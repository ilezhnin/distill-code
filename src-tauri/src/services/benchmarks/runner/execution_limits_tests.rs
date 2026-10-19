use super::tests::{serial_request, setup};
use super::*;
use std::sync::atomic::Ordering;

async fn bounded_request(service: &BenchmarkService) -> RunRequest {
    let mut request = serial_request(service).await;
    request.repetitions = 1;
    request.max_executions = 1;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    request
}

#[tokio::test]
async fn execution_limits_quota_waits_then_dispatches_once_on_the_same_account() {
    // Before dispatch (the host saw the limit coming) and mid-turn (the
    // provider stopped an accepted turn): both wait for the reset and then
    // send the same attempt once, never on the other account.
    for accepted in [false, true] {
        let (dir, service, backend) = setup().await;
        *backend.accounts_of.lock().unwrap() = vec!["isolated".into(), "alternative".into()];
        if accepted {
            backend.accepted_quota_waits.store(1, Ordering::SeqCst);
        } else {
            backend.quota_waits.store(1, Ordering::SeqCst);
        }
        let run = service
            .start_run(bounded_request(&service).await)
            .await
            .unwrap();
        service.tick().await.unwrap();
        let held = service.store.run(&run.id).await.unwrap();
        assert_eq!(held.state, "running", "accepted {accepted}");
        assert_eq!(held.attempts.len(), 1);
        let waiting = &held.attempts[0];
        assert_eq!(waiting.phase, "pending");
        assert!(waiting.wait_until.is_some_and(|until| until > now()));
        // The unfinished turn is gone, so the next try is the cell's first.
        assert!(waiting.session_id.is_none() && waiting.host_run_id.is_none());
        assert!(waiting.phase_times.is_none());
        assert_eq!(waiting.usage.input, None);
        assert_eq!(
            waiting.configuration.account_id.as_deref(),
            Some("isolated")
        );
        // Nothing is sent before the reset.
        service.tick().await.unwrap();
        let sent = u64::from(accepted);
        assert_eq!(backend.calls.load(Ordering::SeqCst), sent);
        PROVIDER_HOLDS
            .lock()
            .unwrap()
            .retain(|(held, _), _| held != &run.id);
        for _ in 0..3 {
            service.tick().await.unwrap();
        }
        let completed = service.store.run(&run.id).await.unwrap();
        assert_eq!(completed.state, "completed", "accepted {accepted}");
        assert_eq!(completed.attempts.len(), 1);
        let attempt = &completed.attempts[0];
        assert_eq!(attempt.phase, "terminal");
        assert_eq!(attempt.outcome.as_deref(), Some("pass"));
        assert_eq!(
            attempt.configuration.account_id.as_deref(),
            Some("isolated")
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), sent + 1);
        dir.close().await;
    }
}

#[tokio::test]
async fn execution_limits_quota_after_an_evaluation_never_discards_the_turn() {
    for retry_policy in [RunRetryPolicy::None, RunRetryPolicy::Automatic] {
        let (dir, service, backend) = setup().await;
        *backend.accounts_of.lock().unwrap() = vec!["isolated".into(), "alternative".into()];
        backend.evaluated_quota_waits.store(1, Ordering::SeqCst);
        let mut request = bounded_request(&service).await;
        request.execution_limits.as_mut().unwrap().retry_policy = retry_policy;
        let run = service.start_run(request).await.unwrap();
        for _ in 0..3 {
            service.tick().await.unwrap();
        }
        let settled = service.store.run(&run.id).await.unwrap();
        // It settles where it stands: unmeasured, for the operator in a run
        // without retries.
        let none = retry_policy == RunRetryPolicy::None;
        assert_eq!(
            settled.state,
            if none { "needs_attention" } else { "completed" }
        );
        assert_eq!(settled.attempts.len(), 1);
        let attempt = &settled.attempts[0];
        assert_eq!(attempt.phase, "terminal", "{retry_policy:?}");
        assert_eq!(attempt.outcome.as_deref(), Some(QUOTA_WAIT));
        assert_eq!(attempt.evaluations.len(), 1);
        assert!(attempt.session_id.is_some() && attempt.host_run_id.is_some());
        assert_eq!(attempt.usage.input, Some(7));
        assert_eq!(
            attempt.configuration.account_id.as_deref(),
            Some("isolated")
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        dir.close().await;
    }
}

#[tokio::test]
async fn execution_limits_a_substituted_model_goes_again_on_the_same_attempt() {
    let (dir, service, backend) = setup().await;
    *backend.accounts_of.lock().unwrap() = vec!["isolated".into(), "alternative".into()];
    backend.wrong_selections.store(1, Ordering::SeqCst);
    let run = service
        .start_run(bounded_request(&service).await)
        .await
        .unwrap();
    service.tick().await.unwrap();
    let held = service.store.run(&run.id).await.unwrap();
    assert_eq!(held.state, "running");
    assert_eq!(held.attempts.len(), 1);
    let mut waiting = held.attempts[0].clone();
    // Nothing of the substituted session stays on the attempt.
    assert_eq!(waiting.phase, "pending");
    assert!(waiting.observed.is_none() && waiting.session_id.is_none());
    assert!(waiting.wait_until.is_some_and(|until| until > now()));
    assert_eq!(
        waiting.configuration.account_id.as_deref(),
        Some("isolated")
    );
    waiting.wait_until = None;
    service.store.save_attempt(&waiting).await.unwrap();
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    let completed = service.store.run(&run.id).await.unwrap();
    assert_eq!(completed.state, "completed");
    assert_eq!(completed.attempts.len(), 1);
    let attempt = &completed.attempts[0];
    assert_eq!(attempt.id, waiting.id);
    assert_eq!(attempt.outcome.as_deref(), Some("pass"));
    assert_eq!(
        attempt.observed.as_ref().unwrap().model_id,
        attempt.configuration.model_id
    );
    dir.close().await;
}

#[tokio::test]
async fn execution_limits_substitutions_that_persist_stop_for_the_operator_unsettled() {
    let (dir, service, backend) = setup().await;
    backend.wrong_selections.store(4, Ordering::SeqCst);
    let run = service
        .start_run(bounded_request(&service).await)
        .await
        .unwrap();
    for _ in 0..3 {
        service.tick().await.unwrap();
        let mut held = service.store.run(&run.id).await.unwrap().attempts[0].clone();
        held.wait_until = None;
        service.store.save_attempt(&held).await.unwrap();
    }
    let stopped = service.store.run(&run.id).await.unwrap();
    assert_eq!(stopped.state, "needs_attention");
    assert_eq!(stopped.attempts.len(), 1);
    assert_eq!(stopped.attempts[0].phase, "pending");
    assert!(stopped.attempts[0].outcome.is_none());
    assert_eq!(stopped.attempts[0].pre_answer_refusals, 3);
    // The bound survives the operator's resume: the same refusal once more
    // settles the cell instead of cycling forever.
    service.control(&run.id, "resume").await.unwrap();
    let mut held = service.store.run(&run.id).await.unwrap().attempts[0].clone();
    held.wait_until = None;
    service.store.save_attempt(&held).await.unwrap();
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    let settled = service.store.run(&run.id).await.unwrap();
    assert_eq!(settled.attempts.len(), 1);
    assert_eq!(settled.attempts[0].phase, "terminal");
    assert_eq!(
        settled.attempts[0].outcome.as_deref(),
        Some("selection_changed")
    );
    dir.close().await;
}

#[tokio::test]
async fn execution_limits_predispatch_refusals_wait_for_the_operator_unsettled() {
    let (dir, service, backend) = setup().await;
    backend.capability_refusals.store(1, Ordering::SeqCst);
    *backend.accounts_of.lock().unwrap() = vec!["isolated".into(), "alternative".into()];
    let run = service
        .start_run(bounded_request(&service).await)
        .await
        .unwrap();
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    let stopped = service.store.run(&run.id).await.unwrap();
    assert_eq!(stopped.state, "needs_attention");
    assert_eq!(stopped.attempts.len(), 1);
    // The runtime the host would not start waits for the operator; the
    // cell is never settled, so a resume sends the same attempt.
    assert_eq!(stopped.attempts[0].phase, "pending");
    assert!(stopped.attempts[0].outcome.is_none());
    assert_eq!(
        stopped.attempts[0].configuration.account_id.as_deref(),
        Some("isolated")
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    dir.close().await;
}

#[tokio::test]
async fn execution_limits_resume_keeps_receipts_and_only_runs_original_fresh_slots() {
    let (dir, service, backend) = setup().await;
    let mut request = bounded_request(&service).await;
    request.repetitions = 2;
    request.max_executions = 2;
    let run = service.start_run(request).await.unwrap();
    let mut accepted = run.attempts[0].clone();
    accepted.phase = "dispatching".into();
    accepted.started_at = Some(now());
    accepted.session_id = Some("invented-interrupted-session".into());
    accepted.host_run_id = Some("invented-interrupted-turn".into());
    accepted.usage.input = Some(4);
    service.store.save_attempt(&accepted).await.unwrap();
    service.store.recover().await.unwrap();
    service.tick().await.unwrap();
    let recovered = service.store.run(&run.id).await.unwrap();
    let first = recovered
        .attempts
        .iter()
        .find(|a| a.id == accepted.id)
        .unwrap();
    assert_eq!(first.outcome.as_deref(), Some("dispatch_uncertain"));
    assert_eq!(first.usage.input, Some(4));
    let saved = serde_json::to_value(first).unwrap();
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    service.control(&run.id, "resume").await.unwrap();
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    let resumed = service.store.run(&run.id).await.unwrap();
    assert_eq!(resumed.attempts.len(), 2);
    assert_eq!(
        serde_json::to_value(
            resumed
                .attempts
                .iter()
                .find(|a| a.id == accepted.id)
                .unwrap()
        )
        .unwrap(),
        saved
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        service.control(&run.id, "resume").await.unwrap_err().code,
        "retry_forbidden"
    );
    dir.close().await;
}

#[tokio::test]
async fn execution_limits_omitted_or_automatic_preserves_account_fallback() {
    for explicit in [false, true] {
        let (dir, service, backend) = setup().await;
        *backend.accounts_of.lock().unwrap() = vec!["isolated".into(), "alternative".into()];
        backend.accepted_quota_waits.store(1, Ordering::SeqCst);
        let mut request = bounded_request(&service).await;
        request.execution_limits = explicit.then_some(RunExecutionLimits {
            retry_policy: RunRetryPolicy::Automatic,
            dispatch_not_after_ms: None,
        });
        let run = service.start_run(request).await.unwrap();
        for _ in 0..4 {
            service.tick().await.unwrap();
        }
        let completed = service.store.run(&run.id).await.unwrap();
        assert_eq!(completed.state, "completed");
        assert_eq!(completed.attempts.len(), 1);
        assert_eq!(
            completed.attempts[0].configuration.account_id.as_deref(),
            Some("alternative")
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        dir.close().await;
    }
}

#[tokio::test]
async fn execution_limits_expiry_during_preview_creates_no_plan() {
    let (dir, service, backend) = setup().await;
    let mut request = bounded_request(&service).await;
    request
        .execution_limits
        .as_mut()
        .unwrap()
        .dispatch_not_after_ms = Some(now() + 40);
    backend.inventory_delay_ms.store(100, Ordering::SeqCst);
    assert_eq!(
        service.start_run(request).await.unwrap_err().code,
        "dispatch_deadline"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM run_plans")
        .fetch_one(&service.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    dir.close().await;
}

#[tokio::test]
async fn execution_limits_expired_pending_plan_cannot_dispatch_or_resume() {
    let (dir, service, backend) = setup().await;
    let mut request = bounded_request(&service).await;
    request
        .execution_limits
        .as_mut()
        .unwrap()
        .dispatch_not_after_ms = Some(now() + 60_000);
    let run = service.start_run(request).await.unwrap();
    let mut expired = run.request.clone();
    expired
        .execution_limits
        .as_mut()
        .unwrap()
        .dispatch_not_after_ms = Some(now() - 1);
    service
        .store
        .set_run_request(&run.id, &expired)
        .await
        .unwrap();
    service.tick().await.unwrap();
    let stopped = service.store.run(&run.id).await.unwrap();
    assert_eq!(
        stopped.attempts[0].outcome.as_deref(),
        Some("dispatch_deadline")
    );
    assert_eq!(stopped.attempts[0].phase, "terminal");
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        service.control(&run.id, "resume").await.unwrap_err().code,
        "dispatch_deadline"
    );
    dir.close().await;
}

#[tokio::test]
async fn execution_limits_wire_is_optional_and_rejects_unknown_policy() {
    let (dir, service, _) = setup().await;
    let request = serial_request(&service).await;
    let mut wire = serde_json::to_value(&request).unwrap();
    assert!(wire.get("executionLimits").is_none());
    assert!(serde_json::from_value::<RunRequest>(wire.clone())
        .unwrap()
        .automatic_retry());
    wire["executionLimits"] = json!({"retryPolicy":"none","dispatchNotAfterMs":123});
    let bounded: RunRequest = serde_json::from_value(wire.clone()).unwrap();
    assert!(!bounded.automatic_retry());
    assert!(bounded.require_dispatch_admission(122).is_ok());
    assert_eq!(
        bounded.require_dispatch_admission(123).unwrap_err().code,
        "dispatch_deadline"
    );
    wire["executionLimits"]["retryPolicy"] = json!("sometimes");
    assert!(serde_json::from_value::<RunRequest>(wire).is_err());
    dir.close().await;
}
