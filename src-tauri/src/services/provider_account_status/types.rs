use serde::{Deserialize, Serialize};

/// Display-only balances. Currency amounts are in major units; expiry is epoch milliseconds.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreditBalance {
    pub id: String,
    pub label: String,
    pub balance: Option<String>,
    pub total: Option<String>,
    pub currency: Option<String>,
    pub expires_at: Option<i64>,
    pub unlimited: bool,
}

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
    /// The account's credits keep it usable once this plan window is spent,
    /// as the provider's own app does. A spending allowance never is.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub covered_by_credits: bool,
    /// A monthly window that meters coding use alone, beside the account's
    /// whole monthly window (Kimi Code).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub coding: bool,
}

/// What a reset refills, named once for every provider. Each adapter maps its
/// provider's own types onto these, so no provider string reaches a label.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetKind {
    /// Every usage window of the account.
    Full,
    Weekly,
    FiveHour,
    /// Returns what Fable used to the weekly allowance and clears nothing else.
    Fable,
    /// The provider does not say which windows it refills.
    Usage,
}

/// Where a reset credit stands, in one vocabulary for every provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetCreditStatus {
    /// Can be redeemed now.
    Available,
    /// Usable, but the provider takes another credit of its kind first.
    Queued,
    /// A redemption of it is under way at the provider.
    Redeeming,
    Paused,
    /// Has uses left and cannot be redeemed now; `blocked` says why when the
    /// provider does.
    Unavailable,
    Used,
    Expired,
}

/// Why a credit with uses left cannot be redeemed now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetBlock {
    /// It works only at a limit it refills, and the account is at none.
    NeedsLimit,
    /// The account is at a limit it does not refill.
    OtherLimit,
    /// Nothing was used this week for it to return (a Fable reset).
    NothingToReturn,
    /// Another reset was used a moment ago.
    Cooldown,
    /// Its period has not begun.
    NotStarted,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredit {
    pub id: String,
    pub reset_type: ResetKind,
    pub status: ResetCreditStatus,
    /// Redemptions left in this credit.
    pub uses_left: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<ResetBlock>,
    pub granted_at: Option<i64>,
    pub expires_at: Option<i64>,
    /// The provider's own name for the credit, where the kind has none.
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetTokens {
    /// Redemptions the account could make now, across its credits.
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
    /// Plan usage is spent and the account runs on its credits.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub on_credits: bool,
    pub last_updated_at: i64,
    pub last_attempt_at: i64,
    pub stale: bool,
    pub error: Option<String>,
    /// Usage endpoint cooldown, independent of the account's message allowance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_retry_at: Option<i64>,
    /// The provider refused this account's request for a reason no usage
    /// reset lifts (no balance or plan for the key to spend, billing, an
    /// account on hold), in its own words. A usage read can still report a
    /// plan with room (Z.ai's does, whichever key asks), so this stands until
    /// a turn on the account is served (after a top-up, say) or its key or
    /// sign-in changes. Turns are never held back for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
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
            on_credits: false,
            last_updated_at: now,
            last_attempt_at: now,
            stale: false,
            error: None,
            usage_retry_at: None,
            refused: None,
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
    /// Another reset was used a moment ago; this one was not spent.
    Cooldown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResetResult {
    pub outcome: ResetOutcome,
}
