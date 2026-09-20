//! Distill ran under its upstream's application identifier, `xyz.block.berd`,
//! and everything the OS keys by identifier sat under that name: the chats,
//! projects and installed bridges in `%APPDATA%\<identifier>`, the logs and the
//! WebView profile (drafts, window layout) in `%LOCALAPPDATA%\<identifier>`.
//! It now has an identifier of its own, and this is what brings those folders
//! along, once, before anything opens a file in them.
//!
//! The folders are renamed rather than copied: nothing in them stores its own
//! absolute path, a rename on one volume is atomic, and ~2 GB are not written a
//! second time. It is all or nothing — a build that started with only some of
//! its folders would open an empty profile over the operator's real one and
//! look like data loss, so a rename that cannot be done is undone as far as it
//! got and the app does not start.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long a folder that will not move is retried before the app refuses to
/// start. The WebView2 processes of a build that was just closed hold its
/// profile open for a moment after the window is gone; a build that is still
/// running holds it for good, and is what the refusal is for.
const RENAME_PATIENCE: Duration = Duration::from_secs(5);
const RENAME_RETRY_INTERVAL: Duration = Duration::from_millis(250);

/// The identifier each of ours replaces. An isolated E2E run has none: its
/// identifier is unique to the run and has no history.
const REPLACED_IDENTIFIERS: &[(&str, &str)] = &[
    ("com.levocat.distill", "xyz.block.berd"),
    ("com.levocat.distill.dev", "xyz.block.berd.dev"),
];

fn replaced_identifier(identifier: &str) -> Option<&'static str> {
    REPLACED_IDENTIFIERS
        .iter()
        .find(|(current, _)| *current == identifier)
        .map(|(_, replaced)| *replaced)
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

/// Bring the folders of the identifier `identifier` replaces under its own
/// name. Returns the folders that were moved, for the log — which does not
/// exist yet when this runs.
pub(crate) fn adopt_replaced_app_dirs(identifier: &str) -> Result<Vec<PathBuf>, String> {
    let Some(replaced) = replaced_identifier(identifier) else {
        return Ok(Vec::new());
    };
    adopt_in(
        &identifier_keyed_dirs(),
        replaced,
        identifier,
        RENAME_PATIENCE,
    )
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
            return Err(refusal(&from, &to, &error));
        }
        moved.push((from, to));
    }
    Ok(moved.into_iter().map(|(_, to)| to).collect())
}

fn refusal(from: &Path, to: &Path, error: &std::io::Error) -> String {
    format!(
        "Distill's data is still in\n{}\nand could not be moved to\n{}\n({error}).\n\n\
         An older Distill that is still running keeps those files open. Close every Distill \
         window and start again. Nothing was changed.",
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
        let (text, caption) = (wide(message), wide("Distill"));
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

    const REPLACED: &str = "xyz.block.berd.dev";
    const CURRENT: &str = "com.levocat.distill.dev";

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

    #[test]
    fn only_our_own_identifiers_replace_one() {
        assert_eq!(
            replaced_identifier("com.levocat.distill"),
            Some("xyz.block.berd")
        );
        assert_eq!(replaced_identifier(CURRENT), Some(REPLACED));
        assert_eq!(replaced_identifier("com.levocat.distill.e2e.run-1"), None);
        assert_eq!(replaced_identifier(REPLACED), None);
    }

    #[test]
    fn every_folder_of_the_replaced_identifier_comes_along() {
        let root = tempfile::tempdir().unwrap();
        let bases = bases(root.path());
        seed(&bases[0], REPLACED, "agent-host.db");
        seed(&bases[1], REPLACED, "berd.log");

        let moved = adopt_in(&bases, REPLACED, CURRENT, Duration::ZERO).unwrap();

        assert_eq!(moved, [bases[0].join(CURRENT), bases[1].join(CURRENT)]);
        assert!(bases[0].join(CURRENT).join("agent-host.db").is_file());
        assert!(bases[1].join(CURRENT).join("berd.log").is_file());
        assert!(!bases[0].join(REPLACED).exists());
        assert!(!bases[1].join(REPLACED).exists());
        // And it is done once: a second start finds nothing to do.
        assert!(adopt_in(&bases, REPLACED, CURRENT, Duration::ZERO)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_profile_already_under_the_new_name_is_never_replaced() {
        let root = tempfile::tempdir().unwrap();
        let bases = bases(root.path());
        seed(&bases[0], REPLACED, "stale.db");
        seed(&bases[0], CURRENT, "live.db");

        assert!(adopt_in(&bases, REPLACED, CURRENT, Duration::ZERO)
            .unwrap()
            .is_empty());

        assert!(bases[0].join(CURRENT).join("live.db").is_file());
        assert!(bases[0].join(REPLACED).join("stale.db").is_file());
    }

    /// What an older build that is still running does to the rename: Windows
    /// will not rename a folder while a file in it is open.
    #[cfg(windows)]
    #[test]
    fn a_folder_that_cannot_be_moved_puts_the_others_back() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = tempfile::tempdir().unwrap();
        let bases = bases(root.path());
        seed(&bases[0], REPLACED, "agent-host.db");
        seed(&bases[1], REPLACED, "berd.log");
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(bases[1].join(REPLACED).join("berd.log"))
            .unwrap();

        let error = adopt_in(&bases, REPLACED, CURRENT, Duration::ZERO).unwrap_err();

        assert!(error.contains("Nothing was changed"));
        assert!(bases[0].join(REPLACED).join("agent-host.db").is_file());
        assert!(!bases[0].join(CURRENT).exists());
        assert!(!bases[1].join(CURRENT).exists());
        drop(held);
    }
}
