//! Reservations with the broker: asking for room, reading its answer, and work that goes ahead of new attempts.
use super::*;

/// A pending lease expires in Linux after sixty seconds. Dropping it releases
/// only an unclaimed lease, never a process tree already owned by bench-run.
pub(crate) struct Reservation {
    pub token: String,
    pub(super) class: ResourceClass,
    pub(super) admission: Admission,
    /// Framing for the run's outcome receipt on its stderr (see
    /// [`take_outcome_trailer`]); only the run's root supervisor sees it.
    pub(super) nonce: String,
    /// Set once the lease is known to be claimed (its run printed the outcome
    /// receipt, or a session's agent answered): bench-budget run removes it
    /// itself, and dropping this one starts no release. Otherwise the drop
    /// releases it, as a helper that failed before claiming leaves it pending.
    pub(super) claimed: std::sync::atomic::AtomicBool,
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
        crate::services::process::apply_no_window(&mut command);
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
pub(super) static CONTINUING: std::sync::Mutex<std::collections::BTreeSet<String>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

/// Marks `owner`'s session as continuing a workflow while this lives.
pub(crate) struct Continuing(pub(super) String);

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

pub(super) const GROUP_BUSY: &str =
    "resource_busy: a sandbox control group was busy during admission; no provider process started";

pub(super) const RESERVATION_UNANSWERED: &str =
    "resource_busy: the sandbox broker did not answer the reservation in time; no provider process started";

pub(super) const ADMISSION_UNANSWERED: &str =
    "resource_busy: the sandbox admission check did not answer in time; no provider process started";

/// A broker ask that timed out while its deadline still holds is `refusal`
/// (WouldBlock): the attempt is asked for again. Any other error stays.
pub(super) fn unanswered(error: io::Error, deadline_ms: u64, refusal: &'static str) -> io::Error {
    if error.kind() == io::ErrorKind::TimedOut && remaining_ms(deadline_ms).is_ok() {
        io::Error::new(io::ErrorKind::WouldBlock, refusal)
    } else {
        error
    }
}

/// Whether `error` from [`reserve`] refused the session before anything of
/// it existed in Linux: the host's own refusals and the broker's, which it
/// raises before making the session's groups or lease. A busy control group
/// can interrupt groups being made, and a broker that did not answer may
/// have made them, so neither refusal is one.
pub(crate) fn reserved_nothing(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        && error.to_string() != GROUP_BUSY
        && error.to_string() != RESERVATION_UNANSWERED
}

/// Reserves a session. A broker too slow to answer before `deadline_ms`
/// started no provider process, so it is a refusal (WouldBlock): the attempt
/// is asked for again, never lost as an infrastructure failure. A lease the
/// broker may still have written stays pending and expires unclaimed.
pub(crate) async fn reserve(
    class: ResourceClass,
    id: &str,
    deadline_ms: u64,
    continuing: bool,
) -> io::Result<Reservation> {
    let mut reservation = reserve_with_buffers_for(class, id, deadline_ms, 0, continuing, false)
        .await
        .map_err(|error| unanswered(error, deadline_ms, RESERVATION_UNANSWERED))?;
    reservation.admission.host_cpus = std::thread::available_parallelism()
        .ok()
        .and_then(|count| u32::try_from(count.get()).ok());
    reservation.admission.host_cpu_mean = host_cpu_mean();
    record_session_admission(id, reservation.admission.clone());
    Ok(reservation)
}

pub(super) async fn reserve_with_buffers(
    class: ResourceClass,
    id: &str,
    deadline_ms: u64,
    host_buffers: usize,
) -> io::Result<Reservation> {
    reserve_with_buffers_for(class, id, deadline_ms, host_buffers, false, false).await
}

/// Asks the broker to admit `class` for `id`: `reserve`, or `admits` for the
/// same checks without a reservation. Its answer, or the refusal as
/// WouldBlock.
pub(super) async fn admission_answer(
    command: &str,
    class: ResourceClass,
    id: &str,
    deadline_ms: u64,
    host_buffers: usize,
    continuing: bool,
    timing: bool,
) -> io::Result<serde_json::Value> {
    valid_id(id)?;
    remaining_ms(deadline_ms)?;
    host_admission().await?;
    let gate = host_gate()?;
    let deadline = deadline_ms.to_string();
    let host_buffers = host_buffers.to_string();
    let mut args: Vec<&str> = vec![command, class.key(), id, &deadline, &gate, &host_buffers];
    if continuing {
        args.push("continuing");
    }
    if timing {
        args.push("timing");
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
        return Err(admission_refusal(out.reason()));
    }
    if !out.success() && group_busy(&out.reason()) {
        return Err(io::Error::new(io::ErrorKind::WouldBlock, GROUP_BUSY));
    }
    let out = out.require_success("resource admission")?;
    Ok(serde_json::from_slice(&out.stdout)?)
}

/// Whether a failed admission was the control group busy for a moment, before
/// anything started: EBUSY while another job's group is reaped, EEXIST while
/// an expired lease of the same name is, EAGAIN or ENOMEM (or Python's own
/// MemoryError) while the supervisors' shared control group is at its limit.
/// Such an admission waits like any other local refusal instead of failing
/// the run's storage.
pub(super) fn group_busy(reason: &str) -> bool {
    [
        "[Errno 11]",
        "[Errno 12]",
        "[Errno 16]",
        "[Errno 17]",
        "MemoryError",
    ]
    .iter()
    .any(|code| reason.contains(code))
}

/// A broker refusal from `reason`, the output tail: from its `resource_busy:`
/// on, so that output before it never hides that nothing started.
pub(super) fn admission_refusal(reason: String) -> io::Error {
    let reason = match reason.find("resource_busy:") {
        Some(start) => reason[start..].to_owned(),
        None => reason,
    };
    io::Error::new(io::ErrorKind::WouldBlock, reason)
}

/// Whether the broker would admit `class` for `id` now, reserving nothing.
/// A session whose workspace is verified and copied before it opens asks
/// first, so a refused retry runs none of those preparation jobs; the
/// reservation when the session opens still decides. A refusal is
/// WouldBlock, as from [`reserve`]; so is a broker too slow to answer
/// before `deadline_ms`: the check makes nothing, so nothing started.
pub(crate) async fn admits(
    class: ResourceClass,
    id: &str,
    deadline_ms: u64,
    continuing: bool,
) -> io::Result<()> {
    let value = admission_answer("admits", class, id, deadline_ms, 0, continuing, false)
        .await
        .map_err(|error| unanswered(error, deadline_ms, ADMISSION_UNANSWERED))?;
    if value["admits"] != true || value["id"] != id || value["class"] != class.key() {
        return Err(io::Error::other(
            "capability_missing: malformed sandbox admission answer",
        ));
    }
    Ok(())
}

pub(super) async fn reserve_with_buffers_for(
    class: ResourceClass,
    id: &str,
    deadline_ms: u64,
    host_buffers: usize,
    continuing: bool,
    timing: bool,
) -> io::Result<Reservation> {
    let value = admission_answer(
        "reserve",
        class,
        id,
        deadline_ms,
        host_buffers,
        continuing,
        timing,
    )
    .await?;
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
