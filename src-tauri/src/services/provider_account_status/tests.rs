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
async fn a_slow_account_does_not_block_another_accounts_refresh() {
    let state = Arc::new(ProviderAccountStatusState::default());
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
    let state = Arc::new(ProviderAccountStatusState::default());
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
    let state = ProviderAccountStatusState::default();
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
    let state = ProviderAccountStatusState::default();
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
