//! Claude's native /limit-reset contract. Keep it separate from get_usage,
//! which strips reset grants. Only consume() sends a redemption request.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::{
    now_ms, timestamp, ResetBlock, ResetCredit, ResetCreditStatus, ResetKind, ResetOutcome,
    ResetResult, ResetTokens,
};
use crate::services::{flock_root, provider_accounts};
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

pub(super) fn clear_backoff(account_id: &str) {
    if let Some(backoff) = USAGE_BACKOFF.get() {
        backoff
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(account_id);
    }
}

/// Seconds left in this account's usage pause, if one is active.
pub(super) fn usage_backoff_remaining(account_id: &str, now: i64) -> Option<u64> {
    USAGE_BACKOFF
        .get()?
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(account_id)?
        .remaining(now)
}

/// A 429 extends the pause; only a successful read ends it early.
pub(super) fn record_usage_result(
    account_id: &str,
    now: i64,
    result: Result<Value, RequestError>,
) -> Result<Value, RequestError> {
    let mut backoff = USAGE_BACKOFF
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    match result {
        Err(RequestError::RateLimited(seconds)) => {
            let paused = backoff
                .entry(account_id.into())
                .or_default()
                .defer(now, seconds);
            log::warn!(
                "[account-status] the provider rate-limited the usage read of account {account_id} (Retry-After {seconds} s); usage reads pause for {paused} s"
            );
            Err(RequestError::RateLimited(paused))
        }
        Ok(usage) => {
            backoff.remove(account_id);
            Ok(usage)
        }
        error => error,
    }
}

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
        let root = flock_root::app_root(app)?;
        let home = provider_accounts::account_home(app, account)?;
        let read = |name: &str| -> Result<Value, String> {
            let path = home.join(name);
            flock_root::reject_document_links(&root, &path)?;
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
    if let Some(seconds) = usage_backoff_remaining(&account.id, now_ms()) {
        return Err(RequestError::RateLimited(seconds));
    }
    let client = Client::for_account(app, account, version)?;
    let result = client
        .send(client.http.get(format!("{ORIGIN}{USAGE_PATH}")))
        .await;
    let mut usage = record_usage_result(&account.id, now_ms(), result)?;
    // The usage reply leaves purchased credits out; the native CLI reads their
    // balance separately. A failed balance read only leaves it unknown.
    if let (Some(organization), Some(fields)) = (&client.organization, usage.as_object_mut()) {
        let request = client
            .http
            .get(format!(
                "{ORIGIN}/api/oauth/organizations/{organization}/prepaid/credits"
            ))
            .header("x-organization-uuid", organization);
        match client.send(request).await {
            Ok(credits) => {
                fields.insert(PREPAID_CREDITS.into(), credits);
            }
            Err(error) => log::warn!("Claude credit balance unavailable: {error}"),
        }
    }
    Ok(usage)
}

/// Where [`fetch_usage`] puts the purchased credit balance in its reply.
pub(super) const PREPAID_CREDITS: &str = "flock_prepaid_credits";

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
    // The provider's answer and reason are short codes; only those are logged.
    let [answer, reason] = ["result", "reason"].map(|field| {
        result[field]
            .as_str()
            .filter(|code| valid_grant_id(code))
            .unwrap_or("-")
    });
    log::info!(
        "[account-status] the provider answered the reset claim of account {}: {answer} (reason {reason})",
        account.id
    );
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
        // An answer, not a failure: a reset began on the account a moment
        // ago, which on a retried claim may be the earlier try itself.
        Some("cooldown") => ResetOutcome::Cooldown,
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

/// What a grant refills, named as the native CLI names it. A Fable reset
/// returns what Fable spent to the weekly allowance and clears nothing else,
/// though its `clears` list reads like a weekly one; the provider marks it
/// with `gives_back_weekly`. Otherwise the provider's own `type` decides, and
/// a reply without one is read from the windows the grant clears.
fn grant_kind(grant: &Value, clears: &[Value]) -> ResetKind {
    if grant["gives_back_weekly"].as_bool() == Some(true) {
        return ResetKind::Fable;
    }
    match grant["type"].as_str() {
        Some("full") => return ResetKind::Full,
        Some("session") => return ResetKind::FiveHour,
        Some("weekly") => return ResetKind::Weekly,
        _ => {}
    }
    let session = clears.iter().any(|kind| kind == "five_hour");
    let weekly = clears
        .iter()
        .any(|kind| kind.as_str().is_some_and(|s| s.starts_with("seven_day")));
    match (session, weekly) {
        (true, true) => ResetKind::Full,
        (true, false) => ResetKind::FiveHour,
        (false, true) => ResetKind::Weekly,
        (false, false) => ResetKind::Usage,
    }
}

/// Why a grant the provider will not take now is held back, read in the
/// native CLI's order: the provider's own reason, a cooldown, a limit the
/// grant does not refill, and last a grant kept for a limit not reached yet.
fn grant_block(
    grant: &Value,
    block: &Value,
    kind: ResetKind,
    clears: &[Value],
    on_cooldown: bool,
) -> Option<ResetBlock> {
    let fable = kind == ResetKind::Fable;
    match grant["unavailable_reason"].as_str() {
        Some("cooldown") => return Some(ResetBlock::Cooldown),
        // A Fable reset held by the weekly limit has no Fable usage to return.
        Some("blocked_seven_day") if fable => return Some(ResetBlock::NothingToReturn),
        Some(
            "blocked_five_hour" | "blocked_seven_day" | "blocked_opus" | "blocked_sonnet"
            | "blocked_other" | "cannot_clear",
        ) => return Some(ResetBlock::OtherLimit),
        Some("needs_limit") => return Some(ResetBlock::NeedsLimit),
        Some("unavailable") => return None,
        _ => {}
    }
    if on_cooldown {
        return Some(ResetBlock::Cooldown);
    }
    let blocking: Vec<&str> = windows(&grant["blocking"]).collect();
    if !blocking.is_empty() {
        return Some(if fable && blocking.contains(&"seven_day") {
            ResetBlock::NothingToReturn
        } else {
            ResetBlock::OtherLimit
        });
    }
    let refills =
        |window: &str| clears.iter().any(|kind| kind == window) || (fable && window == "seven_day");
    if block["at_limit"].as_bool() == Some(true) && !windows(&block["exhausted"]).any(refills) {
        return Some(ResetBlock::OtherLimit);
    }
    // The provider keeps a grant for a limit unless it says otherwise.
    (grant["use_requires_limit"].as_bool() != Some(false)).then_some(ResetBlock::NeedsLimit)
}

/// The usage windows a provider field lists by name.
fn windows(field: &Value) -> impl Iterator<Item = &str> {
    field
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

/// Leaves one usable grant of each kind to claim and queues the rest of the
/// kind behind it. The native CLI offers a reset of every kind at once, the
/// first usable grant of each; the grant the provider takes by default
/// (`next_grant_id`) goes first in its own kind and holds no other kind back.
fn queue_behind_first(credits: &mut [ResetCredit], next: Option<&str>) {
    let usable = |credit: &ResetCredit| credit.status == ResetCreditStatus::Available;
    let mut first: Vec<(ResetKind, String)> = Vec::new();
    for credit in credits.iter().filter(|credit| usable(credit)) {
        match first
            .iter_mut()
            .find(|(kind, _)| *kind == credit.reset_type)
        {
            Some((_, id)) if next == Some(credit.id.as_str()) => *id = credit.id.clone(),
            Some(_) => {}
            None => first.push((credit.reset_type, credit.id.clone())),
        }
    }
    for credit in credits.iter_mut().filter(|credit| usable(credit)) {
        if !first.iter().any(|(_, id)| *id == credit.id) {
            credit.status = ResetCreditStatus::Queued;
        }
    }
}

pub(super) fn map_inventory(usage: &Value, now: i64) -> Result<Option<ResetTokens>, String> {
    let block = &usage["cedar_ember"];
    if block.is_null() {
        return Ok(None);
    }
    let invalid = || "Claude returned an invalid reset inventory".to_string();
    let eligible = block["eligible"].as_bool().ok_or_else(invalid)?;
    let grants = block["grants"].as_array().ok_or_else(invalid)?;
    let on_cooldown = optional_time(&block["cooldown_until"])?.is_some_and(|at| at > now);
    let mut credits: Vec<ResetCredit> = Vec::new();
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
        let kind = grant_kind(grant, clears);
        let started = starts_at.is_none_or(|at| at <= now);
        let mut blocked = None;
        let status = if left == 0 {
            ResetCreditStatus::Used
        } else if expires_at.is_some_and(|at| at <= now) {
            ResetCreditStatus::Expired
        } else if paused {
            ResetCreditStatus::Paused
        } else if eligible && usable && started && !on_cooldown {
            available = available.checked_add(left).ok_or_else(invalid)?;
            ResetCreditStatus::Available
        } else {
            blocked = if !started {
                Some(ResetBlock::NotStarted)
            } else if !eligible {
                // The account, not the grant, is held back; no reason of the
                // grant's own applies.
                None
            } else {
                grant_block(grant, block, kind, clears, on_cooldown)
            };
            ResetCreditStatus::Unavailable
        };
        credits.push(ResetCredit {
            id: id.into(),
            reset_type: kind,
            status,
            uses_left: left,
            blocked,
            granted_at: starts_at,
            expires_at,
            title: None,
            description: grant["label"]
                .as_str()
                .filter(|label| !label.is_empty())
                .map(str::to_owned),
        });
    }
    queue_behind_first(&mut credits, block["next_grant_id"].as_str());
    let expires_at = credits
        .iter()
        .filter(|credit| credit.status == ResetCreditStatus::Available)
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
    fn clearing_a_usage_pause_affects_only_that_account() {
        let (cleared, kept) = ("backoff-clear-target", "backoff-clear-other");
        for id in [cleared, kept] {
            assert!(matches!(
                record_usage_result(id, 1000, Err(RequestError::RateLimited(2067))),
                Err(RequestError::RateLimited(2067))
            ));
        }
        clear_backoff(cleared);
        assert_eq!(usage_backoff_remaining(cleared, 1001), None);
        assert_eq!(usage_backoff_remaining(kept, 1001), Some(2067));
    }

    #[test]
    fn a_usage_pause_escalates_until_a_successful_read() {
        let id = "backoff-escalation";
        let limited = |now| record_usage_result(id, now, Err(RequestError::RateLimited(0)));
        assert!(matches!(limited(1000), Err(RequestError::RateLimited(60))));
        assert_eq!(usage_backoff_remaining(id, 31_000), Some(30));
        assert!(matches!(
            limited(61_000),
            Err(RequestError::RateLimited(120))
        ));
        assert!(record_usage_result(id, 200_000, Ok(json!({}))).is_ok());
        assert_eq!(usage_backoff_remaining(id, 200_001), None);
        assert!(matches!(
            limited(201_000),
            Err(RequestError::RateLimited(60))
        ));
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
        assert_eq!(credit.reset_type, ResetKind::Full);
        assert_eq!(credit.status, ResetCreditStatus::Available);
        assert_eq!(credit.uses_left, 1);
        assert_eq!(credit.description.as_deref(), Some("Launch allowance"));
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
            assert_ne!(
                tokens.credits.unwrap()[0].status,
                ResetCreditStatus::Available
            );
        }
        for (field, value) in [
            ("eligible", json!(false)),
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
        // The grant the provider would take by default is not a gate: the
        // native CLI offers a usable grant whether or not it is that one.
        for next in [json!("another-grant"), Value::Null] {
            let mut input = inventory();
            input["cedar_ember"]["next_grant_id"] = next;
            let tokens = map_inventory(&input, now()).unwrap().unwrap();
            assert_eq!(tokens.available, 1);
            assert_eq!(
                tokens.credits.unwrap()[0].status,
                ResetCreditStatus::Available
            );
        }
    }

    #[test]
    fn a_held_grant_says_why_in_the_native_clis_order() {
        let held = |change: &dyn Fn(&mut Value)| {
            let mut input = inventory();
            input["cedar_ember"]["grants"][0]["usable_now"] = json!(false);
            change(&mut input["cedar_ember"]);
            let credits = map_inventory(&input, now())
                .unwrap()
                .unwrap()
                .credits
                .unwrap();
            assert_eq!(credits[0].status, ResetCreditStatus::Unavailable);
            credits[0].blocked
        };
        let grant = |field: &'static str, value: Value| {
            move |block: &mut Value| block["grants"][0][field] = value.clone()
        };
        // With no reason given, the grant's own terms decide.
        assert_eq!(held(&|_| {}), None);
        assert_eq!(
            held(&grant("use_requires_limit", json!(true))),
            Some(ResetBlock::NeedsLimit)
        );
        for (reason, expected) in [
            ("needs_limit", Some(ResetBlock::NeedsLimit)),
            ("cooldown", Some(ResetBlock::Cooldown)),
            ("blocked_five_hour", Some(ResetBlock::OtherLimit)),
            ("blocked_seven_day", Some(ResetBlock::OtherLimit)),
            ("cannot_clear", Some(ResetBlock::OtherLimit)),
            ("unavailable", None),
        ] {
            assert_eq!(
                held(&grant("unavailable_reason", json!(reason))),
                expected,
                "{reason}"
            );
        }
        // A Fable reset held by the weekly limit has nothing to give back.
        assert_eq!(
            held(&|block| {
                block["grants"][0]["gives_back_weekly"] = json!(true);
                block["grants"][0]["unavailable_reason"] = json!("blocked_seven_day");
            }),
            Some(ResetBlock::NothingToReturn)
        );
        // A reason this build does not know falls back to what the reply shows.
        assert_eq!(
            held(&|block| {
                block["grants"][0]["unavailable_reason"] = json!("later_reason");
                block["grants"][0]["blocking"] = json!(["seven_day_opus"]);
            }),
            Some(ResetBlock::OtherLimit)
        );
        assert_eq!(
            held(&|block| {
                block["at_limit"] = json!(true);
                block["exhausted"] = json!(["seven_day_opus"]);
            }),
            Some(ResetBlock::OtherLimit)
        );
        assert_eq!(
            held(&|block| {
                block["at_limit"] = json!(true);
                block["exhausted"] = json!(["five_hour"]);
            }),
            None
        );
        assert_eq!(
            held(&|block| block["cooldown_until"] = json!("2026-10-01T13:00:00Z")),
            Some(ResetBlock::Cooldown)
        );
        assert_eq!(
            held(&grant("starts_at", json!("2026-10-02T00:00:00Z"))),
            Some(ResetBlock::NotStarted)
        );
        // An account the provider holds back gives its grants no reason of
        // their own.
        assert_eq!(
            held(&|block| {
                block["eligible"] = json!(false);
                block["grants"][0]["use_requires_limit"] = json!(true);
            }),
            None
        );
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
    fn one_grant_of_each_kind_can_be_claimed_whichever_the_provider_takes_first() {
        let mut input = inventory();
        let mut session = input["cedar_ember"]["grants"][0].clone();
        session["id"] = json!("session-grant");
        session["clears"] = json!(["five_hour"]);
        session["resets_left"] = json!(2);
        input["cedar_ember"]["grants"]
            .as_array_mut()
            .unwrap()
            .push(session);
        for next in [json!("session-grant"), json!("launch-grant"), Value::Null] {
            input["cedar_ember"]["next_grant_id"] = next;
            let tokens = map_inventory(&input, now()).unwrap().unwrap();
            assert_eq!(tokens.available, 3);
            let credits = tokens.credits.unwrap();
            assert_eq!(credits[0].reset_type, ResetKind::Full);
            assert_eq!(credits[1].reset_type, ResetKind::FiveHour);
            assert_eq!(credits[1].uses_left, 2);
            assert!(credits
                .iter()
                .all(|credit| credit.status == ResetCreditStatus::Available));
        }
    }

    /// The shape of a launch gift: the provider types a Fable reset "full"
    /// and lists only Fable's window; `gives_back_weekly` is what tells it
    /// from a reset of the whole account.
    fn fable_gift(id: &str) -> Value {
        json!({"id": id, "label": "Launch gift", "resets_total": 1, "resets_left": 1,
            "starts_at": "2026-09-22T16:00:00+00:00", "ends_at": "2026-12-22T07:59:00+00:00",
            "clears": ["seven_day_overage_included"], "paused": false, "usable_now": true,
            "use_requires_limit": false, "blocking": [], "type": "full",
            "unavailable_reason": null, "gives_back_weekly": true})
    }

    fn weekly_gift(id: &str, left: u64) -> Value {
        json!({"id": id, "label": "Earlier gift", "resets_total": 1, "resets_left": left,
            "starts_at": "2026-09-01T00:00:00+00:00", "ends_at": "2026-12-01T00:00:00+00:00",
            "clears": ["seven_day", "seven_day_overage_included"], "paused": false,
            "usable_now": left > 0, "type": "weekly", "gives_back_weekly": false})
    }

    fn shown(usage: &Value) -> (u64, Vec<(ResetKind, ResetCreditStatus)>) {
        let tokens = map_inventory(usage, now()).unwrap().unwrap();
        let credits = tokens.credits.unwrap();
        (
            tokens.available,
            credits
                .iter()
                .map(|credit| (credit.reset_type, credit.status))
                .collect(),
        )
    }

    #[test]
    fn two_fable_resets_and_a_used_weekly_one_read_as_the_provider_sends_them() {
        let mut usage = json!({"cedar_ember": {
            "eligible": true, "at_limit": false, "next_grant_id": "gift-fable",
            "cooldown_until": null,
            "grants": [
                weekly_gift("earlier-weekly", 0),
                fable_gift("gift-fable"),
                fable_gift("gift-fable-second"),
            ]
        }});
        let first_then_second = (
            2,
            vec![
                (ResetKind::Weekly, ResetCreditStatus::Used),
                (ResetKind::Fable, ResetCreditStatus::Available),
                // The same kind again: it waits for the first.
                (ResetKind::Fable, ResetCreditStatus::Queued),
            ],
        );
        assert_eq!(shown(&usage), first_then_second);
        // With no grant named, the first usable one of the kind goes first.
        usage["cedar_ember"]["next_grant_id"] = Value::Null;
        assert_eq!(shown(&usage), first_then_second);
        // The grant the provider takes by default goes first in its kind.
        usage["cedar_ember"]["next_grant_id"] = json!("gift-fable-second");
        assert_eq!(
            shown(&usage).1[1..],
            [
                (ResetKind::Fable, ResetCreditStatus::Queued),
                (ResetKind::Fable, ResetCreditStatus::Available),
            ]
        );
    }

    #[test]
    fn a_fable_reset_can_be_claimed_beside_the_weekly_one_the_provider_takes_first() {
        // An account at its weekly limit with a weekly and two Fable resets:
        // the provider names the weekly one, and the native CLI still offers
        // the choice between a weekly and a Fable reset.
        let usage = json!({"cedar_ember": {
            "eligible": true, "at_limit": true, "exhausted": ["seven_day"],
            "next_grant_id": "gift-weekly", "cooldown_until": null,
            "grants": [
                weekly_gift("gift-weekly", 1),
                weekly_gift("earlier-weekly", 0),
                fable_gift("gift-fable"),
                fable_gift("gift-fable-second"),
            ]
        }});
        assert_eq!(
            shown(&usage),
            (
                3,
                vec![
                    (ResetKind::Weekly, ResetCreditStatus::Available),
                    (ResetKind::Weekly, ResetCreditStatus::Used),
                    (ResetKind::Fable, ResetCreditStatus::Available),
                    (ResetKind::Fable, ResetCreditStatus::Queued),
                ]
            )
        );
    }

    #[test]
    fn a_fable_reset_is_not_a_full_reset() {
        let kind = |change: &dyn Fn(&mut Value)| {
            let mut input = inventory();
            change(&mut input["cedar_ember"]["grants"][0]);
            let credits = map_inventory(&input, now())
                .unwrap()
                .unwrap()
                .credits
                .unwrap();
            // The kind names the reset; no provider title stands in for it.
            assert_eq!(credits[0].title, None);
            credits[0].reset_type
        };
        // The same windows as a full grant, yet it only returns Fable's share.
        assert_eq!(
            kind(&|grant| grant["gives_back_weekly"] = json!(true)),
            ResetKind::Fable
        );
        assert_eq!(
            kind(&|grant| {
                grant["gives_back_weekly"] = json!(true);
                grant["type"] = json!("full");
                grant["clears"] = json!(["seven_day_overage_included"]);
            }),
            ResetKind::Fable
        );
        assert_eq!(
            kind(&|grant| grant["gives_back_weekly"] = json!(false)),
            ResetKind::Full
        );
        // The provider's own type wins over what the windows suggest.
        assert_eq!(
            kind(&|grant| grant["type"] = json!("weekly")),
            ResetKind::Weekly
        );
        assert_eq!(
            kind(&|grant| grant["type"] = json!("session")),
            ResetKind::FiveHour
        );
        assert_eq!(
            kind(&|grant| grant["type"] = json!("later_kind")),
            ResetKind::Full
        );
        assert_eq!(
            kind(&|grant| grant["clears"] = json!(["seven_day", "seven_day_opus"])),
            ResetKind::Weekly
        );
        assert_eq!(
            kind(&|grant| grant["clears"] = json!(["later_window"])),
            ResetKind::Usage
        );
    }

    #[test]
    fn reset_credits_reach_the_renderer_in_one_vocabulary() {
        let usage = json!({"cedar_ember": {
            "eligible": true, "next_grant_id": null, "cooldown_until": null,
            "grants": [fable_gift("gift-fable")]
        }});
        let tokens = map_inventory(&usage, now()).unwrap().unwrap();
        let credit = serde_json::to_value(&tokens.credits.unwrap()[0]).unwrap();
        assert_eq!(credit["resetType"], "fable");
        assert_eq!(credit["status"], "available");
        assert_eq!(credit["usesLeft"], 1);
        assert!(credit.get("blocked").is_none());
        assert_eq!(
            serde_json::to_value(ResetKind::FiveHour).unwrap(),
            "five_hour"
        );
        assert_eq!(
            serde_json::to_value(ResetBlock::NothingToReturn).unwrap(),
            "nothing_to_return"
        );
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
            ("cooldown", ResetOutcome::Cooldown),
        ] {
            assert_eq!(
                map_outcome(&json!({"result":value})).unwrap().outcome,
                expected
            );
        }
        for value in ["unavailable", "reset_unconfirmed", "future_value"] {
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
