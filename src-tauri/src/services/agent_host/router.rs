//! The agent host proper: a local WebSocket endpoint speaking ACP to the
//! renderer, routed onto one bridge process per harness, with sessions,
//! history, and settings persisted in SQLite.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
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
use super::sources::SourceRoots;
use super::store::{SessionRecord, SessionStore, SessionTouchUndo};
use crate::services::managed_acp_tools;

const SESSION_PAGE_SIZE: i64 = 200;
/// How long a chat has to stay on screen before its agent is woken in the
/// background. Clicking through the list attaches nothing; the prompt path
/// attaches on demand regardless.
const BACKGROUND_ATTACH_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);
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
        // Probe sessions and history replays we asked for are not surfaced to
        // the renderer.
        let session_id = self.host_session_for(harness, &bridge_session_id).await?;
        let mut persist = false;
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
            }
        }
        params["sessionId"] = json!(session_id);
        let stored = if persist {
            // A title the agent proposes is a session-list field, not a log
            // entry, and one arrives per chat rather than per chunk.
            if let Some(title) = Self::agent_title(&params) {
                if let Err(error) = self.store.set_agent_title(&session_id, title).await {
                    log::warn!("[agent-host] failed to store the agent's title: {error}");
                }
            }
            Some((session_id, params.clone()))
        } else {
            None
        };
        self.notify_frontend("session/update", params);
        stored
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

    fn current_model(snapshot: &Value) -> Option<String> {
        snapshot
            .pointer("/models/currentModelId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                snapshot["configOptions"]
                    .as_array()?
                    .iter()
                    .find_map(|option| {
                        let is_model = option.get("id").and_then(Value::as_str) == Some("model")
                            || option.get("category").and_then(Value::as_str) == Some("model");
                        if is_model {
                            option
                                .get("currentValue")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        } else {
                            None
                        }
                    })
            })
    }

    /// The renderer reads the active provider and model out of select config
    /// options. Bridges expose neither a provider option nor (always) a model
    /// option, so synthesize them from what we know.
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
        let (bridge, bridge_session_id, snapshot) =
            self.open_bridge_session(spec, &cwd, mcp_servers).await?;
        let session_id = bridge_session_id.clone();
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
            },
        );
        let mut response = Self::presented_snapshot(&harness_id, &snapshot, has_model_option);
        response["sessionId"] = json!(session_id);
        response["_meta"] = json!({ "providerId": harness_id });
        Ok(response)
    }

    /// Start a fresh session on `spec`'s bridge in `cwd` with the configured
    /// agent mode applied. Returns the bridge process that accepted it, the
    /// bridge's session id and the snapshot the bridge answered with.
    async fn open_bridge_session(
        &self,
        spec: &HarnessSpec,
        cwd: &str,
        mcp_servers: Vec<Value>,
    ) -> Result<(Arc<Bridge>, String, Value), Value> {
        let bridge = self.ensure_bridge(spec.id).await?;
        let result = bridge
            .request(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": mcp_servers }),
            )
            .await?;
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
        let current = self
            .store
            .get_session(&record.id)
            .await
            .map_err(protocol::internal)?
            .ok_or_else(|| invalid_params(format!("Unknown session {}", record.id)))?;
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
        if let Some(resume_id) = Self::resumable_bridge_session(record)
            .filter(|_| bridge.supports_load_session())
            .map(str::to_string)
        {
            match bridge
                .request(
                    "session/load",
                    json!({ "sessionId": resume_id, "cwd": record.cwd, "mcpServers": mcp_servers }),
                )
                .await
            {
                Ok(result) => {
                    resumed = true;
                    let loaded = Self::snapshot_from(&result);
                    if !loaded["configOptions"]
                        .as_array()
                        .map(Vec::is_empty)
                        .unwrap_or(true)
                        || !loaded["models"].is_null()
                    {
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
            let result = bridge
                .request(
                    "session/new",
                    json!({ "cwd": record.cwd, "mcpServers": mcp_servers }),
                )
                .await?;
            bridge_session_id = protocol::session_id(&result)
                .ok_or_else(|| protocol::internal("bridge returned no sessionId"))?;
            let fresh = Self::snapshot_from(&result);
            if !fresh["configOptions"]
                .as_array()
                .map(Vec::is_empty)
                .unwrap_or(true)
                || !fresh["models"].is_null()
            {
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
        if let Some(model_id) = record.model_id.as_deref() {
            if Self::current_model(&snapshot).as_deref() != Some(model_id) {
                let _ = self
                    .apply_model(
                        bridge,
                        &bridge_session_id,
                        model_id,
                        Self::has_model_option(&snapshot),
                    )
                    .await;
            }
        }
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
            }
        }
        Ok((Arc::clone(bridge), bridge_session_id))
    }

    async fn load_session(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let mut record = self
            .store
            .get_session(&session_id)
            .await
            .map_err(protocol::internal)?
            .ok_or_else(|| invalid_params(format!("Unknown session {session_id}")))?;
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
        let (snapshot, has_model_option) = match self.runtime_snapshot(&session_id).await {
            Some(live) if attached => live,
            _ => {
                let stored = record
                    .snapshot
                    .clone()
                    .unwrap_or_else(|| Self::snapshot_from(&Value::Null));
                let has_model_option = Self::has_model_option(&stored);
                (stored, has_model_option)
            }
        };
        let mut response = Self::presented_snapshot(&record.harness, &snapshot, has_model_option);
        response["_meta"] = json!({ "providerId": record.harness });
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

    async fn runtime_snapshot(&self, session_id: &str) -> Option<(Value, bool)> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(session_id)
            .map(|runtime| (runtime.snapshot.clone(), runtime.has_model_option))
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
        let Some((snapshot, has_model_option)) = self.runtime_snapshot(&record.id).await else {
            return;
        };
        let presented = Self::presented_snapshot(&harness, &snapshot, has_model_option);
        if presented["configOptions"] == presented_before {
            return;
        }
        self.notify_frontend(
            "session/update",
            json!({
                "sessionId": record.id,
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": presented["configOptions"],
                },
            }),
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

    async fn fork_session(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let record = self
            .store
            .get_session(&session_id)
            .await
            .map_err(protocol::internal)?
            .ok_or_else(|| invalid_params(format!("Unknown session {session_id}")))?;
        let mut meta = json!({ "provider": record.harness });
        if let Some(project_id) = &record.project_id {
            meta["projectId"] = json!(project_id);
        }
        if let Some(persona_id) = &record.persona_id {
            meta["personaId"] = json!(persona_id);
        }
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
        let record = self
            .store
            .get_session(&session_id)
            .await
            .map_err(protocol::internal)?
            .ok_or_else(|| invalid_params(format!("Unknown session {session_id}")))?;
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

    async fn apply_model(
        &self,
        bridge: &Bridge,
        bridge_session_id: &str,
        model_id: &str,
        has_model_option: bool,
    ) -> Result<Value, Value> {
        if has_model_option {
            bridge
                .request(
                    "session/set_config_option",
                    json!({ "sessionId": bridge_session_id, "configId": "model", "value": model_id }),
                )
                .await
        } else {
            bridge
                .request(
                    "session/set_model",
                    json!({ "sessionId": bridge_session_id, "modelId": model_id }),
                )
                .await
        }
    }

    async fn set_config_option(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let config_id = params
            .get("configId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let record = self
            .store
            .get_session(&session_id)
            .await
            .map_err(protocol::internal)?
            .ok_or_else(|| invalid_params(format!("Unknown session {session_id}")))?;
        if config_id == "provider" {
            let requested = params.get("value").and_then(Value::as_str).unwrap_or("");
            if requested != record.harness {
                return self.move_to_harness(&session_id, requested).await;
            }
        }
        let (bridge, bridge_session_id) = self.attach_session(&record).await?;
        let (mut snapshot, has_model_option) = {
            let sessions = self.sessions.lock().await;
            let runtime = sessions
                .get(&session_id)
                .ok_or_else(|| protocol::internal("session vanished"))?;
            (runtime.snapshot.clone(), runtime.has_model_option)
        };
        match config_id.as_str() {
            // Already on the requested harness (a move returned above).
            "provider" => {}
            "model" => {
                let model_id = params
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let result = self
                    .apply_model(&bridge, &bridge_session_id, &model_id, has_model_option)
                    .await?;
                if has_model_option {
                    if let Some(options) = result.get("configOptions") {
                        snapshot["configOptions"] = options.clone();
                    }
                } else if let Some(models) =
                    snapshot.get_mut("models").and_then(Value::as_object_mut)
                {
                    models.insert("currentModelId".to_string(), json!(model_id));
                }
                let _ = self.store.set_model(&session_id, Some(&model_id)).await;
            }
            _ => {
                let mut forwarded = params.clone();
                forwarded["sessionId"] = json!(bridge_session_id);
                let result = bridge
                    .request("session/set_config_option", forwarded)
                    .await?;
                if let Some(options) = result.get("configOptions") {
                    snapshot["configOptions"] = options.clone();
                }
            }
        }
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.get_mut(&session_id) {
                runtime.snapshot = snapshot.clone();
            }
        }
        let _ = self.store.set_snapshot(&session_id, &snapshot).await;
        Ok(Self::presented_snapshot(
            &record.harness,
            &snapshot,
            has_model_option,
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
        let record = self
            .store
            .get_session(session_id)
            .await
            .map_err(protocol::internal)?
            .ok_or_else(|| invalid_params(format!("Unknown session {session_id}")))?;
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
            .open_bridge_session(spec, &record.cwd, mcp_servers)
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
        let record = self
            .store
            .get_session(&session_id)
            .await
            .map_err(protocol::internal)?
            .ok_or_else(|| invalid_params(format!("Unknown session {session_id}")))?;
        let (bridge, bridge_session_id) = self.attach_session(&record).await?;
        let prompt = params
            .get("prompt")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        let meta = params.get("_meta").cloned().unwrap_or_else(|| json!({}));
        {
            let mut sessions = self.sessions.lock().await;
            let runtime = sessions
                .get_mut(&session_id)
                .ok_or_else(|| protocol::internal("session vanished"))?;
            if let Some(active) = runtime.run.as_ref() {
                if steer {
                    runtime
                        .steer_queue
                        .push_back(QueuedPrompt { prompt, meta, ids });
                    return Ok(json!({}));
                }
                return Err(protocol::error_with_data(
                    protocol::INVALID_PARAMS,
                    "A prompt is already running for this session",
                    json!({ "actualRunId": active.run_id }),
                ));
            }
            runtime.run = Some(RunState::start(&ids));
        }
        let recorded = self
            .record_user_prompt(&session_id, &prompt, &meta, &ids, steer)
            .await;
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

    /// Session ids of every live session on `harness` (used to answer
    /// per-session extension queries).
    pub async fn session_record(&self, session_id: &str) -> Result<SessionRecord, Value> {
        self.store
            .get_session(session_id)
            .await
            .map_err(protocol::internal)?
            .ok_or_else(|| invalid_params(format!("Unknown session {session_id}")))
    }

    /// Open a throwaway session to learn which models a harness offers.
    pub async fn probe_models(self: &Arc<Self>, harness_id: &str) -> Result<Vec<Value>, Value> {
        let bridge = self.ensure_bridge(harness_id).await?;
        let cwd = dirs::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string());
        let result = bridge
            .request("session/new", json!({ "cwd": cwd, "mcpServers": [] }))
            .await?;
        // Nothing will ever prompt this session: hand it straight back so the
        // probe does not leave one behind on the bridge every time the model
        // list is refreshed.
        if let Some(probe_session_id) = protocol::session_id(&result) {
            bridge.close_session(&probe_session_id).await;
        }
        let mut models: Vec<Value> = result
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|model| {
                        let id = model.get("modelId").and_then(Value::as_str)?;
                        Some(json!({
                            "id": id,
                            "name": model.get("name").and_then(Value::as_str).unwrap_or(id),
                        }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if models.is_empty() {
            if let Some(options) = result.get("configOptions").and_then(Value::as_array) {
                for option in options {
                    let is_model = option.get("id").and_then(Value::as_str) == Some("model")
                        || option.get("category").and_then(Value::as_str) == Some("model");
                    if !is_model {
                        continue;
                    }
                    if let Some(choices) = option.get("options").and_then(Value::as_array) {
                        for choice in choices {
                            if let Some(value) = choice.get("value").and_then(Value::as_str) {
                                models.push(json!({
                                    "id": value,
                                    "name": choice.get("name").and_then(Value::as_str).unwrap_or(value),
                                }));
                            }
                        }
                    }
                }
            }
        }
        Ok(models)
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
