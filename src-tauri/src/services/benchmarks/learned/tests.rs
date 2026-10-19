use super::super::{analysis::tests::dataset, store::Store};
use super::*;

pub(in crate::services::benchmarks) fn data() -> QueryData {
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
        runtime_match: None,
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
    assert_eq!(artifact.model.recipe, RECIPE);
    for example in &artifact.snapshot.examples {
        assert!(example.targets.iter().any(|t| t.reward == Some(2.0 / 3.0)));
        assert!(example.targets.iter().any(|t| t.reward == Some(0.0)));
    }
    // Every worker's class-wide mean is identical. The public prompt changes
    // the recommendation, proving this is not the aggregate selector in disguise.
    for (index, expected) in [(0, "parser"), (1, "painter")] {
        let result = predict(&artifact.model, &prediction(&data, index)).unwrap();
        let probabilities: Vec<_> = result
            .scores
            .iter()
            .map(|score| score.selection_probability.unwrap())
            .collect();
        assert!((probabilities.iter().sum::<f64>() - 1.0).abs() < 1e-12);
        assert!(probabilities
            .iter()
            .all(|p| p.is_finite() && *p > 0.0 && *p < 1.0));
        assert_eq!(result.chosen.unwrap().model_id, expected);
        assert!(!result.dispatch_allowed);
        assert_eq!(result.reason, "research_prediction");
    }
}

#[test]
fn repository_collection_recipe_matches_prepared_workflow_scope() {
    use super::super::{artifact_context, fixtures, repository, workflow_campaign};

    let mut data = data();
    for version in &mut data.versions {
        let draft = &mut version.manifest;
        draft.execution_profile = "protected_repository".into();
        draft.evaluator.kind = "repository".into();
        draft.permissions.tools = vec!["filesystem".into(), "terminal".into()];
        draft.permissions.network = true;
        draft.environment["nativeBudgetRecipe"] = artifact_context::CLOCK_RECIPE.into();
        draft.environment["nativeRepositoryRecipe"] = repository::ARTIFACT_RECIPE.into();
        draft.entry_state = Some(EntryState {
            schema_version: 1,
            root_task_id: "invented-root".into(),
            step_id: "implement".into(),
            parent_step_id: None,
            fixture_snapshot_hash: String::new(),
            conversation_prefix: String::new(),
            previous_reports: vec![],
            remaining_budget_seconds: draft.limits.timeout_seconds,
            content_hash: String::new(),
        });
        routing::normalize_draft(draft);
        assert!(routing::validate_draft(draft).is_empty());
    }
    for configuration in &mut data.runs[0].request.configurations {
        configuration.execution_profile = "protected_repository".into();
    }
    for attempt in &mut data.attempts {
        attempt.configuration.execution_profile = "protected_repository".into();
        attempt.observed.as_mut().unwrap().execution_profile = "protected_repository".into();
    }
    let artifact = fit(&data, request(&data)).unwrap();
    let original = &data.versions[0].manifest;
    let public = PublicTask::from(original);
    assert_eq!(
        public.repository_recipe.as_deref(),
        Some(repository::ARTIFACT_RECIPE)
    );
    assert!(public.repository_artifact.is_none());

    let mut workflow = original.clone();
    workflow.entry_state = None;
    workflow.workflow = Some(WorkflowSpec {
        schema_version: 1,
        driver_revision: "invented-repository-workflow-v1".into(),
        steps: vec![
            WorkflowStep {
                id: "implement".into(),
                prompt: "Implement the repair".into(),
                include_previous_output: false,
                scope: None,
            },
            WorkflowStep {
                id: "verify".into(),
                prompt: "Verify and repair the result".into(),
                include_previous_output: true,
                scope: None,
            },
        ],
    });
    let frozen =
        workflow_campaign::step_task(&workflow, 0, original.limits.timeout_seconds).unwrap();
    assert_eq!(
        features::scope_hash(&public).unwrap(),
        features::scope_hash(&frozen).unwrap()
    );
    // This fixture tests public projection only. Native artifact ownership and
    // persistence are covered by the collection-context integration tests.
    workflow.environment[artifact_context::INPUT_KEY] = serde_json::json!({
        "before": { "recipe": repository::ARTIFACT_RECIPE, "rootTree": "a".repeat(40),
            "beforeTree": "a".repeat(40), "afterTree": "a".repeat(40), "patch": "",
            "patchHash": fixtures::hash(b""), "archiveHash": "b".repeat(64) },
        "lineage": [], "accessAll": false
    });
    let prepared =
        workflow_campaign::step_task(&workflow, 0, original.limits.timeout_seconds).unwrap();
    assert!(prepared.repository_artifact.is_some());
    assert_eq!(
        features::scope_hash(&frozen).unwrap(),
        features::scope_hash(&prepared).unwrap()
    );
    assert_eq!(
        super::super::promotion::Contract::from_task(&public),
        super::super::promotion::Contract::from_task(&prepared)
    );
    let mut query = prediction(&data, 0);
    query.task = prepared;
    query.min_quality = 0.0;
    let result = predict(&artifact.model, &query).unwrap();
    assert_eq!(result.reason, "research_prediction");
    assert!(result.chosen.is_some());

    let mut legacy = original.clone();
    legacy
        .environment
        .as_object_mut()
        .unwrap()
        .remove("nativeRepositoryRecipe");
    assert!(PublicTask::from(&legacy).repository_recipe.is_none());
    assert_ne!(
        features::scope_hash(&PublicTask::from(&legacy)).unwrap(),
        features::scope_hash(&public).unwrap()
    );
    for change in 0..6 {
        let mut invalid = original.clone();
        match change {
            0 => invalid.environment["nativeRepositoryRecipe"] = "unknown".into(),
            1 => invalid.execution_profile = "native_text".into(),
            2 => {
                invalid
                    .environment
                    .as_object_mut()
                    .unwrap()
                    .remove("nativeBudgetRecipe");
            }
            3 => invalid.entry_state = None,
            4 => invalid.evaluator.kind = "exact".into(),
            _ => {
                invalid.environment[artifact_context::INPUT_KEY] =
                    serde_json::json!({"before":{"recipe":"different"}})
            }
        }
        assert!(
            !routing::validate_draft(&invalid).is_empty(),
            "change {change}"
        );
    }
}

#[test]
fn joint_targets_use_temperature_and_the_configured_resource_objective() {
    let data = data();
    let artifact = fit(&data, request(&data)).unwrap();
    let configurations = &artifact.snapshot.request.configurations;
    let mut targets = artifact.snapshot.examples[0].targets.clone();
    for target in &mut targets {
        target.reward = Some(1.0);
        target.mean_duration_ms = Some(10.0);
        target.mean_cost = Some(if target.candidate_key == configurations[0].id {
            1.0
        } else {
            2.0
        });
    }
    fit::utilities(
        &mut targets,
        RoleWeights {
            quality: 0.5,
            speed: 0.0,
            cost: 0.5,
        },
    );
    let distribution = fit::selection_distribution(&targets, configurations).unwrap();
    let expected = 1.0 / (1.0 + (-0.25 / SELECTION_TEMPERATURE).exp());
    assert!((distribution[0].1 - expected).abs() < 1e-12);
    assert!((distribution[0].1 + distribution[1].1 - 1.0).abs() < 1e-12);
    assert!(distribution[0].1 > distribution[1].1);
    fit::utilities(
        &mut targets,
        RoleWeights {
            quality: 1.0,
            speed: 0.0,
            cost: 0.0,
        },
    );
    assert_eq!(
        fit::selection_distribution(&targets, configurations).unwrap(),
        vec![(0, 0.5), (1, 0.5)]
    );
    assert_eq!(softmax(&[1000.0, 1000.0]).unwrap(), vec![0.5, 0.5]);
    assert!(softmax(&[f64::INFINITY]).is_err());
}

#[test]
fn joint_training_recovers_the_analytic_constant_soft_target_distribution() {
    let data = data();
    let mut snapshot = fit(&data, request(&data)).unwrap().snapshot;
    let first = snapshot.request.configurations[0].id.clone();
    for example in &mut snapshot.examples {
        for target in &mut example.targets {
            target.utility = Some(if target.candidate_key == first {
                0.25
            } else {
                0.5
            });
        }
    }
    let mut bias = vec![0.0; DIMENSIONS];
    bias[0] = 1.0;
    let vectors = vec![bias; snapshot.examples.len()];
    let heads = fit::train_selection(&snapshot, &vectors).unwrap();
    let actual = softmax(&heads.iter().map(|head| head[0]).collect::<Vec<_>>()).unwrap();
    let expected = [1.0 / (1.0 + 1.0_f64.exp()), 1.0 / (1.0 + (-1.0_f64).exp())];
    let divergence: f64 = expected
        .iter()
        .zip(&actual)
        .map(|(target, policy)| target * (target / policy).ln())
        .sum();
    assert!(
        divergence.abs() < 1e-12,
        "KL={divergence}, probabilities={actual:?}"
    );
    for (target, policy) in expected.iter().zip(actual) {
        assert!((target - policy).abs() < 1e-8);
    }
}

#[test]
fn joint_training_masks_unobserved_candidates_and_weights_related_groups_equally() {
    let data = data();
    let artifact = fit(&data, request(&data)).unwrap();
    let mut snapshot = artifact.snapshot;
    let mut masked = snapshot.request.configurations[0].clone();
    masked.model_id = "unmeasured-worker".into();
    masked.id = routing::candidate_key(&masked);
    snapshot.request.configurations.push(masked.clone());
    for (index, example) in snapshot.examples.iter_mut().enumerate() {
        let mut target = example.targets[0].clone();
        target.candidate_key = masked.id.clone();
        target.status = if index % 2 == 0 {
            "not_planned"
        } else {
            "authored_by_candidate"
        }
        .into();
        target.reward = None;
        target.utility = None;
        example.targets.push(target);
    }
    let vectors = |snapshot: &TrainingSnapshot| {
        snapshot
            .examples
            .iter()
            .map(|example| features::extract(&example.task).unwrap())
            .collect::<Vec<_>>()
    };
    let heads = fit::train_selection(&snapshot, &vectors(&snapshot)).unwrap();
    assert!(heads[2].iter().all(|coefficient| *coefficient == 0.0));
    for (head, original) in heads.iter().zip(&artifact.model.candidates) {
        assert_eq!(head, original.selection_coefficients.as_ref().unwrap());
    }
    // Even a stale numeric value attached to a mask cannot become a label or
    // enter the training softmax denominator.
    for example in &mut snapshot.examples {
        example.targets[2].utility = Some(1.0);
        example.targets[2].reward = Some(1.0);
        assert_eq!(
            fit::selection_distribution(&example.targets, &snapshot.request.configurations)
                .unwrap()
                .len(),
            2
        );
    }
    assert_eq!(
        heads,
        fit::train_selection(&snapshot, &vectors(&snapshot)).unwrap()
    );
    let first_group = snapshot.examples[0].split_group.clone();
    let duplicates: Vec<_> = snapshot
        .examples
        .iter()
        .filter(|example| example.split_group == first_group)
        .cloned()
        .collect();
    snapshot.examples.extend(duplicates.clone());
    snapshot.examples.extend(duplicates);
    let duplicated = fit::train_selection(&snapshot, &vectors(&snapshot)).unwrap();
    for (left, right) in heads.iter().flatten().zip(duplicated.iter().flatten()) {
        assert!((left - right).abs() < 1e-12);
    }
}

#[test]
fn joint_selection_ranks_policy_logits_but_keeps_the_quality_floor() {
    let data = data();
    let mut model = fit(&data, request(&data)).unwrap().model;
    for candidate in &mut model.candidates {
        let parser = candidate.configuration.model_id == "parser";
        candidate.quality_coefficients = vec![0.0; DIMENSIONS];
        candidate.quality_coefficients[0] = 1.0;
        candidate.utility_coefficients = vec![0.0; DIMENSIONS];
        candidate.utility_coefficients[0] = if parser { 1.0 } else { 0.0 };
        candidate.selection_coefficients = Some(vec![0.0; DIMENSIONS]);
        candidate.selection_coefficients.as_mut().unwrap()[0] = if parser { -1.0 } else { 1.0 };
    }
    model.id = model_hash(&model).unwrap();
    let query = prediction(&data, 0);
    let joint = predict(&model, &query).unwrap();
    assert_eq!(joint.chosen.unwrap().model_id, "painter");
    assert!(joint.scores[0].selection_probability.unwrap() > 0.8);
    assert_eq!(
        predict_for_class(&model, &query)
            .unwrap()
            .chosen
            .unwrap()
            .model_id,
        "painter"
    );
    let painter = model
        .candidates
        .iter_mut()
        .find(|candidate| candidate.configuration.model_id == "painter")
        .unwrap();
    painter.quality_coefficients[0] = 0.2;
    model.id = model_hash(&model).unwrap();
    assert_eq!(
        predict(&model, &query).unwrap().chosen.unwrap().model_id,
        "parser"
    );
    assert_eq!(
        predict_for_class(&model, &query)
            .unwrap()
            .chosen
            .unwrap()
            .model_id,
        "parser"
    );
}

#[test]
fn provider_model_and_reasoning_settings_are_distinct_joint_choices() {
    let mut data = data();
    let template = data.attempts[0].clone();
    let configurations: Vec<_> = (0..4)
        .map(|index| {
            let mut configuration = template.configuration.clone();
            configuration.provider_id = if index == 2 {
                "provider-b"
            } else {
                "provider-a"
            }
            .into();
            configuration.model_id = if index == 3 { "worker-b" } else { "worker-a" }.into();
            configuration.effort = Some(if index == 1 { "high" } else { "low" }.into());
            configuration.id = routing::candidate_key(&configuration);
            configuration
        })
        .collect();
    assert_eq!(
        configurations
            .iter()
            .map(|configuration| &configuration.id)
            .collect::<BTreeSet<_>>()
            .len(),
        4
    );
    data.runs[0].request.configurations = configurations.clone();
    data.attempts.clear();
    for (index, version) in data.versions.iter_mut().enumerate() {
        version.manifest.prompt = [
            "tokenizer grammar syntax",
            "canvas colors pixels",
            "network sockets packets",
            "storage tables indexes",
        ][index % 4]
            .into();
        for (candidate_index, configuration) in configurations.iter().enumerate() {
            for repetition in 0..3 {
                let mut attempt = template.clone();
                attempt.id = format!("{}-{candidate_index}-{repetition}", version.id);
                attempt.version_id = version.id.clone();
                attempt.configuration = configuration.clone();
                attempt.observed = Some(configuration.clone());
                attempt.repetition = repetition;
                attempt.outcome = Some(
                    if candidate_index == index % 4 {
                        "pass"
                    } else {
                        "fail"
                    }
                    .into(),
                );
                data.attempts.push(attempt);
            }
        }
    }
    let artifact = fit(&data, request(&data)).unwrap();
    for (index, expected) in configurations.iter().enumerate() {
        let mut query = prediction(&data, index);
        query.min_quality = 0.0;
        assert_eq!(
            predict(&artifact.model, &query).unwrap().chosen_key,
            Some(routing::candidate_key(expected))
        );
    }
}

#[tokio::test]
async fn legacy_ridge_bytes_hashes_predictions_and_persistence_remain_unchanged() {
    // These are the original wire fields, independently of the new optional
    // head. Their serialized order is part of the old content-addressed ID.
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyCandidate<'a> {
        candidate_key: &'a str,
        configuration: &'a Configuration,
        cases: usize,
        quality_coefficients: &'a [f64],
        utility_coefficients: &'a [f64],
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyModel<'a> {
        id: &'a str,
        recipe: &'a str,
        feature_version: &'a str,
        candidate_key_algorithm: &'a str,
        work_class_id: &'a str,
        cutoff_at: i64,
        weights: &'a RoleWeights,
        snapshot_hash: &'a str,
        training_cases: usize,
        common_cases: usize,
        training_families: &'a [String],
        training_groups: &'a [String],
        scope_hashes: &'a [String],
        candidates: Vec<LegacyCandidate<'a>>,
    }
    let data = data();
    let current = fit(&data, request(&data)).unwrap();
    let mut legacy = current.clone();
    legacy.model.recipe = LEGACY_RECIPE.into();
    legacy.model.recipe_parameters = None;
    legacy.model.id.clear();
    for candidate in &mut legacy.model.candidates {
        candidate.selection_coefficients = None;
        candidate.quality_coefficients = vec![0.0; DIMENSIONS];
        candidate.quality_coefficients[0] = 1.0;
        candidate.utility_coefficients = vec![0.0; DIMENSIONS];
        candidate.utility_coefficients[0] = if candidate.configuration.model_id == "painter" {
            1.0
        } else {
            0.0
        };
    }
    let model = &legacy.model;
    let original_wire = LegacyModel {
        id: "",
        recipe: LEGACY_RECIPE,
        feature_version: &model.feature_version,
        candidate_key_algorithm: &model.candidate_key_algorithm,
        work_class_id: &model.work_class_id,
        cutoff_at: model.cutoff_at,
        weights: &model.weights,
        snapshot_hash: &model.snapshot_hash,
        training_cases: model.training_cases,
        common_cases: model.common_cases,
        training_families: &model.training_families,
        training_groups: &model.training_groups,
        scope_hashes: &model.scope_hashes,
        candidates: model
            .candidates
            .iter()
            .map(|candidate| LegacyCandidate {
                candidate_key: &candidate.candidate_key,
                configuration: &candidate.configuration,
                cases: candidate.cases,
                quality_coefficients: &candidate.quality_coefficients,
                utility_coefficients: &candidate.utility_coefficients,
            })
            .collect(),
    };
    assert_eq!(
        serde_json::to_vec(&original_wire).unwrap(),
        serde_json::to_vec(model).unwrap()
    );
    let original_id = hash(&original_wire).unwrap();
    assert_eq!(original_id, model_hash(model).unwrap());
    legacy.model.id = original_id.clone();
    assert_ne!(original_id, current.model.id);
    let bytes = serde_json::to_vec(&legacy.model).unwrap();
    let decoded: LearnedModel = serde_json::from_slice(&bytes).unwrap();
    validate_model(&decoded).unwrap();
    assert_eq!(bytes, serde_json::to_vec(&decoded).unwrap());
    let selected = predict(&decoded, &prediction(&data, 0)).unwrap();
    assert_eq!(selected.chosen.unwrap().model_id, "painter");
    assert!(selected
        .scores
        .iter()
        .all(|score| score.selection_probability.is_none()));
    assert!(!selected.dispatch_allowed);
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    store.save_selector_fit(&legacy).await.unwrap();
    store.save_selector_fit(&current).await.unwrap();
    assert_eq!(store.selector_fits().await.unwrap().len(), 2);
    assert_eq!(
        store.selector_model(&original_id).await.unwrap().recipe,
        LEGACY_RECIPE
    );
    assert_eq!(
        store
            .selector_model(&current.model.id)
            .await
            .unwrap()
            .recipe,
        RECIPE
    );
    let mut malformed = decoded;
    malformed.candidates[0].selection_coefficients = Some(vec![0.0; DIMENSIONS]);
    malformed.id = model_hash(&malformed).unwrap();
    assert!(validate_model(&malformed).is_err());
    directory.close().await;
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
    data.versions[0].manifest.environment["authoredBy"] = serde_json::json!([extra]);
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
        v.manifest.environment["authoredBy"] = serde_json::json!([extra]);
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
        .contains("at least two independent groups"));
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
    let directory = crate::test_support::TempRoot::new();
    let data = data();
    let artifact = fit(&data, request(&data)).unwrap();
    let id = artifact.model.id.clone();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
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
    directory.register(&store.pool);
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
    directory.close().await;
}
