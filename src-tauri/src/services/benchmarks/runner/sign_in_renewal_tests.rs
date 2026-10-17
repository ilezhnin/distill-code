//! A test that waits for a sandbox sign-in renewal before any provider saw
//! it waits in the queue under every retry policy, as an unstarted admission
//! does: nothing paid is repeated, and the run goes on without the operator
//! once the renewal is done.
use super::tests::{serial_request, setup};
use super::unstarted_admission_tests::workflow_request;
use super::*;
use crate::services::provider_rate_limits::grok::BENCHMARK_BRIDGE_BUSY;
use std::sync::atomic::Ordering;

fn release(run: &str) {
    PROVIDER_HOLDS
        .lock()
        .unwrap()
        .remove(&(run.to_owned(), "fake".to_owned()));
}

#[tokio::test]
async fn a_renewal_wait_is_an_unstarted_admission_until_a_provider_saw_the_try() {
    let (dir, service, _) = setup().await;
    let run = service
        .start_run(serial_request(&service).await)
        .await
        .unwrap();
    let mut attempt = run.attempts[0].clone();
    attempt.phase = "preparing".into();
    let wait = host_error(format!("sign_in_wait: {BENCHMARK_BRIDGE_BUSY}"));
    assert_eq!(wait.code, SIGN_IN_WAIT);
    assert!(never_started(&attempt, &wait));
    let mut seen = attempt.clone();
    seen.session_id = Some("invented-session".into());
    assert!(!never_started(&seen, &wait));
    let quota = BenchmarkError::new(QUOTA_WAIT, "invented usage limit");
    assert!(!never_started(&attempt, &quota));
    dir.close().await;
}

/// The overnight Grok runs used no automatic retry: a renewal that waited for
/// other sessions must hold the cell, not stop the run for the operator.
#[tokio::test]
async fn a_renewal_wait_holds_a_cell_of_a_run_without_automatic_retry() {
    let (dir, service, backend) = setup().await;
    let mut request = serial_request(&service).await;
    request.repetitions = 1;
    request.max_executions = 1;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    backend.busy_sign_ins.store(1, Ordering::SeqCst);
    let run = service.start_run(request).await.unwrap();
    service.tick().await.unwrap();
    let waiting = service.store.run(&run.id).await.unwrap();
    assert_eq!(waiting.state, "running");
    let cell = &waiting.attempts[0];
    assert_eq!(cell.phase, "pending");
    assert_eq!(cell.outcome, None);
    assert_eq!(cell.reason.as_deref(), Some(BENCHMARK_BRIDGE_BUSY));
    assert!(cell.session_id.is_none() && cell.started_at.is_none());
    let until = provider_hold(&run.id, "fake").expect("a short hold");
    assert!(until <= now() + SIGN_IN_RETRY_MS);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    release(&run.id);
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    let done = service.store.run(&run.id).await.unwrap();
    assert_eq!(done.state, "completed");
    assert_eq!(done.attempts[0].outcome.as_deref(), Some("pass"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    dir.close().await;
}

/// A workflow whose first step waits for the renewal has not started: under
/// either retry policy it returns to the queue without its prepared step and
/// later runs as a first attempt.
#[tokio::test]
async fn a_workflow_waiting_for_a_renewal_at_its_first_step_starts_afresh() {
    for retry_policy in [RunRetryPolicy::None, RunRetryPolicy::Automatic] {
        let (dir, service, backend) = setup().await;
        backend.busy_sign_ins.store(1, Ordering::SeqCst);
        let run = service
            .start_run(workflow_request(&service, retry_policy).await)
            .await
            .unwrap();
        service.tick().await.unwrap();
        let waiting = service.store.run(&run.id).await.unwrap();
        assert_eq!(waiting.state, "running", "{retry_policy:?}");
        let root = &waiting.attempts[0];
        assert_eq!(root.phase, "pending", "{retry_policy:?}");
        assert_eq!(root.outcome, None);
        assert_eq!(root.reason.as_deref(), Some(BENCHMARK_BRIDGE_BUSY));
        assert!(root.workflow_steps.is_empty());
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        release(&run.id);
        for _ in 0..3 {
            service.tick().await.unwrap();
        }
        let done = service.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed", "{retry_policy:?}");
        let root = &done.attempts[0];
        assert_eq!(root.outcome.as_deref(), Some("pass"), "{retry_policy:?}");
        assert_eq!(root.workflow_steps.len(), 2);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        dir.close().await;
    }
}

/// A later step is never held back by a renewal that drains the account; it
/// meets the wait only when its own limit needs a renewal while other
/// sessions run. With automatic retry the workflow keeps its first step and
/// goes on. A run without automatic retry never sends a started workflow
/// again, so it stops for the operator as any refused later step does.
#[tokio::test]
async fn a_later_step_waiting_for_a_renewal_keeps_the_rules_of_its_retry_policy() {
    for retry_policy in [RunRetryPolicy::Automatic, RunRetryPolicy::None] {
        let (dir, service, backend) = setup().await;
        backend.busy_sign_in_after.store(1, Ordering::SeqCst);
        let run = service
            .start_run(workflow_request(&service, retry_policy).await)
            .await
            .unwrap();
        service.tick().await.unwrap();
        let after = service.store.run(&run.id).await.unwrap();
        let root = &after.attempts[0];
        assert!(root.workflow_steps[0].host_run_id.is_some());
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        if retry_policy == RunRetryPolicy::None {
            assert_eq!(after.state, "needs_attention");
            assert_eq!(root.phase, "terminal");
            assert_eq!(root.outcome.as_deref(), Some(SIGN_IN_WAIT));
            dir.close().await;
            continue;
        }
        assert_eq!(after.state, "running");
        assert_eq!(root.phase, "pending");
        release(&run.id);
        for _ in 0..3 {
            service.tick().await.unwrap();
        }
        let done = service.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        let root = &done.attempts[0];
        assert_eq!(root.outcome.as_deref(), Some("pass"));
        assert_eq!(root.workflow_steps.len(), 2);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        dir.close().await;
    }
}
