//! What a failed try means for its attempt and for its run: whether the try
//! counts, whether the cell goes back to the queue and for how long, and when
//! the operator is asked.
use super::*;

/// Tries of one attempt refused before any answer that go back to the queue
/// before the run stops for the operator; one more after the operator's
/// resume settles the cell, as `refused_again` does under automatic retries.
pub(super) const PRE_ANSWER_TRIES: u32 = 3;
/// How long a try refused before any answer waits before the next one.
pub(super) const PRE_ANSWER_RETRY_MS: i64 = 5 * 60 * 1000;
/// What the reason of a cell refused before any answer starts with while it
/// waits for its next try; the refusal's own words follow. At the bound the
/// cell keeps the bare refusal, so the same one after the operator's resume
/// reads as `refused_again` and settles it.
pub(super) const PRE_ANSWER_RETRIED: &str = "Refused before any answer; tried again.";

/// Refusals before any answer a cell goes back with before the operator is
/// asked: a runtime the host would not start needs the operator at once.
pub(super) fn pre_answer_limit(error: &BenchmarkError) -> u32 {
    if error.code == "capability_missing" {
        1
    } else {
        PRE_ANSWER_TRIES
    }
}

/// Whether one more refusal before any answer still goes back to the queue:
/// once the operator resumed a run stopped at the bound, the next refusal
/// settles the cell instead of cycling forever.
pub(super) fn within_pre_answer_tries(attempt: &Attempt, error: &BenchmarkError) -> bool {
    error.code == "account_busy" || attempt.pre_answer_refusals < pre_answer_limit(error)
}

/// Whether a failed try ended before the provider answered anything, so
/// discarding it decides nothing about the attempt's outcome: the provider
/// acknowledged another model at session open, a runtime it would not start,
/// the host refused the prompt (or never dispatched it), or the account had
/// no free seat. Nothing was answered, paid for as output or
/// evaluated. A turn that started answering is outside this class.
pub(in crate::services::benchmarks) fn refused_before_answer(attempt: &Attempt, error: &BenchmarkError) -> bool {
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
pub(super) const SESSION_LOST_BEFORE_ANSWER: &str =
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
pub(in crate::services::benchmarks) fn never_started(attempt: &Attempt, error: &BenchmarkError) -> bool {
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
pub(in crate::services::benchmarks) const NO_PROVIDER_START: &str = "native-owned-no-provider-start-v1";

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
pub(in crate::services::benchmarks) fn settled_failure(unit: &Attempt, error: &BenchmarkError) -> (String, String) {
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
pub(super) fn is_wait(code: &str) -> bool {
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
pub(super) fn refused_again(attempt: &Attempt, error: &BenchmarkError) -> bool {
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

impl BenchmarkService {
    /// Settles the try of `a` that ended with `error`: back to the queue, on
    /// to another account, or settled with its outcome; and the run, where
    /// the operator has to decide.
    pub(super) async fn try_failed(
        &self,
        run: &BenchmarkRun,
        a: &Attempt,
        version: &BenchmarkVersion,
        error: BenchmarkError,
    ) -> Result<()> {
        let mut failed = self.store.attempt(&a.id).await?;
        let error = diagnostics::record(
            &self.store,
            &failed,
            "candidate_execution",
            error,
            None,
            json!({"sessionId": failed.session_id, "hostRunId": failed.host_run_id}),
        )
        .await;
        if never_started(&failed, &error)
            && run.request.require_dispatch_admission(now()).is_ok()
            && self.forget_unstarted_try(&failed, &version).await?
        {
            // This is unstarted admission at whatever stage it was
            // refused, under every retry policy, including research
            // runs that forbid replay. No paid execution is retried,
            // and the cell is neither an attempt nor a failure.
            if error.code == SIGN_IN_WAIT {
                requeue(&mut failed, error.message.clone());
                failed.wait_until =
                    Some(sign_in_retry(&run.id, &a.configuration.provider_id));
            } else {
                // Refused for room at whatever stage (the host's
                // preparation queue, a copy, the Windows floors, the
                // broker): the attempts prepared next are paced as
                // after any sandbox refusal.
                admission_window::refused(&self.store.root.display().to_string(), &a.id);
                requeue(
                    &mut failed,
                    format!("Waiting for local resources: {}", error.message),
                );
                failed.wait_until =
                    Some(now() + admission_window::RETRY.as_millis() as i64);
            }
            failed.workflow_steps.clear();
            if version.manifest.workflow.is_none() {
                drop_collection_clock(&self.store, &mut failed).await?;
            }
            // The flight's end tells the app, once.
            self.store.save_attempt(&failed).await?;
            return Ok(());
        }
        let retry_allowed = run.request.automatic_retry()
            && run.request.require_dispatch_admission(now()).is_ok();
        // A usage limit that stopped the turn before anything of it
        // was evaluated waits for the reset under every retry policy:
        // the unfinished turn is discarded and the same attempt goes
        // again. A run that forbids retries never moves it to another
        // account, and settles a workflow root, whose committed steps
        // it never replays.
        let waits_for_quota = error.code == QUOTA_WAIT
            && failed.evaluations.is_empty()
            && run.request.require_dispatch_admission(now()).is_ok()
            && (retry_allowed || version.manifest.workflow.is_none());
        let back_to_queue = if error.code == QUOTA_WAIT {
            waits_for_quota
        } else {
            retry_allowed
        };
        // A run that forbids retries replays no answer, but a try the
        // provider refused before answering anything is no answer: the
        // same attempt goes again on the same account, a few times,
        // then waits for the operator, never settling the cell.
        if !retry_allowed
            && version.manifest.workflow.is_none()
            && run.request.require_dispatch_admission(now()).is_ok()
            && refused_before_answer(&failed, &error)
            && within_pre_answer_tries(&failed, &error)
        {
            // A busy account is waited out like under automatic
            // retries and never counts toward the bound.
            let busy = error.code == "account_busy";
            let tries = failed.pre_answer_refusals + u32::from(!busy);
            requeue(
                &mut failed,
                format!("{PRE_ANSWER_RETRIED} {}", error.message),
            );
            failed.pre_answer_refusals = tries;
            drop_collection_clock(&self.store, &mut failed).await?;
            failed.wait_until = Some(
                now()
                    + if busy {
                        ACCOUNT_BUSY_RETRY_MS
                    } else {
                        PRE_ANSWER_RETRY_MS
                    },
            );
            self.store.save_attempt(&failed).await?;
            if !busy && tries >= pre_answer_limit(&error) {
                self.store.set_run_state(&run.id, "needs_attention").await?;
            }
            self.changed().await;
            return Ok(());
        }
        if retry_allowed && error.code == "account_busy" {
            failed.phase = "pending".into();
            failed.started_at = None;
            if version.manifest.workflow.is_none() {
                drop_collection_clock(&self.store, &mut failed).await?;
            } else {
                self.idle_root(&failed).await?;
            }
            // Asked again shortly, within this tick: a seat frees
            // long before every other run's turns land.
            failed.wait_until = Some(now() + ACCOUNT_BUSY_RETRY_MS);
            self.store.save_attempt(&failed).await?;
            return Ok(());
        }
        // A turn the provider never saw keeps its cell: a quota wait
        // holds the run until the reset, a sign-in wait until the
        // Grok CLI renews the sign-in, and a refusal before the
        // prompt (a model the provider would not select, a session
        // lost at open) is tried again after a while, a few times,
        // while the run goes on with its other cells; at the bound,
        // or at once for a runtime, sign-in or policy the host would
        // not start, it waits for the operator with its reason. The
        // same refusal again after the operator resumed settles the
        // cell instead.
        // A limit that ran out on this account moves the test to
        // another account of the provider with room, if there is one.
        // A limit that names no reset (Claude's stop mid-answer says
        // only "resets 7pm") waits until the reset the account's last
        // usage read shows, where it shows one.
        let quota_message = if waits_for_quota && quota_reset(&error.message).is_none() {
            match self
                .backend
                .spent_until(
                    a.configuration.account_id.as_deref().unwrap_or_default(),
                    &a.configuration.model_id,
                )
                .await
            {
                Some(reset) => with_next_reset(&error.message, reset),
                None => error.message.clone(),
            }
        } else {
            error.message.clone()
        };
        if retry_allowed && waits_for_quota {
            if let Some(account) = a.configuration.account_id.as_deref() {
                // A refusal no reset lifts holds the account for as
                // long as the run would ever wait.
                let until = if refused_for_good(&quota_message) {
                    now() + QUOTA_WAIT_LIMIT_MS
                } else {
                    quota_reset(&quota_message).unwrap_or(now() + QUOTA_RETRY_MS)
                };
                exhaust(&run.id, account, until);
            }
            if let Some(other) = self.room_elsewhere(&run.id, &a.configuration).await {
                let reason = format!("{MOVED_ACCOUNT}. {}", error.message);
                if version.manifest.workflow.is_some() {
                    failed.phase = "pending".into();
                    failed.started_at = None;
                    failed.reason = Some(reason);
                    failed.wait_until = None;
                    self.idle_root(&failed).await?;
                } else {
                    requeue(&mut failed, reason);
                    drop_collection_clock(&self.store, &mut failed).await?;
                }
                failed.configuration.account_id = Some(other);
                // It goes on at once on the other account, within
                // this tick, while the spent one is held.
                failed.wait_until = Some(now());
                self.store.save_attempt(&failed).await?;
                self.changed().await;
                return Ok(());
            }
        }
        if back_to_queue
            && returns_to_queue(&error.code, &failed.phase)
            && !refused_again(&a, &error)
        {
            // A limit that ran out mid-run discards the unfinished
            // turn; the run waits for a reset it can reach, or stops
            // for the operator with the reason on the test.
            let plan = (error.code == QUOTA_WAIT).then(|| {
                quota_plan(
                    &run.id,
                    &quota_scope(&a.configuration),
                    &quota_message,
                    now(),
                )
            });
            let reason = if plan == Some(QuotaPlan::Stop) {
                let stopped = if refused_for_good(&error.message) {
                    QUOTA_REFUSED
                } else {
                    QUOTA_STOPPED
                };
                format!("{stopped}. {}", error.message)
            } else {
                error.message.clone()
            };
            if version.manifest.workflow.is_some() {
                // Its saved steps keep their sessions and usage, and
                // the root's sums of them stand.
                failed.phase = "pending".into();
                failed.started_at = None;
                failed.reason = Some(reason);
                failed.wait_until = None;
                self.idle_root(&failed).await?;
            } else {
                // A limit hit mid-turn discards the turn and its
                // clock: the next try is a new owner and key.
                requeue(&mut failed, reason);
                drop_collection_clock(&self.store, &mut failed).await?;
            }
            let provider = &a.configuration.provider_id;
            let mut stop = false;
            match plan {
                Some(QuotaPlan::WaitUntil(until)) => {
                    hold_provider_until(&run.id, &quota_scope(&a.configuration), until);
                    failed.wait_until = Some(until);
                }
                Some(QuotaPlan::Stop) => stop = true,
                // A refusal before the prompt. The first one stopped
                // the run: on 11-18 one Claude session of six could
                // not confirm its model with the API ("Try again"),
                // beside five that did, and a run of 1035 attempts
                // stood a minute after its start. The cell now goes
                // again under the bound a run that forbids retries
                // has, unless the run's selection was refused from
                // its start; a workflow root, whose steps are not
                // tried apart, still asks the operator at once.
                None if error.code != SIGN_IN_WAIT => {
                    failed.pre_answer_refusals =
                        failed.pre_answer_refusals.saturating_add(1);
                    if version.manifest.workflow.is_some()
                        || failed.pre_answer_refusals >= pre_answer_limit(&error)
                        || self.refused_from_the_start(&run.id, &failed).await?
                    {
                        stop = true;
                    } else {
                        failed.reason =
                            Some(format!("{PRE_ANSWER_RETRIED} {}", error.message));
                        failed.wait_until = Some(now() + PRE_ANSWER_RETRY_MS);
                    }
                }
                None => failed.wait_until = Some(sign_in_retry(&run.id, provider)),
            }
            self.store.save_attempt(&failed).await?;
            if stop {
                self.store.set_run_state(&run.id, "needs_attention").await?;
            }
            self.changed().await;
            return Ok(());
        }
        let needs_operator = !retry_allowed
            && (returns_to_queue(&error.code, &failed.phase)
                || matches!(
                    error.code.as_str(),
                    "account_busy"
                        | "dispatch_deadline"
                        | "selection_changed"
                        | "validation"
                        | "evidence_mismatch"
                ));
        let (outcome, reason) = settled_failure(&failed, &error);
        failed.phase = "terminal".into();
        failed.outcome = Some(outcome);
        failed.reason = Some(reason);
        failed.finished_at = Some(now());
        self.store.save_attempt(&failed).await?;
        if needs_operator
            || ["dispatch_uncertain", "storage_unavailable"].contains(&error.code.as_str())
        {
            self.store.set_run_state(&run.id, "needs_attention").await?;
        }
        Ok(())
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
