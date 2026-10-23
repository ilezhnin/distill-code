use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

#[tokio::test]
async fn unstarted_judge_preparation_is_bounded_and_dropped() {
    struct Dropped<'a>(&'a AtomicBool);
    impl Drop for Dropped<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let dropped = AtomicBool::new(false);
    let execution = async {
        let _guard = Dropped(&dropped);
        std::future::pending::<Result<()>>().await
    };
    let error = bounded(
        execution,
        Duration::from_millis(40),
        Duration::from_millis(5),
        || async { Ok(Progress::default()) },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, PREPARATION_TIMEOUT);
    assert!(dropped.load(Ordering::SeqCst));
    assert!(
        !unstarted_refusal(&error),
        "a broken preparation must not retry forever"
    );
}

#[tokio::test]
async fn preparation_timeout_never_drops_a_paid_turn() {
    let execution = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        Ok(42)
    };
    assert_eq!(
        bounded(
            execution,
            Duration::from_millis(20),
            Duration::from_millis(5),
            || async {
                Ok(Progress {
                    completed: Vec::new(),
                    in_flight: true,
                })
            }
        )
        .await
        .unwrap(),
        42
    );
}

#[tokio::test]
async fn a_completed_vote_gives_the_next_seat_its_own_preparation_window() {
    let progress = Mutex::new(false);
    let execution = async {
        tokio::time::sleep(Duration::from_millis(40)).await;
        *progress.lock().unwrap() = true;
        tokio::time::sleep(Duration::from_millis(50)).await;
        Ok(42)
    };
    assert_eq!(
        bounded(
            execution,
            Duration::from_millis(70),
            Duration::from_millis(5),
            || async {
                Ok(Progress {
                    completed: if *progress.lock().unwrap() {
                        vec![("invented-vote".into(), 1)]
                    } else {
                        Vec::new()
                    },
                    in_flight: false,
                })
            }
        )
        .await
        .unwrap(),
        42
    );
}

#[tokio::test]
async fn a_blocked_judge_rpc_obeys_the_existing_turn_deadline() {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(20);
    let error = until(
        deadline,
        std::future::pending::<std::result::Result<(), String>>(),
    )
    .await
    .unwrap_err();
    assert!(error.contains("execution budget"));
    assert_eq!(
        until(
            tokio::time::Instant::now() + Duration::from_secs(1),
            async { Ok(42) }
        )
        .await
        .unwrap(),
        42
    );
}

async fn saved_answers() -> (
    crate::test_support::TempRoot,
    Arc<BenchmarkService>,
    BenchmarkRun,
) {
    let dir = crate::test_support::TempRoot::new();
    let store = Store::open(dir.path()).await.unwrap();
    dir.register(&store.pool);
    let service = Arc::new(BenchmarkService {
        store,
        backend: Arc::new(FakeBackend::default()),
        wake: tokio::sync::Notify::new(),
        active: Default::default(),
        queries: Default::default(),
        app: None,
    });
    let mut request = super::super::tests::creative_request(&service).await;
    request.repetitions = 2;
    request.max_executions = 8;
    let run = service.start_run(request).await.unwrap();
    for mut attempt in run.attempts {
        attempt.phase = AWAITING_JUDGES.into();
        attempt.outcome = Some("pending_review".into());
        attempt.output = Some("Invented paid answer".into());
        attempt.evidence_hash = Some("invented-evidence-hash".into());
        attempt.session_id = Some("invented-candidate-session".into());
        attempt.reason = Some(JUDGE_DISCOVERY_WAIT.into());
        service.store.save_attempt(&attempt).await.unwrap();
    }
    let run = full_run(&service, &run.id).await;
    (dir, service, run)
}

async fn full_run(service: &BenchmarkService, id: &str) -> BenchmarkRun {
    let mut run = service.store.run(id).await.unwrap();
    for attempt in &mut run.attempts {
        *attempt = service.store.attempt(&attempt.id).await.unwrap();
    }
    run
}

#[tokio::test]
async fn stalled_queue_pauses_normally_and_preserves_answers_without_new_calls() {
    let (dir, service, run) = saved_answers().await;
    let at = now();
    assert!(!check_queue(&service, &run, at).await.unwrap());
    let mut run = full_run(&service, &run.id).await;
    // Repeated scheduling probes must not renew the queue's deadline.
    for attempt in &mut run.attempts {
        mark_phase(attempt, "judgeStarted");
        mark_phase(attempt, "judgeFinished");
        service.store.save_attempt(attempt).await.unwrap();
    }
    assert!(check_queue(&service, &run, at + QUEUE_LIMIT_MS + 2000)
        .await
        .unwrap());
    assert_eq!(service.store.run_state(&run.id).await.unwrap(), "pausing");
    assert!(service
        .store
        .attempt(&run.attempts[0].id)
        .await
        .unwrap()
        .reason
        .unwrap()
        .contains("run paused after 10 min"));
    for original in &run.attempts {
        let current = service.store.attempt(&original.id).await.unwrap();
        assert_eq!(current.phase, AWAITING_JUDGES);
        assert_eq!(current.outcome.as_deref(), Some("pending_review"));
        assert_eq!(current.output, original.output);
        assert_eq!(current.session_id, original.session_id);
        assert_eq!(current.evidence_hash, original.evidence_hash);
        assert_eq!(
            serde_json::to_value(current.evaluations).unwrap(),
            serde_json::to_value(&original.evaluations).unwrap()
        );
    }
    assert_eq!(service.flying(&run.id).await, 0);
    dir.close().await;
}

#[tokio::test]
async fn quota_and_pause_waits_do_not_turn_into_queue_failures() {
    let (dir, service, run) = saved_answers().await;
    let at = now();
    check_queue(&service, &run, at).await.unwrap();
    let mut run = full_run(&service, &run.id).await;
    run.state = "paused".into();
    assert!(!check_queue(&service, &run, at + 100 * QUEUE_LIMIT_MS)
        .await
        .unwrap());
    run.state = "running".into();
    for attempt in &mut run.attempts {
        attempt.reason = Some(JUDGE_QUOTA_REASON.into());
        attempt.wait_until = Some(at + 200 * QUEUE_LIMIT_MS);
        service.store.save_attempt(attempt).await.unwrap();
    }
    assert!(!check_queue(&service, &run, at + 100 * QUEUE_LIMIT_MS)
        .await
        .unwrap());
    for attempt in &run.attempts {
        let current = service.store.attempt(&attempt.id).await.unwrap();
        assert_eq!(current.phase, AWAITING_JUDGES);
        assert!(!current.phase_times.unwrap().contains_key(QUEUE_SINCE));
    }
    // A resumed attempt begins a new active interval after the pause gap.
    let mut resumed = run.attempts[0].clone();
    resumed.reason = Some(JUDGE_DISCOVERY_WAIT.into());
    resumed.activity = Some(AttemptActivity {
        recorded_from: at,
        complete: true,
        spans: vec![
            ActivitySpan {
                kind: ActivityKind::Waiting,
                started_at: at,
                finished_at: Some(at + 10),
            },
            ActivitySpan {
                kind: ActivityKind::Waiting,
                started_at: at + 100 * QUEUE_LIMIT_MS,
                finished_at: None,
            },
        ],
    });
    assert_eq!(
        queue_since(&resumed, None, at + 100 * QUEUE_LIMIT_MS),
        Some(at + 100 * QUEUE_LIMIT_MS)
    );
    dir.close().await;
}

#[tokio::test]
async fn other_completed_judges_keep_a_long_backlog_healthy() {
    let (dir, service, run) = saved_answers().await;
    let at = now();
    check_queue(&service, &run, at).await.unwrap();
    let mut run = full_run(&service, &run.id).await;
    let version = service
        .store
        .version(&run.attempts[0].version_id)
        .await
        .unwrap();
    let mut evaluation = judge_abstention(
        &version,
        &run.attempts[0].configuration,
        "invented-batch",
        "Invented completed call".into(),
    );
    evaluation.created_at = at + QUEUE_LIMIT_MS;
    evaluation.details = Some(
        json!({"sessionId":"invented-judge-session", "requestKey":"invented-request", "durationMs":42, "usageComplete":true,"inFlight":false}),
    );
    run.attempts[0].evaluations.push(evaluation);
    service.store.save_attempt(&run.attempts[0]).await.unwrap();
    assert!(!check_queue(&service, &run, at + QUEUE_LIMIT_MS + 1000)
        .await
        .unwrap());
    assert_eq!(
        service
            .store
            .attempt(&run.attempts[1].id)
            .await
            .unwrap()
            .phase_times
            .unwrap()
            .get(QUEUE_SINCE),
        Some(&at),
        "a completed call must not rewrite every waiting answer's clock"
    );
    assert_eq!(
        service
            .store
            .attempt(&run.attempts[1].id)
            .await
            .unwrap()
            .phase,
        AWAITING_JUDGES
    );
    dir.close().await;
}

#[tokio::test]
async fn a_pause_after_the_scheduler_snapshot_keeps_all_answers_waiting() {
    let (dir, service, run) = saved_answers().await;
    let at = now();
    check_queue(&service, &run, at).await.unwrap();
    let run = full_run(&service, &run.id).await;
    service.control(&run.id, "pause").await.unwrap();
    assert!(!check_queue(&service, &run, at + QUEUE_LIMIT_MS + 2000)
        .await
        .unwrap());
    for original in &run.attempts {
        let current = service.store.attempt(&original.id).await.unwrap();
        assert_eq!(current.phase, AWAITING_JUDGES);
        assert_eq!(current.reason, original.reason);
    }
    dir.close().await;
}

#[tokio::test]
async fn a_pre_dispatch_abstention_does_not_reset_the_progress_clock() {
    let (dir, service, mut run) = saved_answers().await;
    let version = service
        .store
        .version(&run.attempts[0].version_id)
        .await
        .unwrap();
    let mut evaluation = judge_abstention(
        &version,
        &run.attempts[0].configuration,
        "invented-batch",
        "Selection was not acknowledged".into(),
    );
    evaluation.created_at = now();
    evaluation.details = Some(json!({"sessionId":"invented-session", "usageComplete":true}));
    run.attempts[0].evaluations.push(evaluation);
    assert_eq!(last_progress(&run), None);
    dir.close().await;
}
