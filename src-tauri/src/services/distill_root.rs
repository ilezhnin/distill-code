//! Where everything Distill owns lives, in one folder.
//!
//! The operator's requirement is simple to state and the whole point of this
//! module: archive one folder, unpack it on another machine, and have
//! everything back. Before this, the pieces were scattered by the operating
//! system's conventions — goose put config, data and state in three different
//! places under `Block/goose`, and the app kept its own database somewhere
//! else again. Backing that up meant knowing all of it.
//!
//! One root fixes it, because goose already supports being told where to
//! live: `GOOSE_PATH_ROOT` moves its config, data, state, agents and plugins
//! under one absolute path. This module decides what that path is, creates
//! it, and hands it to the goose child.
//!
//! ## The bootstrap problem
//!
//! The setting that says where everything lives cannot itself live there —
//! nothing would know where to look. So exactly one thing stays outside: a
//! pointer file in the OS config directory holding the chosen path. It is the
//! only file this app writes outside the root, it is one line long, and
//! losing it costs nothing but a re-pick: the data it points at is untouched.
//!
//! Precedence is env var, then pointer file, then `~/.distill`. The env var
//! comes first so a test, a second install or a portable run can redirect
//! everything without touching the user's real setup.

use std::fs;
use std::path::{Path, PathBuf};

/// Overrides the pointer file and the default. Absolute paths only.
pub const DISTILL_ROOT_ENV: &str = "DISTILL_ROOT";

/// Handed to the goose child so its own directories land under our root.
pub const GOOSE_PATH_ROOT_ENV: &str = "GOOSE_PATH_ROOT";

const POINTER_FILE_NAME: &str = "root-path";
const DEFAULT_ROOT_DIR_NAME: &str = ".distill";

/// Where the pointer file lives — the one thing outside the root.
fn pointer_file(os_config_dir: &Path) -> PathBuf {
    os_config_dir.join(POINTER_FILE_NAME)
}

fn absolute(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    path.is_absolute().then_some(path)
}

/// The chosen root, without creating anything.
///
/// `home_dir` and `os_config_dir` are arguments rather than looked up here so
/// the resolution order is testable without touching the machine's real home.
pub fn resolve_root(
    env_value: Option<&str>,
    os_config_dir: &Path,
    home_dir: &Path,
) -> PathBuf {
    if let Some(from_env) = env_value.and_then(absolute) {
        return from_env;
    }
    if let Some(from_pointer) = fs::read_to_string(pointer_file(os_config_dir))
        .ok()
        .as_deref()
        .and_then(absolute)
    {
        return from_pointer;
    }
    home_dir.join(DEFAULT_ROOT_DIR_NAME)
}

/// Records a new root for the next start. Does not move existing data.
///
/// Deliberately not applied to the running process: goose reads
/// `GOOSE_PATH_ROOT` once, at spawn, and half the app pointing at a new root
/// while the other half still holds the old one is the kind of split the
/// whole module exists to prevent. The caller tells the operator to restart.
pub fn write_root_pointer(os_config_dir: &Path, root: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err(format!("Root must be an absolute path: {}", root.display()));
    }
    fs::create_dir_all(root)
        .map_err(|error| format!("Cannot create '{}': {error}", root.display()))?;
    // Proven writable before it is recorded: a pointer to a read-only or
    // vanished path would break every start until someone edited it by hand.
    let probe = root.join(".distill-write-probe");
    fs::write(&probe, b"")
        .map_err(|error| format!("Cannot write into '{}': {error}", root.display()))?;
    let _ = fs::remove_file(&probe);

    fs::create_dir_all(os_config_dir)
        .map_err(|error| format!("Cannot create config dir: {error}"))?;
    fs::write(pointer_file(os_config_dir), root.to_string_lossy().as_bytes())
        .map_err(|error| format!("Cannot record the root: {error}"))
}

/// Creates the root and the folders the app expects inside it.
pub fn ensure_root_layout(root: &Path) -> Result<(), String> {
    for sub in ["projects", "state"] {
        fs::create_dir_all(root.join(sub))
            .map_err(|error| format!("Cannot create '{}': {error}", root.join(sub).display()))?;
    }
    Ok(())
}

/// Resolves a caller-supplied relative path against the root.
///
/// The renderer names documents, so it can name `../../.ssh/id_rsa` too. The
/// check is on the *lexical* path rather than a canonicalized one because the
/// file usually does not exist yet, and it rejects absolute paths, parent
/// traversal and anything that is not plain JSON.
pub fn resolve_document_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(relative);
    if candidate.is_absolute() {
        return Err("Document path must be relative to the Distill root".into());
    }
    let mut resolved = root.to_path_buf();
    for component in candidate.components() {
        match component {
            std::path::Component::Normal(part) => resolved.push(part),
            std::path::Component::CurDir => {}
            _ => return Err("Document path must not leave the Distill root".into()),
        }
    }
    if resolved.extension().and_then(|ext| ext.to_str()) != Some("json") {
        return Err("Only .json documents are stored here".into());
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("distill-root-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn falls_back_to_a_dot_folder_in_home() {
        let base = temp();
        let root = resolve_root(None, &base.join("config"), &base.join("home"));
        assert_eq!(root, base.join("home").join(".distill"));
    }

    #[test]
    fn the_pointer_file_wins_over_the_default() {
        let base = temp();
        let config = base.join("config");
        let chosen = base.join("elsewhere");
        write_root_pointer(&config, &chosen).unwrap();

        assert_eq!(resolve_root(None, &config, &base.join("home")), chosen);
    }

    #[test]
    fn the_environment_wins_over_the_pointer_file() {
        // A portable run or a second install must be able to redirect
        // everything without disturbing the operator's real setup.
        let base = temp();
        let config = base.join("config");
        write_root_pointer(&config, &base.join("pointed")).unwrap();

        let forced = base.join("forced");
        let resolved = resolve_root(
            Some(forced.to_str().unwrap()),
            &config,
            &base.join("home"),
        );
        assert_eq!(resolved, forced);
    }

    #[test]
    fn a_relative_or_blank_override_is_ignored() {
        let base = temp();
        let home = base.join("home");
        for value in ["", "   ", "relative/path"] {
            assert_eq!(
                resolve_root(Some(value), &base.join("config"), &home),
                home.join(".distill"),
            );
        }
    }

    #[test]
    fn a_root_that_cannot_be_written_is_not_recorded() {
        let base = temp();
        let config = base.join("config");
        assert!(write_root_pointer(&config, Path::new("relative")).is_err());
        assert!(!pointer_file(&config).exists());
    }

    #[test]
    fn document_paths_stay_inside_the_root() {
        let root = temp();
        assert!(resolve_document_path(&root, "planner.json").is_ok());
        assert_eq!(
            resolve_document_path(&root, "projects/site/planner.json").unwrap(),
            root.join("projects").join("site").join("planner.json")
        );

        for escape in ["../outside.json", "projects/../../outside.json"] {
            assert!(resolve_document_path(&root, escape).is_err(), "{escape}");
        }
        assert!(resolve_document_path(&root, "/etc/passwd.json").is_err());
        assert!(resolve_document_path(&root, "notes.txt").is_err());
    }
}
