use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::{sync::watch, time::timeout};

use crate::services::shell_env;

/// Per-directory environment cache entry.
enum CacheEntry {
    Ready {
        env: HashMap<String, String>,
        captured_at: Instant,
    },
    InFlight(watch::Receiver<Option<Result<HashMap<String, String>, String>>>),
}

/// Cache of per-directory shell environments.
///
/// Unlike the global `shell_env` capture, this runs an interactive login shell
/// *in the target directory* so that directory-scoped tool managers (Hermit,
/// direnv, mise, etc.) activate and inject their paths. Entries are cached with
/// a TTL to avoid spawning a shell on every git command while still picking up
/// changes when the user modifies their toolchain.
static DIR_ENV_CACHE: Mutex<Option<HashMap<PathBuf, CacheEntry>>> = Mutex::new(None);

/// Match Staged's default so shell startup cost is amortized across a session
/// while still refreshing user shell changes without manual invalidation.
const DIR_ENV_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const HOME_ENV_CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

struct InFlightGuard {
    key: PathBuf,
    promoted: bool,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if self.promoted {
            return;
        }

        let Ok(mut guard) = DIR_ENV_CACHE.lock() else {
            return;
        };
        let Some(cache) = guard.as_mut() else {
            return;
        };
        if matches!(cache.get(&self.key), Some(CacheEntry::InFlight(_))) {
            cache.remove(&self.key);
        }
    }
}

/// Capture the shell environment for a specific directory.
///
/// Runs `$SHELL -i -l -s` with `cwd` set to the target directory so that shell
/// hooks (hermit, direnv, etc.) activate. The shell receives a small stdin
/// script that writes `env -0` to a temp file, while stdout and stderr are
/// discarded so shell banners cannot corrupt parsing.
///
/// Returns `None` if the capture fails. Failed captures are not cached.
pub async fn capture_dir_env(
    dir: &Path,
    timeout_duration: Duration,
) -> Option<HashMap<String, String>> {
    let key = dir.to_path_buf();

    loop {
        enum Action {
            Return(HashMap<String, String>),
            Wait(watch::Receiver<Option<Result<HashMap<String, String>, String>>>),
            Capture(watch::Sender<Option<Result<HashMap<String, String>, String>>>),
        }

        let action = {
            let mut guard = DIR_ENV_CACHE.lock().ok()?;
            let cache = guard.get_or_insert_with(HashMap::new);
            match cache.get(&key) {
                Some(CacheEntry::Ready { env, captured_at })
                    if captured_at.elapsed() < DIR_ENV_CACHE_TTL =>
                {
                    Action::Return(env.clone())
                }
                Some(CacheEntry::InFlight(rx)) => Action::Wait(rx.clone()),
                _ => {
                    let (tx, rx) = watch::channel(None);
                    cache.insert(key.clone(), CacheEntry::InFlight(rx));
                    Action::Capture(tx)
                }
            }
        };

        match action {
            Action::Return(env) => return Some(env),
            Action::Wait(mut rx) => {
                let wait_result = timeout(timeout_duration, async {
                    while rx.borrow().is_none() {
                        if rx.changed().await.is_err() {
                            break;
                        }
                    }

                    rx.borrow().clone()
                })
                .await;

                let result = match wait_result {
                    Ok(result) => result,
                    Err(_) => {
                        log::warn!(
                            "Timed out waiting {:?} for dir env capture in {}",
                            timeout_duration,
                            key.display()
                        );
                        return None;
                    }
                };

                match result {
                    Some(Ok(env)) => return Some(env),
                    Some(Err(_)) => return None,
                    None => continue,
                }
            }
            Action::Capture(tx) => {
                let mut guard = InFlightGuard {
                    key: key.clone(),
                    promoted: false,
                };
                let env = capture_dir_env_uncached(&key, timeout_duration).await;
                if env.is_empty() {
                    let _ = tx.send(Some(Err(
                        "Directory env capture returned no variables".into()
                    )));
                    return None;
                }

                put_cached(key.clone(), env.clone());
                guard.promoted = true;
                let _ = tx.send(Some(Ok(env.clone())));
                return Some(env);
            }
        }
    }
}

/// Capture the user's home/global interactive login environment.
///
/// This reuses the per-directory interactive-login cache with `$HOME` as the
/// directory, then sanitizes only the returned clone. The cached per-directory
/// environment remains raw so project/git callers still receive tool-manager
/// variables such as Hermit or direnv state for their exact directory.
pub async fn capture_home_interactive_env() -> HashMap<String, String> {
    capture_home_interactive_env_with_timeout(HOME_ENV_CAPTURE_TIMEOUT).await
}

/// Capture the environment used to launch an interactive terminal.
///
/// The app itself takes nothing from `dir` on either platform. A Unix shell
/// begins with the sanitized home environment and then runs the user's own
/// startup files in the folder. Windows has no such startup step and gets the
/// session environment as it is: a project's own tools (Hermit and the like)
/// are activated in the terminal by hand.
pub async fn capture_terminal_env(dir: &Path) -> HashMap<String, String> {
    platform::capture_terminal_env(dir, HOME_ENV_CAPTURE_TIMEOUT).await
}

/// Resolve a control executable before any repository-local PATH is applied.
/// Windows returns a canonical absolute path; other platforms preserve the
/// existing PATH lookup behavior.
pub(crate) fn resolve_control_executable(name: &str) -> Option<PathBuf> {
    platform::resolve_control_executable(name)
}

pub async fn capture_home_interactive_env_with_timeout(
    timeout_duration: Duration,
) -> HashMap<String, String> {
    let Some(home) = home_dir_from_env() else {
        return HashMap::new();
    };
    capture_home_interactive_env_for_dir(&home, timeout_duration).await
}

fn home_dir_from_env() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
}

async fn capture_home_interactive_env_for_dir(
    home: &Path,
    timeout_duration: Duration,
) -> HashMap<String, String> {
    let mut env = capture_dir_env(home, timeout_duration)
        .await
        .unwrap_or_default();
    shell_env::sanitize_shell_env(&mut env);
    env
}

#[cfg(test)]
fn get_cached(key: &Path) -> Option<HashMap<String, String>> {
    let guard = DIR_ENV_CACHE.lock().ok()?;
    let cache = guard.as_ref()?;
    let entry = cache.get(key)?;
    match entry {
        CacheEntry::Ready { env, captured_at } if captured_at.elapsed() < DIR_ENV_CACHE_TTL => {
            Some(env.clone())
        }
        _ => None,
    }
}

fn put_cached(key: PathBuf, env: HashMap<String, String>) {
    let mut guard = match DIR_ENV_CACHE.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let cache = guard.get_or_insert_with(HashMap::new);
    cache.insert(
        key,
        CacheEntry::Ready {
            env,
            captured_at: Instant::now(),
        },
    );
}

/// The PATH entries a tool lookup is allowed to probe.
///
/// `std::env::split_paths` yields an empty `PathBuf` for every empty segment —
/// `;;` or a trailing `;`, both common once an installer has appended to PATH —
/// and `Path::new("").join("git.exe")` is the *relative* `git.exe`, which
/// `is_file()` and `canonicalize()` then resolve against Flock's own current
/// directory instead of any PATH directory. A relative-but-non-empty entry
/// (`.`, `bin`) does the same. Rust's `Command` resolver drops both and never
/// searches the current directory; a trusted-PATH lookup must not either, or a
/// `git.exe` dropped in the directory Flock was launched from wins.
///
/// Lives outside `#[cfg(windows)]` so it can be tested on any host: the rule is
/// about PATH shape, which `split_paths` and `is_absolute` already localise.
#[cfg(any(windows, test))]
fn trusted_path_lookup_dirs(path: &str) -> Vec<PathBuf> {
    std::env::split_paths(path)
        .filter(|dir| !dir.as_os_str().is_empty() && dir.is_absolute())
        .collect()
}

/// Find `file_name` in the absolute directories of `path`, and nowhere else.
#[cfg(any(windows, test))]
fn find_file_on_path_dirs(file_name: &str, path: Option<&str>) -> Option<PathBuf> {
    trusted_path_lookup_dirs(path?)
        .into_iter()
        .map(|dir| dir.join(file_name))
        .find(|candidate| candidate.is_file())?
        .canonicalize()
        .ok()
}

#[cfg(windows)]
#[path = "dir_env/windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "dir_env/unix.rs"]
mod platform;

async fn capture_dir_env_uncached(
    dir: &Path,
    timeout_duration: Duration,
) -> HashMap<String, String> {
    platform::capture_dir_env_uncached(dir, timeout_duration).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use crate::services::env_key;

    /// A trailing or doubled separator must not turn a tool lookup into a search
    /// of Flock's own working directory. Runs on every host: the empty and
    /// relative entries are the whole mechanism, and `split_paths` localises the
    /// separator for us.
    #[test]
    fn path_lookup_never_resolves_a_tool_against_the_process_directory() {
        // Cargo runs tests with the crate directory as the working directory, so
        // `Cargo.toml` is exactly the "file sitting in the cwd" an empty or
        // relative PATH entry would hand back.
        let cwd = std::env::current_dir().expect("current dir");
        assert!(cwd.join("Cargo.toml").is_file(), "test fixture missing");

        let untrusted = std::env::join_paths([
            PathBuf::from(""),
            PathBuf::from("."),
            PathBuf::from("crates"),
        ])
        .expect("join untrusted path");
        assert_eq!(
            find_file_on_path_dirs("Cargo.toml", Some(&untrusted.to_string_lossy())),
            None,
            "an empty or relative PATH entry must not be searched"
        );

        // An absolute entry after the empty one is still found.
        let mixed =
            std::env::join_paths([PathBuf::from(""), cwd.clone()]).expect("join mixed path");
        assert_eq!(
            find_file_on_path_dirs("Cargo.toml", Some(&mixed.to_string_lossy())),
            Some(cwd.join("Cargo.toml").canonicalize().expect("canonicalize")),
        );

        assert_eq!(
            trusted_path_lookup_dirs(&mixed.to_string_lossy()),
            vec![cwd],
            "only the absolute entry survives"
        );
        assert!(find_file_on_path_dirs("Cargo.toml", None).is_none());
    }

    #[test]
    #[cfg(windows)]
    fn windows_dedupe_env_keeps_first_seen_case_and_drops_duplicates() {
        let env = platform::dedupe_env_case_insensitive([
            ("Path".to_string(), "C:\\first".to_string()),
            ("PATH".to_string(), "C:\\second".to_string()),
            ("SystemRoot".to_string(), "C:\\Windows".to_string()),
        ]);

        assert_eq!(env.get("Path"), Some(&"C:\\first".to_string()));
        assert!(!env.contains_key("PATH"));
        assert_eq!(env.get("SystemRoot"), Some(&"C:\\Windows".to_string()));
        // Exactly one entry survives for the case-insensitive `path` name.
        assert_eq!(
            env.keys()
                .filter(|k| k.eq_ignore_ascii_case("path"))
                .count(),
            1
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_capture_drops_unvalidated_inherited_hermit_state() {
        let inherited = std::env::join_paths([
            PathBuf::from("C:\\unrelated\\.HERMIT\\bin"),
            PathBuf::from("C:\\Windows\\System32"),
        ])
        .expect("join inherited path")
        .to_string_lossy()
        .into_owned();
        let mut env = HashMap::from([
            ("Path".to_string(), inherited),
            ("Hermit_Env".to_string(), "C:\\unrelated".to_string()),
            (
                "npm_config_prefix".to_string(),
                "C:\\unrelated\\npm".to_string(),
            ),
            (
                "Npm_Config_Cache".to_string(),
                "C:\\unrelated\\cache".to_string(),
            ),
            (
                "corepack_home".to_string(),
                "C:\\unrelated\\corepack".to_string(),
            ),
            (
                "CUSTOM_TOOL_HOME".to_string(),
                "C:\\unrelated\\.HeRmIt\\tool".to_string(),
            ),
        ]);

        platform::strip_untrusted_windows_tool_state(&mut env);

        for key in [
            "HERMIT_ENV",
            "NPM_CONFIG_PREFIX",
            "NPM_CONFIG_CACHE",
            "COREPACK_HOME",
            "CUSTOM_TOOL_HOME",
        ] {
            assert!(!env
                .keys()
                .any(|existing| existing.eq_ignore_ascii_case(key)));
        }
        let paths: Vec<_> =
            std::env::split_paths(env_key::get(&env, "PATH").expect("PATH")).collect();
        assert_eq!(paths, vec![PathBuf::from("C:\\Windows\\System32")]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_git_discovery_uses_sanitized_path() {
        let temp = tempfile::tempdir().expect("temp dir");
        let untrusted_hermit_bin = temp.path().join("repo").join(".hermit").join("bin");
        let trusted_bin = temp.path().join("trusted").join("bin");
        std::fs::create_dir_all(&untrusted_hermit_bin).expect("untrusted Hermit bin");
        std::fs::create_dir_all(&trusted_bin).expect("trusted bin");
        std::fs::write(untrusted_hermit_bin.join("git.exe"), b"untrusted")
            .expect("untrusted git fixture");
        std::fs::write(trusted_bin.join("git.exe"), b"trusted").expect("trusted git fixture");
        let path = std::env::join_paths([untrusted_hermit_bin, trusted_bin.clone()])
            .expect("fixture PATH")
            .to_string_lossy()
            .into_owned();
        let mut env = HashMap::from([("Path".to_string(), path)]);

        platform::strip_untrusted_windows_tool_state(&mut env);
        let git = platform::find_file_on_windows_path("git.exe", env_key::get(&env, "PATH"))
            .expect("trusted git");

        assert_eq!(
            git,
            trusted_bin
                .join("git.exe")
                .canonicalize()
                .expect("canonical trusted Git")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_control_executables_ignore_repository_hermit_bins() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repository_bin = temp.path().join("repo").join(".hermit").join("bin");
        let trusted_bin = temp.path().join("trusted").join("bin");
        std::fs::create_dir_all(&repository_bin).expect("repository Hermit bin");
        std::fs::create_dir_all(&trusted_bin).expect("trusted bin");
        for executable in ["git.exe", "gh.exe"] {
            std::fs::write(repository_bin.join(executable), b"sentinel")
                .expect("repository sentinel");
            std::fs::write(trusted_bin.join(executable), b"trusted").expect("trusted executable");
        }
        let path = std::env::join_paths([repository_bin.clone(), trusted_bin.clone()])
            .expect("fixture PATH")
            .to_string_lossy()
            .into_owned();
        let env = HashMap::from([("Path".to_string(), path)]);

        for executable in ["git", "gh"] {
            assert_eq!(
                platform::resolve_control_executable_in_env(executable, env.clone()),
                Some(
                    trusted_bin
                        .join(format!("{executable}.exe"))
                        .canonicalize()
                        .expect("canonical trusted executable")
                )
            );
        }
    }

    #[test]
    #[cfg(windows)]
    fn windows_process_env_preserves_critical_variables() {
        // The process already inherited the Windows session environment; the
        // capture must surface the variables child processes cannot run without.
        let env = platform::windows_process_env();

        for key in ["SystemRoot", "ComSpec", "PATHEXT"] {
            if std::env::var_os(key).is_some() {
                assert!(
                    env.keys().any(|k| k.eq_ignore_ascii_case(key)),
                    "expected captured Windows env to preserve {key}"
                );
            }
        }
    }

    /// What a cloned repository can carry: a `.git` that git itself accepts
    /// and a Hermit `bin` holding a file named like a tool the operator types.
    #[cfg(windows)]
    fn cloned_repository_with_its_own_tools(root: &Path) -> PathBuf {
        let repo = root.join("Cloned Project");
        let git_dir = repo.join(".git");
        std::fs::create_dir_all(git_dir.join("objects")).expect("objects");
        std::fs::create_dir_all(git_dir.join("refs")).expect("refs");
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").expect("HEAD");
        let hermit_bin = repo.join(".hermit").join("bin");
        std::fs::create_dir_all(&hermit_bin).expect("Hermit bin");
        std::fs::write(hermit_bin.join("git.cmd"), "@echo RAN-FROM-REPO\r\n")
            .expect("planted tool");
        std::fs::create_dir_all(repo.join("nested").join("folder")).expect("nested folder");
        repo
    }

    /// The environment the app captures for a folder, for a terminal and for
    /// its own git commands, takes no PATH entry from that folder. Windows
    /// used to ask git for the repository around it and put the repository's
    /// `.hermit\bin` first.
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_environment_for_a_folder_takes_no_path_entry_from_it() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repo = cloned_repository_with_its_own_tools(temp.path());
        let canonical_repo = dunce::canonicalize(&repo).expect("canonical repository");

        for dir in [repo.clone(), repo.join("nested").join("folder")] {
            let for_terminal = capture_terminal_env(&dir).await;
            let for_git = capture_dir_env(&dir, Duration::from_secs(10))
                .await
                .expect("captured environment");
            for (consumer, env) in [("terminal", &for_terminal), ("git", &for_git)] {
                let inside: Vec<PathBuf> =
                    std::env::split_paths(env_key::get(env, "PATH").expect("PATH"))
                        .filter(|entry| {
                            dunce::canonicalize(entry)
                                .is_ok_and(|entry| entry.starts_with(&canonical_repo))
                        })
                        .collect();
                assert!(
                    inside.is_empty(),
                    "the {consumer} environment for {} has PATH entries inside the repository: {inside:?}",
                    dir.display()
                );
            }
        }
    }

    #[tokio::test]
    async fn home_interactive_env_sanitizes_clone_but_keeps_raw_cache() {
        let home = PathBuf::from("/tmp/test-home-env");
        let mut raw = HashMap::new();
        raw.insert("PATH".to_string(), "/repo/.hermit/bin:/usr/bin".to_string());
        raw.insert("HERMIT_ENV".to_string(), "/repo".to_string());
        raw.insert("LANG".to_string(), "en_US.UTF-8".to_string());

        put_cached(home.clone(), raw);

        let sanitized = capture_home_interactive_env_for_dir(&home, Duration::from_secs(1)).await;

        assert_eq!(sanitized.get("LANG"), Some(&"en_US.UTF-8".to_string()));
        assert!(!sanitized.contains_key("HERMIT_ENV"));
        assert_eq!(
            sanitized.get("PATH"),
            Some(&"/repo/.hermit/bin:/usr/bin".to_string())
        );

        let cached = get_cached(&home).expect("raw cached home env");
        assert!(cached.contains_key("HERMIT_ENV"));
        assert_eq!(
            cached.get("PATH"),
            Some(&"/repo/.hermit/bin:/usr/bin".to_string())
        );
    }
}
