use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::types::{AgentPlatformId, ProviderRateLimitStatus, ProviderRateLimits, RateLimitWindow};
use super::windows::{
    parse_reset_timestamp, usage_window, SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES,
};
use super::{home_dir, now_ms, result};

const OAUTH_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT: &str = "claude-code/2.1.0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeOauthCredentials {
    pub access_token: String,
    pub account_label: Option<String>,
}

pub fn claude_config_dir() -> Option<PathBuf> {
    if let Ok(override_dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    Some(home_dir()?.join(".claude"))
}

fn credential_paths(config_dir: &Path) -> Vec<PathBuf> {
    vec![
        config_dir.join(".credentials.json"),
        config_dir.join("credentials.json"),
        config_dir.join(".claude.json"),
        home_dir()
            .map(|home| home.join(".claude.json"))
            .unwrap_or_else(|| config_dir.join("missing-home.claude.json")),
    ]
}

pub fn read_claude_oauth_credentials() -> Option<ClaudeOauthCredentials> {
    let config_dir = claude_config_dir()?;
    for path in credential_paths(&config_dir) {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        if let Some(credentials) = parse_claude_oauth_credentials(&raw) {
            return Some(credentials);
        }
    }
    None
}

pub fn parse_claude_oauth_credentials(raw: &str) -> Option<ClaudeOauthCredentials> {
    let value: Value = serde_json::from_str(raw).ok()?;
    parse_claude_oauth_value(&value)
}

fn parse_claude_oauth_value(value: &Value) -> Option<ClaudeOauthCredentials> {
    let oauth = value
        .get("claudeAiOauth")
        .or_else(|| value.get("claude_ai_oauth"))
        .or_else(|| {
            value
                .get("oauth")
                .and_then(|oauth| oauth.get("claudeAiOauth"))
        })?;
    let access_token = oauth
        .get("accessToken")
        .or_else(|| oauth.get("access_token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())?;
    let account_label = value
        .pointer("/oauthAccount/emailAddress")
        .or_else(|| value.pointer("/oauthAccount/email"))
        .or_else(|| oauth.get("email").or_else(|| oauth.get("emailAddress")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|email| !email.is_empty())
        .map(ToOwned::to_owned);
    Some(ClaudeOauthCredentials {
        access_token: access_token.to_string(),
        account_label,
    })
}

fn used_percent_from_window(window: &Value) -> Option<f64> {
    window
        .get("utilization")
        .or_else(|| window.get("used_percentage"))
        .or_else(|| window.get("usedPercent"))
        .and_then(Value::as_f64)
}

fn map_named_window(data: &Value, keys: &[&str], window_minutes: u32) -> Option<RateLimitWindow> {
    for key in keys {
        if let Some(window) = data.get(*key) {
            let used_percent = used_percent_from_window(window);
            let resets_at = window
                .get("resets_at")
                .or_else(|| window.get("resetsAt"))
                .and_then(parse_reset_timestamp);
            if let Some(mapped) = usage_window(used_percent, window_minutes, resets_at) {
                return Some(mapped);
            }
        }
    }
    None
}

fn map_fable_weekly(data: &Value) -> Option<RateLimitWindow> {
    if let Some(limits) = data.get("limits").and_then(Value::as_array) {
        for limit in limits {
            let kind = limit.get("kind").and_then(Value::as_str).unwrap_or("");
            let model = limit
                .pointer("/scope/model/display_name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if kind == "weekly_scoped" && model == "fable" {
                let used_percent = limit.get("percent").and_then(Value::as_f64);
                let resets_at = limit
                    .get("resets_at")
                    .or_else(|| limit.get("resetsAt"))
                    .and_then(parse_reset_timestamp);
                if let Some(window) = usage_window(used_percent, WEEKLY_WINDOW_MINUTES, resets_at) {
                    return Some(window);
                }
            }
        }
    }
    map_named_window(
        data,
        &["fable_weekly", "fable_seven_day", "seven_day_fable"],
        WEEKLY_WINDOW_MINUTES,
    )
}

pub fn map_claude_oauth_usage(data: &Value, account_label: Option<String>) -> ProviderRateLimits {
    let session = map_named_window(data, &["five_hour", "fiveHour"], SESSION_WINDOW_MINUTES);
    let weekly = map_named_window(data, &["seven_day", "sevenDay"], WEEKLY_WINDOW_MINUTES);
    let fable_weekly = map_fable_weekly(data);
    let has_data = session.is_some() || weekly.is_some() || fable_weekly.is_some();
    ProviderRateLimits {
        provider: AgentPlatformId::Claude,
        session,
        weekly,
        fable_weekly,
        monthly: None,
        plan_type: None,
        account_label,
        updated_at: now_ms(),
        error: if has_data {
            None
        } else {
            Some("Claude usage did not include rate-limit windows".to_string())
        },
        status: if has_data {
            ProviderRateLimitStatus::Ok
        } else {
            ProviderRateLimitStatus::Unavailable
        },
        configured: true,
    }
}

pub async fn fetch_claude_rate_limits(client: &reqwest::Client) -> ProviderRateLimits {
    let Some(credentials) = read_claude_oauth_credentials() else {
        return result(
            AgentPlatformId::Claude,
            ProviderRateLimitStatus::Unavailable,
            Some("Not signed in to Claude Code".to_string()),
        );
    };

    let request = client
        .get(OAUTH_USAGE_URL)
        .header(
            "Authorization",
            format!("Bearer {}", credentials.access_token),
        )
        .header("anthropic-beta", OAUTH_BETA_HEADER)
        .header("User-Agent", CLAUDE_CODE_USER_AGENT);

    match request.send().await {
        Ok(response) => {
            let status = response.status();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return ProviderRateLimits {
                    configured: true,
                    account_label: credentials.account_label,
                    ..result(
                        AgentPlatformId::Claude,
                        ProviderRateLimitStatus::Error,
                        Some(format!("Claude usage request unauthorized (HTTP {status})")),
                    )
                };
            }
            if !status.is_success() {
                return ProviderRateLimits {
                    configured: true,
                    account_label: credentials.account_label,
                    ..result(
                        AgentPlatformId::Claude,
                        ProviderRateLimitStatus::Error,
                        Some(format!("Claude usage request failed (HTTP {status})")),
                    )
                };
            }
            match response.json::<Value>().await {
                Ok(data) => map_claude_oauth_usage(&data, credentials.account_label),
                Err(error) => ProviderRateLimits {
                    configured: true,
                    account_label: credentials.account_label,
                    ..result(
                        AgentPlatformId::Claude,
                        ProviderRateLimitStatus::Error,
                        Some(format!("Claude usage response was invalid: {error}")),
                    )
                },
            }
        }
        Err(error) => ProviderRateLimits {
            configured: true,
            account_label: credentials.account_label,
            ..result(
                AgentPlatformId::Claude,
                ProviderRateLimitStatus::Error,
                Some(format!("Claude usage request failed: {error}")),
            )
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_oauth_credentials() {
        let parsed = parse_claude_oauth_credentials(
            r#"{
              "claudeAiOauth": { "accessToken": "sk-ant-oat-1" },
              "oauthAccount": { "emailAddress": "dev@example.com" }
            }"#,
        )
        .expect("credentials");
        assert_eq!(parsed.access_token, "sk-ant-oat-1");
        assert_eq!(parsed.account_label.as_deref(), Some("dev@example.com"));
    }

    #[test]
    fn maps_session_weekly_and_fable() {
        let mapped = map_claude_oauth_usage(
            &serde_json::json!({
              "five_hour": { "utilization": 3, "resets_at": "2026-08-21T12:00:00Z" },
              "seven_day": { "used_percentage": 99, "resets_at": 1780000000 },
              "limits": [{
                "kind": "weekly_scoped",
                "percent": 100,
                "resets_at": 1780000000,
                "scope": { "model": { "display_name": "Fable" } }
              }]
            }),
            Some("dev@example.com".into()),
        );
        assert_eq!(mapped.status, ProviderRateLimitStatus::Ok);
        assert_eq!(
            mapped.session.as_ref().map(|window| window.used_percent),
            Some(3.0)
        );
        assert_eq!(
            mapped.weekly.as_ref().map(|window| window.used_percent),
            Some(99.0)
        );
        assert_eq!(
            mapped
                .fable_weekly
                .as_ref()
                .map(|window| window.used_percent),
            Some(100.0)
        );
    }
}
