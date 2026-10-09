//! Invented, offline plumbing proof. Stub outcomes establish no model quality.
//! Use publication, scheduling and persistence APIs, never prefilled SQL rows.
use super::*;
use crate::services::{
    agent_host::{executor_receipts::*, store::SessionStore},
    benchmarks::{executor, learned, selector::RoleWeights},
};
use std::sync::atomic::{AtomicU64, Ordering};

#[path = "promotion_pipeline_tests.rs"]
mod promotion_pipeline_tests;
#[path = "workflow_campaign_tests.rs"]
mod workflow_campaign_tests;
#[path = "workflow_policy_tests.rs"]
mod workflow_policy_tests;

#[derive(Default)]
struct OfflineWorkers {
    native_v2_inventory: bool,
    native_store: std::sync::OnceLock<Arc<SessionStore>>,
    calls: AtomicU64,
    unavailable: std::sync::Mutex<Vec<String>>,
    cancel_after: AtomicU64,
    refuse_next: std::sync::Mutex<Option<String>>,
    owned_dispatches: std::sync::Mutex<std::collections::BTreeMap<String, ExecutionDispatch>>,
    owned_calls: AtomicU64,
    prepare_calls: AtomicU64,
    changed_runtime: std::sync::atomic::AtomicBool,
    wrong_ack: std::sync::atomic::AtomicBool,
    /// Workers whose usage reports no cost, like a runtime without prices.
    no_cost: std::sync::atomic::AtomicBool,
}

/// The root wall budget of tests on the native clock. It runs on real time,
/// so it must outlast a loaded CI runner; no such test measures expiry.
const WALL_BUDGET_SECONDS: u32 = 600;

/// Puts a published-entry draft on the native wall clock with that budget.
fn on_wall_clock(draft: &mut BenchmarkDraft) {
    draft.environment["nativeBudgetRecipe"] = json!(super::super::artifact_context::CLOCK_RECIPE);
    draft.limits.timeout_seconds = WALL_BUDGET_SECONDS;
    if let Some(entry) = draft.entry_state.as_mut() {
        entry.remaining_budget_seconds = WALL_BUDGET_SECONDS;
    }
}

fn configurations() -> Vec<Configuration> {
    ["parser", "painter"]
        .into_iter()
        .map(|model| Configuration {
            id: model.into(),
            provider_id: "offline-pipeline".into(),
            account_id: None,
            model_id: model.into(),
            effort: Some("high".into()),
            fast_mode: Some(false),
            billing_mode: "simulated".into(),
            execution_profile: "native_text".into(),
            inventory_revision: Some("offline-workers-v1".into()),
            model_name: None,
        })
        .collect()
}

fn native_v2_configurations() -> Vec<Configuration> {
    configurations()
        .into_iter()
        .map(|mut configuration| {
            configuration.provider_id = "claude-acp".into();
            configuration.account_id = Some("invented-owned-account".into());
            configuration.inventory_revision =
                Some(fixtures::hash(b"invented-native-pipeline-runtime-v1"));
            configuration
        })
        .collect()
}

impl OfflineWorkers {
    /// This independent adapter fixture records the host acknowledgement and
    /// exercises the production receipt joins. It proves plumbing, not quality.
    async fn native_fixture_events(&self, attempt: &mut Attempt) -> Result<Value> {
        use crate::services::agent_host::{
            execution::{ExecutionProfile, NativeProvider, OwnedSessionRequest},
            store::SessionRecord,
        };
        let host = self.native_store.get().expect("invented native host");
        let owner_id = turn_owner(attempt);
        let session_id = format!("invented-native-session:{}", attempt.id);
        let owner = OwnedSessionRequest {
            owner_id: owner_id.clone(),
            provider_id: "claude-acp".into(),
            account_id: "invented-owned-account".into(),
            model_id: match attempt.configuration.model_id.as_str() {
                "parser" => "parser",
                "painter" => "painter",
                _ => panic!("unadvertised fixture model"),
            }
            .into(),
            reasoning_effort: Some("high".into()),
            fast_mode: Some(false),
            cwd: "C:/invented-native-owned-workspace".into(),
            title: "Invented receipt fixture".into(),
            profile: ExecutionProfile::NativeTextV1,
        };
        let record = SessionRecord {
            id: session_id.clone(),
            harness: owner.provider_id.clone(),
            account_id: Some(owner.account_id.clone()),
            bridge_session_id: Some(format!("invented-bridge:{}", attempt.id)),
            cwd: owner.cwd.clone(),
            title: Some(owner.title.clone()),
            user_set_name: false,
            project_id: None,
            persona_id: None,
            model_id: Some(owner.model_id.clone()),
            reasoning_effort: owner.reasoning_effort.clone(),
            fast_mode: owner.fast_mode,
            legacy_model_id: None,
            hidden: true,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            last_message_at: None,
            archived_at: None,
            message_count: 0,
            last_snippet: None,
            snapshot: None,
        };
        let error = |message| BenchmarkError::new("invented_native_host", message);
        let policy = NativeProvider::Claude.policy_hash(&owner).map_err(error)?;
        host.insert_owned_session(&record, &owner, &policy)
            .await
            .map_err(error)?;
        let dispatch = ExecutionDispatch {
            request_key: format!("benchmark:{owner_id}"),
            session_id: session_id.clone(),
            run_id: format!("invented-host-run:{}", attempt.id),
            user_message_id: format!("invented-host-user:{}", attempt.id),
            phase: "reserved".into(),
            event_cursor: 0,
            result: None,
            error: None,
        };
        assert!(host
            .reserve_dispatch(&dispatch, "invented-fixture-prompt")
            .await
            .map_err(error)?);
        let selection = crate::services::agent_host::execution::ObservedSelection {
            model_id: record.model_id,
            reasoning_effort: record.reasoning_effort,
            fast_mode: record.fast_mode,
        };
        host.settle_dispatch(
            &dispatch.request_key,
            "terminal",
            Some(&json!({"observedSelection":selection,
            "stopReason":"end_turn", "nativeExecutionMs":8})),
            None,
        )
        .await
        .map_err(error)?;
        let runtime = native_receipt::VerifiedRuntime {
            provider_id: owner.provider_id,
            account_id: owner.account_id,
            model_id: owner.model_id,
            execution_profile: "native_text".into(),
            inventory_revision: fixtures::hash(b"invented-native-pipeline-runtime-v1"),
            repository_revision: None,
        };
        let receipt = native_receipt::attest(
            host,
            &dispatch.request_key,
            &session_id,
            &dispatch.run_id,
            &owner_id,
            &runtime,
        )
        .await?;
        let terminal = host
            .execution_dispatch(&dispatch.request_key)
            .await
            .map_err(error)?
            .unwrap();
        attempt.session_id = Some(session_id);
        attempt.host_run_id = Some(dispatch.run_id);
        Ok(
            json!({"offlineStub":true,"nativeExecutionReceipt":receipt,"turnEvents":[{"terminalDispatch":terminal}]}),
        )
    }
}

impl ExecutionBackend for OfflineWorkers {
    fn accounts<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async { Ok(vec!["invented-owned-account".into()]) })
    }
    fn prepare_owned_task<'a>(
        &'a self,
        _: &'a Store,
        binding: &'a super::super::task_execution::Binding,
        chosen: &'a Configuration,
    ) -> BoxFuture<'a, Result<super::super::task_execution::Session>> {
        Box::pin(async move {
            self.prepare_calls.fetch_add(1, Ordering::SeqCst);
            let mut observed = chosen.clone();
            if self.wrong_ack.load(Ordering::SeqCst) {
                observed.model_id = "unacknowledged".into();
            }
            Ok(super::super::task_execution::Session {
                owned: crate::services::agent_host::execution::OwnedSession {
                    session_id: format!("invented-session:{}", binding.id),
                    owner_id: format!("task:{}", binding.id),
                    policy_hash: "invented-policy".into(),
                    selection: crate::services::agent_host::execution::ObservedSelection {
                        model_id: Some(observed.model_id.clone()),
                        reasoning_effort: observed.effort.clone(),
                        fast_mode: observed.fast_mode,
                    },
                    substitutions: vec![],
                },
                observed,
                context_hash: binding.context_hash.clone(),
            })
        })
    }
    fn dispatch_owned_task<'a>(
        &'a self,
        _: &'a Store,
        binding: &'a super::super::task_execution::Binding,
        session: &'a super::super::task_execution::Session,
        _admission: tokio::sync::OwnedMutexGuard<()>,
    ) -> BoxFuture<'a, Result<ExecutionDispatch>> {
        Box::pin(async move {
            let mut records = self.owned_dispatches.lock().unwrap();
            let result = records.entry(binding.id.clone()).or_insert_with(|| {
                self.owned_calls.fetch_add(1, Ordering::SeqCst);
                ExecutionDispatch {
                    request_key: binding.request.request_key.clone(),
                    session_id: session.owned.session_id.clone(),
                    run_id: format!("invented-run:{}", binding.id),
                    user_message_id: format!("invented-user:{}", binding.id),
                    phase: "terminal".into(),
                    event_cursor: 1,
                    result: Some(json!({"output":"ok"})),
                    error: None,
                }
            });
            Ok(result.clone())
        })
    }
    fn owned_task_status<'a>(
        &'a self,
        binding: &'a super::super::task_execution::Binding,
        _: &'a super::super::task_execution::Session,
    ) -> BoxFuture<'a, Result<Option<ExecutionDispatch>>> {
        Box::pin(async move {
            Ok(self
                .owned_dispatches
                .lock()
                .unwrap()
                .get(&binding.id)
                .cloned())
        })
    }
    fn owned_task_output<'a>(
        &'a self,
        binding: &'a super::super::task_execution::Binding,
        _: &'a super::super::task_execution::Session,
    ) -> BoxFuture<'a, Result<super::super::task_execution::NativeOutput>> {
        Box::pin(async move {
            let records = self.owned_dispatches.lock().unwrap();
            if !records
                .get(&binding.id)
                .is_some_and(|record| record.phase == "terminal" && record.error.is_none())
            {
                return Err(BenchmarkError::new(
                    "dispatch_uncertain",
                    "Invented predecessor is not committed",
                ));
            }
            Ok(super::super::task_execution::NativeOutput {
                text: super::super::workflow::committed_report("ok"),
                elapsed_ms: 8,
                repository_result: None,
            })
        })
    }
    fn unsupported(&self, _: &Configuration, _: &BenchmarkDraft) -> Option<String> {
        None
    }

    fn inventory<'a>(
        &'a self,
        _: &'a str,
        account: Option<&'a str>,
        _: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(async move {
            Ok((if self.native_v2_inventory {
                native_v2_configurations()
            } else {
                configurations()
            })
            .into_iter()
            .map(|mut configuration| {
                configuration.account_id = account.map(str::to_owned);
                if account.is_some() {
                    configuration.effort = None;
                    configuration.fast_mode = None;
                }
                if self.changed_runtime.load(Ordering::SeqCst) {
                    configuration.inventory_revision = Some("invented-changed-runtime".into());
                }
                InventoryModel {
                    name: configuration.model_id.clone(),
                    available: !self
                        .unavailable
                        .lock()
                        .unwrap()
                        .contains(&configuration.model_id),
                    configuration,
                    efforts: vec!["high".into()],
                    supports_fast_mode: true,
                    reason: None,
                }
            })
            .collect())
        })
    }

    fn execute<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
        version: BenchmarkVersion,
        _: u32,
        _: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            if let Some(code) = self.refuse_next.lock().unwrap().take() {
                return Err(BenchmarkError::new(&code, "Offline pre-dispatch refusal"));
            }
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            assert!(matches!(
                attempt.configuration.model_id.as_str(),
                "parser" | "painter"
            ));
            // Two specializations and a failed third repeat create soft labels.
            let suitable = version.manifest.prompt.contains("parser")
                == (attempt.configuration.model_id == "parser");
            let feedback_valid = version.manifest.entry_state.as_ref().is_none_or(|entry| {
                !entry.previous_reports.iter().any(|report| {
                    report == "wrong"
                        || serde_json::from_str::<Value>(report)
                            .is_ok_and(|value| value["output"] == "wrong")
                })
            });
            attempt.output = Some(if suitable && feedback_valid && attempt.repetition != 2 {
                "ok".into()
            } else {
                "wrong".into()
            });
            attempt.observed = Some(attempt.configuration.clone());
            attempt.outcome = Some("completed".into());
            attempt.duration_ms = Some(10);
            attempt.native_execution_ms = Some(8);
            attempt.finished_at = Some(now());
            attempt.usage.cost = (!self.no_cost.load(Ordering::SeqCst)).then_some(0.01);
            attempt.usage.schema = "offline-pipeline-v1".into();
            let events = if self.native_v2_inventory {
                self.native_fixture_events(&mut attempt).await?
            } else {
                json!({"offlineStub":true})
            };
            attempt.evidence_hash = Some(fixtures::seal(&store.root, &attempt, &events).await?);
            if self.cancel_after.load(Ordering::SeqCst) == call {
                store.set_run_state(&attempt.run_id, "cancelling").await?;
            }
            Ok(attempt)
        })
    }
}

async fn open(root: &std::path::Path, backend: Arc<OfflineWorkers>) -> Arc<BenchmarkService> {
    if backend.native_v2_inventory && backend.native_store.get().is_none() {
        assert!(backend
            .native_store
            .set(Arc::new(
                SessionStore::open(&root.join("invented-native-host.sqlite"))
                    .await
                    .unwrap()
            ))
            .is_ok());
    }
    let store = Store::open(root).await.unwrap();
    store.recover().await.unwrap();
    Arc::new(BenchmarkService {
        store,
        backend,
        wake: tokio::sync::Notify::new(),
        active: Default::default(),
        app: None,
    })
}

async fn publish(service: &BenchmarkService, split: &str, count: usize) -> Vec<BenchmarkVersion> {
    publish_with_entry(service, split, count, false).await
}

async fn publish_with_entry(
    service: &BenchmarkService,
    split: &str,
    count: usize,
    entry: bool,
) -> Vec<BenchmarkVersion> {
    let mut versions = Vec::new();
    for index in 0..count {
        let mut draft = seed_definitions().remove(0);
        draft.name = format!("Offline pipeline {split} {index}");
        draft.description = "Invented infrastructure fixture; no ranking evidence".into();
        draft.source = "Invented offline fixture".into();
        draft.work_class_id = "debug".into();
        draft.split = split.into();
        draft.task_family = format!("offline-{split}-{index}");
        draft.environment = json!({"splitGroup":format!("{split}-group-{}",index/2)});
        draft.prompt = if index % 2 == 0 {
            "Repair parser tokenizer grammar syntax"
        } else {
            "Repair painter canvas colors pixels"
        }
        .into();
        draft.fixtures.clear();
        draft.repetitions = 3;
        draft.limits.timeout_seconds = 10;
        if entry {
            draft.entry_state = Some(EntryState {
                schema_version: 1,
                root_task_id: "offline-entry".into(),
                step_id: "work".into(),
                parent_step_id: None,
                fixture_snapshot_hash: String::new(),
                conversation_prefix: String::new(),
                previous_reports: vec![],
                remaining_budget_seconds: 10,
                content_hash: String::new(),
            });
        }
        draft.evaluator = Evaluator {
            kind: "exact".into(),
            expected: "ok".into(),
            rubric: String::new(),
            revision: "offline-v1".into(),
            known_good: "ok".into(),
            known_bad: "wrong".into(),
        };
        let definition = service.store.save_draft(None, None, draft).await.unwrap();
        versions.push(
            service
                .publish_version(&definition.id, definition.draft_revision)
                .await
                .unwrap(),
        );
    }
    versions
}

async fn measure(service: &Arc<BenchmarkService>, versions: &[BenchmarkVersion], key: &str) {
    let request = RunRequest {
        request_key: key.into(),
        version_ids: versions.iter().map(|v| v.id.clone()).collect(),
        configurations: configurations(),
        repetitions: 3,
        // The case's own limit: tests on the native clock get a long one.
        timeout_seconds: versions[0].manifest.limits.timeout_seconds,
        max_executions: versions.len() as u32 * 6,
        preview: false,
        parallelism: Some(4),
        workflow_policy: None,
    };
    let run = service.start_run(request.clone()).await.unwrap();
    assert_eq!(service.start_run(request).await.unwrap().id, run.id);
    // A hang guard only: the offline matrix settles in seconds alone but
    // shares the machine with the whole parallel test suite.
    tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            service.tick().await.unwrap();
            let run = service.store.run(&run.id).await.unwrap();
            if run.state == "completed" {
                assert_eq!(run.attempts.len(), versions.len() * 6);
                assert!(run.attempts.iter().all(|a| a.phase == "terminal"
                    && a.evidence_hash.is_some()
                    && !a.evaluations.is_empty()));
                return;
            }
            assert_eq!(run.state, "running");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("offline matrix must settle");
}

#[tokio::test]
async fn published_runs_reach_fit_holdout_selection_and_durable_host_outcome() {
    let directory = tempfile::tempdir().unwrap();
    let backend = Arc::new(OfflineWorkers::default());
    let service = open(directory.path(), backend.clone()).await;
    let training = publish(&service, "train", 8).await;
    let held = publish(&service, "held_out", 8).await;
    measure(&service, &training, "offline-training").await;
    let query = learned::FitRequest {
        work_class_id: "debug".into(),
        version_ids: training.iter().map(|v| v.id.clone()).collect(),
        configurations: configurations(),
        cutoff_at: now(),
        weights: RoleWeights::default(),
    };
    // This is the same query/fit/save path as the application command.
    let artifact = learned::fit(&service.query_data().await.unwrap(), query).unwrap();
    assert_eq!(artifact.model.common_cases, 8);
    service.store.save_selector_fit(&artifact).await.unwrap();
    let plan = service
        .freeze_selector_holdout(learned::holdout::HoldoutRequest {
            request_key: "offline-holdout".into(),
            model_id: artifact.model.id.clone(),
            version_ids: held.iter().map(|v| v.id.clone()).collect(),
            persona_prior: artifact
                .model
                .candidates
                .iter()
                .map(|c| c.candidate_key.clone())
                .collect(),
            fallback_key: artifact.model.candidates[0].candidate_key.clone(),
            min_quality: 0.5,
        })
        .await
        .unwrap();
    assert!(service
        .store
        .evaluate_selector_holdout(&plan.id)
        .await
        .is_err());
    // Reservation and measurement must be distinct millisecond timestamps.
    tokio::time::sleep(Duration::from_millis(2)).await;
    measure(&service, &held, "offline-held-out").await;
    let report = service
        .store
        .evaluate_selector_holdout(&plan.id)
        .await
        .unwrap();
    assert_eq!(report.cases.len(), 8);
    assert_eq!(report.groups, 4);
    assert_eq!(report.policies.len(), 7);
    let best = report
        .policies
        .iter()
        .find(|p| p.policy == "best_fixed")
        .unwrap();
    assert!(best.learned_utility_gain > 0.0);
    assert!(!report.dispatch_allowed);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 96);

    let mut application = executor::ApplicationRequest {
        request_key: "offline-wave:step:0".into(),
        surface: "wave".into(),
        context_id: "offline-wave".into(),
        task: learned::PublicTask::from(&training[0].manifest),
        target_family: "new-application-family".into(),
        target_group: "new-application-group".into(),
        candidates: configurations()
            .into_iter()
            .map(|configuration| RoutingCandidate {
                configuration,
                available: true,
                reason: None,
            })
            .collect(),
        prior_ids: vec!["painter".into(), "parser".into()],
        hard_candidate_id: None,
        model_id: Some(artifact.model.id.clone()),
        min_quality: 0.5,
    };
    let decision = service
        .store
        .preview_executor_decision(application.clone().try_into().unwrap())
        .await
        .unwrap();
    assert_eq!(decision.chosen.as_ref().unwrap().model_id, "painter");
    assert_eq!(decision.source, "prior");
    assert_eq!(
        decision
            .research_prediction
            .as_ref()
            .unwrap()
            .chosen
            .as_ref()
            .unwrap()
            .model_id,
        "parser"
    );
    assert!(!decision.learned_dispatch_allowed);
    application.surface = "chat".into();
    application.request_key = "offline-chat-preview".into();
    let chat = service
        .store
        .preview_executor_decision(application.clone().try_into().unwrap())
        .await
        .unwrap();
    assert_eq!(chat.chosen_key, decision.chosen_key);
    assert!(service
        .store
        .executor_decision(&application.request_key)
        .await
        .unwrap()
        .is_none());
    application.hard_candidate_id = Some("parser".into());
    let pinned = service
        .store
        .preview_executor_decision(application.clone().try_into().unwrap())
        .await
        .unwrap();
    assert_eq!(pinned.source, "pin");
    application.candidates[0].available = false;
    assert!(service
        .store
        .preview_executor_decision(application.clone().try_into().unwrap())
        .await
        .unwrap()
        .chosen
        .is_none());
    application.hard_candidate_id = None;
    application.candidates[0].available = true;
    application.task.execution_profile = "interactive_acp".into();
    for candidate in &mut application.candidates {
        candidate.configuration.execution_profile = "interactive_acp".into();
        candidate.configuration.inventory_revision = None;
    }
    application.request_key = "offline-wave:step:0".into();
    application.surface = "wave".into();
    let decision = service
        .store
        .prepare_executor_decision(application.try_into().unwrap())
        .await
        .unwrap();
    assert_eq!(
        decision.research_prediction.as_ref().unwrap().reason,
        "untrained_role_or_execution_context"
    );
    assert_eq!(decision.chosen.as_ref().unwrap().model_id, "painter");
    assert_eq!(decision.source, "prior");
    assert!(!decision.learned_dispatch_allowed);

    // Exercise real durable receipt APIs with a stubbed provider boundary.
    // The host stores its own run ID, distinct from the graph's logical run.
    let host_path = directory.path().join("host.sqlite");
    let host = SessionStore::open(&host_path).await.unwrap();
    let start = ReceiptStart {
        link: ExecutorLink {
            decision_key: decision.request.request_key.clone(),
            logical_run_id: "graph-run".into(),
        },
        session_id: "offline-session".into(),
        host_run_id: "native-run".into(),
        message_id: "offline-message".into(),
        bridge_generation: 1,
        provider_id: "offline-pipeline".into(),
        account_id: None,
        started_at: "2026-01-01T00:00:00Z".into(),
        selection: ReportedSelection::default(),
    };
    assert!(host.claim_executor_receipt(&start).await.unwrap());
    service
        .store
        .observe_executor(
            &decision.request.request_key,
            executor::Observation {
                phase: "started".into(),
                session_id: Some(start.session_id.clone()),
                run_id: Some(start.link.logical_run_id.clone()),
                configuration: None,
                outcome: None,
                reason: Some("Awaiting provider acknowledgement".into()),
            },
        )
        .await
        .unwrap();
    drop(host);
    service.store.pool.close().await;
    drop(service);

    let service = open(directory.path(), backend.clone()).await;
    let host = SessionStore::open(&host_path).await.unwrap();
    assert!(!host.claim_executor_receipt(&start).await.unwrap());
    assert_eq!(
        service
            .store
            .prepare_executor_decision(decision.request.clone())
            .await
            .unwrap()
            .artifact_hash,
        decision.artifact_hash
    );
    assert_eq!(
        service
            .store
            .selector_holdout_report(&plan.id)
            .await
            .unwrap()
            .unwrap()
            .artifact_hash,
        report.artifact_hash
    );
    assert_eq!(
        service
            .store
            .selector_fit(&artifact.model.id)
            .await
            .unwrap()
            .model
            .snapshot_hash,
        artifact.model.snapshot_hash
    );
    host.finish_executor_receipt(
        &start,
        &ReceiptFinish {
            finished_at: "2026-01-01T00:00:01Z".into(),
            status: "completed".into(),
            selection: ReportedSelection {
                model_id: Some("painter".into()),
                model_name: None,
                effort: Some("high".into()),
                fast: Some(false),
            },
            changes: vec![],
            changes_truncated: false,
        },
    )
    .await
    .unwrap();
    let receipt = host
        .executor_receipt(&start.link.decision_key)
        .await
        .unwrap();
    let terminal = service
        .store
        .observe_host_outcome(
            &start.link.decision_key,
            start.session_id.clone(),
            start.link.logical_run_id.clone(),
            "completed".into(),
            receipt,
        )
        .await
        .unwrap();
    assert_eq!(terminal.observations.len(), 2);
    assert_eq!(
        terminal.observations[1].observation.outcome.as_deref(),
        Some("completed")
    );
    // The provider reports a model, not complete runtime attestation or quality.
    assert_eq!(terminal.observations[1].matches_selected, None);
    assert_eq!(
        terminal.observations[1]
            .observation
            .configuration
            .as_ref()
            .unwrap()
            .model_id,
        "painter"
    );
    assert_eq!(
        terminal.host_execution.unwrap().start.host_run_id,
        "native-run"
    );
    assert!(!host.claim_executor_receipt(&start).await.unwrap());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 96);
}
