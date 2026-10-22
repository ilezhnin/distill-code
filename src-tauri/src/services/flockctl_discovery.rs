//! Stale flockctl discovery-file cleanup.
//!
//! Each app instance's flockctl broker writes a discovery file at
//! `<app_data_dir>/flockctl/control-<app_pid>.json` and deletes it on
//! stop/exit. A crashed instance leaves its file behind (possibly as a
//! `control-<pid>.json.tmp` orphan from a crash mid-write); this sweep
//! removes files whose owning app process is no longer alive. The directory
//! and filename formats are owned by the plugin's discovery module. Compiled
//! unconditionally — stale files must be cleaned even by builds where the
//! flockctl feature is off.

use std::path::Path;

use tauri_plugin_flockctl::{owner_pid_from_discovery_file_name, DISCOVERY_DIR_NAME};

use crate::services::process::{pid_t_from_u32, process_is_alive};

/// Discovery directory of the builds that shipped as Distill. This build's
/// broker never writes there, but an instance of the old build that crashed
/// left its file behind, so the directory is swept like the current one and
/// removed once nothing is left in it.
const LEGACY_DISCOVERY_DIR_NAME: &str = "distillctl";

/// Remove discovery files left behind by dead app instances. The live
/// instances' files (including this one's) are left alone; this instance's
/// plugin owns its own file's lifecycle.
pub fn sweep_stale_discovery_files(app_data_dir: &Path) {
    sweep_discovery_dir(&app_data_dir.join(DISCOVERY_DIR_NAME));

    let legacy_dir = app_data_dir.join(LEGACY_DISCOVERY_DIR_NAME);
    sweep_discovery_dir(&legacy_dir);
    remove_dir_if_empty(&legacy_dir);
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
/// still-running instance of the old build keeps its directory.
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
    use tempfile::tempdir;

    fn write_discovery_file_in(app_data_dir: &Path, dir_name: &str, name: &str) -> PathBuf {
        let dir = app_data_dir.join(dir_name);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, "{}").unwrap();
        path
    }

    fn write_discovery_file(app_data_dir: &Path, name: &str) -> PathBuf {
        write_discovery_file_in(app_data_dir, DISCOVERY_DIR_NAME, name)
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
        let app_data_dir = tempdir().unwrap();
        let gone = dead_pid();
        let dead = write_discovery_file(app_data_dir.path(), &format!("control-{gone}.json"));
        let dead_tmp =
            write_discovery_file(app_data_dir.path(), &format!("control-{gone}.json.tmp"));
        let own = write_discovery_file(
            app_data_dir.path(),
            &format!("control-{}.json", std::process::id()),
        );
        let live =
            write_discovery_file(app_data_dir.path(), &format!("control-{}.json", live_pid()));
        let unrelated = write_discovery_file(app_data_dir.path(), "notes.json");

        sweep_stale_discovery_files(app_data_dir.path());

        assert!(!dead.exists());
        assert!(!dead_tmp.exists());
        assert!(own.exists());
        assert!(live.exists());
        assert!(unrelated.exists());
        assert!(
            !app_data_dir.path().join(LEGACY_DISCOVERY_DIR_NAME).exists(),
            "the sweep creates nothing"
        );
    }

    #[test]
    fn sweeps_the_legacy_directory_and_removes_it_once_empty() {
        let app_data_dir = tempdir().unwrap();
        let gone = dead_pid();
        let legacy_dir = app_data_dir.path().join(LEGACY_DISCOVERY_DIR_NAME);
        let dead = write_discovery_file_in(
            app_data_dir.path(),
            LEGACY_DISCOVERY_DIR_NAME,
            &format!("control-{gone}.json"),
        );
        let dead_tmp = write_discovery_file_in(
            app_data_dir.path(),
            LEGACY_DISCOVERY_DIR_NAME,
            &format!("control-{gone}.json.tmp"),
        );

        sweep_stale_discovery_files(app_data_dir.path());

        assert!(!dead.exists());
        assert!(!dead_tmp.exists());
        assert!(!legacy_dir.exists(), "the emptied legacy directory goes");
        assert!(
            !app_data_dir.path().join(DISCOVERY_DIR_NAME).exists(),
            "the sweep creates nothing"
        );
    }

    #[test]
    fn keeps_the_legacy_directory_while_something_still_lives_in_it() {
        let app_data_dir = tempdir().unwrap();
        let legacy_dir = app_data_dir.path().join(LEGACY_DISCOVERY_DIR_NAME);
        let live = write_discovery_file_in(
            app_data_dir.path(),
            LEGACY_DISCOVERY_DIR_NAME,
            &format!("control-{}.json", live_pid()),
        );

        sweep_stale_discovery_files(app_data_dir.path());

        assert!(live.exists(), "a running old-build instance keeps its file");
        assert!(legacy_dir.exists());

        std::fs::remove_file(&live).unwrap();
        let unrelated =
            write_discovery_file_in(app_data_dir.path(), LEGACY_DISCOVERY_DIR_NAME, "notes.json");

        sweep_stale_discovery_files(app_data_dir.path());

        assert!(unrelated.exists(), "only discovery files are swept");
        assert!(legacy_dir.exists(), "a non-empty directory stays");
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
