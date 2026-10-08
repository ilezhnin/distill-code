//! One running ACP bridge process (claude-agent-acp, codex-acp, ...). The host
//! talks JSON-RPC over the child's stdin/stdout; responses are matched back to
//! their callers here, while notifications and agent-initiated requests are
//! handed to the host's event loop.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use super::execution::{NativeProvider, RuntimePaths};
use super::harness::HarnessSpec;
use super::protocol::{self, Message};
use crate::services::path_env::resolve_executable;
use crate::services::process::ProcessTree;
use crate::services::{env_key, managed_acp_tools};

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
        generation: u64,
        run_id: Option<String>,
        method: String,
        params: Value,
    },
    Request {
        harness: String,
        generation: u64,
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
        /// Whether the host ended it through [`Bridge::kill`] — an idle bridge
        /// shut down, the app quitting, a bridge that would not initialize —
        /// rather than the process dying on its own.
        stopped: bool,
    },
    /// Not a bridge event at all: a marker the host puts in the same queue to
    /// learn when everything queued before it has been handled. Answering
    /// `ack` is the event loop's only work for it.
    Drained {
        ack: oneshot::Sender<Result<(), String>>,
    },
}

struct PendingRequest {
    reply: oneshot::Sender<Result<Value, Value>>,
    turn: Option<(String, String)>,
}

type Pending = Mutex<HashMap<u64, PendingRequest>>;

fn received_run(pending: &Pending, params: &Value) -> Option<String> {
    let session_id = protocol::session_id(params)?;
    pending.lock().ok()?.values().find_map(|request| {
        let (session, run) = request.turn.as_ref()?;
        (session == &session_id).then(|| run.clone())
    })
}

/// The bridge's stdout has ended: mark it dead and fail every request still
/// waiting for an answer that will never come.
///
/// `alive` is set while the `pending` lock is held, which is the same lock
/// [`Bridge::register_owned`] registers under. That is what closes the race:
/// a request either registers before this drain (and is failed by it) or sees
/// the bridge as gone. Registering *after* the drain would wait forever — the
/// writer channel is still open so nothing errors, and `session/prompt` has no
/// deadline to rescue it.
fn fail_pending_on_exit(pending: &Pending, alive: &AtomicBool) {
    let guard = pending.lock();
    alive.store(false, Ordering::SeqCst);
    if let Ok(mut pending) = guard {
        for (_, request) in pending.drain() {
            let _ = request.reply.send(Err(protocol::internal("bridge exited")));
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
    /// The file this process runs, as [`executable_fingerprint`] describes
    /// it: what the model inventory probed through this bridge was read from.
    executable: Value,
    agent_capabilities: RwLock<Value>,
    writer: mpsc::UnboundedSender<String>,
    pending: Arc<Pending>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    /// When the host last used this process: handed it out for work (see
    /// [`Bridge::touch`]), or sent it a request or got an answer back. What the
    /// host measures an idle bridge by before shutting it down.
    last_used: Mutex<Instant>,
    child: Mutex<Option<Child>>,
    /// The bridge and everything it started — the agent CLI a node bridge
    /// spawns is a grandchild no kill of `child` reaches.
    tree: Option<ProcessTree>,
    sandbox_id: Option<String>,
    sandbox_stopped: AtomicBool,
}

/// Everything a bridge process inherits: the user's login-shell environment,
/// the directories to put in front of PATH (managed bridge shims, the distillctl
/// shim), and host-provided variables such as `DISTILLCTL_LOCK`.
#[derive(Clone)]
pub struct SpawnEnv {
    pub shell_env: HashMap<String, String>,
    pub prepend_dirs: Vec<PathBuf>,
    pub extra_env: Vec<(String, String)>,
    pub remove_env: Vec<String>,
}

/// The file `spec.command` runs as it stands on disk right now, or `None`
/// where the harness is not installed.
///
/// A harness CLI is updated underneath Distill — by its own updater, by npm,
/// by the doctor — and the models it serves change with it. This is the cheap
/// question the model inventory asks before trusting its cache: the path the
/// command resolves to, plus the size and modification time of what runs
/// there (the node entrypoint behind a managed launcher, the binary or shim
/// otherwise). Comparing the answer costs a `stat`, never a bridge process.
pub fn executable_fingerprint(spec: &HarnessSpec, env: &SpawnEnv) -> Option<Value> {
    let executable = resolve_executable(
        spec.command,
        &env.prepend_dirs,
        env_key::get(&env.shell_env, "PATH"),
    )?;
    Some(fingerprint_of(spec.id, &executable))
}

fn fingerprint_of(harness_id: &str, executable: &Path) -> Value {
    let target = managed_launcher(harness_id, executable)
        .map(|(_, entrypoint)| entrypoint)
        .unwrap_or_else(|| executable.to_path_buf());
    let metadata = std::fs::metadata(&target).ok();
    let modified = metadata
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_secs());
    json!({
        "path": target.to_string_lossy(),
        "len": metadata.as_ref().map(std::fs::Metadata::len),
        "modified": modified,
    })
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
/// The agent CLI node spawns (`claude.exe`, `codex`) is a grandchild either
/// way; the bridge's [`ProcessTree`] is what ends that one.
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
    if managed_acp_tools::is_managed(harness_id) {
        return managed_cmd_launcher(executable);
    }
    // An explicit tools directory disables managed installation. An isolated
    // app-driver fixture can still name a Node entrypoint, but only its exact
    // validated path and bytes authorize bypassing this deliberately simple
    // wrapper. Production pins and arbitrary third-party launchers stay on the
    // existing path above.
    #[cfg(feature = "app-test-driver")]
    {
        fixture_cmd_launcher(harness_id, executable, |entrypoint| {
            matches!(super::execution_fixture::verified(entrypoint), Ok(Some(_)))
        })
    }
    #[cfg(not(feature = "app-test-driver"))]
    {
        None
    }
}

#[cfg(feature = "app-test-driver")]
fn fixture_cmd_launcher(
    harness_id: &str,
    shim: &Path,
    verified: impl FnOnce(&Path) -> bool,
) -> Option<(PathBuf, PathBuf)> {
    if harness_id != "claude-acp"
        || !shim
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        return None;
    }
    let body = std::fs::read_to_string(shim).ok()?;
    let mut lines = body.lines().map(str::trim).filter(|line| !line.is_empty());
    if !lines.next()?.eq_ignore_ascii_case("@echo off") {
        return None;
    }
    let line = lines.next()?;
    if lines.next().is_some() {
        return None;
    }
    let (node, entrypoint) = line
        .strip_prefix('"')?
        .strip_suffix("\" %*")?
        .split_once("\" \"")?;
    // Never silently drop shell commands or extra launcher arguments. Only
    // the two quoted paths and literal argument forwarding are accepted.
    if node.contains('"') || entrypoint.contains('"') {
        return None;
    }
    let node = cmd_launcher_target(node, shim.parent()?);
    let entrypoint = cmd_launcher_target(entrypoint, shim.parent()?);
    (node.is_file() && verified(&entrypoint)).then_some((node, entrypoint))
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

/// What a host-owned benchmark bridge runs in place of the harness command.
pub struct OwnedLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The file the executable fingerprint describes: the pinned entrypoint or
    /// binary the profile was verified against.
    pub fingerprint_target: PathBuf,
    pub sandbox: Option<(String, String)>,
}

fn missing_bridge(spec: &HarnessSpec) -> String {
    format!(
        "The {} bridge (`{}`) is not installed. Set it up from Settings → AI providers.",
        spec.label, spec.command
    )
}

/// Builds the launch for `provider` from what `spec.command` resolves to on
/// `env`'s PATH, verifying the pinned runtime first. `managed_node` is
/// Distill's Node runtime and `native_cli` the managed native CLI the bridge
/// drives, for a profile that needs them. Reads and hashes the runtime, so
/// call it off the async workers.
pub(super) fn owned_launch(
    provider: NativeProvider,
    spec: &HarnessSpec,
    env: &SpawnEnv,
    managed_node: Option<&Path>,
    native_cli: Option<&Path>,
) -> Result<OwnedLaunch, String> {
    // Refused before anything starts, like every other missing runtime.
    let executable = resolve_executable(
        spec.command,
        &env.prepend_dirs,
        env_key::get(&env.shell_env, "PATH"),
    )
    .ok_or_else(|| format!("capability_missing: {}", missing_bridge(spec)))?;
    // The rest run a node entrypoint with the adapter preloaded: the managed
    // launcher's own, or Kimi's npm package under Distill's Node.
    let (node, entrypoint) = match provider {
        NativeProvider::Claude | NativeProvider::Codex => managed_launcher(spec.id, &executable)
            .ok_or_else(|| {
                format!(
                    "capability_missing: benchmark execution requires the managed {} launcher",
                    spec.label
                )
            })?,
        NativeProvider::Kimi => {
            let entrypoint = super::execution::kimi_entrypoint(&executable)?;
            let node = managed_node.filter(|node| node.is_file()).ok_or(
                "capability_missing: benchmark execution requires the managed Node runtime",
            )?;
            (node.to_path_buf(), entrypoint)
        }
        // The native CLI chats run, verified byte for byte, with the
        // profile's own arguments.
        NativeProvider::Grok => {
            let executable = super::execution::grok_binary(&executable);
            provider.verify_runtime(&RuntimePaths {
                entrypoint: &executable,
                native_cli: None,
            })?;
            return Ok(OwnedLaunch {
                program: executable.clone(),
                args: provider.launch_args().to_vec(),
                fingerprint_target: executable,
                sandbox: None,
            });
        }
    };
    let runtime = RuntimePaths {
        entrypoint: &entrypoint,
        native_cli,
    };
    let mut args = vec![
        "--import".to_string(),
        super::execution::native_preload_argument(provider, &runtime)?,
        entrypoint.to_string_lossy().into_owned(),
    ];
    args.extend(spec.args.iter().map(|arg| (*arg).to_string()));
    Ok(OwnedLaunch {
        program: node,
        args,
        fingerprint_target: entrypoint,
        sandbox: None,
    })
}

/// Installs `env` on a bridge `command`. An `owned` launch starts from a
/// cleared environment, so nothing of Distill's own process reaches it, and
/// the launcher-identity scrub is skipped: it removes by name, after
/// everything below, and would also take away what the host set under such a
/// name (a provider home that Orca redirects for Distill itself, say).
fn apply_env(command: &mut std::process::Command, spec: &HarnessSpec, env: &SpawnEnv, owned: bool) {
    if owned {
        command.env_clear();
    }
    // Remove inherited credentials before installing this account's own
    // environment. Filtering only shell_env would still inherit the host.
    for key in &env.remove_env {
        command.env_remove(key);
    }
    let extended_path = crate::services::path_env::build_extended_path_with_prepended_dirs(
        env_key::get(&env.shell_env, "PATH"),
        &env.prepend_dirs,
    );
    for (key, value) in &env.shell_env {
        if env_key::matches(key, "PATH") {
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
    // `RUST_LOG` configures Distill's own log. Handed down, it turns a
    // Rust-built bridge (grok) into an INFO firehose whose stderr lands in
    // distill.log and rotates it every few minutes, taking crash history
    // with it.
    command.env_remove("RUST_LOG");
    if !owned {
        crate::services::shell_env::remove_inherited_launcher_env(command);
    }
}

impl Bridge {
    pub async fn spawn(
        spec: &HarnessSpec,
        env: &SpawnEnv,
        events: mpsc::UnboundedSender<BridgeEvent>,
    ) -> Result<Arc<Bridge>, String> {
        Self::spawn_scoped(spec, env, events, spec.id, None).await
    }

    /// Starts the bridge for `route_key`. A benchmark route runs only an
    /// `owned` launch, in a cleared environment.
    pub async fn spawn_scoped(
        spec: &HarnessSpec,
        env: &SpawnEnv,
        events: mpsc::UnboundedSender<BridgeEvent>,
        route_key: &str,
        owned: Option<&OwnedLaunch>,
    ) -> Result<Arc<Bridge>, String> {
        if route_key.contains("\u{1f}benchmark:") && owned.is_none() {
            return Err("capability_missing: benchmark execution requires an owned launch".into());
        }
        let (program, args, executable_fingerprint) = match owned {
            Some(launch) => (
                launch.program.clone(),
                launch.args.clone(),
                launch.sandbox.as_ref().map_or_else(
                    || fingerprint_of(spec.id, &launch.fingerprint_target),
                    |(_, revision)| json!({"sandbox":"distill-bench","revision":revision}),
                ),
            ),
            None => {
                let executable = resolve_executable(
                    spec.command,
                    &env.prepend_dirs,
                    env_key::get(&env.shell_env, "PATH"),
                )
                .ok_or_else(|| missing_bridge(spec))?;
                // A managed bridge resolves to a `.cmd` launcher we wrote
                // ourselves; run what it runs, so the child we hold (and kill)
                // is node rather than the `cmd.exe` that would leave node
                // behind. Only for harnesses we installed: a third-party `.cmd`
                // on the user's PATH whose last line happens to hold two quoted
                // paths must keep being launched the way `cmd.exe` reads it,
                // arguments and all.
                let fingerprint = fingerprint_of(spec.id, &executable);
                let mut args = Vec::new();
                let program = match managed_launcher(spec.id, &executable) {
                    Some((node, entrypoint)) => {
                        args.push(entrypoint.to_string_lossy().into_owned());
                        node
                    }
                    None => executable,
                };
                args.extend(spec.args.iter().map(|arg| (*arg).to_string()));
                (program, args, fingerprint)
            }
        };
        let mut command = Command::new(&program);
        apply_env(command.as_std_mut(), spec, env, owned.is_some());
        command.args(&args);
        crate::services::process::apply_no_window_async(&mut command);
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        // An owned launch's arguments include the preload, a long data URL.
        log::info!(
            "[agent-host] spawning {} bridge: {} {}",
            spec.id,
            program.display(),
            args.iter()
                .map(|arg| if arg.starts_with("data:") {
                    "<preload>"
                } else {
                    arg.as_str()
                })
                .collect::<Vec<_>>()
                .join(" ")
        );
        let mut child = command.spawn().map_err(|error| {
            format!(
                "failed to start the {} bridge ({}): {error}",
                spec.label,
                program.display()
            )
        })?;

        // Before the bridge has had time to start the agent CLI, so that lands
        // in the tree as well.
        let tree = ProcessTree::contain(&child);
        if tree.is_none() && cfg!(windows) {
            log::warn!(
                "[agent-host] the {} bridge runs outside a job; what it starts can outlive it",
                spec.id
            );
        }

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

        // stderr: keep the bridge's own logging visible in Distill's log.
        if let Some(stderr) = stderr {
            let harness = route_key.to_string();
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
            let harness = route_key.to_string();
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
                                Some(request) => {
                                    let _ = request.reply.send(result);
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
                                generation,
                                id,
                                method,
                                params,
                            });
                        }
                        Some(Message::Notification { method, params }) => {
                            let _ = events.send(BridgeEvent::Notification {
                                harness: harness.clone(),
                                generation,
                                run_id: received_run(&pending, &params),
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
                // `kill` marks the bridge dead before it ends the process, so
                // one still marked alive here ended on its own.
                let stopped = !alive.load(Ordering::SeqCst);
                fail_pending_on_exit(&pending, &alive);
                let _ = events.send(BridgeEvent::Exited {
                    harness,
                    generation,
                    stopped,
                });
            });
        }

        let bridge = Arc::new(Bridge {
            harness: spec.id.to_string(),
            generation,
            executable: executable_fingerprint,
            agent_capabilities: RwLock::new(Value::Null),
            writer: writer_tx,
            pending,
            next_id: AtomicU64::new(1),
            alive,
            last_used: Mutex::new(Instant::now()),
            child: Mutex::new(Some(child)),
            tree,
            sandbox_id: owned.and_then(|launch| launch.sandbox.as_ref().map(|(id, _)| id.clone())),
            sandbox_stopped: AtomicBool::new(false),
        });

        let init = bridge
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false,
                        "session": { "notices": {}, "compaction": {} },
                        "_meta": {
                            "terminal_output_delta": true,
                            "jetbrains": { "air": { "version": 1, "capabilities": ["sessionFailure"] } }
                        }
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

    /// The file this process runs; see the field's comment.
    pub fn executable(&self) -> Value {
        self.executable.clone()
    }

    /// Record that the host is using this bridge now, which restarts its idle
    /// clock (see the `last_used` field).
    pub fn touch(&self) {
        if let Ok(mut last_used) = self.last_used.lock() {
            *last_used = Instant::now();
        }
    }

    /// When the host last used this bridge; see [`Bridge::touch`].
    pub fn last_used(&self) -> Instant {
        self.last_used
            .lock()
            .map_or_else(|_| Instant::now(), |last_used| *last_used)
    }

    /// How many of the host's requests are still waiting for an answer.
    pub fn in_flight(&self) -> usize {
        self.pending.lock().map_or(0, |pending| pending.len())
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
        self.request_owned(method, params, deadline, None).await
    }

    /// Capture turn ownership at stdout receipt, before notifications can
    /// wait behind another session's disk writes in the host event queue.
    pub async fn prompt(&self, params: Value, run_id: String) -> Result<Value, Value> {
        self.prompt_with_admission(params, run_id, None, None).await
    }

    pub(super) async fn prompt_with_admission(
        &self,
        params: Value,
        run_id: String,
        admission: Option<tokio::sync::OwnedMutexGuard<()>>,
        owned_deadline: Option<tokio::time::Instant>,
    ) -> Result<Value, Value> {
        let session_id = protocol::session_id(&params)
            .ok_or_else(|| protocol::invalid_params("sessionId required"))?;
        self.request_owned_with_admission(
            "session/prompt",
            params,
            None,
            Some((session_id, run_id)),
            admission,
            owned_deadline,
        )
        .await
    }

    async fn request_owned(
        &self,
        method: &str,
        params: Value,
        deadline: Option<Duration>,
        turn: Option<(String, String)>,
    ) -> Result<Value, Value> {
        self.request_owned_with_admission(method, params, deadline, turn, None, None)
            .await
    }

    async fn request_owned_with_admission(
        &self,
        method: &str,
        params: Value,
        deadline: Option<Duration>,
        turn: Option<(String, String)>,
        admission: Option<tokio::sync::OwnedMutexGuard<()>>,
        owned_deadline: Option<tokio::time::Instant>,
    ) -> Result<Value, Value> {
        if !self.is_alive() {
            return Err(protocol::internal(format!(
                "{} bridge is not running",
                self.harness
            )));
        }
        self.touch();
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        if !self.register_owned(id, tx, turn) {
            return Err(protocol::internal(format!(
                "{} bridge is not running",
                self.harness
            )));
        }
        let line = protocol::request(json!(id), method, params);
        if owned_deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
            self.forget(id);
            return Err(protocol::error_with_data(
                -32000,
                "Native root budget expired before provider submission",
                json!({"kind":"budget_timeout"}),
            ));
        }
        if self.writer.send(line).is_err() {
            self.forget(id);
            return Err(protocol::internal(format!(
                "{} bridge stdin closed",
                self.harness
            )));
        }
        // Revocation linearizes against this synchronous native RPC submission,
        // after the receipt claim and every awaited host preparation step.
        // Already submitted work retains its durable identity; no lock is held
        // while waiting for a provider answer.
        drop(admission);
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
        // The idle clock starts when the bridge finished its work, not when it
        // was given it: a turn that ran for an hour was not an hour of idling.
        self.touch();
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
    #[cfg(test)]
    fn register_pending(&self, id: u64, tx: oneshot::Sender<Result<Value, Value>>) -> bool {
        self.register_owned(id, tx, None)
    }

    fn register_owned(
        &self,
        id: u64,
        tx: oneshot::Sender<Result<Value, Value>>,
        turn: Option<(String, String)>,
    ) -> bool {
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        if !self.alive.load(Ordering::SeqCst) {
            return false;
        }
        pending.insert(id, PendingRequest { reply: tx, turn });
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

    pub fn is_sandbox(&self) -> bool {
        self.sandbox_id.is_some()
    }

    pub async fn stop_sandbox(&self) -> Result<(), String> {
        if let Some(id) = &self.sandbox_id {
            crate::services::benchmark_sandbox::kill("session", id)
                .await
                .map_err(|error| error.to_string())?;
            self.sandbox_stopped.store(true, Ordering::SeqCst);
            self.kill();
        }
        Ok(())
    }

    pub fn kill(&self) {
        if !self.sandbox_stopped.swap(true, Ordering::SeqCst) {
            if let Some(id) = &self.sandbox_id {
                crate::services::benchmark_sandbox::kill_detached(id);
            }
        }
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.start_kill();
            }
        }
        if let Some(tree) = &self.tree {
            tree.kill();
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
    resolve_executable(
        spec.command,
        &env.prepend_dirs,
        env_key::get(&env.shell_env, "PATH"),
    )
    .is_some()
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    /// A bridge with no process behind it: whatever is written to it lands
    /// in the returned receiver, and nothing ever answers.
    pub(crate) fn silent_bridge() -> (Bridge, mpsc::UnboundedReceiver<String>) {
        let (writer, written) = mpsc::unbounded_channel();
        let bridge = Bridge {
            harness: "test-acp".to_string(),
            generation: NEXT_GENERATION.fetch_add(1, Ordering::SeqCst),
            executable: Value::Null,
            agent_capabilities: RwLock::new(Value::Null),
            writer,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            alive: Arc::new(AtomicBool::new(true)),
            last_used: Mutex::new(Instant::now()),
            child: Mutex::new(None),
            tree: None,
            sandbox_id: None,
            sandbox_stopped: AtomicBool::new(false),
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
    fn queued_notifications_keep_their_turn_when_the_next_prompt_starts() {
        let (bridge, _written) = silent_bridge();
        let params = json!({"sessionId":"s"});
        let (tx, _rx) = oneshot::channel();
        assert!(bridge.register_owned(1, tx, Some(("s".into(), "first".into()))));
        let queued = received_run(&bridge.pending, &params);
        assert_eq!(queued.as_deref(), Some("first"));
        assert!(received_run(&bridge.pending, &json!({"sessionId":"other"})).is_none());
        bridge.forget(1);
        assert!(received_run(&bridge.pending, &params).is_none());
        let (tx, _rx) = oneshot::channel();
        assert!(bridge.register_owned(2, tx, Some(("s".into(), "second".into()))));
        assert_eq!(
            received_run(&bridge.pending, &params).as_deref(),
            Some("second")
        );
        assert_eq!(queued.as_deref(), Some("first"));
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
            "@echo off\r\nREM Written by Distill's managed ACP tools installer; do not edit.\r\n\"{node}\" \"{entrypoint}\" %*\r\n"
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

    #[tokio::test]
    async fn benchmark_route_without_owned_launch_is_refused() {
        let spec = super::super::harness::harness("claude-acp").unwrap();
        let env = SpawnEnv {
            shell_env: HashMap::new(),
            prepend_dirs: Vec::new(),
            extra_env: Vec::new(),
            remove_env: Vec::new(),
        };
        let (events, _received) = mpsc::unbounded_channel();
        let refused = Bridge::spawn_scoped(
            spec,
            &env,
            events,
            "claude-acp\u{1f}account\u{1f}benchmark:profile",
            None,
        )
        .await
        .err();
        assert_eq!(
            refused.as_deref(),
            Some("capability_missing: benchmark execution requires an owned launch")
        );
    }

    /// Distill started from an Orca pane carries Orca's redirect of a
    /// provider home with its `ORCA_` twin. The owned process must still get
    /// the private home the host set, not lose it to the launcher scrub.
    #[test]
    fn an_owned_launch_keeps_what_the_host_set_under_a_launcher_name() {
        const NAME: &str = "DISTILL_OWNED_HOME_TEST_5E2B";
        const TWIN: &str = "ORCA_DISTILL_OWNED_HOME_TEST_5E2B";
        std::env::set_var(NAME, "orca-redirect");
        std::env::set_var(TWIN, "orca-redirect");
        let spec = super::super::harness::harness("grok-acp").unwrap();
        let env = SpawnEnv {
            shell_env: HashMap::new(),
            prepend_dirs: Vec::new(),
            extra_env: vec![(NAME.to_string(), "private-home".to_string())],
            remove_env: Vec::new(),
        };
        let value = |command: &std::process::Command| {
            command
                .get_envs()
                .find(|(key, _)| *key == NAME)
                .map(|(_, value)| value.map(|value| value.to_string_lossy().into_owned()))
        };
        let mut owned = std::process::Command::new("grok");
        apply_env(&mut owned, spec, &env, true);
        assert_eq!(value(&owned), Some(Some("private-home".to_string())));
        // A chat bridge inherits Distill's own environment, so the scrub stays.
        let mut chat = std::process::Command::new("grok");
        apply_env(&mut chat, spec, &env, false);
        assert_eq!(value(&chat), Some(None));
        std::env::remove_var(NAME);
        std::env::remove_var(TWIN);
    }

    #[test]
    fn grok_launch_runs_only_the_verified_binary_with_the_profile_arguments() {
        let bin = tempfile::tempdir().expect("temp dir");
        let executable = bin
            .path()
            .join(if cfg!(windows) { "grok.exe" } else { "grok" });
        std::fs::write(&executable, "another grok build").unwrap();
        let spec = super::super::harness::harness("grok-acp").unwrap();
        let env = SpawnEnv {
            shell_env: HashMap::from([(
                "PATH".to_string(),
                bin.path().to_string_lossy().into_owned(),
            )]),
            prepend_dirs: Vec::new(),
            extra_env: Vec::new(),
            remove_env: Vec::new(),
        };
        let refused = owned_launch(NativeProvider::Grok, spec, &env, None, None).err();
        assert_eq!(
            refused.as_deref(),
            Some("capability_missing: installed Grok runtime changed; benchmark profile requires verification")
        );
        let missing = SpawnEnv {
            shell_env: HashMap::new(),
            ..env
        };
        assert!(
            owned_launch(NativeProvider::Grok, spec, &missing, None, None)
                .err()
                .is_some_and(|error| error.contains("is not installed"))
        );
        // What the verified build is started with.
        assert_eq!(
            NativeProvider::Grok.launch_args(),
            ["agent", "--no-leader", "stdio"]
        );
        assert_eq!(spec.args, ["agent", "stdio"]);
    }

    #[test]
    fn kimi_launch_runs_the_npm_package_under_the_managed_node() {
        let prefix = tempfile::tempdir().expect("temp dir");
        let shim = prefix
            .path()
            .join(if cfg!(windows) { "kimi.cmd" } else { "kimi" });
        std::fs::write(&shim, "@ECHO off\r\n").unwrap();
        let spec = super::super::harness::harness("kimi-acp").unwrap();
        let env = SpawnEnv {
            shell_env: HashMap::from([(
                "PATH".to_string(),
                prefix.path().to_string_lossy().into_owned(),
            )]),
            prepend_dirs: Vec::new(),
            extra_env: Vec::new(),
            remove_env: Vec::new(),
        };
        let node = prefix.path().join("node.exe");
        std::fs::write(&node, "node").unwrap();
        let launch = |managed_node: Option<&Path>| {
            owned_launch(NativeProvider::Kimi, spec, &env, managed_node, None).err()
        };
        // A shim with no package beside it is not an install the profile knows.
        assert_eq!(
            launch(Some(&node)).as_deref(),
            Some("capability_missing: Kimi Code is not a recognized npm install")
        );
        let dist = prefix
            .path()
            .join("node_modules")
            .join("@moonshot-ai")
            .join("kimi-code")
            .join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("main.mjs"), "another kimi build").unwrap();
        assert_eq!(
            launch(None).as_deref(),
            Some("capability_missing: benchmark execution requires the managed Node runtime")
        );
        assert_eq!(
            launch(Some(&prefix.path().join("missing-node.exe"))).as_deref(),
            Some("capability_missing: benchmark execution requires the managed Node runtime")
        );
        // The bundle is verified before anything starts.
        assert_eq!(
            launch(Some(&node)).as_deref(),
            Some("capability_missing: installed Kimi Code runtime changed; benchmark profile requires verification")
        );
        assert_eq!(spec.args, ["acp"]);
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

    #[cfg(feature = "app-test-driver")]
    #[test]
    fn fixture_launcher_requires_exact_authority_and_preserves_other_shell_behavior() {
        let dir = tempfile::tempdir().unwrap();
        let node = dir.path().join("node.exe");
        let entrypoint = dir.path().join("invented.mjs");
        let shim = dir.path().join("fixture.cmd");
        std::fs::write(&node, "not executed").unwrap();
        std::fs::write(&entrypoint, "invented protocol fixture").unwrap();
        let body = format!(
            "@echo off\r\n\"{}\" \"{}\" %*\r\n",
            node.display(),
            entrypoint.display()
        );
        std::fs::write(&shim, &body).unwrap();
        let expected = (node.clone(), entrypoint.clone());
        assert_eq!(
            fixture_cmd_launcher("claude-acp", &shim, |path| path == entrypoint),
            Some(expected)
        );
        assert!(fixture_cmd_launcher("claude-acp", &shim, |_| false).is_none());
        assert!(fixture_cmd_launcher("codex-acp", &shim, |_| true).is_none());
        assert!(fixture_cmd_launcher("grok-acp", &shim, |_| true).is_none());
        for changed in [
            body.replace(" %*", " --other %*"),
            body.replace(" %*", " %* & echo other"),
            format!("{body}echo other\r\n"),
            body.replace("@echo off", "@echo off\r\necho other"),
            body.replace(" %*", ""),
        ] {
            std::fs::write(&shim, changed).unwrap();
            assert!(fixture_cmd_launcher("claude-acp", &shim, |_| {
                panic!("unrecognized shell behavior must be refused before fixture verification")
            })
            .is_none());
        }
    }

    #[cfg(all(feature = "app-test-driver", windows))]
    #[test]
    fn an_isolated_fixture_override_fingerprints_and_launches_the_attested_entrypoint() {
        const CHILD_ENV: &str = "DISTILL_FIXTURE_LAUNCHER_REGRESSION_CHILD";
        if std::env::var_os(CHILD_ENV).is_none() {
            // Isolate startup-only fixture state and the tools override from
            // every other test. This child never starts Node or a provider.
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().join("fixture-launcher-regression");
            std::fs::create_dir(&root).unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "services::agent_host::bridge::tests::an_isolated_fixture_override_fingerprints_and_launches_the_attested_entrypoint",
                    "--nocapture",
                ])
                .env(CHILD_ENV, "1")
                .env("DISTILL_E2E_MODE", "1")
                .env("DISTILL_E2E_RUN_ID", "fixture-launcher-regression")
                .env("DISTILL_E2E_RUN_ROOT", &root)
                .env("APP_TEST_DRIVER_TOKEN", "a".repeat(32))
                .env("DISTILL_ACP_TOOLS_DIR", &root)
                .env_remove("DISTILL_E2E_RUNTIME_CONFIG");
            crate::services::process::apply_no_window(&mut command);
            let output = command.output().unwrap();
            assert!(
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("1 passed"),
                "fixture regression child failed: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let root = PathBuf::from(std::env::var_os("DISTILL_E2E_RUN_ROOT").unwrap());
        let node = root.join("node.exe");
        let entrypoint = root.join("invented.mjs");
        let shim = root.join("claude-agent-acp.cmd");
        let manifest = root.join("fixture.json");
        std::fs::write(&node, "not executed").unwrap();
        std::fs::write(&entrypoint, "invented protocol fixture").unwrap();
        std::fs::write(
            &shim,
            format!(
                "@echo off\r\n\"{}\" \"{}\" %*\r\n",
                node.display(),
                entrypoint.display()
            ),
        )
        .unwrap();
        assert!(managed_launcher("claude-acp", &shim).is_none());
        assert_eq!(
            fingerprint_of("claude-acp", &shim)["path"],
            shim.to_string_lossy().as_ref()
        );
        std::fs::write(
            &manifest,
            serde_json::to_vec(&json!({
                "schemaVersion":1,"kind":"invented-native-text","entrypoint":entrypoint,
                "sha256":super::super::execution::file_digest(&entrypoint).unwrap()
            }))
            .unwrap(),
        )
        .unwrap();
        std::env::set_var("DISTILL_E2E_NATIVE_FIXTURE_MANIFEST", &manifest);
        let mode = crate::services::e2e_mode::E2eMode::from_process_env(
            "com.levocat.distill.e2e.fixture-launcher-regression",
        )
        .unwrap()
        .unwrap();
        super::super::execution_fixture::initialize(&mode).unwrap();
        assert!(!managed_acp_tools::is_managed("claude-acp"));
        assert!(managed_launcher("codex-acp", &shim).is_none());
        assert_eq!(
            fingerprint_of("claude-acp", &shim)["path"],
            entrypoint.to_string_lossy().as_ref()
        );
        let spec = super::super::harness::harness("claude-acp").unwrap();
        let env = SpawnEnv {
            shell_env: HashMap::new(),
            prepend_dirs: vec![root.clone()],
            extra_env: Vec::new(),
            remove_env: Vec::new(),
        };
        let launch = owned_launch(NativeProvider::Claude, spec, &env, None, None).unwrap();
        assert_eq!(launch.program, node);
        assert_eq!(launch.fingerprint_target, entrypoint);
        assert_eq!(launch.args[0], "--import");
        assert!(launch.args[1].starts_with("data:text/javascript;base64,"));
        let other = root.join("other.mjs");
        std::fs::copy(&entrypoint, &other).unwrap();
        let body = std::fs::read_to_string(&shim).unwrap();
        std::fs::write(
            &shim,
            body.replace(entrypoint.to_str().unwrap(), other.to_str().unwrap()),
        )
        .unwrap();
        assert!(managed_launcher("claude-acp", &shim).is_none());
        assert!(owned_launch(NativeProvider::Claude, spec, &env, None, None).is_err());
        std::fs::write(&shim, body).unwrap();
        // Missing/changed attestation cannot preserve entrypoint provenance or
        // acquire an owned launch, even while a cached inventory exists.
        std::fs::write(&entrypoint, "changed fixture").unwrap();
        assert_eq!(
            fingerprint_of("claude-acp", &shim)["path"],
            shim.to_string_lossy().as_ref()
        );
        assert!(owned_launch(NativeProvider::Claude, spec, &env, None, None).is_err());
    }

    #[tokio::test]
    async fn a_request_cannot_register_behind_the_exit_drain() {
        let pending: Arc<Pending> = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let bridge = Bridge {
            harness: "test-acp".to_string(),
            generation: NEXT_GENERATION.fetch_add(1, Ordering::SeqCst),
            executable: Value::Null,
            agent_capabilities: RwLock::new(Value::Null),
            writer: mpsc::unbounded_channel().0,
            pending: Arc::clone(&pending),
            next_id: AtomicU64::new(1),
            alive: Arc::clone(&alive),
            last_used: Mutex::new(Instant::now()),
            child: Mutex::new(None),
            tree: None,
            sandbox_id: None,
            sandbox_stopped: AtomicBool::new(false),
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
