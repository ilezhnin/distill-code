//! Waits a run knows the end of: usage limits, sign-in renewals, provider holds.
use super::*;

/// The error code of a turn the host refused before any provider call because
/// every eligible account waits for quota.
pub(in super::super) const QUOTA_WAIT: &str = "account_quota_wait";

/// How long a run waits when the host names no quota reset.
pub(in super::super) const QUOTA_RETRY_MS: i64 = 5 * 60 * 1000;

/// Whether a host error is a quota wait that never reached the provider.
pub(in super::super) fn is_quota_wait(error: &Value) -> bool {
    let data = error.get("data").unwrap_or(error);
    (data["kind"] == QUOTA_WAIT || data["type"] == QUOTA_WAIT)
        && data["dispatchStarted"] == Value::Bool(false)
}

/// Whether the provider refused a dispatched turn for an exhausted usage
/// allowance before answering anything. Kimi Code reports its 5-hour limit as
/// ACP's `auth_required` with "403 You've reached your 5-hour usage limit".
/// Nothing was measured, so the cell waits for the reset like a quota wait the
/// host saw coming, instead of settling as an infrastructure failure.
pub(in super::super) fn refused_for_quota(error: &Value, output: &str, usage: &TokenUsage) -> bool {
    crate::services::provider_account_status::is_quota_error(error)
        && output.is_empty()
        && usage.output.unwrap_or(0) == 0
}

/// Whether the provider's usage limit stopped a dispatched turn before
/// anything decided it. The answer it cut off was never finished, so none of
/// it is measured: the turn is discarded and the attempt waits for the reset,
/// as after a refusal before any answer ([`refused_for_quota`]). A turn that
/// broke its policy, or passed its answer cap, already settled as that (the
/// caller also keeps a turn it cancelled itself), and a limit no reset lifts
/// ([`lasting_quota`]) settles as it ended.
pub(in super::super) fn stopped_for_quota(
    error: &Value,
    capture: &TurnCapture,
    repository: bool,
) -> bool {
    crate::services::provider_account_status::is_quota_error(error)
        && !lasting_quota(error)
        && capture.violation.is_none()
        && (repository || !capture.answer_capped)
}

/// Whether a quota error names a limit no reset lifts: billing, an account
/// on hold, no credit, balance or plan package left.
pub(in super::super) fn lasting_quota(error: &Value) -> bool {
    crate::services::provider_account_status::is_lasting_quota_error(error)
}

/// [`lasting_quota`] of a refusal as a run keeps it: the host's error as
/// JSON, or the provider's words.
pub(in super::super) fn refused_for_good(error: &str) -> bool {
    lasting_quota(
        &serde_json::from_str::<Value>(error).unwrap_or_else(|_| json!({ "message": error })),
    )
}

/// The longest a run waits on one provider's usage limit. A 5-hour window
/// resets within it, so a reset further off, or refusals that go on past it,
/// are a limit the run cannot wait out.
pub(in super::super) const QUOTA_WAIT_LIMIT_MS: i64 = (5 * 60 + 15) * 60 * 1000;

/// The usage limit a quota refusal speaks for: the provider account the turn
/// was sent on, so a second account of the provider keeps its own pace and
/// its cells while the first waits for its reset.
pub(in crate::services::benchmarks) fn quota_scope(configuration: &Configuration) -> String {
    format!(
        "{}\u{1f}{}",
        configuration.provider_id,
        configuration.account_id.as_deref().unwrap_or_default()
    )
}

/// Forgets what `run_id` learned about usage limits and sign-ins: the
/// operator resumed it, so its cells ask again, and a refusal from before a
/// long pause neither holds a healthy account nor counts toward giving up.
pub(in crate::services::benchmarks) fn forget_quota_waits(run_id: &str) {
    for held in [&EXHAUSTED, &QUOTA_SINCE, &PROVIDER_HOLDS] {
        held.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|(run, _), _| run != run_id);
    }
    INFRASTRUCTURE_STREAKS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .retain(|(run, _), _| run != run_id);
}

/// Explicit resume probes quota/sign-in availability again. Preserve unrelated
/// preparation and retry backoffs, and the request's dispatch deadline.
pub(in crate::services::benchmarks) async fn reset_account_waits(
    store: &Store,
    run: &BenchmarkRun,
) -> Result<()> {
    for attempt in &run.attempts {
        if !matches!(attempt.phase.as_str(), "pending" | AWAITING_JUDGES)
            || attempt.wait_until.is_none()
        {
            continue;
        }
        let reason = attempt.reason.as_deref().unwrap_or_default();
        let account_wait = reason == SIGN_IN_WAIT_REASON
            || judge_quota_waiting(attempt)
            || reason == crate::services::provider_account_status::grok::BENCHMARK_BRIDGE_BUSY
            || serde_json::from_str::<Value>(reason).is_ok_and(|error| {
                let data = error.get("data").unwrap_or(&error);
                data["kind"] == QUOTA_WAIT
                    || data["type"] == QUOTA_WAIT
                    || crate::services::provider_account_status::is_quota_error(&error)
            });
        if account_wait {
            // Run summaries omit output: keep the complete saved receipt.
            let mut waiting = store.attempt(&attempt.id).await?;
            waiting.wait_until = None;
            store.save_attempt(&waiting).await?;
        }
    }
    Ok(())
}

/// When each run's account first refused for quota (see [`quota_scope`]),
/// while the run waits on it. Kept in memory: a restart begins the wait again.
pub(in super::super) static QUOTA_SINCE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<(String, String), i64>>,
> = std::sync::LazyLock::new(Default::default);

/// Why a run stopped instead of waiting on a provider's usage limit; the
/// provider's own words follow it.
pub(in super::super) const QUOTA_STOPPED: &str =
    "A test did not finish: the usage limit ran out and does not reset in time for the run to wait";

/// Why a run stopped on a provider that refuses the account for a reason no
/// reset lifts ([`lasting_quota`]); the provider's own words follow it.
pub(in super::super) const QUOTA_REFUSED: &str = "A test did not finish: the provider refused this account's request, and a usage reset will not change that. Once the account's balance, plan or key is in order with the provider, resume";

/// What a run does once its provider refused a turn for quota.
#[derive(Debug, PartialEq)]
pub(in super::super) enum QuotaPlan {
    /// Hold the provider's cells until this time and try again.
    WaitUntil(i64),
    /// Stop the run for the operator: the limit will not reset soon.
    Stop,
}

/// Waits for a reset the run can reach: one the host names within
/// [`QUOTA_WAIT_LIMIT_MS`], or, with no time named, a retry every
/// [`QUOTA_RETRY_MS`] while the refusals last no longer than that. A weekly or
/// longer window, a reset further off, refusals past the limit, or a limit
/// no reset lifts ([`lasting_quota`]) stop it.
pub(in super::super) fn quota_plan(run_id: &str, scope: &str, error: &str, at: i64) -> QuotaPlan {
    if refused_for_good(error) {
        QUOTA_SINCE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&(run_id.to_owned(), scope.to_owned()));
        return QuotaPlan::Stop;
    }
    let parsed = serde_json::from_str::<Value>(error).ok();
    let next_reset = parsed
        .as_ref()
        .and_then(|e| e.pointer("/data/nextReset").and_then(Value::as_i64))
        .filter(|reset| *reset > at);
    let words = parsed
        .as_ref()
        .and_then(|e| e["message"].as_str())
        .unwrap_or(error)
        .to_lowercase();
    let long_window = [
        "weekly",
        "per week",
        "monthly",
        "per month",
        "daily",
        "per day",
    ]
    .iter()
    .any(|window| words.contains(window));
    let key = (run_id.to_owned(), scope.to_owned());
    let mut since = QUOTA_SINCE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let first = *since.entry(key.clone()).or_insert(at);
    if long_window
        || next_reset.is_some_and(|reset| reset - at > QUOTA_WAIT_LIMIT_MS)
        || at - first > QUOTA_WAIT_LIMIT_MS
    {
        since.remove(&key);
        return QuotaPlan::Stop;
    }
    QuotaPlan::WaitUntil(next_reset.unwrap_or(at + QUOTA_RETRY_MS))
}

/// Whether `run_id` still waits out the usage limit of `scope` (see
/// [`quota_scope`]): refused for quota, and no turn there finished since.
pub(in super::super) fn quota_waiting(run_id: &str, scope: &str) -> bool {
    QUOTA_SINCE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains_key(&(run_id.to_owned(), scope.to_owned()))
}

/// Accounts whose usage limit ran out under a run, until their reset.
pub(in super::super) static EXHAUSTED: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<(String, String), i64>>,
> = std::sync::LazyLock::new(Default::default);

/// `account` refused `run_id`'s turns for its usage limit until `until`.
pub(in super::super) fn exhaust(run_id: &str, account: &str, until: i64) {
    EXHAUSTED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert((run_id.to_owned(), account.to_owned()), until);
}

/// Whether `account`'s limit still holds `run_id` off.
pub(in super::super) fn exhausted(run_id: &str, account: &str) -> bool {
    exhausted_until(run_id, account).is_some()
}

pub(in super::super) fn exhausted_until(run_id: &str, account: &str) -> Option<i64> {
    let mut held = EXHAUSTED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let key = (run_id.to_owned(), account.to_owned());
    match held.get(&key) {
        Some(until) if *until > now() => Some(*until),
        Some(_) => {
            held.remove(&key);
            None
        }
        None => None,
    }
}

/// A judge turn its account's usage limit refused or cut off mid-answer: the
/// account leaves this run's panels until the reset, as a candidate's does. A
/// CLI sign-in has no usage reads that would show it spent, so without this
/// every later panel that seats it would get one more abstention.
pub(in super::super) fn exhaust_judge_on_quota(
    run_id: &str,
    account: &str,
    error: &Value,
    known_reset: Option<i64>,
) -> bool {
    let refused = judge_quota_stop(error);
    if refused {
        let until = if lasting_quota(error) {
            now() + QUOTA_WAIT_LIMIT_MS
        } else {
            quota_reset(&error.to_string())
                .or(known_reset)
                .unwrap_or(now() + QUOTA_RETRY_MS)
        };
        exhaust(run_id, account, until);
    }
    refused
}

/// Whether a judge turn ended on its account's usage limit, before or
/// during its answer.
pub(in super::super) fn judge_quota_stop(error: &Value) -> bool {
    is_quota_wait(error) || crate::services::provider_account_status::is_quota_error(error)
}

/// `error` (a quota refusal as the host or provider gave it) with its
/// account's known reset as `data.nextReset`, kept as text otherwise.
pub(in super::super) fn with_next_reset(error: &str, reset: i64) -> String {
    let mut value = serde_json::from_str::<Value>(error)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "message": error }));
    if !value["data"].is_object() {
        value["data"] = json!({});
    }
    value["data"]["nextReset"] = json!(reset);
    value.to_string()
}

/// When a quota refusal says the account's limit resets.
pub(in super::super) fn quota_reset(error: &str) -> Option<i64> {
    serde_json::from_str::<Value>(error)
        .ok()?
        .pointer("/data/nextReset")
        .and_then(Value::as_i64)
}

/// Why a test moved to another account, before the provider's own words.
pub(in super::super) const MOVED_ACCOUNT: &str =
    "The usage limit of its account ran out; it goes on on another account of the provider";

/// A turn on `scope` (see [`quota_scope`]) finished: the run no longer waits
/// on its limit.
pub(in super::super) fn quota_recovered(run_id: &str, scope: &str) {
    QUOTA_SINCE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&(run_id.to_owned(), scope.to_owned()));
}

/// The error code of a Grok turn held back, before any session, until the
/// Grok CLI renews the user's sign-in. The run's
/// cells of that provider wait on their own, as for a quota wait, while its
/// other providers' cells go on.
pub(in crate::services::benchmarks) const SIGN_IN_WAIT: &str = "sign_in_wait";

/// A sign-in too short for the turn that the Grok CLI renews only later: the
/// user's environment keeps its renewal window narrower than a turn needs
/// (see [`grok::cli_renewal_window_ms`]).
///
/// [`grok::cli_renewal_window_ms`]: crate::services::provider_account_status::grok::cli_renewal_window_ms
pub(in super::super) const SIGN_IN_WAIT_REASON: &str = "The Grok sign-in expires too soon for this test, and GROK_AUTH_EARLY_INVALIDATION_SECS in your environment lets the Grok CLI renew it only later; the run continues on its own once it does";

/// How soon a Grok turn that waits for another to leave the sign-in asks
/// again.
pub(in super::super) const SIGN_IN_RETRY_MS: i64 = 15 * 1000;

/// How soon a test refused because its account's seats are taken asks
/// again.
pub(in super::super) const ACCOUNT_BUSY_RETRY_MS: i64 = 15 * 1000;

/// When a sign-in wait of `provider`'s cells in `run_id` asks again: at the
/// hold the backend set for a renewal it knows the time of, else shortly, for
/// a renewal that waits for the account's running sessions. The cell records
/// it as its wait: a tick lasts while anything of any run flies, and a cell
/// put back without a time would wait for the next tick, for hours.
pub(in super::super) fn sign_in_retry(run_id: &str, provider: &str) -> i64 {
    provider_hold(run_id, provider).unwrap_or_else(|| {
        let until = now() + SIGN_IN_RETRY_MS;
        hold_provider_until(run_id, provider, until);
        until
    })
}

/// One provider's cells of a run, held until a time the runner knows: a Grok
/// sign-in the Grok CLI renews only later holds the run's Grok cells, and
/// nothing else of the run. Kept in memory, like [`QUOTA_HOLDS`].
pub(in super::super) static PROVIDER_HOLDS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<(String, String), i64>>,
> = std::sync::LazyLock::new(Default::default);

/// Sends no cell of `provider_id` in `run_id` before `until`; the next
/// dispatch after it asks again.
pub(in super::super) fn hold_provider_until(run_id: &str, provider_id: &str, until: i64) {
    PROVIDER_HOLDS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert((run_id.to_owned(), provider_id.to_owned()), until);
}

/// Until when `provider_id`'s cells of `run_id` are held, while they are.
pub(in super::super) fn provider_hold(run_id: &str, provider_id: &str) -> Option<i64> {
    let mut holds = PROVIDER_HOLDS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let key = (run_id.to_owned(), provider_id.to_owned());
    match holds.get(&key) {
        Some(until) if *until > now() => Some(*until),
        Some(_) => {
            holds.remove(&key);
            None
        }
        None => None,
    }
}

pub(in super::super) fn provider_held(run_id: &str, provider_id: &str) -> bool {
    provider_hold(run_id, provider_id).is_some()
}
