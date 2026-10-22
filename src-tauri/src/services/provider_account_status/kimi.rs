//! The Kimi Code CLI's own sign-in, which Flock names `cli-login-kimi-acp`.
//! Kimi's local API owns token refresh and reports the subscription quotas;
//! Flock reads only its configuration to decide whether they apply, never
//! the OAuth credential. A custom provider has no quotas, so the CLI's ACP
//! auth gate alone says whether it is signed in.

use std::{collections::HashMap, fs, path::Path, path::PathBuf};

use doctor::types::AuthStatus;
use serde_json::Value;
use tauri::AppHandle;

use super::types::*;
use super::windows::{
    limit_window, parse_reset_timestamp, MONTHLY_WINDOW_MINUTES, SESSION_WINDOW_MINUTES,
    WEEKLY_WINDOW_MINUTES,
};
use super::{home_dir, now_ms};
use crate::services::{env_key, managed_acp_tools, provider_accounts::ProviderAccount};

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

fn quota_window(
    value: Option<&Value>,
    id: &str,
    label: &str,
    minutes: u32,
    coding: bool,
) -> Option<AccountLimitWindow> {
    let value = value?;
    let mut window = limit_window(
        id,
        label,
        value
            .get("usedRatio")
            .and_then(Value::as_f64)
            .map(|ratio| ratio * 100.0),
        minutes,
        value.get("resetAt").and_then(parse_reset_timestamp),
    )?;
    window.coding = coding;
    Some(window)
}

/// The account status Kimi's usage reply maps to.
pub(super) fn map_usage(
    account: &ProviderAccount,
    data: &Value,
    now: i64,
) -> ProviderAccountStatus {
    let mut status = ProviderAccountStatus::empty(&account.id, &account.provider_id, now);
    if data.get("kind").and_then(Value::as_str) != Some("ok") {
        if matches!(data.get("status").and_then(Value::as_u64), Some(401 | 403)) {
            status.state = AccountState::NeedsAuth;
            status.error = Some("Kimi Code sign-in could not be renewed. Sign in again.".into());
        } else {
            status.state = AccountState::Error;
            status.stale = true;
            status.error = Some(
                "Kimi Code could not refresh usage. Check the connection or sign in again.".into(),
            );
        }
        return status;
    }
    let profile_text = |key: &str| {
        data["userInfo"][key]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    status.account_label = profile_text("email")
        .or_else(|| profile_text("nickname"))
        .or_else(|| profile_text("username"))
        .map(str::to_owned);
    status.subscription = profile_text("userLevelName").map(str::to_owned);
    let extra = &data["quota"]["extraUsage"];
    let cents = |key: &str| extra[key].as_f64().filter(|n| n.is_finite() && *n >= 0.0);
    if let (Some(balance), Some(currency)) = (
        cents("balanceCents"),
        extra["currency"]
            .as_str()
            .filter(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase())),
    ) {
        // The native CLI normalizes the booster wallet into cents.
        status.credits = Some(vec![CreditBalance {
            id: "extra_usage".into(),
            label: "Extra usage".into(),
            balance: Some((balance / 100.0).to_string()),
            total: cents("totalCents").map(|n| (n / 100.0).to_string()),
            currency: Some(currency.into()),
            expires_at: None,
            unlimited: false,
        }]);
    }
    let usages = data.get("quota").and_then(|quota| quota.get("usages"));
    let usage = |key: &str| usages.and_then(|value| value.get(key));
    status.limits = [
        quota_window(
            usage("limit5h"),
            "kimi:limit5h",
            "5 hours",
            SESSION_WINDOW_MINUTES,
            false,
        ),
        quota_window(
            usage("limit7d"),
            "kimi:limit7d",
            "Weekly",
            WEEKLY_WINDOW_MINUTES,
            false,
        ),
        quota_window(
            usage("monthTotal"),
            "kimi:monthTotal",
            "Monthly",
            MONTHLY_WINDOW_MINUTES,
            false,
        ),
        quota_window(
            usage("monthCode"),
            "kimi:monthCode",
            "Monthly coding",
            MONTHLY_WINDOW_MINUTES,
            true,
        ),
    ]
    .into_iter()
    .flatten()
    .collect();
    status.state = if status
        .limits
        .iter()
        .any(|window| window.used_percent.is_some_and(|used| used >= 100.0))
    {
        AccountState::Limited
    } else {
        AccountState::Ready
    };
    status
}

fn kimi_home(env: &HashMap<String, String>) -> Option<PathBuf> {
    env_key::get(env, "KIMI_CODE_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".kimi-code")))
}

/// The status of the Kimi Code CLI sign-in: its plan, quotas and wallet
/// from the CLI's local API when it runs on the managed Kimi provider, else
/// only whether its ACP auth gate passes.
pub(super) async fn fetch(
    app: &AppHandle,
    account: &ProviderAccount,
) -> Result<ProviderAccountStatus, String> {
    let env = managed_acp_tools::provider_env(app).await;
    let root = kimi_home(&env).ok_or("Kimi Code home is unknown")?;
    let base_override = env_key::get(&env, "KIMI_CODE_BASE_URL");
    if !supports_managed_usage(&root, base_override)? {
        let mut status = ProviderAccountStatus::empty(&account.id, &account.provider_id, now_ms());
        status.state = match crate::services::agent_host::kimi::auth_status(env).await {
            AuthStatus::Authenticated => AccountState::Ready,
            AuthStatus::NotAuthenticated => AccountState::NeedsAuth,
            AuthStatus::NotApplicable | AuthStatus::Unknown => AccountState::Unknown,
        };
        return Ok(status);
    }
    let data = crate::services::agent_host::kimi::managed_usage(&root, &env).await?;
    Ok(map_usage(account, &data, now_ms()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::provider_accounts::AuthMethod;
    use serde_json::json;

    fn cli_account() -> ProviderAccount {
        ProviderAccount {
            id: "cli-login-kimi-acp".into(),
            provider_id: "kimi-acp".into(),
            label: "Kimi Code sign-in".into(),
            auth_method: AuthMethod::OAuth,
            enabled: true,
            auto_switch: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn usage(data: Value) -> ProviderAccountStatus {
        map_usage(&cli_account(), &data, 1_000)
    }

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
        let status = usage(json!({"kind":"ok", "quota":{"usages": {
            "limit5h": {"usedRatio": 0.25, "resetAt": "2026-09-24T00:00:00Z"},
            "limit7d": {"usedRatio": 0.7},
            "monthTotal": {"usedRatio": 0.9},
            "monthCode": {"usedRatio": 1.2}
        }}}));
        let window = |id: &str| status.limits.iter().find(|w| w.id == id).unwrap().clone();
        assert_eq!(window("kimi:limit5h").used_percent, Some(25.0));
        assert_eq!(window("kimi:limit5h").window_minutes, Some(300));
        assert!(window("kimi:limit5h").resets_at.is_some());
        assert_eq!(window("kimi:limit7d").used_percent, Some(70.0));
        assert_eq!(window("kimi:monthTotal").used_percent, Some(90.0));
        assert!(!window("kimi:monthTotal").coding);
        assert_eq!(window("kimi:monthCode").used_percent, Some(100.0));
        assert!(window("kimi:monthCode").coding);
        // A spent coding window counts as a limit, as before.
        assert_eq!(status.state, AccountState::Limited);
        let unknown =
            usage(json!({"kind":"ok", "quota":{"usages": {"limit5h": {"usedRatio": "bad"}}}}));
        assert!(unknown.limits.is_empty());
        assert_eq!(unknown.state, AccountState::Ready);
        assert!(unknown.error.is_none());
    }

    #[test]
    fn maps_native_profile_and_booster_wallet_without_guessing_missing_balances() {
        let status = usage(json!({"kind":"ok", "userInfo": {
            "email":"kimi@example.test", "nickname":"Personal", "userLevelName":"Kimi Moderato"
        }, "quota": {"usages":{"limit7d":{"usedRatio":0.23}}, "extraUsage": {
            "balanceCents":750, "totalCents":2000, "currency":"USD"
        }}}));
        assert_eq!(status.account_label.as_deref(), Some("kimi@example.test"));
        assert_eq!(status.subscription.as_deref(), Some("Kimi Moderato"));
        let credits = status.credits.unwrap();
        assert_eq!(credits[0].balance.as_deref(), Some("7.5"));
        assert_eq!(credits[0].total.as_deref(), Some("20"));
        assert_eq!(credits[0].currency.as_deref(), Some("USD"));
        for extra in [
            json!(null),
            json!({"balanceCents":-1,"currency":"USD"}),
            json!({"currency":"USD"}),
        ] {
            let status = usage(json!({"kind":"ok", "quota":{"extraUsage":extra}}));
            assert!(status.credits.is_none());
            assert!(status.subscription.is_none());
            assert!(status.account_label.is_none());
        }
        let exhausted = usage(
            json!({"kind":"ok", "quota": {"usages":{"limit7d":{"usedRatio":0.23}},
            "extraUsage":{"balanceCents":0,"totalCents":2000,"currency":"USD"}}}),
        );
        assert_eq!(exhausted.credits.unwrap()[0].balance.as_deref(), Some("0"));
        assert_eq!(exhausted.state, AccountState::Ready);
    }

    #[test]
    fn only_a_confirmed_auth_failure_needs_sign_in() {
        let expired = usage(json!({"kind":"error", "status":401}));
        assert_eq!(expired.state, AccountState::NeedsAuth);
        assert!(!expired.stale);
        let unavailable = usage(json!({"kind":"error", "message":"network error"}));
        assert_eq!(unavailable.state, AccountState::Error);
        assert!(unavailable.stale);
        assert!(unavailable.error.is_some());
    }
}
