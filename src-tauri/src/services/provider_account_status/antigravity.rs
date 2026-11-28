//! Personal subscription limits reported by the CLI's local /usage command.
use super::types::{AccountLimitWindow, AccountState, ProviderAccountStatus};
use super::windows::{
    limit_window, parse_reset_timestamp, SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES,
};
use crate::services::{agent_host::antigravity, flock_root, provider_accounts::ProviderAccount};
use serde_json::Value;
use tauri::AppHandle;

fn reported_windows(groups: &[Value]) -> Vec<AccountLimitWindow> {
    let mut windows = Vec::new();
    for bucket in groups
        .iter()
        .flat_map(|group| group["buckets"].as_array().into_iter().flatten())
    {
        let (id, label, minutes) = match bucket["id"].as_str() {
            Some("gemini-5h") => ("gemini-5h", "Session", SESSION_WINDOW_MINUTES),
            Some("gemini-weekly") => ("gemini-weekly", "Weekly", WEEKLY_WINDOW_MINUTES),
            _ => continue,
        };
        if bucket["disabled"] == true || windows.iter().any(|w: &AccountLimitWindow| w.id == id) {
            continue;
        }
        let used = bucket["remaining_fraction"]
            .as_f64()
            .filter(|n| (0.0..=1.0).contains(n))
            .map(|n| (1.0 - n) * 100.0);
        if let Some(mut window) = limit_window(
            id,
            label,
            used,
            minutes,
            parse_reset_timestamp(&bucket["reset_time"]),
        ) {
            window.model_id = Some("Gemini".into());
            windows.push(window);
        }
    }
    windows
}

fn apply_usage(status: &mut ProviderAccountStatus, reply: &Value) -> Result<(), String> {
    if reply["num_turns"].as_u64() != Some(0) {
        return Err("Antigravity did not return a zero-turn usage report".into());
    }
    if reply["status"] == "ERROR" && reply["error"] == "authentication failed or timed out" {
        status.state = AccountState::NeedsAuth;
        return Ok(());
    }
    if reply["status"] != "SUCCESS"
        || reply.pointer("/command/name").and_then(Value::as_str) != Some("usage")
    {
        return Err("Antigravity could not report account usage".into());
    }
    let groups = reply
        .pointer("/command/data/groups")
        .and_then(Value::as_array)
        .ok_or("Invalid Antigravity usage report")?;
    status.limits = reported_windows(groups);
    // A spent Gemini window gates matching model IDs in the shared router.
    // Other families on the same personal account have independent allowances.
    status.state = AccountState::Ready;
    Ok(())
}

pub(super) async fn fetch(
    app: &AppHandle,
    account: &ProviderAccount,
) -> Result<ProviderAccountStatus, String> {
    let mut status =
        ProviderAccountStatus::empty(&account.id, &account.provider_id, super::now_ms());
    if !antigravity::personal_grant(&flock_root::app_root(app)?)? {
        status.state = AccountState::NeedsAuth;
        return Ok(status);
    }
    apply_usage(&mut status, &antigravity::usage(app).await?)?;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn antigravity_exhausted_gemini_window_leaves_other_models_available() {
        let mut status = ProviderAccountStatus::empty("test-account", antigravity::ID, 1);
        let response = json!({"status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"buckets":[
            {"id":"other-5h","remaining_fraction":0},
            {"id":"gemini-5h","remaining_fraction":1.5},
            {"id":"gemini-5h","disabled":true,"remaining_fraction":0},
            {"id":"gemini-5h","remaining_fraction":0,"reset_time":"2026-12-01T00:00:00Z"},
            {"id":"gemini-weekly","remaining_fraction":0.25}
        ]}]}}});
        apply_usage(&mut status, &response).unwrap();
        assert_eq!(status.state, AccountState::Ready);
        assert_eq!(status.limits.len(), 2);
        assert_eq!(status.limits[0].model_id.as_deref(), Some("Gemini"));
        assert_eq!(status.limits[1].used_percent, Some(75.0));
        assert_eq!(
            super::super::blocked(&status, Some("gemini-example"), false, 1),
            (true, Some(1796083200000))
        );
        assert_eq!(
            super::super::blocked(&status, Some("different-family"), false, 1),
            (false, None)
        );
    }

    #[test]
    fn antigravity_signed_out_usage_and_unexpected_responses_stay_distinct() {
        let mut status = ProviderAccountStatus::empty("test-account", antigravity::ID, 1);
        apply_usage(
            &mut status,
            &json!({"status":"ERROR","num_turns":0,"error":"authentication failed or timed out"}),
        )
        .unwrap();
        assert_eq!(status.state, AccountState::NeedsAuth);
        for unexpected in [
            json!({"status":"ERROR","num_turns":0,"error":"fictional detail"}),
            json!({"status":"SUCCESS","num_turns":1,"command":{"name":"usage"}}),
            json!({"status":"SUCCESS","num_turns":0,"command":{"name":"other"}}),
            json!({"status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{}}}),
        ] {
            assert!(apply_usage(&mut status, &unexpected).is_err());
        }
    }
}
