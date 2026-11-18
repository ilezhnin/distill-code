//! Pausing, resuming and cancelling a run, and taking it on to an updated runtime.
use super::*;

impl BenchmarkService {
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
                self.refresh_run_runtime_renewing(&run).await?;
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
                runner::reset_account_waits(&self.store, &run).await?;
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

    /// [`Self::refresh_run_runtime`], renewing first the sandbox check of a
    /// model that only lacks a current one, as each update of the app leaves
    /// it, so a Resume needs no separate Update sandbox check. A renewal that
    /// fails keeps the refusal, with why, for the operator.
    pub(in super::super) async fn refresh_run_runtime_renewing(
        &self,
        run: &BenchmarkRun,
    ) -> Result<()> {
        let error = match self.refresh_run_runtime(run).await {
            Err(error) if runner::stale_policy_check(&error) => error,
            refreshed => return refreshed,
        };
        let mut providers = run
            .request
            .configurations
            .iter()
            .filter(|c| c.execution_profile == "native_text")
            .map(|c| c.provider_id.as_str())
            .collect::<Vec<_>>();
        providers.sort_unstable();
        providers.dedup();
        for provider in providers {
            if let Err(renewal) = self.backend.renew_stale_policy_check(provider).await {
                return Err(BenchmarkError::new(
                    &error.code,
                    format!(
                        "{}; the sandbox check could not be renewed: {}",
                        error.message, renewal.message
                    ),
                ));
            }
        }
        self.refresh_run_runtime(run).await
    }

    /// Explicit resume may adopt an installed runtime for work not yet done.
    /// Model, account, options and paid evidence retain their original identity.
    pub(in super::super) async fn refresh_run_runtime(&self, run: &BenchmarkRun) -> Result<()> {
        if run.request.workflow_policy.is_some() || !run.request.automatic_retry() {
            return Ok(());
        }
        let mut request = run.request.clone();
        let mut changed = false;
        let mut inventories: HashMap<(String, Option<String>), Vec<InventoryModel>> =
            HashMap::new();
        for configuration in &mut request.configurations {
            let unmeasured = run.attempts.iter().any(|attempt| {
                if attempt.configuration.id != configuration.id {
                    return false;
                }
                let outcome = attempt.outcome.as_deref();
                let settled = analysis::is_measured(attempt)
                    || matches!(outcome, Some("excluded" | "unsupported" | "superseded"))
                    || (outcome == Some("pending_review") && attempt.evidence_hash.is_some());
                attempt.phase == "pending" || (attempt.phase == "terminal" && !settled)
            });
            if configuration.inventory_revision.is_none() || !unmeasured {
                continue;
            }
            let key = (
                configuration.provider_id.clone(),
                configuration.account_id.clone(),
            );
            if !inventories.contains_key(&key) {
                inventories.insert(
                    key.clone(),
                    self.backend
                        .inventory(&key.0, key.1.as_deref(), false)
                        .await?,
                );
            }
            let model = inventories[&key].iter().find(|model| {
                let current = &model.configuration;
                current.provider_id == configuration.provider_id
                    && current.account_id == configuration.account_id
                    && current.model_id == configuration.model_id
                    && current.execution_profile == configuration.execution_profile
                    && current.billing_mode == configuration.billing_mode
            }).ok_or_else(|| BenchmarkError::new("selection_changed", "The selected model and execution profile are no longer available on this account"))?;
            if configuration.inventory_revision == model.configuration.inventory_revision {
                continue;
            }
            if !model.available {
                return Err(BenchmarkError::new(
                    "capability_missing",
                    model
                        .reason
                        .clone()
                        .unwrap_or_else(|| "The selected model is unavailable".into()),
                ));
            }
            if model.configuration.inventory_revision.is_none()
                || configuration.fast_mode == Some(true) && !model.supports_fast_mode
                || configuration
                    .effort
                    .as_ref()
                    .is_some_and(|effort| !model.efforts.contains(effort))
                || effort::left_to_the_cli(configuration, model)
            {
                return Err(BenchmarkError::new(
                    "selection_changed",
                    "The installed runtime no longer supports the selected model options",
                ));
            }
            configuration.inventory_revision = model.configuration.inventory_revision.clone();
            self.backend.readiness(configuration).await?;
            changed = true;
        }
        if changed {
            self.store
                .refresh_pending_runtime(&run.id, &request)
                .await?;
        }
        Ok(())
    }
}
