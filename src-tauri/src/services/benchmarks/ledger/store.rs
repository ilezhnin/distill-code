use crate::services::benchmarks::types::*;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Row, SqlitePool,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

mod diagnostics;

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
            let Some((class, difficulty)) = crate::services::benchmarks::routing::legacy_work_class(
                &draft.work_class_id,
                &draft.name,
            ) else {
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
            let hash =
                crate::services::benchmarks::fixtures::publish_blob(&self.root, &manifest).await?;
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
mod workflow_activity_tests;

mod attempts;
mod definitions;
mod designs;
mod records;
mod runs;

use self::designs::*;
#[cfg(test)]
use self::runs::*;

#[cfg(test)]
mod tests;
