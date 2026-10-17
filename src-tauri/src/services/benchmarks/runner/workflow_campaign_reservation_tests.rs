//! Admission regressions using isolated storage and gated, offline workers.
use super::*;

/// Rewrites a frozen plan to the saved v3 pool-reservation recipe in the
/// isolated store, as a campaign the previous backend froze persists. Cell
/// request hashes do not depend on the recipe.
async fn reserved_pool_plan(service: &BenchmarkService, frozen: Campaign) -> Campaign {
    assert_eq!(frozen.plan.order_algorithm, STEP_ADMISSION_ORDER);
    let mut plan = frozen.plan;
    plan.order_algorithm = RESERVED_WORKERS_ORDER.into();
    plan.evaluation.primary_metric =
        "quality_weighted_relative_whole_wall_time_reported_cost_requires_resources".into();
    let plan_hash = crate::services::benchmarks::workflow_campaign::hash(&plan).unwrap();
    sqlx::query("UPDATE workflow_campaigns SET plan_json=?,plan_hash=? WHERE id=?")
        .bind(serde_json::to_string(&plan).unwrap())
        .bind(&plan_hash)
        .bind(&plan.id)
        .execute(&service.store.pool)
        .await
        .unwrap();
    let saved = service.store.workflow_campaign(&plan.id).await.unwrap();
    assert_eq!(saved.plan.order_algorithm, RESERVED_WORKERS_ORDER);
    saved
}

/// Freezes an invented admission order into the isolated store before any
/// root starts: the cells whose policies are listed, in that order, then the
/// rest. The recipe is kept.
async fn order_cells(
    service: &BenchmarkService,
    mut frozen: Campaign,
    first: &[usize],
) -> Campaign {
    let mut remaining = std::mem::take(&mut frozen.plan.cells);
    for policy_index in first {
        let index = remaining
            .iter()
            .position(|c| c.policy_index == *policy_index)
            .unwrap();
        frozen.plan.cells.push(remaining.remove(index));
    }
    frozen.plan.cells.extend(remaining);
    frozen.plan_hash = crate::services::benchmarks::workflow_campaign::hash(&frozen.plan).unwrap();
    let mut tx = service.store.pool.begin().await.unwrap();
    sqlx::query("UPDATE workflow_campaigns SET plan_json=?,plan_hash=? WHERE id=?")
        .bind(serde_json::to_string(&frozen.plan).unwrap())
        .bind(&frozen.plan_hash)
        .bind(&frozen.plan.id)
        .execute(&mut *tx)
        .await
        .unwrap();
    for index in 0..frozen.plan.cells.len() {
        let request = frozen.plan.run_request(index).unwrap();
        sqlx::query("UPDATE workflow_campaign_cells SET request_hash=? WHERE request_key=?")
            .bind(crate::services::benchmarks::workflow_campaign::hash(&request).unwrap())
            .bind(&request.request_key)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    frozen
}

fn policy_index(frozen: &Campaign, mode: &str, fixed: Option<&str>) -> usize {
    frozen
        .plan
        .policies
        .iter()
        .position(|p| p.mode == mode && p.fixed_candidate_id.as_deref() == fixed)
        .unwrap()
}

const PARSER_ACCOUNT: &str = "offline-pipeline\u{1f}invented-parser-account";
const PAINTER_ACCOUNT: &str = "offline-pipeline\u{1f}invented-painter-account";

fn account_key(configuration: &Configuration) -> String {
    format!(
        "{}\u{1f}{}",
        configuration.provider_id,
        configuration.account_id.as_deref().unwrap_or_default()
    )
}

async fn admitted_roots(
    service: &BenchmarkService,
    frozen: &Campaign,
    count: usize,
) -> Vec<BenchmarkRun> {
    tokio::time::timeout(HANG_GUARD, async {
        loop {
            let runs = children(service, frozen).await;
            if runs.len() >= count
                && runs
                    .iter()
                    .take(count)
                    .all(|run| run.attempts[0].started_at.is_some())
            {
                return runs;
            }
            assert_running(service, &frozen.plan.id).await;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn step_admission_runs_fixed_roots_of_the_idle_account_beside_adaptive_roots() {
    let (dir, service, backend, frozen) = setup_with_accounts(8, WALL_BUDGET_SECONDS, true).await;
    assert_eq!(frozen.plan.order_algorithm, STEP_ADMISSION_ORDER);
    let adaptive = policy_index(&frozen, "learned", None);
    let parser = policy_index(&frozen, "fixed", Some("parser"));
    let painter = policy_index(&frozen, "fixed", Some("painter"));
    let frozen = order_cells(
        &service,
        frozen,
        &[
            adaptive, adaptive, adaptive, adaptive, parser, parser, painter, painter,
        ],
    )
    .await;
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    // The four adaptive roots decide their first workers on their own tasks,
    // without holding any account first.
    let children = tokio::time::timeout(HANG_GUARD, async {
        loop {
            let runs = children(&service, &frozen).await;
            if runs.len() == 8 {
                let mut decided = 0;
                for run in &runs[..4] {
                    let key = format!("workflow:{}:0", run.attempts[0].id);
                    if service
                        .store
                        .executor_decision(&key)
                        .await
                        .unwrap()
                        .is_some()
                    {
                        decided += 1;
                    }
                }
                if decided == 4 {
                    return runs;
                }
            }
            assert_running(&service, &frozen.plan.id).await;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    // Demand per account: the decided adaptive workers plus two fixed roots
    // each. Every account runs min(demand, four) at once; under the pool
    // reservation the adaptive roots alone would have filled both accounts.
    let mut demand: BTreeMap<String, usize> = BTreeMap::from([
        (PARSER_ACCOUNT.to_owned(), 2),
        (PAINTER_ACCOUNT.to_owned(), 2),
    ]);
    for run in &children[..4] {
        let key = format!("workflow:{}:0", run.attempts[0].id);
        let record = service
            .store
            .executor_decision(&key)
            .await
            .unwrap()
            .unwrap();
        *demand
            .entry(account_key(record.decision.chosen.as_ref().unwrap()))
            .or_default() += 1;
    }
    let expected: usize = demand.values().map(|d| (*d).min(4)).sum();
    assert!(expected >= 6, "{demand:?}");
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == expected
    })
    .await;
    {
        let active = service.active.lock().await;
        for (account, d) in &demand {
            assert_eq!(
                active.values().filter(|f| f.uses_account(account)).count(),
                (*d).min(4),
                "{account}"
            );
        }
        // Roots still waiting for a full account hold nothing.
        assert_eq!(
            active
                .values()
                .filter(|f| f.lane.starts_with("workflow-root:") && f.workers.is_empty())
                .count(),
            8 - expected
        );
        assert_eq!(
            active.values().filter(|f| f.workers.len() == 1).count(),
            expected
        );
    }
    assert_eq!(backend.peak.load(Ordering::SeqCst) as usize, expected);
    // Every admitted root carries its admission time; none has settled.
    for run in admitted_roots(&service, &frozen, 8).await {
        let root = &run.attempts[0];
        assert!(root.started_at.is_some());
        assert!(root.outcome.is_none());
    }
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    backend.drain();
    tick.await.unwrap().unwrap();
    service.tick().await.unwrap();
    dir.close().await;
}

#[tokio::test]
async fn step_admission_excludes_worker_waits_from_the_root_clock_and_records_them() {
    let (dir, service, backend, frozen) = setup_with_accounts(2, 10, true).await;
    let parser = policy_index(&frozen, "fixed", Some("parser"));
    let frozen = order_cells(&service, frozen, &[parser, parser]).await;
    for id in ["busy-1", "busy-2", "busy-3", "busy-4"] {
        assert!(service
            .claim("ordinary", seat(id, PARSER_ACCOUNT))
            .await
            .is_some());
    }
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    let admitted = admitted_roots(&service, &frozen, 2).await;
    // Longer than the whole root budget, with the account full: no worker call,
    // no timeout, no clock spent.
    tokio::time::sleep(Duration::from_secs(11)).await;
    assert_eq!(backend.started.lock().unwrap().len(), 0);
    for run in &admitted {
        let root = service.store.run(&run.id).await.unwrap().attempts.remove(0);
        assert_ne!(root.phase, "terminal", "{:?}", root.reason);
        assert!(root.outcome.is_none());
    }
    for id in ["busy-1", "busy-2", "busy-3", "busy-4"] {
        service.release(id).await;
    }
    service.wake.notify_one();
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == 2
    })
    .await;
    for run in &admitted {
        let root = service.store.run(&run.id).await.unwrap().attempts.remove(0);
        let steps = crate::services::benchmarks::workflow::saved_steps(&service.store, &root.id)
            .await
            .unwrap();
        let waited = steps[0]
            .native_context
            .as_ref()
            .unwrap()
            .local_wait_ms
            .unwrap();
        assert!(waited >= 10_000, "recorded wait {waited} ms");
        let lease = service
            .store
            .native_budget(&format!("workflow:{}:0", root.id))
            .await
            .unwrap()
            .unwrap();
        assert!(lease.root_started_at_ms >= root.started_at.unwrap() + waited as i64 - 1);
        assert_eq!(lease.root_cap_seconds, 10);
        assert!(backend.budgets.lock().unwrap()[&steps[0].attempt.id] >= 8);
    }
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    backend.drain();
    tick.await.unwrap().unwrap();
    service.tick().await.unwrap();
    for run in &admitted {
        let root = service.store.run(&run.id).await.unwrap().attempts.remove(0);
        assert_eq!(root.phase, "terminal");
        assert_ne!(
            root.outcome.as_deref(),
            Some("budget_timeout"),
            "{:?}",
            root.reason
        );
        assert_eq!(root.workflow_steps.len(), 2);
    }
    dir.close().await;
}

#[tokio::test]
async fn step_admission_serves_the_oldest_admitted_root_first_on_a_full_account() {
    let (dir, service, backend, frozen) = setup_with_accounts(3, WALL_BUDGET_SECONDS, true).await;
    let parser = policy_index(&frozen, "fixed", Some("parser"));
    let frozen = order_cells(&service, frozen, &[parser, parser, parser]).await;
    for id in ["busy-1", "busy-2", "busy-3", "busy-4"] {
        assert!(service
            .claim("ordinary", seat(id, PARSER_ACCOUNT))
            .await
            .is_some());
    }
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    let admitted = admitted_roots(&service, &frozen, 3).await;
    let ids: Vec<_> = admitted.iter().map(|run| run.id.clone()).collect();
    // Every root is admitted and decided, and every first step waits for the
    // full account without a worker call or a clock.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(backend.started.lock().unwrap().len(), 0);
    assert_eq!(
        service
            .active
            .lock()
            .await
            .values()
            .filter(|f| !f.workers.is_empty())
            .count(),
        0
    );
    // One slot frees: the oldest admitted root takes it.
    service.release("busy-1").await;
    service.wake.notify_one();
    wait_while_running(&service, &frozen.plan.id, || {
        backend.started.lock().unwrap().len() == 1
    })
    .await;
    assert_eq!(backend.started.lock().unwrap()[0].0, ids[0]);
    {
        let active = service.active.lock().await;
        assert_eq!(
            active
                .values()
                .filter(|f| f.uses_account(PARSER_ACCOUNT))
                .count(),
            4
        );
        // The flying root holds exactly its decided worker; waiting roots
        // hold no account.
        assert_eq!(active.values().filter(|f| f.workers.len() == 1).count(), 1);
    }
    // Its step ends: the worker goes back, and whichever waiting root is
    // oldest at that moment takes the one slot. The finished root holds
    // nothing while its next step is decided.
    backend.release_root(&ids[0]);
    wait_while_running(&service, &frozen.plan.id, || {
        backend.started.lock().unwrap().len() == 2
    })
    .await;
    assert_eq!(
        service
            .active
            .lock()
            .await
            .values()
            .filter(|f| f.workers.len() == 1)
            .count(),
        1
    );
    assert_eq!(backend.peak.load(Ordering::SeqCst), 1);
    // Close admission first: the three admitted roots finish, nothing new
    // starts once the account frees up.
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    for id in ["busy-2", "busy-3", "busy-4"] {
        service.release(id).await;
    }
    service.wake.notify_one();
    backend.drain();
    tick.await.unwrap().unwrap();
    service.tick().await.unwrap();
    for (index, id) in ids.iter().enumerate() {
        let root = service.store.run(id).await.unwrap().attempts.remove(0);
        assert_eq!(root.phase, "terminal");
        // Both steps ran and the trajectory was graded; the invented workers
        // pass or fail by fixture design, never by the slot they waited for.
        assert!(
            matches!(root.outcome.as_deref(), Some("pass") | Some("fail")),
            "{:?} {:?}",
            root.outcome,
            root.reason
        );
        let steps = crate::services::benchmarks::workflow::saved_steps(&service.store, &root.id)
            .await
            .unwrap();
        assert_eq!(steps.len(), 2);
        let waits: Vec<u64> = steps
            .iter()
            .map(|s| s.native_context.as_ref().unwrap().local_wait_ms.unwrap())
            .collect();
        if index > 0 {
            assert!(waits[0] >= 1_000, "root {index} first-step wait {waits:?}");
        }
    }
    {
        let started = backend.started.lock().unwrap();
        assert_eq!(started.len(), 6);
        assert_eq!(
            started
                .iter()
                .map(|(_, id)| id)
                .collect::<BTreeSet<_>>()
                .len(),
            6
        );
    }
    assert_eq!(
        service
            .store
            .workflow_campaign(&frozen.plan.id)
            .await
            .unwrap()
            .next_cell,
        3
    );
    dir.close().await;
}

#[tokio::test]
async fn frozen_account_slots_bound_one_account_and_freezing_rejects_more_than_eight() {
    let dir = crate::test_support::TempRoot::new();
    let backend = Arc::new(GatedWorkers::default());
    let service = service(&dir, backend.clone()).await;
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
    let mut request = request(&fit, &roots, "concurrent-slots");
    for candidate in &mut request.candidates {
        candidate.account_id = Some(format!("invented-{}-account", candidate.id));
    }
    request.parallelism = Some(8);
    request.timeout_seconds = WALL_BUDGET_SECONDS;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    request.account_slots = Some(9);
    assert!(service
        .freeze_workflow_campaign(request.clone())
        .await
        .is_err());
    request.account_slots = Some(6);
    let frozen = service.freeze_workflow_campaign(request).await.unwrap();
    assert_eq!(frozen.plan.request.account_slots, Some(6));
    backend.gated.store(true, Ordering::SeqCst);
    let parser = policy_index(&frozen, "fixed", Some("parser"));
    let frozen = order_cells(&service, frozen, &[parser; 8]).await;
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == 6
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(backend.waiting.lock().unwrap().len(), 6);
    assert_eq!(children(&service, &frozen).await.len(), 8);
    assert_eq!(backend.peak.load(Ordering::SeqCst), 6);
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    backend.drain();
    tick.await.unwrap().unwrap();
    service.tick().await.unwrap();
    dir.close().await;
}

#[tokio::test]
async fn reserved_campaign_queue_does_not_consume_execution_budget() {
    let (dir, service, backend, frozen) = setup_with_timeout(8, 10).await;
    let frozen = reserved_pool_plan(&service, frozen).await;
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
    let admitted = children(&service, &frozen).await;
    assert_eq!(admitted.len(), 8);
    let queued: Vec<_> = admitted
        .iter()
        .filter(|run| run.attempts[0].phase == "pending")
        .map(|run| run.id.clone())
        .collect();
    assert_eq!(queued.len(), 4);
    // Exceed the entire execution allowance in the queue. None of these four
    // roots has started a lease, a step, a provider call or a timeout outcome.
    tokio::time::sleep(Duration::from_secs(11)).await;
    for id in &queued {
        let run = service.store.run(id).await.unwrap();
        let root = &run.attempts[0];
        assert_eq!(root.phase, "pending");
        assert!(root.started_at.is_none() && root.finished_at.is_none());
        assert!(root.outcome.is_none() && root.evidence_hash.is_none());
        assert!(root.session_id.is_none() && root.host_run_id.is_none());
        assert!(root.workflow_steps.is_empty());
        assert!(service
            .store
            .native_budget(&format!("workflow-root:{}", root.id))
            .await
            .unwrap()
            .is_none());
        assert!(
            crate::services::benchmarks::workflow::saved_steps(&service.store, &root.id)
                .await
                .unwrap()
                .is_empty()
        );
    }
    assert_eq!(backend.started.lock().unwrap().len(), 4);
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
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
    for id in &queued {
        assert_eq!(
            service.store.run(id).await.unwrap().attempts[0].phase,
            "pending"
        );
    }

    backend.gated.store(true, Ordering::SeqCst);
    let resumed_at = now();
    service
        .control_workflow_campaign(&frozen.plan.id, "resume")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == 4
    })
    .await;
    let waiting = backend
        .waiting
        .lock()
        .unwrap()
        .iter()
        .map(|(id, (run, _))| (id.clone(), run.clone()))
        .collect::<Vec<_>>();
    for (step, run) in &waiting {
        assert!(
            queued.contains(run),
            "Older queued roots must precede new campaign cells"
        );
        assert!(backend.budgets.lock().unwrap()[step] > 0);
        let root = service.store.run(run).await.unwrap().attempts.remove(0);
        let lease = service
            .store
            .native_budget(&format!("workflow-root:{}", root.id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(lease.root_cap_seconds, 10);
        assert!(lease.root_started_at_ms >= resumed_at);
        assert_eq!(root.started_at, Some(lease.root_started_at_ms));
    }
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    backend.drain();
    tick.await.unwrap().unwrap();
    service.tick().await.unwrap();
    for id in &queued {
        let run = service.store.run(id).await.unwrap();
        assert_eq!(run.attempts.len(), 1);
        assert_eq!(run.attempts[0].workflow_steps.len(), 2);
        assert_ne!(run.attempts[0].outcome.as_deref(), Some("budget_timeout"));
    }
    {
        let started = backend.started.lock().unwrap();
        assert_eq!(
            started.len(),
            started
                .iter()
                .map(|(_, id)| id)
                .collect::<BTreeSet<_>>()
                .len()
        );
    }
    assert_eq!(backend.peak.load(Ordering::SeqCst), 4);
    dir.close().await;
}

#[tokio::test]
async fn reserved_campaign_keeps_next_step_capacity_before_admitting_another_root() {
    let (dir, service, backend, frozen) = setup(8).await;
    let frozen = reserved_pool_plan(&service, frozen).await;
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
    let children = children(&service, &frozen).await;
    let first = &children[0].id;
    let next = &children[4].id;
    assert_eq!(
        backend
            .started
            .lock()
            .unwrap()
            .iter()
            .map(|(run, _)| run.clone())
            .collect::<BTreeSet<_>>(),
        children[..4]
            .iter()
            .map(|run| run.id.clone())
            .collect::<BTreeSet<_>>()
    );
    backend.release_root(first);
    wait_while_running(&service, &frozen.plan.id, || {
        backend.started.lock().unwrap().len() == 5
    })
    .await;
    assert_eq!(&backend.started.lock().unwrap()[4].0, first);
    assert_eq!(backend.waiting.lock().unwrap().len(), 4);
    backend.release_root(first);
    wait_while_running(&service, &frozen.plan.id, || {
        backend.started.lock().unwrap().len() == 6
    })
    .await;
    assert_eq!(&backend.started.lock().unwrap()[5].0, next);
    assert_eq!(backend.peak.load(Ordering::SeqCst), 4);
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    backend.drain();
    tick.await.unwrap().unwrap();
    service.tick().await.unwrap();
    dir.close().await;
}

fn reservation(lane: &str, account: &str) -> WorkerReservation {
    WorkerReservation {
        lane: lane.into(),
        account: account.into(),
        lane_slots: 4,
        account_slots: 4,
    }
}

#[tokio::test]
async fn reserved_campaign_fifo_allows_disjoint_accounts_but_protects_older_adaptive_roots() {
    let (dir, service, backend, mut frozen) =
        setup_with_accounts(4, WALL_BUDGET_SECONDS, true).await;
    // Freeze an invented admission order in the isolated test store before
    // any root starts: blocked A, disjoint B, adaptive A+B, then newer B.
    let policies = &frozen.plan.policies;
    let a = policies
        .iter()
        .position(|p| p.fixed_candidate_id.as_deref() == Some("parser"))
        .unwrap();
    let b = policies
        .iter()
        .position(|p| p.fixed_candidate_id.as_deref() == Some("painter"))
        .unwrap();
    let adaptive = policies.iter().position(|p| p.mode == "learned").unwrap();
    frozen.plan.order_algorithm = RESERVED_WORKERS_ORDER.into();
    frozen.plan.evaluation.primary_metric =
        "quality_weighted_relative_whole_wall_time_reported_cost_requires_resources".into();
    let mut remaining = std::mem::take(&mut frozen.plan.cells);
    for policy_index in [a, b, adaptive, b] {
        let index = remaining
            .iter()
            .position(|c| c.policy_index == policy_index)
            .unwrap();
        frozen.plan.cells.push(remaining.remove(index));
    }
    frozen.plan.cells.extend(remaining);
    frozen.plan_hash = crate::services::benchmarks::workflow_campaign::hash(&frozen.plan).unwrap();
    let mut tx = service.store.pool.begin().await.unwrap();
    sqlx::query("UPDATE workflow_campaigns SET plan_json=?,plan_hash=? WHERE id=?")
        .bind(serde_json::to_string(&frozen.plan).unwrap())
        .bind(&frozen.plan_hash)
        .bind(&frozen.plan.id)
        .execute(&mut *tx)
        .await
        .unwrap();
    for index in 0..frozen.plan.cells.len() {
        let request = frozen.plan.run_request(index).unwrap();
        sqlx::query("UPDATE workflow_campaign_cells SET request_hash=? WHERE request_key=?")
            .bind(crate::services::benchmarks::workflow_campaign::hash(&request).unwrap())
            .bind(&request.request_key)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let blocked_account = "offline-pipeline\u{1f}invented-parser-account";
    for id in ["occupied-1", "occupied-2", "occupied-3", "occupied-4"] {
        assert!(service
            .claim("ordinary", seat(id, blocked_account))
            .await
            .is_some());
    }
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    let worker = service.clone();
    let tick = tokio::spawn(async move { worker.tick().await });
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == 1
    })
    .await;
    let children = children(&service, &frozen).await;
    assert_eq!(children.len(), 4);
    assert_eq!(backend.started.lock().unwrap()[0].0, children[1].id);
    for index in [0, 2, 3] {
        assert_eq!(children[index].attempts[0].phase, "pending");
        assert!(children[index].attempts[0].started_at.is_none());
    }
    // Opening one A seat belongs to the oldest fixed root, not the adaptive
    // root. The newer B root still cannot overtake the older adaptive one.
    service.release("occupied-1").await;
    service.wake.notify_one();
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == 2
    })
    .await;
    assert_eq!(backend.started.lock().unwrap()[1].0, children[0].id);
    assert_eq!(
        service.store.run(&children[3].id).await.unwrap().attempts[0].phase,
        "pending"
    );
    service.release("occupied-2").await;
    service.wake.notify_one();
    wait_while_running(&service, &frozen.plan.id, || {
        backend.waiting.lock().unwrap().len() == 4
    })
    .await;
    let active = service.active.lock().await;
    assert_eq!(
        active
            .values()
            .filter(|flight| flight.uses_account(blocked_account))
            .count(),
        4
    );
    assert_eq!(
        active
            .values()
            .filter(|flight| flight.uses_account("offline-pipeline\u{1f}invented-painter-account"))
            .count(),
        3
    );
    drop(active);
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    backend.drain();
    tick.await.unwrap().unwrap();
    for id in ["occupied-3", "occupied-4"] {
        service.release(id).await;
    }
    service.tick().await.unwrap();
    dir.close().await;
}

fn seat<'a>(id: &'a str, account: &'a str) -> Seat<'a> {
    Seat {
        id,
        lane: id,
        lane_slots: 4,
        account,
        account_slots: 4,
    }
}

#[tokio::test]
async fn reserved_workers_claim_accounts_atomically_and_share_caps_with_ordinary_runs() {
    let dir = crate::test_support::TempRoot::new();
    let service = service(&dir, Arc::new(GatedWorkers::default())).await;
    for id in ["busy-b-1", "busy-b-2", "busy-b-3", "busy-b-4"] {
        assert!(service
            .claim("ordinary", seat(id, "provider-b/account"))
            .await
            .is_some());
    }
    let pool = vec![
        reservation("lane-a", "provider-a/account"),
        reservation("lane-b", "provider-b/account"),
    ];
    assert!(service
        .claim_workers("adaptive", seat("adaptive", ""), pool.clone())
        .await
        .is_none());
    // A failed multi-account reservation must not take any capacity from A.
    for id in ["free-a-1", "free-a-2", "free-a-3", "free-a-4"] {
        assert!(service
            .claim("ordinary", seat(id, "provider-a/account"))
            .await
            .is_some());
    }
    service.release("busy-b-1").await;
    service.release("free-a-1").await;
    assert!(service
        .claim_workers("adaptive", seat("adaptive", ""), pool)
        .await
        .is_some());
    assert!(service
        .claim("ordinary", seat("blocked-a", "provider-a/account"))
        .await
        .is_none());
    assert!(service
        .claim("ordinary", seat("blocked-b", "provider-b/account"))
        .await
        .is_none());
    service.release("adaptive").await;
    assert!(service
        .claim("ordinary", seat("released-a", "provider-a/account"))
        .await
        .is_some());
    assert!(service
        .claim("ordinary", seat("released-b", "provider-b/account"))
        .await
        .is_some());
    dir.close().await;
}

#[tokio::test]
async fn reserved_effort_variants_count_once_per_shared_account() {
    let dir = crate::test_support::TempRoot::new();
    let service = service(&dir, Arc::new(GatedWorkers::default())).await;
    let pool = vec![
        reservation("effort-low", "shared-account"),
        reservation("effort-high", "shared-account"),
    ];
    for id in ["root-1", "root-2", "root-3", "root-4"] {
        assert!(service
            .claim_workers("adaptive", seat(id, ""), pool.clone())
            .await
            .is_some());
    }
    assert!(service
        .claim_workers("adaptive", seat("root-5", ""), pool)
        .await
        .is_none());
    assert!(service
        .claim("ordinary", seat("ordinary", "shared-account"))
        .await
        .is_none());
    service.release("root-2").await;
    assert!(service
        .claim("ordinary", seat("ordinary", "shared-account"))
        .await
        .is_some());
    dir.close().await;
}
