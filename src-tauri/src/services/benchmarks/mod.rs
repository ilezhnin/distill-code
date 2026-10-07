pub mod analysis;
pub mod campaigns;
pub mod catalog;
pub mod effort;
pub mod evaluation;
pub mod evidence;
pub mod export;
pub mod fixtures;
pub mod generated;
mod judge_checks;
pub mod model_catalog;
pub mod repository;
pub mod routing;
pub mod runner;
pub mod seeds;
pub mod selector;
pub mod store;
pub mod types;
pub mod worker;
pub mod workflow;

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, OnceLock, Weak};
use store::{event, now, Store};
use tauri::Manager;
use tokio::sync::{Mutex, Notify, OnceCell};
use types::*;

const MATRIX_ORDER_ALGORITHM: &str = "sha256-cell-order-v1";
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

/// One evaluation writer per attempt: a judge panel on one rendering never
/// blocks a review of another.
fn evaluation_lock(attempt_id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(attempt_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(attempt_id.to_owned(), Arc::downgrade(&lock));
    lock
}

pub(super) fn execution_count(draft: &BenchmarkDraft) -> usize {
    draft.workflow.as_ref().map_or(1, |w| w.steps.len())
        + if draft.evaluator.kind == "rubric" {
            runner::MAX_JUDGES
        } else {
            0
        }
}

/// A plan owes a cell unless its candidate helped write the case.
fn owed(version: &BenchmarkVersion, configuration: &Configuration) -> bool {
    !routing::authored_by_candidate(&version.manifest, configuration)
}

/// Executions a plan owes: every owed cell's turns and judge reservation, per repetition.
fn owed_executions(versions: &[BenchmarkVersion], request: &RunRequest) -> usize {
    let mut turns = 0usize;
    for version in versions {
        for configuration in &request.configurations {
            if owed(version, configuration) {
                turns = turns.saturating_add(execution_count(&version.manifest));
            }
        }
    }
    turns.saturating_mul(request.repetitions as usize)
}

/// A repetition of a case not yet started, as a run plans it.
fn pending_attempt(
    run_id: &str,
    version_id: &str,
    configuration: &Configuration,
    repetition: u32,
) -> Attempt {
    Attempt {
        id: uuid::Uuid::new_v4().to_string(),
        run_id: run_id.to_owned(),
        version_id: version_id.to_owned(),
        configuration: configuration.clone(),
        repetition,
        phase: "pending".into(),
        outcome: None,
        reason: None,
        wait_until: None,
        session_id: None,
        host_run_id: None,
        observed: None,
        started_at: None,
        finished_at: None,
        duration_ms: None,
        output: None,
        evidence_hash: None,
        usage: TokenUsage::default(),
        evaluations: Vec::new(),
        event_cursor: 0,
        workflow_steps: Vec::new(),
        resolved_model: None,
    }
}

/// A cell the run never measured and never will: no repetition to restart or drop.
fn never_measured(attempts: &[Attempt]) -> bool {
    attempts
        .iter()
        .all(|a| matches!(a.outcome.as_deref(), Some("excluded" | "unsupported")))
}

fn window_closed_message(run: &BenchmarkRun) -> String {
    let closed = chrono::DateTime::from_timestamp_millis(analysis::window_closes(run))
        .map(|at| at.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_default();
    format!("The run's 24-hour window closed at {closed}; its results are final. Start a new run.")
}

fn matrix_order_seed(request_key: &str) -> String {
    fixtures::hash(format!("{MATRIX_ORDER_ALGORITHM}\0{request_key}").as_bytes())
}

fn randomized_matrix(request: &RunRequest) -> Result<Vec<(String, Configuration, u32)>> {
    let seed = matrix_order_seed(&request.request_key);
    let mut cells = Vec::new();
    for repetition in 0..request.repetitions {
        for version in &request.version_ids {
            for configuration in &request.configurations {
                let priority = fixtures::hash(&serde_json::to_vec(&(
                    &seed,
                    version,
                    &configuration.id,
                    repetition,
                ))?);
                cells.push((priority, version.clone(), configuration.clone(), repetition));
            }
        }
    }
    cells.sort_by(|a, b| (&a.0, &a.1, &a.2.id, a.3).cmp(&(&b.0, &b.1, &b.2.id, b.3)));
    Ok(cells
        .into_iter()
        .map(|(_, version, configuration, repetition)| (version, configuration, repetition))
        .collect())
}

#[derive(Default)]
pub struct BenchmarkState {
    service: OnceCell<Arc<BenchmarkService>>,
}
impl BenchmarkState {
    pub async fn start_existing(&self, app: &tauri::AppHandle) -> Result<()> {
        let root = super::distill_root::app_root(app)
            .map_err(|e| BenchmarkError::new("storage_unavailable", e))?;
        if root.join("benchmarks/benchmarks.db").is_file() {
            self.get(app).await?;
        }
        Ok(())
    }
    pub async fn get(&self, app: &tauri::AppHandle) -> Result<Arc<BenchmarkService>> {
        self.service
            .get_or_try_init(|| async {
                let root = super::distill_root::app_root(app)
                    .map_err(|e| BenchmarkError::new("storage_unavailable", e))?
                    .join("benchmarks");
                let store = Store::open(&root).await?;
                store.recover().await?;
                let _ = worker::configure(app);
                let backend: Arc<dyn runner::ExecutionBackend> =
                    if app.try_state::<super::e2e_mode::E2eMode>().is_some() {
                        Arc::new(runner::FakeBackend::default())
                    } else {
                        Arc::new(runner::NativeBackend::new(app.clone()))
                    };
                let service = Arc::new(BenchmarkService {
                    store,
                    backend,
                    wake: Notify::new(),
                    active: Default::default(),
                    app: Some(app.clone()),
                });
                service.seed().await?;
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
    #[cfg_attr(test, allow(dead_code))]
    app: Option<tauri::AppHandle>,
}
impl BenchmarkService {
    pub async fn changed(&self) {
        // Unit tests verify committed events. App-driver tests exercise the
        // desktop notification adapter in a real Tauri application.
        #[cfg(not(test))]
        if let Some(app) = &self.app {
            if let Ok(sequence) = sqlx::query_scalar::<_, i64>(
                "SELECT COALESCE(MAX(sequence),0) FROM benchmark_events",
            )
            .fetch_one(&self.store.pool)
            .await
            {
                let _ = tauri::Emitter::emit(
                    app,
                    "benchmark-changed",
                    serde_json::json!({"sequence":sequence}),
                );
            }
        }
    }
    pub async fn query_data(&self) -> Result<QueryData> {
        let definitions = self.store.all_definitions().await?;
        let versions: Vec<BenchmarkVersion> = definitions
            .iter()
            .flat_map(|d| d.versions.clone())
            .collect();
        let mut runs = self.store.all_runs().await?;
        // A cost the provider left out is its tokens at the list prices of the
        // day, so every board and the model page price every provider alike.
        let catalog = self.store.catalog_entries().await?;
        for attempt in runs.iter_mut().flat_map(|run| run.attempts.iter_mut()) {
            attempt.usage.cost = model_catalog::attempt_cost(
                &catalog,
                &attempt.configuration,
                &attempt.usage,
                attempt.finished_at.or(attempt.started_at),
            );
        }
        // Cells of a version an evaluator-only republication replaced are the
        // carrying version's cells in every analysis; the store keeps them
        // where they ran.
        let carried = analysis::carried_versions(&versions);
        if !carried.is_empty() {
            for run in &mut runs {
                for id in &mut run.request.version_ids {
                    if let Some(to) = carried.get(id) {
                        id.clone_from(to);
                    }
                }
                for attempt in &mut run.attempts {
                    if let Some(to) = carried.get(&attempt.version_id) {
                        attempt.version_id.clone_from(to);
                    }
                }
            }
        }
        let attempts = runs.iter().flat_map(|r| r.attempts.clone()).collect();
        let releases = self.store.releases().await?;
        // Every analysis reads this data, so a measurement of an unknown
        // effort is left out of all of them alike, and an attempt its event
        // record stopped is unscored in all of them alike; the store keeps
        // both as they settled.
        Ok(evidence::with_answer_caps(effort::with_known_effort(
            QueryData {
                releases,
                definitions,
                versions,
                runs,
                attempts,
                required_repetitions: analysis::REQUIRED_REPETITIONS,
            },
        )))
    }
    /// Executions a saved plan owes, read from the stored manifests alone.
    pub(super) async fn planned_executions(&self, request: &RunRequest) -> Result<usize> {
        let mut versions = Vec::new();
        for id in &request.version_ids {
            versions.push(self.store.version(id).await?);
        }
        Ok(owed_executions(&versions, request))
    }
    pub async fn preview_run(&self, request: &RunRequest) -> Result<RunPreview> {
        let mut issues = Vec::new();
        let mut versions = Vec::new();
        for id in &request.version_ids {
            versions.push(self.store.version(id).await?);
        }
        let count = owed_executions(&versions, request);
        if !versions.is_empty()
            && request
                .configurations
                .iter()
                .any(|c| !versions.iter().any(|v| owed(v, c)))
        {
            issues.push("A configuration authored every selected case and owes none".into());
        }
        // Quota and capacity batches are retired; a version published for one
        // measures nothing the boards read.
        if versions
            .iter()
            .any(|v| v.manifest.measurement_profile != TASK_METRICS)
        {
            issues.push(RETIRED_PROFILE.into());
        }
        // A pinned runtime that changed since selection would fail every cell.
        let mut runtimes: HashMap<(String, Option<String>), Vec<InventoryModel>> = HashMap::new();
        for c in &request.configurations {
            if let Err(error) = self.backend.readiness(c).await {
                issues.push(error.message);
            }
            let Some(pinned) = c.inventory_revision.as_ref() else {
                continue;
            };
            let key = (c.provider_id.clone(), c.account_id.clone());
            if !runtimes.contains_key(&key) {
                match self
                    .backend
                    .inventory(&c.provider_id, c.account_id.as_deref(), false)
                    .await
                {
                    Ok(models) => {
                        runtimes.insert(key.clone(), models);
                    }
                    Err(error) => {
                        issues.push(format!(
                            "Runtime inventory is unavailable: {}",
                            error.message
                        ));
                        continue;
                    }
                }
            }
            let model = runtimes[&key].iter().find(|m| {
                m.configuration.model_id == c.model_id
                    && m.configuration.execution_profile == c.execution_profile
            });
            if let Some(model) = model.filter(|model| !model.available) {
                issues.push(
                    model
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Configuration is unavailable".into()),
                );
            }
            let current = model.and_then(|m| m.configuration.inventory_revision.as_ref());
            if current != Some(pinned) {
                issues.push(
                    "Runtime changed since this configuration was selected; refresh it".into(),
                );
            }
            // A model that lists levels runs an unset effort at the CLI's
            // "default", which no analysis counts (see `effort`).
            if let Some(model) = model.filter(|model| effort::left_to_the_cli(c, model)) {
                issues.push(format!(
                    "Configuration {} ({}) leaves its reasoning effort to the CLI; choose one of the levels the model lists: {}",
                    c.id,
                    c.model_name.as_deref().unwrap_or(&c.model_id),
                    model.efforts.join(", "),
                ));
            }
        }
        if request.request_key.trim().is_empty() || request.request_key.len() > 256 {
            issues.push("A bounded idempotency request key is required".into());
        }
        if request.version_ids.is_empty()
            || request.configurations.is_empty()
            || request.repetitions == 0
            || request.repetitions > 100
            || count > 1000
            || count > request.max_executions as usize
        {
            issues.push("Select cases and configurations within the explicit execution budget (maximum 1000)".into());
        }
        if request
            .parallelism
            .is_some_and(|n| n == 0 || n > runner::PARALLEL_ATTEMPTS)
        {
            issues.push(format!(
                "Attempts in parallel per configuration must be between 1 and {}",
                runner::PARALLEL_ATTEMPTS
            ));
        }
        if request.timeout_seconds == 0 || request.timeout_seconds > MAX_TIME_LIMIT_SECONDS {
            issues.push(format!(
                "Run time limit must be between 1 and {MAX_TIME_LIMIT_SECONDS} seconds"
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for v in &request.version_ids {
            if !ids.insert(v) {
                issues.push("Duplicate version in matrix".into());
            }
        }
        let mut ids = std::collections::HashSet::new();
        let mut identities = std::collections::HashSet::new();
        for c in &request.configurations {
            if !identities.insert(analysis::leaderboard_key(c)) {
                issues.push("Duplicate configuration identity in matrix".into());
            }
            if !ids.insert(&c.id) {
                issues.push("Duplicate configuration ID in matrix".into());
            }
            if c.id.is_empty() || c.model_id.is_empty() || c.provider_id.is_empty() {
                issues.push("Configuration requires ID, provider and model".into());
            }
            // Nobody could tell which effort such a cell measured, so no
            // analysis would count it (see `effort`).
            if effort::names_cli_default(c.effort.as_deref()) {
                issues.push(format!(
                    "Configuration {} ({}) leaves its reasoning effort to the CLI; \"{}\" is not an effort level, so choose one the model lists",
                    c.id,
                    c.model_name.as_deref().unwrap_or(&c.model_id),
                    effort::CLI_DEFAULT_EFFORT,
                ));
            }
        }
        for version in &versions {
            fixtures::verify_blob(&self.store.root, &version.content_hash, &version.manifest)
                .await?;
            for config in &request.configurations {
                if let Some(reason) = self.backend.unsupported(config, &version.manifest) {
                    issues.push(reason);
                }
            }
        }
        issues.sort();
        issues.dedup();
        let mut seen = std::collections::HashSet::new();
        let execution_order = randomized_matrix(request)?
            .into_iter()
            .filter_map(|(version, _, _)| seen.insert(version.clone()).then_some(version))
            .collect();
        Ok(RunPreview{valid:issues.is_empty(),issues,execution_count:count.min(u32::MAX as usize) as u32,estimated_cost:None,cost_reason:"Provider does not expose a binding spend estimate; explicit task and time limits apply".into(),execution_order})
    }
    pub async fn start_run(&self, request: RunRequest) -> Result<BenchmarkRun> {
        self.start_run_replacing(request, None).await
    }
    /// An explicitly confirmed new sitting seals the previous one in the
    /// same transaction that admits the new plan. Failed admission preserves it.
    pub async fn start_run_replacing(
        &self,
        request: RunRequest,
        replace_run_id: Option<&str>,
    ) -> Result<BenchmarkRun> {
        // The run records how many attempts of a configuration it flies at
        // once, before the request is compared with a saved plan.
        let mut request = request;
        request.parallelism.get_or_insert(runner::PARALLEL_ATTEMPTS);
        if let Some(id) =
            sqlx::query_scalar::<_, String>("SELECT id FROM run_plans WHERE request_key=?")
                .bind(&request.request_key)
                .fetch_optional(&self.store.pool)
                .await?
        {
            let existing = self.store.run(&id).await?;
            if serde_json::to_value(&existing.request)? != serde_json::to_value(&request)? {
                return Err(BenchmarkError::new(
                    "revision_conflict",
                    "Request key already belongs to another plan",
                ));
            }
            return Ok(existing);
        }
        let preview = self.preview_run(&request).await?;
        if !preview.valid {
            return Err(BenchmarkError::new(
                "capability_missing",
                preview.issues.join("; "),
            ));
        }
        let replaced =
            if let Some(previous_id) = replace_run_id {
                let previous = self.store.run(previous_id).await?;
                if previous.baked_at.is_some()
                    || previous.request.preview
                    || request.preview
                    || !matches!(
                        previous.state.as_str(),
                        "completed" | "cancelled" | "needs_attention" | "paused"
                    )
                    || request.configurations.iter().any(|c| {
                        !previous.request.configurations.iter().any(|old| {
                            analysis::leaderboard_key(c) == analysis::leaderboard_key(old)
                        })
                    })
                {
                    return Err(BenchmarkError::new(
                        "validation",
                        "Only a stopped sitting of the same configuration can be replaced",
                    ));
                }
                Some(previous)
            } else {
                None
            };
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = now();
        let mut versions = Vec::new();
        for version_id in &request.version_ids {
            versions.push(self.store.version(version_id).await?);
        }
        let path = self.store.root.join("runs").join(&id);
        // A candidate is never scheduled on a case it helped write.
        let authored: BTreeSet<(&str, &str)> = versions
            .iter()
            .flat_map(|v| {
                request
                    .configurations
                    .iter()
                    .filter(|c| !owed(v, c))
                    .map(|c| (v.id.as_str(), c.id.as_str()))
            })
            .collect();
        let cells: Vec<_> = randomized_matrix(&request)?
            .into_iter()
            .filter(|(version, configuration, _)| {
                !authored.contains(&(version.as_str(), configuration.id.as_str()))
            })
            .collect();
        let mut manifest = serde_json::to_value(&request)?;
        manifest["executionOrder"] = serde_json::json!({
            "algorithm": MATRIX_ORDER_ALGORITHM,
            "seed": matrix_order_seed(&request.request_key),
            "cells": cells.iter().map(|(version,configuration,repetition)| serde_json::json!({
                "versionId":version,"configurationId":configuration.id,"repetition":repetition
            })).collect::<Vec<_>>()
        });
        tokio::fs::create_dir_all(&path).await?;
        fixtures::write_synced(
            &path.join("manifest.json"),
            &serde_json::to_vec_pretty(&manifest)?,
        )
        .await?;
        let mut tx = self.store.pool.begin().await?;
        let inserted=sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'running',1,?,?,?) ON CONFLICT(request_key) DO NOTHING").bind(&id).bind(&request.request_key).bind(timestamp).bind(timestamp).bind(serde_json::to_string(&request)?).execute(&mut *tx).await?.rows_affected();
        if inserted == 0 {
            let previous =
                sqlx::query_scalar::<_, String>("SELECT id FROM run_plans WHERE request_key=?")
                    .bind(&request.request_key)
                    .fetch_one(&mut *tx)
                    .await?;
            tx.commit().await?;
            let run = self.store.run(&previous).await?;
            if serde_json::to_value(&run.request)? != serde_json::to_value(&request)? {
                return Err(BenchmarkError::new(
                    "revision_conflict",
                    "Request key already belongs to another plan",
                ));
            }
            return Ok(run);
        }
        // Persist the seeded cell order before any cell can become runnable.
        for version in &versions {
            routing::persist_snapshot(&mut tx, &routing::snapshot(&id, version, &request)).await?;
        }
        for (version, config, repetition) in cells {
            let attempt = pending_attempt(&id, &version, &config, repetition);
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,?,'pending',?)").bind(&attempt.id).bind(&id).bind(&version).bind(&config.id).bind(repetition as i64).bind(serde_json::to_string(&attempt)?).execute(&mut *tx).await?;
        }
        if let Some(previous) = replaced {
            // A concurrent resume or extension must not be sealed by a stale dialog.
            let revision: i64 = sqlx::query_scalar("SELECT revision FROM run_plans WHERE id=?")
                .bind(&previous.id)
                .fetch_one(&mut *tx)
                .await?;
            if revision != previous.revision {
                return Err(BenchmarkError::new(
                    "revision_conflict",
                    "The previous sitting changed; review it before measuring again",
                ));
            }
            Self::bake_in_transaction(&mut tx, &previous, timestamp).await?;
        }
        event(&mut tx, &id, "run_created").await?;
        tx.commit().await?;
        self.wake.notify_one();
        self.changed().await;
        self.store.run(&id).await
    }
    /// A run resumes with the cases it has not finished, inside its window.
    /// A case short of its repetitions starts over, every repetition anew, so
    /// a cell never spans two sittings; a complete case, passed or failed,
    /// stands. A test the app restarted under was settled as uncertain and
    /// is measured again as a new attempt, never under its own key. Once the
    /// window closed the run is final and nothing resumes it.
    pub async fn control(&self, id: &str, action: &str) -> Result<BenchmarkRun> {
        let run = self.store.run(id).await?;
        let next = match (action, run.state.as_str()) {
            ("pause", "running") => "pausing",
            ("pause", "pausing" | "paused") => return Ok(run),
            ("resume", "running") => return Ok(run),
            ("resume", "paused" | "needs_attention" | "completed" | "cancelled") => {
                if run.baked_at.is_some() || now() >= analysis::window_closes(&run) {
                    return Err(BenchmarkError::new(
                        "validation",
                        window_closed_message(&run),
                    ));
                }
                let unfinished = self.restart_unfinished_cells(&run).await?;
                if !unfinished && matches!(run.state.as_str(), "completed" | "cancelled") {
                    return Err(BenchmarkError::new(
                        "validation",
                        "Every case of this run is complete",
                    ));
                }
                "running"
            }
            ("cancel", "running" | "pausing" | "paused" | "needs_attention") => "cancelling",
            ("cancel", "cancelled" | "cancelling") => return Ok(run),
            _ => {
                return Err(BenchmarkError::new(
                    "validation",
                    "Run does not permit this transition",
                ))
            }
        };
        self.store.set_run_state(id, next).await?;
        if action == "cancel" {
            for flight in self.active.lock().await.values() {
                if flight.run_id == id {
                    let _ = flight.cancel.send(true);
                }
            }
        }
        self.wake.notify_one();
        self.changed().await;
        self.store.run(id).await
    }
    /// Adds cases to a run inside its window and goes on with it, so the
    /// sitting grows instead of a second run starting beside it. A case the
    /// run already planned is not added again: unfinished, it starts over;
    /// complete, it stands. A case a configuration authored is left out.
    /// With no cases to add this is a resume.
    /// Sets how many attempts of a configuration a run inside its window
    /// flies at once from now on, as the operator asks. The request records
    /// the newest setting, so a run that changed it notes the last one.
    pub async fn set_parallelism(&self, id: &str, parallelism: u32) -> Result<BenchmarkRun> {
        if parallelism == 0 || parallelism > runner::PARALLEL_ATTEMPTS {
            return Err(BenchmarkError::new(
                "validation",
                format!(
                    "Attempts in parallel per configuration must be between 1 and {}",
                    runner::PARALLEL_ATTEMPTS
                ),
            ));
        }
        let run = self.store.run(id).await?;
        if run.baked_at.is_some() || now() >= analysis::window_closes(&run) {
            return Err(BenchmarkError::new(
                "validation",
                window_closed_message(&run),
            ));
        }
        let mut request = run.request.clone();
        request.parallelism = Some(parallelism);
        self.store.set_run_request(id, &request).await?;
        self.wake.notify_one();
        self.changed().await;
        self.store.run(id).await
    }
    pub async fn extend_run(&self, id: &str, version_ids: &[String]) -> Result<BenchmarkRun> {
        let run = self.store.run(id).await?;
        if run.baked_at.is_some() || now() >= analysis::window_closes(&run) {
            return Err(BenchmarkError::new(
                "validation",
                window_closed_message(&run),
            ));
        }
        if matches!(run.state.as_str(), "pausing" | "cancelling") {
            return Err(BenchmarkError::new(
                "validation",
                "The run is stopping; add tests once it has",
            ));
        }
        let planned: BTreeSet<(String, String)> = run
            .attempts
            .iter()
            .map(|a| (a.version_id.clone(), a.configuration.id.clone()))
            .collect();
        let mut request = run.request.clone();
        for version_id in version_ids {
            let version = self.store.version(version_id).await?;
            for configuration in &run.request.configurations {
                if planned.contains(&(version.id.clone(), configuration.id.clone()))
                    || !owed(&version, configuration)
                {
                    continue;
                }
                for repetition in 0..request.repetitions.max(1) {
                    self.store
                        .insert_attempt(&pending_attempt(
                            id,
                            &version.id,
                            configuration,
                            repetition,
                        ))
                        .await?;
                }
            }
            if !request.version_ids.contains(version_id) {
                request.version_ids.push(version_id.clone());
                let mut tx = self.store.pool.begin().await?;
                routing::persist_snapshot(&mut tx, &routing::snapshot(id, &version, &request))
                    .await?;
                tx.commit().await?;
            }
        }
        if request.version_ids != run.request.version_ids {
            // The cap grows with the plan, so judged cases keep their panel.
            let executions = self.planned_executions(&request).await?;
            request.max_executions = request
                .max_executions
                .max(executions.min(u32::MAX as usize) as u32);
            self.store.set_run_request(id, &request).await?;
        }
        let run = self.store.run(id).await?;
        let unfinished = self.restart_unfinished_cells(&run).await?;
        if !unfinished && matches!(run.state.as_str(), "completed" | "cancelled") {
            return Err(BenchmarkError::new(
                "validation",
                "Every case of this run is complete",
            ));
        }
        if run.state != "running" {
            self.store.set_run_state(id, "running").await?;
        }
        self.wake.notify_one();
        self.changed().await;
        self.store.run(id).await
    }
    /// Puts every unfinished case of a run back to its start: the settled
    /// attempts of a cell short of the run's repetitions are superseded and
    /// each gets a fresh pending repetition, so the case is measured whole
    /// in one sitting rather than topped up across days. Pending repetitions
    /// stay queued. Returns whether anything is left to run.
    async fn restart_unfinished_cells(&self, run: &BenchmarkRun) -> Result<bool> {
        let planned = run.request.repetitions.max(1);
        let mut unfinished = false;
        for (_, attempts) in analysis::run_cells(run) {
            let measured = attempts.iter().filter(|a| analysis::is_measured(a)).count() as u32;
            if measured >= planned || never_measured(&attempts) {
                continue;
            }
            unfinished = true;
            for attempt in attempts {
                // A queued repetition runs as planned; a rendering awaiting
                // its judges or a verdict keeps its paid generation.
                if attempt.phase != "terminal"
                    || (analysis::is_measured(&attempt) && analysis::score(&attempt).is_none())
                    || matches!(attempt.outcome.as_deref(), Some("excluded" | "unsupported"))
                {
                    continue;
                }
                let fresh = pending_attempt(
                    &run.id,
                    &attempt.version_id,
                    &attempt.configuration,
                    attempt.repetition,
                );
                let mut superseded = attempt;
                superseded.reason = Some(format!(
                    "Measured again from the start on resume: {measured} of {planned} repetitions were measured when the run stopped (this one: {})",
                    superseded.outcome.as_deref().unwrap_or("unfinished")
                ));
                superseded.outcome = Some(analysis::SUPERSEDED.into());
                self.store.supersede_attempt(&superseded).await?;
                self.store.insert_attempt(&fresh).await?;
            }
        }
        Ok(unfinished)
    }
    /// Bakes a run whose window closed: its complete cells stand, every other
    /// attempt is superseded, so the run holds only what was measured whole
    /// in its sitting. Completeness is the protocol's, not the plan's, so a
    /// run that planned fewer repetitions keeps nothing. A run still open is
    /// completed as it stands.
    pub(super) async fn bake(&self, run: &BenchmarkRun, at: i64) -> Result<()> {
        let mut tx = self.store.pool.begin().await?;
        Self::bake_in_transaction(&mut tx, run, at).await?;
        tx.commit().await?;
        self.changed().await;
        Ok(())
    }
    async fn bake_in_transaction(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        run: &BenchmarkRun,
        at: i64,
    ) -> Result<()> {
        let required = run.request.repetitions.max(analysis::REQUIRED_REPETITIONS);
        let mut settled = None;
        for (_, attempts) in analysis::run_cells(run) {
            let scored = attempts
                .iter()
                .filter(|a| analysis::score(a).is_some())
                .count() as u32;
            if scored >= required {
                settled = settled.max(attempts.iter().filter_map(|a| a.finished_at).max());
                continue;
            }
            if never_measured(&attempts) {
                continue;
            }
            for attempt in attempts {
                if matches!(attempt.outcome.as_deref(), Some("excluded" | "unsupported")) {
                    continue;
                }
                let mut dropped = attempt;
                dropped.reason = Some(format!(
                    "Dropped when the sitting was sealed: {scored} of {required} repetitions were scored (this one: {})",
                    dropped.outcome.as_deref().unwrap_or("never ran")
                ));
                dropped.outcome = Some(analysis::SUPERSEDED.into());
                dropped.phase = "terminal".into();
                if dropped.finished_at.is_none() {
                    dropped.finished_at = Some(at);
                }
                // Run summaries omit output. Change only lifecycle fields so
                // superseding never erases the stored answer or paid usage.
                sqlx::query("UPDATE attempts SET phase=?,data_json=json_set(data_json,'$.phase',?,'$.outcome',?,'$.reason',?,'$.finishedAt',?),repetition=-rowid WHERE id=?")
                    .bind(&dropped.phase)
                    .bind(&dropped.phase)
                    .bind(&dropped.outcome)
                    .bind(&dropped.reason)
                    .bind(dropped.finished_at)
                    .bind(&dropped.id)
                    .execute(&mut **tx)
                    .await?;
            }
        }
        if !matches!(run.state.as_str(), "completed" | "cancelled") {
            // Completed when its last counted cell settled, not when the
            // window closed: the point keeps the date of its measurement.
            sqlx::query("UPDATE run_plans SET state='completed',updated_at=? WHERE id=?")
                .bind(settled.unwrap_or(run.updated_at))
                .bind(&run.id)
                .execute(&mut **tx)
                .await?;
        }
        sqlx::query("UPDATE run_plans SET baked_at=?,revision=revision+1 WHERE id=?")
            .bind(at)
            .bind(&run.id)
            .execute(&mut **tx)
            .await?;
        event(tx, &run.id, "run_changed").await?;
        Ok(())
    }
    pub async fn review(
        &self,
        id: &str,
        score: f64,
        reason: String,
        details: Option<serde_json::Value>,
    ) -> Result<Attempt> {
        let lock = evaluation_lock(id);
        let _guard = lock.lock().await;
        if let Some(details) = &details {
            let valid = details.as_object().is_some_and(|map| {
                !map.is_empty()
                    && map.values().all(|v| {
                        v.as_f64()
                            .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n))
                    })
            });
            if !valid {
                return Err(BenchmarkError::new(
                    "validation",
                    "Criterion scores must be numbers from 0 to 1",
                ));
            }
        }
        if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM workflow_steps WHERE attempt_id=?")
            .bind(id)
            .fetch_one(&self.store.pool)
            .await?
            != 0
        {
            return Err(BenchmarkError::new(
                "validation",
                "Workflow step evidence cannot be rescored as a final result",
            ));
        }
        if !score.is_finite() || !(0.0..=1.0).contains(&score) || reason.trim().is_empty() {
            return Err(BenchmarkError::new(
                "validation",
                "Review needs a score from 0 to 1 and rationale",
            ));
        }
        let mut a = self.store.attempt(id).await?;
        let v = self.store.version(&a.version_id).await?;
        let visual = matches!(v.manifest.evaluator.kind.as_str(), "javascript" | "browser");
        let rubric = if visual {
            v.manifest.environment["visualRubric"]
                .as_str()
                .unwrap_or(&v.manifest.evaluator.rubric)
        } else {
            &v.manifest.evaluator.rubric
        };
        if (!visual && v.manifest.evaluator.kind != "rubric")
            || rubric.trim().is_empty()
            || a.phase != "terminal"
            || a.output.is_none()
        {
            return Err(BenchmarkError::new(
                "validation",
                "A finished output and a published review rubric are required",
            ));
        }
        // An override replaces a verdict; a budget failure or an unscored
        // outcome has none to replace.
        if !visual
            && !matches!(
                self.store.stored_outcome(id).await?.as_deref(),
                Some(
                    "pass"
                        | "fail"
                        | "completed"
                        | "evaluation_error"
                        | "pending_review"
                        | "judged"
                )
            )
        {
            return Err(BenchmarkError::new(
                "validation",
                "Only an evaluated result can be reviewed",
            ));
        }
        a.evaluations.push(Evaluation {
            id: uuid::Uuid::new_v4().to_string(),
            evaluator_revision: v.manifest.evaluator.revision,
            verdict: if score == 1.0 { "pass" } else { "fail" }.into(),
            score: Some(score),
            reason,
            created_at: now(),
            provenance: if visual { "human_visual" } else { "human" }.into(),
            artifacts: Vec::new(),
            details,
            judge: None,
            usage: None,
        });
        if !visual {
            a.outcome = Some(if score == 1.0 { "pass" } else { "fail" }.into());
        }
        self.store.save_attempt(&a).await?;
        Ok(a)
    }
    pub async fn rescore(&self, id: &str) -> Result<Attempt> {
        let lock = evaluation_lock(id);
        let Ok(_guard) = lock.try_lock() else {
            return Err(BenchmarkError::new(
                "validation",
                "This attempt is already being evaluated",
            ));
        };
        if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM workflow_steps WHERE attempt_id=?")
            .bind(id)
            .fetch_one(&self.store.pool)
            .await?
            != 0
        {
            return Err(BenchmarkError::new(
                "validation",
                "Rescore the workflow's final attempt, not an intermediate step",
            ));
        }
        let mut a = self.store.attempt(id).await?;
        if a.phase != "terminal" {
            return Err(BenchmarkError::new(
                "validation",
                "Only a finished attempt can be rescored",
            ));
        }
        // Budget failures, cancellations, exclusions and infrastructure outcomes
        // keep their recorded outcome; only an evaluated result is evaluated again.
        if !matches!(
            self.store.stored_outcome(id).await?.as_deref(),
            Some("pass" | "fail" | "completed" | "evaluation_error" | "pending_review" | "judged")
        ) {
            return Err(BenchmarkError::new(
                "validation",
                "Only an evaluated result can be evaluated again",
            ));
        }
        let v = self.store.version(&a.version_id).await?;
        if routing::authored_by_candidate(&v.manifest, &a.configuration) {
            return Err(BenchmarkError::new(
                "validation",
                "The candidate authored this case, so its result is excluded",
            ));
        }
        let output = a.output.as_deref().ok_or_else(|| {
            BenchmarkError::new("evidence_missing", "Attempt has no sealed output")
        })?;
        let e = runner::evaluate(&v.manifest, output).await?;
        // A creative brief goes back to the judge panel; its objective verdict
        // ("review required") is already on record and says nothing new.
        if v.manifest.evaluator.kind == "rubric" && e.verdict == "pending_review" {
            // A human review overrides every panel, so new judge calls could not change the score.
            if a.evaluations
                .iter()
                .any(|e| e.provenance == "human" && e.score.is_some())
            {
                return Err(BenchmarkError::new(
                    "validation",
                    "A human review overrides the judge panel",
                ));
            }
            let recorded = a.evaluations.len();
            a = self
                .backend
                .judge(&self.store, a, &v, runner::JudgeStop::manual())
                .await?;
            if !a.evaluations[recorded.min(a.evaluations.len())..]
                .iter()
                .any(|e| e.provenance == "render")
            {
                return Err(BenchmarkError::new(
                    "validation",
                    a.reason
                        .clone()
                        .unwrap_or_else(|| "No judge panel could be assembled".into()),
                ));
            }
        } else {
            a.outcome = Some(e.verdict.clone());
            a.evaluations.push(e);
        }
        self.store.save_attempt(&a).await?;
        Ok(a)
    }
    /// Publishes a definition's draft. A version that changes only the
    /// evaluator carries the cells of the newest one: an objective evaluator
    /// evaluates their sealed outputs again here, locally and free; a judged
    /// case keeps its panels' scores until the operator asks for new judges,
    /// which costs model calls.
    pub async fn publish_version(&self, id: &str, revision: i64) -> Result<BenchmarkVersion> {
        let version = self.store.publish(id, revision).await?;
        if version.carries_from.is_some() && version.manifest.evaluator.kind != "rubric" {
            self.evaluate_carried(&version).await?;
        }
        self.changed().await;
        Ok(version)
    }
    /// Evaluates every settled, evaluated output of the versions `version`
    /// carries with its evaluator; returns how many it evaluated.
    async fn evaluate_carried(&self, version: &BenchmarkVersion) -> Result<usize> {
        let mut carried = Vec::new();
        let mut from = version.carries_from.clone();
        while let Some(id) = from {
            if carried.contains(&id) {
                break;
            }
            from = self.store.version(&id).await?.carries_from;
            carried.push(id);
        }
        let mut evaluated = 0;
        for run in self.store.all_runs().await? {
            for attempt in run
                .attempts
                .iter()
                .filter(|a| a.phase == "terminal" && carried.contains(&a.version_id))
            {
                let lock = evaluation_lock(&attempt.id);
                let _guard = lock.lock().await;
                // Budget failures, cancellations, exclusions and retired
                // repetitions keep their recorded outcome, as in a rescore.
                let evaluated_before = matches!(
                    self.store.stored_outcome(&attempt.id).await?.as_deref(),
                    Some("pass" | "fail" | "completed" | "evaluation_error")
                );
                let step = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM workflow_steps WHERE attempt_id=?",
                )
                .bind(&attempt.id)
                .fetch_one(&self.store.pool)
                .await?
                    != 0;
                if !evaluated_before || step {
                    continue;
                }
                let mut a = self.store.attempt(&attempt.id).await?;
                let Some(output) = a.output.clone() else {
                    continue;
                };
                match runner::evaluate(&version.manifest, &output).await {
                    Ok(mut e) => {
                        e.details = Some(serde_json::json!({ "carriedTo": version.id }));
                        a.outcome = Some(e.verdict.clone());
                        a.evaluations.push(e);
                    }
                    Err(error) => {
                        a.outcome = Some("evaluation_error".into());
                        a.reason = Some(error.message);
                    }
                }
                self.store.save_attempt(&a).await?;
                evaluated += 1;
            }
        }
        Ok(evaluated)
    }
    /// Freezes every live training/evaluation test's newest published version,
    /// named `name` or the next `vN`. A release that would repeat the newest
    /// one is refused: nothing in the pool changed.
    pub async fn create_release(&self, name: Option<String>) -> Result<PoolRelease> {
        let data = self.query_data().await?;
        let version_ids: Vec<String> = analysis::live_versions(&data, None)
            .into_iter()
            .filter(|version| analysis::is_ranked_split(&version.manifest.split))
            .map(|version| version.id.clone())
            .collect();
        if version_ids.is_empty() {
            return Err(BenchmarkError::new(
                "validation",
                "Publish a training or held-out test before releasing the pool",
            ));
        }
        if let Some(newest) = analysis::release_at(&data, None) {
            // A version that only re-evaluates a frozen one is no change.
            let carried = analysis::carried_versions(&data.versions);
            let mut frozen: Vec<String> = newest
                .version_ids
                .iter()
                .map(|id| carried.get(id).unwrap_or(id).clone())
                .collect();
            frozen.sort();
            if frozen == version_ids {
                return Err(BenchmarkError::new(
                    "validation",
                    format!("The pool has not changed since {}", newest.name),
                ));
            }
        }
        let name = name
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("v{}", data.releases.len() + 1));
        if name.chars().count() > 40 || data.releases.iter().any(|r| r.name == name) {
            return Err(BenchmarkError::new(
                "validation",
                "A release needs a new name of at most 40 characters",
            ));
        }
        let release = PoolRelease {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            created_at: now(),
            version_ids,
        };
        self.store.save_release(&release).await?;
        self.changed().await;
        Ok(release)
    }
    pub async fn save_schedule(&self, mut schedule: Schedule) -> Result<Schedule> {
        campaigns::validate(&schedule)?;
        if let Some(existing) = self
            .store
            .schedules()
            .await?
            .iter()
            .find(|s| s.id == schedule.id)
        {
            schedule.generated_run_ids = existing.generated_run_ids.clone();
        }
        if schedule.id.is_empty() {
            schedule.id = uuid::Uuid::new_v4().to_string();
        }
        if schedule.name.trim().is_empty()
            || schedule.interval_minutes < 5
            || schedule.interval_minutes > 525600
        {
            return Err(BenchmarkError::new(
                "validation",
                "Schedule requires a name and an interval of 5 minutes to one year",
            ));
        }
        let preview = self.preview_run(&schedule.request).await?;
        if !preview.valid {
            return Err(BenchmarkError::new("validation", preview.issues.join("; ")));
        }
        if schedule.enabled && schedule.next_due_at < now() {
            return Err(BenchmarkError::new(
                "validation",
                "Select a future due time; missed work is not replayed",
            ));
        }
        campaigns::save_user_edit(self, &mut schedule).await?;
        self.wake.notify_one();
        Ok(schedule)
    }
    async fn seed(&self) -> Result<()> {
        if !self.store.definitions().await?.is_empty() {
            return Ok(());
        }
        for draft in runner::seed_definitions() {
            let protected = matches!(draft.evaluator.kind.as_str(), "javascript" | "browser");
            let def = self.store.save_draft(None, None, draft).await?;
            if !protected || worker::available() {
                self.store.publish(&def.id, def.draft_revision).await?;
            }
        }
        Ok(())
    }
}
