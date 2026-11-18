//! The leaderboard and the measurement report it is drawn from.
use super::*;

/// The leaderboard is a ledger over the current pool of cases: every
/// configuration stands on its newest run, whole, so a run is one session of
/// measurement and no older run fills its gaps; coverage is counted against
/// the pool, and a rank needs every case complete.
pub fn leaderboard(data: &QueryData, query: &ResultQuery) -> LeaderboardReport {
    leaderboard_counting(data, query, OwnCases::QualityExcluded)
}

pub(super) fn leaderboard_counting(
    data: &QueryData,
    query: &ResultQuery,
    own: OwnCases,
) -> LeaderboardReport {
    let hidden = query.exclude_judge_flags.as_deref().unwrap_or_default();
    leaderboard_from_attempts(
        data,
        query,
        &data
            .attempts
            .iter()
            .filter(|attempt| !judge_flagged(attempt, hidden))
            .collect::<Vec<_>>(),
        ranked_pool(data, query),
        own,
    )
}

/// Whether a panel that judged `attempt` carries one of `flags`, the marks
/// a render records when a judge shares the candidate's lab or model or is
/// the case author's model.
pub(super) fn judge_flagged(attempt: &Attempt, flags: &[String]) -> bool {
    !flags.is_empty()
        && attempt.evaluations.iter().any(|evaluation| {
            evaluation.provenance == "render"
                && evaluation.details.as_ref().is_some_and(|details| {
                    flags
                        .iter()
                        .any(|flag| details.get(flag) == Some(&serde_json::Value::Bool(true)))
                })
        })
}

pub(super) fn leaderboard_from_attempts(
    data: &QueryData,
    query: &ResultQuery,
    source: &[&Attempt],
    pool: Vec<&BenchmarkVersion>,
    own: OwnCases,
) -> LeaderboardReport {
    let prepared = PreparedMeasurements::new(data, query, &pool);
    leaderboard_prepared(data, query, source, pool, own, &prepared)
}

pub(super) fn leaderboard_prepared(
    data: &QueryData,
    query: &ResultQuery,
    source: &[&Attempt],
    pool: Vec<&BenchmarkVersion>,
    own: OwnCases,
    prepared: &PreparedMeasurements<'_>,
) -> LeaderboardReport {
    let mut report = measurement_report(data, query, source, pool.clone(), false, own, prepared);
    let models = measurement_report(data, query, source, pool, true, own, prepared);
    report.models = models
        .rows
        .into_iter()
        .map(|mut row| {
            let key = model_key(&row.configuration);
            // Preserve a measured launch default for the existing run dialog.
            // It supplies no scores and is never a separate model identity.
            if let Some(default) = report
                .rows
                .iter()
                .filter(|entry| model_key(&entry.configuration) == key)
                .max_by(|a, b| {
                    a.complete
                        .cmp(&b.complete)
                        .then(a.scored.cmp(&b.scored))
                        .then(a.measured_at.cmp(&b.measured_at))
                        .then_with(|| {
                            leaderboard_key(&b.configuration)
                                .cmp(&leaderboard_key(&a.configuration))
                        })
                })
            {
                row.configuration = default.configuration.clone();
            }
            LeaderboardModel {
                configuration_keys: report
                    .rows
                    .iter()
                    .filter(|entry| model_key(&entry.configuration) == key)
                    .map(|entry| leaderboard_key(&entry.configuration))
                    .collect(),
                key,
                provider_id: row.configuration.provider_id.clone(),
                model_id: row.configuration.model_id.clone(),
                row,
            }
        })
        .collect();
    report
}

/// Immutable peer baselines for one query cutoff and pool. Configuration and
/// model rows use the same peers; retrospective history points also share
/// today's baseline. This lives only inside one analysis request.
pub(super) struct PreparedMeasurements<'a> {
    pub(super) runs: BTreeMap<&'a str, &'a BenchmarkRun>,
    pub(super) acknowledged: Acknowledgments<'a>,
    pub(super) records: CaseRecords,
    pub(super) entered: BTreeMap<&'a str, i64>,
    pub(super) scores: std::collections::HashMap<*const Attempt, Option<f64>>,
}

#[cfg(test)]
std::thread_local! {
    pub(super) static PREPARED_MEASUREMENTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl<'a> PreparedMeasurements<'a> {
    pub(super) fn new(
        data: &'a QueryData,
        query: &ResultQuery,
        pool: &[&'a BenchmarkVersion],
    ) -> Self {
        #[cfg(test)]
        PREPARED_MEASUREMENTS.with(|count| count.set(count.get() + 1));
        let runs = data
            .runs
            .iter()
            .filter(|run| !run.request.preview)
            .filter(|run| query.run_id.as_ref().is_none_or(|id| id == &run.id))
            .filter(|run| query.as_of.is_none_or(|at| run.created_at <= at))
            .map(|run| (run.id.as_str(), run))
            .collect();
        let pool_versions: BTreeMap<&str, &BenchmarkVersion> =
            pool.iter().map(|v| (v.id.as_str(), *v)).collect();
        let graded = |version_id: &str| {
            pool_versions
                .get(version_id)
                .is_some_and(|v| v.manifest.evaluator.kind == "rubric")
        };
        let required = |version_id: &str| {
            pool_versions
                .get(version_id)
                .map_or(data.required_repetitions.max(1), |v| {
                    required_repetitions(data, v)
                })
        };
        let acknowledged = run_acknowledgments(&data.attempts);
        let scores: std::collections::HashMap<*const Attempt, Option<f64>> = data
            .attempts
            .iter()
            .map(|attempt| {
                (
                    std::ptr::from_ref(attempt),
                    score_as_of(attempt, query.as_of),
                )
            })
            .collect();
        let records = case_records_scored(
            &data.attempts,
            &runs,
            CaseProtocol {
                required: &required,
                graded: &graded,
            },
            &acknowledged,
            &|attempt| scores[&std::ptr::from_ref(attempt)],
        );
        let published = data.versions.iter().map(|v| (v.id.as_str(), v)).collect();
        let entered = pool
            .iter()
            .map(|v| {
                (
                    v.id.as_str(),
                    entered_pool(&published, &data.releases, v, query.as_of),
                )
            })
            .collect();
        Self {
            runs,
            acknowledged,
            records,
            entered,
            scores,
        }
    }

    pub(super) fn score(&self, attempt: &Attempt) -> Option<f64> {
        // All board sources borrow this immutable QueryData's attempts. Use
        // object identity so even repeated labels cannot share an evaluation.
        self.scores[&std::ptr::from_ref(attempt)]
    }
}

/// Model scores count a test once. Its newest scored run/configuration supplies
/// the entire cell. Billing and profiles stay separate, while a runtime refresh
/// or account move within that request preserves its measured repetitions.
pub(super) fn model_cell_attempts<'a>(
    by_run: &BTreeMap<&str, Vec<&'a Attempt>>,
    runs: &BTreeMap<&str, &BenchmarkRun>,
    score: &dyn Fn(&Attempt) -> Option<f64>,
    by_execution: bool,
) -> Vec<&'a Attempt> {
    let mut cells: BTreeMap<(&str, &str, &str, String), Vec<&Attempt>> = BTreeMap::new();
    for (&run, attempts) in by_run {
        for &attempt in attempts {
            cells
                .entry((
                    &attempt.version_id,
                    run,
                    &attempt.configuration.id,
                    // Use the same execution identity as configuration rows.
                    // Strict runtime pins belong to comparison evidence, not
                    // to completion after an explicitly resumed runtime update.
                    if by_execution {
                        leaderboard_key(&execution_configuration(attempt))
                    } else {
                        String::new()
                    },
                ))
                .or_default()
                .push(attempt);
        }
    }
    let mut selected: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
    let order = |cell: &[&Attempt]| {
        let first = cell[0];
        (
            cell.iter().any(|a| score(a).is_some()),
            cell.iter().any(|a| a.started_at.is_some()),
            runs[first.run_id.as_str()].created_at,
            first.run_id.clone(),
            cell.iter().filter_map(|a| a.started_at).max(),
            first.configuration.id.clone(),
        )
    };
    for ((version, _, _, _), cell) in cells {
        // Work that never began measured nothing: no cell of the case.
        if !cell.iter().any(|a| a.started_at.is_some()) {
            continue;
        }
        if selected
            .get(version)
            .is_none_or(|current| order(&cell) > order(current))
        {
            selected.insert(version, cell);
        }
    }
    selected.into_values().flatten().collect()
}

pub(super) fn measurement_report(
    data: &QueryData,
    query: &ResultQuery,
    source: &[&Attempt],
    pool: Vec<&BenchmarkVersion>,
    by_model: bool,
    own: OwnCases,
    prepared: &PreparedMeasurements<'_>,
) -> LeaderboardReport {
    let pool_ids: BTreeSet<&str> = pool.iter().map(|v| v.id.as_str()).collect();
    let pool_versions: BTreeMap<&str, &BenchmarkVersion> =
        pool.iter().map(|v| (v.id.as_str(), *v)).collect();
    let PreparedMeasurements {
        runs,
        acknowledged,
        records,
        entered,
        ..
    } = prepared;
    let score = |attempt: &Attempt| prepared.score(attempt);
    let work_classes: Vec<String> = pool
        .iter()
        .map(|v| v.manifest.work_class_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let work_class = |version_id: &str| {
        pool_versions
            .get(version_id)
            .map(|v| v.manifest.work_class_id.as_str())
            .unwrap_or("unknown")
    };
    let graded = |version_id: &str| {
        pool_versions
            .get(version_id)
            .is_some_and(|v| v.manifest.evaluator.kind == "rubric")
    };
    let required = |version_id: &str| {
        pool_versions
            .get(version_id)
            .map_or(data.required_repetitions.max(1), |v| {
                required_repetitions(data, v)
            })
    };
    let protocol = CaseProtocol {
        required: &required,
        graded: &graded,
    };
    // Every attempt on a pool case from a counted run, by configuration and
    // run, with the repetitions set aside (superseded): a configuration
    // whose every repetition was dropped still has its row, so no measured
    // configuration disappears from the board.
    type Grouped<'a> = (Configuration, BTreeMap<&'a str, Vec<&'a Attempt>>, u32);
    let mut cells: BTreeMap<String, Grouped> = BTreeMap::new();
    for &attempt in source {
        if !pool_ids.contains(attempt.version_id.as_str())
            || !runs.contains_key(attempt.run_id.as_str())
            || query
                .as_of
                .is_some_and(|at| attempt.finished_at.is_none_or(|finished| finished > at))
        {
            continue;
        }
        let configuration = ledger_configuration(attempt, acknowledged);
        let entry = cells
            .entry(if by_model {
                model_key(&configuration)
            } else {
                leaderboard_key(&configuration)
            })
            .or_insert_with(|| (configuration.into_owned(), BTreeMap::new(), 0));
        if is_superseded(attempt) {
            entry.2 += 1;
            continue;
        }
        entry
            .1
            .entry(attempt.run_id.as_str())
            .or_default()
            .push(attempt);
    }
    let mut contributing: BTreeSet<&str> = BTreeSet::new();
    let mut rows: Vec<LeaderboardRow> = cells
        .into_values()
        .filter_map(|(mut configuration, by_run, set_aside)| {
            // A sealed sitting contributes only if it retained a complete
            // cell. Provider refusals remain evidence, not an empty result,
            // and alone leave no row; measured repetitions set aside do.
            let by_run: BTreeMap<_, _> = by_run
                .into_iter()
                .filter(|(id, list)| {
                    runs[id].baked_at.is_none()
                        || case_cells_scored(list, protocol, &score)
                            .values()
                            .any(|cell| cell.complete)
                })
                .collect();
            if by_run.is_empty() && set_aside == 0 {
                return None;
            }
            // The newest run that began measuring, whose request the row
            // reports (how many attempts flew at once). A run still queued
            // leaves the standing one in place until its first cell starts.
            let standing = by_run
                .iter()
                .filter(|(_, list)| list.iter().any(|a| a.started_at.is_some()))
                .max_by_key(|(id, _)| (runs[**id].created_at, **id));
            let standing_request = standing.as_ref().map(|(id, _)| &runs[**id].request);
            // Each case stands on its newest scored cell, one run's
            // repetitions, whichever run measured it: runs taken in chunks
            // fill a row together, while a cell never mixes runs.
            let mut attempts: Vec<&Attempt> =
                model_cell_attempts(&by_run, runs, &score, by_model);
            // Keep the newest concrete configuration for the next run;
            // each attempt retains its original runtime and account evidence.
            if let Some(latest) = attempts
                .iter()
                .max_by_key(|attempt| (attempt.started_at, &attempt.id))
            {
                configuration = ledger_configuration(latest, acknowledged).into_owned();
            }
            // Catch-up pins this configuration, so it carries the runnable profile.
            configuration.execution_profile =
                ledger_profile(&configuration.execution_profile).to_owned();
            // As recorded: 0 for as many as admitted, one for a run admitted
            // before it was recorded.
            let parallelism = standing_request.map(|request| request.parallelism.unwrap_or(1));
            // The candidate's own cases: on a board their cells count for
            // speed and cost but never for quality, points or a rank.
            let own_version_ids: Vec<String> = pool
                .iter()
                .filter(|v| crate::services::benchmarks::routing::authored_by_candidate(&v.manifest, &configuration))
                .map(|v| v.id.clone())
                .collect();
            let counts_own = own == OwnCases::Counted;
            let eligible: Vec<&BenchmarkVersion> = pool
                .iter()
                .copied()
                .filter(|v| counts_own || !own_version_ids.contains(&v.id))
                .collect();
            let excluded = pool.len() as u32 - eligible.len() as u32;
            // An attempt is an own cell when its requested candidate wrote
            // the case, the rule its run planned it under.
            let own_cell = |a: &Attempt| {
                !counts_own
                    && (own_version_ids.contains(&a.version_id)
                        || pool_versions.get(a.version_id.as_str()).is_some_and(|v| {
                            crate::services::benchmarks::routing::authored_by_candidate(&v.manifest, &a.configuration)
                        }))
            };
            let every_cell = attempts.clone();
            let own_attempt_ids: Vec<String> = every_cell
                .iter()
                .filter(|a| own_cell(a))
                .map(|a| a.id.clone())
                .collect();
            attempts.retain(|a| !own_cell(a));
            for attempt in &every_cell {
                contributing.insert(attempt.run_id.as_str());
            }
            // Speed and cost read every cell of the sitting, own cases included.
            let every_cells = case_cells_scored(&every_cell, protocol, &score);
            let every_scored: Vec<&Attempt> = every_cell
                .iter()
                .copied()
                .filter(|a| score(a).is_some())
                .collect();
            let every_scored_versions: BTreeSet<&str> = every_cells.keys().copied().collect();
            let spent = spent_attempts(&every_cell, &every_scored_versions, &score);
            let cost = mean_case_cost(&spent, query.as_of);
            let priced = spent.iter().any(|a| a.usage.cost.is_some());
            let resources = board_stats(&every_cells, records);
            // Work that never began measured nothing, so it never dates the row.
            let measured_at = every_scored
                .iter()
                .chain(&spent)
                .flat_map(|a| {
                    a.finished_at.into_iter().chain(
                        a.evaluations
                            .iter()
                            .map(|e| e.created_at)
                            .filter(|at| query.as_of.is_none_or(|cutoff| *at <= cutoff)),
                    )
                })
                .max();
            let median_duration_ms = median(
                every_scored
                    .iter()
                    .filter_map(|a| a.duration_ms.map(|v| v as f64))
                    .collect(),
            );
            // Auxiliary model calls inflate the counters and a last request's
            // usage understates its turn; keep the figure pure.
            let median_output_tokens = median(
                every_scored
                    .iter()
                    .filter(|a| {
                        !has_auxiliary_usage(a)
                            && !crate::services::benchmarks::model_catalog::usage_is_last_request_only(&a.configuration)
                    })
                    .filter_map(|a| a.usage.output.map(|v| v as f64))
                    .collect(),
            );
            if eligible.is_empty() {
                return Some(LeaderboardRow {
                    comparison_key: String::new(),
                    configuration, passed: 0, scored: 0, attempted: 0, planned: 0, complete: 0, quality: None,
                    median_duration_ms, median_output_tokens, cost, priced, measured_at,
                    points: None, speed_share: resources.speed_share, cost_share: resources.cost_share,
                    status: "excluded".into(),
                    reason: format!("{excluded} cases left out of quality: this candidate helped author every case in the pool; their speed and cost still count"),
                    attempt_ids: Vec::new(),
                    result_attempt_ids: Vec::new(),
                    own_attempt_ids,
                    own_version_ids,
                    axes: Vec::new(),
                    missing_version_ids: Vec::new(),
                    unsupported_version_ids: Vec::new(),
                    scored_version_ids: Vec::new(),
                    resolved_models: Vec::new(),
                    parallelism,
                    suite_planned: 0,
                    suite_complete: 0,
                    complete_version_ids: Vec::new(),
                    fully_tested_at: None,
                });
            }
            let planned = eligible.len() as u32;
            let attempted = attempts
                .iter()
                .filter(|a| a.started_at.is_some())
                .map(|a| a.version_id.as_str())
                .collect::<BTreeSet<_>>()
                .len() as u32;
            let cells = case_cells_scored(&attempts, protocol, &score);
            // The repetitions the cells are made of: scored ones alone, so a
            // repetition of a measured case that never ran dates or costs nothing.
            let scored_attempts: Vec<&Attempt> = attempts.iter().copied()
                .filter(|a| score(a).is_some()).collect();
            let standard_budgets = attempts.iter().all(|a| {
                pool_versions.get(a.version_id.as_str()).is_some_and(|v|
                    runs[a.run_id.as_str()].request.timeout_seconds >= v.manifest.limits.timeout_seconds)
            });
            // A class board is the mean over its cases; the row is the mean
            // over its measured class boards, so a class with many cases does
            // not outweigh a class with few.
            let axes: Vec<LeaderboardAxis> = work_classes
                .iter()
                .map(|class| {
                    let subset: BTreeMap<&str, CaseCell> = cells
                        .iter()
                        .filter(|(version, _)| work_class(version) == class)
                        .map(|(version, cell)| (*version, *cell))
                        .collect();
                    let cases = eligible
                        .iter()
                        .filter(|v| v.manifest.work_class_id == *class)
                        .count() as u32;
                    let stats = board_stats(&subset, records);
                    let class_cells: BTreeMap<&str, CaseCell> = every_cells
                        .iter()
                        .filter(|(version, _)| work_class(version) == class)
                        .map(|(version, cell)| (*version, *cell))
                        .collect();
                    let resources = board_stats(&class_cells, records);
                    LeaderboardAxis {
                        id: class.clone(),
                        quality: stats.quality,
                        points: stats.points,
                        speed_share: resources.speed_share,
                        cost_share: resources.cost_share,
                        passed: stats.passed,
                        scored: stats.scored,
                        planned: cases,
                    }
                })
                .collect();
            let overall = board_stats(&cells, records);
            let measured_axes: Vec<&LeaderboardAxis> =
                axes.iter().filter(|axis| axis.scored > 0).collect();
            let points = (!measured_axes.is_empty()).then(|| {
                (measured_axes.iter().filter_map(|axis| axis.points).map(f64::from).sum::<f64>()
                    / measured_axes.len() as f64)
                    .round() as u32
            });
            let (passed, scored, quality) = (overall.passed, overall.scored, overall.quality);
            let complete = overall.complete;
            // The measurement suite: every eligible case. A row is fully
            // tested when each has a complete cell; the cell completed when
            // its last scored repetition settled.
            let suite: Vec<&BenchmarkVersion> = eligible.clone();
            let suite_planned = suite.len() as u32;
            let complete_version_ids: Vec<String> = suite
                .iter()
                .filter(|v| cells.get(v.id.as_str()).is_some_and(|cell| cell.complete))
                .map(|v| v.id.clone())
                .collect();
            let suite_complete = complete_version_ids.len() as u32;
            // Every complete cell the row ever held, by case: one run's
            // repetitions under one requested configuration.
            let mut completions: BTreeMap<&str, Vec<i64>> = BTreeMap::new();
            for list in by_run.values() {
                let mut by_request: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
                for &attempt in list.iter().filter(|a| !own_cell(a)) {
                    by_request.entry(attempt.configuration.id.as_str()).or_default().push(attempt);
                }
                for cell_attempts in by_request.values() {
                    let cells = case_cells_scored(cell_attempts, protocol, &score);
                    // Gather each case's last settlement in one pass. Scanning
                    // the whole sitting again for every case made history grow
                    // quadratically with the number of measured cases.
                    let mut done: BTreeMap<&str, i64> = BTreeMap::new();
                    for &attempt in cell_attempts {
                        if !cells.get(attempt.version_id.as_str()).is_some_and(|cell| cell.complete)
                            || score(attempt).is_none()
                        {
                            continue;
                        }
                        if let Some(at) = settled_at(attempt) {
                            done.entry(attempt.version_id.as_str())
                                .and_modify(|last| *last = (*last).max(at))
                                .or_insert(at);
                        }
                    }
                    for (version, done) in done {
                        completions.entry(version).or_default().push(done);
                    }
                }
            }
            let suite_cases: Vec<(i64, Vec<i64>)> = suite
                .iter()
                .map(|v| {
                    (
                        entered[v.id.as_str()],
                        completions.get(v.id.as_str()).cloned().unwrap_or_default(),
                    )
                })
                .collect();
            let fully_tested = suite_planned > 0 && suite_complete == suite_planned;
            // A case without a score whose standing cell the provider refused
            // (an `unsupported` outcome, such as a model the account's plan
            // leaves out) is no gap a catch-up fills: asking again would
            // only pay for the same refusal. It is listed apart, for a run
            // the operator asks for.
            let unscored: Vec<&BenchmarkVersion> = eligible
                .iter()
                .copied()
                .filter(|v| !cells.contains_key(v.id.as_str()))
                .collect();
            let (unsupported_version_ids, missing_version_ids): (Vec<String>, Vec<String>) =
                unscored.iter().map(|v| v.id.clone()).partition(|id| {
                    attempts.iter().any(|a| {
                        &a.version_id == id && a.outcome.as_deref() == Some("unsupported")
                    })
                });
            Some(LeaderboardRow {
                comparison_key: comparison_key(&scored_attempts, runs, &pool_versions, query.as_of),
                configuration,
                passed,
                scored,
                attempted,
                planned,
                complete,
                quality,
                median_duration_ms,
                median_output_tokens,
                cost,
                priced,
                measured_at,
                points,
                speed_share: resources.speed_share,
                cost_share: resources.cost_share,
                status: if attempted == 0 {
                    "untested"
                } else if fully_tested && standard_budgets {
                    // Only a row that covers the whole measurement suite with
                    // every repetition ranks; every other score is partial.
                    "comparable"
                } else {
                    "preliminary"
                }
                .into(),
                reason: format!(
                    "{scored}/{planned} cases measured on the current pool, {complete} with every repetition; {suite_complete}/{suite_planned} measurement-suite cases complete; {}; every repetition must pass{}{}{}",
                    if by_model { "each test uses its newest scored cell across the model's runs" } else { "each test uses its newest scored cell across this configuration's runs" },
                    if excluded > 0 {
                        format!("; {excluded} cases authored by this candidate left out of quality, their speed and cost counted")
                    } else if counts_own && !own_version_ids.is_empty() {
                        format!("; includes {} cases authored by this candidate", own_version_ids.len())
                    } else {
                        String::new()
                    },
                    if standard_budgets { "" } else { "; a run shortened the published task budget, so no shared rank is assigned" },
                    if set_aside > 0 {
                        format!("; {set_aside} repetitions set aside, measured again or dropped when their run closed before their case had every repetition")
                    } else {
                        String::new()
                    }
                ),
                attempt_ids: attempts.iter().map(|a| a.id.clone()).collect(),
                result_attempt_ids: scored_attempts.iter().map(|a| a.id.clone()).collect(),
                own_attempt_ids,
                own_version_ids,
                axes,
                missing_version_ids,
                unsupported_version_ids,
                scored_version_ids: scored_attempts.iter().map(|a| a.version_id.clone())
                    .collect::<BTreeSet<_>>().into_iter().collect(),
                resolved_models: scored_attempts.iter().filter_map(|a| a.resolved_model.clone())
                    .collect::<BTreeSet<_>>().into_iter().collect(),
                parallelism,
                suite_planned,
                suite_complete,
                complete_version_ids,
                fully_tested_at: fully_tested_at(&suite_cases),
            })
        })
        .collect();
    let cohort = (!pool.is_empty()).then(|| {
        let counted: Vec<&BenchmarkRun> = contributing.iter().map(|id| runs[id]).collect();
        LeaderboardCohort {
            run_ids: contributing.iter().map(|id| (*id).to_string()).collect(),
            version_ids: pool.iter().map(|v| v.id.clone()).collect(),
            repetitions: counted
                .iter()
                .map(|run| run.request.repetitions)
                .max()
                .unwrap_or(1),
            timeout_seconds: counted
                .iter()
                .map(|run| run.request.timeout_seconds)
                .max()
                .unwrap_or(0),
            max_executions: pool.len() as u32,
            newest_run_at: counted.iter().map(|run| run.created_at).max().unwrap_or(0),
            work_classes: work_classes.clone(),
        }
    });
    // Author exclusions can produce different measurement suites. One
    // reference suite keeps the shared rank: the whole suite when a comparable
    // row covers it, else the suite most comparable rows share (then the
    // larger, then the first by id). Only the rows whose suite differs lose
    // the rank.
    let suite_of = |row: &LeaderboardRow| -> Vec<String> {
        pool.iter()
            .filter(|v| own == OwnCases::Counted || !row.own_version_ids.contains(&v.id))
            .map(|v| v.id.clone())
            .collect()
    };
    let suites: Vec<Vec<String>> = rows.iter().map(suite_of).collect();
    let mut ranked_sets: BTreeMap<&Vec<String>, usize> = BTreeMap::new();
    for (row, suite) in rows.iter().zip(&suites) {
        if row.status == "comparable" {
            *ranked_sets.entry(suite).or_default() += 1;
        }
    }
    let full_suite: Vec<String> = pool.iter().map(|v| v.id.clone()).collect();
    let reference = if ranked_sets.contains_key(&full_suite) {
        Some(full_suite)
    } else {
        ranked_sets
            .iter()
            .max_by(|(a, x), (b, y)| x.cmp(y).then(a.len().cmp(&b.len())).then(b.cmp(a)))
            .map(|(set, _)| (*set).clone())
    };
    if let Some(reference) = reference {
        for (row, _) in rows
            .iter_mut()
            .zip(&suites)
            .filter(|(r, suite)| r.status == "comparable" && **suite != reference)
        {
            row.status = "preliminary".into();
            row.reason.push_str(
                "; this candidate's eligible case set differs from the ranked pool, so no shared rank is assigned",
            );
        }
    }
    rows.sort_by(|a, b| {
        (b.status == "comparable")
            .cmp(&(a.status == "comparable"))
            .then_with(|| b.points.unwrap_or(0).cmp(&a.points.unwrap_or(0)))
            .then_with(|| {
                b.quality
                    .unwrap_or(-1.0)
                    .total_cmp(&a.quality.unwrap_or(-1.0))
            })
    });
    let rows: Vec<_> = rows
        .into_iter()
        .skip(query.offset.unwrap_or(0) as usize)
        .take(query.limit.unwrap_or(100).min(500) as usize)
        .collect();
    LeaderboardReport {
        cohort,
        rows,
        models: Vec::new(),
    }
}

/// The automated evaluation that defines an attempt's scoring protocol: the
/// render marker of the judge batch that produced the score, else the newest
/// objective check or render marker. Judges and human reviews grade or
/// annotate one output; they are not a new protocol.
pub(super) fn protocol_evaluation(attempt: &Attempt, as_of: Option<i64>) -> Option<&Evaluation> {
    let evaluations: Vec<&Evaluation> = attempt
        .evaluations
        .iter()
        .filter(|e| as_of.is_none_or(|at| e.created_at <= at))
        .collect();
    if let Panel::Settled { marker, .. } = judge_panel(&evaluations) {
        return Some(evaluations[marker]);
    }
    evaluations.into_iter().rev().find(|e| {
        !matches!(
            e.provenance.as_str(),
            "judge" | "judge_failure" | "human" | "human_visual"
        )
    })
}

pub(super) fn comparison_key(
    attempts: &[&Attempt],
    runs: &BTreeMap<&str, &BenchmarkRun>,
    pool: &BTreeMap<&str, &BenchmarkVersion>,
    as_of: Option<i64>,
) -> String {
    let protocols: BTreeSet<_> = attempts
        .iter()
        .map(|a| {
            let version = pool.get(a.version_id.as_str()).expect("pool attempt");
            let evaluation = protocol_evaluation(a, as_of);
            serde_json::to_string(&serde_json::json!([
                a.version_id,
                execution_configuration(a).inventory_revision,
                runs[a.run_id.as_str()]
                    .request
                    .timeout_seconds
                    .min(version.manifest.limits.timeout_seconds),
                evaluation.map(|e| (&e.provenance, &e.evaluator_revision)),
                evaluation
                    .and_then(|e| e.details.as_ref())
                    .and_then(|d| d.get("protocolHash"))
            ]))
            .unwrap_or_default()
        })
        .collect();
    serde_json::to_string(&protocols).unwrap_or_default()
}
