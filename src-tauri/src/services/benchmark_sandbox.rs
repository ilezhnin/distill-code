//! Host transport for the dedicated repository-benchmark WSL distribution.
//! No candidate or check command is ever launched on Windows.

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
    "aggregate-linux-v1-memory12-cpu4-disk8-inodes131072-read128-write32";
const GIB: u64 = 1024 * 1024 * 1024;

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
pub(crate) async fn host_preparation(
    deadline_ms: u64,
) -> io::Result<tokio::sync::OwnedSemaphorePermit> {
    let gate = HOST_PREPARATION
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone();
    let permit = tokio::time::timeout(
        Duration::from_millis(remaining_ms(deadline_ms)?),
        gate.acquire_owned(),
    )
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "Native preparation queue deadline expired",
        )
    })?
    .map_err(io::Error::other)?;
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

pub(crate) fn host_gate() -> io::Result<String> {
    let headroom = host_headroom()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis();
    Ok(format!(
        "{now},{},{},{}",
        headroom.available_ram, headroom.available_commit, headroom.sandbox_volume_free
    ))
}

/// A pending lease expires in Linux after sixty seconds. Dropping it releases
/// only an unclaimed lease, never a process tree already owned by bench-run.
pub(crate) struct Reservation {
    pub token: String,
    class: ResourceClass,
}
impl Drop for Reservation {
    fn drop(&mut self) {
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

pub(crate) async fn reserve(
    class: ResourceClass,
    id: &str,
    deadline_ms: u64,
) -> io::Result<Reservation> {
    reserve_with_buffers(class, id, deadline_ms, 0).await
}

async fn reserve_with_buffers(
    class: ResourceClass,
    id: &str,
    deadline_ms: u64,
    host_buffers: usize,
) -> io::Result<Reservation> {
    valid_id(id)?;
    remaining_ms(deadline_ms)?;
    host_admission_for(class).await?;
    let gate = host_gate()?;
    let deadline = deadline_ms.to_string();
    let host_buffers = host_buffers.to_string();
    let out = invoke_raw(
        "/usr/local/sbin/bench-budget",
        &["reserve", class.key(), id, &deadline, &gate, &host_buffers],
        None,
        4096,
        Duration::from_millis(remaining_ms(deadline_ms)?.min(15_000)),
        None,
    )
    .await?;
    if !out.success() && out.reason().contains("resource_busy:") {
        return Err(io::Error::new(io::ErrorKind::WouldBlock, out.reason()));
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
    Ok(Reservation {
        token: token.to_owned(),
        class,
    })
}

#[cfg(not(windows))]
fn host_headroom() -> io::Result<HostHeadroom> {
    Err(io::Error::other(
        "capability_missing: the benchmark host headroom service requires Windows",
    ))
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

#[derive(Debug)]
pub(crate) struct Status {
    pub revision: String,
    accounts: Vec<(String, String)>,
    account_health: BTreeMap<(String, String), AccountHealth>,
}

#[derive(Debug)]
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
        let deadline = now_ms
            .checked_add(i64::from(timeout_seconds) * 1000)
            .and_then(|value| value.checked_add(300_000))
            .ok_or_else(|| io::Error::other("Invalid credential admission window"))?;
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

async fn invoke_raw(
    program: &str,
    args: &[&str],
    input: Option<&[u8]>,
    cap: usize,
    timeout: Duration,
    reservation: Option<&Reservation>,
) -> io::Result<Output> {
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
    let value: serde_json::Value = serde_json::from_slice(&receipt.stdout)?;
    if let Some(reason) = value["infrastructureError"].as_str() {
        if value["token"] != reservation.token {
            return Err(io::Error::other("Sandbox resource outcome owner differs"));
        }
        out.infrastructure = Some(reason.to_owned());
    }
    Ok(out)
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
    let Some((mut class, id)) = helper_phase(program, args) else {
        return invoke_raw(program, args, input, cap, timeout, None).await;
    };
    if program == "/usr/local/sbin/bench-judge" {
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
        class = match response.stdout.as_slice() {
            b"check\n" => ResourceClass::Check,
            b"pair\n" => ResourceClass::PairedCheck,
            _ => return Err(io::Error::other("Sandbox check classification is invalid")),
        };
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis() as u64;
    let deadline = now.saturating_add(timeout.as_millis().min(u64::MAX as u128) as u64);
    let admission_deadline = deadline.min(now.saturating_add(300_000));
    let host_buffers = cap.saturating_mul(2).saturating_add(TAIL_BYTES * 2);
    let lease = loop {
        match reserve_with_buffers(class, id, deadline, host_buffers).await {
            Ok(lease) => break lease,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let remaining =
                    remaining_ms(admission_deadline).map_err(|_| {
                        io::Error::new(io::ErrorKind::WouldBlock,
                    "resource_busy: benchmark preparation queue expired before worker startup")
                    })?;
                tokio::time::sleep(Duration::from_millis(remaining.min(1000))).await;
            }
            Err(error) => return Err(error),
        }
    };
    // A child is launched exactly once. Only failed pre-execution admissions
    // are retried; captured input is retained without paid-model replay.
    invoke_reserved_bounded(
        &lease,
        program,
        args,
        input,
        cap,
        Duration::from_millis(remaining_ms(deadline)?),
    )
    .await
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

/// Runtime identity is independent of credentials. Status separately exposes
/// redacted local health and expiry, never tokens or credential contents.
pub(crate) async fn ready() -> io::Result<Status> {
    host_admission().await?;
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
    for line in [
        "budget memory 12884901888",
        "budget cpu 400000/100000",
        "budget swap 0",
        "budget pids 1536",
        "budget disk 8589934592",
        "budget inodes 131072",
        "budget io 134217728/33554432",
    ] {
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
    copy_until_inner(id, archive, deadline_ms)
        .await
        .map_err(|error| deadline_outcome(error, deadline_ms))
}

async fn copy_until_inner(id: &str, archive: &[u8], deadline_ms: u64) -> io::Result<()> {
    valid_id(id)?;
    let remaining = remaining_ms(deadline_ms)?.min(120_000);
    let deadline = deadline_ms.to_string();
    let out = invoke(
        "/usr/local/sbin/bench-copy",
        &[id, &deadline],
        Some(archive),
        TAIL_BYTES,
        Duration::from_millis(remaining) + Duration::from_secs(5),
    )
    .await?;
    if out.code == Some(124) {
        return Err(io::Error::new(io::ErrorKind::TimedOut, out.reason()));
    }
    out.require_success("copy")?;
    Ok(())
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
    let out = invoke(
        "/usr/bin/python3",
        &["-c", DEADLINE_WORKER, program, id, &deadline],
        None,
        cap,
        Duration::from_millis(remaining) + Duration::from_secs(5),
    )
    .await?;
    if out.code == Some(124) {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Native sandbox deadline expired",
        ));
    }
    Ok(out)
}

pub(crate) async fn ready_until(deadline_ms: u64) -> io::Result<Status> {
    let out = invoke_until("/usr/local/sbin/bench-status", "", 128 * 1024, deadline_ms)
        .await?
        .require_success("status")?;
    if out.truncated {
        return Err(io::Error::other("Sandbox status exceeded its limit"));
    }
    parse_status(&String::from_utf8_lossy(&out.stdout))
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
    let remaining_ms = remaining_ms(deadline_ms)?.min(110_000);
    let deadline = deadline_ms.to_string();
    let out = invoke(
        "/usr/local/sbin/bench-artifact",
        &[id, &deadline],
        Some(package),
        MAX_PACKAGE,
        // The worker expires itself at the root deadline and kills/reaps Git.
        // This bounded grace lets that cleanup finish before the host gives up.
        Duration::from_millis(remaining_ms) + Duration::from_secs(5),
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
    let out = invoke(
        "/usr/local/sbin/bench-patch",
        &[id],
        None,
        max_bytes,
        CONTROL_TIMEOUT,
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

pub(crate) async fn prepare_check(id: &str, archive: &[u8]) -> io::Result<Output> {
    valid_id(id)?;
    let result = invoke(
        "/usr/local/sbin/bench-check-prep",
        &[id],
        Some(archive),
        TAIL_BYTES,
        CONTROL_TIMEOUT,
    )
    .await;
    // Preparing applies the answer in a checker cgroup, too.
    kill("check", id).await?;
    let out = result?;
    if out.code == Some(2) {
        return Ok(out);
    }
    out.require_success("prepare check")
}

pub(crate) async fn check(id: &str, argv: &[String], seconds: u64) -> io::Result<Output> {
    valid_id(id)?;
    if argv.is_empty() {
        return Err(io::Error::other("The check needs a command"));
    }
    let seconds_arg = seconds.to_string();
    let mut args = vec![id, &seconds_arg, "--"];
    args.extend(argv.iter().map(String::as_str));
    let result = invoke(
        "/usr/local/sbin/bench-judge",
        &args,
        None,
        TAIL_BYTES,
        Duration::from_secs(seconds),
    )
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
        lines.extend(
            [
                "budget memory 12884901888",
                "budget cpu 400000/100000",
                "budget swap 0",
                "budget pids 1536",
                "budget disk 8589934592",
                "budget inodes 131072",
                "budget io 134217728/33554432",
            ]
            .map(str::to_owned),
        );
        lines.join("\n")
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
    #[tokio::test]
    async fn output_is_drained_and_only_a_bounded_tail_is_kept() {
        let bytes = vec![b'x'; 100_000];
        let (tail, truncated) = read_tail(bytes.as_slice(), 100).await.unwrap();
        assert_eq!(tail, vec![b'x'; 100]);
        assert!(truncated);
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
