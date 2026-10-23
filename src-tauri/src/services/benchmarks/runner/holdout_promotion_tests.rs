//! Invented service-API acceptance of a class certificate from a held-out
//! evaluation; it establishes plumbing, never model quality.
use super::promotion_pipeline_tests::qualify;
use super::*;
use crate::services::benchmarks::{
    learned::certify::{EvaluationRequest, RankedMatcher},
    promotion::Discovery,
};

fn request() -> EvaluationRequest {
    EvaluationRequest {
        work_class_id: "debug".into(),
        excluded_providers: vec![],
        // The class's fallback order prefers the painter everywhere.
        persona_order: vec![RankedMatcher {
            platform: None,
            needles: vec![vec!["painter".into()]],
            effort: None,
            fast_mode: None,
        }],
    }
}

#[tokio::test]
async fn a_passing_held_out_evaluation_certifies_the_class_for_ordinary_chats() {
    // Keep the complete async scenario off libtest's small Windows stack.
    Box::pin(certificate_scenario()).await;
}

async fn certificate_scenario() {
    let directory = crate::test_support::TempRoot::new();
    let backend = Arc::new(OfflineWorkers::default());
    let service = open(&directory, backend.clone()).await;
    let training = publish(&service, "train", 8).await;
    measure(&service, &training, "certificate-training").await;
    // Held-out cases are ordinary cases: measured by an ordinary run, in
    // any order, with no reservation or freeze.
    let held = publish(&service, "held_out", 16).await;
    let qualifications = qualify(&service, &held).await;
    // Before any held-out cell exists, a look finds nothing to judge.
    let empty = Box::pin(service.evaluate_class(request())).await.unwrap();
    assert_eq!(empty.status, "insufficient_evidence");
    assert_eq!(empty.look, 1);
    assert!(empty.cases.is_empty() && empty.certificate_id.is_none());
    measure(&service, &held, "certificate-held-out").await;
    let evaluation = Box::pin(service.evaluate_class(request())).await.unwrap();
    assert_eq!(
        evaluation.status, "certified",
        "{:?}",
        evaluation.assessment
    );
    assert_eq!(evaluation.look, 2);
    assert_eq!(evaluation.cases.len(), 16);
    assert_eq!(evaluation.persona_order, request().persona_order);
    assert_eq!(evaluation.pool_keys.len(), 2);
    assert_eq!(evaluation.model_id, empty.model_id);
    assert_eq!(evaluation.qualification_ids.len(), 16);
    // The same fit on the same cells is the same look, journaled once.
    let again = Box::pin(service.evaluate_class(request())).await.unwrap();
    assert_eq!(again.id, evaluation.id);
    assert_eq!(
        service
            .store
            .class_evaluations("debug")
            .await
            .unwrap()
            .len(),
        2
    );
    let certificate_id = evaluation.certificate_id.clone().unwrap();
    let (class, model_id) = service
        .store
        .class_certificate("debug")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(class.id, certificate_id);
    assert_eq!(class.source.as_deref(), Some("held_out_certification"));
    assert_eq!(class.campaign_id, evaluation.id);
    assert_eq!(model_id, evaluation.model_id);
    let policy = service
        .store
        .class_policies()
        .await
        .unwrap()
        .into_iter()
        .find(|p| p.work_class_id == "debug")
        .unwrap();
    assert_eq!(
        policy.certificate_id.as_deref(),
        Some(certificate_id.as_str())
    );
    let summary = policy.evaluation.unwrap();
    assert_eq!(summary.status, "certified");
    assert_eq!(summary.look, 2);
    assert_eq!(summary.held_out_cases, 16);
    // An ordinary chat of the class now chooses through the learned model.
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
    // Historical recipes remain readable, but cannot authorize a dispatch
    // without the current recipe's evidence validation. Unknown future
    // recipes are not implicitly trusted either.
    for recipe in ["held-out-certification-v1", "held-out-certification-future"] {
        let mut legacy = evaluation.clone();
        legacy.recipe = recipe.into();
        legacy.artifact_hash.clear();
        legacy.artifact_hash =
            crate::services::benchmarks::workflow_campaign::hash(&legacy).unwrap();
        sqlx::query("UPDATE selector_certifications SET data_json=?,artifact_hash=? WHERE id=?")
            .bind(serde_json::to_string(&legacy).unwrap())
            .bind(&legacy.artifact_hash)
            .bind(&legacy.id)
            .execute(&service.store.pool)
            .await
            .unwrap();
        assert_eq!(
            service
                .store
                .class_evaluation(&legacy.id)
                .await
                .unwrap()
                .recipe,
            recipe
        );
        assert!(service
            .store
            .require_active_promotion(&certificate_id)
            .await
            .unwrap_err()
            .message
            .contains("evidence recipe"));
        assert!(service
            .store
            .class_certificate("debug")
            .await
            .unwrap()
            .is_none());
        let fallback = service
            .store
            .prepare_ordinary_executor_decision(ordinary(recipe))
            .await
            .unwrap();
        assert_ne!(fallback.source, "learned");
        assert_eq!(fallback.chosen.as_ref().unwrap().model_id, "painter");
    }
    sqlx::query("UPDATE selector_certifications SET data_json=?,artifact_hash=? WHERE id=?")
        .bind(serde_json::to_string(&evaluation).unwrap())
        .bind(&evaluation.artifact_hash)
        .bind(&evaluation.id)
        .execute(&service.store.pool)
        .await
        .unwrap();
    assert!(service
        .store
        .require_active_promotion(&certificate_id)
        .await
        .is_ok());
    // Owned native deployments never discover or cover a class certificate.
    assert!(!class.covers(&class.contract, 0));
    assert!(matches!(
        service
            .store
            .discover_active_policy(&class.contract, &[], &class.prior_keys)
            .await
            .unwrap(),
        Discovery::Refused(_)
    ));
    // Only the newest look speaks for the class: a later look that did not
    // certify returns it to its fallback order, and the status shows that look.
    let mut failed = evaluation.clone();
    failed.id = "invented-later-look".into();
    failed.look = 3;
    failed.created_at += 1;
    failed.snapshot_hash = "invented-later-snapshot".into();
    failed.status = "not_certified".into();
    failed.certificate_id = None;
    if let Some(assessment) = failed.assessment.as_mut() {
        assessment.passed = false;
    }
    failed.artifact_hash.clear();
    failed.artifact_hash = crate::services::benchmarks::workflow_campaign::hash(&failed).unwrap();
    sqlx::query("INSERT INTO selector_certifications(id,work_class_id,model_id,snapshot_hash,created_at,data_json,artifact_hash) VALUES(?,?,?,?,?,?,?)")
        .bind(&failed.id).bind(&failed.work_class_id).bind(&failed.model_id)
        .bind(&failed.snapshot_hash).bind(failed.created_at)
        .bind(serde_json::to_string(&failed).unwrap()).bind(&failed.artifact_hash)
        .execute(&service.store.pool).await.unwrap();
    assert!(service
        .store
        .class_certificate("debug")
        .await
        .unwrap()
        .is_none());
    assert!(service
        .store
        .require_active_promotion(&certificate_id)
        .await
        .unwrap_err()
        .message
        .contains("newer held-out look"));
    let policy = service
        .store
        .class_policies()
        .await
        .unwrap()
        .into_iter()
        .find(|p| p.work_class_id == "debug")
        .unwrap();
    assert!(policy.certificate_id.is_none());
    let summary = policy.evaluation.unwrap();
    assert_eq!(
        (summary.status.as_str(), summary.look),
        ("not_certified", 3)
    );
    // The same fit on the same cells after that look is a new look, not the
    // old certified one, and it certifies the class again.
    let back = Box::pin(service.evaluate_class(request())).await.unwrap();
    assert_eq!((back.status.as_str(), back.look), ("certified", 4));
    assert_ne!(back.id, evaluation.id);
    assert_eq!(back.snapshot_hash, evaluation.snapshot_hash);
    let certificate_id = back.certificate_id.clone().unwrap();
    assert_eq!(
        service
            .store
            .class_certificate("debug")
            .await
            .unwrap()
            .unwrap()
            .0
            .id,
        certificate_id
    );
    // A revoked qualification of a counted case deactivates the certificate.
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
            .require_active_promotion(&certificate_id)
            .await
            .unwrap_err()
            .code,
        "invalid_promotion"
    );
    // The next look leaves that case out and is journaled as a new look.
    let after = Box::pin(service.evaluate_class(request())).await.unwrap();
    assert_eq!(after.look, 5);
    assert_eq!(after.unqualified_cases, 1);
    assert_eq!(after.cases.len(), 15);
    // Revocation returns the class to its declared order at once.
    if let Some(id) = after.certificate_id.as_deref() {
        service
            .store
            .revoke_promotion(id, "Invented revocation")
            .await
            .unwrap();
    }
    assert!(service
        .store
        .class_certificate("debug")
        .await
        .unwrap()
        .is_none());
    directory.close().await;
}
