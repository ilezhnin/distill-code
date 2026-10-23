use super::*;

/// Project the unchanged archive contract, rather than reconstructing the
/// expected view with any of the optimized path's helpers.
fn projected(data: &QueryData, configuration: &Configuration) -> serde_json::Value {
    let mut full = serde_json::to_value(model_history(data, configuration)).unwrap();
    for point in full.as_array_mut().unwrap() {
        point.as_object_mut().unwrap().remove("report");
    }
    full
}

fn assert_view(data: &QueryData, configuration: &Configuration) -> Vec<ModelHistoryViewPoint> {
    let view = model_history_view(data, configuration);
    assert_eq!(
        serde_json::to_value(&view).unwrap(),
        projected(data, configuration)
    );
    view
}

fn own<'a>(data: &'a QueryData, configuration: &Configuration) -> Vec<&'a Attempt> {
    let acknowledged = run_acknowledgments(&data.attempts);
    let key = model_key(configuration);
    data.attempts
        .iter()
        .filter(|attempt| model_key(&ledger_configuration(attempt, &acknowledged)) == key)
        .collect()
}

fn one_case() -> QueryData {
    let mut data = tests::dataset();
    data.versions.truncate(1);
    data.runs.retain(|run| run.id == "before");
    data.attempts
        .retain(|attempt| attempt.run_id == "before" && attempt.version_id == "v0");
    data.runs[0].request.version_ids = vec!["v0".into()];
    data
}

fn review(at: i64, score: f64, provenance: &str) -> Evaluation {
    Evaluation {
        id: format!("invented-review-{at}"),
        evaluator_revision: "invented-v1".into(),
        verdict: "judged".into(),
        score: Some(score),
        reason: String::new(),
        created_at: at,
        provenance: provenance.into(),
        artifacts: Vec::new(),
        details: None,
        judge: None,
        usage: None,
    }
}

#[test]
fn model_history_view_matches_complete_archive_projections_and_dated_signatures() {
    for (name, data) in ledger_regressions::history_preparation_fixtures() {
        let configurations: BTreeMap<_, _> = data
            .attempts
            .iter()
            .map(|attempt| {
                (
                    model_key(&attempt.configuration),
                    attempt.configuration.clone(),
                )
            })
            .collect();
        for (key, configuration) in configurations {
            assert!(!assert_view(&data, &configuration).is_empty(), "{name}");
            for point in model_history(&data, &configuration) {
                let query = ResultQuery {
                    as_of: Some(point.created_at),
                    limit: Some(500),
                    ..Default::default()
                };
                let pool = ranked_pool(&data, &query);
                let prepared = PreparedMeasurements::new(&data, &query, &pool);
                assert!(history_groups_fit(
                    &data,
                    &prepared,
                    &pool,
                    point.created_at
                ));
                assert_eq!(
                    dated_model_history_signature(
                        &data,
                        &key,
                        &own(&data, &configuration),
                        point.created_at
                    ),
                    history_row_signature(&point.report, &key, true),
                    "{name} at {}",
                    point.created_at,
                );
            }
        }
    }
}

#[test]
fn model_history_view_keeps_other_models_resource_baselines() {
    let (_, data) = ledger_regressions::history_preparation_fixtures().remove(0);
    let configuration = &data.runs[0].request.configurations[0];
    let key = model_key(configuration);
    let view = assert_view(&data, configuration);
    let measured = view[0]
        .recalculated_report
        .models
        .iter()
        .find(|entry| entry.key == key)
        .unwrap();
    // The invented faster and cheaper peers lower the target's resource shares.
    assert!(measured.row.points.unwrap() < 1000);
    let mut without_peers = data.clone();
    without_peers
        .attempts
        .retain(|attempt| model_key(&attempt.configuration) == key);
    let alone = model_history_view(&without_peers, configuration);
    assert!(alone[0].recalculated_report.models[0].row.points > measured.row.points);
}

fn crowded() -> QueryData {
    let mut data = one_case();
    let template_run = data.runs[0].clone();
    let template_attempt = data.attempts[0].clone();
    for index in 0..500 {
        let mut run = template_run.clone();
        run.id = format!("invented-peer-run-{index}");
        let configuration = &mut run.request.configurations[0];
        configuration.id = format!("invented-peer-configuration-{index}");
        configuration.model_id = format!("invented-peer-{index}");
        let mut attempt = template_attempt.clone();
        attempt.id = format!("invented-peer-attempt-{index}");
        attempt.run_id = run.id.clone();
        attempt.configuration = configuration.clone();
        attempt.observed = Some(configuration.clone());
        data.runs.push(run);
        data.attempts.push(attempt);
    }
    // Below all 500 peers as recorded, then revised to a pass afterwards.
    data.attempts[0].outcome = Some("judged".into());
    data.attempts[0].evaluations = vec![review(2, 0.0, "objective"), review(10, 1.0, "human")];
    data
}

#[test]
fn model_history_view_preserves_top_500_absence_and_recalculation_fallback() {
    let mut data = crowded();
    let configuration = data.runs[0].request.configurations[0].clone();
    let key = model_key(&configuration);
    let query = ResultQuery {
        as_of: Some(3),
        limit: Some(500),
        ..Default::default()
    };
    let pool = ranked_pool(&data, &query);
    let prepared = PreparedMeasurements::new(&data, &query, &pool);
    assert!(!history_groups_fit(&data, &prepared, &pool, 3));
    let full = model_history(&data, &configuration);
    assert_eq!(full.len(), 1);
    assert_eq!(full[0].report.models.len(), 500);
    assert_eq!(history_row_signature(&full[0].report, &key, true), None);
    assert_eq!(
        dated_model_history_signature(&data, &key, &own(&data, &configuration), 3),
        None
    );
    let view = assert_view(&data, &configuration);
    assert_eq!(view[0].created_at, 3);
    assert_eq!(view[0].revised_version_ids, vec!["v0"]);
    assert_eq!(view[0].recalculated_report.models[0].row.points, Some(1000));
    // At exactly 500 groups the target is present and filtering is safe.
    data.runs.pop();
    data.attempts.pop();
    let pool = ranked_pool(&data, &query);
    let prepared = PreparedMeasurements::new(&data, &query, &pool);
    assert!(history_groups_fit(&data, &prepared, &pool, 3));
    assert!(dated_model_history_signature(&data, &key, &own(&data, &configuration), 3).is_some());
    assert_view(&data, &configuration);
}

#[test]
fn model_history_view_row_bound_counts_superseded_groups_and_ignores_future_cells() {
    let mut data = crowded();
    let query = ResultQuery {
        as_of: Some(3),
        limit: Some(500),
        ..Default::default()
    };
    data.attempts.last_mut().unwrap().outcome = Some(SUPERSEDED.into());
    let pool = ranked_pool(&data, &query);
    let prepared = PreparedMeasurements::new(&data, &query, &pool);
    // A superseded-only configuration still occupies a dated board row.
    assert!(!history_groups_fit(&data, &prepared, &pool, 3));
    let configuration = data.runs[0].request.configurations[0].clone();
    assert_view(&data, &configuration);
    data.attempts.last_mut().unwrap().finished_at = Some(4);
    let pool = ranked_pool(&data, &query);
    let prepared = PreparedMeasurements::new(&data, &query, &pool);
    assert!(history_groups_fit(&data, &prepared, &pool, 3));
    assert_view(&data, &configuration);
}

#[test]
fn model_history_view_keeps_observation_when_the_dated_pool_has_no_target() {
    let mut data = one_case();
    // The case was measured outside the then-current release and joined later.
    data.releases = vec![
        PoolRelease {
            id: "invented-empty-release".into(),
            name: "Empty".into(),
            created_at: 1,
            version_ids: Vec::new(),
        },
        PoolRelease {
            id: "invented-measured-release".into(),
            name: "Measured".into(),
            created_at: 5,
            version_ids: vec!["v0".into()],
        },
    ];
    let configuration = &data.runs[0].request.configurations[0];
    let full = model_history(&data, configuration);
    assert_eq!(full.len(), 1);
    assert!(full[0].report.models.is_empty());
    let view = assert_view(&data, configuration);
    assert_eq!(
        (
            view[0].created_at,
            view[0].recalculated_report.models[0].row.points
        ),
        (3, Some(1000))
    );
}

#[test]
fn model_history_view_keeps_24_dates_and_the_oldest_equal_observation() {
    let mut data = one_case();
    let template_run = data.runs.remove(0);
    let template_attempt = data.attempts.remove(0);
    let configuration = template_attempt.configuration.clone();
    for index in 0..30 {
        let mut run = template_run.clone();
        run.id = format!("invented-observation-{index:02}");
        run.created_at = 2 + index * 3;
        run.updated_at = run.created_at + 1;
        let mut attempt = template_attempt.clone();
        // The last two sittings have exactly the same evidence label and
        // score protocol: the latest one must not re-date that observation.
        attempt.id = format!("invented-measurement-{:02}", index.min(28));
        attempt.run_id = run.id.clone();
        attempt.started_at = Some(run.created_at);
        attempt.finished_at = Some(run.updated_at);
        data.runs.push(run);
        data.attempts.push(attempt);
    }
    let view = assert_view(&data, &configuration);
    assert_eq!(view.len(), 24);
    assert_eq!(view.first().unwrap().run_id, "invented-observation-05");
    assert_eq!(view.last().unwrap().run_id, "invented-observation-28");
    assert_eq!(view.last().unwrap().created_at, 87);
    let original = serde_json::to_value(&view).unwrap();
    // An unmeasured cancellation never borrows the older score as a new point.
    let mut run = data.runs.last().unwrap().clone();
    run.id = "invented-unmeasured-cancel".into();
    run.state = "cancelled".into();
    run.created_at = 100;
    run.updated_at = 110;
    let mut attempt = template_attempt.clone();
    attempt.id = "invented-cancelled-attempt".into();
    attempt.run_id = run.id.clone();
    attempt.outcome = Some("cancelled".into());
    attempt.started_at = None;
    attempt.finished_at = Some(110);
    data.runs.push(run);
    data.attempts.push(attempt);
    assert_eq!(
        serde_json::to_value(assert_view(&data, &configuration)).unwrap(),
        original
    );
}
