//! Invented offline adapter plumbing; no provider or empirical quality claim.
use super::*;
use crate::services::agent_host::execution::{ObservedSelection, OwnedSession};
use crate::services::benchmarks::runner::ExecutionBackend;
use futures_util::future::BoxFuture;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::watch;

#[derive(Default)]
struct NativeFixture {
    unavailable: AtomicBool,
    changed_runtime: AtomicBool,
    starts: AtomicUsize,
    /// Setup reports the native root deadline as exhausted.
    setup_expires: AtomicBool,
    /// How long that failing setup takes before it reports.
    setup_delay_ms: std::sync::atomic::AtomicU64,
    /// The host cannot prove that no provider prompt started.
    provider_start_unproven: AtomicBool,
    prepares: AtomicUsize,
    refusals: AtomicUsize,
}
impl ExecutionBackend for NativeFixture {
    fn unsupported(&self, _: &Configuration, _: &BenchmarkDraft) -> Option<String> {
        None
    }
    fn accounts<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async { Ok(vec!["invented-account".into()]) })
    }
    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        _: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(async move {
            Ok(vec![InventoryModel {
                name: "Invented worker".into(),
                configuration: Configuration {
                    id: "native-row".into(),
                    provider_id: provider.into(),
                    account_id: account.map(str::to_owned),
                    model_id: "invented-model".into(),
                    model_name: None,
                    effort: None,
                    fast_mode: None,
                    billing_mode: "simulated".into(),
                    execution_profile: "native_text".into(),
                    inventory_revision: Some(
                        if self.changed_runtime.load(Ordering::SeqCst) {
                            "changed"
                        } else {
                            "invented-runtime-v1"
                        }
                        .into(),
                    ),
                },
                available: !self.unavailable.load(Ordering::SeqCst),
                reason: None,
                efforts: vec!["high".into(), "medium".into()],
                supports_fast_mode: false,
            }])
        })
    }
    fn execute<'a>(
        &'a self,
        _: &'a Store,
        _: Attempt,
        _: BenchmarkVersion,
        _: u32,
        _: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async { panic!("This fixture must never collect provider evidence") })
    }
    fn prepare_owned_task<'a>(
        &'a self,
        _: &'a Store,
        binding: &'a Binding,
        chosen: &'a Configuration,
    ) -> BoxFuture<'a, Result<Session>> {
        Box::pin(async move {
            self.prepares.fetch_add(1, Ordering::SeqCst);
            if self.setup_expires.load(Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(
                    self.setup_delay_ms.load(Ordering::SeqCst),
                ))
                .await;
                return Err(BenchmarkError::new(
                    "budget_timeout",
                    "Invented setup exhausted the native root deadline",
                ));
            }
            Ok(Session {
                owned: OwnedSession {
                    session_id: format!("invented:{}", binding.id),
                    owner_id: format!("task:{}", binding.id),
                    policy_hash: "invented-policy".into(),
                    substitutions: vec![],
                    selection: ObservedSelection {
                        model_id: Some(chosen.model_id.clone()),
                        reasoning_effort: chosen.effort.clone(),
                        fast_mode: chosen.fast_mode,
                    },
                },
                observed: chosen.clone(),
                context_hash: binding.context_hash.clone(),
            })
        })
    }
    fn dispatch_owned_task<'a>(
        &'a self,
        _: &'a Store,
        binding: &'a Binding,
        session: &'a Session,
        _: tokio::sync::OwnedMutexGuard<()>,
    ) -> BoxFuture<'a, Result<ExecutionDispatch>> {
        Box::pin(async move {
            self.starts.fetch_add(1, Ordering::SeqCst);
            Ok(ExecutionDispatch {
                request_key: binding.request.request_key.clone(),
                session_id: session.owned.session_id.clone(),
                run_id: "invented-run".into(),
                user_message_id: "invented-user".into(),
                phase: "reserved".into(),
                event_cursor: 0,
                result: None,
                error: None,
            })
        })
    }
    fn owned_task_status<'a>(
        &'a self,
        _: &'a Binding,
        _: &'a Session,
    ) -> BoxFuture<'a, Result<Option<ExecutionDispatch>>> {
        Box::pin(async { Ok(None) })
    }
    fn owned_task_output<'a>(
        &'a self,
        binding: &'a Binding,
        _: &'a Session,
    ) -> BoxFuture<'a, Result<NativeOutput>> {
        Box::pin(async move {
            Ok(NativeOutput {
                text: format!("Invented committed report of {}", binding.id),
                elapsed_ms: 1,
                repository_result: None,
            })
        })
    }
    fn recover_owned_task_preparation<'a>(
        &'a self,
        _: &'a Binding,
    ) -> BoxFuture<'a, Result<NativePreparationLookup>> {
        Box::pin(async move {
            Ok(NativePreparationLookup {
                session_id: None,
                no_provider_start: !self.provider_start_unproven.load(Ordering::SeqCst),
            })
        })
    }
    fn refuse_owned_task_dispatch<'a>(
        &'a self,
        binding: &'a Binding,
        session: &'a Session,
    ) -> BoxFuture<'a, Result<ExecutionDispatch>> {
        Box::pin(async move {
            self.refusals.fetch_add(1, Ordering::SeqCst);
            Ok(ExecutionDispatch {
                request_key: binding.request.request_key.clone(),
                session_id: session.owned.session_id.clone(),
                run_id: "invented-refusal-run".into(),
                user_message_id: "invented-refusal-user".into(),
                phase: "terminal".into(),
                event_cursor: 0,
                result: None,
                error: Some(serde_json::json!({"kind": "budget_timeout"})),
            })
        })
    }
}
async fn fixture() -> (
    tempfile::TempDir,
    BenchmarkService,
    Arc<NativeFixture>,
    ModeV2,
    RequestV2,
) {
    let dir = tempfile::tempdir().unwrap();
    let roles = dir.path().join("agents");
    std::fs::create_dir_all(&roles).unwrap();
    let path = roles.join("invented-role.md");
    std::fs::write(
        &path,
        "---\ndisplay_name: Invented role\n---\nRepair the supplied text.\n",
    )
    .unwrap();
    let backend = Arc::new(NativeFixture::default());
    let service = BenchmarkService {
        store: Store::open(dir.path()).await.unwrap(),
        backend: backend.clone(),
        wake: Default::default(),
        active: Default::default(),
        app: None,
    };
    let mut intent = ModeRequestV2 {
        schema_version: 2,
        context_id: "invented-chat".into(),
        surface: "chat".into(),
        execution_profile: "native_text".into(),
        repository: None,
        limits: Limits {
            timeout_seconds: 10,
            max_turns: 1,
            max_artifact_bytes: 4096,
        },
        roles: vec![RoleIntent {
            source_path: path.to_string_lossy().into_owned(),
            work_class_id: "debug".into(),
        }],
        provider_ids: vec!["claude-acp".into()],
        acknowledged_contract_hash: String::new(),
    };
    intent.acknowledged_contract_hash = service
        .inspect_owned_task_mode(&intent)
        .await
        .unwrap()
        .artifact_hash;
    let Some(ModeEnvelope::V2(mode)) = service
        .set_owned_task_mode_intent(ModeIntent::V2(intent))
        .await
        .unwrap()
    else {
        panic!("mode")
    };
    let request = RequestV2 {
        schema_version: 2,
        request_key: "invented-accepted-message".into(),
        surface: "chat".into(),
        context_id: mode.request.context_id.clone(),
        mode: ModeReference {
            context_id: mode.request.context_id.clone(),
            artifact_hash: mode.artifact_hash.clone(),
        },
        role_source_id: mode.consent.roles[0].source_id.clone(),
        work_class_id: "debug".into(),
        prompt: "Repair this example.".into(),
        hard_candidate_key: None,
        entry: None,
        step_budget_seconds: 10,
        planned_trajectory: None,
    };
    (dir, service, backend, mode, request)
}

#[tokio::test]
async fn no_fit_or_certificate_still_prepares_and_dispatches_native_prior() {
    let (_dir, service, backend, _, request) = fixture().await;
    let prepared = service
        .prepare_owned_task_intent(PrepareIntent::V2(request.clone()))
        .await
        .unwrap();
    assert_eq!(prepared.binding.decision.source, "prior");
    assert_eq!(
        prepared.binding.decision.reason,
        "native_prior_fallback:no_exact_active_policy"
    );
    assert!(!prepared.binding.decision.learned_dispatch_allowed);
    assert!(prepared.binding.request.promotion_id.is_empty());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM selector_fits")
        .fetch_one(&service.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(prepared.session.observed.effort.as_deref(), Some("high"));
    assert_eq!(prepared.session.observed.fast_mode, Some(false));
    let retry = service
        .prepare_owned_task_intent(PrepareIntent::V2(request.clone()))
        .await
        .unwrap();
    assert_eq!(retry.binding.artifact_hash, prepared.binding.artifact_hash);
    let mut changed = request;
    changed.prompt.push_str(" changed");
    assert!(service
        .prepare_owned_task_intent(PrepareIntent::V2(changed))
        .await
        .is_err());
    service
        .dispatch_owned_task(&prepared.binding.id)
        .await
        .unwrap();
    assert_eq!(backend.starts.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn native_pin_without_fit_and_changed_role_or_runtime_refuse_before_dispatch() {
    let (_dir, service, backend, mode, mut request) = fixture().await;
    let choices = service
        .owned_task_choices_v2(&mode.request.context_id)
        .await
        .unwrap();
    request.hard_candidate_key = Some(choices[0].candidate_key.clone());
    let prepared = service
        .prepare_owned_task_intent(PrepareIntent::V2(request.clone()))
        .await
        .unwrap();
    assert_eq!(prepared.binding.decision.source, "pin");
    backend.changed_runtime.store(true, Ordering::SeqCst);
    assert!(service
        .dispatch_owned_task(&prepared.binding.id)
        .await
        .is_err());
    backend.changed_runtime.store(false, Ordering::SeqCst);
    std::fs::write(
        &mode.consent.roles[0].source_path,
        "---\ndisplay_name: Invented role\n---\nChanged native body.",
    )
    .unwrap();
    assert!(service
        .dispatch_owned_task(&prepared.binding.id)
        .await
        .is_err());
    assert_eq!(backend.starts.load(Ordering::SeqCst), 0);
    assert_eq!(
        service
            .store
            .task_binding(&prepared.binding.id)
            .await
            .unwrap()
            .artifact_hash,
        prepared.binding.artifact_hash
    );
}
#[tokio::test]
async fn forged_role_class_profile_and_controls_do_not_acquire_native_authority() {
    let (_dir, service, _, mode, request) = fixture().await;
    for field in [
        "rolePrompt",
        "permissions",
        "promotionId",
        "runtime",
        "candidates",
    ] {
        let mut forged = serde_json::to_value(&request).unwrap();
        forged[field] = serde_json::json!("forged");
        assert!(
            serde_json::from_value::<PrepareIntent>(forged).is_err(),
            "{field}"
        );
    }
    let mut changed = request.clone();
    changed.work_class_id = "security".into();
    assert!(service
        .prepare_owned_task_intent(PrepareIntent::V2(changed))
        .await
        .is_err());
    let mut changed = request;
    changed.hard_candidate_key = Some("unadvertised-effort-key".into());
    assert!(service
        .prepare_owned_task_intent(PrepareIntent::V2(changed))
        .await
        .is_err());
    let mut changed = mode.request;
    changed.execution_profile = "interactive_acp".into();
    assert!(service.inspect_owned_task_mode(&changed).await.is_err());
}

#[tokio::test]
async fn native_v2_role_preference_precedes_default_and_unknown_mapping_keeps_prior_usable() {
    let (_dir, service, backend, mode, mut request) = fixture().await;
    let source = &mode.consent.roles[0].source_path;
    std::fs::write(source, "---\ndisplay_name: Invented role\nmodel: claude-acp:invented-model[medium]\nfast_mode: false\n---\nRepair the supplied text.").unwrap();
    let mut mode_request = mode.request.clone();
    mode_request.acknowledged_contract_hash = service
        .inspect_owned_task_mode(&mode_request)
        .await
        .unwrap()
        .artifact_hash;
    let Some(ModeEnvelope::V2(mode)) = service
        .set_owned_task_mode_intent(ModeIntent::V2(mode_request))
        .await
        .unwrap()
    else {
        panic!("mode")
    };
    request.mode.artifact_hash = mode.artifact_hash.clone();
    let prepared = service
        .prepare_owned_task_intent(PrepareIntent::V2(request.clone()))
        .await
        .unwrap();
    assert_eq!(prepared.session.observed.effort.as_deref(), Some("medium"));
    assert_eq!(
        prepared.binding.context_v2.as_ref().unwrap().prior_reason,
        "native_role_model_preference"
    );
    service
        .dispatch_owned_task(&prepared.binding.id)
        .await
        .unwrap();

    std::fs::write(
        source,
        "---\ndisplay_name: Invented role\nmodel_ranking: debug\n---\nRepair the supplied text.",
    )
    .unwrap();
    let mut mode_request = mode.request;
    let inspected = service
        .inspect_owned_task_mode(&mode_request)
        .await
        .unwrap();
    assert!(!inspected.complete);
    assert!(!inspected.unknown_reasons.is_empty());
    mode_request.acknowledged_contract_hash = inspected.artifact_hash;
    let Some(ModeEnvelope::V2(mode)) = service
        .set_owned_task_mode_intent(ModeIntent::V2(mode_request))
        .await
        .unwrap()
    else {
        panic!("mode")
    };
    request.request_key = "unknown-ranking-prior".into();
    request.mode.artifact_hash = mode.artifact_hash;
    let prepared = service
        .prepare_owned_task_intent(PrepareIntent::V2(request))
        .await
        .unwrap();
    assert_eq!(prepared.binding.decision.source, "prior");
    assert!(!prepared.binding.context_v2.as_ref().unwrap().complete);
    assert_eq!(
        prepared.binding.decision.learned_status,
        "incomplete_native_role_preferences"
    );
    assert!(!prepared.binding.decision.learned_dispatch_allowed);
    service
        .dispatch_owned_task(&prepared.binding.id)
        .await
        .unwrap();
    assert_eq!(backend.starts.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn native_v2_definite_refusal_requires_absence_and_lost_commits_recover_exact_bytes() {
    let (_dir, service, backend, mode, request) = fixture().await;
    let mut unsaved = mode.request.clone();
    unsaved.context_id = "another-native-context".into();
    unsaved.acknowledged_contract_hash = service
        .inspect_owned_task_mode(&unsaved)
        .await
        .unwrap()
        .artifact_hash;
    std::fs::write(
        &mode.consent.roles[0].source_path,
        "---\ndisplay_name: Invented role\n---\nChanged after inspection.",
    )
    .unwrap();
    let error = service
        .set_owned_task_mode_intent(ModeIntent::V2(unsaved.clone()))
        .await
        .unwrap_err();
    assert_eq!(error.code, "owned_task_intent_refused");
    assert!(service
        .store
        .owned_task_mode_envelope(&unsaved.context_id)
        .await
        .unwrap()
        .is_none());
    let Some(ModeEnvelope::V2(recovered)) = service
        .set_owned_task_mode_intent(ModeIntent::V2(mode.request.clone()))
        .await
        .unwrap()
    else {
        panic!("mode")
    };
    assert_eq!(
        serde_json::to_vec(&recovered).unwrap(),
        serde_json::to_vec(&mode).unwrap()
    );
    let error = service
        .prepare_owned_task_intent(PrepareIntent::V2(request.clone()))
        .await
        .unwrap_err();
    assert_eq!(error.code, "owned_task_intent_refused");
    assert_eq!(backend.starts.load(Ordering::SeqCst), 0);
    let key = format!(
        "owned-task:{}",
        fixtures::hash(request.request_key.as_bytes())
    );
    assert!(service
        .store
        .executor_decision(&key)
        .await
        .unwrap()
        .is_none());

    std::fs::write(
        &mode.consent.roles[0].source_path,
        "---\ndisplay_name: Invented role\n---\nRepair the supplied text.\n",
    )
    .unwrap();
    let prepared = service
        .prepare_owned_task_intent(PrepareIntent::V2(request.clone()))
        .await
        .unwrap();
    std::fs::write(
        &mode.consent.roles[0].source_path,
        "---\ndisplay_name: Invented role\n---\nChanged after committed prepare.",
    )
    .unwrap();
    let recovered = service
        .prepare_owned_task_intent(PrepareIntent::V2(request))
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_vec(&recovered).unwrap(),
        serde_json::to_vec(&prepared).unwrap()
    );
    assert_ne!(
        service
            .dispatch_owned_task(&prepared.binding.id)
            .await
            .unwrap_err()
            .code,
        "owned_task_intent_refused"
    );
    assert_eq!(backend.starts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn expired_setup_records_a_native_refusal_only_with_provider_start_absence() {
    let (_dir, service, backend, _, mut request) = fixture().await;
    let refusals = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM task_budget_bindings WHERE refusal_json IS NOT NULL",
        )
        .fetch_one(&service.store.pool)
        .await
        .unwrap()
    };
    // Setup outlives a one-second root budget.
    request.step_budget_seconds = 1;
    backend.setup_delay_ms.store(1_100, Ordering::SeqCst);
    backend.setup_expires.store(true, Ordering::SeqCst);
    let error = service
        .prepare_owned_task_intent(PrepareIntent::V2(request.clone()))
        .await
        .unwrap_err();
    assert_eq!(error.code, "owned_task_preparation_refused");
    let details = error.details.expect("native refusal record");
    assert_eq!(details["outcome"], "budget_timeout");
    assert_eq!(details["proof"], "native-owned-no-provider-start-v1");
    // The durable refusal answers every retry of the same frozen request; no
    // second setup or provider dispatch is attempted under that identity.
    backend.setup_expires.store(false, Ordering::SeqCst);
    let retry = service
        .prepare_owned_task_intent(PrepareIntent::V2(request.clone()))
        .await
        .unwrap_err();
    assert_eq!(retry.code, "owned_task_preparation_refused");
    assert_eq!(retry.details.unwrap(), details);
    assert_eq!(backend.prepares.load(Ordering::SeqCst), 1);
    assert_eq!(backend.starts.load(Ordering::SeqCst), 0);

    // Without native absence proof the outcome stays unknown and nothing is
    // recorded; once the host proves absence the same key records it.
    let mut unproven = request.clone();
    unproven.request_key = "invented-unproven-setup".into();
    backend.setup_expires.store(true, Ordering::SeqCst);
    backend
        .provider_start_unproven
        .store(true, Ordering::SeqCst);
    let error = service
        .prepare_owned_task_intent(PrepareIntent::V2(unproven.clone()))
        .await
        .unwrap_err();
    assert_eq!(error.code, "dispatch_uncertain");
    assert_eq!(refusals().await, 1);
    backend
        .provider_start_unproven
        .store(false, Ordering::SeqCst);
    let proven = service
        .prepare_owned_task_intent(PrepareIntent::V2(unproven))
        .await
        .unwrap_err();
    assert_eq!(proven.code, "owned_task_preparation_refused");
    assert_eq!(refusals().await, 2);

    // A helper that stops at its own limit while the root budget remains is
    // not budget exhaustion: nothing is recorded and the same key recovers.
    let mut early = request;
    early.request_key = "invented-early-helper-stop".into();
    early.step_budget_seconds = 10;
    backend.setup_delay_ms.store(0, Ordering::SeqCst);
    let error = service
        .prepare_owned_task_intent(PrepareIntent::V2(early.clone()))
        .await
        .unwrap_err();
    assert_eq!(error.code, "dispatch_uncertain");
    assert_eq!(refusals().await, 2);
    backend.setup_expires.store(false, Ordering::SeqCst);
    let recovered = service
        .prepare_owned_task_intent(PrepareIntent::V2(early))
        .await
        .unwrap();
    assert_eq!(recovered.binding.decision.source, "prior");
    assert_eq!(backend.starts.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn an_expired_prepared_task_records_the_no_prompt_outcome_instead_of_dispatching() {
    let (_dir, service, backend, _, mut request) = fixture().await;
    request.step_budget_seconds = 1;
    let prepared = service
        .prepare_owned_task_intent(PrepareIntent::V2(request))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    let dispatch = service
        .dispatch_owned_task(&prepared.binding.id)
        .await
        .unwrap();
    assert_eq!(dispatch.phase, "terminal");
    assert_eq!(dispatch.error.unwrap()["kind"], "budget_timeout");
    assert_eq!(backend.refusals.load(Ordering::SeqCst), 1);
    assert_eq!(backend.starts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_descendant_of_an_expired_root_is_a_definite_pre_write_refusal() {
    let (_dir, service, backend, chat_mode, _) = fixture().await;
    let mut wave = chat_mode.request.clone();
    wave.context_id = "invented-conductor".into();
    wave.surface = "wave".into();
    // The root wall budget is the consent's cap, shared by every step.
    wave.limits.timeout_seconds = 1;
    wave.acknowledged_contract_hash = service
        .inspect_owned_task_mode(&wave)
        .await
        .unwrap()
        .artifact_hash;
    let Some(ModeEnvelope::V2(mode)) = service
        .set_owned_task_mode_intent(ModeIntent::V2(wave))
        .await
        .unwrap()
    else {
        panic!("mode")
    };
    let step = |key: &str, entry: Option<WaveEntry>| RequestV2 {
        schema_version: 2,
        request_key: key.into(),
        surface: "wave".into(),
        context_id: "invented-conductor:wave:invented".into(),
        mode: ModeReference {
            context_id: mode.request.context_id.clone(),
            artifact_hash: mode.artifact_hash.clone(),
        },
        role_source_id: mode.consent.roles[0].source_id.clone(),
        work_class_id: "debug".into(),
        prompt: "Repair this example.".into(),
        hard_candidate_key: None,
        entry,
        step_budget_seconds: 1,
        planned_trajectory: None,
    };
    let root = service
        .prepare_owned_task_intent(PrepareIntent::V2(step("wave:invented:step:0", None)))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    let error = service
        .prepare_owned_task_intent(PrepareIntent::V2(step(
            "wave:invented:step:1",
            Some(WaveEntry {
                root_binding_id: root.binding.id.clone(),
                previous_binding_ids: vec![root.binding.id.clone()],
                include_previous_output: false,
            }),
        )))
        .await
        .unwrap_err();
    // Nothing was bound or decided, so the request may be explicitly edited.
    assert_eq!(error.code, "owned_task_intent_refused");
    assert_eq!(backend.starts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_revision_continues_the_exact_root_lineage_and_budget() {
    let (_dir, service, _, chat_mode, _) = fixture().await;
    let mut wave = chat_mode.request.clone();
    wave.context_id = "invented-conductor".into();
    wave.surface = "wave".into();
    wave.acknowledged_contract_hash = service
        .inspect_owned_task_mode(&wave)
        .await
        .unwrap()
        .artifact_hash;
    let Some(ModeEnvelope::V2(mode)) = service
        .set_owned_task_mode_intent(ModeIntent::V2(wave))
        .await
        .unwrap()
    else {
        panic!("mode")
    };
    let step = |key: &str, context: &str, entry: Option<(String, Vec<String>)>| RequestV2 {
        schema_version: 2,
        request_key: key.into(),
        surface: "wave".into(),
        context_id: context.into(),
        mode: ModeReference {
            context_id: mode.request.context_id.clone(),
            artifact_hash: mode.artifact_hash.clone(),
        },
        role_source_id: mode.consent.roles[0].source_id.clone(),
        work_class_id: "debug".into(),
        prompt: "Repair this example.".into(),
        hard_candidate_key: None,
        entry: entry.map(|(root, previous)| WaveEntry {
            root_binding_id: root,
            previous_binding_ids: previous,
            include_previous_output: true,
        }),
        step_budget_seconds: 10,
        planned_trajectory: None,
    };
    let context = "invented-conductor:wave:root:invented-request";
    let prepare =
        |request: RequestV2| service.prepare_owned_task_intent(PrepareIntent::V2(request));
    let root = prepare(step("wave:first:step:0", context, None))
        .await
        .unwrap();
    let r = root.binding.id.clone();
    let review = prepare(step(
        "wave:first:step:1",
        context,
        Some((r.clone(), vec![r.clone()])),
    ))
    .await
    .unwrap();
    let v = review.binding.id.clone();
    // The revision wave's first step extends the committed prefix.
    let revision = prepare(step(
        "wave:second:step:0",
        context,
        Some((r.clone(), vec![r.clone(), v.clone()])),
    ))
    .await
    .unwrap();
    let budget = |binding: &Binding| {
        binding
            .context_v2
            .as_ref()
            .unwrap()
            .root_budget
            .clone()
            .unwrap()
    };
    assert_eq!(
        budget(&revision.binding).root_id,
        budget(&root.binding).root_id
    );
    assert_eq!(
        budget(&revision.binding).root_started_at_ms,
        budget(&root.binding).root_started_at_ms
    );
    assert_eq!(
        revision
            .binding
            .task
            .entry
            .as_ref()
            .unwrap()
            .previous_reports
            .len(),
        2
    );
    // Skipping a committed predecessor, or moving the lineage to another
    // context, is not the prefix the host committed.
    let n = revision.binding.id.clone();
    for request in [
        step(
            "wave:second:step:1",
            context,
            Some((r.clone(), vec![r.clone(), n.clone()])),
        ),
        step(
            "wave:second:step:2",
            "invented-conductor:wave:root:another-request",
            Some((r.clone(), vec![r.clone(), v.clone(), n.clone()])),
        ),
    ] {
        assert!(prepare(request).await.is_err());
    }
}

#[tokio::test]
async fn a_mixed_role_lineage_never_borrows_a_single_role_certificate() {
    let (dir, service, _, chat_mode, _) = fixture().await;
    let reviewer = dir.path().join("agents").join("invented-reviewer.md");
    std::fs::write(
        &reviewer,
        "---\ndisplay_name: Invented reviewer\n---\nReview the supplied text.\n",
    )
    .unwrap();
    let mut wave = chat_mode.request.clone();
    wave.context_id = "invented-conductor".into();
    wave.surface = "wave".into();
    wave.roles.push(RoleIntent {
        source_path: reviewer.to_string_lossy().into_owned(),
        work_class_id: "code-review".into(),
    });
    wave.acknowledged_contract_hash = service
        .inspect_owned_task_mode(&wave)
        .await
        .unwrap()
        .artifact_hash;
    let Some(ModeEnvelope::V2(mode)) = service
        .set_owned_task_mode_intent(ModeIntent::V2(wave))
        .await
        .unwrap()
    else {
        panic!("mode")
    };
    let step = |key: &str, role: usize, previous: Vec<String>, pin: Option<String>| RequestV2 {
        schema_version: 2,
        request_key: key.into(),
        surface: "wave".into(),
        context_id: "invented-conductor:wave:root:invented-request".into(),
        mode: ModeReference {
            context_id: mode.request.context_id.clone(),
            artifact_hash: mode.artifact_hash.clone(),
        },
        role_source_id: mode.consent.roles[role].source_id.clone(),
        work_class_id: mode.consent.roles[role].work_class_id.clone(),
        prompt: "Handle this example.".into(),
        hard_candidate_key: pin,
        entry: previous.first().cloned().map(|root| WaveEntry {
            root_binding_id: root,
            previous_binding_ids: previous.clone(),
            include_previous_output: true,
        }),
        step_budget_seconds: 10,
        planned_trajectory: None,
    };
    let prepare =
        |request: RequestV2| service.prepare_owned_task_intent(PrepareIntent::V2(request));
    let root = prepare(step("wave:mixed:step:0", 0, vec![], None))
        .await
        .unwrap();
    let r = root.binding.id.clone();
    let same = prepare(step("wave:mixed:step:1", 0, vec![r.clone()], None))
        .await
        .unwrap();
    assert_eq!(
        same.binding.decision.learned_status,
        "no_exact_active_policy"
    );
    let s = same.binding.id.clone();
    let mixed = prepare(step(
        "wave:mixed:step:2",
        1,
        vec![r.clone(), s.clone()],
        None,
    ))
    .await
    .unwrap();
    assert_eq!(mixed.binding.decision.source, "prior");
    assert_eq!(
        mixed.binding.decision.learned_status,
        "mixed_role_trajectory_uncertified"
    );
    assert!(!mixed.binding.decision.learned_dispatch_allowed);
    // An explicit native pin remains binding in a mixed trajectory.
    let choices = service
        .owned_task_choices_v2(&mode.request.context_id)
        .await
        .unwrap();
    let pinned = prepare(step(
        "wave:mixed:step:3",
        1,
        vec![r, s, mixed.binding.id.clone()],
        Some(choices[0].candidate_key.clone()),
    ))
    .await
    .unwrap();
    assert_eq!(pinned.binding.decision.source, "pin");
}
