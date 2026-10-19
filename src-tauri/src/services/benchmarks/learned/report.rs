//! The shared arithmetic of research reports: first scores, cells and the
//! paired bootstrap summary that workflow campaigns use. No run dispatch.
use super::super::analysis;
use super::*;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportProtocol {
    pub recipe: String,
    pub cell_selection: String,
    pub score_selection: String,
    pub primary_metric: String,
    pub resampling: String,
    pub bootstrap_samples: usize,
    pub seed: u64,
    pub interval_mass: f64,
    pub weights: RoleWeights,
}
impl ReportProtocol {
    pub(in crate::services::benchmarks) fn new(weights: RoleWeights) -> Self {
        Self {
            recipe: "family-paired-report-v1".into(),
            cell_selection: "first_planned_exact_candidate_all_repetitions".into(),
            score_selection: "first_scored_published_evaluator_revision".into(),
            primary_metric: "quality_weighted_relative_resource_utility".into(),
            resampling: "paired_whole_split_groups_equal_weight_percentile".into(),
            bootstrap_samples: 2_000,
            seed: 0x5345_4c45,
            interval_mass: 0.95,
            weights,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeatEvidence {
    pub attempt_id: String,
    pub repetition: u32,
    pub scored_at: i64,
    pub quality: f64,
    pub duration_ms: Option<f64>,
    pub cost: Option<f64>,
    pub evidence_hash: Option<String>,
    pub evaluations_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCell {
    pub candidate_key: String,
    pub run_id: String,
    pub quality: f64,
    pub utility: f64,
    pub mean_duration_ms: Option<f64>,
    pub mean_cost: Option<f64>,
    pub repeats: Vec<RepeatEvidence>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCase {
    pub version_id: String,
    pub group: String,
    pub learned_key: String,
    pub aggregate_key: String,
    pub used_fallback: bool,
    pub cells: Vec<ReportCell>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interval {
    pub lower: f64,
    pub upper: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyResult {
    pub policy: String,
    pub selected_fixed_key: Option<String>,
    pub quality: f64,
    pub utility: f64,
    pub mean_duration_ms: Option<f64>,
    pub mean_cost: Option<f64>,
    pub missing_duration_cases: usize,
    pub missing_cost_cases: usize,
    pub utility_interval: Interval,
    /// Positive means the learned policy has higher utility. Best-fixed is
    /// selected again inside each paired resample, not held at its winner.
    pub learned_utility_gain: f64,
    pub learned_gain_interval: Interval,
}

fn incomplete(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("incomplete_holdout_evidence", message)
}

fn mean(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    let values: Option<Vec<_>> = values.collect();
    values
        .filter(|v| !v.is_empty())
        .map(|v| v.iter().sum::<f64>() / v.len() as f64)
}

/// The earliest settled score is fixed even if the operator opens the report
/// after a regrade. A different evaluator cannot silently replace this one.
pub(in crate::services::benchmarks) fn first_score(
    attempt: &Attempt,
    revision: &str,
    after: i64,
) -> Result<RepeatEvidence> {
    let end = attempt
        .finished_at
        .ok_or_else(|| incomplete("Attempt has not finished"))?;
    if attempt.phase != "terminal" || attempt.started_at.is_none_or(|at| at < after || at > end) {
        return Err(incomplete(
            "Attempt is not a terminal post-reservation measurement",
        ));
    }
    let mut cutoffs: BTreeSet<i64> = attempt
        .evaluations
        .iter()
        .map(|e| e.created_at.max(end))
        .collect();
    cutoffs.insert(end);
    for cutoff in cutoffs {
        let evaluations: Vec<_> = attempt
            .evaluations
            .iter()
            .filter(|e| e.created_at <= cutoff)
            .collect();
        // Budget failure is zero without a grader. All other scores need
        // recorded evaluator evidence, not a mutable outcome string alone.
        let budget_failure = matches!(
            attempt.outcome.as_deref(),
            Some("budget_reached" | "budget_timeout")
        );
        if !budget_failure && evaluations.is_empty() {
            continue;
        }
        if let Some(quality) = analysis::score_as_of(attempt, Some(cutoff)) {
            if evaluations.iter().any(|e| e.evaluator_revision != revision) {
                return Err(incomplete(
                    "The first score used a different evaluator revision",
                ));
            }
            return Ok(RepeatEvidence {
                attempt_id: attempt.id.clone(),
                repetition: attempt.repetition,
                scored_at: cutoff,
                quality,
                duration_ms: attempt.duration_ms.map(|v| v as f64),
                cost: attempt.usage.cost.filter(|v| v.is_finite() && *v >= 0.0),
                evidence_hash: attempt.evidence_hash.clone(),
                evaluations_hash: hash(&evaluations)?,
            });
        }
    }
    Err(incomplete(
        "The original repetition has no scored evaluator evidence",
    ))
}

fn group_mean(cases: &[&ReportCase], select: impl Fn(&ReportCase) -> Option<f64>) -> Option<f64> {
    mean(cases.iter().map(|case| select(case)))
}
fn cell<'a>(case: &'a ReportCase, key: &str) -> &'a ReportCell {
    case.cells
        .iter()
        .find(|c| c.candidate_key == key)
        .expect("frozen candidate")
}
fn selection<'a>(case: &'a ReportCase, policy: &str, fixed: &str, persona: &str) -> &'a ReportCell {
    match policy {
        "learned" => cell(case, &case.learned_key),
        "aggregate" => cell(case, &case.aggregate_key),
        "persona" => cell(case, persona),
        "oracle" => case
            .cells
            .iter()
            .max_by(|a, b| {
                a.utility
                    .total_cmp(&b.utility)
                    .then_with(|| b.candidate_key.cmp(&a.candidate_key))
            })
            .expect("candidates"),
        _ => cell(case, policy.strip_prefix("fixed:").unwrap_or(fixed)),
    }
}

fn best_fixed(groups: &[Vec<&ReportCase>], sampled: &[usize], keys: &[String]) -> String {
    keys.iter()
        .max_by(|a, b| {
            let utility = |key: &str| {
                sampled
                    .iter()
                    .map(|i| {
                        group_mean(&groups[*i], |c| Some(cell(c, key).utility)).expect("complete")
                    })
                    .sum::<f64>()
            };
            utility(a).total_cmp(&utility(b)).then_with(|| b.cmp(a))
        })
        .expect("candidates")
        .clone()
}

pub(in crate::services::benchmarks) fn summarize_policies(
    cases: &[ReportCase],
    protocol: &ReportProtocol,
    policies: &[String],
    keys: &[String],
    persona: &str,
) -> Vec<PolicyResult> {
    let mut grouped: BTreeMap<&str, Vec<&ReportCase>> = BTreeMap::new();
    for case in cases {
        grouped.entry(&case.group).or_default().push(case);
    }
    let groups: Vec<_> = grouped.into_values().collect();
    let all: Vec<_> = (0..groups.len()).collect();
    let best = best_fixed(&groups, &all, keys);
    let metric =
        |policy: &str, fixed: &str, sampled: &[usize], measure: fn(&ReportCell) -> Option<f64>| {
            mean(sampled.iter().map(|i| {
                group_mean(&groups[*i], |c| {
                    measure(selection(c, policy, fixed, persona))
                })
            }))
        };
    let quality = |c: &ReportCell| Some(c.quality);
    let utility = |c: &ReportCell| Some(c.utility);
    let learned = metric("learned", &best, &all, utility).expect("complete");
    let mut samples = vec![Vec::new(); policies.len()];
    let mut gains = samples.clone();
    // Fixed SplitMix64 stream; multiply-high maps to a group index. One shared
    // resample pairs all policies and retains all cases/repeats in each group.
    let mut state = protocol.seed;
    for _ in 0..protocol.bootstrap_samples {
        let sampled: Vec<_> = all
            .iter()
            .map(|_| {
                state = state.wrapping_add(0x9e3779b97f4a7c15);
                let mut z = state;
                z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
                z ^= z >> 31;
                ((u128::from(z) * groups.len() as u128) >> 64) as usize
            })
            .collect();
        let fixed = best_fixed(&groups, &sampled, keys);
        let own = metric("learned", &fixed, &sampled, utility).expect("complete");
        for (i, policy) in policies.iter().enumerate() {
            let value = metric(policy, &fixed, &sampled, utility).expect("complete");
            samples[i].push(value);
            gains[i].push(own - value);
        }
    }
    let interval = |values: &mut Vec<f64>| {
        values.sort_by(f64::total_cmp);
        let quantile = |q: f64| {
            let at = q * (values.len() - 1) as f64;
            let lo = at.floor() as usize;
            let hi = at.ceil() as usize;
            values[lo] + (values[hi] - values[lo]) * (at - lo as f64)
        };
        Interval {
            lower: quantile(0.025),
            upper: quantile(0.975),
        }
    };
    policies
        .iter()
        .enumerate()
        .map(|(i, policy)| {
            let utility = metric(policy, &best, &all, utility).expect("complete");
            PolicyResult {
                policy: policy.clone(),
                selected_fixed_key: (policy == "best_fixed").then(|| best.clone()),
                quality: metric(policy, &best, &all, quality).expect("complete"),
                utility,
                mean_duration_ms: metric(policy, &best, &all, |c| c.mean_duration_ms),
                mean_cost: metric(policy, &best, &all, |c| c.mean_cost),
                missing_duration_cases: cases
                    .iter()
                    .filter(|c| {
                        selection(c, policy, &best, persona)
                            .mean_duration_ms
                            .is_none()
                    })
                    .count(),
                missing_cost_cases: cases
                    .iter()
                    .filter(|c| selection(c, policy, &best, persona).mean_cost.is_none())
                    .count(),
                utility_interval: interval(&mut samples[i]),
                learned_utility_gain: learned - utility,
                learned_gain_interval: interval(&mut gains[i]),
            }
        })
        .collect()
}
