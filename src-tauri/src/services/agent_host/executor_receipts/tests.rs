use super::*;
use serde_json::json;

fn start() -> ReceiptStart {
    ReceiptStart {
        link: ExecutorLink {
            decision_key: "wave:example:step:0".into(),
            logical_run_id: "logical-run".into(),
        },
        session_id: "example-session".into(),
        host_run_id: "host-run".into(),
        message_id: "example-message".into(),
        bridge_generation: 7,
        provider_id: "example-provider".into(),
        account_id: None,
        started_at: "2026-01-01T00:00:00Z".into(),
        selection: ReportedSelection::default(),
    }
}

fn finish() -> ReceiptFinish {
    ReceiptFinish {
        finished_at: "2026-01-01T00:00:01Z".into(),
        status: "completed".into(),
        selection: ReportedSelection {
            model_id: Some("reported-model".into()),
            ..Default::default()
        },
        changes: vec![],
        changes_truncated: false,
    }
}

#[test]
fn local_attribution_is_consumed_without_forwarding_it_to_the_provider() {
    let mut meta = json!({"executorSelection": start().link, "other": "preserved"});
    assert_eq!(ExecutorLink::take(&mut meta).unwrap(), Some(start().link));
    assert_eq!(meta, json!({"other":"preserved"}));
    assert!(ExecutorLink::take(&mut meta).unwrap().is_none());
    for value in [
        json!(null),
        json!({"decisionKey":"", "logicalRunId":"run"}),
        json!({"decisionKey":"key", "logicalRunId":"run", "configuration":"forged"}),
    ] {
        let mut meta = json!({"executorSelection":value});
        assert!(ExecutorLink::take(&mut meta).is_err());
        assert!(meta.get("executorSelection").is_none());
    }
}

#[tokio::test]
async fn only_one_dispatch_can_be_claimed_even_after_a_restart_and_lost_response() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("host.sqlite");
    let store = SessionStore::open(&path).await.unwrap();
    let start = start();
    let (a, b) = tokio::join!(
        store.claim_executor_receipt(&start),
        store.claim_executor_receipt(&start)
    );
    assert_ne!(a.unwrap(), b.unwrap());
    store.pool.close().await;
    let store = SessionStore::open(&path).await.unwrap();
    let receipt = store
        .executor_receipt(&start.link.decision_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.start, start);
    assert!(receipt.finish.is_none());
    let mut retry = start.clone();
    retry.session_id = "new-session".into();
    retry.host_run_id = "new-host-run".into();
    assert!(!store.claim_executor_receipt(&retry).await.unwrap());
    let mut aliased = start.clone();
    aliased.link.decision_key = "different-decision".into();
    assert!(!store.claim_executor_receipt(&aliased).await.unwrap());
    store
        .finish_executor_receipt(&start, &finish())
        .await
        .unwrap();
    assert!(!store.claim_executor_receipt(&start).await.unwrap());
}

#[tokio::test]
async fn terminal_evidence_is_idempotent_and_bound_to_the_original_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("host.sqlite");
    let store = SessionStore::open(&path).await.unwrap();
    let start = start();
    assert!(store
        .finish_executor_receipt(&start, &finish())
        .await
        .is_err());
    store.claim_executor_receipt(&start).await.unwrap();
    let mut other = start.clone();
    other.message_id = "another-message".into();
    assert!(store
        .finish_executor_receipt(&other, &finish())
        .await
        .is_err());
    store
        .finish_executor_receipt(&start, &finish())
        .await
        .unwrap();
    store
        .finish_executor_receipt(&start, &finish())
        .await
        .unwrap();
    let mut changed = finish();
    changed.selection.model_id = Some("another-model".into());
    assert!(store
        .finish_executor_receipt(&start, &changed)
        .await
        .is_err());
    store.pool.close().await;
    let store = SessionStore::open(&path).await.unwrap();
    assert_eq!(
        store
            .executor_receipt(&start.link.decision_key)
            .await
            .unwrap()
            .unwrap()
            .finish,
        Some(finish())
    );
    sqlx::query("UPDATE executor_receipts SET finish_hash='changed'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(store
        .executor_receipt(&start.link.decision_key)
        .await
        .is_err());
}

#[tokio::test]
async fn corrupted_dispatch_evidence_is_never_joined_as_a_valid_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let store = SessionStore::open(&dir.path().join("host.sqlite"))
        .await
        .unwrap();
    let start = start();
    store.claim_executor_receipt(&start).await.unwrap();
    sqlx::query("UPDATE executor_receipts SET session_id='other'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(store
        .executor_receipt(&start.link.decision_key)
        .await
        .is_err());
}

fn quota_error() -> Value {
    json!({"code":-32603,"data":{
        "errorKind":"quota_exhausted", "accountId":"account-a",
        "dispatchStarted":false, "promptNotAccepted":true,
    }})
}

async fn reject(store: &SessionStore, start: &ReceiptStart, automatic: bool) -> ReceiptRejection {
    let mut failed = finish();
    failed.status = "failed".into();
    store.finish_executor_receipt(start, &failed).await.unwrap();
    let proof = ReceiptRejection::quota_not_accepted(&quota_error(), automatic).unwrap();
    store
        .mark_executor_prompt_unaccepted(&start.link, &start.session_id, &start.host_run_id, &proof)
        .await
        .unwrap();
    proof
}

#[test]
fn retry_proof_requires_the_exact_quota_and_withdrawal_gate() {
    assert!(ReceiptRejection::quota_not_accepted(&quota_error(), true).is_some());
    for (field, value) in [
        ("dispatchStarted", json!(true)),
        ("dispatchStarted", Value::Null),
        ("promptNotAccepted", json!(false)),
        ("promptNotAccepted", Value::Null),
        ("errorKind", json!("rate_limit")),
        ("accountId", Value::Null),
    ] {
        let mut error = quota_error();
        error["data"][field] = value;
        assert!(
            ReceiptRejection::quota_not_accepted(&error, true).is_none(),
            "{field}"
        );
    }
}

#[tokio::test]
async fn failed_or_unknown_receipts_do_not_authorize_retry_or_unrelated_withdrawal() {
    let dir = tempfile::tempdir().unwrap();
    let store = SessionStore::open(&dir.path().join("host.sqlite"))
        .await
        .unwrap();
    let mut start = start();
    start.account_id = Some("account-a".into());
    assert!(store.claim_executor_receipt(&start).await.unwrap());
    let mut next = start.clone();
    next.host_run_id = "next-run".into();
    assert!(!store.claim_executor_receipt(&next).await.unwrap());
    let proof = ReceiptRejection::quota_not_accepted(&quota_error(), true).unwrap();
    assert!(store
        .mark_executor_prompt_unaccepted(&start.link, &start.session_id, &start.host_run_id, &proof)
        .await
        .is_err());
    let mut failed = finish();
    failed.status = "failed".into();
    store
        .finish_executor_receipt(&start, &failed)
        .await
        .unwrap();
    assert!(!store.claim_executor_receipt(&next).await.unwrap());
    for (session_id, run_id) in [
        ("other-session", start.host_run_id.as_str()),
        (start.session_id.as_str(), "other-run"),
    ] {
        assert!(store
            .mark_executor_prompt_unaccepted(&start.link, session_id, run_id, &proof)
            .await
            .is_err());
    }
    let mut wrong_account = proof.clone();
    wrong_account.account_id = "other-account".into();
    assert!(store
        .mark_executor_prompt_unaccepted(
            &start.link,
            &start.session_id,
            &start.host_run_id,
            &wrong_account
        )
        .await
        .is_err());
    let mut wrong_link = start.link.clone();
    wrong_link.logical_run_id = "other-task".into();
    assert!(store
        .mark_executor_prompt_unaccepted(&wrong_link, &start.session_id, &start.host_run_id, &proof)
        .await
        .is_err());
}

#[tokio::test]
async fn proven_manual_quota_wait_retry_is_atomic_durable_and_preserves_terminal_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("host.sqlite");
    let store = SessionStore::open(&path).await.unwrap();
    let mut first = start();
    first.account_id = Some("account-a".into());
    store.claim_executor_receipt(&first).await.unwrap();
    let proof = reject(&store, &first, false).await;
    let original = store
        .executor_receipt(&first.link.decision_key)
        .await
        .unwrap()
        .unwrap();
    store.pool.close().await;
    let store = SessionStore::open(&path).await.unwrap();
    let mut next = first.clone();
    next.host_run_id = "retry-after-reset".into();
    next.message_id = "retry-message".into();
    let (a, b) = tokio::join!(
        store.claim_executor_receipt(&next),
        store.claim_executor_receipt(&next)
    );
    assert_ne!(a.unwrap(), b.unwrap());
    let receipt = store
        .executor_receipt(&first.link.decision_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.start, next);
    assert!(receipt.finish.is_none());
    assert!(receipt.rejection.is_none());
    assert_eq!(receipt.attempt_index, 1);
    assert_eq!(
        receipt.previous_attempts,
        vec![ExecutorAttempt {
            start: first.clone(),
            finish: original.finish.clone(),
            rejection: Some(proof),
            attempt_index: 0,
        }]
    );
    // A late repeat of the original terminal write cannot overwrite the retry.
    store
        .finish_executor_receipt(&first, original.finish.as_ref().unwrap())
        .await
        .unwrap();
    let mut rewritten = original.finish.unwrap();
    rewritten.status = "completed".into();
    assert!(store
        .finish_executor_receipt(&first, &rewritten)
        .await
        .is_err());
    store
        .finish_executor_receipt(&next, &finish())
        .await
        .unwrap();
    assert!(!store.claim_executor_receipt(&next).await.unwrap());
    let mut alias = first.clone();
    alias.link.decision_key = "alias-old-run".into();
    assert!(!store.claim_executor_receipt(&alias).await.unwrap());
    store.pool.close().await;
    let store = SessionStore::open(&path).await.unwrap();
    assert_eq!(
        store
            .executor_receipt(&first.link.decision_key)
            .await
            .unwrap()
            .unwrap()
            .previous_attempts
            .len(),
        1
    );
    sqlx::query("UPDATE executor_rejected_attempts SET rejection_hash='tampered'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(store
        .executor_receipt(&first.link.decision_key)
        .await
        .is_err());
    assert!(store.claim_executor_receipt(&next).await.is_err());
}

#[tokio::test]
async fn immediate_account_fallback_keeps_logical_turn_and_rechecks_native_routing_policy() {
    let dir = tempfile::tempdir().unwrap();
    let store = SessionStore::open(&dir.path().join("host.sqlite"))
        .await
        .unwrap();
    let mut first = start();
    first.account_id = Some("account-a".into());
    store.claim_executor_receipt(&first).await.unwrap();
    reject(&store, &first, true).await;
    let mut second = first.clone();
    second.account_id = Some("account-b".into());
    second.bridge_generation += 1;
    // The same host prompt invocation retains its message/run IDs.
    assert!(!store
        .claim_executor_receipt_with_routing(&second, false)
        .await
        .unwrap());
    for changed in [
        ReceiptStart {
            session_id: "other-session".into(),
            ..second.clone()
        },
        ReceiptStart {
            provider_id: "other-provider".into(),
            ..second.clone()
        },
        ReceiptStart {
            link: ExecutorLink {
                logical_run_id: "other-task".into(),
                ..second.link.clone()
            },
            ..second.clone()
        },
    ] {
        assert!(!store
            .claim_executor_receipt_with_routing(&changed, true)
            .await
            .unwrap());
    }
    assert!(store
        .claim_executor_receipt_with_routing(&second, true)
        .await
        .unwrap());
    store
        .finish_executor_receipt(&second, &finish())
        .await
        .unwrap();
    let receipt = store
        .executor_receipt(&first.link.decision_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.start.host_run_id, first.host_run_id);
    assert_eq!(receipt.start.message_id, first.message_id);
    assert_eq!(receipt.start.account_id.as_deref(), Some("account-b"));
    assert_eq!(
        receipt.previous_attempts[0].start.account_id.as_deref(),
        Some("account-a")
    );
    assert!(!store
        .claim_executor_receipt_with_routing(&second, true)
        .await
        .unwrap());

    let mut manual = first.clone();
    manual.link.decision_key = "manual-decision".into();
    manual.host_run_id = "manual-run".into();
    store.claim_executor_receipt(&manual).await.unwrap();
    reject(&store, &manual, false).await;
    let mut switched = manual.clone();
    switched.account_id = Some("account-b".into());
    assert!(!store
        .claim_executor_receipt_with_routing(&switched, true)
        .await
        .unwrap());
}
