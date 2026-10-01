//! Authentication commands run only in the selected account's environment.
//! Secrets are neither emitted nor returned; sign-out preserves chat history.

use crate::services::{env_key, managed_acp_tools, provider_accounts};
use provider_accounts::{AuthMethod, ProviderAccount, ProviderAccountsSnapshot};
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

async fn prepare_change(app: &AppHandle, account_id: &str) -> Result<(), String> {
    crate::services::provider_account_status::prepare_account_change(app, account_id).await;
    if let Some(host) = app.try_state::<crate::services::agent_host::AgentHost>() {
        host.prepare_account_change(account_id).await?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountAuthResult {
    pub account_id: String,
    pub status: String,
    pub message: String,
}

fn changed(app: &AppHandle) {
    let _ = app.emit("provider-accounts-changed", ());
}

#[tauri::command]
pub fn list_provider_accounts(app: AppHandle) -> Result<ProviderAccountsSnapshot, String> {
    provider_accounts::snapshot(&app)
}

#[tauri::command]
pub fn add_provider_account(
    app: AppHandle,
    provider_id: String,
    label: String,
    auth_method: AuthMethod,
    api_key: Option<String>,
) -> Result<ProviderAccount, String> {
    let result = provider_accounts::add_account(&app, provider_id, label, auth_method, api_key)?;
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub async fn update_provider_account(
    app: AppHandle,
    account_id: String,
    label: Option<String>,
    api_key: Option<String>,
) -> Result<ProviderAccount, String> {
    let _guard = if api_key.is_some() {
        let guard = provider_accounts::begin_account_change(&account_id)?;
        prepare_change(&app, &account_id).await?;
        Some(guard)
    } else {
        None
    };
    let result = provider_accounts::update_account(&app, &account_id, label, api_key)?;
    drop(_guard);
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub async fn remove_provider_account(
    app: AppHandle,
    account_id: String,
) -> Result<ProviderAccountsSnapshot, String> {
    let _guard = provider_accounts::begin_account_change(&account_id)?;
    prepare_change(&app, &account_id).await?;
    let result = provider_accounts::remove_account(&app, &account_id)?;
    drop(_guard);
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn set_default_provider_account(
    app: AppHandle,
    provider_id: String,
    account_id: String,
) -> Result<ProviderAccountsSnapshot, String> {
    let result = provider_accounts::set_default(&app, &provider_id, &account_id)?;
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn set_provider_account_routing(
    app: AppHandle,
    provider_id: String,
    automatic_switching: bool,
) -> Result<ProviderAccountsSnapshot, String> {
    let result = provider_accounts::set_routing(&app, &provider_id, automatic_switching)?;
    changed(&app);
    Ok(result)
}

struct LoginGuard(String);
static LOGINS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

impl LoginGuard {
    fn acquire(provider: &str) -> Result<Self, String> {
        let mut logins = LOGINS
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| "Account login registry is unavailable")?;
        // Providers may use a fixed local callback port. Separate providers can
        // sign in concurrently; two accounts of one provider cannot race it.
        if !logins.insert(provider.into()) {
            return Err(
                "Finish the current sign-in for this provider before starting another".into(),
            );
        }
        Ok(Self(provider.into()))
    }
}

impl Drop for LoginGuard {
    fn drop(&mut self) {
        if let Ok(mut logins) = LOGINS.get_or_init(Mutex::default).lock() {
            logins.remove(&self.0);
        }
    }
}

struct CliCommand {
    executable: PathBuf,
    prefix: Vec<String>,
}

fn resolve_cli(app: &AppHandle, account: &ProviderAccount) -> Result<CliCommand, String> {
    if let Some(path) = managed_acp_tools::native_cli_path(app, &account.provider_id) {
        return Ok(CliCommand {
            executable: path,
            prefix: vec![],
        });
    }
    Err("Install this provider in Settings before adding its authorization".into())
}

fn command(cli: &CliCommand, args: &[&str], env: &[(String, String)]) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(&cli.executable);
    command
        .args(&cli.prefix)
        .args(args)
        .env_clear()
        .envs(env.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Authentication must not read a project's local settings or API-key helper.
    if let Some((_, home)) = env.iter().find(|(key, _)| {
        env_key::matches(key, "CODEX_HOME") || env_key::matches(key, "CLAUDE_CONFIG_DIR")
    }) {
        command.current_dir(home);
    }
    crate::services::process::apply_no_window_async(&mut command);
    command
}

fn status_args(provider: &str) -> &'static [&'static str] {
    if provider == "codex-acp" {
        &["login", "status"]
    } else {
        &["auth", "status", "--json"]
    }
}

fn login_args(provider: &str) -> &'static [&'static str] {
    if provider == "codex-acp" {
        &["login"]
    } else {
        &["auth", "login", "--claudeai"]
    }
}

fn logout_args(provider: &str) -> &'static [&'static str] {
    if provider == "codex-acp" {
        &["logout"]
    } else {
        &["auth", "logout"]
    }
}

#[tauri::command]
pub async fn sign_out_provider_account(app: AppHandle, account_id: String) -> Result<(), String> {
    let account = provider_accounts::account(&app, &account_id)?;
    let _login_guard = LoginGuard::acquire(&account.provider_id)?;
    // Resolve the isolated environment before acquiring the mutation guard:
    // ordinary consumers cannot request credentials while a change is active.
    let cli_env = if account.auth_method == AuthMethod::ApiKey {
        None
    } else {
        let env = provider_accounts::scoped_env(
            &app,
            &account,
            managed_acp_tools::provider_env(&app)
                .await
                .into_iter()
                .collect(),
        )?;
        Some((resolve_cli(&app, &account)?, env))
    };
    let _guard = provider_accounts::begin_account_change(&account_id)?;
    prepare_change(&app, &account_id).await?;
    if let Some((cli, env)) = cli_env {
        let output = tokio::time::timeout(
            Duration::from_secs(30),
            command(&cli, logout_args(&account.provider_id), &env).output(),
        )
        .await
        .map_err(|_| "Account sign-out timed out; refresh its status before trying again")?
        .map_err(|_| "Cannot start the provider sign-out process")?;
        if !output.status.success() {
            return Err(
                "The provider could not sign out this account; refresh its status and try again"
                    .into(),
            );
        }
    } else {
        provider_accounts::clear_api_credentials(&app, &account_id)?;
    }
    crate::services::provider_account_status::record_signed_out(&app, &account).await;
    drop(_guard);
    let _ = app.emit(
        "provider-account-auth-state",
        ProviderAccountAuthResult {
            account_id,
            status: "needs_auth".into(),
            message: String::new(),
        },
    );
    changed(&app);
    Ok(())
}

async fn probe(
    cli: &CliCommand,
    account: &ProviderAccount,
    env: &[(String, String)],
) -> Result<bool, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(25),
        command(cli, status_args(&account.provider_id), env).output(),
    )
    .await
    .map_err(|_| "Account status check timed out")?
    .map_err(|_| "Cannot start the provider account status check")?;
    if !output.status.success() {
        return Ok(false);
    }
    if account.provider_id == "claude-acp" {
        let result: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| "Claude returned an unreadable account status")?;
        return Ok(result.get("loggedIn").and_then(serde_json::Value::as_bool) == Some(true));
    }
    Ok(true)
}

/// Runs a read-only official CLI check; it never starts browser authorization.
pub async fn probe_account_auth(
    app: &AppHandle,
    account: &ProviderAccount,
) -> Result<bool, String> {
    if account.auth_method == AuthMethod::ApiKey {
        return provider_accounts::account_has_credentials(app, account);
    }
    let env = provider_accounts::scoped_env(
        app,
        account,
        managed_acp_tools::provider_env(app)
            .await
            .into_iter()
            .collect(),
    )?;
    let cli = resolve_cli(app, account)?;
    probe(&cli, account, &env).await
}

#[tauri::command]
pub async fn authenticate_provider_account(
    app: AppHandle,
    account_id: String,
    force: Option<bool>,
) -> Result<ProviderAccountAuthResult, String> {
    let account = provider_accounts::account(&app, &account_id)?;
    if !account.enabled {
        return Err("Enable this account before signing in".into());
    }
    if account.auth_method == AuthMethod::ApiKey {
        if !provider_accounts::account_has_credentials(&app, &account)? {
            return Err("Save an API key before using this account".into());
        }
        return Ok(ProviderAccountAuthResult {
            account_id,
            status: "authenticated".into(),
            message: "API key is saved in protected local storage".into(),
        });
    }
    let _guard = LoginGuard::acquire(&account.provider_id)?;
    let env = provider_accounts::scoped_env(
        &app,
        &account,
        managed_acp_tools::provider_env(&app)
            .await
            .into_iter()
            .collect(),
    )?;
    let cli = resolve_cli(&app, &account)?;
    if !force.unwrap_or(false) && probe(&cli, &account, &env).await.unwrap_or(false) {
        return Ok(ProviderAccountAuthResult {
            account_id,
            status: "authenticated".into(),
            message: "Saved authorization is ready".into(),
        });
    }
    let _account_guard = provider_accounts::begin_account_change(&account_id)?;
    prepare_change(&app, &account_id).await?;
    let running = ProviderAccountAuthResult {
        account_id: account_id.clone(),
        status: "running".into(),
        message: "Complete the one-time sign-in in your browser".into(),
    };
    let _ = app.emit("provider-account-auth-state", &running);
    let outcome = tokio::time::timeout(
        Duration::from_secs(15 * 60),
        command(&cli, login_args(&account.provider_id), &env).output(),
    )
    .await;
    let (status, message) = match outcome {
        Ok(Ok(output)) if output.status.success() => {
            if probe(&cli, &account, &env).await.unwrap_or(false) {
                ("authenticated", "Authorization is saved. You can now switch to this account without signing in again.")
            } else {
                ("needs_auth", "Sign-in finished, but saved authorization could not be verified. Try signing in again.")
            }
        }
        Ok(Ok(_)) => ("needs_auth", "Sign-in was cancelled or the provider did not accept it. Existing accounts remain available."),
        Ok(Err(_)) => ("error", "The provider sign-in process could not be started. Check its installation in Settings."),
        Err(_) => ("needs_auth", "Sign-in timed out. Start it again when you are ready to authorize the account."),
    };
    let result = ProviderAccountAuthResult {
        account_id,
        status: status.into(),
        message: message.into(),
    };
    drop(_account_guard);
    let _ = app.emit("provider-account-auth-state", &result);
    changed(&app);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_out_uses_the_native_provider_logout_commands() {
        assert_eq!(logout_args("codex-acp"), &["logout"]);
        assert_eq!(logout_args("claude-acp"), &["auth", "logout"]);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn logout_process_uses_only_the_selected_cli_home() {
        let root = tempfile::tempdir().unwrap();
        let selected = root.path().join("selected");
        let sibling = root.path().join("sibling");
        std::fs::create_dir(&selected).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        for home in [&selected, &sibling] {
            std::fs::write(home.join("auth.json"), "fixture-token").unwrap();
            std::fs::write(home.join("history.jsonl"), "fixture-history").unwrap();
        }
        let script = root.path().join("fixture-cli.ps1");
        std::fs::write(&script, "param([string]$Action)\nif ($Action -ne 'logout') { exit 2 }\nRemove-Item -LiteralPath (Join-Path $env:CODEX_HOME 'auth.json') -ErrorAction Stop\n").unwrap();
        let cli = CliCommand {
            executable: PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            prefix: vec![
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                script.to_string_lossy().into_owned(),
            ],
        };
        let mut env: Vec<_> = env_key::process_vars_lossy()
            .into_iter()
            .filter(|(key, _)| {
                !provider_accounts::MANAGED_AUTH_ENV_KEYS
                    .iter()
                    .any(|blocked| env_key::matches(key, blocked))
            })
            .collect();
        env.push(("CODEX_HOME".into(), selected.to_string_lossy().into_owned()));
        let output = command(&cli, logout_args("codex-acp"), &env)
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        assert!(!selected.join("auth.json").exists());
        assert!(sibling.join("auth.json").exists());
        assert!(selected.join("history.jsonl").exists());
        assert!(sibling.join("history.jsonl").exists());
    }

    #[test]
    fn account_login_never_contains_logout_or_api_keys_in_arguments() {
        for provider in ["codex-acp", "claude-acp"] {
            assert!(!login_args(provider).contains(&"logout"));
            assert!(!login_args(provider).contains(&"--with-api-key"));
        }
    }

    #[test]
    fn callback_port_is_serialized_only_for_the_same_provider() {
        let first = LoginGuard::acquire("test-codex").unwrap();
        assert!(LoginGuard::acquire("test-codex").is_err());
        assert!(LoginGuard::acquire("test-claude").is_ok());
        drop(first);
        assert!(LoginGuard::acquire("test-codex").is_ok());
    }
}
