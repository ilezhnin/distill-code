//! Invented service-API acceptance; it establishes plumbing, never model quality.
use super::*;
use crate::services::benchmarks::{
    promotion::*, qualification, workflow_campaign, workflow_campaign::acceptance,
};

async fn qualify(service: &BenchmarkService, versions: &[BenchmarkVersion]) -> Vec<String> {
    let mut ids = vec![];
    for version in versions {
        let record = service
            .qualify_version(qualification::Request {
                request_key: format!("controls:{}", version.id),
                version_id: version.id.clone(),
                content_hash: version.content_hash.clone(),
                evaluator_revision: version.manifest.evaluator.revision.clone(),
                reviewer: "Invented acceptance operator".into(),
                contract_review: "Exact text output contract".into(),
                alternative_review: "Whitespace alternatives are accepted".into(),
                family_review: "Independent invented family".into(),
                exposure_review: "Offline development plumbing only".into(),
                requirements: vec![qualification::Requirement {
                    id: "value".into(),
                    statement: "Return the required value".into(),
                    positive_controls: vec!["a".into(), "b".into()],
                    negative_controls: vec!["c".into(), "d".into()],
                }],
                controls: [
                    ("a", "ok", "pass"),
                    ("b", " ok ", "pass"),
                    ("c", "wrong", "fail"),
                    ("d", "absent", "fail"),
                ]
                .into_iter()
                .map(|(id, output, expected)| qualification::Control {
                    id: id.into(),
                    output: output.into(),
                    expected: expected.into(),
                    rationale: "Explicit invented outcome".into(),
                })
                .collect(),
            })
            .await
            .unwrap();
        assert_eq!(record.status, "controls_verified_review_attested");
        ids.push(record.id);
    }
    // Native timestamps are milliseconds. The strict temporal boundary must
    // remain distinguishable even on this fast, provider-free fixture.
    tokio::time::sleep(Duration::from_millis(2)).await;
    ids
}
async fn fit(service: &BenchmarkService, training: &[BenchmarkVersion]) -> learned::FitArtifact {
    let fit = learned::fit(
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
    service.store.save_selector_fit(&fit).await.unwrap();
    fit
}
async fn roots(service: &BenchmarkService, training: &[BenchmarkVersion]) -> Vec<BenchmarkVersion> {
    let mut result = vec![];
    for index in 0..8 {
        let mut draft = training[0].manifest.clone();
        draft.split = "held_out".into();
        draft.task_family = format!("promotion-holdout-{index}");
        draft.environment = json!({"splitGroup":format!("promotion-holdout-group-{index}")});
        draft.entry_state = None;
        draft.prompt = "Produce an artifact.".into();
        draft.workflow = Some(WorkflowSpec {
            schema_version: 1,
            driver_revision: "invented-promotion-v1".into(),
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
        result.push(
            service
                .publish_version(&definition.id, definition.draft_revision)
                .await
                .unwrap(),
        );
    }
    result
}
async fn campaign(
    service: &BenchmarkService,
    fit: &learned::FitArtifact,
    roots: &[BenchmarkVersion],
) -> workflow_campaign::Campaign {
    service
        .freeze_workflow_campaign(workflow_campaign::Request {
            request_key: "invented-preregistered-comparison".into(),
            model_id: fit.model.id.clone(),
            version_ids: roots.iter().map(|v| v.id.clone()).collect(),
            candidates: configurations(),
            persona_prior_ids: vec!["painter".into(), "parser".into()],
            min_quality: 0.0,
            repetitions: 3,
            timeout_seconds: 10,
            max_executions: 240,
        })
        .await
        .unwrap()
}
fn registration(
    campaign: &workflow_campaign::Campaign,
    training: &[BenchmarkVersion],
    ids: Vec<String>,
) -> Registration {
    Registration {
        request_key: "invented-promotion-rule".into(),
        campaign_id: campaign.plan.id.clone(),
        operator: "Invented acceptance operator".into(),
        rule: acceptance::Rule {
            recipe: "independent-group-sign-holm-v1".into(),
            alpha: 0.05,
            minimum_group_utility_gain: 0.0,
            minimum_observed_quality: 1.0,
        },
        contract: Contract::from_task(&learned::PublicTask::from(&training[0].manifest)),
        qualification_ids: ids,
    }
}
#[tokio::test]
async fn qualified_collection_preregistration_positive_promotion_and_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let backend = Arc::new(OfflineWorkers::default());
    let service = open(dir.path(), backend.clone()).await;
    let training = publish_with_entry(&service, "train", 8, true).await;
    let mut ids = qualify(&service, &training).await;
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    measure(&service, &training, "qualified-training").await;
    let fit = fit(&service, &training).await;
    let held = roots(&service, &training).await;
    ids.extend(qualify(&service, &held).await);
    let frozen = campaign(&service, &fit, &held).await;
    let request = registration(&frozen, &training, ids);
    let rule = service
        .store
        .register_promotion_rule(request.clone())
        .await
        .unwrap();
    assert_eq!(
        service
            .store
            .register_promotion_rule(request)
            .await
            .unwrap()
            .artifact_hash,
        rule.artifact_hash
    );
    assert!(service
        .store
        .promote_selector(&frozen.plan.id)
        .await
        .is_err());
    service
        .control_workflow_campaign(&frozen.plan.id, "start")
        .await
        .unwrap();
    for _ in 0..600 {
        if service
            .store
            .workflow_campaign(&frozen.plan.id)
            .await
            .unwrap()
            .state
            != "running"
        {
            break;
        }
        service.tick().await.unwrap();
    }
    let state = service
        .store
        .promote_selector(&frozen.plan.id)
        .await
        .unwrap();
    assert!(state.certificate.assessment.passed);
    assert_eq!(state.certificate.assessment.groups, 8);
    assert_eq!(
        service
            .store
            .require_active_promotion(&state.certificate.id)
            .await
            .unwrap()
            .artifact_hash,
        state.certificate.artifact_hash
    );
    use crate::services::benchmarks::task_execution::{
        ModeReference, ModeRequest, Request as TaskRequest, WaveEntry,
    };
    let fresh = |key: &str| TaskRequest {
        request_key: key.into(),
        surface: "chat".into(),
        context_id: "invented-chat-context".into(),
        promotion_id: state.certificate.id.clone(),
        acknowledged_certificate_hash: state.certificate.artifact_hash.clone(),
        prompt: training[0].manifest.prompt.clone(),
        hard_candidate_key: None,
        repository: None,
        entry: None,
        wave_mode: None,
    };
    let prepared = service
        .prepare_owned_task(fresh("owned-positive-chat"))
        .await
        .unwrap();
    assert_eq!(prepared.binding.decision.source, "learned");
    assert!(prepared.binding.decision.learned_dispatch_allowed);
    assert_eq!(prepared.session.observed.model_id, "parser");
    assert_eq!(
        service
            .prepare_owned_task(fresh("owned-positive-chat"))
            .await
            .unwrap()
            .binding
            .artifact_hash,
        prepared.binding.artifact_hash
    );
    assert_eq!(backend.prepare_calls.load(Ordering::SeqCst), 1);
    let mut forged = serde_json::to_value(fresh("forged-task")).unwrap();
    forged["permissions"] = json!({"tools":["filesystem"]});
    assert!(serde_json::from_value::<TaskRequest>(forged).is_err());
    backend.wrong_ack.store(true, Ordering::SeqCst);
    assert!(service
        .prepare_owned_task(fresh("wrong-provider-ack"))
        .await
        .is_err());
    backend.wrong_ack.store(false, Ordering::SeqCst);
    let delayed = service
        .prepare_owned_task(fresh("delayed-task"))
        .await
        .unwrap();
    backend.changed_runtime.store(true, Ordering::SeqCst);
    assert!(service
        .dispatch_owned_task(&delayed.binding.id)
        .await
        .is_err());
    backend.changed_runtime.store(false, Ordering::SeqCst);
    backend.unavailable.lock().unwrap().push("parser".into());
    assert!(service
        .dispatch_owned_task(&delayed.binding.id)
        .await
        .is_err());
    backend.unavailable.lock().unwrap().clear();
    assert_eq!(backend.owned_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        service
            .dispatch_owned_task(&prepared.binding.id)
            .await
            .unwrap()
            .phase,
        "terminal"
    );
    assert_eq!(
        service
            .dispatch_owned_task(&prepared.binding.id)
            .await
            .unwrap()
            .phase,
        "terminal"
    );
    assert_eq!(backend.owned_calls.load(Ordering::SeqCst), 1);
    let mut pinned = fresh("owned-pin");
    pinned.hard_candidate_key = Some(state.certificate.prior_keys[0].clone());
    let pinned = service.prepare_owned_task(pinned).await.unwrap();
    assert_eq!(pinned.binding.decision.source, "pin");
    assert!(!pinned.binding.decision.learned_dispatch_allowed);
    let mode_request = ModeRequest {
        context_id: "invented-conductor".into(),
        promotion_id: Some(state.certificate.id.clone()),
        acknowledged_certificate_hash: state.certificate.artifact_hash.clone(),
        repository: None,
    };
    let mode = service
        .store
        .set_owned_task_mode(mode_request.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        service
            .store
            .set_owned_task_mode(mode_request)
            .await
            .unwrap()
            .unwrap()
            .artifact_hash,
        mode.artifact_hash
    );
    let mut wave_first = fresh("owned-wave-0");
    wave_first.surface = "wave".into();
    wave_first.context_id = "invented-conductor:wave:invented-wave".into();
    wave_first.wave_mode = Some(ModeReference {
        context_id: "invented-conductor".into(),
        artifact_hash: mode.artifact_hash.clone(),
    });
    let first = service
        .prepare_owned_task(wave_first.clone())
        .await
        .unwrap();
    service
        .dispatch_owned_task(&first.binding.id)
        .await
        .unwrap();
    let mut wave_next = wave_first;
    wave_next.request_key = "owned-wave-1".into();
    wave_next.prompt = training[1].manifest.prompt.clone();
    wave_next.entry = Some(WaveEntry {
        root_binding_id: first.binding.id.clone(),
        previous_binding_ids: vec![first.binding.id.clone()],
        include_previous_output: true,
    });
    let second = service.prepare_owned_task(wave_next.clone()).await.unwrap();
    assert_eq!(second.binding.decision.source, "learned");
    assert_eq!(
        second.binding.task.entry.as_ref().unwrap().previous_reports,
        vec![crate::services::benchmarks::workflow::committed_report(
            "ok"
        )]
    );
    assert_eq!(
        second
            .binding
            .task
            .entry
            .as_ref()
            .unwrap()
            .remaining_budget_seconds,
        crate::services::benchmarks::workflow::remaining_seconds(10, 8).unwrap()
    );
    let collection_entry: String = sqlx::query_scalar(
        "SELECT next.entry_state_json FROM workflow_steps next JOIN workflow_steps previous ON previous.root_attempt_id=next.root_attempt_id AND previous.step_index=0 WHERE next.step_index=1 AND json_extract(previous.data_json,'$.output')='ok' ORDER BY next.rowid LIMIT 1",
    )
    .fetch_one(&service.store.pool)
    .await
    .unwrap();
    let collection_entry: EntryState = serde_json::from_str(&collection_entry).unwrap();
    assert_eq!(
        second.binding.task.entry.as_ref().unwrap().previous_reports,
        collection_entry.previous_reports
    );
    assert_eq!(
        second
            .binding
            .task
            .entry
            .as_ref()
            .unwrap()
            .remaining_budget_seconds,
        collection_entry.remaining_budget_seconds
    );
    wave_next.request_key = "owned-wave-no-access".into();
    wave_next.entry.as_mut().unwrap().include_previous_output = false;
    let no_access = service.prepare_owned_task(wave_next).await.unwrap();
    assert!(no_access
        .binding
        .task
        .entry
        .as_ref()
        .unwrap()
        .previous_reports
        .is_empty());
    assert_eq!(
        service
            .store
            .promote_selector(&frozen.plan.id)
            .await
            .unwrap()
            .certificate
            .artifact_hash,
        state.certificate.artifact_hash
    );
    service
        .store
        .revoke_promotion(&state.certificate.id, "Invented revocation")
        .await
        .unwrap();
    assert!(service
        .store
        .require_active_promotion(&state.certificate.id)
        .await
        .is_err());
    assert!(service
        .store
        .promote_selector(&frozen.plan.id)
        .await
        .unwrap()
        .revoked_at
        .is_some());
    assert!(service
        .dispatch_owned_task(&delayed.binding.id)
        .await
        .is_err());
    assert!(service
        .dispatch_owned_task(&second.binding.id)
        .await
        .is_err());
    let fallback = service
        .prepare_owned_task(fresh("owned-after-revoke"))
        .await
        .unwrap();
    assert_eq!(fallback.binding.decision.source, "prior");
    assert!(!fallback.binding.decision.learned_dispatch_allowed);
    service
        .dispatch_owned_task(&fallback.binding.id)
        .await
        .unwrap();
    assert_eq!(backend.calls.load(Ordering::SeqCst), 288);
}
#[tokio::test]
async fn later_qualification_and_fit_cutoff_cannot_launder_earlier_data() {
    let dir = tempfile::tempdir().unwrap();
    let service = open(dir.path(), Arc::new(OfflineWorkers::default())).await;
    let training = publish_with_entry(&service, "train", 8, true).await;
    measure(&service, &training, "unqualified-training").await;
    let mut ids = qualify(&service, &training).await;
    let fit = fit(&service, &training).await;
    let held = roots(&service, &training).await;
    ids.extend(qualify(&service, &held).await);
    let frozen = campaign(&service, &fit, &held).await;
    let error = service
        .store
        .register_promotion_rule(registration(&frozen, &training, ids))
        .await
        .unwrap_err();
    assert!(error.message.contains("qualification before"));
}
#[tokio::test]
async fn effective_training_timeout_and_workflow_limits_must_match_deployment() {
    let dir = tempfile::tempdir().unwrap();
    let service = open(dir.path(), Arc::new(OfflineWorkers::default())).await;
    let mut training = publish_with_entry(&service, "train", 8, true).await;
    // Publish actual higher entry caps; no target evidence is inserted by hand.
    for version in &mut training {
        let mut draft = version.manifest.clone();
        draft.entry_state.as_mut().unwrap().remaining_budget_seconds = 20;
        let definition = service.store.save_draft(None, None, draft).await.unwrap();
        *version = service
            .publish_version(&definition.id, definition.draft_revision)
            .await
            .unwrap();
    }
    let mut ids = qualify(&service, &training).await;
    let run = service
        .start_run(RunRequest {
            request_key: "higher-collected-timeout".into(),
            version_ids: training.iter().map(|v| v.id.clone()).collect(),
            configurations: configurations(),
            repetitions: 3,
            timeout_seconds: 20,
            max_executions: 48,
            preview: false,
            parallelism: Some(4),
            workflow_policy: None,
        })
        .await
        .unwrap();
    for _ in 0..600 {
        if service.store.run(&run.id).await.unwrap().state == "completed" {
            break;
        }
        service.tick().await.unwrap();
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let fit = fit(&service, &training).await;
    let held = roots(&service, &training).await;
    ids.extend(qualify(&service, &held).await);
    let frozen = campaign(&service, &fit, &held).await;
    let error = service
        .store
        .register_promotion_rule(registration(&frozen, &training, ids))
        .await
        .unwrap_err();
    assert!(error
        .message
        .contains("effective collected training budget"));
    let mut contract = Contract::from_task(&learned::PublicTask::from(&training[0].manifest));
    contract.limits.max_artifact_bytes += 1;
    assert!(service
        .store
        .validate_campaign_contract(&frozen, &contract)
        .await
        .is_err());
}
