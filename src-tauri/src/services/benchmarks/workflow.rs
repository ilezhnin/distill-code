//! Bounded workflows use fresh owned sessions and committed public step inputs.
use super::{
    fixtures,
    store::{event, now, Store},
    types::*,
    BenchmarkService,
};
use futures_util::future::BoxFuture;
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
    ) && !matches!(super::judge_panel::frozen(draft, &[]), Ok(Some(_)))
    {
        issues.push("A workflow requires an objective evaluator or a frozen rubric panel".into());
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
    /// Time the step waited for its decided worker's slot under step
    /// admission, excluded from its root's wall clock. Absent elsewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_wait_ms: Option<u64>,
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

/// A final judge must be independent of every worker that contributed to the
/// answer, including earlier steps and acknowledged provider substitutions.
pub(super) async fn judge_candidates(store: &Store, root: &Attempt) -> Result<Vec<Configuration>> {
    let mut candidates = vec![root.configuration.clone()];
    candidates.extend(root.observed.clone());
    if !root.workflow_steps.is_empty() {
        let steps = saved_steps(store, &root.id).await?;
        if steps.len() != root.workflow_steps.len() {
            return Err(BenchmarkError::new(
                "evidence_missing",
                "Workflow judge exclusions lack step evidence",
            ));
        }
        for step in steps {
            candidates.push(step.attempt.configuration);
            candidates.extend(step.attempt.observed);
        }
    }
    Ok(candidates)
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
    /// Frozen only by campaigns using the queue-excluded timing contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<WorkflowTiming>,
    /// Preserve first outcomes even when timing cannot support a report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTiming {
    pub raw_elapsed_ms: u64,
    pub account_slot_wait_ms: u64,
    pub execution_elapsed_ms: u64,
}

/// Validate committed, sequential admission waits without subtracting worker,
/// selector, or orchestration time. Each wait fits inside its own interval
/// after selection and before the step lease starts; intervals cannot overlap.
pub(super) fn campaign_timing(root: &Attempt, steps: &[SavedStep]) -> Result<WorkflowTiming> {
    let invalid = || {
        BenchmarkError::new(
            "invalid_workflow_timing",
            "Committed workflow timing is incomplete or inconsistent",
        )
    };
    let start = root.started_at.filter(|v| *v >= 0).ok_or_else(invalid)?;
    let end = root.finished_at.ok_or_else(invalid)?;
    let raw = end
        .checked_sub(start)
        .filter(|v| *v >= 0)
        .ok_or_else(invalid)?;
    let mut previous_end = start;
    let mut waits = 0i64;
    for (index, step) in steps.iter().enumerate() {
        step.validate_decision(&root.id)?;
        let decision = step.decision.as_ref().ok_or_else(invalid)?;
        let selected_at = decision.executor.as_ref().ok_or_else(invalid)?.created_at;
        let context = decision.native_context.as_ref().ok_or_else(invalid)?;
        let wait =
            i64::try_from(context.local_wait_ms.ok_or_else(invalid)?).map_err(|_| invalid())?;
        let lease = &context.budget;
        let step_start = step.attempt.started_at.ok_or_else(invalid)?;
        let step_end = step.attempt.finished_at.ok_or_else(invalid)?;
        let interval = lease
            .step_started_at_ms
            .checked_sub(selected_at)
            .filter(|v| *v >= 0)
            .ok_or_else(invalid)?;
        waits = waits
            .checked_add(wait)
            .filter(|v| *v <= raw)
            .ok_or_else(invalid)?;
        if step.index != index
            || step.attempt.run_id != root.run_id
            || step.attempt.version_id != root.version_id
            || selected_at < previous_end
            || wait > interval
            || lease.recipe != super::artifact_context::CLOCK_RECIPE
            || lease.root_id != root.id
            || lease.step_key != format!("workflow:{}:{index}", root.id)
            || Some(lease.root_started_at_ms) != start.checked_add(waits)
            || lease.root_started_at_ms > lease.step_started_at_ms
            || lease.step_started_at_ms > decision.snapshot.created_at
            || decision.snapshot.created_at > step_start
            || step_start > step_end
            || step_end > end
        {
            return Err(invalid());
        }
        previous_end = step_end;
    }
    Ok(WorkflowTiming {
        raw_elapsed_ms: raw as u64,
        account_slot_wait_ms: waits as u64,
        execution_elapsed_ms: (raw - waits) as u64,
    })
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
            timing: None,
            timing_error: None,
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

/// Deletes the prepared steps of a root-pinned workflow that no provider saw,
/// with the native clocks its root and steps froze, so the root's next
/// admission prepares and times them afresh. A step the store shows a
/// provider saw keeps everything, and the answer is false.
pub(super) async fn discard_unstarted(store: &Store, root: &Attempt) -> Result<bool> {
    let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await?;
    let steps: Vec<String> =
        sqlx::query_scalar("SELECT data_json FROM workflow_steps WHERE root_attempt_id=?")
            .bind(&root.id)
            .fetch_all(&mut *tx)
            .await?;
    for step in &steps {
        let step: Attempt = serde_json::from_str(step)?;
        if super::runner::reached_provider(&step)
            || step.evidence_hash.is_some()
            || step.outcome.as_deref() == Some("completed")
        {
            return Ok(false);
        }
    }
    sqlx::query("DELETE FROM workflow_steps WHERE root_attempt_id=?")
        .bind(&root.id)
        .execute(&mut *tx)
        .await?;
    // The keys `execute` and `prepare_step` reserve for this root, and no
    // other binding that names it.
    let step_keys = format!("workflow:{}:", root.id);
    sqlx::query("DELETE FROM task_budget_bindings WHERE root_id=? AND (request_key=? OR substr(request_key,1,length(?))=?)")
        .bind(&root.id)
        .bind(format!("workflow-root:{}", root.id))
        .bind(&step_keys)
        .bind(&step_keys)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM budget_credits WHERE root_id=?")
        .bind(&root.id)
        .execute(&mut *tx)
        .await?;
    if !steps.is_empty() {
        event(&mut tx, &root.run_id, "workflow_steps_discarded").await?;
    }
    tx.commit().await?;
    Ok(true)
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
        return super::runner::collection_context::recover(store, attempt, version).await;
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
    let root_request = store.run(&root.run_id).await?.request;
    let concurrent_policy = root.configuration.execution_profile == "workflow_policy"
        && store
            .workflow_campaign_parallelism(&root_request.request_key)
            .await?
            > 1;
    let mut entry = step_entry(root, &version.manifest, index, remaining, previous)?;
    let new_clock = version
        .manifest
        .environment
        .get("nativeBudgetRecipe")
        .and_then(serde_json::Value::as_str)
        == Some(super::artifact_context::CLOCK_RECIPE);
    let budget = if new_clock || concurrent_policy {
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
            root_cap_seconds: root_request.timeout_seconds,
            step_key: format!("workflow-root:{}", root.id),
            step_started_at_ms: origin,
            step_cap_seconds: root_request.timeout_seconds,
            credits: Vec::new(),
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
                        .map_or_else(
                            || {
                                if new_clock {
                                    version.manifest.limits.timeout_seconds
                                } else {
                                    // Legacy steps have no independent clock;
                                    // concurrency only binds their root deadline.
                                    root_budget.root_cap_seconds
                                }
                            },
                            |scope| scope.step_budget_seconds,
                        )
                        .min(root_budget.root_cap_seconds),
                    &root.id,
                )
                .await?,
        )
    } else {
        None
    };
    let repository_context = if new_clock {
        repository_input(
            store,
            root,
            version,
            spec,
            budget.as_ref().unwrap().deadline_at_ms()?,
        )
        .await?
    } else {
        None
    };
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
    let prompt = step_prompt(version, index, spec);
    check_public_bytes(version, &prompt, &entry)?;
    let child = child_attempt(root, index);
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
            local_wait_ms: None,
        }),
    };
    let policy = root_request.workflow_policy;
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
    commit_step(store, root, version, saved, executor, remaining).await
}

/// The public repository input of a step: the snapshot advanced through the
/// sealed artifacts of its visible predecessors, materialized before
/// `deadline_ms`. Only native-clock repository steps have one.
async fn repository_input(
    store: &Store,
    root: &Attempt,
    version: &BenchmarkVersion,
    spec: &WorkflowStep,
    deadline_ms: i64,
) -> Result<Option<super::artifact_context::Input>> {
    if version.manifest.execution_profile != "protected_repository" {
        return Ok(None);
    }
    {
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
            deadline_ms.try_into().map_err(|_| {
                BenchmarkError::new("budget_clock_conflict", "Native deadline is invalid")
            })?,
        )
        .await?;
        Ok(Some(super::artifact_context::Input {
            before: package.artifact,
            lineage,
            access_all: spec.include_previous_output,
        }))
    }
}

/// The step's own attempt record: the root's identity and configuration
/// before any dispatch, with nothing measured yet.
fn child_attempt(root: &Attempt, index: usize) -> Attempt {
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
    child
}

/// Commits a prepared step with its pre-dispatch decision: one row, written
/// under the writer lock so concurrent roots cannot invalidate the snapshot.
async fn commit_step(
    store: &Store,
    root: &Attempt,
    version: &BenchmarkVersion,
    mut saved: SavedStep,
    executor: Option<super::executor::Decision>,
    remaining: u32,
) -> Result<SavedStep> {
    let workflow = version.manifest.workflow.as_ref().unwrap();
    let index = saved.index;
    // Reserve the writer before reading the decision. Concurrent roots can
    // otherwise invalidate this WAL snapshot before the step is inserted.
    let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await?;
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

/// The prompt a step's worker receives: the root prompt, then its own.
fn step_prompt(version: &BenchmarkVersion, index: usize, spec: &WorkflowStep) -> String {
    let count = version
        .manifest
        .workflow
        .as_ref()
        .map_or(0, |workflow| workflow.steps.len());
    format!(
        "{}\n\nWorkflow step {} of {} ({}):\n{}",
        version.manifest.prompt,
        index + 1,
        count,
        spec.id,
        spec.prompt
    )
}

/// Declared feedback stays inside the native public context cap.
fn check_public_bytes(version: &BenchmarkVersion, prompt: &str, entry: &EntryState) -> Result<()> {
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
    Ok(())
}

/// How often a later workflow step the local broker refused asks again.
#[cfg(not(test))]
pub(super) const LATER_STEP_RETRY: std::time::Duration = std::time::Duration::from_secs(10);
#[cfg(test)]
pub(super) const LATER_STEP_RETRY: std::time::Duration = std::time::Duration::from_millis(50);

/// Whether a later step first tried at `first_try` with `allowance` seconds
/// may still wait for sandbox room at `now`: the next try must start within
/// the first quarter of its allowance.
pub(super) fn later_step_may_wait(first_try: i64, allowance: u32, now: i64) -> bool {
    let next = now.saturating_sub(first_try) + LATER_STEP_RETRY.as_millis() as i64;
    next <= i64::from(allowance) * 1000 / 4
}

/// Worker-slot waits the steps of a step-admitted root recorded; its wall
/// clock runs from admission without them.
fn excluded_waits_ms(steps: &[SavedStep]) -> i64 {
    steps
        .iter()
        .filter_map(|step| step.native_context.as_ref().and_then(|c| c.local_wait_ms))
        .sum::<u64>() as i64
}

/// A step's own allowance: its schema-2 scope, else the case limit on the
/// native clock, else the root's; never above the root's.
fn step_cap_seconds(
    spec: &WorkflowStep,
    new_clock: bool,
    version: &BenchmarkVersion,
    root_cap: u32,
) -> u32 {
    spec.scope
        .as_ref()
        .map_or_else(
            || {
                if new_clock {
                    version.manifest.limits.timeout_seconds
                } else {
                    root_cap
                }
            },
            |scope| scope.step_budget_seconds,
        )
        .min(root_cap)
}

/// [`prepare_step`] under the step-admission recipe: the policy decides the
/// worker on the public task first, the root then takes that worker's slot,
/// and only afterwards the step's budget lease starts, from a root origin
/// that excludes the recorded wait. The projection the policy sees ignores
/// the lease, so a provisional one stands in; the repository input is final.
#[allow(clippy::too_many_arguments)]
async fn prepare_step_admitted(
    service: &BenchmarkService,
    root: &Attempt,
    version: &BenchmarkVersion,
    index: usize,
    remaining: u32,
    previous: Option<&str>,
    native_reports: Option<Vec<String>>,
    concurrency: &super::workflow_campaign::CampaignConcurrency,
    steps: &[SavedStep],
    cancel: watch::Receiver<bool>,
) -> Result<SavedStep> {
    let store = &service.store;
    let workflow = version.manifest.workflow.as_ref().unwrap();
    let spec = &workflow.steps[index];
    let root_request = store.run(&root.run_id).await?.request;
    let policy = root_request.workflow_policy.as_ref().ok_or_else(|| {
        BenchmarkError::new(
            "invalid_workflow_policy",
            "Step admission requires a workflow policy",
        )
    })?;
    let admitted_at = root.started_at.ok_or_else(|| {
        BenchmarkError::new(
            "budget_clock_conflict",
            "Native workflow root clock is absent",
        )
    })?;
    let origin = admitted_at + excluded_waits_ms(steps);
    let root_cap = root_request.timeout_seconds;
    let new_clock = version
        .manifest
        .environment
        .get("nativeBudgetRecipe")
        .and_then(serde_json::Value::as_str)
        == Some(super::artifact_context::CLOCK_RECIPE);
    // The entry declares the allowance the step may use. It is fixed before
    // the policy decides, and the committed step keeps it unchanged, so the
    // decision's public task and the sealed trace are the same bytes; the
    // lease reserved after the wait enforces the real remaining time.
    let step_cap = step_cap_seconds(spec, new_clock, version, root_cap);
    let mut entry = step_entry(
        root,
        &version.manifest,
        index,
        remaining.min(step_cap),
        previous,
    )?;
    let repository_context = if new_clock {
        repository_input(
            store,
            root,
            version,
            spec,
            origin + i64::from(root_cap) * 1000,
        )
        .await?
    } else {
        None
    };
    if spec.include_previous_output {
        if let Some(reports) = native_reports {
            entry.previous_reports = reports;
        }
    }
    entry.content_hash = super::routing::entry_hash(&entry);
    let prompt = step_prompt(version, index, spec);
    check_public_bytes(version, &prompt, &entry)?;
    let step_key = format!("workflow:{}:{index}", root.id);
    let mut saved = SavedStep {
        index,
        id: spec.id.clone(),
        parent_id: entry.parent_step_id.clone(),
        entry,
        prompt,
        attempt: child_attempt(root, index),
        decision: None,
        native_context: Some(NativeStepContext {
            budget: super::artifact_context::BudgetLease {
                recipe: super::artifact_context::CLOCK_RECIPE.into(),
                root_id: root.id.clone(),
                root_started_at_ms: origin,
                root_cap_seconds: root_cap,
                step_key: step_key.clone(),
                step_started_at_ms: now().max(origin),
                step_cap_seconds: root_cap,
                credits: Vec::new(),
            },
            repository: repository_context.clone(),
            local_wait_ms: None,
        }),
    };
    let selected = policy
        .select(service, root, &step_version(version, &saved), index)
        .await?;
    let chosen = selected.chosen.clone().ok_or_else(|| {
        BenchmarkError::new(
            "no_available_worker",
            "No eligible worker for the frozen workflow policy",
        )
    })?;
    saved.attempt.configuration = chosen.clone();
    let waited = service
        .acquire_step_worker(
            &root.id,
            &root.run_id,
            admitted_at,
            &chosen,
            &root_request,
            super::runner::account_slots_within(
                &root.run_id,
                &super::runner::quota_scope(&chosen),
                concurrency.account_slots,
            ),
            cancel,
        )
        .await?;
    let origin = origin + waited as i64;
    let root_budget = super::artifact_context::BudgetLease {
        recipe: super::artifact_context::CLOCK_RECIPE.into(),
        root_id: root.id.clone(),
        root_started_at_ms: origin,
        root_cap_seconds: root_cap,
        step_key: format!("workflow-root:{}", root.id),
        step_started_at_ms: origin,
        step_cap_seconds: root_cap,
        credits: Vec::new(),
    };
    let budget = store
        .reserve_task_budget(
            &step_key,
            &fixtures::hash(&serde_json::to_vec(&(
                &root.id,
                &version.content_hash,
                index,
                spec,
            ))?),
            &version.content_hash,
            Some(&root_budget),
            root_cap,
            step_cap,
            &root.id,
        )
        .await?;
    saved.native_context = Some(NativeStepContext {
        budget,
        repository: repository_context,
        local_wait_ms: Some(waited),
    });
    commit_step(store, root, version, saved, Some(selected), remaining).await
}

fn step_version(version: &BenchmarkVersion, saved: &SavedStep) -> BenchmarkVersion {
    let mut result = version.clone();
    result.manifest.workflow = None;
    result.manifest.prompt = saved.prompt.clone();
    result.manifest.entry_state = Some(saved.entry.clone());
    if version.manifest.evaluator.kind == "rubric" {
        // These are execution-only children. The published root alone owns
        // the final rubric, its control panel and output-format constraints.
        result.manifest.evaluator.rubric.clear();
        result.manifest.evaluator.expected.clear();
        result.manifest.evaluator.known_good.clear();
        result.manifest.evaluator.known_bad.clear();
        if let Some(environment) = result.manifest.environment.as_object_mut() {
            for key in [
                "judgePanel",
                "rubricCriteria",
                "judgeInput",
                "judgeViewport",
                "textLimits",
                "criticalChecks",
                "judgeSamples",
            ] {
                environment.remove(key);
            }
        }
    }
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
    // A root's speed is measured under its most loaded step's admission.
    root.sandbox_admission = executed
        .iter()
        .filter_map(|step| step.attempt.sandbox_admission.as_ref())
        .max_by_key(|admission| admission.competing_heavy)
        .cloned();
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

/// Boxed: an attempt's runner already sits deep on its 2 MiB worker stack,
/// and an unoptimized build gives the awaiting poll a stack slot for every
/// step this would otherwise carry inline.
pub fn execute(
    service: &BenchmarkService,
    mut root: Attempt,
    version: BenchmarkVersion,
    timeout: u32,
    cancel: watch::Receiver<bool>,
) -> BoxFuture<'_, Result<Attempt>> {
    Box::pin(async move {
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
        let concurrency = if root.configuration.execution_profile == "workflow_policy" {
            let request = service.store.run(&root.run_id).await?.request;
            service
                .store
                .workflow_campaign_concurrency(&request.request_key)
                .await?
        } else {
            super::workflow_campaign::CampaignConcurrency::SERIAL
        };
        let concurrent_policy = concurrency.concurrent();
        let step_admission =
            concurrency.admission == super::workflow_campaign::WorkerAdmission::SelectedStep;
        if new_clock || concurrent_policy {
            let key = format!("workflow-root:{}", root.id);
            // The time it sat in the queue with a paid prefix, or stranded
            // by a stopped app, is credited back from here on.
            service.store.close_root_credit(&root.id, now()).await?;
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
                credits: Vec::new(),
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
                let (outcome, reason) = super::runner::settled_failure(&root, &error);
                root.phase = "collecting".into();
                root.outcome = Some(outcome);
                root.reason = Some(reason);
                let steps = saved_steps(&service.store, &root.id).await?;
                seal_root(&service.store, &mut root, &steps).await?;
                return Ok(root);
            }
        }
        let wall_origin = root.started_at.unwrap_or_else(now);
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
            let remaining = if new_clock || concurrent_policy {
                // Exhaustion is the timeout outcome; a clock that moved backwards
                // is a conflict to surface, never a recorded budget timeout.
                match super::artifact_context::remaining_seconds(
                    wall_origin
                        + excluded_waits_ms(&steps)
                        + service.store.root_credit_ms(&root.id).await?,
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
                let exhausted = BenchmarkError::new(
                    "budget_timeout",
                    "Workflow exhausted its shared duration budget",
                );
                let (outcome, reason) = super::runner::settled_failure(&root, &exhausted);
                root.outcome = Some(outcome);
                root.reason = Some(reason);
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
                let prepared = if step_admission {
                    Box::pin(prepare_step_admitted(
                        service,
                        &root,
                        &version,
                        index,
                        remaining,
                        previous,
                        native_reports,
                        &concurrency,
                        &steps,
                        cancel.clone(),
                    ))
                    .await
                } else {
                    prepare_step(
                        service,
                        &root,
                        &version,
                        index,
                        remaining,
                        previous,
                        native_reports,
                    )
                    .await
                };
                match prepared {
                    Ok(step) => steps.push(step),
                    Err(error) if error.code == "budget_timeout" => {
                        let (outcome, reason) = super::runner::settled_failure(&root, &error);
                        root.outcome = Some(outcome);
                        root.reason = Some(reason);
                        break;
                    }
                    Err(error) => return Err(error),
                }
                aggregate(&mut root, &steps);
                service.store.save_attempt(&root).await?;
            }
            let untouched = steps[..index]
                .iter()
                .all(|step| !super::runner::reached_provider(&step.attempt));
            let saved = &mut steps[index];
            saved.attempt.phase = "preparing".into();
            saved.attempt.started_at = Some(now());
            service.store.save_attempt(&saved.attempt).await?;
            let effective_version = step_version(&version, saved);
            let request = service.store.run(&root.run_id).await?.request;
            request.require_dispatch_admission(now())?;
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
                // A later step the local broker refused before any provider
                // process started waits for room on its root's seat, so the
                // paid steps before it are kept: it asks again while no more
                // than a quarter of its allowance has passed. On the wall
                // clock that time comes off the step's own allowance; past
                // the quarter the refusal settles the step, unscored. The
                // first step goes back to the queue instead (below).
                let allowance = remaining.min(saved.entry.remaining_budget_seconds);
                let first_try = now();
                let mut cancelled = cancel.clone();
                loop {
                    let waited =
                        u32::try_from((now() - first_try).max(0) / 1000).unwrap_or(u32::MAX);
                    let timeout = if new_clock || concurrent_policy {
                        allowance.saturating_sub(waited)
                    } else {
                        allowance
                    };
                    // A later step of a workflow a provider already worked
                    // on goes ahead of new attempts in the sandbox.
                    let continuing = (!untouched).then(|| {
                        crate::services::benchmark_sandbox::Continuing::new(
                            super::runner::turn_owner(&saved.attempt),
                        )
                    });
                    let result = service
                        .backend
                        .execute(
                            &service.store,
                            saved.attempt.clone(),
                            effective_version.clone(),
                            timeout,
                            cancel.clone(),
                        )
                        .await;
                    drop(continuing);
                    // A later step refused before any provider saw it, for
                    // sandbox room or for a sign-in renewal that waits for
                    // the account's other sessions, waits here for its own
                    // turn: nothing of its workflow is sent again.
                    let retry = match &result {
                        Err(error)
                            if !untouched
                                && matches!(
                                    error.code.as_str(),
                                    "resource_busy" | super::runner::SIGN_IN_WAIT
                                )
                                && later_step_may_wait(first_try, allowance, now()) =>
                        {
                            let current = service.store.attempt(&saved.attempt.id).await?;
                            (current.phase == "preparing"
                                && !super::runner::reached_provider(&current))
                            .then_some(current)
                        }
                        _ => None,
                    };
                    let Some(current) = retry else {
                        break result;
                    };
                    tokio::select! {
                        _ = tokio::time::sleep(LATER_STEP_RETRY) => {}
                        changed = cancelled.changed() => {
                            // A closed channel cancels nothing; still pause.
                            if changed.is_err() {
                                tokio::time::sleep(LATER_STEP_RETRY).await;
                            }
                        }
                    }
                    if *cancel.borrow() || request.require_dispatch_admission(now()).is_err() {
                        break result;
                    }
                    // A new start is a new owner for the host, as for a cell
                    // that went back to the queue.
                    saved.attempt = current;
                    saved.attempt.started_at = Some(now());
                    service.store.save_attempt(&saved.attempt).await?;
                }
            };
            // The local broker refused the first step a provider would have
            // seen, or a sandbox sign-in renewal held it back: the workflow
            // has not started, under any retry policy. The step goes back
            // unstarted and the runner returns the root to the queue. A
            // research trajectory keeps its committed record below.
            let result = match result {
                Err(error)
                    if untouched
                        && matches!(
                            error.code.as_str(),
                            "resource_busy" | super::runner::SIGN_IN_WAIT
                        )
                        && root.configuration.execution_profile != "workflow_policy" =>
                {
                    let current = service.store.attempt(&saved.attempt.id).await?;
                    if current.phase == "preparing" && !super::runner::reached_provider(&current) {
                        saved.attempt = current;
                        super::runner::requeue(&mut saved.attempt, error.message.clone());
                        service.store.save_attempt(&saved.attempt).await?;
                        return Err(error);
                    }
                    Err(error)
                }
                result => result,
            };
            match result {
                Ok(mut completed) => {
                    completed.phase = "terminal".into();
                    saved.attempt = completed;
                }
                Err(error)
                    if root.configuration.execution_profile == "workflow_policy"
                        && error.code == "budget_timeout" =>
                {
                    // Seal it below even when retries are disabled, without
                    // inventing worker evidence. A step whose session never
                    // started measured a wait for a local slot, the host's,
                    // not the model's: infrastructure, unscored (owner's
                    // coordinator, 10-18); one that ran is a measured
                    // timeout.
                    saved.attempt = service.store.attempt(&saved.attempt.id).await?;
                    let (outcome, reason) = super::runner::settled_failure(&saved.attempt, &error);
                    saved.attempt.phase = "terminal".into();
                    saved.attempt.outcome = Some(outcome);
                    saved.attempt.reason = Some(reason);
                    saved.attempt.finished_at = Some(now());
                }
                Err(error) if !request.automatic_retry() => {
                    saved.attempt = service.store.attempt(&saved.attempt.id).await?;
                    let (outcome, reason) = super::runner::settled_failure(&saved.attempt, &error);
                    saved.attempt.phase = "terminal".into();
                    saved.attempt.outcome = Some(outcome.clone());
                    saved.attempt.reason = Some(reason.clone());
                    saved.attempt.finished_at = Some(now());
                    service.store.save_attempt(&saved.attempt).await?;
                    aggregate(&mut root, &steps);
                    service.store.save_attempt(&root).await?;
                    // The root settles with what its step settled with.
                    return Err(if outcome == error.code {
                        error
                    } else {
                        BenchmarkError::new(&outcome, reason)
                    });
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
                    let (outcome, reason) = super::runner::settled_failure(&saved.attempt, &error);
                    saved.attempt.phase = "terminal".into();
                    saved.attempt.outcome = Some(outcome);
                    saved.attempt.reason = Some(reason);
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
                    let (outcome, reason) = super::runner::settled_failure(&saved.attempt, &error);
                    saved.attempt.phase = "terminal".into();
                    saved.attempt.outcome = Some(outcome);
                    saved.attempt.reason = Some(reason);
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
            let wall_exhausted = if concurrent_policy {
                // Native execution totals exclude earlier worker-slot waits. An
                // opt-in concurrent trajectory keeps its original whole wall cap.
                match super::artifact_context::remaining_seconds(
                    wall_origin + excluded_waits_ms(&steps),
                    now(),
                    timeout,
                ) {
                    Ok(_) => false,
                    Err(error) if error.code == "budget_timeout" => true,
                    Err(error) => return Err(error),
                }
            } else {
                native_elapsed.is_none()
                    && consumed
                        .unwrap_or(budget_ms)
                        .saturating_add(start.elapsed().as_millis() as u64)
                        > budget_ms
            };
            if wall_exhausted {
                root.outcome = Some("budget_timeout".into());
                root.reason = Some("Workflow exceeded its shared duration budget".into());
                break;
            }
        }
        root.phase = "collecting".into();
        seal_root(&service.store, &mut root, &steps).await?;
        Ok(root)
    })
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
        crate::test_support::TempRoot,
        BenchmarkService,
        Arc<FakeBackend>,
        Attempt,
        BenchmarkVersion,
    ) {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let backend = Arc::new(FakeBackend::default());
        let service = BenchmarkService {
            store,
            backend: backend.clone(),
            wake: Notify::new(),
            active: Default::default(),
            queries: Default::default(),
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
            author_policy: None,
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
            execution_limits: None,
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
        let (directory, service, backend, root, version) = setup().await;
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
        directory.close().await;
    }

    async fn exported_steps(
        service: &BenchmarkService,
        include_held_out: bool,
    ) -> (serde_json::Value, Vec<serde_json::Value>) {
        let result = super::super::export::export(
            &service.store,
            &service.query_data().await.unwrap(),
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
        let (directory, service, _, root, version) = setup().await;
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
        directory.close().await;
    }

    #[tokio::test]
    async fn changed_step_input_is_refused_before_dispatch_and_export() {
        let (directory, service, backend, root, version) = setup().await;
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
                &service.query_data().await.unwrap(),
                false
            )
            .await
            .unwrap_err()
            .code,
            "evidence_mismatch"
        );
        directory.close().await;
    }

    #[tokio::test]
    async fn legacy_step_export_does_not_invent_a_pre_dispatch_decision() {
        let (directory, service, _, root, version) = setup().await;
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
        directory.close().await;
    }

    #[tokio::test]
    async fn step_export_requires_explicit_heldout_scope_and_omits_later_outcomes() {
        let (directory, service, _, root, mut version) = setup().await;
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
        service.store.forget_parsed();
        assert!(exported_steps(&service, false).await.1.is_empty());
        assert_eq!(exported_steps(&service, true).await.1.len(), 2);
        version.manifest.split = "development".into();
        sqlx::query("UPDATE benchmark_versions SET manifest_json=? WHERE id=?")
            .bind(serde_json::to_string(&version.manifest).unwrap())
            .bind(&version.id)
            .execute(&service.store.pool)
            .await
            .unwrap();
        service.store.forget_parsed();
        assert!(exported_steps(&service, true).await.1.is_empty());
        directory.close().await;
    }

    #[tokio::test]
    async fn auxiliary_work_is_preserved_when_a_later_step_is_cancelled() {
        let (directory, service, _, root, version) = setup().await;
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
        directory.close().await;
    }

    /// A workflow root's speed is compared under its most loaded step's
    /// admission, so a root carries that step's record.
    #[tokio::test]
    async fn a_root_carries_its_most_loaded_steps_admission() {
        let (directory, service, _, root, version) = setup().await;
        let (_tx, cancel) = watch::channel(false);
        let mut result = execute(&service, root, version, 30, cancel).await.unwrap();
        let mut steps = saved_steps(&service.store, &result.id).await.unwrap();
        aggregate(&mut result, &steps);
        assert_eq!(result.sandbox_admission, None);
        for (step, heavy) in steps.iter_mut().zip([4, 1]) {
            step.attempt.sandbox_admission = Some(
                serde_json::from_value(json!({
                    "lane":"heavy","competing":{},"competingHeavy":heavy,"reservedMemory":0,
                    "reservedCpu":0,"memoryCurrent":0,"guestLoad":[0.0,0.0,0.0],"guestCpus":16,
                    "guestMemAvailable":0,"hostAvailableRam":0,"hostAvailableCommit":0
                }))
                .unwrap(),
            );
        }
        aggregate(&mut result, &steps);
        assert_eq!(
            result
                .sandbox_admission
                .map(|admission| admission.competing_heavy),
            Some(4)
        );
        directory.close().await;
    }

    #[tokio::test]
    async fn workflow_runs_fresh_steps_once_and_retains_declared_feedback() {
        let (directory, service, backend, root, version) = setup().await;
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
        directory.close().await;
    }

    #[tokio::test]
    async fn workflow_cancel_acknowledges_active_child_and_never_starts_next() {
        let (directory, service, backend, root, version) = setup().await;
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
        directory.close().await;
    }

    /// A step the host refused before any provider call goes back to the
    /// queue with its workflow, which the runner holds for the operator; the
    /// next pass runs that step, never settles it.
    #[tokio::test]
    async fn a_step_refused_before_its_session_waits_with_its_workflow() {
        let (directory, service, backend, root, version) = setup().await;
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
        directory.close().await;
    }

    #[tokio::test]
    async fn workflow_recovery_waits_for_resume_and_never_repeats_completed_prefix() {
        let (directory, service, backend, root, version) = setup().await;
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
        directory.close().await;
    }

    #[tokio::test]
    async fn uncertain_workflow_step_is_never_automatically_resent() {
        let (directory, service, backend, root, version) = setup().await;
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
        directory.close().await;
    }

    #[tokio::test]
    async fn workflow_recovery_checks_selection_and_budget_before_final_evaluation() {
        let (directory, service, backend, root, version) = setup().await;
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
        directory.close().await;
    }

    #[tokio::test]
    async fn sealed_workflow_cancellation_without_output_survives_restart() {
        let (directory, service, backend, root, version) = setup().await;
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
        directory.close().await;
    }

    #[tokio::test]
    async fn workflow_entry_content_hash_matches_candidates_and_changes_with_feedback() {
        let (directory, _service, _backend, first, version) = setup().await;
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
        directory.close().await;
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
