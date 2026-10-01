use crate::services::provider_account_status::{self, ProviderAccountStatusSnapshot, ResetResult};

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
