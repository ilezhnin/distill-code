//! A project's own `.distill` folder: overrides and additions that travel with
//! the project rather than with the machine.
//!
//! The global root (`flock_store`) holds what belongs to the operator: their
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

#[tauri::command]
pub async fn initialize_project_context(project_root: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(project_root);
        crate::services::flock_root::ensure_project_layout(&root)?;
        let _ = exclude_agent_folders(&root);
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

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
        Some("json") | Some("md") => {
            crate::services::flock_root::reject_document_links(project_root, &resolved)?;
            Ok(resolved)
        }
        _ => Err("Only .json and .md documents are stored here".into()),
    }
}

/// Reads one of a project's documents. A document never written is `None`.
///
/// `async` + `spawn_blocking` and the shared size cap, for the reasons given on
/// `flock_store::read_flock_document` and
/// `flock_store::MAX_DOCUMENT_BYTES` — a project `.md` in particular can be
/// replaced out-of-band by something arbitrarily large.
#[tauri::command]
pub async fn read_project_document(
    project_root: String,
    path: String,
) -> Result<Option<String>, String> {
    let target = resolve_project_document_path(Path::new(project_root.trim()), &path)?;
    tokio::task::spawn_blocking(move || super::flock_store::read_document_capped(&target))
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
/// on the UI thread. See `flock_store::write_flock_document`.
///
/// CONTRACT: **the caller must serialise its writes per path**, for the reason
/// spelled out on `flock_store::write_flock_document` — an `async` command is
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
    super::flock_store::write_file_synced(&temporary, contents.as_bytes())
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
    crate::services::flock_root::reject_document_links(&root, &target)?;
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
/// on the UI thread. See `flock_store::write_flock_document`.
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
    let target = dir.join(file);
    crate::services::flock_root::reject_document_links(&root, &target)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Cannot create '{}': {error}", dir.display()))?;
    let temporary = target.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    super::flock_store::write_file_synced(&temporary, contents.as_bytes())
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
///
/// Refuses, writing nothing, when `.git`, `.git/info` or the file itself is a
/// link, a junction or any other reparse point, and when the file is there
/// but cannot be read. The callers treat this as best effort and drop the
/// result, so a refusal is logged as well.
pub fn exclude_agent_folders(project_root: &Path) -> Result<bool, String> {
    let git_dir = project_root.join(".git");
    let info = git_dir.join("info");
    let exclude = info.join("exclude");
    let refused = |reason: String| {
        let refusal = format!("Leaving '{}' as it is: {reason}", exclude.display());
        log::warn!("{refusal}");
        refusal
    };
    // A folder that came with its own `.git` (an archive, a shared or synced
    // folder) can make any of the three a link, and everything below follows
    // one: the lines would be added to, or replace, whatever file it names.
    // `.git` is looked at before `is_dir` follows it.
    let reject_links = |target: &Path| {
        crate::services::flock_root::reject_document_links(project_root, target).map_err(&refused)
    };
    reject_links(&git_dir)?;
    if !git_dir.is_dir() {
        // A worktree's `.git` is a file pointing elsewhere, and a plain folder
        // is not a repository at all. Both are "nothing to exclude here".
        return Ok(false);
    }
    reject_links(&exclude)?;
    fs::create_dir_all(&info)
        .map_err(|error| format!("Cannot create '{}': {error}", info.display()))?;
    // A file that cannot be read is not an empty one: written back as if it
    // were, an `exclude` in another encoding would lose all it held.
    let existing = match fs::read_to_string(&exclude) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(refused(format!("it cannot be read ({error})"))),
    };
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
    next.push_str("\n# Added by Flock: folders agent tools keep their own state in.\n");
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

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn refuses_to_leave_the_store() {
        let dir = temp();
        let root = dir.path();
        assert!(resolve_project_document_path(root, "../secrets.json").is_err());
        assert!(resolve_project_document_path(root, "/etc/passwd").is_err());
        assert!(resolve_project_document_path(root, "notes.txt").is_err());
    }

    #[test]
    fn excludes_agent_folders_once_and_leaves_the_rest_alone() {
        let dir = temp();
        let root = dir.path();
        let info = root.join(".git").join("info");
        fs::create_dir_all(&info).unwrap();
        fs::write(info.join("exclude"), "# theirs\nbuild/\n").unwrap();

        assert!(exclude_agent_folders(root).unwrap());
        let written = fs::read_to_string(info.join("exclude")).unwrap();
        assert!(written.starts_with("# theirs\nbuild/\n"));
        assert!(written.contains(".distill/"));
        assert!(written.contains(".claude/"));

        // Second call has nothing to add and must not append again.
        assert!(!exclude_agent_folders(root).unwrap());
        assert_eq!(
            fs::read_to_string(info.join("exclude"))
                .unwrap()
                .matches(".distill/")
                .count(),
            1
        );
    }

    /// A directory link any user may create: a junction on Windows, where a
    /// symbolic link needs a privilege most accounts lack.
    fn link_folder(link: &Path, target: &Path) {
        #[cfg(windows)]
        {
            let made = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .expect("cmd runs");
            assert!(
                made.status.success(),
                "mklink /J: {}",
                String::from_utf8_lossy(&made.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// A file link, or `false` where this account may not create one
    /// (Windows without Developer Mode or the symbolic link privilege).
    fn link_file(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        {
            const PRIVILEGE_NOT_HELD: i32 = 1314;
            match std::os::windows::fs::symlink_file(target, link) {
                Ok(()) => true,
                Err(error) if error.raw_os_error() == Some(PRIVILEGE_NOT_HELD) => false,
                Err(error) => panic!("symlink_file: {error}"),
            }
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).unwrap();
            true
        }
    }

    #[test]
    fn creates_the_exclude_file_a_repository_does_not_have_yet() {
        let dir = temp();
        let root = dir.path();
        fs::create_dir_all(root.join(".git")).unwrap();

        assert!(exclude_agent_folders(root).unwrap());
        let written = fs::read_to_string(root.join(".git").join("info").join("exclude")).unwrap();
        for folder in AGENT_FOLDERS {
            assert!(written.lines().any(|line| line == folder), "{folder}");
        }
    }

    #[test]
    fn leaves_a_worktree_and_a_plain_folder_alone() {
        let dir = temp();
        let plain = dir.path().join("plain");
        let worktree = dir.path().join("worktree");
        fs::create_dir_all(&plain).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        let pointer = "gitdir: ../elsewhere/.git/worktrees/worktree\n";
        fs::write(worktree.join(".git"), pointer).unwrap();

        assert_eq!(exclude_agent_folders(&plain), Ok(false));
        assert_eq!(exclude_agent_folders(&worktree), Ok(false));
        assert!(!plain.join(".git").exists());
        assert_eq!(fs::read_to_string(worktree.join(".git")).unwrap(), pointer);
    }

    /// A folder that came with its own `.git` can make that `.git` a link to
    /// another folder. The lines must not land in the `info/exclude` found
    /// there.
    #[test]
    fn does_not_write_the_exclude_file_through_a_linked_git_folder() {
        let dir = temp();
        let root = dir.path().join("project");
        let elsewhere = dir.path().join("elsewhere");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(elsewhere.join("info")).unwrap();
        fs::write(elsewhere.join("info").join("exclude"), "# theirs\n").unwrap();
        link_folder(&root.join(".git"), &elsewhere);

        let refusal = exclude_agent_folders(&root).unwrap_err();
        assert!(refusal.contains("link or junction"), "{refusal}");
        assert_eq!(
            fs::read_to_string(elsewhere.join("info").join("exclude")).unwrap(),
            "# theirs\n"
        );
    }

    /// With `.git/info` a link, the old code created a file named `exclude`
    /// in whatever folder the link named.
    #[test]
    fn does_not_create_the_exclude_file_through_a_linked_info_folder() {
        let dir = temp();
        let root = dir.path().join("project");
        let elsewhere = dir.path().join("elsewhere");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        link_folder(&root.join(".git").join("info"), &elsewhere);

        let refusal = exclude_agent_folders(&root).unwrap_err();
        assert!(refusal.contains("link or junction"), "{refusal}");
        assert!(!elsewhere.join("exclude").exists());
    }

    /// With `exclude` itself a link to a file that is not text, the old code
    /// read nothing and replaced that file with its own lines.
    #[test]
    fn does_not_write_through_a_linked_exclude_file() {
        let dir = temp();
        let root = dir.path().join("project");
        let info = root.join(".git").join("info");
        fs::create_dir_all(&info).unwrap();
        let theirs = dir.path().join("theirs.bin");
        let bytes = [0xff, 0xfe, 0x00, 0x9f, 0x92, 0x96];
        fs::write(&theirs, bytes).unwrap();
        if !link_file(&info.join("exclude"), &theirs) {
            eprintln!("skipped: this account may not create a file link");
            return;
        }

        let refusal = exclude_agent_folders(&root).unwrap_err();
        assert!(refusal.contains("link or junction"), "{refusal}");
        assert_eq!(fs::read(&theirs).unwrap(), bytes);
    }

    /// The operator's own `exclude` in another encoding (PowerShell writes
    /// UTF-16) cannot be read as text. It is not an empty file.
    #[test]
    fn does_not_replace_an_exclude_file_it_cannot_read() {
        let dir = temp();
        let root = dir.path();
        let info = root.join(".git").join("info");
        fs::create_dir_all(&info).unwrap();
        let bytes = [0xff, 0xfe, b'b', 0x00, b'i', 0x00, b'n', 0x00, 0x00, 0xd8];
        fs::write(info.join("exclude"), bytes).unwrap();

        let refusal = exclude_agent_folders(root).unwrap_err();
        assert!(refusal.contains("cannot be read"), "{refusal}");
        assert_eq!(fs::read(info.join("exclude")).unwrap(), bytes);
    }

    #[test]
    fn writes_and_reads_back_a_document() {
        let dir = temp();
        let root = dir.path();
        write_project_document_blocking(
            root.to_string_lossy().to_string(),
            "memory/facts.json".into(),
            "{\"a\":1}".into(),
        )
        .unwrap();
        let target = resolve_project_document_path(root, "memory/facts.json").unwrap();
        let read = super::super::flock_store::read_document_capped(&target).unwrap();
        assert_eq!(read.as_deref(), Some("{\"a\":1}"));
        assert_eq!(
            list_project_documents_blocking(root.to_string_lossy().to_string(), "memory".into())
                .unwrap(),
            vec!["facts.json".to_string()]
        );
    }

    #[test]
    fn refuses_a_closeout_name_that_is_a_path() {
        let dir = temp();
        let root = dir.path();
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
        let dir = temp();
        let root = dir.path();
        let target = resolve_project_document_path(root, "nope.json").unwrap();
        assert!(super::super::flock_store::read_document_capped(&target)
            .unwrap()
            .is_none());
    }
}
