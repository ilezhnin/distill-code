//! One running ACP bridge process (claude-agent-acp, codex-acp, ...). The host
//! talks JSON-RPC over the child's stdin/stdout; responses are matched back to
//! their callers here, while notifications and agent-initiated requests are
//! handed to the host's event loop.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use super::harness::HarnessSpec;
use super::protocol::{self, Message};

/// How long a freshly started bridge gets to answer `initialize`. A process
/// that is alive but silent — a CLI waiting on a login prompt or a TTY,
/// reading our JSON as its input — never closes stdout, so without a
/// deadline it would hold its harness (and every caller queued on the spawn
/// lock) forever.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
/// The deadline for every other request but `session/prompt`, which runs
/// for as long as the agent works on the turn.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// How long a bridge gets to answer `method`; `None` is unbounded.
fn request_deadline(method: &str) -> Option<Duration> {
    if method == "session/prompt" {
        None
    } else {
        Some(REQUEST_TIMEOUT)
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
        let mut command = Command::new(&executable);
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
            "[agent-host] spawning {} bridge: {} {}",
            spec.id,
            executable.display(),
            spec.args.join(" ")
        );
        let mut child = command.spawn().map_err(|error| {
            format!(
                "failed to start the {} bridge ({}): {error}",
                spec.label,
                executable.display()
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
                alive.store(false, Ordering::SeqCst);
                if let Ok(mut pending) = pending.lock() {
                    for (_, sender) in pending.drain() {
                        let _ = sender.send(Err(protocol::internal("bridge exited")));
                    }
                }
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
            .request_within(
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
                Some(INITIALIZE_TIMEOUT),
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
    /// is the behaviour we had for every session.
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
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, tx);
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
        assert_eq!(request_deadline("initialize"), Some(REQUEST_TIMEOUT));
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
