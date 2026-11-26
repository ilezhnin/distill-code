//! The native implementation of the backend port.
use super::*;

impl ExecutionBackend for NativeBackend {
    fn calibration_judge<'a>(
        &'a self,
        entry: &'a crate::services::benchmarks::judge_pool::Entry,
        calibration: &'a str,
    ) -> BoxFuture<'a, Result<Configuration>> {
        Box::pin(async move {
            let offered = self
                .offered_judges(
                    &format!("judge-calibration:{calibration}"),
                    &format!("judge calibration {calibration}"),
                    std::slice::from_ref(entry),
                    None,
                )
                .await?;
            let rows = crate::services::benchmarks::judge_pool::seat_rows(
                std::slice::from_ref(entry),
                offered.rows,
            );
            by_headroom(
                rows.into_iter()
                    .map(|(headroom, judge)| (headroom.map(|h| h.share), judge))
                    .collect(),
            )
            .into_iter()
            .next()
            .ok_or_else(|| {
                if let Some(error) = offered.deferred {
                    return error;
                }
                BenchmarkError::new(
                    "capability_missing",
                    format!(
                        "No enabled account with usage left offers {} at {} effort to judge",
                        entry.model_id,
                        entry.effort.as_deref().unwrap_or("its default")
                    ),
                )
            })
        })
    }
    fn calibrate_control<'a>(
        &'a self,
        store: &'a Store,
        version: &'a BenchmarkVersion,
        record: &'a crate::services::benchmarks::qualification::Record,
        index: usize,
        judge: &'a Configuration,
        directory: std::path::PathBuf,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            // Calibrated under the ordinary protocol: a task's frozen seats
            // are not this judge's.
            let mut version = version.clone();
            if let Some(environment) = version.manifest.environment.as_object_mut() {
                environment.remove("judgePanel");
            }
            let carrier = qualification_carrier(record, &version, index);
            self.judge_response(
                store,
                carrier,
                &version,
                JudgeStop::manual(),
                JudgeEvidence::Calibration {
                    judge: Box::new(judge.clone()),
                    directory,
                },
            )
            .await
        })
    }
    fn judge_control<'a>(
        &'a self,
        store: &'a Store,
        record: &'a mut crate::services::benchmarks::qualification::Record,
        version: &'a BenchmarkVersion,
        index: usize,
    ) -> BoxFuture<'a, Result<Evaluation>> {
        Box::pin(async move {
            // This carrier is persisted only through qualification evidence.
            let carrier = qualification_carrier(record, version, index);
            let stop = JudgeStop::qualification(&record.id);
            let judged = self
                .judge_response(
                    store,
                    carrier,
                    version,
                    stop,
                    JudgeEvidence::Qualification { record, index },
                )
                .await?;
            // Busy judge accounts, a renderer the sandbox has not admitted or
            // a judge's sandbox check being renewed stop the panel before it
            // renders or asks anyone: the control waits instead of failing.
            if let Some(busy) = judged.reason.as_deref().filter(|reason| {
                matches!(*reason, JUDGES_BUSY | RENDERER_BUSY)
                    || reason.starts_with(JUDGE_POLICY_RENEWAL)
            }) {
                return Err(BenchmarkError::new("resource_busy", busy));
            }
            let score = crate::services::benchmarks::analysis::score(&judged).ok_or_else(|| {
                BenchmarkError::new(
                    "rubric_calibration_incomplete",
                    judged
                        .reason
                        .clone()
                        .unwrap_or_else(|| "The frozen judge panel did not settle".into()),
                )
            })?;
            Ok(Evaluation {
                id: uuid::Uuid::new_v4().to_string(),
                evaluator_revision: version.manifest.evaluator.revision.clone(),
                verdict: "judged".into(),
                score: Some(score),
                reason: "Frozen control panel completed".into(),
                created_at: now(),
                provenance: "judge_calibration".into(),
                artifacts: Vec::new(),
                details: None,
                judge: None,
                usage: None,
            })
        })
    }
    fn validate_owned_task_context<'a>(
        &'a self,
        binding: &'a crate::services::benchmarks::task_execution::Binding,
        session: &'a crate::services::benchmarks::task_execution::Session,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            if binding.task.execution_profile == "protected_repository" {
                let bytes = sandbox::patch(
                    &repository_execution::attempt_id(&session.owned.owner_id),
                    1,
                )
                .await
                .map_err(|error| {
                    untouched_check_error(
                        error,
                        "The isolated native repository changed after setup",
                    )
                })?;
                if !bytes.is_empty() {
                    return Err(BenchmarkError::new(
                        "selection_changed",
                        "The native repository is no longer the acknowledged initial copy",
                    ));
                }
            } else {
                let host = self
                    .app
                    .state::<AgentHost>()
                    .get_or_start(&self.app)
                    .await
                    .map_err(host_error)?;
                let record = host
                    .session_record(&session.owned.session_id)
                    .await
                    .map_err(|error| host_error(error.to_string()))?;
                if record.cwd != "/workspace"
                    || !sandbox::patch(&text_execution::attempt_id(&session.owned.owner_id), 1)
                        .await
                        .map_err(|error| {
                            untouched_check_error(
                                error,
                                "The native text context changed after setup",
                            )
                        })?
                        .is_empty()
                {
                    return Err(BenchmarkError::new(
                        "selection_changed",
                        "The native text context changed after setup",
                    ));
                }
            }
            Ok(())
        })
    }
    fn reopen_owned_task<'a>(
        &'a self,
        binding: &'a crate::services::benchmarks::task_execution::Binding,
        session: &'a crate::services::benchmarks::task_execution::Session,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            host.reopen_task_owned_session(&session.owned.session_id, &binding.request.request_key)
                .await
                .map_err(host_error)
        })
    }
    fn owned_task_output<'a>(
        &'a self,
        binding: &'a crate::services::benchmarks::task_execution::Binding,
        session: &'a crate::services::benchmarks::task_execution::Session,
    ) -> BoxFuture<'a, Result<crate::services::benchmarks::task_execution::NativeOutput>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            read_owned_task_output(
                &host.store,
                &binding.request.request_key,
                &session.owned.session_id,
            )
            .await
        })
    }
    fn prepare_owned_task<'a>(
        &'a self,
        store: &'a Store,
        binding: &'a crate::services::benchmarks::task_execution::Binding,
        chosen: &'a Configuration,
    ) -> BoxFuture<'a, Result<crate::services::benchmarks::task_execution::Session>> {
        Box::pin(async move {
            self.readiness(chosen).await?;
            let account = chosen.account_id.as_deref().ok_or_else(|| {
                BenchmarkError::new(
                    "capability_missing",
                    "Choose a native account for this owned task",
                )
            })?;
            let rows = self
                .unattended_inventory(&chosen.provider_id, Some(account), false)
                .await?;
            if !rows.iter().any(|row| {
                crate::services::benchmarks::task_execution::inventory_acknowledges(row, chosen)
            }) {
                return Err(BenchmarkError::new(
                    "selection_changed",
                    "Native account, runtime or worker changed before owned setup",
                ));
            }
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            let owner = format!("task:{}", binding.id);
            let repository = binding.task.execution_profile == "protected_repository";
            let deadline = binding
                .deadline_at_ms()?
                .map(unsigned_deadline)
                .transpose()?;
            let cwd = if repository {
                let source = binding.request.repository.as_ref().ok_or_else(|| {
                    BenchmarkError::new("validation", "An explicit repository snapshot is required")
                })?;
                // A later step starts from its sealed predecessor's archive;
                // a first one from the published snapshot (`None`).
                let advanced = if let Some(context) = &binding.context_v2 {
                    let before = context.artifact_before.as_ref().ok_or_else(|| {
                        BenchmarkError::new(
                            "invalid_task_authority",
                            "Native repository artifact authority is absent",
                        )
                    })?;
                    let deadline = deadline.ok_or_else(|| {
                        BenchmarkError::new(
                            "invalid_task_authority",
                            "Native repository root deadline is absent",
                        )
                    })?;
                    let prepared = crate::services::benchmarks::repository::advance_until(
                        source,
                        &context.artifact_lineage,
                        context.artifact_access_all.ok_or_else(|| {
                            BenchmarkError::new(
                                "invalid_task_authority",
                                "Native repository access is absent",
                            )
                        })?,
                        binding.task.limits.max_artifact_bytes as usize,
                        deadline,
                    )
                    .await?;
                    if &prepared.artifact != before {
                        return Err(BenchmarkError::new(
                            "evidence_mismatch",
                            "Native repository setup differs from its frozen predecessor artifact",
                        ));
                    }
                    Some(prepared.archive)
                } else {
                    crate::services::benchmarks::repository::verify(source).await?;
                    None
                };
                let marker_dir = store.root.join("task-executions").join(&binding.id);
                tokio::fs::create_dir_all(&marker_dir).await?;
                let marker = marker_dir.join("copy-preparation.json");
                if host
                    .store
                    .owned_session_id(&owner)
                    .await
                    .map_err(host_error)?
                    .is_none()
                {
                    let copy_id = repository_execution::attempt_id(&owner);
                    // A previous setup without a native owner/dispatch cannot
                    // have submitted work. Clean only this isolated task ID,
                    // never a live owner's repository, then make a fresh copy.
                    if marker.is_file() {
                        sandbox::clean(&copy_id).await?;
                    }
                    tokio::fs::write(&marker,serde_json::to_vec(&json!({"bindingId":binding.id,"contextHash":binding.context_hash,"phase":"copying"}))?).await?;
                    match &advanced {
                        Some(archive) => match deadline {
                            Some(deadline) => {
                                sandbox::copy_until(&copy_id, archive, deadline).await
                            }
                            None => sandbox::copy(&copy_id, archive).await,
                        }
                        .map_err(|error| sandbox_setup_error(error, deadline))?,
                        None => copy_snapshot(&copy_id, source, deadline).await?,
                    }
                }
                "/workspace".into()
            } else {
                "/workspace".into()
            };
            // Inventory must not acquire another text lease after this task
            // has occupied a persistent bridge: concurrent tasks could hold
            // every light slot while each waits for an inventory process.
            let rows = self
                .unattended_inventory(&chosen.provider_id, Some(account), false)
                .await?;
            let mut owned = host
                .create_task_owned_session(
                    OwnedSessionRequest {
                        owner_id: owner,
                        provider_id: chosen.provider_id.clone(),
                        account_id: account.into(),
                        model_id: chosen.model_id.clone(),
                        reasoning_effort: chosen.effort.clone(),
                        fast_mode: chosen.fast_mode,
                        cwd,
                        title: format!(
                            "Owned task: {}",
                            binding.task.prompt.chars().take(60).collect::<String>()
                        ),
                        profile: if repository {
                            ExecutionProfile::ProtectedRepositoryV1
                        } else {
                            ExecutionProfile::NativeTextV1
                        },
                    },
                    binding.remaining_ms()?,
                )
                .await
                .map_err(host_error)?;
            acknowledge_lane(&chosen.provider_id, &chosen.model_id, &mut owned);
            let mut observed = chosen.clone();
            observed.model_id = owned.selection.model_id.clone().unwrap_or_default();
            observed.effort = owned.selection.reasoning_effort.clone();
            observed.fast_mode = owned.selection.fast_mode;
            let actual = rows
                .into_iter()
                .find(|row| {
                    row.configuration.model_id == observed.model_id
                        && row.configuration.execution_profile == chosen.execution_profile
                })
                .ok_or_else(|| {
                    BenchmarkError::new(
                        "selection_changed",
                        "Acknowledged worker disappeared from native inventory",
                    )
                })?;
            observed.inventory_revision = actual.configuration.inventory_revision;
            let record = host
                .session_record(&owned.session_id)
                .await
                .map_err(|error| host_error(error.to_string()))?;
            observed.account_id = record.account_id;
            observed.provider_id = record.harness;
            if observed != *chosen || !owned.substitutions.is_empty() {
                return Err(BenchmarkError::new(
                    "selection_changed",
                    "Provider did not acknowledge the exact owned task model and settings",
                ));
            }
            Ok(crate::services::benchmarks::task_execution::Session {
                owned,
                observed,
                context_hash: binding.context_hash.clone(),
            })
        })
    }
    fn recover_owned_task_preparation<'a>(
        &'a self,
        binding: &'a crate::services::benchmarks::task_execution::Binding,
    ) -> BoxFuture<'a, Result<crate::services::benchmarks::task_execution::NativePreparationLookup>>
    {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            host.lookup_owned_task_preparation(
                &format!("task:{}", binding.id),
                &binding.request.request_key,
            )
            .await
            .map_err(host_error)
        })
    }
    fn dispatch_owned_task<'a>(
        &'a self,
        _store: &'a Store,
        binding: &'a crate::services::benchmarks::task_execution::Binding,
        session: &'a crate::services::benchmarks::task_execution::Session,
        admission: tokio::sync::OwnedMutexGuard<()>,
    ) -> BoxFuture<'a, Result<ExecutionDispatch>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            let record = host
                .session_record(&session.owned.session_id)
                .await
                .map_err(|error| host_error(error.to_string()))?;
            if record.archived_at.is_some() {
                return Err(BenchmarkError::new(
                    "cancelled",
                    "Owned task was closed before dispatch",
                ));
            }
            if binding.task.execution_profile == "native_text"
                && (record.cwd != "/workspace"
                    || !sandbox::patch(&text_execution::attempt_id(&session.owned.owner_id), 1)
                        .await?
                        .is_empty())
            {
                return Err(BenchmarkError::new(
                    "selection_changed",
                    "Owned text workspace is no longer empty",
                ));
            }
            let rows = self
                .unattended_inventory(
                    &session.observed.provider_id,
                    session.observed.account_id.as_deref(),
                    false,
                )
                .await?;
            if !rows.iter().any(|row| {
                crate::services::benchmarks::task_execution::inventory_acknowledges(
                    row,
                    &session.observed,
                )
            }) {
                return Err(BenchmarkError::new(
                    "selection_changed",
                    "Native runtime changed at owned dispatch",
                ));
            }
            host.dispatch_task_owned_turn(
                OwnedTurnRequest {
                    session_id: session.owned.session_id.clone(),
                    request_key: binding.request.request_key.clone(),
                    prompt: public_task_prompt(&binding.task)?,
                    policy_hash: session.owned.policy_hash.clone(),
                    timeout_ms: binding.remaining_ms()?,
                    images: vec![],
                    // An application task is the operator's own work and,
                    // like a chat, may run on credits.
                    allow_credits: true,
                },
                crate::services::agent_host::executor_receipts::ExecutorLink {
                    decision_key: binding.request.request_key.clone(),
                    logical_run_id: binding.request.request_key.clone(),
                },
                admission,
                binding.task.limits.max_artifact_bytes,
            )
            .await
            .map_err(host_error)
        })
    }
    fn refuse_owned_task_dispatch<'a>(
        &'a self,
        binding: &'a crate::services::benchmarks::task_execution::Binding,
        session: &'a crate::services::benchmarks::task_execution::Session,
    ) -> BoxFuture<'a, Result<ExecutionDispatch>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            host.refuse_task_owned_turn(
                &session.owned.session_id,
                &binding.request.request_key,
                &format!("task:{}", binding.id),
                &session.owned.policy_hash,
            )
            .await
            .map_err(host_error)
        })
    }
    fn owned_task_status<'a>(
        &'a self,
        binding: &'a crate::services::benchmarks::task_execution::Binding,
        session: &'a crate::services::benchmarks::task_execution::Session,
    ) -> BoxFuture<'a, Result<Option<ExecutionDispatch>>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            let status = host
                .execution_status(&binding.request.request_key)
                .await
                .map_err(host_error)?;
            if status
                .as_ref()
                .is_some_and(|row| row.session_id != session.owned.session_id)
            {
                return Err(BenchmarkError::new(
                    "invalid_task_authority",
                    "Task key belongs to another native session",
                ));
            }
            Ok(status)
        })
    }
    fn cancel_owned_task<'a>(
        &'a self,
        binding: &'a crate::services::benchmarks::task_execution::Binding,
        session: &'a crate::services::benchmarks::task_execution::Session,
        close: bool,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            if close {
                host.close_task_owned_session(
                    &session.owned.session_id,
                    &binding.request.request_key,
                )
                .await
                .map_err(host_error)
            } else if host
                .execution_status(&binding.request.request_key)
                .await
                .map_err(host_error)?
                .is_some()
            {
                host.cancel_owned_turn(&binding.request.request_key)
                    .await
                    .map_err(host_error)
            } else {
                host.close_task_owned_session(
                    &session.owned.session_id,
                    &binding.request.request_key,
                )
                .await
                .map_err(host_error)
            }
        })
    }
    fn judge<'a>(
        &'a self,
        store: &'a Store,
        attempt: Attempt,
        version: &'a BenchmarkVersion,
        stop: JudgeStop,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            let id = attempt.id.clone();
            let evidence = if ordinary_judging::for_attempt(store, &attempt).await? {
                JudgeEvidence::OrdinaryAttempt
            } else {
                JudgeEvidence::Attempt
            };
            judge_watchdog::prepare(
                store,
                &id,
                self.judge_response(store, attempt, version, stop, evidence),
            )
            .await
        })
    }
    fn reconcile_judges<'a>(
        &'a self,
        _store: &'a Store,
        mut attempt: Attempt,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            for evaluation in attempt.evaluations.iter_mut().filter(|e| in_flight(e)) {
                let details = evaluation.details.clone().unwrap_or_default();
                let (Some(key), Some(session)) = (
                    details["requestKey"].as_str(),
                    details["sessionId"].as_str(),
                ) else {
                    settle_interrupted_judge(evaluation, None);
                    continue;
                };
                let status = host.execution_status(key).await.ok().flatten();
                let Some(status) = status.filter(|s| s.phase == "terminal") else {
                    let _ = host.cancel_owned_turn(key).await;
                    settle_interrupted_judge(evaluation, None);
                    continue;
                };
                let mut usage = TokenUsage::default();
                let mut reply = String::new();
                let mut cursor = 0i64;
                let complete = loop {
                    let Ok(page) = host.read_owned_events(session, cursor, 200).await else {
                        break false;
                    };
                    for event in page.events {
                        consume_event(&event.payload, &mut reply, &mut usage);
                    }
                    let advanced = page.cursor > cursor;
                    cursor = page.cursor;
                    if !page.has_more || !advanced {
                        break !page.has_more && cursor >= status.event_cursor;
                    }
                };
                settle_interrupted_judge(evaluation, complete.then_some(usage));
            }
            Ok(attempt)
        })
    }
    fn settled_sessions<'a>(
        &'a self,
    ) -> BoxFuture<'a, Result<Vec<crate::services::agent_host::store::BenchmarkSessionEntry>>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            host.settled_benchmark_sessions().await.map_err(host_error)
        })
    }
    fn purge_sessions<'a>(
        &'a self,
        sessions: &'a [String],
    ) -> BoxFuture<'a, Result<crate::services::agent_host::store::PurgeStats>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            host.purge_benchmark_sessions(sessions)
                .await
                .map_err(host_error)
        })
    }
    fn unsupported(&self, c: &Configuration, d: &BenchmarkDraft) -> Option<String> {
        if let Err(error) = crate::services::benchmarks::judge_panel::frozen(d, &[c]) {
            return Some(error.message);
        }
        if crate::services::benchmarks::repository::is_repository_case(d) {
            return profile_refusal(c)
                .or_else(|| {
                    (c.execution_profile != "protected_repository")
                        .then(|| "Choose the repository configuration for a repository case".into())
                })
                .or_else(|| crate::services::benchmarks::repository::permission_issue(d));
        }
        if let Some(reason) = native_refusal(c) {
            return Some(reason);
        }
        if c.execution_profile != "native_text" {
            return Some(
                "Choose the native text configuration for bounded artifact generation".into(),
            );
        }
        if d.execution_profile != "native_text"
            && !matches!(d.evaluator.kind.as_str(), "javascript" | "browser")
        {
            return Some(
                "General repository execution requires a verified filesystem boundary".into(),
            );
        }
        if matches!(d.evaluator.kind.as_str(), "javascript" | "browser")
            && !crate::services::benchmarks::worker::available()
        {
            return Some("The isolated artifact evaluator is unavailable".into());
        }
        if !d.permissions.tools.is_empty()
            || d.permissions.network
            || d.permissions.context != "clean"
        {
            return Some(
                "The text profile requires clean context, no native tools and no network tools"
                    .into(),
            );
        }
        None
    }
    fn readiness<'a>(&'a self, c: &'a Configuration) -> BoxFuture<'a, Result<()>> {
        self.sandbox_readiness(c, None)
    }
    fn renew_stale_policy_check<'a>(&'a self, provider: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let Some(provider) = NativeProvider::for_harness(provider) else {
                return Ok(());
            };
            crate::services::benchmark_policy_check::renew_if_stale(provider)
                .await
                .map_err(|error| {
                    let code = if error.contains("resource_busy:") {
                        "resource_busy"
                    } else {
                        "infrastructure_failure"
                    };
                    BenchmarkError::new(code, error)
                })
        })
    }
    fn paces_preparation(&self) -> bool {
        true
    }
    fn spent_until<'a>(
        &'a self,
        account: &'a str,
        model_id: &'a str,
    ) -> BoxFuture<'a, Option<i64>> {
        Box::pin(crate::services::provider_account_status::spent_until(
            &self.app,
            account,
            Some(model_id),
        ))
    }
    fn resource_admission<'a>(&'a self, _: &'a Configuration) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            sandbox::host_admission()
                .await
                .map_err(|error| host_error(error.to_string()))
        })
    }
    fn readiness_for_budget<'a>(
        &'a self,
        c: &'a Configuration,
        timeout_seconds: u32,
    ) -> BoxFuture<'a, Result<()>> {
        self.sandbox_readiness(c, Some(timeout_seconds))
    }
    fn activity<'a>(&'a self, c: &'a Configuration) -> BoxFuture<'a, Result<AccountActivity>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            host.account_activity(&c.provider_id, "*")
                .await
                .map_err(host_error)
        })
    }
    fn accounts<'a>(
        &'a self,
        provider: &'a str,
        credits: bool,
    ) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async move {
            let snapshot = crate::services::provider_accounts::snapshot(&self.app)
                .map_err(|error| BenchmarkError::new("infrastructure_failure", error))?;
            let default = snapshot.defaults.get(provider);
            let mut accounts = Vec::new();
            for account in snapshot
                .accounts
                .iter()
                .filter(|account| account.provider_id == provider && account.enabled)
            {
                // A signed-out account is no account to run on, and one
                // whose last status shows a spent limit has no room.
                if crate::services::provider_account_status::signed_in(&self.app, account).await
                    && !crate::services::provider_account_status::usage_spent(
                        &self.app,
                        &account.id,
                        credits,
                    )
                    .await
                {
                    accounts.push(account.id.clone());
                }
            }
            accounts.sort_by_key(|account| Some(account) != default);
            Ok(accounts)
        })
    }
    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        refresh: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(self.listed_inventory(provider, account, refresh, false))
    }
    fn unattended_inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        refresh: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(self.listed_inventory(provider, account, refresh, true))
    }
    fn execute<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
        version: BenchmarkVersion,
        timeout: u32,
        mut cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            let Admitted {
                run_request,
                host,
                account,
                provider,
                version,
                repository,
                budget,
                deadline,
                artifact_input,
                inventory,
                runtime_revision,
                credentials,
            } = self
                .admit(store, &mut attempt, version, timeout, &cancel)
                .await?;
            let timeout_seconds = effective_timeout_seconds(timeout, &version.manifest);
            // Until sign-in, runtime and account readiness succeed, nothing
            // of this try exists in Linux. Arming cleanup earlier starts an
            // independent bench-clean for every renewal refusal, so a queue
            // of untouched cells can exhaust the supervisor process budget.
            // Arm before the first workspace/session operation instead, so
            // partial setup, cancellation and paid turns still clean up.
            let mut cleanup = sandbox::Cleanup(Some(if repository {
                repository_execution::attempt_id(&turn_owner(&attempt))
            } else {
                text_execution::attempt_id(&turn_owner(&attempt))
            }));
            if let Some(id) = cleanup.0.as_deref() {
                // The sandbox's cgroup leaf names no attempt; this line maps it.
                log::info!(
                    "[benchmarks] sandbox job session-{id} = attempt {} ({})",
                    attempt.id,
                    attempt.configuration.execution_profile
                );
            }
            if let Some(id) = cleanup.0.clone().filter(|_| repository) {
                // Asked before the verify and the copy, each a preparation
                // job: a refused retry prepares nothing, and the check made
                // nothing to clean. The reservation when the session opens
                // still decides. Five minutes ahead stays valid for the
                // broker even with the guest clock a minute off.
                let ask_until = deadline
                    .unwrap_or(u64::MAX)
                    .min((now() as u64).saturating_add(300_000));
                if let Err(error) = sandbox::admits(
                    sandbox::ResourceClass::Repository,
                    &id,
                    ask_until,
                    sandbox::continues(&turn_owner(&attempt)),
                )
                .await
                {
                    cleanup.0 = None;
                    let error = sandbox_setup_error(error, deadline);
                    if error.code == "resource_busy" {
                        admission_window::refused(&store.root.display().to_string(), &attempt.id);
                    }
                    return Err(error);
                }
            }
            let cwd = prepare_workspace(
                cleanup.0.as_deref().filter(|_| repository),
                &version.manifest,
                artifact_input.as_ref(),
                deadline,
            )
            .await?;
            run_request.require_dispatch_admission(now())?;
            let session = host
                .create_owned_session(
                    OwnedSessionRequest {
                        owner_id: turn_owner(&attempt),
                        provider_id: attempt.configuration.provider_id.clone(),
                        account_id: account,
                        model_id: attempt.configuration.model_id.clone(),
                        reasoning_effort: attempt.configuration.effort.clone(),
                        fast_mode: attempt.configuration.fast_mode,
                        cwd,
                        title: format!(
                            "Benchmark: {} [{}]",
                            version.manifest.name,
                            attempt.repetition + 1
                        ),
                        profile: if repository {
                            ExecutionProfile::ProtectedRepositoryV1
                        } else {
                            ExecutionProfile::NativeTextV1
                        },
                    },
                    turn_timeout_ms(timeout_seconds, budget.as_ref())?,
                )
                .await
                .map_err(host_error);
            // The sandbox's answer paces the attempts prepared after this one
            // (admission_window).
            let scope = store.root.display().to_string();
            let session = match session {
                Ok(mut session) => {
                    admission_window::admitted(&scope, &attempt.id);
                    acknowledge_lane(
                        &attempt.configuration.provider_id,
                        &attempt.configuration.model_id,
                        &mut session,
                    );
                    session
                }
                Err(error) => {
                    if error.code == "resource_busy" {
                        admission_window::refused(&scope, &attempt.id);
                        // A refused text session left nothing: the router
                        // cleaned before it asked, or after the refusal.
                        if !repository {
                            cleanup.0 = None;
                        }
                    }
                    return Err(error);
                }
            };
            attempt.session_id = Some(session.session_id.clone());
            mark_phase(&mut attempt, "sessionOpened");
            let acknowledged_nothing =
                session.selection.model_id.is_none() && session.substitutions.is_empty();
            let mut observed = attempt.configuration.clone();
            observed.model_id = session.selection.model_id.unwrap_or_default();
            observed.effort = session.selection.reasoning_effort;
            observed.fast_mode = session.selection.fast_mode;
            observed.inventory_revision = Some(runtime_revision);
            let actual_session = host
                .session_record(&session.session_id)
                .await
                .map_err(|error| host_error(error.to_string()))?;
            observed.provider_id = actual_session.harness;
            observed.account_id = actual_session.account_id;
            attempt.observed = Some(observed.clone());
            // A session that acknowledged nothing and refused nothing is not
            // a substitution: its process ended before it named a model (the
            // bridge died at open, 2026-10-31). Read as "another model", the
            // try counted as a refusal three times and stopped the run on
            // the operator; it is a provider failure before any answer, and
            // goes back to the queue as one.
            if acknowledged_nothing {
                store.save_attempt(&attempt).await?;
                return Err(BenchmarkError::new(
                    SESSION_LOST,
                    SESSION_LOST_BEFORE_ANSWER,
                ));
            }
            if !session.substitutions.is_empty()
                || !matches_selection(&attempt.configuration, &observed)
            {
                store.save_attempt(&attempt).await?;
                return Err(BenchmarkError::new(
                    "selection_changed",
                    analysis::selection_refusal(
                        &attempt.configuration,
                        &observed,
                        &session.substitutions,
                    ),
                ));
            }
            attempt.phase = "dispatching".into();
            if *cancel.borrow()
                || !matches!(
                    store.run(&attempt.run_id).await?.state.as_str(),
                    "running" | "pausing"
                )
            {
                return Err(BenchmarkError::new(
                    "cancelled",
                    "Run stopped before prompt dispatch",
                ));
            }
            store.save_attempt(&attempt).await?;
            let key = dispatch_key(&attempt);
            if budget.is_none() {
                // Legacy repository runs start a fresh turn clock after setup.
                // Recheck here so archive/copy/session time cannot consume the
                // credential window reserved before preparation.
                require_unchanged_runtime(
                    &attempt.configuration,
                    repository,
                    timeout_seconds,
                    &inventory,
                    observed.inventory_revision.as_deref(),
                )
                .await?;
                // The session may already hold a private copy of this grant;
                // a newer shared refresh cannot extend that copy's lifetime.
                // Check after the final awaited probe so its own latency
                // cannot consume the original credential's cleanup margin.
                credentials.require(
                    provider.key(),
                    attempt
                        .configuration
                        .account_id
                        .as_deref()
                        .unwrap_or_default(),
                    now(),
                    timeout_seconds,
                )?;
            }
            let credit = self
                .credit_turn(&store.root, &attempt.configuration, true)
                .await?;
            let started = Instant::now();
            let request = OwnedTurnRequest {
                session_id: session.session_id.clone(),
                request_key: key.clone(),
                prompt: prompt_with_fixtures(&version.manifest)?,
                policy_hash: session.policy_hash,
                timeout_ms: turn_timeout_ms(timeout_seconds, budget.as_ref())?,
                images: Vec::new(),
                allow_credits: credit.allow,
            };
            run_request.require_dispatch_admission(now())?;
            let dispatch = match deadline {
                Some(deadline) => {
                    host.dispatch_owned_turn_with_deadline(request, deadline as i64)
                        .await
                }
                None => host.dispatch_owned_turn(request).await,
            }
            .map_err(host_error)?;
            attempt.host_run_id = Some(dispatch.run_id);
            mark_phase(&mut attempt, "dispatched");
            attempt.phase = "running".into();
            store.save_attempt(&attempt).await?;
            let mut capture = TurnCapture::new(version.manifest.limits.max_artifact_bytes);
            let terminal = wait_for_owned_turn(
                host.as_ref(),
                &mut attempt,
                &mut capture,
                &mut cancel,
                OwnedTurnWait {
                    key: &key,
                    session_id: &session.session_id,
                    started,
                    timeout: Duration::from_secs(u64::from(timeout_seconds)),
                    budget: budget.as_ref(),
                    repository,
                    cancellation_grace: Duration::from_secs(15),
                    terminal_drain_grace: Duration::from_secs(15),
                },
            )
            .await?;
            attempt.output = Some(std::mem::take(&mut capture.output));
            attempt.duration_ms = Some(started.elapsed().as_millis() as u64);
            attempt.native_execution_ms = Some(
                host.store
                    .execution_elapsed_ms(&key)
                    .await
                    .map_err(host_error)?,
            );
            attempt.finished_at = Some(now());
            attempt.phase = "collecting".into();
            self.seal_turn(
                &host,
                store,
                &mut attempt,
                &version.manifest,
                &session.session_id,
                repository,
                artifact_input.as_ref(),
                deadline,
                capture,
                terminal,
                &mut cleanup,
                credit,
                budget.as_ref().map(|lease| lease.root_id.as_str()),
            )
            .await?;
            Ok(attempt)
        })
    }
    fn recover<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
    ) -> BoxFuture<'a, Result<Option<Attempt>>> {
        Box::pin(async move {
            let mut cleanup = sandbox::Cleanup(Some(
                if attempt.configuration.execution_profile == "protected_repository" {
                    repository_execution::attempt_id(&turn_owner(&attempt))
                } else {
                    text_execution::attempt_id(&turn_owner(&attempt))
                },
            ));
            if let Some(id) = cleanup.0.as_deref() {
                sandbox::kill("session", id).await?;
            }
            if attempt.evidence_hash.is_some()
                && attempt
                    .outcome
                    .as_deref()
                    .is_some_and(|outcome| !matches!(outcome, "interrupted" | "dispatch_uncertain"))
            {
                clean_sealed(&mut cleanup, |id| async move { sandbox::clean(&id).await }).await;
                return Ok(Some(attempt));
            }
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            // Dispatches made before keys carried their start time used ":0".
            let mut found = None;
            for key in [
                dispatch_key(&attempt),
                format!("benchmark:{}:0", attempt.id),
            ] {
                found = host.execution_status(&key).await.map_err(host_error)?;
                if found.is_some() {
                    break;
                }
            }
            let Some(status) = found else {
                return Ok(None);
            };
            if status.phase != "terminal" {
                return Ok(None);
            }
            if attempt
                .session_id
                .as_ref()
                .is_some_and(|id| id != &status.session_id)
                || attempt
                    .host_run_id
                    .as_ref()
                    .is_some_and(|id| id != &status.run_id)
            {
                return Err(BenchmarkError::new(
                    "native_receipt_conflict",
                    "Recovered native dispatch belongs to another saved session or run",
                ));
            }
            attempt.session_id = Some(status.session_id.clone());
            attempt.host_run_id = Some(status.run_id.clone());
            attempt.native_execution_ms = host
                .store
                .execution_elapsed_ms(&status.request_key)
                .await
                .ok();
            attempt.event_cursor = 0;
            attempt.usage = TokenUsage::default();
            attempt.resolved_model = None;
            // The same caps as a turn the runner watched: the published one
            // on the answer, the evidence ceiling on the record.
            let version = crate::services::benchmarks::workflow::effective_version_for_attempt(
                store, &attempt,
            )
            .await?;
            let cap = version.manifest.limits.max_artifact_bytes;
            let budget = credited_budget(store, &version.manifest).await?;
            let deadline = budget
                .as_ref()
                .map(|budget| budget.deadline_at_ms())
                .transpose()?
                .map(unsigned_deadline)
                .transpose()?;
            let artifact_input =
                crate::services::benchmarks::artifact_context::input(&version.manifest)?;
            let mut capture = TurnCapture::new(cap);
            loop {
                let page = host
                    .read_owned_events(&status.session_id, attempt.event_cursor, 200)
                    .await
                    .map_err(host_error)?;
                for event in page.events {
                    capture.read(event.payload, &mut attempt)?;
                }
                attempt.event_cursor = page.cursor;
                capture.cap_answer();
                if !page.has_more && attempt.event_cursor >= status.event_cursor {
                    break;
                }
            }
            if let Some(result) = status.result.as_ref() {
                consume_terminal_result(result, &mut attempt);
            }
            let terminal = json!({"terminalDispatch":status});
            attempt.output = Some(std::mem::take(&mut capture.output));
            attempt.finished_at = Some(now());
            attempt.outcome = Some(
                status
                    .error
                    .as_ref()
                    .map(|error| terminal_outcome(error, &attempt.configuration.model_id))
                    .unwrap_or("completed")
                    .into(),
            );
            attempt.reason = status.error.map(|v| v.to_string());
            if capture.answer_capped
                && attempt.configuration.execution_profile != "protected_repository"
            {
                attempt.outcome = Some("budget_reached".into());
                attempt.reason = Some(RECOVERED_ANSWER_CAP_REASON.into());
            } else if attempt.outcome.as_deref() == Some("completed") {
                if let Some(reason) = status.result.as_ref().and_then(|result| {
                    runtime_output_cap_stop(&attempt.configuration.provider_id, result)
                }) {
                    attempt.outcome = Some("budget_reached".into());
                    attempt.reason = Some(reason);
                } else if unanswered_turn(&attempt, attempt.output.as_deref().unwrap_or_default()) {
                    attempt.outcome = Some("infrastructure_failure".into());
                    attempt.reason =
                        Some(crate::services::benchmarks::analysis::KIMI_UNANSWERED.into());
                }
            }
            if let Some(selection) = status
                .result
                .as_ref()
                .and_then(|v| v.get("observedSelection"))
            {
                if selection["modelId"].as_str() != Some(attempt.configuration.model_id.as_str())
                    || attempt
                        .configuration
                        .effort
                        .as_ref()
                        .is_some_and(|e| selection["reasoningEffort"].as_str() != Some(e.as_str()))
                    || !crate::services::benchmarks::analysis::fast_mode_acknowledged(
                        attempt.configuration.fast_mode,
                        selection["fastMode"].as_bool(),
                    )
                {
                    attempt.outcome = Some("selection_changed".into());
                    attempt.reason = Some(
                        "Recovered terminal selection differs from the requested configuration"
                            .into(),
                    );
                }
            } else if attempt.outcome.as_deref() == Some("completed") {
                attempt.outcome = Some("selection_changed".into());
                attempt.reason =
                    Some("Recovered terminal state lacks acknowledged selection".into());
            }
            if let Some(violation) = capture.violation.take() {
                settle_violation(&mut attempt, violation, capture.declined);
            }
            let mut artifact_error = None;
            let mut session_limit = None;
            if let Some(id) = cleanup.0.as_deref() {
                let collected = async {
                    host.stop_owned_sandbox(&status.session_id)
                        .await
                        .map_err(host_error)?;
                    if attempt.configuration.execution_profile == "protected_repository" {
                        finalize_repository(
                            &mut attempt,
                            id,
                            &version.manifest,
                            artifact_input.as_ref(),
                            deadline,
                        )
                        .await?;
                    }
                    Ok::<_, BenchmarkError>(())
                }
                .await;
                match collected {
                    Ok(()) => {}
                    Err(error) => {
                        repository_collection_failure(&mut attempt, &error);
                        artifact_error = Some(json!({"code":error.code,"message":error.message}));
                    }
                }
                session_limit = settle_session_limit(&mut attempt, id).await;
            }
            mark_auxiliary_profile(&mut attempt);
            let receipt = self
                .native_execution_receipt(&host, &attempt, &terminal)
                .await;
            let evidence = capture.evidence.close(terminal);
            // Every event of the turn is read: store the session's log the
            // way its replay reads it.
            if let Err(error) = host.compact_owned_events(&status.session_id).await {
                log::warn!(
                    "[benchmarks] session {} keeps its raw event log: {error}",
                    status.session_id
                );
            }
            let mut evidence = native_receipt::sealed_events(evidence, receipt);
            if let Some(error) = artifact_error {
                evidence["repositoryArtifactError"] = error;
            }
            if let Some(verdict) = session_limit {
                evidence["sessionLimit"] = verdict;
            }
            record_sandbox_admission(&mut attempt, &mut evidence, cleanup.0.as_deref());
            mark_phase(&mut attempt, "collected");
            // Persist the patch before removing its only working copy. Recovery
            // can repeat cleanup if the process exits between these operations.
            // No root is credited: recovery runs while its root is out of
            // flight, where the credit `Store::recover` opened for the stop
            // runs until the root's next flight, and a campaign root never
            // continues after a stop.
            keep_sealed(store, &mut attempt, &evidence, None).await?;
            clean_sealed(&mut cleanup, |id| async move { sandbox::clean(&id).await }).await;
            Ok(Some(attempt))
        })
    }
}

/// What a try is admitted with, before anything of it exists in the sandbox.
struct Admitted {
    run_request: RunRequest,
    host: Arc<crate::services::agent_host::router::Inner>,
    account: String,
    provider: NativeProvider,
    /// The version as this try collects it (see `collection_context`).
    version: BenchmarkVersion,
    repository: bool,
    budget: Option<crate::services::benchmarks::artifact_context::BudgetLease>,
    deadline: Option<u64>,
    artifact_input: Option<crate::services::benchmarks::artifact_context::Input>,
    inventory: Value,
    runtime_revision: String,
    credentials: CredentialWindow,
}

impl NativeBackend {
    /// `inventory` and `unattended_inventory`: a probe of an `unattended`
    /// one waits out a CLI whose model listing failed to start.
    async fn listed_inventory(
        &self,
        provider: &str,
        account: Option<&str>,
        refresh: bool,
        unattended: bool,
    ) -> Result<Vec<InventoryModel>> {
        let account = account
            .ok_or_else(|| BenchmarkError::new("capability_missing", account_refusal(provider)))?;
        let host = self
            .app
            .state::<AgentHost>()
            .get_or_start(&self.app)
            .await
            .map_err(host_error)?;
        let result = host
            .benchmark_inventory(provider, account, refresh, unattended)
            .await
            .map_err(host_error)?;
        // The probe candidates are checked against seats judges too.
        self.inventories.observe(provider, account, result.clone());
        self.inventory_rows(provider, account, &result).await
    }

    /// Admits a try: its run still goes on, its account and provider are
    /// known, its turn may be paid for, its budget and sign-in are in hand,
    /// and the runtime is the one its configuration was selected on.
    async fn admit(
        &self,
        store: &Store,
        attempt: &mut Attempt,
        version: BenchmarkVersion,
        timeout: u32,
        cancel: &watch::Receiver<bool>,
    ) -> Result<Admitted> {
        if *cancel.borrow()
            || !matches!(
                store.run(&attempt.run_id).await?.state.as_str(),
                "running" | "pausing"
            )
        {
            return Err(BenchmarkError::new(
                "cancelled",
                "Run stopped before preparation",
            ));
        }
        let run_request = store.run(&attempt.run_id).await?.request;
        run_request.require_dispatch_admission(now())?;
        if requires_browser_runtime(&version.manifest) {
            crate::services::benchmarks::worker::ready_for_attempt().await?;
        }
        let host = self
            .app
            .state::<AgentHost>()
            .get_or_start(&self.app)
            .await
            .map_err(host_error)?;
        let account = attempt.configuration.account_id.clone().ok_or_else(|| {
            BenchmarkError::new(
                "capability_missing",
                account_refusal(&attempt.configuration.provider_id),
            )
        })?;
        let provider =
            NativeProvider::for_harness(&attempt.configuration.provider_id).ok_or_else(|| {
                BenchmarkError::new(
                    "capability_missing",
                    "This provider has no verified native no-tool execution profile",
                )
            })?;
        // A test starts whatever else its account is doing, as a judge
        // does: its turn is a session of its own in the sandbox, and the
        // chats beside it change neither its answer nor its seat. What
        // the provider lets the account fly at once is the pace's to find.
        //
        // A turn whose plan usage is spent waits here, before any setup,
        // unless it may run on credits.
        self.credit_turn(&store.root, &attempt.configuration, false)
            .await?;
        let version = collection_context::prepare(store, attempt, version, timeout).await?;
        let repository =
            crate::services::benchmarks::repository::is_repository_case(&version.manifest);
        let budget = credited_budget(store, &version.manifest).await?;
        let deadline = budget
            .as_ref()
            .map(|budget| budget.deadline_at_ms())
            .transpose()?
            .map(unsigned_deadline)
            .transpose()?;
        let artifact_input =
            crate::services::benchmarks::artifact_context::input(&version.manifest)?;
        if artifact_input.is_some() && (!repository || deadline.is_none()) {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Cumulative repository collection requires a native root lease",
            ));
        }
        // A later step of a workflow already running finishes on the grant
        // its workflow was admitted with; only new work waits for a
        // renewal that drains the account.
        let continues = version
            .manifest
            .entry_state
            .as_ref()
            .is_some_and(|entry| entry.parent_step_id.is_some());
        let ((inventory, runtime_revision, status), grant) = with_app_sign_in(
            &host,
            &attempt.configuration,
            Some(timeout),
            if continues {
                SignInAsker::Running
            } else {
                SignInAsker::Test
            },
            || {
                self.admitted_runtime(
                    &host,
                    &attempt.run_id,
                    &attempt.configuration,
                    &account,
                    timeout,
                    repository,
                )
            },
        )
        .await?;
        // The account's sign-in admits tests again: its queued ones need not
        // ask one at a time any longer.
        sign_in_admitted(attempt);
        let credentials = CredentialWindow::new(grant, status);
        // The pin guards the account the run was planned on. A test the
        // run moved to another account (its usage limit ran out) runs on
        // that account's runtime, which lists that account's models, and
        // records it below.
        let request = store.run(&attempt.run_id).await?.request;
        // Research workflows have a synthetic root column. It must never
        // masquerade as an account move and waive the selected runtime pin.
        let moved = request.workflow_policy.is_none()
            && !request
                .configurations
                .iter()
                .any(|c| c.account_id == attempt.configuration.account_id);
        if !moved
            && attempt
                .configuration
                .inventory_revision
                .as_ref()
                .is_some_and(|revision| revision != &runtime_revision)
        {
            return Err(BenchmarkError::new("selection_changed","Installed runtime or model capabilities changed since configuration selection; refresh inventory"));
        }
        Ok(Admitted {
            run_request,
            host,
            account,
            provider,
            version,
            repository,
            budget,
            deadline,
            artifact_input,
            inventory,
            runtime_revision,
            credentials,
        })
    }

    /// Collects and seals a finished turn: the sandbox stops, a repository
    /// case's artifact is taken out, the events and the native receipt
    /// become the attempt's evidence, and the sandbox job is cleaned. `root`
    /// is the root its native lease names, credited for a store that
    /// refuses the seal (see `keep_sealed`).
    #[allow(clippy::too_many_arguments)]
    async fn seal_turn(
        &self,
        host: &Arc<crate::services::agent_host::router::Inner>,
        store: &Store,
        attempt: &mut Attempt,
        draft: &BenchmarkDraft,
        session_id: &str,
        repository: bool,
        artifact_input: Option<&crate::services::benchmarks::artifact_context::Input>,
        deadline: Option<u64>,
        capture: TurnCapture,
        terminal: Value,
        cleanup: &mut sandbox::Cleanup,
        mut credit: CreditTurn,
        root: Option<&str>,
    ) -> Result<()> {
        let mut artifact_error = None;
        let mut session_limit = None;
        if let Some(id) = cleanup.0.as_deref() {
            let collected = async {
                host.stop_owned_sandbox(session_id)
                    .await
                    .map_err(host_error)?;
                if repository {
                    finalize_repository(attempt, id, draft, artifact_input, deadline).await?;
                }
                Ok::<_, BenchmarkError>(())
            }
            .await;
            if let Err(error) = collected {
                repository_collection_failure(attempt, &error);
                artifact_error = Some(json!({"code":error.code,"message":error.message}));
            }
            session_limit = settle_session_limit(attempt, id).await;
        }
        mark_auxiliary_profile(attempt);
        let receipt = self
            .native_execution_receipt(host, attempt, &terminal)
            .await;
        let evidence = capture.evidence.close(terminal);
        // Every event of the turn is read: store the session's log the
        // way its replay reads it.
        if let Err(error) = host.compact_owned_events(session_id).await {
            log::warn!("[benchmarks] session {session_id} keeps its raw event log: {error}");
        }
        let mut evidence = native_receipt::sealed_events(evidence, receipt);
        if let Some(error) = artifact_error {
            evidence["repositoryArtifactError"] = error;
        }
        if let Some(verdict) = session_limit {
            evidence["sessionLimit"] = verdict;
        }
        self.record_credit_use(&store.root, attempt, &mut evidence, &mut credit)
            .await;
        drop(credit);
        record_sandbox_admission(attempt, &mut evidence, cleanup.0.as_deref());
        mark_phase(attempt, "collected");
        keep_sealed(store, attempt, &evidence, root).await?;
        clean_sealed(cleanup, |id| async move { sandbox::clean(&id).await }).await;
        Ok(())
    }
}

/// Puts a repository case's working copy into its sandbox job `id`: the
/// snapshot as published, or the predecessor its artifact input names.
/// Returns where the session starts. A text case has no job to fill.
async fn prepare_workspace(
    id: Option<&str>,
    draft: &BenchmarkDraft,
    artifact_input: Option<&crate::services::benchmarks::artifact_context::Input>,
    deadline: Option<u64>,
) -> Result<String> {
    let Some(id) = id else {
        return Ok("/workspace".to_owned());
    };
    let snapshot = crate::services::benchmarks::repository::snapshot(draft)?;
    if let Some(input) = artifact_input {
        let prepared = crate::services::benchmarks::repository::advance_until(
            &snapshot,
            &input.lineage,
            input.access_all,
            draft.limits.max_artifact_bytes as usize,
            deadline.expect("validated artifact deadline"),
        )
        .await?;
        if prepared.artifact != input.before {
            return Err(BenchmarkError::new(
                "evidence_mismatch",
                "Collection predecessor differs from its native artifact input",
            ));
        }
        match deadline {
            Some(deadline) => sandbox::copy_until(id, &prepared.archive, deadline).await,
            None => sandbox::copy(id, &prepared.archive).await,
        }
        .map_err(|error| sandbox_setup_error(error, deadline))?;
    } else {
        match deadline {
            Some(deadline) => {
                crate::services::benchmarks::repository::verify_until(&snapshot, deadline).await?
            }
            None => crate::services::benchmarks::repository::verify(&snapshot).await?,
        }
        copy_snapshot(id, &snapshot, deadline).await?;
    }
    Ok("/workspace".to_owned())
}

/// Refuses a turn whose sandbox runtime is no longer the one its session
/// was opened on (`observed_revision`).
async fn require_unchanged_runtime(
    configuration: &Configuration,
    repository: bool,
    timeout_seconds: u32,
    inventory: &Value,
    observed_revision: Option<&str>,
) -> Result<()> {
    let revision = if repository {
        let runtime = repository_runtime_for_budget(configuration, Some(timeout_seconds)).await?;
        repository_inventory_revision(&runtime, inventory, &configuration.model_id)
    } else {
        let (runtime, _) = text_runtime_snapshot(configuration, Some(timeout_seconds)).await?;
        text_inventory_revision(&runtime, inventory, &configuration.model_id)
    };
    if observed_revision != Some(revision.as_str()) {
        return Err(BenchmarkError::new(
            "selection_changed",
            "Sandbox runtime changed during preparation",
        ));
    }
    Ok(())
}
