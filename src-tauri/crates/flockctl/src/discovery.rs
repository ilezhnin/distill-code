//! Discovery-file resolution: how flockctl finds the app's control endpoint.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::client::Failure;

/// Wire-protocol version this binary speaks. Duplicated by hand from
/// `PROTOCOL_VERSION` in the `tauri-plugin-flockctl` crate
/// (src-tauri/plugins/flockctl) — the CLI does not depend on the plugin
/// crate; bump both copies together.
pub const PROTOCOL_VERSION: u32 = 6;

/// Exact wording pinned by the implementation spec: the missing env var is the
/// provenance signal that we are not running under the app.
pub const NOT_UNDER_APP: &str =
    "flockctl must run inside a Levocat Flock desktop app session (the app sets this up automatically)";

/// Environment variable the app sets in every agent session it spawns; clap
/// merges it into `--lock-path`.
pub const LOCK_ENV: &str = "FLOCKCTL_LOCK";

/// The same variable under the name the app exported while it shipped as
/// Distill. An agent session started by that app (or a harness that copied
/// its environment) still carries it, so it is read as a fallback. clap reads
/// one name per argument, so the fallback is resolved in code.
pub const LEGACY_LOCK_ENV: &str = "DISTILLCTL_LOCK";

const REREAD_DELAY: Duration = Duration::from_millis(200);

/// Shape of the discovery file the flockctl broker writes on start
/// (`<Flock root>/flockctl/control-<app-pid>.json`; the app names the exact
/// path in `FLOCKCTL_LOCK`, this binary never looks for it). Duplicated by
/// hand from the writer's struct in `tauri-plugin-flockctl`; keep in sync.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryFile {
    pub port: u16,
    pub pid: u32,
    pub generation: u64,
    pub protocol_version: u32,
}

/// The lock path comes from `--lock-path` or `FLOCKCTL_LOCK` (clap merges
/// the two), then from `DISTILLCTL_LOCK`; an empty value is as good as unset.
pub fn resolve_lock_path(arg: Option<PathBuf>) -> Result<PathBuf, Failure> {
    resolve_lock_path_with(arg, std::env::var_os(LEGACY_LOCK_ENV).map(PathBuf::from))
}

fn resolve_lock_path_with(
    arg: Option<PathBuf>,
    legacy: Option<PathBuf>,
) -> Result<PathBuf, Failure> {
    arg.into_iter()
        .chain(legacy)
        .find(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| Failure::env(NOT_UNDER_APP))
}

pub fn parse(contents: &str) -> Result<DiscoveryFile, String> {
    serde_json::from_str(contents).map_err(|err| format!("discovery file is not valid: {err}"))
}

pub fn load(path: &Path) -> Result<DiscoveryFile, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
    parse(&contents)
}

/// The broker writes the file atomically, so a read/parse failure is either
/// transient (broker restarting) or means the app is gone; one short retry
/// distinguishes the two.
pub fn load_with_retry(path: &Path) -> Result<DiscoveryFile, Failure> {
    load(path)
        .or_else(|_| {
            std::thread::sleep(REREAD_DELAY);
            load(path)
        })
        .map_err(|err| {
            Failure::env(format!(
                "the Flock desktop app's control endpoint is unavailable ({err}); \
                 the app may not be running or app control may be disabled. \
                 confirm Flock is running, app control is enabled, and this \
                 command is running inside a Flock-started agent session."
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"{"port":52341,"pid":4242,"generation":3,"protocolVersion":1}"#;

    #[test]
    fn parses_a_valid_discovery_file() {
        let file = parse(VALID).expect("valid file parses");
        assert_eq!(
            file,
            DiscoveryFile {
                port: 52341,
                pid: 4242,
                generation: 3,
                protocol_version: 1,
            }
        );
    }

    #[test]
    fn tolerates_unknown_fields_for_forward_compat() {
        let file = parse(r#"{"port":1,"pid":2,"generation":3,"protocolVersion":1,"token":"x"}"#)
            .expect("unknown fields are ignored");
        assert_eq!(file.port, 1);
    }

    #[test]
    fn rejects_truncated_json() {
        // A partial write must never yield a usable endpoint.
        assert!(parse(r#"{"port":52341,"pid":4242,"gen"#).is_err());
    }

    #[test]
    fn missing_lock_path_is_exit_3_with_the_pinned_message() {
        let failure = resolve_lock_path_with(None, None).expect_err("missing path fails");
        assert_eq!(failure.exit, crate::client::EXIT_ENV);
        assert_eq!(failure.message, NOT_UNDER_APP);
    }

    #[test]
    fn the_current_lock_path_wins_over_the_legacy_variable() {
        let resolved = resolve_lock_path_with(
            Some(PathBuf::from("current.json")),
            Some(PathBuf::from("legacy.json")),
        )
        .expect("current path resolves");
        assert_eq!(resolved, PathBuf::from("current.json"));
    }

    #[test]
    fn the_legacy_variable_is_read_when_the_current_one_is_unset_or_empty() {
        for current in [None, Some(PathBuf::new())] {
            let resolved = resolve_lock_path_with(current, Some(PathBuf::from("legacy.json")))
                .expect("legacy path resolves");
            assert_eq!(resolved, PathBuf::from("legacy.json"));
        }
        let failure = resolve_lock_path_with(None, Some(PathBuf::new()))
            .expect_err("an empty legacy value is as good as unset");
        assert_eq!(failure.message, NOT_UNDER_APP);
    }

    /// Compatibility pin: the fallback only works while it names the variable
    /// the Distill-era app exported, so the two names must stay distinct. A
    /// rename sweep that rewrites the legacy name collapses them and fails here.
    #[test]
    fn the_legacy_lock_variable_keeps_its_old_name() {
        assert_eq!(LOCK_ENV, "FLOCKCTL_LOCK");
        assert_ne!(LEGACY_LOCK_ENV, LOCK_ENV);
        assert!(!LEGACY_LOCK_ENV.contains("FLOCK"));
        assert!(LEGACY_LOCK_ENV.ends_with("CTL_LOCK"));
    }
}
