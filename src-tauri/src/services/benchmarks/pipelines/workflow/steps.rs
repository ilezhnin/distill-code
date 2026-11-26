//! One step: its entry, its preparation and admission, its prompt and its commit.
use super::*;

pub(super) fn step_entry(
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
    entry.content_hash = crate::services::benchmarks::routing::entry_hash(&entry);
    Ok(entry)
}

pub(super) async fn prepare_step(
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
        == Some(crate::services::benchmarks::artifact_context::CLOCK_RECIPE);
    let budget = if new_clock || concurrent_policy {
        let origin = root.started_at.ok_or_else(|| {
            BenchmarkError::new(
                "budget_clock_conflict",
                "Native workflow root clock is absent",
            )
        })?;
        let root_budget = crate::services::benchmarks::artifact_context::BudgetLease {
            recipe: crate::services::benchmarks::artifact_context::CLOCK_RECIPE.into(),
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
    entry.content_hash = crate::services::benchmarks::routing::entry_hash(&entry);
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
pub(super) async fn repository_input(
    store: &Store,
    root: &Attempt,
    version: &BenchmarkVersion,
    spec: &WorkflowStep,
    deadline_ms: i64,
) -> Result<Option<crate::services::benchmarks::artifact_context::Input>> {
    if version.manifest.execution_profile != "protected_repository" {
        return Ok(None);
    }
    {
        let snapshot = crate::services::benchmarks::repository::snapshot(&version.manifest)?;
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
        let package = crate::services::benchmarks::repository::advance_until(
            &snapshot,
            &lineage,
            spec.include_previous_output,
            version.manifest.limits.max_artifact_bytes as usize,
            deadline_ms.try_into().map_err(|_| {
                BenchmarkError::new("budget_clock_conflict", "Native deadline is invalid")
            })?,
        )
        .await?;
        Ok(Some(crate::services::benchmarks::artifact_context::Input {
            before: package.artifact,
            lineage,
            access_all: spec.include_previous_output,
        }))
    }
}

/// The step's own attempt record: the root's identity and configuration
/// before any dispatch, with nothing measured yet.
pub(super) fn child_attempt(root: &Attempt, index: usize) -> Attempt {
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
pub(super) async fn commit_step(
    store: &Store,
    root: &Attempt,
    version: &BenchmarkVersion,
    mut saved: SavedStep,
    executor: Option<crate::services::benchmarks::executor::Decision>,
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
    let mut snapshot = crate::services::benchmarks::routing::snapshot(
        &root.run_id,
        &step_version(version, &saved),
        &request,
    );
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
pub(super) fn step_prompt(version: &BenchmarkVersion, index: usize, spec: &WorkflowStep) -> String {
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
pub(super) fn check_public_bytes(
    version: &BenchmarkVersion,
    prompt: &str,
    entry: &EntryState,
) -> Result<()> {
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
pub(in crate::services::benchmarks) const LATER_STEP_RETRY: std::time::Duration =
    std::time::Duration::from_secs(10);

#[cfg(test)]
pub(in crate::services::benchmarks) const LATER_STEP_RETRY: std::time::Duration =
    std::time::Duration::from_millis(50);

/// Whether a later step first tried at `first_try` with `allowance` seconds
/// may still wait for sandbox room at `now`: the next try must start within
/// the first quarter of its allowance.
pub(in crate::services::benchmarks) fn later_step_may_wait(
    first_try: i64,
    allowance: u32,
    now: i64,
) -> bool {
    let next = now.saturating_sub(first_try) + LATER_STEP_RETRY.as_millis() as i64;
    next <= i64::from(allowance) * 1000 / 4
}

/// Worker-slot waits the steps of a step-admitted root recorded; its wall
/// clock runs from admission without them.
pub(super) fn excluded_waits_ms(steps: &[SavedStep]) -> i64 {
    steps
        .iter()
        .filter_map(|step| step.native_context.as_ref().and_then(|c| c.local_wait_ms))
        .sum::<u64>() as i64
}

/// A step's own allowance: its schema-2 scope, else the case limit on the
/// native clock, else the root's; never above the root's.
pub(super) fn step_cap_seconds(
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
pub(super) async fn prepare_step_admitted(
    service: &BenchmarkService,
    root: &Attempt,
    version: &BenchmarkVersion,
    index: usize,
    remaining: u32,
    previous: Option<&str>,
    native_reports: Option<Vec<String>>,
    concurrency: &crate::services::benchmarks::workflow_campaign::CampaignConcurrency,
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
        == Some(crate::services::benchmarks::artifact_context::CLOCK_RECIPE);
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
            // The root's credits move its deadline, as its lease's: a
            // campaign root has one only for an earlier step's sealed answer
            // that waited for the store (`keep_sealed`).
            origin + i64::from(root_cap) * 1000 + store.root_credit_ms(&root.id).await?,
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
    entry.content_hash = crate::services::benchmarks::routing::entry_hash(&entry);
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
            budget: crate::services::benchmarks::artifact_context::BudgetLease {
                recipe: crate::services::benchmarks::artifact_context::CLOCK_RECIPE.into(),
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
            crate::services::benchmarks::runner::account_slots_within(
                &root.run_id,
                &crate::services::benchmarks::runner::quota_scope(&chosen),
                concurrency.account_slots,
            ),
            cancel,
        )
        .await?;
    let origin = origin + waited as i64;
    let root_budget = crate::services::benchmarks::artifact_context::BudgetLease {
        recipe: crate::services::benchmarks::artifact_context::CLOCK_RECIPE.into(),
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

pub(super) fn step_version(version: &BenchmarkVersion, saved: &SavedStep) -> BenchmarkVersion {
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
        result.manifest.environment[crate::services::benchmarks::artifact_context::CLOCK_KEY] =
            serde_json::to_value(&context.budget).expect("native budget");
        if let Some(input) = &context.repository {
            result.manifest.environment[crate::services::benchmarks::artifact_context::INPUT_KEY] =
                serde_json::to_value(input).expect("native artifact input");
        }
    }
    result
}
