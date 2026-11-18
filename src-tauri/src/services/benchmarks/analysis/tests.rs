use super::*;

fn selection(model: &str, effort: Option<&str>, fast: Option<bool>) -> Configuration {
    serde_json::from_value(serde_json::json!({
        "id": format!("codex-acp:account-1:{model}"),
        "providerId": "codex-acp",
        "accountId": "account-1",
        "modelId": model,
        "effort": effort,
        "fastMode": fast,
        "billingMode": "subscription",
        "executionProfile": "native_text",
        "inventoryRevision": "runtime-now",
    }))
    .expect("an invented configuration")
}

#[test]
fn a_refused_selection_names_the_bridges_own_refusal_first() {
    let requested = selection("gpt-6-luna", Some("medium"), Some(false));
    let observed = selection("gpt-6-sol", Some("medium"), Some(false));
    let refusal = selection_refusal(
        &requested,
        &observed,
        &[serde_json::json!({
            "role": "model",
            "requested": "gpt-6-luna",
            "applied": "gpt-6-sol",
            "reason": "Invalid params",
        })],
    );
    assert_eq!(
        refusal,
        format!("{SELECTION_REFUSED}: the model gpt-6-luna was refused (Invalid params); gpt-6-sol would have run instead")
    );
    let nothing = selection_refusal(
        &requested,
        &observed,
        &[
            serde_json::json!({ "role": "model", "requested": "gpt-6-luna", "applied": null, "reason": "" }),
        ],
    );
    assert!(
        nothing.ends_with("the model gpt-6-luna was refused; nothing would have run in its place")
    );
}

#[test]
fn a_selection_that_came_back_different_names_each_field() {
    let requested = selection("gpt-6-sol", Some("xhigh"), Some(true));
    let observed = selection("gpt-6-astra", Some("medium"), None);
    assert_eq!(
        selection_refusal(&requested, &observed, &[]),
        format!("{SELECTION_REFUSED}: asked for model gpt-6-sol, the provider acknowledged gpt-6-astra; asked for effort xhigh, acknowledged medium; asked for fast mode on, acknowledged none")
    );
    // An acknowledged selection with no difference and no refusal keeps
    // the bare sentence rather than inventing a detail.
    assert_eq!(
        selection_refusal(&requested, &requested, &[]),
        SELECTION_REFUSED
    );
    let silent = selection("", None, None);
    assert!(selection_refusal(&requested, &silent, &[])
        .contains("asked for model gpt-6-sol, the provider acknowledged none"));
}

#[test]
fn a_panel_that_samples_each_seat_counts_each_seat_once_at_its_median() {
    let evaluation = |provenance: &str,
                      score: Option<f64>,
                      judge: Option<&str>,
                      details: serde_json::Value|
     -> Evaluation {
        serde_json::from_value(serde_json::json!({"id": uuid::Uuid::new_v4().to_string(),
            "evaluatorRevision": "invented-v1", "verdict": "judged", "score": score,
            "reason": "", "createdAt": 1, "provenance": provenance, "details": details,
            "judge": judge.map(|model| serde_json::json!({"id": model, "providerId": "invented-acp",
                "accountId": "invented-account", "modelId": model, "effort": null, "fastMode": false,
                "billingMode": "subscription", "executionProfile": "native_text",
                "inventoryRevision": "invented-runtime"}))}))
        .unwrap()
    };
    let marker = |samples: u64, expected: u64| {
        evaluation(
            "render",
            None,
            None,
            serde_json::json!({"judgeBatchId": "invented-batch", "expectedJudges": expected,
                "protocol": {"samplesPerJudge": samples}}),
        )
    };
    let seat_votes = |seat: &str, scores: &[f64]| -> Vec<Evaluation> {
        scores
            .iter()
            .map(|score| evaluation("judge", Some(*score), Some(seat), serde_json::json!({})))
            .collect()
    };
    let mut sampled = vec![marker(3, 6)];
    sampled.extend(seat_votes("seat-a", &[0.2, 0.8, 0.9]));
    sampled.extend(seat_votes("seat-b", &[0.5, 0.1, 0.5]));
    let Panel::Settled { mut votes, .. } = judge_panel(&sampled.iter().collect::<Vec<_>>()) else {
        panic!("a full sampled panel settles");
    };
    votes.sort_by(f64::total_cmp);
    assert_eq!(votes, vec![0.5, 0.8]);
    // Short of its samples, it waits.
    sampled.pop();
    assert!(matches!(
        judge_panel(&sampled.iter().collect::<Vec<_>>()),
        Panel::Pending
    ));
    // One sample a seat counts every vote, as before.
    let mut single = vec![marker(1, 2)];
    single.extend(seat_votes("seat-a", &[0.2]));
    single.extend(seat_votes("seat-b", &[0.9]));
    let Panel::Settled { votes, .. } = judge_panel(&single.iter().collect::<Vec<_>>()) else {
        panic!("a full panel settles");
    };
    assert_eq!(votes, vec![0.2, 0.9]);
}
#[test]
fn points_share_one_scale() {
    assert_eq!(share_points(0.929), 929);
    assert_eq!(share_points(1.2), 1000);
    assert_eq!(share_of_record(Some(2000.0), Some(2000.0)), Some(1.0));
    assert_eq!(share_of_record(Some(2000.0), Some(10_000.0)), Some(0.2));
    assert_eq!(share_of_record(Some(2000.0), Some(0.0)), Some(1.0));
    assert_eq!(share_of_record(None, Some(2000.0)), None);
}
/// Speed compares a solve with solves of its case in the same admission
/// band only: none, one or two, three or more CPU-heavy jobs beside it,
/// or no recorded admission. A cell takes its most loaded repetition's
/// band. Cost compares across bands, and a solve with no spend at all is
/// no price to beat.
#[test]
fn speed_compares_within_the_admission_band_and_cost_across_bands() {
    let data = dataset();
    let runs: BTreeMap<&str, &BenchmarkRun> =
        data.runs.iter().map(|run| (run.id.as_str(), run)).collect();
    let base = data
        .attempts
        .iter()
        .find(|a| a.id == "before-v0")
        .unwrap()
        .clone();
    let admitted = |heavy: u32| {
        serde_json::from_value(serde_json::json!({
            "lane":"heavy","competing":{},"competingHeavy":heavy,"reservedMemory":0,
            "reservedCpu":0,"memoryCurrent":0,"guestLoad":[0.0,0.0,0.0],"guestCpus":16,
            "guestMemAvailable":0,"hostAvailableRam":0,"hostAvailableCommit":0
        }))
        .unwrap()
    };
    let solve = |model: &str, repetition: u32, heavy: Option<u32>, ms: u64, cost: f64| {
        let mut attempt = base.clone();
        attempt.id = format!("{model}-{repetition}");
        attempt.configuration.model_id = model.into();
        attempt.observed = Some(attempt.configuration.clone());
        attempt.repetition = repetition;
        attempt.duration_ms = Some(ms);
        attempt.usage.cost = Some(cost);
        attempt.sandbox_admission = heavy.map(admitted);
        attempt
    };
    let attempts = vec![
        solve("alone", 0, Some(0), 60_000, 1.0),
        solve("alone", 1, Some(0), 60_000, 1.0),
        solve("crowded", 0, Some(5), 180_000, 3.0),
        solve("crowded", 1, Some(3), 180_000, 3.0),
        solve("mixed", 0, Some(0), 120_000, 2.0),
        solve("mixed", 1, Some(2), 120_000, 2.0),
        solve("unrecorded", 0, None, 240_000, 0.0),
        solve("unrecorded", 1, Some(0), 240_000, 0.0),
    ];
    let protocol = CaseProtocol {
        required: &|_| 2,
        graded: &|_| false,
    };
    let records = case_records(&attempts, &runs, None, protocol);
    let cell = |model: &str| {
        let list: Vec<&Attempt> = attempts
            .iter()
            .filter(|a| a.configuration.model_id == model)
            .collect();
        case_cells(&list, None, protocol)["v0"]
    };
    let share = |model: &str| {
        let cell = cell(model);
        case_points(&cell, record_of(&records, "v0", &cell))
    };
    // The fast solve on an idle sandbox and the slow one beside three or
    // more heavy jobs each set their band's record.
    assert_eq!(cell("alone").band, 0);
    assert_eq!(cell("crowded").band, 2);
    assert_eq!(share("alone").speed, Some(1.0));
    assert_eq!(share("crowded").speed, Some(1.0));
    // A cell spanning bands takes the most loaded one.
    assert_eq!(cell("mixed").band, 1);
    // No recorded admission is a band of its own, whatever its other
    // repetitions recorded.
    assert_eq!(cell("unrecorded").band, BAND_UNRECORDED);
    assert_eq!(share("unrecorded").speed, Some(1.0));
    // Cost compares across bands; the spend-free solve sets no record.
    for model in ["alone", "crowded", "mixed", "unrecorded"] {
        let record = record_of(&records, "v0", &cell(model)).unwrap();
        assert_eq!(record.1, Some(1.0), "{model}");
    }
    // A solved cell whose band holds no record (its repetitions part of
    // a more loaded cell, as after an account move) compares with the
    // nearest more loaded band's record, and its cost with the case's
    // cheapest solve.
    let crowded: Vec<Attempt> = attempts
        .iter()
        .filter(|a| a.configuration.model_id == "crowded")
        .cloned()
        .collect();
    let fewer = case_records(&crowded, &runs, None, protocol);
    let idle = cell("alone");
    assert_eq!(
        record_of(&fewer, "v0", &idle),
        Some((Some(180_000.0), Some(3.0)))
    );
    assert_eq!(
        case_points(&idle, record_of(&fewer, "v0", &idle)).speed,
        Some(1.0)
    );
    // Slower than that record, it reads below it, as the row does.
    let slow = CaseCell {
        duration_ms: Some(360_000.0),
        ..idle
    };
    assert_eq!(
        case_points(&slow, record_of(&fewer, "v0", &slow)).speed,
        Some(0.5)
    );
    // Only a record in a less loaded band leaves the cell alone in its own.
    let mixed: Vec<Attempt> = attempts
        .iter()
        .filter(|a| a.configuration.model_id == "alone")
        .cloned()
        .collect();
    let quiet = case_records(&mixed, &runs, None, protocol);
    let busy = cell("crowded");
    assert_eq!(
        record_of(&quiet, "v0", &busy),
        Some((Some(180_000.0), Some(1.0)))
    );
    assert_eq!(share("crowded").cost, Some(1.0 / 3.0));
    assert_eq!(share("mixed").cost, Some(0.5));
}
/// A solved case: reliability outweighs speed and cost, and a missing
/// measurement gives up its weight instead of counting as the worst.
#[test]
fn a_case_scores_reliability_then_speed_then_cost() {
    let cell = |reward, duration_ms, cost| CaseCell {
        reward,
        duration_ms,
        cost,
        repetitions: 3,
        complete: true,
        band: 0,
    };
    let record = (Some(60_000.0), Some(140.0));
    let points = |c: &CaseCell| case_points(c, Some(record)).points;
    assert_eq!(points(&cell(1.0, Some(60_000.0), Some(140.0))), 1.0);
    let slower = points(&cell(1.0, Some(180_000.0), Some(300.0)));
    assert!((slower - (0.8 + 0.15 / 3.0 + 0.05 * 140.0 / 300.0)).abs() < 1e-9);
    assert_eq!(points(&cell(0.0, Some(1.0), Some(0.01))), 0.0);
    // Unknown cost: reliability and speed share the weight.
    let unknown = points(&cell(1.0, Some(120_000.0), None));
    assert!((unknown - (0.8 + 0.15 * 0.5) / 0.95).abs() < 1e-9);
    assert_eq!(points(&cell(1.0, None, None)), 1.0);
    // A judged case keeps its graded reward.
    assert!((points(&cell(0.5, None, None)) - 0.5).abs() < 1e-9);
}
/// A cell needs every required repetition scored, every one passing.
#[test]
fn a_cell_passes_only_when_every_repetition_passes() {
    let data = dataset();
    let base = &data.attempts[0];
    let attempt = |id: &str, repetition: u32, outcome: &str| Attempt {
        id: id.into(),
        repetition,
        outcome: Some(outcome.into()),
        ..base.clone()
    };
    let three = |outcomes: [&str; 3]| {
        [
            attempt("a", 0, outcomes[0]),
            attempt("b", 1, outcomes[1]),
            attempt("c", 2, outcomes[2]),
        ]
    };
    let objective = CaseProtocol {
        required: &|_| 3,
        graded: &|_| false,
    };
    let graded = CaseProtocol {
        required: &|_| 3,
        graded: &|_| true,
    };
    fn cells<'a>(list: &'a [Attempt], protocol: CaseProtocol<'_>) -> BTreeMap<&'a str, CaseCell> {
        case_cells(&list.iter().collect::<Vec<_>>(), None, protocol)
    }
    let reward = |list: &[Attempt], protocol| cells(list, protocol).get("v0").map(|c| c.reward);
    assert_eq!(
        reward(&three(["pass", "pass", "pass"]), objective),
        Some(1.0)
    );
    assert_eq!(
        reward(&three(["pass", "fail", "pass"]), objective),
        Some(0.0)
    );
    assert_eq!(
        reward(&three(["pass", "budget_timeout", "pass"]), objective),
        Some(0.0)
    );
    // A graded case averages its repetitions instead.
    let graded_reward = reward(&three(["pass", "fail", "pass"]), graded).unwrap();
    assert!((graded_reward - 2.0 / 3.0).abs() < 1e-9);
    // Fewer repetitions than required is a cell still, incomplete; an
    // unscored repetition is left out of it.
    let passes = three(["pass", "pass", "pass"]);
    let partial = cells(&passes[..2], objective);
    assert_eq!((partial["v0"].reward, partial["v0"].complete), (1.0, false));
    let one_cancelled = three(["pass", "pass", "cancelled"]);
    let short = cells(&one_cancelled, objective);
    assert_eq!((short["v0"].repetitions, short["v0"].complete), (2, false));
    let full = cells(&passes, objective);
    assert_eq!((full["v0"].repetitions, full["v0"].complete), (3, true));
    // Missing timing is not an unusually fast repetition. The outcome
    // remains complete, but its latency cannot enter a comparison.
    let mut incomplete_timing = passes;
    incomplete_timing[1].duration_ms = None;
    let measured = cells(&incomplete_timing, objective);
    assert_eq!(measured["v0"].duration_ms, None);
    assert!(measured["v0"].complete);
}
#[test]
fn null_cost_is_not_free() {
    let data = dataset();
    let mut first = data.attempts[0].clone();
    let mut repeat = first.clone();
    repeat.id = "repeat".into();
    repeat.repetition = 1;
    let mut other = data.attempts[1].clone();
    first.usage.cost = Some(1.0);
    other.usage.cost = Some(5.0);
    // An unknown repetition or an unknown case makes the mean unknown.
    assert_eq!(mean_case_cost(&[&first, &repeat, &other], None), None);
    assert_eq!(mean_case_cost(&[&first, &other, &repeat], None), None);
    repeat.usage.cost = Some(3.0);
    // Repetitions average within their case first: ((1 + 3) / 2 + 5) / 2.
    let cost = mean_case_cost(&[&first, &repeat, &other], None).unwrap();
    assert!((cost - 3.5).abs() < 1e-10);
    // Spend reported after the cutoff was not known at it.
    assert_eq!(mean_case_cost(&[&first], Some(1)), None);
    assert_eq!(mean_case_cost(&[&first], Some(2)), Some(1.0));
}

pub fn dataset() -> QueryData {
    let config = Configuration {
        id: "claude:private-account:model".into(),
        provider_id: "claude".into(),
        account_id: Some("private-account".into()),
        model_id: "model".into(),
        effort: Some("medium".into()),
        fast_mode: Some(false),
        billing_mode: "subscription".into(),
        execution_profile: "native_text".into(),
        inventory_revision: Some("runtime-hash".into()),
        model_name: None,
    };
    let versions = (0..6)
        .map(|index| {
            let mut manifest = super::super::seeds::definitions().remove(0);
            manifest.split = "train".into();
            manifest.task_family = format!("family-{index}");
            BenchmarkVersion {
                id: format!("v{index}"),
                definition_id: format!("d{index}"),
                content_hash: format!("hash{index}"),
                published_at: 1,
                manifest,
                carries_from: None,
            }
        })
        .collect::<Vec<_>>();
    let request = RunRequest {
        author_policy: None,
        request_key: "request".into(),
        version_ids: versions.iter().map(|v| v.id.clone()).collect(),
        configurations: vec![config.clone()],
        repetitions: 1,
        timeout_seconds: 120,
        max_executions: 6,
        preview: false,
        parallelism: None,
        execution_limits: None,
        workflow_policy: None,
    };
    let attempts = |run: &str, outcome: &str| {
        versions
            .iter()
            .map(|version| Attempt {
                pre_answer_refusals: 0,
                infrastructure_retries: 0,
                id: format!("{run}-{}", version.id),
                run_id: run.into(),
                version_id: version.id.clone(),
                configuration: config.clone(),
                repetition: 0,
                phase: "terminal".into(),
                outcome: Some(outcome.into()),
                reason: None,
                wait_until: None,
                session_id: Some(format!("session-{run}-{}", version.id)),
                host_run_id: None,
                observed: Some(config.clone()),
                started_at: Some(1),
                finished_at: Some(2),
                duration_ms: Some(100),
                output: Some("private output".into()),
                evidence_hash: Some("sealed".into()),
                usage: TokenUsage::default(),
                evaluations: vec![],
                event_cursor: 1,
                workflow_steps: Vec::new(),
                native_execution_ms: None,
                resolved_model: None,
                repository_result: None,
                collection_context: None,
                sandbox_admission: None,
                account_load: None,
                phase_times: None,
                activity: None,
                credit_use: None,
            })
            .collect::<Vec<_>>()
    };
    let before = attempts("before", "pass");
    let after = attempts("after", "fail");
    let runs = vec![
        BenchmarkRun {
            id: "before".into(),
            state: "completed".into(),
            revision: 1,
            created_at: 2,
            updated_at: 3,
            baked_at: None,
            paused_ms: 0,
            paused_since: None,
            request: request.clone(),
            attempts: vec![],
        },
        BenchmarkRun {
            id: "after".into(),
            state: "completed".into(),
            revision: 1,
            created_at: 5,
            updated_at: 6,
            baked_at: None,
            paused_ms: 0,
            paused_since: None,
            request: request.clone(),
            attempts: vec![],
        },
    ];
    QueryData {
        releases: Vec::new(),
        definitions: vec![],
        versions,
        runs,
        attempts: before.into_iter().chain(after).collect(),
        // The fixtures measure one repetition per case; the product
        // protocol of `REQUIRED_REPETITIONS` has its own tests.
        required_repetitions: 1,
    }
}
/// A case published at `at` whose family no run has measured yet.
fn add_case(data: &mut QueryData, index: usize, at: i64) {
    let mut version = data.versions[0].clone();
    version.id = format!("v{index}");
    version.definition_id = format!("d{index}");
    version.published_at = at;
    version.manifest.task_family = format!("family-{index}");
    data.versions.push(version);
}
fn standing(data: &QueryData) -> LeaderboardRow {
    let report = leaderboard(data, &ResultQuery::default());
    assert_eq!(report.rows.len(), 1);
    report.rows[0].clone()
}
/// A row names its complete suite cases by their current version, so a
/// run owes exactly what the board lacks: a cell carried from an earlier
/// version counts for the version that carries it.
#[test]
fn a_row_names_its_complete_cases_by_their_current_version() {
    let mut data = dataset();
    let row = standing(&data);
    assert_eq!(row.complete_version_ids.len() as u32, row.suite_complete);
    assert!(row.complete_version_ids.contains(&"v0".to_owned()));
    // v0 republished with only its evaluator changed: its cell moves.
    let mut carrying = data.versions[0].clone();
    carrying.id = "v0-evaluator".into();
    carrying.published_at = 2;
    carrying.carries_from = Some("v0".into());
    data.versions.push(carrying);
    // As the service loads them: the cells are the carrying version's.
    for run in &mut data.runs {
        for attempt in &mut run.attempts {
            if attempt.version_id == "v0" {
                attempt.version_id = "v0-evaluator".into();
            }
        }
    }
    for attempt in &mut data.attempts {
        if attempt.version_id == "v0" {
            attempt.version_id = "v0-evaluator".into();
        }
    }
    let row = standing(&data);
    assert!(row
        .complete_version_ids
        .contains(&"v0-evaluator".to_owned()));
    assert!(!row.complete_version_ids.contains(&"v0".to_owned()));
    assert_eq!(row.complete_version_ids.len() as u32, row.suite_complete);
}
/// A configuration whose every repetition was set aside (its runs closed
/// before any case had all of them) keeps its row: measured, never
/// complete, and saying why, instead of vanishing from the board.
#[test]
fn a_configuration_whose_repetitions_were_all_dropped_keeps_its_row() {
    let mut data = dataset();
    for attempt in data
        .attempts
        .iter_mut()
        .chain(data.runs.iter_mut().flat_map(|run| run.attempts.iter_mut()))
    {
        attempt.outcome = Some(SUPERSEDED.into());
    }
    let row = standing(&data);
    assert_eq!(row.complete, 0);
    assert_eq!(row.suite_complete, 0);
    assert!(row.complete_version_ids.is_empty());
    assert_eq!(row.fully_tested_at, None);
    assert!(
        row.reason.contains("repetitions set aside"),
        "{}",
        row.reason
    );
}
/// A model's cases on two execution profiles, a text configuration and a
/// repository one, make one model row: each case stands on the cell of
/// its own profile.
#[test]
fn a_model_row_merges_its_text_and_repository_configurations() {
    let mut data = dataset();
    let mut repository = data.runs[0].request.configurations[0].clone();
    repository.id = format!("{}:repository", repository.id);
    repository.execution_profile = "protected_repository".into();
    for attempt in data
        .attempts
        .iter_mut()
        .chain(data.runs.iter_mut().flat_map(|run| run.attempts.iter_mut()))
    {
        if ["v3", "v4", "v5"].contains(&attempt.version_id.as_str()) {
            attempt.configuration = repository.clone();
            attempt.observed = Some(repository.clone());
        }
    }
    for run in &mut data.runs {
        run.request.configurations.push(repository.clone());
    }
    let report = leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.models.len(), 1);
    let model = &report.models[0];
    assert_eq!(model.configuration_keys.len(), 2);
    assert_eq!(model.row.suite_complete, model.row.suite_planned);
    assert_eq!(model.row.complete_version_ids.len(), 6);
}
#[test]
fn a_row_covering_the_suite_ranks_and_dates_its_last_completion() {
    let row = standing(&dataset());
    assert_eq!((row.suite_complete, row.suite_planned), (6, 6));
    assert_eq!(row.status, "comparable");
    // Every cell of the standing run settled at 2.
    assert_eq!(row.fully_tested_at, Some(2));
}
#[test]
fn a_pool_release_dates_already_completed_cells_without_new_attempts() {
    let mut data = dataset();
    let before = standing(&data);
    data.releases.push(PoolRelease {
        id: "first-release".into(),
        name: "v1".into(),
        created_at: 10,
        version_ids: data.versions.iter().map(|v| v.id.clone()).collect(),
    });
    let report = leaderboard(&data, &ResultQuery::default());
    for row in report
        .rows
        .iter()
        .chain(report.models.iter().map(|m| &m.row))
    {
        assert_eq!((row.suite_complete, row.suite_planned), (6, 6));
        assert_eq!(row.status, "comparable");
        assert_eq!(row.fully_tested_at, Some(10));
        assert_eq!(row.points, before.points);
        assert_eq!(row.attempt_ids, before.attempt_ids);
        assert_eq!(row.measured_at, before.measured_at);
    }
    // A future release cannot erase or move an earlier observation's date.
    let past = leaderboard(
        &data,
        &ResultQuery {
            as_of: Some(3),
            ..Default::default()
        },
    );
    assert_eq!(past.rows[0].fully_tested_at, Some(2));
}
#[test]
fn a_pool_release_waits_for_its_last_unmeasured_case() {
    let mut data = dataset();
    data.attempts.retain(|a| a.id != "before-v5");
    data.attempts
        .iter_mut()
        .find(|a| a.id == "after-v5")
        .unwrap()
        .finished_at = Some(12);
    data.releases.push(PoolRelease {
        id: "first-release".into(),
        name: "v1".into(),
        created_at: 10,
        version_ids: data.versions.iter().map(|v| v.id.clone()).collect(),
    });
    let pending = leaderboard(
        &data,
        &ResultQuery {
            as_of: Some(11),
            ..Default::default()
        },
    );
    assert_eq!(pending.rows[0].suite_complete, 5);
    assert_eq!(pending.rows[0].fully_tested_at, None);
    assert_eq!(standing(&data).fully_tested_at, Some(12));
}
#[test]
fn a_configuration_row_fills_from_earlier_runs_cell_by_cell() {
    let mut data = dataset();
    // The newer run skipped v5: the earlier run's cell stands for it.
    data.attempts.retain(|a| a.id != "after-v5");
    let row = standing(&data);
    assert_eq!((row.suite_complete, row.suite_planned), (6, 6));
    assert_eq!(row.status, "comparable");
    assert!(row.attempt_ids.contains(&"before-v5".to_owned()));
    assert!(row.attempt_ids.contains(&"after-v0".to_owned()));
}
#[test]
fn a_row_short_of_the_suite_has_no_rank_and_no_date() {
    let mut data = dataset();
    // No run measured v5.
    data.attempts.retain(|a| a.version_id != "v5");
    let row = standing(&data);
    assert_eq!((row.suite_complete, row.suite_planned), (5, 6));
    assert_eq!(row.status, "preliminary");
    assert_eq!(row.fully_tested_at, None);
}
#[test]
fn an_unscored_cell_does_not_complete_a_case() {
    let mut data = dataset();
    for attempt in data.attempts.iter_mut().filter(|a| a.version_id == "v2") {
        attempt.outcome = Some("infrastructure_failure".into());
    }
    let row = standing(&data);
    assert_eq!((row.suite_complete, row.suite_planned), (5, 6));
    assert_eq!(row.status, "preliminary");
    assert_eq!(row.fully_tested_at, None);
}
#[test]
fn a_grown_suite_takes_the_rank_and_keeps_the_last_full_date() {
    let mut data = dataset();
    add_case(&mut data, 6, 10);
    let row = standing(&data);
    assert_eq!((row.suite_complete, row.suite_planned), (6, 7));
    assert_eq!(row.status, "preliminary");
    // Full at 2, before the case published at 10 joined the suite.
    assert_eq!(row.fully_tested_at, Some(2));
}
#[test]
fn a_history_point_lists_a_refused_case_as_refused() {
    let mut data = dataset();
    for attempt in data.attempts.iter_mut().filter(|a| a.id == "after-v5") {
        attempt.outcome = Some("unsupported".into());
    }
    let configuration = data.attempts[0].configuration.clone();
    let points = history(&data, &configuration);
    let row = &points.last().unwrap().recalculated_report.rows[0];
    assert_eq!(row.unsupported_version_ids, vec!["v5".to_owned()]);
    assert!(row.missing_version_ids.is_empty());
}
#[test]
fn a_board_can_leave_out_scores_a_marked_panel_gave() {
    let mut data = dataset();
    // v0 was judged by a one-judge panel that sat a judge of the
    // candidate's lab.
    let judged = |id: String, at: i64, provenance: &str, score: Option<f64>, details| Evaluation {
        id,
        evaluator_revision: "1".into(),
        verdict: if score.is_some() {
            "judged"
        } else {
            "rendered"
        }
        .into(),
        score,
        reason: String::new(),
        created_at: at,
        provenance: provenance.into(),
        artifacts: Vec::new(),
        details,
        judge: None,
        usage: None,
    };
    for attempt in data.attempts.iter_mut().filter(|a| a.version_id == "v0") {
        attempt.outcome = Some("judged".into());
        attempt.evaluations = vec![
            judged(
                format!("{}-render", attempt.id),
                2,
                "render",
                None,
                Some(serde_json::json!({ "expectedJudges": 1, "sameVendor": true })),
            ),
            judged(format!("{}-vote", attempt.id), 2, "judge", Some(1.0), None),
        ];
    }
    let row = |flags: Option<Vec<String>>| {
        leaderboard(
            &data,
            &ResultQuery {
                exclude_judge_flags: flags,
                ..Default::default()
            },
        )
        .rows[0]
            .clone()
    };
    assert_eq!(row(None).suite_complete, 6);
    assert_eq!(row(Some(vec!["ownModel".into()])).suite_complete, 6);
    let hidden = row(Some(vec!["sameVendor".into(), "ownModel".into()]));
    assert_eq!((hidden.suite_complete, hidden.suite_planned), (5, 6));
    assert_eq!(hidden.status, "preliminary");
}
#[test]
fn the_full_date_is_the_last_moment_every_published_case_was_complete() {
    // (entered the pool, completions of its complete cells)
    assert_eq!(fully_tested_at(&[(1, vec![4]), (1, vec![7])]), Some(7));
    // All measurements precede the release that admits their cases.
    assert_eq!(fully_tested_at(&[(10, vec![4]), (10, vec![7])]), Some(10));
    // A premeasured new case completes the expanded pool upon entry.
    assert_eq!(fully_tested_at(&[(1, vec![4]), (10, vec![7])]), Some(10));
    // A case entered at 9 and never completed: full at 7, before it.
    assert_eq!(
        fully_tested_at(&[(1, vec![4]), (1, vec![7]), (9, vec![])]),
        Some(7)
    );
    // A case entered at 5 but completed only at 12: full from 12 on.
    assert_eq!(
        fully_tested_at(&[(1, vec![4]), (5, vec![12]), (1, vec![7])]),
        Some(12)
    );
    // An earlier complete cell keeps the date while a re-run is open.
    assert_eq!(fully_tested_at(&[(1, vec![4, 20]), (1, vec![7])]), Some(20));
    // A case in the pool from 1 that never completed: never full.
    assert_eq!(fully_tested_at(&[(1, vec![4]), (1, vec![])]), None);
    assert_eq!(fully_tested_at(&[]), None);
}
#[test]
fn the_tracker_tells_discriminating_flaky_and_smoke_cases_apart() {
    let mut data = dataset();
    data.required_repetitions = 2;
    let template: Vec<Attempt> = data
        .attempts
        .iter()
        .filter(|a| a.run_id == "after")
        .cloned()
        .collect();
    data.attempts.retain(|a| a.run_id != "after");
    let mine = template[0].configuration.clone();
    let mut other = mine.clone();
    other.id = "other".into();
    other.model_id = "other".into();
    for attempt in &template {
        for (model, configuration) in [("model", &mine), ("other", &other)] {
            for repetition in 0..2u32 {
                // v0 every model passes, v1 only "model" does, v2 "model"
                // passes one repetition of two, the rest nobody passes.
                let pass = match attempt.version_id.as_str() {
                    "v0" => true,
                    "v1" => model == "model",
                    "v2" => !(model == "model" && repetition == 1),
                    _ => false,
                };
                let mut copy = attempt.clone();
                copy.id = format!("{}-{model}-{repetition}", attempt.id);
                copy.configuration = configuration.clone();
                copy.observed = Some(configuration.clone());
                copy.repetition = repetition;
                copy.outcome = Some(if pass { "pass" } else { "fail" }.into());
                data.attempts.push(copy);
            }
        }
    }
    let stats = case_tracker(&data);
    let of = |id: &str| stats.iter().find(|s| s.version_id == id).unwrap();
    assert_eq!((of("v0").models, of("v0").passed), (2, 2));
    assert_eq!(of("v0").spread, Some(0.0));
    assert!(of("v0").smoke);
    assert_eq!((of("v1").passed, of("v1").spread), (1, Some(1.0)));
    assert!(!of("v1").smoke);
    assert_eq!((of("v2").flaky, of("v2").spread), (1, Some(0.5)));
    assert_eq!((of("v3").models, of("v3").passed), (2, 0));
    assert!(!of("v3").smoke);
}
#[test]
fn authored_cases_leave_quality_but_count_for_speed_and_cost() {
    let mut data = dataset();
    let query = ResultQuery::default();
    assert_eq!(leaderboard(&data, &query).rows[0].status, "comparable");
    data.versions[0].manifest.environment["authoredBy"] =
        serde_json::json!([data.runs[0].request.configurations[0]]);
    // The own case is the only one the standing run solved, and it ran
    // with known spend.
    for attempt in &mut data.attempts {
        attempt.usage.cost = Some(if attempt.version_id == "v0" { 3.0 } else { 1.0 });
        if attempt.id == "after-v0" {
            attempt.outcome = Some("pass".into());
        }
    }
    let row = &leaderboard(&data, &query).rows[0];
    assert_eq!(row.planned, 5);
    assert!(row
        .reason
        .contains("1 cases authored by this candidate left out of quality"));
    assert!(!row.attempt_ids.contains(&"after-v0".to_string()));
    assert_eq!(row.own_attempt_ids, vec!["after-v0"]);
    assert_eq!(row.own_version_ids, vec!["v0"]);
    assert_eq!(row.scored_version_ids, vec!["v1", "v2", "v3", "v4", "v5"]);
    assert_eq!((row.passed, row.quality), (0, Some(0.0)));
    // Speed and cost read the own cell too.
    assert_eq!(row.speed_share, Some(1.0));
    assert_eq!(row.cost, Some(8.0 / 6.0));
    assert_eq!(row.axes[0].speed_share, Some(1.0));
    // A history compares the model with itself and counts the own case.
    let configuration = data.runs[0].request.configurations[0].clone();
    let points = history(&data, &configuration);
    let newest = points.last().unwrap();
    let counted = newest
        .report
        .rows
        .iter()
        .find(|r| leaderboard_key(&r.configuration) == leaderboard_key(&configuration))
        .unwrap();
    assert_eq!(counted.planned, 6);
    assert!(counted.scored_version_ids.contains(&"v0".to_string()));
    assert_eq!(counted.own_version_ids, vec!["v0"]);
    assert!(counted.own_attempt_ids.is_empty());
    assert_eq!(counted.passed, 1);
    for version in &mut data.versions {
        version.manifest.environment["authoredBy"] =
            serde_json::json!([data.runs[0].request.configurations[0]]);
    }
    let report = leaderboard(&data, &query);
    assert_eq!(report.rows[0].status, "excluded");
    assert_eq!(report.rows[0].quality, None);
    assert!(report.rows[0].scored_version_ids.is_empty());
    assert_eq!(report.rows[0].median_duration_ms, Some(100.0));
    assert_eq!(report.rows[0].own_attempt_ids.len(), 6);
    assert!(report.cohort.is_some());
}
/// A cell is one sitting: each case stands on its newest scored cell,
/// whichever run measured it, so a later run that left cases out keeps
/// the earlier cells of those cases.
#[test]
fn each_case_stands_on_its_newest_scored_cell_and_coverage_follows_the_pool() {
    let mut data = dataset();
    for version in data.versions.iter_mut().take(2) {
        version.manifest.work_class_id = "planning".into();
    }
    // The later run left v0 and v1 out and failed the other four.
    data.attempts
        .retain(|a| !(a.run_id == "after" && (a.version_id == "v0" || a.version_id == "v1")));
    let query = ResultQuery::default();
    let report = leaderboard(&data, &query);
    let cohort = report.cohort.as_ref().unwrap();
    assert_eq!(cohort.work_classes.len(), 2);
    assert_eq!(cohort.version_ids.len(), 6);
    assert_eq!(
        cohort.run_ids,
        vec!["after".to_string(), "before".to_string()]
    );
    let row = &report.rows[0];
    assert_eq!(row.status, "comparable");
    assert_eq!((row.scored, row.planned), (6, 6));
    // The earlier passes of v0 and v1 stand beside the later fails.
    let planning = row.axes.iter().find(|axis| axis.id == "planning").unwrap();
    assert_eq!(
        (planning.scored, planning.planned, planning.passed),
        (2, 2, 2)
    );
    assert!(row.missing_version_ids.is_empty());
    for id in ["before-v0", "before-v1", "after-v2", "after-v5"] {
        assert!(row.attempt_ids.contains(&id.to_owned()), "{id}");
    }
    assert_eq!(row.attempt_ids.len(), 6);
    assert_eq!(row.measured_at, Some(2));
    // Both runs whole: the newest stands, every case failed.
    let whole = dataset();
    let row = &leaderboard(&whole, &query).rows[0];
    assert_eq!(
        (row.status.as_str(), row.scored, row.points),
        ("comparable", 6, Some(0))
    );
    // One lonely case leaves five gaps and no rank.
    data.attempts.truncate(1);
    let row = &leaderboard(&data, &query).rows[0];
    assert_eq!(row.status, "preliminary");
    assert_eq!((row.scored, row.planned), (1, 6));
    assert_eq!(row.missing_version_ids.len(), 5);
    assert_eq!(
        row.scored_version_ids,
        vec![data.attempts[0].version_id.clone()]
    );
    assert_eq!(row.axes.iter().map(|axis| axis.planned).sum::<u32>(), 6);
    data.attempts[0].outcome = None;
    data.attempts[0].usage.cost = Some(0.5);
    // Paid failures retain their known spend even without a quality verdict.
    assert_eq!(leaderboard(&data, &query).rows[0].cost, Some(0.5));
}
#[test]
fn the_ledger_as_of_a_date_shows_what_was_measured_by_then() {
    let data = dataset();
    // Before the second run only the first run's passes exist.
    let early = leaderboard(
        &data,
        &ResultQuery {
            as_of: Some(3),
            ..ResultQuery::default()
        },
    );
    assert_eq!(early.rows[0].points, Some(1000));
    assert_eq!(
        early.cohort.as_ref().unwrap().run_ids,
        vec!["before".to_string()]
    );
    // Later the second run supersedes every case.
    let late = leaderboard(&data, &ResultQuery::default());
    assert_eq!(late.rows[0].points, Some(0));
}
/// Run 607f8612: every attempt on a model the account's plan leaves out
/// ended `unsupported`. Such a case is no gap for a catch-up, which would
/// only pay for the same refusal again; it is listed apart. A newer cell
/// that is merely unscored (an infrastructure failure) makes it a gap
/// again.
#[test]
fn a_case_the_provider_refused_is_no_catch_up_gap() {
    let mut data = dataset();
    for attempt in data.attempts.iter_mut().filter(|a| a.version_id == "v0") {
        attempt.outcome = Some("unsupported".into());
    }
    let row = &leaderboard(&data, &ResultQuery::default()).rows[0];
    assert!(row.missing_version_ids.is_empty());
    assert_eq!(row.unsupported_version_ids, vec!["v0".to_string()]);
    assert_eq!((row.scored, row.planned), (5, 6));
    assert_eq!(row.status, "preliminary");
    data.attempts
        .iter_mut()
        .find(|a| a.id == "after-v0")
        .unwrap()
        .outcome = Some("infrastructure_failure".into());
    let row = &leaderboard(&data, &ResultQuery::default()).rows[0];
    assert_eq!(row.missing_version_ids, vec!["v0".to_string()]);
    assert!(row.unsupported_version_ids.is_empty());
}
/// Every provider runs every split since 2026-10-19: a held-out cell the
/// retired train-only rule settled `excluded` unsent holds no measurement,
/// so the case stays in the plan and is owed again.
#[test]
fn a_case_the_retired_train_only_rule_kept_out_is_owed_again() {
    let mut data = dataset();
    let before = leaderboard(&data, &ResultQuery::default()).rows[0].planned;
    for attempt in data.attempts.iter_mut().filter(|a| a.version_id == "v0") {
        attempt.outcome = Some("excluded".into());
        attempt.reason = Some(
            "Invented Lab may train on submitted data, so it runs only train tasks, not held_out ones"
                .into(),
        );
        attempt.evaluations.clear();
    }
    let row = &leaderboard(&data, &ResultQuery::default()).rows[0];
    assert_eq!(row.planned, before);
    assert_eq!(row.missing_version_ids, vec!["v0".to_string()]);
    assert!(row.unsupported_version_ids.is_empty());
}
#[test]
fn a_new_case_adds_a_gap_instead_of_resetting_history() {
    let mut data = dataset();
    // A seventh case is published; nobody has run it yet.
    let mut extra = data.versions[0].clone();
    extra.id = "v6".into();
    extra.definition_id = "d6".into();
    extra.published_at = 9;
    data.versions.push(extra);
    let report = leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.cohort.as_ref().unwrap().version_ids.len(), 7);
    let row = &report.rows[0];
    assert_eq!(row.status, "preliminary");
    assert_eq!((row.scored, row.planned), (6, 7));
    assert_eq!(row.missing_version_ids, vec!["v6".to_string()]);
    assert_eq!(
        row.scored_version_ids,
        vec!["v0", "v1", "v2", "v3", "v4", "v5"]
    );
    // The six measured cases still carry their points, on every board.
    assert_eq!(row.points, Some(0));
    assert_eq!(row.speed_share, None);
    // Archiving a definition retires its case from the pool.
    data.definitions.push(DefinitionState {
        id: "d6".into(),
        archived: true,
        archived_at: None,
        archive_history: vec![],
    });
    assert_eq!(
        leaderboard(&data, &ResultQuery::default()).rows[0].status,
        "comparable"
    );
    // A newer version of a case replaces the older one in the pool.
    let mut revised = data.versions[1].clone();
    revised.id = "v1b".into();
    revised.published_at = 10;
    data.versions.push(revised);
    let row = &leaderboard(&data, &ResultQuery::default()).rows[0];
    assert_eq!(row.missing_version_ids, vec!["v1b".to_string()]);
    assert_eq!(row.scored_version_ids, vec!["v0", "v2", "v3", "v4", "v5"]);
    // Asking for one run shows that run's own suite.
    let narrow = ResultQuery {
        run_id: Some("before".into()),
        ..ResultQuery::default()
    };
    let report = leaderboard(&data, &narrow);
    assert_eq!(report.cohort.as_ref().unwrap().version_ids.len(), 6);
    assert_eq!(report.rows[0].points, Some(1000));
}
#[test]
fn later_judgments_and_reviews_do_not_rewrite_an_earlier_snapshot() {
    let mut data = dataset();
    let attempt = &mut data.attempts[0];
    attempt.outcome = Some("judged".into());
    let evaluation = |created_at, score, provenance: &str| Evaluation {
        id: format!("evaluation-{created_at}"),
        evaluator_revision: "1".into(),
        verdict: "judged".into(),
        score: Some(score),
        reason: String::new(),
        created_at,
        provenance: provenance.into(),
        artifacts: vec![],
        details: None,
        judge: None,
        usage: None,
    };
    attempt.evaluations = vec![evaluation(9, 0.4, "judge"), evaluation(10, 1.0, "human")];
    let at = |time| {
        leaderboard(
            &data,
            &ResultQuery {
                run_id: Some("before".into()),
                as_of: Some(time),
                ..ResultQuery::default()
            },
        )
        .rows
        .remove(0)
    };
    let pending = at(3);
    assert_eq!((pending.scored, pending.planned), (5, 6));
    assert_eq!(pending.missing_version_ids, vec!["v0"]);
    assert_eq!(pending.status, "preliminary");
    let judged = at(9);
    assert_eq!(judged.scored, 6);
    // A panel score short of a pass fails an objective case.
    assert_eq!(judged.points, Some(833));
    assert_eq!(at(10).points, Some(1000));
}

#[test]
fn model_scores_each_test_once_across_configurations_and_runs() {
    let mut data = dataset();
    data.attempts
        .retain(|a| a.run_id == "before" || a.version_id == "v0");
    for a in data.attempts.iter_mut().filter(|a| a.run_id == "after") {
        a.configuration.id = "repository".into();
        a.configuration.execution_profile = "protected_repository".into();
        a.configuration.billing_mode = "api".into();
        a.configuration.account_id = Some("another-account".into());
        a.configuration.inventory_revision = Some("another-runtime".into());
        a.observed = Some(a.configuration.clone());
        a.started_at = Some(5);
        a.finished_at = Some(6);
    }
    let report = leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.rows.len(), 2);
    assert_eq!(report.models.len(), 1);
    let row = &report.models[0].row;
    assert_eq!((row.scored, row.passed), (6, 5));
    assert_eq!(row.result_attempt_ids.len(), 6);
    assert!(row.result_attempt_ids.contains(&"after-v0".into()));
    assert!(!row.result_attempt_ids.contains(&"before-v0".into()));
    assert_eq!(report.models[0].configuration_keys.len(), 2);
    let history = model_history(&data, &row.configuration);
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].report.models[0].row.passed, 6);
    assert_eq!(history[1].report.models[0].row.passed, 5);
    assert_eq!(history[1].recalculated_report.models[0].row.scored, 6);
    // An infrastructure failure carries evidence but cannot erase a score.
    data.attempts
        .iter_mut()
        .filter(|a| a.run_id == "after")
        .for_each(|a| a.outcome = Some("infrastructure_failure".into()));
    let report = leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.models[0].row.passed, 6);
    assert_eq!(report.models[0].row.result_attempt_ids.len(), 6);
}

/// Effort and fast mode are what a selection chooses: each combination
/// is its own model row, scored only from its own cells.
#[test]
fn effort_and_fast_mode_are_separate_model_rows() {
    let mut data = dataset();
    data.attempts
        .retain(|a| a.run_id == "before" || a.version_id == "v0");
    for a in data.attempts.iter_mut().filter(|a| a.run_id == "after") {
        a.configuration.effort = Some("max".into());
        a.observed = Some(a.configuration.clone());
        a.started_at = Some(5);
        a.finished_at = Some(6);
    }
    let report = leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.models.len(), 2);
    let effort = |model: &LeaderboardModel| model.row.configuration.effort.clone();
    let max = report
        .models
        .iter()
        .find(|model| effort(model).as_deref() == Some("max"))
        .unwrap();
    assert_eq!(max.row.scored, 1);
    assert_eq!(max.row.result_attempt_ids, ["after-v0"]);
    let other = report
        .models
        .iter()
        .find(|model| effort(model).as_deref() != Some("max"))
        .unwrap();
    assert_eq!(other.row.scored, 6);
    assert!(other.row.result_attempt_ids.contains(&"before-v0".into()));
    assert_ne!(max.key, other.key);
    // The renderer builds the same key (benchmarkModels.ts, modelKey).
    let mut pinned = other.row.configuration.clone();
    pinned.provider_id = "claude-acp".into();
    pinned.model_id = "model-1".into();
    pinned.effort = None;
    pinned.fast_mode = None;
    pinned.model_name = None;
    assert_eq!(
        model_key(&pinned),
        r#"["claude-acp","model-1","default",false]"#
    );
    let history = model_history(&data, &max.row.configuration);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].run_id, "after");

    for a in data.attempts.iter_mut().filter(|a| a.run_id == "after") {
        a.configuration.effort = None;
        a.configuration.fast_mode = Some(true);
        a.observed = Some(a.configuration.clone());
    }
    let report = leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.models.len(), 2);
    assert!(report
        .models
        .iter()
        .any(|model| model.row.configuration.fast_mode == Some(true)
            && model.row.result_attempt_ids == ["after-v0"]));
}

#[test]
fn resumed_runtime_refresh_keeps_a_complete_model_cell() {
    let mut data = dataset();
    data.required_repetitions = 3;
    data.versions.retain(|v| v.id == "v0");
    data.runs.retain(|run| run.id == "before");
    data.runs[0].request.repetitions = 3;
    data.attempts.retain(|a| a.id == "before-v0");
    let original = data.attempts[0].clone();
    for repetition in 1..3 {
        let mut resumed = original.clone();
        resumed.id = format!("resumed-{repetition}");
        resumed.repetition = repetition;
        resumed.started_at = Some(3);
        resumed.finished_at = Some(4);
        resumed.configuration.inventory_revision = Some("updated-runtime".into());
        resumed.observed = Some(resumed.configuration.clone());
        data.attempts.push(resumed);
    }
    let report = leaderboard(&data, &ResultQuery::default());
    let configuration_row = &report.rows[0];
    let model_row = &report.models[0].row;
    assert_eq!(configuration_row.suite_complete, 1);
    assert_eq!(model_row.suite_complete, configuration_row.suite_complete);
    assert_eq!(model_row.complete_version_ids, ["v0"]);
    assert_eq!(model_row.result_attempt_ids.len(), 3);
    assert_eq!(model_row.fully_tested_at, Some(4));
    assert_eq!(model_row.status, "comparable");
    // Runtime evidence stays untouched, including for paired comparisons.
    assert_ne!(
        configuration_key(&data.attempts[0].configuration),
        configuration_key(&data.attempts[1].configuration)
    );
    // A separately requested configuration still cannot fill this cell.
    data.attempts[1].configuration.id = "separate-request".into();
    let report = leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.models[0].row.suite_complete, 0);
}

#[test]
fn model_cells_never_combine_repetitions_from_different_settings() {
    let mut data = dataset();
    data.required_repetitions = 3;
    data.attempts.retain(|a| a.run_id == "before");
    let mut second = data.attempts[0].clone();
    second.id = "second-setting".into();
    second.configuration.billing_mode = "api".into();
    second.observed = Some(second.configuration.clone());
    data.attempts.push(second.clone());
    second.id = "third-setting".into();
    second.configuration.execution_profile = "protected_repository".into();
    second.observed = Some(second.configuration.clone());
    data.attempts.push(second);
    let report = leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.models.len(), 1);
    assert_eq!(report.models[0].row.complete, 0);
    assert_eq!(report.models[0].row.result_attempt_ids.len(), 6);
}

#[test]
fn runtime_updates_and_implicit_defaults_share_one_ledger() {
    let mut data = dataset();
    for attempt in &mut data.attempts {
        // Configuration IDs are display labels and differ between runs.
        attempt.configuration.id = format!("label-{}", attempt.run_id);
        let observed = attempt.observed.as_mut().unwrap();
        observed.id = format!("label-{}", attempt.run_id);
        if attempt.run_id == "before" {
            observed.effort = None;
            observed.fast_mode = None;
            observed.inventory_revision = Some("old-runtime".into());
        } else {
            observed.effort = Some("default".into());
            observed.fast_mode = Some(false);
            observed.inventory_revision = Some("new-runtime".into());
        }
    }
    let report = leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.rows.len(), 1);
    // An omitted effort is "default" and an omitted fast mode is off.
    assert_eq!(report.models.len(), 1);
    assert_eq!(report.rows[0].scored, 6);
    assert_eq!(report.rows[0].points, Some(0));
    assert_eq!(
        report.rows[0].configuration.inventory_revision.as_deref(),
        Some("new-runtime")
    );
    let early = leaderboard(
        &data,
        &ResultQuery {
            as_of: Some(3),
            ..ResultQuery::default()
        },
    );
    assert_eq!(early.rows.len(), 1);
    assert_eq!(early.rows[0].points, Some(1000));
    assert_eq!(
        leaderboard_key(&early.rows[0].configuration),
        leaderboard_key(&report.rows[0].configuration)
    );
    // Paired regressions still require the original frozen runtime conditions.
    assert_ne!(
        configuration_key(&early.rows[0].configuration),
        configuration_key(&report.rows[0].configuration)
    );
    data.attempts
        .last_mut()
        .unwrap()
        .observed
        .as_mut()
        .unwrap()
        .effort = Some("high".into());
    assert_eq!(leaderboard(&data, &ResultQuery::default()).rows.len(), 2);
}

/// Claude's key is pinned byte for byte, so a running campaign never
/// splits. A Kimi id its vendor moves between models is a row per
/// display name, while a display name changes no other key. Each row
/// lists the models its counted attempts' usage named.
#[test]
fn a_moving_alias_is_a_row_per_name_and_rows_name_the_models_that_ran() {
    let claude = Configuration {
        id: "label".into(),
        provider_id: "claude-acp".into(),
        account_id: Some("account".into()),
        model_id: "sonnet".into(),
        effort: None,
        fast_mode: None,
        billing_mode: "subscription".into(),
        execution_profile: "native_text_auxiliary".into(),
        inventory_revision: Some("runtime".into()),
        model_name: Some("Sonnet".into()),
    };
    assert_eq!(
        leaderboard_key(&claude),
        r#"["claude-acp","sonnet","default",false,"subscription","native_text"]"#
    );
    let mut renamed = claude.clone();
    renamed.model_name = Some("Sonnet 5.5".into());
    assert_eq!(leaderboard_key(&renamed), leaderboard_key(&claude));
    let mut k27 = claude.clone();
    k27.provider_id = "kimi-acp".into();
    k27.account_id = Some("cli-login-kimi-acp".into());
    k27.model_id = "kimi-code/kimi-for-coding".into();
    k27.model_name = Some("K2.7 Code".into());
    let mut k28 = k27.clone();
    k28.model_name = Some("K2.8 Preview".into());
    assert_ne!(leaderboard_key(&k27), leaderboard_key(&k28));
    assert_eq!(
        leaderboard_key(&k28),
        r#"[["kimi-acp","kimi-code/kimi-for-coding","default",false,"subscription","native_text"],"K2.8 Preview"]"#
    );
    let mut k3 = k27.clone();
    k3.model_id = "kimi-code/k3".into();
    k3.model_name = Some("K3".into());
    let mut k3_renamed = k3.clone();
    k3_renamed.model_name = Some("K3 Turbo".into());
    assert_eq!(leaderboard_key(&k3), leaderboard_key(&k3_renamed));

    let mut data = dataset();
    for attempt in &mut data.attempts {
        attempt.resolved_model = Some(format!("model-{}", attempt.run_id));
    }
    data.attempts.last_mut().unwrap().resolved_model = Some("model-moved".into());
    let report = leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.rows.len(), 1);
    assert_eq!(
        report.rows[0].resolved_models,
        ["model-after", "model-moved"]
    );
    let early = leaderboard(
        &data,
        &ResultQuery {
            as_of: Some(3),
            ..ResultQuery::default()
        },
    );
    assert_eq!(early.rows[0].resolved_models, ["model-before"]);
    // The alias as K2.7 in one run and as K2.8 in the next: two rows.
    for attempt in &mut data.attempts {
        let configuration = if attempt.run_id == "before" {
            &k27
        } else {
            &k28
        };
        attempt.configuration = configuration.clone();
        attempt.observed = Some(configuration.clone());
    }
    let moved = leaderboard(&data, &ResultQuery::default());
    let mut names: Vec<_> = moved
        .rows
        .iter()
        .map(|row| row.configuration.model_name.clone().unwrap_or_default())
        .collect();
    names.sort();
    assert_eq!(names, ["K2.7 Code", "K2.8 Preview"]);
}

#[test]
fn a_judged_rendering_scores_the_panel_median_until_a_human_overrides() {
    let data = dataset();
    let mut attempt = data.attempts[0].clone();
    attempt.outcome = Some("judged".into());
    let judge = |score: f64, provenance: &str| Evaluation {
        id: format!("{provenance}-{score}"),
        evaluator_revision: "1".into(),
        verdict: "judged".into(),
        score: Some(score),
        reason: String::new(),
        created_at: 9,
        provenance: provenance.into(),
        artifacts: vec![],
        details: None,
        judge: None,
        usage: None,
    };
    attempt.evaluations = vec![
        judge(0.9, "judge"),
        judge(0.6, "judge"),
        judge(0.2, "judge"),
    ];
    assert_eq!(score(&attempt), Some(0.6));
    attempt.evaluations.push(judge(0.35, "human"));
    assert_eq!(score(&attempt), Some(0.35));
}
/// A run of one case replaces that case's cell only: the other five keep
/// their cells from the earlier full run.
#[test]
fn a_narrow_follow_up_run_replaces_only_its_case() {
    let mut data = dataset();
    let mut follow_up = data.runs[1].clone();
    follow_up.id = "follow-up".into();
    follow_up.created_at = 9;
    follow_up.request.version_ids.truncate(1);
    follow_up.request.timeout_seconds = 600;
    follow_up.request.max_executions = 1;
    data.runs.push(follow_up);
    let mut attempt = data.attempts[0].clone();
    attempt.id = "follow-up-v0".into();
    attempt.run_id = "follow-up".into();
    attempt.outcome = Some("pass".into());
    data.attempts.push(attempt);
    let query = ResultQuery::default();
    let report = leaderboard(&data, &query);
    let cohort = report.cohort.as_ref().unwrap();
    assert_eq!(cohort.version_ids.len(), 6);
    assert_eq!(
        cohort.run_ids,
        vec!["after".to_string(), "follow-up".to_string()]
    );
    let row = &report.rows[0];
    assert_eq!(
        (row.scored, row.planned, row.status.as_str()),
        (6, 6, "comparable")
    );
    assert_eq!(row.passed, 1);
    assert!(row.attempt_ids.contains(&"follow-up-v0".to_string()));
    assert!(!row.attempt_ids.contains(&"after-v0".to_string()));
    assert_eq!(cohort.timeout_seconds, 600);
    // Planned but not begun, a run leaves the standing one in place.
    data.attempts.last_mut().unwrap().started_at = None;
    data.attempts.last_mut().unwrap().finished_at = None;
    data.attempts.last_mut().unwrap().phase = "pending".into();
    data.attempts.last_mut().unwrap().outcome = None;
    let report = leaderboard(&data, &query);
    assert_eq!(
        report.cohort.as_ref().unwrap().run_ids,
        vec!["after".to_string()]
    );
    assert_eq!(report.rows[0].scored, 6);
}
#[test]
fn a_fractional_rubric_score_is_preserved() {
    let mut data = dataset();
    let attempt = &mut data.attempts[0];
    attempt.outcome = Some("fail".into());
    attempt.evaluations.push(Evaluation {
        id: "review".into(),
        evaluator_revision: "rubric-v1".into(),
        verdict: "fail".into(),
        score: Some(0.8),
        reason: "Eight criteria met".into(),
        created_at: 7,
        provenance: "human".into(),
        artifacts: vec![],
        details: None,
        judge: None,
        usage: None,
    });
    assert_eq!(score(attempt), Some(0.8));
    attempt.evaluations.push(Evaluation {
        provenance: "human_visual".into(),
        score: Some(0.0),
        ..attempt.evaluations[0].clone()
    });
    assert_eq!(score(attempt), Some(0.8));
}

/// A Kimi turn recorded as the model's failure though it completed no
/// request reads as the infrastructure failure it was, unscored; the
/// stored record keeps what it says.
#[test]
fn a_recorded_kimi_turn_that_completed_no_request_is_not_scored() {
    let mut stored = dataset().attempts[0].clone();
    stored.configuration.provider_id = "kimi-acp".into();
    stored.outcome = Some("fail".into());
    stored.reason = None;
    stored.usage = TokenUsage::default();
    stored.evaluations.clear();
    stored.evaluations.push(Evaluation {
        id: "objective".into(),
        evaluator_revision: "invented-v1".into(),
        verdict: "fail".into(),
        score: Some(0.0),
        reason: "No answer".into(),
        created_at: 7,
        provenance: "objective".into(),
        artifacts: vec![],
        details: None,
        judge: None,
        usage: None,
    });
    for outcome in ["fail", "no_answer"] {
        let mut recorded = stored.clone();
        recorded.outcome = Some(outcome.into());
        recorded.evaluations[0].verdict = outcome.into();
        let read = normalize_outcome(recorded);
        assert_eq!(read.outcome.as_deref(), Some("infrastructure_failure"));
        assert_eq!(read.reason.as_deref(), Some(KIMI_UNANSWERED));
        assert_eq!(score(&read), None);
    }
    // Counters show a request answered; another runtime's empty usage
    // and a human's verdict stand.
    let mut counted = stored.clone();
    counted.usage.input = Some(900);
    let mut other = stored.clone();
    other.configuration.provider_id = "codex-acp".into();
    let mut reviewed = stored.clone();
    reviewed.evaluations[0].provenance = "human".into();
    for attempt in [counted, other, reviewed] {
        let read = normalize_outcome(attempt);
        assert_eq!(read.outcome.as_deref(), Some("fail"));
        assert_eq!(score(&read), Some(0.0));
    }
}
