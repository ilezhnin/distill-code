//! Host transport for the dedicated repository-benchmark WSL distribution.
//! No candidate or check command is ever launched on Windows.

use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io, process::Stdio, time::Duration};
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
    "bench-status",
    "wsl.conf",
];

#[derive(Debug)]
pub(crate) struct Status {
    pub revision: String,
    accounts: Vec<(String, String)>,
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
    let mut cmd = tokio::process::Command::new("wsl.exe");
    cmd.args(["-d", DISTRIBUTION, "-u", "root", "--exec", program])
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
}

impl Output {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
    pub fn reason(&self) -> String {
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&self.stdout),
            String::from_utf8_lossy(&self.stderr)
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
    let mut tail = Vec::new();
    let mut truncated = false;
    let mut block = [0_u8; 8192];
    loop {
        let count = reader.read(&mut block).await?;
        if count == 0 {
            break;
        }
        tail.extend_from_slice(&block[..count]);
        if tail.len() > cap {
            tail.drain(..tail.len() - cap);
            truncated = true;
        }
    }
    Ok((tail, truncated))
}

async fn invoke(
    program: &str,
    args: &[&str],
    input: Option<&[u8]>,
    cap: usize,
    timeout: Duration,
) -> io::Result<Output> {
    let mut cmd = command(program, args);
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

/// Readiness is independent of credentials. Status exposes only an account's
/// signed-in flag; it never returns tokens or credential contents.
pub(crate) async fn ready() -> io::Result<Status> {
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
    for (name, bytes) in FILES {
        let expected = hex::encode(Sha256::digest(bytes));
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
    Ok(Status {
        revision: hex::encode(Sha256::digest(serde_json::to_vec(&identity)?)),
        accounts,
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

pub(crate) async fn copy_until(id: &str, archive: &[u8], deadline_ms: u64) -> io::Result<()> {
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
    if !["session", "check", "login"].contains(&mode) {
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
    if valid_id(id).is_err() {
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
            "session",
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
        if let (Some(id), Ok(runtime)) = (self.0.take(), tokio::runtime::Handle::try_current()) {
            runtime.spawn(async move {
                if let Err(error) = clean(&id).await {
                    log::warn!("[benchmarks] sandbox cleanup {id}: {error}");
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status() -> String {
        let mut lines: Vec<String> = FILES
            .iter()
            .map(|(name, bytes)| format!("file {name} {}", hex::encode(Sha256::digest(bytes))))
            .collect();
        let pins: BTreeMap<String, String> = serde_json::from_str(include_str!(
            "../../resources/benchmark-sandbox/runtime-pins.json"
        ))
        .unwrap();
        lines.extend(pins.iter().map(|(key, value)| format!("{key} {value}")));
        lines.push("netns up".into());
        lines.join("\n")
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
