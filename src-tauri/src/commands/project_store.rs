//! A project's own `.distill` folder: overrides and additions that travel with
//! the project rather than with the machine.
//!
//! The global root (`distill_store`) holds what belongs to the operator: their
//! agents, their skills, their memory, the conductor's state. That is the
//! right home for almost all of it and the wrong home for the part that is
//! about one piece of work. An agent written for a repository, an instruction
//! that only makes sense inside it, and everything the app remembered while
//! working on it should move when the folder moves and should not follow the
//! operator into an unrelated project.
//!
//! Same shape as the global store and for the same reasons: the renderer names
//! a relative path and gets text, and where that can land is decided here. The
//! resolved path is always inside `<project>/.distill`, so a renderer that
//! asks for `../../.ssh/id_rsa` is refused rather than obeyed. Two extensions
//! are allowed instead of the global store's one — `.json` for state and `.md`
//! for the things a person is meant to read and edit, which is most of what a
//! project override actually is.

use std::fs;
use std::path::{Path, PathBuf};

/// The folder a project's own documents live in, inside the project.
pub const PROJECT_STORE_DIR: &str = ".distill";

/// Folders this tool creates in someone else's repository.
///
/// Listed together because they are excluded together: an operator who never
/// asked to version any of them should not have to notice them one at a time.
const AGENT_FOLDERS: [&str; 3] = [".distill/", ".codex/", ".claude/"];

/// Resolves a caller-supplied relative path inside a project's store.
///
/// The check is lexical rather than canonical because the file usually does
/// not exist yet. It rejects absolute paths, parent traversal, and anything
/// that is not a JSON document or a Markdown one.
pub fn resolve_project_document_path(
    project_root: &Path,
    relative: &str,
) -> Result<PathBuf, String> {
    if !project_root.is_absolute() {
        return Err("Project path must be absolute".into());
    }
    let candidate = Path::new(relative);
    if candidate.is_absolute() {
        return Err("Document path must be relative to the project store".into());
    }
    let mut resolved = project_root.join(PROJECT_STORE_DIR);
    for component in candidate.components() {
        match component {
            std::path::Component::Normal(part) => resolved.push(part),
            std::path::Component::CurDir => {}
            _ => return Err("Document path must not leave the project store".into()),
        }
    }
    match resolved.extension().and_then(|ext| ext.to_str()) {
        Some("json") | Some("md") => Ok(resolved),
        _ => Err("Only .json and .md documents are stored here".into()),
    }
}

/// Reads one of a project's documents. A document never written is `None`.
///
/// `async` + `spawn_blocking` and the shared size cap, for the reasons given on
/// `distill_store::read_distill_document` and
/// `distill_store::MAX_DOCUMENT_BYTES` — a project `.md` in particular can be
/// replaced out-of-band by something arbitrarily large.
#[tauri::command]
pub async fn read_project_document(
    project_root: String,
    path: String,
) -> Result<Option<String>, String> {
    let target = resolve_project_document_path(Path::new(project_root.trim()), &path)?;
    tokio::task::spawn_blocking(move || super::distill_store::read_document_capped(&target))
        .await
        .map_err(|error| format!("Cannot read '{path}': {error}"))?
}

/// Writes one of a project's documents, atomically.
///
/// Temporary file then rename, so a crash mid-write leaves the previous
/// version rather than half of the new one. The first write into a project
/// also arranges for git to ignore what this tool creates there; see
/// `exclude_agent_folders`.
///
/// `async` + `spawn_blocking`: the write ends in an `fsync`, which must not run
/// on the UI thread. See `distill_store::write_distill_document`.
///
/// CONTRACT: **the caller must serialise its writes per path**, for the reason
/// spelled out on `distill_store::write_distill_document` — an `async` command is
/// spawned rather than run in IPC message order, so two writes of one document in
/// flight at once can land older-last.
#[tauri::command]
pub async fn write_project_document(
    project_root: String,
    path: String,
    contents: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        write_project_document_blocking(project_root, path, contents)
    })
    .await
    .map_err(|error| format!("Cannot write the project document: {error}"))?
}

fn write_project_document_blocking(
    project_root: String,
    path: String,
    contents: String,
) -> Result<(), String> {
    let root = PathBuf::from(project_root.trim());
    let target = resolve_project_document_path(&root, &path)?;
    let store = root.join(PROJECT_STORE_DIR);
    let is_first_write = !store.exists();
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create '{}': {error}", parent.display()))?;
    }
    if is_first_write {
        // Best-effort by design: a project that is not a repository, or one
        // whose `.git` we cannot write, must still get its documents.
        let _ = exclude_agent_folders(&root);
    }
    let temporary = target.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    super::distill_store::write_file_synced(&temporary, contents.as_bytes())
        .map_err(|error| format!("Cannot write '{}': {error}", temporary.display()))?;
    match fs::rename(&temporary, &target) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(format!("Cannot replace '{}': {error}", target.display()))
        }
    }
}

/// Names of the documents directly inside one of a project's store folders.
///
/// Sorted, files only, and never recursive: the callers list a folder of
/// agents or of memory documents, and a caller that wants a subfolder asks for
/// it by name.
///
/// `async` + `spawn_blocking`: a `read_dir` of an unbounded folder on a slow or
/// network drive must not run on the UI thread.
#[tauri::command]
pub async fn list_project_documents(
    project_root: String,
    path: String,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || list_project_documents_blocking(project_root, path))
        .await
        .map_err(|error| format!("Cannot list the project documents: {error}"))?
}

fn list_project_documents_blocking(
    project_root: String,
    path: String,
) -> Result<Vec<String>, String> {
    let root = PathBuf::from(project_root.trim());
    if !root.is_absolute() {
        return Err("Project path must be absolute".into());
    }
    let mut target = root.join(PROJECT_STORE_DIR);
    for component in Path::new(path.trim()).components() {
        match component {
            std::path::Component::Normal(part) => target.push(part),
            std::path::Component::CurDir => {}
            _ => return Err("Document path must not leave the project store".into()),
        }
    }
    let entries = match fs::read_dir(&target) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot list '{}': {error}", target.display())),
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| entry.file_name().to_str().map(|name| name.to_string()))
        .filter(|name| name.ends_with(".json") || name.ends_with(".md"))
        .collect();
    names.sort();
    Ok(names)
}

/// Where a run's closeout is written, inside the project.
///
/// Deliberately outside `.distill`, and the only thing this module writes
/// there. `.distill` is excluded from git on purpose — it is this tool's own
/// state and does not belong in someone's history — but a closeout is the
/// opposite kind of file: a short record of what a request changed and why,
/// meant to be read by a person in six months and therefore meant to be
/// committed with the work it describes. A folder of tool state that git
/// ignores cannot serve that, so the closeout lives beside the project's own
/// documentation and is committed like any other file.
pub const PROJECT_RUNS_DIR: &str = "docs/runs";

/// Writes one run closeout into `docs/runs/`.
///
/// `name` is a file name and nothing else: no separators, no traversal, and
/// `.md` enforced. A narrow command rather than a general file write, because
/// "the app may write anywhere in your repository" is not a capability this
/// tool should have for the sake of one feature.
///
/// `async` + `spawn_blocking`: the write ends in an `fsync`, which must not run
/// on the UI thread. See `distill_store::write_distill_document`.
#[tauri::command]
pub async fn write_project_run_closeout(
    project_root: String,
    name: String,
    contents: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        write_project_run_closeout_blocking(project_root, name, contents)
    })
    .await
    .map_err(|error| format!("Cannot write the run closeout: {error}"))?
}

fn write_project_run_closeout_blocking(
    project_root: String,
    name: String,
    contents: String,
) -> Result<String, String> {
    let root = PathBuf::from(project_root.trim());
    if !root.is_absolute() {
        return Err("Project path must be absolute".into());
    }
    let file = name.trim();
    if file.is_empty()
        || file.contains('/')
        || file.contains('\\')
        || file.contains("..")
        || file.contains(':')
        || !file.ends_with(".md")
    {
        return Err("A closeout file name must be a plain '.md' name".into());
    }
    // `docs/runs/CON.md` addresses the console device rather than a document.
    crate::services::windows_names::reject_unusable_windows_name(file, "A closeout file name")?;
    let dir = PROJECT_RUNS_DIR
        .split('/')
        .fold(root.clone(), |path, part| path.join(part));
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Cannot create '{}': {error}", dir.display()))?;
    let target = dir.join(file);
    let temporary = target.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    super::distill_store::write_file_synced(&temporary, contents.as_bytes())
        .map_err(|error| format!("Cannot write '{}': {error}", temporary.display()))?;
    match fs::rename(&temporary, &target) {
        Ok(()) => Ok(target.to_string_lossy().to_string()),
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(format!("Cannot replace '{}': {error}", target.display()))
        }
    }
}

/// Tells this project's git to ignore what agent tools leave in it.
///
/// `.git/info/exclude` and deliberately not `.gitignore`: the second is a
/// tracked file belonging to whoever owns the repository, and editing it is a
/// change to their project that they would have to review, revert, or explain
/// to their colleagues. `info/exclude` has the same effect for this checkout
/// and belongs to the person using it.
///
/// Idempotent, and additive: an entry already present is left alone, and
/// nothing that was in the file is removed or reordered.
pub fn exclude_agent_folders(project_root: &Path) -> Result<bool, String> {
    let git_dir = project_root.join(".git");
    if !git_dir.is_dir() {
        // A worktree's `.git` is a file pointing elsewhere, and a plain folder
        // is not a repository at all. Both are "nothing to exclude here".
        return Ok(false);
    }
    let info = git_dir.join("info");
    fs::create_dir_all(&info)
        .map_err(|error| format!("Cannot create '{}': {error}", info.display()))?;
    let exclude = info.join("exclude");
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    let already: Vec<&str> = existing.lines().map(|line| line.trim()).collect();
    let missing: Vec<&str> = AGENT_FOLDERS
        .iter()
        .copied()
        .filter(|folder| !already.contains(folder))
        .collect();
    if missing.is_empty() {
        return Ok(false);
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("\n# Added by Distill: folders agent tools keep their own state in.\n");
    for folder in missing {
        next.push_str(folder);
        next.push('\n');
    }
    fs::write(&exclude, next)
        .map_err(|error| format!("Cannot write '{}': {error}", exclude.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("distill-project-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn refuses_to_leave_the_store() {
        let root = temp();
        assert!(resolve_project_document_path(&root, "../secrets.json").is_err());
        assert!(resolve_project_document_path(&root, "/etc/passwd").is_err());
        assert!(resolve_project_document_path(&root, "notes.txt").is_err());
    }

    #[test]
    fn excludes_agent_folders_once_and_leaves_the_rest_alone() {
        let root = temp();
        let info = root.join(".git").join("info");
        fs::create_dir_all(&info).unwrap();
        fs::write(info.join("exclude"), "# theirs\nbuild/\n").unwrap();

        assert!(exclude_agent_folders(&root).unwrap());
        let written = fs::read_to_string(info.join("exclude")).unwrap();
        assert!(written.starts_with("# theirs\nbuild/\n"));
        assert!(written.contains(".distill/"));
        assert!(written.contains(".claude/"));

        // Second call has nothing to add and must not append again.
        assert!(!exclude_agent_folders(&root).unwrap());
        assert_eq!(
            fs::read_to_string(info.join("exclude"))
                .unwrap()
                .matches(".distill/")
                .count(),
            1
        );
    }

    #[test]
    fn writes_and_reads_back_a_document() {
        let root = temp();
        write_project_document_blocking(
            root.to_string_lossy().to_string(),
            "memory/facts.json".into(),
            "{\"a\":1}".into(),
        )
        .unwrap();
        let target = resolve_project_document_path(&root, "memory/facts.json").unwrap();
        let read = super::super::distill_store::read_document_capped(&target).unwrap();
        assert_eq!(read.as_deref(), Some("{\"a\":1}"));
        assert_eq!(
            list_project_documents_blocking(root.to_string_lossy().to_string(), "memory".into())
                .unwrap(),
            vec!["facts.json".to_string()]
        );
    }

    #[test]
    fn refuses_a_closeout_name_that_is_a_path() {
        let root = temp();
        // `C:x.md` is drive-relative on Windows and would replace the folder
        // it is joined onto.
        for name in [
            "../escape.md",
            "sub/dir.md",
            "notes.txt",
            "",
            "C:escape.md",
            "note.md:stream.md",
            // DOS devices: `docs/runs/CON.md` is the console, not a document.
            "CON.md",
            "nul.md",
            "COM1.md",
            "lpt9.md",
            "PRN.md",
            "aux.md",
        ] {
            assert!(
                write_project_run_closeout_blocking(
                    root.to_string_lossy().to_string(),
                    name.into(),
                    "x".into(),
                )
                .is_err(),
                "{name}"
            );
        }
    }

    #[test]
    fn a_document_never_written_reads_as_nothing() {
        let root = temp();
        let target = resolve_project_document_path(&root, "nope.json").unwrap();
        assert!(super::super::distill_store::read_document_capped(&target)
            .unwrap()
            .is_none());
    }
}
