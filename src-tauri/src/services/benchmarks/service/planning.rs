//! From a request to a run: what it owes, in which order, its preview, its start, and what joins or restarts later.
use super::*;

pub(in super::super) const MATRIX_ORDER_ALGORITHM: &str = "sha256-cell-order-v1";

pub(in crate::services) fn execution_count(draft: &BenchmarkDraft) -> usize {
    draft.workflow.as_ref().map_or(1, |w| w.steps.len()) + judge_execution_count(draft)
}

pub(in crate::services) fn judge_execution_count(draft: &BenchmarkDraft) -> usize {
    if draft.evaluator.kind != "rubric" {
        return 0;
    }
    judge_panel::frozen(draft, &[])
        .ok()
        .flatten()
        .map_or(MAX_JUDGES, |panel| panel.len())
}

/// Whether `configuration` runs `case` at all: a repository case runs only on
/// a protected_repository configuration and a bounded text case only on a
/// native_text one, so one run of a model carries one configuration per
/// profile and pairs each case with its own. Other profiles pair as before.
pub(in crate::services) fn fits(case: &BenchmarkDraft, configuration: &Configuration) -> bool {
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
pub(in super::super) fn owed(
    request: &RunRequest,
    version: &BenchmarkVersion,
    configuration: &Configuration,
) -> bool {
    fits(&version.manifest, configuration)
        && (request.measures_author_cells()
            || !routing::authored_by_candidate(&version.manifest, configuration))
}

/// The cells a plan creates, in its seeded order: every repetition of every
/// owed pair, so each case runs only on the configuration of its profile.
pub(in super::super) fn planned_cells(
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
pub(in super::super) fn profile_gaps(
    versions: &[BenchmarkVersion],
    configurations: &[Configuration],
) -> Vec<String> {
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
pub(in super::super) fn join_configurations(
    request: &RunRequest,
    joining: &[Configuration],
) -> Result<RunRequest> {
    let mut joined = request.clone();
    for configuration in joining {
        // The same model, effort and fast mode; the account may differ, as
        // a row names the account of its newest attempt and accounts of one
        // provider are quota pools of the same model.
        let same_model = request.configurations.iter().any(|c| {
            c.provider_id == configuration.provider_id
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
pub(in super::super) fn owed_executions(
    versions: &[BenchmarkVersion],
    request: &RunRequest,
) -> usize {
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
pub(in super::super) fn pending_attempt(
    run_id: &str,
    version_id: &str,
    configuration: &Configuration,
    repetition: u32,
) -> Attempt {
    Attempt {
        pre_answer_refusals: 0,
        infrastructure_retries: 0,
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
        activity: Some(AttemptActivity {
            recorded_from: now(),
            complete: true,
            spans: vec![ActivitySpan {
                kind: ActivityKind::Waiting,
                started_at: now(),
                finished_at: None,
            }],
        }),
        credit_use: None,
    }
}

/// A cell the run never measured and never will: no repetition to restart or drop.
/// Whether resuming its run checks `attempt`'s sealed answer again instead of
/// measuring the case anew: its turn finished and was sealed, and its check
/// ended without a verdict (the sandbox failed, the evaluator did, or the run
/// stopped while the check waited). The answer is paid for; only the check is
/// owed.
pub(in super::super) fn rechecked_on_resume(attempt: &Attempt) -> bool {
    attempt.phase == "terminal"
        && attempt.outcome.as_deref() == Some("evaluation_error")
        && attempt.evidence_hash.is_some()
        && attempt.workflow_steps.is_empty()
}

pub(in super::super) fn never_measured(attempts: &[Attempt]) -> bool {
    attempts
        .iter()
        .all(|a| matches!(a.outcome.as_deref(), Some("excluded" | "unsupported")))
}

pub(in super::super) fn window_closed_message(run: &BenchmarkRun) -> String {
    let closed = chrono::DateTime::from_timestamp_millis(analysis::window_closes(run))
        .map(|at| at.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_default();
    format!("The run's 24-hour window closed at {closed}; its results are final. Start a new run.")
}

pub(in super::super) fn matrix_order_seed(request_key: &str) -> String {
    fixtures::hash(format!("{MATRIX_ORDER_ALGORITHM}\0{request_key}").as_bytes())
}

pub(in super::super) fn randomized_matrix(
    request: &RunRequest,
) -> Result<Vec<(String, Configuration, u32)>> {
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

impl BenchmarkService {
    /// Executions a saved plan owes, read from the stored manifests alone.
    pub(in crate::services) async fn planned_executions(
        &self,
        request: &RunRequest,
    ) -> Result<usize> {
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
            || count > request.max_executions as usize
        {
            issues.push("Select cases and configurations within the explicit execution budget, with 1 to 100 repetitions".into());
        }
        if request.timeout_seconds == 0 || request.timeout_seconds > MAX_TIME_LIMIT_SECONDS {
            issues.push(format!(
                "Run time limit must be between 1 and {MAX_TIME_LIMIT_SECONDS} seconds"
            ));
        }
        // A sandbox test signs in with a lease of the app's grant, which must
        // outlast it: a limit no fresh grant covers would never start.
        let mut too_long = std::collections::BTreeSet::new();
        for c in workers {
            if let Some(provider) =
                crate::services::agent_host::execution::NativeProvider::for_harness(&c.provider_id)
                    .filter(|provider| crate::services::credential_lease::leased(*provider))
                    .filter(|provider| {
                        matches!(
                            c.execution_profile.as_str(),
                            "native_text" | "protected_repository"
                        ) && !crate::services::credential_lease::fresh_grant_covers(
                            *provider,
                            request.timeout_seconds,
                        )
                    })
            {
                too_long.insert(provider.key());
            }
        }
        for provider in too_long {
            issues.push(format!(
                "The time limit is longer than a {provider} sign-in lasts, so its tests could never start; choose a shorter time limit"
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

    /// What keeps `configuration` from joining a run of `cases`, as the
    /// preview checks a Start: fast mode, readiness, its pin against today's
    /// inventory row and the backend's support for each case it runs.
    pub(in super::super) async fn joining_issues(
        &self,
        configuration: &Configuration,
        cases: &[BenchmarkVersion],
    ) -> Vec<String> {
        let mut issues = Vec::new();
        if configuration.fast_mode == Some(true) {
            issues
                .push("Benchmarks never run fast mode; choose the configuration without it".into());
        }
        if let Err(error) = self.backend.readiness(configuration).await {
            issues.push(error.message);
        }
        if let Some(pinned) = configuration.inventory_revision.as_ref() {
            match self
                .backend
                .inventory(
                    &configuration.provider_id,
                    configuration.account_id.as_deref(),
                    false,
                )
                .await
            {
                Ok(models) => {
                    let model = models.iter().find(|m| {
                        m.configuration.model_id == configuration.model_id
                            && m.configuration.execution_profile == configuration.execution_profile
                    });
                    if let Some(model) = model.filter(|model| !model.available) {
                        issues.push(
                            model
                                .reason
                                .clone()
                                .unwrap_or_else(|| "Configuration is unavailable".into()),
                        );
                    }
                    if model.and_then(|m| m.configuration.inventory_revision.as_ref())
                        != Some(pinned)
                    {
                        issues.push(
                            "Runtime changed since this configuration was selected; refresh it"
                                .into(),
                        );
                    }
                }
                Err(error) => issues.push(format!(
                    "Runtime inventory is unavailable: {}",
                    error.message
                )),
            }
        }
        for case in cases.iter().filter(|v| fits(&v.manifest, configuration)) {
            if let Some(reason) = self.backend.unsupported(configuration, &case.manifest) {
                issues.push(reason);
            }
        }
        issues.sort();
        issues.dedup();
        issues
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
            .require_continuable_versions(&run.request.version_ids)
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
        // Nothing changes until every case of the run, its own and the
        // added ones, has a configuration of its profile: a run planned
        // before it carried one per profile takes the missing one now.
        let mut cases: Vec<BenchmarkVersion> = Vec::new();
        for version_id in run.request.version_ids.iter().chain(version_ids) {
            if !cases.iter().any(|v| &v.id == version_id) {
                cases.push(self.store.version(version_id).await?);
            }
        }
        if let Some(gap) = profile_gaps(&cases, &request.configurations)
            .into_iter()
            .next()
        {
            return Err(BenchmarkError::new("validation", gap));
        }
        // A joining configuration passes what a Start checks in its preview,
        // so it cannot fail its first case: the dialog may hold an
        // inventory read before a helper or CLI update.
        for configuration in joining {
            let issues = self.joining_issues(configuration, &cases).await;
            if !issues.is_empty() {
                return Err(BenchmarkError::new("capability_missing", issues.join("; ")));
            }
        }
        if request.configurations.len() != run.request.configurations.len() {
            self.store.set_run_request(id, &request).await?;
        }
        // Every case on each configuration that runs it and has no cell of it
        // yet: the added cases, and the run's own on a joining profile.
        for version in &cases {
            let version_id = &version.id;
            for configuration in &request.configurations {
                if planned.contains(&(version.id.clone(), configuration.id.clone()))
                    || !owed(&request, version, configuration)
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
                routing::persist_snapshot(&mut tx, &routing::snapshot(id, version, &request))
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
        self.refresh_run_runtime_renewing(&run).await?;
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
            runner::reset_account_waits(&self.store, &run).await?;
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
    pub(in super::super) async fn restart_unfinished_cells(
        &self,
        run: &BenchmarkRun,
    ) -> Result<bool> {
        self.store
            .require_continuable_versions(&run.request.version_ids)
            .await?;
        run.request.require_dispatch_admission(now())?;
        if !run.request.automatic_retry() {
            // Resume may finish original, never-started slots or the remaining
            // judging of a sealed answer. Neither replaces a generation or
            // supersedes receipts/enlarges the admitted execution plan.
            return Ok(run.attempts.iter().any(|attempt| {
                (attempt.phase == "pending"
                    && attempt.started_at.is_none()
                    && attempt.session_id.is_none()
                    && attempt.host_run_id.is_none()
                    && attempt.workflow_steps.is_empty())
                    || (attempt.phase == AWAITING_JUDGES
                        && attempt.outcome.as_deref() == Some("pending_review")
                        && attempt.evidence_hash.is_some())
            }));
        }
        let planned = run.request.repetitions.max(1);
        let mut unfinished = false;
        // A rendering whose panel could not settle keeps its sealed answer:
        // it goes back to its judges instead of being measured again.
        for attempt in &run.attempts {
            if attempt.phase == "terminal"
                && attempt.outcome.as_deref() == Some("pending_review")
                && analysis::score(attempt).is_none()
                && attempt.evidence_hash.is_some()
            {
                // Run summaries omit the answer; recover the full sealed
                // attempt before saving so resume never erases its output.
                let mut waiting = self.store.attempt(&attempt.id).await?;
                fixtures::restore_sealed_output(&self.store.root, &mut waiting).await?;
                waiting.phase = AWAITING_JUDGES.into();
                waiting.reason = None;
                self.store.save_attempt(&waiting).await?;
                unfinished = true;
            }
            // An answer whose check failed without a verdict keeps its sealed
            // answer as well: it is checked again, and no model is asked. One
            // whose sealed answer cannot be read is measured again below.
            if rechecked_on_resume(attempt)
                && self
                    .store
                    .version(&attempt.version_id)
                    .await?
                    .manifest
                    .workflow
                    .is_none()
            {
                let mut sealed = self.store.attempt(&attempt.id).await?;
                if fixtures::restore_sealed_output(&self.store.root, &mut sealed)
                    .await
                    .is_ok()
                {
                    sealed.phase = "interrupted".into();
                    sealed.outcome = Some("completed".into());
                    sealed.reason = None;
                    sealed.wait_until = None;
                    self.store.save_attempt(&sealed).await?;
                    unfinished = true;
                }
            }
        }
        let run = &self.store.run(&run.id).await?;
        for ((version_id, _), attempts) in analysis::run_cells(run) {
            // A cell planned on a configuration of another execution profile,
            // before a run carried one per profile, never runs: its queued
            // repetitions are set aside, and the case is measured on its own
            // profile's configuration once the run has one.
            let version = self.store.version(&version_id).await?;
            if attempts
                .first()
                .is_some_and(|a| !fits(&version.manifest, &a.configuration))
            {
                for mut queued in attempts.into_iter().filter(|a| a.phase == "pending") {
                    queued.phase = "terminal".into();
                    queued.outcome = Some(analysis::SUPERSEDED.into());
                    queued.reason = Some(
                        "Planned on a configuration of another execution profile; the case runs on its own profile's configuration".into(),
                    );
                    queued.finished_at = Some(now());
                    self.store.supersede_attempt(&queued).await?;
                }
                continue;
            }
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
                    run.request
                        .configurations
                        .iter()
                        .find(|configuration| configuration.id == attempt.configuration.id)
                        .unwrap_or(&attempt.configuration),
                    attempt.repetition,
                );
                let mut superseded = attempt;
                superseded.reason = Some(format!(
                    "Measured again on resume: {measured} of {planned} repetitions were measured when the run stopped (this one: {})",
                    superseded.outcome.as_deref().unwrap_or("unfinished")
                ));
                superseded.outcome = Some(analysis::SUPERSEDED.into());
                self.store.supersede_and_insert(&superseded, &fresh).await?;
            }
        }
        Ok(unfinished)
    }
}
