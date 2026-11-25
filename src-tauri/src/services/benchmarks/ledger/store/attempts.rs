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

    /// Every settled native session and judge session in the store, for
    /// Stats. Only the runs written since the last read are read again; see
    /// `usage_ledger` below.
    pub async fn usage_ledger(&self) -> Result<Vec<UsageLedgerEntry>> {
        let kept = usage_ledger::kept_for(&self.root);
        let mut kept = kept.lock().await;
        // One snapshot for the marks and for every row read under them.
        let mut tx = self.pool.begin().await?;
        let ledger = usage_ledger::read(&mut tx, &mut kept).await?;
        tx.commit().await?;
        Ok(ledger)
    }

    /// Adds a pending attempt to a run that already exists.
    pub async fn insert_attempt(&self, attempt: &Attempt) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        Self::insert_in_transaction(&mut tx, attempt).await?;
        event(&mut tx, &attempt.run_id, "run_changed").await?;
        tx.commit().await?;
        Ok(())
    }

    async fn insert_in_transaction(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        attempt: &Attempt,
    ) -> Result<()> {
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,?,?,?)")
            .bind(&attempt.id)
            .bind(&attempt.run_id)
            .bind(&attempt.version_id)
            .bind(&attempt.configuration.id)
            .bind(attempt.repetition as i64)
            .bind(&attempt.phase)
            .bind(serde_json::to_string(attempt)?)
            .execute(&mut **tx)
            .await?;
        crate::services::benchmarks::workflow_campaign::check_reserved_versions(
            tx,
            std::slice::from_ref(&attempt.version_id),
            None,
        )
        .await?;
        Ok(())
    }

    /// Sets `superseded` aside and adds `fresh` in its repetition's slot in
    /// one transaction: a replacement the store refuses (a lock that outlasts
    /// the busy timeout, a version a frozen campaign reserved meanwhile)
    /// leaves the try it would replace standing, never a repetition with no
    /// attempt at all.
    pub async fn supersede_and_insert(&self, superseded: &Attempt, fresh: &Attempt) -> Result<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        Self::supersede_in_transaction(&mut tx, superseded).await?;
        Self::insert_in_transaction(&mut tx, fresh).await?;
        event(&mut tx, &superseded.run_id, "run_changed").await?;
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

/// The usage ledger, kept between reads.
///
/// Stats shows every settled session the store holds, and the app reads the
/// ledger on start and every five minutes, Stats open or not. Read whole, it
/// parses the JSON record of every attempt twice, and each record carries its
/// answer and evidence: on the 5 GB store of 2026-11-25 a read took a median
/// of 4.4 s (2.8 s and 1.6 s for its two statements, 272 reads in two days of
/// the app log) to find a few new rows (bug hunt of 2026-11-25, A-8).
///
/// A run's rows change only when one of its attempts or workflow steps does,
/// and every such write commits a `benchmark_events` row naming the run in
/// the same transaction (see `store::event`; a step's attempt carries its
/// root's run). SQLite has one writer, so the events a read's snapshot shows
/// are exactly those up to the newest one in it. A read after the first
/// therefore reads again only the runs an event named since the read before,
/// through the `(run_id, phase)` index, and takes the other runs' rows from
/// memory; it returns the rows a whole read returns, in the same order. An
/// attempt or step a writer added without an event is found by its rowid as
/// well. A store whose newest event or attempt went back (another database
/// under the same folder) is read whole again.
mod usage_ledger {
    use super::*;
    use sqlx::SqliteConnection;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, OnceLock};

    /// How far a read saw: the newest event, attempt and workflow step in its
    /// snapshot.
    #[derive(Clone, Copy, PartialEq, Eq)]
    struct Marks {
        event: i64,
        attempt: i64,
        step: i64,
    }

    /// The rows of one run.
    #[derive(Default)]
    struct RunRows {
        native: Vec<UsageLedgerEntry>,
        /// Judge sessions, each with the rowid of the attempt that holds the
        /// evaluation and its place among that attempt's evaluations: the
        /// order a whole read finds them in.
        judged: Vec<(i64, i64, UsageLedgerEntry)>,
    }

    /// The rows of every run the last read saw, and how far it saw.
    #[derive(Default)]
    pub(super) struct Kept {
        marks: Option<Marks>,
        runs: HashMap<String, RunRows>,
    }

    /// The ledger kept for the store in `root`. It lives here, by folder,
    /// rather than on `Store` (store.rs), which this change leaves alone;
    /// every `Store` opened on a folder reads the one database there.
    pub(super) fn kept_for(root: &Path) -> Arc<tokio::sync::Mutex<Kept>> {
        static KEPT: OnceLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<Kept>>>>> =
            OnceLock::new();
        // Nothing panics while the map is locked, so a poisoned lock still
        // guards a whole map.
        KEPT.get_or_init(Default::default)
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(root.to_path_buf())
            .or_default()
            .clone()
    }

    const MARKS: &str = "SELECT (SELECT COALESCE(MAX(sequence),0) FROM benchmark_events),(SELECT COALESCE(MAX(rowid),0) FROM attempts),(SELECT COALESCE(MAX(rowid),0) FROM workflow_steps)";

    /// The runs named by an event after `?1` up to `?2`, and the runs of the
    /// attempts and steps added after `?3` and `?5` up to `?4` and `?6`.
    const CHANGED_RUNS: &str = "SELECT entity_id FROM benchmark_events WHERE sequence>?1 AND sequence<=?2 UNION SELECT run_id FROM attempts WHERE rowid>?3 AND rowid<=?4 UNION SELECT r.run_id FROM workflow_steps s JOIN attempts r ON r.id=s.root_attempt_id WHERE s.rowid>?5 AND s.rowid<=?6";

    // Each native prompt owns its own session. Workflow roots aggregate these
    // children for benchmark quality, but must not count them twice in Stats.
    // A rendering awaiting its panel has already paid for its generation.
    // Every row names its run; a step's run is its root's.
    const NATIVE_ALL: &str = "WITH native_attempts AS (SELECT a.run_id,a.id,a.phase,a.data_json FROM attempts a WHERE COALESCE(json_array_length(a.data_json,'$.workflowSteps'),0)=0 AND NOT EXISTS(SELECT 1 FROM workflow_steps s WHERE s.root_attempt_id=a.id) UNION ALL SELECT r.run_id,s.attempt_id AS id,s.phase,s.data_json FROM workflow_steps s JOIN attempts r ON r.id=s.root_attempt_id) SELECT run_id,id,json_extract(data_json,'$.sessionId'),json_extract(data_json,'$.configuration.providerId'),COALESCE(json_extract(data_json,'$.observed.modelId'),json_extract(data_json,'$.configuration.modelId')),json_extract(data_json,'$.observed.effort'),json_extract(data_json,'$.usage.input'),json_extract(data_json,'$.usage.output'),json_extract(data_json,'$.usage.cost'),json_extract(data_json,'$.durationMs'),json_extract(data_json,'$.finishedAt') FROM native_attempts WHERE phase IN ('terminal','awaiting_judges') AND json_extract(data_json,'$.sessionId') IS NOT NULL AND json_extract(data_json,'$.evidenceHash') IS NOT NULL AND json_extract(data_json,'$.finishedAt') IS NOT NULL ORDER BY json_extract(data_json,'$.finishedAt'),id";

    /// `NATIVE_ALL` for the runs in the JSON array `?1`. Its outer filter on
    /// the phase, repeated on the attempts, lets the `(run_id, phase)` index
    /// find them.
    const NATIVE_OF_RUNS: &str = "WITH native_attempts AS (SELECT a.run_id,a.id,a.phase,a.data_json FROM attempts a WHERE a.run_id IN (SELECT value FROM json_each(?1)) AND a.phase IN ('terminal','awaiting_judges') AND COALESCE(json_array_length(a.data_json,'$.workflowSteps'),0)=0 AND NOT EXISTS(SELECT 1 FROM workflow_steps s WHERE s.root_attempt_id=a.id) UNION ALL SELECT r.run_id,s.attempt_id AS id,s.phase,s.data_json FROM attempts r JOIN workflow_steps s ON s.root_attempt_id=r.id WHERE r.run_id IN (SELECT value FROM json_each(?1))) SELECT run_id,id,json_extract(data_json,'$.sessionId'),json_extract(data_json,'$.configuration.providerId'),COALESCE(json_extract(data_json,'$.observed.modelId'),json_extract(data_json,'$.configuration.modelId')),json_extract(data_json,'$.observed.effort'),json_extract(data_json,'$.usage.input'),json_extract(data_json,'$.usage.output'),json_extract(data_json,'$.usage.cost'),json_extract(data_json,'$.durationMs'),json_extract(data_json,'$.finishedAt') FROM native_attempts WHERE phase IN ('terminal','awaiting_judges') AND json_extract(data_json,'$.sessionId') IS NOT NULL AND json_extract(data_json,'$.evidenceHash') IS NOT NULL AND json_extract(data_json,'$.finishedAt') IS NOT NULL ORDER BY json_extract(data_json,'$.finishedAt'),id";

    /// Every judge's evaluation of a settled attempt.
    const JUDGED_ALL: &str = "SELECT a.run_id,a.rowid,e.key,e.value FROM attempts a,json_each(a.data_json,'$.evaluations') e WHERE a.phase IN ('terminal','awaiting_judges') AND json_extract(e.value,'$.provenance') IN ('judge','judge_failure') AND json_extract(e.value,'$.details.sessionId') IS NOT NULL";

    /// `JUDGED_ALL` for the runs in the JSON array `?1`.
    const JUDGED_OF_RUNS: &str = "SELECT a.run_id,a.rowid,e.key,e.value FROM attempts a,json_each(a.data_json,'$.evaluations') e WHERE a.run_id IN (SELECT value FROM json_each(?1)) AND a.phase IN ('terminal','awaiting_judges') AND json_extract(e.value,'$.provenance') IN ('judge','judge_failure') AND json_extract(e.value,'$.details.sessionId') IS NOT NULL";

    /// The ledger as the snapshot `connection` reads in shows it, reading
    /// again only what changed since `kept`, which then holds this read.
    pub(super) async fn read(
        connection: &mut SqliteConnection,
        kept: &mut Kept,
    ) -> Result<Vec<UsageLedgerEntry>> {
        let row = sqlx::query(MARKS).fetch_one(&mut *connection).await?;
        let marks = Marks {
            event: row.get(0),
            attempt: row.get(1),
            step: row.get(2),
        };
        // Events are only added and attempts never deleted: fewer of either
        // is another database, read whole. Steps are deleted when unstarted
        // work is prepared afresh, and an event names that run.
        let seen = kept
            .marks
            .filter(|seen| seen.event <= marks.event && seen.attempt <= marks.attempt);
        match seen {
            None => kept.runs = rows(connection, None).await?,
            Some(seen) if seen != marks => {
                let changed: Vec<String> = sqlx::query_scalar(CHANGED_RUNS)
                    .bind(seen.event)
                    .bind(marks.event)
                    .bind(seen.attempt)
                    .bind(marks.attempt)
                    .bind(seen.step)
                    .bind(marks.step)
                    .fetch_all(&mut *connection)
                    .await?;
                if !changed.is_empty() {
                    let mut fresh = rows(connection, Some(&changed)).await?;
                    for run in changed {
                        match fresh.remove(&run) {
                            Some(rows) => kept.runs.insert(run, rows),
                            None => kept.runs.remove(&run),
                        };
                    }
                }
            }
            Some(_) => {}
        }
        kept.marks = Some(marks);
        Ok(ledger(&kept.runs))
    }

    /// The rows of every run, or of the runs in `runs`, by run.
    async fn rows(
        connection: &mut SqliteConnection,
        runs: Option<&[String]>,
    ) -> Result<HashMap<String, RunRows>> {
        let runs = runs.map(serde_json::to_string).transpose()?;
        let mut by_run: HashMap<String, RunRows> = HashMap::new();
        let native = match &runs {
            None => sqlx::query(NATIVE_ALL),
            Some(runs) => sqlx::query(NATIVE_OF_RUNS).bind(runs),
        }
        .fetch_all(&mut *connection)
        .await?;
        for r in native {
            by_run
                .entry(r.get(0))
                .or_default()
                .native
                .push(UsageLedgerEntry {
                    attempt_id: r.get(1),
                    session_id: r.get(2),
                    provider_id: r.get(3),
                    model_id: r.get(4),
                    effort: r.get(5),
                    input_tokens: r.get::<Option<i64>, _>(6).map(|v| v as u64),
                    output_tokens: r.get::<Option<i64>, _>(7).map(|v| v as u64),
                    cost_usd: r.get(8),
                    duration_ms: r.get::<Option<i64>, _>(9).map(|v| v as u64),
                    finished_at: r.get(10),
                });
        }
        let judged = match &runs {
            None => sqlx::query(JUDGED_ALL),
            Some(runs) => sqlx::query(JUDGED_OF_RUNS).bind(runs),
        }
        .fetch_all(&mut *connection)
        .await?;
        for r in judged {
            let evaluation: Evaluation = serde_json::from_str(r.get::<&str, _>(3))?;
            if let (Some(judge), Some(usage), Some(details)) =
                (evaluation.judge, evaluation.usage, evaluation.details)
            {
                let entry = UsageLedgerEntry {
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
                };
                by_run
                    .entry(r.get(0))
                    .or_default()
                    .judged
                    .push((r.get(1), r.get(2), entry));
            }
        }
        Ok(by_run)
    }

    /// The rows of `runs` in the order a whole read gives them: the native
    /// sessions by finish time and id, then the judge sessions as found,
    /// then all of them sorted by finish time and id, ties kept in that order.
    fn ledger(runs: &HashMap<String, RunRows>) -> Vec<UsageLedgerEntry> {
        let mut native: Vec<&UsageLedgerEntry> =
            runs.values().flat_map(|run| &run.native).collect();
        native.sort_by(|a, b| (a.finished_at, &a.attempt_id).cmp(&(b.finished_at, &b.attempt_id)));
        let mut judged: Vec<&(i64, i64, UsageLedgerEntry)> =
            runs.values().flat_map(|run| &run.judged).collect();
        judged.sort_by_key(|judged| (judged.0, judged.1));
        let mut ledger: Vec<UsageLedgerEntry> = native
            .into_iter()
            .cloned()
            .chain(judged.into_iter().map(|judged| judged.2.clone()))
            .collect();
        ledger.sort_by_key(|entry| (entry.finished_at, entry.attempt_id.clone()));
        ledger
    }
}

#[cfg(test)]
mod usage_ledger_tests {
    use super::*;
    use serde_json::{json, Value};

    async fn kept_ledger(store: &Store) -> Vec<Value> {
        let ledger = store.usage_ledger().await.unwrap();
        ledger
            .iter()
            .map(|e| serde_json::to_value(e).unwrap())
            .collect()
    }

    /// The ledger read whole, as every read was before it was kept.
    async fn whole_ledger(store: &Store) -> Vec<Value> {
        let mut connection = store.pool.acquire().await.unwrap();
        let mut nothing_kept = usage_ledger::Kept::default();
        let ledger = usage_ledger::read(&mut connection, &mut nothing_kept)
            .await
            .unwrap();
        ledger
            .iter()
            .map(|e| serde_json::to_value(e).unwrap())
            .collect()
    }

    fn ids(ledger: &[Value]) -> Vec<&str> {
        ledger
            .iter()
            .map(|e| e["attemptId"].as_str().unwrap())
            .collect()
    }

    fn input_of(ledger: &[Value], id: &str) -> Option<u64> {
        ledger
            .iter()
            .find(|e| e["attemptId"] == id)
            .and_then(|e| e["inputTokens"].as_u64())
    }

    /// What a store write commits with every attempt it writes.
    async fn name_run(store: &Store, run: &str) {
        sqlx::query(
            "INSERT INTO benchmark_events(entity_id,kind,created_at) VALUES(?,'attempt_changed',0)",
        )
        .bind(run)
        .execute(&store.pool)
        .await
        .unwrap();
    }

    async fn insert_settled(store: &Store, attempt: &Value) {
        let id = attempt["id"].as_str().unwrap();
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,0,'terminal',?)")
            .bind(id)
            .bind(attempt["runId"].as_str().unwrap())
            .bind(attempt["versionId"].as_str().unwrap())
            .bind(id)
            .bind(attempt.to_string())
            .execute(&store.pool)
            .await
            .unwrap();
    }

    /// The ledger is kept between reads: a read reads again only the runs
    /// written since the one before, and returns what a whole read returns
    /// (bug hunt of 2026-11-25, A-8).
    #[tokio::test]
    async fn the_usage_ledger_reads_again_only_the_runs_written_since() {
        let dir = crate::test_support::TempRoot::new();
        let store = Store::open(dir.path()).await.unwrap();
        dir.register(&store.pool);
        let draft = crate::services::benchmarks::seeds::definitions().remove(0);
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let config = json!({"id":"c","providerId":"claude-acp","accountId":"account","modelId":"sonnet","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let judge = json!({"id":"j","providerId":"claude-acp","accountId":"account","modelId":"haiku","effort":"low","fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        for run in ["one", "two"] {
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'running',1,0,0,'{}')")
                .bind(run).bind(run).execute(&store.pool).await.unwrap();
        }
        let settled = |id: &str, run: &str, input: u64, finished_at: i64, evaluations: Value| json!({"id":id,"runId":run,"versionId":version.id,"configuration":config,"repetition":0,"phase":"terminal","outcome":"completed","sessionId":format!("session-{id}"),"observed":config,"finishedAt":finished_at,"durationMs":10,"evidenceHash":"sealed","usage":{"input":input,"output":1,"schema":"native"},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[]});
        let vote = json!([{"id":"vote","evaluatorRevision":"1","verdict":"judged","score":0.7,"reason":"ok","createdAt":150,"provenance":"judge","artifacts":[],"details":{"sessionId":"judge-1","durationMs":40},"judge":judge,"usage":{"schema":"native","input":7,"output":3,"cost":0.01}}]);
        insert_settled(&store, &settled("a1", "one", 5, 100, vote)).await;
        insert_settled(&store, &settled("b1", "two", 7, 90, json!([]))).await;
        name_run(&store, "one").await;
        name_run(&store, "two").await;

        let first = kept_ledger(&store).await;
        assert_eq!(ids(&first), ["b1", "a1", "vote"]);
        assert_eq!(first, whole_ledger(&store).await);

        // Run one written around the store, without the event every store
        // write commits: it is not read again, so the kept row stands.
        sqlx::query(
            "UPDATE attempts SET data_json=json_set(data_json,'$.usage.input',99) WHERE id='a1'",
        )
        .execute(&store.pool)
        .await
        .unwrap();
        assert_eq!(input_of(&kept_ledger(&store).await, "a1"), Some(5));
        assert_eq!(input_of(&whole_ledger(&store).await, "a1"), Some(99));
        // The event naming run one: it is read again.
        name_run(&store, "one").await;
        let named = kept_ledger(&store).await;
        assert_eq!(input_of(&named, "a1"), Some(99));
        assert_eq!(named, whole_ledger(&store).await);

        // An attempt added without an event is found by its rowid.
        insert_settled(&store, &settled("b2", "two", 3, 95, json!([]))).await;
        let added = kept_ledger(&store).await;
        assert_eq!(ids(&added), ["b1", "b2", "a1", "vote"]);
        assert_eq!(added, whole_ledger(&store).await);

        // A workflow step under a1: the root no longer counts, its step does.
        sqlx::query("INSERT INTO workflow_steps(attempt_id,root_attempt_id,step_index,step_id,entry_state_hash,entry_state_json,prompt,phase,data_json) VALUES('a1-step','a1',0,'a1-step','hash','{}','prompt','terminal',?)")
            .bind(settled("a1-step", "one", 4, 120, json!([])).to_string())
            .execute(&store.pool).await.unwrap();
        name_run(&store, "one").await;
        let stepped = kept_ledger(&store).await;
        assert_eq!(ids(&stepped), ["b1", "b2", "a1-step", "vote"]);
        assert_eq!(stepped, whole_ledger(&store).await);
        // Nothing written since: the same rows again.
        assert_eq!(kept_ledger(&store).await, stepped);
        dir.close().await;
    }
}
