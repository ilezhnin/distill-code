//! Invented interrupted receipts exercise recovery without provider replays.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[derive(Default)]
struct RecoveryBackend {
    fake: FakeBackend,
    recoveries: AtomicU64,
    checks: AtomicU64,
    panic_check: AtomicBool,
    hold: AtomicBool,
    hold_admission: AtomicBool,
    entered: tokio::sync::Notify,
    finish: tokio::sync::Notify,
}

impl ExecutionBackend for RecoveryBackend {
    fn unsupported(&self, _: &Configuration, _: &BenchmarkDraft) -> Option<String> {
        None
    }
    fn paces_preparation(&self) -> bool {
        true
    }
    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        refresh: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        self.fake.inventory(provider, account, refresh)
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
            admission_window::admitted(&store.root.display().to_string(), &attempt.id);
            self.fake
                .execute(store, attempt, version, timeout, cancel)
                .await
        })
    }
    fn recover<'a>(
        &'a self,
        _: &'a Store,
        attempt: Attempt,
    ) -> BoxFuture<'a, Result<Option<Attempt>>> {
        Box::pin(async move {
            self.recoveries.fetch_add(1, Ordering::SeqCst);
            Ok((attempt.evidence_hash.is_some() && attempt.output.is_some()).then_some(attempt))
        })
    }
    fn evaluate_output<'a>(
        &'a self,
        draft: &'a BenchmarkDraft,
        output: &'a str,
    ) -> BoxFuture<'a, Result<Evaluation>> {
        Box::pin(async move {
            if draft.name == "Invented recovered checker" {
                self.checks.fetch_add(1, Ordering::SeqCst);
                if self.hold_admission.load(Ordering::SeqCst) {
                    self.entered.notify_one();
                    self.finish.notified().await;
                }
                sandbox::test_workload_admission(sandbox::ResourceClass::PairedCheck);
                self.entered.notify_one();
                assert!(
                    !self.panic_check.load(Ordering::SeqCst),
                    "invented checker panic"
                );
                if self.hold.load(Ordering::SeqCst) {
                    self.finish.notified().await;
                }
            }
            fake_evaluate(draft, output).await
        })
    }
    fn judge<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
        _: &'a BenchmarkVersion,
        _: JudgeStop,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            admission_window::admitted(
                &store.root.display().to_string(),
                &format!("judge:{}", attempt.id),
            );
            self.fake.judges.fetch_add(1, Ordering::SeqCst);
            attempt.outcome = Some("judged".into());
            Ok(attempt)
        })
    }
}

async fn setup() -> (
    crate::test_support::TempRoot,
    Arc<BenchmarkService>,
    Arc<RecoveryBackend>,
    BenchmarkRun,
) {
    let dir = crate::test_support::TempRoot::new();
    let store = Store::open(dir.path()).await.unwrap();
    dir.register(&store.pool);
    let backend = Arc::new(RecoveryBackend::default());
    backend.fake.turn_ms.store(1, Ordering::SeqCst);
    let service = Arc::new(BenchmarkService {
        store,
        backend: backend.clone(),
        wake: tokio::sync::Notify::new(),
        active: Default::default(),
        queries: Default::default(),
        app: None,
    });
    let mut request = tests::serial_request(&service).await;
    let mut draft = service
        .store
        .version(&request.version_ids[0])
        .await
        .unwrap()
        .manifest;
    draft.name = "Invented recovered checker".into();
    let definition = service.store.save_draft(None, None, draft).await.unwrap();
    let mut version = service.store.publish(&definition.id, 1).await.unwrap();
    // Only this isolated fake backend grades the invented repository fixture;
    // its blob still matches the manifest verified by the ordinary runner.
    version.manifest.evaluator.kind = super::super::repository::EVALUATOR.into();
    version.manifest.execution_profile = "protected_repository".into();
    version.content_hash = fixtures::publish_blob(&service.store.root, &version.manifest)
        .await
        .unwrap();
    sqlx::query("UPDATE benchmark_versions SET manifest_json=?,content_hash=? WHERE id=?")
        .bind(serde_json::to_string(&version.manifest).unwrap())
        .bind(&version.content_hash)
        .bind(&version.id)
        .execute(&service.store.pool)
        .await
        .unwrap();
    request.version_ids = vec![version.id];
    request.configurations[0].execution_profile = "protected_repository".into();
    request.configurations[0].inventory_revision = None;
    request.repetitions = 1;
    request.max_executions = 1;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    let run = service.start_run(request).await.unwrap();
    let mut sealed = run.attempts[0].clone();
    sealed.phase = "interrupted".into();
    sealed.outcome = Some("completed".into());
    sealed.output = Some(version.manifest.evaluator.known_good);
    sealed.evidence_hash = Some(
        fixtures::seal(&service.store.root, &sealed, &json!({}))
            .await
            .unwrap(),
    );
    service.store.save_attempt(&sealed).await.unwrap();
    let mut run = service.store.run(&run.id).await.unwrap();
    run.attempts[0] = service.store.attempt(&sealed.id).await.unwrap();
    (dir, service, backend, run)
}

async fn entered(backend: &RecoveryBackend) {
    tokio::time::timeout(Duration::from_secs(5), backend.entered.notified())
        .await
        .unwrap();
}

#[tokio::test]
async fn recovery_evaluation_does_not_block_other_candidates_or_judges() {
    let (dir, service, backend, recovered) = setup().await;
    backend.hold.store(true, Ordering::SeqCst);
    let mut request = tests::serial_request(&service).await;
    let mut draft = seed_definitions()
        .into_iter()
        .find(|draft| draft.work_class_id == "creative")
        .unwrap();
    request.request_key = "invented-light-beside-recovery".into();
    draft.name = "Invented light work beside recovery".into();
    draft.split = "train".into();
    let definition = service.store.save_draft(None, None, draft).await.unwrap();
    request.version_ids = vec![service.store.publish(&definition.id, 1).await.unwrap().id];
    request.repetitions = 1;
    request.max_executions = 4;
    let light = service.start_run(request).await.unwrap();
    let ticking = tokio::spawn({
        let service = service.clone();
        async move { service.tick().await }
    });
    entered(&backend).await;
    let progress = tokio::time::timeout(Duration::from_secs(3), async {
        while backend.fake.judges.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    let managed = service.flying(&recovered.id).await;
    // Always release the invented checker, including on a failed assertion.
    backend.finish.notify_one();
    tokio::time::timeout(Duration::from_secs(5), ticking)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        progress.is_ok(),
        "a recovered checker blocked eligible light generation and judging"
    );
    assert_eq!(
        managed, 1,
        "recovery must remain a managed flight while checking"
    );
    assert_eq!(
        backend.fake.calls.load(Ordering::SeqCst),
        1,
        "only the light candidate may execute"
    );
    assert_eq!(backend.fake.judges.load(Ordering::SeqCst), 1);
    assert_eq!(backend.recoveries.load(Ordering::SeqCst), 1);
    assert_eq!(
        service.store.run(&light.id).await.unwrap().attempts[0].phase,
        "terminal"
    );
    service.tick().await.unwrap();
    assert_eq!(
        backend.checks.load(Ordering::SeqCst),
        1,
        "settled evidence must not be evaluated twice"
    );
    assert!(service.active.lock().await.is_empty());
    dir.close().await;
}

#[tokio::test]
async fn recovery_evaluation_cancellation_preserves_sealed_output_and_releases_flight() {
    let (dir, service, backend, run) = setup().await;
    backend.hold.store(true, Ordering::SeqCst);
    let mut ticking = tokio::spawn({
        let service = service.clone();
        async move { service.tick().await }
    });
    entered(&backend).await;
    service.control(&run.id, "cancel").await.unwrap();
    let stopped = tokio::time::timeout(Duration::from_secs(3), &mut ticking).await;
    backend.finish.notify_one();
    if stopped.is_err() {
        ticking.await.unwrap().unwrap();
    }
    assert!(
        stopped.is_ok(),
        "cancel must reach the recovered local checker"
    );
    stopped.unwrap().unwrap().unwrap();
    let saved = service.store.attempt(&run.attempts[0].id).await.unwrap();
    assert_eq!(saved.phase, "terminal");
    assert_eq!(saved.outcome.as_deref(), Some("evaluation_error"));
    assert_eq!(saved.output, run.attempts[0].output);
    assert_eq!(saved.evidence_hash, run.attempts[0].evidence_hash);
    assert!(service.active.lock().await.is_empty());
    service.tick().await.unwrap();
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
    assert_eq!(backend.checks.load(Ordering::SeqCst), 1);
    assert!(admission_window::has_room(
        &admission_window::evaluation_scope(&service.store.root.display().to_string())
    ));
    dir.close().await;
}

#[tokio::test]
async fn recovery_evaluation_panic_preserves_receipt_and_does_not_replay() {
    let (dir, service, backend, run) = setup().await;
    backend.panic_check.store(true, Ordering::SeqCst);
    service.tick().await.unwrap();
    let saved = service.store.attempt(&run.attempts[0].id).await.unwrap();
    assert_eq!(saved.phase, "terminal");
    assert_eq!(saved.outcome.as_deref(), Some("infrastructure_failure"));
    assert_eq!(saved.output, run.attempts[0].output);
    assert_eq!(saved.evidence_hash, run.attempts[0].evidence_hash);
    assert!(saved.reason.unwrap().contains("panicked"));
    assert!(service.active.lock().await.is_empty());
    service.tick().await.unwrap();
    assert_eq!(backend.checks.load(Ordering::SeqCst), 1);
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
    assert!(admission_window::has_room(
        &admission_window::evaluation_scope(&service.store.root.display().to_string())
    ));
    dir.close().await;
}

#[tokio::test]
async fn recovery_evaluation_settles_stopped_runs_without_dispatch_or_state_changes() {
    for state in ["paused", "needs_attention", "cancelled", "completed"] {
        let (dir, service, backend, run) = setup().await;
        service.store.set_run_state(&run.id, state).await.unwrap();
        service.tick().await.unwrap();
        let saved = service.store.run(&run.id).await.unwrap();
        assert_eq!(saved.state, state);
        assert_eq!(saved.attempts[0].phase, "terminal");
        assert_eq!(saved.attempts[0].outcome.as_deref(), Some("pass"));
        assert_eq!(
            saved.attempts[0].evidence_hash,
            run.attempts[0].evidence_hash
        );
        assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
        assert_eq!(backend.fake.judges.load(Ordering::SeqCst), 0);
        dir.close().await;
    }
}

#[tokio::test]
async fn recovery_evaluation_is_unique_and_restart_checks_the_same_receipt() {
    let (dir, service, backend, run) = setup().await;
    backend.hold_admission.store(true, Ordering::SeqCst);
    let mut waiting = run.attempts[0].clone();
    waiting.wait_until = Some(now() - 1);
    waiting.reason = Some(format!("{EVALUATION_WAIT}: invented broker wait"));
    service.store.save_attempt(&waiting).await.unwrap();
    let ticking = tokio::spawn({
        let service = service.clone();
        async move { service.tick().await }
    });
    entered(&backend).await;
    tokio::time::timeout(Duration::from_secs(2), service.tick())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(backend.recoveries.load(Ordering::SeqCst), 1);
    assert_eq!(service.flying(&run.id).await, 1);
    let reserved = !admission_window::has_room(&admission_window::evaluation_scope(
        &service.store.root.display().to_string(),
    ));

    // Dropping the runner models process shutdown, not a user cancel: the
    // interrupted receipt must remain recoverable by the next service.
    ticking.abort();
    assert!(ticking.await.unwrap_err().is_cancelled());
    drop(service);
    assert!(
        reserved,
        "a duplicate recovery probe removed the active checker's preparation"
    );
    backend.hold_admission.store(false, Ordering::SeqCst);
    let store = Store::open(dir.path()).await.unwrap();
    dir.register(&store.pool);
    let restarted = Arc::new(BenchmarkService {
        store,
        backend: backend.clone(),
        wake: tokio::sync::Notify::new(),
        active: Default::default(),
        queries: Default::default(),
        app: None,
    });
    restarted.store.recover().await.unwrap();
    restarted.tick().await.unwrap();
    let saved = restarted.store.attempt(&run.attempts[0].id).await.unwrap();
    assert_eq!(saved.phase, "terminal");
    assert_eq!(saved.outcome.as_deref(), Some("pass"));
    assert_eq!(saved.evidence_hash, run.attempts[0].evidence_hash);
    assert_eq!(saved.output, run.attempts[0].output);
    assert_eq!(saved.evaluations.len(), 1);
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
    assert_eq!(backend.checks.load(Ordering::SeqCst), 2);
    assert!(restarted.active.lock().await.is_empty());
    dir.close().await;
}

#[tokio::test]
async fn recovery_evaluation_drains_after_maintenance_failure_without_new_dispatch() {
    let (dir, service, backend, recovered) = setup().await;
    backend.hold.store(true, Ordering::SeqCst);
    let mut request = tests::serial_request(&service).await;
    request.request_key = "invented-work-after-maintenance-failure".into();
    let pending = service.start_run(request).await.unwrap();
    // Campaign maintenance fails after recovery has acquired its managed seat.
    sqlx::query("DROP TABLE schedules")
        .execute(&service.store.pool)
        .await
        .unwrap();
    let ticking = tokio::spawn({
        let service = service.clone();
        async move { service.tick().await }
    });
    entered(&backend).await;
    backend.finish.notify_one();
    assert!(ticking.await.unwrap().is_err());
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        service
            .store
            .attempt(&recovered.attempts[0].id)
            .await
            .unwrap()
            .outcome
            .as_deref(),
        Some("pass")
    );
    assert!(service
        .store
        .run(&pending.id)
        .await
        .unwrap()
        .attempts
        .iter()
        .all(|a| a.phase == "pending"));
    assert!(service.active.lock().await.is_empty());
    dir.close().await;
}
