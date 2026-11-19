#[tokio::test]
async fn native_task_history_and_wave_prefixes_use_sealed_bytes_after_workspace_changes() {
    use crate::services::agent_host::store::{SessionRecord, SessionStore};
    let dir = crate::test_support::TempRoot::new();
    let database = dir.path().join("host.db");
    let store = SessionStore::open(&database).await.unwrap();
    dir.register(store.pool());
    let owner = OwnedSessionRequest {
        owner_id: "task:invented-repository".into(),
        provider_id: "claude-acp".into(),
        account_id: "invented-account".into(),
        model_id: "invented-model".into(),
        reasoning_effort: Some("high".into()),
        fast_mode: Some(false),
        cwd: dir.path().to_string_lossy().into_owned(),
        title: "Invented repository task".into(),
        profile: ExecutionProfile::ProtectedRepositoryV1,
    };
    let record = SessionRecord {
        id: "native-task".into(),
        harness: owner.provider_id.clone(),
        account_id: Some(owner.account_id.clone()),
        bridge_session_id: None,
        cwd: owner.cwd.clone(),
        title: Some(owner.title.clone()),
        user_set_name: false,
        project_id: None,
        persona_id: None,
        model_id: Some(owner.model_id.clone()),
        reasoning_effort: owner.reasoning_effort.clone(),
        fast_mode: owner.fast_mode,
        legacy_model_id: None,
        hidden: false,
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
        last_message_at: None,
        archived_at: None,
        message_count: 0,
        last_snippet: None,
        snapshot: None,
    };
    store
        .insert_owned_session_for_purpose(&record, &owner, "policy", "task")
        .await
        .unwrap();
    let dispatch = ExecutionDispatch {
        request_key: "owned-task:invented-repository".into(),
        session_id: record.id.clone(),
        run_id: "native-run".into(),
        user_message_id: "native-user".into(),
        phase: "reserved".into(),
        event_cursor: 0,
        result: None,
        error: None,
    };
    store
        .reserve_dispatch(&dispatch, "invented prompt")
        .await
        .unwrap();
    assert!(
        super::read_owned_task_output(&store, &dispatch.request_key, &record.id)
            .await
            .is_err()
    );
    let patch = dir.path().join("stopped-patch.diff");
    tokio::fs::write(
        &patch,
        "diff --git a/invented.txt b/invented.txt\n+first bounded output\n",
    )
    .await
    .unwrap();
    let output = tokio::fs::read_to_string(&patch).await.unwrap();
    let result = json!({"stopReason":"end_turn","nativeExecutionMs":1201});
    store
        .settle_task_dispatch(
            &dispatch.request_key,
            &record.id,
            Some(&result),
            None,
            Some(&output),
            1201,
        )
        .await
        .unwrap();
    let first = super::read_owned_task_output(&store, &dispatch.request_key, &record.id)
        .await
        .unwrap();
    tokio::fs::write(&patch, "+changed workspace output\n")
        .await
        .unwrap();
    // A later wave prefix rereads all earlier IDs. It receives the same
    // report and clock even after the stopped copy changes or disappears.
    let second_prefix = super::read_owned_task_output(&store, &dispatch.request_key, &record.id)
        .await
        .unwrap();
    tokio::fs::remove_file(&patch).await.unwrap();
    let third_prefix = super::read_owned_task_output(&store, &dispatch.request_key, &record.id)
        .await
        .unwrap();
    assert_eq!(
        first.text,
        super::super::workflow::committed_report(&output)
    );
    assert_eq!(second_prefix.text, first.text);
    assert_eq!(third_prefix.text, first.text);
    assert_eq!(third_prefix.elapsed_ms, 1201);
    assert!(store
        .settle_task_dispatch(
            &dispatch.request_key,
            &record.id,
            Some(&result),
            None,
            Some("changed"),
            1201
        )
        .await
        .is_err());
    let restarted = SessionStore::open(&database).await.unwrap();
    dir.register(restarted.pool());
    assert_eq!(
        super::read_owned_task_output(&restarted, &dispatch.request_key, &record.id)
            .await
            .unwrap()
            .text,
        first.text
    );
    // A v2 repository terminal carries a report separately from its
    // cumulative patch. Reopening reads only the immutable sealed value.
    let artifact = super::super::artifact_context::PublicResult {
        schema_version: 2,
        recipe: super::super::repository::ARTIFACT_RECIPE.into(),
        report: "Review passed without another patch".into(),
        artifact: super::super::repository::Artifact {
            recipe: super::super::repository::ARTIFACT_RECIPE.into(),
            root_tree: "a".repeat(40),
            before_tree: "b".repeat(40),
            after_tree: "b".repeat(40),
            patch: output.clone(),
            patch_hash: fixtures::hash(output.as_bytes()),
            archive_hash: fixtures::hash(b"invented immutable archive"),
        },
    };
    let envelope = artifact.encode(4096).unwrap();
    // Each owned session holds exactly one turn, so the review step owns
    // its own native session, as the wave consumer prepares it.
    let review_owner = OwnedSessionRequest {
        owner_id: "task:invented-review".into(),
        ..owner.clone()
    };
    let review_record = SessionRecord {
        id: "native-review-task".into(),
        ..record.clone()
    };
    store
        .insert_owned_session_for_purpose(&review_record, &review_owner, "policy", "task")
        .await
        .unwrap();
    let second_dispatch = ExecutionDispatch {
        request_key: "owned-task:invented-review".into(),
        session_id: review_record.id.clone(),
        run_id: "native-review-run".into(),
        user_message_id: "native-review-user".into(),
        phase: "reserved".into(),
        result: None,
        error: None,
        ..dispatch.clone()
    };
    store
        .reserve_dispatch(&second_dispatch, "Review the predecessor")
        .await
        .unwrap();
    store
        .settle_task_dispatch(
            &second_dispatch.request_key,
            &review_record.id,
            Some(&result),
            None,
            Some(&envelope),
            1201,
        )
        .await
        .unwrap();
    for native_store in [&store, &restarted] {
        let restored = super::read_owned_task_output(
            native_store,
            &second_dispatch.request_key,
            &review_record.id,
        )
        .await
        .unwrap();
        assert_eq!(
            restored.text,
            super::super::workflow::committed_report(&artifact.report)
        );
        assert_eq!(restored.repository_result.as_ref(), Some(&artifact));
    }
    assert!(store
        .settle_task_dispatch(
            &second_dispatch.request_key,
            &review_record.id,
            Some(&result),
            None,
            Some("rewritten"),
            1201
        )
        .await
        .is_err());
    // A sealed artifact does not authorize an uncertain dispatch. The
    // production reader also checks status in its own metadata join.
    store
        .settle_dispatch(
            &dispatch.request_key,
            "uncertain",
            None,
            Some(&json!({"kind":"dispatch_uncertain"})),
        )
        .await
        .unwrap();
    assert!(
        super::read_owned_task_output(&store, &dispatch.request_key, &record.id)
            .await
            .is_err()
    );
    assert!(store
        .task_public_result(&dispatch.request_key, &record.id)
        .await
        .is_err());
    assert!(store
        .settle_task_dispatch(
            &dispatch.request_key,
            &record.id,
            Some(&result),
            None,
            Some(&output),
            1201
        )
        .await
        .is_err());
    dir.close().await;
}

#[test]
fn frozen_panels_refuse_malformed_and_out_of_range_score_sheets() {
    let mut draft = creative();
    draft.environment["judgePanel"] = json!({"recipe": super::super::judge_panel::RECIPE});
    let criteria = vec![RubricCriterion {
        id: "quality".into(),
        label: "Quality".into(),
        weight: 1.0,
    }];
    for reply in [
        "{\"scores\":{\"quality\":11}}",
        "{\"scores\":{\"quality\":-1}}",
        "{\"scores\":{\"quality\":\"8\"}}",
        "{\"scores\":{\"quality\":8,\"undeclared\":10}}",
        "Here: {\"scores\":{\"quality\":8}}",
        "{\"scores\":{}}",
    ] {
        assert!(
            judge_score_sheet(&draft, reply, None, &criteria).is_none(),
            "{reply}"
        );
    }
    for score in [0, 8, 10] {
        let reply = json!({"scores":{"quality":score},"notes":"Invented rating"}).to_string();
        assert_eq!(
            judge_score_sheet(&draft, &reply, None, &criteria)
                .unwrap()
                .score,
            Some(f64::from(score) / 10.0)
        );
    }
    draft
        .environment
        .as_object_mut()
        .unwrap()
        .remove("judgePanel");
    assert!(judge_score_sheet(
        &draft,
        "Here: {\"scores\":{\"quality\":11}}",
        None,
        &criteria
    )
    .is_some());
}

#[test]
fn untouched_usage_on_an_account_that_flies_is_unknown_headroom() {
    use crate::services::provider_account_status::Headroom;
    let now = 10 * 60 * 60 * 1000;
    let untouched = Some(Headroom {
        share: 100.0,
        read_at: now - 60_000,
    });
    let read = Some(Headroom {
        share: 27.0,
        read_at: now - 60_000,
    });
    // 0 % on every window while it flew turns minutes ago: unknown.
    assert_eq!(trusted_headroom(untouched, Some(now - 120_000), now), None);
    // Idle for over an hour, or never paced here: as read.
    assert_eq!(
        trusted_headroom(untouched, Some(now - 2 * 60 * 60 * 1000), now),
        untouched
    );
    assert_eq!(trusted_headroom(untouched, None, now), untouched);
    // A partly used account reads as it is, flying or not.
    assert_eq!(trusted_headroom(read, Some(now - 120_000), now), read);
    assert_eq!(trusted_headroom(None, Some(now), now), None);
}
/// A workflow root as its account's pace sees it: one turn admitted at
/// the root's load, its steps on the provider. `turns`, the outcome and
/// the reason are each test's.
pub(super) fn workflow_root(turns: u32, outcome: &str, reason: Option<&str>) -> Attempt {
    let row = judge_row("sonnet");
    let mut root = super::super::pending_attempt("invented-run", "invented-version", &row, 0);
    root.outcome = Some(outcome.into());
    root.reason = reason.map(str::to_owned);
    root.usage.output = Some(5000);
    root.native_execution_ms = Some(10_000);
    root.account_load = Some(AccountLoad { turns, limit: 4 });
    root.workflow_steps = vec![WorkflowStepEvidence {
        root_task_id: "invented-root".into(),
        step_id: "invented-step".into(),
        parent_step_id: None,
        entry_state_hash: "invented-hash".into(),
        attempt_id: "invented-step-attempt".into(),
        session_id: Some("invented-session".into()),
        host_run_id: None,
        evidence_hash: None,
        outcome: Some(outcome.into()),
    }];
    root
}
#[test]
fn a_workflow_root_admitted_full_counts_toward_its_accounts_round() {
    let account = "invented-acp\u{1f}pace-workflow-round";
    // Roots admitted with fewer beside them fill no round.
    for turns in 1..4 {
        pace_workflow(account, &workflow_root(turns, "completed", None), None);
    }
    assert_eq!(account_pace::limit(account), ACCOUNT_SLOTS);
    for _ in 0..ACCOUNT_SLOTS {
        pace_workflow(account, &workflow_root(4, "completed", None), None);
    }
    assert_eq!(account_pace::limit(account), 2 * ACCOUNT_SLOTS);
    // A policy root, admitted without an account seat, and a root no step
    // of which reached the provider tell the pace nothing, not even a
    // rate limit their reason quotes.
    let other = "invented-acp\u{1f}pace-workflow-unseated";
    let limited = Some("HTTP 429 Too Many Requests");
    let mut unseated = workflow_root(4, "provider_error", limited);
    unseated.account_load = None;
    let mut unsent = workflow_root(4, "provider_error", limited);
    unsent.workflow_steps[0].session_id = None;
    for _ in 0..2 * ACCOUNT_SLOTS {
        pace_workflow(other, &unseated, None);
        pace_workflow(other, &unsent, None);
    }
    assert_eq!(account_pace::limit(other), ACCOUNT_SLOTS);
}
#[test]
fn a_rate_limited_workflow_step_halves_its_accounts_pace() {
    let reason = "invented-acp\u{1f}pace-workflow-reason";
    let limited = workflow_root(4, "provider_error", Some("HTTP 429 Too Many Requests"));
    pace_workflow(reason, &limited, None);
    assert_eq!(account_pace::limit(reason), ACCOUNT_SLOTS / 2);
    let error = "invented-acp\u{1f}pace-workflow-error";
    pace_workflow(
        error,
        &workflow_root(4, "completed", None),
        Some(&BenchmarkError::new(
            "provider_error",
            "rate limit reached for requests",
        )),
    );
    assert_eq!(account_pace::limit(error), ACCOUNT_SLOTS / 2);
}
#[test]
fn a_workflow_root_keeps_no_speed_sample() {
    // As text turns, five alone at 500 tokens/s and five beside three
    // others at 100 would send the pace below four (see
    // only_text_turns_teach_the_pace_speed_and_timeouts_never_throttle);
    // as workflow roots they only fill a round.
    let account = "invented-acp\u{1f}pace-workflow-speed";
    for _ in 0..5 {
        let mut alone = workflow_root(1, "completed", None);
        alone.usage.output = Some(5000);
        let mut beside = workflow_root(4, "completed", None);
        beside.usage.output = Some(1000);
        pace_workflow(account, &alone, None);
        pace_workflow(account, &beside, None);
    }
    assert_eq!(account_pace::limit(account), 2 * ACCOUNT_SLOTS);
}
#[test]
fn a_workflow_root_that_fails_otherwise_neither_grows_nor_halves_the_pace() {
    let account = "invented-acp\u{1f}pace-workflow-failure";
    for _ in 0..2 * ACCOUNT_SLOTS {
        pace_workflow(
            account,
            &workflow_root(4, "provider_error", Some("stream disconnected")),
            None,
        );
        pace_workflow(account, &workflow_root(4, "fail", None), None);
        pace_workflow(
            account,
            &workflow_root(4, "completed", None),
            Some(&BenchmarkError::new(
                "infrastructure_failure",
                "Repository sandbox: Sandbox copy failed",
            )),
        );
    }
    assert_eq!(account_pace::limit(account), ACCOUNT_SLOTS);
}
pub(super) fn judge_row(model: &str) -> Configuration {
    Configuration {
        id: format!("claude-acp:account:{model}"),
        provider_id: "claude-acp".into(),
        account_id: Some("account".into()),
        model_id: model.into(),
        effort: None,
        fast_mode: None,
        billing_mode: "subscription".into(),
        execution_profile: "native_text".into(),
        inventory_revision: Some("runtime".into()),
        model_name: None,
    }
}
#[test]
fn a_partial_judge_inventory_is_not_a_missing_panel() {
    let busy = || BenchmarkError::new("resource_busy", "local CPU admission refused");
    assert_eq!(
        resolve_judge_panel(vec![judge_row("opus")], Some(busy()))
            .unwrap_err()
            .code,
        "resource_busy"
    );
    // An unused account's refusal does not hold a complete panel back.
    assert_eq!(
        resolve_judge_panel(vec![judge_row("opus"), judge_row("sonnet")], Some(busy()))
            .unwrap()
            .len(),
        2
    );
    // A complete discovery with too few judges keeps the real panel error.
    assert_eq!(
        resolve_judge_panel(vec![judge_row("opus")], None)
            .unwrap()
            .len(),
        1
    );
}

pub(super) fn critical_text() -> BenchmarkDraft {
    let mut draft = creative();
    draft.environment["judgeInput"] = json!("text");
    draft.environment["rubricCriteria"] = json!([{"id":"quality","label":"Quality","weight":1}]);
    draft.environment["criticalChecks"] = json!([
        {"id":"retention","requirement":"An old acknowledgement cannot remove a newer pending write."},
        {"id":"barrier","requirement":"Keep the close barrier until every participant settles."}
    ]);
    draft
}

pub(super) fn critical_reply() -> Value {
    json!({"scores":{"quality":9},"notes":"Concrete revision comparison and settled barrier.",
    "checks":{
        "retention":{"verdict":"pass","evidence":["Remove only the acknowledged revision."],"reason":"A newer pending revision remains queued."},
        "barrier":{"verdict":"pass","evidence":["Wait for every participant."],"reason":"A rejected participant does not release the other participants."}
    }})
}

#[test]
fn mixed_critical_sheet_corrections_preserve_history_usage_and_batch_identity() {
    let draft = critical_text();
    let mut attempt = super::super::pending_attempt("run", "version", &judge_row("sonnet"), 0);
    attempt.phase = "terminal".into();
    attempt.outcome = Some("pending_review".into());
    attempt.finished_at = Some(1);
    attempt.output =
        Some("Remove only the acknowledged revision. Wait for every participant.".into());
    attempt.evidence_hash = Some("sealed".into());
    let mut checks = critical_reply()["checks"].clone();
    checks["retention"]["verdict"] = json!("fail");
    checks["barrier"]["verdict"] = json!("unknown");
    checks["barrier"]["evidence"] = json!([]);
    let mut marker = settled_batch()[0].clone();
    marker.created_at = 1;
    marker.details = Some(json!({"judgeBatchId":"batch", "expectedJudges":2,
        "protocol":{"criticalCheckPolicy":judge_checks::POLICY,
        "panel":[judge_row("sonnet"), judge_row("haiku")]}}));
    marker.artifacts.push(Artifact {
        kind: "text".into(),
        path: "answer.txt".into(),
        hash: "sealed".into(),
        label: "Answer".into(),
    });
    let mut original = settled_batch()[1].clone();
    original.evaluator_revision = draft.evaluator.revision.clone();
    original.created_at = 2;
    original.provenance = "judge_failure".into();
    original.verdict = "abstained".into();
    original.score = None;
    original.reason = "Critical checks unresolved; judge abstained. Recorded trace".into();
    original.usage = Some(TokenUsage {
        input: Some(100),
        output: Some(50),
        cost: Some(0.01),
        ..Default::default()
    });
    original.details = Some(
        json!({"judgeBatchId":"batch","sessionId":"session","requestKey":"key",
        "usageComplete":true,"inFlight":false,"durationMs":1234,"criteria":{"quality":0.9},
        "criticalCheckPolicy":judge_checks::POLICY,"criticalCheckStatus":"unknown","criticalChecks":checks}),
    );
    let original_json = serde_json::to_value(&original).unwrap();
    attempt.evaluations = vec![marker.clone(), original];
    assert_eq!(judge_corrections::repair(&mut attempt, &draft, 10), 1);
    assert_eq!(
        serde_json::to_value(&attempt.evaluations[1]).unwrap(),
        original_json
    );
    let correction = &attempt.evaluations[2];
    assert_eq!(correction.score, Some(0.0));
    assert!(correction.usage.is_none());
    assert!(correction
        .details
        .as_ref()
        .unwrap()
        .get("durationMs")
        .is_none());
    let open = open_batch(&attempt.evaluations).unwrap();
    assert_eq!(open.asked, vec![judge_row("sonnet")]);
    assert_eq!(judge_corrections::repair(&mut attempt, &draft, 20), 0);
    let mut second = attempt.evaluations[2].clone();
    second.id = "other-seat".into();
    second.judge = Some(judge_row("haiku"));
    second.created_at = 3;
    second.score = Some(0.9);
    second.details =
        Some(json!({"criticalCheckPolicy":judge_checks::POLICY,"criticalCheckStatus":"pass"}));
    attempt.evaluations.push(second);
    assert_eq!(super::super::analysis::score_as_of(&attempt, Some(9)), None);
    assert_eq!(
        super::super::analysis::score_as_of(&attempt, Some(10)),
        Some(0.0)
    );
    // A later, incomplete batch cannot absorb or hide the corrected vote.
    attempt.evaluations.push(marker);
    assert_eq!(super::super::analysis::score(&attempt), Some(0.0));

    for invalid in ["quote", "revision", "unfinished", "unsealed"] {
        let mut bad = attempt.clone();
        bad.evaluations = vec![bad.evaluations[0].clone(), bad.evaluations[1].clone()];
        match invalid {
            "quote" => {
                bad.evaluations[1].details.as_mut().unwrap()["criticalChecks"]["retention"]
                    ["evidence"] = json!(["Fabricated quote"])
            }
            "revision" => bad.evaluations[1].evaluator_revision = "another".into(),
            "unfinished" => {
                bad.evaluations[1].details.as_mut().unwrap()["usageComplete"] = json!(false)
            }
            _ => bad.evidence_hash = None,
        }
        assert_eq!(
            judge_corrections::repair(&mut bad, &draft, 20),
            0,
            "{invalid}"
        );
    }
}

use super::*;
use std::sync::atomic::Ordering;
use tokio::sync::Notify;
pub(super) async fn setup() -> (
    crate::test_support::TempRoot,
    Arc<BenchmarkService>,
    Arc<FakeBackend>,
) {
    let dir = crate::test_support::TempRoot::new();
    let store = Store::open(dir.path()).await.unwrap();
    dir.register(&store.pool);
    let backend = Arc::new(FakeBackend::default());
    let service = Arc::new(BenchmarkService {
        store,
        backend: backend.clone(),
        wake: Notify::new(),
        active: Default::default(),
        queries: Default::default(),
        app: None,
    });
    (dir, service, backend)
}
pub(super) async fn request(s: &BenchmarkService) -> RunRequest {
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    draft.split = "train".into();
    let d = s.store.save_draft(None, None, draft).await.unwrap();
    let v = s.store.publish(&d.id, 1).await.unwrap();
    RunRequest {
        author_policy: None,
        request_key: "test-key".into(),
        version_ids: vec![v.id],
        configurations: vec![Configuration {
            id: "fake-pass".into(),
            provider_id: "fake".into(),
            account_id: Some("isolated".into()),
            model_id: "fake-pass".into(),
            effort: None,
            fast_mode: None,
            billing_mode: "simulated".into(),
            execution_profile: "native_text".into(),
            inventory_revision: Some("fake-v1".into()),
            model_name: None,
        }],
        repetitions: 2,
        timeout_seconds: 10,
        max_executions: 2,
        preview: false,
        parallelism: None,
        execution_limits: None,
        workflow_policy: None,
    }
}
#[tokio::test]
async fn a_provider_that_may_train_on_submitted_data_is_planned_every_split() {
    // Every provider runs every split (owner, 2026-10-19); data use only
    // keeps a provider off judge panels.
    let (dir, s, _backend) = setup().await;
    let mut req = request(&s).await;
    let train = req.version_ids[0].clone();
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    draft.split = "held_out".into();
    draft.task_family = "invented-held-out-family".into();
    let held_out = s.store.save_draft(None, None, draft).await.unwrap();
    let held_out = s.store.publish(&held_out.id, 1).await.unwrap().id;
    req.configurations[0].provider_id = "zai-acp".into();
    req.version_ids = vec![train, held_out];
    req.repetitions = 1;
    let preview = s.preview_run(&req).await.unwrap();
    assert!(preview.valid, "{:?}", preview.issues);
    dir.close().await;
}
#[tokio::test]
async fn finish_continues_a_cancelled_run_and_returns_a_stopped_panel_to_its_judges() {
    let (dir, s, backend) = setup().await;
    let run = s.start_run(creative_request(&s).await).await.unwrap();
    s.tick().await.unwrap();
    // Stopped while its rendering awaited the panel: the answer is sealed,
    // its verdict missing. Build the real seal instead of fabricating an
    // output with no evidence hash, which resume must not trust.
    let mut stopped = s.store.attempt(&run.attempts[0].id).await.unwrap();
    let sealed_output = stopped.output.clone();
    assert!(sealed_output.is_some());
    assert!(stopped.evidence_hash.is_some());
    stopped.phase = "terminal".into();
    stopped.outcome = Some("pending_review".into());
    stopped.reason = Some(JUDGING_STOPPED.into());
    s.store.save_attempt(&stopped).await.unwrap();
    s.store.set_run_state(&run.id, "cancelled").await.unwrap();
    let finished = s.extend_run(&run.id, &[], &[]).await.unwrap();
    // The same run goes on, and the answer waits for its judges again.
    assert_eq!(finished.id, run.id);
    assert_eq!(finished.state, "running");
    let revived = s.store.attempt(&stopped.id).await.unwrap();
    assert_eq!(revived.phase, AWAITING_JUDGES);
    assert_eq!(revived.outcome.as_deref(), Some("pending_review"));
    assert_eq!(revived.reason, None);
    assert_eq!(revived.output, sealed_output);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    dir.close().await;
}
/// [`request`] flown one attempt at a time, so a refused turn is the
/// only one sent before the run reacts to it.
pub(super) async fn serial_request(s: &BenchmarkService) -> RunRequest {
    RunRequest {
        parallelism: Some(1),
        ..request(s).await
    }
}
#[tokio::test]
async fn a_change_notice_names_the_runs_changed_since_the_last_one() {
    let (dir, service, _) = setup().await;
    let notified = std::sync::atomic::AtomicI64::new(0);
    let run = service.start_run(request(&service).await).await.unwrap();
    // The first notice names nothing: the app refreshes everything.
    let first = super::super::changed_notice(&service.store, &notified)
        .await
        .unwrap();
    assert!(first.get("entityIds").is_none());
    let mut attempt = service.store.run(&run.id).await.unwrap().attempts.remove(0);
    attempt.reason = Some("Invented wait".into());
    service.store.save_attempt(&attempt).await.unwrap();
    let next = super::super::changed_notice(&service.store, &notified)
        .await
        .unwrap();
    assert_eq!(next["entityIds"], serde_json::json!([run.id]));
    assert!(next["sequence"].as_i64() > first["sequence"].as_i64());
    // Nothing committed since: nothing to refresh.
    let idle = super::super::changed_notice(&service.store, &notified)
        .await
        .unwrap();
    assert_eq!(idle["entityIds"], serde_json::json!([]));
    dir.close().await;
}
#[tokio::test]
async fn the_dispatcher_loads_only_runs_it_acts_on() {
    let (dir, service, _) = setup().await;
    let run = service.start_run(request(&service).await).await.unwrap();
    for (state, loaded) in [
        ("running", true),
        ("pausing", true),
        ("cancelling", true),
        ("paused", false),
        ("needs_attention", false),
        ("completed", false),
    ] {
        service.store.set_run_state(&run.id, state).await.unwrap();
        let active = service.store.active_runs().await.unwrap();
        assert_eq!(active.iter().any(|r| r.id == run.id), loaded, "{state}");
    }
    dir.close().await;
}
#[tokio::test]
async fn resource_waits_preserve_unstarted_no_replay_cells_without_paid_calls() {
    let (dir, service, backend) = setup().await;
    let mut request = serial_request(&service).await;
    request.repetitions = 1;
    request.max_executions = 1;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    backend.resource_busy.store(true, Ordering::SeqCst);
    let run = service.start_run(request).await.unwrap();
    service.tick().await.unwrap();
    let waiting = service.store.run(&run.id).await.unwrap();
    assert_eq!(waiting.state, "running");
    assert_eq!(waiting.attempts[0].phase, "pending");
    assert!(waiting.attempts[0].session_id.is_none());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    backend.resource_busy.store(false, Ordering::SeqCst);
    backend.resource_refusals.store(1, Ordering::SeqCst);
    admission_window::expire_wait(&service.store.root.display().to_string());
    service.tick().await.unwrap();
    let waiting = service.store.run(&run.id).await.unwrap();
    assert_eq!(waiting.attempts[0].phase, "pending");
    assert!(waiting.attempts[0].wait_until.is_some());
    assert!(waiting.attempts[0].started_at.is_none());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    admission_window::expire_wait(&service.store.root.display().to_string());
    service.tick().await.unwrap();
    service.tick().await.unwrap();
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(service.store.run(&run.id).await.unwrap().attempts.len(), 1);
    dir.close().await;
}
#[tokio::test]
async fn resource_refusal_parks_the_whole_queue_and_checks_once_when_due() {
    let (dir, service, backend) = setup().await;
    let mut request = request(&service).await;
    request.repetitions = 20;
    request.max_executions = 20;
    backend.resource_busy.store(true, Ordering::SeqCst);
    let run = service.start_run(request).await.unwrap();
    let scope = service.store.root.display().to_string();
    for _ in 0..20 {
        service.tick().await.unwrap();
    }
    assert_eq!(backend.resource_probes.load(Ordering::SeqCst), 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    let queued = service.store.run(&run.id).await.unwrap();
    assert_eq!(queued.state, "running");
    assert!(queued
        .attempts
        .iter()
        .all(|a| a.phase == "pending" && a.started_at.is_none()));
    assert_eq!(
        queued
            .attempts
            .iter()
            .filter(|a| a.wait_until.is_some())
            .count(),
        1
    );
    assert!(admission_window::remaining(&scope) > admission_window::RETRY - Duration::from_secs(5));
    admission_window::expire_wait(&scope);
    service.tick().await.unwrap();
    assert_eq!(backend.resource_probes.load(Ordering::SeqCst), 2);
    for _ in 0..5 {
        service.tick().await.unwrap();
    }
    assert_eq!(backend.resource_probes.load(Ordering::SeqCst), 2);
    backend.resource_busy.store(false, Ordering::SeqCst);
    admission_window::expire_wait(&scope);
    for _ in 0..3 {
        service.tick().await.unwrap();
    }
    assert_eq!(backend.calls.load(Ordering::SeqCst), 20);
    assert_eq!(service.store.run(&run.id).await.unwrap().state, "completed");
    dir.close().await;
}
#[tokio::test]
async fn durable_matrix_and_idempotent_start_do_not_duplicate() {
    let (dir, s, backend) = setup().await;
    let req = request(&s).await;
    let run = s.start_run(req.clone()).await.unwrap();
    let again = s.start_run(req.clone()).await.unwrap();
    assert_eq!(run.id, again.id);
    assert_eq!(again.attempts.len(), 2);
    let mut changed = req;
    changed.repetitions = 1;
    assert_eq!(
        s.start_run(changed).await.unwrap_err().code,
        "revision_conflict"
    );
    for _ in 0..3 {
        s.tick().await.unwrap();
    }
    let completed = s.store.run(&run.id).await.unwrap();
    assert_eq!(completed.state, "completed");
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    assert!(completed
        .attempts
        .iter()
        .all(|a| a.outcome.as_deref() == Some("pass")));
    assert!(completed.attempts.iter().all(|a| a.output.is_none()));
    assert!(s
        .store
        .attempt(&completed.attempts[0].id)
        .await
        .unwrap()
        .output
        .is_some());
    dir.close().await;
}
#[tokio::test]
async fn matrix_order_is_seeded_repeatable_and_frozen_before_dispatch() {
    let (dir, service, backend) = setup().await;
    let mut req = request(&service).await;
    req.repetitions = 6;
    req.max_executions = 12;
    let mut second = req.configurations[0].clone();
    second.id = "second".into();
    second.effort = Some("high".into());
    req.configurations.push(second);
    let identities = |cells: Vec<(String, Configuration, u32)>| {
        cells
            .into_iter()
            .map(|(v, c, r)| (v, c.id, r))
            .collect::<Vec<_>>()
    };
    let first = identities(super::super::randomized_matrix(&req).unwrap());
    let mut permuted = req.clone();
    permuted.configurations.reverse();
    assert_eq!(
        first,
        identities(super::super::randomized_matrix(&permuted).unwrap())
    );
    let mut other_seed = req.clone();
    other_seed.request_key = "different-request-key".into();
    assert_ne!(
        first,
        identities(super::super::randomized_matrix(&other_seed).unwrap())
    );
    // The plan check names the cases in the order the run dispatches them.
    let mut seen = std::collections::HashSet::new();
    let cases: Vec<String> = first
        .iter()
        .filter(|(version, _, _)| seen.insert(version.clone()))
        .map(|(version, _, _)| version.clone())
        .collect();
    assert_eq!(
        service.preview_run(&req).await.unwrap().execution_order,
        cases
    );
    let run = service.start_run(req.clone()).await.unwrap();
    assert_eq!(
        first,
        run.attempts
            .iter()
            .map(|a| (
                a.version_id.clone(),
                a.configuration.id.clone(),
                a.repetition
            ))
            .collect::<Vec<_>>()
    );
    let manifest: Value = serde_json::from_slice(
        &tokio::fs::read(
            service
                .store
                .root
                .join("runs")
                .join(&run.id)
                .join("manifest.json"),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        manifest["executionOrder"]["algorithm"],
        "sha256-cell-order-v1"
    );
    assert_eq!(
        manifest["executionOrder"]["seed"],
        super::super::matrix_order_seed(&req.request_key)
    );
    assert_eq!(
        manifest["executionOrder"]["cells"]
            .as_array()
            .unwrap()
            .len(),
        12
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    assert_eq!(run.id, service.start_run(req).await.unwrap().id);
    dir.close().await;
}
#[test]
fn a_turn_gets_the_run_limit_or_a_shorter_frozen_budget() {
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    // The case's own limit is the least a run must allow, not a stop.
    draft.limits.timeout_seconds = 120;
    assert_eq!(effective_timeout_seconds(14_400, &draft), 14_400);
    assert_eq!(effective_timeout_seconds(90, &draft), 90);
    draft.entry_state = Some(EntryState {
        schema_version: 1,
        root_task_id: "task".into(),
        step_id: "continue".into(),
        parent_step_id: None,
        fixture_snapshot_hash: String::new(),
        conversation_prefix: String::new(),
        previous_reports: vec![],
        remaining_budget_seconds: 30,
        content_hash: String::new(),
    });
    assert_eq!(effective_timeout_seconds(90, &draft), 30);
    assert_eq!(effective_timeout_seconds(10, &draft), 10);
    draft.limits.timeout_seconds = 5;
    assert_eq!(effective_timeout_seconds(90, &draft), 30);
}

#[tokio::test]
async fn interrupted_dispatch_is_never_requeued() {
    let (dir, s, backend) = setup().await;
    let req = request(&s).await;
    let run = s.start_run(req).await.unwrap();
    let mut a = run.attempts[0].clone();
    a.phase = "dispatching".into();
    s.store.save_attempt(&a).await.unwrap();
    s.store.recover().await.unwrap();
    s.tick().await.unwrap();
    let recovered = s.store.run(&run.id).await.unwrap();
    assert_eq!(recovered.state, "needs_attention");
    assert_eq!(
        recovered.attempts[0].outcome.as_deref(),
        Some("dispatch_uncertain")
    );
    assert_eq!(recovered.attempts[1].phase, "pending");
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    // One lost test never retires the rest: the run resumes, the
    // uncertain repetition is superseded and measured anew as its own
    // attempt, never under the lost key.
    s.control(&run.id, "resume").await.unwrap();
    for _ in 0..3 {
        s.tick().await.unwrap();
    }
    let resumed = s.store.run(&run.id).await.unwrap();
    assert_eq!(resumed.attempts[0].outcome.as_deref(), Some("superseded"));
    assert_eq!(resumed.attempts.len(), 3);
    assert!(resumed.attempts[1..]
        .iter()
        .all(|a| a.phase == "terminal" && super::super::analysis::score(a).is_some()));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    dir.close().await;
}
/// A second case for a run, published from the next seed.
pub(super) async fn second_case(s: &BenchmarkService) -> String {
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(1);
    draft.split = "train".into();
    let d = s.store.save_draft(None, None, draft).await.unwrap();
    s.store.publish(&d.id, 1).await.unwrap().id
}
pub(super) fn settle(attempt: &Attempt, outcome: &str) -> Attempt {
    let mut done = attempt.clone();
    done.phase = "terminal".into();
    done.outcome = Some(outcome.into());
    done.started_at = Some(1);
    done.finished_at = Some(now());
    done
}
/// The repetitions of `version` in `run`.
pub(super) fn cell_of(run: &BenchmarkRun, version: &str) -> Vec<Attempt> {
    run.attempts
        .iter()
        .filter(|a| a.version_id == version)
        .cloned()
        .collect()
}
#[tokio::test]
async fn confirmed_remeasurement_seals_the_previous_sitting_atomically() {
    let (dir, s, backend) = setup().await;
    let mut req = request(&s).await;
    req.repetitions = 3;
    req.max_executions = 3;
    let old = s.start_run(req.clone()).await.unwrap();
    for attempt in &old.attempts {
        let mut failed = settle(attempt, "fail");
        failed.output = Some("Original failed answer".into());
        s.store.save_attempt(&failed).await.unwrap();
    }
    s.store.set_run_state(&old.id, "completed").await.unwrap();
    let before = s.store.run(&old.id).await.unwrap();
    req.request_key = "measure-again".into();
    let mut invalid = req.clone();
    invalid.max_executions = 0;
    assert!(s.start_run_replacing(invalid, Some(&old.id)).await.is_err());
    assert!(s.store.run(&old.id).await.unwrap().baked_at.is_none());
    // A failure while sealing rolls back the newly admitted plan too.
    sqlx::query("CREATE TRIGGER refuse_seal BEFORE UPDATE OF baked_at ON run_plans BEGIN SELECT RAISE(ABORT, 'test: seal failed'); END")
        .execute(&s.store.pool).await.unwrap();
    assert!(s
        .start_run_replacing(req.clone(), Some(&old.id))
        .await
        .is_err());
    assert_eq!(s.store.runs().await.unwrap().len(), 1);
    assert!(s.store.run(&old.id).await.unwrap().baked_at.is_none());
    sqlx::query("DROP TRIGGER refuse_seal")
        .execute(&s.store.pool)
        .await
        .unwrap();
    let new = s
        .start_run_replacing(req.clone(), Some(&old.id))
        .await
        .unwrap();
    let sealed = s.store.run(&old.id).await.unwrap();
    assert!(sealed.baked_at.is_some());
    assert_eq!(sealed.updated_at, before.updated_at);
    assert_eq!(sealed.attempts.len(), 3);
    assert!(sealed
        .attempts
        .iter()
        .all(|a| a.outcome.as_deref() == Some("fail")));
    assert!(s.control(&old.id, "resume").await.is_err());
    assert!(s.extend_run(&old.id, &[], &[]).await.is_err());
    assert_ne!(new.id, old.id);
    assert_eq!(new.attempts.len(), 3);
    assert!(new.attempts.iter().all(|a| a.phase == "pending"));
    // Retrying an acknowledged request neither creates nor seals anything again.
    assert_eq!(
        s.start_run_replacing(req, Some(&old.id)).await.unwrap().id,
        new.id
    );
    assert_eq!(
        s.store.run(&old.id).await.unwrap().baked_at,
        sealed.baked_at
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    let history = super::super::analysis::history(
        &s.query_data().await.unwrap(),
        &before.request.configurations[0],
    );
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].run_id, old.id);
    dir.close().await;
}
/// A run holds every attempt it planned, however many: a full suite at
/// three repetitions is over a thousand, and the run, the analyses and
/// a resume read all of them.
#[tokio::test]
async fn a_run_of_more_than_a_thousand_attempts_loads_whole() {
    let (dir, s, _) = setup().await;
    let mut req = request(&s).await;
    req.repetitions = 3;
    req.max_executions = 3;
    let run = s.start_run(req).await.unwrap();
    let first = run.attempts[0].clone();
    for repetition in 3..1103 {
        s.store
            .insert_attempt(&super::super::pending_attempt(
                &run.id,
                &first.version_id,
                &first.configuration,
                repetition,
            ))
            .await
            .unwrap();
    }
    let loaded = s.store.run(&run.id).await.unwrap();
    assert_eq!(loaded.attempts.len(), 1103);
    assert_eq!(loaded.attempts.last().unwrap().repetition, 1102);
    let every = s.store.all_runs().await.unwrap();
    assert_eq!(every[0].attempts.len(), 1103);
    let data = s.query_data().await.unwrap();
    assert_eq!(data.runs[0].attempts.len(), 1103);
    dir.close().await;
}
/// Time a run spends paused is left out of its 24-hour window: a run
/// whose window would have closed during a two-hour pause resumes, and
/// a paused run is never baked.
#[tokio::test]
async fn a_pause_does_not_count_toward_the_window() {
    let (dir, s, backend) = setup().await;
    let req = request(&s).await;
    let run = s.start_run(req).await.unwrap();
    // Ten minutes of the window are left when the owner pauses it.
    sqlx::query("UPDATE run_plans SET created_at=? WHERE id=?")
        .bind(now() - super::super::analysis::RUN_WINDOW_MS + 600_000)
        .bind(&run.id)
        .execute(&s.store.pool)
        .await
        .unwrap();
    s.control(&run.id, "pause").await.unwrap();
    s.tick().await.unwrap();
    let paused = s.store.run(&run.id).await.unwrap();
    assert_eq!(paused.state, "paused");
    assert!(paused.paused_since.is_some());
    // Two hours pass in the pause: the 24 hours since the start are over.
    sqlx::query("UPDATE run_plans SET created_at=created_at-7200000,paused_since=paused_since-7200000 WHERE id=?")
        .bind(&run.id)
        .execute(&s.store.pool)
        .await
        .unwrap();
    s.tick().await.unwrap();
    let resting = s.store.run(&run.id).await.unwrap();
    assert!(resting.baked_at.is_none());
    assert!(now() < super::super::analysis::window_closes(&resting));
    s.control(&run.id, "resume").await.unwrap();
    let resumed = s.store.run(&run.id).await.unwrap();
    assert_eq!(resumed.state, "running");
    assert!(resumed.paused_since.is_none());
    assert!(resumed.paused_ms >= 7_200_000);
    assert!(now() < super::super::analysis::window_closes(&resumed));
    for _ in 0..3 {
        s.tick().await.unwrap();
    }
    let done = s.store.run(&run.id).await.unwrap();
    assert_eq!(done.state, "completed");
    assert!(done.baked_at.is_none());
    assert!(backend.calls.load(Ordering::SeqCst) > 0);
    dir.close().await;
}
#[tokio::test]
async fn active_cancel_retains_sealed_evidence() {
    let (dir, s, backend) = setup().await;
    let req = serial_request(&s).await;
    let run = s.start_run(req).await.unwrap();
    let background = s.clone();
    let tick = tokio::spawn(async move { background.tick().await });
    // Cancelled once the turn reached the provider.
    while backend.in_flight.load(Ordering::SeqCst) == 0 {
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    s.control(&run.id, "cancel").await.unwrap();
    tick.await.unwrap().unwrap();
    s.tick().await.unwrap();
    let run = s.store.run(&run.id).await.unwrap();
    assert_eq!(run.state, "cancelled");
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert!(run.attempts.iter().any(|a| a.evidence_hash.is_some()));
    dir.close().await;
}
/// Five efforts of both fake models on each of two accounts, two turns
/// each: 20 configurations, 40 turns. The second account's models are
/// billed apart, so each is its own candidate.
pub(super) async fn wide_request(s: &BenchmarkService, backend: &FakeBackend) -> RunRequest {
    let efforts = ["low", "medium", "high", "xhigh", "max"];
    *backend.effort_levels.lock().unwrap() = efforts.map(String::from).to_vec();
    let mut req = request(s).await;
    let base = req.configurations.remove(0);
    for account in ["one", "two"] {
        for model in ["fake-pass", "fake-fail"] {
            for effort in efforts {
                let mut c = base.clone();
                c.id = format!("{account}-{model}-{effort}");
                c.account_id = Some(account.into());
                c.model_id = model.into();
                c.effort = Some(effort.into());
                if account == "two" {
                    c.billing_mode = "simulated-second".into();
                }
                req.configurations.push(c);
            }
        }
    }
    req.max_executions = 40;
    req
}
/// One configuration, eight turns of one case.
pub(super) async fn deep_request(s: &BenchmarkService, provider: &str) -> RunRequest {
    let mut req = request(s).await;
    req.configurations[0].provider_id = provider.into();
    req.repetitions = 8;
    req.max_executions = 8;
    req
}
pub(super) async fn drain(s: &Arc<BenchmarkService>, run_id: &str) -> BenchmarkRun {
    for _ in 0..12 {
        s.tick().await.unwrap();
        let run = s.store.run(run_id).await.unwrap();
        if run.state == "completed" {
            return run;
        }
    }
    panic!("run {run_id} did not complete");
}
#[tokio::test]
async fn a_run_admitted_before_parallelism_flies_one_attempt_at_a_time() {
    let (dir, s, backend) = setup().await;
    let run = s.start_run(deep_request(&s, "fake").await).await.unwrap();
    let mut old = run.request.clone();
    old.parallelism = None;
    sqlx::query("UPDATE run_plans SET request_json=? WHERE id=?")
        .bind(serde_json::to_string(&old).unwrap())
        .bind(&run.id)
        .execute(&s.store.pool)
        .await
        .unwrap();
    drain(&s, &run.id).await;
    assert_eq!(backend.calls.load(Ordering::SeqCst), 8);
    assert_eq!(backend.peak_in_flight.load(Ordering::SeqCst), 1);
    let data = s.query_data().await.unwrap();
    let report = super::super::analysis::leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.rows[0].parallelism, Some(1));
    dir.close().await;
}
#[tokio::test]
async fn an_open_run_can_be_set_to_fly_in_parallel() {
    let (dir, s, backend) = setup().await;
    let run = s.start_run(deep_request(&s, "fake").await).await.unwrap();
    let mut old = run.request.clone();
    old.parallelism = None;
    sqlx::query("UPDATE run_plans SET request_json=? WHERE id=?")
        .bind(serde_json::to_string(&old).unwrap())
        .bind(&run.id)
        .execute(&s.store.pool)
        .await
        .unwrap();
    // An operator's number bounds the configuration, whatever its size;
    // the account's pace still decides below it.
    assert_eq!(
        s.set_parallelism(&run.id, 64)
            .await
            .unwrap()
            .request
            .parallelism,
        Some(64)
    );
    let set = s.set_parallelism(&run.id, 3).await.unwrap();
    assert_eq!(set.request.parallelism, Some(3));
    drain(&s, &run.id).await;
    assert_eq!(backend.peak_in_flight.load(Ordering::SeqCst), 3);
    dir.close().await;
}
#[tokio::test]
async fn independent_grok_text_bridges_fill_the_requested_parallelism() {
    let (dir, s, backend) = setup().await;
    let run = s
        .start_run(deep_request(&s, "grok-acp").await)
        .await
        .unwrap();
    drain(&s, &run.id).await;
    assert_eq!(backend.calls.load(Ordering::SeqCst), 8);
    assert_eq!(backend.peak_in_flight.load(Ordering::SeqCst), 4);
    dir.close().await;
}
#[tokio::test]
async fn a_spent_account_hands_its_tests_to_another_and_the_row_stays_one() {
    let (dir, s, backend) = setup().await;
    *backend.accounts_of.lock().unwrap() = vec!["isolated".into(), "second".into()];
    *backend.spent_accounts.lock().unwrap() = vec!["isolated".into()];
    let run = s.start_run(deep_request(&s, "fake").await).await.unwrap();
    let run = drain(&s, &run.id).await;
    assert_eq!(backend.calls.load(Ordering::SeqCst), 8);
    assert!(run.attempts.iter().all(|a| {
        a.outcome.as_deref() == Some("pass")
            && a.configuration.account_id.as_deref() == Some("second")
    }));
    // The run asked for the first account; its row is the model's one.
    assert_eq!(
        run.request.configurations[0].account_id.as_deref(),
        Some("isolated")
    );
    let data = s.query_data().await.unwrap();
    let report = super::super::analysis::leaderboard(&data, &ResultQuery::default());
    assert_eq!(report.rows.len(), 1);
    assert_eq!(report.rows[0].scored, 1);
    dir.close().await;
}
#[tokio::test]
async fn every_account_spent_still_waits_or_stops_as_before() {
    let (dir, s, backend) = setup().await;
    *backend.accounts_of.lock().unwrap() = vec!["isolated".into(), "second".into()];
    *backend.spent_accounts.lock().unwrap() = vec!["isolated".into(), "second".into()];
    let run = s.start_run(serial_request(&s).await).await.unwrap();
    s.tick().await.unwrap();
    s.tick().await.unwrap();
    let held = s.store.run(&run.id).await.unwrap();
    assert_eq!(held.state, "running");
    assert!(held.attempts.iter().all(|a| a.phase == "pending"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    dir.close().await;
}
#[test]
fn a_case_goes_out_whole_and_a_begun_case_first() {
    let attempt = |version: &str, repetition: u32, started: bool| Attempt {
        pre_answer_refusals: 0,
        infrastructure_retries: 0,
        id: format!("{version}-{repetition}"),
        run_id: "run".into(),
        version_id: version.into(),
        configuration: Configuration {
            id: "c".into(),
            provider_id: "fake".into(),
            account_id: None,
            model_id: "m".into(),
            effort: None,
            fast_mode: None,
            billing_mode: "simulated".into(),
            execution_profile: "native_text".into(),
            inventory_revision: None,
            model_name: None,
        },
        repetition,
        phase: if started { "terminal" } else { "pending" }.into(),
        outcome: started.then(|| "pass".into()),
        reason: None,
        wait_until: None,
        session_id: None,
        host_run_id: None,
        observed: None,
        started_at: started.then_some(1),
        finished_at: started.then_some(2),
        duration_ms: None,
        output: None,
        evidence_hash: None,
        usage: TokenUsage::default(),
        evaluations: vec![],
        event_cursor: 0,
        workflow_steps: vec![],
        native_execution_ms: None,
        resolved_model: None,
        repository_result: None,
        collection_context: None,
        sandbox_admission: None,
        account_load: None,
        phase_times: None,
        activity: None,
        credit_use: None,
    };
    let version = |id: &str| BenchmarkVersion {
        id: id.into(),
        definition_id: id.into(),
        content_hash: String::new(),
        published_at: 0,
        manifest: crate::services::benchmarks::seeds::definitions().remove(0),
        carries_from: None,
    };
    // Planned shuffled: b0 a1 c0 b2 a0 a2 b1 c1 c2; c0 already ran.
    let plan = [
        ("b", 0),
        ("a", 1),
        ("b", 2),
        ("a", 0),
        ("a", 2),
        ("b", 1),
        ("c", 1),
        ("c", 2),
    ];
    let ready: Vec<_> = plan
        .iter()
        .map(|(v, r)| (attempt(v, *r, false), version(v)))
        .collect();
    let mut attempts: Vec<Attempt> = ready.iter().map(|(a, _)| a.clone()).collect();
    attempts.push(attempt("c", 0, true));
    let run = BenchmarkRun {
        id: "run".into(),
        state: "running".into(),
        revision: 1,
        created_at: 0,
        updated_at: 0,
        baked_at: None,
        paused_ms: 0,
        paused_since: None,
        request: RunRequest {
            author_policy: None,
            request_key: "run".into(),
            version_ids: vec!["a".into(), "b".into(), "c".into()],
            configurations: vec![attempts[0].configuration.clone()],
            repetitions: 3,
            timeout_seconds: 60,
            max_executions: 9,
            preview: false,
            parallelism: None,
            execution_limits: None,
            workflow_policy: None,
        },
        attempts,
    };
    let order: Vec<String> = grouped_by_cell(&run, ready)
        .into_iter()
        .map(|(a, _)| a.id)
        .collect();
    assert_eq!(
        order,
        ["c-1", "c-2", "b-0", "b-1", "b-2", "a-0", "a-1", "a-2"]
    );
}
#[tokio::test]
async fn any_parallelism_is_an_operators_bound_and_none_leaves_it_to_admission() {
    // Owner decision 2026-10-17: no fixed count bounds a run; 0 (the
    // default) leaves it to the account's pace and the sandbox.
    let (dir, s, _) = setup().await;
    for n in [AS_ADMITTED, 1, 5, 64] {
        let mut req = request(&s).await;
        req.parallelism = Some(n);
        let preview = s.preview_run(&req).await.unwrap();
        assert!(
            preview
                .issues
                .iter()
                .all(|issue| !issue.contains("in parallel")),
            "{:?}",
            preview.issues
        );
    }
    let configuration = request(&s).await.configurations[0].clone();
    let mut req = request(&s).await;
    req.parallelism = Some(AS_ADMITTED);
    assert_eq!(attempts_at_once(&req, &configuration), u32::MAX);
    req.parallelism = None;
    assert_eq!(attempts_at_once(&req, &configuration), 1);
    dir.close().await;
}
#[tokio::test]
async fn cancel_stops_every_turn_in_flight() {
    let (dir, s, backend) = setup().await;
    backend.hold_turns.store(true, Ordering::SeqCst);
    let run = s.start_run(wide_request(&s, &backend).await).await.unwrap();
    let background = s.clone();
    let tick = tokio::spawn(async move { background.tick().await });
    tokio::time::timeout(Duration::from_secs(30), async {
        while backend.in_flight.load(Ordering::SeqCst) < 2 * ACCOUNT_SLOTS as u64 {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("all account slots must dispatch before cancellation");
    s.control(&run.id, "cancel").await.unwrap();
    tokio::time::timeout(Duration::from_secs(30), tick)
        .await
        .expect("cancellation must settle every turn")
        .unwrap()
        .unwrap();
    s.tick().await.unwrap();
    let run = s.store.run(&run.id).await.unwrap();
    assert_eq!(run.state, "cancelled");
    assert_eq!(
        backend.calls.load(Ordering::SeqCst),
        2 * ACCOUNT_SLOTS as u64
    );
    assert!(run
        .attempts
        .iter()
        .all(|a| a.phase == "terminal" && a.outcome.as_deref() == Some("cancelled")));
    dir.close().await;
}

#[test]
fn a_usage_limit_mid_answer_stops_the_turn_for_quota_unless_something_decided_it() {
    // Claude Code's session limit as the host reports it after a long answer.
    let limit = json!({"code":-32603,"data":{"accountId":"invented-account",
        "dispatchStarted":true,"errorKind":"quota_exhausted","promptNotAccepted":false,
        "sessionFailure":{"actions":[],"category":"limit","severity":"error",
            "title":"You've hit your session limit · resets 7pm (America/Los_Angeles)"}},
        "message":"You've hit your session limit · resets 7pm (America/Los_Angeles)"});
    let mut capture = TurnCapture::new(1024);
    capture.output = "an answer cut off midway".into();
    assert!(stopped_for_quota(&limit, &capture, false));
    // Anything else that ended the turn is no quota.
    let crashed = json!({"code":-32603,"data":{"errorKind":"provider_failure",
        "dispatchStarted":true},"message":"bridge exited"});
    assert!(!stopped_for_quota(&crashed, &capture, false));
    let refused = json!({"code":-32000,"message":"Authentication required: 401 Your current subscription does not have access to kimi-for-coding-highspeed."});
    assert!(!stopped_for_quota(&refused, &capture, false));
    // A limit no reset lifts settles as it ended instead of waiting.
    for kind in crate::services::provider_account_status::LASTING_QUOTA_KINDS {
        let lasting = json!({"data":{"errorKind":kind,"dispatchStarted":true},
            "message":"invented provider words"});
        assert!(!stopped_for_quota(&lasting, &capture, false), "{kind}");
    }
    let said = json!({"message":"insufficient_quota: add credits to continue"});
    assert!(crate::services::provider_account_status::is_quota_error(
        &said
    ));
    assert!(!stopped_for_quota(&said, &capture, false));
    // A broken policy settles as that, whatever stopped the turn after.
    let mut violated = TurnCapture::new(1024);
    violated.violation = Some("invented violation".into());
    assert!(!stopped_for_quota(&limit, &violated, false));
    // So does an answer past its cap, except in a repository, whose
    // answer is its work tree.
    let mut capped = TurnCapture::new(4);
    capped.output = "longer than four bytes".into();
    assert!(capped.cap_answer());
    assert!(!stopped_for_quota(&limit, &capped, false));
    assert!(stopped_for_quota(&limit, &capped, true));
}
pub(super) async fn expire_saved_waits(service: &BenchmarkService, run_id: &str) {
    for attempt in service.store.run(run_id).await.unwrap().attempts {
        if attempt.wait_until.is_some() {
            let mut elapsed = service.store.attempt(&attempt.id).await.unwrap();
            elapsed.wait_until = Some(now() - 1);
            service.store.save_attempt(&elapsed).await.unwrap();
        }
    }
}

/// One refusal before the prompt is one try's, not the run's: on 11-18
/// one Claude session of six could not confirm its model with the API
/// beside five that did, and the run stopped a minute after its start.
/// The cell waits and goes again, and the run goes on.
#[tokio::test]
async fn a_selection_refused_once_before_dispatch_is_tried_again() {
    let (dir, s, fake) = setup().await;
    fake.refused_selections.store(1, Ordering::SeqCst);
    let run = s.start_run(serial_request(&s).await).await.unwrap();
    s.tick().await.unwrap();
    let held = s.store.run(&run.id).await.unwrap();
    assert_eq!(held.state, "running");
    let refused: Vec<&Attempt> = held
        .attempts
        .iter()
        .filter(|a| a.pre_answer_refusals > 0)
        .collect();
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].pre_answer_refusals, 1);
    assert!(refused[0].phase == "pending" && refused[0].observed.is_none());
    assert!(refused[0].wait_until.is_some_and(|until| until > now()));
    assert!(refused[0]
        .reason
        .as_deref()
        .is_some_and(|reason| reason.starts_with(PRE_ANSWER_RETRIED)));
    expire_saved_waits(&s, &run.id).await;
    for _ in 0..4 {
        s.tick().await.unwrap();
    }
    let done = s.store.run(&run.id).await.unwrap();
    assert_eq!(done.state, "completed");
    assert!(done
        .attempts
        .iter()
        .all(|a| a.phase == "terminal" && a.outcome.as_deref() != Some("selection_changed")));
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    dir.close().await;
}
/// A sign-in near expiry, a refused preflight or a missing runtime stops
/// the session before any provider call. The cell keeps its place and
/// the reason, and its account's cells are left for the operator with it
/// instead of each being refused in its turn, or settling within seconds.
#[tokio::test]
async fn a_refusal_before_the_session_keeps_the_cell_for_the_operator() {
    let (dir, s, fake) = setup().await;
    fake.capability_refusals.store(1, Ordering::SeqCst);
    let run = s.start_run(serial_request(&s).await).await.unwrap();
    for _ in 0..2 {
        s.tick().await.unwrap();
    }
    let stopped = s.store.run(&run.id).await.unwrap();
    assert_eq!(stopped.state, "needs_attention");
    assert!(stopped
        .attempts
        .iter()
        .all(|a| a.phase == "pending" && a.outcome.is_none() && a.started_at.is_none()));
    assert!(stopped.attempts.iter().any(|a| a
        .reason
        .as_deref()
        .is_some_and(|reason| reason.contains("Grok sign-in expires"))));
    // Nothing more is tried until the operator resumes.
    s.tick().await.unwrap();
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
    assert_eq!(fake.capability_refusals.load(Ordering::SeqCst), 0);
    s.control(&run.id, "resume").await.unwrap();
    for _ in 0..3 {
        s.tick().await.unwrap();
    }
    let done = s.store.run(&run.id).await.unwrap();
    assert!(done
        .attempts
        .iter()
        .all(|a| a.phase == "terminal" && a.outcome.as_deref() != Some("capability_missing")));
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    dir.close().await;
}
/// One Grok answer chunk as the host stores it, with Grok's per-chunk
/// telemetry and the host's stamp.
pub(super) fn telemetry_chunk(kind: &str, text: &str, n: usize) -> Value {
    json!({
        "_meta": {"agentTimestampMs": 1_791_142_991_804u64 + n as u64, "chunkId": n,
            "eventId": format!("01a10871-0ea6-7042-b71f-98eb341afd73-{n}"),
            "promptId": "ddf932fe-1f3b-47f4-a036-120ad519f902",
            "streamStartMs": 1_791_142_990_182u64, "totalTokens": 207,
            "turnStartMs": 1_791_142_989_637u64, "updateType": "AgentMessageChunk"},
        "sessionId": "7ce99634-5aee-4928-9ab8-57085d4c26a3",
        "update": {"_meta": {
                "distill": {"assistantMessageId": "c373d081-b2d1-4b26-93d4-7e9c8f400d74",
                    "created": "2026-10-04T19:43:15.247Z",
                    "messageId": "30b2e7ec-a1c6-484a-8316-affdf9f8bca1",
                    "runId": "808dd1f8-1cc5-4ba8-964e-da06df71a147"},
                "executionOwner": {"id": "89663cb7-d49e-4dca-a9cf-6a7637dc82e1:1791142989445",
                    "kind": "benchmark"}},
            "content": {"text": text, "type": "text"}, "sessionUpdate": kind}
    })
}
pub(super) fn blank_attempt() -> Attempt {
    let data = super::super::analysis::tests::dataset();
    let mut attempt = data.attempts[0].clone();
    attempt.usage = TokenUsage::default();
    attempt.resolved_model = None;
    attempt
}

#[tokio::test]
async fn sealed_recovery_evaluates_without_new_dispatch() {
    let (dir, s, backend) = setup().await;
    let req = request(&s).await;
    let run = s.start_run(req).await.unwrap();
    let mut a = run.attempts[0].clone();
    let v = s.store.version(&a.version_id).await.unwrap();
    a.phase = "collecting".into();
    a.outcome = Some("completed".into());
    a.output = Some(v.manifest.evaluator.known_good);
    a.evidence_hash = Some(fixtures::seal(&s.store.root, &a, &json!({})).await.unwrap());
    s.store.save_attempt(&a).await.unwrap();
    s.store.recover().await.unwrap();
    s.tick().await.unwrap();
    let a = s.store.attempt(&a.id).await.unwrap();
    assert_eq!(a.outcome.as_deref(), Some("pass"));
    assert_eq!(a.evaluations.len(), 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    dir.close().await;
}
#[tokio::test]
async fn rubric_review_settles_quality() {
    let (dir, s, _) = setup().await;
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    draft.split = "train".into();
    draft.evaluator.kind = "rubric".into();
    draft.evaluator.rubric = "The response must correctly identify Mira and total five.".into();
    let d = s.store.save_draft(None, None, draft).await.unwrap();
    let v = s.store.publish(&d.id, 1).await.unwrap();
    let mut req = request(&s).await;
    req.version_ids = vec![v.id];
    req.repetitions = 1;
    req.max_executions = 4 * req.configurations.len() as u32;
    let run = s.start_run(req).await.unwrap();
    s.tick().await.unwrap();
    let a = s.store.attempt(&run.attempts[0].id).await.unwrap();
    assert_eq!(a.outcome.as_deref(), Some("pending_review"));
    let a = s
        .review(&a.id, 1.0, "Meets the declared rubric".into(), None)
        .await
        .unwrap();
    assert_eq!(a.outcome.as_deref(), Some("pass"));
    assert_eq!(a.evaluations[1].provenance, "human");
    dir.close().await;
}
#[tokio::test]
async fn old_active_runs_and_export_history_are_not_limited_to_recent_page() {
    let (dir, s, backend) = setup().await;
    let req = request(&s).await;
    let old = s.start_run(req.clone()).await.unwrap();
    for index in 0..101 {
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,?,?,?)").bind(format!("history-{index}")).bind(format!("history-{index}")).bind(now()+index).bind(now()+index).bind(serde_json::to_string(&req).unwrap()).execute(&s.store.pool).await.unwrap();
    }
    assert_eq!(s.store.runs().await.unwrap().len(), 100);
    assert_eq!(s.query_data().await.unwrap().runs.len(), 102);
    s.tick().await.unwrap();
    // Both repetitions of the old run fly at once.
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    assert!(s
        .store
        .run(&old.id)
        .await
        .unwrap()
        .attempts
        .iter()
        .all(|a| a.outcome.as_deref() == Some("pass")));
    dir.close().await;
}
#[test]
fn typed_terminal_outcomes_and_public_fixtures_are_preserved() {
    for (kind, wanted) in [
        ("budget_timeout", "budget_timeout"),
        ("cancelled", "cancelled"),
        ("selection_changed", "selection_changed"),
        ("quota_blocked", "quota_blocked"),
    ] {
        assert_eq!(terminal_error_outcome(&json!({"kind":kind})), wanted);
    }
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    draft.fixtures.push(Fixture {
        path: "input.txt".into(),
        content: "visible fixture".into(),
    });
    let prompt = prompt_with_fixtures(&draft).unwrap();
    assert!(prompt.contains("visible fixture"));
    assert!(!prompt.contains(&draft.evaluator.known_good));
}
#[test]
fn exact_selection_accepts_only_unspecified_native_defaults() {
    let c = Configuration {
        id: "a".into(),
        provider_id: "fake".into(),
        account_id: None,
        model_id: "m".into(),
        effort: None,
        fast_mode: None,
        billing_mode: "simulated".into(),
        execution_profile: "native_text".into(),
        inventory_revision: None,
        model_name: None,
    };
    let mut observed = c.clone();
    observed.effort = Some("high".into());
    assert!(matches_selection(&c, &observed));
    let mut requested = c;
    requested.effort = Some("low".into());
    assert!(!matches_selection(&requested, &observed));
}
pub(super) fn creative() -> BenchmarkDraft {
    crate::services::benchmarks::seeds::definitions()
        .into_iter()
        .find(|d| d.work_class_id == "creative")
        .unwrap()
}
pub(super) async fn publish(s: &BenchmarkService, draft: BenchmarkDraft) -> BenchmarkVersion {
    let definition = s.store.save_draft(None, None, draft).await.unwrap();
    s.store.publish(&definition.id, 1).await.unwrap()
}
/// The pool the boards measure now, as version ids.
pub(super) async fn board_pool(s: &BenchmarkService) -> Vec<String> {
    let data = s.query_data().await.unwrap();
    let mut ids: Vec<String> = super::super::analysis::ranked_pool(&data, &ResultQuery::default())
        .into_iter()
        .map(|version| version.id.clone())
        .collect();
    ids.sort();
    ids
}
#[tokio::test]
async fn releases_exclude_development_without_removing_diagnostics() {
    let (dir, s, _) = setup().await;
    let mut seeds = crate::services::benchmarks::seeds::definitions();
    let diagnostic = publish(&s, seeds.remove(0)).await;
    assert!(s.create_release(None).await.is_err());
    let mut training = seeds.remove(0);
    training.split = "train".into();
    let training = publish(&s, training).await;
    let mut held_out = seeds.remove(0);
    held_out.split = "held_out".into();
    let held_out = publish(&s, held_out).await;
    let release = s.create_release(None).await.unwrap();
    let mut expected = vec![training.id, held_out.id];
    expected.sort();
    assert_eq!(release.version_ids, expected);
    assert_eq!(board_pool(&s).await, expected);
    assert!(s
        .store
        .definition(&diagnostic.definition_id)
        .await
        .unwrap()
        .versions
        .iter()
        .any(|version| version.id == diagnostic.id));
    assert!(s.create_release(None).await.is_err());
    dir.close().await;
}

#[tokio::test]
async fn republication_retires_old_versions_without_changing_their_results() {
    let (dir, s, backend) = setup().await;
    let mut draft = crate::services::benchmarks::seeds::definitions()
        .into_iter()
        .find(|d| d.evaluator.kind == "exact")
        .unwrap();
    draft.split = "train".into();
    let definition = s.store.save_draft(None, None, draft.clone()).await.unwrap();
    let first = s.publish_version(&definition.id, 1).await.unwrap();
    assert_eq!(first.carries_from, None);
    let mut req = request(&s).await;
    req.request_key = "carried".into();
    req.version_ids = vec![first.id.clone()];
    req.repetitions = super::super::analysis::REQUIRED_REPETITIONS;
    req.max_executions = super::super::analysis::REQUIRED_REPETITIONS;
    let run = s.start_run(req).await.unwrap();
    let run = drain(&s, &run.id).await;
    assert!(run
        .attempts
        .iter()
        .all(|a| a.outcome.as_deref() == Some("pass")));
    let calls = backend.calls.load(Ordering::SeqCst);
    let frozen = serde_json::to_value(&run).unwrap();
    // A corrected evaluator belongs to a new version, never to old outputs.
    let mut fixed = draft.clone();
    fixed.evaluator.expected = format!("{} corrected", draft.evaluator.expected);
    fixed.evaluator.known_good = fixed.evaluator.expected.clone();
    fixed.evaluator.revision = "corrected".into();
    let saved = s
        .store
        .save_draft(Some(definition.id.as_str()), Some(1), fixed.clone())
        .await
        .unwrap();
    let second = s
        .publish_version(&definition.id, saved.draft_revision)
        .await
        .unwrap();
    assert_eq!(second.carries_from, None);
    assert!(second.published_at > first.published_at);
    assert_eq!(
        serde_json::to_value(s.store.run(&run.id).await.unwrap()).unwrap(),
        frozen
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), calls);
    // Retrieving the admitted request is idempotent, but no new execution,
    // preview, extension, resume or rescore may target its retired version.
    assert_eq!(s.start_run(run.request.clone()).await.unwrap().id, run.id);
    let mut stale = run.request.clone();
    stale.request_key = "retired-version".into();
    assert_eq!(
        s.preview_run(&stale).await.unwrap_err().code,
        "version_retired"
    );
    assert_eq!(
        s.start_run(stale).await.unwrap_err().code,
        "version_retired"
    );
    assert_eq!(
        s.extend_run(&run.id, &[], &[]).await.unwrap_err().code,
        "version_retired"
    );
    assert_eq!(
        s.control(&run.id, "resume").await.unwrap_err().code,
        "version_retired"
    );
    assert_eq!(
        s.rescore(&run.attempts[0].id).await.unwrap_err().code,
        "version_retired"
    );
    assert_eq!(
        serde_json::to_value(s.store.run(&run.id).await.unwrap()).unwrap(),
        frozen
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), calls);
    assert_eq!(s.store.versions_for(&definition.id).await.unwrap().len(), 2);
    let mut fresh = run.request.clone();
    fresh.request_key = "current-version".into();
    fresh.version_ids = vec![second.id.clone()];
    assert!(s.preview_run(&fresh).await.unwrap().valid);
    // No measurements are silently carried to the new evaluator.
    let data = s.query_data().await.unwrap();
    let report = super::super::analysis::leaderboard(&data, &ResultQuery::default());
    assert!(report
        .rows
        .iter()
        .all(|row| !row.scored_version_ids.contains(&second.id)));
    // A changed prompt is another task: it opens a gap and carries nothing.
    let mut reworded = fixed;
    reworded.prompt.push_str(" Answer in one line.");
    let saved = s
        .store
        .save_draft(
            Some(definition.id.as_str()),
            Some(saved.draft_revision),
            reworded,
        )
        .await
        .unwrap();
    let third = s
        .publish_version(&definition.id, saved.draft_revision)
        .await
        .unwrap();
    assert_eq!(third.carries_from, None);
    let data = s.query_data().await.unwrap();
    let report = super::super::analysis::leaderboard(&data, &ResultQuery::default());
    assert!(report
        .rows
        .iter()
        .all(|row| !row.scored_version_ids.contains(&third.id)));
    dir.close().await;
}
/// One repetition of a creative brief for the passing fake model.
pub(super) async fn creative_request(s: &BenchmarkService) -> RunRequest {
    let version = publish(s, creative()).await;
    let mut req = request(s).await;
    req.request_key = "creative".into();
    req.version_ids = vec![version.id];
    req.repetitions = 1;
    req.max_executions = 4;
    req
}
pub(super) async fn rewrite_plan(s: &BenchmarkService, id: &str, request: &RunRequest) {
    sqlx::query("UPDATE run_plans SET request_json=? WHERE id=?")
        .bind(serde_json::to_string(request).unwrap())
        .bind(id)
        .execute(&s.store.pool)
        .await
        .unwrap();
}
/// A request with a case one candidate wrote and one it did not, for
/// that candidate and another model, one repetition each.
pub(super) async fn authored_request(s: &BenchmarkService) -> (RunRequest, BenchmarkVersion) {
    let mut req = request(s).await;
    let mut authored = crate::services::benchmarks::seeds::definitions().remove(0);
    authored.split = "train".into();
    authored.name.push_str(" written by the candidate");
    authored.environment["authoredBy"] = json!([req.configurations[0]]);
    let written = publish(s, authored).await;
    req.version_ids.push(written.id.clone());
    req.repetitions = 1;
    let mut other = req.configurations[0].clone();
    other.id = "fake-fail".into();
    other.model_id = "fake-fail".into();
    req.configurations.push(other);
    req.max_executions = 4;
    (req, written)
}
#[tokio::test]
async fn author_cells_are_planned_and_run_like_any_other_cell() {
    let (dir, s, backend) = setup().await;
    let (req, written) = authored_request(&s).await;
    let own = |a: &Attempt| a.version_id == written.id && a.configuration.model_id == "fake-pass";
    let preview = s.preview_run(&req).await.unwrap();
    assert!(preview.valid, "{:?}", preview.issues);
    assert_eq!(preview.execution_count, 4);
    let run = s.start_run(req.clone()).await.unwrap();
    assert_eq!(
        run.request.author_policy.as_deref(),
        Some(AUTHOR_CELLS_MEASURED)
    );
    assert_eq!(run.attempts.len(), 4);
    assert!(run.attempts.iter().any(own));
    // The same request key returns the plan it admitted.
    assert_eq!(s.start_run(req.clone()).await.unwrap().id, run.id);
    for _ in 0..5 {
        s.tick().await.unwrap();
    }
    let run = s.store.run(&run.id).await.unwrap();
    assert_eq!(run.state, "completed");
    let measured = run.attempts.iter().find(|a| own(a)).unwrap();
    assert_eq!(measured.phase, "terminal");
    assert!(super::super::analysis::score(measured).is_some());
    assert_ne!(measured.outcome.as_deref(), Some("excluded"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 4);
    // A configuration that wrote every selected case owes those cases.
    let mut only = req.clone();
    only.request_key = "only-authored".into();
    only.version_ids = vec![written.id.clone()];
    only.configurations.truncate(1);
    let preview = s.preview_run(&only).await.unwrap();
    assert!(preview.valid, "{:?}", preview.issues);
    assert_eq!(preview.execution_count, 1);
    let mut unknown = req.clone();
    unknown.request_key = "unknown-policy".into();
    unknown.author_policy = Some("author-cells-unknown".into());
    let preview = s.preview_run(&unknown).await.unwrap();
    assert!(!preview.valid);
    dir.close().await;
}
#[tokio::test]
async fn a_plan_admitted_before_author_cells_were_measured_keeps_its_rule() {
    let (dir, s, backend) = setup().await;
    let (req, written) = authored_request(&s).await;
    let run = s.start_run(req).await.unwrap();
    // A plan saved before the rule names no author policy, and its own
    // cell, still pending, settles without any model call.
    let mut legacy = run.request.clone();
    legacy.author_policy = None;
    rewrite_plan(&s, &run.id, &legacy).await;
    assert_eq!(s.planned_executions(&legacy).await.unwrap(), 3);
    for _ in 0..5 {
        s.tick().await.unwrap();
    }
    let run = s.store.run(&run.id).await.unwrap();
    assert_eq!(run.state, "completed");
    let excluded = run
        .attempts
        .iter()
        .find(|a| a.version_id == written.id && a.configuration.model_id == "fake-pass")
        .unwrap();
    assert_eq!(excluded.phase, "terminal");
    assert_eq!(excluded.outcome.as_deref(), Some("excluded"));
    assert_eq!(
        excluded.reason.as_deref(),
        Some("authored by this candidate")
    );
    assert!(excluded.session_id.is_none());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 3);
    // Its rule also refuses a plan whose candidate wrote every case.
    let mut only = legacy.clone();
    only.request_key = "only-authored".into();
    only.version_ids = vec![written.id.clone()];
    only.configurations.truncate(1);
    assert_eq!(s.planned_executions(&only).await.unwrap(), 0);
    dir.close().await;
}
#[tokio::test]
async fn a_cli_default_effort_is_refused_at_planning() {
    let (dir, s, backend) = setup().await;
    let mut req = request(&s).await;
    req.configurations[0].effort = Some("default".into());
    let preview = s.preview_run(&req).await.unwrap();
    assert!(!preview.valid);
    assert!(
        preview
            .issues
            .iter()
            .any(|issue| issue.contains("fake-pass")
                && issue.contains("\"default\" is not an effort level")),
        "{:?}",
        preview.issues
    );
    let refused = s.start_run(req.clone()).await.unwrap_err();
    assert!(refused.message.contains("not an effort level"));
    assert!(s.store.runs().await.unwrap().is_empty());
    // An explicit level plans, and so does a model without an effort control.
    req.configurations[0].effort = Some("high".into());
    assert!(s.preview_run(&req).await.unwrap().valid);
    req.configurations[0].effort = None;
    assert!(s.preview_run(&req).await.unwrap().valid);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    dir.close().await;
}
#[tokio::test]
async fn an_unset_effort_is_refused_on_a_model_that_lists_levels() {
    let (dir, s, backend) = setup().await;
    *backend.effort_levels.lock().unwrap() = vec!["high".into()];
    let mut req = request(&s).await;
    req.configurations[0].effort = None;
    let preview = s.preview_run(&req).await.unwrap();
    assert!(!preview.valid);
    assert!(
        preview
            .issues
            .iter()
            .any(|issue| issue.contains("fake-pass")
                && issue.contains("leaves its reasoning effort to the CLI")
                && issue.ends_with("the model lists: high")),
        "{:?}",
        preview.issues
    );
    let refused = s.start_run(req.clone()).await.unwrap_err();
    assert!(refused
        .message
        .contains("leaves its reasoning effort to the CLI"));
    assert!(s.store.runs().await.unwrap().is_empty());
    // A level the model lists plans.
    req.configurations[0].effort = Some("high".into());
    let preview = s.preview_run(&req).await.unwrap();
    assert!(preview.valid, "{:?}", preview.issues);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    dir.close().await;
}
#[tokio::test]
async fn the_analysis_data_leaves_out_attempts_acknowledged_at_the_cli_default() {
    let (dir, s, _) = setup().await;
    let run = s.start_run(request(&s).await).await.unwrap();
    for _ in 0..3 {
        s.tick().await.unwrap();
    }
    let completed = s.store.run(&run.id).await.unwrap();
    assert_eq!(completed.state, "completed");
    let counted = |data: &QueryData| data.attempts.iter().filter(|a| a.run_id == run.id).count();
    let ranked = |data: &QueryData| {
        super::super::analysis::leaderboard(data, &ResultQuery::default())
            .rows
            .iter()
            .any(|row| row.configuration.model_id == "fake-pass")
    };
    let data = s.query_data().await.unwrap();
    assert_eq!(counted(&data), 2);
    assert!(ranked(&data));
    // The bridge acknowledged the CLI's "default" for every attempt of the
    // unset request.
    for attempt in &completed.attempts {
        let mut attempt = s.store.attempt(&attempt.id).await.unwrap();
        attempt.observed.as_mut().unwrap().effort = Some("default".into());
        s.store.save_attempt(&attempt).await.unwrap();
    }
    let data = s.query_data().await.unwrap();
    assert_eq!(counted(&data), 0);
    assert!(!ranked(&data));
    let planned = data.runs.iter().find(|r| r.id == run.id).unwrap();
    assert!(planned.attempts.is_empty());
    assert!(planned.request.configurations.is_empty());
    // Run detail and the raw run listing keep them for audit.
    assert_eq!(s.store.run(&run.id).await.unwrap().attempts.len(), 2);
    let listed = s.store.runs().await.unwrap();
    assert_eq!(
        listed
            .iter()
            .find(|r| r.id == run.id)
            .unwrap()
            .attempt_count,
        2
    );
    dir.close().await;
}
#[tokio::test]
async fn judge_calls_are_reserved_and_only_the_budget_skips_them() {
    let (dir, s, backend) = setup().await;
    let mut req = creative_request(&s).await;
    req.max_executions = 3;
    let preview = s.preview_run(&req).await.unwrap();
    assert_eq!(preview.execution_count, 4);
    assert!(!preview.valid);
    assert!(s.start_run(req.clone()).await.is_err());
    req.max_executions = 4;
    let covered = s.start_run(req.clone()).await.unwrap();
    // A pin that went stale after admission does not cost the panel its reservation.
    let mut stale = req.clone();
    stale.configurations[0].inventory_revision = Some("runtime-before-an-update".into());
    rewrite_plan(&s, &covered.id, &stale).await;
    s.tick().await.unwrap();
    assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    let judged = s.store.attempt(&covered.attempts[0].id).await.unwrap();
    assert_eq!(judged.phase, "terminal");
    assert!(judged.reason.is_none());
    // A plan saved before the reservation never dispatches judges.
    let mut old = req.clone();
    old.request_key = "saved-before-reservations".into();
    let old_run = s.start_run(old.clone()).await.unwrap();
    old.max_executions = 1;
    rewrite_plan(&s, &old_run.id, &old).await;
    s.tick().await.unwrap();
    s.tick().await.unwrap();
    let skipped = s.store.attempt(&old_run.attempts[0].id).await.unwrap();
    assert_eq!(skipped.phase, "terminal");
    assert_eq!(skipped.outcome.as_deref(), Some("pending_review"));
    assert_eq!(
        skipped.reason.as_deref(),
        Some("Judge calls are not covered by this saved run's execution budget")
    );
    assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    dir.close().await;
}
#[tokio::test]
async fn a_large_plan_keeps_its_explicit_execution_and_judge_budget() {
    let (dir, s, backend) = setup().await;
    let mut req = creative_request(&s).await;
    for index in 0..2 {
        let mut draft = creative();
        draft.name = format!("Invented large-plan brief {index}");
        req.version_ids.push(publish(&s, draft).await.id);
    }
    // Three judged cases, 100 repetitions: 300 candidate turns and
    // 900 reserved judge calls. The operator's limit governs all of them.
    req.repetitions = 100;
    req.max_executions = 1199;
    let refused = s.preview_run(&req).await.unwrap();
    assert_eq!(refused.execution_count, 1200);
    assert!(!refused.valid);
    assert!(s.start_run(req.clone()).await.is_err());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    req.max_executions = 1200;
    let preview = s.preview_run(&req).await.unwrap();
    assert!(preview.valid, "{:?}", preview.issues);
    assert_eq!(preview.execution_count, 1200);
    let mut run = s.start_run(req).await.unwrap();
    assert_eq!(run.attempts.len(), 300);
    let version = s.store.version(&run.request.version_ids[0]).await.unwrap();
    assert_eq!(s.judge_budget(&run, &version).await, Some(Ok(true)));
    // Saved plans must still cover the judge reservation. There is no
    // second, hidden ceiling that withholds it from a larger valid plan.
    run.request.max_executions = 1199;
    assert_eq!(s.judge_budget(&run, &version).await, Some(Ok(false)));
    dir.close().await;
}
/// Starts a creative run and stops it with `action` while its panel runs.
pub(super) async fn stop_during_the_panel(
    s: &Arc<BenchmarkService>,
    backend: &FakeBackend,
    action: &str,
) -> BenchmarkRun {
    backend.hold_judges.store(true, Ordering::SeqCst);
    let run = s.start_run(creative_request(s).await).await.unwrap();
    let background = s.clone();
    let tick = tokio::spawn(async move { background.tick().await });
    backend.judge_entered.notified().await;
    // The cancel signal stays live while the panel runs.
    assert!(!s.active.lock().await.is_empty());
    s.control(&run.id, action).await.unwrap();
    backend.hold_judges.store(false, Ordering::SeqCst);
    backend.judge_release.notify_one();
    tick.await.unwrap().unwrap();
    assert_eq!(backend.stopped_judges.load(Ordering::SeqCst), 1, "{action}");
    assert!(s.active.lock().await.is_empty());
    run
}
#[tokio::test]
async fn a_paused_panel_is_asked_again_after_resume_without_a_new_generation() {
    let (dir, s, backend) = setup().await;
    let run = stop_during_the_panel(&s, &backend, "pause").await;
    let id = &run.attempts[0].id;
    let waiting = s.store.attempt(id).await.unwrap();
    assert_eq!(waiting.phase, AWAITING_JUDGES);
    assert_eq!(waiting.outcome.as_deref(), Some("pending_review"));
    assert!(waiting.output.is_some());
    // While paused nothing is asked and the run never completes.
    for _ in 0..3 {
        s.tick().await.unwrap();
    }
    assert_eq!(s.store.run(&run.id).await.unwrap().state, "paused");
    assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    s.control(&run.id, "resume").await.unwrap();
    s.tick().await.unwrap();
    assert_eq!(backend.judges.load(Ordering::SeqCst), 2);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    let judged = s.store.attempt(id).await.unwrap();
    assert_eq!(judged.phase, "terminal");
    assert!(judged.reason.is_none());
    s.tick().await.unwrap();
    assert_eq!(s.store.run(&run.id).await.unwrap().state, "completed");
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    dir.close().await;
}
#[tokio::test]
async fn a_cancel_settles_a_rendering_that_waits_for_its_panel() {
    let (dir, s, backend) = setup().await;
    let run = stop_during_the_panel(&s, &backend, "pause").await;
    s.tick().await.unwrap();
    s.control(&run.id, "cancel").await.unwrap();
    s.tick().await.unwrap();
    assert_eq!(s.store.run(&run.id).await.unwrap().state, "cancelled");
    let a = s.store.attempt(&run.attempts[0].id).await.unwrap();
    assert_eq!(a.phase, "terminal");
    assert_eq!(a.outcome.as_deref(), Some("pending_review"));
    assert_eq!(a.reason.as_deref(), Some(JUDGING_STOPPED));
    assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    dir.close().await;
}
#[tokio::test]
async fn busy_judges_hold_the_run_open_until_the_panel_is_asked() {
    let (dir, s, backend) = setup().await;
    backend.busy_judges.store(true, Ordering::SeqCst);
    let run = s.start_run(creative_request(&s).await).await.unwrap();
    let id = &run.attempts[0].id;
    for _ in 0..3 {
        s.tick().await.unwrap();
    }
    assert_eq!(s.store.attempt(id).await.unwrap().phase, AWAITING_JUDGES);
    assert_eq!(s.store.run(&run.id).await.unwrap().state, "running");
    backend.busy_judges.store(false, Ordering::SeqCst);
    let mut waiting = s.store.attempt(id).await.unwrap();
    waiting.wait_until = Some(now() - 1);
    s.store.save_attempt(&waiting).await.unwrap();
    s.tick().await.unwrap();
    let judged = s.store.attempt(id).await.unwrap();
    assert_eq!(judged.phase, "terminal");
    assert!(judged.reason.is_none());
    s.tick().await.unwrap();
    assert_eq!(s.store.run(&run.id).await.unwrap().state, "completed");
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    dir.close().await;
}
/// Rewrites a creative run's first attempt as a killed process left it:
/// mid-panel with a render marker and an in-flight judge turn, or sealed
/// but not yet evaluated. Then the app restarts.
pub(super) async fn restart_during_the_first_panel(
    s: &Arc<BenchmarkService>,
    backend: &FakeBackend,
    evaluated: bool,
) -> String {
    let run = s.start_run(creative_request(s).await).await.unwrap();
    s.tick().await.unwrap();
    assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
    a.phase = "collecting".into();
    if evaluated {
        let mut marker = judge_abstention(
            &s.store.version(&a.version_id).await.unwrap(),
            &judge_row("sonnet"),
            "batch",
            String::new(),
        );
        marker.provenance = "render".into();
        marker.verdict = "rendered".into();
        marker.judge = None;
        marker.details = Some(json!({"judgeBatchId": "batch", "expectedJudges": 2,
            "protocol": {"panel": [judge_row("sonnet"), judge_row("haiku")]}}));
        let mut placeholder = marker.clone();
        placeholder.id = "in-flight".into();
        placeholder.provenance = "judge_failure".into();
        placeholder.verdict = "abstained".into();
        placeholder.judge = Some(judge_row("sonnet"));
        placeholder.details = Some(json!({"judgeBatchId": "batch", "sessionId": "session",
            "requestKey": "key", "usageComplete": false, "inFlight": true}));
        a.evaluations.extend([marker, placeholder]);
        assert_eq!(a.outcome.as_deref(), Some("pending_review"));
    } else {
        a.outcome = Some("completed".into());
        a.evaluations.clear();
    }
    s.store.save_attempt(&a).await.unwrap();
    s.store.recover().await.unwrap();
    s.reconcile_judges().await.unwrap();
    s.tick().await.unwrap();
    a.id
}

#[tokio::test]
async fn resume_refreshes_only_pending_and_replacement_runtime_pins() {
    let (dir, s, backend) = setup().await;
    let run = s.start_run(request(&s).await).await.unwrap();
    let mut failed = s.store.attempt(&run.attempts[0].id).await.unwrap();
    failed.phase = "terminal".into();
    failed.outcome = Some("execution_failed".into());
    s.store.save_attempt(&failed).await.unwrap();
    s.store
        .set_run_state(&run.id, "needs_attention")
        .await
        .unwrap();
    *backend.inventory_revision.lock().unwrap() = Some("fake-v2".into());
    let resumed = s.control(&run.id, "resume").await.unwrap();
    assert_eq!(resumed.state, "running");
    let pending: Vec<_> = resumed
        .attempts
        .iter()
        .filter(|a| a.phase == "pending")
        .collect();
    assert_eq!(pending.len(), 2);
    for attempt in pending {
        assert_eq!(
            attempt.configuration.inventory_revision.as_deref(),
            Some("fake-v2")
        );
        assert_eq!(
            attempt.configuration.model_id,
            failed.configuration.model_id
        );
        assert_eq!(
            attempt.configuration.account_id,
            failed.configuration.account_id
        );
    }
    let original = s.store.attempt(&failed.id).await.unwrap();
    assert_eq!(
        original.configuration.inventory_revision.as_deref(),
        Some("fake-v1")
    );
    assert_eq!(original.outcome.as_deref(), Some("superseded"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    dir.close().await;
}

#[tokio::test]
async fn resume_refuses_changed_model_options_without_mutating_the_run() {
    let (dir, s, backend) = setup().await;
    let run = s.start_run(request(&s).await).await.unwrap();
    s.store.set_run_state(&run.id, "paused").await.unwrap();
    *backend.inventory_revision.lock().unwrap() = Some("fake-v2".into());
    *backend.effort_levels.lock().unwrap() = vec!["high".into()];
    let error = s.control(&run.id, "resume").await.unwrap_err();
    assert_eq!(error.code, "selection_changed");
    let unchanged = s.store.run(&run.id).await.unwrap();
    assert_eq!(unchanged.state, "paused");
    assert_eq!(
        unchanged.request.configurations[0]
            .inventory_revision
            .as_deref(),
        Some("fake-v1")
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    dir.close().await;
}

#[tokio::test]
async fn resume_recovers_a_missing_answer_from_its_verified_seal() {
    let (dir, s, backend) = setup().await;
    let run = s.start_run(creative_request(&s).await).await.unwrap();
    s.tick().await.unwrap();
    let id = &run.attempts[0].id;
    let mut attempt = s.store.attempt(id).await.unwrap();
    let output = attempt.output.take();
    assert!(output.is_some());
    let seal = attempt.evidence_hash.clone();
    let session = attempt.session_id.clone();
    attempt.phase = "terminal".into();
    attempt.outcome = Some("pending_review".into());
    attempt.reason = None;
    attempt.evaluations.retain(|e| e.provenance != "judge");
    let previous = serde_json::to_value(&attempt.evaluations).unwrap();
    s.store.save_attempt(&attempt).await.unwrap();
    s.store
        .set_run_state(&run.id, "needs_attention")
        .await
        .unwrap();
    s.control(&run.id, "resume").await.unwrap();
    let queued = s.store.attempt(id).await.unwrap();
    assert_eq!(queued.phase, AWAITING_JUDGES);
    assert_eq!(queued.output, output);
    assert_eq!(queued.evidence_hash, seal);
    assert_eq!(queued.session_id, session);
    assert_eq!(serde_json::to_value(&queued.evaluations).unwrap(), previous);
    s.tick().await.unwrap();
    let judged = s.store.attempt(id).await.unwrap();
    assert_eq!(judged.output, output);
    assert_eq!(judged.evidence_hash, seal);
    assert_eq!(judged.phase, "terminal");
    assert!(judged.reason.is_none());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.judges.load(Ordering::SeqCst), 2);
    dir.close().await;
}

#[tokio::test]
async fn resume_rejects_missing_tampered_or_unrelated_sealed_answers() {
    for fault in ["missing", "hash", "attempt", "session", "output"] {
        let (dir, s, backend) = setup().await;
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let mut attempt = s.store.attempt(&run.attempts[0].id).await.unwrap();
        let evidence_dir = s
            .store
            .root
            .join("runs")
            .join(&run.id)
            .join(&attempt.id)
            .join("evidence");
        let path = evidence_dir.join(format!("{}.json", attempt.evidence_hash.as_ref().unwrap()));
        if fault == "missing" {
            tokio::fs::remove_file(path).await.unwrap();
        } else if fault == "hash" {
            tokio::fs::write(path, b"{}").await.unwrap();
        } else {
            let mut evidence: Value =
                serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
            match fault {
                "attempt" => evidence["attemptId"] = json!("another-attempt"),
                "session" => evidence["sessionId"] = json!("another-session"),
                "output" => evidence["output"] = Value::Null,
                _ => unreachable!(),
            }
            let bytes = serde_json::to_vec(&evidence).unwrap();
            let digest = fixtures::hash(&bytes);
            tokio::fs::write(evidence_dir.join(format!("{digest}.json")), bytes)
                .await
                .unwrap();
            attempt.evidence_hash = Some(digest);
        }
        attempt.output = None;
        attempt.phase = "terminal".into();
        attempt.outcome = Some("pending_review".into());
        attempt.reason = None;
        attempt.evaluations.retain(|e| e.provenance != "judge");
        s.store.save_attempt(&attempt).await.unwrap();
        s.store
            .set_run_state(&run.id, "needs_attention")
            .await
            .unwrap();
        let error = s.control(&run.id, "resume").await.unwrap_err();
        assert_eq!(error.code, "evidence_missing", "{fault}");
        let unchanged = s.store.attempt(&attempt.id).await.unwrap();
        assert_eq!(
            serde_json::to_value(&unchanged).unwrap(),
            serde_json::to_value(&attempt).unwrap(),
            "{fault}"
        );
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "needs_attention");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        dir.close().await;
    }
}

#[tokio::test]
async fn a_restart_inside_a_completed_run_settles_the_rendering() {
    let (dir, s, backend) = setup().await;
    let run = s.start_run(creative_request(&s).await).await.unwrap();
    s.tick().await.unwrap();
    // A failed final save left the rendering mid-panel; the run completed anyway.
    let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
    a.phase = "collecting".into();
    s.store.save_attempt(&a).await.unwrap();
    s.store.set_run_state(&run.id, "completed").await.unwrap();
    s.store.recover().await.unwrap();
    s.tick().await.unwrap();
    // Nothing resumes a completed run, so the rendering never waits for a panel.
    let settled = s.store.attempt(&a.id).await.unwrap();
    assert_eq!(settled.phase, "terminal");
    assert_eq!(settled.outcome.as_deref(), Some("pending_review"));
    assert_eq!(s.store.run(&run.id).await.unwrap().state, "completed");
    assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    dir.close().await;
}
#[tokio::test]
async fn a_resumed_panel_whose_votes_all_landed_asks_no_judge() {
    let (dir, s, backend) = setup().await;
    let run = s.start_run(creative_request(&s).await).await.unwrap();
    s.tick().await.unwrap();
    assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    // Each vote was saved as it landed, but the process stopped before the
    // attempt's final save.
    let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
    a.evaluations.extend(settled_batch());
    a.phase = AWAITING_JUDGES.into();
    a.reason = None;
    s.store.save_attempt(&a).await.unwrap();
    s.tick().await.unwrap();
    assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    let settled = s.store.attempt(&a.id).await.unwrap();
    assert_eq!(settled.phase, "terminal");
    assert!(settled.reason.is_none());
    assert_eq!(super::super::analysis::score(&settled), Some(0.7));
    assert_eq!(
        s.store.stored_outcome(&a.id).await.unwrap().as_deref(),
        Some("judged")
    );
    dir.close().await;
}
#[tokio::test]
async fn a_recovered_rendering_its_candidate_authored_asks_no_judge() {
    let (dir, s, backend) = setup().await;
    let run = s.start_run(creative_request(&s).await).await.unwrap();
    s.tick().await.unwrap();
    assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    // A plan saved before authored cells were left out generated one, and
    // a restart cut off its panel.
    let mut authored = creative();
    authored.name.push_str(" written by the candidate");
    authored.environment["authoredBy"] = json!([run.request.configurations[0]]);
    let written = publish(&s, authored).await;
    let mut request = run.request.clone();
    request.author_policy = None;
    rewrite_plan(&s, &run.id, &request).await;
    let mut legacy = s.store.attempt(&run.attempts[0].id).await.unwrap();
    legacy.id = "legacy-authored".into();
    legacy.version_id = written.id.clone();
    legacy.phase = "collecting".into();
    assert_eq!(legacy.outcome.as_deref(), Some("pending_review"));
    sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,0,'collecting',?)")
        .bind(&legacy.id).bind(&run.id).bind(&written.id).bind(&legacy.configuration.id)
        .bind(serde_json::to_string(&legacy).unwrap())
        .execute(&s.store.pool).await.unwrap();
    s.store.recover().await.unwrap();
    s.tick().await.unwrap();
    s.control(&run.id, "resume").await.unwrap();
    for _ in 0..3 {
        s.tick().await.unwrap();
    }
    assert_eq!(s.store.run(&run.id).await.unwrap().state, "completed");
    let excluded = s.store.attempt("legacy-authored").await.unwrap();
    assert_eq!(excluded.phase, "terminal");
    assert_eq!(excluded.outcome.as_deref(), Some("excluded"));
    assert_eq!(
        excluded.reason.as_deref(),
        Some("authored by this candidate")
    );
    // The paid generation stays on record. Resume retries only the
    // original unfinished panel, never the excluded authored attempt.
    assert!(excluded.output.is_some());
    assert_eq!(backend.judges.load(Ordering::SeqCst), 2);
    assert_eq!(
        *backend.judged_attempts.lock().unwrap(),
        vec![run.attempts[0].id.clone(), run.attempts[0].id.clone()]
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    dir.close().await;
}
#[tokio::test]
async fn failed_judging_requires_attention_and_preserves_the_paid_answer() {
    let (dir, s, backend) = setup().await;
    let run = s.start_run(creative_request(&s).await).await.unwrap();
    let mut a = run.attempts[0].clone();
    a.phase = "terminal".into();
    a.outcome = Some("pending_review".into());
    a.reason = Some("No judge panel: 1 eligible judge(s), at least 2 are required".into());
    a.output = Some("Preserved answer".into());
    a.finished_at = Some(now());
    s.store.save_attempt(&a).await.unwrap();
    // The reason is visible immediately, while other work could still run.
    assert_eq!(
        s.store.runs().await.unwrap()[0]
            .attention
            .as_ref()
            .unwrap()
            .reason,
        a.reason.clone().unwrap()
    );
    s.tick().await.unwrap();
    let stopped = s.store.run(&run.id).await.unwrap();
    assert_eq!(stopped.state, "needs_attention");
    assert_eq!(s.store.attempt(&a.id).await.unwrap().output, a.output);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
    // Historical runs also expose the problem instead of a silent success.
    s.store.set_run_state(&run.id, "completed").await.unwrap();
    let summary = s.store.runs().await.unwrap().remove(0);
    assert_eq!(
        summary.attention.unwrap().outcome.as_deref(),
        Some("pending_review")
    );
    dir.close().await;
}
#[tokio::test]
async fn a_panel_that_fails_before_saving_keeps_the_objective_verdict() {
    let (dir, s, backend) = setup().await;
    backend.fail_judges.store(true, Ordering::SeqCst);
    let run = s.start_run(creative_request(&s).await).await.unwrap();
    s.tick().await.unwrap();
    let a = s.store.attempt(&run.attempts[0].id).await.unwrap();
    assert_eq!(a.phase, "terminal");
    assert_eq!(a.outcome.as_deref(), Some("pending_review"));
    assert!(a
        .evaluations
        .iter()
        .any(|e| e.provenance == "objective" && e.verdict == "pending_review"));
    assert!(a.reason.as_deref().unwrap().starts_with("Judging failed:"));
    dir.close().await;
}
/// A scripted panel: `answers[i]` is judge `i`'s answer.
pub(super) struct ScriptedPanel {
    pub(super) answers: Vec<JudgeAnswer>,
    pub(super) asked: Vec<usize>,
    pub(super) halt_after: Option<usize>,
}
impl PanelJudges for ScriptedPanel {
    fn halted(&mut self) -> BoxFuture<'_, Result<bool>> {
        let halted = self.halt_after.is_some_and(|n| self.asked.len() >= n);
        Box::pin(async move { Ok(halted) })
    }
    fn ask<'s>(
        &'s mut self,
        index: usize,
        _: &'s Configuration,
    ) -> BoxFuture<'s, Result<JudgeAnswer>> {
        self.asked.push(index);
        let answer = self.answers[index];
        Box::pin(async move { Ok(answer) })
    }
}
#[test]
fn resuming_an_incomplete_batch_keeps_its_valid_votes_and_failed_evidence() {
    let panel: Vec<Configuration> = ["opus[1m]", "haiku", "claude-opus-4-8"]
        .into_iter()
        .map(judge_row)
        .collect();
    let evaluation =
        |provenance: &str, judge: Option<&Configuration>, score: Option<f64>| Evaluation {
            id: uuid::Uuid::new_v4().to_string(),
            evaluator_revision: "1".into(),
            verdict: "v".into(),
            score,
            reason: String::new(),
            created_at: 1,
            provenance: provenance.into(),
            artifacts: Vec::new(),
            details: Some(json!({"judgeBatchId":"batch", "usageComplete":true})),
            judge: judge.cloned(),
            usage: None,
        };
    let mut marker = evaluation("render", None, None);
    marker.artifacts.push(Artifact {
        kind: "screenshot".into(),
        path: "rendering.png".into(),
        hash: "h".into(),
        label: "Rendering".into(),
    });
    marker.details = Some(json!({"judgeBatchId": "batch", "expectedJudges": 3,
        "protocol": {"panel": panel, "expectedJudges": 3}}));
    let mut evaluations = vec![
        evaluation("objective", None, None),
        marker,
        evaluation("judge", Some(&panel[0]), Some(0.7)),
    ];
    let open = open_batch(&evaluations).unwrap();
    assert_eq!((open.id.as_str(), open.expected), ("batch", 3));
    assert_eq!(open.asked, vec![panel[0].clone()]);
    assert_eq!(open.rendering, "rendering.png");
    // Explicit resume retries the failed seat, retaining the valid vote.
    evaluations.push(evaluation("judge_failure", Some(&panel[1]), None));
    assert_eq!(
        open_batch(&evaluations).unwrap().asked,
        vec![panel[0].clone()]
    );
    evaluations.pop();
    evaluations.push(evaluation("judge", Some(&panel[1]), Some(0.6)));
    evaluations.push(evaluation("judge", Some(&panel[2]), Some(0.5)));
    assert!(open_batch(&evaluations).is_none());
    assert!(open_batch(&evaluations[..1]).is_none());
}

#[tokio::test]
async fn evaluating_again_keeps_budget_failures_exclusions_and_human_overrides() {
    let (dir, s, backend) = setup().await;
    let mut req = request(&s).await;
    req.repetitions = 1;
    req.max_executions = 1;
    let run = s.start_run(req).await.unwrap();
    s.tick().await.unwrap();
    let id = run.attempts[0].id.clone();
    assert_eq!(
        s.store.attempt(&id).await.unwrap().outcome.as_deref(),
        Some("pass")
    );
    // The output still holds a passing answer; the recorded outcome stands.
    for outcome in [
        "budget_timeout",
        "budget_reached",
        "cancelled",
        "selection_changed",
        "excluded",
    ] {
        let mut a = s.store.attempt(&id).await.unwrap();
        a.outcome = Some(outcome.into());
        a.evaluations.clear();
        s.store.save_attempt(&a).await.unwrap();
        assert_eq!(s.rescore(&id).await.unwrap_err().code, "validation");
        let kept = s.store.attempt(&id).await.unwrap();
        assert_eq!(kept.outcome.as_deref(), Some(outcome));
        assert!(kept.evaluations.is_empty());
    }
    // A human review overrides the panel, so no judge is asked again.
    let creative = s.start_run(creative_request(&s).await).await.unwrap();
    s.tick().await.unwrap();
    s.tick().await.unwrap();
    let reviewed = s
        .review(&creative.attempts[0].id, 0.8, "Override".into(), None)
        .await
        .unwrap();
    let asked = backend.judges.load(Ordering::SeqCst);
    assert_eq!(asked, 1);
    assert_eq!(
        s.rescore(&reviewed.id).await.unwrap_err().code,
        "validation"
    );
    assert_eq!(backend.judges.load(Ordering::SeqCst), asked);
    // A human override cannot turn a timeout into a verdict either: the
    // turn failed its task, and that stands.
    let mut timed_out = s.store.attempt(&creative.attempts[0].id).await.unwrap();
    timed_out.outcome = Some("budget_timeout".into());
    timed_out.evaluations.clear();
    s.store.save_attempt(&timed_out).await.unwrap();
    let refused = s
        .review(&timed_out.id, 1.0, "Override".into(), None)
        .await
        .unwrap_err();
    assert_eq!(refused.message, "Only an evaluated result can be reviewed");
    let kept = s.store.attempt(&timed_out.id).await.unwrap();
    assert_eq!(kept.outcome.as_deref(), Some("budget_timeout"));
    assert_eq!(super::super::analysis::score(&kept), Some(0.0));
    dir.close().await;
}
#[tokio::test]
async fn evaluating_again_persists_the_new_verdict_of_a_finished_attempt() {
    let (dir, s, _) = setup().await;
    let mut req = request(&s).await;
    req.repetitions = 1;
    req.max_executions = 1;
    let run = s.start_run(req).await.unwrap();
    let id = run.attempts[0].id.clone();
    let waiting = s.rescore(&id).await.unwrap_err();
    assert_eq!(waiting.code, "validation");
    assert_eq!(waiting.message, "Only a finished attempt can be rescored");
    s.tick().await.unwrap();
    // An evaluator failure on a passing answer, evaluated again.
    let mut a = s.store.attempt(&id).await.unwrap();
    a.outcome = Some("evaluation_error".into());
    a.evaluations.clear();
    s.store.save_attempt(&a).await.unwrap();
    let rescored = s.rescore(&id).await.unwrap();
    assert_eq!(rescored.outcome.as_deref(), Some("pass"));
    // The raw record, not only its normalized reading, holds the verdict.
    assert_eq!(
        s.store.stored_outcome(&id).await.unwrap().as_deref(),
        Some("pass")
    );
    let stored = s.store.attempt(&id).await.unwrap();
    assert_eq!(stored.evaluations.len(), 1);
    assert_eq!(super::super::analysis::score(&stored), Some(1.0));
    dir.close().await;
}
#[tokio::test]
async fn a_panel_on_one_attempt_never_blocks_a_review_of_another() {
    let (dir, s, _) = setup().await;
    let mut req = creative_request(&s).await;
    req.repetitions = 2;
    req.max_executions = 8;
    let run = s.start_run(req).await.unwrap();
    s.tick().await.unwrap();
    s.tick().await.unwrap();
    let (first, second) = (&run.attempts[0].id, &run.attempts[1].id);
    let panel = super::super::evaluation_lock(first);
    let _held = panel.lock().await;
    let review = s.review(second, 0.5, "Reviewed meanwhile".into(), None);
    let reviewed = tokio::time::timeout(Duration::from_secs(5), review).await;
    assert!(reviewed.expect("review waited on another panel").is_ok());
    let busy = s.rescore(first).await.unwrap_err();
    assert_eq!(busy.message, "This attempt is already being evaluated");
    dir.close().await;
}
/// A render marker for two judges and their valid votes, 0.6 and 0.8.
pub(super) fn settled_batch() -> [Evaluation; 3] {
    let vote = |id: &str, score: f64| Evaluation {
        id: id.into(),
        evaluator_revision: "1".into(),
        verdict: if id == "render" { "rendered" } else { "judged" }.into(),
        score: (id != "render").then_some(score),
        reason: "recorded".into(),
        created_at: now(),
        provenance: if id == "render" { "render" } else { "judge" }.into(),
        artifacts: Vec::new(),
        details: (id == "render").then(|| json!({"expectedJudges": 2})),
        judge: (id != "render").then(|| judge_row("sonnet")),
        usage: None,
    };
    [vote("render", 0.0), vote("first", 0.6), vote("second", 0.8)]
}
#[tokio::test]
async fn an_answer_without_markup_fails_and_asks_no_judge() {
    let (dir, s, backend) = setup().await;
    let mut req = creative_request(&s).await;
    req.configurations[0].id = "fake-fail".into();
    req.configurations[0].model_id = "fake-fail".into();
    let run = s.start_run(req).await.unwrap();
    s.tick().await.unwrap();
    let a = s.store.attempt(&run.attempts[0].id).await.unwrap();
    assert_eq!(a.output.as_deref(), Some("I cannot draw."));
    assert_eq!(a.outcome.as_deref(), Some("fail"));
    assert_eq!(super::super::analysis::score(&a), Some(0.0));
    assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
    dir.close().await;
}
#[tokio::test]
async fn judge_turns_cut_off_by_a_restart_are_settled_and_never_vote() {
    let (dir, s, _) = setup().await;
    let run = s.start_run(creative_request(&s).await).await.unwrap();
    s.tick().await.unwrap();
    let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
    a.evaluations.push(Evaluation {
        id: "in-flight".into(),
        evaluator_revision: "1".into(),
        verdict: "abstained".into(),
        score: None,
        reason: "Judge turn in flight".into(),
        created_at: now(),
        provenance: "judge_failure".into(),
        artifacts: Vec::new(),
        details: Some(json!({"judgeBatchId": "batch", "sessionId": "session",
            "requestKey": "key", "usageComplete": false, "inFlight": true})),
        judge: Some(judge_row("sonnet")),
        usage: None,
    });
    s.store.save_attempt(&a).await.unwrap();
    s.reconcile_judges().await.unwrap();
    let a = s.store.attempt(&a.id).await.unwrap();
    let settled = a.evaluations.iter().find(|e| e.id == "in-flight").unwrap();
    assert!(!in_flight(settled));
    assert!(settled.reason.contains("restart"));
    assert!(settled.score.is_none());
    let left: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM attempts a,json_each(a.data_json,'$.evaluations') e
         WHERE json_extract(e.value,'$.details.inFlight')=1",
    )
    .fetch_one(&s.store.pool)
    .await
    .unwrap();
    assert_eq!(left, 0);
    dir.close().await;
}
