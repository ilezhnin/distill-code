//! What the infrastructure breaks, a run mends by itself: a check the sandbox
//! ended runs again on the sealed answer, a turn an infrastructure failure
//! ended is measured again as a fresh try, and resuming a run checks an
//! answer whose check never gave a verdict instead of paying for another.
use super::tests::{serial_request, setup};
use super::*;
use std::sync::atomic::Ordering;

/// One cell of an ordinary run, which allows retries.
async fn one_cell(service: &BenchmarkService) -> RunRequest {
    let mut request = serial_request(service).await;
    request.repetitions = 1;
    request.max_executions = 1;
    request
}

/// Ticks until the run leaves the running state, waiting out the short
/// pauses a replacement or a check takes before it asks again.
async fn settle(service: &Arc<BenchmarkService>, run_id: &str) -> BenchmarkRun {
    for _ in 0..200 {
        service.tick().await.unwrap();
        let run = service.store.run(run_id).await.unwrap();
        if run.state != "running" {
            return run;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the run never settled");
}

fn counted(run: &BenchmarkRun) -> Vec<&Attempt> {
    run.attempts
        .iter()
        .filter(|a| !super::super::analysis::is_superseded(a))
        .collect()
}

fn set_aside(run: &BenchmarkRun) -> Vec<&Attempt> {
    run.attempts
        .iter()
        .filter(|a| super::super::analysis::is_superseded(a))
        .collect()
}

#[tokio::test]
async fn a_check_the_sandbox_ended_runs_again_on_the_sealed_answer() {
    let (dir, service, backend) = setup().await;
    backend
        .evaluation_infrastructure_failures
        .store(u64::from(CHECK_RERUNS), Ordering::SeqCst);
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let settled = settle(&service, &run.id).await;
    assert_eq!(settled.state, "completed");
    let attempt = &settled.attempts[0];
    assert_eq!(settled.attempts.len(), 1);
    assert_eq!(attempt.outcome.as_deref(), Some("pass"));
    assert_eq!(attempt.evaluations.len(), 1);
    assert_eq!(attempt.reason, None);
    // The answer was asked for once and checked until the check held.
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        backend.evaluations.load(Ordering::SeqCst),
        u64::from(CHECK_RERUNS) + 1
    );
    dir.close().await;
}

#[tokio::test]
async fn resuming_checks_a_sealed_answer_again_instead_of_asking_the_model() {
    let (dir, service, backend) = setup().await;
    // One failure more than the check runs again by itself.
    backend
        .evaluation_infrastructure_failures
        .store(u64::from(CHECK_RERUNS) + 1, Ordering::SeqCst);
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let stopped = settle(&service, &run.id).await;
    let unscored = stopped.attempts[0].clone();
    assert_eq!(unscored.outcome.as_deref(), Some("evaluation_error"));
    assert!(unscored.evidence_hash.is_some());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);

    service.control(&run.id, "resume").await.unwrap();
    let resumed = settle(&service, &run.id).await;
    assert_eq!(resumed.state, "completed");
    assert_eq!(
        resumed.attempts.len(),
        1,
        "the answer was set aside and measured again"
    );
    let checked = &resumed.attempts[0];
    assert_eq!(checked.id, unscored.id);
    assert_eq!(checked.outcome.as_deref(), Some("pass"));
    assert_eq!(checked.evidence_hash, unscored.evidence_hash);
    assert_eq!(checked.evaluations.len(), 1);
    assert_eq!(
        backend.calls.load(Ordering::SeqCst),
        1,
        "resume paid for a second answer"
    );
    dir.close().await;
}

#[tokio::test]
async fn a_turn_an_infrastructure_failure_ended_is_measured_again_by_its_run() {
    let (dir, service, backend) = setup().await;
    backend
        .infrastructure_turn_failures
        .store(1, Ordering::SeqCst);
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let settled = settle(&service, &run.id).await;
    assert_eq!(settled.state, "completed");
    let failed = set_aside(&settled);
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].reason.as_deref(), Some(MEASURED_AGAIN));
    // The try keeps what it cost and what it sealed.
    assert_eq!(failed[0].usage.input, Some(7));
    assert!(failed[0].evidence_hash.is_some());
    let measured = counted(&settled);
    assert_eq!(measured.len(), 1);
    assert_eq!(measured[0].outcome.as_deref(), Some("pass"));
    assert_eq!(measured[0].repetition, failed[0].repetition);
    assert_eq!(measured[0].infrastructure_retries, 1);
    assert_eq!(measured[0].reason, None);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    dir.close().await;
}

#[tokio::test]
async fn a_test_that_keeps_failing_is_left_to_the_operator_after_its_tries() {
    let (dir, service, backend) = setup().await;
    backend
        .infrastructure_turn_failures
        .store(u64::MAX, Ordering::SeqCst);
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let settled = settle(&service, &run.id).await;
    assert_eq!(settled.state, "completed");
    assert_eq!(set_aside(&settled).len() as u32, INFRASTRUCTURE_RETRIES);
    let last = counted(&settled);
    assert_eq!(last.len(), 1);
    assert_eq!(last[0].outcome.as_deref(), Some("infrastructure_failure"));
    assert_eq!(last[0].infrastructure_retries, INFRASTRUCTURE_RETRIES);
    assert_eq!(
        backend.calls.load(Ordering::SeqCst),
        u64::from(INFRASTRUCTURE_RETRIES) + 1
    );
    dir.close().await;
}

#[tokio::test]
async fn a_run_that_forbids_retries_never_measures_a_failed_turn_again() {
    let (dir, service, backend) = setup().await;
    backend
        .infrastructure_turn_failures
        .store(1, Ordering::SeqCst);
    let mut request = one_cell(&service).await;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    let run = service.start_run(request).await.unwrap();
    let settled = settle(&service, &run.id).await;
    assert_eq!(settled.attempts.len(), 1);
    assert_eq!(
        settled.attempts[0].outcome.as_deref(),
        Some("infrastructure_failure")
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    dir.close().await;
}

#[tokio::test]
async fn a_provider_that_pushed_back_for_its_rate_is_asked_again_later() {
    let (dir, service, backend) = setup().await;
    backend
        .infrastructure_turn_failures
        .store(1, Ordering::SeqCst);
    *backend.infrastructure_turn_words.lock().unwrap() =
        Some("Internal error: Rate limit reached for requests".into());
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let asked = now();
    service.tick().await.unwrap();
    let waiting = service.store.run(&run.id).await.unwrap();
    assert_eq!(waiting.state, "running");
    let again = counted(&waiting);
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].phase, "pending");
    assert_eq!(again[0].reason.as_deref(), Some(MEASURING_AGAIN));
    assert!(
        again[0].wait_until.unwrap() >= asked + THROTTLED_RETRY_MS,
        "a rate limit is not asked again at once"
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    dir.close().await;
}

#[test]
fn only_a_failure_worth_asking_again_is_measured_again() {
    let request: RunRequest = serde_json::from_value(json!({
        "requestKey":"invented","versionIds":[],"configurations":[],
        "repetitions":1,"timeoutSeconds":60,"maxExecutions":1
    }))
    .unwrap();
    let version = BenchmarkVersion {
        id: "invented".into(),
        definition_id: "invented".into(),
        content_hash: "invented".into(),
        published_at: 0,
        manifest: seed_definitions().remove(0),
        carries_from: None,
    };
    let failed = |reason: &str, retries: u32| {
        let mut attempt = tests::blank_attempt();
        attempt.phase = "terminal".into();
        attempt.outcome = Some("infrastructure_failure".into());
        attempt.reason = Some(reason.into());
        attempt.infrastructure_retries = retries;
        attempt
    };
    let lost = "The agent's bridge exited before this turn finished";
    assert!(measured_again_by_itself(
        &request,
        &version,
        &failed(lost, 0),
        1
    ));
    // Its tries are spent.
    assert!(!measured_again_by_itself(
        &request,
        &version,
        &failed(lost, INFRASTRUCTURE_RETRIES),
        1
    ));
    // Failure after failure with nothing settled between: not this turn's.
    assert!(!measured_again_by_itself(
        &request,
        &version,
        &failed(lost, 0),
        INFRASTRUCTURE_STREAK
    ));
    // A balance no reset refills would only be refused again.
    assert!(!measured_again_by_itself(
        &request,
        &version,
        &failed(
            "Insufficient balance or no resource package. Please recharge.",
            0
        ),
        1
    ));
    // A model's own failed answer is its measurement.
    let mut answered = failed(lost, 0);
    answered.outcome = Some("fail".into());
    assert!(!measured_again_by_itself(&request, &version, &answered, 1));
    // A streak counts failures in a row and ends with any other turn.
    assert_eq!(infrastructure_streak("invented-run", "invented", true), 1);
    assert_eq!(infrastructure_streak("invented-run", "invented", true), 2);
    assert_eq!(infrastructure_streak("invented-run", "invented", false), 0);
    assert_eq!(infrastructure_streak("invented-run", "invented", true), 1);
    forget_quota_waits("invented-run");
    assert_eq!(infrastructure_streak("invented-run", "invented", true), 1);
    forget_quota_waits("invented-run");
}

/// Sealing a sitting that meets another writer waits for it: it reads each
/// attempt's reason before it writes, and SQLite refuses at once to upgrade a
/// read another connection's write has overtaken ("database is locked").
#[tokio::test]
async fn sealing_a_sitting_waits_for_a_concurrent_write_instead_of_failing() {
    let (dir, service, _backend) = setup().await;
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let mut writer = service
        .store
        .pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .unwrap();
    sqlx::query("INSERT INTO benchmark_events(entity_id,kind,created_at) VALUES(?,?,?)")
        .bind("invented-writer")
        .bind("concurrent_write")
        .bind(0_i64)
        .execute(&mut *writer)
        .await
        .unwrap();
    let sealing = tokio::spawn({
        let service = service.clone();
        let run = run.clone();
        async move { service.bake(&run, now()).await }
    });
    // Long enough for the sealing to read what it replaces.
    tokio::time::sleep(Duration::from_millis(500)).await;
    writer.commit().await.unwrap();
    sealing.await.unwrap().unwrap();
    let sealed = service.store.run(&run.id).await.unwrap();
    assert_eq!(sealed.state, "completed");
    assert_eq!(sealed.attempts[0].outcome.as_deref(), Some("superseded"));
    dir.close().await;
}
