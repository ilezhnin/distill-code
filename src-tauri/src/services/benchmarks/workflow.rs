//! Bounded workflows use fresh owned sessions and committed public step inputs.
use super::{
    fixtures,
    store::{event, now, Store},
    types::*,
    BenchmarkService,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Row;
use std::{collections::HashSet, time::Instant};
use tokio::sync::watch;

pub fn validate(draft: &BenchmarkDraft) -> Vec<String> {
    let Some(workflow) = &draft.workflow else {
        return Vec::new();
    };
    let mut issues = Vec::new();
    if ![1, 2].contains(&workflow.schema_version) || workflow.driver_revision.trim().is_empty() {
        issues.push("Workflow requires schema 1 and a frozen driver revision".into());
    }
    if !(2..=if workflow.schema_version == 2 { 5 } else { 4 }).contains(&workflow.steps.len()) {
        issues.push("A bounded workflow requires 2–4 steps".into());
    }
    if !matches!(
        draft.evaluator.kind.as_str(),
        "exact" | "json" | "javascript" | "browser" | "repository"
    ) {
        issues.push("A workflow requires a final objective evaluator".into());
    }
    let mut ids = HashSet::new();
    for (index, step) in workflow.steps.iter().enumerate() {
        if workflow.schema_version == 2 {
            if draft
                .environment
                .get("nativeBudgetRecipe")
                .and_then(serde_json::Value::as_str)
                != Some(super::artifact_context::CLOCK_RECIPE)
                || step.scope.as_ref().is_none_or(|scope| {
                    scope.role_id.trim().is_empty()
                        || scope.role_prompt.trim().is_empty()
                        || scope.role_prompt.len() > 64 * 1024
                        || !super::routing::WORK_CLASSES.contains(&scope.work_class_id.as_str())
                        || !matches!(
                            scope.purpose.as_str(),
                            "implement" | "review" | "closing_qa"
                        )
                        || scope.step_budget_seconds == 0
                        || scope.step_budget_seconds > draft.limits.timeout_seconds
                })
                || (index + 1 == workflow.steps.len()
                    && step.scope.as_ref().is_none_or(|scope| {
                        scope.purpose != "closing_qa" || !step.include_previous_output
                    }))
            {
                issues.push("Schema-2 workflows require native root wall accounting, exact role/class/step budgets and a final closing QA with artifact access".into());
            }
        } else if step.scope.is_some() {
            issues.push("Per-step roles require the versioned schema-2 workflow recipe".into());
        }
        if step.id.trim().is_empty() || step.id.len() > 128 || !ids.insert(&step.id) {
            issues.push("Workflow step IDs must be unique, nonempty and bounded".into());
        }
        if step.prompt.trim().is_empty() || step.prompt.len() > 64 * 1024 {
            issues.push("Workflow steps require a prompt of at most 64 KiB".into());
        }
        if index == 0 && step.include_previous_output {
            issues.push("The first workflow step has no previous output".into());
        }
    }
    issues
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StepDecision {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<super::executor::Decision>,
    pub root_attempt_id: String,
    pub root_decision_id: String,
    pub step_index: usize,
    pub driver_revision: String,
    pub snapshot: DecisionSnapshot,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_context: Option<NativeStepContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NativeStepContext {
    pub budget: super::artifact_context::BudgetLease,
    pub repository: Option<super::artifact_context::Input>,
}

impl StepDecision {
    fn hash(&self) -> Result<String> {
        let mut value = self.clone();
        value.content_hash.clear();
        Ok(fixtures::hash(&serde_json::to_vec(&value)?))
    }
}

pub(super) struct SavedStep {
    pub index: usize,
    pub id: String,
    pub parent_id: Option<String>,
    pub entry: EntryState,
    pub prompt: String,
    pub attempt: Attempt,
    pub decision: Option<StepDecision>,
    pub native_context: Option<NativeStepContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceStep {
    pub index: usize,
    pub id: String,
    pub parent_id: Option<String>,
    pub entry: EntryState,
    pub prompt: String,
    pub attempt: Attempt,
    pub input_hash: Option<String>,
    pub executor_decision: Option<super::executor::Decision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub root: Attempt,
    pub policy: Option<super::workflow_policy::WorkflowPolicy>,
    pub steps: Vec<TraceStep>,
}

impl Store {
    pub async fn workflow_trace(&self, root_id: &str) -> Result<Trace> {
        let root = self.attempt(root_id).await?;
        let is_root: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attempts WHERE id=?)")
            .bind(root_id)
            .fetch_one(&self.pool)
            .await?;
        if !is_root
            || self
                .version(&root.version_id)
                .await?
                .manifest
                .workflow
                .is_none()
        {
            return Err(BenchmarkError::new(
                "validation",
                "Select a workflow root attempt",
            ));
        }
        let policy = self.run(&root.run_id).await?.request.workflow_policy;
        let steps = saved_steps(self, root_id)
            .await?
            .into_iter()
            .map(|step| TraceStep {
                index: step.index,
                id: step.id,
                parent_id: step.parent_id,
                entry: step.entry,
                prompt: step.prompt,
                attempt: step.attempt,
                input_hash: step.decision.as_ref().map(|d| d.content_hash.clone()),
                executor_decision: step.decision.and_then(|d| d.executor),
            })
            .collect();
        Ok(Trace {
            root,
            policy,
            steps,
        })
    }
}

impl SavedStep {
    pub(super) fn validate_decision(&self, root_id: &str) -> Result<()> {
        let Some(record) = &self.decision else {
            return Ok(());
        };
        let snapshot = &record.snapshot;
        let configuration = &self.attempt.configuration;
        // Every check names itself, so a refusal says what changed.
        let checks = [
            ("schema", snapshot.schema_version == 1),
            ("content hash", record.content_hash == record.hash()?),
            ("root", record.root_attempt_id == root_id),
            ("step index", record.step_index == self.index),
            (
                "native context",
                record.native_context == self.native_context,
            ),
            ("root decision", !record.root_decision_id.is_empty()),
            ("run", snapshot.run_id == self.attempt.run_id),
            ("version", snapshot.version_id == self.attempt.version_id),
            ("prompt", snapshot.public_prompt == self.prompt),
            ("entry", snapshot.entry_state.as_ref() == Some(&self.entry)),
            (
                "entry identity",
                self.entry.root_task_id == root_id
                    && self.entry.step_id == self.id
                    && self.entry.parent_step_id == self.parent_id,
            ),
            (
                "entry hash",
                self.entry.content_hash == super::routing::entry_hash(&self.entry),
            ),
            (
                "selection provenance",
                snapshot.selection_provenance
                    == if record.executor.is_some() {
                        "workflow_research_policy_v1"
                    } else {
                        "workflow_root_pin_v1"
                    },
            ),
            (
                "executor decision",
                record.executor.as_ref().is_none_or(|d| {
                    d.request.surface == "benchmark"
                        && d.request.request_key == format!("workflow:{root_id}:{}", self.index)
                        && d.chosen.as_ref() == Some(configuration)
                        && d.request.prediction.task.prompt == self.prompt
                }),
            ),
            (
                "executor decision time",
                record
                    .executor
                    .as_ref()
                    .is_none_or(|d| d.created_at <= snapshot.created_at),
            ),
            (
                "configuration",
                snapshot.request.configurations == [configuration.clone()]
                    && snapshot.constraints.hard_candidate_key.as_deref()
                        == Some(super::routing::candidate_key(configuration).as_str()),
            ),
            (
                "start time",
                self.attempt
                    .started_at
                    .is_none_or(|at| snapshot.created_at <= at),
            ),
        ];
        let changed: Vec<_> = checks
            .iter()
            .filter(|(_, holds)| !holds)
            .map(|(name, _)| *name)
            .collect();
        if !changed.is_empty() {
            return Err(BenchmarkError::new(
                "evidence_mismatch",
                format!(
                    "Workflow input or selection no longer matches its committed pre-dispatch decision ({})",
                    changed.join(", ")
                ),
            ));
        }
        Ok(())
    }
}

pub(super) async fn saved_steps(store: &Store, root_id: &str) -> Result<Vec<SavedStep>> {
    let rows = sqlx::query("SELECT step_index,step_id,parent_step_id,entry_state_json,prompt,data_json,decision_json FROM workflow_steps WHERE root_attempt_id=? ORDER BY step_index")
        .bind(root_id).fetch_all(&store.pool).await?;
    let steps: Vec<SavedStep> = rows
        .into_iter()
        .map(|row| {
            let decision: Option<StepDecision> = row
                .get::<Option<&str>, _>(6)
                .map(serde_json::from_str)
                .transpose()?;
            let step = SavedStep {
                index: row.get::<i64, _>(0) as usize,
                id: row.get(1),
                parent_id: row.get(2),
                entry: serde_json::from_str(row.get(3))?,
                prompt: row.get(4),
                attempt: serde_json::from_str(row.get(5))?,
                native_context: decision
                    .as_ref()
                    .and_then(|record| record.native_context.clone()),
                decision,
            };
            step.validate_decision(root_id)?;
            Ok(step)
        })
        .collect::<Result<_>>()?;
    for step in &steps {
        if let Some(decision) = step.decision.as_ref().and_then(|d| d.executor.as_ref()) {
            let saved = store
                .executor_decision(&decision.request.request_key)
                .await?
                .ok_or_else(|| {
                    BenchmarkError::new("evidence_missing", "Workflow executor decision is missing")
                })?;
            if saved.decision.artifact_hash != decision.artifact_hash {
                return Err(BenchmarkError::new(
                    "evidence_mismatch",
                    "Workflow executor decision changed",
                ));
            }
        }
    }
    if steps
        .iter()
        .any(|s| s.decision.as_ref().is_some_and(|d| d.executor.is_some()))
    {
        let root = store.attempt(root_id).await?;
        let version = store.version(&root.version_id).await?;
        let policy = store
            .run(&root.run_id)
            .await?
            .request
            .workflow_policy
            .ok_or_else(|| {
                BenchmarkError::new("evidence_mismatch", "Research workflow policy is missing")
            })?;
        let configuration = policy.configuration()?;
        for step in &steps {
            let selection = step
                .decision
                .as_ref()
                .and_then(|d| d.executor.as_ref())
                .ok_or_else(|| {
                    BenchmarkError::new(
                        "evidence_missing",
                        "Research workflow selection is missing",
                    )
                })?;
            if root.configuration != configuration
                || selection.request.context_id != configuration.id
                || selection.request.prediction.task
                    != super::learned::PublicTask::from(&step_version(&version, step).manifest)
            {
                return Err(BenchmarkError::new(
                    "evidence_mismatch",
                    "Research workflow inputs no longer match the frozen policy",
                ));
            }
        }
    }
    Ok(steps)
}

/// Recovery uses the same immutable pre-dispatch input record as collection.
/// Original version metadata alone cannot reconstruct a cumulative child.
pub(super) async fn effective_version_for_attempt(
    store: &Store,
    attempt: &Attempt,
) -> Result<BenchmarkVersion> {
    let root = sqlx::query_scalar::<_, String>(
        "SELECT root_attempt_id FROM workflow_steps WHERE attempt_id=?",
    )
    .bind(&attempt.id)
    .fetch_optional(&store.pool)
    .await?;
    let version = store.version(&attempt.version_id).await?;
    let Some(root) = root else {
        return Ok(version);
    };
    let step = saved_steps(store, &root)
        .await?
        .into_iter()
        .find(|step| step.attempt.id == attempt.id)
        .ok_or_else(|| {
            BenchmarkError::new("evidence_missing", "Native child input record is absent")
        })?;
    if step.attempt.run_id != attempt.run_id
        || step.attempt.version_id != attempt.version_id
        || step.attempt.configuration != attempt.configuration
    {
        return Err(BenchmarkError::new(
            "evidence_mismatch",
            "Native child recovery belongs to another frozen input or worker",
        ));
    }
    Ok(step_version(&version, &step))
}

fn step_entry(
    root: &Attempt,
    draft: &BenchmarkDraft,
    index: usize,
    remaining: u32,
    previous: Option<&str>,
) -> Result<EntryState> {
    let workflow = draft
        .workflow
        .as_ref()
        .ok_or_else(|| BenchmarkError::new("validation", "Workflow is absent"))?;
    let step = &workflow.steps[index];
    let declared = draft.entry_state.as_ref();
    let mut reports = declared
        .map(|entry| entry.previous_reports.clone())
        .unwrap_or_default();
    if step.include_previous_output {
        reports.push(
            previous
                .ok_or_else(|| {
                    BenchmarkError::new(
                        "evidence_missing",
                        "The declared previous step output is missing",
                    )
                })?
                .into(),
        );
    }
    let mut entry = EntryState {
        schema_version: 1,
        root_task_id: root.id.clone(),
        step_id: step.id.clone(),
        parent_step_id: index.checked_sub(1).map(|i| workflow.steps[i].id.clone()),
        fixture_snapshot_hash: fixtures::hash(serde_json::to_vec(&draft.fixtures)?.as_slice()),
        conversation_prefix: declared
            .map(|entry| entry.conversation_prefix.clone())
            .unwrap_or_default(),
        previous_reports: reports,
        remaining_budget_seconds: remaining,
        content_hash: String::new(),
    };
    entry.content_hash = super::routing::entry_hash(&entry);
    Ok(entry)
}

async fn prepare_step(
    service: &BenchmarkService,
    root: &Attempt,
    version: &BenchmarkVersion,
    index: usize,
    remaining: u32,
    previous: Option<&str>,
    native_reports: Option<Vec<String>>,
) -> Result<SavedStep> {
    let store = &service.store;
    let workflow = version.manifest.workflow.as_ref().unwrap();
    let spec = &workflow.steps[index];
    let mut entry = step_entry(root, &version.manifest, index, remaining, previous)?;
    let new_clock = version
        .manifest
        .environment
        .get("nativeBudgetRecipe")
        .and_then(serde_json::Value::as_str)
        == Some(super::artifact_context::CLOCK_RECIPE);
    let budget = if new_clock {
        let origin = root.started_at.ok_or_else(|| {
            BenchmarkError::new(
                "budget_clock_conflict",
                "Native workflow root clock is absent",
            )
        })?;
        let root_budget = super::artifact_context::BudgetLease {
            recipe: super::artifact_context::CLOCK_RECIPE.into(),
            root_id: root.id.clone(),
            root_started_at_ms: origin,
            root_cap_seconds: store.run(&root.run_id).await?.request.timeout_seconds,
            step_key: format!("workflow-root:{}", root.id),
            step_started_at_ms: origin,
            step_cap_seconds: store.run(&root.run_id).await?.request.timeout_seconds,
        };
        Some(
            store
                .reserve_task_budget(
                    &format!("workflow:{}:{index}", root.id),
                    &fixtures::hash(&serde_json::to_vec(&(
                        &root.id,
                        &version.content_hash,
                        index,
                        spec,
                    ))?),
                    &version.content_hash,
                    Some(&root_budget),
                    root_budget.root_cap_seconds,
                    // A run may set a shorter time limit than the case; no step
                    // allowance can then exceed the root it belongs to.
                    spec.scope
                        .as_ref()
                        .map_or(version.manifest.limits.timeout_seconds, |scope| {
                            scope.step_budget_seconds
                        })
                        .min(root_budget.root_cap_seconds),
                    &root.id,
                )
                .await?,
        )
    } else {
        None
    };
    let mut repository_context = None;
    if version.manifest.execution_profile == "protected_repository" && new_clock {
        let snapshot = super::repository::snapshot(&version.manifest)?;
        let mut lineage = vec![];
        for prior in saved_steps(store, &root.id).await? {
            let result = prior.attempt.repository_result.as_ref().ok_or_else(|| {
                BenchmarkError::new(
                    "evidence_missing",
                    "Native workflow predecessor has no sealed cumulative artifact",
                )
            })?;
            result.validate(version.manifest.limits.max_artifact_bytes as usize)?;
            if prior
                .native_context
                .as_ref()
                .and_then(|context| context.repository.as_ref())
                .is_none_or(|input| !input.access_all)
            {
                lineage.clear();
            }
            lineage.push(result.artifact.clone());
        }
        let package = super::repository::advance_until(
            &snapshot,
            &lineage,
            spec.include_previous_output,
            version.manifest.limits.max_artifact_bytes as usize,
            budget
                .as_ref()
                .unwrap()
                .deadline_at_ms()?
                .try_into()
                .map_err(|_| {
                    BenchmarkError::new("budget_clock_conflict", "Native deadline is invalid")
                })?,
        )
        .await?;
        repository_context = Some(super::artifact_context::Input {
            before: package.artifact,
            lineage,
            access_all: spec.include_previous_output,
        });
    }
    if let Some(budget) = &budget {
        entry.remaining_budget_seconds = budget.remaining_seconds(now())?;
    }
    if spec.include_previous_output {
        if let Some(reports) = native_reports {
            entry.previous_reports = reports;
        }
    }
    // The hash covers the entry as committed. The budget measured just above
    // can be a second below the one `step_entry` hashed when a second passed
    // in between, so it is always computed again here.
    entry.content_hash = super::routing::entry_hash(&entry);
    let prompt = format!(
        "{}\n\nWorkflow step {} of {} ({}):\n{}",
        version.manifest.prompt,
        index + 1,
        workflow.steps.len(),
        spec.id,
        spec.prompt
    );
    let public_bytes = prompt.len()
        + version.manifest.role_prompt.len()
        + entry.conversation_prefix.len()
        + entry
            .previous_reports
            .iter()
            .map(String::len)
            .sum::<usize>()
        + version
            .manifest
            .fixtures
            .iter()
            .map(|f| f.path.len() + f.content.len() + 20)
            .sum::<usize>();
    if public_bytes > 256 * 1024 {
        return Err(BenchmarkError::new(
            "budget_reached",
            "Declared workflow feedback exceeds the native public context cap",
        ));
    }
    let mut child = root.clone();
    child.id = fixtures::hash(format!("workflow-v1:{}:{index}", root.id).as_bytes());
    child.phase = "pending".into();
    child.outcome = None;
    child.reason = None;
    child.session_id = None;
    child.host_run_id = None;
    child.observed = None;
    child.started_at = None;
    child.finished_at = None;
    child.duration_ms = None;
    child.native_execution_ms = None;
    child.output = None;
    child.evidence_hash = None;
    child.usage = TokenUsage::default();
    child.resolved_model = None;
    child.evaluations.clear();
    child.event_cursor = 0;
    child.workflow_steps.clear();
    child.repository_result = None;
    let mut saved = SavedStep {
        index,
        id: spec.id.clone(),
        parent_id: entry.parent_step_id.clone(),
        entry,
        prompt,
        attempt: child,
        decision: None,
        native_context: budget.map(|budget| NativeStepContext {
            budget,
            repository: repository_context,
        }),
    };
    let policy = store.run(&root.run_id).await?.request.workflow_policy;
    let executor = if let Some(policy) = &policy {
        let selected = policy
            .select(service, root, &step_version(version, &saved), index)
            .await?;
        saved.attempt.configuration = selected.chosen.clone().ok_or_else(|| {
            BenchmarkError::new(
                "no_available_worker",
                "No eligible worker for the frozen workflow policy",
            )
        })?;
        Some(selected)
    } else {
        None
    };
    let mut tx = store.pool.begin().await?;
    let root_decision: String = sqlx::query_scalar(
        "SELECT data_json FROM decision_snapshots WHERE run_id=? AND version_id=?",
    )
    .bind(&root.run_id)
    .bind(&version.id)
    .fetch_one(&mut *tx)
    .await?;
    let root_decision: DecisionSnapshot = serde_json::from_str(&root_decision)?;
    let mut request = root_decision.request.clone();
    request.configurations = vec![saved.attempt.configuration.clone()];
    request.workflow_policy = None;
    request.version_ids = vec![version.id.clone()];
    request.timeout_seconds = remaining;
    request.repetitions = 1;
    request.max_executions = 1;
    let mut snapshot =
        super::routing::snapshot(&root.run_id, &step_version(version, &saved), &request);
    snapshot.selection_provenance = if executor.is_some() {
        "workflow_research_policy_v1"
    } else {
        "workflow_root_pin_v1"
    }
    .into();
    snapshot.candidates[0].reason = Some(if executor.is_some() {
        "Committed research policy choice; availability and fallback are in the linked executor decision"
    } else {
        "Pinned by the root attempt; fresh provider admission is checked separately, no alternative worker was selected"
    }.into());
    let mut decision = StepDecision {
        executor,
        root_attempt_id: root.id.clone(),
        root_decision_id: root_decision.id,
        step_index: index,
        driver_revision: workflow.driver_revision.clone(),
        snapshot,
        content_hash: String::new(),
        native_context: saved.native_context.clone(),
    };
    decision.content_hash = decision.hash()?;
    saved.decision = Some(decision);
    saved.validate_decision(&root.id)?;
    sqlx::query("INSERT INTO workflow_steps(attempt_id,root_attempt_id,step_index,step_id,parent_step_id,entry_state_hash,entry_state_json,prompt,phase,data_json,decision_json) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)")
        .bind(&saved.attempt.id).bind(&root.id).bind(index as i64).bind(&saved.id).bind(&saved.parent_id)
        .bind(&saved.entry.content_hash).bind(serde_json::to_string(&saved.entry)?).bind(&saved.prompt)
        .bind(serde_json::to_string(&saved.attempt)?).bind(serde_json::to_string(saved.decision.as_ref().unwrap())?)
        .execute(&mut *tx).await?;
    event(&mut tx, &root.run_id, "workflow_step_prepared").await?;
    tx.commit().await?;
    Ok(saved)
}

fn step_version(version: &BenchmarkVersion, saved: &SavedStep) -> BenchmarkVersion {
    let mut result = version.clone();
    result.manifest.workflow = None;
    result.manifest.prompt = saved.prompt.clone();
    result.manifest.entry_state = Some(saved.entry.clone());
    if let Some(scope) = version
        .manifest
        .workflow
        .as_ref()
        .and_then(|workflow| workflow.steps.get(saved.index))
        .and_then(|step| step.scope.as_ref())
    {
        result.manifest.role_id = Some(scope.role_id.clone());
        result.manifest.role_prompt = scope.role_prompt.clone();
        result.manifest.work_class_id = scope.work_class_id.clone();
        result.manifest.limits.timeout_seconds = scope.step_budget_seconds;
    }
    if let Some(context) = &saved.native_context {
        result.manifest.environment[super::artifact_context::CLOCK_KEY] =
            serde_json::to_value(&context.budget).expect("native budget");
        if let Some(input) = &context.repository {
            result.manifest.environment[super::artifact_context::INPUT_KEY] =
                serde_json::to_value(input).expect("native artifact input");
        }
    }
    result
}

fn aggregate(root: &mut Attempt, steps: &[SavedStep]) {
    root.workflow_steps = steps
        .iter()
        .map(|step| WorkflowStepEvidence {
            root_task_id: root.id.clone(),
            step_id: step.id.clone(),
            parent_step_id: step.parent_id.clone(),
            entry_state_hash: step.entry.content_hash.clone(),
            attempt_id: step.attempt.id.clone(),
            session_id: step.attempt.session_id.clone(),
            host_run_id: step.attempt.host_run_id.clone(),
            evidence_hash: step.attempt.evidence_hash.clone(),
            outcome: step.attempt.outcome.clone(),
        })
        .collect();
    let executed: Vec<_> = steps
        .iter()
        .filter(|step| step.attempt.started_at.is_some())
        .collect();
    let sum = |field: fn(&TokenUsage) -> Option<u64>| {
        executed.iter().try_fold(0u64, |total, step| {
            field(&step.attempt.usage).and_then(|value| total.checked_add(value))
        })
    };
    root.usage = if executed.is_empty() {
        TokenUsage::default()
    } else {
        TokenUsage {
            input: sum(|u| u.input),
            output: sum(|u| u.output),
            cache_read: sum(|u| u.cache_read),
            cache_write: sum(|u| u.cache_write),
            reasoning: sum(|u| u.reasoning),
            cost: executed.iter().try_fold(0.0, |total, step| {
                step.attempt.usage.cost.map(|value| total + value)
            }),
            schema: "workflow_sum_v1".into(),
        }
    };
    root.duration_ms = if executed.is_empty() {
        None
    } else {
        executed.iter().try_fold(0u64, |total, step| {
            step.attempt
                .duration_ms
                .and_then(|value| total.checked_add(value))
        })
    };
    root.native_execution_ms = if executed.is_empty() {
        None
    } else {
        executed.iter().try_fold(0u64, |sum, step| {
            step.attempt
                .native_execution_ms
                .and_then(|ms| sum.checked_add(ms))
        })
    };
    // A root-pinned workflow names its most recent worker. Research policies
    // clear that single-worker attribution below and retain the step records.
    root.resolved_model = executed
        .iter()
        .rev()
        .find_map(|step| step.attempt.resolved_model.clone());
    if let Some(last) = executed.last() {
        let first_step = executed
            .iter()
            .filter_map(|step| step.attempt.started_at)
            .min();
        root.started_at = if root.configuration.execution_profile == "workflow_policy"
            || steps.iter().any(|step| step.native_context.is_some())
        {
            root.started_at.into_iter().chain(first_step).min()
        } else {
            first_step
        };
        root.session_id = last.attempt.session_id.clone();
        root.host_run_id = last.attempt.host_run_id.clone();
        root.observed = last.attempt.observed.clone();
        root.event_cursor = last.attempt.event_cursor;
    }
    if let Some(auxiliary) = executed
        .iter()
        .find(|step| step.attempt.usage.schema == "provider_turn_with_auxiliary_v2")
    {
        root.usage.schema = "workflow_sum_with_auxiliary_v2".into();
        if root.observed.is_none() {
            root.observed = auxiliary.attempt.observed.clone();
        }
        if let Some(observed) = root.observed.as_mut() {
            observed.execution_profile = "native_text_auxiliary".into();
        }
    }
    if root.configuration.execution_profile == "workflow_policy" {
        // No single executor produced this result. Each step keeps its own
        // observed configuration, and the root remains a policy measurement.
        root.observed = None;
        root.resolved_model = None;
    }
}

async fn seal_root(store: &Store, root: &mut Attempt, steps: &[SavedStep]) -> Result<()> {
    aggregate(root, steps);
    root.finished_at = steps
        .iter()
        .filter_map(|step| step.attempt.finished_at)
        .max()
        .or_else(|| Some(now()));
    if root.configuration.execution_profile == "workflow_policy" {
        // Whole-trajectory wall time includes selection and orchestration.
        // duration_ms separately retains the sum of measured worker durations.
        root.finished_at = Some(now());
    }
    root.evidence_hash = Some(
        fixtures::seal(
            &store.root,
            root,
            &json!({"driver":"bounded-workflow-v1","steps":root.workflow_steps}),
        )
        .await?,
    );
    store.save_attempt(root).await
}

fn stop_with_child(root: &mut Attempt, child: &Attempt) {
    root.output = child.output.clone();
    root.outcome = child.outcome.clone();
    root.reason = child.reason.clone();
    root.phase = "collecting".into();
}

fn prefix_violation(steps: &[SavedStep], budget_ms: u64) -> Option<(&'static str, &'static str)> {
    let completed: Vec<_> = steps
        .iter()
        .filter(|step| step.attempt.outcome.as_deref() == Some("completed"))
        .collect();
    if completed
        .iter()
        .any(|s| s.decision.as_ref().is_some_and(|d| d.executor.is_some()))
    {
        if completed.iter().any(|s| {
            s.attempt.observed.as_ref().is_none_or(|observed| {
                super::routing::candidate_key(observed)
                    != super::routing::candidate_key(&s.attempt.configuration)
                    || observed.inventory_revision != s.attempt.configuration.inventory_revision
            })
        }) {
            return Some((
                "selection_changed",
                "A workflow worker did not acknowledge its committed selection",
            ));
        }
    } else if let Some(first) = completed.first() {
        if first.attempt.observed.is_none()
            || completed
                .iter()
                .any(|step| step.attempt.observed != first.attempt.observed)
        {
            return Some((
                "selection_changed",
                "The acknowledged configuration changed between workflow steps",
            ));
        }
    }
    let observed_duration = steps.iter().fold(0u64, |sum, step| {
        sum.saturating_add(step.attempt.duration_ms.unwrap_or(0))
    });
    (observed_duration > budget_ms).then_some((
        "budget_timeout",
        "Workflow exceeded its shared duration budget",
    ))
}

/// Execute only never-dispatched steps; the native backend owns each turn's acceptance boundary.
pub(super) fn remaining_seconds(cap: u32, elapsed_ms: u64) -> Option<u32> {
    let remaining = (u64::from(cap) * 1000).saturating_sub(elapsed_ms);
    (remaining > 0).then(|| remaining.div_ceil(1000) as u32)
}

pub(super) fn committed_report(output: &str) -> String {
    serde_json::to_string(&json!({"outcome":"completed","output":output}))
        .expect("public string report")
}

pub async fn execute(
    service: &BenchmarkService,
    mut root: Attempt,
    version: BenchmarkVersion,
    timeout: u32,
    cancel: watch::Receiver<bool>,
) -> Result<Attempt> {
    let issues = validate(&version.manifest);
    if !issues.is_empty() {
        return Err(BenchmarkError::new("validation", issues.join("; ")));
    }
    let count = version
        .manifest
        .workflow
        .as_ref()
        .ok_or_else(|| BenchmarkError::new("validation", "Workflow is absent"))?
        .steps
        .len();
    let new_clock = version
        .manifest
        .environment
        .get("nativeBudgetRecipe")
        .and_then(serde_json::Value::as_str)
        == Some(super::artifact_context::CLOCK_RECIPE);
    if new_clock {
        let key = format!("workflow-root:{}", root.id);
        let old = service.store.native_budget(&key).await?;
        let origin = old
            .as_ref()
            .map(|lease| lease.root_started_at_ms)
            .or(root.started_at)
            .unwrap_or_else(now);
        root.started_at = Some(origin);
        service.store.save_attempt(&root).await?;
        let lease = super::artifact_context::BudgetLease {
            recipe: super::artifact_context::CLOCK_RECIPE.into(),
            root_id: root.id.clone(),
            root_started_at_ms: origin,
            root_cap_seconds: timeout,
            step_key: key.clone(),
            step_started_at_ms: origin,
            step_cap_seconds: timeout,
        };
        if let Err(error) = service
            .store
            .reserve_task_budget(
                &key,
                &fixtures::hash(&serde_json::to_vec(&(
                    &root.id,
                    &version.content_hash,
                    timeout,
                ))?),
                &version.content_hash,
                Some(&lease),
                timeout,
                timeout,
                &root.id,
            )
            .await
        {
            if error.code != "budget_timeout" {
                return Err(error);
            }
            root.phase = "collecting".into();
            root.outcome = Some(error.code);
            root.reason = Some(error.message);
            let steps = saved_steps(&service.store, &root.id).await?;
            seal_root(&service.store, &mut root, &steps).await?;
            return Ok(root);
        }
    }
    let mut steps = saved_steps(&service.store, &root.id).await?;
    let consumed = steps
        .iter()
        .filter(|s| s.attempt.phase == "terminal")
        .try_fold(0u64, |sum, step| {
            step.attempt.duration_ms.and_then(|ms| sum.checked_add(ms))
        });
    let start = Instant::now();
    // The run's limit bounds the steps together; the case's own limit is the
    // least a run must allow, never a stop.
    let budget_ms = u64::from(timeout) * 1000;
    if let Some((code, reason)) = prefix_violation(&steps, budget_ms) {
        root.outcome = Some(code.into());
        root.reason = Some(reason.into());
        root.phase = "collecting".into();
        seal_root(&service.store, &mut root, &steps).await?;
        return Ok(root);
    }
    for index in 0..count {
        let run_state: String = sqlx::query_scalar("SELECT state FROM run_plans WHERE id=?")
            .bind(&root.run_id)
            .fetch_one(&service.store.pool)
            .await?;
        if *cancel.borrow() || matches!(run_state.as_str(), "cancelling" | "cancelled") {
            root.outcome = Some("cancelled".into());
            root.reason = Some("Workflow cancelled before the next step".into());
            break;
        }
        if let Some(existing) = steps.get(index) {
            if existing.index != index {
                return Err(BenchmarkError::new(
                    "evidence_missing",
                    "Workflow step sequence is incomplete",
                ));
            }
            if existing.attempt.phase == "terminal" {
                if existing.attempt.outcome.as_deref() != Some("completed") {
                    stop_with_child(&mut root, &existing.attempt);
                    break;
                }
                if index + 1 == count {
                    stop_with_child(&mut root, &existing.attempt);
                }
                continue;
            }
            if existing.attempt.phase != "pending" {
                return Err(BenchmarkError::new(
                    "dispatch_uncertain",
                    "A previously admitted workflow step requires reconciliation",
                ));
            }
        }
        let native_elapsed = steps
            .iter()
            .filter(|step| step.attempt.phase == "terminal")
            .try_fold(0u64, |sum, step| {
                step.attempt
                    .native_execution_ms
                    .and_then(|ms| sum.checked_add(ms))
            });
        let remaining_ms = budget_ms
            .saturating_sub(consumed.unwrap_or(budget_ms))
            .saturating_sub(start.elapsed().as_millis() as u64);
        let remaining = if new_clock {
            // Exhaustion is the timeout outcome; a clock that moved backwards
            // is a conflict to surface, never a recorded budget timeout.
            match super::artifact_context::remaining_seconds(
                root.started_at.unwrap(),
                now(),
                timeout,
            ) {
                Ok(seconds) => seconds,
                Err(error) if error.code == "budget_timeout" => 0,
                Err(error) => return Err(error),
            }
        } else if let Some(elapsed) = native_elapsed {
            remaining_seconds(timeout, elapsed).unwrap_or(0)
        } else {
            remaining_ms.div_ceil(1000) as u32
        };
        if remaining == 0 {
            root.outcome = Some("budget_timeout".into());
            root.reason = Some("Workflow exhausted its shared duration budget".into());
            break;
        }
        if steps.len() == index {
            let native_report = if native_elapsed.is_some() {
                steps
                    .last()
                    .and_then(|s| {
                        s.attempt
                            .repository_result
                            .as_ref()
                            .map(|result| result.report.as_str())
                            .or(s.attempt.output.as_deref())
                    })
                    .map(committed_report)
            } else {
                None
            };
            let previous = native_report
                .as_deref()
                .or_else(|| steps.last().and_then(|s| s.attempt.output.as_deref()));
            let native_reports = native_elapsed.map(|_| {
                steps
                    .iter()
                    .filter_map(|step| {
                        step.attempt
                            .repository_result
                            .as_ref()
                            .map(|result| result.report.as_str())
                            .or(step.attempt.output.as_deref())
                    })
                    .map(committed_report)
                    .collect()
            });
            let prepared = prepare_step(
                service,
                &root,
                &version,
                index,
                remaining,
                previous,
                native_reports,
            )
            .await;
            match prepared {
                Ok(step) => steps.push(step),
                Err(error) if error.code == "budget_timeout" => {
                    root.outcome = Some(error.code);
                    root.reason = Some(error.message);
                    break;
                }
                Err(error) => return Err(error),
            }
            aggregate(&mut root, &steps);
            service.store.save_attempt(&root).await?;
        }
        let saved = &mut steps[index];
        saved.attempt.phase = "preparing".into();
        saved.attempt.started_at = Some(now());
        service.store.save_attempt(&saved.attempt).await?;
        let effective_version = step_version(&version, saved);
        let result = if root.configuration.execution_profile == "workflow_policy" {
            service
                .execute_workflow_policy_step(
                    &root.id,
                    saved.attempt.clone(),
                    effective_version,
                    remaining.min(saved.entry.remaining_budget_seconds),
                    cancel.clone(),
                )
                .await
        } else {
            service
                .backend
                .execute(
                    &service.store,
                    saved.attempt.clone(),
                    effective_version,
                    remaining.min(saved.entry.remaining_budget_seconds),
                    cancel.clone(),
                )
                .await
        };
        match result {
            Ok(mut completed) => {
                completed.phase = "terminal".into();
                saved.attempt = completed;
            }
            Err(error)
                if root.configuration.execution_profile == "workflow_policy"
                    && !matches!(
                        error.code.as_str(),
                        "dispatch_uncertain" | "storage_unavailable"
                    ) =>
            {
                // A research trajectory records its actual unavailable/quota
                // outcome. It cannot silently move accounts or retry a worker.
                saved.attempt = service.store.attempt(&saved.attempt.id).await?;
                saved.attempt.phase = "terminal".into();
                saved.attempt.outcome = Some(error.code);
                saved.attempt.reason = Some(error.message);
                saved.attempt.finished_at = Some(now());
            }
            Err(error) if error.code == "account_busy" => {
                saved.attempt = service.store.attempt(&saved.attempt.id).await?;
                saved.attempt.phase = "pending".into();
                saved.attempt.started_at = None;
                service.store.save_attempt(&saved.attempt).await?;
                return Err(error);
            }
            Err(error)
                if matches!(
                    error.code.as_str(),
                    "dispatch_uncertain" | "storage_unavailable"
                ) =>
            {
                return Err(error)
            }
            Err(error) => {
                saved.attempt = service.store.attempt(&saved.attempt.id).await?;
                // A step the provider never saw waits in the queue with its
                // workflow, as a single turn would.
                if super::runner::returns_to_queue(&error.code, &saved.attempt.phase) {
                    super::runner::requeue(&mut saved.attempt, error.message.clone());
                    service.store.save_attempt(&saved.attempt).await?;
                    return Err(error);
                }
                saved.attempt.phase = "terminal".into();
                saved.attempt.outcome = Some(error.code);
                saved.attempt.reason = Some(error.message);
                saved.attempt.finished_at = Some(now());
            }
        }
        service.store.save_attempt(&saved.attempt).await?;
        let failed = saved.attempt.outcome.as_deref() != Some("completed");
        if failed || index + 1 == count {
            stop_with_child(&mut root, &saved.attempt);
        }
        aggregate(&mut root, &steps);
        service.store.save_attempt(&root).await?;
        if failed {
            break;
        }
        if let Some((code, reason)) = prefix_violation(&steps, budget_ms) {
            root.outcome = Some(code.into());
            root.reason = Some(reason.into());
            break;
        }
        if native_elapsed.is_none()
            && consumed
                .unwrap_or(budget_ms)
                .saturating_add(start.elapsed().as_millis() as u64)
                > budget_ms
        {
            root.outcome = Some("budget_timeout".into());
            root.reason = Some("Workflow exceeded its shared duration budget".into());
            break;
        }
    }
    root.phase = "collecting".into();
    seal_root(&service.store, &mut root, &steps).await?;
    Ok(root)
}

/// Restore observations only. Undispatched continuation waits for an explicit run resume.
pub async fn recover(
    service: &BenchmarkService,
    mut root: Attempt,
    version: BenchmarkVersion,
) -> Result<Option<Attempt>> {
    if root.evidence_hash.is_some()
        && root
            .outcome
            .as_deref()
            .is_some_and(|outcome| !matches!(outcome, "interrupted" | "dispatch_uncertain"))
    {
        root.phase = "collecting".into();
        return Ok(Some(root));
    }
    let count = version
        .manifest
        .workflow
        .as_ref()
        .ok_or_else(|| BenchmarkError::new("validation", "Workflow is absent"))?
        .steps
        .len();
    let mut steps = saved_steps(&service.store, &root.id).await?;
    for saved in &mut steps {
        if saved.attempt.phase == "pending"
            || (saved.attempt.phase == "terminal"
                && saved.attempt.outcome.as_deref() != Some("dispatch_uncertain"))
        {
            continue;
        }
        let result = service
            .backend
            .recover(&service.store, saved.attempt.clone())
            .await?;
        match result {
            Some(mut recovered) => {
                recovered.phase = "terminal".into();
                saved.attempt = recovered;
            }
            None => {
                saved.attempt.phase = "terminal".into();
                saved.attempt.outcome = Some("dispatch_uncertain".into());
                saved.attempt.reason =
                    Some("Workflow step acceptance is uncertain; it will not be resent".into());
            }
        }
        service.store.save_attempt(&saved.attempt).await?;
    }
    let timeout = service
        .store
        .run(&root.run_id)
        .await?
        .request
        .timeout_seconds;
    // The run's limit bounds the steps together; the case's own limit is the
    // least a run must allow, never a stop.
    let budget_ms = u64::from(timeout) * 1000;
    if let Some((code, reason)) = prefix_violation(&steps, budget_ms) {
        root.outcome = Some(code.into());
        root.reason = Some(reason.into());
        root.phase = "collecting".into();
    } else if let Some(failed) = steps.iter().find(|step| {
        step.attempt.phase == "terminal" && step.attempt.outcome.as_deref() != Some("completed")
    }) {
        stop_with_child(&mut root, &failed.attempt);
    } else if steps.len() == count && steps.iter().all(|s| s.attempt.phase == "terminal") {
        stop_with_child(&mut root, &steps.last().unwrap().attempt);
    } else {
        aggregate(&mut root, &steps);
        root.phase = "pending".into();
        root.outcome = None;
        root.reason = Some(
            "Saved workflow steps recovered; resume explicitly to admit the remaining steps".into(),
        );
        service.store.save_attempt(&root).await?;
        return Ok(Some(root));
    }
    seal_root(&service.store, &mut root, &steps).await?;
    Ok(Some(root))
}

#[cfg(test)]
mod tests {
    use super::super::runner::FakeBackend;
    use super::*;
    use std::sync::{atomic::Ordering, Arc};
    use tokio::sync::Notify;

    async fn setup() -> (
        tempfile::TempDir,
        BenchmarkService,
        Arc<FakeBackend>,
        Attempt,
        BenchmarkVersion,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let backend = Arc::new(FakeBackend::default());
        let service = BenchmarkService {
            store,
            backend: backend.clone(),
            wake: Notify::new(),
            active: Default::default(),
            app: None,
        };
        let mut draft = super::super::runner::seed_definitions().remove(0);
        draft.split = "train".into();
        draft.workflow = Some(WorkflowSpec {
            schema_version: 1,
            driver_revision: "test-v1".into(),
            steps: vec![
                WorkflowStep {
                    id: "plan".into(),
                    prompt: "Produce a plan.".into(),
                    include_previous_output: false,
                    scope: None,
                },
                WorkflowStep {
                    id: "answer".into(),
                    prompt: "Produce the final structured answer.".into(),
                    include_previous_output: true,
                    scope: None,
                },
            ],
        });
        let definition = service.store.save_draft(None, None, draft).await.unwrap();
        let version = service.store.publish(&definition.id, 1).await.unwrap();
        let request = RunRequest {
            request_key: "workflow-test".into(),
            version_ids: vec![version.id.clone()],
            configurations: vec![Configuration {
                id: "fake".into(),
                provider_id: "benchmark-fake".into(),
                account_id: Some("isolated".into()),
                model_id: "fake-pass".into(),
                effort: None,
                fast_mode: None,
                billing_mode: "simulated".into(),
                execution_profile: "native_text".into(),
                inventory_revision: Some("fake-v1".into()),
                model_name: None,
            }],
            repetitions: 1,
            timeout_seconds: 30,
            max_executions: 2,
            preview: false,
            parallelism: None,
            workflow_policy: None,
        };
        let run = service.start_run(request).await.unwrap();
        let mut root = run.attempts[0].clone();
        root.phase = "preparing".into();
        root.started_at = Some(now());
        service.store.save_attempt(&root).await.unwrap();
        (directory, service, backend, root, version)
    }

    #[tokio::test]
    async fn step_decision_precedes_execution_and_survives_retries_unchanged() {
        let (_directory, service, backend, root, version) = setup().await;
        let prepared = prepare_step(&service, &root, &version, 0, 17, None, None)
            .await
            .unwrap();
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        let frozen = serde_json::to_value(prepared.decision.as_ref().unwrap()).unwrap();
        assert_eq!(
            frozen["snapshot"]["selectionProvenance"],
            "workflow_root_pin_v1"
        );
        assert_eq!(frozen["snapshot"]["request"]["timeoutSeconds"], 17);
        assert_eq!(frozen["snapshot"]["request"]["maxExecutions"], 1);
        assert_eq!(
            frozen["snapshot"]["request"]["configurations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            frozen["snapshot"]["entryState"]["previousReports"],
            json!([])
        );
        assert!(prepared.attempt.started_at.is_none());
        let (_tx, cancel) = watch::channel(false);
        let result = execute(&service, root, version.clone(), 30, cancel.clone())
            .await
            .unwrap();
        let steps = saved_steps(&service.store, &result.id).await.unwrap();
        assert_eq!(
            serde_json::to_value(steps[0].decision.as_ref().unwrap()).unwrap(),
            frozen
        );
        assert_eq!(
            steps[1]
                .decision
                .as_ref()
                .unwrap()
                .snapshot
                .entry_state
                .as_ref()
                .unwrap()
                .previous_reports,
            vec![steps[0].attempt.output.clone().unwrap()]
        );
        for step in &steps {
            assert!(
                step.decision.as_ref().unwrap().snapshot.created_at
                    <= step.attempt.started_at.unwrap()
            );
        }
        execute(&service, result.clone(), version, 30, cancel)
            .await
            .unwrap();
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            serde_json::to_value(
                saved_steps(&service.store, &result.id).await.unwrap()[0]
                    .decision
                    .as_ref()
                    .unwrap()
            )
            .unwrap(),
            frozen
        );
    }

    async fn exported_steps(
        service: &BenchmarkService,
        include_held_out: bool,
    ) -> (serde_json::Value, Vec<serde_json::Value>) {
        let result = super::super::export::export(
            &service.store,
            service.query_data().await.unwrap(),
            include_held_out,
        )
        .await
        .unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&result.manifest_path).await.unwrap()).unwrap();
        let body = tokio::fs::read_to_string(
            std::path::Path::new(&result.path).with_file_name("workflow-steps.jsonl"),
        )
        .await
        .unwrap();
        assert_eq!(
            manifest["workflowSteps"]["contentHash"],
            fixtures::hash(body.as_bytes())
        );
        let rows = body
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(manifest["workflowSteps"]["rowCount"], rows.len());
        (manifest, rows)
    }

    #[tokio::test]
    async fn step_export_preserves_causal_inputs_without_root_rewards_or_private_fields() {
        let (_directory, service, _, root, version) = setup().await;
        let prepared = prepare_step(&service, &root, &version, 0, 23, None, None)
            .await
            .unwrap();
        let (manifest, rows) = exported_steps(&service, false).await;
        assert_eq!(manifest["schemaVersion"], 4);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["decisionStatus"], "committed_before_dispatch");
        assert!(rows[0]["outcome"]["usage"].is_null());
        assert!(rows[0]["outcome"]["outcome"].is_null());
        assert_eq!(
            rows[0]["decision"]["record"]["budget"]["timeoutSeconds"],
            23
        );
        assert_eq!(
            rows[0]["decision"]["features"]["entryState"]["previousReports"],
            json!([])
        );
        assert_eq!(
            rows[0]["decision"]["selectedConfiguration"]["candidateKey"],
            super::super::routing::candidate_key(&prepared.attempt.configuration)
        );
        let (_tx, cancel) = watch::channel(false);
        let mut finished = execute(&service, root, version, 30, cancel).await.unwrap();
        finished.phase = "terminal".into();
        finished.outcome = Some("pass".into());
        finished.output = Some("FINAL-ANSWER-MUST-NOT-BECOME-A-FEATURE".into());
        service.store.save_attempt(&finished).await.unwrap();
        let (_, rows) = exported_steps(&service, false).await;
        assert_eq!(rows.len(), 2);
        for row in &rows {
            assert!(row["outcome"]["reward"].is_null());
            assert_eq!(row["outcome"]["observed"], false);
            assert_eq!(row["independentTask"], false);
            assert_eq!(row["counterfactualOutcomesAvailable"], false);
            assert_eq!(row["rootAttemptId"], finished.id);
            assert_eq!(row["split"], "train");
            assert!(row["outcome"]["usage"]["cost"].is_null());
        }
        let encoded = serde_json::to_string(&rows).unwrap();
        assert!(!encoded.contains("FINAL-ANSWER-MUST-NOT-BECOME-A-FEATURE"));
        assert!(!encoded.contains("\"isolated\""));
        assert!(!encoded.contains("knownGood"));
        assert!(!encoded.contains("knownBad"));
        assert!(!encoded.contains("expected"));
        let saved = saved_steps(&service.store, &finished.id).await.unwrap();
        assert_eq!(
            rows[1]["decision"]["features"]["entryState"]["previousReports"],
            json!([saved[0].attempt.output])
        );
        let mut failed = saved[0].attempt.clone();
        failed.outcome = Some("budget_timeout".into());
        service.store.save_attempt(&failed).await.unwrap();
        let (_, rows) = exported_steps(&service, false).await;
        assert_eq!(rows[0]["outcome"]["outcome"], "budget_timeout");
        assert!(rows[0]["outcome"]["reward"].is_null());
    }

    #[tokio::test]
    async fn changed_step_input_is_refused_before_dispatch_and_export() {
        let (_directory, service, backend, root, version) = setup().await;
        let prepared = prepare_step(&service, &root, &version, 0, 30, None, None)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE workflow_steps SET prompt='changed after preparation' WHERE attempt_id=?",
        )
        .bind(&prepared.attempt.id)
        .execute(&service.store.pool)
        .await
        .unwrap();
        let (_tx, cancel) = watch::channel(false);
        assert_eq!(
            execute(&service, root, version, 30, cancel)
                .await
                .unwrap_err()
                .code,
            "evidence_mismatch"
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            super::super::export::export(
                &service.store,
                service.query_data().await.unwrap(),
                false
            )
            .await
            .unwrap_err()
            .code,
            "evidence_mismatch"
        );
    }

    #[tokio::test]
    async fn legacy_step_export_does_not_invent_a_pre_dispatch_decision() {
        let (_directory, service, _, root, version) = setup().await;
        let (_tx, cancel) = watch::channel(false);
        execute(&service, root, version, 30, cancel).await.unwrap();
        sqlx::query("UPDATE workflow_steps SET decision_json=NULL")
            .execute(&service.store.pool)
            .await
            .unwrap();
        let (_, rows) = exported_steps(&service, false).await;
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row["decisionStatus"]
            == "legacy_missing_pre_dispatch_decision"
            && row["decision"].is_null()
            && row["outcome"]["reward"].is_null()));
    }

    #[tokio::test]
    async fn step_export_requires_explicit_heldout_scope_and_omits_later_outcomes() {
        let (_directory, service, _, root, mut version) = setup().await;
        let (_tx, cancel) = watch::channel(false);
        let result = execute(&service, root, version.clone(), 30, cancel)
            .await
            .unwrap();
        let mut steps = saved_steps(&service.store, &result.id).await.unwrap();
        steps[1].attempt.finished_at = Some(now() + 60_000);
        service.store.save_attempt(&steps[1].attempt).await.unwrap();
        let (_, rows) = exported_steps(&service, false).await;
        assert!(rows[1]["outcome"]["usage"].is_null());
        assert!(rows[1]["outcome"]["outcome"].is_null());
        assert!(rows[0]["outcome"]["usage"].is_object());
        // Isolated storage fixture: exercise split filtering without collecting
        // another worker outcome or modifying any live benchmark version.
        version.manifest.split = "held_out".into();
        sqlx::query("UPDATE benchmark_versions SET manifest_json=? WHERE id=?")
            .bind(serde_json::to_string(&version.manifest).unwrap())
            .bind(&version.id)
            .execute(&service.store.pool)
            .await
            .unwrap();
        assert!(exported_steps(&service, false).await.1.is_empty());
        assert_eq!(exported_steps(&service, true).await.1.len(), 2);
        version.manifest.split = "development".into();
        sqlx::query("UPDATE benchmark_versions SET manifest_json=? WHERE id=?")
            .bind(serde_json::to_string(&version.manifest).unwrap())
            .bind(&version.id)
            .execute(&service.store.pool)
            .await
            .unwrap();
        assert!(exported_steps(&service, true).await.1.is_empty());
    }

    #[tokio::test]
    async fn auxiliary_work_is_preserved_when_a_later_step_is_cancelled() {
        let (_directory, service, _, root, version) = setup().await;
        let (_tx, cancel) = watch::channel(false);
        let mut result = execute(&service, root, version, 30, cancel).await.unwrap();
        let mut steps = saved_steps(&service.store, &result.id).await.unwrap();
        steps[0].attempt.usage.schema = "provider_turn_with_auxiliary_v2".into();
        steps[0]
            .attempt
            .observed
            .as_mut()
            .unwrap()
            .execution_profile = "native_text_auxiliary".into();
        steps[1].attempt.outcome = Some("cancelled".into());
        // The newest step whose usage named the model that answered speaks
        // for the task.
        steps[0].attempt.resolved_model = Some("fake-pass-2026".into());
        aggregate(&mut result, &steps);
        assert_eq!(result.resolved_model.as_deref(), Some("fake-pass-2026"));
        assert_eq!(result.usage.schema, "workflow_sum_with_auxiliary_v2");
        assert_eq!(
            result.observed.unwrap().execution_profile,
            "native_text_auxiliary"
        );
        assert_eq!(result.usage.input, Some(20));
    }

    #[tokio::test]
    async fn workflow_runs_fresh_steps_once_and_retains_declared_feedback() {
        let (_directory, service, backend, root, version) = setup().await;
        let (_tx, cancel) = watch::channel(false);
        let result = execute(&service, root, version.clone(), 30, cancel.clone())
            .await
            .unwrap();
        assert_eq!(result.outcome.as_deref(), Some("completed"));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        assert_eq!(result.workflow_steps.len(), 2);
        assert_ne!(
            result.workflow_steps[0].attempt_id,
            result.workflow_steps[1].attempt_id
        );
        assert_ne!(
            result.workflow_steps[0].host_run_id,
            result.workflow_steps[1].host_run_id
        );
        assert_eq!(result.usage.input, Some(20));
        assert_eq!(result.usage.output, Some(10));
        assert_eq!(result.usage.cost, None);
        assert_eq!(result.usage.cache_read, None);
        let saved = saved_steps(&service.store, &result.id).await.unwrap();
        assert!(saved[0].entry.previous_reports.is_empty());
        assert!(!saved[0]
            .prompt
            .contains(&version.manifest.evaluator.known_good));
        assert_eq!(
            saved[1].entry.previous_reports,
            vec![saved[0].attempt.output.clone().unwrap()]
        );
        assert_eq!(saved[1].entry.parent_step_id.as_deref(), Some("plan"));
        assert_eq!(
            saved[1].entry.content_hash,
            super::super::routing::entry_hash(&saved[1].entry)
        );
        assert_eq!(
            super::super::evaluation::evaluate(
                &version.manifest.evaluator,
                result.output.as_deref().unwrap()
            )
            .unwrap()
            .verdict,
            "pass"
        );
        execute(&service, result, version, 30, cancel)
            .await
            .unwrap();
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn workflow_cancel_acknowledges_active_child_and_never_starts_next() {
        let (_directory, service, backend, root, version) = setup().await;
        let (tx, cancel) = watch::channel(false);
        let stop = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            tx.send(true).unwrap();
        });
        let result = execute(&service, root, version, 30, cancel).await.unwrap();
        stop.await.unwrap();
        assert_eq!(result.outcome.as_deref(), Some("cancelled"));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert_eq!(result.workflow_steps.len(), 1);
    }

    /// A step the host refused before any provider call goes back to the
    /// queue with its workflow, which the runner holds for the operator; the
    /// next pass runs that step, never settles it.
    #[tokio::test]
    async fn a_step_refused_before_its_session_waits_with_its_workflow() {
        let (_directory, service, backend, root, version) = setup().await;
        backend.capability_refusals.store(1, Ordering::SeqCst);
        let (_tx, cancel) = watch::channel(false);
        let refused = execute(&service, root.clone(), version.clone(), 30, cancel.clone())
            .await
            .unwrap_err();
        assert_eq!(refused.code, "capability_missing");
        let steps = saved_steps(&service.store, &root.id).await.unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].attempt.phase, "pending");
        assert_eq!(steps[0].attempt.outcome, None);
        assert_eq!(steps[0].attempt.started_at, None);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        let result = execute(&service, root, version, 30, cancel).await.unwrap();
        assert_eq!(result.outcome.as_deref(), Some("completed"));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn workflow_recovery_waits_for_resume_and_never_repeats_completed_prefix() {
        let (_directory, service, backend, root, version) = setup().await;
        let mut first = prepare_step(&service, &root, &version, 0, 30, None, None)
            .await
            .unwrap();
        first.attempt.phase = "preparing".into();
        first.attempt.started_at = Some(now());
        service.store.save_attempt(&first.attempt).await.unwrap();
        let (_tx, cancel) = watch::channel(false);
        first.attempt = service
            .backend
            .execute(
                &service.store,
                first.attempt.clone(),
                step_version(&version, &first),
                30,
                cancel.clone(),
            )
            .await
            .unwrap();
        first.attempt.phase = "terminal".into();
        service.store.save_attempt(&first.attempt).await.unwrap();
        service.store.recover().await.unwrap();
        let interrupted = service.store.attempt(&root.id).await.unwrap();
        let restored = recover(&service, interrupted, version.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.phase, "pending");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            service.store.run(&root.run_id).await.unwrap().state,
            "needs_attention"
        );
        service.control(&root.run_id, "resume").await.unwrap();
        let result = execute(&service, restored, version, 30, cancel)
            .await
            .unwrap();
        assert_eq!(result.outcome.as_deref(), Some("completed"));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn uncertain_workflow_step_is_never_automatically_resent() {
        let (_directory, service, backend, root, version) = setup().await;
        let mut first = prepare_step(&service, &root, &version, 0, 30, None, None)
            .await
            .unwrap();
        first.attempt.phase = "dispatching".into();
        first.attempt.started_at = Some(now());
        service.store.save_attempt(&first.attempt).await.unwrap();
        let restored = recover(&service, root, version).await.unwrap().unwrap();
        assert_eq!(restored.outcome.as_deref(), Some("dispatch_uncertain"));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            saved_steps(&service.store, &restored.id)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn workflow_recovery_checks_selection_and_budget_before_final_evaluation() {
        let (_directory, service, backend, root, version) = setup().await;
        let mut first = prepare_step(&service, &root, &version, 0, 30, None, None)
            .await
            .unwrap();
        let mut second = prepare_step(
            &service,
            &root,
            &version,
            1,
            29,
            Some("public report"),
            None,
        )
        .await
        .unwrap();
        for saved in [&mut first, &mut second] {
            saved.attempt.phase = "terminal".into();
            saved.attempt.outcome = Some("completed".into());
            saved.attempt.observed = Some(saved.attempt.configuration.clone());
            saved.attempt.output = Some(version.manifest.evaluator.known_good.clone());
            saved.attempt.started_at = Some(now());
            saved.attempt.finished_at = Some(now());
            saved.attempt.duration_ms = Some(300);
        }
        second.attempt.observed.as_mut().unwrap().effort = Some("different".into());
        service.store.save_attempt(&first.attempt).await.unwrap();
        service.store.save_attempt(&second.attempt).await.unwrap();
        let restored = recover(&service, root.clone(), version.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.outcome.as_deref(), Some("selection_changed"));
        second.attempt.observed = first.attempt.observed.clone();
        second.attempt.duration_ms = Some(30_000);
        service.store.save_attempt(&second.attempt).await.unwrap();
        let restored = recover(&service, root, version).await.unwrap().unwrap();
        assert_eq!(restored.outcome.as_deref(), Some("budget_timeout"));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn sealed_workflow_cancellation_without_output_survives_restart() {
        let (_directory, service, backend, root, version) = setup().await;
        let (_tx, cancel) = watch::channel(true);
        let result = execute(&service, root, version.clone(), 30, cancel)
            .await
            .unwrap();
        assert_eq!(result.outcome.as_deref(), Some("cancelled"));
        assert!(result.output.is_none());
        service.store.recover().await.unwrap();
        let interrupted = service.store.attempt(&result.id).await.unwrap();
        let restored = recover(&service, interrupted, version)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.outcome.as_deref(), Some("cancelled"));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn workflow_entry_content_hash_matches_candidates_and_changes_with_feedback() {
        let (_directory, _service, _backend, first, version) = setup().await;
        let mut second = first.clone();
        second.id = "another-candidate-attempt".into();
        second.configuration.model_id = "another-model".into();
        let a = step_entry(&first, &version.manifest, 0, 30, None).unwrap();
        let b = step_entry(&second, &version.manifest, 0, 30, None).unwrap();
        assert_ne!(a.root_task_id, b.root_task_id);
        assert_eq!(a.content_hash, b.content_hash);
        let x = step_entry(&first, &version.manifest, 1, 29, Some("first answer")).unwrap();
        let y = step_entry(&second, &version.manifest, 1, 29, Some("different answer")).unwrap();
        assert_ne!(x.content_hash, y.content_hash);
    }

    #[test]
    fn workflow_rejects_ambiguous_feedback_and_unbounded_driver() {
        let mut draft = super::super::runner::seed_definitions().remove(0);
        draft.workflow = Some(WorkflowSpec {
            schema_version: 1,
            driver_revision: "1".into(),
            steps: vec![WorkflowStep {
                id: "a".into(),
                prompt: "p".into(),
                include_previous_output: true,
                scope: None,
            }],
        });
        assert!(validate(&draft).len() >= 2);
    }
}
