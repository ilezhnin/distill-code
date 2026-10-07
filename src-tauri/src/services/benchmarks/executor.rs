//! One recorded selection boundary for interactive suggestions and wave dispatch.
//! Research predictions are inspectable, but cannot authorize a worker change.

use super::{learned, routing, store::now, store::Store, types::*};
use crate::services::agent_host::executor_receipts::ExecutorReceipt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::BTreeSet;

#[cfg(test)]
mod tests;

const POLICY_VERSION: &str = "executor-selection-v1";

/// Application callers identify inventory rows; canonical evidence keys stay native.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationRequest {
    pub request_key: String,
    pub surface: String,
    pub context_id: String,
    pub task: learned::PublicTask,
    pub target_family: String,
    pub target_group: String,
    pub candidates: Vec<RoutingCandidate>,
    pub prior_ids: Vec<String>,
    pub hard_candidate_id: Option<String>,
    pub model_id: Option<String>,
    pub min_quality: f64,
}

impl TryFrom<ApplicationRequest> for Request {
    type Error = BenchmarkError;

    fn try_from(value: ApplicationRequest) -> Result<Self> {
        let identities: std::collections::BTreeMap<_, _> = value
            .candidates
            .iter()
            .map(|row| {
                (
                    row.configuration.id.clone(),
                    routing::candidate_key(&row.configuration),
                )
            })
            .collect();
        if identities.len() != value.candidates.len()
            || identities.keys().any(|id| id.trim().is_empty())
        {
            return Err(error(
                "validation",
                "Application candidate IDs must be distinct and nonempty",
            ));
        }
        let key = |id: &String| {
            identities.get(id).cloned().ok_or_else(|| {
                error(
                    "validation",
                    "Application preference does not identify an inventory candidate",
                )
            })
        };
        let request = Self {
            request_key: value.request_key,
            surface: value.surface,
            context_id: value.context_id,
            prediction: learned::PredictionRequest {
                task: value.task,
                target_family: value.target_family,
                target_group: value.target_group,
                candidates: value.candidates,
                hard_candidate_key: value.hard_candidate_id.as_ref().map(key).transpose()?,
                min_quality: value.min_quality,
            },
            prior_keys: value.prior_ids.iter().map(key).collect::<Result<_>>()?,
            model_id: value.model_id,
        };
        validate(&request)?;
        Ok(request)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    /// Stable per accepted task/step, never regenerated for a dispatch retry.
    pub request_key: String,
    /// `chat` or `wave`; this is attribution, not a different policy.
    pub surface: String,
    pub context_id: String,
    pub prediction: learned::PredictionRequest,
    /// Caller-resolved persona order, expressed as exact candidate identities.
    pub prior_keys: Vec<String>,
    /// Optional research model to inspect. Its ID confers no dispatch authority.
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub request: Request,
    pub input_hash: String,
    pub artifact_hash: String,
    pub created_at: i64,
    pub policy_version: String,
    pub chosen: Option<Configuration>,
    pub chosen_key: Option<String>,
    pub source: String,
    pub reason: String,
    pub learned_status: String,
    pub research_prediction: Option<learned::Prediction>,
    /// False until a separately verified promotion authorizes learned dispatch.
    pub learned_dispatch_allowed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub phase: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    /// Actual reported executor, never filled from the selected intent.
    pub configuration: Option<Configuration>,
    pub outcome: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedObservation {
    pub created_at: i64,
    pub observation: Observation,
    /// None when no executor was observed (for example cancellation before start).
    pub matches_selected: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub decision: Decision,
    pub observations: Vec<RecordedObservation>,
    /// Joined from the host's durable receipt, never supplied by renderer observations.
    pub host_execution: Option<ExecutorReceipt>,
}

fn error(code: &str, message: &str) -> BenchmarkError {
    BenchmarkError::new(code, message)
}

fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

fn artifact_hash(decision: &Decision) -> Result<String> {
    let mut body = decision.clone();
    body.artifact_hash.clear();
    hash(&body)
}

fn validate(request: &Request) -> Result<()> {
    let prediction = &request.prediction;
    let candidates = &prediction.candidates;
    let keys: BTreeSet<_> = candidates
        .iter()
        .map(|candidate| routing::candidate_key(&candidate.configuration))
        .collect();
    if request.request_key.trim().is_empty()
        || request.request_key.len() > 256
        || request.context_id.trim().is_empty()
        || request.context_id.len() > 256
        || !matches!(request.surface.as_str(), "chat" | "wave")
        || candidates.len() > 32
        || candidates.iter().any(|candidate| {
            candidate.configuration.provider_id.trim().is_empty()
                || candidate.configuration.model_id.trim().is_empty()
        })
        || keys.len() != candidates.len()
        || request.prior_keys.len() > 32
        || request.prior_keys.iter().collect::<BTreeSet<_>>().len() != request.prior_keys.len()
        || request.prior_keys.iter().any(|key| !keys.contains(key))
        || request
            .model_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 128)
        || serde_json::to_vec(request)?.len() > 2 * 1024 * 1024
    {
        return Err(error("validation", "Invalid executor decision inputs"));
    }
    // Apply the same public-feature bounds even when no fit is available.
    learned::validate_public_request(prediction)?;
    Ok(())
}

impl Store {
    /// Reads model coefficients only. This path never loads training labels or runs.
    pub async fn preview_executor_decision(&self, request: Request) -> Result<Decision> {
        validate(&request)?;
        let prediction = &request.prediction;
        let available = |key: &str| {
            prediction.candidates.iter().find(|candidate| {
                candidate.available && routing::candidate_key(&candidate.configuration) == key
            })
        };
        let (chosen, source, reason) = if let Some(pin) = &prediction.hard_candidate_key {
            match available(pin) {
                Some(candidate) => (Some(candidate.configuration.clone()), "pin", "explicit_pin"),
                None => (None, "none", "pinned_candidate_unavailable"),
            }
        } else {
            match request.prior_keys.iter().find_map(|key| available(key)) {
                Some(candidate) => (
                    Some(candidate.configuration.clone()),
                    "prior",
                    "persona_prior",
                ),
                None => (None, "none", "no_available_prior"),
            }
        };
        // Selection and prediction are deliberately separate. Neither a fitted
        // model nor a good-looking research report is a promotion certificate.
        let (research_prediction, learned_status) = match &request.model_id {
            None => (None, "not_requested".to_owned()),
            Some(id) => match self.selector_model(id).await {
                Ok(model) => {
                    let result = learned::predict(&model, prediction)?;
                    (Some(result), "promotion_required".to_owned())
                }
                Err(failure) if failure.code == "not_found" => {
                    (None, "model_unavailable".to_owned())
                }
                Err(failure) => return Err(failure),
            },
        };
        let mut decision = Decision {
            input_hash: hash(&request)?,
            request,
            artifact_hash: String::new(),
            created_at: now(),
            policy_version: POLICY_VERSION.into(),
            chosen_key: chosen.as_ref().map(routing::candidate_key),
            chosen,
            source: source.into(),
            reason: reason.into(),
            learned_status,
            research_prediction,
            learned_dispatch_allowed: false,
        };
        decision.artifact_hash = artifact_hash(&decision)?;
        Ok(decision)
    }

    /// Commit before any external session effect. Repeated keys never reselect.
    pub async fn prepare_executor_decision(&self, request: Request) -> Result<Decision> {
        validate(&request)?;
        if let Some(record) = self.executor_decision(&request.request_key).await? {
            return same_request(record.decision, &request);
        }
        let decision = self.preview_executor_decision(request).await?;
        sqlx::query("INSERT OR IGNORE INTO executor_decisions(request_key,input_hash,created_at,decision_json) VALUES(?,?,?,?)")
            .bind(&decision.request.request_key).bind(&decision.input_hash).bind(decision.created_at)
            .bind(serde_json::to_string(&decision)?).execute(&self.pool).await?;
        let saved = self
            .executor_decision(&decision.request.request_key)
            .await?
            .ok_or_else(|| error("storage_unavailable", "Prepared decision disappeared"))?;
        same_request(saved.decision, &decision.request)
    }

    pub async fn executor_decision(&self, request_key: &str) -> Result<Option<Record>> {
        let row = sqlx::query("SELECT input_hash,created_at,decision_json FROM executor_decisions WHERE request_key=?")
            .bind(request_key).fetch_optional(&self.pool).await?;
        let Some(row) = row else { return Ok(None) };
        let decision: Decision = serde_json::from_str(row.try_get("decision_json")?)?;
        if decision.request.request_key != request_key
            || decision.input_hash != row.try_get::<String, _>("input_hash")?
            || decision.created_at != row.try_get::<i64, _>("created_at")?
            || decision.input_hash != hash(&decision.request)?
            || decision.artifact_hash != artifact_hash(&decision)?
        {
            return Err(error(
                "invalid_decision",
                "Executor decision integrity check failed",
            ));
        }
        let rows = sqlx::query("SELECT phase,created_at,observation_json,artifact_hash FROM executor_observations WHERE request_key=? ORDER BY CASE phase WHEN 'started' THEN 0 ELSE 1 END")
            .bind(request_key).fetch_all(&self.pool).await?;
        let mut observations = Vec::new();
        for row in rows {
            let observation: RecordedObservation =
                serde_json::from_str(row.try_get("observation_json")?)?;
            if observation.observation.phase != row.try_get::<String, _>("phase")?
                || observation.created_at != row.try_get::<i64, _>("created_at")?
                || hash(&(request_key, &observation))?
                    != row.try_get::<String, _>("artifact_hash")?
            {
                return Err(error(
                    "invalid_decision",
                    "Executor observation integrity check failed",
                ));
            }
            observations.push(observation);
        }
        Ok(Some(Record {
            decision,
            observations,
            host_execution: None,
        }))
    }

    /// Append observed execution. Mismatches stay visible and are not relabelled.
    pub async fn observe_executor(
        &self,
        request_key: &str,
        observation: Observation,
    ) -> Result<Record> {
        let record = self
            .executor_decision(request_key)
            .await?
            .ok_or_else(|| error("not_found", "Executor decision was not prepared"))?;
        validate_observation(&record, &observation)?;
        let matches_selected = observation
            .configuration
            .as_ref()
            .and_then(|configuration| {
                let Some(chosen) = record.decision.chosen.as_ref() else {
                    return Some(false);
                };
                if chosen.provider_id != configuration.provider_id
                    || chosen.model_id != configuration.model_id
                    || chosen.execution_profile != configuration.execution_profile
                    || chosen
                        .account_id
                        .as_ref()
                        .zip(configuration.account_id.as_ref())
                        .is_some_and(|(a, b)| a != b)
                    || chosen
                        .effort
                        .as_ref()
                        .zip(configuration.effort.as_ref())
                        .is_some_and(|(a, b)| a != b)
                    || chosen
                        .fast_mode
                        .zip(configuration.fast_mode)
                        .is_some_and(|(a, b)| a != b)
                    || chosen
                        .inventory_revision
                        .as_ref()
                        .zip(configuration.inventory_revision.as_ref())
                        .is_some_and(|(a, b)| a != b)
                {
                    return Some(false);
                }
                // Missing reports are not confirmation of default effort, normal
                // speed or a matching runtime. Known mismatches still remain false.
                if configuration.effort.is_none()
                    || chosen.effort.is_none()
                    || configuration.fast_mode.is_none()
                    || chosen.fast_mode.is_none()
                    || configuration.inventory_revision.is_none()
                    || chosen.inventory_revision.is_none()
                {
                    return None;
                }
                Some(routing::candidate_key(chosen) == routing::candidate_key(configuration))
            });
        let saved = RecordedObservation {
            created_at: now(),
            observation,
            matches_selected,
        };
        // Serialize competing start/terminal writes; a terminal observation must
        // never be followed by a late successful start after cancellation.
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT observation_json FROM executor_observations WHERE request_key=?",
        )
        .bind(request_key)
        .fetch_all(&mut *transaction)
        .await?;
        let current = Record {
            decision: record.decision,
            host_execution: None,
            observations: rows
                .iter()
                .map(|row| serde_json::from_str(row))
                .collect::<std::result::Result<_, _>>()?,
        };
        validate_observation(&current, &saved.observation)?;
        let phases: Vec<_> = current
            .observations
            .iter()
            .map(|row| row.observation.phase.as_str())
            .collect();
        if saved.observation.phase == "started"
            && phases.contains(&"terminal")
            && !phases.contains(&"started")
        {
            return Err(error(
                "decision_terminal",
                "Execution was already closed before start",
            ));
        }
        sqlx::query("INSERT OR IGNORE INTO executor_observations(request_key,phase,created_at,observation_json,artifact_hash) VALUES(?,?,?,?,?)")
            .bind(request_key).bind(&saved.observation.phase).bind(saved.created_at)
            .bind(serde_json::to_string(&saved)?).bind(hash(&(request_key, &saved))?)
            .execute(&mut *transaction).await?;
        transaction.commit().await?;
        let result = self
            .executor_decision(request_key)
            .await?
            .ok_or_else(|| error("storage_unavailable", "Executor decision disappeared"))?;
        if result.observations.iter().any(|row| {
            row.observation.phase == saved.observation.phase && row.observation != saved.observation
        }) {
            return Err(error(
                "observation_conflict",
                "An immutable executor observation already exists",
            ));
        }
        Ok(result)
    }
}

impl Record {
    pub fn with_host_execution(mut self, receipt: Option<ExecutorReceipt>) -> Result<Self> {
        if let Some(receipt) = &receipt {
            if receipt.start.link.decision_key != self.decision.request.request_key
                || self.observations.iter().any(|row| {
                    row.observation
                        .session_id
                        .as_ref()
                        .is_some_and(|id| id != &receipt.start.session_id)
                        || row
                            .observation
                            .run_id
                            .as_ref()
                            .is_some_and(|id| id != &receipt.start.link.logical_run_id)
                })
            {
                return Err(error(
                    "observation_conflict",
                    "Host dispatch does not match the recorded execution",
                ));
            }
        }
        self.host_execution = receipt;
        Ok(self)
    }
}

impl Store {
    /// The renderer reports the graph outcome; only the host may supply actual
    /// executor fields. The native and logical run IDs remain separately visible.
    pub async fn observe_host_outcome(
        &self,
        request_key: &str,
        session_id: String,
        run_id: String,
        outcome: String,
        receipt: Option<ExecutorReceipt>,
    ) -> Result<Record> {
        if let Some(receipt) = &receipt {
            if receipt.start.link.decision_key != request_key
                || receipt.start.session_id != session_id
                || receipt.start.link.logical_run_id != run_id
            {
                return Err(error(
                    "observation_conflict",
                    "Host dispatch identity does not match this wave step",
                ));
            }
        }
        let configuration = receipt.as_ref().and_then(|receipt| {
            receipt.finish.as_ref().and_then(|finish| {
                finish
                    .selection
                    .model_id
                    .as_ref()
                    .map(|model_id| Configuration {
                        id: format!("host:{}", receipt.start.host_run_id),
                        provider_id: receipt.start.provider_id.clone(),
                        account_id: receipt.start.account_id.clone(),
                        model_id: model_id.clone(),
                        model_name: finish.selection.model_name.clone(),
                        effort: finish.selection.effort.clone(),
                        fast_mode: finish.selection.fast,
                        billing_mode: "unknown".into(),
                        execution_profile: "interactive_acp".into(),
                        inventory_revision: None,
                    })
            })
        });
        let reason = match &receipt {
            Some(receipt) if receipt.finish.is_some() => "Provider-reported terminal configuration; full transition history is in the host receipt. Run completion is not a quality verdict.",
            Some(_) => "Provider dispatch was claimed but terminal acknowledgement is missing; do not retry automatically.",
            None => "No provider dispatch receipt was found; executor configuration remains unknown.",
        };
        let record = self
            .observe_executor(
                request_key,
                Observation {
                    phase: "terminal".into(),
                    session_id: Some(session_id),
                    run_id: Some(run_id),
                    configuration,
                    outcome: Some(outcome),
                    reason: Some(reason.into()),
                },
            )
            .await?;
        record.with_host_execution(receipt)
    }
}

fn same_request(decision: Decision, request: &Request) -> Result<Decision> {
    if decision.input_hash != hash(request)? {
        return Err(error(
            "decision_conflict",
            "A decision key cannot be reused with changed inputs",
        ));
    }
    Ok(decision)
}

fn validate_observation(record: &Record, value: &Observation) -> Result<()> {
    let started = value.phase == "started";
    let terminal = value.phase == "terminal";
    let ids = [&value.session_id, &value.run_id];
    let valid_ids = ids.iter().all(|id| {
        id.as_ref()
            .is_some_and(|id| !id.trim().is_empty() && id.len() <= 256)
    });
    let observed = value.configuration.is_some();
    let any_id = ids.iter().any(|id| id.is_some());
    if (!started && !terminal)
        || (started
            && (value.outcome.is_some()
                || !valid_ids
                || (!observed
                    && value
                        .reason
                        .as_deref()
                        .is_none_or(|reason| reason.trim().is_empty()))))
        || (terminal
            && !matches!(
                value.outcome.as_deref(),
                Some("completed" | "failed" | "cancelled" | "blocked")
            ))
        || (observed && !valid_ids)
        || (any_id && !valid_ids)
        || (terminal && value.outcome.as_deref() == Some("completed") && !valid_ids)
        || (terminal
            && valid_ids
            && !observed
            && value
                .reason
                .as_deref()
                .is_none_or(|reason| reason.trim().is_empty()))
        || value.configuration.as_ref().is_some_and(|configuration| {
            configuration.provider_id.trim().is_empty() || configuration.model_id.trim().is_empty()
        })
        || serde_json::to_vec(value)?.len() > 65_536
        || value
            .reason
            .as_ref()
            .is_some_and(|reason| reason.len() > 4096)
    {
        return Err(error("validation", "Invalid executor observation"));
    }
    if let Some(start) = record
        .observations
        .iter()
        .find(|row| row.observation.phase == "started")
    {
        if value.session_id != start.observation.session_id
            || value.run_id != start.observation.run_id
        {
            return Err(error(
                "observation_conflict",
                "Execution identity changed after start",
            ));
        }
    }
    Ok(())
}
