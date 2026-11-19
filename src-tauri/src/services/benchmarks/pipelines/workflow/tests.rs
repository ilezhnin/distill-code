use super::*;
use crate::services::benchmarks::runner::FakeBackend;
use std::sync::{atomic::Ordering, Arc};
use tokio::sync::Notify;

async fn setup() -> (
    crate::test_support::TempRoot,
    BenchmarkService,
    Arc<FakeBackend>,
    Attempt,
    BenchmarkVersion,
) {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let backend = Arc::new(FakeBackend::default());
    let service = BenchmarkService {
        store,
        backend: backend.clone(),
        wake: Notify::new(),
        active: Default::default(),
        queries: Default::default(),
        app: None,
    };
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    draft.split = "train".into();
    draft.workflow = Some(WorkflowSpec {
        schema_version: 1,
        driver_revision: "test-v1".into(),
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
        request_key: "workflow-test".into(),
        version_ids: vec![version.id.clone()],
        configurations: vec![Configuration {
            id: "fake".into(),
            provider_id: "benchmark-fake".into(),
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
        timeout_seconds: 30,
        max_executions: 2,
        preview: false,
        parallelism: None,
        execution_limits: None,
        workflow_policy: None,
    };
    let run = service.start_run(request).await.unwrap();
    let mut root = run.attempts[0].clone();
    root.phase = "preparing".into();
    root.started_at = Some(now());
    service.store.save_attempt(&root).await.unwrap();
    (directory, service, backend, root, version)
}

#[tokio::test]
async fn step_decision_precedes_execution_and_survives_retries_unchanged() {
    let (directory, service, backend, root, version) = setup().await;
    let prepared = prepare_step(&service, &root, &version, 0, 17, None, None)
        .await
        .unwrap();
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    let frozen = serde_json::to_value(prepared.decision.as_ref().unwrap()).unwrap();
    assert_eq!(
        frozen["snapshot"]["selectionProvenance"],
        "workflow_root_pin_v1"
    );
    assert_eq!(frozen["snapshot"]["request"]["timeoutSeconds"], 17);
    assert_eq!(frozen["snapshot"]["request"]["maxExecutions"], 1);
    assert_eq!(
        frozen["snapshot"]["request"]["configurations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        frozen["snapshot"]["entryState"]["previousReports"],
        json!([])
    );
    assert!(prepared.attempt.started_at.is_none());
    let (_tx, cancel) = watch::channel(false);
    let result = execute(&service, root, version.clone(), 30, cancel.clone())
        .await
        .unwrap();
    let steps = saved_steps(&service.store, &result.id).await.unwrap();
    assert_eq!(
        serde_json::to_value(steps[0].decision.as_ref().unwrap()).unwrap(),
        frozen
    );
    assert_eq!(
        steps[1]
            .decision
            .as_ref()
            .unwrap()
            .snapshot
            .entry_state
            .as_ref()
            .unwrap()
            .previous_reports,
        vec![steps[0].attempt.output.clone().unwrap()]
    );
    for step in &steps {
        assert!(
            step.decision.as_ref().unwrap().snapshot.created_at <= step.attempt.started_at.unwrap()
        );
    }
    execute(&service, result.clone(), version, 30, cancel)
        .await
        .unwrap();
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        serde_json::to_value(
            saved_steps(&service.store, &result.id).await.unwrap()[0]
                .decision
                .as_ref()
                .unwrap()
        )
        .unwrap(),
        frozen
    );
    directory.close().await;
}

async fn exported_steps(
    service: &BenchmarkService,
    include_held_out: bool,
) -> (serde_json::Value, Vec<serde_json::Value>) {
    let result = crate::services::benchmarks::export::export(
        &service.store,
        &service.query_data().await.unwrap(),
        include_held_out,
    )
    .await
    .unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&result.manifest_path).await.unwrap()).unwrap();
    let body = tokio::fs::read_to_string(
        std::path::Path::new(&result.path).with_file_name("workflow-steps.jsonl"),
    )
    .await
    .unwrap();
    assert_eq!(
        manifest["workflowSteps"]["contentHash"],
        fixtures::hash(body.as_bytes())
    );
    let rows = body
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(manifest["workflowSteps"]["rowCount"], rows.len());
    (manifest, rows)
}

#[tokio::test]
async fn step_export_preserves_causal_inputs_without_root_rewards_or_private_fields() {
    let (directory, service, _, root, version) = setup().await;
    let prepared = prepare_step(&service, &root, &version, 0, 23, None, None)
        .await
        .unwrap();
    let (manifest, rows) = exported_steps(&service, false).await;
    assert_eq!(manifest["schemaVersion"], 4);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["decisionStatus"], "committed_before_dispatch");
    assert!(rows[0]["outcome"]["usage"].is_null());
    assert!(rows[0]["outcome"]["outcome"].is_null());
    assert_eq!(
        rows[0]["decision"]["record"]["budget"]["timeoutSeconds"],
        23
    );
    assert_eq!(
        rows[0]["decision"]["features"]["entryState"]["previousReports"],
        json!([])
    );
    assert_eq!(
        rows[0]["decision"]["selectedConfiguration"]["candidateKey"],
        crate::services::benchmarks::routing::candidate_key(&prepared.attempt.configuration)
    );
    let (_tx, cancel) = watch::channel(false);
    let mut finished = execute(&service, root, version, 30, cancel).await.unwrap();
    finished.phase = "terminal".into();
    finished.outcome = Some("pass".into());
    finished.output = Some("FINAL-ANSWER-MUST-NOT-BECOME-A-FEATURE".into());
    service.store.save_attempt(&finished).await.unwrap();
    let (_, rows) = exported_steps(&service, false).await;
    assert_eq!(rows.len(), 2);
    for row in &rows {
        assert!(row["outcome"]["reward"].is_null());
        assert_eq!(row["outcome"]["observed"], false);
        assert_eq!(row["independentTask"], false);
        assert_eq!(row["counterfactualOutcomesAvailable"], false);
        assert_eq!(row["rootAttemptId"], finished.id);
        assert_eq!(row["split"], "train");
        assert!(row["outcome"]["usage"]["cost"].is_null());
    }
    let encoded = serde_json::to_string(&rows).unwrap();
    assert!(!encoded.contains("FINAL-ANSWER-MUST-NOT-BECOME-A-FEATURE"));
    assert!(!encoded.contains("\"isolated\""));
    assert!(!encoded.contains("knownGood"));
    assert!(!encoded.contains("knownBad"));
    assert!(!encoded.contains("expected"));
    let saved = saved_steps(&service.store, &finished.id).await.unwrap();
    assert_eq!(
        rows[1]["decision"]["features"]["entryState"]["previousReports"],
        json!([saved[0].attempt.output])
    );
    let mut failed = saved[0].attempt.clone();
    failed.outcome = Some("budget_timeout".into());
    service.store.save_attempt(&failed).await.unwrap();
    let (_, rows) = exported_steps(&service, false).await;
    assert_eq!(rows[0]["outcome"]["outcome"], "budget_timeout");
    assert!(rows[0]["outcome"]["reward"].is_null());
    directory.close().await;
}

#[tokio::test]
async fn changed_step_input_is_refused_before_dispatch_and_export() {
    let (directory, service, backend, root, version) = setup().await;
    let prepared = prepare_step(&service, &root, &version, 0, 30, None, None)
        .await
        .unwrap();
    sqlx::query("UPDATE workflow_steps SET prompt='changed after preparation' WHERE attempt_id=?")
        .bind(&prepared.attempt.id)
        .execute(&service.store.pool)
        .await
        .unwrap();
    let (_tx, cancel) = watch::channel(false);
    assert_eq!(
        execute(&service, root, version, 30, cancel)
            .await
            .unwrap_err()
            .code,
        "evidence_mismatch"
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        crate::services::benchmarks::export::export(
            &service.store,
            &service.query_data().await.unwrap(),
            false
        )
        .await
        .unwrap_err()
        .code,
        "evidence_mismatch"
    );
    directory.close().await;
}

#[tokio::test]
async fn legacy_step_export_does_not_invent_a_pre_dispatch_decision() {
    let (directory, service, _, root, version) = setup().await;
    let (_tx, cancel) = watch::channel(false);
    execute(&service, root, version, 30, cancel).await.unwrap();
    sqlx::query("UPDATE workflow_steps SET decision_json=NULL")
        .execute(&service.store.pool)
        .await
        .unwrap();
    let (_, rows) = exported_steps(&service, false).await;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(
        |row| row["decisionStatus"] == "legacy_missing_pre_dispatch_decision"
            && row["decision"].is_null()
            && row["outcome"]["reward"].is_null()
    ));
    directory.close().await;
}

#[tokio::test]
async fn step_export_requires_explicit_heldout_scope_and_omits_later_outcomes() {
    let (directory, service, _, root, mut version) = setup().await;
    let (_tx, cancel) = watch::channel(false);
    let result = execute(&service, root, version.clone(), 30, cancel)
        .await
        .unwrap();
    let mut steps = saved_steps(&service.store, &result.id).await.unwrap();
    steps[1].attempt.finished_at = Some(now() + 60_000);
    service.store.save_attempt(&steps[1].attempt).await.unwrap();
    let (_, rows) = exported_steps(&service, false).await;
    assert!(rows[1]["outcome"]["usage"].is_null());
    assert!(rows[1]["outcome"]["outcome"].is_null());
    assert!(rows[0]["outcome"]["usage"].is_object());
    // Isolated storage fixture: exercise split filtering without collecting
    // another worker outcome or modifying any live benchmark version.
    version.manifest.split = "held_out".into();
    sqlx::query("UPDATE benchmark_versions SET manifest_json=? WHERE id=?")
        .bind(serde_json::to_string(&version.manifest).unwrap())
        .bind(&version.id)
        .execute(&service.store.pool)
        .await
        .unwrap();
    service.store.forget_parsed();
    assert!(exported_steps(&service, false).await.1.is_empty());
    assert_eq!(exported_steps(&service, true).await.1.len(), 2);
    version.manifest.split = "development".into();
    sqlx::query("UPDATE benchmark_versions SET manifest_json=? WHERE id=?")
        .bind(serde_json::to_string(&version.manifest).unwrap())
        .bind(&version.id)
        .execute(&service.store.pool)
        .await
        .unwrap();
    service.store.forget_parsed();
    assert!(exported_steps(&service, true).await.1.is_empty());
    directory.close().await;
}

#[tokio::test]
async fn auxiliary_work_is_preserved_when_a_later_step_is_cancelled() {
    let (directory, service, _, root, version) = setup().await;
    let (_tx, cancel) = watch::channel(false);
    let mut result = execute(&service, root, version, 30, cancel).await.unwrap();
    let mut steps = saved_steps(&service.store, &result.id).await.unwrap();
    steps[0].attempt.usage.schema = "provider_turn_with_auxiliary_v2".into();
    steps[0]
        .attempt
        .observed
        .as_mut()
        .unwrap()
        .execution_profile = "native_text_auxiliary".into();
    steps[1].attempt.outcome = Some("cancelled".into());
    // The newest step whose usage named the model that answered speaks
    // for the task.
    steps[0].attempt.resolved_model = Some("fake-pass-2026".into());
    aggregate(&mut result, &steps);
    assert_eq!(result.resolved_model.as_deref(), Some("fake-pass-2026"));
    assert_eq!(result.usage.schema, "workflow_sum_with_auxiliary_v2");
    assert_eq!(
        result.observed.unwrap().execution_profile,
        "native_text_auxiliary"
    );
    assert_eq!(result.usage.input, Some(20));
    directory.close().await;
}

/// A repository case's tool turns need several model calls, so its root
/// keeps the profile its run planned: marked as a text one, the
/// repetition would stand apart from the rest of its case's cell.
#[tokio::test]
async fn auxiliary_calls_leave_a_repository_root_on_its_profile() {
    let (directory, service, _, root, version) = setup().await;
    let (_tx, cancel) = watch::channel(false);
    let mut result = execute(&service, root, version, 30, cancel).await.unwrap();
    let mut steps = saved_steps(&service.store, &result.id).await.unwrap();
    result.configuration.execution_profile = "protected_repository".into();
    for step in &mut steps {
        step.attempt.observed.as_mut().unwrap().execution_profile = "protected_repository".into();
    }
    steps[0].attempt.usage.schema = "provider_turn_with_auxiliary_v2".into();
    aggregate(&mut result, &steps);
    // The usage still says auxiliary calls were made.
    assert_eq!(result.usage.schema, "workflow_sum_with_auxiliary_v2");
    assert_eq!(
        result.observed.unwrap().execution_profile,
        "protected_repository"
    );
    directory.close().await;
}

/// A workflow root's speed is compared under its most loaded step's
/// admission, so a root carries that step's record.
#[tokio::test]
async fn a_root_carries_its_most_loaded_steps_admission() {
    let (directory, service, _, root, version) = setup().await;
    let (_tx, cancel) = watch::channel(false);
    let mut result = execute(&service, root, version, 30, cancel).await.unwrap();
    let mut steps = saved_steps(&service.store, &result.id).await.unwrap();
    aggregate(&mut result, &steps);
    assert_eq!(result.sandbox_admission, None);
    for (step, heavy) in steps.iter_mut().zip([4, 1]) {
        step.attempt.sandbox_admission = Some(
            serde_json::from_value(json!({
                "lane":"heavy","competing":{},"competingHeavy":heavy,"reservedMemory":0,
                "reservedCpu":0,"memoryCurrent":0,"guestLoad":[0.0,0.0,0.0],"guestCpus":16,
                "guestMemAvailable":0,"hostAvailableRam":0,"hostAvailableCommit":0
            }))
            .unwrap(),
        );
    }
    aggregate(&mut result, &steps);
    assert_eq!(
        result
            .sandbox_admission
            .as_ref()
            .map(|admission| admission.competing_heavy),
        Some(4)
    );
    // One executed step without a recorded admission leaves the root
    // unrecorded, never banded by the steps that recorded one.
    steps[1].attempt.sandbox_admission = None;
    aggregate(&mut result, &steps);
    assert_eq!(result.sandbox_admission, None);
    directory.close().await;
}

#[tokio::test]
async fn workflow_runs_fresh_steps_once_and_retains_declared_feedback() {
    let (directory, service, backend, root, version) = setup().await;
    let (_tx, cancel) = watch::channel(false);
    let result = execute(&service, root, version.clone(), 30, cancel.clone())
        .await
        .unwrap();
    assert_eq!(result.outcome.as_deref(), Some("completed"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    assert_eq!(result.workflow_steps.len(), 2);
    assert_ne!(
        result.workflow_steps[0].attempt_id,
        result.workflow_steps[1].attempt_id
    );
    assert_ne!(
        result.workflow_steps[0].host_run_id,
        result.workflow_steps[1].host_run_id
    );
    assert_eq!(result.usage.input, Some(20));
    assert_eq!(result.usage.output, Some(10));
    assert_eq!(result.usage.cost, None);
    assert_eq!(result.usage.cache_read, None);
    let saved = saved_steps(&service.store, &result.id).await.unwrap();
    assert!(saved[0].entry.previous_reports.is_empty());
    assert!(!saved[0]
        .prompt
        .contains(&version.manifest.evaluator.known_good));
    assert_eq!(
        saved[1].entry.previous_reports,
        vec![saved[0].attempt.output.clone().unwrap()]
    );
    assert_eq!(saved[1].entry.parent_step_id.as_deref(), Some("plan"));
    assert_eq!(
        saved[1].entry.content_hash,
        crate::services::benchmarks::routing::entry_hash(&saved[1].entry)
    );
    assert_eq!(
        crate::services::benchmarks::evaluation::evaluate(
            &version.manifest.evaluator,
            result.output.as_deref().unwrap()
        )
        .unwrap()
        .verdict,
        "pass"
    );
    execute(&service, result, version, 30, cancel)
        .await
        .unwrap();
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    directory.close().await;
}

#[tokio::test]
async fn workflow_cancel_acknowledges_active_child_and_never_starts_next() {
    let (directory, service, backend, root, version) = setup().await;
    let (tx, cancel) = watch::channel(false);
    let stop = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        tx.send(true).unwrap();
    });
    let result = execute(&service, root, version, 30, cancel).await.unwrap();
    stop.await.unwrap();
    assert_eq!(result.outcome.as_deref(), Some("cancelled"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(result.workflow_steps.len(), 1);
    directory.close().await;
}

/// A step the host refused before any provider call goes back to the
/// queue with its workflow, which the runner holds for the operator; the
/// next pass runs that step, never settles it.
#[tokio::test]
async fn a_step_refused_before_its_session_waits_with_its_workflow() {
    let (directory, service, backend, root, version) = setup().await;
    backend.capability_refusals.store(1, Ordering::SeqCst);
    let (_tx, cancel) = watch::channel(false);
    let refused = execute(&service, root.clone(), version.clone(), 30, cancel.clone())
        .await
        .unwrap_err();
    assert_eq!(refused.code, "capability_missing");
    let steps = saved_steps(&service.store, &root.id).await.unwrap();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].attempt.phase, "pending");
    assert_eq!(steps[0].attempt.outcome, None);
    assert_eq!(steps[0].attempt.started_at, None);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    let result = execute(&service, root, version, 30, cancel).await.unwrap();
    assert_eq!(result.outcome.as_deref(), Some("completed"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    directory.close().await;
}

#[tokio::test]
async fn workflow_recovery_waits_for_resume_and_never_repeats_completed_prefix() {
    let (directory, service, backend, root, version) = setup().await;
    let mut first = prepare_step(&service, &root, &version, 0, 30, None, None)
        .await
        .unwrap();
    first.attempt.phase = "preparing".into();
    first.attempt.started_at = Some(now());
    service.store.save_attempt(&first.attempt).await.unwrap();
    let (_tx, cancel) = watch::channel(false);
    first.attempt = service
        .backend
        .execute(
            &service.store,
            first.attempt.clone(),
            step_version(&version, &first),
            30,
            cancel.clone(),
        )
        .await
        .unwrap();
    first.attempt.phase = "terminal".into();
    service.store.save_attempt(&first.attempt).await.unwrap();
    service.store.recover().await.unwrap();
    let interrupted = service.store.attempt(&root.id).await.unwrap();
    let restored = recover(&service, interrupted, version.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.phase, "pending");
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        service.store.run(&root.run_id).await.unwrap().state,
        "needs_attention"
    );
    service.control(&root.run_id, "resume").await.unwrap();
    let result = execute(&service, restored, version, 30, cancel)
        .await
        .unwrap();
    assert_eq!(result.outcome.as_deref(), Some("completed"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    directory.close().await;
}

#[tokio::test]
async fn uncertain_workflow_step_is_never_automatically_resent() {
    let (directory, service, backend, root, version) = setup().await;
    let mut first = prepare_step(&service, &root, &version, 0, 30, None, None)
        .await
        .unwrap();
    first.attempt.phase = "dispatching".into();
    first.attempt.started_at = Some(now());
    service.store.save_attempt(&first.attempt).await.unwrap();
    let restored = recover(&service, root, version).await.unwrap().unwrap();
    assert_eq!(restored.outcome.as_deref(), Some("dispatch_uncertain"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        saved_steps(&service.store, &restored.id)
            .await
            .unwrap()
            .len(),
        1
    );
    directory.close().await;
}

#[tokio::test]
async fn workflow_recovery_checks_selection_and_budget_before_final_evaluation() {
    let (directory, service, backend, root, version) = setup().await;
    let mut first = prepare_step(&service, &root, &version, 0, 30, None, None)
        .await
        .unwrap();
    let mut second = prepare_step(
        &service,
        &root,
        &version,
        1,
        29,
        Some("public report"),
        None,
    )
    .await
    .unwrap();
    for saved in [&mut first, &mut second] {
        saved.attempt.phase = "terminal".into();
        saved.attempt.outcome = Some("completed".into());
        saved.attempt.observed = Some(saved.attempt.configuration.clone());
        saved.attempt.output = Some(version.manifest.evaluator.known_good.clone());
        saved.attempt.started_at = Some(now());
        saved.attempt.finished_at = Some(now());
        saved.attempt.duration_ms = Some(300);
    }
    second.attempt.observed.as_mut().unwrap().effort = Some("different".into());
    service.store.save_attempt(&first.attempt).await.unwrap();
    service.store.save_attempt(&second.attempt).await.unwrap();
    let restored = recover(&service, root.clone(), version.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.outcome.as_deref(), Some("selection_changed"));
    second.attempt.observed = first.attempt.observed.clone();
    second.attempt.duration_ms = Some(30_000);
    service.store.save_attempt(&second.attempt).await.unwrap();
    let restored = recover(&service, root, version).await.unwrap().unwrap();
    assert_eq!(restored.outcome.as_deref(), Some("budget_timeout"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    directory.close().await;
}

#[tokio::test]
async fn sealed_workflow_cancellation_without_output_survives_restart() {
    let (directory, service, backend, root, version) = setup().await;
    let (_tx, cancel) = watch::channel(true);
    let result = execute(&service, root, version.clone(), 30, cancel)
        .await
        .unwrap();
    assert_eq!(result.outcome.as_deref(), Some("cancelled"));
    assert!(result.output.is_none());
    service.store.recover().await.unwrap();
    let interrupted = service.store.attempt(&result.id).await.unwrap();
    let restored = recover(&service, interrupted, version)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(restored.outcome.as_deref(), Some("cancelled"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    directory.close().await;
}

#[tokio::test]
async fn workflow_entry_content_hash_matches_candidates_and_changes_with_feedback() {
    let (directory, _service, _backend, first, version) = setup().await;
    let mut second = first.clone();
    second.id = "another-candidate-attempt".into();
    second.configuration.model_id = "another-model".into();
    let a = step_entry(&first, &version.manifest, 0, 30, None).unwrap();
    let b = step_entry(&second, &version.manifest, 0, 30, None).unwrap();
    assert_ne!(a.root_task_id, b.root_task_id);
    assert_eq!(a.content_hash, b.content_hash);
    let x = step_entry(&first, &version.manifest, 1, 29, Some("first answer")).unwrap();
    let y = step_entry(&second, &version.manifest, 1, 29, Some("different answer")).unwrap();
    assert_ne!(x.content_hash, y.content_hash);
    directory.close().await;
}

#[test]
fn workflow_rejects_ambiguous_feedback_and_unbounded_driver() {
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    draft.workflow = Some(WorkflowSpec {
        schema_version: 1,
        driver_revision: "1".into(),
        steps: vec![WorkflowStep {
            id: "a".into(),
            prompt: "p".into(),
            include_previous_output: true,
            scope: None,
        }],
    });
    assert!(validate(&draft).len() >= 2);
}
