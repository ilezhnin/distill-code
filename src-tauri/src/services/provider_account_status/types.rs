pub use crate::services::provider_rate_limits::CreditBalance;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountState {
    Ready,
    Limited,
    NeedsAuth,
    Unknown,
    Error,
    Disabled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLimitWindow {
    pub id: String,
    pub label: String,
    pub used_percent: Option<f64>,
    pub remaining: Option<f64>,
    pub resets_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<u32>,
    pub model_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredit {
    pub id: String,
    pub reset_type: String,
    pub status: String,
    pub granted_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetTokens {
    pub available: u64,
    pub expires_at: Option<i64>,
    /// This adapter has a verified operator-only redemption method.
    pub supported: bool,
    pub credits: Option<Vec<ResetCredit>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountStatus {
    pub account_id: String,
    pub provider_id: String,
    pub state: AccountState,
    pub subscription: Option<String>,
    pub account_label: Option<String>,
    pub limits: Vec<AccountLimitWindow>,
    pub reset_tokens: Option<ResetTokens>,
    pub credits: Option<Vec<CreditBalance>>,
    pub last_updated_at: i64,
    pub last_attempt_at: i64,
    pub stale: bool,
    pub error: Option<String>,
    /// Usage endpoint cooldown, independent of the account's message allowance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_retry_at: Option<i64>,
}

impl ProviderAccountStatus {
    pub fn empty(account_id: &str, provider_id: &str, now: i64) -> Self {
        Self {
            account_id: account_id.into(),
            provider_id: provider_id.into(),
            state: AccountState::Unknown,
            subscription: None,
            account_label: None,
            limits: Vec::new(),
            reset_tokens: None,
            credits: None,
            last_updated_at: now,
            last_attempt_at: now,
            stale: false,
            error: None,
            usage_retry_at: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountStatusSnapshot {
    pub accounts: Vec<ProviderAccountStatus>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AccountSelection {
    Ready {
        #[serde(rename = "accountId")]
        account_id: String,
    },
    Wait {
        #[serde(rename = "accountId")]
        account_id: String,
        #[serde(rename = "nextReset")]
        next_reset: Option<i64>,
        #[serde(rename = "resetTokensAvailable")]
        reset_tokens_available: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResetOutcome {
    Reset,
    AlreadyRedeemed,
    NothingToReset,
    NoCredit,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResetResult {
    pub outcome: ResetOutcome,
}
