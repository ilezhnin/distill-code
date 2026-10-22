use super::types::*;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Row, SqlitePool,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Store {
    pub pool: SqlitePool,
    pub root: PathBuf,
    parsed: Arc<Parsed>,
}
/// Parsed copies of what is read most and changes least: published versions
/// by id and drafts by definition. A version's columns and a draft's revision
/// are read from the database every time, and a change in any of them parses
/// it again; a manifest itself never changes under its content hash.
#[derive(Default)]
struct Parsed {
    versions: Mutex<HashMap<String, Arc<BenchmarkVersion>>>,
    drafts: Mutex<HashMap<String, (i64, Arc<BenchmarkDraft>)>>,
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A terminal repetition awaiting a panel is settled only once that entire
/// panel scores. Its first valid vote is not a completed measurement. The
/// listing projects evaluations only for these repetitions, never outputs.
fn settled_cells(raw: &str) -> Result<u64> {
    type Cell = (
        String,
        String,
        String,
        Option<String>,
        Option<Vec<Evaluation>>,
    );
    let rows: Vec<Cell> = serde_json::from_str(raw)?;
    let mut cells = HashMap::new();
    for (configuration, version, phase, outcome, evaluations) in rows {
        let settled = phase == "terminal"
            && (outcome.as_deref() != Some("pending_review")
                || super::analysis::score_of(
                    outcome.as_deref(),
                    None,
                    evaluations.as_deref().unwrap_or_default(),
                    None,
                )
                .is_some());
        *cells.entry((configuration, version)).or_insert(true) &= settled;
    }
    Ok(cells.values().filter(|settled| **settled).count() as u64)
}

/// A SQL expression reading a [`ManifestSummary`] out of the manifest JSON in
/// `column`, path by path. Nothing outside these paths leaves SQLite, however
/// large the prompt, fixtures, checks or environment are. Defaults follow
/// [`BenchmarkDraft`]'s serde defaults. `json()` keeps nested values JSON
/// through CASE and subqueries.
fn manifest_summary_sql(column: &str) -> String {
    const SQL: &str = "json_object(
        'name',json_extract(@,'$.name'),
        'category',json_extract(@,'$.category'),
        'taskFamily',json_extract(@,'$.taskFamily'),
        'split',json_extract(@,'$.split'),
        'executionProfile',json_extract(@,'$.executionProfile'),
        'measurementProfile',json_extract(@,'$.measurementProfile'),
        'evaluator',json_object('kind',json_extract(@,'$.evaluator.kind'),'revision',json_extract(@,'$.evaluator.revision')),
        'limits',json_object('timeoutSeconds',json_extract(@,'$.limits.timeoutSeconds'),'maxTurns',json_extract(@,'$.limits.maxTurns'),'maxArtifactBytes',json_extract(@,'$.limits.maxArtifactBytes')),
        'repetitions',json_extract(@,'$.repetitions'),
        'workClassId',COALESCE(json_extract(@,'$.workClassId'),'general'),
        'roleId',json_extract(@,'$.roleId'),
        'roleContextHash',COALESCE(json_extract(@,'$.roleContextHash'),'clean-v1'),
        'facets',json_object('language',json_extract(@,'$.facets.language'),'domain',json_extract(@,'$.facets.domain'),'difficulty',json_extract(@,'$.facets.difficulty'),'inputBytes',json_extract(@,'$.facets.inputBytes'),'outputFormat',json_extract(@,'$.facets.outputFormat')),
        'entryState',json(CASE WHEN json_type(@,'$.entryState')='object' THEN json_object('contentHash',json_extract(@,'$.entryState.contentHash')) END),
        'workflow',json(CASE WHEN json_type(@,'$.workflow')='object' THEN json_object('steps',json((SELECT json_group_array(json_object('id',json_extract(s.value,'$.id'),'scope',json(CASE WHEN json_type(s.value,'$.scope')='object' THEN json_object('roleId',json_extract(s.value,'$.scope.roleId'),'workClassId',json_extract(s.value,'$.scope.workClassId'),'purpose',json_extract(s.value,'$.scope.purpose'),'stepBudgetSeconds',json_extract(s.value,'$.scope.stepBudgetSeconds')) END))) FROM json_each(@,'$.workflow.steps') s))) END),
        'environment',json_object(
            'authoredBy',json(CASE WHEN json_type(@,'$.environment.authoredBy')='array' THEN (SELECT json_group_array(json_object('providerId',json_extract(a.value,'$.providerId'),'modelId',json_extract(a.value,'$.modelId'),'effort',json_extract(a.value,'$.effort'))) FROM json_each(@,'$.environment.authoredBy') a WHERE a.type='object' AND json_type(a.value,'$.providerId')='text' AND json_type(a.value,'$.modelId')='text' AND json_type(a.value,'$.effort') IN ('text','null')) END),
            'splitGroup',CASE WHEN json_type(@,'$.environment.splitGroup')='text' THEN json_extract(@,'$.environment.splitGroup') END,
            'judgePanel',json(CASE WHEN json_type(@,'$.environment.judgePanel.judges')='array' THEN json_object('judges',json((SELECT json_group_array(json_object('providerId',json_extract(j.value,'$.providerId'),'modelId',json_extract(j.value,'$.modelId'),'effort',json_extract(j.value,'$.effort'))) FROM json_each(@,'$.environment.judgePanel.judges') j))) WHEN json_type(@,'$.environment.judgePanel')='object' THEN json_object() END),
            'generator',json(CASE WHEN json_type(@,'$.environment.generator.family')='text' THEN json_object('family',json_extract(@,'$.environment.generator.family')) END)))";
    SQL.replace('@', column)
}
/// Parses [`manifest_summary_sql`]'s JSON. Environment keys a manifest does
/// not declare stay absent rather than null.
fn manifest_summary(json: &str) -> Result<ManifestSummary> {
    let mut summary: ManifestSummary = serde_json::from_str(json)?;
    if let serde_json::Value::Object(environment) = &mut summary.environment {
        environment.retain(|_, value| !value.is_null());
    }
    Ok(summary)
}
/// How long a statement waits for another connection's write to finish.
/// Tests run hundreds of stores side by side, and a loaded CI runner holds
/// a test's own transactions far longer (10-18: a campaign test paused on
/// "database is locked"), so tests wait longer; the app keeps 10 s.
#[cfg(not(test))]
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
#[cfg(test)]
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

impl Store {
    pub async fn open(root: &Path) -> Result<Self> {
        tokio::fs::create_dir_all(root).await?;
        let options = SqliteConnectOptions::new()
            .filename(root.join("benchmarks.db"))
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(BUSY_TIMEOUT);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations_benchmarks")
            .run(&pool)
            .await
            .map_err(|e| BenchmarkError::new("storage_unavailable", e.to_string()))?;
        let store = Self {
            pool,
            root: root.to_owned(),
            parsed: Arc::default(),
        };
        store.reclassify_legacy_work_classes().await?;
        Ok(store)
    }
    /// Moves every case of a class retired on October 5, 2026 to its class of
    /// today, once. A class is metadata about a case, not a change to its
    /// task, so the version keeps its id and its measured cells; only its
    /// manifest and content hash move, through the same published blob the
    /// catalog writes. Drafts move with their definitions.
    async fn reclassify_legacy_work_classes(&self) -> Result<()> {
        const MARKER: &str = "work-classes-2026-10-05";
        let done: Option<String> =
            sqlx::query_scalar("SELECT id FROM catalog_seed_sets WHERE id=?")
                .bind(MARKER)
                .fetch_optional(&self.pool)
                .await?;
        if done.is_some() {
            return Ok(());
        }
        let reclassified = |draft: &mut BenchmarkDraft| -> bool {
            let Some((class, difficulty)) =
                super::routing::legacy_work_class(&draft.work_class_id, &draft.name)
            else {
                return false;
            };
            draft.work_class_id = class.into();
            if draft.facets.difficulty.is_none() {
                draft.facets.difficulty = difficulty.map(Into::into);
            }
            true
        };
        let versions = sqlx::query("SELECT id,manifest_json FROM benchmark_versions")
            .fetch_all(&self.pool)
            .await?;
        for row in versions {
            let id: String = row.get(0);
            let mut manifest: BenchmarkDraft = serde_json::from_str(row.get(1))?;
            if !reclassified(&mut manifest) {
                continue;
            }
            let hash = super::fixtures::publish_blob(&self.root, &manifest).await?;
            sqlx::query("UPDATE benchmark_versions SET manifest_json=?,content_hash=? WHERE id=?")
                .bind(serde_json::to_string(&manifest)?)
                .bind(hash)
                .bind(&id)
                .execute(&self.pool)
                .await?;
        }
        let definitions = sqlx::query("SELECT id,draft_json FROM benchmark_definitions")
            .fetch_all(&self.pool)
            .await?;
        for row in definitions {
            let id: String = row.get(0);
            let mut draft: BenchmarkDraft = serde_json::from_str(row.get(1))?;
            if !reclassified(&mut draft) {
                continue;
            }
            sqlx::query("UPDATE benchmark_definitions SET draft_json=? WHERE id=?")
                .bind(serde_json::to_string(&draft)?)
                .bind(&id)
                .execute(&self.pool)
                .await?;
        }
        sqlx::query(
            "INSERT INTO catalog_seed_sets(id,seeded_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(MARKER)
        .bind(now())
        .execute(&self.pool)
        .await?;
        Ok(())
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
    /// UI catalog window: the newest 1,000 definitions, as summaries. SQLite
    /// reads the listed paths out of each manifest, so the app never holds
    /// the task contents of the whole catalog at once. Evidence and export
    /// consumers must use all_definitions so old published cases remain visible.
    pub async fn definition_summaries(&self) -> Result<Vec<BenchmarkDefinitionSummary>> {
        let rows = sqlx::query(&format!(
            "SELECT id,revision,archived,archived_at,{} FROM benchmark_definitions ORDER BY rowid DESC LIMIT 1000",
            manifest_summary_sql("draft_json")
        ))
        .fetch_all(&self.pool)
        .await?;
        let versions = format!(
            "SELECT id,content_hash,published_at,carries_from,{} FROM benchmark_versions WHERE definition_id=? ORDER BY published_at DESC,rowid DESC",
            manifest_summary_sql("manifest_json")
        );
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let id: String = r.get(0);
            let mut listed = Vec::new();
            for v in sqlx::query(&versions)
                .bind(&id)
                .fetch_all(&self.pool)
                .await?
            {
                listed.push(BenchmarkVersionSummary {
                    id: v.get(0),
                    definition_id: id.clone(),
                    content_hash: v.get(1),
                    published_at: v.get(2),
                    carries_from: v.get(3),
                    manifest: manifest_summary(v.get(4))?,
                });
            }
            out.push(BenchmarkDefinitionSummary {
                archive_history: self.archive_history(&id).await?,
                draft_revision: r.get(1),
                archived: r.get(2),
                archived_at: r.get(3),
                draft: manifest_summary(r.get(4))?,
                versions: listed,
                id,
            });
        }
        Ok(out)
    }
    pub async fn has_definitions(&self) -> Result<bool> {
        Ok(
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM benchmark_definitions)")
                .fetch_one(&self.pool)
                .await?,
        )
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
            "SELECT revision,archived,archived_at FROM benchmark_definitions WHERE id=?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| BenchmarkError::new("validation", "Definition not found"))?;
        let (draft_revision, draft) = self.draft(id, r.get(0)).await?;
        Ok(BenchmarkDefinition {
            id: id.into(),
            draft: Arc::unwrap_or_clone(draft),
            draft_revision,
            archived: r.get(1),
            archived_at: r.get(2),
            archive_history: self.archive_history(id).await?,
            versions: self.versions_for(id).await?,
        })
    }
    /// `id`'s draft at `revision`, parsed once per revision; a newer revision
    /// is read together with its own number.
    async fn draft(&self, id: &str, revision: i64) -> Result<(i64, Arc<BenchmarkDraft>)> {
        let cached = self.parsed.drafts.lock().unwrap().get(id).cloned();
        if let Some((at, draft)) = cached.filter(|(at, _)| *at == revision) {
            return Ok((at, draft));
        }
        let r = sqlx::query("SELECT revision,draft_json FROM benchmark_definitions WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| BenchmarkError::new("validation", "Definition not found"))?;
        let revision: i64 = r.get(0);
        let draft = Arc::new(serde_json::from_str::<BenchmarkDraft>(r.get(1))?);
        self.parsed
            .drafts
            .lock()
            .unwrap()
            .insert(id.into(), (revision, draft.clone()));
        Ok((revision, draft))
    }
    /// What the analyses read of every definition, in catalog order: whether
    /// and when it was archived. No draft or manifest is read.
    pub async fn definition_states(&self) -> Result<Vec<DefinitionState>> {
        let mut history: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
        for r in sqlx::query(
            "SELECT definition_id,archived_at,restored_at FROM benchmark_definition_archives ORDER BY archived_at",
        )
        .fetch_all(&self.pool)
        .await?
        {
            history
                .entry(r.get(0))
                .or_default()
                .push((r.get(1), r.get(2)));
        }
        let rows =
            sqlx::query("SELECT id,archived,archived_at FROM benchmark_definitions ORDER BY rowid")
                .fetch_all(&self.pool)
                .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let id: String = r.get(0);
                DefinitionState {
                    archive_history: history.remove(&id).unwrap_or_default(),
                    id,
                    archived: r.get(1),
                    archived_at: r.get(2),
                }
            })
            .collect())
    }
    /// Every published version: definitions in catalog order, each one's
    /// newest first, as [`Self::all_definitions`] lists them.
    pub async fn all_versions(&self) -> Result<Vec<BenchmarkVersion>> {
        let ids = sqlx::query_scalar::<_, String>(
            "SELECT v.id FROM benchmark_versions v JOIN benchmark_definitions d ON d.id=v.definition_id ORDER BY d.rowid,v.published_at DESC,v.rowid DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            out.push(Arc::unwrap_or_clone(self.version_shared(&id).await?));
        }
        Ok(out)
    }
    /// Drops the parsed copies, for fixtures that rewrite a stored manifest
    /// or draft in place behind the store.
    #[cfg(test)]
    pub(crate) fn forget_parsed(&self) {
        self.parsed.versions.lock().unwrap().clear();
        self.parsed.drafts.lock().unwrap().clear();
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
        let ids = sqlx::query_scalar::<_, String>(
            "SELECT id FROM benchmark_versions WHERE definition_id=? ORDER BY published_at DESC,rowid DESC",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(ids.len());
        for version in ids {
            out.push(Arc::unwrap_or_clone(self.version_shared(&version).await?));
        }
        Ok(out)
    }
    /// Historical manifests stay readable; only current versions accept new work.
    pub async fn require_current_versions(&self, ids: &[String]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        Self::require_current_versions_in(&mut tx, ids).await
    }
    pub(super) async fn require_current_versions_in(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        ids: &[String],
    ) -> Result<()> {
        for id in ids {
            let current: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM benchmark_versions v JOIN benchmark_definitions d ON d.id=v.definition_id WHERE v.id=? AND d.archived=0 AND v.id=(SELECT newest.id FROM benchmark_versions newest WHERE newest.definition_id=v.definition_id ORDER BY newest.published_at DESC,newest.rowid DESC LIMIT 1))",
            ).bind(id).fetch_one(&mut **tx).await?;
            if !current {
                return Err(BenchmarkError::new(
                    "version_retired",
                    "This test version is archived or unavailable; select its latest published version for a new run",
                ));
            }
            let difficulty: Option<String> = sqlx::query_scalar("SELECT json_extract(manifest_json,'$.facets.difficulty') FROM benchmark_versions WHERE id=?")
                .bind(id).fetch_one(&mut **tx).await?;
            if !matches!(difficulty.as_deref(), Some("easy" | "medium" | "hard")) {
                return Err(BenchmarkError::new("validation", "Set the test difficulty to easy, medium or hard and publish it before starting new work"));
            }
        }
        Ok(())
    }
    pub async fn version(&self, id: &str) -> Result<BenchmarkVersion> {
        Ok(Arc::unwrap_or_clone(self.version_shared(id).await?))
    }
    /// A published version, its manifest parsed once: the small columns are
    /// read every time, and the cached copy is used while they all match.
    pub async fn version_shared(&self, id: &str) -> Result<Arc<BenchmarkVersion>> {
        let r=sqlx::query("SELECT definition_id,content_hash,published_at,carries_from FROM benchmark_versions WHERE id=?").bind(id).fetch_optional(&self.pool).await?.ok_or_else(||BenchmarkError::new("validation","Published version not found"))?;
        let (definition_id, content_hash, published_at, carries_from): (
            String,
            String,
            i64,
            Option<String>,
        ) = (r.get(0), r.get(1), r.get(2), r.get(3));
        let cached = self.parsed.versions.lock().unwrap().get(id).cloned();
        if let Some(version) = cached.filter(|v| {
            v.definition_id == definition_id
                && v.content_hash == content_hash
                && v.published_at == published_at
                && v.carries_from == carries_from
        }) {
            return Ok(version);
        }
        let manifest: String =
            sqlx::query_scalar("SELECT manifest_json FROM benchmark_versions WHERE id=?")
                .bind(id)
                .fetch_one(&self.pool)
                .await?;
        let version = Arc::new(BenchmarkVersion {
            id: id.into(),
            definition_id,
            content_hash,
            manifest: serde_json::from_str(&manifest)?,
            published_at,
            carries_from,
        });
        self.parsed
            .versions
            .lock()
            .unwrap()
            .insert(id.into(), version.clone());
        Ok(version)
    }
    /// The version that carries `id`'s cells now: the end of its chain of
    /// evaluator-only republications, or `id` itself.
    pub async fn carried_version(&self, id: &str) -> Result<BenchmarkVersion> {
        let mut current = id.to_owned();
        while let Some(next) = sqlx::query_scalar::<_, String>(
            "SELECT id FROM benchmark_versions WHERE carries_from=? ORDER BY published_at DESC LIMIT 1",
        )
        .bind(&current)
        .fetch_optional(&self.pool)
        .await?
        {
            current = next;
        }
        self.version(&current).await
    }
    pub async fn run(&self, id: &str) -> Result<BenchmarkRun> {
        let r = sqlx::query(
            "SELECT state,revision,created_at,updated_at,request_json,baked_at,paused_ms,paused_since FROM run_plans WHERE id=?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| BenchmarkError::new("validation", "Run not found"))?;
        // Detailed output is loaded only through the evidence endpoint. Every
        // attempt is loaded: a full suite at three repetitions is over a
        // thousand, and a run missing some would plan, resume and bake wrong.
        let rows=sqlx::query_scalar::<_,String>("SELECT json_set(data_json,'$.output',NULL) FROM attempts WHERE run_id=? ORDER BY rowid").bind(id).fetch_all(&self.pool).await?;
        Ok(BenchmarkRun {
            id: id.into(),
            state: r.get(0),
            revision: r.get(1),
            created_at: r.get(2),
            updated_at: r.get(3),
            baked_at: r.get(5),
            paused_ms: r.get(6),
            paused_since: r.get(7),
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
            "WITH recent_runs AS MATERIALIZED (
                SELECT * FROM run_plans ORDER BY created_at DESC,id LIMIT 100
             ), recent_attempts AS MATERIALIZED (
                SELECT a.run_id,a.configuration_id,a.version_id,a.phase,a.rowid,
                    json_extract(a.data_json,'$.outcome') AS outcome,
                    json_extract(a.data_json,'$.reason') AS reason,
                    json_extract(a.data_json,'$.observed.effort') AS observed_effort,
                    json_extract(a.data_json,'$.observed.fastMode') AS observed_fast,
                    json_extract(a.data_json,'$.observed.modelId') AS observed_model,
                    json_extract(a.data_json,'$.configuration.modelId') AS configured_model,
                    json_extract(a.data_json,'$.finishedAt') AS finished_at,
                    EXISTS(SELECT 1 FROM json_each(a.data_json,'$.evaluations') e
                        WHERE e.type='object' AND json_extract(e.value,'$.provenance')='human'
                            AND json_extract(e.value,'$.score') IS NOT NULL) AS has_human_score,
                    CASE WHEN a.phase='terminal' AND json_extract(a.data_json,'$.outcome')='pending_review'
                        THEN json_extract(a.data_json,'$.evaluations') END AS pending_evaluations
                FROM attempts a JOIN recent_runs r ON r.id=a.run_id
             ) SELECT r.id,r.state,r.revision,r.created_at,r.updated_at,r.request_json,
                (SELECT COUNT(*) FROM recent_attempts a WHERE a.run_id=r.id
                    AND COALESCE(a.outcome,'')<>'superseded'),
                (SELECT COUNT(*) FROM recent_attempts a WHERE a.run_id=r.id AND a.phase='terminal'
                    AND COALESCE(a.outcome,'')<>'superseded'),
                CASE WHEN r.state NOT IN ('completed','cancelled','cancelling') THEN
                (SELECT json_group_array(json_array(o.configuration_id,
                        o.observed_effort,o.observed_fast))
                    FROM (SELECT a.configuration_id,a.observed_effort,a.observed_fast
                        FROM recent_attempts a WHERE a.run_id=r.id AND a.phase<>'pending'
                            AND a.observed_model=a.configured_model
                            AND COALESCE(a.outcome,'')<>'selection_changed'
                        ORDER BY a.phase,a.rowid) o)
                END,
                CASE WHEN r.state NOT IN ('completed','cancelled','cancelling') THEN
                (SELECT json_group_array(json_array(o.configuration_id,o.version_id,o.running))
                    FROM (SELECT a.configuration_id,a.version_id,MAX(a.phase<>'pending') AS running FROM recent_attempts a
                        WHERE a.run_id=r.id AND a.phase<>'terminal'
                        GROUP BY a.configuration_id,a.version_id ORDER BY MIN(a.rowid)) o)
                END,
                CASE WHEN r.state IN ('running','pausing','needs_attention','completed') THEN
                (SELECT json_array(a.outcome,a.reason)
                    FROM recent_attempts a WHERE a.run_id=r.id
                        AND COALESCE(a.reason,'')<>''
                        AND ((a.phase='terminal' AND a.outcome='pending_review'
                            AND a.has_human_score=0)
                        OR (r.state='needs_attention' AND COALESCE(a.outcome,'') NOT IN
                            ('pass','fail','judged','pending_review','completed','budget_reached','budget_timeout',
                             'excluded','selection_changed','unsupported','cancelled','superseded')))
                    ORDER BY (a.phase='pending') DESC,
                        (a.reason LIKE 'No judge panel:%') DESC,
                        COALESCE(a.finished_at,0) DESC, a.rowid DESC
                    LIMIT 1)
                END,
                r.baked_at,
                CASE WHEN json_extract(r.request_json,'$.workflowPolicy') IS NOT NULL
                    AND (SELECT COUNT(*) FROM recent_attempts a WHERE a.run_id=r.id
                        AND COALESCE(a.outcome,'')<>'superseded')=1
                THEN (SELECT json_object('outcome',a.outcome,
                        'reason',a.reason)
                    FROM recent_attempts a WHERE a.run_id=r.id AND a.phase='terminal'
                        AND a.outcome IS NOT NULL
                        AND a.outcome<>'superseded')
                END,
                r.paused_ms,r.paused_since,
                (SELECT COUNT(*) FROM (SELECT 1 FROM recent_attempts a WHERE a.run_id=r.id
                    AND COALESCE(a.outcome,'')<>'superseded'
                    GROUP BY a.configuration_id,a.version_id)),
                (SELECT json_group_array(json_array(a.configuration_id,a.version_id,a.phase,a.outcome,
                    json(a.pending_evaluations))) FROM recent_attempts a WHERE a.run_id=r.id
                    AND COALESCE(a.outcome,'')<>'superseded'
                )
             FROM recent_runs r ORDER BY r.created_at DESC,r.id LIMIT 100",
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
                    baked_at: r.get(11),
                    paused_ms: r.get(13),
                    paused_since: r.get(14),
                    request: serde_json::from_str(r.get(5))?,
                    attempt_count: r.get::<i64, _>(6) as u64,
                    settled_count: r.get::<i64, _>(7) as u64,
                    cell_count: r.get::<i64, _>(15) as u64,
                    settled_cell_count: settled_cells(r.get(16))?,
                    observed_selections: observed_selections(r.get(8)),
                    open_cells: open_cells(r.get(9)),
                    attention: run_attention(r.get(10)),
                    workflow_result: r
                        .get::<Option<String>, _>(12)
                        .and_then(|raw| serde_json::from_str(&raw).ok()),
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
                    super::model_catalog::attempt_cost(
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
                    outcome: super::analysis::outcome_as_of(
                        outcome,
                        finished_at,
                        &evaluations,
                        q.as_of,
                    ),
                    score: super::analysis::score_of(outcome, finished_at, &evaluations, q.as_of),
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
    /// A rendering from the newest complete cell per creative brief and
    /// configuration. Repetitions must belong to the same run and request.
    pub async fn list_designs(&self, q: &ResultQuery) -> Result<Vec<DesignEntry>> {
        let catalog = self.catalog_entries().await?;
        let versions = q
            .version_ids
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let rows = sqlx::query(
            "SELECT a.data_json,v.manifest_json,r.created_at,
                    json_extract(r.request_json,'$.repetitions')
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
        // A rendering of an unknown effort is no entry (see `effort`). An
        // attempt without an acknowledgment is judged by what its run's
        // attempts of the same request were acknowledged at.
        let mut defaulted = super::effort::DefaultedRequests::default();
        for row in sqlx::query(
            "SELECT run_id,json_extract(data_json,'$.configuration') FROM attempts
             WHERE json_extract(data_json,'$.observed.effort')=?",
        )
        .bind(super::effort::CLI_DEFAULT_EFFORT)
        .fetch_all(&self.pool)
        .await?
        {
            let requested: Configuration = serde_json::from_str(&row.get::<String, _>(1))?;
            defaulted.add(&row.get::<String, _>(0), &requested);
        }
        // One card per brief and model as the leaderboard counts it: runtime
        // revisions and defaulted controls do not split a model. Rows come newest
        // first. Only complete scored cells can supply a card; a failed
        // triple remains a result, while a single rendering is no measurement.
        let mut candidates: Vec<(Attempt, BenchmarkDraft, i64, u32)> = Vec::new();
        let mut repetitions = std::collections::BTreeMap::<_, std::collections::BTreeSet<_>>::new();
        let mut cards: std::collections::BTreeMap<(String, String), (u8, usize)> =
            std::collections::BTreeMap::new();
        for row in rows {
            let mut attempt: Attempt = serde_json::from_str(&row.get::<String, _>(0))?;
            // A candidate that authored the brief is not an entry of it.
            if attempt.outcome.as_deref() == Some("excluded")
                || super::analysis::is_superseded(&attempt)
                || super::effort::effort_unknown(&attempt, &defaulted)
            {
                continue;
            }
            let manifest: BenchmarkDraft = serde_json::from_str(&row.get::<String, _>(1))?;
            // The gallery compares quality, so a rendering of a brief its
            // candidate wrote stays out of it, as on every quality board.
            if super::routing::authored_by_candidate(&manifest, &attempt.configuration) {
                continue;
            }
            // A rendering its event record stopped is unscored, as on every
            // board (see `evidence`).
            super::evidence::rendering_with_answer_cap(
                &mut attempt,
                manifest.limits.max_artifact_bytes,
            );
            if attempt.phase != "terminal"
                || super::analysis::score_as_of(&attempt, q.as_of).is_none()
            {
                continue;
            }
            let required = super::analysis::REQUIRED_REPETITIONS
                .max(manifest.repetitions)
                .max(row.get::<i64, _>(3) as u32);
            repetitions
                .entry((
                    attempt.run_id.clone(),
                    attempt.version_id.clone(),
                    attempt.configuration.id.clone(),
                ))
                .or_default()
                .insert(attempt.repetition);
            candidates.push((attempt, manifest, row.get(2), required));
        }
        // The card each candidate of a complete cell belongs to.
        let mut keys: Vec<Option<(String, String)>> = Vec::with_capacity(candidates.len());
        for (index, (attempt, _, _, required)) in candidates.iter().enumerate() {
            if repetitions[&(
                attempt.run_id.clone(),
                attempt.version_id.clone(),
                attempt.configuration.id.clone(),
            )]
                .len()
                < *required as usize
            {
                keys.push(None);
                continue;
            }
            let key = (
                attempt.version_id.clone(),
                super::analysis::leaderboard_key(&card_configuration(attempt)),
            );
            keys.push(Some(key.clone()));
            let tier = card_tier(attempt);
            let card = cards.entry(key).or_insert((tier, index));
            if tier > card.0 && candidates[card.1].0.run_id == attempt.run_id {
                *card = (tier, index);
            }
        }
        let mut chosen: Vec<usize> = cards.into_values().map(|(_, index)| index).collect();
        chosen.sort_unstable();
        let mut out = Vec::new();
        for index in chosen {
            let (attempt, manifest, run_created_at, required) = &candidates[index];
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
            // Every scored rendering of the card's brief and model, each with
            // the image its own panel scored.
            let mut points: Vec<DesignPoint> = candidates
                .iter()
                .zip(&keys)
                .filter(|(_, key)| key.is_some() && **key == keys[index])
                .map(|((point, _, _, _), _)| {
                    let batch = &point.evaluations[scoring_batch(&point.evaluations)];
                    DesignPoint {
                        attempt_id: point.id.clone(),
                        run_id: point.run_id.clone(),
                        repetition: point.repetition,
                        finished_at: point.finished_at,
                        duration_ms: point.duration_ms,
                        cost: super::model_catalog::attempt_cost(
                            &catalog,
                            &point.configuration,
                            &point.usage,
                            point.finished_at.or(point.started_at),
                        ),
                        score: super::analysis::score(point),
                        judges: batch
                            .iter()
                            .filter(|e| e.provenance == "judge" && e.score.is_some())
                            .count() as u32,
                        rendering: batch_rendering(batch),
                    }
                })
                .collect();
            points.sort_by(|a, b| {
                b.finished_at
                    .cmp(&a.finished_at)
                    .then(a.repetition.cmp(&b.repetition))
            });
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
                cost: super::model_catalog::attempt_cost(
                    &catalog,
                    &attempt.configuration,
                    &attempt.usage,
                    attempt.finished_at.or(attempt.started_at),
                ),
                review,
                judges,
                score,
                required_repetitions: *required,
                completed_repetitions: repetitions[&(
                    attempt.run_id.clone(),
                    attempt.version_id.clone(),
                    attempt.configuration.id.clone(),
                )]
                    .len() as u32,
                rendering: batch_rendering(
                    &attempt.evaluations[scoring_batch(&attempt.evaluations)],
                ),
                points,
            });
        }
        Ok(out)
    }
    /// Runs the dispatcher acts on: running, pausing or cancelling, oldest
    /// first. Paused runs and runs that need attention wait for the operator
    /// and are not loaded.
    pub async fn active_runs(&self) -> Result<Vec<BenchmarkRun>> {
        let ids=sqlx::query_scalar::<_,String>("SELECT id FROM run_plans WHERE state IN ('running','pausing','cancelling') ORDER BY created_at,rowid").fetch_all(&self.pool).await?;
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
        super::workflow_campaign::check_reserved_versions(
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
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE attempts SET phase=?,data_json=json_set(data_json,'$.phase',?,'$.outcome',?,'$.reason',?,'$.finishedAt',?),repetition=-rowid WHERE id=?")
            .bind(&attempt.phase)
            .bind(&attempt.phase)
            .bind(&attempt.outcome)
            .bind(&attempt.reason)
            .bind(attempt.finished_at)
            .bind(&attempt.id)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, &attempt.run_id, "run_changed").await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn save_attempt(&self, attempt: &Attempt) -> Result<()> {
        // Timing belongs to the stored attempt, not a possibly stale flight copy.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let previous: Option<String> = sqlx::query_scalar(
            "SELECT json_extract(data_json,'$.activity') FROM attempts WHERE id=? UNION ALL SELECT json_extract(data_json,'$.activity') FROM workflow_steps WHERE attempt_id=? LIMIT 1"
        ).bind(&attempt.id).bind(&attempt.id).fetch_optional(&mut *tx).await?.flatten();
        let mut attempt = attempt.clone();
        attempt.activity = previous
            .map(|value| serde_json::from_str(&value))
            .transpose()?;
        let state: String = sqlx::query_scalar("SELECT state FROM run_plans WHERE id=?")
            .bind(&attempt.run_id)
            .fetch_one(&mut *tx)
            .await?;
        let kind = super::activity::kind(&attempt, &state);
        super::activity::record(&mut attempt.activity, kind, now());
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
    /// The ids of runs whose window, time spent paused left out, closed at
    /// or before `cutoff` (a paused run's window waits) and whose
    /// cells are not final yet, oldest first, leaving out the runs a workflow
    /// campaign owns. Only ids: the caller loads a run once it may bake it.
    pub async fn unbaked_run_ids(&self, cutoff: i64) -> Result<Vec<String>> {
        Ok(sqlx::query_scalar::<_, String>(
            "SELECT id FROM run_plans p WHERE baked_at IS NULL AND paused_since IS NULL AND created_at+paused_ms<=? AND NOT EXISTS(SELECT 1 FROM workflow_campaign_cells c WHERE c.request_key=p.request_key) ORDER BY created_at,id",
        )
        .bind(cutoff)
        .fetch_all(&self.pool)
        .await?)
    }
    /// Replaces a run's request: how a run inside its window grows by the
    /// cases added to it.
    pub async fn set_run_request(&self, id: &str, request: &RunRequest) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE run_plans SET request_json=?,revision=revision+1 WHERE id=?")
            .bind(serde_json::to_string(request)?)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, id, "run_changed").await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn set_run_state(&self, id: &str, state: &str) -> Result<()> {
        self.set_run_state_at(id, state, now()).await
    }
    /// Moves a run to `state` as of `at`: how a run baked after its window
    /// closed is completed at the time its last cell settled.
    pub async fn set_run_state_at(&self, id: &str, state: &str, at: i64) -> Result<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        // A turn that fails while the owner stops the run never takes the
        // stop back: needs_attention leaves a cancelling or cancelled run be.
        // Nor does a tick that read the run before the stop and then found
        // nothing of it flying: completed leaves it be, and the stop ends it.
        // A pause's time is kept apart, so the run's window leaves it out.
        sqlx::query("UPDATE run_plans SET state=?1,revision=revision+1,updated_at=?2,paused_ms=paused_ms+CASE WHEN paused_since IS NOT NULL AND ?1<>'paused' THEN MAX(0,?2-paused_since) ELSE 0 END,paused_since=CASE WHEN ?1='paused' THEN COALESCE(paused_since,?2) ELSE NULL END WHERE id=?3 AND NOT (?1 IN ('needs_attention','completed') AND state IN ('cancelling','cancelled'))")
            .bind(state)
            .bind(at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let effective: String = sqlx::query_scalar("SELECT state FROM run_plans WHERE id=?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let rows = sqlx::query("SELECT id,phase,json_extract(data_json,'$.activity') FROM attempts WHERE run_id=? AND phase<>'terminal'")
            .bind(id).fetch_all(&mut *tx).await?;
        for row in rows {
            let mut activity: Option<AttemptActivity> = row
                .get::<Option<String>, _>(2)
                .map(|value| serde_json::from_str(&value))
                .transpose()?;
            if effective == "running"
                && activity.as_ref().is_some_and(|history| {
                    history
                        .spans
                        .last()
                        .is_some_and(|span| span.finished_at.is_none())
                })
            {
                continue;
            }
            let kind = match effective.as_str() {
                "running" if matches!(row.get::<&str, _>(1), "pending" | "awaiting_judges") => {
                    Some(ActivityKind::Waiting)
                }
                "running" | "pausing" | "cancelling" => continue,
                _ => None,
            };
            super::activity::record(&mut activity, kind, at);
            sqlx::query(
                "UPDATE attempts SET data_json=json_set(data_json,'$.activity',json(?)) WHERE id=?",
            )
            .bind(serde_json::to_string(&activity)?)
            .bind(row.get::<&str, _>(0))
            .execute(&mut *tx)
            .await?;
        }
        event(&mut tx, id, "run_changed").await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn recover(&self) -> Result<()> {
        // Do not turn application downtime into work or queue time.
        let last_beat = self.last_beat().await?;
        let rows = sqlx::query("SELECT id,json_extract(data_json,'$.activity') FROM attempts WHERE phase<>'terminal' AND json_type(data_json,'$.activity')='object'")
            .fetch_all(&self.pool).await?;
        for row in rows {
            let mut activity: Option<AttemptActivity> =
                serde_json::from_str(row.get::<&str, _>(1))?;
            let stopped_at = last_beat.unwrap_or_else(|| {
                if let Some(history) = &mut activity {
                    history.complete = false;
                    history
                        .spans
                        .last()
                        .map_or(history.recorded_from, |span| span.started_at)
                } else {
                    now()
                }
            });
            super::activity::record(&mut activity, None, stopped_at);
            sqlx::query(
                "UPDATE attempts SET data_json=json_set(data_json,'$.activity',json(?)) WHERE id=?",
            )
            .bind(serde_json::to_string(&activity)?)
            .bind(row.get::<&str, _>(0))
            .execute(&self.pool)
            .await?;
        }
        self.park_workflow_campaigns().await?;
        self.recover_qualifications().await?;
        // Never retry an attempt that may have crossed the host acceptance boundary.
        // A rendering awaiting its panel has a sealed generation; its run asks the
        // panel after resume, and reconciliation settles any judge turn cut off.
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT data_json FROM attempts WHERE phase NOT IN ('pending','terminal','awaiting_judges')",
        )
        .fetch_all(&self.pool)
        .await?;
        // A workflow root the stop cut off mid-trajectory gets the downtime
        // back from when the service was last alive.
        let alive = self.last_beat().await?;
        for data in rows {
            let mut a: Attempt = serde_json::from_str(&data)?;
            if let Some(from) = alive {
                if a.configuration.execution_profile != "workflow_policy" {
                    self.open_root_credit(&a.id, &a.run_id, from, "stranded")
                        .await?;
                }
            }
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
        // A stop the restart cut short stays a stop: the runner closes it
        // once nothing of the run flies, as it would have before.
        sqlx::query("UPDATE run_plans SET state='needs_attention',revision=revision+1 WHERE state IN ('running','pausing')").execute(&self.pool).await?;
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
    /// Every catalog entry, newest effective date first. Each vendor seed set
    /// is added once, together with the record that it was, so a set shipped
    /// later reaches an existing catalog and a seed the user deleted never
    /// comes back.
    pub async fn catalog_entries(&self) -> Result<Vec<CatalogEntry>> {
        let seeded: Vec<String> = sqlx::query_scalar("SELECT id FROM catalog_seed_sets")
            .fetch_all(&self.pool)
            .await?;
        for (set, entries) in super::model_catalog::seed_sets() {
            if seeded.iter().any(|id| id == set) {
                continue;
            }
            let mut tx = self.pool.begin().await?;
            let recorded = sqlx::query(
                "INSERT INTO catalog_seed_sets(id,seeded_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING",
            )
            .bind(set)
            .bind(now())
            .execute(&mut *tx)
            .await?
            .rows_affected();
            // Another caller seeded it meanwhile.
            if recorded == 0 {
                continue;
            }
            for entry in entries {
                sqlx::query("INSERT INTO catalog_entries(id,kind,effective_from,created_at,data_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
                    .bind(&entry.id)
                    .bind(&entry.kind)
                    .bind(entry.effective_from)
                    .bind(entry.created_at)
                    .bind(serde_json::to_string(&entry)?)
                    .execute(&mut *tx)
                    .await?;
            }
            tx.commit().await?;
        }
        self.json_rows(
            "SELECT data_json FROM catalog_entries ORDER BY effective_from DESC, created_at DESC",
        )
        .await
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
    /// Every pool release, oldest first.
    pub async fn releases(&self) -> Result<Vec<PoolRelease>> {
        self.json_rows("SELECT data_json FROM pool_releases ORDER BY created_at, rowid")
            .await
    }
    /// Every family and split group an evaluation reserves, as (kind, value),
    /// whoever owns it. Suites no longer read reservations; tests use this to
    /// prove a retired holdout's rows block nothing.
    #[cfg(test)]
    pub async fn evaluation_reservations(&self) -> Result<Vec<(String, String)>> {
        // Reservations of the retired executor holdout are history: they
        // never hold a case back from a suite, lane or run.
        sqlx::query("SELECT DISTINCT kind, value FROM evaluation_reservations WHERE owner_kind<>'executor_holdout'")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|row| Ok((row.try_get("kind")?, row.try_get("value")?)))
            .collect()
    }
    pub async fn save_release(&self, release: &PoolRelease) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO pool_releases(id,name,created_at,data_json) VALUES(?,?,?,?)")
            .bind(&release.id)
            .bind(&release.name)
            .bind(release.created_at)
            .bind(serde_json::to_string(release)?)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, &release.id, "release_created").await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn schedules(&self) -> Result<Vec<Schedule>> {
        self.json_rows("SELECT data_json FROM schedules ORDER BY rowid DESC")
            .await
    }
    pub async fn usage_samples(&self) -> Result<Vec<UsageSample>> {
        // Quota samples of the retired Usage Bench, kept as data and read
        // only by the export, in bounded batches.
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

/// The cells a run still has work on, from distinct rows of
/// `[configuration id, version id, 1 while an attempt of it runs]`.
/// The attempt that parked a run, as the summary query lists it.
fn run_attention(raw: Option<String>) -> Option<RunAttention> {
    let value: serde_json::Value = serde_json::from_str(raw.as_deref()?).ok()?;
    let pair = value.as_array()?;
    let reason = pair.get(1)?.as_str()?.to_owned();
    Some(RunAttention {
        outcome: pair.first().and_then(|v| v.as_str()).map(str::to_owned),
        reason,
    })
}

fn open_cells(rows: Option<&str>) -> Vec<OpenRunCell> {
    rows.and_then(|rows| serde_json::from_str::<Vec<(String, String, i64)>>(rows).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|(configuration_id, version_id, running)| OpenRunCell {
            configuration_id,
            version_id,
            running: running != 0,
        })
        .collect()
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

/// The image a judge batch scored: its render marker's screenshot.
fn batch_rendering(batch: &[Evaluation]) -> Option<String> {
    batch
        .first()
        .filter(|e| e.provenance == "render")?
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == "screenshot")
        .map(|artifact| artifact.path.clone())
}

/// How well an attempt can stand for its card: a scored rendering, a rendering,
/// a settled attempt, anything else. A rendering awaiting its panel has a
/// sealed generation and stands like a settled one.
fn card_tier(attempt: &Attempt) -> u8 {
    if !matches!(
        attempt.phase.as_str(),
        "terminal" | super::runner::AWAITING_JUDGES
    ) {
        return 0;
    }
    let rendering = attempt
        .output
        .as_deref()
        .is_some_and(|o| !o.trim().is_empty())
        && !matches!(
            attempt.outcome.as_deref(),
            Some(
                "cancelled"
                    | "selection_changed"
                    | "execution_violation"
                    | "interrupted"
                    | "dispatch_uncertain"
            )
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
    async fn activity_survives_stale_flight_saves_retries_and_pause_resume() {
        let dir = crate::test_support::TempRoot::new();
        let store = Store::open(dir.path()).await.unwrap();
        dir.register(&store.pool);
        let definition = store
            .save_draft(None, None, super::super::seeds::definitions().remove(0))
            .await
            .unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let config = json!({"id":"c","providerId":"provider","accountId":"account","modelId":"native","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let request = json!({"requestKey":"clock","versionIds":[version.id],"configurations":[config],"repetitions":1,"timeoutSeconds":30,"maxExecutions":3});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('clock','clock','running',1,0,0,?)")
            .bind(request.to_string()).execute(&store.pool).await.unwrap();
        let mut attempt = super::super::pending_attempt(
            "clock",
            &version.id,
            &serde_json::from_value(config).unwrap(),
            0,
        );
        store.insert_attempt(&attempt).await.unwrap();
        let original_wait = attempt.activity.as_ref().unwrap().spans[0].started_at;
        attempt.phase = "running".into();
        attempt.started_at = Some(now());
        store.save_attempt(&attempt).await.unwrap();
        // The flight does not reload timing on every phase transition.
        attempt.activity = None;
        attempt.phase = "awaiting_judges".into();
        attempt.output = Some("Retained example answer".into());
        attempt.reason = Some("Waiting for local resources: preparation capacity".into());
        store.save_attempt(&attempt).await.unwrap();
        store.save_attempt(&attempt).await.unwrap();
        let saved = store.attempt(&attempt.id).await.unwrap();
        let spans = &saved.activity.as_ref().unwrap().spans;
        assert_eq!(spans.len(), 3);
        assert_eq!(spans[0].started_at, original_wait);
        assert_eq!(spans[1].kind, ActivityKind::Execution);
        assert_eq!(spans[2].kind, ActivityKind::Waiting);
        assert!(spans[2].finished_at.is_none());
        let paused_at = now();
        store
            .set_run_state_at("clock", "paused", paused_at)
            .await
            .unwrap();
        let paused = store.attempt(&attempt.id).await.unwrap();
        assert_eq!(
            paused.activity.unwrap().spans.last().unwrap().finished_at,
            Some(paused_at)
        );
        let resumed_at = paused_at + 7_200_000;
        store
            .set_run_state_at("clock", "running", resumed_at)
            .await
            .unwrap();
        let resumed = store.attempt(&attempt.id).await.unwrap();
        let spans = &resumed.activity.as_ref().unwrap().spans;
        assert_eq!(spans.len(), 4);
        assert_eq!(spans.last().unwrap().started_at, resumed_at);
        assert_eq!(resumed.output.as_deref(), Some("Retained example answer"));
        dir.close().await;
    }

    /// Complete each fixture's protocol without changing which rendering is
    /// newest. Copies precede the original row in the gallery's ordering.
    async fn add_gallery_repetitions(store: &Store) {
        let rows = sqlx::query("SELECT data_json FROM attempts")
            .fetch_all(&store.pool)
            .await
            .unwrap();
        for row in rows {
            let original: Attempt = serde_json::from_str(row.get(0)).unwrap();
            for copy in 1..=2 {
                let mut attempt = original.clone();
                attempt.id = format!("{}-copy-{copy}", original.id);
                attempt.repetition = sqlx::query_scalar::<_, i64>("SELECT MAX(repetition)+1 FROM attempts WHERE run_id=? AND version_id=? AND configuration_id=?")
                    .bind(&attempt.run_id).bind(&attempt.version_id).bind(&attempt.configuration.id)
                    .fetch_one(&store.pool).await.unwrap() as u32;
                sqlx::query("INSERT INTO attempts(rowid,id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES((SELECT MIN(0,MIN(rowid))-1 FROM attempts),?,?,?,?,?,?,?)")
                    .bind(&attempt.id).bind(&attempt.run_id).bind(&attempt.version_id)
                    .bind(&attempt.configuration.id).bind(attempt.repetition)
                    .bind(&attempt.phase).bind(serde_json::to_string(&attempt).unwrap())
                    .execute(&store.pool).await.unwrap();
            }
        }
    }

    /// sqlx stores the checksum of every migration it applies and refuses to
    /// open a database whose applied migration no longer matches its file,
    /// comments included; every benchmark surface would then fail to open. A
    /// migration that has shipped is frozen; this says so at test time
    /// instead of at the operator's next launch. New migrations are appended
    /// here once they ship.
    #[test]
    fn a_shipped_migration_is_never_edited() {
        const SHIPPED: &[(i64, &str)] = &[
            (20260930000000, "9eeb1cf55d05eedf82f94eb8009fbcd480b0ddc74877111f1c91b30009c4cf147ec120098b50f1bedbc850c990c05d4c"),
            (20261001000000, "971a3d5b40baa96b542add5ac54841ed9592a59a58cdf79fc11c65db8f918fcce210966a05aa2e0a2fc8f9da47cacf02"),
            (20261002000000, "82d4743341e09aa8ef814312ac1ca61dd9b0db4de8d534357c04f0a1c3c642ba583e861e6fae6551804ec1761fc42fad"),
            (20261003000000, "31579022d9cc8b18e883bd695f77a4613a2e596d9726d201400a399b89ae9970132e38d19a5f027b19970c29e647883c"),
            (20261003000001, "168178b0ce15869346cc3d80450b00b6c7bd097ee87e168d8051410ed83cdad2f02bcd9d8627818302b4c1989d719ccd"),
            (20261004000000, "e962b9e07105c1df071a37c7c2d76913bc38a622bf4f37eda08fdaeb9c4ff097c1be29046eee9fd12832e2e74f921d8c"),
        ];
        let migrator = sqlx::migrate!("./migrations_benchmarks");
        for (version, checksum) in SHIPPED {
            let migration = migrator
                .iter()
                .find(|migration| migration.version == *version)
                .unwrap_or_else(|| panic!("shipped migration {version} is gone"));
            assert_eq!(
                hex::encode(&migration.checksum),
                *checksum,
                "migration {version} changed after it shipped; restore the file and add a new migration instead"
            );
        }
    }

    #[tokio::test]
    async fn the_design_gallery_keeps_the_newest_rendering_per_brief_and_configuration() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
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
            let attempt = json!({"id":format!("attempt-{run}"),"runId":run,"versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":"pending_review","output":format!("<svg data-run='{run}'/>"),"usage":{"schema":"native","output":120,"cost":0.05},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'candidate',0,'terminal',?)")
                .bind(format!("attempt-{run}")).bind(run).bind(&version.id).bind(attempt.to_string())
                .execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        // The preview run never shows; the newest real run wins and carries its review.
        add_gallery_repetitions(&store).await;
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
        // Each scored repetition of the measurement is a point of its own.
        let points = &entries[0].points;
        assert_eq!(points.len(), 3);
        assert!(points.iter().all(|point| point.run_id == "run-2"));
        assert!(points
            .iter()
            .any(|point| point.attempt_id == "attempt-run-2"));
        let mut repetitions: Vec<u32> = points.iter().map(|point| point.repetition).collect();
        repetitions.sort_unstable();
        assert_eq!(repetitions, vec![0, 1, 2]);
        assert!(points.iter().all(|point| point.score == Some(0.7)));
        assert_eq!(entries[0].rendering, None);
        // A run whose rendering is not reviewed is not a completed result.
        let older = store
            .list_designs(&ResultQuery {
                run_id: Some("run-1".into()),
                ..ResultQuery::default()
            })
            .await
            .unwrap();
        assert!(older.is_empty());
        let none = store
            .list_designs(&ResultQuery {
                version_ids: Some(vec![]),
                ..ResultQuery::default()
            })
            .await
            .unwrap();
        assert!(none.is_empty());
        directory.close().await;
    }
    #[test]
    fn a_design_shows_the_image_its_scoring_batch_rendered() {
        let evaluations: Vec<Evaluation> = serde_json::from_value(json!([
            {"id":"r1","evaluatorRevision":"1","verdict":"rendered","score":null,"reason":"","createdAt":1,"provenance":"render","artifacts":[{"kind":"screenshot","path":"old.png","hash":"a","label":"Rendering"}],"details":{"expectedJudges":1}},
            {"id":"j1","evaluatorRevision":"1","verdict":"judged","score":0.4,"reason":"","createdAt":2,"provenance":"judge","artifacts":[]},
            {"id":"r2","evaluatorRevision":"1","verdict":"rendered","score":null,"reason":"","createdAt":3,"provenance":"render","artifacts":[{"kind":"screenshot","path":"new.png","hash":"b","label":"Rendering"}],"details":{"expectedJudges":1}},
            {"id":"j2","evaluatorRevision":"1","verdict":"judged","score":0.9,"reason":"","createdAt":4,"provenance":"judge","artifacts":[]},
            {"id":"r3","evaluatorRevision":"1","verdict":"rendered","score":null,"reason":"","createdAt":5,"provenance":"render","artifacts":[{"kind":"screenshot","path":"unsettled.png","hash":"c","label":"Rendering"}],"details":{"expectedJudges":2}}
        ]))
        .unwrap();
        // The newest settled batch scores the attempt, so its image is shown.
        assert_eq!(
            batch_rendering(&evaluations[scoring_batch(&evaluations)]).as_deref(),
            Some("new.png")
        );
        assert_eq!(batch_rendering(&evaluations[1..2]), None);
        assert_eq!(batch_rendering(&[]), None);
    }
    /// A rendering the old runner stopped for the size of its event record
    /// scored a fixed 0 and, being the newest scored one, took the card. Read
    /// as unscored, it leaves the card to the older scored rendering, and its
    /// own run has no completed gallery result.
    #[tokio::test]
    async fn a_rendering_stopped_by_its_event_record_is_unscored_in_the_gallery() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let draft = super::super::seeds::definitions()
            .into_iter()
            .find(|d| d.work_class_id == "creative")
            .unwrap();
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let configuration = json!({"id":"candidate","providerId":"provider","accountId":null,"modelId":"native-model","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let reviewed = json!([{"id":"objective","evaluatorRevision":"1","verdict":"pending_review","score":null,"reason":"waiting","createdAt":5,"provenance":"objective","artifacts":[]},{"id":"review","evaluatorRevision":"1","verdict":"fail","score":0.7,"reason":"ok","createdAt":6,"provenance":"human","artifacts":[]}]);
        let mut tx = store.pool.begin().await.unwrap();
        for (run, created_at) in [("run-1", 1), ("run-2", 2)] {
            let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[configuration],"repetitions":1,"timeoutSeconds":600,"maxExecutions":1,"preview":false});
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,?,?,?)")
                .bind(run).bind(run).bind(created_at).bind(created_at).bind(request.to_string())
                .execute(&mut *tx).await.unwrap();
            let mut attempt = json!({"id":format!("attempt-{run}"),"runId":run,"versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":"pending_review","output":format!("<svg data-run='{run}'/>"),"usage":{"schema":"native"},"evaluations":reviewed,"eventCursor":0,"workflowSteps":[]});
            if run == "run-2" {
                attempt["outcome"] = json!("budget_reached");
                attempt["reason"] = json!(super::super::evidence::LEGACY_CAP_REASON);
                attempt["evaluations"] = json!([]);
            }
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'candidate',0,'terminal',?)")
                .bind(format!("attempt-{run}")).bind(run).bind(&version.id).bind(attempt.to_string())
                .execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        add_gallery_repetitions(&store).await;
        let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].attempt_id, "attempt-run-1");
        assert_eq!(entries[0].score, Some(0.7));
        let stopped = store
            .list_designs(&ResultQuery {
                run_id: Some("run-2".into()),
                ..ResultQuery::default()
            })
            .await
            .unwrap();
        assert!(stopped.is_empty());
        // The store keeps what it settled with, for run detail.
        assert_eq!(
            store
                .attempt("attempt-run-2")
                .await
                .unwrap()
                .outcome
                .as_deref(),
            Some("budget_reached")
        );
        directory.close().await;
    }
    #[tokio::test]
    async fn one_gallery_card_per_model_shows_its_scored_rendering_and_generation_cost() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let draft = super::super::seeds::definitions()
            .into_iter()
            .find(|d| d.work_class_id == "creative")
            .unwrap();
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let configuration = |revision: &str, fast: Option<bool>| json!({"id":"sonnet","providerId":"claude-acp","accountId":"account","modelId":"sonnet","effort":"high","fastMode":fast,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":revision});
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
                configuration("r1", Some(false)),
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
        add_gallery_repetitions(&store).await;
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
        directory.close().await;
    }
    #[tokio::test]
    async fn an_excluded_authored_cell_is_no_gallery_entry() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let mut draft = super::super::seeds::definitions()
            .into_iter()
            .find(|d| d.work_class_id == "creative")
            .unwrap();
        draft.environment["authoredBy"] =
            json!([{"providerId":"claude-acp","modelId":"claude-fable-5-1","effort":null}]);
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
        // An unreviewed rendering from an older run is not a complete cell.
        insert("run-1", 1, json!({"id":"rendering","runId":"run-1","versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":"pending_review","output":"<svg/>","finishedAt":1,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]})).await;
        let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
        assert!(entries.is_empty());
        directory.close().await;
    }
    #[tokio::test]
    async fn a_measured_rendering_of_its_own_brief_is_no_gallery_entry() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let mut draft = super::super::seeds::definitions()
            .into_iter()
            .find(|d| d.work_class_id == "creative")
            .unwrap();
        draft.environment["authoredBy"] =
            json!([{"providerId":"claude-acp","modelId":"writer","effort":null}]);
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let configuration = |model: &str| json!({"id":model,"providerId":"claude-acp","accountId":"account","modelId":model,"effort":null,"fastMode":false,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"r1"});
        let mut tx = store.pool.begin().await.unwrap();
        let request = json!({"requestKey":"run-1","versionIds":[version.id],"configurations":[],"repetitions":1,"timeoutSeconds":600,"maxExecutions":2,"preview":false,"authorPolicy":"author-cells-measured-v1"});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run-1','run-1','completed',1,0,0,?)")
            .bind(request.to_string())
            .execute(&mut *tx).await.unwrap();
        for model in ["writer", "reader"] {
            let attempt = json!({"id":model,"runId":"run-1","versionId":version.id,"configuration":configuration(model),"observed":configuration(model),"repetition":0,"phase":"terminal","outcome":"pass","output":format!("<svg data-id='{model}'/>"),"finishedAt":1,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run-1',?,?,0,'terminal',?)")
                .bind(model).bind(&version.id).bind(model).bind(attempt.to_string())
                .execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        add_gallery_repetitions(&store).await;
        let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|e| e.attempt_id.as_str())
                .collect::<Vec<_>>(),
            ["reader"]
        );
        directory.close().await;
    }
    #[tokio::test]
    async fn a_rendering_of_an_unknown_effort_is_no_gallery_entry() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let draft = super::super::seeds::definitions()
            .into_iter()
            .find(|d| d.work_class_id == "creative")
            .unwrap();
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let configuration = |model: &str, effort: Option<&str>| json!({"id":model,"providerId":"claude-acp","accountId":"account","modelId":model,"effort":effort,"fastMode":false,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"r1"});
        let acknowledged = |model: &str, effort: Option<&str>| Some(configuration(model, effort));
        // Sonnet asked for the CLI's default. Opus left the effort unset: one
        // attempt was acknowledged at the default, and another of the same
        // request in that run never was. Haiku has no effort control.
        let attempts = [
            (
                "sonnet",
                "run-1",
                configuration("sonnet", Some("default")),
                acknowledged("sonnet", Some("default")),
            ),
            (
                "opus-2",
                "run-2",
                configuration("opus", None),
                acknowledged("opus", Some("default")),
            ),
            ("opus-3", "run-2", configuration("opus", None), None),
            (
                "haiku",
                "run-3",
                configuration("haiku", None),
                acknowledged("haiku", None),
            ),
        ];
        let mut tx = store.pool.begin().await.unwrap();
        for run in ["run-1", "run-2", "run-3"] {
            let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[],"repetitions":1,"timeoutSeconds":600,"maxExecutions":1,"preview":false});
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,0,0,?)")
                .bind(run).bind(run).bind(request.to_string())
                .execute(&mut *tx).await.unwrap();
        }
        for (repetition, (id, run, requested, observed)) in attempts.into_iter().enumerate() {
            let attempt = json!({"id":id,"runId":run,"versionId":version.id,"configuration":requested,"observed":observed,"repetition":repetition,"phase":"terminal","outcome":"pass","output":format!("<svg data-id='{id}'/>"),"finishedAt":1,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,?,'terminal',?)")
                .bind(id).bind(run).bind(&version.id).bind(requested["id"].as_str().unwrap()).bind(repetition as i64).bind(attempt.to_string())
                .execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        add_gallery_repetitions(&store).await;
        let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|e| e.attempt_id.as_str())
                .collect::<Vec<_>>(),
            ["haiku"]
        );
        // The archive keeps every attempt for audit.
        for id in ["sonnet", "opus-2", "opus-3"] {
            assert!(store.attempt(id).await.is_ok());
        }
        directory.close().await;
    }
    #[tokio::test]
    async fn a_rendering_awaiting_its_panel_is_not_a_completed_gallery_result() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let draft = super::super::seeds::definitions()
            .into_iter()
            .find(|d| d.work_class_id == "creative")
            .unwrap();
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let configuration = json!({"id":"sonnet","providerId":"claude-acp","accountId":"account","modelId":"sonnet","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"r1"});
        let objective = json!([{"id":"objective","evaluatorRevision":"1","verdict":"pending_review","score":null,"reason":"waiting","createdAt":5,"provenance":"objective","artifacts":[]}]);
        // An older run was cancelled before its cell ran; a newer one holds a
        // rendering whose panel a pause deferred.
        for (run, created_at, state, phase, outcome, output, evaluations) in [
            (
                "run-1",
                1,
                "cancelled",
                "terminal",
                "cancelled",
                None,
                json!([]),
            ),
            (
                "run-2",
                2,
                "paused",
                "awaiting_judges",
                "pending_review",
                Some("<svg/>"),
                objective,
            ),
        ] {
            let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[configuration],"repetitions":1,"timeoutSeconds":600,"maxExecutions":4,"preview":false});
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,?,1,?,?,?)")
                .bind(run).bind(run).bind(state).bind(created_at).bind(created_at).bind(request.to_string())
                .execute(&store.pool).await.unwrap();
            let attempt = json!({"id":format!("attempt-{run}"),"runId":run,"versionId":version.id,"configuration":configuration,"repetition":0,"phase":phase,"outcome":outcome,"output":output,"finishedAt":created_at,"usage":{"schema":"native","cost":0.05},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'sonnet',0,?,?)")
                .bind(format!("attempt-{run}")).bind(run).bind(&version.id).bind(phase).bind(attempt.to_string())
                .execute(&store.pool).await.unwrap();
        }
        let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
        assert!(entries.is_empty());
        assert_eq!(
            store
                .attempt("attempt-run-2")
                .await
                .unwrap()
                .output
                .as_deref(),
            Some("<svg/>")
        );
        directory.close().await;
    }
    #[tokio::test]
    async fn the_gallery_requires_a_whole_cell_from_one_run_and_keeps_failed_triples() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let draft = super::super::seeds::definitions()
            .into_iter()
            .find(|d| d.work_class_id == "creative")
            .unwrap();
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        for (run, model, outcomes, required) in [
            ("one", "partial", vec!["pass"], 3),
            ("two", "partial", vec!["pass", "pass"], 3),
            ("retired", "retired", vec!["superseded"; 3], 3),
            ("refused", "refused", vec!["unsupported"; 3], 3),
            (
                "unreviewed",
                "unreviewed",
                vec!["pass", "pass", "pending_review"],
                3,
            ),
            ("mixed", "mixed", vec!["pass", "pass", "superseded"], 3),
            ("failed", "failed", vec!["fail"; 3], 3),
            ("complete", "complete", vec!["pass"; 3], 3),
            ("four", "four", vec!["pass"; 3], 4),
        ] {
            let configuration = json!({"id":model,"providerId":"provider","accountId":null,"modelId":model,"effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
            let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[configuration],"repetitions":required,"timeoutSeconds":600,"maxExecutions":4,"preview":false});
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,1,1,?)")
                .bind(run).bind(run).bind(request.to_string()).execute(&store.pool).await.unwrap();
            for (repetition, outcome) in outcomes.into_iter().enumerate() {
                let id = format!("{run}-{repetition}");
                let attempt = json!({"id":id,"runId":run,"versionId":version.id,"configuration":configuration,"repetition":repetition,"phase":"terminal","outcome":outcome,"output":"<svg/>","finishedAt":1,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
                sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,?,'terminal',?)")
                    .bind(id).bind(run).bind(&version.id).bind(model).bind(repetition as i64).bind(attempt.to_string())
                    .execute(&store.pool).await.unwrap();
            }
        }
        let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|e| e.configuration.model_id.as_str())
                .collect::<std::collections::BTreeSet<_>>(),
            ["complete", "failed"].into_iter().collect()
        );
        assert!(entries
            .iter()
            .all(|e| e.required_repetitions == 3 && e.completed_repetitions == 3));
        assert_eq!(
            entries
                .iter()
                .find(|e| e.configuration.model_id == "failed")
                .unwrap()
                .score,
            Some(0.0)
        );
        directory.close().await;
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
    /// A catalog from before October 5, 2026 carries the retired classes; the
    /// first open moves every case and draft, keeps version ids and their
    /// cells, and the second open leaves them alone.
    #[tokio::test]
    async fn legacy_work_classes_move_once_and_keep_their_versions() {
        let directory = crate::test_support::TempRoot::new();
        let mut draft = super::super::runner::seed_definitions().remove(0);
        draft.work_class_id = "coding-simple".into();
        draft.name = "Repair bounded clamp".into();
        draft.facets.difficulty = None;
        let mut planning = super::super::runner::seed_definitions().remove(1);
        planning.work_class_id = "planning".into();
        planning.facets.difficulty = Some("hard".into());
        {
            let store = Store::open(directory.path()).await.unwrap();
            directory.register(&store.pool);
            let json = |d: &BenchmarkDraft| serde_json::to_string(d).unwrap();
            for (id, d) in [("d1", &draft), ("d2", &planning)] {
                sqlx::query("INSERT INTO benchmark_definitions(id,draft_json,revision,archived) VALUES(?,?,1,0)")
                    .bind(id).bind(json(d)).execute(&store.pool).await.unwrap();
                sqlx::query("INSERT INTO benchmark_versions(id,definition_id,content_hash,manifest_json,published_at) VALUES(?,?,?,?,1)")
                    .bind(format!("{id}-v")).bind(id).bind(format!("old-{id}")).bind(json(d)).execute(&store.pool).await.unwrap();
            }
            // The marker the first open wrote applies to an empty catalog; drop
            // it to replay the move over these rows.
            sqlx::query("DELETE FROM catalog_seed_sets WHERE id='work-classes-2026-10-05'")
                .execute(&store.pool)
                .await
                .unwrap();
            store.pool.close().await;
        }
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let moved = store.version("d1-v").await.unwrap();
        assert_eq!(moved.manifest.work_class_id, "debug");
        assert_eq!(moved.manifest.facets.difficulty.as_deref(), Some("easy"));
        assert_ne!(moved.content_hash, "old-d1");
        assert!(directory
            .path()
            .join("versions")
            .join(&moved.content_hash)
            .is_dir());
        assert_eq!(
            store.definition("d1").await.unwrap().draft.work_class_id,
            "debug"
        );
        // A class still in force keeps its row and its declared difficulty.
        let kept = store.version("d2-v").await.unwrap();
        assert_eq!(kept.manifest.work_class_id, "planning");
        assert_eq!(kept.manifest.facets.difficulty.as_deref(), Some("hard"));
        assert_eq!(kept.content_hash, "old-d2");
        store.pool.close().await;
        let again = Store::open(directory.path()).await.unwrap();
        directory.register(&again.pool);
        assert_eq!(
            again.version("d1-v").await.unwrap().content_hash,
            moved.content_hash
        );
        directory.close().await;
    }
    #[test]
    fn a_run_summary_names_the_attempt_that_parked_it() {
        let parsed = run_attention(Some(
            r#"["dispatch_uncertain","Remote acceptance cannot be established after restart"]"#
                .into(),
        ))
        .unwrap();
        assert_eq!(parsed.outcome.as_deref(), Some("dispatch_uncertain"));
        assert!(parsed.reason.starts_with("Remote acceptance"));
        // A pending quota wait carries no outcome yet.
        let waiting = run_attention(Some(r#"[null,"the usage limit ran out"]"#.into())).unwrap();
        assert_eq!(waiting.outcome, None);
        assert_eq!(run_attention(None), None);
        assert_eq!(run_attention(Some("[]".into())), None);
    }
    #[tokio::test]
    async fn catalog_seed_sets_insert_new_vendors_once() {
        let directory = crate::test_support::TempRoot::new();
        // A catalog seeded before seed sets were recorded, whose user then
        // deleted one Anthropic seed.
        {
            let options = SqliteConnectOptions::new()
                .filename(directory.path().join("benchmarks.db"))
                .create_if_missing(true);
            let pool = SqlitePoolOptions::new()
                .connect_with(options)
                .await
                .unwrap();
            let mut migrator = sqlx::migrate!("./migrations_benchmarks");
            migrator.migrations = std::borrow::Cow::Owned(
                migrator
                    .migrations
                    .iter()
                    .filter(|migration| migration.version < 20261004000000)
                    .cloned()
                    .collect(),
            );
            migrator.run(&pool).await.unwrap();
            let store = Store {
                pool,
                root: directory.path().to_owned(),
                parsed: Arc::default(),
            };
            let (_, anthropic) = super::super::model_catalog::seed_sets().remove(0);
            for entry in anthropic.iter().skip(1) {
                store.save_catalog_entry(entry).await.unwrap();
            }
            store.pool.close().await;
        }
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let entries = store.catalog_entries().await.unwrap();
        assert!(!entries.iter().any(|e| e.id == "seed-anthropic-fable-5-1"));
        // Four kept Anthropic rows, fourteen vendor rows, two estimates, and
        // the two Sonnet rows of the dated context correction.
        assert_eq!(entries.len(), 4 + 14 + 2 + 2);
        assert!(entries
            .iter()
            .any(|e| e.id == "seed-anthropic-sonnet-5-2026-10-22"));
        assert!(entries.iter().any(|e| e.id == "seed-moonshot-k3"));
        assert!(entries
            .iter()
            .any(|e| e.id == "seed-estimate-kimi-k2-8-preview"));
        // A vendor seed the user deletes stays deleted.
        store
            .delete_catalog_entry("seed-xai-grok-4-5")
            .await
            .unwrap();
        let again = store.catalog_entries().await.unwrap();
        assert_eq!(again.len(), 21);
        assert!(!again.iter().any(|e| e.id == "seed-xai-grok-4-5"));
        // A new catalog gets every set.
        let fresh_directory = crate::test_support::TempRoot::new();
        let fresh = Store::open(fresh_directory.path()).await.unwrap();
        fresh_directory.register(&fresh.pool);
        assert_eq!(fresh.catalog_entries().await.unwrap().len(), 5 + 14 + 2 + 2);
        directory.close().await;
        fresh_directory.close().await;
    }
    #[test]
    fn a_policy_violation_never_stands_as_a_rendering() {
        let attempt = |outcome: &str| -> Attempt {
            serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v","configuration":{"id":"c","providerId":"claude-acp","accountId":"x","modelId":"m","billingMode":"subscription","executionProfile":"native_text"},"repetition":0,"phase":"terminal","outcome":outcome,"output":"<svg/>","usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]})).unwrap()
        };
        assert_eq!(card_tier(&attempt("pending_review")), 2);
        assert_eq!(card_tier(&attempt("execution_violation")), 1);
        assert_eq!(card_tier(&attempt("selection_changed")), 1);
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
        let dir = crate::test_support::TempRoot::new();
        let store = Store::open(dir.path()).await.unwrap();
        dir.register(&store.pool);
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
        dir.close().await;
    }
    #[tokio::test]
    async fn workflow_summary_keeps_the_sole_terminal_root_result_without_evidence() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let draft = super::super::seeds::definitions().remove(0);
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let configuration = json!({"id":"candidate","providerId":"provider","accountId":null,"modelId":"native-model","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let request = json!({
            "requestKey":"history", "versionIds":[version.id], "configurations":[configuration],
            "repetitions":1, "timeoutSeconds":30, "maxExecutions":1, "preview":false,
            "workflowPolicy":{"modelId":"fit","mode":"fixed","candidates":[configuration],
                "priorIds":["candidate"],"fixedCandidateId":"candidate","minQuality":0.5}
        });
        let cases = [
            (
                "timeout",
                "completed",
                Some("budget_timeout"),
                "terminal",
                1,
            ),
            (
                "infra",
                "completed",
                Some("infrastructure_failure"),
                "terminal",
                1,
            ),
            ("cancelled", "cancelled", Some("pass"), "terminal", 1),
            ("absent", "completed", Some("pass"), "terminal", 0),
            ("multiple", "completed", Some("pass"), "terminal", 2),
            ("pending", "running", None, "pending", 1),
            ("no-outcome", "completed", None, "terminal", 1),
            ("ordinary", "completed", Some("pass"), "terminal", 1),
            ("superseded", "completed", Some("pass"), "terminal", 2),
        ];
        for (run_id, state, outcome, phase, roots) in cases {
            let mut run_request = request.clone();
            if run_id == "ordinary" {
                run_request
                    .as_object_mut()
                    .unwrap()
                    .remove("workflowPolicy");
            }
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,?,1,1,1,?)")
                .bind(run_id).bind(run_id).bind(state).bind(run_request.to_string())
                .execute(&store.pool).await.unwrap();
            for index in 0..roots {
                let id = format!("{run_id}-{index}");
                let outcome = if run_id == "superseded" && index == 1 {
                    Some("superseded")
                } else {
                    outcome
                };
                let attempt = json!({
                    "outcome":outcome, "reason":"Recorded diagnostic",
                    "output":"private output must remain lazy", "evaluations":["private evaluation"],
                    "workflowSteps":["private step evidence"], "sessionId":"private session identity"
                });
                sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'candidate',?,?,?)")
                    .bind(id).bind(run_id).bind(&version.id).bind(index).bind(phase).bind(attempt.to_string())
                    .execute(&store.pool).await.unwrap();
            }
        }
        let summaries = store.runs().await.unwrap();
        assert_eq!(summaries.len(), cases.len());
        for (run_id, state, outcome, _, _) in cases {
            let summary = summaries.iter().find(|row| row.id == run_id).unwrap();
            assert_eq!(summary.state, state);
            let expected =
                matches!(run_id, "timeout" | "infra" | "cancelled" | "superseded").then(|| {
                    WorkflowRunResult {
                        outcome: outcome.unwrap().into(),
                        reason: Some("Recorded diagnostic".into()),
                    }
                });
            assert_eq!(summary.workflow_result, expected, "{run_id}");
            assert!(summary.attention.is_none(), "{run_id}");
        }
        let serialized = serde_json::to_value(&summaries).unwrap();
        assert!(!serialized.to_string().contains("private "));
        let mut old_summary = serde_json::to_value(&summaries[0]).unwrap();
        old_summary
            .as_object_mut()
            .unwrap()
            .remove("workflowResult");
        assert!(serde_json::from_value::<RunSummary>(old_summary)
            .unwrap()
            .workflow_result
            .is_none());
        directory.close().await;
    }

    /// The Attempts table and the model-page grid price an attempt as the
    /// boards, the points and the evidence do: list price first, the
    /// provider's own figure only for a model the catalog does not price.
    #[tokio::test]
    async fn the_attempts_table_prices_list_first_like_the_boards() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let definition = store
            .save_draft(None, None, super::super::seeds::definitions().remove(0))
            .await
            .unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        store
            .save_catalog_entry(&CatalogEntry {
                id: "invented-list-price".into(),
                kind: "model".into(),
                provider_id: Some("invented-provider".into()),
                needle: "invented-priced-model".into(),
                display_name: None,
                vendor: None,
                input_per_million: Some(3.0),
                output_per_million: Some(15.0),
                cache_read_per_million: None,
                cache_write_per_million: None,
                context_tokens: None,
                effective_from: 1,
                checked_at: 1,
                source: "https://example.test".into(),
                created_at: 1,
            })
            .await
            .unwrap();
        let request = json!({"requestKey":"pricing","versionIds":[version.id],"configurations":[],"repetitions":1,"timeoutSeconds":30,"maxExecutions":2,"preview":false});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','pricing','completed',1,1,1,?)")
            .bind(request.to_string())
            .execute(&store.pool)
            .await
            .unwrap();
        // The provider reports a third of the list price for the priced model.
        for (id, model, reported) in [
            ("priced", "invented-priced-model", 1.0),
            ("unpriced", "invented-unpriced-model", 0.25),
        ] {
            let configuration = json!({"id":id,"providerId":"invented-provider","accountId":null,"modelId":model,"effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
            let attempt = json!({"id":id,"runId":"run","versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":"pass","finishedAt":1000,"usage":{"input":1_000_000,"output":0,"cost":reported,"schema":"provider_turn_usage_v1"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,?,0,'terminal',?)")
                .bind(id)
                .bind(&version.id)
                .bind(id)
                .bind(attempt.to_string())
                .execute(&store.pool)
                .await
                .unwrap();
        }
        let listed = store.list_attempts(&ResultQuery::default()).await.unwrap();
        let cost = |id: &str| listed.iter().find(|a| a.id == id).unwrap().cost;
        assert_eq!(cost("priced"), Some(3.0));
        assert_eq!(cost("unpriced"), Some(0.25));
        directory.close().await;
    }

    #[test]
    fn history_progress_requires_the_whole_panel_and_every_repetition() {
        let evaluation = |provenance: &str, score: Option<f64>| {
            serde_json::json!({
            "id":provenance,"evaluatorRevision":"1","verdict":"judged","score":score,
            "reason":"","createdAt":1,"provenance":provenance,"artifacts":[],
            "details":{"expectedJudges":2}})
        };
        let partial =
            serde_json::json!([evaluation("render", None), evaluation("judge", Some(0.8))]);
        let complete = serde_json::json!([
            evaluation("render", None),
            evaluation("judge", Some(0.8)),
            evaluation("judge", Some(0.6))
        ]);
        let rows = serde_json::json!([
            ["model", "partial", "terminal", "pending_review", partial],
            ["model", "partial", "terminal", "pass", null],
            ["model", "complete", "terminal", "pending_review", complete],
            ["model", "objective", "terminal", "pass", null],
            ["model", "unfinished", "terminal", "pass", null],
            ["model", "unfinished", "pending", null, null]
        ]);
        assert_eq!(settled_cells(&rows.to_string()).unwrap(), 2);
    }

    #[tokio::test]
    async fn history_summaries_and_result_pages_do_not_load_attempt_evidence() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
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
            // Two settled repetitions a resume set aside count nowhere.
            let outcome = if index == 2 || index == 4 {
                Some("superseded")
            } else if phase == "terminal" {
                Some("pass")
            } else {
                None
            };
            let mut attempt = json!({"id":id,"runId":run_id,"versionId":version_id,"configuration":configuration,"repetition":index,"phase":phase,"outcome":outcome,"output":output,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
            if outcome.is_some() {
                attempt["resolvedModel"] = json!("native-model-2026");
            }
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'candidate',?,?,?)")
                .bind(&id).bind(run_id).bind(version_id).bind(index).bind(phase).bind(attempt.to_string())
                .execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();

        let summaries = store.runs().await.unwrap();
        assert_eq!(summaries.len(), 100);
        assert_eq!(summaries[0].id, "run-104");
        assert_eq!(summaries[0].attempt_count, 123);
        assert_eq!(summaries[0].settled_count, 61);
        // Two cells: the first case's repetitions all settled, the second's pending.
        assert_eq!(summaries[0].cell_count, 2);
        assert_eq!(summaries[0].settled_cell_count, 1);
        assert_eq!(summaries[1].attempt_count, 0);
        assert!(!summaries.iter().any(|r| r.id == "run-0"));
        let serialized = serde_json::to_value(&summaries).unwrap();
        assert!(serialized[0].get("attempts").is_none());
        assert!(!serialized.to_string().contains("private evidence"));

        let first_page = store.list_attempts(&ResultQuery::default()).await.unwrap();
        assert_eq!(first_page.len(), 50);
        assert_eq!(first_page[0].id, "attempt-0");
        assert_eq!(first_page[0].model_id, "native-model");
        // The model the attempt's usage named, beside the one it asked for.
        assert_eq!(
            first_page[0].resolved_model.as_deref(),
            Some("native-model-2026")
        );
        assert_eq!(first_page[1].resolved_model, None);
        // A pass scores 1; a pending attempt has no score yet.
        assert_eq!(first_page[0].score, Some(1.0));
        assert_eq!(first_page[1].score, None);
        let projection = serde_json::to_value(&first_page[0]).unwrap();
        assert_eq!(projection.as_object().unwrap().len(), 13);
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
            exclude_judge_flags: None,
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
        directory.close().await;
    }

    #[tokio::test]
    async fn a_listed_attempt_without_a_reported_cost_is_priced_from_the_catalog() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let draft = super::super::seeds::definitions().remove(0);
        let definition = store.save_draft(None, None, draft).await.unwrap();
        let version = store.publish(&definition.id, 1).await.unwrap();
        let config = json!({"id":"c","providerId":"kimi-acp","accountId":null,"modelId":"kimi-code/k3","effort":"low","fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1","modelName":"Kimi K3"});
        let req = json!({"requestKey":"priced","versionIds":[version.id],"configurations":[config],"repetitions":1,"timeoutSeconds":30,"maxExecutions":3});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','priced','completed',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
        // The shipped Moonshot seed prices K3 at $3 in and $15 out per million.
        let finished = 1_800_000_000_000i64;
        for (id, cost) in [("unpriced", Value::Null), ("reported", json!(0.42))] {
            let a = json!({"id":id,"runId":"run","versionId":version.id,"configuration":config,"repetition":0,"phase":"terminal","outcome":"pass","startedAt":finished - 10,"finishedAt":finished,"durationMs":10,"usage":{"input":1_000_000,"output":100_000,"cacheRead":0,"cacheWrite":0,"cost":cost,"schema":"provider_turn_usage_v1"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,?,0,'terminal',?)").bind(id).bind(&version.id).bind(id).bind(a.to_string()).execute(&store.pool).await.unwrap();
        }
        let listed = store.list_attempts(&ResultQuery::default()).await.unwrap();
        let cost = |id: &str| listed.iter().find(|a| a.id == id).unwrap().cost;
        assert!((cost("unpriced").unwrap() - 4.5).abs() < 1e-9);
        // A reported figure gives way to the list price, as on every board.
        assert!((cost("reported").unwrap() - 4.5).abs() < 1e-9);
        directory.close().await;
    }

    #[tokio::test]
    async fn a_dated_attempt_listing_shows_each_attempt_as_it_stood_then() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
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
            let a = json!({"id":id,"runId":"run","versionId":version.id,"configuration":config,"repetition":0,"phase":"terminal","outcome":outcome,"startedAt":1,"finishedAt":finished,"durationMs":10,"usage":{"output":4,"cost":0.5,"schema":"native"},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[],"resolvedModel":"native-2026"});
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
        // Which model answered is known only once it has.
        assert_eq!(later.resolved_model, None);
        assert_eq!(
            then["reviewed"].resolved_model.as_deref(),
            Some("native-2026")
        );
        directory.close().await;
    }

    #[tokio::test]
    async fn a_run_summary_names_the_selections_its_attempts_ran_with() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
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
        directory.close().await;
    }

    #[tokio::test]
    async fn a_run_summary_lists_only_the_cells_its_run_has_yet_to_settle() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let mut draft = super::super::seeds::definitions().remove(0);
        let definition = store.save_draft(None, None, draft.clone()).await.unwrap();
        let first = store.publish(&definition.id, 1).await.unwrap();
        draft.name.push_str(" second version");
        store
            .save_draft(Some(&definition.id), Some(1), draft)
            .await
            .unwrap();
        let second = store.publish(&definition.id, 2).await.unwrap();
        let config = |id: &str| json!({"id":id,"providerId":"claude-acp","accountId":"account","modelId":id,"effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let req = json!({"requestKey":"open","versionIds":[first.id,second.id],"configurations":[config("sonnet"),config("haiku")],"repetitions":2,"timeoutSeconds":30,"maxExecutions":8});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','open','running',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
        for (id, configuration, version, repetition, phase, outcome) in [
            // Settled without a score: the run never retries it.
            (
                "a0",
                "sonnet",
                &first.id,
                0,
                "terminal",
                Some("infrastructure_failure"),
            ),
            ("a1", "sonnet", &first.id, 1, "terminal", Some("pass")),
            ("a2", "sonnet", &second.id, 0, "pending", None),
            (
                "a3",
                "sonnet",
                &second.id,
                1,
                "awaiting_judges",
                Some("pending_review"),
            ),
            ("a4", "haiku", &first.id, 0, "running", None),
            ("a5", "haiku", &second.id, 0, "terminal", Some("cancelled")),
            ("a6", "haiku", &second.id, 1, "pending", None),
        ] {
            let a = json!({"id":id,"runId":"run","versionId":version,"configuration":config(configuration),"repetition":repetition,"phase":phase,"outcome":outcome,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,?,?,?,?)").bind(id).bind(version).bind(configuration).bind(repetition).bind(phase).bind(a.to_string()).execute(&store.pool).await.unwrap();
        }
        let summary = store.runs().await.unwrap().remove(0);
        let cell = |configuration: &str, version: &str, running: bool| OpenRunCell {
            configuration_id: configuration.into(),
            version_id: version.into(),
            running,
        };
        // One entry per cell, in plan order, however many attempts it holds;
        // a cell runs while any attempt of it left the queue.
        assert_eq!(
            summary.open_cells,
            vec![
                cell("sonnet", &second.id, true),
                cell("haiku", &first.id, true),
                cell("haiku", &second.id, false),
            ]
        );
        assert_eq!(
            serde_json::to_value(&summary).unwrap()["openCells"][0],
            json!({"configurationId":"sonnet","versionId":second.id,"running":true})
        );
        // A run finished or being cancelled starts nothing, so its attempts are never read here.
        for state in ["completed", "cancelling", "cancelled"] {
            store.set_run_state("run", state).await.unwrap();
            assert!(store.runs().await.unwrap()[0].open_cells.is_empty());
        }
        directory.close().await;
    }

    #[tokio::test]
    async fn a_stop_outlives_a_completion_read_before_it() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','key','running',1,0,0,'{}')")
            .execute(&store.pool)
            .await
            .unwrap();
        let state = || async {
            sqlx::query_scalar::<_, String>("SELECT state FROM run_plans WHERE id='run'")
                .fetch_one(&store.pool)
                .await
                .unwrap()
        };
        // The dispatcher read this run as running, then found nothing of it
        // flying once the owner had stopped it: completed never takes the
        // stop back.
        for stop in ["cancelling", "cancelled"] {
            store.set_run_state("run", stop).await.unwrap();
            store.set_run_state("run", "completed").await.unwrap();
            assert_eq!(state().await, stop);
        }
        // Going on again, the run completes as before.
        store.set_run_state("run", "running").await.unwrap();
        store.set_run_state("run", "completed").await.unwrap();
        assert_eq!(state().await, "completed");
        directory.close().await;
    }

    #[tokio::test]
    async fn historical_definitions_and_filtered_usage_survive_ui_window_limits() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
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
        let visible = store.definition_summaries().await.unwrap();
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
        directory.close().await;
    }

    /// A catalog of large tasks once listed every prompt, fixture, check and
    /// mutant in one reply, hundreds of megabytes, and the app ran out of
    /// memory. The list carries summaries whose size does not grow with the
    /// tasks. Every byte of filler here is invented.
    #[tokio::test]
    async fn catalog_summaries_stay_small_however_large_the_tasks_are() {
        let directory = crate::test_support::TempRoot::new();
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let filler = "invented-filler-".repeat(512);
        let mut draft = super::super::seeds::definitions().remove(0);
        draft.name = "Invented large task".into();
        draft.task_family = "invented-family".into();
        draft.split = "held_out".into();
        draft.work_class_id = "debug".into();
        draft.facets.difficulty = Some("hard".into());
        draft.description = filler.clone();
        draft.prompt = filler.clone();
        draft.role_prompt = filler.clone();
        draft.evaluator = Evaluator {
            kind: "rubric".into(),
            expected: filler.clone(),
            rubric: filler.clone(),
            revision: "invented-revision".into(),
            known_good: filler.clone(),
            known_bad: filler.clone(),
        };
        draft.fixtures = (0..4)
            .map(|index| Fixture {
                path: format!("fixtures/input-{index}.txt"),
                content: filler.clone(),
            })
            .collect();
        draft.environment = json!({
            "mutants": [filler, filler, filler, filler],
            "alternatives": [{ "answer": filler }],
            "repositoryArtifactInput": { "before": { "patch": filler } },
            "authoredBy": [
                { "providerId": "example-provider", "modelId": "example-model", "effort": "xhigh" },
                "legacy-tag",
                { "providerId": "example-provider", "modelId": "other-model", "effort": null, "notes": filler },
            ],
            "splitGroup": "invented-group",
            "judgePanel": {
                "recipe": "frozen-native-panel-v1",
                "judges": [
                    { "providerId": "judge-a", "modelId": "judge-model", "effort": "high", "accountId": "account-a" },
                    { "providerId": "judge-b", "modelId": "judge-model", "effort": null, "accountId": "account-b" },
                ],
            },
            "generator": { "family": "invented-generator", "template": filler },
        });
        draft.entry_state = Some(EntryState {
            schema_version: 1,
            root_task_id: "root".into(),
            step_id: "step".into(),
            parent_step_id: None,
            fixture_snapshot_hash: "snapshot".into(),
            conversation_prefix: filler.clone(),
            previous_reports: vec![filler.clone()],
            remaining_budget_seconds: 60,
            content_hash: "entry-hash".into(),
        });
        draft.workflow = Some(WorkflowSpec {
            schema_version: 2,
            driver_revision: "driver".into(),
            steps: vec![
                WorkflowStep {
                    id: "implement".into(),
                    prompt: filler.clone(),
                    include_previous_output: false,
                    scope: Some(WorkflowScope {
                        role_id: "implementer".into(),
                        role_prompt: filler.clone(),
                        work_class_id: "debug".into(),
                        purpose: "implement".into(),
                        step_budget_seconds: 60,
                    }),
                },
                WorkflowStep {
                    id: "review".into(),
                    prompt: filler.clone(),
                    include_previous_output: true,
                    scope: None,
                },
            ],
        });
        let manifest = serde_json::to_string(&draft).unwrap();
        assert!(manifest.len() > 150_000, "{}", manifest.len());
        const DEFINITIONS: usize = 160;
        let mut tx = store.pool.begin().await.unwrap();
        for index in 0..DEFINITIONS {
            let id = format!("definition-{index}");
            sqlx::query("INSERT INTO benchmark_definitions(id,draft_json,revision,archived) VALUES(?,?,3,?)")
                .bind(&id).bind(&manifest).bind(index == 0).execute(&mut *tx).await.unwrap();
            for version in 0..2 {
                sqlx::query("INSERT INTO benchmark_versions(id,definition_id,content_hash,manifest_json,published_at) VALUES(?,?,?,?,?)")
                    .bind(format!("{id}-v{version}")).bind(&id).bind(format!("hash-{index}-{version}"))
                    .bind(&manifest).bind(version).execute(&mut *tx).await.unwrap();
            }
        }
        tx.commit().await.unwrap();
        let stored: i64 = sqlx::query_scalar(
            "SELECT (SELECT SUM(LENGTH(draft_json)) FROM benchmark_definitions)+(SELECT SUM(LENGTH(manifest_json)) FROM benchmark_versions)",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert!(stored > 90_000_000, "{stored}");

        let listed = store.definition_summaries().await.unwrap();
        let reply = serde_json::to_string(&listed).unwrap();
        assert_eq!(listed.len(), DEFINITIONS);
        assert!(reply.len() < 1_000_000, "{} bytes", reply.len());
        assert!(!reply.contains("invented-filler-"));
        assert!(!reply.contains("account-a"));

        // The listed facts read the same paths as the full manifest.
        let first = listed.last().unwrap();
        assert_eq!(first.id, "definition-0");
        assert!(first.archived);
        assert_eq!(first.draft_revision, 3);
        let ids: Vec<&str> = first.versions.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["definition-0-v1", "definition-0-v0"]);
        let summary = &first.versions[0].manifest;
        assert_eq!(summary, &first.draft);
        assert_eq!(summary.name, draft.name);
        assert_eq!(summary.task_family, draft.task_family);
        assert_eq!(summary.split, "held_out");
        assert_eq!(summary.work_class_id, "debug");
        assert_eq!(summary.facets, draft.facets);
        assert_eq!(summary.limits, draft.limits);
        assert_eq!(summary.repetitions, draft.repetitions);
        assert_eq!(summary.evaluator.kind, "rubric");
        assert_eq!(summary.evaluator.revision, "invented-revision");
        assert_eq!(
            summary
                .entry_state
                .as_ref()
                .map(|e| e.content_hash.as_str()),
            Some("entry-hash")
        );
        let workflow = summary.workflow.as_ref().unwrap();
        assert_eq!(workflow.steps.len(), 2);
        assert_eq!(
            workflow.steps[0]
                .scope
                .as_ref()
                .map(|s| s.work_class_id.as_str()),
            Some("debug")
        );
        assert!(workflow.steps[1].scope.is_none());
        assert_eq!(
            summary.environment,
            json!({
                "authoredBy": [
                    { "providerId": "example-provider", "modelId": "example-model", "effort": "xhigh" },
                    { "providerId": "example-provider", "modelId": "other-model", "effort": null },
                ],
                "splitGroup": "invented-group",
                "judgePanel": { "judges": [
                    { "providerId": "judge-a", "modelId": "judge-model", "effort": "high" },
                    { "providerId": "judge-b", "modelId": "judge-model", "effort": null },
                ] },
                "generator": { "family": "invented-generator" },
            })
        );

        // A manifest from before the defaulted fields lists their defaults,
        // and an environment without the listed keys lists none of them.
        let mut legacy: Value = serde_json::from_str(&manifest).unwrap();
        let object = legacy.as_object_mut().unwrap();
        for key in ["workClassId", "roleContextHash", "entryState", "workflow"] {
            object.remove(key);
        }
        object.insert("environment".into(), json!({ "mutants": [filler] }));
        sqlx::query("UPDATE benchmark_definitions SET draft_json=? WHERE id='definition-1'")
            .bind(legacy.to_string())
            .execute(&store.pool)
            .await
            .unwrap();
        let listed = store.definition_summaries().await.unwrap();
        let legacy = &listed
            .iter()
            .find(|d| d.id == "definition-1")
            .unwrap()
            .draft;
        assert_eq!(legacy.work_class_id, "general");
        assert_eq!(legacy.role_context_hash, "clean-v1");
        assert!(legacy.entry_state.is_none() && legacy.workflow.is_none());
        assert_eq!(legacy.environment, json!({}));
        directory.close().await;
    }

    #[tokio::test]
    async fn ledger_counts_native_children_once_and_recovery_preserves_sealed_cancellation() {
        let dir = crate::test_support::TempRoot::new();
        let store = Store::open(dir.path()).await.unwrap();
        dir.register(&store.pool);
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
        dir.close().await;
    }
}
