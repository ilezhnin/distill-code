use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::types::{AgentPlatformId, ProviderRateLimitStatus, ProviderRateLimits};
use super::windows::{
    parse_reset_timestamp, usage_window, MONTHLY_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES,
};
use super::{home_dir, now_ms, result};

const GROK_CLI_PROXY_BASE: &str = "https://cli-chat-proxy.grok.com/v1";
const GROK_CLI_AUTH_HEADER: &str = "xai-grok-cli";
const PREFERRED_GROK_AUTH_ISSUER: &str = "https://auth.x.ai";
const TOKEN_SKEW_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrokAuthSession {
    pub access_token: String,
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrokAuthReadResult {
    Missing,
    Error(String),
    Ok(GrokAuthSession),
}

pub fn grok_home() -> PathBuf {
    if let Some(override_dir) = crate::services::shell_env::user_env_var("GROK_HOME") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".grok")
}

pub fn grok_auth_path() -> PathBuf {
    grok_home().join("auth.json")
}

pub fn is_grok_access_token_fresh(session: &GrokAuthSession) -> bool {
    match session.expires_at_ms {
        None => true,
        Some(expires_at_ms) => expires_at_ms - now_ms() > TOKEN_SKEW_MS,
    }
}

pub fn read_grok_auth_session() -> GrokAuthReadResult {
    read_grok_auth_session_at(&grok_auth_path())
}

pub fn read_grok_auth_session_at(path: &Path) -> GrokAuthReadResult {
    let Ok(raw) = fs::read_to_string(path) else {
        return GrokAuthReadResult::Missing;
    };
    parse_grok_auth_session(&raw)
}

/// How long a Grok session handed to a benchmark process must stay valid at
/// least, whatever the turn: longer than the default ten-minute attempt
/// timeout. That process cannot refresh it; a benchmark bridge whose session
/// comes too close to expiry is replaced before its next session. A turn that
/// outlives the session would fail at sign-in rather than produce a result,
/// so a longer turn needs a longer margin (see
/// [`benchmark_sign_in_margin_ms`]).
pub const BENCHMARK_SIGN_IN_MARGIN_MS: i64 = 15 * 60 * 1000;

/// What a turn needs beyond its own time limit: opening its session, and the
/// wait for a cancellation to be confirmed when the limit is reached.
const BENCHMARK_SIGN_IN_SLACK_MS: i64 = 5 * 60 * 1000;

/// How long the session must stay valid for a benchmark turn that may run
/// `turn_limit_ms`: the turn and its slack, and never less than
/// [`BENCHMARK_SIGN_IN_MARGIN_MS`].
pub fn benchmark_sign_in_margin_ms(turn_limit_ms: u64) -> i64 {
    i64::try_from(turn_limit_ms)
        .unwrap_or(i64::MAX)
        .saturating_add(BENCHMARK_SIGN_IN_SLACK_MS)
        .max(BENCHMARK_SIGN_IN_MARGIN_MS)
}

/// The user's Grok sign-in as a benchmark process may use it: the auth
/// document reduced to the fields a session runs on (see
/// [`benchmark_sign_in_document`]), and when the session Grok picks from it
/// expires. Without a refresh token that process can use the session but
/// never rotate it, so the user's own Grok keeps the only refreshable copy.
/// `None` when there is no session (Grok then signs in with `XAI_API_KEY`, if
/// the user has one). Read into memory; nothing is written.
pub fn benchmark_auth_document() -> Result<Option<(String, Option<i64>)>, String> {
    match fs::read_to_string(grok_auth_path()) {
        Ok(raw) => benchmark_auth_from(&raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Grok auth file cannot be read".into()),
    }
}

fn benchmark_auth_from(raw: &str) -> Result<Option<(String, Option<i64>)>, String> {
    match parse_grok_auth_session(raw) {
        GrokAuthReadResult::Missing => Ok(None),
        GrokAuthReadResult::Error(error) => Err(error),
        GrokAuthReadResult::Ok(session) => Ok(Some((
            benchmark_sign_in_document(raw)?,
            session.expires_at_ms,
        ))),
    }
}

/// Whether a session expiring at `expires_at_ms` is too close to expiry, at
/// `now`, for a benchmark process to start or run a turn of up to
/// `turn_limit_ms` on it.
pub fn benchmark_sign_in_expiring(
    expires_at_ms: Option<i64>,
    now: i64,
    turn_limit_ms: u64,
) -> bool {
    expires_at_ms.is_some_and(|expires| expires - now < benchmark_sign_in_margin_ms(turn_limit_ms))
}

/// When the user's Grok sign-in expires, read the way
/// [`benchmark_auth_document`] reads the session, and nothing else of it.
/// `None` without a session or without an expiry.
pub fn benchmark_sign_in_expiry() -> Result<Option<i64>, String> {
    match fs::read_to_string(grok_auth_path()) {
        Ok(raw) => match parse_grok_auth_session(&raw) {
            GrokAuthReadResult::Missing => Ok(None),
            GrokAuthReadResult::Error(error) => Err(error),
            GrokAuthReadResult::Ok(session) => Ok(session.expires_at_ms),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Grok auth file cannot be read".into()),
    }
}

/// How long before expiry the Grok CLI renews a sign-in by default:
/// `GROK_AUTH_EARLY_INVALIDATION_SECS` unset is 300 seconds.
const GROK_CLI_RENEWAL_WINDOW_MS: i64 = 5 * 60 * 1000;

/// How far into the CLI's renewal window a waiting run starts again, so the
/// CLI already counts the sign-in as due when the run lists its models.
const RENEWAL_WINDOW_SLACK_MS: i64 = 30 * 1000;

/// How long before expiry the Grok CLI the user's chats run renews its
/// sign-in: from then on it counts the session as expired and renews it, in
/// its own home with its own refresh token, before any request it makes
/// (the pinned 1.0.40 logs "oidc refresh enter" with reason `PreRequest`).
/// `GROK_AUTH_EARLY_INVALIDATION_SECS` as the user's environment sets it,
/// else Grok's default.
pub fn cli_renewal_window_ms() -> i64 {
    crate::services::shell_env::user_env_var("GROK_AUTH_EARLY_INVALIDATION_SECS")
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|seconds| *seconds >= 0)
        .map_or(GROK_CLI_RENEWAL_WINDOW_MS, |seconds| {
            seconds.saturating_mul(1000)
        })
}

/// What a benchmark turn of up to `turn_limit_ms` needs, at `now`, of a
/// sign-in that expires at `expires_at_ms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BenchmarkSignIn {
    /// It outlasts the turn, or there is no session to outlast it.
    Ready,
    /// The CLI counts it as due: any request the CLI makes renews it first,
    /// so one model listing on the user's chat bridge renews it.
    Renew,
    /// Nothing the CLI does renews it before this time, inside its renewal
    /// window.
    WaitUntil(i64),
}

/// See [`BenchmarkSignIn`]; `renewal_window_ms` is
/// [`cli_renewal_window_ms`].
pub fn benchmark_sign_in_step(
    expires_at_ms: Option<i64>,
    now: i64,
    turn_limit_ms: u64,
    renewal_window_ms: i64,
) -> BenchmarkSignIn {
    let Some(expires) = expires_at_ms else {
        return BenchmarkSignIn::Ready;
    };
    if !benchmark_sign_in_expiring(Some(expires), now, turn_limit_ms) {
        return BenchmarkSignIn::Ready;
    }
    let renews_from = expires.saturating_sub(renewal_window_ms);
    if now >= renews_from {
        BenchmarkSignIn::Renew
    } else {
        BenchmarkSignIn::WaitUntil(renews_from.saturating_add(RENEWAL_WINDOW_SLACK_MS))
    }
}

/// The fields of a sign-in entry a benchmark process gets: the access token
/// (`key`), how and when it was issued, when it expires and whose it is. The
/// pinned Grok runs a session on exactly these (the policy probe signs in
/// with nothing else).
const BENCHMARK_SIGN_IN_FIELDS: &[&str] = &[
    "key",
    "auth_mode",
    "create_time",
    "expires_at",
    "user_id",
    "email",
];

/// The auth document `raw` with each sign-in entry reduced to
/// [`BENCHMARK_SIGN_IN_FIELDS`] holding plain values. Everything else stays
/// with the user's own Grok: refresh, ID and other session tokens under any
/// name, nested objects, and anything that is not an entry.
pub fn benchmark_sign_in_document(raw: &str) -> Result<String, String> {
    let invalid = || "Grok auth file is invalid".to_string();
    let document: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
    let entries = document.as_object().ok_or_else(invalid)?;
    let kept: serde_json::Map<String, Value> = entries
        .iter()
        .filter_map(|(issuer, entry)| {
            let fields = entry
                .as_object()?
                .iter()
                .filter(|(field, value)| {
                    BENCHMARK_SIGN_IN_FIELDS.contains(&field.as_str())
                        && !value.is_object()
                        && !value.is_array()
                })
                .map(|(field, value)| (field.clone(), value.clone()))
                .collect();
            Some((issuer.clone(), Value::Object(fields)))
        })
        .collect();
    serde_json::to_string(&Value::Object(kept)).map_err(|error| error.to_string())
}

/// Whether the auth file holds a session Grok will accept without signing in
/// again. The Grok agent check decides from this with the same issuer
/// preference and freshness rule the usage fetch applies, so the provider card
/// and the usage roster agree about a sign-in.
pub fn has_fresh_grok_sign_in(auth: &GrokAuthReadResult) -> bool {
    matches!(auth, GrokAuthReadResult::Ok(session) if is_grok_access_token_fresh(session))
}

pub fn parse_grok_auth_session(raw: &str) -> GrokAuthReadResult {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return GrokAuthReadResult::Error("Grok auth file is invalid".into()),
    };
    let Some(object) = parsed.as_object() else {
        return GrokAuthReadResult::Error("Grok auth file is invalid".into());
    };

    let mut preferred_key_seen = false;
    let mut expired_preferred: Option<GrokAuthSession> = None;
    let mut fallback: Option<GrokAuthSession> = None;

    for (key, entry) in object {
        let is_preferred = key == PREFERRED_GROK_AUTH_ISSUER
            || key.starts_with(&format!("{PREFERRED_GROK_AUTH_ISSUER}::"));
        preferred_key_seen |= is_preferred;
        let Some(session) = session_from_auth_entry(entry) else {
            continue;
        };
        if is_preferred {
            if is_grok_access_token_fresh(&session) {
                return GrokAuthReadResult::Ok(session);
            }
            if expired_preferred.is_none() {
                expired_preferred = Some(session);
            }
            continue;
        }
        if fallback.is_none() {
            fallback = Some(session);
        }
    }

    if let Some(session) = expired_preferred.or(if preferred_key_seen { None } else { fallback }) {
        return GrokAuthReadResult::Ok(session);
    }
    GrokAuthReadResult::Missing
}

fn session_from_auth_entry(value: &Value) -> Option<GrokAuthSession> {
    let access_token = value.get("key").and_then(Value::as_str)?.trim();
    if access_token.is_empty() {
        return None;
    }
    let expires_at_ms = value.get("expires_at").and_then(parse_reset_timestamp);
    Some(GrokAuthSession {
        access_token: access_token.to_string(),
        user_id: value
            .get("user_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        email: value
            .get("email")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        expires_at_ms,
    })
}

fn money_val(value: Option<&Value>) -> Option<f64> {
    let raw = value?.get("val")?;
    match raw {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

fn timestamps_match(left: Option<&str>, right: Option<&str>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            parse_reset_timestamp(&Value::String(left.to_string()))
                == parse_reset_timestamp(&Value::String(right.to_string()))
        }
        _ => false,
    }
}

fn billing_config(data: &Value) -> Option<&Value> {
    data.get("config").or_else(|| {
        if data.get("creditUsagePercent").is_some() || data.get("monthlyLimit").is_some() {
            Some(data)
        } else {
            None
        }
    })
}

fn map_weekly_credits(config: &Value) -> Option<super::types::RateLimitWindow> {
    let period = config.get("currentPeriod");
    let period_type = period
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str);
    let confirmed_weekly = period_type == Some("USAGE_PERIOD_TYPE_WEEKLY")
        && timestamps_match(
            period
                .and_then(|value| value.get("start"))
                .and_then(Value::as_str),
            config.get("billingPeriodStart").and_then(Value::as_str),
        )
        && timestamps_match(
            period
                .and_then(|value| value.get("end"))
                .and_then(Value::as_str),
            config.get("billingPeriodEnd").and_then(Value::as_str),
        );
    let used_percent = match config.get("creditUsagePercent").and_then(Value::as_f64) {
        Some(value) => Some(value),
        None if confirmed_weekly => Some(0.0),
        None => None,
    };
    let period_end = period
        .and_then(|value| value.get("end"))
        .or_else(|| config.get("billingPeriodEnd"));
    usage_window(
        used_percent,
        WEEKLY_WINDOW_MINUTES,
        period_end.and_then(parse_reset_timestamp),
    )
}

fn map_monthly_usage(config: &Value) -> Option<super::types::RateLimitWindow> {
    let limit = money_val(config.get("monthlyLimit"))?;
    let used = money_val(config.get("used"))?;
    if limit <= 0.0 {
        return None;
    }
    let period_end = config
        .get("currentPeriod")
        .and_then(|value| value.get("end"))
        .or_else(|| config.get("billingPeriodEnd"));
    usage_window(
        Some((used / limit) * 100.0),
        MONTHLY_WINDOW_MINUTES,
        period_end.and_then(parse_reset_timestamp),
    )
}

fn apply_session_headers(
    request: reqwest::RequestBuilder,
    session: &GrokAuthSession,
) -> reqwest::RequestBuilder {
    let mut request = request
        .header("Authorization", format!("Bearer {}", session.access_token))
        .header("X-XAI-Token-Auth", GROK_CLI_AUTH_HEADER)
        .header("Accept", "application/json");
    if let Some(user_id) = &session.user_id {
        request = request.header("x-userid", user_id);
    }
    request
}

fn billing_base() -> String {
    std::env::var("GROK_CLI_CHAT_PROXY_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| GROK_CLI_PROXY_BASE.to_string())
}

async fn fetch_billing_json(
    client: &reqwest::Client,
    url: &str,
    session: &GrokAuthSession,
) -> Result<Value, ProviderRateLimits> {
    let response = apply_session_headers(client.get(url), session)
        .send()
        .await
        .map_err(|error| {
            grok_error(session, format!("Grok usage request failed: {error}"), true)
        })?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(super::unauthorized_from_response(
            AgentPlatformId::Grok,
            "Grok",
            status,
            response,
            session.email.clone(),
        )
        .await);
    }
    if !status.is_success() {
        return Err(grok_error(
            session,
            format!("Grok usage request failed (HTTP {status})"),
            true,
        ));
    }
    response.json().await.map_err(|error| {
        grok_error(
            session,
            format!("Grok usage response was invalid: {error}"),
            true,
        )
    })
}

fn grok_error(session: &GrokAuthSession, error: String, configured: bool) -> ProviderRateLimits {
    ProviderRateLimits {
        configured,
        account_label: session.email.clone(),
        ..result(
            AgentPlatformId::Grok,
            ProviderRateLimitStatus::Error,
            Some(error),
        )
    }
}

/// An expired sign-in is a sign-in, not a failed refresh: `configured: false`
/// is what the roster reads as "offer Sign in". It stays an `Error` rather than
/// the `Unavailable` a missing login returns, because the status bar hides an
/// unavailable, unconfigured provider — and this account needs its Sign in row.
fn expired_sign_in_result(session: &GrokAuthSession) -> ProviderRateLimits {
    ProviderRateLimits {
        account_label: session.email.clone(),
        ..result(
            AgentPlatformId::Grok,
            ProviderRateLimitStatus::Error,
            Some("Grok sign-in expired — sign in to Grok again".to_string()),
        )
    }
}

fn billing_usage_result(
    session: &GrokAuthSession,
    weekly: Option<super::types::RateLimitWindow>,
    monthly: Option<super::types::RateLimitWindow>,
    config: &Value,
) -> ProviderRateLimits {
    let tier = config
        .get("subscriptionTier")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let account = session
        .email
        .clone()
        .or_else(|| session.user_id.clone())
        .unwrap_or_else(|| "Grok account".to_string());
    ProviderRateLimits {
        provider: AgentPlatformId::Grok,
        session: None,
        weekly,
        fable_weekly: None,
        monthly,
        coding_monthly: None,
        plan_type: tier.map(ToOwned::to_owned),
        account_label: Some(account),
        credits: None,
        updated_at: now_ms(),
        error: None,
        status: ProviderRateLimitStatus::Ok,
        configured: true,
    }
}

pub async fn fetch_grok_rate_limits(client: &reqwest::Client) -> ProviderRateLimits {
    match read_grok_auth_session() {
        GrokAuthReadResult::Missing => result(
            AgentPlatformId::Grok,
            ProviderRateLimitStatus::Unavailable,
            Some("Not signed in to Grok — run grok login".to_string()),
        ),
        GrokAuthReadResult::Error(error) => result(
            AgentPlatformId::Grok,
            ProviderRateLimitStatus::Error,
            Some(error),
        ),
        GrokAuthReadResult::Ok(session) => {
            if !is_grok_access_token_fresh(&session) {
                return expired_sign_in_result(&session);
            }
            let base = billing_base();
            let credits_url = format!("{base}/billing?format=credits");
            let default_url = format!("{base}/billing");
            let credits = match fetch_billing_json(client, &credits_url, &session).await {
                Ok(value) => value,
                Err(error) => return error,
            };
            let Some(config) = billing_config(&credits).cloned() else {
                return ProviderRateLimits {
                    configured: true,
                    account_label: session.email.clone(),
                    ..result(
                        AgentPlatformId::Grok,
                        ProviderRateLimitStatus::Unavailable,
                        Some("Grok billing response did not include config".to_string()),
                    )
                };
            };
            if let Some(weekly) = map_weekly_credits(&config) {
                return billing_usage_result(&session, Some(weekly), None, &config);
            }
            let fallback = match fetch_billing_json(client, &default_url, &session).await {
                Ok(value) => value,
                Err(error) => return error,
            };
            let monthly_config = billing_config(&fallback).unwrap_or(&fallback);
            if let Some(monthly) = map_monthly_usage(monthly_config) {
                return billing_usage_result(&session, None, Some(monthly), &config);
            }
            ProviderRateLimits {
                configured: true,
                account_label: session.email.clone(),
                ..result(
                    AgentPlatformId::Grok,
                    ProviderRateLimitStatus::Unavailable,
                    Some("Grok billing response did not include credit usage".to_string()),
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(expires_at_ms: Option<i64>) -> GrokAuthSession {
        GrokAuthSession {
            access_token: "test-access-token".to_string(),
            user_id: None,
            email: Some("dev@example.com".to_string()),
            expires_at_ms,
        }
    }

    #[test]
    fn expired_sign_in_is_reported_as_a_sign_in_not_a_failed_refresh() {
        // The roster offers Sign in for an error with no usage windows that is
        // not configured; a configured error reads as "Refresh failed".
        let expired = expired_sign_in_result(&session(Some(now_ms() - 60_000)));
        assert!(matches!(expired.status, ProviderRateLimitStatus::Error));
        assert!(!expired.configured);
        assert!(expired.session.is_none() && expired.weekly.is_none() && expired.monthly.is_none());
        assert_eq!(expired.account_label.as_deref(), Some("dev@example.com"));
        assert!(!expired
            .error
            .unwrap_or_default()
            .contains("test-access-token"));
    }

    #[test]
    fn grok_auth_document_drops_refresh_tokens() {
        let raw = r#"{
            "https://auth.x.ai::scope": {
                "key": "fabricated-access",
                "auth_mode": "oidc",
                "create_time": "2026-10-01T00:00:00Z",
                "user_id": "fabricated-user",
                "refresh_token": "fabricated-refresh",
                "id_token": "fabricated-id-token",
                "session_token": "fabricated-session-token",
                "access_token": "fabricated-second-access",
                "email": "dev@example.com",
                "expires_at": "2030-01-01T00:00:00Z",
                "source": {"refreshToken": "nested-refresh", "issuer": "https://auth.x.ai"},
                "history": [{"refresh_token": "listed-refresh", "kept": 1}]
            },
            "version": 2
        }"#;
        let stripped = benchmark_sign_in_document(raw).unwrap();
        // Only the fields a session runs on are handed over: no other token
        // under any name, and nothing nested.
        for gone in [
            "refresh",
            "id-token",
            "session-token",
            "second-access",
            "source",
            "history",
            "version",
        ] {
            assert!(!stripped.contains(gone), "{gone}: {stripped}");
        }
        let document: Value = serde_json::from_str(&stripped).unwrap();
        let entry = document["https://auth.x.ai::scope"].as_object().unwrap();
        let mut fields: Vec<&str> = entry.keys().map(String::as_str).collect();
        fields.sort_unstable();
        assert_eq!(
            fields,
            [
                "auth_mode",
                "create_time",
                "email",
                "expires_at",
                "key",
                "user_id"
            ]
        );
        assert_eq!(entry["key"], "fabricated-access");
        assert_eq!(entry["email"], "dev@example.com");
        assert!(benchmark_sign_in_document("not json").is_err());
        assert!(benchmark_sign_in_document("[]").is_err());

        // The session Grok would use, with its expiry; no session is not an
        // error, an unreadable document is.
        let (document, expires) = benchmark_auth_from(raw).unwrap().unwrap();
        assert_eq!(document, stripped);
        assert_eq!(
            expires,
            parse_reset_timestamp(&Value::String("2030-01-01T00:00:00Z".into()))
        );
        assert_eq!(benchmark_auth_from("{}").unwrap(), None);
        assert!(benchmark_auth_from("[").is_err());
    }

    #[test]
    fn a_benchmark_sign_in_must_outlive_the_margin() {
        let now = 1_000_000_000;
        let ten_minutes = 10 * 60 * 1000;
        assert!(!benchmark_sign_in_expiring(None, now, ten_minutes));
        assert!(!benchmark_sign_in_expiring(
            Some(now + BENCHMARK_SIGN_IN_MARGIN_MS),
            now,
            ten_minutes
        ));
        assert!(benchmark_sign_in_expiring(
            Some(now + BENCHMARK_SIGN_IN_MARGIN_MS - 1),
            now,
            ten_minutes
        ));
        assert!(benchmark_sign_in_expiring(Some(now - 1), now, 0));
    }

    /// A run may allow an hour per turn; the sign-in must outlast the whole
    /// turn and the time to open and cancel it, not just the default margin.
    #[test]
    fn a_long_turn_needs_its_whole_limit_and_slack_left_on_the_sign_in() {
        let hour = 60 * 60 * 1000;
        let slack = BENCHMARK_SIGN_IN_SLACK_MS;
        assert_eq!(benchmark_sign_in_margin_ms(0), BENCHMARK_SIGN_IN_MARGIN_MS);
        assert_eq!(benchmark_sign_in_margin_ms(hour), hour as i64 + slack);
        assert_eq!(benchmark_sign_in_margin_ms(u64::MAX), i64::MAX);
        let now = 1_000_000_000;
        // Thirty minutes left is enough for a ten-minute turn, not an hour.
        let expires = Some(now + 30 * 60 * 1000);
        assert!(!benchmark_sign_in_expiring(expires, now, 10 * 60 * 1000));
        assert!(benchmark_sign_in_expiring(expires, now, hour));
        assert!(!benchmark_sign_in_expiring(
            Some(now + hour as i64 + slack),
            now,
            hour
        ));
    }

    /// The Grok CLI renews a sign-in before any request once it is within
    /// its renewal window (five minutes by default), never earlier, while a
    /// benchmark turn needs fifteen minutes or more left. Measured on the
    /// pinned 1.0.40 against a loopback stub: a sign-in ten minutes from
    /// expiry was used as it was through a start and a session; three minutes
    /// from expiry, every request renewed it first.
    #[test]
    fn a_sign_in_is_renewed_inside_the_cli_window_and_waited_for_before_it() {
        let now = 1_000_000_000;
        let minute = 60 * 1000;
        let window = GROK_CLI_RENEWAL_WINDOW_MS;
        let turn = 10 * 60 * 1000;
        assert_eq!(
            benchmark_sign_in_step(None, now, turn, window),
            BenchmarkSignIn::Ready
        );
        assert_eq!(
            benchmark_sign_in_step(Some(now + 20 * minute), now, turn, window),
            BenchmarkSignIn::Ready
        );
        // Ten minutes left: too little for the turn, too much for the CLI to
        // renew it yet; the run waits until half a minute into its window.
        assert_eq!(
            benchmark_sign_in_step(Some(now + 10 * minute), now, turn, window),
            BenchmarkSignIn::WaitUntil(now + 5 * minute + RENEWAL_WINDOW_SLACK_MS)
        );
        // Inside the window, or past expiry, a listing renews it.
        for left in [5 * minute, 3 * minute, 0, -minute] {
            assert_eq!(
                benchmark_sign_in_step(Some(now + left), now, turn, window),
                BenchmarkSignIn::Renew,
                "{left}"
            );
        }
        // A user who turned the early renewal off: the CLI renews at expiry.
        assert_eq!(
            benchmark_sign_in_step(Some(now + 10 * minute), now, turn, 0),
            BenchmarkSignIn::WaitUntil(now + 10 * minute + RENEWAL_WINDOW_SLACK_MS)
        );
    }

    #[test]
    fn only_a_fresh_session_counts_as_signed_in() {
        let fresh = GrokAuthReadResult::Ok(session(Some(now_ms() + 60 * 60 * 1000)));
        let expired = GrokAuthReadResult::Ok(session(Some(now_ms() - 60_000)));
        assert!(has_fresh_grok_sign_in(&fresh));
        assert!(!has_fresh_grok_sign_in(&expired));
        assert!(!has_fresh_grok_sign_in(&GrokAuthReadResult::Missing));
        assert!(!has_fresh_grok_sign_in(&GrokAuthReadResult::Error(
            "Grok auth file is invalid".into()
        )));
    }
}
