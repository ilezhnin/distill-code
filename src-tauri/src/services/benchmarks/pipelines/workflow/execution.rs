//! Running a workflow root step by step, and picking it up after a restart.
use super::*;
use crate::services::benchmarks::{
    artifact_context,
    runner::{
        reached_provider, requeue, returns_to_queue, settled_failure, turn_owner, SIGN_IN_WAIT,
    },
    workflow_campaign::{CampaignConcurrency, WorkerAdmission},
};

/// Boxed: an attempt's runner already sits deep on its 2 MiB worker stack,
/// and an unoptimized build gives the awaiting poll a stack slot for every
/// step this would otherwise carry inline.
pub fn execute(
    service: &BenchmarkService,
    mut root: Attempt,
    version: BenchmarkVersion,
    timeout: u32,
    cancel: watch::Receiver<bool>,
) -> BoxFuture<'_, Result<Attempt>> {
    Box::pin(async move {
        let issues = validate(&version.manifest);
        if !issues.is_empty() {
            return Err(BenchmarkError::new("validation", issues.join("; ")));
        }
        let count = version
            .manifest
            .workflow
            .as_ref()
            .ok_or_else(|| BenchmarkError::new("validation", "Workflow is absent"))?
            .steps
            .len();
        let new_clock = version
            .manifest
            .environment
            .get("nativeBudgetRecipe")
            .and_then(serde_json::Value::as_str)
            == Some(artifact_context::CLOCK_RECIPE);
        let policy = root.configuration.execution_profile == "workflow_policy";
        let concurrency = if policy {
            let request = service.store.run(&root.run_id).await?.request;
            service
                .store
                .workflow_campaign_concurrency(&request.request_key)
                .await?
        } else {
            CampaignConcurrency::SERIAL
        };
        let concurrent = concurrency.concurrent();
        if (new_clock || concurrent)
            && !open_root_clock(service, &mut root, &version, timeout).await?
        {
            return Ok(root);
        }
        let mut steps = saved_steps(&service.store, &root.id).await?;
        let trajectory = Trajectory {
            service,
            version: &version,
            timeout,
            wall_clock: new_clock || concurrent,
            concurrent,
            concurrency,
            cancel: cancel.clone(),
            wall_origin: root.started_at.unwrap_or_else(now),
            consumed: steps
                .iter()
                .filter(|s| s.attempt.phase == "terminal")
                .try_fold(0u64, |sum, step| {
                    step.attempt.duration_ms.and_then(|ms| sum.checked_add(ms))
                }),
            start: Instant::now(),
        };
        if let Some((code, reason)) = prefix_violation(&steps, trajectory.budget_ms()) {
            root.outcome = Some(code.into());
            root.reason = Some(reason.into());
            root.phase = "collecting".into();
            seal_root(&service.store, &mut root, &steps).await?;
            return Ok(root);
        }
        for index in 0..count {
            let run_state: String = sqlx::query_scalar("SELECT state FROM run_plans WHERE id=?")
                .bind(&root.run_id)
                .fetch_one(&service.store.pool)
                .await?;
            if *cancel.borrow() || matches!(run_state.as_str(), "cancelling" | "cancelled") {
                root.outcome = Some("cancelled".into());
                root.reason = Some("Workflow cancelled before the next step".into());
                break;
            }
            if let Some(existing) = steps.get(index) {
                if existing.index != index {
                    return Err(BenchmarkError::new(
                        "evidence_missing",
                        "Workflow step sequence is incomplete",
                    ));
                }
                if existing.attempt.phase == "terminal" {
                    if existing.attempt.outcome.as_deref() != Some("completed") {
                        stop_with_child(&mut root, &existing.attempt);
                        break;
                    }
                    if index + 1 == count {
                        stop_with_child(&mut root, &existing.attempt);
                    }
                    continue;
                }
                if existing.attempt.phase != "pending" {
                    return Err(BenchmarkError::new(
                        "dispatch_uncertain",
                        "A previously admitted workflow step requires reconciliation",
                    ));
                }
            }
            let native_elapsed = steps
                .iter()
                .filter(|step| step.attempt.phase == "terminal")
                .try_fold(0u64, |sum, step| {
                    step.attempt
                        .native_execution_ms
                        .and_then(|ms| sum.checked_add(ms))
                });
            let remaining = trajectory.remaining(&root, &steps, native_elapsed).await?;
            if remaining == 0 {
                let exhausted = BenchmarkError::new(
                    "budget_timeout",
                    "Workflow exhausted its shared duration budget",
                );
                fail_root(&mut root, &exhausted);
                break;
            }
            if steps.len() == index {
                let prepared = trajectory
                    .prepare(&root, index, remaining, &steps, native_elapsed.is_some())
                    .await;
                match prepared {
                    Ok(step) => steps.push(step),
                    Err(error) if error.code == "budget_timeout" => {
                        fail_root(&mut root, &error);
                        break;
                    }
                    Err(error) => return Err(error),
                }
                aggregate(&mut root, &steps);
                service.store.save_attempt(&root).await?;
            }
            let untouched = steps[..index]
                .iter()
                .all(|step| !reached_provider(&step.attempt));
            let saved = &mut steps[index];
            saved.attempt.phase = "preparing".into();
            saved.attempt.started_at = Some(now());
            service.store.save_attempt(&saved.attempt).await?;
            let effective_version = step_version(&version, saved);
            let request = service.store.run(&root.run_id).await?.request;
            request.require_dispatch_admission(now())?;
            let allowance = remaining.min(saved.entry.remaining_budget_seconds);
            let result = if policy {
                service
                    .execute_workflow_policy_step(
                        &root.id,
                        saved.attempt.clone(),
                        effective_version,
                        allowance,
                        cancel.clone(),
                    )
                    .await
            } else {
                trajectory
                    .execute_waiting_for_room(
                        saved,
                        effective_version,
                        allowance,
                        untouched,
                        &request,
                    )
                    .await?
            };
            match result {
                Ok(mut completed) => {
                    completed.phase = "terminal".into();
                    saved.attempt = completed;
                }
                Err(error) => {
                    let retry = request.automatic_retry();
                    if fails_its_root(&error.code, retry) {
                        return Err(error);
                    }
                    saved.attempt = service.store.attempt(&saved.attempt.id).await?;
                    let failure = step_failure(&StepFacts {
                        code: &error.code,
                        policy,
                        retry,
                        untouched,
                        unstarted: saved.attempt.phase == "preparing"
                            && !reached_provider(&saved.attempt),
                        returns_to_queue: returns_to_queue(&error.code, &saved.attempt.phase),
                    });
                    match failure {
                        StepFailure::Requeue => {
                            requeue(&mut saved.attempt, error.message.clone());
                            service.store.save_attempt(&saved.attempt).await?;
                            return Err(error);
                        }
                        StepFailure::WaitForSeat => {
                            saved.attempt.phase = "pending".into();
                            saved.attempt.started_at = None;
                            service.store.save_attempt(&saved.attempt).await?;
                            return Err(error);
                        }
                        StepFailure::Settle => {
                            settle_step(&mut saved.attempt, &error);
                        }
                        StepFailure::SettleAndFail => {
                            let (outcome, reason) = settle_step(&mut saved.attempt, &error);
                            service.store.save_attempt(&saved.attempt).await?;
                            aggregate(&mut root, &steps);
                            service.store.save_attempt(&root).await?;
                            // The root settles with what its step settled with.
                            return Err(if outcome == error.code {
                                error
                            } else {
                                BenchmarkError::new(&outcome, reason)
                            });
                        }
                    }
                }
            }
            service.store.save_attempt(&saved.attempt).await?;
            let failed = saved.attempt.outcome.as_deref() != Some("completed");
            if failed || index + 1 == count {
                stop_with_child(&mut root, &saved.attempt);
            }
            aggregate(&mut root, &steps);
            service.store.save_attempt(&root).await?;
            if failed {
                break;
            }
            if let Some((code, reason)) = prefix_violation(&steps, trajectory.budget_ms()) {
                root.outcome = Some(code.into());
                root.reason = Some(reason.into());
                break;
            }
            if trajectory.wall_exhausted(&steps, native_elapsed.is_none())? {
                root.outcome = Some("budget_timeout".into());
                root.reason = Some("Workflow exceeded its shared duration budget".into());
                break;
            }
        }
        root.phase = "collecting".into();
        seal_root(&service.store, &mut root, &steps).await?;
        Ok(root)
    })
}

/// Starts the root's wall clock, or takes it up where an earlier admission
/// left it: the time the root sat in the queue with a paid prefix, or
/// stranded by a stopped app, is credited back from here on. Whether the root
/// goes on: once its budget ran out it is sealed with that instead.
async fn open_root_clock(
    service: &BenchmarkService,
    root: &mut Attempt,
    version: &BenchmarkVersion,
    timeout: u32,
) -> Result<bool> {
    let key = format!("workflow-root:{}", root.id);
    service.store.close_root_credit(&root.id, now()).await?;
    let old = service.store.native_budget(&key).await?;
    let origin = old
        .as_ref()
        .map(|lease| lease.root_started_at_ms)
        .or(root.started_at)
        .unwrap_or_else(now);
    root.started_at = Some(origin);
    service.store.save_attempt(root).await?;
    let lease = artifact_context::BudgetLease {
        recipe: artifact_context::CLOCK_RECIPE.into(),
        root_id: root.id.clone(),
        root_started_at_ms: origin,
        root_cap_seconds: timeout,
        step_key: key.clone(),
        step_started_at_ms: origin,
        step_cap_seconds: timeout,
        credits: Vec::new(),
    };
    let reserved = service
        .store
        .reserve_task_budget(
            &key,
            &fixtures::hash(&serde_json::to_vec(&(
                &root.id,
                &version.content_hash,
                timeout,
            ))?),
            &version.content_hash,
            Some(&lease),
            timeout,
            timeout,
            &root.id,
        )
        .await;
    let Err(error) = reserved else {
        return Ok(true);
    };
    if error.code != "budget_timeout" {
        return Err(error);
    }
    fail_root(root, &error);
    root.phase = "collecting".into();
    let steps = saved_steps(&service.store, &root.id).await?;
    seal_root(&service.store, root, &steps).await?;
    Ok(false)
}

/// The root ends with what `error` means for it (see [`settled_failure`]).
fn fail_root(root: &mut Attempt, error: &BenchmarkError) {
    let (outcome, reason) = settled_failure(root, error);
    root.outcome = Some(outcome);
    root.reason = Some(reason);
}

/// Settles `step` with what `error` means for it (see [`settled_failure`]),
/// and returns that outcome and reason.
fn settle_step(step: &mut Attempt, error: &BenchmarkError) -> (String, String) {
    let (outcome, reason) = settled_failure(step, error);
    step.phase = "terminal".into();
    step.outcome = Some(outcome.clone());
    step.reason = Some(reason.clone());
    step.finished_at = Some(now());
    (outcome, reason)
}

/// Whether a step's failure with `code` is its root's own under a run that
/// retries by itself: the root fails with it, and nothing of the step is read
/// or changed. A run that forbids retries settles the step with it instead
/// (see [`step_failure`]).
fn fails_its_root(code: &str, retry: bool) -> bool {
    retry && matches!(code, "dispatch_uncertain" | "storage_unavailable")
}

/// How a workflow answers a step that failed, beside a failure that is its
/// root's own (see [`fails_its_root`]).
#[derive(Debug, PartialEq, Eq)]
enum StepFailure {
    /// The step is unstarted again, and the runner returns its root to the
    /// queue.
    Requeue,
    /// The step waits for a seat of its account, and its root with it.
    WaitForSeat,
    /// The step settles with the failure, and its trajectory ends with it.
    Settle,
    /// The step settles, and the root fails with what it settled with.
    SettleAndFail,
}

/// What the answer to a failed step is decided on.
struct StepFacts<'a> {
    code: &'a str,
    /// A research trajectory: it records its actual outcome, and never moves
    /// accounts or retries a worker silently.
    policy: bool,
    /// The run retries by itself.
    retry: bool,
    /// No provider saw any step before this one.
    untouched: bool,
    /// The step, as saved, is still in preparation and no provider saw it.
    unstarted: bool,
    /// See [`returns_to_queue`], for the step as saved.
    returns_to_queue: bool,
}

/// The answer to a failed step. The local broker refusing the first step a
/// provider would have seen, or a sandbox sign-in renewal holding it back,
/// leaves the workflow unstarted under any retry policy. A research
/// trajectory seals a budget timeout even where retries are forbidden,
/// without inventing worker evidence. A step the provider never saw waits in
/// the queue with its workflow, as a single turn would.
fn step_failure(facts: &StepFacts) -> StepFailure {
    let waits_for_local = matches!(facts.code, "resource_busy" | SIGN_IN_WAIT);
    if facts.untouched && waits_for_local && !facts.policy && facts.unstarted {
        return StepFailure::Requeue;
    }
    if facts.policy && facts.code == "budget_timeout" {
        return StepFailure::Settle;
    }
    if !facts.retry {
        return StepFailure::SettleAndFail;
    }
    if facts.policy {
        return StepFailure::Settle;
    }
    if facts.code == "account_busy" {
        return StepFailure::WaitForSeat;
    }
    if facts.returns_to_queue {
        StepFailure::Requeue
    } else {
        StepFailure::Settle
    }
}

/// What stays the same over the steps of one root.
struct Trajectory<'a> {
    service: &'a BenchmarkService,
    version: &'a BenchmarkVersion,
    /// The run's limit for the steps together, in seconds: the case's own
    /// limit is the least a run must allow, never a stop.
    timeout: u32,
    /// The root is timed on the wall clock: the native budget recipe, or a
    /// concurrent campaign.
    wall_clock: bool,
    /// A concurrent campaign's root, which keeps its whole wall cap.
    concurrent: bool,
    concurrency: CampaignConcurrency,
    cancel: watch::Receiver<bool>,
    /// When the root's clock started.
    wall_origin: i64,
    /// What the steps settled before this admission took, where each says.
    consumed: Option<u64>,
    /// When this admission began.
    start: Instant,
}

impl Trajectory<'_> {
    fn budget_ms(&self) -> u64 {
        u64::from(self.timeout) * 1000
    }

    /// The seconds the next step may take; zero once the shared budget is
    /// spent. Exhaustion is the timeout outcome; a clock that moved backwards
    /// is a conflict to surface, never a recorded budget timeout.
    async fn remaining(
        &self,
        root: &Attempt,
        steps: &[SavedStep],
        native_elapsed: Option<u64>,
    ) -> Result<u32> {
        if self.wall_clock {
            let waited =
                excluded_waits_ms(steps) + self.service.store.root_credit_ms(&root.id).await?;
            return match artifact_context::remaining_seconds(
                self.wall_origin + waited,
                now(),
                self.timeout,
            ) {
                Ok(seconds) => Ok(seconds),
                Err(error) if error.code == "budget_timeout" => Ok(0),
                Err(error) => Err(error),
            };
        }
        if let Some(elapsed) = native_elapsed {
            return Ok(remaining_seconds(self.timeout, elapsed).unwrap_or(0));
        }
        let remaining_ms = self
            .budget_ms()
            .saturating_sub(self.consumed.unwrap_or(self.budget_ms()))
            .saturating_sub(self.start.elapsed().as_millis() as u64);
        Ok(remaining_ms.div_ceil(1000) as u32)
    }

    /// Whether the steps so far used up the root's wall budget. Native
    /// execution totals exclude earlier worker-slot waits, and an opt-in
    /// concurrent trajectory keeps its original whole wall cap.
    fn wall_exhausted(&self, steps: &[SavedStep], unmeasured: bool) -> Result<bool> {
        if self.concurrent {
            return match artifact_context::remaining_seconds(
                self.wall_origin + excluded_waits_ms(steps),
                now(),
                self.timeout,
            ) {
                Ok(_) => Ok(false),
                Err(error) if error.code == "budget_timeout" => Ok(true),
                Err(error) => Err(error),
            };
        }
        Ok(unmeasured
            && self
                .consumed
                .unwrap_or(self.budget_ms())
                .saturating_add(self.start.elapsed().as_millis() as u64)
                > self.budget_ms())
    }

    /// Prepares step `index` from the steps before it: its prompt carries
    /// the previous step's output and, where the steps are timed natively
    /// (`native`), the committed reports of all of them.
    async fn prepare(
        &self,
        root: &Attempt,
        index: usize,
        remaining: u32,
        steps: &[SavedStep],
        native: bool,
    ) -> Result<SavedStep> {
        let report = |step: &SavedStep| {
            step.attempt
                .repository_result
                .as_ref()
                .map(|result| result.report.as_str())
                .or(step.attempt.output.as_deref())
                .map(committed_report)
        };
        let native_report = native.then(|| steps.last().and_then(report)).flatten();
        let previous = native_report
            .as_deref()
            .or_else(|| steps.last().and_then(|s| s.attempt.output.as_deref()));
        let native_reports = native.then(|| steps.iter().filter_map(report).collect());
        if self.concurrency.admission == WorkerAdmission::SelectedStep {
            Box::pin(prepare_step_admitted(
                self.service,
                root,
                self.version,
                index,
                remaining,
                previous,
                native_reports,
                &self.concurrency,
                steps,
                self.cancel.clone(),
            ))
            .await
        } else {
            prepare_step(
                self.service,
                root,
                self.version,
                index,
                remaining,
                previous,
                native_reports,
            )
            .await
        }
    }

    /// Runs one step of a root that is not a research trajectory. A later
    /// step the local broker refused before any provider process started, or
    /// a sandbox sign-in renewal held back, waits for room on its root's
    /// seat, so the paid steps before it are kept: it asks again while no
    /// more than a quarter of its allowance has passed, and nothing of its
    /// workflow is sent again. On the wall clock that time comes off the
    /// step's own allowance; past the quarter the refusal settles the step,
    /// unscored. The first step goes back to the queue instead (see
    /// [`step_failure`]).
    async fn execute_waiting_for_room(
        &self,
        saved: &mut SavedStep,
        version: BenchmarkVersion,
        allowance: u32,
        untouched: bool,
        request: &RunRequest,
    ) -> Result<Result<Attempt>> {
        let service = self.service;
        let first_try = now();
        let mut cancelled = self.cancel.clone();
        loop {
            let waited = u32::try_from((now() - first_try).max(0) / 1000).unwrap_or(u32::MAX);
            let timeout = if self.wall_clock {
                allowance.saturating_sub(waited)
            } else {
                allowance
            };
            // A later step of a workflow a provider already worked on goes
            // ahead of new attempts in the sandbox.
            let continuing = (!untouched).then(|| {
                crate::services::benchmark_sandbox::Continuing::new(turn_owner(&saved.attempt))
            });
            let result = service
                .backend
                .execute(
                    &service.store,
                    saved.attempt.clone(),
                    version.clone(),
                    timeout,
                    self.cancel.clone(),
                )
                .await;
            drop(continuing);
            let retry = match &result {
                Err(error)
                    if !untouched
                        && matches!(error.code.as_str(), "resource_busy" | SIGN_IN_WAIT)
                        && later_step_may_wait(first_try, allowance, now()) =>
                {
                    let current = service.store.attempt(&saved.attempt.id).await?;
                    (current.phase == "preparing" && !reached_provider(&current)).then_some(current)
                }
                _ => None,
            };
            let Some(current) = retry else {
                return Ok(result);
            };
            tokio::select! {
                _ = tokio::time::sleep(LATER_STEP_RETRY) => {}
                changed = cancelled.changed() => {
                    // A closed channel cancels nothing; still pause.
                    if changed.is_err() {
                        tokio::time::sleep(LATER_STEP_RETRY).await;
                    }
                }
            }
            if *self.cancel.borrow() || request.require_dispatch_admission(now()).is_err() {
                return Ok(result);
            }
            // A new start is a new owner for the host, as for a cell that
            // went back to the queue.
            saved.attempt = current;
            saved.attempt.started_at = Some(now());
            service.store.save_attempt(&saved.attempt).await?;
        }
    }
}

/// Restore observations only. Undispatched continuation waits for an explicit run resume.
pub async fn recover(
    service: &BenchmarkService,
    mut root: Attempt,
    version: BenchmarkVersion,
) -> Result<Option<Attempt>> {
    if root.evidence_hash.is_some()
        && root
            .outcome
            .as_deref()
            .is_some_and(|outcome| !matches!(outcome, "interrupted" | "dispatch_uncertain"))
    {
        root.phase = "collecting".into();
        return Ok(Some(root));
    }
    let count = version
        .manifest
        .workflow
        .as_ref()
        .ok_or_else(|| BenchmarkError::new("validation", "Workflow is absent"))?
        .steps
        .len();
    let mut steps = saved_steps(&service.store, &root.id).await?;
    for saved in &mut steps {
        if saved.attempt.phase == "pending"
            || (saved.attempt.phase == "terminal"
                && saved.attempt.outcome.as_deref() != Some("dispatch_uncertain"))
        {
            continue;
        }
        let result = service
            .backend
            .recover(&service.store, saved.attempt.clone())
            .await?;
        match result {
            Some(mut recovered) => {
                recovered.phase = "terminal".into();
                saved.attempt = recovered;
            }
            None => {
                saved.attempt.phase = "terminal".into();
                saved.attempt.outcome = Some("dispatch_uncertain".into());
                saved.attempt.reason =
                    Some("Workflow step acceptance is uncertain; it will not be resent".into());
            }
        }
        service.store.save_attempt(&saved.attempt).await?;
    }
    let timeout = service
        .store
        .run(&root.run_id)
        .await?
        .request
        .timeout_seconds;
    // The run's limit bounds the steps together; the case's own limit is the
    // least a run must allow, never a stop.
    let budget_ms = u64::from(timeout) * 1000;
    if let Some((code, reason)) = prefix_violation(&steps, budget_ms) {
        root.outcome = Some(code.into());
        root.reason = Some(reason.into());
        root.phase = "collecting".into();
    } else if let Some(failed) = steps.iter().find(|step| {
        step.attempt.phase == "terminal" && step.attempt.outcome.as_deref() != Some("completed")
    }) {
        stop_with_child(&mut root, &failed.attempt);
    } else if steps.len() == count && steps.iter().all(|s| s.attempt.phase == "terminal") {
        stop_with_child(&mut root, &steps.last().unwrap().attempt);
    } else {
        aggregate(&mut root, &steps);
        root.phase = "pending".into();
        root.outcome = None;
        root.reason = Some(
            "Saved workflow steps recovered; resume explicitly to admit the remaining steps".into(),
        );
        service.store.save_attempt(&root).await?;
        return Ok(Some(root));
    }
    seal_root(&service.store, &mut root, &steps).await?;
    Ok(Some(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A step of a root that retries by itself, with nothing sent before it,
    /// that failed after its prompt went out.
    fn facts(code: &str) -> StepFacts<'_> {
        StepFacts {
            code,
            policy: false,
            retry: true,
            untouched: true,
            unstarted: false,
            returns_to_queue: false,
        }
    }

    #[test]
    fn a_failed_step_is_answered_by_what_it_was_and_what_its_run_allows() {
        use StepFailure::*;
        // Refused for local room, or held by a sign-in renewal, before any
        // provider saw the workflow: unstarted again under either retry
        // policy. A research trajectory records the refusal instead.
        for code in ["resource_busy", SIGN_IN_WAIT] {
            let unstarted = |retry| StepFacts {
                unstarted: true,
                retry,
                ..facts(code)
            };
            assert_eq!(step_failure(&unstarted(true)), Requeue, "{code}");
            assert_eq!(step_failure(&unstarted(false)), Requeue, "{code}");
            let research = StepFacts {
                policy: true,
                ..unstarted(true)
            };
            assert_eq!(step_failure(&research), Settle, "{code}");
            // A later step past its wait settles, unscored.
            let later = StepFacts {
                untouched: false,
                unstarted: true,
                ..facts(code)
            };
            assert_eq!(step_failure(&later), Settle, "{code}");
        }
        // A step the provider never saw waits in the queue with its
        // workflow, one without a seat waits for it, and a turn that ran is
        // the step's outcome.
        let unseen = StepFacts {
            returns_to_queue: true,
            ..facts("selection_changed")
        };
        assert_eq!(step_failure(&unseen), Requeue);
        assert_eq!(step_failure(&facts("account_busy")), WaitForSeat);
        assert_eq!(step_failure(&facts("infrastructure_failure")), Settle);
        // A run that forbids retries settles the step with whatever ended
        // it, and its root fails with that.
        for code in [
            "infrastructure_failure",
            "account_busy",
            "selection_changed",
            "dispatch_uncertain",
        ] {
            let forbidden = StepFacts {
                retry: false,
                returns_to_queue: true,
                ..facts(code)
            };
            assert_eq!(step_failure(&forbidden), SettleAndFail, "{code}");
        }
        // A research trajectory records its outcome, and seals a budget
        // timeout even where retries are forbidden.
        let research = |code, retry| StepFacts {
            policy: true,
            retry,
            ..facts(code)
        };
        assert_eq!(step_failure(&research("account_quota_wait", true)), Settle);
        assert_eq!(step_failure(&research("budget_timeout", false)), Settle);
        assert_eq!(
            step_failure(&research("infrastructure_failure", false)),
            SettleAndFail
        );
        // An uncertain dispatch or a store that failed is the root's own
        // where the run retries by itself.
        for code in ["dispatch_uncertain", "storage_unavailable"] {
            assert!(fails_its_root(code, true), "{code}");
            assert!(!fails_its_root(code, false), "{code}");
        }
        assert!(!fails_its_root("infrastructure_failure", true));
    }
}
