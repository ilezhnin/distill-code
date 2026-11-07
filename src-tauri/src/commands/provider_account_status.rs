use crate::services::provider_account_status::{
    self, AccountSelection, ProviderAccountStatusSnapshot, ResetResult,
};

/// Whether a new chat of `provider_id` on `model_id` could run its first
/// prompt now, or would wait for an allowance reset; null when Flock reads
/// no allowance for the provider.
#[tauri::command]
pub async fn new_chat_account_selection(
    app: tauri::AppHandle,
    provider_id: String,
    model_id: Option<String>,
) -> Result<Option<AccountSelection>, String> {
    Ok(provider_account_status::new_chat_selection(&app, &provider_id, model_id.as_deref()).await)
}

#[tauri::command]
pub async fn get_provider_account_statuses(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<ProviderAccountStatusSnapshot, String> {
    provider_account_status::fetch_snapshot(&app, force.unwrap_or(false)).await
}

#[tauri::command]
pub async fn consume_provider_account_reset(
    app: tauri::AppHandle,
    account_id: String,
    idempotency_key: String,
    credit_id: Option<String>,
) -> Result<ResetResult, String> {
    provider_account_status::consume_reset(
        &app,
        &account_id,
        &idempotency_key,
        credit_id.as_deref(),
    )
    .await
}
