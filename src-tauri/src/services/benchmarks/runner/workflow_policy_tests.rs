use super::*;
use crate::services::benchmarks::{workflow, workflow_policy::*};

#[tokio::test]
async fn research_workflow_selects_each_step_and_preserves_whole_trajectory_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let backend = Arc::new(OfflineWorkers::default());
    let service = open(directory.path(), backend.clone()).await;
    let training = publish_with_entry(&service, "train", 8, true).await;
    measure(&service, &training, "policy-training").await;
    let artifact = learned::fit(
        &service.query_data().await.unwrap(),
        learned::FitRequest {
            work_class_id: "debug".into(),
            version_ids: training.iter().map(|v| v.id.clone()).collect(),
            configurations: configurations(),
            cutoff_at: now(),
            weights: RoleWeights::default(),
        },
    )
    .unwrap();
    service.store.save_selector_fit(&artifact).await.unwrap();
    let mut draft = training[0].manifest.clone();
    draft.task_family = "new-workflow-family".into();
    draft.environment = json!({"splitGroup":"new-workflow-group"});
    draft.entry_state = None;
    draft.prompt = "Produce a completed artifact.".into();
    draft.repetitions = 1;
    draft.workflow = Some(WorkflowSpec {
        schema_version: 1,
        driver_revision: "offline-policy-v1".into(),
        steps: vec![
            WorkflowStep {
                id: "parse".into(),
                prompt: training[0].manifest.prompt.clone(),
                include_previous_output: false,
            },
            WorkflowStep {
                id: "paint".into(),
                prompt: training[1].manifest.prompt.clone(),
                include_previous_output: true,
            },
        ],
    });
    let definition = service.store.save_draft(None, None, draft).await.unwrap();
    let version = service
        .publish_version(&definition.id, definition.draft_revision)
        .await
        .unwrap();
    let policy = WorkflowPolicy {
        model_id: artifact.model.id.clone(),
        mode: "learned".into(),
        candidates: configurations(),
        prior_ids: vec!["painter".into(), "parser".into()],
        fixed_candidate_id: None,
        min_quality: 0.0,
    };
    let request = |key: &str, policy: WorkflowPolicy| {
        RunRequest::try_from(WorkflowRunRequest {
            request_key: key.into(),
            version_ids: vec![version.id.clone()],
            policy,
            repetitions: 1,
            timeout_seconds: 10,
            max_executions: 2,
        })
        .unwrap()
    };
    for index in 0..6 {
        let mut invalid = policy.clone();
        match index {
            0 => invalid.mode = "unknown".into(),
            1 => {
                invalid.candidates.pop();
            }
            2 => invalid.candidates[0].inventory_revision = Some("changed".into()),
            3 => invalid.prior_ids[1] = invalid.prior_ids[0].clone(),
            4 => invalid.fixed_candidate_id = Some("parser".into()),
            _ => invalid.min_quality = 2.0,
        }
        assert!(service
            .start_run(request(&format!("invalid-{index}"), invalid))
            .await
            .is_err());
    }
    let mut insufficient = request("budget-too-small", policy.clone());
    insufficient.max_executions = 1;
    assert!(!service.preview_run(&insufficient).await.unwrap().valid);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 48);
    for (mode, expected) in [
        ("learned", ["parser", "painter"]),
        ("persona", ["painter", "painter"]),
        ("fixed", ["parser", "parser"]),
    ] {
        let mut mode_policy = policy.clone();
        mode_policy.mode = mode.into();
        mode_policy.fixed_candidate_id = (mode == "fixed").then(|| "parser".into());
        let run = service.start_run(request(mode, mode_policy)).await.unwrap();
        for _ in 0..3 {
            service.tick().await.unwrap();
        }
        let complete = service.store.run(&run.id).await.unwrap();
        assert_eq!(complete.state, "completed");
        let root = &complete.attempts[0];
        assert_eq!(root.workflow_steps.len(), 2);
        assert!(root.observed.is_none());
        assert_eq!(root.usage.cost, Some(0.02));
        assert_eq!(root.duration_ms, Some(20));
        assert_eq!(root.evaluations.len(), 1);
        let steps = workflow::saved_steps(&service.store, &root.id)
            .await
            .unwrap();
        let trace = service.store.workflow_trace(&root.id).await.unwrap();
        assert_eq!(trace.policy.unwrap().mode, mode);
        assert_eq!(trace.steps.len(), 2);
        assert!(trace
            .steps
            .iter()
            .all(|s| s.input_hash.is_some() && s.executor_decision.is_some()));
        assert!(service
            .store
            .workflow_trace(&steps[0].attempt.id)
            .await
            .is_err());
        assert_eq!(
            steps
                .iter()
                .map(|s| s.attempt.configuration.model_id.as_str())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(steps[0].attempt.native_execution_ms, Some(8));
        assert_eq!(steps[1].entry.previous_reports.len(), 1);
        // The common native entry recipe commits a bounded public result,
        // never a root verdict or a renderer-formatted report. Its exact
        // outcome/output envelope is also what the deployment path consumes.
        let public_result: Value =
            serde_json::from_str(&steps[1].entry.previous_reports[0]).unwrap();
        assert_eq!(
            public_result,
            json!({"outcome":"completed","output":steps[0].attempt.output.as_ref().unwrap()})
        );
        assert_eq!(
            steps[1].entry.content_hash,
            crate::services::benchmarks::routing::entry_hash(&steps[1].entry)
        );
        assert_eq!(
            steps[1]
                .decision
                .as_ref()
                .unwrap()
                .executor
                .as_ref()
                .unwrap()
                .request
                .prediction
                .task
                .entry
                .as_ref()
                .unwrap()
                .previous_reports,
            steps[1].entry.previous_reports
        );
        assert!(steps.iter().all(|s| s.attempt.evaluations.is_empty()));
        for step in &steps {
            let decision = step.decision.as_ref().unwrap().executor.as_ref().unwrap();
            assert!(decision.created_at <= step.attempt.started_at.unwrap());
            assert!(root.started_at.unwrap() <= decision.created_at);
            assert!(!decision.learned_dispatch_allowed);
            assert_eq!(decision.request.surface, "benchmark");
        }
        if mode == "learned" {
            assert_eq!(root.outcome.as_deref(), Some("pass"));
            assert!(steps.iter().all(|s| s
                .decision
                .as_ref()
                .unwrap()
                .executor
                .as_ref()
                .unwrap()
                .source
                == "research_learned"));
        } else {
            // The final stub answer depends on both steps through feedback.
            assert_eq!(root.outcome.as_deref(), Some("fail"));
        }
        assert!(!service
            .query_data()
            .await
            .unwrap()
            .runs
            .iter()
            .any(|r| r.id == run.id));
        assert!(service.extend_run(&run.id, &[]).await.is_err());
        assert!(service.set_parallelism(&run.id, 2).await.is_err());
    }
    // Selection observes a changed pool at dispatch, even after admission.
    let mut fixed = policy.clone();
    fixed.mode = "fixed".into();
    fixed.fixed_candidate_id = Some("parser".into());
    let refused = service
        .start_run(request("unavailable-fixed", fixed))
        .await
        .unwrap();
    backend.unavailable.lock().unwrap().push("parser".into());
    let before = backend.calls.load(Ordering::SeqCst);
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    let refused = service.store.run(&refused.id).await.unwrap();
    assert_eq!(backend.calls.load(Ordering::SeqCst), before);
    assert_eq!(
        refused.attempts[0].outcome.as_deref(),
        Some("no_available_worker")
    );
    backend.unavailable.lock().unwrap().clear();

    let busy = service
        .start_run(request("busy-policy", policy.clone()))
        .await
        .unwrap();
    service.active.lock().await.insert(
        "occupied-worker".into(),
        Flight {
            run_id: "other-run".into(),
            lane: crate::services::benchmarks::analysis::configuration_key(&configurations()[0]),
            account: "offline-pipeline\u{1f}".into(),
            cancel: watch::channel(false).0,
        },
    );
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    let busy = service.store.run(&busy.id).await.unwrap();
    assert_eq!(busy.attempts[0].outcome.as_deref(), Some("account_busy"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), before);
    service.active.lock().await.remove("occupied-worker");

    let quota = service
        .start_run(request("quota-policy", policy.clone()))
        .await
        .unwrap();
    *backend.refuse_next.lock().unwrap() = Some(QUOTA_WAIT.into());
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    let quota = service.store.run(&quota.id).await.unwrap();
    assert_eq!(quota.state, "completed");
    assert_eq!(quota.attempts[0].outcome.as_deref(), Some(QUOTA_WAIT));
    assert!(quota.attempts[0].evaluations.is_empty());
    assert!(quota.attempts[0].usage.cost.is_none());
    assert_eq!(quota.attempts[0].workflow_steps.len(), 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), before);

    // Cancellation after one step preserves it and does not start the next.
    let cancelled = service
        .start_run(request("cancelled-policy", policy))
        .await
        .unwrap();
    backend.cancel_after.store(before + 1, Ordering::SeqCst);
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    let cancelled = service.store.run(&cancelled.id).await.unwrap();
    assert_eq!(cancelled.state, "cancelled");
    assert_eq!(cancelled.attempts[0].workflow_steps.len(), 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), before + 1);
    service.store.pool.close().await;
    drop(service);
    let service = open(directory.path(), backend.clone()).await;
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    assert_eq!(backend.calls.load(Ordering::SeqCst), before + 1);
    let root = &service.store.run(&cancelled.id).await.unwrap().attempts[0];
    assert_eq!(root.outcome.as_deref(), Some("cancelled"));
    assert_eq!(
        workflow::saved_steps(&service.store, &root.id)
            .await
            .unwrap()
            .len(),
        1
    );
    // A partial/corrupt record cannot be reused as evidence after recovery.
    sqlx::query("DELETE FROM executor_decisions WHERE request_key=?")
        .bind(format!("workflow:{}:0", root.id))
        .execute(&service.store.pool)
        .await
        .unwrap();
    assert_eq!(
        workflow::saved_steps(&service.store, &root.id)
            .await
            .err()
            .unwrap()
            .code,
        "evidence_missing"
    );
}
