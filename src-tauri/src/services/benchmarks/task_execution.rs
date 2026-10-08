//! Explicit application tasks using the same owned adapter as collection.
//! Ordinary workspace sessions never acquire authority from this API.
use super::{
    executor, fixtures, learned, promotion, repository, routing,
    store::{now, Store},
    types::*,
    BenchmarkService,
};
use crate::services::agent_host::execution::{ExecutionDispatch, OwnedSession};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::{BTreeMap, BTreeSet};

mod v2;
pub use v2::{Consent, ContextV2, ModeEnvelope, ModeIntent, ModeRequestV2, PrepareIntent};

fn invalid(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("invalid_task_authority", message)
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(fixtures::hash(&serde_json::to_vec(value)?))
}
pub(super) fn inventory_acknowledges(row: &InventoryModel, chosen: &Configuration) -> bool {
    row.available
        && row.configuration.provider_id == chosen.provider_id
        && row.configuration.account_id == chosen.account_id
        && row.configuration.model_id == chosen.model_id
        && row.configuration.execution_profile == chosen.execution_profile
        && row.configuration.inventory_revision == chosen.inventory_revision
        && row.configuration.billing_mode == chosen.billing_mode
        && chosen
            .effort
            .as_ref()
            .is_none_or(|effort| row.efforts.contains(effort))
        && (!chosen.fast_mode.unwrap_or(false) || row.supports_fast_mode)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub candidate_key: String,
    pub configuration: Configuration,
    pub available: bool,
    pub reason: Option<String>,
}

/// No renderer role, permission, runtime, account or candidate assertions are
/// accepted. The acknowledgement names the exact displayed native certificate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub request_key: String,
    pub surface: String,
    pub context_id: String,
    pub promotion_id: String,
    pub acknowledged_certificate_hash: String,
    pub prompt: String,
    pub hard_candidate_key: Option<String>,
    /// An explicit immutable copy, never an ordinary workspace send.
    pub repository: Option<repository::Snapshot>,
    #[serde(default)]
    pub entry: Option<WaveEntry>,
    #[serde(default)]
    pub wave_mode: Option<ModeReference>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModeReference {
    pub context_id: String,
    pub artifact_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModeRequest {
    pub context_id: String,
    pub promotion_id: Option<String>,
    pub acknowledged_certificate_hash: String,
    pub repository: Option<repository::Snapshot>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mode {
    pub request: ModeRequest,
    pub created_at: i64,
    pub artifact_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaveEntry {
    pub root_binding_id: String,
    pub previous_binding_ids: Vec<String>,
    pub include_previous_output: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOutput {
    pub text: String,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_result: Option<super::artifact_context::PublicResult>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    pub created_at: i64,
    pub request: Request,
    pub certificate_hash: String,
    pub task: learned::PublicTask,
    pub context_hash: String,
    pub decision: executor::Decision,
    pub artifact_hash: String,
    /// Omitted for legacy records: their original serialized bytes remain stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_v2: Option<ContextV2>,
}
impl Binding {
    /// This step's position in its native lineage; a root is step zero.
    pub(super) fn step_index(&self) -> usize {
        self.context_v2
            .as_ref()
            .and_then(|context| context.intent.entry.as_ref())
            .map_or(0, |entry| entry.previous_binding_ids.len())
    }
    pub(super) fn remaining_ms(&self) -> Result<u64> {
        if let Some(budget) = self
            .context_v2
            .as_ref()
            .and_then(|context| context.root_budget.as_ref())
        {
            budget.remaining_ms(now())
        } else {
            Ok(u64::from(
                self.task
                    .entry
                    .as_ref()
                    .map_or(self.task.limits.timeout_seconds, |entry| {
                        entry.remaining_budget_seconds
                    }),
            ) * 1000)
        }
    }
    pub(super) fn deadline_at_ms(&self) -> Result<Option<i64>> {
        self.context_v2
            .as_ref()
            .and_then(|context| context.root_budget.as_ref())
            .map(|budget| budget.deadline_at_ms())
            .transpose()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub owned: OwnedSession,
    /// Actual provider acknowledgement and current native runtime, not intent.
    pub observed: Configuration,
    pub context_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub binding: Binding,
    pub session: Session,
}

/// Rust-only proof from the existing host owner/dispatch locks. A session ID
/// here is an inspection target, never a substitute configuration receipt.
#[derive(Debug, Clone)]
pub struct NativePreparationLookup {
    pub session_id: Option<String>,
    pub no_provider_start: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparationRefusal {
    pub schema_version: u32,
    pub binding_id: String,
    pub binding_hash: String,
    pub request_key: String,
    pub session_id: Option<String>,
    pub outcome: String,
    pub proof: String,
}
fn preparation_refusal_error(refusal: PreparationRefusal) -> BenchmarkError {
    BenchmarkError::new("owned_task_preparation_refused","Native setup exhausted its root budget before any provider prompt; inspect or explicitly start a new task")
        .with_details(serde_json::to_value(refusal).expect("native preparation refusal"))
}

impl Store {
    async fn task_preparation_refusal(
        &self,
        binding: &Binding,
    ) -> Result<Option<PreparationRefusal>> {
        let row = sqlx::query(
            "SELECT refusal_json,refusal_hash FROM task_budget_bindings WHERE request_key=?",
        )
        .bind(&binding.request.request_key)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let Some(body) = row.try_get::<Option<String>, _>("refusal_json")? else {
            return Ok(None);
        };
        let refusal: PreparationRefusal = serde_json::from_str(&body)?;
        if row.try_get::<Option<String>, _>("refusal_hash")?.as_deref()
            != Some(fixtures::hash(body.as_bytes()).as_str())
            || refusal.schema_version != 1
            || refusal.binding_id != binding.id
            || refusal.binding_hash != binding.artifact_hash
            || refusal.request_key != binding.request.request_key
            || refusal.outcome != "budget_timeout"
            || refusal.proof != "native-owned-no-provider-start-v1"
        {
            return Err(invalid(
                "Native terminal preparation refusal integrity changed",
            ));
        }
        Ok(Some(refusal))
    }
    async fn save_task_preparation_refusal(
        &self,
        binding: &Binding,
        lookup: NativePreparationLookup,
    ) -> Result<PreparationRefusal> {
        if !lookup.no_provider_start {
            return Err(BenchmarkError::new(
                "dispatch_uncertain",
                "Native setup expired but provider-start absence is unconfirmed",
            ));
        }
        let refusal = PreparationRefusal {
            schema_version: 1,
            binding_id: binding.id.clone(),
            binding_hash: binding.artifact_hash.clone(),
            request_key: binding.request.request_key.clone(),
            session_id: lookup.session_id,
            outcome: "budget_timeout".into(),
            proof: "native-owned-no-provider-start-v1".into(),
        };
        let body = serde_json::to_string(&refusal)?;
        sqlx::query("UPDATE task_budget_bindings SET refusal_json=?,refusal_hash=? WHERE request_key=? AND refusal_json IS NULL")
            .bind(&body).bind(fixtures::hash(body.as_bytes())).bind(&binding.request.request_key).execute(&self.pool).await?;
        self.task_preparation_refusal(binding)
            .await?
            .ok_or_else(|| invalid("Native preparation refusal was not durably recorded"))
    }
    pub async fn owned_task_mode(&self, context_id: &str) -> Result<Option<Mode>> {
        if let Some(ModeEnvelope::V2(_)) = self.owned_task_mode_envelope(context_id).await? {
            return Ok(None);
        }
        let row = sqlx::query(
            "SELECT mode_json,artifact_hash FROM task_mode_consents WHERE context_id=?",
        )
        .bind(context_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let value: Mode = serde_json::from_str(row.try_get("mode_json")?)?;
        let mut body = value.clone();
        body.artifact_hash.clear();
        if value.request.context_id != context_id
            || hash(&body)? != value.artifact_hash
            || value.artifact_hash != row.try_get::<String, _>("artifact_hash")?
        {
            return Err(invalid("Native task mode consent integrity failed"));
        }
        Ok(Some(value))
    }
    pub async fn set_owned_task_mode(&self, request: ModeRequest) -> Result<Option<Mode>> {
        let gate = promotion::admission_gate();
        let _guard = gate.lock().await;
        if request.context_id.trim().is_empty() || request.context_id.len() > 256 {
            return Err(invalid("A task mode needs a native context ID"));
        }
        let Some(id) = &request.promotion_id else {
            sqlx::query("DELETE FROM task_mode_consents WHERE context_id=?")
                .bind(&request.context_id)
                .execute(&self.pool)
                .await?;
            return Ok(None);
        };
        let certificate = self.require_active_promotion(id).await?;
        if certificate.trajectory.is_some() {
            return Err(invalid(
                "A trajectory certificate authorizes only its exact step sequence, not a single task",
            ));
        }
        if certificate.artifact_hash != request.acknowledged_certificate_hash
            || (certificate.contract.execution_profile == "protected_repository")
                != request.repository.is_some()
        {
            return Err(invalid(
                "Task mode must acknowledge the exact active contract and explicit repository copy",
            ));
        }
        if let Some(existing) = self.owned_task_mode(&request.context_id).await? {
            if serde_json::to_value(&existing.request)? == serde_json::to_value(&request)? {
                return Ok(Some(existing));
            }
        }
        let mut value = Mode {
            request,
            created_at: now(),
            artifact_hash: String::new(),
        };
        value.artifact_hash = hash(&value)?;
        sqlx::query("INSERT INTO task_mode_consents(context_id,mode_json,artifact_hash) VALUES(?,?,?) ON CONFLICT(context_id) DO UPDATE SET mode_json=excluded.mode_json,artifact_hash=excluded.artifact_hash")
            .bind(&value.request.context_id).bind(serde_json::to_string(&value)?).bind(&value.artifact_hash).execute(&self.pool).await?;
        Ok(Some(value))
    }
    pub async fn task_binding(&self, id: &str) -> Result<Binding> {
        let row=sqlx::query("SELECT binding_json,binding_hash,request_key,request_hash FROM task_context_bindings WHERE id=?")
            .bind(id).fetch_optional(&self.pool).await?.ok_or_else(||invalid("Task binding not found"))?;
        let value: Binding = serde_json::from_str(row.try_get("binding_json")?)?;
        let mut body = value.clone();
        body.artifact_hash.clear();
        if value.id != id
            || hash(&body)? != value.artifact_hash
            || value.artifact_hash != row.try_get::<String, _>("binding_hash")?
            || value.request.request_key != row.try_get::<String, _>("request_key")?
            || hash(&value.request)? != row.try_get::<String, _>("request_hash")?
            || value.effective_context_hash()? != value.context_hash
        {
            return Err(invalid("Task binding integrity check failed"));
        }
        Ok(value)
    }
    async fn task_binding_retry(&self, request: &Request) -> Result<Option<Binding>> {
        let id: Option<String> =
            sqlx::query_scalar("SELECT id FROM task_context_bindings WHERE request_key=?")
                .bind(&request.request_key)
                .fetch_optional(&self.pool)
                .await?;
        match id {
            None => Ok(None),
            Some(id) => {
                let saved = self.task_binding(&id).await?;
                if hash(&saved.request)? != hash(request)? {
                    return Err(invalid(
                        "Task key is already bound to different inputs; explicitly edit and save a new task",
                    ));
                }
                Ok(Some(saved))
            }
        }
    }
    pub async fn task_session(&self, binding: &Binding) -> Result<Option<Session>> {
        let row = sqlx::query(
            "SELECT session_json,session_hash FROM task_owned_sessions WHERE binding_id=?",
        )
        .bind(&binding.id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let session: Session = serde_json::from_str(row.try_get("session_json")?)?;
        if hash(&session)? != row.try_get::<String, _>("session_hash")?
            || session.context_hash != binding.context_hash
            || session.owned.owner_id != format!("task:{}", binding.id)
            || binding.decision.chosen.as_ref() != Some(&session.observed)
        {
            return Err(invalid("Task session authority changed"));
        }
        Ok(Some(session))
    }
}

impl Binding {
    fn effective_context_hash(&self) -> Result<String> {
        match &self.context_v2 {
            Some(context) => hash(&(&self.task, &self.request.repository, context)),
            None => hash(&(&self.task, &self.request.repository)),
        }
    }
}
/// What the app itself found about the files a wave's reports named, read from
/// the sealed native repository artifact rather than any working folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFacts {
    /// Reported paths that name a file inside the task copy and were looked up.
    pub checked: usize,
    /// Those of the checked paths absent from the final sealed tree.
    pub missing: Vec<String>,
    /// Reported paths that cannot name a file in the copy (URIs, outside paths).
    pub unchecked: usize,
    /// Files the cumulative patch changes relative to the published snapshot.
    pub changed_files: usize,
    pub after_tree: String,
}

const MAX_ARTIFACT_FACT_PATHS: usize = 40;
const ARTIFACT_FACTS_DEADLINE_MS: u64 = 60_000;

impl BenchmarkService {
    /// Checks reported paths against the final tree of this task's sealed
    /// cumulative artifact. The tree is regenerated from the published root and
    /// the committed lineage; a missing path is a fact, a failure is not.
    pub async fn owned_task_artifact_facts(
        &self,
        id: &str,
        paths: Vec<String>,
    ) -> Result<ArtifactFacts> {
        if paths.len() > MAX_ARTIFACT_FACT_PATHS || paths.iter().any(|path| path.len() > 4096) {
            return Err(invalid("Too many or too long artifact paths"));
        }
        let binding = self.store.task_binding(id).await?;
        let unsupported = || {
            BenchmarkError::new(
                "capability_missing",
                "Only a native v2 repository task has a sealed cumulative artifact",
            )
        };
        let context = binding.context_v2.as_ref().ok_or_else(unsupported)?;
        let snapshot = binding
            .request
            .repository
            .as_ref()
            .ok_or_else(unsupported)?;
        let session = self
            .store
            .task_session(&binding)
            .await?
            .ok_or_else(|| invalid("Native task proof is missing"))?;
        let result = self
            .backend
            .owned_task_output(&binding, &session)
            .await?
            .repository_result
            .ok_or_else(unsupported)?;
        let max_bytes = binding.task.limits.max_artifact_bytes as usize;
        result.validate(max_bytes)?;
        let mut chain = if context.artifact_access_all == Some(true) {
            context.artifact_lineage.clone()
        } else {
            vec![]
        };
        chain.push(result.artifact.clone());
        let files = repository::final_tree_files(
            snapshot,
            &chain,
            max_bytes,
            (now() as u64).saturating_add(ARTIFACT_FACTS_DEADLINE_MS),
        )
        .await?;
        let mut checked = 0;
        let mut unchecked = 0;
        let mut missing = vec![];
        for reported in paths {
            match repository::workspace_relative(&reported) {
                Some(path) => {
                    checked += 1;
                    if !files.contains(&path) {
                        missing.push(reported);
                    }
                }
                None => unchecked += 1,
            }
        }
        Ok(ArtifactFacts {
            checked,
            missing,
            unchecked,
            changed_files: result
                .artifact
                .patch
                .lines()
                .filter(|line| line.starts_with("diff --git "))
                .count(),
            after_tree: result.artifact.after_tree,
        })
    }
    pub async fn owned_task_public_result(&self, id: &str) -> Result<NativeOutput> {
        let binding = self.store.task_binding(id).await?;
        let session = self
            .store
            .task_session(&binding)
            .await?
            .ok_or_else(|| invalid("Native task proof is missing"))?;
        self.backend.owned_task_output(&binding, &session).await
    }
    pub async fn owned_task_choices(&self, promotion_id: &str) -> Result<Vec<Choice>> {
        let certificate = self.store.promotion(promotion_id).await?.certificate;
        let model = self.store.selector_model(&certificate.model_id).await?;
        Ok(self
            .task_candidates(&model, &certificate.contract.execution_profile)
            .await?
            .into_iter()
            .map(|candidate| Choice {
                candidate_key: routing::candidate_key(&candidate.configuration),
                configuration: candidate.configuration,
                available: candidate.available,
                reason: candidate.reason,
            })
            .collect())
    }
    pub async fn validate_final_owned_task(
        &self,
        id: &str,
        session_id: &str,
        key: &str,
    ) -> Result<()> {
        let binding = self.store.task_binding(id).await?;
        let session = self
            .store
            .task_session(&binding)
            .await?
            .ok_or_else(|| invalid("Native task proof is missing"))?;
        if session.owned.session_id != session_id || binding.request.request_key != key {
            return Err(invalid(
                "Native task key or session differs at provider handoff",
            ));
        }
        self.validate_context_v2(&binding).await?;
        if binding.decision.learned_dispatch_allowed {
            let active = self
                .store
                .require_active_promotion(&binding.request.promotion_id)
                .await?;
            if active.artifact_hash != binding.certificate_hash
                || !active.covers(
                    &promotion::Contract::from_task(&binding.task),
                    binding.step_index(),
                )
            {
                return Err(invalid(
                    "Learned task authority changed before provider handoff",
                ));
            }
        }
        let rows = self
            .backend
            .inventory(
                &session.observed.provider_id,
                session.observed.account_id.as_deref(),
                false,
            )
            .await?;
        if !rows
            .iter()
            .any(|row| inventory_acknowledges(row, &session.observed))
        {
            return Err(invalid(
                "Native runtime or account changed before provider handoff",
            ));
        }
        self.backend
            .validate_owned_task_context(&binding, &session)
            .await?;
        binding.remaining_ms()?;
        Ok(())
    }
    pub(crate) async fn owned_task_deadline_at_ms(&self, id: &str) -> Result<Option<i64>> {
        self.store.task_binding(id).await?.deadline_at_ms()
    }
    pub(crate) async fn expired_owned_task_identity(
        &self,
        id: &str,
        session_id: &str,
        key: &str,
    ) -> Result<()> {
        let binding = self.store.task_binding(id).await?;
        let session = self
            .store
            .task_session(&binding)
            .await?
            .ok_or_else(|| invalid("Native task session proof is absent"))?;
        if binding.request.request_key != key
            || session.owned.session_id != session_id
            || binding
                .deadline_at_ms()?
                .is_none_or(|deadline| deadline > now())
        {
            return Err(invalid(
                "Native task refusal identity or expired deadline differs",
            ));
        }
        Ok(())
    }
    pub async fn reopen_owned_task(&self, id: &str) -> Result<()> {
        let binding = self.store.task_binding(id).await?;
        let session = self
            .store
            .task_session(&binding)
            .await?
            .ok_or_else(|| invalid("Task session proof is missing"))?;
        self.backend.reopen_owned_task(&binding, &session).await
    }
    async fn require_task_mode(&self, request: &Request) -> Result<()> {
        if request.surface == "wave" {
            let reference = request.wave_mode.as_ref().ok_or_else(|| {
                invalid("Wave owned execution needs an explicit native operator consent")
            })?;
            let mode = self
                .store
                .owned_task_mode(&reference.context_id)
                .await?
                .ok_or_else(|| invalid("The operator disabled this wave task contract"))?;
            if mode.artifact_hash != reference.artifact_hash
                || !request
                    .context_id
                    .starts_with(&format!("{}:wave:", reference.context_id))
                || mode.request.promotion_id.as_deref() != Some(&request.promotion_id)
                || mode.request.acknowledged_certificate_hash
                    != request.acknowledged_certificate_hash
                || mode.request.repository != request.repository
            {
                return Err(invalid("The native wave task contract changed"));
            }
        } else if request.wave_mode.is_some() || request.entry.is_some() {
            return Err(invalid("Fresh initial chat cannot claim wave context"));
        }
        Ok(())
    }
    async fn committed_entry(&self, request: &Request, cap: u32) -> Result<learned::PublicEntry> {
        let mut entry = learned::PublicEntry {
            conversation_prefix: String::new(),
            previous_reports: vec![],
            remaining_budget_seconds: cap,
        };
        let Some(reference) = &request.entry else {
            return Ok(entry);
        };
        if request.surface != "wave"
            || reference.previous_binding_ids.is_empty()
            || reference.previous_binding_ids.len() > 64
            || reference
                .previous_binding_ids
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != reference.previous_binding_ids.len()
            || reference.previous_binding_ids.first() != Some(&reference.root_binding_id)
        {
            return Err(invalid(
                "Wave entry requires distinct ordered native predecessors starting at its root",
            ));
        }
        let root = self.store.task_binding(&reference.root_binding_id).await?;
        if root.request.surface != "wave"
            || root.request.context_id != request.context_id
            || root.request.entry.is_some()
            || root.task.limits.timeout_seconds != cap
        {
            return Err(invalid(
                "Native wave root has another context or initial budget",
            ));
        }
        let mut elapsed = 0u64;
        for (index, id) in reference.previous_binding_ids.iter().enumerate() {
            let prior = self.store.task_binding(id).await?;
            let exact_prefix = if index == 0 {
                prior.request.entry.is_none()
            } else {
                prior.request.entry.as_ref().is_some_and(|entry| {
                    entry.root_binding_id == reference.root_binding_id
                        && entry.previous_binding_ids == reference.previous_binding_ids[..index]
                })
            };
            if prior.request.surface != "wave"
                || prior.request.context_id != request.context_id
                || !exact_prefix
                || prior.request.promotion_id != request.promotion_id
                || prior.request.acknowledged_certificate_hash
                    != request.acknowledged_certificate_hash
                || prior
                    .request
                    .wave_mode
                    .as_ref()
                    .map(|mode| &mode.artifact_hash)
                    != request.wave_mode.as_ref().map(|mode| &mode.artifact_hash)
            {
                return Err(invalid(
                    "A wave predecessor belongs to another native task context",
                ));
            }
            let session = self
                .store
                .task_session(&prior)
                .await?
                .ok_or_else(|| invalid("Native predecessor session is missing"))?;
            let output = self.backend.owned_task_output(&prior, &session).await?;
            elapsed = elapsed.saturating_add(output.elapsed_ms);
            if reference.include_previous_output {
                entry.previous_reports.push(output.text);
            }
        }
        let remaining = u64::from(cap) * 1000;
        if elapsed >= remaining {
            return Err(invalid("Native wave root budget is exhausted"));
        }
        entry.remaining_budget_seconds = super::workflow::remaining_seconds(cap, elapsed)
            .ok_or_else(|| invalid("Native wave root budget is exhausted"))?;
        Ok(entry)
    }
    /// Native inventory determines account availability and runtime identity.
    async fn task_candidates(
        &self,
        model: &learned::LearnedModel,
        profile: &str,
    ) -> Result<Vec<RoutingCandidate>> {
        let providers: BTreeSet<_> = model
            .candidates
            .iter()
            .map(|c| c.configuration.provider_id.as_str())
            .collect();
        let mut candidates = BTreeMap::new();
        for provider in providers {
            let accounts = self.backend.accounts(provider).await?;
            for account in accounts {
                for row in self
                    .backend
                    .inventory(provider, Some(&account), false)
                    .await?
                {
                    if row.configuration.execution_profile != profile
                        || row.configuration.account_id.as_deref() != Some(account.as_str())
                    {
                        continue;
                    }
                    for trained in &model.candidates {
                        let mut configuration = row.configuration.clone();
                        configuration.id = trained.configuration.id.clone();
                        configuration.effort = trained.configuration.effort.clone();
                        configuration.fast_mode = trained.configuration.fast_mode;
                        if routing::candidate_key(&configuration) != trained.candidate_key
                            || !inventory_acknowledges(
                                &InventoryModel {
                                    available: true,
                                    ..row.clone()
                                },
                                &configuration,
                            )
                        {
                            continue;
                        }
                        let key = trained.candidate_key.clone();
                        let busy = self.backend.activity(&configuration).await?;
                        let candidate = RoutingCandidate {
                            configuration,
                            available: row.available && busy.active_sessions.is_empty(),
                            reason: row.reason.clone(),
                        };
                        if candidates
                            .get(&key)
                            .is_none_or(|old: &RoutingCandidate| !old.available)
                        {
                            candidates.insert(key, candidate);
                        }
                    }
                }
            }
        }
        Ok(candidates.into_values().collect())
    }
    async fn bind_task(&self, mut request: Request) -> Result<Binding> {
        if request.request_key.trim().is_empty()
            || request.request_key.len() > 256
            || request.context_id.trim().is_empty()
            || request.context_id.len() > 256
            || !matches!(request.surface.as_str(), "chat" | "wave")
            || request.prompt.trim().is_empty()
            || request.prompt.len() > 256 * 1024
        {
            return Err(invalid(
                "An explicit task needs bounded identity, surface and prompt",
            ));
        }
        if !request.request_key.starts_with("owned-task:") {
            request.request_key = format!(
                "owned-task:{}",
                fixtures::hash(request.request_key.as_bytes())
            );
        }
        let lock = super::evaluation_lock(&format!("bind:{}", request.request_key));
        let _guard = lock.lock().await;
        if let Some(saved) = self.store.task_binding_retry(&request).await? {
            return Ok(saved);
        }
        self.require_task_mode(&request).await?;
        let state = self.store.promotion(&request.promotion_id).await?;
        let certificate = state.certificate;
        if certificate.artifact_hash != request.acknowledged_certificate_hash
            || certificate.trajectory.is_some()
        {
            return Err(invalid(
                "The operator has not acknowledged this exact native execution contract",
            ));
        }
        if (certificate.contract.execution_profile == "protected_repository")
            != request.repository.is_some()
        {
            return Err(invalid(
                "This owned profile requires its explicit native repository-copy contract",
            ));
        }
        let entry = self
            .committed_entry(&request, certificate.contract.limits.timeout_seconds)
            .await?;
        let task = certificate
            .contract
            .task(request.prompt.clone(), Some(entry))?;
        let model = self.store.selector_model(&certificate.model_id).await?;
        let candidates = self
            .task_candidates(&model, &certificate.contract.execution_profile)
            .await?;
        let id = hash(&request)?;
        let prediction = learned::PredictionRequest {
            task: task.clone(),
            target_family: format!("application:{id}"),
            target_group: format!("application:{id}"),
            candidates,
            hard_candidate_key: request.hard_candidate_key.clone(),
            min_quality: certificate.min_prediction_quality,
        };
        let selection = executor::Request {
            request_key: request.request_key.clone(),
            surface: request.surface.clone(),
            context_id: request.context_id.clone(),
            prediction,
            prior_keys: certificate.prior_keys.clone(),
            model_id: None,
        };
        let mut decision = self.store.preview_executor_decision(selection).await?;
        if request.hard_candidate_key.is_none() {
            match self
                .store
                .require_active_promotion(&request.promotion_id)
                .await
            {
                Ok(active) if active.artifact_hash == certificate.artifact_hash => {
                    let predicted = learned::predict(&model, &decision.request.prediction)?;
                    if let Some(chosen) = predicted.chosen.clone() {
                        decision.chosen_key = predicted.chosen_key.clone();
                        decision.chosen = Some(chosen);
                        decision.source = "learned".into();
                        decision.reason = "qualified_preregistered_native_owned_policy".into();
                        decision.learned_dispatch_allowed = true;
                    } else {
                        decision.reason = format!("native_prior_fallback:{}", predicted.reason);
                    }
                    decision.research_prediction = Some(predicted);
                    decision.learned_status = "authorized_owned_scope".into();
                }
                Ok(_) => return Err(invalid("Promotion authority changed")),
                Err(failure) => {
                    decision.learned_status = "authority_refused".into();
                    decision.reason = format!("native_prior_fallback:{}", failure.message);
                }
            }
        }
        decision.policy_version = "executor-selection-v1/native-owned-task-v1".into();
        decision.artifact_hash = executor::artifact_hash(&decision)?;
        let decision = self.store.persist_executor_decision(decision).await?;
        let mut binding = Binding {
            id,
            created_at: now(),
            context_hash: hash(&(&task, &request.repository))?,
            request,
            certificate_hash: certificate.artifact_hash,
            task,
            decision,
            artifact_hash: String::new(),
            context_v2: None,
        };
        binding.artifact_hash = hash(&binding)?;
        sqlx::query("INSERT OR IGNORE INTO task_context_bindings(id,request_key,request_hash,binding_json,binding_hash) VALUES(?,?,?,?,?)")
            .bind(&binding.id).bind(&binding.request.request_key).bind(hash(&binding.request)?).bind(serde_json::to_string(&binding)?).bind(&binding.artifact_hash).execute(&self.store.pool).await?;
        self.store
            .task_binding_retry(&binding.request)
            .await?
            .ok_or_else(|| invalid("Task binding disappeared"))
    }
    pub async fn prepare_owned_task(&self, request: Request) -> Result<Prepared> {
        let binding = self.bind_task(request).await?;
        self.prepare_bound_task(binding).await
    }
    async fn prepare_bound_task(&self, binding: Binding) -> Result<Prepared> {
        let lock = super::evaluation_lock(&format!("task:{}", binding.id));
        let _guard = lock.lock().await;
        if let Some(refusal) = self.store.task_preparation_refusal(&binding).await? {
            return Err(preparation_refusal_error(refusal));
        }
        let chosen = binding.decision.chosen.as_ref().ok_or_else(|| {
            invalid(format!(
                "No native owned worker available: {}",
                binding.decision.reason
            ))
        })?;
        if let Some(session) = self.store.task_session(&binding).await? {
            return Ok(Prepared { binding, session });
        }
        if let Some(context) = &binding.context_v2 {
            let budget = context
                .root_budget
                .as_ref()
                .ok_or_else(|| invalid("Native budget authority is absent"))?;
            if let Err(error) = self
                .store
                .verify_task_budget(budget, &binding.id, &context.consent_hash)
                .await
            {
                return Err(self.resolve_preparation_failure(&binding, error).await);
            }
        }
        let preparation = self
            .backend
            .prepare_owned_task(&self.store, &binding, chosen);
        let result = if binding.context_v2.is_some() {
            let remaining = match binding.remaining_ms() {
                Ok(remaining) => remaining,
                Err(error) => return Err(self.resolve_preparation_failure(&binding, error).await),
            };
            match tokio::time::timeout(
                std::time::Duration::from_millis(remaining.saturating_add(5_000)),
                preparation,
            )
            .await
            {
                Ok(result) => result,
                Err(_) => Err(BenchmarkError::new(
                    "budget_timeout",
                    "Native root budget expired during owned session setup",
                )),
            }
        } else {
            preparation.await
        };
        let session = match result {
            Ok(session) => session,
            Err(error) => return Err(self.resolve_preparation_failure(&binding, error).await),
        };
        if binding.context_v2.is_some() {
            if let Err(error) = binding.remaining_ms() {
                return Err(self.resolve_preparation_failure(&binding, error).await);
            }
        }
        if &session.observed != chosen
            || session.context_hash != binding.context_hash
            || !session.owned.substitutions.is_empty()
        {
            return Err(invalid(
                "Provider did not acknowledge the exact bound worker and context",
            ));
        }
        sqlx::query("INSERT OR IGNORE INTO task_owned_sessions(binding_id,session_json,session_hash) VALUES(?,?,?)")
            .bind(&binding.id).bind(serde_json::to_string(&session)?).bind(hash(&session)?).execute(&self.store.pool).await?;
        let session = self
            .store
            .task_session(&binding)
            .await?
            .ok_or_else(|| invalid("Task session disappeared"))?;
        Ok(Prepared { binding, session })
    }
    async fn resolve_preparation_failure(
        &self,
        binding: &Binding,
        error: BenchmarkError,
    ) -> BenchmarkError {
        if error.code != "budget_timeout" || binding.context_v2.is_none() {
            return error;
        }
        // The durable refusal states that the root budget is exhausted, so it
        // needs the bound deadline itself to have passed, not merely a helper
        // that reported a timeout of its own.
        if binding
            .deadline_at_ms()
            .ok()
            .flatten()
            .is_none_or(|deadline| deadline > now())
        {
            return BenchmarkError::new(
                "dispatch_uncertain",
                format!(
                    "Setup stopped before its native deadline; recover the exact task: {}",
                    error.message
                ),
            );
        }
        match self.backend.recover_owned_task_preparation(binding).await {
            Ok(lookup) if lookup.no_provider_start => match self
                .store
                .save_task_preparation_refusal(binding, lookup)
                .await
            {
                Ok(refusal) => preparation_refusal_error(refusal),
                Err(error) => error,
            },
            Ok(lookup) => BenchmarkError::new(
                "dispatch_uncertain",
                "Setup expired; recover the exact native task and inspect its existing claim",
            )
            .with_details(
                serde_json::json!({"bindingId":binding.id,"sessionId":lookup.session_id}),
            ),
            Err(error) => BenchmarkError::new(
                "dispatch_uncertain",
                format!(
                    "Setup expired; native provider-start proof is unresolved: {}",
                    error.message
                ),
            ),
        }
    }
    /// Runtime/selection setup has already awaited. Recheck authority and native
    /// runtime while holding the same gate as revoke, through durable dispatch.
    pub async fn dispatch_owned_task(&self, id: &str) -> Result<ExecutionDispatch> {
        let binding = self.store.task_binding(id).await?;
        let session = self
            .store
            .task_session(&binding)
            .await?
            .ok_or_else(|| invalid("Task has no native session proof"))?;
        if let Some(existing) = self.backend.owned_task_status(&binding, &session).await? {
            return Ok(existing);
        }
        if let Err(error) = binding.remaining_ms() {
            if error.code == "budget_timeout" && binding.context_v2.is_some() {
                return self
                    .backend
                    .refuse_owned_task_dispatch(&binding, &session)
                    .await;
            }
            return Err(error);
        }
        let inventory = self
            .backend
            .inventory(
                &session.observed.provider_id,
                session.observed.account_id.as_deref(),
                false,
            )
            .await?;
        if !inventory
            .iter()
            .any(|row| inventory_acknowledges(row, &session.observed))
        {
            return Err(invalid(
                "Native runtime, account or model availability changed after preparation",
            ));
        }
        let guard = promotion::admission_gate().lock_owned().await;
        if let Err(error) = self.validate_context_v2(&binding).await {
            if error.code == "budget_timeout" && binding.context_v2.is_some() {
                return self
                    .backend
                    .refuse_owned_task_dispatch(&binding, &session)
                    .await;
            }
            return Err(error);
        }
        if binding.decision.learned_dispatch_allowed {
            let active = self
                .store
                .require_active_promotion(&binding.request.promotion_id)
                .await?;
            if active.artifact_hash != binding.certificate_hash
                || !active.covers(
                    &promotion::Contract::from_task(&binding.task),
                    binding.step_index(),
                )
            {
                return Err(invalid("Native role or context authority changed"));
            }
        }
        self.backend
            .dispatch_owned_task(&self.store, &binding, &session, guard)
            .await
    }
    pub async fn owned_task_status(&self, id: &str) -> Result<Option<ExecutionDispatch>> {
        let binding = self.store.task_binding(id).await?;
        let session = self
            .store
            .task_session(&binding)
            .await?
            .ok_or_else(|| invalid("Task session missing"))?;
        self.backend.owned_task_status(&binding, &session).await
    }
    pub async fn cancel_owned_task(&self, id: &str, close: bool) -> Result<()> {
        let binding = self.store.task_binding(id).await?;
        let session = self
            .store
            .task_session(&binding)
            .await?
            .ok_or_else(|| invalid("Task session missing"))?;
        self.backend
            .cancel_owned_task(&binding, &session, close)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row() -> InventoryModel {
        InventoryModel {
            configuration: Configuration {
                id: "native-row".into(),
                provider_id: "invented-provider".into(),
                account_id: Some("native-account".into()),
                model_id: "invented-model".into(),
                model_name: None,
                effort: None,
                fast_mode: None,
                billing_mode: "simulated".into(),
                execution_profile: "native_text".into(),
                inventory_revision: Some("native-revision".into()),
            },
            name: "Invented model".into(),
            efforts: vec!["high".into()],
            supports_fast_mode: false,
            available: true,
            reason: None,
        }
    }
    #[test]
    fn native_choices_allow_only_advertised_controls_and_exact_runtime_account() {
        let inventory = row();
        let mut chosen = inventory.configuration.clone();
        chosen.id = "frozen-candidate-id".into();
        chosen.effort = Some("high".into());
        chosen.fast_mode = Some(false);
        assert!(inventory_acknowledges(&inventory, &chosen));
        for mutation in [
            "effort", "fast", "runtime", "account", "profile", "billing", "model",
        ] {
            let mut changed = chosen.clone();
            match mutation {
                "effort" => changed.effort = Some("unadvertised".into()),
                "fast" => changed.fast_mode = Some(true),
                "runtime" => changed.inventory_revision = Some("changed".into()),
                "account" => changed.account_id = Some("another".into()),
                "profile" => changed.execution_profile = "interactive_acp".into(),
                "billing" => changed.billing_mode = "another".into(),
                _ => changed.model_id = "another".into(),
            }
            assert!(!inventory_acknowledges(&inventory, &changed), "{mutation}");
        }
        let mut unavailable = inventory;
        unavailable.available = false;
        assert!(!inventory_acknowledges(&unavailable, &chosen));
    }
    #[test]
    fn committed_native_budget_uses_ceiling_without_changing_wall_latency() {
        assert_eq!(super::super::workflow::remaining_seconds(10, 8), Some(10));
        assert_eq!(
            super::super::workflow::remaining_seconds(10, 1_001),
            Some(9)
        );
        assert_eq!(
            super::super::workflow::remaining_seconds(10, 9_999),
            Some(1)
        );
        assert_eq!(super::super::workflow::remaining_seconds(10, 10_000), None);
        let mut attempt =
            super::super::pending_attempt("invented", "invented", &row().configuration, 0);
        attempt.duration_ms = Some(1200);
        attempt.native_execution_ms = Some(8);
        let encoded = serde_json::to_value(attempt).unwrap();
        assert_eq!(encoded["durationMs"], 1200);
        assert_eq!(encoded["nativeExecutionMs"], 8);
    }
}
