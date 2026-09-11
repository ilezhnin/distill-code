//! Renderer IPC for connected agent-platform subscription limits.
//!
//! Distill's Tauri layer already installs and authenticates the Claude Code /
//! Codex / Grok CLIs, so it also fetches their subscription windows. Per-session
//! token usage arrives separately, on ACP prompt results.

use crate::services::provider_rate_limits::{fetch_snapshot, ProviderRateLimitSnapshot};

#[tauri::command]
pub async fn get_provider_rate_limits() -> Result<ProviderRateLimitSnapshot, String> {
    fetch_snapshot().await
}
