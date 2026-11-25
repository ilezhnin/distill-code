//! Starting a turn and running a prompt through it.
use super::*;
use crate::services::agent_host::bridge::{prompt_withheld, OpenTurn};

impl Inner {
    /// Run one user turn and then every message steered into it, in order.
    /// A steered turn (`steer`) that finds another turn already running is
    /// queued behind it instead of failing: the steer was acknowledged with
    /// these ids, so it has to be delivered under them.
    pub(super) async fn start_turn(
        self: &Arc<Self>,
        params: Value,
        ids: TurnIds,
        steer: bool,
    ) -> Result<Value, Value> {
        self.start_turn_with_admission(params, ids, steer, None)
            .await
    }

    pub(super) async fn start_turn_with_admission(
        self: &Arc<Self>,
        mut params: Value,
        ids: TurnIds,
        steer: bool,
        task_admission: Option<tokio::sync::OwnedMutexGuard<()>>,
    ) -> Result<Value, Value> {
        // When the renderer's prompt reached the host (see `stopped_after`);
        // taken out before the prompt's `_meta` is recorded or sent.
        let arrival = Self::take_arrival(&mut params);
        check_owned_deadline(ids.owned_deadline)?;
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let mut record = self
            .adopt_default_account(self.session_record(&session_id).await?)
            .await?;
        if self.active_run_id(&session_id).await.is_none() {
            self.route_account_for_dispatch(&record, ids.allow_credits)
                .await?;
            record = self.session_record(&session_id).await?;
        }
        let (bridge, _) = self.attach_session(&record).await?;
        let lock = self.attach_lock(&session_id).await;
        let admission = lock.lock().await;
        let current = self.session_record(&session_id).await?;
        if task_admission.is_some() {
            let (owner, _) = self
                .store
                .execution_owner(&session_id)
                .await
                .map_err(protocol::internal)?
                .ok_or_else(|| invalid_params("Task session lost native ownership"))?;
            self.require_owned_selection(&owner, &current)
                .await
                .map_err(protocol::internal)?;
        }
        if current.archived_at.is_some() {
            return Err(invalid_params(
                "Unarchive the session before sending a prompt",
            ));
        }
        if current.cwd != record.cwd
            || current.harness != record.harness
            || current.account_id != record.account_id
        {
            return Err(invalid_params(
                "Session changed while preparing the prompt; retry in its current workspace",
            ));
        }
        if provider_accounts::supports_managed_accounts(&current.harness) {
            let id = current
                .account_id
                .as_deref()
                .ok_or_else(|| invalid_params("Choose a signed-in account for this chat"))?;
            provider_accounts::resolve_account(&self.app, &current.harness, Some(id))
                .map_err(invalid_params)?;
        }
        let prompt = params
            .get("prompt")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        let meta = params.get("_meta").cloned().unwrap_or_else(|| json!({}));
        let executor_link = ExecutorLink::take(&mut meta.clone()).map_err(invalid_params)?;
        if executor_link
            .as_ref()
            .is_some_and(|link| link.decision_key.starts_with("owned-task:"))
            && task_admission.is_none()
        {
            return Err(invalid_params(
                "Task-bound executor keys require the native owned dispatch authority",
            ));
        }
        // A chat that came here from another agent owes this one the
        // conversation so far. Built before the turn is claimed: reading the
        // log means waiting for the event loop to catch up, and whatever a
        // freshly opened bridge session says about itself meanwhile would be
        // stamped onto the run as something the turn produced — which is what
        // stops a prompt the bridge then rejects from being withdrawn.
        let carryover = self.pending_carryover(&session_id).await?;
        // A chat loaded from a file owes the agent that transcript once. A
        // session that is already handing over its whole log covers the loaded
        // messages, so the extra block would only say them twice.
        let import_handoff = if carryover.is_some() {
            if let Err(error) = self
                .store
                .kv_delete(
                    crate::services::agent_host::transcript_import::HANDOFF_SCOPE,
                    &session_id,
                )
                .await
            {
                log::warn!(
                    "[agent-host] failed to drop the loaded-chat handoff of {session_id}: {error}"
                );
            }
            None
        } else {
            self.pending_import_handoff(&session_id).await?
        };
        // For the same reason, everything the bridge said before this prompt
        // is handled and stored before the turn is claimed and the prompt is
        // recorded. An update still queued would otherwise be stamped as this
        // turn's, and one still waiting for its commit would land in the log
        // after this prompt's rows. The previous turn's own tail is already in:
        // `run_prompt` drains before a turn it ran ends.
        self.drain_bridge_events().await?;
        check_owned_deadline(ids.owned_deadline)?;
        // The bridge session the prompt goes to is the one the runtime names
        // in the very lock the run is registered in. `attach_session` released
        // its own lock before returning, and a `reopen_on_model` that took it
        // in between closes the bridge session and opens another: one that
        // finished first is answered here with its new id, and one still in
        // flight left no runtime at all, which fails the prompt cleanly
        // instead of sending it into a session the bridge has already closed.
        //
        // The claimed turn is held open in the turn ledger, under the same
        // lock the claim is made in, for as long as this call runs it: a Stop
        // reads from there whether the prompt was written, and whether anyone
        // still owns the run (see `OpenTurn`).
        let (bridge_session_id, mut turn) = {
            let mut sessions = self.sessions.lock().await;
            let runtime = sessions
                .get_mut(&session_id)
                .ok_or_else(|| protocol::internal("session vanished"))?;
            if self.shutdown_prepared.load(Ordering::SeqCst) {
                return Err(invalid_params("Flock is closing"));
            }
            match Self::claim_turn(runtime, &ids) {
                Ok(bridge_session_id) => {
                    self.activity_generations
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .record(&runtime.harness, runtime.account_id.as_deref());
                    let turn = OpenTurn::open(&ids.run_id);
                    // A Stop that arrived before this prompt was not pressed
                    // for its turn (see `Inner::stop_runtime`).
                    if let Some(run) = runtime.run.as_mut() {
                        run.arrival = arrival;
                    }
                    // A Stop sent after this prompt, while it was on its way
                    // here, found no turn to stop: it stops this one.
                    if Self::stopped_after(&session_id, arrival) {
                        turn.stop();
                    }
                    (bridge_session_id, turn)
                }
                Err(active) if runtime.background.active_run_id().is_some() => {
                    return Err(protocol::error_with_data(
                        protocol::INVALID_PARAMS,
                        "The agent is processing a background result",
                        json!({"actualRunId": active}),
                    ));
                }
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
        // A move is refused from here on, so this second look is the one that
        // cannot go stale: it catches a chat that changed agents between the
        // first look and the claim. Both come before the prompt is recorded,
        // so the transcript handed over ends where this message begins.
        //
        // From the claim on, every return before the prompt is sent lets go
        // of the turn first (`release_turn`). The store read below used to
        // return through `?` with the run still claimed, and the chat refused
        // every prompt until its bridge died or Flock restarted (2026-11-25
        // hunt, D-1).
        let recorded = match self
            .record_user_prompt(&session_id, &prompt, &meta, &ids, steer)
            .await
        {
            Ok(recorded) => recorded,
            Err(error) => {
                self.release_turn(&session_id, &ids.run_id).await;
                return Err(error);
            }
        };
        let turn_start = recorded
            .as_ref()
            .and_then(|recorded| recorded.event_ids.first().copied());
        drop(admission);
        let cancelled = match self.store.session_execution_cancelled(&session_id).await {
            Ok(cancelled) => cancelled,
            Err(error) => {
                self.release_turn(&session_id, &ids.run_id).await;
                return Err(protocol::internal(error));
            }
        };
        if cancelled {
            self.release_turn(&session_id, &ids.run_id).await;
            return Err(protocol::error_with_data(
                -32000,
                "Benchmark was cancelled before provider dispatch",
                json!({"kind":"cancelled"}),
            ));
        }
        self.name_untitled_session(&record, &prompt);
        // What is recorded is what the user sent; what the agent is sent
        // opens with what it missed.
        let sent = match (&carryover, &import_handoff) {
            (Some(block), _) => Self::prompt_after(block, &prompt),
            (None, Some(block)) => Self::prompt_after(block, &prompt),
            (None, None) => prompt,
        };
        let mut result = self
            .run_prompt_with_admission(
                &bridge,
                &session_id,
                &bridge_session_id,
                sent,
                meta,
                task_admission,
                ids.owned_deadline,
            )
            .await;
        if let Err(error) = &mut result {
            let dispatch_started = self
                .sessions
                .lock()
                .await
                .get(&session_id)
                .and_then(|runtime| runtime.run.as_ref())
                .is_none_or(|run| run.saw_update);
            let mut data = error
                .get("data")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            data.insert("dispatchStarted".into(), json!(dispatch_started));
            let quota_account = quota_identity(&record.harness, record.account_id.as_deref())
                .ok()
                .flatten()
                .map(|(account_id, _)| account_id);
            data.insert("accountId".into(), json!(quota_account));
            error["data"] = Value::Object(data);
            if let Some(account_id) = &quota_account {
                crate::services::provider_account_status::record_quota_error(
                    &self.app, account_id, error,
                )
                .await;
            }
            Self::explain_refusal(error, &record.harness);
        }
        // A served turn ends a refusal the account's status still shows.
        if result
            .as_ref()
            .is_ok_and(|result| result["stopReason"] != "cancelled")
        {
            if let Some((account_id, _)) =
                quota_identity(&record.harness, record.account_id.as_deref())
                    .ok()
                    .flatten()
            {
                crate::services::provider_account_status::record_served(&self.app, &account_id)
                    .await;
            }
        }
        match &mut result {
            // Only a turn the bridge saw through proves the agent has the
            // transcript. A failed one proves nothing either way — a bridge
            // that died took the prompt with it — and an agent told the same
            // history twice is a far smaller harm than one never told it. A
            // prompt a Stop kept from being written told the agent nothing.
            Ok(answer) if carryover.is_some() && !prompt_withheld(answer) => {
                if let Err(error) = self.store.clear_carryover(&session_id).await {
                    log::warn!(
                        "[agent-host] failed to settle the carry-over of {session_id}: {error}"
                    );
                }
            }
            Ok(answer) if import_handoff.is_some() && !prompt_withheld(answer) => {
                if let Err(error) = self
                    .store
                    .kv_delete(
                        crate::services::agent_host::transcript_import::HANDOFF_SCOPE,
                        &session_id,
                    )
                    .await
                {
                    log::warn!(
                        "[agent-host] failed to settle the loaded-chat handoff of {session_id}: {error}"
                    );
                }
            }
            Ok(_) => {}
            Err(error) => {
                let withdrawn = self.discard_rejected_prompt(&session_id, recorded).await;
                error["data"]["promptNotAccepted"] = json!(withdrawn);
                if !withdrawn {
                    // The turn did something before it failed, so its reply
                    // stays in the transcript — and so must the reason it
                    // stops where it does. The renderer that sent the prompt
                    // hears the error once in the reply; a renderer that
                    // reloads later, or opens this chat from a conductor's
                    // digest, reads it from here.
                    let reason = error["message"]
                        .as_str()
                        .filter(|message| !message.trim().is_empty())
                        .unwrap_or("The turn failed before the agent finished");
                    let mut pending = vec![(
                        session_id.clone(),
                        Self::turn_failed_update(&session_id, reason),
                    )];
                    if let Err(persist_error) = self.flush_pending_events(&mut pending).await {
                        log::warn!(
                            "[agent-host] failed to record why the turn of {session_id} failed: {persist_error}"
                        );
                    }
                    // Why the turn ended is otherwise only in the provider's
                    // words. A wave step goes on after a cut-off whether or
                    // not a spare account is ready, so it is told in a field.
                    if Self::cut_off_by_quota(error) {
                        error["data"]["cutOffByLimit"] = json!(true);
                    }
                    if let Some(spare) = self
                        .spare_account_after_quota(&record, error, ids.allow_credits)
                        .await
                    {
                        log::info!(
                            "[agent-host] {} ran out of its limit in the middle of a turn of {session_id}; {spare} is ready to go on",
                            record.account_id.as_deref().unwrap_or("its account")
                        );
                        error["data"]["continueOnAccount"] = json!(spare);
                    }
                }
                let automatic_routing = self
                    .automatic_account_switching(&record.harness)
                    .unwrap_or(false);
                if let (Some(link), Some(rejection)) = (
                    executor_link.as_ref(),
                    ReceiptRejection::quota_not_accepted(error, automatic_routing).or_else(|| {
                        ReceiptRejection::rate_limit_not_accepted(error, automatic_routing)
                    }),
                ) {
                    // Keep the claim until the host's withdrawal proof is durable.
                    // Neither a renderer error flag nor a failed receipt permits retry.
                    // A refused proof never becomes durable: the decision stays
                    // claimed, and the prompt settles with its error instead
                    // of holding the session forever.
                    while let Err(error) = self
                        .store
                        .mark_executor_prompt_unaccepted(link, &session_id, &ids.run_id, &rejection)
                        .await
                    {
                        if let EvidenceError::Refused(error) = error {
                            log::error!(
                                "[agent-host] unaccepted executor proof refused, decision stays claimed: {error}"
                            );
                            break;
                        }
                        log::error!(
                            "[agent-host] unaccepted executor proof not committed: {error}"
                        );
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                }
            }
        }
        // Steering while the turn ran: send the queued messages one after the
        // other so the agent sees them in order.
        loop {
            let queued = {
                let mut sessions = self.sessions.lock().await;
                let Some(runtime) = sessions.get_mut(&session_id) else {
                    break;
                };
                // A turn just ended: the chat's idle time starts now, not when
                // the turn began.
                runtime.touch();
                // The turn failed (the bridge exited, the prompt was
                // rejected): the queued steers were never sent, so they are
                // dropped rather than persisted and echoed as sent messages
                // that will never get a reply — and the caller keeps the real
                // error instead of the last steer's.
                if result.is_err() {
                    runtime.background.cancel();
                    let dropped = runtime.drop_queued_steers();
                    runtime.run = None;
                    if dropped > 0 {
                        log::warn!(
                            "[agent-host] session {session_id} turn failed: dropped {dropped} queued steer(s)"
                        );
                    }
                    break;
                }
                // A provider continuation can beat the cleanup of its parent
                // prompt. Keep the earlier queue claim until the reply ends.
                if !runtime.steer_queue.is_empty() && runtime.background.active_run_id().is_some() {
                    drop(sessions);
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                }
                let Some(queued) = runtime.steer_queue.pop_front() else {
                    runtime.run = None;
                    break;
                };
                if runtime.accepts_continuations() {
                    runtime.background.allow(&queued.ids.message_id);
                }
                runtime.run = Some(RunState::start(&queued.ids));
                turn.reopen(&queued.ids.run_id);
                queued
            };
            let recorded = match self
                .record_user_prompt(&session_id, &queued.prompt, &queued.meta, &queued.ids, true)
                .await
            {
                Ok(recorded) => recorded,
                Err(error) => {
                    if let Some(runtime) = self.sessions.lock().await.get_mut(&session_id) {
                        runtime.steer_queue.push_front(queued);
                        runtime.run = None;
                    }
                    return Err(error);
                }
            };
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
        // The turn and the steers it took are in the log in full: `run_prompt`
        // drains the bridge before a turn ends. Store them the way their
        // replay reads them. An owned session's runner is still paging the
        // log and compacts it itself once it has read everything
        // (`AgentHost::compact_owned_events`).
        if let Some(from) = turn_start {
            let compacted = match self.store.execution_owner(&session_id).await {
                Ok(Some(_)) => Ok(None),
                Ok(None) => self.store.compact_events(&session_id, from).await.map(Some),
                Err(error) => Err(error),
            };
            if let Err(error) = compacted {
                log::warn!("[agent-host] turn of {session_id} keeps its raw event rows: {error}");
            }
        }
        if result.is_ok() {
            if let Some(account_id) = &record.account_id {
                crate::services::provider_account_status::invalidate(&self.app, account_id).await;
            }
        }
        result
    }

    /// Whether the run `run_id` of a chat has had any of the agent's reply.
    pub(super) async fn run_saw_agent_message(&self, session_id: &str, run_id: &str) -> bool {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .and_then(|runtime| runtime.run.as_ref())
            .is_some_and(|run| run.run_id == run_id && run.saw_agent_message)
    }

    /// The failure a Kimi session recorded for the turn the host sent at
    /// `sent_at_ms`, if it recorded one (see `kimi::turn_outcome`). The CLI
    /// writes the record as the turn ends, a moment before it answers the
    /// prompt, so a record that does not show the turn yet is read again
    /// shortly; one that shows it ended cleanly settles the question at once.
    pub(super) async fn kimi_turn_failure(
        &self,
        bridge_session_id: &str,
        sent_at_ms: i64,
    ) -> Option<crate::services::agent_host::kimi::TurnFailure> {
        let env = self.spawn_env().await;
        let home = crate::services::agent_host::kimi::home(&env.shell_env)?;
        for attempt in 0..3 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
            let (home, session_id) = (home.clone(), bridge_session_id.to_string());
            let outcome = tokio::task::spawn_blocking(move || {
                crate::services::agent_host::kimi::turn_outcome(&home, &session_id, sent_at_ms)
            })
            .await
            .ok()?;
            match outcome {
                crate::services::agent_host::kimi::TurnOutcome::Failed(failure) => {
                    return Some(failure)
                }
                crate::services::agent_host::kimi::TurnOutcome::Ended => return None,
                crate::services::agent_host::kimi::TurnOutcome::Unknown => continue,
            }
        }
        None
    }

    /// Lets go of turn `run_id` of a chat, claimed by `claim_turn`, that ends
    /// before its prompt was sent; see [`Self::release_claim`].
    pub(super) async fn release_turn(&self, session_id: &str, run_id: &str) {
        let dropped = self
            .sessions
            .lock()
            .await
            .get_mut(session_id)
            .and_then(|runtime| Self::release_claim(runtime, run_id));
        if let Some(dropped) = dropped.filter(|dropped| *dropped > 0) {
            log::warn!(
                "[agent-host] session {session_id} turn ended before its prompt was sent: dropped {dropped} queued steer(s)"
            );
        }
    }

    /// Lets go of turn `run_id` the way a turn that failed does: the chat
    /// takes the next prompt, no reply continues under the turn's message,
    /// and messages steered into it are dropped rather than sent as turns
    /// nobody asked for. Only that run: one the chat no longer names is
    /// someone else's, and it is left alone. Answers how many queued steers
    /// were dropped, or `None` when the chat was not on `run_id`.
    pub(super) fn release_claim(runtime: &mut SessionRuntime, run_id: &str) -> Option<usize> {
        if runtime.run.as_ref().is_none_or(|run| run.run_id != run_id) {
            return None;
        }
        runtime.run = None;
        runtime.background.cancel();
        Some(runtime.drop_queued_steers())
    }

    /// Stores what the provider answered an owned (benchmark or task) turn,
    /// its `benchmark_turn_result`; nothing for an ordinary chat. Retried
    /// every `pause` until it commits, the policy of the executor receipt
    /// beside it, so there is no error a caller could put in place of the
    /// provider's answer.
    pub(super) async fn commit_turn_result(
        store: &SessionStore,
        session_id: &str,
        raw_result: &Result<Value, Value>,
        pause: std::time::Duration,
    ) {
        while let Err(error) = Self::record_turn_result(store, session_id, raw_result).await {
            log::error!(
                "[agent-host] benchmark turn result of {session_id} not committed: {error}"
            );
            tokio::time::sleep(pause).await;
        }
    }

    async fn record_turn_result(
        store: &SessionStore,
        session_id: &str,
        raw_result: &Result<Value, Value>,
    ) -> Result<(), String> {
        let Some((owner, _)) = store.execution_owner(session_id).await? else {
            return Ok(());
        };
        let raw = match raw_result {
            Ok(value) => {
                json!({"usage":value.get("usage"),"quota":value.pointer("/_meta/quota"),"stopReason":value.get("stopReason")})
            }
            Err(error) => json!({"error":error}),
        };
        let purpose = store
            .owned_session_purpose(session_id)
            .await?
            .unwrap_or_else(|| "benchmark".into());
        store.append_events(session_id,&[json!({"sessionId":session_id,"update":{"sessionUpdate":"benchmark_turn_result","_meta":{"executionOwner":{"kind":purpose,"id":owner.owner_id},"benchmarkRawResult":raw}}})]).await?;
        Ok(())
    }

    /// Register a turn on an idle session and answer with the bridge session
    /// its prompt must go to, both read under one lock. `Err` names the run
    /// already going, which a steered prompt queues behind and an ordinary one
    /// is refused for.
    pub(super) fn claim_turn(
        runtime: &mut SessionRuntime,
        ids: &TurnIds,
    ) -> Result<String, String> {
        if let Some(active) = runtime.active_run_id() {
            return Err(active.to_owned());
        }
        if runtime.accepts_continuations() {
            runtime.background.allow(&ids.message_id);
        }
        runtime.run = Some(RunState::start(ids));
        Ok(runtime.bridge_session_id.clone())
    }

    pub(super) async fn run_prompt(
        &self,
        bridge: &Bridge,
        session_id: &str,
        bridge_session_id: &str,
        prompt: Value,
        meta: Value,
    ) -> Result<Value, Value> {
        self.run_prompt_with_admission(
            bridge,
            session_id,
            bridge_session_id,
            prompt,
            meta,
            None,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_prompt_with_admission(
        &self,
        bridge: &Bridge,
        session_id: &str,
        bridge_session_id: &str,
        prompt: Value,
        mut meta: Value,
        task_admission: Option<tokio::sync::OwnedMutexGuard<()>>,
        owned_deadline: Option<tokio::time::Instant>,
    ) -> Result<Value, Value> {
        let link = ExecutorLink::take(&mut meta).map_err(invalid_params)?;
        if link
            .as_ref()
            .is_some_and(|link| link.decision_key.starts_with("owned-task:"))
            && task_admission.is_none()
        {
            return Err(invalid_params(
                "Task-bound executor keys require the native owned dispatch authority",
            ));
        }
        if task_admission.is_some() {
            let (owner, _) = self
                .store
                .execution_owner(session_id)
                .await
                .map_err(protocol::internal)?
                .ok_or_else(|| invalid_params("Native task owner disappeared"))?;
            let binding_id = owner
                .owner_id
                .strip_prefix("task:")
                .ok_or_else(|| invalid_params("Native task owner is invalid"))?;
            let link = link
                .as_ref()
                .ok_or_else(|| invalid_params("Native task processing has no bound key"))?;
            if link.logical_run_id != link.decision_key {
                return Err(invalid_params(
                    "Native task logical receipt identity changed",
                ));
            }
            let service = self
                .app
                .state::<crate::services::benchmarks::BenchmarkState>()
                .get(&self.app)
                .await
                .map_err(|error| protocol::internal(error.message))?;
            service
                .validate_final_owned_task(binding_id, session_id, &link.decision_key)
                .await
                .map_err(|error| protocol::internal(error.message))?;
            if self
                .store
                .execution_cancel_requested(&link.decision_key)
                .await
                .map_err(protocol::internal)?
            {
                return Err(protocol::internal(
                    "cancelled: task was cancelled before processing",
                ));
            }
        }
        let mut request = json!({ "sessionId": bridge_session_id, "prompt": prompt });
        if meta.as_object().is_some_and(|meta| !meta.is_empty()) {
            request["_meta"] = meta;
        }
        let (run_id, receipt_start, kimi_record) = {
            let sessions = self.sessions.lock().await;
            let runtime = sessions
                .get(session_id)
                .ok_or_else(|| protocol::internal("Session ended before its provider request"))?;
            let run = runtime
                .run
                .as_ref()
                .ok_or_else(|| protocol::internal("Turn ended before its provider request"))?;
            let receipt = link.map(|link| ReceiptStart {
                link,
                session_id: session_id.to_string(),
                host_run_id: run.run_id.clone(),
                message_id: run.message_id.clone(),
                bridge_generation: runtime.generation,
                provider_id: runtime.harness.clone(),
                account_id: runtime.account_id.clone(),
                started_at: now_iso(),
                selection: ReportedSelection::read(&runtime.snapshot),
            });
            // Kimi answers a failed turn with a plain `end_turn`; an ordinary
            // chat reads its session record afterwards (`kimi_turn_failure`).
            // An owned run has its record in the sandbox, out of reach.
            // Kimi also queues a prompt that arrives while a turn of its own
            // runs, and shows that prompt's answer only on its record
            // (`kimi_relay`), so the record is followed from before the send.
            let kimi_record = (runtime.harness == "kimi-acp"
                && runtime.execution_profile.is_none())
            .then(|| (runtime.generation, run.message_id.clone()));
            (run.run_id.clone(), receipt, kimi_record)
        };
        if let Some((generation, message_id)) = &kimi_record {
            self.follow_kimi_prompt(session_id, bridge_session_id, *generation, message_id)
                .await;
        }
        let mut prompt_admission = task_admission;
        if let Some(start) = &receipt_start {
            check_owned_deadline(owned_deadline)?;
            if prompt_admission.is_none() {
                let service = self
                    .app
                    .state::<crate::services::benchmarks::BenchmarkState>()
                    .get(&self.app)
                    .await
                    .map_err(|error| protocol::internal(error.message))?;
                prompt_admission = service
                    .store
                    .admit_ordinary_executor(start)
                    .await
                    .map_err(|error| protocol::internal(error.message))?;
            }
            if !self
                .store
                .claim_executor_receipt_with_routing(
                    start,
                    self.automatic_account_switching(&start.provider_id)?,
                )
                .await
                .map_err(protocol::internal)?
            {
                return Err(invalid_params("This executor decision already claimed a provider dispatch; inspect its recorded run before retrying"));
            }
        }
        let sent_at_ms = chrono::Utc::now().timestamp_millis();
        let raw_result = match prompt_admission {
            Some(admission) => {
                bridge
                    .prompt_with_admission(request, run_id.clone(), Some(admission), owned_deadline)
                    .await
            }
            None => match owned_deadline {
                Some(deadline) => {
                    bridge
                        .prompt_with_admission(request, run_id.clone(), None, Some(deadline))
                        .await
                }
                None => bridge.prompt(request, run_id.clone()).await,
            },
        };
        // The provider has answered, and an owned turn is billed by now. Like
        // the receipt write below, a failed local write must never turn that
        // answer into an error: the turn was reported failed and a runner
        // that retries pays for the task again (2026-11-25 hunt, D-4).
        Self::commit_turn_result(
            &self.store,
            session_id,
            &raw_result,
            std::time::Duration::from_secs(1),
        )
        .await;
        let mut result = Self::prompt_response(raw_result);
        // The bridge writes every update of the turn before it answers the
        // prompt, but the two do not travel together: its reader hands the
        // answer straight to this request, while the updates wait in the
        // event queue (see `bridge_event_loop`). Until the loop has reached
        // the point of the answer, the reply's tail is still queued, and
        // handling it after the caller ends this run would stamp it with no
        // run or with the next steered turn's ids, storing it under the
        // wrong message; the snippet read below would miss it too. An answer
        // that is an error gets the same wait, since a failed turn may have
        // streamed as well.
        while let Err(error) = self.drain_bridge_events().await {
            log::error!(
                "[agent-host] holding turn {session_id} until history is durable: {}",
                error_text(&error)
            );
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        if let Some((generation, message_id)) = kimi_record.as_ref().filter(|_| {
            result
                .as_ref()
                .is_ok_and(|response| response["stopReason"].as_str() == Some("end_turn"))
        }) {
            if let Some(failure) = self.kimi_turn_failure(bridge_session_id, sent_at_ms).await {
                log::warn!(
                    "[agent-host] kimi-acp turn of {session_id} failed out of band ({}): {}",
                    if failure.is_quota() {
                        "quota"
                    } else {
                        "provider"
                    },
                    failure.message
                );
                result = Err(failure.prompt_error());
            } else if !self.run_saw_agent_message(session_id, &run_id).await {
                self.settle_kimi_prompt(
                    session_id,
                    bridge_session_id,
                    *generation,
                    message_id,
                    sent_at_ms,
                )
                .await;
            }
        }
        if let Some(start) = &receipt_start {
            let (selection, changes, changes_truncated) = {
                let sessions = self.sessions.lock().await;
                match sessions
                    .get(session_id)
                    .filter(|runtime| runtime.generation == start.bridge_generation)
                    .and_then(|runtime| {
                        runtime
                            .run
                            .as_ref()
                            .filter(|run| run.run_id == run_id)
                            .map(|run| (runtime, run))
                    }) {
                    Some((runtime, run)) => (
                        ReportedSelection::read(&runtime.snapshot),
                        run.configuration_changes.clone(),
                        run.changes_truncated,
                    ),
                    None => (ReportedSelection::default(), Vec::new(), true),
                }
            };
            let status = match &result {
                Ok(value) if value["stopReason"].as_str() == Some("cancelled") => "cancelled",
                Ok(_) => "completed",
                Err(_) => "failed",
            };
            let finish = ReceiptFinish {
                finished_at: now_iso(),
                status: status.into(),
                selection,
                changes,
                changes_truncated,
            };
            // A completed provider request must never turn into a retryable
            // send error because recording its receipt failed. Keep retrying
            // the identical local write while the run remains claimed.
            while let Err(error) = self.store.finish_executor_receipt(start, &finish).await {
                log::error!("[agent-host] executor terminal receipt not committed: {error}");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
        let (agent_text, saw_agent_message) = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .and_then(|runtime| runtime.run.as_ref())
                .map(|run| (run.agent_text.clone(), run.saw_agent_message))
                .unwrap_or_default()
        };
        let snippet = message_snippet(&agent_text);
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
}
