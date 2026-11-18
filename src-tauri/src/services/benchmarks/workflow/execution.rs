//! Running a workflow root step by step, and picking it up after a restart.
use super::*;

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
            == Some(crate::services::benchmarks::artifact_context::CLOCK_RECIPE);
        let concurrency = if root.configuration.execution_profile == "workflow_policy" {
            let request = service.store.run(&root.run_id).await?.request;
            service
                .store
                .workflow_campaign_concurrency(&request.request_key)
                .await?
        } else {
            crate::services::benchmarks::workflow_campaign::CampaignConcurrency::SERIAL
        };
        let concurrent_policy = concurrency.concurrent();
        let step_admission = concurrency.admission
            == crate::services::benchmarks::workflow_campaign::WorkerAdmission::SelectedStep;
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
            let lease = crate::services::benchmarks::artifact_context::BudgetLease {
                recipe: crate::services::benchmarks::artifact_context::CLOCK_RECIPE.into(),
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
                let (outcome, reason) =
                    crate::services::benchmarks::runner::settled_failure(&root, &error);
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
                match crate::services::benchmarks::artifact_context::remaining_seconds(
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
                let (outcome, reason) =
                    crate::services::benchmarks::runner::settled_failure(&root, &exhausted);
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
                        let (outcome, reason) =
                            crate::services::benchmarks::runner::settled_failure(&root, &error);
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
                .all(|step| !crate::services::benchmarks::runner::reached_provider(&step.attempt));
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
                            crate::services::benchmarks::runner::turn_owner(&saved.attempt),
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
                                    "resource_busy"
                                        | crate::services::benchmarks::runner::SIGN_IN_WAIT
                                )
                                && later_step_may_wait(first_try, allowance, now()) =>
                        {
                            let current = service.store.attempt(&saved.attempt.id).await?;
                            (current.phase == "preparing"
                                && !crate::services::benchmarks::runner::reached_provider(&current))
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
                            "resource_busy" | crate::services::benchmarks::runner::SIGN_IN_WAIT
                        )
                        && root.configuration.execution_profile != "workflow_policy" =>
                {
                    let current = service.store.attempt(&saved.attempt.id).await?;
                    if current.phase == "preparing"
                        && !crate::services::benchmarks::runner::reached_provider(&current)
                    {
                        saved.attempt = current;
                        crate::services::benchmarks::runner::requeue(
                            &mut saved.attempt,
                            error.message.clone(),
                        );
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
                    let (outcome, reason) = crate::services::benchmarks::runner::settled_failure(
                        &saved.attempt,
                        &error,
                    );
                    saved.attempt.phase = "terminal".into();
                    saved.attempt.outcome = Some(outcome);
                    saved.attempt.reason = Some(reason);
                    saved.attempt.finished_at = Some(now());
                }
                Err(error) if !request.automatic_retry() => {
                    saved.attempt = service.store.attempt(&saved.attempt.id).await?;
                    let (outcome, reason) = crate::services::benchmarks::runner::settled_failure(
                        &saved.attempt,
                        &error,
                    );
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
                    let (outcome, reason) = crate::services::benchmarks::runner::settled_failure(
                        &saved.attempt,
                        &error,
                    );
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
                    if crate::services::benchmarks::runner::returns_to_queue(
                        &error.code,
                        &saved.attempt.phase,
                    ) {
                        crate::services::benchmarks::runner::requeue(
                            &mut saved.attempt,
                            error.message.clone(),
                        );
                        service.store.save_attempt(&saved.attempt).await?;
                        return Err(error);
                    }
                    let (outcome, reason) = crate::services::benchmarks::runner::settled_failure(
                        &saved.attempt,
                        &error,
                    );
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
                match crate::services::benchmarks::artifact_context::remaining_seconds(
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
