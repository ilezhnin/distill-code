//! Offline admission checks. No provider calls or authentication operations.
use super::*;
use std::sync::{atomic::AtomicBool, Mutex};
use tokio::sync::oneshot;

#[derive(Default)]
struct ReadinessWorkers {
    workers: OfflineWorkers,
    unavailable: AtomicBool,
    inventory_fault: AtomicU64,
    refreshes: AtomicU64,
    block_refreshed_inventory_after: AtomicU64,
    busy: AtomicBool,
    unsupported: AtomicBool,
    probe_gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
}

impl ExecutionBackend for ReadinessWorkers {
    fn unsupported(&self, c: &Configuration, d: &BenchmarkDraft) -> Option<String> {
        if self.unsupported.load(Ordering::SeqCst) {
            Some("Invented capability is unavailable".into())
        } else {
            self.workers.unsupported(c, d)
        }
    }

    fn activity<'a>(&'a self, _: &'a Configuration) -> BoxFuture<'a, Result<AccountActivity>> {
        Box::pin(async move {
            Ok(AccountActivity {
                active_sessions: if self.busy.load(Ordering::SeqCst) {
                    vec!["invented-interactive-session".into()]
                } else {
                    vec![]
                },
                generation: 0,
            })
        })
    }

    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        refresh: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(async move {
            let fault = self.inventory_fault.load(Ordering::SeqCst);
            if refresh {
                self.refreshes.fetch_add(1, Ordering::SeqCst);
                let gate = self.probe_gate.lock().unwrap().take();
                if let Some((entered, release)) = gate {
                    let _ = entered.send(());
                    let _ = release.await;
                }
            }
            let mut rows = self.workers.inventory(provider, account, refresh).await?;
            let after = self.block_refreshed_inventory_after.load(Ordering::SeqCst);
            for row in &mut rows {
                if refresh && after > 0 && self.workers.calls.load(Ordering::SeqCst) >= after {
                    row.available = false;
                }
                match fault {
                    1 => row.available = false,
                    2 => row.configuration.inventory_revision = Some("changed-runtime".into()),
                    3 => row.efforts.clear(),
                    4 => row.configuration.billing_mode = "changed-billing".into(),
                    _ => {}
                }
            }
            Ok(rows)
        })
    }

    fn readiness<'a>(&'a self, _: &'a Configuration) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            if self.unavailable.load(Ordering::SeqCst) {
                Err(BenchmarkError::new(
                    "capability_missing",
                    "Invented sandbox is unavailable",
                ))
            } else {
                Ok(())
            }
        })
    }

    fn execute<'a>(
        &'a self,
        store: &'a Store,
        attempt: Attempt,
        version: BenchmarkVersion,
        timeout: u32,
        cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        self.workers
            .execute(store, attempt, version, timeout, cancel)
    }
}

async fn setup() -> (
    crate::test_support::TempRoot,
    Arc<BenchmarkService>,
    Arc<ReadinessWorkers>,
    Campaign,
) {
    let directory = crate::test_support::TempRoot::new();
    let backend = Arc::new(ReadinessWorkers::default());
    let service = Arc::new(BenchmarkService {
        store: Store::open(directory.path()).await.unwrap(),
        backend: backend.clone(),
        wake: Default::default(),
        active: Default::default(),
        app: None,
    });
    directory.register(&service.store.pool);
    let (train, fit) = training_with_weights(
        &service,
        RoleWeights {
            quality: 0.85,
            speed: 0.15,
            cost: 0.0,
        },
    )
    .await;
    let roots = roots(&service, &train, "readiness").await;
    let mut request = request(&fit, &roots, "readiness-campaign");
    request.parallelism = Some(4);
    request.timeout_seconds = WALL_BUDGET_SECONDS;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    let frozen = service.freeze_workflow_campaign(request).await.unwrap();
    backend.refreshes.store(0, Ordering::SeqCst);
    (directory, service, backend, frozen)
}

async fn children(service: &BenchmarkService, frozen: &Campaign) -> Vec<BenchmarkRun> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT r.id FROM run_plans r JOIN workflow_campaign_cells c ON c.request_key=r.request_key WHERE c.campaign_id=? ORDER BY c.cell_index",
    )
    .bind(&frozen.plan.id)
    .fetch_all(&service.store.pool)
    .await
    .unwrap();
    let mut runs = Vec::new();
    for id in ids {
        runs.push(service.store.run(&id).await.unwrap());
    }
    runs
}

#[tokio::test]
async fn start_refuses_missing_runtime_settings_or_readiness_before_creating_roots() {
    let (directory, service, backend, frozen) = setup().await;
    let calls = backend.workers.calls.load(Ordering::SeqCst);
    for fault in 1..=7 {
        backend.inventory_fault.store(fault, Ordering::SeqCst);
        backend.unavailable.store(fault == 5, Ordering::SeqCst);
        backend.busy.store(fault == 6, Ordering::SeqCst);
        backend.unsupported.store(fault == 7, Ordering::SeqCst);
        let error = service
            .control_workflow_campaign(&frozen.plan.id, "start")
            .await
            .unwrap_err();
        assert_eq!(error.code, "campaign_not_ready");
        assert!(error.message.contains("No new workflow was admitted"));
        let saved = service
            .store
            .workflow_campaign(&frozen.plan.id)
            .await
            .unwrap();
        assert_eq!(saved.state, "reserved");
        assert_eq!(saved.revision, frozen.revision);
        assert_eq!(saved.plan_hash, frozen.plan_hash);
        assert!(children(&service, &frozen).await.is_empty());
        assert_eq!(backend.workers.calls.load(Ordering::SeqCst), calls);
    }
    directory.close().await;
}

#[tokio::test]
async fn a_ready_batch_refreshes_each_account_once_without_selecting_steps() {
    let (directory, service, backend, frozen) = setup().await;
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    assert_eq!(backend.refreshes.load(Ordering::SeqCst), 1);
    assert!(children(&service, &frozen).await.is_empty());
    super::super::super::super::workflow_campaign::tick(&service)
        .await
        .unwrap();
    let runs = children(&service, &frozen).await;
    assert_eq!(runs.len(), 4);
    assert_eq!(backend.refreshes.load(Ordering::SeqCst), 2);
    for (index, run) in runs.iter().enumerate() {
        assert_eq!(
            serde_json::to_value(&run.request).unwrap(),
            serde_json::to_value(frozen.plan.run_request(index).unwrap()).unwrap(),
        );
        assert!(run.attempts.iter().all(|attempt| {
            attempt.phase == "pending"
                && attempt.started_at.is_none()
                && attempt.workflow_steps.is_empty()
        }));
    }
    directory.close().await;
}

#[tokio::test]
async fn readiness_loss_between_start_and_refill_pauses_without_consuming_roots() {
    let (directory, service, backend, frozen) = setup().await;
    let calls = backend.workers.calls.load(Ordering::SeqCst);
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    backend.unavailable.store(true, Ordering::SeqCst);
    super::super::super::super::workflow_campaign::tick(&service)
        .await
        .unwrap();
    let saved = service
        .store
        .workflow_campaign(&frozen.plan.id)
        .await
        .unwrap();
    assert_eq!(saved.state, "paused");
    assert_eq!(saved.next_cell, 0);
    assert_eq!(saved.plan_hash, frozen.plan_hash);
    assert!(saved.state_reason.unwrap().contains("no ready worker"));
    assert!(children(&service, &frozen).await.is_empty());
    assert_eq!(backend.workers.calls.load(Ordering::SeqCst), calls);
    directory.close().await;
}

#[tokio::test]
async fn a_stale_probe_refusal_cannot_pause_a_newer_operator_resume() {
    let (directory, service, backend, frozen) = setup().await;
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    backend.inventory_fault.store(1, Ordering::SeqCst);
    let (entered, wait_for_probe) = oneshot::channel();
    let (release, wait_for_release) = oneshot::channel();
    *backend.probe_gate.lock().unwrap() = Some((entered, wait_for_release));
    let worker = service.clone();
    let pending =
        tokio::spawn(
            async move { super::super::super::super::workflow_campaign::tick(&worker).await },
        );
    tokio::time::timeout(HANG_GUARD, wait_for_probe)
        .await
        .unwrap()
        .unwrap();
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    backend.inventory_fault.store(0, Ordering::SeqCst);
    let resumed = service
        .control_workflow_campaign(&frozen.plan.id, "resume")
        .await
        .unwrap();
    release.send(()).unwrap();
    pending.await.unwrap().unwrap();
    let retained = service
        .store
        .workflow_campaign(&frozen.plan.id)
        .await
        .unwrap();
    assert_eq!(retained.state, "running");
    assert_eq!(retained.revision, resumed.revision);
    assert_eq!(retained.state_reason, None);
    assert!(children(&service, &frozen).await.is_empty());
    super::super::super::super::workflow_campaign::tick(&service)
        .await
        .unwrap();
    assert_eq!(children(&service, &frozen).await.len(), 4);
    directory.close().await;
}

#[tokio::test]
async fn refill_refusal_retains_first_outcomes_from_admitted_roots() {
    let (directory, service, backend, frozen) = setup().await;
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    backend.block_refreshed_inventory_after.store(
        backend.workers.calls.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    service.tick().await.unwrap();
    super::super::super::super::workflow_campaign::tick(&service)
        .await
        .unwrap();
    assert_eq!(children(&service, &frozen).await.len(), 4);
    let first: Vec<(String, String)> = sqlx::query_as(
        "SELECT result_json,result_hash FROM workflow_campaign_cells WHERE campaign_id=? AND result_json IS NOT NULL ORDER BY cell_index",
    )
    .bind(&frozen.plan.id)
    .fetch_all(&service.store.pool)
    .await
    .unwrap();
    assert!(!first.is_empty());
    let calls = backend.workers.calls.load(Ordering::SeqCst);
    service.tick().await.unwrap();
    let retained: Vec<(String, String)> = sqlx::query_as(
        "SELECT result_json,result_hash FROM workflow_campaign_cells WHERE campaign_id=? AND result_json IS NOT NULL ORDER BY cell_index",
    )
    .bind(&frozen.plan.id)
    .fetch_all(&service.store.pool)
    .await
    .unwrap();
    assert_eq!(retained, first);
    assert_eq!(backend.workers.calls.load(Ordering::SeqCst), calls);
    assert_eq!(children(&service, &frozen).await.len(), 4);
    directory.close().await;
}

#[tokio::test]
async fn refused_resume_preserves_children_and_ready_resume_keeps_original_requests() {
    let (directory, service, backend, frozen) = setup().await;
    let calls = backend.workers.calls.load(Ordering::SeqCst);
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    super::super::super::super::workflow_campaign::tick(&service)
        .await
        .unwrap();
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    service.tick().await.unwrap();
    let before = children(&service, &frozen).await;
    backend.unavailable.store(true, Ordering::SeqCst);
    assert_eq!(
        service
            .control_workflow_campaign(&frozen.plan.id, "resume")
            .await
            .unwrap_err()
            .code,
        "campaign_not_ready",
    );
    assert_eq!(
        serde_json::to_value(&before).unwrap(),
        serde_json::to_value(children(&service, &frozen).await).unwrap(),
    );
    backend.unavailable.store(false, Ordering::SeqCst);
    let resumed = service
        .control_workflow_campaign(&frozen.plan.id, "resume")
        .await
        .unwrap();
    assert_eq!(resumed.state, "running");
    assert_eq!(resumed.plan_hash, frozen.plan_hash);
    let after = children(&service, &frozen).await;
    assert_eq!(after.len(), before.len());
    for (before, after) in before.iter().zip(&after) {
        assert_eq!(before.id, after.id);
        assert_eq!(
            serde_json::to_value(&before.request).unwrap(),
            serde_json::to_value(&after.request).unwrap(),
        );
        assert_eq!(
            serde_json::to_value(&before.attempts).unwrap(),
            serde_json::to_value(&after.attempts).unwrap(),
        );
    }
    assert_eq!(backend.workers.calls.load(Ordering::SeqCst), calls);
    directory.close().await;
}

#[tokio::test]
async fn adaptive_fallback_does_not_require_an_unavailable_alternative() {
    let (directory, service, backend, frozen) = setup().await;
    let fixed = frozen
        .plan
        .cells
        .iter()
        .position(|cell| frozen.plan.policies[cell.policy_index].mode == "fixed")
        .unwrap();
    let policy = &frozen.plan.policies[frozen.plan.cells[fixed].policy_index];
    *backend.workers.unavailable.lock().unwrap() = vec![policy.fixed_candidate_id.clone().unwrap()];
    assert!(service
        .require_ready_campaign_cells(&frozen.plan, &[fixed])
        .await
        .is_err());
    let adaptive = frozen
        .plan
        .cells
        .iter()
        .position(|cell| frozen.plan.policies[cell.policy_index].mode == "learned")
        .unwrap();
    service
        .require_ready_campaign_cells(&frozen.plan, &[adaptive])
        .await
        .unwrap();
    assert!(children(&service, &frozen).await.is_empty());
    directory.close().await;
}

#[tokio::test]
async fn legacy_recipes_keep_their_original_admission_behavior() {
    let (directory, service, backend, frozen) = setup().await;
    backend.unavailable.store(true, Ordering::SeqCst);
    let mut plan = frozen.plan;
    for recipe in [
        "sha256-campaign-cell-bounded-refill-v2",
        RESERVED_WORKERS_ORDER,
    ] {
        plan.order_algorithm = recipe.into();
        plan.evaluation.primary_metric =
            "quality_weighted_relative_whole_wall_time_reported_cost_requires_resources".into();
        service
            .require_ready_campaign_cells(&plan, &[0])
            .await
            .unwrap();
    }
    assert_eq!(backend.refreshes.load(Ordering::SeqCst), 0);
    directory.close().await;
}
