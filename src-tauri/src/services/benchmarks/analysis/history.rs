//! A model's history: observations over time and the reports recalculated from them.
use super::*;

/// Today's pool and all peers, shared by every retrospective observation.
pub(super) struct CurrentHistoryPool<'a> {
    pub(super) versions: Vec<&'a BenchmarkVersion>,
    pub(super) ids: BTreeSet<&'a str>,
    pub(super) prepared: PreparedMeasurements<'a>,
}

/// Recompute an observation on today's cases with today's evidence: the
/// run's own cells as they had finished by `at`, whatever runtime, budget or
/// evaluator revision they ran under, so a later run never rewrites an
/// earlier point. A verdict given after `at` on a cell finished by then is
/// that run's own measurement and counts here; a case the run had not
/// finished by then is a gap at that point.
pub(super) fn recalculated_history_report(
    data: &QueryData,
    own: &[&Attempt],
    current: &CurrentHistoryPool<'_>,
    run_id: &str,
    at: i64,
    by_model: bool,
) -> (LeaderboardReport, Vec<String>, Vec<String>) {
    let selected: Vec<&Attempt> = own
        .iter()
        .copied()
        .filter(|a| {
            (by_model || a.run_id == run_id)
                && current.ids.contains(a.version_id.as_str())
                && !is_superseded(a)
                && a.finished_at.is_some_and(|end| end <= at)
                // A refusal by the provider stays, so the point lists the
                // case as refused, as the board does, not as an open gap.
                && (current.prepared.score(a).is_some() || a.outcome.as_deref() == Some("unsupported"))
        })
        .collect();
    let backfilled: Vec<String> = Vec::new();
    // The cases whose verdict came after the run's end, named on the point.
    let revised: Vec<String> = selected
        .iter()
        .filter(|a| a.evaluations.iter().any(|e| e.created_at > at))
        .map(|a| a.version_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    // A point with nothing finished by its date has no observation to anchor it.
    let mut report = if selected.is_empty() {
        LeaderboardReport {
            cohort: None,
            rows: Vec::new(),
            models: Vec::new(),
        }
    } else {
        leaderboard_prepared(
            data,
            &ResultQuery::default(),
            &selected,
            current.versions.clone(),
            OwnCases::Counted,
            &current.prepared,
        )
    };
    for row in &mut report.rows {
        // A retrospective estimate has no dated peer comparison or rank.
        row.status = "preliminary".into();
        row.reason = format!(
            "{}/{} current cases finished by then; {} reviewed later; recalculated using today's evidence",
            row.scored, row.planned, revised.len()
        );
    }
    for model in &mut report.models {
        model.row.status = "preliminary".into();
    }
    (report, backfilled, revised)
}

/// Points a configuration's history keeps.
pub(super) const HISTORY_POINTS: usize = 24;

/// Walks events newest first, keeps the oldest event of each run of equal
/// observations and stops once `limit` observations are settled, so the work
/// follows the points shown rather than every event ever recorded.
pub(super) fn newest_observations<E, T>(
    newest_first: impl Iterator<Item = E>,
    limit: usize,
    mut observe: impl FnMut(E) -> Option<(String, T)>,
) -> Vec<T> {
    let mut kept = Vec::new();
    let mut pending: Option<(String, T)> = None;
    for event in newest_first {
        if kept.len() == limit {
            break;
        }
        let Some((signature, value)) = observe(event) else {
            continue;
        };
        if pending.as_ref().is_some_and(|(seen, _)| *seen == signature) {
            pending = Some((signature, value));
        } else if let Some((_, newer)) = pending.replace((signature, value)) {
            kept.push(newer);
        }
    }
    if kept.len() < limit {
        kept.extend(pending.map(|(_, value)| value));
    }
    kept.reverse();
    kept
}

/// When a finished attempt's score first became known through its own
/// evaluation, else when it finished. Human reviews are later events.
pub(super) fn settled_at(attempt: &Attempt) -> Option<i64> {
    let finished = attempt.finished_at?;
    let mut times: Vec<i64> = attempt
        .evaluations
        .iter()
        .filter(|e| !matches!(e.provenance.as_str(), "human" | "human_visual"))
        .map(|e| e.created_at)
        .filter(|at| *at > finished)
        .collect();
    times.sort_unstable();
    Some(
        std::iter::once(finished)
            .chain(times)
            .find(|at| score_as_of(attempt, Some(*at)).is_some())
            .unwrap_or(finished),
    )
}

/// One data read supplies both the dated archive and the recalculated series.
/// Every non-preview run that settled cells of this configuration is one
/// observation whatever its state: its repetitions and any verdict given on
/// them later belong to that one point, never to points of their own. A run
/// is observed when its last counted cell settled, so a window that closed a
/// day later never re-dates what was measured.
pub fn history(data: &QueryData, configuration: &Configuration) -> Vec<HistorySnapshot> {
    history_for(data, configuration, false)
}

pub fn model_history(data: &QueryData, configuration: &Configuration) -> Vec<HistorySnapshot> {
    history_for(data, configuration, true)
}

pub(super) fn history_for(
    data: &QueryData,
    configuration: &Configuration,
    by_model: bool,
) -> Vec<HistorySnapshot> {
    history_observations(
        data,
        configuration,
        by_model,
        |key, own, current, at, run_id| {
            // As the board stood at the run's end, with the model's own cases
            // counted: a history compares the model with itself.
            let report = leaderboard_counting(
                data,
                &ResultQuery {
                    as_of: Some(at),
                    limit: Some(500),
                    ..Default::default()
                },
                OwnCases::Counted,
            );
            let (recalculated_report, backfilled_version_ids, revised_version_ids) =
                recalculated_history_report(data, own, current, run_id, at, by_model);
            // A run that left the board as it stood, a cancel before any cell
            // ran, adds no point of its own.
            let signature = history_row_signature(&report, key, by_model)
                .or_else(|| history_row_signature(&recalculated_report, key, by_model))?;
            Some((
                signature,
                HistorySnapshot {
                    id: format!("{run_id}:{at}"),
                    run_id: run_id.to_owned(),
                    created_at: at,
                    report,
                    recalculated_report,
                    backfilled_version_ids,
                    revised_version_ids,
                },
            ))
        },
    )
}

pub(super) fn history_row_signature(
    report: &LeaderboardReport,
    key: &str,
    by_model: bool,
) -> Option<String> {
    let row = if by_model {
        report
            .models
            .iter()
            .find(|model| model.key == key)
            .map(|model| &model.row)
    } else {
        report
            .rows
            .iter()
            .find(|row| leaderboard_key(&row.configuration) == key)
    }?;
    Some(
        serde_json::to_string(&(row.points, &row.attempt_ids, &row.comparison_key, row.cost))
            .unwrap_or_default(),
    )
}

/// These groups bound the rows before ranking, including superseded-only
/// groups. Filtering the row source is safe only when neither full board can
/// truncate a row: otherwise a target outside the first 500 would reappear.
pub(super) fn history_groups_fit(
    data: &QueryData,
    prepared: &PreparedMeasurements<'_>,
    pool: &[&BenchmarkVersion],
    at: i64,
) -> bool {
    let pool_ids: BTreeSet<&str> = pool.iter().map(|version| version.id.as_str()).collect();
    let mut configurations = BTreeSet::new();
    let mut models = BTreeSet::new();
    for attempt in &data.attempts {
        if !pool_ids.contains(attempt.version_id.as_str())
            || !prepared.runs.contains_key(attempt.run_id.as_str())
            || attempt.finished_at.is_none_or(|finished| finished > at)
        {
            continue;
        }
        let configuration = ledger_configuration(attempt, &prepared.acknowledged);
        configurations.insert(leaderboard_key(&configuration));
        models.insert(model_key(&configuration));
        if configurations.len() > 500 || models.len() > 500 {
            return false;
        }
    }
    true
}

pub(super) fn dated_model_history_signature(
    data: &QueryData,
    key: &str,
    own: &[&Attempt],
    at: i64,
) -> Option<String> {
    let query = ResultQuery {
        as_of: Some(at),
        limit: Some(500),
        ..Default::default()
    };
    let pool = ranked_pool(data, &query);
    // Peer baselines and review cutoffs always see the full ledger. Only row
    // materialization can omit peers; filtering QueryData would change points.
    let prepared = PreparedMeasurements::new(data, &query, &pool);
    let all;
    let source = if history_groups_fit(data, &prepared, &pool, at) {
        own
    } else {
        all = data.attempts.iter().collect::<Vec<_>>();
        &all
    };
    let report = leaderboard_prepared(data, &query, source, pool, OwnCases::Counted, &prepared);
    history_row_signature(&report, key, true)
}

/// A smaller read for the model page. Observation identity still comes from
/// the dated board; the UI receives its unchanged current-pool recalculation.
pub fn model_history_view(
    data: &QueryData,
    configuration: &Configuration,
) -> Vec<ModelHistoryViewPoint> {
    history_observations(
        data,
        configuration,
        true,
        |key, own, current, at, run_id| {
            let dated = dated_model_history_signature(data, key, own, at);
            let (recalculated_report, backfilled_version_ids, revised_version_ids) =
                recalculated_history_report(data, own, current, run_id, at, true);
            let signature =
                dated.or_else(|| history_row_signature(&recalculated_report, key, true))?;
            Some((
                signature,
                ModelHistoryViewPoint {
                    id: format!("{run_id}:{at}"),
                    run_id: run_id.to_owned(),
                    created_at: at,
                    recalculated_report,
                    backfilled_version_ids,
                    revised_version_ids,
                },
            ))
        },
    )
}

/// Both readers use the same eligible events, dates, peer preparation and
/// consecutive-signature collapse. The observer chooses which reports to keep.
pub(super) fn history_observations<T>(
    data: &QueryData,
    configuration: &Configuration,
    by_model: bool,
    mut observe: impl FnMut(
        &str,
        &[&Attempt],
        &CurrentHistoryPool<'_>,
        i64,
        &str,
    ) -> Option<(String, T)>,
) -> Vec<T> {
    let identity = if by_model { model_key } else { leaderboard_key };
    let key = identity(configuration);
    let ranked: BTreeSet<&str> = data
        .versions
        .iter()
        .filter(|v| is_ranked_split(&v.manifest.split))
        .map(|v| v.id.as_str())
        .collect();
    let runs: BTreeMap<_, _> = data
        .runs
        .iter()
        .filter(|r| !r.request.preview)
        .map(|r| (r.id.as_str(), r))
        .collect();
    let acknowledged = run_acknowledgments(&data.attempts);
    let own: Vec<&Attempt> = data
        .attempts
        .iter()
        .filter(|a| {
            runs.contains_key(a.run_id.as_str())
                && ranked.contains(a.version_id.as_str())
                && identity(&ledger_configuration(a, &acknowledged)) == key
        })
        .collect();
    // Today's pool: what every point is recalculated on.
    let current_pool = ranked_pool(data, &ResultQuery::default());
    let current: BTreeSet<&str> = current_pool.iter().map(|v| v.id.as_str()).collect();
    // The counted attempts of each run: its settled, unsuperseded cells.
    let mut cells: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
    for &a in &own {
        if !is_superseded(a) && a.phase == "terminal" && a.finished_at.is_some() {
            cells.entry(a.run_id.as_str()).or_default().push(a);
        }
    }
    // A run without a scored result must never borrow an older model score
    // and re-date it, even when a pool change makes that score look different.
    cells.retain(|run_id, attempts| {
        attempts.iter().any(|a| score(a).is_some())
            && (runs[run_id].baked_at.is_none()
                || current_pool.iter().any(|version| {
                    attempts
                        .iter()
                        .filter(|a| a.version_id == version.id && score(a).is_some())
                        .count() as u32
                        >= required_repetitions(data, version)
                }))
    });
    // A finished run is observed at its end; any other run, cancelled
    // included, when the last of its started cells settled, so a later
    // cancel or evaluation never re-dates it; a later evaluation stays an
    // event of its own.
    let mut observed: BTreeMap<&str, i64> = BTreeMap::new();
    for (run_id, attempts) in &cells {
        let run = runs[run_id];
        let at = if run.state == "completed" {
            run.updated_at
        } else {
            attempts
                .iter()
                .filter(|a| a.started_at.is_some())
                .filter_map(|a| settled_at(a))
                .max()
                // A run none of whose cells began work is dated by its own record.
                .unwrap_or(run.updated_at)
        };
        observed.insert(*run_id, at);
    }
    let events: BTreeSet<(i64, &str)> = observed.iter().map(|(run, at)| (*at, *run)).collect();
    if events.is_empty() {
        return Vec::new();
    }
    let current = CurrentHistoryPool {
        prepared: PreparedMeasurements::new(data, &ResultQuery::default(), &current_pool),
        versions: current_pool,
        ids: current,
    };
    newest_observations(events.into_iter().rev(), HISTORY_POINTS, |(at, run_id)| {
        observe(&key, &own, &current, at, run_id)
    })
}
