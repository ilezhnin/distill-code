//! Where everything Distill owns lives, in one folder.
//!
//! The operator's requirement is simple to state and the whole point of this
//! module: archive one folder, unpack it on another machine, and have
//! everything back. This module decides what that path is and creates it.
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
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// The single root registered before any app-owned store starts.
pub fn app_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.try_state::<crate::commands::distill_store::DistillRootState>()
        .map(|state| state.root.clone())
        .ok_or_else(|| "Distill root is not initialized".to_string())
}

/// Overrides the pointer file and the default. Absolute paths only.
pub const DISTILL_ROOT_ENV: &str = "DISTILL_ROOT";

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
pub fn resolve_root(env_value: Option<&str>, os_config_dir: &Path, home_dir: &Path) -> PathBuf {
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
/// Deliberately not applied to the running process: half the app pointing at
/// a new root while the other half still holds the old one is the kind of
/// split the whole module exists to prevent. The caller tells the operator to
/// restart.
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
    fs::write(
        pointer_file(os_config_dir),
        root.to_string_lossy().as_bytes(),
    )
    .map_err(|error| format!("Cannot record the root: {error}"))
}

/// Creates the root and the folders the app expects inside it.
pub fn ensure_root_layout(root: &Path) -> Result<(), String> {
    for sub in [
        "projects",
        "state",
        "agents",
        "skills",
        "sessions",
        "cache",
        "artifacts",
        "conductor",
        "runs",
    ] {
        fs::create_dir_all(root.join(sub))
            .map_err(|error| format!("Cannot create '{}': {error}", root.join(sub).display()))?;
    }
    for (relative, contents) in [
        ("settings.json", "{}\n"),
        ("cache/README.md", "# Cache\n\nRegenerable downloads and runtime assets. Exclude this folder from backups.\n"),
    ] {
        create_missing_file(&root.join(relative), contents)?;
    }
    Ok(())
}

/// Never replace operator content, including an intentionally empty file.
pub fn create_missing_file(path: &Path, contents: &str) -> Result<(), String> {
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => file
            .write_all(contents.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("Cannot initialize '{}': {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(format!("Cannot initialize '{}': {error}", path.display())),
    }
}

pub fn ensure_project_layout(project: &Path) -> Result<(), String> {
    if !project.is_absolute() || !project.is_dir() {
        return Err(format!(
            "Project folder does not exist: {}",
            project.display()
        ));
    }
    let root = project.join(".distill");
    for sub in ["agents", "skills", "wiki"] {
        fs::create_dir_all(root.join(sub)).map_err(|error| error.to_string())?;
    }
    create_missing_file(&root.join("settings.json"), "{}\n")?;
    let _ = crate::commands::project_store::exclude_agent_folders(project);
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
    fn startup_creates_only_app_data_and_preserves_custom_files() {
        let dir = tempfile::tempdir().unwrap();
        ensure_root_layout(dir.path()).unwrap();
        let mut names = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(
            names,
            [
                "agents",
                "artifacts",
                "cache",
                "conductor",
                "projects",
                "runs",
                "sessions",
                "settings.json",
                "skills",
                "state",
            ]
        );
        fs::write(dir.path().join("custom-notes.md"), "My content").unwrap();
        fs::write(dir.path().join("empty-notes.md"), "").unwrap();
        fs::write(dir.path().join("settings.json"), "{\"locale\":\"es\"}").unwrap();
        ensure_root_layout(dir.path()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("custom-notes.md")).unwrap(),
            "My content"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("empty-notes.md")).unwrap(),
            ""
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("settings.json")).unwrap(),
            "{\"locale\":\"es\"}"
        );
    }

    #[test]
    fn project_layout_contains_only_app_data_and_preserves_overrides() {
        let dir = tempfile::tempdir().unwrap();
        ensure_project_layout(dir.path()).unwrap();
        let context = dir.path().join(".distill");
        let mut names = fs::read_dir(&context)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, ["agents", "settings.json", "skills", "wiki"]);
        fs::write(
            context.join("settings.json"),
            "{\"style-guidelines\":\"Local\"}",
        )
        .unwrap();
        fs::write(context.join("custom-notes.md"), "Project notes").unwrap();
        ensure_project_layout(dir.path()).unwrap();
        assert_eq!(
            fs::read_to_string(context.join("settings.json")).unwrap(),
            "{\"style-guidelines\":\"Local\"}"
        );
        assert_eq!(
            fs::read_to_string(context.join("custom-notes.md")).unwrap(),
            "Project notes"
        );
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
        let resolved = resolve_root(Some(forced.to_str().unwrap()), &config, &base.join("home"));
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
