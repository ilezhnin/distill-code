//! Judge counts, waits and the reasons a cell shows while judging is deferred.
use super::*;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn a_cancel_reaches_a_running_judge_panel_and_settles_the_attempt() {
        let (dir, s, backend) = setup().await;
        let run = stop_during_the_panel(&s, &backend, "cancel").await;
        let a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        assert_eq!(a.phase, "terminal");
        assert_eq!(a.outcome.as_deref(), Some("pending_review"));
        assert_eq!(a.reason.as_deref(), Some(JUDGING_STOPPED));
        dir.close().await;
    }

    #[tokio::test]
    async fn a_restart_during_the_first_panel_waits_for_resume_without_a_new_generation() {
        for evaluated in [true, false] {
            let (dir, s, backend) = setup().await;
            let id = restart_during_the_first_panel(&s, &backend, evaluated).await;
            let waiting = s.store.attempt(&id).await.unwrap();
            assert_eq!(waiting.phase, AWAITING_JUDGES, "{evaluated}");
            assert_eq!(waiting.reason.as_deref(), Some(JUDGING_STOPPED));
            assert_eq!(waiting.outcome.as_deref(), Some("pending_review"));
            let run = s.store.run(&waiting.run_id).await.unwrap();
            assert_eq!(run.state, "needs_attention");
            // Nothing is asked until the operator resumes.
            s.tick().await.unwrap();
            assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
            s.control(&run.id, "resume").await.unwrap();
            s.tick().await.unwrap();
            assert_eq!(backend.judges.load(Ordering::SeqCst), 2, "{evaluated}");
            assert_eq!(backend.calls.load(Ordering::SeqCst), 1, "{evaluated}");
            let judged = s.store.attempt(&id).await.unwrap();
            assert_eq!(judged.phase, "terminal");
            assert!(judged.reason.is_none());
            dir.close().await;
        }
    }

    #[tokio::test]
    async fn judge_discovery_waits_without_repeating_the_paid_answer() {
        let (dir, s, backend) = setup().await;
        let mut request = creative_request(&s).await;
        request.execution_limits = Some(RunExecutionLimits {
            retry_policy: RunRetryPolicy::None,
            dispatch_not_after_ms: None,
        });
        backend.judge_listing_refusals.store(1, Ordering::SeqCst);
        let run = s.start_run(request).await.unwrap();
        s.tick().await.unwrap();
        let mut waiting = s.store.attempt(&run.attempts[0].id).await.unwrap();
        assert_eq!(waiting.phase, AWAITING_JUDGES);
        assert!(judge_discovery_waiting(&waiting));
        assert!(waiting.wait_until.is_some());
        assert!(waiting.output.is_some());
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "running");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
        let output = waiting.output.clone();
        let session = waiting.session_id.clone();
        // Ticking before the retry time neither probes nor sends a judge prompt.
        waiting.wait_until = Some(now() + 60_000);
        s.store.save_attempt(&waiting).await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
        assert_eq!(
            s.store.attempt(&waiting.id).await.unwrap().wait_until,
            waiting.wait_until
        );
        waiting.wait_until = Some(now() - 1);
        s.store.save_attempt(&waiting).await.unwrap();
        admission_window::expire_wait(&s.store.root.display().to_string());
        s.tick().await.unwrap();
        let judged = s.store.attempt(&waiting.id).await.unwrap();
        assert_eq!(judged.phase, "terminal");
        assert!(judged.reason.is_none());
        assert!(judged.wait_until.is_none());
        assert_eq!(judged.output, output);
        assert_eq!(judged.session_id, session);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        dir.close().await;
    }

    #[tokio::test]
    async fn a_waiting_judge_retries_within_the_tick_when_preparation_capacity_returns() {
        let (dir, s, backend) = setup().await;
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        let mut waiting = run.attempts[0].clone();
        waiting.phase = AWAITING_JUDGES.into();
        waiting.outcome = Some("pending_review".into());
        waiting.output = Some(creative().evaluator.known_good);
        waiting.reason = Some(JUDGE_DISCOVERY_WAIT.into());
        waiting.wait_until = None;
        s.store.save_attempt(&waiting).await.unwrap();
        // This same tick already tried the panel while another preparation
        // occupied the window. Other runs can keep that tick open indefinitely.
        let mut tried = std::collections::HashSet::from([waiting.id.clone()]);
        let mut flights = tokio::task::JoinSet::new();
        let scope = s.store.root.display().to_string();
        let preparing = admission_window::begin(&scope, "other-preparation").unwrap();
        s.fill(&mut flights, &mut tried).await.unwrap();
        assert!(
            flights.is_empty(),
            "a full preparation window must not be polled"
        );
        drop(preparing);
        // Reuse the tick's tried set: a new tick must not be needed to judge.
        s.fill(&mut flights, &mut tried).await.unwrap();
        assert_eq!(
            flights.len(),
            1,
            "the waiting panel must resume in this tick"
        );
        while let Some(result) = flights.join_next().await {
            result.unwrap();
        }
        let settled = s.store.attempt(&waiting.id).await.unwrap();
        assert_eq!(settled.phase, "terminal");
        assert_eq!(settled.output, waiting.output);
        assert!(settled.reason.is_none());
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        dir.close().await;
    }

    #[tokio::test]
    async fn busy_judges_and_renderers_retry_within_a_long_tick_without_polling() {
        for reason in [JUDGES_BUSY, RENDERER_BUSY] {
            let (dir, s, backend) = setup().await;
            let run = s.start_run(creative_request(&s).await).await.unwrap();
            let mut waiting = run.attempts[0].clone();
            waiting.phase = AWAITING_JUDGES.into();
            waiting.outcome = Some("pending_review".into());
            waiting.output = Some(creative().evaluator.known_good);
            waiting.reason = Some(reason.into());
            // Includes old saved waits that had no deadline and were already
            // tried in this tick while another run kept it open.
            s.store.save_attempt(&waiting).await.unwrap();
            let mut tried = std::collections::HashSet::from([waiting.id.clone()]);
            let mut flights = tokio::task::JoinSet::new();
            backend
                .busy_judges
                .store(reason == JUDGES_BUSY, Ordering::SeqCst);
            backend
                .busy_renderer
                .store(reason == RENDERER_BUSY, Ordering::SeqCst);
            s.fill(&mut flights, &mut tried).await.unwrap();
            assert_eq!(flights.len(), 1, "{reason}");
            while let Some(result) = flights.join_next().await {
                result.unwrap();
            }
            waiting = s.store.attempt(&waiting.id).await.unwrap();
            assert_eq!(waiting.phase, AWAITING_JUDGES);
            assert!(waiting.wait_until.unwrap() > now());
            s.fill(&mut flights, &mut tried).await.unwrap();
            assert!(flights.is_empty(), "busy panels must not spin");
            backend.busy_judges.store(false, Ordering::SeqCst);
            backend.busy_renderer.store(false, Ordering::SeqCst);
            waiting.wait_until = Some(now() - 1);
            s.store.save_attempt(&waiting).await.unwrap();
            s.fill(&mut flights, &mut tried).await.unwrap();
            assert_eq!(flights.len(), 1);
            while let Some(result) = flights.join_next().await {
                result.unwrap();
            }
            let settled = s.store.attempt(&waiting.id).await.unwrap();
            assert_eq!(settled.phase, "terminal");
            assert_eq!(settled.output, waiting.output);
            assert!(settled.reason.is_none());
            assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
            assert_eq!(backend.judges.load(Ordering::SeqCst), 2);
            dir.close().await;
        }
    }

    #[tokio::test]
    async fn judge_preparation_contention_never_parks_the_resource_queue() {
        let (dir, s, backend) = setup().await;
        let scope = s.store.root.display().to_string();
        let first = prepare_judge(&scope, "judge:invented").unwrap();
        admission_window::admitted(&scope, "judge:invented");
        let a = admission_window::begin(&scope, "other-a").unwrap();
        let b = admission_window::begin(&scope, "other-b").unwrap();
        admission_window::finished(&scope, "judge:invented");
        let error = prepare_judge(&scope, "judge:invented").err().unwrap();
        assert_eq!(error.code, JUDGE_ADMISSION_WAIT);
        assert!(!unstarted_refusal(&error));
        drop((first, a, b));
        assert!(admission_window::has_room(&scope));
        assert!(admission_window::remaining(&scope).is_zero());
        // Exercise the caller too: a local wait must not become a global
        // sandbox refusal when the backend returns it between judge seats.
        backend.judge_admission_waits.store(1, Ordering::SeqCst);
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let waiting = s.store.attempt(&run.attempts[0].id).await.unwrap();
        assert_eq!(waiting.phase, AWAITING_JUDGES);
        assert!(judge_discovery_waiting(&waiting));
        assert!(waiting.wait_until.is_none());
        assert!(admission_window::remaining(&scope).is_zero());
        s.tick().await.unwrap();
        let settled = s.store.attempt(&waiting.id).await.unwrap();
        assert_eq!(settled.phase, "terminal");
        assert_eq!(settled.output, waiting.output);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        dir.close().await;
    }

    #[test]
    fn a_judge_that_turns_busy_defers_the_batch_to_its_run() {
        assert_eq!(panel_reason(PanelEnd::Busy, 1, 3, false), Some(JUDGES_BUSY));
        assert_eq!(
            panel_reason(PanelEnd::Busy, 1, 3, true),
            Some(JUDGING_STOPPED)
        );
        assert_eq!(
            panel_reason(PanelEnd::Stopped, 1, 3, false),
            Some(JUDGING_STOPPED)
        );
        assert_eq!(
            panel_reason(PanelEnd::Incomplete, 1, 3, false),
            Some(PANEL_INCOMPLETE)
        );
        assert_eq!(panel_reason(PanelEnd::Asked, 3, 3, false), None);
        // The run keeps such an attempt waiting for its panel.
        let reason = |end: PanelEnd| {
            let mut attempt: Attempt = serde_json::from_value(json!({
                "id": "a", "runId": "r", "versionId": "v", "repetition": 0,
                "phase": "collecting", "configuration": judge_row("sonnet"),
                "usage": TokenUsage::default(), "evaluations": [], "eventCursor": 0
            }))
            .unwrap();
            attempt.reason = panel_reason(end, 1, 3, false).map(str::to_owned);
            judging_deferred(&attempt)
        };
        assert!(reason(PanelEnd::Busy));
        assert!(!reason(PanelEnd::Incomplete));
    }
}
