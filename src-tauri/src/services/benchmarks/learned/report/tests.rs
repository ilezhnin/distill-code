use super::*;

fn fixture() -> (QueryData, HoldoutPlan, LearnedModel) {
    let (mut data, artifact, request) = holdout::tests::fixture();
    let mut plan = holdout::prepare(&data, &artifact.model, request).unwrap();
    plan.created_at = 100;
    let mut run = data.runs[0].clone();
    run.id = "holdout-run".into();
    run.created_at = 101;
    run.updated_at = 105;
    run.request.version_ids = plan.request.version_ids.clone();
    for (index, case) in plan.cases.iter().enumerate() {
        for configuration in &run.request.configurations {
            for repetition in 0..case.required_repetitions {
                let mut a = data.attempts[0].clone();
                a.id = format!("held-{index}-{}-{repetition}", configuration.id);
                a.run_id = run.id.clone();
                a.version_id = case.version_id.clone();
                a.repetition = repetition;
                a.configuration = configuration.clone();
                a.observed = Some(configuration.clone());
                a.started_at = Some(102);
                a.finished_at = Some(103);
                a.outcome = Some("pass".into());
                let score = f64::from(
                    (index % 2 == 0) == (configuration.model_id == "parser") && repetition != 2,
                );
                a.evaluations = vec![Evaluation {
                    id: format!("evaluation-{}", a.id),
                    evaluator_revision: case.evaluator_revision.clone(),
                    verdict: if score > 0.0 { "pass" } else { "fail" }.into(),
                    score: Some(score),
                    reason: "isolated fixture".into(),
                    created_at: 104,
                    provenance: "objective".into(),
                    artifacts: vec![],
                    details: None,
                    judge: None,
                    usage: None,
                }];
                data.attempts.push(a);
            }
        }
    }
    data.runs.push(run);
    (data, plan, artifact.model)
}

#[test]
fn reports_soft_rewards_all_baselines_and_exact_repeat_evidence() {
    let (data, plan, model) = fixture();
    let report = evaluate(data, &plan, &model).unwrap();
    assert_eq!(report.groups, 4);
    assert_eq!(report.cases.len(), 8);
    assert_eq!(report.policies.len(), 7);
    let learned = report
        .policies
        .iter()
        .find(|p| p.policy == "learned")
        .unwrap();
    assert!((learned.quality - 2.0 / 3.0).abs() < 1e-12);
    let best = report
        .policies
        .iter()
        .find(|p| p.policy == "best_fixed")
        .unwrap();
    assert!((best.quality - 1.0 / 3.0).abs() < 1e-12);
    assert!(best.learned_gain_interval.lower > 0.0);
    assert_eq!(report.cases[0].cells[0].repeats.len(), 3);
    assert_eq!(report.cases[0].cells[0].repeats[0].scored_at, 104);
    assert!(!report.dispatch_allowed);
    assert_eq!(report.status, "research_only");
}

#[test]
fn reports_reproduce_and_regrading_cannot_change_the_first_score() {
    let (mut data, plan, model) = fixture();
    let original = evaluate(data.clone(), &plan, &model).unwrap();
    for a in data
        .attempts
        .iter_mut()
        .filter(|a| a.run_id == "holdout-run")
    {
        let mut later = a.evaluations[0].clone();
        later.created_at = 200;
        later.score = Some(1.0);
        a.evaluations.push(later);
    }
    data.attempts.reverse();
    data.versions.reverse();
    data.runs.reverse();
    let later = evaluate(data, &plan, &model).unwrap();
    assert_eq!(
        hash(&original.policies).unwrap(),
        hash(&later.policies).unwrap()
    );
    assert_eq!(hash(&original.cases).unwrap(), hash(&later.cases).unwrap());
}

#[test]
fn partial_or_incompatible_first_cells_cannot_be_replaced_by_later_successes() {
    for mode in 0..8 {
        let (mut data, plan, model) = fixture();
        let mut later = data.runs.last().unwrap().clone();
        later.id = "later-success".into();
        later.created_at = 200;
        let copies: Vec<_> = data
            .attempts
            .iter()
            .filter(|a| a.run_id == "holdout-run")
            .map(|a| {
                let mut a = a.clone();
                a.id.push_str("-later");
                a.run_id = later.id.clone();
                a
            })
            .collect();
        data.runs.push(later);
        data.attempts.extend(copies);
        let at = data
            .attempts
            .iter()
            .position(|a| a.run_id == "holdout-run")
            .unwrap();
        match mode {
            0 => {
                data.attempts.remove(at);
            }
            1 => {
                data.attempts[at]
                    .observed
                    .as_mut()
                    .unwrap()
                    .inventory_revision = Some("another-runtime".into());
            }
            2 => {
                data.attempts[at].observed.as_mut().unwrap().effort = None;
            }
            3 => {
                data.attempts[at].outcome = Some("infrastructure_failure".into());
            }
            4 => {
                data.attempts[at].evaluations[0].evaluator_revision = "another-grader".into();
            }
            5 => {
                data.runs
                    .iter_mut()
                    .find(|r| r.id == "holdout-run")
                    .unwrap()
                    .request
                    .repetitions = 4;
            }
            6 => {
                data.attempts[at].evaluations.clear();
            }
            _ => {
                data.attempts[at].phase = "pending".into();
            }
        }
        assert_eq!(
            evaluate(data, &plan, &model).unwrap_err().code,
            "incomplete_holdout_evidence",
            "mode {mode}"
        );
    }
}

#[test]
fn missing_resources_remain_unknown_and_abstentions_use_the_frozen_fallback() {
    let (mut data, mut plan, model) = fixture();
    for a in data
        .attempts
        .iter_mut()
        .filter(|a| a.run_id == "holdout-run")
    {
        a.usage.cost = None;
        a.duration_ms = None;
    }
    for c in &mut plan.cases {
        c.learned_key = plan.request.fallback_key.clone();
        c.learned_abstention = Some("below_quality_floor".into());
    }
    let report = evaluate(data, &plan, &model).unwrap();
    assert_eq!(report.fallback_cases, 8);
    for policy in report.policies {
        assert_eq!(policy.mean_cost, None);
        assert_eq!(policy.mean_duration_ms, None);
        assert_eq!(policy.missing_cost_cases, 8);
        assert_eq!(policy.utility, policy.quality);
    }
}

#[test]
fn recipes_versions_and_pre_reservation_exposure_are_binding() {
    for mode in 0..5 {
        let (mut data, mut plan, model) = fixture();
        match mode {
            0 => {
                plan.evaluation = None;
            }
            1 => {
                plan.evaluation.as_mut().unwrap().seed += 1;
            }
            2 => {
                data.versions
                    .iter_mut()
                    .find(|v| v.id == plan.cases[0].version_id)
                    .unwrap()
                    .content_hash = "changed".into();
            }
            3 => {
                data.runs.last_mut().unwrap().created_at = 99;
            }
            _ => {
                data.runs.last_mut().unwrap().request.timeout_seconds = 1;
            }
        }
        assert!(evaluate(data, &plan, &model).is_err());
    }
}

#[test]
fn equal_group_weights_and_resampled_best_fixed_do_not_count_variants_as_independent() {
    let (data, plan, model) = fixture();
    let mut cases = evaluate(data, &plan, &model).unwrap().cases;
    for (i, case) in cases.iter_mut().enumerate() {
        for (j, c) in case.cells.iter_mut().enumerate() {
            c.utility = f64::from((i / 2 < 2) == (j == 0));
            c.quality = c.utility;
        }
        case.learned_key = case
            .cells
            .iter()
            .find(|c| c.utility == 1.0)
            .unwrap()
            .candidate_key
            .clone();
    }
    let policies = summarize(&cases, &plan);
    let best = policies.iter().find(|p| p.policy == "best_fixed").unwrap();
    assert_eq!(best.utility, 0.5);
    assert_eq!(best.learned_gain_interval.lower, 0.0);
    assert_eq!(best.learned_gain_interval.upper, 0.5);
    // Add more variants in one group without adding any independent group.
    let extra = cases[..2]
        .iter()
        .cycle()
        .take(10)
        .cloned()
        .collect::<Vec<_>>();
    cases.extend(extra);
    assert_eq!(
        hash(&policies).unwrap(),
        hash(&summarize(&cases, &plan)).unwrap()
    );
}

#[tokio::test]
async fn persisted_reports_are_single_use_reloadable_and_detect_tampering() {
    let (data, plan, model) = fixture();
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let (_, artifact, _) = holdout::tests::fixture();
    store.save_selector_fit(&artifact).await.unwrap();
    sqlx::query("INSERT INTO selector_holdouts(id,request_key,request_hash,model_id,created_at,data_json) VALUES(?,?,?,?,?,?)")
        .bind(&plan.id).bind(&plan.request.request_key).bind(hash(&plan.request).unwrap()).bind(&model.id).bind(plan.created_at).bind(serde_json::to_string(&plan).unwrap()).execute(&store.pool).await.unwrap();
    let report = evaluate(data, &plan, &model).unwrap();
    let mut other = report.clone();
    other.created_at += 1;
    let (first, second) = tokio::join!(
        store.save_holdout_report(&report),
        store.save_holdout_report(&report)
    );
    assert_eq!(first.unwrap().artifact_hash, second.unwrap().artifact_hash);
    // A retry returns the first artifact even when later inputs differ.
    assert_eq!(
        store.save_holdout_report(&other).await.unwrap().created_at,
        report.created_at
    );
    store.pool.close().await;
    let store = Store::open(directory.path()).await.unwrap();
    assert_eq!(
        store
            .evaluate_selector_holdout(&plan.id)
            .await
            .unwrap()
            .artifact_hash,
        report.artifact_hash
    );
    sqlx::query(
        "UPDATE selector_holdout_reports SET data_json=json_set(data_json,'$.dispatchAllowed',1)",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(store.selector_holdout_report(&plan.id).await.is_err());
}

#[tokio::test]
async fn store_evaluator_reads_original_versions_raw_plans_and_complete_cells() {
    let (data, plan, model) = fixture();
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let (_, artifact, _) = holdout::tests::fixture();
    store.save_selector_fit(&artifact).await.unwrap();
    for version in &data.versions {
        sqlx::query("INSERT INTO benchmark_definitions(id,draft_json,revision) VALUES(?,?,1)")
            .bind(&version.definition_id)
            .bind(serde_json::to_string(&version.manifest).unwrap())
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO benchmark_versions(id,definition_id,content_hash,manifest_json,published_at) VALUES(?,?,?,?,?)")
            .bind(&version.id).bind(&version.definition_id).bind(&version.content_hash).bind(serde_json::to_string(&version.manifest).unwrap()).bind(version.published_at).execute(&store.pool).await.unwrap();
    }
    sqlx::query("INSERT INTO selector_holdouts(id,request_key,request_hash,model_id,created_at,data_json) VALUES(?,?,?,?,?,?)")
        .bind(&plan.id).bind(&plan.request.request_key).bind(hash(&plan.request).unwrap()).bind(&model.id).bind(plan.created_at).bind(serde_json::to_string(&plan).unwrap()).execute(&store.pool).await.unwrap();
    for run in &data.runs {
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,?,1,?,?,?)")
            .bind(&run.id).bind(&run.id).bind(&run.state).bind(run.created_at).bind(run.updated_at).bind(serde_json::to_string(&run.request).unwrap()).execute(&store.pool).await.unwrap();
    }
    assert_eq!(
        store
            .evaluate_selector_holdout(&plan.id)
            .await
            .unwrap_err()
            .code,
        "incomplete_holdout_evidence"
    );
    assert!(store
        .selector_holdout_report(&plan.id)
        .await
        .unwrap()
        .is_none());
    for attempt in &data.attempts {
        store.insert_attempt(attempt).await.unwrap();
    }
    let expected = evaluate(data, &plan, &model).unwrap();
    let actual = store.evaluate_selector_holdout(&plan.id).await.unwrap();
    assert_eq!(
        hash(&actual.policies).unwrap(),
        hash(&expected.policies).unwrap()
    );
    assert_eq!(hash(&actual.cases).unwrap(), hash(&expected.cases).unwrap());
    assert_eq!(
        store
            .evaluate_selector_holdout(&plan.id)
            .await
            .unwrap()
            .artifact_hash,
        actual.artifact_hash
    );
}
