use super::super::tests::data;
use super::*;

/// The training fixture, a train-only vendor that solves every training case,
/// and `held` held-out cases in their own groups, copied from training cases
/// of the same prompt kind with the same measurements.
fn measured(held: usize) -> QueryData {
    let mut data = data();
    let mut vendor = data.runs[0].request.configurations[0].clone();
    vendor.id = "vendor".into();
    vendor.provider_id = "zai-acp".into();
    vendor.model_id = "vendor-model".into();
    let solved: Vec<_> = data
        .attempts
        .iter()
        .filter(|a| a.configuration.model_id == "parser")
        .cloned()
        .map(|mut a| {
            a.id = format!("{}-vendor", a.id);
            a.configuration = vendor.clone();
            a.observed = Some(vendor.clone());
            a.outcome = Some("pass".into());
            a
        })
        .collect();
    data.attempts.extend(solved);
    data.runs[0].request.configurations.push(vendor);
    let train = data.versions.clone();
    let attempts = data.attempts.clone();
    for (index, source) in train.iter().take(held).enumerate() {
        let mut version = source.clone();
        version.id = format!("held-{index:02}");
        version.definition_id = version.id.clone();
        version.content_hash = format!("held-hash-{index}");
        version.manifest.split = "held_out".into();
        version.manifest.task_family = format!("held-family-{index}");
        version.manifest.environment =
            serde_json::json!({"splitGroup": format!("held-group-{index}")});
        for attempt in attempts
            .iter()
            .filter(|a| a.version_id == source.id && a.configuration.model_id != "vendor-model")
        {
            let mut attempt = attempt.clone();
            attempt.id = format!("{}-{}", version.id, attempt.id);
            attempt.version_id = version.id.clone();
            data.attempts.push(attempt);
        }
        data.runs[0].request.version_ids.push(version.id.clone());
        data.versions.push(version);
    }
    data
}

/// The default provider data use: Z.ai and Kimi may train on submissions.
fn data_use() -> DataUse {
    DataUse::from_settings(&serde_json::Value::Null)
}

fn matcher(word: &str) -> RankedMatcher {
    RankedMatcher {
        platform: None,
        needles: vec![vec![word.into()]],
        effort: None,
        fast_mode: None,
    }
}

fn request() -> EvaluationRequest {
    EvaluationRequest {
        work_class_id: "debug".into(),
        excluded_providers: vec![],
        // The manual order prefers the painter everywhere.
        persona_order: vec![matcher("painter")],
    }
}

/// Every held-out version counts, with a current non-renderer qualification.
fn countable(data: &QueryData) -> BTreeMap<String, Countable> {
    data.versions
        .iter()
        .filter(|v| v.manifest.split == "held_out")
        .map(|v| {
            (
                v.id.clone(),
                Countable {
                    binding: qualification::Binding {
                        id: format!("qualification-{}", v.id),
                        version_id: v.id.clone(),
                        content_hash: v.content_hash.clone(),
                        manifest_hash: "manifest".into(),
                        evaluator_revision: v.manifest.evaluator.revision.clone(),
                        created_at: 1,
                        record_hash: "record".into(),
                        evaluator_runtime_revision: None,
                        status: "controls_verified_review_attested".into(),
                        revoked_at: None,
                        revocation_reason: None,
                    },
                    worker: None,
                },
            )
        })
        .collect()
}

#[test]
fn candidates_come_from_training_cells_and_skip_train_only_vendors() {
    let data = measured(8);
    let fit_request = training_request(&data, &request(), 10, &data_use()).unwrap();
    let models: BTreeSet<_> = fit_request
        .configurations
        .iter()
        .map(|c| c.model_id.as_str())
        .collect();
    assert_eq!(models, BTreeSet::from(["painter", "parser"]));
    assert_eq!(fit_request.version_ids.len(), 16);
    assert!(fit_request.version_ids.iter().all(|id| data
        .versions
        .iter()
        .any(|v| &v.id == id && v.manifest.split == "train")));
    assert_eq!(fit_request.runtime_match, Some(RuntimeMatch::ModelIdentity));
    assert!(require_held_out_pool(&fit_request.configurations, &data_use()).is_ok());
    // A user exclusion applies on top; with no pair left there is no fit.
    let mut excluded = request();
    excluded.excluded_providers = vec![" claude ".into()];
    assert_eq!(
        training_request(&data, &excluded, 10, &data_use())
            .unwrap_err()
            .code,
        "insufficient_training_evidence"
    );
    // An evaluation needs a known class and the class's manual order.
    let mut unknown = request();
    unknown.work_class_id = "invented-class".into();
    assert!(training_request(&data, &unknown, 10, &data_use()).is_err());
    let mut unordered = request();
    unordered.persona_order.clear();
    assert!(training_request(&data, &unordered, 10, &data_use()).is_err());
}

#[test]
fn a_fit_never_reads_held_out_cases() {
    let data = measured(8);
    let mut fit_request = training_request(&data, &request(), 10, &data_use()).unwrap();
    fit_request.version_ids.pop();
    fit_request.version_ids.push("held-00".into());
    let refused = fit(&data, fit_request).unwrap_err();
    assert!(
        refused.message.contains("never reads held-out")
            || refused.message.contains("not in the training pool"),
        "{refused:?}"
    );
}

#[test]
fn candidates_need_not_share_training_cases() {
    let mut data = measured(0);
    // The vendor here may see held-out tasks, so it joins the pool; the
    // painter never measured four training cases.
    for a in &mut data.attempts {
        if a.configuration.model_id == "vendor-model" {
            a.configuration.provider_id = "invented-acp".into();
            a.observed = Some(a.configuration.clone());
        }
    }
    for c in &mut data.runs[0].request.configurations {
        if c.model_id == "vendor-model" {
            c.provider_id = "invented-acp".into();
        }
    }
    data.attempts.retain(|a| {
        !(a.configuration.model_id == "painter"
            && ["v00", "v01", "v02", "v03"].contains(&a.version_id.as_str()))
    });
    let fit_request = training_request(&data, &request(), 10, &data_use()).unwrap();
    assert_eq!(fit_request.configurations.len(), 3);
    assert_eq!(fit_request.version_ids.len(), 16);
    let artifact = fit(&data, fit_request).unwrap();
    assert_eq!(artifact.model.recipe, RECIPE_PATH_V2);
    assert!(artifact.model.common_cases < artifact.model.training_cases);
    let painter = artifact
        .model
        .candidates
        .iter()
        .find(|c| c.configuration.model_id == "painter")
        .unwrap();
    assert_eq!(painter.cases, 12);
    // The recipe is deterministic: the same cells fit the same model.
    let again = fit(
        &data,
        training_request(&data, &request(), 10, &data_use()).unwrap(),
    )
    .unwrap();
    assert_eq!(again.model.id, artifact.model.id);
}

const RECIPE_PATH_V2: &str = "family-weighted-softmax-kl-v2-random-subsets";

#[test]
fn random_subsets_are_seeded_renormalized_and_keep_the_full_set_first() {
    let mut data = measured(0);
    let mut example = fit(
        &data,
        training_request(&data, &request(), 10, &data_use()).unwrap(),
    )
    .unwrap()
    .snapshot
    .examples
    .remove(0);
    let full = vec![(0, 0.4), (1, 0.3), (2, 0.2), (3, 0.1)];
    let draws = fit::subset_targets(&example, &full).unwrap();
    assert_eq!(draws.len(), 8);
    assert_eq!(draws[0], full);
    for draw in &draws {
        assert!(draw.len() >= 2);
        assert!((draw.iter().map(|(_, p)| p).sum::<f64>() - 1.0).abs() < 1e-12);
        assert!(draw.windows(2).all(|w| w[0].0 < w[1].0));
    }
    assert_eq!(fit::subset_targets(&example, &full).unwrap(), draws);
    // The recipe's parameters are pinned, and so is the stream: SplitMix64's
    // reference vector and the draws of one named case.
    assert_eq!(
        super::super::RECIPE_PARAMETERS,
        super::super::RecipeParameters {
            subset_draws: 8,
            subset_inclusion: 0.5,
            subset_seed: 0x5355_4253_4554_0002,
            min_candidate_cases: 8,
        }
    );
    let mut state = 0;
    assert_eq!(fit::split_mix(&mut state), 0xE220_A839_7B1D_CDAF);
    let mut golden = example.clone();
    golden.version_id = "golden-case".into();
    let indices: Vec<Vec<usize>> = fit::subset_targets(&golden, &full)
        .unwrap()
        .iter()
        .map(|draw| draw.iter().map(|(i, _)| *i).collect())
        .collect();
    assert_eq!(
        indices,
        vec![
            vec![0, 1, 2, 3],
            vec![0, 2, 3],
            vec![1, 2],
            vec![0, 2, 3],
            vec![0, 1, 2],
            vec![0, 1, 3],
            vec![0, 2],
            vec![1, 2],
        ]
    );
    // Another case draws another stream.
    example.version_id.push_str("-other");
    assert_ne!(fit::subset_targets(&example, &full).unwrap(), draws);
    // Two candidates leave nothing to draw.
    assert_eq!(fit::subset_targets(&example, &full[..2]).unwrap().len(), 1);
    data.versions.clear();
}

#[test]
fn the_fallback_order_maps_to_the_candidates_it_names_only() {
    let data = measured(0);
    let artifact = fit(
        &data,
        training_request(&data, &request(), 10, &data_use()).unwrap(),
    )
    .unwrap();
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
    assert!(artifact.model.recipe_parameters.is_some());
    // A chat falls back only to what its order names, never to the rest.
    assert_eq!(
        persona_keys(&artifact.model, &[matcher("PAINTER")]),
        vec![key("painter")]
    );
    assert_eq!(
        persona_keys(&artifact.model, &[matcher("parser"), matcher("painter")]),
        vec![key("parser"), key("painter")]
    );
    // Another platform, effort or fast mode names nothing.
    let elsewhere = RankedMatcher {
        platform: Some("invented-platform".into()),
        ..matcher("painter")
    };
    assert!(persona_keys(&artifact.model, &[elsewhere]).is_empty());
    let painter = artifact
        .model
        .candidates
        .iter()
        .find(|c| c.configuration.model_id == "painter")
        .unwrap()
        .configuration
        .clone();
    let other_effort = RankedMatcher {
        effort: Some(format!(
            "{}-other",
            painter.effort.clone().unwrap_or_default()
        )),
        ..matcher("painter")
    };
    assert!(persona_keys(&artifact.model, &[other_effort]).is_empty());
    let fast = RankedMatcher {
        fast_mode: Some(!painter.fast_mode.unwrap_or(false)),
        ..matcher("painter")
    };
    assert!(persona_keys(&artifact.model, &[fast]).is_empty());
    let exact = RankedMatcher {
        effort: painter.effort.clone(),
        fast_mode: Some(painter.fast_mode.unwrap_or(false)),
        ..matcher("painter")
    };
    assert_eq!(
        persona_keys(&artifact.model, &[exact]),
        vec![key("painter")]
    );
}

#[test]
fn held_out_cases_count_present_candidates_only_and_certify_on_enough_groups() {
    let mut data = measured(16);
    // The parser's held-out cell of one case is incomplete: that case still
    // counts the two arms it has only if two candidates remain, so it drops.
    data.attempts.retain(|a| {
        !(a.version_id == "held-15" && a.configuration.model_id == "parser" && a.repetition == 2)
    });
    let artifact = fit(
        &data,
        training_request(&data, &request(), 10, &data_use()).unwrap(),
    )
    .unwrap();
    let persona = persona_keys(&artifact.model, &request().persona_order);
    let mut eligible = countable(&data);
    eligible.remove("held-14");
    let held = held_out_cases(&data, &artifact, &persona, &eligible, 10).unwrap();
    let cases = held.cases;
    assert_eq!(held.unqualified, 1);
    assert_eq!(held.ungraded, 0);
    assert_eq!(cases.len(), 14);
    for case in &cases {
        let names: BTreeSet<_> = case
            .cells
            .iter()
            .map(|c| c.candidate_key.as_str())
            .collect();
        assert!(names.contains("learned") && names.contains("persona"));
        // The learned choice transfers to each prompt kind.
        let index: usize = case.version_id["held-".len()..].parse().unwrap();
        let model = artifact
            .model
            .candidates
            .iter()
            .find(|c| c.candidate_key == case.learned_key)
            .unwrap()
            .configuration
            .model_id
            .clone();
        assert_eq!(
            model,
            if index.is_multiple_of(2) {
                "parser"
            } else {
                "painter"
            }
        );
    }
    let keys: Vec<_> = artifact
        .model
        .candidates
        .iter()
        .map(|c| c.candidate_key.clone())
        .collect();
    assert_eq!(held.pool, keys);
    let assessment = acceptance::assess_available(&rule(), &cases, &held.pool).unwrap();
    assert!(assessment.passed, "{:?}", assessment.reasons);
    assert_eq!(assessment.groups, 14);
    // A worker measured on fewer than eight groups cannot be compared.
    let thin: Vec<_> = cases
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, mut case)| {
            if index >= 7 {
                case.cells.retain(|c| {
                    !c.candidate_key.starts_with("worker:") || c.candidate_key.ends_with(&keys[0])
                });
            }
            case
        })
        .collect();
    let thin = acceptance::assess_available(&rule(), &thin, &keys).unwrap();
    assert!(!thin.passed);
    assert!(thin
        .reasons
        .contains(&"fewer_than_eight_independent_groups".to_owned()));
}

#[test]
fn a_class_without_measured_held_out_cases_has_no_cases() {
    let data = measured(0);
    let artifact = fit(
        &data,
        training_request(&data, &request(), 10, &data_use()).unwrap(),
    )
    .unwrap();
    let persona = persona_keys(&artifact.model, &request().persona_order);
    let held = held_out_cases(&data, &artifact, &persona, &BTreeMap::new(), 10).unwrap();
    assert!(held.cases.is_empty());
    assert!(held.pool.is_empty());
    assert_eq!(held.unqualified, 0);
}

#[test]
fn a_candidate_on_fewer_than_eight_held_out_groups_leaves_the_certified_pool() {
    let mut data = measured(16);
    // The vendor may see held-out tasks here, so it trains and is measured on
    // every held-out case; the parser only on five held-out groups.
    for c in &mut data.runs[0].request.configurations {
        if c.model_id == "vendor-model" {
            c.provider_id = "invented-acp".into();
        }
    }
    let vendor = data.runs[0]
        .request
        .configurations
        .iter()
        .find(|c| c.model_id == "vendor-model")
        .unwrap()
        .clone();
    for a in &mut data.attempts {
        if a.configuration.model_id == "vendor-model" {
            a.configuration = vendor.clone();
            a.observed = Some(vendor.clone());
        }
    }
    let held_parser: Vec<_> = data
        .attempts
        .iter()
        .filter(|a| a.version_id.starts_with("held-") && a.configuration.model_id == "parser")
        .cloned()
        .collect();
    for mut a in held_parser {
        a.id = format!("{}-vendor", a.id);
        a.configuration = vendor.clone();
        a.observed = Some(vendor.clone());
        data.attempts.push(a);
    }
    data.attempts.retain(|a| {
        !(a.configuration.model_id == "parser"
            && a.version_id.starts_with("held-")
            && a.version_id["held-".len()..].parse::<usize>().unwrap() >= 5)
    });
    let artifact = fit(
        &data,
        training_request(&data, &request(), 10, &data_use()).unwrap(),
    )
    .unwrap();
    assert_eq!(artifact.model.candidates.len(), 3);
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
    let persona = persona_keys(&artifact.model, &request().persona_order);
    let held = held_out_cases(&data, &artifact, &persona, &countable(&data), 10).unwrap();
    let mut pool = vec![key("painter"), key("vendor-model")];
    pool.sort_by_key(|k| {
        artifact
            .model
            .candidates
            .iter()
            .position(|c| &c.candidate_key == k)
    });
    assert_eq!(held.pool, pool);
    // Every case still compares the two pool candidates; the parser is never
    // a worker, an arm or a learned choice until a later look measures it.
    assert_eq!(held.cases.len(), 16);
    let parser = key("parser");
    for case in &held.cases {
        assert!(case
            .cells
            .iter()
            .all(|c| !c.candidate_key.ends_with(&parser)));
        assert_ne!(case.learned_key, parser);
        assert_ne!(case.aggregate_key, parser);
    }
    let assessment = acceptance::assess_available(&rule(), &held.cases, &held.pool).unwrap();
    assert_eq!(assessment.groups, 16);
    assert!(assessment
        .comparisons
        .iter()
        .all(|c| !c.baseline.ends_with(&parser)));
}
