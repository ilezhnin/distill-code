//! Bounded workflows use fresh owned sessions and committed public step inputs.
use super::{
    fixtures,
    store::{event, now, Store},
    types::*,
    BenchmarkService,
};
use serde_json::json;
use sqlx::Row;
use std::{collections::HashSet, time::Instant};
use tokio::sync::watch;

pub fn validate(draft: &BenchmarkDraft) -> Vec<String> {
    let Some(workflow) = &draft.workflow else {
        return Vec::new();
    };
    let mut issues = Vec::new();
    if workflow.schema_version != 1 || workflow.driver_revision.trim().is_empty() {
        issues.push("Workflow requires schema 1 and a frozen driver revision".into());
    }
    if !(2..=4).contains(&workflow.steps.len()) {
        issues.push("A bounded workflow requires 2–4 steps".into());
    }
    if draft.measurement_profile != "task_metrics" {
        issues.push("Bounded workflows currently support task metrics only".into());
    }
    if !matches!(
        draft.evaluator.kind.as_str(),
        "exact" | "json" | "javascript" | "browser"
    ) {
        issues.push("A workflow requires a final objective evaluator".into());
    }
    let mut ids = HashSet::new();
    for (index, step) in workflow.steps.iter().enumerate() {
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

struct SavedStep {
    index: usize,
    id: String,
    parent_id: Option<String>,
    entry: EntryState,
    prompt: String,
    attempt: Attempt,
}

async fn saved_steps(store: &Store, root_id: &str) -> Result<Vec<SavedStep>> {
    let rows = sqlx::query("SELECT step_index,step_id,parent_step_id,entry_state_json,prompt,data_json FROM workflow_steps WHERE root_attempt_id=? ORDER BY step_index")
        .bind(root_id).fetch_all(&store.pool).await?;
    rows.into_iter()
        .map(|row| {
            Ok(SavedStep {
                index: row.get::<i64, _>(0) as usize,
                id: row.get(1),
                parent_id: row.get(2),
                entry: serde_json::from_str(row.get(3))?,
                prompt: row.get(4),
                attempt: serde_json::from_str(row.get(5))?,
            })
        })
        .collect()
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
    store: &Store,
    root: &Attempt,
    version: &BenchmarkVersion,
    index: usize,
    remaining: u32,
    previous: Option<&str>,
) -> Result<SavedStep> {
    let workflow = version.manifest.workflow.as_ref().unwrap();
    let spec = &workflow.steps[index];
    let entry = step_entry(root, &version.manifest, index, remaining, previous)?;
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
    child.output = None;
    child.evidence_hash = None;
    child.usage = TokenUsage::default();
    child.evaluations.clear();
    child.event_cursor = 0;
    child.workflow_steps.clear();
    let saved = SavedStep {
        index,
        id: spec.id.clone(),
        parent_id: entry.parent_step_id.clone(),
        entry,
        prompt,
        attempt: child,
    };
    let mut tx = store.pool.begin().await?;
    sqlx::query("INSERT INTO workflow_steps(attempt_id,root_attempt_id,step_index,step_id,parent_step_id,entry_state_hash,entry_state_json,prompt,phase,data_json) VALUES(?,?,?,?,?,?,?,?,'pending',?)")
        .bind(&saved.attempt.id).bind(&root.id).bind(index as i64).bind(&saved.id).bind(&saved.parent_id)
        .bind(&saved.entry.content_hash).bind(serde_json::to_string(&saved.entry)?).bind(&saved.prompt)
        .bind(serde_json::to_string(&saved.attempt)?).execute(&mut *tx).await?;
    event(&mut tx, &root.run_id, "workflow_step_prepared").await?;
    tx.commit().await?;
    Ok(saved)
}

fn step_version(version: &BenchmarkVersion, saved: &SavedStep) -> BenchmarkVersion {
    let mut result = version.clone();
    result.manifest.workflow = None;
    result.manifest.prompt = saved.prompt.clone();
    result.manifest.entry_state = Some(saved.entry.clone());
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
    if let Some(last) = executed.last() {
        root.started_at = executed
            .iter()
            .filter_map(|step| step.attempt.started_at)
            .min();
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
}

async fn seal_root(store: &Store, root: &mut Attempt, steps: &[SavedStep]) -> Result<()> {
    aggregate(root, steps);
    root.finished_at = steps
        .iter()
        .filter_map(|step| step.attempt.finished_at)
        .max()
        .or_else(|| Some(now()));
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
    if let Some(first) = completed.first() {
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
    let mut steps = saved_steps(&service.store, &root.id).await?;
    let consumed = steps
        .iter()
        .filter(|s| s.attempt.phase == "terminal")
        .try_fold(0u64, |sum, step| {
            step.attempt.duration_ms.and_then(|ms| sum.checked_add(ms))
        });
    let start = Instant::now();
    let budget_ms = u64::from(timeout.min(version.manifest.limits.timeout_seconds)) * 1000;
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
        let remaining_ms = budget_ms
            .saturating_sub(consumed.unwrap_or(budget_ms))
            .saturating_sub(start.elapsed().as_millis() as u64);
        let remaining = remaining_ms.div_ceil(1000) as u32;
        if remaining_ms == 0 {
            root.outcome = Some("budget_timeout".into());
            root.reason = Some("Workflow exhausted its shared duration budget".into());
            break;
        }
        if steps.len() == index {
            let previous = steps.last().and_then(|s| s.attempt.output.as_deref());
            steps.push(
                prepare_step(&service.store, &root, &version, index, remaining, previous).await?,
            );
            aggregate(&mut root, &steps);
            service.store.save_attempt(&root).await?;
        }
        let saved = &mut steps[index];
        saved.attempt.phase = "preparing".into();
        saved.attempt.started_at = Some(now());
        service.store.save_attempt(&saved.attempt).await?;
        let effective_version = step_version(&version, saved);
        let result = service
            .backend
            .execute(
                &service.store,
                saved.attempt.clone(),
                effective_version,
                remaining.min(saved.entry.remaining_budget_seconds),
                cancel.clone(),
            )
            .await;
        match result {
            Ok(mut completed) => {
                completed.phase = "terminal".into();
                saved.attempt = completed;
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
        if consumed
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
    let budget_ms = u64::from(timeout.min(version.manifest.limits.timeout_seconds)) * 1000;
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
    use tokio::sync::{Mutex, Notify};

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
            active: Mutex::new(None),
            app: None,
        };
        let mut draft = super::super::runner::seed_definitions().remove(0);
        draft.workflow = Some(WorkflowSpec {
            schema_version: 1,
            driver_revision: "test-v1".into(),
            steps: vec![
                WorkflowStep {
                    id: "plan".into(),
                    prompt: "Produce a plan.".into(),
                    include_previous_output: false,
                },
                WorkflowStep {
                    id: "answer".into(),
                    prompt: "Produce the final structured answer.".into(),
                    include_previous_output: true,
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
            }],
            repetitions: 1,
            timeout_seconds: 30,
            max_executions: 2,
            preview: false,
        };
        let run = service.start_run(request).await.unwrap();
        let mut root = run.attempts[0].clone();
        root.phase = "preparing".into();
        root.started_at = Some(now());
        service.store.save_attempt(&root).await.unwrap();
        (directory, service, backend, root, version)
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
        aggregate(&mut result, &steps);
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

    #[tokio::test]
    async fn workflow_recovery_waits_for_resume_and_never_repeats_completed_prefix() {
        let (_directory, service, backend, root, version) = setup().await;
        let mut first = prepare_step(&service.store, &root, &version, 0, 30, None)
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
        let mut first = prepare_step(&service.store, &root, &version, 0, 30, None)
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
        let mut first = prepare_step(&service.store, &root, &version, 0, 30, None)
            .await
            .unwrap();
        let mut second = prepare_step(
            &service.store,
            &root,
            &version,
            1,
            29,
            Some("public report"),
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
            }],
        });
        assert!(validate(&draft).len() >= 2);
    }
}
