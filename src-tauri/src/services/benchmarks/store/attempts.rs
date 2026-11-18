//! Attempt records: reading, writing, superseding, and the usage ledger.
use super::*;

impl Store {
    pub async fn list_attempts(&self, q: &ResultQuery) -> Result<Vec<AttemptSummary>> {
        // Apply filters and page bounds before projecting the small result rows.
        // A present, empty version selection matches no cases; None means all.
        let versions = q
            .version_ids
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let attempts = q
            .attempt_ids
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let rows = sqlx::query(
            "WITH selected AS MATERIALIZED (
                SELECT a.rowid AS attempt_rowid,r.created_at,r.id AS run_id
                FROM attempts a JOIN run_plans r ON r.id=a.run_id
                WHERE (? IS NULL OR a.run_id=?)
                    AND (? IS NULL OR a.version_id IN (SELECT value FROM json_each(?)))
                    AND (? IS NULL OR a.id IN (SELECT value FROM json_each(?)))
                ORDER BY r.created_at DESC,r.id,a.rowid LIMIT ? OFFSET ?
             )
             SELECT a.id,a.run_id,a.version_id,
                json_extract(a.data_json,'$.configuration.modelId'),a.phase,
                json_extract(a.data_json,'$.outcome'),
                json_extract(a.data_json,'$.repetition'),
                json_extract(a.data_json,'$.finishedAt'),
                json_extract(a.data_json,'$.durationMs'),
                json_extract(a.data_json,'$.usage.output'),
                json_extract(a.data_json,'$.usage.cost'),
                COALESCE(json_extract(a.data_json,'$.evaluations'),'[]'),
                json_extract(a.data_json,'$.startedAt'),
                json_extract(a.data_json,'$.resolvedModel'),
                json_extract(a.data_json,'$.configuration'),
                json_extract(a.data_json,'$.usage')
             FROM selected p JOIN attempts a ON a.rowid=p.attempt_rowid
             ORDER BY p.created_at DESC,p.run_id,p.attempt_rowid",
        )
        .bind(&q.run_id)
        .bind(&q.run_id)
        .bind(&versions)
        .bind(&versions)
        .bind(&attempts)
        .bind(&attempts)
        .bind(q.limit.unwrap_or(50).min(100))
        .bind(q.offset.unwrap_or(0))
        .fetch_all(&self.pool)
        .await?;
        let catalog = self.catalog_entries().await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let finished_at: Option<i64> = r.get(7);
                let started_at: Option<i64> = r.get(12);
                // Priced as every board, the points and the evidence price it:
                // the catalog's list price of the day, the provider's own
                // figure only where the catalog has none (see `model_catalog`).
                let priced = || {
                    let configuration: Configuration =
                        serde_json::from_str(r.get::<Option<&str>, _>(14)?).ok()?;
                    let usage: TokenUsage =
                        serde_json::from_str(r.get::<Option<&str>, _>(15)?).ok()?;
                    crate::services::benchmarks::model_catalog::attempt_cost(
                        &catalog,
                        &configuration,
                        &usage,
                        finished_at.or(started_at),
                    )
                };
                let cost = priced().or_else(|| r.get::<Option<f64>, _>(10));
                let outcome: Option<&str> = r.get(5);
                let evaluations = serde_json::from_str::<Vec<Evaluation>>(r.get::<&str, _>(11))
                    .unwrap_or_default();
                let mut summary = AttemptSummary {
                    id: r.get(0),
                    run_id: r.get(1),
                    version_id: r.get(2),
                    model_id: r.get(3),
                    phase: r.get(4),
                    // A dated listing shows each attempt as it stood then.
                    outcome: crate::services::benchmarks::analysis::outcome_as_of(
                        outcome,
                        finished_at,
                        &evaluations,
                        q.as_of,
                    ),
                    score: crate::services::benchmarks::analysis::score_of(
                        outcome,
                        finished_at,
                        &evaluations,
                        q.as_of,
                    ),
                    repetition: r.get::<Option<u32>, _>(6).unwrap_or(0),
                    finished_at,
                    duration_ms: r.get(8),
                    output_tokens: r.get(9),
                    cost,
                    resolved_model: r.get(13),
                };
                if let Some(at) = q.as_of.filter(|at| finished_at.is_none_or(|end| end > *at)) {
                    summary.phase = if started_at.is_some_and(|start| start <= at) {
                        "running"
                    } else {
                        "pending"
                    }
                    .into();
                    summary.finished_at = None;
                    summary.duration_ms = None;
                    summary.output_tokens = None;
                    summary.cost = None;
                    summary.resolved_model = None;
                    summary.score = None;
                }
                summary
            })
            .collect())
    }

    pub async fn attempt(&self, id: &str) -> Result<Attempt> {
        let data = sqlx::query_scalar::<_, String>("SELECT data_json FROM attempts WHERE id=? UNION ALL SELECT data_json FROM workflow_steps WHERE attempt_id=? LIMIT 1")
            .bind(id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| BenchmarkError::new("evidence_missing", "Attempt not found"))?;
        Ok(crate::services::benchmarks::analysis::normalize_outcome(
            serde_json::from_str(&data)?,
        ))
    }

    pub async fn usage_ledger(&self) -> Result<Vec<UsageLedgerEntry>> {
        // Each native prompt owns its own session. Workflow roots aggregate these
        // children for benchmark quality, but must not count them twice in Stats.
        // A rendering awaiting its panel has already paid for its generation.
        let rows=sqlx::query("WITH native_attempts AS (SELECT id,phase,data_json FROM attempts a WHERE COALESCE(json_array_length(data_json,'$.workflowSteps'),0)=0 AND NOT EXISTS(SELECT 1 FROM workflow_steps s WHERE s.root_attempt_id=a.id) UNION ALL SELECT attempt_id AS id,phase,data_json FROM workflow_steps) SELECT id,json_extract(data_json,'$.sessionId'),json_extract(data_json,'$.configuration.providerId'),COALESCE(json_extract(data_json,'$.observed.modelId'),json_extract(data_json,'$.configuration.modelId')),json_extract(data_json,'$.observed.effort'),json_extract(data_json,'$.usage.input'),json_extract(data_json,'$.usage.output'),json_extract(data_json,'$.usage.cost'),json_extract(data_json,'$.durationMs'),json_extract(data_json,'$.finishedAt') FROM native_attempts WHERE phase IN ('terminal','awaiting_judges') AND json_extract(data_json,'$.sessionId') IS NOT NULL AND json_extract(data_json,'$.evidenceHash') IS NOT NULL AND json_extract(data_json,'$.finishedAt') IS NOT NULL ORDER BY json_extract(data_json,'$.finishedAt'),id").fetch_all(&self.pool).await?;
        let mut ledger: Vec<UsageLedgerEntry> = rows
            .into_iter()
            .map(|r| UsageLedgerEntry {
                attempt_id: r.get(0),
                session_id: r.get(1),
                provider_id: r.get(2),
                model_id: r.get(3),
                effort: r.get(4),
                input_tokens: r.get::<Option<i64>, _>(5).map(|v| v as u64),
                output_tokens: r.get::<Option<i64>, _>(6).map(|v| v as u64),
                cost_usd: r.get(7),
                duration_ms: r.get::<Option<i64>, _>(8).map(|v| v as u64),
                finished_at: r.get(9),
            })
            .collect();
        let evaluations = sqlx::query_scalar::<_, String>(
            "SELECT e.value FROM attempts a,json_each(a.data_json,'$.evaluations') e
             WHERE a.phase IN ('terminal','awaiting_judges') AND json_extract(e.value,'$.provenance') IN ('judge','judge_failure')
               AND json_extract(e.value,'$.details.sessionId') IS NOT NULL"
        ).fetch_all(&self.pool).await?;
        for encoded in evaluations {
            let evaluation: Evaluation = serde_json::from_str(&encoded)?;
            if let (Some(judge), Some(usage), Some(details)) =
                (evaluation.judge, evaluation.usage, evaluation.details)
            {
                ledger.push(UsageLedgerEntry {
                    attempt_id: evaluation.id,
                    session_id: details["sessionId"].as_str().unwrap_or_default().into(),
                    provider_id: judge.provider_id,
                    model_id: judge.model_id,
                    effort: judge.effort,
                    input_tokens: usage.input,
                    output_tokens: usage.output,
                    cost_usd: usage.cost,
                    duration_ms: details["durationMs"].as_u64(),
                    finished_at: evaluation.created_at,
                });
            }
        }
        ledger.sort_by_key(|entry| (entry.finished_at, entry.attempt_id.clone()));
        Ok(ledger)
    }

    /// Adds a pending attempt to a run that already exists.
    pub async fn insert_attempt(&self, attempt: &Attempt) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,?,?,?)")
            .bind(&attempt.id)
            .bind(&attempt.run_id)
            .bind(&attempt.version_id)
            .bind(&attempt.configuration.id)
            .bind(attempt.repetition as i64)
            .bind(&attempt.phase)
            .bind(serde_json::to_string(attempt)?)
            .execute(&mut *tx)
            .await?;
        crate::services::benchmarks::workflow_campaign::check_reserved_versions(
            &mut tx,
            std::slice::from_ref(&attempt.version_id),
            None,
        )
        .await?;
        event(&mut tx, &attempt.run_id, "run_changed").await?;
        tx.commit().await?;
        Ok(())
    }

    /// Saves an attempt that no longer counts and frees its repetition slot
    /// in the run's plan, so a fresh attempt may take that repetition. The
    /// row's slot moves to a value no plan uses; the attempt's own
    /// repetition stays in its data.
    pub async fn supersede_attempt(&self, attempt: &Attempt) -> Result<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        Self::supersede_in_transaction(&mut tx, attempt).await?;
        event(&mut tx, &attempt.run_id, "run_changed").await?;
        tx.commit().await?;
        Ok(())
    }

    /// Shared by individual supersession and sealing a sitting. Preserve the
    /// preceding cause in the same transaction, without loading paid evidence.
    pub(in crate::services::benchmarks) async fn supersede_in_transaction(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        attempt: &Attempt,
    ) -> Result<()> {
        let previous =
            sqlx::query("SELECT json_extract(data_json,'$.reason'),phase FROM attempts WHERE id=?")
                .bind(&attempt.id)
                .fetch_optional(&mut **tx)
                .await?
                .ok_or_else(|| BenchmarkError::new("evidence_missing", "Attempt not found"))?;
        diagnostics::capture_reason(tx, attempt, previous.get(0), previous.get(1)).await?;
        sqlx::query("UPDATE attempts SET phase=?,data_json=json_set(data_json,'$.phase',?,'$.outcome',?,'$.reason',?,'$.finishedAt',?),repetition=-rowid WHERE id=?")
            .bind(&attempt.phase)
            .bind(&attempt.phase)
            .bind(&attempt.outcome)
            .bind(&attempt.reason)
            .bind(attempt.finished_at)
            .bind(&attempt.id)
            .execute(&mut **tx)
            .await?;
        Ok(())
    }

    pub async fn save_attempt(&self, attempt: &Attempt) -> Result<()> {
        // Timing belongs to the stored attempt, not a possibly stale flight copy.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let previous = sqlx::query(
            "SELECT json_extract(data_json,'$.activity'),json_extract(data_json,'$.reason'),phase FROM attempts WHERE id=? UNION ALL SELECT json_extract(data_json,'$.activity'),json_extract(data_json,'$.reason'),phase FROM workflow_steps WHERE attempt_id=? LIMIT 1"
        ).bind(&attempt.id).bind(&attempt.id).fetch_optional(&mut *tx).await?
            .ok_or_else(|| BenchmarkError::new("evidence_missing", "Attempt not found"))?;
        diagnostics::capture_reason(&mut tx, attempt, previous.get(1), previous.get(2)).await?;
        let mut attempt = attempt.clone();
        attempt.activity = previous
            .get::<Option<String>, _>(0)
            .map(|value| serde_json::from_str(&value))
            .transpose()?;
        let state: String = sqlx::query_scalar("SELECT state FROM run_plans WHERE id=?")
            .bind(&attempt.run_id)
            .fetch_one(&mut *tx)
            .await?;
        let kind = crate::services::benchmarks::activity::kind(&attempt, &state);
        crate::services::benchmarks::activity::record(&mut attempt.activity, kind, now());
        let changed = sqlx::query("UPDATE attempts SET phase=?,data_json=? WHERE id=?")
            .bind(&attempt.phase)
            .bind(serde_json::to_string(&attempt)?)
            .bind(&attempt.id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if changed == 0 {
            let changed =
                sqlx::query("UPDATE workflow_steps SET phase=?,data_json=? WHERE attempt_id=?")
                    .bind(&attempt.phase)
                    .bind(serde_json::to_string(&attempt)?)
                    .bind(&attempt.id)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected();
            if changed == 0 {
                return Err(BenchmarkError::new("evidence_missing", "Attempt not found"));
            }
        }
        event(&mut tx, &attempt.run_id, "attempt_changed").await?;
        tx.commit().await?;
        Ok(())
    }
}
