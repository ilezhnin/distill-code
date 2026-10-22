//! Levocat Flock has had two names before this one. It ran under its
//! upstream's application identifier, `xyz.block.berd`, then as Distill under
//! `com.levocat.distill`, and everything the OS keys by identifier sat under
//! those names: the chats, projects and installed bridges in
//! `%APPDATA%\<identifier>`, the logs and the WebView profile (drafts, window
//! layout) in `%LOCALAPPDATA%\<identifier>`. This is what brings those folders
//! along, once, before anything opens a file in them.
//!
//! The folders are renamed rather than copied: nothing in them stores its own
//! absolute path, a rename on one volume is atomic, and ~2 GB are not written a
//! second time. It is all or nothing — a build that started with only some of
//! its folders would open an empty profile over the operator's real one and
//! look like data loss, so a rename that cannot be done is undone as far as it
//! got and the app does not start.
//!
//! Each identifier has a chain of predecessors, newest first. One start
//! adopts exactly one of them: the newest that still has a folder anywhere,
//! because that is the install the operator last ran. An older predecessor
//! that is also still on disk was already adopted by the newer one, or was
//! never run again after the newer one took over; either way its folders are
//! not this build's data and stay where they are.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long a folder that will not move is retried before the app refuses to
/// start. The WebView2 processes of a build that was just closed hold its
/// profile open for a moment after the window is gone; a build that is still
/// running holds it for good, and is what the refusal is for.
const RENAME_PATIENCE: Duration = Duration::from_secs(5);
const RENAME_RETRY_INTERVAL: Duration = Duration::from_millis(250);

/// The identifiers each of ours replaced, newest first. An isolated E2E run
/// has none: its identifier is unique to the run and has no history.
///
/// These are the names older installs carry on disk; a rename of the product
/// adds a new current identifier in front of a chain and never rewrites one.
const REPLACED_IDENTIFIERS: &[(&str, &[&str])] = &[
    (
        "com.levocat.flock",
        &["com.levocat.distill", "xyz.block.berd"],
    ),
    (
        "com.levocat.flock.dev",
        &["com.levocat.distill.dev", "xyz.block.berd.dev"],
    ),
];

/// Dev-only: semicolon-separated absolute directories that stand in for the
/// OS's identifier-keyed directories, so the rename can be rehearsed on a
/// temporary copy of them. A release build never reads it, and an isolated
/// E2E run never adopts anything, so it does not get here.
pub(crate) const MIGRATION_BASES_ENV: &str = "FLOCK_MIGRATION_BASES";

fn replaced_identifiers(identifier: &str) -> &'static [&'static str] {
    REPLACED_IDENTIFIERS
        .iter()
        .find(|(current, _)| *current == identifier)
        .map(|(_, replaced)| *replaced)
        .unwrap_or_default()
}

/// Every directory the OS gives an app a folder of its own in. On Windows
/// these are two (Roaming and Local); elsewhere some coincide or differ, and
/// the duplicates are dropped.
fn identifier_keyed_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in [
        dirs::data_dir(),
        dirs::config_dir(),
        dirs::data_local_dir(),
        dirs::cache_dir(),
    ]
    .into_iter()
    .flatten()
    {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// The rehearsal directories named by [`MIGRATION_BASES_ENV`], when a dev
/// build has it set. A value that is set but unusable is an error rather than
/// a fallback: a rehearsal with a typo must not touch the real folders.
fn override_bases(value: Option<&str>, dev_build: bool) -> Result<Option<Vec<PathBuf>>, String> {
    let Some(value) = value.filter(|_| dev_build) else {
        return Ok(None);
    };
    let mut bases = Vec::new();
    for entry in value
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let base = PathBuf::from(entry);
        if !base.is_absolute() {
            return Err(format!(
                "{MIGRATION_BASES_ENV} names '{entry}', which is not an absolute directory. \
                 Nothing was changed."
            ));
        }
        if !bases.contains(&base) {
            bases.push(base);
        }
    }
    if bases.is_empty() {
        return Err(format!(
            "{MIGRATION_BASES_ENV} is set but names no directory. Nothing was changed."
        ));
    }
    Ok(Some(bases))
}

fn migration_bases() -> Result<Vec<PathBuf>, String> {
    let dev_build =
        cfg!(debug_assertions) && std::env::var_os(crate::services::e2e_mode::MODE_ENV).is_none();
    let value = std::env::var(MIGRATION_BASES_ENV).ok();
    Ok(override_bases(value.as_deref(), dev_build)?.unwrap_or_else(identifier_keyed_dirs))
}

/// Bring the folders of the identifier `identifier` replaces under its own
/// name. Returns the folders that were moved, for the log — which does not
/// exist yet when this runs.
pub(crate) fn adopt_replaced_app_dirs(identifier: &str) -> Result<Vec<PathBuf>, String> {
    let predecessors = replaced_identifiers(identifier);
    if predecessors.is_empty() {
        return Ok(Vec::new());
    }
    adopt_chain_in(
        &migration_bases()?,
        predecessors,
        identifier,
        RENAME_PATIENCE,
    )
}

/// The one predecessor this start adopts: the newest with a folder under any
/// base. Chosen once, so a base that only has an older predecessor's folder
/// is left alone rather than filled from the wrong install. A folder already
/// under our own name under any base means this ran before (or the profile
/// is in use), and nothing older is adopted into a base it never reached.
fn choose_predecessor<'a>(
    bases: &[PathBuf],
    identifier: &str,
    predecessors: &[&'a str],
) -> Option<&'a str> {
    if bases.iter().any(|base| base.join(identifier).is_dir()) {
        return None;
    }
    predecessors
        .iter()
        .copied()
        .find(|predecessor| bases.iter().any(|base| base.join(predecessor).is_dir()))
}

fn adopt_chain_in(
    bases: &[PathBuf],
    predecessors: &[&str],
    identifier: &str,
    patience: Duration,
) -> Result<Vec<PathBuf>, String> {
    let Some(replaced) = choose_predecessor(bases, identifier, predecessors) else {
        return Ok(Vec::new());
    };
    adopt_in(bases, replaced, identifier, patience)
}

fn rename_with_patience(from: &Path, to: &Path, patience: Duration) -> std::io::Result<()> {
    let deadline = Instant::now() + patience;
    loop {
        match std::fs::rename(from, to) {
            Err(_) if Instant::now() < deadline => std::thread::sleep(RENAME_RETRY_INTERVAL),
            result => return result,
        }
    }
}

fn adopt_in(
    bases: &[PathBuf],
    replaced: &str,
    identifier: &str,
    patience: Duration,
) -> Result<Vec<PathBuf>, String> {
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for base in bases {
        let from = base.join(replaced);
        let to = base.join(identifier);
        // A folder already under the new name is the profile in use: either
        // this ran before, or an older build was started again afterwards and
        // made itself a fresh one, which must not replace it.
        if !from.is_dir() || to.exists() {
            continue;
        }
        if let Err(error) = rename_with_patience(&from, &to, patience) {
            for (from, to) in moved.iter().rev() {
                let _ = std::fs::rename(to, from);
            }
            return Err(refusal(replaced, &from, &to, &error));
        }
        moved.push((from, to));
    }
    Ok(moved.into_iter().map(|(_, to)| to).collect())
}

fn refusal(replaced: &str, from: &Path, to: &Path, error: &std::io::Error) -> String {
    format!(
        "Levocat Flock found the data of its previous identity ({replaced}) in\n{}\n\
         and could not move it to\n{}\n({error}).\n\n\
         An older build that is still running keeps those files open. Close every window \
         of it and start Levocat Flock again. Nothing was changed.",
        from.display(),
        to.display()
    )
}

/// Say why the app is not starting and end the process. A release build has
/// no console, so without the dialog this would be a launch that does nothing.
pub(crate) fn refuse_to_start(message: &str) -> ! {
    eprintln!("{message}");
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

        let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() };
        let (text, caption) = (wide(message), wide("Levocat Flock"));
        // SAFETY: both buffers are NUL-terminated and outlive the call; a null
        // owner makes the dialog a top-level window.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                caption.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURRENT: &str = "com.levocat.flock.dev";
    const DISTILL: &str = "com.levocat.distill.dev";
    const BERD: &str = "xyz.block.berd.dev";
    const CHAIN: &[&str] = &[DISTILL, BERD];

    fn bases(root: &Path) -> Vec<PathBuf> {
        let bases = vec![root.join("Roaming"), root.join("Local")];
        for base in &bases {
            std::fs::create_dir_all(base).unwrap();
        }
        bases
    }

    fn seed(base: &Path, identifier: &str, file: &str) {
        let dir = base.join(identifier);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(file), file).unwrap();
    }

    /// The chain members are the names older installs carry on disk. They
    /// are spelled out of pieces here so that a product rename sweeping the
    /// sources cannot rename the folders it is supposed to find.
    fn spelled(parts: &[&str]) -> String {
        parts.concat()
    }

    #[test]
    fn the_distill_identifier_is_the_newest_predecessor() {
        assert_eq!(
            replaced_identifiers("com.levocat.flock")[0],
            spelled(&["com.levocat.", "dis", "till"])
        );
        assert_eq!(
            replaced_identifiers(CURRENT)[0],
            spelled(&["com.levocat.", "dis", "till", ".dev"])
        );
    }

    #[test]
    fn the_berd_identifier_is_the_oldest_predecessor() {
        assert_eq!(
            replaced_identifiers("com.levocat.flock")[1],
            spelled(&["xyz.block.", "be", "rd"])
        );
        assert_eq!(
            replaced_identifiers(CURRENT)[1],
            spelled(&["xyz.block.", "be", "rd", ".dev"])
        );
    }

    #[test]
    fn only_our_own_identifiers_have_predecessors() {
        assert_eq!(replaced_identifiers("com.levocat.flock").len(), 2);
        assert_eq!(replaced_identifiers(CURRENT), CHAIN);
        assert!(replaced_identifiers("com.levocat.flock.e2e.run-1").is_empty());
        assert!(replaced_identifiers(DISTILL).is_empty());
        assert!(replaced_identifiers(BERD).is_empty());
    }

    #[test]
    fn every_folder_of_the_chosen_predecessor_comes_along() {
        let root = tempfile::tempdir().unwrap();
        let bases = bases(root.path());
        seed(&bases[0], DISTILL, "agent-host.db");
        seed(&bases[1], DISTILL, "flock.log");

        let moved = adopt_chain_in(&bases, CHAIN, CURRENT, Duration::ZERO).unwrap();

        assert_eq!(moved, [bases[0].join(CURRENT), bases[1].join(CURRENT)]);
        assert!(bases[0].join(CURRENT).join("agent-host.db").is_file());
        assert!(bases[1].join(CURRENT).join("flock.log").is_file());
        assert!(!bases[0].join(DISTILL).exists());
        assert!(!bases[1].join(DISTILL).exists());
        // And it is done once: a second start finds nothing to do.
        assert!(adopt_chain_in(&bases, CHAIN, CURRENT, Duration::ZERO)
            .unwrap()
            .is_empty());
    }

    /// An install that went Berd -> Distill and kept the Berd folders in one
    /// base: Distill is the install the operator last ran, so only its
    /// folders move, and a base that has only Berd gets nothing from it.
    #[test]
    fn the_newest_predecessor_on_disk_is_the_only_one_adopted() {
        let root = tempfile::tempdir().unwrap();
        let bases = bases(root.path());
        seed(&bases[0], BERD, "berd.db");
        seed(&bases[0], DISTILL, "distill.db");
        seed(&bases[1], BERD, "berd.log");

        let moved = adopt_chain_in(&bases, CHAIN, CURRENT, Duration::ZERO).unwrap();

        assert_eq!(moved, [bases[0].join(CURRENT)]);
        assert!(bases[0].join(CURRENT).join("distill.db").is_file());
        assert!(!bases[0].join(DISTILL).exists());
        assert!(bases[0].join(BERD).join("berd.db").is_file());
        assert!(!bases[1].join(CURRENT).exists());
        assert!(bases[1].join(BERD).join("berd.log").is_file());

        // The second start finds its own folder and leaves the older
        // predecessor where it is, rather than filling the other base from it.
        let again = adopt_chain_in(&bases, CHAIN, CURRENT, Duration::ZERO).unwrap();
        assert!(again.is_empty());
        assert!(!bases[1].join(CURRENT).exists());
        assert!(bases[1].join(BERD).join("berd.log").is_file());
    }

    #[test]
    fn an_install_that_never_ran_distill_adopts_berd() {
        let root = tempfile::tempdir().unwrap();
        let bases = bases(root.path());
        seed(&bases[0], BERD, "agent-host.db");
        seed(&bases[1], BERD, "berd.log");

        let moved = adopt_chain_in(&bases, CHAIN, CURRENT, Duration::ZERO).unwrap();

        assert_eq!(moved, [bases[0].join(CURRENT), bases[1].join(CURRENT)]);
        assert!(bases[0].join(CURRENT).join("agent-host.db").is_file());
        assert!(bases[1].join(CURRENT).join("berd.log").is_file());
        assert!(!bases[0].join(BERD).exists());
        assert!(!bases[1].join(BERD).exists());
    }

    #[test]
    fn an_install_with_only_distill_folders_adopts_them() {
        let root = tempfile::tempdir().unwrap();
        let bases = bases(root.path());
        seed(&bases[1], DISTILL, "flock.log");

        let moved = adopt_chain_in(&bases, CHAIN, CURRENT, Duration::ZERO).unwrap();

        assert_eq!(moved, [bases[1].join(CURRENT)]);
        assert!(bases[1].join(CURRENT).join("flock.log").is_file());
        assert!(!bases[0].join(CURRENT).exists());
    }

    #[test]
    fn a_fresh_install_has_nothing_to_adopt() {
        let root = tempfile::tempdir().unwrap();
        let bases = bases(root.path());

        assert!(adopt_chain_in(&bases, CHAIN, CURRENT, Duration::ZERO)
            .unwrap()
            .is_empty());
        assert!(!bases[0].join(CURRENT).exists());
        assert!(!bases[1].join(CURRENT).exists());
    }

    #[test]
    fn a_profile_already_under_the_new_name_is_never_replaced() {
        let root = tempfile::tempdir().unwrap();
        let bases = bases(root.path());
        seed(&bases[0], DISTILL, "stale.db");
        seed(&bases[0], CURRENT, "live.db");

        assert!(adopt_chain_in(&bases, CHAIN, CURRENT, Duration::ZERO)
            .unwrap()
            .is_empty());

        assert!(bases[0].join(CURRENT).join("live.db").is_file());
        assert!(bases[0].join(DISTILL).join("stale.db").is_file());
    }

    /// The rehearsal override stands in for the OS directories, in a dev
    /// build only, and refuses a value that could not mean a rehearsal.
    #[test]
    fn the_rehearsal_override_names_the_bases_in_a_dev_build_only() {
        let root = tempfile::tempdir().unwrap();
        let bases = bases(root.path());
        let value = format!(
            " {} ; {};;{}",
            bases[0].display(),
            bases[1].display(),
            bases[0].display()
        );

        assert_eq!(
            override_bases(Some(&value), true).unwrap(),
            Some(bases.clone())
        );
        assert_eq!(override_bases(Some(&value), false).unwrap(), None);
        assert_eq!(override_bases(None, true).unwrap(), None);
        assert!(override_bases(Some("relative/copy"), true)
            .unwrap_err()
            .contains(MIGRATION_BASES_ENV));
        assert!(override_bases(Some(" ; "), true)
            .unwrap_err()
            .contains(MIGRATION_BASES_ENV));

        // The rehearsal itself: the copy is adopted, the real directories are
        // never consulted.
        seed(&bases[0], DISTILL, "agent-host.db");
        let rehearsal = override_bases(Some(&value), true).unwrap().unwrap();
        let moved = adopt_chain_in(&rehearsal, CHAIN, CURRENT, Duration::ZERO).unwrap();
        assert_eq!(moved, [bases[0].join(CURRENT)]);
        assert!(bases[0].join(CURRENT).join("agent-host.db").is_file());
    }

    /// What an older build that is still running does to the rename: Windows
    /// will not rename a folder while a file in it is open.
    #[cfg(windows)]
    #[test]
    fn a_folder_that_cannot_be_moved_puts_the_others_back() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = tempfile::tempdir().unwrap();
        let bases = bases(root.path());
        seed(&bases[0], DISTILL, "agent-host.db");
        seed(&bases[1], DISTILL, "flock.log");
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(bases[1].join(DISTILL).join("flock.log"))
            .unwrap();

        let error = adopt_chain_in(&bases, CHAIN, CURRENT, Duration::ZERO).unwrap_err();

        assert!(error.contains("Nothing was changed"));
        assert!(error.contains("Levocat Flock"), "{error}");
        assert!(error.contains(DISTILL), "{error}");
        assert!(bases[0].join(DISTILL).join("agent-host.db").is_file());
        assert!(!bases[0].join(CURRENT).exists());
        assert!(!bases[1].join(CURRENT).exists());
        drop(held);
    }
}
