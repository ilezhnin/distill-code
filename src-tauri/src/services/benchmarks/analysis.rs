//! Per-case measurements and frozen baseline comparisons.
use super::types::*;
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn score(attempt: &Attempt) -> Option<f64> {
    score_as_of(attempt, None)
}

fn valid_score(score: &f64) -> bool {
    score.is_finite() && (0.0..=1.0).contains(score)
}

/// The judge panel's state over a list of evaluations in recorded order.
enum Panel {
    /// No render marker: the attempt was never sent to a panel.
    Absent,
    /// Markers exist, but no batch reached its panel size.
    Pending,
    /// The newest batch that reached its panel size: the index of its render
    /// marker and its valid votes.
    Settled { marker: usize, votes: Vec<f64> },
}

/// A batch runs from its render marker to the next one. The newest batch
/// whose valid votes reached its `expectedJudges` scores the attempt, so an
/// unfinished re-evaluation never hides a settled panel.
fn judge_panel(evaluations: &[&Evaluation]) -> Panel {
    let markers: Vec<usize> = evaluations
        .iter()
        .enumerate()
        .filter(|(_, e)| e.provenance == "render")
        .map(|(index, _)| index)
        .collect();
    if markers.is_empty() {
        return Panel::Absent;
    }
    for position in (0..markers.len()).rev() {
        let start = markers[position];
        let end = markers
            .get(position + 1)
            .copied()
            .unwrap_or(evaluations.len());
        let expected = evaluations[start]
            .details
            .as_ref()
            .and_then(|d| d["expectedJudges"].as_u64())
            .unwrap_or(1) as usize;
        let votes: Vec<f64> = evaluations[start..end]
            .iter()
            .filter(|e| e.provenance == "judge")
            .filter_map(|e| e.score)
            .filter(valid_score)
            .collect();
        if votes.len() >= expected {
            return Panel::Settled {
                marker: start,
                votes,
            };
        }
    }
    Panel::Pending
}

/// Read legacy records through their latest evidence without rewriting the archive.
pub(super) fn evaluation_outcome(evaluations: &[Evaluation]) -> Option<&str> {
    if let Some(human) = evaluations.iter().rev().find(|e| e.provenance == "human") {
        return Some(&human.verdict);
    }
    match judge_panel(&evaluations.iter().collect::<Vec<_>>()) {
        Panel::Settled { .. } => return Some("judged"),
        Panel::Pending => return Some("pending_review"),
        Panel::Absent => {}
    }
    evaluations
        .iter()
        .rev()
        .find(|e| !matches!(e.provenance.as_str(), "human_visual" | "judge_failure"))
        .map(|e| e.verdict.as_str())
}

pub(super) fn normalize_outcome(mut attempt: Attempt) -> Attempt {
    attempt.outcome = effective_outcome(attempt.outcome.as_deref(), &attempt.evaluations);
    attempt
}

/// The outcome shown for an attempt as it stood at `as_of`: none before it
/// finished, else the newest evidence recorded by then. Today's stored outcome
/// never stands in for a verdict that was recorded later.
pub(super) fn outcome_as_of(
    outcome: Option<&str>,
    finished_at: Option<i64>,
    evaluations: &[Evaluation],
    as_of: Option<i64>,
) -> Option<String> {
    let Some(at) = as_of else {
        return effective_outcome(outcome, evaluations);
    };
    if finished_at.is_none_or(|end| end > at) {
        return None;
    }
    let known: Vec<Evaluation> = evaluations
        .iter()
        .filter(|e| e.created_at <= at)
        .cloned()
        .collect();
    if has_quality_outcome(outcome)
        && !is_budget_failure(outcome)
        && known.iter().all(|e| e.provenance == "human_visual")
        && evaluations.iter().any(|e| e.provenance != "human_visual")
    {
        return Some("pending_review".into());
    }
    effective_outcome(outcome, &known)
}

pub(super) fn effective_outcome(
    outcome: Option<&str>,
    evaluations: &[Evaluation],
) -> Option<String> {
    if has_quality_outcome(outcome) && !is_budget_failure(outcome) {
        evaluation_outcome(evaluations)
            .or(outcome)
            .map(str::to_owned)
    } else {
        outcome.map(str::to_owned)
    }
}

/// An answer past the published artifact cap, or a turn the run's time limit
/// stopped, is a task failure, not an infrastructure exclusion: the candidate
/// chose that behavior, and a limit of hours is a safety stop that only a hung
/// turn reaches. Both score a fixed 0 that no later evaluation of the partial
/// output can change.
fn is_budget_failure(outcome: Option<&str>) -> bool {
    matches!(outcome, Some("budget_reached" | "budget_timeout"))
}

fn has_quality_outcome(outcome: Option<&str>) -> bool {
    matches!(
        outcome,
        Some(
            "pass"
                | "fail"
                | "judged"
                | "pending_review"
                | "completed"
                | "budget_reached"
                | "budget_timeout"
        )
    )
}

pub(super) fn score_as_of(attempt: &Attempt, as_of: Option<i64>) -> Option<f64> {
    score_of(
        attempt.outcome.as_deref(),
        attempt.finished_at,
        &attempt.evaluations,
        as_of,
    )
}

/// [`score_as_of`] from the parts of an attempt it reads, for a listing that
/// holds no full attempt.
pub(super) fn score_of(
    outcome: Option<&str>,
    finished_at: Option<i64>,
    recorded: &[Evaluation],
    as_of: Option<i64>,
) -> Option<f64> {
    if !has_quality_outcome(outcome) {
        return None;
    }
    if as_of.is_some_and(|at| finished_at.is_none_or(|finished| finished > at)) {
        return None;
    }
    if is_budget_failure(outcome) {
        return Some(0.0);
    }
    let evaluations: Vec<_> = recorded
        .iter()
        .filter(|e| as_of.is_none_or(|at| e.created_at <= at))
        .collect();
    if let Some(review) = evaluations.iter().rev().find(|e| e.provenance == "human") {
        return review.score.filter(valid_score);
    }
    match judge_panel(&evaluations) {
        Panel::Settled { votes, .. } => return median(votes),
        Panel::Pending => return None,
        Panel::Absent => {}
    }
    // Legacy judge votes recorded without a render marker.
    let judged: Vec<_> = evaluations
        .iter()
        .filter(|e| e.provenance == "judge")
        .filter_map(|e| e.score)
        .filter(valid_score)
        .collect();
    if !judged.is_empty() {
        return median(judged);
    }
    if let Some(evaluation) = evaluations
        .iter()
        .rev()
        .find(|e| e.provenance != "human_visual" && e.provenance != "judge_failure")
    {
        return evaluation.score.filter(valid_score);
    }
    // Evaluated attempts get their score only from evidence available at the
    // cutoff. Today's mutable outcome cannot fill an earlier missing verdict.
    if recorded.iter().any(|e| e.provenance != "human_visual") {
        return None;
    }
    match outcome? {
        "pass" => Some(1.0),
        "fail" => Some(0.0),
        _ => None,
    }
}

pub(crate) fn configuration_key(configuration: &Configuration) -> String {
    // IDs are UI labels, not evidence of equivalent execution conditions.
    serde_json::to_string(&(
        &configuration.provider_id,
        &configuration.account_id,
        &configuration.model_id,
        &configuration.effort,
        configuration.fast_mode,
        &configuration.billing_mode,
        &configuration.execution_profile,
        &configuration.inventory_revision,
    ))
    .unwrap_or_default()
}

/// The runner marks a single attempt that made auxiliary model calls with an
/// `_auxiliary` profile. That is attempt evidence, not a separate candidate.
fn ledger_profile(profile: &str) -> &str {
    profile.strip_suffix("_auxiliary").unwrap_or(profile)
}

fn has_auxiliary_usage(attempt: &Attempt) -> bool {
    attempt.usage.schema.contains("auxiliary")
        || execution_configuration(attempt)
            .execution_profile
            .ends_with("_auxiliary")
}

/// Runtime probes, omitted defaults and auxiliary-call markers do not create
/// new leaderboard candidates. A model id its vendor moves to another model
/// (`NativeProvider::moving_aliases`) is a candidate per display name, so
/// Kimi's `kimi-for-coding` as K2.7 Code and as K2.8 Preview are two rows;
/// every other key is unchanged by that.
pub(super) fn leaderboard_key(configuration: &Configuration) -> String {
    let identity = (
        &configuration.provider_id,
        &configuration.account_id,
        &configuration.model_id,
        configuration
            .effort
            .as_deref()
            .filter(|effort| !effort.is_empty())
            .unwrap_or("default"),
        configuration.fast_mode.unwrap_or(false),
        &configuration.billing_mode,
        ledger_profile(&configuration.execution_profile),
    );
    if on_moving_alias(configuration) {
        serde_json::to_string(&(identity, &configuration.model_name))
    } else {
        serde_json::to_string(&identity)
    }
    .unwrap_or_default()
}

/// Whether a configuration is on a model id its vendor moves between models.
fn on_moving_alias(configuration: &Configuration) -> bool {
    crate::services::agent_host::execution::NativeProvider::for_harness(&configuration.provider_id)
        .is_some_and(|provider| {
            provider
                .moving_aliases()
                .contains(&configuration.model_id.as_str())
        })
}

/// Whether an acknowledged selection is the one asked for: the same model,
/// and the requested effort and fast mode wherever the request set them.
pub(crate) fn matches_selection(requested: &Configuration, observed: &Configuration) -> bool {
    requested.model_id == observed.model_id
        && requested
            .effort
            .as_ref()
            .is_none_or(|e| Some(e) == observed.effort.as_ref())
        && requested
            .fast_mode
            .is_none_or(|f| Some(f) == observed.fast_mode)
}

/// What ran. A refused selection (another model, effort or fast mode) stays
/// with the candidate that was asked for; where that request left effort or
/// fast mode to the provider, the requested model's acknowledged value fills it.
pub(crate) fn execution_configuration(attempt: &Attempt) -> Cow<'_, Configuration> {
    let requested = &attempt.configuration;
    let Some(observed) = attempt
        .observed
        .as_ref()
        .filter(|observed| observed.model_id == requested.model_id)
    else {
        return Cow::Borrowed(requested);
    };
    if attempt.outcome.as_deref() != Some("selection_changed")
        || matches_selection(requested, observed)
    {
        return Cow::Borrowed(observed);
    }
    let mut asked = requested.clone();
    if asked.effort.is_none() {
        asked.effort = observed.effort.clone();
    }
    if asked.fast_mode.is_none() {
        asked.fast_mode = observed.fast_mode;
    }
    Cow::Owned(asked)
}

/// Each run's newest attempt that acknowledged its requested model, by run and
/// requested configuration, for requests that left effort or fast mode to the
/// provider.
type Acknowledgments<'a> = BTreeMap<(&'a str, String), &'a Attempt>;

fn run_acknowledgments(attempts: &[Attempt]) -> Acknowledgments<'_> {
    let mut acknowledged: Acknowledgments<'_> = BTreeMap::new();
    for attempt in attempts.iter().filter(|a| {
        (a.configuration.effort.is_none() || a.configuration.fast_mode.is_none())
            && a.observed
                .as_ref()
                .is_some_and(|observed| observed.model_id == a.configuration.model_id)
    }) {
        let newest = acknowledged
            .entry((
                attempt.run_id.as_str(),
                configuration_key(&attempt.configuration),
            ))
            .or_insert(attempt);
        if (attempt.started_at, &attempt.id) > (newest.started_at, &newest.id) {
            *newest = attempt;
        }
    }
    acknowledged
}

/// What ran, as the ledger counts it. An attempt with no acknowledgment of
/// its requested model (refused before a session existed, or still waiting)
/// fills the effort and fast mode its request left to the provider from what
/// the same request acknowledged in its run, so it stays on that row.
fn ledger_configuration<'a>(
    attempt: &'a Attempt,
    acknowledged: &Acknowledgments<'_>,
) -> Cow<'a, Configuration> {
    let configuration = execution_configuration(attempt);
    let requested = &attempt.configuration;
    if (requested.effort.is_some() && requested.fast_mode.is_some())
        || attempt
            .observed
            .as_ref()
            .is_some_and(|observed| observed.model_id == requested.model_id)
    {
        return configuration;
    }
    let Some(sibling) = acknowledged.get(&(attempt.run_id.as_str(), configuration_key(requested)))
    else {
        return configuration;
    };
    let seen = execution_configuration(sibling);
    let mut filled = configuration.into_owned();
    if filled.effort.is_none() {
        filled.effort = seen.effort.clone();
    }
    if filled.fast_mode.is_none() {
        filled.fast_mode = seen.fast_mode;
    }
    Cow::Owned(filled)
}

/// What ran, as Nerf pairs it: the strict configuration, except that an
/// attempt which also called an auxiliary model stays its configuration's
/// evidence.
fn nerf_configuration(attempt: &Attempt) -> Cow<'_, Configuration> {
    let mut configuration = execution_configuration(attempt);
    if configuration.execution_profile.ends_with("_auxiliary") {
        let profile = ledger_profile(&configuration.execution_profile).to_owned();
        configuration.to_mut().execution_profile = profile;
    }
    configuration
}

fn nerf_key(attempt: &Attempt) -> String {
    configuration_key(&nerf_configuration(attempt))
}

/// The conditions a run measured under: its suite, repetitions and timeout.
/// The execution cap only admits a plan, so it is not a condition.
fn conditions<'a>(
    versions: impl IntoIterator<Item = &'a String>,
    repetitions: u32,
    timeout_seconds: u32,
) -> String {
    let versions: BTreeSet<&String> = versions.into_iter().collect();
    serde_json::to_string(&(versions, repetitions, timeout_seconds)).unwrap_or_default()
}

fn cohort(run: &BenchmarkRun) -> String {
    let request = &run.request;
    conditions(
        &request.version_ids,
        request.repetitions,
        request.timeout_seconds,
    )
}

/// Each frozen configuration's conditions, taken from the baseline runs that
/// produced its snapshots. The requested configuration may leave effort or
/// fast mode unset while the snapshots carry the observed values, so the
/// request's own configuration list cannot identify them. Runs of one
/// configuration with the same repetitions and timeout freeze the union of
/// their suites, so a run and its catch-up pair with one follow-up over both.
/// A snapshot without a recorded request adds an unmatchable condition.
pub(super) fn frozen_conditions(baseline: &Baseline) -> BTreeMap<String, BTreeSet<String>> {
    let requests: BTreeMap<&str, &RunRequest> = baseline
        .run_ids
        .iter()
        .map(String::as_str)
        .zip(&baseline.run_conditions)
        .collect();
    let mut runs: BTreeMap<String, BTreeSet<&str>> = BTreeMap::new();
    for attempt in &baseline.snapshots {
        runs.entry(nerf_key(attempt))
            .or_default()
            .insert(attempt.run_id.as_str());
    }
    runs.into_iter()
        .map(|(key, run_ids)| {
            let mut frozen = BTreeSet::new();
            let mut suites: BTreeMap<(u32, u32), BTreeSet<&String>> = BTreeMap::new();
            for id in run_ids {
                match requests.get(id) {
                    Some(request) => suites
                        .entry((request.repetitions, request.timeout_seconds))
                        .or_default()
                        .extend(&request.version_ids),
                    None => {
                        frozen.insert(String::new());
                    }
                }
            }
            for ((repetitions, timeout_seconds), versions) in suites {
                frozen.insert(conditions(versions, repetitions, timeout_seconds));
            }
            (key, frozen)
        })
        .collect()
}

/// The follow-up run of each frozen configuration: its newest completed run
/// after the baseline under that configuration's frozen conditions, else its
/// newest one, which then reports changed conditions.
fn selected_runs<'a>(
    data: &'a QueryData,
    baseline: &Baseline,
    frozen: &BTreeMap<String, BTreeSet<String>>,
    query: &ResultQuery,
) -> BTreeMap<String, &'a BenchmarkRun> {
    let mut selected = BTreeMap::new();
    for (key, conditions) in frozen {
        let candidates: Vec<_> =
            data.runs
                .iter()
                .filter(|run| {
                    !run.request.preview
                        && run.state == "completed"
                        && run.created_at > baseline.created_at
                        && !baseline.run_ids.contains(&run.id)
                        && query.run_id.as_ref().is_none_or(|id| id == &run.id)
                        && query.as_of.is_none_or(|at| run.updated_at <= at)
                        && query.version_ids.as_ref().is_none_or(|ids| {
                            ids.iter().all(|id| run.request.version_ids.contains(id))
                        })
                        && data
                            .attempts
                            .iter()
                            .any(|a| a.run_id == run.id && nerf_key(a) == *key)
                })
                .collect();
        let matching = candidates
            .iter()
            .copied()
            .filter(|run| conditions.contains(&cohort(run)))
            .max_by_key(|run| (run.created_at, &run.id));
        if let Some(run) = matching.or_else(|| {
            candidates
                .into_iter()
                .max_by_key(|run| (run.created_at, &run.id))
        }) {
            selected.insert(key.clone(), run);
        }
    }
    selected
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    })
}

/// A measured share as points out of 1000.
pub fn share_points(share: f64) -> u32 {
    (share * 1000.0).round().clamp(0.0, 1000.0) as u32
}

/// A case counts only once its newest cell holds this many scored repetitions:
/// one pass proves nothing about a model that will do the work unattended.
/// The ledger reads it from `QueryData::required_repetitions`; a case may
/// declare more in its manifest.
pub const REQUIRED_REPETITIONS: u32 = 3;

/// The repetitions a case's cell needs: the ledger's protocol or the case's
/// own declaration, whichever asks for more.
pub(super) fn required_repetitions(data: &QueryData, version: &BenchmarkVersion) -> u32 {
    data.required_repetitions
        .max(version.manifest.repetitions)
        .max(1)
}

/// How a solved case's points split: reliability first, then how fast and how
/// cheaply it was solved against the best measurement of that case. Speed and
/// cost are compared only among candidates that solved the case, so a cheap
/// wrong answer earns nothing. A missing measurement gives up its weight to
/// the others in proportion.
const RELIABILITY_WEIGHT: f64 = 0.8;
const SPEED_WEIGHT: f64 = 0.15;
const COST_WEIGHT: f64 = 0.05;

/// One configuration's settled measurement of one case.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct CaseCell {
    /// 1 when every repetition passed, 0 when any failed; a judged case takes
    /// the mean of its repetitions' panel scores instead.
    pub reward: f64,
    /// Median wall-clock over the repetitions.
    pub duration_ms: Option<f64>,
    /// Mean spend per repetition; unknown when any repetition's is.
    pub cost: Option<f64>,
    pub repetitions: u32,
}

/// How the pool reads a case: the repetitions its cell needs, and whether it
/// is scored on a scale rather than pass or fail.
#[derive(Clone, Copy)]
pub(super) struct CaseProtocol<'a> {
    pub required: &'a dyn Fn(&str) -> u32,
    pub graded: &'a dyn Fn(&str) -> bool,
}

/// The cells of a set of attempts, by case: every repetition scored and at
/// least as many of them as the case requires.
pub(super) fn case_cells<'a>(
    attempts: &[&'a Attempt],
    as_of: Option<i64>,
    protocol: CaseProtocol<'_>,
) -> BTreeMap<&'a str, CaseCell> {
    let (required, graded) = (protocol.required, protocol.graded);
    let mut by_case: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
    for attempt in attempts {
        by_case
            .entry(attempt.version_id.as_str())
            .or_default()
            .push(attempt);
    }
    by_case
        .into_iter()
        .filter_map(|(version, list)| {
            let scores: Vec<f64> = list
                .iter()
                .map(|a| score_as_of(a, as_of))
                .collect::<Option<_>>()?;
            if (scores.len() as u32) < required(version) {
                return None;
            }
            let reward = if graded(version) {
                scores.iter().sum::<f64>() / scores.len() as f64
            } else if scores.iter().all(|s| *s == 1.0) {
                1.0
            } else {
                0.0
            };
            let costs: Option<Vec<f64>> = list.iter().map(|a| a.usage.cost).collect();
            Some((
                version,
                CaseCell {
                    reward,
                    duration_ms: median(
                        list.iter()
                            .filter_map(|a| a.duration_ms.map(|v| v as f64))
                            .collect(),
                    ),
                    cost: costs.map(|c| c.iter().sum::<f64>() / c.len() as f64),
                    repetitions: scores.len() as u32,
                },
            ))
        })
        .collect()
}

/// The fastest and cheapest solved cell of each case: what speed and cost are
/// measured against. Every settled cell of every candidate counts, so the
/// record does not depend on which rows a report happens to hold.
pub(super) type CaseRecords = BTreeMap<String, (Option<f64>, Option<f64>)>;

pub(super) fn case_records(
    attempts: &[Attempt],
    runs: &BTreeMap<&str, &BenchmarkRun>,
    as_of: Option<i64>,
    protocol: CaseProtocol<'_>,
) -> CaseRecords {
    let graded = protocol.graded;
    let acknowledged = run_acknowledgments(attempts);
    let mut cells: BTreeMap<(String, &str), Vec<&Attempt>> = BTreeMap::new();
    for attempt in attempts {
        if !runs.contains_key(attempt.run_id.as_str()) {
            continue;
        }
        let key = leaderboard_key(&ledger_configuration(attempt, &acknowledged));
        cells
            .entry((key, attempt.run_id.as_str()))
            .or_default()
            .push(attempt);
    }
    let mut records = CaseRecords::new();
    for list in cells.values() {
        for (version, cell) in case_cells(list, as_of, protocol) {
            if (cell.reward < 1.0 && !graded(version)) || cell.reward <= 0.0 {
                continue;
            }
            let entry = records.entry(version.to_owned()).or_insert((None, None));
            entry.0 = min_of(entry.0, cell.duration_ms);
            entry.1 = min_of(entry.1, cell.cost);
        }
    }
    records
}

fn min_of(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// A solved case's share of its best measurement: 1 at the record, 0.5 at
/// twice the record's time or spend.
fn share_of_record(record: Option<f64>, value: Option<f64>) -> Option<f64> {
    match (record, value) {
        (Some(record), Some(value)) if value > 0.0 => Some((record / value).clamp(0.0, 1.0)),
        (Some(_), Some(_)) => Some(1.0),
        _ => None,
    }
}

/// What one case adds to a board, 0 to 1, with the speed and cost shares that
/// went into it.
pub(super) struct CasePoints {
    pub points: f64,
    pub speed: Option<f64>,
    pub cost: Option<f64>,
}

pub(super) fn case_points(
    cell: &CaseCell,
    record: Option<&(Option<f64>, Option<f64>)>,
) -> CasePoints {
    let (best_duration, best_cost) = record.copied().unwrap_or((None, None));
    let speed = share_of_record(best_duration, cell.duration_ms);
    let cost = share_of_record(best_cost, cell.cost);
    if cell.reward <= 0.0 {
        return CasePoints {
            points: 0.0,
            speed: None,
            cost: None,
        };
    }
    let mut weight = RELIABILITY_WEIGHT;
    let mut sum = RELIABILITY_WEIGHT;
    if let Some(speed) = speed {
        weight += SPEED_WEIGHT;
        sum += SPEED_WEIGHT * speed;
    }
    if let Some(cost) = cost {
        weight += COST_WEIGHT;
        sum += COST_WEIGHT * cost;
    }
    CasePoints {
        points: cell.reward * sum / weight,
        speed,
        cost,
    }
}

/// A board over a set of cells: solved cases, the mean reward, the points and
/// the mean speed and cost shares of the solved cases.
pub(super) struct BoardStats {
    pub passed: u32,
    pub scored: u32,
    pub quality: Option<f64>,
    pub points: Option<u32>,
    pub speed_share: Option<f64>,
    pub cost_share: Option<f64>,
}

pub(super) fn board_stats(cells: &BTreeMap<&str, CaseCell>, records: &CaseRecords) -> BoardStats {
    let scored = cells.len() as u32;
    if scored == 0 {
        return BoardStats {
            passed: 0,
            scored,
            quality: None,
            points: None,
            speed_share: None,
            cost_share: None,
        };
    }
    let mut points = 0.0;
    let mut speeds = Vec::new();
    let mut costs = Vec::new();
    for (version, cell) in cells {
        let case = case_points(cell, records.get(*version));
        points += case.points;
        speeds.extend(case.speed);
        costs.extend(case.cost);
    }
    let mean = |values: &[f64]| {
        (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
    };
    BoardStats {
        passed: cells.values().filter(|cell| cell.reward >= 1.0).count() as u32,
        scored,
        quality: Some(cells.values().map(|cell| cell.reward).sum::<f64>() / scored as f64),
        points: Some(share_points(points / scored as f64)),
        speed_share: mean(&speeds),
        cost_share: mean(&costs),
    }
}

/// The current pool: the latest published version of every live definition,
/// or one run's suite when a run is asked for, narrowed by any version filter.
/// A dated query takes the pool as it stood then, so a later publication,
/// archive or restore never rewrites an earlier observation.
pub(super) fn pool<'a>(data: &'a QueryData, query: &ResultQuery) -> Vec<&'a BenchmarkVersion> {
    let as_of = query.as_of;
    let versions: BTreeMap<&str, &BenchmarkVersion> =
        data.versions.iter().map(|v| (v.id.as_str(), v)).collect();
    // An archived definition is live before its archive time. Definitions
    // archived before that time was recorded were still live through the
    // last run that planned one of their versions.
    let mut archived: BTreeMap<&str, i64> = data
        .definitions
        .iter()
        .filter(|definition| definition.archived)
        .map(|definition| {
            (
                definition.id.as_str(),
                definition.archived_at.map_or(i64::MIN, |at| at - 1),
            )
        })
        .collect();
    let legacy: BTreeSet<&str> = data
        .definitions
        .iter()
        .filter(|definition| definition.archived && definition.archived_at.is_none())
        .map(|definition| definition.id.as_str())
        .collect();
    // A restored definition stays retired inside every period it was archived.
    let periods: BTreeMap<&str, &[(i64, i64)]> = data
        .definitions
        .iter()
        .filter(|definition| !definition.archive_history.is_empty())
        .map(|definition| {
            (
                definition.id.as_str(),
                definition.archive_history.as_slice(),
            )
        })
        .collect();
    let archived_then = |definition: &str, at: i64| {
        periods
            .get(definition)
            .is_some_and(|list| list.iter().any(|(from, until)| *from <= at && at < *until))
    };
    if as_of.is_some() && !legacy.is_empty() {
        for run in data.runs.iter().filter(|run| !run.request.preview) {
            for id in &run.request.version_ids {
                if let Some(live_until) = versions
                    .get(id.as_str())
                    .filter(|v| legacy.contains(v.definition_id.as_str()))
                    .and_then(|v| archived.get_mut(v.definition_id.as_str()))
                {
                    *live_until = (*live_until).max(run.updated_at);
                }
            }
        }
    }
    let mut pool: Vec<&BenchmarkVersion> = match query
        .run_id
        .as_ref()
        .and_then(|id| data.runs.iter().find(|run| &run.id == id))
    {
        Some(run) => run
            .request
            .version_ids
            .iter()
            .filter_map(|id| versions.get(id.as_str()).copied())
            .collect(),
        None => {
            let mut latest: BTreeMap<&str, &BenchmarkVersion> = BTreeMap::new();
            for version in &data.versions {
                let retired = archived
                    .get(version.definition_id.as_str())
                    .is_some_and(|live_until| as_of.is_none_or(|at| at > *live_until))
                    || as_of.is_some_and(|at| archived_then(&version.definition_id, at));
                if retired || as_of.is_some_and(|at| version.published_at > at) {
                    continue;
                }
                let entry = latest
                    .entry(version.definition_id.as_str())
                    .or_insert(version);
                if version.published_at > entry.published_at {
                    *entry = version;
                }
            }
            latest.into_values().collect()
        }
    };
    if let Some(ids) = &query.version_ids {
        pool.retain(|version| ids.contains(&version.id));
    }
    pool.sort_by(|a, b| a.id.cmp(&b.id));
    pool
}

/// A run's cell replaces an older one only when every planned repetition settled
/// with a valid score and the run planned at least `required` of them: a quick
/// check of fewer repetitions never displaces a measurement. Cancelled,
/// interrupted, failed-infrastructure, pending or partial retests keep the
/// previous cell; scored failures do replace it. A case with no scored cell
/// keeps its newest settled cell that began work, so paid spend stays visible;
/// a cell that never ran is a plain gap.
pub(super) fn latest_cell_attempts<'a>(
    attempts: &[&'a Attempt],
    runs: &BTreeMap<&str, &BenchmarkRun>,
    as_of: Option<i64>,
    required: u32,
) -> Vec<&'a Attempt> {
    let mut groups: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
    for attempt in attempts {
        groups.entry(&attempt.run_id).or_default().push(attempt);
    }
    let settled: Vec<(&str, Vec<&Attempt>)> = groups
        .into_iter()
        .filter(|(id, list)| {
            let run = runs[id];
            list.len() == run.request.repetitions as usize
                && list.iter().all(|a| {
                    a.phase == "terminal"
                        && a.finished_at
                            .is_some_and(|at| as_of.is_none_or(|cutoff| at <= cutoff))
                })
        })
        .collect();
    let newest = |accept: &dyn Fn(&[&Attempt]) -> bool| {
        settled
            .iter()
            .filter(|(_, list)| accept(list))
            .max_by_key(|(id, _)| (runs[id].created_at, *id))
            .map(|(_, list)| list.clone())
    };
    newest(&|list| {
        list.len() >= required as usize && list.iter().all(|a| score_as_of(a, as_of).is_some())
    })
    .or_else(|| newest(&|list| list.iter().any(|a| a.started_at.is_some())))
    .unwrap_or_default()
}

/// The spend a ledger row reports: scored cells as measured, and unscored cells
/// only through the repetitions that began work, and only when all of those
/// report their spend. A repetition that never ran spent nothing, and a cell
/// whose spend is unknown is a gap for cost, never free.
fn spent_attempts<'a>(attempts: &[&'a Attempt], scored: &BTreeSet<&str>) -> Vec<&'a Attempt> {
    let unscored: BTreeSet<&str> = attempts
        .iter()
        .filter(|a| !scored.contains(a.version_id.as_str()))
        .map(|a| a.version_id.as_str())
        .collect();
    let unknown: BTreeSet<&str> = attempts
        .iter()
        .filter(|a| unscored.contains(a.version_id.as_str()))
        .filter(|a| a.started_at.is_some() && a.usage.cost.is_none())
        .map(|a| a.version_id.as_str())
        .collect();
    attempts
        .iter()
        .copied()
        .filter(|a| {
            !unscored.contains(a.version_id.as_str())
                || (a.started_at.is_some() && !unknown.contains(a.version_id.as_str()))
        })
        .collect()
}

/// The candidate's own generation spend per task: repetitions are averaged
/// within a case, then cases are averaged. Judge calls are the benchmark's
/// expense and stay on their evaluations. Unknown spend is never free.
pub(super) fn mean_case_cost(attempts: &[&Attempt], as_of: Option<i64>) -> Option<f64> {
    let mut cases: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
    for attempt in attempts {
        // Spend of an attempt that finished after the cutoff was not known then.
        if as_of.is_some_and(|at| attempt.finished_at.is_none_or(|end| end > at)) {
            return None;
        }
        let cost = attempt.usage.cost?;
        cases.entry(&attempt.version_id).or_default().push(cost);
    }
    (!cases.is_empty()).then(|| {
        cases
            .values()
            .map(|values| values.iter().sum::<f64>() / values.len() as f64)
            .sum::<f64>()
            / cases.len() as f64
    })
}

/// The leaderboard is a ledger over the current pool of cases: for every
/// configuration and case the newest run's attempts stand, repetitions are
/// averaged per case, coverage is counted against the pool, and a rank needs
/// every case measured. Adding a case adds a gap to fill, never a reset.
pub fn leaderboard(data: &QueryData, query: &ResultQuery) -> LeaderboardReport {
    leaderboard_from_attempts(data, query, &data.attempts.iter().collect::<Vec<_>>())
}

fn leaderboard_from_attempts(
    data: &QueryData,
    query: &ResultQuery,
    source: &[&Attempt],
) -> LeaderboardReport {
    let pool = pool(data, query);
    let pool_ids: BTreeSet<&str> = pool.iter().map(|v| v.id.as_str()).collect();
    let runs: BTreeMap<&str, &BenchmarkRun> = data
        .runs
        .iter()
        .filter(|run| !run.request.preview)
        .filter(|run| query.run_id.as_ref().is_none_or(|id| id == &run.id))
        .filter(|run| query.as_of.is_none_or(|at| run.created_at <= at))
        .map(|run| (run.id.as_str(), run))
        .collect();
    let work_classes: Vec<String> = pool
        .iter()
        .map(|v| v.manifest.work_class_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let work_class = |version_id: &str| {
        pool.iter()
            .find(|v| v.id == version_id)
            .map(|v| v.manifest.work_class_id.as_str())
            .unwrap_or("unknown")
    };
    let graded = |version_id: &str| {
        pool.iter()
            .find(|v| v.id == version_id)
            .is_some_and(|v| v.manifest.evaluator.kind == "rubric")
    };
    let required = |version_id: &str| {
        pool.iter()
            .find(|v| v.id == version_id)
            .map_or(data.required_repetitions.max(1), |v| {
                required_repetitions(data, v)
            })
    };
    let protocol = CaseProtocol {
        required: &required,
        graded: &graded,
    };
    let records = case_records(&data.attempts, &runs, query.as_of, protocol);
    let acknowledged = run_acknowledgments(&data.attempts);
    // Every attempt on a pool case from a counted run, by configuration and case.
    let mut cells: BTreeMap<String, (Configuration, BTreeMap<&str, Vec<&Attempt>>)> =
        BTreeMap::new();
    for &attempt in source {
        if !pool_ids.contains(attempt.version_id.as_str())
            || !runs.contains_key(attempt.run_id.as_str())
            || query
                .as_of
                .is_some_and(|at| attempt.finished_at.is_none_or(|finished| finished > at))
        {
            continue;
        }
        let configuration = ledger_configuration(attempt, &acknowledged);
        let entry = cells
            .entry(leaderboard_key(&configuration))
            .or_insert_with(|| (configuration.into_owned(), BTreeMap::new()));
        entry
            .1
            .entry(attempt.version_id.as_str())
            .or_default()
            .push(attempt);
    }
    let mut contributing: BTreeSet<&str> = BTreeSet::new();
    let mut rows: Vec<LeaderboardRow> = cells
        .into_values()
        .map(|(mut configuration, by_case)| {
            // Per case, the newest run's attempts stand; older measurements are superseded.
            let mut attempts: Vec<&Attempt> = Vec::new();
            for (version, list) in by_case {
                attempts.extend(latest_cell_attempts(&list, &runs, query.as_of, required(version)));
            }
            // Keep the newest concrete configuration for catch-up execution;
            // each attempt retains its original runtime and account evidence.
            if let Some(latest) = attempts.iter().max_by_key(|attempt| {
                (runs[attempt.run_id.as_str()].created_at, attempt.started_at, &attempt.id)
            }) {
                configuration = ledger_configuration(latest, &acknowledged).into_owned();
            }
            // Catch-up pins this configuration, so it carries the runnable profile.
            configuration.execution_profile =
                ledger_profile(&configuration.execution_profile).to_owned();
            let eligible: Vec<&BenchmarkVersion> = pool
                .iter()
                .copied()
                .filter(|v| !super::routing::authored_by_candidate(&v.manifest, &configuration))
                .collect();
            let excluded = pool.len() as u32 - eligible.len() as u32;
            attempts.retain(|a| eligible.iter().any(|v| v.id == a.version_id));
            for attempt in &attempts {
                contributing.insert(attempt.run_id.as_str());
            }
            if eligible.is_empty() {
                return LeaderboardRow {
                    comparison_key: String::new(),
                    configuration, passed: 0, scored: 0, attempted: 0, planned: 0, quality: None,
                    median_duration_ms: None, median_output_tokens: None, cost: None, measured_at: None,
                    points: None, speed_share: None, cost_share: None,
                    status: "excluded".into(),
                    reason: format!("{excluded} cases excluded: this candidate helped author every case in the pool"),
                    attempt_ids: Vec::new(),
                    result_attempt_ids: Vec::new(),
                    axes: Vec::new(),
                    missing_version_ids: Vec::new(),
                    unsupported_version_ids: Vec::new(),
                    scored_version_ids: Vec::new(),
                    resolved_models: Vec::new(),
                };
            }
            let planned = eligible.len() as u32;
            let attempted = attempts
                .iter()
                .filter(|a| a.started_at.is_some())
                .map(|a| a.version_id.as_str())
                .collect::<BTreeSet<_>>()
                .len() as u32;
            let cells = case_cells(&attempts, query.as_of, protocol);
            let scored_versions: BTreeSet<&str> = cells.keys().copied().collect();
            let scored_attempts: Vec<&Attempt> = attempts.iter().copied()
                .filter(|a| scored_versions.contains(a.version_id.as_str())).collect();
            let spent = spent_attempts(&attempts, &scored_versions);
            let cost = mean_case_cost(&spent, query.as_of);
            let standard_budgets = attempts.iter().all(|a| {
                eligible.iter().find(|v| v.id == a.version_id).is_some_and(|v|
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
                    let stats = board_stats(&subset, &records);
                    LeaderboardAxis {
                        id: class.clone(),
                        quality: stats.quality,
                        points: stats.points,
                        speed_share: stats.speed_share,
                        cost_share: stats.cost_share,
                        passed: stats.passed,
                        scored: stats.scored,
                        planned: cases,
                    }
                })
                .collect();
            let overall = board_stats(&cells, &records);
            let measured_axes: Vec<&LeaderboardAxis> =
                axes.iter().filter(|axis| axis.scored > 0).collect();
            let points = (!measured_axes.is_empty()).then(|| {
                (measured_axes.iter().filter_map(|axis| axis.points).map(f64::from).sum::<f64>()
                    / measured_axes.len() as f64)
                    .round() as u32
            });
            let (passed, scored, quality) = (overall.passed, overall.scored, overall.quality);
            // A case without a score whose standing cell the provider refused
            // (an `unsupported` outcome, such as a model the account's plan
            // leaves out) is no gap a catch-up fills: asking again would
            // only pay for the same refusal. It is listed apart, for a run
            // the operator asks for.
            let unscored: Vec<&BenchmarkVersion> = eligible
                .iter()
                .copied()
                .filter(|v| !scored_attempts.iter().any(|a| a.version_id == v.id))
                .collect();
            let (unsupported_version_ids, missing_version_ids): (Vec<String>, Vec<String>) =
                unscored.iter().map(|v| v.id.clone()).partition(|id| {
                    attempts.iter().any(|a| {
                        &a.version_id == id && a.outcome.as_deref() == Some("unsupported")
                    })
                });
            LeaderboardRow {
                comparison_key: comparison_key(&scored_attempts, &runs, &pool, query.as_of),
                configuration,
                passed,
                scored,
                attempted,
                planned,
                quality,
                median_duration_ms: median(
                    scored_attempts
                        .iter()
                        .filter_map(|a| a.duration_ms.map(|v| v as f64))
                        .collect(),
                ),
                // Auxiliary model calls inflate the counters; keep the figure pure.
                median_output_tokens: median(
                    scored_attempts
                        .iter()
                        .filter(|a| !has_auxiliary_usage(a))
                        .filter_map(|a| a.usage.output.map(|v| v as f64))
                        .collect(),
                ),
                cost,
                // Work that never began measured nothing, so it never dates the row.
                measured_at: scored_attempts.iter().chain(&spent).flat_map(|a| a.finished_at.into_iter().chain(
                    a.evaluations.iter().map(|e| e.created_at).filter(|at| query.as_of.is_none_or(|cutoff| *at <= cutoff))
                )).max(),
                points,
                speed_share: overall.speed_share,
                cost_share: overall.cost_share,
                status: if attempted == 0 {
                    "untested"
                } else if scored == planned && standard_budgets {
                    "comparable"
                } else {
                    "preliminary"
                }
                .into(),
                reason: format!(
                    "{scored}/{planned} cases measured on the current pool; the newest settled cell of {REQUIRED_REPETITIONS} repetitions per case counts, and every repetition must pass{}{}",
                    if excluded > 0 {
                        format!("; {excluded} cases authored by this candidate excluded")
                    } else {
                        String::new()
                    },
                    if standard_budgets { "" } else { "; a run shortened the published task budget, so no shared rank is assigned" }
                ),
                attempt_ids: attempts.iter().map(|a| a.id.clone()).collect(),
                result_attempt_ids: scored_attempts.iter().map(|a| a.id.clone()).collect(),
                axes,
                missing_version_ids,
                unsupported_version_ids,
                scored_version_ids: scored_attempts.iter().map(|a| a.version_id.clone())
                    .collect::<BTreeSet<_>>().into_iter().collect(),
                resolved_models: scored_attempts.iter().filter_map(|a| a.resolved_model.clone())
                    .collect::<BTreeSet<_>>().into_iter().collect(),
            }
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
    // Author exclusions can produce different measured pools. One reference set
    // keeps the shared rank: the full pool when a comparable row covers it, else
    // the set most comparable rows share (then the larger, then the first by id).
    // Only the rows whose set differs lose the rank.
    let mut ranked_sets: BTreeMap<&Vec<String>, usize> = BTreeMap::new();
    for row in rows.iter().filter(|r| r.status == "comparable") {
        *ranked_sets.entry(&row.scored_version_ids).or_default() += 1;
    }
    let full_pool: Vec<String> = pool.iter().map(|v| v.id.clone()).collect();
    let reference = if ranked_sets.contains_key(&full_pool) {
        Some(full_pool)
    } else {
        ranked_sets
            .iter()
            .max_by(|(a, x), (b, y)| x.cmp(y).then(a.len().cmp(&b.len())).then(b.cmp(a)))
            .map(|(set, _)| (*set).clone())
    };
    if let Some(reference) = reference {
        for row in rows
            .iter_mut()
            .filter(|r| r.status == "comparable" && r.scored_version_ids != reference)
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
    let rows = rows
        .into_iter()
        .skip(query.offset.unwrap_or(0) as usize)
        .take(query.limit.unwrap_or(100).min(500) as usize)
        .collect();
    LeaderboardReport { cohort, rows }
}

/// The automated evaluation that defines an attempt's scoring protocol: the
/// render marker of the judge batch that produced the score, else the newest
/// objective check or render marker. Judges and human reviews grade or
/// annotate one output; they are not a new protocol.
fn protocol_evaluation(attempt: &Attempt, as_of: Option<i64>) -> Option<&Evaluation> {
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

/// Provenance, evaluator revision and judge protocol hash of that evaluation.
fn evaluator_identity(attempt: &Attempt) -> String {
    let evaluation = protocol_evaluation(attempt, None);
    serde_json::to_string(&(
        evaluation.map(|e| (&e.provenance, &e.evaluator_revision)),
        evaluation
            .and_then(|e| e.details.as_ref())
            .and_then(|d| d.get("protocolHash")),
    ))
    .unwrap_or_default()
}

/// Whether an attempt scores the same under any evaluator: a budget failure's
/// fixed 0, or a judged brief answered without markup, which fails before a
/// panel sees it (its rubric check is otherwise always pending review).
fn protocol_neutral(data: &QueryData, attempt: &Attempt) -> bool {
    is_budget_failure(attempt.outcome.as_deref())
        || protocol_evaluation(attempt, None).is_some_and(|e| {
            e.provenance == "objective"
                && e.verdict == "fail"
                && data
                    .versions
                    .iter()
                    .find(|v| v.id == attempt.version_id)
                    .is_some_and(|v| v.manifest.evaluator.kind == "rubric")
        })
}

/// Each case's evaluator identities. A follow-up is scored by the same
/// evaluator only when its objective check or judge protocol is unchanged.
/// Protocol-neutral attempts identify no evaluator, so a case they alone
/// measured on one side is not compared.
fn case_evaluators<'a>(
    data: &QueryData,
    attempts: &[&'a Attempt],
) -> BTreeMap<&'a str, BTreeSet<String>> {
    let mut cases: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
    for attempt in attempts.iter().filter(|a| !protocol_neutral(data, a)) {
        cases
            .entry(attempt.version_id.as_str())
            .or_default()
            .insert(evaluator_identity(attempt));
    }
    cases
}

fn comparison_key(
    attempts: &[&Attempt],
    runs: &BTreeMap<&str, &BenchmarkRun>,
    pool: &[&BenchmarkVersion],
    as_of: Option<i64>,
) -> String {
    let protocols: BTreeSet<_> = attempts
        .iter()
        .map(|a| {
            let version = pool
                .iter()
                .find(|v| v.id == a.version_id)
                .expect("pool attempt");
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

/// Recompute each observation on today's measured cases with today's evidence.
/// A case keeps the newest scored cell observed by then, whatever runtime,
/// budget or evaluator revision it ran under, so a retest never rewrites an
/// earlier point. A case first measured later supplies the first cell scored
/// after the point, explicitly marked as backfilled.
fn recalculated_history_report(
    data: &QueryData,
    own: &[&Attempt],
    current: &BTreeSet<&str>,
    runs: &BTreeMap<&str, &BenchmarkRun>,
    at: i64,
) -> (LeaderboardReport, Vec<String>, Vec<String>) {
    let mut cells: BTreeMap<&str, BTreeMap<&str, Vec<&Attempt>>> = BTreeMap::new();
    for &attempt in own {
        if current.contains(attempt.version_id.as_str()) {
            cells
                .entry(&attempt.version_id)
                .or_default()
                .entry(&attempt.run_id)
                .or_default()
                .push(attempt);
        }
    }
    let mut selected = Vec::new();
    let mut backfilled = Vec::new();
    let mut revised = Vec::new();
    for (version, groups) in cells {
        let required = data
            .versions
            .iter()
            .find(|v| v.id == version)
            .map_or(data.required_repetitions.max(1), |v| {
                required_repetitions(data, v)
            });
        let mut settled: Vec<_> = groups
            .into_iter()
            .filter(|(id, attempts)| {
                attempts.len() == runs[id].request.repetitions as usize
                    && attempts.len() >= required as usize
                    && attempts.iter().all(|a| {
                        a.phase == "terminal" && a.finished_at.is_some() && score(a).is_some()
                    })
            })
            .collect();
        settled.sort_by_key(|(id, _)| (runs[id].created_at, *id));
        // A cell counts as known at `at` only if it was scored by then; a panel
        // that answered later falls through to the backfill branch.
        let known = settled.iter().rev().find(|(id, attempts)| {
            runs[id].created_at <= at
                && attempts.iter().all(|a| {
                    a.finished_at.is_some_and(|end| end <= at) && score_as_of(a, Some(at)).is_some()
                })
        });
        // Otherwise the first cell scored after it stands, whenever its run was
        // created, so an older run resumed later never replaces that backfill.
        let first_later = || {
            settled.iter().min_by_key(|(id, attempts)| {
                (
                    attempts.iter().filter_map(|a| settled_at(a)).max(),
                    runs[id].created_at,
                    *id,
                )
            })
        };
        if let Some((_, attempts)) = known.or_else(first_later) {
            if known.is_none() {
                backfilled.push(version.to_owned());
            } else if attempts
                .iter()
                .any(|a| a.evaluations.iter().any(|e| e.created_at > at))
            {
                revised.push(version.to_owned());
            }
            selected.extend(attempts.iter().copied());
        }
    }
    // A point with only future evidence has no observation to anchor it.
    let mut report = if backfilled.len() == current.len() {
        LeaderboardReport {
            cohort: None,
            rows: Vec::new(),
        }
    } else {
        leaderboard_from_attempts(data, &ResultQuery::default(), &selected)
    };
    for row in &mut report.rows {
        // A retrospective estimate has no dated peer comparison or rank.
        row.status = "preliminary".into();
        row.reason = format!(
            "{}/{} current cases; {} first measured later, {} reviewed later; recalculated using today's evidence",
            row.scored, row.planned, backfilled.len(), revised.len()
        );
    }
    (report, backfilled, revised)
}

/// Points a configuration's history keeps.
const HISTORY_POINTS: usize = 24;

/// Walks events newest first, keeps the oldest event of each run of equal
/// observations and stops once `limit` observations are settled, so the work
/// follows the points shown rather than every event ever recorded.
fn newest_observations<E, T>(
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
fn settled_at(attempt: &Attempt) -> Option<i64> {
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
/// Every non-preview run that settled cells of this configuration is an
/// observation whatever its state, and so is every later evaluation of them.
/// A finished run is observed at its end; any other run, cancelled included,
/// at the time its started cells settled.
pub fn history(data: &QueryData, configuration: &Configuration) -> Vec<HistorySnapshot> {
    let key = leaderboard_key(configuration);
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
                && leaderboard_key(&ledger_configuration(a, &acknowledged)) == key
        })
        .collect();
    let current_versions = leaderboard(
        data,
        &ResultQuery {
            limit: Some(500),
            ..Default::default()
        },
    )
    .rows
    .into_iter()
    .find(|r| leaderboard_key(&r.configuration) == key)
    .map(|r| r.scored_version_ids)
    .unwrap_or_default();
    let current: BTreeSet<&str> = current_versions.iter().map(String::as_str).collect();
    let mut cells: BTreeMap<(&str, &str), Vec<&Attempt>> = BTreeMap::new();
    for &a in &own {
        cells
            .entry((a.run_id.as_str(), a.version_id.as_str()))
            .or_default()
            .push(a);
    }
    cells.retain(|(run_id, _), attempts| {
        attempts.len() == runs[run_id].request.repetitions as usize
            && attempts
                .iter()
                .all(|a| a.phase == "terminal" && a.finished_at.is_some())
    });
    // A finished run is observed at its end. Any other run, cancelled included,
    // is observed when its started cells settled, so its results never wait
    // for a later run and a later cancel or evaluation never re-dates them; a
    // later evaluation stays an event of its own.
    let mut observed: BTreeMap<&str, i64> = BTreeMap::new();
    for ((run_id, _), attempts) in &cells {
        let run = runs[run_id];
        let at = if run.state == "completed" {
            Some(run.updated_at)
        } else {
            attempts
                .iter()
                .filter(|a| a.started_at.is_some())
                .filter_map(|a| settled_at(a))
                .max()
        };
        if let Some(at) = at {
            let entry = observed.entry(*run_id).or_insert(at);
            *entry = (*entry).max(at);
        }
    }
    // A run none of whose cells began work is dated by its own record.
    for (run_id, _) in cells.keys() {
        observed.entry(*run_id).or_insert(runs[run_id].updated_at);
    }
    let mut events = BTreeMap::new();
    for ((run_id, _), attempts) in &cells {
        let at = observed[run_id];
        events.insert(at, *run_id);
        for e in attempts.iter().flat_map(|a| &a.evaluations) {
            if e.created_at > at {
                events.insert(e.created_at, *run_id);
            }
        }
    }
    let observations =
        newest_observations(events.into_iter().rev(), HISTORY_POINTS, |(at, run_id)| {
            let report = leaderboard(
                data,
                &ResultQuery {
                    as_of: Some(at),
                    limit: Some(500),
                    ..Default::default()
                },
            );
            let row = report
                .rows
                .iter()
                .find(|r| leaderboard_key(&r.configuration) == key)?;
            let signature = serde_json::to_string(&(
                row.points,
                &row.attempt_ids,
                &row.comparison_key,
                row.cost,
            ))
            .unwrap_or_default();
            Some((signature, (at, run_id, report)))
        });
    observations
        .into_iter()
        .map(|(at, run_id, report)| {
            let (recalculated_report, backfilled_version_ids, revised_version_ids) =
                recalculated_history_report(data, &own, &current, &runs, at);
            HistorySnapshot {
                id: format!("{run_id}:{at}"),
                run_id: run_id.to_owned(),
                created_at: at,
                report,
                recalculated_report,
                backfilled_version_ids,
                revised_version_ids,
            }
        })
        .collect()
}

fn means_by_family(data: &QueryData, attempts: &[&Attempt]) -> BTreeMap<String, f64> {
    let mut cases: BTreeMap<String, (String, Vec<f64>)> = BTreeMap::new();
    for attempt in attempts {
        let Some(value) = score(attempt) else {
            continue;
        };
        let family = data
            .versions
            .iter()
            .find(|v| v.id == attempt.version_id)
            .map(|v| v.manifest.task_family.clone())
            .unwrap_or_else(|| attempt.version_id.clone());
        cases
            .entry(attempt.version_id.clone())
            .or_insert_with(|| (family, Vec::new()))
            .1
            .push(value);
    }
    let mut families: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for (family, scores) in cases.into_values() {
        families
            .entry(family)
            .or_default()
            .push(scores.iter().sum::<f64>() / scores.len() as f64);
    }
    families
        .into_iter()
        .map(|(family, scores)| (family, scores.iter().sum::<f64>() / scores.len() as f64))
        .collect()
}

fn interval(deltas: &[f64]) -> (f64, f64) {
    let mut state = 0x6d2b79f5_u64;
    let mut samples = Vec::with_capacity(2_000);
    for _ in 0..2_000 {
        let mut sum = 0.0;
        for _ in deltas {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            sum += deltas[state as usize % deltas.len()];
        }
        samples.push(sum / deltas.len() as f64);
    }
    samples.sort_by(f64::total_cmp);
    (samples[49], samples[1_949])
}

fn sign_probability(deltas: &[f64], threshold: f64) -> f64 {
    let n = deltas.len().min(256);
    let negatives = deltas
        .iter()
        .take(n)
        .filter(|value| **value < -threshold)
        .count();
    let mut probability = 2.0_f64.powi(-(n as i32));
    let mut cumulative = 0.0;
    for k in 0..=n {
        if k >= negatives {
            cumulative += probability;
        }
        if k < n {
            probability *= (n - k) as f64 / (k + 1) as f64;
        }
    }
    cumulative.min(1.0)
}

pub fn compare(data: &QueryData, baseline: &Baseline, query: &ResultQuery) -> Vec<Comparison> {
    let frozen = frozen_conditions(baseline);
    let selected = selected_runs(data, baseline, &frozen, query);
    let mut configurations: BTreeMap<String, (String, Configuration)> = BTreeMap::new();
    for attempt in &baseline.snapshots {
        configurations.insert(
            nerf_key(attempt),
            (
                attempt.configuration.id.clone(),
                nerf_configuration(attempt).into_owned(),
            ),
        );
    }
    let mut results = Vec::new();
    let authored = |attempt: &Attempt| {
        data.versions
            .iter()
            .find(|v| v.id == attempt.version_id)
            .is_some_and(|v| {
                super::routing::authored_by_candidate(
                    &v.manifest,
                    &execution_configuration(attempt),
                )
            })
    };
    for (key, (id, configuration)) in configurations {
        let before: Vec<_> = baseline
            .snapshots
            .iter()
            .filter(|a| nerf_key(a) == key && !authored(a))
            .collect();
        // Only the run selected for this configuration is its follow-up; a run
        // selected for another configuration never adds samples here.
        let run = selected.get(&key).copied();
        let after: Vec<_> = data
            .attempts
            .iter()
            .filter(|a| {
                run.is_some_and(|run| a.run_id == run.id) && nerf_key(a) == key && !authored(a)
            })
            .collect();
        let before_cases: BTreeSet<_> = before.iter().map(|a| &a.version_id).collect();
        let after_cases: BTreeSet<_> = after.iter().map(|a| &a.version_id).collect();
        let frozen_evaluators = case_evaluators(data, &before);
        let changed_evaluator = case_evaluators(data, &after)
            .iter()
            .any(|(case, identities)| {
                frozen_evaluators
                    .get(case)
                    .is_some_and(|frozen| frozen != identities)
            });
        let conditions = frozen.get(&key);
        let budgets_match = run.zip(conditions).is_some_and(|(run, conditions)| {
            conditions.len() == 1 && conditions.contains(&cohort(run))
        });
        let same_conditions = budgets_match
            && before_cases == after_cases
            && !changed_evaluator
            && before
                .iter()
                .chain(after.iter())
                .all(|a| score(a).is_some());
        let old = means_by_family(data, &before);
        let new = means_by_family(data, &after);
        let deltas: Vec<_> = old
            .iter()
            .filter_map(|(family, value)| new.get(family).map(|latest| latest - value))
            .collect();
        let mut result = Comparison {
            baseline_id: baseline.id.clone(),
            configuration_id: id,
            configuration,
            quality_change: None,
            retained_quality_percent: None,
            interval_low: None,
            interval_high: None,
            status: "insufficient_evidence".into(),
            reason: "No complete paired family comparison after this frozen baseline".into(),
            attempt_ids: after.iter().map(|a| a.id.clone()).collect(),
            duration_change_percent: None,
            token_change_percent: None,
            method: "family-bootstrap-v1/holm-sign-v1".into(),
            measured_at: after.iter().filter_map(|a| a.finished_at).max(),
        };
        let mut p = 1.0;
        if !after.is_empty() && !same_conditions {
            result.status = "changed_conditions".into();
            result.reason = "Case coverage, evaluator protocol, repetitions or timeout differ or are unavailable".into();
        } else if !deltas.is_empty() {
            let relative = |old: Option<f64>, new: Option<f64>| {
                old.zip(new)
                    .and_then(|(a, b)| (a > 0.0).then_some(100.0 * (b / a - 1.0)))
            };
            result.duration_change_percent = relative(
                median(
                    before
                        .iter()
                        .filter_map(|a| a.duration_ms.map(|v| v as f64))
                        .collect(),
                ),
                median(
                    after
                        .iter()
                        .filter_map(|a| a.duration_ms.map(|v| v as f64))
                        .collect(),
                ),
            );
            // Auxiliary model calls inflate the counters; keep the figure pure.
            let tokens = |attempts: &[&Attempt]| {
                median(
                    attempts
                        .iter()
                        .filter(|a| !has_auxiliary_usage(a))
                        .filter_map(|a| a.usage.output.map(|v| v as f64))
                        .collect(),
                )
            };
            result.token_change_percent = relative(tokens(&before), tokens(&after));
            let change = deltas.iter().sum::<f64>() / deltas.len() as f64;
            let initial = old.values().sum::<f64>() / old.len() as f64;
            let (low, high) = interval(&deltas);
            result.quality_change = Some(change);
            result.retained_quality_percent =
                (initial > 0.0).then_some(100.0 * (initial + change) / initial);
            result.interval_low = Some(low);
            result.interval_high = Some(high);
            result.status = "preliminary".into();
            result.reason = format!("{} independent paired families; family-bootstrap-v1, seed 1831565813, 2000 samples; threshold {}; one-sided sign test with Holm correction", deltas.len(), baseline.threshold);
            if deltas.len() >= 6 && high < -baseline.threshold {
                p = sign_probability(&deltas, baseline.threshold);
            }
        }
        results.push((p, result));
    }
    results.sort_by(|a, b| a.0.total_cmp(&b.0));
    let count = results.len();
    let mut rejected = false;
    for (index, (p, result)) in results.iter_mut().enumerate() {
        if !rejected && *p <= 0.05 / (count - index) as f64 {
            result.status = "confirmed_change".into();
        } else {
            rejected = true;
        }
    }
    results.into_iter().map(|(_, result)| result).collect()
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    #[test]
    fn family_interval_does_not_count_repeats_as_families() {
        assert_eq!(interval(&[-0.5; 8]), (-0.5, -0.5));
        assert!(sign_probability(&[-0.5; 8], 0.1) < 0.01);
        assert!(sign_probability(&[0.0; 8], 0.1) > 0.99);
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
    /// A solved case: reliability outweighs speed and cost, and a missing
    /// measurement gives up its weight instead of counting as the worst.
    #[test]
    fn a_case_scores_reliability_then_speed_then_cost() {
        let cell = |reward, duration_ms, cost| CaseCell {
            reward,
            duration_ms,
            cost,
            repetitions: 3,
        };
        let record = (Some(60_000.0), Some(140.0));
        let points = |c: &CaseCell| case_points(c, Some(&record)).points;
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
        let (data, _) = dataset();
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
        fn cells<'a>(
            list: &'a [Attempt],
            protocol: CaseProtocol<'_>,
        ) -> BTreeMap<&'a str, CaseCell> {
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
        // Fewer repetitions than required is no cell; an unscored one neither.
        assert_eq!(
            reward(&three(["pass", "pass", "pass"])[..2], objective),
            None
        );
        assert_eq!(
            reward(&three(["pass", "pass", "cancelled"]), objective),
            None
        );
        assert_eq!(
            cells(&three(["pass", "pass", "pass"]), objective)["v0"].repetitions,
            3
        );
    }
    #[test]
    fn null_cost_is_not_free() {
        let (data, _) = dataset();
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

    pub fn dataset() -> (QueryData, Baseline) {
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
                let mut manifest = super::super::runner::seed_definitions().remove(0);
                manifest.task_family = format!("family-{index}");
                BenchmarkVersion {
                    id: format!("v{index}"),
                    definition_id: format!("d{index}"),
                    content_hash: format!("hash{index}"),
                    published_at: 1,
                    manifest,
                }
            })
            .collect::<Vec<_>>();
        let request = RunRequest {
            request_key: "request".into(),
            version_ids: versions.iter().map(|v| v.id.clone()).collect(),
            configurations: vec![config.clone()],
            repetitions: 1,
            timeout_seconds: 120,
            max_executions: 6,
            preview: false,
        };
        let attempts = |run: &str, outcome: &str| {
            versions
                .iter()
                .map(|version| Attempt {
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
                    resolved_model: None,
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
                request: request.clone(),
                attempts: vec![],
            },
            BenchmarkRun {
                id: "after".into(),
                state: "completed".into(),
                revision: 1,
                created_at: 5,
                updated_at: 6,
                request: request.clone(),
                attempts: vec![],
            },
        ];
        let baseline = Baseline {
            id: "baseline".into(),
            name: "Frozen".into(),
            run_ids: vec!["before".into()],
            created_at: 4,
            threshold: 0.1,
            snapshots: before.clone(),
            run_conditions: vec![request],
        };
        (
            QueryData {
                definitions: vec![],
                versions,
                runs,
                attempts: before.into_iter().chain(after).collect(),
                // The fixtures measure one repetition per case; the product
                // protocol of `REQUIRED_REPETITIONS` has its own tests.
                required_repetitions: 1,
            },
            baseline,
        )
    }
    #[test]
    fn authored_cases_are_excluded_from_rows_and_comparisons() {
        let (mut data, baseline) = dataset();
        let query = ResultQuery::default();
        assert_eq!(leaderboard(&data, &query).rows[0].status, "comparable");
        data.versions[0].manifest.environment["authoredBy"] = serde_json::json!(["model"]);
        // Both frozen runs share the suite, so the authored case drops one cell each.
        let row = &leaderboard(&data, &query).rows[0];
        assert_eq!(row.planned, 5);
        assert!(row
            .reason
            .contains("1 cases authored by this candidate excluded"));
        assert!(!row.attempt_ids.contains(&"after-v0".to_string()));
        assert_eq!(row.scored_version_ids, vec!["v1", "v2", "v3", "v4", "v5"]);
        for version in &mut data.versions {
            version.manifest.environment["authoredBy"] = serde_json::json!(["claude"]);
        }
        let report = leaderboard(&data, &query);
        assert_eq!(report.rows[0].status, "excluded");
        assert_eq!(report.rows[0].quality, None);
        assert!(report.rows[0].scored_version_ids.is_empty());
        assert!(report.cohort.is_some());
        let comparison = compare(&data, &baseline, &query);
        assert_eq!(comparison[0].status, "insufficient_evidence");
        assert!(comparison[0].attempt_ids.is_empty());
    }
    #[test]
    fn the_newest_result_per_case_counts_and_coverage_follows_the_pool() {
        let (mut data, _) = dataset();
        for version in data.versions.iter_mut().take(2) {
            version.manifest.work_class_id = "planning".into();
        }
        // v0 and v1 were never re-run after they passed; the other four failed later.
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
        // Two of six cases solved; the row is the mean of its two class
        // boards (1000 and 0), not of its cases.
        assert_eq!(row.quality, Some(2.0 / 6.0));
        assert_eq!(row.points, Some(500));
        let planning = row.axes.iter().find(|axis| axis.id == "planning").unwrap();
        assert_eq!(
            (planning.scored, planning.planned, planning.points),
            (2, 2, Some(1000))
        );
        assert!(row.missing_version_ids.is_empty());
        // Every attempt took 100 ms, so the solved cases sit at their record.
        assert_eq!((row.speed_share, row.cost_share), (Some(1.0), None));
        assert_eq!(row.measured_at, Some(2));
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
        let (data, _) = dataset();
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
        let (mut data, _) = dataset();
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
    #[test]
    fn a_new_case_adds_a_gap_instead_of_resetting_history() {
        let (mut data, _) = dataset();
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
        data.definitions.push(BenchmarkDefinition {
            id: "d6".into(),
            draft_revision: 1,
            archived: true,
            archived_at: None,
            archive_history: vec![],
            draft: data.versions[6].manifest.clone(),
            versions: vec![],
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
        let (mut data, _) = dataset();
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
    fn runtime_updates_and_implicit_defaults_share_one_ledger() {
        let (mut data, _) = dataset();
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
            r#"["claude-acp","account","sonnet","default",false,"subscription","native_text"]"#
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
            r#"[["kimi-acp","cli-login-kimi-acp","kimi-code/kimi-for-coding","default",false,"subscription","native_text"],"K2.8 Preview"]"#
        );
        let mut k3 = k27.clone();
        k3.model_id = "kimi-code/k3".into();
        k3.model_name = Some("K3".into());
        let mut k3_renamed = k3.clone();
        k3_renamed.model_name = Some("K3 Turbo".into());
        assert_eq!(leaderboard_key(&k3), leaderboard_key(&k3_renamed));

        let (mut data, _) = dataset();
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
        let (data, _) = dataset();
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
    #[test]
    fn a_narrow_follow_up_run_never_shrinks_the_board() {
        let (mut data, _) = dataset();
        // One case re-run later with its own budget: a follow-up, not a new suite.
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
        assert!(cohort.run_ids.iter().any(|id| id == "follow-up"));
        // The follow-up's pass supersedes the failed v0 cell: one of six.
        assert_eq!(report.rows[0].points, Some(167));
        assert_eq!(cohort.timeout_seconds, 600);
    }
    #[test]
    fn matched_families_detect_change_but_changed_budgets_do_not() {
        let (mut data, baseline) = dataset();
        assert_eq!(
            compare(&data, &baseline, &ResultQuery::default())[0].status,
            "confirmed_change"
        );
        data.runs[1].request.timeout_seconds = 1;
        let result = compare(&data, &baseline, &ResultQuery::default());
        assert_eq!(result[0].status, "changed_conditions");
        assert_eq!(result[0].quality_change, None);
    }
    #[test]
    fn repeated_case_family_is_not_independent_evidence() {
        let (mut data, baseline) = dataset();
        for version in &mut data.versions {
            version.manifest.task_family = "same-family".into();
        }
        assert_eq!(
            compare(&data, &baseline, &ResultQuery::default())[0].status,
            "preliminary"
        );
    }
    #[test]
    fn observed_selection_and_fractional_rubric_are_preserved() {
        let (mut data, baseline) = dataset();
        for attempt in data.attempts.iter_mut().filter(|a| a.run_id == "after") {
            attempt.observed.as_mut().unwrap().effort = Some("high".into());
        }
        assert_eq!(
            compare(&data, &baseline, &ResultQuery::default())[0].status,
            "insufficient_evidence"
        );
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
}

#[cfg(test)]
#[path = "ledger_regressions.rs"]
mod ledger_regressions;
