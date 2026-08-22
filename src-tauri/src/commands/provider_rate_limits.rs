//! Renderer IPC for connected agent-platform subscription limits.
//!
//! Goose is not the owner of Claude Code / Codex / Grok CLI logins. Distill's
//! Tauri layer already installs and authenticates those agents, so it also
//! fetches their subscription windows. Goose continues to report ACP token
//! usage for Goose-hosted sessions.

use crate::services::provider_rate_limits::{fetch_snapshot, ProviderRateLimitSnapshot};

#[tauri::command]
pub async fn get_provider_rate_limits() -> Result<ProviderRateLimitSnapshot, String> {
    fetch_snapshot().await
}
