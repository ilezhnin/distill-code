//! A text or repository turn hands its lane and account to the next attempt
//! of its configuration once its answer is sealed, so the run's checks no
//! longer stand between its turns. Turns of one lane never overlap, a lane
//! keeps at most as many checks waiting this way as it flies turns, and a
//! planning lab's turn keeps its seat until its verdict.
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
    cells_of(&mut request, cells, profile);
    request
}

/// The same cells of an invented planning lab.
async fn planning_cells(service: &BenchmarkService, cells: u32, profile: &str) -> RunRequest {
    let mut draft = seed_definitions().remove(0);
    draft.split = "train".into();
    draft.name = "Invented planning lab".into();
    draft.work_class_id = "planning".into();
    let definition = service.store.save_draft(None, None, draft).await.unwrap();
    let version = service.store.publish(&definition.id, 1).await.unwrap();
    let mut request = serial_request(service).await;
    request.request_key = format!("turn-seat-planning-{profile}-{cells}");
    request.version_ids = vec![version.id];
    cells_of(&mut request, cells, profile);
    request
}

fn cells_of(request: &mut RunRequest, cells: u32, profile: &str) {
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
    lane_turns_while_its_previous_answer_is_checked("native_text").await;
}

#[tokio::test]
async fn a_repository_lane_turns_while_its_previous_answer_is_checked() {
    lane_turns_while_its_previous_answer_is_checked("protected_repository").await;
}

async fn lane_turns_while_its_previous_answer_is_checked(profile: &str) {
    let (dir, service, backend) = setup().await;
    backend.hold_evaluations.store(true, Ordering::SeqCst);
    let run = service
        .start_run(serial_cells(&service, 3, profile).await)
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
    // Each attempt records when its check began, before its verdict.
    assert!(attempts.iter().all(|a| a
        .phase_times
        .as_ref()
        .and_then(|times| times.get("checkStarted"))
        .is_some_and(|at| *at >= a.finished_at.unwrap() && *at <= verdict_at(a))));
    assert_eq!(backend.peak_in_flight.load(Ordering::SeqCst), 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 3);
    dir.close().await;
}

#[tokio::test]
async fn a_planning_lab_keeps_its_seat_until_its_verdict() {
    let (dir, service, backend) = setup().await;
    backend.hold_evaluations.store(true, Ordering::SeqCst);
    let run = service
        .start_run(planning_cells(&service, 2, "protected_repository").await)
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
    assert!(checks_without_its_seat(&answer, &version));
    answer.configuration.execution_profile = "isolated_ui".into();
    assert!(!checks_without_its_seat(&answer, &version));
    answer.configuration.execution_profile = "native_text".into();
    let mut planning = version.clone();
    planning.manifest.work_class_id = "planning".into();
    assert!(!checks_without_its_seat(&answer, &planning));
    version.manifest.evaluator.kind = "rubric".into();
    assert!(!checks_without_its_seat(&answer, &version));
    dir.close().await;
}

/// The harness behind the throughput note: the same serial run of one
/// repository configuration with a check shorter than a turn, once as a
/// planning lab that keeps its seat and once as a lab that hands it on.
/// Prints both wall times (run with --nocapture to read them).
#[tokio::test]
async fn handing_the_seat_on_takes_the_checks_off_a_lanes_path() {
    let mut walls = Vec::new();
    for planning in [true, false] {
        let (dir, service, backend) = setup().await;
        backend.turn_ms.store(200, Ordering::SeqCst);
        backend.evaluation_ms.store(150, Ordering::SeqCst);
        let profile = "protected_repository";
        let request = if planning {
            planning_cells(&service, 6, profile).await
        } else {
            serial_cells(&service, 6, profile).await
        };
        let run = service.start_run(request).await.unwrap();
        let started = Instant::now();
        while service.store.run(&run.id).await.unwrap().state != "completed" {
            service.tick().await.unwrap();
        }
        let wall = started.elapsed();
        assert_eq!(backend.calls.load(Ordering::SeqCst), 6);
        assert_eq!(backend.peak_in_flight.load(Ordering::SeqCst), 1);
        eprintln!(
            "[turn-seat harness] {}: 6 cells, turn 200 ms, check 150 ms -> {} ms",
            if planning {
                "keeps its seat"
            } else {
                "hands it on"
            },
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
