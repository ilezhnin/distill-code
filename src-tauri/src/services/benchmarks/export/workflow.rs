//! Steps are dependent observations of a root workflow, never extra scored tasks.
use super::*;

pub(super) async fn rows(
    store: &Store,
    data: &QueryData,
    exported: &[Value],
    salt: &str,
    cutoff: i64,
) -> Result<Vec<Value>> {
    let root_ids: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT root_attempt_id FROM workflow_steps ORDER BY root_attempt_id",
    )
    .fetch_all(&store.pool)
    .await?;
    let mut result = Vec::new();
    for root_id in root_ids {
        let root = store.attempt(&root_id).await?;
        if !exported
            .iter()
            .any(|row| row["runId"] == root.run_id && row["taskVersion"] == root.version_id)
        {
            continue;
        }
        let version = data
            .versions
            .iter()
            .find(|v| v.id == root.version_id)
            .ok_or_else(|| {
                BenchmarkError::new("evidence_missing", "Workflow root version is unavailable")
            })?;
        for step in super::super::workflow::saved_steps(store, &root_id).await? {
            if step
                .decision
                .as_ref()
                .is_some_and(|d| d.snapshot.created_at > cutoff)
            {
                continue;
            }
            // Unknown legacy preparation time cannot establish historical inputs.
            // Its existing observations remain inspectable without a reconstructed
            // decision or an input suitable for fitting a selector.
            let excluded = super::super::routing::authored_by_candidate(
                &version.manifest,
                &step.attempt.configuration,
            ) || step.attempt.observed.as_ref().is_some_and(|c| {
                super::super::routing::authored_by_candidate(&version.manifest, c)
            });
            let terminal = step.attempt.phase == "terminal"
                && step.attempt.finished_at.is_some_and(|at| at <= cutoff);
            let mut outcome = observation(
                terminal.then_some(&step.attempt),
                root.repetition,
                excluded,
                salt,
                Some(cutoff),
            );
            outcome["attemptId"] = json!(step.attempt.id);
            // Intermediate steps have no independent success label. In particular,
            // neither root pass/fail nor a budget failure is a per-step reward.
            outcome["reward"] = Value::Null;
            outcome["observed"] = json!(false);
            outcome["rewardReason"] = json!("quality_is_evaluated_for_the_complete_workflow_only");
            let decision = step.decision.as_ref().map(|record| {
                let snapshot = &record.snapshot;
                json!({"rootDecisionId":record.root_decision_id,"contentHash":record.content_hash,
                    "driverRevision":record.driver_revision,"record":decision_record(snapshot,salt),
                    "selectedConfiguration":public_configuration(&snapshot.request.configurations[0],salt),
                    "features":{"prompt":snapshot.public_prompt,"fixtures":snapshot.public_fixtures,
                        "workClassId":snapshot.work_class_id,"roleId":snapshot.role_id,"rolePrompt":snapshot.role_prompt,
                        "facets":snapshot.facets,"roleContextHash":snapshot.role_context_hash,"entryState":snapshot.entry_state},
                    "availability":"root_configuration_pin_not_a_fresh_worker_pool_observation"})
            });
            result.push(json!({"schemaVersion":1,"candidateKeyAlgorithm":super::super::routing::CANDIDATE_KEY_ALGORITHM,
                "runId":root.run_id,"rootAttemptId":root_id,"rootRepetition":root.repetition,
                "taskVersion":root.version_id,"family":version.manifest.task_family,
                "splitGroup":split_group(&version.manifest),"split":version.manifest.split,
                "stepIndex":step.index,"stepId":step.id,"parentStepId":step.parent_id,
                "attemptId":step.attempt.id,"entryStateHash":step.entry.content_hash,
                "decisionStatus":if decision.is_some(){"committed_before_dispatch"}else{"legacy_missing_pre_dispatch_decision"},
                "decision":decision,"outcome":outcome,"independentTask":false,
                "counterfactualOutcomesAvailable":false}));
        }
    }
    Ok(result)
}
