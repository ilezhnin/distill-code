//! Seats: what flies, how many may at once, and who waits for a seat.
use super::*;

/// The error code a judge whose account turned busy answers with.
pub(in super::super) const ACCOUNT_BUSY: &str = "account_busy";

/// Attempts in flight at once on one account when its pace starts (see
/// [`account_pace`]), which then grows and shrinks with what the provider
/// shows. No number bounds the attempts across the app: the sandbox admits
/// what fits, and [`admission_window`] paces how many it is asked for at once.
pub(in crate::services::benchmarks) const ACCOUNT_SLOTS: usize = 4;

/// The parallelism a new run records: as many attempts of a configuration
/// at once as its account's pace and the sandbox admit. A stream's tokens per
/// second do not depend on how many we send; what parallelism spends is the
/// account's rate limit, which the pace follows. An operator may still set a
/// number, which then bounds the configuration; saved runs without one fly
/// one at a time.
pub const AS_ADMITTED: u32 = 0;

/// An attempt or a judge panel in flight, keyed in `BenchmarkService::active`
/// by the attempt (or, for a panel, its run's panel lane): its run, the lane
/// it shares with its configuration's other attempts, its account and the
/// signal that cancels it.
pub struct Flight {
    pub run_id: String,
    pub lane: String,
    pub account: String,
    /// Held for the whole workflow, including preparation between steps.
    pub workers: Vec<WorkerReservation>,
    pub cancel: watch::Sender<bool>,
    /// A finished turn whose sealed answer is being checked. It holds neither
    /// its lane nor its account any more (see `release_turn_seat`), only its
    /// place among the run's and the app's flights.
    pub checking: bool,
    /// How many attempts its lane flies at once, as claimed.
    pub lane_slots: usize,
    /// The model its turn asks for ("" for a panel), counted against the
    /// model's ceiling on its account (see `account_pace`).
    pub model: String,
}

#[derive(Clone)]
pub struct WorkerReservation {
    pub(in super::super) lane: String,
    pub(in super::super) account: String,
    pub(in super::super) lane_slots: usize,
    pub(in super::super) account_slots: usize,
}

impl Flight {
    pub(in super::super) fn uses_account(&self, account: &str) -> bool {
        !self.checking
            && !account.is_empty()
            && (self.account == account || self.workers.iter().any(|w| w.account == account))
    }
    pub(in super::super) fn uses_lane(&self, lane: &str) -> bool {
        !self.checking && (self.lane == lane || self.workers.iter().any(|w| w.lane == lane))
    }
    pub(in super::super) fn uses_model(&self, account: &str, model: &str) -> bool {
        !model.is_empty() && self.model == model && self.uses_account(account)
    }
}

/// Where a flight would sit: its key in `BenchmarkService::active`, its lane
/// and how many of the lane may fly at once, its account and how many of
/// the account may, and its model and how many of that model the account
/// may fly while the provider's ceiling for it stands.
pub(in super::super) struct Seat<'a> {
    pub(in super::super) id: &'a str,
    pub(in super::super) lane: &'a str,
    pub(in super::super) lane_slots: usize,
    pub(in super::super) account: &'a str,
    pub(in super::super) account_slots: usize,
    pub(in super::super) model: &'a str,
    pub(in super::super) model_slots: usize,
}

/// Every sandbox attempt owns an independent bridge. Resource admission and
/// the account's limits separately constrain requested concurrency.
pub(in crate::services::benchmarks) fn attempts_at_once(
    request: &RunRequest,
    _configuration: &Configuration,
) -> u32 {
    match request.parallelism {
        Some(AS_ADMITTED) => u32::MAX,
        Some(parallelism) => parallelism,
        None => 1,
    }
}

/// Whether a finished turn's check may run after its seat is handed on: an
/// objectively checked text or repository answer, sealed with its sandbox
/// cleaned, whose check needs neither the lane nor the account. The check is
/// its own admitted sandbox job, whose CPU weight puts it ahead of the
/// sessions that start beside it. A planning lab keeps its seat: its checks
/// time planners on budgets of seconds, so the next session of its
/// configuration never runs beside them. A judged rendering keeps it too, so
/// its panel finds the accounts as before.
pub(in super::super) fn checks_without_its_seat(
    attempt: &Attempt,
    version: &BenchmarkVersion,
) -> bool {
    matches!(
        attempt.configuration.execution_profile.as_str(),
        "native_text" | "protected_repository"
    ) && attempt.outcome.as_deref() == Some("completed")
        && attempt.evidence_hash.is_some()
        && version.manifest.workflow.is_none()
        && version.manifest.evaluator.kind != "rubric"
        && version.manifest.work_class_id != "planning"
}

pub(in super::super) fn resource_waiting(attempt: &Attempt) -> bool {
    attempt.wait_until.is_some_and(|until| until > now())
        && attempt
            .reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("Waiting for local resources:"))
}

/// A persisted queue wait survives ticks and process restarts. Only a local
/// resource refusal may wake early when a finished job releases capacity.
pub(in super::super) fn pending_waiting(attempt: &Attempt, scope: &str, at: i64) -> bool {
    attempt.wait_until.is_some_and(|until| until > at)
        && (!attempt
            .reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("Waiting for local resources:"))
            || !admission_window::remaining(scope).is_zero())
}

/// How many attempts of `run_id` fly at once on `account` (its provider and
/// id, as a seat names it): one while the run waits out that account's usage
/// limit (`scope`, see [`quota_scope`]), so a single turn finds out whether
/// the limit reset, else what the account's pace allows (see [`account_pace`]).
pub(in super::super) fn account_slots(run_id: &str, scope: &str, account: &str) -> usize {
    account_slots_within(run_id, scope, account_pace::limit(account))
}

/// How many turns of `model` that run flies at once on `account`: its
/// account's, below the model's standing ceiling (see [`account_pace`]).
pub(in super::super) fn model_slots(
    run_id: &str,
    scope: &str,
    account: &str,
    model: &str,
) -> usize {
    account_slots_within(run_id, scope, account_pace::limit_for(account, model))
}

/// [`account_slots`] under a campaign's own frozen per-account bound.
pub(in crate::services::benchmarks) fn account_slots_within(
    run_id: &str,
    scope: &str,
    configured: usize,
) -> usize {
    if quota_waiting(run_id, scope) {
        1
    } else {
        configured
    }
}

/// Steps of admitted roots waiting for their selected worker's slot under the
/// step-admission recipe, served oldest root first. Kept in memory beside the
/// flights they wait for, scoped to the store they belong to; a waiter whose
/// root no longer flies is ignored, and a dropped wait removes itself.
pub(in super::super) static STEP_WAITERS: std::sync::LazyLock<std::sync::Mutex<Vec<StepWaiter>>> =
    std::sync::LazyLock::new(Default::default);

#[derive(Clone, PartialEq, Eq)]
pub(in super::super) struct StepWaiter {
    /// The store root the root's service runs on.
    pub(in super::super) scope: String,
    pub(in super::super) root_started_at: i64,
    /// The root's campaign cell index: admission order when two roots were
    /// admitted within the same millisecond.
    pub(in super::super) order: u64,
    pub(in super::super) root_id: String,
    pub(in super::super) account: String,
}

/// Registers a waiter for as long as it is held; dropping it, by a finished
/// wait or a cancelled future, takes the waiter out of the queue.
pub(in super::super) struct Waiting(StepWaiter);

impl Waiting {
    pub(in super::super) fn new(waiter: StepWaiter) -> Self {
        STEP_WAITERS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(waiter.clone());
        Self(waiter)
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        STEP_WAITERS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|waiter| waiter != &self.0);
    }
}

/// A campaign child's cell index from its request key, else zero.
pub(in super::super) fn cell_order(request_key: &str) -> u64 {
    request_key
        .rsplit(':')
        .next()
        .and_then(|index| index.parse().ok())
        .unwrap_or(0)
}

/// Whether `seat` (and every worker a v3 root reserves with it) fits beside
/// the flights in `active`: below its lane's and its account's limits, and
/// not flying already.
pub(in super::super) fn room(
    active: &std::collections::HashMap<String, Flight>,
    seat: &Seat<'_>,
    workers: &[WorkerReservation],
) -> bool {
    let on = |used: &dyn Fn(&Flight) -> bool| active.values().filter(|f| used(f)).count();
    !active.contains_key(seat.id)
        && on(&|flight| flight.uses_lane(seat.lane)) < seat.lane_slots
        && on(&|flight| flight.uses_account(seat.account)) < seat.account_slots
        && on(&|flight| flight.uses_model(seat.account, seat.model)) < seat.model_slots
        && workers.iter().all(|worker| {
            on(&|flight| flight.uses_lane(&worker.lane)) < worker.lane_slots
                && on(&|flight| flight.uses_account(&worker.account)) < worker.account_slots
        })
}

/// The ready attempts in dispatch order: a case's repetitions go out
/// together, at the place of its first one in the plan, and a case already
/// begun goes first, so a run stopped early leaves whole cases rather than
/// one or two repetitions of many. The order of cases stays the plan's.
pub(in super::super) fn grouped_by_cell<V>(
    run: &BenchmarkRun,
    ready: Vec<(Attempt, V)>,
) -> Vec<(Attempt, V)> {
    let cell = |a: &Attempt| {
        (
            a.version_id.clone(),
            crate::services::benchmarks::analysis::leaderboard_key(&a.configuration),
        )
    };
    let begun: std::collections::HashSet<_> = run
        .attempts
        .iter()
        .filter(|a| {
            a.started_at.is_some() && !crate::services::benchmarks::analysis::is_superseded(a)
        })
        .map(cell)
        .collect();
    let mut first: std::collections::HashMap<_, usize> = std::collections::HashMap::new();
    for (index, (a, _)) in ready.iter().enumerate() {
        first.entry(cell(a)).or_insert(index);
    }
    let mut ready = ready;
    ready.sort_by_key(|(a, _)| {
        let key = cell(a);
        (!begun.contains(&key), first[&key], a.repetition)
    });
    ready
}

impl BenchmarkService {
    /// Whether [`Self::claim_workers`] would take `seat` now, without taking it.
    pub(in super::super) async fn has_room(
        &self,
        seat: &Seat<'_>,
        workers: &[WorkerReservation],
    ) -> bool {
        room(&*self.active.lock().await, seat, workers)
    }

    /// Attempts and panels of `run_id` in flight.
    pub(in super::super) async fn flying(&self, run_id: &str) -> usize {
        self.active
            .lock()
            .await
            .values()
            .filter(|flight| flight.run_id == run_id)
            .count()
    }

    /// Takes `seat` if it is free: its lane and its account below their
    /// limits. Returns its cancel signal.
    pub(in super::super) async fn claim(
        &self,
        run_id: &str,
        seat: Seat<'_>,
    ) -> Option<watch::Receiver<bool>> {
        self.claim_workers(run_id, seat, Vec::new()).await
    }

    pub(in super::super) async fn claim_workers(
        &self,
        run_id: &str,
        seat: Seat<'_>,
        workers: Vec<WorkerReservation>,
    ) -> Option<watch::Receiver<bool>> {
        let mut active = self.active.lock().await;
        if !room(&active, &seat, &workers) {
            return None;
        }
        let (cancel, signal) = watch::channel(false);
        active.insert(
            seat.id.to_owned(),
            Flight {
                run_id: run_id.to_owned(),
                lane: seat.lane.to_owned(),
                account: seat.account.to_owned(),
                workers,
                cancel,
                checking: false,
                lane_slots: seat.lane_slots,
                model: seat.model.to_owned(),
            },
        );
        Some(signal)
    }

    pub(in super::super) async fn release(&self, id: &str) {
        self.active.lock().await.remove(id);
        let scope = self.store.root.display().to_string();
        if admission_window::finished(&scope, id) {
            self.wake.notify_one();
        }
        admission_window::ended(&scope, id);
    }

    /// Every worker exit releases its seat. Unexpected failures preserve the
    /// latest saved evidence and require inspection, never an automatic replay.
    pub(in super::super) async fn finish_flight(
        &self,
        id: &str,
        seat: &str,
        result: std::thread::Result<Result<()>>,
    ) {
        let result = result.unwrap_or_else(|_| {
            Err(BenchmarkError::new(
                "infrastructure_failure",
                "Benchmark worker panicked; inspect the application log",
            ))
        });
        if let Err(error) = result {
            log::error!("[benchmarks] worker {id} stopped: {}", error.message);
            let recorded = async {
                let mut attempt = self.store.attempt(id).await?;
                if attempt.phase != "terminal" {
                    attempt.phase = "terminal".into();
                    // The last vote may already have landed before the worker
                    // failed. A completed measurement remains a measurement.
                    if crate::services::benchmarks::analysis::score(&attempt).is_none() {
                        let judging = attempt.outcome.as_deref() == Some("pending_review");
                        if !judging {
                            attempt.outcome = Some("infrastructure_failure".into());
                        }
                        attempt.reason = Some(format!(
                            "{}: {}",
                            if judging {
                                "Judging failed"
                            } else {
                                "Benchmark worker failed"
                            },
                            error.message
                        ));
                    }
                    attempt.wait_until = None;
                    attempt.finished_at.get_or_insert_with(now);
                    self.store.save_attempt(&attempt).await?;
                }
                Ok::<_, BenchmarkError>(())
            }
            .await;
            if let Err(error) = recorded {
                log::error!(
                    "[benchmarks] could not record worker failure for {id}: {}",
                    error.message
                );
            }
        }
        self.release(seat).await;
        let scope = self.store.root.display().to_string();
        let job = format!("judge:{id}");
        admission_window::finished(&scope, &job);
        admission_window::ended(&scope, &job);
        self.changed().await;
        // A final attempt keeps its turn in the sealed evidence; its chats go
        // now (see `session_retention`). One still owed judges keeps them.
        self.release_settled_sessions_logged(Some(id)).await;
    }

    /// Hands the lane and account of a finished turn to the next attempt of
    /// its configuration while its sealed answer is checked, so the run's
    /// checks no longer stand between its turns. A lane keeps at most as many
    /// checks waiting this way as it flies turns; past that, the turn keeps
    /// its seat until its verdict. True when the seat was handed on.
    pub(in super::super) async fn release_turn_seat(&self, id: &str) -> bool {
        let mut active = self.active.lock().await;
        let Some((lane, slots)) = active
            .get(id)
            .filter(|flight| !flight.checking && flight.workers.is_empty())
            .map(|flight| (flight.lane.clone(), flight.lane_slots))
        else {
            return false;
        };
        let checking = active
            .values()
            .filter(|flight| flight.checking && flight.lane == lane)
            .count();
        if checking >= slots {
            return false;
        }
        if let Some(flight) = active.get_mut(id) {
            flight.checking = true;
        }
        true
    }

    /// Takes the slot of the worker a step-admitted root decided on, holding
    /// it on the root's flight until [`Self::execute_workflow_policy_step`]
    /// gives it back. Waits while the worker's lane or account is full, oldest
    /// waiting root on that account first; the wait is returned for the
    /// step's record and stays out of the root's wall clock. Nothing is sent
    /// to a provider here.
    #[allow(clippy::too_many_arguments)]
    pub(in crate::services::benchmarks) async fn acquire_step_worker(
        &self,
        root_id: &str,
        run_id: &str,
        root_started_at: i64,
        configuration: &Configuration,
        request: &RunRequest,
        account_slots: usize,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<u64> {
        let mut request = request.clone();
        let concurrency = self
            .store
            .workflow_campaign_concurrency(&request.request_key)
            .await?;
        request.parallelism = Some(concurrency.lane_parallelism());
        let lane_slots = attempts_at_once(&request, configuration) as usize;
        let lane = crate::services::benchmarks::analysis::configuration_key(configuration);
        let account = format!(
            "{}\u{1f}{}",
            configuration.provider_id,
            configuration.account_id.as_deref().unwrap_or_default()
        );
        let me = StepWaiter {
            scope: self.store.root.to_string_lossy().into_owned(),
            root_started_at,
            order: cell_order(&request.request_key),
            root_id: root_id.to_owned(),
            account: account.clone(),
        };
        let _waiting = Waiting::new(me.clone());
        // Only a slot that was busy counts as waited: a free one costs the
        // root nothing and leaves its clock origin exactly at admission.
        let mut blocked_since: Option<i64> = None;
        loop {
            if *cancel.borrow()
                || matches!(
                    self.store.run_state(run_id).await?.as_str(),
                    "cancelling" | "cancelled"
                )
            {
                break Err(BenchmarkError::new(
                    "cancelled",
                    "Workflow cancelled while awaiting a worker slot",
                ));
            }
            if let Err(error) = request.require_dispatch_admission(now()) {
                break Err(error);
            }
            let mut active = self.active.lock().await;
            if !active.contains_key(root_id) {
                break Err(BenchmarkError::new(
                    "dispatch_uncertain",
                    "Workflow has no active root reservation",
                ));
            }
            // The oldest admitted root still flying that waits on this account
            // goes first; a waiter whose flight ended cannot hold anyone back.
            let first = STEP_WAITERS
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .filter(|waiter| {
                    waiter.scope == me.scope
                        && waiter.account == account
                        && active.contains_key(&waiter.root_id)
                })
                .min_by(|a, b| {
                    a.root_started_at
                        .cmp(&b.root_started_at)
                        .then_with(|| a.order.cmp(&b.order))
                        .then_with(|| a.root_id.cmp(&b.root_id))
                })
                .cloned();
            let others = || active.iter().filter(|(id, _)| id.as_str() != root_id);
            if first.as_ref() == Some(&me)
                && others()
                    .filter(|(_, flight)| flight.uses_lane(&lane))
                    .count()
                    < lane_slots
                && others()
                    .filter(|(_, flight)| flight.uses_account(&account))
                    .count()
                    < account_slots
            {
                let root = active.get_mut(root_id).expect("checked root flight");
                root.workers = vec![WorkerReservation {
                    lane: lane.clone(),
                    account: account.clone(),
                    lane_slots,
                    account_slots,
                }];
                break Ok(
                    blocked_since.map_or(0, |since| now().saturating_sub(since).max(0) as u64)
                );
            }
            drop(active);
            blocked_since.get_or_insert_with(now);
            tokio::select! {
                changed = cancel.changed() => {
                    if changed.is_err() {
                        break Err(BenchmarkError::new("cancelled", "Workflow worker reservation closed"));
                    }
                },
                _ = tokio::time::sleep(Duration::from_millis(50)) => {},
            }
        }
    }
}
