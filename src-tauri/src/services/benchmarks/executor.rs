//! One recorded selection boundary for interactive suggestions and wave dispatch.
//! Research predictions are inspectable, but cannot authorize a worker change.

use super::{learned, routing, store::now, store::Store, types::*};
use crate::services::agent_host::executor_receipts::{ExecutorReceipt, ReceiptStart};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::BTreeSet;

#[cfg(test)]
mod tests;

const POLICY_VERSION: &str = "executor-selection-v1";
/// Learned status of a chat or wave decision made without the class policy:
/// its unrestricted session context is outside every qualified contract.
pub const ORDINARY_CONTEXT_UNCOVERED: &str = "ordinary_context_uncovered";
/// Learned statuses of an ordinary chat or wave decision under the class policy.
pub const CERTIFIED_CLASS_POLICY: &str = "certified_class_policy";
pub const NO_CLASS_CERTIFICATE: &str = "no_class_certificate";
pub const CLASS_POLICY_ABSTAINED: &str = "class_policy_abstained";
pub const EXPLICIT_PIN: &str = "explicit_pin";

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
                    application_candidate_key(&row.configuration),
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

pub(super) fn artifact_hash(decision: &Decision) -> Result<String> {
    let mut body = decision.clone();
    body.artifact_hash.clear();
    hash(&body)
}

/// Application intent distinguishes an unspecified speed from explicit normal
/// mode. Benchmark evidence keys and all noninteractive identities stay intact.
fn application_candidate_key(configuration: &Configuration) -> String {
    let key = routing::candidate_key(configuration);
    if configuration.execution_profile == "interactive_acp" && configuration.fast_mode.is_none() {
        format!(
            "{:x}",
            Sha256::digest(format!("interactive-unspecified-fast-v1:{key}").as_bytes())
        )
    } else {
        key
    }
}

fn validate(request: &Request) -> Result<()> {
    let prediction = &request.prediction;
    let candidates = &prediction.candidates;
    // Ordinary requests carry the full live inventory. The class policy maps
    // it to the bounded trained pool; a renderer ranking must not cut that
    // evidence off before selection. The serialized request bound still applies.
    let ordinary =
        matches!(request.surface.as_str(), "chat" | "wave") && request.model_id.is_none();
    let keys: BTreeSet<_> = candidates
        .iter()
        .map(|candidate| application_candidate_key(&candidate.configuration))
        .collect();
    if request.request_key.trim().is_empty()
        || request.request_key.len() > 256
        || request.context_id.trim().is_empty()
        || request.context_id.len() > 256
        || !matches!(request.surface.as_str(), "chat" | "wave" | "benchmark")
        || (!ordinary && candidates.len() > 32)
        || candidates.iter().any(|candidate| {
            candidate.configuration.provider_id.trim().is_empty()
                || candidate.configuration.model_id.trim().is_empty()
        })
        || keys.len() != candidates.len()
        || (!ordinary && request.prior_keys.len() > 32)
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
    // Application intent uniqueness was checked above; the benchmark validator
    // deliberately shares a key for omitted speed and explicit normal mode.
    // Reuse its feature/floor bounds without asserting those intents are equal.
    if ordinary {
        let mut public_features = prediction.clone();
        public_features.candidates.clear();
        learned::validate_public_request(&public_features)?;
    } else {
        learned::validate_public_request(prediction)?;
    }
    Ok(())
}

/// A class recommendation transfers a runnable choice, not its benchmark runtime.
/// Unknown interactive provenance stays unknown in the decision and its receipts.
fn class_evidence_matches(runnable: &Configuration, trained: &Configuration) -> bool {
    if runnable.provider_id != trained.provider_id
        || runnable.model_id != trained.model_id
        || runnable.effort != trained.effort
        || runnable.fast_mode != trained.fast_mode
        || trained
            .inventory_revision
            .as_deref()
            .is_none_or(str::is_empty)
        || runnable
            .inventory_revision
            .as_ref()
            .is_some_and(|revision| Some(revision) != trained.inventory_revision.as_ref())
    {
        return false;
    }
    let moving_alias =
        crate::services::agent_host::execution::NativeProvider::for_harness(&runnable.provider_id)
            .is_some_and(|provider| {
                provider
                    .moving_aliases()
                    .contains(&runnable.model_id.as_str())
            });
    if moving_alias
        && (runnable.model_name.as_deref().is_none_or(str::is_empty)
            || runnable.model_name != trained.model_name)
    {
        return false;
    }
    if runnable.execution_profile == "interactive_acp" {
        runnable.billing_mode == "unknown" || runnable.billing_mode == trained.billing_mode
    } else {
        routing::candidate_key(runnable) == routing::candidate_key(trained)
            && runnable.inventory_revision == trained.inventory_revision
    }
}

/// Called only after verifying the class certificate. The research prediction
/// retains the exact evidence keys/configurations; `chosen` is an unchanged
/// application row, so no native profile, billing or revision is fabricated.
fn apply_class_model(
    decision: &mut Decision,
    model: &learned::LearnedModel,
    certificate_id: &str,
    min_quality: f64,
    pool: Option<&[String]>,
) -> Result<()> {
    if decision.request.prediction.hard_candidate_key.is_some() {
        decision.learned_status = EXPLICIT_PIN.into();
        return Ok(());
    }
    let mut prediction = decision.request.prediction.clone();
    prediction.min_quality = prediction.min_quality.max(min_quality);
    let mut runnable_by_evidence = std::collections::BTreeMap::new();
    let matches: Vec<_> = prediction
        .candidates
        .iter()
        .filter(|candidate| candidate.available)
        .filter_map(|candidate| {
            let mut matches = model.candidates.iter().filter(|trained| {
                class_evidence_matches(&candidate.configuration, &trained.configuration)
            });
            let trained = matches.next()?;
            // Different certified billing/profile contexts are not interchangeable.
            if matches.next().is_some() {
                return None;
            }
            // A held-out certificate speaks only for its certified pool.
            if pool.is_some_and(|pool| !pool.contains(&trained.candidate_key)) {
                return None;
            }
            Some((
                trained.candidate_key.clone(),
                trained.configuration.clone(),
                candidate.configuration.clone(),
            ))
        })
        .collect();
    let mut evidence_counts = std::collections::BTreeMap::new();
    for (key, _, _) in &matches {
        *evidence_counts.entry(key.clone()).or_insert(0usize) += 1;
    }
    prediction.candidates = matches
        .into_iter()
        .filter_map(|(key, trained, runnable)| {
            // Two runnable contexts claiming one evidence row are also ambiguous;
            // exclude both instead of failing the whole decision on duplicate keys.
            if evidence_counts[&key] != 1 {
                return None;
            }
            runnable_by_evidence.insert(key, runnable);
            Some(RoutingCandidate {
                configuration: trained,
                available: true,
                reason: Some("certified_evidence_for_ordinary_executor_choice".into()),
            })
        })
        .collect();
    let result = learned::predict_for_class(model, &prediction)?;
    if let Some(chosen) = result
        .chosen_key
        .as_ref()
        .and_then(|key| runnable_by_evidence.get(key))
    {
        decision.chosen_key = Some(application_candidate_key(chosen));
        decision.chosen = Some(chosen.clone());
        decision.source = "learned".into();
        decision.reason =
            format!("certificate:{certificate_id};class_recommendation_not_runtime_attestation");
        decision.learned_dispatch_allowed = true;
        decision.learned_status = CERTIFIED_CLASS_POLICY.into();
    } else {
        decision.learned_status = format!("{CLASS_POLICY_ABSTAINED}:{}", result.reason);
    }
    decision.research_prediction = Some(result);
    Ok(())
}

impl Store {
    /// Owned task attribution uses the verified native session and policy proof.
    /// Ordinary ACP attribution keeps its existing unknown-runtime semantics.
    pub async fn observe_native_host_outcome(
        &self,
        host: &crate::services::agent_host::store::SessionStore,
        request_key: &str,
        session_id: String,
        run_id: String,
        outcome: String,
        receipt: Option<ExecutorReceipt>,
    ) -> Result<Record> {
        let task_owner = host
            .owned_session_purpose(&session_id)
            .await
            .map_err(|message| error("host_evidence", &message))?
            .as_deref()
            == Some("task");
        if !task_owner && !request_key.starts_with("owned-task:") {
            return self
                .observe_host_outcome(request_key, session_id, run_id, outcome, receipt)
                .await;
        }
        let configuration = self
            .native_task_outcome_configuration(
                host,
                request_key,
                &session_id,
                &run_id,
                &outcome,
                receipt.as_ref(),
            )
            .await?;
        self.record_host_outcome(
            request_key,
            session_id,
            run_id,
            outcome,
            receipt,
            Some(configuration),
        )
        .await
    }

    async fn native_task_outcome_configuration(
        &self,
        host: &crate::services::agent_host::store::SessionStore,
        key: &str,
        session_id: &str,
        run_id: &str,
        outcome: &str,
        receipt: Option<&ExecutorReceipt>,
    ) -> Result<Option<Configuration>> {
        use crate::services::agent_host::execution::ExecutionProfile;
        if host
            .owned_session_purpose(session_id)
            .await
            .map_err(|message| error("host_evidence", &message))?
            .as_deref()
            != Some("task")
        {
            return Err(error(
                "observation_conflict",
                "The owned task key has no matching native owner",
            ));
        }
        let (owner, policy_hash) = host
            .execution_owner(session_id)
            .await
            .map_err(|message| error("host_evidence", &message))?
            .ok_or_else(|| error("host_evidence", "Native task owner is missing"))?;
        let id = owner
            .owner_id
            .strip_prefix("task:")
            .ok_or_else(|| error("host_evidence", "Native task owner identity is invalid"))?;
        let binding = self.task_binding(id).await?;
        let session = self
            .task_session(&binding)
            .await?
            .ok_or_else(|| error("host_evidence", "Verified native task session is missing"))?;
        let profile = match owner.profile {
            ExecutionProfile::NativeTextV1 => "native_text",
            ExecutionProfile::ProtectedRepositoryV1 => "protected_repository",
        };
        let observed = &session.observed;
        let current = host
            .get_session(session_id)
            .await
            .map_err(|message| error("host_evidence", &message))?
            .ok_or_else(|| error("host_evidence", "Native task session disappeared"))?;
        if key != binding.request.request_key
            || run_id != key
            || session.owned.session_id != session_id
            || session.owned.policy_hash != policy_hash
            || policy_hash.is_empty()
            || profile != binding.task.execution_profile
            || profile != observed.execution_profile
            || owner.provider_id != observed.provider_id
            || Some(&owner.account_id) != observed.account_id.as_ref()
            || owner.model_id != observed.model_id
            || owner.reasoning_effort != observed.effort
            || owner.fast_mode != observed.fast_mode
            || current.harness != observed.provider_id
            || current.account_id != observed.account_id
            || current.cwd != owner.cwd
            || current.model_id.as_ref() != Some(&observed.model_id)
            || current.reasoning_effort != observed.effort
            || current.fast_mode != observed.fast_mode
            || session.owned.selection.model_id.as_ref() != Some(&observed.model_id)
            || session.owned.selection.reasoning_effort != observed.effort
            || session.owned.selection.fast_mode != observed.fast_mode
            || observed
                .inventory_revision
                .as_ref()
                .is_none_or(|revision| revision.is_empty())
        {
            return Err(error(
                "observation_conflict",
                "Native task binding, session, policy or acknowledgement differs",
            ));
        }
        let dispatch = host
            .execution_dispatch(key)
            .await
            .map_err(|message| error("host_evidence", &message))?
            .ok_or_else(|| error("host_evidence", "Native task dispatch is missing"))?;
        let native_outcome = if dispatch.phase == "uncertain" {
            "failed"
        } else if dispatch.phase != "terminal" {
            return Err(error(
                "host_evidence",
                "Native task outcome is not committed",
            ));
        } else if let Some(failure) = &dispatch.error {
            if failure["kind"] == "cancelled" {
                "cancelled"
            } else {
                "failed"
            }
        } else {
            "completed"
        };
        if dispatch.session_id != session_id || outcome != native_outcome {
            return Err(error(
                "observation_conflict",
                "Reported task outcome differs from the native dispatch",
            ));
        }
        let Some(receipt) = receipt else {
            return Ok(None);
        };
        if receipt.start.link.decision_key != key
            || receipt.start.link.logical_run_id != key
            || receipt.start.session_id != session_id
            || receipt.start.host_run_id != dispatch.run_id
            || receipt.start.message_id != dispatch.user_message_id
            || receipt.start.provider_id != observed.provider_id
            || receipt.start.account_id != observed.account_id
        {
            return Err(error(
                "observation_conflict",
                "Native task provider receipt belongs to another execution",
            ));
        }
        let Some(finish) = &receipt.finish else {
            return Ok(None);
        };
        if dispatch.phase == "uncertain" {
            return Ok(None);
        }
        if finish.selection.model_id.as_ref() != Some(&observed.model_id)
            || finish.selection.effort != observed.effort
            || finish.selection.fast != observed.fast_mode
        {
            return Err(error(
                "observation_conflict",
                "Terminal provider acknowledgement differs from the verified native task",
            ));
        }
        Ok(Some(Configuration {
            id: format!("host:{}", receipt.start.host_run_id),
            provider_id: receipt.start.provider_id.clone(),
            account_id: receipt.start.account_id.clone(),
            model_id: finish.selection.model_id.clone().unwrap_or_default(),
            model_name: finish.selection.model_name.clone(),
            effort: finish.selection.effort.clone(),
            fast_mode: finish.selection.fast,
            billing_mode: observed.billing_mode.clone(),
            execution_profile: profile.into(),
            inventory_revision: observed.inventory_revision.clone(),
        }))
    }

    /// Only the bounded workflow runner uses predictions for research turns.
    /// The public chat/wave entry points still require production promotion.
    pub(super) async fn prepare_workflow_research_decision(
        &self,
        request: Request,
        mode: &str,
    ) -> Result<Decision> {
        if request.surface != "benchmark" {
            return Err(error(
                "validation",
                "Research decisions require a benchmark workflow",
            ));
        }
        if let Some(record) = self.executor_decision(&request.request_key).await? {
            return same_request(record.decision, &request);
        }
        let mut decision = self.preview_executor_decision(request).await?;
        if mode == "aggregate" {
            decision.source = "research_aggregate".into();
            decision.reason = "workflow_frozen_aggregate_order".into();
        }
        if decision.request.prediction.hard_candidate_key.is_none() {
            if let Some(prediction) = &decision.research_prediction {
                if let Some(chosen) = &prediction.chosen {
                    decision.chosen = Some(chosen.clone());
                    decision.chosen_key = prediction.chosen_key.clone();
                    decision.source = "research_learned".into();
                    decision.reason = "workflow_research_prediction".into();
                } else {
                    decision.reason = format!("workflow_research_abstained:{}", prediction.reason);
                }
            }
        }
        decision.policy_version = "executor-selection-v1/workflow-research-v1".into();
        decision.artifact_hash = artifact_hash(&decision)?;
        self.persist_executor_decision(decision).await
    }

    /// Reads model coefficients only. This path never loads training labels or runs.
    pub async fn preview_executor_decision(&self, request: Request) -> Result<Decision> {
        validate(&request)?;
        let prediction = &request.prediction;
        let available = |key: &str| {
            prediction.candidates.iter().find(|candidate| {
                candidate.available && application_candidate_key(&candidate.configuration) == key
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
            // Ordinary chat and wave sends run with the session's own
            // unrestricted tools, history and environment. No qualified
            // contract covers that context, so the record says why learned
            // selection does not apply. Owned task bindings replace this
            // status with their native discovery outcome.
            None if matches!(request.surface.as_str(), "chat" | "wave") => {
                (None, ORDINARY_CONTEXT_UNCOVERED.to_owned())
            }
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
            chosen_key: chosen.as_ref().map(application_candidate_key),
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

    /// Ordinary chat and wave selection. Under an active certificate for the
    /// task's work class, the certified class model chooses among its trained,
    /// available candidates. An explicit pin, a class without a certificate or
    /// an abstention keeps the caller's own order.
    pub async fn preview_ordinary_executor_decision(&self, request: Request) -> Result<Decision> {
        let mut decision = self.preview_executor_decision(request).await?;
        if !matches!(decision.request.surface.as_str(), "chat" | "wave")
            || decision.request.model_id.is_some()
        {
            return Ok(decision);
        }
        if decision.request.prediction.hard_candidate_key.is_some() {
            decision.learned_status = EXPLICIT_PIN.into();
        } else {
            let class = decision.request.prediction.task.work_class_id.clone();
            match self.class_certificate(&class).await? {
                None => decision.learned_status = NO_CLASS_CERTIFICATE.into(),
                Some((certificate, model_id)) => {
                    let model = self.selector_model(&model_id).await?;
                    apply_class_model(
                        &mut decision,
                        &model,
                        &certificate.id,
                        certificate.min_prediction_quality,
                        certificate.pool_keys.as_deref(),
                    )?;
                }
            }
        }
        decision.artifact_hash = artifact_hash(&decision)?;
        Ok(decision)
    }

    /// [`Self::preview_ordinary_executor_decision`], committed once per key.
    pub async fn prepare_ordinary_executor_decision(&self, request: Request) -> Result<Decision> {
        if let Some(record) = self.executor_decision(&request.request_key).await? {
            // An unchanged persisted request keeps its original identity rules.
            // Verify its immutable body before applying today's rules to new work.
            return same_request(record.decision, &request);
        }
        validate(&request)?;
        let decision = self.preview_ordinary_executor_decision(request).await?;
        self.persist_executor_decision(decision).await
    }

    /// Revalidate a saved ordinary choice at the final native handoff. The
    /// caller holds the returned permit through receipt claim and synchronous
    /// bridge submission, then releases it without waiting for the model.
    /// Revocation uses the same gate; queued/restored choices never reselect.
    pub async fn admit_ordinary_executor(
        &self,
        start: &ReceiptStart,
    ) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>> {
        let record = self
            .executor_decision(&start.link.decision_key)
            .await?
            .ok_or_else(|| error("invalid_decision", "Executor decision was not prepared"))?;
        let decision = record.decision;
        if !decision.learned_dispatch_allowed && decision.source != "learned" {
            // Explicit pins and persona choices do not rely on a certificate.
            return Ok(None);
        }
        let refused = || {
            error(
                "invalid_decision",
                "Learned executor authority or selection changed before provider handoff",
            )
        };
        if !decision.learned_dispatch_allowed
            || decision.source != "learned"
            || decision.learned_status != CERTIFIED_CLASS_POLICY
            || !matches!(decision.request.surface.as_str(), "chat" | "wave")
            || decision.request.prediction.hard_candidate_key.is_some()
        {
            return Err(refused());
        }
        // This identity is part of the immutable decision, including older
        // saved choices. Never substitute today's newest class certificate.
        let certificate_id = decision
            .reason
            .strip_prefix("certificate:")
            .and_then(|reason| reason.strip_suffix(";class_recommendation_not_runtime_attestation"))
            .filter(|id| !id.is_empty())
            .ok_or_else(refused)?;
        let admission = super::promotion::admission_gate().lock_owned().await;
        let certificate = self.require_active_promotion(certificate_id).await?;
        let model_id = certificate
            .model_for_class(&decision.request.prediction.task.work_class_id)
            .ok_or_else(refused)?;
        let model = self.selector_model(model_id).await?;
        let chosen = decision.chosen.as_ref().ok_or_else(refused)?;
        if decision
            .research_prediction
            .as_ref()
            .is_none_or(|prediction| prediction.model_id != model_id)
            || decision.chosen_key.as_deref() != Some(application_candidate_key(chosen).as_str())
            || !decision
                .request
                .prediction
                .candidates
                .iter()
                .any(|candidate| candidate.available && candidate.configuration == *chosen)
            || !model
                .candidates
                .iter()
                .any(|trained| class_evidence_matches(chosen, &trained.configuration))
            || chosen.provider_id != start.provider_id
            || start.selection.model_id.as_deref() != Some(chosen.model_id.as_str())
            || chosen
                .effort
                .as_ref()
                .is_some_and(|effort| start.selection.effort.as_ref() != Some(effort))
            || chosen
                .fast_mode
                .is_some_and(|fast| start.selection.fast != Some(fast))
            || chosen
                .account_id
                .as_ref()
                .is_some_and(|account| start.account_id.as_ref() != Some(account))
            || chosen
                .model_name
                .as_ref()
                .zip(start.selection.model_name.as_ref())
                .is_some_and(|(expected, reported)| expected != reported)
        {
            return Err(refused());
        }
        Ok(Some(admission))
    }

    /// Commit before any external session effect. Repeated keys never reselect.
    #[cfg(test)]
    pub async fn prepare_executor_decision(&self, request: Request) -> Result<Decision> {
        validate(&request)?;
        if let Some(record) = self.executor_decision(&request.request_key).await? {
            return same_request(record.decision, &request);
        }
        let decision = self.preview_executor_decision(request).await?;
        self.persist_executor_decision(decision).await
    }

    pub(super) async fn persist_executor_decision(&self, decision: Decision) -> Result<Decision> {
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
    pub async fn observe_application_executor(
        &self,
        request_key: &str,
        observation: Observation,
    ) -> Result<Record> {
        if request_key.starts_with("owned-task:") {
            return Err(error(
                "invalid_task_authority",
                "Owned task observations require verified native receipt and policy evidence",
            ));
        }
        self.observe_executor(request_key, observation).await
    }

    /// Internal native producers may append their verified observations.
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
        self.record_host_outcome(request_key, session_id, run_id, outcome, receipt, None)
            .await
    }

    async fn record_host_outcome(
        &self,
        request_key: &str,
        session_id: String,
        run_id: String,
        outcome: String,
        receipt: Option<ExecutorReceipt>,
        owned_configuration: Option<Option<Configuration>>,
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
        let owned_proof = owned_configuration.is_some();
        let configuration = if let Some(configuration) = owned_configuration {
            configuration
        } else {
            receipt.as_ref().and_then(|receipt| {
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
            })
        };
        let reason = match &receipt {
            _ if owned_proof && configuration.is_some() => "Provider terminal model/settings joined to the verified native task session, profile, runtime and billing proof. Completion is not a quality verdict.",
            _ if owned_proof => "Owned task terminal configuration is unconfirmed; inspect the native receipt and do not retry automatically.",
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
