//! Agent-platform subscription rate limits.
//!
//! Distill owns this surface because Distill already owns agent CLI install
//! and auth (`agent_setup`). Per-session token usage is a separate signal:
//! the ACP bridges report it on prompt results, the agent host passes those
//! through unchanged, and the renderer records them in its usage ledger for
//! Settings → Stats. Subscription windows come only from the CLIs' own
//! accounts, fetched here.

mod claude;
mod codex;
pub(crate) mod grok;
mod kimi;
mod types;
mod windows;

pub use types::{
    AgentPlatformId, ProviderRateLimitSnapshot, ProviderRateLimitStatus, ProviderRateLimits,
};

const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to build rate-limit HTTP client: {error}"))
}

pub async fn fetch_snapshot(
    env: &std::collections::HashMap<String, String>,
) -> Result<ProviderRateLimitSnapshot, String> {
    let client = http_client()?;
    let (claude, codex, grok, kimi) = tokio::join!(
        claude::fetch_claude_rate_limits(&client),
        codex::fetch_codex_rate_limits(&client),
        grok::fetch_grok_rate_limits(&client),
        kimi::fetch_kimi_rate_limits(env),
    );
    // These are quota adapters, not the provider roster. The UI derives its
    // roster from the catalog and fills in connection status without quotas.
    let mut providers = vec![claude, grok, codex];
    providers.extend(kimi);
    Ok(ProviderRateLimitSnapshot {
        providers,
        updated_at: now_ms(),
    })
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn home_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir()
}

fn result(
    provider: AgentPlatformId,
    status: ProviderRateLimitStatus,
    error: Option<String>,
) -> ProviderRateLimits {
    ProviderRateLimits {
        provider,
        session: None,
        weekly: None,
        fable_weekly: None,
        monthly: None,
        coding_monthly: None,
        plan_type: None,
        account_label: None,
        updated_at: now_ms(),
        error,
        status,
        configured: false,
    }
}

/// An unauthorized usage fetch is a dead sign-in, not a blip: `configured:
/// false` is what the roster reads as "offer Sign in". It stays an `Error`
/// rather than the `Unavailable` a missing login returns, because the status
/// bar hides an unavailable, unconfigured provider — and this account needs
/// its Sign in row. The error body is kept (truncated) so a revoked token is
/// distinguishable from a missing one; it must not say "rate limit", which
/// the roster would paint as Limited.
fn unauthorized_sign_in(
    provider: AgentPlatformId,
    error: String,
    account_label: Option<String>,
) -> ProviderRateLimits {
    ProviderRateLimits {
        account_label,
        ..result(provider, ProviderRateLimitStatus::Error, Some(error))
    }
}

fn format_unauthorized_usage_error(provider_label: &str, status: u16, body: &str) -> String {
    let snippet = compact_error_body(body);
    if snippet.is_empty() {
        format!("{provider_label} usage request unauthorized (HTTP {status})")
    } else {
        format!("{provider_label} usage request unauthorized (HTTP {status}): {snippet}")
    }
}

fn compact_error_body(body: &str) -> String {
    let collapsed = body.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 280;
    let count = collapsed.chars().count();
    if count <= MAX {
        collapsed
    } else {
        let mut out: String = collapsed.chars().take(MAX).collect();
        out.push('…');
        out
    }
}

async fn unauthorized_from_response(
    provider: AgentPlatformId,
    provider_label: &str,
    status: reqwest::StatusCode,
    response: reqwest::Response,
    account_label: Option<String>,
) -> ProviderRateLimits {
    let body = response.text().await.unwrap_or_default();
    unauthorized_sign_in(
        provider,
        format_unauthorized_usage_error(provider_label, status.as_u16(), &body),
        account_label,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unauthorized_usage_is_a_sign_in_not_a_failed_refresh() {
        let result = unauthorized_sign_in(
            AgentPlatformId::Codex,
            "Codex usage request unauthorized (HTTP 401): token_revoked".into(),
            Some("acct_1".into()),
        );
        assert!(matches!(result.status, ProviderRateLimitStatus::Error));
        assert!(!result.configured);
        assert!(result.session.is_none() && result.weekly.is_none() && result.monthly.is_none());
        assert_eq!(result.account_label.as_deref(), Some("acct_1"));
    }

    #[test]
    fn unauthorized_error_includes_body_without_rate_limit_wording() {
        let error = format_unauthorized_usage_error(
            "Codex",
            401,
            r#"{ "error": { "message": "Encountered invalidated oauth token for user, failing request", "type": null, "code": "token_revoked" } }"#,
        );
        assert!(error.contains("401"));
        assert!(error.contains("token_revoked"));
        assert!(error.contains("invalidated oauth token"));
        assert!(!error.to_lowercase().contains("rate limit"));
    }

    #[test]
    fn unauthorized_error_truncates_a_long_body() {
        let error = format_unauthorized_usage_error("Claude", 403, &"x".repeat(400));
        assert!(error.contains("HTTP 403"));
        assert!(error.ends_with('…'));
        assert!(error.len() < 400);
    }
}
