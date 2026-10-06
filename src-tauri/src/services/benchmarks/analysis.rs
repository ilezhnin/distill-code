//! Per-case measurements, boards and history.
use super::types::*;
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn score(attempt: &Attempt) -> Option<f64> {
    score_as_of(attempt, None)
}

/// How long a run stays open after it started: the window in which its
/// unfinished cases may still be measured. Once it closes the run is baked,
/// complete cells kept and the rest dropped, and nothing changes it after.
pub const RUN_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// When a run's window closes.
pub fn window_closes(run: &BenchmarkRun) -> i64 {
    run.created_at + RUN_WINDOW_MS
}

/// The outcome of an attempt that no longer counts: a repetition of a case
/// measured again from the start, or one its run's closing window left
/// short. The attempt keeps its evidence and spend; no cell holds it.
pub const SUPERSEDED: &str = "superseded";

pub fn is_superseded(attempt: &Attempt) -> bool {
    attempt.outcome.as_deref() == Some(SUPERSEDED)
}

/// Whether an attempt holds a measurement: a settled generation with a
/// quality outcome, scored or still before its reviewers.
pub(super) fn is_measured(attempt: &Attempt) -> bool {
    attempt.phase == "terminal" && has_quality_outcome(attempt.outcome.as_deref())
}

/// A run's cells by case and configuration, superseded repetitions left
/// out: what finishing and baking a run decide on.
pub(super) fn run_cells(run: &BenchmarkRun) -> BTreeMap<(String, String), Vec<Attempt>> {
    let mut cells: BTreeMap<(String, String), Vec<Attempt>> = BTreeMap::new();
    for attempt in run.attempts.iter().filter(|a| !is_superseded(a)) {
        cells
            .entry((attempt.version_id.clone(), attempt.configuration.id.clone()))
            .or_default()
            .push(attempt.clone());
    }
    cells
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

/// One configuration's measurement of one case: its newest scored
/// repetitions, up to the count the case requires.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct CaseCell {
    /// 1 when every repetition so far passed, 0 when any failed; a judged
    /// case takes the mean of its repetitions' panel scores instead.
    pub reward: f64,
    /// Median wall-clock over the repetitions.
    pub duration_ms: Option<f64>,
    /// Mean spend per repetition; unknown when any repetition's is.
    pub cost: Option<f64>,
    pub repetitions: u32,
    /// Whether the cell holds every repetition the case requires. A cell
    /// short of them still reads, as a preliminary measurement; a case
    /// counts for a rank only once complete.
    pub complete: bool,
}

/// How the pool reads a case: the repetitions its cell needs, and whether it
/// is scored on a scale rather than pass or fail.
#[derive(Clone, Copy)]
pub(super) struct CaseProtocol<'a> {
    pub required: &'a dyn Fn(&str) -> u32,
    pub graded: &'a dyn Fn(&str) -> bool,
}

/// The cells of a set of attempts, by case, from the scored repetitions
/// each case holds. A repetition without a score is left out; a case with
/// none is no cell.
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
            let list: Vec<&Attempt> = list
                .into_iter()
                .filter(|a| score_as_of(a, as_of).is_some())
                .collect();
            let scores: Vec<f64> = list.iter().filter_map(|a| score_as_of(a, as_of)).collect();
            if scores.is_empty() {
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
                    complete: scores.len() as u32 >= required(version),
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
    /// Cases whose cell holds every repetition it requires.
    pub complete: u32,
    pub quality: Option<f64>,
    pub points: Option<u32>,
    pub speed_share: Option<f64>,
    pub cost_share: Option<f64>,
}

pub(super) fn board_stats(cells: &BTreeMap<&str, CaseCell>, records: &CaseRecords) -> BoardStats {
    let scored = cells.len() as u32;
    let complete = cells.values().filter(|cell| cell.complete).count() as u32;
    if scored == 0 {
        return BoardStats {
            passed: 0,
            scored,
            complete,
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
        complete,
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
    let versions: BTreeMap<&str, &BenchmarkVersion> =
        data.versions.iter().map(|v| (v.id.as_str(), v)).collect();
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
        // From the first release on, the pool is the newest release at the
        // date; publishing or archiving a test changes it only at the next.
        None => match release_at(data, query.as_of) {
            Some(release) => release
                .version_ids
                .iter()
                .filter_map(|id| versions.get(id.as_str()).copied())
                .collect(),
            None => live_versions(data, query.as_of),
        },
    };
    if let Some(ids) = &query.version_ids {
        pool.retain(|version| ids.contains(&version.id));
    }
    pool.sort_by(|a, b| a.id.cmp(&b.id));
    pool
}

/// The newest pool release made by `as_of` (by now without one).
pub(super) fn release_at(data: &QueryData, as_of: Option<i64>) -> Option<&PoolRelease> {
    data.releases
        .iter()
        .filter(|release| as_of.is_none_or(|at| release.created_at <= at))
        .max_by_key(|release| (release.created_at, &release.id))
}

/// Every live test's newest published version at `as_of` (now without one):
/// the pool before the first release, and what the next release freezes.
pub(super) fn live_versions(data: &QueryData, as_of: Option<i64>) -> Vec<&BenchmarkVersion> {
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
    let mut live: Vec<&BenchmarkVersion> = latest.into_values().collect();
    live.sort_by(|a, b| a.id.cmp(&b.id));
    live
}

/// A case's standing cell for the training ledger and the orchestrator's
/// evidence: the scored repetitions of the newest run that scored the
/// case, else, when no run scored it, the newest run's settled attempts
/// that began work, so paid spend stays visible. A cell is one run's
/// repetitions, never a mix of runs; superseded repetitions are no
/// attempts. With `as_of`, only attempts finished by then count.
pub(super) fn latest_cell_attempts<'a>(
    attempts: &[&'a Attempt],
    runs: &BTreeMap<&str, &BenchmarkRun>,
    as_of: Option<i64>,
) -> Vec<&'a Attempt> {
    let mut groups: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
    for attempt in attempts {
        if is_superseded(attempt)
            || !runs.contains_key(attempt.run_id.as_str())
            || attempt.phase != "terminal"
            || attempt
                .finished_at
                .is_none_or(|end| as_of.is_some_and(|at| end > at))
        {
            continue;
        }
        groups.entry(&attempt.run_id).or_default().push(attempt);
    }
    let newest = |keep: &dyn Fn(&Attempt) -> bool| {
        groups
            .iter()
            .filter(|(_, list)| list.iter().any(|a| keep(a)))
            .max_by_key(|(id, _)| (runs[*id].created_at, **id))
            .map(|(_, list)| list.iter().copied().filter(|a| keep(a)).collect::<Vec<_>>())
    };
    newest(&|a| score_as_of(a, as_of).is_some())
        .or_else(|| newest(&|a| a.started_at.is_some()))
        .unwrap_or_default()
}

/// The spend a ledger row reports: scored cells through their scored
/// repetitions, and unscored cells only through the repetitions that began
/// work, and only when all of those report their spend. A repetition that
/// never ran spent nothing, and a cell whose spend is unknown is a gap for
/// cost, never free.
fn spent_attempts<'a>(
    attempts: &[&'a Attempt],
    scored: &BTreeSet<&str>,
    as_of: Option<i64>,
) -> Vec<&'a Attempt> {
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
            if unscored.contains(a.version_id.as_str()) {
                a.started_at.is_some() && !unknown.contains(a.version_id.as_str())
            } else {
                score_as_of(a, as_of).is_some()
            }
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

/// The leaderboard is a ledger over the current pool of cases: every
/// configuration stands on its newest run, whole, so a run is one session of
/// measurement and no older run fills its gaps; coverage is counted against
/// the pool, and a rank needs every case complete.
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
    // Every attempt on a pool case from a counted run, by configuration and run.
    let mut cells: BTreeMap<String, (Configuration, BTreeMap<&str, Vec<&Attempt>>)> =
        BTreeMap::new();
    for &attempt in source {
        if !pool_ids.contains(attempt.version_id.as_str())
            || !runs.contains_key(attempt.run_id.as_str())
            || is_superseded(attempt)
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
            .entry(attempt.run_id.as_str())
            .or_default()
            .push(attempt);
    }
    let mut contributing: BTreeSet<&str> = BTreeSet::new();
    let mut rows: Vec<LeaderboardRow> = cells
        .into_values()
        .filter_map(|(mut configuration, by_run)| {
            // A sealed sitting contributes only if it retained a complete
            // cell. Provider refusals remain evidence, not an empty result.
            let by_run: BTreeMap<_, _> = by_run
                .into_iter()
                .filter(|(id, list)| {
                    runs[id].baked_at.is_none()
                        || case_cells(list, query.as_of, protocol)
                            .values()
                            .any(|cell| cell.complete)
                })
                .collect();
            if by_run.is_empty() {
                return None;
            }
            // The newest run that began measuring stands whole: one session's
            // cells, its gaps its own. A run still queued leaves the standing
            // one in place until its first cell starts.
            let standing = by_run
                .into_iter()
                .filter(|(_, list)| list.iter().any(|a| a.started_at.is_some()))
                .max_by_key(|(id, _)| (runs[id].created_at, *id));
            let standing_request = standing.as_ref().map(|(id, _)| &runs[id].request);
            let mut attempts: Vec<&Attempt> =
                standing.map(|(_, list)| list).unwrap_or_default();
            // Keep the newest concrete configuration for the next run;
            // each attempt retains its original runtime and account evidence.
            if let Some(latest) = attempts
                .iter()
                .max_by_key(|attempt| (attempt.started_at, &attempt.id))
            {
                configuration = ledger_configuration(latest, &acknowledged).into_owned();
            }
            // Catch-up pins this configuration, so it carries the runnable profile.
            configuration.execution_profile =
                ledger_profile(&configuration.execution_profile).to_owned();
            let parallelism = standing_request.map(|request| {
                super::runner::attempts_at_once(request, &configuration.provider_id)
            });
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
                return Some(LeaderboardRow {
                    comparison_key: String::new(),
                    configuration, passed: 0, scored: 0, attempted: 0, planned: 0, complete: 0, quality: None,
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
                    parallelism,
                });
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
            // The repetitions the cells are made of: scored ones alone, so a
            // repetition of a measured case that never ran dates or costs nothing.
            let scored_attempts: Vec<&Attempt> = attempts.iter().copied()
                .filter(|a| score_as_of(a, query.as_of).is_some()).collect();
            let spent = spent_attempts(&attempts, &scored_versions, query.as_of);
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
            let complete = overall.complete;
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
            Some(LeaderboardRow {
                comparison_key: comparison_key(&scored_attempts, &runs, &pool, query.as_of),
                configuration,
                passed,
                scored,
                attempted,
                planned,
                complete,
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
                } else if complete == planned && standard_budgets {
                    "comparable"
                } else {
                    "preliminary"
                }
                .into(),
                reason: format!(
                    "{scored}/{planned} cases measured on the current pool, {complete} with every repetition; the newest run stands whole, and every repetition must pass{}{}",
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
                parallelism,
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

/// Recompute an observation on today's cases with today's evidence: the
/// run's own cells as they had finished by `at`, whatever runtime, budget or
/// evaluator revision they ran under, so a later run never rewrites an
/// earlier point. A case the run had not finished by then is a gap at that
/// point.
fn recalculated_history_report(
    data: &QueryData,
    own: &[&Attempt],
    current: &BTreeSet<&str>,
    run_id: &str,
    at: i64,
) -> (LeaderboardReport, Vec<String>, Vec<String>) {
    let selected: Vec<&Attempt> = own
        .iter()
        .copied()
        .filter(|a| {
            a.run_id == run_id
                && current.contains(a.version_id.as_str())
                && !is_superseded(a)
                && a.finished_at.is_some_and(|end| end <= at)
                && score_as_of(a, Some(at)).is_some()
        })
        .collect();
    let backfilled: Vec<String> = Vec::new();
    // A panel that answered later leaves that repetition out of this point.
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
        }
    } else {
        leaderboard_from_attempts(data, &ResultQuery::default(), &selected)
    };
    for row in &mut report.rows {
        // A retrospective estimate has no dated peer comparison or rank.
        row.status = "preliminary".into();
        row.reason = format!(
            "{}/{} current cases finished by then; {} reviewed later; recalculated using today's evidence",
            row.scored, row.planned, revised.len()
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
/// A run is observed when its last counted cell settled, so a window that
/// closed a day later never re-dates what was measured.
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
    // Today's pool: what every point is recalculated on.
    let current_pool = pool(data, &ResultQuery::default());
    let current: BTreeSet<&str> = current_pool.iter().map(|v| v.id.as_str()).collect();
    // The counted attempts of each run: its settled, unsuperseded cells.
    let mut cells: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
    for &a in &own {
        if !is_superseded(a) && a.phase == "terminal" && a.finished_at.is_some() {
            cells.entry(a.run_id.as_str()).or_default().push(a);
        }
    }
    // An empty sealed sitting must not borrow an earlier row and re-date it.
    cells.retain(|run_id, attempts| {
        runs[run_id].baked_at.is_none()
            || current_pool.iter().any(|version| {
                attempts
                    .iter()
                    .filter(|a| a.version_id == version.id && score(a).is_some())
                    .count() as u32
                    >= required_repetitions(data, version)
            })
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
    let mut events = BTreeMap::new();
    for (run_id, attempts) in &cells {
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
                recalculated_history_report(data, &own, &current, run_id, at);
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

#[cfg(test)]
pub(super) mod tests {
    use super::*;
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
            complete: true,
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
            parallelism: None,
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
                baked_at: None,
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
    #[test]
    fn authored_cases_are_excluded_from_rows() {
        let mut data = dataset();
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
    }
    /// A run is one sitting: the newest run that began stands whole, and
    /// a case it never measured is its gap, however an earlier run scored it.
    #[test]
    fn the_newest_run_stands_whole_and_coverage_follows_the_pool() {
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
        assert_eq!(cohort.run_ids, vec!["after".to_string()]);
        let row = &report.rows[0];
        assert_eq!(row.status, "preliminary");
        assert_eq!((row.scored, row.planned), (4, 6));
        assert_eq!(row.quality, Some(0.0));
        assert_eq!(row.points, Some(0));
        // The earlier passes of v0 and v1 fill no gap of this sitting.
        let planning = row.axes.iter().find(|axis| axis.id == "planning").unwrap();
        assert_eq!(
            (planning.scored, planning.planned, planning.points),
            (0, 2, None)
        );
        assert_eq!(row.missing_version_ids, vec!["v0", "v1"]);
        assert!(row.attempt_ids.iter().all(|id| id.starts_with("after-")));
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
    /// A run of one case is a sitting of one case: it stands alone, with
    /// five gaps, and the earlier full run is history. Re-measuring only the
    /// cases a model failed can never lift its row.
    #[test]
    fn a_narrow_follow_up_run_stands_alone() {
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
        assert_eq!(cohort.run_ids, vec!["follow-up".to_string()]);
        let row = &report.rows[0];
        assert_eq!(
            (row.scored, row.planned, row.status.as_str()),
            (1, 6, "preliminary")
        );
        assert_eq!(row.points, Some(1000));
        assert_eq!(row.attempt_ids, vec!["follow-up-v0".to_string()]);
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
}

#[cfg(test)]
#[path = "ledger_regressions.rs"]
mod ledger_regressions;
