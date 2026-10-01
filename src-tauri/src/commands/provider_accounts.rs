//! Authentication commands run only in the selected account's environment.
//! Secrets are neither emitted nor returned; sign-out preserves chat history.

use crate::services::{env_key, managed_acp_tools, provider_accounts};
use provider_accounts::{AuthMethod, ProviderAccount, ProviderAccountsSnapshot};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

mod codex_login;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
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

struct LoginGuard {
    provider: String,
    cancelled: watch::Receiver<bool>,
    finished: watch::Sender<bool>,
}

struct LoginAttempt {
    account_id: Option<String>,
    attempt_id: Option<String>,
    cancel: watch::Sender<bool>,
    finished: watch::Receiver<bool>,
}

static LOGINS: OnceLock<Mutex<HashMap<String, LoginAttempt>>> = OnceLock::new();

impl LoginGuard {
    fn acquire(
        provider: &str,
        account_id: Option<&str>,
        attempt_id: Option<&str>,
    ) -> Result<Self, String> {
        let mut logins = LOGINS
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| "Account login registry is unavailable")?;
        // Providers may use a fixed local callback port. Separate providers can
        // sign in concurrently; two accounts of one provider cannot race it.
        if logins.contains_key(provider) {
            return Err(
                "Finish or cancel the current sign-in for this provider before starting another"
                    .into(),
            );
        }
        let (cancel, cancelled) = watch::channel(false);
        let (finished, completion) = watch::channel(false);
        logins.insert(
            provider.into(),
            LoginAttempt {
                account_id: account_id.map(str::to_owned),
                attempt_id: attempt_id.map(str::to_owned),
                cancel,
                finished: completion,
            },
        );
        Ok(Self {
            provider: provider.into(),
            cancelled,
            finished,
        })
    }
}

impl Drop for LoginGuard {
    fn drop(&mut self) {
        if let Ok(mut logins) = LOGINS.get_or_init(Mutex::default).lock() {
            logins.remove(&self.provider);
        }
        let _ = self.finished.send(true);
    }
}

fn cancel_login(
    account_id: &str,
    attempt_id: Option<&str>,
) -> Result<Option<watch::Receiver<bool>>, String> {
    let logins = LOGINS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Account login registry is unavailable")?;
    let Some(login) = logins
        .values()
        .find(|login| login.account_id.as_deref() == Some(account_id))
    else {
        return Ok(None);
    };
    if login.attempt_id.as_deref() != attempt_id {
        return Err(
            "This sign-in has already been replaced; refresh the account before cancelling".into(),
        );
    }
    let _ = login.cancel.send(true);
    Ok(Some(login.finished.clone()))
}

#[tauri::command]
pub async fn cancel_provider_account_authentication(
    account_id: String,
    attempt_id: Option<String>,
) -> Result<(), String> {
    if let Some(mut finished) = cancel_login(&account_id, attempt_id.as_deref())? {
        // Do not offer another sign-in until the child has exited and both
        // the provider callback port and account mutation guard are released.
        let _ = finished.wait_for(|done| *done).await;
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum LoginOutcome {
    Exited(bool),
    Cancelled,
    TimedOut,
}

async fn run_login(
    mut command: tokio::process::Command,
    mut cancelled: watch::Receiver<bool>,
    deadline: tokio::time::Instant,
) -> Result<LoginOutcome, String> {
    if *cancelled.borrow() {
        return Ok(LoginOutcome::Cancelled);
    }
    // The native CLI owns the callback listener. Await its exit on cancellation
    // instead of just dropping a timeout future while its port is still open.
    let mut child = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            "The provider sign-in process could not be started. Check its installation in Settings."
        })?;
    let outcome = tokio::select! {
        biased;
        _ = cancelled.wait_for(|cancel| *cancel) => LoginOutcome::Cancelled,
        _ = tokio::time::sleep_until(deadline) => LoginOutcome::TimedOut,
        status = child.wait() => LoginOutcome::Exited(status.map_err(|_| "Could not wait for provider sign-in to finish")?.success()),
    };
    if outcome != LoginOutcome::Exited(true) && outcome != LoginOutcome::Exited(false) {
        child
            .kill()
            .await
            .map_err(|_| "Could not stop the provider sign-in process")?;
    }
    Ok(outcome)
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
        &["app-server"]
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
    let _login_guard = LoginGuard::acquire(&account.provider_id, None, None)?;
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
            attempt_id: None,
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
    attempt_id: Option<String>,
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
            attempt_id,
            status: "authenticated".into(),
            message: "API key is saved in protected local storage".into(),
        });
    }
    let login = LoginGuard::acquire(
        &account.provider_id,
        Some(&account_id),
        attempt_id.as_deref(),
    )?;
    let mut cancelled = login.cancelled.clone();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5 * 60);
    let running = ProviderAccountAuthResult {
        account_id: account_id.clone(),
        attempt_id: attempt_id.clone(),
        status: "running".into(),
        message: "Complete the one-time sign-in in your browser".into(),
    };
    let _ = app.emit("provider-account-auth-state", &running);
    let prepare = async {
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
            return Ok(None);
        }
        let account_guard = provider_accounts::begin_account_change(&account_id)?;
        prepare_change(&app, &account_id).await?;
        Ok::<_, String>(Some((cli, env, account_guard)))
    };
    // Cancellation also covers a slow status check or an account waiting for
    // its telemetry process to release credentials, before the browser opens.
    let prepared = tokio::select! {
        biased;
        _ = cancelled.wait_for(|cancel| *cancel) => Err("Sign-in cancelled. You can start again.".into()),
        _ = tokio::time::sleep_until(deadline) => Err("Sign-in timed out. You can start again.".into()),
        result = prepare => result,
    };
    let outcome: Result<_, String> = async {
        let Some((cli, env, _account_guard)) = prepared? else {
            return Ok(("authenticated", "Saved authorization is ready"));
        };
        let command = command(&cli, login_args(&account.provider_id), &env);
        let login_outcome = if account.provider_id == "codex-acp" {
            use tauri_plugin_opener::OpenerExt;
            codex_login::run(command, cancelled, deadline, |url| {
                app.opener().open_url(url, None::<&str>)
                    .map_err(|_| "Could not open the sign-in page. Try signing in again.".to_string())
            }).await?
        } else {
            run_login(command, cancelled, deadline).await?
        };
        match login_outcome {
        LoginOutcome::Exited(true) => {
            if probe(&cli, &account, &env).await.unwrap_or(false) {
                Ok(("authenticated", "Authorization is saved. You can now switch to this account without signing in again."))
            } else {
                Ok(("needs_auth", "Sign-in finished, but saved authorization could not be verified. Try signing in again."))
            }
        }
        LoginOutcome::Exited(false) => Ok(("needs_auth", "The provider did not complete sign-in. Try signing in again.")),
        LoginOutcome::Cancelled => Ok(("needs_auth", "Sign-in cancelled. You can start again.")),
        LoginOutcome::TimedOut => Ok(("needs_auth", "Sign-in timed out. You can start again.")),
        }
    }.await;
    let (status, message) = match outcome {
        Ok((status, message)) => (status, message.to_owned()),
        Err(message) => ("needs_auth", message),
    };
    let result = ProviderAccountAuthResult {
        account_id,
        attempt_id,
        status: status.into(),
        message,
    };
    drop(login);
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
        let first = LoginGuard::acquire("test-codex", None, None).unwrap();
        assert!(LoginGuard::acquire("test-codex", None, None).is_err());
        assert!(LoginGuard::acquire("test-claude", None, None).is_ok());
        drop(first);
        assert!(LoginGuard::acquire("test-codex", None, None).is_ok());
    }

    #[tokio::test]
    async fn cancellation_is_scoped_and_waits_for_guard_release() {
        let login =
            LoginGuard::acquire("cancel-test", Some("cancel-account"), Some("new")).unwrap();
        assert!(cancel_login("sibling-account", Some("new"))
            .unwrap()
            .is_none());
        assert!(cancel_login("cancel-account", Some("old")).is_err());
        assert!(!*login.cancelled.borrow());
        let completion = cancel_login("cancel-account", Some("new"))
            .unwrap()
            .unwrap();
        assert!(*login.cancelled.borrow());
        assert!(!*completion.borrow());
        assert!(LoginGuard::acquire("cancel-test", None, None).is_err());
        drop(login);
        assert!(*completion.borrow());
        assert!(LoginGuard::acquire("cancel-test", None, None).is_ok());
    }

    #[cfg(windows)]
    async fn interrupted_login_releases_callback_port(cancel: bool, codex: bool) {
        let root = tempfile::tempdir().unwrap();
        let ready = root.path().join("ready");
        let script = root.path().join("pending-login.ps1");
        std::fs::write(
            &script,
            r#"param([int]$Port, [string]$Ready)
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
[System.IO.File]::WriteAllText($Ready, 'ready')
Start-Sleep -Seconds 30
"#,
        )
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let provider = uuid::Uuid::new_v4().to_string();
        let account = uuid::Uuid::new_v4().to_string();
        let login = LoginGuard::acquire(&provider, Some(&account), Some("first")).unwrap();
        let account_guard = provider_accounts::begin_account_change(&account).unwrap();
        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg(address.port().to_string())
        .arg(&ready)
        .kill_on_drop(true);
        crate::services::process::apply_no_window_async(&mut cmd);
        let pending = tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
            let outcome = if codex {
                codex_login::run(cmd, login.cancelled.clone(), deadline, |_| {
                    panic!("pending fixture must not open a browser")
                })
                .await
            } else {
                run_login(cmd, login.cancelled.clone(), deadline).await
            };
            drop(account_guard);
            drop(login);
            outcome
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            while !ready.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("fixture must be listening before interruption");
        assert!(provider_accounts::begin_account_change(&account).is_err());
        if cancel {
            cancel_provider_account_authentication(account.clone(), Some("first".into()))
                .await
                .unwrap();
        }
        let outcome = pending.await.unwrap().unwrap();
        assert_eq!(
            outcome,
            if cancel {
                LoginOutcome::Cancelled
            } else {
                LoginOutcome::TimedOut
            }
        );
        let _listener =
            std::net::TcpListener::bind(address).expect("callback port must already be free");
        let _login = LoginGuard::acquire(&provider, Some(&account), Some("retry")).unwrap();
        let _account = provider_accounts::begin_account_change(&account).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cancellation_stops_login_before_allowing_retry() {
        interrupted_login_releases_callback_port(true, false).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn timeout_stops_login_before_allowing_retry() {
        interrupted_login_releases_callback_port(false, false).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn codex_cancellation_stops_service_before_allowing_retry() {
        interrupted_login_releases_callback_port(true, true).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn codex_timeout_stops_service_before_allowing_retry() {
        interrupted_login_releases_callback_port(false, true).await;
    }
}
