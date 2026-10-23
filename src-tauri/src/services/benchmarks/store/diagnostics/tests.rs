use super::*;
use crate::test_support::TempRoot;

async fn fixture() -> (TempRoot, Store, Attempt) {
    let directory = TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = super::super::super::seeds::definitions().remove(0);
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let config: Configuration = serde_json::from_value(json!({
        "id":"invented-candidate", "providerId":"example-provider", "accountId":"example-account",
        "modelId":"example-model", "effort":"low", "fastMode":false,
        "billingMode":"subscription", "executionProfile":"native_text", "inventoryRevision":"example-v1"
    })).unwrap();
    let request = json!({"requestKey":"diagnostics-fixture","versionIds":[version.id],
        "configurations":[config],"repetitions":1,"timeoutSeconds":30,"maxExecutions":10});
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('diagnostics-fixture','diagnostics-fixture','running',1,0,0,?)")
        .bind(request.to_string()).execute(&store.pool).await.unwrap();
    let mut attempt =
        super::super::super::pending_attempt("diagnostics-fixture", &version.id, &config, 0);
    attempt.output = Some("INVENTED_PRIVATE_CANDIDATE_OUTPUT".repeat(2048));
    attempt.evidence_hash = Some("invented-sealed-evidence".into());
    store.insert_attempt(&attempt).await.unwrap();
    (directory, store, attempt)
}

async fn emit(store: &Store, attempt: &Attempt, message: &str) {
    store
        .record_diagnostic(
            attempt,
            "judge_session",
            &BenchmarkError::new("resource_busy", message),
            Some(&attempt.configuration),
            json!({"jobId":"invented-job","dispatched":false}),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn diagnostics_preserve_legacy_reason_overwrites_cancellation_and_reopen() {
    let (directory, store, mut attempt) = fixture().await;
    // Simulate a pre-migration row: the first save must preserve the old cause
    // before replacing it, without reading its large output into the journal.
    sqlx::query(
        "UPDATE attempts SET data_json=json_set(data_json,'$.reason','Old RAM refusal') WHERE id=?",
    )
    .bind(&attempt.id)
    .execute(&store.pool)
    .await
    .unwrap();
    attempt.phase = "awaiting_judges".into();
    attempt.reason = Some("Waiting for preparation capacity".into());
    store.save_attempt(&attempt).await.unwrap();
    store.save_attempt(&attempt).await.unwrap();
    let first = store.diagnostics(&attempt.id, None, 100).await.unwrap();
    assert_eq!(first.items.len(), 2);
    assert!(first.items.iter().all(|item| item.occurrences == 1));
    assert_eq!(first.items[1].message, "Old RAM refusal");
    assert_eq!(first.items[1].phase, "pending");
    attempt.reason = None;
    store.save_attempt(&attempt).await.unwrap();
    let mut stale = attempt.clone();
    stale.phase = "terminal".into();
    stale.outcome = Some("cancelled".into());
    stale.reason = Some("Run cancelled".into());
    store
        .set_run_state(&attempt.run_id, "cancelled")
        .await
        .unwrap();
    store.save_attempt(&stale).await.unwrap();
    let before = store.diagnostics(&attempt.id, None, 100).await.unwrap();
    assert_eq!(before.items.len(), 4);
    assert_eq!(before.items[1].code, "reason_cleared");
    let saved = store.attempt(&attempt.id).await.unwrap();
    assert_eq!(saved.output, attempt.output);
    assert_eq!(saved.evidence_hash, attempt.evidence_hash);
    store.pool.close().await;
    let reopened = Store::open(directory.path()).await.unwrap();
    directory.register(&reopened.pool);
    assert_eq!(
        reopened.diagnostics(&attempt.id, None, 100).await.unwrap(),
        before
    );
    directory.close().await;
}

#[tokio::test]
async fn diagnostics_concurrent_identical_events_coalesce_only_consecutively_per_attempt() {
    let (directory, store, attempt) = fixture().await;
    let mut workers = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let store = store.clone();
        let attempt = attempt.clone();
        workers.spawn(async move {
            emit(&store, &attempt, "RAM admission refused").await;
        });
    }
    while let Some(result) = workers.join_next().await {
        result.unwrap();
    }
    let page = store.diagnostics(&attempt.id, None, 100).await.unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].occurrences, 16);
    assert!(page.items[0].last_at >= page.items[0].first_at);
    let mut other = attempt.clone();
    other.id = "another-invented-attempt".into();
    other.repetition = 1;
    store.insert_attempt(&other).await.unwrap();
    emit(&store, &other, "Other attempt refusal").await;
    emit(&store, &attempt, "RAM admission refused").await;
    assert_eq!(
        store
            .diagnostics(&attempt.id, None, 100)
            .await
            .unwrap()
            .items[0]
            .occurrences,
        17
    );
    emit(&store, &attempt, "CPU admission refused").await;
    emit(&store, &attempt, "RAM admission refused").await;
    let page = store.diagnostics(&attempt.id, None, 100).await.unwrap();
    assert_eq!(page.items.len(), 3);
    assert_eq!(
        page.items.iter().map(|v| v.occurrences).collect::<Vec<_>>(),
        vec![1, 1, 17]
    );
    assert!(page.items.windows(2).all(|v| v[0].sequence > v[1].sequence));
    directory.close().await;
}

#[tokio::test]
async fn diagnostics_pagination_bounds_reads_without_losing_any_distinct_cause() {
    let (directory, store, attempt) = fixture().await;
    for index in 0..105 {
        emit(&store, &attempt, &format!("Invented refusal {index}")).await;
    }
    let first = store
        .diagnostics(&attempt.id, None, u32::MAX)
        .await
        .unwrap();
    assert_eq!(first.items.len(), 100);
    assert_eq!(first.items[0].message, "Invented refusal 104");
    assert_eq!(first.next_before, Some(first.items[99].sequence));
    let next = store
        .diagnostics(&attempt.id, first.next_before, 100)
        .await
        .unwrap();
    assert_eq!(next.items.len(), 5);
    assert_eq!(next.items[4].message, "Invented refusal 0");
    assert!(next.next_before.is_none());
    assert_eq!(
        store
            .diagnostics(&attempt.id, None, 0)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    directory.close().await;
}

#[tokio::test]
async fn diagnostics_workflow_children_keep_their_own_reasons_and_evidence() {
    let (directory, store, root) = fixture().await;
    let mut child = root.clone();
    child.id = "invented-workflow-child".into();
    child.reason = Some("Child legacy resource refusal".into());
    sqlx::query("INSERT INTO workflow_steps(attempt_id,root_attempt_id,step_index,step_id,entry_state_hash,entry_state_json,prompt,phase,data_json) VALUES(?,?,0,'step','sealed-entry','{}','INVENTED_PRIVATE_PROMPT',?,?)")
        .bind(&child.id).bind(&root.id).bind(&child.phase).bind(serde_json::to_string(&child).unwrap())
        .execute(&store.pool).await.unwrap();
    child.reason = Some("Child quota reset pending".into());
    store.save_attempt(&child).await.unwrap();
    let page = store.diagnostics(&child.id, None, 100).await.unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(page
        .items
        .iter()
        .all(|item| item.attempt_id == child.id && item.run_id == root.run_id));
    assert!(store
        .diagnostics(&root.id, None, 100)
        .await
        .unwrap()
        .items
        .is_empty());
    assert_eq!(store.attempt(&child.id).await.unwrap().output, child.output);
    let encoded = serde_json::to_string(&page).unwrap();
    assert!(!encoded.contains("INVENTED_PRIVATE"));
    directory.close().await;
}

#[tokio::test]
async fn diagnostics_write_failure_rolls_back_the_attempt_and_propagates_error() {
    let (directory, store, mut attempt) = fixture().await;
    let before = store.attempt(&attempt.id).await.unwrap();
    sqlx::query("CREATE TRIGGER diagnostics_fixture_refusal BEFORE INSERT ON attempt_diagnostics BEGIN SELECT RAISE(ABORT,'invented journal unavailable'); END")
        .execute(&store.pool).await.unwrap();
    attempt.reason = Some("Important original refusal".into());
    attempt.phase = "awaiting_judges".into();
    let error = store.save_attempt(&attempt).await.unwrap_err();
    assert_eq!(error.code, "storage_unavailable");
    assert!(error.message.contains("invented journal unavailable"));
    assert_eq!(
        serde_json::to_value(store.attempt(&attempt.id).await.unwrap()).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    assert_eq!(
        store
            .record_diagnostic(
                &attempt,
                "judge_session",
                &BenchmarkError::new("resource_busy", "Original refusal"),
                None,
                json!({})
            )
            .await
            .unwrap_err()
            .code,
        "storage_unavailable"
    );
    assert!(store
        .diagnostics(&attempt.id, None, 100)
        .await
        .unwrap()
        .items
        .is_empty());
    directory.close().await;
}

#[tokio::test]
async fn diagnostics_redact_secrets_bound_strings_and_exclude_payloads() {
    let (directory, store, attempt) = fixture().await;
    let error = BenchmarkError::new(
        "resource_busy",
        "token=fixture-secret; RAM admission refused",
    )
    .with_details(json!({"prompt":"INVENTED_PRIVATE_PROMPT","output":"INVENTED_PRIVATE_OUTPUT"}));
    store.record_diagnostic(&attempt,"judge_session",&error,None,json!({
        "prompt":"INVENTED_PRIVATE_PROMPT","output":"INVENTED_PRIVATE_OUTPUT","tokens":123,
        "jobId":"token=fixture-job-secret", "dispatched":false,
        "resourceSnapshot":{"availableBytes":123456,"providerOutput":"INVENTED_PRIVATE_OUTPUT"}
    })).await.unwrap();
    let page = store.diagnostics(&attempt.id, None, 100).await.unwrap();
    let encoded = serde_json::to_string(&page).unwrap();
    assert!(!encoded.contains("fixture-secret"));
    assert!(!encoded.contains("fixture-job-secret"));
    assert!(!encoded.contains("INVENTED_PRIVATE"));
    assert!(!encoded.contains("tokens"));
    assert!(page.items[0].message.contains("[redacted]"));
    assert_eq!(
        page.items[0].context["resourceSnapshot"],
        json!({"availableBytes":123456})
    );
    assert!(page.items[0].context["appVersion"].is_string());
    for suffix in ["one", "two"] {
        emit(
            &store,
            &attempt,
            &format!("{} {suffix}", "拒绝".repeat(3000)),
        )
        .await;
    }
    let page = store.diagnostics(&attempt.id, None, 100).await.unwrap();
    assert_eq!(page.items.len(), 3);
    assert_eq!(page.items[0].message, page.items[1].message);
    assert!(page.items[0].message.len() <= MAX_MESSAGE_BYTES);
    assert!(page.items[0].message.ends_with("...[truncated]"));
    directory.close().await;
}

#[tokio::test]
async fn diagnostics_stale_concurrent_saves_preserve_each_observed_reason() {
    let (directory, store, attempt) = fixture().await;
    let mut workers = tokio::task::JoinSet::new();
    for message in ["CPU refusal", "RAM refusal", "Quota refusal"] {
        let store = store.clone();
        let mut attempt = attempt.clone();
        attempt.reason = Some(message.into());
        workers.spawn(async move {
            store.save_attempt(&attempt).await.unwrap();
        });
    }
    while let Some(result) = workers.join_next().await {
        result.unwrap();
    }
    let page = store.diagnostics(&attempt.id, None, 100).await.unwrap();
    let mut messages: Vec<_> = page
        .items
        .iter()
        .map(|item| item.message.as_str())
        .collect();
    messages.sort();
    assert_eq!(
        messages,
        vec!["CPU refusal", "Quota refusal", "RAM refusal"]
    );
    assert_eq!(
        store.attempt(&attempt.id).await.unwrap().output,
        attempt.output
    );
    directory.close().await;
}

#[tokio::test]
async fn diagnostics_superseding_preserves_prior_cause_without_rewriting_paid_output() {
    let (directory, store, mut attempt) = fixture().await;
    attempt.reason = Some("Specific original admission refusal".into());
    store.save_attempt(&attempt).await.unwrap();
    let output = attempt.output.take(); // A summary has no sealed output.
    attempt.phase = "terminal".into();
    attempt.outcome = Some("superseded".into());
    attempt.reason = Some("Sitting sealed".into());
    store.supersede_attempt(&attempt).await.unwrap();
    let page = store.diagnostics(&attempt.id, None, 100).await.unwrap();
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.items[0].message, "Sitting sealed");
    assert_eq!(page.items[1].message, "Specific original admission refusal");
    assert_eq!(store.attempt(&attempt.id).await.unwrap().output, output);
    directory.close().await;
}

#[tokio::test]
async fn diagnostics_do_not_merge_changes_in_phase_judge_stage_or_context() {
    let (directory, store, mut attempt) = fixture().await;
    let error = BenchmarkError::new("resource_busy", "Same resource refusal");
    for (phase, stage, judge, context) in [
        ("pending", "preparation", None, json!({"jobId":"one"})),
        (
            "awaiting_judges",
            "preparation",
            None,
            json!({"jobId":"one"}),
        ),
        (
            "awaiting_judges",
            "judge_session",
            None,
            json!({"jobId":"one"}),
        ),
        (
            "awaiting_judges",
            "judge_session",
            Some(attempt.configuration.clone()),
            json!({"jobId":"one"}),
        ),
        (
            "awaiting_judges",
            "judge_session",
            Some(attempt.configuration.clone()),
            json!({"jobId":"two"}),
        ),
    ] {
        attempt.phase = phase.into();
        store
            .record_diagnostic(&attempt, stage, &error, judge.as_ref(), context)
            .await
            .unwrap();
    }
    assert_eq!(
        store
            .diagnostics(&attempt.id, None, 100)
            .await
            .unwrap()
            .items
            .len(),
        5
    );
    // Qualification diagnostics need correlation, not a fabricated campaign.
    attempt.id = "invented-qualification-carrier".into();
    attempt.run_id = "invented-qualification".into();
    emit(&store, &attempt, "Qualification resource refusal").await;
    let page = store.diagnostics(&attempt.id, None, 100).await.unwrap();
    assert_eq!(page.items[0].run_id, attempt.run_id);
    directory.close().await;
}
