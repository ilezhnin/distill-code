//! The agent host proper: a local WebSocket endpoint speaking ACP to the
//! renderer, routed onto one bridge process per harness, with sessions,
//! history, and settings persisted in SQLite.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::Manager;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::bridge::{error_text, Bridge, BridgeEvent, SpawnEnv};
use super::ext;
use super::harness::{self, HarnessSpec};
use super::harness_env::build_spawn_env;
use super::legacy_import;
use super::protocol::{self, invalid_params, now_iso, Message};
use super::session_title;
use super::sources::SourceRoots;
use super::store::{SessionRecord, SessionStore, SessionTouchUndo};
use crate::services::managed_acp_tools;

const SESSION_PAGE_SIZE: i64 = 200;
/// How long a chat has to stay on screen before its agent is woken in the
/// background. Clicking through the list attaches nothing; the prompt path
/// attaches on demand regardless.
const BACKGROUND_ATTACH_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);
/// How long closing a bridge session may take before reopening it anyway.
const BRIDGE_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const SNIPPET_CHARS: usize = 200;
/// How long an attach waits for the bridge event loop to catch up with the
/// history the bridge replayed before it gives up and goes live anyway.
const EVENT_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// How many streamed updates may wait for their commit before the bridge event
/// loop stops taking new ones and writes what it has. A burst of chunks then
/// costs one transaction instead of one per chunk, and nothing waits longer than
/// the burst.
const APPEND_BATCH_LIMIT: usize = 64;
pub const EXT_PREFIX: &str = "_distill/";

/// The kv row that governs the lazy split of folded model ids
/// (`gpt-5.6-sol[xhigh]` into a model and an effort). See
/// `selection_split_enabled`.
const SELECTION_SPLIT_SCOPE: &str = "migrations";
const SELECTION_SPLIT_KEY: &str = "selection_split";

/// The renderer socket a request arrived on. Its reply goes back there and
/// nowhere else: request ids are per socket (the SDK numbers them from 0 on
/// every connection), so a reply delivered to a later socket would resolve
/// whatever request happens to carry that id there. Once the socket is gone
/// the sender fails and the reply is dropped.
type ReplyTo = mpsc::UnboundedSender<String>;

/// The ids one user turn is recorded under: `message_id` is the user
/// prompt's message, `assistant_message_id` the agent's reply to it, and
/// `run_id` the turn.
#[derive(Clone)]
struct TurnIds {
    run_id: String,
    message_id: String,
    assistant_message_id: String,
}

impl TurnIds {
    fn new() -> Self {
        Self {
            run_id: uuid::Uuid::new_v4().to_string(),
            message_id: uuid::Uuid::new_v4().to_string(),
            assistant_message_id: uuid::Uuid::new_v4().to_string(),
        }
    }
}

struct RunState {
    run_id: String,
    message_id: String,
    assistant_message_id: String,
    agent_text: String,
    saw_agent_message: bool,
    /// Whether the bridge sent *any* `session/update` for this turn. A turn
    /// that produced nothing and then failed never happened, so its prompt is
    /// taken back out of the log instead of sitting there unanswered.
    saw_update: bool,
}

impl RunState {
    fn start(ids: &TurnIds) -> Self {
        Self {
            run_id: ids.run_id.clone(),
            message_id: ids.message_id.clone(),
            assistant_message_id: ids.assistant_message_id.clone(),
            agent_text: String::new(),
            saw_agent_message: false,
            saw_update: false,
        }
    }
}

/// What it takes to undo [`Inner::record_user_prompt`]: the turn the rows
/// belong to, the event rows the prompt was stored as, and the session-list
/// fields its `touch` overwrote. The run id is part of it because the undo is
/// only allowed for the turn it was recorded for — see
/// [`Inner::discard_rejected_prompt`].
struct RecordedPrompt {
    run_id: String,
    event_ids: Vec<i64>,
    undo: SessionTouchUndo,
}

struct QueuedPrompt {
    prompt: Value,
    meta: Value,
    ids: TurnIds,
}

/// A model id with an effort tier folded in, read back as the two values a
/// bridge offers in separate model and effort options (see `apply_model`).
///
/// LEGACY, INBOUND ONLY. The host itself never writes such an id any more;
/// this exists because one can still arrive from an old renderer, an old
/// berdctl client or a stored `sessions.model_id` the lazy split has not
/// reached, and a send must not fail on it. See `split_effort_model` for the
/// condition under which it can go.
#[derive(Debug, PartialEq, Eq)]
struct SplitModel {
    model: String,
    effort_option: String,
    effort: String,
}

/// What putting a bridge session on a model takes. One write is the whole
/// story — the bridge's own model option, the bridge's own model id — and the
/// other two arms exist for bridges and ids that predate it.
#[derive(Debug, PartialEq, Eq)]
enum ModelWrite {
    /// A bridge that offers no model option at all takes the older
    /// `session/set_model`. Only such a bridge may: codex's
    /// `unstable_setSessionModel` requires `model[effort]` and throws on a
    /// base id, so a base id must never reach it.
    SetModel,
    /// One `session/set_config_option` under the bridge's own option id.
    ConfigOption { config_id: String, model: String },
    /// LEGACY INBOUND: an id that still folds an effort into the model's name,
    /// sent as the two values the bridge keeps apart (see `SplitModel`).
    Folded(SplitModel),
}

/// Which of a session's four selections a config option carries. The host
/// classifies by ROLE so it knows what to persist, and then forwards the
/// bridge's own option id and value shape untouched — claude's `effort`,
/// codex's `reasoning_effort` and `fast-mode`, grok's `reasoning_effort`.
/// Renaming them here would take a per-harness table, and a gap in such a
/// table makes a control disappear rather than degrade.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OptionRole {
    Model,
    Effort,
    Fast,
    Other,
}

/// The three model-scoped selections of a session, either as a bridge's own
/// option list says it is set (`selection_from`) or as a chat is meant to run
/// (`apply_selection`). A field is `None` when it was not stated, which is
/// never the same as "off" or "no effort": an answer carrying no options at
/// all teaches nothing, while one that lists options without an effort option
/// says this model has none.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Selection {
    model: Option<String>,
    effort: Option<String>,
    fast: Option<bool>,
}

pub struct SessionRuntime {
    pub harness: String,
    pub bridge_session_id: String,
    /// The bridge process that accepted `bridge_session_id`. A later process
    /// for the same harness has never heard of it, and the exit of an earlier
    /// one says nothing about this session.
    generation: u64,
    loading: bool,
    run: Option<RunState>,
    steer_queue: VecDeque<QueuedPrompt>,
    /// `{ modes, models, configOptions }` as last reported by the bridge.
    snapshot: Value,
    has_model_option: bool,
    /// What the bridge would not do when this session was last put on its
    /// selections, as `_meta.substitutions` entries (see `apply_selection`).
    substitutions: Vec<Value>,
}

impl SessionRuntime {
    /// The bridge session calls on this session go to, and the bridge process
    /// that accepted it. There is none while the session is still being
    /// attached: the bridge has not accepted the stored id yet (and may
    /// never), so a caller waits on the attach lock instead of routing at a
    /// session the bridge does not know.
    fn route(&self) -> Option<(String, String, u64)> {
        if self.loading {
            return None;
        }
        Some((
            self.harness.clone(),
            self.bridge_session_id.clone(),
            self.generation,
        ))
    }

    /// Whether this session was accepted by *that* bridge process. Used when a
    /// bridge exits: only the sessions of the process that died are forgotten,
    /// never those of a replacement that is already serving the same harness.
    fn served_by(&self, harness: &str, generation: u64) -> bool {
        self.harness == harness && self.generation == generation
    }

    /// Forget the messages steered into the running turn, and report how many
    /// there were. A queued steer is only persisted and echoed when it is
    /// actually sent, so a sequence the user stopped — or one the bridge cut
    /// short with an error — must drop them instead of starting fresh turns
    /// nobody asked for and recording them as sent.
    fn drop_queued_steers(&mut self) -> usize {
        let dropped = self.steer_queue.len();
        self.steer_queue.clear();
        dropped
    }
}

pub struct Inner {
    pub app: tauri::AppHandle,
    pub store: SessionStore,
    pub roots: SourceRoots,
    ws_url: String,
    bridges: Mutex<HashMap<String, Arc<Bridge>>>,
    /// One lock per harness so two callers never spawn the same bridge twice,
    /// without holding `bridges` while a spawn is in flight.
    spawn_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    sessions: Mutex<HashMap<String, SessionRuntime>>,
    frontend: StdMutex<Option<mpsc::UnboundedSender<String>>>,
    /// Requests a bridge made of the client, by the id the renderer was
    /// asked under: (harness, the bridge's own id, method).
    client_requests: StdMutex<HashMap<u64, (String, Value, String)>>,
    next_client_request_id: AtomicU64,
    events_tx: mpsc::UnboundedSender<BridgeEvent>,
    spawn_env: Mutex<Option<Arc<SpawnEnv>>>,
    /// One lock per session so a background attach started by `session/load`
    /// and a prompt arriving while it runs never race to attach twice; the
    /// second caller waits and then takes the already-attached fast path.
    attach_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// The session `session/load` answered most recently; a delayed background
    /// attach only proceeds if it is still this one.
    last_loaded: StdMutex<Option<String>>,
    /// Reply text of the throwaway naming sessions `summarize_title` has open,
    /// by `naming_key` (harness and bridge session id).
    naming_replies: StdMutex<HashMap<String, String>>,
    /// Whether the lazy split of folded model ids still runs: 0 not read yet,
    /// 1 on, 2 off. Every session load asks, so the kv row behind it is read
    /// once per run.
    selection_split: AtomicU8,
}

/// Tauri-managed handle; the host starts lazily on the first URL request.
pub struct AgentHost {
    inner: Mutex<Option<Arc<Inner>>>,
}

impl Default for AgentHost {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentHost {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub async fn get_or_start(&self, app: &tauri::AppHandle) -> Result<Arc<Inner>, String> {
        let mut guard = self.inner.lock().await;
        if let Some(inner) = guard.as_ref() {
            return Ok(Arc::clone(inner));
        }
        let inner = Inner::start(app.clone()).await?;
        *guard = Some(Arc::clone(&inner));
        Ok(inner)
    }

    pub fn shutdown(&self) {
        if let Ok(guard) = self.inner.try_lock() {
            if let Some(inner) = guard.as_ref() {
                inner.kill_bridges();
            }
        }
    }
}

fn legacy_goose_projects_dir() -> Option<PathBuf> {
    // goose kept `<data dir>/Block/goose/data/projects`; carry them over once.
    let base = dirs::data_dir()?;
    Some(
        base.join("Block")
            .join("goose")
            .join("data")
            .join("projects"),
    )
}

impl Inner {
    async fn start(app: tauri::AppHandle) -> Result<Arc<Inner>, String> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
        let host_dir = app_data_dir.join("agent-host");
        let store = SessionStore::open(&host_dir.join("agent-host.db")).await?;
        match legacy_import::import_goose_sessions_once(&store).await {
            Ok(0) => {}
            Ok(count) => log::info!("[agent-host] imported {count} goose sessions"),
            Err(error) => log::warn!("[agent-host] goose session import failed: {error}"),
        }
        let roots = SourceRoots {
            projects_dir: app_data_dir.join("projects"),
            builtin_skills_dir: app_data_dir.join("skills"),
            legacy_projects_dir: legacy_goose_projects_dir(),
        };

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("failed to bind the agent host socket: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("failed to read the agent host port: {error}"))?
            .port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let ws_url = format!("ws://127.0.0.1:{port}/acp?token={token}");

        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            app,
            store,
            roots,
            ws_url,
            bridges: Mutex::new(HashMap::new()),
            spawn_locks: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            frontend: StdMutex::new(None),
            client_requests: StdMutex::new(HashMap::new()),
            next_client_request_id: AtomicU64::new(1_000_000),
            events_tx,
            spawn_env: Mutex::new(None),
            attach_locks: Mutex::new(HashMap::new()),
            last_loaded: StdMutex::new(None),
            naming_replies: StdMutex::new(HashMap::new()),
            selection_split: AtomicU8::new(0),
        });

        tokio::spawn(Arc::clone(&inner).accept_loop(listener, token));
        tokio::spawn(Arc::clone(&inner).bridge_event_loop(events_rx));
        log::info!("[agent-host] listening on 127.0.0.1:{port}");
        Ok(inner)
    }

    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    pub fn kill_bridges(&self) {
        if let Ok(bridges) = self.bridges.try_lock() {
            for bridge in bridges.values() {
                bridge.kill();
            }
        }
    }

    // -----------------------------------------------------------------------
    // Frontend socket

    // The handshake callback's error type is tungstenite's `ErrorResponse`.
    #[allow(clippy::result_large_err)]
    async fn accept_loop(self: Arc<Self>, listener: TcpListener, token: String) {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let expected = token.clone();
            let ws = tokio_tungstenite::accept_hdr_async(
                stream,
                move |request: &Request, response: Response| {
                    let query = request.uri().query().unwrap_or("");
                    let authorized = query
                        .split('&')
                        .any(|pair| pair.strip_prefix("token=") == Some(expected.as_str()));
                    if authorized {
                        Ok(response)
                    } else {
                        let mut rejection = ErrorResponse::new(Some("unauthorized".to_string()));
                        *rejection.status_mut() =
                            tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
                        Err(rejection)
                    }
                },
            )
            .await;
            let ws = match ws {
                Ok(ws) => ws,
                Err(error) => {
                    log::warn!("[agent-host] rejected socket: {error}");
                    continue;
                }
            };
            tokio::spawn(Arc::clone(&self).serve_frontend(ws));
        }
    }

    async fn serve_frontend(
        self: Arc<Self>,
        ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) {
        let (mut sink, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        // Whatever the previous renderer was asked can no longer be answered.
        let orphaned = self.take_client_requests();
        {
            if let Ok(mut frontend) = self.frontend.lock() {
                *frontend = Some(tx.clone());
            }
        }
        self.answer_orphaned_client_requests(orphaned).await;
        let writer = tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if sink.send(WsMessage::Text(line.into())).await.is_err() {
                    break;
                }
            }
        });
        while let Some(message) = source.next().await {
            match message {
                Ok(WsMessage::Text(text)) => {
                    // One task per frame, deliberately: `session/prompt` runs
                    // for as long as the agent works on the turn, so handling
                    // frames in arrival order would block every other call on
                    // this socket — a `session/cancel`, another chat's prompt —
                    // for that whole turn. The cost is that two frames sent back
                    // to back can reach the bridge in either order; the renderer
                    // serialises the mutations where that matters
                    // (`serializeSessionMutation`), and a cancel that loses the
                    // race is a no-op. Sequencing per *session* inside the host
                    // is the real fix and a design change.
                    let host = Arc::clone(&self);
                    let line = text.to_string();
                    let reply_to = tx.clone();
                    tokio::spawn(async move { host.handle_frontend_line(line, reply_to).await });
                }
                Ok(WsMessage::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
        let was_current = match self.frontend.lock() {
            Ok(mut frontend) => {
                let current = frontend
                    .as_ref()
                    .is_some_and(|current| current.same_channel(&tx));
                if current {
                    *frontend = None;
                }
                current
            }
            Err(_) => false,
        };
        if was_current {
            let orphaned = self.take_client_requests();
            self.answer_orphaned_client_requests(orphaned).await;
        }
        writer.abort();
        log::info!("[agent-host] frontend disconnected");
    }

    pub fn send_to_frontend(&self, line: String) {
        if let Ok(frontend) = self.frontend.lock() {
            if let Some(tx) = frontend.as_ref() {
                let _ = tx.send(line);
            }
        }
    }

    pub fn notify_frontend(&self, method: &str, params: Value) {
        self.send_to_frontend(protocol::notification(method, params));
    }

    /// Answer a request on the socket it arrived on, never on whichever socket
    /// is current when the answer is ready: request ids are numbered per
    /// connection, so the same id belongs to a different request on the next
    /// socket and the answer would resolve that one. A renderer that dropped
    /// the socket has given up on the answer, so it is dropped with it.
    fn reply_on(reply_to: &ReplyTo, method: &str, reply: String) {
        if reply_to.send(reply).is_err() {
            log::debug!("[agent-host] dropped the answer to {method}: its socket is gone");
        }
    }

    async fn handle_frontend_line(self: Arc<Self>, line: String, reply_to: ReplyTo) {
        let Some(message) = protocol::parse(&line) else {
            log::warn!("[agent-host] unparseable frontend message");
            return;
        };
        match message {
            Message::Request { id, method, params } => {
                let result = self.handle_request(&method, params).await;
                let reply = match result {
                    Ok(result) => protocol::response(id, result),
                    Err(error) => protocol::error_response(id, error),
                };
                Self::reply_on(&reply_to, &method, reply);
            }
            Message::Notification { method, params } => {
                self.handle_client_notification(&method, params).await;
            }
            Message::Response { id, result } => {
                self.handle_client_response(id, result).await;
            }
        }
    }

    async fn handle_client_notification(&self, method: &str, params: Value) {
        if method == "session/cancel" {
            if let Some(session_id) = protocol::session_id(&params) {
                // Stop means stop: the messages steered into the turn being
                // cancelled are not started as turns of their own once it
                // returns.
                let dropped = self
                    .sessions
                    .lock()
                    .await
                    .get_mut(&session_id)
                    .map(SessionRuntime::drop_queued_steers)
                    .unwrap_or(0);
                if dropped > 0 {
                    log::info!(
                        "[agent-host] session {session_id} cancelled: dropped {dropped} queued steer(s)"
                    );
                }
                if let Some((bridge, bridge_session_id)) = self.attached_route(&session_id).await {
                    let mut params = params.clone();
                    params["sessionId"] = json!(bridge_session_id);
                    bridge.notify(method, params);
                }
            }
        }
    }

    async fn handle_client_response(&self, id: Value, result: Result<Value, Value>) {
        let mapping = id
            .as_u64()
            .and_then(|key| self.client_requests.lock().ok()?.remove(&key));
        let Some((harness, bridge_id, _)) = mapping else {
            log::warn!("[agent-host] response for unknown client request {id}");
            return;
        };
        if let Some(bridge) = self.bridges.lock().await.get(&harness).cloned() {
            bridge.respond(bridge_id, result);
        }
    }

    /// The answer a bridge gets when no renderer can answer its request: a
    /// permission prompt is cancelled (the turn goes on or stops cleanly),
    /// anything else fails instead of leaving the bridge waiting forever.
    fn unanswered_client_request(method: &str) -> Result<Value, Value> {
        if method == "session/request_permission" {
            Ok(json!({ "outcome": { "outcome": "cancelled" } }))
        } else {
            Err(protocol::internal("The app is not connected"))
        }
    }

    /// Every request still waiting on the renderer; taken when the socket it
    /// was sent over is replaced or goes away.
    fn take_client_requests(&self) -> Vec<(String, Value, String)> {
        match self.client_requests.lock() {
            Ok(mut pending) => pending.drain().map(|(_, request)| request).collect(),
            Err(_) => Vec::new(),
        }
    }

    async fn answer_orphaned_client_requests(&self, orphaned: Vec<(String, Value, String)>) {
        if orphaned.is_empty() {
            return;
        }
        let bridges = self.bridges.lock().await;
        for (harness, id, method) in orphaned {
            if let Some(bridge) = bridges.get(&harness) {
                bridge.respond(id, Self::unanswered_client_request(&method));
            }
        }
    }

    async fn handle_request(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, Value> {
        if let Some(ext_method) = method.strip_prefix(EXT_PREFIX) {
            return ext::handle(self, ext_method, params).await;
        }
        match method {
            "initialize" => Ok(json!({
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
                    "mcpCapabilities": { "http": true, "sse": true },
                    "sessionCapabilities": { "list": {}, "fork": {} }
                },
                "agentInfo": { "name": "distill-host", "version": env!("CARGO_PKG_VERSION") },
                "authMethods": []
            })),
            "authenticate" => Ok(json!({})),
            "session/new" => self.new_session(params).await,
            "session/load" => self.load_session(params).await,
            "session/list" => self.list_sessions(params).await,
            "session/delete" => self.delete_session(params).await,
            "session/fork" => self.fork_session(params).await,
            "session/prompt" => self.prompt(params).await,
            "session/set_config_option" => self.set_config_option(params).await,
            "session/set_mode" | "session/set_model" => self.forward(method, params).await,
            _ => {
                if protocol::session_id(&params).is_some() {
                    self.forward(method, params).await
                } else {
                    Err(protocol::error(
                        protocol::METHOD_NOT_FOUND,
                        format!("Unsupported method {method}"),
                    ))
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Bridges

    async fn spawn_env(&self) -> Arc<SpawnEnv> {
        let mut cached = self.spawn_env.lock().await;
        if let Some(env) = cached.as_ref() {
            return Arc::clone(env);
        }
        let env = Arc::new(build_spawn_env(&self.app).await);
        *cached = Some(Arc::clone(&env));
        env
    }

    /// The running bridge for `harness_id`, if any. Takes the bridge map lock
    /// only for the lookup.
    async fn live_bridge(&self, harness_id: &str) -> Option<Arc<Bridge>> {
        self.bridges
            .lock()
            .await
            .get(harness_id)
            .filter(|bridge| bridge.is_alive())
            .cloned()
    }

    pub async fn ensure_bridge(&self, harness_id: &str) -> Result<Arc<Bridge>, Value> {
        let spec: &HarnessSpec = harness::harness(harness_id)
            .ok_or_else(|| invalid_params(format!("Unknown harness {harness_id}")))?;
        if let Some(bridge) = self.live_bridge(harness_id).await {
            return Ok(bridge);
        }
        // Spawning waits on a managed install and on the bridge's
        // `initialize` answer. Serialize that per harness instead of holding
        // the shared bridge map, which every session route, cancel and
        // permission answer needs in the meantime.
        let spawn_lock = Arc::clone(
            self.spawn_locks
                .lock()
                .await
                .entry(harness_id.to_string())
                .or_default(),
        );
        let _spawning = spawn_lock.lock().await;
        if let Some(bridge) = self.live_bridge(harness_id).await {
            return Ok(bridge);
        }
        let env = self.spawn_env().await;
        // A managed bridge is installed transactionally into app data; wait
        // out any install in flight so the process is never started from a
        // tree that is being swapped underneath it.
        let _install = if managed_acp_tools::is_managed(harness_id) {
            Some(managed_acp_tools::install_lock().lock().await)
        } else {
            None
        };
        let bridge = Bridge::spawn(spec, &env, self.events_tx.clone())
            .await
            .map_err(protocol::internal)?;
        self.bridges
            .lock()
            .await
            .insert(harness_id.to_string(), Arc::clone(&bridge));
        Ok(bridge)
    }

    pub async fn installed_harnesses(&self) -> Vec<&'static HarnessSpec> {
        let env = self.spawn_env().await;
        harness::HARNESSES
            .iter()
            .filter(|spec| super::bridge::is_installed(spec, &env))
            .collect()
    }

    /// The one loop that handles every bridge's events, in the order they
    /// arrived. Writing each streamed chunk to SQLite from here is what used to
    /// make every chat's persistence queue behind every other chat's — and made
    /// [`Self::drain_bridge_events`], which every attach and every withdrawn
    /// prompt waits on, wait for that whole backlog. The chunks are therefore
    /// stamped and forwarded to the renderer immediately and committed together
    /// as soon as the loop runs out of queued work, at the latest at the drain
    /// marker or after [`APPEND_BATCH_LIMIT`] of them.
    async fn bridge_event_loop(self: Arc<Self>, mut events: mpsc::UnboundedReceiver<BridgeEvent>) {
        let mut pending: Vec<(String, Value)> = Vec::new();
        loop {
            let event = match events.try_recv() {
                Ok(event) => event,
                Err(mpsc::error::TryRecvError::Empty) => {
                    // Nothing else is waiting: store what the burst produced
                    // before parking on the channel, so a chat is never more
                    // than one idle moment away from being on disk.
                    self.flush_pending_events(&mut pending).await;
                    match events.recv().await {
                        Some(event) => event,
                        None => break,
                    }
                }
                Err(mpsc::error::TryRecvError::Disconnected) => break,
            };
            match event {
                BridgeEvent::Notification {
                    harness,
                    method,
                    params,
                } => {
                    if let Some(event) =
                        self.on_bridge_notification(&harness, &method, params).await
                    {
                        pending.push(event);
                        if pending.len() >= APPEND_BATCH_LIMIT {
                            self.flush_pending_events(&mut pending).await;
                        }
                    }
                }
                BridgeEvent::Request {
                    harness,
                    id,
                    method,
                    params,
                } => self.on_bridge_request(&harness, id, &method, params).await,
                BridgeEvent::Drained { ack } => {
                    // Whoever waits for this marker reads the transcript, the
                    // run state, or both: everything queued before it is now
                    // handled *and* committed.
                    self.flush_pending_events(&mut pending).await;
                    let _ = ack.send(());
                }
                BridgeEvent::Exited {
                    harness,
                    generation,
                } => {
                    log::warn!("[agent-host] {harness} bridge exited");
                    // A replacement bridge may already be running and serving
                    // sessions: only the process that actually died is
                    // forgotten, and only the sessions it was serving. The
                    // rest keep working instead of silently losing the agent's
                    // context on their next prompt.
                    let mut bridges = self.bridges.lock().await;
                    if bridges
                        .get(&harness)
                        .is_some_and(|bridge| bridge.generation() == generation)
                    {
                        bridges.remove(&harness);
                    }
                    drop(bridges);
                    let mut sessions = self.sessions.lock().await;
                    sessions.retain(|_, runtime| !runtime.served_by(&harness, generation));
                }
            }
        }
        self.flush_pending_events(&mut pending).await;
    }

    /// Commit the session updates a burst of events produced. Consecutive
    /// events of one chat go in one transaction; the order they were handled in
    /// is the order the transcript keeps.
    async fn flush_pending_events(&self, pending: &mut Vec<(String, Value)>) {
        for (session_id, payloads) in Self::group_events_by_session(std::mem::take(pending)) {
            if let Err(error) = self.store.append_events(&session_id, &payloads).await {
                log::warn!(
                    "[agent-host] failed to persist {} update(s) of session {session_id}: {error}",
                    payloads.len()
                );
            }
        }
    }

    /// Runs of *consecutive* events belonging to the same chat. Two chats
    /// streaming at once interleave, and merging across the interleaving would
    /// reorder the log, so only neighbours are merged.
    fn group_events_by_session(events: Vec<(String, Value)>) -> Vec<(String, Vec<Value>)> {
        let mut grouped: Vec<(String, Vec<Value>)> = Vec::new();
        for (session_id, payload) in events {
            match grouped.last_mut() {
                Some((current, payloads)) if *current == session_id => payloads.push(payload),
                _ => grouped.push((session_id, vec![payload])),
            }
        }
        grouped
    }

    /// Wait until the bridge event loop has handled everything that was
    /// already queued, and has stored it. A `session/load` replays the whole
    /// transcript as notifications into that queue and only then answers; the
    /// replay is swallowed because the session is still `loading`, so the
    /// session must not become live until the loop has actually reached the
    /// marker behind it — otherwise the tail of the replay is persisted a
    /// second time. It is also how a caller that is about to read the
    /// transcript, or a turn's run state, knows the queue holds nothing about
    /// it any more.
    ///
    /// The queue is shared by every bridge, so this waits for other harnesses'
    /// events too — bounded by what the loop does per event, which is stamping
    /// and forwarding, not a database round trip.
    pub(super) async fn drain_bridge_events(&self) {
        let (ack, drained) = oneshot::channel();
        if self.events_tx.send(BridgeEvent::Drained { ack }).is_err() {
            return;
        }
        if tokio::time::timeout(EVENT_DRAIN_TIMEOUT, drained)
            .await
            .is_err()
        {
            log::warn!(
                "[agent-host] bridge events still backlogged after {} seconds",
                EVENT_DRAIN_TIMEOUT.as_secs()
            );
        }
    }

    /// Map a bridge-side session id back to the host session id.
    async fn host_session_for(&self, harness: &str, bridge_session_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions
            .iter()
            .find(|(_, runtime)| {
                runtime.harness == harness && runtime.bridge_session_id == bridge_session_id
            })
            .map(|(id, _)| id.clone())
    }

    async fn runtime_route(&self, session_id: &str) -> Option<(String, String, u64)> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).and_then(SessionRuntime::route)
    }

    /// Handle one notification and report the update the transcript has to
    /// keep, for the loop to commit with the rest of the burst. `None` when
    /// there is nothing to store: a notification that is not a session update,
    /// one of a session nobody is watching, or a replay of history the session
    /// already has.
    async fn on_bridge_notification(
        &self,
        harness: &str,
        method: &str,
        mut params: Value,
    ) -> Option<(String, Value)> {
        if method != "session/update" {
            self.notify_frontend(method, params);
            return None;
        }
        let bridge_session_id = protocol::session_id(&params)?;
        let Some(session_id) = self.host_session_for(harness, &bridge_session_id).await else {
            // Probe sessions and history replays we asked for are not
            // surfaced to the renderer; a naming session's reply is kept.
            self.capture_naming_reply(harness, &bridge_session_id, &params);
            return None;
        };
        let mut persist = false;
        let mut reconfigured: Option<(Value, Selection)> = None;
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.get_mut(&session_id) {
                if runtime.loading {
                    return None;
                }
                persist = true;
                if let Some(run) = runtime.run.as_mut() {
                    Self::stamp_run_update(&mut params, run, &now_iso());
                }
                if let Some(options) = Self::config_option_update(&params) {
                    // A bridge moves these without being asked: claude drops
                    // an effort a model does not offer, and the SDK flips fast
                    // mode back after a cooldown. Until now the host watched
                    // the update go past and kept describing the old state.
                    let selection = Self::selection_from(&options);
                    runtime.snapshot["configOptions"] = options;
                    runtime.has_model_option = Self::has_model_option(&runtime.snapshot);
                    reconfigured = Some((runtime.snapshot.clone(), selection));
                }
            }
        }
        if let Some((snapshot, selection)) = reconfigured {
            self.store_bridge_selection(&session_id, &snapshot, &selection)
                .await;
        }
        params["sessionId"] = json!(session_id);
        let stored = if persist {
            // A harness title is at best the chat's first prompt echoed back
            // (Claude Code's `summary` falls back to it). It may name a chat
            // nothing has named yet, but must not replace the host's title in
            // the event log or on screen. It is a session-list field, not a log
            // entry, and one arrives per chat rather than per chunk.
            if let Some(title) = Self::agent_title(&params).map(str::to_string) {
                let named = self
                    .store
                    .set_title_if_untitled(&session_id, &title)
                    .await
                    .unwrap_or_else(|error| {
                        log::warn!("[agent-host] failed to store the agent's title: {error}");
                        false
                    });
                if !named {
                    if let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) {
                        update.remove("title");
                    }
                }
            }
            Some((session_id, params.clone()))
        } else {
            None
        };
        self.notify_frontend("session/update", params);
        stored
    }

    /// The option list a `config_option_update` carries, as the bridge sent
    /// it. A bridge that sends one sends its whole list (verified on grok, the
    /// only one that notifies a client-initiated write), so it is a complete
    /// statement of the session's configuration; an empty array is not, and
    /// says nothing.
    fn config_option_update(params: &Value) -> Option<Value> {
        let update = params.get("update")?;
        if update.get("sessionUpdate").and_then(Value::as_str) != Some("config_option_update") {
            return None;
        }
        update
            .get("configOptions")
            .filter(|options| options.as_array().is_some_and(|list| !list.is_empty()))
            .cloned()
    }

    /// Record a change a bridge made on its own: the snapshot it now
    /// describes, the effort and fast toggle it just stated — the absence of
    /// either in a full list means the model has none — and the model, which
    /// is only ever written when named, since clearing it would send the next
    /// attach to the harness default.
    async fn store_bridge_selection(
        &self,
        session_id: &str,
        snapshot: &Value,
        selection: &Selection,
    ) {
        if let Err(error) = self.store.set_snapshot(session_id, snapshot).await {
            log::warn!("[agent-host] failed to store the session snapshot: {error}");
        }
        if let Some(model_id) = selection.model.as_deref() {
            if let Err(error) = self.store.set_model(session_id, Some(model_id)).await {
                log::warn!("[agent-host] failed to store the session model: {error}");
            }
        }
        if let Err(error) = self
            .store
            .set_run_settings(session_id, selection.effort.as_deref(), selection.fast)
            .await
        {
            log::warn!("[agent-host] failed to store the session run settings: {error}");
        }
    }

    /// The title a `session_info_update` proposes, when it is one the chat
    /// list should keep (the renderer applies the same filter live).
    fn agent_title(params: &Value) -> Option<&str> {
        let update = params.get("update")?;
        if update.get("sessionUpdate").and_then(Value::as_str) != Some("session_info_update") {
            return None;
        }
        update
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| {
                !title.is_empty() && !title.starts_with(legacy_import::PERSONA_HANDOFF_PREFIX)
            })
    }

    /// Note what a running turn's update adds to the chat snippet and stamp
    /// it with the host's bookkeeping. `messageId` is the user prompt's id,
    /// as it always was; everything but a user chunk also names the reply's
    /// own message, `assistantMessageId`, so a consumer can keep the prompt
    /// and the reply (and consecutive turns) apart.
    fn stamp_run_update(params: &mut Value, run: &mut RunState, created: &str) {
        let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) else {
            return;
        };
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        run.saw_update = true;
        if kind == "agent_message_chunk" {
            run.saw_agent_message = true;
            if let Some(text) = update
                .get("content")
                .and_then(|content| content.get("text"))
                .and_then(Value::as_str)
            {
                if run.agent_text.chars().count() < SNIPPET_CHARS * 2 {
                    run.agent_text.push_str(text);
                }
            }
        }
        let mut distill =
            json!({ "messageId": run.message_id, "runId": run.run_id, "created": created });
        if kind != "user_message_chunk" {
            distill["assistantMessageId"] = json!(run.assistant_message_id);
        }
        let mut meta = update
            .get("_meta")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        meta.insert("distill".to_string(), distill);
        update.insert("_meta".to_string(), Value::Object(meta));
    }

    async fn on_bridge_request(&self, harness: &str, id: Value, method: &str, mut params: Value) {
        if let Some(bridge_session_id) = protocol::session_id(&params) {
            if self.is_naming_session(harness, &bridge_session_id) {
                // Nobody sees a naming session, so nothing it asks for is granted.
                if let Some(bridge) = self.live_bridge(harness).await {
                    let answer = if method == "session/request_permission" {
                        Ok(json!({ "outcome": { "outcome": "cancelled" } }))
                    } else {
                        Err(protocol::error(
                            protocol::METHOD_NOT_FOUND,
                            format!("{method} is not available to a naming session"),
                        ))
                    };
                    bridge.respond(id, answer);
                }
                return;
            }
            if let Some(session_id) = self.host_session_for(harness, &bridge_session_id).await {
                params["sessionId"] = json!(session_id);
            }
        }
        let request_id = self.next_client_request_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut pending) = self.client_requests.lock() {
            pending.insert(
                request_id,
                (harness.to_string(), id.clone(), method.to_string()),
            );
        }
        let has_frontend = self.frontend.lock().map(|f| f.is_some()).unwrap_or(false);
        if !has_frontend {
            // Nobody to ask: cancel the request so the bridge does not hang.
            if let Ok(mut pending) = self.client_requests.lock() {
                pending.remove(&request_id);
            }
            if let Some(bridge) = self.bridges.lock().await.get(harness).cloned() {
                bridge.respond(id, Self::unanswered_client_request(method));
            }
            return;
        }
        self.send_to_frontend(protocol::request(json!(request_id), method, params));
    }

    // -----------------------------------------------------------------------
    // Sessions

    fn is_model_option(option: &Value) -> bool {
        option.get("id").and_then(Value::as_str) == Some("model")
            || option.get("category").and_then(Value::as_str) == Some("model")
    }

    /// Whether the bridge offers `model_id` in the session's own model list.
    fn lists_model(snapshot: &Value, model_id: &str) -> bool {
        let in_models = snapshot
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .is_some_and(|models| models.iter().any(|model| model["modelId"] == model_id));
        Self::option_lists(snapshot, Self::is_model_option, model_id) || in_models
    }

    /// Whether a select config option picked out by `matches` offers `value`.
    fn option_lists(snapshot: &Value, matches: fn(&Value) -> bool, value: &str) -> bool {
        snapshot["configOptions"].as_array().is_some_and(|options| {
            options
                .iter()
                .filter(|option| matches(option))
                .any(|option| {
                    option["options"].as_array().is_some_and(|choices| {
                        choices.iter().any(|choice| choice["value"] == value)
                    })
                })
        })
    }

    fn is_effort_option(option: &Value) -> bool {
        option.get("category").and_then(Value::as_str) == Some("thought_level")
    }

    /// The role `config_id` plays in an option list the bridge itself sent.
    fn option_role(options: &Value, config_id: &str) -> OptionRole {
        let Some(option) = options["configOptions"].as_array().and_then(|options| {
            options
                .iter()
                .find(|option| option.get("id").and_then(Value::as_str) == Some(config_id))
        }) else {
            return OptionRole::Other;
        };
        if Self::is_model_option(option) {
            OptionRole::Model
        } else if Self::is_effort_option(option) {
            OptionRole::Effort
        } else if Self::is_fast_option(option) {
            OptionRole::Fast
        } else {
            OptionRole::Other
        }
    }

    /// The role a write plays, read from the session's live snapshot and, for
    /// a session whose stored snapshot arrived with no options at all (grok's
    /// cold `session/new`), from the bridge's answer to the write itself.
    fn write_role(snapshot: &Value, answer: &Value, config_id: &str) -> OptionRole {
        match Self::option_role(snapshot, config_id) {
            OptionRole::Other => Self::option_role(answer, config_id),
            role => role,
        }
    }

    /// What the options a bridge answered with say the session is now on. This
    /// is the acknowledgement: a bridge silently clamps an effort to the
    /// model's own default (codex) or drops it to `default` (claude), so what
    /// was asked for is never what gets stored.
    fn selection_from(config_options: &Value) -> Selection {
        let Some(options) = config_options.as_array() else {
            return Selection::default();
        };
        let current = |matches: fn(&Value) -> bool| {
            options
                .iter()
                .find(|option| matches(option))
                .and_then(|option| option.get("currentValue"))
        };
        Selection {
            model: current(Self::is_model_option)
                .and_then(Value::as_str)
                .map(str::to_string),
            effort: current(Self::is_effort_option)
                .and_then(Value::as_str)
                .map(str::to_string),
            fast: current(Self::is_fast_option).and_then(Self::fast_enabled),
        }
    }

    /// A config write on its way to the bridge: the client's own request with
    /// nothing but the session id swapped. The option id and the value shape
    /// are the bridge's own and are never rewritten here — the host classifies
    /// a write by role to know what to store, not to rename it.
    fn forwarded_config_write(params: &Value, bridge_session_id: &str) -> Value {
        let mut forwarded = params.clone();
        forwarded["sessionId"] = json!(bridge_session_id);
        forwarded
    }

    /// The session's effort option as one step of `apply_selection` needs it:
    /// the bridge's own id for it, the value it is on, and whether it offers
    /// the one being asked for. `None` where the model has no effort control
    /// at all, which is a different answer and has to stay different.
    fn effort_state(snapshot: &Value, wanted: &str) -> Option<(String, Option<String>, bool)> {
        let option = snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_effort_option(option))?;
        let id = option.get("id").and_then(Value::as_str)?.to_string();
        let current = option
            .get("currentValue")
            .and_then(Value::as_str)
            .map(str::to_string);
        let offers = option["options"]
            .as_array()
            .is_some_and(|choices| choices.iter().any(|choice| choice["value"] == wanted));
        Some((id, current, offers))
    }

    /// The session's fast toggle the same way: its own id, whether it is on,
    /// and whether it takes a native boolean instead of the on/off select both
    /// live bridges send.
    fn fast_state(snapshot: &Value) -> Option<(String, Option<bool>, bool)> {
        let option = snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_fast_option(option))?;
        let id = option.get("id").and_then(Value::as_str)?.to_string();
        let current = option.get("currentValue").and_then(Self::fast_enabled);
        let boolean = option.get("type").and_then(Value::as_str) == Some("boolean");
        Some((id, current, boolean))
    }

    /// The bridge's own id for the model option, for a write that goes out
    /// under it.
    fn model_option_id(snapshot: &Value) -> &str {
        Self::model_option(snapshot)
            .and_then(|option| option.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("model")
    }

    fn fast_word(enabled: bool) -> &'static str {
        if enabled {
            "on"
        } else {
            "off"
        }
    }

    /// Fold a bridge's answer to one write into the session snapshot, so the
    /// next step reads what the bridge said after this one. An answer carrying
    /// no options — or an empty list — states nothing and changes nothing:
    /// `session/set_model` answers that way.
    fn take_options(snapshot: &mut Value, answer: &Value) {
        let stated = answer
            .get("configOptions")
            .filter(|options| options.as_array().is_some_and(|list| !list.is_empty()));
        if let Some(options) = stated {
            snapshot["configOptions"] = options.clone();
        }
    }

    /// Whether a snapshot a bridge just answered with should replace the one
    /// a session was opened with. Only one that states its options does:
    /// grok's cold `session/new` answers with its models and no
    /// `configOptions` key at all, and storing that leaves the chat's effort
    /// control looking unsupported for good. A stored snapshot that states no
    /// options either has nothing to lose, so a bridge that keeps its models
    /// outside the option list still gets through.
    fn replaces_snapshot(fresh: &Value, stored: &Value) -> bool {
        let states_options = |snapshot: &Value| {
            snapshot["configOptions"]
                .as_array()
                .is_some_and(|options| !options.is_empty())
        };
        states_options(fresh) || !states_options(stored)
    }

    /// One selection a bridge would not take as a `_meta.substitutions` entry:
    /// what was asked for, what the session is actually on — `null` where the
    /// model has no such control at all — and why. This is the only
    /// machine-readable record of a downgrade there is: codex clamps an effort
    /// to the target model's own default and claude drops it to `default`,
    /// neither of them saying so anywhere else.
    fn substitution(role: &str, requested: &str, applied: Option<&str>, reason: String) -> Value {
        json!({ "role": role, "requested": requested, "applied": applied, "reason": reason })
    }

    /// A presented snapshot carrying what the bridge would not do. Merged into
    /// `_meta` rather than set, since the callers name the provider there too.
    fn with_substitutions(mut presented: Value, substitutions: &[Value]) -> Value {
        if substitutions.is_empty() {
            return presented;
        }
        let mut meta = presented
            .get("_meta")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        meta.insert("substitutions".to_string(), json!(substitutions));
        presented["_meta"] = Value::Object(meta);
        presented
    }

    /// A fast toggle's value in either shape a bridge sends it: the on/off
    /// select both live bridges use, or the native boolean an ACP client that
    /// advertises the capability would get.
    fn fast_enabled(value: &Value) -> Option<bool> {
        match value {
            Value::Bool(enabled) => Some(*enabled),
            Value::String(text) => match text.as_str() {
                "on" | "true" | "enabled" => Some(true),
                "off" | "false" | "disabled" => Some(false),
                _ => None,
            },
            _ => None,
        }
    }

    /// `gpt-5.6-luna[low]` as the model and effort values a bridge offers in
    /// separate options instead; `None` when its model option offers the id
    /// itself, or does not offer both halves.
    ///
    /// LEGACY TOLERANCE, READ ONLY. Distill no longer names a model this way:
    /// the four selections travel separately and the renderer, the store and
    /// every answer carry the bridge's own base id. What still arrives folded
    /// is history — a chat stored before the split whose lazy conversion has
    /// not run, a renderer or a berdctl client older than protocolVersion 6 —
    /// and it reaches `apply_model` inside a send, where failing is not an
    /// option. SUNSET: this and `SplitModel` may go once no
    /// `sessions.legacy_model_id` rows remain and no pre-protocolVersion-6
    /// berdctl client is in use. Not a date: removing it earlier loses the
    /// operator's own history.
    fn split_effort_model(snapshot: &Value, model_id: &str) -> Option<SplitModel> {
        if Self::option_lists(snapshot, Self::is_model_option, model_id) {
            return None;
        }
        let (model, effort) = model_id.strip_suffix(']')?.split_once('[')?;
        if !Self::option_lists(snapshot, Self::is_model_option, model)
            || !Self::option_lists(snapshot, Self::is_effort_option, effort)
        {
            return None;
        }
        let effort_option = snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_effort_option(option))?
            .get("id")?
            .as_str()?;
        Some(SplitModel {
            model: model.to_string(),
            effort_option: effort_option.to_string(),
            effort: effort.to_string(),
        })
    }

    /// Whether moving a session to `model_id` means reopening its bridge
    /// session on that model: one the harness runs only that way, and not in
    /// the bridge's own list.
    fn opens_on_model(harness_id: &str, snapshot: &Value, model_id: &str) -> bool {
        harness::harness(harness_id)
            .and_then(|spec| harness::session_model_meta(spec, model_id))
            .is_some()
            && !Self::lists_model(snapshot, model_id)
    }

    /// Put a session on a model its bridge runs only when a session is opened
    /// on it: close the bridge session and open it again on that model, which
    /// resumes its history. Refused while a turn runs, since reopening would
    /// cut it off.
    async fn reopen_on_model(
        self: &Arc<Self>,
        session_id: &str,
        model_id: &str,
    ) -> Result<Value, Value> {
        let lock = self.attach_lock(session_id).await;
        let _reopening = lock.lock().await;
        let running = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .is_some_and(|runtime| runtime.run.is_some());
        if running {
            return Err(invalid_params(
                "The model cannot change while a turn is running",
            ));
        }
        if let Some((bridge, bridge_session_id)) = self.attached_route(session_id).await {
            let closed = tokio::time::timeout(
                BRIDGE_CLOSE_TIMEOUT,
                bridge.request("session/close", json!({ "sessionId": bridge_session_id })),
            )
            .await;
            if !matches!(closed, Ok(Ok(_))) {
                log::info!(
                    "[agent-host] session {session_id} did not close cleanly before reopening"
                );
            }
        }
        self.sessions.lock().await.remove(session_id);
        self.store
            .set_model(session_id, Some(model_id))
            .await
            .map_err(protocol::internal)?;
        let record = self.session_record(session_id).await?;
        // The attach opens the new bridge session on the model and puts the
        // chat's effort and fast mode back on it, so the reopen keeps all
        // three rather than only the one that was clicked.
        self.attach_session_locked(&record).await?;
        let sessions = self.sessions.lock().await;
        let runtime = sessions
            .get(session_id)
            .ok_or_else(|| protocol::internal("session vanished"))?;
        Ok(Self::with_substitutions(
            Self::presented_snapshot(&record.harness, &runtime.snapshot, runtime.has_model_option),
            &runtime.substitutions,
        ))
    }

    fn naming_key(harness: &str, bridge_session_id: &str) -> String {
        format!("{harness}\u{0}{bridge_session_id}")
    }

    /// Whether a bridge session is one `summarize_title` has open.
    fn is_naming_session(&self, harness: &str, bridge_session_id: &str) -> bool {
        self.naming_replies.lock().is_ok_and(|replies| {
            replies.contains_key(&Self::naming_key(harness, bridge_session_id))
        })
    }

    fn snapshot_from(result: &Value) -> Value {
        json!({
            "modes": result.get("modes").cloned().unwrap_or(Value::Null),
            "models": result.get("models").cloned().unwrap_or(Value::Null),
            "configOptions": result.get("configOptions").cloned().unwrap_or(Value::Array(vec![])),
        })
    }

    fn has_model_option(snapshot: &Value) -> bool {
        snapshot["configOptions"]
            .as_array()
            .map(|options| {
                options.iter().any(|option| {
                    option.get("id").and_then(Value::as_str) == Some("model")
                        || option.get("category").and_then(Value::as_str) == Some("model")
                })
            })
            .unwrap_or(false)
    }

    /// The model a session is on. The `model` config option's own value comes
    /// first and `models.currentModelId` is only the fallback for a bridge
    /// with no such option: a bridge that keeps both may name the model in its
    /// `models` block with the effort folded in (codex reports
    /// `gpt-6-astra[xhigh]` there while its option says `gpt-6-astra`), and
    /// that folded name is a display id the option itself refuses. Reading it
    /// first is how it used to reach `sessions.model_id`.
    fn current_model(snapshot: &Value) -> Option<String> {
        Self::model_option(snapshot)
            .and_then(|option| option.get("currentValue"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                snapshot
                    .pointer("/models/currentModelId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
    }

    /// The renderer reads the active provider and model out of select config
    /// options. Bridges expose neither a provider option nor (always) a model
    /// option, so synthesize them from what we know.
    ///
    /// Nothing the bridge did state is renamed on the way out: a model is
    /// presented under the id its own bridge gave it, with its effort left in
    /// the effort option where the bridge keeps it. The host used to fold the
    /// two into `gpt-5.6-luna[low]` here, which made an effort click read as a
    /// model change all the way up the stack.
    fn presented_snapshot(harness: &str, snapshot: &Value, has_model_option: bool) -> Value {
        let spec_label = harness::harness(harness)
            .map(|spec| spec.label)
            .unwrap_or(harness);
        let mut options: Vec<Value> = snapshot["configOptions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        options.retain(|option| option.get("id").and_then(Value::as_str) != Some("provider"));
        let provider_option = json!({
            "id": "provider",
            "name": "Agent",
            "category": "provider",
            "type": "select",
            "currentValue": harness,
            "options": [{ "value": harness, "name": spec_label }],
        });
        let mut presented = vec![provider_option];
        if !has_model_option {
            if let Some(models) = snapshot.get("models").filter(|models| !models.is_null()) {
                let current = models.get("currentModelId").cloned().unwrap_or(Value::Null);
                let choices: Vec<Value> = models["availableModels"]
                    .as_array()
                    .map(|list| {
                        list.iter()
                            .map(|model| {
                                json!({
                                    "value": model.get("modelId").cloned().unwrap_or(Value::Null),
                                    "name": model.get("name").cloned().unwrap_or(model.get("modelId").cloned().unwrap_or(Value::Null)),
                                    "description": model.get("description").cloned().unwrap_or(Value::Null),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                presented.push(json!({
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": current,
                    "options": choices,
                }));
            }
        }
        presented.extend(options);
        let mut out = snapshot.clone();
        out["configOptions"] = Value::Array(presented);
        out
    }

    async fn mcp_servers(&self, requested: &Value) -> Vec<Value> {
        let mut servers: Vec<Value> = requested.as_array().cloned().unwrap_or_default();
        match self.store.mcp_list().await {
            Ok(records) => {
                for record in records.into_iter().filter(|record| record.enabled) {
                    if let Some(server) = ext::mcp_server_from_extension(&record.config) {
                        servers.push(server);
                    }
                }
            }
            Err(error) => log::warn!("[agent-host] failed to read MCP servers: {error}"),
        }
        servers
    }

    async fn agent_mode(&self) -> String {
        self.store
            .kv_get("settings", "agentMode")
            .await
            .ok()
            .flatten()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| harness::DEFAULT_AGENT_MODE.to_string())
    }

    async fn apply_mode(&self, bridge: &Bridge, spec: &HarnessSpec, bridge_session_id: &str) {
        let mode = self.agent_mode().await;
        if let Some(bridge_mode) = harness::bridge_mode(spec, &mode) {
            if let Err(error) = bridge
                .request(
                    "session/set_mode",
                    json!({ "sessionId": bridge_session_id, "modeId": bridge_mode }),
                )
                .await
            {
                log::warn!(
                    "[agent-host] failed to set {} mode {bridge_mode}: {}",
                    spec.id,
                    error_text(&error)
                );
            }
        }
    }

    fn meta_string(params: &Value, key: &str) -> Option<String> {
        params
            .pointer(&format!("/_meta/{key}"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// The three model-scoped selections a caller can name when a chat is
    /// created, in the `_meta` of `session/new` — the renderer's pending
    /// selection, or the chat a fork was taken from. Each is optional: a chat
    /// nobody chose for opens on whatever its harness starts with.
    fn wanted_from_meta(params: &Value) -> Selection {
        Selection {
            model: Self::meta_string(params, "model"),
            effort: Self::meta_string(params, "reasoningEffort"),
            fast: params.pointer("/_meta/fastMode").and_then(Value::as_bool),
        }
    }

    async fn new_session(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let harness_id = Self::meta_string(&params, "provider").ok_or_else(|| {
            invalid_params("session/new requires _meta.provider (the agent harness id)")
        })?;
        let spec = harness::harness(&harness_id)
            .ok_or_else(|| invalid_params(format!("Unknown harness {harness_id}")))?;
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| invalid_params("session/new requires cwd"))?;
        let mcp_servers = self.mcp_servers(&params["mcpServers"]).await;
        // A model this harness runs only in a session opened on it decides how
        // the session is opened; every other one is written afterwards.
        let wanted = Self::wanted_from_meta(&params);
        let open_meta = wanted
            .model
            .as_deref()
            .and_then(|model_id| harness::session_model_meta(spec, model_id));
        let (bridge, bridge_session_id, mut snapshot) = self
            .open_bridge_session(spec, &cwd, mcp_servers, open_meta.as_ref())
            .await?;
        let session_id = bridge_session_id.clone();
        let substitutions = self
            .apply_to_session(
                &harness_id,
                &bridge,
                &bridge_session_id,
                &mut snapshot,
                &wanted,
                open_meta.is_some(),
            )
            .await;
        let acknowledged = Self::selection_from(&snapshot["configOptions"]);
        let has_model_option = Self::has_model_option(&snapshot);
        let now = now_iso();
        let record = SessionRecord {
            id: session_id.clone(),
            harness: harness_id.clone(),
            bridge_session_id: Some(bridge_session_id.clone()),
            cwd: cwd.clone(),
            title: None,
            user_set_name: false,
            project_id: Self::meta_string(&params, "projectId"),
            persona_id: Self::meta_string(&params, "personaId"),
            model_id: Self::current_model(&snapshot),
            // Only a choice made for this chat is stored. The effort a fresh
            // session opens on is the harness's own (claude and codex both
            // seed it from the operator's settings file), so a chat nobody
            // chose an effort for keeps none — and what is kept is what the
            // bridge acknowledged, never what was asked for.
            reasoning_effort: wanted.effort.and(acknowledged.effort),
            fast_mode: wanted.fast.and(acknowledged.fast),
            legacy_model_id: None,
            hidden: params
                .pointer("/_meta/hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            created_at: now.clone(),
            updated_at: now,
            last_message_at: None,
            archived_at: None,
            message_count: 0,
            last_snippet: None,
            snapshot: Some(snapshot.clone()),
        };
        if let Err(error) = self.store.insert_session(&record).await {
            // There is no chat to reach it through, so the session the bridge
            // just opened for us is unreachable: hand it back instead of
            // leaving the agent holding it until the process exits.
            bridge.close_session(&bridge_session_id).await;
            return Err(protocol::internal(error));
        }
        self.sessions.lock().await.insert(
            session_id.clone(),
            SessionRuntime {
                harness: harness_id.clone(),
                bridge_session_id,
                generation: bridge.generation(),
                loading: false,
                run: None,
                steer_queue: VecDeque::new(),
                snapshot: snapshot.clone(),
                has_model_option,
                substitutions: substitutions.clone(),
            },
        );
        let mut response = Self::presented_snapshot(&harness_id, &snapshot, has_model_option);
        response["sessionId"] = json!(session_id);
        response["_meta"] = json!({
            "providerId": harness_id,
            "modelId": record.model_id,
            "reasoningEffort": record.reasoning_effort,
            "fastMode": record.fast_mode,
        });
        Ok(Self::with_substitutions(response, &substitutions))
    }

    /// Start a fresh session on `spec`'s bridge in `cwd` with the configured
    /// agent mode applied, opened on a model through `open_meta` where the
    /// harness runs one only that way. Returns the bridge process that
    /// accepted it, the bridge's session id and the snapshot the bridge
    /// answered with.
    async fn open_bridge_session(
        &self,
        spec: &HarnessSpec,
        cwd: &str,
        mcp_servers: Vec<Value>,
        open_meta: Option<&Value>,
    ) -> Result<(Arc<Bridge>, String, Value), Value> {
        let bridge = self.ensure_bridge(spec.id).await?;
        let mut params = json!({ "cwd": cwd, "mcpServers": mcp_servers });
        if let Some(meta) = open_meta {
            params["_meta"] = meta.clone();
        }
        let result = bridge.request("session/new", params).await?;
        let bridge_session_id = protocol::session_id(&result)
            .ok_or_else(|| protocol::internal("bridge returned no sessionId"))?;
        self.apply_mode(&bridge, spec, &bridge_session_id).await;
        Ok((bridge, bridge_session_id, Self::snapshot_from(&result)))
    }

    /// The per-session lock that serializes attaching a session to a bridge
    /// and moving it to another harness.
    async fn attach_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        Arc::clone(
            self.attach_locks
                .lock()
                .await
                .entry(session_id.to_string())
                .or_default(),
        )
    }

    /// Make sure a stored session has a live bridge session behind it,
    /// (re)attaching after a bridge restart or an app restart.
    async fn attach_session(
        self: &Arc<Self>,
        record: &SessionRecord,
    ) -> Result<(Arc<Bridge>, String), Value> {
        let lock = self.attach_lock(&record.id).await;
        let _attaching = lock.lock().await;
        if let Some(attached) = self.attached_route(&record.id).await {
            return Ok(attached);
        }
        // The caller's copy may predate a move to another harness made while
        // it waited for the lock (a delayed background attach, say); attach
        // what the store holds now.
        let current = self.session_record(&record.id).await?;
        self.attach_session_locked(&current).await
    }

    /// The live bridge behind a session, when it is already attached and the
    /// bridge process it was attached to is still the one running. Never
    /// attaches.
    async fn attached_route(&self, session_id: &str) -> Option<(Arc<Bridge>, String)> {
        // Never hold the session map while waiting for the bridge map: the
        // bridge event loop needs the session map for every update it routes.
        let (harness, bridge_session_id, generation) = self.runtime_route(session_id).await?;
        let bridge = self.live_bridge(&harness).await?;
        // A replacement bridge is running: it never accepted this session id,
        // so the session has to be attached again instead of being routed at a
        // process that would answer "unknown session".
        if bridge.generation() != generation {
            return None;
        }
        Some((bridge, bridge_session_id))
    }

    async fn attach_session_locked(
        self: &Arc<Self>,
        record: &SessionRecord,
    ) -> Result<(Arc<Bridge>, String), Value> {
        let spec = harness::harness(&record.harness)
            .ok_or_else(|| invalid_params(format!("Unknown harness {}", record.harness)))?;
        let bridge = self.ensure_bridge(&record.harness).await?;
        let stored_bridge_id = record
            .bridge_session_id
            .clone()
            .unwrap_or_else(|| record.id.clone());
        let snapshot = record
            .snapshot
            .clone()
            .unwrap_or_else(|| Self::snapshot_from(&Value::Null));

        // Register early with `loading` so replayed history from the bridge is
        // swallowed rather than duplicated in the renderer.
        self.sessions.lock().await.insert(
            record.id.clone(),
            SessionRuntime {
                harness: record.harness.clone(),
                bridge_session_id: stored_bridge_id.clone(),
                generation: bridge.generation(),
                loading: true,
                run: None,
                steer_queue: VecDeque::new(),
                snapshot: snapshot.clone(),
                has_model_option: Self::has_model_option(&snapshot),
                substitutions: Vec::new(),
            },
        );
        let attached = self
            .attach_registered_session(record, spec, &bridge, stored_bridge_id, snapshot)
            .await;
        if attached.is_err() {
            // The bridge accepted nothing: leave no runtime behind, or every
            // later call would route at a bridge session it never opened
            // instead of attaching again once the cause is fixed.
            self.sessions.lock().await.remove(&record.id);
        }
        attached
    }

    /// The bridge session an attach is allowed to resume: the one the record
    /// carries, which is either the id the bridge itself gave us or — for a chat
    /// imported from another tool — the agent's own session id.
    ///
    /// `None` means "open a fresh one". That is what
    /// [`Inner::release_bridge_session`] leaves behind: a bridge session runs in
    /// the folder it was created in, so a chat that moved folders must not
    /// resume it, and every bridge that supports `loadSession` but not
    /// `session/close` would happily resume it forever. Falling back to the
    /// host's own session id here (the record's `id`) would do exactly that for
    /// an imported chat, whose two ids are the same.
    fn resumable_bridge_session(record: &SessionRecord) -> Option<&str> {
        record
            .bridge_session_id
            .as_deref()
            .filter(|id| !id.is_empty())
    }

    /// The bridge round trips of an attach, for a session already registered
    /// as loading: resume the stored bridge session (or open a fresh one),
    /// apply the mode and model, and only then make the runtime routable.
    async fn attach_registered_session(
        self: &Arc<Self>,
        record: &SessionRecord,
        spec: &HarnessSpec,
        bridge: &Arc<Bridge>,
        stored_bridge_id: String,
        mut snapshot: Value,
    ) -> Result<(Arc<Bridge>, String), Value> {
        let mcp_servers = self.mcp_servers(&Value::Null).await;
        let mut bridge_session_id = stored_bridge_id.clone();
        let mut resumed = false;
        // A model the bridge runs only when a session is opened on it.
        let open_meta = record
            .model_id
            .as_deref()
            .and_then(|model_id| harness::session_model_meta(spec, model_id));
        if let Some(resume_id) = Self::resumable_bridge_session(record)
            .filter(|_| bridge.supports_load_session())
            .map(str::to_string)
        {
            let mut load =
                json!({ "sessionId": resume_id, "cwd": record.cwd, "mcpServers": mcp_servers });
            if let Some(meta) = &open_meta {
                load["_meta"] = meta.clone();
            }
            match bridge.request("session/load", load).await {
                Ok(result) => {
                    resumed = true;
                    let loaded = Self::snapshot_from(&result);
                    if Self::replaces_snapshot(&loaded, &snapshot) {
                        snapshot = loaded;
                    }
                }
                Err(error) => log::warn!(
                    "[agent-host] {} could not resume session {}: {}",
                    record.harness,
                    record.id,
                    error_text(&error)
                ),
            }
        }
        if !resumed {
            let mut open = json!({ "cwd": record.cwd, "mcpServers": mcp_servers });
            if let Some(meta) = &open_meta {
                open["_meta"] = meta.clone();
            }
            let result = bridge.request("session/new", open).await?;
            bridge_session_id = protocol::session_id(&result)
                .ok_or_else(|| protocol::internal("bridge returned no sessionId"))?;
            let fresh = Self::snapshot_from(&result);
            if Self::replaces_snapshot(&fresh, &snapshot) {
                snapshot = fresh;
            }
            if let Err(error) = self
                .store
                .set_bridge_session_id(&record.id, Some(bridge_session_id.as_str()))
                .await
            {
                log::warn!("[agent-host] failed to record bridge session id: {error}");
            }
        }
        self.apply_mode(bridge, spec, &bridge_session_id).await;
        // Mode, then model, then the two knobs that belong to the model — the
        // whole selection again, every time the chat wakes. No bridge keeps it
        // across a resume: claude re-seeds the effort from the operator's
        // settings file and loses it altogether after a model with none, codex
        // clamps it to the model's own default. What a model will not take is
        // recorded and left alone; the stored intent stands, so the next model
        // that offers it gets it back.
        let wanted = Selection {
            model: record.model_id.clone(),
            effort: record.reasoning_effort.clone(),
            fast: record.fast_mode,
        };
        let substitutions = self
            .apply_to_session(
                &record.harness,
                bridge,
                &bridge_session_id,
                &mut snapshot,
                &wanted,
                open_meta.is_some(),
            )
            .await;
        let has_model_option = Self::has_model_option(&snapshot);
        let _ = self.store.set_snapshot(&record.id, &snapshot).await;
        // Everything the bridge replayed for this session is already in the
        // event queue; let the loop swallow it all before the session is live,
        // or its tail would be appended to the transcript a second time.
        self.drain_bridge_events().await;
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.get_mut(&record.id) {
                runtime.bridge_session_id = bridge_session_id.clone();
                runtime.loading = false;
                runtime.snapshot = snapshot;
                runtime.has_model_option = has_model_option;
                runtime.substitutions = substitutions;
            }
        }
        Ok((Arc::clone(bridge), bridge_session_id))
    }

    async fn load_session(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let mut record = self.session_record(&session_id).await?;
        if let Some(cwd) = params.get("cwd").and_then(Value::as_str) {
            if !cwd.is_empty() && cwd != "~" && cwd != record.cwd {
                let _ = self.store.set_cwd(&session_id, cwd).await;
                record.cwd = cwd.to_string();
                // The bridge session it may still be attached to was created
                // in the old folder and cannot move; stop using it so the
                // background attach below opens one in the new folder.
                self.release_bridge_session(&session_id).await;
            }
        }
        // The transcript is ours: replay it from the local log and answer
        // right away. Waking the agent behind the session (spawning its
        // bridge, resuming its own context) is only needed for the next
        // prompt, so it happens in the background — the user may just read
        // the chat and never send anything.
        //
        // The log is read, so the event loop's own buffer has to be committed
        // first: a chat that is streaming right now has its last chunks there,
        // and replaying without them would show a transcript missing its tail.
        self.drain_bridge_events().await;
        let events = self
            .store
            .list_event_payloads(&session_id)
            .await
            .map_err(protocol::internal)?;
        for payload in events {
            self.send_to_frontend(protocol::raw_notification("session/update", &payload));
        }
        let attached = self.attached_route(&session_id).await.is_some();
        let (snapshot, has_model_option, substitutions) =
            match self.runtime_snapshot(&session_id).await {
                Some(live) if attached => live,
                _ => {
                    let stored = record
                        .snapshot
                        .clone()
                        .unwrap_or_else(|| Self::snapshot_from(&Value::Null));
                    let has_model_option = Self::has_model_option(&stored);
                    (stored, has_model_option, Vec::new())
                }
            };
        let mut response = Self::presented_snapshot(&record.harness, &snapshot, has_model_option);
        response["_meta"] = json!({ "providerId": record.harness });
        let response = Self::with_substitutions(response, &substitutions);
        if let Ok(mut last) = self.last_loaded.lock() {
            *last = Some(session_id.clone());
        }
        if !attached {
            let host = Arc::clone(self);
            let presented = response["configOptions"].clone();
            tokio::spawn(async move {
                tokio::time::sleep(BACKGROUND_ATTACH_DELAY).await;
                let still_current = host
                    .last_loaded
                    .lock()
                    .map(|last| last.as_deref() == Some(record.id.as_str()))
                    .unwrap_or(false);
                if still_current {
                    host.attach_in_background(record, presented).await;
                }
            });
        }
        Ok(response)
    }

    /// A live session's snapshot, whether its bridge names its models in an
    /// option of its own, and what that bridge would not do when the session
    /// was last put on its selections.
    async fn runtime_snapshot(&self, session_id: &str) -> Option<(Value, bool, Vec<Value>)> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).map(|runtime| {
            (
                runtime.snapshot.clone(),
                runtime.has_model_option,
                runtime.substitutions.clone(),
            )
        })
    }

    /// Wake the agent behind a session after `session/load` has already
    /// answered from the local log. When the bridge reports different config
    /// options than the stored snapshot the chat was opened with, the
    /// renderer gets the live ones as a `config_option_update`.
    async fn attach_in_background(self: Arc<Self>, record: SessionRecord, presented_before: Value) {
        if let Err(error) = self.attach_session(&record).await {
            log::warn!(
                "[agent-host] background attach of session {} to {} failed: {}",
                record.id,
                record.harness,
                error_text(&error)
            );
            return;
        }
        let Some((harness, _, _)) = self.runtime_route(&record.id).await else {
            return;
        };
        let Some((snapshot, has_model_option, substitutions)) =
            self.runtime_snapshot(&record.id).await
        else {
            return;
        };
        let presented = Self::presented_snapshot(&harness, &snapshot, has_model_option);
        if presented["configOptions"] == presented_before && substitutions.is_empty() {
            return;
        }
        // The attach happened with nobody watching, so this notification is
        // the only way a value the agent would not take reaches the screen.
        let mut update = json!({
            "sessionUpdate": "config_option_update",
            "configOptions": presented["configOptions"],
        });
        if !substitutions.is_empty() {
            update["_meta"] = json!({ "substitutions": substitutions });
        }
        self.notify_frontend(
            "session/update",
            json!({ "sessionId": record.id, "update": update }),
        );
    }

    pub fn session_info(record: &SessionRecord, active_run_id: Option<&str>) -> Value {
        json!({
            "sessionId": record.id,
            "cwd": record.cwd,
            "title": record.title,
            "updatedAt": record.updated_at,
            "_meta": {
                "createdAt": record.created_at,
                "lastMessageAt": record.last_message_at,
                "archivedAt": record.archived_at,
                "userSetName": record.user_set_name,
                "messageCount": record.message_count,
                "lastMessageSnippet": record.last_snippet,
                "projectId": record.project_id,
                "providerId": record.harness,
                "modelId": record.model_id,
                // The two knobs that belong to the model, so a chat the
                // operator has not opened still reports what it runs at.
                "reasoningEffort": record.reasoning_effort,
                "fastMode": record.fast_mode,
                "personaId": record.persona_id,
                "activeRunId": active_run_id,
            }
        })
    }

    pub async fn active_run_id(&self, session_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .and_then(|runtime| runtime.run.as_ref().map(|run| run.run_id.clone()))
    }

    async fn list_sessions(&self, params: Value) -> Result<Value, Value> {
        let offset: i64 = params
            .get("cursor")
            .and_then(Value::as_str)
            .and_then(|cursor| cursor.parse().ok())
            .unwrap_or(0);
        let records = self
            .store
            .list_sessions(offset, SESSION_PAGE_SIZE)
            .await
            .map_err(protocol::internal)?;
        let next_cursor = if records.len() as i64 == SESSION_PAGE_SIZE {
            Some((offset + SESSION_PAGE_SIZE).to_string())
        } else {
            None
        };
        let mut sessions = Vec::with_capacity(records.len());
        for record in &records {
            let active = self.active_run_id(&record.id).await;
            sessions.push(Self::session_info(record, active.as_deref()));
        }
        Ok(json!({ "sessions": sessions, "nextCursor": next_cursor }))
    }

    async fn delete_session(&self, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        // Tell the agent first: forgetting the runtime does not stop the turn,
        // and a bridge session nobody will ever talk to again keeps its agent
        // context (and whatever it is doing) alive until the process exits.
        let attached = self.attached_route(&session_id).await;
        self.sessions.lock().await.remove(&session_id);
        self.attach_locks.lock().await.remove(&session_id);
        if let Some((bridge, bridge_session_id)) = attached {
            bridge.notify(
                "session/cancel",
                json!({ "sessionId": bridge_session_id.clone() }),
            );
            Self::close_in_background(bridge, bridge_session_id);
        }
        self.store
            .delete_session(&session_id)
            .await
            .map_err(protocol::internal)?;
        Ok(json!({}))
    }

    /// Cancel and hand back a bridge session nobody will talk to again, so the
    /// agent stops holding its context and whatever it was doing. Best effort:
    /// a bridge without `session/close` keeps it until the process exits.
    async fn let_go_of(&self, runtime: &SessionRuntime) {
        let Some(bridge) = self.live_bridge(&runtime.harness).await else {
            return;
        };
        if bridge.generation() != runtime.generation {
            return;
        }
        bridge.notify(
            "session/cancel",
            json!({ "sessionId": runtime.bridge_session_id.clone() }),
        );
        Self::close_in_background(bridge, runtime.bridge_session_id.clone());
    }

    /// Hand a bridge session back without waiting for the answer. The callers
    /// are on the renderer's request path — deleting a chat, moving one to
    /// another folder — and the host has already stopped using the session:
    /// nothing the bridge could say changes what happens next, so a bridge that
    /// takes the request and goes quiet must not delay the user's action.
    fn close_in_background(bridge: Arc<Bridge>, bridge_session_id: String) {
        tokio::spawn(async move {
            bridge.close_session(&bridge_session_id).await;
        });
    }

    /// Stop using a session's bridge session, so the next prompt attaches a
    /// fresh one. A bridge session's working directory is fixed when the bridge
    /// creates it, so this is the only way a chat that moved folders runs in
    /// the new one. Refuses (returns `false`) while a turn is running or an
    /// attach is in flight: dropping the runtime then would strand that turn's
    /// updates, which `host_session_for` routes through it.
    ///
    /// The stored id is cleared too, not just the runtime. Without that the next
    /// attach reads the id straight back out of the row and resumes the same
    /// bridge session — which, for a bridge that supports `loadSession` but not
    /// `session/close` (every bridge shipped today), is still alive in the old
    /// folder, so the chat would keep running there.
    pub async fn release_bridge_session(&self, session_id: &str) -> bool {
        let released = {
            let mut sessions = self.sessions.lock().await;
            let busy = sessions
                .get(session_id)
                .is_some_and(|runtime| runtime.loading || runtime.run.is_some());
            if busy {
                None
            } else {
                sessions.remove(session_id)
            }
        };
        let Some(runtime) = released else {
            return false;
        };
        self.let_go_of(&runtime).await;
        if let Err(error) = self.store.set_bridge_session_id(session_id, None).await {
            log::warn!("[agent-host] failed to forget the bridge session of {session_id}: {error}");
        }
        true
    }

    /// The `session/new _meta` a fork opens on: everything about the chat it
    /// was taken from that a new session can be given. All four selections
    /// travel, so a fork runs what its source ran instead of starting over on
    /// the bridge's own default.
    fn fork_meta(record: &SessionRecord) -> Value {
        let mut meta = json!({ "provider": record.harness });
        if let Some(project_id) = &record.project_id {
            meta["projectId"] = json!(project_id);
        }
        if let Some(persona_id) = &record.persona_id {
            meta["personaId"] = json!(persona_id);
        }
        if let Some(model_id) = &record.model_id {
            meta["model"] = json!(model_id);
        }
        if let Some(effort) = &record.reasoning_effort {
            meta["reasoningEffort"] = json!(effort);
        }
        if let Some(fast) = record.fast_mode {
            meta["fastMode"] = json!(fast);
        }
        meta
    }

    async fn fork_session(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let record = self.session_record(&session_id).await?;
        let meta = Self::fork_meta(&record);
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty() && *cwd != "~")
            .unwrap_or(&record.cwd)
            .to_string();
        let created = self
            .new_session(json!({ "cwd": cwd, "mcpServers": [], "_meta": meta }))
            .await?;
        let new_id = protocol::session_id(&created)
            .ok_or_else(|| protocol::internal("fork produced no session"))?;
        // "Fork from this message": the renderer sends the Unix second the
        // copy must stop before.
        let before = params
            .pointer("/_meta/conversationBefore")
            .and_then(Value::as_i64);
        self.store
            .copy_events(&session_id, &new_id, before)
            .await
            .map_err(protocol::internal)?;
        if let Some(title) = &record.title {
            let _ = self
                .store
                .set_title(&new_id, title, record.user_set_name)
                .await;
        }
        let _ = self
            .store
            .touch(
                &new_id,
                record.message_count,
                record.last_snippet.as_deref(),
            )
            .await;
        Ok(created)
    }

    async fn forward(self: &Arc<Self>, method: &str, mut params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let record = self.session_record(&session_id).await?;
        let (bridge, bridge_session_id) = self.attach_session(&record).await?;
        params["sessionId"] = json!(bridge_session_id);
        let mut result = bridge.request(method, params).await?;
        if let Some(object) = result.as_object_mut() {
            if object.contains_key("sessionId") {
                object.insert("sessionId".to_string(), json!(session_id));
            }
        }
        Ok(result)
    }

    /// What putting a bridge session on `model_id` takes (see `apply_model`),
    /// decided from the options the bridge last stated and nothing else.
    fn model_write(snapshot: &Value, model_id: &str) -> ModelWrite {
        if !Self::has_model_option(snapshot) {
            return ModelWrite::SetModel;
        }
        match Self::split_effort_model(snapshot, model_id) {
            Some(split) => ModelWrite::Folded(split),
            None => ModelWrite::ConfigOption {
                config_id: Self::model_option_id(snapshot).to_string(),
                model: model_id.to_string(),
            },
        }
    }

    /// Put a bridge session on `model_id`: one `set_config_option` under the
    /// bridge's own model option id, carrying the bridge's own model id.
    ///
    /// The other two arms are for what the ACP bridges are, not for what
    /// Distill sends. A bridge with no model option takes the older
    /// `session/set_model` — and only such a bridge may: codex's
    /// `unstable_setSessionModel` insists on `model[effort]` and throws on a
    /// base id, which is why that arm is behind `has_model_option` rather than
    /// behind a per-harness rule. A folded id is legacy inbound tolerance
    /// (`split_effort_model`): it arrives from history, never from us, and is
    /// sent as the two values the bridge actually keeps.
    async fn apply_model(
        &self,
        bridge: &Bridge,
        bridge_session_id: &str,
        model_id: &str,
        snapshot: &Value,
    ) -> Result<Value, Value> {
        match Self::model_write(snapshot, model_id) {
            ModelWrite::SetModel => {
                bridge
                    .request(
                        "session/set_model",
                        json!({ "sessionId": bridge_session_id, "modelId": model_id }),
                    )
                    .await
            }
            ModelWrite::ConfigOption { config_id, model } => {
                bridge
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId": bridge_session_id,
                            "configId": config_id,
                            "value": model,
                        }),
                    )
                    .await
            }
            ModelWrite::Folded(split) => {
                bridge
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId": bridge_session_id,
                            "configId": Self::model_option_id(snapshot),
                            "value": split.model,
                        }),
                    )
                    .await?;
                bridge
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId": bridge_session_id,
                            "configId": split.effort_option,
                            "value": split.effort,
                        }),
                    )
                    .await
            }
        }
    }

    /// Put a bridge session on the model, effort and fast mode a chat is meant
    /// to run with (see `apply_selection`), routing the model step through
    /// `apply_model` so a bridge with no model option — and a stored id that
    /// still folds an effort into a model's name — are both still served.
    async fn apply_to_session(
        &self,
        harness_id: &str,
        bridge: &Arc<Bridge>,
        bridge_session_id: &str,
        snapshot: &mut Value,
        wanted: &Selection,
        assert_model: bool,
    ) -> Vec<Value> {
        // The model is always the first step, so `apply_model` reads the
        // session exactly as the bridge last described it.
        let opening = Arc::new(snapshot.clone());
        Self::apply_selection(
            harness_id,
            snapshot,
            wanted,
            assert_model,
            |role, request| {
                let host = self;
                let bridge = Arc::clone(bridge);
                let session = bridge_session_id.to_string();
                let opening = Arc::clone(&opening);
                async move {
                    match role {
                        OptionRole::Model => {
                            let model_id = request["value"].as_str().unwrap_or_default();
                            host.apply_model(&bridge, &session, model_id, &opening)
                                .await
                        }
                        _ => {
                            let mut params = request;
                            params["sessionId"] = json!(session);
                            bridge.request("session/set_config_option", params).await
                        }
                    }
                }
            },
        )
        .await
    }

    /// Put a session on the model, effort and fast mode a chat is meant to run
    /// with, in the only order that works: the model first, then the two knobs
    /// that belong to it. A step is skipped unless the options the bridge
    /// answered the previous one with advertise that option and list that
    /// value, and every answer is folded into `snapshot`, so each step reads
    /// what the bridge said after the one before it.
    ///
    /// Nothing here fails. A bridge that refuses one of the three is recorded
    /// in the returned `_meta.substitutions` entries and the sequence carries
    /// on: an attach must never fall over because a model stopped offering an
    /// effort level, and the chat's stored intent stays as it is so the next
    /// model that offers it gets it back.
    ///
    /// `write` sends one option write and answers with the bridge's own option
    /// list, under the bridge's own option id — the host classifies a write by
    /// role to know what it means, never to rename it.
    async fn apply_selection<W, WFut>(
        harness_id: &str,
        snapshot: &mut Value,
        wanted: &Selection,
        assert_model: bool,
        mut write: W,
    ) -> Vec<Value>
    where
        W: FnMut(OptionRole, Value) -> WFut,
        WFut: std::future::Future<Output = Result<Value, Value>>,
    {
        let mut substitutions = Vec::new();
        if let Some(model_id) = wanted.model.as_deref() {
            // A model the harness runs only in a session opened on it is
            // asserted even where the bridge lists no such value:
            // claude-agent-acp answers `session/new` with
            // `_meta.claudeCode.options.model` still reporting `default`, and
            // until the assert its effort and fast options describe that alias
            // instead — which is how Opus 4.6 came to advertise an `xhigh` it
            // does not have and a fast toggle it does not offer.
            let offered = assert_model || Self::lists_model(snapshot, model_id);
            if Self::current_model(snapshot).as_deref() != Some(model_id) {
                if offered {
                    let request =
                        json!({ "configId": Self::model_option_id(snapshot), "value": model_id });
                    match write(OptionRole::Model, request).await {
                        Ok(answer) => {
                            Self::take_options(snapshot, &answer);
                            // A bridge that also lists models reports the
                            // chosen one there and answers the write itself
                            // with nothing.
                            if let Some(models) =
                                snapshot.get_mut("models").and_then(Value::as_object_mut)
                            {
                                models.insert("currentModelId".to_string(), json!(model_id));
                            }
                            let applied = Self::current_model(snapshot);
                            // A stored id that still folds an effort into the
                            // model's name is applied as the two halves its
                            // bridge keeps apart (legacy inbound only — see
                            // `split_effort_model`), and the bridge names the
                            // model half back. That is the model that was
                            // asked for, not one substituted for it.
                            let asked = Self::split_effort_model(snapshot, model_id)
                                .map(|split| split.model)
                                .unwrap_or_else(|| model_id.to_string());
                            if applied.as_deref() != Some(asked.as_str()) {
                                substitutions.push(Self::substitution(
                                    "model",
                                    model_id,
                                    applied.as_deref(),
                                    format!("not offered by {harness_id}"),
                                ));
                            }
                        }
                        Err(error) => {
                            let reason = error_text(&error);
                            log::info!(
                                "[agent-host] {harness_id} would not run {model_id}: {reason}"
                            );
                            substitutions.push(Self::substitution(
                                "model",
                                model_id,
                                Self::current_model(snapshot).as_deref(),
                                reason,
                            ));
                        }
                    }
                } else {
                    substitutions.push(Self::substitution(
                        "model",
                        model_id,
                        Self::current_model(snapshot).as_deref(),
                        format!("not offered by {harness_id}"),
                    ));
                }
            }
        }
        // The model the remaining two belong to, as it is now: both are its
        // own, and a model that does not offer one is what the entry names.
        let model = Self::current_model(snapshot).unwrap_or_else(|| harness_id.to_string());
        if let Some(effort) = wanted.effort.as_deref() {
            match Self::effort_state(snapshot, effort) {
                // The model has no effort control at all (claude on haiku).
                None => substitutions.push(Self::substitution(
                    "effort",
                    effort,
                    None,
                    format!("{model} has no effort control"),
                )),
                Some((_, current, _)) if current.as_deref() == Some(effort) => {}
                Some((_, current, false)) => substitutions.push(Self::substitution(
                    "effort",
                    effort,
                    current.as_deref(),
                    format!("not offered by {model}"),
                )),
                Some((config_id, _, true)) => {
                    let request = json!({ "configId": config_id, "value": effort });
                    match write(OptionRole::Effort, request).await {
                        Ok(answer) => {
                            Self::take_options(snapshot, &answer);
                            let applied = Self::effort_state(snapshot, effort)
                                .and_then(|(_, current, _)| current);
                            if applied.as_deref() != Some(effort) {
                                substitutions.push(Self::substitution(
                                    "effort",
                                    effort,
                                    applied.as_deref(),
                                    format!("not offered by {model}"),
                                ));
                            }
                        }
                        Err(error) => {
                            let reason = error_text(&error);
                            log::info!("[agent-host] {harness_id} kept its effort: {reason}");
                            substitutions.push(Self::substitution("effort", effort, None, reason));
                        }
                    }
                }
            }
        }
        if let Some(fast) = wanted.fast {
            match Self::fast_state(snapshot) {
                // Writing a fast toggle a model does not have answers
                // "Unknown config option: fast"; the intent survives for the
                // next model that offers one.
                None => substitutions.push(Self::substitution(
                    "fast",
                    Self::fast_word(fast),
                    None,
                    format!("{model} has no fast mode"),
                )),
                Some((_, current, _)) if current == Some(fast) => {}
                Some((config_id, _, boolean)) => {
                    let request = if boolean {
                        // The ACP boolean arm is a discriminated union and is
                        // rejected without its `type`.
                        json!({ "configId": config_id, "value": fast, "type": "boolean" })
                    } else {
                        json!({ "configId": config_id, "value": Self::fast_word(fast) })
                    };
                    match write(OptionRole::Fast, request).await {
                        Ok(answer) => {
                            Self::take_options(snapshot, &answer);
                            let applied = Self::fast_state(snapshot).and_then(|(_, on, _)| on);
                            if applied != Some(fast) {
                                substitutions.push(Self::substitution(
                                    "fast",
                                    Self::fast_word(fast),
                                    applied.map(Self::fast_word),
                                    format!("not offered by {model}"),
                                ));
                            }
                        }
                        Err(error) => {
                            let reason = error_text(&error);
                            log::info!("[agent-host] {harness_id} kept its fast mode: {reason}");
                            substitutions.push(Self::substitution(
                                "fast",
                                Self::fast_word(fast),
                                None,
                                reason,
                            ));
                        }
                    }
                }
            }
        }
        substitutions
    }

    /// What a bridge did differently from what was asked of it, read off one
    /// answer rather than a sequence: an entry per selection whose read-back
    /// value is not the requested one, with `applied: null` where the model
    /// turned out to have no such control. Only ever called with an answer
    /// that stated its options — one that states none teaches nothing and
    /// must not read as a refusal.
    fn substitutions_for(wanted: &Selection, applied: &Selection) -> Vec<Value> {
        let model = applied.model.clone().or_else(|| wanted.model.clone());
        let named = model.as_deref().unwrap_or("the model");
        let mut out = Vec::new();
        if let Some(requested) = wanted.model.as_deref() {
            if let Some(got) = applied.model.as_deref().filter(|got| *got != requested) {
                out.push(Self::substitution(
                    "model",
                    requested,
                    Some(got),
                    format!("the agent is on {got}"),
                ));
            }
        }
        if let Some(requested) = wanted.effort.as_deref() {
            if applied.effort.as_deref() != Some(requested) {
                let reason = match applied.effort {
                    Some(_) => format!("not offered by {named}"),
                    None => format!("{named} has no effort control"),
                };
                out.push(Self::substitution(
                    "effort",
                    requested,
                    applied.effort.as_deref(),
                    reason,
                ));
            }
        }
        if let Some(requested) = wanted.fast {
            if applied.fast != Some(requested) {
                let reason = match applied.fast {
                    Some(_) => format!("not offered by {named}"),
                    None => format!("{named} has no fast mode"),
                };
                out.push(Self::substitution(
                    "fast",
                    Self::fast_word(requested),
                    applied.fast.map(Self::fast_word),
                    reason,
                ));
            }
        }
        out
    }

    async fn set_config_option(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let config_id = params
            .get("configId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let record = self.session_record(&session_id).await?;
        if config_id == "provider" {
            let requested = params.get("value").and_then(Value::as_str).unwrap_or("");
            if requested != record.harness {
                return self.move_to_harness(&session_id, requested).await;
            }
        }
        let (bridge, bridge_session_id) = self.attach_session(&record).await?;
        let (mut snapshot, has_model_option, standing) = {
            let sessions = self.sessions.lock().await;
            let runtime = sessions
                .get(&session_id)
                .ok_or_else(|| protocol::internal("session vanished"))?;
            (
                runtime.snapshot.clone(),
                runtime.has_model_option,
                runtime.substitutions.clone(),
            )
        };
        // What this write turned out to mean, when it meant one of the three
        // selections at all. A write about something else — a mode, an agent —
        // says nothing about them, so what a model would not do before it
        // still stands.
        let mut written: Option<Vec<Value>> = None;
        match config_id.as_str() {
            // Already on the requested harness (a move returned above).
            "provider" => {}
            "model" => {
                let model_id = params
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if Self::opens_on_model(&record.harness, &snapshot, &model_id) {
                    return self.reopen_on_model(&session_id, &model_id).await;
                }
                let result = self
                    .apply_model(&bridge, &bridge_session_id, &model_id, &snapshot)
                    .await?;
                if has_model_option {
                    if let Some(options) = result.get("configOptions") {
                        snapshot["configOptions"] = options.clone();
                    }
                }
                // A bridge that also lists models reports the chosen id there.
                if let Some(models) = snapshot.get_mut("models").and_then(Value::as_object_mut) {
                    models.insert("currentModelId".to_string(), json!(model_id));
                }
                // A model change moves the other two knobs with it: codex
                // clamps the effort to the new model's default and claude
                // drops it to `default`, both without saying so. Store what
                // the bridge answered, not what was asked for.
                let acknowledged = Self::selection_from(&result["configOptions"]);
                let _ = self
                    .store
                    .set_model(
                        &session_id,
                        Some(acknowledged.model.as_deref().unwrap_or(&model_id)),
                    )
                    .await;
                if result.get("configOptions").is_some() {
                    let _ = self
                        .store
                        .set_run_settings(
                            &session_id,
                            acknowledged.effort.as_deref(),
                            acknowledged.fast,
                        )
                        .await;
                    // What the chat was running at is what it asked to keep;
                    // the host does not write it back — putting a downgraded
                    // value where a model offers one again is the renderer's
                    // to decide — but a downgrade nobody is told about is how
                    // a chat quietly drops from xhigh to medium.
                    let wanted = Selection {
                        model: Some(model_id),
                        effort: record.reasoning_effort.clone(),
                        fast: record.fast_mode,
                    };
                    written = Some(Self::substitutions_for(&wanted, &acknowledged));
                }
            }
            _ => {
                let result = bridge
                    .request(
                        "session/set_config_option",
                        Self::forwarded_config_write(&params, &bridge_session_id),
                    )
                    .await?;
                let role = Self::write_role(&snapshot, &result, &config_id);
                // The write went out under the bridge's own id and value
                // shape; only what it means to this session is ours. An answer
                // with no options at all states nothing, so nothing moves.
                if let Some(options) = result.get("configOptions") {
                    let acknowledged = Self::selection_from(options);
                    snapshot["configOptions"] = options.clone();
                    // A bridge answers a write it cannot honour with the value
                    // it kept, not with an error.
                    let requested = params.get("value").unwrap_or(&Value::Null);
                    let stored = match role {
                        OptionRole::Effort => {
                            let wanted = Selection {
                                effort: requested.as_str().map(str::to_string),
                                ..Selection::default()
                            };
                            written = Some(Self::substitutions_for(&wanted, &acknowledged));
                            self.store
                                .set_reasoning_effort(&session_id, acknowledged.effort.as_deref())
                                .await
                        }
                        OptionRole::Fast => {
                            let wanted = Selection {
                                fast: Self::fast_enabled(requested),
                                ..Selection::default()
                            };
                            written = Some(Self::substitutions_for(&wanted, &acknowledged));
                            self.store
                                .set_fast_mode(&session_id, acknowledged.fast)
                                .await
                        }
                        // A harness naming its model option something other
                        // than `model` (none of the three live ones do).
                        OptionRole::Model => match acknowledged.model.as_deref() {
                            Some(model_id) => {
                                self.store.set_model(&session_id, Some(model_id)).await
                            }
                            None => Ok(()),
                        },
                        // A mode, an agent, a verbosity: none of the three, so
                        // what a model would not do still stands.
                        OptionRole::Other => Ok(()),
                    };
                    if let Err(error) = stored {
                        log::warn!("[agent-host] failed to store a session selection: {error}");
                    }
                }
            }
        }
        let substitutions = written.unwrap_or(standing);
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.get_mut(&session_id) {
                runtime.snapshot = snapshot.clone();
                // The last word on this session, so a chat reopened later is
                // told the same thing — and a write the bridge did honour
                // clears a notice left by one it did not.
                runtime.substitutions = substitutions.clone();
            }
        }
        let _ = self.store.set_snapshot(&session_id, &snapshot).await;
        Ok(Self::with_substitutions(
            Self::presented_snapshot(&record.harness, &snapshot, has_model_option),
            &substitutions,
        ))
    }

    /// Put a session on another harness — the "provider" option. That is
    /// only possible before its first message: from then on the
    /// conversation lives in the agent's own context, which cannot follow
    /// the chat to a different agent, so a started chat keeps its harness
    /// and a new chat is the way to another one. The new bridge session is
    /// opened before anything is changed, so a failure leaves the session
    /// on the harness it had.
    async fn move_to_harness(
        self: &Arc<Self>,
        session_id: &str,
        harness_id: &str,
    ) -> Result<Value, Value> {
        let spec = harness::harness(harness_id)
            .ok_or_else(|| invalid_params(format!("Unknown harness {harness_id}")))?;
        let lock = self.attach_lock(session_id).await;
        let _moving = lock.lock().await;
        let record = self.session_record(session_id).await?;
        let started = || {
            invalid_params(format!(
                "Session {session_id} already has messages on {}; start a new chat to use {harness_id}",
                record.harness
            ))
        };
        if record.message_count > 0 || self.active_run_id(session_id).await.is_some() {
            return Err(started());
        }
        let mcp_servers = self.mcp_servers(&Value::Null).await;
        let (bridge, bridge_session_id, snapshot) = self
            .open_bridge_session(spec, &record.cwd, mcp_servers, None)
            .await?;
        let model_id = Self::current_model(&snapshot);
        // The store re-checks "no message yet" in the same statement, so a
        // first prompt that slipped in meanwhile keeps the session where it is.
        if !self
            .store
            .rebind_unstarted_session(
                session_id,
                harness_id,
                &bridge_session_id,
                model_id.as_deref(),
                &snapshot,
            )
            .await
            .map_err(protocol::internal)?
        {
            // The move was refused: the session we just opened on the new
            // harness is never going to be used, so hand it back.
            bridge.close_session(&bridge_session_id).await;
            return Err(started());
        }
        // The effort and the fast toggle stay behind with the harness that
        // named them: another one has its own vocabulary for the first and may
        // have no such control at all for the second, and the chat is now on a
        // model neither belonged to.
        if let Err(error) = self.store.set_run_settings(session_id, None, None).await {
            log::warn!("[agent-host] failed to clear the moved session's run settings: {error}");
        }
        // The session it used to be is nobody's any more: cancel and close it
        // so the old agent stops holding its context.
        let previously = self.sessions.lock().await.remove(session_id);
        if let Some(previously) = previously {
            self.let_go_of(&previously).await;
        }
        let has_model_option = Self::has_model_option(&snapshot);
        self.sessions.lock().await.insert(
            session_id.to_string(),
            SessionRuntime {
                harness: harness_id.to_string(),
                bridge_session_id,
                generation: bridge.generation(),
                loading: false,
                run: None,
                steer_queue: VecDeque::new(),
                snapshot: snapshot.clone(),
                has_model_option,
                substitutions: Vec::new(),
            },
        );
        log::info!(
            "[agent-host] session {session_id} moved from {} to {harness_id} before its first message",
            record.harness
        );
        Ok(Self::presented_snapshot(
            harness_id,
            &snapshot,
            has_model_option,
        ))
    }

    fn snippet(text: &str) -> Option<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        let collapsed: String = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
        Some(collapsed.chars().take(SNIPPET_CHARS).collect())
    }

    fn prompt_text(prompt: &Value) -> String {
        prompt
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| {
                        block.get("type").and_then(Value::as_str) == Some("text")
                            && block
                                .pointer("/annotations/audience")
                                .and_then(Value::as_array)
                                .map(|audience| audience.iter().any(|entry| entry == "user"))
                                .unwrap_or(true)
                    })
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    }

    /// Persist a user turn's prompt blocks. A steered turn (one the agent
    /// picks up after the turn it was steered into) is marked `steer` and
    /// echoed live once: the renderer already shows the message and needs
    /// the echo as the boundary between the previous reply and this one.
    ///
    /// Returns what it takes to undo these writes, for the case where the
    /// bridge rejects the prompt outright.
    async fn record_user_prompt(
        &self,
        session_id: &str,
        prompt: &Value,
        meta: &Value,
        ids: &TurnIds,
        steer: bool,
    ) -> Option<RecordedPrompt> {
        let events = Self::user_prompt_events(session_id, prompt, meta, ids, &now_iso(), steer);
        let undo = match self.store.touch_undo(session_id).await {
            Ok(undo) => undo,
            Err(error) => {
                log::warn!("[agent-host] failed to read session {session_id}: {error}");
                None
            }
        };
        // One commit for the whole prompt: its blocks are one message and
        // half of them in the log is never a state anyone wants to read.
        let event_ids = match self.store.append_events(session_id, &events).await {
            Ok(ids) => ids,
            Err(error) => {
                log::warn!("[agent-host] failed to persist prompt: {error}");
                Vec::new()
            }
        };
        if steer {
            if let Some(mut echo) = events.into_iter().next() {
                echo["update"]["messageId"] = json!(ids.message_id);
                self.notify_frontend("session/update", echo);
            }
        }
        let snippet = Self::snippet(&Self::prompt_text(prompt));
        let _ = self.store.touch(session_id, 1, snippet.as_deref()).await;
        if snippet.is_none() {
            let _ = self.store.touch(session_id, 0, None).await;
        }
        undo.map(|undo| RecordedPrompt {
            run_id: ids.run_id.clone(),
            event_ids,
            undo,
        })
    }

    /// Take a prompt the bridge rejected back out of the log and off the
    /// message count. Only when the turn produced nothing at all: once any
    /// `session/update` has arrived the turn happened, whatever `session/prompt`
    /// answered with, and the transcript has to keep it.
    ///
    /// The renderer's queue law re-dispatches a message whose send failed, so
    /// leaving it behind is what turns one rejected send into two, three, …
    /// copies of the same message with no replies — and a `message_count` that
    /// refuses to move the still-unanswered chat to another agent.
    ///
    /// The decision fails *closed*: without proof that this very turn produced
    /// nothing, the prompt stays. Leaving an unanswered message behind costs a
    /// duplicate the user can see and delete; withdrawing a message whose reply
    /// was persisted leaves a transcript holding an answer to nothing and loses
    /// what the user typed.
    async fn discard_rejected_prompt(&self, session_id: &str, recorded: Option<RecordedPrompt>) {
        let Some(recorded) = recorded else {
            return;
        };
        // The evidence lives in the bridge event queue: an update the bridge
        // emitted before it answered with an error is only stamped onto the run
        // when the event loop gets to it. Wait for the loop to catch up, or a
        // chunk that is about to be persisted reads as "nothing happened".
        self.drain_bridge_events().await;
        let produced_nothing = {
            let sessions = self.sessions.lock().await;
            Self::turn_produced_nothing(sessions.get(session_id), &recorded.run_id)
        };
        if !produced_nothing {
            return;
        }
        if let Err(error) = self
            .store
            .discard_prompt(session_id, &recorded.event_ids, &recorded.undo)
            .await
        {
            log::warn!(
                "[agent-host] failed to withdraw the rejected prompt of session {session_id}: {error}"
            );
        }
    }

    /// Whether `runtime` positively says that turn `run_id` produced nothing:
    /// the session is still there, the turn it is running is this one, and no
    /// `session/update` of it has been seen.
    ///
    /// Anything else means "it happened, keep the prompt". A runtime that is
    /// gone is the case that matters: when a bridge dies mid-turn the outstanding
    /// `session/prompt` is failed and the `Exited` that follows removes the
    /// runtime, so the state that would prove the reply exists is exactly the
    /// state that has been thrown away — while the reply's chunks are already in
    /// the transcript. A `run` belonging to another turn says nothing about this
    /// one either.
    fn turn_produced_nothing(runtime: Option<&SessionRuntime>, run_id: &str) -> bool {
        runtime
            .and_then(|runtime| runtime.run.as_ref())
            .is_some_and(|run| run.run_id == run_id && !run.saw_update)
    }

    fn user_prompt_events(
        session_id: &str,
        prompt: &Value,
        meta: &Value,
        ids: &TurnIds,
        created: &str,
        steer: bool,
    ) -> Vec<Value> {
        let mut distill =
            json!({ "messageId": ids.message_id, "runId": ids.run_id, "created": created });
        if let Some(persona_id) = meta.get("personaId") {
            distill["personaId"] = persona_id.clone();
        }
        if steer {
            distill["steer"] = json!(true);
        }
        let mut update_meta = meta.as_object().cloned().unwrap_or_default();
        update_meta.insert("distill".to_string(), distill);
        prompt
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .map(|block| {
                        json!({
                            "sessionId": session_id,
                            "update": {
                                "sessionUpdate": "user_message_chunk",
                                "content": block,
                                "_meta": Value::Object(update_meta.clone()),
                            }
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    async fn prompt(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        self.start_turn(params, TurnIds::new(), false).await
    }

    /// The update that tells the renderer a turn has ended when no request of
    /// its own will carry the answer. `_meta.activeRunId == null` is what
    /// `acpSessionInfoUpdate.ts` settles a chat's active run on.
    fn run_settled_update(session_id: &str) -> Value {
        json!({
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "session_info_update",
                "_meta": { "activeRunId": Value::Null },
            }
        })
    }

    /// Run one user turn and then every message steered into it, in order.
    /// A steered turn (`steer`) that finds another turn already running is
    /// queued behind it instead of failing: the steer was acknowledged with
    /// these ids, so it has to be delivered under them.
    async fn start_turn(
        self: &Arc<Self>,
        params: Value,
        ids: TurnIds,
        steer: bool,
    ) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let record = self.session_record(&session_id).await?;
        let (bridge, _) = self.attach_session(&record).await?;
        let prompt = params
            .get("prompt")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        let meta = params.get("_meta").cloned().unwrap_or_else(|| json!({}));
        // The bridge session the prompt goes to is the one the runtime names
        // in the very lock the run is registered in. `attach_session` released
        // its own lock before returning, and a `reopen_on_model` that took it
        // in between closes the bridge session and opens another: one that
        // finished first is answered here with its new id, and one still in
        // flight left no runtime at all, which fails the prompt cleanly
        // instead of sending it into a session the bridge has already closed.
        let bridge_session_id = {
            let mut sessions = self.sessions.lock().await;
            let runtime = sessions
                .get_mut(&session_id)
                .ok_or_else(|| protocol::internal("session vanished"))?;
            match Self::claim_turn(runtime, &ids) {
                Ok(bridge_session_id) => bridge_session_id,
                Err(active_run_id) => {
                    if steer {
                        runtime
                            .steer_queue
                            .push_back(QueuedPrompt { prompt, meta, ids });
                        return Ok(json!({}));
                    }
                    return Err(protocol::error_with_data(
                        protocol::INVALID_PARAMS,
                        "A prompt is already running for this session",
                        json!({ "actualRunId": active_run_id }),
                    ));
                }
            }
        };
        let recorded = self
            .record_user_prompt(&session_id, &prompt, &meta, &ids, steer)
            .await;
        self.name_untitled_session(&record, &prompt);
        let mut result = self
            .run_prompt(&bridge, &session_id, &bridge_session_id, prompt, meta)
            .await;
        if result.is_err() {
            self.discard_rejected_prompt(&session_id, recorded).await;
        }
        // Steering while the turn ran: send the queued messages one after the
        // other so the agent sees them in order.
        loop {
            let queued = {
                let mut sessions = self.sessions.lock().await;
                let Some(runtime) = sessions.get_mut(&session_id) else {
                    break;
                };
                // The turn failed (the bridge exited, the prompt was
                // rejected): the queued steers were never sent, so they are
                // dropped rather than persisted and echoed as sent messages
                // that will never get a reply — and the caller keeps the real
                // error instead of the last steer's.
                if result.is_err() {
                    let dropped = runtime.drop_queued_steers();
                    runtime.run = None;
                    if dropped > 0 {
                        log::warn!(
                            "[agent-host] session {session_id} turn failed: dropped {dropped} queued steer(s)"
                        );
                    }
                    break;
                }
                let Some(queued) = runtime.steer_queue.pop_front() else {
                    runtime.run = None;
                    break;
                };
                runtime.run = Some(RunState::start(&queued.ids));
                queued
            };
            let recorded = self
                .record_user_prompt(&session_id, &queued.prompt, &queued.meta, &queued.ids, true)
                .await;
            result = self
                .run_prompt(
                    &bridge,
                    &session_id,
                    &bridge_session_id,
                    queued.prompt,
                    queued.meta,
                )
                .await;
            if result.is_err() {
                self.discard_rejected_prompt(&session_id, recorded).await;
            }
        }
        result
    }

    /// Register a turn on an idle session and answer with the bridge session
    /// its prompt must go to, both read under one lock. `Err` names the run
    /// already going, which a steered prompt queues behind and an ordinary one
    /// is refused for.
    fn claim_turn(runtime: &mut SessionRuntime, ids: &TurnIds) -> Result<String, String> {
        if let Some(active) = runtime.run.as_ref() {
            return Err(active.run_id.clone());
        }
        runtime.run = Some(RunState::start(ids));
        Ok(runtime.bridge_session_id.clone())
    }

    async fn run_prompt(
        &self,
        bridge: &Bridge,
        session_id: &str,
        bridge_session_id: &str,
        prompt: Value,
        meta: Value,
    ) -> Result<Value, Value> {
        let mut request = json!({ "sessionId": bridge_session_id, "prompt": prompt });
        if meta.as_object().is_some_and(|meta| !meta.is_empty()) {
            request["_meta"] = meta;
        }
        let result = bridge.request("session/prompt", request).await;
        let (agent_text, saw_agent_message) = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .and_then(|runtime| runtime.run.as_ref())
                .map(|run| (run.agent_text.clone(), run.saw_agent_message))
                .unwrap_or_default()
        };
        let snippet = Self::snippet(&agent_text);
        let _ = self
            .store
            .touch(
                session_id,
                if saw_agent_message { 1 } else { 0 },
                snippet.as_deref(),
            )
            .await;
        result
    }

    /// Queue a message behind the running turn (or start one when idle).
    /// The answer's ids are the ones the message is recorded and run under.
    pub async fn steer(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let expected_run = params
            .get("expectedRunId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let prompt = params
            .get("prompt")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        let meta = params.get("_meta").cloned().unwrap_or_else(|| json!({}));
        let ids = TurnIds::new();
        let queued = {
            let mut sessions = self.sessions.lock().await;
            match sessions.get_mut(&session_id).and_then(|runtime| {
                runtime
                    .run
                    .as_ref()
                    .map(|run| run.run_id.clone())
                    .map(|active| (runtime, active))
            }) {
                Some((runtime, active_run)) => {
                    if expected_run != active_run && expected_run != "__berd_unknown_active_run__" {
                        return Err(protocol::error_with_data(
                            protocol::INVALID_PARAMS,
                            format!("expected run `{expected_run}` but found `{active_run}`"),
                            json!({ "actualRunId": active_run }),
                        ));
                    }
                    runtime.steer_queue.push_back(QueuedPrompt {
                        prompt: prompt.clone(),
                        meta: meta.clone(),
                        ids: ids.clone(),
                    });
                    true
                }
                None => false,
            }
        };
        if !queued {
            // Nothing is running: this becomes a turn of its own. Attach now
            // so a session that cannot be woken fails the steer instead of
            // being acknowledged and then dropped.
            let record = self.session_record(&session_id).await?;
            self.attach_session(&record).await?;
            let host = Arc::clone(self);
            let turn = ids.clone();
            let settle_id = session_id.clone();
            tokio::spawn(async move {
                let params =
                    json!({ "sessionId": settle_id.clone(), "prompt": prompt, "_meta": meta });
                if let Err(error) = host.start_turn(params, turn, true).await {
                    log::warn!("[agent-host] steer prompt failed: {}", error_text(&error));
                }
                // Nobody is awaiting this turn's answer — the renderer got its
                // ids from the `session/steer` reply and nothing else will ever
                // tell it the turn is over. Only settle when the session is
                // genuinely idle: a steer that raced a prompt was queued behind
                // it and that turn is still running.
                if host.active_run_id(&settle_id).await.is_none() {
                    host.notify_frontend("session/update", Self::run_settled_update(&settle_id));
                }
            });
        }
        Ok(json!({
            "runId": ids.run_id,
            "messageId": ids.message_id,
            "assistantMessageId": ids.assistant_message_id,
        }))
    }

    /// A stored session, with any model id that still carries a folded effort
    /// split first. Every single-session read goes through here, so a chat is
    /// converted on the load that first looks at it and never by a sweep over
    /// rows nobody opened.
    pub async fn session_record(&self, session_id: &str) -> Result<SessionRecord, Value> {
        let mut record = self
            .store
            .get_session(session_id)
            .await
            .map_err(protocol::internal)?
            .ok_or_else(|| invalid_params(format!("Unknown session {session_id}")))?;
        self.split_stored_model_id(&mut record).await;
        Ok(record)
    }

    /// Split a stored `model[effort]` id into the two selections it always
    /// was, keeping the original in `legacy_model_id`.
    ///
    /// Only ever for a session nothing has chosen an effort for, and only when
    /// the harness itself advertises that effort for that base model. Anything
    /// else is left byte for byte: claude's `[1m]` context lanes are model ids
    /// and not pairs, `default` and `current` are aliases, and an id whose
    /// suffix no harness advertises is a model name the app has no business
    /// rewriting.
    async fn split_stored_model_id(&self, record: &mut SessionRecord) {
        if record.reasoning_effort.is_some() || record.legacy_model_id.is_some() {
            return;
        }
        let Some(model_id) = record.model_id.clone() else {
            return;
        };
        if !model_id.ends_with(']') || !self.selection_split_enabled().await {
            return;
        }
        let models = ext::known_models(&self.store, &record.harness).await;
        let Some((base, effort)) = Self::legacy_split(&model_id, &models) else {
            return;
        };
        match self
            .store
            .split_legacy_model_id(&record.id, &base, &effort)
            .await
        {
            Ok(true) => {
                log::info!(
                    "[agent-host] session {} runs {base} at {effort}, split out of the stored {model_id}",
                    record.id
                );
                record.legacy_model_id = Some(model_id);
                record.model_id = Some(base);
                record.reasoning_effort = Some(effort);
            }
            // Something chose for this session first; its choice stands.
            Ok(false) => {}
            Err(error) => log::warn!(
                "[agent-host] failed to split the stored model id of session {}: {error}",
                record.id
            ),
        }
    }

    /// The base id and effort a stored `model[effort]` id splits into, when
    /// the harness's own inventory advertises that effort for that base model.
    /// `None` — leave the id exactly as it is — for every other id, including
    /// one whose harness has not been probed yet, which is a "not now" rather
    /// than a "never".
    fn legacy_split(model_id: &str, models: &[Value]) -> Option<(String, String)> {
        let advertised = |id: &str| models.iter().find(|model| model["id"] == id);
        // A harness that lists the whole id means it: that is a model.
        if advertised(model_id).is_some() {
            return None;
        }
        let (base, effort) = model_id.strip_suffix(']')?.split_once('[')?;
        if base.is_empty() || effort.is_empty() || effort.contains('[') {
            return None;
        }
        let offers = advertised(base)?["efforts"]
            .as_array()
            .is_some_and(|efforts| efforts.iter().any(|entry| entry["value"] == effort));
        offers.then(|| (base.to_string(), effort.to_string()))
    }

    /// Whether the lazy split still runs. It does unless the kv row
    /// `migrations/selection_split` says `false` (or `{"enabled": false}`),
    /// which is how it is retired — by condition, not by date: once no
    /// `sessions.legacy_model_id` row is left and no client can still send a
    /// folded id, nothing is gained by asking again.
    async fn selection_split_enabled(&self) -> bool {
        match self.selection_split.load(Ordering::Relaxed) {
            1 => return true,
            2 => return false,
            _ => {}
        }
        let enabled = match self
            .store
            .kv_get(SELECTION_SPLIT_SCOPE, SELECTION_SPLIT_KEY)
            .await
            .ok()
            .flatten()
        {
            Some(Value::Bool(enabled)) => enabled,
            Some(value) => value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            None => true,
        };
        self.selection_split
            .store(if enabled { 1 } else { 2 }, Ordering::Relaxed);
        enabled
    }

    /// Have a chat nothing has named yet summarized, in the background, by its
    /// own harness and model from the message starting this turn. The
    /// renderer shows its own title from
    /// that message meanwhile; a summary that fails leaves the chat untitled,
    /// so the next message tries again. Hidden sessions are never shown, so
    /// they are not named.
    fn name_untitled_session(self: &Arc<Self>, record: &SessionRecord, prompt: &Value) {
        if record.title.is_some() || record.user_set_name || record.hidden {
            return;
        }
        let text = Self::prompt_text(prompt);
        if text.trim().is_empty() {
            return;
        }
        let host = Arc::clone(self);
        let session_id = record.id.clone();
        let harness_id = record.harness.clone();
        let model_id = record.model_id.clone();
        tokio::spawn(async move {
            match host
                .summarize_title(&harness_id, model_id.as_deref(), &text)
                .await
            {
                Ok(Some(title)) => host.apply_host_title(&session_id, &title).await,
                Ok(None) => {
                    log::info!("[agent-host] the title summary for {session_id} came back empty")
                }
                Err(error) => log::info!(
                    "[agent-host] no title summary for {session_id}: {}",
                    error_text(&error)
                ),
            }
        });
    }

    /// Store a title the host chose and show it, unless the user has named
    /// the chat in the meantime.
    async fn apply_host_title(&self, session_id: &str, title: &str) {
        match self.store.set_agent_title(session_id, title).await {
            Ok(true) => self.notify_frontend(
                "session/update",
                json!({
                    "sessionId": session_id,
                    "update": { "sessionUpdate": "session_info_update", "title": title },
                }),
            ),
            Ok(false) => {}
            Err(error) => log::warn!("[agent-host] failed to store the chat title: {error}"),
        }
    }

    /// Ask the chat's own harness and model for a few-word title in a
    /// throwaway session (see `session_title::naming_session_params`), then
    /// end it: deleted where the bridge keeps sessions and allows that, closed
    /// otherwise. `Ok(None)` when the answer held nothing usable.
    async fn summarize_title(
        &self,
        harness_id: &str,
        model_id: Option<&str>,
        user_text: &str,
    ) -> Result<Option<String>, Value> {
        let bridge = self.ensure_bridge(harness_id).await?;
        let cwd = dirs::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string());
        let opened = tokio::time::timeout(
            session_title::TITLE_TIMEOUT,
            bridge.request(
                "session/new",
                session_title::naming_session_params(harness_id, &cwd, model_id),
            ),
        )
        .await
        .map_err(|_| protocol::internal("the naming session did not open in time"))??;
        let naming_id = protocol::session_id(&opened)
            .ok_or_else(|| protocol::internal("bridge returned no sessionId"))?;
        let key = Self::naming_key(harness_id, &naming_id);
        if let Ok(mut replies) = self.naming_replies.lock() {
            replies.insert(key.clone(), String::new());
        }
        let keeps_no_transcript = session_title::keeps_no_transcript(harness_id);
        // Claude Code's naming session is opened on the model
        // (`naming_session_params`); the others take it after opening.
        if let (Some(model_id), false) = (model_id, keeps_no_transcript) {
            let snapshot = Self::snapshot_from(&opened);
            if let Err(error) =
                Self::apply_title_model(&bridge, &naming_id, model_id, &snapshot).await
            {
                log::info!(
                    "[agent-host] the naming session stays on its default model: {}",
                    error_text(&error)
                );
            }
        }
        let asked = tokio::time::timeout(
            session_title::TITLE_TIMEOUT,
            bridge.request(
                "session/prompt",
                json!({
                    "sessionId": naming_id,
                    "prompt": session_title::naming_prompt(user_text),
                }),
            ),
        )
        .await;
        if asked.is_err() {
            bridge.notify("session/cancel", json!({ "sessionId": naming_id }));
        }
        self.drain_bridge_events().await;
        let reply = self
            .naming_replies
            .lock()
            .ok()
            .and_then(|mut replies| replies.remove(&key))
            .unwrap_or_default();
        let ending = if !keeps_no_transcript && bridge.supports_session_capability("delete") {
            "session/delete"
        } else {
            "session/close"
        };
        let ended = tokio::time::timeout(
            session_title::TITLE_TIMEOUT,
            bridge.request(ending, json!({ "sessionId": naming_id })),
        )
        .await;
        if !matches!(ended, Ok(Ok(_))) {
            log::info!(
                "[agent-host] the naming session {naming_id} did not end cleanly ({ending})"
            );
        }
        match asked {
            Ok(Ok(_)) => Ok(session_title::clean_summary(&reply)),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(protocol::internal("the title summary timed out")),
        }
    }

    /// Put a naming session on the chat's own model and on nothing else. A
    /// title is three words long: it is written by the model the chat runs on
    /// so it reads like the chat, but never at that chat's effort or in its
    /// fast mode, and a stored id that still folds an effort into the model's
    /// name contributes only the model half.
    async fn apply_title_model(
        bridge: &Bridge,
        naming_id: &str,
        model_id: &str,
        snapshot: &Value,
    ) -> Result<Value, Value> {
        if !Self::has_model_option(snapshot) {
            return bridge
                .request(
                    "session/set_model",
                    json!({ "sessionId": naming_id, "modelId": model_id }),
                )
                .await;
        }
        let model_id = Self::split_effort_model(snapshot, model_id)
            .map(|split| split.model)
            .unwrap_or_else(|| model_id.to_string());
        bridge
            .request(
                "session/set_config_option",
                json!({
                    "sessionId": naming_id,
                    "configId": Self::model_option_id(snapshot),
                    "value": model_id,
                }),
            )
            .await
    }

    /// Collect a naming session's reply text (see `summarize_title`).
    fn capture_naming_reply(&self, harness: &str, bridge_session_id: &str, params: &Value) {
        let Some(text) = session_title::agent_message_text(params) else {
            return;
        };
        if let Ok(mut replies) = self.naming_replies.lock() {
            if let Some(reply) = replies.get_mut(&Self::naming_key(harness, bridge_session_id)) {
                reply.push_str(text);
            }
        }
    }

    /// Where the model probe opens its throwaway session. The app's own data
    /// directory, not the user's home: a bridge files a session under its
    /// `cwd`, and the probe has no business appearing in the history of the
    /// directory the user actually works in.
    fn probe_cwd(&self) -> String {
        self.app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string())
    }

    /// Open a throwaway session to learn which models a harness offers and
    /// what each of them can do, then close it.
    ///
    /// The row list is the session's own `model` option: base ids under the
    /// bridge's own names. `models.availableModels` is not the list — codex
    /// builds that array as a display-only cross product of every model with
    /// every effort (`gpt-6-astra[low]` and 30 more), and reading the
    /// inventory from there is where Distill learned to treat an effort as
    /// part of a model id. Each model is then selected in turn so the effort
    /// values and fast toggle recorded against it are its own. No prompt is
    /// ever sent, so nothing runs and nothing is billed.
    pub async fn probe_models(self: &Arc<Self>, harness_id: &str) -> Result<Vec<Value>, Value> {
        let bridge = self.ensure_bridge(harness_id).await?;
        let mut params = json!({ "cwd": self.probe_cwd(), "mcpServers": [] });
        if let Some(meta) = harness::probe_session_meta(harness_id) {
            params["_meta"] = meta;
        }
        let opened = bridge.request("session/new", params).await?;
        let Some(probe_session) = protocol::session_id(&opened) else {
            log::info!("[agent-host] {harness_id} named no session to probe its models in");
            return Ok(Self::probe_rows(&opened));
        };
        let select = |config_id: String, model_id: String| {
            let bridge = Arc::clone(&bridge);
            let session = probe_session.clone();
            async move {
                bridge
                    .request(
                        "session/set_config_option",
                        json!({ "sessionId": session, "configId": config_id, "value": model_id }),
                    )
                    .await
            }
        };
        let close = || {
            let bridge = Arc::clone(&bridge);
            let session = probe_session.clone();
            async move {
                // Closed, never deleted: a session that was never prompted is
                // not persisted, and both bridges answer `session/delete` for
                // one with an error that reads like a leak but is the proof
                // there is nothing to delete.
                let closed = tokio::time::timeout(
                    BRIDGE_CLOSE_TIMEOUT,
                    bridge.request("session/close", json!({ "sessionId": session })),
                )
                .await;
                if !matches!(closed, Ok(Ok(_))) {
                    log::info!("[agent-host] the model probe session {session} did not close");
                }
            }
        };
        Ok(Self::probe_model_rows(&opened, select, close).await)
    }

    /// Walk a throwaway session's model list. `select` puts the session on
    /// one model and answers with the bridge's refreshed options; `close`
    /// ends the session, and runs whether the walk finished or gave up.
    async fn probe_model_rows<S, SFut, C, CFut>(
        opened: &Value,
        mut select: S,
        close: C,
    ) -> Vec<Value>
    where
        S: FnMut(String, String) -> SFut,
        SFut: std::future::Future<Output = Result<Value, Value>>,
        C: FnOnce() -> CFut,
        CFut: std::future::Future<Output = ()>,
    {
        let mut rows = Self::probe_rows(opened);
        if let Some(config_id) = Self::model_option(opened)
            .and_then(|option| option.get("id"))
            .and_then(Value::as_str)
        {
            for row in rows.iter_mut() {
                let Some(model_id) = row["id"].as_str().map(str::to_string) else {
                    continue;
                };
                match select(config_id.to_string(), model_id.clone()).await {
                    Ok(answer) => Self::record_capabilities(row, &answer),
                    Err(error) => {
                        // Whatever is wrong with the bridge will be wrong for
                        // the rest of the list too; the models already walked
                        // keep what they answered.
                        log::info!(
                            "[agent-host] the model probe stopped at {model_id}: {}",
                            error_text(&error)
                        );
                        break;
                    }
                }
            }
        }
        close().await;
        rows
    }

    fn model_option(snapshot: &Value) -> Option<&Value> {
        snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_model_option(option))
    }

    /// The models a freshly opened session offers, before any of them has
    /// been selected: names and ids, plus whatever the bridge already said
    /// about their effort levels.
    fn probe_rows(opened: &Value) -> Vec<Value> {
        let mut rows = Self::probe_row_list(opened, Self::model_option(opened));
        for row in rows.iter_mut() {
            Self::apply_advertised_details(row, opened);
        }
        rows
    }

    /// The models a session offers, as the bridge's own model option lists
    /// them. A bridge with no model option at all still names them in its
    /// `models` block.
    fn probe_row_list(opened: &Value, model_option: Option<&Value>) -> Vec<Value> {
        let listed: Vec<Value> = model_option
            .and_then(|option| option["options"].as_array())
            .map(|choices| {
                choices
                    .iter()
                    .filter_map(|choice| {
                        let value = choice.get("value").and_then(Value::as_str)?;
                        Some(Self::probe_row(
                            value,
                            choice.get("name").and_then(Value::as_str),
                            choice.get("description"),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !listed.is_empty() {
            return listed;
        }
        opened
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| {
                        let id = model.get("modelId").and_then(Value::as_str)?;
                        Some(Self::probe_row(
                            id,
                            model.get("name").and_then(Value::as_str),
                            model.get("description"),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A model nobody has asked anything about yet. An empty effort list next
    /// to `capabilitySource: "unknown"` means exactly that, and never "this
    /// model has no effort control".
    fn probe_row(id: &str, name: Option<&str>, description: Option<&Value>) -> Value {
        json!({
            "id": id,
            "name": name.unwrap_or(id),
            "description": description.cloned().unwrap_or(Value::Null),
            "efforts": [],
            "defaultEffort": Value::Null,
            "supportsFast": Value::Null,
            "capabilitySource": "unknown",
        })
    }

    /// What the session reports after moving to this model: the effort values
    /// it offers, and whether it has a fast toggle at all.
    fn record_capabilities(row: &mut Value, answer: &Value) {
        // An answer with no options at all says nothing about the model; one
        // that lists options without an effort or fast option says the model
        // has none, which is a different thing and has to stay different.
        let Some(options) = answer["configOptions"].as_array() else {
            return;
        };
        let efforts: Vec<Value> = options
            .iter()
            .find(|option| Self::is_effort_option(option))
            .and_then(|option| option["options"].as_array())
            .map(|choices| {
                choices
                    .iter()
                    .filter_map(|choice| {
                        let value = choice.get("value").and_then(Value::as_str)?;
                        Some(harness::effort(
                            value,
                            choice.get("name").and_then(Value::as_str),
                            choice.get("description").and_then(Value::as_str),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !efforts.is_empty() {
            row["efforts"] = json!(efforts);
        }
        row["supportsFast"] = json!(options.iter().any(Self::is_fast_option));
        row["capabilitySource"] = json!("probed");
    }

    /// What a bridge says about a model beside its own model option: the
    /// description it only puts in the `models` block, and — for the one
    /// bridge that states it (grok) — the model's effort menu with the
    /// `default: true` flag, the only place any harness names a default.
    fn apply_advertised_details(row: &mut Value, opened: &Value) {
        let Some(model) = opened
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .and_then(|models| {
                models
                    .iter()
                    .find(|model| model["modelId"] == row["id"] && model["modelId"].is_string())
            })
        else {
            return;
        };
        if row["description"].is_null() {
            if let Some(description) = model.get("description").filter(|value| value.is_string()) {
                row["description"] = description.clone();
            }
        }
        let Some(efforts) = model
            .pointer("/_meta/reasoningEfforts")
            .and_then(Value::as_array)
        else {
            return;
        };
        let mut listed = Vec::new();
        let mut default_effort = Value::Null;
        for entry in efforts {
            let Some(value) = entry
                .get("value")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if entry.get("default").and_then(Value::as_bool) == Some(true) {
                default_effort = json!(value);
            }
            listed.push(harness::effort(
                value,
                entry
                    .get("label")
                    .or_else(|| entry.get("name"))
                    .and_then(Value::as_str),
                entry.get("description").and_then(Value::as_str),
            ));
        }
        if listed.is_empty() {
            return;
        }
        row["efforts"] = json!(listed);
        row["defaultEffort"] = default_effort;
        row["capabilitySource"] = json!("probed");
    }

    /// Whether a config option is the model's fast/speed toggle: the
    /// dedicated `fast` option, or a `model_config` on/off select or boolean.
    /// The renderer reads it the same way (`acpSessionConfigSnapshots.ts`),
    /// and the host deliberately does not rename either bridge's own id.
    fn is_fast_option(option: &Value) -> bool {
        let id = option.get("id").and_then(Value::as_str).unwrap_or_default();
        if id != "fast" && option.get("category").and_then(Value::as_str) != Some("model_config") {
            return false;
        }
        match option.get("type").and_then(Value::as_str) {
            Some("boolean") => true,
            Some("select") => {
                id == "fast"
                    || option["options"].as_array().is_some_and(|choices| {
                        let offers =
                            |wanted: &str| choices.iter().any(|choice| choice["value"] == wanted);
                        offers("on") && offers("off")
                    })
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> TurnIds {
        TurnIds {
            run_id: "run-1".to_string(),
            message_id: "user-1".to_string(),
            assistant_message_id: "reply-1".to_string(),
        }
    }

    #[test]
    fn a_steered_prompt_is_recorded_as_a_steer_under_its_acknowledged_ids() {
        let prompt = json!([
            { "type": "text", "text": "skill", "annotations": { "audience": ["assistant"] } },
            { "type": "text", "text": "also check the tests" }
        ]);
        let events = Inner::user_prompt_events(
            "s1",
            &prompt,
            &json!({ "personaId": "p1" }),
            &ids(),
            "2026-09-11T00:00:00.000Z",
            true,
        );
        assert_eq!(events.len(), 2);
        for event in &events {
            assert_eq!(event["sessionId"], "s1");
            assert_eq!(event["update"]["sessionUpdate"], "user_message_chunk");
            let distill = &event["update"]["_meta"]["distill"];
            assert_eq!(distill["messageId"], "user-1");
            assert_eq!(distill["runId"], "run-1");
            assert_eq!(distill["steer"], true);
            assert_eq!(distill["personaId"], "p1");
        }
        assert_eq!(
            events[1]["update"]["content"]["text"],
            "also check the tests"
        );
    }

    #[test]
    fn an_ordinary_prompt_is_not_marked_as_a_steer() {
        let events = Inner::user_prompt_events(
            "s1",
            &json!([{ "type": "text", "text": "hi" }]),
            &json!({}),
            &ids(),
            "2026-09-11T00:00:00.000Z",
            false,
        );
        assert_eq!(events.len(), 1);
        assert!(events[0]["update"]["_meta"]["distill"]
            .get("steer")
            .is_none());
    }

    #[test]
    fn agent_updates_of_a_turn_name_the_reply_apart_from_the_prompt() {
        let mut run = RunState::start(&ids());
        let mut chunk = json!({
            "sessionId": "bridge-1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hello" },
                "_meta": { "claudeCode": { "parentToolUseId": null } },
            }
        });
        Inner::stamp_run_update(&mut chunk, &mut run, "2026-09-11T00:00:00.000Z");
        let meta = &chunk["update"]["_meta"];
        assert_eq!(meta["distill"]["messageId"], "user-1");
        assert_eq!(meta["distill"]["assistantMessageId"], "reply-1");
        assert_eq!(meta["distill"]["runId"], "run-1");
        assert!(meta.get("claudeCode").is_some());
        assert!(run.saw_agent_message);
        assert_eq!(run.agent_text, "hello");

        let mut tool = json!({
            "update": { "sessionUpdate": "tool_call", "toolCallId": "t1" }
        });
        Inner::stamp_run_update(&mut tool, &mut run, "2026-09-11T00:00:00.000Z");
        assert_eq!(
            tool["update"]["_meta"]["distill"]["assistantMessageId"],
            "reply-1"
        );
    }

    #[test]
    fn a_user_chunk_of_a_turn_keeps_only_the_prompt_id() {
        let mut run = RunState::start(&ids());
        let mut echo = json!({
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": { "type": "text", "text": "hi" },
            }
        });
        Inner::stamp_run_update(&mut echo, &mut run, "2026-09-11T00:00:00.000Z");
        let distill = &echo["update"]["_meta"]["distill"];
        assert_eq!(distill["messageId"], "user-1");
        assert!(distill.get("assistantMessageId").is_none());
        assert!(!run.saw_agent_message);
    }

    #[test]
    fn one_write_puts_a_session_on_a_model_and_a_legacy_folded_id_still_arrives() {
        // The whole story: the bridge's own option id, the bridge's own model
        // id, one call.
        let codex = codex_session();
        assert_eq!(
            Inner::model_write(&codex, "gpt-5.5"),
            ModelWrite::ConfigOption {
                config_id: "model".to_string(),
                model: "gpt-5.5".to_string(),
            }
        );

        // A stored id from before the split still reaches `apply_model` inside
        // a send, and is sent as the two values the bridge keeps apart.
        assert_eq!(
            Inner::model_write(&codex, "gpt-5.5[low]"),
            ModelWrite::Folded(SplitModel {
                model: "gpt-5.5".to_string(),
                effort_option: "reasoning_effort".to_string(),
                effort: "low".to_string(),
            })
        );

        // Only a folded id whose BOTH halves the bridge offers is split. An
        // effort it does not advertise is not one, so the id goes out whole
        // and the bridge answers for itself rather than the host inventing a
        // pair of writes out of a model's name.
        assert_eq!(
            Inner::model_write(&codex, "gpt-5.5[ultra]"),
            ModelWrite::ConfigOption {
                config_id: "model".to_string(),
                model: "gpt-5.5[ultra]".to_string(),
            }
        );

        // `[1m]` is a context lane, not an effort: claude's own model option
        // lists the id, so it is never taken apart.
        assert_eq!(
            Inner::model_write(&claude_session(), "opus[1m]"),
            ModelWrite::ConfigOption {
                config_id: "model".to_string(),
                model: "opus[1m]".to_string(),
            }
        );

        // The older method is reached only by a bridge with no model option:
        // codex's `unstable_setSessionModel` requires `model[effort]` and
        // throws on a base id, so it must never see one.
        let optionless = json!({
            "models": { "currentModelId": "some-model", "availableModels": [{ "modelId": "some-model" }] },
            "configOptions": [],
        });
        assert_eq!(
            Inner::model_write(&optionless, "some-model"),
            ModelWrite::SetModel
        );
        for id in ["gpt-5.5", "gpt-5.5[low]", "gpt-5.5[ultra]"] {
            assert_ne!(Inner::model_write(&codex, id), ModelWrite::SetModel);
        }
    }

    #[test]
    fn a_model_reaches_the_renderer_under_the_name_its_own_bridge_gave_it() {
        // codex names one model two ways: `gpt-6-astra` in the option it takes
        // writes on, and `gpt-6-astra[xhigh]` in the display block whose rows
        // are every model crossed with every effort. The host used to present
        // the folded one, which is how an effort click came to read as a model
        // change everywhere above it.
        let snapshot = codex_session();
        let presented = Inner::presented_snapshot("codex-acp", &snapshot, true);
        let option = |id: &str| {
            presented["configOptions"]
                .as_array()
                .expect("options")
                .iter()
                .find(|option| option["id"] == id)
                .expect("option")
                .clone()
        };
        assert_eq!(option("model")["currentValue"], "gpt-6-astra");
        // The effort stays where its bridge keeps it.
        assert_eq!(option("reasoning_effort")["currentValue"], "xhigh");
        // Every option the bridge stated is presented exactly as it stated it,
        // behind the synthesized provider option the renderer reads the agent
        // from.
        assert_eq!(presented["configOptions"][0]["id"], "provider");
        assert_eq!(
            presented["configOptions"]
                .as_array()
                .expect("options")
                .iter()
                .skip(1)
                .cloned()
                .collect::<Vec<_>>(),
            snapshot["configOptions"]
                .as_array()
                .cloned()
                .expect("stated"),
        );

        // And a bridge's own notification passes through unrewritten.
        let params = json!({
            "sessionId": "s",
            "update": {
                "sessionUpdate": "config_option_update",
                "configOptions": snapshot["configOptions"].clone(),
            }
        });
        assert_eq!(
            Inner::config_option_update(&params),
            snapshot["configOptions"]
                .as_array()
                .cloned()
                .map(Value::Array),
        );
    }

    /// A session as codex-acp opens one: base ids in the model option, and a
    /// `models` block whose 31 rows are every model crossed with every
    /// effort. The probe must read the option and ignore the block.
    fn codex_session() -> Value {
        json!({
            "sessionId": "probe-1",
            "models": {
                "currentModelId": "gpt-6-astra[xhigh]",
                "availableModels": [
                    { "modelId": "gpt-6-astra[low]", "name": "GPT-6-Astra (low)" },
                    { "modelId": "gpt-6-astra[ultra]", "name": "GPT-6-Astra (ultra)" },
                    { "modelId": "gpt-5.5[xhigh]", "name": "GPT-5.5 (xhigh)" },
                ]
            },
            "configOptions": [
                {
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "gpt-6-astra",
                    "options": [
                        { "value": "gpt-6-astra", "name": "GPT-6-Astra", "description": "Our most capable model." },
                        { "value": "gpt-5.5", "name": "GPT-5.5" },
                        { "value": "gpt-5.3-codex-spark", "name": "GPT-5.3-Codex-Spark" },
                    ]
                },
                { "id": "reasoning_effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "low", "name": "Low" }] },
                { "id": "fast-mode", "category": "model_config", "type": "select", "currentValue": "off", "options": [{ "value": "on" }, { "value": "off" }] },
            ]
        })
    }

    /// What codex answers when a model is selected: the full option array,
    /// rebuilt for that model.
    fn codex_answer(efforts: &[&str], fast: bool) -> Value {
        let mut options = vec![
            json!({ "id": "model", "category": "model", "type": "select" }),
            json!({
                "id": "reasoning_effort",
                "category": "thought_level",
                "type": "select",
                "options": efforts
                    .iter()
                    .map(|value| json!({ "value": value, "name": value }))
                    .collect::<Vec<_>>(),
            }),
        ];
        if fast {
            options.push(json!({
                "id": "fast-mode",
                "category": "model_config",
                "type": "select",
                "options": [{ "value": "on" }, { "value": "off" }],
            }));
        }
        json!({ "configOptions": options })
    }

    fn effort_values(row: &Value) -> Vec<&str> {
        row["efforts"]
            .as_array()
            .expect("efforts")
            .iter()
            .filter_map(|effort| effort["value"].as_str())
            .collect()
    }

    #[tokio::test]
    async fn the_model_list_is_the_model_option_and_never_the_folded_cross_product() {
        let opened = codex_session();
        let asked = StdMutex::new(Vec::new());
        let closed = StdMutex::new(false);
        let rows = Inner::probe_model_rows(
            &opened,
            |config_id, model_id| {
                asked
                    .lock()
                    .expect("asked")
                    .push(format!("{config_id}={model_id}"));
                async move {
                    Ok(match model_id.as_str() {
                        "gpt-6-astra" => {
                            codex_answer(&["low", "medium", "high", "xhigh", "max", "ultra"], true)
                        }
                        "gpt-5.5" => codex_answer(&["low", "medium", "high", "xhigh"], true),
                        _ => codex_answer(&["low", "medium", "high", "xhigh"], false),
                    })
                }
            },
            || async {
                *closed.lock().expect("closed") = true;
            },
        )
        .await;

        let ids: Vec<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
        assert_eq!(ids, ["gpt-6-astra", "gpt-5.5", "gpt-5.3-codex-spark"]);
        assert!(
            !ids.iter().any(|id| id.contains('[')),
            "no folded id survives the probe"
        );
        assert_eq!(rows[0]["name"], "GPT-6-Astra");
        assert_eq!(rows[0]["description"], "Our most capable model.");
        assert_eq!(
            *asked.lock().expect("asked"),
            [
                "model=gpt-6-astra",
                "model=gpt-5.5",
                "model=gpt-5.3-codex-spark",
            ]
        );

        // Each model's own effort set, not the session's current one.
        assert_eq!(
            effort_values(&rows[0]),
            ["low", "medium", "high", "xhigh", "max", "ultra"]
        );
        assert_eq!(effort_values(&rows[1]), ["low", "medium", "high", "xhigh"]);
        assert_eq!(rows[0]["supportsFast"], true);
        // Spark's fast option disappears from the array while it is current.
        assert_eq!(rows[2]["supportsFast"], false);
        assert_eq!(rows[2]["capabilitySource"], "probed");
        assert!(
            *closed.lock().expect("closed"),
            "the probe session is closed"
        );
    }

    #[tokio::test]
    async fn a_probe_that_gives_up_still_closes_its_session() {
        let opened = codex_session();
        let closed = StdMutex::new(false);
        let rows = Inner::probe_model_rows(
            &opened,
            |_, model_id| async move {
                if model_id == "gpt-6-astra" {
                    Ok(codex_answer(&["low", "medium"], true))
                } else {
                    Err(protocol::internal("the bridge went away"))
                }
            },
            || async {
                *closed.lock().expect("closed") = true;
            },
        )
        .await;

        assert!(*closed.lock().expect("closed"), "closed on the error path");
        // The list survives the failure; what was never asked stays unknown,
        // which is not the same as having no effort control.
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["capabilitySource"], "probed");
        assert_eq!(rows[1]["capabilitySource"], "unknown");
        assert_eq!(rows[1]["supportsFast"], Value::Null);
        assert!(effort_values(&rows[1]).is_empty());
    }

    #[tokio::test]
    async fn grok_keeps_the_effort_menu_and_default_it_states_in_model_meta() {
        let opened = json!({
            "sessionId": "probe-1",
            "models": {
                "currentModelId": "grok-4.6",
                "availableModels": [
                    {
                        "modelId": "grok-4.6",
                        "name": "Grok 4.6",
                        "description": "SpaceXAI's latest frontier model",
                        "_meta": { "reasoningEfforts": [
                            { "id": "xhigh", "value": "xhigh", "label": "Extra High Effort", "default": false },
                            { "id": "high", "value": "high", "label": "High Effort", "default": true },
                        ] }
                    },
                    {
                        "modelId": "grok-4.5",
                        "name": "Grok 4.5",
                        "_meta": { "reasoningEfforts": [
                            { "id": "high", "value": "high", "label": "High Effort", "default": true },
                        ] }
                    },
                ]
            },
            "configOptions": [
                {
                    "id": "model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "grok-4.6",
                    "options": [{ "value": "grok-4.6", "name": "Grok 4.6" }, { "value": "grok-4.5", "name": "Grok 4.5" }]
                },
                { "id": "reasoning_effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "xhigh" }] },
            ]
        });
        let rows = Inner::probe_model_rows(
            &opened,
            |_, model_id| async move {
                let efforts: Vec<Value> = if model_id == "grok-4.6" {
                    vec![json!({ "value": "xhigh", "name": "Extra High Effort" })]
                } else {
                    vec![json!({ "value": "high", "name": "High Effort" })]
                };
                Ok(json!({ "configOptions": [
                    { "id": "model", "category": "model", "type": "select" },
                    { "id": "reasoning_effort", "category": "thought_level", "type": "select", "options": efforts },
                ] }))
            },
            || async {},
        )
        .await;

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["defaultEffort"], "high");
        assert_eq!(rows[1]["defaultEffort"], "high");
        // The model option carries no description; the models block does.
        assert_eq!(rows[0]["description"], "SpaceXAI's latest frontier model");
        // The selected model's own menu wins over the advertised one.
        assert_eq!(effort_values(&rows[0]), ["xhigh"]);
        // Grok has no fast mode anywhere, and says so rather than shrugging.
        assert_eq!(rows[0]["supportsFast"], false);
        assert_eq!(rows[0]["capabilitySource"], "probed");
    }

    #[tokio::test]
    async fn a_context_lane_in_a_model_id_is_left_alone() {
        let opened = json!({
            "sessionId": "probe-1",
            "configOptions": [
                {
                    "id": "model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "default",
                    "options": [
                        { "value": "default", "name": "Default" },
                        { "value": "opus[1m]", "name": "Opus (1M context)" },
                        { "value": "haiku", "name": "Haiku 4.5" },
                    ]
                },
                { "id": "effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "default" }] },
                { "id": "fast", "category": "model_config", "type": "select", "currentValue": "off", "options": [{ "value": "on" }, { "value": "off" }] },
            ]
        });
        let rows = Inner::probe_model_rows(
            &opened,
            |_, model_id| async move {
                // Haiku offers neither control; the others offer both.
                Ok(if model_id == "haiku" {
                    json!({ "configOptions": [{ "id": "model", "category": "model", "type": "select" }] })
                } else {
                    json!({ "configOptions": [
                        { "id": "model", "category": "model", "type": "select" },
                        { "id": "effort", "category": "thought_level", "type": "select", "options": [{ "value": "default" }, { "value": "max" }] },
                        { "id": "fast", "category": "model_config", "type": "select", "options": [{ "value": "on" }, { "value": "off" }] },
                    ] })
                })
            },
            || async {},
        )
        .await;

        let ids: Vec<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
        assert_eq!(ids, ["default", "opus[1m]", "haiku"]);
        assert_eq!(rows[1]["name"], "Opus (1M context)");
        assert_eq!(effort_values(&rows[1]), ["default", "max"]);
        assert_eq!(rows[1]["supportsFast"], true);
        // Haiku has no effort control at all, and that is a probed answer.
        assert!(effort_values(&rows[2]).is_empty());
        assert_eq!(rows[2]["capabilitySource"], "probed");
        assert_eq!(rows[2]["supportsFast"], false);
    }

    #[test]
    fn a_fast_toggle_is_recognised_under_either_bridge_s_own_name() {
        assert!(Inner::is_fast_option(&json!({
            "id": "fast", "category": "model_config", "type": "select",
            "options": [{ "value": "on" }, { "value": "off" }]
        })));
        assert!(Inner::is_fast_option(&json!({
            "id": "fast-mode", "category": "model_config", "type": "select",
            "options": [{ "value": "off" }, { "value": "on" }]
        })));
        assert!(Inner::is_fast_option(
            &json!({ "id": "fast-mode", "category": "model_config", "type": "boolean" })
        ));
        // Another model_config knob that happens to be a select is not it.
        assert!(!Inner::is_fast_option(&json!({
            "id": "verbosity", "category": "model_config", "type": "select",
            "options": [{ "value": "terse" }, { "value": "verbose" }]
        })));
        assert!(!Inner::is_fast_option(
            &json!({ "id": "reasoning_effort", "category": "thought_level", "type": "select" })
        ));
    }

    /// A claude-acp session as the bridge opens one: no `models` block at
    /// all, the model in its own option, and an effort seeded from the
    /// operator's `~/.claude/settings.json` rather than from the model.
    fn claude_session() -> Value {
        json!({
            "models": Value::Null,
            "configOptions": [
                { "id": "mode", "category": "mode", "type": "select", "currentValue": "default", "options": [{ "value": "default" }] },
                {
                    "id": "model", "category": "model", "type": "select", "currentValue": "opus[1m]",
                    "options": [
                        { "value": "default" }, { "value": "opus[1m]" },
                        { "value": "claude-fable-5[1m]" }, { "value": "sonnet" }, { "value": "haiku" },
                    ]
                },
                {
                    "id": "effort", "category": "thought_level", "type": "select", "currentValue": "xhigh",
                    "options": [{ "value": "default" }, { "value": "low" }, { "value": "high" }, { "value": "xhigh" }, { "value": "max" }]
                },
                {
                    "id": "fast", "category": "model_config", "type": "select", "currentValue": "off",
                    "options": [{ "value": "on" }, { "value": "off" }]
                },
                { "id": "agent", "category": "agent", "type": "select", "currentValue": "default", "options": [{ "value": "default" }] },
            ]
        })
    }

    /// grok-acp: a real `thought_level` option under the same id codex uses,
    /// and no fast toggle of any kind.
    fn grok_session() -> Value {
        json!({
            "models": { "currentModelId": "grok-4.6" },
            "configOptions": [
                { "id": "model", "category": "model", "type": "select", "currentValue": "grok-4.6", "options": [{ "value": "grok-4.6" }] },
                { "id": "reasoning_effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "xhigh" }] },
            ]
        })
    }

    /// An inventory row as `probe_models` writes it, before `merge_inventory`
    /// places it.
    fn probed_row(id: &str, efforts: &[&str]) -> Value {
        json!({
            "id": id,
            "name": id,
            "description": Value::Null,
            "efforts": efforts.iter().map(|value| harness::effort(value, None, None)).collect::<Vec<_>>(),
            "defaultEffort": Value::Null,
            "supportsFast": false,
            "capabilitySource": "probed",
        })
    }

    #[test]
    fn a_write_is_routed_by_role_and_keeps_the_bridges_own_name() {
        let claude = claude_session();
        assert_eq!(Inner::option_role(&claude, "model"), OptionRole::Model);
        assert_eq!(Inner::option_role(&claude, "effort"), OptionRole::Effort);
        assert_eq!(Inner::option_role(&claude, "fast"), OptionRole::Fast);
        assert_eq!(Inner::option_role(&claude, "mode"), OptionRole::Other);
        assert_eq!(Inner::option_role(&claude, "agent"), OptionRole::Other);

        // The same three roles under each bridge's own ids.
        let codex = codex_session();
        assert_eq!(
            Inner::option_role(&codex, "reasoning_effort"),
            OptionRole::Effort
        );
        assert_eq!(Inner::option_role(&codex, "fast-mode"), OptionRole::Fast);
        assert_eq!(
            Inner::option_role(&codex, "collaboration_mode"),
            OptionRole::Other
        );
        assert_eq!(
            Inner::option_role(&grok_session(), "reasoning_effort"),
            OptionRole::Effort
        );
        assert_eq!(
            Inner::option_role(&grok_session(), "fast"),
            OptionRole::Other
        );

        // A session whose stored snapshot arrived with no options (grok's cold
        // session/new) is classified from the bridge's own answer instead.
        let cold = json!({ "configOptions": [] });
        assert_eq!(
            Inner::write_role(&cold, &claude, "effort"),
            OptionRole::Effort
        );
        assert_eq!(
            Inner::write_role(&claude, &cold, "effort"),
            OptionRole::Effort
        );
        assert_eq!(Inner::write_role(&cold, &cold, "effort"), OptionRole::Other);

        // What goes to the bridge is the client's own request, session id
        // aside: the id and the value shape are never rewritten.
        let write = json!({ "sessionId": "host-1", "configId": "fast-mode", "value": true, "type": "boolean" });
        assert_eq!(
            Inner::forwarded_config_write(&write, "bridge-1"),
            json!({ "sessionId": "bridge-1", "configId": "fast-mode", "value": true, "type": "boolean" })
        );
    }

    #[test]
    fn what_is_stored_is_what_the_bridge_answered_not_what_was_asked() {
        // Asked for gpt-5.5 at xhigh, codex clamps the effort to the model's
        // own default and reports it nowhere but in the options it answers with.
        let clamped = json!([
            { "id": "model", "category": "model", "currentValue": "gpt-5.5" },
            { "id": "reasoning_effort", "category": "thought_level", "currentValue": "medium" },
            {
                "id": "fast-mode", "category": "model_config", "type": "select", "currentValue": "on",
                "options": [{ "value": "on" }, { "value": "off" }]
            },
        ]);
        assert_eq!(
            Inner::selection_from(&clamped),
            Selection {
                model: Some("gpt-5.5".to_string()),
                effort: Some("medium".to_string()),
                fast: Some(true),
            }
        );

        // A full list without an effort or a fast option is the model saying
        // it has neither (claude on haiku), which is not the same as silence.
        let haiku = json!([
            { "id": "mode", "category": "mode", "currentValue": "default" },
            { "id": "model", "category": "model", "currentValue": "haiku" },
        ]);
        assert_eq!(
            Inner::selection_from(&haiku),
            Selection {
                model: Some("haiku".to_string()),
                effort: None,
                fast: None,
            }
        );
        // An answer carrying no options at all teaches nothing.
        assert_eq!(
            Inner::selection_from(&json!({})["configOptions"]),
            Selection::default()
        );

        assert_eq!(Inner::fast_enabled(&json!(true)), Some(true));
        assert_eq!(Inner::fast_enabled(&json!("on")), Some(true));
        assert_eq!(Inner::fast_enabled(&json!("off")), Some(false));
        assert_eq!(Inner::fast_enabled(&json!("sometimes")), None);
    }

    #[test]
    fn the_model_a_session_is_on_is_the_one_its_bridge_would_take_back() {
        // codex keeps a folded display id in its models block while its own
        // option holds the base id it accepts; reading the block first is how
        // `gpt-6-astra[xhigh]` used to reach sessions.model_id.
        let codex = json!({
            "models": { "currentModelId": "gpt-6-astra[xhigh]" },
            "configOptions": [
                { "id": "model", "category": "model", "currentValue": "gpt-6-astra" },
                { "id": "reasoning_effort", "category": "thought_level", "currentValue": "xhigh" },
            ]
        });
        assert_eq!(Inner::current_model(&codex).as_deref(), Some("gpt-6-astra"));
        assert_eq!(
            Inner::current_model(&claude_session()).as_deref(),
            Some("opus[1m]")
        );
        // A bridge with no model option is still read from its models block.
        let listed = json!({ "models": { "currentModelId": "amp-1" }, "configOptions": [] });
        assert_eq!(Inner::current_model(&listed).as_deref(), Some("amp-1"));
        assert_eq!(Inner::current_model(&json!({})), None);
    }

    #[test]
    fn only_a_folded_id_its_harness_can_explain_is_split() {
        let codex = harness::merge_inventory(
            "codex-acp",
            vec![
                probed_row(
                    "gpt-6-astra",
                    &["low", "medium", "high", "xhigh", "max", "ultra"],
                ),
                probed_row(
                    "gpt-5.6-sol",
                    &["low", "medium", "high", "xhigh", "max", "ultra"],
                ),
                probed_row("gpt-5.6-luna", &["low", "medium", "high", "xhigh", "max"]),
                probed_row("gpt-5.4-mini", &[]),
            ],
        );
        // The four ids the live store actually holds folded.
        for (folded, model, effort) in [
            ("gpt-5.6-sol[xhigh]", "gpt-5.6-sol", "xhigh"),
            ("gpt-5.6-sol[low]", "gpt-5.6-sol", "low"),
            ("gpt-6-astra[xhigh]", "gpt-6-astra", "xhigh"),
            ("gpt-5.6-luna[low]", "gpt-5.6-luna", "low"),
        ] {
            assert_eq!(
                Inner::legacy_split(folded, &codex),
                Some((model.to_string(), effort.to_string())),
                "{folded}"
            );
        }
        // An effort that model does not offer, a model the harness does not
        // list, and every shape that is not a pair at all.
        for id in [
            "gpt-5.6-luna[ultra]",
            "gpt-5.3-codex-spark[high]",
            "gpt-5.4-mini",
            "current",
            "a[b][c]",
            "[low]",
            "gpt-5.6-sol[]",
            "gpt-5.6-sol[xhigh",
        ] {
            assert_eq!(Inner::legacy_split(id, &codex), None, "{id}");
        }
        // A harness nobody has probed yet answers "not now", never a guess.
        assert_eq!(
            Inner::legacy_split(
                "gpt-5.6-sol[xhigh]",
                &harness::merge_inventory("codex-acp", vec![])
            ),
            None
        );

        // claude's `[1m]` ids are context lanes, not efforts, and `default` is
        // an alias — with or without a probe behind them.
        let claude = harness::merge_inventory(
            "claude-acp",
            vec![
                probed_row("default", &["default", "low", "high", "xhigh", "max"]),
                probed_row("opus[1m]", &["default", "low", "high", "xhigh", "max"]),
                probed_row(
                    "claude-fable-5[1m]",
                    &["default", "low", "high", "xhigh", "max"],
                ),
                probed_row("sonnet", &["default", "low", "high", "xhigh", "max"]),
                probed_row("haiku", &[]),
            ],
        );
        let declared = harness::merge_inventory("claude-acp", vec![]);
        for id in [
            "opus[1m]",
            "claude-fable-5[1m]",
            "claude-fable-5-1[1m]",
            "default",
            "haiku",
            "claude-opus-4-7",
        ] {
            assert_eq!(Inner::legacy_split(id, &claude), None, "{id}");
            assert_eq!(Inner::legacy_split(id, &declared), None, "{id} declared");
        }

        let grok = harness::merge_inventory(
            "grok-acp",
            vec![probed_row("grok-4.6", &["xhigh", "high", "medium", "low"])],
        );
        assert_eq!(Inner::legacy_split("grok-4.6", &grok), None);
        assert_eq!(Inner::legacy_split("current", &grok), None);
    }

    #[test]
    fn a_configuration_the_bridge_changes_by_itself_is_read_off_the_notification() {
        let update = |options: Value| {
            json!({
                "sessionId": "s1",
                "update": { "sessionUpdate": "config_option_update", "configOptions": options },
            })
        };
        // grok sends the whole list, so one notification states everything.
        let grok = update(json!([
            { "id": "model", "category": "model", "currentValue": "grok-4.6" },
            { "id": "reasoning_effort", "category": "thought_level", "currentValue": "low" },
        ]));
        let options = Inner::config_option_update(&grok).expect("options");
        assert_eq!(
            Inner::selection_from(&options),
            Selection {
                model: Some("grok-4.6".to_string()),
                effort: Some("low".to_string()),
                fast: None,
            }
        );

        // claude's SDK flipping fast mode back after a cooldown, with nobody
        // watching.
        let cooled = update(json!([
            { "id": "model", "category": "model", "currentValue": "opus[1m]" },
            { "id": "effort", "category": "thought_level", "currentValue": "max" },
            {
                "id": "fast", "category": "model_config", "type": "select", "currentValue": "off",
                "options": [{ "value": "on" }, { "value": "off" }]
            },
        ]));
        let selection =
            Inner::selection_from(&Inner::config_option_update(&cooled).expect("options"));
        assert_eq!(selection.effort.as_deref(), Some("max"));
        assert_eq!(selection.fast, Some(false));

        // Nothing to apply from an empty list or another kind of update.
        assert!(Inner::config_option_update(&update(json!([]))).is_none());
        assert!(Inner::config_option_update(
            &json!({ "update": { "sessionUpdate": "agent_message_chunk" } })
        )
        .is_none());
    }

    /// Everything claude-agent-acp offers, and the five values the 4.6-class
    /// models drop `xhigh` from.
    const EVERY_EFFORT: &[&str] = &["default", "low", "medium", "high", "xhigh", "max"];
    const NO_XHIGH: &[&str] = &["default", "low", "medium", "high", "max"];

    /// What claude-agent-acp answers a write with: its whole option list,
    /// rebuilt for the model the session is now on. `effort` is `None` for a
    /// model with no effort control at all (haiku) and `fast` `None` for one
    /// with no fast toggle (every model but the Opus rows).
    fn claude_answer(
        model: &str,
        effort: Option<&str>,
        efforts: &[&str],
        fast: Option<bool>,
    ) -> Value {
        let mut options = vec![json!({
            "id": "model", "category": "model", "type": "select", "currentValue": model,
            "options": [
                { "value": "default" }, { "value": "opus[1m]" },
                { "value": "claude-fable-5[1m]" }, { "value": "sonnet" }, { "value": "haiku" },
            ]
        })];
        if let Some(effort) = effort {
            options.push(json!({
                "id": "effort", "category": "thought_level", "type": "select",
                "currentValue": effort,
                "options": efforts.iter().map(|value| json!({ "value": value })).collect::<Vec<_>>(),
            }));
        }
        if let Some(fast) = fast {
            options.push(json!({
                "id": "fast", "category": "model_config", "type": "select",
                "currentValue": Inner::fast_word(fast),
                "options": [{ "value": "on" }, { "value": "off" }],
            }));
        }
        json!({ "configOptions": options })
    }

    #[tokio::test]
    async fn a_chat_is_put_on_its_model_then_its_effort_then_its_fast_mode() {
        let mut snapshot = claude_session();
        let asked = StdMutex::new(Vec::new());
        let wanted = Selection {
            model: Some("sonnet".to_string()),
            effort: Some("high".to_string()),
            fast: Some(true),
        };
        let substitutions =
            Inner::apply_selection("claude-acp", &mut snapshot, &wanted, false, |_, request| {
                let config_id = request["configId"].as_str().unwrap_or_default().to_string();
                asked
                    .lock()
                    .expect("asked")
                    .push(format!("{config_id}={}", request["value"]));
                // Sonnet keeps the effort it was on and has no fast toggle.
                let answer = match config_id.as_str() {
                    "model" => claude_answer("sonnet", Some("xhigh"), EVERY_EFFORT, None),
                    _ => claude_answer("sonnet", Some("high"), EVERY_EFFORT, None),
                };
                async move { Ok(answer) }
            })
            .await;

        assert_eq!(
            *asked.lock().expect("asked"),
            vec!["model=\"sonnet\"", "effort=\"high\""]
        );
        assert_eq!(Inner::current_model(&snapshot).as_deref(), Some("sonnet"));
        assert_eq!(
            Inner::effort_state(&snapshot, "high").map(|(_, current, _)| current),
            Some(Some("high".to_string()))
        );
        // The step nothing advertised is the only one that did not happen, and
        // it is the one the chat is told about.
        assert_eq!(substitutions.len(), 1, "{substitutions:?}");
        assert_eq!(substitutions[0]["role"], "fast");
        assert_eq!(substitutions[0]["requested"], "on");
        assert_eq!(substitutions[0]["applied"], Value::Null);
        assert_eq!(substitutions[0]["reason"], "sonnet has no fast mode");
    }

    #[tokio::test]
    async fn a_model_the_bridge_only_opens_on_is_asserted_and_not_assumed() {
        // A session opened through `_meta.claudeCode.options.model`: the bridge
        // reports `default` and its effort and fast options describe that
        // alias, which is how Opus 4.6 came to advertise an xhigh it has not.
        let opened = || {
            json!({
                "models": Value::Null,
                "configOptions": claude_answer("default", Some("xhigh"), EVERY_EFFORT, Some(false))["configOptions"],
            })
        };
        let wanted = Selection {
            model: Some("claude-opus-4-6".to_string()),
            effort: Some("xhigh".to_string()),
            fast: None,
        };

        let mut snapshot = opened();
        let asked = StdMutex::new(Vec::new());
        let substitutions =
            Inner::apply_selection("claude-acp", &mut snapshot, &wanted, true, |_, request| {
                asked
                    .lock()
                    .expect("asked")
                    .push(request["value"].as_str().unwrap_or_default().to_string());
                // Asserted, the session finally describes the model it is for.
                let answer = claude_answer("claude-opus-4-6", Some("default"), NO_XHIGH, None);
                async move { Ok(answer) }
            })
            .await;
        assert_eq!(*asked.lock().expect("asked"), vec!["claude-opus-4-6"]);
        assert_eq!(
            Inner::current_model(&snapshot).as_deref(),
            Some("claude-opus-4-6")
        );
        assert!(Inner::fast_state(&snapshot).is_none(), "4.6 has no fast");
        // And the effort the session showed before the assert belonged to the
        // alias: 4.6 does not offer it, so it is left alone and reported.
        assert_eq!(substitutions.len(), 1, "{substitutions:?}");
        assert_eq!(substitutions[0]["role"], "effort");
        assert_eq!(substitutions[0]["requested"], "xhigh");
        assert_eq!(substitutions[0]["applied"], "default");
        assert_eq!(substitutions[0]["reason"], "not offered by claude-opus-4-6");

        // Without the assert — an ordinary model — a value the bridge does not
        // list is never written at it.
        let mut untouched = opened();
        let refused =
            Inner::apply_selection("claude-acp", &mut untouched, &wanted, false, |_, _| async {
                panic!("nothing may be written for a model the bridge does not list")
            })
            .await;
        assert_eq!(refused[0]["role"], "model");
        assert_eq!(refused[0]["applied"], "default");
        assert_eq!(untouched, opened());
    }

    #[tokio::test]
    async fn an_effort_is_never_written_at_a_model_that_has_none() {
        // Haiku has no effort option at all, and writing one answers "Unknown
        // config option: effort".
        let mut snapshot = json!({
            "models": Value::Null,
            "configOptions": claude_answer("haiku", None, &[], None)["configOptions"],
        });
        let wanted = Selection {
            model: None,
            effort: Some("xhigh".to_string()),
            fast: Some(true),
        };
        let substitutions =
            Inner::apply_selection("claude-acp", &mut snapshot, &wanted, false, |_, _| async {
                panic!("haiku offers neither knob")
            })
            .await;
        assert_eq!(substitutions.len(), 2);
        assert_eq!(substitutions[0]["reason"], "haiku has no effort control");
        assert_eq!(substitutions[1]["reason"], "haiku has no fast mode");
        for entry in &substitutions {
            assert_eq!(entry["applied"], Value::Null);
        }
    }

    #[tokio::test]
    async fn the_value_a_bridge_answers_with_is_the_one_that_stuck() {
        // A bridge answers a write it will not honour with the value it kept
        // rather than with an error: what came back is what the session runs
        // at, whatever was asked for.
        let mut snapshot = claude_session();
        let wanted = Selection {
            model: None,
            effort: Some("max".to_string()),
            fast: None,
        };
        let substitutions =
            Inner::apply_selection("claude-acp", &mut snapshot, &wanted, false, |_, _| async {
                Ok(claude_answer(
                    "opus[1m]",
                    Some("high"),
                    EVERY_EFFORT,
                    Some(false),
                ))
            })
            .await;
        assert_eq!(substitutions.len(), 1);
        assert_eq!(substitutions[0]["requested"], "max");
        assert_eq!(substitutions[0]["applied"], "high");
        assert_eq!(
            Inner::effort_state(&snapshot, "max").map(|(_, current, _)| current),
            Some(Some("high".to_string()))
        );

        // A refusal is not a failure either: the sequence records it and goes on.
        let mut refused = claude_session();
        let substitutions =
            Inner::apply_selection("claude-acp", &mut refused, &wanted, false, |_, _| async {
                Err(protocol::internal("Unknown config option: effort"))
            })
            .await;
        assert_eq!(substitutions.len(), 1);
        assert_eq!(substitutions[0]["applied"], Value::Null);
        assert_eq!(refused, claude_session());
    }

    #[tokio::test]
    async fn a_stored_id_that_still_folds_an_effort_is_applied_as_its_two_halves() {
        // Until its harness has been probed once, a session stored before the
        // effort was split out of the model's name still carries the folded
        // id. `apply_model` sends the two halves the bridge keeps apart, and
        // the model it names back is the model half — which is the model that
        // was asked for, not one substituted for it.
        let mut snapshot = codex_session();
        let wanted = Selection {
            model: Some("gpt-5.5[xhigh]".to_string()),
            effort: None,
            fast: None,
        };
        let asked = StdMutex::new(Vec::new());
        let substitutions =
            Inner::apply_selection("codex-acp", &mut snapshot, &wanted, false, |role, request| {
                asked
                    .lock()
                    .expect("asked")
                    .push((role, request["value"].clone()));
                let answer = json!({ "configOptions": [
                    { "id": "model", "category": "model", "type": "select", "currentValue": "gpt-5.5",
                      "options": [{ "value": "gpt-6-astra" }, { "value": "gpt-5.5" }] },
                    { "id": "reasoning_effort", "category": "thought_level", "type": "select",
                      "currentValue": "xhigh", "options": [{ "value": "low" }, { "value": "xhigh" }] },
                ] });
                async move { Ok(answer) }
            })
            .await;
        assert_eq!(
            *asked.lock().expect("asked"),
            vec![(OptionRole::Model, json!("gpt-5.5[xhigh]"))]
        );
        assert!(substitutions.is_empty(), "{substitutions:?}");
        assert_eq!(Inner::current_model(&snapshot).as_deref(), Some("gpt-5.5"));
    }

    #[test]
    fn a_bridge_answer_that_states_no_options_never_silences_a_chats_controls() {
        // grok's cold `session/new` carries its models and no `configOptions`
        // key at all; storing that left the chat's effort control looking
        // unsupported for good.
        let cold = json!({ "models": { "currentModelId": "grok-4.6" }, "configOptions": [] });
        assert!(!Inner::replaces_snapshot(&cold, &grok_session()));
        // With nothing to lose it still gets through, so a bridge that keeps
        // its models outside the option list is not left without any.
        assert!(Inner::replaces_snapshot(
            &cold,
            &json!({ "configOptions": [] })
        ));
        assert!(Inner::replaces_snapshot(&grok_session(), &cold));

        // The same rule mid-sequence: `session/set_model` answers with nothing.
        let mut snapshot = grok_session();
        Inner::take_options(&mut snapshot, &json!({}));
        Inner::take_options(&mut snapshot, &json!({ "configOptions": [] }));
        assert_eq!(snapshot, grok_session());
    }

    /// A stored chat, as everything but its four selections is beside the
    /// point here.
    fn record_on(model: Option<&str>, effort: Option<&str>, fast: Option<bool>) -> SessionRecord {
        SessionRecord {
            id: "s1".to_string(),
            harness: "codex-acp".to_string(),
            bridge_session_id: Some("bridge-1".to_string()),
            cwd: "/work".to_string(),
            title: None,
            user_set_name: false,
            project_id: Some("p1".to_string()),
            persona_id: Some("agent-1".to_string()),
            model_id: model.map(str::to_string),
            reasoning_effort: effort.map(str::to_string),
            fast_mode: fast,
            legacy_model_id: None,
            hidden: false,
            created_at: "2026-09-14T00:00:00.000Z".to_string(),
            updated_at: "2026-09-14T00:00:00.000Z".to_string(),
            last_message_at: None,
            archived_at: None,
            message_count: 3,
            last_snippet: None,
            snapshot: None,
        }
    }

    #[test]
    fn a_fork_opens_on_everything_the_chat_it_was_taken_from_was_running() {
        let meta = Inner::fork_meta(&record_on(Some("gpt-6-astra"), Some("ultra"), Some(true)));
        assert_eq!(
            meta,
            json!({
                "provider": "codex-acp",
                "projectId": "p1",
                "personaId": "agent-1",
                "model": "gpt-6-astra",
                "reasoningEffort": "ultra",
                "fastMode": true,
            })
        );
        // And `session/new` reads back exactly what the fork wrote.
        assert_eq!(
            Inner::wanted_from_meta(&json!({ "_meta": meta })),
            Selection {
                model: Some("gpt-6-astra".to_string()),
                effort: Some("ultra".to_string()),
                fast: Some(true),
            }
        );

        // A chat nobody chose for names nothing, and opens on whatever its
        // harness starts with.
        let bare = Inner::fork_meta(&record_on(None, None, None));
        assert_eq!(bare["model"], Value::Null);
        assert_eq!(
            Inner::wanted_from_meta(&json!({ "_meta": bare })),
            Selection::default()
        );
        assert_eq!(Inner::wanted_from_meta(&json!({})), Selection::default());
    }

    #[test]
    fn what_a_bridge_would_not_do_is_the_only_record_of_a_downgrade() {
        // codex clamps the effort to the target model's own default on a model
        // change, and says so nowhere but in the options it answers with.
        let wanted = Selection {
            model: Some("gpt-5.5".to_string()),
            effort: Some("xhigh".to_string()),
            fast: None,
        };
        let clamped = Selection {
            model: Some("gpt-5.5".to_string()),
            effort: Some("medium".to_string()),
            fast: None,
        };
        let entries = Inner::substitutions_for(&wanted, &clamped);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0],
            json!({
                "role": "effort",
                "requested": "xhigh",
                "applied": "medium",
                "reason": "not offered by gpt-5.5",
            })
        );

        // claude drops the effort entirely on a model that has none, and keeps
        // the fast intent it cannot show.
        let haiku = Selection {
            model: Some("haiku".to_string()),
            effort: None,
            fast: None,
        };
        let asked = Selection {
            model: Some("haiku".to_string()),
            effort: Some("xhigh".to_string()),
            fast: Some(true),
        };
        let entries = Inner::substitutions_for(&asked, &haiku);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["applied"], Value::Null);
        assert_eq!(entries[0]["reason"], "haiku has no effort control");
        assert_eq!(entries[1]["requested"], "on");
        assert_eq!(entries[1]["reason"], "haiku has no fast mode");

        // A model the agent would not take is named for what it is on.
        let elsewhere = Inner::substitutions_for(
            &wanted,
            &Selection {
                model: Some("gpt-6-astra".to_string()),
                effort: Some("xhigh".to_string()),
                fast: None,
            },
        );
        assert_eq!(elsewhere.len(), 1);
        assert_eq!(elsewhere[0]["role"], "model");
        assert_eq!(elsewhere[0]["applied"], "gpt-6-astra");

        // Nothing to report when the bridge did as it was asked.
        assert!(Inner::substitutions_for(&wanted, &wanted).is_empty());
        assert!(Inner::substitutions_for(&Selection::default(), &haiku).is_empty());
    }

    #[test]
    fn a_presented_snapshot_carries_a_downgrade_next_to_the_provider_that_made_it() {
        let mut presented = Inner::presented_snapshot("claude-acp", &claude_session(), true);
        presented["_meta"] = json!({ "providerId": "claude-acp" });
        let entry = Inner::substitution("effort", "xhigh", Some("high"), "no".to_string());
        let carried = Inner::with_substitutions(presented.clone(), std::slice::from_ref(&entry));
        assert_eq!(carried["_meta"]["providerId"], "claude-acp");
        assert_eq!(carried["_meta"]["substitutions"], json!([entry]));
        // Nothing was refused, nothing is said.
        assert_eq!(Inner::with_substitutions(presented.clone(), &[]), presented);
    }

    /// A live session, as `claim_turn` reads one.
    fn runtime_on(bridge_session_id: &str) -> SessionRuntime {
        SessionRuntime {
            harness: "claude-acp".to_string(),
            bridge_session_id: bridge_session_id.to_string(),
            generation: 0,
            loading: false,
            run: None,
            steer_queue: VecDeque::new(),
            snapshot: claude_session(),
            has_model_option: true,
            substitutions: Vec::new(),
        }
    }

    #[test]
    fn a_prompt_goes_to_the_bridge_session_its_runtime_names_as_the_run_is_registered() {
        let mut runtime = runtime_on("bridge-1");
        // A `reopen_on_model` that got in between the attach and the claim
        // closed `bridge-1` and opened another; the prompt must go to that one.
        runtime.bridge_session_id = "bridge-2".to_string();
        assert_eq!(
            Inner::claim_turn(&mut runtime, &ids()),
            Ok("bridge-2".to_string())
        );
        assert_eq!(
            runtime.run.as_ref().map(|run| run.run_id.as_str()),
            Some("run-1")
        );

        // The second prompt is told which run it found, and takes neither the
        // turn nor the session from it.
        let mut second = TurnIds::new();
        second.run_id = "run-2".to_string();
        assert_eq!(
            Inner::claim_turn(&mut runtime, &second),
            Err("run-1".to_string())
        );
        assert_eq!(
            runtime.run.as_ref().map(|run| run.run_id.as_str()),
            Some("run-1")
        );
    }

    #[test]
    fn only_a_real_session_info_title_is_kept() {
        fn info(title: &str) -> Value {
            json!({
                "sessionId": "s1",
                "update": { "sessionUpdate": "session_info_update", "title": title },
            })
        }
        assert_eq!(
            Inner::agent_title(&info("  Fix the build ")),
            Some("Fix the build")
        );
        assert_eq!(Inner::agent_title(&info("   ")), None);
        let handoff = format!("{}chat", legacy_import::PERSONA_HANDOFF_PREFIX);
        assert_eq!(Inner::agent_title(&info(&handoff)), None);
        let chunk = json!({
            "update": { "sessionUpdate": "agent_message_chunk", "title": "no" }
        });
        assert_eq!(Inner::agent_title(&chunk), None);
    }

    fn runtime(harness: &str, bridge_session_id: &str, generation: u64) -> SessionRuntime {
        SessionRuntime {
            harness: harness.to_string(),
            bridge_session_id: bridge_session_id.to_string(),
            generation,
            loading: false,
            run: None,
            steer_queue: VecDeque::new(),
            snapshot: Value::Null,
            has_model_option: false,
            substitutions: Vec::new(),
        }
    }

    #[test]
    fn a_chat_that_let_go_of_its_bridge_session_does_not_resume_it() {
        let mut record = SessionRecord {
            id: "session-1".to_string(),
            harness: "claude-acp".to_string(),
            bridge_session_id: Some("bridge-1".to_string()),
            cwd: "C:\\work".to_string(),
            title: None,
            user_set_name: false,
            project_id: None,
            persona_id: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: None,
            legacy_model_id: None,
            hidden: false,
            created_at: "2026-09-11T00:00:00.000Z".to_string(),
            updated_at: "2026-09-11T00:00:00.000Z".to_string(),
            last_message_at: None,
            archived_at: None,
            message_count: 0,
            last_snippet: None,
            snapshot: None,
        };
        assert_eq!(
            Inner::resumable_bridge_session(&record),
            Some("bridge-1"),
            "an attach resumes the bridge session the row names"
        );

        // What `release_bridge_session` leaves behind after a folder move: the
        // bridge session it ran in is gone for good, so the attach has to open a
        // new one in the new folder instead of loading the old one — never the
        // chat's own id, which for an imported chat *is* the old bridge session.
        record.bridge_session_id = None;
        assert_eq!(Inner::resumable_bridge_session(&record), None);
        record.bridge_session_id = Some(String::new());
        assert_eq!(Inner::resumable_bridge_session(&record), None);
    }

    #[test]
    fn a_session_still_being_attached_has_no_route() {
        let mut loading = runtime("claude-acp", "stored-id", 7);
        loading.loading = true;
        assert_eq!(loading.route(), None);
        loading.loading = false;
        assert_eq!(
            loading.route(),
            Some(("claude-acp".to_string(), "stored-id".to_string(), 7))
        );
    }

    #[test]
    fn only_the_sessions_of_the_bridge_that_died_are_forgotten() {
        let old = runtime("claude-acp", "a", 1);
        let replacement = runtime("claude-acp", "b", 2);
        let other_harness = runtime("codex-acp", "c", 1);

        // The crashed process is generation 1: its own session goes, the one
        // already re-attached to the replacement stays, and a same-generation
        // session of another harness is none of its business.
        assert!(old.served_by("claude-acp", 1));
        assert!(!replacement.served_by("claude-acp", 1));
        assert!(!other_harness.served_by("claude-acp", 1));
    }

    #[test]
    fn an_answer_goes_to_the_socket_that_asked_and_nowhere_else() {
        let (socket_a, mut heard_a) = mpsc::unbounded_channel::<String>();
        let (_socket_b, mut heard_b) = mpsc::unbounded_channel::<String>();
        Inner::reply_on(
            &socket_a,
            "session/new",
            protocol::response(json!(0), json!({ "sessionId": "s1" })),
        );
        assert!(heard_a.try_recv().is_ok());
        assert!(heard_b.try_recv().is_err());

        // The renderer gave up on that socket: its answer is dropped rather
        // than delivered to the next connection, where id 0 is another call.
        drop(heard_a);
        Inner::reply_on(
            &socket_a,
            "session/new",
            protocol::response(json!(0), json!({ "sessionId": "s2" })),
        );
        assert!(heard_b.try_recv().is_err());
    }

    #[test]
    fn stopping_a_turn_forgets_the_messages_steered_into_it() {
        let mut live = runtime("claude-acp", "a", 1);
        live.run = Some(RunState::start(&ids()));
        for _ in 0..2 {
            live.steer_queue.push_back(QueuedPrompt {
                prompt: json!([{ "type": "text", "text": "also this" }]),
                meta: json!({}),
                ids: TurnIds::new(),
            });
        }

        assert_eq!(live.drop_queued_steers(), 2);
        assert!(live.steer_queue.is_empty());
        // Cancelling does not end the turn itself: its `session/prompt` is
        // still in flight and its run state still stamps the updates arriving.
        assert!(live.run.is_some());
        assert_eq!(live.drop_queued_steers(), 0);
    }

    #[test]
    fn a_burst_of_updates_is_stored_per_chat_without_reordering_the_log() {
        let chunk = |text: &str| json!({ "update": { "content": { "text": text } } });
        let grouped = Inner::group_events_by_session(vec![
            ("a".to_string(), chunk("a1")),
            ("a".to_string(), chunk("a2")),
            // Another chat streaming at the same time: merging across it would
            // put "a3" in the log before "b1", which is not the order the
            // updates arrived in.
            ("b".to_string(), chunk("b1")),
            ("a".to_string(), chunk("a3")),
        ]);

        let shape: Vec<(&str, Vec<&str>)> = grouped
            .iter()
            .map(|(session_id, payloads)| {
                (
                    session_id.as_str(),
                    payloads
                        .iter()
                        .map(|payload| payload["update"]["content"]["text"].as_str().unwrap_or(""))
                        .collect(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                ("a", vec!["a1", "a2"]),
                ("b", vec!["b1"]),
                ("a", vec!["a3"])
            ]
        );
        assert!(Inner::group_events_by_session(Vec::new()).is_empty());
    }

    #[test]
    fn a_rejected_prompt_is_withdrawn_only_on_proof_that_its_turn_produced_nothing() {
        let mut live = runtime("claude-acp", "a", 1);
        live.run = Some(RunState::start(&ids()));

        // The bridge answered the prompt with an error and sent nothing at all:
        // the turn never happened, so the message comes back out of the log.
        assert!(Inner::turn_produced_nothing(Some(&live), "run-1"));

        // One update is enough to make it a turn that happened.
        live.run.as_mut().expect("run").saw_update = true;
        assert!(!Inner::turn_produced_nothing(Some(&live), "run-1"));

        // The bridge died mid-turn: `fail_pending_on_exit` failed the prompt and
        // the `Exited` behind it removed the runtime while the turn was still
        // unwinding. The reply it streamed is in the transcript, so the absence
        // of evidence must not be read as "nothing happened".
        assert!(!Inner::turn_produced_nothing(None, "run-1"));

        // Same for a runtime that is no longer running this turn, or is running
        // the next one.
        live.run = None;
        assert!(!Inner::turn_produced_nothing(Some(&live), "run-1"));
        live.run = Some(RunState::start(&TurnIds::new()));
        assert!(!Inner::turn_produced_nothing(Some(&live), "run-1"));
    }

    #[test]
    fn a_turn_nobody_awaits_reports_its_end_as_a_cleared_active_run() {
        let update = Inner::run_settled_update("s1");
        assert_eq!(update["sessionId"], "s1");
        assert_eq!(update["update"]["sessionUpdate"], "session_info_update");
        // `acpSessionInfoUpdate.ts` keys off `"activeRunId" in meta` and treats
        // a non-string as null, so the key has to be present and explicitly
        // null rather than omitted.
        let meta = &update["update"]["_meta"];
        assert!(meta
            .as_object()
            .is_some_and(|meta| meta.get("activeRunId").is_some_and(Value::is_null)));
    }

    #[test]
    fn a_request_nobody_can_answer_is_cancelled_or_failed() {
        assert_eq!(
            Inner::unanswered_client_request("session/request_permission"),
            Ok(json!({ "outcome": { "outcome": "cancelled" } }))
        );
        assert!(Inner::unanswered_client_request("fs/read_text_file").is_err());
    }
}
