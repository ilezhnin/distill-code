use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use super::types::{AgentPlatformId, ProviderRateLimitStatus, ProviderRateLimits};
use super::windows::{
    parse_reset_timestamp, usage_window, MONTHLY_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES,
};
use super::{home_dir, now_ms, result};

const GROK_CLI_PROXY_BASE: &str = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLI_AUTH_HEADER: &str = "xai-grok-cli";
const PREFERRED_GROK_AUTH_ISSUER: &str = "https://auth.x.ai";
const TOKEN_SKEW_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrokAuthSession {
    pub access_token: String,
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrokAuthReadResult {
    Missing,
    Error(String),
    Ok(GrokAuthSession),
}

pub fn grok_home() -> PathBuf {
    if let Some(override_dir) = crate::services::shell_env::user_env_var("GROK_HOME") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".grok")
}

pub fn grok_auth_path() -> PathBuf {
    grok_home().join("auth.json")
}

pub fn is_grok_access_token_fresh(session: &GrokAuthSession) -> bool {
    match session.expires_at_ms {
        None => true,
        Some(expires_at_ms) => expires_at_ms - now_ms() > TOKEN_SKEW_MS,
    }
}

pub fn read_grok_auth_session() -> GrokAuthReadResult {
    let path = grok_auth_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return GrokAuthReadResult::Missing;
    };
    parse_grok_auth_session(&raw)
}

pub fn parse_grok_auth_session(raw: &str) -> GrokAuthReadResult {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return GrokAuthReadResult::Error("Grok auth file is invalid".into()),
    };
    let Some(object) = parsed.as_object() else {
        return GrokAuthReadResult::Error("Grok auth file is invalid".into());
    };

    let mut preferred_key_seen = false;
    let mut expired_preferred: Option<GrokAuthSession> = None;
    let mut fallback: Option<GrokAuthSession> = None;

    for (key, entry) in object {
        let is_preferred = key == PREFERRED_GROK_AUTH_ISSUER
            || key.starts_with(&format!("{PREFERRED_GROK_AUTH_ISSUER}::"));
        preferred_key_seen |= is_preferred;
        let Some(session) = session_from_auth_entry(entry) else {
            continue;
        };
        if is_preferred {
            if is_grok_access_token_fresh(&session) {
                return GrokAuthReadResult::Ok(session);
            }
            if expired_preferred.is_none() {
                expired_preferred = Some(session);
            }
            continue;
        }
        if fallback.is_none() {
            fallback = Some(session);
        }
    }

    if let Some(session) = expired_preferred.or(if preferred_key_seen { None } else { fallback }) {
        return GrokAuthReadResult::Ok(session);
    }
    GrokAuthReadResult::Missing
}

fn session_from_auth_entry(value: &Value) -> Option<GrokAuthSession> {
    let access_token = value.get("key").and_then(Value::as_str)?.trim();
    if access_token.is_empty() {
        return None;
    }
    let expires_at_ms = value.get("expires_at").and_then(parse_reset_timestamp);
    Some(GrokAuthSession {
        access_token: access_token.to_string(),
        user_id: value
            .get("user_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        email: value
            .get("email")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        expires_at_ms,
    })
}

fn money_val(value: Option<&Value>) -> Option<f64> {
    let raw = value?.get("val")?;
    match raw {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

fn timestamps_match(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            parse_reset_timestamp(&Value::String(left.to_string()))
                == parse_reset_timestamp(&Value::String(right.to_string()))
        }
        _ => false,
    }
}

fn billing_config(data: &Value) -> Option<&Value> {
    data.get("config").or_else(|| {
        if data.get("creditUsagePercent").is_some() || data.get("monthlyLimit").is_some() {
            Some(data)
        } else {
            None
        }
    })
}

fn map_weekly_credits(config: &Value) -> Option<super::types::RateLimitWindow> {
    let period = config.get("currentPeriod");
    let period_type = period
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str);
    let confirmed_weekly = period_type == Some("USAGE_PERIOD_TYPE_WEEKLY")
        && timestamps_match(
            period
                .and_then(|value| value.get("start"))
                .and_then(Value::as_str),
            config.get("billingPeriodStart").and_then(Value::as_str),
        )
        && timestamps_match(
            period
                .and_then(|value| value.get("end"))
                .and_then(Value::as_str),
            config.get("billingPeriodEnd").and_then(Value::as_str),
        );
    let used_percent = match config.get("creditUsagePercent").and_then(Value::as_f64) {
        Some(value) => Some(value),
        None if confirmed_weekly => Some(0.0),
        None => None,
    };
    let period_end = period
        .and_then(|value| value.get("end"))
        .or_else(|| config.get("billingPeriodEnd"));
    usage_window(
        used_percent,
        WEEKLY_WINDOW_MINUTES,
        period_end.and_then(parse_reset_timestamp),
    )
}

fn map_monthly_usage(config: &Value) -> Option<super::types::RateLimitWindow> {
    let limit = money_val(config.get("monthlyLimit"))?;
    let used = money_val(config.get("used"))?;
    if limit <= 0.0 {
        return None;
    }
    let period_end = config
        .get("currentPeriod")
        .and_then(|value| value.get("end"))
        .or_else(|| config.get("billingPeriodEnd"));
    usage_window(
        Some((used / limit) * 100.0),
        MONTHLY_WINDOW_MINUTES,
        period_end.and_then(parse_reset_timestamp),
    )
}

fn apply_session_headers(
    request: reqwest::RequestBuilder,
    session: &GrokAuthSession,
) -> reqwest::RequestBuilder {
    let mut request = request
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("X-XAI-Token-Auth", GROK_CLI_AUTH_HEADER)
        .header("Accept", "application/json");
    if let Some(user_id) = &session.user_id {
        request = request.header("x-userid", user_id);
    }
    request
}

fn billing_base() -> String {
    std::env::var("GROK_CLI_CHAT_PROXY_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| GROK_CLI_PROXY_BASE.to_string())
}

async fn fetch_billing_json(
    client: &reqwest::Client,
    url: &str,
    session: &GrokAuthSession,
) -> Result<Value, ProviderRateLimits> {
    let response = apply_session_headers(client.get(url), session)
        .send()
        .await
        .map_err(|error| {
            grok_error(session, format!("Grok usage request failed: {error}"), true)
        })?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(grok_error(
            session,
            format!("Grok usage request unauthorized (HTTP {status})"),
            true,
        ));
    }
    if !status.is_success() {
        return Err(grok_error(
            session,
            format!("Grok usage request failed (HTTP {status})"),
            true,
        ));
    }
    response.json().await.map_err(|error| {
        grok_error(
            session,
            format!("Grok usage response was invalid: {error}"),
            true,
        )
    })
}

fn grok_error(session: &GrokAuthSession, error: String, configured: bool) -> ProviderRateLimits {
    ProviderRateLimits {
        configured,
        account_label: session.email.clone(),
        ..result(
            AgentPlatformId::Grok,
            ProviderRateLimitStatus::Error,
            Some(error),
        )
    }
}

fn billing_usage_result(
    session: &GrokAuthSession,
    weekly: Option<super::types::RateLimitWindow>,
    monthly: Option<super::types::RateLimitWindow>,
    config: &Value,
) -> ProviderRateLimits {
    let tier = config
        .get("subscriptionTier")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let account = session
        .email
        .clone()
        .or_else(|| session.user_id.clone())
        .unwrap_or_else(|| "Grok account".to_string());
    ProviderRateLimits {
        provider: AgentPlatformId::Grok,
        session: None,
        weekly,
        fable_weekly: None,
        monthly,
        plan_type: tier.map(ToOwned::to_owned),
        account_label: Some(account),
        updated_at: now_ms(),
        error: None,
        status: ProviderRateLimitStatus::Ok,
        configured: true,
    }
}

pub async fn fetch_grok_rate_limits(client: &reqwest::Client) -> ProviderRateLimits {
    match read_grok_auth_session() {
        GrokAuthReadResult::Missing => result(
            AgentPlatformId::Grok,
            ProviderRateLimitStatus::Unavailable,
            Some("Not signed in to Grok — run grok login".to_string()),
        ),
        GrokAuthReadResult::Error(error) => result(
            AgentPlatformId::Grok,
            ProviderRateLimitStatus::Error,
            Some(error),
        ),
        GrokAuthReadResult::Ok(session) => {
            if !is_grok_access_token_fresh(&session) {
                return ProviderRateLimits {
                    configured: true,
                    account_label: session.email.clone(),
                    ..result(
                        AgentPlatformId::Grok,
                        ProviderRateLimitStatus::Error,
                        Some(
                            "Grok sign-in expired — run grok on this computer and sign in if prompted."
                                .to_string(),
                        ),
                    )
                };
            }
            let base = billing_base();
            let credits_url = format!("{base}/billing?format=credits");
            let default_url = format!("{base}/billing");
            let credits = match fetch_billing_json(client, &credits_url, &session).await {
                Ok(value) => value,
                Err(error) => return error,
            };
            let Some(config) = billing_config(&credits).cloned() else {
                return ProviderRateLimits {
                    configured: true,
                    account_label: session.email.clone(),
                    ..result(
                        AgentPlatformId::Grok,
                        ProviderRateLimitStatus::Unavailable,
                        Some("Grok billing response did not include config".to_string()),
                    )
                };
            };
            if let Some(weekly) = map_weekly_credits(&config) {
                return billing_usage_result(&session, Some(weekly), None, &config);
            }
            let fallback = match fetch_billing_json(client, &default_url, &session).await {
                Ok(value) => value,
                Err(error) => return error,
            };
            let monthly_config = billing_config(&fallback).unwrap_or(&fallback);
            if let Some(monthly) = map_monthly_usage(monthly_config) {
                return billing_usage_result(&session, None, Some(monthly), &config);
            }
            ProviderRateLimits {
                configured: true,
                account_label: session.email.clone(),
                ..result(
                    AgentPlatformId::Grok,
                    ProviderRateLimitStatus::Unavailable,
                    Some("Grok billing response did not include credit usage".to_string()),
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_xai_issuer() {
        let parsed = parse_grok_auth_session(
            r#"{
              "https://other.example": { "key": "other" },
              "https://auth.x.ai": {
                "key": "preferred",
                "email": "dev@example.com",
                "user_id": "u1"
              }
            }"#,
        );
        match parsed {
            GrokAuthReadResult::Ok(session) => {
                assert_eq!(session.access_token, "preferred");
                assert_eq!(session.email.as_deref(), Some("dev@example.com"));
            }
            other => panic!("expected ok, got {other:?}"),
        }
    }

    #[test]
    fn maps_weekly_credits() {
        let window = map_weekly_credits(&serde_json::json!({
            "creditUsagePercent": 8,
            "currentPeriod": {
                "type": "USAGE_PERIOD_TYPE_WEEKLY",
                "end": "2026-08-27T00:00:00Z"
            }
        }))
        .expect("weekly window");
        assert_eq!(window.used_percent, 8.0);
        assert_eq!(window.window_minutes, WEEKLY_WINDOW_MINUTES);
    }
}
