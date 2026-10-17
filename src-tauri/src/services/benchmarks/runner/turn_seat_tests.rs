//! A text turn hands its lane and account to the next attempt of its
//! configuration once its answer is sealed, so the run's checks no longer
//! stand between its turns. Turns of one lane never overlap, a lane keeps at
//! most as many checks waiting this way as it flies turns, and a repository
//! turn keeps its seat until its verdict.
use super::tests::{serial_request, setup};
use super::*;
use std::sync::atomic::Ordering;

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what}"));
}

/// `cells` cells of one configuration, one turn at a time, no replay.
async fn serial_cells(service: &BenchmarkService, cells: u32, profile: &str) -> RunRequest {
    let mut request = serial_request(service).await;
    request.request_key = format!("turn-seat-{profile}-{cells}");
    request.repetitions = cells;
    request.max_executions = cells;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    let configuration = &mut request.configurations[0];
    configuration.execution_profile = profile.into();
    if profile != "native_text" {
        // The fake inventory lists text rows only; an unpinned row is checked
        // for readiness alone.
        configuration.inventory_revision = None;
    }
    request
}

/// Ticks until the run completes. A pass ends with its last flight, before
/// it fills again, and the pass after the last attempt settles the run.
async fn settle(service: &Arc<BenchmarkService>, run: &str) -> BenchmarkRun {
    for _ in 0..20 {
        let current = service.store.run(run).await.unwrap();
        if current.state == "completed" {
            return current;
        }
        service.tick().await.unwrap();
    }
    panic!("the run never completed");
}

fn by_start(mut attempts: Vec<Attempt>) -> Vec<Attempt> {
    attempts.sort_by_key(|attempt| attempt.started_at);
    attempts
}

fn verdict_at(attempt: &Attempt) -> i64 {
    attempt.evaluations[0].created_at
}

#[tokio::test]
async fn a_text_lane_turns_while_its_previous_answer_is_checked() {
    let (dir, service, backend) = setup().await;
    backend.hold_evaluations.store(true, Ordering::SeqCst);
    let run = service
        .start_run(serial_cells(&service, 3, "native_text").await)
        .await
        .unwrap();
    let ticking = tokio::spawn({
        let service = service.clone();
        async move { service.tick().await }
    });
    // The first answer waits in its check while the second turn runs, and
    // the second answer then waits too.
    until(
        "the second turn never ran while the first was checked",
        || {
            backend.calls.load(Ordering::SeqCst) == 2
                && backend.evaluations_entered.load(Ordering::SeqCst) == 2
        },
    )
    .await;
    // One check per lane slot waits without its seat: the second keeps its
    // seat, so the third turn does not start while both are checked.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    backend.evaluation_permits.fetch_add(3, Ordering::SeqCst);
    ticking.await.unwrap().unwrap();
    let attempts = by_start(settle(&service, &run.id).await.attempts);
    assert!(attempts
        .iter()
        .all(|a| a.phase == "terminal" && a.outcome.as_deref() == Some("pass")));
    let (first, second, third) = (&attempts[0], &attempts[1], &attempts[2]);
    // Claimed after the first turn ended, before its verdict.
    assert!(second.started_at >= first.finished_at);
    assert!(second.started_at.unwrap() < verdict_at(first));
    // Claimed only once the second check gave its seat back.
    assert!(third.started_at.unwrap() >= verdict_at(second));
    assert_eq!(backend.peak_in_flight.load(Ordering::SeqCst), 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 3);
    dir.close().await;
}

#[tokio::test]
async fn a_repository_turn_keeps_its_seat_until_its_verdict() {
    let (dir, service, backend) = setup().await;
    backend.hold_evaluations.store(true, Ordering::SeqCst);
    let run = service
        .start_run(serial_cells(&service, 2, "protected_repository").await)
        .await
        .unwrap();
    let ticking = tokio::spawn({
        let service = service.clone();
        async move { service.tick().await }
    });
    until("the first answer never reached its check", || {
        backend.evaluations_entered.load(Ordering::SeqCst) == 1
    })
    .await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    backend.evaluation_permits.fetch_add(2, Ordering::SeqCst);
    ticking.await.unwrap().unwrap();
    let attempts = by_start(settle(&service, &run.id).await.attempts);
    assert!(attempts[1].started_at.unwrap() >= verdict_at(&attempts[0]));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    dir.close().await;
}

#[tokio::test]
async fn only_sealed_objective_text_answers_are_checked_without_their_seat() {
    let (dir, service, _backend) = setup().await;
    let run = service
        .start_run(serial_cells(&service, 1, "native_text").await)
        .await
        .unwrap();
    let mut version = service
        .store
        .version(&run.attempts[0].version_id)
        .await
        .unwrap();
    let mut answer = run.attempts[0].clone();
    answer.outcome = Some("completed".into());
    answer.evidence_hash = Some("sealed".into());
    assert!(checks_without_its_seat(&answer, &version));
    for outcome in [None, Some("cancelled"), Some("budget_reached")] {
        let mut other = answer.clone();
        other.outcome = outcome.map(str::to_owned);
        assert!(!checks_without_its_seat(&other, &version));
    }
    let mut unsealed = answer.clone();
    unsealed.evidence_hash = None;
    assert!(!checks_without_its_seat(&unsealed, &version));
    answer.configuration.execution_profile = "protected_repository".into();
    assert!(!checks_without_its_seat(&answer, &version));
    answer.configuration.execution_profile = "native_text".into();
    version.manifest.evaluator.kind = "rubric".into();
    assert!(!checks_without_its_seat(&answer, &version));
    dir.close().await;
}

/// The harness behind the throughput note: the same serial run of one
/// configuration with a check shorter than a turn, once on a text lane that
/// hands its seat on and once on a repository lane that keeps it. Prints
/// both wall times (run with --nocapture to read them).
#[tokio::test]
async fn handing_the_seat_on_takes_the_checks_off_a_text_lanes_path() {
    let mut walls = Vec::new();
    for profile in ["protected_repository", "native_text"] {
        let (dir, service, backend) = setup().await;
        backend.turn_ms.store(200, Ordering::SeqCst);
        backend.evaluation_ms.store(150, Ordering::SeqCst);
        let run = service
            .start_run(serial_cells(&service, 6, profile).await)
            .await
            .unwrap();
        let started = Instant::now();
        while service.store.run(&run.id).await.unwrap().state != "completed" {
            service.tick().await.unwrap();
        }
        let wall = started.elapsed();
        assert_eq!(backend.calls.load(Ordering::SeqCst), 6);
        assert_eq!(backend.peak_in_flight.load(Ordering::SeqCst), 1);
        eprintln!(
            "[turn-seat harness] {profile}: 6 cells, turn 200 ms, check 150 ms -> {} ms",
            wall.as_millis()
        );
        walls.push(wall);
        dir.close().await;
    }
    // Keeping the seat: six turns plus six checks; handing it on: six turns
    // plus the last check.
    assert!(
        walls[1].as_secs_f64() < walls[0].as_secs_f64() * 0.9,
        "{walls:?}"
    );
}
