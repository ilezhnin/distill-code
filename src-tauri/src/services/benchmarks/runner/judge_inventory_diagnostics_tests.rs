//! Inventory fallback/partial discovery must not erase refused setup attempts.
use super::*;

async fn fixture() -> (
    crate::test_support::TempRoot,
    Arc<BenchmarkService>,
    Attempt,
) {
    let (directory, service, _) = tests::setup().await;
    let request = tests::request(&service).await;
    let run = service.start_run(request).await.unwrap();
    let mut attempt = service.store.attempt(&run.attempts[0].id).await.unwrap();
    attempt.output = Some("Invented sealed answer".into());
    attempt.evidence_hash = Some("invented-sealed-hash".into());
    attempt.phase = "awaiting_judges".into();
    service.store.save_attempt(&attempt).await.unwrap();
    (directory, service, attempt)
}

fn full_panel(attempt: &Attempt, error: &BenchmarkError) -> DiscoveredJudgePanel {
    let mut first = attempt.configuration.clone();
    first.provider_id = "claude-acp".into();
    let mut second = first.clone();
    second.provider_id = "grok-acp".into();
    let issue = JudgeDiscoveryIssue::from_error("claude-acp", Some("invented-account"), error);
    DiscoveredJudgePanel::discovered(vec![first, second], issue.into_iter().collect(), &[])
}

#[tokio::test]
async fn judge_inventory_diagnostics_keep_refused_refresh_without_changing_cached_full_panel() {
    let (directory, service, attempt) = fixture().await;
    let before = serde_json::to_value(service.store.attempt(&attempt.id).await.unwrap()).unwrap();
    let listing = json!({"models":[{"modelId":"invented-judge"}]});
    let result = judge_inventory(
        Some(ListingAge {
            age: Duration::from_secs(2 * 3600),
            refused_ago: None,
            inventory: listing.clone(),
        }),
        async {
            Err(BenchmarkError::new(
                "resource_busy",
                "Invented CPU admission refusal",
            ))
        },
    )
    .await;
    let (listed, refused) = preserve_judge_listing(
        Some((&service.store, &attempt)),
        "claude-acp",
        "invented-account",
        result,
    )
    .await
    .unwrap();
    assert_eq!(listed, listing);
    let (_, error) = refused.unwrap();
    assert!(full_panel(&attempt, &error).issue(false).is_none());
    let page = service
        .store
        .diagnostics(&attempt.id, None, 100)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].stage, "judge_inventory_refresh");
    assert_eq!(page.items[0].code, "resource_busy");
    assert_eq!(page.items[0].message, "Invented CPU admission refusal");
    assert_eq!(page.items[0].context["providerId"], "claude-acp");
    assert_eq!(page.items[0].context["accountId"], "invented-account");
    assert_eq!(page.items[0].context["dispatched"], false);
    assert_eq!(
        serde_json::to_value(service.store.attempt(&attempt.id).await.unwrap()).unwrap(),
        before
    );
    directory.close().await;
}

#[tokio::test]
async fn judge_inventory_diagnostics_keep_optional_account_refusal_with_sufficient_other_seats() {
    let (directory, service, attempt) = fixture().await;
    let original = BenchmarkError::new("capability_missing", "Invented policy proof unavailable");
    let result = judge_inventory(None, async { Err(original.clone()) }).await;
    let error = preserve_judge_listing(
        Some((&service.store, &attempt)),
        "claude-acp",
        "invented-account",
        result,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, original.code);
    assert_eq!(error.message, original.message);
    let panel = full_panel(&attempt, &error);
    assert_eq!(panel.seats.len(), MIN_JUDGES);
    assert!(panel.issue(false).is_none());
    // Successful panel construction discards its short-panel labels, but the
    // exact original refusal has already been durably recorded.
    assert!(panel.diagnostics.is_empty());
    let page = service
        .store
        .diagnostics(&attempt.id, None, 100)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].stage, "judge_inventory_listing");
    assert_eq!(page.items[0].message, original.message);
    directory.close().await;
}

#[tokio::test]
async fn judge_inventory_diagnostics_keep_unavailable_native_row_before_panel_selection() {
    let (directory, service, attempt) = fixture().await;
    let judge = attempt.configuration.clone();
    let original = BenchmarkError::new("capability_missing", "Invented native runtime unavailable");
    let error = preserve_judge_discovery_refusal(
        Some((&service.store, &attempt)),
        &judge.provider_id,
        judge.account_id.as_deref().unwrap_or_default(),
        "judge_inventory_readiness",
        original.clone(),
        Some(&judge),
    )
    .await
    .unwrap();
    assert_eq!(error.message, original.message);
    assert!(full_panel(&attempt, &error).issue(false).is_none());
    let page = service
        .store
        .diagnostics(&attempt.id, None, 100)
        .await
        .unwrap();
    assert_eq!(
        page.items[0].judge.as_ref().unwrap().model_id,
        judge.model_id
    );
    assert_eq!(page.items[0].message, original.message);
    directory.close().await;
}

#[tokio::test]
async fn judge_inventory_diagnostics_failed_journal_cannot_hide_behind_cached_success() {
    let (directory, service, attempt) = fixture().await;
    let before = serde_json::to_value(service.store.attempt(&attempt.id).await.unwrap()).unwrap();
    sqlx::query("CREATE TRIGGER refuse_inventory_diagnostic BEFORE INSERT ON attempt_diagnostics BEGIN SELECT RAISE(FAIL,'invented inventory journal failure'); END")
        .execute(&service.store.pool).await.unwrap();
    let result = Ok((
        json!({"models":[]}),
        Some((
            Duration::from_secs(7200),
            BenchmarkError::new("resource_busy", "Original invented memory refusal"),
        )),
    ));
    let error = preserve_judge_listing(
        Some((&service.store, &attempt)),
        "claude-acp",
        "invented-account",
        result,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "resource_busy");
    assert!(error.message.contains("Original invented memory refusal"));
    assert!(error
        .message
        .contains("Diagnostic history could not be saved"));
    assert_eq!(error.details.unwrap()["diagnosticPersistenceFailed"], true);
    assert_eq!(
        serde_json::to_value(service.store.attempt(&attempt.id).await.unwrap()).unwrap(),
        before
    );
    directory.close().await;
}
