//! Offline maintenance of the chat history database for the `flock-history`
//! binary: the compaction the host runs in the background, on a database no
//! app has open, followed by the VACUUM that returns the freed pages.
use std::path::Path;

pub use crate::services::agent_host::store::CompactionStats;

/// Compact every session of the database at `db_path` and vacuum the file.
/// The pass takes the host's own write path, so it is meant for a database
/// Flock is not running on. Says what the pass read and left, and whether
/// it vacuumed: an earlier complete pass leaves nothing to do unless `again`
/// forgets it first (for a database older builds kept writing to).
pub async fn compact(
    db_path: &Path,
    again: bool,
    progress: impl FnMut(&str, &CompactionStats),
) -> Result<(CompactionStats, bool), String> {
    if !db_path.is_file() {
        return Err(format!("{} is not a file", db_path.display()));
    }
    let store = crate::services::agent_host::store::SessionStore::open(db_path).await?;
    let result = async {
        if again {
            store.forget_history_compaction().await?;
        }
        let total = store
            .compact_history(|_| std::future::ready(false), progress)
            .await?;
        let vacuumed = store.vacuum_if_pending().await?;
        Ok::<_, String>((total, vacuumed))
    }
    .await;
    store.close().await;
    result
}
