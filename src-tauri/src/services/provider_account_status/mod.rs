//! Account-scoped quota snapshots and routing. Reset credits are never consumed
//! by selection, polling, or dispatch; only the operator's explicit IPC can do so.

pub mod benchmark_sampling;
mod claude;
mod claude_resets;
mod codex;
mod types;

pub use types::*;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::{stream, StreamExt};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};
use tokio::sync::Mutex;

use crate::services::provider_accounts::{self, ProviderAccount};

const CACHE_MS: i64 = 60_000;
const STALE_MS: i64 = 120_000;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Bound allocation while reading, including a provider that never sends a newline.
async fn read_response_line(
    reader: &mut (impl AsyncBufRead + Unpin),
) -> Result<Option<String>, String> {
    let mut line = String::new();
    let size = reader
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_line(&mut line)
        .await
        .map_err(|_| "Could not read account service response".to_string())?;
    if size > MAX_RESPONSE_BYTES {
        return Err("Account response exceeded the size limit".into());
    }
    Ok((size > 0).then_some(line))
}

#[derive(Default)]
pub struct ProviderAccountStatusState {
    cache: Mutex<HashMap<String, ProviderAccountStatus>>,
    refreshes: Mutex<HashMap<String, Arc<AccountRefresh>>>,
    reset_lock: Mutex<()>,
}

#[derive(Default)]
struct AccountRefresh {
    gate: Mutex<()>,
    completed: AtomicU64,
    observations: AtomicU64,
}

impl ProviderAccountStatusState {
    async fn refresh_slot(&self, account_id: &str) -> Arc<AccountRefresh> {
        self.refreshes
            .lock()
            .await
            .entry(account_id.into())
            .or_default()
            .clone()
    }

    async fn refresh(
        &self,
        account: &ProviderAccount,
        force: bool,
        fetch: impl Future<Output = ProviderAccountStatus> + Send,
    ) -> ProviderAccountStatus {
        let slot = self.refresh_slot(&account.id).await;
        let completed = slot.completed.load(Ordering::SeqCst);
        let _guard = slot.gate.lock().await;
        {
            let cache = self.cache.lock().await;
            if let Some(status) = cache.get(&account.id).filter(|status| {
                // Even manual refresh must wait before starting another CLI.
                let cooling_down =
                    account.enabled && status.usage_retry_at.is_some_and(|until| until > now_ms());
                cooling_down
                    || (!refresh_needed(status, account, now_ms())
                        && (!force || slot.completed.load(Ordering::SeqCst) != completed))
            }) {
                return status.clone();
            }
        }
        let observations = slot.observations.load(Ordering::SeqCst);
        let fetched = fetch.await;
        let mut cache = self.cache.lock().await;
        let changed = slot.observations.load(Ordering::SeqCst) != observations;
        let status = match cache.get(&account.id) {
            // A rejection received during this refresh is stronger evidence
            // than telemetry that began before the rejected request.
            Some(old) if changed && old.state == AccountState::Limited => old.clone(),
            old => {
                let mut status = merge_refresh(old, fetched);
                if changed {
                    // A completed turn invalidated the sample while it was
                    // in flight. Let the next request obtain a newer sample.
                    status.last_attempt_at = 0;
                }
                status
            }
        };
        cache.insert(account.id.clone(), status.clone());
        slot.completed.fetch_add(1, Ordering::SeqCst);
        status
    }
}

fn refresh_needed(status: &ProviderAccountStatus, account: &ProviderAccount, now: i64) -> bool {
    status.last_attempt_at <= 0
        || !(0..CACHE_MS).contains(&(now - status.last_attempt_at))
        || (status.state == AccountState::Disabled) == account.enabled
}

pub(super) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(super) fn timestamp(value: &Value) -> Option<i64> {
    if let Some(number) = value
        .as_f64()
        .filter(|number| number.is_finite() && *number > 0.0)
    {
        return Some(if number < 10_000_000_000.0 {
            (number * 1000.0) as i64
        } else {
            number as i64
        });
    }
    value
        .as_str()
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .map(|time| time.timestamp_millis())
}

pub async fn invalidate(app: &AppHandle, account_id: &str) {
    if let Some(state) = app.try_state::<ProviderAccountStatusState>() {
        let slot = state.refresh_slot(account_id).await;
        if let Some(status) = state.cache.lock().await.get_mut(account_id) {
            status.last_attempt_at = 0;
            slot.observations.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// Called after the registry mutation guard prevents any new scoped process.
/// Wait for the old telemetry process to exit before its credentials move.
pub async fn prepare_account_change(app: &AppHandle, account_id: &str) {
    if let Some(state) = app.try_state::<ProviderAccountStatusState>() {
        let slot = state.refresh_slot(account_id).await;
        let _guard = slot.gate.lock().await;
        state.cache.lock().await.remove(account_id);
        slot.observations.fetch_add(1, Ordering::SeqCst);
    }
}

pub async fn record_signed_out(app: &AppHandle, account: &ProviderAccount) {
    if let Some(state) = app.try_state::<ProviderAccountStatusState>() {
        let slot = state.refresh_slot(&account.id).await;
        let _guard = slot.gate.lock().await;
        let mut status = ProviderAccountStatus::empty(&account.id, &account.provider_id, now_ms());
        status.state = AccountState::NeedsAuth;
        state.cache.lock().await.insert(account.id.clone(), status);
        slot.observations.fetch_add(1, Ordering::SeqCst);
    }
}

pub async fn fetch_snapshot(
    app: &AppHandle,
    force: bool,
) -> Result<ProviderAccountStatusSnapshot, String> {
    let accounts = provider_accounts::snapshot(app)?.accounts;
    stream::iter(accounts)
        .map(|account| async move { refresh_account(app, &account, force).await })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
    emit_cached_snapshot(app).await
}

async fn refresh_account(
    app: &AppHandle,
    account: &ProviderAccount,
    force: bool,
) -> ProviderAccountStatus {
    app.state::<ProviderAccountStatusState>()
        .refresh(account, force, async {
            // A queued refresh must observe changes made while its account
            // gate was held, including account removal or disabling.
            match provider_accounts::account(app, &account.id) {
                Ok(current) => fetch_account(app, &current).await,
                Err(_) => {
                    let mut status =
                        ProviderAccountStatus::empty(&account.id, &account.provider_id, now_ms());
                    status.state = AccountState::Disabled;
                    status
                }
            }
        })
        .await
}

async fn emit_cached_snapshot(app: &AppHandle) -> Result<ProviderAccountStatusSnapshot, String> {
    let accounts = provider_accounts::snapshot(app)?.accounts;
    let state = app.state::<ProviderAccountStatusState>();
    let now = now_ms();
    let mut cache = state.cache.lock().await;
    cache.retain(|id, _| accounts.iter().any(|account| &account.id == id));
    let snapshot = ProviderAccountStatusSnapshot {
        accounts: accounts
            .iter()
            .filter_map(|account| cache.get(&account.id).cloned())
            .map(|mut status| {
                status.stale |= now - status.last_updated_at > STALE_MS;
                status
            })
            .collect(),
        updated_at: now_ms(),
    };
    drop(cache);
    let _ = app.emit("provider-account-statuses", &snapshot);
    Ok(snapshot)
}

/// A telemetry error is not evidence that an exhausted account refilled.
/// Preserve its last known values while exposing the failed attempt separately.
fn merge_refresh(
    old: Option<&ProviderAccountStatus>,
    mut status: ProviderAccountStatus,
) -> ProviderAccountStatus {
    if let Some(old) = old.filter(|old| {
        old.state == AccountState::Limited && old.last_updated_at > status.last_attempt_at
    }) {
        // The running agent learned about quota after this request began.
        // An older response cannot undo that newer observation.
        return old.clone();
    }
    if status.state == AccountState::Error {
        if let Some(old) = old.filter(|old| {
            old.state != AccountState::NeedsAuth && old.state != AccountState::Disabled
        }) {
            status.subscription = status.subscription.or_else(|| old.subscription.clone());
            status.account_label = status.account_label.or_else(|| old.account_label.clone());
            status.limits = old.limits.clone();
            status.reset_tokens = old.reset_tokens.clone();
            status.credits = old.credits.clone();
            status.last_updated_at = old.last_updated_at;
            if old.state == AccountState::Limited {
                status.state = AccountState::Limited;
            }
        }
        status.stale = true;
    }
    status
}

async fn fetch_account(app: &AppHandle, account: &ProviderAccount) -> ProviderAccountStatus {
    let mut empty = ProviderAccountStatus::empty(&account.id, &account.provider_id, now_ms());
    if !account.enabled {
        empty.state = AccountState::Disabled;
        return empty;
    }
    if account.auth_method == provider_accounts::AuthMethod::ApiKey {
        empty.subscription = Some("API".into());
        empty.state = match provider_accounts::account_has_credentials(app, account) {
            Ok(true) => AccountState::Ready,
            Ok(false) => AccountState::NeedsAuth,
            Err(_) => AccountState::Error,
        };
        return empty;
    }
    let result = match account.provider_id.as_str() {
        "codex-acp" => codex::fetch(app, account).await,
        "claude-acp" => claude::fetch(app, account).await,
        _ => Ok(empty.clone()),
    };
    let started = empty.last_attempt_at;
    let mut result = result.unwrap_or_else(|error| {
        empty.state = AccountState::Error;
        empty.error = Some(error);
        empty.stale = true;
        empty
    });
    // Adapters timestamp their completed response. Keep the request start as
    // well so a concurrent quota rejection cannot be overwritten by old data.
    result.last_attempt_at = started;
    result
}

/// Selection never calls a credit redemption endpoint. A wait is a real wait,
/// including when the selected account has earned reset credits available.
pub async fn select_account(
    app: &AppHandle,
    provider_id: &str,
    current_account_id: Option<&str>,
    auto_switch: bool,
    model_id: Option<&str>,
) -> Result<AccountSelection, String> {
    select_account_excluding(
        app,
        provider_id,
        current_account_id,
        auto_switch,
        model_id,
        &HashSet::new(),
    )
    .await
}

pub async fn select_account_excluding(
    app: &AppHandle,
    provider_id: &str,
    current_account_id: Option<&str>,
    auto_switch: bool,
    model_id: Option<&str>,
    excluded: &HashSet<String>,
) -> Result<AccountSelection, String> {
    let registry = provider_accounts::snapshot(app)?;
    let current = provider_accounts::resolve_account(app, provider_id, current_account_id)?;
    {
        let state = app.state::<ProviderAccountStatusState>();
        let cache = state.cache.lock().await;
        if cache
            .get(&current.id)
            .is_some_and(|status| current_status_ready(status, model_id, now_ms()))
        {
            // An unrelated account's status request cannot delay dispatch.
            return Ok(AccountSelection::Ready {
                account_id: current.id,
            });
        }
    }
    let current_status = refresh_account(app, &current, false).await;
    let mut statuses = vec![current_status.clone()];
    let selection = choose_account(
        &registry.accounts,
        &statuses,
        &current.id,
        false,
        model_id,
        now_ms(),
    );
    if !auto_switch || matches!(selection, Ok(AccountSelection::Ready { .. })) {
        let _ = emit_cached_snapshot(app).await;
        return selection;
    }
    let current_api = api_billed(&current, Some(&current_status));
    let candidates: Vec<_> = registry
        .accounts
        .iter()
        .filter(|account| {
            !excluded.contains(&account.id) && fallback_candidate(account, &current, current_api)
        })
        .cloned()
        .collect();
    // Look at already-fresh candidates first. A slow unavailable spare must
    // not delay a switch to another account whose allowance is known.
    {
        let state = app.state::<ProviderAccountStatusState>();
        let cache = state.cache.lock().await;
        for candidate in &candidates {
            if let Some(status) = cache.get(&candidate.id).filter(|status| {
                !refresh_needed(status, candidate, now_ms())
                    && current_status_ready(status, model_id, now_ms())
            }) {
                statuses.push(status.clone());
            }
        }
    }
    if let Ok(ready @ AccountSelection::Ready { .. }) = choose_account(
        &registry.accounts,
        &statuses,
        &current.id,
        true,
        model_id,
        now_ms(),
    ) {
        let _ = emit_cached_snapshot(app).await;
        return Ok(ready);
    }
    let mut pending = stream::iter(candidates)
        .map(|account| {
            let app = app.clone();
            async move { refresh_account(&app, &account, false).await }
        })
        .buffer_unordered(4);
    while let Some(status) = pending.next().await {
        statuses.retain(|old| old.account_id != status.account_id);
        statuses.push(status);
        if let Ok(ready @ AccountSelection::Ready { .. }) = choose_account(
            &registry.accounts,
            &statuses,
            &current.id,
            true,
            model_id,
            now_ms(),
        ) {
            let _ = emit_cached_snapshot(app).await;
            return Ok(ready);
        }
    }
    let _ = emit_cached_snapshot(app).await;
    choose_account(
        &registry.accounts,
        &statuses,
        &current.id,
        true,
        model_id,
        now_ms(),
    )
}

fn api_billed(account: &ProviderAccount, status: Option<&ProviderAccountStatus>) -> bool {
    account.auth_method == provider_accounts::AuthMethod::ApiKey
        || status.is_some_and(|status| status.subscription.as_deref() == Some("API"))
}

fn fallback_candidate(
    account: &ProviderAccount,
    current: &ProviderAccount,
    current_api: bool,
) -> bool {
    account.id != current.id
        && account.enabled
        && account.auto_switch
        && account.provider_id == current.provider_id
        && match account.auth_method {
            provider_accounts::AuthMethod::ApiKey => current_api,
            provider_accounts::AuthMethod::OAuth => !current_api,
        }
}

fn current_status_ready(status: &ProviderAccountStatus, model_id: Option<&str>, now: i64) -> bool {
    !status.stale
        && status.last_attempt_at > 0
        && (0..CACHE_MS).contains(&(now - status.last_attempt_at))
        && (0..STALE_MS).contains(&(now - status.last_updated_at))
        && matches!(status.state, AccountState::Ready | AccountState::Unknown)
        && !exhausted(status, model_id, now).0
}

fn applies(window: &AccountLimitWindow, model_id: Option<&str>) -> bool {
    let Some(scope) = &window.model_id else {
        return true;
    };
    model_id.is_some_and(|model| {
        model
            .to_ascii_lowercase()
            .contains(&scope.to_ascii_lowercase())
    })
}

fn exhausted(
    status: &ProviderAccountStatus,
    model_id: Option<&str>,
    now: i64,
) -> (bool, Option<i64>) {
    let windows: Vec<_> = status
        .limits
        .iter()
        .filter(|window| {
            applies(window, model_id) && window.used_percent.is_some_and(|used| used >= 100.0)
        })
        .collect();
    if windows.is_empty() {
        return (status.state == AccountState::Limited, None);
    }
    // Do not assume a quota refilled merely because a cached countdown elapsed.
    // A fresh provider snapshot will establish availability before dispatch.
    let next_reset = if windows
        .iter()
        .all(|window| window.resets_at.is_some_and(|reset| reset > now))
    {
        windows.iter().filter_map(|window| window.resets_at).max()
    } else {
        None
    };
    (true, next_reset)
}

pub(crate) fn choose_account(
    accounts: &[ProviderAccount],
    statuses: &[ProviderAccountStatus],
    current_id: &str,
    auto_switch: bool,
    model_id: Option<&str>,
    now: i64,
) -> Result<AccountSelection, String> {
    let current = accounts
        .iter()
        .find(|account| account.id == current_id)
        .ok_or("Selected account no longer exists")?;
    if !current.enabled {
        return Err("The selected account is disabled".into());
    }
    let find_status = |id: &str| statuses.iter().find(|status| status.account_id == id);
    let current_status = find_status(current_id);
    let current_blocked = current_status.is_some_and(|status| exhausted(status, model_id, now).0);
    let current_auth_missing = current_status.is_some_and(|status| {
        matches!(
            status.state,
            AccountState::NeedsAuth | AccountState::Disabled
        )
    });
    if !current_blocked && !current_auth_missing {
        return Ok(AccountSelection::Ready {
            account_id: current_id.into(),
        });
    }
    let same_billing = |account: &ProviderAccount| {
        api_billed(account, find_status(&account.id)) == api_billed(current, current_status)
    };
    let candidates: Vec<_> = accounts
        .iter()
        .filter(|account| {
            account.enabled
                && account.provider_id == current.provider_id
                && same_billing(account)
                && (account.id == current_id || (auto_switch && account.auto_switch))
        })
        .collect();
    if auto_switch {
        for candidate in &candidates {
            if let Some(status) = find_status(&candidate.id)
                .filter(|status| !status.stale && status.state == AccountState::Ready)
            {
                if !exhausted(status, model_id, now).0 {
                    return Ok(AccountSelection::Ready {
                        account_id: candidate.id.clone(),
                    });
                }
            }
        }
    }
    let mut waits: Vec<_> = candidates
        .iter()
        .filter_map(|account| {
            let status = find_status(&account.id)?;
            let (blocked, reset) = exhausted(status, model_id, now);
            blocked.then_some((account, status, reset))
        })
        .collect();
    waits.sort_by_key(|(_, _, reset)| reset.unwrap_or(i64::MAX));
    if let Some((account, _, next_reset)) = waits.first() {
        let reset_tokens_available = waits.iter().any(|(_, status, _)| {
            !status.stale
                && status
                    .reset_tokens
                    .as_ref()
                    .is_some_and(|tokens| tokens.available > 0)
        });
        return Ok(AccountSelection::Wait {
            account_id: account.id.clone(),
            next_reset: *next_reset,
            reset_tokens_available,
        });
    }
    Err("No authenticated account is available for this provider".into())
}

pub(crate) fn is_quota_error(error: &Value) -> bool {
    let quota_kind = |kind: &str| {
        matches!(
            kind.to_ascii_lowercase().as_str(),
            "quota_exhausted"
                | "usagelimitexceeded"
                | "usage_limit_reached"
                | "quota_exceeded"
                | "insufficient_quota"
                | "billing_error"
                | "account_on_hold"
        )
    };
    let mut typed_quota = false;
    for path in [
        "/data/errorKind",
        "/errorKind",
        "/data/codexErrorInfo",
        "/codexErrorInfo",
        "/data/code",
        "/error/code",
        "/code",
    ] {
        if let Some(kind) = error
            .pointer(path)
            .filter(|value| !value.is_null() && !value.is_number())
        {
            // Any explicit non-quota kind wins over prose, even if a provider
            // includes usage-limit advice in a temporary or contextual error.
            if !kind.as_str().is_some_and(quota_kind) {
                return false;
            }
            typed_quota = true;
        }
    }
    for path in [
        "/data/sessionFailure",
        "/_meta/jetbrains/air/sessionFailure",
        "/data/_meta/jetbrains/air/sessionFailure",
    ] {
        if let Some(failure) = error.pointer(path).filter(|value| !value.is_null()) {
            if failure["severity"] != "error"
                || failure["category"] != "limit"
                || !failure["actions"].as_array().is_some_and(Vec::is_empty)
            {
                return false;
            }
            typed_quota = true;
        }
    }
    if typed_quota {
        return true;
    }
    // Legacy bridges may only provide text. Restrict fallback to diagnostic
    // fields; arbitrary metadata and quoted transcript content are not errors.
    [
        error.as_str(),
        error.pointer("/message").and_then(Value::as_str),
        error.pointer("/data/message").and_then(Value::as_str),
        error
            .pointer("/data/additionalDetails")
            .and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .any(|text| {
        let text = text.to_ascii_lowercase();
        [
            "quota_exhausted",
            "usagelimitexceeded",
            "usage_limit_reached",
            "quota_exceeded",
            "insufficient_quota",
            "usage limit",
            "hit your limit",
            "weekly limit reached",
        ]
        .iter()
        .any(|needle| text.contains(needle))
    })
}

pub async fn record_quota_error(app: &AppHandle, account_id: &str, error: &Value) -> bool {
    if !is_quota_error(error) {
        return false;
    }
    let Ok(account) = provider_accounts::account(app, account_id) else {
        return false;
    };
    let state = app.state::<ProviderAccountStatusState>();
    let slot = state.refresh_slot(account_id).await;
    let mut cache = state.cache.lock().await;
    let status = cache.entry(account_id.into()).or_insert_with(|| {
        ProviderAccountStatus::empty(account_id, &account.provider_id, now_ms())
    });
    status.state = AccountState::Limited;
    status.last_attempt_at = now_ms();
    status.last_updated_at = now_ms();
    status.error = Some("The provider reported an exhausted usage allowance".into());
    slot.observations.fetch_add(1, Ordering::SeqCst);
    drop(cache);
    let _ = emit_cached_snapshot(app).await;
    true
}

pub async fn consume_reset(
    app: &AppHandle,
    account_id: &str,
    idempotency_key: &str,
    credit_id: Option<&str>,
) -> Result<ResetResult, String> {
    // This method is only exposed by the explicit operator command. No routing
    // setting enables it and neither status refresh nor selection calls it.
    uuid::Uuid::parse_str(idempotency_key)
        .map_err(|_| "A reset requires a valid operation identifier".to_string())?;
    if credit_id.is_some_and(|id| id.trim().is_empty() || id.len() > 512) {
        return Err("Invalid reset credit identifier".into());
    }
    let account = provider_accounts::account(app, account_id)?;
    if !matches!(account.provider_id.as_str(), "codex-acp" | "claude-acp")
        || account.auth_method == provider_accounts::AuthMethod::ApiKey
        || !account.enabled
    {
        return Err("This account does not support earned limit resets".into());
    }
    let state = app.state::<ProviderAccountStatusState>();
    let _guard = state.reset_lock.lock().await;
    let slot = state.refresh_slot(account_id).await;
    let refresh_guard = slot.gate.lock().await;
    let result = match account.provider_id.as_str() {
        "claude-acp" => claude::consume(app, &account, idempotency_key, credit_id).await?,
        _ => codex::consume(app, &account, idempotency_key, credit_id).await?,
    };
    drop(refresh_guard);
    invalidate(app, account_id).await;
    // Keep the redemption outcome authoritative even if the subsequent status
    // read fails. A retry must reuse its original idempotency key.
    let _ = fetch_snapshot(app, true).await;
    Ok(result)
}

#[cfg(test)]
mod tests;
