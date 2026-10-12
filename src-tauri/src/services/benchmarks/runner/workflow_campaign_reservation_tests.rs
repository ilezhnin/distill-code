//! Admission regressions using isolated storage and gated, offline workers.
use super::*;

#[tokio::test]
async fn reserved_campaign_queue_does_not_consume_execution_budget() {
    let (_dir, service, backend, frozen) = setup_with_timeout(8, 10).await;
    assert_eq!(frozen.plan.order_algorithm, RESERVED_WORKERS_ORDER);
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
    let started = backend.started.lock().unwrap();
    assert_eq!(
        started.len(),
        started
            .iter()
            .map(|(_, id)| id)
            .collect::<BTreeSet<_>>()
            .len()
    );
    assert_eq!(backend.peak.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn reserved_campaign_keeps_next_step_capacity_before_admitting_another_root() {
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
    let (_dir, service, backend, mut frozen) =
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
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), Arc::new(GatedWorkers::default())).await;
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
}

#[tokio::test]
async fn reserved_effort_variants_count_once_per_shared_account() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), Arc::new(GatedWorkers::default())).await;
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
}
