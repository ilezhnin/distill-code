use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum AgentPlatformId {
    #[serde(rename = "claude-acp")]
    Claude,
    #[serde(rename = "codex-acp")]
    Codex,
    #[serde(rename = "grok-acp")]
    Grok,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderRateLimitStatus {
    Idle,
    Fetching,
    Ok,
    Error,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub used_percent: f64,
    pub window_minutes: u32,
    pub resets_at: Option<i64>,
    pub reset_description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRateLimits {
    pub provider: AgentPlatformId,
    pub session: Option<RateLimitWindow>,
    pub weekly: Option<RateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fable_weekly: Option<RateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monthly: Option<RateLimitWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    pub updated_at: i64,
    pub error: Option<String>,
    pub status: ProviderRateLimitStatus,
    pub configured: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRateLimitSnapshot {
    pub providers: Vec<ProviderRateLimits>,
    pub updated_at: i64,
}
