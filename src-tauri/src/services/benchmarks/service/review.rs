//! Closing a window, the operator's review of an answer, and scoring a saved answer again.
use super::*;

impl BenchmarkService {
    /// Bakes a run whose window closed: its complete cells stand, every other
    /// attempt is superseded, so the run holds only what was measured whole
    /// in its sitting. Completeness is the protocol's, not the plan's, so a
    /// run that planned fewer repetitions keeps nothing. A run still open is
    /// completed as it stands.
    pub(in crate::services) async fn bake(&self, run: &BenchmarkRun, at: i64) -> Result<()> {
        // Immediate: sealing reads each attempt's reason before it writes,
        // and SQLite refuses at once, without waiting, to upgrade a read
        // another writer has overtaken.
        let mut tx = self.store.pool.begin_with("BEGIN IMMEDIATE").await?;
        Self::bake_in_transaction(&mut tx, run, at).await?;
        tx.commit().await?;
        self.changed().await;
        Ok(())
    }

    pub(in super::super) async fn bake_in_transaction(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        run: &BenchmarkRun,
        at: i64,
    ) -> Result<()> {
        let required = run.request.repetitions.max(analysis::REQUIRED_REPETITIONS);
        let mut settled = None;
        for (_, attempts) in analysis::run_cells(run) {
            let scored = attempts
                .iter()
                .filter(|a| analysis::score(a).is_some())
                .count() as u32;
            if scored >= required {
                settled = settled.max(attempts.iter().filter_map(|a| a.finished_at).max());
                continue;
            }
            if never_measured(&attempts) {
                continue;
            }
            for attempt in attempts {
                if matches!(attempt.outcome.as_deref(), Some("excluded" | "unsupported")) {
                    continue;
                }
                let mut dropped = attempt;
                dropped.reason = Some(format!(
                    "Dropped when the sitting was sealed: {scored} of {required} repetitions were scored (this one: {})",
                    dropped.outcome.as_deref().unwrap_or("never ran")
                ));
                dropped.outcome = Some(analysis::SUPERSEDED.into());
                dropped.phase = "terminal".into();
                if dropped.finished_at.is_none() {
                    dropped.finished_at = Some(at);
                }
                // Run summaries omit output. Change only lifecycle fields so
                // superseding never erases the stored answer or paid usage.
                Store::supersede_in_transaction(tx, &dropped).await?;
            }
        }
        if !matches!(run.state.as_str(), "completed" | "cancelled") {
            // Completed when its last counted cell settled, not when the
            // window closed: the point keeps the date of its measurement.
            sqlx::query("UPDATE run_plans SET state='completed',updated_at=? WHERE id=?")
                .bind(settled.unwrap_or(run.updated_at))
                .bind(&run.id)
                .execute(&mut **tx)
                .await?;
        }
        sqlx::query("UPDATE run_plans SET baked_at=?,revision=revision+1 WHERE id=?")
            .bind(at)
            .bind(&run.id)
            .execute(&mut **tx)
            .await?;
        event(tx, &run.id, "run_changed").await?;
        Ok(())
    }

    pub async fn review(
        &self,
        id: &str,
        score: f64,
        reason: String,
        details: Option<serde_json::Value>,
    ) -> Result<Attempt> {
        let lock = evaluation_lock(id);
        let _guard = lock.lock().await;
        if let Some(details) = &details {
            let valid = details.as_object().is_some_and(|map| {
                !map.is_empty()
                    && map.values().all(|v| {
                        v.as_f64()
                            .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
                    })
            });
            if !valid {
                return Err(BenchmarkError::new(
                    "validation",
                    "Criterion scores must be numbers from 0 to 1",
                ));
            }
        }
        if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM workflow_steps WHERE attempt_id=?")
            .bind(id)
            .fetch_one(&self.store.pool)
            .await?
            != 0
        {
            return Err(BenchmarkError::new(
                "validation",
                "Workflow step evidence cannot be rescored as a final result",
            ));
        }
        if !score.is_finite() || !(0.0..=1.0).contains(&score) || reason.trim().is_empty() {
            return Err(BenchmarkError::new(
                "validation",
                "Review needs a score from 0 to 1 and rationale",
            ));
        }
        let mut a = self.store.attempt(id).await?;
        self.store
            .require_current_versions(std::slice::from_ref(&a.version_id))
            .await?;
        self.store
            .require_independent_run(&self.store.run(&a.run_id).await?.request.request_key)
            .await?;
        let v = self.store.version(&a.version_id).await?;
        let visual = matches!(v.manifest.evaluator.kind.as_str(), "javascript" | "browser");
        let rubric = if visual {
            v.manifest.environment["visualRubric"]
                .as_str()
                .unwrap_or(&v.manifest.evaluator.rubric)
        } else {
            &v.manifest.evaluator.rubric
        };
        if (!visual && v.manifest.evaluator.kind != "rubric")
            || rubric.trim().is_empty()
            || a.phase != "terminal"
            || a.output.is_none()
        {
            return Err(BenchmarkError::new(
                "validation",
                "A finished output and a published review rubric are required",
            ));
        }
        // An override replaces a verdict; a budget failure or an unscored
        // outcome has none to replace.
        if !visual
            && !matches!(
                self.store.stored_outcome(id).await?.as_deref(),
                Some(
                    "pass"
                        | "fail"
                        | "completed"
                        | "evaluation_error"
                        | "pending_review"
                        | "judged"
                )
            )
        {
            return Err(BenchmarkError::new(
                "validation",
                "Only an evaluated result can be reviewed",
            ));
        }
        a.evaluations.push(Evaluation {
            id: uuid::Uuid::new_v4().to_string(),
            evaluator_revision: v.manifest.evaluator.revision,
            verdict: if score == 1.0 { "pass" } else { "fail" }.into(),
            score: Some(score),
            reason,
            created_at: now(),
            provenance: if visual { "human_visual" } else { "human" }.into(),
            artifacts: Vec::new(),
            details,
            judge: None,
            usage: None,
        });
        if !visual {
            a.outcome = Some(if score == 1.0 { "pass" } else { "fail" }.into());
        }
        self.store.save_attempt(&a).await?;
        Ok(a)
    }

    pub async fn rescore(&self, id: &str) -> Result<Attempt> {
        let lock = evaluation_lock(id);
        let Ok(_guard) = lock.try_lock() else {
            return Err(BenchmarkError::new(
                "validation",
                "This attempt is already being evaluated",
            ));
        };
        if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM workflow_steps WHERE attempt_id=?")
            .bind(id)
            .fetch_one(&self.store.pool)
            .await?
            != 0
        {
            return Err(BenchmarkError::new(
                "validation",
                "Rescore the workflow's final attempt, not an intermediate step",
            ));
        }
        let mut a = self.store.attempt(id).await?;
        // An answer whose version a later one carries is that version's
        // answer: its evaluator evaluates it, while it is the current one.
        let v = self.store.carried_version(&a.version_id).await?;
        self.store
            .require_current_versions(std::slice::from_ref(&v.id))
            .await?;
        if a.phase != "terminal" {
            return Err(BenchmarkError::new(
                "validation",
                "Only a finished attempt can be rescored",
            ));
        }
        self.store
            .require_independent_run(&self.store.run(&a.run_id).await?.request.request_key)
            .await?;
        // Budget failures, cancellations, exclusions and infrastructure outcomes
        // keep their recorded outcome; only an evaluated result is evaluated again.
        if !matches!(
            self.store.stored_outcome(id).await?.as_deref(),
            Some("pass" | "fail" | "completed" | "evaluation_error" | "pending_review" | "judged")
        ) {
            return Err(BenchmarkError::new(
                "validation",
                "Only an evaluated result can be evaluated again",
            ));
        }
        // An answer recorded with the broken streams of a reconnect in front
        // of it is read again from its sealed turn, and evaluated as the
        // model gave it. Nothing is saved unless the evaluation is.
        if let Some(answer) = runner::reconnect::rebuilt_answer(
            &self.store.root,
            &a,
            v.manifest.limits.max_artifact_bytes,
        )
        .await
        {
            log::info!(
                "[benchmarks] attempt {id}: answer read again from its sealed turn without the streams a reconnect broke ({} of {} bytes)",
                answer.len(),
                a.output.as_deref().map_or(0, str::len)
            );
            a.output = Some(answer);
        }
        let output = a.output.as_deref().ok_or_else(|| {
            BenchmarkError::new("evidence_missing", "Attempt has no sealed output")
        })?;
        let e = runner::evaluate(&v.manifest, output).await?;
        // A creative brief goes back to the judge panel; its objective verdict
        // ("review required") is already on record and says nothing new.
        if v.manifest.evaluator.kind == "rubric" && e.verdict == "pending_review" {
            // A human review overrides every panel, so new judge calls could not change the score.
            if a.evaluations
                .iter()
                .any(|e| e.provenance == "human" && e.score.is_some())
            {
                return Err(BenchmarkError::new(
                    "validation",
                    "A human review overrides the judge panel",
                ));
            }
            let recorded = a.evaluations.len();
            let diagnostic_identity = runner::diagnostics::identity(&a);
            a = match self
                .backend
                .judge(&self.store, a, &v, runner::JudgeStop::manual())
                .await
            {
                Ok(judged) => judged,
                Err(error) => {
                    let error = runner::diagnostics::record(
                        &self.store,
                        &diagnostic_identity,
                        "manual_judging",
                        error,
                        None,
                        serde_json::json!({"source": "manual_rescore"}),
                    )
                    .await;
                    // A panel may have saved its rendering or paid votes
                    // before failing. Update that latest receipt, never the
                    // pre-call copy, and report the original typed error.
                    let recorded = async {
                        let mut latest = self.store.attempt(id).await?;
                        latest.reason = Some(runner::judge_error_reason(&error));
                        self.store.save_attempt(&latest).await
                    }
                    .await;
                    if let Err(recording) = recorded {
                        log::warn!(
                            "[benchmarks] could not record manual judging failure for {id}: {}",
                            recording.message
                        );
                    } else {
                        self.changed().await;
                    }
                    return Err(error);
                }
            };
            if !a.evaluations[recorded.min(a.evaluations.len())..]
                .iter()
                .any(|e| e.provenance == "render")
            {
                return Err(BenchmarkError::new(
                    "validation",
                    a.reason
                        .clone()
                        .unwrap_or_else(|| "No judge panel could be assembled".into()),
                ));
            }
        } else {
            a.outcome = Some(e.verdict.clone());
            a.evaluations.push(e);
        }
        self.store.save_attempt(&a).await?;
        Ok(a)
    }
}
