//! The host as the app sees it: the socket, requests and notifications from the frontend, and what a closing app leaves.
use super::*;
use crate::services::agent_host::bridge::{CancelOutcome, OpenTurn};

/// The order frames reach the host in, over every renderer socket. A prompt
/// and a Stop of one chat are handled by tasks of their own, which run in any
/// order; their arrivals tell which the operator sent first.
static ARRIVALS: AtomicU64 = AtomicU64::new(1);

/// The `_meta` key a frame's arrival travels under from the socket to the
/// prompt or Stop it belongs to. Taken out before anything else reads
/// `_meta`, so it is never recorded or sent to a bridge.
const ARRIVAL_KEY: &str = "distillArrival";

/// Where each chat's latest Stop that found no claimed turn arrived. A Stop
/// pressed while a prompt is still on its way to its claim (a dormant chat's
/// bridge starting, its session loading) finds no turn to stop, and its
/// cancel went to an idle agent that then ran the whole turn (2026-11-25
/// hunt, D-2). The turn of a prompt that arrived before such a Stop is
/// stopped at its claim, before its prompt is written (`stopped_after`); a
/// prompt sent after the Stop is not, whichever task gets there first.
static STOPS_WITHOUT_TURN: std::sync::LazyLock<StdMutex<HashMap<String, u64>>> =
    std::sync::LazyLock::new(Default::default);

fn stops_without_turn() -> std::sync::MutexGuard<'static, HashMap<String, u64>> {
    STOPS_WITHOUT_TURN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Inner {
    /// Stamps a renderer frame with its arrival; see [`ARRIVAL_KEY`].
    pub(super) fn stamp_arrival(params: &mut Value, arrival: u64) {
        let Some(params) = params.as_object_mut() else {
            return;
        };
        if let Some(meta) = params
            .entry("_meta")
            .or_insert_with(|| json!({}))
            .as_object_mut()
        {
            meta.insert(ARRIVAL_KEY.into(), json!(arrival));
        }
    }

    /// Takes a frame's arrival back out of its params.
    pub(super) fn take_arrival(params: &mut Value) -> Option<u64> {
        params
            .get_mut("_meta")
            .and_then(Value::as_object_mut)
            .and_then(|meta| meta.remove(ARRIVAL_KEY))
            .and_then(|arrival| arrival.as_u64())
    }

    /// Records a Stop of chat `session_id`, arrived at `arrival`, that found
    /// no claimed turn; see [`STOPS_WITHOUT_TURN`].
    pub(super) fn note_stop_without_turn(session_id: &str, arrival: u64) {
        let mut stops = stops_without_turn();
        let latest = stops.entry(session_id.to_string()).or_default();
        *latest = (*latest).max(arrival);
    }

    /// Whether a Stop that found no claimed turn of chat `session_id` came
    /// after its prompt that arrived at `arrival`: that Stop was meant for
    /// this prompt, which was still on its way to its claim. Never for a
    /// prompt with no arrival (one the host sends itself).
    pub(super) fn stopped_after(session_id: &str, arrival: Option<u64>) -> bool {
        arrival.is_some_and(|arrival| {
            stops_without_turn()
                .get(session_id)
                .is_some_and(|stop| *stop > arrival)
        })
    }

    pub(super) async fn start(app: tauri::AppHandle) -> Result<Arc<Inner>, String> {
        // Migration and seeding finish before opening any source or database.
        app.state::<crate::services::bundled_skills::BundledSkillsState>()
            .wait_until_ready()
            .await;
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
        let flock_root = crate::services::flock_root::app_root(&app)?;
        // An isolated E2E run starts from nothing, and a root the environment
        // forced is not the operator's: neither adopts older data.
        let isolated = !crate::services::flock_root::adoption_enabled(
            app.try_state::<crate::services::e2e_mode::E2eMode>()
                .is_some(),
            crate::services::flock_root::root_override().as_deref(),
        );
        if !isolated {
            crate::services::root_migration::adopt_sessions(
                &flock_root,
                &app_data_dir,
                &app.config().identifier,
            )
            .await?;
        }
        // A sign-in an owned bridge was starting with when Flock stopped
        // goes now, not with the next Grok benchmark.
        if let Err(error) = execution::discard_left_sign_ins(&owned_runtime_root(&flock_root)) {
            log::warn!("[agent-host] benchmark sign-in copies were not removed: {error}");
        }
        let host_dir = flock_root.join("sessions");
        let store = SessionStore::open(&host_dir.join("agent-host.db")).await?;
        store.reconcile_execution_dispatches().await?;
        // No VACUUM here or anywhere else in the running host: before the host
        // listened it kept the window black for four minutes (6.7 GB,
        // 2026-10-25), and from the background it failed every write for
        // three (12 GB, 2026-11-14). `flock-history compact` runs it on a
        // closed database.
        if !isolated {
            match legacy_import::import_goose_sessions_once(&store).await {
                Ok(0) => {}
                Ok(count) => log::info!("[agent-host] imported {count} goose sessions"),
                Err(error) => log::warn!("[agent-host] goose session import failed: {error}"),
            }
        }
        let roots = SourceRoots::new(
            flock_root,
            if isolated {
                None
            } else {
                legacy_goose_projects_dir()
            },
        );

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
            sessions: Mutex::new(SessionTable::default()),
            frontend: StdMutex::new(None),
            client_requests: StdMutex::new(HashMap::new()),
            next_client_request_id: AtomicU64::new(1_000_000),
            events_tx,
            spawn_env: Mutex::new(None),
            kimi_follows: Mutex::new(HashMap::new()),
            attach_locks: Mutex::new(HashMap::new()),
            naming_replies: StdMutex::new(HashMap::new()),
            selection_split: AtomicU8::new(0),
            shutdown_prepared: AtomicBool::new(false),
            owned_locks: Mutex::new(HashMap::new()),
            activity_generations: StdMutex::new(ActivityGenerations::default()),
            owned_sign_in_expiry: StdMutex::new(HashMap::new()),
            sign_in_renewals: SignInRenewals::default(),
        });

        tokio::spawn(Arc::clone(&inner).accept_loop(listener, token));
        tokio::spawn(Arc::clone(&inner).bridge_event_loop(events_rx));
        tokio::spawn(Self::reap_idle_bridges_periodically(Arc::downgrade(&inner)));
        tokio::spawn(Self::compact_history_in_background(Arc::downgrade(&inner)));
        tokio::spawn(Self::follow_kimi_records_periodically(Arc::downgrade(
            &inner,
        )));
        if inner
            .app
            .try_state::<crate::services::e2e_mode::E2eMode>()
            .is_none()
        {
            tokio::spawn(Self::keep_app_sign_ins_alive_periodically(Arc::downgrade(
                &inner,
            )));
        }
        log::info!("[agent-host] listening on 127.0.0.1:{port}");
        Ok(inner)
    }

    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// Stops every bridge as the app quits, and with each owned one what the
    /// host kept for it: the event loop that would otherwise do that may not
    /// run again. A sign-in a bridge still starting was handed goes too.
    pub fn kill_bridges(&self) {
        if let Ok(bridges) = self.bridges.try_lock() {
            for (route, bridge) in bridges.iter() {
                bridge.kill();
                self.forget_owned_bridge(route, bridge.generation());
            }
        }
        if let Err(error) = crate::services::flock_root::app_root(&self.app).and_then(|root| {
            execution::discard_left_sign_ins(&owned_runtime_root(&root))
                .map_err(|error| error.to_string())
        }) {
            log::warn!("[agent-host] benchmark sign-in copies were not removed: {error}");
        }
    }

    // -----------------------------------------------------------------------
    // Frontend socket

    // The handshake callback's error type is tungstenite's `ErrorResponse`.
    #[allow(clippy::result_large_err)]
    pub(super) async fn accept_loop(self: Arc<Self>, listener: TcpListener, token: String) {
        let handshakes = Arc::new(tokio::sync::Semaphore::new(16));
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let Ok(permit) = Arc::clone(&handshakes).try_acquire_owned() else {
                continue;
            };
            let host = Arc::clone(&self);
            let expected = token.clone();
            tokio::spawn(async move {
                let ws = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    tokio_tungstenite::accept_hdr_async_with_config(
                        stream,
                        move |request: &Request, response: Response| {
                            let query = request.uri().query().unwrap_or("");
                            let authorized = query
                                .split('&')
                                .any(|pair| pair.strip_prefix("token=") == Some(expected.as_str()));
                            if authorized {
                                Ok(response)
                            } else {
                                let mut rejection =
                                    ErrorResponse::new(Some("unauthorized".to_string()));
                                *rejection.status_mut() =
                                    tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
                                Err(rejection)
                            }
                        },
                        Some(frontend_socket_config()),
                    ),
                )
                .await;
                drop(permit);
                if let Ok(Ok(ws)) = ws {
                    host.serve_frontend(ws).await;
                }
            });
        }
    }

    pub(super) async fn serve_frontend(
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
                    let arrival = ARRIVALS.fetch_add(1, Ordering::SeqCst);
                    let host = Arc::clone(&self);
                    let line = text.to_string();
                    let reply_to = tx.clone();
                    tokio::spawn(async move {
                        host.handle_frontend_line(line, reply_to, arrival).await
                    });
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
    pub(super) fn reply_on(reply_to: &ReplyTo, method: &str, reply: String) -> bool {
        let delivered = reply_to.send(reply).is_ok();
        if !delivered {
            log::debug!("[agent-host] dropped the answer to {method}: its socket is gone");
        }
        delivered
    }

    /// The chat a request runs a turn of, when its answer is the one thing
    /// that tells the renderer the turn is over.
    pub(super) fn turn_request_session(method: &str, params: &Value) -> Option<String> {
        (method == "session/prompt")
            .then(|| protocol::session_id(params))
            .flatten()
    }

    /// The renderer that sent a turn is gone (it reloaded, or another took
    /// its place) and the answer that would have ended the turn for it was
    /// dropped with its socket. Whoever is connected now still shows the chat
    /// as running (it adopted the host's updates), so it is told the turn is
    /// over the way a steer's own background turn is: `activeRunId: null`.
    pub(super) async fn settle_orphaned_turn(&self, session_id: &str) {
        if self.reported_run_id(session_id).await.is_some() {
            return;
        }
        log::info!(
            "[agent-host] turn of {session_id} ended after its renderer left; settling it for the current one"
        );
        self.notify_frontend("session/update", protocol::run_settled_update(session_id));
    }

    pub(super) async fn handle_frontend_line(
        self: Arc<Self>,
        line: String,
        reply_to: ReplyTo,
        arrival: u64,
    ) {
        let Some(message) = protocol::parse(&line) else {
            log::warn!("[agent-host] unparseable frontend message");
            return;
        };
        match message {
            Message::Request {
                id,
                method,
                mut params,
            } => {
                if method == "session/prompt" {
                    Self::stamp_arrival(&mut params, arrival);
                }
                let turn_of = Self::turn_request_session(&method, &params);
                let result = self.handle_request(&method, params).await;
                let reply = match result {
                    Ok(result) => protocol::response(id, result),
                    Err(error) => protocol::error_response(id, error),
                };
                if !Self::reply_on(&reply_to, &method, reply) {
                    if let Some(session_id) = turn_of {
                        self.settle_orphaned_turn(&session_id).await;
                    }
                }
            }
            Message::Notification { method, mut params } => {
                if method == "session/cancel" {
                    Self::stamp_arrival(&mut params, arrival);
                }
                self.handle_client_notification(&method, params).await;
            }
            Message::Response { id, result } => {
                self.handle_client_response(id, result).await;
            }
        }
    }

    pub(super) async fn handle_client_notification(
        self: &Arc<Self>,
        method: &str,
        mut params: Value,
    ) {
        if let Some(id) = protocol::session_id(&params) {
            if !matches!(self.store.execution_owner(&id).await, Ok(None)) {
                return;
            }
        }
        if method == "session/cancel" {
            // A Stop the host makes itself (a close) arrives now.
            let arrival = Self::take_arrival(&mut params)
                .unwrap_or_else(|| ARRIVALS.fetch_add(1, Ordering::SeqCst));
            if let Some(session_id) = protocol::session_id(&params) {
                // Do not let the next prompt claim the released chat before
                // its predecessor's cancel has gone to the bridge.
                let lock = self.attach_lock(&session_id).await;
                let mut admission = Some(lock.lock().await);
                let (dropped, cancelled_run, kimi) = self
                    .sessions
                    .lock()
                    .await
                    .get_mut(&session_id)
                    .map(|runtime| {
                        let run = runtime.run.as_ref().map(|run| run.run_id.clone());
                        let (dropped, closing) = runtime.stop(&session_id);
                        if let Some(params) = closing {
                            let _ = self.events_tx.send(BridgeEvent::BackgroundFinished {
                                session_id: session_id.clone(),
                                params,
                            });
                        }
                        (dropped, run, runtime.harness == "kimi-acp")
                    })
                    .unwrap_or((0, None, false));
                // No turn to stop yet: a prompt sent before this Stop and
                // still on its way to its claim is stopped when it gets there.
                if cancelled_run.is_none() {
                    Self::note_stop_without_turn(&session_id, arrival);
                }
                if kimi && cancelled_run.is_none() {
                    drop(admission.take()); // The Kimi relay takes the attach lock to close its session.
                    self.stop_kimi_own_turn(&session_id).await;
                }
                if dropped > 0 {
                    log::info!(
                        "[agent-host] session {session_id} cancelled: dropped {dropped} queued steer(s)"
                    );
                }
                if let Some((bridge, bridge_session_id)) = self.attached_route(&session_id).await {
                    let mut params = params.clone();
                    params["sessionId"] = json!(bridge_session_id);
                    // Decided where the turn's prompt is written: a cancel
                    // sent ahead of the prompt found an idle agent, which
                    // then ran the whole turn (2026-11-25 hunt, D-2).
                    match bridge.cancel_turn(cancelled_run.as_deref(), params) {
                        CancelOutcome::Sent => {
                            if let Some(run_id) = cancelled_run {
                                self.end_cancelled_turn_if_unanswered(session_id, run_id, bridge);
                            }
                        }
                        // The turn ends as cancelled where its prompt would
                        // have been written; nothing reached the agent, so
                        // there is no answer to wait for.
                        CancelOutcome::Withheld => log::info!(
                            "[agent-host] session {session_id} stopped before its prompt reached the agent; the prompt is not sent"
                        ),
                        CancelOutcome::Unowned => {
                            if let Some(run_id) = cancelled_run {
                                self.clear_unowned_run(&session_id, &run_id).await;
                            }
                        }
                    }
                }
            }
        }
    }

    /// Stop every ordinary chat a close would cut, for an operator who chose
    /// to close anyway: each is stopped as its Stop button would, and a turn
    /// its agent has not ended within [`CLOSE_STOP_GRACE`] is ended here, as
    /// cancelled. Flock is about to exit, so a stuck agent — one retrying a
    /// spent quota never answers a cancel — is not given the Stop grace and
    /// cannot hold the window open. Benchmark and task turns are not chats;
    /// the benchmark pause handles them. Answers how many chats were stopped.
    pub(super) async fn stop_chats_for_close(self: &Arc<Self>) -> usize {
        let chats: Vec<String> = self
            .sessions
            .lock()
            .await
            .iter()
            .filter(|(_, runtime)| {
                runtime.execution_profile.is_none() && runtime.has_pending_chat_work()
            })
            .map(|(id, _)| id.clone())
            .collect();
        for session_id in &chats {
            self.handle_client_notification("session/cancel", json!({ "sessionId": session_id }))
                .await;
        }
        let deadline = tokio::time::Instant::now() + CLOSE_STOP_GRACE;
        loop {
            let running = self.running_chat_turns().await;
            if running.is_empty() {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                for (session_id, run_id) in running {
                    if let Some((bridge, _)) = self.attached_route(&session_id).await {
                        if bridge.abandon_turn(&run_id) {
                            log::warn!(
                                "[agent-host] {} did not end the turn of {session_id} for the close; ended it as cancelled",
                                bridge.harness
                            );
                        }
                    }
                }
                // Let the abandoned turns record their ends before the exit.
                let settle = tokio::time::Instant::now() + CLOSE_STOP_GRACE;
                while !self.running_chat_turns().await.is_empty()
                    && tokio::time::Instant::now() < settle
                {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        if !chats.is_empty() {
            log::info!(
                "[agent-host] stopped {} active chat(s) to close Flock",
                chats.len()
            );
        }
        chats.len()
    }

    /// The running turns of ordinary chats, as (session, run).
    pub(super) async fn running_chat_turns(&self) -> Vec<(String, String)> {
        self.sessions
            .lock()
            .await
            .iter()
            .filter(|(_, runtime)| runtime.execution_profile.is_none())
            .filter_map(|(id, runtime)| Some((id.clone(), runtime.run.as_ref()?.run_id.clone())))
            .collect()
    }

    /// Stop must end the turn even when the agent will not. A bridge that
    /// ignores `session/cancel` — Codex retrying against a spent quota, an
    /// agent that stopped reading — would keep the turn running forever: the
    /// chat could never be stopped, and the chat that started it waited on
    /// it for good. After [`CANCEL_ANSWER_GRACE`] the host ends the turn
    /// itself, as cancelled, if it is still the one that was stopped.
    pub(super) fn end_cancelled_turn_if_unanswered(
        self: &Arc<Self>,
        session_id: String,
        run_id: String,
        bridge: Arc<Bridge>,
    ) {
        let host = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(CANCEL_ANSWER_GRACE).await;
            let still_running = host
                .sessions
                .lock()
                .await
                .get(&session_id)
                .and_then(|runtime| runtime.run.as_ref())
                .is_some_and(|run| run.run_id == run_id);
            if still_running && bridge.abandon_turn(&run_id) {
                log::warn!(
                    "[agent-host] {} did not end the cancelled turn of {session_id} within {} s; ended it as cancelled",
                    bridge.harness,
                    CANCEL_ANSWER_GRACE.as_secs()
                );
            } else if still_running && !OpenTurn::is_open(&run_id) {
                host.clear_unowned_run(&session_id, &run_id).await;
            }
        });
    }

    /// Ends run `run_id` of a chat when no live turn owns it any more: no
    /// prompt of it waits in the bridge, and nothing that started it is still
    /// running to let go of it. Such a run refused every prompt, and Stop
    /// could not end it, until the bridge died or Flock restarted (2026-11-25
    /// hunt, D-1). The renderer is told the run is over, as for a turn whose
    /// answer it never got.
    pub(super) async fn clear_unowned_run(&self, session_id: &str, run_id: &str) {
        let released = self
            .sessions
            .lock()
            .await
            .get_mut(session_id)
            .and_then(|runtime| Self::release_claim(runtime, run_id));
        let Some(dropped) = released else {
            return;
        };
        log::warn!(
            "[agent-host] run {run_id} of {session_id} had no turn behind it; Stop ended it (dropped {dropped} queued steer(s))"
        );
        self.notify_frontend("session/update", protocol::run_settled_update(session_id));
    }

    pub(super) async fn handle_client_response(&self, id: Value, result: Result<Value, Value>) {
        let mapping = id
            .as_u64()
            .and_then(|key| self.client_requests.lock().ok()?.remove(&key));
        let Some(request) = mapping else {
            log::warn!("[agent-host] response for unknown client request {id}");
            return;
        };
        if let Some(bridge) = self.bridges.lock().await.get(&request.harness) {
            request.respond(bridge, result);
        }
    }

    /// The answer a bridge gets when no renderer can answer its request: a
    /// permission prompt is cancelled (the turn goes on or stops cleanly),
    /// anything else fails instead of leaving the bridge waiting forever.
    pub(super) fn unanswered_client_request(method: &str) -> Result<Value, Value> {
        if method == "session/request_permission" {
            Ok(json!({ "outcome": { "outcome": "cancelled" } }))
        } else {
            Err(protocol::internal("The app is not connected"))
        }
    }

    /// Every request still waiting on the renderer; taken when the socket it
    /// was sent over is replaced or goes away.
    pub(super) fn take_client_requests(&self) -> Vec<ClientRequest> {
        match self.client_requests.lock() {
            Ok(mut pending) => pending.drain().map(|(_, request)| request).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub(super) async fn answer_orphaned_client_requests(&self, orphaned: Vec<ClientRequest>) {
        if orphaned.is_empty() {
            return;
        }
        let bridges = self.bridges.lock().await;
        for request in orphaned {
            if let Some(bridge) = bridges.get(&request.harness) {
                let result = Self::unanswered_client_request(&request.method);
                request.respond(bridge, result);
            }
        }
    }

    pub(super) async fn handle_request(
        self: &Arc<Self>,
        method: &str,
        params: Value,
    ) -> Result<Value, Value> {
        if let Some(id) = protocol::session_id(&params) {
            if self
                .store
                .execution_owner(&id)
                .await
                .map_err(protocol::internal)?
                .is_some()
                && !matches!(
                    method,
                    "session/load"
                        | "session/fork"
                        | "_flock/session/info"
                        | "_flock/session/history"
                        | "_flock/session/history/result"
                        | "_flock/session/messages"
                )
            {
                return Err(invalid_params(
                    "Benchmark evidence is read-only; fork it into an ordinary chat to continue",
                ));
            }
        }
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
                "agentInfo": { "name": "flock-host", "version": env!("CARGO_PKG_VERSION") },
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
}
