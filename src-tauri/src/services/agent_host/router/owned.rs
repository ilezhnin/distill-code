//! Sessions and turns another service owns (benchmarks, tasks): creation, dispatch, status, cancellation and cleanup.
use super::*;

impl Inner {
    /// Opens the owned session `request` names, or returns the one its owner
    /// already has. `turn_limit_ms` is the longest its turn may run, which the
    /// sign-in of a bridge that cannot refresh it must outlast.
    pub async fn create_owned_session(
        self: &Arc<Self>,
        request: OwnedSessionRequest,
        turn_limit_ms: u64,
    ) -> Result<OwnedSession, String> {
        self.create_owned_session_for_purpose(request, turn_limit_ms, "benchmark")
            .await
    }

    /// Application tasks explicitly opt into the same verified owned runtime.
    /// They remain protected from ordinary ACP mutations and sends.
    pub async fn create_task_owned_session(
        self: &Arc<Self>,
        request: OwnedSessionRequest,
        turn_limit_ms: u64,
    ) -> Result<OwnedSession, String> {
        if !request.owner_id.starts_with("task:") {
            return Err("validation: invalid task owner".into());
        }
        self.create_owned_session_for_purpose(request, turn_limit_ms, "task")
            .await
    }

    /// Boxed for the same stack reason as [`Self::ensure_execution_bridge`].
    pub(super) fn create_owned_session_for_purpose<'a>(
        self: &'a Arc<Self>,
        mut request: OwnedSessionRequest,
        turn_limit_ms: u64,
        purpose: &'a str,
    ) -> BoxFuture<'a, Result<OwnedSession, String>> {
        Box::pin(async move {
            let provider = execution::validate_request(&request)?;
            if turn_limit_ms == 0 || turn_limit_ms > MAX_OWNED_TURN_MS {
                return Err(
                    "validation: owned execution requires a turn limit from 1 ms to 24 hours"
                        .into(),
                );
            }
            // The owned workspace is a Linux mount, never a Windows task folder.
            request.cwd = "/workspace".into();
            // Fail closed: a profile the policy probe has not passed on what this
            // build ships never starts.
            let repository_revision = if request.profile == ExecutionProfile::ProtectedRepositoryV1
            {
                let status = repository_execution::readiness(provider, &request.account_id).await?;
                Some(repository_execution::revision(provider, &status))
            } else {
                None
            };
            let text_revision = if repository_revision.is_none() {
                let status = text_execution::readiness(provider, &request.account_id).await?;
                Some(text_execution::revision(provider, &status))
            } else {
                None
            };
            let policy_hash = match &repository_revision {
                Some(revision) => repository_execution::policy_hash(&request, revision)?,
                None => text_execution::policy_hash(
                    &request,
                    text_revision.as_deref().expect("text revision"),
                )?,
            };
            let lock = self
                .owned_lock(&format!("owner:{}", request.owner_id))
                .await;
            let _guard = lock.lock().await;
            let existing_id = self.store.owned_session_id(&request.owner_id).await?;
            if let Some(id) = existing_id.as_ref() {
                if self.store.owned_session_purpose(id).await?.as_deref() != Some(purpose) {
                    return Err("validation: owner purpose changed".into());
                }
                let (_, existing_hash) = self
                    .store
                    .execution_owner(id)
                    .await?
                    .ok_or("evidence_missing: owner")?;
                if existing_hash != policy_hash {
                    return Err("validation: owner already exists with another policy".into());
                }
                let record = self.session_record(id).await.map_err(|e| error_text(&e))?;
                if self.attached_route(id).await.is_some()
                    || self.store.session_has_execution_dispatch(id).await?
                {
                    return Ok(Self::owned_session_result(&request, &record, existing_hash));
                }
            }
            if self.shutdown_prepared.load(Ordering::SeqCst) {
                return Err("Flock is closing".into());
            }
            let account = provider_accounts::resolve_account(
                &self.app,
                &request.provider_id,
                Some(&request.account_id),
            )?;
            let profile_key = if repository_revision.is_some() {
                repository_execution::profile_key(&request.owner_id)
            } else {
                text_execution::profile_key(&request.owner_id)
            };
            let sandbox_id = if repository_revision.is_some() {
                repository_execution::attempt_id(&request.owner_id)
            } else {
                text_execution::attempt_id(&request.owner_id)
            };
            let mut setup_cleanup =
                crate::services::benchmark_sandbox::Cleanup(Some(sandbox_id.clone()));
            let setup_route = format!(
                "{}{BENCHMARK_ROUTE}{profile_key}",
                account_route_key(&request.provider_id, Some(&request.account_id))
            );
            let mut sandbox_clear = false;
            let result = async {
        let bridge = self
            .ensure_execution_bridge(
                &request.provider_id,
                Some(&account.id),
                Some(OwnedBridge {
                    profile_key: &profile_key,
                    request: &request,
                    revision: repository_revision.as_deref().or(text_revision.as_deref()).expect("isolated revision"),
                    provider,
                    turn_limit_ms,
                }),
            )
            .await
            .map_err(|e| {
                sandbox_clear = e["code"] == CLEAR_SANDBOX_REFUSAL;
                error_text(&e)
            })?;
        let meta = if repository_revision.is_some() {
            repository_execution::session_meta(provider, &request.model_id)
        } else {
            provider.session_meta(&request.model_id)
        };
        let opened = bridge
            .request(
                "session/new",
                json!({"cwd":request.cwd,"mcpServers":[],"_meta":meta}),
            )
            .await
            .map_err(|e| error_text(&e))?;
        let bridge_session_id =
            protocol::session_id(&opened).ok_or("bridge returned no sessionId")?;
        let mode = if repository_revision.is_some() {
            repository_execution::permission_mode(provider)
        } else {
            provider.permission_mode()
        };
        if let Some(mode) = mode {
            if let Err(error) = bridge
                .request(
                    "session/set_mode",
                    json!({"sessionId":bridge_session_id,"modeId":mode}),
                )
                .await
            {
                bridge.close_session(&bridge_session_id).await;
                return Err(format!(
                    "capability_missing: explicit permission mode was rejected: {}",
                    error_text(&error)
                ));
            }
        }
        let wanted = Selection {
            model: Some(request.model_id.clone()),
            effort: request.reasoning_effort.clone(),
            fast: request.fast_mode,
        };
        let mut snapshot = Self::snapshot_from(&opened);
        let substitutions = self
            .apply_to_session(
                &request.provider_id,
                &bridge,
                &bridge_session_id,
                &mut snapshot,
                &wanted,
                true,
            )
            .await;
        let acknowledged = Self::selection_from(&snapshot["configOptions"]);
        // A bridge that lands on a refused effort by itself must not run it.
        if let Some(reason) = provider.effort_refusal(acknowledged.effort.as_deref()) {
            bridge.close_session(&bridge_session_id).await;
            return Err(format!("capability_missing: {reason}"));
        }
        let matches = substitutions.is_empty()
            && ObservedSelection {
                model_id: acknowledged.model.clone(),
                reasoning_effort: acknowledged.effort.clone(),
                fast_mode: acknowledged.fast,
            }.matches(&request);
        snapshot["_meta"]["executionOwner"] = json!({"kind":purpose,"id":request.owner_id});
        snapshot["_meta"]["executionPolicy"] = json!({
            "repositoryRevision": repository_revision, "textRevision": text_revision,
        });
        let session_id = existing_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let now = now_iso();
        let record = SessionRecord {
            id: session_id.clone(),
            harness: request.provider_id.clone(),
            account_id: Some(account.id),
            bridge_session_id: Some(bridge_session_id.clone()),
            cwd: request.cwd.clone(),
            title: Some(request.title.clone()),
            user_set_name: true,
            project_id: None,
            persona_id: None,
            model_id: acknowledged.model.clone(),
            reasoning_effort: acknowledged.effort.clone(),
            fast_mode: acknowledged.fast,
            legacy_model_id: None,
            hidden: purpose == "benchmark",
            created_at: now.clone(),
            updated_at: now,
            last_message_at: None,
            archived_at: None,
            message_count: 0,
            last_snippet: None,
            snapshot: Some(snapshot.clone()),
        };
        let stored = if existing_id.is_some() {
            self.store
                .set_bridge_session_id(&record.id, Some(&bridge_session_id))
                .await?;
            self.store_bridge_selection(&record.id, &snapshot, &acknowledged)
                .await;
            Ok(())
        } else if purpose == "benchmark" {
            self.store
                .insert_owned_session(&record, &request, &policy_hash)
                .await
        } else {
            self.store
                .insert_owned_session_for_purpose(&record, &request, &policy_hash, purpose)
                .await
        };
        if let Err(error) = stored {
            bridge.close_session(&bridge_session_id).await;
            return Err(error);
        }
        if let Err(error) = install_owned_runtime(
            &self.events_tx,
            &self.sessions,
            session_id.clone(),
            SessionRuntime {
                harness: request.provider_id.clone(),
                account_id: Some(request.account_id.clone()),
                execution_profile: Some(profile_key),
                bridge_session_id: bridge_session_id.clone(),
                generation: bridge.generation(),
                loading: false,
                run: None,
                background: Default::default(),
                context: Default::default(),
                steer_queue: VecDeque::new(),
                native_steers: Vec::new(),
                has_model_option: Self::has_model_option(&snapshot),
                snapshot,
                substitutions: substitutions.clone(),
                last_active: std::time::Instant::now(),
            },
        )
        .await
        {
            bridge.close_session(&bridge_session_id).await;
            return Err(error_text(&error));
        }
        let mut result = Self::owned_session_result(&request, &record, policy_hash);
        result.substitutions = substitutions;
        if !matches && result.substitutions.is_empty() {
            result.substitutions.push(json!({"kind":"selection_changed","message":"Requested selection was not acknowledged exactly"}));
        }
        Ok(result)
        }.await;
            if result.is_err() {
                if let Some(bridge) = self.bridges.lock().await.remove(&setup_route) {
                    bridge.kill();
                }
                // A refusal that reserved nothing left the sandbox as it was
                // cleared before asking: nothing to clean again here.
                if !sandbox_clear {
                    if let Err(error) = crate::services::benchmark_sandbox::clean(&sandbox_id).await
                    {
                        log::warn!("[agent-host] owned setup cleanup failed: {error}");
                        return result;
                    }
                }
            }
            setup_cleanup.0 = None;
            result
        })
    }

    pub(super) fn owned_session_result(
        request: &OwnedSessionRequest,
        record: &SessionRecord,
        policy_hash: String,
    ) -> OwnedSession {
        OwnedSession {
            session_id: record.id.clone(),
            owner_id: request.owner_id.clone(),
            policy_hash,
            selection: ObservedSelection {
                model_id: record.model_id.clone(),
                reasoning_effort: record.reasoning_effort.clone(),
                fast_mode: record.fast_mode,
            },
            substitutions: Vec::new(),
        }
    }

    pub(in crate::services::agent_host) async fn owned_lock(&self, key: &str) -> Arc<Mutex<()>> {
        Arc::clone(
            self.owned_locks
                .lock()
                .await
                .entry(key.to_string())
                .or_default(),
        )
    }

    /// Observe setup under the very same owner/create and dispatch locks used
    /// by effects. No new bridge/session or model probe is started here.
    pub(crate) async fn lookup_owned_task_preparation(
        &self,
        owner_id: &str,
        request_key: &str,
    ) -> Result<crate::services::benchmarks::task_execution::NativePreparationLookup, String> {
        if !owner_id.starts_with("task:") || !request_key.starts_with("owned-task:") {
            return Err("validation: native task preparation identity is invalid".into());
        }
        let owner_lock = self.owned_lock(&format!("owner:{owner_id}")).await;
        let _owner_guard = owner_lock.lock().await;
        let session_id = self.store.owned_session_id(owner_id).await?;
        let dispatch_lock = match &session_id {
            Some(id) => Some(self.owned_lock(&format!("dispatch:{id}")).await),
            None => None,
        };
        let _dispatch_guard = match &dispatch_lock {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };
        if let Some(id) = &session_id {
            let (owner, _) = self
                .store
                .execution_owner(id)
                .await?
                .ok_or("evidence_missing: native task owner is absent")?;
            if owner.owner_id != owner_id
                || self.store.owned_session_purpose(id).await?.as_deref() != Some("task")
            {
                return Err("validation: native setup belongs to another purpose or owner".into());
            }
            if self.store.get_session(id).await?.is_none() {
                return Err("evidence_missing: native setup record is absent".into());
            }
        }
        let dispatch = self.store.execution_dispatch(request_key).await?;
        let receipt = self.store.executor_receipt(request_key).await?;
        let active = session_id.as_ref().is_some_and(|id| {
            self.sessions.try_lock().map_or(true, |sessions| {
                sessions
                    .get(id)
                    .is_some_and(|runtime| runtime.run.is_some())
            })
        });
        Ok(
            crate::services::benchmarks::task_execution::NativePreparationLookup {
                session_id,
                no_provider_start: dispatch.is_none() && receipt.is_none() && !active,
            },
        )
    }

    pub async fn dispatch_owned_turn(
        self: &Arc<Self>,
        request: OwnedTurnRequest,
    ) -> Result<ExecutionDispatch, String> {
        self.dispatch_owned_turn_with_link(request, None, None, None, None)
            .await
    }

    /// Persist the no-prompt terminal outcome on the existing dispatch ledger.
    /// Only a native expired binding and exact owned session may use this path.
    pub(crate) async fn refuse_task_owned_turn(
        &self,
        session_id: &str,
        request_key: &str,
        owner_id: &str,
        policy_hash: &str,
    ) -> Result<ExecutionDispatch, String> {
        let lock = self.owned_lock(&format!("dispatch:{session_id}")).await;
        let _guard = lock.lock().await;
        let (owner, hash) = self
            .store
            .execution_owner(session_id)
            .await?
            .ok_or("validation: task owner is absent")?;
        if owner.owner_id != owner_id
            || hash != policy_hash
            || self
                .store
                .owned_session_purpose(session_id)
                .await?
                .as_deref()
                != Some("task")
        {
            return Err("validation: task refusal owner or policy differs".into());
        }
        let id = owner_id
            .strip_prefix("task:")
            .ok_or("validation: task binding is absent")?;
        let service = self
            .app
            .state::<crate::services::benchmarks::BenchmarkState>()
            .get(&self.app)
            .await
            .map_err(|error| error.message)?;
        service
            .expired_owned_task_identity(id, session_id, request_key)
            .await
            .map_err(|error| error.message)?;
        if let Some(dispatch) = self.store.execution_dispatch(request_key).await? {
            return Ok(dispatch);
        }
        if self.store.executor_receipt(request_key).await?.is_some()
            || self
                .sessions
                .lock()
                .await
                .get(session_id)
                .is_some_and(|runtime| runtime.run.is_some())
        {
            return Err("dispatch_uncertain: native provider-start absence is unconfirmed".into());
        }
        let ids = TurnIds::new();
        let dispatch = ExecutionDispatch {
            request_key: request_key.into(),
            session_id: session_id.into(),
            run_id: ids.run_id,
            user_message_id: ids.message_id,
            phase: "reserved".into(),
            event_cursor: 0,
            result: None,
            error: None,
        };
        // The identity is immutable even when no user prompt was transmitted.
        self.store
            .reserve_dispatch(&dispatch, &execution::digest(b"native-budget-no-prompt-v1"))
            .await?;
        let error = json!({"kind":"budget_timeout","message":"Native root budget expired before any provider prompt","proof":"native-owned-no-provider-start-v1"});
        self.store
            .settle_dispatch(request_key, "terminal", None, Some(&error))
            .await?;
        self.store
            .execution_dispatch(request_key)
            .await?
            .ok_or("evidence_missing: native refusal disappeared".into())
    }

    /// Rust-only collection admission supplies the shared native root deadline;
    /// this is not a renderer dispatch parameter or a replacement receipt path.
    pub(crate) async fn dispatch_owned_turn_with_deadline(
        self: &Arc<Self>,
        request: OwnedTurnRequest,
        deadline_at_ms: i64,
    ) -> Result<ExecutionDispatch, String> {
        self.dispatch_owned_turn_with_link(request, None, None, None, Some(deadline_at_ms))
            .await
    }

    pub async fn dispatch_task_owned_turn(
        self: &Arc<Self>,
        request: OwnedTurnRequest,
        link: ExecutorLink,
        admission: tokio::sync::OwnedMutexGuard<()>,
        max_artifact_bytes: u64,
    ) -> Result<ExecutionDispatch, String> {
        if self
            .store
            .owned_session_purpose(&request.session_id)
            .await?
            .as_deref()
            != Some("task")
        {
            return Err("validation: session is not an application task owner".into());
        }
        let (owner, _) = self
            .store
            .execution_owner(&request.session_id)
            .await?
            .ok_or("validation: native task owner is absent")?;
        let binding_id = owner
            .owner_id
            .strip_prefix("task:")
            .ok_or("validation: native task binding is absent")?;
        let service = self
            .app
            .state::<crate::services::benchmarks::BenchmarkState>()
            .get(&self.app)
            .await
            .map_err(|error| error.message)?;
        let deadline = service
            .owned_task_deadline_at_ms(binding_id)
            .await
            .map_err(|error| error.message)?;
        self.dispatch_owned_turn_with_link(
            request,
            Some(link),
            Some(admission),
            Some(max_artifact_bytes),
            deadline,
        )
        .await
    }

    pub(super) async fn dispatch_owned_turn_with_link(
        self: &Arc<Self>,
        request: OwnedTurnRequest,
        link: Option<ExecutorLink>,
        task_admission: Option<tokio::sync::OwnedMutexGuard<()>>,
        task_answer_cap: Option<u64>,
        deadline_at_ms: Option<i64>,
    ) -> Result<ExecutionDispatch, String> {
        if request.request_key.trim().is_empty()
            || request.request_key.len() > 256
            || request.prompt.len() > 1024 * 1024
            || request
                .images
                .iter()
                .map(|image| image.data.len())
                .sum::<usize>()
                > 6 * 1024 * 1024
            || request.timeout_ms == 0
            || request.timeout_ms > MAX_OWNED_TURN_MS
        {
            return Err("validation: invalid dispatch key, prompt size or time limit".into());
        }
        let lock = self
            .owned_lock(&format!("dispatch:{}", request.session_id))
            .await;
        let _guard = lock.lock().await;
        let (owner, hash) = self
            .store
            .execution_owner(&request.session_id)
            .await?
            .ok_or("validation: session has no execution owner")?;
        if request.policy_hash != hash {
            return Err("validation: execution policy changed".into());
        }
        let prompt_hash = execution::digest(request.prompt.as_bytes());
        if let Some(existing) = self.store.execution_dispatch(&request.request_key).await? {
            self.store.reserve_dispatch(&existing, &prompt_hash).await?;
            if existing.session_id != request.session_id {
                return Err("validation: request key belongs to another session".into());
            }
            return Ok(existing);
        }
        let current = self
            .session_record(&request.session_id)
            .await
            .map_err(|e| error_text(&e))?;
        self.require_owned_selection(&owner, &current).await?;
        if self.attached_route(&request.session_id).await.is_none() {
            return Err(
                "dispatch_uncertain: owned runtime is unavailable; create an explicit rerun".into(),
            );
        }
        let provider = NativeProvider::for_harness(&current.harness);
        let mut ids = TurnIds::new();
        // Anchor before reservation and every worker await. The UTC cap is
        // projected once onto the monotonic clock; setup never restores time.
        let monotonic_deadline = owned_turn_deadline(request.timeout_ms, deadline_at_ms);
        ids.owned_deadline = deadline_at_ms.map(|_| monotonic_deadline);
        ids.allow_credits = request.allow_credits;
        let dispatch = ExecutionDispatch {
            request_key: request.request_key.clone(),
            session_id: request.session_id.clone(),
            run_id: ids.run_id.clone(),
            user_message_id: ids.message_id.clone(),
            phase: "reserved".into(),
            event_cursor: 0,
            result: None,
            error: None,
        };
        if !self.store.reserve_dispatch(&dispatch, &prompt_hash).await? {
            return self
                .store
                .execution_dispatch(&request.request_key)
                .await?
                .ok_or("dispatch_uncertain: reservation vanished".into());
        }
        let host = Arc::clone(self);
        tokio::spawn(async move {
            if tokio::time::Instant::now() >= monotonic_deadline {
                let error = json!({"kind":"budget_timeout","message":"Native root wall budget expired before dispatch","proof":"native-owned-no-provider-start-v1"});
                let _ = host
                    .store
                    .settle_dispatch(&request.request_key, "terminal", None, Some(&error))
                    .await;
                return;
            }
            if let Err(error) = host
                .store
                .settle_dispatch(&request.request_key, "running", None, None)
                .await
            {
                log::error!("[agent-host] owned dispatch cannot start: {error}");
                return;
            }
            if host
                .store
                .execution_cancel_requested(&request.request_key)
                .await
                .unwrap_or(true)
            {
                let error = json!({"kind":"cancelled","message":"Cancelled before dispatch"});
                let _ = host
                    .store
                    .settle_dispatch(&request.request_key, "terminal", None, Some(&error))
                    .await;
                return;
            }
            let blocks = owned_prompt_blocks(&request.prompt, &request.images);
            let purpose = host
                .store
                .owned_session_purpose(&request.session_id)
                .await
                .ok()
                .flatten()
                .unwrap_or_else(|| "benchmark".into());
            let mut prompt = owned_prompt_params(
                &request.session_id,
                blocks,
                &owner.owner_id,
                provider,
                &purpose,
            );
            if let Some(link) = link {
                prompt["_meta"]["executorSelection"] = json!(link);
            }
            let task = host.start_turn_with_admission(prompt, ids, false, task_admission);
            tokio::pin!(task);
            let mut timed_out = false;
            let cancellation = async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    if host
                        .store
                        .execution_cancel_requested(&request.request_key)
                        .await
                        .unwrap_or(true)
                    {
                        break;
                    }
                }
            };
            let mut cancelled = false;
            let mut policy_failure = None;
            let policy_monitor = async {
                match task_answer_cap {
                    Some(cap) => {
                        crate::services::benchmarks::runner::monitor_owned_task(
                            &host,
                            &request.session_id,
                            cap,
                        )
                        .await
                    }
                    None => std::future::pending().await,
                }
            };
            let outcome = tokio::select! {
                biased;
                _=tokio::time::sleep_until(monotonic_deadline)=>{
                    timed_out=true;
                    let _=host.cancel_owned_turn(&request.request_key).await;
                    match tokio::time::timeout(std::time::Duration::from_secs(15),&mut task).await {
                        Ok(result)=>result,
                        Err(_)=>{
                            let error=json!({"kind":"dispatch_uncertain","message":"Budget cancellation was not acknowledged; the account remains busy"});
                            let _=host.store.settle_dispatch(&request.request_key,"uncertain",None,Some(&error)).await;
                            let _=task.await;
                            return;
                        }
                    }
                }
                result=&mut task => result,
                failure=policy_monitor=>{
                    policy_failure=Some(failure);
                    let _=host.cancel_owned_turn(&request.request_key).await;
                    match tokio::time::timeout(std::time::Duration::from_secs(15),&mut task).await {
                        Ok(result)=>result,
                        Err(_)=>{
                            let error=json!({"kind":"dispatch_uncertain","message":"Policy cancellation was not acknowledged; inspect the account"});
                            let _=host.store.settle_dispatch(&request.request_key,"uncertain",None,Some(&error)).await;
                            let _=task.await;
                            return;
                        }
                    }
                }
                _=cancellation=>{
                    cancelled=true;
                    let _=host.cancel_owned_turn(&request.request_key).await;
                    match tokio::time::timeout(std::time::Duration::from_secs(15),&mut task).await {
                        Ok(result)=>result,
                        Err(_)=>{
                            let error=json!({"kind":"dispatch_uncertain","message":"Cancellation was not acknowledged; the account remains busy"});
                            let _=host.store.settle_dispatch(&request.request_key,"uncertain",None,Some(&error)).await;
                            let _=task.await;
                            return;
                        }
                    }
                }
            };
            let native_elapsed_ms = host.store.execution_clock_now(&request.request_key).await;
            let mut result = outcome.as_ref().ok().cloned();
            let mut error = outcome.err();
            if result
                .as_ref()
                .is_some_and(|value| value["stopReason"] == "cancelled")
            {
                cancelled = true;
            }
            if cancelled {
                error = Some(json!({"kind":"cancelled","message":"Cancelled by the operator"}));
                result = None;
            }
            if timed_out {
                error = Some(
                    json!({"kind":"budget_timeout","message":"The declared task duration expired"}),
                );
                result = None;
            }
            if let Some(failure) = policy_failure {
                error = Some(failure);
                result = None;
            }
            let mut public_output = None;
            if let Some(cap) = task_answer_cap {
                match crate::services::benchmarks::runner::owned_task_public_output(
                    &host,
                    &request.session_id,
                    cap,
                    true,
                )
                .await
                {
                    Ok(output) => public_output = output,
                    Err(failure) => {
                        error = Some(failure);
                        result = None;
                    }
                }
            }
            match host.session_record(&request.session_id).await {
                Ok(record) => {
                    if let Err(reason) = host.require_owned_selection(&owner, &record).await {
                        error = Some(json!({"kind":terminal_error_kind(&reason),"message":reason}));
                        result = None;
                    } else if let Some(value) = result.as_mut() {
                        value["observedSelection"] = json!(ObservedSelection {
                            model_id: record.model_id,
                            reasoning_effort: record.reasoning_effort,
                            fast_mode: record.fast_mode
                        });
                    }
                }
                Err(err) => {
                    error = Some(err);
                    result = None;
                }
            }
            match &native_elapsed_ms {
                Ok(elapsed) => {
                    if let Some(value) = result.as_mut().and_then(Value::as_object_mut) {
                        value.insert("nativeExecutionMs".into(), json!(elapsed));
                    }
                    if let Some(value) = error.as_mut().and_then(Value::as_object_mut) {
                        value.insert("nativeExecutionMs".into(), json!(elapsed));
                    }
                }
                Err(reason) => {
                    error = Some(json!({"kind":"dispatch_uncertain","message":reason}));
                    result = None;
                }
            }
            let settled = if task_answer_cap.is_some() {
                match native_elapsed_ms {
                    Ok(elapsed) => {
                        host.store
                            .settle_task_dispatch(
                                &request.request_key,
                                &request.session_id,
                                result.as_ref(),
                                error.as_ref(),
                                public_output.as_deref(),
                                elapsed,
                            )
                            .await
                    }
                    Err(_) => {
                        host.store
                            .settle_dispatch(
                                &request.request_key,
                                "uncertain",
                                None,
                                error.as_ref(),
                            )
                            .await
                    }
                }
            } else {
                host.store
                    .settle_dispatch(
                        &request.request_key,
                        "terminal",
                        result.as_ref(),
                        error.as_ref(),
                    )
                    .await
            };
            if let Err(error) = settled {
                log::error!("[agent-host] owned terminal evidence not committed: {error}");
                let failure = json!({"kind":"dispatch_uncertain","message":format!("Native terminal evidence was not committed: {error}")});
                if let Err(reason) = host
                    .store
                    .mark_unsettled_dispatch_uncertain(&request.request_key, &failure)
                    .await
                {
                    log::error!("[agent-host] owned unknown evidence not committed: {reason}");
                }
            }
        });
        Ok(dispatch)
    }

    pub(super) async fn require_owned_selection(
        &self,
        owner: &OwnedSessionRequest,
        record: &SessionRecord,
    ) -> Result<(), String> {
        if self.store.execution_policy_violation(&record.id).await? {
            return Err(
                "execution_violation: native execution violated the declared no-tool policy".into(),
            );
        }
        if record.harness != owner.provider_id
            || record.account_id.as_deref() != Some(owner.account_id.as_str())
            || !(ObservedSelection {
                model_id: record.model_id.clone(),
                reasoning_effort: record.reasoning_effort.clone(),
                fast_mode: record.fast_mode,
            })
            .matches(owner)
        {
            return Err(
                "selection_changed: requested benchmark selection was not acknowledged".into(),
            );
        }
        Ok(())
    }

    pub async fn execution_status(&self, key: &str) -> Result<Option<ExecutionDispatch>, String> {
        self.store.execution_dispatch(key).await
    }

    pub async fn close_task_owned_session(&self, session: &str, key: &str) -> Result<(), String> {
        if self.store.owned_session_purpose(session).await?.as_deref() != Some("task") {
            return Err(
                "validation: only application task sessions may use this close path".into(),
            );
        }
        if let Some(dispatch) = self.execution_status(key).await? {
            if dispatch.session_id != session {
                return Err("validation: dispatch belongs to another session".into());
            }
            self.cancel_owned_turn(key).await?;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
            loop {
                let state = self
                    .execution_status(key)
                    .await?
                    .ok_or("dispatch_uncertain: task receipt disappeared during close")?;
                if state.phase == "terminal" {
                    break;
                }
                if state.phase == "uncertain" || tokio::time::Instant::now() >= deadline {
                    return Err("dispatch_uncertain: task cancellation was not confirmed; inspect before closing".into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
        self.stop_owned_sandbox(session).await?;
        self.store.set_archived(session, true).await
    }

    pub async fn reopen_task_owned_session(&self, session: &str, key: &str) -> Result<(), String> {
        if self.store.owned_session_purpose(session).await?.as_deref() != Some("task") {
            return Err("validation: only an application task transcript can reopen here".into());
        }
        if self
            .execution_status(key)
            .await?
            .is_some_and(|row| row.session_id != session)
        {
            return Err("validation: task key belongs to another session".into());
        }
        // Reopening exposes the immutable transcript; it grants no new turn.
        self.store.set_archived(session, false).await
    }

    pub async fn read_owned_events(
        &self,
        id: &str,
        after: i64,
        limit: u32,
    ) -> Result<OwnedEventPage, String> {
        self.store.owned_events(id, after, limit).await
    }

    /// Store an owned session's log the way its replay reads it, once its
    /// runner has read every event (see `SessionStore::compact_events`).
    pub async fn compact_owned_events(
        &self,
        id: &str,
    ) -> Result<crate::services::agent_host::store::CompactionStats, String> {
        self.store.compact_events(id, 0).await
    }

    /// The benchmark sessions the host itself no longer needs (see
    /// `SessionStore::settled_benchmark_sessions`).
    pub async fn settled_benchmark_sessions(
        &self,
    ) -> Result<Vec<crate::services::agent_host::store::BenchmarkSessionEntry>, String> {
        self.store.settled_benchmark_sessions().await
    }

    /// Delete finished benchmark sessions: a session with a turn loading or
    /// running here is left, any other lets go of its bridge session the way
    /// a deleted chat does, and the store removes it with its records. New
    /// history reuses the space, which also counts toward the VACUUM of the
    /// next `flock-history compact`.
    pub async fn purge_benchmark_sessions(
        &self,
        ids: &[String],
    ) -> Result<crate::services::agent_host::store::PurgeStats, String> {
        let mut total = crate::services::agent_host::store::PurgeStats::default();
        for chunk in ids.chunks(32) {
            let mut idle = Vec::with_capacity(chunk.len());
            for id in chunk {
                let busy = self
                    .sessions
                    .lock()
                    .await
                    .get(id)
                    .is_some_and(|runtime| runtime.loading || runtime.run.is_some());
                if busy {
                    continue;
                }
                let attached = self.attached_route(id).await;
                self.sessions.lock().await.remove(id);
                self.attach_locks.lock().await.remove(id);
                if let Some((bridge, bridge_session_id)) = attached {
                    Self::close_in_background(bridge, bridge_session_id);
                }
                idle.push(id.clone());
            }
            let purged = self.store.delete_benchmark_sessions(&idle).await?;
            total.add(&purged);
            // A long backlog shares the database with live chats and turns.
            tokio::task::yield_now().await;
        }
        self.store.record_freed_history(total.bytes).await?;
        Ok(total)
    }

    pub async fn stop_owned_sandbox(&self, session: &str) -> Result<(), String> {
        if let Some((bridge, _)) = self.attached_route(session).await {
            if bridge.is_sandbox() {
                bridge.stop_sandbox().await?;
            }
        }
        if let Some((owner, _)) = self.store.execution_owner(session).await? {
            if owner.profile == ExecutionProfile::NativeTextV1 {
                crate::services::benchmark_sandbox::clean(&text_execution::attempt_id(
                    &owner.owner_id,
                ))
                .await
                .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    pub async fn cancel_owned_turn(&self, key: &str) -> Result<(), String> {
        let dispatch = self
            .store
            .execution_dispatch(key)
            .await?
            .ok_or("validation: unknown dispatch")?;
        if dispatch.phase == "terminal" {
            return Ok(());
        }
        self.store.request_execution_cancel(key).await?;
        if let Some((bridge, id)) = self.attached_route(&dispatch.session_id).await {
            bridge.notify("session/cancel", json!({"sessionId":id}));
            if bridge.is_sandbox() {
                bridge.stop_sandbox().await?;
            }
            Ok(())
        } else {
            Err("dispatch_uncertain: no live runtime can confirm cancellation".into())
        }
    }
}
