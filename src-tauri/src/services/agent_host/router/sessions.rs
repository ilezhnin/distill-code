//! A chat session from new to archived: opening, attaching, loading, listing, forking and deleting.
use super::*;

impl Inner {
    /// The tool servers a bridge session is opened with: the ones the request
    /// names, the user's enabled servers, and, for a chat with computer use
    /// on, Flock's own computer use server, which takes the place of any
    /// other server of that name.
    pub(super) async fn mcp_servers(
        &self,
        requested: &Value,
        session_id: Option<&str>,
    ) -> Vec<Value> {
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
        if let Some(session_id) = session_id {
            if self.computer_use_on(session_id).await {
                match computer_use::server_for(&self.app) {
                    Some(server) => {
                        servers.retain(|server| {
                            server.get("name").and_then(Value::as_str)
                                != Some(computer_use::SERVER_NAME)
                        });
                        servers.push(server);
                    }
                    None => log::warn!(
                        "[agent-host] session {session_id} has computer use on but its driver is not installed; opening it without computer use"
                    ),
                }
            }
        }
        servers
    }

    /// Whether a chat has computer use on. Off unless the chat turned it on.
    pub(in crate::services::agent_host) async fn computer_use_on(&self, session_id: &str) -> bool {
        let stored = self
            .store
            .kv_get(computer_use::KV_SCOPE, session_id)
            .await
            .unwrap_or_else(|error| {
                log::warn!("[agent-host] failed to read computer use for {session_id}: {error}");
                None
            });
        computer_use::is_on(stored.as_ref())
    }

    pub(in crate::services::agent_host) async fn computer_use_state(
        &self,
        session_id: &str,
    ) -> Value {
        json!({
            "enabled": self.computer_use_on(session_id).await,
            "driverVersion": computer_use::driver_version(),
        })
    }

    /// Turn computer use on or off for a chat.
    ///
    /// Turning it on installs the pinned driver first, outside the chat's
    /// attach lock, so a download never holds the chat up. The tool server
    /// belongs to the agent session, so an attached chat lets go of its bridge
    /// session the way an idle one is let go of (`release_idle_session`): the
    /// next turn resumes it with the server added or taken away. Refused while
    /// the chat is busy, while a wave owns it, and for an agent that could not
    /// resume the conversation it has.
    pub(in crate::services::agent_host) async fn set_computer_use(
        &self,
        session_id: &str,
        enabled: bool,
    ) -> Result<Value, Value> {
        let record = self.session_record(session_id).await?;
        if enabled {
            computer_use::ensure_driver(&self.app)
                .await
                .map_err(invalid_params)?;
        }
        let lock = self.attach_lock(session_id).await;
        let _changing = lock.lock().await;
        if self.computer_use_on(session_id).await == enabled {
            return Ok(self.computer_use_state(session_id).await);
        }
        if self
            .store
            .execution_owner(session_id)
            .await
            .map_err(protocol::internal)?
            .is_some()
        {
            return Err(invalid_params(
                "A wave runs this chat; computer use can change once the wave is done",
            ));
        }
        let attached = {
            let sessions = self.sessions.lock().await;
            match sessions.get(session_id) {
                None => None,
                Some(runtime)
                    if runtime.loading
                        || runtime.run.is_some()
                        || runtime.background.is_busy()
                        || !runtime.steer_queue.is_empty() =>
                {
                    return Err(invalid_params(
                        "Wait for the turn to finish before turning computer use on or off",
                    ));
                }
                Some(runtime) => Some((
                    runtime.route_key(),
                    runtime.generation,
                    runtime.bridge_session_id.clone(),
                )),
            }
        };
        let bridge = match &attached {
            Some((route, generation, _)) => self
                .live_bridge(route)
                .await
                .filter(|bridge| bridge.generation() == *generation),
            None => None,
        };
        if bridge
            .as_ref()
            .is_some_and(|bridge| !bridge.supports_load_session())
            && record.message_count > 0
        {
            return Err(invalid_params(
                "This agent cannot reopen its conversation, so computer use can change only in a new chat",
            ));
        }
        if enabled {
            self.store
                .kv_set(
                    computer_use::KV_SCOPE,
                    session_id,
                    &json!({ "enabled": true }),
                )
                .await
        } else {
            self.store
                .kv_delete(computer_use::KV_SCOPE, session_id)
                .await
        }
        .map_err(protocol::internal)?;
        if let Some((_, _, bridge_session_id)) = attached {
            self.drain_bridge_events().await?;
            self.sessions.lock().await.remove(session_id);
            if let Some(bridge) = bridge {
                bridge.close_session(&bridge_session_id).await;
            }
            log::info!(
                "[agent-host] session {session_id} turned computer use {}; its next turn reopens the agent session",
                if enabled { "on" } else { "off" }
            );
        }
        Ok(self.computer_use_state(session_id).await)
    }

    pub(super) async fn agent_mode(&self) -> String {
        self.store
            .kv_get("settings", "agentMode")
            .await
            .ok()
            .flatten()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| harness::DEFAULT_AGENT_MODE.to_string())
    }

    pub(super) async fn apply_mode(
        &self,
        bridge: &Bridge,
        spec: &HarnessSpec,
        bridge_session_id: &str,
    ) {
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

    pub(super) fn meta_string(params: &Value, key: &str) -> Option<String> {
        params
            .pointer(&format!("/_meta/{key}"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// The three model-scoped selections a caller can name when a chat is
    /// created, in the `_meta` of `session/new` — the renderer's pending
    /// selection, or the chat a fork was taken from. Each is optional: a chat
    /// nobody chose for opens on whatever its harness starts with.
    pub(super) fn wanted_from_meta(params: &Value) -> Selection {
        Selection {
            model: Self::meta_string(params, "model"),
            effort: Self::meta_string(params, "reasoningEffort"),
            fast: params.pointer("/_meta/fastMode").and_then(Value::as_bool),
        }
    }

    pub(super) async fn new_session(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        if self.shutdown_prepared.load(Ordering::SeqCst) {
            return Err(protocol::internal("Flock is closing"));
        }
        let harness_id = Self::meta_string(&params, "provider").ok_or_else(|| {
            invalid_params("session/new requires _meta.provider (the agent harness id)")
        })?;
        let spec = harness::harness(&harness_id)
            .ok_or_else(|| invalid_params(format!("Unknown harness {harness_id}")))?;
        let named_account = Self::meta_string(&params, "accountId");
        let mut account_id = self.resolve_account_id(&harness_id, named_account.as_deref())?;
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| invalid_params("session/new requires cwd"))?;
        let mcp_servers = self.mcp_servers(&params["mcpServers"], None).await;
        // A model this harness runs only in a session opened on it decides how
        // the session is opened; every other one is written afterwards.
        let wanted = Self::wanted_from_meta(&params);
        // A chat that names no account opens on the one that serves its model.
        if let (None, Some(current), Some(model_id)) =
            (&named_account, account_id.clone(), wanted.model.as_deref())
        {
            if let Some(serving) = self
                .account_for_model(&harness_id, &current, model_id)
                .await
            {
                account_id = Some(serving);
            }
        }
        let open_meta = wanted
            .model
            .as_deref()
            .and_then(|model_id| harness::session_model_meta(spec, model_id));
        let (bridge, bridge_session_id, mut snapshot) = self
            .open_bridge_session(
                spec,
                account_id.as_deref(),
                &cwd,
                mcp_servers,
                open_meta.as_ref(),
            )
            .await?;
        // Native session ids are local to each account's process/home.
        let session_id = uuid::Uuid::new_v4().to_string();
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
            account_id: account_id.clone(),
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
        let mut sessions = self.sessions.lock().await;
        if self.shutdown_prepared.load(Ordering::SeqCst) {
            drop(sessions);
            bridge.close_session(&bridge_session_id).await;
            return Err(protocol::internal("Flock is closing"));
        }
        if let Err(error) = self.store.insert_session(&record).await {
            // There is no chat to reach it through, so the session the bridge
            // just opened for us is unreachable: hand it back instead of
            // leaving the agent holding it until the process exits.
            drop(sessions);
            bridge.close_session(&bridge_session_id).await;
            return Err(protocol::internal(error));
        }
        sessions.insert(
            session_id.clone(),
            SessionRuntime {
                harness: harness_id.clone(),
                account_id: account_id.clone(),
                execution_profile: None,
                bridge_session_id,
                generation: bridge.generation(),
                loading: false,
                run: None,
                background: Default::default(),
                context: Default::default(),
                steer_queue: VecDeque::new(),
                native_steers: Vec::new(),
                snapshot: snapshot.clone(),
                has_model_option,
                substitutions: substitutions.clone(),
                last_active: std::time::Instant::now(),
            },
        );
        let mut response = Self::presented_snapshot(&harness_id, &snapshot, has_model_option);
        response["sessionId"] = json!(session_id);
        response["_meta"] = json!({
            "providerId": harness_id,
            "accountId": account_id,
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
    pub(super) async fn open_bridge_session(
        &self,
        spec: &HarnessSpec,
        account_id: Option<&str>,
        cwd: &str,
        mcp_servers: Vec<Value>,
        open_meta: Option<&Value>,
    ) -> Result<(Arc<Bridge>, String, Value), Value> {
        let bridge = self.ensure_account_bridge(spec.id, account_id).await?;
        let mut params = json!({ "cwd": cwd, "mcpServers": mcp_servers });
        if let Some(meta) =
            harness::merge_session_meta(harness::session_base_meta(spec.id), open_meta)
        {
            params["_meta"] = meta;
        }
        let result = bridge.request("session/new", params).await?;
        let bridge_session_id = protocol::session_id(&result)
            .ok_or_else(|| protocol::internal("bridge returned no sessionId"))?;
        self.apply_mode(&bridge, spec, &bridge_session_id).await;
        Ok((bridge, bridge_session_id, Self::snapshot_from(&result)))
    }

    /// The per-session lock that serializes attaching a session to a bridge
    /// and moving it to another harness.
    pub(super) async fn attach_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
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
    pub(super) async fn attach_session(
        self: &Arc<Self>,
        record: &SessionRecord,
    ) -> Result<(Arc<Bridge>, String), Value> {
        let lock = self.attach_lock(&record.id).await;
        let _attaching = lock.lock().await;
        let current = self.session_record(&record.id).await?;
        if self.shutdown_prepared.load(Ordering::SeqCst) || current.archived_at.is_some() {
            return Err(invalid_params("Session is archived or Flock is closing"));
        }
        if let Some(attached) = self.attached_route(&record.id).await {
            // Every caller is about to use the session. Marked under the
            // attach lock, which `release_idle_session` takes too, so the chat
            // cannot be let go of between this answer and that use.
            self.touch_session(&record.id).await;
            return Ok(attached);
        }
        if self
            .store
            .execution_owner(&record.id)
            .await
            .map_err(protocol::internal)?
            .is_some()
        {
            return Err(protocol::internal(
                "dispatch_uncertain: owned session runtime is unavailable; no automatic reopen",
            ));
        }
        // The caller's copy may predate a move to another harness made while
        // it waited for the lock (an explicit preparation, say); attach
        // what the store holds now.
        let current = self.adopt_default_account(current).await?;
        self.attach_session_locked(&current).await
    }

    /// A chat of a provider with saved accounts that names none — imported
    /// from another tool, or older than saved accounts — runs on the
    /// provider's default account from now on. Without one every attach and
    /// prompt is refused ("Choose a signed-in account for this chat") before
    /// anything reaches the chat, so its queued messages never leave the
    /// queue. With no signed-in account at all, that is the error.
    pub(super) async fn adopt_default_account(
        &self,
        record: SessionRecord,
    ) -> Result<SessionRecord, Value> {
        if record.account_id.is_some()
            || record.archived_at.is_some()
            || !provider_accounts::supports_managed_accounts(&record.harness)
        {
            return Ok(record);
        }
        let Some(account_id) = self.resolve_account_id(&record.harness, None)? else {
            return Ok(record);
        };
        if self
            .store
            .adopt_account(&record.id, &account_id)
            .await
            .map_err(protocol::internal)?
        {
            log::info!(
                "[agent-host] session {} had no {} account; it runs on {account_id} now",
                record.id,
                record.harness
            );
        }
        self.session_record(&record.id).await
    }

    /// The live bridge behind a session, when it is already attached and the
    /// bridge process it was attached to is still the one running. Never
    /// attaches.
    pub(super) async fn attached_route(&self, session_id: &str) -> Option<(Arc<Bridge>, String)> {
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

    pub(super) async fn attach_session_locked(
        self: &Arc<Self>,
        record: &SessionRecord,
    ) -> Result<(Arc<Bridge>, String), Value> {
        let spec = harness::harness(&record.harness)
            .ok_or_else(|| invalid_params(format!("Unknown harness {}", record.harness)))?;
        let bridge = self
            .ensure_account_bridge(&record.harness, record.account_id.as_deref())
            .await?;
        let stored_bridge_id = record
            .bridge_session_id
            .clone()
            .unwrap_or_else(|| record.id.clone());
        let mut snapshot = record
            .snapshot
            .clone()
            .unwrap_or_else(|| Self::snapshot_from(&Value::Null));
        snapshot[REPORTED_KEY] = json!(ReportedSelection::default());

        // Register early with `loading` so replayed history from the bridge is
        // swallowed rather than duplicated in the renderer.
        let mut sessions = self.sessions.lock().await;
        if self.shutdown_prepared.load(Ordering::SeqCst) {
            return Err(protocol::internal("Flock is closing"));
        }
        sessions.insert(
            record.id.clone(),
            SessionRuntime {
                harness: record.harness.clone(),
                account_id: record.account_id.clone(),
                execution_profile: None,
                bridge_session_id: stored_bridge_id.clone(),
                generation: bridge.generation(),
                loading: true,
                run: None,
                background: Default::default(),
                context: Default::default(),
                steer_queue: VecDeque::new(),
                native_steers: Vec::new(),
                snapshot: snapshot.clone(),
                has_model_option: Self::has_model_option(&snapshot),
                substitutions: Vec::new(),
                last_active: std::time::Instant::now(),
            },
        );
        drop(sessions);
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
    /// [`Inner::update_working_dir`] leaves behind: a bridge session runs in
    /// the folder it was created in, so a chat that moved folders must not
    /// resume it, and every bridge that supports `loadSession` but not
    /// `session/close` would happily resume it forever. Falling back to the
    /// host's own session id here (the record's `id`) would do exactly that for
    /// an imported chat, whose two ids are the same.
    ///
    /// A chat nobody has prompted has nothing to resume either, and the agent
    /// never saved its bridge session: claude answers such a resume with
    /// "Resource not found" after about three seconds, and the home composer's
    /// draft paid that on every start.
    pub(super) fn resumable_bridge_session(record: &SessionRecord) -> Option<&str> {
        if record.message_count == 0 {
            return None;
        }
        record
            .bridge_session_id
            .as_deref()
            .filter(|id| !id.is_empty())
    }

    /// The bridge round trips of an attach, for a session already registered
    /// as loading: resume the stored bridge session (or open a fresh one),
    /// apply the mode and model, and only then make the runtime routable.
    pub(super) async fn attach_registered_session(
        self: &Arc<Self>,
        record: &SessionRecord,
        spec: &HarnessSpec,
        bridge: &Arc<Bridge>,
        stored_bridge_id: String,
        mut snapshot: Value,
    ) -> Result<(Arc<Bridge>, String), Value> {
        let mcp_servers = self.mcp_servers(&Value::Null, Some(&record.id)).await;
        let mut bridge_session_id = stored_bridge_id.clone();
        let mut resumed = false;
        // A model the bridge runs only when a session is opened on it, over
        // what every session on the harness opens and resumes with.
        let model_meta = record
            .model_id
            .as_deref()
            .and_then(|model_id| harness::session_model_meta(spec, model_id));
        let open_meta =
            harness::merge_session_meta(harness::session_base_meta(spec.id), model_meta.as_ref());
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
                    snapshot[REPORTED_KEY] = loaded[REPORTED_KEY].clone();
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
            snapshot[REPORTED_KEY] = fresh[REPORTED_KEY].clone();
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
                model_meta.is_some(),
            )
            .await;
        let has_model_option = Self::has_model_option(&snapshot);
        let _ = self.store.set_snapshot(&record.id, &snapshot).await;
        // Everything the bridge replayed for this session is already in the
        // event queue; let the loop swallow it all before the session is live,
        // or its tail would be appended to the transcript a second time.
        let parent = if resumed && record.harness != "kimi-acp" {
            self.store
                .latest_prompt_id(&record.id)
                .await
                .map_err(protocol::internal)?
        } else {
            None
        };
        self.drain_bridge_events().await?;
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.rebind(&record.id, bridge_session_id.clone()) {
                if let Some(parent) = parent {
                    runtime.background.allow(&parent);
                }
                runtime.loading = false;
                runtime.snapshot = snapshot;
                runtime.has_model_option = has_model_option;
                runtime.substitutions = substitutions;
                runtime.touch();
            }
        }
        Ok((Arc::clone(bridge), bridge_session_id))
    }

    pub(super) async fn load_session(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let started = std::time::Instant::now();
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let mut record = self.session_record(&session_id).await?;
        let owned = self
            .store
            .execution_owner(&session_id)
            .await
            .map_err(protocol::internal)?
            .is_some();
        if !owned {
            if let Some(cwd) = params.get("cwd").and_then(Value::as_str) {
                if !cwd.is_empty() && cwd != "~" && cwd != record.cwd {
                    self.update_working_dir(&session_id, cwd).await?;
                    record.cwd = cwd.to_string();
                }
            }
        }
        // The transcript is ours: replay it from the local log and answer
        // right away. Waking the agent behind the session (spawning its
        // bridge, resuming its own context) is only needed for the next
        // prompt, so the prompt path attaches on demand. Reading a chat must not
        // connect integrations or request their authorization.
        //
        // The log is read, so the event loop's own buffer has to be committed
        // first: a chat that is streaming right now has its last chunks there,
        // and replaying without them would show a transcript missing its tail.
        let before_drain = std::time::Instant::now();
        self.drain_bridge_events().await?;
        let before_read = std::time::Instant::now();
        let paged = params
            .pointer("/_meta/distill/historyPage")
            .and_then(Value::as_bool)
            == Some(true);
        let history = if paged {
            Some(
                self.store
                    .history_page(&session_id, None)
                    .await
                    .map_err(protocol::internal)?,
            )
        } else {
            None
        };
        let (events, event_count) = if paged {
            (Vec::new(), 0)
        } else {
            self.store
                .replay_payloads(&session_id)
                .await
                .map_err(protocol::internal)?
        };
        let before_send = std::time::Instant::now();
        let replayed_count = events.len();
        let batched = params
            .pointer("/_meta/distill/replayBatch")
            .and_then(Value::as_bool)
            == Some(true);
        let frames = protocol::send_replay_notifications(events, batched, |frame| {
            self.send_to_frontend(frame);
        });
        log::debug!(
            target: "perf",
            "[perf:host-load] {} record={}ms drain={}ms read_compact={}ms enqueue={}ms events={} replayed={} frames={} page_events={} page_bytes={}",
            session_id,
            before_drain.duration_since(started).as_millis(),
            before_read.duration_since(before_drain).as_millis(),
            before_send.duration_since(before_read).as_millis(),
            before_send.elapsed().as_millis(),
            event_count,
            replayed_count,
            frames,
            history.as_ref().map_or(0, |page| page.events.len()),
            history.as_ref().map_or(0, |page| page.events.iter().map(|event| event.get().len()).sum::<usize>()),
        );
        let background_tasks = self
            .sessions
            .lock()
            .await
            .get(&session_id)
            .map(|runtime| runtime.background.snapshot())
            .unwrap_or_else(|| json!([]));
        self.notify_frontend("session/update", json!({"sessionId": session_id, "update": {
            "sessionUpdate": "session_info_update", "_meta": {"backgroundTasks": background_tasks}
        }}));
        let attached = self.attached_route(&session_id).await.is_some();
        if attached {
            // Opening a chat whose agent is already awake counts as using it.
            // A dormant chat stays dormant until an explicit preparation.
            self.touch_session(&session_id).await;
        }
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
        response["_meta"] = json!({ "providerId": record.harness, "accountId": record.account_id });
        if owned {
            response["_meta"]["executionOwner"] = record
                .snapshot
                .as_ref()
                .and_then(|v| v.pointer("/_meta/executionOwner"))
                .cloned()
                .unwrap_or(Value::Null);
        }
        if let Some(history) = history {
            response["_meta"]["distillHistory"] = json!(history);
        }
        // A chat loaded while its turn runs (the renderer reloaded, or another
        // frontend opened it): name the run, so the renderer shows the work
        // and offers Stop instead of an idle chat that queues its sends. The
        // renderer applies it after its replay, the way it applies every
        // update that arrives during a load.
        if !owned {
            if let Some(run_id) = self.reported_run_id(&session_id).await {
                response["_meta"]["activeRunId"] = json!(run_id);
                self.notify_frontend(
                    "session/update",
                    json!({
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "session_info_update",
                            "_meta": { "activeRunId": run_id }
                        }
                    }),
                );
            }
        }
        let response = Self::with_substitutions(response, &substitutions);
        Ok(response)
    }

    /// A live session's snapshot, whether its bridge names its models in an
    /// option of its own, and what that bridge would not do when the session
    /// was last put on its selections.
    pub(super) async fn runtime_snapshot(
        &self,
        session_id: &str,
    ) -> Option<(Value, bool, Vec<Value>)> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).map(|runtime| {
            (
                runtime.snapshot.clone(),
                runtime.has_model_option,
                runtime.substitutions.clone(),
            )
        })
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
                "accountId": record.account_id,
                "modelId": record.model_id,
                // The two knobs that belong to the model, so a chat the
                // operator has not opened still reports what it runs at.
                "reasoningEffort": record.reasoning_effort,
                "fastMode": record.fast_mode,
                "personaId": record.persona_id,
                "activeRunId": active_run_id,
                "executionOwner": record.snapshot.as_ref().and_then(|v| v.pointer("/_meta/executionOwner")),
            }
        })
    }

    pub async fn active_run_id(&self, session_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .and_then(|runtime| runtime.active_run_id().map(str::to_string))
    }

    /// The run a chat is busy with as the renderer is to see it: a prompt's or
    /// a background reply's ([`Self::active_run_id`]), or the turn a Kimi
    /// agent began by itself and the chat is shown (`kimi_relay`). Sends are
    /// never refused for the last: Kimi queues them itself.
    pub(super) async fn reported_run_id(&self, session_id: &str) -> Option<String> {
        if let Some(run_id) = self.active_run_id(session_id).await {
            return Some(run_id);
        }
        self.kimi_follows
            .lock()
            .await
            .get(session_id)
            .and_then(|follow| follow.running_reply().map(str::to_string))
    }

    pub(super) async fn list_sessions(&self, params: Value) -> Result<Value, Value> {
        let from = match params.get("cursor") {
            None | Some(Value::Null) => SessionListPosition::START,
            Some(cursor) => cursor
                .as_str()
                .and_then(SessionListPosition::from_cursor)
                .ok_or_else(|| invalid_params("cursor is not one session/list handed out"))?,
        };
        let page = self
            .store
            .list_session_page(from, SESSION_PAGE_SIZE)
            .await
            .map_err(protocol::internal)?;
        let mut sessions = Vec::with_capacity(page.sessions.len());
        for record in &page.sessions {
            let active = self.reported_run_id(&record.id).await;
            sessions.push(Self::session_info(record, active.as_deref()));
        }
        // `activeComplete`: every chat that is not archived is on this page or
        // an earlier one. The sidebar reads pages until it is true, and leaves
        // the archive to whoever opens it.
        Ok(json!({
            "sessions": sessions,
            "nextCursor": page.next_cursor,
            "_meta": { "activeComplete": page.active_complete },
        }))
    }

    pub(super) async fn delete_session(&self, params: Value) -> Result<Value, Value> {
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
        if let Err(error) = self
            .store
            .kv_delete(computer_use::KV_SCOPE, &session_id)
            .await
        {
            log::warn!("[agent-host] failed to forget computer use for {session_id}: {error}");
        }
        Ok(json!({}))
    }

    /// Cancel and hand back a bridge session nobody will talk to again, so the
    /// agent stops holding its context and whatever it was doing. Best effort:
    /// a bridge without `session/close` keeps it until the process exits.
    pub(super) async fn let_go_of(&self, runtime: &SessionRuntime) {
        let Some(bridge) = self.live_bridge(&runtime.route_key()).await else {
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
    pub(super) fn close_in_background(bridge: Arc<Bridge>, bridge_session_id: String) {
        tokio::spawn(async move {
            bridge.close_session(&bridge_session_id).await;
        });
    }

    /// Permanently remove one message or step and abandon its old provider
    /// context. Share the dispatch lock so no prompt can race the rewrite.
    pub(in crate::services::agent_host) async fn remove_transcript_message(
        &self,
        session_id: &str,
        side: crate::services::agent_host::store::MessageSide,
        message_id: &str,
        part: Option<&crate::services::agent_host::store::MessagePart>,
    ) -> Result<Value, Value> {
        let lock = self.attach_lock(session_id).await;
        let _changing = lock.lock().await;
        self.session_record(session_id).await?;
        if self
            .store
            .execution_owner(session_id)
            .await
            .map_err(protocol::internal)?
            .is_some()
        {
            return Err(invalid_params("Task-owned transcripts cannot be changed"));
        }
        if self
            .sessions
            .lock()
            .await
            .get(session_id)
            .is_some_and(|runtime| {
                runtime.loading || runtime.run.is_some() || !runtime.steer_queue.is_empty()
            })
        {
            return Err(invalid_params(
                "Stop the current turn before deleting a message or step",
            ));
        }
        self.drain_bridge_events().await?;
        let removal = self
            .store
            .remove_message(session_id, side, message_id, part)
            .await
            .map_err(protocol::internal)?;
        if removal.removed == 0 {
            return Err(invalid_params("The message or step no longer exists"));
        }
        let released = self.sessions.lock().await.remove(session_id);
        if let Some(runtime) = released {
            self.let_go_of(&runtime).await;
        }
        let record = self.session_record(session_id).await?;
        Ok(json!({
            "removed": removal.removed,
            "lastMessage": removal.was_last,
            "snippet": record.last_snippet,
            "messageCount": record.message_count,
        }))
    }

    pub(in crate::services::agent_host) async fn update_working_dir(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Result<(), Value> {
        let lock = self.attach_lock(session_id).await;
        let _changing = lock.lock().await;
        let record = self.session_record(session_id).await?;
        if record.cwd == cwd {
            return Ok(());
        }
        if self
            .sessions
            .lock()
            .await
            .get(session_id)
            .is_some_and(|runtime| {
                runtime.loading || runtime.run.is_some() || !runtime.steer_queue.is_empty()
            })
        {
            return Err(invalid_params(
                "Wait for the session to finish before changing its working directory",
            ));
        }
        self.drain_bridge_events().await?;
        self.store
            .move_working_dir(session_id, cwd)
            .await
            .map_err(protocol::internal)?;
        let released = self.sessions.lock().await.remove(session_id);
        if let Some(runtime) = released {
            self.let_go_of(&runtime).await;
        }
        Ok(())
    }

    pub(in crate::services::agent_host) async fn archive_session(
        &self,
        session_id: &str,
    ) -> Result<(), Value> {
        let lock = self.attach_lock(session_id).await;
        let _archiving = lock.lock().await;
        if self
            .sessions
            .lock()
            .await
            .get(session_id)
            .is_some_and(|runtime| {
                runtime.loading || runtime.run.is_some() || !runtime.steer_queue.is_empty()
            })
        {
            return Err(invalid_params(
                "Wait for the session to finish before archiving it",
            ));
        }
        self.drain_bridge_events().await?;
        self.store
            .set_archived(session_id, true)
            .await
            .map_err(protocol::internal)?;
        if let Some((harness, bridge_id, generation)) = self.runtime_route(session_id).await {
            let bridge = self.live_bridge(&harness).await;
            if Self::resumable_after_release(
                bridge
                    .as_ref()
                    .map(|bridge| (bridge.generation(), bridge.supports_load_session())),
                generation,
            ) {
                self.sessions.lock().await.remove(session_id);
                if let Some(bridge) = bridge {
                    bridge.close_session(&bridge_id).await;
                }
            }
        }
        Ok(())
    }

    /// The `session/new _meta` a fork opens on: everything about the chat it
    /// was taken from that a new session can be given. All four selections
    /// travel, so a fork runs what its source ran instead of starting over on
    /// the bridge's own default.
    pub(super) fn fork_meta(record: &SessionRecord) -> Value {
        let mut meta = json!({ "provider": record.harness });
        if let Some(account_id) = &record.account_id {
            meta["accountId"] = json!(account_id);
        }
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

    pub(super) async fn fork_session(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let lock = self.attach_lock(&session_id).await;
        let _forking = lock.lock().await;
        let record = self.session_record(&session_id).await?;
        self.drain_bridge_events().await?;
        // Resolve the selected message before creating a provider session. A
        // missing/stale identity must not silently become a full-history fork.
        let boundary = if let Some(target) = params.pointer("/_meta/conversationThrough") {
            let message_id = target
                .get("messageId")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| invalid_params("conversationThrough.messageId required"))?;
            let side = match target.get("role").and_then(Value::as_str) {
                Some("user") => MessageSide::User,
                Some("assistant") => MessageSide::Assistant,
                _ => {
                    return Err(invalid_params(
                        "conversationThrough.role must be user or assistant",
                    ))
                }
            };
            Some(ForkBoundary::ThroughEvent(
                self.store
                    .message_last_event(&session_id, side, message_id)
                    .await
                    .map_err(invalid_params)?,
            ))
        } else {
            params
                .pointer("/_meta/conversationBefore")
                .and_then(Value::as_i64)
                .map(ForkBoundary::BeforeSecond)
        };
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
        if let Err(error) = self.store.copy_events(&session_id, &new_id, boundary).await {
            // Do not leave an empty, attached fork when copying fails.
            if let Err(cleanup) = self.delete_session(json!({ "sessionId": new_id })).await {
                return Err(protocol::internal(format!(
                    "{error}; failed to remove incomplete fork: {cleanup}"
                )));
            }
            return Err(protocol::internal(error));
        }
        if let Some(title) = &record.title {
            let _ = self
                .store
                .set_title(&new_id, title, record.user_set_name)
                .await;
        }
        Ok(created)
    }
}
