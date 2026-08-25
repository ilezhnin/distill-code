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

use tauri::{Manager, State};

use crate::services::distill_root::{
    ensure_root_layout, has_legacy_goose_data, has_root_pointer, legacy_goose_data_dir,
    resolve_document_path, should_adopt_root, write_root_pointer, DISTILL_ROOT_ENV,
};

/// The resolved root, held for the process's lifetime.
///
/// Resolved once at startup: goose is handed `GOOSE_PATH_ROOT` when it spawns
/// and cannot be told to move afterwards, so a root that changed mid-run would
/// leave the two halves of the app writing to different folders.
pub struct DistillRootState {
    pub root: std::path::PathBuf,
    pub os_config_dir: std::path::PathBuf,
    /// True when goose was pointed at the root on this start. False means a
    /// previous install's chats and projects are still in their old place and
    /// nobody has asked to move them.
    pub goose_adopted: bool,
    /// Where those chats and projects are, when they have not moved.
    pub legacy_data_dir: Option<std::path::PathBuf>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistillRootInfo {
    /// Absolute path of the folder holding everything Distill owns.
    pub root: String,
    /// True when an environment variable forced it, so the UI can say the
    /// setting is not in charge right now instead of pretending it is.
    pub forced_by_environment: bool,
    /// True when chats, projects and settings are in the root too. False when
    /// only the app's own documents are, and goose is still using its old
    /// directories.
    pub holds_everything: bool,
    /// The old location, when there is still something in it.
    pub legacy_data_dir: Option<String>,
}

#[tauri::command]
pub fn get_distill_root(state: State<'_, DistillRootState>) -> DistillRootInfo {
    DistillRootInfo {
        root: state.root.to_string_lossy().to_string(),
        forced_by_environment: std::env::var(DISTILL_ROOT_ENV).is_ok(),
        holds_everything: state.goose_adopted,
        legacy_data_dir: state
            .legacy_data_dir
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
    }
}

/// Records a new root for the next start.
///
/// Existing data is left where it is on purpose. Moving gigabytes while the
/// app runs, with goose holding files open, is how people lose a folder; the
/// operator copies it themselves and the app picks it up on restart. The UI
/// says exactly that.
#[tauri::command]
pub fn set_distill_root(state: State<'_, DistillRootState>, path: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(path.trim());
    write_root_pointer(&state.os_config_dir, &root)?;
    ensure_root_layout(&root)
}

/// Reads one document. A document that was never written is `None`, not an
/// error — every caller's first read is a miss.
#[tauri::command]
pub fn read_distill_document(
    state: State<'_, DistillRootState>,
    path: String,
) -> Result<Option<String>, String> {
    let target = resolve_document_path(&state.root, &path)?;
    match fs::read_to_string(&target) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read '{}': {error}", target.display())),
    }
}

/// Writes one document, atomically.
///
/// Temporary file then rename, so a crash mid-write leaves the previous
/// version intact rather than a half-written one. A planner truncated to
/// nothing by a power cut would be indistinguishable from a planner the
/// operator emptied.
#[tauri::command]
pub fn write_distill_document(
    state: State<'_, DistillRootState>,
    path: String,
    contents: String,
) -> Result<(), String> {
    let target = resolve_document_path(&state.root, &path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create '{}': {error}", parent.display()))?;
    }
    let temporary = target.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, contents.as_bytes())
        .map_err(|error| format!("Cannot write '{}': {error}", temporary.display()))?;
    match fs::rename(&temporary, &target) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(format!("Cannot replace '{}': {error}", target.display()))
        }
    }
}

/// Resolves the root at startup, creates it, and exports `GOOSE_PATH_ROOT` so
/// the goose child puts its config, data, state, agents and plugins inside it
/// instead of in three OS-blessed directories elsewhere.
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

    let legacy_dir = legacy_goose_data_dir();
    let legacy_has_data = legacy_dir
        .as_deref()
        .is_some_and(has_legacy_goose_data);
    let adopt = should_adopt_root(
        env_value.is_some(),
        has_root_pointer(&os_config_dir),
        legacy_has_data,
    );

    if adopt {
        // Set before goose is spawned; `GooseServeProcess` inherits this
        // process's environment.
        std::env::set_var(
            crate::services::distill_root::GOOSE_PATH_ROOT_ENV,
            &root,
        );
        // Recorded so the choice survives, including the fresh-install case
        // where nobody chose anything and the default was simply free to take.
        if env_value.is_none() {
            if let Err(error) = write_root_pointer(&os_config_dir, &root) {
                log::warn!("Could not record the Distill root: {error}");
            }
        }
    } else {
        log::info!(
            "Keeping goose's existing data directory; choose a Distill folder to move it"
        );
    }

    Ok(DistillRootState {
        root,
        os_config_dir,
        goose_adopted: adopt,
        legacy_data_dir: if legacy_has_data { legacy_dir } else { None },
    })
}
