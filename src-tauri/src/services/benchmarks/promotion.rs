//! Explicit deployment authority. Research reports never authorize dispatch.
use super::{
    fixtures, learned, qualification, repository,
    store::{now, Store},
    types::*,
    workflow_campaign::acceptance,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::BTreeSet;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

/// Revocation and the final native dispatch reservation share one admission
/// boundary. The lock is released before provider work starts.
pub(super) fn admission_gate() -> Arc<Mutex<()>> {
    static GATE: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(Mutex::new(()))).clone()
}

fn invalid(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("invalid_promotion", message)
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(fixtures::hash(&serde_json::to_vec(value)?))
}

pub(super) enum Discovery {
    Pinned,
    Unique(Box<Certificate>),
    Refused(&'static str),
}
impl Discovery {
    pub(super) fn reason(&self) -> &'static str {
        match self {
            Self::Pinned => "explicit_native_pin",
            Self::Unique(_) => "unique_exact_active_policy",
            Self::Refused(reason) => reason,
        }
    }
}

fn native_configuration_matches(expected: &Configuration, actual: &Configuration) -> bool {
    super::routing::candidate_key(expected) == super::routing::candidate_key(actual)
        && expected.provider_id == actual.provider_id
        && expected.account_id == actual.account_id
        && expected.model_id == actual.model_id
        && expected.effort == actual.effort
        && expected.fast_mode == actual.fast_mode
        && expected.billing_mode == actual.billing_mode
        && expected.inventory_revision == actual.inventory_revision
        && expected.execution_profile == actual.execution_profile
}

/// This exact owned contract is shown before the operator opts a task into it.
/// It cannot attest an ordinary interactive session or its opaque context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contract {
    pub work_class_id: String,
    pub role_id: Option<String>,
    pub role_prompt: String,
    pub permissions: Permissions,
    pub execution_profile: String,
    pub limits: Limits,
    pub entry_present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_recipe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_recipe: Option<String>,
}
impl Contract {
    pub fn from_task(task: &learned::PublicTask) -> Self {
        let mut permissions = task.permissions.clone();
        permissions.tools.sort();
        permissions.tools.dedup();
        Self {
            work_class_id: task.work_class_id.clone(),
            role_id: task.role_id.clone(),
            role_prompt: task.role_prompt.clone(),
            permissions,
            execution_profile: task.execution_profile.clone(),
            limits: task.limits.clone(),
            entry_present: task.entry.is_some(),
            budget_recipe: task.budget_recipe.clone(),
            repository_recipe: task.repository_recipe.clone(),
        }
    }
    pub fn task(
        &self,
        prompt: String,
        entry: Option<learned::PublicEntry>,
    ) -> Result<learned::PublicTask> {
        if entry.is_some() != self.entry_present {
            return Err(invalid(
                "The task entry shape differs from the approved contract",
            ));
        }
        Ok(learned::PublicTask {
            work_class_id: self.work_class_id.clone(),
            prompt,
            fixtures: vec![],
            facets: Default::default(),
            role_id: self.role_id.clone(),
            role_prompt: self.role_prompt.clone(),
            permissions: self.permissions.clone(),
            execution_profile: self.execution_profile.clone(),
            limits: self.limits.clone(),
            entry,
            budget_recipe: self.budget_recipe.clone(),
            repository_recipe: self.repository_recipe.clone(),
            repository_artifact: None,
        })
    }
    fn validate(&self) -> Result<()> {
        if !matches!(
            self.execution_profile.as_str(),
            "native_text" | "protected_repository"
        ) || self.permissions.context != "clean"
            || self.limits.timeout_seconds == 0
            || self.limits.max_turns != 1
            || self.limits.max_artifact_bytes == 0
            || !self.entry_present
            || self
                .budget_recipe
                .as_deref()
                .is_some_and(|recipe| recipe != super::artifact_context::CLOCK_RECIPE)
            || self.repository_recipe.as_deref().is_some_and(|recipe| {
                recipe != repository::ARTIFACT_RECIPE
                    || self.execution_profile != "protected_repository"
                    || self.budget_recipe.is_none()
            })
            || (self.execution_profile == "native_text"
                && (!self.permissions.tools.is_empty() || self.permissions.network))
            || (self.execution_profile == "protected_repository"
                && (!self.permissions.network
                    || self.permissions.tools != ["filesystem", "terminal"]))
        {
            return Err(invalid(
                "Deployment requires the genuine bounded owned profile, explicit permissions and frozen entry contract",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registration {
    pub request_key: String,
    pub campaign_id: String,
    pub operator: String,
    pub rule: acceptance::Rule,
    pub contract: Contract,
    pub qualification_ids: Vec<String>,
    /// A campaign registers every step, in order, when its steps do not all
    /// share one contract or it names a model per step class; `contract` is
    /// then its first step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trajectory: Option<TrajectoryContract>,
}
/// The exact step sequence and root wall budget a trajectory rule covers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrajectoryContract {
    pub root_budget_seconds: u32,
    pub steps: Vec<Contract>,
}
/// What an operator acknowledges for a campaign, computed natively from its
/// frozen cases: one shared contract, or a step-by-step trajectory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub contract: Contract,
    pub trajectory: Option<TrajectoryContract>,
}
/// One step of a certified trajectory and the class model it uses.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CertifiedStep {
    pub contract: Contract,
    pub model_id: String,
    pub model_snapshot_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CertifiedTrajectory {
    pub root_budget_seconds: u32,
    pub steps: Vec<CertifiedStep>,
}
impl CertifiedTrajectory {
    pub fn contract(&self) -> TrajectoryContract {
        TrajectoryContract {
            root_budget_seconds: self.root_budget_seconds,
            steps: self
                .steps
                .iter()
                .map(|step| step.contract.clone())
                .collect(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredRule {
    pub request: Registration,
    pub created_at: i64,
    pub plan_hash: String,
    pub qualification_hashes: Vec<String>,
    pub artifact_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Certificate {
    pub id: String,
    pub created_at: i64,
    pub model_id: String,
    pub model_snapshot_hash: String,
    pub campaign_id: String,
    pub campaign_plan_hash: String,
    pub report_hash: String,
    pub rule_hash: String,
    pub contract: Contract,
    pub assessment: acceptance::Assessment,
    pub qualifications: Vec<qualification::Binding>,
    pub prior_keys: Vec<String>,
    pub min_prediction_quality: f64,
    pub artifact_hash: String,
    /// Native accounts are not stored in the account-neutral coefficient model.
    /// Omitted for old certificates, preserving their original hashes/authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_inventory: Option<Vec<Configuration>>,
    /// A trajectory certificate speaks only for this exact step sequence,
    /// never for a lone step of its first contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trajectory: Option<CertifiedTrajectory>,
}
impl Certificate {
    /// Whether this certificate authorizes that contract at that lineage
    /// position: any position for a single contract, exactly its own step
    /// for a trajectory.
    pub fn covers(&self, contract: &Contract, step_index: usize) -> bool {
        match &self.trajectory {
            None => self.contract == *contract,
            Some(trajectory) => trajectory
                .steps
                .get(step_index)
                .is_some_and(|step| step.contract == *contract),
        }
    }
    /// The fitted model that selects the worker at that lineage position.
    pub fn model_for_step(&self, step_index: usize) -> Option<&str> {
        match &self.trajectory {
            None => Some(&self.model_id),
            Some(trajectory) => trajectory
                .steps
                .get(step_index)
                .map(|step| step.model_id.as_str()),
        }
    }
    /// The fitted model this certificate stands behind for a work class.
    pub fn model_for_class(&self, work_class: &str) -> Option<&str> {
        match &self.trajectory {
            None => (self.contract.work_class_id == work_class).then_some(self.model_id.as_str()),
            Some(trajectory) => trajectory
                .steps
                .iter()
                .find(|step| step.contract.work_class_id == work_class)
                .map(|step| step.model_id.as_str()),
        }
    }
}

/// What a work class can show about learned selection: the certificate that
/// drives it, or how far its evidence still is from one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassPolicy {
    pub work_class_id: String,
    pub certificate_id: Option<String>,
    pub certified_at: Option<i64>,
    pub campaign_id: Option<String>,
    pub model_id: Option<String>,
    /// Current published versions with a valid qualification record.
    pub qualified_training: usize,
    pub qualified_held_out: usize,
    /// Qualified held-out versions that are whole workflows.
    pub held_out_workflows: usize,
    pub fits: usize,
    pub campaigns: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub certificate: Certificate,
    pub revoked_at: Option<i64>,
    pub revocation_reason: Option<String>,
}
impl Store {
    /// Issuance may inspect complete immutable first trajectories. Inference
    /// uses only the resulting certificate projection, never these outcomes.
    async fn attest_campaign_inventory(
        &self,
        campaign: &super::workflow_campaign::Campaign,
    ) -> Result<Option<Vec<Configuration>>> {
        let candidates = &campaign.plan.request.candidates;
        if candidates
            .iter()
            .any(|candidate| candidate.account_id.is_none())
        {
            return Ok(None);
        }
        let mut observed = BTreeSet::new();
        for index in 0..campaign.plan.cells.len() {
            let request = campaign.plan.run_request(index)?;
            let row = sqlx::query(
                "SELECT result_json,result_hash FROM workflow_campaign_cells WHERE request_key=?",
            )
            .bind(&request.request_key)
            .fetch_one(&self.pool)
            .await?;
            let body: String = row.try_get("result_json")?;
            let trace: super::workflow::Trace = serde_json::from_str(&body)?;
            if hash(&trace)? != row.try_get::<String, _>("result_hash")? {
                return Err(invalid("Native deployment trajectory integrity changed"));
            }
            for step in &trace.steps {
                let Some(actual) = &step.attempt.observed else {
                    return Ok(None);
                };
                let expected = candidates
                    .iter()
                    .find(|candidate| {
                        super::routing::candidate_key(candidate)
                            == super::routing::candidate_key(actual)
                    })
                    .ok_or_else(|| invalid("Native deployment observed an unregistered worker"))?;
                if !native_configuration_matches(expected, actual)
                    || !native_configuration_matches(&step.attempt.configuration, actual)
                {
                    return Err(invalid(
                        "Native deployment account/runtime/settings acknowledgement differs from the frozen campaign",
                    ));
                }
                let Some(digest) = &step.attempt.evidence_hash else {
                    return Ok(None);
                };
                if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err(invalid("Native deployment receipt seal is invalid"));
                }
                let path = self
                    .root
                    .join("runs")
                    .join(&step.attempt.run_id)
                    .join(&step.attempt.id)
                    .join("evidence")
                    .join(format!("{digest}.json"));
                let bytes = tokio::fs::read(path).await?;
                if fixtures::hash(&bytes) != *digest {
                    return Err(invalid("Native deployment receipt seal changed"));
                }
                let evidence: serde_json::Value = serde_json::from_slice(&bytes)?;
                let Some(receipt) = evidence.pointer("/events/nativeExecutionReceipt") else {
                    return Ok(None);
                };
                let receipt: super::runner::native_receipt::NativeExecutionReceipt =
                    serde_json::from_value(receipt.clone())?;
                receipt.validate_policy_metadata()?;
                if evidence["attemptId"].as_str() != Some(step.attempt.id.as_str())
                    || evidence["sessionId"].as_str() != step.attempt.session_id.as_deref()
                    || receipt.owner_id
                        != format!(
                            "{}:{}",
                            step.attempt.id,
                            step.attempt.started_at.unwrap_or_default()
                        )
                    || receipt.request_key
                        != format!(
                            "benchmark:{}:{}",
                            step.attempt.id,
                            step.attempt.started_at.unwrap_or_default()
                        )
                    || Some(receipt.session_id.as_str()) != step.attempt.session_id.as_deref()
                    || Some(receipt.host_run_id.as_str()) != step.attempt.host_run_id.as_deref()
                    || receipt.provider_id != actual.provider_id
                    || Some(receipt.account_id.as_str()) != actual.account_id.as_deref()
                    || receipt.model_id != actual.model_id
                    || receipt.effort != actual.effort
                    || receipt.fast_mode != actual.fast_mode
                    || receipt.execution_profile != actual.execution_profile
                    || Some(receipt.inventory_revision.as_str())
                        != actual.inventory_revision.as_deref()
                {
                    return Err(invalid(
                        "Native deployment sealed receipt differs from actual acknowledged execution",
                    ));
                }
                let terminal = evidence
                    .pointer("/events/turnEvents")
                    .and_then(serde_json::Value::as_array)
                    .and_then(|events| {
                        events
                            .iter()
                            .find_map(|event| event.get("terminalDispatch"))
                    })
                    .ok_or_else(|| {
                        invalid("Native deployment receipt has no sealed terminal dispatch")
                    })?;
                let terminal: crate::services::agent_host::execution::ExecutionDispatch =
                    serde_json::from_value(terminal.clone())?;
                receipt.validate_terminal_dispatch(&terminal)?;
                if Some(receipt.native_execution_ms) != step.attempt.native_execution_ms {
                    return Err(invalid(
                        "Native deployment terminal receipt/settings/runtime clock joins differ",
                    ));
                }
                observed.insert(super::routing::candidate_key(expected));
            }
        }
        if candidates
            .iter()
            .any(|candidate| !observed.contains(&super::routing::candidate_key(candidate)))
        {
            return Ok(None);
        }
        Ok(Some(candidates.clone()))
    }
    /// Only immutable certificates, native authority metadata and coefficient
    /// models are read here. No fit labels, grader payloads or control records.
    pub(super) async fn discover_active_policy(
        &self,
        contract: &Contract,
        inventory: &[RoutingCandidate],
        native_prior_keys: &[String],
    ) -> Result<Discovery> {
        // A trajectory certificate never authorizes a lone step, even when
        // that step equals its first contract.
        self.discover(
            |certificate| certificate.trajectory.is_none() && &certificate.contract == contract,
            inventory,
            native_prior_keys,
        )
        .await
    }

    /// The root of a planned trajectory finds the one active certificate for
    /// that exact step sequence and root budget.
    pub(super) async fn discover_active_trajectory(
        &self,
        trajectory: &TrajectoryContract,
        inventory: &[RoutingCandidate],
        native_prior_keys: &[String],
    ) -> Result<Discovery> {
        self.discover(
            |certificate| {
                certificate
                    .trajectory
                    .as_ref()
                    .is_some_and(|certified| certified.contract() == *trajectory)
            },
            inventory,
            native_prior_keys,
        )
        .await
    }

    async fn discover(
        &self,
        covers: impl Fn(&Certificate) -> bool,
        inventory: &[RoutingCandidate],
        native_prior_keys: &[String],
    ) -> Result<Discovery> {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM selector_promotions WHERE revoked_at IS NULL ORDER BY id LIMIT 257",
        )
        .fetch_all(&self.pool)
        .await?;
        if ids.len() > 256 {
            return Ok(Discovery::Refused("active_policy_discovery_bound"));
        }
        let mut compatible = Vec::new();
        let mut unattested = false;
        for id in ids {
            let state = self.promotion(&id).await?;
            if !covers(&state.certificate) {
                continue;
            }
            let certificate = match self.require_active_promotion(&id).await {
                Ok(certificate) => certificate,
                Err(error) if error.code == "invalid_promotion" => continue,
                Err(error) => return Err(error),
            };
            let mut models = vec![self.selector_model(&certificate.model_id).await?];
            for step in certificate.trajectory.iter().flat_map(|t| &t.steps) {
                if models.iter().all(|model| model.id != step.model_id) {
                    models.push(self.selector_model(&step.model_id).await?);
                }
            }
            if certificate.prior_keys != native_prior_keys
                || !models.iter().all(|model| {
                    native_prior_keys.iter().all(|key| {
                        model
                            .candidates
                            .iter()
                            .any(|trained| &trained.candidate_key == key)
                    })
                })
            {
                continue;
            }
            let Some(attested) = &certificate.native_inventory else {
                unattested = true;
                continue;
            };
            if models
                .iter()
                .flat_map(|model| &model.candidates)
                .all(|trained| {
                    inventory.iter().any(|row| {
                        super::routing::candidate_key(&row.configuration) == trained.candidate_key
                            && row.configuration.inventory_revision
                                == trained.configuration.inventory_revision
                            && attested.iter().any(|proof| {
                                native_configuration_matches(proof, &row.configuration)
                            })
                    })
                })
            {
                compatible.push(certificate);
            }
        }
        Ok(match compatible.len() {
            0 if unattested => Discovery::Refused("legacy_unattested_native_inventory"),
            0 => Discovery::Refused("no_exact_active_policy"),
            1 => Discovery::Unique(Box::new(compatible.remove(0))),
            _ => Discovery::Refused("ambiguous_exact_active_policies"),
        })
    }
    /// The first native admission is the deadline, including unsuccessful or
    /// preview admissions. A later fit cutoff cannot launder unqualified data.
    async fn training_admission(&self, example: &learned::TrainingExample) -> Result<i64> {
        let runs = self.all_runs().await?;
        let used: BTreeSet<_> = example
            .targets
            .iter()
            .filter_map(|target| target.evidence["runId"].as_str())
            .collect();
        runs.iter()
            .filter(|run| {
                used.contains(run.id.as_str())
                    || run.request.version_ids.contains(&example.version_id)
                    || run
                        .attempts
                        .iter()
                        .any(|a| a.version_id == example.version_id)
            })
            .map(|run| run.created_at)
            .min()
            .ok_or_else(|| invalid("Fitted training evidence has no immutable native admission"))
    }

    async fn validate_training_budget(
        &self,
        fit: &learned::FitArtifact,
        contract: &Contract,
    ) -> Result<()> {
        for example in &fit.snapshot.examples {
            for target in example
                .targets
                .iter()
                .filter(|target| target.status == "observed")
            {
                if target.evidence["effectiveTimeoutSeconds"].as_u64()
                    != Some(u64::from(contract.limits.timeout_seconds))
                {
                    return Err(invalid(
                        "The deployment budget differs from the effective collected training budget",
                    ));
                }
                let run_id = target.evidence["runId"]
                    .as_str()
                    .ok_or_else(|| invalid("Training admission evidence is missing"))?;
                let run = self.run(run_id).await?;
                let version = self.version(&example.version_id).await?;
                if super::runner::effective_timeout_seconds(
                    run.request.timeout_seconds,
                    &version.manifest,
                ) != contract.limits.timeout_seconds
                {
                    return Err(invalid(
                        "Collected native timeout differs from the deployment budget",
                    ));
                }
            }
        }
        Ok(())
    }

    /// Every fitted model a campaign evaluated, checked against its frozen
    /// snapshot: one for a single-class campaign, one per class otherwise.
    async fn campaign_fits(
        &self,
        campaign: &super::workflow_campaign::Campaign,
    ) -> Result<Vec<learned::FitArtifact>> {
        let request = &campaign.plan.request;
        let primary = self.selector_fit(&request.model_id).await?;
        if primary.model.snapshot_hash != campaign.plan.model_snapshot_hash {
            return Err(invalid("The frozen campaign model changed"));
        }
        if request.class_model_ids.is_empty() {
            return Ok(vec![primary]);
        }
        let mut fits = Vec::new();
        for (class, id) in &request.class_model_ids {
            let fit = self.selector_fit(id).await?;
            if &fit.model.work_class_id != class
                || campaign.plan.class_snapshot_hashes.get(class) != Some(&fit.model.snapshot_hash)
            {
                return Err(invalid("A frozen class model changed"));
            }
            fits.push(fit);
        }
        Ok(fits)
    }

    /// The exact deployment a campaign evaluated, computed natively from its
    /// frozen cases. The operator acknowledges this projection; a renderer
    /// never assembles it. Steps that do not all share one contract, or a
    /// campaign with class models, form a trajectory every case shares.
    pub async fn campaign_deployment(&self, campaign_id: &str) -> Result<Deployment> {
        let campaign = self.workflow_campaign(campaign_id).await?;
        let mut cases = Vec::new();
        for case in &campaign.plan.cases {
            let version = self.version(&case.version_id).await?;
            if hash(&version.manifest)? != case.manifest_hash {
                return Err(invalid("Frozen workflow manifest changed"));
            }
            let steps = version
                .manifest
                .workflow
                .as_ref()
                .ok_or_else(|| invalid("Frozen workflow is absent"))?
                .steps
                .len();
            let contracts = (0..steps)
                .map(|index| {
                    super::workflow_campaign::step_task(
                        &version.manifest,
                        index,
                        campaign.plan.request.timeout_seconds,
                    )
                    .map(|task| Contract::from_task(&task))
                })
                .collect::<Result<Vec<_>>>()?;
            cases.push(contracts);
        }
        let first = cases
            .first()
            .and_then(|steps| steps.first())
            .cloned()
            .ok_or_else(|| invalid("Campaign has no frozen cases"))?;
        if campaign.plan.request.class_model_ids.is_empty()
            && cases.iter().flatten().all(|contract| *contract == first)
        {
            return Ok(Deployment {
                contract: first,
                trajectory: None,
            });
        }
        if cases.windows(2).any(|pair| pair[0] != pair[1]) {
            return Err(invalid(
                "Campaign cases do not share one deployment trajectory",
            ));
        }
        Ok(Deployment {
            contract: first,
            trajectory: Some(TrajectoryContract {
                root_budget_seconds: campaign.plan.request.timeout_seconds,
                steps: cases.remove(0),
            }),
        })
    }

    async fn validate_single_registration(
        &self,
        campaign: &super::workflow_campaign::Campaign,
        contract: &Contract,
    ) -> Result<()> {
        let fit = self.selector_fit(&campaign.plan.request.model_id).await?;
        let public = contract.task(
            "Scope validation".into(),
            Some(learned::PublicEntry {
                conversation_prefix: String::new(),
                previous_reports: vec![],
                remaining_budget_seconds: contract.limits.timeout_seconds,
            }),
        )?;
        if !fit
            .model
            .scope_hashes
            .contains(&learned::scope_hash(&public)?)
            || fit
                .snapshot
                .examples
                .iter()
                .any(|example| Contract::from_task(&example.task) != *contract)
            || campaign.plan.request.timeout_seconds != contract.limits.timeout_seconds
            || campaign
                .plan
                .request
                .candidates
                .iter()
                .any(|c| c.execution_profile != contract.execution_profile)
        {
            return Err(invalid(
                "The deployment contract must match the exact fitted and evaluated owned scope and budgets",
            ));
        }
        self.validate_training_budget(&fit, contract).await?;
        self.validate_campaign_contract(campaign, contract).await
    }

    /// A trajectory rule binds each step's exact contract to the model fitted
    /// for that step's class, with the scope and budget checks a single rule
    /// receives, and fixes the root wall budget every step shares.
    async fn validate_trajectory_registration(
        &self,
        campaign: &super::workflow_campaign::Campaign,
        trajectory: &TrajectoryContract,
    ) -> Result<()> {
        let fits = self.campaign_fits(campaign).await?;
        for contract in &trajectory.steps {
            contract.validate()?;
            let fit = fits
                .iter()
                .find(|fit| fit.model.work_class_id == contract.work_class_id)
                .ok_or_else(|| invalid("A trajectory step has no class model"))?;
            let public = contract.task(
                "Scope validation".into(),
                Some(learned::PublicEntry {
                    conversation_prefix: String::new(),
                    previous_reports: vec![],
                    remaining_budget_seconds: contract.limits.timeout_seconds,
                }),
            )?;
            if !fit
                .model
                .scope_hashes
                .contains(&learned::scope_hash(&public)?)
                || fit
                    .snapshot
                    .examples
                    .iter()
                    .any(|example| Contract::from_task(&example.task) != *contract)
                || contract.limits.timeout_seconds > trajectory.root_budget_seconds
                || campaign
                    .plan
                    .request
                    .candidates
                    .iter()
                    .any(|c| c.execution_profile != contract.execution_profile)
            {
                return Err(invalid(
                    "Every trajectory step must match its class model's exact fitted scope and budgets",
                ));
            }
            self.validate_training_budget(fit, contract).await?;
        }
        for case in &campaign.plan.cases {
            let version = self.version(&case.version_id).await?;
            if super::runner::effective_timeout_seconds(
                campaign.plan.request.timeout_seconds,
                &version.manifest,
            ) != trajectory.root_budget_seconds
            {
                return Err(invalid(
                    "Every frozen trajectory must start with the registered root budget",
                ));
            }
        }
        Ok(())
    }

    pub(super) async fn validate_campaign_contract(
        &self,
        campaign: &super::workflow_campaign::Campaign,
        contract: &Contract,
    ) -> Result<()> {
        for case in &campaign.plan.cases {
            let version = self.version(&case.version_id).await?;
            if hash(&version.manifest)? != case.manifest_hash {
                return Err(invalid("Frozen workflow manifest changed"));
            }
            let workflow = version
                .manifest
                .workflow
                .as_ref()
                .ok_or_else(|| invalid("Frozen workflow is absent"))?;
            // workflow::prepare_step applies a step's own scope; without one
            // the step inherits the root role, permissions, profile and limits.
            // Only prompt and native entry vary per step. The root budget is
            // the initial cap; each fresh step receives the remaining cap after
            // native measured prior work. This is the same explicit
            // remaining-budget mapping used at deployment.
            for index in 0..workflow.steps.len() {
                let task = super::workflow_campaign::step_task(
                    &version.manifest,
                    index,
                    campaign.plan.request.timeout_seconds,
                )?;
                if Contract::from_task(&task) != *contract
                    || super::runner::effective_timeout_seconds(
                        campaign.plan.request.timeout_seconds,
                        &version.manifest,
                    ) != contract.limits.timeout_seconds
                {
                    return Err(invalid(
                        "Every frozen workflow step must use the exact deployment contract and initial native budget",
                    ));
                }
            }
        }
        Ok(())
    }

    async fn registration_qualifications(
        &self,
        request: &Registration,
    ) -> Result<Vec<qualification::Binding>> {
        let campaign = self.workflow_campaign(&request.campaign_id).await?;
        // Every class model's training versions need qualification too.
        let fits = self.campaign_fits(&campaign).await?;
        let examples: Vec<_> = fits.iter().flat_map(|fit| &fit.snapshot.examples).collect();
        let needed: BTreeSet<_> = examples
            .iter()
            .map(|e| &e.version_id)
            .chain(campaign.plan.cases.iter().map(|c| &c.version_id))
            .collect();
        let mut covered = BTreeSet::new();
        let mut bindings = Vec::new();
        for id in &request.qualification_ids {
            let record = self.qualification(id).await?;
            let binding = self
                .qualification_bindings(&record.request.version_id)
                .await?
                .into_iter()
                .find(|b| &b.id == id)
                .ok_or_else(|| invalid("Qualification binding disappeared"))?;
            let version = self.version(&binding.version_id).await?;
            qualification::validate_protocol(&record, &version)?;
            // Training versions qualify before their first native admission,
            // the earliest one when class fits share a version; held-out
            // cases qualify before the campaign was reserved.
            let mut deadline: Option<i64> = None;
            for example in examples
                .iter()
                .filter(|e| e.version_id == binding.version_id)
            {
                let admitted = self.training_admission(example).await?;
                deadline = Some(deadline.map_or(admitted, |at| at.min(admitted)));
            }
            let deadline = deadline.unwrap_or(campaign.plan.created_at);
            if !needed.contains(&binding.version_id)
                || !covered.insert(binding.version_id.clone())
                || binding.revoked_at.is_some()
                || binding.status != "controls_verified_review_attested"
                || record.finished_at.is_none_or(|at| at >= deadline)
                || binding.content_hash != version.content_hash
                || binding.manifest_hash != hash(&version.manifest)?
                || binding.evaluator_revision != version.manifest.evaluator.revision
            {
                return Err(invalid(
                    "Every frozen training and workflow version needs its exact unrevoked first qualification before the evidence cutoff/reservation",
                ));
            }
            bindings.push(binding);
        }
        if covered.len() != needed.len() {
            return Err(invalid("Qualification coverage is incomplete"));
        }
        bindings.sort_by(|a, b| a.version_id.cmp(&b.version_id));
        Ok(bindings)
    }
    /// Commit the operator's rule while the campaign is still unexposed.
    pub async fn register_promotion_rule(
        &self,
        mut request: Registration,
    ) -> Result<RegisteredRule> {
        for contract in std::iter::once(&mut request.contract).chain(
            request
                .trajectory
                .iter_mut()
                .flat_map(|trajectory| trajectory.steps.iter_mut()),
        ) {
            contract.permissions.tools.sort();
            contract.permissions.tools.dedup();
        }
        request.qualification_ids.sort();
        if request.request_key.trim().is_empty()
            || request.request_key.len() > 128
            || request.operator.trim().is_empty()
            || request.operator.len() > 256
            || request.qualification_ids.len() > 512
            || request
                .qualification_ids
                .windows(2)
                .any(|ids| ids[0] == ids[1])
        {
            return Err(invalid(
                "Registration needs bounded request/operator IDs and distinct qualification records",
            ));
        }
        request.rule.validate()?;
        request.contract.validate()?;
        if let Some(saved) = self.promotion_rule(&request.campaign_id).await? {
            if hash(&saved.request)? != hash(&request)? {
                return Err(invalid(
                    "An immutable rule already exists for this campaign",
                ));
            }
            return Ok(saved);
        }
        let campaign = self.workflow_campaign(&request.campaign_id).await?;
        // The rule acknowledges exactly what the campaign evaluated: one
        // shared contract, or every step of one shared trajectory.
        let deployment = self.campaign_deployment(&request.campaign_id).await?;
        if deployment.contract != request.contract || deployment.trajectory != request.trajectory {
            return Err(invalid(
                "The rule must acknowledge the campaign's exact deployment contract or step-by-step trajectory",
            ));
        }
        if let Some(trajectory) = &request.trajectory {
            self.validate_trajectory_registration(&campaign, trajectory)
                .await?;
        } else {
            self.validate_single_registration(&campaign, &request.contract)
                .await?;
        }
        let bindings = self.registration_qualifications(&request).await?;
        let mut saved = RegisteredRule {
            request,
            created_at: now(),
            plan_hash: campaign.plan_hash,
            qualification_hashes: bindings.iter().map(|b| b.record_hash.clone()).collect(),
            artifact_hash: String::new(),
        };
        saved.artifact_hash = hash(&saved)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row =
            sqlx::query("SELECT state,next_cell,plan_hash FROM workflow_campaigns WHERE id=?")
                .bind(&saved.request.campaign_id)
                .fetch_one(&mut *tx)
                .await?;
        let exposed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM run_plans WHERE request_key IN (SELECT request_key FROM workflow_campaign_cells WHERE campaign_id=?)")
            .bind(&saved.request.campaign_id).fetch_one(&mut *tx).await?;
        if row.try_get::<String, _>("state")? != "reserved"
            || row.try_get::<i64, _>("next_cell")? != 0
            || row.try_get::<String, _>("plan_hash")? != saved.plan_hash
            || exposed != 0
        {
            return Err(invalid(
                "The comparison rule must be registered before any campaign admission or outcome",
            ));
        }
        sqlx::query("INSERT INTO selector_promotion_rules(campaign_id,request_key,request_hash,created_at,request_json,artifact_hash) VALUES(?,?,?,?,?,?)")
            .bind(&saved.request.campaign_id).bind(&saved.request.request_key).bind(hash(&saved.request)?)
            .bind(saved.created_at).bind(serde_json::to_string(&saved)?).bind(&saved.artifact_hash).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(saved)
    }
    pub async fn promotion_rule(&self, campaign: &str) -> Result<Option<RegisteredRule>> {
        let row = sqlx::query("SELECT request_json,artifact_hash,request_hash FROM selector_promotion_rules WHERE campaign_id=?")
            .bind(campaign).fetch_optional(&self.pool).await?;
        let Some(row) = row else { return Ok(None) };
        let value: RegisteredRule = serde_json::from_str(row.try_get("request_json")?)?;
        let mut body = value.clone();
        body.artifact_hash.clear();
        if hash(&body)? != value.artifact_hash
            || row.try_get::<String, _>("artifact_hash")? != value.artifact_hash
            || hash(&value.request)? != row.try_get::<String, _>("request_hash")?
            || value.request.campaign_id != campaign
        {
            return Err(invalid("Registered rule integrity check failed"));
        }
        Ok(Some(value))
    }
    pub async fn promote_selector(&self, campaign_id: &str) -> Result<State> {
        if let Some(state) = self.promotion_for_campaign(campaign_id).await? {
            return Ok(state);
        }
        let registration = self
            .promotion_rule(campaign_id)
            .await?
            .ok_or_else(|| invalid("No preregistered deployment rule exists"))?;
        let campaign = self.workflow_campaign(campaign_id).await?;
        // The rule must still name exactly what the campaign evaluated, also
        // for rules registered before trajectories had their own form.
        let deployment = self.campaign_deployment(campaign_id).await?;
        if deployment.contract != registration.request.contract
            || deployment.trajectory != registration.request.trajectory
        {
            return Err(invalid(
                "The registered rule does not name what the campaign evaluated",
            ));
        }
        let report = self.workflow_campaign_report(campaign_id).await?;
        let fit = self.selector_fit(&campaign.plan.request.model_id).await?;
        let qualifications = self
            .registration_qualifications(&registration.request)
            .await?;
        if registration.plan_hash != campaign.plan_hash
            || report.plan_hash != campaign.plan_hash
            || qualifications
                .iter()
                .map(|b| &b.record_hash)
                .collect::<Vec<_>>()
                != registration.qualification_hashes.iter().collect::<Vec<_>>()
        {
            return Err(invalid("Registered evidence bindings changed"));
        }
        let fixed: Vec<_> = campaign
            .plan
            .request
            .candidates
            .iter()
            .map(|c| c.id.clone())
            .collect();
        let assessment = acceptance::assess(&registration.request.rule, &report.cases, &fixed)?;
        if !assessment.passed {
            return Err(invalid(format!(
                "Preregistered comparison failed: {}",
                assessment.reasons.join(", ")
            )));
        }
        let native_inventory = self.attest_campaign_inventory(&campaign).await?;
        let trajectory = match &registration.request.trajectory {
            None => None,
            Some(registered) => {
                let fits = self.campaign_fits(&campaign).await?;
                let steps = registered
                    .steps
                    .iter()
                    .map(|contract| {
                        let fit = fits
                            .iter()
                            .find(|fit| fit.model.work_class_id == contract.work_class_id)
                            .ok_or_else(|| invalid("A trajectory step has no class model"))?;
                        Ok(CertifiedStep {
                            contract: contract.clone(),
                            model_id: fit.model.id.clone(),
                            model_snapshot_hash: fit.model.snapshot_hash.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                Some(CertifiedTrajectory {
                    root_budget_seconds: registered.root_budget_seconds,
                    steps,
                })
            }
        };
        let mut certificate = Certificate {
            id: String::new(),
            created_at: now(),
            model_id: fit.model.id,
            model_snapshot_hash: fit.model.snapshot_hash,
            campaign_id: campaign_id.into(),
            campaign_plan_hash: campaign.plan_hash,
            report_hash: report.artifact_hash,
            rule_hash: registration.artifact_hash,
            contract: registration.request.contract,
            assessment,
            qualifications,
            prior_keys: campaign
                .plan
                .request
                .persona_prior_ids
                .iter()
                .filter_map(|id| {
                    campaign
                        .plan
                        .request
                        .candidates
                        .iter()
                        .find(|candidate| &candidate.id == id)
                })
                .map(super::routing::candidate_key)
                .collect(),
            min_prediction_quality: campaign.plan.request.min_quality,
            artifact_hash: String::new(),
            native_inventory,
            trajectory,
        };
        certificate.id = hash(&certificate)?;
        certificate.artifact_hash = hash(&certificate)?;
        sqlx::query("INSERT OR IGNORE INTO selector_promotions(id,campaign_id,created_at,artifact_json,artifact_hash) VALUES(?,?,?,?,?)")
            .bind(&certificate.id).bind(campaign_id).bind(certificate.created_at)
            .bind(serde_json::to_string(&certificate)?).bind(&certificate.artifact_hash).execute(&self.pool).await?;
        self.promotion_for_campaign(campaign_id)
            .await?
            .ok_or_else(|| invalid("Promotion disappeared"))
    }
    async fn promotion_for_campaign(&self, campaign: &str) -> Result<Option<State>> {
        let id: Option<String> =
            sqlx::query_scalar("SELECT id FROM selector_promotions WHERE campaign_id=?")
                .bind(campaign)
                .fetch_optional(&self.pool)
                .await?;
        match id {
            Some(id) => self.promotion(&id).await.map(Some),
            None => Ok(None),
        }
    }
    pub async fn promotion(&self, id: &str) -> Result<State> {
        let row=sqlx::query("SELECT artifact_json,artifact_hash,revoked_at,revocation_reason FROM selector_promotions WHERE id=?")
            .bind(id).fetch_optional(&self.pool).await?.ok_or_else(|| invalid("Promotion not found"))?;
        let certificate: Certificate = serde_json::from_str(row.try_get("artifact_json")?)?;
        let mut body = certificate.clone();
        body.artifact_hash.clear();
        if certificate.id != id
            || hash(&body)? != certificate.artifact_hash
            || row.try_get::<String, _>("artifact_hash")? != certificate.artifact_hash
        {
            return Err(invalid("Promotion integrity check failed"));
        }
        Ok(State {
            certificate,
            revoked_at: row.try_get("revoked_at")?,
            revocation_reason: row.try_get("revocation_reason")?,
        })
    }
    pub async fn require_active_promotion(&self, id: &str) -> Result<Certificate> {
        let state = self.promotion(id).await?;
        if state.revoked_at.is_some() {
            return Err(invalid("Promotion was revoked"));
        }
        // Inference reads no fit snapshot, controls, evaluators or run outcomes.
        // Full evidence validation happened when this certificate was issued.
        for frozen in &state.certificate.qualifications {
            let current = self
                .qualification_bindings(&frozen.version_id)
                .await?
                .into_iter()
                .find(|binding| binding.id == frozen.id)
                .ok_or_else(|| invalid("Promotion qualification authority disappeared"))?;
            if current.revoked_at.is_some()
                || current.status != "controls_verified_review_attested"
                || current.record_hash != frozen.record_hash
                || current.manifest_hash != frozen.manifest_hash
                || current.content_hash != frozen.content_hash
                || current.evaluator_revision != frozen.evaluator_revision
                || current.created_at != frozen.created_at
            {
                return Err(invalid("Promotion qualification authority changed"));
            }
        }
        let model = self.selector_model(&state.certificate.model_id).await?;
        if model.snapshot_hash != state.certificate.model_snapshot_hash {
            return Err(invalid("Promoted fit changed"));
        }
        for step in state.certificate.trajectory.iter().flat_map(|t| &t.steps) {
            if self.selector_model(&step.model_id).await?.snapshot_hash != step.model_snapshot_hash
            {
                return Err(invalid("A promoted class fit changed"));
            }
        }
        Ok(state.certificate)
    }
    pub async fn revoke_promotion(&self, id: &str, reason: &str) -> Result<State> {
        let gate = admission_gate();
        let _guard = gate.lock().await;
        if reason.trim().is_empty() || reason.len() > 4096 {
            return Err(invalid("Revocation needs a bounded reason"));
        }
        self.promotion(id).await?;
        sqlx::query("UPDATE selector_promotions SET revoked_at=?,revocation_reason=? WHERE id=? AND revoked_at IS NULL")
            .bind(now()).bind(reason).bind(id).execute(&self.pool).await?;
        self.promotion(id).await
    }
    /// The newest active certificate covering a work class, with the fitted
    /// model it certifies for that class. Ordinary chats, agents and waves of
    /// the class choose through it; their manual order stays the fallback.
    pub async fn class_certificate(
        &self,
        work_class: &str,
    ) -> Result<Option<(Certificate, String)>> {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM selector_promotions WHERE revoked_at IS NULL ORDER BY created_at DESC,id LIMIT 256",
        )
        .fetch_all(&self.pool)
        .await?;
        for id in ids {
            let state = self.promotion(&id).await?;
            let Some(model_id) = state
                .certificate
                .model_for_class(work_class)
                .map(str::to_owned)
            else {
                continue;
            };
            match self.require_active_promotion(&id).await {
                Ok(certificate) => return Ok(Some((certificate, model_id))),
                Err(error) if error.code == "invalid_promotion" => continue,
                Err(error) => return Err(error),
            }
        }
        Ok(None)
    }

    /// Learned selection state of every work class, for the places that show
    /// which model a class prefers.
    pub async fn class_policies(&self) -> Result<Vec<ClassPolicy>> {
        let mut policies: Vec<ClassPolicy> = super::routing::WORK_CLASSES
            .iter()
            .map(|class| ClassPolicy {
                work_class_id: (*class).to_owned(),
                certificate_id: None,
                certified_at: None,
                campaign_id: None,
                model_id: None,
                qualified_training: 0,
                qualified_held_out: 0,
                held_out_workflows: 0,
                fits: 0,
                campaigns: 0,
            })
            .collect();
        // Policies follow WORK_CLASSES order, so a class finds its row there.
        let index = |class: &str| {
            super::routing::WORK_CLASSES
                .iter()
                .position(|known| *known == class)
        };
        let mut counts = vec![(0usize, 0usize, 0usize); policies.len()];
        for definition in self.all_definitions().await? {
            let Some(version) = definition.versions.first() else {
                continue;
            };
            let Some(slot) = index(&version.manifest.work_class_id) else {
                continue;
            };
            if definition.archived {
                continue;
            }
            let qualified = self
                .qualification_bindings(&version.id)
                .await?
                .iter()
                .any(|binding| {
                    binding.revoked_at.is_none()
                        && binding.status == "controls_verified_review_attested"
                        && binding.content_hash == version.content_hash
                });
            if !qualified {
                continue;
            }
            match version.manifest.split.as_str() {
                "train" => counts[slot].0 += 1,
                "held_out" => {
                    counts[slot].1 += 1;
                    if version.manifest.workflow.is_some() {
                        counts[slot].2 += 1;
                    }
                }
                _ => {}
            }
        }
        let fits = self.selector_fits().await?;
        let fit_class: std::collections::BTreeMap<_, _> = fits
            .iter()
            .map(|fit| (fit.id.clone(), fit.work_class_id.clone()))
            .collect();
        for fit in &fits {
            if let Some(slot) = index(&fit.work_class_id) {
                policies[slot].fits += 1;
            }
        }
        for campaign in self.workflow_campaigns().await? {
            let request = &campaign.plan.request;
            let classes: BTreeSet<String> = if request.class_model_ids.is_empty() {
                fit_class
                    .get(&request.model_id)
                    .cloned()
                    .into_iter()
                    .collect()
            } else {
                request.class_model_ids.keys().cloned().collect()
            };
            for class in classes {
                if let Some(slot) = index(&class) {
                    policies[slot].campaigns += 1;
                }
            }
        }
        for (slot, policy) in policies.iter_mut().enumerate() {
            (
                policy.qualified_training,
                policy.qualified_held_out,
                policy.held_out_workflows,
            ) = counts[slot];
            if let Some((certificate, model_id)) =
                self.class_certificate(&policy.work_class_id).await?
            {
                policy.certificate_id = Some(certificate.id);
                policy.certified_at = Some(certificate.created_at);
                policy.campaign_id = Some(certificate.campaign_id);
                policy.model_id = Some(model_id);
            }
        }
        Ok(policies)
    }

    pub async fn promotions(&self) -> Result<Vec<State>> {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM selector_promotions ORDER BY created_at DESC,id LIMIT 256",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut values = Vec::new();
        for id in ids {
            values.push(self.promotion(&id).await?);
        }
        Ok(values)
    }
}

#[cfg(test)]
mod tests;
