//! Certification of a class's learned choice on its permanent held-out
//! cases. A fit reads the train split only; held-out cases are an evaluation
//! set that ordinary benchmark runs measure for every model. An evaluation
//! replays one frozen fit on whatever complete held-out cells exist now,
//! choosing among the candidates each case measured, and every evaluation is
//! journaled with its fit, recipe and data snapshot, so the number of looks
//! stays visible. Nothing here is reserved, frozen before measurement or
//! single use: the discipline is the frozen recipe, the train-only fit and
//! the journal.
use super::super::{
    export::{self, RuntimeMatch},
    qualification,
    store::{now, Store},
    workflow_campaign::acceptance,
    BenchmarkService,
};
use super::report::{ReportCase, ReportCell};
use super::*;
use serde_json::Value;
use sqlx::Row;
use std::collections::BTreeMap;

/// The evaluation recipe: its arithmetic and its fixed acceptance rule.
pub const RECIPE: &str = "held-out-certification-v1";
/// The quality floor of a learned choice, as an ordinary chat applies it.
const MIN_QUALITY: f64 = 0.5;

/// The rule every evaluation applies; it is part of the recipe, never chosen
/// per evaluation.
pub(in crate::services::benchmarks) fn rule() -> acceptance::Rule {
    acceptance::Rule {
        recipe: acceptance::SELECTION_RECIPE.into(),
        alpha: 0.05,
        minimum_group_utility_gain: 0.0,
        minimum_observed_quality: 0.5,
        non_inferiority_margin: Some(0.05),
    }
}

/// One entry of the class's fallback order, as an ordinary chat of the
/// class resolves it (the user's class override, else the built-in ranking):
/// a provider, alternative sets of words the model's id or name must all
/// contain, and the effort and fast mode the chat would run it at.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankedMatcher {
    #[serde(default)]
    pub platform: Option<String>,
    pub needles: Vec<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvaluationRequest {
    pub work_class_id: String,
    /// Providers the user leaves out, in addition to the train-only vendors.
    #[serde(default)]
    pub excluded_providers: Vec<String>,
    /// The class's manual order, the comparator a certificate must beat.
    pub persona_order: Vec<RankedMatcher>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationCandidate {
    pub candidate_key: String,
    pub provider_id: String,
    pub model_id: String,
    pub model_name: Option<String>,
    pub effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub training_cases: usize,
    pub held_out_cases: usize,
    /// Held-out cases on which the learned policy chose this candidate.
    pub learned_cases: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassEvaluation {
    pub id: String,
    pub work_class_id: String,
    pub created_at: i64,
    pub recipe: String,
    pub fit_recipe: String,
    pub model_id: String,
    pub model_snapshot_hash: String,
    /// This evaluation's number among the class's journaled evaluations.
    pub look: usize,
    /// The fallback order as the request named it, and the pool candidates
    /// it resolved to, in order.
    #[serde(default)]
    pub persona_order: Vec<RankedMatcher>,
    pub persona_keys: Vec<String>,
    /// The candidates measured on at least eight held-out groups: the only
    /// ones compared, and the only ones a certificate lets the policy choose.
    #[serde(default)]
    pub pool_keys: Vec<String>,
    pub aggregate_keys: Vec<String>,
    pub excluded_providers: Vec<String>,
    pub candidates: Vec<EvaluationCandidate>,
    pub cases: Vec<ReportCase>,
    /// Held-out cases left out for a missing or stale qualification.
    pub unqualified_cases: usize,
    /// Measured cells left out because another renderer graded them.
    pub ungraded_cells: usize,
    /// Hash of every counted cell: what this evaluation looked at.
    pub snapshot_hash: String,
    pub assessment: Option<acceptance::Assessment>,
    /// `certified`, `not_certified` or `insufficient_evidence`.
    pub status: String,
    pub limitations: Vec<String>,
    pub qualification_ids: Vec<String>,
    pub certificate_id: Option<String>,
    pub artifact_hash: String,
}

/// What a class's status line shows about its newest evaluation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationSummary {
    pub id: String,
    pub model_id: String,
    pub created_at: i64,
    pub status: String,
    pub look: usize,
    pub training_cases: usize,
    pub held_out_cases: usize,
    pub groups: usize,
    pub observed_quality: Option<f64>,
    pub reasons: Vec<String>,
    pub certificate_id: Option<String>,
}

impl ClassEvaluation {
    pub fn summary(&self, training_cases: usize) -> EvaluationSummary {
        EvaluationSummary {
            id: self.id.clone(),
            model_id: self.model_id.clone(),
            created_at: self.created_at,
            status: self.status.clone(),
            look: self.look,
            training_cases,
            held_out_cases: self.cases.len(),
            groups: self
                .cases
                .iter()
                .map(|c| &c.group)
                .collect::<BTreeSet<_>>()
                .len(),
            observed_quality: self.assessment.as_ref().map(|a| a.observed_quality),
            reasons: self
                .assessment
                .as_ref()
                .map(|a| a.reasons.clone())
                .unwrap_or_default(),
            certificate_id: self.certificate_id.clone(),
        }
    }
}

fn coverage(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("insufficient_training_evidence", message)
}

/// The providers the user excluded. Every provider runs every split, so data
/// use excludes none.
fn excluded(request: &EvaluationRequest) -> Vec<String> {
    request
        .excluded_providers
        .iter()
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty())
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect()
}

/// The candidate a ledger column names, in the fit's canonical form.
fn column_configuration(cell: &Value) -> Option<Configuration> {
    let c = &cell["configuration"];
    let text = |field: &str| c[field].as_str().map(str::to_owned);
    Some(Configuration {
        id: text("candidateKey")?,
        provider_id: text("providerId")?,
        account_id: None,
        model_id: text("modelId")?,
        effort: text("effort"),
        fast_mode: c["fastMode"].as_bool(),
        billing_mode: text("billingMode")?,
        execution_profile: text("executionProfile")?,
        inventory_revision: text("inventoryRevision").filter(|r| !r.trim().is_empty()),
        model_name: text("modelName"),
    })
}

fn observed<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    row["matrix"].as_array()?.iter().find(|cell| {
        cell["configuration"]["candidateKey"] == key && cell["observationStatus"] == "observed"
    })
}

fn validate_request(request: &EvaluationRequest) -> Result<()> {
    if !routing::WORK_CLASSES.contains(&request.work_class_id.as_str())
        || request.excluded_providers.len() > 64
        || request.persona_order.is_empty()
        || request.persona_order.len() > 32
        || request
            .persona_order
            .iter()
            .any(|m| m.needles.is_empty() || m.needles.iter().any(|set| set.is_empty()))
    {
        return Err(invalid(
            "An evaluation needs a known work class, at most 64 excluded providers and the class's manual order",
        ));
    }
    Ok(())
}

/// The training request of a class, decided from training cells only: the
/// class's executor tasks in its largest public scope; every candidate with
/// at least [`MIN_CANDIDATE_CASES`] complete training cells there, except
/// excluded providers; every case that measured at least two of them.
/// Candidates need not share cases.
pub(super) fn training_request(
    data: &QueryData,
    request: &EvaluationRequest,
    cutoff: i64,
) -> Result<FitRequest> {
    validate_request(request)?;
    let excluded = excluded(request);
    let rows = export::ledger_rows_matching(
        data,
        false,
        LEDGER_SALT,
        cutoff,
        RuntimeMatch::ModelIdentity,
    )?;
    let versions: BTreeMap<_, _> = data.versions.iter().map(|v| (v.id.as_str(), v)).collect();
    let mut scopes: BTreeMap<String, Vec<(&Value, &str)>> = BTreeMap::new();
    for row in &rows {
        let Some(version) = row["taskVersion"].as_str().and_then(|id| versions.get(id)) else {
            continue;
        };
        let draft = &version.manifest;
        if draft.work_class_id != request.work_class_id
            || draft.split != "train"
            || draft.workflow.is_some()
        {
            continue;
        }
        let task = PublicTask::from(draft);
        if features::extract(&task).is_err() {
            continue;
        }
        scopes
            .entry(features::scope_hash(&task)?)
            .or_default()
            .push((row, draft.execution_profile.as_str()));
    }
    let cases = scopes
        .into_iter()
        .max_by(|a, b| a.1.len().cmp(&b.1.len()).then_with(|| b.0.cmp(&a.0)))
        .map(|(_, cases)| cases)
        .ok_or_else(|| coverage("The class has no measured training task"))?;
    let mut columns: BTreeMap<String, (Configuration, usize)> = BTreeMap::new();
    for (row, profile) in &cases {
        for cell in row["matrix"].as_array().into_iter().flatten() {
            if cell["observationStatus"] != "observed" {
                continue;
            }
            let Some(configuration) = column_configuration(cell) else {
                continue;
            };
            // Auxiliary calls inside repository workflows share a text
            // identity; a candidate runs the task's own profile.
            if configuration.inventory_revision.is_none()
                || configuration.execution_profile != *profile
                || excluded.contains(&configuration.provider_id)
            {
                continue;
            }
            columns
                .entry(configuration.id.clone())
                .or_insert((configuration, 0))
                .1 += 1;
        }
    }
    let mut chosen: Vec<_> = columns
        .into_values()
        .filter(|(_, count)| *count >= MIN_CANDIDATE_CASES)
        .collect();
    chosen.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.id.cmp(&b.0.id)));
    chosen.truncate(MAX_CANDIDATES);
    if chosen.len() < 2 {
        return Err(coverage(format!(
            "Fewer than two candidates have {MIN_CANDIDATE_CASES} complete training cases in the class"
        )));
    }
    // A case counts when it measured two pool candidates; a candidate whose
    // own counted cases then fall below the bound leaves the pool, and the
    // cases are counted again, until both settle.
    let usable: Vec<&Value> = loop {
        let usable: Vec<&Value> = cases
            .iter()
            .map(|(row, _)| *row)
            .filter(|row| {
                chosen
                    .iter()
                    .filter(|(configuration, _)| observed(row, &configuration.id).is_some())
                    .count()
                    >= 2
            })
            .collect();
        let before = chosen.len();
        chosen.retain(|(configuration, _)| {
            usable
                .iter()
                .filter(|row| observed(row, &configuration.id).is_some())
                .count()
                >= MIN_CANDIDATE_CASES
        });
        if chosen.len() < 2 {
            return Err(coverage(format!(
                "Fewer than two candidates have {MIN_CANDIDATE_CASES} complete training cases in the class"
            )));
        }
        if chosen.len() == before {
            break usable;
        }
    };
    let groups: BTreeSet<_> = usable
        .iter()
        .filter_map(|row| row["splitGroup"].as_str())
        .collect();
    if usable.len() < MIN_CASES || groups.len() < 2 {
        return Err(coverage(
            "Fewer than eight training cases in two groups measured two pool candidates",
        ));
    }
    // Above the fit's case limit, take the groups in turn, so the kept cases
    // still span every group the limit can hold.
    let mut by_group: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for row in &usable {
        if let (Some(group), Some(version)) =
            (row["splitGroup"].as_str(), row["taskVersion"].as_str())
        {
            by_group.entry(group).or_default().push(version.to_owned());
        }
    }
    let mut queues: Vec<std::collections::VecDeque<String>> = by_group
        .into_values()
        .map(|mut versions| {
            versions.sort();
            versions.into()
        })
        .collect();
    let mut version_ids = Vec::new();
    while version_ids.len() < MAX_CASES && queues.iter().any(|q| !q.is_empty()) {
        for queue in &mut queues {
            if version_ids.len() == MAX_CASES {
                break;
            }
            if let Some(version) = queue.pop_front() {
                version_ids.push(version);
            }
        }
    }
    version_ids.sort();
    Ok(FitRequest {
        work_class_id: request.work_class_id.clone(),
        version_ids,
        configurations: chosen.into_iter().map(|(c, _)| c).collect(),
        cutoff_at: cutoff,
        weights: RoleWeights::default(),
        runtime_match: Some(RuntimeMatch::ModelIdentity),
    })
}

/// The newest moment a counted training measurement of the class was
/// recorded: the run, attempt end or evaluation of every repetition the
/// training ledger counts at `now`. Unchanged training cells give the same
/// cutoff, so the same fit; an uncounted attempt never moves it.
fn training_cutoff(data: &QueryData, class: &str, now: i64) -> Result<Option<i64>> {
    let rows =
        export::ledger_rows_matching(data, false, LEDGER_SALT, now, RuntimeMatch::ModelIdentity)?;
    let train: BTreeSet<&str> = data
        .versions
        .iter()
        .filter(|v| v.manifest.split == "train" && v.manifest.work_class_id == class)
        .map(|v| v.id.as_str())
        .collect();
    let counted: BTreeSet<&str> = rows
        .iter()
        .filter(|row| {
            row["taskVersion"]
                .as_str()
                .is_some_and(|id| train.contains(id))
        })
        .flat_map(|row| row["matrix"].as_array().into_iter().flatten())
        .filter(|cell| cell["observationStatus"] == "observed")
        .flat_map(|cell| cell["outcomes"].as_array().into_iter().flatten())
        .filter_map(|outcome| outcome["attemptId"].as_str())
        .collect();
    let runs: BTreeMap<&str, i64> = data
        .runs
        .iter()
        .map(|r| (r.id.as_str(), r.created_at))
        .collect();
    Ok(data
        .attempts
        .iter()
        .filter(|a| counted.contains(a.id.as_str()))
        .flat_map(|a| {
            [a.finished_at, runs.get(a.run_id.as_str()).copied()]
                .into_iter()
                .flatten()
                .chain(a.evaluations.iter().map(|e| e.created_at))
        })
        .max())
}

/// The pool candidates an ordinary chat's fallback order names, in its
/// order: each matcher's provider, words, effort and fast mode must all
/// match (several matches of one matcher in key order). A candidate the order
/// never names is not the persona's; where none it names measured a case,
/// the persona arm is absent there.
pub(super) fn persona_keys(model: &LearnedModel, order: &[RankedMatcher]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for matcher in order {
        let mut matches: Vec<&CandidateModel> = model
            .candidates
            .iter()
            .filter(|candidate| {
                let c = &candidate.configuration;
                let haystack = format!(
                    "{} {}",
                    c.model_id,
                    c.model_name.as_deref().unwrap_or_default()
                )
                .to_lowercase();
                matcher
                    .platform
                    .as_ref()
                    .is_none_or(|platform| platform == &c.provider_id)
                    && matcher
                        .effort
                        .as_ref()
                        .is_none_or(|effort| c.effort.as_ref() == Some(effort))
                    && matcher
                        .fast_mode
                        .is_none_or(|fast| c.fast_mode.unwrap_or(false) == fast)
                    && matcher.needles.iter().any(|set| {
                        set.iter()
                            .all(|needle| haystack.contains(&needle.to_lowercase()))
                    })
            })
            .collect();
        matches.sort_by(|a, b| a.candidate_key.cmp(&b.candidate_key));
        for candidate in matches {
            if !keys.contains(&candidate.candidate_key) {
                keys.push(candidate.candidate_key.clone());
            }
        }
    }
    keys
}

/// The training aggregate for a sparse pool: candidates ranked by their mean
/// case-centred utility (a case's utility minus the mean over the candidates
/// that case measured) over their own training cases, each group weighted
/// equally. Candidates that never shared a case still compare.
pub(super) fn aggregate_keys(artifact: &FitArtifact) -> Vec<String> {
    let mut by_candidate: BTreeMap<&str, BTreeMap<&str, Vec<f64>>> = BTreeMap::new();
    for example in &artifact.snapshot.examples {
        let measured: Vec<(&str, f64)> = example
            .targets
            .iter()
            .filter_map(|t| Some((t.candidate_key.as_str(), t.utility?)))
            .collect();
        if measured.len() < 2 {
            continue;
        }
        let mean = measured.iter().map(|(_, u)| u).sum::<f64>() / measured.len() as f64;
        for (key, utility) in measured {
            by_candidate
                .entry(key)
                .or_default()
                .entry(example.split_group.as_str())
                .or_default()
                .push(utility - mean);
        }
    }
    let score = |key: &str| -> f64 {
        by_candidate.get(key).map_or(f64::NEG_INFINITY, |groups| {
            groups
                .values()
                .map(|v| v.iter().sum::<f64>() / v.len() as f64)
                .sum::<f64>()
                / groups.len() as f64
        })
    };
    let mut keys: Vec<String> = artifact
        .model
        .candidates
        .iter()
        .map(|c| c.candidate_key.clone())
        .collect();
    keys.sort_by(|a, b| score(b).total_cmp(&score(a)).then_with(|| a.cmp(b)));
    keys
}

/// How a held-out version may be counted: its current qualification, and the
/// renderer and browser worker that must have graded its repetitions.
#[derive(Debug, Clone)]
pub(super) struct Countable {
    pub binding: qualification::Binding,
    pub worker: Option<String>,
}

/// The held-out evidence of one evaluation.
#[derive(Debug, Clone)]
pub(super) struct HeldOut {
    pub cases: Vec<ReportCase>,
    /// The candidates measured on at least eight held-out groups.
    pub pool: Vec<String>,
    pub unqualified: usize,
    pub ungraded: usize,
}

/// A countable held-out case: its version, group, task and the present
/// candidates' keys, cells and rewards.
type MeasuredCase<'a> = (
    &'a BenchmarkVersion,
    String,
    PublicTask,
    Vec<(String, &'a Value, f64)>,
);

/// The policy cases of one evaluation: every held-out case of the fit's class
/// and scope with a current qualification, counting the candidates whose cell
/// is complete in one run and graded by the qualified renderer. Only
/// candidates measured on at least eight held-out groups are compared (the
/// certified pool; others join at a later look once measured), and a case
/// needs two of them. An absent candidate is never a zero.
pub(super) fn held_out_cases(
    data: &QueryData,
    artifact: &FitArtifact,
    persona: &[String],
    countable: &BTreeMap<String, Countable>,
    cutoff: i64,
) -> Result<HeldOut> {
    let model = &artifact.model;
    let aggregate = aggregate_keys(artifact);
    let rows =
        export::ledger_rows_matching(data, true, LEDGER_SALT, cutoff, RuntimeMatch::ModelIdentity)?;
    let versions: BTreeMap<_, _> = data.versions.iter().map(|v| (v.id.as_str(), v)).collect();
    let attempts: BTreeMap<_, _> = data.attempts.iter().map(|a| (a.id.as_str(), a)).collect();
    let (mut unqualified, mut ungraded) = (0, 0);
    // Every countable case with its group and its graded, complete cells.
    let mut measured: Vec<MeasuredCase> = Vec::new();
    for row in &rows {
        let Some(version) = row["taskVersion"].as_str().and_then(|id| versions.get(id)) else {
            continue;
        };
        let draft = &version.manifest;
        if draft.split != "held_out"
            || draft.work_class_id != model.work_class_id
            || draft.workflow.is_some()
        {
            continue;
        }
        let task = PublicTask::from(draft);
        if features::extract(&task).is_err()
            || !model.scope_hashes.contains(&features::scope_hash(&task)?)
        {
            continue;
        }
        let Some(countable) = countable.get(&version.id) else {
            unqualified += 1;
            continue;
        };
        let mut present: Vec<(String, &Value, f64)> = Vec::new();
        for candidate in &model.candidates {
            let Some(cell) = observed(row, &candidate.candidate_key) else {
                continue;
            };
            let Some(reward) = cell["reward"]
                .as_f64()
                .filter(|r| r.is_finite() && (0.0..=1.0).contains(r))
            else {
                continue;
            };
            if let Some(installed) = countable.binding.evaluator_runtime_revision.as_deref() {
                if !graded_by(cell, &attempts, installed, countable.worker.as_deref()) {
                    ungraded += 1;
                    continue;
                }
            }
            present.push((candidate.candidate_key.clone(), cell, reward));
        }
        let group = row["splitGroup"]
            .as_str()
            .unwrap_or(&draft.task_family)
            .to_owned();
        measured.push((version, group, task, present));
    }
    // The certified pool: candidates on at least eight groups among the cases
    // two pool candidates measured, until both settle.
    let mut pool: Vec<String> = model
        .candidates
        .iter()
        .map(|c| c.candidate_key.clone())
        .collect();
    loop {
        let before = pool.len();
        let mut groups: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        for (_, group, _, present) in &measured {
            let in_pool: Vec<&str> = present
                .iter()
                .map(|(key, _, _)| key.as_str())
                .filter(|key| pool.iter().any(|p| p == key))
                .collect();
            if in_pool.len() < 2 {
                continue;
            }
            for key in in_pool {
                groups.entry(key).or_default().insert(group.as_str());
            }
        }
        pool.retain(|key| groups.get(key.as_str()).is_some_and(|g| g.len() >= 8));
        if pool.len() == before {
            break;
        }
    }
    let mut cases = Vec::new();
    for (version, group, task, present) in measured {
        let present: Vec<_> = present
            .into_iter()
            .filter(|(key, _, _)| pool.contains(key))
            .collect();
        if present.len() < 2 {
            continue;
        }
        let keys: Vec<String> = present.iter().map(|(key, _, _)| key.clone()).collect();
        let first_of = |order: &[String]| order.iter().find(|key| keys.contains(key)).cloned();
        let persona_key = first_of(persona);
        let aggregate_key = first_of(&aggregate).expect("aggregate covers the pool");
        let learned = choose_among(model, &task, &keys, MIN_QUALITY)?;
        let mut targets: Vec<_> = present
            .iter()
            .map(|(key, cell, reward)| TrainingTarget {
                candidate_key: key.clone(),
                status: "observed".into(),
                reward: Some(*reward),
                utility: None,
                mean_duration_ms: fit::mean_duration(cell),
                mean_cost: fit::mean_cost(cell),
                evidence: Value::Null,
            })
            .collect();
        fit::utilities(&mut targets, model.weights);
        let workers: Vec<ReportCell> = targets
            .into_iter()
            .zip(&present)
            .map(|(target, (_, cell, _))| ReportCell {
                candidate_key: target.candidate_key,
                run_id: cell["runId"].as_str().unwrap_or_default().to_owned(),
                quality: target.reward.expect("observed"),
                utility: target.utility.expect("observed"),
                mean_duration_ms: target.mean_duration_ms,
                mean_cost: target.mean_cost,
                repeats: repeats(cell, &attempts, cutoff),
            })
            .collect();
        // An abstaining prediction falls back as an ordinary chat does: to
        // its fallback order, else to the training aggregate.
        let used_fallback = learned.is_none();
        let learned_key = learned
            .or_else(|| persona_key.clone())
            .unwrap_or_else(|| aggregate_key.clone());
        let arm = |name: &str, key: &str| {
            let mut cell = workers
                .iter()
                .find(|c| c.candidate_key == key)
                .expect("chosen among present")
                .clone();
            cell.candidate_key = name.into();
            cell
        };
        let mut cells = vec![
            arm("learned", &learned_key),
            arm("aggregate", &aggregate_key),
        ];
        if let Some(persona_key) = &persona_key {
            cells.push(arm("persona", persona_key));
        }
        cells.extend(workers.iter().cloned().map(|mut cell| {
            cell.candidate_key = format!("worker:{}", cell.candidate_key);
            cell
        }));
        cases.push(ReportCase {
            version_id: version.id.clone(),
            group,
            learned_key,
            aggregate_key,
            used_fallback,
            cells,
        });
    }
    cases.sort_by(|a, b| a.version_id.cmp(&b.version_id));
    Ok(HeldOut {
        cases,
        pool,
        unqualified,
        ungraded,
    })
}

/// The counted repetitions of a cell: attempt ids and their evaluations,
/// hashed, so a look names exactly the evidence it read.
fn repeats(
    cell: &Value,
    attempts: &BTreeMap<&str, &Attempt>,
    cutoff: i64,
) -> Vec<super::report::RepeatEvidence> {
    let mut repeats: Vec<_> = cell["outcomes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|outcome| attempts.get(outcome["attemptId"].as_str()?))
        .filter_map(|attempt| {
            Some(super::report::RepeatEvidence {
                attempt_id: attempt.id.clone(),
                repetition: attempt.repetition,
                scored_at: attempt.finished_at?,
                quality: super::super::analysis::score_as_of(attempt, Some(cutoff))?,
                duration_ms: attempt.duration_ms.map(|v| v as f64),
                cost: attempt.usage.cost.filter(|v| v.is_finite() && *v >= 0.0),
                evidence_hash: attempt.evidence_hash.clone(),
                evaluations_hash: hash(&attempt.evaluations).ok()?,
            })
        })
        .collect();
    repeats.sort_by(|a, b| (a.repetition, &a.attempt_id).cmp(&(b.repetition, &b.attempt_id)));
    repeats
}

/// Whether every repetition of a renderer-bound cell was graded by the
/// renderer (and browser worker) its version's qualification verified, and
/// at least one names it: the grading renderer, never the one installed now.
fn graded_by(
    cell: &Value,
    attempts: &BTreeMap<&str, &Attempt>,
    installed: &str,
    worker: Option<&str>,
) -> bool {
    let Some(outcomes) = cell["outcomes"].as_array().filter(|o| !o.is_empty()) else {
        return false;
    };
    let mut named = false;
    for outcome in outcomes {
        let Some(attempt) = outcome["attemptId"]
            .as_str()
            .and_then(|id| attempts.get(id))
        else {
            return false;
        };
        // Every evaluation the attempt holds, regrades included, must name
        // the qualified renderer wherever it names one.
        let evaluations: Vec<_> = attempt.evaluations.iter().collect();
        match super::super::promotion::qualified_renderer_grading(&evaluations, installed, worker) {
            Some(name) => named |= name,
            None => return false,
        }
    }
    worker.is_none() || named
}

impl Store {
    /// Held-out versions of a class with their current, attested, unrevoked
    /// qualification on the published content and evaluator.
    async fn countable_held_out(
        &self,
        data: &QueryData,
        class: &str,
    ) -> Result<BTreeMap<String, Countable>> {
        let mut countable = BTreeMap::new();
        for version in data.versions.iter().filter(|v| {
            v.manifest.split == "held_out"
                && v.manifest.work_class_id == class
                && v.manifest.workflow.is_none()
        }) {
            let manifest_hash = hash(&version.manifest)?;
            let Some(binding) = self
                .qualification_bindings(&version.id)
                .await?
                .into_iter()
                .filter(|b| {
                    b.revoked_at.is_none()
                        && b.status == "controls_verified_review_attested"
                        && b.content_hash == version.content_hash
                        && b.manifest_hash == manifest_hash
                        && b.evaluator_revision == version.manifest.evaluator.revision
                })
                .max_by_key(|b| b.created_at)
            else {
                continue;
            };
            let worker = if binding.evaluator_runtime_revision.is_some() {
                self.qualification(&binding.id)
                    .await?
                    .controls
                    .iter()
                    .find_map(|control| control.evaluation.as_ref()?.details.as_ref())
                    .and_then(|details| details.get("runtimeRevision")?.as_str())
                    .map(str::to_owned)
            } else {
                None
            };
            countable.insert(version.id.clone(), Countable { binding, worker });
        }
        Ok(countable)
    }

    pub async fn class_evaluation(&self, id: &str) -> Result<ClassEvaluation> {
        let row =
            sqlx::query("SELECT data_json,artifact_hash FROM selector_certifications WHERE id=?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| {
                    BenchmarkError::new("not_found", "Class evaluation was not found")
                })?;
        let evaluation: ClassEvaluation = serde_json::from_str(row.try_get("data_json")?)?;
        let mut body = evaluation.clone();
        body.artifact_hash.clear();
        if hash(&body)? != evaluation.artifact_hash
            || row.try_get::<String, _>("artifact_hash")? != evaluation.artifact_hash
            || evaluation.id != id
        {
            return Err(invalid("Class evaluation integrity check failed"));
        }
        Ok(evaluation)
    }

    /// The id of a class's newest journaled look: the only one whose
    /// certificate may speak for the class.
    pub async fn newest_class_evaluation_id(&self, class: &str) -> Result<Option<String>> {
        Ok(sqlx::query_scalar(
            "SELECT id FROM selector_certifications WHERE work_class_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .bind(class)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Every journaled evaluation of a class, newest first.
    pub async fn class_evaluations(&self, class: &str) -> Result<Vec<ClassEvaluation>> {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM selector_certifications WHERE work_class_id=? ORDER BY created_at DESC,rowid DESC LIMIT 256",
        )
        .bind(class)
        .fetch_all(&self.pool)
        .await?;
        let mut evaluations = Vec::new();
        for id in ids {
            evaluations.push(self.class_evaluation(&id).await?);
        }
        Ok(evaluations)
    }

    /// The newest evaluation of every class that has one.
    pub async fn latest_class_evaluations(&self) -> Result<Vec<ClassEvaluation>> {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM selector_certifications s WHERE rowid=(SELECT rowid FROM selector_certifications t WHERE t.work_class_id=s.work_class_id ORDER BY created_at DESC,rowid DESC LIMIT 1) ORDER BY work_class_id",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut latest: Vec<ClassEvaluation> = Vec::new();
        for id in ids {
            match self.class_evaluation(&id).await {
                Ok(evaluation)
                    if latest
                        .last()
                        .is_none_or(|e| e.work_class_id != evaluation.work_class_id) =>
                {
                    latest.push(evaluation)
                }
                Ok(_) => {}
                Err(error) => log::warn!(
                    "[benchmarks] skipped class evaluation {id}: {}",
                    error.message
                ),
            }
        }
        Ok(latest)
    }
}

impl BenchmarkService {
    /// Fits a class from its training cells (a fit the data already produced
    /// is reused), then evaluates that fit on the class's held-out cells. The
    /// same fit on the same cells is one look, journaled once; a passing
    /// evaluation issues the class certificate. Makes no model call.
    pub async fn evaluate_class(&self, request: EvaluationRequest) -> Result<ClassEvaluation> {
        validate_request(&request)?;
        let data = self.query_data().await?;
        let countable = self
            .store
            .countable_held_out(&data, &request.work_class_id)
            .await?;
        let excluded = excluded(&request);
        let eligible = countable.clone();
        let order = request.persona_order.clone();
        let (artifact, persona, held) = tauri::async_runtime::spawn_blocking(move || {
            let cutoff = now();
            // The fit's cutoff is its newest counted training measurement, so
            // the same training cells always give the same fit.
            let fit_cutoff =
                training_cutoff(&data, &request.work_class_id, cutoff)?.unwrap_or(cutoff);
            let artifact = fit(&data, training_request(&data, &request, fit_cutoff)?)?;
            let persona = persona_keys(&artifact.model, &request.persona_order);
            let held = held_out_cases(&data, &artifact, &persona, &eligible, cutoff)?;
            Ok::<_, BenchmarkError>((artifact, persona, held))
        })
        .await
        .map_err(|e| BenchmarkError::new("infrastructure_failure", e.to_string()))??;
        self.store.save_selector_fit(&artifact).await?;
        let model = &artifact.model;
        let HeldOut {
            cases,
            pool,
            unqualified,
            ungraded,
        } = held;
        let counted: BTreeSet<&str> = cases.iter().map(|c| c.version_id.as_str()).collect();
        let mut bindings: Vec<qualification::Binding> = countable
            .into_iter()
            .filter(|(id, _)| counted.contains(id.as_str()))
            .map(|(_, c)| c.binding)
            .collect();
        bindings.sort_by(|a, b| a.version_id.cmp(&b.version_id));
        let qualification_ids: Vec<String> = bindings.iter().map(|b| b.id.clone()).collect();
        // Everything a look read and how it judged it: the recipe and its rule,
        // the fit's parameters, the order, the pool, every counted repetition
        // and the qualifications of the counted cases.
        let snapshot_hash = hash(&(
            RECIPE,
            rule(),
            model.recipe_parameters,
            &order,
            &persona,
            &pool,
            &cases,
            &qualification_ids,
        ))?;
        let assessment = if cases.is_empty() {
            None
        } else {
            Some(acceptance::assess_available(&rule(), &cases, &pool)?)
        };
        let candidates = model
            .candidates
            .iter()
            .map(|candidate| {
                let c = &candidate.configuration;
                let worker = format!("worker:{}", candidate.candidate_key);
                EvaluationCandidate {
                    candidate_key: candidate.candidate_key.clone(),
                    provider_id: c.provider_id.clone(),
                    model_id: c.model_id.clone(),
                    model_name: c.model_name.clone(),
                    effort: c.effort.clone(),
                    fast_mode: c.fast_mode,
                    training_cases: candidate.cases,
                    held_out_cases: cases
                        .iter()
                        .filter(|case| case.cells.iter().any(|cell| cell.candidate_key == worker))
                        .count(),
                    learned_cases: cases
                        .iter()
                        .filter(|case| case.learned_key == candidate.candidate_key)
                        .count(),
                }
            })
            .collect();
        let uncapped: BTreeSet<&str> = model
            .candidates
            .iter()
            .map(|c| c.configuration.provider_id.as_str())
            .filter(|p| !super::super::runner::OUTPUT_CAP_PROVIDERS.contains(p))
            .collect();
        let mut limitations = vec![
            "Held-out cases are a permanent evaluation set every model has measured; this is not an unseen-family exam".into(),
            "The look count grows with every journaled evaluation; no correction is made across looks".into(),
            "A cell is the newest run that scored the case, the leaderboard's rule; a newer run stopped part-way leaves its candidate absent there even when an older run is complete, and a run stopped for an outcome-related reason would bias which cells count".into(),
        ];
        if !uncapped.is_empty() {
            limitations.push(format!("An output-token stop of these providers' CLIs is not recognized, so such a cell stays absent instead of scoring zero: {}", uncapped.into_iter().collect::<Vec<_>>().join(", ")));
        }
        let first_case = match cases.first() {
            Some(case) => Some(self.store.version(&case.version_id).await?),
            None => None,
        };
        let passed = assessment.as_ref().is_some_and(|a| a.passed);
        let mut evaluation = ClassEvaluation {
            id: String::new(),
            work_class_id: model.work_class_id.clone(),
            created_at: now(),
            recipe: RECIPE.into(),
            fit_recipe: model.recipe.clone(),
            model_id: model.id.clone(),
            model_snapshot_hash: model.snapshot_hash.clone(),
            look: 0,
            persona_order: order,
            persona_keys: persona,
            pool_keys: pool,
            aggregate_keys: aggregate_keys(&artifact),
            excluded_providers: excluded,
            candidates,
            unqualified_cases: unqualified,
            ungraded_cells: ungraded,
            snapshot_hash,
            status: match &assessment {
                None => "insufficient_evidence",
                Some(a) if a.passed => "certified",
                Some(_) => "not_certified",
            }
            .into(),
            assessment,
            cases,
            limitations,
            qualification_ids,
            certificate_id: None,
            artifact_hash: String::new(),
        };
        // One writer: the dedup check, the look number, the journal row and
        // its certificate commit together or not at all.
        let mut tx = self.store.pool.begin_with("BEGIN IMMEDIATE").await?;
        // Only a repeat of the class's newest look is the same look; the same
        // fit and cells after a different look are journaled again, so the
        // newest look always names what the class stands on.
        let newest: Option<(String, String, String, i64)> = sqlx::query_as(
            "SELECT id,model_id,snapshot_hash,created_at FROM selector_certifications WHERE work_class_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .bind(&evaluation.work_class_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some((id, model_id, snapshot_hash, _)) = &newest {
            if *model_id == evaluation.model_id && *snapshot_hash == evaluation.snapshot_hash {
                let id = id.clone();
                tx.rollback().await?;
                return self.store.class_evaluation(&id).await;
            }
        }
        // Stamped under the lock, never before the newest look's time, so the
        // newest by time is also the highest look number.
        evaluation.created_at = newest.map_or(now(), |(_, _, _, at)| now().max(at));
        let looks: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM selector_certifications WHERE work_class_id=?",
        )
        .bind(&evaluation.work_class_id)
        .fetch_one(&mut *tx)
        .await?;
        evaluation.look = looks as usize + 1;
        evaluation.id = hash(&evaluation)?;
        let certificate = match (passed, first_case) {
            (true, Some(first)) => Some(super::super::promotion::held_out_certificate(
                &evaluation,
                model,
                bindings,
                super::super::promotion::Contract::from_task(&PublicTask::from(&first.manifest)),
            )?),
            _ => None,
        };
        evaluation.certificate_id = certificate.as_ref().map(|c| c.id.clone());
        evaluation.artifact_hash = hash(&evaluation)?;
        sqlx::query("INSERT INTO selector_certifications(id,work_class_id,model_id,snapshot_hash,created_at,data_json,artifact_hash) VALUES(?,?,?,?,?,?,?)")
            .bind(&evaluation.id).bind(&evaluation.work_class_id).bind(&evaluation.model_id)
            .bind(&evaluation.snapshot_hash).bind(evaluation.created_at)
            .bind(serde_json::to_string(&evaluation)?).bind(&evaluation.artifact_hash)
            .execute(&mut *tx).await?;
        if let Some(certificate) = &certificate {
            sqlx::query("INSERT INTO selector_class_certificates(id,evaluation_id,created_at,artifact_json,artifact_hash) VALUES(?,?,?,?,?)")
                .bind(&certificate.id).bind(&evaluation.id).bind(certificate.created_at)
                .bind(serde_json::to_string(certificate)?).bind(&certificate.artifact_hash)
                .execute(&mut *tx).await?;
        }
        tx.commit().await?;
        self.store.class_evaluation(&evaluation.id).await
    }
}

#[cfg(test)]
mod tests;
