use super::*;

fn before_only() -> QueryData {
    let (mut data, _) = super::tests::dataset();
    data.runs.retain(|r| r.id == "before");
    data.attempts.retain(|a| a.run_id == "before");
    data
}

fn evaluation(at: i64, value: Option<f64>, provenance: &str, verdict: &str) -> Evaluation {
    Evaluation {
        id: format!("eval-{at}"),
        evaluator_revision: "1".into(),
        verdict: verdict.into(),
        score: value,
        reason: String::new(),
        created_at: at,
        provenance: provenance.into(),
        artifacts: vec![],
        details: None,
        judge: None,
        usage: None,
    }
}

#[test]
fn future_human_review_must_not_create_a_score_in_the_past() {
    let mut a = before_only().attempts.remove(0);
    a.outcome = Some("pending_review".into());
    a.evaluations = vec![evaluation(2, None, "objective", "pending_review")];
    assert_eq!(score_as_of(&a, Some(3)), None);
    // This is the outcome mutation made by Service::review for rubric tasks.
    a.outcome = Some("fail".into());
    a.evaluations
        .push(evaluation(10, Some(0.4), "human", "fail"));
    assert_eq!(score_as_of(&a, Some(3)), None);
}

#[test]
fn successful_objective_rescore_must_update_the_effective_score() {
    let mut a = before_only().attempts.remove(0);
    a.outcome = Some("fail".into());
    a.evaluations = vec![
        evaluation(2, Some(0.0), "objective", "fail"),
        evaluation(10, Some(1.0), "objective", "pass"),
    ];
    // Service::rescore appends the new evaluation and preserves the outcome.
    assert_eq!(score(&a), Some(1.0));
}

#[test]
fn pending_retest_must_not_erase_completed_measurements() {
    let mut data = before_only();
    let mut pending = data.runs[0].clone();
    pending.id = "pending".into();
    pending.created_at = 10;
    pending.updated_at = 10;
    pending.state = "running".into();
    let attempts: Vec<_> = data
        .attempts
        .iter()
        .cloned()
        .map(|mut a| {
            a.id = format!("pending-{}", a.id);
            a.run_id = "pending".into();
            a.phase = "pending".into();
            a.outcome = None;
            a.started_at = None;
            a.finished_at = None;
            a.observed = None;
            a.evaluations.clear();
            a.output = None;
            a
        })
        .collect();
    data.runs.push(pending);
    data.attempts.extend(attempts);
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    eprintln!(
        "pending retest: status={}, scored={}, points={:?}",
        row.status, row.scored, row.points
    );
    assert_eq!(row.points, Some(1000));
}

#[test]
fn cost_rating_must_not_penalize_identical_per_case_cost_for_more_repetitions() {
    let mut data = before_only();
    for a in &mut data.attempts {
        a.usage.cost = Some(1.0);
    }
    let mut config = data.runs[0].request.configurations[0].clone();
    config.id = "other".into();
    config.model_id = "other".into();
    let mut run = data.runs[0].clone();
    run.id = "other".into();
    run.created_at = 5;
    run.updated_at = 6;
    run.request.configurations = vec![config.clone()];
    run.request.repetitions = 3;
    run.request.max_executions = 18;
    let mut extra = vec![];
    for a in &data.attempts {
        for repetition in 0..3 {
            let mut a = a.clone();
            a.id = format!("other-{}-{repetition}", a.id);
            a.run_id = "other".into();
            a.configuration = config.clone();
            a.observed = Some(config.clone());
            a.repetition = repetition;
            extra.push(a);
        }
    }
    data.runs.push(run);
    data.attempts.extend(extra);
    let rows = leaderboard(&data, &ResultQuery::default()).rows;
    assert_eq!(rows.len(), 2);
    assert!(rows
        .iter()
        .all(|r| r.status == "comparable" && r.points == Some(1000)));
    eprintln!(
        "cost ratings: {:?}",
        rows.iter()
            .map(|r| (&r.configuration.model_id, r.cost, r.cost_points))
            .collect::<Vec<_>>()
    );
    assert_eq!(rows[0].cost_points, rows[1].cost_points);
}

#[test]
fn new_panel_must_not_mix_with_old_panel_scores() {
    let mut a = before_only().attempts.remove(0);
    a.outcome = Some("judged".into());
    a.evaluations = vec![
        evaluation(2, Some(0.7), "judge", "judged"),
        evaluation(3, Some(0.8), "judge", "judged"),
        evaluation(4, Some(0.9), "judge", "judged"),
        evaluation(10, None, "render", "rendered"),
        evaluation(11, Some(0.2), "judge", "judged"),
        evaluation(12, Some(0.3), "judge", "judged"),
        evaluation(13, Some(0.4), "judge", "judged"),
    ];
    assert_eq!(score(&a), Some(0.3));
}

#[test]
fn larger_unrelated_suite_must_not_hide_a_valid_nerf_follow_up() {
    let (mut data, baseline) = super::tests::dataset();
    let before = compare(&data, &baseline, &ResultQuery::default());
    assert_eq!(before[0].quality_change, Some(-1.0));
    let mut version = data.versions[0].clone();
    version.id = "v6".into();
    version.definition_id = "d6".into();
    version.manifest.task_family = "family-6".into();
    data.versions.push(version);
    let mut run = data.runs[1].clone();
    run.id = "larger".into();
    run.created_at = 10;
    run.updated_at = 11;
    run.request.version_ids.push("v6".into());
    run.request.max_executions = 7;
    let template = data.attempts[6].clone();
    for id in &run.request.version_ids {
        let mut a = template.clone();
        a.id = format!("larger-{id}");
        a.run_id = run.id.clone();
        a.version_id = id.clone();
        data.attempts.push(a);
    }
    data.runs.push(run);
    let after = compare(&data, &baseline, &ResultQuery::default());
    eprintln!(
        "Nerf after larger suite: {} {:?}",
        after[0].status, after[0].quality_change
    );
    assert_eq!(after[0].quality_change, Some(-1.0));
}

#[test]
fn history_includes_late_reviews_without_global_run_truncation() {
    let mut data = before_only();
    let configuration = data.attempts[0].configuration.clone();
    data.attempts[0]
        .evaluations
        .push(evaluation(50, Some(0.4), "human", "fail"));
    for n in 0..30 {
        let mut run = data.runs[0].clone();
        run.id = format!("other-{n}");
        run.created_at = 100 + n;
        run.updated_at = 101 + n;
        data.runs.push(run);
    }
    let points = history(&data, &configuration);
    assert_eq!(points.len(), 2);
    assert_eq!(points[0].report.rows[0].points, Some(1000));
    assert_eq!(points[1].report.rows[0].points, Some(900));
    assert_eq!(points[1].created_at, 50);
    assert_eq!(points[0].recalculated_report.rows[0].points, Some(900));
    assert_eq!(points[0].revised_version_ids, vec!["v0"]);
    assert!(points[1].revised_version_ids.is_empty());
}

#[test]
fn backfill_aligns_the_pool_but_preserves_real_retests_and_the_dated_archive() {
    let (mut data, _) = super::tests::dataset();
    data.versions.truncate(3);
    data.attempts.retain(|a| {
        (a.run_id == "before" && a.version_id == "v0")
            || (a.run_id == "after" && a.version_id == "v1")
    });
    data.attempts[1].finished_at = Some(6);
    let configuration = data.attempts[0].configuration.clone();
    let first = history(&data, &configuration);
    assert_eq!(first[0].report.rows[0].points, Some(1000));
    assert_eq!(first[0].report.rows[0].scored, 1);
    assert_eq!(first[0].recalculated_report.rows[0].points, Some(500));
    assert_eq!(first[0].backfilled_version_ids, vec!["v1"]);
    assert!(first
        .iter()
        .all(|s| s.recalculated_report.rows[0].scored == 2
            && s.recalculated_report.rows[0].planned == 3));

    let mut run = data.runs[1].clone();
    run.id = "retest".into();
    run.created_at = 10;
    run.updated_at = 11;
    let mut attempt = data.attempts[1].clone();
    attempt.id = "retest-v1".into();
    attempt.run_id = run.id.clone();
    attempt.finished_at = Some(11);
    attempt.outcome = Some("pass".into());
    data.runs.push(run);
    data.attempts.push(attempt);
    let points = history(&data, &configuration);
    assert_eq!(
        points
            .iter()
            .map(|s| s.recalculated_report.rows[0].points)
            .collect::<Vec<_>>(),
        vec![Some(500), Some(500), Some(1000)]
    );
    assert_eq!(
        points[0].recalculated_report.rows[0].attempt_ids,
        first[0].recalculated_report.rows[0].attempt_ids
    );
    assert!(points.last().unwrap().backfilled_version_ids.is_empty());
    assert_eq!(
        points.last().unwrap().recalculated_report.rows[0].points,
        leaderboard(&data, &ResultQuery::default()).rows[0].points
    );
}

#[test]
fn backfill_requires_every_repetition_and_never_reuses_a_replaced_version() {
    let (mut data, _) = super::tests::dataset();
    let configuration = data.attempts[0].configuration.clone();
    data.runs[1].request.repetitions = 2;
    data.attempts
        .iter_mut()
        .filter(|a| a.run_id == "after")
        .for_each(|a| a.finished_at = Some(6));
    // One repetition of the later run cannot displace the first complete cell.
    let mut replacement = data.versions[0].clone();
    replacement.id = "replacement".into();
    replacement.published_at = 9;
    data.versions.push(replacement);
    let points = history(&data, &configuration);
    for point in points {
        let row = &point.recalculated_report.rows[0];
        assert_eq!(row.points, Some(1000));
        assert_eq!(row.scored, 5);
        assert_eq!(row.missing_version_ids, vec!["replacement"]);
        assert!(row.attempt_ids.iter().all(|id| id.starts_with("before-")));
    }
}

#[test]
fn recalculation_uses_current_execution_conditions_and_requires_an_observed_anchor() {
    let (mut data, _) = super::tests::dataset();
    let configuration = data.attempts[0].configuration.clone();
    for a in &mut data.attempts {
        if a.run_id == "before" {
            a.observed.as_mut().unwrap().inventory_revision = Some("old-runtime".into());
        } else {
            a.finished_at = Some(6);
        }
    }
    let points = history(&data, &configuration);
    assert_eq!(points[0].report.rows[0].points, Some(1000));
    assert!(points[0].recalculated_report.rows.is_empty());
    assert_eq!(points[1].recalculated_report.rows[0].points, Some(0));
    assert!(points[1].backfilled_version_ids.is_empty());
}

#[test]
fn incomplete_judge_batch_and_unreported_judge_cost_stay_unknown() {
    let mut a = before_only().attempts.remove(0);
    a.outcome = Some("judged".into());
    a.usage.cost = Some(1.0);
    let mut marker = evaluation(10, None, "render", "rendered");
    marker.details = Some(serde_json::json!({"expectedJudges":3}));
    a.evaluations = vec![marker, evaluation(11, Some(0.8), "judge", "judged")];
    assert_eq!(score(&a), None);
    assert_eq!(mean_case_cost(&[&a], None), None);
    for n in 12..14 {
        a.evaluations
            .push(evaluation(n, Some(0.8), "judge", "judged"));
    }
    for e in a.evaluations.iter_mut().filter(|e| e.provenance == "judge") {
        e.usage = Some(TokenUsage {
            cost: Some(0.1),
            ..Default::default()
        });
    }
    assert_eq!(score(&a), Some(0.8));
    assert!((mean_case_cost(&[&a], None).unwrap() - 1.3).abs() < 1e-10);
    a.outcome = Some("cancelled".into());
    assert_eq!(score(&a), None);
}

#[test]
fn incomplete_repetitions_do_not_replace_the_previous_cell() {
    let mut data = before_only();
    let mut run = data.runs[0].clone();
    run.id = "retest".into();
    run.created_at = 20;
    run.request.repetitions = 2;
    let mut a = data.attempts[0].clone();
    a.id = "new-first-repeat".into();
    a.run_id = run.id.clone();
    a.outcome = Some("fail".into());
    data.runs.push(run);
    data.attempts.push(a);
    assert_eq!(
        leaderboard(&data, &ResultQuery::default()).rows[0].points,
        Some(1000)
    );
}

#[test]
fn prepared_export_joins_current_cases_across_runs_and_masks_missing_cells() {
    let (mut data, _) = super::tests::dataset();
    data.attempts
        .retain(|a| a.run_id == "before" || a.version_id == "v0");
    let mut version = data.versions[0].clone();
    version.id = "new-version".into();
    version.published_at = 100;
    data.versions.push(version);
    let rows = crate::services::benchmarks::export::ledger_rows(&data, false, "test").unwrap();
    assert_eq!(rows.len(), 6);
    let gap = rows
        .iter()
        .find(|r| r["taskVersion"] == "new-version")
        .unwrap();
    assert_eq!(gap["matrix"][0]["observed"], false);
    assert!(gap["matrix"][0]["reward"].is_null());
    let retained = rows.iter().find(|r| r["taskVersion"] == "v1").unwrap();
    assert_eq!(retained["matrix"][0]["reward"], 1.0);
    assert_eq!(retained["matrix"][0]["runId"], "before");
}

#[test]
fn interrupted_run_does_not_turn_each_ordinary_evaluation_into_a_history_point() {
    let mut data = before_only();
    let configuration = data.attempts[0].configuration.clone();
    data.runs[0].state = "needs_attention".into();
    data.attempts[0]
        .evaluations
        .push(evaluation(50, Some(1.0), "objective", "pass"));
    assert!(history(&data, &configuration).is_empty());
    assert_eq!(
        leaderboard(&data, &ResultQuery::default()).rows[0].points,
        Some(1000)
    );
}

#[test]
fn missing_repeat_score_does_not_count_as_complete_case() {
    let mut data = before_only();
    data.runs[0].request.repetitions = 2;
    let mut second = data.attempts[0].clone();
    second.id = "missing-score".into();
    second.repetition = 1;
    second.outcome = Some("infrastructure_failure".into());
    data.attempts.truncate(1);
    data.attempts.push(second);
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!(row.scored, 0);
    assert_eq!(row.points, None);
}
