//! What the infrastructure breaks, a run mends by itself: a check the sandbox
//! ended runs again on the sealed answer, a turn an infrastructure failure
//! ended is measured again as a fresh try, and resuming a run checks an
//! answer whose check never gave a verdict instead of paying for another.
use super::super::tests::{serial_request, setup};
use super::*;
use crate::services::benchmarks::runner::*;
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
        .filter(|a| !super::super::super::analysis::is_superseded(a))
        .collect()
}

fn set_aside(run: &BenchmarkRun) -> Vec<&Attempt> {
    run.attempts
        .iter()
        .filter(|a| super::super::super::analysis::is_superseded(a))
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

/// 11-16: a paired probe past its own memory ceiling had been recorded as the
/// sandbox's failure, so three answers stood unscored. Once the sandbox named
/// the ceiling the candidate's, resuming still left them evaluator errors:
/// the run stopped again and asked for another resume, which could only
/// repeat the same check.
#[tokio::test]
async fn resuming_scores_an_answer_whose_check_passes_the_candidates_own_ceiling() {
    let (dir, service, backend) = setup().await;
    backend
        .evaluation_infrastructure_failures
        .store(u64::from(CHECK_RERUNS) + 1, Ordering::SeqCst);
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let stopped = settle(&service, &run.id).await;
    let unscored = stopped.attempts[0].clone();
    assert_eq!(unscored.outcome.as_deref(), Some("evaluation_error"));

    backend
        .evaluation_candidate_limits
        .store(1, Ordering::SeqCst);
    service.control(&run.id, "resume").await.unwrap();
    let resumed = settle(&service, &run.id).await;
    assert_eq!(resumed.state, "completed");
    assert_eq!(resumed.attempts.len(), 1);
    let checked = &resumed.attempts[0];
    assert_eq!(checked.id, unscored.id);
    // The answer past its budget: a measurement, scored 0, nothing to resume.
    assert_eq!(checked.outcome.as_deref(), Some("budget_reached"));
    assert_eq!(super::super::super::analysis::score(checked), Some(0.0));
    assert_eq!(
        backend.evaluation_candidate_limits.load(Ordering::SeqCst),
        0,
        "the check was not asked again"
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    // No run stays open on it, and no notice asks for attention.
    let listed = service.store.runs().await.unwrap();
    let summary = listed.iter().find(|entry| entry.id == run.id).unwrap();
    assert!(summary.attention.is_none(), "{:?}", summary.attention);
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
        manifest: crate::services::benchmarks::seeds::definitions().remove(0),
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

/// 11-24: the store refused the save that keeps a checked answer's verdict
/// (one BEGIN IMMEDIATE in four failed), the worker's failure settled the paid
/// answer as an infrastructure failure, and resuming bought another turn for
/// it. It now settles unscored, and resuming checks the same sealed answer.
#[tokio::test]
async fn a_verdict_the_store_could_not_keep_is_checked_again_never_bought_again() {
    let (dir, service, backend) = setup().await;
    // The store refuses every save that carries a check's verdict.
    sqlx::query("CREATE TRIGGER refuse_verdicts BEFORE UPDATE ON attempts WHEN json_array_length(NEW.data_json,'$.evaluations')>0 BEGIN SELECT RAISE(ABORT,'invented disk failure'); END")
        .execute(&service.store.pool)
        .await
        .unwrap();
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let stopped = settle(&service, &run.id).await;
    let unscored = stopped.attempts[0].clone();
    assert_eq!(unscored.phase, "terminal");
    assert_eq!(unscored.outcome.as_deref(), Some("evaluation_error"));
    assert!(unscored
        .reason
        .as_deref()
        .unwrap()
        .starts_with(CHECK_NOT_KEPT));
    assert!(unscored.evidence_hash.is_some());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);

    sqlx::query("DROP TRIGGER refuse_verdicts")
        .execute(&service.store.pool)
        .await
        .unwrap();
    service.control(&run.id, "resume").await.unwrap();
    let resumed = settle(&service, &run.id).await;
    assert_eq!(resumed.state, "completed");
    assert_eq!(
        resumed.attempts.len(),
        1,
        "the answer was set aside and measured again"
    );
    assert_eq!(resumed.attempts[0].id, unscored.id);
    assert_eq!(resumed.attempts[0].outcome.as_deref(), Some("pass"));
    assert_eq!(
        backend.calls.load(Ordering::SeqCst),
        1,
        "resume paid for a second answer"
    );
    dir.close().await;
}

/// The same when the store fails while the sealed answer is being checked:
/// the try failed with `storage_unavailable`, which settled the paid answer
/// with that outcome, and resuming bought another turn. It now settles
/// unscored; the run still stops for the operator, whose resume checks it.
#[tokio::test]
async fn a_store_failure_during_a_check_keeps_the_sealed_answer_for_its_check() {
    let (dir, service, backend) = setup().await;
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let dispatched = run.attempts[0].clone();
    let version = service.store.version(&dispatched.version_id).await.unwrap();
    // As the native backend saves a finished turn before its check.
    let mut sealed = dispatched.clone();
    sealed.phase = "collecting".into();
    sealed.started_at = Some(now());
    sealed.host_run_id = Some(format!("fake-{}", sealed.id));
    sealed.observed = Some(sealed.configuration.clone());
    sealed.outcome = Some("completed".into());
    sealed.output = Some(version.manifest.evaluator.known_good.clone());
    sealed.finished_at = Some(now());
    sealed.evidence_hash = Some(
        crate::services::benchmarks::fixtures::seal(
            &service.store.root,
            &sealed,
            &json!({"provider":"isolated_e2e_fake"}),
        )
        .await
        .unwrap(),
    );
    service.store.save_attempt(&sealed).await.unwrap();
    service
        .try_failed(
            &run,
            &dispatched,
            &version,
            BenchmarkError::new("storage_unavailable", "invented disk failure"),
        )
        .await
        .unwrap();
    let stopped = service.store.run(&run.id).await.unwrap();
    assert_eq!(stopped.state, "needs_attention");
    assert_eq!(stopped.attempts[0].phase, "terminal");
    assert_eq!(
        stopped.attempts[0].outcome.as_deref(),
        Some("evaluation_error")
    );

    service.control(&run.id, "resume").await.unwrap();
    let resumed = settle(&service, &run.id).await;
    assert_eq!(
        resumed.attempts.len(),
        1,
        "the answer was set aside and measured again"
    );
    assert_eq!(resumed.attempts[0].outcome.as_deref(), Some("pass"));
    assert_eq!(
        backend.calls.load(Ordering::SeqCst),
        0,
        "resume paid for an answer"
    );
    dir.close().await;
}

/// 11-24: "could not record worker failure" released the seat and left the
/// attempt running with no flight, which only a restart picked up. Now the
/// flight keeps its seat and records the failure once the store takes it.
#[tokio::test]
async fn a_worker_failure_the_store_refused_is_recorded_once_it_takes_it() {
    let (dir, service, _backend) = setup().await;
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let mut attempt = run.attempts[0].clone();
    attempt.phase = "running".into();
    attempt.started_at = Some(now());
    service.store.save_attempt(&attempt).await.unwrap();
    let seat = Seat {
        id: &attempt.id,
        lane: "invented-lane",
        lane_slots: 1,
        account: "",
        account_slots: usize::MAX,
        model: "",
        model_slots: usize::MAX,
    };
    assert!(service.claim(&run.id, seat).await.is_some());
    // For a while the store refuses to settle anything.
    sqlx::query("CREATE TRIGGER refuse_settling BEFORE UPDATE ON attempts WHEN NEW.phase='terminal' BEGIN SELECT RAISE(ABORT,'invented disk failure'); END")
        .execute(&service.store.pool)
        .await
        .unwrap();
    let finishing = tokio::spawn({
        let service = service.clone();
        let id = attempt.id.clone();
        async move {
            service
                .finish_flight(
                    &id,
                    &id,
                    Ok(Err(BenchmarkError::new(
                        "storage_unavailable",
                        "invented store failure",
                    ))),
                )
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Still in flight: no run completes, pauses or is cancelled around it.
    assert!(!finishing.is_finished());
    assert_eq!(service.flying(&run.id).await, 1);
    assert_eq!(
        service.store.attempt(&attempt.id).await.unwrap().phase,
        "running"
    );

    sqlx::query("DROP TRIGGER refuse_settling")
        .execute(&service.store.pool)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(20), finishing)
        .await
        .expect("the failure was never recorded")
        .unwrap();
    let recorded = service.store.attempt(&attempt.id).await.unwrap();
    assert_eq!(recorded.phase, "terminal");
    assert_eq!(recorded.outcome.as_deref(), Some("infrastructure_failure"));
    assert_eq!(service.flying(&run.id).await, 0);
    dir.close().await;
}

/// measure_again superseded the failed try in one transaction and inserted
/// its replacement in another: a replacement the store refused lost that
/// repetition for good. Both now commit together or not at all.
#[tokio::test]
async fn a_replacement_the_store_refuses_leaves_the_failed_try_standing() {
    let (dir, service, _backend) = setup().await;
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let mut failed = run.attempts[0].clone();
    failed.phase = "terminal".into();
    failed.outcome = Some("infrastructure_failure".into());
    failed.reason = Some("The agent's bridge exited before this turn finished".into());
    failed.finished_at = Some(now());
    service.store.save_attempt(&failed).await.unwrap();
    sqlx::query("CREATE TRIGGER refuse_inserts BEFORE INSERT ON attempts BEGIN SELECT RAISE(ABORT,'invented disk failure'); END")
        .execute(&service.store.pool)
        .await
        .unwrap();
    assert!(service.measure_again(&run, failed.clone()).await.is_err());
    let after = service.store.run(&run.id).await.unwrap();
    assert_eq!(after.attempts.len(), 1);
    assert_eq!(
        after.attempts[0].outcome.as_deref(),
        Some("infrastructure_failure"),
        "the try was set aside with no replacement"
    );

    // Once the store takes writes again, the try is measured again as before.
    sqlx::query("DROP TRIGGER refuse_inserts")
        .execute(&service.store.pool)
        .await
        .unwrap();
    service.measure_again(&run, failed).await.unwrap();
    let after = service.store.run(&run.id).await.unwrap();
    assert_eq!(after.attempts.len(), 2);
    assert_eq!(after.attempts[0].outcome.as_deref(), Some("superseded"));
    assert_eq!(after.attempts[1].phase, "pending");
    assert_eq!(after.attempts[1].repetition, after.attempts[0].repetition);
    dir.close().await;
}

/// A finished turn as the native backend holds it right before it seals the
/// answer: dispatched, answered and saved as running, nothing sealed yet.
async fn answered_turn(service: &BenchmarkService, run: &BenchmarkRun) -> Attempt {
    let mut running = run.attempts[0].clone();
    running.phase = "running".into();
    running.started_at = Some(now());
    running.session_id = Some(format!("invented-session-{}", running.id));
    running.host_run_id = Some(format!("invented-turn-{}", running.id));
    running.observed = Some(running.configuration.clone());
    service.store.save_attempt(&running).await.unwrap();
    let version = service.store.version(&running.version_id).await.unwrap();
    let mut answered = running;
    answered.phase = "collecting".into();
    answered.outcome = Some("completed".into());
    answered.output = Some(version.manifest.evaluator.known_good.clone());
    answered.finished_at = Some(now());
    answered
}

/// 2026-11-25 audit, X-3: the save that records a sealed answer's evidence
/// hash failed, the try settled `storage_unavailable` with no hash on record,
/// and resuming the run bought another turn. The answer is now kept once the
/// store takes it, its try holding its seat meanwhile; from there a failure
/// leaves it to be checked again, never bought again.
#[tokio::test]
async fn a_sealed_answer_the_store_refused_is_kept_once_it_takes_it() {
    let (dir, service, backend) = setup().await;
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let mut answered = answered_turn(&service, &run).await;
    let id = answered.id.clone();
    // For a while the store refuses every save that carries a sealed answer.
    sqlx::query("CREATE TRIGGER refuse_sealed BEFORE UPDATE ON attempts WHEN json_extract(NEW.data_json,'$.evidenceHash') IS NOT NULL BEGIN SELECT RAISE(ABORT,'invented disk failure'); END")
        .execute(&service.store.pool)
        .await
        .unwrap();
    let keeping = tokio::spawn({
        let service = service.clone();
        async move {
            keep_sealed(
                &service.store,
                &mut answered,
                &json!({"provider": "invented-native"}),
                None,
            )
            .await
            .map(|()| answered)
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !keeping.is_finished(),
        "the try gave up on its paid answer: {:?}",
        keeping.await.unwrap().map(|kept| kept.evidence_hash)
    );
    assert!(service
        .store
        .attempt(&id)
        .await
        .unwrap()
        .evidence_hash
        .is_none());

    sqlx::query("DROP TRIGGER refuse_sealed")
        .execute(&service.store.pool)
        .await
        .unwrap();
    let kept = tokio::time::timeout(Duration::from_secs(20), keeping)
        .await
        .expect("the sealed answer was never kept")
        .unwrap()
        .expect("kept once the store takes it");
    let stored = service.store.attempt(&id).await.unwrap();
    assert!(stored.evidence_hash.is_some());
    assert_eq!(stored.evidence_hash, kept.evidence_hash);
    assert_eq!(stored.outcome.as_deref(), Some("completed"));

    // A store failure after that is the check's, which resuming makes again.
    let version = service.store.version(&stored.version_id).await.unwrap();
    service
        .try_failed(
            &run,
            &run.attempts[0],
            &version,
            BenchmarkError::new("storage_unavailable", "invented disk failure"),
        )
        .await
        .unwrap();
    service.control(&run.id, "resume").await.unwrap();
    let resumed = settle(&service, &run.id).await;
    assert_eq!(resumed.attempts.len(), 1, "the answer was measured again");
    assert_eq!(resumed.attempts[0].outcome.as_deref(), Some("pass"));
    assert_eq!(
        backend.calls.load(Ordering::SeqCst),
        0,
        "resume paid for a second answer"
    );
    dir.close().await;
}

/// Control: a store that takes the save keeps the sealed answer at once.
#[tokio::test]
async fn a_sealed_answer_is_kept_at_once_by_a_store_that_takes_it() {
    let (dir, service, _backend) = setup().await;
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let mut answered = answered_turn(&service, &run).await;
    tokio::time::timeout(
        Duration::from_secs(1),
        keep_sealed(
            &service.store,
            &mut answered,
            &json!({"provider": "invented-native"}),
            None,
        ),
    )
    .await
    .expect("kept without waiting")
    .unwrap();
    let stored = service.store.attempt(&answered.id).await.unwrap();
    assert_eq!(stored.evidence_hash, answered.evidence_hash);
    assert!(stored.evidence_hash.is_some());
    dir.close().await;
}

/// A run whose only cell ended unscored and stopped for the operator, and the
/// family of its case, for a resume to measure it again.
async fn stopped_unscored(service: &BenchmarkService) -> (BenchmarkRun, String) {
    let run = service.start_run(one_cell(service).await).await.unwrap();
    let mut failed = run.attempts[0].clone();
    failed.phase = "terminal".into();
    failed.outcome = Some("infrastructure_failure".into());
    failed.reason = Some("The agent's bridge exited before this turn finished".into());
    failed.finished_at = Some(now());
    service.store.save_attempt(&failed).await.unwrap();
    service
        .store
        .set_run_state(&run.id, "needs_attention")
        .await
        .unwrap();
    let family = service
        .store
        .version(&failed.version_id)
        .await
        .unwrap()
        .manifest
        .task_family;
    (run, family)
}

async fn reserve_for_campaign(service: &BenchmarkService, family: &str) {
    sqlx::query("INSERT INTO evaluation_reservations(kind,value,owner_kind,owner_id) VALUES('family',?,'workflow_campaign','invented-frozen-campaign')")
        .bind(family)
        .execute(&service.store.pool)
        .await
        .unwrap();
}

/// 2026-11-25 audit, X-6: since supersede and insert share a transaction, a
/// case a frozen workflow campaign reserved after its run started made every
/// resume of the run fail at that cell. Before, the first resume failed and
/// the next went on without the cell; now the resume goes on without it and
/// the try it set aside says why.
#[tokio::test]
async fn a_resume_goes_on_without_a_cell_a_frozen_campaign_reserved() {
    let (dir, service, backend) = setup().await;
    let (run, family) = stopped_unscored(&service).await;
    reserve_for_campaign(&service, &family).await;
    let resumed = service
        .control(&run.id, "resume")
        .await
        .expect("the resume goes on without the reserved cell");
    assert_eq!(resumed.state, "running");
    let after = service.store.run(&run.id).await.unwrap();
    assert_eq!(after.attempts.len(), 1, "a reserved case was queued again");
    assert_eq!(after.attempts[0].outcome.as_deref(), Some("superseded"));
    let reason = after.attempts[0].reason.as_deref().unwrap_or_default();
    assert!(reason.contains("frozen workflow campaign"), "{reason}");
    let settled = settle(&service, &run.id).await;
    assert_eq!(settled.state, "completed");
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    dir.close().await;
}

/// Control: a campaign that reserves another case leaves the resume as it
/// was, the cell set aside and measured again in one step.
#[tokio::test]
async fn a_resume_measures_again_a_cell_no_campaign_reserved() {
    let (dir, service, backend) = setup().await;
    let (run, _family) = stopped_unscored(&service).await;
    reserve_for_campaign(&service, "invented-other-family").await;
    service.control(&run.id, "resume").await.unwrap();
    let after = service.store.run(&run.id).await.unwrap();
    assert_eq!(after.attempts.len(), 2);
    assert_eq!(after.attempts[0].outcome.as_deref(), Some("superseded"));
    assert!(after.attempts[0]
        .reason
        .as_deref()
        .unwrap_or_default()
        .starts_with("Measured again on resume"));
    assert_eq!(after.attempts[1].phase, "pending");
    let settled = settle(&service, &run.id).await;
    assert_eq!(settled.state, "completed");
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    dir.close().await;
}

/// The fake backend's turns, sealed the way the native backend seals a turn:
/// its native time measured, then its evidence sealed and saved by
/// `keep_sealed`, which holds the try while the store refuses.
struct NativeSealing(Arc<FakeBackend>);

impl ExecutionBackend for NativeSealing {
    fn unsupported(&self, configuration: &Configuration, draft: &BenchmarkDraft) -> Option<String> {
        self.0.unsupported(configuration, draft)
    }
    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        refresh: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        self.0.inventory(provider, account, refresh)
    }
    fn execute<'a>(
        &'a self,
        store: &'a Store,
        attempt: Attempt,
        version: BenchmarkVersion,
        timeout: u32,
        cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            let root = collection_budget(&version.manifest)?.map(|lease| lease.root_id);
            let mut answered = self
                .0
                .execute(store, attempt, version, timeout, cancel)
                .await?;
            answered.native_execution_ms = answered.duration_ms;
            keep_sealed(
                store,
                &mut answered,
                &json!({"provider": "invented-native"}),
                root.as_deref(),
            )
            .await?;
            Ok(answered)
        })
    }
}

/// The wall budget, in seconds, of the workflow root below: its two steps
/// together take well under a second.
const ROOT_SECONDS: u32 = 5;

/// How long the store refuses a step's sealed answer: longer than the root's
/// whole wall budget.
const STEP_OUTAGE: Duration = Duration::from_secs(8);

/// A run of one two-step workflow root on the native wall clock, with
/// [`ROOT_SECONDS`] for its steps together, on [`NativeSealing`].
async fn wall_clock_workflow() -> (
    crate::test_support::TempRoot,
    Arc<BenchmarkService>,
    Arc<FakeBackend>,
    RunRequest,
) {
    let dir = crate::test_support::TempRoot::new();
    let store = Store::open(dir.path()).await.unwrap();
    dir.register(&store.pool);
    let fake = Arc::new(FakeBackend::default());
    let service = Arc::new(BenchmarkService {
        store,
        backend: Arc::new(NativeSealing(fake.clone())),
        wake: Default::default(),
        active: Default::default(),
        queries: Default::default(),
        app: None,
    });
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    draft.split = "train".into();
    draft.environment["nativeBudgetRecipe"] =
        json!(crate::services::benchmarks::artifact_context::CLOCK_RECIPE);
    draft.workflow = Some(WorkflowSpec {
        schema_version: 1,
        driver_revision: "invented-wall-clock-v1".into(),
        steps: vec![
            WorkflowStep {
                id: "plan".into(),
                prompt: "Produce a plan.".into(),
                include_previous_output: false,
                scope: None,
            },
            WorkflowStep {
                id: "answer".into(),
                prompt: "Produce the final structured answer.".into(),
                include_previous_output: true,
                scope: None,
            },
        ],
    });
    let definition = service.store.save_draft(None, None, draft).await.unwrap();
    let version = service.store.publish(&definition.id, 1).await.unwrap();
    let request = RunRequest {
        author_policy: None,
        request_key: "invented-wall-clock-workflow".into(),
        version_ids: vec![version.id],
        configurations: vec![Configuration {
            id: "fake-pass".into(),
            provider_id: "fake".into(),
            account_id: Some("isolated".into()),
            model_id: "fake-pass".into(),
            effort: None,
            fast_mode: None,
            billing_mode: "simulated".into(),
            execution_profile: "native_text".into(),
            inventory_revision: Some("fake-v1".into()),
            model_name: None,
        }],
        repetitions: 1,
        timeout_seconds: ROOT_SECONDS,
        max_executions: 2,
        preview: false,
        parallelism: Some(1),
        execution_limits: None,
        workflow_policy: None,
    };
    (dir, service, fake, request)
}

/// The store refuses every save of a workflow step that carries a sealed
/// answer, as a full disk or a held write lock would.
const REFUSE_SEALED_STEPS: &str = "CREATE TRIGGER refuse_sealed_steps BEFORE UPDATE ON workflow_steps WHEN json_extract(NEW.data_json,'$.evidenceHash') IS NOT NULL BEGIN SELECT RAISE(ABORT,'invented disk failure'); END";

/// 2026-11-25 audit 2, Y-1: while the store refused a step's sealed answer,
/// the wait ran on its workflow root's wall clock, and a wait longer than the
/// root had left ended the root `budget_timeout`, scored zero. The wait is
/// now credited to the root, as the time an idle root sits in the queue is.
#[tokio::test]
async fn a_step_answer_the_store_refused_costs_its_root_no_wall_time() {
    let (dir, service, fake, request) = wall_clock_workflow().await;
    sqlx::query(REFUSE_SEALED_STEPS)
        .execute(&service.store.pool)
        .await
        .unwrap();
    let run = service.start_run(request).await.unwrap();
    let mends = tokio::spawn({
        let pool = service.store.pool.clone();
        async move {
            tokio::time::sleep(STEP_OUTAGE).await;
            sqlx::query("DROP TRIGGER refuse_sealed_steps")
                .execute(&pool)
                .await
                .unwrap();
        }
    });
    let settled = settle(&service, &run.id).await;
    mends.await.unwrap();
    let root = &settled.attempts[0];
    // Both steps were answered once, and the root scored its answer.
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2, "{:?}", root.reason);
    assert_eq!(root.outcome.as_deref(), Some("pass"), "{:?}", root.reason);
    assert_eq!(
        crate::services::benchmarks::analysis::score(root),
        Some(1.0)
    );
    // The wait outlasted the root's whole budget, and the root got it back.
    let credited = service.store.root_credit_ms(&root.id).await.unwrap();
    assert!(
        credited > i64::from(ROOT_SECONDS) * 1000,
        "credited {credited} ms"
    );
    dir.close().await;
}

/// Control: with a store that takes every save the same root scores the same
/// and keeps its clock exactly as before: no credit, and its last step's
/// deadline is the root's own.
#[tokio::test]
async fn a_root_whose_store_takes_every_save_keeps_its_clock() {
    let (dir, service, fake, request) = wall_clock_workflow().await;
    let run = service.start_run(request).await.unwrap();
    let settled = settle(&service, &run.id).await;
    let root = &settled.attempts[0];
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2, "{:?}", root.reason);
    assert_eq!(root.outcome.as_deref(), Some("pass"), "{:?}", root.reason);
    assert_eq!(
        crate::services::benchmarks::analysis::score(root),
        Some(1.0)
    );
    let credits: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM budget_credits")
        .fetch_one(&service.store.pool)
        .await
        .unwrap();
    assert_eq!(credits, 0);
    let last = service
        .store
        .native_budget(&format!("workflow:{}:1", root.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        last.deadline_at_ms().unwrap(),
        last.root_started_at_ms + i64::from(ROOT_SECONDS) * 1000
    );
    dir.close().await;
}
