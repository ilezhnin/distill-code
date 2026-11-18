//! What a failed try means for its attempt and for its run: whether the try
//! counts, whether the cell goes back to the queue and for how long, whether
//! it is left for the operator, and what its end means for the run (see
//! [`stop`](super::stop)).
use super::*;

/// Tries of one attempt refused before any answer that go back to the queue
/// before the cell is left for the operator; one more after the operator's
/// resume settles the cell, as `refused_again` does under automatic retries.
const PRE_ANSWER_TRIES: u32 = 3;
/// How long a try refused before any answer waits before the next one.
const PRE_ANSWER_RETRY_MS: i64 = 5 * 60 * 1000;
/// What the reason of a cell refused before any answer starts with while it
/// waits for its next try; the refusal's own words follow. Left for the
/// operator, the cell keeps the bare refusal, so the same one after their
/// resume reads as `refused_again` and settles it.
pub(in super::super) const PRE_ANSWER_RETRIED: &str = "Refused before any answer; tried again.";

/// Refusals before any answer a cell goes back with before it is left for
/// the operator: a runtime the host would not start needs them at once.
fn pre_answer_limit(error: &BenchmarkError) -> u32 {
    if error.code == "capability_missing" {
        1
    } else {
        PRE_ANSWER_TRIES
    }
}

/// Whether one more refusal before any answer still goes back to the queue:
/// once the operator resumed a run stopped at the bound, the next refusal
/// settles the cell instead of cycling forever.
fn within_pre_answer_tries(attempt: &Attempt, error: &BenchmarkError) -> bool {
    error.code == "account_busy" || attempt.pre_answer_refusals < pre_answer_limit(error)
}

/// Whether a failed try ended before the provider answered anything, so
/// discarding it decides nothing about the attempt's outcome: the provider
/// acknowledged another model at session open, a runtime it would not start,
/// the host refused the prompt (or never dispatched it), or the account had
/// no free seat. Nothing was answered, paid for as output or
/// evaluated. A turn that started answering is outside this class.
pub(in crate::services::benchmarks) fn refused_before_answer(
    attempt: &Attempt,
    error: &BenchmarkError,
) -> bool {
    let host = serde_json::from_str::<Value>(&error.message).ok();
    let data = host
        .as_ref()
        .map(|e| e.get("data").unwrap_or(e).clone())
        .unwrap_or(Value::Null);
    let before_prompt = data["dispatchStarted"] == Value::Bool(false)
        || data["promptNotAccepted"] == Value::Bool(true);
    attempt.evaluations.is_empty()
        && attempt.output.as_deref().is_none_or(str::is_empty)
        && attempt.usage.output.unwrap_or(0) == 0
        && (error.code == "account_busy"
            || (attempt.phase == "preparing"
                && matches!(
                    error.code.as_str(),
                    "selection_changed" | "capability_missing" | SESSION_LOST
                ))
            || (error.code == "infrastructure_failure" && before_prompt))
}

/// A session the provider opened and lost before it acknowledged a model:
/// its bridge ended at open. Nothing was asked, so the try goes back to the
/// queue like a refusal before any answer, under the same bound.
pub(in crate::services::benchmarks) const SESSION_LOST: &str = "session_lost";
pub(in super::super) const SESSION_LOST_BEFORE_ANSWER: &str =
    "The provider's session ended before it acknowledged a model; nothing was asked of it";

/// Whether a turn that failed with `code`, while its attempt was saved in
/// `phase`, never reached the provider, so its cell goes back to the queue
/// instead of settling: a quota wait the host refused before any provider
/// call, a wait for the Grok CLI to renew its sign-in, and anything refused
/// while the attempt was still being prepared, before its prompt was
/// dispatched: a selection the provider would not make, or a runtime,
/// sign-in, preflight or policy the host would not start.
pub(in crate::services::benchmarks) fn returns_to_queue(code: &str, phase: &str) -> bool {
    is_wait(code)
        || (phase == "preparing"
            && matches!(
                code,
                "selection_changed" | "capability_missing" | SESSION_LOST
            ))
}

/// Whether `attempt`, as saved, shows that a provider saw any of its try: a
/// session, a dispatched turn, an acknowledged selection.
pub(in crate::services::benchmarks) fn reached_provider(attempt: &Attempt) -> bool {
    attempt.session_id.is_some() || attempt.host_run_id.is_some() || attempt.observed.is_some()
}

/// Whether `error` refused `attempt`, still saved as in preparation, before
/// any provider process started, so the try counts for nothing and the cell
/// waits in the queue. Only the trusted pre-spawn path reports
/// `resource_busy`: the local broker queued the admission, its window closed
/// in the queue, or the host gate's evidence expired. A sandbox sign-in
/// renewal's `sign_in_wait` comes before any session of the try as well.
/// Nothing of the attempt, nor of any workflow step it carries, may have
/// reached a provider. An attempt leaves preparation only once its session
/// exists, so this holds at every stage before the prompt: workflow step,
/// bridge start, admission.
pub(in crate::services::benchmarks) fn never_started(
    attempt: &Attempt,
    error: &BenchmarkError,
) -> bool {
    matches!(error.code.as_str(), "resource_busy" | SIGN_IN_WAIT)
        && attempt.phase == "preparing"
        && !reached_provider(attempt)
        && attempt
            .workflow_steps
            .iter()
            .all(|step| step.session_id.is_none() && step.host_run_id.is_none())
}

/// The reason of a unit settled as [`unstarted_timeout`], before the
/// clock's own message.
pub(in crate::services::benchmarks) const UNSTARTED_TIMEOUT: &str = "Infrastructure: the native root wall budget ran out before the session of the attempt or step that timed out started (no model time in it)";

/// The host's proof that a turn's budget ran out before any provider prompt.
pub(in crate::services::benchmarks) const NO_PROVIDER_START: &str =
    "native-owned-no-provider-start-v1";

/// Whether a `budget_timeout` settles `unit` (an attempt, a workflow root or
/// one of its steps) before any session of it started: no session, turn or
/// acknowledged selection, no native time, no sealed evidence, no session
/// opened, and no step of it that reached a provider or sealed evidence. The clock then
/// measured the host (a pause, the queue, a wait for a local slot), not the
/// model, so the unit is the infrastructure's, unscored, never a zero. It
/// settles and is never requeued, so an exhausted clock cannot loop; a run
/// that allows retries owes the cell again through a fresh attempt.
pub(in crate::services::benchmarks) fn unstarted_timeout(unit: &Attempt, code: &str) -> bool {
    code == "budget_timeout"
        && !reached_provider(unit)
        && unit.native_execution_ms.unwrap_or(0) == 0
        && unit.evidence_hash.is_none()
        && unit
            .phase_times
            .as_ref()
            .is_none_or(|times| !times.contains_key("sessionOpened"))
        && unit.workflow_steps.iter().all(|step| {
            step.session_id.is_none() && step.host_run_id.is_none() && step.evidence_hash.is_none()
        })
}

/// The outcome and reason `unit` settles with after `error`: its code and
/// message, or `infrastructure_failure` for a wall budget that ran out
/// before its session started (see [`unstarted_timeout`]).
pub(in crate::services::benchmarks) fn settled_failure(
    unit: &Attempt,
    error: &BenchmarkError,
) -> (String, String) {
    if unstarted_timeout(unit, &error.code) {
        (
            "infrastructure_failure".into(),
            format!("{UNSTARTED_TIMEOUT}: {}", error.message),
        )
    } else {
        (error.code.clone(), error.message.clone())
    }
}

/// Whether `code` holds its run until a time it already knows, rather than
/// asking the operator.
fn is_wait(code: &str) -> bool {
    matches!(code, QUOTA_WAIT | SIGN_IN_WAIT)
}

/// Whether `error` refuses `attempt`, as it was dispatched, for the very
/// reason an earlier refusal returned it to the queue with: the operator
/// resumed the run and nothing changed. Some refusals last as long as the run
/// (a Codex account whose model list is not cached, a Kimi home that cannot
/// be found, a profile changed since its probe); holding the run again would
/// refuse the same cell on every resume, so it settles with that outcome
/// instead, and the run goes on with its other cells. A quota wait and a
/// sign-in renewal wait always wait.
fn refused_again(attempt: &Attempt, error: &BenchmarkError) -> bool {
    !is_wait(&error.code) && attempt.reason.as_deref() == Some(error.message.as_str())
}

/// Puts `attempt` back in the queue with `reason`, without anything of the
/// try it discards: its phase times go with its claim, so a session that try
/// opened never counts as the next try's (see [`unstarted_timeout`]).
pub(in crate::services::benchmarks) fn requeue(attempt: &mut Attempt, reason: String) {
    attempt.phase = "pending".into();
    attempt.started_at = None;
    attempt.session_id = None;
    attempt.host_run_id = None;
    attempt.observed = None;
    attempt.event_cursor = 0;
    attempt.usage = TokenUsage::default();
    attempt.resolved_model = None;
    attempt.phase_times = None;
    attempt.reason = Some(reason);
    attempt.wait_until = None;
}

/// How the run answers a failed try that a provider saw, or that could not be
/// forgotten.
#[derive(Debug, PartialEq, Eq)]
enum Response {
    /// Refused before any answer under a run that forbids retries: the same
    /// attempt again after a pause, up to its bound. A busy account is waited
    /// out and never counts toward it.
    TryAgain { busy: bool },
    /// The account had no free seat: asked again shortly.
    WaitForSeat,
    /// A usage limit before anything of the turn was evaluated: another
    /// account with room where the run may move the test, else the reset the
    /// run can reach.
    WaitForQuota { may_move: bool },
    /// The Grok CLI renews the sign-in later.
    WaitForSignIn,
    /// Refused before the prompt under automatic retries: again after a
    /// pause, up to the bound, while the run goes on with its other cells.
    RetryRefusal,
    /// The try is the attempt's outcome.
    Settle(ForRun),
}

/// What a settled failure means for its run.
#[derive(Debug, PartialEq, Eq)]
enum ForRun {
    /// The cell's own: the run goes on.
    Nothing,
    /// The cell is lost to a cause that may be the run's: the run stops once
    /// as many in a row are as it affords (see [`lost_cells_limit`]).
    Lost,
    /// The run's own.
    Stop(Stop),
}

/// What the response is decided on, read from the try and its run.
struct Facts<'a> {
    code: &'a str,
    /// The run retries by itself and may still dispatch.
    retry_allowed: bool,
    /// The run's dispatch deadline has not passed.
    admission_open: bool,
    workflow: bool,
    /// Nothing of the turn was evaluated.
    unevaluated: bool,
    /// See [`refused_before_answer`].
    refused_before_answer: bool,
    /// See [`within_pre_answer_tries`].
    within_tries: bool,
    /// See [`returns_to_queue`].
    returns_to_queue: bool,
    /// See [`refused_again`].
    refused_again: bool,
}

/// Failures that lose a cell of a run that forbids retries, beside those
/// that would return to its queue.
const LOST_WITHOUT_RETRY: [&str; 4] = [
    "account_busy",
    "selection_changed",
    "validation",
    "evidence_mismatch",
];

/// What the failure that settles a cell means for its run: a store that
/// failed and a dispatch deadline that passed are the run's own, and an
/// uncertain dispatch loses the cell under every retry policy.
fn for_run(facts: &Facts) -> ForRun {
    match facts.code {
        "storage_unavailable" => ForRun::Stop(Stop::Storage),
        "dispatch_deadline" => ForRun::Stop(Stop::DispatchDeadline),
        "dispatch_uncertain" => ForRun::Lost,
        code if !facts.retry_allowed
            && (facts.returns_to_queue || LOST_WITHOUT_RETRY.contains(&code)) =>
        {
            ForRun::Lost
        }
        _ => ForRun::Nothing,
    }
}

/// The response to a failed try. A turn the provider never saw keeps its
/// cell: a quota wait holds it until the reset, a sign-in wait until the CLI
/// renews the sign-in, a refusal before the prompt goes again a few times.
/// The same refusal again after the operator resumed settles the cell.
fn respond(facts: &Facts) -> Response {
    if !facts.retry_allowed
        && !facts.workflow
        && facts.admission_open
        && facts.refused_before_answer
        && facts.within_tries
    {
        return Response::TryAgain {
            busy: facts.code == "account_busy",
        };
    }
    if facts.retry_allowed && facts.code == "account_busy" {
        return Response::WaitForSeat;
    }
    if facts.code == QUOTA_WAIT {
        // A run that forbids retries never moves the test to another
        // account, and settles a workflow root, whose committed steps it
        // never replays.
        if facts.unevaluated && facts.admission_open && (facts.retry_allowed || !facts.workflow) {
            return Response::WaitForQuota {
                may_move: facts.retry_allowed,
            };
        }
    } else if facts.retry_allowed && facts.returns_to_queue && !facts.refused_again {
        return if facts.code == SIGN_IN_WAIT {
            Response::WaitForSignIn
        } else {
            Response::RetryRefusal
        };
    }
    Response::Settle(for_run(facts))
}

/// A failed try with what it belongs to.
struct FailedTry<'a> {
    run: &'a BenchmarkRun,
    /// The attempt as it was dispatched.
    dispatched: &'a Attempt,
    version: &'a BenchmarkVersion,
    error: &'a BenchmarkError,
}

impl FailedTry<'_> {
    fn workflow(&self) -> bool {
        self.version.manifest.workflow.is_some()
    }
}

impl BenchmarkService {
    /// Settles the try of `a` that ended with `error`: back to the queue, on
    /// to another account, left for the operator, or settled with its
    /// outcome; and the run, where the failure is its own.
    pub(in super::super) async fn try_failed(
        &self,
        run: &BenchmarkRun,
        a: &Attempt,
        version: &BenchmarkVersion,
        error: BenchmarkError,
    ) -> Result<()> {
        let failed = self.store.attempt(&a.id).await?;
        let error = diagnostics::record(
            &self.store,
            &failed,
            "candidate_execution",
            error,
            None,
            json!({"sessionId": failed.session_id, "hostRunId": failed.host_run_id}),
        )
        .await;
        let failure = FailedTry {
            run,
            dispatched: a,
            version,
            error: &error,
        };
        let admission_open = run.request.require_dispatch_admission(now()).is_ok();
        // A try no provider saw counts for nothing under every retry policy,
        // research runs that forbid replay included: no paid execution is
        // retried, and the cell is neither an attempt nor a failure.
        if never_started(&failed, &error)
            && admission_open
            && self.forget_unstarted_try(&failed, version).await?
        {
            return self.wait_unstarted(&failure, failed).await;
        }
        let facts = Facts {
            code: &error.code,
            retry_allowed: run.request.automatic_retry() && admission_open,
            admission_open,
            workflow: failure.workflow(),
            unevaluated: failed.evaluations.is_empty(),
            refused_before_answer: refused_before_answer(&failed, &error),
            within_tries: within_pre_answer_tries(&failed, &error),
            returns_to_queue: returns_to_queue(&error.code, &failed.phase),
            refused_again: refused_again(a, &error),
        };
        match respond(&facts) {
            Response::TryAgain { busy } => self.try_again(&failure, failed, busy).await,
            Response::WaitForSeat => self.wait_for_seat(&failure, failed).await,
            Response::WaitForQuota { may_move } => {
                self.wait_for_quota(&failure, failed, may_move).await
            }
            Response::WaitForSignIn => self.wait_for_sign_in(&failure, failed).await,
            Response::RetryRefusal => self.retry_refusal(&failure, failed).await,
            Response::Settle(for_run) => self.settle_failed(&failure, failed, for_run).await,
        }
    }

    /// A cell refused before any answer stopped trying by itself: the run
    /// stops where the refusal is its own, else the cell is left for the
    /// operator and the run goes on. A runtime the host would not start (a
    /// sign-in near expiry, a refused preflight) refuses every cell of its
    /// account, so the account's cells are left with it.
    async fn stops_trying(&self, failure: &FailedTry<'_>, refused: &Attempt) -> Result<()> {
        let run = failure.run;
        if self.refused_from_the_start(&run.id, refused).await? {
            return self
                .stop_for_operator(&run.id, Stop::SelectionRefused)
                .await;
        }
        if failure.error.code == "capability_missing" {
            leave_for_operator(&run.id, &quota_scope(&failure.dispatched.configuration));
        } else {
            leave_for_operator(&run.id, &refused.id);
        }
        Ok(())
    }

    /// Puts the cell back in the queue with `reason`. A workflow root keeps
    /// its saved steps, their sessions and usage, and waits on an idle
    /// credit; a standalone attempt discards the try and its clock, so the
    /// next one is a new owner and key.
    async fn back_in_queue(
        &self,
        failure: &FailedTry<'_>,
        failed: &mut Attempt,
        reason: String,
    ) -> Result<()> {
        if failure.workflow() {
            failed.phase = "pending".into();
            failed.started_at = None;
            failed.reason = Some(reason);
            failed.wait_until = None;
            self.idle_root(failed).await
        } else {
            requeue(failed, reason);
            drop_collection_clock(&self.store, failed).await
        }
    }

    /// No provider process started: the cell waits for the sign-in or for
    /// room, and its next admission is its first.
    async fn wait_unstarted(&self, failure: &FailedTry<'_>, mut failed: Attempt) -> Result<()> {
        let error = failure.error;
        if error.code == SIGN_IN_WAIT {
            requeue(&mut failed, error.message.clone());
            failed.wait_until = Some(sign_in_retry(
                &failure.run.id,
                &failure.dispatched.configuration.provider_id,
            ));
        } else {
            // Refused for room at whatever stage (the host's preparation
            // queue, a copy, the Windows floors, the broker): the attempts
            // prepared next are paced as after any sandbox refusal.
            admission_window::refused(
                &self.store.root.display().to_string(),
                &failure.dispatched.id,
            );
            requeue(
                &mut failed,
                format!("Waiting for local resources: {}", error.message),
            );
            failed.wait_until = Some(now() + admission_window::RETRY.as_millis() as i64);
        }
        failed.workflow_steps.clear();
        if !failure.workflow() {
            drop_collection_clock(&self.store, &mut failed).await?;
        }
        // The flight's end tells the app, once.
        self.store.save_attempt(&failed).await
    }

    /// The same attempt goes again on the same account, and at its bound it
    /// stops trying by itself; the cell is never settled here.
    async fn try_again(
        &self,
        failure: &FailedTry<'_>,
        mut failed: Attempt,
        busy: bool,
    ) -> Result<()> {
        let error = failure.error;
        let tries = failed.pre_answer_refusals + u32::from(!busy);
        let done = !busy && tries >= pre_answer_limit(error);
        requeue(&mut failed, error.message.clone());
        failed.pre_answer_refusals = tries;
        drop_collection_clock(&self.store, &mut failed).await?;
        if !done {
            failed.reason = Some(format!("{PRE_ANSWER_RETRIED} {}", error.message));
            failed.wait_until = Some(
                now()
                    + if busy {
                        ACCOUNT_BUSY_RETRY_MS
                    } else {
                        PRE_ANSWER_RETRY_MS
                    },
            );
        }
        self.store.save_attempt(&failed).await?;
        if done {
            self.stops_trying(failure, &failed).await?;
        }
        self.changed().await;
        Ok(())
    }

    /// Asked again shortly, within this tick: a seat frees long before every
    /// other run's turns land.
    async fn wait_for_seat(&self, failure: &FailedTry<'_>, mut failed: Attempt) -> Result<()> {
        failed.phase = "pending".into();
        failed.started_at = None;
        if failure.workflow() {
            self.idle_root(&failed).await?;
        } else {
            drop_collection_clock(&self.store, &mut failed).await?;
        }
        failed.wait_until = Some(now() + ACCOUNT_BUSY_RETRY_MS);
        self.store.save_attempt(&failed).await
    }

    /// A limit that ran out on this account moves the test to another
    /// account of the provider with room, where the run may. Otherwise the
    /// unfinished turn is discarded and the run waits for a reset it can
    /// reach, or leaves the account's tests for the operator, with the
    /// reason on this one, and goes on with its other accounts.
    async fn wait_for_quota(
        &self,
        failure: &FailedTry<'_>,
        mut failed: Attempt,
        may_move: bool,
    ) -> Result<()> {
        let (run, error) = (failure.run, failure.error);
        let asked = &failure.dispatched.configuration;
        // A limit that names no reset waits until the reset the account's
        // last usage read shows, where it shows one.
        let message = if quota_reset(&error.message).is_none() {
            match self
                .backend
                .spent_until(
                    asked.account_id.as_deref().unwrap_or_default(),
                    &asked.model_id,
                )
                .await
            {
                Some(reset) => with_next_reset(&error.message, reset),
                None => error.message.clone(),
            }
        } else {
            error.message.clone()
        };
        if may_move {
            if let Some(account) = asked.account_id.as_deref() {
                // A refusal no reset lifts holds the account for as long as
                // the run would ever wait.
                let until = if refused_for_good(&message) {
                    now() + QUOTA_WAIT_LIMIT_MS
                } else {
                    quota_reset(&message).unwrap_or(now() + QUOTA_RETRY_MS)
                };
                exhaust(&run.id, account, until);
            }
            if let Some(other) = self.room_elsewhere(&run.id, asked).await {
                let reason = format!("{MOVED_ACCOUNT}. {}", error.message);
                self.back_in_queue(failure, &mut failed, reason).await?;
                failed.configuration.account_id = Some(other);
                // It goes on at once on the other account, within this
                // tick, while the spent one is held.
                failed.wait_until = Some(now());
                self.store.save_attempt(&failed).await?;
                self.changed().await;
                return Ok(());
            }
        }
        let plan = quota_plan(&run.id, &quota_scope(asked), &message, now());
        let reason = match plan {
            QuotaPlan::LeaveForOperator => {
                let stopped = if refused_for_good(&error.message) {
                    QUOTA_REFUSED
                } else {
                    QUOTA_STOPPED
                };
                format!("{stopped}. {}", error.message)
            }
            QuotaPlan::WaitUntil(_) => error.message.clone(),
        };
        self.back_in_queue(failure, &mut failed, reason).await?;
        if let QuotaPlan::WaitUntil(until) = plan {
            hold_provider_until(&run.id, &quota_scope(asked), until);
            failed.wait_until = Some(until);
        }
        self.store.save_attempt(&failed).await?;
        self.changed().await;
        Ok(())
    }

    /// The cell waits until the Grok CLI renews the sign-in.
    async fn wait_for_sign_in(&self, failure: &FailedTry<'_>, mut failed: Attempt) -> Result<()> {
        let reason = failure.error.message.clone();
        self.back_in_queue(failure, &mut failed, reason).await?;
        failed.wait_until = Some(sign_in_retry(
            &failure.run.id,
            &failure.dispatched.configuration.provider_id,
        ));
        self.store.save_attempt(&failed).await?;
        self.changed().await;
        Ok(())
    }

    /// A refusal before the prompt (a model the provider would not select, a
    /// session lost at open) is one try's until it repeats: the cell goes
    /// again after a pause. At its bound, at once for a runtime the host
    /// would not start or a workflow root (whose steps are not tried apart),
    /// and when the run's selection was refused from its start, it stops
    /// trying by itself, with the bare refusal on the cell.
    async fn retry_refusal(&self, failure: &FailedTry<'_>, mut failed: Attempt) -> Result<()> {
        let error = failure.error;
        self.back_in_queue(failure, &mut failed, error.message.clone())
            .await?;
        failed.pre_answer_refusals = failed.pre_answer_refusals.saturating_add(1);
        let done = failure.workflow()
            || failed.pre_answer_refusals >= pre_answer_limit(error)
            || self
                .refused_from_the_start(&failure.run.id, &failed)
                .await?;
        if !done {
            failed.reason = Some(format!("{PRE_ANSWER_RETRIED} {}", error.message));
            failed.wait_until = Some(now() + PRE_ANSWER_RETRY_MS);
        }
        self.store.save_attempt(&failed).await?;
        if done {
            self.stops_trying(failure, &failed).await?;
        }
        self.changed().await;
        Ok(())
    }

    /// The try is the attempt's outcome.
    async fn settle_failed(
        &self,
        failure: &FailedTry<'_>,
        mut failed: Attempt,
        for_run: ForRun,
    ) -> Result<()> {
        let (outcome, reason) = settled_failure(&failed, failure.error);
        failed.phase = "terminal".into();
        failed.outcome = Some(outcome);
        failed.reason = Some(reason);
        failed.finished_at = Some(now());
        self.store.save_attempt(&failed).await?;
        match for_run {
            ForRun::Nothing => Ok(()),
            ForRun::Lost => {
                let scope = quota_scope(&failure.dispatched.configuration);
                self.cell_lost(failure.run, &scope).await
            }
            ForRun::Stop(why) => self.stop_for_operator(&failure.run.id, why).await,
        }
    }

    /// Whether the refusal of `refused` before any answer reads as its run's
    /// own, not one try's: no attempt of the run on the same selection was
    /// ever dispatched, and `PRE_ANSWER_TRIES` of them were refused. A model
    /// the provider no longer offers refuses every session; trying each cell
    /// in turn would open hundreds of sessions before one cell reached its
    /// own bound.
    async fn refused_from_the_start(&self, run_id: &str, refused: &Attempt) -> Result<bool> {
        let asked = &refused.configuration;
        let mut cells = 1;
        for other in self.store.run(run_id).await?.attempts {
            let selection = &other.configuration;
            if other.id == refused.id
                || selection.provider_id != asked.provider_id
                || selection.model_id != asked.model_id
                || selection.effort != asked.effort
                || selection.fast_mode != asked.fast_mode
            {
                continue;
            }
            if other.host_run_id.is_some() {
                return Ok(false);
            }
            cells += u32::from(other.pre_answer_refusals > 0);
        }
        Ok(cells >= PRE_ANSWER_TRIES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;
    use std::sync::atomic::Ordering;

    /// A refusal before the prompt, under automatic retries, with everything
    /// else at rest.
    fn facts(code: &str) -> Facts<'_> {
        Facts {
            code,
            retry_allowed: true,
            admission_open: true,
            workflow: false,
            unevaluated: true,
            refused_before_answer: false,
            within_tries: true,
            returns_to_queue: false,
            refused_again: false,
        }
    }

    #[test]
    fn the_response_follows_what_the_try_was_and_what_the_run_allows() {
        // The cell's own, a cell the run lost, and the run's own.
        let own = || Response::Settle(ForRun::Nothing);
        let lost = || Response::Settle(ForRun::Lost);
        let stop = |why| Response::Settle(ForRun::Stop(why));
        // Under automatic retries.
        assert_eq!(respond(&facts("account_busy")), Response::WaitForSeat);
        assert_eq!(
            respond(&facts(QUOTA_WAIT)),
            Response::WaitForQuota { may_move: true }
        );
        let before_prompt = |code| Facts {
            returns_to_queue: true,
            refused_before_answer: true,
            ..facts(code)
        };
        assert_eq!(
            respond(&before_prompt("selection_changed")),
            Response::RetryRefusal
        );
        assert_eq!(
            respond(&before_prompt(SESSION_LOST)),
            Response::RetryRefusal
        );
        assert_eq!(
            respond(&before_prompt(SIGN_IN_WAIT)),
            Response::WaitForSignIn
        );
        // The same refusal after the operator resumed settles the cell, and
        // the run goes on.
        assert_eq!(
            respond(&Facts {
                refused_again: true,
                ..before_prompt("selection_changed")
            }),
            own()
        );
        // A turn that ran is its attempt's outcome. An uncertain dispatch
        // loses the cell, and a store that failed is the run's own.
        assert_eq!(respond(&facts("budget_timeout")), own());
        assert_eq!(respond(&facts("selection_changed")), own());
        assert_eq!(respond(&facts("dispatch_uncertain")), lost());
        assert_eq!(respond(&facts("storage_unavailable")), stop(Stop::Storage));
        // A limit after part of the turn was evaluated never discards it.
        assert_eq!(
            respond(&Facts {
                unevaluated: false,
                ..facts(QUOTA_WAIT)
            }),
            own()
        );

        // Under a run that forbids retries.
        let forbidden = |code| Facts {
            retry_allowed: false,
            ..facts(code)
        };
        let refused = |code| Facts {
            returns_to_queue: true,
            refused_before_answer: true,
            ..forbidden(code)
        };
        assert_eq!(
            respond(&refused("selection_changed")),
            Response::TryAgain { busy: false }
        );
        assert_eq!(
            respond(&Facts {
                refused_before_answer: true,
                ..forbidden("account_busy")
            }),
            Response::TryAgain { busy: true }
        );
        // Past its bound, a workflow root, or a deadline that passed: the
        // cell is lost.
        assert_eq!(
            respond(&Facts {
                within_tries: false,
                ..refused("selection_changed")
            }),
            lost()
        );
        assert_eq!(
            respond(&Facts {
                workflow: true,
                ..refused("selection_changed")
            }),
            lost()
        );
        assert_eq!(
            respond(&Facts {
                admission_open: false,
                ..refused("selection_changed")
            }),
            lost()
        );
        // It still waits for a usage reset, on the same account, unless the
        // attempt is a workflow root.
        assert_eq!(
            respond(&forbidden(QUOTA_WAIT)),
            Response::WaitForQuota { may_move: false }
        );
        assert_eq!(
            respond(&Facts {
                workflow: true,
                returns_to_queue: true,
                ..forbidden(QUOTA_WAIT)
            }),
            lost()
        );
        assert_eq!(
            respond(&Facts {
                returns_to_queue: true,
                ..forbidden(SIGN_IN_WAIT)
            }),
            lost()
        );
        // A turn that ran is the cell's own, a validation or evidence
        // failure loses it, and a dispatch deadline that passed is the
        // run's own.
        assert_eq!(respond(&forbidden("budget_timeout")), own());
        assert_eq!(respond(&forbidden("validation")), lost());
        assert_eq!(respond(&forbidden("evidence_mismatch")), lost());
        assert_eq!(
            respond(&forbidden("dispatch_deadline")),
            stop(Stop::DispatchDeadline)
        );
    }

    #[test]
    fn a_wall_budget_spent_before_the_session_started_is_the_infrastructures() {
        // 10-18: attempts that kept a clock through a pause, and campaign
        // steps that waited for a local slot, settled as budget_timeout with
        // no model time: false zeros on the boards and in fit data.
        let row = judge_row("sonnet");
        let attempt = crate::services::benchmarks::pending_attempt(
            "invented-run",
            "invented-version",
            &row,
            0,
        );
        let exhausted =
            BenchmarkError::new("budget_timeout", "Native root wall budget is exhausted");
        let (outcome, reason) = settled_failure(&attempt, &exhausted);
        assert_eq!(outcome, "infrastructure_failure");
        assert!(reason.starts_with(UNSTARTED_TIMEOUT), "{reason}");
        assert!(
            reason.ends_with("Native root wall budget is exhausted"),
            "{reason}"
        );
        // Anything of a model measured keeps the timeout: a session, native
        // time, sealed evidence, an opened session, a step that ran.
        let mut started = attempt.clone();
        started.session_id = Some("invented-session".into());
        let mut timed = attempt.clone();
        timed.native_execution_ms = Some(5);
        let mut sealed = attempt.clone();
        sealed.evidence_hash = Some("invented-evidence".into());
        let mut opened = attempt.clone();
        mark_phase(&mut opened, "sessionOpened");
        let step = |session: Option<&str>, evidence: Option<&str>| WorkflowStepEvidence {
            root_task_id: "invented-root".into(),
            step_id: "implement".into(),
            parent_step_id: None,
            entry_state_hash: "invented-entry".into(),
            attempt_id: "invented-step".into(),
            session_id: session.map(Into::into),
            host_run_id: None,
            evidence_hash: evidence.map(Into::into),
            outcome: None,
        };
        let mut prefix = attempt.clone();
        prefix
            .workflow_steps
            .push(step(None, Some("invented-evidence")));
        let mut ran = attempt.clone();
        ran.workflow_steps
            .push(step(Some("invented-session"), None));
        for unit in [started, timed, sealed, opened, prefix, ran] {
            assert_eq!(settled_failure(&unit, &exhausted).0, "budget_timeout");
        }
        // A root whose steps never started is the infrastructure's too.
        let mut unstarted_root = attempt.clone();
        unstarted_root.workflow_steps.push(step(None, None));
        assert_eq!(
            settled_failure(&unstarted_root, &exhausted).0,
            "infrastructure_failure"
        );
        // Other failures keep their code and message.
        let capped = BenchmarkError::new("budget_reached", "Answer cap");
        assert_eq!(
            settled_failure(&attempt, &capped),
            ("budget_reached".into(), "Answer cap".into())
        );
        // The host's proof that the deadline passed before any provider
        // prompt, at either place a turn error carries it.
        assert_eq!(
            terminal_error_outcome(&json!({"kind": "budget_timeout", "proof": NO_PROVIDER_START})),
            "infrastructure_failure"
        );
        assert_eq!(
            terminal_error_outcome(
                &json!({"data": {"kind": "budget_timeout", "proof": NO_PROVIDER_START}})
            ),
            "infrastructure_failure"
        );
        assert_eq!(
            terminal_error_outcome(&json!({"kind": "budget_timeout"})),
            "budget_timeout"
        );
    }

    #[test]
    fn only_a_try_refused_before_any_answer_goes_again() {
        let mut attempt = blank_attempt();
        attempt.phase = "preparing".into();
        attempt.evaluations.clear();
        attempt.output = None;
        attempt.usage = TokenUsage::default();
        let error = |code: &str, message: &str| BenchmarkError::new(code, message);
        let host = |data: Value| json!({"code":-32603,"data":data}).to_string();
        assert!(refused_before_answer(
            &attempt,
            &error("selection_changed", "substituted")
        ));
        assert!(refused_before_answer(
            &attempt,
            &error("capability_missing", "no sign-in")
        ));
        // A session lost before it acknowledged a model asked nothing.
        assert!(refused_before_answer(
            &attempt,
            &error(SESSION_LOST, SESSION_LOST_BEFORE_ANSWER)
        ));
        assert!(refused_before_answer(
            &attempt,
            &error("account_busy", "Workflow worker slots are occupied")
        ));
        assert!(refused_before_answer(
            &attempt,
            &error(
                "infrastructure_failure",
                &host(json!({"dispatchStarted":false}))
            )
        ));
        assert!(refused_before_answer(
            &attempt,
            &error(
                "infrastructure_failure",
                &host(json!({"dispatchStarted":true,"promptNotAccepted":true}))
            )
        ));
        // A turn the provider accepted, or one that answered, is not.
        assert!(!refused_before_answer(
            &attempt,
            &error(
                "infrastructure_failure",
                &host(json!({"dispatchStarted":true,"promptNotAccepted":false}))
            )
        ));
        assert!(!refused_before_answer(
            &attempt,
            &error("dispatch_uncertain", "unknown")
        ));
        let mut running = attempt.clone();
        running.phase = "running".into();
        assert!(!refused_before_answer(
            &running,
            &error("selection_changed", "changed mid-turn")
        ));
        let mut answered = attempt.clone();
        answered.usage.output = Some(12);
        assert!(!refused_before_answer(
            &answered,
            &error("account_busy", "busy")
        ));
        let mut evaluated = attempt.clone();
        evaluated.evaluations.push(Evaluation {
            id: "invented".into(),
            evaluator_revision: "invented".into(),
            verdict: "pass".into(),
            score: Some(1.0),
            reason: String::new(),
            created_at: 1,
            provenance: "objective".into(),
            artifacts: vec![],
            details: None,
            judge: None,
            usage: None,
        });
        assert!(!refused_before_answer(
            &evaluated,
            &error("selection_changed", "late")
        ));
    }

    #[tokio::test]
    async fn only_the_same_refusal_after_a_resume_settles_a_cell() {
        let (dir, s, _) = setup().await;
        let run = s.start_run(request(&s).await).await.unwrap();
        let mut attempt = s.store.run(&run.id).await.unwrap().attempts.remove(0);
        attempt.reason = Some("the Codex model list is not cached".into());
        let again = BenchmarkError::new("capability_missing", "the Codex model list is not cached");
        assert!(refused_again(&attempt, &again));
        let other = BenchmarkError::new("capability_missing", "the Grok sign-in expires soon");
        assert!(!refused_again(&attempt, &other));
        attempt.reason = None;
        assert!(!refused_again(&attempt, &again));
        attempt.reason = Some("held".into());
        assert!(!refused_again(
            &attempt,
            &BenchmarkError::new(QUOTA_WAIT, "held")
        ));
        attempt.reason = Some(SIGN_IN_WAIT_REASON.into());
        assert!(!refused_again(
            &attempt,
            &BenchmarkError::new(SIGN_IN_WAIT, SIGN_IN_WAIT_REASON)
        ));
        dir.close().await;
    }

    #[test]
    fn only_a_turn_the_provider_never_saw_returns_to_the_queue() {
        assert!(returns_to_queue(QUOTA_WAIT, "running"));
        // A session lost before it acknowledged a model asked nothing either.
        for code in ["selection_changed", "capability_missing", SESSION_LOST] {
            assert!(returns_to_queue(code, "preparing"), "{code}");
            // Once the prompt is on its way, the turn is the provider's.
            assert!(!returns_to_queue(code, "dispatching"), "{code}");
            assert!(!returns_to_queue(code, "running"), "{code}");
        }
        for code in ["infrastructure_failure", "cancelled", "dispatch_uncertain"] {
            assert!(!returns_to_queue(code, "preparing"), "{code}");
        }
    }

    #[tokio::test]
    async fn workflow_tick_dispatches_children_once_and_evaluates_only_root() {
        let (dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
        draft.split = "train".into();
        draft.workflow = Some(WorkflowSpec {
            schema_version: 1,
            driver_revision: "runner-workflow-test-v1".into(),
            steps: vec![
                WorkflowStep {
                    id: "plan".into(),
                    prompt: "Prepare the public plan.".into(),
                    include_previous_output: false,
                    scope: None,
                },
                WorkflowStep {
                    id: "answer".into(),
                    prompt: "Produce the final structured answer.".into(),
                    include_previous_output: true,
                    scope: None,
                },
            ],
        });
        let definition = s.store.save_draft(None, None, draft).await.unwrap();
        let version = s.store.publish(&definition.id, 1).await.unwrap();
        req.version_ids = vec![version.id];
        req.repetitions = 1;
        let run = s.start_run(req).await.unwrap();
        s.tick().await.unwrap();
        s.tick().await.unwrap();
        s.tick().await.unwrap();
        let completed = s.store.run(&run.id).await.unwrap();
        assert_eq!(completed.state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        assert_eq!(completed.attempts.len(), 1);
        let root = &completed.attempts[0];
        assert_eq!(root.outcome.as_deref(), Some("pass"));
        assert_eq!(root.evaluations.len(), 1);
        assert_eq!(root.workflow_steps.len(), 2);
        assert_eq!(root.usage.input, Some(20));
        for child in &root.workflow_steps {
            let attempt = s.store.attempt(&child.attempt_id).await.unwrap();
            assert_eq!(attempt.phase, "terminal");
            assert_eq!(attempt.outcome.as_deref(), Some("completed"));
            assert!(attempt.evaluations.is_empty());
        }
        dir.close().await;
    }

    /// A selection no session of the run ever acknowledged is the run's own
    /// refusal: the third cell refused stops the run for the operator, before
    /// every remaining cell opens a session to be refused in its turn.
    #[tokio::test]
    async fn a_selection_refused_from_the_start_stops_at_the_third_cell() {
        let (dir, s, fake) = setup().await;
        fake.refused_selections.store(3, Ordering::SeqCst);
        let mut request = serial_request(&s).await;
        request.repetitions = 3;
        request.max_executions = 3;
        let run = s.start_run(request).await.unwrap();
        for _ in 0..4 {
            s.tick().await.unwrap();
        }
        let stopped = s.store.run(&run.id).await.unwrap();
        assert_eq!(stopped.state, "needs_attention");
        assert!(stopped
            .attempts
            .iter()
            .all(|a| a.phase == "pending" && a.pre_answer_refusals == 1 && a.outcome.is_none()));
        // Two wait for their next try; the third keeps the bare refusal the
        // operator reads.
        let waiting = stopped
            .attempts
            .iter()
            .filter(|a| a.wait_until.is_some())
            .count();
        assert_eq!(waiting, 2);
        assert!(stopped.attempts.iter().any(|a| a.wait_until.is_none()
            && a.reason
                .as_deref()
                .is_some_and(|reason| !reason.starts_with(PRE_ANSWER_RETRIED))));
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        // The operator resumed and the provider takes the selection now.
        s.store.set_run_state(&run.id, "running").await.unwrap();
        expire_saved_waits(&s, &run.id).await;
        for _ in 0..5 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert_eq!(fake.calls.load(Ordering::SeqCst), 3);
        dir.close().await;
    }

    /// Beside attempts the provider did take, one cell refused again and
    /// again is left for the operator at its third try while the run
    /// measures its other cells; the run stops once nothing else of it can
    /// go on, and the same refusal once more after the operator's resume
    /// settles the cell.
    #[tokio::test]
    async fn a_cell_refused_three_times_before_dispatch_is_left_for_the_operator() {
        let (dir, s, fake) = setup().await;
        let mut request = serial_request(&s).await;
        request.repetitions = 3;
        request.max_executions = 3;
        // The provider refuses one cell on each of its tries and takes the
        // other two beside it.
        fake.refused_selections.store(1, Ordering::SeqCst);
        let run = s.start_run(request).await.unwrap();
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        assert_eq!(s.store.run_state(&run.id).await.unwrap(), "running");
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        for tries in 2..=PRE_ANSWER_TRIES {
            fake.refused_selections.store(1, Ordering::SeqCst);
            expire_saved_waits(&s, &run.id).await;
            s.tick().await.unwrap();
            let seen = s.store.run(&run.id).await.unwrap();
            assert!(seen.attempts.iter().any(|a| a.pre_answer_refusals == tries));
        }
        // Nothing else of the run can go on: it stops, and the refused cell
        // kept the bare refusal and no wait of its own.
        s.tick().await.unwrap();
        let stopped = s.store.run(&run.id).await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        assert_eq!(stopped.state, "needs_attention");
        let left: Vec<&Attempt> = stopped
            .attempts
            .iter()
            .filter(|a| a.phase == "pending")
            .collect();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].pre_answer_refusals, PRE_ANSWER_TRIES);
        assert!(left[0].wait_until.is_none());
        assert!(left[0]
            .reason
            .as_deref()
            .is_some_and(|reason| !reason.starts_with(PRE_ANSWER_RETRIED)));
        // The operator resumed, and the provider refuses the cell as before.
        fake.refused_selections.store(1, Ordering::SeqCst);
        s.control(&run.id, "resume").await.unwrap();
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        let settled: Vec<&Attempt> = done
            .attempts
            .iter()
            .filter(|a| a.outcome.as_deref() == Some("selection_changed"))
            .collect();
        assert_eq!(settled.len(), 1);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        dir.close().await;
    }
}
