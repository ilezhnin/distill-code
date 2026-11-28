//! Antigravity owns Google's OAuth flow and refreshes its own personal grant.
//! All Flock entry points give it the same private home and provider environment.
use super::{
    bridge::{Bridge, SpawnEnv},
    harness,
};
use crate::services::{credential_lease, flock_root, managed_acp_tools, provider_accounts};
use doctor::types::AuthStatus;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::AppHandle;
use tokio::{
    sync::{mpsc, Mutex},
    time::timeout,
};

pub(crate) const ID: &str = "antigravity-acp";
pub(crate) const ACCOUNT_ID: &str = "cli-login-antigravity-acp";
pub(crate) const GRANT: &str = ".gemini/antigravity-cli/antigravity-oauth-token";
// A new agy process can refresh the canonical grant while it starts. Serialize
// explicit account requests so Doctor, quota reads and sign-in cannot race.
static ACCOUNT_REQUEST: Mutex<()> = Mutex::const_new(());
const SIGN_IN: &str =
    "Sign in to Google Antigravity with your personal Google account in Settings > AI providers";

fn profile(root: &Path) -> PathBuf {
    root.join("provider-accounts").join(ACCOUNT_ID)
}

/// Never fall back to the desktop's shared Google sign-in or OS keyring.
pub(super) fn scope(root: &Path, env: &mut SpawnEnv) -> Result<(), String> {
    let home = profile(root);
    flock_root::reject_document_links(root, &home.join(GRANT))?;
    fs::create_dir_all(&home).map_err(|_| "Cannot create the Antigravity account directory")?;
    provider_accounts::protect_directory(&home)?;
    for key in ["HOME", "USERPROFILE"] {
        env.extra_env
            .push((key.to_owned(), home.to_string_lossy().into_owned()));
    }
    Ok(())
}

pub(crate) fn read_grant(root: &Path) -> Result<Option<Vec<u8>>, String> {
    let path = profile(root).join(GRANT);
    flock_root::reject_document_links(root, &path)?;
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read the Antigravity sign-in".into()),
    };
    let mut raw = Vec::new();
    let read = file.take(256 * 1024 + 1).read_to_end(&mut raw);
    if read.is_err() || raw.len() > 256 * 1024 {
        credential_lease::wipe(&mut raw);
        return Err("Invalid Antigravity sign-in file".into());
    }
    Ok(Some(raw))
}

pub(crate) fn personal_grant(root: &Path) -> Result<bool, String> {
    let Some(mut raw) = read_grant(root)? else {
        return Ok(false);
    };
    let grant = serde_json::from_slice::<Value>(&raw);
    credential_lease::wipe(&mut raw);
    let grant = grant.map_err(|_| "Cannot parse the Antigravity sign-in")?;
    Ok(grant["auth_method"] == "consumer"
        && grant
            .pointer("/token/access_token")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty()))
}

pub(crate) fn require_personal_grant(root: &Path) -> Result<(), String> {
    if personal_grant(root)? {
        Ok(())
    } else {
        Err(SIGN_IN.into())
    }
}

async fn request(
    root: &Path,
    shell_env: HashMap<String, String>,
    method: &str,
    params: Value,
    limit: Duration,
) -> Result<Value, Value> {
    let unavailable = || json!({"code": -32603, "message":"Antigravity CLI did not answer"});
    let operation = async {
        let _account = ACCOUNT_REQUEST.lock().await;
        let mut env = SpawnEnv {
            shell_env,
            extra_env: vec![],
            remove_env: vec![],
            prepend_dirs: vec![],
        };
        scope(root, &mut env).map_err(|_| unavailable())?;
        let (events, _rx) = mpsc::unbounded_channel();
        let bridge = Bridge::spawn(
            harness::harness(ID).expect("registered Antigravity harness"),
            &env,
            events,
        )
        .await
        .map_err(|_| unavailable())?;
        let result = bridge.request_within(method, params, Some(limit)).await;
        bridge.kill();
        result
    };
    timeout(limit, operation)
        .await
        .unwrap_or_else(|_| Err(unavailable()))
}

pub(crate) async fn auth_status(app: &AppHandle, env: HashMap<String, String>) -> AuthStatus {
    let Ok(root) = flock_root::app_root(app) else {
        return AuthStatus::Unknown;
    };
    match personal_grant(&root) {
        Ok(false) => return AuthStatus::NotAuthenticated,
        Err(_) => return AuthStatus::Unknown,
        Ok(true) => {}
    }
    match request(
        &root,
        env,
        "session/list",
        json!({}),
        Duration::from_secs(15),
    )
    .await
    {
        Ok(answer) if answer["sessions"].is_array() => AuthStatus::Authenticated,
        Err(error) if error["code"] == -32000 && error["message"] == "Authentication required" => {
            AuthStatus::NotAuthenticated
        }
        _ => AuthStatus::Unknown,
    }
}

fn supports_usage(version: &[u8]) -> bool {
    std::str::from_utf8(version)
        .ok()
        .and_then(|s| semver::Version::parse(s.trim()).ok())
        .is_some_and(|v| v >= semver::Version::new(1, 5, 18))
}

/// Capture only the bounded stdout of a native agy command. Stderr can
/// include a login URL and must not reach Flock's logs or renderer.
async fn cli_output(
    executable: &Path,
    env: &SpawnEnv,
    cwd: &Path,
    args: &[&str],
    max_bytes: u64,
) -> Result<(bool, Vec<u8>), String> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    let spec = harness::harness(ID).expect("registered Antigravity harness");
    let mut command = tokio::process::Command::new(executable);
    super::bridge::apply_env(command.as_std_mut(), spec, env, false);
    command
        .current_dir(cwd)
        .args(args)
        // The CLI's SSH login flow prints a code URL instead of opening a
        // browser. With no stdin a background status read cannot complete it.
        .env("SSH_CONNECTION", "127.0.0.1 1 127.0.0.1 22")
        .env("AGY_CLI_NONINTERACTIVE_HEADLESS", "1")
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    crate::services::process::apply_no_window_async(&mut command);
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start Antigravity CLI for usage")?;
    let _tree = crate::services::process::ProcessTree::contain(&child);
    let stdout = child
        .stdout
        .take()
        .ok_or("Cannot read Antigravity CLI output")?;
    let mut bytes = Vec::new();
    stdout
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "Cannot read Antigravity CLI output")?;
    if bytes.len() as u64 > max_bytes {
        return Err("Antigravity CLI usage response exceeded the size limit".into());
    }
    let status = child
        .wait()
        .await
        .map_err(|_| "Cannot read Antigravity CLI exit status")?;
    Ok((status.success(), bytes))
}

/// agy implements /usage itself. Older binaries may forward a slash command
/// as a model prompt, so check the same executable before invoking it. Explicit
/// session settings enable the built-in even if slash commands are disabled in
/// the saved CLI settings.
pub(crate) async fn usage(app: &AppHandle) -> Result<Value, String> {
    use crate::services::{env_key, path_env};
    const ARGS: &[&str] = &[
        "--settings",
        r#"{"disableSlashCommands":false,"useG1Credits":false,"modelProvider":""}"#,
        "-p",
        "/usage",
        "--output-format",
        "json",
        "--print-timeout",
        "12s",
    ];
    let root = flock_root::app_root(app)?;
    let operation = async {
        let _account = ACCOUNT_REQUEST.lock().await;
        require_personal_grant(&root)?;
        let mut env = SpawnEnv {
            shell_env: managed_acp_tools::provider_env(app).await,
            extra_env: vec![],
            prepend_dirs: vec![],
            remove_env: vec![],
        };
        scope(&root, &mut env)?;
        let spec = harness::harness(ID).expect("registered Antigravity harness");
        let executable = path_env::resolve_executable(
            spec.command,
            &env.prepend_dirs,
            env_key::get(&env.shell_env, "PATH"),
        )
        .ok_or("Antigravity CLI is not installed")?;
        let cwd = profile(&root).join("usage");
        flock_root::reject_document_links(&root, &cwd)?;
        fs::create_dir_all(&cwd).map_err(|_| "Cannot create Antigravity usage directory")?;
        let (ok, version) = cli_output(&executable, &env, &cwd, &["--version"], 256).await?;
        if !ok || !supports_usage(&version) {
            return Err("Reading usage requires Antigravity CLI 1.5.18 or newer".into());
        }
        let (ok, bytes) = cli_output(&executable, &env, &cwd, ARGS, 1024 * 1024).await?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid Antigravity CLI usage response")?;
        if !ok && value["status"] != "ERROR" {
            return Err("Antigravity CLI could not report usage".into());
        }
        Ok(value)
    };
    timeout(Duration::from_secs(25), operation)
        .await
        .map_err(|_| "Antigravity CLI usage request timed out")?
}

pub(crate) async fn login(app: &AppHandle) -> Result<(), String> {
    let root = flock_root::app_root(app)?;
    let env = managed_acp_tools::provider_env(app).await;
    request(
        &root,
        env.clone(),
        "authenticate",
        json!({"methodId":"oauth-personal"}),
        Duration::from_secs(300),
    )
    .await
    .map_err(|_| {
        "Google Antigravity sign-in did not complete. Retry sign-in in Settings > AI providers."
    })?;
    if auth_status(app, env).await != AuthStatus::Authenticated {
        return Err("The Antigravity CLI could not verify the personal Google sign-in.".into());
    }
    Ok(())
}

pub(crate) async fn logout(app: &AppHandle) -> Result<(), String> {
    let root = flock_root::app_root(app)?;
    request(
        &root,
        managed_acp_tools::provider_env(app).await,
        "logout",
        json!({}),
        Duration::from_secs(20),
    )
    .await
    .map(|_| ())
    .map_err(|_| "The Antigravity CLI could not sign out.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_usage_requires_a_cli_with_native_usage_support() {
        assert!(supports_usage(b"1.5.18\r\n"));
        assert!(supports_usage(b"1.6.0"));
        for invalid in [b"1.5.17".as_slice(), b"1.5.18-alpha", b"unknown"] {
            assert!(!supports_usage(invalid));
        }
    }

    #[test]
    fn only_the_private_consumer_profile_counts_as_an_antigravity_sign_in() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(!personal_grant(root).unwrap());
        let path = profile(root).join(GRANT);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for method in ["gemini-api-key", "oauth-business", "agent-platform"] {
            fs::write(
                &path,
                json!({"auth_method":method, "token":{"access_token":"fixture"}}).to_string(),
            )
            .unwrap();
            assert!(require_personal_grant(root).is_err());
        }
        fs::write(
            &path,
            br#"{"auth_method":"consumer","token":{"access_token":"fixture"}}"#,
        )
        .unwrap();
        require_personal_grant(root).unwrap();
        let mut env = SpawnEnv {
            shell_env: HashMap::new(),
            prepend_dirs: vec![],
            extra_env: vec![],
            remove_env: vec![],
        };
        scope(root, &mut env).unwrap();
        for key in ["HOME", "USERPROFILE"] {
            assert!(env
                .extra_env
                .contains(&(key.into(), profile(root).to_string_lossy().into_owned())));
        }
        let harness = harness::harness(ID).unwrap();
        assert!(harness.models.is_empty());
        assert_eq!(harness.command, "agy");
        assert!(harness.env_remove.contains(&"GEMINI_API_KEY"));
        assert!(harness.env_remove.contains(&"AGY_ADC_AUTH"));
        assert!(harness
            .env
            .contains(&("AGY_CLI_FORCE_FILE_TOKEN_STORAGE", "1")));
    }
}
