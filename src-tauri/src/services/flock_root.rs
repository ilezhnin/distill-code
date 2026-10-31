//! Where everything Flock owns lives, in one folder.
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
//! Precedence is env var, then pointer file, then the folder in the home
//! directory: `~/.flock`, or `~/.distill` when an install upgraded from
//! Distill still has one and no `~/.flock`. The env var comes first so a test,
//! a second install or a portable run can redirect everything without
//! touching the user's real setup. The upgraded install's folder is adopted
//! in place — nothing is moved — and the first start records it in the
//! pointer file, so every later start takes the pointer.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// The single root registered before any app-owned store starts.
pub fn app_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.try_state::<crate::commands::flock_store::FlockRootState>()
        .map(|state| state.root.clone())
        .ok_or_else(|| "Flock root is not initialized".to_string())
}

/// Overrides the pointer file and the default. Absolute paths only.
pub const FLOCK_ROOT_ENV: &str = "FLOCK_ROOT";
/// The spelling a machine set up for Distill may still export. Read after
/// [`FLOCK_ROOT_ENV`], never written.
pub const LEGACY_ROOT_ENV: &str = "DISTILL_ROOT";

const POINTER_FILE_NAME: &str = "root-path";
/// The folder a fresh install gets in the home directory.
pub(crate) const DEFAULT_ROOT_DIR_NAME: &str = ".flock";
/// The folder an install upgraded from Distill keeps.
const LEGACY_ROOT_DIR_NAME: &str = ".distill";

/// The root the environment forces, if any: the first non-blank of
/// [`FLOCK_ROOT_ENV`] and [`LEGACY_ROOT_ENV`]. The one place that reads
/// either variable; every "is the root forced" decision goes through here so
/// the two spellings cannot disagree.
pub fn root_override() -> Option<String> {
    [FLOCK_ROOT_ENV, LEGACY_ROOT_ENV]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|value| !value.trim().is_empty())
}

/// Whether this start may adopt an older install's data (its legacy stores,
/// its sessions, its goose projects). Never in an isolated E2E run, which
/// starts from nothing, and never when the environment forced the root: a
/// portable run or a test must not pull the operator's old data into its
/// own folder.
pub fn adoption_enabled(isolated_e2e: bool, root_override: Option<&str>) -> bool {
    !isolated_e2e && root_override.is_none()
}

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
/// `env_value` is what [`root_override`] returned; it, `home_dir` and
/// `os_config_dir` are arguments rather than looked up here so the resolution
/// order is testable without touching the machine's real home.
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
    // No pointer yet: a first start. A `.flock` folder is this app's own;
    // failing that, the folder Distill left behind is adopted where it is.
    let default = home_dir.join(DEFAULT_ROOT_DIR_NAME);
    if default.is_dir() {
        return default;
    }
    let legacy = home_dir.join(LEGACY_ROOT_DIR_NAME);
    if legacy.is_dir() {
        return legacy;
    }
    default
}

/// The root this process resolved at startup, for the records that name a
/// file inside it by an absolute path.
static CURRENT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Registers the root this process resolved; the first registration wins.
pub fn register_current(root: &Path) {
    let _ = CURRENT.set(root.to_path_buf());
}

/// [`relocate`] against the root this process resolved, or `recorded`
/// unchanged before one is registered.
pub fn relocated(recorded: &Path) -> PathBuf {
    match CURRENT.get() {
        Some(root) => relocate(recorded, root),
        None => recorded.to_path_buf(),
    }
}

/// Where `recorded`, an absolute path some record kept inside an earlier
/// location of the Flock folder, is now.
///
/// The folder can be copied to another machine or Windows account and work
/// there (the point of this module), but a record may name a file in it by
/// the absolute path it had then, in a home that no longer exists. A path
/// that still exists is kept. Otherwise its longest tail of two or more
/// components that exists under `root` names the same file in the copy:
/// `C:\Users\old\.distill\benchmark-tasks\snapshots.git` becomes
/// `<root>\benchmark-tasks\snapshots.git`. Without such a tail the recorded
/// path comes back unchanged, and opening it reports what is missing. A
/// caller that reads content back checks it against the record's own hash.
pub fn relocate(recorded: &Path, root: &Path) -> PathBuf {
    if !recorded.is_absolute() || recorded.exists() {
        return recorded.to_path_buf();
    }
    let parts: Vec<&std::ffi::OsStr> = recorded
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect();
    (0..parts.len().saturating_sub(1))
        .map(|start| {
            parts[start..]
                .iter()
                .fold(root.to_path_buf(), |path, part| path.join(part))
        })
        .find(|candidate| candidate.exists())
        .unwrap_or_else(|| recorded.to_path_buf())
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
    let probe = root.join(".flock-write-probe");
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
    reject_document_links(project, &root)?;
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
        return Err("Document path must be relative to the Flock root".into());
    }
    let mut resolved = root.to_path_buf();
    for component in candidate.components() {
        match component {
            std::path::Component::Normal(part) => resolved.push(part),
            std::path::Component::CurDir => {}
            _ => return Err("Document path must not leave the Flock root".into()),
        }
    }
    if resolved.extension().and_then(|ext| ext.to_str()) != Some("json") {
        return Err("Only .json documents are stored here".into());
    }
    reject_document_links(root, &resolved)?;
    Ok(resolved)
}

/// Check existing components too: lexical containment alone follows a junction
/// or symlink into another folder. Missing descendants are safe to create.
pub fn reject_document_links(root: &Path, target: &Path) -> Result<(), String> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "Document is outside its store")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                #[cfg(windows)]
                let linked = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let linked = metadata.file_type().is_symlink();
                if linked {
                    return Err("Document path crosses a link or junction".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("Cannot inspect document path: {error}")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_recorded_in_a_copied_folder_resolves_in_the_copy() {
        let machine = tempfile::tempdir().unwrap();
        let old = machine.path().join("Users/old/.distill");
        let root = machine.path().join("Users/new/.flock");
        let store = root.join("benchmark-tasks/snapshots.git");
        fs::create_dir_all(&store).unwrap();
        let preview = root.join("benchmarks/evaluations/e1/preview.png");
        fs::create_dir_all(preview.parent().unwrap()).unwrap();
        fs::write(&preview, b"png").unwrap();
        assert_eq!(
            relocate(&old.join("benchmark-tasks/snapshots.git"), &root),
            store
        );
        assert_eq!(
            relocate(&old.join("benchmarks/evaluations/e1/preview.png"), &root),
            preview
        );
    }

    #[test]
    fn an_existing_or_unknown_path_is_kept_as_recorded() {
        let machine = tempfile::tempdir().unwrap();
        let root = machine.path().join("flock");
        let elsewhere = machine.path().join("checkouts/task/repo");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir_all(root.join("checkouts/task/repo")).unwrap();
        // A path that still exists is never redirected into the root.
        assert_eq!(relocate(&elsewhere, &root), elsewhere);
        let gone = machine.path().join("old/benchmark-tasks/missing.git");
        assert_eq!(relocate(&gone, &root), gone);
        // A lone file name is no evidence of the same file.
        fs::write(root.join("snapshots.git"), b"").unwrap();
        let lone = machine.path().join("old/snapshots.git");
        assert_eq!(relocate(&lone, &root), lone);
        assert_eq!(
            relocate(Path::new("relative/path"), &root),
            Path::new("relative/path")
        );
    }

    #[cfg(windows)]
    #[test]
    fn document_resolvers_reject_junctions_outside_the_store() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = root.path().join(".distill");
        let script = format!(
            "New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null",
            link.display(),
            outside.path().display()
        );
        assert!(std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &script])
            .status()
            .unwrap()
            .success());
        fs::write(outside.path().join("memory.json"), "original").unwrap();
        assert!(ensure_project_layout(root.path()).is_err());
        assert!(!outside.path().join("settings.json").exists());
        assert!(resolve_document_path(root.path(), ".distill/memory.json").is_err());
        assert!(resolve_document_path(root.path(), ".distill/new/file.json").is_err());
        assert!(
            crate::commands::project_store::resolve_project_document_path(
                root.path(),
                "memory.json"
            )
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(outside.path().join("memory.json")).unwrap(),
            "original"
        );
        // Remove only the junction itself; never recurse into its target.
        fs::remove_dir(&link).unwrap();
    }

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
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
        let dir = temp();
        let base = dir.path();
        let config = base.join("config");
        let chosen = base.join("elsewhere");
        write_root_pointer(&config, &chosen).unwrap();

        assert_eq!(resolve_root(None, &config, &base.join("home")), chosen);
    }

    #[test]
    fn the_environment_wins_over_the_pointer_file() {
        // A portable run or a second install must be able to redirect
        // everything without disturbing the operator's real setup.
        let dir = temp();
        let base = dir.path();
        let config = base.join("config");
        write_root_pointer(&config, &base.join("pointed")).unwrap();

        let forced = base.join("forced");
        let resolved = resolve_root(Some(forced.to_str().unwrap()), &config, &base.join("home"));
        assert_eq!(resolved, forced);
    }

    #[test]
    fn a_relative_or_blank_override_is_ignored() {
        let dir = temp();
        let base = dir.path();
        let home = base.join("home");
        for value in ["", "   ", "relative/path"] {
            assert_eq!(
                resolve_root(Some(value), &base.join("config"), &home),
                home.join(".flock"),
            );
        }
    }

    /// Nothing recorded and nothing on disk: the fresh-install default. It
    /// is not created here; `initialize` does that and records it.
    #[test]
    fn a_fresh_install_gets_the_flock_folder_without_a_pointer() {
        let dir = temp();
        let base = dir.path();
        let home = base.join("home");
        let config = base.join("config");
        fs::create_dir_all(&home).unwrap();

        assert_eq!(resolve_root(None, &config, &home), home.join(".flock"));
        assert!(!pointer_file(&config).exists());
        assert!(!home.join(".flock").exists());
    }

    /// An install upgraded from Distill has a `~/.distill` and no pointer
    /// (older builds wrote one, but a machine restored from a backup of the
    /// folder alone has none): the folder is adopted where it is.
    #[test]
    fn an_upgraded_install_keeps_its_distill_folder() {
        let dir = temp();
        let base = dir.path();
        let home = base.join("home");
        let config = base.join("config");
        let legacy = home.join(LEGACY_ROOT_DIR_NAME);
        fs::create_dir_all(&legacy).unwrap();

        assert_eq!(resolve_root(None, &config, &home), legacy);
        assert!(!home.join(".flock").exists());
    }

    #[test]
    fn the_flock_folder_wins_when_both_folders_exist() {
        let dir = temp();
        let base = dir.path();
        let home = base.join("home");
        fs::create_dir_all(home.join(".distill")).unwrap();
        fs::create_dir_all(home.join(".flock")).unwrap();

        assert_eq!(
            resolve_root(None, &base.join("config"), &home),
            home.join(".flock")
        );
    }

    /// A file named like the folder is not the folder.
    #[test]
    fn only_a_directory_counts_as_an_existing_root() {
        let dir = temp();
        let base = dir.path();
        let home = base.join("home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join(".distill"), b"not a folder").unwrap();

        assert_eq!(
            resolve_root(None, &base.join("config"), &home),
            home.join(".flock")
        );
    }

    /// The pointer wins over an existing `~/.distill`: once recorded, a
    /// chosen root is never second-guessed by what else the home holds.
    #[test]
    fn the_pointer_file_wins_over_the_upgraded_folder() {
        let dir = temp();
        let base = dir.path();
        let home = base.join("home");
        let config = base.join("config");
        fs::create_dir_all(home.join(".distill")).unwrap();
        let chosen = base.join("elsewhere");
        write_root_pointer(&config, &chosen).unwrap();

        assert_eq!(resolve_root(None, &config, &home), chosen);
    }

    /// The names a Distill install left behind, spelled out of pieces so a
    /// rename sweeping the sources cannot change what this build looks for.
    #[test]
    fn the_legacy_names_are_the_ones_distill_used() {
        assert_eq!(LEGACY_ROOT_DIR_NAME, [".dis", "till"].concat());
        assert_eq!(LEGACY_ROOT_ENV, ["DIS", "TILL", "_ROOT"].concat());
        assert_eq!(DEFAULT_ROOT_DIR_NAME, ".flock");
        assert_eq!(FLOCK_ROOT_ENV, "FLOCK_ROOT");
    }

    fn with_root_variables<T>(
        flock: Option<&str>,
        legacy: Option<&str>,
        check: impl FnOnce() -> T,
    ) -> T {
        let _guard = crate::test_support::env_lock().lock().expect("env lock");
        let saved: Vec<_> = [FLOCK_ROOT_ENV, LEGACY_ROOT_ENV]
            .into_iter()
            .map(|name| (name, std::env::var_os(name)))
            .collect();
        // SAFETY: this test holds the crate-wide environment lock, and the
        // variables are restored before it is released.
        unsafe {
            for (name, value) in [(FLOCK_ROOT_ENV, flock), (LEGACY_ROOT_ENV, legacy)] {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
        let result = check();
        // SAFETY: as above.
        unsafe {
            for (name, value) in saved {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
        result
    }

    /// `DISTILL_ROOT` alone still forces the root: a machine set up for
    /// Distill keeps working. It is honoured over the pointer and the home
    /// folders, the pointer is not written for it, and nothing is adopted.
    #[test]
    fn the_distill_root_variable_alone_still_forces_the_root() {
        let dir = temp();
        let base = dir.path();
        let home = base.join("home");
        let config = base.join("config");
        fs::create_dir_all(home.join(".distill")).unwrap();
        write_root_pointer(&config, &base.join("pointed")).unwrap();
        let forced = base.join("forced");

        let override_value =
            with_root_variables(None, Some(forced.to_str().unwrap()), root_override);
        assert_eq!(override_value.as_deref(), forced.to_str());
        assert_eq!(
            resolve_root(override_value.as_deref(), &config, &home),
            forced
        );
        assert!(!adoption_enabled(false, override_value.as_deref()));
        assert_eq!(
            fs::read_to_string(pointer_file(&config)).unwrap(),
            base.join("pointed").to_string_lossy()
        );
    }

    #[test]
    fn the_flock_root_variable_is_read_first_and_blank_values_do_not_count() {
        assert_eq!(
            with_root_variables(Some(r"C:\new"), Some(r"C:\old"), root_override).as_deref(),
            Some(r"C:\new")
        );
        assert_eq!(
            with_root_variables(Some("  "), Some(r"C:\old"), root_override).as_deref(),
            Some(r"C:\old")
        );
        assert_eq!(with_root_variables(Some(""), Some(""), root_override), None);
        assert_eq!(with_root_variables(None, None, root_override), None);
    }

    #[test]
    fn adoption_runs_only_for_an_ordinary_start_with_an_unforced_root() {
        assert!(adoption_enabled(false, None));
        assert!(!adoption_enabled(true, None));
        assert!(!adoption_enabled(false, Some(r"C:\forced")));
        assert!(!adoption_enabled(true, Some(r"C:\forced")));
    }

    #[test]
    fn document_paths_stay_inside_the_root() {
        let dir = temp();
        let root = dir.path();
        assert!(resolve_document_path(root, "planner.json").is_ok());
        assert_eq!(
            resolve_document_path(root, "projects/site/planner.json").unwrap(),
            root.join("projects").join("site").join("planner.json")
        );

        for escape in ["../outside.json", "projects/../../outside.json"] {
            assert!(resolve_document_path(root, escape).is_err(), "{escape}");
        }
        assert!(resolve_document_path(root, "/etc/passwd.json").is_err());
        assert!(resolve_document_path(root, "notes.txt").is_err());
    }
}
