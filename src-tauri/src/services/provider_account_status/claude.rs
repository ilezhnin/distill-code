//! The pinned Claude CLI owns OAuth refresh, credential precedence and usage.
//! Control requests do not send a prompt, start a model turn or redeem a reset.
use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};

use super::{now_ms, timestamp, types::*};
use crate::services::{managed_acp_tools, process, provider_accounts};
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

async fn read_usage(app: &AppHandle, account: &ProviderAccount) -> Result<(Value, Value), String> {
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
        let usage = client
            .request(json!({"subtype":"get_usage","skip_behaviors":true}))
            .await?;
        Ok((init["account"].clone(), usage))
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
    let (identity, usage) = read_usage(app, account).await?;
    let mut status = ProviderAccountStatus::empty(&account.id, &account.provider_id, now_ms());
    status.account_label = identity["email"].as_str().map(str::to_owned);
    status.subscription = usage["subscription_type"]
        .as_str()
        .or_else(|| identity["subscriptionType"].as_str())
        .map(str::to_owned);
    if is_api_billed(&identity, &usage) {
        status.subscription = Some("API".into());
        status.state = AccountState::Ready;
    } else if usage["rate_limits"].is_object() {
        map_usage(&mut status, &usage["rate_limits"]);
    } else if status.subscription.is_some() || usage["rate_limits_available"] == true {
        return Err("Claude subscription usage is temporarily unavailable".into());
    } else {
        status.state = if crate::commands::provider_accounts::probe_account_auth(app, account)
            .await
            .unwrap_or(false)
        {
            AccountState::Unknown
        } else {
            AccountState::NeedsAuth
        };
    }
    Ok(status)
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

pub(super) fn map_usage(status: &mut ProviderAccountStatus, usage: &Value) {
    // Newer CLIs expose authoritative server rows. Prefer them to the legacy
    // compatibility windows so each allowance appears only once.
    if usage["limits"].as_array().is_none() {
        if let Some(windows) = usage.as_object() {
            for (id, window) in windows {
                let Some(used) = window
                    .get("utilization")
                    .or_else(|| window.get("used_percentage"))
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                else {
                    continue;
                };
                // Extra usage is a spend allowance, not a blocking subscription window.
                if id == "extra_usage" {
                    continue;
                }
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
    if let Some(plan) = usage.get("plan_type").and_then(Value::as_str) {
        status.subscription = Some(plan.into());
    }
    // Claude's OAuth usage response does not have a documented reset-credit
    // contract. Leave it unknown instead of presenting a fabricated zero.
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
    use super::*;

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
