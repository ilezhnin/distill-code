//! The scheduler: the loop, a tick, filling free seats, starting an attempt.
use super::*;

/// How often a tick that lasts recovers, bakes and admits campaign work
/// again, as it does when it starts.
const HOUSEKEEPING_EVERY: Duration = if cfg!(test) {
    Duration::from_millis(200)
} else {
    Duration::from_secs(5)
};

impl BenchmarkService {
    pub async fn run_loop(self: Arc<Self>) {
        if let Err(error) = self.reconcile_qualification_judges().await {
            log::warn!(
                "[benchmarks] qualification reconciliation failed: {}",
                error.message
            );
        }
        if let Err(error) = self.reconcile_judges().await {
            log::warn!(
                "[benchmarks] judge reconciliation failed: {}",
                error.message
            );
        }
        if let Err(error) = self.repair_saved_judge_assessments().await {
            log::warn!(
                "[benchmarks] judge assessment repair failed: {}",
                error.message
            );
        }
        // Chats of attempts that settled while Flock was closed, and those
        // earlier builds kept, go once the judges above are reconciled.
        self.sweep_settled_sessions(true);
        loop {
            if let Err(error) = self.tick().await {
                log::warn!("[benchmarks] runner paused: {}", error.message);
            }
            tokio::select! {_ = self.wake.notified()=>{},_ = tokio::time::sleep(Duration::from_secs(1))=>{}}
        }
    }

    pub(in super::super) async fn tick(self: &Arc<Self>) -> Result<()> {
        let mut kept = Instant::now();
        // Attempts and judge panels in flight, each its own task; each settles
        // its own attempt and frees its slot, and the next fill takes the slot
        // up again.
        let mut flights = tokio::task::JoinSet::new();
        // Each attempt and panel starts at most once a tick, so one that goes
        // straight back to the queue waits for the next tick; an attempt put
        // back with a wait starts again once the wait is over.
        let mut tried = std::collections::HashSet::new();
        // Recovery owns ordinary flights too: a slow local checker must not
        // stop this loop from dispatching unrelated turns and judge panels.
        let maintained = self.housekeeping(&mut flights, &mut tried).await;
        // A failed dispatch still lets what already flies land.
        let dispatched = if maintained.is_ok() {
            self.fill(&mut flights, &mut tried).await
        } else {
            Ok(())
        };
        // The tick lasts while anything flies; the next one settles runs left
        // with nothing to do.
        while !flights.is_empty() {
            tokio::select! {
                result = flights.join_next() => {
                    if let Some(Err(error)) = result {
                        log::error!("[benchmarks] worker task failed: {error}");
                    }
                }
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
            if flights.is_empty() {
                if maintained.is_ok() {
                    // Drain the interrupted receipts one at a time before an
                    // operator resumes their campaign; other work can still
                    // be filled while each recovered checker runs.
                    self.recover_interrupted(&mut flights, &mut tried).await?;
                    if flights.is_empty() {
                        // Journal the recovered first observations while the
                        // campaign is still stopped, without dispatching any
                        // replacement turn or waiting for the next tick.
                        crate::services::benchmarks::workflow_campaign::tick(self).await?;
                    }
                }
                if flights.is_empty() {
                    break;
                }
            }
            // Under nonstop measurement a tick hardly ends, so what starts one
            // also runs on its own clock while it lasts.
            if maintained.is_ok() && kept.elapsed() >= HOUSEKEEPING_EVERY {
                kept = Instant::now();
                if let Err(error) = self.housekeeping(&mut flights, &mut tried).await {
                    log::warn!("[benchmarks] housekeeping paused: {}", error.message);
                }
            }
            if maintained.is_ok() {
                if let Err(error) = self.fill(&mut flights, &mut tried).await {
                    log::warn!("[benchmarks] dispatch paused: {}", error.message);
                }
            }
        }
        maintained.and(dispatched)
    }

    /// Recovers interrupted attempts, bakes closed windows and admits due
    /// campaign work: at the start of every tick, and every
    /// [`HOUSEKEEPING_EVERY`] within one.
    pub(in super::super) async fn housekeeping(
        self: &Arc<Self>,
        flights: &mut tokio::task::JoinSet<()>,
        tried: &mut std::collections::HashSet<String>,
    ) -> Result<()> {
        self.store.beat(now()).await?;
        self.recover_interrupted(flights, tried).await?;
        self.sweep_settled_sessions(false);
        self.bake_closed_windows().await?;
        crate::services::benchmarks::campaigns::tick(self).await?;
        crate::services::benchmarks::workflow_campaign::tick(self).await
    }

    /// Bakes every run whose window closed, once nothing of it flies. A
    /// rendering still before its judges keeps the run open until the
    /// verdict, as its generation is paid for; no other cell starts.
    async fn bake_closed_windows(&self) -> Result<()> {
        let at = now();
        // A campaign owns first attempts across its whole repetition series;
        // ordinary sitting expiry must not supersede them, so its runs are
        // not listed.
        for id in self
            .store
            .unbaked_run_ids(at - crate::services::benchmarks::analysis::RUN_WINDOW_MS)
            .await?
        {
            if self.flying(&id).await > 0 {
                continue;
            }
            let run = self.store.run(&id).await?;
            // A sealed generation still waiting for its evaluation is part of
            // the sitting.
            if run.attempts.iter().any(|a| a.phase == "interrupted") {
                continue;
            }
            if run.attempts.iter().any(|a| a.phase == AWAITING_JUDGES) {
                if !matches!(run.state.as_str(), "running" | "pausing" | "cancelling") {
                    self.store.set_run_state(&run.id, "running").await?;
                }
                continue;
            }
            self.bake(&run, at).await?;
        }
        Ok(())
    }

    /// Starts what may run now and settles runs that paused, were cancelled or
    /// have nothing left. Runs take turns; workflows sharing reserved worker
    /// accounts are admitted oldest first.
    pub(in super::super) async fn fill(
        self: &Arc<Self>,
        flights: &mut tokio::task::JoinSet<()>,
        tried: &mut std::collections::HashSet<String>,
    ) -> Result<()> {
        crate::services::benchmarks::workflow_campaign::refill(self).await?;
        let mut queues = Vec::new();
        let runs = self.store.active_runs().await?;
        let scope = self.store.root.display().to_string();
        restore_saved_waits(&runs, &scope);
        for run in runs {
            let flying = self.flying(&run.id).await;
            match run.state.as_str() {
                "pausing" => {
                    if flying == 0 {
                        self.store.set_run_state(&run.id, "paused").await?;
                        self.changed().await;
                    }
                    continue;
                }
                "cancelling" => {
                    if flying == 0 {
                        self.finish_cancelling(run).await?;
                    }
                    continue;
                }
                "running" => {}
                _ => continue,
            }
            if judge_watchdog::check_queue(self, &run, now()).await? {
                continue;
            }
            // A rendering a pause or busy judges held back is judged beside the
            // run's generations; the run completes only once none is waiting.
            if let Some(id) = ready_judge(&run, &scope, tried) {
                self.start_waiting_judge(&run, id, flights, tried).await;
            }
            if !admission_window::remaining(&scope).is_zero()
                && run.attempts.iter().any(|a| a.phase == "pending")
            {
                continue;
            }
            let ready_at = now();
            let ready = self.dispatchable(&run, ready_at).await?;
            if ready.is_empty() {
                self.close_if_nothing_is_left(&run, flying == 0, ready_at)
                    .await?;
                continue;
            }
            queues.push((run, ready.into_iter()));
        }
        // An older workflow waiting for several accounts keeps its place
        // on each of them. Disjoint accounts can still make progress.
        let mut waiting_accounts = std::collections::BTreeSet::new();
        loop {
            let mut started = false;
            for (run, ready) in &mut queues {
                for (a, version) in ready.by_ref() {
                    if !admission_window::remaining(&scope).is_zero() {
                        return Ok(());
                    }
                    // A tick lasts while anything of any run flies. A cell put
                    // back with a wait starts again once it has waited it out;
                    // one put straight back waits for the next tick.
                    let resources_released =
                        resource_waiting(&a) && admission_window::remaining(&scope).is_zero();
                    if tried.contains(&a.id)
                        && !resources_released
                        && a.wait_until.is_none_or(|until| until > now())
                    {
                        continue;
                    }
                    if self
                        .start(run, a, version, flights, tried, &mut waiting_accounts)
                        .await?
                    {
                        started = true;
                        break;
                    }
                }
            }
            if !started {
                return Ok(());
            }
        }
    }

    /// Ends a cancelled run once nothing of it flies: its pending cells settle
    /// as cancelled, and a sealed answer awaiting judges keeps its output and
    /// only lacks its verdict.
    async fn finish_cancelling(&self, run: BenchmarkRun) -> Result<()> {
        for mut a in run.attempts {
            if a.phase == "pending" {
                a.phase = "terminal".into();
                a.outcome = Some("cancelled".into());
                a.finished_at = Some(now());
                self.store.save_attempt(&a).await?;
            } else if a.phase == AWAITING_JUDGES {
                let mut waiting = self.store.attempt(&a.id).await?;
                waiting.phase = "terminal".into();
                waiting.reason = Some(JUDGING_STOPPED.into());
                self.store.save_attempt(&waiting).await?;
            }
        }
        self.store.set_run_state(&run.id, "cancelled").await?;
        self.changed().await;
        Ok(())
    }

    /// Closes a run with nothing ready when nothing of it flies, waits for
    /// judges or is held: for its provider, for a time of its own, or
    /// interrupted. Cells left for the operator, or an unusable panel that
    /// stopped judging, have not completed the measurement: the run then
    /// waits for the operator with its paid answers kept.
    async fn close_if_nothing_is_left(
        &self,
        run: &BenchmarkRun,
        grounded: bool,
        ready_at: i64,
    ) -> Result<()> {
        let waiting = run.attempts.iter().any(|a| a.phase == AWAITING_JUDGES);
        // A cell left for the operator goes nowhere by itself, so no wait of
        // its own keeps the run open.
        let left = |a: &Attempt| a.phase == "pending" && left_for_operator(a);
        let held = run.attempts.iter().any(|a| {
            (a.phase == "pending"
                && !left(a)
                && (provider_held(&run.id, &a.configuration.provider_id)
                    || provider_held(&run.id, &quota_scope(&a.configuration))
                    || a.wait_until.is_some_and(|until| until > ready_at)))
                || a.phase == "interrupted"
        });
        if !grounded || waiting || held {
            return Ok(());
        }
        let needs_operator = run.attempts.iter().any(|a| {
            left(a)
                || (a.outcome.as_deref() == Some("pending_review")
                    && a.reason.is_some()
                    && crate::services::benchmarks::analysis::score(a).is_none())
        });
        if needs_operator {
            self.stop_for_operator(&run.id, Stop::NothingCanGoOn)
                .await?;
        } else {
            self.store.set_run_state(&run.id, "completed").await?;
        }
        self.changed().await;
        Ok(())
    }

    /// Starts `a` if its configuration, account and the app have a free slot.
    pub(in super::super) async fn start(
        self: &Arc<Self>,
        run: &BenchmarkRun,
        mut a: Attempt,
        version: Arc<BenchmarkVersion>,
        flights: &mut tokio::task::JoinSet<()>,
        tried: &mut std::collections::HashSet<String>,
        waiting_accounts: &mut std::collections::BTreeSet<String>,
    ) -> Result<bool> {
        if self.refuses_replay(run, &mut a).await? {
            return Ok(false);
        }
        self.hand_to_an_account_with_room(run, &mut a).await;
        // A configuration flies as many attempts as its run was admitted
        // with, within its account's and the app's slots.
        let concurrency = if a.configuration.execution_profile == "workflow_policy" {
            self.store
                .workflow_campaign_concurrency(&run.request.request_key)
                .await?
        } else {
            crate::services::benchmarks::workflow_campaign::CampaignConcurrency::SERIAL
        };
        let concurrent_workflow = concurrency.concurrent();
        let lane = if concurrent_workflow {
            format!("workflow-root:{}", a.id)
        } else {
            crate::services::benchmarks::analysis::configuration_key(&a.configuration)
        };
        let provider = &a.configuration.provider_id;
        let account = if concurrent_workflow {
            String::new()
        } else {
            format!(
                "{provider}\u{1f}{}",
                a.configuration.account_id.as_deref().unwrap_or_default()
            )
        };
        let id = a.id.clone();
        let seat = Seat {
            id: &id,
            lane: &lane,
            lane_slots: attempts_at_once(&run.request, &a.configuration) as usize,
            account: &account,
            account_slots: account_slots(
                &run.id,
                &quota_scope(&a.configuration),
                &pace_key(&self.store, &account),
            ),
            model: &a.configuration.model_id,
            model_slots: model_slots(
                &run.id,
                &quota_scope(&a.configuration),
                &pace_key(&self.store, &account),
                &a.configuration.model_id,
            ),
        };
        // A v3 root holds every worker its policy may select for the whole
        // trajectory. A v4 root holds none here: each step takes its decided
        // worker in `acquire_step_worker` and gives it back when it ends.
        let reserve_workers = concurrent_workflow
            && concurrency.admission
                == crate::services::benchmarks::workflow_campaign::WorkerAdmission::ReservedPool;
        let workers = if reserve_workers {
            Self::policy_workers(run, &concurrency)?
        } else {
            Vec::new()
        };
        let accounts: Vec<_> = workers
            .iter()
            .map(|worker| worker.account.clone())
            .collect();
        if accounts
            .iter()
            .any(|account| waiting_accounts.contains(account))
        {
            waiting_accounts.extend(accounts);
            return Ok(false);
        }
        // A cell without a free seat waits without probing the host: a fill
        // passes every pending cell, and most of them wait for a seat. An
        // ordinary cell also waits while the attempts already in preparation
        // fill the window the sandbox's recent answers allow.
        let prepares = self.backend.paces_preparation()
            && version.manifest.workflow.is_none()
            && a.configuration.execution_profile != "workflow_policy";
        let scope = self.store.root.display().to_string();
        if !self.has_room(&seat, &workers).await || !admission_window::has_room(&scope) {
            waiting_accounts.extend(accounts);
            return Ok(false);
        }
        // Reserve before the host probe so a full queue is asked by one
        // candidate after the shared wait, never by every pending cell. Its
        // place in the window ends with the flight that owns it, however that
        // flight ends, or here on any return before the flight starts.
        let Some(preparing) = admission_window::begin(&scope, &id) else {
            waiting_accounts.extend(accounts);
            return Ok(false);
        };
        if !self.host_admits(&a, &scope).await? {
            return Ok(false);
        }
        let Some(cancel_rx) = self.claim_workers(&run.id, seat, workers).await else {
            waiting_accounts.extend(accounts);
            return Ok(false);
        };
        if !account.is_empty() {
            self.record_account_load(run, &mut a, &account).await;
        }
        if let Err(error) =
            fixtures::verify_blob(&self.store.root, &version.content_hash, &version.manifest).await
        {
            self.release(&id).await;
            return Err(error);
        }
        // Judges run only where the saved plan reserved their calls; known
        // before the paid turn.
        let judge_budget = self.judge_budget(run, &version).await;
        tried.insert(a.id.clone());
        if !self.mark_preparing(run, &mut a).await? {
            return Ok(false);
        }
        // Tell the app the attempt started, so a run's view shows which test
        // runs now and since when, not only which ones finished.
        self.changed().await;
        let (service, run) = (self.clone(), run.clone());
        if !prepares {
            admission_window::admitted(&scope, &id);
        }
        flights.spawn(async move {
            let _preparing = preparing;
            let result = AssertUnwindSafe(service.run_attempt(
                &run,
                a,
                Arc::unwrap_or_clone(version),
                judge_budget,
                cancel_rx,
            ))
            .catch_unwind()
            .await;
            service.finish_flight(&id, &id, result).await;
        });
        Ok(true)
    }

    /// A run that forbids retries never replays an attempt that had started:
    /// the attempt settles as an uncertain dispatch, a cell the run lost.
    /// Whether it did.
    async fn refuses_replay(&self, run: &BenchmarkRun, a: &mut Attempt) -> Result<bool> {
        if run.request.automatic_retry()
            || !(a.started_at.is_some()
                || a.session_id.is_some()
                || a.host_run_id.is_some()
                || !a.workflow_steps.is_empty())
        {
            return Ok(false);
        }
        a.phase = "terminal".into();
        a.outcome = Some("dispatch_uncertain".into());
        a.reason = Some("This run forbids replay of a previously started attempt".into());
        a.finished_at = Some(now());
        self.store.save_attempt(a).await?;
        self.cell_lost(run, &quota_scope(&a.configuration)).await?;
        Ok(true)
    }

    /// An account whose limit ran out under this run hands its tests to
    /// another account of the provider that has room.
    async fn hand_to_an_account_with_room(&self, run: &BenchmarkRun, a: &mut Attempt) {
        if !run.request.automatic_retry() {
            return;
        }
        let Some(account) = a.configuration.account_id.clone() else {
            return;
        };
        if exhausted(&run.id, &account) {
            if let Some(other) = self.room_elsewhere(&run.id, &a.configuration).await {
                a.configuration.account_id = Some(other);
            }
        }
    }

    /// The workers a workflow root reserves for its whole trajectory: every
    /// candidate its policy may select.
    fn policy_workers(
        run: &BenchmarkRun,
        concurrency: &crate::services::benchmarks::workflow_campaign::CampaignConcurrency,
    ) -> Result<Vec<WorkerReservation>> {
        let policy = run.request.workflow_policy.as_ref().ok_or_else(|| {
            BenchmarkError::new(
                "invalid_workflow_policy",
                "Workflow worker policy is absent",
            )
        })?;
        let mut worker_request = run.request.clone();
        worker_request.parallelism = Some(concurrency.lane_parallelism());
        let workers: Vec<_> = policy
            .candidates
            .iter()
            .filter(|candidate| {
                policy.mode != "fixed"
                    || policy.fixed_candidate_id.as_deref() == Some(candidate.id.as_str())
            })
            .map(|candidate| WorkerReservation {
                lane: crate::services::benchmarks::analysis::configuration_key(candidate),
                account: format!(
                    "{}\u{1f}{}",
                    candidate.provider_id,
                    candidate.account_id.as_deref().unwrap_or_default()
                ),
                lane_slots: attempts_at_once(&worker_request, candidate) as usize,
                account_slots: account_slots_within(
                    &run.id,
                    &quota_scope(candidate),
                    concurrency.account_slots,
                ),
            })
            .collect();
        if workers.is_empty() {
            return Err(BenchmarkError::new(
                "invalid_workflow_policy",
                "Workflow has no reservable worker",
            ));
        }
        Ok(workers)
    }

    /// Asks the host whether `a` may start now. A refusal for room parks the
    /// queue and leaves its reason and the next ask on the stored cell,
    /// without an account handoff that only its start makes; every other
    /// cell stays quietly queued.
    async fn host_admits(&self, a: &Attempt, scope: &str) -> Result<bool> {
        let Err(error) = self.backend.resource_admission(&a.configuration).await else {
            return Ok(true);
        };
        let error = diagnostics::record(
            &self.store,
            a,
            "candidate_admission",
            error,
            None,
            json!({"retryAfterMs": admission_window::RETRY.as_millis() as u64, "dispatched": false}),
        )
        .await;
        if error.code != "resource_busy" {
            return Err(error);
        }
        admission_window::refused(scope, &a.id);
        let mut waiting = self.store.attempt(&a.id).await?;
        waiting.reason = Some(format!("Waiting for local resources: {}", error.message));
        waiting.wait_until = Some(now() + admission_window::RETRY.as_millis() as i64);
        self.store.save_attempt(&waiting).await?;
        self.changed().await;
        Ok(false)
    }

    /// Notes how loaded `account` is as the attempt starts on it. The account
    /// flies a turn from now: a restart measures its pace's staleness from
    /// here even before the turn ends.
    async fn record_account_load(&self, run: &BenchmarkRun, a: &mut Attempt, account: &str) {
        let turns = self
            .active
            .lock()
            .await
            .values()
            .filter(|flight| flight.uses_account(account))
            .count();
        a.account_load = Some(AccountLoad {
            turns: u32::try_from(turns).unwrap_or(u32::MAX),
            limit: u32::try_from(account_slots(
                &run.id,
                &quota_scope(&a.configuration),
                &pace_key(&self.store, account),
            ))
            .unwrap_or(u32::MAX),
        });
        account_pace::record_flight(&pace_key(&self.store, account), now());
    }

    /// Saves `a` as preparing, and whether its flight may go. The claim holds
    /// a lane, account and model seat: a store failure from here on, or a
    /// run that stopped meanwhile, releases it, and the cell waits again
    /// instead of reading as preparing with no flight until a restart.
    async fn mark_preparing(&self, run: &BenchmarkRun, a: &mut Attempt) -> Result<bool> {
        a.phase = "preparing".into();
        a.started_at = Some(now());
        if a.reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("Waiting for local resources"))
        {
            a.reason = None;
        }
        // A wait ends when its cell starts; only a new one lets it start
        // again within this tick.
        a.wait_until = None;
        if let Err(error) = self.store.save_attempt(a).await {
            self.release(&a.id).await;
            return Err(error);
        }
        let state = self.store.run_state(&run.id).await;
        if state.as_deref().is_ok_and(|state| state == "running") {
            return Ok(true);
        }
        a.phase = "pending".into();
        a.started_at = None;
        let saved = self.store.save_attempt(a).await;
        self.release(&a.id).await;
        // A state that could not be read is the failure to report; the save
        // of the waiting cell was then best effort.
        state?;
        saved?;
        Ok(false)
    }

    /// The pending attempts ready to dispatch. In a run admitted before author
    /// cells were measured, a pending cell whose candidate authored the case
    /// settles as excluded here, without any model call. A cell whose
    /// provider is held (see [`hold_provider_until`]) waits, one left for
    /// the operator (see [`leave_for_operator`]) stays, and nothing starts
    /// once the run's window closed.
    pub(in super::super) async fn dispatchable(
        &self,
        run: &BenchmarkRun,
        at: i64,
    ) -> Result<Vec<(Attempt, Arc<BenchmarkVersion>)>> {
        let mut ready = Vec::new();
        if at >= crate::services::benchmarks::analysis::window_closes(run)
            && !self
                .store
                .workflow_campaign_owns(&run.request.request_key)
                .await?
        {
            return Ok(ready);
        }
        let mut versions: std::collections::HashMap<String, Arc<BenchmarkVersion>> =
            std::collections::HashMap::new();
        for pending in run.attempts.iter().filter(|a| {
            a.phase == "pending"
                && !provider_held(&run.id, &a.configuration.provider_id)
                && !provider_held(&run.id, &quota_scope(&a.configuration))
                && !left_for_operator(a)
                && !pending_waiting(a, &self.store.root.display().to_string(), at)
        }) {
            if !versions.contains_key(&pending.version_id) {
                let version = self.store.version_shared(&pending.version_id).await?;
                versions.insert(pending.version_id.clone(), version);
            }
            let version = &versions[&pending.version_id];
            // A cell of a case its candidate wrote is settled here unsent.
            let authored = !run.request.measures_author_cells()
                && crate::services::benchmarks::routing::authored_by_candidate(
                    &version.manifest,
                    &pending.configuration,
                );
            if !authored {
                ready.push((pending.clone(), version.clone()));
                continue;
            }
            let mut excluded = pending.clone();
            excluded.phase = "terminal".into();
            excluded.outcome = Some("excluded".into());
            excluded.reason = Some("authored by this candidate".into());
            excluded.finished_at = Some(now());
            self.store.save_attempt(&excluded).await?;
            self.changed().await;
        }
        Ok(grouped_by_cell(run, ready))
    }
}

/// Restores, once per store after a restart, the waits the cells saved: the
/// longest wait for local resources parks the preparation lane again, the
/// longest wait of a check its own lane.
fn restore_saved_waits(runs: &[BenchmarkRun], scope: &str) {
    let saved_wait = runs
        .iter()
        .flat_map(|run| &run.attempts)
        .filter(|a| {
            matches!(a.phase.as_str(), "pending" | AWAITING_JUDGES)
                && a.reason.as_deref().is_some_and(|reason| {
                    reason.starts_with("Waiting for local resources")
                        && !reason.starts_with(EVALUATION_WAIT)
                })
        })
        .filter_map(|a| a.wait_until)
        .max()
        .unwrap_or_default()
        .saturating_sub(now())
        .max(0) as u64;
    admission_window::restore(scope, Duration::from_millis(saved_wait));
    let evaluation_wait = runs
        .iter()
        .flat_map(|run| &run.attempts)
        .filter(|attempt| {
            matches!(attempt.phase.as_str(), "collecting" | "interrupted")
                && attempt
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.starts_with(EVALUATION_WAIT))
        })
        .filter_map(|attempt| attempt.wait_until)
        .max()
        .unwrap_or_default()
        .saturating_sub(now())
        .max(0) as u64;
    admission_window::restore(
        &admission_window::evaluation_scope(scope),
        Duration::from_millis(evaluation_wait),
    );
}

/// The answer of `run` whose panel may be asked now, the one that waited
/// longest for it. A refused panel must not monopolize every resource probe:
/// answers are ordered by their last opportunity, or by when an untried one
/// became ready, so fresh arrivals cannot starve older work.
fn ready_judge(
    run: &BenchmarkRun,
    scope: &str,
    tried: &std::collections::HashSet<String>,
) -> Option<String> {
    run.attempts
        .iter()
        .filter(|a| {
            a.phase == AWAITING_JUDGES
                && admission_window::has_room(scope)
                && (judge_discovery_waiting(a)
                    || a.wait_until.is_none_or(|until| until <= now()))
                // Temporary waits must resume within a long tick.
                // Busy accounts/renderers have a bounded retry time;
                // preparation waits follow the shared window instead.
                && (!tried.contains(&a.id)
                    || a.wait_until.is_some()
                    || judging_deferred(a))
        })
        .min_by_key(|a| {
            a.phase_times
                .as_ref()
                .and_then(|times| times.get("judgeStarted"))
                .copied()
                .or(a.finished_at)
                .or(a.started_at)
                .unwrap_or_default()
        })
        .map(|a| a.id.clone())
}
