use std::{
    collections::{hash_map::Entry, HashMap},
    path::{Path, PathBuf},
    time::Duration,
};

use crate::services::{env_key, shell_env};

/// Windows has no general-purpose login shell: the inherited process
/// environment is the session environment, the same for every folder.
///
/// Nothing is taken from the folder itself. A project is content, a cloned
/// repository included, and the app has no way yet to ask whether a folder is
/// trusted. A directory inside it on PATH (its Hermit `bin`, anything found
/// by walking the folder or its parents) would let the repository's files
/// answer to `git`, `node` or `powershell` in a terminal and in what git
/// starts by name. Whoever wants a project's own tools activates them in the
/// terminal by hand.
pub(super) async fn capture_dir_env_uncached(
    _dir: &Path,
    _timeout_duration: Duration,
) -> HashMap<String, String> {
    windows_process_env()
}

pub(crate) fn windows_process_env() -> HashMap<String, String> {
    let mut env = dedupe_env_case_insensitive(env_key::process_vars_lossy());
    strip_untrusted_windows_tool_state(&mut env);
    env
}

/// Remove repository-scoped tool state inherited from the directory that
/// launched Flock. The shared sanitizer owns the variable policy; this function
/// additionally removes Hermit PATH entries using Windows path semantics.
pub(crate) fn strip_untrusted_windows_tool_state(env: &mut HashMap<String, String>) {
    shell_env::sanitize_shell_env(env);
    let Some(path) = env_key::get(env, "PATH") else {
        return;
    };
    let paths = std::env::split_paths(path).filter(|entry| {
        !entry.components().any(|component| {
            component
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(".hermit")
        })
    });
    if let Ok(path) = std::env::join_paths(paths) {
        env_key::upsert_map(env, "PATH", path.to_string_lossy().into_owned());
    }
}

pub(crate) fn resolve_control_executable(name: &str) -> Option<PathBuf> {
    resolve_control_executable_in_env(
        name,
        dedupe_env_case_insensitive(env_key::process_vars_lossy()),
    )
}

pub(crate) fn resolve_control_executable_in_env(
    name: &str,
    mut env: HashMap<String, String>,
) -> Option<PathBuf> {
    strip_untrusted_windows_tool_state(&mut env);
    let file_name = if name.to_ascii_lowercase().ends_with(".exe") {
        name.to_string()
    } else {
        format!("{name}.exe")
    };
    find_file_on_windows_path(&file_name, env_key::get(&env, "PATH"))
}

pub(crate) fn find_file_on_windows_path(file_name: &str, path: Option<&str>) -> Option<PathBuf> {
    super::find_file_on_path_dirs(file_name, path)
}

pub(crate) fn dedupe_env_case_insensitive(
    vars: impl IntoIterator<Item = (String, String)>,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let mut canonical_key = HashMap::new();
    for (key, value) in vars {
        match canonical_key.entry(key.to_ascii_lowercase()) {
            Entry::Occupied(_) => {}
            Entry::Vacant(slot) => {
                slot.insert(key.clone());
                env.insert(key, value);
            }
        }
    }
    env
}

pub(super) async fn capture_terminal_env(
    _dir: &Path,
    _timeout_duration: Duration,
) -> HashMap<String, String> {
    windows_process_env()
}
