use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use super::types::{AgentPlatformId, ProviderRateLimitStatus, ProviderRateLimits, RateLimitWindow};
use super::windows::{
    classify_codex_window_minutes, parse_reset_timestamp, usage_window, SESSION_WINDOW_MINUTES,
    WEEKLY_WINDOW_MINUTES,
};
use super::{home_dir, now_ms, result};

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexBackendAuth {
    pub access_token: String,
    pub account_id: Option<String>,
}

pub fn codex_home() -> PathBuf {
    if let Ok(override_dir) = std::env::var("CODEX_HOME") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}

pub fn read_codex_backend_auth() -> Option<CodexBackendAuth> {
    let raw = fs::read_to_string(codex_home().join("auth.json")).ok()?;
    parse_codex_backend_auth(&raw)
}

pub fn parse_codex_backend_auth(raw: &str) -> Option<CodexBackendAuth> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let tokens = value.get("tokens")?;
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())?;
    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned);
    Some(CodexBackendAuth {
        access_token: access_token.to_string(),
        account_id,
    })
}

fn window_from_backend(raw: Option<&Value>, fallback_minutes: u32) -> Option<RateLimitWindow> {
    let raw = raw?;
    let used_percent = raw
        .get("used_percent")
        .or_else(|| raw.get("usedPercent"))
        .and_then(Value::as_f64);
    let duration_seconds = raw
        .get("limit_window_seconds")
        .or_else(|| raw.get("windowDurationMins"))
        .and_then(Value::as_f64);
    let duration_minutes = if raw.get("windowDurationMins").is_some() {
        duration_seconds
    } else {
        duration_seconds.map(|seconds| seconds / 60.0)
    };
    let minutes = classify_codex_window_minutes(duration_minutes)
        .map(|kind| {
            if kind == "session" {
                SESSION_WINDOW_MINUTES
            } else {
                WEEKLY_WINDOW_MINUTES
            }
        })
        .unwrap_or(fallback_minutes);
    let resets_at = raw
        .get("reset_at")
        .or_else(|| raw.get("resetsAt"))
        .and_then(parse_reset_timestamp);
    usage_window(used_percent, minutes, resets_at)
}

pub fn map_codex_backend_usage(data: &Value) -> ProviderRateLimits {
    let rate_limit = data.get("rate_limit").or_else(|| data.get("rateLimits"));
    let primary =
        rate_limit.and_then(|value| value.get("primary_window").or_else(|| value.get("primary")));
    let secondary = rate_limit.and_then(|value| {
        value
            .get("secondary_window")
            .or_else(|| value.get("secondary"))
    });

    let primary_kind = primary.and_then(|window| {
        let duration = window
            .get("limit_window_seconds")
            .and_then(Value::as_f64)
            .map(|seconds| seconds / 60.0)
            .or_else(|| window.get("windowDurationMins").and_then(Value::as_f64));
        classify_codex_window_minutes(duration)
    });
    let secondary_kind = secondary.and_then(|window| {
        let duration = window
            .get("limit_window_seconds")
            .and_then(Value::as_f64)
            .map(|seconds| seconds / 60.0)
            .or_else(|| window.get("windowDurationMins").and_then(Value::as_f64));
        classify_codex_window_minutes(duration)
    });

    let (session, weekly) = if primary_kind == Some("weekly") {
        (
            window_from_backend(secondary, SESSION_WINDOW_MINUTES),
            window_from_backend(primary, WEEKLY_WINDOW_MINUTES),
        )
    } else if secondary_kind == Some("session") {
        (
            window_from_backend(secondary, SESSION_WINDOW_MINUTES),
            window_from_backend(primary, WEEKLY_WINDOW_MINUTES),
        )
    } else {
        (
            window_from_backend(primary, SESSION_WINDOW_MINUTES),
            window_from_backend(secondary, WEEKLY_WINDOW_MINUTES),
        )
    };

    let plan_type = data
        .get("plan_type")
        .or_else(|| data.get("planType"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let has_data = session.is_some() || weekly.is_some();
    ProviderRateLimits {
        provider: AgentPlatformId::Codex,
        session,
        weekly,
        fable_weekly: None,
        monthly: None,
        plan_type,
        account_label: None,
        updated_at: now_ms(),
        error: if has_data {
            None
        } else {
            Some("Codex usage did not include rate-limit windows".to_string())
        },
        status: if has_data {
            ProviderRateLimitStatus::Ok
        } else {
            ProviderRateLimitStatus::Unavailable
        },
        configured: true,
    }
}

pub async fn fetch_codex_rate_limits(client: &reqwest::Client) -> ProviderRateLimits {
    let Some(auth) = read_codex_backend_auth() else {
        return result(
            AgentPlatformId::Codex,
            ProviderRateLimitStatus::Unavailable,
            Some("Not signed in to Codex".to_string()),
        );
    };

    let mut request = client
        .get(CODEX_USAGE_URL)
        .header("Authorization", format!("Bearer {}", auth.access_token))
        .header("User-Agent", "codex-cli")
        .header("OpenAI-Beta", "codex-1")
        .header("originator", "Distill");
    if let Some(account_id) = &auth.account_id {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return ProviderRateLimits {
                    configured: true,
                    ..result(
                        AgentPlatformId::Codex,
                        ProviderRateLimitStatus::Error,
                        Some(format!("Codex usage request unauthorized (HTTP {status})")),
                    )
                };
            }
            if !status.is_success() {
                return ProviderRateLimits {
                    configured: true,
                    ..result(
                        AgentPlatformId::Codex,
                        ProviderRateLimitStatus::Error,
                        Some(format!("Codex usage request failed (HTTP {status})")),
                    )
                };
            }
            match response.json::<Value>().await {
                Ok(data) => map_codex_backend_usage(&data),
                Err(error) => ProviderRateLimits {
                    configured: true,
                    ..result(
                        AgentPlatformId::Codex,
                        ProviderRateLimitStatus::Error,
                        Some(format!("Codex usage response was invalid: {error}")),
                    )
                },
            }
        }
        Err(error) => ProviderRateLimits {
            configured: true,
            ..result(
                AgentPlatformId::Codex,
                ProviderRateLimitStatus::Error,
                Some(format!("Codex usage request failed: {error}")),
            )
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_auth_json() {
        let parsed = parse_codex_backend_auth(
            r#"{ "tokens": { "access_token": "tok", "account_id": "acct_1" } }"#,
        )
        .expect("auth");
        assert_eq!(parsed.access_token, "tok");
        assert_eq!(parsed.account_id.as_deref(), Some("acct_1"));
    }

    #[test]
    fn maps_primary_session_and_secondary_weekly() {
        let mapped = map_codex_backend_usage(&serde_json::json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 12,
                    "limit_window_seconds": 18000,
                    "reset_at": 1780000000
                },
                "secondary_window": {
                    "used_percent": 40,
                    "limit_window_seconds": 604800,
                    "reset_at": 1780500000
                }
            }
        }));
        assert_eq!(mapped.status, ProviderRateLimitStatus::Ok);
        assert_eq!(mapped.plan_type.as_deref(), Some("plus"));
        assert_eq!(
            mapped.session.as_ref().map(|window| window.used_percent),
            Some(12.0)
        );
        assert_eq!(
            mapped.weekly.as_ref().map(|window| window.used_percent),
            Some(40.0)
        );
    }
}
