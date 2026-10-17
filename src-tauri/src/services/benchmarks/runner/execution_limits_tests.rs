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
async fn execution_limits_accepted_quota_never_retries_or_changes_account() {
    let (dir, service, backend) = setup().await;
    *backend.accounts_of.lock().unwrap() = vec!["isolated".into(), "alternative".into()];
    backend.accepted_quota_waits.store(1, Ordering::SeqCst);
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
    let attempt = &stopped.attempts[0];
    assert_eq!(attempt.phase, "terminal");
    assert_eq!(attempt.outcome.as_deref(), Some(QUOTA_WAIT));
    assert!(attempt
        .reason
        .as_deref()
        .unwrap()
        .contains("\"dispatchStarted\":true"));
    assert_eq!(
        attempt.configuration.account_id.as_deref(),
        Some("isolated")
    );
    assert_eq!(attempt.usage.input, Some(7));
    assert!(attempt.session_id.is_some() && attempt.host_run_id.is_some());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    let saved = serde_json::to_value(attempt).unwrap();
    assert_eq!(
        service.control(&run.id, "resume").await.unwrap_err().code,
        "retry_forbidden"
    );
    assert_eq!(
        service.extend_run(&run.id, &[]).await.unwrap_err().code,
        "retry_forbidden"
    );
    service.store.recover().await.unwrap();
    service.tick().await.unwrap();
    let recovered = service.store.run(&run.id).await.unwrap();
    assert_eq!(recovered.attempts.len(), 1);
    assert_eq!(serde_json::to_value(&recovered.attempts[0]).unwrap(), saved);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    dir.close().await;
}

#[tokio::test]
async fn execution_limits_predispatch_refusals_settle_without_retry() {
    for quota in [false, true] {
        let (dir, service, backend) = setup().await;
        if quota {
            backend.quota_waits.store(1, Ordering::SeqCst);
        } else {
            backend.capability_refusals.store(1, Ordering::SeqCst);
        }
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
        assert_eq!(stopped.attempts[0].phase, "terminal");
        assert_eq!(
            stopped.attempts[0].outcome.as_deref(),
            Some(if quota {
                QUOTA_WAIT
            } else {
                "capability_missing"
            })
        );
        assert_eq!(
            stopped.attempts[0].configuration.account_id.as_deref(),
            Some("isolated")
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        dir.close().await;
    }
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
