//! Stale flockctl discovery-file cleanup.
//!
//! Each app instance's flockctl broker writes a discovery file at
//! `<Flock root>/flockctl/control-<app_pid>.json` and deletes it on
//! stop/exit. A crashed instance leaves its file behind (possibly as a
//! `control-<pid>.json.tmp` orphan from a crash mid-write); this sweep
//! removes files whose owning app process is no longer alive. The directory
//! and filename formats are owned by the plugin's discovery module. Compiled
//! unconditionally — stale files must be cleaned even by builds where the
//! flockctl feature is off.
//!
//! ## Why the root, not the app data folder
//!
//! Builds before this one wrote the file under the OS's identifier-keyed app
//! data folder. On Windows that folder is not one folder for everyone: a
//! process started from the Claude desktop app, every agent session's shell
//! among them, sees `%LOCALAPPDATA%` through that app's package redirection,
//! a merged copy-on-write view under `…\Packages\Claude_…\LocalCache\`. A dev
//! app started from such a session wrote its discovery file into that view,
//! where it outlived the instance and was listed by every later such process
//! beside the operator's, with nothing to tell the two apart. The home
//! directory is not redirected, so a file under the root is the same file for
//! everyone (the app log moved for the same reason; see `services::app_log`).
//!
//! The two folders older builds wrote are still swept, so files their crashed
//! instances left do not accumulate, and each is removed once it is empty. A
//! running instance of an older build keeps its file and its folder.

use std::path::Path;

use tauri_plugin_flockctl::{owner_pid_from_discovery_file_name, DISCOVERY_DIR_NAME};

use crate::services::process::{pid_t_from_u32, process_is_alive};

/// Discovery directory of the builds that shipped as Distill, under the app
/// data folder. This build's broker never writes there, but an instance of
/// the old build that crashed left its file behind, so the directory is swept
/// like the current one and removed once nothing is left in it.
const LEGACY_DISCOVERY_DIR_NAME: &str = "distillctl";

/// Remove discovery files left behind by dead app instances. The live
/// instances' files (including this one's) are left alone; this instance's
/// plugin owns its own file's lifecycle.
///
/// `flock_root` holds the current folder; `app_data_dir` is the identifier-
/// keyed OS folder where builds before this one wrote, under this build's
/// directory name and under the Distill-era one.
pub fn sweep_stale_discovery_files(flock_root: &Path, app_data_dir: &Path) {
    sweep_discovery_dir(&flock_root.join(DISCOVERY_DIR_NAME));

    for legacy_dir in [
        app_data_dir.join(DISCOVERY_DIR_NAME),
        app_data_dir.join(LEGACY_DISCOVERY_DIR_NAME),
    ] {
        sweep_discovery_dir(&legacy_dir);
        remove_dir_if_empty(&legacy_dir);
    }
}

fn sweep_discovery_dir(dir: &Path) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            log::warn!(
                "Failed to read flockctl discovery dir {}: {error}",
                dir.display()
            );
            return;
        }
    };

    for entry in entries.flatten() {
        let Some(owner_pid) = entry
            .file_name()
            .to_str()
            .and_then(owner_pid_from_discovery_file_name)
        else {
            continue;
        };
        if owner_pid == std::process::id() {
            continue;
        }

        let alive = pid_t_from_u32(owner_pid).is_some_and(process_is_alive);
        if alive {
            continue;
        }

        let path = entry.path();
        log::info!("Removing stale flockctl discovery file {}", path.display());
        if let Err(error) = std::fs::remove_file(&path) {
            log::warn!(
                "Failed to remove stale flockctl discovery file {}: {error}",
                path.display()
            );
        }
    }
}

/// `remove_dir` refuses a non-empty directory, which is exactly the rule: a
/// still-running instance of an older build keeps its directory.
fn remove_dir_if_empty(dir: &Path) {
    match std::fs::remove_dir(dir) {
        Ok(()) => log::info!("Removed the empty legacy discovery dir {}", dir.display()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) => {}
        Err(error) => log::warn!(
            "Failed to remove the legacy discovery dir {}: {error}",
            dir.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::{tempdir, TempDir};

    /// A root and an app data folder that are, as on a real machine, two
    /// different places.
    fn folders() -> (TempDir, TempDir) {
        (tempdir().unwrap(), tempdir().unwrap())
    }

    fn write_discovery_file_in(base_dir: &Path, dir_name: &str, name: &str) -> PathBuf {
        let dir = base_dir.join(dir_name);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, "{}").unwrap();
        path
    }

    /// A file in the current folder, under the root.
    fn write_discovery_file(flock_root: &Path, name: &str) -> PathBuf {
        write_discovery_file_in(flock_root, DISCOVERY_DIR_NAME, name)
    }

    /// Spawn and reap a short-lived child to obtain a pid that is no longer
    /// alive.
    fn dead_pid() -> u32 {
        // `true` is not an executable on a stock Windows PATH.
        let mut command = if cfg!(windows) {
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/D", "/C", "exit 0"]);
            command
        } else {
            std::process::Command::new("true")
        };
        crate::services::process::apply_no_window(&mut command);
        let mut child = command.spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }

    /// pid 1 (launchd/init) and pid 4 (Windows System) are always alive.
    fn live_pid() -> u32 {
        if cfg!(windows) {
            4
        } else {
            1
        }
    }

    #[test]
    fn removes_dead_owner_files_and_keeps_live_and_own_files() {
        let (flock_root, app_data_dir) = folders();
        let gone = dead_pid();
        let dead = write_discovery_file(flock_root.path(), &format!("control-{gone}.json"));
        let dead_tmp = write_discovery_file(flock_root.path(), &format!("control-{gone}.json.tmp"));
        let own = write_discovery_file(
            flock_root.path(),
            &format!("control-{}.json", std::process::id()),
        );
        let live = write_discovery_file(flock_root.path(), &format!("control-{}.json", live_pid()));
        let unrelated = write_discovery_file(flock_root.path(), "notes.json");

        sweep_stale_discovery_files(flock_root.path(), app_data_dir.path());

        assert!(!dead.exists());
        assert!(!dead_tmp.exists());
        assert!(own.exists());
        assert!(live.exists());
        assert!(unrelated.exists());
        for dir_name in [DISCOVERY_DIR_NAME, LEGACY_DISCOVERY_DIR_NAME] {
            assert!(
                !app_data_dir.path().join(dir_name).exists(),
                "the sweep creates nothing: {dir_name}"
            );
        }
    }

    /// The current folder is the broker's, not the sweep's: emptied, it stays.
    #[test]
    fn the_current_folder_stays_when_the_sweep_empties_it() {
        let (flock_root, app_data_dir) = folders();
        let gone = dead_pid();
        let dead = write_discovery_file(flock_root.path(), &format!("control-{gone}.json"));

        sweep_stale_discovery_files(flock_root.path(), app_data_dir.path());

        assert!(!dead.exists());
        assert!(flock_root.path().join(DISCOVERY_DIR_NAME).is_dir());
    }

    /// Both folders older builds wrote: this build's directory name under the
    /// app data folder, and the Distill-era one.
    #[test]
    fn sweeps_the_legacy_directories_and_removes_them_once_empty() {
        let (flock_root, app_data_dir) = folders();
        let gone = dead_pid();
        let mut left_behind = Vec::new();
        for dir_name in [DISCOVERY_DIR_NAME, LEGACY_DISCOVERY_DIR_NAME] {
            left_behind.push(write_discovery_file_in(
                app_data_dir.path(),
                dir_name,
                &format!("control-{gone}.json"),
            ));
            left_behind.push(write_discovery_file_in(
                app_data_dir.path(),
                dir_name,
                &format!("control-{gone}.json.tmp"),
            ));
        }

        sweep_stale_discovery_files(flock_root.path(), app_data_dir.path());

        for path in left_behind {
            assert!(!path.exists(), "{}", path.display());
        }
        for dir_name in [DISCOVERY_DIR_NAME, LEGACY_DISCOVERY_DIR_NAME] {
            assert!(
                !app_data_dir.path().join(dir_name).exists(),
                "the emptied legacy directory goes: {dir_name}"
            );
        }
        assert!(
            !flock_root.path().join(DISCOVERY_DIR_NAME).exists(),
            "the sweep creates nothing"
        );
    }

    #[test]
    fn keeps_a_legacy_directory_while_something_still_lives_in_it() {
        for dir_name in [DISCOVERY_DIR_NAME, LEGACY_DISCOVERY_DIR_NAME] {
            let (flock_root, app_data_dir) = folders();
            let legacy_dir = app_data_dir.path().join(dir_name);
            let live = write_discovery_file_in(
                app_data_dir.path(),
                dir_name,
                &format!("control-{}.json", live_pid()),
            );

            sweep_stale_discovery_files(flock_root.path(), app_data_dir.path());

            assert!(
                live.exists(),
                "a running older-build instance keeps its file: {dir_name}"
            );
            assert!(legacy_dir.exists());

            std::fs::remove_file(&live).unwrap();
            let unrelated = write_discovery_file_in(app_data_dir.path(), dir_name, "notes.json");

            sweep_stale_discovery_files(flock_root.path(), app_data_dir.path());

            assert!(unrelated.exists(), "only discovery files are swept");
            assert!(legacy_dir.exists(), "a non-empty directory stays");
        }
    }

    /// Compatibility pin: the legacy directory is the one the Distill-era
    /// broker wrote to. A rename sweep that rewrites it makes both names the
    /// same directory and fails here.
    #[test]
    fn the_legacy_discovery_dir_keeps_its_old_name() {
        assert_eq!(DISCOVERY_DIR_NAME, "flockctl");
        assert_ne!(LEGACY_DISCOVERY_DIR_NAME, DISCOVERY_DIR_NAME);
        assert!(!LEGACY_DISCOVERY_DIR_NAME.contains("flock"));
        assert!(LEGACY_DISCOVERY_DIR_NAME.ends_with("ctl"));
    }
}
