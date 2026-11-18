//! Settling a completed answer: its check, its judges, its phase.
use super::*;

/// The reason a sealed generation carries while the sandbox has not yet
/// admitted its evaluation.
pub(in super::super) const EVALUATION_WAIT: &str = "Waiting for local resources to evaluate";

/// How many more times a check the sandbox's infrastructure ended (memory
/// pressure from above the job, the broker's deadline, a failed cleanup) runs
/// on the same sealed answer before the answer settles unscored. The check
/// calls no model.
pub(in super::super) const CHECK_RERUNS: u32 = 2;

/// How long such a check waits before it runs again.
const CHECK_RERUN_WAIT: Duration = if cfg!(test) {
    Duration::from_millis(10)
} else {
    Duration::from_secs(20)
};

/// The reason a sealed answer carries while its check waits to run again.
const CHECK_AGAIN: &str = "Checking again after an infrastructure failure";

/// How long an evaluation the sandbox refused before starting waits before it
/// asks again. The broker's own admission already waited out its window.
pub(in crate::services::benchmarks) const EVALUATION_RETRY: Duration = if cfg!(test) {
    Duration::from_millis(10)
} else {
    Duration::from_secs(2)
};

/// The outcome of an answer whose evaluation failed with `error`: the
/// candidate's own past its job's ceiling (scored 0), else an evaluator
/// error (unscored).
pub(in super::super) fn evaluation_failure_outcome(error: &BenchmarkError) -> &'static str {
    if error.code == CANDIDATE_LIMIT {
        "budget_reached"
    } else {
        "evaluation_error"
    }
}

/// Whether a check that failed with `error` runs again on the same sealed
/// answer, after `reruns` such runs: the sandbox's infrastructure ended it
/// (see [`CHECK_RERUNS`]). The candidate's own limit, an evaluator's defect
/// and a missing runtime decide the answer or need the operator, and settle.
fn check_runs_again(error: &BenchmarkError, reruns: u32) -> bool {
    error.code == "infrastructure_failure" && reruns < CHECK_RERUNS
}

/// Only isolated checks need the evaluator preparation lane. Local answer
/// comparisons and rubric validation share the candidate/judge lane, so a
/// queued native checker cannot delay an already available local verdict.
pub(in super::super) fn evaluation_preparation_scope(
    scope: &str,
    draft: &BenchmarkDraft,
) -> String {
    if matches!(
        draft.evaluator.kind.as_str(),
        "javascript" | "browser" | "repository"
    ) {
        admission_window::evaluation_scope(scope)
    } else {
        scope.to_owned()
    }
}

pub async fn evaluate(draft: &BenchmarkDraft, output: &str) -> Result<Evaluation> {
    if matches!(draft.evaluator.kind.as_str(), "javascript" | "browser") {
        return crate::services::benchmarks::worker::evaluate(draft, output).await;
    }
    // A repository case's output is the candidate's patch; its check runs in
    // a fresh copy of the snapshot outside every working copy.
    if draft.evaluator.kind == crate::services::benchmarks::repository::EVALUATOR {
        return crate::services::benchmarks::repository::evaluate_patch(draft, output).await;
    }
    let mut evaluation = evaluation::evaluate(&draft.evaluator, output)?;
    // A judged brief answered without any drawing or page leaves the panel
    // nothing to see: the candidate failed it, the evidence is not missing.
    if draft.evaluator.kind == "rubric"
        && !rubric_criteria(draft).is_empty()
        && judge_document(draft, output).is_none()
    {
        evaluation.verdict = "fail".into();
        evaluation.score = Some(0.0);
        evaluation.reason = if text_judged(draft) {
            "Text is empty or exceeds the published text limits"
        } else {
            "No renderable SVG or HTML markup in the answer"
        }
        .into();
    }
    Ok(evaluation)
}

impl BenchmarkService {
    /// Evaluates a finished generation and, for a creative brief, asks the
    /// judge panel. Evaluator and judge failures stay on the attempt.
    pub(in super::super) async fn settle(
        &self,
        mut completed: Attempt,
        version: &BenchmarkVersion,
        judge_budget: Option<std::result::Result<bool, String>>,
        stop: JudgeStop,
    ) -> Result<Attempt> {
        if completed.outcome.as_deref() != Some("completed") {
            return Ok(completed);
        }
        let output = completed.output.clone().unwrap_or_default();
        let mut waited = false;
        let mut reruns = 0;
        let scope =
            evaluation_preparation_scope(&self.store.root.display().to_string(), &version.manifest);
        let job = format!("evaluation:{}", completed.id);
        let evaluation = loop {
            // Waiting never probes or restarts a worker. Cancellation stays
            // responsive while the shared two-minute deadline runs down.
            if stop.cancelled() && (waited || reruns > 0 || !admission_window::has_room(&scope)) {
                completed.outcome = Some("evaluation_error".into());
                completed
                    .reason
                    .get_or_insert_with(|| format!("{EVALUATION_WAIT}: cancelled while queued"));
                return Ok(completed);
            }
            let Some(preparing) = admission_window::begin(&scope, &job) else {
                if !completed
                    .reason
                    .as_deref()
                    .is_some_and(|reason| reason.starts_with(EVALUATION_WAIT))
                {
                    completed.reason = Some(format!("{EVALUATION_WAIT}: preparation capacity"));
                    self.store.save_attempt(&completed).await?;
                    self.changed().await;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            };
            let preparing = Arc::new(preparing.observe());
            completed.reason = None;
            completed.wait_until = None;
            self.store.save_attempt(&completed).await?;
            self.changed().await;
            if !self.backend.paces_preparation() {
                preparing.admitted();
            }
            let admission = preparing.clone();
            match sandbox::with_workload_admission(
                move || admission.admitted(),
                self.backend.evaluate_output(&version.manifest, &output),
            )
            .await
            {
                Ok(evaluation) => {
                    preparing.admitted();
                    if preparing.finished() {
                        self.wake.notify_one();
                    }
                    if completed
                        .reason
                        .as_deref()
                        .is_some_and(|reason| reason.starts_with(EVALUATION_WAIT))
                    {
                        completed.reason = None;
                    }
                    completed.wait_until = None;
                    break evaluation;
                }
                // Nothing graded the paid answer yet: it waits for the sandbox
                // as long as its run goes on, and is never generated again.
                Err(error) if unstarted_refusal(&error) && !stop.cancelled() => {
                    let error = diagnostics::record(
                        &self.store,
                        &completed,
                        "evaluation_admission",
                        error,
                        None,
                        json!({"retryAfterMs": admission_window::RETRY.as_millis() as u64}),
                    )
                    .await;
                    preparing.finished();
                    if !waited {
                        log::info!(
                            "[benchmarks] {EVALUATION_WAIT} attempt {}: {}",
                            completed.id,
                            error.message
                        );
                        waited = true;
                    }
                    admission_window::refused(&scope, &job);
                    completed.reason = Some(format!("{EVALUATION_WAIT}: {}", error.message));
                    completed.wait_until = Some(now() + admission_window::RETRY.as_millis() as i64);
                    self.store.save_attempt(&completed).await?;
                    self.changed().await;
                    drop(preparing);
                }
                Err(error) => {
                    preparing.finished();
                    let error = diagnostics::record(
                        &self.store,
                        &completed,
                        "evaluation_failure",
                        error,
                        None,
                        json!({}),
                    )
                    .await;
                    // The sandbox ended this check, not the answer: the same
                    // sealed answer is checked again, and no model is asked.
                    if check_runs_again(&error, reruns) && !stop.cancelled() {
                        reruns += 1;
                        log::warn!(
                            "[benchmarks] attempt {}: its check failed in the sandbox and runs again ({reruns} of {CHECK_RERUNS}): {}",
                            completed.id,
                            error.message
                        );
                        completed.reason = Some(format!("{CHECK_AGAIN}: {}", error.message));
                        self.store.save_attempt(&completed).await?;
                        self.changed().await;
                        let until = Instant::now() + CHECK_RERUN_WAIT;
                        while Instant::now() < until && !stop.cancelled() {
                            tokio::time::sleep(CHECK_RERUN_WAIT.min(Duration::from_millis(100)))
                                .await;
                        }
                        continue;
                    }
                    completed.outcome = Some(evaluation_failure_outcome(&error).into());
                    completed.reason = Some(error.message);
                    return Ok(completed);
                }
            }
        };
        let judging =
            version.manifest.evaluator.kind == "rubric" && evaluation.verdict == "pending_review";
        completed.outcome = Some(evaluation.verdict.clone());
        completed.evaluations.push(evaluation);
        if !judging {
            return Ok(completed);
        }
        Ok(self
            .ask_judges(completed, version, judge_budget, stop)
            .await)
    }

    /// A panel a pause or busy judges held back waits for its run; anything
    /// else, a cancelled run included, settles the attempt.
    pub(in super::super) async fn settled_phase(
        &self,
        run: &BenchmarkRun,
        attempt: &Attempt,
    ) -> Result<&'static str> {
        Ok(
            if (run.request.automatic_retry()
                || judge_discovery_waiting(attempt)
                || judge_quota_waiting(attempt)
                || judge_policy_waiting(attempt))
                && judging_deferred(attempt)
                && !matches!(
                    self.store.run_state(&run.id).await?.as_str(),
                    "cancelling" | "cancelled"
                )
            {
                AWAITING_JUDGES
            } else {
                "terminal"
            },
        )
    }
}
