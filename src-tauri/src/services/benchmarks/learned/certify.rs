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
    data_use::DataUse,
    export::{self, RuntimeMatch},
    qualification,
    store::{now, Store},
    workflow_campaign::{self, acceptance},
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

/// One entry of the class's manual order, as the app's ranking names it: a
/// provider (optional) and alternative sets of words the model's id or name
/// must all contain.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankedMatcher {
    #[serde(default)]
    pub platform: Option<String>,
    pub needles: Vec<Vec<String>>,
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
    pub persona_keys: Vec<String>,
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

/// The user's exclusions and every provider that may train on submitted
/// data: those see training tasks only, so they never join a pool compared on
/// held-out tasks.
fn excluded(request: &EvaluationRequest, data_use: &DataUse) -> Vec<String> {
    let mut providers: BTreeSet<String> = data_use
        .providers()
        .into_iter()
        .filter(|provider| provider.trains_on_submissions)
        .map(|provider| provider.provider_id)
        .collect();
    providers.extend(
        request
            .excluded_providers
            .iter()
            .map(|p| p.trim().to_owned())
            .filter(|p| !p.is_empty()),
    );
    providers.into_iter().collect()
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
    data_use: &DataUse,
) -> Result<FitRequest> {
    validate_request(request)?;
    let excluded = excluded(request, data_use);
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

/// The newest moment any training measurement of the class was recorded:
/// a run's creation, an attempt's end or its evaluation, whichever is latest.
fn training_cutoff(data: &QueryData, class: &str) -> Option<i64> {
    let train: BTreeSet<&str> = data
        .versions
        .iter()
        .filter(|v| v.manifest.split == "train" && v.manifest.work_class_id == class)
        .map(|v| v.id.as_str())
        .collect();
    let runs: BTreeMap<&str, i64> = data
        .runs
        .iter()
        .map(|r| (r.id.as_str(), r.created_at))
        .collect();
    data.attempts
        .iter()
        .filter(|a| train.contains(a.version_id.as_str()))
        .flat_map(|a| {
            [a.finished_at, runs.get(a.run_id.as_str()).copied()]
                .into_iter()
                .flatten()
                .chain(a.evaluations.iter().map(|e| e.created_at))
        })
        .max()
}

/// The pool in the class's manual order: candidates each matcher names, in
/// the matchers' order (key order among one matcher's matches), then the rest
/// in key order, so every case has a persona choice among its candidates.
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
    let mut rest: Vec<_> = model
        .candidates
        .iter()
        .map(|c| c.candidate_key.clone())
        .filter(|key| !keys.contains(key))
        .collect();
    rest.sort();
    keys.extend(rest);
    keys
}

/// How a held-out version may be counted: its current qualification, and the
/// renderer and browser worker that must have graded its repetitions.
#[derive(Debug, Clone)]
pub(super) struct Countable {
    pub binding: qualification::Binding,
    pub worker: Option<String>,
}

/// The policy cases of one evaluation: every held-out case of the fit's class
/// and scope with a current qualification, counting the pool candidates whose
/// cell is complete under the single-run rule and graded by the qualified
/// renderer. A case needs two such candidates; an absent candidate is never a
/// zero.
pub(super) fn held_out_cases(
    data: &QueryData,
    artifact: &FitArtifact,
    persona: &[String],
    countable: &BTreeMap<String, Countable>,
    cutoff: i64,
) -> Result<(Vec<ReportCase>, usize, usize)> {
    let model = &artifact.model;
    let configurations: Vec<_> = model
        .candidates
        .iter()
        .map(|c| c.configuration.clone())
        .collect();
    let aggregate = workflow_campaign::aggregate_order(artifact, &configurations)?;
    let rows =
        export::ledger_rows_matching(data, true, LEDGER_SALT, cutoff, RuntimeMatch::ModelIdentity)?;
    let versions: BTreeMap<_, _> = data.versions.iter().map(|v| (v.id.as_str(), v)).collect();
    let attempts: BTreeMap<_, _> = data.attempts.iter().map(|a| (a.id.as_str(), a)).collect();
    let (mut unqualified, mut ungraded) = (0, 0);
    let mut cases = Vec::new();
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
        if present.len() < 2 {
            continue;
        }
        let keys: Vec<String> = present.iter().map(|(key, _, _)| key.clone()).collect();
        let first_of = |order: &[String]| order.iter().find(|key| keys.contains(key)).cloned();
        let persona_key = first_of(persona).expect("persona covers the pool");
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
                repeats: vec![],
            })
            .collect();
        let used_fallback = learned.is_none();
        let learned_key = learned.unwrap_or_else(|| persona_key.clone());
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
            arm("persona", &persona_key),
        ];
        cells.extend(workers.iter().cloned().map(|mut cell| {
            cell.candidate_key = format!("worker:{}", cell.candidate_key);
            cell
        }));
        cases.push(ReportCase {
            version_id: version.id.clone(),
            group: row["splitGroup"]
                .as_str()
                .unwrap_or(&draft.task_family)
                .to_owned(),
            learned_key,
            aggregate_key,
            used_fallback,
            cells,
        });
    }
    cases.sort_by(|a, b| a.version_id.cmp(&b.version_id));
    Ok((cases, unqualified, ungraded))
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

    /// Every journaled evaluation of a class, newest first.
    pub async fn class_evaluations(&self, class: &str) -> Result<Vec<ClassEvaluation>> {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM selector_certifications WHERE work_class_id=? ORDER BY created_at DESC,id DESC LIMIT 256",
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
            "SELECT id FROM selector_certifications s WHERE created_at=(SELECT max(created_at) FROM selector_certifications t WHERE t.work_class_id=s.work_class_id) ORDER BY work_class_id,id",
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
        let data_use = DataUse::load(&self.store.root).await;
        let countable = self
            .store
            .countable_held_out(&data, &request.work_class_id)
            .await?;
        let excluded = excluded(&request, &data_use);
        let eligible = countable.clone();
        let (artifact, persona, cases, unqualified, ungraded) =
            tauri::async_runtime::spawn_blocking(move || {
                let cutoff = now();
                // The fit's cutoff is its newest training measurement, so the
                // same training cells always give the same fit and look.
                let fit_cutoff = training_cutoff(&data, &request.work_class_id).unwrap_or(cutoff);
                let artifact = fit(
                    &data,
                    training_request(&data, &request, fit_cutoff, &data_use)?,
                )?;
                require_held_out_pool(
                    &artifact
                        .model
                        .candidates
                        .iter()
                        .map(|c| c.configuration.clone())
                        .collect::<Vec<_>>(),
                    &data_use,
                )?;
                let persona = persona_keys(&artifact.model, &request.persona_order);
                let (cases, unqualified, ungraded) =
                    held_out_cases(&data, &artifact, &persona, &eligible, cutoff)?;
                Ok::<_, BenchmarkError>((artifact, persona, cases, unqualified, ungraded))
            })
            .await
            .map_err(|e| BenchmarkError::new("infrastructure_failure", e.to_string()))??;
        self.store.save_selector_fit(&artifact).await?;
        let model = &artifact.model;
        let snapshot_hash = hash(&(&cases, &persona))?;
        let journaled: Option<String> = sqlx::query_scalar(
            "SELECT id FROM selector_certifications WHERE model_id=? AND snapshot_hash=?",
        )
        .bind(&model.id)
        .bind(&snapshot_hash)
        .fetch_optional(&self.store.pool)
        .await?;
        if let Some(id) = journaled {
            return self.store.class_evaluation(&id).await;
        }
        let keys: Vec<String> = model
            .candidates
            .iter()
            .map(|c| c.candidate_key.clone())
            .collect();
        let assessment = if cases.is_empty() {
            None
        } else {
            Some(acceptance::assess_available(&rule(), &cases, &keys)?)
        };
        let configurations: Vec<_> = model
            .candidates
            .iter()
            .map(|c| c.configuration.clone())
            .collect();
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
        let uncapped: BTreeSet<&str> = configurations
            .iter()
            .map(|c| c.provider_id.as_str())
            .filter(|p| !super::super::runner::OUTPUT_CAP_PROVIDERS.contains(p))
            .collect();
        let mut limitations = vec![
            "Held-out cases are a permanent evaluation set every model has measured; this is not an unseen-family exam".into(),
            "The look count grows with every journaled evaluation; no correction is made across looks".into(),
        ];
        if !uncapped.is_empty() {
            limitations.push(format!("An output-token stop of these providers' CLIs is not recognized, so such a cell stays absent instead of scoring zero: {}", uncapped.into_iter().collect::<Vec<_>>().join(", ")));
        }
        let look: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM selector_certifications WHERE work_class_id=?",
        )
        .bind(&model.work_class_id)
        .fetch_one(&self.store.pool)
        .await?;
        let counted: BTreeSet<&str> = cases.iter().map(|c| c.version_id.as_str()).collect();
        let mut bindings: Vec<qualification::Binding> = countable
            .into_iter()
            .filter(|(id, _)| counted.contains(id.as_str()))
            .map(|(_, c)| c.binding)
            .collect();
        bindings.sort_by(|a, b| a.version_id.cmp(&b.version_id));
        let passed = assessment.as_ref().is_some_and(|a| a.passed);
        let mut evaluation = ClassEvaluation {
            id: String::new(),
            work_class_id: model.work_class_id.clone(),
            created_at: now(),
            recipe: RECIPE.into(),
            fit_recipe: model.recipe.clone(),
            model_id: model.id.clone(),
            model_snapshot_hash: model.snapshot_hash.clone(),
            look: look as usize + 1,
            aggregate_keys: workflow_campaign::aggregate_order(&artifact, &configurations)?,
            persona_keys: persona,
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
            qualification_ids: bindings.iter().map(|b| b.id.clone()).collect(),
            certificate_id: None,
            artifact_hash: String::new(),
        };
        evaluation.id = hash(&evaluation)?;
        if passed {
            let first = self.store.version(&evaluation.cases[0].version_id).await?;
            evaluation.certificate_id = Some(
                self.store
                    .issue_class_certificate(
                        &evaluation,
                        model,
                        bindings,
                        super::super::promotion::Contract::from_task(&PublicTask::from(
                            &first.manifest,
                        )),
                    )
                    .await?,
            );
        }
        evaluation.artifact_hash = hash(&evaluation)?;
        sqlx::query("INSERT OR IGNORE INTO selector_certifications(id,work_class_id,model_id,snapshot_hash,created_at,data_json,artifact_hash) VALUES(?,?,?,?,?,?,?)")
            .bind(&evaluation.id).bind(&evaluation.work_class_id).bind(&evaluation.model_id)
            .bind(&evaluation.snapshot_hash).bind(evaluation.created_at)
            .bind(serde_json::to_string(&evaluation)?).bind(&evaluation.artifact_hash)
            .execute(&self.store.pool).await?;
        self.store.class_evaluation(&evaluation.id).await
    }
}

#[cfg(test)]
mod tests;
