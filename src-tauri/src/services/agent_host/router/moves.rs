//! Moving a session to another harness or account.
use super::*;

impl Inner {
    /// Put a session on another harness — the "provider" option. Between
    /// turns only: a running turn belongs to the agent that is answering it.
    ///
    /// The conversation so far lives in the previous agent's own context,
    /// which cannot follow the chat to a different agent. What can is the
    /// transcript, which is the host's: a chat that has messages is marked as
    /// owing it to the new agent, and the next prompt carries it (see
    /// `carryover_block`). The new bridge session is opened before anything is
    /// changed, so a failure leaves the session on the harness it had.
    pub(super) async fn move_to_harness(
        self: &Arc<Self>,
        session_id: &str,
        harness_id: &str,
    ) -> Result<Value, Value> {
        let spec = harness::harness(harness_id)
            .ok_or_else(|| invalid_params(format!("Unknown harness {harness_id}")))?;
        let lock = self.attach_lock(session_id).await;
        let _moving = lock.lock().await;
        let record = self.session_record(session_id).await?;
        let running = || {
            invalid_params(format!(
                "Session {session_id} is running a turn on {}; it can move to {harness_id} once the turn ends",
                record.harness
            ))
        };
        let account_id = self.resolve_account_id(harness_id, None)?;
        if self.active_run_id(session_id).await.is_some() {
            return Err(running());
        }
        let mcp_servers = self.mcp_servers(&Value::Null, Some(session_id)).await;
        let (bridge, bridge_session_id, snapshot) = self
            .open_bridge_session(spec, account_id.as_deref(), &record.cwd, mcp_servers, None)
            .await?;
        let model_id = Self::current_model(&snapshot);
        // Opening the bridge session took a while, and a prompt that was past
        // its attach before this move took the lock may have claimed a turn
        // on the old one meanwhile. The route is taken away under the very
        // lock a turn is claimed under, so either that turn is seen here and
        // the move is refused, or the prompt finds no runtime and fails
        // cleanly instead of being cut off by the close below.
        let previously = {
            let mut sessions = self.sessions.lock().await;
            if sessions
                .get(session_id)
                .is_some_and(|runtime| runtime.run.is_some())
            {
                None
            } else {
                Some(sessions.remove(session_id))
            }
        };
        let Some(previously) = previously else {
            // The session we just opened on the new harness is never going to
            // be used, so hand it back.
            bridge.close_session(&bridge_session_id).await;
            return Err(running());
        };
        let carried_over = match self
            .store
            .rebind_session(
                session_id,
                harness_id,
                account_id.as_deref(),
                &bridge_session_id,
                model_id.as_deref(),
                &snapshot,
            )
            .await
        {
            Ok(carried_over) => carried_over,
            Err(error) => {
                // Nothing moved: the record still names the old harness and
                // its bridge session. Put its route back, or that session
                // stays open in its bridge with nobody to hear it until the
                // next attach loads an id the bridge never let go of.
                if let Some(previously) = previously {
                    let mut sessions = self.sessions.lock().await;
                    if sessions.get(session_id).is_none() {
                        sessions.insert(session_id.to_string(), previously);
                    }
                }
                bridge.close_session(&bridge_session_id).await;
                return Err(protocol::internal(error));
            }
        };
        // The session it used to be is nobody's any more: cancel and close it
        // so the old agent stops holding its context.
        if let Some(previously) = previously {
            self.let_go_of(&previously).await;
        }
        let has_model_option = Self::has_model_option(&snapshot);
        self.sessions.lock().await.insert(
            session_id.to_string(),
            SessionRuntime {
                harness: harness_id.to_string(),
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
                substitutions: Vec::new(),
                last_active: std::time::Instant::now(),
            },
        );
        log::info!(
            "[agent-host] session {session_id} moved from {} to {harness_id}{}",
            record.harness,
            if carried_over {
                "; its transcript goes with the next prompt"
            } else {
                " before its first message"
            }
        );
        let mut response = Self::presented_snapshot(harness_id, &snapshot, has_model_option);
        response["_meta"] = json!({"providerId":harness_id,"accountId":account_id});
        self.notify_frontend("session/update", json!({"sessionId":session_id,"update":{"sessionUpdate":"session_info_update","_meta":response["_meta"]}}));
        Ok(response)
    }

    /// The account a chat on `account_id` has to move to for `model_id`:
    /// another of the provider's accounts whose list names the model, when
    /// this account's own list does not (a model the provider grants account
    /// by account). `None` leaves the chat where it is: its account lists the
    /// model, or nothing read so far says another one does.
    pub(super) async fn account_for_model(
        self: &Arc<Self>,
        harness_id: &str,
        account_id: &str,
        model_id: &str,
    ) -> Option<String> {
        if ext::account_lists_model(self, harness_id, account_id, model_id).await != Some(false) {
            return None;
        }
        for other in ext::pool_accounts(&self.app, harness_id, account_id).await {
            if ext::account_lists_model(self, harness_id, &other.id, model_id).await == Some(true) {
                return Some(other.id);
            }
        }
        None
    }

    /// Switch only an idle chat. A new CLI session receives context as text;
    /// historical commands are never dispatched as live tool invocations.
    pub(in crate::services::agent_host) async fn set_session_account(
        self: &Arc<Self>,
        session_id: &str,
        account_id: &str,
    ) -> Result<Value, Value> {
        self.move_session_to_account(session_id, account_id, None)
            .await
    }

    /// [`Self::set_session_account`], for a chat that moves because it was
    /// put on `model`, which only the new account serves. An account change
    /// alone keeps everything the chat runs with or is refused; one made for
    /// a model keeps what that model offers and says what it does not.
    pub(super) async fn move_session_to_account(
        self: &Arc<Self>,
        session_id: &str,
        account_id: &str,
        model: Option<&str>,
    ) -> Result<Value, Value> {
        let lock = self.attach_lock(session_id).await;
        let _moving = lock.lock().await;
        let record = self.session_record(session_id).await?;
        let selected =
            provider_accounts::resolve_account(&self.app, &record.harness, Some(account_id))
                .map_err(invalid_params)?;
        if record.archived_at.is_some() || self.shutdown_prepared.load(Ordering::SeqCst) {
            return Err(invalid_params("Session is archived or Flock is closing"));
        }
        if account_route_key(&record.harness, record.account_id.as_deref())
            == account_route_key(&record.harness, Some(&selected.id))
        {
            let snapshot = record.snapshot.clone().unwrap_or_else(|| json!({}));
            let mut response = Self::presented_snapshot(
                &record.harness,
                &snapshot,
                Self::has_model_option(&snapshot),
            );
            response["_meta"] = json!({"providerId":record.harness,"accountId":selected.id});
            return Ok(response);
        }
        let can_switch = |runtime: &SessionRuntime| {
            !runtime.loading && runtime.run.is_none() && runtime.steer_queue.is_empty()
        };
        if self
            .sessions
            .lock()
            .await
            .get(session_id)
            .is_some_and(|runtime| !can_switch(runtime))
        {
            return Err(invalid_params(
                "Finish or stop the active turn before switching accounts",
            ));
        }
        let spec =
            harness::harness(&record.harness).ok_or_else(|| invalid_params("Unknown provider"))?;
        let wanted = Selection {
            model: model
                .map(str::to_string)
                .or_else(|| record.model_id.clone()),
            effort: record.reasoning_effort.clone(),
            fast: record.fast_mode,
        };
        let open_meta = wanted
            .model
            .as_deref()
            .and_then(|model| harness::session_model_meta(spec, model));
        let (bridge, bridge_session_id, mut snapshot) = self
            .open_bridge_session(
                spec,
                Some(&selected.id),
                &record.cwd,
                self.mcp_servers(&Value::Null, Some(session_id)).await,
                open_meta.as_ref(),
            )
            .await?;
        let substitutions = self
            .apply_to_session(
                &record.harness,
                &bridge,
                &bridge_session_id,
                &mut snapshot,
                &wanted,
                open_meta.is_some(),
            )
            .await;
        let model_refused = wanted
            .model
            .as_ref()
            .is_some_and(|model| Self::current_model(&snapshot).as_ref() != Some(model));
        if model_refused || (model.is_none() && !substitutions.is_empty()) {
            bridge.close_session(&bridge_session_id).await;
            return Err(protocol::error_with_data(
                protocol::INVALID_PARAMS,
                "The selected account cannot preserve this chat's model and settings",
                json!({"accountId":selected.id,"substitutions":substitutions}),
            ));
        }
        if let Err(error) = self.drain_bridge_events().await {
            bridge.close_session(&bridge_session_id).await;
            return Err(error);
        }
        // Remove the route under the same lock that claims turns. A prompt
        // admitted earlier either owns a run now or cannot dispatch here.
        let previously = {
            let mut sessions = self.sessions.lock().await;
            if self.shutdown_prepared.load(Ordering::SeqCst)
                || sessions
                    .get(session_id)
                    .is_some_and(|runtime| !can_switch(runtime))
            {
                drop(sessions);
                bridge.close_session(&bridge_session_id).await;
                return Err(invalid_params(
                    "Finish or stop the active turn before switching accounts",
                ));
            }
            sessions.remove(session_id)
        };
        if let Err(error) = self
            .store
            .switch_account(session_id, &selected.id, &bridge_session_id, &snapshot)
            .await
        {
            if let Some(runtime) = previously {
                self.sessions
                    .lock()
                    .await
                    .insert(session_id.to_string(), runtime);
            }
            bridge.close_session(&bridge_session_id).await;
            return Err(protocol::internal(error));
        }
        if let Some(runtime) = previously {
            self.let_go_of(&runtime).await;
        }
        if let Some(model) = model {
            // As after any model change: what the bridge answered is kept.
            let acknowledged = Self::selection_from(&snapshot["configOptions"]);
            let _ = self.store.set_model(session_id, Some(model)).await;
            let _ = self
                .store
                .set_run_settings(
                    session_id,
                    acknowledged.effort.as_deref(),
                    acknowledged.fast,
                )
                .await;
        }
        let has_model_option = Self::has_model_option(&snapshot);
        self.sessions.lock().await.insert(
            session_id.to_string(),
            SessionRuntime {
                harness: record.harness.clone(),
                account_id: Some(selected.id.clone()),
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
        let meta = json!({"providerId":record.harness,"accountId":selected.id,"contextTransfer":"transcript"});
        self.notify_frontend("session/update", json!({"sessionId":session_id,"update":{"sessionUpdate":"session_info_update","_meta":meta}}));
        let mut response = Self::presented_snapshot(&record.harness, &snapshot, has_model_option);
        self.notify_frontend("session/update", json!({"sessionId":session_id,"update":{"sessionUpdate":"config_option_update","configOptions":response["configOptions"],"_meta":meta}}));
        response["_meta"] = meta;
        Ok(Self::with_substitutions(response, &substitutions))
    }
}
