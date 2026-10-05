pub mod analysis;
pub mod campaigns;
pub mod catalog;
pub mod effort;
pub mod evaluation;
pub mod evidence;
pub mod export;
pub mod fixtures;
pub mod generated;
pub mod model_catalog;
pub mod routing;
pub mod runner;
pub mod seeds;
pub mod store;
pub mod types;
pub mod usage;
pub mod worker;
pub mod workflow;

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, OnceLock, Weak};
use store::{event, now, Store};
use tauri::Manager;
use tokio::sync::{Mutex, Notify, OnceCell};
use types::*;

const MATRIX_ORDER_ALGORITHM: &str = "sha256-cell-order-v1";
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
        let versions = definitions
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
        let attempts = runs.iter().flat_map(|r| r.attempts.clone()).collect();
        // Every analysis reads this data, so a measurement of an unknown
        // effort is left out of all of them alike, and an attempt its event
        // record stopped is unscored in all of them alike; the store keeps
        // both as they settled.
        Ok(evidence::with_answer_caps(effort::with_known_effort(
            QueryData {
                definitions,
                versions,
                runs,
                attempts,
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
        // Judge turns share the measured provider, so they cannot sit inside a quota sample.
        if versions.iter().any(|v| {
            v.manifest.evaluator.kind == "rubric"
                && !runner::rubric_criteria(&v.manifest).is_empty()
                && v.manifest.measurement_profile != "task_metrics"
        }) {
            issues.push("Judged creative briefs support task metrics only".into());
        }
        // A pinned runtime that changed since selection would fail every cell.
        let mut runtimes: HashMap<(String, Option<String>), Vec<InventoryModel>> = HashMap::new();
        for c in &request.configurations {
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
            let model = runtimes[&key]
                .iter()
                .find(|m| m.configuration.model_id == c.model_id);
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
        let mut profiles = std::collections::HashSet::new();
        for version in &versions {
            fixtures::verify_blob(&self.store.root, &version.content_hash, &version.manifest)
                .await?;
            profiles.insert(version.manifest.measurement_profile.clone());
            for config in &request.configurations {
                if let Some(reason) = self.backend.unsupported(config, &version.manifest) {
                    issues.push(reason);
                }
            }
        }
        if profiles.len() > 1 {
            issues.push("A run must use one measurement profile".into());
        }
        if profiles.iter().any(|p| p != "task_metrics") && request.configurations.len() != 1 {
            issues.push(
                "Controlled quota and capacity batches require exactly one configuration".into(),
            );
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
            let attempt = Attempt {
                id: uuid::Uuid::new_v4().to_string(),
                run_id: id.clone(),
                version_id: version.clone(),
                configuration: config.clone(),
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
            };
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,?,'pending',?)").bind(&attempt.id).bind(&id).bind(&version).bind(&config.id).bind(repetition as i64).bind(serde_json::to_string(&attempt)?).execute(&mut *tx).await?;
        }
        event(&mut tx, &id, "run_created").await?;
        tx.commit().await?;
        self.wake.notify_one();
        self.changed().await;
        self.store.run(&id).await
    }
    pub async fn control(&self, id: &str, action: &str) -> Result<BenchmarkRun> {
        let run = self.store.run(id).await?;
        if action == "resume"
            && run.attempts.iter().any(|a| {
                matches!(
                    a.outcome.as_deref(),
                    Some("dispatch_uncertain" | "interrupted")
                )
            })
        {
            return Err(BenchmarkError::new(
                "dispatch_uncertain",
                "Uncertain execution requires inspection and a separately requested new run",
            ));
        }
        let next = match (action, run.state.as_str()) {
            ("pause", "running") => "pausing",
            ("pause", "pausing" | "paused") => return Ok(run),
            ("resume", "paused" | "needs_attention") => "running",
            ("resume", "running") => return Ok(run),
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
    pub async fn create_baseline(
        &self,
        name: String,
        run_ids: Vec<String>,
        threshold: f64,
    ) -> Result<Baseline> {
        if name.trim().is_empty()
            || run_ids.is_empty()
            || !threshold.is_finite()
            || !(0.0..=1.0).contains(&threshold)
        {
            return Err(BenchmarkError::new(
                "validation",
                "Baseline needs a name, runs and a threshold from 0 to 1",
            ));
        }
        let mut snapshots = Vec::new();
        let mut run_conditions = Vec::new();
        for id in &run_ids {
            let run = self.store.run(id).await?;
            if run.request.preview {
                return Err(BenchmarkError::new(
                    "validation",
                    "Development previews cannot become official baselines",
                ));
            }
            // Cells settled as excluded (authored by their candidate) were never owed.
            let owed: Vec<Attempt> = run
                .attempts
                .into_iter()
                .filter(|a| a.outcome.as_deref() != Some("excluded"))
                .collect();
            if run.state != "completed"
                || owed
                    .iter()
                    .any(|a| a.phase != "terminal" || analysis::score(a).is_none())
            {
                return Err(BenchmarkError::new("validation","An official baseline requires a completed matrix with all quality outcomes observed"));
            }
            snapshots.extend(owed);
            run_conditions.push(run.request);
        }
        let baseline = Baseline {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            run_ids,
            created_at: now(),
            threshold,
            snapshots,
            run_conditions,
        };
        // One follow-up run reproduces one protocol per configuration, so a
        // configuration frozen under two could never be compared.
        if analysis::frozen_conditions(&baseline)
            .values()
            .any(|conditions| conditions.len() > 1)
        {
            return Err(BenchmarkError::new(
                "validation",
                "Each configuration in a baseline needs the same repetitions and timeout in all its runs",
            ));
        }
        let mut tx = self.store.pool.begin().await?;
        sqlx::query("INSERT INTO baselines(id,data_json) VALUES(?,?)")
            .bind(&baseline.id)
            .bind(serde_json::to_string(&baseline)?)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, &baseline.id, "baseline_created").await?;
        tx.commit().await?;
        Ok(baseline)
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
