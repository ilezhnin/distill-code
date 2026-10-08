//! Explicit research execution of a frozen policy over a complete workflow.
//! These trials do not promote a fit or contribute individual worker labels.
use super::{executor, fixtures, learned, routing, types::*, BenchmarkService};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowPolicy {
    pub model_id: String,
    /// `learned`, `aggregate`, `persona`, or `fixed`, with the same candidate pool.
    pub mode: String,
    pub candidates: Vec<Configuration>,
    pub prior_ids: Vec<String>,
    pub fixed_candidate_id: Option<String>,
    pub min_quality: f64,
}

fn invalid(message: &str) -> BenchmarkError {
    BenchmarkError::new("invalid_workflow_policy", message)
}

impl WorkflowPolicy {
    pub fn configuration(&self) -> Result<Configuration> {
        let digest = fixtures::hash(&serde_json::to_vec(self)?);
        Ok(Configuration {
            id: format!("workflow-policy:{digest}"),
            provider_id: "research-workflow".into(),
            account_id: None,
            model_id: self.mode.clone(),
            effort: None,
            fast_mode: None,
            billing_mode: "research_workflow".into(),
            execution_profile: "workflow_policy".into(),
            inventory_revision: Some(digest),
            model_name: Some(format!("Workflow policy: {}", self.mode)),
        })
    }

    pub(super) async fn validate(
        &self,
        service: &BenchmarkService,
        request: &RunRequest,
        versions: &[BenchmarkVersion],
    ) -> Result<()> {
        let model = service.store.selector_model(&self.model_id).await?;
        if self.mode == "aggregate"
            && self.prior_ids
                != super::workflow_campaign::aggregate_order(
                    &service.store.selector_fit(&self.model_id).await?,
                    &self.candidates,
                )?
        {
            return Err(invalid(
                "Aggregate preference must match the frozen fitted training snapshot",
            ));
        }
        let keys: BTreeSet<_> = self.candidates.iter().map(routing::candidate_key).collect();
        let ids: BTreeSet<_> = self.candidates.iter().map(|c| &c.id).collect();
        let prior: BTreeSet<_> = self.prior_ids.iter().collect();
        let fitted: BTreeSet<_> = model
            .candidates
            .iter()
            .map(|c| c.candidate_key.clone())
            .collect();
        if !matches!(
            self.mode.as_str(),
            "learned" | "aggregate" | "persona" | "fixed"
        ) || self
            .candidates
            .iter()
            .any(|c| c.id.trim().is_empty() || c.id.len() > 256)
            || self.candidates.len() != keys.len()
            || self.candidates.len() != ids.len()
            || keys != fitted
            || ids != prior
            || self.prior_ids.len() != prior.len()
            || self
                .fixed_candidate_id
                .as_ref()
                .is_some_and(|id| !ids.contains(id))
            || (self.mode == "fixed") != self.fixed_candidate_id.is_some()
            || !self.min_quality.is_finite()
            || !(0.0..=1.0).contains(&self.min_quality)
            || request.configurations != [self.configuration()?]
            || request.parallelism != Some(1)
            || versions.iter().any(|v| {
                v.manifest.workflow.is_none()
                    || v.manifest.work_class_id != model.work_class_id
                    || self.candidates.iter().any(|c| {
                        c.execution_profile != v.manifest.execution_profile
                            || routing::authored_by_candidate(&v.manifest, c)
                    })
            })
            || self.candidates.iter().any(|c| {
                model
                    .candidates
                    .iter()
                    .find(|m| m.candidate_key == routing::candidate_key(c))
                    .is_none_or(|m| m.configuration.inventory_revision != c.inventory_revision)
            })
        {
            return Err(invalid("Workflow research requires a stored fit, its exact candidate runtimes, complete preference order, objective workflow roots and one serial policy column"));
        }
        Ok(())
    }

    pub(super) async fn select(
        &self,
        service: &BenchmarkService,
        root: &Attempt,
        version: &BenchmarkVersion,
        index: usize,
    ) -> Result<executor::Decision> {
        let key = format!("workflow:{}:{index}", root.id);
        if let Some(record) = service.store.executor_decision(&key).await? {
            // A pending step keeps its committed choice after restart. Its
            // backend still checks exact selection before provider dispatch.
            if record.decision.request.context_id != self.configuration()?.id
                || record.decision.request.prediction.task
                    != learned::PublicTask::from(&version.manifest)
            {
                return Err(invalid("Saved workflow choice belongs to different inputs"));
            }
            return Ok(record.decision);
        }
        let mut inventories = BTreeMap::new();
        let mut candidates = Vec::new();
        for configuration in &self.candidates {
            let inventory_key = (
                configuration.provider_id.clone(),
                configuration.account_id.clone(),
            );
            if !inventories.contains_key(&inventory_key) {
                let inventory = service
                    .backend
                    .inventory(
                        &configuration.provider_id,
                        configuration.account_id.as_deref(),
                        false,
                    )
                    .await;
                inventories.insert(inventory_key.clone(), inventory);
            }
            let available = inventories[&inventory_key]
                .as_ref()
                .ok()
                .is_some_and(|rows| {
                    rows.iter().any(|row| {
                        row.available
                            && row.configuration.model_id == configuration.model_id
                            && row.configuration.execution_profile
                                == configuration.execution_profile
                            && row.configuration.inventory_revision
                                == configuration.inventory_revision
                            && configuration
                                .effort
                                .as_ref()
                                .is_none_or(|level| row.efforts.contains(level))
                            && (configuration.fast_mode != Some(true) || row.supports_fast_mode)
                    })
                })
                && service.backend.readiness(configuration).await.is_ok()
                && service
                    .backend
                    .activity(configuration)
                    .await
                    .is_ok_and(|activity| activity.active_sessions.is_empty())
                && service
                    .backend
                    .unsupported(configuration, &version.manifest)
                    .is_none();
            candidates.push(RoutingCandidate {
                configuration: configuration.clone(),
                available,
                reason: (!available).then(|| "Unavailable or changed worker runtime".into()),
            });
        }
        let mut request: executor::Request = executor::ApplicationRequest {
            request_key: key,
            surface: "benchmark".into(),
            context_id: self.configuration()?.id,
            task: learned::PublicTask::from(&version.manifest),
            target_family: version.manifest.task_family.clone(),
            target_group: version
                .manifest
                .environment
                .get("splitGroup")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&version.manifest.task_family)
                .into(),
            candidates,
            prior_ids: self.prior_ids.clone(),
            hard_candidate_id: self.fixed_candidate_id.clone(),
            model_id: Some(self.model_id.clone()),
            min_quality: self.min_quality,
        }
        .try_into()?;
        // Persona and fixed baselines are not influenced by predicted scores.
        if self.mode != "learned" {
            request.model_id = None;
        }
        service
            .store
            .prepare_workflow_research_decision(request, &self.mode)
            .await
    }
}

/// Native callers supply a policy, not a forged synthetic model column.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunRequest {
    pub request_key: String,
    pub version_ids: Vec<String>,
    pub policy: WorkflowPolicy,
    pub repetitions: u32,
    pub timeout_seconds: u32,
    pub max_executions: u32,
}

impl TryFrom<WorkflowRunRequest> for RunRequest {
    type Error = BenchmarkError;
    fn try_from(value: WorkflowRunRequest) -> Result<Self> {
        Ok(Self {
            configurations: vec![value.policy.configuration()?],
            workflow_policy: Some(value.policy),
            request_key: value.request_key,
            version_ids: value.version_ids,
            repetitions: value.repetitions,
            timeout_seconds: value.timeout_seconds,
            max_executions: value.max_executions,
            preview: false,
            parallelism: Some(1),
        })
    }
}
