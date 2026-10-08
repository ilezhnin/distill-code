use super::*;
use crate::services::benchmarks::{workflow_campaign::*, workflow_policy::*};

async fn training(
    service: &Arc<BenchmarkService>,
) -> (Vec<BenchmarkVersion>, learned::FitArtifact) {
    let versions = publish_with_entry(service, "train", 8, true).await;
    measure(service, &versions, "campaign-training").await;
    let fit = learned::fit(
        &service.query_data().await.unwrap(),
        learned::FitRequest {
            work_class_id: "debug".into(),
            version_ids: versions.iter().map(|v| v.id.clone()).collect(),
            configurations: configurations(),
            cutoff_at: now(),
            weights: RoleWeights::default(),
        },
    )
    .unwrap();
    service.store.save_selector_fit(&fit).await.unwrap();
    (versions, fit)
}
async fn roots(
    service: &BenchmarkService,
    training: &[BenchmarkVersion],
    prefix: &str,
) -> Vec<BenchmarkVersion> {
    let mut roots = Vec::new();
    for index in 0..8 {
        let mut draft = training[0].manifest.clone();
        draft.split = "held_out".into();
        draft.task_family = format!("{prefix}-family-{index}");
        draft.environment = json!({"splitGroup":format!("{prefix}-group-{}",index/2)});
        draft.entry_state = None;
        draft.prompt = "Produce an artifact.".into();
        draft.workflow = Some(WorkflowSpec {
            schema_version: 1,
            driver_revision: "offline-campaign-v1".into(),
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
        roots.push(
            service
                .publish_version(&definition.id, definition.draft_revision)
                .await
                .unwrap(),
        );
    }
    roots
}
fn request(fit: &learned::FitArtifact, roots: &[BenchmarkVersion], key: &str) -> Request {
    Request {
        request_key: key.into(),
        model_id: fit.model.id.clone(),
        version_ids: roots.iter().map(|v| v.id.clone()).collect(),
        candidates: configurations(),
        persona_prior_ids: vec!["painter".into(), "parser".into()],
        min_quality: 0.0,
        repetitions: 3,
        timeout_seconds: 10,
        max_executions: 240,
    }
}
async fn finish(service: &Arc<BenchmarkService>, id: &str) -> Campaign {
    for _ in 0..600 {
        let campaign = service.store.workflow_campaign(id).await.unwrap();
        if campaign.state != "running" {
            return campaign;
        }
        service.tick().await.unwrap();
    }
    panic!("campaign failed to settle")
}

#[tokio::test]
async fn preregistered_campaign_executes_every_policy_and_reports_whole_trajectories() {
    let dir = tempfile::tempdir().unwrap();
    let backend = Arc::new(OfflineWorkers::default());
    let service = open(dir.path(), backend.clone()).await;
    let (train, fit) = training(&service).await;
    let roots = roots(&service, &train, "comparison").await;
    let request = request(&fit, &roots, "whole-comparison");
    let frozen = service
        .freeze_workflow_campaign(request.clone())
        .await
        .unwrap();
    assert_eq!(frozen.state, "reserved");
    assert_eq!(frozen.plan.cells.len(), 120);
    assert_eq!(frozen.plan.policies.len(), 5);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 48);
    let mut retry = request.clone();
    retry.version_ids.reverse();
    retry.candidates.reverse();
    assert_eq!(
        service
            .freeze_workflow_campaign(retry)
            .await
            .unwrap()
            .plan_hash,
        frozen.plan_hash
    );
    let mut changed = request.clone();
    changed.timeout_seconds += 1;
    assert!(service.freeze_workflow_campaign(changed).await.is_err());
    let mut duplicate = request;
    duplicate.request_key = "overlapping-campaign".into();
    assert!(service.freeze_workflow_campaign(duplicate).await.is_err());
    assert!(service
        .start_run(frozen.plan.run_request(0).unwrap())
        .await
        .is_err());
    assert!(service
        .store
        .workflow_campaign_report(&frozen.plan.id)
        .await
        .is_err());
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    assert!(service
        .start_run(frozen.plan.run_request(1).unwrap())
        .await
        .is_err());
    let mut edited = frozen.plan.run_request(0).unwrap();
    edited.timeout_seconds += 1;
    assert!(service.start_run(edited).await.is_err());
    let mut external = frozen.plan.run_request(0).unwrap();
    external.request_key = "outside-campaign".into();
    assert!(service.start_run(external).await.is_err());
    service.tick().await.unwrap();
    let key = frozen.plan.run_request(0).unwrap().request_key;
    let child = service
        .store
        .all_runs()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.request.request_key == key)
        .unwrap();
    for action in ["pause", "resume", "cancel"] {
        assert!(service.control(&child.id, action).await.is_err());
    }
    assert!(service.set_parallelism(&child.id, 1).await.is_err());
    assert!(service.rescore(&child.attempts[0].id).await.is_err());
    let complete = finish(&service, &frozen.plan.id).await;
    assert_eq!(complete.state, "completed");
    assert_eq!(complete.next_cell, 120);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 288);
    let report = service
        .store
        .workflow_campaign_report(&frozen.plan.id)
        .await
        .unwrap();
    assert_eq!(report.trace_hashes.len(), 120);
    assert_eq!(report.cases.len(), 8);
    assert_eq!(report.groups, 4);
    assert_eq!(report.policies.len(), 7);
    assert!(!report.dispatch_allowed);
    assert_eq!(
        report
            .policies
            .iter()
            .find(|p| p.policy == "learned")
            .unwrap()
            .quality,
        1.0
    );
    for policy in report
        .policies
        .iter()
        .filter(|p| p.policy != "learned" && p.policy != "oracle")
    {
        assert_eq!(policy.quality, 0.0);
    }
    assert!(report
        .cases
        .iter()
        .all(|c| c.cells.len() == 5 && c.cells.iter().all(|c| c.repeats.len() == 3)));
    assert_eq!(service.query_data().await.unwrap().runs.len(), 1);
    drop(service);
    let reopened = open(dir.path(), backend.clone()).await;
    assert_eq!(
        reopened
            .store
            .workflow_campaign_report(&frozen.plan.id)
            .await
            .unwrap()
            .artifact_hash,
        report.artifact_hash
    );
    reopened.tick().await.unwrap();
    assert_eq!(backend.calls.load(Ordering::SeqCst), 288);
}

#[tokio::test]
async fn campaign_preserves_refusal_and_requires_explicit_resume_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let backend = Arc::new(OfflineWorkers::default());
    let service = open(dir.path(), backend.clone()).await;
    let (train, fit) = training(&service).await;
    let roots = roots(&service, &train, "refusal").await;
    let frozen = service
        .freeze_workflow_campaign(request(&fit, &roots, "refused"))
        .await
        .unwrap();
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    *backend.refuse_next.lock().unwrap() = Some("quota_exhausted".into());
    let paused = finish(&service, &frozen.plan.id).await;
    assert_eq!(paused.state, "paused");
    assert_eq!(paused.next_cell, 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 48);
    let before: String = sqlx::query_scalar(
        "SELECT result_json FROM workflow_campaign_cells WHERE campaign_id=? AND cell_index=0",
    )
    .bind(&frozen.plan.id)
    .fetch_one(&service.store.pool)
    .await
    .unwrap();
    assert!(before.contains("quota_exhausted"));
    service
        .control_workflow_campaign(&frozen.plan.id, "resume")
        .await
        .unwrap();
    drop(service);
    let reopened = open(dir.path(), backend.clone()).await;
    for _ in 0..3 {
        reopened.tick().await.unwrap();
    }
    assert_eq!(
        reopened
            .store
            .workflow_campaign(&frozen.plan.id)
            .await
            .unwrap()
            .state,
        "paused"
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 48);
    reopened
        .control_workflow_campaign(&frozen.plan.id, "resume")
        .await
        .unwrap();
    assert_eq!(finish(&reopened, &frozen.plan.id).await.state, "completed");
    assert_eq!(backend.calls.load(Ordering::SeqCst), 286);
    assert!(reopened
        .store
        .workflow_campaign_report(&frozen.plan.id)
        .await
        .is_err());
    let after: String = sqlx::query_scalar(
        "SELECT result_json FROM workflow_campaign_cells WHERE campaign_id=? AND cell_index=0",
    )
    .bind(&frozen.plan.id)
    .fetch_one(&reopened.store.pool)
    .await
    .unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn reservations_cover_historical_relations_exposure_and_existing_holdouts() {
    let dir = tempfile::tempdir().unwrap();
    let backend = Arc::new(OfflineWorkers::default());
    let service = open(dir.path(), backend.clone()).await;
    let (train, fit) = training(&service).await;
    let held = publish_with_entry(&service, "held_out", 8, true).await;
    let holdout = learned::holdout::HoldoutRequest {
        request_key: "executor-holdout".into(),
        model_id: fit.model.id.clone(),
        version_ids: held.iter().map(|v| v.id.clone()).collect(),
        persona_prior: fit
            .model
            .candidates
            .iter()
            .map(|c| c.candidate_key.clone())
            .collect(),
        fallback_key: fit.model.candidates[0].candidate_key.clone(),
        min_quality: 0.0,
    };
    service.freeze_selector_holdout(holdout).await.unwrap();
    let roots_a = roots(&service, &train, "heldout-conflict").await;
    // Publish historical family/group relations through the native catalog.
    let mut bridge = roots_a[0].manifest.clone();
    bridge.environment = held[0].manifest.environment.clone();
    let d = service.store.save_draft(None, None, bridge).await.unwrap();
    service
        .publish_version(&d.id, d.draft_revision)
        .await
        .unwrap();
    assert!(service
        .freeze_workflow_campaign(request(&fit, &roots_a, "holdout-overlap"))
        .await
        .is_err());
    let roots_b = roots(&service, &train, "exposed").await;
    let policy = WorkflowPolicy {
        model_id: fit.model.id.clone(),
        mode: "persona".into(),
        candidates: configurations(),
        prior_ids: vec!["parser".into(), "painter".into()],
        fixed_candidate_id: None,
        min_quality: 0.0,
    };
    let run: RunRequest = WorkflowRunRequest {
        request_key: "preexisting-plan".into(),
        version_ids: vec![roots_b[0].id.clone()],
        policy,
        repetitions: 1,
        timeout_seconds: 10,
        max_executions: 2,
    }
    .try_into()
    .unwrap();
    let run = service.start_run(run).await.unwrap();
    service.control(&run.id, "cancel").await.unwrap();
    assert!(service
        .freeze_workflow_campaign(request(&fit, &roots_b, "already-exposed"))
        .await
        .is_err());
    let roots_c = roots(&service, &train, "joined-groups").await;
    let mut bridge = roots_c[0].manifest.clone();
    bridge.environment = roots_c[2].manifest.environment.clone();
    let d = service.store.save_draft(None, None, bridge).await.unwrap();
    service
        .publish_version(&d.id, d.draft_revision)
        .await
        .unwrap();
    assert!(service
        .freeze_workflow_campaign(request(&fit, &roots_c, "joined-groups"))
        .await
        .is_err());
    assert!(service.store.workflow_campaigns().await.unwrap().is_empty());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 48);
    let roots_d = roots(&service, &train, "campaign-first").await;
    let frozen = service
        .freeze_workflow_campaign(request(&fit, &roots_d, "campaign-first"))
        .await
        .unwrap();
    let mut relatives = Vec::new();
    for root in &roots_d {
        let mut draft = train[0].manifest.clone();
        draft.split = "held_out".into();
        draft.task_family = root.manifest.task_family.clone();
        draft.environment = root.manifest.environment.clone();
        let d = service.store.save_draft(None, None, draft).await.unwrap();
        relatives.push(
            service
                .publish_version(&d.id, d.draft_revision)
                .await
                .unwrap(),
        );
    }
    assert!(service
        .freeze_selector_holdout(learned::holdout::HoldoutRequest {
            request_key: "conflicting-executor-holdout".into(),
            model_id: fit.model.id.clone(),
            version_ids: relatives.iter().map(|v| v.id.clone()).collect(),
            persona_prior: fit
                .model
                .candidates
                .iter()
                .map(|c| c.candidate_key.clone())
                .collect(),
            fallback_key: fit.model.candidates[0].candidate_key.clone(),
            min_quality: 0.0
        })
        .await
        .is_err());
    // A newly published alias inherits reservation through its related group.
    let mut alias = relatives[0].manifest.clone();
    alias.task_family = "new-family-alias".into();
    let d = service.store.save_draft(None, None, alias).await.unwrap();
    let alias = service
        .publish_version(&d.id, d.draft_revision)
        .await
        .unwrap();
    let run = RunRequest {
        request_key: "alias-bypass".into(),
        version_ids: vec![alias.id.clone()],
        configurations: configurations(),
        workflow_policy: None,
        repetitions: 3,
        timeout_seconds: 10,
        max_executions: 6,
        preview: false,
        parallelism: Some(1),
    };
    assert!(service.start_run(run).await.is_err());
    let training_run = service
        .store
        .all_runs()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.request.request_key == "campaign-training")
        .unwrap();
    assert!(service
        .extend_run(&training_run.id, &[alias.id])
        .await
        .is_err());
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    service
        .control_workflow_campaign(&frozen.plan.id, "pause")
        .await
        .unwrap();
    service.tick().await.unwrap();
    assert_eq!(backend.calls.load(Ordering::SeqCst), 48);
    service
        .control_workflow_campaign(&frozen.plan.id, "resume")
        .await
        .unwrap();
    service.tick().await.unwrap();
    let calls = backend.calls.load(Ordering::SeqCst);
    service
        .control_workflow_campaign(&frozen.plan.id, "cancel")
        .await
        .unwrap();
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    assert_eq!(backend.calls.load(Ordering::SeqCst), calls);
    assert_eq!(
        service
            .store
            .workflow_campaign(&frozen.plan.id)
            .await
            .unwrap()
            .state,
        "cancelled"
    );
    assert!(service
        .control_workflow_campaign(&frozen.plan.id, "resume")
        .await
        .is_err());
}
