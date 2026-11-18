//! Running a helper in the sandbox: the command, its bounded output, admission in turn, and the verdict it leaves.
use super::*;

#[cfg(test)]
pub(crate) fn command(program: &str, args: &[&str]) -> tokio::process::Command {
    command_with_host_buffers(program, args, 0, None)
}

pub(super) fn command_with_host_buffers(
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
    crate::services::process::apply_no_window_async(&mut cmd);
    cmd
}

#[derive(Debug)]
pub(crate) struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
    pub(super) infrastructure: Option<String>,
    pub(super) candidate_limit: Option<String>,
}

impl Output {
    /// Only root-owned lease receipts establish this classification. Submitted
    /// code cannot turn its stderr text into an infrastructure verdict.
    pub(crate) fn infrastructure_error(&self) -> Option<&str> {
        self.infrastructure.as_deref()
    }
    /// A root-owned receipt that the job's own ceiling stopped the
    /// candidate's code (`candidateLimit`, e.g. `memory`): the answer past
    /// its budget, not the sandbox failing.
    pub(crate) fn candidate_limit(&self) -> Option<&str> {
        self.candidate_limit.as_deref()
    }
    pub fn success(&self) -> bool {
        self.code == Some(0) && self.infrastructure.is_none() && self.candidate_limit.is_none()
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
    pub(super) fn require_success(self, operation: &str) -> io::Result<Self> {
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
pub(super) fn invoke_raw<'a>(
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
            // Protect the transport's Windows allocations here. Every workload
            // enters through bench-budget, which adds its measured Linux claim
            // and existing reservations to the fresh host gate. Charging its
            // full class ceiling here would reject otherwise admitted work.
            tokio::task::spawn_blocking(move || {
                check_headroom(&host_headroom()?, host_buffers as u64)
            })
            .await
            .map_err(io::Error::other)??;
        }
        let mut cmd = command_with_host_buffers(program, args, host_buffers, reservation);
        if input.is_some() {
            cmd.stdin(Stdio::piped());
        }
        let mut child = cmd.spawn()?;
        let tree = crate::services::process::ProcessTree::contain(&child);
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
                candidate_limit: None,
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

pub(super) fn helper_phase<'a>(
    program: &str,
    args: &'a [&str],
) -> Option<(ResourceClass, &'a str)> {
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
    observe_workload_admission(reservation.class);
    let mut out = invoke_raw(program, args, input, cap, timeout, Some(reservation)).await?;
    // The run's supervisor prints its receipt as the last stderr line; a
    // helper from an earlier build, or a run cut short, needs the call.
    let value: serde_json::Value = match take_outcome_trailer(&mut out.stderr, &reservation.nonce) {
        // Only the run's supervisor, which claimed the lease and removes it
        // itself, prints the receipt; without it the drop releases the lease.
        Some(value) => {
            reservation.mark_claimed();
            value
        }
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
    if let Some(limit) = value["candidateLimit"].as_str() {
        if value["token"] != reservation.token {
            return Err(io::Error::other("Sandbox resource outcome owner differs"));
        }
        out.candidate_limit = Some(limit.to_owned());
    }
    Ok(out)
}

tokio::task_local! {
    /// An evaluator's observer belongs only to its async call, never a
    /// concurrent check, provider turn or later use of the same worker.
    static WORKLOAD_ADMISSION: Box<dyn Fn() + Send + Sync>;
}

/// Observe substantive evaluator admission without changing the broker's
/// resource checks or its queue. Preparation/copy helpers do not establish
/// that the actual checker or browser has obtained its own lease.
pub(crate) async fn with_workload_admission<F: std::future::Future>(
    admitted: impl Fn() + Send + Sync + 'static,
    evaluate: F,
) -> F::Output {
    WORKLOAD_ADMISSION.scope(Box::new(admitted), evaluate).await
}

pub(super) fn observe_workload_admission(class: ResourceClass) {
    if matches!(
        class,
        ResourceClass::Check | ResourceClass::PairedCheck | ResourceClass::Browser
    ) {
        let _ = WORKLOAD_ADMISSION.try_with(|admitted| admitted());
    }
}

#[cfg(test)]
pub(crate) fn test_workload_admission(class: ResourceClass) {
    observe_workload_admission(class);
}

/// What the broker kept for a session job whose own memory ceiling killed a
/// command the agent ran for the candidate (`bench-budget verdict ID`): the
/// bridge dies with the session's leaf, so its run's receipt never reaches
/// the host.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionVerdict {
    /// The ceiling the candidate's command reached, e.g. `memory`.
    pub(crate) candidate_limit: String,
    /// The killed command's name, as the kernel knew it.
    pub(crate) victim: Option<String>,
}

/// The broker's candidate verdict for session job `id`, or none. A helper
/// from an earlier build has no such command and fails the call.
pub(crate) async fn session_verdict(id: &str) -> io::Result<Option<SessionVerdict>> {
    valid_id(id)?;
    let out = invoke_raw(
        "/usr/local/sbin/bench-budget",
        &["verdict", id],
        None,
        4096,
        Duration::from_secs(5),
        None,
    )
    .await?
    .require_success("session verdict")?;
    parse_session_verdict(id, &out.stdout)
}

pub(super) fn parse_session_verdict(id: &str, stdout: &[u8]) -> io::Result<Option<SessionVerdict>> {
    let value: serde_json::Value = serde_json::from_slice(stdout)?;
    let Some(limit) = value["candidateLimit"].as_str() else {
        return Ok(None);
    };
    if value["id"] != id {
        return Err(io::Error::other("Sandbox session verdict owner differs"));
    }
    Ok(Some(SessionVerdict {
        candidate_limit: limit.to_owned(),
        // A process the candidate's agent started chose its own name.
        victim: value["victim"]
            .as_str()
            .map(|name| name.chars().filter(|c| !c.is_control()).take(16).collect()),
    }))
}

/// The outcome receipt a leased run's supervisor printed last on stderr as
/// `NONCE outcome JSON`, removed from `stderr`. Only that supervisor knows
/// the nonce (it takes it out of the environment before starting anything),
/// so nothing the run starts can print the line.
pub(super) fn take_outcome_trailer(stderr: &mut Vec<u8>, nonce: &str) -> Option<serde_json::Value> {
    let marker = format!("{nonce} outcome ");
    // Only the last line is read: the tail before it may hold any bytes, or
    // start mid-character where the host's bounded tail cut it.
    let mut end = stderr.len();
    while end > 0 && matches!(stderr[end - 1], b'\n' | b'\r') {
        end -= 1;
    }
    let start = stderr[..end]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |at| at + 1);
    let line = std::str::from_utf8(&stderr[start..end]).ok()?;
    let value = serde_json::from_str(line.strip_prefix(marker.as_str())?).ok()?;
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
    let lease = admit_in_turn(class, admission_deadline, || {
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
pub(super) async fn leased_class<'a>(
    program: &str,
    args: &'a [&'a str],
) -> io::Result<Option<(ResourceClass, &'a str)>> {
    let Some((class, id)) = helper_phase(program, args) else {
        return Ok(None);
    };
    if program != "/usr/local/sbin/bench-judge" {
        return Ok(Some((class, id)));
    }
    let ask = ["check-class", id];
    let response = once_more_if_timed_out(|| {
        invoke_raw(
            "/usr/local/sbin/bench-budget",
            &ask,
            None,
            64,
            Duration::from_secs(5),
            None,
        )
    })
    .await?
    .require_success("check classification")?;
    let class = match response.stdout.as_slice() {
        b"check\n" => ResourceClass::Check,
        b"pair\n" => ResourceClass::PairedCheck,
        _ => return Err(io::Error::other("Sandbox check classification is invalid")),
    };
    Ok(Some((class, id)))
}

pub(super) fn now_ms() -> io::Result<u64> {
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
pub(super) async fn invoke_once_admitted(
    phase: (ResourceClass, &str),
    program: &str,
    args: &[&str],
    input: Option<&[u8]>,
    cap: usize,
    run: Duration,
    admit_until_ms: u64,
    deadline_ms: Option<u64>,
) -> io::Result<Output> {
    invoke_once_admitted_as(
        phase,
        program,
        args,
        input,
        cap,
        run,
        admit_until_ms,
        deadline_ms,
        false,
    )
    .await
    .map(|(output, _)| output)
}

/// [`invoke_once_admitted`], also returning the admission record its lease
/// was granted under; a `timing` lease is a timing-sensitive check's.
#[allow(clippy::too_many_arguments)]
pub(super) async fn invoke_once_admitted_as(
    (class, id): (ResourceClass, &str),
    program: &str,
    args: &[&str],
    input: Option<&[u8]>,
    cap: usize,
    run: Duration,
    admit_until_ms: u64,
    deadline_ms: Option<u64>,
    timing: bool,
) -> io::Result<(Output, Admission)> {
    if cap > 512 * 1024 * 1024 || input.is_some_and(|bytes| bytes.len() > 512 * 1024 * 1024) {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "Sandbox transport exceeds its byte budget",
        ));
    }
    let host_buffers = cap.saturating_mul(2).saturating_add(TAIL_BYTES * 2);
    let lease = admit_in_turn(
        class,
        admission_window(admit_until_ms, deadline_ms),
        move || async move {
            let until = now_ms()?.saturating_add(run_after_admission(run, deadline_ms)?);
            reserve_with_buffers_for(class, id, until, host_buffers, false, timing).await
        },
    )
    .await?;
    let run = run_after_admission(run, deadline_ms).map_err(|_| admission_queue_expired())?;
    let admission = lease.admission.clone();
    invoke_reserved_bounded(
        &lease,
        program,
        args,
        input,
        cap,
        Duration::from_millis(run),
    )
    .await
    .map(|output| (output, admission))
}

/// The run time a helper admitted now gets: all of `run`, cut to what is left
/// before the caller's native `deadline_ms`; an expired deadline is TimedOut.
pub(super) fn run_after_admission(run: Duration, deadline_ms: Option<u64>) -> io::Result<u64> {
    let run = run.as_millis().min(u64::MAX as u128) as u64;
    match deadline_ms {
        Some(deadline) => Ok(run.min(remaining_ms(deadline)?)),
        None => Ok(run),
    }
}

/// Until when admission asks: the caller's window, never past its native
/// deadline.
pub(super) fn admission_window(admit_until_ms: u64, deadline_ms: Option<u64>) -> u64 {
    deadline_ms.map_or(admit_until_ms, |deadline| admit_until_ms.min(deadline))
}

/// How long a post-turn collection or a check may wait for sandbox room
/// without a native deadline of its own. Its answer is already sealed.
pub(super) const COLLECTION_ADMISSION: Duration = Duration::from_secs(30 * 60);

/// A lease whose admission window closed before its helper started. No
/// helper and no provider process ran, so the caller may wait and ask again.
pub(super) fn admission_queue_expired() -> io::Error {
    io::Error::new(
        io::ErrorKind::WouldBlock,
        "resource_busy: benchmark preparation queue expired before worker startup",
    )
}

/// Asks `reserve` for a lease, once a second while the Linux broker answers
/// busy, until `admission_deadline`. A window that closes in the queue is the
/// queue's refusal, whichever check sees it first: the broker's last busy
/// answer, or the deadline check before the next ask.
/// One ask of each resource class is in flight to the broker at a time; the
/// other askers wait here, in the app, in turn for each ask. Every ask starts
/// processes inside the distribution (`wsl.exe`, the broker, its timeout), so
/// a burst of jobs waiting for room used to cost one each per second per job:
/// on 10-18 a rescore's 122 waiting renders exhausted the sandbox's process
/// budget, which failed their cleanups and the lane cells' own setup. Now a
/// burst costs one ask at a time per class, a class's burst never holds
/// another class's askers, and since the turn is held for one ask, not for
/// the whole wait, the broker still chooses among every waiting job. How many
/// jobs run stays the broker's measured decision; this bounds only the
/// asking.
pub(super) static ADMISSION_TURNS: [tokio::sync::Mutex<()>; 6] =
    [const { tokio::sync::Mutex::const_new(()) }; 6];

/// [`admit`], each ask in its turn among the askers of `class`; the wait for
/// a turn comes off the same admission window.
pub(super) async fn admit_in_turn<L, F>(
    class: ResourceClass,
    admission_deadline: u64,
    mut reserve: impl FnMut() -> F,
) -> io::Result<L>
where
    F: std::future::Future<Output = io::Result<L>>,
{
    admit(admission_deadline, || {
        let ask = reserve();
        async move {
            let window = remaining_ms(admission_deadline).map_err(|_| admission_queue_expired())?;
            let _turn = tokio::time::timeout(
                Duration::from_millis(window),
                ADMISSION_TURNS[class as usize].lock(),
            )
            .await
            .map_err(|_| admission_queue_expired())?;
            ask.await
        }
    })
    .await
}

pub(super) async fn admit<L, F>(
    admission_deadline: u64,
    mut reserve: impl FnMut() -> F,
) -> io::Result<L>
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
            // A broker too slow to answer gave this asker nothing: a lease it
            // may have written stays pending and expires, and its groups
            // refuse a new one as busy until reaped. Ask again in the window.
            Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                let remaining =
                    remaining_ms(admission_deadline).map_err(|_| admission_queue_expired())?;
                tokio::time::sleep(Duration::from_millis(remaining.min(1000))).await;
            }
            Err(error) => return Err(error),
        }
    }
}

pub(super) async fn invoke(
    program: &str,
    args: &[&str],
    input: Option<&[u8]>,
    cap: usize,
    timeout: Duration,
) -> io::Result<Output> {
    invoke_bounded(program, args, input, cap, timeout).await
}

// The Linux worker owns its process group. The native absolute deadline is
// recomputed there after WSL startup, before any Git/status work can begin.
pub(super) const DEADLINE_WORKER: &str = r#"import os, signal, subprocess, sys, time
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

pub(super) async fn invoke_until(
    program: &str,
    id: &str,
    cap: usize,
    deadline_ms: u64,
) -> io::Result<Output> {
    invoke_until_inner(program, id, cap, deadline_ms)
        .await
        .map_err(|error| deadline_outcome(error, deadline_ms))
}

pub(super) async fn invoke_until_inner(
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
