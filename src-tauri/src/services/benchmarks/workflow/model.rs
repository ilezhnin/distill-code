//! A workflow's vocabulary: its validation, a step's decision and context, the trace and its timing.
use super::*;

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
    ) && !matches!(
        crate::services::benchmarks::judge_panel::frozen(draft, &[]),
        Ok(Some(_))
    ) {
        issues.push("A workflow requires an objective evaluator or a frozen rubric panel".into());
    }
    let mut ids = HashSet::new();
    for (index, step) in workflow.steps.iter().enumerate() {
        if workflow.schema_version == 2 {
            if draft
                .environment
                .get("nativeBudgetRecipe")
                .and_then(serde_json::Value::as_str)
                != Some(crate::services::benchmarks::artifact_context::CLOCK_RECIPE)
                || step.scope.as_ref().is_none_or(|scope| {
                    scope.role_id.trim().is_empty()
                        || scope.role_prompt.trim().is_empty()
                        || scope.role_prompt.len() > 64 * 1024
                        || !crate::services::benchmarks::routing::WORK_CLASSES
                            .contains(&scope.work_class_id.as_str())
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
pub(in crate::services::benchmarks) struct StepDecision {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<crate::services::benchmarks::executor::Decision>,
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
pub(in crate::services::benchmarks) struct NativeStepContext {
    pub budget: crate::services::benchmarks::artifact_context::BudgetLease,
    pub repository: Option<crate::services::benchmarks::artifact_context::Input>,
    /// Time the step waited for its decided worker's slot under step
    /// admission, excluded from its root's wall clock. Absent elsewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_wait_ms: Option<u64>,
}

impl StepDecision {
    pub(super) fn hash(&self) -> Result<String> {
        let mut value = self.clone();
        value.content_hash.clear();
        Ok(fixtures::hash(&serde_json::to_vec(&value)?))
    }
}

/// A final judge must be independent of every worker that contributed to the
/// answer, including earlier steps and acknowledged provider substitutions.
pub(in crate::services::benchmarks) async fn judge_candidates(
    store: &Store,
    root: &Attempt,
) -> Result<Vec<Configuration>> {
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
    pub executor_decision: Option<crate::services::benchmarks::executor::Decision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub root: Attempt,
    pub policy: Option<crate::services::benchmarks::workflow_policy::WorkflowPolicy>,
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
pub(in crate::services::benchmarks) fn campaign_timing(
    root: &Attempt,
    steps: &[SavedStep],
) -> Result<WorkflowTiming> {
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
            || lease.recipe != crate::services::benchmarks::artifact_context::CLOCK_RECIPE
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
