//! An account's pace, learned from how its turns end.
use super::*;

/// The key an account's pace is kept under: the store it measures for (each
/// test service has its own) and the account as a seat names it.
pub(in super::super) fn pace_key(store: &Store, account: &str) -> String {
    format!("{}\u{1e}{account}", store.root.display())
}

/// What a finished turn tells its account's pace: a rate-limit answer to a
/// sent prompt, or a clean turn's speed at the concurrency it was admitted
/// at. Turns that never reached the provider tell it nothing.
pub(in super::super) fn pace_turn(
    account: &str,
    attempt: &Attempt,
    error: Option<&BenchmarkError>,
) {
    if reached_provider(attempt) {
        pace(account, attempt, error, true);
    }
}

/// What a finished workflow root tells its account's pace, as one turn
/// admitted at its root's load: a rate-limit answer to any step halves it, a
/// clean root counts toward a round. Its steps' summed tokens per second say
/// nothing about one level, so it keeps no speed. A root no step of which
/// reached the provider, or one admitted without an account seat (a policy
/// root, whose workers this does not pace), tells it nothing.
pub(in super::super) fn pace_workflow(
    account: &str,
    root: &Attempt,
    error: Option<&BenchmarkError>,
) {
    let reached = reached_provider(root)
        || root
            .workflow_steps
            .iter()
            .any(|step| step.session_id.is_some() || step.host_run_id.is_some());
    if reached && root.account_load.is_some() {
        pace(account, root, error, false);
    }
}

pub(in super::super) fn pace(
    account: &str,
    attempt: &Attempt,
    error: Option<&BenchmarkError>,
    measured: bool,
) {
    if account.is_empty() {
        return;
    }
    // A turn that ran out of its own time or was stopped says nothing about
    // the provider's rate, whatever its reason quotes; nor does a usage limit
    // or a sign-in wait, which have their own holds.
    let ended = error.map_or(attempt.outcome.as_deref(), |error| {
        Some(error.code.as_str())
    });
    let throttled = !matches!(
        ended,
        Some("budget_timeout" | "cancelled" | QUOTA_WAIT | SIGN_IN_WAIT)
    ) && error
        .map(|error| account_pace::throttle_signal(&error.message))
        .unwrap_or_else(|| {
            attempt.outcome.as_deref() != Some("completed")
                && attempt
                    .reason
                    .as_deref()
                    .is_some_and(account_pace::throttle_signal)
        });
    if throttled {
        let admitted = attempt
            .account_load
            .as_ref()
            .map(|load| load.limit as usize);
        account_pace::record_throttle(account, &attempt.configuration.model_id, admitted, now());
    } else if error.is_none() && attempt.outcome.as_deref() == Some("completed") {
        let turns = attempt.account_load.as_ref().map_or(1, |load| load.turns);
        // Only a text turn's native time is the provider streaming; a
        // repository turn's includes its tools. A turn admitted while the
        // host was past the CPU line streamed as slowly as our own load let
        // it, which must never read as the provider slowing the account.
        let speed = if measured
            && attempt.configuration.execution_profile == "native_text"
            && !host_past_cpu_line(attempt)
        {
            account_pace::speed(
                attempt.usage.output,
                attempt.usage.reasoning,
                attempt.native_execution_ms,
            )
        } else {
            None
        };
        account_pace::record_turn(
            account,
            &attempt.configuration.model_id,
            turns,
            speed,
            now(),
        );
    }
}

/// An account's usage headroom as judge seating may rank by: none (unknown,
/// ranked last) when it reads 0 % used on every window although it flew
/// turns within the hour. 10-18: b55a read 0 % on every window through
/// hundreds of turns (its usage reads another sign-in than the sandbox
/// spends, or the provider paused them), so every judge seat went to it as
/// the roomiest account while it could hit a real limit unseen.
pub(in super::super) fn trusted_headroom(
    headroom: Option<crate::services::provider_account_status::Headroom>,
    last_flight: Option<i64>,
    now: i64,
) -> Option<crate::services::provider_account_status::Headroom> {
    let flew_lately = last_flight.is_some_and(|at| now - at < 60 * 60 * 1000);
    headroom.filter(|headroom| !(flew_lately && headroom.share >= 100.0))
}

/// The host CPU busy share past which heavy jobs wait (bench-budget's
/// LOAD_LINE, measured-load-v1).
const HOST_CPU_LINE: f64 = 0.70;

/// Whether `attempt` was admitted while the Windows host was past the CPU
/// line: by the 30-second mean its admission recorded, which the broker's
/// line compares too, or, on admissions from before the mean was kept, by
/// its one-second sample.
fn host_past_cpu_line(attempt: &Attempt) -> bool {
    attempt
        .sandbox_admission
        .as_ref()
        .and_then(|admission| admission.host_cpu_mean.or(admission.host_cpu_busy))
        .is_some_and(|busy| busy >= HOST_CPU_LINE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;

    #[test]
    fn a_turn_admitted_past_the_hosts_cpu_line_teaches_the_pace_no_speed() {
        // 10-18: our own load slowing the streaming must never read as the
        // provider slowing the account.
        let row = judge_row("sonnet");
        let mut attempt = crate::services::benchmarks::pending_attempt(
            "invented-run",
            "invented-version",
            &row,
            0,
        );
        assert!(!host_past_cpu_line(&attempt));
        let admitted = |busy: f64| -> sandbox::Admission {
            serde_json::from_value(json!({
                "heavyLanes": 3, "lane": "heavy", "competing": {}, "competingHeavy": 0,
                "reservedMemory": 0, "reservedCpu": 0, "memoryCurrent": 0,
                "guestLoad": [0.0, 0.0, 0.0], "guestCpus": 16, "guestMemAvailable": 0,
                "hostAvailableRam": 0, "hostAvailableCommit": 0, "hostCpuBusy": busy,
            }))
            .unwrap()
        };
        attempt.sandbox_admission = Some(admitted(0.69));
        assert!(!host_past_cpu_line(&attempt));
        attempt.sandbox_admission = Some(admitted(0.70));
        assert!(host_past_cpu_line(&attempt));
        // The 30-second mean, the broker's own window, decides where it was
        // recorded: a quiet second inside a busy stretch is still busy, and a
        // spike inside a quiet one is not.
        let mut busy_stretch = admitted(0.2);
        busy_stretch.host_cpu_mean = Some(0.8);
        attempt.sandbox_admission = Some(busy_stretch);
        assert!(host_past_cpu_line(&attempt));
        let mut spike = admitted(0.95);
        spike.host_cpu_mean = Some(0.5);
        attempt.sandbox_admission = Some(spike);
        assert!(!host_past_cpu_line(&attempt));
    }
}
