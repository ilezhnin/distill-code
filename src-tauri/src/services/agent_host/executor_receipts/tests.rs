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
