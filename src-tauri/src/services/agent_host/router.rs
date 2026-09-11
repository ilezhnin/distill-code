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
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::bridge::{error_text, Bridge, BridgeEvent, SpawnEnv};
use super::ext;
use super::harness::{self, HarnessSpec};
use super::harness_env::build_spawn_env;
use super::legacy_import;
use super::protocol::{self, invalid_params, now_iso, Message};
use super::sources::SourceRoots;
use super::store::{SessionRecord, SessionStore};
use crate::services::managed_acp_tools;

const SESSION_PAGE_SIZE: i64 = 200;
/// How long a chat has to stay on screen before its agent is woken in the
/// background. Clicking through the list attaches nothing; the prompt path
/// attaches on demand regardless.
const BACKGROUND_ATTACH_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);
const SNIPPET_CHARS: usize = 200;
pub const EXT_PREFIX: &str = "_distill/";

struct RunState {
    run_id: String,
    message_id: String,
    agent_text: String,
    saw_agent_message: bool,
}

struct QueuedPrompt {
    prompt: Value,
    meta: Value,
    message_id: String,
    run_id: String,
}

pub struct SessionRuntime {
    pub harness: String,
    pub bridge_session_id: String,
    loading: bool,
    run: Option<RunState>,
    steer_queue: VecDeque<QueuedPrompt>,
    /// `{ modes, models, configOptions }` as last reported by the bridge.
    snapshot: Value,
    has_model_option: bool,
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
    client_requests: StdMutex<HashMap<u64, (String, Value)>>,
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
        {
            if let Ok(mut frontend) = self.frontend.lock() {
                *frontend = Some(tx.clone());
            }
        }
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
                    tokio::spawn(async move { host.handle_frontend_line(line).await });
                }
                Ok(WsMessage::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
        if let Ok(mut frontend) = self.frontend.lock() {
            if frontend
                .as_ref()
                .is_some_and(|current| current.same_channel(&tx))
            {
                *frontend = None;
            }
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

    async fn handle_frontend_line(self: Arc<Self>, line: String) {
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
                self.send_to_frontend(reply);
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
                if let Some((harness, bridge_session_id)) = self.runtime_route(&session_id).await {
                    if let Some(bridge) = self.bridges.lock().await.get(&harness).cloned() {
                        let mut params = params.clone();
                        params["sessionId"] = json!(bridge_session_id);
                        bridge.notify(method, params);
                    }
                }
            }
        }
    }

    async fn handle_client_response(&self, id: Value, result: Result<Value, Value>) {
        let mapping = id
            .as_u64()
            .and_then(|key| self.client_requests.lock().ok()?.remove(&key));
        let Some((harness, bridge_id)) = mapping else {
            log::warn!("[agent-host] response for unknown client request {id}");
            return;
        };
        if let Some(bridge) = self.bridges.lock().await.get(&harness).cloned() {
            bridge.respond(bridge_id, result);
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

    async fn bridge_event_loop(self: Arc<Self>, mut events: mpsc::UnboundedReceiver<BridgeEvent>) {
        while let Some(event) = events.recv().await {
            match event {
                BridgeEvent::Notification {
                    harness,
                    method,
                    params,
                } => self.on_bridge_notification(&harness, &method, params).await,
                BridgeEvent::Request {
                    harness,
                    id,
                    method,
                    params,
                } => self.on_bridge_request(&harness, id, &method, params).await,
                BridgeEvent::Exited { harness } => {
                    log::warn!("[agent-host] {harness} bridge exited");
                    let mut bridges = self.bridges.lock().await;
                    if bridges
                        .get(&harness)
                        .is_some_and(|bridge| !bridge.is_alive())
                    {
                        bridges.remove(&harness);
                    }
                    drop(bridges);
                    let mut sessions = self.sessions.lock().await;
                    sessions.retain(|_, runtime| runtime.harness != harness);
                }
            }
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

    async fn runtime_route(&self, session_id: &str) -> Option<(String, String)> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(session_id)
            .map(|runtime| (runtime.harness.clone(), runtime.bridge_session_id.clone()))
    }

    async fn on_bridge_notification(&self, harness: &str, method: &str, mut params: Value) {
        if method != "session/update" {
            self.notify_frontend(method, params);
            return;
        }
        let Some(bridge_session_id) = protocol::session_id(&params) else {
            return;
        };
        let Some(session_id) = self.host_session_for(harness, &bridge_session_id).await else {
            // Probe sessions and history replays we asked for are not
            // surfaced to the renderer.
            return;
        };
        let mut persist = false;
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.get_mut(&session_id) {
                if runtime.loading {
                    return;
                }
                persist = true;
                if let Some(run) = runtime.run.as_mut() {
                    let update = params.get("update").cloned().unwrap_or(Value::Null);
                    let kind = update
                        .get("sessionUpdate")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if kind == "agent_message_chunk" {
                        run.saw_agent_message = true;
                        if let Some(text) = update.pointer("/content/text").and_then(Value::as_str)
                        {
                            if run.agent_text.chars().count() < SNIPPET_CHARS * 2 {
                                run.agent_text.push_str(text);
                            }
                        }
                    }
                    let meta = params["update"]
                        .get("_meta")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    let mut meta = meta;
                    meta.insert(
                        "distill".to_string(),
                        json!({ "messageId": run.message_id, "runId": run.run_id, "created": now_iso() }),
                    );
                    if let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) {
                        update.insert("_meta".to_string(), Value::Object(meta));
                    }
                }
            }
        }
        params["sessionId"] = json!(session_id);
        if persist {
            if let Err(error) = self.store.append_event(&session_id, &params).await {
                log::warn!("[agent-host] failed to persist session update: {error}");
            }
        }
        self.notify_frontend("session/update", params);
    }

    async fn on_bridge_request(&self, harness: &str, id: Value, method: &str, mut params: Value) {
        if let Some(bridge_session_id) = protocol::session_id(&params) {
            if let Some(session_id) = self.host_session_for(harness, &bridge_session_id).await {
                params["sessionId"] = json!(session_id);
            }
        }
        let request_id = self.next_client_request_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut pending) = self.client_requests.lock() {
            pending.insert(request_id, (harness.to_string(), id.clone()));
        }
        let has_frontend = self.frontend.lock().map(|f| f.is_some()).unwrap_or(false);
        if !has_frontend {
            // Nobody to ask: cancel the request so the bridge does not hang.
            if let Ok(mut pending) = self.client_requests.lock() {
                pending.remove(&request_id);
            }
            if let Some(bridge) = self.bridges.lock().await.get(harness).cloned() {
                bridge.respond(id, Ok(json!({ "outcome": { "outcome": "cancelled" } })));
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
        let bridge = self.ensure_bridge(&harness_id).await?;
        let mcp_servers = self.mcp_servers(&params["mcpServers"]).await;
        let result = bridge
            .request(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": mcp_servers }),
            )
            .await?;
        let bridge_session_id = protocol::session_id(&result)
            .ok_or_else(|| protocol::internal("bridge returned no sessionId"))?;
        let session_id = bridge_session_id.clone();
        self.apply_mode(&bridge, spec, &bridge_session_id).await;

        let snapshot = Self::snapshot_from(&result);
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
        self.store
            .insert_session(&record)
            .await
            .map_err(protocol::internal)?;
        self.sessions.lock().await.insert(
            session_id.clone(),
            SessionRuntime {
                harness: harness_id.clone(),
                bridge_session_id,
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

    /// Make sure a stored session has a live bridge session behind it,
    /// (re)attaching after a bridge restart or an app restart.
    async fn attach_session(
        self: &Arc<Self>,
        record: &SessionRecord,
    ) -> Result<(Arc<Bridge>, String), Value> {
        let lock = Arc::clone(
            self.attach_locks
                .lock()
                .await
                .entry(record.id.clone())
                .or_default(),
        );
        let _attaching = lock.lock().await;
        if let Some(attached) = self.attached_route(&record.id).await {
            return Ok(attached);
        }
        self.attach_session_locked(record).await
    }

    /// The live bridge behind a session, when it is already attached and the
    /// bridge process is still running. Never attaches.
    async fn attached_route(&self, session_id: &str) -> Option<(Arc<Bridge>, String)> {
        // Never hold the session map while waiting for the bridge map: the
        // bridge event loop needs the session map for every update it routes.
        let (harness, bridge_session_id) = self.runtime_route(session_id).await?;
        let bridge = self.live_bridge(&harness).await?;
        Some((bridge, bridge_session_id))
    }

    async fn attach_session_locked(
        self: &Arc<Self>,
        record: &SessionRecord,
    ) -> Result<(Arc<Bridge>, String), Value> {
        let spec = harness::harness(&record.harness)
            .ok_or_else(|| invalid_params(format!("Unknown harness {}", record.harness)))?;
        let bridge = self.ensure_bridge(&record.harness).await?;
        let mcp_servers = self.mcp_servers(&Value::Null).await;
        let stored_bridge_id = record
            .bridge_session_id
            .clone()
            .unwrap_or_else(|| record.id.clone());
        let mut snapshot = record
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
                loading: true,
                run: None,
                steer_queue: VecDeque::new(),
                snapshot: snapshot.clone(),
                has_model_option: Self::has_model_option(&snapshot),
            },
        );

        let mut bridge_session_id = stored_bridge_id.clone();
        let mut resumed = false;
        if bridge.supports_load_session() {
            match bridge
                .request(
                    "session/load",
                    json!({ "sessionId": stored_bridge_id, "cwd": record.cwd, "mcpServers": mcp_servers }),
                )
                .await
            {
                Ok(result) => {
                    resumed = true;
                    let loaded = Self::snapshot_from(&result);
                    if !loaded["configOptions"].as_array().map(Vec::is_empty).unwrap_or(true) || !loaded["models"].is_null() {
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
                .set_bridge_session_id(&record.id, &bridge_session_id)
                .await
            {
                log::warn!("[agent-host] failed to record bridge session id: {error}");
            }
        }
        self.apply_mode(&bridge, spec, &bridge_session_id).await;
        if let Some(model_id) = record.model_id.as_deref() {
            if Self::current_model(&snapshot).as_deref() != Some(model_id) {
                let _ = self
                    .apply_model(
                        &bridge,
                        &bridge_session_id,
                        model_id,
                        Self::has_model_option(&snapshot),
                    )
                    .await;
            }
        }
        let has_model_option = Self::has_model_option(&snapshot);
        let _ = self.store.set_snapshot(&record.id, &snapshot).await;
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.get_mut(&record.id) {
                runtime.bridge_session_id = bridge_session_id.clone();
                runtime.loading = false;
                runtime.snapshot = snapshot;
                runtime.has_model_option = has_model_option;
            }
        }
        Ok((bridge, bridge_session_id))
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
            }
        }
        // The transcript is ours: replay it from the local log and answer
        // right away. Waking the agent behind the session (spawning its
        // bridge, resuming its own context) is only needed for the next
        // prompt, so it happens in the background — the user may just read
        // the chat and never send anything.
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
        let Some((snapshot, has_model_option)) = self.runtime_snapshot(&record.id).await else {
            return;
        };
        let presented = Self::presented_snapshot(&record.harness, &snapshot, has_model_option);
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
        self.sessions.lock().await.remove(&session_id);
        self.attach_locks.lock().await.remove(&session_id);
        self.store
            .delete_session(&session_id)
            .await
            .map_err(protocol::internal)?;
        Ok(json!({}))
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
        self.store
            .copy_events(&session_id, &new_id)
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
        let (bridge, bridge_session_id) = self.attach_session(&record).await?;
        let (mut snapshot, has_model_option) = {
            let sessions = self.sessions.lock().await;
            let runtime = sessions
                .get(&session_id)
                .ok_or_else(|| protocol::internal("session vanished"))?;
            (runtime.snapshot.clone(), runtime.has_model_option)
        };
        match config_id.as_str() {
            "provider" => {
                let requested = params.get("value").and_then(Value::as_str).unwrap_or("");
                if requested != record.harness {
                    return Err(invalid_params(format!(
                        "Session {session_id} runs on {}; start a new chat to use {requested}",
                        record.harness
                    )));
                }
            }
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

    async fn record_user_prompt(
        &self,
        session_id: &str,
        prompt: &Value,
        meta: &Value,
        message_id: &str,
        run_id: &str,
    ) {
        let created = now_iso();
        let mut distill = json!({ "messageId": message_id, "runId": run_id, "created": created });
        if let Some(persona_id) = meta.get("personaId") {
            distill["personaId"] = persona_id.clone();
        }
        let mut update_meta = meta.as_object().cloned().unwrap_or_default();
        update_meta.insert("distill".to_string(), distill);
        for block in prompt.as_array().cloned().unwrap_or_default() {
            let event = json!({
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": block,
                    "_meta": Value::Object(update_meta.clone()),
                }
            });
            if let Err(error) = self.store.append_event(session_id, &event).await {
                log::warn!("[agent-host] failed to persist prompt: {error}");
            }
        }
        let snippet = Self::snippet(&Self::prompt_text(prompt));
        let _ = self.store.touch(session_id, 1, snippet.as_deref()).await;
        if snippet.is_none() {
            let _ = self.store.touch(session_id, 0, None).await;
        }
    }

    async fn prompt(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
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
        let run_id = uuid::Uuid::new_v4().to_string();
        let message_id = uuid::Uuid::new_v4().to_string();
        {
            let mut sessions = self.sessions.lock().await;
            let runtime = sessions
                .get_mut(&session_id)
                .ok_or_else(|| protocol::internal("session vanished"))?;
            if runtime.run.is_some() {
                return Err(protocol::error_with_data(
                    protocol::INVALID_PARAMS,
                    "A prompt is already running for this session",
                    json!({ "actualRunId": runtime.run.as_ref().map(|run| run.run_id.clone()) }),
                ));
            }
            runtime.run = Some(RunState {
                run_id: run_id.clone(),
                message_id: message_id.clone(),
                agent_text: String::new(),
                saw_agent_message: false,
            });
        }
        self.record_user_prompt(&session_id, &prompt, &meta, &message_id, &run_id)
            .await;
        let mut result = self
            .run_prompt(&bridge, &session_id, &bridge_session_id, prompt, meta)
            .await;
        // Steering while the turn ran: send the queued messages one after the
        // other so the agent sees them in order.
        loop {
            let queued = {
                let mut sessions = self.sessions.lock().await;
                let Some(runtime) = sessions.get_mut(&session_id) else {
                    break;
                };
                let Some(queued) = runtime.steer_queue.pop_front() else {
                    runtime.run = None;
                    break;
                };
                runtime.run = Some(RunState {
                    run_id: queued.run_id.clone(),
                    message_id: queued.message_id.clone(),
                    agent_text: String::new(),
                    saw_agent_message: false,
                });
                queued
            };
            self.record_user_prompt(
                &session_id,
                &queued.prompt,
                &queued.meta,
                &queued.message_id,
                &queued.run_id,
            )
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
        let run_id = uuid::Uuid::new_v4().to_string();
        let message_id = uuid::Uuid::new_v4().to_string();
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
                        message_id: message_id.clone(),
                        run_id: run_id.clone(),
                    });
                    true
                }
                None => false,
            }
        };
        if !queued {
            let host = Arc::clone(self);
            let session = session_id.clone();
            tokio::spawn(async move {
                if let Err(error) = host
                    .prompt(json!({ "sessionId": session, "prompt": prompt, "_meta": meta }))
                    .await
                {
                    log::warn!("[agent-host] steer prompt failed: {}", error_text(&error));
                }
            });
        }
        Ok(json!({ "runId": run_id, "messageId": message_id }))
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
