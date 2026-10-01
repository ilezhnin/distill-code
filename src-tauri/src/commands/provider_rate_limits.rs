//! Renderer IPC for Grok/Kimi subscription limits. Claude/Codex quotas come
//! from the managed account status service and are composed in the renderer.

use crate::services::{
    e2e_mode::E2eMode,
    managed_acp_tools,
    provider_rate_limits::{fetch_snapshot, ProviderRateLimitSnapshot},
};
use tauri::Manager;

#[tauri::command]
pub async fn get_provider_rate_limits(
    app: tauri::AppHandle,
) -> Result<ProviderRateLimitSnapshot, String> {
    // This legacy poll reads host CLI credentials directly. An isolated UI
    // run must never probe real accounts merely by opening the window.
    if app.try_state::<E2eMode>().is_some() {
        return Ok(ProviderRateLimitSnapshot {
            providers: Vec::new(),
            updated_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0),
        });
    }
    fetch_snapshot(&managed_acp_tools::provider_env(&app).await).await
}
