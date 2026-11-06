//! Steering a Kimi Code chat.
//!
//! Kimi Code's ACP server refuses a message while a turn runs, though its
//! engine takes one into the running turn, as Kimi's own terminal does. The
//! host loads a preload (`resources/kimi-acp-steering.mjs`) into the Kimi
//! process it starts for a chat. The preload gives the server the
//! `_session/steering` request Claude Code's adapter has, and advertises it
//! only when every one of its edits applied to the Kimi version that runs.
//! The host steers a chat only through a bridge that advertises it
//! (`router/steering.rs`); any other Kimi keeps a message queued until its
//! turn ends.

use std::path::Path;

use base64::Engine as _;

use super::bridge::SpawnEnv;
use crate::services::env_key;

const PRELOAD: &str = include_str!("../../../resources/kimi-acp-steering.mjs");

/// The `NODE_OPTIONS` entry that loads the preload. The preload takes it out
/// of its own process's environment again, so nothing Kimi starts loads it.
fn import_option() -> String {
    format!(
        "--import=data:text/javascript;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(PRELOAD)
    )
}

/// `NODE_OPTIONS` for a Kimi Code bridge: the user's own options, then the
/// preload.
fn node_options(existing: Option<&str>) -> String {
    let import = import_option();
    match existing
        .map(str::trim)
        .filter(|options| !options.is_empty())
    {
        Some(existing) => format!("{existing} {import}"),
        None => import,
    }
}

/// Whether `executable`, what `kimi` resolves to, starts Kimi Code's Node
/// CLI: npm's Windows launcher of `@moonshot-ai/kimi-code`, or a link to its
/// entrypoint. Another `kimi` gets no preload, and no Node it starts sees one.
fn launches_kimi_code(executable: &Path) -> bool {
    if executable
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        return std::fs::read_to_string(executable).is_ok_and(|body| {
            body.to_ascii_lowercase()
                .contains(r"node_modules\@moonshot-ai\kimi-code\dist\main.mjs")
        });
    }
    std::fs::canonicalize(executable).is_ok_and(|target| {
        target.ends_with(Path::new(
            "node_modules/@moonshot-ai/kimi-code/dist/main.mjs",
        ))
    })
}

/// The `NODE_OPTIONS` a chat's Kimi bridge starts with, when `executable` is
/// Kimi Code's CLI: the options it would inherit, from the host's variables,
/// the login shell or Flock's own environment, with the preload after them.
pub(super) fn bridge_node_options(executable: &Path, env: &SpawnEnv) -> Option<String> {
    if !launches_kimi_code(executable) {
        return None;
    }
    let inherited = env
        .extra_env
        .iter()
        .rev()
        .find(|(key, _)| env_key::matches(key, "NODE_OPTIONS"))
        .map(|(_, value)| value.clone())
        .or_else(|| env_key::get(&env.shell_env, "NODE_OPTIONS").map(str::to_string))
        .or_else(|| crate::services::shell_env::user_env_var("NODE_OPTIONS"));
    Some(node_options(inherited.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(shell: &[(&str, &str)], extra: &[(&str, &str)]) -> SpawnEnv {
        SpawnEnv {
            shell_env: shell
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect::<HashMap<_, _>>(),
            prepend_dirs: Vec::new(),
            extra_env: extra
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
            remove_env: Vec::new(),
        }
    }

    /// npm's launcher, as `npm install -g @moonshot-ai/kimi-code` writes it.
    const NPM_LAUNCHER: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@moonshot-ai\\kimi-code\\dist\\main.mjs\" %*\r\n";

    #[test]
    fn only_kimi_codes_launcher_gets_the_preload() {
        let dir = tempfile::tempdir().unwrap();
        let kimi = dir.path().join("kimi.cmd");
        std::fs::write(&kimi, NPM_LAUNCHER).unwrap();
        let other = dir.path().join("other.cmd");
        std::fs::write(
            &other,
            NPM_LAUNCHER.replace("@moonshot-ai\\kimi-code", "@example\\kimi"),
        )
        .unwrap();
        let options = bridge_node_options(&kimi, &env(&[], &[])).unwrap();
        assert!(options.starts_with("--import=data:text/javascript;base64,"));
        assert!(!options.contains(' '), "{options}");
        assert_eq!(bridge_node_options(&other, &env(&[], &[])), None);
        assert_eq!(
            bridge_node_options(&dir.path().join("kimi.exe"), &env(&[], &[])),
            None
        );
    }

    #[test]
    fn the_users_own_node_options_come_first_and_stay() {
        let dir = tempfile::tempdir().unwrap();
        let kimi = dir.path().join("kimi.cmd");
        std::fs::write(&kimi, NPM_LAUNCHER).unwrap();
        let import = import_option();
        assert_eq!(
            bridge_node_options(
                &kimi,
                &env(&[("Node_Options", " --max-old-space-size=4096 ")], &[])
            ),
            Some(format!("--max-old-space-size=4096 {import}"))
        );
        // What the host sets wins over the login shell, as it does on spawn.
        assert_eq!(
            bridge_node_options(
                &kimi,
                &env(
                    &[("NODE_OPTIONS", "--shell")],
                    &[("NODE_OPTIONS", "--host")]
                )
            ),
            Some(format!("--host {import}"))
        );
    }

    #[test]
    fn the_preload_edits_kimi_only_when_its_anchors_hold_and_removes_itself() {
        // The preload's contract with the host: what it advertises, the
        // request it answers, the outcomes the host reads, and that its own
        // NODE_OPTIONS entry leaves the environment Kimi passes on.
        for needle in [
            "_meta: { steering: { supported: true } }",
            "\"_session/steering\"",
            "outcome: \"promptRequired\"",
            "outcome: \"injected\"",
            "outcome: \"startedNewTurn\"",
            "const own = `--import=${import.meta.url}`;",
            "if (parts.length !== 2) return { missing: name };",
        ] {
            assert!(PRELOAD.contains(needle), "{needle}");
        }
    }
}
