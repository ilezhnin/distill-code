//! Where the app's own log file goes.
//!
//! `flock.log` lives in the Flock root, under `logs/`, not in the OS's
//! identifier-keyed log folder the log plugin would pick by default. The root
//! is the one folder the operator archives and the one every tool is pointed
//! at, so the log sits next to the data it explains.
//!
//! On Windows there is a second reason: `%LOCALAPPDATA%` is not one folder
//! for everyone. A process started from the Claude desktop app, every agent
//! session's shell among them, sees it through that app's package
//! redirection (`…\AppData\Local\Packages\Claude_…\LocalCache\Local\…`), a
//! merged view in which a file such a process once wrote hides the real one
//! from every later such process. An app instance started from an agent
//! session on 2026-10-22 wrote its own `flock.log` there; from then on every
//! agent session read that frozen copy and took the live log for stopped,
//! while the operator's app kept writing the real file. The home directory
//! is not redirected, so a root under it is the same file for everyone.
//!
//! The root is resolved here, before the app exists, the same way the store
//! resolves it once the app runs ([`flock_root::resolve_root`] fed the same
//! OS folders), so the log and the data cannot land in different roots.

use std::fs;
use std::path::{Path, PathBuf};

use crate::services::e2e_mode::E2eMode;
use crate::services::flock_root;

/// The folder under the root that holds the log and its rotated archives.
pub(crate) const LOG_DIR_NAME: &str = "logs";
/// The log file's name without the `.log` the plugin appends.
pub(crate) const LOG_FILE_STEM: &str = "flock";
/// The log file's name as it appears on disk.
pub(crate) const LOG_FILE_NAME: &str = "flock.log";

/// The root this start will use, as the store resolves it in `setup`, or
/// `None` when the OS names no home or config folder.
pub(crate) fn startup_root(e2e_mode: Option<&E2eMode>, identifier: &str) -> Option<PathBuf> {
    if let Some(mode) = e2e_mode {
        return Some(mode.flock_root());
    }
    // The folders `tauri::path::PathResolver` hands the store later:
    // `app_config_dir()` is the OS config folder keyed by the identifier,
    // `home_dir()` the user's home.
    let os_config_dir = dirs::config_dir()?.join(identifier);
    let home_dir = dirs::home_dir()?;
    Some(flock_root::resolve_root(
        flock_root::root_override().as_deref(),
        &os_config_dir,
        &home_dir,
    ))
}

/// The folder the log file goes in, `<root>/logs`, created here because the
/// plugin opens the file at once. `None` when it cannot be created (a root
/// pointer at a vanished drive), so the caller can fall back to the OS log
/// folder and the app still starts to report that.
pub(crate) fn log_dir(root: Option<&Path>) -> Option<PathBuf> {
    let dir = root?.join(LOG_DIR_NAME);
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// The log plugin's file target: the root's `logs/` when it exists, else the
/// OS's identifier-keyed log folder.
pub(crate) fn file_target(log_dir: Option<PathBuf>) -> tauri_plugin_log::Target {
    let kind = match log_dir {
        Some(path) => tauri_plugin_log::TargetKind::Folder {
            path,
            file_name: Some(LOG_FILE_STEM.into()),
        },
        None => tauri_plugin_log::TargetKind::LogDir {
            file_name: Some(LOG_FILE_STEM.into()),
        },
    };
    tauri_plugin_log::Target::new(kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_folder_is_logs_under_the_root_and_is_created() {
        let root = tempfile::tempdir().unwrap();
        let dir = log_dir(Some(root.path())).unwrap();
        assert_eq!(dir, root.path().join(LOG_DIR_NAME));
        assert!(dir.is_dir());
        assert_eq!(dir.join(LOG_FILE_NAME).file_stem().unwrap(), LOG_FILE_STEM);
    }

    #[test]
    fn no_log_folder_without_a_root_or_when_it_cannot_be_created() {
        assert_eq!(log_dir(None), None);
        let root = tempfile::tempdir().unwrap();
        let file_as_root = root.path().join("not-a-folder");
        fs::write(&file_as_root, b"").unwrap();
        assert_eq!(log_dir(Some(&file_as_root)), None);
    }
}
