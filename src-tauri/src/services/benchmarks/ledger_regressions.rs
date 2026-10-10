use super::*;

fn before_only() -> QueryData {
    let mut data = super::tests::dataset();
    data.runs.retain(|r| r.id == "before");
    data.attempts.retain(|a| a.run_id == "before");
    data
}

#[test]
fn development_runs_cannot_rank_reset_standing_or_enter_training() {
    let mut data = before_only();
    for version in &mut data.versions {
        version.manifest.split = "train".into();
    }
    data.versions[0].manifest.split = "development".into();
    data.releases.push(PoolRelease {
        id: "legacy-mixed-release".into(),
        name: "legacy".into(),
        created_at: 1,
        version_ids: data
            .versions
            .iter()
            .map(|version| version.id.clone())
            .collect(),
    });
    let mut diagnostic = data.runs[0].clone();
    diagnostic.id = "diagnostic".into();
    diagnostic.created_at = 10;
    diagnostic.updated_at = 12;
    diagnostic.request.version_ids = vec!["v0".into()];
    let mut latest = data.attempts[0].clone();
    latest.id = "diagnostic-attempt".into();
    latest.run_id = diagnostic.id.clone();
    latest.started_at = Some(10);
    latest.finished_at = Some(11);
    latest.outcome = Some("fail".into());
    data.runs.push(diagnostic.clone());
    data.attempts.push(latest.clone());
    // A model measured only on development fixtures must not create a ranking
    // row or an otherwise-empty training matrix column.
    diagnostic.id = "development-only-model".into();
    diagnostic.request.configurations[0].model_id = "development-only".into();
    latest.id = "development-only-attempt".into();
    latest.run_id = diagnostic.id.clone();
    latest.configuration = diagnostic.request.configurations[0].clone();
    latest.observed = Some(latest.configuration.clone());
    data.runs.push(diagnostic);
    data.attempts.push(latest);

    for query in [
        ResultQuery::default(),
        ResultQuery {
            run_id: Some("before".into()),
            ..Default::default()
        },
        ResultQuery {
            version_ids: Some(vec!["v0".into(), "v1".into()]),
            ..Default::default()
        },
    ] {
        let board = leaderboard(&data, &query);
        assert_eq!(board.rows.len(), 1);
        assert_eq!(board.rows[0].quality, Some(1.0));
        assert!(!board.rows[0].scored_version_ids.contains(&"v0".into()));
        assert!(!board.cohort.unwrap().version_ids.contains(&"v0".into()));
    }
    assert!(leaderboard(
        &data,
        &ResultQuery {
            run_id: Some("diagnostic".into()),
            ..Default::default()
        }
    )
    .rows
    .is_empty());
    let history = history(&data, &data.runs[0].request.configurations[0]);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].run_id, "before");

    for include_held_out in [false, true] {
        let archive = super::super::export::rows(&data, include_held_out, "test").unwrap();
        assert!(archive.iter().all(|row| row["split"] != "development"));
        let ledger = super::super::export::ledger_rows(&data, include_held_out, "test").unwrap();
        assert_eq!(ledger.len(), 5);
        for row in ledger {
            assert_ne!(row["split"], "development");
            assert_eq!(row["matrix"].as_array().unwrap().len(), 1);
        }
    }
    // Raw attempts and the library's diagnostic statistics remain inspectable.
    assert!(data.attempts.iter().any(|a| a.id == "diagnostic-attempt"));
    let tracker = case_tracker(&data);
    assert_eq!(
        tracker
            .iter()
            .find(|row| row.version_id == "v0")
            .unwrap()
            .models,
        2
    );
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

/// Copies the "before" run and its attempts under another model.
fn add_candidate(data: &mut QueryData, model: &str) {
    let mut config = data.runs[0].request.configurations[0].clone();
    config.id = model.into();
    config.model_id = model.into();
    let mut run = data.runs[0].clone();
    run.id = format!("run-{model}");
    run.request.configurations = vec![config.clone()];
    let extra: Vec<_> = data
        .attempts
        .iter()
        .filter(|a| a.run_id == "before")
        .cloned()
        .map(|mut a| {
            a.id = format!("{model}-{}", a.id);
            a.run_id = run.id.clone();
            a.configuration = config.clone();
            a.observed = Some(config.clone());
            a
        })
        .collect();
    data.runs.push(run);
    data.attempts.extend(extra);
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
    // A record rescored before outcomes were persisted: stored "fail", newest
    // objective evaluation "pass". Scoring and display read the latest evidence.
    assert_eq!(score(&a), Some(1.0));
    assert_eq!(
        effective_outcome(a.outcome.as_deref(), &a.evaluations).as_deref(),
        Some("pass")
    );
}

#[test]
fn displayed_outcome_follows_the_newest_evidence() {
    let shown =
        |outcome: Option<&str>, evaluations: &[Evaluation]| effective_outcome(outcome, evaluations);
    let mut marker = evaluation(10, None, "render", "rendered");
    marker.details = Some(serde_json::json!({"expectedJudges":3}));
    let mut panel = vec![
        evaluation(2, None, "objective", "pending_review"),
        marker,
        evaluation(11, Some(0.8), "judge", "judged"),
        evaluation(12, None, "judge_failure", "abstained"),
    ];
    // An incomplete panel is still waiting, whatever was stored.
    assert_eq!(
        shown(Some("judged"), &panel).as_deref(),
        Some("pending_review")
    );
    for at in 13..15 {
        panel.push(evaluation(at, Some(0.6), "judge", "judged"));
    }
    assert_eq!(
        shown(Some("pending_review"), &panel).as_deref(),
        Some("judged")
    );
    // A human review overrides the panel.
    panel.push(evaluation(20, Some(0.3), "human", "fail"));
    assert_eq!(shown(Some("judged"), &panel).as_deref(), Some("fail"));
    // Outcomes without a quality verdict are shown as stored.
    for stored in [Some("cancelled"), Some("evaluation_error"), None] {
        assert_eq!(shown(stored, &panel).as_deref(), stored);
    }
}

#[test]
fn a_critical_failure_cannot_be_outvoted_by_quality_scores() {
    let mut attempt = before_only().attempts.remove(0);
    attempt.outcome = Some("pending_review".into());
    let mut marker = evaluation(10, None, "render", "rendered");
    marker.details = Some(serde_json::json!({"expectedJudges":3,
        "protocol":{"criticalCheckPolicy":super::super::judge_checks::POLICY}}));
    let vote = |at, value, status| {
        let mut result = evaluation(at, Some(value), "judge", "judged");
        result.details = Some(
            serde_json::json!({"criticalCheckPolicy":super::super::judge_checks::POLICY,
            "criticalCheckStatus":status}),
        );
        result
    };
    attempt.evaluations = vec![
        marker.clone(),
        vote(11, 0.0, "fail"),
        vote(12, 0.9, "pass"),
        vote(13, 1.0, "pass"),
    ];
    assert_eq!(score_as_of(&attempt, Some(12)), None);
    assert_eq!(score(&attempt), Some(0.0));
    // An incomplete new panel preserves the last complete verdict and its cutoff.
    marker.created_at = 20;
    attempt.evaluations.extend([marker, vote(21, 0.9, "pass")]);
    assert_eq!(score(&attempt), Some(0.0));
    attempt
        .evaluations
        .extend([vote(22, 0.8, "pass"), vote(23, 1.0, "pass")]);
    assert_eq!(score(&attempt), Some(0.9));
    assert_eq!(score_as_of(&attempt, Some(19)), Some(0.0));
    attempt
        .evaluations
        .push(evaluation(30, Some(0.7), "human", "judged"));
    assert_eq!(score(&attempt), Some(0.7));
}

#[test]
fn critical_panels_require_matching_decided_votes() {
    let mut attempt = before_only().attempts.remove(0);
    attempt.outcome = Some("judged".into());
    let mut marker = evaluation(10, None, "render", "rendered");
    marker.details = Some(serde_json::json!({"expectedJudges":1,
        "protocol":{"criticalCheckPolicy":super::super::judge_checks::POLICY}}));
    for details in [
        None,
        Some(serde_json::json!({"criticalCheckPolicy":"old","criticalCheckStatus":"pass"})),
        Some(
            serde_json::json!({"criticalCheckPolicy":super::super::judge_checks::POLICY,"criticalCheckStatus":"unknown"}),
        ),
    ] {
        let mut vote = evaluation(11, Some(1.0), "judge", "judged");
        vote.details = details;
        attempt.evaluations = vec![marker.clone(), vote];
        assert_eq!(score(&attempt), None);
        assert_eq!(
            evaluation_outcome(&attempt.evaluations),
            Some("pending_review")
        );
    }
    // This protocol never changes legacy visual or text panel interpretation.
    attempt.evaluations[0].details = Some(serde_json::json!({"expectedJudges":1}));
    assert_eq!(score(&attempt), Some(1.0));
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

/// A later run of every case in `before_only()`, settled with `outcomes` per
/// repetition.
fn settled_retest(data: &mut QueryData, state: &str, outcomes: &[&str]) {
    let mut run = data.runs[0].clone();
    run.id = "retest".into();
    run.created_at = 10;
    run.updated_at = 11;
    run.state = state.into();
    run.request.repetitions = outcomes.len() as u32;
    let mut extra = Vec::new();
    for a in data.attempts.iter().filter(|a| a.run_id == "before") {
        for (repetition, outcome) in outcomes.iter().enumerate() {
            let mut a = a.clone();
            a.id = format!("retest-{repetition}-{}", a.id);
            a.run_id = run.id.clone();
            a.repetition = repetition as u32;
            a.outcome = Some((*outcome).into());
            a.finished_at = Some(11);
            if *outcome == "cancelled" {
                a.started_at = None;
                a.observed = None;
                a.output = None;
            }
            extra.push(a);
        }
    }
    data.runs.push(run);
    data.attempts.extend(extra);
}

/// A newer run that began stands even where it scored nothing: its unscored
/// cells are gaps of that sitting, never filled from an earlier run. A run
/// cancelled before any cell started never began, so the earlier run stands.
#[test]
fn an_unscored_newer_run_stands_with_its_gaps() {
    let mut data = before_only();
    settled_retest(&mut data, "cancelled", &["cancelled"]);
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!(
        (row.points, row.scored, row.status.as_str()),
        (Some(1000), 6, "comparable")
    );
    assert!(row.attempt_ids.iter().all(|id| id.starts_with("before-")));
    let rows = crate::services::benchmarks::export::ledger_rows(&data, false, "t").unwrap();
    for cell in rows.iter().map(|r| &r["matrix"][0]) {
        assert_eq!(cell["observed"], true);
        assert_eq!(cell["runId"], "before");
    }
    for outcomes in [
        &["infrastructure_failure"][..],
        &["dispatch_uncertain"],
        &["selection_changed"],
    ] {
        let mut data = before_only();
        settled_retest(&mut data, "cancelled", outcomes);
        let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
        assert_eq!(row.points, None, "{outcomes:?}");
        assert_eq!((row.scored, row.planned), (0, 6), "{outcomes:?}");
        assert_eq!(row.status, "preliminary", "{outcomes:?}");
        assert_eq!(row.missing_version_ids.len(), 6, "{outcomes:?}");
        assert!(
            row.attempt_ids.iter().all(|id| id.starts_with("retest-")),
            "{outcomes:?}"
        );
        // The training ledger is evidence, not standing: the earlier scored
        // cell stays its observation.
        let rows = crate::services::benchmarks::export::ledger_rows(&data, false, "t").unwrap();
        for cell in rows.iter().map(|r| &r["matrix"][0]) {
            assert_eq!(cell["observed"], true, "{outcomes:?}");
            assert_eq!(cell["runId"], "before", "{outcomes:?}");
        }
    }
    // A scored repetition beside an unscored one is a cell of that run,
    // short of two repetitions where two are required.
    for (outcomes, points) in [
        (&["pass", "cancelled"][..], 1000),
        (&["fail", "interrupted"], 0),
    ] {
        let mut data = before_only();
        data.required_repetitions = 2;
        settled_retest(&mut data, "cancelled", outcomes);
        let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
        assert_eq!(row.points, Some(points), "{outcomes:?}");
        assert_eq!(
            (row.scored, row.complete, row.planned),
            (6, 0, 6),
            "{outcomes:?}"
        );
        assert_eq!(row.status, "preliminary", "{outcomes:?}");
        assert!(
            row.attempt_ids.iter().all(|id| id.starts_with("retest-")),
            "{outcomes:?}"
        );
    }
}

#[test]
fn unscored_runs_cannot_redate_model_history_after_a_pool_change() {
    for state in ["needs_attention", "cancelled", "completed"] {
        let mut data = before_only();
        let configuration = data.runs[0].request.configurations[0].clone();
        let original_at = model_history(&data, &configuration)[0].created_at;
        // Replacing one test changes the inherited model row even though
        // the later run produced no new measurement.
        let mut replacement = data.versions[0].clone();
        replacement.id = "replacement-test".into();
        replacement.published_at = 5;
        data.versions.push(replacement);
        settled_retest(&mut data, state, &["infrastructure_failure"]);

        let points = model_history(&data, &configuration);
        assert_eq!(points.len(), 1, "{state}");
        assert_eq!(points[0].run_id, "before", "{state}");
        assert_eq!(points[0].created_at, original_at, "{state}");
        assert_eq!(points[0].report.models[0].row.scored, 6);
        assert_eq!(points[0].recalculated_report.models[0].row.scored, 5);
    }
}

#[test]
fn sealed_unmeasured_runs_leave_no_row_or_history_point() {
    let mut data = before_only();
    settled_retest(&mut data, "completed", &["unsupported"]);
    data.runs[1].baked_at = Some(12);
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!((row.scored, row.complete), (6, 6));
    assert!(row.attempt_ids.iter().all(|id| id.starts_with("before-")));
    let configuration = data.runs[0].request.configurations[0].clone();
    let points = history(&data, &configuration);
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].run_id, "before");

    data.runs.retain(|r| r.id == "retest");
    data.attempts.retain(|a| a.run_id == "retest");
    assert!(leaderboard(&data, &ResultQuery::default()).rows.is_empty());
    let configuration = data.runs[0].request.configurations[0].clone();
    assert!(history(&data, &configuration).is_empty());
}

#[test]
fn sealed_failed_triples_remain_results() {
    let mut data = before_only();
    data.required_repetitions = 3;
    settled_retest(&mut data, "completed", &["fail", "fail", "fail"]);
    data.runs[1].baked_at = Some(12);
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!((row.scored, row.complete, row.passed), (6, 6, 0));
    assert_eq!(row.points, Some(0));
    assert!(row.attempt_ids.iter().all(|id| id.starts_with("retest-")));
}

#[test]
fn scored_failures_and_complete_retests_replace_the_previous_cell() {
    for outcomes in [
        &["fail", "budget_reached"][..],
        &["pass", "budget_timeout"],
        &["pass", "fail"],
    ] {
        let mut data = before_only();
        settled_retest(&mut data, "completed", outcomes);
        let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
        // One failed repetition fails the case.
        assert_eq!(row.points, Some(0), "{outcomes:?}");
        assert_eq!(row.status, "comparable", "{outcomes:?}");
        assert!(row.attempt_ids.iter().all(|id| id.starts_with("retest-")));
    }
    let mut data = before_only();
    settled_retest(&mut data, "completed", &["pass", "pass"]);
    assert_eq!(
        leaderboard(&data, &ResultQuery::default()).rows[0].points,
        Some(1000)
    );
}

/// The product protocol: a case's cell is the repetitions one run scored,
/// up to the three it requires. One repetition is a measurement already,
/// preliminary until the cell is complete; a rank needs every case
/// complete; and repetitions never add up across runs, so a run that
/// measured a case once leaves it incomplete however an earlier run did.
#[test]
fn repetitions_never_add_up_across_runs_and_a_rank_waits_for_complete_cells() {
    let mut data = before_only();
    data.required_repetitions = 3;
    // One repetition each: measured, preliminary, nothing missing to start.
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!((row.scored, row.complete, row.planned), (6, 0, 6));
    assert_eq!(
        (row.points, row.status.as_str()),
        (Some(1000), "preliminary")
    );
    assert!(row.missing_version_ids.is_empty());
    // A later run of two repetitions stands alone, still short of three.
    settled_retest(&mut data, "completed", &["pass", "pass"]);
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!(
        (row.scored, row.complete, row.status.as_str()),
        (6, 0, "preliminary")
    );
    assert_eq!(row.attempt_ids.len(), 12);
    assert!(row.attempt_ids.iter().all(|id| id.starts_with("retest-")));
    // Three repetitions in one run complete every cell, and the row ranks.
    let mut data = before_only();
    data.required_repetitions = 3;
    settled_retest(&mut data, "completed", &["pass", "pass", "pass"]);
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!(
        (row.scored, row.complete, row.status.as_str()),
        (6, 6, "comparable")
    );
    assert_eq!((row.points, row.attempt_ids.len()), (Some(1000), 18));
    // One failed repetition among the three fails the case.
    let mut data = before_only();
    data.required_repetitions = 3;
    settled_retest(&mut data, "completed", &["pass", "fail", "pass"]);
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!((row.scored, row.complete, row.passed), (6, 6, 0));
    assert_eq!((row.points, row.status.as_str()), (Some(0), "comparable"));
}

#[test]
fn a_case_without_any_scored_cell_stays_a_gap() {
    // v0 was cancelled before it started; the other cases passed earlier.
    let mut data = before_only();
    settled_retest(&mut data, "cancelled", &["cancelled"]);
    retest_only_v0(&mut data);
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!(row.status, "preliminary");
    assert_eq!(row.missing_version_ids, vec!["v0"]);
    assert_eq!((row.scored, row.planned), (5, 6));
    // A later run that began on v0 and failed its infrastructure stands
    // instead, with every case its gap.
    let mut data = before_only();
    settled_retest(&mut data, "needs_attention", &["infrastructure_failure"]);
    retest_only_v0(&mut data);
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!(row.status, "preliminary");
    assert_eq!(row.missing_version_ids.len(), 6);
    assert_eq!((row.scored, row.planned, row.attempted), (0, 6, 1));
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
    // Both spend 1.0 per repetition on every case, so both sit at the record.
    assert!(rows.iter().all(|r| r.cost_share == Some(1.0)));
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

/// Settles every attempt of `run_id` as a rendering judged `value` by a
/// two-judge panel whose render marker carries `protocol` when given.
fn judge_run(data: &mut QueryData, run_id: &str, protocol: Option<&str>, value: f64) {
    for a in data.attempts.iter_mut().filter(|a| a.run_id == run_id) {
        let mut marker = evaluation(3, None, "render", "rendered");
        marker.details = Some(match protocol {
            Some(hash) => serde_json::json!({"expectedJudges": 2, "protocolHash": hash}),
            None => serde_json::json!({"expectedJudges": 2}),
        });
        a.outcome = Some("judged".into());
        a.evaluations = vec![
            marker,
            evaluation(4, Some(value), "judge", "judged"),
            evaluation(5, Some(value), "judge", "judged"),
        ];
    }
}

/// A run is one point: a verdict given on its outputs after it ended
/// restates that point instead of adding one, however many come later.
#[test]
fn a_late_review_restates_its_runs_point_instead_of_adding_one() {
    let mut data = before_only();
    let configuration = data.attempts[0].configuration.clone();
    let end = data.runs[0].updated_at;
    data.attempts[0]
        .evaluations
        .push(evaluation(2, Some(1.0), "objective", "pass"));
    for (at, value) in [(50, 0.4), (60, 0.4), (70, 0.4)] {
        data.attempts[0]
            .evaluations
            .push(evaluation(at, Some(value), "human", "fail"));
    }
    for n in 0..30 {
        let mut run = data.runs[0].clone();
        run.id = format!("other-{n}");
        run.created_at = 100 + n;
        run.updated_at = 101 + n;
        data.runs.push(run);
    }
    let points = history(&data, &configuration);
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].created_at, end);
    // As recorded, the board read 1000 at the run's end.
    assert_eq!(points[0].report.rows[0].points, Some(1000));
    // A review short of a pass fails the case: five of six solved.
    assert_eq!(points[0].recalculated_report.rows[0].points, Some(833));
    assert_eq!(points[0].revised_version_ids, vec!["v0"]);
    assert_eq!(
        points[0].recalculated_report.rows[0].points,
        leaderboard(&data, &ResultQuery::default()).rows[0].points
    );

    // Unscored at the run's end, the case was finished then, so its later
    // verdict still counts on that one point.
    data.attempts[0].evaluations.remove(0);
    let points = history(&data, &configuration);
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].report.rows[0].scored, 5);
    assert!(points[0].backfilled_version_ids.is_empty());
    assert_eq!(points[0].revised_version_ids, vec!["v0"]);
    let row = &points[0].recalculated_report.rows[0];
    assert_eq!((row.scored, row.planned, row.points), (6, 6, Some(833)));
}

/// A point on the current pool counts only the cases that had finished by
/// its date; a case first measured later is a gap there, so an older point
/// never reads as complete and never borrows a later result.
#[test]
fn a_point_counts_only_what_had_finished_by_its_date() {
    let mut data = super::tests::dataset();
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
    let early = &first[0].recalculated_report.rows[0];
    assert_eq!(
        (early.scored, early.planned, early.points),
        (1, 3, Some(1000))
    );
    assert!(first.iter().all(|s| s.backfilled_version_ids.is_empty()));
    // Each point is its run's sitting: v0 then, v1 alone later.
    assert_eq!(
        first
            .iter()
            .map(|s| s.recalculated_report.rows[0].scored)
            .collect::<Vec<_>>(),
        vec![1, 1]
    );

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
    // v0 alone, then v1's fail, then v1's retest passes.
    assert_eq!(
        points
            .iter()
            .map(|s| s.recalculated_report.rows[0].points)
            .collect::<Vec<_>>(),
        vec![Some(1000), Some(0), Some(1000)]
    );
    assert_eq!(
        points[0].recalculated_report.rows[0].attempt_ids,
        first[0].recalculated_report.rows[0].attempt_ids
    );
    assert!(points.iter().all(|s| s.backfilled_version_ids.is_empty()));
    assert_eq!(
        points.last().unwrap().recalculated_report.rows[0].points,
        leaderboard(&data, &ResultQuery::default()).rows[0].points
    );
}

#[test]
fn a_retest_under_a_new_runtime_keeps_earlier_observations() {
    // A full retest, then a retest of v0..v2 only, after a CLI update; the
    // narrower retest is its own sitting and its three fails score 0.
    for (retested, expected) in [("v6", 0), ("v3", 0)] {
        let mut data = super::tests::dataset();
        let configuration = data.attempts[0].configuration.clone();
        data.attempts
            .retain(|a| a.run_id == "before" || a.version_id.as_str() < retested);
        for a in data.attempts.iter_mut().filter(|a| a.run_id == "after") {
            a.finished_at = Some(6);
            a.observed.as_mut().unwrap().inventory_revision = Some("new-runtime".into());
        }
        let points = history(&data, &configuration);
        assert_eq!(
            points
                .iter()
                .map(|p| p.recalculated_report.rows[0].points)
                .collect::<Vec<_>>(),
            vec![Some(1000), Some(expected)],
            "{retested}"
        );
        assert!(
            points.iter().all(|p| p.backfilled_version_ids.is_empty()),
            "{retested}"
        );
        // The earlier point keeps the cells observed then.
        assert_eq!(
            points[0].recalculated_report.rows[0].attempt_ids,
            points[0].report.rows[0].attempt_ids
        );
    }
}

#[test]
fn a_point_with_only_later_evidence_is_left_out_of_the_recalculated_series() {
    let mut data = super::tests::dataset();
    let configuration = data.attempts[0].configuration.clone();
    // Every case was republished before the second run measured it.
    for version in data.versions.clone() {
        let mut republished = version;
        republished.id = format!("{}b", republished.id);
        republished.published_at = 4;
        data.versions.push(republished);
    }
    for a in data.attempts.iter_mut().filter(|a| a.run_id == "after") {
        a.version_id = format!("{}b", a.version_id);
        a.finished_at = Some(6);
    }
    let points = history(&data, &configuration);
    assert_eq!(points.len(), 2);
    // The dated archive keeps the pool of its date.
    assert_eq!(points[0].report.rows[0].points, Some(1000));
    assert_eq!(points[0].report.rows[0].scored, 6);
    assert!(points[0].recalculated_report.rows.is_empty());
    assert_eq!(points[1].recalculated_report.rows[0].points, Some(0));
    assert!(points[1].backfilled_version_ids.is_empty());
}

#[test]
fn later_publications_and_archives_never_rewrite_the_dated_archive() {
    let mut data = super::tests::dataset();
    let configuration = data.attempts[0].configuration.clone();
    let recorded = |data: &QueryData| {
        history(data, &configuration)
            .into_iter()
            .map(|s| (s.created_at, serde_json::to_value(&s.report).unwrap()))
            .collect::<Vec<_>>()
    };
    let first = recorded(&data);
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].1["rows"][0]["points"], 1000);
    assert_eq!(first[0].1["rows"][0]["status"], "comparable");
    // After both runs d1 is republished, a seventh case joins and d0 is archived.
    let mut republished = data.versions[1].clone();
    republished.id = "v1b".into();
    republished.published_at = 10;
    let mut added = data.versions[0].clone();
    added.id = "v6".into();
    added.definition_id = "d6".into();
    added.published_at = 10;
    data.versions.extend([republished, added]);
    data.definitions.push(BenchmarkDefinition {
        id: "d0".into(),
        draft_revision: 2,
        archived: true,
        archived_at: None,
        archive_history: vec![],
        draft: data.versions[0].manifest.clone(),
        versions: vec![],
    });
    assert_eq!(recorded(&data), first);
    // Today's board uses today's pool and shows its gaps.
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!(row.missing_version_ids, vec!["v1b", "v6"]);
    assert_eq!(row.scored_version_ids, vec!["v2", "v3", "v4", "v5"]);
}

#[test]
fn a_review_on_the_current_output_never_rewrites_earlier_points() {
    for provenance in ["human_visual", "human"] {
        let mut data = super::tests::dataset();
        let configuration = data.attempts[0].configuration.clone();
        for a in &mut data.attempts {
            let passed = a.run_id == "before";
            if !passed {
                a.finished_at = Some(6);
            }
            a.evaluations.push(if passed {
                evaluation(2, Some(1.0), "objective", "pass")
            } else {
                evaluation(6, Some(0.0), "objective", "fail")
            });
        }
        let first = history(&data, &configuration);
        // A score-neutral note or an override that keeps the score.
        data.attempts
            .iter_mut()
            .find(|a| a.id == "after-v0")
            .unwrap()
            .evaluations
            .push(evaluation(7, Some(0.0), provenance, "fail"));
        let points = history(&data, &configuration);
        assert_eq!(
            points
                .iter()
                .map(|p| p.recalculated_report.rows[0].points)
                .collect::<Vec<_>>(),
            vec![Some(1000), Some(0)],
            "{provenance}"
        );
        assert!(
            points.iter().all(|p| p.backfilled_version_ids.is_empty()),
            "{provenance}"
        );
        // No duplicate point, and the series keeps its protocol.
        assert_eq!(points.len(), 2, "{provenance}");
        assert_eq!(
            points[1].report.rows[0].comparison_key,
            first[1].report.rows[0].comparison_key
        );
    }
}

#[test]
fn history_work_stops_once_the_shown_points_are_settled() {
    let mut calls = 0;
    // A hundred distinct observations, listed newest first.
    let kept = newest_observations((0..100).rev(), HISTORY_POINTS, |event| {
        calls += 1;
        Some((event.to_string(), event))
    });
    assert_eq!(kept, (76..100).collect::<Vec<_>>());
    assert_eq!(calls, HISTORY_POINTS + 1);
    // Equal neighbours keep their oldest event; events without a row are skipped.
    let signatures = ["a", "a", "b", "-", "b", "b", "a"];
    let kept = newest_observations((0..signatures.len()).rev(), 2, |i| {
        (signatures[i] != "-").then(|| (signatures[i].to_string(), i))
    });
    assert_eq!(kept, vec![2, 6]);
}

#[test]
fn incomplete_judge_batch_stays_unscored_and_judge_spend_is_not_the_candidates() {
    let mut a = before_only().attempts.remove(0);
    a.outcome = Some("judged".into());
    a.usage.cost = Some(1.0);
    let mut marker = evaluation(10, None, "render", "rendered");
    marker.details = Some(serde_json::json!({"expectedJudges":3}));
    // A legacy judge record carries no usage; the generation cost stays known.
    a.evaluations = vec![marker, evaluation(11, Some(0.8), "judge", "judged")];
    assert_eq!(score(&a), None);
    assert_eq!(mean_case_cost(&[&a], None), Some(1.0));
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
    // The panel's 0.3 stays on its evaluations, not on the candidate.
    assert_eq!(mean_case_cost(&[&a], None), Some(1.0));
    // An interrupted judge with partial usage changes neither.
    let mut interrupted = evaluation(14, None, "judge_failure", "abstained");
    interrupted.usage = Some(TokenUsage {
        cost: Some(0.01),
        ..Default::default()
    });
    interrupted.details = Some(serde_json::json!({"usageComplete": false}));
    a.evaluations.push(interrupted);
    assert_eq!(mean_case_cost(&[&a], None), Some(1.0));
    assert_eq!(score(&a), Some(0.8));
    a.outcome = Some("cancelled".into());
    assert_eq!(score(&a), None);
}

#[test]
fn judge_panels_never_reach_the_cost_board() {
    let mut data = before_only();
    for a in &mut data.attempts {
        a.usage.cost = Some(1.0);
    }
    add_candidate(&mut data, "other");
    // Only the first candidate drew an expensive, partly interrupted panel.
    for a in data.attempts.iter_mut().filter(|a| a.run_id == "before") {
        a.evaluations
            .push(evaluation(2, Some(1.0), "objective", "pass"));
        let mut judge = evaluation(5, None, "judge_failure", "abstained");
        judge.usage = Some(TokenUsage {
            cost: Some(4.0),
            ..Default::default()
        });
        judge.details = Some(serde_json::json!({"usageComplete": false}));
        a.evaluations.push(judge);
    }
    let rows = leaderboard(&data, &ResultQuery::default()).rows;
    assert_eq!(rows.len(), 2);
    for row in &rows {
        assert_eq!(row.cost, Some(1.0));
        assert_eq!(row.cost_share, Some(1.0));
    }
}

#[test]
fn a_retest_of_one_case_is_a_sitting_of_one_case() {
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
    // The retest stands alone: v0 failed, the other five are its gaps.
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!((row.scored, row.planned, row.points), (1, 6, Some(0)));
    assert_eq!(row.missing_version_ids.len(), 5);
    // With three required its one repetition is incomplete as well.
    data.required_repetitions = 3;
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!((row.scored, row.complete, row.passed), (1, 0, 0));
    assert_eq!(row.status, "preliminary");
}

#[test]
fn prepared_export_joins_current_cases_across_runs_and_masks_missing_cells() {
    let mut data = super::tests::dataset();
    // v0 was re-run later; every other case keeps its first cell.
    data.attempts
        .retain(|a| a.run_id == "before" || a.version_id == "v0");
    // A newer version of d2 has not been measured yet.
    let mut version = data.versions[2].clone();
    version.id = "new-version".into();
    version.published_at = 100;
    data.versions.push(version);
    let rows = crate::services::benchmarks::export::ledger_rows(&data, false, "test").unwrap();
    assert_eq!(rows.len(), 6);
    let cell =
        |id: &str| rows.iter().find(|r| r["taskVersion"] == id).unwrap()["matrix"][0].clone();
    let gap = cell("new-version");
    assert_eq!(gap["observed"], false);
    assert!(gap["reward"].is_null());
    // The newest settled cell wins, and one export mixes cells of both runs.
    let rerun = cell("v0");
    assert_eq!(rerun["runId"], "after");
    assert_eq!(rerun["reward"], 0.0);
    let retained = cell("v1");
    assert_eq!(retained["runId"], "before");
    assert_eq!(retained["reward"], 1.0);
    assert!(rows
        .iter()
        .all(|r| r["completeMatrix"] == (r["taskVersion"] != "new-version")));
}

#[test]
fn held_out_cases_stay_out_of_the_training_ledger() {
    let mut data = super::tests::dataset();
    data.versions[0].manifest.split = "held_out".into();
    let export = crate::services::benchmarks::export::ledger_rows;
    let rows = export(&data, false, "t").unwrap();
    assert_eq!(rows.len(), 5);
    assert!(rows.iter().all(|r| r["taskVersion"] != "v0"));
    let rows = export(&data, true, "t").unwrap();
    assert_eq!(rows.len(), 6);
    let held_out = rows.iter().find(|r| r["taskVersion"] == "v0").unwrap();
    assert_eq!(held_out["matrix"][0]["reward"], 0.0);
}

#[test]
fn a_shortened_task_budget_withholds_the_rank() {
    let mut data = before_only();
    data.versions[0].manifest.limits.timeout_seconds = 600;
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!((row.scored, row.planned), (6, 6));
    assert_eq!(row.status, "preliminary");
    assert!(row.reason.contains("shortened the published task budget"));
    data.runs[0].request.timeout_seconds = 600;
    assert_eq!(
        leaderboard(&data, &ResultQuery::default()).rows[0].status,
        "comparable"
    );
}

#[test]
fn only_a_candidate_with_a_different_eligible_set_loses_its_rank() {
    let mut data = before_only();
    add_candidate(&mut data, "other");
    for a in &mut data.attempts {
        a.usage.output = Some(100);
        a.usage.cost = Some(1.0);
    }
    let rows = leaderboard(&data, &ResultQuery::default()).rows;
    assert!(rows.iter().all(|r| r.status == "comparable"));
    // The first candidate helped author v0, so it answers five cases.
    data.versions[0].manifest.environment["authoredBy"] = serde_json::json!(["model"]);
    let rows = leaderboard(&data, &ResultQuery::default()).rows;
    let row = |model: &str| {
        rows.iter()
            .find(|r| r.configuration.model_id == model)
            .unwrap()
    };
    let (author, other) = (row("model"), row("other"));
    assert_eq!((other.scored, other.planned), (6, 6));
    assert_eq!(other.status, "comparable");
    assert_eq!(
        (other.speed_share, other.cost_share),
        (Some(1.0), Some(1.0))
    );
    assert_eq!((author.scored, author.planned), (5, 5));
    assert_eq!(author.status, "preliminary");
    assert!(author
        .reason
        .contains("eligible case set differs from the ranked pool"));
    // The unranked row is still scored against the record.
    assert_eq!(author.speed_share, Some(1.0));
}

#[test]
fn without_a_full_pool_row_the_most_shared_eligible_set_keeps_the_rank() {
    let mut data = before_only();
    add_candidate(&mut data, "model-b");
    add_candidate(&mut data, "other");
    data.versions[0].manifest.environment["authoredBy"] = serde_json::json!(["model"]);
    data.versions[1].manifest.environment["authoredBy"] = serde_json::json!(["other"]);
    let status = |data: &QueryData| {
        leaderboard(data, &ResultQuery::default())
            .rows
            .into_iter()
            .map(|r| (r.configuration.model_id, r.status))
            .collect::<BTreeMap<_, _>>()
    };
    let ranked = status(&data);
    assert_eq!(ranked["model"], "comparable");
    assert_eq!(ranked["model-b"], "comparable");
    assert_eq!(ranked["other"], "preliminary");
    // A tie goes to the larger set, then to the first set by case id.
    data.attempts.retain(|a| !a.id.starts_with("model-b-"));
    let ranked = status(&data);
    assert_eq!(ranked["other"], "comparable");
    assert_eq!(ranked["model"], "preliminary");
}

#[test]
fn relative_boards_keep_points_while_no_row_is_ranked() {
    let mut data = before_only();
    add_candidate(&mut data, "other");
    for a in &mut data.attempts {
        let slow = a.run_id != "before";
        a.duration_ms = Some(if slow { 200 } else { 100 });
        a.usage.output = Some(if slow { 400 } else { 100 });
        a.usage.cost = Some(if slow { 2.0 } else { 1.0 });
    }
    // Each candidate misses a different case, so neither has a rank yet.
    data.attempts
        .retain(|a| a.id != "before-v0" && a.id != "other-before-v1");
    let rows = leaderboard(&data, &ResultQuery::default()).rows;
    assert!(rows.iter().all(|r| r.status == "preliminary"));
    let points = |model: &str| {
        let row = rows
            .iter()
            .find(|r| r.configuration.model_id == model)
            .unwrap();
        (row.speed_share, row.cost_share, row.points)
    };
    assert_eq!(points("model"), (Some(1.0), Some(1.0), Some(1000)));
    // Twice the record on the four shared cases (0.8 + 0.15 / 2 + 0.05 / 2),
    // the record itself on the case only "other" solved.
    assert_eq!(points("other"), (Some(0.6), Some(0.6), Some(920)));
}

#[test]
fn a_ranked_row_without_a_metric_never_blanks_that_board() {
    let mut data = before_only();
    add_candidate(&mut data, "other");
    for a in &mut data.attempts {
        a.duration_ms = Some(100);
        a.usage.output = Some(100);
        a.usage.cost = Some(1.0);
    }
    // "other" misses a case, so "model" is the only ranked row.
    data.attempts.retain(|a| a.id != "other-before-v1");
    // The ranked row's spend is unknown and its tokens all include auxiliary calls.
    for a in data.attempts.iter_mut().filter(|a| a.run_id == "before") {
        a.usage.schema = "provider_turn_with_auxiliary_v2".into();
    }
    data.attempts
        .iter_mut()
        .find(|a| a.id == "before-v0")
        .unwrap()
        .usage
        .cost = None;
    let rows = leaderboard(&data, &ResultQuery::default()).rows;
    let row = |model: &str| {
        rows.iter()
            .find(|r| r.configuration.model_id == model)
            .unwrap()
    };
    let (model, other) = (row("model"), row("other"));
    assert_eq!(model.status, "comparable");
    // Unknown spend is never free; the cases with known spend still compare.
    assert_eq!((model.cost, model.cost_share), (None, Some(1.0)));
    assert_eq!(model.median_output_tokens, None);
    assert_eq!(other.status, "preliminary");
    assert_eq!(other.cost_share, Some(1.0));
    assert_eq!(
        (model.speed_share, other.speed_share),
        (Some(1.0), Some(1.0))
    );
}

#[test]
fn auxiliary_repetitions_stay_in_their_configurations_cell() {
    let mut data = before_only();
    data.runs[0].request.repetitions = 3;
    for a in &mut data.attempts {
        a.usage.output = Some(100);
    }
    let mut extra = Vec::new();
    for a in &data.attempts {
        for repetition in 1..3 {
            let mut a = a.clone();
            a.id = format!("{}-{repetition}", a.id);
            a.repetition = repetition;
            // The runner relabels repetitions that also called another model.
            if repetition > 0 {
                a.usage.schema = "provider_turn_with_auxiliary_v2".into();
                a.usage.output = Some(5000);
                a.observed.as_mut().unwrap().execution_profile = "native_text_auxiliary".into();
            }
            extra.push(a);
        }
    }
    data.attempts.extend(extra);
    data.required_repetitions = 3;
    let rows = leaderboard(&data, &ResultQuery::default()).rows;
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.status, "comparable");
    assert_eq!((row.scored, row.planned), (6, 6));
    assert_eq!(row.attempt_ids.len(), 18);
    // Catch-up pins this configuration, so it must stay runnable.
    assert_eq!(row.configuration.execution_profile, "native_text");
    // Auxiliary calls stay out of the pure token figure.
    assert_eq!(row.median_output_tokens, Some(100.0));
}

fn dated_points(data: &QueryData, configuration: &Configuration) -> Vec<(i64, Option<u32>)> {
    history(data, configuration)
        .iter()
        .map(|p| (p.created_at, p.report.rows[0].points))
        .collect()
}

fn recalculated_points(data: &QueryData, configuration: &Configuration) -> Vec<(i64, Option<u32>)> {
    history(data, configuration)
        .iter()
        .map(|p| (p.created_at, p.recalculated_report.rows[0].points))
        .collect()
}

#[test]
fn settled_cells_of_an_unfinished_or_cancelled_run_are_one_history_point() {
    for state in ["needs_attention", "running", "paused", "cancelled"] {
        let mut data = before_only();
        let configuration = data.attempts[0].configuration.clone();
        data.runs[0].state = state.into();
        // A cancel long after the cells settled never re-dates them.
        data.runs[0].updated_at = 200;
        // Ordinary evaluations made while the cells settled add no point.
        for a in &mut data.attempts {
            a.evaluations
                .push(evaluation(2, Some(1.0), "objective", "pass"));
        }
        let unchanged = {
            let mut data = data.clone();
            data.attempts[0]
                .evaluations
                .push(evaluation(50, Some(1.0), "objective", "pass"));
            data
        };
        let points = history(&unchanged, &configuration);
        assert_eq!(points.len(), 1, "{state}");
        assert_eq!(points[0].created_at, 2, "{state}");
        let board = leaderboard(&unchanged, &ResultQuery::default())
            .rows
            .remove(0);
        assert_eq!(board.points, Some(1000), "{state}");
        assert_eq!(points[0].report.rows[0].points, board.points, "{state}");
        assert_eq!(points[0].report.rows[0].attempt_ids, board.attempt_ids);
        // A later review restates the run's one point, which stays put.
        let mut reviewed = unchanged.clone();
        reviewed.attempts[0]
            .evaluations
            .push(evaluation(60, Some(0.4), "human", "fail"));
        assert_eq!(
            dated_points(&reviewed, &configuration),
            vec![(2, Some(1000))],
            "{state}"
        );
        assert_eq!(
            recalculated_points(&reviewed, &configuration),
            vec![(2, Some(833))],
            "{state}"
        );
        // So does a later objective re-evaluation that changes the score.
        data.attempts[0]
            .evaluations
            .push(evaluation(50, Some(0.0), "objective", "fail"));
        assert_eq!(
            recalculated_points(&data, &configuration),
            vec![(2, Some(833))],
            "{state}"
        );
    }
}

#[test]
fn cancelling_a_paused_run_keeps_its_settled_point() {
    let mut data = before_only();
    let configuration = data.attempts[0].configuration.clone();
    let paused = &mut data.runs[0];
    paused.state = "paused".into();
    paused.updated_at = 100;
    for a in &mut data.attempts {
        a.started_at = Some(90);
        a.finished_at = Some(100);
    }
    // v5 had not started when the run paused.
    let waiting = data
        .attempts
        .iter_mut()
        .find(|a| a.version_id == "v5")
        .unwrap();
    waiting.phase = "pending".into();
    waiting.outcome = None;
    waiting.started_at = None;
    waiting.finished_at = None;
    waiting.observed = None;
    waiting.output = None;
    // A catch-up run fills the gap later.
    let mut catch_up = data.runs[0].clone();
    catch_up.id = "catch-up".into();
    catch_up.state = "completed".into();
    catch_up.created_at = 110;
    catch_up.updated_at = 120;
    catch_up.request.version_ids = vec!["v5".into()];
    let mut filled = data
        .attempts
        .iter()
        .find(|a| a.version_id == "v0")
        .unwrap()
        .clone();
    filled.id = "catch-up-v5".into();
    filled.run_id = catch_up.id.clone();
    filled.version_id = "v5".into();
    filled.started_at = Some(112);
    filled.finished_at = Some(115);
    data.runs.push(catch_up);
    data.attempts.push(filled);
    let before_cancel = dated_points(&data, &configuration);
    assert_eq!(before_cancel, vec![(100, Some(1000)), (120, Some(1000))]);
    // The operator cancels the paused run much later.
    data.runs[0].state = "cancelled".into();
    data.runs[0].updated_at = 200;
    let waiting = data
        .attempts
        .iter_mut()
        .find(|a| a.run_id == "before" && a.version_id == "v5")
        .unwrap();
    waiting.phase = "terminal".into();
    waiting.outcome = Some("cancelled".into());
    waiting.finished_at = Some(200);
    assert_eq!(dated_points(&data, &configuration), before_cancel);
}

#[test]
fn a_running_retest_is_observed_before_it_completes() {
    let mut data = before_only();
    let configuration = data.attempts[0].configuration.clone();
    settled_retest(&mut data, "running", &["fail"]);
    // v0..v2 settled at 11; v3..v5 are still waiting.
    for a in data
        .attempts
        .iter_mut()
        .filter(|a| a.run_id == "retest" && a.version_id.as_str() >= "v3")
    {
        a.phase = "pending".into();
        a.outcome = None;
        a.started_at = None;
        a.finished_at = None;
    }
    let points = history(&data, &configuration);
    // The running retest is the sitting that stands: three fails so far.
    assert_eq!(
        points
            .iter()
            .map(|p| (p.created_at, p.report.rows[0].points))
            .collect::<Vec<_>>(),
        vec![(3, Some(1000)), (11, Some(0))]
    );
    // The newest point is the header's rating; the live board also lists
    // the repetitions still queued.
    let board = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!(
        points[1].report.rows[0].result_attempt_ids,
        board.result_attempt_ids
    );
    assert_eq!(points[1].report.rows[0].points, board.points);
    assert_eq!(board.attempt_ids.len(), 6);
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
    data.required_repetitions = 2;
    // The scored repetition is a measurement; the case is incomplete.
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!((row.scored, row.complete), (1, 0));
    assert_eq!(
        (row.points, row.status.as_str()),
        (Some(1000), "preliminary")
    );
}

#[test]
fn an_artifact_cap_failure_and_a_timeout_score_zero() {
    // The time limit is a safety stop of hours; a turn that reaches it failed
    // the task, and no later evaluation of what it left behind changes that.
    let mut timed_out = before_only().attempts.remove(0);
    timed_out.outcome = Some("budget_timeout".into());
    timed_out.evaluations = vec![evaluation(10, Some(1.0), "objective", "pass")];
    assert_eq!(score(&timed_out), Some(0.0));
    assert_eq!(score_as_of(&timed_out, Some(20)), Some(0.0));
    let mut a = before_only().attempts.remove(0);
    a.outcome = Some("budget_reached".into());
    // A legacy rescore of the partial output, recorded after the run.
    a.evaluations = vec![evaluation(10, Some(1.0), "objective", "pass")];
    assert_eq!(score(&a), Some(0.0));
    assert_eq!(score_as_of(&a, Some(3)), Some(0.0));
    assert_eq!(score_as_of(&a, Some(20)), Some(0.0));
    // A result that finished after the cutoff was not known then.
    assert_eq!(score_as_of(&a, Some(1)), None);
    assert_eq!(
        effective_outcome(a.outcome.as_deref(), &a.evaluations).as_deref(),
        Some("budget_reached")
    );
}

#[test]
fn an_unfinished_reevaluation_keeps_the_settled_panel() {
    let marker = |at: i64, judges: u64| {
        let mut e = evaluation(at, None, "render", "rendered");
        e.details = Some(serde_json::json!({"expectedJudges": judges}));
        e
    };
    let mut a = before_only().attempts.remove(0);
    a.outcome = Some("judged".into());
    a.evaluations = vec![
        evaluation(2, None, "objective", "pending_review"),
        marker(3, 2),
        evaluation(4, Some(0.6), "judge", "judged"),
        evaluation(5, Some(0.8), "judge", "judged"),
        // A later batch that stopped after one of its two votes.
        marker(10, 2),
        evaluation(11, Some(0.1), "judge", "judged"),
        evaluation(12, None, "judge_failure", "abstained"),
    ];
    assert_eq!(score(&a), Some(0.7));
    assert_eq!(
        effective_outcome(a.outcome.as_deref(), &a.evaluations).as_deref(),
        Some("judged")
    );
    // Before the first batch settled, the attempt was still waiting.
    assert_eq!(score_as_of(&a, Some(4)), None);
    assert_eq!(score_as_of(&a, Some(9)), Some(0.7));
    // The newest batch wins once it reaches its panel size.
    a.evaluations
        .push(evaluation(13, Some(0.3), "judge", "judged"));
    assert_eq!(score(&a), Some(0.2));
    // Only a panel that never completed leaves the attempt pending.
    a.evaluations.drain(1..4);
    assert_eq!(
        effective_outcome(a.outcome.as_deref(), &a.evaluations[..4]).as_deref(),
        Some("pending_review")
    );
}

#[test]
fn a_refused_selection_stays_with_the_requested_candidate() {
    let mut data = before_only();
    let mut refused = data.attempts[0].clone();
    refused.id = "refused".into();
    refused.run_id = "refused-run".into();
    refused.outcome = Some("selection_changed".into());
    refused.output = None;
    refused.observed.as_mut().unwrap().model_id = "default".into();
    let mut run = data.runs[0].clone();
    run.id = "refused-run".into();
    run.created_at = 10;
    run.updated_at = 11;
    data.runs.push(run);
    data.attempts.push(refused);
    let rows = leaderboard(&data, &ResultQuery::default()).rows;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].configuration.model_id, "model");
    // The refused run began, so it is the sitting that stands: all gaps.
    assert_eq!((rows[0].scored, rows[0].planned), (0, 6));
    assert_eq!(rows[0].points, None);
}

#[test]
fn a_recorded_archive_time_retires_the_case_from_that_date_on() {
    let mut data = super::tests::dataset();
    let dated = |data: &QueryData, at: i64| {
        pool(
            data,
            &ResultQuery {
                as_of: Some(at),
                ..Default::default()
            },
        )
        .iter()
        .any(|v| v.id == "v0")
    };
    data.definitions.push(BenchmarkDefinition {
        id: "d0".into(),
        draft_revision: 2,
        archived: true,
        archived_at: Some(20),
        archive_history: vec![],
        draft: data.versions[0].manifest.clone(),
        versions: vec![],
    });
    // The last run that planned d0 ended at 6; d0 was archived at 20.
    assert!(dated(&data, 10));
    assert!(dated(&data, 19));
    assert!(!dated(&data, 20));
    assert!(!pool(&data, &ResultQuery::default())
        .iter()
        .any(|v| v.id == "v0"));
    // Without a recorded time the last planning run bounds it.
    data.definitions[0].archived_at = None;
    assert!(dated(&data, 6));
    assert!(!dated(&data, 10));
    // Restored at 30: the archive period still holds for dates inside it.
    let definition = &mut data.definitions[0];
    definition.archived = false;
    definition.archived_at = None;
    definition.archive_history = vec![(20, 30)];
    assert!(dated(&data, 19));
    assert!(!dated(&data, 20));
    assert!(!dated(&data, 29));
    assert!(dated(&data, 30));
    assert!(pool(&data, &ResultQuery::default())
        .iter()
        .any(|v| v.id == "v0"));
    // Archived again at 40 after the restore.
    data.definitions[0].archived = true;
    data.definitions[0].archived_at = Some(40);
    assert!(!dated(&data, 25));
    assert!(dated(&data, 35));
    assert!(!dated(&data, 40));
}

#[test]
fn a_display_id_never_splits_a_leaderboard_row() {
    let mut data = super::tests::dataset();
    for a in data.attempts.iter_mut().filter(|a| a.run_id == "after") {
        a.configuration.id = "relabelled".into();
        a.observed.as_mut().unwrap().id = "relabelled-observed".into();
    }
    let rows = leaderboard(&data, &ResultQuery::default()).rows;
    assert_eq!(rows.len(), 1);
    assert!(rows[0]
        .attempt_ids
        .iter()
        .all(|id| id.starts_with("after-")));
}

/// Keeps the "before" cells of v1..v5 and only the "retest" cell of v0.
fn retest_only_v0(data: &mut QueryData) {
    data.attempts.retain(|a| {
        if a.run_id == "before" {
            a.version_id != "v0"
        } else {
            a.version_id == "v0"
        }
    });
}

#[test]
fn a_cell_that_never_ran_leaves_the_cost_and_the_date_alone() {
    let mut data = before_only();
    let configuration = data.attempts[0].configuration.clone();
    // The run was cancelled before v0 started; nobody scored v0 before.
    settled_retest(&mut data, "cancelled", &["cancelled"]);
    retest_only_v0(&mut data);
    for a in data.attempts.iter_mut().filter(|a| a.run_id == "before") {
        a.usage.cost = Some(1.0);
    }
    let row = leaderboard(&data, &ResultQuery::default()).rows.remove(0);
    assert_eq!(row.missing_version_ids, vec!["v0"]);
    assert_eq!(row.cost, Some(1.0));
    assert_eq!(row.cost_share, Some(1.0));
    assert_eq!(row.measured_at, Some(2));
    assert!(row.attempt_ids.iter().all(|id| !id.starts_with("retest-")));
    // The cancellation changes nothing, so it adds no point of its own.
    assert_eq!(history(&data, &configuration).len(), 1);
}

#[test]
fn only_repetitions_that_ran_carry_spend() {
    let mut data = before_only();
    settled_retest(&mut data, "cancelled", &["pass", "cancelled"]);
    retest_only_v0(&mut data);
    for a in &mut data.attempts {
        a.usage.cost = match (a.run_id.as_str(), a.repetition) {
            ("before", _) => Some(1.0),
            (_, 0) => Some(2.0),
            _ => None,
        };
    }
    let cost = |data: &QueryData| leaderboard(data, &ResultQuery::default()).rows[0].cost;
    // The retest stands alone with v0: its paid repetition counts and the
    // cancelled one, never started, spent nothing.
    assert!((cost(&data).unwrap() - 2.0).abs() < 1e-9);
    // With that repetition's spend unknown the row's spend is unknown too,
    // never free.
    data.attempts
        .iter_mut()
        .find(|a| a.run_id == "retest" && a.repetition == 0)
        .unwrap()
        .usage
        .cost = None;
    assert_eq!(cost(&data), None);
}

/// A newer run "refused-run" holding one refused attempt on v0 whose session
/// acknowledged `effort` and `fast_mode`.
fn refuse(data: &mut QueryData, effort: Option<&str>, fast_mode: Option<bool>) {
    let mut refused = data.attempts[0].clone();
    refused.id = "refused".into();
    refused.run_id = "refused-run".into();
    refused.outcome = Some("selection_changed".into());
    refused.output = None;
    refused.finished_at = Some(11);
    let observed = refused.observed.as_mut().unwrap();
    observed.effort = effort.map(str::to_owned);
    observed.fast_mode = fast_mode;
    let mut run = data.runs[0].clone();
    run.id = "refused-run".into();
    run.created_at = 10;
    run.updated_at = 11;
    data.runs.push(run);
    data.attempts.push(refused);
}

#[test]
fn a_refused_effort_or_fast_mode_stays_with_the_requested_candidate() {
    // The candidate asked for effort "medium" without fast mode.
    for (effort, fast_mode) in [(Some("high"), Some(false)), (Some("medium"), Some(true))] {
        let mut data = before_only();
        refuse(&mut data, effort, fast_mode);
        let rows = leaderboard(&data, &ResultQuery::default()).rows;
        assert_eq!(rows.len(), 1, "{effort:?} {fast_mode:?}");
        let row = &rows[0];
        assert_eq!(row.configuration.effort.as_deref(), Some("medium"));
        assert_eq!(row.configuration.fast_mode, Some(false));
        assert_eq!((row.scored, row.planned), (0, 6));
        assert_eq!(row.points, None);
    }
    // Where the request left effort to the provider, the acknowledged one stays.
    let mut data = before_only();
    refuse(&mut data, Some("medium"), Some(true));
    data.attempts.last_mut().unwrap().configuration.effort = None;
    assert_eq!(leaderboard(&data, &ResultQuery::default()).rows.len(), 1);
}

#[test]
fn a_refused_sibling_never_blocks_the_cell_it_was_mistaken_for() {
    let mut data = before_only();
    let off = data.runs[0].request.configurations[0].clone();
    let mut on = off.clone();
    on.id = "fast".into();
    on.fast_mode = Some(true);
    let mut run = data.runs[0].clone();
    run.id = "sibling".into();
    run.created_at = 10;
    run.updated_at = 11;
    run.request.configurations = vec![off.clone(), on.clone()];
    let mut extra = Vec::new();
    for a in data.attempts.iter().filter(|a| a.run_id == "before") {
        let mut failed = a.clone();
        failed.id = format!("sibling-off-{}", a.version_id);
        failed.run_id = run.id.clone();
        failed.outcome = Some("fail".into());
        failed.finished_at = Some(11);
        // The fast request's session acknowledged fast mode off and was refused.
        let mut refused = failed.clone();
        refused.id = format!("sibling-on-{}", a.version_id);
        refused.configuration = on.clone();
        refused.observed = Some(off.clone());
        refused.outcome = Some("selection_changed".into());
        refused.output = None;
        extra.extend([failed, refused]);
    }
    data.runs.push(run);
    data.attempts.extend(extra);
    let rows = leaderboard(&data, &ResultQuery::default()).rows;
    let row = |fast: bool| {
        rows.iter()
            .find(|r| r.configuration.fast_mode == Some(fast))
            .unwrap()
    };
    // The newer run's fast-off cells settle and replace the earlier passes.
    let off_row = row(false);
    assert_eq!(off_row.points, Some(0));
    assert!(off_row
        .attempt_ids
        .iter()
        .all(|id| id.starts_with("sibling-off-")));
    // The refused request stays with the fast candidate that was asked for.
    assert_eq!(row(true).scored, 0);
}

/// Starts a batch on every attempt of `run_id` under `protocol` that only one
/// of its two judges answered.
fn reevaluate(data: &mut QueryData, run_id: &str, protocol: &str) {
    for a in data.attempts.iter_mut().filter(|a| a.run_id == run_id) {
        let mut marker = evaluation(7, None, "render", "rendered");
        marker.details = Some(serde_json::json!({"expectedJudges": 2, "protocolHash": protocol}));
        a.evaluations.push(marker);
        a.evaluations
            .push(evaluation(8, Some(0.5), "judge", "judged"));
    }
}

#[test]
fn the_protocol_that_scored_identifies_the_evaluator() {
    let mut data = super::tests::dataset();
    judge_run(&mut data, "before", Some("panel-a"), 1.0);
    judge_run(&mut data, "after", Some("panel-a"), 0.0);
    let query = ResultQuery::default();
    let key = leaderboard(&data, &query).rows[0].comparison_key.clone();
    // An unfinished panel-b batch changes neither the score nor its protocol.
    reevaluate(&mut data, "after", "panel-b");
    let row = leaderboard(&data, &query).rows.remove(0);
    assert_eq!(row.points, Some(0));
    assert_eq!(row.comparison_key, key);
    // A follow-up scored by panel-b stays another evaluator, whatever started later.
    judge_run(&mut data, "after", Some("panel-b"), 0.0);
    reevaluate(&mut data, "after", "panel-a");
    assert_ne!(leaderboard(&data, &query).rows[0].comparison_key, key);
}

#[test]
fn a_refusal_before_any_session_stays_on_the_row_its_run_acknowledged() {
    let mut data = before_only();
    data.runs[0].state = "running".into();
    // The run dialog sends no effort; the sessions acknowledged "high".
    data.runs[0].request.configurations[0].effort = None;
    for a in &mut data.attempts {
        a.configuration.effort = None;
        a.observed.as_mut().unwrap().effort = Some("high".into());
    }
    // The runtime changed mid-run: v5 was refused before a session existed,
    // and v4 is still waiting.
    let refused = data
        .attempts
        .iter_mut()
        .find(|a| a.version_id == "v5")
        .unwrap();
    refused.outcome = Some("selection_changed".into());
    refused.observed = None;
    refused.output = None;
    let waiting = data
        .attempts
        .iter_mut()
        .find(|a| a.version_id == "v4")
        .unwrap();
    waiting.phase = "pending".into();
    waiting.outcome = None;
    waiting.started_at = None;
    waiting.finished_at = None;
    waiting.observed = None;
    waiting.output = None;
    let rows = leaderboard(&data, &ResultQuery::default()).rows;
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    // The refusal is the row's newest attempt, so it also names the row.
    assert_eq!(row.configuration.effort.as_deref(), Some("high"));
    assert_eq!((row.scored, row.attempted, row.planned), (4, 5, 6));
    assert_eq!(row.missing_version_ids, vec!["v4", "v5"]);
    let points = history(&data, &row.configuration);
    assert!(!points.is_empty());
    assert!(points.iter().all(|p| p.report.rows.len() == 1));
}

/// A cell scored after a point is a gap at that point, and one repetition
/// short of the required count never counts at any point.
#[test]
fn later_and_partial_cells_stay_gaps_at_earlier_points() {
    let mut data = before_only();
    let configuration = data.attempts[0].configuration.clone();
    let v5 = data
        .attempts
        .iter()
        .find(|a| a.version_id == "v5")
        .unwrap()
        .clone();
    data.attempts.retain(|a| a.version_id != "v5");
    // "partial" left v5 one repetition short; "catch-up" measured it later.
    for (id, created_at, repetitions, outcome, finished_at) in
        [("partial", 4, 2, "fail", 6), ("catch-up", 5, 1, "pass", 10)]
    {
        let mut run = data.runs[0].clone();
        run.id = id.into();
        run.created_at = created_at;
        run.updated_at = finished_at + 1;
        run.request.repetitions = repetitions;
        run.request.version_ids = vec!["v5".into()];
        data.runs.push(run);
        let mut a = v5.clone();
        a.id = format!("{id}-v5");
        a.run_id = id.into();
        a.outcome = Some(outcome.into());
        a.started_at = Some(finished_at - 1);
        a.finished_at = Some(finished_at);
        data.attempts.push(a);
    }
    data.required_repetitions = 2;
    let points = history(&data, &configuration);
    let at = |time: i64| {
        points
            .iter()
            .find(|p| p.created_at == time)
            .map(|p| p.recalculated_report.rows[0].clone())
            .unwrap()
    };
    // Each run is a point of its own sitting.
    assert_eq!(
        points.iter().map(|p| p.created_at).collect::<Vec<_>>(),
        vec![3, 7, 11]
    );
    // The first point had five cases finished; v5 is its gap.
    let first = at(3);
    assert_eq!((first.scored, first.planned), (5, 6));
    assert_eq!(first.missing_version_ids, vec!["v5"]);
    assert!(first.attempt_ids.iter().all(|id| !id.ends_with("-v5")));
    // The run that left v5 one repetition short stands as it was: v5
    // measured, incomplete, and the other five its gaps.
    let partial = at(7);
    assert_eq!(partial.attempt_ids, vec!["partial-v5".to_string()]);
    assert_eq!(
        (partial.scored, partial.complete, partial.planned),
        (1, 0, 6)
    );
    // The later run of v5 alone is a sitting of v5 alone.
    let later = at(11);
    assert_eq!(later.attempt_ids, vec!["catch-up-v5".to_string()]);
    assert_eq!(
        (later.scored, later.complete, later.points),
        (1, 0, Some(1000))
    );
    assert!(points.iter().all(|p| p.backfilled_version_ids.is_empty()));
}
