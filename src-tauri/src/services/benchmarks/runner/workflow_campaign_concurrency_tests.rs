//! Offline scheduling checks. No model calls or model-quality evidence.
use super::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{atomic::AtomicBool, Mutex},
};
use tokio::sync::oneshot;

#[path = "workflow_campaign_reservation_tests.rs"]
mod reservations;

#[derive(Default)]
struct GatedWorkers {
    workers: OfflineWorkers,
    gated: AtomicBool,
    waiting: Mutex<BTreeMap<String, (String, oneshot::Sender<()>)>>,
    started: Mutex<Vec<(String, String)>>,
    budgets: Mutex<BTreeMap<String, u32>>,
    setup_delay_ms: AtomicU64,
    preparing: AtomicU64,
    active: AtomicU64,
    peak: AtomicU64,
}

struct ActiveCall<'a>(&'a AtomicU64);
impl Drop for ActiveCall<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ExecutionBackend for GatedWorkers {
    fn unsupported(&self, c: &Configuration, d: &BenchmarkDraft) -> Option<String> {
        self.workers.unsupported(c, d)
    }
    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        force: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        self.workers.inventory(provider, account, force)
    }
    fn execute<'a>(
        &'a self,
        store: &'a Store,
        attempt: Attempt,
        version: BenchmarkVersion,
        timeout: u32,
        mut cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            let setup_delay = self.setup_delay_ms.load(Ordering::SeqCst);
            if setup_delay > 0 {
                self.preparing.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(setup_delay)).await;
                // Exercise the production dispatch gate after asynchronous
                // backend setup, before recording any fake worker dispatch.
                let budget = collection_budget(&version.manifest)?;
                turn_timeout_ms(timeout, budget.as_ref())?;
            }
            if *cancel.borrow() {
                return Err(BenchmarkError::new(
                    "cancelled",
                    "Offline worker cancelled before dispatch",
                ));
            }
            let _active = if version.manifest.task_family.starts_with("concurrent-") {
                let count = self.active.fetch_add(1, Ordering::SeqCst) + 1;
                self.peak.fetch_max(count, Ordering::SeqCst);
                self.started
                    .lock()
                    .unwrap()
                    .push((attempt.run_id.clone(), attempt.id.clone()));
                self.budgets
                    .lock()
                    .unwrap()
                    .insert(attempt.id.clone(), timeout);
                Some(ActiveCall(&self.active))
            } else {
                None
            };
            let receive = {
                let mut waiting = self.waiting.lock().unwrap();
                if self.gated.load(Ordering::SeqCst) {
                    let (send, receive) = oneshot::channel();
                    waiting.insert(attempt.id.clone(), (attempt.run_id.clone(), send));
                    Some(receive)
                } else {
                    None
                }
            };
            if let Some(receive) = receive {
                tokio::select! {
                    _ = receive => {},
                    _ = cancel.changed() => {
                        self.waiting.lock().unwrap().remove(&attempt.id);
                        return Err(BenchmarkError::new("cancelled", "Offline worker cancelled"));
                    },
                }
            }
            self.workers
                .execute(store, attempt, version, timeout, cancel)
                .await
        })
    }
}

async fn wait_until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(HANG_GUARD, async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}

async fn assert_running(service: &BenchmarkService, id: &str) {
    let campaign = service.store.workflow_campaign(id).await.unwrap();
    assert_eq!(campaign.state, "running", "{:?}", campaign.state_reason);
}

async fn wait_while_running(
    service: &BenchmarkService,
    id: &str,
    mut predicate: impl FnMut() -> bool,
) {
    tokio::time::timeout(HANG_GUARD, async {
        while !predicate() {
            assert_running(service, id).await;
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}

impl GatedWorkers {
    fn release_root(&self, run_id: &str) {
        let mut waiting = self.waiting.lock().unwrap();
        let id = waiting
            .iter()
            .find(|(_, (run, _))| run == run_id)
            .unwrap()
            .0
            .clone();
        let (_, release) = waiting.remove(&id).unwrap();
        release.send(()).unwrap();
    }
    fn drain(&self) {
        let mut waiting = self.waiting.lock().unwrap();
        self.gated.store(false, Ordering::SeqCst);
        for (_, (_, release)) in std::mem::take(&mut *waiting) {
            let _ = release.send(());
        }
    }
}

async fn service(root: &std::path::Path, backend: Arc<GatedWorkers>) -> Arc<BenchmarkService> {
    let store = Store::open(root).await.unwrap();
    store.recover().await.unwrap();
    Arc::new(BenchmarkService {
        store,
        backend,
        wake: Default::default(),
        active: Default::default(),
        app: None,
    })
}

async fn setup(
    parallelism: u32,
) -> (
    tempfile::TempDir,
    Arc<BenchmarkService>,
    Arc<GatedWorkers>,
    Campaign,
) {
    setup_with_timeout(parallelism, WALL_BUDGET_SECONDS).await
}

async fn setup_with_timeout(
    parallelism: u32,
    timeout_seconds: u32,
) -> (
    tempfile::TempDir,
    Arc<BenchmarkService>,
    Arc<GatedWorkers>,
    Campaign,
) {
    setup_with_accounts(parallelism, timeout_seconds, false).await
}

async fn setup_with_accounts(
    parallelism: u32,
    timeout_seconds: u32,
    separate_accounts: bool,
) -> (
    tempfile::TempDir,
    Arc<BenchmarkService>,
    Arc<GatedWorkers>,
    Campaign,
) {
    let dir = tempfile::tempdir().unwrap();
    let backend = Arc::new(GatedWorkers::default());
    let service = service(dir.path(), backend.clone()).await;
    // Undispatched timeouts have no provider cost receipt. These scheduling
    // checks compare quality and wall time, without inventing a zero cost.
    let (train, fit) = training_with_weights(
        &service,
        RoleWeights {
            quality: 0.85,
            speed: 0.15,
            cost: 0.0,
        },
    )
    .await;
    let roots = roots(&service, &train, "concurrent").await;
    let mut request = request(&fit, &roots, "concurrent-comparison");
    if separate_accounts {
        for candidate in &mut request.candidates {
            candidate.account_id = Some(format!("invented-{}-account", candidate.id));
        }
    }
    request.parallelism = Some(parallelism);
    request.timeout_seconds = timeout_seconds;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    let frozen = service.freeze_workflow_campaign(request).await.unwrap();
    backend.gated.store(true, Ordering::SeqCst);
    (dir, service, backend, frozen)
}

async fn children(service: &BenchmarkService, frozen: &Campaign) -> Vec<BenchmarkRun> {
    let mut result = Vec::new();
    for index in 0..frozen.plan.cells.len() {
        let key = frozen.plan.run_request(index).unwrap().request_key;
        let id: Option<String> = sqlx::query_scalar("SELECT id FROM run_plans WHERE request_key=?")
            .bind(key)
            .fetch_optional(&service.store.pool)
            .await
            .unwrap();
        if let Some(id) = id {
            result.push(service.store.run(&id).await.unwrap());
        }
    }
    result
}

// Recreate a persisted v2 contract in an isolated fixture. Installing v3 must
// neither reinterpret its queue clock nor change its idempotent freeze result.
async fn legacy_bounded_plan(service: &BenchmarkService, frozen: Campaign) -> Campaign {
    assert_eq!(frozen.plan.order_algorithm, STEP_ADMISSION_ORDER);
    let mut plan = frozen.plan;
    plan.order_algorithm = "sha256-campaign-cell-bounded-refill-v2".into();
    let plan_hash = crate::services::benchmarks::workflow_campaign::hash(&plan).unwrap();
    assert_ne!(plan_hash, frozen.plan_hash);
    sqlx::query("UPDATE workflow_campaigns SET plan_json=?,plan_hash=? WHERE id=?")
        .bind(serde_json::to_string(&plan).unwrap())
        .bind(&plan_hash)
        .bind(&plan.id)
        .execute(&service.store.pool)
        .await
        .unwrap();
    let retained = service
        .freeze_workflow_campaign(plan.request.clone())
        .await
        .unwrap();
    assert_eq!(retained.plan_hash, plan_hash);
    retained
}

#[tokio::test]
async fn concurrent_campaign_refills_while_slow_children_fly_and_drains_all_on_pause() {
    let (_dir, service, backend, frozen) = setup(4).await;
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == 4
    })
    .await;
    let first = backend
        .waiting
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .0
        .clone();
    let slow: BTreeSet<_> = backend
        .waiting
        .lock()
        .unwrap()
        .values()
        .map(|v| v.0.clone())
        .filter(|r| r != &first)
        .collect();
    assert_eq!(children(&service, &frozen).await.len(), 4);
    backend.release_root(&first);
    wait_while_running(&service, &frozen.plan.id, || {
        backend
            .waiting
            .lock()
            .unwrap()
            .values()
            .any(|v| v.0 == first)
    })
    .await;
    backend.release_root(&first);
    tokio::time::timeout(HANG_GUARD, async {
        while children(&service, &frozen).await.len() < 5 {
            assert_running(&service, &frozen.plan.id).await;
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert!(slow
        .iter()
        .all(|r| backend.waiting.lock().unwrap().values().any(|v| &v.0 == r)));
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    assert_eq!(
        service
            .store
            .workflow_campaign(&frozen.plan.id)
            .await
            .unwrap()
            .state,
        "pausing"
    );
    assert!(service
        .control_workflow_campaign(&frozen.plan.id, "resume")
        .await
        .is_err());
    let admitted = children(&service, &frozen).await;
    assert!(admitted
        .iter()
        .all(|r| matches!(r.state.as_str(), "pausing" | "completed")));
    // Pause closes admission. Already admitted whole workflows drain, so their
    // dependent steps retain one uninterrupted wall clock and first trajectory.
    backend.drain();
    tick.await.unwrap().unwrap();
    service.tick().await.unwrap();
    assert_eq!(
        service
            .store
            .workflow_campaign(&frozen.plan.id)
            .await
            .unwrap()
            .state,
        "paused"
    );
    let calls = backend.workers.calls.load(Ordering::SeqCst);
    service.tick().await.unwrap();
    assert_eq!(backend.workers.calls.load(Ordering::SeqCst), calls);
    assert_eq!(children(&service, &frozen).await.len(), admitted.len());
    assert_eq!(backend.peak.load(Ordering::SeqCst), 4);
    assert!(service
        .start_run(frozen.plan.run_request(admitted.len()).unwrap())
        .await
        .is_err());
    let first_attempts: Vec<_> = children(&service, &frozen)
        .await
        .into_iter()
        .map(|r| r.attempts[0].id.clone())
        .collect();
    service
        .control_workflow_campaign(&frozen.plan.id, "resume")
        .await
        .unwrap();
    assert_eq!(finish(&service, &frozen.plan.id).await.state, "completed");
    let all = children(&service, &frozen).await;
    assert_eq!(all.len(), 120);
    assert!(all.iter().all(|r| r.attempts.len() == 1));
    assert_eq!(
        first_attempts,
        all.iter()
            .take(first_attempts.len())
            .map(|r| r.attempts[0].id.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(backend.workers.calls.load(Ordering::SeqCst), 48 + 240);
    let started = backend.started.lock().unwrap();
    assert_eq!(started.len(), 240);
    assert_eq!(
        started
            .iter()
            .map(|(_, id)| id)
            .collect::<BTreeSet<_>>()
            .len(),
        240
    );
    drop(started);
    let report = service
        .store
        .workflow_campaign_report(&frozen.plan.id)
        .await
        .unwrap();
    assert_eq!(report.trace_hashes.len(), 120);
    assert_eq!(report.groups, 4);
    assert_eq!(
        report
            .policies
            .iter()
            .find(|p| p.policy == "learned")
            .unwrap()
            .quality,
        1.0
    );
    assert!(report
        .policies
        .iter()
        .filter(|p| !matches!(p.policy.as_str(), "learned" | "oracle"))
        .all(|p| p.quality == 0.0));
    assert_eq!(
        service
            .store
            .workflow_campaign_report(&frozen.plan.id)
            .await
            .unwrap()
            .artifact_hash,
        report.artifact_hash
    );
}

#[tokio::test]
async fn concurrent_campaign_slot_timeout_seals_first_evidence_without_dispatch_or_retry() {
    let (_dir, service, backend, frozen) = setup_with_timeout(8, 10).await;
    let frozen = legacy_bounded_plan(&service, frozen).await;
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == 4
    })
    .await;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let admitted = children(&service, &frozen).await;
            if admitted.len() == 8
                && admitted
                    .iter()
                    .all(|run| run.attempts[0].workflow_steps.len() == 1)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    let dispatched: BTreeSet<_> = backend
        .started
        .lock()
        .unwrap()
        .iter()
        .map(|(run, _)| run.clone())
        .collect();
    assert_eq!(dispatched.len(), 4);
    let expired = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let waiting: Vec<_> = children(&service, &frozen)
                .await
                .into_iter()
                .filter(|run| !dispatched.contains(&run.id))
                .collect();
            if waiting.len() == 4
                && waiting
                    .iter()
                    .all(|run| run.attempts[0].phase == "terminal")
            {
                break waiting;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    backend.drain();
    tick.await.unwrap().unwrap();
    service.tick().await.unwrap();
    for run in &expired {
        let root = &run.attempts[0];
        assert!(
            root.evidence_hash.is_some(),
            "A measured slot timeout must seal its first root evidence"
        );
        assert_eq!(root.outcome.as_deref(), Some("budget_timeout"));
        let steps = crate::services::benchmarks::workflow::saved_steps(&service.store, &root.id)
            .await
            .unwrap();
        assert_eq!(steps.len(), 1);
        let child = &steps[0].attempt;
        assert_eq!(child.phase, "terminal");
        assert_eq!(child.outcome.as_deref(), Some("budget_timeout"));
        assert!(child.session_id.is_none() && child.host_run_id.is_none());
        assert!(child.observed.is_none() && child.native_execution_ms.is_none());
        assert!(child.duration_ms.is_none());
    }
    assert_eq!(backend.started.lock().unwrap().len(), 4);
    service
        .control_workflow_campaign(&frozen.plan.id, "resume")
        .await
        .unwrap();
    assert_eq!(finish(&service, &frozen.plan.id).await.state, "completed");
    service.tick().await.unwrap();
    for original in &expired {
        assert_eq!(
            serde_json::to_value(service.store.run(&original.id).await.unwrap().attempts).unwrap(),
            serde_json::to_value(&original.attempts).unwrap()
        );
        assert!(!backend
            .started
            .lock()
            .unwrap()
            .iter()
            .any(|(run, _)| run == &original.id));
    }
    let report = service
        .store
        .workflow_campaign_report(&frozen.plan.id)
        .await
        .unwrap();
    assert_eq!(report.trace_hashes.len(), frozen.plan.cells.len());
    for original in &expired {
        let repeat = report
            .cases
            .iter()
            .flat_map(|case| &case.cells)
            .flat_map(|cell| &cell.repeats)
            .find(|repeat| repeat.attempt_id == original.attempts[0].id)
            .expect("The original undispatched timeout remains in the complete report");
        assert_eq!(repeat.quality, 0.0);
        assert_eq!(repeat.evidence_hash, original.attempts[0].evidence_hash);
    }
    assert_eq!(
        service
            .store
            .workflow_campaign_report(&frozen.plan.id)
            .await
            .unwrap()
            .artifact_hash,
        report.artifact_hash
    );
}

#[tokio::test]
async fn concurrent_campaign_slot_wait_remains_in_the_next_step_wall_budget() {
    let (_dir, service, backend, frozen) = setup_with_timeout(8, 10).await;
    let frozen = legacy_bounded_plan(&service, frozen).await;
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == 4
    })
    .await;
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    let original: BTreeSet<_> = backend
        .started
        .lock()
        .unwrap()
        .iter()
        .map(|(run, _)| run.clone())
        .collect();
    let released = original.iter().next().unwrap().clone();
    tokio::time::sleep(Duration::from_secs(2)).await;
    backend.release_root(&released);
    wait_until(|| {
        let waiting = backend.waiting.lock().unwrap();
        if waiting.values().any(|(run, _)| !original.contains(run)) {
            return true;
        }
        let released_has_next = waiting.values().any(|(run, _)| run == &released);
        drop(waiting);
        // Either a waiting root or this root's second step can win the slot.
        if released_has_next {
            backend.release_root(&released);
        }
        false
    })
    .await;
    let admitted = backend
        .waiting
        .lock()
        .unwrap()
        .iter()
        .find(|(_, (run, _))| !original.contains(run))
        .map(|(attempt, (run, _))| (run.clone(), attempt.clone()))
        .unwrap();
    assert!(backend.budgets.lock().unwrap()[&admitted.1] < 10);
    let started_at = service.store.run(&admitted.0).await.unwrap().attempts[0]
        .started_at
        .unwrap();
    let until_expired = (started_at + 10_050 - now()).max(0) as u64;
    tokio::time::sleep(Duration::from_millis(until_expired)).await;
    backend.drain();
    tick.await.unwrap().unwrap();
    service.tick().await.unwrap();
    let timed = service.store.run(&admitted.0).await.unwrap();
    let root = &timed.attempts[0];
    assert_eq!(root.outcome.as_deref(), Some("budget_timeout"));
    assert!(root.evidence_hash.is_some());
    assert_eq!(root.workflow_steps.len(), 1);
    assert_eq!(
        backend
            .started
            .lock()
            .unwrap()
            .iter()
            .filter(|(run, _)| run == &admitted.0)
            .count(),
        1
    );
    let before = serde_json::to_value(&timed.attempts).unwrap();
    service.tick().await.unwrap();
    assert_eq!(
        serde_json::to_value(service.store.run(&timed.id).await.unwrap().attempts).unwrap(),
        before
    );
}

#[tokio::test]
async fn concurrent_campaign_backend_setup_cannot_dispatch_after_root_deadline() {
    let (_dir, service, backend, frozen) = setup_with_timeout(4, 10).await;
    backend.gated.store(false, Ordering::SeqCst);
    backend.setup_delay_ms.store(11_000, Ordering::SeqCst);
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    wait_while_running(&service, &frozen.plan.id, || {
        backend.preparing.load(Ordering::SeqCst) == 4
    })
    .await;
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    tick.await.unwrap().unwrap();
    service.tick().await.unwrap();
    assert!(backend.started.lock().unwrap().is_empty());
    assert_eq!(backend.workers.calls.load(Ordering::SeqCst), 48);
    assert!(service.active.lock().await.is_empty());
    let runs = children(&service, &frozen).await;
    assert_eq!(runs.len(), 4);
    for run in runs {
        let root = &run.attempts[0];
        assert_eq!(root.outcome.as_deref(), Some("budget_timeout"));
        assert!(root.evidence_hash.is_some());
        assert_eq!(root.workflow_steps.len(), 1);
        let step = &root.workflow_steps[0];
        assert!(step.session_id.is_none());
        assert!(step.host_run_id.is_none());
        let lease = service
            .store
            .native_budget(&format!("workflow:{}:0", root.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(lease.root_started_at_ms, root.started_at.unwrap());
        assert_eq!(lease.root_cap_seconds, 10);
        assert_eq!(lease.step_cap_seconds, 10);
        assert_eq!(
            lease.deadline_at_ms().unwrap(),
            root.started_at.unwrap() + 10_000
        );
    }
}

#[tokio::test]
async fn concurrent_campaign_admission_is_ordered_atomic_and_idempotent() {
    let (dir, service, backend, frozen) = setup(8).await;
    let mut changed = frozen.plan.request.clone();
    changed.parallelism = Some(4);
    assert!(service.freeze_workflow_campaign(changed).await.is_err());
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    assert!(service
        .start_run(frozen.plan.run_request(1).unwrap())
        .await
        .is_err());
    let request = frozen.plan.run_request(0).unwrap();
    let (a, b) = tokio::join!(
        service.start_run(request.clone()),
        service.start_run(request)
    );
    assert_eq!(a.unwrap().id, b.unwrap().id);
    super::super::super::super::workflow_campaign::tick(&service)
        .await
        .unwrap();
    assert_eq!(children(&service, &frozen).await.len(), 8);
    assert!(service
        .start_run(frozen.plan.run_request(8).unwrap())
        .await
        .is_err());
    assert_eq!(backend.workers.calls.load(Ordering::SeqCst), 48);
    service
        .control_workflow_campaign(&frozen.plan.id, "cancel")
        .await
        .unwrap();
    // Crash after the cancellation transaction, before the runner drained it.
    service.store.pool.close().await;
    drop(service);
    let reopened = self::service(dir.path(), backend.clone()).await;
    reopened.tick().await.unwrap();
    assert!(children(&reopened, &frozen)
        .await
        .iter()
        .all(|r| r.state == "cancelled" && r.attempts.len() == 1));
    assert_eq!(backend.workers.calls.load(Ordering::SeqCst), 48);
}

#[tokio::test]
async fn concurrent_campaign_cancels_every_active_and_waiting_child() {
    let (_dir, service, backend, frozen) = setup(8).await;
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == 4
    })
    .await;
    service
        .control_workflow_campaign(&frozen.plan.id, "cancel")
        .await
        .unwrap();
    tick.await.unwrap().unwrap();
    service.tick().await.unwrap();
    let cancelled = children(&service, &frozen).await;
    assert_eq!(cancelled.len(), 8);
    assert!(
        cancelled
            .iter()
            .all(|r| r.state == "cancelled" && r.attempts[0].phase == "terminal"),
        "{:?}",
        cancelled
            .iter()
            .map(|r| (
                r.state.clone(),
                r.attempts[0].phase.clone(),
                r.attempts[0].outcome.clone(),
                r.attempts[0].reason.clone()
            ))
            .collect::<Vec<_>>()
    );
    assert_eq!(backend.active.load(Ordering::SeqCst), 0);
    let receipts: Vec<_> = cancelled
        .iter()
        .map(|r| serde_json::to_value(&r.attempts).unwrap())
        .collect();
    service.tick().await.unwrap();
    assert_eq!(
        receipts,
        children(&service, &frozen)
            .await
            .iter()
            .map(|r| serde_json::to_value(&r.attempts).unwrap())
            .collect::<Vec<_>>()
    );
    assert_eq!(backend.workers.calls.load(Ordering::SeqCst), 48);
}

#[tokio::test]
async fn concurrent_campaign_restart_preserves_uncertain_first_attempts_and_untouched_children() {
    let (dir, service, backend, frozen) = setup(8).await;
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == 4
    })
    .await;
    let before = children(&service, &frozen).await;
    tick.abort();
    assert!(tick.await.unwrap_err().is_cancelled());
    wait_until(|| backend.active.load(Ordering::SeqCst) == 0).await;
    service.store.pool.close().await;
    drop(service);
    backend.drain();
    let reopened = self::service(dir.path(), backend.clone()).await;
    reopened.tick().await.unwrap();
    let paused = reopened
        .store
        .workflow_campaign(&frozen.plan.id)
        .await
        .unwrap();
    assert_eq!(paused.state, "paused");
    assert_eq!(backend.workers.calls.load(Ordering::SeqCst), 48);
    let retained = children(&reopened, &frozen).await;
    assert_eq!(retained.len(), before.len());
    assert!(retained
        .iter()
        .zip(&before)
        .all(|(a, b)| a.attempts[0].id == b.attempts[0].id));
    let failed: Vec<_> = retained
        .iter()
        .filter(|r| r.attempts[0].phase == "terminal")
        .map(|r| (r.id.clone(), serde_json::to_value(&r.attempts).unwrap()))
        .collect();
    assert!(!failed.is_empty());
    reopened
        .control_workflow_campaign(&frozen.plan.id, "resume")
        .await
        .unwrap();
    assert_eq!(finish(&reopened, &frozen.plan.id).await.state, "completed");
    for (id, original) in failed {
        assert_eq!(
            serde_json::to_value(reopened.store.run(&id).await.unwrap().attempts).unwrap(),
            original
        );
    }
    assert!(reopened
        .store
        .workflow_campaign_report(&frozen.plan.id)
        .await
        .is_err());
    let started = backend.started.lock().unwrap();
    assert_eq!(
        started
            .iter()
            .map(|(_, id)| id)
            .collect::<BTreeSet<_>>()
            .len(),
        started.len()
    );
}

#[test]
fn serial_campaign_serialization_remains_unchanged() {
    let legacy = json!({
        "requestKey":"invented-old","modelId":"invented-fit","versionIds":[],
        "candidates":[],"personaPriorIds":[],"minQuality":0.0,"repetitions":3,
        "timeoutSeconds":10,"maxExecutions":240
    });
    let request: Request = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(&request).unwrap(), legacy);
    assert!(request.parallelism.is_none());
}
