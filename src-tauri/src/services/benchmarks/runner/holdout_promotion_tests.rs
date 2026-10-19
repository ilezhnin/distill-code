//! Invented service-API acceptance of a class certificate from an executor
//! holdout; it establishes plumbing, never model quality.
use super::promotion_pipeline_tests::qualify;
use super::*;
use crate::services::benchmarks::{
    export::RuntimeMatch,
    learned::holdout::HoldoutRequest,
    promotion::{Discovery, HoldoutRegistration},
    workflow_campaign::acceptance,
};

/// Held-out executor cases in the training scope, one family and one group each.
async fn held_out(
    service: &BenchmarkService,
    template: &BenchmarkVersion,
    count: usize,
) -> Vec<BenchmarkVersion> {
    held_out_named(service, template, count, "certificate-holdout").await
}

async fn held_out_named(
    service: &BenchmarkService,
    template: &BenchmarkVersion,
    count: usize,
    stem: &str,
) -> Vec<BenchmarkVersion> {
    let mut versions = Vec::new();
    for index in 0..count {
        let mut draft = template.manifest.clone();
        draft.name = format!("Offline {stem} {index}");
        draft.split = "held_out".into();
        draft.task_family = format!("{stem}-{index}");
        draft.environment = json!({"splitGroup": format!("{stem}-group-{index}")});
        draft.prompt = if index % 2 == 0 {
            "Repair parser tokenizer grammar syntax"
        } else {
            "Repair painter canvas colors pixels"
        }
        .into();
        let definition = service.store.save_draft(None, None, draft).await.unwrap();
        versions.push(
            service
                .publish_version(&definition.id, definition.draft_revision)
                .await
                .unwrap(),
        );
    }
    versions
}

fn rule() -> acceptance::Rule {
    acceptance::Rule {
        recipe: acceptance::SELECTION_RECIPE.into(),
        alpha: 0.05,
        minimum_group_utility_gain: 0.0,
        minimum_observed_quality: 0.5,
        non_inferiority_margin: Some(0.05),
        max_incomplete_groups: None,
    }
}

#[tokio::test]
async fn a_passing_executor_holdout_certifies_the_class_for_ordinary_chats() {
    // Keep the complete async scenario off libtest's small Windows stack.
    Box::pin(certificate_scenario()).await;
}

async fn certificate_scenario() {
    let directory = crate::test_support::TempRoot::new();
    let backend = Arc::new(OfflineWorkers::default());
    let service = open(&directory, backend.clone()).await;
    let training = publish(&service, "train", 8).await;
    measure(&service, &training, "certificate-training").await;
    let artifact = fit_or_explain(
        &service,
        learned::FitRequest {
            work_class_id: "debug".into(),
            version_ids: training.iter().map(|v| v.id.clone()).collect(),
            configurations: configurations(),
            cutoff_at: now(),
            weights: RoleWeights::default(),
            runtime_match: Some(RuntimeMatch::ModelIdentity),
        },
    )
    .await;
    service.store.save_selector_fit(&artifact).await.unwrap();
    let key = |model: &str| {
        artifact
            .model
            .candidates
            .iter()
            .find(|c| c.configuration.model_id == model)
            .unwrap()
            .candidate_key
            .clone()
    };
    let held = held_out(&service, &training[0], 16).await;
    let qualifications = qualify(&service, &held).await;
    let plan = service
        .freeze_selector_holdout(HoldoutRequest {
            request_key: "certificate-holdout".into(),
            model_id: artifact.model.id.clone(),
            version_ids: held.iter().map(|v| v.id.clone()).collect(),
            // The declared order prefers the painter everywhere.
            persona_prior: vec![key("painter"), key("parser")],
            fallback_key: key("painter"),
            min_quality: 0.5,
        })
        .await
        .unwrap();
    let registration = HoldoutRegistration {
        request_key: "certificate-holdout-rule".into(),
        plan_id: plan.id.clone(),
        operator: "Invented acceptance operator".into(),
        rule: rule(),
        qualification_ids: qualifications.clone(),
    };
    // Every frozen case needs its qualification, and the original recipe
    // must name no margin.
    let mut partial = registration.clone();
    partial.qualification_ids.pop();
    assert!(service.store.register_holdout_rule(partial).await.is_err());
    let mut malformed = registration.clone();
    malformed.rule.recipe = "independent-group-sign-holm-v1".into();
    assert!(service
        .store
        .register_holdout_rule(malformed)
        .await
        .is_err());
    let saved = service
        .store
        .register_holdout_rule(registration.clone())
        .await
        .unwrap();
    assert_eq!(
        service
            .store
            .register_holdout_rule(registration.clone())
            .await
            .unwrap()
            .artifact_hash,
        saved.artifact_hash
    );
    let mut changed = registration.clone();
    changed.rule.alpha = 0.01;
    assert!(service.store.register_holdout_rule(changed).await.is_err());
    // Nothing certifies before the frozen measurement exists.
    assert!(service
        .store
        .promote_holdout_selector(&plan.id)
        .await
        .is_err());
    assert!(service
        .store
        .class_certificate("debug")
        .await
        .unwrap()
        .is_none());
    // Reservation and measurement must be distinct millisecond timestamps.
    tokio::time::sleep(Duration::from_millis(2)).await;
    measure(&service, &held, "certificate-measurement").await;
    // A released reservation opens the families to ordinary runs: no
    // certificate, however the measurement went.
    let released: Vec<(String, String)> =
        sqlx::query_as("SELECT kind,value FROM evaluation_reservations WHERE owner_id=?")
            .bind(&plan.id)
            .fetch_all(&service.store.pool)
            .await
            .unwrap();
    assert_eq!(released.len(), 32);
    sqlx::query("DELETE FROM evaluation_reservations WHERE kind=? AND value=?")
        .bind(&released[0].0)
        .bind(&released[0].1)
        .execute(&service.store.pool)
        .await
        .unwrap();
    assert!(service
        .store
        .promote_holdout_selector(&plan.id)
        .await
        .unwrap_err()
        .message
        .contains("no longer reserved"));
    sqlx::query("INSERT INTO evaluation_reservations(kind,value,owner_kind,owner_id) VALUES(?,?,'executor_holdout',?)")
        .bind(&released[0].0)
        .bind(&released[0].1)
        .bind(&plan.id)
        .execute(&service.store.pool)
        .await
        .unwrap();
    let state = service
        .store
        .promote_holdout_selector(&plan.id)
        .await
        .unwrap();
    let certificate = &state.certificate;
    assert_eq!(certificate.source.as_deref(), Some("executor_holdout"));
    assert_eq!(certificate.campaign_id, plan.id);
    assert!(certificate.assessment.passed);
    assert_eq!(certificate.assessment.groups, 16);
    assert!(certificate.native_inventory.is_none() && certificate.trajectory.is_none());
    assert_eq!(
        service
            .store
            .promote_holdout_selector(&plan.id)
            .await
            .unwrap()
            .certificate
            .id,
        certificate.id
    );
    let (class, model_id) = service
        .store
        .class_certificate("debug")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(class.id, certificate.id);
    assert_eq!(model_id, artifact.model.id);
    assert!(service
        .store
        .promotions()
        .await
        .unwrap()
        .iter()
        .any(|p| p.certificate.id == certificate.id));
    assert_eq!(
        service
            .store
            .class_policies()
            .await
            .unwrap()
            .iter()
            .find(|p| p.work_class_id == "debug")
            .unwrap()
            .certificate_id
            .as_deref(),
        Some(certificate.id.as_str())
    );
    // An ordinary chat of the class, with its own role, tools and unknown
    // interactive runtime, now chooses through the learned model.
    let ordinary = |key: &str| {
        let mut task = learned::PublicTask::from(&training[0].manifest);
        task.role_id = Some("invented-ordinary-agent".into());
        task.role_prompt = "An ordinary agent with its own tools.".into();
        task.execution_profile = "interactive_acp".into();
        task.permissions.tools = vec!["acp_session".into()];
        task.permissions.network = true;
        task.permissions.context = "Host-resolved interactive permissions".into();
        task.limits.timeout_seconds = 0;
        task.limits.max_turns = 0;
        task.limits.max_artifact_bytes = 0;
        executor::Request::try_from(executor::ApplicationRequest {
            request_key: key.into(),
            surface: "chat".into(),
            context_id: "invented-certificate-chat".into(),
            task,
            target_family: "application:invented-certificate".into(),
            target_group: "application:invented-certificate".into(),
            candidates: configurations()
                .into_iter()
                .map(|mut configuration| {
                    configuration.billing_mode = "unknown".into();
                    configuration.execution_profile = "interactive_acp".into();
                    configuration.inventory_revision = None;
                    RoutingCandidate {
                        configuration,
                        available: true,
                        reason: None,
                    }
                })
                .collect(),
            prior_ids: vec!["painter".into()],
            hard_candidate_id: None,
            model_id: None,
            min_quality: 0.0,
        })
        .unwrap()
    };
    let decision = service
        .store
        .prepare_ordinary_executor_decision(ordinary("certificate-chat"))
        .await
        .unwrap();
    assert_eq!(decision.learned_status, executor::CERTIFIED_CLASS_POLICY);
    assert_eq!(decision.source, "learned");
    assert_eq!(decision.chosen.as_ref().unwrap().model_id, "parser");
    assert!(decision.learned_dispatch_allowed);
    // A revoked qualification of a frozen case deactivates the certificate.
    service
        .store
        .revoke_qualification(&qualifications[0], "Invented control error")
        .await
        .unwrap();
    assert!(service
        .store
        .class_certificate("debug")
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        service
            .store
            .require_active_promotion(&certificate.id)
            .await
            .unwrap_err()
            .code,
        "invalid_promotion"
    );
    // Owned native deployments never discover or cover a holdout certificate.
    assert!(!certificate.covers(&certificate.contract, 0));
    assert!(matches!(
        service
            .store
            .discover_active_policy(&certificate.contract, &[], &certificate.prior_keys)
            .await
            .unwrap(),
        Discovery::Refused(_)
    ));
    // Revocation returns the class to its declared order at once.
    service
        .store
        .revoke_promotion(&certificate.id, "Invented revocation")
        .await
        .unwrap();
    assert!(service
        .store
        .class_certificate("debug")
        .await
        .unwrap()
        .is_none());
    let fallback = service
        .store
        .preview_ordinary_executor_decision(ordinary("certificate-chat-after-revocation"))
        .await
        .unwrap();
    assert_eq!(fallback.learned_status, executor::NO_CLASS_CERTIFICATE);
    assert_eq!(fallback.chosen.as_ref().unwrap().model_id, "painter");
    // A rule cannot be registered once any run named a reserved family.
    let late = held_out_named(&service, &training[0], 8, "certificate-late").await;
    let late_ids = qualify(&service, &late).await;
    let late_plan = service
        .freeze_selector_holdout(HoldoutRequest {
            request_key: "certificate-late-holdout".into(),
            model_id: artifact.model.id.clone(),
            version_ids: late.iter().map(|v| v.id.clone()).collect(),
            persona_prior: vec![key("painter"), key("parser")],
            fallback_key: key("painter"),
            min_quality: 0.5,
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(2)).await;
    measure(&service, &late, "certificate-late-measurement").await;
    let refused = service
        .store
        .register_holdout_rule(HoldoutRegistration {
            request_key: "certificate-late-rule".into(),
            plan_id: late_plan.id.clone(),
            operator: "Invented acceptance operator".into(),
            rule: rule(),
            qualification_ids: late_ids,
        })
        .await
        .unwrap_err();
    assert!(refused.message.contains("before any run"), "{refused:?}");
    // A holdout certificate cannot pass for a campaign certificate.
    sqlx::query("UPDATE selector_holdout_promotions SET artifact_json=json_remove(artifact_json,'$.source')")
        .execute(&service.store.pool)
        .await
        .unwrap();
    assert!(service.store.promotion(&certificate.id).await.is_err());
    directory.close().await;
}

#[tokio::test]
async fn a_group_lost_within_the_registered_tolerance_is_left_out_of_every_arm() {
    Box::pin(tolerance_scenario()).await;
}

async fn tolerance_scenario() {
    let directory = crate::test_support::TempRoot::new();
    let backend = Arc::new(OfflineWorkers::default());
    let service = open(&directory, backend.clone()).await;
    let training = publish(&service, "train", 8).await;
    measure(&service, &training, "tolerance-training").await;
    let artifact = fit_or_explain(
        &service,
        learned::FitRequest {
            work_class_id: "debug".into(),
            version_ids: training.iter().map(|v| v.id.clone()).collect(),
            configurations: configurations(),
            cutoff_at: now(),
            weights: RoleWeights::default(),
            runtime_match: Some(RuntimeMatch::ModelIdentity),
        },
    )
    .await;
    service.store.save_selector_fit(&artifact).await.unwrap();
    let key = |model: &str| {
        artifact
            .model
            .candidates
            .iter()
            .find(|c| c.configuration.model_id == model)
            .unwrap()
            .candidate_key
            .clone()
    };
    let held = held_out_named(&service, &training[0], 16, "tolerance-holdout").await;
    let qualifications = qualify(&service, &held).await;
    let plan = service
        .freeze_selector_holdout(HoldoutRequest {
            request_key: "tolerance-holdout".into(),
            model_id: artifact.model.id.clone(),
            version_ids: held.iter().map(|v| v.id.clone()).collect(),
            persona_prior: vec![key("painter"), key("parser")],
            fallback_key: key("painter"),
            min_quality: 0.5,
        })
        .await
        .unwrap();
    let mut tolerant = rule();
    tolerant.max_incomplete_groups = Some(1);
    service
        .store
        .register_holdout_rule(HoldoutRegistration {
            request_key: "tolerance-holdout-rule".into(),
            plan_id: plan.id.clone(),
            operator: "Invented acceptance operator".into(),
            rule: tolerant,
            qualification_ids: qualifications,
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(2)).await;
    measure(&service, &held, "tolerance-measurement").await;
    // One first repetition settled unscored, as when a provider fails a
    // turn: it is never replaced, and its whole group leaves every arm.
    let lost: String =
        sqlx::query_scalar("SELECT id FROM attempts WHERE version_id=? ORDER BY rowid LIMIT 1")
            .bind(&held[1].id)
            .fetch_one(&service.store.pool)
            .await
            .unwrap();
    sqlx::query("UPDATE attempts SET data_json=json_set(data_json,'$.outcome','infrastructure_failure','$.evaluations',json('[]')) WHERE id=?")
        .bind(&lost)
        .execute(&service.store.pool)
        .await
        .unwrap();
    let state = service
        .store
        .promote_holdout_selector(&plan.id)
        .await
        .unwrap();
    assert!(state.certificate.assessment.passed);
    assert_eq!(state.certificate.assessment.groups, 15);
    let report = service
        .store
        .evaluate_selector_holdout(&plan.id)
        .await
        .unwrap();
    assert_eq!(report.status, "incomplete");
    assert_eq!(report.excluded.len(), 1);
    assert_eq!(report.excluded[0].version_id, held[1].id);
    assert!(report.cases.iter().all(|c| c.version_id != held[1].id));
    // A registered rule the measurement does not pass issues nothing.
    let strict_held = held_out_named(&service, &training[0], 16, "failing-holdout").await;
    let strict_ids = qualify(&service, &strict_held).await;
    let strict_plan = service
        .freeze_selector_holdout(HoldoutRequest {
            request_key: "failing-holdout".into(),
            model_id: artifact.model.id.clone(),
            version_ids: strict_held.iter().map(|v| v.id.clone()).collect(),
            persona_prior: vec![key("painter"), key("parser")],
            fallback_key: key("painter"),
            min_quality: 0.5,
        })
        .await
        .unwrap();
    let mut strict = rule();
    // Eight differing groups give p = 1/256; Holm doubles it past 0.5%.
    strict.alpha = 0.005;
    service
        .store
        .register_holdout_rule(HoldoutRegistration {
            request_key: "failing-holdout-rule".into(),
            plan_id: strict_plan.id.clone(),
            operator: "Invented acceptance operator".into(),
            rule: strict,
            qualification_ids: strict_ids,
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(2)).await;
    measure(&service, &strict_held, "failing-measurement").await;
    let failed = service
        .store
        .promote_holdout_selector(&strict_plan.id)
        .await
        .unwrap_err();
    assert!(
        failed.message.contains("Preregistered comparison failed"),
        "{failed:?}"
    );
    let issued: i64 =
        sqlx::query_scalar("SELECT count(*) FROM selector_holdout_promotions WHERE plan_id=?")
            .bind(&strict_plan.id)
            .fetch_one(&service.store.pool)
            .await
            .unwrap();
    assert_eq!(issued, 0);
    directory.close().await;
}
