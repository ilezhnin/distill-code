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
    learned::forget(run_id);
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

/// Why a test is left for the operator instead of waiting on its account's
/// usage limit; the provider's own words follow it.
pub(in super::super) const QUOTA_STOPPED: &str =
    "A test did not finish: the usage limit ran out and does not reset in time for the run to wait";

/// Why a test is left for the operator on an account its provider refuses
/// for a reason no reset lifts ([`lasting_quota`]); the provider's own words
/// follow it.
pub(in super::super) const QUOTA_REFUSED: &str = "A test did not finish: the provider refused this account's request, and a usage reset will not change that. Once the account's balance, plan or key is in order with the provider, resume";

/// What a run does once its provider refused a turn for quota.
#[derive(Debug, PartialEq)]
pub(in super::super) enum QuotaPlan {
    /// Hold the provider's cells until this time and try again.
    WaitUntil(i64),
    /// The limit will not reset soon: the account's cells are left for the
    /// operator (see [`leave_for_operator`]).
    LeaveForOperator,
}

/// What `run_id` does about the usage limit of `scope` (see [`quota_scope`])
/// that `error` refused a turn for: it waits for a reset it can reach (see
/// [`reachable_reset`]), else the account is left for the operator. Once
/// left it stays so until their resume ([`forget_quota_waits`]): a turn of
/// it that was under way and is refused in its turn never starts a wait of
/// its own.
pub(in super::super) fn quota_plan(run_id: &str, scope: &str, error: &str, at: i64) -> QuotaPlan {
    learned::of(run_id, |run| {
        if run.left.contains(scope) {
            return QuotaPlan::LeaveForOperator;
        }
        match reachable_reset(&mut run.quota_since, scope, error, at) {
            Some(until) => QuotaPlan::WaitUntil(until),
            None => {
                run.left.insert(scope.to_owned());
                QuotaPlan::LeaveForOperator
            }
        }
    })
}

/// The reset the run waits for: one the host names within
/// [`QUOTA_WAIT_LIMIT_MS`], or, with no time named, a retry every
/// [`QUOTA_RETRY_MS`] while the refusals last no longer than that. None for
/// a weekly or longer window, a reset further off, refusals past the limit,
/// or a limit no reset lifts ([`lasting_quota`]). `since` is when each of
/// the run's accounts first refused, while the run waits on it.
fn reachable_reset(
    since: &mut std::collections::HashMap<String, i64>,
    scope: &str,
    error: &str,
    at: i64,
) -> Option<i64> {
    if refused_for_good(error) {
        since.remove(scope);
        return None;
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
    let first = *since.entry(scope.to_owned()).or_insert(at);
    if long_window
        || next_reset.is_some_and(|reset| reset - at > QUOTA_WAIT_LIMIT_MS)
        || at - first > QUOTA_WAIT_LIMIT_MS
    {
        since.remove(scope);
        return None;
    }
    Some(next_reset.unwrap_or(at + QUOTA_RETRY_MS))
}

/// Whether `run_id` still waits out the usage limit of `scope` (see
/// [`quota_scope`]): refused for quota, and no turn there finished since.
pub(in super::super) fn quota_waiting(run_id: &str, scope: &str) -> bool {
    learned::of(run_id, |run| run.quota_since.contains_key(scope))
}

/// `account` refused `run_id`'s turns for its usage limit until `until`.
pub(in super::super) fn exhaust(run_id: &str, account: &str, until: i64) {
    learned::of(run_id, |run| {
        run.exhausted.insert(account.to_owned(), until)
    });
}

/// Whether `account`'s limit still holds `run_id` off.
pub(in super::super) fn exhausted(run_id: &str, account: &str) -> bool {
    exhausted_until(run_id, account).is_some()
}

pub(in super::super) fn exhausted_until(run_id: &str, account: &str) -> Option<i64> {
    learned::of(run_id, |run| {
        learned::ahead(&mut run.exhausted, account, now())
    })
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
    learned::of(run_id, |run| run.quota_since.remove(scope));
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

/// Sends no cell of `provider_id` (a provider, or an account by its
/// [`quota_scope`]) in `run_id` before `until`; the next dispatch after it
/// asks again. A Grok sign-in the Grok CLI renews only later holds the run's
/// Grok cells so, and nothing else of the run.
pub(in super::super) fn hold_provider_until(run_id: &str, provider_id: &str, until: i64) {
    learned::of(run_id, |run| {
        run.holds.insert(provider_id.to_owned(), until)
    });
}

/// Until when `provider_id`'s cells of `run_id` are held, while they are.
pub(in super::super) fn provider_hold(run_id: &str, provider_id: &str) -> Option<i64> {
    learned::of(run_id, |run| {
        learned::ahead(&mut run.holds, provider_id, now())
    })
}

/// Ends the holds of `run_id`, or the one of `provider_id`: the time a test
/// would otherwise wait out. Whether there was one.
#[cfg(test)]
pub(in super::super) fn end_holds(run_id: &str, provider_id: Option<&str>) -> bool {
    learned::of(run_id, |run| match provider_id {
        Some(provider_id) => run.holds.remove(provider_id).is_some(),
        None => {
            let held = !run.holds.is_empty();
            run.holds.clear();
            held
        }
    })
}

pub(in super::super) fn provider_held(run_id: &str, provider_id: &str) -> bool {
    provider_hold(run_id, provider_id).is_some()
}

/// Sends nothing of `key` in `run_id` until the operator resumes the run,
/// while the run goes on with the rest: an account whose usage limit no wait
/// of the run reaches or whose runtime the host would not start (by its
/// [`quota_scope`]), or one cell (by its id) that used up its tries. The run
/// stops once nothing else of it can go on (see [`stop`](super::stop)). A
/// restart stops the run for the operator anyway, and their resume lets
/// everything ask again ([`forget_quota_waits`]).
pub(in super::super) fn leave_for_operator(run_id: &str, key: &str) {
    learned::of(run_id, |run| run.left.insert(key.to_owned()));
}

/// Whether `attempt`, or the account it is sent on, waits for the operator.
pub(in super::super) fn left_for_operator(attempt: &Attempt) -> bool {
    learned::of(&attempt.run_id, |run| {
        run.left.contains(&attempt.id) || run.left.contains(&quota_scope(&attempt.configuration))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;
    use std::sync::atomic::Ordering;

    /// The pace learns speeds from text turns only (a repository turn's
    /// native time includes its tools), and a turn that ran out of its own
    /// time or was stopped is no rate-limit signal, whatever its reason says.
    #[test]
    fn only_text_turns_teach_the_pace_speed_and_timeouts_never_throttle() {
        let row = judge_row("sonnet");
        let busy_host: sandbox::Admission = serde_json::from_value(json!({
            "heavyLanes": 3, "lane": "heavy", "competing": {}, "competingHeavy": 0,
            "reservedMemory": 0, "reservedCpu": 0, "memoryCurrent": 0,
            "guestLoad": [0.0, 0.0, 0.0], "guestCpus": 16, "guestMemAvailable": 0,
            "hostAvailableRam": 0, "hostAvailableCommit": 0, "hostCpuBusy": 0.3,
            "hostCpuMean": 0.9,
        }))
        .unwrap();
        let turn = |profile: &str, turns: u32, output: u64, loaded: bool| {
            let mut attempt = crate::services::benchmarks::pending_attempt(
                "invented-run",
                "invented-version",
                &row,
                0,
            );
            attempt.configuration.execution_profile = profile.into();
            attempt.outcome = Some("completed".into());
            attempt.session_id = Some("invented-session".into());
            attempt.usage.output = Some(output);
            attempt.native_execution_ms = Some(10_000);
            attempt.account_load = Some(AccountLoad { turns, limit: 4 });
            if loaded {
                attempt.sandbox_admission = Some(busy_host.clone());
            }
            attempt
        };
        // Five turns alone at 500 tokens/s, five beside three others at 80
        // each (320 in all, under three quarters of 500). A repository turn
        // teaches no speed, so its full round at four doubles the pace; so do
        // text turns at four admitted while the host's 30-second mean was past
        // its CPU line. Only the text turns' slowdown at four sends it to three.
        for (profile, account, loaded, limit) in [
            (
                "protected_repository",
                "invented-acp\u{1f}pace-repository",
                false,
                8,
            ),
            ("native_text", "invented-acp\u{1f}pace-loaded", true, 8),
            ("native_text", "invented-acp\u{1f}pace-text", false, 3),
        ] {
            for _ in 0..5 {
                pace_turn(account, &turn(profile, 1, 5000, false), None);
                pace_turn(account, &turn(profile, 4, 800, loaded), None);
            }
            assert_eq!(account_pace::limit(account), limit, "{account}");
        }
        let account = "invented-acp\u{1f}pace-timeout";
        let mut timed = turn("native_text", 1, 0, false);
        timed.outcome = Some("budget_timeout".into());
        timed.reason = Some("rate limit reached; {\"nativeExecutionMs\":429810}".into());
        pace_turn(account, &timed, None);
        pace_turn(
            account,
            &timed,
            Some(&BenchmarkError::new(
                "budget_timeout",
                "HTTP 429 rate limit",
            )),
        );
        // A usage limit or a sign-in wait has its own hold, whatever its JSON
        // says about rates.
        for code in [QUOTA_WAIT, SIGN_IN_WAIT] {
            pace_turn(
                account,
                &timed,
                Some(&BenchmarkError::new(
                    code,
                    "{\"error\":{\"type\":\"rate_limit_error\"},\"dispatchStarted\":true}",
                )),
            );
        }
        assert_eq!(account_pace::limit(account), ACCOUNT_SLOTS);
        let mut limited = timed.clone();
        limited.outcome = Some("provider_error".into());
        pace_turn(account, &limited, None);
        assert_eq!(account_pace::limit(account), ACCOUNT_SLOTS / 2);
        // The other turns of that burst, sent under the old limit, halve
        // nothing more.
        pace_turn(account, &limited, None);
        pace_turn(account, &limited, None);
        assert_eq!(account_pace::limit(account), ACCOUNT_SLOTS / 2);
    }

    #[test]
    fn a_judge_account_its_limit_refused_leaves_the_runs_panels_until_its_reset() {
        let reset = now() + 60_000;
        let quota =
            json!({"data": {"kind": QUOTA_WAIT, "dispatchStarted": false, "nextReset": reset}});
        assert!(exhaust_judge_on_quota(
            "invented-run",
            "cli-login-grok-acp",
            &quota,
            None
        ));
        assert!(exhausted("invented-run", "cli-login-grok-acp"));
        // Another run, or another account, is not held.
        assert!(!exhausted("other-run", "cli-login-grok-acp"));
        assert!(!exhausted("invented-run", "invented-claude"));
        // Any other failure leaves the account in the panels.
        let other = json!({"data": {"kind": "bridge_exited", "dispatchStarted": true}});
        assert!(!exhaust_judge_on_quota(
            "second-run",
            "cli-login-grok-acp",
            &other,
            None
        ));
        assert!(!exhausted("second-run", "cli-login-grok-acp"));
        // A limit that cut the judge off mid-answer holds the account too.
        let cut = json!({"code":-32603,"data":{"errorKind":"quota_exhausted",
            "dispatchStarted":true},"message":"You've hit your session limit"});
        let reset = now() + 2 * 60 * 60 * 1000;
        assert!(exhaust_judge_on_quota(
            "third-run",
            "invented-claude",
            &cut,
            Some(reset)
        ));
        assert!(exhausted("third-run", "invented-claude"));
        assert_eq!(exhausted_until("third-run", "invented-claude"), Some(reset));
    }

    #[test]
    fn a_quota_wait_leaves_one_flight_on_the_account_until_a_turn_lands() {
        let run = "quota-slots-run";
        let mut spent = judge_row("kimi");
        spent.provider_id = "kimi-acp".into();
        spent.account_id = Some("quota-slots-account".into());
        let mut healthy = spent.clone();
        healthy.account_id = Some("quota-slots-second".into());
        let (scope, other) = (quota_scope(&spent), quota_scope(&healthy));
        let account = "kimi-acp\u{1f}quota-slots-account";
        assert_eq!(account_slots(run, &scope, account), ACCOUNT_SLOTS);
        let error = json!({"data":{"kind":QUOTA_WAIT,"nextReset":now() + 60_000}}).to_string();
        assert!(matches!(
            quota_plan(run, &scope, &error, now()),
            QuotaPlan::WaitUntil(_)
        ));
        assert_eq!(account_slots(run, &scope, account), 1);
        // The provider's other account keeps its own pace, and another run on
        // the provider flies as before.
        assert_eq!(account_slots(run, &other, account), ACCOUNT_SLOTS);
        assert_eq!(account_slots("another-run", &scope, account), ACCOUNT_SLOTS);
        quota_recovered(run, &scope);
        assert_eq!(account_slots(run, &scope, account), ACCOUNT_SLOTS);
    }

    /// A run the operator resumes asks every account again: a quota hold, an
    /// exhausted account and a first refusal from before a long pause are
    /// forgotten, so one refusal after the pause waits instead of stopping
    /// the run, and a healthy account's cells are not held.
    #[tokio::test]
    async fn resuming_a_run_forgets_its_usage_limit_waits() {
        let (dir, s, _) = setup().await;
        let run = s.start_run(serial_request(&s).await).await.unwrap();
        let configuration = run.attempts[0].configuration.clone();
        let scope = quota_scope(&configuration);
        let error = json!({"data":{"kind":QUOTA_WAIT}}).to_string();
        let long_ago = now() - QUOTA_WAIT_LIMIT_MS - 60_000;
        assert!(matches!(
            quota_plan(&run.id, &scope, &error, long_ago),
            QuotaPlan::WaitUntil(_)
        ));
        exhaust(&run.id, "isolated", now() + QUOTA_WAIT_LIMIT_MS);
        hold_provider_until(&run.id, &scope, now() + QUOTA_WAIT_LIMIT_MS);
        assert!(s.dispatchable(&run, now()).await.unwrap().is_empty());
        // Adding cases to a run still going on keeps what its turns learned.
        s.extend_run(&run.id, &[], &[]).await.unwrap();
        assert!(quota_waiting(&run.id, &scope));
        assert!(exhausted(&run.id, "isolated"));
        assert!(provider_held(&run.id, &scope));
        s.store.set_run_state(&run.id, "paused").await.unwrap();
        s.control(&run.id, "resume").await.unwrap();
        assert!(!quota_waiting(&run.id, &scope));
        assert!(!exhausted(&run.id, "isolated"));
        assert!(!provider_held(&run.id, &scope));
        let resumed = s.store.run(&run.id).await.unwrap();
        assert_eq!(s.dispatchable(&resumed, now()).await.unwrap().len(), 2);
        assert!(matches!(
            quota_plan(&run.id, &scope, &error, now()),
            QuotaPlan::WaitUntil(_)
        ));
        dir.close().await;
    }

    #[test]
    fn a_limit_that_names_no_reset_waits_for_the_one_the_usage_read_shows() {
        let reset = now() + 2 * 60 * 60 * 1000;
        // Claude's stop mid-answer names its reset only in words.
        let stop = json!({"code":-32603,"data":{"errorKind":"quota_exhausted",
            "dispatchStarted":true},"message":"You've hit your session limit · resets 7pm"})
        .to_string();
        assert_eq!(quota_reset(&stop), None);
        let filled = with_next_reset(&stop, reset);
        assert_eq!(quota_reset(&filled), Some(reset));
        assert!(filled.contains("quota_exhausted") && filled.contains("resets 7pm"));
        assert_eq!(
            quota_plan("invented-reset-run", "claude-acp", &filled, now()),
            QuotaPlan::WaitUntil(reset)
        );
        // Words alone keep their text beside the reset.
        let words = with_next_reset("usage limit reached", reset);
        assert_eq!(quota_reset(&words), Some(reset));
        assert!(words.contains("usage limit reached"));
    }

    #[tokio::test]
    async fn a_quota_wait_keeps_the_cell_and_holds_the_run_until_the_reset() {
        let (dir, s, fake) = setup().await;
        fake.quota_waits.store(1, Ordering::SeqCst);
        let run = s.start_run(serial_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let held = s.store.run(&run.id).await.unwrap();
        assert_eq!(held.state, "running");
        assert!(held.attempts.iter().all(|a| a.phase == "pending"));
        assert!(held.attempts.iter().all(|a| a.host_run_id.is_none()));
        // Nothing is sent before the reset.
        s.tick().await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        end_holds(&run.id, None);
        expire_saved_waits(&s, &run.id).await;
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert!(done
            .attempts
            .iter()
            .all(|a| a.phase == "terminal" && a.outcome.as_deref() != Some(QUOTA_WAIT)));
        dir.close().await;
    }

    /// A Grok sign-in the CLI renews only later holds the provider's cells
    /// until then, without the operator, however often it comes up; the run
    /// then goes on with every cell.
    #[tokio::test]
    async fn a_sign_in_the_cli_renews_later_holds_the_run_on_its_own() {
        let (dir, s, fake) = setup().await;
        fake.sign_in_waits.store(2, Ordering::SeqCst);
        let run = s.start_run(serial_request(&s).await).await.unwrap();
        let release = || end_holds(&run.id, Some("fake"));
        s.tick().await.unwrap();
        let held = s.store.run(&run.id).await.unwrap();
        assert_eq!(held.state, "running");
        assert!(held
            .attempts
            .iter()
            .all(|a| a.phase == "pending" && a.outcome.is_none()));
        // The returned test says when the run tries it again.
        assert!(held.attempts.iter().any(|a| {
            a.reason.as_deref() == Some(SIGN_IN_WAIT_REASON)
                && a.wait_until.is_some_and(|until| until > now())
        }));
        // Nothing is sent while it waits, and the run does not complete.
        s.tick().await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "running");
        // The same wait again settles nothing and asks nobody.
        assert!(release());
        expire_saved_waits(&s, &run.id).await;
        s.tick().await.unwrap();
        let again = s.store.run(&run.id).await.unwrap();
        assert_eq!(again.state, "running");
        assert!(again.attempts.iter().all(|a| a.phase == "pending"));
        assert!(release());
        expire_saved_waits(&s, &run.id).await;
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert!(done
            .attempts
            .iter()
            .all(|a| a.phase == "terminal" && a.outcome.as_deref() == Some("pass")));
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        dir.close().await;
    }

    /// A Grok turn that finds another still running on the due sign-in goes
    /// back to the queue without the operator and is asked again shortly:
    /// its wait records when, so the runner retries it within the tick.
    #[tokio::test]
    async fn a_turn_waits_for_another_on_the_due_sign_in() {
        let (dir, s, fake) = setup().await;
        fake.busy_sign_ins.store(1, Ordering::SeqCst);
        let run = s.start_run(request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let held = s.store.run(&run.id).await.unwrap();
        assert_eq!(held.state, "running");
        let waiting = held
            .attempts
            .iter()
            .find(|a| a.reason.is_some())
            .expect("a returned test");
        assert_eq!(waiting.phase, "pending");
        assert_eq!(
            waiting.reason.as_deref(),
            Some(crate::services::provider_account_status::grok::BENCHMARK_BRIDGE_BUSY)
        );
        let until = provider_hold(&run.id, "fake").expect("a short hold");
        assert!(until <= now() + SIGN_IN_RETRY_MS);
        assert_eq!(waiting.wait_until, Some(until));
        end_holds(&run.id, Some("fake"));
        expire_saved_waits(&s, &run.id).await;
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert!(done
            .attempts
            .iter()
            .all(|a| a.outcome.as_deref() == Some("pass")));
        dir.close().await;
    }

    /// Run 607f8612 mixed Grok and Kimi: a Grok sign-in wait holds the Grok
    /// cells alone. The other provider's cells run meanwhile, and the run
    /// does not complete while a held cell is pending.
    #[tokio::test]
    async fn a_sign_in_wait_holds_only_that_providers_cells() {
        let (dir, s, fake) = setup().await;
        let mut req = request(&s).await;
        let mut grok = req.configurations[0].clone();
        grok.id = "grok-pass".into();
        grok.provider_id = "grok".into();
        req.configurations.push(grok);
        req.max_executions = 4;
        let run = s.start_run(req).await.unwrap();
        hold_provider_until(&run.id, "grok", now() + 60_000);
        for _ in 0..4 {
            s.tick().await.unwrap();
        }
        let held = s.store.run(&run.id).await.unwrap();
        assert_eq!(held.state, "running");
        for attempt in &held.attempts {
            if attempt.configuration.provider_id == "grok" {
                assert_eq!(attempt.phase, "pending");
            } else {
                assert_eq!(attempt.outcome.as_deref(), Some("pass"));
            }
        }
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        end_holds(&run.id, Some("grok"));
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert!(done
            .attempts
            .iter()
            .all(|a| a.outcome.as_deref() == Some("pass")));
        assert_eq!(fake.calls.load(Ordering::SeqCst), 4);
        dir.close().await;
    }

    #[test]
    fn only_an_identifier_before_the_colon_is_a_host_error_code() {
        assert_eq!(host_error("validation: bad key".into()).code, "validation");
        let crash = host_error("Internal error: {\"details\":\"exited\"}".into());
        assert_eq!(crash.code, "infrastructure_failure");
        assert!(crash.message.starts_with("Internal error:"));
        assert!(is_quota_wait(
            &json!({"code":-32010,"data":{"kind":QUOTA_WAIT,"dispatchStarted":false}})
        ));
        assert!(!is_quota_wait(
            &json!({"code":-32010,"data":{"kind":QUOTA_WAIT,"dispatchStarted":true}})
        ));
    }

    #[test]
    fn a_usage_limit_waits_for_a_reset_it_can_reach_and_leaves_its_account_otherwise() {
        let at = 1_800_000_000_000i64;
        let hour = 3_600_000i64;
        let five_hour = r#"{"code":-32000,"message":"Authentication required: 403 You've reached your 5-hour usage limit."}"#;
        // No reset named: try again shortly, as long as the refusals last no
        // longer than a 5-hour window can.
        assert_eq!(
            quota_plan("run-a", "kimi-acp", five_hour, at),
            QuotaPlan::WaitUntil(at + QUOTA_RETRY_MS)
        );
        assert_eq!(
            quota_plan("run-a", "kimi-acp", five_hour, at + 3 * hour),
            QuotaPlan::WaitUntil(at + 3 * hour + QUOTA_RETRY_MS)
        );
        assert_eq!(
            quota_plan("run-a", "kimi-acp", five_hour, at + QUOTA_WAIT_LIMIT_MS + 1),
            QuotaPlan::LeaveForOperator
        );
        // Left for the operator, the account stays so: a later refusal of
        // it starts no wait of its own.
        let later = at + QUOTA_WAIT_LIMIT_MS + 2;
        assert_eq!(
            quota_plan("run-a", "kimi-acp", five_hour, later),
            QuotaPlan::LeaveForOperator
        );
        // After the operator's resume, or a turn that went through, a
        // refusal starts a new wait.
        forget_quota_waits("run-a");
        assert_eq!(
            quota_plan("run-a", "kimi-acp", five_hour, later),
            QuotaPlan::WaitUntil(later + QUOTA_RETRY_MS)
        );
        quota_recovered("run-a", "kimi-acp");
        assert_eq!(
            quota_plan("run-a", "kimi-acp", five_hour, later + 6 * hour),
            QuotaPlan::WaitUntil(later + 6 * hour + QUOTA_RETRY_MS)
        );
        // A reset the host names: wait for it when near, stop when far.
        let reset = |next: i64| {
            json!({"code":-32010,"data":{"kind":QUOTA_WAIT,"dispatchStarted":false,"nextReset":next}})
                .to_string()
        };
        assert_eq!(
            quota_plan("run-b", "claude-acp", &reset(at + hour), at),
            QuotaPlan::WaitUntil(at + hour)
        );
        assert_eq!(
            quota_plan("run-c", "claude-acp", &reset(at + 72 * hour), at),
            QuotaPlan::LeaveForOperator
        );
        // A weekly or monthly limit is never waited out.
        let weekly = r#"{"message":"You've reached your weekly usage limit."}"#;
        assert_eq!(
            quota_plan("run-d", "kimi-acp", weekly, at),
            QuotaPlan::LeaveForOperator
        );
        let zai = json!({"code":-32603,"data":{"errorName":"APIError",
            "dispatchStarted":true,"promptNotAccepted":false},
            "message":"Internal error: Weekly/Monthly Limit Exhausted. Your limit will reset at 2030-01-02 12:00:00"});
        let mut capture = TurnCapture::new(1024);
        capture.output = "unfinished solution".into();
        assert!(stopped_for_quota(&zai, &capture, true));
        assert_eq!(
            quota_plan("run-zai", "zai-acp", &zai.to_string(), at),
            QuotaPlan::LeaveForOperator
        );
        // A key with nothing to spend (a Standard key on an empty balance,
        // or a Coding Plan key without a plan) is refused before any answer,
        // and no usage reset lifts it: the account is left for the
        // operator at once instead of retrying for hours.
        let lapsed = json!({"code":-32603,"data":{"errorName":"APIError",
            "dispatchStarted":true,"promptNotAccepted":false},
            "message":"Internal error: Insufficient balance or no resource package. Please recharge."});
        assert!(refused_for_quota(&lapsed, "", &TokenUsage::default()));
        assert!(!stopped_for_quota(&lapsed, &capture, true));
        assert!(refused_for_good(&lapsed.to_string()));
        assert!(refused_for_good(
            "Insufficient balance or no resource package"
        ));
        assert!(!refused_for_good(five_hour));
        assert_eq!(
            quota_plan("run-lapsed", "zai-acp", &lapsed.to_string(), at),
            QuotaPlan::LeaveForOperator
        );
        assert!(!quota_waiting("run-lapsed", "zai-acp"));
    }
}
