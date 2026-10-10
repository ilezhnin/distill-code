//! Typed IPC boundary. The durable service owns all admission and execution.
use crate::services::agent_host::execution::NativeProvider;
use crate::services::benchmarks::{self, types::*, BenchmarkState};
use crate::services::provider_accounts;
use tauri::{AppHandle, Manager};

async fn service(app: &AppHandle) -> Result<std::sync::Arc<benchmarks::BenchmarkService>> {
    app.state::<BenchmarkState>().get(app).await
}
#[tauri::command]
pub async fn benchmark_owned_task_choices(
    app: AppHandle,
    promotion_id: String,
) -> Result<Vec<benchmarks::task_execution::Choice>> {
    service(&app).await?.owned_task_choices(&promotion_id).await
}
#[tauri::command]
pub async fn benchmark_owned_task_artifact_facts(
    app: AppHandle,
    binding_id: String,
    paths: Vec<String>,
) -> Result<benchmarks::task_execution::ArtifactFacts> {
    service(&app)
        .await?
        .owned_task_artifact_facts(&binding_id, paths)
        .await
}
#[tauri::command]
pub async fn benchmark_owned_task_public_result(
    app: AppHandle,
    binding_id: String,
) -> Result<benchmarks::task_execution::NativeOutput> {
    service(&app)
        .await?
        .owned_task_public_result(&binding_id)
        .await
}
#[tauri::command]
pub fn benchmark_execution_backend_metadata(app: AppHandle) -> serde_json::Value {
    let fixture = {
        #[cfg(feature = "app-test-driver")]
        {
            crate::services::agent_host::execution_fixture::metadata()
        }
        #[cfg(not(feature = "app-test-driver"))]
        {
            serde_json::Value::Null
        }
    };
    serde_json::json!({"backendKind":benchmarks::execution_backend_kind(&app),"fixture":fixture})
}
#[tauri::command]
pub async fn benchmark_get_owned_task_mode(
    app: AppHandle,
    context_id: String,
) -> Result<Option<benchmarks::task_execution::ModeEnvelope>> {
    service(&app)
        .await?
        .store
        .owned_task_mode_envelope(&context_id)
        .await
}
#[tauri::command]
pub async fn benchmark_set_owned_task_mode(
    app: AppHandle,
    request: benchmarks::task_execution::ModeIntent,
) -> Result<Option<benchmarks::task_execution::ModeEnvelope>> {
    let svc = service(&app).await?;
    let clearing_fresh = matches!(&request, benchmarks::task_execution::ModeIntent::V1(value) if value.promotion_id.is_none())
        && matches!(svc.store.owned_task_mode_envelope(request.context_id()).await?, Some(benchmarks::task_execution::ModeEnvelope::V2(mode)) if mode.request.surface == "chat");
    if request.is_fresh_chat() || clearing_fresh {
        return svc.set_owned_task_mode_intent(request).await;
    }
    let host = app
        .state::<crate::services::agent_host::AgentHost>()
        .get_or_start(&app)
        .await
        .map_err(|e| BenchmarkError::new("infrastructure_failure", e))?;
    host.session_record(request.context_id())
        .await
        .map_err(|e| BenchmarkError::new("validation", e.to_string()))?;
    if host
        .store
        .execution_owner(request.context_id())
        .await
        .map_err(|e| BenchmarkError::new("infrastructure_failure", e))?
        .is_some()
    {
        return Err(BenchmarkError::new(
            "validation",
            "Owned execution cannot authorize autonomous waves",
        ));
    }
    service(&app)
        .await?
        .set_owned_task_mode_intent(request)
        .await
}
#[tauri::command]
pub async fn benchmark_prepare_owned_task(
    app: AppHandle,
    request: benchmarks::task_execution::PrepareIntent,
) -> Result<benchmarks::task_execution::Prepared> {
    service(&app)
        .await?
        .prepare_owned_task_intent(request)
        .await
}

#[tauri::command]
pub async fn benchmark_inspect_owned_task_mode(
    app: AppHandle,
    request: benchmarks::task_execution::ModeRequestV2,
) -> Result<benchmarks::task_execution::Consent> {
    service(&app).await?.inspect_owned_task_mode(&request).await
}
#[tauri::command]
pub async fn benchmark_owned_task_native_choices(
    app: AppHandle,
    context_id: String,
) -> Result<Vec<benchmarks::task_execution::Choice>> {
    service(&app)
        .await?
        .owned_task_choices_v2(&context_id)
        .await
}
#[tauri::command]
pub async fn benchmark_dispatch_owned_task(
    app: AppHandle,
    binding_id: String,
) -> Result<crate::services::agent_host::execution::ExecutionDispatch> {
    service(&app).await?.dispatch_owned_task(&binding_id).await
}
#[tauri::command]
pub async fn benchmark_owned_task_status(
    app: AppHandle,
    binding_id: String,
) -> Result<Option<crate::services::agent_host::execution::ExecutionDispatch>> {
    service(&app).await?.owned_task_status(&binding_id).await
}
#[tauri::command]
pub async fn benchmark_reopen_owned_task(app: AppHandle, binding_id: String) -> Result<()> {
    service(&app).await?.reopen_owned_task(&binding_id).await
}
#[tauri::command]
pub async fn benchmark_cancel_owned_task(
    app: AppHandle,
    binding_id: String,
    close: bool,
) -> Result<()> {
    service(&app)
        .await?
        .cancel_owned_task(&binding_id, close)
        .await
}
#[tauri::command]
pub async fn benchmark_get_owned_task(
    app: AppHandle,
    binding_id: String,
) -> Result<benchmarks::task_execution::Prepared> {
    let s = service(&app).await?;
    let binding = s.store.task_binding(&binding_id).await?;
    let session = s
        .store
        .task_session(&binding)
        .await?
        .ok_or_else(|| BenchmarkError::new("not_found", "Owned task session is missing"))?;
    Ok(benchmarks::task_execution::Prepared { binding, session })
}
#[tauri::command]
pub async fn benchmark_qualify_version(
    app: AppHandle,
    request: benchmarks::qualification::Request,
) -> Result<benchmarks::qualification::Record> {
    service(&app).await?.qualify_version(request).await
}
#[tauri::command]
pub async fn benchmark_get_qualification(
    app: AppHandle,
    id: String,
) -> Result<benchmarks::qualification::Record> {
    service(&app).await?.store.qualification(&id).await
}
#[tauri::command]
pub async fn benchmark_qualification_bindings(
    app: AppHandle,
    version_id: String,
) -> Result<Vec<benchmarks::qualification::Binding>> {
    service(&app)
        .await?
        .store
        .qualification_bindings(&version_id)
        .await
}
#[tauri::command]
pub async fn benchmark_revoke_qualification(
    app: AppHandle,
    id: String,
    reason: String,
) -> Result<()> {
    let s = service(&app).await?;
    s.store.revoke_qualification(&id, &reason).await?;
    s.changed().await;
    Ok(())
}
#[tauri::command]
pub async fn benchmark_register_promotion_rule(
    app: AppHandle,
    request: benchmarks::promotion::Registration,
) -> Result<benchmarks::promotion::RegisteredRule> {
    let s = service(&app).await?;
    let value = s.store.register_promotion_rule(request).await?;
    s.changed().await;
    Ok(value)
}
/// Learned selection state of every work class: its certificate, or how far
/// its qualified evidence still is from one.
#[tauri::command]
pub async fn benchmark_class_policies(
    app: AppHandle,
) -> Result<Vec<benchmarks::promotion::ClassPolicy>> {
    service(&app).await?.store.class_policies().await
}

/// The exact contract or step-by-step trajectory a campaign evaluated, for
/// the operator to acknowledge in its rule.
#[tauri::command]
pub async fn benchmark_campaign_deployment(
    app: AppHandle,
    campaign_id: String,
) -> Result<benchmarks::promotion::Deployment> {
    service(&app)
        .await?
        .store
        .campaign_deployment(&campaign_id)
        .await
}
#[tauri::command]
pub async fn benchmark_get_promotion_rule(
    app: AppHandle,
    campaign_id: String,
) -> Result<Option<benchmarks::promotion::RegisteredRule>> {
    service(&app)
        .await?
        .store
        .promotion_rule(&campaign_id)
        .await
}
#[tauri::command]
pub async fn benchmark_promote_selector(
    app: AppHandle,
    campaign_id: String,
) -> Result<benchmarks::promotion::State> {
    let s = service(&app).await?;
    let value = s.store.promote_selector(&campaign_id).await?;
    s.changed().await;
    Ok(value)
}
#[tauri::command]
pub async fn benchmark_list_promotions(
    app: AppHandle,
) -> Result<Vec<benchmarks::promotion::State>> {
    service(&app).await?.store.promotions().await
}
#[tauri::command]
pub async fn benchmark_revoke_promotion(
    app: AppHandle,
    id: String,
    reason: String,
) -> Result<benchmarks::promotion::State> {
    let s = service(&app).await?;
    let value = s.store.revoke_promotion(&id, &reason).await?;
    s.changed().await;
    Ok(value)
}
#[tauri::command]
pub async fn benchmark_list_definitions(app: AppHandle) -> Result<Vec<BenchmarkDefinition>> {
    service(&app).await?.store.definitions().await
}
#[tauri::command]
pub async fn benchmark_save_draft(
    app: AppHandle,
    id: Option<String>,
    expected_revision: Option<i64>,
    draft: BenchmarkDraft,
) -> Result<BenchmarkDefinition> {
    let s = service(&app).await?;
    let value = s
        .store
        .save_draft(id.as_deref(), expected_revision, draft)
        .await?;
    s.changed().await;
    Ok(value)
}
#[tauri::command]
pub fn benchmark_validate_draft(draft: BenchmarkDraft) -> ValidationReport {
    benchmarks::catalog::validate(&draft)
}
#[tauri::command]
pub async fn benchmark_publish_version(
    app: AppHandle,
    id: String,
    expected_revision: i64,
) -> Result<BenchmarkVersion> {
    service(&app)
        .await?
        .publish_version(&id, expected_revision)
        .await
}
#[tauri::command]
pub async fn benchmark_duplicate_definition(
    app: AppHandle,
    id: String,
) -> Result<BenchmarkDefinition> {
    let s = service(&app).await?;
    let value = s.store.duplicate(&id).await?;
    s.changed().await;
    Ok(value)
}
#[tauri::command]
pub async fn benchmark_archive_definition(
    app: AppHandle,
    id: String,
    archived: bool,
) -> Result<BenchmarkDefinition> {
    let s = service(&app).await?;
    let value = s.store.archive(&id, archived).await?;
    s.changed().await;
    Ok(value)
}
#[tauri::command]
pub async fn benchmark_import_definition(
    app: AppHandle,
    draft: BenchmarkDraft,
) -> Result<BenchmarkDefinition> {
    let s = service(&app).await?;
    let value = s.store.save_draft(None, None, draft).await?;
    s.changed().await;
    Ok(value)
}
#[tauri::command]
pub fn benchmark_generate_variant(family: String, seed: u64) -> Result<BenchmarkDraft> {
    benchmarks::generated::generate(&family, seed)
}
#[tauri::command]
pub async fn benchmark_preview_run(app: AppHandle, request: RunRequest) -> Result<RunPreview> {
    service(&app).await?.preview_run(&request).await
}
#[tauri::command]
pub async fn benchmark_preview_workflow_policy(
    app: AppHandle,
    request: benchmarks::workflow_policy::WorkflowRunRequest,
) -> Result<RunPreview> {
    service(&app).await?.preview_run(&request.try_into()?).await
}
#[tauri::command]
pub async fn benchmark_freeze_workflow_campaign(
    app: AppHandle,
    request: benchmarks::workflow_campaign::Request,
) -> Result<benchmarks::workflow_campaign::Campaign> {
    let s = service(&app).await?;
    let result = s.freeze_workflow_campaign(request).await?;
    s.changed().await;
    Ok(result)
}
#[tauri::command]
pub async fn benchmark_list_workflow_campaigns(
    app: AppHandle,
) -> Result<Vec<benchmarks::workflow_campaign::Campaign>> {
    service(&app).await?.store.workflow_campaigns().await
}
#[tauri::command]
pub async fn benchmark_get_workflow_campaign(
    app: AppHandle,
    id: String,
) -> Result<benchmarks::workflow_campaign::Campaign> {
    service(&app).await?.store.workflow_campaign(&id).await
}
#[tauri::command]
pub async fn benchmark_control_workflow_campaign(
    app: AppHandle,
    id: String,
    action: String,
) -> Result<benchmarks::workflow_campaign::Campaign> {
    service(&app)
        .await?
        .control_workflow_campaign(&id, &action)
        .await
}
#[tauri::command]
pub async fn benchmark_workflow_campaign_report(
    app: AppHandle,
    id: String,
) -> Result<benchmarks::workflow_campaign::report::Report> {
    service(&app)
        .await?
        .store
        .workflow_campaign_report(&id)
        .await
}
#[tauri::command]
pub async fn benchmark_start_workflow_policy(
    app: AppHandle,
    request: benchmarks::workflow_policy::WorkflowRunRequest,
) -> Result<BenchmarkRun> {
    service(&app).await?.start_run(request.try_into()?).await
}
#[tauri::command]
pub async fn benchmark_get_workflow_trace(
    app: AppHandle,
    root_attempt_id: String,
) -> Result<benchmarks::workflow::Trace> {
    service(&app)
        .await?
        .store
        .workflow_trace(&root_attempt_id)
        .await
}
#[tauri::command]
pub async fn benchmark_start_run(
    app: AppHandle,
    request: RunRequest,
    replace_run_id: Option<String>,
) -> Result<BenchmarkRun> {
    service(&app)
        .await?
        .start_run_replacing(request, replace_run_id.as_deref())
        .await
}
#[tauri::command]
pub async fn benchmark_list_runs(app: AppHandle) -> Result<Vec<RunSummary>> {
    service(&app).await?.store.runs().await
}
#[tauri::command]
pub async fn benchmark_list_attempts(
    app: AppHandle,
    query: ResultQuery,
) -> Result<Vec<AttemptSummary>> {
    service(&app).await?.store.list_attempts(&query).await
}
#[tauri::command]
pub async fn benchmark_list_designs(
    app: AppHandle,
    query: ResultQuery,
) -> Result<Vec<DesignEntry>> {
    service(&app).await?.store.list_designs(&query).await
}
#[tauri::command]
pub async fn benchmark_get_run(app: AppHandle, id: String) -> Result<BenchmarkRun> {
    service(&app).await?.store.run(&id).await
}
#[tauri::command]
pub async fn benchmark_pause_run(app: AppHandle, id: String) -> Result<BenchmarkRun> {
    service(&app).await?.control(&id, "pause").await
}
#[tauri::command]
pub async fn benchmark_resume_run(app: AppHandle, id: String) -> Result<BenchmarkRun> {
    service(&app).await?.control(&id, "resume").await
}
#[tauri::command]
pub async fn benchmark_extend_run(
    app: AppHandle,
    id: String,
    version_ids: Vec<String>,
) -> Result<BenchmarkRun> {
    service(&app).await?.extend_run(&id, &version_ids).await
}
#[tauri::command]
pub async fn benchmark_cancel_run(app: AppHandle, id: String) -> Result<BenchmarkRun> {
    service(&app).await?.control(&id, "cancel").await
}
#[tauri::command]
pub async fn benchmark_get_evidence(app: AppHandle, id: String) -> Result<Attempt> {
    let service = service(&app).await?;
    let mut attempt = service.store.attempt(&id).await?;
    // Priced as every report prices it: an unreported cost from the catalog.
    let catalog = service.store.catalog_entries().await?;
    attempt.usage.cost = benchmarks::model_catalog::attempt_cost(
        &catalog,
        &attempt.configuration,
        &attempt.usage,
        attempt.finished_at.or(attempt.started_at),
    );
    Ok(attempt)
}
#[tauri::command]
pub async fn benchmark_events_since(
    app: AppHandle,
    after_sequence: i64,
) -> Result<Vec<BenchmarkEvent>> {
    service(&app)
        .await?
        .store
        .events_since(after_sequence)
        .await
}
#[tauri::command]
pub async fn benchmark_get_inventory(
    app: AppHandle,
    provider_id: String,
    account_id: Option<String>,
    refresh: bool,
) -> Result<Vec<InventoryModel>> {
    let s = service(&app).await?;
    let models = s
        .backend
        .inventory(&provider_id, account_id.as_deref(), refresh)
        .await?;
    s.store
        .record_inventory(&provider_id, account_id.as_deref(), &models)
        .await?;
    Ok(models)
}
#[tauri::command]
pub async fn benchmark_get_routing_evidence(
    app: AppHandle,
    query: RoutingEvidenceQuery,
) -> Result<RoutingEvidence> {
    let s = service(&app).await?;
    benchmarks::routing::get_evidence(&s.query_data().await?, &query)
}
#[tauri::command]
pub async fn benchmark_get_candidate_observations(
    app: AppHandle,
) -> Result<Vec<CandidateObservation>> {
    service(&app).await?.store.candidate_observations().await
}
/// What a provider's verified native text profile guarantees.
fn native_text_reason(provider: NativeProvider) -> &'static str {
    match provider {
        NativeProvider::Claude => "Fresh owned sessions with tools, personal context, hooks and MCP disabled; exact selection required",
        NativeProvider::Codex => "Fresh owned sessions with Codex tools, code mode, subagents, skills, AGENTS.md, apps and web search disabled; exact selection required; 'ultra' effort excluded",
        NativeProvider::Grok => "Fresh owned sessions on a private Grok home with tools, rules, hooks, skills and web search disabled; uses the Grok CLI sign-in",
        NativeProvider::Kimi => "Fresh owned sessions with Kimi tools, SYSTEM.md, AGENTS.md, hooks, reminders, MCP and search disabled in process; uses the Kimi Code sign-in",
    }
}

/// A provider's native text capability: supported only once its policy probe
/// has passed on what this build ships, and otherwise saying why not.
fn native_text_capability(provider: NativeProvider) -> Capability {
    capability_with_issue(provider, provider.admission_issue())
}

/// The native text capability of `provider`, unsupported for `issue` when
/// there is one.
fn capability_with_issue(provider: NativeProvider, issue: Option<String>) -> Capability {
    Capability {
        provider_id: provider.harness_id().into(),
        execution_profile: "native_text".into(),
        supported: issue.is_none(),
        reason: issue.unwrap_or_else(|| native_text_reason(provider).into()),
        cli_account_id: provider_accounts::cli_login_account_id(provider.harness_id()),
    }
}

#[tauri::command]
pub async fn benchmark_get_capabilities(app: AppHandle) -> Vec<Capability> {
    let _ = benchmarks::worker::configure(&app);
    let mut capabilities: Vec<Capability> = NativeProvider::ALL
        .iter()
        .map(|provider| native_text_capability(*provider))
        .collect();
    let sandbox_issue = crate::services::benchmark_sandbox::ready()
        .await
        .err()
        .map(|error| error.to_string());
    for provider in NativeProvider::ALL {
        capabilities.push(Capability {
            provider_id: provider.harness_id().into(),
            execution_profile: "protected_repository".into(),
            supported: sandbox_issue.is_none(),
            reason: sandbox_issue.clone().unwrap_or_else(|| "Repository tasks run with tools in an isolated WSL copy; choose an account signed in inside distill-bench".into()),
            cli_account_id: provider_accounts::cli_login_account_id(provider.harness_id()),
        });
    }
    capabilities.push(Capability {
        provider_id: "claude-acp".into(),
        execution_profile: "isolated_ui".into(),
        supported: benchmarks::worker::available(),
        reason: if benchmarks::worker::available() {
            "Bounded HTML artifacts generated as text and evaluated in a separate Chromium sandbox"
        } else {
            "Isolated artifact worker prerequisites are unavailable"
        }
        .into(),
        cli_account_id: None,
    });
    if app
        .try_state::<crate::services::e2e_mode::E2eMode>()
        .is_some()
    {
        capabilities.push(Capability {
            provider_id: "benchmark-fake".into(),
            execution_profile: "native_text".into(),
            supported: true,
            reason: "Deterministic fake provider in validated isolated E2E mode".into(),
            cli_account_id: None,
        });
    }
    capabilities
}
/// Ledger analysis is CPU work over every attempt; it runs off the async
/// workers so a long history never stalls other commands.
async fn analyze<T: Send + 'static>(
    data: QueryData,
    work: impl FnOnce(&QueryData) -> T + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || work(&data))
        .await
        .map_err(|error| BenchmarkError::new("infrastructure_failure", error.to_string()))
}
#[tauri::command]
pub async fn benchmark_get_leaderboard(
    app: AppHandle,
    query: ResultQuery,
) -> Result<LeaderboardReport> {
    let s = service(&app).await?;
    analyze(s.query_data().await?, move |data| {
        benchmarks::analysis::leaderboard(data, &query)
    })
    .await
}
#[tauri::command]
pub async fn benchmark_get_case_stats(app: AppHandle) -> Result<Vec<CaseStats>> {
    let s = service(&app).await?;
    analyze(s.query_data().await?, benchmarks::analysis::case_tracker).await
}
/// Chooses a configuration for a class of work from the evidence, or the
/// persona's prior while evidence is short; `record` keeps the decision.
#[tauri::command]
pub async fn benchmark_select_candidate(
    app: AppHandle,
    query: benchmarks::selector::SelectionQuery,
    record: Option<bool>,
) -> Result<benchmarks::selector::Selection> {
    let s = service(&app).await?;
    let selection = analyze(s.query_data().await?, move |data| {
        benchmarks::selector::select(data, &query)
    })
    .await??;
    if record.unwrap_or(false) {
        s.store.save_selection(&selection).await?;
    }
    Ok(selection)
}
/// Fits locally from a frozen training ledger; never dispatches a model call.
#[tauri::command]
pub async fn benchmark_fit_selector(
    app: AppHandle,
    request: benchmarks::learned::FitRequest,
) -> Result<benchmarks::learned::FitSummary> {
    let s = service(&app).await?;
    let artifact = analyze(s.query_data().await?, move |data| {
        benchmarks::learned::fit(data, request)
    })
    .await??;
    s.store.save_selector_fit(&artifact).await
}

#[tauri::command]
pub async fn benchmark_list_selector_fits(
    app: AppHandle,
) -> Result<Vec<benchmarks::learned::FitSummary>> {
    service(&app).await?.store.selector_fits().await
}

#[tauri::command]
pub async fn benchmark_get_selector_fit(
    app: AppHandle,
    id: String,
) -> Result<benchmarks::learned::FitArtifact> {
    service(&app).await?.store.selector_fit(&id).await
}

#[tauri::command]
pub async fn benchmark_predict_selector(
    app: AppHandle,
    id: String,
    request: benchmarks::learned::PredictionRequest,
) -> Result<benchmarks::learned::Prediction> {
    let model = service(&app).await?.store.selector_model(&id).await?;
    tauri::async_runtime::spawn_blocking(move || benchmarks::learned::predict(&model, &request))
        .await
        .map_err(|e| BenchmarkError::new("infrastructure_failure", e.to_string()))?
}

#[tauri::command]
pub async fn benchmark_select_executor(
    app: AppHandle,
    request: benchmarks::executor::ApplicationRequest,
    record: bool,
) -> Result<benchmarks::executor::Decision> {
    if request.request_key.starts_with("owned-task:") {
        return Err(BenchmarkError::new(
            "validation",
            "Owned task keys require native context binding",
        ));
    }
    let store = &service(&app).await?.store;
    let request = request.try_into()?;
    // Ordinary chat and wave sends choose through their class's certificate.
    if record {
        store.prepare_ordinary_executor_decision(request).await
    } else {
        store.preview_ordinary_executor_decision(request).await
    }
}

#[tauri::command]
pub async fn benchmark_preview_executor_decision(
    app: AppHandle,
    request: benchmarks::executor::Request,
) -> Result<benchmarks::executor::Decision> {
    if request.request_key.starts_with("owned-task:") {
        return Err(BenchmarkError::new(
            "validation",
            "Owned task keys require native context binding",
        ));
    }
    service(&app)
        .await?
        .store
        .preview_ordinary_executor_decision(request)
        .await
}

#[tauri::command]
pub async fn benchmark_prepare_executor_decision(
    app: AppHandle,
    request: benchmarks::executor::Request,
) -> Result<benchmarks::executor::Decision> {
    if request.request_key.starts_with("owned-task:") {
        return Err(BenchmarkError::new(
            "validation",
            "Owned task keys require native context binding",
        ));
    }
    service(&app)
        .await?
        .store
        .prepare_ordinary_executor_decision(request)
        .await
}

#[tauri::command]
pub async fn benchmark_get_executor_decision(
    app: AppHandle,
    request_key: String,
) -> Result<Option<benchmarks::executor::Record>> {
    let record = service(&app)
        .await?
        .store
        .executor_decision(&request_key)
        .await?;
    let Some(record) = record else {
        return Ok(None);
    };
    let receipt = executor_host_receipt(&app, &request_key).await?;
    Ok(Some(record.with_host_execution(receipt)?))
}

async fn executor_host_receipt(
    app: &AppHandle,
    key: &str,
) -> Result<Option<crate::services::agent_host::executor_receipts::ExecutorReceipt>> {
    let host = app
        .state::<crate::services::agent_host::AgentHost>()
        .get_or_start(app)
        .await
        .map_err(|message| BenchmarkError::new("host_unavailable", message))?;
    host.store
        .executor_receipt(key)
        .await
        .map_err(|message| BenchmarkError::new("host_evidence", message))
}

#[tauri::command]
pub async fn benchmark_sync_executor_outcome(
    app: AppHandle,
    request_key: String,
    session_id: String,
    run_id: String,
    outcome: String,
) -> Result<benchmarks::executor::Record> {
    let receipt = executor_host_receipt(&app, &request_key).await?;
    let host = app
        .state::<crate::services::agent_host::AgentHost>()
        .get_or_start(&app)
        .await
        .map_err(|message| BenchmarkError::new("host_unavailable", message))?;
    service(&app)
        .await?
        .store
        .observe_native_host_outcome(
            &host.store,
            &request_key,
            session_id,
            run_id,
            outcome,
            receipt,
        )
        .await
}

#[tauri::command]
pub async fn benchmark_observe_executor(
    app: AppHandle,
    request_key: String,
    observation: benchmarks::executor::Observation,
) -> Result<benchmarks::executor::Record> {
    service(&app)
        .await?
        .store
        .observe_application_executor(&request_key, observation)
        .await
}

/// Reserves unused related families and freezes choices without starting work.
#[tauri::command]
pub async fn benchmark_freeze_selector_holdout(
    app: AppHandle,
    request: benchmarks::learned::holdout::HoldoutRequest,
) -> Result<benchmarks::learned::holdout::HoldoutPlan> {
    let service = service(&app).await?;
    let plan = service.freeze_selector_holdout(request).await?;
    service.changed().await;
    Ok(plan)
}

#[tauri::command]
pub async fn benchmark_list_selector_holdouts(
    app: AppHandle,
    model_id: String,
) -> Result<Vec<benchmarks::learned::holdout::HoldoutPlan>> {
    service(&app)
        .await?
        .store
        .selector_holdouts(&model_id)
        .await
}

/// Evaluate only existing evidence; never starts generation or judging.
#[tauri::command]
pub async fn benchmark_evaluate_selector_holdout(
    app: AppHandle,
    plan_id: String,
) -> Result<benchmarks::learned::report::HoldoutReport> {
    let service = service(&app).await?;
    let report = service.store.evaluate_selector_holdout(&plan_id).await?;
    service.changed().await;
    Ok(report)
}

#[tauri::command]
pub async fn benchmark_get_selector_holdout_report(
    app: AppHandle,
    plan_id: String,
) -> Result<Option<benchmarks::learned::report::HoldoutReport>> {
    service(&app)
        .await?
        .store
        .selector_holdout_report(&plan_id)
        .await
}

/// The held-out harness of one class: the selector against fixed policies.
#[tauri::command]
pub async fn benchmark_selector_harness(
    app: AppHandle,
    query: benchmarks::selector::HarnessQuery,
) -> Result<benchmarks::selector::HarnessReport> {
    let s = service(&app).await?;
    analyze(s.query_data().await?, move |data| {
        benchmarks::selector::harness(data, &query)
    })
    .await?
}
#[tauri::command]
pub async fn benchmark_get_history(
    app: AppHandle,
    configuration: Configuration,
    model: Option<bool>,
) -> Result<Vec<HistorySnapshot>> {
    let s = service(&app).await?;
    analyze(s.query_data().await?, move |data| {
        if model.unwrap_or(false) {
            benchmarks::analysis::model_history(data, &configuration)
        } else {
            benchmarks::analysis::history(data, &configuration)
        }
    })
    .await
}
#[tauri::command]
pub async fn benchmark_get_usage_ledger(app: AppHandle) -> Result<Vec<UsageLedgerEntry>> {
    let root = crate::services::distill_root::app_root(&app)
        .map_err(|e| BenchmarkError::new("storage_unavailable", e))?;
    if !root.join("benchmarks/benchmarks.db").is_file() {
        return Ok(Vec::new());
    }
    service(&app).await?.store.usage_ledger().await
}
#[tauri::command]
pub async fn benchmark_list_catalog(app: AppHandle) -> Result<Vec<CatalogEntry>> {
    service(&app).await?.store.catalog_entries().await
}
#[tauri::command]
pub async fn benchmark_save_catalog_entry(
    app: AppHandle,
    mut entry: CatalogEntry,
) -> Result<CatalogEntry> {
    benchmarks::model_catalog::validate(&entry)
        .map_err(|message| BenchmarkError::new("validation", message))?;
    if entry.id.trim().is_empty() {
        entry.id = uuid::Uuid::new_v4().to_string();
    }
    if entry.created_at <= 0 {
        entry.created_at = benchmarks::store::now();
    }
    if entry.checked_at <= 0 {
        entry.checked_at = entry.created_at;
    }
    entry.needle = entry.needle.trim().to_lowercase();
    service(&app)
        .await?
        .store
        .save_catalog_entry(&entry)
        .await?;
    Ok(entry)
}
#[tauri::command]
pub async fn benchmark_delete_catalog_entry(app: AppHandle, id: String) -> Result<()> {
    service(&app).await?.store.delete_catalog_entry(&id).await
}
/// Sets how many attempts of a configuration an open run flies at once.
#[tauri::command]
pub async fn benchmark_set_run_parallelism(
    app: AppHandle,
    id: String,
    parallelism: u32,
) -> Result<BenchmarkRun> {
    service(&app).await?.set_parallelism(&id, parallelism).await
}
#[tauri::command]
pub async fn benchmark_list_releases(app: AppHandle) -> Result<Vec<PoolRelease>> {
    service(&app).await?.store.releases().await
}
#[tauri::command]
pub async fn benchmark_create_release(app: AppHandle, name: Option<String>) -> Result<PoolRelease> {
    service(&app).await?.create_release(name).await
}
#[tauri::command]
pub async fn benchmark_submit_review(
    app: AppHandle,
    id: String,
    score: f64,
    reason: String,
    criteria: Option<serde_json::Value>,
) -> Result<Attempt> {
    let s = service(&app).await?;
    let value = s.review(&id, score, reason, criteria).await?;
    s.changed().await;
    Ok(value)
}
#[tauri::command]
pub async fn benchmark_rescore(app: AppHandle, id: String) -> Result<Attempt> {
    let s = service(&app).await?;
    let value = s.rescore(&id).await?;
    s.changed().await;
    Ok(value)
}
#[tauri::command]
pub async fn benchmark_export_dataset(
    app: AppHandle,
    include_held_out: bool,
) -> Result<ExportResult> {
    let s = service(&app).await?;
    benchmarks::export::export(&s.store, s.query_data().await?, include_held_out).await
}
#[tauri::command]
pub async fn benchmark_list_schedules(app: AppHandle) -> Result<Vec<Schedule>> {
    service(&app).await?.store.schedules().await
}
#[tauri::command]
pub async fn benchmark_save_schedule(app: AppHandle, schedule: Schedule) -> Result<Schedule> {
    let s = service(&app).await?;
    let value = s.save_schedule(schedule).await?;
    s.changed().await;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn analysis_never_holds_the_async_worker() {
        let (sender, receiver) = std::sync::mpsc::channel();
        // This task can only run while the analysis leaves the worker free.
        let ping = tokio::spawn(async move {
            let _ = sender.send(());
        });
        let data = QueryData {
            releases: Vec::new(),
            definitions: Vec::new(),
            versions: Vec::new(),
            runs: Vec::new(),
            attempts: Vec::new(),
            required_repetitions: 1,
        };
        let received = analyze(data, move |_| {
            receiver
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_ok()
        })
        .await
        .unwrap();
        assert!(received);
        ping.await.unwrap();
    }

    /// A profile whose policy probe has not passed is listed with the reason
    /// and never offered as supported.
    #[test]
    fn only_a_probed_profile_is_a_supported_capability() {
        let claude = native_text_capability(NativeProvider::Claude);
        assert!(claude.supported);
        assert_eq!(claude.cli_account_id, None);
        let kimi = native_text_capability(NativeProvider::Kimi);
        assert!(kimi.supported);
        assert_eq!(kimi.reason, native_text_reason(NativeProvider::Kimi));
        assert_eq!(kimi.cli_account_id.as_deref(), Some("cli-login-kimi-acp"));
        // Codex runs on managed accounts, so it names no CLI sign-in.
        let codex = native_text_capability(NativeProvider::Codex);
        assert!(codex.supported);
        assert_eq!(codex.reason, native_text_reason(NativeProvider::Codex));
        assert_eq!(codex.cli_account_id, None);
        let grok = native_text_capability(NativeProvider::Grok);
        assert!(grok.supported);
        assert_eq!(grok.reason, native_text_reason(NativeProvider::Grok));
        assert_eq!(grok.cli_account_id.as_deref(), Some("cli-login-grok-acp"));
        // A profile the probe has not passed says why, and keeps naming its
        // CLI sign-in, so its rows still list.
        let unprobed = capability_with_issue(
            NativeProvider::Grok,
            Some("The Grok benchmark profile has not passed its policy probe".into()),
        );
        assert!(!unprobed.supported);
        assert_eq!(
            unprobed.reason,
            "The Grok benchmark profile has not passed its policy probe"
        );
        assert_eq!(
            unprobed.cli_account_id.as_deref(),
            Some("cli-login-grok-acp")
        );
    }
}
