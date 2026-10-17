//! Host transport for the dedicated repository-benchmark WSL distribution.
//! No candidate or check command is ever launched on Windows.

use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    io,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

pub(crate) const DISTRIBUTION: &str = "distill-bench";
const CONTROL_TIMEOUT: Duration = Duration::from_secs(120);
const TAIL_BYTES: usize = 8 * 1024;

macro_rules! resources {
    ($($name:literal),* $(,)?) => { &[$(( $name, include_bytes!(concat!(
        "../../resources/benchmark-sandbox/", $name
    )).as_slice() )),*] };
}

const FILES: &[(&str, &[u8])] = resources![
    "bench-artifact",
    "bench-auth",
    "bench-browser",
    "bench-budget",
    "bench-check-prep",
    "bench-clean",
    "bench-copy",
    "bench-digest",
    "bench-enter",
    "bench-judge",
    "bench-kill",
    "bench-login",
    "bench-net",
    "bench-network",
    "bench-patch",
    "bench-run",
    "bench-run-inner",
    "bench-status",
    "bench-unpack",
    "browser-runtime.json",
    "wsl.conf",
];

fn resource_hash(bytes: &[u8]) -> String {
    // Windows checkouts may use CRLF; Linux deployment canonicalizes source
    // files to LF. Bind runtime identity to the actual canonical bytes.
    let normalized: Vec<u8> = bytes
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| {
            if *byte == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                None
            } else {
                Some(*byte)
            }
        })
        .collect();
    hex::encode(Sha256::digest(normalized))
}

pub(crate) const RESOURCE_POLICY: &str =
    "dynamic-v2-linux-memory23-cpu14-pids4096-io1024-256-job-read128-write32-light-read32-write8-disk8-inodes131072-weights10000-300-100-control1";
const GIB: u64 = 1024 * 1024 * 1024;

/// Budget lines the broker reports: the aggregate every admitted job shares
/// (memory, CPUs and processes with the supervisors' own share on top) and
/// each job's own scratch IO ceiling (read/write bytes per second). Under the
/// dynamic policy no line depends on how many jobs run; admission measures
/// that instead (see bench-budget).
const FIXED_BUDGET: [&str; 9] = [
    "budget admission dynamic-v2",
    "budget memory 25769803776",
    "budget cpu 1500000/100000",
    "budget pids 4224",
    "budget io 1073741824/268435456",
    "budget swap 0",
    "budget disk 8589934592",
    "budget inodes 131072",
    "budget job-io heavy 134217728/33554432 prep 134217728/33554432 light 33554432/8388608",
];

/// The policy and the competing load the Linux broker admitted a
/// candidate session under. The attempt keeps it, so a speed comparison can
/// tell a run that had the sandbox to itself from one that shared it.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    /// The admission policy (`dynamic-v2`: repository sessions by measured
    /// use; `dynamic-v1`: every CPU-heavy job by its ceiling), or absent for
    /// the fixed heavy lanes before them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<String>,
    /// Heavy jobs (repository, browser, check, pair) the fixed policy ran at
    /// once; absent under the dynamic one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heavy_lanes: Option<u32>,
    /// The operator's cap on CPU-heavy jobs, where one was set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heavy_cap: Option<u32>,
    /// This job's lane: heavy, light or prep.
    pub lane: String,
    /// Jobs already admitted, by resource class, and how many were heavy.
    pub competing: BTreeMap<String, u32>,
    pub competing_heavy: u32,
    /// Memory (bytes) those jobs claimed (their reservations under the fixed
    /// policy), and the CPU ceilings of the CPU-heavy ones.
    pub reserved_memory: u64,
    pub reserved_cpu: u32,
    /// What this job was expected to need, the cores the CPU-heavy jobs could
    /// have, the CPUs the benchmark jobs used over the last sampled seconds,
    /// the guest's CPU pressure and how long recent checks waited for CPUs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_memory: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_cpu: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_pressure: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_stall: Option<f64>,
    /// Logical CPUs the host left the benchmark jobs, the burst allowance
    /// counted per repository session, the repository sessions running, and
    /// which rule admitted a CPU-heavy job: `ceilings` (every CPU-heavy job
    /// by its ceiling, as before) or `measured` (by the sandbox's measured
    /// use).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_capacity: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_burst: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_sessions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admitted_by: Option<String>,
    /// Set on a later workflow step's session, admitted ahead of new attempts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuing: Option<bool>,
    /// Memory the benchmark cgroup actually used at admission.
    pub memory_current: u64,
    /// The WSL guest's 1, 5 and 15 minute load averages, CPUs and free memory.
    pub guest_load: [f64; 3],
    pub guest_cpus: u32,
    pub guest_mem_available: u64,
    /// Windows available RAM and commit headroom from the admission gate.
    pub host_available_ram: u64,
    pub host_available_commit: u64,
    /// Busy share of all Windows CPUs over the second before admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_cpu_busy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_cpus: Option<u32>,
    /// The sandbox clock minus the gate evidence's Windows time, transport
    /// included: a WSL clock drifted from Windows shows here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_gate_age_ms: Option<i64>,
}

type PendingAdmissions = BTreeMap<String, (std::time::Instant, Admission)>;
static SESSION_ADMISSIONS: OnceLock<std::sync::Mutex<PendingAdmissions>> = OnceLock::new();

fn session_admissions() -> std::sync::MutexGuard<'static, PendingAdmissions> {
    SESSION_ADMISSIONS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn record_session_admission(id: &str, admission: Admission) {
    let mut admissions = session_admissions();
    // An attempt that ends before sealing evidence leaves its record behind;
    // none outlives the longest deadline the broker admits (24 h + 8 min).
    admissions.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(26 * 3600));
    admissions.insert(id.to_owned(), (std::time::Instant::now(), admission));
}

/// The admission of the candidate session in sandbox `id`, handed out once.
/// Absent after an app restart: the record lives only in this process.
pub(crate) fn take_session_admission(id: &str) -> Option<Admission> {
    session_admissions()
        .remove(id)
        .map(|(_, admission)| admission)
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ResourceClass {
    Text,
    Repository,
    Browser,
    Preparation,
    PairedCheck,
    Check,
}

impl ResourceClass {
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Repository => "repository",
            Self::Browser => "browser",
            Self::Preparation => "prep",
            Self::PairedCheck => "pair",
            Self::Check => "check",
        }
    }
    fn memory(self) -> u64 {
        match self {
            Self::Text | Self::Browser | Self::Preparation => 2 * GIB,
            Self::Repository => 6 * GIB,
            Self::PairedCheck => 8 * GIB,
            Self::Check => 4 * GIB,
        }
    }
}

#[derive(Debug)]
struct HostHeadroom {
    available_ram: u64,
    available_commit: u64,
    sandbox_volume_free: u64,
}

fn check_headroom(headroom: &HostHeadroom, additional_memory: u64) -> io::Result<()> {
    if headroom.available_ram < 12 * GIB + additional_memory {
        return Err(io::Error::new(io::ErrorKind::WouldBlock,
            "resource_busy: Windows available RAM cannot cover the benchmark reservation and 12 GiB desktop floor"));
    }
    if headroom.available_commit < 8 * GIB + additional_memory {
        return Err(io::Error::new(io::ErrorKind::WouldBlock,
            "resource_busy: Windows commit headroom cannot cover the benchmark reservation and 8 GiB floor"));
    }
    if headroom.sandbox_volume_free < 30 * GIB {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "resource_busy: The registered sandbox volume has less than 30 GiB free",
        ));
    }
    Ok(())
}

/// Metadata-only host admission. It reserves no account or paid model turn.
/// The Linux broker separately owns fair, atomic process/resource leases.
pub(crate) async fn host_admission() -> io::Result<()> {
    host_admission_for(ResourceClass::Text).await
}

pub(crate) async fn host_admission_for(class: ResourceClass) -> io::Result<()> {
    tokio::task::spawn_blocking(move || check_headroom(&host_headroom()?, class.memory()))
        .await
        .map_err(io::Error::other)?
}

static HOST_PREPARATION: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

/// Acquire before allocating a snapshot/package, and retain through its final
/// import/export. Invocation deliberately does not acquire this gate again.
///
/// The Linux broker admits preparations by measured room rather than one at a
/// time, so the host lets a few prepare at once; each permit still passes
/// the Windows headroom check for its own buffers below.
pub(crate) const HOST_PREPARATIONS: usize = 3;

pub(crate) async fn host_preparation(
    deadline_ms: u64,
) -> io::Result<tokio::sync::OwnedSemaphorePermit> {
    let gate =
        HOST_PREPARATION.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(HOST_PREPARATIONS)));
    let permit = queue_for_preparation(gate, deadline_ms).await?;
    // Max input512MiB + ring/output overlap1GiB, in addition to Linux prep2GiB.
    tokio::task::spawn_blocking(|| {
        check_headroom(
            &host_headroom()?,
            ResourceClass::Preparation.memory() + 3 * GIB / 2,
        )
    })
    .await
    .map_err(io::Error::other)??;
    Ok(permit)
}

/// Waits for `gate` until `deadline_ms`, in arrival order. A deadline that
/// passes in the queue is the queue's refusal: nothing was prepared and no
/// worker started, so the caller may wait and ask again.
async fn queue_for_preparation(
    gate: &Arc<tokio::sync::Semaphore>,
    deadline_ms: u64,
) -> io::Result<tokio::sync::OwnedSemaphorePermit> {
    tokio::time::timeout(
        Duration::from_millis(remaining_ms(deadline_ms)?),
        gate.clone().acquire_owned(),
    )
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::WouldBlock,
            "resource_busy: benchmark host preparation queue expired before worker startup",
        )
    })?
    .map_err(io::Error::other)
}

/// Fresh Windows evidence for the broker: the time, available RAM, commit
/// headroom, the sandbox volume's free space, and how busy the host's CPUs
/// were over the last second in thousandths (1001 while unknown).
pub(crate) fn host_gate() -> io::Result<String> {
    let headroom = host_headroom()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis();
    Ok(format!(
        "{now},{},{},{},{}",
        headroom.available_ram,
        headroom.available_commit,
        headroom.sandbox_volume_free,
        host_cpu_permille().unwrap_or(1001)
    ))
}

/// A pending lease expires in Linux after sixty seconds. Dropping it releases
/// only an unclaimed lease, never a process tree already owned by bench-run.
pub(crate) struct Reservation {
    pub token: String,
    class: ResourceClass,
    admission: Admission,
    /// Framing for the run's outcome receipt on its stderr (see
    /// [`take_outcome_trailer`]); only the run's root supervisor sees it.
    nonce: String,
    /// Set once a process that claims the lease was started: bench-budget
    /// run then removes the lease itself, and dropping this one starts no
    /// release. A lease nothing claimed is released, and expires regardless.
    claimed: std::sync::atomic::AtomicBool,
}
impl Reservation {
    pub(crate) fn mark_claimed(&self) {
        self.claimed
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if self.claimed.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let mut command = std::process::Command::new("wsl.exe");
        command
            .args([
                "-d",
                DISTRIBUTION,
                "-u",
                "root",
                "--exec",
                "/usr/local/sbin/bench-budget",
                "release",
                &self.token,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        super::process::apply_no_window(&mut command);
        if let Err(error) = command.spawn() {
            log::warn!("[benchmarks] cannot release pending sandbox resource lease: {error}");
        }
    }
}

/// Reserve a candidate session's process tree. Its admission record, with
/// the Windows CPU share the broker decided on, waits for the attempt's
/// evidence.
/// Owners of sessions that continue a workflow already under way: a later
/// step, whose earlier steps a provider already worked on. Admission lets
/// such a session ahead of new attempts and past the CPU pressure guards;
/// its ceilings, memory and the Windows floors still bound it (bench-budget).
static CONTINUING: std::sync::Mutex<std::collections::BTreeSet<String>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

/// Marks `owner`'s session as continuing a workflow while this lives.
pub(crate) struct Continuing(String);

impl Continuing {
    pub(crate) fn new(owner: String) -> Self {
        CONTINUING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(owner.clone());
        Self(owner)
    }
}

impl Drop for Continuing {
    fn drop(&mut self) {
        CONTINUING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// Whether `owner`'s session continues a workflow (see [`Continuing`]).
pub(crate) fn continues(owner: &str) -> bool {
    CONTINUING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(owner)
}

pub(crate) async fn reserve(
    class: ResourceClass,
    id: &str,
    deadline_ms: u64,
    continuing: bool,
) -> io::Result<Reservation> {
    let mut reservation = reserve_with_buffers_for(class, id, deadline_ms, 0, continuing).await?;
    reservation.admission.host_cpus = std::thread::available_parallelism()
        .ok()
        .and_then(|count| u32::try_from(count.get()).ok());
    record_session_admission(id, reservation.admission.clone());
    Ok(reservation)
}

async fn reserve_with_buffers(
    class: ResourceClass,
    id: &str,
    deadline_ms: u64,
    host_buffers: usize,
) -> io::Result<Reservation> {
    reserve_with_buffers_for(class, id, deadline_ms, host_buffers, false).await
}

async fn reserve_with_buffers_for(
    class: ResourceClass,
    id: &str,
    deadline_ms: u64,
    host_buffers: usize,
    continuing: bool,
) -> io::Result<Reservation> {
    valid_id(id)?;
    remaining_ms(deadline_ms)?;
    host_admission_for(class).await?;
    let gate = host_gate()?;
    let deadline = deadline_ms.to_string();
    let host_buffers = host_buffers.to_string();
    let mut args: Vec<&str> = vec!["reserve", class.key(), id, &deadline, &gate, &host_buffers];
    if continuing {
        args.push("continuing");
    }
    let out = invoke_raw(
        "/usr/local/sbin/bench-budget",
        &args,
        None,
        4096,
        Duration::from_millis(remaining_ms(deadline_ms)?.min(15_000)),
        None,
    )
    .await?;
    if !out.success() && out.reason().contains("resource_busy:") {
        return Err(io::Error::new(io::ErrorKind::WouldBlock, out.reason()));
    }
    // A cgroup busy for a moment (EBUSY while another job's group is reaped)
    // refused this admission before anything started: wait like any other
    // local refusal instead of failing the run's storage.
    if !out.success() && out.reason().contains("[Errno 16]") {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "resource_busy: a sandbox control group was busy during admission; no provider process started",
        ));
    }
    let out = out.require_success("resource admission")?;
    let value: serde_json::Value = serde_json::from_slice(&out.stdout)?;
    let token = value["token"]
        .as_str()
        .filter(|token| {
            token.len() == 32
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
        .ok_or_else(|| {
            io::Error::other("capability_missing: malformed sandbox resource reservation")
        })?;
    if value["id"] != id
        || value["class"] != class.key()
        || value["deadlineMs"].as_u64() != Some(deadline_ms)
    {
        return Err(io::Error::other(
            "capability_missing: sandbox resource reservation owner differs",
        ));
    }
    let admission = serde_json::from_value(value["admission"].clone())
        .map_err(|_| io::Error::other("capability_missing: malformed sandbox admission record"))?;
    Ok(Reservation {
        token: token.to_owned(),
        class,
        admission,
        nonce: uuid::Uuid::new_v4().simple().to_string(),
        claimed: std::sync::atomic::AtomicBool::new(false),
    })
}

#[cfg(not(windows))]
fn host_headroom() -> io::Result<HostHeadroom> {
    Err(io::Error::other(
        "capability_missing: the benchmark host headroom service requires Windows",
    ))
}

/// Busy share of all Windows CPUs over one second, in thousandths, from a
/// thread that samples once a second for every admission's evidence; None in
/// the first second, and where Windows reports nothing.
fn host_cpu_permille() -> Option<u32> {
    static LATEST: OnceLock<Arc<std::sync::atomic::AtomicU32>> = OnceLock::new();
    let latest = LATEST.get_or_init(|| {
        let latest = Arc::new(std::sync::atomic::AtomicU32::new(u32::MAX));
        let writer = Arc::clone(&latest);
        let started = std::thread::Builder::new()
            .name("benchmark-host-cpu".into())
            .spawn(move || loop {
                let busy = host_cpu_busy_over(Duration::from_secs(1)).unwrap_or(u32::MAX);
                writer.store(busy, std::sync::atomic::Ordering::Relaxed);
            });
        if started.is_err() {
            log::warn!("[benchmarks] cannot sample Windows CPU use for sandbox admission");
        }
        latest
    });
    Some(latest.load(std::sync::atomic::Ordering::Relaxed)).filter(|busy| *busy <= 1000)
}

#[cfg(not(windows))]
fn host_cpu_busy_over(window: Duration) -> Option<u32> {
    std::thread::sleep(window);
    None
}

/// Busy share of all Windows CPUs over `window`, in thousandths; idle time
/// is part of the kernel time GetSystemTimes reports.
#[cfg(windows)]
fn host_cpu_busy_over(window: Duration) -> Option<u32> {
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
    }
    let sample = || {
        let (mut idle, mut kernel, mut user) = (
            FileTime::default(),
            FileTime::default(),
            FileTime::default(),
        );
        if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
            return None;
        }
        let ticks = |time: &FileTime| (u64::from(time.high) << 32) | u64::from(time.low);
        Some((ticks(&idle), ticks(&kernel) + ticks(&user)))
    };
    let Some((idle_before, total_before)) = sample() else {
        std::thread::sleep(window);
        return None;
    };
    std::thread::sleep(window);
    let (idle_after, total_after) = sample()?;
    let total = total_after.checked_sub(total_before)?;
    let idle = idle_after.checked_sub(idle_before)?.min(total);
    (total > 0).then(|| ((total - idle) as f64 / total as f64 * 1000.0).round() as u32)
}

#[cfg(windows)]
fn host_headroom() -> io::Result<HostHeadroom> {
    use std::mem::size_of;
    // Native APIs avoid starting PowerShell, inheriting profiles or parsing
    // localized shell output at each scheduling/admission decision.
    #[repr(C)]
    struct MemoryStatus {
        length: u32,
        load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page: u64,
        avail_page: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended: u64,
    }
    #[repr(C)]
    struct PerformanceInfo {
        size: u32,
        commit_total: usize,
        commit_limit: usize,
        commit_peak: usize,
        physical_total: usize,
        physical_available: usize,
        system_cache: usize,
        kernel_total: usize,
        kernel_paged: usize,
        kernel_nonpaged: usize,
        page_size: usize,
        handle_count: u32,
        process_count: u32,
        thread_count: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
        fn GetDiskFreeSpaceExW(
            path: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    #[link(name = "psapi")]
    unsafe extern "system" {
        fn GetPerformanceInfo(info: *mut PerformanceInfo, size: u32) -> i32;
    }
    let mut memory: MemoryStatus = unsafe { std::mem::zeroed() };
    memory.length = size_of::<MemoryStatus>() as u32;
    let mut performance: PerformanceInfo = unsafe { std::mem::zeroed() };
    performance.size = size_of::<PerformanceInfo>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut memory) } == 0
        || unsafe { GetPerformanceInfo(&mut performance, size_of::<PerformanceInfo>() as u32) } == 0
    {
        return Err(io::Error::other(
            "capability_missing: Windows memory/commit metadata is unavailable",
        ));
    }
    let path = registered_sandbox_path()?;
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let mut available = 0;
    if unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::other(
            "capability_missing: registered sandbox volume metadata is unavailable",
        ));
    }
    Ok(HostHeadroom {
        available_ram: memory.avail_phys,
        available_commit: performance
            .commit_limit
            .saturating_sub(performance.commit_total)
            .saturating_mul(performance.page_size) as u64,
        sandbox_volume_free: available,
    })
}

#[cfg(windows)]
fn registered_sandbox_path() -> io::Result<String> {
    use std::ffi::c_void;
    type Key = *mut c_void;
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegOpenKeyExW(
            key: Key,
            name: *const u16,
            options: u32,
            access: u32,
            out: *mut Key,
        ) -> i32;
        fn RegEnumKeyExW(
            key: Key,
            index: u32,
            name: *mut u16,
            length: *mut u32,
            reserved: *mut u32,
            class: *mut u16,
            class_length: *mut u32,
            written: *mut c_void,
        ) -> i32;
        fn RegQueryValueExW(
            key: Key,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            bytes: *mut u8,
            length: *mut u32,
        ) -> i32;
        fn RegCloseKey(key: Key) -> i32;
    }
    struct RegistryKey(Key);
    impl Drop for RegistryKey {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let query = |key: Key, name: &str| -> Option<String> {
        let name = wide(name);
        let mut bytes = [0_u16; 4096];
        let mut length = (bytes.len() * 2) as u32;
        let mut kind = 0;
        let result = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                bytes.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if result != 0 || kind != 1 || length < 2 || length as usize > bytes.len() * 2 {
            return None;
        }
        let text = &bytes[..length as usize / 2];
        String::from_utf16(text.strip_suffix(&[0]).unwrap_or(text)).ok()
    };
    let mut root: Key = std::ptr::null_mut();
    // HKEY_CURRENT_USER is a sign-extended predefined handle on Windows x64.
    let current_user = (0x8000_0001_u32 as i32 as isize) as Key;
    let result = unsafe {
        RegOpenKeyExW(
            current_user,
            wide("Software\\Microsoft\\Windows\\CurrentVersion\\Lxss").as_ptr(),
            0,
            0x20019,
            &mut root,
        )
    };
    if result != 0 {
        return Err(io::Error::other(
            "capability_missing: the benchmark WSL distribution is not registered",
        ));
    }
    let root = RegistryKey(root);
    for index in 0..1024 {
        let mut name = [0_u16; 256];
        let mut length = name.len() as u32;
        let result = unsafe {
            RegEnumKeyExW(
                root.0,
                index,
                name.as_mut_ptr(),
                &mut length,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if result == 259 {
            break;
        }
        if result != 0 {
            continue;
        }
        name[length as usize] = 0;
        let mut child: Key = std::ptr::null_mut();
        if unsafe { RegOpenKeyExW(root.0, name.as_ptr(), 0, 0x20019, &mut child) } != 0 {
            continue;
        }
        let child = RegistryKey(child);
        if query(child.0, "DistributionName").as_deref() == Some(DISTRIBUTION) {
            return query(child.0, "BasePath")
                .filter(|path| !path.is_empty())
                .ok_or_else(|| {
                    io::Error::other("capability_missing: sandbox storage location is unavailable")
                });
        }
    }
    Err(io::Error::other(
        "capability_missing: the benchmark WSL distribution is not registered",
    ))
}

#[derive(Clone, Debug)]
pub(crate) struct Status {
    pub revision: String,
    accounts: Vec<(String, String)>,
    account_health: BTreeMap<(String, String), AccountHealth>,
}

#[derive(Clone, Debug)]
struct AccountHealth {
    mode: String,
    state: String,
    expires_at_ms: Option<i64>,
}

impl Status {
    pub fn require_account(&self, provider: &str, account: &str) -> io::Result<()> {
        valid_id(account)?;
        if !self
            .accounts
            .iter()
            .any(|(p, a)| p == provider && a == account)
        {
            return Err(io::Error::other(format!(
                "The {provider} account {account} is not signed in inside {DISTRIBUTION}; run bench-login in the sandbox"
            )));
        }
        Ok(())
    }

    /// Local expiry evidence covers the entire admitted attempt plus cleanup.
    /// This is not a claim that a grant has been remotely authenticated.
    pub fn require_account_window(
        &self,
        provider: &str,
        account: &str,
        now_ms: i64,
        timeout_seconds: u32,
    ) -> io::Result<()> {
        self.require_account(provider, account)?;
        // These providers expose expiry metadata in bench-auth. Other
        // providers retain their existing sign-in and usage-policy checks
        // until their actual credential formats have a health adapter.
        if !matches!(provider, "claude" | "grok") {
            return Ok(());
        }
        if now_ms < 0 || timeout_seconds == 0 {
            return Err(io::Error::other("Invalid credential admission window"));
        }
        let health = self
            .account_health
            .get(&(provider.to_owned(), account.to_owned()))
            .ok_or_else(|| {
                io::Error::other(
                    "Sandbox credential health is unknown; inspect the account before admission",
                )
            })?;
        if health.mode == "unbounded" && health.state == "unknown" {
            // This mode makes no expiry claim (for example an API key). Its
            // existing account/usage policy remains responsible for admission.
            return Ok(());
        }
        let deadline = admission_deadline(now_ms, timeout_seconds)?;
        if health.mode != "oauth"
            || health.state != "current"
            || health.expires_at_ms.is_none_or(|expiry| expiry <= deadline)
        {
            return Err(io::Error::other(
                "Sandbox OAuth credentials do not cover the complete attempt and cleanup margin; drain active work and refresh or sign in before admission",
            ));
        }
        Ok(())
    }

    /// When the sandbox OAuth grant of `account` expires, for a grant whose
    /// structure and expiry bench-auth reads, current or already expired:
    /// one the provider's CLI can renew with the refresh token it keeps.
    /// None for every other credential: an API key, a missing or unreadable
    /// grant, or one whose expiry is unknown.
    pub fn oauth_expiry(&self, provider: &str, account: &str) -> Option<i64> {
        let health = self
            .account_health
            .get(&(provider.to_owned(), account.to_owned()))?;
        if health.mode != "oauth" || !matches!(health.state.as_str(), "current" | "expired") {
            return None;
        }
        health.expires_at_ms
    }
}

/// The latest moment an attempt admitted at `now_ms` may still hold its
/// sandbox credentials: its time limit and the five-minute cleanup margin.
pub(crate) fn admission_deadline(now_ms: i64, timeout_seconds: u32) -> io::Result<i64> {
    now_ms
        .checked_add(i64::from(timeout_seconds) * 1000)
        .and_then(|value| value.checked_add(300_000))
        .ok_or_else(|| io::Error::other("Invalid credential admission window"))
}

pub(crate) fn valid_id(id: &str) -> io::Result<()> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(io::Error::other("Invalid sandbox attempt or account id"));
    }
    Ok(())
}

pub(crate) fn command(program: &str, args: &[&str]) -> tokio::process::Command {
    command_with_host_buffers(program, args, 0, None)
}

fn command_with_host_buffers(
    program: &str,
    args: &[&str],
    host_buffers: usize,
    reservation: Option<&Reservation>,
) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("wsl.exe");
    cmd.args(["-d", DISTRIBUTION, "-u", "root", "--exec"]);
    cmd.arg("/usr/bin/env");
    if let Ok(gate) = host_gate() {
        cmd.arg(format!("DISTILL_BENCH_HOST_GATE={gate}"));
    }
    cmd.arg(format!("DISTILL_BENCH_HOST_BUFFER_BYTES={host_buffers}"));
    if let Some(reservation) = reservation {
        cmd.arg(format!("DISTILL_BENCH_RESERVATION={}", reservation.token));
        cmd.arg(format!("DISTILL_BENCH_OUTCOME_NONCE={}", reservation.nonce));
    }
    cmd.arg(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    super::process::apply_no_window_async(&mut cmd);
    cmd
}

#[derive(Debug)]
pub(crate) struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
    infrastructure: Option<String>,
}

impl Output {
    /// Only root-owned lease receipts establish this classification. Submitted
    /// code cannot turn its stderr text into an infrastructure verdict.
    pub(crate) fn infrastructure_error(&self) -> Option<&str> {
        self.infrastructure.as_deref()
    }
    pub fn success(&self) -> bool {
        self.code == Some(0) && self.infrastructure.is_none()
    }
    pub fn reason(&self) -> String {
        let out_start = self.stdout.len().saturating_sub(TAIL_BYTES);
        let err_start = self.stderr.len().saturating_sub(TAIL_BYTES);
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&self.stdout[out_start..]),
            String::from_utf8_lossy(&self.stderr[err_start..])
        );
        text.chars()
            .rev()
            .take(2_000)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>()
            .trim()
            .to_owned()
    }
    fn require_success(self, operation: &str) -> io::Result<Self> {
        if !self.success() {
            return Err(io::Error::other(format!(
                "Sandbox {operation} failed: {}",
                self.reason()
            )));
        }
        Ok(self)
    }
}

// Drain both streams while writing stdin. Retain a bounded tail, even if a
// broken check fills stderr before reading its input or forks a noisy child.
pub(crate) async fn read_tail(
    mut reader: impl AsyncRead + Unpin,
    cap: usize,
) -> io::Result<(Vec<u8>, bool)> {
    let mut tail = VecDeque::new();
    let mut truncated = false;
    let mut block = [0_u8; 8192];
    loop {
        let count = reader.read(&mut block).await?;
        if count == 0 {
            break;
        }
        let retained = count.min(cap);
        let overflow = tail.len().saturating_add(count).saturating_sub(cap);
        if overflow > 0 {
            for _ in 0..overflow.min(tail.len()) {
                tail.pop_front();
            }
            truncated = true;
        }
        let needed = tail.len() + retained;
        if needed > tail.capacity() {
            let target = tail
                .capacity()
                .max(8192)
                .saturating_mul(2)
                .min(cap)
                .max(needed);
            tail.reserve_exact(target - tail.len());
        }
        tail.extend(block[count - retained..count].iter().copied());
    }
    Ok((tail.into_iter().collect(), truncated))
}

/// Every sandbox operation ends here, so its process and stream state is
/// boxed once instead of being carried inline by every future that awaits
/// one. An unoptimized build gives each awaiting poll a stack slot for the
/// whole awaited future, and a benchmark attempt awaits sandbox calls under
/// many such layers on a 2 MiB runtime worker stack.
fn invoke_raw<'a>(
    program: &'a str,
    args: &'a [&'a str],
    input: Option<&'a [u8]>,
    cap: usize,
    timeout: Duration,
    reservation: Option<&'a Reservation>,
) -> BoxFuture<'a, io::Result<Output>> {
    Box::pin(async move {
        const MAX_TRANSPORT: usize = 512 * 1024 * 1024;
        if cap > MAX_TRANSPORT || input.is_some_and(|bytes| bytes.len() > MAX_TRANSPORT) {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "Sandbox transport exceeds its byte budget",
            ));
        }
        // Ring collection and its returned Vec can coexist briefly. Count the
        // future host allocation in addition to the Linux process-tree class.
        let host_buffers = cap.saturating_mul(2).saturating_add(TAIL_BYTES * 2);
        // Cleanup/status remain available when RAM is low. Workload-bearing
        // operations must pass the dynamic host guard before entering Linux.
        if program != "/usr/local/sbin/bench-budget"
            && !matches!(
                program,
                "/usr/local/sbin/bench-kill"
                    | "/usr/local/sbin/bench-clean"
                    | "/usr/local/sbin/bench-status"
            )
        {
            let class = reservation.map(|lease| lease.class).unwrap_or_else(|| {
                if program == "/usr/local/sbin/bench-judge" {
                    ResourceClass::PairedCheck
                } else if program == "/usr/local/sbin/bench-browser" {
                    ResourceClass::Browser
                } else {
                    ResourceClass::Preparation
                }
            });
            tokio::task::spawn_blocking(move || {
                check_headroom(&host_headroom()?, class.memory() + host_buffers as u64)
            })
            .await
            .map_err(io::Error::other)??;
        }
        let mut cmd = command_with_host_buffers(program, args, host_buffers, reservation);
        if input.is_some() {
            cmd.stdin(Stdio::piped());
        }
        let mut child = cmd.spawn()?;
        if let Some(reservation) = reservation {
            reservation.mark_claimed();
        }
        let tree = super::process::ProcessTree::contain(&child);
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let run = async {
            let (write, out, err, status) = tokio::join!(
                async {
                    if let (Some(mut stream), Some(bytes)) = (stdin, input) {
                        stream.write_all(bytes).await?;
                        stream.shutdown().await?;
                    }
                    Ok::<_, io::Error>(())
                },
                read_tail(stdout, cap),
                read_tail(stderr, TAIL_BYTES),
                child.wait()
            );
            let status = status?;
            // Prefer the helper's diagnostic over a broken pipe on rejected input.
            if status.success() {
                write?;
            }
            let (stdout, truncated) = out?;
            let (stderr, _) = err?;
            Ok(Output {
                code: status.code(),
                stdout,
                stderr,
                truncated,
                infrastructure: None,
            })
        };
        match tokio::time::timeout(timeout, run).await {
            Ok(result) => result,
            Err(_) => {
                if let Some(tree) = tree {
                    tree.kill();
                }
                let _ = child.kill().await;
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Sandbox operation exceeded its time limit",
                ))
            }
        }
    })
}

fn helper_phase<'a>(program: &str, args: &'a [&str]) -> Option<(ResourceClass, &'a str)> {
    match program {
        "/usr/local/sbin/bench-copy"
        | "/usr/local/sbin/bench-check-prep"
        | "/usr/local/sbin/bench-artifact"
        | "/usr/local/sbin/bench-patch" => args.first().map(|id| (ResourceClass::Preparation, *id)),
        "/usr/local/sbin/bench-judge" => args.first().map(|id| (ResourceClass::PairedCheck, *id)),
        "/usr/local/sbin/bench-browser"
            if matches!(args.first(), Some(&"evaluate") | Some(&"provision-receipt")) =>
        {
            args.get(1).map(|id| (ResourceClass::Browser, *id))
        }
        _ => None,
    }
}

pub(crate) async fn invoke_reserved_bounded(
    reservation: &Reservation,
    program: &str,
    args: &[&str],
    input: Option<&[u8]>,
    cap: usize,
    timeout: Duration,
) -> io::Result<Output> {
    let mut out = invoke_raw(program, args, input, cap, timeout, Some(reservation)).await?;
    // The run's supervisor prints its receipt as the last stderr line; a
    // helper from an earlier build, or a run cut short, needs the call.
    let value: serde_json::Value = match take_outcome_trailer(&mut out.stderr, &reservation.nonce) {
        Some(value) => value,
        None => {
            let receipt = invoke_raw(
                "/usr/local/sbin/bench-budget",
                &["outcome", &reservation.token],
                None,
                4096,
                Duration::from_secs(5),
                None,
            )
            .await?
            .require_success("resource outcome")?;
            serde_json::from_slice(&receipt.stdout)?
        }
    };
    if let Some(reason) = value["infrastructureError"].as_str() {
        if value["token"] != reservation.token {
            return Err(io::Error::other("Sandbox resource outcome owner differs"));
        }
        out.infrastructure = Some(reason.to_owned());
    }
    Ok(out)
}

/// The outcome receipt a leased run's supervisor printed last on stderr as
/// `NONCE outcome JSON`, removed from `stderr`. Only that supervisor knows
/// the nonce (it takes it out of the environment before starting anything),
/// so nothing the run starts can print the line.
fn take_outcome_trailer(stderr: &mut Vec<u8>, nonce: &str) -> Option<serde_json::Value> {
    let marker = format!("{nonce} outcome ");
    let text = std::str::from_utf8(stderr).ok()?;
    let trimmed = text.trim_end_matches(['\n', '\r']);
    let start = trimmed.rfind('\n').map_or(0, |at| at + 1);
    let json = trimmed[start..].strip_prefix(marker.as_str())?;
    let value = serde_json::from_str(json).ok()?;
    stderr.truncate(start);
    Some(value)
}

pub(crate) async fn invoke_bounded(
    program: &str,
    args: &[&str],
    input: Option<&[u8]>,
    cap: usize,
    timeout: Duration,
) -> io::Result<Output> {
    if cap > 512 * 1024 * 1024 || input.is_some_and(|bytes| bytes.len() > 512 * 1024 * 1024) {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "Sandbox transport exceeds its byte budget",
        ));
    }
    let Some((class, id)) = leased_class(program, args).await? else {
        return invoke_raw(program, args, input, cap, timeout, None).await;
    };
    let now = now_ms()?;
    let deadline = now.saturating_add(timeout.as_millis().min(u64::MAX as u128) as u64);
    let admission_deadline = deadline.min(now.saturating_add(300_000));
    let host_buffers = cap.saturating_mul(2).saturating_add(TAIL_BYTES * 2);
    let lease = admit(admission_deadline, || {
        reserve_with_buffers(class, id, deadline, host_buffers)
    })
    .await?;
    // A child is launched exactly once. Only failed pre-execution admissions
    // are retried; captured input is retained without paid-model replay.
    let remaining = remaining_ms(deadline).map_err(|_| admission_queue_expired())?;
    invoke_reserved_bounded(
        &lease,
        program,
        args,
        input,
        cap,
        Duration::from_millis(remaining),
    )
    .await
}

/// The lease class and owner a workload helper runs under; a check asks the
/// broker whether it is paired. None for a control helper.
async fn leased_class<'a>(
    program: &str,
    args: &'a [&'a str],
) -> io::Result<Option<(ResourceClass, &'a str)>> {
    let Some((class, id)) = helper_phase(program, args) else {
        return Ok(None);
    };
    if program != "/usr/local/sbin/bench-judge" {
        return Ok(Some((class, id)));
    }
    let response = invoke_raw(
        "/usr/local/sbin/bench-budget",
        &["check-class", id],
        None,
        64,
        Duration::from_secs(5),
        None,
    )
    .await?
    .require_success("check classification")?;
    let class = match response.stdout.as_slice() {
        b"check\n" => ResourceClass::Check,
        b"pair\n" => ResourceClass::PairedCheck,
        _ => return Err(io::Error::other("Sandbox check classification is invalid")),
    };
    Ok(Some((class, id)))
}

fn now_ms() -> io::Result<u64> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis() as u64)
}

/// Runs a workload helper under a lease of `class` for `id`, like
/// [`invoke_bounded`], except that waiting for room never shortens the run:
/// admission asks once a second until `admit_until_ms`, and the helper then
/// gets all of `run`, cut only to what is left before the caller's native
/// `deadline_ms`. A window that closes in the queue is the queue's refusal
/// (`resource_busy`): nothing started, and the caller may ask again.
#[allow(clippy::too_many_arguments)]
async fn invoke_once_admitted(
    (class, id): (ResourceClass, &str),
    program: &str,
    args: &[&str],
    input: Option<&[u8]>,
    cap: usize,
    run: Duration,
    admit_until_ms: u64,
    deadline_ms: Option<u64>,
) -> io::Result<Output> {
    if cap > 512 * 1024 * 1024 || input.is_some_and(|bytes| bytes.len() > 512 * 1024 * 1024) {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "Sandbox transport exceeds its byte budget",
        ));
    }
    let host_buffers = cap.saturating_mul(2).saturating_add(TAIL_BYTES * 2);
    let lease = admit(
        admission_window(admit_until_ms, deadline_ms),
        move || async move {
            let until = now_ms()?.saturating_add(run_after_admission(run, deadline_ms)?);
            reserve_with_buffers(class, id, until, host_buffers).await
        },
    )
    .await?;
    let run = run_after_admission(run, deadline_ms).map_err(|_| admission_queue_expired())?;
    invoke_reserved_bounded(
        &lease,
        program,
        args,
        input,
        cap,
        Duration::from_millis(run),
    )
    .await
}

/// The run time a helper admitted now gets: all of `run`, cut to what is left
/// before the caller's native `deadline_ms`; an expired deadline is TimedOut.
fn run_after_admission(run: Duration, deadline_ms: Option<u64>) -> io::Result<u64> {
    let run = run.as_millis().min(u64::MAX as u128) as u64;
    match deadline_ms {
        Some(deadline) => Ok(run.min(remaining_ms(deadline)?)),
        None => Ok(run),
    }
}

/// Until when admission asks: the caller's window, never past its native
/// deadline.
fn admission_window(admit_until_ms: u64, deadline_ms: Option<u64>) -> u64 {
    deadline_ms.map_or(admit_until_ms, |deadline| admit_until_ms.min(deadline))
}

/// How long a post-turn collection or a check may wait for sandbox room
/// without a native deadline of its own. Its answer is already sealed.
const COLLECTION_ADMISSION: Duration = Duration::from_secs(30 * 60);

/// A lease whose admission window closed before its helper started. No
/// helper and no provider process ran, so the caller may wait and ask again.
fn admission_queue_expired() -> io::Error {
    io::Error::new(
        io::ErrorKind::WouldBlock,
        "resource_busy: benchmark preparation queue expired before worker startup",
    )
}

/// Asks `reserve` for a lease, once a second while the Linux broker answers
/// busy, until `admission_deadline`. A window that closes in the queue is the
/// queue's refusal, whichever check sees it first: the broker's last busy
/// answer, or the deadline check before the next ask.
async fn admit<L, F>(admission_deadline: u64, mut reserve: impl FnMut() -> F) -> io::Result<L>
where
    F: std::future::Future<Output = io::Result<L>>,
{
    loop {
        match reserve().await {
            Ok(lease) => return Ok(lease),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let remaining =
                    remaining_ms(admission_deadline).map_err(|_| admission_queue_expired())?;
                tokio::time::sleep(Duration::from_millis(remaining.min(1000))).await;
            }
            Err(error)
                if error.kind() == io::ErrorKind::TimedOut
                    && remaining_ms(admission_deadline).is_err() =>
            {
                return Err(admission_queue_expired())
            }
            Err(error) => return Err(error),
        }
    }
}

async fn invoke(
    program: &str,
    args: &[&str],
    input: Option<&[u8]>,
    cap: usize,
    timeout: Duration,
) -> io::Result<Output> {
    invoke_bounded(program, args, input, cap, timeout).await
}

/// How long one sandbox observation answers the readiness checks after it.
/// An attempt checks readiness at each step of its preparation and again
/// for its receipt, and attempts on other lanes check side by side. Each
/// check used to start its own `bench-status`, which reads every pinned
/// executable inside the half-CPU control group: about six seconds, eight
/// times an attempt. Within this window the checks share the last
/// observation. Helper updates refuse while any job runs, and every native
/// receipt observes again after its turn ([`observe_now`]), as does a
/// sign-in renewal; a key copied into the sandbox drops the observation.
pub(crate) const OBSERVATION_REUSE: Duration = Duration::from_secs(10);

/// What the sandbox reported, shared by the checks within a reuse window of
/// the observation. One observation runs at a time per key, and the checks
/// that arrive meanwhile wait for it instead of starting their own. A failed
/// observation is never kept: the next check observes again.
pub(crate) struct Recent<K, T> {
    reuse: Duration,
    slots: std::sync::Mutex<BTreeMap<K, Observed<T>>>,
}

/// One key's last observation, when it started and when it finished,
/// locked while observing.
type Observed<T> = Arc<tokio::sync::Mutex<Option<Observation<T>>>>;

struct Observation<T> {
    started: std::time::Instant,
    finished: std::time::Instant,
    value: T,
}

impl<K: Ord + Clone, T: Clone> Recent<K, T> {
    pub(crate) const fn new(reuse: Duration) -> Self {
        Self {
            reuse,
            slots: std::sync::Mutex::new(BTreeMap::new()),
        }
    }

    /// The value observed for `key` within the reuse window, else a new
    /// observation, which later checks then share. A `fresh` check takes
    /// only an observation that started after it asked, so every check that
    /// arrives while one runs shares the next: the state after the event
    /// that asked (a turn's end, a renewal), observed once for all of them.
    pub(crate) async fn get<E, F, O>(&self, key: K, fresh: bool, observe: O) -> Result<T, E>
    where
        O: FnOnce() -> F,
        F: std::future::Future<Output = Result<T, E>>,
    {
        let slot = {
            let mut slots = self
                .slots
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // Keys are runtime revisions; old ones go once nothing holds them.
            if slots.len() >= 32 {
                slots.retain(|_, slot| Arc::strong_count(slot) > 1);
            }
            Arc::clone(slots.entry(key).or_default())
        };
        let asked = std::time::Instant::now();
        let mut held = slot.lock().await;
        if let Some(last) = held.as_ref() {
            let current = if fresh {
                last.started >= asked
            } else {
                last.finished.elapsed() < self.reuse
            };
            if current {
                return Ok(last.value.clone());
            }
        }
        let started = std::time::Instant::now();
        // Boxed: readiness is awaited deep inside an attempt's preparation.
        let value = Box::pin(observe()).await?;
        *held = Some(Observation {
            started,
            finished: std::time::Instant::now(),
            value: value.clone(),
        });
        Ok(value)
    }

    /// Drops every kept observation, so the next check observes again: for
    /// an action of the app's own that changed what the sandbox reports.
    pub(crate) fn forget(&self) {
        self.slots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
}

static STATUS: Recent<(), Status> = Recent::new(OBSERVATION_REUSE);

/// Runtime identity is independent of credentials. Status separately exposes
/// redacted local health and expiry, never tokens or credential contents.
/// A check within [`OBSERVATION_REUSE`] of the last observation shares it.
pub(crate) async fn ready() -> io::Result<Status> {
    host_admission().await?;
    STATUS.get((), false, observe_status).await
}

/// A new observation, never an earlier one: the runtime as it is after a
/// turn, for the receipt sealed with that turn's evidence. Receipts that
/// arrive while one observation runs share the next.
pub(crate) async fn observe_now() -> io::Result<Status> {
    host_admission().await?;
    STATUS.get((), true, observe_status).await
}

async fn observe_status() -> io::Result<Status> {
    let out = invoke(
        "/usr/local/sbin/bench-status",
        &[],
        None,
        128 * 1024,
        CONTROL_TIMEOUT,
    )
    .await?
    .require_success("status")?;
    if out.truncated {
        return Err(io::Error::other("Sandbox status exceeded its limit"));
    }
    parse_status(&String::from_utf8_lossy(&out.stdout))
}

fn parse_status(text: &str) -> io::Result<Status> {
    let lines: Vec<Vec<&str>> = text
        .lines()
        .map(|line| line.split_whitespace().collect())
        .collect();
    let mut identity = BTreeMap::new();
    // Admission policy and aggregate are runtime identity (they are pinned
    // below); the operator's cap on CPU-heavy jobs and the jobs running are
    // operator state. Every attempt records what it was admitted under.
    let caps: Vec<&str> = text
        .lines()
        .filter_map(|line| line.strip_prefix("budget heavy-cap "))
        .collect();
    let valid_cap =
        |cap: &str| cap == "off" || cap.parse::<u8>().is_ok_and(|cap| (1..=8).contains(&cap));
    if !matches!(caps.as_slice(), [cap] if valid_cap(cap)) {
        return Err(io::Error::other(
            "capability_missing: the sandbox reports no valid heavy-job cap",
        ));
    }
    for line in FIXED_BUDGET {
        if !text.lines().any(|observed| observed == line) {
            return Err(io::Error::other(
                "capability_missing: required aggregate benchmark containment is missing",
            ));
        }
    }
    identity.insert("resourcePolicy".to_owned(), RESOURCE_POLICY.to_owned());
    for (name, bytes) in FILES {
        let expected = resource_hash(bytes);
        if !lines
            .iter()
            .any(|parts| parts == &["file", name, &expected])
        {
            return Err(io::Error::other(format!(
                "The sandbox file {name} is missing or changed; provision {DISTRIBUTION} from this build"
            )));
        }
        identity.insert(name.to_string(), expected);
    }
    let pins: BTreeMap<String, String> = serde_json::from_str(include_str!(
        "../../resources/benchmark-sandbox/runtime-pins.json"
    ))?;
    for (key, expected) in pins {
        let found = lines
            .iter()
            .any(|parts| parts.join(" ") == format!("{key} {expected}"));
        if !found {
            return Err(io::Error::other(format!(
                "Sandbox runtime changed or missing: {key}"
            )));
        }
        identity.insert(key, expected);
    }
    if !lines.iter().any(|parts| parts == &["netns", "up"]) {
        return Err(io::Error::other(
            "Sandbox network is not ready; provision distill-bench",
        ));
    }
    let accounts = lines
        .iter()
        .filter_map(|parts| match parts.as_slice() {
            ["account", provider, account, "yes"] => {
                Some((provider.to_string(), account.to_string()))
            }
            _ => None,
        })
        .collect();
    let mut account_health = BTreeMap::new();
    for parts in &lines {
        if parts.first() != Some(&"account-health") {
            continue;
        }
        let [_, provider, account, mode, state, expiry] = parts.as_slice() else {
            return Err(io::Error::other("Malformed sandbox credential health"));
        };
        valid_id(provider)?;
        valid_id(account)?;
        if !matches!(*mode, "oauth" | "unbounded" | "unknown")
            || !matches!(
                *state,
                "current" | "expired" | "missing" | "invalid" | "unknown"
            )
        {
            return Err(io::Error::other("Unknown sandbox credential health"));
        }
        let expires_at_ms = if *expiry == "-" {
            None
        } else {
            Some(
                expiry
                    .parse::<i64>()
                    .map_err(|_| io::Error::other("Invalid sandbox credential expiry"))?,
            )
        };
        if expires_at_ms.is_some_and(|value| value <= 0)
            || account_health
                .insert(
                    (provider.to_string(), account.to_string()),
                    AccountHealth {
                        mode: mode.to_string(),
                        state: state.to_string(),
                        expires_at_ms,
                    },
                )
                .is_some()
        {
            return Err(io::Error::other("Conflicting sandbox credential health"));
        }
    }
    Ok(Status {
        revision: hex::encode(Sha256::digest(serde_json::to_vec(&identity)?)),
        accounts,
        account_health,
    })
}

/// What `bench-login zai` reads on standard input: the key as one printable
/// ASCII line, the form the sandbox stores and accepts.
fn api_key_input(key: &str) -> io::Result<Vec<u8>> {
    let key = key.trim();
    if key.is_empty() || key.len() > 4096 || !key.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "The saved key is not one printable line; save it again in Distill",
        ));
    }
    Ok(format!("{key}\n").into_bytes())
}

/// Copies a Z.ai account's saved key into its sandbox home, where every
/// benchmark session of the account reads a private copy. The key travels
/// only on the helper's standard input: never as an argument, a variable or
/// in a diagnostic, which carries only the helper's own short message.
pub(crate) async fn store_api_key(account: &str, key: &str) -> io::Result<()> {
    valid_id(account)?;
    let input = api_key_input(key)?;
    invoke_raw(
        "/usr/local/sbin/bench-login",
        &["zai", account],
        Some(&input),
        TAIL_BYTES,
        Duration::from_secs(60),
        None,
    )
    .await?
    .require_success("Z.ai key copy")?;
    // The account is signed in from now on, not after the reuse window.
    STATUS.forget();
    Ok(())
}

pub(crate) async fn copy(id: &str, archive: &[u8]) -> io::Result<()> {
    valid_id(id)?;
    invoke(
        "/usr/local/sbin/bench-copy",
        &[id],
        Some(archive),
        TAIL_BYTES,
        CONTROL_TIMEOUT,
    )
    .await?
    .require_success("copy")?;
    Ok(())
}

fn remaining_ms(deadline_ms: u64) -> io::Result<u64> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis() as u64;
    deadline_ms
        .checked_sub(now_ms)
        .filter(|remaining| *remaining > 0)
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "Native sandbox deadline expired"))
}

/// Helpers also stop at their own fixed limits. Only an expired native
/// deadline is a timeout of the caller's budget; a helper that stopped early
/// is an infrastructure failure and must not be recorded as budget exhaustion.
fn deadline_outcome(error: io::Error, deadline_ms: u64) -> io::Error {
    if error.kind() != io::ErrorKind::TimedOut || remaining_ms(deadline_ms).is_err() {
        return error;
    }
    io::Error::other(format!(
        "Sandbox operation stopped at its fixed time limit before the native deadline: {error}"
    ))
}

pub(crate) async fn copy_until(id: &str, archive: &[u8], deadline_ms: u64) -> io::Result<()> {
    valid_id(id)?;
    let deadline = deadline_ms.to_string();
    copy_until_inner(&[id, &deadline], Some(archive), deadline_ms)
        .await
        .and_then(|out| out.require_success("copy"))
        .map_err(|error| deadline_outcome(error, deadline_ms))?;
    Ok(())
}

async fn copy_until_inner(
    args: &[&str],
    archive: Option<&[u8]>,
    deadline_ms: u64,
) -> io::Result<Output> {
    remaining_ms(deadline_ms)?;
    // A later step's workspace waits for room inside its own deadline.
    let out = invoke_once_admitted(
        (ResourceClass::Preparation, args[0]),
        "/usr/local/sbin/bench-copy",
        args,
        archive,
        TAIL_BYTES,
        Duration::from_secs(125),
        deadline_ms,
        Some(deadline_ms),
    )
    .await?;
    if out.code == Some(124) {
        return Err(io::Error::new(io::ErrorKind::TimedOut, out.reason()));
    }
    Ok(out)
}

/// Builds the attempt's workspace from the published `tree`: the sandbox's
/// cached copy of it, or, given its `archive`, that archive once bench-copy
/// found it holds `tree`; the sandbox then keeps it for the attempts and
/// checks after. `Ok(false)` without an archive: the cache holds no copy
/// and nothing was written, so the caller sends the archive.
pub(crate) async fn copy_tree(
    id: &str,
    tree: &str,
    archive: Option<&[u8]>,
    deadline_ms: Option<u64>,
) -> io::Result<bool> {
    valid_id(id)?;
    valid_tree(tree)?;
    let deadline_ms = match deadline_ms {
        Some(deadline_ms) => deadline_ms,
        None => now_ms()?.saturating_add(CONTROL_TIMEOUT.as_millis() as u64),
    };
    let deadline = deadline_ms.to_string();
    let mut args = vec![id, deadline.as_str(), tree];
    if archive.is_some() {
        args.push("-");
    }
    let out = copy_until_inner(&args, archive, deadline_ms)
        .await
        .map_err(|error| deadline_outcome(error, deadline_ms))?;
    if archive.is_none() && not_cached(&out, tree) {
        return Ok(false);
    }
    out.require_success("copy")?;
    Ok(true)
}

fn valid_tree(tree: &str) -> io::Result<()> {
    if matches!(tree.len(), 40 | 64)
        && tree
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(io::Error::other("Invalid snapshot tree id"))
    }
}

/// The helper's answer when the sandbox's snapshot cache holds no copy of
/// `tree`: it wrote nothing, and the caller may send the snapshot.
fn not_cached(out: &Output, tree: &str) -> bool {
    out.code == Some(3)
        && out.infrastructure_error().is_none()
        && out.stdout == format!("not cached {tree}\n").as_bytes()
}

// The Linux worker owns its process group. The native absolute deadline is
// recomputed there after WSL startup, before any Git/status work can begin.
const DEADLINE_WORKER: &str = r#"import os, signal, subprocess, sys, time
program, ident, deadline = sys.argv[1:]
remaining = min(120.0, (int(deadline) - time.time_ns() // 1_000_000) / 1000)
if remaining <= 0:
    sys.exit(124)
child = subprocess.Popen([program] + ([ident] if ident else []), start_new_session=True)
try:
    sys.exit(child.wait(timeout=remaining))
except subprocess.TimeoutExpired:
    os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    sys.exit(124)
"#;

async fn invoke_until(program: &str, id: &str, cap: usize, deadline_ms: u64) -> io::Result<Output> {
    invoke_until_inner(program, id, cap, deadline_ms)
        .await
        .map_err(|error| deadline_outcome(error, deadline_ms))
}

async fn invoke_until_inner(
    program: &str,
    id: &str,
    cap: usize,
    deadline_ms: u64,
) -> io::Result<Output> {
    let remaining = remaining_ms(deadline_ms)?.min(120_000);
    let deadline = deadline_ms.to_string();
    let args: [&str; 5] = ["-c", DEADLINE_WORKER, program, id, &deadline];
    // A workload helper (a patch) holds its lease before the worker starts,
    // waiting for room inside the native deadline: its turn already ended,
    // and Windows headroom that is short for a moment must not lose it.
    let out = match helper_phase(program, &[id]) {
        Some((class, _)) => {
            invoke_once_admitted(
                (class, id),
                "/usr/bin/python3",
                &args,
                None,
                cap,
                Duration::from_secs(125),
                deadline_ms,
                Some(deadline_ms),
            )
            .await?
        }
        None => {
            invoke(
                "/usr/bin/python3",
                &args,
                None,
                cap,
                Duration::from_millis(remaining) + Duration::from_secs(5),
            )
            .await?
        }
    };
    if out.code == Some(124) {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Native sandbox deadline expired",
        ));
    }
    Ok(out)
}

/// [`ready`] within a native deadline: the shared observation of the last
/// seconds, or a new one the deadline bounds. Only a deadline that passes
/// is a timeout.
pub(crate) async fn ready_until(deadline_ms: u64) -> io::Result<Status> {
    let remaining = remaining_ms(deadline_ms)?;
    tokio::time::timeout(
        Duration::from_millis(remaining),
        STATUS.get((), false, observe_status),
    )
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Native sandbox deadline expired"))?
}

/// Apply/export data-only repository transitions in protected root staging.
/// The helper never checks out or executes candidate files.
pub(crate) async fn artifact(id: &str, package: &[u8], deadline_ms: u64) -> io::Result<Vec<u8>> {
    artifact_inner(id, package, deadline_ms)
        .await
        .map_err(|error| deadline_outcome(error, deadline_ms))
}

async fn artifact_inner(id: &str, package: &[u8], deadline_ms: u64) -> io::Result<Vec<u8>> {
    valid_id(id)?;
    const MAX_PACKAGE: usize = 512 * 1024 * 1024;
    if package.len() > MAX_PACKAGE {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "Artifact package exceeds its byte limit",
        ));
    }
    remaining_ms(deadline_ms)?;
    let deadline = deadline_ms.to_string();
    let out = invoke_once_admitted(
        (ResourceClass::Preparation, id),
        "/usr/local/sbin/bench-artifact",
        &[id, &deadline],
        Some(package),
        MAX_PACKAGE,
        // The worker expires itself at the root deadline and kills/reaps Git.
        // This bounded grace lets that cleanup finish before the host gives up.
        Duration::from_secs(115),
        deadline_ms,
        Some(deadline_ms),
    )
    .await?;
    let reason = String::from_utf8_lossy(&out.stderr);
    if out.code == Some(2)
        && matches!(
            reason.trim(),
            "Artifact transition exceeded its time limit"
                | "Artifact deadline expired before staging"
                | "Artifact deadline expired before input"
        )
    {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            reason.trim().to_owned(),
        ));
    }
    let out = out.require_success("artifact transition")?;
    if out.truncated {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "Artifact result exceeds its byte limit",
        ));
    }
    Ok(out.stdout)
}

pub(crate) async fn patch(id: &str, max_bytes: usize) -> io::Result<Vec<u8>> {
    valid_id(id)?;
    let out = invoke_once_admitted(
        (ResourceClass::Preparation, id),
        "/usr/local/sbin/bench-patch",
        &[id],
        None,
        max_bytes,
        CONTROL_TIMEOUT,
        now_ms()?.saturating_add(COLLECTION_ADMISSION.as_millis() as u64),
        None,
    )
    .await?;
    let out = require_patch(out)?;
    if out.truncated {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "The patch exceeds the artifact budget",
        ));
    }
    Ok(out.stdout)
}

pub(crate) async fn patch_until(
    id: &str,
    max_bytes: usize,
    deadline_ms: u64,
) -> io::Result<Vec<u8>> {
    valid_id(id)?;
    let out = invoke_until("/usr/local/sbin/bench-patch", id, max_bytes, deadline_ms).await?;
    let out = require_patch(out)?;
    if out.truncated {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "The patch exceeds the artifact budget",
        ));
    }
    Ok(out.stdout)
}

fn require_patch(out: Output) -> io::Result<Output> {
    let diagnostic = String::from_utf8_lossy(&out.stderr);
    // Git's explicit candidate encoding failures are measured invalid
    // artifacts. Filesystem/process/unknown Git failures remain infrastructure.
    if !out.success()
        && [
            "failed to encode",
            "BOM is required",
            "contains a byte order mark",
        ]
        .iter()
        .any(|message| diagnostic.contains(message))
    {
        return Err(io::Error::new(io::ErrorKind::InvalidData, out.reason()));
    }
    out.require_success("patch")
}

/// Prepares check `id` on the published `tree`. The package carries the
/// snapshot (snapshot.tar) only when the sandbox's cache lacks it; for one
/// without it, `Ok(None)` says the cache holds no copy and nothing was
/// prepared, so the caller sends the snapshot.
pub(crate) async fn prepare_check(
    id: &str,
    tree: &str,
    package: &[u8],
) -> io::Result<Option<Output>> {
    valid_id(id)?;
    valid_tree(tree)?;
    let result = invoke(
        "/usr/local/sbin/bench-check-prep",
        &[id, tree],
        Some(package),
        TAIL_BYTES,
        CONTROL_TIMEOUT,
    )
    .await;
    // Preparing applies the answer in a checker cgroup, too.
    kill("check", id).await?;
    let out = result?;
    if not_cached(&out, tree) {
        return Ok(None);
    }
    if out.code == Some(2) {
        return Ok(Some(out));
    }
    out.require_success("prepare check").map(Some)
}

pub(crate) async fn check(id: &str, argv: &[String], seconds: u64) -> io::Result<Output> {
    valid_id(id)?;
    if argv.is_empty() {
        return Err(io::Error::other("The check needs a command"));
    }
    let seconds_arg = seconds.to_string();
    let mut args = vec![id, &seconds_arg, "--"];
    args.extend(argv.iter().map(String::as_str));
    // The check's own limit runs from its start inside the sandbox. A wait
    // for room before it must not cut that limit short and turn a slow
    // queue into a failed check; bench-judge stops the check itself.
    let result = async {
        let phase = leased_class("/usr/local/sbin/bench-judge", &args)
            .await?
            .ok_or_else(|| io::Error::other("Sandbox check has no lease class"))?;
        invoke_once_admitted(
            phase,
            "/usr/local/sbin/bench-judge",
            &args,
            None,
            TAIL_BYTES,
            Duration::from_secs(seconds) + Duration::from_secs(30),
            now_ms()?.saturating_add(300_000),
            None,
        )
        .await
    }
    .await;
    // Windows Job Objects do not kill Linux children. Also remove detached
    // children after an ordinary exit; they must not outlive an evaluation.
    kill("check", id).await?;
    result
}

pub(crate) async fn kill(mode: &str, id: &str) -> io::Result<()> {
    valid_id(id)?;
    if !["session", "check", "probe", "login", "browser", "prep"].contains(&mode) {
        return Err(io::Error::other("Invalid sandbox mode"));
    }
    invoke(
        "/usr/local/sbin/bench-kill",
        &[mode, id],
        None,
        TAIL_BYTES,
        Duration::from_secs(15),
    )
    .await?
    .require_success("kill")?;
    Ok(())
}

/// Start Linux cleanup even while the host's async runtime is shutting down.
/// The helper is its own Windows process and finishes the cgroup kill after
/// the app exits. Explicit cancellation awaits `kill` instead.
pub(crate) fn kill_detached(id: &str) {
    kill_mode_detached("session", id);
}

pub(crate) fn kill_mode_detached(mode: &str, id: &str) {
    if !["session", "check", "probe", "login", "browser", "prep"].contains(&mode)
        || valid_id(id).is_err()
    {
        return;
    }
    let mut command = std::process::Command::new("wsl.exe");
    command
        .args([
            "-d",
            DISTRIBUTION,
            "-u",
            "root",
            "--exec",
            "/usr/local/sbin/bench-kill",
            mode,
            id,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    super::process::apply_no_window(&mut command);
    if let Err(error) = command.spawn() {
        log::warn!("[benchmarks] cannot stop sandbox {id}: {error}");
    }
}

pub(crate) async fn clean(id: &str) -> io::Result<()> {
    valid_id(id)?;
    invoke(
        "/usr/local/sbin/bench-clean",
        &[id],
        None,
        TAIL_BYTES,
        Duration::from_secs(30),
    )
    .await?
    .require_success("clean")?;
    Ok(())
}

/// Cancelling an async evaluator must still clean its Linux processes. Crash
/// recovery can use the same idempotent clean operation for recorded owners.
pub(crate) struct Cleanup(pub Option<String>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(id) = self.0.take() {
            if valid_id(&id).is_err() {
                return;
            }
            // An async spawn can be discarded while Tokio is shutting down.
            // This independent Windows helper owns bounded Linux cleanup even
            // after the application/runtime has exited.
            let mut command = std::process::Command::new("wsl.exe");
            command
                .args([
                    "-d",
                    DISTRIBUTION,
                    "-u",
                    "root",
                    "--exec",
                    "/usr/local/sbin/bench-clean",
                    &id,
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            super::process::apply_no_window(&mut command);
            if let Err(error) = command.spawn() {
                log::warn!("[benchmarks] cannot start independent sandbox cleanup {id}: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status() -> String {
        let mut lines: Vec<String> = FILES
            .iter()
            .map(|(name, bytes)| format!("file {name} {}", resource_hash(bytes)))
            .collect();
        let pins: BTreeMap<String, String> = serde_json::from_str(include_str!(
            "../../resources/benchmark-sandbox/runtime-pins.json"
        ))
        .unwrap();
        lines.extend(pins.iter().map(|(key, value)| format!("{key} {value}")));
        lines.push("netns up".into());
        lines.extend(budget("off"));
        lines.join("\n")
    }

    #[test]
    fn a_leased_run_s_outcome_comes_from_its_framed_last_stderr_line() {
        let nonce = "b".repeat(32);
        let token = "a".repeat(32);
        let mut stderr = format!(
            "resource_admitted: prep\ncopied invented\n{nonce} outcome {{\"token\": \"{token}\", \"infrastructureError\": null}}\n"
        )
        .into_bytes();
        let value = take_outcome_trailer(&mut stderr, &nonce).unwrap();
        assert_eq!(value["token"], token);
        assert!(value["infrastructureError"].is_null());
        assert_eq!(stderr, b"resource_admitted: prep\ncopied invented\n");
        // A line with another nonce, or not the last one, is not the receipt:
        // the separate outcome call decides then.
        let forged = "c".repeat(32);
        for text in [
            format!("{forged} outcome {{\"token\": \"{token}\", \"infrastructureError\": \"x\"}}\n"),
            format!("{nonce} outcome {{\"token\": \"{token}\", \"infrastructureError\": null}}\nlater\n"),
            "no receipt at all\n".to_owned(),
        ] {
            let mut stderr = text.clone().into_bytes();
            assert!(take_outcome_trailer(&mut stderr, &nonce).is_none(), "{text}");
            assert_eq!(stderr, text.into_bytes());
        }
    }

    fn budget(cap: &str) -> Vec<String> {
        let mut lines = vec![format!("budget heavy-cap {cap}")];
        lines.extend(FIXED_BUDGET.map(str::to_owned));
        lines
    }

    #[test]
    fn readiness_pins_the_dynamic_policy_but_not_the_operators_cap() {
        let base = status();
        let revision = parse_status(&base).unwrap().revision;
        for cap in ["off", "1", "2", "8"] {
            let changed = base.replace(&budget("off").join("\n"), &budget(cap).join("\n"));
            assert_eq!(parse_status(&changed).unwrap().revision, revision, "{cap}");
        }
        let off = budget("off").join("\n");
        for invalid in [
            off.replace("budget heavy-cap off", "budget heavy-cap 0"),
            off.replace("budget heavy-cap off", "budget heavy-cap 9"),
            off.replace("budget heavy-cap off", "budget heavy-cap two"),
            off.replace(
                "budget heavy-cap off",
                "budget heavy-cap off\nbudget heavy-cap 2",
            ),
            off.replace("budget heavy-cap off\n", ""),
            // The fixed policy's aggregate, or another policy, is not this one.
            off.replace("budget admission dynamic-v2\n", ""),
            off.replace("budget admission dynamic-v2", "budget admission dynamic-v1"),
            off.replace("budget memory 25769803776", "budget memory 19327352832"),
            off.replace("budget cpu 1500000/100000", "budget cpu 1450000/100000"),
            off.replace("light 33554432/8388608", "light 134217728/33554432"),
        ] {
            assert!(
                parse_status(&base.replace(&off, &invalid)).is_err(),
                "{invalid}"
            );
        }
        // A status from the fixed heavy lanes is not the dynamic policy.
        let fixed = base.replace(&off, "budget heavy-lanes 2\nbudget memory 19327352832");
        assert!(parse_status(&fixed).is_err());
    }

    #[test]
    fn a_dynamic_admission_record_keeps_what_admission_measured() {
        // The shape bench-budget prints beside a dynamic reservation token.
        let printed = serde_json::json!({
            "policy": "dynamic-v2", "heavyCap": null, "lane": "light",
            "competing": {"repository": 2}, "competingHeavy": 2,
            "reservedMemory": 5 * GIB, "reservedCpu": 4, "memoryCurrent": 3 * GIB,
            "guestLoad": [0.8, 0.9, 0.7], "guestCpus": 16,
            "hostAvailableRam": 28 * GIB, "hostAvailableCommit": 20 * GIB,
            "guestMemAvailable": 25 * GIB, "hostCpuBusy": 0.18,
            "expectedMemory": 655360000, "cpuLine": 6, "sandboxCpu": 1.25,
            "cpuPressure": 0.02, "checkStall": null, "cpuCapacity": 11,
            "sessionBurst": 0.5, "repositorySessions": 2, "admittedBy": null,
        });
        let admission: Admission = serde_json::from_value(printed).unwrap();
        assert_eq!(admission.policy.as_deref(), Some("dynamic-v2"));
        assert_eq!(
            (
                admission.cpu_capacity,
                admission.session_burst,
                admission.repository_sessions
            ),
            (Some(11), Some(0.5), Some(2))
        );
        // A light job is admitted by neither CPU-heavy rule.
        assert_eq!(admission.admitted_by, None);
        assert_eq!(admission.heavy_lanes, None);
        assert_eq!(admission.cpu_line, Some(6));
        assert_eq!(admission.sandbox_cpu, Some(1.25));
        assert_eq!(admission.host_cpu_busy, Some(0.18));
        // Absent measurements stay absent in the sealed record.
        let sealed = serde_json::to_value(&admission).unwrap();
        assert!(sealed.get("checkStall").is_none() && sealed.get("heavyLanes").is_none());
    }

    #[test]
    fn a_session_admission_record_is_parsed_and_handed_out_once() {
        // The shape bench-budget prints beside a reservation token.
        let printed = serde_json::json!({
            "heavyLanes": 2, "lane": "heavy", "competing": {"text": 1, "repository": 1},
            "competingHeavy": 1, "reservedMemory": 8 * GIB, "reservedCpu": 3,
            "memoryCurrent": 3 * GIB, "guestLoad": [1.5, 0.75, 0.25], "guestCpus": 16,
            "hostAvailableRam": 28 * GIB, "hostAvailableCommit": 20 * GIB,
            "guestMemAvailable": 32 * GIB,
        });
        let mut admission: Admission = serde_json::from_value(printed.clone()).unwrap();
        assert_eq!(admission.competing_heavy, 1);
        assert_eq!(serde_json::to_value(&admission).unwrap(), printed);
        assert_eq!(admission.heavy_lanes, Some(2));
        let mut incomplete = printed;
        incomplete.as_object_mut().unwrap().remove("lane");
        assert!(serde_json::from_value::<Admission>(incomplete).is_err());
        admission.host_cpu_busy = Some(0.42);
        record_session_admission("invented-sandbox", admission.clone());
        assert_eq!(take_session_admission("invented-sandbox"), Some(admission));
        assert_eq!(take_session_admission("invented-sandbox"), None);
        assert_eq!(take_session_admission("another-invented-sandbox"), None);
    }
    #[test]
    fn only_an_expired_native_deadline_is_a_budget_timeout() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let stopped = || io::Error::new(io::ErrorKind::TimedOut, "helper limit");
        assert_eq!(
            deadline_outcome(stopped(), now + 3_600_000).kind(),
            io::ErrorKind::Other
        );
        assert_eq!(
            deadline_outcome(stopped(), now.saturating_sub(1)).kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            deadline_outcome(io::Error::other("unrelated"), now + 3_600_000).kind(),
            io::ErrorKind::Other
        );
    }

    #[test]
    fn only_the_helpers_own_answer_for_the_asked_tree_is_a_cache_miss() {
        let tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
        let answer = |code, stdout: &str, infrastructure: Option<&str>| Output {
            code: Some(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
            truncated: false,
            infrastructure: infrastructure.map(str::to_owned),
        };
        assert!(not_cached(
            &answer(3, &format!("not cached {tree}\n"), None),
            tree
        ));
        // Another tree's miss, another exit, or a lease the broker failed
        // are no reason to send the snapshot and try again.
        let other = "0".repeat(40);
        assert!(!not_cached(
            &answer(3, &format!("not cached {other}\n"), None),
            tree
        ));
        assert!(!not_cached(
            &answer(70, &format!("not cached {tree}\n"), None),
            tree
        ));
        assert!(!not_cached(&answer(3, "", None), tree));
        assert!(!not_cached(
            &answer(
                3,
                &format!("not cached {tree}\n"),
                Some("infrastructure_error: x")
            ),
            tree
        ));
    }

    #[test]
    fn a_snapshot_tree_is_a_full_lowercase_git_object_id() {
        assert!(valid_tree(&"a".repeat(40)).is_ok());
        assert!(valid_tree(&"0123456789abcdef".repeat(4)).is_ok());
        for tree in [
            "A".repeat(40),
            "a".repeat(39),
            "g".repeat(40),
            "a".repeat(41),
            String::new(),
        ] {
            assert!(valid_tree(&tree).is_err(), "{tree}");
        }
        assert!(valid_tree(&format!("-{}", "a".repeat(39))).is_err());
    }

    #[test]
    fn linux_source_identity_canonicalizes_windows_line_endings() {
        assert_eq!(
            resource_hash(b"first\nsecond\n"),
            resource_hash(b"first\r\nsecond\r\n")
        );
        assert_ne!(
            resource_hash(b"first\rsecond\n"),
            resource_hash(b"first\nsecond\n")
        );
    }

    #[test]
    fn admission_keeps_desktop_ram_commit_and_actual_sandbox_volume_floors() {
        let healthy = HostHeadroom {
            available_ram: 28 * GIB,
            available_commit: 20 * GIB,
            sandbox_volume_free: 57 * GIB,
        };
        assert!(check_headroom(&healthy, ResourceClass::PairedCheck.memory()).is_ok());
        assert!(check_headroom(
            &HostHeadroom {
                available_ram: 13 * GIB,
                ..healthy
            },
            2 * GIB
        )
        .is_err());
        assert!(check_headroom(
            &HostHeadroom {
                available_commit: 9 * GIB,
                ..healthy
            },
            2 * GIB
        )
        .is_err());
        assert!(check_headroom(
            &HostHeadroom {
                sandbox_volume_free: 29 * GIB,
                ..healthy
            },
            2 * GIB
        )
        .is_err());
    }

    #[test]
    fn readiness_pins_resources_and_runtime_and_never_infers_a_sign_in() {
        let base = status();
        let ready = parse_status(&base).unwrap();
        assert!(ready.require_account("claude", "account-1").is_err());
        let signed = parse_status(&format!("{base}\naccount claude account-1 yes")).unwrap();
        assert!(signed.require_account("claude", "account-1").is_ok());
        assert_eq!(ready.revision, signed.revision);
        assert!(parse_status(&base.replace("file bench-run", "file other")).is_err());
        assert!(parse_status(
            &base.replace("tool codex-acp file codex", "tool changed file codex")
        )
        .is_err());
        assert!(parse_status(&base.replace("netns up", "netns down")).is_err());
        for id in ["", "../other", "/tmp/file", "a;b"] {
            assert!(valid_id(id).is_err());
        }
    }

    #[test]
    fn oauth_health_must_cover_the_whole_attempt_and_cleanup() {
        let base = format!("{}\naccount claude account-1 yes", status());
        let now = 1_800_000_000_000;
        let deadline = now + 600_000 + 300_000;
        let check = |health: &str| {
            parse_status(&format!("{base}\naccount-health claude account-1 {health}"))
                .unwrap()
                .require_account_window("claude", "account-1", now, 600)
        };
        assert!(check(&format!("oauth current {}", deadline + 1)).is_ok());
        for health in [
            format!("oauth current {deadline}"),
            format!("oauth current {}", now + 1),
            format!("oauth expired {}", deadline + 1),
            "oauth current -".into(),
            "oauth unknown -".into(),
            "unknown unknown -".into(),
            "oauth missing -".into(),
            "oauth invalid -".into(),
        ] {
            assert!(check(&health).is_err(), "{health}");
        }
        assert!(parse_status(&base)
            .unwrap()
            .require_account_window("claude", "account-1", now, 600)
            .is_err());
        let ready = parse_status(&format!(
            "{base}\naccount-health claude account-1 oauth current {}",
            deadline + 1
        ))
        .unwrap();
        assert!(ready
            .require_account_window("claude", "account-2", now, 600)
            .is_err());
        assert!(ready
            .require_account_window("claude", "account-1", -1, 600)
            .is_err());
        assert!(ready
            .require_account_window("claude", "account-1", now, 0)
            .is_err());
        assert!(ready
            .require_account_window("claude", "account-1", i64::MAX, 600)
            .is_err());
    }

    /// What a renewal may act on: a grant bench-auth reads, even an expired
    /// one, whose refresh token the CLI still holds. The admission window
    /// itself stays the one `require_account_window` computes.
    #[test]
    fn only_a_readable_oauth_grant_has_an_expiry_its_cli_can_renew() {
        let base = status();
        let health = |line: &str| {
            parse_status(&format!(
                "{base}\naccount grok account-1 no\naccount-health grok account-1 {line}"
            ))
            .unwrap()
        };
        assert_eq!(
            health("oauth current 1800000900000").oauth_expiry("grok", "account-1"),
            Some(1_800_000_900_000)
        );
        assert_eq!(
            health("oauth expired 1700000000000").oauth_expiry("grok", "account-1"),
            Some(1_700_000_000_000)
        );
        for line in [
            "oauth unknown -",
            "oauth current -",
            "oauth missing -",
            "oauth invalid -",
            "unbounded unknown -",
            "unknown invalid -",
        ] {
            assert_eq!(
                health(line).oauth_expiry("grok", "account-1"),
                None,
                "{line}"
            );
        }
        let signed = health("oauth current 1800000900000");
        assert_eq!(signed.oauth_expiry("grok", "account-2"), None);
        assert_eq!(signed.oauth_expiry("claude", "account-1"), None);
        assert_eq!(
            admission_deadline(1_800_000_000_000, 600).unwrap(),
            1_800_000_000_000 + 600_000 + 300_000
        );
        assert!(admission_deadline(i64::MAX, 600).is_err());
    }

    #[test]
    fn credential_health_is_volatile_evidence_not_runtime_identity() {
        let base = status();
        let original = parse_status(&base).unwrap();
        for health in [
            "oauth expired 100",
            "oauth current 1800001000000",
            "unbounded unknown -",
        ] {
            let signed = parse_status(&format!(
                "{base}\naccount grok account-1 yes\naccount-health grok account-1 {health}"
            ))
            .unwrap();
            assert_eq!(signed.revision, original.revision);
        }
        let unbounded = parse_status(&format!(
            "{base}\naccount grok account-1 yes\naccount-health grok account-1 unbounded unknown -"
        ))
        .unwrap();
        assert!(unbounded
            .require_account_window("grok", "account-1", 1_800_000_000_000, 3600)
            .is_ok());
    }

    #[test]
    fn a_refreshed_shared_grant_cannot_extend_an_earlier_session_snapshot() {
        let start = 1_800_000_000_000;
        let prefix = format!(
            "{}\naccount claude account-1 yes\naccount-health claude account-1 oauth current",
            status()
        );
        let original = parse_status(&format!("{prefix} {}", start + 1_000_000)).unwrap();
        assert!(original
            .require_account_window("claude", "account-1", start, 600)
            .is_ok());
        let after_setup = start + 200_000;
        let refreshed = parse_status(&format!("{prefix} {}", start + 2_000_000)).unwrap();
        assert!(refreshed
            .require_account_window("claude", "account-1", after_setup, 600)
            .is_ok());
        assert!(original
            .require_account_window("claude", "account-1", after_setup, 600)
            .is_err());
    }

    #[test]
    fn providers_without_an_expiry_adapter_keep_existing_account_checks() {
        for provider in ["codex", "kimi"] {
            let base = status();
            let signed = parse_status(&format!(
                "{base}\naccount {provider} account-1 yes\naccount-health {provider} account-1 unknown unknown -"
            ))
            .unwrap();
            assert!(signed
                .require_account_window(provider, "account-1", 1_800_000_000_000, 3600)
                .is_ok());
            assert!(signed
                .require_account_window(provider, "account-2", 1_800_000_000_000, 3600)
                .is_err());
        }
    }

    /// A Z.ai key is an API key: signed in while bench-login stored one, with
    /// no expiry claim, and part of no runtime identity.
    #[test]
    fn a_zai_key_is_an_unbounded_sign_in_outside_runtime_identity() {
        let base = status();
        let signed = parse_status(&format!(
            "{base}\naccount zai account-1 yes\naccount-health zai account-1 unbounded unknown -"
        ))
        .unwrap();
        assert_eq!(signed.revision, parse_status(&base).unwrap().revision);
        assert!(signed
            .require_account_window("zai", "account-1", 1_800_000_000_000, 3600)
            .is_ok());
        let missing = parse_status(&format!(
            "{base}\naccount zai account-1 no\naccount-health zai account-1 unknown missing -"
        ))
        .unwrap();
        assert!(missing.require_account("zai", "account-1").is_err());
        // The pinned OpenCode and its ripgrep are part of the runtime.
        for pin in [
            "binary /opt/distill-tools/bin/opencode",
            "binary /opt/distill-tools/zai/bin/rg",
            "tool zai file opencode",
        ] {
            let line = base.lines().find(|line| line.starts_with(pin)).unwrap();
            assert!(parse_status(&base.replace(line, &format!("{pin} changed"))).is_err());
        }
    }

    #[test]
    fn a_saved_key_reaches_bench_login_as_one_line_or_not_at_all() {
        assert_eq!(
            api_key_input("  invented-zai-key.Part2  ").unwrap(),
            b"invented-zai-key.Part2\n"
        );
        let long = "k".repeat(4097);
        for invalid in [
            "",
            "   ",
            "invented key",
            "invented\nkey",
            "invented\u{e9}key",
            long.as_str(),
        ] {
            let error = api_key_input(invalid).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            assert!(!error.to_string().contains("invented"));
        }
    }

    #[test]
    fn malformed_or_duplicate_credential_health_is_rejected_without_echoing_input() {
        let base = status();
        for health in [
            "claude account-1 oauth current",
            "claude account-1 invented current -",
            "claude account-1 oauth invented -",
            "claude account-1 oauth current secret-value",
            "claude account-1 oauth current -1",
            "claude account-1 oauth current 0",
            "claude ../account oauth current 1000",
            "claude account-1 oauth current 1000\naccount-health claude account-1 oauth current 2000",
        ] {
            let error = parse_status(&format!("{base}\naccount-health {health}"))
                .unwrap_err()
                .to_string();
            assert!(!error.contains("secret-value"));
        }
    }
    #[test]
    fn a_continuing_owner_is_marked_only_while_its_guard_lives() {
        let owner = "invented-step:1".to_owned();
        assert!(!continues(&owner));
        let guard = Continuing::new(owner.clone());
        assert!(continues(&owner));
        assert!(!continues("invented-step:2"));
        drop(guard);
        assert!(!continues(&owner));
    }

    /// Readiness checks within the reuse window share one observation, and
    /// checks that arrive while it runs wait for it; a receipt's fresh check,
    /// an expired window or a failure observes again.
    #[tokio::test]
    async fn recent_observations_are_shared_within_their_window_and_never_failures() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let recent: Arc<Recent<(), usize>> = Arc::new(Recent::new(Duration::from_millis(200)));
        let observed = Arc::new(AtomicUsize::new(0));
        let observe = |observed: Arc<AtomicUsize>| {
            move || async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok::<_, io::Error>(observed.fetch_add(1, Ordering::SeqCst) + 1)
            }
        };
        let concurrent: Vec<_> = (0..4)
            .map(|_| {
                let (recent, observed) = (recent.clone(), observed.clone());
                tokio::spawn(async move { recent.get((), false, observe(observed)).await })
            })
            .collect();
        for check in concurrent {
            assert_eq!(check.await.unwrap().unwrap(), 1);
        }
        assert_eq!(observed.load(Ordering::SeqCst), 1);
        assert_eq!(
            recent
                .get((), false, observe(observed.clone()))
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            recent
                .get((), true, observe(observed.clone()))
                .await
                .unwrap(),
            2
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(
            recent
                .get((), false, observe(observed.clone()))
                .await
                .unwrap(),
            3
        );
        let failed: Recent<(), usize> = Recent::new(Duration::from_secs(60));
        assert!(failed
            .get((), false, || async {
                Err::<usize, _>(io::Error::other("refused"))
            })
            .await
            .is_err());
        assert_eq!(
            failed
                .get((), false, || async { Ok::<_, io::Error>(7) })
                .await
                .unwrap(),
            7
        );
        // Fresh checks that ask together share one observation once the
        // one already running (which started before they asked) is done.
        let together: Arc<Recent<(), usize>> = Arc::new(Recent::new(Duration::from_secs(60)));
        let count = Arc::new(AtomicUsize::new(0));
        let asked: Vec<_> = (0..6)
            .map(|_| {
                let (together, count) = (together.clone(), count.clone());
                tokio::spawn(async move { together.get((), true, observe(count)).await })
            })
            .collect();
        for check in asked {
            assert!(check.await.unwrap().unwrap() >= 1);
        }
        assert!(count.load(Ordering::SeqCst) <= 2, "{count:?}");
        // A forgotten observation is observed again.
        failed.forget();
        assert_eq!(
            failed
                .get((), false, || async { Ok::<_, io::Error>(8) })
                .await
                .unwrap(),
            8
        );
        // Each key is its own observation.
        let keyed: Recent<&str, &str> = Recent::new(Duration::from_secs(60));
        assert_eq!(
            keyed
                .get("a", false, || async { Ok::<_, io::Error>("a") })
                .await
                .unwrap(),
            "a"
        );
        assert_eq!(
            keyed
                .get("b", false, || async { Ok::<_, io::Error>("b") })
                .await
                .unwrap(),
            "b"
        );
        assert_eq!(
            keyed
                .get("a", false, || async { Ok::<_, io::Error>("x") })
                .await
                .unwrap(),
            "a"
        );
    }

    #[tokio::test]
    async fn output_is_drained_and_only_a_bounded_tail_is_kept() {
        let bytes = vec![b'x'; 100_000];
        let (tail, truncated) = read_tail(bytes.as_slice(), 100).await.unwrap();
        assert_eq!(tail, vec![b'x'; 100]);
        assert!(truncated);
    }

    /// The host preparation queue refuses like the broker's queue when its
    /// deadline passes while another preparation holds the permit, as a
    /// qualification control met on 2026-10-17; it admits in arrival order.
    #[tokio::test]
    async fn a_host_preparation_queue_that_expires_is_a_busy_refusal() {
        let now = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
        };
        let gate = Arc::new(tokio::sync::Semaphore::new(1));
        let held = gate.clone().acquire_owned().await.unwrap();
        let refused = queue_for_preparation(&gate, now() + 50).await.unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
        assert_eq!(
            refused.to_string(),
            "resource_busy: benchmark host preparation queue expired before worker startup"
        );
        let next = tokio::spawn({
            let gate = gate.clone();
            async move { queue_for_preparation(&gate, now() + 60_000).await }
        });
        tokio::task::yield_now().await;
        drop(held);
        assert!(next.await.unwrap().is_ok());
        // A deadline already gone before the queue is the caller's own.
        let late = queue_for_preparation(&gate, now() - 1).await.unwrap_err();
        assert_eq!(late.kind(), io::ErrorKind::TimedOut);
    }

    /// A lease that waits in a busy queue until its window closes is refused
    /// as busy, never as an expired native deadline, however the closing is
    /// seen; a deadline that fires while the window is still open stays one.
    #[tokio::test]
    async fn a_lease_window_closing_in_the_queue_is_a_busy_refusal() {
        let now = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
        };
        let busy = |reason: &str| io::Error::new(io::ErrorKind::WouldBlock, reason.to_owned());
        let queued =
            "resource_busy: benchmark resource capacity is queued; no provider process started";
        // The broker answers busy until the window closes, and the deadline
        // check before the next ask sees it close, as on 2026-10-16 behind an
        // interactive sign-in that held the light lane.
        let window = now() + 60;
        let refused = admit::<(), _>(window, || async move {
            remaining_ms(window)?;
            Err(busy(queued))
        })
        .await
        .unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
        assert!(refused.to_string().starts_with("resource_busy:"));
        // Each way the closing is seen, deterministically: the deadline check
        // ("Native sandbox deadline expired"), and the broker's busy answer,
        // including the expired Windows headroom evidence of the host gate.
        let closed = now() - 1;
        for reason in [
            remaining_ms(closed).unwrap_err(),
            busy(queued),
            busy("resource_busy: Windows headroom evidence expired before execution; no provider process started"),
        ] {
            let mut reason = Some(reason);
            let refused = admit::<(), _>(closed, || {
                let reason = reason.take().expect("asked once");
                async move { Err(reason) }
            })
            .await
            .unwrap_err();
            assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
            assert_eq!(
                refused.to_string(),
                "resource_busy: benchmark preparation queue expired before worker startup"
            );
        }
        // A helper's own time limit inside an open window is not the queue's.
        let refused = admit::<(), _>(now() + 60_000, || async {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Sandbox operation exceeded its time limit",
            ))
        })
        .await
        .unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::TimedOut);
        let granted = admit(now() + 60_000, || async { Ok(7) }).await.unwrap();
        assert_eq!(granted, 7);
    }

    /// A collection, check or later step that waits for room keeps its whole
    /// run time once admitted; only its native deadline cuts it, and a
    /// deadline that passes in the queue is the queue's refusal (unscored),
    /// as a Grok step met on 2026-10-17 when a host build took the commit
    /// headroom between its two steps.
    #[tokio::test]
    async fn waiting_for_room_never_shortens_a_helpers_run_and_never_outlives_its_deadline() {
        let now = now_ms().unwrap();
        assert_eq!(
            run_after_admission(Duration::from_secs(125), None).unwrap(),
            125_000
        );
        let near = run_after_admission(Duration::from_secs(125), Some(now + 60_000)).unwrap();
        assert!((55_000..=60_000).contains(&near), "{near}");
        assert_eq!(
            run_after_admission(Duration::from_secs(125), Some(now - 1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(admission_window(now + 1_800_000, None), now + 1_800_000);
        assert_eq!(
            admission_window(now + 1_800_000, Some(now + 60_000)),
            now + 60_000
        );
        // Busy until the window closes: refused as busy, never as a timeout
        // of the candidate's budget.
        let window = admission_window(now + 1_800_000, Some(now + 80));
        let refused = admit::<(), _>(window, || async {
            Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "resource_busy: Windows commit headroom cannot cover benchmark reservations and its 8 GiB floor; no provider process started",
            ))
        })
        .await
        .unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::WouldBlock);
        assert!(refused.to_string().starts_with("resource_busy:"));
        // Room that opens inside the window admits the helper.
        let mut asked = 0;
        let admitted = admit(now_ms().unwrap() + 60_000, || {
            asked += 1;
            let busy = asked < 3;
            async move {
                if busy {
                    Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "resource_busy: queued",
                    ))
                } else {
                    Ok("lease")
                }
            }
        })
        .await
        .unwrap();
        assert_eq!((admitted, asked), ("lease", 3));
    }

    #[tokio::test]
    async fn expired_native_deadlines_refuse_before_starting_any_wsl_process() {
        assert_eq!(
            copy_until("invented-expired", b"unread input", 0)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            artifact("invented-expired", b"unread input", 0)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            patch_until("invented-expired", 1024, 0)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            ready_until(0).await.unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }

    #[tokio::test]
    #[ignore = "requires the provisioned distill-bench WSL distribution"]
    async fn copy_and_patch_use_the_pristine_base_and_enforce_the_byte_cap() {
        ready().await.unwrap();
        let mut archive = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(4);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, "file.txt", "one\n".as_bytes())
            .unwrap();
        let id = format!("copy-test-{}", uuid::Uuid::new_v4());
        let mut cleanup = Cleanup(Some(id.clone()));
        copy(&id, &archive.into_inner().unwrap()).await.unwrap();
        assert!(patch(&id, 1024).await.unwrap().is_empty());
        let edited = invoke(
            "/usr/local/sbin/bench-run",
            &[
                "session",
                &id,
                "--",
                "bash",
                "-c",
                "printf 'two\\n' >file.txt; printf 'new\\n' >added.txt; rm -rf /workspace/.git",
            ],
            None,
            TAIL_BYTES,
            CONTROL_TIMEOUT,
        )
        .await
        .unwrap();
        assert!(edited.success(), "{}", edited.reason());
        kill("session", &id).await.unwrap();
        let answer = patch(&id, 4096).await.unwrap();
        let text = String::from_utf8(answer.clone()).unwrap();
        assert!(text.contains("added.txt") && text.contains("+two"));
        assert_eq!(patch(&id, 4096).await.unwrap(), answer);
        assert_eq!(
            patch(&id, 8).await.unwrap_err().kind(),
            io::ErrorKind::FileTooLarge
        );
        clean(&id).await.unwrap();
        cleanup.0 = None;
    }
}
