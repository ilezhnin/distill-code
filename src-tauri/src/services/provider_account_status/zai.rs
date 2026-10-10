//! Read-only Coding Plan telemetry, using the account's saved API key.
//! Endpoint: zai-org/zai-coding-plugins, glm-plan-usage/query-usage.mjs.

use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use super::{now_ms, timestamp, types::*};
use crate::services::provider_accounts::{self, ProviderAccount};

const QUOTA_URL: &str = "https://api.z.ai/api/monitor/usage/quota/limit";
const MAX_BYTES: usize = 256 * 1024;

pub(super) async fn fetch(
    app: &AppHandle,
    account: &ProviderAccount,
) -> Result<ProviderAccountStatus, String> {
    if !provider_accounts::account_has_credentials(app, account)? {
        let mut status = ProviderAccountStatus::empty(&account.id, &account.provider_id, now_ms());
        status.state = AccountState::NeedsAuth;
        return Ok(status);
    }
    let key = provider_accounts::scoped_env(app, account, vec![])?
        .into_iter()
        .find_map(|(name, value)| (name == "DISTILL_ZAI_API_KEY").then_some(value))
        .ok_or("Z.ai API key is unavailable")?;
    request_usage(&account.id, &key, QUOTA_URL).await
}

async fn request_usage(
    account_id: &str,
    key: &str,
    url: &str,
) -> Result<ProviderAccountStatus, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not start the Z.ai usage request")?;
    let mut response = client
        .get(url)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| "Could not reach Z.ai usage; try refreshing")?;
    let http_status = response.status().as_u16();
    let retry_seconds = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(60)
        .clamp(1, 3600);
    if http_status != 200 {
        return Ok(failed_status(account_id, http_status as i64, retry_seconds));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read Z.ai usage")?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err("Z.ai usage response exceeded the size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Z.ai returned an invalid usage response")?;
    let code = body["code"]
        .as_i64()
        .or_else(|| body["code"].as_str()?.parse().ok());
    // This service also reports authorization errors inside an HTTP 200 body.
    if body["success"] == false || code.is_some_and(|code| code != 200 && code != 0) {
        return Ok(failed_status(account_id, code.unwrap_or(0), retry_seconds));
    }
    map_usage(account_id, &body, now_ms())
}

fn failed_status(account_id: &str, code: i64, retry_seconds: i64) -> ProviderAccountStatus {
    let now = now_ms();
    let mut status = ProviderAccountStatus::empty(account_id, "zai-acp", now);
    status.state = AccountState::Error;
    status.stale = true;
    // Never return provider error bodies: they may echo credential material.
    status.error = Some(match code {
        401 | 403 => format!(
            "Z.ai rejected usage access ({code}); check the saved API key and Coding Plan access"
        ),
        429 => {
            status.usage_retry_at = Some(now + retry_seconds * 1000);
            "Z.ai usage requests are temporarily paused; existing limits are retained".into()
        }
        _ => format!("Z.ai could not return usage (code {code}); try refreshing"),
    });
    status
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

pub(super) fn map_usage(
    account_id: &str,
    body: &Value,
    now: i64,
) -> Result<ProviderAccountStatus, String> {
    let data = &body["data"];
    let limits = data["limits"]
        .as_array()
        .ok_or("Z.ai returned no quota data; check Coding Plan access")?;
    let mut status = ProviderAccountStatus::empty(account_id, "zai-acp", now);
    let level = match data["level"].as_str() {
        Some("lite") => " Lite",
        Some("pro") => " Pro",
        Some("max") => " Max",
        _ => "",
    };
    status.subscription = Some(format!("GLM Coding Plan{level}"));
    let mut credits = Vec::new();
    for (index, limit) in limits.iter().enumerate() {
        let kind = limit["type"].as_str().unwrap_or("");
        if !matches!(kind, "CREDIT_LIMIT" | "TOKENS_LIMIT" | "TIME_LIMIT") {
            continue;
        }
        let total = number(&limit["usage"]);
        let current = number(&limit["currentValue"]);
        let remaining = number(&limit["remaining"]).or_else(|| Some((total? - current?).max(0.0)));
        let percent = total
            .filter(|total| *total > 0.0)
            .and_then(|total| {
                let spent = match (current, remaining) {
                    (Some(current), Some(remaining)) => current.max(total - remaining),
                    (Some(current), None) => current,
                    (None, Some(remaining)) => total - remaining,
                    _ => return None,
                };
                Some((spent / total * 100.0).clamp(0.0, 100.0))
            })
            .or_else(|| number(&limit["percentage"]).map(|value| value.min(100.0)));
        let minutes = match limit["unit"].as_u64() {
            Some(1) => Some(1440_u64),
            Some(3) => Some(60),
            Some(5) => Some(1),
            Some(6) => Some(10080),
            _ => None,
        }
        .and_then(|unit| limit["number"].as_u64()?.checked_mul(unit))
        .and_then(|minutes| u32::try_from(minutes).ok())
        .filter(|minutes| *minutes > 0);
        let reset = timestamp(&limit["nextResetTime"])
            .filter(|reset| minutes != Some(300) || *reset <= now + 301 * 60_000);
        let label = match minutes {
            Some(300) => "5-hour".to_string(),
            Some(10080) => "Weekly".to_string(),
            Some(minutes) => format!("{minutes}-minute"),
            None => "Coding Plan".to_string(),
        };
        let id = format!("zai:{kind}:{index}");
        if (kind == "CREDIT_LIMIT" || kind == "TIME_LIMIT")
            && (total.is_some() || remaining.is_some())
        {
            credits.push(CreditBalance {
                id: id.clone(),
                label: if kind == "TIME_LIMIT" {
                    "MCP tool calls".into()
                } else {
                    format!("{label} credits")
                },
                balance: remaining.map(|value| value.to_string()),
                total: total.map(|value| value.to_string()),
                currency: None,
                expires_at: None,
                unlimited: false,
            });
        }
        // An exhausted tool-call pool must not block ordinary model prompts.
        if kind == "TIME_LIMIT" {
            continue;
        }
        let used_percent = percent.ok_or("Z.ai returned a quota window without usage values")?;
        status.limits.push(AccountLimitWindow {
            id,
            label,
            used_percent: Some(used_percent),
            remaining,
            resets_at: reset,
            window_minutes: minutes,
            model_id: None,
        });
    }
    if status.limits.is_empty() {
        return Err("Z.ai returned no Coding Plan quota windows; check plan access".into());
    }
    status.credits = (!credits.is_empty()).then_some(credits);
    status.state = if status
        .limits
        .iter()
        .any(|limit| limit.used_percent.is_some_and(|used| used >= 100.0))
    {
        AccountState::Limited
    } else {
        AccountState::Ready
    };
    Ok(status)
}

#[cfg(test)]
mod tests;
