//! A try the infrastructure broke is measured again by the run itself.
use super::*;

/// Tries of one repetition a run measures again by itself after an
/// infrastructure failure ended them. Past them the cell stays unmeasured
/// until the operator resumes the run, as before.
pub(in super::super) const INFRASTRUCTURE_RETRIES: u32 = 2;

/// Turns of one provider in a run that an infrastructure failure ended in a
/// row, with no turn that settled otherwise between them, after which the run
/// stops measuring them again by itself: the provider or the sandbox is down,
/// and each further try would only cost.
pub(in super::super) const INFRASTRUCTURE_STREAK: u32 = 5;

/// How long a try's replacement waits before it asks, and how long when the
/// provider pushed back for its rate.
const INFRASTRUCTURE_RETRY_MS: i64 = if cfg!(test) { 20 } else { 60 * 1000 };

pub(in super::super) const THROTTLED_RETRY_MS: i64 = 5 * 60 * 1000;

/// The reason of a try its run set aside after an infrastructure failure.
/// The outcome in it is what the test's trail shows for the try.
pub(in super::super) const MEASURED_AGAIN: &str =
    "Measured again in the same run after an infrastructure failure (this one: infrastructure_failure)";

/// The reason its replacement waits with.
pub(in super::super) const MEASURING_AGAIN: &str =
    "An infrastructure failure ended the last try; the test is measured again";

/// How many turns of `scope` (see [`quota_scope`]) in `run_id` an
/// infrastructure failure ended in a row, this one counted: `failed` adds to
/// the streak, any other settled turn ends it. Kept in memory (see
/// [`learned`]), so a restart or the operator's resume begins it again.
pub(in super::super) fn infrastructure_streak(run_id: &str, scope: &str, failed: bool) -> u32 {
    learned::of(run_id, |run| {
        if failed {
            let streak = run.streaks.entry(scope.to_owned()).or_default();
            *streak += 1;
            *streak
        } else {
            run.streaks.remove(scope);
            0
        }
    })
}

/// Whether the run measures `settled` again by itself: a standalone try of a
/// run that allows retries, which an infrastructure failure ended before
/// anything of it was evaluated. Not the model's answer, so nothing is lost
/// by asking again; a workflow root's committed steps are never replayed, a
/// refusal no reset lifts (a spent balance, an account on hold) would only
/// be refused again, and `streak` failures in a row say the cause is not
/// this turn's.
pub(in super::super) fn measured_again_by_itself(
    request: &RunRequest,
    version: &BenchmarkVersion,
    settled: &Attempt,
    streak: u32,
) -> bool {
    request.automatic_retry()
        && request.require_dispatch_admission(now()).is_ok()
        && version.manifest.workflow.is_none()
        && settled.phase == "terminal"
        && settled.outcome.as_deref() == Some("infrastructure_failure")
        && settled.evaluations.is_empty()
        && settled.infrastructure_retries < INFRASTRUCTURE_RETRIES
        && streak < INFRASTRUCTURE_STREAK
        && !settled.reason.as_deref().is_some_and(refused_for_good)
}

impl BenchmarkService {
    /// Sets aside a try an infrastructure failure ended and queues a fresh
    /// one for the same repetition, as an operator's resume does for the
    /// whole run: the failed try keeps its evidence and spend and counts
    /// nowhere, and its replacement waits a moment (longer when the provider
    /// pushed back for its rate) before it asks again.
    pub(in super::super) async fn measure_again(
        &self,
        run: &BenchmarkRun,
        failed: Attempt,
    ) -> Result<()> {
        let throttled = failed
            .reason
            .as_deref()
            .is_some_and(account_pace::throttle_signal);
        let mut fresh = crate::services::benchmarks::pending_attempt(
            &run.id,
            &failed.version_id,
            run.request
                .configurations
                .iter()
                .find(|configuration| configuration.id == failed.configuration.id)
                .unwrap_or(&failed.configuration),
            failed.repetition,
        );
        fresh.infrastructure_retries = failed.infrastructure_retries + 1;
        fresh.reason = Some(MEASURING_AGAIN.into());
        fresh.wait_until = Some(
            now()
                + if throttled {
                    THROTTLED_RETRY_MS
                } else {
                    INFRASTRUCTURE_RETRY_MS
                },
        );
        log::warn!(
            "[benchmarks] attempt {}: an infrastructure failure ended its turn; the run measures the test again as attempt {} (try {} of {})",
            failed.id,
            fresh.id,
            fresh.infrastructure_retries + 1,
            INFRASTRUCTURE_RETRIES + 1
        );
        let mut superseded = failed;
        superseded.reason = Some(MEASURED_AGAIN.into());
        superseded.outcome = Some(crate::services::benchmarks::analysis::SUPERSEDED.into());
        self.store.supersede_and_insert(&superseded, &fresh).await?;
        self.wake.notify_one();
        Ok(())
    }
}
