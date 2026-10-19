//! Reproducible research fits. Inference has no ledger or training examples.
//! Promotion and dispatch require separate evidence; this module grants neither.
mod features;
mod fit;

pub mod certify;
mod persistence;
pub mod report;
#[cfg(test)]
pub(super) mod tests;

use super::{routing, selector::RoleWeights, types::*};
pub(super) use features::scope_hash;
pub use fit::fit;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const LEGACY_RECIPE: &str = "family-weighted-ridge-v1";
const RECIPE_V1: &str = "family-weighted-softmax-kl-v1";
/// Conductor-style: the selection head learns from seeded random subsets of
/// the candidates each training case measured, so it chooses among whatever
/// candidates are present and a candidate joins once it has training cells.
const RECIPE: &str = "family-weighted-softmax-kl-v2-random-subsets";
/// Subsets drawn per training case: the full measured set first, then
/// `SUBSET_DRAWS - 1` random ones of at least two candidates.
const SUBSET_DRAWS: usize = 8;
/// Each measured candidate joins a random subset with this probability.
const SUBSET_INCLUSION: f64 = 0.5;
/// Seed of the subset stream; a case's own stream mixes in its version id.
const SUBSET_SEED: u64 = 0x5355_4253_4554_0002;
/// Training cases a candidate needs before it joins the pool.
const MIN_CANDIDATE_CASES: usize = 8;
const SELECTION_TEMPERATURE: f64 = 0.25;
const FEATURE_VERSION: &str = "public-task-hash-v1";
const DIMENSIONS: usize = 128;
const ITERATIONS: usize = 400;
const LEARNING_RATE: f64 = 0.2;
const REGULARIZATION: f64 = 0.002;
const MIN_CASES: usize = 8;
const MAX_CASES: usize = 256;
const MAX_CANDIDATES: usize = 32;
/// Pseudonym salt of the training ledger; it names no account in the result.
const LEDGER_SALT: &str = "learned-selector-v1";
/// Refuses a held-out comparison pool with a provider that may train on what
/// it is sent: the provider data-use rule keeps it on training tasks.
pub(in crate::services::benchmarks) fn require_held_out_pool(
    configurations: &[Configuration],
    data_use: &super::data_use::DataUse,
) -> Result<()> {
    match configurations
        .iter()
        .find_map(|c| data_use.refusal(&c.provider_id, "held_out"))
    {
        Some(reason) => Err(invalid(reason)),
        None => Ok(()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicEntry {
    pub conversation_prefix: String,
    pub previous_reports: Vec<String>,
    pub remaining_budget_seconds: u32,
}

/// Deliberate allowlist: no evaluator, environment, source, IDs or labels.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicTask {
    pub work_class_id: String,
    pub prompt: String,
    pub fixtures: Vec<Fixture>,
    pub facets: TaskFacets,
    pub role_id: Option<String>,
    pub role_prompt: String,
    pub permissions: Permissions,
    pub execution_profile: String,
    pub limits: Limits,
    pub entry: Option<PublicEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_recipe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_recipe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_artifact: Option<super::repository::Artifact>,
}

impl From<&BenchmarkDraft> for PublicTask {
    fn from(draft: &BenchmarkDraft) -> Self {
        Self {
            work_class_id: draft.work_class_id.clone(),
            prompt: draft.prompt.clone(),
            fixtures: draft.fixtures.clone(),
            facets: draft.facets.clone(),
            role_id: draft.role_id.clone(),
            role_prompt: draft.role_prompt.clone(),
            permissions: draft.permissions.clone(),
            execution_profile: draft.execution_profile.clone(),
            limits: draft.limits.clone(),
            entry: draft.entry_state.as_ref().map(|entry| PublicEntry {
                conversation_prefix: entry.conversation_prefix.clone(),
                previous_reports: entry.previous_reports.clone(),
                remaining_budget_seconds: entry.remaining_budget_seconds,
            }),
            budget_recipe: draft
                .environment
                .get("nativeBudgetRecipe")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            repository_recipe: draft
                .environment
                .get(super::artifact_context::INPUT_KEY)
                .and_then(|input| input.pointer("/before/recipe"))
                .and_then(serde_json::Value::as_str)
                .or_else(|| {
                    draft
                        .environment
                        .get("nativeRepositoryRecipe")
                        .and_then(serde_json::Value::as_str)
                })
                .map(str::to_owned),
            repository_artifact: draft
                .environment
                .get(super::artifact_context::INPUT_KEY)
                .and_then(|input| input.get("before"))
                .and_then(|value| serde_json::from_value(value.clone()).ok()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitRequest {
    pub work_class_id: String,
    pub version_ids: Vec<String>,
    pub configurations: Vec<Configuration>,
    pub cutoff_at: i64,
    #[serde(default)]
    pub weights: RoleWeights,
    /// Which runtimes a candidate's training cells may come from; omitted is
    /// the exact newest runtime, which keeps earlier snapshot hashes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_match: Option<super::export::RuntimeMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateModel {
    pub candidate_key: String,
    pub configuration: Configuration,
    pub cases: usize,
    pub quality_coefficients: Vec<f64>,
    pub utility_coefficients: Vec<f64>,
    /// Joint selection logits; absent in the original independent ridge recipe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_coefficients: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedModel {
    pub id: String,
    pub recipe: String,
    pub feature_version: String,
    pub candidate_key_algorithm: String,
    pub work_class_id: String,
    pub cutoff_at: i64,
    pub weights: RoleWeights,
    pub snapshot_hash: String,
    pub training_cases: usize,
    pub common_cases: usize,
    pub training_families: Vec<String>,
    pub training_groups: Vec<String>,
    pub scope_hashes: Vec<String>,
    pub candidates: Vec<CandidateModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingTarget {
    pub candidate_key: String,
    pub status: String,
    pub reward: Option<f64>,
    pub utility: Option<f64>,
    pub mean_duration_ms: Option<f64>,
    pub mean_cost: Option<f64>,
    /// Frozen repeated observations and evaluation revisions, only for audit/refit.
    pub evidence: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingExample {
    pub version_id: String,
    pub content_hash: String,
    pub family: String,
    pub split_group: String,
    pub evaluator_revision: String,
    pub task: PublicTask,
    pub targets: Vec<TrainingTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingSnapshot {
    pub request: FitRequest,
    pub examples: Vec<TrainingExample>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FitArtifact {
    pub created_at: i64,
    pub model: LearnedModel,
    pub snapshot: TrainingSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FitSummary {
    pub id: String,
    pub created_at: i64,
    pub work_class_id: String,
    pub training_cases: usize,
    pub common_cases: usize,
    pub groups: usize,
    pub candidates: usize,
    pub dispatch_allowed: bool,
    pub status: String,
}

impl FitArtifact {
    pub fn summary(&self) -> FitSummary {
        FitSummary {
            id: self.model.id.clone(),
            created_at: self.created_at,
            work_class_id: self.model.work_class_id.clone(),
            training_cases: self.model.training_cases,
            common_cases: self.model.common_cases,
            groups: self.model.training_groups.len(),
            candidates: self.model.candidates.len(),
            dispatch_allowed: false,
            status: "research_only".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PredictionRequest {
    pub task: PublicTask,
    /// Metadata for exclusion only; these strings never enter the feature vector.
    pub target_family: String,
    pub target_group: String,
    pub candidates: Vec<RoutingCandidate>,
    pub hard_candidate_key: Option<String>,
    pub min_quality: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionScore {
    pub candidate_key: String,
    pub configuration: Configuration,
    /// Regression estimates, not calibrated success probabilities.
    pub quality: f64,
    pub utility: f64,
    /// Relative selection mass among the scored candidates, not success probability.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_probability: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prediction {
    pub model_id: String,
    pub chosen: Option<Configuration>,
    pub chosen_key: Option<String>,
    pub reason: String,
    pub dispatch_allowed: bool,
    pub scores: Vec<PredictionScore>,
}

fn invalid(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("validation", message)
}

fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

fn model_hash(model: &LearnedModel) -> Result<String> {
    let mut body = model.clone();
    body.id.clear();
    hash(&body)
}

fn validate_model(model: &LearnedModel) -> Result<()> {
    if !matches!(model.recipe.as_str(), RECIPE | RECIPE_V1 | LEGACY_RECIPE)
        || model.feature_version != FEATURE_VERSION
        || model.candidate_key_algorithm != routing::CANDIDATE_KEY_ALGORITHM
        || model.id != model_hash(model)?
        || !(2..=MAX_CANDIDATES).contains(&model.candidates.len())
        || (model.recipe != RECIPE && model.common_cases < MIN_CASES)
        || model.training_cases < MIN_CASES
        || model.training_cases > MAX_CASES
        || model.training_groups.len() < 2
        || model.candidates.iter().any(|candidate| {
            candidate.candidate_key != routing::candidate_key(&candidate.configuration)
                || candidate
                    .configuration
                    .inventory_revision
                    .as_deref()
                    .is_none_or(str::is_empty)
                || [
                    &candidate.quality_coefficients,
                    &candidate.utility_coefficients,
                ]
                .iter()
                .any(|head| head.len() != DIMENSIONS || head.iter().any(|v| !v.is_finite()))
                || match (&candidate.selection_coefficients, model.recipe.as_str()) {
                    (Some(head), RECIPE | RECIPE_V1) => {
                        head.len() != DIMENSIONS || head.iter().any(|v| !v.is_finite())
                    }
                    (None, LEGACY_RECIPE) => false,
                    _ => true,
                }
        })
    {
        return Err(BenchmarkError::new(
            "invalid_model",
            "Unsupported or damaged learned selector model",
        ));
    }
    Ok(())
}

fn softmax(logits: &[f64]) -> Result<Vec<f64>> {
    if logits.iter().any(|value| !value.is_finite()) {
        return Err(BenchmarkError::new(
            "invalid_model",
            "Non-finite selection logits",
        ));
    }
    let maximum = logits.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mut probabilities: Vec<_> = logits.iter().map(|value| (value - maximum).exp()).collect();
    let total: f64 = probabilities.iter().sum();
    for probability in &mut probabilities {
        *probability /= total;
    }
    Ok(probabilities)
}

fn rank_scores(model: &LearnedModel, x: &[f64], scores: &mut [PredictionScore]) -> Result<()> {
    if matches!(model.recipe.as_str(), RECIPE | RECIPE_V1) {
        let logits: Vec<_> = scores
            .iter()
            .map(|score| {
                let candidate = model
                    .candidates
                    .iter()
                    .find(|candidate| candidate.candidate_key == score.candidate_key)
                    .expect("scored candidate is trained");
                features::dot(
                    x,
                    candidate
                        .selection_coefficients
                        .as_ref()
                        .expect("validated joint head"),
                )
            })
            .collect();
        for (score, probability) in scores.iter_mut().zip(softmax(&logits)?) {
            score.selection_probability = Some(probability);
        }
    }
    scores.sort_by(|a, b| {
        b.selection_probability
            .unwrap_or(b.utility)
            .total_cmp(&a.selection_probability.unwrap_or(a.utility))
            .then(a.candidate_key.cmp(&b.candidate_key))
    });
    Ok(())
}

pub(super) fn validate_public_request(request: &PredictionRequest) -> Result<Vec<f64>> {
    let x = features::extract(&request.task)?;
    let keys: BTreeSet<_> = request
        .candidates
        .iter()
        .map(|c| routing::candidate_key(&c.configuration))
        .collect();
    if request.candidates.len() > MAX_CANDIDATES
        || keys.len() != request.candidates.len()
        || !request.min_quality.is_finite()
        || !(0.0..=1.0).contains(&request.min_quality)
        || request.target_family.trim().is_empty()
        || request.target_group.trim().is_empty()
    {
        return Err(invalid(
            "Prediction needs distinct candidates, family/group and a quality floor from 0 to 1",
        ));
    }
    Ok(x)
}

/// Pure inference: no QueryData, Store, labels, examples or hidden evaluators.
pub fn predict(model: &LearnedModel, request: &PredictionRequest) -> Result<Prediction> {
    validate_model(model)?;
    let x = validate_public_request(request)?;
    let mut result = Prediction {
        model_id: model.id.clone(),
        chosen: None,
        chosen_key: None,
        reason: String::new(),
        dispatch_allowed: false,
        scores: Vec::new(),
    };
    let refused = if model.work_class_id != request.task.work_class_id {
        Some("untrained_work_class")
    } else if model.training_families.contains(&request.target_family)
        || model.training_groups.contains(&request.target_group)
    {
        Some("training_family_or_group")
    } else if !model
        .scope_hashes
        .contains(&features::scope_hash(&request.task)?)
    {
        Some("untrained_role_or_execution_context")
    } else {
        None
    };
    if let Some(reason) = refused {
        result.reason = reason.into();
        return Ok(result);
    }
    for candidate in request.candidates.iter().filter(|c| c.available) {
        let key = routing::candidate_key(&candidate.configuration);
        if request
            .hard_candidate_key
            .as_ref()
            .is_some_and(|pin| pin != &key)
        {
            continue;
        }
        let Some(trained) = model.candidates.iter().find(|c| c.candidate_key == key) else {
            result.reason = "untrained_available_candidate".into();
            return Ok(result);
        };
        if candidate.configuration.inventory_revision != trained.configuration.inventory_revision {
            result.reason = "changed_candidate_runtime".into();
            return Ok(result);
        }
        result.scores.push(PredictionScore {
            candidate_key: key,
            configuration: candidate.configuration.clone(),
            quality: features::dot(&x, &trained.quality_coefficients).clamp(0.0, 1.0),
            utility: features::dot(&x, &trained.utility_coefficients).clamp(0.0, 1.0),
            selection_probability: None,
        });
    }
    rank_scores(model, &x, &mut result.scores)?;
    if let Some(best) = result
        .scores
        .iter()
        .find(|s| s.quality >= request.min_quality)
    {
        result.chosen = Some(best.configuration.clone());
        result.chosen_key = Some(best.candidate_key.clone());
        result.reason = if request.hard_candidate_key.is_some() {
            "research_explicit_pin"
        } else {
            "research_prediction"
        }
        .into();
    } else {
        result.reason = if result.scores.is_empty() {
            if request.hard_candidate_key.is_some() {
                "explicit_pin_unavailable"
            } else {
                "no_available_candidates"
            }
        } else {
            "below_quality_floor"
        }
        .into();
    }
    Ok(result)
}

/// Inference for an ordinary chat or wave task of a certified work class.
/// Its role, tools and context are outside any frozen scope, so only the class
/// must match; the choice is among the trained candidates that are available
/// on their trained runtime, and untrained ones are left to the caller's
/// fallback order instead of refusing the whole selection.
pub fn predict_for_class(model: &LearnedModel, request: &PredictionRequest) -> Result<Prediction> {
    validate_model(model)?;
    let x = validate_public_request(request)?;
    let mut result = Prediction {
        model_id: model.id.clone(),
        chosen: None,
        chosen_key: None,
        reason: String::new(),
        dispatch_allowed: false,
        scores: Vec::new(),
    };
    if model.work_class_id != request.task.work_class_id {
        result.reason = "untrained_work_class".into();
        return Ok(result);
    }
    for candidate in request.candidates.iter().filter(|c| c.available) {
        let key = routing::candidate_key(&candidate.configuration);
        let Some(trained) = model.candidates.iter().find(|c| {
            c.candidate_key == key
                && c.configuration.inventory_revision == candidate.configuration.inventory_revision
        }) else {
            continue;
        };
        result.scores.push(PredictionScore {
            candidate_key: key,
            configuration: candidate.configuration.clone(),
            quality: features::dot(&x, &trained.quality_coefficients).clamp(0.0, 1.0),
            utility: features::dot(&x, &trained.utility_coefficients).clamp(0.0, 1.0),
            selection_probability: None,
        });
    }
    rank_scores(model, &x, &mut result.scores)?;
    if let Some(best) = result
        .scores
        .iter()
        .find(|s| s.quality >= request.min_quality)
    {
        result.chosen = Some(best.configuration.clone());
        result.chosen_key = Some(best.candidate_key.clone());
        result.reason = "certified_class_prediction".into();
    } else {
        result.reason = if result.scores.is_empty() {
            "no_trained_available_candidate"
        } else {
            "below_quality_floor"
        }
        .into();
    }
    Ok(result)
}

/// The learned choice among the candidates a held-out case actually
/// measured, as an ordinary chat of the class chooses among the trained
/// candidates it has: the highest selection mass whose estimated quality
/// reaches the floor, or none, when the caller's own order decides.
pub(super) fn choose_among(
    model: &LearnedModel,
    task: &PublicTask,
    present: &[String],
    min_quality: f64,
) -> Result<Option<String>> {
    validate_model(model)?;
    let x = features::extract(task)?;
    let mut scores: Vec<PredictionScore> = model
        .candidates
        .iter()
        .filter(|trained| present.contains(&trained.candidate_key))
        .map(|trained| PredictionScore {
            candidate_key: trained.candidate_key.clone(),
            configuration: trained.configuration.clone(),
            quality: features::dot(&x, &trained.quality_coefficients).clamp(0.0, 1.0),
            utility: features::dot(&x, &trained.utility_coefficients).clamp(0.0, 1.0),
            selection_probability: None,
        })
        .collect();
    rank_scores(model, &x, &mut scores)?;
    Ok(scores
        .into_iter()
        .find(|s| s.quality >= min_quality)
        .map(|s| s.candidate_key))
}
