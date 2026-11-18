//! Picking up what a restart interrupted.
use super::*;

impl BenchmarkService {
    /// Receipt collection and checking are managed, cancellable flights, not
    /// housekeeping awaits. A store recovers one receipt at a time while its
    /// other eligible candidates and panels continue through normal admission.
    pub(in super::super) async fn recover_interrupted(
        self: &Arc<Self>,
        flights: &mut tokio::task::JoinSet<()>,
        tried: &mut std::collections::HashSet<String>,
    ) -> Result<()> {
        let interrupted = sqlx::query_scalar::<_, String>(
            "SELECT data_json FROM attempts WHERE phase='interrupted'",
        )
        .fetch_all(&self.store.pool)
        .await?;
        let root_scope = self.store.root.display().to_string();
        let lane = format!("recovery:{}", root_scope);
        for data in interrupted {
            let a: Attempt = serde_json::from_str(&data)?;
            if a.wait_until.is_some_and(|until| until > now())
                || (tried.contains(&a.id) && a.wait_until.is_none())
                || self.active.lock().await.contains_key(&a.id)
            {
                continue;
            }
            let run = self.store.run(&a.run_id).await?;
            let version = self.store.version(&a.version_id).await?;
            let scope = evaluation_preparation_scope(&root_scope, &version.manifest);
            let job = format!("evaluation:{}", a.id);
            let Some(preparing) = admission_window::begin(&scope, &job) else {
                continue;
            };
            // Planning checks keep the configuration's seat just as a freshly
            // completed turn does; recovery does not create a new paid turn.
            let workers = if checks_without_its_seat(&a, &version) {
                Vec::new()
            } else {
                let account = format!(
                    "{}\u{1f}{}",
                    a.configuration.provider_id,
                    a.configuration.account_id.as_deref().unwrap_or_default()
                );
                vec![WorkerReservation {
                    lane: crate::services::benchmarks::analysis::configuration_key(
                        &a.configuration,
                    ),
                    account_slots: account_slots(
                        &run.id,
                        &quota_scope(&a.configuration),
                        &pace_key(&self.store, &account),
                    ),
                    account,
                    lane_slots: attempts_at_once(&run.request, &a.configuration) as usize,
                }]
            };
            let Some(cancel) = self
                .claim_workers(
                    &run.id,
                    Seat {
                        id: &a.id,
                        lane: &lane,
                        lane_slots: 1,
                        account: "",
                        account_slots: usize::MAX,
                        model: "",
                        model_slots: usize::MAX,
                    },
                    workers,
                )
                .await
            else {
                continue;
            };
            let id = a.id.clone();
            tried.insert(id.clone());
            let service = self.clone();
            let preparing = Arc::new(preparing.observe());
            flights.spawn(async move {
                let result = AssertUnwindSafe(service.recover_one(
                    a,
                    &run.request,
                    &version,
                    cancel,
                    &scope,
                    &job,
                    preparing.clone(),
                ))
                .catch_unwind()
                .await;
                // The observer drops on every exit, including a checker panic.
                drop(preparing);
                service.finish_flight(&id, &id, result).await;
            });
            break;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub(in super::super) async fn recover_one(
        &self,
        mut a: Attempt,
        request: &RunRequest,
        version: &BenchmarkVersion,
        mut cancel: watch::Receiver<bool>,
        scope: &str,
        job: &str,
        preparing: Arc<admission_window::ObservedJob>,
    ) -> Result<()> {
        let recovered = if version.manifest.workflow.is_some() {
            crate::services::benchmarks::workflow::recover(self, a.clone(), version.clone()).await?
        } else {
            self.backend.recover(&self.store, a.clone()).await?
        };
        match recovered {
            Some(mut restored) => {
                // A recovered prefix waits for an explicit resume before another paid step.
                if restored.phase == "pending" {
                    if !request.automatic_retry() {
                        restored.phase = "terminal".into();
                        restored.outcome = Some("interrupted".into());
                        restored.reason = Some("Recovered workflow prefix retained; this run forbids another dispatch after interruption".into());
                        restored.finished_at = Some(now());
                    } else if version.manifest.workflow.is_none() {
                        // Back in the queue, a standalone try takes its
                        // clock with it, as after any requeue.
                        drop_collection_clock(&self.store, &mut restored).await?;
                    }
                    self.store.save_attempt(&restored).await?;
                    return Ok(());
                }
                if restored.outcome.as_deref() == Some("completed") {
                    // Save newly recovered output before a fallible checker;
                    // panic/cancellation cleanup must keep its sealed receipt.
                    restored.phase = "interrupted".into();
                    restored.wait_until = None;
                    self.store.save_attempt(&restored).await?;
                    if !self.backend.paces_preparation() {
                        preparing.admitted();
                    }
                    let admission = preparing.clone();
                    let evaluate = sandbox::with_workload_admission(
                        move || admission.admitted(),
                        self.backend.evaluate_output(
                            &version.manifest,
                            restored.output.as_deref().unwrap_or_default(),
                        ),
                    );
                    let evaluation = if *cancel.borrow() {
                        Err(BenchmarkError::new(
                            "cancelled",
                            "Recovered evaluation cancelled",
                        ))
                    } else {
                        tokio::select! {
                            result = evaluate => result,
                            _ = cancel.changed() => Err(BenchmarkError::new(
                                "cancelled", "Recovered evaluation cancelled",
                            )),
                        }
                    };
                    if evaluation.is_ok() {
                        preparing.admitted();
                    }
                    if preparing.finished() {
                        self.wake.notify_one();
                    }
                    match evaluation {
                        Ok(e) => {
                            if restored
                                .reason
                                .as_deref()
                                .is_some_and(|reason| reason.starts_with(EVALUATION_WAIT))
                            {
                                restored.reason = None;
                            }
                            restored.wait_until = None;
                            restored.outcome = Some(e.verdict.clone());
                            restored.evaluations.push(e);
                        }
                        // Nothing graded the sealed generation: it stays
                        // interrupted, and a later pass asks again without
                        // recovering the turn again, as long as its run
                        // goes on. The run waits for it.
                        Err(e)
                            if unstarted_refusal(&e)
                                && restored.evidence_hash.is_some()
                                && !matches!(
                                    self.store.run_state(&restored.run_id).await?.as_str(),
                                    "cancelling" | "cancelled"
                                ) =>
                        {
                            admission_window::refused(scope, job);
                            restored.phase = "interrupted".into();
                            restored.reason = Some(format!("{EVALUATION_WAIT}: {}", e.message));
                            restored.wait_until =
                                Some(now() + admission_window::RETRY.as_millis() as i64);
                            self.store.save_attempt(&restored).await?;
                            self.changed().await;
                            return Ok(());
                        }
                        // As in `settle`: the candidate's own past its
                        // job's ceiling is its answer, scored 0. Left as an
                        // evaluator error it stayed unscored, and every
                        // resume ran the same check into the same ceiling.
                        Err(e) => {
                            restored.outcome = Some(evaluation_failure_outcome(&e).into());
                            restored.reason = Some(e.message);
                        }
                    }
                }
                // A rendering whose panel a restart cut off keeps its paid
                // generation and waits for its run's resume, which asks a
                // fresh panel; anything else settles here.
                if request.automatic_retry() && self.awaits_panel(&restored, version).await? {
                    restored.phase = AWAITING_JUDGES.into();
                    restored.reason = Some(JUDGING_STOPPED.into());
                } else {
                    restored.phase = "terminal".into();
                }
                self.store.save_attempt(&restored).await?;
                self.changed().await;
            }
            None => {
                a.phase = "terminal".into();
                a.outcome = Some("dispatch_uncertain".into());
                a.reason = Some(if request.automatic_retry() {
                    "Remote acceptance cannot be established after restart; the run continues with its other tests, and this case starts over when the run resumes"
                } else {
                    "Remote acceptance cannot be established after restart; this run forbids a replacement dispatch and requires operator inspection"
                }.into());
                a.finished_at = Some(now());
                self.store.save_attempt(&a).await?;
                self.changed().await;
            }
        }
        Ok(())
    }
}
