//! The Windows side of admission: memory headroom, CPU load, the preparations the host itself holds, and the gate a job carries to the broker.
use super::*;

#[derive(Debug, Clone, Copy)]
pub(super) struct HostHeadroom {
    pub(super) available_ram: u64,
    pub(super) available_commit: u64,
    pub(super) sandbox_volume_free: u64,
}

/// How long one measurement of the host's headroom answers admission. The
/// dispatcher asks for every waiting cell on each pass, about once a second,
/// so it measures the host once per pass instead of once per cell.
pub(super) const HEADROOM_REUSE: Duration = Duration::from_secs(1);

/// The last measurement of the host's headroom and when it was taken.
#[derive(Default)]
pub(super) struct RecentHeadroom(pub(super) std::sync::Mutex<Option<(Instant, HostHeadroom)>>);

impl RecentHeadroom {
    pub(super) fn reuse(&self, now: Instant) -> Option<HostHeadroom> {
        let last = *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        last.filter(|(at, _)| now.saturating_duration_since(*at) < HEADROOM_REUSE)
            .map(|(_, headroom)| headroom)
    }
    pub(super) fn keep(&self, at: Instant, headroom: HostHeadroom) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((at, headroom));
    }
}

pub(super) static HEADROOM: std::sync::LazyLock<RecentHeadroom> =
    std::sync::LazyLock::new(RecentHeadroom::default);

// Shared with bench-budget: leave a small host reserve after measured job
// claims, instead of holding an idle workstation-sized allowance per queue.
pub(super) const HOST_MEMORY_FLOOR: u64 = 2 * GIB;

pub(super) fn check_headroom(headroom: &HostHeadroom, additional_memory: u64) -> io::Result<()> {
    if headroom.available_ram < HOST_MEMORY_FLOOR + additional_memory {
        return Err(io::Error::new(io::ErrorKind::WouldBlock,
            format!("resource_busy: Windows available RAM cannot cover the benchmark reservation and 2 GiB desktop floor; available_ram_bytes={}; reservation_bytes={additional_memory}; floor_bytes={HOST_MEMORY_FLOOR}", headroom.available_ram)));
    }
    if headroom.available_commit < HOST_MEMORY_FLOOR + additional_memory {
        return Err(io::Error::new(io::ErrorKind::WouldBlock,
            format!("resource_busy: Windows commit headroom cannot cover the benchmark reservation and 2 GiB floor; available_commit_bytes={}; reservation_bytes={additional_memory}; floor_bytes={HOST_MEMORY_FLOOR}", headroom.available_commit)));
    }
    if headroom.sandbox_volume_free < 30 * GIB {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("resource_busy: The registered sandbox volume has less than 30 GiB free; volume_free_bytes={}; floor_bytes={}", headroom.sandbox_volume_free, 30 * GIB),
        ));
    }
    Ok(())
}

/// Metadata-only host admission. It reserves no account or paid model turn.
/// The Linux broker adds each job's measured claim and outstanding leases
/// to these floors atomically. A class ceiling is not a memory reservation.
pub(crate) async fn host_admission() -> io::Result<()> {
    if let Some(headroom) = HEADROOM.reuse(Instant::now()) {
        return check_headroom(&headroom, 0);
    }
    tokio::task::spawn_blocking(move || {
        let at = Instant::now();
        let headroom = host_headroom()?;
        HEADROOM.keep(at, headroom);
        check_headroom(&headroom, 0)
    })
    .await
    .map_err(io::Error::other)?
}

/// Windows memory the host preparations in progress reserved: what each of
/// their buffers may take, until it ends. No count bounds them: a
/// preparation starts when the measured headroom, less what the others
/// reserved, still covers its buffers and the Windows floors, so many asking
/// at once never count the same free memory twice.
#[derive(Debug, Default)]
pub(super) struct HostReservations {
    pub(super) reserved: std::sync::Mutex<u64>,
    pub(super) released: tokio::sync::Notify,
}

pub(super) static HOST_PREPARATIONS: std::sync::LazyLock<HostReservations> =
    std::sync::LazyLock::new(HostReservations::default);

/// What one host preparation reserves: its input (at most 512 MiB) and the
/// ring and output overlap (1 GiB) beside the Linux preparation's 2 GiB.
pub(super) const HOST_PREPARATION_BYTES: u64 = 2 * GIB + 3 * GIB / 2;

/// A host preparation's reserved memory, returned when it drops.
#[derive(Debug)]
pub(crate) struct HostPreparation {
    pub(super) reservations: &'static HostReservations,
    pub(super) bytes: u64,
}

impl Drop for HostPreparation {
    fn drop(&mut self) {
        let mut reserved = self
            .reservations
            .reserved
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *reserved = reserved.saturating_sub(self.bytes);
        drop(reserved);
        self.reservations.released.notify_waiters();
    }
}

/// Acquire before allocating a snapshot/package, and retain through its final
/// import/export. Invocation deliberately does not acquire this gate again.
pub(crate) async fn host_preparation(deadline_ms: u64) -> io::Result<HostPreparation> {
    reserve_host_preparation(
        &HOST_PREPARATIONS,
        HOST_PREPARATION_BYTES,
        deadline_ms,
        || tokio::task::spawn_blocking(host_headroom),
    )
    .await
}

/// Reserves `bytes` of host memory for a preparation in `reservations`,
/// measuring the headroom with `measure`. Headroom that lacks room even with
/// nothing reserved refuses at once (WouldBlock, as before any reservation
/// existed); headroom the other preparations' reservations take waits for
/// them to end, until `deadline_ms`, and a deadline that passes then is the
/// queue's refusal: nothing was prepared and no worker started.
pub(super) async fn reserve_host_preparation<F>(
    reservations: &'static HostReservations,
    bytes: u64,
    deadline_ms: u64,
    measure: impl Fn() -> F,
) -> io::Result<HostPreparation>
where
    F: std::future::Future<Output = Result<io::Result<HostHeadroom>, tokio::task::JoinError>>,
{
    remaining_ms(deadline_ms)?;
    loop {
        // Registered before the check, so a release between them still wakes it.
        let released = reservations.released.notified();
        let headroom = measure().await.map_err(io::Error::other)??;
        let refusal = {
            let mut reserved = reservations
                .reserved
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let left = HostHeadroom {
                available_ram: headroom.available_ram.saturating_sub(*reserved),
                available_commit: headroom.available_commit.saturating_sub(*reserved),
                ..headroom
            };
            match check_headroom(&left, bytes) {
                Ok(()) => {
                    *reserved += bytes;
                    return Ok(HostPreparation {
                        reservations,
                        bytes,
                    });
                }
                Err(error) if *reserved == 0 || check_headroom(&headroom, bytes).is_err() => {
                    return Err(io::Error::new(
                        error.kind(),
                        format!("{error}; reserved_bytes={reserved}"),
                    ))
                }
                Err(error) => format!("{error}; reserved_bytes={reserved}"),
            }
        };
        let remaining = remaining_ms(deadline_ms).map_err(|_| host_queue_expired(&refusal))?;
        tokio::select! {
            () = released => {}
            () = tokio::time::sleep(Duration::from_millis(remaining.min(1000))) => {}
        }
        if remaining_ms(deadline_ms).is_err() {
            return Err(host_queue_expired(&refusal));
        }
    }
}

pub(super) fn host_queue_expired(last_refusal: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::WouldBlock,
        format!("resource_busy: benchmark host preparation queue expired before worker startup; last refusal: {last_refusal}"),
    )
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

#[cfg(not(windows))]
pub(super) fn host_headroom() -> io::Result<HostHeadroom> {
    Err(io::Error::other(
        "capability_missing: the benchmark host headroom service requires Windows",
    ))
}

/// How many one-second samples the host CPU mean covers: the 30 seconds over
/// which bench-budget smooths the gate's samples for its load line.
pub(super) const HOST_CPU_WINDOW: usize = 30;

/// The host CPU samples of the last [`HOST_CPU_WINDOW`] seconds, in
/// thousandths, newest last; filled by a thread that samples once a second
/// from the first admission on.
pub(super) fn host_cpu_samples() -> &'static std::sync::Mutex<std::collections::VecDeque<u32>> {
    static SAMPLES: OnceLock<Arc<std::sync::Mutex<std::collections::VecDeque<u32>>>> =
        OnceLock::new();
    SAMPLES.get_or_init(|| {
        let samples = Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
        let writer = Arc::clone(&samples);
        let started = std::thread::Builder::new()
            .name("benchmark-host-cpu".into())
            .spawn(move || loop {
                let busy = host_cpu_busy_over(Duration::from_secs(1)).unwrap_or(u32::MAX);
                let mut samples = writer
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                samples.push_back(busy);
                while samples.len() > HOST_CPU_WINDOW {
                    samples.pop_front();
                }
            });
        if started.is_err() {
            log::warn!("[benchmarks] cannot sample Windows CPU use for sandbox admission");
        }
        samples
    })
}

/// Busy share of all Windows CPUs over the last second, in thousandths, for
/// the broker's evidence; None in the first second, and where Windows
/// reports nothing.
pub(super) fn host_cpu_permille() -> Option<u32> {
    let samples = host_cpu_samples()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    samples.back().copied().filter(|busy| *busy <= 1000)
}

/// Mean busy share of all Windows CPUs over the last 30 seconds (as much of
/// it as was sampled), from 0 to 1: what the broker's load line compares, so
/// a turn admitted in a quiet second of a busy stretch still reads as busy.
pub(super) fn host_cpu_mean() -> Option<f64> {
    let samples = host_cpu_samples()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    mean_share(samples.iter().copied())
}

/// The mean of the known thousandths among `samples`, as a share.
pub(super) fn mean_share(samples: impl Iterator<Item = u32>) -> Option<f64> {
    let known: Vec<u32> = samples.filter(|busy| *busy <= 1000).collect();
    (!known.is_empty()).then(|| f64::from(known.iter().sum::<u32>()) / known.len() as f64 / 1000.0)
}

#[cfg(not(windows))]
pub(super) fn host_cpu_busy_over(window: Duration) -> Option<u32> {
    std::thread::sleep(window);
    None
}

/// Busy share of all Windows CPUs over `window`, in thousandths; idle time
/// is part of the kernel time GetSystemTimes reports.
#[cfg(windows)]
pub(super) fn host_cpu_busy_over(window: Duration) -> Option<u32> {
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
pub(super) fn host_headroom() -> io::Result<HostHeadroom> {
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
