use super::types::RateLimitWindow;

pub const SESSION_WINDOW_MINUTES: u32 = 300;
pub const WEEKLY_WINDOW_MINUTES: u32 = 10_080;
pub const MONTHLY_WINDOW_MINUTES: u32 = 43_200;
const CODEX_WINDOW_DURATION_TOLERANCE_MINUTES: u32 = 1;

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

pub fn reset_description(resets_at: Option<i64>) -> Option<String> {
    let resets_at = resets_at?;
    let datetime = chrono::DateTime::from_timestamp_millis(resets_at)?;
    Some(datetime.to_rfc3339())
}

pub fn usage_window(
    used_percent: Option<f64>,
    window_minutes: u32,
    resets_at: Option<i64>,
) -> Option<RateLimitWindow> {
    let used_percent = used_percent.filter(|value| value.is_finite())?;
    Some(RateLimitWindow {
        used_percent: clamp_used_percent(used_percent),
        window_minutes,
        resets_at,
        reset_description: reset_description(resets_at),
    })
}

pub fn classify_codex_window_minutes(duration_minutes: Option<f64>) -> Option<&'static str> {
    let duration = duration_minutes.filter(|value| value.is_finite())? as u32;
    if duration.abs_diff(SESSION_WINDOW_MINUTES) <= CODEX_WINDOW_DURATION_TOLERANCE_MINUTES {
        return Some("session");
    }
    if duration.abs_diff(WEEKLY_WINDOW_MINUTES) <= CODEX_WINDOW_DURATION_TOLERANCE_MINUTES {
        return Some("weekly");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_seconds_and_millis_epochs() {
        assert_eq!(
            parse_reset_timestamp(&serde_json::json!(1_700_000_000)),
            Some(1_700_000_000_000)
        );
        assert_eq!(
            parse_reset_timestamp(&serde_json::json!(1_700_000_000_000i64)),
            Some(1_700_000_000_000)
        );
    }

    #[test]
    fn clamps_percent() {
        assert_eq!(clamp_used_percent(140.0), 100.0);
        assert_eq!(clamp_used_percent(-4.0), 0.0);
    }
}
