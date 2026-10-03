//! Frozen-cohort analysis. Infrastructure exclusions stay visible as missing cells.
use super::types::*;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn score(attempt: &Attempt) -> Option<f64> {
    score_as_of(attempt, None)
}

fn score_as_of(attempt: &Attempt, as_of: Option<i64>) -> Option<f64> {
    let valid = |score: &f64| score.is_finite() && (0.0..=1.0).contains(score);
    if matches!(attempt.outcome.as_deref(), Some("pass" | "fail" | "judged")) {
        if let Some(review) = attempt
            .evaluations
            .iter()
            .rev()
            .find(|e| e.provenance == "human" && as_of.is_none_or(|at| e.created_at <= at))
        {
            return review.score.filter(valid);
        }
        // A panel verdict is the median of its judges, so one outlier moves nothing.
        let judged: Vec<f64> = attempt
            .evaluations
            .iter()
            .filter(|e| e.provenance == "judge" && as_of.is_none_or(|at| e.created_at <= at))
            .filter_map(|e| e.score)
            .filter(valid)
            .collect();
        if !judged.is_empty() {
            return median(judged);
        }
    }
    match attempt.outcome.as_deref()? {
        "pass" => Some(1.0),
        // Exceeding the published time or artifact budget is a task failure, not
        // an infrastructure exclusion: the candidate chose that behavior.
        "fail" | "budget_timeout" | "budget_reached" => Some(0.0),
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

pub(crate) fn execution_configuration(attempt: &Attempt) -> &Configuration {
    attempt.observed.as_ref().unwrap_or(&attempt.configuration)
}

fn request_conditions(request: &RunRequest) -> String {
    let mut versions = request.version_ids.clone();
    versions.sort();
    serde_json::to_string(&(
        versions,
        request.repetitions,
        request.timeout_seconds,
        request.max_executions,
    ))
    .unwrap_or_default()
}

fn cohort(run: &BenchmarkRun) -> String {
    request_conditions(&run.request)
}

fn selected_runs<'a>(data: &'a QueryData, query: &ResultQuery) -> Vec<&'a BenchmarkRun> {
    let runs: Vec<_> = data
        .runs
        .iter()
        .filter(|run| {
            !run.request.preview
                && query.run_id.as_ref().is_none_or(|id| id == &run.id)
                && query
                    .version_ids
                    .as_ref()
                    .is_none_or(|ids| ids.iter().all(|id| run.request.version_ids.contains(id)))
        })
        .collect();
    // Default view is one frozen suite, never a blend of easy and hard cohorts:
    // the broadest suite still made of live cases, the newest among equals, so a
    // narrow follow-up run never shrinks the board and a retired case stops
    // counting once its definition is archived.
    let archived: BTreeSet<&str> = data
        .definitions
        .iter()
        .filter(|definition| definition.archived)
        .map(|definition| definition.id.as_str())
        .collect();
    let live: BTreeSet<&str> = data
        .versions
        .iter()
        .filter(|version| !archived.contains(version.definition_id.as_str()))
        .map(|version| version.id.as_str())
        .collect();
    let breadth = |run: &BenchmarkRun| {
        run.request
            .version_ids
            .iter()
            .filter(|id| live.contains(id.as_str()))
            .count()
    };
    let chosen = runs
        .iter()
        .max_by_key(|run| (breadth(run), run.created_at))
        .map(|run| cohort(run));
    runs.into_iter()
        .filter(|run| chosen.as_ref().is_some_and(|key| cohort(run) == *key))
        .collect()
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

/// Points for a lower-is-better measurement: the best value scores 1000, the
/// rest in proportion to it.
pub fn relative_points(value: f64, best: f64) -> u32 {
    if value <= 0.0 {
        1000
    } else {
        share_points(best / value)
    }
}

/// Passed and scored cells plus the mean of per-case means.
fn cell_stats(attempts: &[&Attempt], as_of: Option<i64>) -> (u32, u32, Option<f64>) {
    let mut cases: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
    for attempt in attempts {
        if let Some(value) = score_as_of(attempt, as_of) {
            cases.entry(&attempt.version_id).or_default().push(value);
        }
    }
    let passed = attempts
        .iter()
        .filter(|a| score_as_of(a, as_of) == Some(1.0))
        .count() as u32;
    let scored = cases.values().map(|values| values.len() as u32).sum();
    let quality = (!cases.is_empty()).then(|| {
        cases
            .values()
            .map(|values| values.iter().sum::<f64>() / values.len() as f64)
            .sum::<f64>()
            / cases.len() as f64
    });
    (passed, scored, quality)
}

/// The current pool: the latest published version of every live definition,
/// or one run's suite when a run is asked for, narrowed by any version filter.
fn pool<'a>(data: &'a QueryData, query: &ResultQuery) -> Vec<&'a BenchmarkVersion> {
    let archived: BTreeSet<&str> = data
        .definitions
        .iter()
        .filter(|definition| definition.archived)
        .map(|definition| definition.id.as_str())
        .collect();
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
        None => {
            let mut latest: BTreeMap<&str, &BenchmarkVersion> = BTreeMap::new();
            for version in &data.versions {
                if archived.contains(version.definition_id.as_str()) {
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

/// Distinct cases among attempts that carry a score.
fn scored_cases(attempts: &[&Attempt], as_of: Option<i64>) -> u32 {
    attempts
        .iter()
        .filter(|a| score_as_of(a, as_of).is_some())
        .map(|a| a.version_id.as_str())
        .collect::<BTreeSet<_>>()
        .len() as u32
}

/// The leaderboard is a ledger over the current pool of cases: for every
/// configuration and case the newest run's attempts stand, repetitions are
/// averaged per case, coverage is counted against the pool, and a rank needs
/// every case measured. Adding a case adds a gap to fill, never a reset.
pub fn leaderboard(data: &QueryData, query: &ResultQuery) -> LeaderboardReport {
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
    // Every attempt on a pool case from a counted run, by configuration and case.
    let mut cells: BTreeMap<String, (Configuration, BTreeMap<&str, Vec<&Attempt>>)> =
        BTreeMap::new();
    for attempt in &data.attempts {
        if !pool_ids.contains(attempt.version_id.as_str())
            || !runs.contains_key(attempt.run_id.as_str())
            || query
                .as_of
                .is_some_and(|at| attempt.finished_at.is_none_or(|finished| finished > at))
        {
            continue;
        }
        let configuration = execution_configuration(attempt);
        let entry = cells
            .entry(configuration_key(configuration))
            .or_insert_with(|| (configuration.clone(), BTreeMap::new()));
        entry
            .1
            .entry(attempt.version_id.as_str())
            .or_default()
            .push(attempt);
    }
    let mut contributing: BTreeSet<&str> = BTreeSet::new();
    let mut rows: Vec<LeaderboardRow> = cells
        .into_values()
        .map(|(configuration, by_case)| {
            // Per case, the newest run's attempts stand; older measurements are superseded.
            let mut attempts: Vec<&Attempt> = Vec::new();
            for (_, mut list) in by_case {
                let newest = list
                    .iter()
                    .map(|a| runs[a.run_id.as_str()].created_at)
                    .max();
                list.retain(|a| Some(runs[a.run_id.as_str()].created_at) == newest);
                attempts.extend(list);
            }
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
                    configuration, passed: 0, scored: 0, attempted: 0, planned: 0, quality: None,
                    median_duration_ms: None, median_output_tokens: None, cost: None, measured_at: None,
                    points: None, efficiency_points: None, speed_points: None, cost_points: None,
                    status: "excluded".into(),
                    reason: format!("{excluded} cases excluded: this candidate helped author every case in the pool"),
                    attempt_ids: Vec::new(),
                    axes: Vec::new(),
                    missing_version_ids: Vec::new(),
                };
            }
            let planned = eligible.len() as u32;
            let attempted = attempts
                .iter()
                .filter(|a| a.started_at.is_some())
                .map(|a| a.version_id.as_str())
                .collect::<BTreeSet<_>>()
                .len() as u32;
            let (passed, _, quality) = cell_stats(&attempts, query.as_of);
            let scored = scored_cases(&attempts, query.as_of);
            let scored_attempts: Vec<&Attempt> =
                attempts.iter().copied().filter(|a| score_as_of(a, query.as_of).is_some()).collect();
            // No scored case means no measured spend, not a free pool.
            let cost = (!scored_attempts.is_empty())
                .then(|| {
                    scored_attempts.iter().try_fold(0.0, |sum, attempt| {
                        attempt.usage.cost.map(|value| sum + value)
                    })
                })
                .flatten();
            let axes = work_classes
                .iter()
                .map(|class| {
                    let subset: Vec<&Attempt> = attempts
                        .iter()
                        .copied()
                        .filter(|a| work_class(&a.version_id) == class)
                        .collect();
                    let cases = eligible
                        .iter()
                        .filter(|v| v.manifest.work_class_id == *class)
                        .count() as u32;
                    let (passed, _, quality) = cell_stats(&subset, query.as_of);
                    LeaderboardAxis {
                        id: class.clone(),
                        quality,
                        points: quality.map(share_points),
                        passed,
                        scored: scored_cases(&subset, query.as_of),
                        planned: cases,
                    }
                })
                .collect();
            let missing_version_ids: Vec<String> = eligible
                .iter()
                .filter(|v| !scored_attempts.iter().any(|a| a.version_id == v.id))
                .map(|v| v.id.clone())
                .collect();
            LeaderboardRow {
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
                median_output_tokens: median(
                    scored_attempts
                        .iter()
                        .filter_map(|a| a.usage.output.map(|v| v as f64))
                        .collect(),
                ),
                cost,
                measured_at: attempts.iter().filter_map(|a| a.finished_at).max(),
                points: quality.map(share_points),
                efficiency_points: None,
                speed_points: None,
                cost_points: None,
                status: if attempted == 0 {
                    "untested"
                } else if scored == planned {
                    "comparable"
                } else {
                    "preliminary"
                }
                .into(),
                reason: format!(
                    "{scored}/{planned} cases measured on the current pool; the newest result per case counts, repetitions averaged{}",
                    if excluded > 0 {
                        format!("; {excluded} cases authored by this candidate excluded")
                    } else {
                        String::new()
                    }
                ),
                attempt_ids: attempts.iter().map(|a| a.id.clone()).collect(),
                axes,
                missing_version_ids,
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
    // Lower-is-better boards score against the best comparable configuration in the pool.
    let best = |pick: fn(&LeaderboardRow) -> Option<f64>| {
        rows.iter()
            .filter(|row| row.status == "comparable")
            .filter_map(pick)
            .fold(None, |best: Option<f64>, value| {
                Some(best.map_or(value, |b| b.min(value)))
            })
    };
    let best_tokens = best(|row| row.median_output_tokens);
    let best_duration = best(|row| row.median_duration_ms);
    let best_cost = best(|row| row.cost);
    for row in &mut rows {
        row.efficiency_points = row
            .median_output_tokens
            .zip(best_tokens)
            .map(|(v, b)| relative_points(v, b));
        row.speed_points = row
            .median_duration_ms
            .zip(best_duration)
            .map(|(v, b)| relative_points(v, b));
        row.cost_points = row.cost.zip(best_cost).map(|(v, b)| relative_points(v, b));
    }
    rows.sort_by(|a, b| {
        (b.status == "comparable")
            .cmp(&(a.status == "comparable"))
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
    let current_runs = selected_runs(data, query);
    let current_ids: BTreeSet<_> = current_runs
        .iter()
        .filter(|r| !baseline.run_ids.contains(&r.id) && r.created_at > baseline.created_at)
        .map(|r| r.id.as_str())
        .collect();
    let mut configurations: BTreeMap<String, (String, Configuration)> = BTreeMap::new();
    for attempt in &baseline.snapshots {
        configurations.insert(
            configuration_key(execution_configuration(attempt)),
            (
                attempt.configuration.id.clone(),
                execution_configuration(attempt).clone(),
            ),
        );
    }
    let mut results = Vec::new();
    let authored = |attempt: &Attempt| {
        data.versions
            .iter()
            .find(|v| v.id == attempt.version_id)
            .is_some_and(|v| {
                super::routing::authored_by_candidate(&v.manifest, execution_configuration(attempt))
            })
    };
    for (key, (id, configuration)) in configurations {
        let before: Vec<_> = baseline
            .snapshots
            .iter()
            .filter(|a| configuration_key(execution_configuration(a)) == key && !authored(a))
            .collect();
        let after: Vec<_> = data
            .attempts
            .iter()
            .filter(|a| {
                current_ids.contains(a.run_id.as_str())
                    && configuration_key(execution_configuration(a)) == key
                    && !authored(a)
            })
            .collect();
        let before_cases: BTreeSet<_> = before.iter().map(|a| &a.version_id).collect();
        let after_cases: BTreeSet<_> = after.iter().map(|a| &a.version_id).collect();
        let changed_evaluator = after.iter().any(|a| {
            before
                .iter()
                .find(|b| b.version_id == a.version_id)
                .is_some_and(|b| {
                    b.evaluations.last().map(|e| &e.evaluator_revision)
                        != a.evaluations.last().map(|e| &e.evaluator_revision)
                })
        });
        let frozen_conditions: BTreeSet<_> = baseline
            .run_conditions
            .iter()
            .map(request_conditions)
            .collect();
        let budgets_match = frozen_conditions.len() == 1
            && current_runs
                .iter()
                .filter(|run| current_ids.contains(run.id.as_str()))
                .all(|run| frozen_conditions.contains(&cohort(run)));
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
            result.reason = "Case coverage, evaluator revision, repetitions or frozen execution budgets differ or are unavailable".into();
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
            result.token_change_percent = relative(
                median(
                    before
                        .iter()
                        .filter_map(|a| a.usage.output.map(|v| v as f64))
                        .collect(),
                ),
                median(
                    after
                        .iter()
                        .filter_map(|a| a.usage.output.map(|v| v as f64))
                        .collect(),
                ),
            );
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
        assert_eq!(relative_points(2000.0, 2000.0), 1000);
        assert_eq!(relative_points(10_000.0, 2000.0), 200);
        assert_eq!(relative_points(0.0, 2000.0), 1000);
    }
    #[test]
    fn null_cost_is_not_free() {
        let costs = [Some(1.0), None];
        assert_eq!(
            costs.into_iter().try_fold(0.0, |sum, x| x.map(|v| sum + v)),
            None
        );
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
        for version in &mut data.versions {
            version.manifest.environment["authoredBy"] = serde_json::json!(["claude"]);
        }
        let report = leaderboard(&data, &query);
        assert_eq!(report.rows[0].status, "excluded");
        assert_eq!(report.rows[0].quality, None);
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
        assert_eq!(row.points, Some(333));
        let planning = row.axes.iter().find(|axis| axis.id == "planning").unwrap();
        assert_eq!(
            (planning.scored, planning.planned, planning.points),
            (2, 2, Some(1000))
        );
        assert!(row.missing_version_ids.is_empty());
        // Every attempt took 100 ms, so the only comparable row is its own best.
        assert_eq!(row.speed_points, Some(1000));
        assert_eq!((row.efficiency_points, row.cost_points), (None, None));
        assert_eq!(row.measured_at, Some(2));
        // One lonely case leaves five gaps and no rank.
        data.attempts.truncate(1);
        let row = &leaderboard(&data, &query).rows[0];
        assert_eq!(row.status, "preliminary");
        assert_eq!((row.scored, row.planned), (1, 6));
        assert_eq!(row.missing_version_ids.len(), 5);
        assert_eq!(row.axes.iter().map(|axis| axis.planned).sum::<u32>(), 6);
        data.attempts[0].outcome = None;
        data.attempts[0].usage.cost = Some(0.5);
        assert_eq!(leaderboard(&data, &query).rows[0].cost, None);
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
        // The six measured cases still carry their points.
        assert_eq!(row.points, Some(0));
        // Archiving a definition retires its case from the pool.
        data.definitions.push(BenchmarkDefinition {
            id: "d6".into(),
            draft_revision: 1,
            archived: true,
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
        assert_eq!(judged.points, Some(900));
        assert_eq!(at(10).points, Some(1000));
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
