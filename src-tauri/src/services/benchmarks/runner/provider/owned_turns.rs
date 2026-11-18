//! An owned turn: its output, its receipts and the wait for its end.
use super::*;

/// Why an attempt whose answer passed the published artifact cap settled as
/// a budget failure.
pub(crate) const ANSWER_CAP_REASON: &str =
    "The answer exceeded the published artifact cap; cancellation acknowledged";

/// The same, found while recovering a turn a restart cut off.
pub(in super::super) const RECOVERED_ANSWER_CAP_REASON: &str =
    "The recovered answer exceeds the published artifact cap";

/// What a turn's events add up to as the runner reads them: the answer, the
/// first policy violation and the record to seal, with the usage and the
/// model that answered written on the attempt. Only the answer counts
/// against the published artifact cap; the record has a ceiling of its own
/// (see [`crate::services::benchmarks::evidence::EvidenceLog`]) and never ends the turn.
/// Read the committed native history without reopening a workspace or event stream.
pub(in super::super) async fn read_owned_task_output(
    store: &crate::services::agent_host::store::SessionStore,
    key: &str,
    session: &str,
) -> Result<crate::services::benchmarks::task_execution::NativeOutput> {
    let status = store
        .execution_dispatch(key)
        .await
        .map_err(host_error)?
        .ok_or_else(|| {
            BenchmarkError::new("evidence_missing", "Native predecessor has no dispatch")
        })?;
    if status.session_id != session || status.phase != "terminal" {
        return Err(BenchmarkError::new(
            "dispatch_uncertain",
            "A predecessor has not reached a committed native terminal result",
        ));
    }
    if status.error.is_some() {
        return Err(BenchmarkError::new(
            "evidence_missing",
            "Native task did not complete successfully",
        ));
    }
    let (output, elapsed_ms) = store
        .task_public_result(key, session)
        .await
        .map_err(host_error)?;
    let (owner, _) = store
        .execution_owner(session)
        .await
        .map_err(host_error)?
        .ok_or_else(|| {
            BenchmarkError::new("evidence_missing", "Native predecessor owner is absent")
        })?;
    let repository_result = if owner.profile == ExecutionProfile::ProtectedRepositoryV1 {
        crate::services::benchmarks::artifact_context::decode(&output, 256 * 1024 * 1024)?
    } else {
        None
    };
    Ok(crate::services::benchmarks::task_execution::NativeOutput {
        text: crate::services::benchmarks::workflow::committed_report(
            repository_result
                .as_ref()
                .map_or(output.as_str(), |result| result.report.as_str()),
        ),
        elapsed_ms,
        repository_result,
    })
}

/// Inspect only native public events with the same output/policy caps as collection.
pub(crate) async fn owned_task_public_output(
    host: &Arc<crate::services::agent_host::router::Inner>,
    session: &str,
    cap: u64,
    terminal: bool,
) -> std::result::Result<Option<String>, Value> {
    let owner = match host.store.execution_owner(session).await {
        Ok(Some((owner, _))) => owner,
        _ => {
            return Err(
                json!({"kind":"dispatch_uncertain","message":"Native task owner is unavailable"}),
            )
        }
    };
    let repository = owner.profile == ExecutionProfile::ProtectedRepositoryV1;
    let binding = if repository && terminal {
        let purpose = host
            .store
            .owned_session_purpose(session)
            .await
            .map_err(|error| json!({"kind":"dispatch_uncertain","message":error}))?;
        if purpose.as_deref() != Some("task") {
            return Err(
                json!({"kind":"dispatch_uncertain","message":"Repository output requires a native task owner"}),
            );
        }
        let id = owner.owner_id.strip_prefix("task:").ok_or_else(
            || json!({"kind":"dispatch_uncertain","message":"Native task binding is absent"}),
        )?;
        let service = host
            .app
            .state::<crate::services::benchmarks::BenchmarkState>()
            .get(&host.app)
            .await
            .map_err(|error| json!({"kind":error.code,"message":error.message}))?;
        let binding = service
            .store
            .task_binding(id)
            .await
            .map_err(|error| json!({"kind":error.code,"message":error.message}))?;
        let saved = service
            .store
            .task_session(&binding)
            .await
            .map_err(|error| json!({"kind":error.code,"message":error.message}))?;
        if saved.as_ref().is_none_or(|saved| {
            saved.owned.session_id != session || saved.owned.owner_id != owner.owner_id
        }) {
            return Err(
                json!({"kind":"dispatch_uncertain","message":"Native task binding belongs to another session"}),
            );
        }
        Some(binding)
    } else {
        None
    };
    let mut attempt = crate::services::benchmarks::pending_attempt(
        "application",
        "public-policy",
        &Configuration {
            id: "policy".into(),
            provider_id: "policy".into(),
            account_id: None,
            model_id: "policy".into(),
            model_name: None,
            effort: None,
            fast_mode: None,
            billing_mode: "unknown".into(),
            execution_profile: "native_text".into(),
            inventory_revision: None,
        },
        0,
    );
    let mut capture = TurnCapture::new(cap);
    let mut cursor = 0;
    loop {
        let page = match host.read_owned_events(session, cursor, 200).await {
            Ok(page) => page,
            Err(error) => return Err(json!({"kind":"dispatch_uncertain","message":error})),
        };
        for event in page.events {
            if let Err(error) = capture.read(event.payload, &mut attempt) {
                return Err(json!({"kind":"dispatch_uncertain","message":error.message}));
            }
            if repository && capture.output.len() > 128 * 1024 {
                return Err(
                    json!({"kind":"artifact_limit","message":"Native repository report exceeds its sealed report limit"}),
                );
            }
        }
        cursor = page.cursor;
        if !page.has_more {
            break;
        }
    }
    if repository && terminal {
        if let Err(error) = host.stop_owned_sandbox(session).await {
            return Err(json!({"kind":"dispatch_uncertain","message":error}));
        }
        let deadline = binding
            .as_ref()
            .map(|binding| binding.deadline_at_ms())
            .transpose()
            .map_err(|error| json!({"kind":error.code,"message":error.message}))?
            .flatten()
            .map(unsigned_deadline)
            .transpose()
            .map_err(|error| json!({"kind":error.code,"message":error.message}))?;
        if let Err(error) = collect_repository_until(
            &mut attempt,
            &repository_execution::attempt_id(&owner.owner_id),
            cap,
            deadline,
        )
        .await
        {
            return Err(json!({"kind":error.code,"message":error.message}));
        }
        if attempt.outcome.as_deref() == Some("budget_reached") {
            return Err(
                json!({"kind":"artifact_limit","message":"Native repository patch exceeds its artifact cap"}),
            );
        }
    }
    if !repository && capture.cap_answer() {
        return Err(
            json!({"kind":"artifact_limit","message":"Owned task exceeded its published output cap"}),
        );
    }
    if let Some(message) = capture.violation {
        return Err(json!({"kind":"execution_violation","message":message}));
    }
    if let Some(binding) = &binding {
        if let Some(context) = &binding.context_v2 {
            let result = async {
                let snapshot = binding.request.repository.as_ref().ok_or_else(|| {
                    BenchmarkError::new(
                        "invalid_task_authority",
                        "Native repository snapshot is absent",
                    )
                })?;
                let before = context.artifact_before.as_ref().ok_or_else(|| {
                    BenchmarkError::new(
                        "invalid_task_authority",
                        "Native repository predecessor is absent",
                    )
                })?;
                let deadline = binding.deadline_at_ms()?.ok_or_else(|| {
                    BenchmarkError::new(
                        "invalid_task_authority",
                        "Native repository deadline is absent",
                    )
                })?;
                let sealed = crate::services::benchmarks::repository::seal_until(
                    snapshot,
                    before,
                    attempt.output.as_deref().unwrap_or_default(),
                    cap as usize,
                    unsigned_deadline(deadline)?,
                )
                .await?;
                crate::services::benchmarks::artifact_context::PublicResult {
                    schema_version: 2,
                    recipe: crate::services::benchmarks::repository::ARTIFACT_RECIPE.into(),
                    report: capture.output,
                    artifact: sealed.artifact,
                }
                .encode(cap as usize)
            }
            .await;
            return result.map(Some).map_err(
                |error: BenchmarkError| json!({"kind":error.code,"message":error.message}),
            );
        }
    }
    Ok(terminal.then(|| {
        if repository {
            attempt.output.unwrap_or_default()
        } else {
            capture.output
        }
    }))
}

pub(crate) async fn monitor_owned_task(
    host: &Arc<crate::services::agent_host::router::Inner>,
    session: &str,
    cap: u64,
) -> Value {
    loop {
        if let Err(failure) = owned_task_public_output(host, session, cap, false).await {
            return failure;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Reading and cancelling an already dispatched turn never grants another
/// provider call. This boundary also lets reconciliation run against recorded
/// host responses without starting an application or a provider in tests.
pub(in super::super) trait OwnedTurnReceiptSource: Sync {
    fn cancel_owned_turn<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, std::result::Result<(), String>>;
    fn read_owned_events<'a>(
        &'a self,
        session: &'a str,
        after: i64,
        limit: u32,
    ) -> BoxFuture<'a, std::result::Result<OwnedEventPage, String>>;
    fn execution_status<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, std::result::Result<Option<ExecutionDispatch>, String>>;
}

impl OwnedTurnReceiptSource for crate::services::agent_host::router::Inner {
    fn cancel_owned_turn<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, std::result::Result<(), String>> {
        Box::pin(Self::cancel_owned_turn(self, key))
    }
    fn read_owned_events<'a>(
        &'a self,
        session: &'a str,
        after: i64,
        limit: u32,
    ) -> BoxFuture<'a, std::result::Result<OwnedEventPage, String>> {
        Box::pin(Self::read_owned_events(self, session, after, limit))
    }
    fn execution_status<'a>(
        &'a self,
        key: &'a str,
    ) -> BoxFuture<'a, std::result::Result<Option<ExecutionDispatch>, String>> {
        Box::pin(Self::execution_status(self, key))
    }
}

pub(in super::super) struct OwnedTurnWait<'a> {
    pub(in super::super) key: &'a str,
    pub(in super::super) session_id: &'a str,
    pub(in super::super) started: Instant,
    pub(in super::super) timeout: Duration,
    pub(in super::super) budget:
        Option<&'a crate::services::benchmarks::artifact_context::BudgetLease>,
    pub(in super::super) repository: bool,
    pub(in super::super) cancellation_grace: Duration,
    pub(in super::super) terminal_drain_grace: Duration,
}

fn reconcile_owned_cancel_request(result: std::result::Result<(), String>) -> Result<()> {
    match result {
        // The host may have stopped its sandbox while its terminal receipt is
        // still being committed. Only that notification race gets a grace
        // period; storage, validation and other host errors must propagate.
        Err(message)
            if message == "dispatch_uncertain: no live runtime can confirm cancellation" =>
        {
            Ok(())
        }
        other => other.map_err(host_error),
    }
}

pub(in super::super) async fn wait_for_owned_turn(
    host: &impl OwnedTurnReceiptSource,
    attempt: &mut Attempt,
    capture: &mut TurnCapture,
    cancel: &mut watch::Receiver<bool>,
    wait: OwnedTurnWait<'_>,
) -> Result<Value> {
    let OwnedTurnWait {
        key,
        session_id,
        started,
        timeout,
        budget,
        repository,
        cancellation_grace,
        terminal_drain_grace,
    } = wait;
    let mut cancelled = false;
    let mut timed_out = false;
    let mut cancellation_started = None;
    let mut terminal_drain_started = None;
    let terminal;
    loop {
        if (*cancel.borrow()
            || started.elapsed() > timeout
            || budget
                .as_ref()
                .is_some_and(|budget| budget.remaining_ms(now()).is_err()))
            && !cancelled
        {
            timed_out = !*cancel.borrow();
            reconcile_owned_cancel_request(host.cancel_owned_turn(key).await)?;
            cancelled = true;
            cancellation_started = Some(Instant::now());
        }
        let page = host
            .read_owned_events(session_id, attempt.event_cursor, 200)
            .await
            .map_err(host_error)?;
        for event in page.events {
            capture.read(event.payload, attempt)?;
        }
        attempt.event_cursor = page.cursor;
        // An answer past the published cap, or a broken no-tool
        // policy, has already decided the attempt; stop paying for
        // the rest of the turn. The size of the event record never
        // does (see `evidence`).
        let answer_capped = capture.cap_answer();
        if ((answer_capped && !repository) || capture.violation.is_some()) && !cancelled {
            reconcile_owned_cancel_request(host.cancel_owned_turn(key).await)?;
            cancelled = true;
            cancellation_started = Some(Instant::now());
        }
        let status = host
            .execution_status(key)
            .await
            .map_err(host_error)?
            .ok_or_else(|| {
                BenchmarkError::new("dispatch_uncertain", "Host dispatch record disappeared")
            })?;
        if status.phase == "terminal"
            && !page.has_more
            && attempt.event_cursor >= status.event_cursor
        {
            if let Some(error) = status.error.as_ref().filter(|e| {
                is_quota_wait(e)
                    || refused_for_quota(e, &capture.output, &attempt.usage)
                    || (!cancelled && stopped_for_quota(e, capture, repository))
            }) {
                return Err(BenchmarkError::new(QUOTA_WAIT, error.to_string()));
            }
            terminal = json!({"terminalDispatch":status});
            if let Some(result) = status.result.as_ref() {
                consume_terminal_result(result, attempt);
            }
            if let Some(violation) = capture.violation.take() {
                settle_violation(attempt, violation, capture.declined);
                break;
            }
            if let Some(selection) = status
                .result
                .as_ref()
                .and_then(|r| r.get("observedSelection"))
            {
                let observed = ObservedSelection {
                    model_id: selection["modelId"].as_str().map(str::to_owned),
                    reasoning_effort: selection["reasoningEffort"].as_str().map(str::to_owned),
                    fast_mode: selection["fastMode"].as_bool(),
                };
                if observed.model_id.as_deref() != Some(attempt.configuration.model_id.as_str())
                    || attempt
                        .configuration
                        .effort
                        .as_ref()
                        .is_some_and(|e| Some(e) != observed.reasoning_effort.as_ref())
                    || !crate::services::benchmarks::analysis::fast_mode_acknowledged(
                        attempt.configuration.fast_mode,
                        observed.fast_mode,
                    )
                {
                    attempt.outcome = Some("selection_changed".into());
                    attempt.reason = Some("Provider selection changed during execution".into());
                    break;
                }
            }
            if capture.answer_capped && !repository {
                attempt.outcome = Some("budget_reached".into());
                attempt.reason = Some(ANSWER_CAP_REASON.into());
            } else if let Some(error) = status.error {
                // A cancellation this loop issued because the time or
                // root budget ran out is that timeout, whichever clock
                // (this wall check or the host's deadline) fired first.
                attempt.outcome = Some(
                    if timed_out && error["kind"] == "cancelled" {
                        "budget_timeout"
                    } else {
                        terminal_outcome(&error, &attempt.configuration.model_id)
                    }
                    .into(),
                );
                attempt.reason = Some(error.to_string());
            } else if cancelled {
                attempt.outcome = Some(
                    if timed_out {
                        "budget_timeout"
                    } else {
                        "cancelled"
                    }
                    .into(),
                );
            } else if let Some(reason) = status.result.as_ref().and_then(|result| {
                runtime_output_cap_stop(&attempt.configuration.provider_id, result)
            }) {
                attempt.outcome = Some("budget_reached".into());
                attempt.reason = Some(reason);
            } else if unanswered_turn(attempt, &capture.output) {
                attempt.outcome = Some("infrastructure_failure".into());
                attempt.reason =
                    Some(crate::services::benchmarks::analysis::KIMI_UNANSWERED.into());
            } else {
                attempt.outcome = Some("completed".into());
            }
            break;
        }
        if status.phase == "uncertain" {
            return Err(BenchmarkError::new(
                "dispatch_uncertain",
                "Host cannot determine remote acceptance",
            ));
        }
        // A committed terminal receipt confirms cancellation. Give its events
        // a separate, fixed drain period; an unreachable cursor must not hold
        // the attempt forever. Neither new pages nor progress reset the cap.
        if status.phase == "terminal" && cancelled {
            let draining = terminal_drain_started.get_or_insert_with(Instant::now);
            if draining.elapsed() >= terminal_drain_grace {
                return Err(BenchmarkError::new(
                    "dispatch_uncertain",
                    "Terminal receipt events could not be reconciled before the drain deadline",
                ));
            }
        } else if cancellation_started.is_some_and(|t| t.elapsed() >= cancellation_grace) {
            return Err(BenchmarkError::new(
                "dispatch_uncertain",
                "Cancellation was not confirmed; account requires inspection",
            ));
        }
        if !page.has_more {
            tokio::select! {_ = tokio::time::sleep(Duration::from_millis(250))=>{},_ = cancel.changed()=>{}}
        }
    }
    Ok(terminal)
}
