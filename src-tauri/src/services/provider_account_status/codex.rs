//! Codex account telemetry through its supported native app-server protocol.
//! This process never starts threads or model turns and never signs out.

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

const RPC_TIMEOUT: Duration = Duration::from_secs(25);

struct Client {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
}

impl Client {
    async fn send(&mut self, value: Value) -> Result<(), String> {
        let line = format!("{value}\n");
        self.input
            .write_all(line.as_bytes())
            .await
            .map_err(|_| "Codex account service disconnected".to_string())?;
        self.input
            .flush()
            .await
            .map_err(|_| "Codex account service disconnected".to_string())
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        loop {
            let Some(line) = super::read_response_line(&mut self.output).await? else {
                return Err("Codex account service exited before replying".into());
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("method").is_some() && message.get("id").is_some() {
                // No tool or approval action is authorized by a quota probe.
                self.send(json!({"id":message["id"],"error":{"code":-32601,"message":"Account telemetry does not handle agent requests"}})).await?;
                continue;
            }
            if message["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                let code = error["code"].as_i64().unwrap_or(-32603);
                let detail = error["message"].as_str().unwrap_or("").to_ascii_lowercase();
                let hint = if code == -32601 {
                    "Update the Codex provider to use this account feature"
                } else if [
                    "401",
                    "unauthorized",
                    "token expired",
                    "token_expired",
                    "not authenticated",
                ]
                .iter()
                .any(|value| detail.contains(value))
                {
                    "Codex account authorization needs refresh"
                } else {
                    "Could not fetch the account operation; try refreshing its status"
                };
                // Provider errors may echo credentials. Return a code and our own text.
                return Err(format!("{hint} (Codex error {code})"));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| "Codex account reply had no result".into());
        }
    }
}

async fn with_client(
    app: &AppHandle,
    account: &ProviderAccount,
    consume: Option<Value>,
) -> Result<(Value, Value), String> {
    let base = managed_acp_tools::provider_env(app).await;
    let env: HashMap<String, String> =
        provider_accounts::scoped_env(app, account, base.into_iter().collect())?
            .into_iter()
            .collect();
    let binary = managed_acp_tools::native_cli_path(app, "codex-acp")
        .ok_or_else(|| "Install the Codex provider to read account status".to_string())?;
    let mut command = Command::new(binary);
    let home = provider_accounts::account_home(app, account)?;
    if home.is_dir() {
        command.current_dir(home);
    }
    command
        .arg("app-server")
        .env_clear()
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    process::apply_no_window_async(&mut command);
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the Codex account service".to_string())?;
    let tree = process::ProcessTree::contain(&child);
    let mut client = Client {
        input: child.stdin.take().ok_or("Codex input unavailable")?,
        output: BufReader::new(child.stdout.take().ok_or("Codex output unavailable")?),
        next_id: 0,
    };
    let operation = async {
        client.request("initialize", json!({"clientInfo":{"name":"distill_accounts","title":"Distill","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        client
            .send(json!({"method":"initialized","params":{}}))
            .await?;
        let mut identity = client
            .request("account/read", json!({"refreshToken":false}))
            .await?;
        if consume.is_none()
            && (identity["account"].is_null() || identity["account"]["type"] == "apiKey")
        {
            return Ok((identity, Value::Null));
        }
        let (method, params) = consume
            .map(|params| ("account/rateLimitResetCredit/consume", params))
            .unwrap_or(("account/rateLimits/read", json!({})));
        match client.request(method, params.clone()).await {
            Ok(limits) => Ok((identity, limits)),
            Err(first_error) => {
                if !first_error.contains("authorization needs refresh") {
                    return Err(first_error);
                }
                // Native Codex owns refresh-token rotation. Only request it after a
                // failed read, never mint or restore stale token files ourselves.
                identity = client
                    .request("account/read", json!({"refreshToken":true}))
                    .await
                    .map_err(|_| first_error)?;
                // A manual redemption retry keeps the exact idempotency UUID.
                let limits = client.request(method, params).await?;
                Ok((identity, limits))
            }
        }
    };
    let result = tokio::time::timeout(RPC_TIMEOUT, operation)
        .await
        .unwrap_or_else(|_| Err("Codex account service timed out".into()));
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
    let (identity, usage) = with_client(app, account, None).await?;
    Ok(map_usage(&account.id, &identity, &usage, now_ms()))
}

pub(super) async fn consume(
    app: &AppHandle,
    account: &ProviderAccount,
    idempotency_key: &str,
    credit_id: Option<&str>,
) -> Result<ResetResult, String> {
    let mut params = json!({"idempotencyKey":idempotency_key});
    if let Some(credit_id) = credit_id {
        params["creditId"] = json!(credit_id);
    }
    let (_, result) = with_client(app, account, Some(params)).await?;
    serde_json::from_value(result).map_err(|_| {
        "Codex returned an unknown reset outcome; refresh status before retrying".into()
    })
}

pub(super) fn map_usage(
    account_id: &str,
    identity: &Value,
    usage: &Value,
    now: i64,
) -> ProviderAccountStatus {
    let mut status = ProviderAccountStatus::empty(account_id, "codex-acp", now);
    let Some(account) = identity.get("account").filter(|value| !value.is_null()) else {
        status.state = AccountState::NeedsAuth;
        return status;
    };
    status.account_label = account["email"].as_str().map(str::to_owned);
    status.subscription = account["planType"].as_str().map(str::to_owned);
    if account["type"] == "apiKey" {
        status.subscription = Some("API".into());
        status.state = AccountState::Ready;
        return status;
    }
    if let Some(buckets) = usage["rateLimitsByLimitId"]
        .as_object()
        .filter(|buckets| !buckets.is_empty())
    {
        for (id, bucket) in buckets {
            append_bucket(&mut status, id, bucket);
        }
    } else if let Some(bucket) = usage.get("rateLimits").filter(|bucket| !bucket.is_null()) {
        append_bucket(&mut status, "codex", bucket);
    }
    status.reset_tokens = usage.get("rateLimitResetCredits").and_then(|value| {
        let available = value["availableCount"].as_u64()?;
        let credits: Option<Vec<ResetCredit>> = value["credits"].as_array().map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(ResetCredit {
                        id: row["id"].as_str()?.to_owned(),
                        reset_type: row["resetType"].as_str()?.to_owned(),
                        status: row["status"].as_str()?.to_owned(),
                        granted_at: timestamp(&row["grantedAt"]),
                        expires_at: timestamp(&row["expiresAt"]),
                        title: row["title"].as_str().map(str::to_owned),
                        description: row["description"].as_str().map(str::to_owned),
                    })
                })
                .collect()
        });
        let expires_at = credits.as_ref().and_then(|rows| {
            rows.iter()
                .filter(|row| row.status == "available")
                .filter_map(|row| row.expires_at)
                .min()
        });
        Some(ResetTokens {
            available,
            expires_at,
            supported: true,
            credits,
        })
    });
    status.state = if status.limits.iter().any(|window| {
        window.model_id.is_none() && window.used_percent.is_some_and(|used| used >= 100.0)
    }) {
        AccountState::Limited
    } else if status.limits.is_empty() {
        AccountState::Unknown
    } else {
        AccountState::Ready
    };
    status
}

fn append_bucket(status: &mut ProviderAccountStatus, id: &str, bucket: &Value) {
    let label = bucket["limitName"].as_str().unwrap_or(id);
    for (key, fallback) in [("primary", "Session"), ("secondary", "Weekly")] {
        let Some(window) = bucket.get(key).filter(|value| !value.is_null()) else {
            continue;
        };
        let used = window["usedPercent"]
            .as_f64()
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 100.0));
        let duration = window["windowDurationMins"]
            .as_u64()
            .map(|minutes| format!("{minutes} min"))
            .unwrap_or_else(|| fallback.into());
        status.limits.push(AccountLimitWindow {
            id: format!("{id}:{key}"),
            label: format!("{label} · {duration}"),
            used_percent: used,
            remaining: used.map(|value| 100.0 - value),
            resets_at: timestamp(&window["resetsAt"]),
            window_minutes: window["windowDurationMins"]
                .as_u64()
                .and_then(|minutes| u32::try_from(minutes).ok()),
            // Only the general Codex bucket applies to every model. Other bucket
            // names are preserved, never guessed to mean all models.
            model_id: bucket["normalModelSlug"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| (id != "codex").then(|| id.to_owned())),
        });
    }
    if let Some(limit) = bucket
        .get("individualLimit")
        .filter(|value| !value.is_null())
    {
        let remaining = limit["remainingPercent"]
            .as_f64()
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 100.0));
        status.limits.push(AccountLimitWindow {
            id: format!("{id}:individual"),
            label: format!("{label} · spending allowance"),
            used_percent: remaining.map(|value| 100.0 - value),
            remaining,
            resets_at: timestamp(&limit["resetsAt"]),
            window_minutes: None,
            model_id: None,
        });
    }
    let reached_type = bucket["rateLimitReachedType"].as_str();
    let spending_blocked = bucket["spendControlReached"] == true
        || reached_type.is_some_and(|kind| kind != "rate_limit_reached");
    if spending_blocked
        && !status.limits.iter().any(|window| {
            window.id == format!("{id}:individual")
                && window.used_percent.is_some_and(|used| used >= 100.0)
        })
    {
        // A session reset cannot clear a separate exhausted spending budget.
        status.limits.push(AccountLimitWindow {
            id: format!("{id}:spend-blocked"),
            label: format!("{label} · spending allowance exhausted"),
            used_percent: Some(100.0),
            remaining: Some(0.0),
            resets_at: None,
            window_minutes: None,
            model_id: None,
        });
    }
    if reached_type == Some("rate_limit_reached")
        && !status.limits.iter().any(|window| {
            window.id.starts_with(&format!("{id}:"))
                && window.used_percent.is_some_and(|used| used >= 100.0)
        })
    {
        status.limits.push(AccountLimitWindow {
            id: format!("{id}:blocked"),
            label: format!("{label} · allowance exhausted"),
            used_percent: Some(100.0),
            remaining: Some(0.0),
            resets_at: None,
            window_minutes: None,
            model_id: bucket["normalModelSlug"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| (id != "codex").then(|| id.to_owned())),
        });
    }
    if status.subscription.is_none() {
        status.subscription = bucket["planType"].as_str().map(str::to_owned);
    }
    if let Some(credits) = bucket.get("credits").filter(|value| !value.is_null()) {
        status.credits = Some(AccountCredits {
            balance: credits["balance"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| credits["balance"].as_f64().map(|n| n.to_string())),
            unlimited: credits["unlimited"].as_bool().unwrap_or(false),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spending_exhaustion_survives_an_already_full_session_window() {
        let status = map_usage(
            "one",
            &json!({"account":{"type":"chatgpt"}}),
            &json!({"rateLimits":{"primary":{"usedPercent":100,"resetsAt":1900000000},"spendControlReached":true}}),
            0,
        );
        assert_eq!(status.limits.len(), 2);
        assert_eq!(status.limits[1].resets_at, None);
        assert_eq!(status.limits[1].model_id, None);
    }

    #[test]
    fn normal_model_slug_defines_bucket_scope() {
        let status = map_usage(
            "one",
            &json!({"account":{"type":"chatgpt"}}),
            &json!({"rateLimitsByLimitId":{"opaque":{"normalModelSlug":"gpt-6-astra","primary":{"usedPercent":100}}}}),
            0,
        );
        assert_eq!(status.limits[0].model_id.as_deref(), Some("gpt-6-astra"));
    }
}
