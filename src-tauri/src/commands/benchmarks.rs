//! Typed IPC boundary. The durable service owns all admission and execution.
use crate::services::benchmarks::{self, types::*, BenchmarkState};
use tauri::{AppHandle, Manager};

async fn service(app: &AppHandle) -> Result<std::sync::Arc<benchmarks::BenchmarkService>> {
    app.state::<BenchmarkState>().get(app).await
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
    let s = service(&app).await?;
    let value = s.store.publish(&id, expected_revision).await?;
    s.changed().await;
    Ok(value)
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
pub async fn benchmark_start_run(app: AppHandle, request: RunRequest) -> Result<BenchmarkRun> {
    service(&app).await?.start_run(request).await
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
pub async fn benchmark_cancel_run(app: AppHandle, id: String) -> Result<BenchmarkRun> {
    service(&app).await?.control(&id, "cancel").await
}
#[tauri::command]
pub async fn benchmark_get_evidence(app: AppHandle, id: String) -> Result<Attempt> {
    service(&app).await?.store.attempt(&id).await
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
#[tauri::command]
pub fn benchmark_get_capabilities(app: AppHandle) -> Vec<Capability> {
    let _ = benchmarks::worker::configure(&app);
    let mut capabilities=vec![Capability{provider_id:"claude-acp".into(),execution_profile:"native_text".into(),supported:true,reason:"Fresh owned sessions with tools, personal context, hooks and MCP disabled; exact selection required".into()},Capability{provider_id:"codex-acp".into(),execution_profile:"native_text".into(),supported:false,reason:"Native no-tool and context restrictions require verification".into()}];
    for profile in ["protected_repository", "isolated_ui"] {
        capabilities.push(Capability{provider_id:"claude-acp".into(),execution_profile:profile.into(),supported:benchmarks::worker::available(),reason:if benchmarks::worker::available(){"Bounded JavaScript/HTML artifacts generated as text and evaluated in a separate Chromium sandbox; general native repository execution is unavailable"}else{"Isolated artifact worker prerequisites are unavailable"}.into()});
    }
    if app
        .try_state::<crate::services::e2e_mode::E2eMode>()
        .is_some()
    {
        capabilities.push(Capability {
            provider_id: "benchmark-fake".into(),
            execution_profile: "native_text".into(),
            supported: true,
            reason: "Deterministic fake provider in validated isolated E2E mode".into(),
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
pub async fn benchmark_get_history(
    app: AppHandle,
    configuration: Configuration,
) -> Result<Vec<HistorySnapshot>> {
    let s = service(&app).await?;
    analyze(s.query_data().await?, move |data| {
        benchmarks::analysis::history(data, &configuration)
    })
    .await
}
#[tauri::command]
pub async fn benchmark_get_usage_series(
    app: AppHandle,
    query: ResultQuery,
) -> Result<Vec<UsageSample>> {
    service(&app).await?.store.list_usage(&query).await
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
pub async fn benchmark_get_usage_comparisons(
    app: AppHandle,
    baseline_id: String,
) -> Result<Vec<benchmarks::usage::UsageComparison>> {
    let s = service(&app).await?;
    let baseline = s
        .store
        .baselines()
        .await?
        .into_iter()
        .find(|b| b.id == baseline_id)
        .ok_or_else(|| BenchmarkError::new("validation", "Baseline not found"))?;
    Ok(benchmarks::usage::compare_samples(
        &s.store.usage_samples().await?,
        &baseline,
    ))
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
#[tauri::command]
pub async fn benchmark_list_baselines(app: AppHandle) -> Result<Vec<Baseline>> {
    service(&app).await?.store.baselines().await
}
#[tauri::command]
pub async fn benchmark_create_baseline(
    app: AppHandle,
    name: String,
    run_ids: Vec<String>,
    threshold: f64,
) -> Result<Baseline> {
    let s = service(&app).await?;
    let value = s.create_baseline(name, run_ids, threshold).await?;
    s.changed().await;
    Ok(value)
}
#[tauri::command]
pub async fn benchmark_get_comparisons(
    app: AppHandle,
    baseline_id: String,
    query: ResultQuery,
) -> Result<Vec<Comparison>> {
    let s = service(&app).await?;
    let baseline = s
        .store
        .baselines()
        .await?
        .into_iter()
        .find(|v| v.id == baseline_id)
        .ok_or_else(|| BenchmarkError::new("validation", "Baseline not found"))?;
    Ok(benchmarks::analysis::compare(
        &s.query_data().await?,
        &baseline,
        &query,
    ))
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
            definitions: Vec::new(),
            versions: Vec::new(),
            runs: Vec::new(),
            attempts: Vec::new(),
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
}
