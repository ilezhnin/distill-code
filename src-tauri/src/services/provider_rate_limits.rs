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

pub async fn fetch_snapshot() -> Result<ProviderRateLimitSnapshot, String> {
    let client = http_client()?;
    let (claude, codex, grok) = tokio::join!(
        claude::fetch_claude_rate_limits(&client),
        codex::fetch_codex_rate_limits(&client),
        grok::fetch_grok_rate_limits(&client),
    );

    Ok(ProviderRateLimitSnapshot {
        providers: vec![claude, grok, codex],
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
        plan_type: None,
        account_label: None,
        updated_at: now_ms(),
        error,
        status,
        configured: false,
    }
}
