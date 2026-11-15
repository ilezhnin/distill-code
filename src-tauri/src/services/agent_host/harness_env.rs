//! Process environment for bridge children: the user's login-shell env, the
//! managed bridge shims in front of PATH, and the flockctl shim/discovery
//! variables that let an agent running inside a session drive the app.

#[cfg(feature = "flockctl")]
use std::path::Path;
use std::path::PathBuf;
use tauri::Manager;

use super::bridge::SpawnEnv;
use crate::services::{env_key, managed_acp_tools};

pub async fn build_spawn_env(app: &tauri::AppHandle) -> SpawnEnv {
    let shell_env = managed_acp_tools::provider_env(app).await;
    let mut prepend_dirs: Vec<PathBuf> = Vec::new();
    if let Some(bundle) = app
        .try_state::<crate::services::distro_bundle::DistroBundleState>()
        .and_then(|state| state.bundle().cloned())
    {
        if let Some(bin_dir) = bundle.bin_dir.as_ref() {
            prepend_dirs.push(bin_dir.clone());
        }
    }
    let mut extra_env = Vec::new();
    install_flockctl_shims(app, &mut prepend_dirs, &mut extra_env);
    SpawnEnv {
        shell_env,
        prepend_dirs,
        extra_env,
        remove_env: Vec::new(),
    }
}

/// Minimum runtime environment for a separate no-tool bridge: the fixed
/// allowlist plus the `inherited` keys the provider's own sign-in needs.
/// Authentication is installed afterwards by the existing managed-account
/// adapter.
pub async fn build_owned_spawn_env(app: &tauri::AppHandle, inherited: &[&str]) -> SpawnEnv {
    let mut shell_env = managed_acp_tools::provider_env(app).await;
    shell_env.retain(|key, _| owned_env_keeps(key, inherited));
    SpawnEnv {
        shell_env,
        prepend_dirs: Vec::new(),
        extra_env: Vec::new(),
        remove_env: Vec::new(),
    }
}

/// Whether an owned bridge keeps the shell variable `key`.
fn owned_env_keeps(key: &str, inherited: &[&str]) -> bool {
    matches!(
        key.to_ascii_uppercase().as_str(),
        "PATH"
            | "SYSTEMROOT"
            | "WINDIR"
            | "COMSPEC"
            | "PATHEXT"
            | "TEMP"
            | "TMP"
            | "USERPROFILE"
            | "APPDATA"
            | "LOCALAPPDATA"
            | "PROGRAMFILES"
            | "PROGRAMFILES(X86)"
            | "HOMEDRIVE"
            | "HOMEPATH"
            | "HOME"
    ) || inherited.iter().any(|kept| env_key::matches(key, kept))
}

/// The names a CLI answers to from a session's PATH: the current one first,
/// then the one the previous build installed, kept for one release so
/// installed skills and old transcripts that call it keep working. Both
/// shims run the same current binary.
#[cfg(feature = "flockctl")]
const FLOCKCTL_SHIM_STEMS: &[&str] = &["flockctl", "distillctl"];
#[cfg(feature = "flockctl")]
const FLOCK_MONITOR_SHIM_STEMS: &[&str] = &["flock-monitor", "distill-monitor"];
/// Where `just dev` (externalBin empty) says a binary is: the current
/// spelling first, the previous build's read as a fallback. The first one
/// that is set and not blank wins.
#[cfg(feature = "flockctl")]
const FLOCKCTL_BIN_ENV: &[&str] = &["FLOCKCTL_BIN", "DISTILLCTL_BIN"];
#[cfg(feature = "flockctl")]
const FLOCK_MONITOR_BIN_ENV: &[&str] = &["FLOCK_MONITOR_BIN", "DISTILL_MONITOR_BIN"];
/// The discovery lock a session is told about, under both spellings for one
/// release: a CLI from the previous build reads the old one.
#[cfg(feature = "flockctl")]
const FLOCKCTL_LOCK_ENV: &[&str] = &["FLOCKCTL_LOCK", "DISTILLCTL_LOCK"];
/// Set in every harness the app starts, so a `flockctl` call from an
/// agent's shell says it comes from an agent, and one from the operator's
/// own terminal — which never gets the variable — does not. It cannot say
/// WHICH session calls: one harness process serves every session of that
/// harness. The name avoids the words a harness strips from the
/// environment it hands its shells (KEY, SECRET, TOKEN).
#[cfg(feature = "flockctl")]
const FLOCK_AGENT_SHELL_ENV: &str = "FLOCK_AGENT_SHELL";

#[cfg(feature = "flockctl")]
fn install_flockctl_shims(
    app: &tauri::AppHandle,
    prepend_dirs: &mut Vec<PathBuf>,
    extra_env: &mut Vec<(String, String)>,
) {
    let flockctl_bin = resolve_cli_bin(FLOCKCTL_BIN_ENV, &binary_name("flockctl"));
    let flock_monitor_bin = resolve_cli_bin(FLOCK_MONITOR_BIN_ENV, &binary_name("flock-monitor"));
    let Ok(root) = crate::services::flock_root::app_root(app) else {
        return;
    };
    let shim_dir = root.join("cache").join("bin");
    sweep_replaced_shims(&shim_dir);
    let mut installed_any = false;
    for (cli_path, stems) in [
        (flockctl_bin.as_deref(), FLOCKCTL_SHIM_STEMS),
        (flock_monitor_bin.as_deref(), FLOCK_MONITOR_SHIM_STEMS),
    ] {
        if let Some(cli_path) = cli_path {
            installed_any |= create_cli_shims(&shim_dir, cli_path, stems);
        }
    }
    if installed_any {
        prepend_dirs.push(shim_dir);
    }
    // The broker writes its discovery file under the same root (the base the
    // plugin was handed at `init`), so a session is told the very file this
    // instance writes, whichever process tree it runs in.
    let lock_path = tauri_plugin_flockctl::discovery_file_path(&root, std::process::id())
        .to_string_lossy()
        .into_owned();
    extra_env.extend(cli_env_exports(&lock_path, flockctl_bin.as_deref()));
}

/// Every shim one CLI is reachable under; whether at least one was written.
/// A shim that cannot be written is logged and skipped so the others still
/// land.
#[cfg(feature = "flockctl")]
fn create_cli_shims(shim_dir: &Path, cli_path: &Path, stems: &[&str]) -> bool {
    let mut installed_any = false;
    for stem in stems {
        match create_cli_shim(shim_dir, cli_path, binary_name(stem)) {
            Ok(()) => installed_any = true,
            Err(error) => log::warn!("Skipping {stem} PATH shim: {error}"),
        }
    }
    installed_any
}

/// What a session is told so a bare `flockctl` — or the previous build's
/// `distillctl` — finds this app instance: the discovery lock, and the
/// binary itself when it could be resolved, each under both spellings.
#[cfg(feature = "flockctl")]
fn cli_env_exports(lock_path: &str, flockctl_bin: Option<&Path>) -> Vec<(String, String)> {
    let mut exports: Vec<(String, String)> = FLOCKCTL_LOCK_ENV
        .iter()
        .map(|key| (key.to_string(), lock_path.to_string()))
        .collect();
    match flockctl_bin {
        Some(bin) => exports.extend(
            FLOCKCTL_BIN_ENV
                .iter()
                .map(|key| (key.to_string(), bin.to_string_lossy().into_owned())),
        ),
        None => log::warn!("Skipping FLOCKCTL_BIN: could not resolve the flockctl binary path"),
    }
    exports.push((FLOCK_AGENT_SHELL_ENV.to_string(), "1".to_string()));
    exports
}

#[cfg(not(feature = "flockctl"))]
fn install_flockctl_shims(
    _app: &tauri::AppHandle,
    _prepend_dirs: &mut Vec<PathBuf>,
    _extra_env: &mut Vec<(String, String)>,
) {
}

/// Explicit env override (exported by `just dev`, where externalBin is
/// empty) wins; otherwise the externalBin sidecar sits next to the app
/// executable.
#[cfg(feature = "flockctl")]
fn resolve_cli_bin(override_envs: &[&str], binary_name: &str) -> Option<PathBuf> {
    resolve_cli_bin_with(|key| std::env::var(key).ok(), override_envs, binary_name)
}

/// `lookup` is the process environment: the first of `override_envs` that is
/// set and not blank names the binary, in the order given — the current
/// spelling before the previous build's.
#[cfg(feature = "flockctl")]
fn resolve_cli_bin_with(
    lookup: impl Fn(&str) -> Option<String>,
    override_envs: &[&str],
    binary_name: &str,
) -> Option<PathBuf> {
    if let Some(override_path) = override_envs
        .iter()
        .find_map(|key| lookup(key).filter(|value| !value.is_empty()))
    {
        return Some(PathBuf::from(override_path));
    }
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(binary_name))
}

#[cfg(feature = "flockctl")]
fn binary_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// Create or refresh the PATH shim that lets harness children run a bare
/// `flockctl`. Unix uses a symlink so the bundled binary stays authoritative;
/// Windows, where symlinks need elevated shells, keeps a copy of the binary
/// (see [`create_cli_shim_file`]).
#[cfg(feature = "flockctl")]
fn create_cli_shim(shim_dir: &Path, cli_path: &Path, shim_name: String) -> Result<(), String> {
    if !cli_path.exists() {
        return Err(format!(
            "agent CLI binary not found at {}",
            cli_path.display()
        ));
    }
    std::fs::create_dir_all(shim_dir)
        .map_err(|error| format!("failed to create {}: {error}", shim_dir.display()))?;
    create_cli_shim_file(cli_path, &shim_dir.join(shim_name))
}

#[cfg(all(feature = "flockctl", unix))]
fn create_cli_shim_file(cli_path: &Path, link: &Path) -> Result<(), String> {
    match std::fs::remove_file(link) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to remove stale shim {}: {error}",
                link.display()
            ));
        }
    }
    std::os::unix::fs::symlink(cli_path, link).map_err(|error| {
        format!(
            "failed to symlink {} -> {}: {error}",
            link.display(),
            cli_path.display()
        )
    })
}

/// The CLI itself, copied to `link`. A `.cmd` wrapper stood here and ran the
/// binary through cmd.exe, which ends an argument at its first line break and
/// reads `& | < > ^ %` as its own: a prompt of several lines reached the app
/// as its first line (11-14). An executable takes its arguments as they are
/// given. The copy is replaced when the binary changed; one still running (a
/// detached `flock-monitor`) cannot be overwritten, so it is moved aside.
#[cfg(all(feature = "flockctl", windows))]
fn create_cli_shim_file(cli_path: &Path, link: &Path) -> Result<(), String> {
    // The wrapper an earlier build left would still answer `<name>.cmd`.
    let _ = std::fs::remove_file(link.with_extension("cmd"));
    let stamp = |path: &Path| {
        std::fs::metadata(path)
            .ok()
            .map(|meta| (meta.len(), meta.modified().ok()))
    };
    // A copy keeps its source's size and modification time.
    if stamp(link).is_some() && stamp(link) == stamp(cli_path) {
        return Ok(());
    }
    if link.exists() && std::fs::remove_file(link).is_err() {
        let aside = link.with_extension(format!("old-{}", std::process::id()));
        let _ = std::fs::remove_file(&aside);
        std::fs::rename(link, &aside).map_err(|error| {
            format!(
                "failed to move the running {} aside: {error}",
                link.display()
            )
        })?;
    }
    std::fs::copy(cli_path, link).map(|_| ()).map_err(|error| {
        format!(
            "failed to copy {} to {}: {error}",
            cli_path.display(),
            link.display()
        )
    })
}

/// Removes the copies earlier starts moved aside (see
/// [`create_cli_shim_file`]) once nothing runs them any more.
#[cfg(all(feature = "flockctl", windows))]
fn sweep_replaced_shims(shim_dir: &Path) {
    for entry in std::fs::read_dir(shim_dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension.to_string_lossy().starts_with("old-"))
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(all(feature = "flockctl", not(windows)))]
fn sweep_replaced_shims(_shim_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_env_keeps_only_the_allowlist_and_requested_keys() {
        for key in ["Path", "SystemRoot", "TEMP", "USERPROFILE", "HomeDrive"] {
            assert!(owned_env_keeps(key, &[]), "{key}");
        }
        for key in [
            "ANTHROPIC_API_KEY",
            "CODEX_HOME",
            "XAI_API_KEY",
            "GROK_HOME",
            "NODE_OPTIONS",
            "FLOCKCTL_LOCK",
        ] {
            assert!(!owned_env_keeps(key, &[]), "{key}");
        }
        assert!(owned_env_keeps("xai_api_key", &["XAI_API_KEY"]));
        assert!(!owned_env_keeps("XAI_API_KEY_FILE", &["XAI_API_KEY"]));
        assert!(!owned_env_keeps("GROK_HOME", &["XAI_API_KEY"]));
    }

    /// The previous build's names are kept beside the current ones, not
    /// renamed to them: a mechanical rename that touched them would collapse
    /// each pair into one name and silently drop the compatibility.
    #[cfg(feature = "flockctl")]
    #[test]
    fn the_previous_names_are_not_the_current_ones() {
        for (list, current) in [
            (FLOCKCTL_SHIM_STEMS, "flockctl"),
            (FLOCK_MONITOR_SHIM_STEMS, "flock-monitor"),
            (FLOCKCTL_BIN_ENV, "FLOCKCTL_BIN"),
            (FLOCK_MONITOR_BIN_ENV, "FLOCK_MONITOR_BIN"),
            (FLOCKCTL_LOCK_ENV, "FLOCKCTL_LOCK"),
        ] {
            assert_eq!(list[0], current);
            assert_eq!(list.len(), 2, "{current}: one current name, one previous");
            assert_ne!(list[1], list[0], "{current}: the previous name differs");
        }
        assert_eq!(FLOCKCTL_SHIM_STEMS[1], "distillctl");
        assert_eq!(FLOCK_MONITOR_SHIM_STEMS[1], "distill-monitor");
        assert_eq!(FLOCKCTL_BIN_ENV[1], "DISTILLCTL_BIN");
        assert_eq!(FLOCK_MONITOR_BIN_ENV[1], "DISTILL_MONITOR_BIN");
        assert_eq!(FLOCKCTL_LOCK_ENV[1], "DISTILLCTL_LOCK");
    }

    /// Both CLIs land on PATH under their current name and the previous
    /// build's: four shims, every one running the current binary, and on
    /// Windows none of them a `.cmd` wrapper, which cut a prompt of several
    /// lines at its first.
    #[cfg(feature = "flockctl")]
    #[test]
    fn the_shims_cover_the_current_and_the_previous_names() {
        let dir = tempfile::tempdir().unwrap();
        let flockctl = dir.path().join(binary_name("flockctl"));
        let monitor = dir.path().join(binary_name("flock-monitor"));
        std::fs::write(&flockctl, "cli").unwrap();
        std::fs::write(&monitor, "monitor").unwrap();
        let shim_dir = dir.path().join("cache").join("bin");
        // What an earlier build left: its wrapper is retired.
        std::fs::create_dir_all(&shim_dir).unwrap();
        if cfg!(windows) {
            std::fs::write(shim_dir.join("flockctl.cmd"), "@echo off\r\n").unwrap();
        }

        assert!(create_cli_shims(&shim_dir, &flockctl, FLOCKCTL_SHIM_STEMS));
        assert!(create_cli_shims(
            &shim_dir,
            &monitor,
            FLOCK_MONITOR_SHIM_STEMS
        ));
        // A second run refreshes the same four, nothing more.
        assert!(create_cli_shims(&shim_dir, &flockctl, FLOCKCTL_SHIM_STEMS));

        let mut names: Vec<String> = std::fs::read_dir(&shim_dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let mut expected: Vec<String> =
            ["distill-monitor", "distillctl", "flock-monitor", "flockctl"]
                .iter()
                .map(|stem| binary_name(stem))
                .collect();
        expected.sort();
        assert_eq!(names, expected);
        for (stem, target) in [
            ("flockctl", &flockctl),
            ("distillctl", &flockctl),
            ("flock-monitor", &monitor),
            ("distill-monitor", &monitor),
        ] {
            assert!(
                shim_runs(&shim_dir.join(binary_name(stem)), target),
                "{stem} runs {}",
                target.display()
            );
        }
    }

    /// What a shim at `link` runs: the binary's own bytes on Windows, the
    /// symlink's target elsewhere.
    #[cfg(feature = "flockctl")]
    fn shim_runs(link: &Path, target: &Path) -> bool {
        if cfg!(windows) {
            std::fs::read(link).unwrap() == std::fs::read(target).unwrap()
        } else {
            std::fs::read_link(link).unwrap() == target
        }
    }

    /// A binary an update replaced reaches its shim, a shim that is current
    /// is left alone, and the copies moved aside are swept.
    #[cfg(all(feature = "flockctl", windows))]
    #[test]
    fn a_shim_follows_its_binary_through_an_update() {
        let dir = tempfile::tempdir().unwrap();
        let flockctl = dir.path().join(binary_name("flockctl"));
        let shim_dir = dir.path().join("bin");
        let shim = shim_dir.join(binary_name("flockctl"));
        std::fs::write(&flockctl, "first build").unwrap();
        assert!(create_cli_shims(&shim_dir, &flockctl, &["flockctl"]));
        assert_eq!(std::fs::read_to_string(&shim).unwrap(), "first build");
        std::fs::write(&flockctl, "the second build").unwrap();
        assert!(create_cli_shims(&shim_dir, &flockctl, &["flockctl"]));
        assert_eq!(std::fs::read_to_string(&shim).unwrap(), "the second build");
        let aside = shim.with_extension("old-1");
        std::fs::write(&aside, "moved aside").unwrap();
        sweep_replaced_shims(&shim_dir);
        assert!(!aside.exists());
        assert!(shim.exists());
    }

    /// A shim whose binary is missing is skipped; the one beside it is still
    /// written, and the caller still learns that a shim landed.
    #[cfg(feature = "flockctl")]
    #[test]
    fn a_missing_binary_skips_its_shims_only() {
        let dir = tempfile::tempdir().unwrap();
        let shim_dir = dir.path().join("bin");
        let missing = dir.path().join(binary_name("flockctl"));

        assert!(!create_cli_shims(&shim_dir, &missing, FLOCKCTL_SHIM_STEMS));
        assert!(!shim_dir.exists());
    }

    /// `just dev` from the previous build exports the previous spelling: it
    /// is read when the current one is absent or blank, and the current one
    /// wins when both are set.
    #[cfg(feature = "flockctl")]
    #[test]
    fn the_previous_env_spelling_is_read_as_a_fallback() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| value.to_string())
            }
        };
        let resolve = |pairs| resolve_cli_bin_with(env(pairs), FLOCKCTL_BIN_ENV, "flockctl.exe");

        assert_eq!(
            resolve(&[("DISTILLCTL_BIN", "C:/old/flockctl.exe")]),
            Some(PathBuf::from("C:/old/flockctl.exe"))
        );
        assert_eq!(
            resolve(&[
                ("FLOCKCTL_BIN", "C:/new/flockctl.exe"),
                ("DISTILLCTL_BIN", "C:/old/flockctl.exe"),
            ]),
            Some(PathBuf::from("C:/new/flockctl.exe"))
        );
        assert_eq!(
            resolve(&[
                ("FLOCKCTL_BIN", ""),
                ("DISTILLCTL_BIN", "C:/old/flockctl.exe")
            ]),
            Some(PathBuf::from("C:/old/flockctl.exe"))
        );
        // Neither set: the sidecar beside the running executable.
        let beside_exe = resolve(&[]).unwrap();
        assert_eq!(beside_exe.file_name().unwrap(), "flockctl.exe");
        assert_eq!(
            beside_exe.parent().unwrap(),
            std::env::current_exe().unwrap().parent().unwrap()
        );
        assert_eq!(
            resolve_cli_bin_with(
                env(&[("DISTILL_MONITOR_BIN", "C:/old/flock-monitor.exe")]),
                FLOCK_MONITOR_BIN_ENV,
                "flock-monitor.exe"
            ),
            Some(PathBuf::from("C:/old/flock-monitor.exe"))
        );
    }

    /// A session is told the lock and the binary under both spellings, with
    /// the same values; without a resolved binary only the lock is exported.
    #[cfg(feature = "flockctl")]
    #[test]
    fn a_session_is_told_both_spellings() {
        let exports = cli_env_exports(
            "C:/data/flockctl/control-1.json",
            Some(Path::new("C:/app/flockctl.exe")),
        );
        assert_eq!(
            exports,
            vec![
                (
                    "FLOCKCTL_LOCK".to_string(),
                    "C:/data/flockctl/control-1.json".to_string()
                ),
                (
                    "DISTILLCTL_LOCK".to_string(),
                    "C:/data/flockctl/control-1.json".to_string()
                ),
                (
                    "FLOCKCTL_BIN".to_string(),
                    "C:/app/flockctl.exe".to_string()
                ),
                (
                    "DISTILLCTL_BIN".to_string(),
                    "C:/app/flockctl.exe".to_string()
                ),
                ("FLOCK_AGENT_SHELL".to_string(), "1".to_string()),
            ]
        );
        let keys: std::collections::BTreeSet<_> =
            exports.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(
            keys.len(),
            exports.len(),
            "every spelling is its own variable"
        );

        let lock_only = cli_env_exports("lock", None);
        assert_eq!(
            lock_only,
            vec![
                ("FLOCKCTL_LOCK".to_string(), "lock".to_string()),
                ("DISTILLCTL_LOCK".to_string(), "lock".to_string()),
                ("FLOCK_AGENT_SHELL".to_string(), "1".to_string()),
            ]
        );
    }
}
