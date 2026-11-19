//! Closing a root: the aggregate of its steps, its seal, and what stops it with a child.
use super::*;

pub(super) fn aggregate(root: &mut Attempt, steps: &[SavedStep]) {
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
    // A root's speed is measured under its most loaded step's admission. A
    // step that ran without a recorded one could have been more loaded than
    // any recorded, so the whole root is unrecorded then.
    root.sandbox_admission = if executed
        .iter()
        .any(|step| step.attempt.sandbox_admission.is_none())
    {
        None
    } else {
        executed
            .iter()
            .filter_map(|step| step.attempt.sandbox_admission.as_ref())
            .max_by_key(|admission| admission.competing_heavy)
            .cloned()
    };
    if let Some(auxiliary) = executed
        .iter()
        .find(|step| step.attempt.usage.schema == "provider_turn_with_auxiliary_v2")
    {
        root.usage.schema = "workflow_sum_with_auxiliary_v2".into();
        if root.observed.is_none() {
            root.observed = auxiliary.attempt.observed.clone();
        }
        // The marker is the text profile's, as for a single turn: a
        // repository case's tool turns need several calls and keep their
        // profile, or the board would read the repetition as a text one,
        // apart from the rest of its case's cell.
        if root.configuration.execution_profile == "native_text" {
            if let Some(observed) = root.observed.as_mut() {
                observed.execution_profile = "native_text_auxiliary".into();
            }
        }
    }
    if root.configuration.execution_profile == "workflow_policy" {
        // No single executor produced this result. Each step keeps its own
        // observed configuration, and the root remains a policy measurement.
        root.observed = None;
        root.resolved_model = None;
    }
}

pub(super) async fn seal_root(
    store: &Store,
    root: &mut Attempt,
    steps: &[SavedStep],
) -> Result<()> {
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

pub(super) fn stop_with_child(root: &mut Attempt, child: &Attempt) {
    root.output = child.output.clone();
    root.outcome = child.outcome.clone();
    root.reason = child.reason.clone();
    root.phase = "collecting".into();
}

pub(super) fn prefix_violation(
    steps: &[SavedStep],
    budget_ms: u64,
) -> Option<(&'static str, &'static str)> {
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
                crate::services::benchmarks::routing::candidate_key(observed)
                    != crate::services::benchmarks::routing::candidate_key(&s.attempt.configuration)
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
pub(in crate::services::benchmarks) fn remaining_seconds(cap: u32, elapsed_ms: u64) -> Option<u32> {
    let remaining = (u64::from(cap) * 1000).saturating_sub(elapsed_ms);
    (remaining > 0).then(|| remaining.div_ceil(1000) as u32)
}

pub(in crate::services::benchmarks) fn committed_report(output: &str) -> String {
    serde_json::to_string(&json!({"outcome":"completed","output":output}))
        .expect("public string report")
}
