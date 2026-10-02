//! Frozen-cohort analysis. Infrastructure exclusions stay visible as missing cells.
use super::types::*;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn score(attempt: &Attempt) -> Option<f64> {
    if matches!(attempt.outcome.as_deref(), Some("pass" | "fail")) {
        if let Some(review) = attempt
            .evaluations
            .iter()
            .rev()
            .find(|e| e.provenance == "human")
        {
            return review
                .score
                .filter(|score| score.is_finite() && (0.0..=1.0).contains(score));
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

fn configuration_key(configuration: &Configuration) -> String {
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

fn execution_configuration(attempt: &Attempt) -> &Configuration {
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
    // Default view is one frozen suite, never a blend of easy and hard cohorts.
    let latest = runs
        .iter()
        .max_by_key(|run| run.created_at)
        .map(|run| cohort(run));
    runs.into_iter()
        .filter(|run| latest.as_ref().is_some_and(|key| cohort(run) == *key))
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

/// Passed and scored cells plus the mean of per-case means.
fn cell_stats(attempts: &[&Attempt]) -> (u32, u32, Option<f64>) {
    let mut cases: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
    for attempt in attempts {
        if let Some(value) = score(attempt) {
            cases.entry(&attempt.version_id).or_default().push(value);
        }
    }
    let passed = attempts.iter().filter(|a| score(a) == Some(1.0)).count() as u32;
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

pub fn leaderboard(data: &QueryData, query: &ResultQuery) -> LeaderboardReport {
    let runs = selected_runs(data, query);
    let ids: BTreeSet<_> = runs.iter().map(|run| run.id.as_str()).collect();
    let versions: BTreeMap<_, _> = data.versions.iter().map(|v| (v.id.as_str(), v)).collect();
    let newest = runs.iter().max_by_key(|run| run.created_at);
    // The suite is the newest run's case list; a candidate owes every case it did not author.
    let suite: Vec<&BenchmarkVersion> = newest
        .map(|run| {
            run.request
                .version_ids
                .iter()
                .filter_map(|id| versions.get(id.as_str()).copied())
                .collect()
        })
        .unwrap_or_default();
    let repetitions = newest
        .map(|run| run.request.repetitions)
        .unwrap_or(1)
        .max(1);
    let work_classes: Vec<String> = suite
        .iter()
        .map(|v| v.manifest.work_class_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let cohort = newest.map(|newest| {
        let mut version_ids = newest.request.version_ids.clone();
        version_ids.sort();
        LeaderboardCohort {
            run_ids: runs.iter().map(|run| run.id.clone()).collect(),
            version_ids,
            repetitions: newest.request.repetitions,
            timeout_seconds: newest.request.timeout_seconds,
            max_executions: newest.request.max_executions,
            newest_run_at: newest.created_at,
            work_classes: work_classes.clone(),
        }
    });
    let work_class = |version_id: &str| {
        versions
            .get(version_id)
            .map(|v| v.manifest.work_class_id.as_str())
            .unwrap_or("unknown")
    };
    let authored = |attempt: &Attempt| {
        versions.get(attempt.version_id.as_str()).is_some_and(|v| {
            super::routing::authored_by_candidate(&v.manifest, execution_configuration(attempt))
        })
    };
    // Scored cells plus the count of cells this candidate helped author.
    let mut groups: BTreeMap<String, (Configuration, Vec<&Attempt>, u32)> = BTreeMap::new();
    for attempt in &data.attempts {
        if ids.contains(attempt.run_id.as_str()) {
            let group = groups
                .entry(configuration_key(execution_configuration(attempt)))
                .or_insert_with(|| (execution_configuration(attempt).clone(), Vec::new(), 0));
            if authored(attempt) {
                group.2 += 1;
            } else {
                group.1.push(attempt);
            }
        }
    }
    let mut rows: Vec<_> = groups.into_values().map(|(configuration, attempts, excluded)| {
        if attempts.is_empty() {
            return LeaderboardRow {
                configuration, passed: 0, scored: 0, attempted: 0, planned: 0, quality: None,
                median_duration_ms: None, median_output_tokens: None, cost: None, measured_at: None,
                status: "excluded".into(),
                reason: format!("{excluded} cells excluded: this candidate helped author every case in the suite"),
                attempt_ids: Vec::new(),
                axes: Vec::new(),
            };
        }
        let eligible: Vec<&BenchmarkVersion> = suite
            .iter()
            .copied()
            .filter(|v| !super::routing::authored_by_candidate(&v.manifest, &configuration))
            .collect();
        // Observed cells never shrink the plan; an unfinished suite stays preliminary.
        let planned = (attempts.len() as u32).max(eligible.len() as u32 * repetitions);
        let attempted = attempts.iter().filter(|a| a.started_at.is_some()).count() as u32;
        let (passed, scored, quality) = cell_stats(&attempts);
        let scored_attempts: Vec<&Attempt> = attempts.iter().copied().filter(|a| score(a).is_some()).collect();
        // No scored cell means no measured spend, not a free suite.
        let cost = (!scored_attempts.is_empty())
            .then(|| scored_attempts.iter().try_fold(0.0, |sum, attempt| attempt.usage.cost.map(|value| sum + value)))
            .flatten();
        let axes = work_classes
            .iter()
            .map(|class| {
                let subset: Vec<&Attempt> = attempts.iter().copied().filter(|a| work_class(&a.version_id) == class).collect();
                let cases = eligible.iter().filter(|v| v.manifest.work_class_id == *class).count() as u32;
                let (passed, scored, quality) = cell_stats(&subset);
                LeaderboardAxis { id: class.clone(), quality, passed, scored, planned: (subset.len() as u32).max(cases * repetitions) }
            })
            .collect();
        LeaderboardRow {
            configuration, passed, scored, attempted, planned, quality,
            median_duration_ms: median(scored_attempts.iter().filter_map(|a| a.duration_ms.map(|v| v as f64)).collect()),
            median_output_tokens: median(scored_attempts.iter().filter_map(|a| a.usage.output.map(|v| v as f64)).collect()),
            cost,
            measured_at: attempts.iter().filter_map(|a| a.finished_at).max(),
            status: if attempted == 0 { "untested" } else if scored == planned { "comparable" } else { "preliminary" }.into(),
            reason: format!(
                "{scored}/{planned} scored cells in the same frozen suite; equal case weights, observed repetitions retained{}",
                if excluded > 0 { format!("; {excluded} cells authored by this candidate excluded") } else { String::new() }
            ),
            attempt_ids: attempts.iter().map(|a| a.id.clone()).collect(),
            axes,
        }
    }).collect();
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
        assert_eq!(row.planned, 10);
        assert!(row
            .reason
            .contains("2 cells authored by this candidate excluded"));
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
    fn an_unfinished_suite_stays_preliminary_and_axes_follow_work_classes() {
        let (mut data, _) = dataset();
        for version in data.versions.iter_mut().take(2) {
            version.manifest.work_class_id = "planning".into();
        }
        let query = ResultQuery::default();
        let report = leaderboard(&data, &query);
        let cohort = report.cohort.as_ref().unwrap();
        assert_eq!(cohort.work_classes.len(), 2);
        let row = &report.rows[0];
        assert_eq!(row.status, "comparable");
        assert_eq!((row.scored, row.planned), (12, 12));
        let planning = row.axes.iter().find(|axis| axis.id == "planning").unwrap();
        assert_eq!((planning.scored, planning.planned), (4, 4));
        // v0 and v1 passed before and failed after: half of the planning cells.
        assert_eq!(planning.quality, Some(0.5));
        assert_eq!(row.measured_at, Some(2));
        // One lonely cell cannot be comparable while the suite has six cases.
        data.attempts.truncate(1);
        let row = &leaderboard(&data, &query).rows[0];
        assert_eq!(row.status, "preliminary");
        assert_eq!((row.scored, row.planned), (1, 6));
        data.attempts[0].outcome = None;
        data.attempts[0].usage.cost = Some(0.5);
        assert_eq!(leaderboard(&data, &query).rows[0].cost, None);
        assert_eq!(row.axes.iter().map(|axis| axis.planned).sum::<u32>(), 6);
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
