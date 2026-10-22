//! Quota window helpers shared by the status adapters that read a harness's
//! own usage report (Grok, Kimi).

use super::types::AccountLimitWindow;

pub const SESSION_WINDOW_MINUTES: u32 = 300;
pub const WEEKLY_WINDOW_MINUTES: u32 = 10_080;
pub const MONTHLY_WINDOW_MINUTES: u32 = 43_200;

pub fn clamp_used_percent(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 100.0)
}

pub fn parse_reset_timestamp(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::Number(number) => {
            let raw = number.as_f64()?;
            if !raw.is_finite() {
                return None;
            }
            Some(if raw > 10_000_000_000.0 {
                raw as i64
            } else {
                (raw * 1000.0) as i64
            })
        }
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(raw) = trimmed.parse::<f64>() {
                if raw.is_finite() {
                    return Some(if raw > 10_000_000_000.0 {
                        raw as i64
                    } else {
                        (raw * 1000.0) as i64
                    });
                }
            }
            chrono::DateTime::parse_from_rfc3339(trimmed)
                .ok()
                .map(|date| date.timestamp_millis())
        }
        _ => None,
    }
}

/// A plan window the account's status lists, or `None` when the provider
/// reported no usage figure for it: an unknown window is never shown as
/// unused.
pub fn limit_window(
    id: &str,
    label: &str,
    used_percent: Option<f64>,
    window_minutes: u32,
    resets_at: Option<i64>,
) -> Option<AccountLimitWindow> {
    let used_percent = used_percent.filter(|value| value.is_finite())?;
    Some(AccountLimitWindow {
        id: id.into(),
        label: label.into(),
        used_percent: Some(clamp_used_percent(used_percent)),
        remaining: None,
        resets_at,
        window_minutes: Some(window_minutes),
        model_id: None,
        covered_by_credits: false,
        coding: false,
    })
}
