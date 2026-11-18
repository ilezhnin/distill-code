//! A workflow policy step on its root's seat.
use super::*;

impl BenchmarkService {
    /// Transfer the root's existing slot to the selected worker for this turn.
    /// Synthetic policy columns must not bypass normal model/account limits.
    pub(in crate::services::benchmarks) async fn execute_workflow_policy_step(
        &self,
        root_id: &str,
        attempt: Attempt,
        version: BenchmarkVersion,
        timeout: u32,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<Attempt> {
        let mut request = self.store.run(&attempt.run_id).await?.request;
        let concurrency = self
            .store
            .workflow_campaign_concurrency(&request.request_key)
            .await?;
        let concurrent = concurrency.concurrent();
        if concurrent {
            request.parallelism = Some(concurrency.lane_parallelism());
        }
        let lane_slots = attempts_at_once(&request, &attempt.configuration) as usize;
        let account_slots = account_slots_within(
            &attempt.run_id,
            &quota_scope(&attempt.configuration),
            concurrency.account_slots,
        );
        let budget = if concurrent {
            Some(collection_budget(&version.manifest)?.ok_or_else(|| {
                BenchmarkError::new(
                    "budget_clock_conflict",
                    "Concurrent workflow step has no root wall deadline",
                )
            })?)
        } else {
            None
        };
        let lane = crate::services::benchmarks::analysis::configuration_key(&attempt.configuration);
        let account = format!(
            "{}\u{1f}{}",
            attempt.configuration.provider_id,
            attempt
                .configuration
                .account_id
                .as_deref()
                .unwrap_or_default()
        );
        let previous = loop {
            if *cancel.borrow()
                || matches!(
                    self.store.run_state(&attempt.run_id).await?.as_str(),
                    "cancelling" | "cancelled"
                )
            {
                return Err(BenchmarkError::new(
                    "cancelled",
                    "Workflow cancelled while awaiting a worker slot",
                ));
            }
            request.require_dispatch_admission(now())?;
            if let Some(budget) = &budget {
                budget.remaining_ms(now())?;
            }
            let mut active = self.active.lock().await;
            if let Some(root) = active.get(root_id).filter(|root| !root.workers.is_empty()) {
                if !root
                    .workers
                    .iter()
                    .any(|worker| worker.lane == lane && worker.account == account)
                {
                    return Err(BenchmarkError::new(
                        "worker_reservation_conflict",
                        "Selected worker is outside the admitted workflow reservation",
                    ));
                }
                // The root owns this capacity until both steps and collection
                // finish. A newer root cannot take its next step's slot.
                let root = active
                    .get_mut(root_id)
                    .expect("checked workflow reservation");
                break (
                    std::mem::replace(&mut root.lane, lane.clone()),
                    std::mem::replace(&mut root.account, account.clone()),
                );
            }
            let others = || active.iter().filter(|(id, _)| id.as_str() != root_id);
            if others()
                .filter(|(_, flight)| flight.uses_lane(&lane))
                .count()
                >= lane_slots
                || others()
                    .filter(|(_, flight)| flight.uses_account(&account))
                    .count()
                    >= account_slots
            {
                drop(active);
                if !concurrent {
                    return Err(BenchmarkError::new(
                        "account_busy",
                        "Workflow worker slots are occupied",
                    ));
                }
                // Local admission is not a provider retry. Keep the same first
                // attempt and committed choice; contention spends root wall time.
                tokio::select! {
                    changed = cancel.changed() => {
                        if changed.is_err() {
                            return Err(BenchmarkError::new("cancelled", "Workflow worker reservation closed"));
                        }
                    },
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {},
                }
                continue;
            }
            let root = active.get_mut(root_id).ok_or_else(|| {
                BenchmarkError::new(
                    "dispatch_uncertain",
                    "Workflow has no active root reservation",
                )
            })?;
            break (
                std::mem::replace(&mut root.lane, lane.clone()),
                std::mem::replace(&mut root.account, account.clone()),
            );
        };
        let result = async {
            let timeout = match &budget {
                Some(budget) => timeout.min(budget.remaining_seconds(now())?),
                None => timeout,
            };
            // The projected lease also reaches native dispatch, after backend
            // setup has consumed time. Always restore the reservation below.
            self.backend
                .execute(&self.store, attempt, version, timeout, cancel)
                .await
        }
        .await;
        if let Some(root) = self.active.lock().await.get_mut(root_id) {
            (root.lane, root.account) = previous;
            // A step-admitted worker is held for its step only; the next
            // step decides, and takes, its own.
            if concurrency.admission
                == crate::services::benchmarks::workflow_campaign::WorkerAdmission::SelectedStep
            {
                root.workers.clear();
            }
        }
        result
    }
}
