//! Claude's native /limit-reset contract. Keep it separate from get_usage,
//! which strips reset grants. Only consume() sends a redemption request.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::{now_ms, timestamp, ResetCredit, ResetOutcome, ResetResult, ResetTokens};
use crate::services::{distill_root, provider_accounts};
use provider_accounts::ProviderAccount;

const ORIGIN: &str = "https://api.anthropic.com";
const USAGE_PATH: &str = "/api/oauth/usage?cedar_ember=1";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub(super) enum RequestError {
    Unauthorized,
    RateLimited(u64),
    Other(String),
}

impl From<String> for RequestError {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized => {
                write!(f, "Claude authorization expired (HTTP 401); sign in again")
            }
            Self::RateLimited(seconds) => write!(
                f,
                "Claude usage is temporarily rate limited. Try again in {seconds} seconds."
            ),
            Self::Other(message) => f.write_str(message),
        }
    }
}

#[derive(Default)]
struct UsageBackoff {
    until: i64,
    failures: u32,
}

impl UsageBackoff {
    fn remaining(&self, now: i64) -> Option<u64> {
        (self.until > now).then(|| ((self.until - now + 999) / 1000) as u64)
    }

    fn defer(&mut self, now: i64, retry_after: u64) -> u64 {
        self.failures = self.failures.saturating_add(1);
        // Some usage responses return Retry-After: 0. Do not turn that into
        // a tight retry loop; force-refresh must respect the same cooldown.
        let seconds = (60u64 << self.failures.min(4).saturating_sub(1))
            .min(300)
            .max(retry_after);
        self.until = now.saturating_add((seconds.min(i64::MAX as u64 / 1000) * 1000) as i64);
        seconds
    }
}

static USAGE_BACKOFF: OnceLock<Mutex<HashMap<String, UsageBackoff>>> = OnceLock::new();

struct Client {
    http: reqwest::Client,
    token: String,
    organization: Option<String>,
}

impl Client {
    fn for_account(
        app: &AppHandle,
        account: &ProviderAccount,
        version: Option<&str>,
    ) -> Result<Self, String> {
        let root = distill_root::app_root(app)?;
        let home = provider_accounts::account_home(app, account)?;
        let read = |name: &str| -> Result<Value, String> {
            let path = home.join(name);
            distill_root::reject_document_links(&root, &path)?;
            let bytes = std::fs::read(path)
                .map_err(|_| "Cannot read Claude reset authorization".to_string())?;
            serde_json::from_slice(&bytes)
                .map_err(|_| "Invalid Claude reset authorization".to_string())
        };
        let auth = read(".credentials.json")?;
        let token = auth
            .pointer("/claudeAiOauth/accessToken")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or("Claude reset authorization is unavailable; refresh the account")?
            .to_owned();
        let organization = read(".claude.json").ok().and_then(|value| {
            value
                .pointer("/oauthAccount/organizationUuid")
                .and_then(Value::as_str)
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .map(|id| id.to_string())
        });
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(user_agent(version)?)
            .build()
            .map_err(|_| "Cannot start Claude reset service".to_string())?;
        Ok(Self {
            http,
            token,
            organization,
        })
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value, RequestError> {
        let mut response = request
            .bearer_auth(&self.token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("Content-Type", "application/json")
            .send()
            .await
            .map_err(|_| {
                "Claude reset request could not be confirmed; retry the same operation".to_string()
            })?;
        if !response.status().is_success() {
            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                return Err(RequestError::Unauthorized);
            }
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(60);
                return Err(RequestError::RateLimited(retry_after));
            }
            // Never expose provider response bodies or credentials to the renderer.
            return Err(RequestError::Other(format!(
                "Claude reset service returned HTTP {}; refresh the account and retry",
                response.status().as_u16()
            )));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read Claude reset response".to_string())?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(RequestError::Other(
                    "Claude reset response exceeded the size limit".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
            RequestError::Other("Claude returned an unreadable reset response".into())
        })?;
        if value.pointer("/error/type").and_then(Value::as_str) == Some("rate_limit_error") {
            return Err(RequestError::RateLimited(60));
        }
        Ok(value)
    }
}

fn user_agent(version: Option<&str>) -> Result<String, String> {
    let version = version
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
        })
        .ok_or("Claude did not report its version; update its installation to read resets")?;
    // The service uses the CLI version/surface to decide eligibility. Identify
    // our client as well; a generic HTTP user agent returns an empty inventory.
    Ok(format!(
        "claude-cli/{version} (external, cli, client-app/distill)"
    ))
}

pub(super) async fn fetch_usage(
    app: &AppHandle,
    account: &ProviderAccount,
    version: Option<&str>,
) -> Result<Value, RequestError> {
    {
        let backoff = USAGE_BACKOFF
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(seconds) = backoff
            .get(&account.id)
            .and_then(|state| state.remaining(now_ms()))
        {
            return Err(RequestError::RateLimited(seconds));
        }
    }
    let client = Client::for_account(app, account, version)?;
    let result = client
        .send(client.http.get(format!("{ORIGIN}{USAGE_PATH}")))
        .await;
    let mut backoff = USAGE_BACKOFF
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    match result {
        Err(RequestError::RateLimited(seconds)) => {
            let seconds = backoff
                .entry(account.id.clone())
                .or_default()
                .defer(now_ms(), seconds);
            Err(RequestError::RateLimited(seconds))
        }
        Ok(usage) => {
            backoff.remove(&account.id);
            Ok(usage)
        }
        error => error,
    }
}

pub(super) async fn consume(
    app: &AppHandle,
    account: &ProviderAccount,
    version: Option<&str>,
    request_id: &str,
    grant_id: &str,
) -> Result<ResetResult, String> {
    let body = claim_body(grant_id, request_id)?;
    let client = Client::for_account(app, account, version)?;
    let organization = client
        .organization
        .as_deref()
        .ok_or("Claude did not report this account's organization; refresh its authorization")?;
    // No automatic retry or grant substitution. The dialog retains both IDs
    // after an uncertain response, matching the native CLI's idempotent claim.
    let result = client
        .send(
            client
                .http
                .post(format!(
                    "{ORIGIN}/api/organizations/{organization}/reset_rate_limits"
                ))
                .json(&body),
        )
        .await
        .map_err(|error| error.to_string())?;
    map_outcome(&result)
}

fn valid_grant_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}

fn claim_body(grant_id: &str, request_id: &str) -> Result<Value, String> {
    if !valid_grant_id(grant_id) || uuid::Uuid::parse_str(request_id).is_err() {
        return Err("Invalid Claude reset operation identifier".into());
    }
    Ok(json!({"program":"cedar_ember", "grant_id":grant_id, "request_id":request_id}))
}

fn map_outcome(value: &Value) -> Result<ResetResult, String> {
    let outcome = match value["result"].as_str() {
        Some("reset") => ResetOutcome::Reset,
        Some("already_used") => ResetOutcome::AlreadyRedeemed,
        Some("not_limited") => ResetOutcome::NothingToReset,
        Some("ineligible") => ResetOutcome::NoCredit,
        Some("cooldown") => return Err("Claude reset is on cooldown; wait and retry this operation".into()),
        _ => return Err("Claude did not confirm the reset; refresh usage and retry this same operation if needed".into()),
    };
    Ok(ResetResult { outcome })
}

fn optional_time(value: &Value) -> Result<Option<i64>, String> {
    if value.is_null() {
        return Ok(None);
    }
    timestamp(value)
        .map(Some)
        .ok_or("Claude returned an invalid reset date".into())
}

pub(super) fn map_inventory(usage: &Value, now: i64) -> Result<Option<ResetTokens>, String> {
    let block = &usage["cedar_ember"];
    if block.is_null() {
        return Ok(None);
    }
    let invalid = || "Claude returned an invalid reset inventory".to_string();
    let eligible = block["eligible"].as_bool().ok_or_else(invalid)?;
    let grants = block["grants"].as_array().ok_or_else(invalid)?;
    let cooldown = optional_time(&block["cooldown_until"])?;
    let mut credits = Vec::new();
    let mut available = 0u64;
    for grant in grants {
        let id = grant["id"]
            .as_str()
            .filter(|id| valid_grant_id(id))
            .ok_or_else(invalid)?;
        let left = grant["resets_left"].as_u64().ok_or_else(invalid)?;
        let starts_at = optional_time(&grant["starts_at"])?;
        let expires_at = optional_time(&grant["ends_at"])?;
        let paused = grant["paused"].as_bool().ok_or_else(invalid)?;
        let usable = grant["usable_now"].as_bool().ok_or_else(invalid)?;
        let clears = grant["clears"].as_array().ok_or_else(invalid)?;
        if clears.is_empty() || clears.iter().any(|kind| !kind.is_string()) {
            return Err(invalid());
        }
        let status = if left == 0 {
            "used"
        } else if expires_at.is_some_and(|at| at <= now) {
            "expired"
        } else if paused {
            "paused"
        } else if eligible
            && usable
            && starts_at.is_none_or(|at| at <= now)
            && cooldown.is_none_or(|at| at <= now)
            && block["next_grant_id"].as_str() == Some(id)
        {
            "available"
        } else {
            "unavailable"
        };
        if status == "available" {
            available = available.checked_add(left).ok_or_else(invalid)?;
        }
        let full = clears
            .iter()
            .any(|kind| kind.as_str().is_some_and(|s| s.starts_with("seven_day")));
        let (reset_type, title) = if full {
            ("full", "Full reset")
        } else if clears.iter().all(|kind| kind == "five_hour") {
            ("five_hour", "5-hour reset")
        } else {
            ("usage", "Usage reset")
        };
        credits.push(ResetCredit {
            id: id.into(),
            reset_type: reset_type.into(),
            status: status.into(),
            granted_at: starts_at,
            expires_at,
            title: Some(title.into()),
            description: grant["label"].as_str().map(str::to_owned),
        });
    }
    let expires_at = credits
        .iter()
        .filter(|credit| credit.status == "available")
        .filter_map(|credit| credit.expires_at)
        .min();
    Ok(Some(ResetTokens {
        available,
        expires_at,
        supported: true,
        credits: Some(credits),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_backoff_respects_retry_after_and_never_spins_on_zero() {
        let mut state = UsageBackoff::default();
        assert_eq!(state.remaining(1000), None);
        assert_eq!(state.defer(1000, 0), 60);
        assert_eq!(state.remaining(1001), Some(60));
        assert_eq!(state.remaining(61_000), None);
        assert_eq!(state.defer(61_000, 0), 120);
        assert_eq!(state.defer(181_000, 900), 900);
        assert_eq!(state.remaining(181_001), Some(900));
    }

    #[test]
    fn one_usage_response_contains_both_quota_and_reset_inventory() {
        let mut usage = inventory();
        usage["limits"] = json!([
            {"kind":"session", "percent":30},
            {"kind":"weekly_all", "percent":24},
            {"kind":"weekly_scoped", "percent":6, "scope":{"model":{"display_name":"Fable"}}}
        ]);
        let mut status = super::super::ProviderAccountStatus::empty("one", "claude-acp", now());
        super::super::claude::map_usage(&mut status, &usage);
        assert_eq!(status.limits.len(), 3);
        assert_eq!(status.limits[2].model_id.as_deref(), Some("fable"));
        assert_eq!(map_inventory(&usage, now()).unwrap().unwrap().available, 1);
    }

    fn inventory() -> Value {
        json!({"cedar_ember": {
            "eligible": true, "next_grant_id": "launch-grant", "cooldown_until": null,
            "grants": [{"id":"launch-grant", "label":"Launch allowance", "resets_left":1,
                "starts_at":"2026-09-22T16:00:00Z", "ends_at":"2026-10-22T16:00:00Z",
                "clears":["five_hour","seven_day","seven_day_overage_included"],
                "paused":false, "usable_now":true, "use_requires_limit":false}]
        }})
    }

    fn now() -> i64 {
        timestamp(&json!("2026-10-01T12:00:00Z")).unwrap()
    }

    #[test]
    fn available_launch_reset_is_reported_before_the_account_hits_a_limit() {
        let tokens = map_inventory(&inventory(), now()).unwrap().unwrap();
        assert_eq!(tokens.available, 1);
        assert!(tokens.supported);
        assert_eq!(tokens.expires_at, timestamp(&json!("2026-10-22T16:00:00Z")));
        let credit = &tokens.credits.unwrap()[0];
        assert_eq!(credit.id, "launch-grant");
        assert_eq!(credit.reset_type, "full");
        assert_eq!(credit.status, "available");
    }

    #[test]
    fn absent_inventory_is_unknown_and_explicit_empty_inventory_is_zero() {
        for input in [json!({}), json!({"cedar_ember":null})] {
            assert!(map_inventory(&input, now()).unwrap().is_none());
        }
        let empty = json!({"cedar_ember":{"eligible":false,"grants":[]}});
        assert_eq!(map_inventory(&empty, now()).unwrap().unwrap().available, 0);
        for input in [
            json!({"cedar_ember":{}}),
            json!({"cedar_ember":{"eligible":true}}),
        ] {
            assert!(map_inventory(&input, now()).is_err());
        }
    }

    #[test]
    fn eligibility_and_grant_lifecycle_control_which_reset_can_be_used() {
        for (field, value) in [
            ("paused", json!(true)),
            ("usable_now", json!(false)),
            ("resets_left", json!(0)),
            ("ends_at", json!("2026-09-30T00:00:00Z")),
            ("starts_at", json!("2026-10-02T00:00:00Z")),
        ] {
            let mut input = inventory();
            input["cedar_ember"]["grants"][0][field] = value;
            let tokens = map_inventory(&input, now()).unwrap().unwrap();
            assert_eq!(tokens.available, 0, "{field}");
            assert_ne!(tokens.credits.unwrap()[0].status, "available");
        }
        for (field, value) in [
            ("eligible", json!(false)),
            ("next_grant_id", json!("another-grant")),
            ("cooldown_until", json!("2026-10-01T13:00:00Z")),
        ] {
            let mut input = inventory();
            input["cedar_ember"][field] = value;
            assert_eq!(
                map_inventory(&input, now()).unwrap().unwrap().available,
                0,
                "{field}"
            );
        }
    }

    #[test]
    fn malformed_grants_never_become_spendable() {
        for (field, value) in [
            ("id", json!("../other")),
            ("resets_left", json!(-1)),
            ("usable_now", Value::Null),
            ("ends_at", json!("invalid")),
            ("clears", json!([])),
        ] {
            let mut input = inventory();
            input["cedar_ember"]["grants"][0][field] = value;
            assert!(map_inventory(&input, now()).is_err(), "{field}");
        }
    }

    #[test]
    fn five_hour_grants_and_provider_selected_grants_stay_distinct() {
        let mut input = inventory();
        let mut session = input["cedar_ember"]["grants"][0].clone();
        session["id"] = json!("session-grant");
        session["clears"] = json!(["five_hour"]);
        session["resets_left"] = json!(2);
        input["cedar_ember"]["grants"]
            .as_array_mut()
            .unwrap()
            .push(session);
        input["cedar_ember"]["next_grant_id"] = json!("session-grant");
        let tokens = map_inventory(&input, now()).unwrap().unwrap();
        assert_eq!(tokens.available, 2);
        let credits = tokens.credits.unwrap();
        assert_eq!(credits[0].status, "unavailable");
        assert_eq!(credits[1].reset_type, "five_hour");
        assert_eq!(credits[1].status, "available");
    }

    #[test]
    fn claims_preserve_the_selected_grant_and_idempotency_key() {
        let id = "e479d566-4be1-4f20-9ba7-56b21be9ace3";
        let body = claim_body("launch-grant", id).unwrap();
        assert_eq!(
            body,
            json!({"program":"cedar_ember","grant_id":"launch-grant","request_id":id})
        );
        assert_eq!(body, claim_body("launch-grant", id).unwrap());
        assert!(claim_body("launch-grant", "invalid").is_err());
        assert!(claim_body("../other", id).is_err());
        assert!(claim_body("", id).is_err());
    }

    #[test]
    fn only_confirmed_provider_outcomes_are_successful() {
        for (value, expected) in [
            ("reset", ResetOutcome::Reset),
            ("already_used", ResetOutcome::AlreadyRedeemed),
            ("not_limited", ResetOutcome::NothingToReset),
            ("ineligible", ResetOutcome::NoCredit),
        ] {
            assert_eq!(
                map_outcome(&json!({"result":value})).unwrap().outcome,
                expected
            );
        }
        for value in [
            "cooldown",
            "unavailable",
            "reset_unconfirmed",
            "future_value",
        ] {
            assert!(map_outcome(&json!({"result":value})).is_err());
        }
        assert!(map_outcome(&json!({})).is_err());
    }

    #[test]
    fn eligibility_uses_the_reported_cli_version_and_identifies_distill() {
        assert_eq!(
            user_agent(Some("2.1.280")).unwrap(),
            "claude-cli/2.1.280 (external, cli, client-app/distill)"
        );
        assert!(user_agent(None).is_err());
        assert!(user_agent(Some("2.1.280\r\nAuthorization: secret")).is_err());
    }

    #[tokio::test]
    async fn reset_http_errors_do_not_expose_provider_bodies_or_credentials() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 4096];
            let size = socket.read(&mut request).await.unwrap();
            let text = String::from_utf8_lossy(&request[..size]);
            assert!(text.starts_with("GET /usage "));
            assert!(text.contains("Bearer private-test-token"));
            socket.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 18\r\nConnection: close\r\n\r\nprivate-test-token").await.unwrap();
        });
        let client = Client {
            http: reqwest::Client::builder().no_proxy().build().unwrap(),
            token: "private-test-token".into(),
            organization: None,
        };
        let error = client
            .send(client.http.get(format!("http://{address}/usage")))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("401"));
        assert!(!error.to_string().contains("private-test-token"));
        server.await.unwrap();
    }
}
