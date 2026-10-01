//! Targeted benchmark observations with a fetch barrier and explicit unknown precision.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMeasurement {
    pub account_id: String,
    pub provider_id: String,
    pub subscription: Option<String>,
    pub scope_key: String,
    pub scope_confidence: String,
    pub source: String,
    pub fetch_started_at: i64,
    pub fetch_finished_at: i64,
    pub source_timestamp: Option<i64>,
    pub precision_percent: Option<f64>,
    pub windows: Vec<AccountLimitWindow>,
    pub stale: bool,
    pub error: Option<String>,
    pub state: AccountState,
}

pub async fn sample_account(
    app: &AppHandle,
    account_id: &str,
    not_before: i64,
) -> Result<AccountMeasurement, String> {
    let state = app.state::<ProviderAccountStatusState>();
    let slot = state.refresh_slot(account_id).await;
    // Never share a refresh that began before the measured interval ended.
    let _guard = slot.gate.lock().await;
    let account = provider_accounts::account(app, account_id)?;
    let started = now_ms();
    if started < not_before {
        return Err("Sample requested before its freshness barrier".into());
    }
    let observations = slot.observations.load(Ordering::SeqCst);
    let fetched = fetch_account(app, &account).await;
    let finished = now_ms();
    let changed = observations != slot.observations.load(Ordering::SeqCst);
    let mut cache = state.cache.lock().await;
    let merged = merge_refresh(cache.get(account_id), fetched.clone());
    cache.insert(account_id.into(), merged);
    slot.completed.fetch_add(1, Ordering::SeqCst);
    Ok(AccountMeasurement {
        account_id: account.id,
        provider_id: account.provider_id.clone(),
        subscription: fetched.subscription,
        // Credential account IDs do not establish independent subscriptions.
        scope_key: format!("{}:unverified-shared-pool", account.provider_id),
        scope_confidence: "unknown".into(),
        source: format!("{}/account-status-v1", account.provider_id),
        fetch_started_at: started,
        fetch_finished_at: finished,
        source_timestamp: None,
        precision_percent: None,
        windows: fetched.limits,
        stale: fetched.stale || changed || fetched.last_updated_at < started,
        error: fetched.error,
        state: fetched.state,
    })
}
