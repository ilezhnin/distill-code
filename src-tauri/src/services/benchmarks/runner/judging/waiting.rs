//! Judge counts, waits and the reasons a cell shows while judging is deferred.
use super::*;

/// Fewest judges whose votes may settle a rendering.
pub(crate) const MIN_JUDGES: usize = 2;

/// Most judges on one panel; plan admission reserves this many calls.
pub(crate) const MAX_JUDGES: usize = 3;

/// How long one judge turn may take. 10-18: Grok 4.7 high judged text
/// rubrics in a median 122 s with a tenth at the old 180 s cap, and six of
/// its sheets timed out; every other judge's 90th percentile stays near a
/// minute, so a fast judge finishes as soon as before.
pub(in crate::services::benchmarks) const JUDGE_TIMEOUT_SECONDS: u32 = 600;

pub(in crate::services::benchmarks) const JUDGING_STOPPED: &str =
    "Judging stopped: the run was paused or cancelled";

pub(in crate::services::benchmarks) const JUDGES_BUSY: &str =
    "Judge accounts are busy; evaluate again later";

pub(in crate::services::benchmarks) const RENDERER_BUSY: &str =
    "Waiting for local resources to render for the judge panel; evaluate again later";

pub(in super::super) const JUDGE_DISCOVERY_WAIT: &str = "Waiting for local resources to judge";

pub(in crate::services::benchmarks) const JUDGE_ADMISSION_WAIT: &str = "judge_admission_wait";

pub(in super::super) const JUDGE_QUOTA_WAIT: &str = "judge_quota_wait";

pub(in super::super) const JUDGE_QUOTA_REASON: &str =
    "Waiting for judge subscription quota to reset";

pub(in super::super) const JUDGE_BUSY_RETRY: Duration = Duration::from_secs(5);

/// A panel short only of judges whose sandbox check went stale, while the app
/// renews those checks itself. Each update of the app makes them stale.
pub(in super::super) const JUDGE_POLICY_RENEWAL: &str = "Updating the sandbox check before judging";

/// How often a panel waiting on that renewal looks for its judges again.
pub(in super::super) const JUDGE_POLICY_RETRY: Duration = Duration::from_secs(2 * 60);

/// A rendering whose panel a pause or busy judges held back: its generation
/// is sealed and the run asks the panel before any new generation.
pub(crate) const AWAITING_JUDGES: &str = "awaiting_judges";

/// Whether a panel stopped short in a way its run can take up again.
pub(in super::super) fn judging_deferred(attempt: &Attempt) -> bool {
    matches!(
        attempt.reason.as_deref(),
        Some(JUDGING_STOPPED | JUDGES_BUSY | RENDERER_BUSY | JUDGE_RESELECTING | JUDGE_REPLACING)
    ) || judge_discovery_waiting(attempt)
        || judge_quota_waiting(attempt)
        || judge_policy_waiting(attempt)
}

pub(in super::super) fn judge_policy_waiting(attempt: &Attempt) -> bool {
    attempt
        .reason
        .as_deref()
        .is_some_and(|reason| reason.starts_with(JUDGE_POLICY_RENEWAL))
}

pub(in super::super) const JUDGE_RESELECTING: &str =
    "Selecting a replacement judge after a usage limit";

/// A judge of an ordinary panel failed on its own: it gave no valid sheet,
/// its provider refused the request, or its runtime would not take the
/// selection. Its run takes the panel up again with another judge in that
/// seat, or with the judges it has when nobody can take it (see
/// [`ordinary_judging::judge_interrupted`]).
pub(in super::super) const JUDGE_REPLACING: &str =
    "Selecting a replacement judge after a judge failed";

/// How the reason of a judge turn an interruption cut off begins. Such a
/// turn is nobody's failure: its seat asks the same judge again.
pub(in super::super) const JUDGE_INTERRUPTED: &str = "Judge turn interrupted by a restart";

pub(in super::super) fn judge_quota_waiting(attempt: &Attempt) -> bool {
    attempt.reason.as_deref() == Some(JUDGE_QUOTA_REASON)
}

pub(in super::super) fn judge_quota_wait(until: Option<i64>) -> BenchmarkError {
    BenchmarkError::new(JUDGE_QUOTA_WAIT, JUDGE_QUOTA_REASON).with_details(json!({
        "nextReset": until.filter(|until| *until > now()).unwrap_or(now() + QUOTA_RETRY_MS)
    }))
}

pub(in super::super) fn judge_discovery_waiting(attempt: &Attempt) -> bool {
    attempt.reason.as_deref().is_some_and(|reason| {
        reason.starts_with(JUDGE_DISCOVERY_WAIT)
            || reason.starts_with("Waiting for local resources to list judge models")
    })
}
