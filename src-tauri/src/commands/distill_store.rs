//! Reading and writing the app's own documents inside the Distill root.
//!
//! Deliberately a document store and not a file API: the renderer names a
//! relative path and gets JSON text back, and everything about *where* that
//! lands is decided here. The renderer cannot reach outside the root, cannot
//! write anything but `.json`, and cannot learn the root's contents beyond
//! what it asked for.
//!
//! This is what replaces `localStorage` for the planner, memory and the review
//! queue. Those were browser state: invisible to a backup, unreadable by a
//! person, and gone on a reinstall — the exact split the single root exists to
//! remove.

use std::fs;
use std::io::Write;
use std::path::Path;

use tauri::{Manager, State};

use crate::services::distill_root::{
    ensure_root_layout, resolve_document_path, write_root_pointer, DISTILL_ROOT_ENV,
};

/// The resolved root, held for the process's lifetime.
///
/// Resolved once at startup; a root that changed mid-run would leave parts
/// of the app writing to different folders.
pub struct DistillRootState {
    pub root: std::path::PathBuf,
    pub os_config_dir: std::path::PathBuf,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistillRootInfo {
    /// Absolute path of the folder holding everything Distill owns.
    pub root: String,
    /// True when an environment variable forced it, so the UI can say the
    /// setting is not in charge right now instead of pretending it is.
    pub forced_by_environment: bool,
}

#[tauri::command]
pub fn get_distill_root(state: State<'_, DistillRootState>) -> DistillRootInfo {
    DistillRootInfo {
        root: state.root.to_string_lossy().to_string(),
        forced_by_environment: std::env::var(DISTILL_ROOT_ENV).is_ok(),
    }
}

/// Records a new root for the next start.
///
/// Existing data is left where it is on purpose. Moving gigabytes while the
/// app runs, with files open, is how people lose a folder; the operator
/// copies it themselves and the app picks it up on restart. The UI says
/// exactly that.
#[tauri::command]
pub fn set_distill_root(state: State<'_, DistillRootState>, path: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(path.trim());
    write_root_pointer(&state.os_config_dir, &root)?;
    ensure_root_layout(&root)
}

/// Largest document either store will read into memory.
///
/// The documents are written by the app, so the cap is not a policy about what
/// belongs in a planner — it is a refusal to turn an out-of-band replacement
/// (a `.distill/*.md` swapped for something enormous, a planner grown by a
/// runaway writer) into a multi-gigabyte `String` in the app's address space.
/// Far above anything the app itself produces, far below "unbounded".
pub(crate) const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;

/// Reads a store document with the size cap applied before the read.
///
/// A document that was never written is `None`, not an error — every caller's
/// first read is a miss. The metadata check happens first so an oversized file
/// is refused without allocating for it.
pub(crate) fn read_document_capped(target: &Path) -> Result<Option<String>, String> {
    match fs::metadata(target) {
        Ok(metadata) if metadata.len() > MAX_DOCUMENT_BYTES => {
            return Err(format!(
                "Cannot read '{}': the document is {} bytes, above the {MAX_DOCUMENT_BYTES} byte limit",
                target.display(),
                metadata.len()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read '{}': {error}", target.display())),
    }
    match fs::read_to_string(target) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read '{}': {error}", target.display())),
    }
}

/// Reads one document. A document that was never written is `None`, not an
/// error — every caller's first read is a miss.
///
/// `async` + `spawn_blocking`: a synchronous `#[tauri::command]` runs inline in
/// the WebView2 IPC callback, i.e. on the UI thread, so a read from a slow or
/// network drive would stall the window.
#[tauri::command]
pub async fn read_distill_document(
    state: State<'_, DistillRootState>,
    path: String,
) -> Result<Option<String>, String> {
    let target = resolve_document_path(&state.root, &path)?;
    tokio::task::spawn_blocking(move || read_document_capped(&target))
        .await
        .map_err(|error| format!("Cannot read '{path}': {error}"))?
}

/// Writes one document, atomically.
///
/// Temporary file then rename, so a crash mid-write leaves the previous
/// version intact rather than a half-written one. A planner truncated to
/// nothing by a power cut would be indistinguishable from a planner the
/// operator emptied.
///
/// `async` + `spawn_blocking`: this is the debounced planner/memory/queue
/// autosave path and it ends in an `fsync`. A synchronous `#[tauri::command]`
/// runs inline in the WebView2 IPC callback, so the flush would block the
/// window every time someone ticks a planner item.
///
/// CONTRACT: **the caller must serialise its writes per path.** A synchronous
/// command ran inline in the IPC callback and so completed in message order;
/// this one is spawned onto the Tokio pool, so two `invoke`s that are in flight
/// at the same time can land in either order and the older document can be the
/// one that survives. Every read-modify-write of a document therefore has to
/// await the previous write of that same document before starting the next —
/// which is what `distillDocument.ts` (a per-path promise chain),
/// `taskMemory.ts` (`documentQueues`) and `memoryStore.ts` (`enqueueFolderWork`)
/// do. A new caller that fires two writes of one path without awaiting is a
/// last-writer-wins bug, and nothing here can detect it.
#[tauri::command]
pub async fn write_distill_document(
    state: State<'_, DistillRootState>,
    path: String,
    contents: String,
) -> Result<(), String> {
    let target = resolve_document_path(&state.root, &path)?;
    tokio::task::spawn_blocking(move || write_document_at(&target, &contents))
        .await
        .map_err(|error| format!("Cannot write '{path}': {error}"))?
}

fn write_document_at(target: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create '{}': {error}", parent.display()))?;
    }
    let temporary = target.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    write_file_synced(&temporary, contents.as_bytes())
        .map_err(|error| format!("Cannot write '{}': {error}", temporary.display()))?;
    match fs::rename(&temporary, target) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(format!("Cannot replace '{}': {error}", target.display()))
        }
    }
}

/// Writes `bytes` to `path` and flushes them to disk before returning.
///
/// The temporary file of a write-then-rename must be durable before the
/// rename: otherwise a power cut can persist the rename but not the data,
/// and the document comes back empty instead of in its previous version.
pub(crate) fn write_file_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Resolves the root at startup and creates it.
pub fn initialize(app: &tauri::App) -> Result<DistillRootState, String> {
    let os_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("No config directory: {error}"))?;
    let home_dir = app
        .path()
        .home_dir()
        .map_err(|error| format!("No home directory: {error}"))?;
    let env_value = std::env::var(DISTILL_ROOT_ENV).ok();

    let root = crate::services::distill_root::resolve_root(
        env_value.as_deref(),
        &os_config_dir,
        &home_dir,
    );
    ensure_root_layout(&root)?;

    // Recorded so the choice survives, including the fresh-install case
    // where nobody chose anything and the default was simply free to take.
    if env_value.is_none() {
        if let Err(error) = write_root_pointer(&os_config_dir, &root) {
            log::warn!("Could not record the Distill root: {error}");
        }
    }

    Ok(DistillRootState {
        root,
        os_config_dir,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("distill-store-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_document_never_written_reads_as_nothing() {
        let root = temp();
        assert_eq!(
            read_document_capped(&root.join("planner.json")).unwrap(),
            None
        );
    }

    #[test]
    fn writes_and_reads_back_a_document() {
        let root = temp();
        let target = root.join("nested").join("planner.json");
        write_document_at(&target, "{\"a\":1}").unwrap();
        assert_eq!(
            read_document_capped(&target).unwrap().as_deref(),
            Some("{\"a\":1}")
        );
    }

    #[test]
    fn refuses_a_document_above_the_size_cap_without_reading_it() {
        let root = temp();
        let target = root.join("planner.json");
        // Sparse where the filesystem supports it: the point is the declared
        // length, not writing 64 MiB of bytes.
        let file = fs::File::create(&target).unwrap();
        file.set_len(MAX_DOCUMENT_BYTES + 1).unwrap();
        drop(file);

        let error = read_document_capped(&target).unwrap_err();
        assert!(error.contains("above the"), "{error}");
        assert!(error.contains(&MAX_DOCUMENT_BYTES.to_string()), "{error}");
    }
}
