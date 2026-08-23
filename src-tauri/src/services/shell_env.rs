//! Environment hygiene for the subprocesses Berd spawns.
//!
//! Two policies live here and [`sanitize_shell_env`] applies both:
//!
//! 1. Repository tool-manager state captured from the user's shell (Hermit
//!    activation, npm prefix overrides). Berd resolves project tooling itself.
//! 2. The identity of whatever launched Berd. Terminal emulators, multiplexers,
//!    and coding-agent hosts (Orca, Claude Code, Codex, Grok) stamp their
//!    children with per-pane / per-session variables, and the agent CLIs carry
//!    host-installed hooks that report any session running with those
//!    variables back to the host. Berd's long-lived backend (`goose serve`) and
//!    the per-session ACP bridges it spawns are not children of that pane:
//!    inheriting its identity makes every Berd chat show up inside the terminal
//!    that happened to run Berd, and Orca's redirected `CODEX_HOME` would route
//!    Codex sessions through Orca's account instead of the user's own.
//!
//! A captured shell environment is a map, but a `Command` that layers that map
//! onto the live process environment still inherits everything the map was
//! scrubbed of. [`remove_inherited_launcher_env`] closes that second path.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path};

use crate::services::env_key;

/// Orca's per-pane runtime state: pane key, tab id, terminal handle, launch
/// token, agent-hook endpoint/port/token, mirrored config redirects,
/// workspace/worktree ids, app metadata.
const ORCA_PREFIX: &str = "ORCA_";
/// Orca's user-data root. Config-dir redirects Orca injects (`CODEX_HOME`,
/// `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`, ...) point inside it.
const ORCA_USER_DATA_PATH: &str = "ORCA_USER_DATA_PATH";

/// Variables terminal emulators and multiplexers set to identify the pane a
/// process runs in. A desktop app's backend runs in no pane at all.
const TERMINAL_SESSION_VARS: &[&str] = &[
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TERM_SESSION_ID",
    "ITERM_SESSION_ID",
    "ITERM_PROFILE",
    "WT_SESSION",
    "WT_PROFILE_ID",
    "TMUX",
    "TMUX_PANE",
    "STY",
    "WINDOWID",
    "KITTY_WINDOW_ID",
    "KITTY_PID",
    "WEZTERM_PANE",
    "WEZTERM_UNIX_SOCKET",
    "ALACRITTY_WINDOW_ID",
];

/// Variables a running coding agent stamps on the processes it starts.
/// Deliberate user configuration (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_EXECUTABLE`,
/// `CODEX_HOME`, `GROK_HOME`, API keys) is intentionally not listed; Orca's
/// injected config redirects are handled by [`OrcaContext`] instead.
const AGENT_SESSION_VARS: &[&str] = &[
    // Claude Code CLI: nested-session guard, parent identity, IPC back to the
    // parent, IDE attach port.
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SSE_PORT",
    // Codex CLI: sandbox markers for commands it executes.
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    // Grok CLI: agent marker and session id.
    "GROK_AGENT",
    "GROK_SESSION_ID",
];

pub fn sanitize_shell_env(env: &mut HashMap<String, String>) {
    let removable = removable_keys(env);
    env.retain(|key, _| !removable.contains(key));
}

/// Remove launcher identity the child would otherwise inherit from the live
/// process environment. Use on every `Command` that layers a captured
/// environment instead of clearing it.
pub fn remove_inherited_launcher_env(command: &mut std::process::Command) {
    for key in inherited_env_keys_to_remove() {
        command.env_remove(key);
    }
}

/// Keys of the current process environment that [`sanitize_shell_env`] would
/// drop, spelled exactly as the process sees them.
pub fn inherited_env_keys_to_remove() -> Vec<String> {
    removable_keys(&process_env()).into_iter().collect()
}

/// Read a variable from this process's environment unless it is launcher
/// identity. Berd's own reads of agent config locations (`CODEX_HOME`,
/// `GROK_HOME`, ...) go through here so an Orca-injected redirect steers
/// neither the sessions Berd spawns nor the credentials and config it shows.
pub fn user_env_var(key: &str) -> Option<String> {
    let env = process_env();
    let removable = removable_keys(&env);
    if removable
        .iter()
        .any(|removed| env_key::matches(removed, key))
    {
        return None;
    }
    env_key::get(&env, key).map(str::to_string)
}

fn process_env() -> HashMap<String, String> {
    std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

fn removable_keys(env: &HashMap<String, String>) -> HashSet<String> {
    let orca = OrcaContext::from_env(env);
    env.iter()
        .filter(|(key, value)| should_remove_env_var(key, value, &orca))
        .map(|(key, _)| key.clone())
        .collect()
}

fn should_remove_env_var(key: &str, value: &str, orca: &OrcaContext) -> bool {
    let upper_key = key.to_ascii_uppercase();

    if upper_key.starts_with("HERMIT_") || upper_key.starts_with(ORCA_PREFIX) {
        return true;
    }

    if matches!(
        upper_key.as_str(),
        "NPM_CONFIG_PREFIX" | "NPM_CONFIG_CACHE" | "COREPACK_HOME"
    ) {
        return true;
    }

    if TERMINAL_SESSION_VARS.contains(&upper_key.as_str())
        || AGENT_SESSION_VARS.contains(&upper_key.as_str())
    {
        return true;
    }

    if upper_key == "PATH" {
        return false;
    }

    orca.injected(&upper_key, value) || contains_hermit_path_component(value)
}

/// Evidence that a non-`ORCA_` variable was injected by Orca rather than set
/// by the user.
struct OrcaContext {
    /// `ORCA_<NAME>` twins Orca publishes next to the `<NAME>` it overrides
    /// (`ORCA_CODEX_HOME` / `CODEX_HOME`), keyed by upper-cased `<NAME>`.
    mirrored: HashMap<String, String>,
    /// `ORCA_USER_DATA_PATH`, when present: Orca's config redirects live
    /// under it, a user's own never do.
    user_data_root: Option<String>,
}

impl OrcaContext {
    fn from_env(env: &HashMap<String, String>) -> Self {
        let mut mirrored = HashMap::new();
        let mut user_data_root = None;
        for (key, value) in env {
            let upper_key = key.to_ascii_uppercase();
            let Some(name) = upper_key.strip_prefix(ORCA_PREFIX) else {
                continue;
            };
            if upper_key == ORCA_USER_DATA_PATH {
                user_data_root = Some(value.clone()).filter(|root| !root.is_empty());
            }
            if !name.is_empty() {
                mirrored.insert(name.to_string(), value.clone());
            }
        }
        Self {
            mirrored,
            user_data_root,
        }
    }

    fn injected(&self, upper_key: &str, value: &str) -> bool {
        if self
            .mirrored
            .get(upper_key)
            .is_some_and(|mirrored| mirrored == value)
        {
            return true;
        }
        self.user_data_root
            .as_deref()
            .is_some_and(|root| path_is_within(value, root))
    }
}

/// `true` when `value` is a path strictly inside `root`. Components are
/// compared case-insensitively on Windows, matching its filesystem.
fn path_is_within(value: &str, root: &str) -> bool {
    let root: Vec<String> = normalized_components(root);
    let value: Vec<String> = normalized_components(value);
    !root.is_empty() && value.len() > root.len() && value.starts_with(&root)
}

fn normalized_components(path: &str) -> Vec<String> {
    Path::new(path)
        .components()
        .filter(|component| !matches!(component, Component::CurDir))
        .map(|component| {
            let text = component.as_os_str().to_string_lossy();
            if cfg!(windows) {
                text.to_ascii_lowercase()
            } else {
                text.into_owned()
            }
        })
        .collect()
}

pub(crate) fn contains_hermit_path_component(value: &str) -> bool {
    value
        .split(['/', '\\'])
        .any(|component| component.eq_ignore_ascii_case(".hermit"))
}

#[cfg(test)]
mod tests {
    use super::{
        inherited_env_keys_to_remove, remove_inherited_launcher_env, sanitize_shell_env,
        user_env_var,
    };
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn temp_path(segments: &[&str]) -> String {
        let mut path = std::env::temp_dir();
        for segment in segments {
            path.push(segment);
        }
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn sanitize_shell_env_removes_repo_tool_manager_state() {
        let mut env = HashMap::from([
            ("HOME".to_string(), "/Users/morganm".to_string()),
            (
                "HERMIT_ENV".to_string(),
                "/Users/morganm/Development/repo".to_string(),
            ),
            (
                "NPM_CONFIG_PREFIX".to_string(),
                "/Users/morganm/Development/repo/.hermit/node".to_string(),
            ),
            (
                "COREPACK_HOME".to_string(),
                "/Users/morganm/Development/repo/.hermit/node".to_string(),
            ),
            (
                "CUSTOM_TOOL_HOME".to_string(),
                "C:\\repo\\.HeRmIt\\tool".to_string(),
            ),
            (
                "PATH".to_string(),
                "/Users/morganm/Development/repo/.hermit/bin:/usr/bin".to_string(),
            ),
        ]);

        sanitize_shell_env(&mut env);

        assert_eq!(env.get("HOME"), Some(&"/Users/morganm".to_string()));
        assert_eq!(
            env.get("PATH"),
            Some(&"/Users/morganm/Development/repo/.hermit/bin:/usr/bin".to_string())
        );
        assert!(!env.contains_key("HERMIT_ENV"));
        assert!(!env.contains_key("NPM_CONFIG_PREFIX"));
        assert!(!env.contains_key("COREPACK_HOME"));
        assert!(!env.contains_key("CUSTOM_TOOL_HOME"));
    }

    #[test]
    fn sanitize_shell_env_removes_terminal_pane_and_agent_session_identity() {
        let mut env = env(&[
            ("HOME", "/Users/morganm"),
            ("PATH", "/usr/bin"),
            ("ORCA_PANE_KEY", "tab:pane"),
            ("ORCA_TAB_ID", "tab"),
            ("ORCA_TERMINAL_HANDLE", "term_1"),
            ("ORCA_AGENT_LAUNCH_TOKEN", "launch"),
            ("ORCA_AGENT_HOOK_PORT", "64252"),
            ("ORCA_AGENT_HOOK_TOKEN", "hook"),
            ("orca_worktree_id", "ws::/repo"),
            ("TERM_PROGRAM", "Orca"),
            ("TERM_PROGRAM_VERSION", "1.4.187"),
            ("TMUX", "/tmp/tmux-501/default,123,0"),
            ("WT_SESSION", "guid"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_PID", "65796"),
            ("CLAUDE_CODE_SESSION_ID", "session"),
            ("CLAUDE_CODE_CHILD_SESSION", "1"),
            ("CLAUDE_CODE_ENTRYPOINT", "cli"),
            ("CLAUDE_CODE_EXECPATH", "/opt/claude"),
            ("CLAUDE_CODE_MESSAGING_SOCKET", "\\\\.\\pipe\\cc-msg"),
            ("CLAUDE_CODE_MESSAGING_TOKEN", "token"),
            ("CODEX_SANDBOX_NETWORK_DISABLED", "1"),
            ("GROK_AGENT", "1"),
            ("GROK_SESSION_ID", "01a0"),
            // Deliberate user configuration stays.
            ("CLAUDE_CONFIG_DIR", "/Users/morganm/.claude-work"),
            ("CLAUDE_CODE_EXECUTABLE", "/opt/claude/claude"),
            ("CODEX_HOME", "/Users/morganm/.codex"),
            ("GROK_HOME", "/Users/morganm/.grok"),
            ("XAI_API_KEY", "xai-secret"),
            ("ANTHROPIC_API_KEY", "sk-secret"),
            ("TERM", "xterm-256color"),
        ]);

        sanitize_shell_env(&mut env);

        let mut remaining: Vec<&str> = env.keys().map(String::as_str).collect();
        remaining.sort_unstable();
        assert_eq!(
            remaining,
            vec![
                "ANTHROPIC_API_KEY",
                "CLAUDE_CODE_EXECUTABLE",
                "CLAUDE_CONFIG_DIR",
                "CODEX_HOME",
                "GROK_HOME",
                "HOME",
                "PATH",
                "TERM",
                "XAI_API_KEY",
            ]
        );
    }

    #[test]
    fn sanitize_shell_env_removes_config_redirects_orca_mirrors() {
        let orca_codex_home = temp_path(&["orca", "codex-accounts", "acct", "home"]);
        let mut env = env(&[
            ("ORCA_CODEX_HOME", orca_codex_home.as_str()),
            ("CODEX_HOME", orca_codex_home.as_str()),
            ("ORCA_OPENCODE_CONFIG_DIR", "/shared/opencode"),
            ("OPENCODE_CONFIG_DIR", "/shared/opencode"),
            // The user overrode Orca's redirect with their own value: keep it.
            ("ORCA_GROK_HOME", "/orca/grok"),
            ("GROK_HOME", "/Users/morganm/.grok"),
        ]);

        sanitize_shell_env(&mut env);

        assert_eq!(
            env,
            HashMap::from([("GROK_HOME".to_string(), "/Users/morganm/.grok".to_string())])
        );
    }

    #[test]
    fn sanitize_shell_env_removes_config_redirects_inside_orca_user_data() {
        let user_data = temp_path(&["orca"]);
        let claude_account = temp_path(&["orca", "claude-accounts", "acct"]);
        let codex_account = temp_path(&["orca", "codex-accounts", "acct"]);
        // Sibling of the Orca root, not inside it.
        let grok_home = temp_path(&["orca-backup", "grok"]);
        // A user's own config dir elsewhere.
        let opencode_dir = temp_path(&["dotfiles", "opencode"]);
        let mut env = env(&[
            ("ORCA_USER_DATA_PATH", user_data.as_str()),
            ("CLAUDE_CONFIG_DIR", claude_account.as_str()),
            ("CODEX_HOME", codex_account.as_str()),
            ("GROK_HOME", grok_home.as_str()),
            ("OPENCODE_CONFIG_DIR", opencode_dir.as_str()),
        ]);

        sanitize_shell_env(&mut env);

        let mut remaining: Vec<&str> = env.keys().map(String::as_str).collect();
        remaining.sort_unstable();
        assert_eq!(remaining, vec!["GROK_HOME", "OPENCODE_CONFIG_DIR"]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_orca_user_data_match_ignores_case_and_separator_style() {
        let mut env = env(&[
            (
                "ORCA_USER_DATA_PATH",
                "C:\\Users\\User\\AppData\\Roaming\\orca",
            ),
            (
                "CODEX_HOME",
                "c:/users/user/appdata/roaming/ORCA/codex-accounts/acct/home",
            ),
        ]);

        sanitize_shell_env(&mut env);

        assert!(env.is_empty(), "{env:?}");
    }

    #[test]
    fn sanitize_shell_env_keeps_user_config_without_orca_evidence() {
        let mut env = env(&[
            ("CODEX_HOME", "/Users/morganm/.codex"),
            ("CLAUDE_CONFIG_DIR", "/Users/morganm/.claude"),
            ("OPENCODE_CONFIG_DIR", "/Users/morganm/.config/opencode"),
        ]);
        let expected = env.clone();

        sanitize_shell_env(&mut env);

        assert_eq!(env, expected);
    }

    #[test]
    fn remove_inherited_launcher_env_unsets_process_variables_on_command() {
        // Unique names so parallel tests never observe each other.
        const PANE: &str = "ORCA_PANE_KEY_SHELL_ENV_TEST_7F1C";
        const SAFE: &str = "BERD_SHELL_ENV_TEST_KEEP_7F1C";
        std::env::set_var(PANE, "tab:pane");
        std::env::set_var(SAFE, "keep");

        let keys = inherited_env_keys_to_remove();
        assert!(keys.iter().any(|key| key == PANE), "{keys:?}");
        assert!(!keys.iter().any(|key| key == SAFE), "{keys:?}");

        let mut command = std::process::Command::new("goose");
        remove_inherited_launcher_env(&mut command);
        let removed: Vec<String> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        assert!(removed.iter().any(|key| key == PANE), "{removed:?}");
        assert!(!removed.iter().any(|key| key == SAFE), "{removed:?}");

        std::env::remove_var(PANE);
        std::env::remove_var(SAFE);
    }

    #[test]
    fn user_env_var_ignores_launcher_identity_but_reads_user_config() {
        const PANE: &str = "ORCA_TAB_ID_SHELL_ENV_TEST_9A2D";
        const CONFIG: &str = "BERD_SHELL_ENV_TEST_CONFIG_DIR_9A2D";
        std::env::set_var(PANE, "tab");
        std::env::set_var(CONFIG, "/Users/morganm/.config/tool");

        assert_eq!(user_env_var(PANE), None);
        assert_eq!(
            user_env_var(CONFIG).as_deref(),
            Some("/Users/morganm/.config/tool")
        );
        assert_eq!(user_env_var("BERD_SHELL_ENV_TEST_UNSET_9A2D"), None);

        std::env::remove_var(PANE);
        std::env::remove_var(CONFIG);
    }
}
