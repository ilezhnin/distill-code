pub mod analysis;
pub mod campaigns;
pub mod catalog;
pub mod evaluation;
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

use std::sync::Arc;
use store::{event, now, Store};
use tauri::Manager;
use tokio::sync::{Mutex, Notify, OnceCell};
use types::*;

const MATRIX_ORDER_ALGORITHM: &str = "sha256-cell-order-v1";

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
                        Arc::new(runner::NativeBackend { app: app.clone() })
                    };
                let service = Arc::new(BenchmarkService {
                    store,
                    backend,
                    wake: Notify::new(),
                    active: Mutex::new(None),
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
    pub active: Mutex<Option<(String, tokio::sync::watch::Sender<bool>)>>,
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
        let runs = self.store.all_runs().await?;
        let attempts = runs.iter().flat_map(|r| r.attempts.clone()).collect();
        Ok(QueryData {
            definitions,
            versions,
            runs,
            attempts,
        })
    }
    pub async fn preview_run(&self, request: &RunRequest) -> Result<RunPreview> {
        let mut issues = Vec::new();
        let mut case_turns = 0usize;
        for id in &request.version_ids {
            case_turns = case_turns.saturating_add(
                self.store
                    .version(id)
                    .await?
                    .manifest
                    .workflow
                    .as_ref()
                    .map(|w| w.steps.len())
                    .unwrap_or(1),
            );
        }
        let count = case_turns
            .checked_mul(request.configurations.len())
            .and_then(|v| v.checked_mul(request.repetitions as usize))
            .unwrap_or(usize::MAX);
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
        if request.timeout_seconds == 0 || request.timeout_seconds > 3600 {
            issues.push("Run timeout must be between 1 and 3600 seconds".into());
        }
        let mut ids = std::collections::HashSet::new();
        for v in &request.version_ids {
            if !ids.insert(v) {
                issues.push("Duplicate version in matrix".into());
            }
        }
        let mut ids = std::collections::HashSet::new();
        for c in &request.configurations {
            if !ids.insert(&c.id) {
                issues.push("Duplicate configuration ID in matrix".into());
            }
            if c.id.is_empty() || c.model_id.is_empty() || c.provider_id.is_empty() {
                issues.push("Configuration requires ID, provider and model".into());
            }
        }
        let mut profiles = std::collections::HashSet::new();
        for id in &request.version_ids {
            let version = self.store.version(id).await?;
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
        Ok(RunPreview{valid:issues.is_empty(),issues,execution_count:count.min(u32::MAX as usize) as u32,estimated_cost:None,cost_reason:"Provider does not expose a binding spend estimate; explicit task and time limits apply".into()})
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
        let cells = randomized_matrix(&request)?;
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
            if let Some((run_id, signal)) = self.active.lock().await.as_ref() {
                if run_id == id {
                    let _ = signal.send(true);
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
            if run.state != "completed"
                || run.attempts.iter().any(|a| {
                    a.phase != "terminal"
                        || !matches!(
                            a.outcome.as_deref(),
                            Some("pass" | "fail" | "budget_timeout" | "budget_reached")
                        )
                })
            {
                return Err(BenchmarkError::new("validation","An official baseline requires a completed matrix with all quality outcomes observed"));
            }
            snapshots.extend(run.attempts);
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
        });
        if !visual {
            a.outcome = Some(if score == 1.0 { "pass" } else { "fail" }.into());
        }
        self.store.save_attempt(&a).await?;
        Ok(a)
    }
    pub async fn rescore(&self, id: &str) -> Result<Attempt> {
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
        let v = self.store.version(&a.version_id).await?;
        let output = a.output.as_deref().ok_or_else(|| {
            BenchmarkError::new("evidence_missing", "Attempt has no sealed output")
        })?;
        let e = runner::evaluate(&v.manifest, output).await?;
        // A creative brief goes back to the judge panel; its objective verdict
        // ("review required") is already on record and says nothing new.
        if v.manifest.evaluator.kind == "rubric" {
            a = self.backend.judge(&self.store, a, &v).await?;
        } else {
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
