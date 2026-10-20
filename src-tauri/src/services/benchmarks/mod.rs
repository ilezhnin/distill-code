pub mod analysis;
pub mod artifact_context;
pub mod campaigns;
pub mod catalog;
pub mod credits;
pub mod data_use;
pub mod effort;
pub mod evaluation;
pub mod evidence;
pub mod executor;
pub mod export;
pub mod fixtures;
pub mod flights;
pub mod generated;
pub mod home_advantage;
mod judge_checks;
mod judge_panel;
pub mod judge_pool;
pub mod learned;
pub mod model_catalog;
pub mod promotion;
pub mod qualification;
pub mod repository;
pub mod routing;
pub mod runner;
pub mod seeds;
pub mod selector;
pub mod store;
pub mod task_execution;
pub mod types;
pub mod worker;
pub mod workflow;
pub mod workflow_campaign;
pub mod workflow_policy;

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, OnceLock, Weak};
use store::{event, now, Store};
use tauri::Manager;
use tokio::sync::{Mutex, Notify, OnceCell};
use types::*;

const MATRIX_ORDER_ALGORITHM: &str = "sha256-cell-order-v1";
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
    draft.workflow.as_ref().map_or(1, |w| w.steps.len()) + judge_execution_count(draft)
}

pub(super) fn judge_execution_count(draft: &BenchmarkDraft) -> usize {
    if draft.evaluator.kind != "rubric" {
        return 0;
    }
    judge_panel::frozen(draft, &[])
        .ok()
        .flatten()
        .map_or(runner::MAX_JUDGES, |panel| panel.len())
}

/// Whether `configuration` runs `case` at all: a repository case runs only on
/// a protected_repository configuration and a bounded text case only on a
/// native_text one, so one run of a model carries one configuration per
/// profile and pairs each case with its own. Other profiles pair as before.
fn fits(case: &BenchmarkDraft, configuration: &Configuration) -> bool {
    match configuration.execution_profile.as_str() {
        "native_text" => !repository::is_repository_case(case),
        "protected_repository" => repository::is_repository_case(case),
        _ => true,
    }
}

/// A plan owes every cell of a case on a configuration that runs it, its
/// candidate's own cases included, unless it was admitted before author
/// cells were measured: such a plan never owed the cases its candidate
/// helped write.
fn owed(request: &RunRequest, version: &BenchmarkVersion, configuration: &Configuration) -> bool {
    fits(&version.manifest, configuration)
        && (request.measures_author_cells()
            || !routing::authored_by_candidate(&version.manifest, configuration))
}

/// The cells a plan creates, in its seeded order: every repetition of every
/// owed pair, so each case runs only on the configuration of its profile.
fn planned_cells(
    request: &RunRequest,
    versions: &[BenchmarkVersion],
) -> Result<Vec<(String, Configuration, u32)>> {
    let by_id: HashMap<&str, &BenchmarkVersion> =
        versions.iter().map(|v| (v.id.as_str(), v)).collect();
    Ok(randomized_matrix(request)?
        .into_iter()
        .filter(|(version, configuration, _)| {
            by_id
                .get(version.as_str())
                .is_some_and(|v| owed(request, v, configuration))
        })
        .collect())
}

/// The cases no configuration of their profile can run, named for the operator.
fn profile_gaps(versions: &[BenchmarkVersion], configurations: &[Configuration]) -> Vec<String> {
    versions
        .iter()
        .filter(|v| !configurations.iter().any(|c| fits(&v.manifest, c)))
        .map(|v| {
            format!(
                "{}: add the {} configuration of this model to run this case",
                v.manifest.name,
                if repository::is_repository_case(&v.manifest) {
                    "repository"
                } else {
                    "native text"
                }
            )
        })
        .collect()
}

/// `request` with `joining` added: the same model on execution profiles the
/// run does not have yet, so cases of those profiles can join it.
fn join_configurations(request: &RunRequest, joining: &[Configuration]) -> Result<RunRequest> {
    let mut joined = request.clone();
    for configuration in joining {
        let same_model = request.configurations.iter().any(|c| {
            c.provider_id == configuration.provider_id
                && c.account_id == configuration.account_id
                && c.model_id == configuration.model_id
                && c.effort == configuration.effort
                && c.fast_mode.unwrap_or(false) == configuration.fast_mode.unwrap_or(false)
        });
        let taken = joined.configurations.iter().any(|c| {
            c.execution_profile == configuration.execution_profile || c.id == configuration.id
        });
        if !same_model || taken {
            return Err(BenchmarkError::new(
                "validation",
                "A run takes another configuration only for the same model on an execution profile it does not have yet",
            ));
        }
        joined.configurations.push(configuration.clone());
    }
    Ok(joined)
}

/// Executions a plan owes: every owed cell's turns and judge reservation, per repetition.
fn owed_executions(versions: &[BenchmarkVersion], request: &RunRequest) -> usize {
    let mut turns = 0usize;
    for version in versions {
        for configuration in &request.configurations {
            if owed(request, version, configuration) {
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
        pre_answer_refusals: 0,
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
        native_execution_ms: None,
        resolved_model: None,
        repository_result: None,
        collection_context: None,
        sandbox_admission: None,
        account_load: None,
        phase_times: None,
        credit_use: None,
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
impl BenchmarkService {
    pub async fn changed(&self) {
        notify_changed(&self.store, self.app.as_ref()).await;
    }
    /// What every analysis reads. Views asking at once share one load, and
    /// none overlaps another (see [`flights::Flights`]).
    pub async fn query_data(&self) -> Result<Arc<QueryData>> {
        self.queries
            .share("query-data", || self.load_query_data())
            .await
    }
    async fn load_query_data(&self) -> Result<QueryData> {
        // Analyses read a definition's archive state only; its draft stays in
        // the store, and published manifests come parsed from the store.
        let definitions = self.store.definition_states().await?;
        let versions = self.store.all_versions().await?;
        let mut runs = self.store.all_runs().await?;
        // A mixed-worker trajectory is not a measurement of its root column
        // or of any one of its workers. Raw run/attempt views retain it.
        runs.retain(|run| run.request.workflow_policy.is_none());
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
        let request = &request.clone().with_current_author_policy();
        self.store
            .require_current_versions(&request.version_ids)
            .await?;
        let mut issues = Vec::new();
        let mut versions = Vec::new();
        for id in &request.version_ids {
            versions.push(self.store.version(id).await?);
        }
        let count = owed_executions(&versions, request);
        if let Some(policy) = &request.workflow_policy {
            policy.validate(self, request, &versions).await?;
        } else if request
            .configurations
            .iter()
            .any(|c| c.execution_profile == "workflow_policy")
        {
            return Err(BenchmarkError::new(
                "validation",
                "A workflow policy column requires its frozen policy",
            ));
        }
        let workers = request
            .workflow_policy
            .as_ref()
            .map(|policy| &policy.candidates)
            .unwrap_or(&request.configurations);
        if request
            .author_policy
            .as_deref()
            .is_some_and(|policy| policy != AUTHOR_CELLS_MEASURED)
        {
            issues.push("Unknown author-cell policy".into());
        }
        if !versions.is_empty()
            && request
                .configurations
                .iter()
                .any(|c| !versions.iter().any(|v| owed(request, v, c)))
        {
            issues.push(
                "A configuration owes none of the selected cases: its candidate authored them, or they run on another execution profile".into(),
            );
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
        for c in workers {
            // Research policies retain unavailable alternatives in their frozen
            // pool; each step checks admission and records its feasible subset.
            if request.workflow_policy.is_some() {
                continue;
            }
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
            // Only the pairs the run plans are checked.
            for config in workers.iter().filter(|c| fits(&version.manifest, c)) {
                if let Some(reason) = self.backend.unsupported(config, &version.manifest) {
                    issues.push(reason);
                }
            }
        }
        // A case no configuration of its profile runs is named once.
        issues.extend(profile_gaps(&versions, workers));
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
        // once, before the request is compared with a saved plan: unless the
        // operator set a number, as many as the account's pace and the
        // sandbox admit.
        let mut request = request.with_current_author_policy();
        request.parallelism.get_or_insert(runner::AS_ADMITTED);
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
        request.require_dispatch_admission(now())?;
        if !preview.valid {
            return Err(BenchmarkError::new(
                "capability_missing",
                preview.issues.join("; "),
            ));
        }
        let replaced =
            if let Some(previous_id) = replace_run_id {
                let previous = self.store.run(previous_id).await?;
                self.store
                    .require_independent_run(&previous.request.request_key)
                    .await?;
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
        // Only a plan admitted before author cells were measured leaves the
        // cases its candidate wrote out, and no plan pairs a case with a
        // configuration of another execution profile.
        let cells = planned_cells(&request, &versions)?;
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
        Store::require_current_versions_in(&mut tx, &request.version_ids).await?;
        workflow_campaign::check_admission(&mut tx, &request).await?;
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
    /// A case short of its repetitions keeps the ones it measured and owes
    /// only the rest: the cell is the run's, across pauses and stops; a
    /// complete case, passed or failed, stands. A test the app restarted under was settled as uncertain and
    /// is measured again as a new attempt, never under its own key. Once the
    /// window closed the run is final and nothing resumes it.
    pub async fn control(&self, id: &str, action: &str) -> Result<BenchmarkRun> {
        let run = self.store.run(id).await?;
        self.store
            .require_independent_run(&run.request.request_key)
            .await?;
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
                if !unfinished && !run.request.automatic_retry() {
                    return Err(BenchmarkError::new(
                        "retry_forbidden",
                        "This run forbids replacement attempts; its existing receipts remain final",
                    ));
                }
                if !unfinished && matches!(run.state.as_str(), "completed" | "cancelled") {
                    return Err(BenchmarkError::new(
                        "validation",
                        "Every case of this run is complete",
                    ));
                }
                // The operator's resume asks every waiting account again.
                runner::forget_quota_waits(id);
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
    /// complete, it stands. A run admitted before author cells were measured
    /// leaves out a case a configuration authored. With no cases to add this
    /// is a resume.
    /// Sets how many attempts of a configuration a run inside its window
    /// flies at once from now on, as the operator asks. The request records
    /// the newest setting, so a run that changed it notes the last one.
    /// `parallelism` 0 lets the account's pace and the sandbox decide
    /// ([`runner::AS_ADMITTED`]); any other number bounds the configuration.
    pub async fn set_parallelism(&self, id: &str, parallelism: u32) -> Result<BenchmarkRun> {
        let run = self.store.run(id).await?;
        if run.request.workflow_policy.is_some() && parallelism != 1 {
            return Err(BenchmarkError::new(
                "validation",
                "Research workflow policy conditions are frozen",
            ));
        }
        self.store
            .require_independent_run(&run.request.request_key)
            .await?;
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
    /// `joining` adds the configuration of another execution profile of the
    /// same model, for added cases no configuration of the run can run: a
    /// repository case joining a run of text cases, or the reverse.
    pub async fn extend_run(
        &self,
        id: &str,
        version_ids: &[String],
        joining: &[Configuration],
    ) -> Result<BenchmarkRun> {
        let run = self.store.run(id).await?;
        self.store
            .require_current_versions(&run.request.version_ids)
            .await?;
        self.store.require_current_versions(version_ids).await?;
        if !run.request.automatic_retry() {
            return Err(BenchmarkError::new(
                "retry_forbidden",
                "A run without retries has a fixed attempt plan; create a separate run to add cases",
            ));
        }
        if run.request.workflow_policy.is_some() {
            return Err(BenchmarkError::new(
                "validation",
                "Research workflow cases are frozen; use explicit resume to continue",
            ));
        }
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
        let mut request = join_configurations(&run.request, joining)?;
        // Nothing changes until every added case has a configuration of its
        // own profile.
        let mut added = Vec::new();
        for version_id in version_ids {
            added.push(self.store.version(version_id).await?);
        }
        if let Some(gap) = profile_gaps(&added, &request.configurations)
            .into_iter()
            .next()
        {
            return Err(BenchmarkError::new("validation", gap));
        }
        if request.configurations.len() != run.request.configurations.len() {
            self.store.set_run_request(id, &request).await?;
        }
        for version_id in version_ids {
            let version = self.store.version(version_id).await?;
            for configuration in &request.configurations {
                if planned.contains(&(version.id.clone(), configuration.id.clone()))
                    || !owed(&request, &version, configuration)
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
        if request.version_ids != run.request.version_ids
            || request.configurations.len() != run.request.configurations.len()
        {
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
            // A stopped run going on again asks every waiting account again;
            // one still running keeps what its turns learned.
            runner::forget_quota_waits(id);
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
        self.store
            .require_current_versions(&run.request.version_ids)
            .await?;
        run.request.require_dispatch_admission(now())?;
        if !run.request.automatic_retry() {
            // Resume may finish original, never-started slots. It must not
            // supersede receipts or enlarge the admitted execution plan.
            return Ok(run.attempts.iter().any(|attempt| {
                attempt.phase == "pending"
                    && attempt.started_at.is_none()
                    && attempt.session_id.is_none()
                    && attempt.host_run_id.is_none()
                    && attempt.workflow_steps.is_empty()
            }));
        }
        let planned = run.request.repetitions.max(1);
        let mut unfinished = false;
        // A rendering whose panel a stop cut short keeps its sealed answer:
        // it goes back to its judges instead of being measured again.
        for attempt in &run.attempts {
            if attempt.phase == "terminal"
                && attempt.reason.as_deref() == Some(runner::JUDGING_STOPPED)
                && attempt.outcome.as_deref() == Some("pending_review")
                && analysis::score(attempt).is_none()
            {
                let mut waiting = attempt.clone();
                waiting.phase = runner::AWAITING_JUDGES.into();
                waiting.reason = None;
                self.store.save_attempt(&waiting).await?;
                unfinished = true;
            }
        }
        let run = &self.store.run(&run.id).await?;
        for (_, attempts) in analysis::run_cells(run) {
            let measured = attempts.iter().filter(|a| analysis::is_measured(a)).count() as u32;
            if measured >= planned || never_measured(&attempts) {
                continue;
            }
            unfinished = true;
            for attempt in attempts {
                // A queued repetition runs as planned. A measured one, scored
                // or awaiting its verdict, stands: the cell belongs to the
                // run, not to a sitting, so only a cancelled, failed or
                // unscored repetition is measured again.
                if attempt.phase != "terminal"
                    || analysis::is_measured(&attempt)
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
                    "Measured again on resume: {measured} of {planned} repetitions were measured when the run stopped (this one: {})",
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
        self.store
            .require_current_versions(std::slice::from_ref(&a.version_id))
            .await?;
        self.store
            .require_independent_run(&self.store.run(&a.run_id).await?.request.request_key)
            .await?;
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
        self.store
            .require_current_versions(std::slice::from_ref(&a.version_id))
            .await?;
        if a.phase != "terminal" {
            return Err(BenchmarkError::new(
                "validation",
                "Only a finished attempt can be rescored",
            ));
        }
        self.store
            .require_independent_run(&self.store.run(&a.run_id).await?.request.request_key)
            .await?;
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
    /// Publishes a new immutable version without changing earlier results.
    pub async fn publish_version(&self, id: &str, revision: i64) -> Result<BenchmarkVersion> {
        let version = self.store.publish(id, revision).await?;
        self.changed().await;
        Ok(version)
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
        if self.store.has_definitions().await? {
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
