//! One attempt from dispatch to the end of its try.
use super::*;

/// Records when `attempt` reached `phase` (see `Attempt::phase_times`).
pub(in super::super) fn mark_phase(attempt: &mut Attempt, phase: &str) {
    attempt
        .phase_times
        .get_or_insert_with(Default::default)
        .insert(phase.into(), now());
}

/// Drops the native clock a standalone attempt's try froze when the try goes
/// back to the queue, so the next try is timed from its own start: time in
/// the queue (a pause, a refusal for room, a quota wait) never spends the
/// next try's wall budget. A sealed attempt keeps it.
pub(in super::super) async fn drop_collection_clock(
    store: &Store,
    attempt: &mut Attempt,
) -> Result<()> {
    if collection_context::discard_clock(store, attempt).await? {
        attempt.collection_context = None;
    }
    Ok(())
}

/// The host request key of an attempt's candidate turn. A turn the host
/// refused before any provider call returns the attempt to the queue, and the
/// next dispatch starts at a new time, so it never meets the refused record.
pub(in super::super) fn dispatch_key(attempt: &Attempt) -> String {
    format!("benchmark:{}", turn_owner(attempt))
}

/// The owner of an attempt's candidate session. The host keeps one session
/// and one turn per owner, so a turn tried again after a refusal needs a new
/// owner as well as a new key; both carry the start time.
pub(in crate::services::benchmarks) fn turn_owner(attempt: &Attempt) -> String {
    format!("{}:{}", attempt.id, attempt.started_at.unwrap_or_default())
}

impl BenchmarkService {
    /// Runs one attempt to its settlement, as the runner always has.
    pub(in super::super) async fn run_attempt(
        &self,
        run: &BenchmarkRun,
        a: Attempt,
        version: BenchmarkVersion,
        judge_budget: Option<std::result::Result<bool, String>>,
        cancel_rx: watch::Receiver<bool>,
    ) -> Result<()> {
        let result = if let Err(error) = run.request.require_dispatch_admission(now()) {
            Err(error)
        } else if version.manifest.workflow.is_some() {
            let executed = crate::services::benchmarks::workflow::execute(
                self,
                a.clone(),
                version.clone(),
                run.request.timeout_seconds,
                cancel_rx.clone(),
            )
            .await;
            let account = format!(
                "{}\u{1f}{}",
                a.configuration.provider_id,
                a.configuration.account_id.as_deref().unwrap_or_default()
            );
            let paced = pace_key(&self.store, &account);
            match &executed {
                Ok(root) => pace_workflow(&paced, root, None),
                Err(error) => {
                    if let Ok(saved) = self.store.attempt(&a.id).await {
                        pace_workflow(&paced, &saved, Some(error));
                    }
                }
            }
            executed
        } else {
            let unstarted = || async {
                self.store
                    .attempt(&a.id)
                    .await
                    .is_ok_and(|saved| saved.phase == "preparing" && !reached_provider(&saved))
            };
            let executed = preparation_watchdog::bounded(
                self.backend.execute(
                    &self.store,
                    a.clone(),
                    version.clone(),
                    run.request.timeout_seconds,
                    cancel_rx.clone(),
                ),
                preparation_watchdog::PREPARATION_LIMIT,
                preparation_watchdog::CHECK_EVERY,
                unstarted,
            )
            .await;
            if executed
                .as_ref()
                .is_ok_and(|done| checks_without_its_seat(done, &version))
                && self.release_turn_seat(&a.id).await
            {
                // The next attempt prepares while this answer is checked.
                self.wake.notify_one();
            }
            let account = format!(
                "{}\u{1f}{}",
                a.configuration.provider_id,
                a.configuration.account_id.as_deref().unwrap_or_default()
            );
            let paced = pace_key(&self.store, &account);
            match &executed {
                Ok(done) => pace_turn(&paced, done, None),
                Err(error) => {
                    if let Ok(saved) = self.store.attempt(&a.id).await {
                        pace_turn(&paced, &saved, Some(error));
                    }
                }
            }
            executed
        };
        // The generation released its sandbox. A refused queue can now check
        // again, while this sealed answer proceeds to evaluation and judging.
        if admission_window::finished(&self.store.root.display().to_string(), &a.id) {
            self.wake.notify_one();
        }
        // The cancel signal stays live through judging.
        let result = match result {
            Ok(mut completed) => {
                mark_phase(&mut completed, "checkStarted");
                let stop = JudgeStop::run(&run.id, cancel_rx);
                // A republication that changed only the evaluator while the
                // turn ran evaluates it, as it evaluated the settled ones.
                match self.store.carried_version(&version.id).await {
                    Ok(evaluated) => self.settle(completed, &evaluated, judge_budget, stop).await,
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(mut completed) => {
                quota_recovered(&run.id, &quota_scope(&a.configuration));
                completed.phase = self.settled_phase(run, &completed).await?.into();
                self.store.save_attempt(&completed).await?;
                let streak = infrastructure_streak(
                    &run.id,
                    &quota_scope(&a.configuration),
                    completed.outcome.as_deref() == Some("infrastructure_failure"),
                );
                if measured_again_by_itself(&run.request, &version, &completed, streak)
                    && self.store.run_state(&run.id).await? == "running"
                {
                    self.measure_again(run, completed).await?;
                }
            }
            Err(error) => self.try_failed(run, &a, &version, error).await?,
        }
        Ok(())
    }

    /// Opens an idle credit for a workflow root that goes back to the queue
    /// with its native root clock running, so the wait is not spent from its
    /// wall budget. A campaign root never continues mid-trajectory, so it
    /// never gets one.
    pub(in super::super) async fn idle_root(&self, root: &Attempt) -> Result<()> {
        if root.configuration.execution_profile == "workflow_policy" {
            return Ok(());
        }
        self.store
            .open_root_credit(&root.id, &root.run_id, now(), "idle")
            .await
    }

    /// Discards what a try no provider saw left behind, so the cell's next
    /// admission is its first: a root-pinned workflow's prepared steps and
    /// the clocks they froze. False when something must stay: a research
    /// workflow's committed step decisions, or a step the store shows a
    /// provider saw.
    pub(in super::super) async fn forget_unstarted_try(
        &self,
        attempt: &Attempt,
        version: &BenchmarkVersion,
    ) -> Result<bool> {
        if version.manifest.workflow.is_none() {
            return Ok(true);
        }
        if attempt.configuration.execution_profile == "workflow_policy"
            && !attempt.workflow_steps.is_empty()
        {
            return Ok(false);
        }
        // A campaign root that never started a step times its next
        // admission afresh too: its root clock and any step clock its
        // preparation froze go with the prepared steps.
        crate::services::benchmarks::workflow::discard_unstarted(&self.store, attempt).await
    }

    /// Another enabled account of `configuration`'s provider whose limit has
    /// not run out under `run_id`, the default first.
    pub(in super::super) async fn room_elsewhere(
        &self,
        run_id: &str,
        configuration: &Configuration,
    ) -> Option<String> {
        let current = configuration.account_id.as_deref();
        let credits = crate::services::benchmarks::credits::spend(&self.store.root)
            .await
            .is_ok_and(|spend| spend.allows());
        self.backend
            .accounts(&configuration.provider_id, credits)
            .await
            .unwrap_or_default()
            .into_iter()
            .find(|account| Some(account.as_str()) != current && !exhausted(run_id, account))
    }
}
