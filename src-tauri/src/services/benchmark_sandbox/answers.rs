//! Getting an answer out and checked: the artifact, the patch, and the check with its reruns.
use super::*;

/// Apply/export data-only repository transitions in protected root staging.
/// The helper never checks out or executes candidate files.
pub(crate) async fn artifact(id: &str, package: &[u8], deadline_ms: u64) -> io::Result<Vec<u8>> {
    artifact_inner(id, package, deadline_ms)
        .await
        .map_err(|error| deadline_outcome(error, deadline_ms))
}

/// The artifact helper's refusals for size: each measures what the candidate's
/// patches make of the published tree (which fit its limits when published),
/// such as its canonical patch past the published artifact cap.
pub(super) const ARTIFACT_OVER_BUDGET: &[&str] = &[
    "Artifact Git output exceeds its byte limit",
    "Artifact contents exceed their byte limit",
    "Artifact archive or package exceeds its byte limit",
];

/// A transition the helper refused for size: the answer past its budget, as
/// `FileTooLarge`, not the sandbox failing. The admitting supervisor writes
/// its own lines first; the helper's refusal is the last one.
pub(super) fn artifact_over_budget(code: Option<i32>, reason: &str) -> Option<io::Error> {
    let last = reason
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())?;
    (code == Some(2) && ARTIFACT_OVER_BUDGET.contains(&last))
        .then(|| io::Error::new(io::ErrorKind::FileTooLarge, last.to_owned()))
}

/// The artifact helper's own deadline refusals: the transition ran out of
/// the root's time, as `TimedOut`. Matched on the last line, like the size
/// refusals, since the admitting supervisor writes its own lines first; a
/// transition the broker reported as failed stays the sandbox's.
pub(super) const ARTIFACT_TIMED_OUT: &[&str] = &[
    "Artifact transition exceeded its time limit",
    "Artifact deadline expired before staging",
    "Artifact deadline expired before input",
];

pub(super) fn artifact_timed_out(out: &Output) -> Option<io::Error> {
    if out.code != Some(2) || out.infrastructure_error().is_some() {
        return None;
    }
    let reason = String::from_utf8_lossy(&out.stderr);
    let last = reason
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())?;
    ARTIFACT_TIMED_OUT
        .contains(&last)
        .then(|| io::Error::new(io::ErrorKind::TimedOut, last.to_owned()))
}

/// [`artifact_over_budget`] for a transition the broker did not report as
/// failed: a helper tree that outlived its kill is the sandbox's failure,
/// whatever the helper said before it.
pub(super) fn artifact_size_refusal(out: &Output) -> Option<io::Error> {
    if out.infrastructure_error().is_some() {
        return None;
    }
    artifact_over_budget(out.code, &String::from_utf8_lossy(&out.stderr))
}

pub(super) async fn artifact_inner(
    id: &str,
    package: &[u8],
    deadline_ms: u64,
) -> io::Result<Vec<u8>> {
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
    if let Some(timeout) = artifact_timed_out(&out) {
        return Err(timeout);
    }
    if let Some(refusal) = artifact_size_refusal(&out) {
        return Err(refusal);
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

pub(super) fn require_patch(out: Output) -> io::Result<Output> {
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
/// snapshot (snapshot.tar, `sent`) only when the sandbox's cache lacks it;
/// for one without it, `Ok(None)` says the cache holds no copy and nothing
/// was prepared, so the caller sends the snapshot. Ask without the snapshot
/// only for a tree [`snapshot_cached`] knows.
pub(crate) async fn prepare_check(
    id: &str,
    tree: &str,
    package: &[u8],
    sent: bool,
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
    let mut out = result?;
    if !sent && not_cached(&out, tree) {
        warn_cache_miss(&out, tree);
        learn_cache(tree, false);
        return Ok(None);
    }
    if let Some(held) = check_cache_held(&out, tree, sent) {
        learn_cache(tree, held);
    }
    // What the cache did is no part of the check's answer: a reason recorded
    // for an answer that does not apply reads the same either way.
    out.stdout = without_cache_line(&out.stdout, tree);
    if out.code == Some(2) {
        return Ok(Some(out));
    }
    out.require_success("prepare check").map(Some)
}

/// Whether a check preparation leaves `tree` in the sandbox's cache, or
/// `None` when the answer says nothing about it. An answer that does not
/// apply (exit 2) still found the snapshot placed.
pub(super) fn check_cache_held(out: &Output, tree: &str, sent: bool) -> Option<bool> {
    (out.code == Some(2) || out.success()).then(|| !sent || kept(out, tree))
}

pub(crate) async fn check(id: &str, argv: &[String], seconds: u64) -> io::Result<Output> {
    check_as(id, argv, seconds, false)
        .await
        .map(|(output, _)| output)
}

/// [`check`] for a timing-sensitive check: it starts only with its whole
/// ceiling free, one at a time, and keeps that ceiling while it runs.
/// Returns the admission record, the load it started under.
pub(crate) async fn check_timed(
    id: &str,
    argv: &[String],
    seconds: u64,
) -> io::Result<(Output, Admission)> {
    check_as(id, argv, seconds, true).await
}

pub(super) async fn check_as(
    id: &str,
    argv: &[String],
    seconds: u64,
    timing: bool,
) -> io::Result<(Output, Admission)> {
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
        invoke_once_admitted_as(
            phase,
            "/usr/local/sbin/bench-judge",
            &args,
            None,
            TAIL_BYTES,
            Duration::from_secs(seconds) + Duration::from_secs(30),
            now_ms()?.saturating_add(300_000),
            None,
            timing,
        )
        .await
    }
    .await;
    // Windows Job Objects do not kill Linux children. Also remove detached
    // children after an ordinary exit; they must not outlive an evaluation.
    // A kill that timed out once is asked again before the check's result is
    // given up.
    once_more_if_timed_out(|| kill("check", id)).await?;
    result
}

/// `call` again when its first answer timed out: a slow WSL start or a busy
/// broker for a moment, not a reason to lose a check that already ran.
pub(super) async fn once_more_if_timed_out<T, F, Fut>(mut call: F) -> io::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = io::Result<T>>,
{
    match call().await {
        Err(error) if error.kind() == io::ErrorKind::TimedOut => call().await,
        answer => answer,
    }
}

/// `call` again, after each of `pauses`, while its helper answers with a
/// failure: a status that failed once is a busy moment of WSL or the helper
/// far more often than what the sandbox holds, and a run stops on it. Every
/// failed answer is logged with its exit code and what was printed, since
/// the refusal a caller makes of it names neither. For a read-only control
/// call only: nothing that started work is asked twice. An answer that never
/// came (a timeout, no room) stays the caller's to judge.
pub(crate) async fn again_while_failed<F, Fut>(
    what: &str,
    pauses: &[Duration],
    mut call: F,
) -> io::Result<Output>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = io::Result<Output>>,
{
    let mut pauses = pauses.iter();
    loop {
        let output = call().await?;
        if output.success() && !output.truncated {
            return Ok(output);
        }
        let pause = pauses.next();
        log::warn!(
            "[benchmarks] {what} failed (exit {:?}{}): {}; {}",
            output.code,
            if output.truncated { ", truncated" } else { "" },
            output.reason(),
            match pause {
                Some(pause) => format!("asking again in {} s", pause.as_secs()),
                None => "not asked again".into(),
            }
        );
        match pause {
            Some(pause) => tokio::time::sleep(*pause).await,
            None => return Ok(output),
        }
    }
}
