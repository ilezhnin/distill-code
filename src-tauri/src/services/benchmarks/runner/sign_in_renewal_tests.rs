//! A test that waits for a sandbox sign-in renewal before any provider saw
//! it waits in the queue under every retry policy, as an unstarted admission
//! does: nothing paid is repeated, and the run goes on without the operator
//! once the renewal is done.
use super::tests::{serial_request, setup};
use super::unstarted_admission_tests::workflow_request;
use super::*;
use crate::services::provider_account_status::grok::BENCHMARK_BRIDGE_BUSY;
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
/// sessions run. Refused before any provider saw it, it waits in its step
/// loop for the renewal, as for sandbox room, under either retry policy:
/// the workflow keeps its paid first step, sends nothing again and goes on
/// (the overnight Grok workflow df5f6555 stopped here for the operator).
#[tokio::test]
async fn a_later_step_waiting_for_a_renewal_waits_in_its_workflow() {
    for retry_policy in [RunRetryPolicy::Automatic, RunRetryPolicy::None] {
        let (dir, service, backend) = setup().await;
        backend.busy_sign_in_after.store(1, Ordering::SeqCst);
        let run = service
            .start_run(workflow_request(&service, retry_policy).await)
            .await
            .unwrap();
        for _ in 0..3 {
            service.tick().await.unwrap();
        }
        let done = service.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed", "{retry_policy:?}");
        let root = &done.attempts[0];
        assert_eq!(root.outcome.as_deref(), Some("pass"), "{retry_policy:?}");
        assert_eq!(root.workflow_steps.len(), 2);
        assert!(root.workflow_steps[0].host_run_id.is_some());
        // The first step ran once; the refused try of the second sent
        // nothing, and its next try ran.
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2, "{retry_policy:?}");
        dir.close().await;
    }
}

/// Another run's turn the fake keeps open, so the tick `flights` and `tried`
/// stand for goes on, as under nonstop measurement. Its configuration runs
/// on `account`.
async fn keep_a_turn_in_flight(
    service: &Arc<BenchmarkService>,
    backend: &FakeBackend,
    account: &str,
    flights: &mut tokio::task::JoinSet<()>,
    tried: &mut std::collections::HashSet<String>,
) -> String {
    backend.hold_turns.store(true, Ordering::SeqCst);
    let mut other = serial_request(service).await;
    other.request_key = "invented-other-run".into();
    other.repetitions = 1;
    other.max_executions = 1;
    other.configurations[0].account_id = Some(account.into());
    let other = service.start_run(other).await.unwrap();
    service.fill(flights, tried).await.unwrap();
    in_flight(backend, 1).await;
    other.id
}

async fn in_flight(backend: &FakeBackend, turns: u64) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while backend.in_flight.load(Ordering::SeqCst) < turns {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("the turn must start");
}

/// One cell of a run under `retry_policy`, started after another run's turn
/// is already in flight and refused once by what `arm` sets up; returned
/// once its try has gone back to the queue.
async fn refused_once_beside_a_turn_in_flight(
    service: &Arc<BenchmarkService>,
    flights: &mut tokio::task::JoinSet<()>,
    tried: &mut std::collections::HashSet<String>,
    retry_policy: RunRetryPolicy,
    arm: impl FnOnce(),
) -> Attempt {
    let mut request = serial_request(service).await;
    request.request_key = "invented-refused-run".into();
    request.repetitions = 1;
    request.max_executions = 1;
    // Its one cell shares the held turn's lane (the same configuration): a
    // second seat lets it start beside that turn.
    request.parallelism = Some(2);
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy,
        dispatch_not_after_ms: None,
    });
    let run = service.start_run(request).await.unwrap();
    arm();
    service.fill(flights, tried).await.unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let cell = service.store.run(&run.id).await.unwrap().attempts.remove(0);
            if cell.phase == "pending" && tried.contains(&cell.id) {
                return cell;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("the refused try must go back to the queue")
}

/// The refused cell starts again within the same tick while the other turn
/// still flies; then both runs are cancelled.
async fn starts_again_within_the_tick(
    service: &Arc<BenchmarkService>,
    backend: &FakeBackend,
    flights: &mut tokio::task::JoinSet<()>,
    tried: &mut std::collections::HashSet<String>,
    runs: [&str; 2],
) {
    service.fill(flights, tried).await.unwrap();
    in_flight(backend, 2).await;
    for run in runs {
        service.control(run, "cancel").await.unwrap();
    }
    tokio::time::timeout(Duration::from_secs(30), async {
        while flights.join_next().await.is_some() {}
    })
    .await
    .expect("cancellation must settle both turns");
}

/// Run e4c31fd2 (2026-10-17): every cell of a Grok repository run went back
/// with a sign-in wait while other runs kept flying, so the tick never ended,
/// and the runner never asked those cells again after the renewal. A cell put
/// back with a sign-in wait records when it asks again, and the same tick
/// retries it once that time has passed, under either retry policy.
#[tokio::test]
async fn a_cell_waiting_for_a_renewal_is_retried_within_a_tick_that_goes_on() {
    for retry_policy in [RunRetryPolicy::None, RunRetryPolicy::Automatic] {
        let (dir, service, backend) = setup().await;
        let mut flights = tokio::task::JoinSet::new();
        let mut tried = std::collections::HashSet::new();
        let other =
            keep_a_turn_in_flight(&service, &backend, "isolated", &mut flights, &mut tried).await;
        let cell = refused_once_beside_a_turn_in_flight(
            &service,
            &mut flights,
            &mut tried,
            retry_policy,
            || backend.busy_sign_ins.store(1, Ordering::SeqCst),
        )
        .await;
        let until = cell
            .wait_until
            .expect("the wait records when it asks again");
        assert_eq!(provider_hold(&cell.run_id, "fake"), Some(until));
        // Before the wait is over nothing of the run starts again.
        service.fill(&mut flights, &mut tried).await.unwrap();
        assert_eq!(backend.in_flight.load(Ordering::SeqCst), 1);
        // The wait is over, as fifteen seconds later.
        release(&cell.run_id);
        let mut waited = cell.clone();
        waited.wait_until = Some(now() - 1);
        service.store.save_attempt(&waited).await.unwrap();
        starts_again_within_the_tick(
            &service,
            &backend,
            &mut flights,
            &mut tried,
            [&other, &cell.run_id],
        )
        .await;
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2, "{retry_policy:?}");
        dir.close().await;
    }
}

/// A test whose account ran out of usage moves to another account of the
/// provider and goes on at once, within the tick, while other turns fly.
#[tokio::test]
async fn a_cell_moved_to_another_account_starts_again_within_the_tick() {
    let (dir, service, backend) = setup().await;
    *backend.accounts_of.lock().unwrap() = vec!["isolated".into(), "second".into()];
    let mut flights = tokio::task::JoinSet::new();
    let mut tried = std::collections::HashSet::new();
    let other = keep_a_turn_in_flight(&service, &backend, "second", &mut flights, &mut tried).await;
    let cell = refused_once_beside_a_turn_in_flight(
        &service,
        &mut flights,
        &mut tried,
        RunRetryPolicy::Automatic,
        || *backend.spent_accounts.lock().unwrap() = vec!["isolated".into()],
    )
    .await;
    assert_eq!(cell.configuration.account_id.as_deref(), Some("second"));
    assert!(cell.wait_until.is_some_and(|until| until <= now()));
    starts_again_within_the_tick(
        &service,
        &backend,
        &mut flights,
        &mut tried,
        [&other, &cell.run_id],
    )
    .await;
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    dir.close().await;
}

/// A test refused because interactive work held its account asks again
/// shortly, within the tick, while other turns fly.
#[tokio::test]
async fn a_cell_refused_for_a_busy_account_is_retried_within_the_tick() {
    let (dir, service, backend) = setup().await;
    let mut flights = tokio::task::JoinSet::new();
    let mut tried = std::collections::HashSet::new();
    let other =
        keep_a_turn_in_flight(&service, &backend, "isolated", &mut flights, &mut tried).await;
    let cell = refused_once_beside_a_turn_in_flight(
        &service,
        &mut flights,
        &mut tried,
        RunRetryPolicy::Automatic,
        || backend.busy_accounts.store(1, Ordering::SeqCst),
    )
    .await;
    let until = cell
        .wait_until
        .expect("the refusal records when it asks again");
    assert!(until <= now() + ACCOUNT_BUSY_RETRY_MS);
    service.fill(&mut flights, &mut tried).await.unwrap();
    assert_eq!(backend.in_flight.load(Ordering::SeqCst), 1);
    let mut waited = cell.clone();
    waited.wait_until = Some(now() - 1);
    service.store.save_attempt(&waited).await.unwrap();
    starts_again_within_the_tick(
        &service,
        &backend,
        &mut flights,
        &mut tried,
        [&other, &cell.run_id],
    )
    .await;
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    dir.close().await;
}
