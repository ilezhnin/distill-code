//! Ending a job: the group kill and the removal of what it left.
use super::*;

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
    crate::services::process::apply_no_window(&mut command);
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
            crate::services::process::apply_no_window(&mut command);
            if let Err(error) = command.spawn() {
                log::warn!("[benchmarks] cannot start independent sandbox cleanup {id}: {error}");
            }
        }
    }
}
