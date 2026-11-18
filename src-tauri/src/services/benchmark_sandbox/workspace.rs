//! Getting a workspace into the sandbox: staging, copies, and the cache of trees already there.
use super::*;

/// The arguments of `bench-auth stage` for the lease of `provider` in
/// attempt `id`: never a credential, which travels on standard input alone.
pub(super) fn stage_arguments<'a>(id: &'a str, provider: &'a str) -> [&'a str; 3] {
    ["stage", id, provider]
}

/// Stages `lease`, built from the Flock app's own sign-in, into attempt
/// `id`'s private home, before its session starts (`bench-auth stage`). The
/// lease travels on the helper's standard input only: never as an argument,
/// a variable or in a diagnostic, which carries the helper's own short
/// reason alone. The helper refuses a lease with a refresh token.
pub(crate) async fn stage_lease(
    id: &str,
    lease: &crate::services::credential_lease::Lease,
) -> io::Result<()> {
    valid_id(id)?;
    let mut input = lease.stage_input();
    let staged = invoke_raw(
        "/usr/local/sbin/bench-auth",
        &stage_arguments(id, lease.provider().key()),
        Some(&input),
        TAIL_BYTES,
        Duration::from_secs(60),
        None,
    )
    .await;
    crate::services::credential_lease::wipe(&mut input);
    staged?.require_success("credential lease")?;
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

/// How long an admitted session's own preparation may ask for its lease:
/// with the last ask's up to 15 s, the copy and the spawn after it, still
/// inside the sixty seconds the session's pending lease lasts in Linux.
pub(crate) const PENDING_PREPARATION: Duration = Duration::from_secs(30);

/// [`copy`] for a session already reserved: its preparation lease is asked
/// for only within `window`, so a lease that does not come in time is the
/// queue's refusal (`resource_busy`) while the session's pending lease still
/// lives, and dropping the session's reservation releases it.
pub(crate) async fn copy_within(id: &str, archive: &[u8], window: Duration) -> io::Result<()> {
    valid_id(id)?;
    let admit_until = now_ms()?.saturating_add(window.as_millis().min(u64::MAX as u128) as u64);
    invoke_once_admitted(
        (ResourceClass::Preparation, id),
        "/usr/local/sbin/bench-copy",
        &[id],
        Some(archive),
        TAIL_BYTES,
        CONTROL_TIMEOUT,
        admit_until,
        None,
    )
    .await?
    .require_success("copy")?;
    Ok(())
}

pub(super) fn remaining_ms(deadline_ms: u64) -> io::Result<u64> {
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
pub(super) fn deadline_outcome(error: io::Error, deadline_ms: u64) -> io::Error {
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

pub(super) async fn copy_until_inner(
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
/// and nothing was written, so the caller sends the archive. Ask without an
/// archive only for a tree [`snapshot_cached`] knows.
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
    settle_copy(out, tree, archive.is_some())
}

/// What a copy answer means for the attempt: `Ok(false)` for a cache miss
/// of an unsent `tree`, `Ok(true)` for a workspace, an error naming the
/// failure otherwise. The cache's own line never enters that error, so a
/// failure reads the same whatever the cache did.
pub(super) fn settle_copy(mut out: Output, tree: &str, sent: bool) -> io::Result<bool> {
    if !sent && not_cached(&out, tree) {
        warn_cache_miss(&out, tree);
        learn_cache(tree, false);
        return Ok(false);
    }
    let held = !sent || kept(&out, tree);
    out.stdout = without_cache_line(&out.stdout, tree);
    out.require_success("copy")?;
    learn_cache(tree, held);
    Ok(true)
}

/// What a helper said beside a cache miss, such as a cache directory it
/// will not trust; `None` when it said nothing.
pub(super) fn cache_miss_warning(out: &Output) -> Option<String> {
    let text = String::from_utf8_lossy(&out.stderr);
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(500).collect())
}

/// A degraded cache only speaks on a miss, and after one miss this process
/// stops asking for that tree, so the warning is logged where it is said.
pub(super) fn warn_cache_miss(out: &Output, tree: &str) {
    if let Some(warning) = cache_miss_warning(out) {
        log::warn!("Benchmark snapshot cache missed {tree}: {warning}");
    }
}

/// Published trees the sandbox's snapshot cache held when this process last
/// copied or checked them. Only these are asked for from the cache; any
/// other goes with its archive at once. A lease that finds nothing would be
/// recorded as an empty preparation and pull the learned preparation peaks
/// down, so it stays for entries the sandbox evicted since.
pub(super) static CACHED_TREES: OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    OnceLock::new();

pub(super) fn cached_trees() -> std::sync::MutexGuard<'static, std::collections::HashSet<String>> {
    CACHED_TREES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether the sandbox's snapshot cache held `tree` at its last use here.
pub(crate) fn snapshot_cached(tree: &str) -> bool {
    cached_trees().contains(tree)
}

pub(super) fn learn_cache(tree: &str, held: bool) {
    if held {
        cached_trees().insert(tree.to_owned());
    } else {
        cached_trees().remove(tree);
    }
}

/// `stdout` without the line in which bench-unpack said it kept `tree`.
pub(super) fn without_cache_line(stdout: &[u8], tree: &str) -> Vec<u8> {
    let line = format!("cached {tree}\n");
    let line = line.as_bytes();
    let mut rest = Vec::with_capacity(stdout.len());
    for piece in stdout.split_inclusive(|byte| *byte == b'\n') {
        if piece != line {
            rest.extend_from_slice(piece);
        }
    }
    rest
}

/// Whether a helper that was sent the archive of `tree` kept it: bench-unpack
/// says so when it does, and keeps nothing while scratch room is short.
pub(super) fn kept(out: &Output, tree: &str) -> bool {
    let line = format!("cached {tree}");
    out.stdout
        .split(|byte| *byte == b'\n')
        .any(|candidate| candidate == line.as_bytes())
}

pub(super) fn valid_tree(tree: &str) -> io::Result<()> {
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
pub(super) fn not_cached(out: &Output, tree: &str) -> bool {
    out.code == Some(3)
        && out.infrastructure_error().is_none()
        && out.stdout == format!("not cached {tree}\n").as_bytes()
}
