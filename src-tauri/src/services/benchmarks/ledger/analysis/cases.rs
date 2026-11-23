//! A case's cells, records and points, and which cases a board counts.
use super::*;

pub(super) fn median(mut values: Vec<f64>) -> Option<f64> {
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
pub(in crate::services::benchmarks) fn required_repetitions(
    data: &QueryData,
    version: &BenchmarkVersion,
) -> u32 {
    data.required_repetitions
        .max(version.manifest.repetitions)
        .max(1)
}

/// How a solved case's points split: reliability first, then how fast and how
/// cheaply it was solved against the best measurement of that case. Speed and
/// cost are compared only among candidates that solved the case, so a cheap
/// wrong answer earns nothing. A missing measurement gives up its weight to
/// the others in proportion.
pub(super) const RELIABILITY_WEIGHT: f64 = 0.8;

pub(super) const SPEED_WEIGHT: f64 = 0.15;

pub(super) const COST_WEIGHT: f64 = 0.05;

/// One configuration's measurement of one case: its newest scored
/// repetitions, up to the count the case requires.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(in crate::services::benchmarks) struct CaseCell {
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
    /// The most loaded admission band among its repetitions (see
    /// [`admission_band`]): its speed compares only within that band.
    pub band: u8,
}

/// The admission bands speed is compared within, by the CPU-heavy jobs the
/// sandbox had already admitted beside a repetition: none, one or two, three
/// or more; an attempt admitted before the admission was recorded is a band
/// of its own. Higher is more loaded, and unknown counts as most.
pub(in crate::services::benchmarks) const BAND_UNRECORDED: u8 = 3;

pub(in crate::services::benchmarks) fn admission_band(attempt: &Attempt) -> u8 {
    match attempt
        .sandbox_admission
        .as_ref()
        .map(|admission| admission.competing_heavy)
    {
        None => BAND_UNRECORDED,
        Some(0) => 0,
        Some(1..=2) => 1,
        Some(_) => 2,
    }
}

/// How the pool reads a case: the repetitions its cell needs, and whether it
/// is scored on a scale rather than pass or fail.
#[derive(Clone, Copy)]
pub(in crate::services::benchmarks) struct CaseProtocol<'a> {
    pub required: &'a dyn Fn(&str) -> u32,
    pub graded: &'a dyn Fn(&str) -> bool,
}

/// The cells of a set of attempts, by case, from the scored repetitions
/// each case holds. A repetition without a score is left out; a case with
/// none is no cell.
pub(in crate::services::benchmarks) fn case_cells<'a>(
    attempts: &[&'a Attempt],
    as_of: Option<i64>,
    protocol: CaseProtocol<'_>,
) -> BTreeMap<&'a str, CaseCell> {
    case_cells_scored(attempts, protocol, &|attempt| score_as_of(attempt, as_of))
}

pub(super) fn case_cells_scored<'a>(
    attempts: &[&'a Attempt],
    protocol: CaseProtocol<'_>,
    score: &dyn Fn(&Attempt) -> Option<f64>,
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
            let (list, scores): (Vec<&Attempt>, Vec<f64>) = list
                .into_iter()
                .filter_map(|attempt| score(attempt).map(|score| (attempt, score)))
                .unzip();
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
            let durations: Option<Vec<f64>> = list
                .iter()
                .map(|a| a.duration_ms.map(|v| v as f64))
                .collect();
            Some((
                version,
                CaseCell {
                    reward,
                    duration_ms: durations.and_then(median),
                    cost: costs.map(|c| c.iter().sum::<f64>() / c.len() as f64),
                    repetitions: scores.len() as u32,
                    complete: scores.len() as u32 >= required(version),
                    band: list.iter().copied().map(admission_band).max().unwrap_or(0),
                },
            ))
        })
        .collect()
}

/// What speed and cost are measured against: the fastest solved cell of each
/// case within each admission band, and the cheapest of the case across
/// bands. Every settled cell of every candidate counts, so the record does
/// not depend on which rows a report happens to hold.
#[derive(Default)]
pub(in crate::services::benchmarks) struct CaseRecords {
    /// Cases with at least one solve.
    pub(super) solved: BTreeSet<String>,
    pub(super) durations: BTreeMap<(String, u8), f64>,
    /// The cheapest solve with a known, positive spend.
    pub(super) costs: BTreeMap<String, f64>,
}

#[cfg(test)]
pub(in crate::services::benchmarks) fn case_records(
    attempts: &[Attempt],
    runs: &BTreeMap<&str, &BenchmarkRun>,
    as_of: Option<i64>,
    protocol: CaseProtocol<'_>,
) -> CaseRecords {
    case_records_scored(
        attempts,
        runs,
        protocol,
        &run_acknowledgments(attempts),
        &|attempt| score_as_of(attempt, as_of),
    )
}

pub(super) fn case_records_scored(
    attempts: &[Attempt],
    runs: &BTreeMap<&str, &BenchmarkRun>,
    protocol: CaseProtocol<'_>,
    acknowledged: &Acknowledgments<'_>,
    score: &dyn Fn(&Attempt) -> Option<f64>,
) -> CaseRecords {
    let graded = protocol.graded;
    let mut cells: BTreeMap<(String, &str), Vec<&Attempt>> = BTreeMap::new();
    for attempt in attempts {
        if !runs.contains_key(attempt.run_id.as_str()) {
            continue;
        }
        let key = leaderboard_key(&ledger_configuration(attempt, acknowledged));
        cells
            .entry((key, attempt.run_id.as_str()))
            .or_default()
            .push(attempt);
    }
    let mut records = CaseRecords::default();
    let least = |best: Option<&f64>, value: Option<f64>| min_of(best.copied(), value);
    for list in cells.values() {
        for (version, cell) in case_cells_scored(list, protocol, score) {
            if (cell.reward < 1.0 && !graded(version)) || cell.reward <= 0.0 {
                continue;
            }
            records.solved.insert(version.to_owned());
            let key = (version.to_owned(), cell.band);
            if let Some(duration) = least(records.durations.get(&key), cell.duration_ms) {
                records.durations.insert(key, duration);
            }
            // A solve that reported no spend at all is no price to beat.
            let spend = cell.cost.filter(|cost| *cost > 0.0);
            if let Some(cost) = least(records.costs.get(version), spend) {
                records.costs.insert(version.to_owned(), cost);
            }
        }
    }
    records
}

/// The record a cell's speed and cost compare with: its band's fastest solve
/// of the case and the case's cheapest. A solved cell no record holds in its
/// band (its repetitions a subset of a more loaded cell, as after an account
/// move) compares with the nearest more loaded band's record, the cell it was
/// part of, and only without one is alone in its band and sets it.
pub(in crate::services::benchmarks) fn record_of(
    records: &CaseRecords,
    version: &str,
    cell: &CaseCell,
) -> Option<(Option<f64>, Option<f64>)> {
    if !records.solved.contains(version) {
        return None;
    }
    let duration = (cell.band..=BAND_UNRECORDED)
        .find_map(|band| records.durations.get(&(version.to_owned(), band)).copied())
        .or(cell.duration_ms);
    Some((duration, records.costs.get(version).copied()))
}

pub(super) fn min_of(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// A solved case's share of its best measurement: 1 at the record, 0.5 at
/// twice the record's time or spend.
pub(super) fn share_of_record(record: Option<f64>, value: Option<f64>) -> Option<f64> {
    match (record, value) {
        (Some(record), Some(value)) if value > 0.0 => Some((record / value).clamp(0.0, 1.0)),
        (Some(_), Some(_)) => Some(1.0),
        _ => None,
    }
}

/// What one case adds to a board, 0 to 1, with the speed and cost shares that
/// went into it.
pub(in crate::services::benchmarks) struct CasePoints {
    pub points: f64,
    pub speed: Option<f64>,
    pub cost: Option<f64>,
}

pub(in crate::services::benchmarks) fn case_points(
    cell: &CaseCell,
    record: Option<(Option<f64>, Option<f64>)>,
) -> CasePoints {
    let (best_duration, best_cost) = record.unwrap_or((None, None));
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
pub(in crate::services::benchmarks) struct BoardStats {
    pub passed: u32,
    pub scored: u32,
    /// Cases whose cell holds every repetition it requires.
    pub complete: u32,
    pub quality: Option<f64>,
    pub points: Option<u32>,
    pub speed_share: Option<f64>,
    pub cost_share: Option<f64>,
}

pub(in crate::services::benchmarks) fn board_stats(
    cells: &BTreeMap<&str, CaseCell>,
    records: &CaseRecords,
) -> BoardStats {
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
        let case = case_points(cell, record_of(records, version, cell));
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
pub(in crate::services::benchmarks) fn pool<'a>(
    data: &'a QueryData,
    query: &ResultQuery,
) -> Vec<&'a BenchmarkVersion> {
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
    // A case republished with only its evaluator changed is its carrying
    // version, at every date: the cells moved to it.
    let carried = carried_versions(&data.versions);
    if !carried.is_empty() {
        pool = pool
            .into_iter()
            .map(|version| {
                carried
                    .get(&version.id)
                    .and_then(|id| versions.get(id.as_str()).copied())
                    .unwrap_or(version)
            })
            .collect();
        pool.sort_by(|a, b| a.id.cmp(&b.id));
        pool.dedup_by(|a, b| a.id == b.id);
    }
    if let Some(ids) = &query.version_ids {
        pool.retain(|version| ids.contains(&version.id));
    }
    pool.sort_by(|a, b| a.id.cmp(&b.id));
    pool
}

/// Development fixtures exercise infrastructure; only these splits measure
/// model capability. Keep raw catalog and diagnostic evidence available.
pub(in crate::services::benchmarks) fn is_ranked_split(split: &str) -> bool {
    matches!(split, "train" | "held_out")
}

pub(in crate::services::benchmarks) fn ranked_pool<'a>(
    data: &'a QueryData,
    query: &ResultQuery,
) -> Vec<&'a BenchmarkVersion> {
    pool(data, query)
        .into_iter()
        .filter(|version| is_ranked_split(&version.manifest.split))
        .collect()
}

/// A repetition passes at a full objective score, or at half the points or
/// more of a judged one, the mark every result view draws.
pub(super) fn repetition_passed(score: f64) -> bool {
    score >= 0.5
}

/// Discrimination and flakiness of every pool case over the models' standing
/// cells, the ones the boards read: which cases separate models, which only
/// add noise, and which every model passes.
pub fn case_tracker(data: &QueryData) -> Vec<CaseStats> {
    let query = ResultQuery {
        limit: Some(500),
        ..Default::default()
    };
    let pool = pool(data, &query);
    // The development library still shows diagnostic outcomes. These internal
    // statistics are never returned as official leaderboard rows.
    let rows = leaderboard_from_attempts(
        data,
        &query,
        &data.attempts.iter().collect::<Vec<_>>(),
        pool.clone(),
    )
    .rows;
    let attempts: BTreeMap<&str, &Attempt> =
        data.attempts.iter().map(|a| (a.id.as_str(), a)).collect();
    pool.into_iter()
        .map(|version| {
            let required = required_repetitions(data, version) as usize;
            // Each model's share of passed repetitions, over complete cells.
            let mut shares = Vec::new();
            let mut flaky = 0;
            for row in &rows {
                let scores: Vec<f64> = row
                    .attempt_ids
                    .iter()
                    .filter_map(|id| attempts.get(id.as_str()))
                    .filter(|a| a.version_id == version.id)
                    .filter_map(|a| score_as_of(a, None))
                    .collect();
                if scores.len() < required {
                    continue;
                }
                let passed = scores.iter().filter(|s| repetition_passed(**s)).count();
                if passed > 0 && passed < scores.len() {
                    flaky += 1;
                }
                shares.push(passed as f64 / scores.len() as f64);
            }
            let models = shares.len() as u32;
            let passed = shares.iter().filter(|share| **share >= 1.0).count() as u32;
            let spread = (!shares.is_empty()).then(|| {
                let high = shares.iter().copied().fold(f64::MIN, f64::max);
                let low = shares.iter().copied().fold(f64::MAX, f64::min);
                high - low
            });
            CaseStats {
                version_id: version.id.clone(),
                definition_id: version.definition_id.clone(),
                models,
                passed,
                spread,
                flaky,
                smoke: models >= 2 && passed == models,
            }
        })
        .collect()
}

/// When a version's case entered the pool: the oldest publication of its
/// evaluator-only chain, whose cells it carries, or, once pool releases
/// exist, the first release that held the case, if later.
pub(super) fn entered_pool(
    versions: &BTreeMap<&str, &BenchmarkVersion>,
    releases: &[PoolRelease],
    version: &BenchmarkVersion,
    as_of: Option<i64>,
) -> i64 {
    let mut at = version.published_at;
    let mut seen = BTreeSet::from([version.id.as_str()]);
    let mut next = version.carries_from.as_deref();
    while let Some(id) = next {
        let Some(earlier) = versions.get(id).filter(|_| seen.insert(id)) else {
            break;
        };
        at = at.min(earlier.published_at);
        next = earlier.carries_from.as_deref();
    }
    releases
        .iter()
        .filter(|release| as_of.is_none_or(|at| release.created_at <= at))
        .filter(|release| {
            release
                .version_ids
                .iter()
                .any(|id| seen.contains(id.as_str()))
        })
        .map(|release| release.created_at)
        .min()
        .map_or(at, |released| released.max(at))
}

/// The last time a row covered its suite: the latest moment at which every
/// suite case in the pool by then held a complete cell finished by then. Each
/// case is (entered the pool, when each of its complete cells completed, in
/// any of the row's runs). A row that covers the suite today gets the moment
/// its newest complete cell completed, or the pool entry if the cells were
/// measured before release; one short of it, the last moment it was whole
/// before the suite grew. A re-run in progress keeps the date its earlier
/// cells earned.
pub(super) fn fully_tested_at(cases: &[(i64, Vec<i64>)]) -> Option<i64> {
    let mut times: Vec<i64> = cases
        .iter()
        // Coverage can become complete when an already measured case enters
        // the pool, even if no attempt finishes at or after that release.
        .flat_map(|(entered, done)| std::iter::once(*entered).chain(done.iter().copied()))
        .collect();
    times.sort_unstable();
    times.dedup();
    times.into_iter().rev().find(|&at| {
        let mut covered = false;
        for (entered, done) in cases {
            if *entered > at {
                continue;
            }
            if !done.iter().any(|completed| *completed <= at) {
                return false;
            }
            covered = true;
        }
        covered
    })
}

/// Each version an evaluator-only republication replaced, to the version
/// that carries its cells now: the end of its chain.
pub fn carried_versions(versions: &[BenchmarkVersion]) -> BTreeMap<String, String> {
    let mut next: BTreeMap<&str, &BenchmarkVersion> = BTreeMap::new();
    for version in versions {
        if let Some(from) = version.carries_from.as_deref() {
            let entry = next.entry(from).or_insert(version);
            if version.published_at > entry.published_at {
                *entry = version;
            }
        }
    }
    next.keys()
        .map(|from| {
            let mut current = *from;
            // A chain is never longer than the versions; a cycle stops there.
            for _ in 0..versions.len() {
                match next.get(current) {
                    Some(successor) => current = successor.id.as_str(),
                    None => break,
                }
            }
            ((*from).to_owned(), current.to_owned())
        })
        .collect()
}

/// The newest pool release made by `as_of` (by now without one).
pub(in crate::services::benchmarks) fn release_at(
    data: &QueryData,
    as_of: Option<i64>,
) -> Option<&PoolRelease> {
    data.releases
        .iter()
        .filter(|release| as_of.is_none_or(|at| release.created_at <= at))
        .max_by_key(|release| (release.created_at, &release.id))
}

/// Every live test's newest published version at `as_of` (now without one):
/// the pool before the first release, and what the next release freezes.
pub(in crate::services::benchmarks) fn live_versions(
    data: &QueryData,
    as_of: Option<i64>,
) -> Vec<&BenchmarkVersion> {
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
pub(in crate::services::benchmarks) fn latest_cell_attempts<'a>(
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
pub(super) fn spent_attempts<'a>(
    attempts: &[&'a Attempt],
    scored: &BTreeSet<&str>,
    score: &dyn Fn(&Attempt) -> Option<f64>,
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
                score(a).is_some()
            }
        })
        .collect()
}

/// The candidate's own generation spend per task: repetitions are averaged
/// within a case, then cases are averaged. Judge calls are the benchmark's
/// expense and stay on their evaluations. Unknown spend is never free.
pub(in crate::services::benchmarks) fn mean_case_cost(
    attempts: &[&Attempt],
    as_of: Option<i64>,
) -> Option<f64> {
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
