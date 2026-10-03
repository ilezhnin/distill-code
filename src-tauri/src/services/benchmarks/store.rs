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
        let rows=sqlx::query("SELECT id,draft_json,revision,archived FROM benchmark_definitions ORDER BY rowid DESC LIMIT 1000").fetch_all(&self.pool).await?;
        let mut out = Vec::new();
        for r in rows {
            let id: String = r.get(0);
            out.push(BenchmarkDefinition {
                id: id.clone(),
                draft: serde_json::from_str(r.get(1))?,
                draft_revision: r.get(2),
                archived: r.get(3),
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
            "SELECT draft_json,revision,archived FROM benchmark_definitions WHERE id=?",
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
            versions: self.versions_for(id).await?,
        })
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
                .map(|v| serde_json::from_str(&v))
                .collect::<std::result::Result<_, _>>()?,
        })
    }
    /// Recent history needs plans and counts, never serialized attempt evidence.
    pub async fn runs(&self) -> Result<Vec<RunSummary>> {
        let rows = sqlx::query(
            "SELECT r.id,r.state,r.revision,r.created_at,r.updated_at,r.request_json,
                (SELECT COUNT(*) FROM attempts a WHERE a.run_id=r.id),
                (SELECT COUNT(*) FROM attempts a WHERE a.run_id=r.id AND a.phase='terminal')
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
                json_extract(a.data_json,'$.usage.cost')
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
            .map(|r| AttemptSummary {
                id: r.get(0),
                run_id: r.get(1),
                version_id: r.get(2),
                model_id: r.get(3),
                phase: r.get(4),
                outcome: r.get(5),
                repetition: r.get::<Option<u32>, _>(6).unwrap_or(0),
                finished_at: r.get(7),
                duration_ms: r.get(8),
                output_tokens: r.get(9),
                cost: r.get(10),
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
        let mut seen = std::collections::BTreeSet::new();
        let mut out = Vec::new();
        for row in rows {
            let attempt: Attempt = serde_json::from_str(&row.get::<String, _>(0))?;
            let manifest: BenchmarkDraft = serde_json::from_str(&row.get::<String, _>(1))?;
            let configuration = super::analysis::execution_configuration(&attempt).clone();
            let key = (
                attempt.version_id.clone(),
                super::analysis::configuration_key(&configuration),
            );
            if !seen.insert(key) {
                continue;
            }
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
            let judges = attempt
                .evaluations
                .iter()
                .filter(|e| e.provenance == "judge")
                .filter_map(|e| {
                    Some(DesignJudge {
                        configuration: e.judge.clone()?,
                        score: e.score?,
                        reason: e.reason.clone(),
                        details: e.details.clone(),
                    })
                })
                .collect();
            let score = super::analysis::score(&attempt);
            out.push(DesignEntry {
                attempt_id: attempt.id.clone(),
                run_id: attempt.run_id.clone(),
                run_created_at: row.get(2),
                version_id: attempt.version_id.clone(),
                name: manifest.name.clone(),
                task_family: manifest.task_family.clone(),
                difficulty: manifest.facets.difficulty.clone(),
                output_format: manifest.facets.output_format.clone(),
                configuration,
                phase: attempt.phase.clone(),
                outcome: attempt.outcome.clone(),
                output: attempt.output.clone(),
                finished_at: attempt.finished_at,
                duration_ms: attempt.duration_ms,
                output_tokens: attempt.usage.output,
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
        Ok(serde_json::from_str(&data)?)
    }
    pub async fn usage_ledger(&self) -> Result<Vec<UsageLedgerEntry>> {
        // Each native prompt owns its own session. Workflow roots aggregate these
        // children for benchmark quality, but must not count them twice in Stats.
        let rows=sqlx::query("WITH native_attempts AS (SELECT id,phase,data_json FROM attempts a WHERE COALESCE(json_array_length(data_json,'$.workflowSteps'),0)=0 AND NOT EXISTS(SELECT 1 FROM workflow_steps s WHERE s.root_attempt_id=a.id) UNION ALL SELECT attempt_id AS id,phase,data_json FROM workflow_steps) SELECT id,json_extract(data_json,'$.sessionId'),json_extract(data_json,'$.configuration.providerId'),COALESCE(json_extract(data_json,'$.observed.modelId'),json_extract(data_json,'$.configuration.modelId')),json_extract(data_json,'$.observed.effort'),json_extract(data_json,'$.usage.input'),json_extract(data_json,'$.usage.output'),json_extract(data_json,'$.usage.cost'),json_extract(data_json,'$.durationMs'),json_extract(data_json,'$.finishedAt') FROM native_attempts WHERE phase='terminal' AND json_extract(data_json,'$.sessionId') IS NOT NULL AND json_extract(data_json,'$.evidenceHash') IS NOT NULL AND json_extract(data_json,'$.finishedAt') IS NOT NULL ORDER BY json_extract(data_json,'$.finishedAt'),id").fetch_all(&self.pool).await?;
        Ok(rows
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
            .collect())
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
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT data_json FROM attempts WHERE phase NOT IN ('pending','terminal')",
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
    use serde_json::json;

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
        store.recover().await.unwrap();
        let cancelled = store.attempt("cancelled").await.unwrap();
        assert_eq!(cancelled.outcome.as_deref(), Some("cancelled"));
        assert!(cancelled.output.is_none());
    }
}
