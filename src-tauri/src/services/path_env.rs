use std::{collections::HashMap, path::PathBuf};

use crate::services::{dir_env, env_key, shell_env};

fn push_existing_path(paths: &mut Vec<PathBuf>, path: &str, preserve_hermit: bool) {
    paths.extend(std::env::split_paths(path).filter(|path| {
        preserve_hermit
            || (!path.to_string_lossy().contains(".hermit")
                && !path.join("activate-hermit").exists())
    }));
}

pub fn build_extended_path_with_prepended_dirs(
    path: Option<&str>,
    prepend_dirs: &[PathBuf],
) -> String {
    build_extended_path(path, prepend_dirs, false)
}

fn build_extended_path(
    path: Option<&str>,
    prepend_dirs: &[PathBuf],
    preserve_hermit: bool,
) -> String {
    let mut paths: Vec<PathBuf> = prepend_dirs.to_vec();

    if let Some(path) = path {
        push_existing_path(&mut paths, path, preserve_hermit);
    } else if let Ok(system_path) = std::env::var("PATH") {
        // Login-shell capture can fail; preserve the app process PATH as a
        // fallback instead of dropping all inherited search paths.
        push_existing_path(&mut paths, &system_path, preserve_hermit);
    }

    push_tool_manager_dirs(&mut paths);

    dedupe_paths(&mut paths);

    match std::env::join_paths(&paths) {
        Ok(joined) => joined.to_string_lossy().to_string(),
        Err(_) => {
            // A single dir embedding the separator (legal in macOS paths)
            // makes join_paths reject the whole list; drop such dirs so one
            // bad entry cannot empty the child-process PATH.
            paths.retain(|path| {
                let joinable = std::env::join_paths(std::iter::once(path)).is_ok();
                if !joinable {
                    log::warn!("Dropping un-joinable PATH entry: {}", path.display());
                }
                joinable
            });
            std::env::join_paths(paths)
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        }
    }
}

#[cfg(windows)]
#[path = "path_env/windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "path_env/unix.rs"]
mod platform;

fn push_tool_manager_dirs(paths: &mut Vec<PathBuf>) {
    platform::push_tool_manager_dirs(paths);
}

fn dedupe_paths(paths: &mut Vec<PathBuf>) {
    platform::dedupe_paths(paths);
}

#[cfg(all(test, windows))]
fn build_extended_path_from_path(path: Option<&str>) -> String {
    build_extended_path_with_prepended_dirs(path, &[])
}

/// Build the terminal PATH according to the platform activation contract.
/// Windows preserves its validated project Hermit entry; Unix removes inherited
/// Hermit state because the interactive shell activates the requested cwd.
pub fn build_terminal_path(path: Option<&str>) -> String {
    platform::build_terminal_path(path)
}

/// Build a deterministic environment snapshot with PATH normalized through
/// `build_extended_path_with_prepended_dirs`.
///
/// If home env capture failed, fall back to the current process environment so
/// callers that clear child environments still preserve essential variables.
pub fn env_vars_with_extended_path_and_prepended_dirs(
    shell_env: &HashMap<String, String>,
    prepend_dirs: &[PathBuf],
) -> Vec<(String, String)> {
    let mut env = if shell_env.is_empty() {
        env_key::process_vars_lossy().into_iter().collect()
    } else {
        shell_env.clone()
    };
    shell_env::sanitize_shell_env(&mut env);
    let extended_path =
        build_extended_path_with_prepended_dirs(env_key::get(&env, "PATH"), prepend_dirs);
    env_key::upsert_map(&mut env, "PATH", extended_path);

    let mut vars: Vec<_> = env.into_iter().collect();
    vars.sort_by(|(left, _), (right, _)| left.cmp(right));
    vars
}

pub async fn home_env_vars_with_extended_path_and_prepended_dirs(
    prepend_dirs: &[PathBuf],
) -> Vec<(String, String)> {
    let shell_env = dir_env::capture_home_interactive_env().await;
    env_vars_with_extended_path_and_prepended_dirs(&shell_env, prepend_dirs)
}

#[cfg(test)]
mod tests {
    use super::build_extended_path_with_prepended_dirs;
    #[cfg(windows)]
    use super::platform::{latest_semver_bin, push_windows_fnm_bin, windows_fnm_root};
    #[cfg(windows)]
    use super::{build_extended_path_from_path, env_vars_with_extended_path_and_prepended_dirs};
    #[cfg(windows)]
    use std::collections::HashMap;
    #[cfg(windows)]
    use std::path::Path;
    use std::path::PathBuf;

    #[test]
    fn terminal_path_applies_platform_hermit_activation_contract() {
        let input = std::env::join_paths([
            PathBuf::from("project/.hermit/bin"),
            PathBuf::from("system/bin"),
        ])
        .expect("join input path")
        .to_string_lossy()
        .into_owned();

        let path = super::build_terminal_path(Some(&input));
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            paths.iter().any(|path| path.ends_with(".hermit/bin")),
            cfg!(windows),
            "Windows preserves validated Hermit activation; Unix shells reactivate cwd"
        );
    }

    #[test]
    fn extended_path_keeps_prepended_dirs_in_front() {
        let path = build_extended_path_with_prepended_dirs(
            Some("/shell/bin:/acp/bin"),
            &[PathBuf::from("/acp/bin"), PathBuf::from("/distro/bin")],
        );
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            paths.first().map(|p| p.as_path()),
            Some(std::path::Path::new("/acp/bin"))
        );
        assert_eq!(
            paths.get(1).map(|p| p.as_path()),
            Some(std::path::Path::new("/distro/bin"))
        );
        assert_eq!(
            paths
                .iter()
                .filter(|p| p.as_path() == std::path::Path::new("/acp/bin"))
                .count(),
            1
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_env_vars_extend_inherited_path_without_a_logical_duplicate() {
        let inherited = std::env::join_paths([PathBuf::from("C:\\Windows\\System32")])
            .expect("join inherited path")
            .to_string_lossy()
            .into_owned();
        let prepended = PathBuf::from("C:\\Program Files\\Berd Tools");
        let env = HashMap::from([("Path".to_string(), inherited)]);

        let vars =
            env_vars_with_extended_path_and_prepended_dirs(&env, std::slice::from_ref(&prepended));
        let mut command = std::process::Command::new("cmd.exe");
        command.env_clear();
        for (key, value) in &vars {
            command.env(key, value);
        }
        let applied_paths = command
            .get_envs()
            .filter_map(|(key, value)| (key.eq_ignore_ascii_case("PATH")).then_some(value?))
            .collect::<Vec<_>>();
        let paths = applied_paths
            .first()
            .map(|value| std::env::split_paths(value).collect::<Vec<_>>())
            .expect("extended path");

        assert_eq!(
            vars.iter()
                .filter(|(key, _)| key.eq_ignore_ascii_case("PATH"))
                .count(),
            1,
            "environment construction must retain one logical PATH"
        );
        assert_eq!(
            applied_paths.len(),
            1,
            "command-style application must see one logical PATH"
        );
        assert_eq!(paths.first(), Some(&prepended));
        assert!(paths.iter().any(|path| path.ends_with("Windows\\System32")));
    }

    #[cfg(windows)]
    fn write_fnm_install(root: &Path, version: &str) -> PathBuf {
        let installation = root
            .join("node-versions")
            .join(version)
            .join("installation");
        std::fs::create_dir_all(&installation).expect("fnm installation");
        std::fs::write(installation.join("node.exe"), b"fixture").expect("node fixture");
        installation
    }

    #[cfg(windows)]
    #[test]
    fn windows_fnm_root_rejects_inherited_hermit_override() {
        let appdata = PathBuf::from("C:\\Users\\dev\\AppData\\Roaming");
        let env = [("FNM_DIR".into(), "C:\\repo\\.HeRmIt\\fnm".into())];

        assert_eq!(
            windows_fnm_root(env, Some(&appdata)),
            Some(appdata.join("fnm"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_fnm_semver_fallback_compares_numeric_major_versions() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("fnm");
        write_fnm_install(&root, "v9");
        let v22 = write_fnm_install(&root, "v22");

        let selected = latest_semver_bin(&root.join("node-versions"), "installation")
            .expect("selected fnm version");

        assert_eq!(selected, v22);
    }

    #[cfg(windows)]
    #[test]
    fn windows_fnm_rejects_default_alias_outside_installations() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("fnm");
        let latest = write_fnm_install(&root, "v22.1.0");
        let invalid_default = root.join("aliases").join("default");
        std::fs::create_dir_all(&invalid_default).expect("invalid default alias");
        std::fs::write(invalid_default.join("node.exe"), b"fixture").expect("node fixture");
        let mut paths = Vec::new();

        push_windows_fnm_bin(&mut paths, &root);

        assert_eq!(paths, vec![latest]);
    }

    #[test]
    #[cfg(windows)]
    fn windows_extended_path_dedupes_case_insensitively() {
        let input = std::env::join_paths([
            PathBuf::from("C:\\Tools\\Bin"),
            PathBuf::from("c:\\tools\\bin"),
        ])
        .expect("join input path")
        .to_string_lossy()
        .to_string();
        let path = build_extended_path_from_path(Some(&input));
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            paths
                .iter()
                .filter(|p| p.to_string_lossy().eq_ignore_ascii_case("c:\\tools\\bin"))
                .count(),
            1,
            "case-insensitive duplicate PATH entries must collapse on Windows"
        );
    }

    #[test]
    #[cfg(windows)]
    fn windows_extended_path_preserves_directories_with_spaces() {
        let spaced = PathBuf::from("C:\\Program Files\\nodejs");
        let input = std::env::join_paths([spaced.clone()])
            .expect("join input path")
            .to_string_lossy()
            .to_string();
        let path = build_extended_path_from_path(Some(&input));
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert!(
            paths.iter().any(|p| p == spaced.as_path()),
            "directories containing spaces must survive PATH round-trip"
        );
    }
}
