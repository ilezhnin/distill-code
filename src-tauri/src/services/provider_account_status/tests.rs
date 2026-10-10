use super::*;
use provider_accounts::AuthMethod;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn account_responses_are_bounded_before_a_newline_arrives() {
    let bytes = vec![b'x'; MAX_RESPONSE_BYTES * 2];
    let mut reader = &bytes[..];
    assert!(read_response_line(&mut reader).await.is_err());
    assert_eq!(reader.len(), bytes.len() - MAX_RESPONSE_BYTES - 1);
    let mut reader = &b"first\nsecond\n"[..];
    assert_eq!(
        read_response_line(&mut reader).await.unwrap().as_deref(),
        Some("first\n")
    );
    assert_eq!(
        read_response_line(&mut reader).await.unwrap().as_deref(),
        Some("second\n")
    );
    assert!(read_response_line(&mut reader).await.unwrap().is_none());
}

fn account(id: &str) -> ProviderAccount {
    ProviderAccount {
        id: id.into(),
        provider_id: "codex-acp".into(),
        label: id.into(),
        auth_method: AuthMethod::OAuth,
        enabled: true,
        auto_switch: true,
        created_at: 0,
        updated_at: 0,
    }
}

fn status(id: &str, used: f64, reset: i64) -> ProviderAccountStatus {
    let mut status = ProviderAccountStatus::empty(id, "codex-acp", 1000);
    status.state = if used >= 100.0 {
        AccountState::Limited
    } else {
        AccountState::Ready
    };
    status.limits.push(AccountLimitWindow {
        id: "session".into(),
        label: "Session".into(),
        used_percent: Some(used),
        remaining: Some(100.0 - used),
        resets_at: Some(reset),
        window_minutes: Some(300),
        model_id: None,
    });
    status
}

#[test]
fn a_fresh_current_account_is_admitted_without_polling_other_accounts() {
    let ready = status("a", 20.0, 5000);
    assert!(current_status_ready(&ready, None, 2000));
    let mut unknown = ready.clone();
    unknown.state = AccountState::Unknown;
    unknown.limits.clear();
    assert!(current_status_ready(&unknown, None, 2000));
    // An expired, invalidated, failed, or model-limited cache must still refresh.
    assert!(!current_status_ready(&ready, None, 1000 + CACHE_MS));
    let mut invalidated = ready.clone();
    invalidated.last_attempt_at = 0;
    assert!(!current_status_ready(&invalidated, None, 2000));
    let mut failed = ready.clone();
    failed.stale = true;
    assert!(!current_status_ready(&failed, None, 2000));
    let mut scoped = ready;
    scoped.limits[0].used_percent = Some(100.0);
    scoped.limits[0].model_id = Some("opus".into());
    assert!(!current_status_ready(&scoped, Some("claude-opus"), 2000));
    assert!(current_status_ready(&scoped, Some("claude-sonnet"), 2000));
}

#[test]
fn failed_refresh_preserves_runtime_reported_exhaustion_without_numeric_limits() {
    let mut limited = status("a", 20.0, 5000);
    limited.state = AccountState::Limited;
    limited.error = Some("The provider reported an exhausted usage allowance".into());
    let mut failed = ProviderAccountStatus::empty("a", "codex-acp", 2000);
    failed.state = AccountState::Error;
    failed.error = Some("Status service is unavailable".into());
    let merged = merge_refresh(Some(&limited), failed.clone());
    assert_eq!(merged.state, AccountState::Limited);
    assert!(merged.stale);
    assert_eq!(merged.error, failed.error);
    assert_eq!(merged.last_updated_at, limited.last_updated_at);
    assert_eq!(merged.last_attempt_at, 2000);
    assert_eq!(
        choose_account(
            &[account("a")],
            std::slice::from_ref(&merged),
            "a",
            true,
            None,
            2000
        )
        .unwrap(),
        AccountSelection::Wait {
            account_id: "a".into(),
            next_reset: None,
            reset_tokens_available: false
        }
    );
    failed.last_attempt_at = 3000;
    assert_eq!(
        merge_refresh(Some(&merged), failed).state,
        AccountState::Limited
    );
}

#[test]
fn a_successful_fresh_refresh_can_clear_the_reported_limit() {
    let mut limited = status("a", 20.0, 5000);
    limited.state = AccountState::Limited;
    let mut ready = status("a", 0.0, 5000);
    ready.last_attempt_at = 2000;
    ready.last_updated_at = 2500;
    let merged = merge_refresh(Some(&limited), ready);
    assert_eq!(merged.state, AccountState::Ready);
    assert!(!merged.stale);
    assert!(current_status_ready(&merged, None, 2600));
}

#[test]
fn an_inflight_refresh_cannot_erase_a_newer_quota_rejection() {
    let mut limited = status("a", 20.0, 5000);
    limited.state = AccountState::Limited;
    limited.last_updated_at = 2000;
    limited.last_attempt_at = 2000;
    let mut older_request = status("a", 10.0, 5000);
    older_request.last_attempt_at = 1000;
    older_request.last_updated_at = 3000;
    assert_eq!(merge_refresh(Some(&limited), older_request), limited);
}

fn fresh_status(id: &str) -> ProviderAccountStatus {
    let mut result = status(id, 20.0, now_ms() + 5000);
    result.last_attempt_at = now_ms();
    result.last_updated_at = now_ms();
    result
}

#[tokio::test]
async fn usage_cooldown_blocks_cli_refresh_until_the_deadline_even_when_forced() {
    let state = AccountStatusCache::default();
    let target = account("a");
    let mut paused = fresh_status("a");
    paused.state = AccountState::Error;
    paused.stale = true;
    paused.last_attempt_at = now_ms() - CACHE_MS * 2;
    paused.usage_retry_at = Some(now_ms() + 60_000);
    state.cache.lock().await.insert("a".into(), paused.clone());
    for force in [false, true] {
        let cached = state
            .refresh(&target, force, async {
                panic!("cooldown must prevent the entire probe, including CLI initialization")
            })
            .await;
        assert_eq!(cached, paused);
    }
    state
        .cache
        .lock()
        .await
        .get_mut("a")
        .unwrap()
        .usage_retry_at = Some(now_ms() - 1);
    let refreshed = state
        .refresh(&target, false, async { fresh_status("a") })
        .await;
    assert_eq!(refreshed.state, AccountState::Ready);
    assert_eq!(refreshed.usage_retry_at, None);
}

#[tokio::test]
async fn expired_authorization_releases_the_usage_pause() {
    let state = AccountStatusCache::default();
    let target = account("a");
    let mut paused = fresh_status("a");
    paused.state = AccountState::Error;
    paused.stale = true;
    paused.usage_retry_at = Some(now_ms() + 60_000);
    state.cache.lock().await.insert("a".into(), paused.clone());
    state
        .release_cooldown_for_expired_authorization("a", false)
        .await;
    let cached = state
        .refresh(&target, true, async {
            panic!("a live authorization keeps the pause")
        })
        .await;
    assert_eq!(cached, paused);
    state
        .release_cooldown_for_expired_authorization("a", true)
        .await;
    let refreshed = state
        .refresh(&target, false, async { fresh_status("a") })
        .await;
    assert_eq!(refreshed.state, AccountState::Ready);
    assert_eq!(refreshed.usage_retry_at, None);
}

#[tokio::test]
async fn an_account_change_forgets_its_status_and_usage_pause() {
    let state = AccountStatusCache::default();
    let id = "account-change-forgets";
    let _ = claude_resets::record_usage_result(
        id,
        now_ms(),
        Err(claude_resets::RequestError::RateLimited(600)),
    );
    state.cache.lock().await.insert(id.into(), fresh_status(id));
    state.forget_account(id).await;
    assert!(!state.cache.lock().await.contains_key(id));
    assert_eq!(claude_resets::usage_backoff_remaining(id, now_ms()), None);
}

#[test]
fn failed_usage_keeps_the_new_identity_and_previous_quota() {
    let mut old = status("a", 59.0, 5000);
    old.subscription = Some("Pro".into());
    let mut failed = ProviderAccountStatus::empty("a", "codex-acp", 2000);
    failed.state = AccountState::Error;
    failed.subscription = Some("Max (5x)".into());
    failed.account_label = Some("Current account".into());
    failed.usage_retry_at = Some(60_000);
    let merged = merge_refresh(Some(&old), failed);
    assert_eq!(merged.subscription.as_deref(), Some("Max (5x)"));
    assert_eq!(merged.account_label.as_deref(), Some("Current account"));
    assert_eq!(merged.limits, old.limits);
    assert_eq!(merged.usage_retry_at, Some(60_000));
    assert!(merged.stale);
}

#[tokio::test]
async fn a_slow_account_does_not_block_another_accounts_refresh() {
    let state = Arc::new(AccountStatusCache::default());
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let slow_state = state.clone();
    let slow = tokio::spawn(async move {
        slow_state
            .refresh(&account("slow"), false, async {
                entered_tx.send(()).unwrap();
                release_rx.await.unwrap();
                fresh_status("slow")
            })
            .await
    });
    entered_rx.await.unwrap();
    let ready = tokio::time::timeout(
        Duration::from_secs(1),
        state.refresh(&account("current"), false, async {
            fresh_status("current")
        }),
    )
    .await
    .expect("another account's request must not wait for the slow account");
    assert_eq!(ready.account_id, "current");
    release_tx.send(()).unwrap();
    slow.await.unwrap();
}

#[tokio::test]
async fn concurrent_forced_refreshes_share_the_same_account_request() {
    let state = Arc::new(AccountStatusCache::default());
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let first_state = state.clone();
    let first = tokio::spawn(async move {
        first_state
            .refresh(&account("a"), true, async {
                entered_tx.send(()).unwrap();
                release_rx.await.unwrap();
                fresh_status("a")
            })
            .await
    });
    entered_rx.await.unwrap();
    let target = account("a");
    let duplicate = state.refresh(&target, true, async {
        panic!("a simultaneous forced request must reuse the completed sample")
    });
    tokio::pin!(duplicate);
    assert!(futures_util::poll!(&mut duplicate).is_pending());
    release_tx.send(()).unwrap();
    let expected = first.await.unwrap();
    assert_eq!(duplicate.await, expected);
}

#[tokio::test]
async fn a_quota_observation_wins_even_when_refresh_started_in_the_same_millisecond() {
    let state = AccountStatusCache::default();
    let target = account("a");
    let slot = state.refresh_slot(&target.id).await;
    let ready = fresh_status("a");
    let mut limited = ready.clone();
    limited.state = AccountState::Limited;
    let expected = limited.clone();
    let result = state
        .refresh(&target, false, async {
            let mut cache = state.cache.lock().await;
            cache.insert(target.id.clone(), limited);
            slot.observations.fetch_add(1, Ordering::SeqCst);
            ready
        })
        .await;
    assert_eq!(result, expected);
}

#[tokio::test]
async fn a_turn_finishing_during_refresh_requires_a_newer_sample() {
    let state = AccountStatusCache::default();
    let target = account("a");
    let slot = state.refresh_slot(&target.id).await;
    let result = state
        .refresh(&target, false, async {
            let mut old = fresh_status("a");
            old.last_attempt_at = 0;
            state.cache.lock().await.insert(target.id.clone(), old);
            slot.observations.fetch_add(1, Ordering::SeqCst);
            fresh_status("a")
        })
        .await;
    assert_eq!(result.last_attempt_at, 0);
    let result = state
        .refresh(&target, false, async {
            let mut newer = fresh_status("a");
            newer.limits[0].used_percent = Some(30.0);
            newer
        })
        .await;
    assert_eq!(result.limits[0].used_percent, Some(30.0));
    assert!(result.last_attempt_at > 0);
}

#[test]
fn routing_only_probes_enabled_eligible_accounts_of_the_same_provider() {
    let current = account("current");
    let mut candidate = account("spare");
    assert!(fallback_candidate(&candidate, &current, false));
    assert!(!fallback_candidate(&current, &current, false));
    candidate.provider_id = "claude-acp".into();
    assert!(!fallback_candidate(&candidate, &current, false));
    candidate.provider_id = current.provider_id.clone();
    candidate.auto_switch = false;
    assert!(!fallback_candidate(&candidate, &current, false));
    candidate.auto_switch = true;
    candidate.enabled = false;
    assert!(!fallback_candidate(&candidate, &current, false));
    candidate.enabled = true;
    candidate.auth_method = AuthMethod::ApiKey;
    assert!(!fallback_candidate(&candidate, &current, false));
    assert!(fallback_candidate(&candidate, &current, true));
    candidate.auth_method = AuthMethod::OAuth;
    assert!(fallback_candidate(&candidate, &current, false));
    assert!(!fallback_candidate(&candidate, &current, true));
}

#[test]
fn zai_keys_use_subscription_routing_and_keep_exhaustion_on_failed_refresh() {
    let mut current = account("current");
    current.provider_id = "zai-acp".into();
    current.auth_method = AuthMethod::ApiKey;
    let mut spare = current.clone();
    spare.id = "spare".into();
    assert!(!api_billed(&current, None));
    assert!(fallback_candidate(&spare, &current, false));
    assert!(!fallback_candidate(&spare, &current, true));
    let mut blocked = status("current", 100.0, 5000);
    blocked.provider_id = "zai-acp".into();
    let mut ready = status("spare", 20.0, 5000);
    ready.provider_id = "zai-acp".into();
    assert_eq!(
        choose_account(
            &[current.clone(), spare],
            &[blocked.clone(), ready],
            "current",
            true,
            None,
            2000
        )
        .unwrap(),
        AccountSelection::Ready {
            account_id: "spare".into()
        }
    );
    let mut failed = ProviderAccountStatus::empty("current", "zai-acp", 3000);
    failed.state = AccountState::Error;
    failed.error = Some("Z.ai usage unavailable".into());
    let merged = merge_refresh(Some(&blocked), failed);
    assert_eq!(merged.state, AccountState::Limited);
    assert_eq!(merged.limits, blocked.limits);
    assert!(merged.stale);
    assert!(matches!(
        choose_account(&[current], &[merged], "current", false, None, 3500).unwrap(),
        AccountSelection::Wait { .. }
    ));
}

#[test]
fn typed_quota_errors_are_distinct_from_temporary_rate_and_context_limits() {
    assert!(is_quota_error(
        &json!({"data":{"codexErrorInfo":"usageLimitExceeded"}})
    ));
    assert!(is_quota_error(
        &json!({"data":{"errorKind":"quota_exhausted"}})
    ));
    assert!(!is_quota_error(
        &json!({"code":429,"data":{"codexErrorInfo":"rateLimitExceeded"}})
    ));
    assert!(!is_quota_error(&json!({"data":{"errorKind":"rate_limit"}})));
    assert!(!is_quota_error(
        &json!({"data":{"codexErrorInfo":"contextWindowExceeded"}})
    ));
}

#[test]
fn typed_nonquota_failures_override_conflicting_usage_limit_prose() {
    for kind in [
        "provider_failure",
        "rate_limit",
        "authentication_failed",
        "budget_exhausted",
        "context_exhausted",
    ] {
        assert!(
            !is_quota_error(
                &json!({"message":"usage limit reached; quota_exhausted", "data":{"errorKind":kind}})
            ),
            "{kind}"
        );
    }
    for kind in [
        "rateLimitExceeded",
        "contextWindowExceeded",
        "sessionBudgetExceeded",
        "unauthorized",
    ] {
        assert!(
            !is_quota_error(
                &json!({"data":{"message":"usage limit reached", "codexErrorInfo":kind}})
            ),
            "{kind}"
        );
    }
    for actions in [json!(["retry"]), json!(["new_session"])] {
        assert!(!is_quota_error(&json!({"message":"usage limit", "data":{
            "sessionFailure":{"severity":"error","category":"limit","actions":actions,"title":"usage limit"}
        }})));
    }
    // Contradictory typed fields also fail closed; no prose or other quota
    // marker may override a definite temporary-rate-limit policy.
    assert!(!is_quota_error(
        &json!({"data":{"errorKind":"quota_exhausted",
            "sessionFailure":{"severity":"error","category":"limit","actions":["retry"]}
        }})
    ));
    assert!(is_quota_error(&json!({"message":"usage limit reached"})));
    assert!(!is_quota_error(
        &json!({"data":{"transcript":"usage limit reached"}})
    ));
    assert!(is_quota_error(
        &json!({"data":{"errorKind":"quota_exhausted",
            "sessionFailure":{"severity":"error","category":"limit","actions":[]}
        }})
    ));
}

#[test]
fn automatic_routing_keeps_usable_account_then_falls_back_when_exhausted() {
    let accounts = [account("a"), account("b")];
    let mut statuses = [status("a", 20.0, 3000), status("b", 0.0, 2000)];
    assert_eq!(
        choose_account(&accounts, &statuses, "a", true, None, 1000).unwrap(),
        AccountSelection::Ready {
            account_id: "a".into()
        }
    );
    statuses[0] = status("a", 100.0, 3000);
    assert_eq!(
        choose_account(&accounts, &statuses, "a", true, None, 1000).unwrap(),
        AccountSelection::Ready {
            account_id: "b".into()
        }
    );
    assert_eq!(
        choose_account(&accounts, &statuses, "a", false, None, 1000).unwrap(),
        AccountSelection::Wait {
            account_id: "a".into(),
            next_reset: Some(3000),
            reset_tokens_available: false
        }
    );
}

#[test]
fn wait_uses_latest_blocking_window_per_account_then_earliest_account() {
    let accounts = [account("a"), account("b")];
    let mut a = status("a", 100.0, 2000);
    let mut weekly = a.limits[0].clone();
    weekly.id = "weekly".into();
    weekly.resets_at = Some(9000);
    a.limits.push(weekly);
    let b = status("b", 100.0, 5000);
    assert_eq!(
        choose_account(&accounts, &[a, b], "a", true, None, 1000).unwrap(),
        AccountSelection::Wait {
            account_id: "b".into(),
            next_reset: Some(5000),
            reset_tokens_available: false
        }
    );
}

#[test]
fn earned_resets_never_make_an_exhausted_account_automatically_ready() {
    let accounts = [account("a"), account("b")];
    let a = status("a", 100.0, 5000);
    let mut b = status("b", 100.0, 9000);
    b.reset_tokens = Some(ResetTokens {
        available: 2,
        expires_at: None,
        supported: true,
        credits: None,
    });
    assert_eq!(
        choose_account(&accounts, &[a, b], "a", true, None, 1000).unwrap(),
        AccountSelection::Wait {
            account_id: "a".into(),
            next_reset: Some(5000),
            reset_tokens_available: true
        }
    );
}

#[test]
fn unavailable_stale_disabled_and_excluded_accounts_do_not_receive_fallback() {
    let mut accounts = [account("a"), account("b"), account("c"), account("d")];
    accounts[2].enabled = false;
    accounts[3].auto_switch = false;
    let mut statuses = [
        status("a", 100.0, 5000),
        status("b", 0.0, 9000),
        status("c", 0.0, 9000),
        status("d", 0.0, 9000),
    ];
    statuses[1].stale = true;
    assert!(
        matches!(choose_account(&accounts,&statuses,"a",true,None,1000).unwrap(),AccountSelection::Wait {account_id,..} if account_id == "a")
    );
}

#[test]
fn oauth_fallback_never_enables_api_billing_or_another_provider() {
    let mut accounts = [account("a"), account("api"), account("claude")];
    accounts[1].auth_method = AuthMethod::ApiKey;
    accounts[2].provider_id = "claude-acp".into();
    let statuses = [
        status("a", 100.0, 5000),
        status("api", 0.0, 9000),
        status("claude", 0.0, 9000),
    ];
    assert!(matches!(
        choose_account(&accounts, &statuses, "a", true, None, 1000).unwrap(),
        AccountSelection::Wait { .. }
    ));
}

#[test]
fn api_fallback_stays_in_the_same_provider_and_billing_mode() {
    let mut accounts = [
        account("api"),
        account("other-provider"),
        account("oauth"),
        account("backup"),
    ];
    accounts[0].auth_method = AuthMethod::ApiKey;
    accounts[1].auth_method = AuthMethod::ApiKey;
    accounts[1].provider_id = "claude-acp".into();
    accounts[3].auth_method = AuthMethod::ApiKey;
    let statuses = [
        status("api", 100.0, 5000),
        status("other-provider", 0.0, 9000),
        status("oauth", 0.0, 9000),
        status("backup", 0.0, 9000),
    ];
    assert_eq!(
        choose_account(&accounts, &statuses, "api", true, None, 1000).unwrap(),
        AccountSelection::Ready {
            account_id: "backup".into()
        }
    );
    assert!(matches!(
        choose_account(&accounts[..3], &statuses[..3], "api", true, None, 1000).unwrap(),
        AccountSelection::Wait { .. }
    ));
}

#[test]
fn scoped_model_limit_does_not_block_other_models() {
    let accounts = [account("a")];
    let mut a = status("a", 100.0, 5000);
    a.state = AccountState::Ready;
    a.limits[0].model_id = Some("opus".into());
    assert!(matches!(
        choose_account(
            &accounts,
            &[a.clone()],
            "a",
            false,
            Some("claude-sonnet"),
            1000
        )
        .unwrap(),
        AccountSelection::Ready { .. }
    ));
    assert!(matches!(
        choose_account(&accounts, &[a], "a", false, Some("claude-opus"), 1000).unwrap(),
        AccountSelection::Wait { .. }
    ));
}

#[test]
fn elapsed_cached_reset_needs_fresh_evidence() {
    assert_eq!(
        choose_account(
            &[account("a")],
            &[status("a", 100.0, 900)],
            "a",
            true,
            None,
            1000
        )
        .unwrap(),
        AccountSelection::Wait {
            account_id: "a".into(),
            next_reset: None,
            reset_tokens_available: false
        }
    );
}

#[test]
fn codex_preserves_all_buckets_and_authoritative_reset_count() {
    let identity = json!({"account":{"type":"chatgpt","email":"a@example.test","planType":"pro"}});
    let usage = json!({"rateLimitsByLimitId":{
        "codex":{"primary":{"usedPercent":100,"resetsAt":1800000000,"windowDurationMins":300},"secondary":{"usedPercent":10,"resetsAt":1800100000,"windowDurationMins":10080}},
        "codex_other":{"limitName":"Other","primary":{"usedPercent":50,"resetsAt":1800000500,"windowDurationMins":60}}
    },"rateLimitResetCredits":{"availableCount":3,"credits":[{"id":"credit-1","resetType":"codexRateLimits","status":"available","grantedAt":1790000000,"expiresAt":1810000000}]}});
    let result = codex::map_usage("a", &identity, &usage, 1000);
    assert_eq!(result.state, AccountState::Limited);
    assert_eq!(result.limits.len(), 3);
    assert_eq!(result.limits[0].resets_at, Some(1_800_000_000_000));
    assert_eq!(result.subscription.as_deref(), Some("ChatGPT Pro 200"));
    let tokens = result.reset_tokens.unwrap();
    assert_eq!(tokens.available, 3);
    assert_eq!(tokens.credits.unwrap().len(), 1);
}

#[test]
fn missing_quota_or_reset_inventory_is_not_zero_or_unlimited() {
    let result = codex::map_usage(
        "a",
        &json!({"account":{"type":"chatgpt"}}),
        &json!({}),
        1000,
    );
    assert_eq!(result.state, AccountState::Unknown);
    assert!(result.limits.is_empty());
    assert!(result.reset_tokens.is_none());
    assert!(result.credits.is_none());
}

#[test]
fn claude_model_windows_and_unknown_reset_tokens_stay_distinct() {
    let mut result = ProviderAccountStatus::empty("a", "claude-acp", 1000);
    claude::map_usage(
        &mut result,
        &json!({"five_hour":{"utilization":50,"resets_at":"2026-09-28T18:00:00Z"},"seven_day_sonnet":{"utilization":100,"resets_at":"2026-10-01T18:00:00Z"},"extra_usage":{"utilization":100}}),
    );
    assert_eq!(result.state, AccountState::Ready);
    assert_eq!(result.limits.len(), 2);
    assert!(result.reset_tokens.is_none());
    assert!(!exhausted(&result, Some("claude-opus"), 1000).0);
    assert!(exhausted(&result, Some("claude-sonnet"), 1000).0);
}

#[test]
fn reset_outcomes_keep_idempotent_success_distinct() {
    let result: ResetResult = serde_json::from_value(json!({"outcome":"alreadyRedeemed"})).unwrap();
    assert_eq!(result.outcome, ResetOutcome::AlreadyRedeemed);
    assert!(serde_json::from_value::<ResetResult>(json!({"outcome":"unknown"})).is_err());
}

#[tokio::test]
async fn authorization_quota_and_invalidation_stay_in_the_executing_runtime() {
    for (blocked, executing) in [
        (AccountRuntime::Native, AccountRuntime::Repository),
        (AccountRuntime::Repository, AccountRuntime::Native),
    ] {
        let state = ProviderAccountStatusState::default();
        let target = account("same-account");
        let mut signed_out = fresh_status(&target.id);
        signed_out.state = AccountState::NeedsAuth;
        state
            .runtime(blocked)
            .refresh(&target, false, async { signed_out.clone() })
            .await;
        let ready = state
            .runtime(executing)
            .refresh(&target, false, async { fresh_status(&target.id) })
            .await;
        assert!(matches!(
            choose_account(
                std::slice::from_ref(&target),
                &[ready],
                &target.id,
                false,
                None,
                now_ms()
            ),
            Ok(AccountSelection::Ready { .. })
        ));
        assert!(choose_account(
            std::slice::from_ref(&target),
            std::slice::from_ref(&signed_out),
            &target.id,
            false,
            None,
            now_ms()
        )
        .is_err());

        state.runtime(executing).record_limited(&target).await;
        assert_eq!(
            state.runtime(blocked).cache.lock().await[&target.id],
            signed_out
        );
        state.runtime(blocked).invalidate(&target.id).await;
        let limited = state
            .runtime(executing)
            .refresh(&target, false, async {
                panic!("fresh rejection must block dispatch without polling")
            })
            .await;
        assert!(matches!(
            choose_account(
                std::slice::from_ref(&target),
                &[limited],
                &target.id,
                false,
                None,
                now_ms()
            ),
            Ok(AccountSelection::Wait { .. })
        ));

        // Failed telemetry cannot undo a known quota rejection in this runtime.
        state.runtime(executing).invalidate(&target.id).await;
        let failed = state
            .runtime(executing)
            .refresh(&target, false, async {
                let mut status = fresh_status(&target.id);
                status.state = AccountState::Error;
                status
            })
            .await;
        assert!(matches!(
            choose_account(
                std::slice::from_ref(&target),
                &[failed],
                &target.id,
                false,
                None,
                now_ms()
            ),
            Ok(AccountSelection::Wait { .. })
        ));
    }
}

#[tokio::test]
async fn a_native_refresh_does_not_hold_the_repository_gate_for_the_same_account() {
    let state = ProviderAccountStatusState::default();
    let slot = state.native.refresh_slot("a").await;
    let _guard = slot.gate.lock().await;
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        state
            .repository
            .refresh(&account("a"), false, async { fresh_status("a") }),
    )
    .await;
    assert_eq!(result.unwrap().state, AccountState::Ready);
}

#[test]
fn repository_claude_usage_recognizes_auth_and_model_specific_quota() {
    let mut target = account("sandbox-account");
    target.provider_id = "claude-acp".into();
    let usage = json!({"subscription_type":"pro","rate_limits_available":true,"rate_limits":{"limits":[{"kind":"session","percent":12},{"kind":"weekly_all","percent":42},{"kind":"weekly_scoped","percent":100,"scope":{"model":{"display_name":"Sonnet"}}}]}});
    let status =
        claude::repository_status(&target, &json!({"subscriptionType":"claude_pro"}), &usage);
    assert_eq!(status.subscription.as_deref(), Some("Claude Pro"));
    assert!(matches!(
        choose_account(
            std::slice::from_ref(&target),
            std::slice::from_ref(&status),
            &target.id,
            false,
            Some("haiku"),
            now_ms()
        ),
        Ok(AccountSelection::Ready { .. })
    ));
    assert!(matches!(
        choose_account(
            std::slice::from_ref(&target),
            &[status],
            &target.id,
            false,
            Some("sonnet"),
            now_ms()
        ),
        Ok(AccountSelection::Wait { .. })
    ));
    assert_eq!(
        claude::repository_status(&target, &Value::Null, &usage).state,
        AccountState::NeedsAuth
    );
}
