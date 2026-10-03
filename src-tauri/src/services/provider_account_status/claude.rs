//! The pinned Claude CLI owns OAuth refresh, credential precedence and usage.
//! Control requests do not send a prompt, start a model turn or redeem a reset.
use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

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
        .env_clear()
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Keep the probe outside project settings while preserving the selected
    // account's user auth configuration (including API-key precedence).
    if home.is_dir() {
        command.current_dir(&home);
    }
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

pub(super) async fn fetch(
    app: &AppHandle,
    account: &ProviderAccount,
) -> Result<ProviderAccountStatus, String> {
    let (identity, _, version) = read_usage(app, account, false).await?;
    let mut status = ProviderAccountStatus::empty(&account.id, &account.provider_id, now_ms());
    status.account_label = identity["email"].as_str().map(str::to_owned);
    status.subscription = account_plan(app, account, &identity);
    if is_api_billed(&identity, &Value::Null) {
        status.subscription = Some("API".into());
        status.state = AccountState::Ready;
        return Ok(status);
    }
    if status.subscription.is_none() {
        status.state = if crate::commands::provider_accounts::probe_account_auth(app, account)
            .await
            .unwrap_or(false)
        {
            AccountState::Unknown
        } else {
            AccountState::NeedsAuth
        };
        return Ok(status);
    }
    // One usage request returns both quota and reset grants. Calling get_usage
    // first doubles traffic to the same endpoint and can exhaust its read limit.
    let mut usage = claude_resets::fetch_usage(app, account, version.as_deref()).await;
    if matches!(usage, Err(claude_resets::RequestError::Unauthorized)) {
        // OAuth refresh remains owned by the native CLI. Retry a rejected read
        // once after that refresh; a 429 never triggers another request here.
        let (_, _, version) = read_usage(app, account, true).await?;
        usage = claude_resets::fetch_usage(app, account, version.as_deref()).await;
    }
    let usage = match usage {
        Ok(usage) => usage,
        Err(claude_resets::RequestError::Unauthorized) => {
            status.state = AccountState::NeedsAuth;
            return Ok(status);
        }
        Err(error) => return Ok(usage_failure(status, error)),
    };
    if !usage["limits"].is_array()
        && !usage["five_hour"].is_object()
        && !usage["seven_day"].is_object()
    {
        return Err("Claude subscription usage is temporarily unavailable".into());
    }
    map_usage(&mut status, &usage);
    status.reset_tokens = claude_resets::map_inventory(&usage, now_ms())?;
    Ok(status)
}

fn usage_failure(
    mut status: ProviderAccountStatus,
    error: claude_resets::RequestError,
) -> ProviderAccountStatus {
    if let claude_resets::RequestError::RateLimited(seconds) = &error {
        status.usage_retry_at =
            Some(now_ms().saturating_add(((*seconds).min(i64::MAX as u64 / 1000) * 1000) as i64));
    }
    status.state = AccountState::Error;
    status.stale = true;
    status.error = Some(error.to_string());
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
