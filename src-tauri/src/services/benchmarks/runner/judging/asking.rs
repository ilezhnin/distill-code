//! One judge call: admission, the session, the turn.
use super::*;

/// What a judge's turn left: its reply and spend, and why it gave no vote
/// where it gave none.
struct JudgeTurn {
    started: Instant,
    reply: String,
    usage: TokenUsage,
    /// Why the turn's end is unknown, so its usage is incomplete.
    failure: Option<String>,
    /// Why a turn that ended is no vote.
    turn_failure: Option<String>,
    provider_error: Option<Value>,
}

/// One judge call as it ended, before its reply is read.
struct JudgeCall {
    /// The id its placeholder was saved under.
    id: String,
    session_id: String,
    key: String,
    runtime_revision: String,
    started: Instant,
    usage_complete: bool,
    provider_error: Option<Value>,
    reply: String,
    usage: TokenUsage,
    /// Why the call is no vote, where that is known before its reply is
    /// read.
    failure: Option<String>,
}

impl NativeBackend {
    /// One judge's evaluation. A placeholder is saved before the turn is sent,
    /// so a restart still finds the session and its spend; the result reuses
    /// the placeholder's id.
    #[allow(clippy::too_many_arguments)]
    pub(in super::super) async fn ask_judge(
        &self,
        store: &Store,
        attempt: &mut Attempt,
        version: &BenchmarkVersion,
        judge: &Configuration,
        batch: &str,
        index: usize,
        prompt: &str,
        image: Option<&OwnedTurnImage>,
        response: Option<&str>,
        criteria: &[RubricCriterion],
        stop: &JudgeStop,
        evidence: &mut JudgeEvidence<'_>,
    ) -> Result<Evaluation> {
        let mut retrying = false;
        loop {
            if stop.halted(store).await? {
                return Err(BenchmarkError::new(ACCOUNT_BUSY, JUDGING_STOPPED));
            }
            let _retry_preparing = if retrying {
                Some(prepare_judge(
                    &store.root.display().to_string(),
                    &format!("judge:{}", attempt.id),
                )?)
            } else {
                None
            };
            let mut trace = diagnostics::JudgeTrace::new(batch, index);
            let result = self
                .ask_judge_inner(
                    store, attempt, version, judge, batch, index, prompt, image, response,
                    criteria, stop, evidence, &mut trace,
                )
                .await;
            let result = match result {
                Err(error) => Err(diagnostics::record(
                    store,
                    attempt,
                    trace.stage,
                    error,
                    Some(judge),
                    trace.context,
                )
                .await),
                Ok(mut evaluation) if evaluation.provenance == "judge_failure" => {
                    let error = diagnostics::record(
                        store,
                        attempt,
                        trace.stage,
                        BenchmarkError::new("judge_abstained", &evaluation.reason),
                        Some(judge),
                        trace.context,
                    )
                    .await;
                    if error
                        .details
                        .as_ref()
                        .is_some_and(|d| d["diagnosticPersistenceFailed"] == true)
                    {
                        return Err(error);
                    }
                    evaluation.reason = error.message;
                    Ok(evaluation)
                }
                result => result,
            };
            let retry = result
                .as_ref()
                .is_ok_and(|evaluation| retry_unpaid_judge_selection(attempt, evaluation));
            if !retry {
                return result;
            }
            let evaluation = result?;
            insert_judge_evaluation(attempt, batch, evaluation);
            evidence.save(store, attempt).await?;
            if stop.halted(store).await? {
                return Err(BenchmarkError::new(ACCOUNT_BUSY, JUDGING_STOPPED));
            }
            // Let the refused session's cleanup finish before opening a fresh
            // one. The next pass still enforces account, runtime and resource gates.
            tokio::time::sleep(Duration::from_secs(2)).await;
            retrying = true;
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn ask_judge_inner(
        &self,
        store: &Store,
        attempt: &mut Attempt,
        version: &BenchmarkVersion,
        judge: &Configuration,
        batch: &str,
        index: usize,
        prompt: &str,
        image: Option<&OwnedTurnImage>,
        response: Option<&str>,
        criteria: &[RubricCriterion],
        stop: &JudgeStop,
        evidence: &mut JudgeEvidence<'_>,
        trace: &mut diagnostics::JudgeTrace,
    ) -> Result<Evaluation> {
        let host = self
            .app
            .state::<AgentHost>()
            .get_or_start(&self.app)
            .await
            .map_err(host_error)?;
        let Some(account) = judge.account_id.clone() else {
            return Ok(judge_abstention(
                version,
                judge,
                batch,
                "Judge has no managed account".into(),
            ));
        };
        let frozen = !matches!(evidence, JudgeEvidence::OrdinaryAttempt)
            && version.manifest.environment.get("judgePanel").is_some();
        if let Some(refused) = self
            .seat_refusal(
                &host, store, attempt, version, judge, &account, batch, frozen,
            )
            .await?
        {
            return Ok(refused);
        }
        let timeout = Duration::from_secs(u64::from(JUDGE_TIMEOUT_SECONDS));
        let ((runtime_revision, status), grant) =
            with_app_sign_in(&host, judge, Some(JUDGE_TIMEOUT_SECONDS), true, || {
                text_runtime_snapshot(judge, Some(JUDGE_TIMEOUT_SECONDS))
            })
            .await?;
        let credentials = CredentialWindow::new(grant, status);
        let index = judge_call_index(attempt, batch, index, judge);
        let judge_owner = format!("{}:judge:{batch}:{index}", attempt.id);
        let job = text_execution::attempt_id(&judge_owner);
        trace.stage = "judge_session";
        trace.context["judgeIndex"] = json!(index);
        trace.context["jobId"] = json!(format!("session-{job}"));
        // The sandbox's cgroup leaf names no judge; this line maps it.
        log::info!(
            "[benchmarks] sandbox job session-{job} = judge {index} ({}) of attempt {}",
            judge.model_id,
            attempt.id
        );
        let _sandbox_cleanup = sandbox::Cleanup(Some(job));
        // A judge grades an answer a provider was already paid for: the
        // sandbox admits its session ahead of new attempts, without the room
        // a new text attempt leaves for one more repository attempt, and a
        // refusal keeps memory from new attempts until the judge fits.
        let continuing = sandbox::Continuing::new(judge_owner.clone());
        let mut session = host
            .create_owned_session(
                OwnedSessionRequest {
                    owner_id: judge_owner,
                    provider_id: judge.provider_id.clone(),
                    account_id: account.clone(),
                    model_id: judge.model_id.clone(),
                    reasoning_effort: judge.effort.clone(),
                    fast_mode: judge.fast_mode,
                    cwd: "/workspace".into(),
                    title: format!("Benchmark judge: {}", version.manifest.name),
                    profile: ExecutionProfile::NativeTextV1,
                },
                timeout.as_millis() as u64,
            )
            .await
            .map_err(host_error)?;
        drop(continuing);
        acknowledge_lane(&judge.provider_id, &judge.model_id, &mut session);
        trace.context["sessionId"] = json!(session.session_id);
        admission_window::admitted(
            &store.root.display().to_string(),
            &format!("judge:{}", attempt.id),
        );
        let mut acknowledged = judge.clone();
        acknowledged.model_id = session.selection.model_id.clone().unwrap_or_default();
        acknowledged.effort = session.selection.reasoning_effort.clone();
        acknowledged.fast_mode = session.selection.fast_mode;
        if !session.substitutions.is_empty()
            || !matches_selection(judge, &acknowledged)
            || (frozen && judge.effort != acknowledged.effort)
        {
            let mut abstention = judge_abstention(
                version,
                judge,
                batch,
                format!(
                    "Judge selection was not acknowledged: requested {} ({:?}, fast {:?}), received {} ({:?}, fast {:?}); no scoring request was sent",
                    judge.model_id, judge.effort, judge.fast_mode,
                    acknowledged.model_id, acknowledged.effort, acknowledged.fast_mode,
                ),
            );
            abstention.details = Some(json!({"judgeBatchId": batch,
                "sessionId": session.session_id, "usageComplete": true,
                "inFlight": false, "dispatched": false, "selectionNotAcknowledged": true}));
            return Ok(abstention);
        }
        let key = format!("benchmark:{}:judge:{batch}:{index}", attempt.id);
        trace.context["requestKey"] = json!(key);
        credentials.require(
            NativeProvider::for_harness(&judge.provider_id)
                .expect("validated judge")
                .key(),
            judge.account_id.as_deref().unwrap_or_default(),
            now(),
            JUDGE_TIMEOUT_SECONDS,
        )?;
        let mut placeholder =
            judge_abstention(version, judge, batch, "Judge turn in flight".into());
        placeholder.details = Some(
            json!({"judgeBatchId": batch, "sessionId": session.session_id,
            "requestKey": key, "usageComplete": false, "inFlight": true}),
        );
        let placeholder_id = placeholder.id.clone();
        let placeholder_position = insert_judge_evaluation(attempt, batch, placeholder);
        if let Err(error) = evidence.save(store, attempt).await {
            attempt.evaluations.remove(placeholder_position);
            return Err(error);
        }
        if stop.qualification_id.is_some() && stop.turn_cancelled(store).await? {
            let mut stopped = judge_abstention(
                version,
                judge,
                batch,
                "Calibration stopped before dispatch".into(),
            );
            stopped.id = placeholder_id;
            stopped.details = Some(json!({"judgeBatchId":batch,"sessionId":session.session_id,
                "requestKey":key,"inFlight":false,"usageComplete":true,"dispatched":false}));
            return Ok(stopped);
        }
        if let Some(run_id) = &stop.run_id {
            store
                .run(run_id)
                .await?
                .request
                .require_dispatch_admission(now())?;
        }
        let turn = self
            .judge_turn(
                &host,
                store,
                &attempt.run_id,
                judge,
                &account,
                frozen,
                &session,
                &key,
                prompt,
                image,
                stop,
                trace,
                timeout,
            )
            .await;
        let JudgeTurn {
            started,
            reply,
            usage,
            mut failure,
            mut turn_failure,
            provider_error,
        } = turn;
        let usage_complete = failure.is_none();
        trace.context["usageComplete"] = json!(usage_complete);
        trace.context["inFlight"] = json!(!usage_complete);
        trace.context["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
        // Save the original turn failure before cancellation or cleanup awaits.
        // A blocked cleanup must not hide why this turn stopped progressing.
        if let Some(reason) = failure.as_ref().or(turn_failure.as_ref()) {
            let recorded = diagnostics::record(
                store,
                attempt,
                trace.stage,
                BenchmarkError::new("judge_execution_failed", reason),
                Some(judge),
                trace.context.clone(),
            )
            .await;
            if failure.is_some() {
                failure = Some(recorded.message);
            } else {
                turn_failure = Some(recorded.message);
            }
        }
        if !usage_complete {
            let _ = host.cancel_owned_turn(&key).await;
        }
        let mut cleanup_failure = host.stop_owned_sandbox(&session.session_id).await.err();
        if let Some(reason) = cleanup_failure.as_ref() {
            let recorded = diagnostics::record(
                store,
                attempt,
                "judge_cleanup",
                BenchmarkError::new("judge_cleanup_failed", reason),
                Some(judge),
                trace.context.clone(),
            )
            .await;
            cleanup_failure = Some(recorded.message);
        }
        let failure = failure.or(turn_failure).or(cleanup_failure);
        if failure.is_none() {
            trace.stage = "judge_parse";
        }
        let call = JudgeCall {
            id: placeholder_id,
            session_id: session.session_id,
            key,
            runtime_revision,
            started,
            usage_complete,
            provider_error,
            reply,
            usage,
            failure,
        };
        Ok(judge_evaluation(
            store,
            attempt,
            version,
            judge,
            batch,
            evidence,
            &trace.context,
            response,
            criteria,
            call,
        )
        .await)
    }

    /// Why `judge` does not take its seat now, where it does not: an
    /// abstention for a provider that never judges, an error for a frozen
    /// judge that is no longer eligible or an account that waits for quota.
    #[allow(clippy::too_many_arguments)]
    async fn seat_refusal(
        &self,
        host: &Arc<crate::services::agent_host::router::Inner>,
        store: &Store,
        attempt: &Attempt,
        version: &BenchmarkVersion,
        judge: &Configuration,
        account: &str,
        batch: &str,
        frozen: bool,
    ) -> Result<Option<Evaluation>> {
        // A judge reads the brief, the rubric and the response, so a provider
        // that may train on submitted data never judges, frozen seats too.
        if let Some(reason) = crate::services::benchmarks::data_use::DataUse::load(&store.root)
            .await
            .judge_refusal(&judge.provider_id)
        {
            return Ok(Some(judge_abstention(version, judge, batch, reason)));
        }
        if frozen {
            let contributing =
                crate::services::benchmarks::workflow::judge_candidates(store, attempt).await?;
            let candidates: Vec<_> = contributing.iter().collect();
            let panel =
                crate::services::benchmarks::judge_panel::frozen(&version.manifest, &candidates)?
                    .ok_or_else(|| {
                    BenchmarkError::new("invalid_judge_panel", "Frozen panel is absent")
                })?;
            let snapshot =
                crate::services::provider_accounts::snapshot(&self.app).map_err(host_error)?;
            let enabled = snapshot.accounts.iter().any(|row| {
                row.id == account && row.provider_id == judge.provider_id && row.enabled
            });
            if !panel.contains(judge) || !enabled || native_refusal(judge).is_some() {
                return Err(BenchmarkError::new(
                    "selection_changed",
                    "Frozen judge is no longer eligible",
                ));
            }
        }
        // An opened panel keeps its exact seats and any paid votes. Quota
        // discovered before this seat starts is a wait, not an abstention.
        if let Some(until) = exhausted_until(&attempt.run_id, account) {
            return Err(judge_quota_wait(Some(until)));
        }
        if crate::services::provider_account_status::usage_spent(&self.app, account, false).await {
            return Err(judge_quota_wait(
                crate::services::provider_account_status::spent_until(
                    &self.app,
                    account,
                    Some(&judge.model_id),
                )
                .await,
            ));
        }
        // A judge turn flies on its account too, so a stretch of judging alone
        // still counts as the account flying (see `trusted_headroom`).
        account_pace::record_flight(
            &pace_key(store, &format!("{}\u{1f}{}", judge.provider_id, account)),
            now(),
        );
        if frozen {
            // From the account's newest listing, as for ordinary seats.
            let listing = (
                host,
                attempt.run_id.as_str(),
                judge.provider_id.as_str(),
                account,
            );
            let diagnostic_target = Some((store, attempt));
            let (offered, _) =
                with_app_sign_in(host, judge, Some(JUDGE_TIMEOUT_SECONDS), true, || {
                    let (host, run, provider, account) = listing;
                    async move {
                        let listed = self
                            .judge_listing(
                                host,
                                run,
                                "frozen judge",
                                provider,
                                account,
                                diagnostic_target,
                            )
                            .await?;
                        self.inventory_rows(provider, account, &listed).await
                    }
                })
                .await?;
            if !offered
                .iter()
                .any(|row| crate::services::benchmarks::judge_panel::offered(judge, row))
            {
                return Err(BenchmarkError::new("selection_changed", "Frozen judge settings, billing or runtime changed; no replacement was selected"));
            }
        }
        Ok(None)
    }

    /// Sends the judge its prompt and reads the turn to its end, or to the
    /// failure that leaves its end unknown.
    #[allow(clippy::too_many_arguments)]
    async fn judge_turn(
        &self,
        host: &Arc<crate::services::agent_host::router::Inner>,
        store: &Store,
        run_id: &str,
        judge: &Configuration,
        account: &str,
        frozen: bool,
        session: &OwnedSession,
        key: &str,
        prompt: &str,
        image: Option<&OwnedTurnImage>,
        stop: &JudgeStop,
        trace: &mut diagnostics::JudgeTrace,
        timeout: Duration,
    ) -> JudgeTurn {
        let started = Instant::now();
        let deadline = tokio::time::Instant::now() + timeout + Duration::from_secs(15);
        trace.stage = "judge_dispatch";
        let dispatch = judge_watchdog::until(
            deadline,
            host.dispatch_owned_turn(OwnedTurnRequest {
                session_id: session.session_id.clone(),
                request_key: key.to_owned(),
                prompt: prompt.to_string(),
                policy_hash: session.policy_hash.clone(),
                timeout_ms: timeout.as_millis() as u64,
                images: image.cloned().into_iter().collect(),
                allow_credits: false,
            }),
        )
        .await;
        // A failed dispatch may still have been accepted by the provider.
        // Keep that state unknown instead of claiming no request was sent.
        trace.context["dispatched"] = if dispatch.is_ok() {
            json!(true)
        } else {
            Value::Null
        };
        let mut cursor = 0i64;
        let mut reply = String::new();
        let mut usage = TokenUsage::default();
        // A judge's reply is read as a candidate's answer is: what a lost
        // connection broke stays out of the score sheet.
        let mut restarts = reconnect::Restarts::for_turn(&judge.provider_id, "native_text");
        let mut failure = dispatch.err();
        let mut turn_failure = None;
        let mut provider_error = None;
        while failure.is_none() {
            trace.stage = "judge_status";
            match stop.turn_cancelled(store).await {
                Ok(true) => {
                    failure = Some("Judging cancelled".into());
                    break;
                }
                Err(error) => {
                    failure = Some(error.message);
                    break;
                }
                Ok(false) => {}
            }
            if started.elapsed() > timeout + Duration::from_secs(15) {
                failure = Some("Judge exceeded its time budget".to_string());
                break;
            }
            trace.stage = "judge_events";
            let page = match judge_watchdog::until(
                deadline,
                host.read_owned_events(&session.session_id, cursor, 200),
            )
            .await
            {
                Ok(page) => page,
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            };
            for event in page.events {
                let answered = reply.len();
                consume_event(&event.payload, &mut reply, &mut usage);
                restarts.settle(&event.payload, &mut reply, answered);
            }
            cursor = page.cursor;
            trace.stage = "judge_status";
            let status = match judge_watchdog::until(deadline, host.execution_status(key)).await {
                Ok(status) => status,
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            };
            match status {
                Some(status)
                    if status.phase == "terminal"
                        && !page.has_more
                        && cursor >= status.event_cursor =>
                {
                    // A flagged or substituted turn abstains; its spend still counts.
                    turn_failure = judge_turn_failure(judge, &status);
                    provider_error = status.error.clone();
                    if let Some(error) = status.error.as_ref() {
                        // A limit that names no reset holds the account until
                        // the one its usage read shows.
                        let known = if judge_quota_stop(error)
                            && quota_reset(&error.to_string()).is_none()
                        {
                            ExecutionBackend::spent_until(self, account, &judge.model_id).await
                        } else {
                            None
                        };
                        exhaust_judge_on_quota(run_id, account, error, known);
                    }
                    if frozen
                        && status.result.as_ref().and_then(|result| {
                            result
                                .pointer("/observedSelection/reasoningEffort")
                                .and_then(Value::as_str)
                        }) != judge.effort.as_deref()
                    {
                        turn_failure = Some("Frozen judge effort changed during the turn".into());
                    }
                    break;
                }
                None => {
                    failure = Some("Judge execution status is unavailable".into());
                    break;
                }
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        JudgeTurn {
            started,
            reply,
            usage,
            failure,
            turn_failure,
            provider_error,
        }
    }
}

/// The evaluation a judge call amounts to: its score sheet where the reply
/// holds a valid one, else an abstention that says why.
#[allow(clippy::too_many_arguments)]
async fn judge_evaluation(
    store: &Store,
    attempt: &Attempt,
    version: &BenchmarkVersion,
    judge: &Configuration,
    batch: &str,
    evidence: &JudgeEvidence<'_>,
    context: &Value,
    response: Option<&str>,
    criteria: &[RubricCriterion],
    call: JudgeCall,
) -> Evaluation {
    let parsed = call
        .failure
        .is_none()
        .then(|| judge_score_sheet(&version.manifest, &call.reply, response, criteria))
        .flatten();
    let score = parsed.as_ref().and_then(|sheet| sheet.score);
    // The monitor of quote-less passes: they are valid on any condition,
    // and their share by judge model and kind of condition is watched.
    let quote_less = parsed
        .as_ref()
        .and_then(|sheet| sheet.critical.as_ref())
        .map(|critical| critical.quote_less);
    if let Some(counts) = quote_less.filter(|q| q.omission + q.positive > 0) {
        log::info!(
            "[benchmarks] judge {} passed conditions without a quote: {} omission, {} positive",
            judge.model_id,
            counts.omission,
            counts.positive
        );
    }
    // A reply that gave no valid sheet is kept beside the rendering, so a
    // later audit reads it from the evidence (10-18: the rejected sheets
    // had to be rebuilt from the session events).
    let mut artifacts = Vec::new();
    let mut diagnostic_notice = None;
    if parsed.is_none() && !call.reply.trim().is_empty() {
        let directory = evidence.directory(store, attempt);
        let path = directory.join(format!("judge-reply-{}.txt", call.id));
        let written = async {
            tokio::fs::create_dir_all(&directory).await?;
            tokio::fs::write(&path, call.reply.as_bytes()).await
        }
        .await;
        match written {
            Ok(()) => artifacts.push(Artifact {
                kind: "text".into(),
                path: path.to_string_lossy().into_owned(),
                hash: hex::encode(Sha256::digest(call.reply.as_bytes())),
                label: "Judge reply".into(),
            }),
            Err(error) => {
                log::warn!(
                    "[benchmarks] the judge reply of {} could not be kept: {error}",
                    call.id
                );
                let error = diagnostics::record(
                    store,
                    attempt,
                    "judge_reply_storage",
                    error.into(),
                    Some(judge),
                    context.clone(),
                )
                .await;
                if error
                    .details
                    .as_ref()
                    .is_some_and(|d| d["diagnosticPersistenceFailed"] == true)
                {
                    diagnostic_notice = Some(error.message);
                }
            }
        }
    }
    let mut reason = match &parsed {
        Some(sheet) if !sheet.reason.is_empty() => sheet.reason.clone(),
        Some(_) => "Scored by the judge panel".into(),
        None => call.failure.unwrap_or_else(|| {
            format!(
                "Judge returned no valid score sheet: {}",
                invalid_sheet_reason(&version.manifest, &call.reply, response, criteria)
            )
        }),
    };
    if let Some(notice) = diagnostic_notice {
        reason.push_str(&format!(". {notice}"));
    }
    Evaluation {
        id: call.id,
        evaluator_revision: version.manifest.evaluator.revision.clone(),
        verdict: if score.is_some() {
            "judged"
        } else {
            "abstained"
        }
        .into(),
        score,
        reason,
        created_at: now(),
        provenance: if score.is_some() {
            "judge"
        } else {
            "judge_failure"
        }
        .into(),
        artifacts,
        details: Some(
            json!({"judgeBatchId": batch, "sessionId": call.session_id, "usageComplete": call.usage_complete,
                "requestKey": call.key, "inFlight": !call.usage_complete,
                "providerError": call.provider_error,
                "durationMs": call.started.elapsed().as_millis() as u64,
                "runtimeRevision": call.runtime_revision,
                "criteria": parsed.as_ref().map(|sheet| &sheet.shares),
                "criticalCheckPolicy": parsed.as_ref().and_then(|sheet| sheet.critical.as_ref().map(|_| judge_checks::POLICY)),
                "criticalCheckStatus": parsed.as_ref().and_then(|sheet| sheet.critical.as_ref().map(|check| check.status)),
                "criticalChecks": parsed.as_ref().and_then(|sheet| sheet.critical.as_ref().map(|check| &check.checks)),
                "quoteLessPasses": quote_less.map(|q| json!({"omission": q.omission, "positive": q.positive}))}),
        ),
        judge: Some(judge.clone()),
        usage: Some(call.usage),
    }
}
