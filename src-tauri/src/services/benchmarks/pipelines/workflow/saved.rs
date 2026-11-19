//! The steps a workflow root has saved, and what a try no provider saw leaves to discard.
use super::*;

pub(in crate::services::benchmarks) struct SavedStep {
    pub index: usize,
    pub id: String,
    pub parent_id: Option<String>,
    pub entry: EntryState,
    pub prompt: String,
    pub attempt: Attempt,
    pub decision: Option<StepDecision>,
    pub native_context: Option<NativeStepContext>,
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
    pub(in crate::services::benchmarks) fn validate_decision(&self, root_id: &str) -> Result<()> {
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
                self.entry.content_hash
                    == crate::services::benchmarks::routing::entry_hash(&self.entry),
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
                        == Some(
                            crate::services::benchmarks::routing::candidate_key(configuration)
                                .as_str(),
                        ),
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

pub(in crate::services::benchmarks) async fn saved_steps(
    store: &Store,
    root_id: &str,
) -> Result<Vec<SavedStep>> {
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
                    != crate::services::benchmarks::learned::PublicTask::from(
                        &step_version(&version, step).manifest,
                    )
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
pub(in crate::services::benchmarks) async fn discard_unstarted(
    store: &Store,
    root: &Attempt,
) -> Result<bool> {
    let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await?;
    let steps: Vec<String> =
        sqlx::query_scalar("SELECT data_json FROM workflow_steps WHERE root_attempt_id=?")
            .bind(&root.id)
            .fetch_all(&mut *tx)
            .await?;
    for step in &steps {
        let step: Attempt = serde_json::from_str(step)?;
        if crate::services::benchmarks::runner::reached_provider(&step)
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
pub(in crate::services::benchmarks) async fn effective_version_for_attempt(
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
        return crate::services::benchmarks::runner::collection_context::recover(
            store, attempt, version,
        )
        .await;
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
