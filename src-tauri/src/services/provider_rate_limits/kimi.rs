//! Kimi's own local API owns token refresh. Distill reads only configuration
//! to decide whether subscription quotas apply, never the OAuth credential.

use super::types::{AgentPlatformId, ProviderRateLimitStatus, ProviderRateLimits, RateLimitWindow};
use super::windows::{
    parse_reset_timestamp, usage_window, MONTHLY_WINDOW_MINUTES, SESSION_WINDOW_MINUTES,
    WEEKLY_WINDOW_MINUTES,
};
use super::{home_dir, result};
use crate::services::env_key;
use serde_json::Value;
use std::{collections::HashMap, fs, path::Path};

fn supports_managed_usage(root: &Path, base_override: Option<&str>) -> Result<bool, String> {
    let raw = match fs::read_to_string(root.join("config.toml")) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("Kimi Code configuration could not be read".into()),
    };
    let config: toml::Value =
        toml::from_str(&raw).map_err(|_| "Kimi Code configuration is invalid".to_string())?;
    let Some(provider) = config
        .get("providers")
        .and_then(|providers| providers.get("managed:kimi-code"))
    else {
        return Ok(false);
    };
    let base = base_override.or_else(|| provider.get("base_url").and_then(toml::Value::as_str));
    Ok(base.is_some_and(|base| {
        matches!(
            base.trim_end_matches('/'),
            "https://api.kimi.com/coding/v1" | "https://api.kimi.ai/coding/v1"
        )
    }))
}

fn quota_window(value: Option<&Value>, minutes: u32) -> Option<RateLimitWindow> {
    let value = value?;
    usage_window(
        value
            .get("usedRatio")
            .and_then(Value::as_f64)
            .map(|ratio| ratio * 100.0),
        minutes,
        value.get("resetAt").and_then(parse_reset_timestamp),
    )
}

fn map_usage(data: &Value) -> ProviderRateLimits {
    if data.get("kind").and_then(Value::as_str) != Some("ok") {
        return if matches!(data.get("status").and_then(Value::as_u64), Some(401 | 403)) {
            super::unauthorized_sign_in(
                AgentPlatformId::Kimi,
                "Kimi Code sign-in could not be renewed. Sign in again.".into(),
                None,
            )
        } else {
            usage_error("Kimi Code could not refresh usage. Check the connection or sign in again.")
        };
    }
    let usages = data.get("quota").and_then(|quota| quota.get("usages"));
    let mut output = result(AgentPlatformId::Kimi, ProviderRateLimitStatus::Ok, None);
    output.configured = true;
    output.session = quota_window(
        usages.and_then(|u| u.get("limit5h")),
        SESSION_WINDOW_MINUTES,
    );
    output.weekly = quota_window(usages.and_then(|u| u.get("limit7d")), WEEKLY_WINDOW_MINUTES);
    output.monthly = quota_window(
        usages.and_then(|u| u.get("monthTotal")),
        MONTHLY_WINDOW_MINUTES,
    );
    output.coding_monthly = quota_window(
        usages.and_then(|u| u.get("monthCode")),
        MONTHLY_WINDOW_MINUTES,
    );
    if output.session.is_none()
        && output.weekly.is_none()
        && output.monthly.is_none()
        && output.coding_monthly.is_none()
    {
        output.status = ProviderRateLimitStatus::Unavailable;
    }
    output
}

fn usage_error(message: &str) -> ProviderRateLimits {
    ProviderRateLimits {
        configured: true,
        ..result(
            AgentPlatformId::Kimi,
            ProviderRateLimitStatus::Error,
            Some(message.into()),
        )
    }
}

pub async fn fetch_kimi_rate_limits(env: &HashMap<String, String>) -> Option<ProviderRateLimits> {
    let root = env_key::get(env, "KIMI_CODE_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".kimi-code")))?;
    let base_override = env_key::get(env, "KIMI_CODE_BASE_URL");
    match supports_managed_usage(&root, base_override) {
        Ok(false) => None,
        Err(error) => Some(usage_error(&error)),
        Ok(true) => Some(
            match crate::services::agent_host::kimi::managed_usage(&root, env).await {
                Ok(data) => map_usage(&data),
                Err(error) => usage_error(&error),
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn supports_both_regions_without_reading_or_creating_credentials() {
        let root = tempfile::tempdir().unwrap();
        for base in [
            "https://api.kimi.com/coding/v1",
            "https://api.kimi.ai/coding/v1",
        ] {
            let config = format!("[providers.\"managed:kimi-code\"]\ntype = \"kimi\"\nbase_url = \"{base}\"\noauth = {{ storage = \"file\", key = \"oauth/kimi-code-global\" }}");
            fs::write(root.path().join("config.toml"), &config).unwrap();
            assert!(supports_managed_usage(root.path(), None).unwrap());
            assert!(!root.path().join("credentials").exists());
            assert_eq!(
                fs::read_to_string(root.path().join("config.toml")).unwrap(),
                config
            );
            assert!(
                !supports_managed_usage(root.path(), Some("https://example.org/coding/v1"))
                    .unwrap()
            );
        }
    }

    #[test]
    fn custom_providers_leave_readiness_to_the_cli() {
        let root = tempfile::tempdir().unwrap();
        assert!(!supports_managed_usage(root.path(), None).unwrap());
        fs::write(
            root.path().join("config.toml"),
            "[providers.local]\ntype = \"openai\"\nbase_url = \"http://localhost:1234/v1\"",
        )
        .unwrap();
        assert!(!supports_managed_usage(root.path(), None).unwrap());
    }

    #[test]
    fn maps_all_quota_windows_and_preserves_unknown_values() {
        let usage = map_usage(&json!({"kind":"ok", "quota":{"usages": {
            "limit5h": {"usedRatio": 0.25, "resetAt": "2026-09-24T00:00:00Z"},
            "limit7d": {"usedRatio": 0.7},
            "monthTotal": {"usedRatio": 0.9},
            "monthCode": {"usedRatio": 1.2}
        }}}));
        assert_eq!(usage.session.unwrap().used_percent, 25.0);
        assert_eq!(usage.weekly.unwrap().used_percent, 70.0);
        assert_eq!(usage.monthly.unwrap().used_percent, 90.0);
        assert_eq!(usage.coding_monthly.unwrap().used_percent, 100.0);
        let unknown =
            map_usage(&json!({"kind":"ok", "quota":{"usages": {"limit5h": {"usedRatio": "bad"}}}}));
        assert!(unknown.session.is_none());
        assert_eq!(unknown.status, ProviderRateLimitStatus::Unavailable);
        assert!(unknown.configured);
    }

    #[test]
    fn only_a_confirmed_auth_failure_offers_sign_in() {
        let expired = map_usage(&json!({"kind":"error", "status":401}));
        assert!(!expired.configured);
        let unavailable = map_usage(&json!({"kind":"error", "message":"network error"}));
        assert!(unavailable.configured);
        assert_eq!(unavailable.status, ProviderRateLimitStatus::Error);
    }
}
