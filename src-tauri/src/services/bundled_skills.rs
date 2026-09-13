use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tokio::sync::Notify;

use serde::Deserialize;

use crate::services::distro_bundle::DistroBundle;
use crate::services::managed_acp_tools::retry_transient_io;

const DISTRO_SKILLS_DIR_NAME: &str = "skills";
const SKILLS_DIR_NAME: &str = "skills";
const SKILL_FILE_NAME: &str = "SKILL.md";
/// Staged and superseded copies live one level below the skills root, so the
/// skill scanner — which treats every direct child holding a `SKILL.md` as a
/// skill, dot-prefixed or not — never sees a half-installed or retired copy.
const TRANSACTIONS_DIR_NAME: &str = ".berd-skill-transactions";
static INSTALL_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Default)]
pub struct BundledSkillsState {
    ready: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl BundledSkillsState {
    pub fn mark_ready(&self) {
        self.ready.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub async fn wait_until_ready(&self) {
        loop {
            let notified = self.notify.notified();
            if self.ready.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

pub fn seed_bundled_skills(bundle: &DistroBundle, app_data_dir: &Path) -> Result<usize, String> {
    let source_root = bundle.root_dir.join(DISTRO_SKILLS_DIR_NAME);
    let target_root = bundled_skills_target(app_data_dir);
    seed_bundled_skills_from_dir(&source_root, &target_root)
}

fn bundled_skills_target(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join(SKILLS_DIR_NAME)
}

fn seed_bundled_skills_from_dir(source_root: &Path, target_root: &Path) -> Result<usize, String> {
    if !source_root.is_dir() {
        return Ok(0);
    }

    fs::create_dir_all(target_root).map_err(|err| {
        format!(
            "Failed to create skills directory '{}': {err}",
            target_root.display()
        )
    })?;
    // A previous run that was killed mid-swap can leave stage/retired copies
    // behind. They are invisible to the scanner, but sweeping them keeps the
    // directory from growing one pair per crash.
    let _ = fs::remove_dir_all(target_root.join(TRANSACTIONS_DIR_NAME));

    let mut seeded = 0usize;
    for entry in fs::read_dir(source_root).map_err(|err| {
        format!(
            "Failed to read bundled skills directory '{}': {err}",
            source_root.display()
        )
    })? {
        let entry = entry.map_err(|err| {
            format!(
                "Failed to read bundled skills directory '{}': {err}",
                source_root.display()
            )
        })?;
        let source = entry.path();
        if !source.is_dir() || !source.join(SKILL_FILE_NAME).is_file() {
            continue;
        }

        let skill_name = entry.file_name();
        let target = target_root.join(&skill_name);
        // One skill that cannot be installed must not cost every skill after it
        // its seeding — the loop used to abort on the first error.
        match should_install_skill(&source, &target) {
            Ok(false) => continue,
            Ok(true) => {}
            Err(error) => {
                log::warn!("{error}");
                continue;
            }
        }
        match install_skill_dir(&source, &target) {
            Ok(()) => seeded += 1,
            Err(error) => log::warn!("{error}"),
        }
    }

    Ok(seeded)
}

/// What is sitting at a bundled skill's install path.
#[derive(Debug, PartialEq, Eq)]
enum InstalledSkillState {
    Nothing,
    /// A directory carrying our own `berdBundled` marker.
    Bundled,
    /// A directory with no readable `SKILL.md`. It is not a skill at all — it is
    /// what an interrupted install leaves behind — so it is ours to repair.
    /// Classifying it as user-authored is what used to make the loss permanent.
    Partial,
    /// Something the user owns: their own skill, or a file/symlink at the path.
    UserOwned,
}

fn installed_skill_state(skill_dir: &Path) -> Result<InstalledSkillState, String> {
    let metadata = match fs::symlink_metadata(skill_dir) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(InstalledSkillState::Nothing)
        }
        Err(err) => {
            return Err(format!(
                "Failed to inspect installed skill path '{}': {err}",
                skill_dir.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(InstalledSkillState::UserOwned);
    }

    let skill_file = skill_dir.join(SKILL_FILE_NAME);
    let contents = match fs::read_to_string(&skill_file) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(InstalledSkillState::Partial)
        }
        Err(err) if err.kind() == std::io::ErrorKind::InvalidData => {
            return Ok(InstalledSkillState::UserOwned)
        }
        Err(err) => {
            return Err(format!(
                "Failed to read installed skill '{}': {err}",
                skill_file.display()
            ));
        }
    };

    if skill_frontmatter(&contents)
        .and_then(|frontmatter| yaml_serde::from_str::<SkillFrontmatter>(frontmatter).ok())
        .and_then(|frontmatter| frontmatter.metadata)
        .map(|metadata| metadata.berd_bundled.unwrap_or(false))
        .unwrap_or(false)
    {
        Ok(InstalledSkillState::Bundled)
    } else {
        Ok(InstalledSkillState::UserOwned)
    }
}

fn should_install_skill(source: &Path, target: &Path) -> Result<bool, String> {
    match installed_skill_state(target)? {
        InstalledSkillState::Nothing | InstalledSkillState::Partial => Ok(true),
        InstalledSkillState::UserOwned => Ok(false),
        // The usual case on every launch after the first: the installed copy is
        // already what we would write, so touching it is pure risk.
        InstalledSkillState::Bundled => Ok(!dirs_have_equal_contents(source, target)?),
    }
}

/// Whether `target` is byte-for-byte the tree `source` would install.
///
/// A symlink anywhere in either tree counts as different: `copy_dir_all` refuses
/// to write one, so it cannot be something we installed.
fn dirs_have_equal_contents(source: &Path, target: &Path) -> Result<bool, String> {
    let source_names = dir_entry_names(source)?;
    if source_names != dir_entry_names(target)? {
        return Ok(false);
    }

    for name in source_names {
        let source_path = source.join(&name);
        let target_path = target.join(&name);
        let source_meta = entry_metadata(&source_path)?;
        let target_meta = entry_metadata(&target_path)?;
        if source_meta.file_type().is_symlink() || target_meta.file_type().is_symlink() {
            return Ok(false);
        }
        if source_meta.is_dir() != target_meta.is_dir() {
            return Ok(false);
        }
        if source_meta.is_dir() {
            if !dirs_have_equal_contents(&source_path, &target_path)? {
                return Ok(false);
            }
        } else if source_meta.len() != target_meta.len()
            || read_for_compare(&source_path)? != read_for_compare(&target_path)?
        {
            return Ok(false);
        }
    }

    Ok(true)
}

fn dir_entry_names(dir: &Path) -> Result<BTreeSet<OsString>, String> {
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(dir)
        .map_err(|err| format!("Failed to read skill directory '{}': {err}", dir.display()))?
    {
        let entry = entry
            .map_err(|err| format!("Failed to read skill directory '{}': {err}", dir.display()))?;
        names.insert(entry.file_name());
    }
    Ok(names)
}

fn entry_metadata(path: &Path) -> Result<fs::Metadata, String> {
    fs::symlink_metadata(path)
        .map_err(|err| format!("Failed to inspect skill path '{}': {err}", path.display()))
}

fn read_for_compare(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|err| format!("Failed to read '{}': {err}", path.display()))
}

fn skill_frontmatter(contents: &str) -> Option<&str> {
    let contents = contents.strip_prefix("---\n")?;
    let end = contents.find("\n---")?;
    Some(&contents[..end])
}

#[derive(Deserialize)]
struct SkillFrontmatter {
    metadata: Option<SkillMetadata>,
}

#[derive(Deserialize)]
struct SkillMetadata {
    #[serde(rename = "berdBundled")]
    berd_bundled: Option<bool>,
}

/// Install `source` at `target` without ever leaving `target` incomplete.
///
/// The old code emptied the live directory first (`remove_dir_all` + copy). On
/// Windows that deletes the children and removes the directory last, so any
/// handle on the directory — an Explorer window, an indexer, a shell sitting in
/// it — fails the final step *after* `SKILL.md` is already gone, and the skill
/// was then classified user-authored and never repaired. Here the replacement is
/// built to the side first and the live copy is only ever moved aside, so a
/// failure at any step leaves either the old tree or the new one, never neither.
fn install_skill_dir(source: &Path, target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| {
        format!(
            "Bundled skill target '{}' has no parent directory",
            target.display()
        )
    })?;
    let transactions = parent.join(TRANSACTIONS_DIR_NAME);
    fs::create_dir_all(&transactions).map_err(|err| {
        format!(
            "Failed to create bundled skill staging directory '{}': {err}",
            transactions.display()
        )
    })?;
    let sequence = INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let stage = transactions.join(format!("stage-{}-{sequence}", std::process::id()));
    let retired = transactions.join(format!("retired-{}-{sequence}", std::process::id()));
    let _ = fs::remove_dir_all(&stage);
    let _ = fs::remove_dir_all(&retired);

    if let Err(err) = copy_dir_all(source, &stage) {
        let _ = fs::remove_dir_all(&stage);
        return Err(err);
    }

    let had_previous = fs::symlink_metadata(target).is_ok();
    if had_previous {
        if let Err(err) = retry_transient_io(|| fs::rename(target, &retired)) {
            let _ = fs::remove_dir_all(&stage);
            return Err(format!(
                "Failed to replace bundled skill '{}': could not move the installed copy aside: {err}",
                target.display()
            ));
        }
    }

    if let Err(err) = retry_transient_io(|| fs::rename(&stage, target)) {
        // Put the working copy back rather than leaving the skill missing.
        if had_previous {
            let _ = retry_transient_io(|| fs::rename(&retired, target));
        }
        let _ = fs::remove_dir_all(&stage);
        return Err(format!(
            "Failed to install bundled skill '{}': {err}",
            target.display()
        ));
    }

    // The new tree is live; the retired one is only disk space, and the sweep at
    // the start of the next seeding run picks up whatever resists deletion now.
    if had_previous {
        let _ = fs::remove_dir_all(&retired);
    }
    Ok(())
}

fn copy_dir_all(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|err| {
        format!(
            "Failed to inspect bundled skill path '{}': {err}",
            source.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Bundled skill path '{}' must not be a symbolic link",
            source.display()
        ));
    }

    fs::create_dir_all(target).map_err(|err| {
        format!(
            "Failed to create bundled skill directory '{}': {err}",
            target.display()
        )
    })?;

    for entry in fs::read_dir(source)
        .map_err(|err| format!("Failed to read bundled skill '{}': {err}", source.display()))?
    {
        let entry = entry
            .map_err(|err| format!("Failed to read bundled skill '{}': {err}", source.display()))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path).map_err(|err| {
            format!(
                "Failed to inspect bundled skill path '{}': {err}",
                source_path.display()
            )
        })?;

        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Bundled skill path '{}' must not be a symbolic link",
                source_path.display()
            ));
        }
        if metadata.is_dir() {
            copy_dir_all(&source_path, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &target_path).map_err(|err| {
                format!(
                    "Failed to copy bundled skill file '{}' to '{}': {err}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_skill(root: &Path, name: &str, skill_md: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SKILL_FILE_NAME), skill_md).unwrap();
    }

    #[test]
    fn preserves_existing_user_skill() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_skill(source.path(), "agent-builder", "bundled");
        write_skill(target.path(), "agent-builder", "user edited");

        let seeded = seed_bundled_skills_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(seeded, 0);
        assert_eq!(
            fs::read_to_string(target.path().join("agent-builder").join(SKILL_FILE_NAME)).unwrap(),
            "user edited"
        );
    }

    const BUNDLED: &str = "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\nbody";

    fn transactions_dir(target: &Path) -> std::path::PathBuf {
        target.join(TRANSACTIONS_DIR_NAME)
    }

    #[test]
    fn an_unchanged_bundled_skill_is_not_rewritten() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_skill(source.path(), "agent-builder", BUNDLED);
        fs::create_dir_all(source.path().join("agent-builder").join("references")).unwrap();
        fs::write(
            source
                .path()
                .join("agent-builder")
                .join("references")
                .join("notes.md"),
            "reference",
        )
        .unwrap();

        assert_eq!(
            seed_bundled_skills_from_dir(source.path(), target.path()).unwrap(),
            1
        );
        // Second launch: the installed copy is already what we would write, so
        // nothing is removed and nothing is copied.
        assert_eq!(
            seed_bundled_skills_from_dir(source.path(), target.path()).unwrap(),
            0
        );
        assert_eq!(
            fs::read_to_string(target.path().join("agent-builder").join(SKILL_FILE_NAME)).unwrap(),
            BUNDLED
        );
        // A changed reference file is enough to make it reinstall.
        fs::write(
            source
                .path()
                .join("agent-builder")
                .join("references")
                .join("notes.md"),
            "updated reference",
        )
        .unwrap();
        assert_eq!(
            seed_bundled_skills_from_dir(source.path(), target.path()).unwrap(),
            1
        );
        assert_eq!(
            fs::read_to_string(
                target
                    .path()
                    .join("agent-builder")
                    .join("references")
                    .join("notes.md")
            )
            .unwrap(),
            "updated reference"
        );
    }

    #[test]
    fn a_skill_directory_left_without_a_skill_file_is_repaired() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_skill(source.path(), "berd-help", BUNDLED);
        // What a failed `remove_dir_all` used to leave behind: the directory
        // survives, `SKILL.md` is gone. It must not be mistaken for a user skill.
        fs::create_dir_all(target.path().join("berd-help").join("references")).unwrap();

        assert_eq!(
            seed_bundled_skills_from_dir(source.path(), target.path()).unwrap(),
            1
        );
        assert_eq!(
            fs::read_to_string(target.path().join("berd-help").join(SKILL_FILE_NAME)).unwrap(),
            BUNDLED
        );
        assert!(
            !target.path().join("berd-help").join("references").exists(),
            "the repaired skill is the bundled tree, not a merge"
        );
    }

    #[test]
    fn nothing_is_staged_where_the_skill_scanner_would_find_it() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_skill(source.path(), "agent-builder", BUNDLED);
        write_skill(
            target.path(),
            "agent-builder",
            "---\nmetadata:\n  berdBundled: true\n---\nold",
        );

        seed_bundled_skills_from_dir(source.path(), target.path()).unwrap();

        // The scanner treats any direct child of the skills root holding a
        // SKILL.md as a skill, leading dot or not, so staging must be one level
        // deeper — and a successful install must leave nothing behind.
        let staging = transactions_dir(target.path());
        if staging.is_dir() {
            assert_eq!(dir_entry_names(&staging).unwrap(), BTreeSet::new());
        }
        let visible = dir_entry_names(target.path())
            .unwrap()
            .into_iter()
            .filter(|name| target.path().join(name).join(SKILL_FILE_NAME).is_file())
            .collect::<Vec<_>>();
        assert_eq!(visible, vec![OsString::from("agent-builder")]);
    }

    #[cfg(unix)]
    #[test]
    fn one_unusable_skill_does_not_stop_the_others() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        // `copy_dir_all` refuses symlinks, so "aaa" fails to install. It sorts
        // before "zzz", which used to mean "zzz" was never seeded that launch.
        write_skill(source.path(), "aaa-broken", BUNDLED);
        std::os::unix::fs::symlink(
            "/etc/hosts",
            source.path().join("aaa-broken").join("linked"),
        )
        .unwrap();
        write_skill(source.path(), "zzz-fine", BUNDLED);

        let seeded = seed_bundled_skills_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(seeded, 1, "the healthy skill is still seeded");
        assert_eq!(
            fs::read_to_string(target.path().join("zzz-fine").join(SKILL_FILE_NAME)).unwrap(),
            BUNDLED
        );
        assert!(
            !target.path().join("aaa-broken").exists(),
            "a failed install leaves no partial directory"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_reinstall_leaves_the_installed_skill_intact() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_skill(source.path(), "berd-help", BUNDLED);
        std::os::unix::fs::symlink("/etc/hosts", source.path().join("berd-help").join("linked"))
            .unwrap();
        write_skill(
            target.path(),
            "berd-help",
            "---\nmetadata:\n  berdBundled: true\n---\nstill here",
        );

        assert_eq!(
            seed_bundled_skills_from_dir(source.path(), target.path()).unwrap(),
            0
        );
        assert_eq!(
            fs::read_to_string(target.path().join("berd-help").join(SKILL_FILE_NAME)).unwrap(),
            "---\nmetadata:\n  berdBundled: true\n---\nstill here",
            "the live skill must survive an install that cannot complete"
        );
    }

    #[test]
    fn a_file_or_symlink_at_the_skill_path_is_left_to_the_user() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_skill(source.path(), "agent-builder", BUNDLED);
        fs::write(target.path().join("agent-builder"), "not a directory").unwrap();

        assert_eq!(
            seed_bundled_skills_from_dir(source.path(), target.path()).unwrap(),
            0
        );
        assert_eq!(
            fs::read_to_string(target.path().join("agent-builder")).unwrap(),
            "not a directory"
        );
    }

    #[test]
    fn reinstalls_existing_bundled_skill() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_skill(
            source.path(),
            "agent-builder",
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\nupdated",
        );
        write_skill(
            target.path(),
            "agent-builder",
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\nold",
        );

        let seeded = seed_bundled_skills_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(seeded, 1);
        assert_eq!(
            fs::read_to_string(target.path().join("agent-builder").join(SKILL_FILE_NAME)).unwrap(),
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\nupdated"
        );
    }
}
