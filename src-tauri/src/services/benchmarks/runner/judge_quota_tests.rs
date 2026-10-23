//! Known quota before a judge starts parks the sealed answer, not a paid
//! abstention. Every account, answer and clock change in this module is invented.
use super::tests::{request, setup};
use super::*;
use std::sync::atomic::Ordering;

fn judge(provider: &str, model: &str, account: &str) -> Configuration {
    Configuration {
        id: format!("invented-{provider}-{model}-{account}"),
        provider_id: provider.into(),
        account_id: Some(account.into()),
        model_id: model.into(),
        effort: Some("high".into()),
        fast_mode: Some(false),
        billing_mode: "subscription".into(),
        execution_profile: "native_text".into(),
        inventory_revision: Some("invented-runtime".into()),
        model_name: None,
    }
}

fn brief() -> BenchmarkDraft {
    let mut draft = seed_definitions()
        .into_iter()
        .find(|draft| draft.work_class_id == "creative")
        .unwrap();
    draft.name = "Invented delayed panel".into();
    draft.split = "train".into();
    draft
}

#[test]
fn judge_quota_missing_eligible_seat_waits_for_its_reset() {
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let ready = judge("claude-acp", "invented-judge-a", "ready");
    let blocked = judge("codex-acp", "invented-judge-b", "limited");
    let until = now() + 2 * 24 * 60 * 60 * 1000;
    let error = resolve_quota_panel(
        vec![ready],
        &[&candidate],
        &brief(),
        vec![(until, blocked)],
        None,
    )
    .unwrap_err();
    assert_eq!(error.code, JUDGE_QUOTA_WAIT);
    assert_eq!(error.details.unwrap()["nextReset"], until);
    assert!(!unstarted_refusal(&judge_quota_wait(Some(until))));
}

#[test]
fn judge_quota_optional_seats_do_not_delay_a_sufficient_panel() {
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let panel = vec![
        judge("claude-acp", "invented-judge-a", "ready"),
        judge("codex-acp", "invented-judge-b", "ready"),
    ];
    let found = resolve_quota_panel(
        panel.clone(),
        &[&candidate],
        &brief(),
        vec![(now() + QUOTA_RETRY_MS, candidate.clone())],
        Some(BenchmarkError::new(
            "resource_busy",
            "Invented optional listing",
        )),
    )
    .unwrap();
    assert_eq!(found, panel);
}

#[test]
fn judge_quota_ineligible_authors_duplicates_and_unknown_candidates_do_not_wait() {
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let ready = judge("claude-acp", "invented-judge-a", "ready");
    let mut duplicate = ready.clone();
    duplicate.id = "invented-other-account".into();
    duplicate.account_id = Some("limited".into());
    let until = now() + QUOTA_RETRY_MS;
    let found = resolve_quota_panel(
        vec![ready.clone()],
        &[&candidate],
        &brief(),
        vec![(until, duplicate)],
        None,
    )
    .unwrap();
    assert_eq!(found, vec![ready.clone()]);

    let author = judge("codex-acp", "invented-author", "limited");
    let mut authored = brief();
    authored.environment["authoredBy"] = json!([author]);
    let found = resolve_quota_panel(
        vec![ready.clone()],
        &[&candidate],
        &authored,
        vec![(until, author.clone())],
        None,
    )
    .unwrap();
    assert_eq!(found, vec![ready.clone()]);

    let unknown = judge("invented-unknown-provider", "candidate", "candidate");
    assert!(resolve_quota_panel(
        Vec::new(),
        &[&unknown],
        &brief(),
        vec![(until, ready), (until, author)],
        None,
    )
    .unwrap()
    .is_empty());
}

#[test]
fn judge_quota_keeps_own_model_and_same_lab_fallback_policy() {
    let candidate = judge("claude-acp", "invented-judge-a", "candidate");
    let other = judge("claude-acp", "invented-judge-b", "limited");
    let until = now() + QUOTA_RETRY_MS;
    let error = resolve_quota_panel(
        vec![candidate.clone()],
        &[&candidate],
        &brief(),
        vec![(until, other)],
        None,
    )
    .unwrap_err();
    assert_eq!(error.code, JUDGE_QUOTA_WAIT);
    assert_eq!(error.details.unwrap()["nextReset"], until);
}

#[test]
fn judge_quota_waits_for_the_first_reset_that_can_complete_the_panel() {
    let candidate = judge("grok-acp", "invented-candidate", "candidate");
    let first = judge("claude-acp", "invented-judge-a", "first");
    let mut duplicate = first.clone();
    duplicate.id = "invented-duplicate".into();
    duplicate.account_id = Some("duplicate".into());
    let second = judge("codex-acp", "invented-judge-b", "second");
    let soon = now() + QUOTA_RETRY_MS;
    let later = soon + QUOTA_RETRY_MS;
    let error = resolve_quota_panel(
        Vec::new(),
        &[&candidate],
        &brief(),
        vec![(later, second), (soon, first), (soon + 1, duplicate)],
        None,
    )
    .unwrap_err();
    assert_eq!(error.details.unwrap()["nextReset"], later);
}

#[test]
fn judge_quota_only_calibrated_allowed_accounts_and_efforts_can_defer() {
    let configuration = judge("codex-acp", "invented-judge", "allowed");
    let row = InventoryModel {
        configuration: configuration.clone(),
        name: "Invented judge".into(),
        efforts: vec!["high".into()],
        supports_fast_mode: false,
        available: true,
        reason: None,
    };
    let entry = super::super::judge_pool::Entry {
        provider_id: configuration.provider_id.clone(),
        model_id: configuration.model_id.clone(),
        effort: configuration.effort.clone(),
        inputs: None,
        accounts: Some(vec!["allowed".into()]),
        disclosure_confirmed: false,
    };
    let until = now() + QUOTA_RETRY_MS;
    assert_eq!(
        quota_seats(
            std::slice::from_ref(&entry),
            vec![(until, row.clone())],
            &[]
        ),
        vec![(until, configuration)]
    );
    assert!(quota_seats(&[], vec![(until, row.clone())], &[]).is_empty());
    for invalid in 0..4 {
        let mut invalid_row = row.clone();
        match invalid {
            0 => invalid_row.configuration.account_id = Some("unapproved".into()),
            1 => invalid_row.efforts.clear(),
            2 => invalid_row.configuration.model_id = "uncalibrated-model".into(),
            _ => invalid_row.configuration.fast_mode = Some(true),
        }
        assert!(quota_seats(
            std::slice::from_ref(&entry),
            vec![(until, invalid_row)],
            &[],
        )
        .is_empty());
    }
}

#[test]
fn judge_quota_unknown_or_expired_reset_uses_a_bounded_recheck() {
    let before = now();
    for reset in [None, Some(before - 1)] {
        let error = judge_quota_wait(reset);
        let until = error.details.unwrap()["nextReset"].as_i64().unwrap();
        assert!(until >= before + QUOTA_RETRY_MS);
        assert!(until <= now() + QUOTA_RETRY_MS);
    }
}

async fn creative_request(service: &BenchmarkService) -> RunRequest {
    let definition = service.store.save_draft(None, None, brief()).await.unwrap();
    let version = service.store.publish(&definition.id, 1).await.unwrap();
    let mut request = request(service).await;
    request.request_key = "invented-quota-panel".into();
    request.version_ids = vec![version.id];
    request.repetitions = 1;
    request.max_executions = 4;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    request
}

async fn tick(service: &Arc<BenchmarkService>) {
    tokio::time::timeout(Duration::from_secs(10), service.tick())
        .await
        .expect("a known judge reset must never be awaited by a flight")
        .unwrap();
}

fn seal(attempt: &Attempt) -> Value {
    json!({"output":attempt.output,"evidence":attempt.evidence_hash,
        "session":attempt.session_id,"hostRun":attempt.host_run_id,
        "usage":attempt.usage,"observed":attempt.observed,
        "evaluations":attempt.evaluations})
}

async fn released(service: &BenchmarkService) {
    assert!(service.active.lock().await.is_empty());
    let scope = service.store.root.display().to_string();
    assert!(admission_window::has_room(&scope));
    assert!(admission_window::remaining(&scope).is_zero());
}

#[tokio::test]
async fn judge_quota_persists_across_restart_without_replaying_paid_generation() {
    let (dir, service, backend) = setup().await;
    let until = now() + 2 * 24 * 60 * 60 * 1000;
    backend.judge_quota_until.store(until, Ordering::SeqCst);
    let run = service
        .start_run(creative_request(&service).await)
        .await
        .unwrap();
    tick(&service).await;
    let waiting = service.store.attempt(&run.attempts[0].id).await.unwrap();
    assert_eq!(waiting.phase, AWAITING_JUDGES);
    assert_eq!(waiting.reason.as_deref(), Some(JUDGE_QUOTA_REASON));
    assert_eq!(waiting.wait_until, Some(until));
    assert!(waiting.output.is_some());
    assert!(waiting.evidence_hash.is_some());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
    assert_eq!(backend.judge_quota_refusals.load(Ordering::SeqCst), 1);
    released(&service).await;
    let sealed = seal(&waiting);

    let restarted = Arc::new(BenchmarkService {
        store: service.store.clone(),
        backend: backend.clone(),
        wake: tokio::sync::Notify::new(),
        active: Default::default(),
        queries: Default::default(),
        app: None,
    });
    for _ in 0..3 {
        tick(&restarted).await;
    }
    let still_waiting = restarted.store.attempt(&waiting.id).await.unwrap();
    assert_eq!(still_waiting.wait_until, Some(until));
    assert_eq!(seal(&still_waiting), sealed);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
    assert_eq!(backend.judge_quota_refusals.load(Ordering::SeqCst), 1);
    released(&restarted).await;

    // Advance only the invented provider and persisted queue clock.
    backend.judge_quota_until.store(0, Ordering::SeqCst);
    let mut ready = still_waiting;
    ready.wait_until = Some(now() - 1);
    restarted.store.save_attempt(&ready).await.unwrap();
    tick(&restarted).await;
    let finished = restarted.store.attempt(&waiting.id).await.unwrap();
    assert_eq!(finished.phase, "terminal");
    assert_eq!(finished.wait_until, None);
    assert_eq!(seal(&finished), sealed);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    assert_eq!(backend.judge_quota_refusals.load(Ordering::SeqCst), 1);
    released(&restarted).await;
    dir.close().await;
}

#[tokio::test]
async fn judge_quota_keeps_partial_votes_and_does_not_hold_other_candidates() {
    let (dir, service, backend) = setup().await;
    let until = now() + 2 * 24 * 60 * 60 * 1000;
    backend.judge_quota_until.store(until, Ordering::SeqCst);
    let run = service
        .start_run(creative_request(&service).await)
        .await
        .unwrap();
    tick(&service).await;
    let mut waiting = service.store.attempt(&run.attempts[0].id).await.unwrap();
    let version = service.store.version(&waiting.version_id).await.unwrap();
    let first = judge("claude-acp", "invented-judge-a", "ready");
    let second = judge("codex-acp", "invented-judge-b", "limited");
    let mut marker = judge_abstention(&version, &first, "invented-batch", String::new());
    marker.provenance = "render".into();
    marker.verdict = "rendered".into();
    marker.judge = None;
    marker.artifacts = vec![Artifact {
        kind: "text".into(),
        path: "invented-response.txt".into(),
        hash: "invented-sealed-response".into(),
        label: "Response".into(),
    }];
    marker.details = Some(json!({"judgeBatchId":"invented-batch", "expectedJudges":2,
        "protocol":{"panel":[first,second],"expectedJudges":2,
            "prompt":"invented-scoring-instructions","renderer":"text"}}));
    let mut vote = judge_abstention(&version, &first, "invented-batch", String::new());
    vote.provenance = "judge".into();
    vote.verdict = "scored".into();
    vote.score = Some(0.75);
    vote.usage = Some(TokenUsage {
        input: Some(17),
        output: Some(9),
        ..Default::default()
    });
    vote.details = Some(
        json!({"judgeBatchId":"invented-batch", "sessionId":"invented-paid-judge",
        "requestKey":"invented-judge-request", "usageComplete":true}),
    );
    waiting.evaluations.extend([marker, vote]);
    assert_eq!(super::super::analysis::score(&waiting), None);
    waiting.wait_until = Some(now() - 1);
    service.store.save_attempt(&waiting).await.unwrap();
    let sealed = seal(&waiting);

    // The next unpaid seat still has no quota. Existing votes are kept byte
    // for byte, with no synthetic abstention or candidate generation.
    tick(&service).await;
    let waiting = service.store.attempt(&waiting.id).await.unwrap();
    assert_eq!(waiting.phase, AWAITING_JUDGES);
    assert_eq!(waiting.wait_until, Some(until));
    assert_eq!(seal(&waiting), sealed);
    let open = recoverable_open_batch(
        &waiting.evaluations,
        "invented-scoring-instructions",
        "text",
        &[],
    )
    .unwrap();
    assert_eq!(open.id, "invented-batch");
    assert_eq!(open.asked, vec![first]);
    assert_eq!(seat_samples(&open.panel, 1, &open.asked), vec![(1, second)]);
    assert!(
        recoverable_open_batch(&waiting.evaluations, "different instructions", "text", &[])
            .is_none()
    );

    let mut objective = request(&service).await;
    objective.request_key = "invented-objective-during-judge-quota".into();
    objective.repetitions = 1;
    objective.max_executions = 1;
    let next = service.start_run(objective).await.unwrap();
    tick(&service).await;
    let completed = service.store.attempt(&next.attempts[0].id).await.unwrap();
    assert_eq!(completed.outcome.as_deref(), Some("pass"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
    assert_eq!(backend.judge_quota_refusals.load(Ordering::SeqCst), 2);
    assert_eq!(
        seal(&service.store.attempt(&waiting.id).await.unwrap()),
        sealed
    );
    released(&service).await;
    dir.close().await;
}

#[tokio::test]
async fn judge_quota_sealed_answer_keeps_its_sitting_open_beyond_a_day() {
    let (dir, service, backend) = setup().await;
    let until = now() + 2 * 24 * 60 * 60 * 1000;
    backend.judge_quota_until.store(until, Ordering::SeqCst);
    let run = service
        .start_run(creative_request(&service).await)
        .await
        .unwrap();
    tick(&service).await;
    let waiting = service.store.attempt(&run.attempts[0].id).await.unwrap();
    let sealed = seal(&waiting);
    sqlx::query("UPDATE run_plans SET created_at=? WHERE id=?")
        .bind(now() - super::super::analysis::RUN_WINDOW_MS - 1_000)
        .bind(&run.id)
        .execute(&service.store.pool)
        .await
        .unwrap();
    tick(&service).await;
    let current = service.store.run(&run.id).await.unwrap();
    assert_eq!(current.state, "running");
    assert!(current.baked_at.is_none());
    let waiting = service.store.attempt(&waiting.id).await.unwrap();
    assert_eq!(waiting.phase, AWAITING_JUDGES);
    assert_eq!(waiting.wait_until, Some(until));
    assert_eq!(seal(&waiting), sealed);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.judge_quota_refusals.load(Ordering::SeqCst), 1);
    released(&service).await;
    dir.close().await;
}

#[tokio::test]
async fn judge_quota_wait_can_pause_recheck_and_cancel_without_losing_evidence() {
    let (dir, service, backend) = setup().await;
    let until = now() + 2 * 24 * 60 * 60 * 1000;
    backend.judge_quota_until.store(until, Ordering::SeqCst);
    let run = service
        .start_run(creative_request(&service).await)
        .await
        .unwrap();
    tick(&service).await;
    let waiting = service.store.attempt(&run.attempts[0].id).await.unwrap();
    let sealed = seal(&waiting);
    service.control(&run.id, "pause").await.unwrap();
    tick(&service).await;
    assert_eq!(service.store.run(&run.id).await.unwrap().state, "paused");
    released(&service).await;

    service.control(&run.id, "resume").await.unwrap();
    let resumed = service.store.run(&run.id).await.unwrap();
    assert_eq!(resumed.attempts.len(), 1);
    assert_eq!(resumed.attempts[0].id, waiting.id);
    assert!(!resumed.request.automatic_retry());
    assert_eq!(
        service.store.attempt(&waiting.id).await.unwrap().wait_until,
        None
    );
    tick(&service).await;
    assert_eq!(
        service.store.attempt(&waiting.id).await.unwrap().wait_until,
        Some(until)
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
    assert_eq!(backend.judge_quota_refusals.load(Ordering::SeqCst), 2);

    service.control(&run.id, "cancel").await.unwrap();
    tick(&service).await;
    let cancelled = service.store.attempt(&waiting.id).await.unwrap();
    assert_eq!(cancelled.phase, "terminal");
    assert_eq!(cancelled.reason.as_deref(), Some(JUDGING_STOPPED));
    assert_eq!(seal(&cancelled), sealed);
    assert_eq!(service.store.run(&run.id).await.unwrap().state, "cancelled");
    assert_eq!(
        service.control(&run.id, "resume").await.unwrap_err().code,
        "retry_forbidden"
    );
    released(&service).await;
    dir.close().await;
}

#[tokio::test]
async fn judge_quota_resume_never_reopens_terminal_uncertain_or_unsealed_receipts() {
    let (dir, service, backend) = setup().await;
    backend
        .judge_quota_until
        .store(now() + QUOTA_RETRY_MS, Ordering::SeqCst);
    let run = service
        .start_run(creative_request(&service).await)
        .await
        .unwrap();
    tick(&service).await;
    service.control(&run.id, "pause").await.unwrap();
    tick(&service).await;
    let original = service.store.attempt(&run.attempts[0].id).await.unwrap();
    for invalid in 0..4 {
        let mut receipt = original.clone();
        match invalid {
            0 => receipt.phase = "terminal".into(),
            1 => receipt.evidence_hash = None,
            2 => receipt.outcome = Some("dispatch_uncertain".into()),
            _ => receipt.phase = "pending".into(), // Already started, never a fresh slot.
        }
        service.store.save_attempt(&receipt).await.unwrap();
        let before = serde_json::to_value(&receipt).unwrap();
        assert_eq!(
            service.control(&run.id, "resume").await.unwrap_err().code,
            "retry_forbidden"
        );
        let saved = service.store.attempt(&receipt.id).await.unwrap();
        assert_eq!(serde_json::to_value(saved).unwrap(), before);
        let stopped = service.store.run(&run.id).await.unwrap();
        assert_eq!(stopped.state, "paused");
        assert_eq!(stopped.attempts.len(), 1);
        assert_eq!(stopped.attempts[0].id, original.id);
        assert!(!stopped.request.automatic_retry());
    }
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
    released(&service).await;
    dir.close().await;
}
