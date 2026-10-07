use super::super::{analysis::tests::dataset, store::Store};
use super::*;

pub(super) fn data() -> QueryData {
    let mut data = dataset();
    let version = data.versions[0].clone();
    let attempt = data.attempts[0].clone();
    let configurations = ["parser", "painter"].map(|id| {
        let mut c = attempt.configuration.clone();
        c.id = id.into();
        c.model_id = id.into();
        c
    });
    data.versions.clear();
    data.attempts.clear();
    data.runs.truncate(1);
    data.required_repetitions = 3;
    data.runs[0].request.repetitions = 3;
    data.runs[0].request.timeout_seconds = 3_600;
    data.runs[0].request.configurations = configurations.to_vec();
    for index in 0..16 {
        let mut v = version.clone();
        v.id = format!("v{index:02}");
        v.definition_id = format!("d{index:02}");
        v.content_hash = format!("hash-{index}");
        v.manifest.work_class_id = "debug".into();
        v.manifest.task_family = format!("family-{index}");
        v.manifest.environment = serde_json::json!({"splitGroup":format!("group-{}", index/4)});
        v.manifest.prompt = if index % 2 == 0 {
            "Repair parser tokenizer grammar syntax"
        } else {
            "Repair painter canvas colors pixels"
        }
        .into();
        v.manifest.repetitions = 3;
        for c in &configurations {
            for repetition in 0..3 {
                let mut a = attempt.clone();
                a.id = format!("{}-{}-{repetition}", v.id, c.model_id);
                a.version_id = v.id.clone();
                a.configuration = c.clone();
                a.observed = Some(c.clone());
                a.repetition = repetition;
                a.outcome = Some(
                    if (index % 2 == 0) == (c.model_id == "parser") && repetition != 2 {
                        "pass"
                    } else {
                        "fail"
                    }
                    .into(),
                );
                a.usage.cost = Some(0.01);
                data.attempts.push(a);
            }
        }
        data.versions.push(v);
    }
    data.runs[0].request.version_ids = data.versions.iter().map(|v| v.id.clone()).collect();
    data
}

fn request(data: &QueryData) -> FitRequest {
    FitRequest {
        work_class_id: "debug".into(),
        version_ids: data.versions.iter().map(|v| v.id.clone()).collect(),
        configurations: data.runs[0].request.configurations.clone(),
        cutoff_at: 10,
        weights: RoleWeights::default(),
    }
}

fn prediction(data: &QueryData, index: usize) -> PredictionRequest {
    PredictionRequest {
        task: PublicTask::from(&data.versions[index].manifest),
        target_family: "unseen-family".into(),
        target_group: "unseen-group".into(),
        candidates: request(data)
            .configurations
            .into_iter()
            .map(|configuration| RoutingCandidate {
                configuration,
                available: true,
                reason: None,
            })
            .collect(),
        hard_candidate_key: None,
        min_quality: 0.5,
    }
}

#[test]
fn learns_task_conditioned_choices_with_soft_repeated_targets() {
    let data = data();
    let artifact = fit(&data, request(&data)).unwrap();
    assert_eq!(artifact.model.common_cases, 16);
    for example in &artifact.snapshot.examples {
        assert!(example.targets.iter().any(|t| t.reward == Some(2.0 / 3.0)));
        assert!(example.targets.iter().any(|t| t.reward == Some(0.0)));
    }
    // Every worker's class-wide mean is identical. The public prompt changes
    // the recommendation, proving this is not the aggregate selector in disguise.
    for (index, expected) in [(0, "parser"), (1, "painter")] {
        let result = predict(&artifact.model, &prediction(&data, index)).unwrap();
        assert_eq!(result.chosen.unwrap().model_id, expected);
        assert!(!result.dispatch_allowed);
        assert_eq!(result.reason, "research_prediction");
    }
}

#[test]
fn reordering_refitting_and_serialization_reproduce_identical_models() {
    let mut data = data();
    let mut query = request(&data);
    let original = fit(&data, query.clone()).unwrap();
    data.attempts.reverse();
    data.versions.reverse();
    data.runs.reverse();
    query.version_ids.reverse();
    query.configurations.reverse();
    let reordered = fit(&data, query).unwrap();
    assert_eq!(original.model.id, reordered.model.id);
    let snapshot: TrainingSnapshot =
        serde_json::from_slice(&serde_json::to_vec(&original.snapshot).unwrap()).unwrap();
    let mut replay = fit::refit(&snapshot, original.model.common_cases).unwrap();
    replay.id = model_hash(&replay).unwrap();
    assert_eq!(original.model.id, replay.id);
    let model: LearnedModel =
        serde_json::from_slice(&serde_json::to_vec(&replay).unwrap()).unwrap();
    validate_model(&model).unwrap();
}

#[test]
fn protected_content_and_lineage_never_enter_features_or_inference() {
    let data = data();
    let mut draft = data.versions[0].manifest.clone();
    let original = PublicTask::from(&draft);
    draft.evaluator.expected = "SECRET-ANSWER".into();
    draft.evaluator.known_good = "SECRET-SOLUTION".into();
    draft.evaluator.rubric = "SECRET-GRADER".into();
    draft.source = "SECRET-SOURCE".into();
    draft.task_family = "SECRET-FAMILY".into();
    draft.environment = serde_json::json!({"hidden":"SECRET-CHECK"});
    assert_eq!(original, PublicTask::from(&draft));
    assert_eq!(
        features::extract(&original).unwrap(),
        features::extract(&PublicTask::from(&draft)).unwrap()
    );
    let mut wire = serde_json::to_value(original).unwrap();
    wire["evaluator"] = serde_json::json!({});
    assert!(serde_json::from_value::<PublicTask>(wire).is_err());
    let model = fit(&data, request(&data)).unwrap().model;
    let wire = serde_json::to_string(&model).unwrap();
    assert!(!wire.contains("Repair parser"));
    assert!(!wire.contains("private output"));
    assert!(!wire.contains("private-account"));
}

#[test]
fn incomplete_owed_cells_and_runtime_mismatches_refuse_fitting() {
    let mut data = data();
    let query = request(&data);
    data.attempts.pop();
    assert_eq!(
        fit(&data, query).unwrap_err().code,
        "insufficient_training_evidence"
    );
    let data = self::data();
    let mut query = request(&data);
    query.configurations[0].inventory_revision = Some("other-runtime".into());
    assert!(fit(&data, query)
        .unwrap_err()
        .message
        .contains("different runtime"));
    let mut query = request(&data);
    query.configurations[0].inventory_revision = None;
    assert_eq!(fit(&data, query).unwrap_err().code, "validation");
}

#[test]
fn masks_never_supply_common_coverage_or_false_zero_targets() {
    let mut data = data();
    let mut extra = data.runs[0].request.configurations[0].clone();
    extra.id = "third".into();
    extra.model_id = "third".into();
    data.runs[0].request.configurations.push(extra.clone());
    let existing = data.attempts.clone();
    for a in existing
        .into_iter()
        .filter(|a| a.configuration.model_id == "parser")
    {
        let mut a = a;
        a.id.push_str("-third");
        a.configuration = extra.clone();
        a.observed = Some(extra.clone());
        data.attempts.push(a);
    }
    data.versions[0].manifest.environment["authoredBy"] = serde_json::json!(["third"]);
    let artifact = fit(&data, request(&data)).unwrap();
    assert_eq!(artifact.model.common_cases, 15);
    let excluded = artifact.snapshot.examples[0]
        .targets
        .iter()
        .find(|t| t.status == "authored_by_candidate")
        .unwrap();
    assert_eq!(excluded.reward, None);
    assert_eq!(excluded.utility, None);
    for v in &mut data.versions {
        v.manifest.environment["authoredBy"] = serde_json::json!(["third"]);
    }
    assert_eq!(
        fit(&data, request(&data)).unwrap_err().code,
        "insufficient_training_evidence"
    );
}

#[test]
fn train_split_cutoff_and_related_groups_are_enforced() {
    let mut data = data();
    let query = request(&data);
    data.versions[0].manifest.split = "held_out".into();
    assert!(fit(&data, query).is_err());
    let mut data = self::data();
    let mut query = request(&data);
    query.cutoff_at = 1;
    assert!(fit(&data, query).is_err());
    for v in &mut data.versions {
        v.manifest.environment["splitGroup"] = serde_json::json!("same-group");
    }
    assert!(fit(&data, request(&data))
        .unwrap_err()
        .message
        .contains("1 groups"));
}

#[test]
fn later_and_held_out_results_do_not_change_a_frozen_fit() {
    let mut data = data();
    let query = request(&data);
    let before = fit(&data, query.clone()).unwrap();
    let mut later = data.runs[0].clone();
    later.id = "later".into();
    later.created_at = 11;
    later.request.configurations[0].inventory_revision = Some("later-runtime".into());
    let mut attempt = data.attempts[0].clone();
    attempt.id = "later".into();
    attempt.run_id = later.id.clone();
    attempt.configuration = later.request.configurations[0].clone();
    attempt.observed = Some(attempt.configuration.clone());
    attempt.finished_at = Some(12);
    data.runs.push(later);
    data.attempts.push(attempt);
    let mut held = data.versions[0].clone();
    held.id = "held".into();
    held.definition_id = "held".into();
    held.manifest.task_family = "held-family".into();
    held.manifest.environment = serde_json::json!({});
    held.manifest.split = "held_out".into();
    data.versions.push(held);
    assert_eq!(before.model.id, fit(&data, query).unwrap().model.id);
}

#[test]
fn inference_abstains_on_seen_groups_changed_scope_runtime_and_availability() {
    let data = data();
    let model = fit(&data, request(&data)).unwrap().model;
    for (change, reason) in [
        (0, "training_family_or_group"),
        (1, "training_family_or_group"),
        (2, "untrained_role_or_execution_context"),
        (3, "changed_candidate_runtime"),
        (4, "no_available_candidates"),
        (5, "untrained_available_candidate"),
        (6, "below_quality_floor"),
    ] {
        let mut query = prediction(&data, 0);
        match change {
            0 => query.target_family = model.training_families[0].clone(),
            1 => query.target_group = model.training_groups[0].clone(),
            2 => query.task.role_prompt = "new role".into(),
            3 => query.candidates[0].configuration.inventory_revision = Some("other".into()),
            4 => {
                for candidate in &mut query.candidates {
                    candidate.available = false;
                }
            }
            5 => query.candidates[0].configuration.model_id = "untrained".into(),
            _ => query.min_quality = 1.0,
        }
        let result = predict(&model, &query).unwrap();
        assert_eq!(result.reason, reason);
        assert!(result.chosen.is_none());
        assert!(!result.dispatch_allowed);
    }
}

#[test]
fn explicit_pin_is_binding_and_recommendations_use_current_account() {
    let data = data();
    let model = fit(&data, request(&data)).unwrap().model;
    let mut query = prediction(&data, 0);
    query.min_quality = 0.0;
    query.hard_candidate_key = Some(routing::candidate_key(&query.candidates[1].configuration));
    query.candidates[1].configuration.account_id = Some("current-account".into());
    assert_eq!(
        predict(&model, &query)
            .unwrap()
            .chosen
            .unwrap()
            .account_id
            .as_deref(),
        Some("current-account")
    );
    query.candidates[1].available = false;
    let result = predict(&model, &query).unwrap();
    assert_eq!(result.reason, "explicit_pin_unavailable");
    assert!(result.chosen.is_none());
}

#[test]
fn missing_cost_is_not_free_and_failures_get_no_speed_credit() {
    let mut data = data();
    for a in &mut data.attempts {
        a.usage.cost = None;
        if a.outcome.as_deref() == Some("fail") {
            a.duration_ms = Some(1);
        }
    }
    let artifact = fit(&data, request(&data)).unwrap();
    for target in artifact.snapshot.examples.iter().flat_map(|e| &e.targets) {
        assert_eq!(target.mean_cost, None);
        assert_eq!(target.utility, target.reward);
    }
}

#[tokio::test]
async fn immutable_fits_survive_reopen_and_inference_loads_no_labels() {
    let directory = tempfile::tempdir().unwrap();
    let data = data();
    let artifact = fit(&data, request(&data)).unwrap();
    let id = artifact.model.id.clone();
    let store = Store::open(directory.path()).await.unwrap();
    store.save_selector_fit(&artifact).await.unwrap();
    let mut retry = artifact.clone();
    retry.created_at += 100;
    assert_eq!(
        store.save_selector_fit(&retry).await.unwrap().created_at,
        artifact.created_at
    );
    assert_eq!(store.selector_fits().await.unwrap().len(), 1);
    store.pool.close().await;
    let store = Store::open(directory.path()).await.unwrap();
    assert_eq!(store.selector_fit(&id).await.unwrap().model.id, id);
    // Labels can be unavailable while the separately loaded inference still works.
    sqlx::query("UPDATE selector_fits SET snapshot_json='{}' WHERE id=?")
        .bind(&id)
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(store.selector_fit(&id).await.is_err());
    let model = store.selector_model(&id).await.unwrap();
    assert_eq!(
        predict(&model, &prediction(&data, 0))
            .unwrap()
            .chosen
            .unwrap()
            .model_id,
        "parser"
    );
    let mut damaged = model;
    damaged.candidates[0].quality_coefficients[0] += 0.1;
    assert_eq!(
        predict(&damaged, &prediction(&data, 0)).unwrap_err().code,
        "invalid_model"
    );
}
