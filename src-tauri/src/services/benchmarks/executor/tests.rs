use super::*;
use crate::services::benchmarks::selector::RoleWeights;

fn request() -> Request {
    let data = learned::tests::data();
    let candidates: Vec<_> = data.runs[0]
        .request
        .configurations
        .iter()
        .map(|configuration| RoutingCandidate {
            configuration: configuration.clone(),
            available: true,
            reason: None,
        })
        .collect();
    Request {
        request_key: "example-wave:step-0".into(),
        surface: "wave".into(),
        context_id: "example-wave".into(),
        prior_keys: candidates
            .iter()
            .rev()
            .map(|row| routing::candidate_key(&row.configuration))
            .collect(),
        model_id: None,
        prediction: learned::PredictionRequest {
            task: learned::PublicTask::from(&data.versions[0].manifest),
            target_family: "unseen-family".into(),
            target_group: "unseen-group".into(),
            candidates,
            hard_candidate_key: None,
            min_quality: 0.5,
        },
    }
}

async fn fitted(store: &Store) -> learned::FitArtifact {
    let data = learned::tests::data();
    let artifact = learned::fit(
        &data,
        learned::FitRequest {
            work_class_id: "debug".into(),
            version_ids: data
                .versions
                .iter()
                .map(|version| version.id.clone())
                .collect(),
            configurations: data.runs[0].request.configurations.clone(),
            cutoff_at: 10,
            weights: RoleWeights::default(),
        },
    )
    .unwrap();
    store.save_selector_fit(&artifact).await.unwrap();
    artifact
}

fn started(decision: &Decision) -> Observation {
    Observation {
        phase: "started".into(),
        session_id: Some("example-session".into()),
        run_id: Some("example-run".into()),
        configuration: decision.chosen.clone(),
        outcome: None,
        reason: None,
    }
}

/// Invented persistence fixtures test provenance joins only. They are not
/// qualification, promotion, runtime-probe or model-performance evidence.
async fn native_journal_fixture(
    root: &std::path::Path,
    profile: &str,
) -> (
    Store,
    crate::services::agent_host::store::SessionStore,
    ExecutorReceipt,
    Configuration,
) {
    use crate::services::agent_host::{
        execution::{
            ExecutionDispatch, ExecutionProfile, ObservedSelection, OwnedSession,
            OwnedSessionRequest,
        },
        executor_receipts::{ExecutorLink, ReceiptFinish, ReceiptStart, ReportedSelection},
        store::{SessionRecord, SessionStore},
    };
    use crate::services::benchmarks::task_execution::{Binding, Request as TaskRequest, Session};
    let store = Store::open(&root.join("bench")).await.unwrap();
    let host = SessionStore::open(&root.join("host.db")).await.unwrap();
    let configuration = Configuration {
        id: "invented-worker".into(),
        provider_id: "claude-acp".into(),
        account_id: Some("invented-account".into()),
        model_id: "invented-model".into(),
        effort: Some("high".into()),
        fast_mode: Some(false),
        billing_mode: "subscription".into(),
        execution_profile: profile.into(),
        inventory_revision: Some("invented-verified-native-runtime".into()),
        model_name: None,
    };
    let mut input = request();
    input.request_key = format!("owned-task:journal-{profile}");
    input.prediction.task.execution_profile = profile.into();
    input.prediction.candidates = vec![RoutingCandidate {
        configuration: configuration.clone(),
        available: true,
        reason: None,
    }];
    input.prior_keys = vec![routing::candidate_key(&configuration)];
    let decision = store.prepare_executor_decision(input).await.unwrap();
    let id = format!("journal-{profile}");
    let task_request = TaskRequest {
        request_key: decision.request.request_key.clone(),
        surface: "chat".into(),
        context_id: "invented-native-context".into(),
        promotion_id: "invented-fixture".into(),
        acknowledged_certificate_hash: "invented-certificate".into(),
        prompt: decision.request.prediction.task.prompt.clone(),
        hard_candidate_key: None,
        repository: None,
        entry: None,
        wave_mode: None,
    };
    let task = decision.request.prediction.task.clone();
    let mut binding = Binding {
        id: id.clone(),
        created_at: 1,
        context_hash: hash(&(&task, &task_request.repository)).unwrap(),
        request: task_request,
        certificate_hash: "invented-certificate".into(),
        task,
        decision,
        artifact_hash: String::new(),
        context_v2: None,
    };
    binding.artifact_hash = hash(&binding).unwrap();
    sqlx::query("INSERT INTO task_context_bindings(id,request_key,request_hash,binding_json,binding_hash) VALUES(?,?,?,?,?)").bind(&id).bind(&binding.request.request_key).bind(hash(&binding.request).unwrap()).bind(serde_json::to_string(&binding).unwrap()).bind(&binding.artifact_hash).execute(&store.pool).await.unwrap();
    let owner = OwnedSessionRequest {
        owner_id: format!("task:{id}"),
        provider_id: configuration.provider_id.clone(),
        account_id: configuration.account_id.clone().unwrap(),
        model_id: configuration.model_id.clone(),
        reasoning_effort: configuration.effort.clone(),
        fast_mode: configuration.fast_mode,
        cwd: "C:/invented-native".into(),
        title: "Invented native task".into(),
        profile: if profile == "native_text" {
            ExecutionProfile::NativeTextV1
        } else {
            ExecutionProfile::ProtectedRepositoryV1
        },
    };
    let record = SessionRecord {
        id: "native-session".into(),
        harness: configuration.provider_id.clone(),
        account_id: configuration.account_id.clone(),
        bridge_session_id: Some("invented-bridge-session".into()),
        cwd: owner.cwd.clone(),
        title: Some(owner.title.clone()),
        user_set_name: false,
        project_id: None,
        persona_id: None,
        model_id: Some(configuration.model_id.clone()),
        reasoning_effort: configuration.effort.clone(),
        fast_mode: configuration.fast_mode,
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
    host.insert_owned_session_for_purpose(&record, &owner, "invented-native-policy-hash", "task")
        .await
        .unwrap();
    let session = Session {
        owned: OwnedSession {
            session_id: record.id.clone(),
            owner_id: owner.owner_id.clone(),
            policy_hash: "invented-native-policy-hash".into(),
            selection: ObservedSelection {
                model_id: record.model_id.clone(),
                reasoning_effort: record.reasoning_effort.clone(),
                fast_mode: record.fast_mode,
            },
            substitutions: vec![],
        },
        observed: configuration.clone(),
        context_hash: binding.context_hash.clone(),
    };
    sqlx::query(
        "INSERT INTO task_owned_sessions(binding_id,session_json,session_hash) VALUES(?,?,?)",
    )
    .bind(&id)
    .bind(serde_json::to_string(&session).unwrap())
    .bind(hash(&session).unwrap())
    .execute(&store.pool)
    .await
    .unwrap();
    let start = ReceiptStart {
        link: ExecutorLink {
            decision_key: binding.request.request_key.clone(),
            logical_run_id: binding.request.request_key.clone(),
        },
        session_id: record.id.clone(),
        host_run_id: "native-run".into(),
        message_id: "native-user".into(),
        bridge_generation: 1,
        provider_id: configuration.provider_id.clone(),
        account_id: configuration.account_id.clone(),
        started_at: "2026-01-01T00:00:00Z".into(),
        selection: ReportedSelection {
            model_id: record.model_id.clone(),
            model_name: None,
            effort: record.reasoning_effort.clone(),
            fast: record.fast_mode,
        },
    };
    host.reserve_dispatch(
        &ExecutionDispatch {
            request_key: start.link.decision_key.clone(),
            session_id: record.id.clone(),
            run_id: start.host_run_id.clone(),
            user_message_id: start.message_id.clone(),
            phase: "reserved".into(),
            event_cursor: 0,
            result: None,
            error: None,
        },
        "invented-prompt",
    )
    .await
    .unwrap();
    host.claim_executor_receipt(&start).await.unwrap();
    host.finish_executor_receipt(
        &start,
        &ReceiptFinish {
            finished_at: "2026-01-01T00:00:01Z".into(),
            status: "completed".into(),
            selection: start.selection.clone(),
            changes: vec![],
            changes_truncated: false,
        },
    )
    .await
    .unwrap();
    host.settle_task_dispatch(
        &start.link.decision_key,
        &record.id,
        Some(&serde_json::json!({"stopReason":"end_turn"})),
        None,
        Some("invented public output"),
        1000,
    )
    .await
    .unwrap();
    let receipt = host
        .executor_receipt(&start.link.decision_key)
        .await
        .unwrap()
        .unwrap();
    (store, host, receipt, configuration)
}

#[tokio::test]
async fn owned_terminal_journal_uses_native_profile_runtime_and_billing_and_deduplicates() {
    for profile in ["native_text", "protected_repository"] {
        let dir = tempfile::tempdir().unwrap();
        let (store, host, receipt, expected) = native_journal_fixture(dir.path(), profile).await;
        assert!(store
            .observe_application_executor(
                &receipt.start.link.decision_key,
                Observation {
                    phase: "terminal".into(),
                    session_id: Some(receipt.start.session_id.clone()),
                    run_id: Some(receipt.start.link.logical_run_id.clone()),
                    configuration: Some(expected.clone()),
                    outcome: Some("completed".into()),
                    reason: None
                }
            )
            .await
            .is_err());
        let record = store
            .observe_native_host_outcome(
                &host,
                &receipt.start.link.decision_key,
                receipt.start.session_id.clone(),
                receipt.start.link.logical_run_id.clone(),
                "completed".into(),
                Some(receipt.clone()),
            )
            .await
            .unwrap();
        let actual = record.observations[0]
            .observation
            .configuration
            .as_ref()
            .unwrap();
        assert_eq!(actual.execution_profile, profile);
        assert_eq!(actual.inventory_revision, expected.inventory_revision);
        assert_eq!(actual.billing_mode, expected.billing_mode);
        assert_eq!(actual.model_id, expected.model_id);
        assert_eq!(actual.account_id, expected.account_id);
        assert_eq!(actual.effort, expected.effort);
        assert_eq!(actual.fast_mode, expected.fast_mode);
        assert_eq!(record.observations[0].matches_selected, Some(true));
        assert_eq!(
            store
                .observe_native_host_outcome(
                    &host,
                    &receipt.start.link.decision_key,
                    receipt.start.session_id.clone(),
                    receipt.start.link.logical_run_id.clone(),
                    "completed".into(),
                    Some(receipt.clone())
                )
                .await
                .unwrap()
                .observations
                .len(),
            1
        );
    }
}

#[tokio::test]
async fn owned_terminal_journal_refuses_acknowledgement_policy_and_outcome_mismatches() {
    let dir = tempfile::tempdir().unwrap();
    let (store, host, receipt, _) = native_journal_fixture(dir.path(), "native_text").await;
    for field in ["model", "effort", "fast", "account", "session", "run"] {
        let mut wrong = receipt.clone();
        match field {
            "model" => {
                wrong.finish.as_mut().unwrap().selection.model_id = Some("other-model".into())
            }
            "effort" => wrong.finish.as_mut().unwrap().selection.effort = None,
            "fast" => wrong.finish.as_mut().unwrap().selection.fast = Some(true),
            "account" => wrong.start.account_id = Some("other-account".into()),
            "session" => wrong.start.session_id = "other-session".into(),
            "run" => wrong.start.host_run_id = "other-run".into(),
            _ => unreachable!(),
        }
        assert!(store
            .observe_native_host_outcome(
                &host,
                &receipt.start.link.decision_key,
                receipt.start.session_id.clone(),
                receipt.start.link.logical_run_id.clone(),
                "completed".into(),
                Some(wrong)
            )
            .await
            .is_err());
    }
    assert!(store
        .observe_native_host_outcome(
            &host,
            &receipt.start.link.decision_key,
            receipt.start.session_id.clone(),
            receipt.start.link.logical_run_id.clone(),
            "cancelled".into(),
            Some(receipt.clone())
        )
        .await
        .is_err());
    let id = "journal-native_text";
    let binding = store.task_binding(id).await.unwrap();
    let session = store.task_session(&binding).await.unwrap().unwrap();
    for field in ["policy", "runtime", "billing"] {
        let mut changed = session.clone();
        match field {
            "policy" => changed.owned.policy_hash = "other-native-policy".into(),
            "runtime" => changed.observed.inventory_revision = Some("other-runtime".into()),
            "billing" => changed.observed.billing_mode = "unknown".into(),
            _ => unreachable!(),
        }
        sqlx::query(
            "UPDATE task_owned_sessions SET session_json=?,session_hash=? WHERE binding_id=?",
        )
        .bind(serde_json::to_string(&changed).unwrap())
        .bind(hash(&changed).unwrap())
        .bind(id)
        .execute(&store.pool)
        .await
        .unwrap();
        assert!(store
            .observe_native_host_outcome(
                &host,
                &receipt.start.link.decision_key,
                receipt.start.session_id.clone(),
                receipt.start.link.logical_run_id.clone(),
                "completed".into(),
                Some(receipt.clone())
            )
            .await
            .is_err());
    }
    sqlx::query("UPDATE task_owned_sessions SET session_hash='corrupted'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(store
        .observe_native_host_outcome(
            &host,
            &receipt.start.link.decision_key,
            receipt.start.session_id.clone(),
            receipt.start.link.logical_run_id.clone(),
            "completed".into(),
            Some(receipt.clone())
        )
        .await
        .is_err());
    assert!(store
        .executor_decision(&receipt.start.link.decision_key)
        .await
        .unwrap()
        .unwrap()
        .observations
        .is_empty());
}

#[test]
fn application_ids_resolve_to_native_keys_and_invalid_references_are_rejected() {
    let canonical = request();
    let mut input = ApplicationRequest {
        request_key: canonical.request_key.clone(),
        surface: canonical.surface.clone(),
        context_id: canonical.context_id.clone(),
        task: canonical.prediction.task.clone(),
        target_family: canonical.prediction.target_family.clone(),
        target_group: canonical.prediction.target_group.clone(),
        candidates: canonical.prediction.candidates.clone(),
        prior_ids: canonical
            .prediction
            .candidates
            .iter()
            .rev()
            .map(|row| row.configuration.id.clone())
            .collect(),
        hard_candidate_id: None,
        model_id: None,
        min_quality: canonical.prediction.min_quality,
    };
    let converted = Request::try_from(input.clone()).unwrap();
    assert_eq!(hash(&converted).unwrap(), hash(&canonical).unwrap());
    input.hard_candidate_id = Some(input.candidates[0].configuration.id.clone());
    assert_eq!(
        Request::try_from(input.clone())
            .unwrap()
            .prediction
            .hard_candidate_key,
        Some(routing::candidate_key(&input.candidates[0].configuration))
    );
    input.hard_candidate_id = Some("missing".into());
    assert_eq!(
        Request::try_from(input.clone()).unwrap_err().code,
        "validation"
    );
    input.hard_candidate_id = None;
    input.candidates[1].configuration.id = input.candidates[0].configuration.id.clone();
    assert_eq!(Request::try_from(input).unwrap_err().code, "validation");
}

#[tokio::test]
async fn unknown_reported_executor_stays_unknown_even_when_execution_completes() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let decision = store.prepare_executor_decision(request()).await.unwrap();
    let mut observation = started(&decision);
    observation.configuration = None;
    assert_eq!(
        store
            .observe_executor(&decision.request.request_key, observation.clone())
            .await
            .unwrap_err()
            .code,
        "validation"
    );
    observation.reason = Some("Provider configuration not reported".into());
    store
        .observe_executor(&decision.request.request_key, observation.clone())
        .await
        .unwrap();
    observation.phase = "terminal".into();
    observation.outcome = Some("completed".into());
    let record = store
        .observe_executor(&decision.request.request_key, observation)
        .await
        .unwrap();
    assert!(record
        .observations
        .iter()
        .all(|row| row.matches_selected.is_none() && row.observation.configuration.is_none()));
}

#[tokio::test]
async fn both_surfaces_share_the_policy_and_research_never_overrides_the_prior() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let fit = fitted(&store).await;
    for surface in ["chat", "wave"] {
        let mut input = request();
        input.surface = surface.into();
        input.model_id = Some(fit.model.id.clone());
        let result = store.preview_executor_decision(input).await.unwrap();
        assert_eq!(result.chosen.as_ref().unwrap().model_id, "painter");
        assert_eq!(
            result.research_prediction.unwrap().chosen.unwrap().model_id,
            "parser"
        );
        assert_eq!(result.learned_status, "promotion_required");
        assert!(!result.learned_dispatch_allowed);
    }
    assert!(store
        .executor_decision("example-wave:step-0")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn ordinary_sends_record_why_learned_selection_does_not_apply() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    for surface in ["chat", "wave"] {
        let mut input = request();
        input.surface = surface.into();
        input.request_key = format!("ordinary-{surface}");
        let preview = store
            .preview_executor_decision(input.clone())
            .await
            .unwrap();
        assert_eq!(preview.learned_status, ORDINARY_CONTEXT_UNCOVERED);
        let decision = store.prepare_executor_decision(input).await.unwrap();
        assert_eq!(decision.learned_status, ORDINARY_CONTEXT_UNCOVERED);
        assert_eq!(decision.source, "prior");
        assert!(!decision.learned_dispatch_allowed);
        // The persisted record carries the same status and verifies.
        let saved = store
            .executor_decision(&format!("ordinary-{surface}"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.decision.learned_status, ORDINARY_CONTEXT_UNCOVERED);
    }
}

#[tokio::test]
async fn explicit_pins_and_unavailability_do_not_silently_substitute() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let mut input = request();
    input.prediction.hard_candidate_key = Some(routing::candidate_key(
        &input.prediction.candidates[0].configuration,
    ));
    let pinned = store
        .preview_executor_decision(input.clone())
        .await
        .unwrap();
    assert_eq!(pinned.chosen.unwrap().model_id, "parser");
    assert_eq!(pinned.source, "pin");
    input.prediction.candidates[0].available = false;
    let refused = store
        .preview_executor_decision(input.clone())
        .await
        .unwrap();
    assert!(refused.chosen.is_none());
    assert_eq!(refused.reason, "pinned_candidate_unavailable");
    input.prediction.hard_candidate_key = None;
    input.prediction.candidates[1].available = false;
    assert!(store
        .preview_executor_decision(input)
        .await
        .unwrap()
        .chosen
        .is_none());
}

#[tokio::test]
async fn incomplete_fit_availability_uses_declared_prior_and_does_not_load_labels() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let mut input = request();
    input.model_id = Some("missing-model".into());
    let missing = store
        .preview_executor_decision(input.clone())
        .await
        .unwrap();
    assert_eq!(missing.learned_status, "model_unavailable");
    assert_eq!(missing.chosen.unwrap().model_id, "painter");
    let artifact = fitted(&store).await;
    input.model_id = Some(artifact.model.id.clone());
    sqlx::query("UPDATE selector_fits SET snapshot_json='{}' WHERE id=?")
        .bind(&artifact.model.id)
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(store.selector_fit(&artifact.model.id).await.is_err());
    assert!(store
        .preview_executor_decision(input)
        .await
        .unwrap()
        .research_prediction
        .is_some());
}

#[tokio::test]
async fn decisions_survive_restart_are_idempotent_and_reject_changed_inputs() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let input = request();
    let (a, b) = tokio::join!(
        store.prepare_executor_decision(input.clone()),
        store.prepare_executor_decision(input.clone())
    );
    let original = a.unwrap();
    assert_eq!(original.artifact_hash, b.unwrap().artifact_hash);
    store.pool.close().await;
    let reopened = Store::open(directory.path()).await.unwrap();
    assert_eq!(
        reopened
            .prepare_executor_decision(input.clone())
            .await
            .unwrap()
            .artifact_hash,
        original.artifact_hash
    );
    let mut changed = input;
    changed.prediction.task.prompt += " changed";
    assert_eq!(
        reopened
            .prepare_executor_decision(changed)
            .await
            .unwrap_err()
            .code,
        "decision_conflict"
    );
    sqlx::query("UPDATE executor_decisions SET input_hash='changed'")
        .execute(&reopened.pool)
        .await
        .unwrap();
    assert_eq!(
        reopened
            .executor_decision(&original.request.request_key)
            .await
            .unwrap_err()
            .code,
        "invalid_decision"
    );
}

#[tokio::test]
async fn observed_execution_is_immutable_and_mismatch_is_retained() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let decision = store.prepare_executor_decision(request()).await.unwrap();
    let key = &decision.request.request_key;
    let mut start = started(&decision);
    start.configuration = Some(
        decision.request.prediction.candidates[0]
            .configuration
            .clone(),
    );
    let result = store.observe_executor(key, start.clone()).await.unwrap();
    assert_eq!(result.observations[0].matches_selected, Some(false));
    assert_eq!(
        store
            .observe_executor(key, start.clone())
            .await
            .unwrap()
            .observations
            .len(),
        1
    );
    let mut finish = start.clone();
    finish.phase = "terminal".into();
    finish.outcome = Some("completed".into());
    let result = store.observe_executor(key, finish.clone()).await.unwrap();
    assert_eq!(result.observations.len(), 2);
    finish.outcome = Some("failed".into());
    assert_eq!(
        store.observe_executor(key, finish).await.unwrap_err().code,
        "observation_conflict"
    );
    let mut substituted = start;
    substituted.session_id = Some("another-session".into());
    assert_eq!(
        store
            .observe_executor(key, substituted)
            .await
            .unwrap_err()
            .code,
        "observation_conflict"
    );
}

#[tokio::test]
async fn changed_runtime_is_an_observed_mismatch_even_for_the_same_model() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let decision = store.prepare_executor_decision(request()).await.unwrap();
    let mut observation = started(&decision);
    observation
        .configuration
        .as_mut()
        .unwrap()
        .inventory_revision = Some("different-runtime".into());
    let record = store
        .observe_executor(&decision.request.request_key, observation)
        .await
        .unwrap();
    assert_eq!(record.observations[0].matches_selected, Some(false));
}

#[tokio::test]
async fn concurrent_start_and_cancel_cannot_record_a_start_after_a_prestart_cancel() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let decision = store.prepare_executor_decision(request()).await.unwrap();
    let cancelled = Observation {
        phase: "terminal".into(),
        session_id: None,
        run_id: None,
        configuration: None,
        outcome: Some("cancelled".into()),
        reason: None,
    };
    let (start, cancel) = tokio::join!(
        store.observe_executor(&decision.request.request_key, started(&decision)),
        store.observe_executor(&decision.request.request_key, cancelled),
    );
    assert_ne!(start.is_ok(), cancel.is_ok());
    let record = store
        .executor_decision(&decision.request.request_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.observations.len(), 1);
}

#[tokio::test]
async fn cancellation_before_start_refuses_late_execution_and_success_needs_observation() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let decision = store.prepare_executor_decision(request()).await.unwrap();
    let key = &decision.request.request_key;
    let mut closed = Observation {
        phase: "terminal".into(),
        session_id: None,
        run_id: None,
        configuration: None,
        outcome: Some("completed".into()),
        reason: None,
    };
    assert_eq!(
        store
            .observe_executor(key, closed.clone())
            .await
            .unwrap_err()
            .code,
        "validation"
    );
    closed.outcome = Some("cancelled".into());
    store.observe_executor(key, closed).await.unwrap();
    assert_eq!(
        store
            .observe_executor(key, started(&decision))
            .await
            .unwrap_err()
            .code,
        "decision_terminal"
    );
}

#[tokio::test]
async fn observation_tampering_and_hidden_input_fields_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).await.unwrap();
    let input = request();
    let mut wire = serde_json::to_value(&input).unwrap();
    wire["prediction"]["task"]["evaluator"] = serde_json::json!({"expected":"invented-answer"});
    assert!(serde_json::from_value::<Request>(wire).is_err());
    let mut invalid = input.clone();
    invalid.prior_keys.push("not-a-candidate".into());
    assert_eq!(
        store
            .prepare_executor_decision(invalid)
            .await
            .unwrap_err()
            .code,
        "validation"
    );
    let decision = store.prepare_executor_decision(input).await.unwrap();
    store
        .observe_executor(&decision.request.request_key, started(&decision))
        .await
        .unwrap();
    sqlx::query("UPDATE executor_observations SET artifact_hash='changed'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert_eq!(
        store
            .executor_decision(&decision.request.request_key)
            .await
            .unwrap_err()
            .code,
        "invalid_decision"
    );
}

#[tokio::test]
async fn host_receipt_reconciles_the_actual_executor_across_store_restart() {
    use crate::services::agent_host::{
        executor_receipts::{ExecutorLink, ReceiptFinish, ReceiptStart, ReportedSelection},
        store::SessionStore,
    };
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("bench")).await.unwrap();
    let decision = store.prepare_executor_decision(request()).await.unwrap();
    let key = &decision.request.request_key;
    let host_path = dir.path().join("host.sqlite");
    let host = SessionStore::open(&host_path).await.unwrap();
    let start = ReceiptStart {
        link: ExecutorLink {
            decision_key: key.clone(),
            logical_run_id: "example-run".into(),
        },
        session_id: "example-session".into(),
        host_run_id: "separate-native-run".into(),
        message_id: "message".into(),
        bridge_generation: 4,
        provider_id: "actual-provider".into(),
        account_id: Some("actual-account".into()),
        started_at: "2026-01-01T00:00:00Z".into(),
        selection: ReportedSelection::default(),
    };
    host.claim_executor_receipt(&start).await.unwrap();
    // The renderer can recover the native claim before recording 'started'.
    let recovered = store
        .executor_decision(key)
        .await
        .unwrap()
        .unwrap()
        .with_host_execution(host.executor_receipt(key).await.unwrap())
        .unwrap();
    assert!(recovered.observations.is_empty());
    assert!(recovered.host_execution.unwrap().finish.is_none());
    let finish = ReceiptFinish {
        finished_at: "2026-01-01T00:00:01Z".into(),
        status: "completed".into(),
        selection: ReportedSelection {
            model_id: Some("actual-model".into()),
            effort: Some("high".into()),
            ..Default::default()
        },
        changes: vec![ReportedSelection::default()],
        changes_truncated: false,
    };
    host.finish_executor_receipt(&start, &finish).await.unwrap();
    drop(host);
    let host = SessionStore::open(&host_path).await.unwrap();
    let record = store
        .observe_native_host_outcome(
            &host,
            key,
            start.session_id.clone(),
            start.link.logical_run_id.clone(),
            "completed".into(),
            host.executor_receipt(key).await.unwrap(),
        )
        .await
        .unwrap();
    let observed = &record.observations[0];
    let actual = observed.observation.configuration.as_ref().unwrap();
    assert_eq!(actual.model_id, "actual-model");
    assert_eq!(actual.provider_id, "actual-provider");
    assert_eq!(actual.account_id.as_deref(), Some("actual-account"));
    assert_eq!(actual.effort.as_deref(), Some("high"));
    assert_eq!(actual.fast_mode, None);
    assert_eq!(actual.inventory_revision, None);
    assert_eq!(actual.execution_profile, "interactive_acp");
    assert_eq!(actual.billing_mode, "unknown");
    assert_eq!(observed.matches_selected, Some(false));
    assert_eq!(
        record.host_execution.unwrap().start.host_run_id,
        "separate-native-run"
    );
    assert_eq!(observed.observation.run_id.as_deref(), Some("example-run"));
    assert_eq!(
        store
            .observe_host_outcome(
                key,
                start.session_id.clone(),
                start.link.logical_run_id.clone(),
                "completed".into(),
                host.executor_receipt(key).await.unwrap()
            )
            .await
            .unwrap()
            .observations
            .len(),
        1
    );
    assert_eq!(
        store
            .observe_host_outcome(
                key,
                "unrelated-session".into(),
                "example-run".into(),
                "completed".into(),
                host.executor_receipt(key).await.unwrap()
            )
            .await
            .unwrap_err()
            .code,
        "observation_conflict"
    );
    let mut wrong = host.executor_receipt(key).await.unwrap().unwrap();
    wrong.start.link.logical_run_id = "other-run".into();
    assert_eq!(
        store
            .executor_decision(key)
            .await
            .unwrap()
            .unwrap()
            .with_host_execution(Some(wrong))
            .unwrap_err()
            .code,
        "observation_conflict"
    );
}

#[tokio::test]
async fn absent_host_evidence_and_partial_configuration_never_confirm_selected_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).await.unwrap();
    let decision = store.prepare_executor_decision(request()).await.unwrap();
    let key = &decision.request.request_key;
    let mut observation = started(&decision);
    observation.configuration.as_mut().unwrap().fast_mode = None;
    assert_eq!(
        store
            .observe_executor(key, observation)
            .await
            .unwrap()
            .observations[0]
            .matches_selected,
        None
    );
    let record = store
        .observe_host_outcome(
            key,
            "example-session".into(),
            "example-run".into(),
            "failed".into(),
            None,
        )
        .await
        .unwrap();
    let terminal = &record.observations[1];
    assert!(terminal.observation.configuration.is_none());
    assert!(terminal.matches_selected.is_none());
    assert!(record.host_execution.is_none());
}
