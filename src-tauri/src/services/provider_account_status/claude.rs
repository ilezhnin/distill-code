//! The pinned Claude CLI owns OAuth refresh, credential precedence and usage.
//! Control requests do not send a prompt, start a model turn or redeem a reset.
use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};

use super::{claude_resets, now_ms, timestamp, types::*};
use crate::services::{distill_root, managed_acp_tools, process, provider_accounts};
use provider_accounts::ProviderAccount;

struct Client {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
}

impl Client {
    async fn send(&mut self, message: Value) -> Result<(), String> {
        self.input
            .write_all(format!("{message}\n").as_bytes())
            .await
            .map_err(|_| "Claude account service disconnected".to_string())?;
        self.input
            .flush()
            .await
            .map_err(|_| "Claude account service disconnected".to_string())
    }

    async fn request(&mut self, request: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = format!("distill-status-{}", self.next_id);
        self.send(json!({"type":"control_request","request_id":id,"request":request}))
            .await?;
        loop {
            let Some(line) = super::read_response_line(&mut self.output).await? else {
                return Err("Claude account service exited before replying".into());
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message["type"] == "control_request" {
                self.send(json!({"type":"control_response","response":{"subtype":"error","request_id":message["request_id"],"error":"Account telemetry cannot invoke actions"}})).await?;
                continue;
            }
            if message["type"] != "control_response" || message["response"]["request_id"] != id {
                continue;
            }
            if message["response"]["subtype"] != "success" {
                // Provider error text may contain credential material.
                return Err("Claude could not refresh account usage; check its installation and saved authorization".into());
            }
            return Ok(message["response"]["response"].clone());
        }
    }
}

async fn read_usage(
    app: &AppHandle,
    account: &ProviderAccount,
    refresh_oauth: bool,
) -> Result<(Value, Value, Option<String>), String> {
    let env: HashMap<String, String> = provider_accounts::scoped_env(
        app,
        account,
        managed_acp_tools::provider_env(app)
            .await
            .into_iter()
            .collect(),
    )?
    .into_iter()
    .collect();
    let binary = managed_acp_tools::native_cli_path(app, "claude-acp")
        .ok_or("Install the Claude provider to read account status")?;
    let home = provider_accounts::account_home(app, account)?;
    let mut command = Command::new(binary);
    command.env_clear().envs(&env);
    // Keep the probe outside project settings while preserving account auth.
    if home.is_dir() {
        command.current_dir(&home);
    }
    read_usage_command(command, refresh_oauth).await
}

pub(super) async fn read_usage_command(
    mut command: Command,
    refresh_oauth: bool,
) -> Result<(Value, Value, Option<String>), String> {
    command
        .args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--settings",
            r#"{"disableAllHooks":true}"#,
            "--setting-sources",
            "user",
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "--disable-slash-commands",
            "--tools",
            "",
            "--no-chrome",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    process::apply_no_window_async(&mut command);
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the Claude account service".to_string())?;
    let tree = process::ProcessTree::contain(&child);
    let mut client = Client {
        input: child.stdin.take().ok_or("Claude input unavailable")?,
        output: BufReader::new(child.stdout.take().ok_or("Claude output unavailable")?),
        next_id: 0,
    };
    let operation = async {
        let init = client.request(json!({"subtype":"initialize","hooks":{},"sdkMcpServers":[],"skills":[],"promptSuggestions":false})).await?;
        let usage = if refresh_oauth {
            client
                .request(json!({"subtype":"get_usage","skip_behaviors":true}))
                .await?
        } else {
            Value::Null
        };
        let version = client
            .request(json!({"subtype":"get_binary_version"}))
            .await
            .ok()
            .and_then(|value| value["version"].as_str().map(str::to_owned));
        Ok((init["account"].clone(), usage, version))
    };
    let result = tokio::time::timeout(Duration::from_secs(25), operation)
        .await
        .unwrap_or_else(|_| Err("Claude account service timed out".into()));
    drop(client);
    if let Some(tree) = &tree {
        tree.kill();
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

pub(super) fn repository_status(
    account: &ProviderAccount,
    identity: &Value,
    usage: &Value,
) -> ProviderAccountStatus {
    let mut status = ProviderAccountStatus::empty(&account.id, &account.provider_id, now_ms());
    status.subscription = plan_label(identity, &Value::Null);
    if is_api_billed(identity, usage) {
        status.subscription = Some("API".into());
        status.state = AccountState::Ready;
        return status;
    }
    if identity.is_null() {
        status.state = AccountState::NeedsAuth;
        return status;
    }
    // The CLI wraps the HTTP usage document in rate_limits.
    usage_status(status, usage.get("rate_limits").unwrap_or(usage), now_ms())
}

/// What a status read needs from the account's files, its native CLI and the
/// usage endpoint. Tests replace them to drive the real control flow.
trait UsageIo: Send {
    fn account(&self) -> &ProviderAccount;
    /// The saved OAuth block of this account, or null when it has none.
    fn saved_oauth(&mut self) -> Result<Value, String>;
    /// Reads the identity through the native CLI, which refreshes OAuth when
    /// asked; returns the identity and the CLI's version.
    fn probe(&mut self, refresh: bool) -> BoxFuture<'_, Result<(Value, Option<String>), String>>;
    fn plan(&mut self, identity: &Value) -> Option<String>;
    /// Whether the CLI reports the account as signed in, when it can tell.
    fn signed_in(&mut self) -> BoxFuture<'_, Option<bool>>;
    /// One usage read; an active usage pause answers without a request.
    fn fetch_usage<'a>(
        &'a mut self,
        version: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Value, claude_resets::RequestError>>;
}

struct NativeUsage<'a> {
    app: &'a AppHandle,
    account: &'a ProviderAccount,
}

impl UsageIo for NativeUsage<'_> {
    fn account(&self) -> &ProviderAccount {
        self.account
    }
    fn saved_oauth(&mut self) -> Result<Value, String> {
        saved_oauth(self.app, self.account)
    }
    fn probe(&mut self, refresh: bool) -> BoxFuture<'_, Result<(Value, Option<String>), String>> {
        Box::pin(async move {
            read_usage(self.app, self.account, refresh)
                .await
                .map(|(identity, _, version)| (identity, version))
        })
    }
    fn plan(&mut self, identity: &Value) -> Option<String> {
        account_plan(self.app, self.account, identity)
    }
    fn signed_in(&mut self) -> BoxFuture<'_, Option<bool>> {
        Box::pin(async move {
            crate::commands::provider_accounts::probe_account_auth(self.app, self.account)
                .await
                .ok()
        })
    }
    fn fetch_usage<'a>(
        &'a mut self,
        version: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Value, claude_resets::RequestError>> {
        Box::pin(claude_resets::fetch_usage(self.app, self.account, version))
    }
}

pub(super) async fn fetch(
    app: &AppHandle,
    account: &ProviderAccount,
) -> Result<ProviderAccountStatus, String> {
    fetch_with(&mut NativeUsage { app, account }).await
}

/// Only signing in again (`forget_account`) clears a usage pause; nothing on
/// this path may, or a routine token refresh would send a request inside it.
async fn fetch_with(io: &mut impl UsageIo) -> Result<ProviderAccountStatus, String> {
    let refresh_oauth = refresh_before_probe(&io.saved_oauth()?, now_ms());
    let (identity, mut version) = io.probe(refresh_oauth).await?;
    let account = io.account();
    let mut status = ProviderAccountStatus::empty(&account.id, &account.provider_id, now_ms());
    status.account_label = identity["email"].as_str().map(str::to_owned);
    status.subscription = io.plan(&identity);
    if is_api_billed(&identity, &Value::Null) {
        status.subscription = Some("API".into());
        status.state = AccountState::Ready;
        return Ok(status);
    }
    // initialize can return a cached profile while its OAuth token has expired.
    // get_usage lets the native CLI refresh it without starting a model turn.
    // Never send expired credentials to the usage endpoint: its 429 can hide
    // an authorization failure behind a long telemetry cooldown. A routine
    // refresh keeps the usage pause; signing in again clears it.
    if let Some(report) = restore_authorization(io, refresh_oauth, &status, &mut version).await {
        return Ok(report);
    }
    if status.subscription.is_none() {
        status.state = if io.signed_in().await.unwrap_or(false) {
            AccountState::Unknown
        } else {
            AccountState::NeedsAuth
        };
        return Ok(status);
    }
    // One usage request returns both quota and reset grants. Calling get_usage
    // first doubles traffic to the same endpoint and can exhaust its read limit.
    let mut usage = io.fetch_usage(version.as_deref()).await;
    if matches!(usage, Err(claude_resets::RequestError::Unauthorized)) {
        // OAuth refresh remains owned by the native CLI. Retry a rejected read
        // once after that refresh; a 429 never triggers another request here.
        match io.probe(true).await {
            Ok((_, current)) => version = current.or(version),
            Err(error) => return Ok(usage_failure(status, error.into())),
        }
        if let Some(report) = restore_authorization(io, true, &status, &mut version).await {
            return Ok(report);
        }
        usage = io.fetch_usage(version.as_deref()).await;
    }
    let usage = match usage {
        Ok(usage) => usage,
        // Rejected again after the CLI refreshed it: the provider revoked it.
        Err(claude_resets::RequestError::Unauthorized) => {
            status.state = AccountState::NeedsAuth;
            return Ok(status);
        }
        Err(error) => return Ok(usage_failure(status, error)),
    };
    Ok(usage_status(status, &usage, now_ms()))
}

/// Applies a usage reply. The identity and plan already read survive a reply
/// without quota, and a malformed optional reset inventory never discards
/// valid quota; its grants stay unknown and cannot be redeemed.
fn usage_status(
    mut status: ProviderAccountStatus,
    usage: &Value,
    now: i64,
) -> ProviderAccountStatus {
    if !usage["limits"].is_array()
        && !usage["five_hour"].is_object()
        && !usage["seven_day"].is_object()
    {
        return usage_failure(
            status,
            claude_resets::RequestError::Other(
                "Claude subscription usage is temporarily unavailable".into(),
            ),
        );
    }
    map_usage(&mut status, usage);
    status.reset_tokens = claude_resets::map_inventory(usage, now).unwrap_or_else(|error| {
        log::warn!("Claude reset inventory ignored: {error}");
        None
    });
    status
}

/// Ask the CLI to refresh within its own five-minute margin, so a token cannot
/// lapse while a probe that did not request a refresh starts.
const OAUTH_REFRESH_MARGIN_MS: i64 = 5 * 60_000;

fn refresh_before_probe(oauth: &Value, now: i64) -> bool {
    oauth_needs_refresh(oauth, now.saturating_add(OAUTH_REFRESH_MARGIN_MS))
}

#[derive(Debug, PartialEq, Eq)]
enum AuthorizationStep {
    /// The saved access token is live; usage may be read with it.
    Proceed,
    /// The token lapsed during a probe that never asked the CLI to refresh it.
    Refresh,
    /// The CLI was asked to refresh and the token is still not live.
    Unrestored,
}

fn authorization_step(refresh_requested: bool, oauth: &Value, now: i64) -> AuthorizationStep {
    if !oauth_needs_refresh(oauth, now) {
        AuthorizationStep::Proceed
    } else if refresh_requested {
        AuthorizationStep::Unrestored
    } else {
        AuthorizationStep::Refresh
    }
}

/// Returns the status to report instead of reading usage, if the saved token
/// is not live. The CLI is asked to refresh it at most once here.
async fn restore_authorization(
    io: &mut impl UsageIo,
    mut refresh_requested: bool,
    status: &ProviderAccountStatus,
    version: &mut Option<String>,
) -> Option<ProviderAccountStatus> {
    loop {
        let oauth = match io.saved_oauth() {
            Ok(oauth) => oauth,
            Err(error) => return Some(usage_failure(status.clone(), error.into())),
        };
        match authorization_step(refresh_requested, &oauth, now_ms()) {
            AuthorizationStep::Proceed => return None,
            AuthorizationStep::Refresh => match io.probe(true).await {
                Ok((_, current)) => *version = current.or(version.take()),
                Err(error) => return Some(usage_failure(status.clone(), error.into())),
            },
            AuthorizationStep::Unrestored => {
                let signed_in = if has_refresh_token(&oauth) {
                    io.signed_in().await
                } else {
                    None
                };
                return Some(unrestored_status(
                    status.clone(),
                    unrestored_needs_sign_in(&oauth, signed_in),
                ));
            }
        }
        refresh_requested = true;
    }
}

fn has_refresh_token(oauth: &Value) -> bool {
    oauth["refreshToken"]
        .as_str()
        .is_some_and(|token| !token.is_empty())
}

/// Only positive evidence of sign-out requires a new sign-in: no saved refresh
/// token, or the CLI reporting the account as signed out. A refresh that failed
/// for a passing reason (offline after wake, provider outage) is not.
fn unrestored_needs_sign_in(oauth: &Value, signed_in: Option<bool>) -> bool {
    !has_refresh_token(oauth) || signed_in == Some(false)
}

/// A failed refresh is a telemetry failure: the account stays connected with
/// its last known plan and quota, and the next poll retries.
fn unrestored_status(
    mut status: ProviderAccountStatus,
    needs_sign_in: bool,
) -> ProviderAccountStatus {
    if needs_sign_in {
        status.state = AccountState::NeedsAuth;
        return status;
    }
    usage_failure(
        status,
        claude_resets::RequestError::Other(
            "Claude authorization could not be refreshed; retrying".into(),
        ),
    )
}

/// The saved OAuth block of this account, or null when it has none.
fn saved_oauth(app: &AppHandle, account: &ProviderAccount) -> Result<Value, String> {
    let root = distill_root::app_root(app)?;
    let path = provider_accounts::account_home(app, account)?.join(".credentials.json");
    distill_root::reject_document_links(&root, &path)?;
    let mut value = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "Cannot read Claude authorization".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(_) => return Err("Cannot read Claude authorization".into()),
    };
    // get_mut, unlike IndexMut, cannot panic on a non-object file.
    Ok(value
        .get_mut("claudeAiOauth")
        .map(Value::take)
        .unwrap_or_default())
}

pub(super) fn authorization_needs_refresh(
    app: &AppHandle,
    account: &ProviderAccount,
) -> Result<bool, String> {
    Ok(oauth_needs_refresh(&saved_oauth(app, account)?, now_ms()))
}

fn oauth_needs_refresh(oauth: &Value, now: i64) -> bool {
    oauth["accessToken"].as_str().is_none_or(str::is_empty)
        || oauth["expiresAt"]
            .as_i64()
            .is_none_or(|expires| expires <= now)
}

fn usage_failure(
    mut status: ProviderAccountStatus,
    error: claude_resets::RequestError,
) -> ProviderAccountStatus {
    status.error = Some(match &error {
        claude_resets::RequestError::RateLimited(seconds) => {
            status.usage_retry_at = Some(
                now_ms().saturating_add(((*seconds).min(i64::MAX as u64 / 1000) * 1000) as i64),
            );
            // usage_retry_at carries the deadline. A number stored here would
            // freeze in the cached status for the whole pause.
            "Claude usage requests are paused by the provider.".into()
        }
        error => error.to_string(),
    });
    status.state = AccountState::Error;
    status.stale = true;
    status
}

pub(super) async fn consume(
    app: &AppHandle,
    account: &ProviderAccount,
    idempotency_key: &str,
    credit_id: Option<&str>,
) -> Result<ResetResult, String> {
    let credit_id = credit_id.ok_or("Select a Claude reset before confirming")?;
    // Let the native CLI refresh OAuth before reading its account-scoped token.
    let (identity, usage, version) = read_usage(app, account, true).await?;
    if is_api_billed(&identity, &usage) || usage["subscription_type"].is_null() {
        return Err("Claude limit resets require a subscription account".into());
    }
    let _guard = provider_accounts::begin_account_change(&account.id)?;
    claude_resets::consume(app, account, version.as_deref(), idempotency_key, credit_id).await
}

fn is_api_billed(identity: &Value, usage: &Value) -> bool {
    identity["apiProvider"]
        .as_str()
        .is_some_and(|provider| provider != "firstParty")
        || (usage["subscription_type"].is_null()
            && identity["apiKeySource"]
                .as_str()
                .is_some_and(|source| !source.is_empty() && source != "none"))
}

fn account_plan(app: &AppHandle, account: &ProviderAccount, identity: &Value) -> Option<String> {
    // The native profile records upgrades and Max tiers that the credential's
    // subscriptionType (and initialize response) can omit or leave outdated.
    let profile = (|| {
        let root = distill_root::app_root(app).ok()?;
        let path = provider_accounts::account_home(app, account)
            .ok()?
            .join(".claude.json");
        distill_root::reject_document_links(&root, &path).ok()?;
        serde_json::from_slice::<Value>(&std::fs::read(path).ok()?).ok()
    })()
    .unwrap_or(Value::Null);
    plan_label(identity, &profile["oauthAccount"])
}

fn plan_label(identity: &Value, profile: &Value) -> Option<String> {
    // Never borrow profile metadata from a different signed-in identity.
    let profile = match (identity["email"].as_str(), profile["emailAddress"].as_str()) {
        (Some(email), Some(saved)) if email.eq_ignore_ascii_case(saved) => profile,
        _ => &Value::Null,
    };
    let family = |plan: &str| match plan {
        "claude_max" | "max" | "Claude Max" => Some("Claude Max"),
        "claude_pro" | "pro" | "Claude Pro" => Some("Claude Pro"),
        "claude_team" | "team" | "Claude Team" => Some("Claude Team"),
        "claude_enterprise" | "enterprise" | "Claude Enterprise" => Some("Claude Enterprise"),
        "claude_free" | "free" | "Claude Free" => Some("Claude Free"),
        _ => None,
    };
    let name = profile["organizationType"]
        .as_str()
        .and_then(family)
        .or_else(|| identity["subscriptionType"].as_str().and_then(family))?;
    let tier = profile["userRateLimitTier"]
        .as_str()
        .filter(|value| !value.is_empty())
        .or_else(|| profile["organizationRateLimitTier"].as_str());
    Some(match (name, tier) {
        ("Claude Max", Some("default_claude_max_5x")) => "Claude Max (5x)".into(),
        ("Claude Max", Some("default_claude_max_20x")) => "Claude Max (20x)".into(),
        _ => name.into(),
    })
}

pub(super) fn map_usage(status: &mut ProviderAccountStatus, usage: &Value) {
    status.credits = credit_balances(usage);
    // Newer CLIs expose authoritative server rows. Prefer them to the legacy
    // compatibility windows so each allowance appears only once.
    if usage["limits"].as_array().is_none() {
        if let Some(windows) = usage.as_object() {
            for (id, window) in windows {
                // Monetary grants are balances, not subscription quota windows.
                if id != "five_hour" && !id.starts_with("seven_day") {
                    continue;
                }
                let Some(used) = window
                    .get("utilization")
                    .or_else(|| window.get("used_percentage"))
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                else {
                    continue;
                };
                let model_id = id
                    .strip_prefix("seven_day_")
                    .filter(|name| *name != "all" && *name != "oauth_apps")
                    .map(str::to_owned);
                status.limits.push(AccountLimitWindow {
                    id: id.clone(),
                    window_minutes: window_minutes(id),
                    label: id.replace('_', " "),
                    used_percent: Some(used.clamp(0.0, 100.0)),
                    remaining: Some((100.0 - used).clamp(0.0, 100.0)),
                    resets_at: window
                        .get("resets_at")
                        .or_else(|| window.get("resetsAt"))
                        .and_then(timestamp),
                    model_id,
                });
            }
        }
    }
    if let Some(windows) = usage["limits"].as_array() {
        for (index, window) in windows.iter().enumerate() {
            let Some(used) = window["percent"].as_f64().filter(|value| value.is_finite()) else {
                continue;
            };
            let model = window
                .pointer("/scope/model/display_name")
                .and_then(Value::as_str);
            let surface = window
                .pointer("/scope/surface/display_name")
                .and_then(Value::as_str);
            let kind = window["kind"].as_str().unwrap_or("usage");
            status.limits.push(AccountLimitWindow {
                id: format!("{kind}:{index}"),
                window_minutes: window_minutes(kind),
                label: model
                    .map(|model| format!("{model} · {kind}"))
                    .unwrap_or_else(|| kind.into()),
                used_percent: Some(used.clamp(0.0, 100.0)),
                remaining: Some((100.0 - used).clamp(0.0, 100.0)),
                resets_at: timestamp(&window["resets_at"]),
                model_id: model
                    .or_else(|| surface.filter(|name| !name.eq_ignore_ascii_case("claude code")))
                    .map(str::to_ascii_lowercase),
            });
        }
    }
    if usage["limits"].as_array().is_none() {
        if let Some(windows) = usage["model_scoped"].as_array() {
            for window in windows {
                let Some(model) = window["display_name"].as_str() else {
                    continue;
                };
                let Some(used) = window["utilization"]
                    .as_f64()
                    .filter(|value| value.is_finite())
                else {
                    continue;
                };
                if status.limits.iter().any(|limit| {
                    limit
                        .model_id
                        .as_deref()
                        .is_some_and(|id| id.eq_ignore_ascii_case(model))
                }) {
                    continue;
                }
                status.limits.push(AccountLimitWindow {
                    id: format!("model:{}", model.to_ascii_lowercase()),
                    window_minutes: Some(10_080),
                    label: format!("{model} · weekly"),
                    used_percent: Some(used.clamp(0.0, 100.0)),
                    remaining: Some((100.0 - used).clamp(0.0, 100.0)),
                    resets_at: timestamp(&window["resets_at"]),
                    model_id: Some(model.to_ascii_lowercase()),
                });
            }
        }
    }
    status.state = if status.limits.iter().any(|window| {
        window.model_id.is_none() && window.used_percent.is_some_and(|used| used >= 100.0)
    }) {
        AccountState::Limited
    } else if status.limits.is_empty() {
        AccountState::Unknown
    } else {
        AccountState::Ready
    };
}

fn credit_balances(usage: &Value) -> Option<Vec<CreditBalance>> {
    let mut balances = Vec::new();
    for (id, grant) in usage.as_object()? {
        let number = |key: &str| grant[key].as_f64().filter(|n| n.is_finite() && *n >= 0.0);
        let Some(balance) = number("remaining_dollars") else {
            continue;
        };
        let label = grant["display_name"].as_str().unwrap_or(match id.as_str() {
            "iguana_necktie" => "Cloud session credits",
            _ => "Included credits",
        });
        balances.push(CreditBalance {
            id: id.clone(),
            label: label.into(),
            balance: Some(balance.to_string()),
            total: number("limit_dollars").map(|n| n.to_string()),
            currency: Some("USD".into()),
            expires_at: timestamp(&grant["resets_at"]),
            unlimited: false,
        });
    }
    let money = &usage["spend"]["balance"];
    if let (Some(amount), Some(currency), Some(exponent)) = (
        money["amount_minor"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0),
        money["currency"]
            .as_str()
            .filter(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase())),
        money["exponent"].as_u64().filter(|e| *e <= 6),
    ) {
        balances.push(CreditBalance {
            id: "usage_credits".into(),
            label: "Usage credits".into(),
            balance: Some((amount / 10_f64.powi(exponent as i32)).to_string()),
            total: None,
            currency: Some(currency.into()),
            expires_at: None,
            unlimited: false,
        });
    }
    (!balances.is_empty()).then_some(balances)
}

fn window_minutes(kind: &str) -> Option<u32> {
    match kind {
        "five_hour" | "session" => Some(300),
        "seven_day" | "weekly" | "weekly_all" | "weekly_scoped" => Some(10_080),
        key if key.starts_with("seven_day_") => Some(10_080),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn first_usage_failure_retains_the_native_plan_and_identity() {
        let mut status = super::ProviderAccountStatus::empty("a", "claude-acp", super::now_ms());
        status.subscription = Some("Claude Max (5x)".into());
        status.account_label = Some("Current account".into());
        let before = super::now_ms();
        let failed = super::usage_failure(
            status,
            super::claude_resets::RequestError::RateLimited(2067),
        );
        assert_eq!(failed.subscription.as_deref(), Some("Claude Max (5x)"));
        assert_eq!(failed.account_label.as_deref(), Some("Current account"));
        assert_eq!(failed.state, super::AccountState::Error);
        assert!(failed.stale);
        assert!(failed.usage_retry_at.unwrap() >= before + 2_067_000);
        assert!(failed.limits.is_empty());
    }

    #[test]
    fn a_usage_pause_stores_no_countdown_that_could_freeze() {
        let status = super::ProviderAccountStatus::empty("a", "claude-acp", super::now_ms());
        let failed = super::usage_failure(
            status,
            super::claude_resets::RequestError::RateLimited(2067),
        );
        // The cached status is returned unchanged for the whole pause.
        let error = failed.error.unwrap();
        assert!(!error.chars().any(|c| c.is_ascii_digit()), "{error}");
        assert!(failed.usage_retry_at.is_some());
    }

    fn live_oauth(expires_at: i64) -> Value {
        json!({"accessToken":"fixture","refreshToken":"fixture","expiresAt":expires_at})
    }

    #[test]
    fn a_token_near_expiry_is_refreshed_before_the_probe_starts() {
        let now = 1_000_000;
        // Valid now, but it could lapse while the CLI starts.
        assert!(super::refresh_before_probe(&live_oauth(now + 3_000), now));
        assert!(super::refresh_before_probe(&live_oauth(now - 1), now));
        assert!(!super::refresh_before_probe(
            &live_oauth(now + 3_600_000),
            now
        ));
    }

    #[test]
    fn a_token_that_lapses_during_a_plain_probe_is_refreshed_before_any_verdict() {
        use super::AuthorizationStep::*;
        let now = 1_000_000;
        let expired = live_oauth(now - 1);
        assert_eq!(super::authorization_step(false, &expired, now), Refresh);
        assert_eq!(super::authorization_step(true, &expired, now), Unrestored);
        assert_eq!(
            super::authorization_step(true, &Value::Null, now),
            Unrestored
        );
        for requested in [false, true] {
            let live = live_oauth(now + 1);
            assert_eq!(super::authorization_step(requested, &live, now), Proceed);
        }
    }

    #[test]
    fn only_positive_evidence_of_sign_out_requires_sign_in() {
        // get_usage succeeded but swallowed a failed refresh: still expired.
        let expired = live_oauth(1);
        assert!(!super::unrestored_needs_sign_in(&expired, Some(true)));
        assert!(!super::unrestored_needs_sign_in(&expired, None));
        assert!(super::unrestored_needs_sign_in(&expired, Some(false)));
        let no_refresh = json!({"accessToken":"fixture","refreshToken":"","expiresAt":1});
        assert!(super::unrestored_needs_sign_in(&no_refresh, Some(true)));
        assert!(super::unrestored_needs_sign_in(&Value::Null, None));
    }

    #[test]
    fn a_failed_token_refresh_keeps_the_account_connected_and_routable() {
        use crate::services::provider_accounts::AuthMethod;
        let mut old = ProviderAccountStatus::empty("a", "claude-acp", 1000);
        old.state = AccountState::Ready;
        old.subscription = Some("Claude Max (5x)".into());
        old.limits.push(AccountLimitWindow {
            id: "session:0".into(),
            label: "session".into(),
            used_percent: Some(20.0),
            remaining: Some(80.0),
            resets_at: None,
            window_minutes: Some(300),
            model_id: None,
        });
        let mut fresh = ProviderAccountStatus::empty("a", "claude-acp", 2000);
        fresh.account_label = Some("a@example.test".into());
        let failed = unrestored_status(fresh.clone(), false);
        assert_eq!(failed.state, AccountState::Error);
        assert!(failed.stale);
        assert_eq!(failed.usage_retry_at, None);
        assert_eq!(failed.account_label.as_deref(), Some("a@example.test"));
        let merged = super::super::merge_refresh(Some(&old), failed);
        assert_eq!(merged.subscription.as_deref(), Some("Claude Max (5x)"));
        assert_eq!(merged.limits, old.limits);
        let account = ProviderAccount {
            id: "a".into(),
            provider_id: "claude-acp".into(),
            label: "a".into(),
            auth_method: AuthMethod::OAuth,
            enabled: true,
            auto_switch: true,
            created_at: 0,
            updated_at: 0,
        };
        assert_eq!(
            super::super::choose_account(&[account], &[merged], "a", true, None, 3000).unwrap(),
            AccountSelection::Ready {
                account_id: "a".into()
            }
        );
        assert_eq!(
            unrestored_status(fresh, true).state,
            AccountState::NeedsAuth
        );
    }

    /// A scripted account: its token, what the CLI's refresh does to it, its
    /// sign-in report, and a usage endpoint that honours the provider's pause
    /// like the real one and counts the requests it sends.
    struct ScriptedUsage {
        account: ProviderAccount,
        oauth: Value,
        refreshed: Value,
        /// The token after a probe that did not ask for a refresh, when it
        /// lapsed meanwhile.
        after_plain_probe: Option<Value>,
        signed_in: Option<bool>,
        probes: Vec<bool>,
        sign_in_checks: usize,
        sent: usize,
    }

    impl ScriptedUsage {
        fn new(id: &str, oauth: Value, refreshed: Value) -> Self {
            Self {
                account: ProviderAccount {
                    id: id.into(),
                    provider_id: "claude-acp".into(),
                    label: id.into(),
                    auth_method: crate::services::provider_accounts::AuthMethod::OAuth,
                    enabled: true,
                    auto_switch: true,
                    created_at: 0,
                    updated_at: 0,
                },
                oauth,
                refreshed,
                after_plain_probe: None,
                signed_in: Some(true),
                probes: Vec::new(),
                sign_in_checks: 0,
                sent: 0,
            }
        }
    }

    impl UsageIo for ScriptedUsage {
        fn account(&self) -> &ProviderAccount {
            &self.account
        }
        fn saved_oauth(&mut self) -> Result<Value, String> {
            Ok(self.oauth.clone())
        }
        fn probe(
            &mut self,
            refresh: bool,
        ) -> BoxFuture<'_, Result<(Value, Option<String>), String>> {
            self.probes.push(refresh);
            if refresh {
                self.oauth = self.refreshed.clone();
            } else if let Some(lapsed) = &self.after_plain_probe {
                self.oauth = lapsed.clone();
            }
            Box::pin(async { Ok((json!({"email":"a@example.test"}), Some("2.1.0".into()))) })
        }
        fn plan(&mut self, _: &Value) -> Option<String> {
            Some("Claude Max (5x)".into())
        }
        fn signed_in(&mut self) -> BoxFuture<'_, Option<bool>> {
            self.sign_in_checks += 1;
            let signed_in = self.signed_in;
            Box::pin(async move { signed_in })
        }
        fn fetch_usage<'a>(
            &'a mut self,
            _: Option<&'a str>,
        ) -> BoxFuture<'a, Result<Value, claude_resets::RequestError>> {
            let paused = claude_resets::usage_backoff_remaining(&self.account.id, now_ms());
            if paused.is_none() {
                self.sent += 1;
            }
            Box::pin(async move {
                match paused {
                    Some(seconds) => Err(claude_resets::RequestError::RateLimited(seconds)),
                    None => Ok(json!({"five_hour":{"utilization":20}})),
                }
            })
        }
    }

    #[tokio::test]
    async fn a_routine_token_refresh_keeps_the_usage_pause() {
        let id = "claude-routine-refresh";
        assert!(claude_resets::record_usage_result(
            id,
            now_ms(),
            Err(claude_resets::RequestError::RateLimited(2067))
        )
        .is_err());
        // The token expired; the CLI's routine refresh restores it.
        let mut io = ScriptedUsage::new(id, live_oauth(1), live_oauth(now_ms() + 3_600_000));
        let status = fetch_with(&mut io).await.unwrap();
        assert_eq!(io.probes, [true]);
        // No request inside the provider's Retry-After, and the pause stays.
        assert_eq!(io.sent, 0);
        assert_eq!(status.state, AccountState::Error);
        assert!(status.usage_retry_at.is_some());
        assert_eq!(status.subscription.as_deref(), Some("Claude Max (5x)"));
        assert!(claude_resets::usage_backoff_remaining(id, now_ms()).is_some_and(|s| s > 2000));
        // Without a pause the same path reads usage once.
        let mut io = ScriptedUsage::new(
            "claude-routine-refresh-free",
            live_oauth(1),
            live_oauth(now_ms() + 3_600_000),
        );
        assert_eq!(
            fetch_with(&mut io).await.unwrap().state,
            AccountState::Ready
        );
        assert_eq!(io.sent, 1);
    }

    #[tokio::test]
    async fn a_token_expiring_within_the_margin_is_refreshed_by_the_first_probe() {
        let mut io = ScriptedUsage::new(
            "claude-near-expiry",
            live_oauth(now_ms() + 3_000),
            live_oauth(now_ms() + 3_600_000),
        );
        let status = fetch_with(&mut io).await.unwrap();
        assert_eq!(io.probes, [true]);
        assert_eq!(status.state, AccountState::Ready);
        assert_eq!(io.sent, 1);
    }

    #[tokio::test]
    async fn a_token_that_lapses_during_a_plain_probe_is_refreshed_and_read() {
        let mut io = ScriptedUsage::new(
            "claude-lapsed-mid-probe",
            live_oauth(now_ms() + 600_000),
            live_oauth(now_ms() + 3_600_000),
        );
        io.after_plain_probe = Some(live_oauth(1));
        let status = fetch_with(&mut io).await.unwrap();
        assert_eq!(io.probes, [false, true]);
        assert_eq!(status.state, AccountState::Ready);
        assert_eq!(io.sent, 1);
        assert_eq!(io.sign_in_checks, 0);
    }

    #[tokio::test]
    async fn a_refresh_that_fails_for_a_passing_reason_keeps_the_account_connected() {
        let expired = live_oauth(1);
        for (signed_in, needs_sign_in) in [(Some(true), false), (None, false), (Some(false), true)]
        {
            let mut io = ScriptedUsage::new("claude-unrestored", expired.clone(), expired.clone());
            io.signed_in = signed_in;
            let status = fetch_with(&mut io).await.unwrap();
            assert_eq!(io.sent, 0, "{signed_in:?}");
            assert_eq!(io.sign_in_checks, 1, "{signed_in:?}");
            if needs_sign_in {
                assert_eq!(status.state, AccountState::NeedsAuth);
            } else {
                assert_eq!(status.state, AccountState::Error, "{signed_in:?}");
                assert!(status.stale);
                assert_eq!(status.usage_retry_at, None);
            }
        }
        // Without a refresh token the account is signed out; the CLI is not asked.
        let signed_out = json!({"accessToken":"fixture","refreshToken":"","expiresAt":1});
        let mut io = ScriptedUsage::new("claude-signed-out", signed_out.clone(), signed_out);
        assert_eq!(
            fetch_with(&mut io).await.unwrap().state,
            AccountState::NeedsAuth
        );
        assert_eq!(io.sign_in_checks, 0);
    }

    #[test]
    fn usage_without_quota_keeps_the_native_plan_and_identity() {
        for usage in [json!({}), json!({"limits":null})] {
            let mut status = ProviderAccountStatus::empty("a", "claude-acp", 1000);
            status.subscription = Some("Claude Max (5x)".into());
            status.account_label = Some("a@example.test".into());
            let failed = usage_status(status, &usage, 1000);
            assert_eq!(failed.state, AccountState::Error);
            assert!(failed.stale);
            assert_eq!(failed.subscription.as_deref(), Some("Claude Max (5x)"));
            assert_eq!(failed.account_label.as_deref(), Some("a@example.test"));
        }
    }

    #[test]
    fn a_malformed_reset_inventory_keeps_valid_quota() {
        let mut status = ProviderAccountStatus::empty("a", "claude-acp", 1000);
        status.subscription = Some("Claude Max (5x)".into());
        status.account_label = Some("a@example.test".into());
        let usage = json!({
            "five_hour":{"utilization":20},
            "seven_day":{"utilization":40},
            "cedar_ember":{"eligible":true,"grants":[{"id":"Launch","resets_left":1,
                "paused":false,"usable_now":true,"clears":[]}]}
        });
        let result = usage_status(status, &usage, 1000);
        assert_eq!(result.state, AccountState::Ready);
        assert_eq!(result.limits.len(), 2);
        assert_eq!(result.reset_tokens, None);
        assert_eq!(result.error, None);
        assert_eq!(result.subscription.as_deref(), Some("Claude Max (5x)"));
        assert_eq!(result.account_label.as_deref(), Some("a@example.test"));
    }

    #[test]
    fn oauth_without_a_live_access_token_needs_refresh() {
        let oauth = json!({"accessToken":"fixture", "expiresAt":2000});
        assert!(!super::oauth_needs_refresh(&oauth, 1999));
        assert!(super::oauth_needs_refresh(&oauth, 2000));
        assert!(super::oauth_needs_refresh(
            &json!({"accessToken":"fixture", "expiresAt":0}),
            1
        ));
        assert!(super::oauth_needs_refresh(
            &json!({"accessToken":"", "expiresAt":2000}),
            1
        ));
        assert!(super::oauth_needs_refresh(&Value::Null, 1));
    }

    use super::*;

    #[test]
    fn credit_grants_are_balances_and_never_exhaust_subscription_quota() {
        let mut status = ProviderAccountStatus::empty("one", "claude-acp", 0);
        map_usage(
            &mut status,
            &json!({
                "five_hour":{"utilization":20},
                "iguana_necktie":{"utilization":100,"limit_dollars":250,"remaining_dollars":0,"resets_at":"2026-11-05T07:59:00Z"},
                "project_grant":{"display_name":"Project setup credit","utilization":42,"limit_dollars":100,"remaining_dollars":58}
            }),
        );
        assert_eq!(status.state, AccountState::Ready);
        assert_eq!(status.limits.len(), 1);
        let balances = status.credits.unwrap();
        assert_eq!(balances.len(), 2);
        assert_eq!(balances[0].label, "Cloud session credits");
        assert_eq!(balances[0].balance.as_deref(), Some("0"));
        assert_eq!(balances[0].total.as_deref(), Some("250"));
        assert_eq!(balances[0].currency.as_deref(), Some("USD"));
        assert!(balances[0].expires_at.is_some());
        assert_eq!(balances[1].label, "Project setup credit");
    }

    #[test]
    fn purchased_credits_respect_currency_exponent_and_unknown_values() {
        for (currency, exponent, minor, expected) in [
            ("USD", 2, 1234, "12.34"),
            ("JPY", 0, 1234, "1234"),
            ("KWD", 3, 1234, "1.234"),
            ("USD", 2, 0, "0"),
        ] {
            let rows = credit_balances(&json!({"spend":{"balance":{"amount_minor":minor,"currency":currency,"exponent":exponent}}})).unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].balance.as_deref(), Some(expected));
            assert_eq!(rows[0].currency.as_deref(), Some(currency));
        }
        for value in [
            Value::Null,
            json!({"spend":{"balance":null}}),
            json!({"spend":{"used":{"amount_minor":500,"currency":"USD","exponent":2}}}),
            json!({"spend":{"balance":{"amount_minor":-1,"currency":"USD","exponent":2}}}),
            json!({"spend":{"balance":{"amount_minor":100,"currency":"USD","exponent":99}}}),
        ] {
            assert!(credit_balances(&value).is_none());
        }
    }

    #[test]
    fn native_profile_upgrade_overrides_stale_subscription_type() {
        let identity = json!({"email":"a@example.test","subscriptionType":"Claude Pro"});
        for (tier, expected) in [
            ("default_claude_max_5x", "Claude Max (5x)"),
            ("default_claude_max_20x", "Claude Max (20x)"),
        ] {
            let profile = json!({"emailAddress":"a@example.test","organizationType":"claude_max","organizationRateLimitTier":tier});
            assert_eq!(plan_label(&identity, &profile).as_deref(), Some(expected));
        }
    }

    #[test]
    fn unknown_tiers_and_mismatched_profiles_do_not_invent_a_plan() {
        let identity = json!({"email":"a@example.test","subscriptionType":"max"});
        let profile = json!({"emailAddress":"other@example.test","organizationType":"claude_pro","organizationRateLimitTier":"default_claude_max_5x"});
        assert_eq!(
            plan_label(&identity, &profile).as_deref(),
            Some("Claude Max")
        );
        let profile = json!({"emailAddress":"a@example.test","organizationType":"claude_max","organizationRateLimitTier":"future_tier"});
        assert_eq!(
            plan_label(&identity, &profile).as_deref(),
            Some("Claude Max")
        );
        assert_eq!(plan_label(&Value::Null, &profile), None);
    }

    #[test]
    fn individual_tier_wins_and_usage_does_not_downgrade_the_plan() {
        let identity = json!({"email":"a@example.test","subscriptionType":"max"});
        let profile = json!({"emailAddress":"a@example.test","organizationType":"claude_max","organizationRateLimitTier":"default_claude_max_20x","userRateLimitTier":"default_claude_max_5x"});
        let mut status = ProviderAccountStatus::empty("one", "claude-acp", 0);
        status.subscription = plan_label(&identity, &profile);
        map_usage(
            &mut status,
            &json!({"plan_type":"Claude Max","five_hour":{"utilization":20}}),
        );
        assert_eq!(status.subscription.as_deref(), Some("Claude Max (5x)"));
    }

    #[test]
    fn effective_api_source_overrides_stored_oauth_identity() {
        assert!(is_api_billed(
            &json!({"apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY","tokenSource":"claude.ai"}),
            &json!({"subscription_type":null})
        ));
        assert!(is_api_billed(
            &json!({"apiProvider":"bedrock"}),
            &Value::Null
        ));
        assert!(!is_api_billed(
            &json!({"apiProvider":"firstParty"}),
            &json!({"subscription_type":"max"})
        ));
    }

    #[test]
    fn authoritative_rows_do_not_duplicate_legacy_windows() {
        let mut status = ProviderAccountStatus::empty("one", "claude-acp", 0);
        map_usage(
            &mut status,
            &json!({"five_hour":{"utilization":50},"limits":[{"kind":"session","percent":50},{"kind":"weekly_scoped","percent":100,"scope":{"model":{"display_name":"Fable"}}}]}),
        );
        assert_eq!(status.limits.len(), 2);
        assert_eq!(status.limits[1].model_id.as_deref(), Some("fable"));
        assert_eq!(status.state, AccountState::Ready);
    }

    #[test]
    fn shared_weekly_rows_have_a_duration_for_every_usage_view() {
        let mut status = ProviderAccountStatus::empty("one", "claude-acp", 0);
        map_usage(
            &mut status,
            &json!({"limits":[{"kind":"session","percent":17},{"kind":"weekly_all","percent":19,"resets_at":"2026-10-03T00:00:00Z"}]}),
        );
        assert_eq!(status.limits.len(), 2);
        assert_eq!(status.limits[0].window_minutes, Some(300));
        assert_eq!(status.limits[1].window_minutes, Some(10_080));
        assert_eq!(status.limits[1].used_percent, Some(19.0));
        assert_eq!(status.limits[1].model_id, None);
        assert!(status.limits[1].resets_at.is_some());
    }

    #[test]
    fn native_model_windows_are_preserved_without_raw_rows() {
        let mut status = ProviderAccountStatus::empty("one", "claude-acp", 0);
        map_usage(
            &mut status,
            &json!({"five_hour":{"utilization":50},"model_scoped":[{"display_name":"Fable","utilization":100,"resets_at":"2026-10-01T00:00:00Z"}]}),
        );
        assert_eq!(status.limits.len(), 2);
        assert_eq!(status.limits[1].used_percent, Some(100.0));
        assert_eq!(status.limits[1].model_id.as_deref(), Some("fable"));
        assert!(status.limits[1].resets_at.is_some());
    }
}
