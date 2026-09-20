//! One running ACP bridge process (claude-agent-acp, codex-acp, ...). The host
//! talks JSON-RPC over the child's stdin/stdout; responses are matched back to
//! their callers here, while notifications and agent-initiated requests are
//! handed to the host's event loop.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use super::harness::HarnessSpec;
use super::protocol::{self, Message};
use crate::services::managed_acp_tools;

/// How long a freshly started bridge gets to answer `initialize`. A process
/// that is alive but silent — a CLI waiting on a login prompt or a TTY,
/// reading our JSON as its input — never closes stdout, so without a
/// deadline it would hold its harness (and every caller queued on the spawn
/// lock) forever.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
/// The deadline for every other request but `session/prompt`, which runs
/// for as long as the agent works on the turn.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a `session/close` gets. It is a courtesy call — the host has
/// already stopped using the session — and it happens while the user waits for
/// a chat to be deleted or moved, so a bridge that accepts the request and then
/// goes quiet must cost seconds, not the full request deadline.
const CLOSE_SESSION_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a bridge gets to answer `method`; `None` is unbounded.
fn request_deadline(method: &str) -> Option<Duration> {
    match method {
        // The agent works on the turn for as long as it takes.
        "session/prompt" => None,
        "initialize" => Some(INITIALIZE_TIMEOUT),
        "session/close" => Some(CLOSE_SESSION_TIMEOUT),
        _ => Some(REQUEST_TIMEOUT),
    }
}

pub enum BridgeEvent {
    Notification {
        harness: String,
        method: String,
        params: Value,
    },
    Request {
        harness: String,
        id: Value,
        method: String,
        params: Value,
    },
    Exited {
        harness: String,
        /// Which bridge process for that harness died — see
        /// [`Bridge::generation`]. A replacement may already be running and
        /// serving sessions by the time this is handled.
        generation: u64,
    },
    /// Not a bridge event at all: a marker the host puts in the same queue to
    /// learn when everything queued before it has been handled. Answering
    /// `ack` is the event loop's only work for it.
    Drained { ack: oneshot::Sender<()> },
}

type Pending = Mutex<HashMap<u64, oneshot::Sender<Result<Value, Value>>>>;

/// The bridge's stdout has ended: mark it dead and fail every request still
/// waiting for an answer that will never come.
///
/// `alive` is set while the `pending` lock is held, which is the same lock
/// [`Bridge::register_pending`] registers under. That is what closes the race:
/// a request either registers before this drain (and is failed by it) or sees
/// the bridge as gone. Registering *after* the drain would wait forever — the
/// writer channel is still open so nothing errors, and `session/prompt` has no
/// deadline to rescue it.
fn fail_pending_on_exit(pending: &Pending, alive: &AtomicBool) {
    let guard = pending.lock();
    alive.store(false, Ordering::SeqCst);
    if let Ok(mut pending) = guard {
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(protocol::internal("bridge exited")));
        }
    }
}

/// Hands out [`Bridge::generation`]. Process-wide, so no two bridges of a run
/// ever share one, whatever harness they belong to.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

pub struct Bridge {
    pub harness: String,
    /// Which bridge process this is. A session's runtime records the
    /// generation it was accepted by, so the exit of an older process cannot
    /// be mistaken for the exit of the one now serving the harness (and a
    /// session attached to the old process is never routed at the new one,
    /// which has never heard of its session id).
    generation: u64,
    agent_capabilities: RwLock<Value>,
    writer: mpsc::UnboundedSender<String>,
    pending: Arc<Pending>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    child: Mutex<Option<Child>>,
}

/// Everything a bridge process inherits: the user's login-shell environment,
/// the directories to put in front of PATH (managed bridge shims, the berdctl
/// shim), and host-provided variables such as `BERDCTL_LOCK`.
pub struct SpawnEnv {
    pub shell_env: HashMap<String, String>,
    pub prepend_dirs: Vec<PathBuf>,
    pub extra_env: Vec<(String, String)>,
}

/// Resolve `name` on the extended PATH the bridges see: managed shims first,
/// then the user's login-shell PATH.
pub fn resolve_executable(
    name: &str,
    prepend_dirs: &[PathBuf],
    path_value: Option<&str>,
) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = prepend_dirs.to_vec();
    if let Some(path_value) = path_value {
        dirs.extend(std::env::split_paths(path_value));
    }
    let candidates: Vec<String> = if cfg!(windows) {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".exe") || lower.ends_with(".cmd") || lower.ends_with(".bat") {
            vec![name.to_string()]
        } else {
            vec![
                format!("{name}.exe"),
                format!("{name}.cmd"),
                format!("{name}.bat"),
                name.to_string(),
            ]
        }
    } else {
        vec![name.to_string()]
    };
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for candidate in &candidates {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// The `node <entrypoint>` pair a managed bridge's Windows `.cmd` launcher
/// runs, read out of the launcher itself so the bridge can be started without
/// it.
///
/// `Command::new("x.cmd")` on Windows runs the batch file through `cmd.exe /c`,
/// which makes the tokio `Child` — and everything `start_kill`, `kill_on_drop`
/// and the app-exit sweep can reach — `cmd.exe` rather than node. Killing it
/// leaves node (and the agent CLI it spawned) running the turn, which is what
/// users see as orphaned `node.exe` in Task Manager after quitting. Spawning
/// node directly makes the child the process we actually want to kill.
///
/// This does **not** cover the whole tree: node is the direct child, but the
/// agent CLI node spawns (`claude.exe`, `codex`) is a grandchild and Windows
/// kills no process tree for us, so quitting mid-turn can still leave it behind.
/// A kill-on-close Job Object the bridge is assigned to is what would cover it;
/// until then this removes one level, the one that used to leave *node itself*
/// running.
///
/// Returns `None` for anything that is not a launcher we wrote (see
/// `managed_acp_tools::shim_contents`), so an unrecognised or hand-edited
/// `.cmd` keeps being launched the old way. Callers apply it only to harnesses
/// we installed ourselves — see [`Bridge::spawn`].
/// The `node <entrypoint>` pair to start `harness_id` with, or `None` to start
/// the resolved executable itself. Only a harness this build installs is read as
/// a launcher: the shim shape is one *we* write, and a third-party `.cmd` that
/// happens to match it would be re-spelled with any further arguments on its
/// line silently dropped.
fn managed_launcher(harness_id: &str, executable: &Path) -> Option<(PathBuf, PathBuf)> {
    if !managed_acp_tools::is_managed(harness_id) {
        return None;
    }
    managed_cmd_launcher(executable)
}

fn managed_cmd_launcher(shim: &Path) -> Option<(PathBuf, PathBuf)> {
    if !shim
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        return None;
    }
    let body = std::fs::read_to_string(shim).ok()?;
    parse_cmd_launcher(&body, shim.parent()?)
}

/// The command line out of a managed `.cmd` launcher's body. `shim_dir` is the
/// directory the launcher lives in, which is what `%~dp0` stands for.
fn parse_cmd_launcher(body: &str, shim_dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let line = body.lines().map(str::trim).rfind(|line| {
        !line.is_empty()
            && !line.starts_with('@')
            && !line[..3.min(line.len())].eq_ignore_ascii_case("rem")
    })?;
    // `%*` forwards the bridge's own arguments; `spec.args` supplies those.
    let line = line.strip_suffix("%*").unwrap_or(line).trim_end();
    let mut quoted = line.split('"').skip(1).step_by(2);
    let node = cmd_launcher_target(quoted.next()?, shim_dir);
    let entrypoint = cmd_launcher_target(quoted.next()?, shim_dir);
    if quoted.next().is_some() {
        // More than the two paths we write: not our launcher.
        return None;
    }
    // The launcher is only worth bypassing if it points at a node that is
    // really there; otherwise let cmd.exe report the failure as before.
    node.is_file().then_some((node, entrypoint))
}

/// One double-quoted path out of a launcher body: `%%` is cmd's escape for a
/// literal `%`, and a `%~dp0` prefix means "relative to the launcher".
fn cmd_launcher_target(quoted: &str, shim_dir: &Path) -> PathBuf {
    let unescaped = quoted.replace("%%", "%");
    match unescaped.strip_prefix("%~dp0") {
        Some(relative) => shim_dir.join(relative.replace('\\', std::path::MAIN_SEPARATOR_STR)),
        None => PathBuf::from(unescaped),
    }
}

fn path_value(env: &HashMap<String, String>) -> Option<&str> {
    env.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value.as_str())
}

impl Bridge {
    pub async fn spawn(
        spec: &HarnessSpec,
        env: &SpawnEnv,
        events: mpsc::UnboundedSender<BridgeEvent>,
    ) -> Result<Arc<Bridge>, String> {
        let executable =
            resolve_executable(spec.command, &env.prepend_dirs, path_value(&env.shell_env))
                .ok_or_else(|| {
                    format!(
                "The {} bridge (`{}`) is not installed. Set it up from Settings → AI providers.",
                spec.label, spec.command
            )
                })?;
        // A managed bridge resolves to a `.cmd` launcher we wrote ourselves; run
        // what it runs, so the child we hold (and kill) is node rather than the
        // `cmd.exe` that would leave node behind. Only for harnesses we
        // installed: a third-party `.cmd` on the user's PATH whose last line
        // happens to hold two quoted paths must keep being launched the way
        // `cmd.exe` reads it, arguments and all.
        let launcher = managed_launcher(spec.id, &executable);
        let program = launcher
            .as_ref()
            .map_or(executable.as_path(), |(node, _)| node.as_path());
        let mut command = Command::new(program);
        if let Some((_, entrypoint)) = &launcher {
            command.arg(entrypoint);
        }
        command.args(spec.args);
        let extended_path = crate::services::path_env::build_extended_path_with_prepended_dirs(
            path_value(&env.shell_env),
            &env.prepend_dirs,
        );
        for (key, value) in &env.shell_env {
            if key.eq_ignore_ascii_case("PATH") {
                continue;
            }
            command.env(key, value);
        }
        command.env("PATH", extended_path);
        for (key, value) in &env.extra_env {
            command.env(key, value);
        }
        for key in spec.env_remove {
            command.env_remove(key);
        }
        crate::services::shell_env::remove_inherited_launcher_env(command.as_std_mut());
        crate::services::process::apply_no_window_async(&mut command);
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        log::info!(
            "[agent-host] spawning {} bridge: {}{} {}",
            spec.id,
            program.display(),
            launcher
                .as_ref()
                .map(|(_, entrypoint)| format!(" {}", entrypoint.display()))
                .unwrap_or_default(),
            spec.args.join(" ")
        );
        let mut child = command.spawn().map_err(|error| {
            format!(
                "failed to start the {} bridge ({}): {error}",
                spec.label,
                program.display()
            )
        })?;

        let stdin = child.stdin.take().ok_or("bridge stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("bridge stdout unavailable")?;
        let stderr = child.stderr.take();

        let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<String>();
        let pending: Arc<Pending> = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::SeqCst);

        // Writer: serialize every outbound line onto stdin.
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = writer_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
        });

        // stderr: keep the bridge's own logging visible in Berd's log.
        if let Some(stderr) = stderr {
            let harness = spec.id.to_string();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut buf = Vec::new();
                while let Some(line) = next_line_lossy(&mut reader, &mut buf).await {
                    log::info!("[{harness}] {line}");
                }
            });
        }

        // Reader: demultiplex responses, requests, and notifications.
        {
            let harness = spec.id.to_string();
            let pending = Arc::clone(&pending);
            let alive = Arc::clone(&alive);
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut buf = Vec::new();
                while let Some(line) = next_line_lossy(&mut reader, &mut buf).await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match protocol::parse(&line) {
                        Some(Message::Response { id, result }) => {
                            let sender = id
                                .as_u64()
                                .and_then(|key| pending.lock().ok()?.remove(&key));
                            match sender {
                                Some(sender) => {
                                    let _ = sender.send(result);
                                }
                                // Every id the host issues is a number, so a
                                // response under any other id answers a request
                                // the bridge made of itself and let out on its
                                // stdout (grok's `"skills-reload"`, every time
                                // its skill watcher fires). Nothing of ours is
                                // waiting on it.
                                None if !id.is_u64() => {
                                    log::debug!(
                                        "[{harness}] response for a foreign request id {id}"
                                    )
                                }
                                None => {
                                    log::warn!("[{harness}] response for unknown request id {id}")
                                }
                            }
                        }
                        Some(Message::Request { id, method, params }) => {
                            let _ = events.send(BridgeEvent::Request {
                                harness: harness.clone(),
                                id,
                                method,
                                params,
                            });
                        }
                        Some(Message::Notification { method, params }) => {
                            let _ = events.send(BridgeEvent::Notification {
                                harness: harness.clone(),
                                method,
                                params,
                            });
                        }
                        None => log::warn!(
                            "[{harness}] unparseable line on stdout: {}",
                            truncate(&line, 200)
                        ),
                    }
                }
                fail_pending_on_exit(&pending, &alive);
                let _ = events.send(BridgeEvent::Exited {
                    harness,
                    generation,
                });
            });
        }

        let bridge = Arc::new(Bridge {
            harness: spec.id.to_string(),
            generation,
            agent_capabilities: RwLock::new(Value::Null),
            writer: writer_tx,
            pending,
            next_id: AtomicU64::new(1),
            alive,
            child: Mutex::new(Some(child)),
        });

        let init = bridge
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    },
                    "clientInfo": {
                        "name": "distill",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
            .await
            .map_err(|error| {
                // Whatever the process is doing, it is not speaking ACP to
                // us: do not leave it running behind the error.
                bridge.kill();
                format!(
                    "{} bridge failed to initialize: {}",
                    spec.label,
                    error_text(&error)
                )
            })?;
        if let Ok(mut capabilities) = bridge.agent_capabilities.write() {
            *capabilities = init
                .get("agentCapabilities")
                .cloned()
                .unwrap_or(Value::Null);
        }
        Ok(bridge)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Which bridge process this is; see the field's comment.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn supports_load_session(&self) -> bool {
        self.agent_capabilities
            .read()
            .ok()
            .and_then(|capabilities| capabilities.get("loadSession")?.as_bool())
            .unwrap_or(false)
    }

    /// Whether the agent advertised `sessionCapabilities.<name>` (`close`,
    /// `delete`, ...) in its `initialize` answer.
    pub fn supports_session_capability(&self, name: &str) -> bool {
        self.agent_capabilities
            .read()
            .ok()
            .is_some_and(|capabilities| {
                capabilities
                    .pointer(&format!("/sessionCapabilities/{name}"))
                    .is_some()
            })
    }

    /// Whether the bridge advertises `session/close`, which cancels whatever
    /// the session is doing and frees the agent-side resources behind it. The
    /// capability is an object, so its mere presence is the answer.
    pub fn supports_close_session(&self) -> bool {
        self.agent_capabilities
            .read()
            .ok()
            .is_some_and(|capabilities| {
                capabilities
                    .pointer("/sessionCapabilities/close")
                    .is_some_and(|close| !close.is_null())
            })
    }

    /// Let go of a bridge session we will never talk to again. Best effort:
    /// bridges without the capability keep it until the process exits, which
    /// is the behaviour we had for every session. Bounded by
    /// [`CLOSE_SESSION_TIMEOUT`], because the host has already stopped using
    /// the session and nothing it could answer changes what happens next.
    pub async fn close_session(&self, bridge_session_id: &str) {
        if !self.supports_close_session() {
            return;
        }
        if let Err(error) = self
            .request("session/close", json!({ "sessionId": bridge_session_id }))
            .await
        {
            log::debug!(
                "[agent-host] {} could not close session {bridge_session_id}: {}",
                self.harness,
                error_text(&error)
            );
        }
    }

    /// Send `method` and wait for its answer, for as long as a request of
    /// that method is allowed to take (see [`request_deadline`]).
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, Value> {
        self.request_within(method, params, request_deadline(method))
            .await
    }

    /// [`request`](Self::request) with an explicit deadline; `None` waits
    /// until the bridge answers or exits. A request that runs out of time
    /// fails and is forgotten: a late answer is logged as unknown.
    pub async fn request_within(
        &self,
        method: &str,
        params: Value,
        deadline: Option<Duration>,
    ) -> Result<Value, Value> {
        if !self.is_alive() {
            return Err(protocol::internal(format!(
                "{} bridge is not running",
                self.harness
            )));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        if !self.register_pending(id, tx) {
            return Err(protocol::internal(format!(
                "{} bridge is not running",
                self.harness
            )));
        }
        let line = protocol::request(json!(id), method, params);
        if self.writer.send(line).is_err() {
            self.forget(id);
            return Err(protocol::internal(format!(
                "{} bridge stdin closed",
                self.harness
            )));
        }
        let answer = match deadline {
            Some(deadline) => match tokio::time::timeout(deadline, rx).await {
                Ok(answer) => answer,
                Err(_) => {
                    self.forget(id);
                    return Err(protocol::internal(format!(
                        "{} bridge did not answer {method} within {} seconds",
                        self.harness,
                        deadline.as_secs()
                    )));
                }
            },
            None => rx.await,
        };
        answer.unwrap_or_else(|_| {
            Err(protocol::internal(format!(
                "{} bridge dropped the request",
                self.harness
            )))
        })
    }

    /// Claim a slot for request `id`'s answer, or report that the bridge is
    /// already gone. The liveness check happens under the `pending` lock, the
    /// same one [`fail_pending_on_exit`] drains under, so a request can never
    /// end up registered behind the drain with nothing left to answer it.
    fn register_pending(&self, id: u64, tx: oneshot::Sender<Result<Value, Value>>) -> bool {
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        if !self.alive.load(Ordering::SeqCst) {
            return false;
        }
        pending.insert(id, tx);
        true
    }

    fn forget(&self, id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }

    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.writer.send(protocol::notification(method, params));
    }

    /// Answer a request the bridge made of its client (permission prompts and
    /// the like), using the bridge's own request id.
    pub fn respond(&self, id: Value, result: Result<Value, Value>) {
        let line = match result {
            Ok(result) => protocol::response(id, result),
            Err(error) => protocol::error_response(id, error),
        };
        let _ = self.writer.send(line);
    }

    pub fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.start_kill();
            }
        }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.kill();
    }
}

pub fn error_text(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    match error.get("data") {
        Some(Value::String(data)) if !data.is_empty() => format!("{message}: {data}"),
        Some(data) if data.is_object() => format!("{message}: {data}"),
        _ => message.to_string(),
    }
}

/// The next line of a bridge pipe, or `None` at end of stream. Bytes that
/// are not UTF-8 (a Windows tool writing in the OEM code page) are replaced
/// rather than ending the stream: `lines()` stops at the first such line,
/// which on stdout cut the bridge off as if it had exited and on stderr
/// stopped draining the pipe until the bridge blocked writing to it.
async fn next_line_lossy<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> Option<String> {
    buf.clear();
    match reader.read_until(b'\n', buf).await {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(
            String::from_utf8_lossy(buf.as_slice())
                .trim_end_matches(['\r', '\n'])
                .to_string(),
        ),
    }
}

fn truncate(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

/// Executable presence check used by the provider inventory.
pub fn is_installed(spec: &HarnessSpec, env: &SpawnEnv) -> bool {
    resolve_executable(spec.command, &env.prepend_dirs, path_value(&env.shell_env)).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bridge with no process behind it: whatever is written to it lands
    /// in the returned receiver, and nothing ever answers.
    fn silent_bridge() -> (Bridge, mpsc::UnboundedReceiver<String>) {
        let (writer, written) = mpsc::unbounded_channel();
        let bridge = Bridge {
            harness: "test-acp".to_string(),
            generation: NEXT_GENERATION.fetch_add(1, Ordering::SeqCst),
            agent_capabilities: RwLock::new(Value::Null),
            writer,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            alive: Arc::new(AtomicBool::new(true)),
            child: Mutex::new(None),
        };
        (bridge, written)
    }

    fn pending_count(bridge: &Bridge) -> usize {
        bridge
            .pending
            .lock()
            .map(|pending| pending.len())
            .unwrap_or(0)
    }

    #[test]
    fn only_a_prompt_may_run_for_as_long_as_it_takes() {
        assert_eq!(request_deadline("session/prompt"), None);
        assert_eq!(request_deadline("session/new"), Some(REQUEST_TIMEOUT));
        assert_eq!(request_deadline("session/load"), Some(REQUEST_TIMEOUT));
        assert_eq!(request_deadline("session/set_mode"), Some(REQUEST_TIMEOUT));
        // `initialize` and `session/close` have deadlines of their own, and the
        // calls make them through this one function rather than passing their
        // own value, so the deadline a method runs under is readable here.
        assert_eq!(request_deadline("initialize"), Some(INITIALIZE_TIMEOUT));
        assert_eq!(
            request_deadline("session/close"),
            Some(CLOSE_SESSION_TIMEOUT)
        );
    }

    #[tokio::test]
    async fn letting_go_of_a_session_gives_up_long_before_an_ordinary_request_would() {
        // Deleting a chat or moving it to another folder waits on nothing else:
        // a bridge that takes the `session/close` and never answers costs
        // seconds, not the two minutes every other request is allowed.
        assert!(
            CLOSE_SESSION_TIMEOUT <= Duration::from_secs(5)
                && CLOSE_SESSION_TIMEOUT * 10 < REQUEST_TIMEOUT,
            "{CLOSE_SESSION_TIMEOUT:?} is not a short deadline next to {REQUEST_TIMEOUT:?}"
        );

        let (bridge, mut written) = silent_bridge();
        *bridge.agent_capabilities.write().expect("capabilities") =
            json!({ "sessionCapabilities": { "close": {} } });
        // Nothing answers: the request is given up on and its slot released, so
        // the caller is not left holding a turn's worth of time.
        tokio::time::timeout(Duration::from_millis(20), bridge.close_session("bridge-1"))
            .await
            .unwrap_or(());
        assert!(written
            .recv()
            .await
            .is_some_and(|line| line.contains("\"method\":\"session/close\"")));
    }

    #[tokio::test]
    async fn a_request_the_bridge_never_answers_fails_at_its_deadline() {
        let (bridge, mut written) = silent_bridge();
        let error = bridge
            .request_within(
                "session/new",
                json!({ "cwd": "C:\\work" }),
                Some(Duration::from_millis(20)),
            )
            .await
            .expect_err("no answer");
        assert!(
            error_text(&error).contains("did not answer session/new"),
            "{error}"
        );
        // The request went out, and its slot is not kept for a late answer.
        let line = written.recv().await.expect("written");
        assert!(line.contains("\"method\":\"session/new\""));
        assert_eq!(pending_count(&bridge), 0);
    }

    /// The exact body `managed_acp_tools::shim_contents` writes on Windows.
    fn windows_shim_body(node: &str, entrypoint: &str) -> String {
        format!(
            "@echo off\r\nREM Written by Berd's managed ACP tools installer; do not edit.\r\n\"{node}\" \"{entrypoint}\" %*\r\n"
        )
    }

    #[test]
    fn a_managed_launcher_resolves_to_the_node_and_entrypoint_it_runs() {
        let packages = tempfile::tempdir().expect("temp dir");
        let shim_dir = packages.path().join("bin");
        let node = packages.path().join("node").join("node.exe");
        std::fs::create_dir_all(&shim_dir).expect("bin");
        std::fs::create_dir_all(node.parent().expect("parent")).expect("node dir");
        std::fs::write(&node, b"").expect("node");

        // Both paths written relative to the launcher, and a `%` doubled the way
        // cmd.exe needs it.
        let body = windows_shim_body(
            "%~dp0..\\node\\node.exe",
            "%~dp0..\\tools\\100%%\\dist\\index.js",
        );
        let (program, entrypoint) = parse_cmd_launcher(&body, &shim_dir).expect("our launcher");
        assert_eq!(
            std::fs::canonicalize(&program).expect("node"),
            std::fs::canonicalize(&node).expect("node")
        );
        assert!(
            entrypoint.ends_with("dist/index.js") || entrypoint.ends_with("dist\\index.js"),
            "{}",
            entrypoint.display()
        );
        // `%%` is cmd's escape for one literal `%`.
        assert!(entrypoint.to_string_lossy().contains("100%"));
        assert!(!entrypoint.to_string_lossy().contains("100%%"));
        // `%*` is the launcher's own argument forwarding, not a path.
        assert!(!entrypoint.to_string_lossy().contains('*'));
    }

    #[test]
    fn anything_but_a_launcher_we_wrote_is_started_the_ordinary_way() {
        let dir = tempfile::tempdir().expect("temp dir");
        let shim_dir = dir.path().join("bin");
        std::fs::create_dir_all(&shim_dir).expect("bin");

        // A node that is not there: let cmd.exe report the failure as before.
        assert!(parse_cmd_launcher(
            &windows_shim_body("%~dp0..\\node\\node.exe", "%~dp0..\\dist\\index.js"),
            &shim_dir
        )
        .is_none());

        // Not the shape we write.
        for body in [
            "@echo off\r\n".to_string(),
            "@echo off\r\nnode index.js %*\r\n".to_string(),
            windows_shim_body("%~dp0..\\node\\node.exe", "%~dp0a\" \"%~dp0b\" \"%~dp0c"),
        ] {
            assert!(
                parse_cmd_launcher(&body, &shim_dir).is_none(),
                "{body:?} must not be treated as our launcher"
            );
        }

        // A non-`.cmd` executable is never read as one.
        let plain = dir.path().join("claude-agent-acp");
        std::fs::write(&plain, b"#!/bin/sh\nexec node x\n").expect("write");
        assert!(managed_cmd_launcher(&plain).is_none());
    }

    #[test]
    fn only_a_harness_we_installed_has_its_launcher_rewritten() {
        let packages = tempfile::tempdir().expect("temp dir");
        let shim_dir = packages.path().join("bin");
        let shim = shim_dir.join("third-party.cmd");
        let node = packages.path().join("node").join("node.exe");
        std::fs::create_dir_all(&shim_dir).expect("bin");
        std::fs::create_dir_all(node.parent().expect("parent")).expect("node dir");
        std::fs::write(&node, b"").expect("node");
        std::fs::write(
            &shim,
            windows_shim_body("%~dp0..\\node\\node.exe", "%~dp0..\\dist\\index.js"),
        )
        .expect("shim");
        std::fs::create_dir_all(packages.path().join("dist")).expect("dist");
        std::fs::write(packages.path().join("dist").join("index.js"), b"").expect("entrypoint");

        // A `.cmd` on the user's own PATH keeps being launched the way cmd.exe
        // reads it, whatever its last line looks like — the re-spelling is for
        // the shims this build writes itself.
        assert!(!managed_acp_tools::is_managed("grok-acp"));
        assert!(managed_launcher("grok-acp", &shim).is_none());
        // The body itself is one we would have written, so the gate is the only
        // thing refusing it.
        assert!(managed_cmd_launcher(&shim).is_some());
    }

    #[tokio::test]
    async fn a_request_cannot_register_behind_the_exit_drain() {
        let pending: Arc<Pending> = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let bridge = Bridge {
            harness: "test-acp".to_string(),
            generation: NEXT_GENERATION.fetch_add(1, Ordering::SeqCst),
            agent_capabilities: RwLock::new(Value::Null),
            writer: mpsc::unbounded_channel().0,
            pending: Arc::clone(&pending),
            next_id: AtomicU64::new(1),
            alive: Arc::clone(&alive),
            child: Mutex::new(None),
        };

        // A request that got in before the drain is failed by it.
        let (tx, rx) = oneshot::channel();
        assert!(bridge.register_pending(1, tx));
        assert_eq!(pending_count(&bridge), 1);
        fail_pending_on_exit(&pending, &alive);
        assert!(!bridge.is_alive());
        assert_eq!(pending_count(&bridge), 0);
        let answer = rx.await.expect("the drain answers").expect_err("failed");
        assert!(error_text(&answer).contains("bridge exited"), "{answer}");

        // One that arrives after it is refused instead of waiting for an answer
        // nothing is left to send.
        let (tx, mut rx) = oneshot::channel();
        assert!(!bridge.register_pending(2, tx));
        assert_eq!(pending_count(&bridge), 0);
        assert!(rx.try_recv().is_err());
        let error = bridge
            .request_within("session/prompt", json!({}), None)
            .await
            .expect_err("a dead bridge answers nothing");
        assert!(error_text(&error).contains("is not running"), "{error}");
    }

    #[tokio::test]
    async fn a_session_is_only_handed_back_to_a_bridge_that_offers_to_take_it() {
        let (bridge, mut written) = silent_bridge();
        assert!(!bridge.supports_close_session());
        // No capability: nothing is sent, and nothing is waited for either.
        bridge.close_session("bridge-1").await;
        assert!(written.try_recv().is_err());

        *bridge.agent_capabilities.write().expect("capabilities") =
            json!({ "sessionCapabilities": { "close": {} } });
        assert!(bridge.supports_close_session());
        // Nothing answers, so this returns at its deadline rather than hanging;
        // the request still went out.
        tokio::time::timeout(Duration::from_millis(50), bridge.close_session("bridge-1"))
            .await
            .unwrap_or(());
        let line = written.recv().await.expect("written");
        assert!(line.contains("\"method\":\"session/close\""), "{line}");
        assert!(line.contains("bridge-1"), "{line}");
    }

    #[test]
    fn a_bridge_that_says_nothing_about_closing_sessions_cannot_close_them() {
        let (bridge, _written) = silent_bridge();
        for capabilities in [
            json!({}),
            json!({ "sessionCapabilities": {} }),
            json!({ "sessionCapabilities": { "close": null } }),
        ] {
            *bridge.agent_capabilities.write().expect("capabilities") = capabilities.clone();
            assert!(
                !bridge.supports_close_session(),
                "{capabilities} must not count as support"
            );
        }
    }

    #[tokio::test]
    async fn a_line_that_is_not_utf8_does_not_end_the_stream() {
        let bytes: &[u8] = b"{\"a\":1}\r\n\xcf\xf0\xe8\n{\"b\":2}";
        let mut reader = BufReader::new(bytes);
        let mut buf = Vec::new();
        assert_eq!(
            next_line_lossy(&mut reader, &mut buf).await.as_deref(),
            Some("{\"a\":1}")
        );
        let garbled = next_line_lossy(&mut reader, &mut buf).await;
        assert!(garbled.is_some_and(|line| line.contains('\u{fffd}')));
        assert_eq!(
            next_line_lossy(&mut reader, &mut buf).await.as_deref(),
            Some("{\"b\":2}")
        );
        assert_eq!(next_line_lossy(&mut reader, &mut buf).await, None);
    }
}
