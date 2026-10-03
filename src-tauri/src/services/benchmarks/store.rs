use super::types::*;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Row, SqlitePool,
};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Store {
    pub pool: SqlitePool,
    pub root: PathBuf,
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
impl Store {
    pub async fn open(root: &Path) -> Result<Self> {
        tokio::fs::create_dir_all(root).await?;
        let options = SqliteConnectOptions::new()
            .filename(root.join("benchmarks.db"))
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(std::time::Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations_benchmarks")
            .run(&pool)
            .await
            .map_err(|e| BenchmarkError::new("storage_unavailable", e.to_string()))?;
        Ok(Self {
            pool,
            root: root.to_owned(),
        })
    }
    pub async fn events_since(&self, sequence: i64) -> Result<Vec<BenchmarkEvent>> {
        let rows=sqlx::query("SELECT sequence,entity_id,kind,created_at FROM benchmark_events WHERE sequence>? ORDER BY sequence LIMIT 500").bind(sequence).fetch_all(&self.pool).await?;
        Ok(rows
            .into_iter()
            .map(|r| BenchmarkEvent {
                sequence: r.get(0),
                entity_id: r.get(1),
                kind: r.get(2),
                created_at: r.get(3),
            })
            .collect())
    }
    /// UI catalog window: the newest 1,000 definitions. Evidence and export
    /// consumers must use all_definitions so old published cases remain visible.
    pub async fn definitions(&self) -> Result<Vec<BenchmarkDefinition>> {
        let rows=sqlx::query("SELECT id,draft_json,revision,archived,archived_at FROM benchmark_definitions ORDER BY rowid DESC LIMIT 1000").fetch_all(&self.pool).await?;
        let mut out = Vec::new();
        for r in rows {
            let id: String = r.get(0);
            out.push(BenchmarkDefinition {
                id: id.clone(),
                draft: serde_json::from_str(r.get(1))?,
                draft_revision: r.get(2),
                archived: r.get(3),
                archived_at: r.get(4),
                archive_history: self.archive_history(&id).await?,
                versions: self.versions_for(&id).await?,
            });
        }
        Ok(out)
    }
    pub async fn all_definitions(&self) -> Result<Vec<BenchmarkDefinition>> {
        let mut definitions = Vec::new();
        let mut after = 0i64;
        loop {
            let rows=sqlx::query("SELECT rowid,id FROM benchmark_definitions WHERE rowid>? ORDER BY rowid LIMIT 1000")
                .bind(after).fetch_all(&self.pool).await?;
            let count = rows.len();
            for row in rows {
                after = row.get(0);
                definitions.push(self.definition(row.get(1)).await?);
            }
            if count < 1000 {
                break;
            }
        }
        Ok(definitions)
    }
    pub async fn definition(&self, id: &str) -> Result<BenchmarkDefinition> {
        let r = sqlx::query(
            "SELECT draft_json,revision,archived,archived_at FROM benchmark_definitions WHERE id=?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| BenchmarkError::new("validation", "Definition not found"))?;
        Ok(BenchmarkDefinition {
            id: id.into(),
            draft: serde_json::from_str(r.get(0))?,
            draft_revision: r.get(1),
            archived: r.get(2),
            archived_at: r.get(3),
            archive_history: self.archive_history(id).await?,
            versions: self.versions_for(id).await?,
        })
    }
    /// Archive periods a restore closed, oldest first.
    async fn archive_history(&self, id: &str) -> Result<Vec<(i64, i64)>> {
        let rows = sqlx::query(
            "SELECT archived_at,restored_at FROM benchmark_definition_archives WHERE definition_id=? ORDER BY archived_at",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| (r.get(0), r.get(1))).collect())
    }
    pub async fn versions_for(&self, id: &str) -> Result<Vec<BenchmarkVersion>> {
        let rows=sqlx::query("SELECT id,content_hash,manifest_json,published_at FROM benchmark_versions WHERE definition_id=? ORDER BY published_at DESC").bind(id).fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|r| {
                Ok(BenchmarkVersion {
                    id: r.get(0),
                    definition_id: id.into(),
                    content_hash: r.get(1),
                    manifest: serde_json::from_str(r.get(2))?,
                    published_at: r.get(3),
                })
            })
            .collect()
    }
    pub async fn version(&self, id: &str) -> Result<BenchmarkVersion> {
        let r=sqlx::query("SELECT definition_id,content_hash,manifest_json,published_at FROM benchmark_versions WHERE id=?").bind(id).fetch_optional(&self.pool).await?.ok_or_else(||BenchmarkError::new("validation","Published version not found"))?;
        Ok(BenchmarkVersion {
            id: id.into(),
            definition_id: r.get(0),
            content_hash: r.get(1),
            manifest: serde_json::from_str(r.get(2))?,
            published_at: r.get(3),
        })
    }
    pub async fn run(&self, id: &str) -> Result<BenchmarkRun> {
        let r = sqlx::query(
            "SELECT state,revision,created_at,updated_at,request_json FROM run_plans WHERE id=?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| BenchmarkError::new("validation", "Run not found"))?;
        // Detailed output is loaded only through the evidence endpoint.
        let rows=sqlx::query_scalar::<_,String>("SELECT json_set(data_json,'$.output',NULL) FROM attempts WHERE run_id=? ORDER BY rowid LIMIT 1000").bind(id).fetch_all(&self.pool).await?;
        Ok(BenchmarkRun {
            id: id.into(),
            state: r.get(0),
            revision: r.get(1),
            created_at: r.get(2),
            updated_at: r.get(3),
            request: serde_json::from_str(r.get(4))?,
            attempts: rows
                .into_iter()
                .map(|v| serde_json::from_str(&v).map(super::analysis::normalize_outcome))
                .collect::<std::result::Result<_, _>>()?,
        })
    }
    pub async fn run_state(&self, id: &str) -> Result<String> {
        sqlx::query_scalar::<_, String>("SELECT state FROM run_plans WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| BenchmarkError::new("validation", "Run not found"))
    }
    /// The outcome as recorded, before any evidence is read into it.
    pub async fn stored_outcome(&self, id: &str) -> Result<Option<String>> {
        Ok(sqlx::query_scalar::<_, Option<String>>(
            "SELECT json_extract(data_json,'$.outcome') FROM attempts WHERE id=?
             UNION ALL SELECT json_extract(data_json,'$.outcome') FROM workflow_steps WHERE attempt_id=? LIMIT 1",
        )
        .bind(id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .flatten())
    }
    /// Recent history needs plans and counts, never serialized attempt evidence.
    pub async fn runs(&self) -> Result<Vec<RunSummary>> {
        let rows = sqlx::query(
            "SELECT r.id,r.state,r.revision,r.created_at,r.updated_at,r.request_json,
                (SELECT COUNT(*) FROM attempts a WHERE a.run_id=r.id),
                (SELECT COUNT(*) FROM attempts a WHERE a.run_id=r.id AND a.phase='terminal'),
                CASE WHEN r.state NOT IN ('completed','cancelled','cancelling') THEN
                (SELECT json_group_array(json_array(a.configuration_id,
                        json_extract(a.data_json,'$.observed.effort'),
                        json_extract(a.data_json,'$.observed.fastMode')))
                    FROM attempts a WHERE a.run_id=r.id AND a.phase<>'pending'
                        AND json_extract(a.data_json,'$.observed.modelId')=json_extract(a.data_json,'$.configuration.modelId')
                        AND COALESCE(json_extract(a.data_json,'$.outcome'),'')<>'selection_changed')
                END
             FROM run_plans r ORDER BY r.created_at DESC,r.id LIMIT 100",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|r| {
                Ok(RunSummary {
                    id: r.get(0),
                    state: r.get(1),
                    revision: r.get(2),
                    created_at: r.get(3),
                    updated_at: r.get(4),
                    request: serde_json::from_str(r.get(5))?,
                    attempt_count: r.get::<i64, _>(6) as u64,
                    settled_count: r.get::<i64, _>(7) as u64,
                    observed_selections: observed_selections(r.get(8)),
                })
            })
            .collect()
    }
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
                json_extract(a.data_json,'$.startedAt')
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
        Ok(rows
            .into_iter()
            .map(|r| {
                let finished_at: Option<i64> = r.get(7);
                let started_at: Option<i64> = r.get(12);
                let mut summary = AttemptSummary {
                    id: r.get(0),
                    run_id: r.get(1),
                    version_id: r.get(2),
                    model_id: r.get(3),
                    phase: r.get(4),
                    // A dated listing shows each attempt as it stood then.
                    outcome: super::analysis::outcome_as_of(
                        r.get::<Option<&str>, _>(5),
                        finished_at,
                        &serde_json::from_str::<Vec<Evaluation>>(r.get::<&str, _>(11))
                            .unwrap_or_default(),
                        q.as_of,
                    ),
                    repetition: r.get::<Option<u32>, _>(6).unwrap_or(0),
                    finished_at,
                    duration_ms: r.get(8),
                    output_tokens: r.get(9),
                    cost: r.get(10),
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
                }
                summary
            })
            .collect())
    }
    /// The newest rendering per creative brief and configuration, newest
    /// run first, with the markup and any recorded review.
    pub async fn list_designs(&self, q: &ResultQuery) -> Result<Vec<DesignEntry>> {
        let versions = q
            .version_ids
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let rows = sqlx::query(
            "SELECT a.data_json,v.manifest_json,r.created_at
             FROM attempts a
             JOIN benchmark_versions v ON v.id=a.version_id
             JOIN run_plans r ON r.id=a.run_id
             WHERE json_extract(v.manifest_json,'$.workClassId')='creative'
                AND COALESCE(json_extract(r.request_json,'$.preview'),0)=0
                AND (? IS NULL OR a.run_id=?)
                AND (? IS NULL OR a.version_id IN (SELECT value FROM json_each(?)))
             ORDER BY r.created_at DESC,r.id,a.rowid DESC",
        )
        .bind(&q.run_id)
        .bind(&q.run_id)
        .bind(&versions)
        .bind(&versions)
        .fetch_all(&self.pool)
        .await?;
        // One card per brief and model as the leaderboard counts it: runtime
        // revisions and defaulted controls do not split a model. Rows come newest
        // first; a card shows the newest scored rendering, else the newest
        // rendering, else the newest settled attempt, else the newest attempt.
        let mut candidates: Vec<(Attempt, BenchmarkDraft, i64)> = Vec::new();
        let mut cards: std::collections::BTreeMap<(String, String), (u8, usize)> =
            std::collections::BTreeMap::new();
        for row in rows {
            let attempt: Attempt = serde_json::from_str(&row.get::<String, _>(0))?;
            // A candidate that authored the brief is not an entry of it.
            if attempt.outcome.as_deref() == Some("excluded") {
                continue;
            }
            let manifest: BenchmarkDraft = serde_json::from_str(&row.get::<String, _>(1))?;
            let key = (
                attempt.version_id.clone(),
                super::analysis::leaderboard_key(&card_configuration(&attempt)),
            );
            let tier = card_tier(&attempt);
            let index = candidates.len();
            candidates.push((attempt, manifest, row.get(2)));
            let card = cards.entry(key).or_insert((tier, index));
            if tier > card.0 {
                *card = (tier, index);
            }
        }
        let mut chosen: Vec<usize> = cards.into_values().map(|(_, index)| index).collect();
        chosen.sort_unstable();
        let mut out = Vec::new();
        for index in chosen {
            let (attempt, manifest, run_created_at) = &candidates[index];
            let configuration = card_configuration(attempt).into_owned();
            let review = attempt
                .evaluations
                .iter()
                .rev()
                .find(|e| e.provenance == "human" && e.score.is_some())
                .map(|e| DesignReview {
                    score: e.score.unwrap_or_default(),
                    reason: e.reason.clone(),
                    details: e.details.clone(),
                    created_at: e.created_at,
                });
            let judges = attempt.evaluations[scoring_batch(&attempt.evaluations)]
                .iter()
                .filter(|e| e.provenance == "judge")
                .filter_map(|e| {
                    Some(DesignJudge {
                        configuration: e.judge.clone()?,
                        score: e.score?,
                        reason: e.reason.clone(),
                        details: e
                            .details
                            .as_ref()
                            .map(|d| d.get("criteria").unwrap_or(d).clone()),
                    })
                })
                .collect();
            let score = super::analysis::score(attempt);
            out.push(DesignEntry {
                attempt_id: attempt.id.clone(),
                run_id: attempt.run_id.clone(),
                run_created_at: *run_created_at,
                version_id: attempt.version_id.clone(),
                name: manifest.name.clone(),
                task_family: manifest.task_family.clone(),
                difficulty: manifest.facets.difficulty.clone(),
                output_format: manifest.facets.output_format.clone(),
                configuration,
                phase: attempt.phase.clone(),
                outcome: super::analysis::effective_outcome(
                    attempt.outcome.as_deref(),
                    &attempt.evaluations,
                ),
                output: attempt.output.clone(),
                finished_at: attempt.finished_at,
                duration_ms: attempt.duration_ms,
                output_tokens: attempt.usage.output,
                // The candidate's own generation; judge calls are the benchmark's expense.
                cost: attempt.usage.cost,
                review,
                judges,
                score,
            });
        }
        Ok(out)
    }
    pub async fn active_runs(&self) -> Result<Vec<BenchmarkRun>> {
        let ids=sqlx::query_scalar::<_,String>("SELECT id FROM run_plans WHERE state NOT IN ('completed','cancelled') ORDER BY created_at").fetch_all(&self.pool).await?;
        let mut out = Vec::new();
        for id in ids {
            out.push(self.run(&id).await?);
        }
        Ok(out)
    }
    pub async fn all_runs(&self) -> Result<Vec<BenchmarkRun>> {
        let mut out = Vec::new();
        let mut offset = 0;
        loop {
            let ids = sqlx::query_scalar::<_, String>(
                "SELECT id FROM run_plans ORDER BY created_at,id LIMIT 100 OFFSET ?",
            )
            .bind(offset)
            .fetch_all(&self.pool)
            .await?;
            let count = ids.len();
            for id in ids {
                out.push(self.run(&id).await?);
            }
            if count < 100 {
                break;
            }
            offset += 100;
        }
        Ok(out)
    }
    pub async fn attempt(&self, id: &str) -> Result<Attempt> {
        let data = sqlx::query_scalar::<_, String>("SELECT data_json FROM attempts WHERE id=? UNION ALL SELECT data_json FROM workflow_steps WHERE attempt_id=? LIMIT 1")
            .bind(id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| BenchmarkError::new("evidence_missing", "Attempt not found"))?;
        Ok(super::analysis::normalize_outcome(serde_json::from_str(
            &data,
        )?))
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
    pub async fn save_attempt(&self, attempt: &Attempt) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let changed = sqlx::query("UPDATE attempts SET phase=?,data_json=? WHERE id=?")
            .bind(&attempt.phase)
            .bind(serde_json::to_string(attempt)?)
            .bind(&attempt.id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if changed == 0 {
            let changed =
                sqlx::query("UPDATE workflow_steps SET phase=?,data_json=? WHERE attempt_id=?")
                    .bind(&attempt.phase)
                    .bind(serde_json::to_string(attempt)?)
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
    pub async fn set_run_state(&self, id: &str, state: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE run_plans SET state=?,revision=revision+1,updated_at=? WHERE id=?")
            .bind(state)
            .bind(now())
            .bind(id)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, id, "run_changed").await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn recover(&self) -> Result<()> {
        // Never retry an attempt that may have crossed the host acceptance boundary.
        // A rendering awaiting its panel has a sealed generation; its run asks the
        // panel after resume, and reconciliation settles any judge turn cut off.
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT data_json FROM attempts WHERE phase NOT IN ('pending','terminal','awaiting_judges')",
        )
        .fetch_all(&self.pool)
        .await?;
        for data in rows {
            let mut a: Attempt = serde_json::from_str(&data)?;
            a.phase = "interrupted".into();
            if a.evidence_hash.is_none()
                || a.outcome.is_none()
                || a.outcome.as_deref() == Some("interrupted")
            {
                a.outcome = Some("interrupted".into());
            }
            a.reason=Some("Application restarted; reconcile committed host evidence before any further dispatch.".into());
            self.save_attempt(&a).await?;
        }
        sqlx::query("UPDATE run_plans SET state='needs_attention',revision=revision+1 WHERE state IN ('running','pausing','cancelling')").execute(&self.pool).await?;
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT data_json FROM schedules WHERE enabled=1 AND next_due_at<?",
        )
        .bind(now())
        .fetch_all(&self.pool)
        .await?;
        for data in rows {
            let mut s: Schedule = serde_json::from_str(&data)?;
            s.missed = true;
            s.enabled = false;
            self.save_schedule(&s).await?;
        }
        Ok(())
    }
    pub async fn baselines(&self) -> Result<Vec<Baseline>> {
        self.json_rows("SELECT data_json FROM baselines ORDER BY rowid DESC")
            .await
    }
    /// Every catalog entry, newest effective date first; an empty catalog is
    /// seeded once from the published vendor rates.
    pub async fn catalog_entries(&self) -> Result<Vec<CatalogEntry>> {
        const LIST: &str =
            "SELECT data_json FROM catalog_entries ORDER BY effective_from DESC, created_at DESC";
        let entries: Vec<CatalogEntry> = self.json_rows(LIST).await?;
        if !entries.is_empty() {
            return Ok(entries);
        }
        for entry in super::model_catalog::seeds() {
            self.save_catalog_entry(&entry).await?;
        }
        self.json_rows(LIST).await
    }
    pub async fn save_catalog_entry(&self, entry: &CatalogEntry) -> Result<()> {
        sqlx::query("INSERT INTO catalog_entries(id,kind,effective_from,created_at,data_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,effective_from=excluded.effective_from,data_json=excluded.data_json")
            .bind(&entry.id)
            .bind(&entry.kind)
            .bind(entry.effective_from)
            .bind(entry.created_at)
            .bind(serde_json::to_string(entry)?)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
    pub async fn delete_catalog_entry(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM catalog_entries WHERE id=?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
    pub async fn schedules(&self) -> Result<Vec<Schedule>> {
        self.json_rows("SELECT data_json FROM schedules ORDER BY rowid DESC")
            .await
    }
    pub async fn usage_samples(&self) -> Result<Vec<UsageSample>> {
        // Full historical evidence for comparisons and export, read in bounded
        // batches. UI reads use list_usage with its SQL filter and page bounds.
        let mut samples = Vec::new();
        let mut before = i64::MAX;
        loop {
            let rows=sqlx::query("SELECT rowid,data_json FROM usage_observations WHERE rowid<? ORDER BY rowid DESC LIMIT 1000")
                .bind(before).fetch_all(&self.pool).await?;
            let count = rows.len();
            for row in rows {
                before = row.get(0);
                samples.push(serde_json::from_str(row.get(1))?);
            }
            if count < 1000 {
                break;
            }
        }
        Ok(samples)
    }
    pub async fn list_usage(&self, q: &ResultQuery) -> Result<Vec<UsageSample>> {
        sqlx::query_scalar::<_,String>("SELECT data_json FROM usage_observations WHERE (? IS NULL OR run_id=?) ORDER BY rowid DESC LIMIT ? OFFSET ?")
            .bind(&q.run_id).bind(&q.run_id).bind(q.limit.unwrap_or(100).min(500)).bind(q.offset.unwrap_or(0))
            .fetch_all(&self.pool).await?.into_iter()
            .map(|data|serde_json::from_str(&data).map_err(Into::into)).collect()
    }
    pub async fn save_usage(&self, s: &UsageSample) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO usage_observations(id,run_id,data_json) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING").bind(&s.id).bind(&s.run_id).bind(serde_json::to_string(s)?).execute(&mut *tx).await?;
        event(&mut tx, &s.run_id, "usage_changed").await?;
        tx.commit().await?;
        Ok(())
    }
    async fn json_rows<T: serde::de::DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>> {
        sqlx::query_scalar::<_, String>(sql)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|v| serde_json::from_str(&v).map_err(Into::into))
            .collect()
    }
    pub async fn save_schedule(&self, s: &Schedule) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO schedules(id,enabled,next_due_at,data_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,next_due_at=excluded.next_due_at,data_json=excluded.data_json").bind(&s.id).bind(s.enabled).bind(s.next_due_at).bind(serde_json::to_string(s)?).execute(&mut *tx).await?;
        event(&mut tx, &s.id, "schedule_changed").await?;
        tx.commit().await?;
        Ok(())
    }
}
/// The distinct selections a run's acknowledged attempts ran with, from rows
/// of `[configuration id, effort, fast mode as 0 or 1]`.
fn observed_selections(rows: Option<&str>) -> Vec<ObservedRunSelection> {
    let rows: Vec<(String, Option<String>, Option<i64>)> = rows
        .and_then(|rows| serde_json::from_str(rows).ok())
        .unwrap_or_default();
    let mut selections: Vec<ObservedRunSelection> = Vec::new();
    for (configuration_id, effort, fast_mode) in rows {
        let selection = ObservedRunSelection {
            configuration_id,
            effort,
            fast_mode: fast_mode.map(|fast| fast != 0),
        };
        if !selections.contains(&selection) {
            selections.push(selection);
        }
    }
    selections
}

/// The model a gallery card stands for: the leaderboard's own attribution, so
/// a refused selection stays with the candidate that was asked for.
fn card_configuration(attempt: &Attempt) -> std::borrow::Cow<'_, Configuration> {
    super::analysis::execution_configuration(attempt)
}

/// The judge batch a card shows: the newest one whose valid votes reached its
/// panel size, else the newest one. An unfinished re-evaluation never hides a
/// settled panel.
fn scoring_batch(evaluations: &[Evaluation]) -> std::ops::Range<usize> {
    let markers: Vec<usize> = evaluations
        .iter()
        .enumerate()
        .filter(|(_, e)| e.provenance == "render")
        .map(|(index, _)| index)
        .collect();
    let batch = |position: usize| {
        let start = markers[position];
        start
            ..markers
                .get(position + 1)
                .copied()
                .unwrap_or(evaluations.len())
    };
    for position in (0..markers.len()).rev() {
        let range = batch(position);
        let expected = evaluations[range.start]
            .details
            .as_ref()
            .and_then(|d| d["expectedJudges"].as_u64())
            .unwrap_or(1) as usize;
        let votes = evaluations[range.clone()]
            .iter()
            .filter(|e| {
                e.provenance == "judge"
                    && e.score
                        .is_some_and(|s| s.is_finite() && (0.0..=1.0).contains(&s))
            })
            .count();
        if votes >= expected {
            return range;
        }
    }
    match markers.last() {
        Some(_) => batch(markers.len() - 1),
        None => 0..evaluations.len(),
    }
}

/// How well an attempt can stand for its card: a scored rendering, a rendering,
/// a settled attempt, anything else.
fn card_tier(attempt: &Attempt) -> u8 {
    if attempt.phase != "terminal" {
        return 0;
    }
    let rendering = attempt
        .output
        .as_deref()
        .is_some_and(|o| !o.trim().is_empty())
        && !matches!(
            attempt.outcome.as_deref(),
            Some("cancelled" | "selection_changed" | "interrupted" | "dispatch_uncertain")
        );
    match (rendering, super::analysis::score(attempt).is_some()) {
        (true, true) => 3,
        (true, false) => 2,
        _ => 1,
    }
}

pub async fn event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    id: &str,
    kind: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO benchmark_events(entity_id,kind,created_at) VALUES(?,?,?)")
        .bind(id)
        .bind(kind)
        .bind(now())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[tokio::test]
    async fn the_design_gallery_keeps_the_newest_rendering_per_brief_and_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let draft = super::super::seeds::definitions()
            .into_iter()
            .find(|d| d.work_class_id == "creative")
            .unwrap();
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let configuration = json!({"id":"candidate","providerId":"provider","accountId":null,"modelId":"native-model","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let mut tx = store.pool.begin().await.unwrap();
        for (run, created_at, preview) in
            [("run-1", 1, false), ("run-2", 2, false), ("run-3", 3, true)]
        {
            let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[configuration],"repetitions":1,"timeoutSeconds":600,"maxExecutions":1,"preview":preview});
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,?,?,?)")
                .bind(run).bind(run).bind(created_at).bind(created_at).bind(request.to_string())
                .execute(&mut *tx).await.unwrap();
            let evaluations = if run == "run-2" {
                json!([{"id":"objective","evaluatorRevision":"1","verdict":"pending_review","score":null,"reason":"waiting","createdAt":5,"provenance":"objective","artifacts":[]},{"id":"review","evaluatorRevision":"1","verdict":"fail","score":0.7,"reason":"Lighthouse present","createdAt":6,"provenance":"human","artifacts":[],"details":{"adherence":0.8,"craft":0.6}}])
            } else {
                json!([{"id":"objective","evaluatorRevision":"1","verdict":"pending_review","score":null,"reason":"waiting","createdAt":5,"provenance":"objective","artifacts":[]}])
            };
            let attempt = json!({"id":format!("attempt-{run}"),"runId":run,"versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":null,"output":format!("<svg data-run='{run}'/>"),"usage":{"schema":"native","output":120,"cost":0.05},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'candidate',0,'terminal',?)")
                .bind(format!("attempt-{run}")).bind(run).bind(&version.id).bind(attempt.to_string())
                .execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        // The preview run never shows; the newest real run wins and carries its review.
        let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].attempt_id, "attempt-run-2");
        assert_eq!(
            entries[0].output.as_deref(),
            Some("<svg data-run='run-2'/>")
        );
        assert_eq!(entries[0].output_format.as_deref(), Some("svg"));
        let review = entries[0].review.as_ref().unwrap();
        assert_eq!(review.score, 0.7);
        assert!(entries[0].judges.is_empty());
        assert_eq!(review.details.as_ref().unwrap()["craft"], json!(0.6));
        // One run on request: its own rendering, not yet reviewed.
        let older = store
            .list_designs(&ResultQuery {
                run_id: Some("run-1".into()),
                ..ResultQuery::default()
            })
            .await
            .unwrap();
        assert_eq!(older[0].attempt_id, "attempt-run-1");
        assert!(older[0].review.is_none());
        let none = store
            .list_designs(&ResultQuery {
                version_ids: Some(vec![]),
                ..ResultQuery::default()
            })
            .await
            .unwrap();
        assert!(none.is_empty());
    }
    #[tokio::test]
    async fn one_gallery_card_per_model_shows_its_scored_rendering_and_generation_cost() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let draft = super::super::seeds::definitions()
            .into_iter()
            .find(|d| d.work_class_id == "creative")
            .unwrap();
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let configuration = |revision: &str, effort: Option<&str>| json!({"id":"sonnet","providerId":"claude-acp","accountId":"account","modelId":"sonnet","effort":effort,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":revision});
        let judge = configuration("r1", None);
        // Two batches: only the newer one shows, with its criteria unwrapped.
        let judged = json!([
            {"id":"objective","evaluatorRevision":"1","verdict":"pending_review","score":null,"reason":"waiting","createdAt":5,"provenance":"objective","artifacts":[]},
            {"id":"render-1","evaluatorRevision":"1","verdict":"rendered","score":null,"reason":"r","createdAt":6,"provenance":"render","artifacts":[],"details":{"expectedJudges":2}},
            {"id":"legacy","evaluatorRevision":"1","verdict":"judged","score":0.9,"reason":"old","createdAt":7,"provenance":"judge","artifacts":[],"details":{"adherence":0.9},"judge":judge},
            {"id":"render-2","evaluatorRevision":"1","verdict":"rendered","score":null,"reason":"r","createdAt":8,"provenance":"render","artifacts":[],"details":{"expectedJudges":2}},
            {"id":"new-1","evaluatorRevision":"1","verdict":"judged","score":0.6,"reason":"one","createdAt":9,"provenance":"judge","artifacts":[],"details":{"judgeBatchId":"b","sessionId":"s1","usageComplete":true,"criteria":{"adherence":0.6}},"judge":judge,"usage":{"schema":"native","cost":0.1}},
            {"id":"new-2","evaluatorRevision":"1","verdict":"judged","score":0.8,"reason":"two","createdAt":10,"provenance":"judge","artifacts":[],"details":{"judgeBatchId":"b","sessionId":"s2","usageComplete":true,"criteria":{"adherence":0.8}},"judge":judge},
            {"id":"failed","evaluatorRevision":"1","verdict":"abstained","score":null,"reason":"busy","createdAt":11,"provenance":"judge_failure","artifacts":[],"details":{"judgeBatchId":"b","usageComplete":true,"criteria":null},"judge":judge}
        ]);
        // Newest first: a pending retest under a new runtime, a cancelled one whose
        // session acknowledged another model, then the judged rendering.
        let mut substituted = configuration("r2", None);
        substituted["modelId"] = json!("default");
        let attempts = [
            (
                "run-3",
                3,
                "pending",
                None,
                configuration("r2", None),
                Value::Null,
                json!([]),
                None,
            ),
            (
                "run-2",
                2,
                "terminal",
                Some("cancelled"),
                configuration("r2", None),
                substituted,
                json!([]),
                Some("<svg data-run='2'/>"),
            ),
            (
                "run-1",
                1,
                "terminal",
                Some("judged"),
                configuration("r1", None),
                configuration("r1", Some("default")),
                judged,
                Some("<svg data-run='1'/>"),
            ),
        ];
        let mut tx = store.pool.begin().await.unwrap();
        for (run, created_at, phase, outcome, requested, observed, evaluations, output) in attempts
        {
            let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[requested],"repetitions":1,"timeoutSeconds":600,"maxExecutions":4,"preview":false});
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'running',1,?,?,?)")
                .bind(run).bind(run).bind(created_at).bind(created_at).bind(request.to_string())
                .execute(&mut *tx).await.unwrap();
            let attempt = json!({"id":format!("attempt-{run}"),"runId":run,"versionId":version.id,"configuration":requested,"observed":observed,"repetition":0,"phase":phase,"outcome":outcome,"output":output,"finishedAt":created_at,"durationMs":1000,"usage":{"schema":"native","output":120,"cost":0.05},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'sonnet',0,?,?)")
                .bind(format!("attempt-{run}")).bind(run).bind(&version.id).bind(phase).bind(attempt.to_string())
                .execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
        assert_eq!(entries.len(), 1);
        let card = &entries[0];
        assert_eq!(card.attempt_id, "attempt-run-1");
        assert_eq!(card.score, Some(0.7));
        // The card's cost is the candidate's own generation, whatever the judges cost.
        assert_eq!(card.cost, Some(0.05));
        assert_eq!(
            card.judges.iter().map(|j| j.score).collect::<Vec<_>>(),
            [0.6, 0.8]
        );
        assert_eq!(card.judges[0].details, Some(json!({"adherence":0.6})));
    }
    #[tokio::test]
    async fn an_excluded_authored_cell_is_no_gallery_entry() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let mut draft = super::super::seeds::definitions()
            .into_iter()
            .find(|d| d.work_class_id == "creative")
            .unwrap();
        draft.environment["authoredBy"] = json!(["fable"]);
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let configuration = json!({"id":"fable","providerId":"claude-acp","accountId":"account","modelId":"claude-fable-5-1","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"r1"});
        let insert = |run: &'static str, created_at: i64, attempt: Value| {
            let store = &store;
            let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[configuration],"repetitions":1,"timeoutSeconds":600,"maxExecutions":1,"preview":false});
            async move {
                sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'running',1,?,?,?)")
                    .bind(run).bind(run).bind(created_at).bind(created_at).bind(request.to_string())
                    .execute(&store.pool).await.unwrap();
                sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'fable',0,'terminal',?)")
                    .bind(attempt["id"].as_str().unwrap()).bind(run).bind(attempt["versionId"].as_str().unwrap()).bind(attempt.to_string())
                    .execute(&store.pool).await.unwrap();
            }
        };
        // The runner settled the planned cell without a model call.
        insert("run-2", 2, json!({"id":"excluded","runId":"run-2","versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":"excluded","reason":"authored by this candidate","output":null,"finishedAt":2,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]})).await;
        let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
        assert!(entries.is_empty());
        // A rendering an older run made still stands for that model.
        insert("run-1", 1, json!({"id":"rendering","runId":"run-1","versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":"pending_review","output":"<svg/>","finishedAt":1,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]})).await;
        let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].attempt_id, "rendering");
    }
    #[test]
    fn a_refused_rendering_stays_on_the_requested_card() {
        let requested = json!({"id":"opus","providerId":"claude-acp","accountId":"account","modelId":"opus","effort":"high","fastMode":true,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"r1"});
        let mut observed = requested.clone();
        observed["effort"] = json!("medium");
        let mut attempt: Attempt = serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v","configuration":requested,"observed":observed,"repetition":0,"phase":"terminal","outcome":"selection_changed","usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]})).unwrap();
        assert_eq!(card_configuration(&attempt).effort.as_deref(), Some("high"));
        attempt.observed.as_mut().unwrap().effort = Some("high".into());
        attempt.observed.as_mut().unwrap().fast_mode = Some(false);
        assert_eq!(card_configuration(&attempt).fast_mode, Some(true));
    }
    #[test]
    fn a_card_shows_the_newest_settled_judge_batch() {
        let evaluation = |provenance: &str, score: Option<f64>| -> Evaluation {
            let details = if provenance == "render" {
                json!({"expectedJudges": 2})
            } else {
                Value::Null
            };
            serde_json::from_value(json!({"id":"e","evaluatorRevision":"1","verdict":"v","score":score,"reason":"r","createdAt":1,"provenance":provenance,"artifacts":[],"details":details})).unwrap()
        };
        let mut evaluations = vec![
            evaluation("objective", None),
            evaluation("render", None),
            evaluation("judge", Some(0.6)),
            evaluation("judge", Some(0.8)),
        ];
        assert_eq!(scoring_batch(&evaluations), 1..4);
        // An unfinished re-evaluation keeps the settled panel on the card.
        evaluations.extend([
            evaluation("render", None),
            evaluation("judge", Some(0.2)),
            evaluation("judge_failure", None),
        ]);
        assert_eq!(scoring_batch(&evaluations), 1..4);
        evaluations.push(evaluation("judge", Some(0.4)));
        assert_eq!(scoring_batch(&evaluations), 4..8);
        assert_eq!(scoring_batch(&evaluations[..1]), 0..1);
    }
    #[tokio::test]
    async fn the_usage_ledger_counts_each_judge_session_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        let draft = super::super::seeds::definitions().remove(0);
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let config = json!({"id":"c","providerId":"claude-acp","accountId":"account","modelId":"sonnet","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let judge = json!({"id":"j","providerId":"claude-acp","accountId":"account","modelId":"haiku","effort":"low","fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let req = json!({"requestKey":"ledger","versionIds":[version.id],"configurations":[config],"repetitions":1,"timeoutSeconds":30,"maxExecutions":4});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','ledger','completed',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
        let evaluations = json!([
            {"id":"vote","evaluatorRevision":"1","verdict":"judged","score":0.7,"reason":"ok","createdAt":200,"provenance":"judge","artifacts":[],"details":{"sessionId":"judge-1","durationMs":40},"judge":judge,"usage":{"schema":"native","input":7,"output":3,"cost":0.01}},
            {"id":"abstained","evaluatorRevision":"1","verdict":"abstained","score":null,"reason":"off form","createdAt":150,"provenance":"judge_failure","artifacts":[],"details":{"sessionId":"judge-2","durationMs":20},"judge":judge,"usage":{"schema":"native","input":5,"output":2,"cost":0.02}},
            {"id":"busy","evaluatorRevision":"1","verdict":"abstained","score":null,"reason":"busy","createdAt":160,"provenance":"judge_failure","artifacts":[],"details":{"judgeBatchId":"b"},"judge":judge}
        ]);
        let attempt = json!({"id":"candidate","runId":"run","versionId":version.id,"configuration":config,"repetition":0,"phase":"terminal","outcome":"judged","sessionId":"candidate-session","observed":config,"finishedAt":100,"durationMs":10,"evidenceHash":"sealed","usage":{"input":30,"output":9,"cost":0.2,"schema":"native"},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[]});
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES('candidate','run',?,'c',0,'terminal',?)").bind(&version.id).bind(attempt.to_string()).execute(&store.pool).await.unwrap();
        let ledger = store.usage_ledger().await.unwrap();
        assert_eq!(
            ledger
                .iter()
                .map(|e| (e.session_id.as_str(), e.model_id.as_str(), e.finished_at))
                .collect::<Vec<_>>(),
            [
                ("candidate-session", "sonnet", 100),
                ("judge-2", "haiku", 150),
                ("judge-1", "haiku", 200)
            ]
        );
        assert_eq!(ledger[2].cost_usd, Some(0.01));
        assert_eq!(ledger[2].effort.as_deref(), Some("low"));
        assert_eq!(ledger[2].duration_ms, Some(40));
        assert_eq!(ledger[1].input_tokens, Some(5));
    }
    #[tokio::test]
    async fn history_summaries_and_result_pages_do_not_load_attempt_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let mut draft = super::super::seeds::definitions().remove(0);
        let definition = store.save_draft(None, None, draft.clone()).await.unwrap();
        let first = store.publish(&definition.id, 1).await.unwrap();
        draft.name.push_str(" second version");
        store
            .save_draft(Some(&definition.id), Some(1), draft)
            .await
            .unwrap();
        let second = store.publish(&definition.id, 2).await.unwrap();
        let configuration = json!({"id":"candidate","providerId":"provider","accountId":null,"modelId":"native-model","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let request = json!({"requestKey":"history","versionIds":[first.id,second.id],"configurations":[configuration],"repetitions":125,"timeoutSeconds":30,"maxExecutions":250,"preview":false});
        let output = "private evidence must remain lazy ".repeat(256);
        let mut tx = store.pool.begin().await.unwrap();
        for index in 0..105 {
            let id = format!("run-{index}");
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,?,?,?)")
                .bind(&id).bind(&id).bind(index).bind(index).bind(request.to_string())
                .execute(&mut *tx).await.unwrap();
        }
        for index in 0..126 {
            let id = format!("attempt-{index}");
            let run_id = if index == 125 { "run-0" } else { "run-104" };
            let version_id = if index % 2 == 0 || index == 125 {
                &first.id
            } else {
                &second.id
            };
            let phase = if index % 2 == 0 {
                "terminal"
            } else {
                "pending"
            };
            let outcome = if phase == "terminal" {
                Some("pass")
            } else {
                None
            };
            let attempt = json!({"id":id,"runId":run_id,"versionId":version_id,"configuration":configuration,"repetition":index,"phase":phase,"outcome":outcome,"output":output,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'candidate',?,?,?)")
                .bind(&id).bind(run_id).bind(version_id).bind(index).bind(phase).bind(attempt.to_string())
                .execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();

        let summaries = store.runs().await.unwrap();
        assert_eq!(summaries.len(), 100);
        assert_eq!(summaries[0].id, "run-104");
        assert_eq!(summaries[0].attempt_count, 125);
        assert_eq!(summaries[0].settled_count, 63);
        assert_eq!(summaries[1].attempt_count, 0);
        assert!(!summaries.iter().any(|r| r.id == "run-0"));
        let serialized = serde_json::to_value(&summaries).unwrap();
        assert!(serialized[0].get("attempts").is_none());
        assert!(!serialized.to_string().contains("private evidence"));

        let first_page = store.list_attempts(&ResultQuery::default()).await.unwrap();
        assert_eq!(first_page.len(), 50);
        assert_eq!(first_page[0].id, "attempt-0");
        assert_eq!(first_page[0].model_id, "native-model");
        let projection = serde_json::to_value(&first_page[0]).unwrap();
        assert_eq!(projection.as_object().unwrap().len(), 11);
        assert!(projection.get("output").is_none());
        assert!(projection.get("evaluations").is_none());
        assert_eq!(
            store
                .list_attempts(&ResultQuery {
                    limit: Some(1000),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            100
        );
        let query = ResultQuery {
            run_id: Some("run-104".into()),
            version_ids: Some(vec![first.id.clone()]),
            attempt_ids: None,
            as_of: None,
            offset: Some(50),
            limit: Some(50),
        };
        let filtered = store.list_attempts(&query).await.unwrap();
        assert_eq!(filtered.len(), 13);
        assert_eq!(filtered[0].id, "attempt-100");
        assert_eq!(filtered[12].id, "attempt-124");
        assert!(filtered
            .iter()
            .all(|a| a.outcome.as_deref() == Some("pass")));
        assert_eq!(
            serde_json::to_value(&filtered).unwrap(),
            serde_json::to_value(store.list_attempts(&query).await.unwrap()).unwrap()
        );
        let old_page = store
            .list_attempts(&ResultQuery {
                run_id: Some("run-0".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(old_page.len(), 1);
        assert_eq!(old_page[0].id, "attempt-125");
        assert!(store
            .list_attempts(&ResultQuery {
                run_id: Some("run-0".into()),
                version_ids: Some(vec![second.id]),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .list_attempts(&ResultQuery {
                version_ids: Some(vec![]),
                ..Default::default()
            })
            .await
            .unwrap()
            .is_empty());
        // Reports hand exact attempt ids to the evidence dialog.
        let picked = store
            .list_attempts(&ResultQuery {
                attempt_ids: Some(vec!["attempt-125".into(), "attempt-3".into()]),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            picked.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            ["attempt-3", "attempt-125"]
        );

        // Full internal records and direct evidence remain independently available.
        assert_eq!(store.all_runs().await.unwrap().len(), 105);
        assert_eq!(store.run("run-104").await.unwrap().attempts.len(), 125);
        assert_eq!(
            store.attempt("attempt-0").await.unwrap().output.as_deref(),
            Some(output.as_str())
        );
    }

    #[tokio::test]
    async fn a_dated_attempt_listing_shows_each_attempt_as_it_stood_then() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let draft = super::super::seeds::definitions().remove(0);
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let config = json!({"id":"c","providerId":"provider","accountId":"account","modelId":"native","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let req = json!({"requestKey":"dated","versionIds":[version.id],"configurations":[config],"repetitions":1,"timeoutSeconds":30,"maxExecutions":3});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','dated','completed',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
        let evaluation = |id: &str, at: i64, provenance: &str, verdict: &str, score: Value| json!({"id":id,"evaluatorRevision":"1","verdict":verdict,"score":score,"reason":"r","createdAt":at,"provenance":provenance,"artifacts":[]});
        let mut marker = evaluation("marker", 10, "render", "rendered", Value::Null);
        marker["details"] = json!({"expectedJudges": 2});
        let attempts = [
            // Failed at 2; a human review at 10 flipped it and its stored outcome.
            (
                "reviewed",
                "pass",
                Some(2),
                json!([
                    evaluation("objective", 2, "objective", "fail", json!(0.0)),
                    evaluation("review", 10, "human", "pass", json!(1.0))
                ]),
            ),
            // Waiting for its panel at 3; judged at 11 and 12.
            (
                "rendering",
                "judged",
                Some(2),
                json!([
                    evaluation("pending", 3, "objective", "pending_review", Value::Null),
                    marker,
                    evaluation("vote-1", 11, "judge", "judged", json!(0.6)),
                    evaluation("vote-2", 12, "judge", "judged", json!(0.8))
                ]),
            ),
            // Still running at 5; it finished at 9.
            (
                "later",
                "fail",
                Some(9),
                json!([evaluation("late", 9, "objective", "fail", json!(0.0))]),
            ),
        ];
        for (id, outcome, finished, evaluations) in attempts {
            let a = json!({"id":id,"runId":"run","versionId":version.id,"configuration":config,"repetition":0,"phase":"terminal","outcome":outcome,"startedAt":1,"finishedAt":finished,"durationMs":10,"usage":{"output":4,"cost":0.5,"schema":"native"},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,?,0,'terminal',?)").bind(id).bind(&version.id).bind(id).bind(a.to_string()).execute(&store.pool).await.unwrap();
        }
        let listed = |as_of: Option<i64>| {
            let store = &store;
            async move {
                store
                    .list_attempts(&ResultQuery {
                        attempt_ids: Some(vec![
                            "reviewed".into(),
                            "rendering".into(),
                            "later".into(),
                        ]),
                        as_of,
                        ..Default::default()
                    })
                    .await
                    .unwrap()
                    .into_iter()
                    .map(|a| (a.id.clone(), a))
                    .collect::<std::collections::BTreeMap<_, _>>()
            }
        };
        let today = listed(None).await;
        assert_eq!(today["reviewed"].outcome.as_deref(), Some("pass"));
        assert_eq!(today["rendering"].outcome.as_deref(), Some("judged"));
        assert_eq!(today["later"].outcome.as_deref(), Some("fail"));
        let then = listed(Some(5)).await;
        assert_eq!(then["reviewed"].outcome.as_deref(), Some("fail"));
        assert_eq!(then["rendering"].outcome.as_deref(), Some("pending_review"));
        let later = &then["later"];
        assert_eq!(
            (later.outcome.as_deref(), later.phase.as_str()),
            (None, "running")
        );
        assert_eq!((later.finished_at, later.cost), (None, None));
    }

    #[tokio::test]
    async fn a_run_summary_names_the_selections_its_attempts_ran_with() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let draft = super::super::seeds::definitions().remove(0);
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let config = json!({"id":"sonnet","providerId":"claude-acp","accountId":"account","modelId":"sonnet","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let req = json!({"requestKey":"observed","versionIds":[version.id],"configurations":[config],"repetitions":4,"timeoutSeconds":30,"maxExecutions":4});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','observed','running',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
        let observed = |model: &str, effort: &str| {
            let mut observed = config.clone();
            observed["modelId"] = json!(model);
            observed["effort"] = json!(effort);
            observed["fastMode"] = json!(false);
            observed
        };
        for (repetition, outcome, acknowledged) in [
            (0, "pass", observed("sonnet", "high")),
            (1, "fail", observed("sonnet", "high")),
            // A refusal and a substituted model ran no candidate selection.
            (2, "selection_changed", observed("sonnet", "low")),
            (3, "selection_changed", observed("default", "medium")),
        ] {
            let a = json!({"id":format!("a{repetition}"),"runId":"run","versionId":version.id,"configuration":config,"observed":acknowledged,"repetition":repetition,"phase":"terminal","outcome":outcome,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,'sonnet',?,'terminal',?)").bind(format!("a{repetition}")).bind(&version.id).bind(repetition).bind(a.to_string()).execute(&store.pool).await.unwrap();
        }
        let summary = store.runs().await.unwrap().remove(0);
        assert_eq!(
            summary.observed_selections,
            vec![ObservedRunSelection {
                configuration_id: "sonnet".into(),
                effort: Some("high".into()),
                fast_mode: Some(false),
            }]
        );
        // A finished run starts nothing, so its evidence is never read here.
        store.set_run_state("run", "completed").await.unwrap();
        assert!(store.runs().await.unwrap()[0]
            .observed_selections
            .is_empty());
    }

    #[tokio::test]
    async fn historical_definitions_and_filtered_usage_survive_ui_window_limits() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let draft = super::super::seeds::definitions().remove(0);
        let oldest = store.save_draft(None, None, draft.clone()).await.unwrap();
        let version = store.publish(&oldest.id, 1).await.unwrap();
        let mut tx = store.pool.begin().await.unwrap();
        for id in ["old-run", "new-run"] {
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,0,0,'{}')")
                .bind(id).bind(id).execute(&mut *tx).await.unwrap();
        }
        let draft_json = serde_json::to_string(&draft).unwrap();
        for index in 0..1005 {
            sqlx::query("INSERT INTO benchmark_definitions(id,draft_json,revision,archived) VALUES(?,?,1,0)")
                .bind(format!("definition-{index}")).bind(&draft_json).execute(&mut *tx).await.unwrap();
            let run_id = if index == 0 { "old-run" } else { "new-run" };
            let sample = json!({"id":format!("sample-{index}"),"runId":run_id,"accountScope":"account","windowId":"window","capturedAt":index,"attribution":"unknown","status":"unavailable","completedTasks":0,"reason":"test historical evidence","attemptIds":[]});
            sqlx::query("INSERT INTO usage_observations(id,run_id,data_json) VALUES(?,?,?)")
                .bind(format!("sample-{index}"))
                .bind(run_id)
                .bind(sample.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
        let visible = store.definitions().await.unwrap();
        assert_eq!(visible.len(), 1000);
        assert!(!visible.iter().any(|d| d.id == oldest.id));
        let historical = store.all_definitions().await.unwrap();
        assert_eq!(historical.len(), 1006);
        assert!(historical
            .iter()
            .flat_map(|d| &d.versions)
            .any(|v| v.id == version.id));
        let samples = store.usage_samples().await.unwrap();
        assert_eq!(samples.len(), 1005);
        assert!(samples.iter().any(|s| s.id == "sample-0"));
        let old_page = store
            .list_usage(&ResultQuery {
                run_id: Some("old-run".into()),
                limit: Some(10),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(old_page.len(), 1);
        assert_eq!(old_page[0].id, "sample-0");
        let latest_page = store
            .list_usage(&ResultQuery {
                limit: Some(2),
                offset: Some(1),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(
            latest_page
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            vec!["sample-1003", "sample-1002"]
        );
    }

    #[tokio::test]
    async fn ledger_counts_native_children_once_and_recovery_preserves_sealed_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        let draft = super::super::seeds::definitions().remove(0);
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let config = json!({"id":"c","providerId":"provider","accountId":"account","modelId":"native","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let req = json!({"requestKey":"test","versionIds":[version.id],"configurations":[config],"repetitions":1,"timeoutSeconds":30,"maxExecutions":3});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','test','running',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
        let make = |id: &str, input: u64| -> Attempt {
            serde_json::from_value(json!({"id":id,"runId":"run","versionId":version.id,"configuration":config,"repetition":0,"phase":"terminal","outcome":"completed","sessionId":format!("session-{id}"),"observed":config,"finishedAt":100,"durationMs":10,"evidenceHash":"sealed","usage":{"input":input,"output":1,"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]})).unwrap()
        };
        for (id, input) in [("root", 30), ("single", 5), ("cancelled", 0)] {
            let mut a = make(id, input);
            if id == "cancelled" {
                a.phase = "collecting".into();
                a.outcome = Some("cancelled".into());
                a.session_id = None;
            }
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,?,0,?,?)").bind(id).bind(&version.id).bind(id).bind(&a.phase).bind(serde_json::to_string(&a).unwrap()).execute(&store.pool).await.unwrap();
        }
        for (index, (id, input)) in [("child-1", 10), ("child-2", 20)].into_iter().enumerate() {
            let a = make(id, input);
            sqlx::query("INSERT INTO workflow_steps(attempt_id,root_attempt_id,step_index,step_id,entry_state_hash,entry_state_json,prompt,phase,data_json) VALUES(?,'root',?,?,'hash','{}','prompt','terminal',?)").bind(id).bind(index as i64).bind(id).bind(serde_json::to_string(&a).unwrap()).execute(&store.pool).await.unwrap();
        }
        let ledger = store.usage_ledger().await.unwrap();
        assert_eq!(ledger.len(), 3);
        assert_eq!(
            ledger.iter().filter_map(|e| e.input_tokens).sum::<u64>(),
            35
        );
        assert!(!ledger.iter().any(|e| e.attempt_id == "root"));
        // A rendering awaiting its panel has paid for its generation.
        let mut waiting = make("waiting", 4);
        waiting.phase = "awaiting_judges".into();
        waiting.outcome = Some("pending_review".into());
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES('waiting','run',?,'waiting',0,'awaiting_judges',?)").bind(&version.id).bind(serde_json::to_string(&waiting).unwrap()).execute(&store.pool).await.unwrap();
        let ledger = store.usage_ledger().await.unwrap();
        assert!(ledger
            .iter()
            .any(|e| e.attempt_id == "waiting" && e.input_tokens == Some(4)));
        store.recover().await.unwrap();
        let cancelled = store.attempt("cancelled").await.unwrap();
        assert_eq!(cancelled.outcome.as_deref(), Some("cancelled"));
        assert!(cancelled.output.is_none());
        // A sealed rendering awaiting its panel is no uncertain dispatch.
        let waiting = store.attempt("waiting").await.unwrap();
        assert_eq!(waiting.phase, "awaiting_judges");
        assert_eq!(waiting.outcome.as_deref(), Some("pending_review"));
    }
}
