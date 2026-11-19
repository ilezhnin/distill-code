pub mod campaigns;
pub mod credits;
pub mod data_use;
mod owner;
pub mod runner;
mod session_retention;
pub mod types;

// The systems below the runner, and their modules under the names the rest
// of the app knows them by.
pub mod definitions;
pub mod grading;
pub mod ledger;
pub mod pipelines;
pub use definitions::{catalog, fixtures, generated, model_catalog, seeds};
pub use grading::{artifact_context, evaluation, mutation, repository, worker};
use ledger::activity;
pub use ledger::{analysis, effort, evidence, export, flights, home_advantage, routing, store};
pub use pipelines::{
    executor, learned, promotion, qualification, selector, task_execution, workflow,
    workflow_campaign, workflow_policy,
};

// The judging system's parts under the names the service knows them by.
pub use runner::pool as judge_pool;
use runner::{checks as judge_checks, frozen as judge_panel};

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, OnceLock, Weak};
use store::{event, now, Store};
use tauri::Manager;
use tokio::sync::{Mutex, Notify, OnceCell};
use types::*;

pub(crate) fn execution_backend_kind(app: &tauri::AppHandle) -> &'static str {
    #[cfg(feature = "app-test-driver")]
    if super::agent_host::execution_fixture::active() {
        return "isolated_native_fixture";
    }
    if app.try_state::<super::e2e_mode::E2eMode>().is_some() {
        "isolated_stub"
    } else {
        "production_native"
    }
}
/// The one measurement profile a case is published and run with: tokens,
/// time and list-price cost per attempt. The quota and capacity batches that
/// sampled an account around a run are retired.
pub const TASK_METRICS: &str = "task_metrics";
const RETIRED_PROFILE: &str =
    "Quota and capacity measurements are retired; republish the case with task metrics";
/// The longest time limit a run may give one turn, in seconds. A time limit
/// only stops a turn that never ends; it is no part of what a case measures.
pub const MAX_TIME_LIMIT_SECONDS: u32 =
    (crate::services::agent_host::router::MAX_OWNED_TURN_MS / 1000) as u32;

/// How long a starting process waits for the one it replaces to let the
/// benchmark folder go (see [`owner`]).
const OWNER_WAIT_SECONDS: u32 = 30;

#[derive(Default)]
pub struct BenchmarkState {
    service: OnceCell<Arc<BenchmarkService>>,
    /// This process's claim on the benchmark folder, held while it lives.
    owner: OnceLock<std::fs::File>,
}
impl BenchmarkState {
    pub async fn start_existing(&self, app: &tauri::AppHandle) -> Result<()> {
        let root = super::flock_root::app_root(app)
            .map_err(|e| BenchmarkError::new("storage_unavailable", e))?;
        if !root.join("benchmarks/benchmarks.db").is_file() {
            return Ok(());
        }
        // A restart can start this process while the one it replaces is
        // still closing.
        let mut waited = 0;
        loop {
            match self.get(app).await {
                Err(error) if error.message == owner::ELSEWHERE && waited < OWNER_WAIT_SECONDS => {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    waited += 1;
                }
                result => return result.map(|_| ()),
            }
        }
    }
    pub async fn get(&self, app: &tauri::AppHandle) -> Result<Arc<BenchmarkService>> {
        self.service
            .get_or_try_init(|| async {
                let root = super::flock_root::app_root(app)
                    .map_err(|e| BenchmarkError::new("storage_unavailable", e))?
                    .join("benchmarks");
                // Before the store opens: opening migrates it and recovers
                // the runs of a process that stopped.
                let owner = owner::claim(&root)?;
                let store = Store::open(&root).await?;
                store.recover().await?;
                let _ = worker::configure(app);
                let backend: Arc<dyn runner::ExecutionBackend> =
                    if execution_backend_kind(app) == "isolated_stub" {
                        Arc::new(runner::FakeBackend::default())
                    } else {
                        Arc::new(runner::NativeBackend::new(app.clone()))
                    };
                let service = Arc::new(BenchmarkService {
                    store,
                    backend,
                    wake: Notify::new(),
                    active: Default::default(),
                    queries: Default::default(),
                    app: Some(app.clone()),
                });
                service.seed().await?;
                let _ = self.owner.set(owner);
                let background = service.clone();
                tauri::async_runtime::spawn(async move {
                    background.run_loop().await;
                });
                Ok(service)
            })
            .await
            .cloned()
    }
    pub async fn park(&self) -> Result<()> {
        if let Some(service) = self.service.get() {
            service.store.park_workflow_campaigns().await?;
            for run in service.store.active_runs().await? {
                if run.state == "running" {
                    service.store.set_run_state(&run.id, "pausing").await?;
                }
            }
            service.wake.notify_one();
        }
        Ok(())
    }
}
pub struct BenchmarkService {
    pub store: Store,
    pub backend: Arc<dyn runner::ExecutionBackend>,
    pub wake: Notify,
    /// Attempts and judge panels in flight, by lane (see [`runner::Flight`]).
    pub active: Mutex<std::collections::HashMap<String, runner::Flight>>,
    /// The query data and the views' analyses, one computation of each at a
    /// time (see [`flights::Flights`]).
    pub queries: flights::Flights,
    #[cfg_attr(test, allow(dead_code))]
    app: Option<tauri::AppHandle>,
}
pub(super) async fn notify_changed(
    #[cfg_attr(test, allow(unused_variables))] store: &Store,
    #[cfg_attr(test, allow(unused_variables))] app: Option<&tauri::AppHandle>,
) {
    // Unit tests verify committed events. App-driver tests exercise the
    // desktop notification adapter in a real Tauri application.
    #[cfg(not(test))]
    if let Some(app) = app {
        static NOTIFIED: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
        if let Ok(notice) = changed_notice(store, &NOTIFIED).await {
            let _ = tauri::Emitter::emit(app, "benchmark-changed", notice);
        }
    }
}
/// The most entities one notice names; past it the app refreshes everything.
const NOTICE_ENTITIES: i64 = 100;
/// The notice for events committed since the last one (`notified` holds its
/// sequence): the newest sequence and the ids of the entities those events
/// changed (runs, definitions, campaigns), so the app refreshes only their
/// views. Without ids (the first notice, or more than [`NOTICE_ENTITIES`])
/// the app refreshes everything.
#[cfg_attr(test, allow(dead_code))]
async fn changed_notice(
    store: &Store,
    notified: &std::sync::atomic::AtomicI64,
) -> Result<serde_json::Value> {
    let sequence =
        sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(sequence),0) FROM benchmark_events")
            .fetch_one(&store.pool)
            .await?;
    let since = notified.fetch_max(sequence, std::sync::atomic::Ordering::SeqCst);
    if since == 0 {
        return Ok(serde_json::json!({ "sequence": sequence }));
    }
    // The range is this notice's now; if its names cannot be read, it still
    // goes out, naming nothing, so the app refreshes everything.
    let Ok(ids) = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT entity_id FROM benchmark_events WHERE sequence>? AND sequence<=? LIMIT ?",
    )
    .bind(since)
    .bind(sequence)
    .bind(NOTICE_ENTITIES + 1)
    .fetch_all(&store.pool)
    .await
    else {
        return Ok(serde_json::json!({ "sequence": sequence }));
    };
    if ids.len() as i64 > NOTICE_ENTITIES {
        return Ok(serde_json::json!({ "sequence": sequence }));
    }
    Ok(serde_json::json!({ "sequence": sequence, "entityIds": ids }))
}

mod service;
pub(super) use self::service::*;
