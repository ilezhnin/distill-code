//! A class's learned choice, previewed on held-out cases that were already
//! measured. The fit reads training cells only, with a candidate set chosen by
//! a fixed rule before any held-out row is read; the frozen model then replays
//! on the class's held-out cases with the holdout report's arithmetic. Those
//! families are exposed, so this is a retrospective comparison: it grants no
//! routing, no reservation and no promotion.
use super::super::{
    data_use::DataUse,
    export::{self, RuntimeMatch},
    store::{now, Store},
    workflow_campaign, BenchmarkService,
};
use super::report::{PolicyResult, ReportCase, ReportCell, ReportProtocol};
use super::*;
use serde_json::Value;
use sqlx::Row;
use std::collections::BTreeMap;

const RECIPE: &str = "retrospective-exposed-holdout-preview-v1";
/// The quality floor a preview's predictions use, as a frozen comparison would.
const MIN_QUALITY: f64 = 0.5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRequest {
    pub work_class_id: String,
    /// Providers the user leaves out, in addition to the train-only vendors.
    #[serde(default)]
    pub excluded_providers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCandidate {
    pub candidate_key: String,
    pub provider_id: String,
    pub model_id: String,
    pub model_name: Option<String>,
    pub effort: Option<String>,
    pub fast_mode: Option<bool>,
    /// Mean measured quality on the fitted training cases.
    pub training_quality: f64,
    /// Held-out cases on which the learned policy chose this candidate.
    pub learned_cases: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedPreview {
    pub model_id: String,
    pub work_class_id: String,
    pub created_at: i64,
    pub recipe: String,
    pub runtime_match: RuntimeMatch,
    pub training_cases: usize,
    pub training_groups: usize,
    pub excluded_providers: Vec<String>,
    pub candidates: Vec<PreviewCandidate>,
    pub cases: Vec<ReportCase>,
    pub groups: usize,
    pub fallback_cases: usize,
    pub policies: Vec<PolicyResult>,
    pub limitations: Vec<String>,
    pub status: String,
    pub dispatch_allowed: bool,
    pub artifact_hash: String,
}

/// What a class's status line shows about its newest preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSummary {
    pub model_id: String,
    pub created_at: i64,
    pub status: String,
    pub training_cases: usize,
    pub held_out_cases: usize,
    pub groups: usize,
    pub fallback_cases: usize,
    pub candidates: Vec<PreviewCandidate>,
    pub learned: Option<PolicyResult>,
    pub best_fixed: Option<PolicyResult>,
    pub aggregate: Option<PolicyResult>,
}

impl LearnedPreview {
    pub fn summary(&self) -> PreviewSummary {
        let policy = |name: &str| self.policies.iter().find(|p| p.policy == name).cloned();
        PreviewSummary {
            model_id: self.model_id.clone(),
            created_at: self.created_at,
            status: self.status.clone(),
            training_cases: self.training_cases,
            held_out_cases: self.cases.len(),
            groups: self.groups,
            fallback_cases: self.fallback_cases,
            candidates: self.candidates.clone(),
            learned: policy("learned"),
            best_fixed: policy("best_fixed"),
            aggregate: policy("aggregate"),
        }
    }
}

fn coverage(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("insufficient_training_evidence", message)
}

/// The user's exclusions and every provider that may train on submitted
/// data: those see training tasks only, so they never join a pool compared on
/// held-out tasks.
fn excluded(request: &PreviewRequest, data_use: &DataUse) -> Vec<String> {
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

/// The training request a preview fits, decided from training cells only:
/// the class's executor tasks in its largest public scope; every candidate
/// with at least eight complete training cells there, except excluded
/// providers; then the fewest-measured candidates leave until at least eight
/// cases in two groups are measured by all that remain.
pub(super) fn training_request(
    data: &QueryData,
    request: &PreviewRequest,
    cutoff: i64,
    data_use: &DataUse,
) -> Result<FitRequest> {
    if !routing::WORK_CLASSES.contains(&request.work_class_id.as_str())
        || request.excluded_providers.len() > 64
    {
        return Err(invalid(
            "A preview needs a known work class and at most 64 excluded providers",
        ));
    }
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
        .filter(|(_, count)| *count >= MIN_CASES)
        .collect();
    chosen.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.id.cmp(&b.0.id)));
    chosen.truncate(MAX_CANDIDATES);
    loop {
        if chosen.len() < 2 {
            return Err(coverage(
                "Fewer than two candidates share eight complete training cases in two groups under the fixed greedy rule",
            ));
        }
        let common: Vec<&Value> = cases
            .iter()
            .map(|(row, _)| *row)
            .filter(|row| {
                chosen
                    .iter()
                    .all(|(configuration, _)| observed(row, &configuration.id).is_some())
            })
            .collect();
        let groups: BTreeSet<_> = common
            .iter()
            .filter_map(|row| row["splitGroup"].as_str())
            .collect();
        if common.len() >= MIN_CASES && groups.len() >= 2 {
            let mut version_ids: Vec<String> = common
                .iter()
                .filter_map(|row| row["taskVersion"].as_str().map(str::to_owned))
                .collect();
            version_ids.sort();
            version_ids.truncate(MAX_CASES);
            return Ok(FitRequest {
                work_class_id: request.work_class_id.clone(),
                version_ids,
                configurations: chosen.into_iter().map(|(c, _)| c).collect(),
                cutoff_at: cutoff,
                weights: RoleWeights::default(),
                runtime_match: Some(RuntimeMatch::ModelIdentity),
            });
        }
        chosen.pop();
    }
}

/// Replays a fitted model on the exposed held-out cases of its class.
pub(super) fn preview(
    data: &QueryData,
    artifact: &FitArtifact,
    request: &PreviewRequest,
    cutoff: i64,
    data_use: &DataUse,
) -> Result<LearnedPreview> {
    let model = &artifact.model;
    validate_model(model)?;
    let configurations: Vec<_> = model
        .candidates
        .iter()
        .map(|c| c.configuration.clone())
        .collect();
    let keys: Vec<_> = model
        .candidates
        .iter()
        .map(|c| c.candidate_key.clone())
        .collect();
    // The training aggregate is both a comparator and the fallback of an
    // abstaining prediction, as in a frozen comparison.
    let aggregate = workflow_campaign::aggregate_order(artifact, &configurations)?
        .into_iter()
        .next()
        .expect("fitted candidates");
    let available: Vec<_> = configurations
        .iter()
        .cloned()
        .map(|configuration| RoutingCandidate {
            configuration,
            available: true,
            reason: None,
        })
        .collect();
    let rows =
        export::ledger_rows_matching(data, true, LEDGER_SALT, cutoff, RuntimeMatch::ModelIdentity)?;
    let versions: BTreeMap<_, _> = data.versions.iter().map(|v| (v.id.as_str(), v)).collect();
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
        let Some(cells) = keys
            .iter()
            .map(|key| observed(row, key))
            .collect::<Option<Vec<_>>>()
        else {
            continue;
        };
        let rewards: Option<Vec<f64>> = cells
            .iter()
            .map(|cell| {
                cell["reward"]
                    .as_f64()
                    .filter(|r| r.is_finite() && (0.0..=1.0).contains(r))
            })
            .collect();
        let Some(rewards) = rewards else {
            continue;
        };
        let group = row["splitGroup"]
            .as_str()
            .unwrap_or(&draft.task_family)
            .to_owned();
        let prediction = predict(
            model,
            &PredictionRequest {
                task,
                target_family: draft.task_family.clone(),
                target_group: group.clone(),
                candidates: available.clone(),
                hard_candidate_key: None,
                min_quality: MIN_QUALITY,
            },
        )?;
        let mut targets: Vec<_> = keys
            .iter()
            .zip(&cells)
            .zip(&rewards)
            .map(|((key, cell), reward)| TrainingTarget {
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
        cases.push(ReportCase {
            version_id: version.id.clone(),
            group,
            learned_key: prediction
                .chosen_key
                .clone()
                .unwrap_or_else(|| aggregate.clone()),
            aggregate_key: aggregate.clone(),
            used_fallback: prediction.chosen_key.is_none(),
            cells: targets
                .into_iter()
                .zip(&cells)
                .map(|(target, cell)| ReportCell {
                    candidate_key: target.candidate_key,
                    run_id: cell["runId"].as_str().unwrap_or_default().to_owned(),
                    quality: target.reward.expect("observed"),
                    utility: target.utility.expect("observed"),
                    mean_duration_ms: target.mean_duration_ms,
                    mean_cost: target.mean_cost,
                    repeats: vec![],
                })
                .collect(),
        });
    }
    let policies = if cases.is_empty() {
        Vec::new()
    } else {
        let mut names: Vec<String> = ["learned", "aggregate", "best_fixed", "oracle"]
            .map(str::to_owned)
            .to_vec();
        names.extend(keys.iter().map(|key| format!("fixed:{key}")));
        report::summarize_policies(
            &cases,
            &ReportProtocol::new(model.weights),
            &names,
            &keys,
            &aggregate,
        )
    };
    let candidates = model
        .candidates
        .iter()
        .map(|candidate| {
            let rewards: Vec<f64> = artifact
                .snapshot
                .examples
                .iter()
                .filter_map(|example| {
                    example
                        .targets
                        .iter()
                        .find(|t| t.candidate_key == candidate.candidate_key)?
                        .reward
                })
                .collect();
            let c = &candidate.configuration;
            PreviewCandidate {
                candidate_key: candidate.candidate_key.clone(),
                provider_id: c.provider_id.clone(),
                model_id: c.model_id.clone(),
                model_name: c.model_name.clone(),
                effort: c.effort.clone(),
                fast_mode: c.fast_mode,
                training_quality: if rewards.is_empty() {
                    0.0
                } else {
                    rewards.iter().sum::<f64>() / rewards.len() as f64
                },
                learned_cases: cases
                    .iter()
                    .filter(|case| case.learned_key == candidate.candidate_key)
                    .count(),
            }
        })
        .collect();
    let mut result = LearnedPreview {
        model_id: model.id.clone(),
        work_class_id: model.work_class_id.clone(),
        created_at: now(),
        recipe: RECIPE.into(),
        runtime_match: RuntimeMatch::ModelIdentity,
        training_cases: model.training_cases,
        training_groups: model.training_groups.len(),
        excluded_providers: excluded(request, data_use),
        candidates,
        groups: cases.iter().map(|c| &c.group).collect::<BTreeSet<_>>().len(),
        fallback_cases: cases.iter().filter(|c| c.used_fallback).count(),
        status: if cases.is_empty() {
            "no_held_out_cases"
        } else {
            "retrospective_preview"
        }
        .into(),
        cases,
        policies,
        limitations: vec![
            "These held-out families were measured before the fit: an exposed, retrospective comparison, not an unseen evaluation".into(),
            "Cells pool every recorded runtime of a model identity".into(),
            "Small group counts give wide or degenerate intervals, unadjusted for multiple comparisons".into(),
            "Best fixed and oracle are hindsight comparators; best fixed is reselected in every resample".into(),
            "This preview grants no routing, reservation or promotion".into(),
        ],
        dispatch_allowed: false,
        artifact_hash: String::new(),
    };
    result.artifact_hash = hash(&result)?;
    Ok(result)
}

impl BenchmarkService {
    /// Fits a class from its training cells and previews the frozen fit on the
    /// class's measured held-out cases. Makes no model call.
    pub async fn preview_learned_class(&self, request: PreviewRequest) -> Result<LearnedPreview> {
        let data = self.query_data().await?;
        let data_use = DataUse::load(&self.store.root).await;
        let (artifact, preview) = tauri::async_runtime::spawn_blocking(move || {
            let cutoff = now();
            let artifact = fit(&data, training_request(&data, &request, cutoff, &data_use)?)?;
            let preview = preview(&data, &artifact, &request, cutoff, &data_use)?;
            Ok::<_, BenchmarkError>((artifact, preview))
        })
        .await
        .map_err(|e| BenchmarkError::new("infrastructure_failure", e.to_string()))??;
        self.store.save_selector_fit(&artifact).await?;
        self.store.save_selector_preview(&preview).await?;
        Ok(preview)
    }
}

impl Store {
    pub async fn save_selector_preview(&self, preview: &LearnedPreview) -> Result<()> {
        let mut body = preview.clone();
        body.artifact_hash.clear();
        if preview.artifact_hash != hash(&body)? || preview.dispatch_allowed {
            return Err(invalid("Preview integrity check failed"));
        }
        sqlx::query("INSERT OR IGNORE INTO selector_previews(id,model_id,work_class_id,created_at,data_json) VALUES(?,?,?,?,?)")
            .bind(&preview.artifact_hash).bind(&preview.model_id).bind(&preview.work_class_id)
            .bind(preview.created_at).bind(serde_json::to_string(preview)?)
            .execute(&self.pool).await?;
        Ok(())
    }

    /// The newest readable preview of every class that has one. A preview
    /// carries no authority, so an unreadable row never hides the state of
    /// the other classes: it is skipped with a warning and the class shows its
    /// previous preview. Rows are checked against their own columns, not a
    /// hash of today's serialization, so a later field does not void them.
    pub async fn latest_selector_previews(&self) -> Result<Vec<LearnedPreview>> {
        let rows = sqlx::query("SELECT id,model_id,work_class_id,created_at,data_json FROM selector_previews ORDER BY work_class_id,created_at DESC,id DESC LIMIT 4096")
            .fetch_all(&self.pool).await?;
        let mut latest: Vec<LearnedPreview> = Vec::new();
        for row in &rows {
            let class: String = row.try_get("work_class_id")?;
            if latest.last().is_some_and(|p| p.work_class_id == class) {
                continue;
            }
            let id: String = row.try_get("id")?;
            let model: String = row.try_get("model_id")?;
            let created_at: i64 = row.try_get("created_at")?;
            let preview = serde_json::from_str::<LearnedPreview>(row.try_get("data_json")?)
                .ok()
                .filter(|p| {
                    p.artifact_hash == id
                        && p.model_id == model
                        && p.work_class_id == class
                        && p.created_at == created_at
                        && !p.dispatch_allowed
                        && matches!(
                            p.status.as_str(),
                            "retrospective_preview" | "no_held_out_cases"
                        )
                });
            match preview {
                Some(preview) => latest.push(preview),
                None => log::warn!("[benchmarks] skipped an unreadable learned preview {id}"),
            }
        }
        Ok(latest)
    }
}

#[cfg(test)]
mod tests;
