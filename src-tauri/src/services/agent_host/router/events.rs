//! What a bridge sends: the event loop, notifications and requests, and how an update is accepted and stamped.
use super::*;

impl Inner {
    /// The one loop that handles every bridge's events, in the order they
    /// arrived. Writing each streamed chunk to SQLite from here is what used to
    /// make every chat's persistence queue behind every other chat's — and made
    /// [`Self::drain_bridge_events`], which every attach and every withdrawn
    /// prompt waits on, wait for that whole backlog. The chunks are therefore
    /// stamped and forwarded to the renderer immediately and committed together
    /// as soon as the loop runs out of queued work, at the latest at the drain
    /// marker or after [`APPEND_BATCH_LIMIT`] of them.
    pub(super) async fn bridge_event_loop(
        self: Arc<Self>,
        mut events: mpsc::UnboundedReceiver<BridgeEvent>,
    ) {
        let mut pending: Vec<(String, Value)> = Vec::new();
        loop {
            let event = match events.try_recv() {
                Ok(event) => event,
                Err(mpsc::error::TryRecvError::Empty) => {
                    // Nothing else is waiting: store what the burst produced
                    // before parking on the channel, so a chat is never more
                    // than one idle moment away from being on disk.
                    let _ = self.flush_pending_events(&mut pending).await;
                    tokio::select! {
                        event = events.recv() => match event { Some(event) => event, None => break },
                        _ = tokio::time::sleep(std::time::Duration::from_secs(1)), if !pending.is_empty() => continue,
                    }
                }
                Err(mpsc::error::TryRecvError::Disconnected) => break,
            };
            let (event, _transport_lease) = event.into_admitted();
            match event {
                BridgeEvent::Bounded { .. } => {
                    log::error!("[agent-host] nested transport admission envelope rejected");
                }
                BridgeEvent::Notification {
                    harness,
                    generation,
                    run_id,
                    method,
                    params,
                } => {
                    if let Some(event) = self
                        .on_bridge_notification(
                            &harness,
                            generation,
                            run_id.as_deref(),
                            &method,
                            params,
                            false,
                        )
                        .await
                    {
                        pending.push(event);
                        if pending.len() >= APPEND_BATCH_LIMIT {
                            let _ = self.flush_pending_events(&mut pending).await;
                        }
                    }
                }
                BridgeEvent::Relayed {
                    harness,
                    generation,
                    params,
                } => {
                    if let Some(event) = self
                        .on_bridge_notification(
                            &harness,
                            generation,
                            None,
                            "session/update",
                            params,
                            true,
                        )
                        .await
                    {
                        pending.push(event);
                        if pending.len() >= APPEND_BATCH_LIMIT {
                            let _ = self.flush_pending_events(&mut pending).await;
                        }
                    }
                }
                BridgeEvent::Request {
                    harness,
                    generation,
                    id,
                    method,
                    params,
                } => {
                    self.on_bridge_request(&harness, generation, id, &method, params)
                        .await
                }
                BridgeEvent::Drained { ack } => {
                    // Whoever waits for this marker reads the transcript, the
                    // run state, or both: everything queued before it is now
                    // handled *and* committed.
                    let result = self.flush_pending_events(&mut pending).await;
                    let _ = ack.send(result);
                }
                BridgeEvent::Exited {
                    harness,
                    generation,
                    stopped,
                } => {
                    // A bridge the host shut down itself — idle, or the app
                    // quitting — ended normally. Either way nothing may route
                    // at it any more, so the cleanup below is the same.
                    if stopped {
                        log::info!("[agent-host] {harness} bridge stopped");
                    } else {
                        log::warn!("[agent-host] {harness} bridge exited");
                    }
                    // A replacement bridge may already be running and serving
                    // sessions: only the process that actually died is
                    // forgotten, and only the sessions it was serving. The
                    // rest keep working instead of silently losing the agent's
                    // context on their next prompt.
                    let mut bridges = self.bridges.lock().await;
                    let live = bridges.get(&harness).map(|bridge| bridge.generation());
                    if live == Some(generation) {
                        bridges.remove(&harness);
                    }
                    drop(bridges);
                    if Self::exit_ends_route(live, generation) {
                        self.forget_owned_bridge(&harness, generation);
                    }
                    let mut sessions = self.sessions.lock().await;
                    for (session_id, runtime) in sessions.runtimes.iter_mut() {
                        if runtime.served_by(&harness, generation) && runtime.background.is_busy() {
                            let tasks = runtime.background.disconnected(&now_iso());
                            pending.push((session_id.clone(), json!({"sessionId": session_id, "update": {
                                "sessionUpdate": "session_info_update",
                                "_meta": {"backgroundTasks": tasks, "backgroundDisconnected": true, "activeRunId": null}
                            }})));
                        }
                    }
                    sessions.retain(|runtime| !runtime.served_by(&harness, generation));
                }
            }
        }
        let _ = self.flush_pending_events(&mut pending).await;
    }

    /// Commit the session updates a burst of events produced. Consecutive
    /// events of one chat go in one transaction; the order they were handled in
    /// is the order the transcript keeps.
    pub(super) async fn flush_pending_events(
        &self,
        pending: &mut Vec<(String, Value)>,
    ) -> Result<(), String> {
        Self::persist_pending_events(&self.store, pending, |payload, id| {
            if let Some(payload) = Self::frontend_event(payload, id) {
                self.notify_frontend("session/update", payload);
            }
        })
        .await
    }

    pub(super) fn frontend_event(mut payload: Value, id: i64) -> Option<Value> {
        if Self::evidence_only(&payload) {
            return None;
        }
        Self::stamp_event_id(&mut payload, id);
        Some(payload)
    }

    /// Marks an update the transcript keeps as evidence but the renderer
    /// never shows (see [`Self::evidence_only`]).
    pub(super) fn mark_evidence_only(params: &mut Value) {
        if let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) {
            let meta = update.entry("_meta").or_insert_with(|| json!({}));
            if !meta.is_object() {
                *meta = json!({});
            }
            if !meta["distill"].is_object() {
                meta["distill"] = json!({});
            }
            meta["distill"]["evidenceOnly"] = json!(true);
        }
    }

    /// Whether an update is an owned session's provider extension the host
    /// keeps as evidence only.
    pub(super) fn evidence_only(payload: &Value) -> bool {
        payload.pointer("/update/_meta/distill/evidenceOnly") == Some(&json!(true))
    }

    pub(super) async fn persist_pending_events(
        store: &SessionStore,
        pending: &mut Vec<(String, Value)>,
        mut committed: impl FnMut(Value, i64),
    ) -> Result<(), String> {
        for (session_id, payloads) in Self::group_events_by_session(pending.clone()) {
            let ids = store.append_events(&session_id, &payloads).await.map_err(|error| {
                log::error!("[agent-host] history is not durable for {session_id}; retained for retry: {error}");
                error
            })?;
            pending.drain(..payloads.len());
            for (payload, id) in payloads.into_iter().zip(ids) {
                committed(payload, id);
            }
        }
        Ok(())
    }

    /// Runs of *consecutive* events belonging to the same chat. Two chats
    /// streaming at once interleave, and merging across the interleaving would
    /// reorder the log, so only neighbours are merged.
    pub(super) fn group_events_by_session(
        events: Vec<(String, Value)>,
    ) -> Vec<(String, Vec<Value>)> {
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
    pub(in crate::services::agent_host) async fn drain_bridge_events(&self) -> Result<(), Value> {
        drain_queued_bridge_events(&self.events_tx).await
    }

    /// Map a bridge-side session id back to the host session id: one lookup
    /// in the table's index, whatever the number of attached chats.
    pub(super) async fn host_session_for(
        &self,
        harness: &str,
        generation: u64,
        bridge_session_id: &str,
    ) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions
            .host_session_for_generation(harness, generation, bridge_session_id)
            .map(str::to_string)
    }

    pub(super) async fn runtime_route(&self, session_id: &str) -> Option<(String, String, u64)> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).and_then(SessionRuntime::route)
    }

    /// Mark an attached chat as in use now; see [`SessionRuntime::touch`].
    pub(super) async fn touch_session(&self, session_id: &str) {
        if let Some(runtime) = self.sessions.lock().await.get_mut(session_id) {
            runtime.touch();
        }
    }

    /// Handle one notification and report the update the transcript has to
    /// keep, for the loop to commit with the rest of the burst. `None` when
    /// there is nothing to store: a notification that is not a session update,
    /// one of a session nobody is watching, or a replay of history the session
    /// already has.
    /// `relayed` marks an update the host read from a Kimi session's own
    /// record ([`BridgeEvent::Relayed`]): the turn it belongs to never reaches
    /// the bridge's prompt, and it arrives already stamped as the agent's own
    /// reply.
    pub(super) async fn on_bridge_notification(
        &self,
        harness: &str,
        generation: u64,
        received_run: Option<&str>,
        method: &str,
        mut params: Value,
        relayed: bool,
    ) -> Option<(String, Value)> {
        // Drain notifications already queued before Exited even if stdout has
        // closed. Liveness is not ownership; a replacement generation is.
        if self.bridges.lock().await.get(harness)?.generation() != generation {
            return None;
        }
        let benchmark = harness.contains("\u{1f}benchmark:");
        // An owned session also keeps grok's other session extension updates:
        // they are evidence, and grok reports its hooks and subagents there.
        // They are no ACP updates, so the renderer never sees them (10-17:
        // its ACP client rejected every `session_summary_generated`).
        let usage = Self::normalize_xai_turn_usage(method, &mut params);
        let evidence_only = benchmark && !usage && Self::is_xai_session_extension(method);
        if evidence_only {
            Self::mark_evidence_only(&mut params);
        }
        let method = if usage || evidence_only {
            "session/update"
        } else {
            method
        };
        if method != "session/update" {
            if benchmark {
                return None;
            }
            self.notify_frontend(method, params);
            return None;
        }
        let bridge_session_id = protocol::session_id(&params)?;
        let Some(session_id) = self
            .host_session_for(harness, generation, &bridge_session_id)
            .await
        else {
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
                if runtime.execution_profile.is_some() {
                    params["update"]["_meta"]["executionOwner"] =
                        runtime.snapshot["_meta"]["executionOwner"].clone();
                    if let Some(violation) = Self::owned_violation(
                        params
                            .pointer("/update/sessionUpdate")
                            .and_then(Value::as_str),
                        runtime.run.is_some(),
                    )
                    .filter(|_| {
                        !runtime
                            .execution_profile
                            .as_deref()
                            .is_some_and(repository_execution::is_route)
                            || !Self::repository_work(
                                params
                                    .pointer("/update/sessionUpdate")
                                    .and_then(Value::as_str),
                            )
                    }) {
                        params["update"]["_meta"]["executionViolation"] = json!(violation);
                    }
                    if params
                        .pointer("/update/sessionUpdate")
                        .and_then(Value::as_str)
                        == Some("usage_update")
                    {
                        let raw = params["update"].clone();
                        params["update"]["_meta"]["benchmarkRawUsage"] = raw;
                    }
                }
                if runtime.loading || runtime.generation != generation {
                    return None;
                }
                if !Self::accept_update(runtime, received_run, &mut params, relayed) {
                    return None;
                }
                if runtime.execution_profile.is_none()
                    && (Self::is_command_list_update(&params)
                        || Self::is_failure_state_update(&params)
                        || Self::is_thread_status_update(&params)
                        || Self::is_zero_usage_update(&params)
                        || params
                            .pointer("/update/sessionUpdate")
                            .and_then(Value::as_str)
                            == Some("notice"))
                {
                    // Passed on, but neither a part of the turn nor of the
                    // transcript. Notices are explicitly live-only in ACP.
                    drop(sessions);
                    params["sessionId"] = json!(session_id);
                    self.notify_frontend("session/update", params);
                    return None;
                }
                // Only what the conversation is made of counts as use: a
                // bridge restating its command list to every session it has
                // would otherwise keep every chat of it attached for good.
                runtime.touch();
                persist = true;
                if let Some(run) = runtime
                    .run
                    .as_mut()
                    .filter(|run| Some(run.run_id.as_str()) == received_run)
                {
                    Self::stamp_staged_update(&mut params, run, &now_iso(), evidence_only);
                }
                runtime.context.observe(&mut params);
                if let Some(options) = Self::config_option_update(&params) {
                    // A bridge moves these without being asked: claude drops
                    // an effort a model does not offer, and the SDK flips fast
                    // mode back after a cooldown. Until now the host watched
                    // the update go past and kept describing the old state.
                    let mut stated = json!({ "configOptions": options });
                    if let Some(held) = Self::current_model(&runtime.snapshot) {
                        if Self::hold_declared_model(&runtime.harness, &held, &mut stated) {
                            params["update"]["configOptions"] = stated["configOptions"].clone();
                        }
                    }
                    let options = stated["configOptions"].take();
                    let selection = Self::selection_from(&options);
                    if runtime.execution_profile.is_some()
                        && selection != Self::selection_from(&runtime.snapshot["configOptions"])
                    {
                        params["update"]["_meta"]["executionViolation"] =
                            json!(violation::SELECTION);
                    }
                    Self::capture_reported(
                        &mut runtime.snapshot,
                        &json!({"configOptions": options}),
                        None,
                    );
                    runtime.snapshot["configOptions"] = options;
                    Self::record_configuration_change(runtime);
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
        if !persist && !Self::evidence_only(&params) {
            self.notify_frontend("session/update", params);
        }
        stored
    }

    pub(super) fn stamp_event_id(payload: &mut Value, id: i64) {
        if let Some(update) = payload.get_mut("update").and_then(Value::as_object_mut) {
            let meta = update.entry("_meta").or_insert_with(|| json!({}));
            if !meta.is_object() {
                *meta = json!({});
            }
            if !meta["distill"].is_object() {
                meta["distill"] = json!({});
            }
            meta["distill"]["eventId"] = json!(id);
        }
    }

    /// What an update of an owned session shows the no-tool policy broken by,
    /// if anything: work no single clean answer does, or a mode change while
    /// the turn runs.
    pub(super) fn owned_violation(update: Option<&str>, running: bool) -> Option<&'static str> {
        match update? {
            "tool_call" | "tool_call_update" => Some(violation::TOOL),
            "plan" => Some(violation::PLAN),
            kind if kind.starts_with("async_task") => Some(violation::BACKGROUND),
            kind if kind.starts_with("subagent") => Some(violation::SUBAGENT),
            // Grok's hook runs.
            "hook_run_started" | "hook_execution" => Some(violation::HOOK),
            "current_mode_update" if running => Some(violation::MODE),
            _ => None,
        }
    }

    /// Whether a repository session may send `update`, which the no-tool
    /// profile forbids: its granted tools, the plan it keeps, and the
    /// background work those tools start (a shell command that runs long
    /// goes on in the background: 10-31, a Codex `exec_command` writing a
    /// file was cut off as a policy breach).
    pub(super) fn repository_work(update: Option<&str>) -> bool {
        update.is_some_and(|kind| {
            matches!(kind, "tool_call" | "tool_call_update" | "plan")
                || kind.starts_with("async_task")
        })
    }

    /// Whether a chat keeps an update: one the bridge sent (see
    /// [`Self::accept_turn_update`]), or one the host read from an ordinary
    /// Kimi chat's own session record (`relayed`), which only the host queues.
    pub(super) fn accept_update(
        runtime: &mut SessionRuntime,
        received_run: Option<&str>,
        params: &mut Value,
        relayed: bool,
    ) -> bool {
        if relayed {
            return runtime.harness == "kimi-acp" && runtime.execution_profile.is_none();
        }
        steering::acknowledge_echo(&mut runtime.native_steers, received_run, params);
        Self::accept_turn_update(runtime, received_run, params)
    }

    pub(super) fn accept_turn_update(
        runtime: &mut SessionRuntime,
        received_run: Option<&str>,
        params: &mut Value,
    ) -> bool {
        let ordinary_claude =
            runtime.harness == "claude-acp" && runtime.execution_profile.is_none();
        if ordinary_claude {
            runtime.background.task_update(params, &now_iso());
        }
        if !Self::is_turn_update(params) {
            return true;
        }
        if ordinary_claude && received_run.is_none() {
            return runtime.background.stamp_continuation(params, &now_iso());
        }
        received_run.is_some()
            && runtime.run.as_ref().map(|run| run.run_id.as_str()) == received_run
    }

    pub(super) fn is_turn_update(params: &Value) -> bool {
        matches!(
            params
                .pointer("/update/sessionUpdate")
                .and_then(Value::as_str),
            Some(
                "user_message_chunk"
                    | "agent_message_chunk"
                    | "agent_thought_chunk"
                    | "tool_call"
                    | "tool_call_update"
                    | "plan"
                    | "usage_update"
                    | "message_usage"
            )
        )
    }

    /// Whether `method` is one of grok's per-session extension notifications.
    /// Grok 1.0.40 sends `turn_completed`, retries and its other session
    /// events on `_x.ai/session_notification`; earlier builds sent the turn
    /// on `_x.ai/session/update`, which still carries tool and content
    /// updates.
    pub(super) fn is_xai_session_extension(method: &str) -> bool {
        matches!(
            method,
            "_x.ai/session/update" | "_x.ai/session_notification"
        )
    }

    /// Rewrites grok's `turn_completed` session extension update into the
    /// standard `message_usage` update, so grok turns reach the usage ledger
    /// the way claude's and codex's do; every other `_x.ai` extension keeps
    /// its raw passthrough. Grok's `inputTokens` includes the cached share,
    /// which `message_usage` counts separately, so the cache is subtracted.
    /// The raw usage stays under `_meta.xaiTurnUsage`: its `costUsdTicks`
    /// (1 USD = 1e10 ticks) is complete only when grok says so, which
    /// benchmarks check before counting it; chats show no cost from it.
    pub(super) fn normalize_xai_turn_usage(method: &str, params: &mut Value) -> bool {
        if !Self::is_xai_session_extension(method) {
            return false;
        }
        let Some(update) = params.get("update") else {
            return false;
        };
        if update.get("sessionUpdate").and_then(Value::as_str) != Some("turn_completed") {
            return false;
        }
        let Some(usage) = update.get("usage") else {
            return false;
        };
        let read = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        let input = read("inputTokens");
        let output = read("outputTokens");
        let cache_read = read("cachedReadTokens");
        let cache_write = read("cacheCreationTokens");
        if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
            return false;
        }
        let raw = usage.clone();
        params["update"] = json!({
            "sessionUpdate": "message_usage",
            "usage": {
                "inputTokens": input.saturating_sub(cache_read + cache_write),
                "outputTokens": output,
                "cacheReadTokens": cache_read,
                "cacheWriteTokens": cache_write,
                "elapsedMs": read("apiDurationMs"),
            },
            "_meta": { "xaiTurnUsage": raw },
        });
        true
    }

    /// Whether this is an `available_commands_update`: the harness restating
    /// its whole slash-command list. It describes the harness, not the
    /// conversation, and a bridge sends it whenever it likes — grok to every
    /// session each time its skill watcher fires, which a sync job touching
    /// `~/.claude/skills` makes every ten minutes. Kept as events those were 7%
    /// of a transcript store nobody reads them from, replayed on every load;
    /// and one landing in a turn that then failed made the turn look answered.
    pub(super) fn is_command_list_update(params: &Value) -> bool {
        params
            .get("update")
            .and_then(|update| update.get("sessionUpdate"))
            .and_then(Value::as_str)
            == Some("available_commands_update")
    }

    /// The option list a `config_option_update` carries, as the bridge sent
    /// it. A bridge that sends one sends its whole list (verified on grok, the
    /// only one that notifies a client-initiated write), so it is a complete
    /// statement of the session's configuration; an empty array is not, and
    /// says nothing.
    pub(super) fn config_option_update(params: &Value) -> Option<Value> {
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
    pub(super) async fn store_bridge_selection(
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
    pub(super) fn agent_title(params: &Value) -> Option<&str> {
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

    /// Keep the host's visibility classification across the authoritative run
    /// stamp. Do not inherit a provider-supplied evidenceOnly flag instead.
    pub(super) fn stamp_staged_update(
        params: &mut Value,
        run: &mut RunState,
        created: &str,
        evidence_only: bool,
    ) {
        Self::stamp_run_update(params, run, created);
        if evidence_only {
            Self::mark_evidence_only(params);
        }
    }

    /// Note what a running turn's update adds to the chat snippet and stamp
    /// it with the host's bookkeeping. `messageId` is the user prompt's id,
    /// as it always was; everything but a user chunk also names the reply's
    /// own message, `assistantMessageId`, so a consumer can keep the prompt
    /// and the reply (and consecutive turns) apart.
    pub(super) fn stamp_run_update(params: &mut Value, run: &mut RunState, created: &str) {
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
        if kind == "compaction_update" {
            // Our replay stamp must not turn an omitted metadata patch into
            // a replacement, or erase the distinction between omission/null.
            let mut patch = json!({});
            if let Some(meta) = update.get("_meta") {
                patch["value"] = meta.clone();
            }
            distill["compactionMetaPatch"] = patch;
        }
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

    pub(super) fn air_session_failure(meta: &Value) -> Option<&Value> {
        let air = meta.pointer("/jetbrains/air")?;
        if air["version"].as_u64().is_none_or(|version| version < 1) {
            return None;
        }
        let failure = air.get("sessionFailure")?;
        (failure["id"].is_string() && failure["revision"].is_u64()).then_some(failure)
    }

    /// AIR failure rows describe provider state; they are not model output.
    /// Extra fields make an update substantive and retain normal bookkeeping.
    pub(super) fn is_failure_state_update(params: &Value) -> bool {
        let Some(update) = params.get("update").and_then(Value::as_object) else {
            return false;
        };
        update.get("sessionUpdate").and_then(Value::as_str) == Some("session_info_update")
            && update
                .keys()
                .all(|key| key == "sessionUpdate" || key == "_meta")
            && update
                .get("_meta")
                .and_then(Self::air_session_failure)
                .is_some()
    }

    /// Codex's word on its own thread (`_meta.codex.threadStatus`: active,
    /// idle, systemError) is provider state, not model output. It arrives at
    /// the start of every turn, before the model has said anything, so
    /// counting it as the turn's work made every Codex turn look started: a
    /// prompt the provider refused at once (a 429 on a burst of agents,
    /// 2026-11-05) was kept and failed instead of being withdrawn. Extra
    /// fields make the update substantive.
    pub(super) fn is_thread_status_update(params: &Value) -> bool {
        let Some(update) = params.get("update").and_then(Value::as_object) else {
            return false;
        };
        update.get("sessionUpdate").and_then(Value::as_str) == Some("session_info_update")
            && update
                .keys()
                .all(|key| key == "sessionUpdate" || key == "_meta")
            && update
                .get("_meta")
                .and_then(Value::as_object)
                .is_some_and(|meta| {
                    meta.keys().all(|key| key == "codex")
                        && meta
                            .get("codex")
                            .and_then(Value::as_object)
                            .is_some_and(|codex| {
                                !codex.is_empty() && codex.keys().all(|key| key == "threadStatus")
                            })
                })
    }

    pub(super) fn is_zero_usage_update(params: &Value) -> bool {
        let Some(update) = params.get("update").and_then(Value::as_object) else {
            return false;
        };
        // Claude reports zero synthetic-message usage before its terminal
        // quota failure. Positive/unknown usage remains fail-closed.
        update.get("sessionUpdate").and_then(Value::as_str) == Some("usage_update")
            && update.get("used").and_then(Value::as_f64) == Some(0.0)
            && update
                .get("cost")
                .is_none_or(|cost| cost["amount"].as_f64() == Some(0.0))
            && update.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "sessionUpdate" | "used" | "size" | "cost" | "_meta"
                )
            })
    }

    pub(super) fn prompt_response(result: Result<Value, Value>) -> Result<Value, Value> {
        result.and_then(|response| {
            let Some(failure) = response
                .get("_meta")
                .and_then(Self::air_session_failure)
                .filter(|failure| failure["severity"] == "error")
            else {
                return Ok(response);
            };
            // Both pinned Claude/Codex bridges reserve this policy for quota
            // exhaustion. Temporary rate limits offer retry; context and turn
            // budgets offer new_session. Do not infer quota from error prose.
            let quota = failure["category"] == "limit"
                && failure["actions"].as_array().is_some_and(Vec::is_empty);
            Err(protocol::error_with_data(
                protocol::INTERNAL_ERROR,
                failure["title"]
                    .as_str()
                    .unwrap_or("The provider could not complete this turn"),
                json!({
                    "errorKind": if quota { "quota_exhausted" } else { "provider_failure" },
                    "sessionFailure": failure,
                }),
            ))
        })
    }

    pub(super) async fn on_bridge_request(
        &self,
        harness: &str,
        generation: u64,
        id: Value,
        method: &str,
        mut params: Value,
    ) {
        let Some(origin) = self
            .live_bridge(harness)
            .await
            .filter(|bridge| bridge.generation() == generation)
        else {
            return;
        };
        if harness.contains("\u{1f}benchmark:") && protocol::session_id(&params).is_none() {
            origin.respond(id, Self::unanswered_client_request(method));
            return;
        }
        if let Some(bridge_session_id) = protocol::session_id(&params) {
            if self.is_naming_session(harness, &bridge_session_id) {
                // Nobody sees a naming session, so nothing it asks for is granted.
                {
                    let answer = if method == "session/request_permission" {
                        Ok(json!({ "outcome": { "outcome": "cancelled" } }))
                    } else {
                        Err(protocol::error(
                            protocol::METHOD_NOT_FOUND,
                            format!("{method} is not available to a naming session"),
                        ))
                    };
                    origin.respond(id, answer);
                }
                return;
            }
            if let Some(session_id) = self
                .host_session_for(harness, generation, &bridge_session_id)
                .await
            {
                if harness.contains("\u{1f}benchmark:") {
                    let owner_record = self.store.execution_owner(&session_id).await.ok().flatten();
                    if let Some(answer) = owned_permission_answer(
                        owner_record.as_ref().map(|(owner, _)| owner.profile),
                        method,
                        &params,
                    ) {
                        origin.respond(id, Ok(answer));
                        return;
                    }
                    let owner = owner_record.map(|(owner, _)| owner.owner_id);
                    let purpose = self
                        .store
                        .owned_session_purpose(&session_id)
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| "benchmark".into());
                    let event = json!({"sessionId":session_id,"update":{"sessionUpdate":"notice","_meta":{"executionOwner":{"kind":purpose,"id":owner},"executionViolation":format!("Unexpected native client request: {method}")}}});
                    if let Err(error) = self.store.append_events(&session_id, &[event]).await {
                        log::error!(
                            "[agent-host] cannot retain execution policy violation: {error}"
                        );
                    }
                    origin.respond(id, Self::unanswered_client_request(method));
                    return;
                }
                params["sessionId"] = json!(session_id);
            } else {
                origin.respond(
                    id,
                    Err(invalid_params("Unknown or detached bridge session")),
                );
                return;
            }
        }
        let request_id = self.next_client_request_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut pending) = self.client_requests.lock() {
            pending.insert(
                request_id,
                ClientRequest {
                    harness: harness.to_string(),
                    generation,
                    bridge_id: id.clone(),
                    method: method.to_string(),
                },
            );
        }
        let has_frontend = self.frontend.lock().map(|f| f.is_some()).unwrap_or(false);
        if !has_frontend {
            // Nobody to ask: cancel the request so the bridge does not hang.
            if let Ok(mut pending) = self.client_requests.lock() {
                pending.remove(&request_id);
            }
            origin.respond(id, Self::unanswered_client_request(method));
            return;
        }
        self.send_to_frontend(protocol::request(json!(request_id), method, params));
    }

    // -----------------------------------------------------------------------
    // Sessions
}
