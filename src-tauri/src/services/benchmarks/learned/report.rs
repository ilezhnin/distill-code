//! One immutable research report per preregistered holdout. No run dispatch.
use super::super::{analysis, evidence, store::Store};
use super::{holdout::HoldoutPlan, *};
use sqlx::Row;
use std::collections::BTreeMap;

#[cfg(test)]
mod tests;

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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldoutReport {
    pub plan_id: String,
    pub plan_hash: String,
    pub artifact_hash: String,
    pub created_at: i64,
    pub protocol: ReportProtocol,
    pub cases: Vec<ReportCase>,
    pub groups: usize,
    pub fallback_cases: usize,
    pub policies: Vec<PolicyResult>,
    pub limitations: Vec<String>,
    pub status: String,
    pub dispatch_allowed: bool,
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

/// Raw immutable version IDs and run plans are required here. Ordinary board
/// queries carry versions forward and filter unknown effort, which would hide
/// an incomplete first measurement and allow a favorable later one to replace it.
fn collect(data: &QueryData, plan: &HoldoutPlan) -> Result<Vec<ReportCase>> {
    let mut cases = Vec::new();
    for frozen in &plan.cases {
        let v = data
            .versions
            .iter()
            .find(|v| v.id == frozen.version_id)
            .ok_or_else(|| incomplete("Frozen task version is unavailable"))?;
        if v.content_hash != frozen.content_hash
            || v.manifest.evaluator.revision != frozen.evaluator_revision
            || hash(&PublicTask::from(&v.manifest))? != frozen.public_task_hash
            || v.manifest.split != "held_out"
        {
            return Err(incomplete("Frozen task or evaluator has changed"));
        }
        let mut cells = Vec::new();
        for candidate in &plan.configurations {
            let key = routing::candidate_key(candidate);
            let matches =
                |configuration: &Configuration| routing::candidate_key(configuration) == key;
            let run = data
                .runs
                .iter()
                .filter(|r| {
                    !r.request.preview
                        && (r.request.version_ids.contains(&frozen.version_id)
                            && r.request.configurations.iter().any(matches)
                            || data.attempts.iter().any(|a| {
                                a.run_id == r.id
                                    && a.version_id == frozen.version_id
                                    && (matches(&a.configuration)
                                        || a.observed.as_ref().is_some_and(matches))
                            }))
                })
                .min_by_key(|r| (r.created_at, &r.id))
                .ok_or_else(|| {
                    incomplete(format!(
                        "{} / {} has not been planned",
                        frozen.version_id, candidate.model_id
                    ))
                })?;
            let requested: Vec<_> = run
                .request
                .configurations
                .iter()
                .filter(|c| matches(c))
                .collect();
            if run.created_at <= plan.created_at
                || requested.len() != 1
                || requested[0].inventory_revision != candidate.inventory_revision
                || run.request.repetitions != frozen.required_repetitions
                || run.request.timeout_seconds < frozen.minimum_timeout_seconds
            {
                return Err(incomplete(
                    "First run does not match the frozen runtime, repetitions or timeout",
                ));
            }
            let mut attempts: Vec<_> = data
                .attempts
                .iter()
                .filter(|a| {
                    a.run_id == run.id
                        && a.version_id == frozen.version_id
                        && (a.configuration.id == requested[0].id
                            || matches(&a.configuration)
                            || a.observed.as_ref().is_some_and(matches))
                })
                .collect();
            attempts.sort_by_key(|a| (a.repetition, &a.id));
            if attempts.len() != frozen.required_repetitions as usize
                || !attempts
                    .iter()
                    .map(|a| a.repetition)
                    .eq(0..frozen.required_repetitions)
                || attempts.iter().any(|a| {
                    a.observed.as_ref().is_none_or(|c| {
                        !matches(c) || c.inventory_revision != candidate.inventory_revision
                    })
                })
            {
                return Err(incomplete("First cell is incomplete or acknowledged another runtime; later runs cannot replace it"));
            }
            let repeats: Vec<_> = attempts
                .iter()
                .map(|a| first_score(a, &frozen.evaluator_revision, plan.created_at))
                .collect::<Result<_>>()?;
            cells.push(ReportCell {
                candidate_key: key,
                run_id: run.id.clone(),
                quality: mean(repeats.iter().map(|r| Some(r.quality))).expect("nonempty repeats"),
                utility: 0.0,
                mean_duration_ms: mean(repeats.iter().map(|r| r.duration_ms)),
                mean_cost: mean(repeats.iter().map(|r| r.cost)),
                repeats,
            });
        }
        // Use precisely the fitted model's utility rule, including its treatment
        // of absent costs and zero-quality answers. No new held-out weights.
        let mut targets: Vec<_> = cells
            .iter()
            .map(|c| TrainingTarget {
                candidate_key: c.candidate_key.clone(),
                status: "observed".into(),
                reward: Some(c.quality),
                utility: None,
                mean_duration_ms: c.mean_duration_ms,
                mean_cost: c.mean_cost,
                evidence: serde_json::Value::Null,
            })
            .collect();
        fit::utilities(
            &mut targets,
            plan.evaluation.as_ref().expect("validated recipe").weights,
        );
        for (cell, target) in cells.iter_mut().zip(targets) {
            cell.utility = target.utility.expect("observed");
        }
        cases.push(ReportCase {
            version_id: frozen.version_id.clone(),
            group: frozen.split_group.clone(),
            learned_key: frozen.learned_key.clone(),
            aggregate_key: frozen.aggregate_key.clone(),
            used_fallback: frozen.learned_abstention.is_some(),
            cells,
        });
    }
    Ok(cases)
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

fn summarize(cases: &[ReportCase], plan: &HoldoutPlan) -> Vec<PolicyResult> {
    let protocol = plan.evaluation.as_ref().expect("validated recipe");
    let keys: Vec<_> = plan
        .configurations
        .iter()
        .map(routing::candidate_key)
        .collect();
    summarize_policies(
        cases,
        protocol,
        &plan.policies,
        &keys,
        &plan.request.persona_prior[0],
    )
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

fn evaluate(data: QueryData, plan: &HoldoutPlan, model: &LearnedModel) -> Result<HoldoutReport> {
    validate_model(model)?;
    let protocol = plan
        .evaluation
        .as_ref()
        .ok_or_else(|| invalid("This older reservation has no predeclared report recipe"))?;
    if hash(protocol)? != hash(&ReportProtocol::new(model.weights))?
        || model.id != plan.request.model_id
        || model.snapshot_hash != plan.model_snapshot_hash
        || plan.cases.len() < MIN_CASES
        || plan.configurations.len() < 2
    {
        return Err(invalid(
            "Holdout report protocol or model identity mismatch",
        ));
    }
    let cases = collect(&evidence::with_answer_caps(data), plan)?;
    let policies = summarize(&cases, plan);
    let mut report = HoldoutReport {
        plan_id: plan.id.clone(), plan_hash: hash(plan)?, artifact_hash: String::new(), created_at: super::super::store::now(),
        protocol: protocol.clone(), groups: cases.iter().map(|c| &c.group).collect::<BTreeSet<_>>().len(),
        fallback_cases: cases.iter().filter(|c| c.used_fallback).count(), cases, policies,
        limitations: vec!["Declared groups require independent semantic and grader qualification".into(),
            "Percentile intervals are exploratory, conditional on recorded repetitions, and not adjusted for multiple comparisons".into(),
            "Small group counts can produce unreliable or degenerate intervals; no promotion inference is granted".into(),
            "Best fixed and oracle are hindsight comparators selected by utility; best fixed is reselected in every resample".into(),
            "Duration and cost cover generation only; unknown resources remain absent and subscription charges are not inferred".into(),
            "Full workflow qualification and promotion approval remain required".into()],
        status: "research_only".into(), dispatch_allowed: false,
    };
    report.artifact_hash = hash(&report)?;
    Ok(report)
}

impl Store {
    pub async fn selector_holdout(&self, id: &str) -> Result<HoldoutPlan> {
        let body: String = sqlx::query_scalar("SELECT data_json FROM selector_holdouts WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| BenchmarkError::new("not_found", "Holdout plan was not found"))?;
        Ok(serde_json::from_str(&body)?)
    }
    pub async fn selector_holdout_report(&self, id: &str) -> Result<Option<HoldoutReport>> {
        let row = sqlx::query(
            "SELECT artifact_hash,data_json FROM selector_holdout_reports WHERE plan_id=?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let mut report: HoldoutReport = serde_json::from_str(row.try_get("data_json")?)?;
        let saved = std::mem::take(&mut report.artifact_hash);
        if report.plan_id != id
            || saved != row.try_get::<String, _>("artifact_hash")?
            || saved != hash(&report)?
            || report.plan_hash != hash(&self.selector_holdout(id).await?)?
        {
            return Err(BenchmarkError::new(
                "invalid_report",
                "Saved holdout report integrity check failed",
            ));
        }
        report.artifact_hash = saved;
        Ok(Some(report))
    }
    async fn save_holdout_report(&self, report: &HoldoutReport) -> Result<HoldoutReport> {
        sqlx::query("INSERT OR IGNORE INTO selector_holdout_reports(plan_id,created_at,artifact_hash,data_json) VALUES(?,?,?,?)")
            .bind(&report.plan_id).bind(report.created_at).bind(&report.artifact_hash).bind(serde_json::to_string(report)?)
            .execute(&self.pool).await?;
        self.selector_holdout_report(&report.plan_id)
            .await?
            .ok_or_else(|| incomplete("Report was not persisted"))
    }
    pub async fn evaluate_selector_holdout(&self, id: &str) -> Result<HoldoutReport> {
        if let Some(saved) = self.selector_holdout_report(id).await? {
            return Ok(saved);
        }
        let plan = self.selector_holdout(id).await?;
        let model = self.selector_model(&plan.request.model_id).await?;
        let mut tx = self.pool.begin().await?;
        let version_ids = serde_json::to_string(&plan.request.version_ids)?;
        let rows = sqlx::query("SELECT id,definition_id,content_hash,manifest_json,published_at FROM benchmark_versions WHERE id IN (SELECT value FROM json_each(?))")
            .bind(&version_ids).fetch_all(&mut *tx).await?;
        let versions = rows
            .into_iter()
            .map(|r| {
                Ok(BenchmarkVersion {
                    id: r.try_get("id")?,
                    definition_id: r.try_get("definition_id")?,
                    content_hash: r.try_get("content_hash")?,
                    manifest: serde_json::from_str(r.try_get("manifest_json")?)?,
                    published_at: r.try_get("published_at")?,
                    carries_from: None,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let rows = sqlx::query("SELECT id,state,revision,created_at,updated_at,baked_at,request_json FROM run_plans ORDER BY created_at,id").fetch_all(&mut *tx).await?;
        let runs = rows
            .into_iter()
            .map(|r| {
                Ok(BenchmarkRun {
                    id: r.try_get("id")?,
                    state: r.try_get("state")?,
                    revision: r.try_get("revision")?,
                    created_at: r.try_get("created_at")?,
                    updated_at: r.try_get("updated_at")?,
                    baked_at: r.try_get("baked_at")?,
                    request: serde_json::from_str(r.try_get("request_json")?)?,
                    attempts: vec![],
                })
            })
            .collect::<Result<Vec<_>>>()?;
        // No row cap, effort filtering, evaluator-only carry or price imputation.
        let bodies: Vec<String> = sqlx::query_scalar("SELECT json_set(data_json,'$.output',NULL) FROM attempts WHERE version_id IN (SELECT value FROM json_each(?)) ORDER BY rowid")
            .bind(version_ids).fetch_all(&mut *tx).await?;
        let attempts = bodies
            .into_iter()
            .map(|body| Ok(serde_json::from_str(&body)?))
            .collect::<Result<Vec<_>>>()?;
        tx.commit().await?;
        let data = QueryData {
            versions,
            runs,
            attempts,
            definitions: vec![],
            releases: vec![],
            required_repetitions: 1,
        };
        let report = tauri::async_runtime::spawn_blocking(move || evaluate(data, &plan, &model))
            .await
            .map_err(|e| BenchmarkError::new("infrastructure_failure", e.to_string()))??;
        self.save_holdout_report(&report).await
    }
}
