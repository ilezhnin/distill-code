//! The run's side of judging: starting, asking, resuming and reconciling panels.
use super::*;

impl BenchmarkService {
    pub(in super::super) async fn start_waiting_judge(
        self: &Arc<Self>,
        run: &BenchmarkRun,
        id: String,
        flights: &mut tokio::task::JoinSet<()>,
        tried: &mut std::collections::HashSet<String>,
    ) -> bool {
        let lane = format!("judges\u{1f}{}", run.id);
        let seat = Seat {
            id: &lane,
            lane: &lane,
            lane_slots: 1,
            account: "",
            account_slots: ACCOUNT_SLOTS,
            model: "",
            model_slots: usize::MAX,
        };
        let Some(cancel) = self.claim(&run.id, seat).await else {
            return false;
        };
        // Reserve before spawning: fill continues admitting candidates while
        // this task is not yet polled. The chosen paid answer must already
        // own its place. Claim the lane first so a duplicate scheduler pass
        // cannot drop the active panel's same-generation preparation guard.
        let scope = self.store.root.display().to_string();
        let job = format!("judge:{id}");
        let Some(preparing) = admission_window::begin(&scope, &job) else {
            self.release(&lane).await;
            return false;
        };
        let preparing = preparing.observe();
        tried.insert(id.clone());
        let (service, run) = (self.clone(), run.clone());
        flights.spawn(async move {
            let _preparing = preparing;
            let result = AssertUnwindSafe(service.resume_judging(&run, &id, cancel))
                .catch_unwind()
                .await;
            service.finish_flight(&id, &lane, result).await;
        });
        true
    }

    /// Sends a rendering to its judge panel where the saved plan reserved the
    /// calls. Judge failures stay on the attempt.
    pub(in super::super) async fn ask_judges(
        &self,
        mut attempt: Attempt,
        version: &BenchmarkVersion,
        judge_budget: Option<std::result::Result<bool, String>>,
        stop: JudgeStop,
    ) -> Attempt {
        match judge_budget {
            Some(Ok(true)) => {
                let scope = self.store.root.display().to_string();
                let job = format!("judge:{}", attempt.id);
                let Some(_preparing) = admission_window::begin(&scope, &job) else {
                    attempt.reason = Some(JUDGE_DISCOVERY_WAIT.into());
                    let remaining = admission_window::remaining(&scope);
                    attempt.wait_until =
                        (!remaining.is_zero()).then(|| now() + remaining.as_millis() as i64);
                    return attempt;
                };
                let lock = crate::services::benchmarks::evaluation_lock(&attempt.id);
                let _guard = lock.lock().await;
                let recorded: Vec<String> =
                    attempt.evaluations.iter().map(|e| e.id.clone()).collect();
                if !self.backend.paces_preparation() {
                    admission_window::admitted(&scope, &job);
                }
                attempt.reason = None;
                attempt.wait_until = None;
                mark_phase(&mut attempt, "judgeStarted");
                if let Err(error) = self.store.save_attempt(&attempt).await {
                    admission_window::finished(&scope, &job);
                    attempt.reason = Some(error.message);
                    return attempt;
                }
                self.changed().await;
                let result = self
                    .backend
                    .judge(&self.store, attempt.clone(), version, stop)
                    .await;
                admission_window::finished(&scope, &job);
                match result {
                    Ok(judged) => attempt = judged,
                    Err(error) => {
                        // Once the panel saved, the store holds this attempt's verdicts
                        // plus the judges' spend; before that only memory holds them.
                        if let Ok(saved) = self.store.attempt(&attempt.id).await {
                            if recorded
                                .iter()
                                .all(|id| saved.evaluations.iter().any(|e| &e.id == id))
                            {
                                attempt = saved;
                            }
                        }
                        let error = diagnostics::record(
                            &self.store,
                            &attempt,
                            "judge_attempt",
                            error,
                            None,
                            json!({}),
                        )
                        .await;
                        if error.code == JUDGE_QUOTA_WAIT {
                            attempt.reason = Some(judge_error_reason(&error));
                            attempt.wait_until = Some(
                                error
                                    .details
                                    .as_ref()
                                    .and_then(|details| details["nextReset"].as_i64())
                                    .filter(|until| *until > now())
                                    .unwrap_or(now() + QUOTA_RETRY_MS),
                            );
                        } else if unstarted_refusal(&error) || error.code == JUDGE_ADMISSION_WAIT {
                            if unstarted_refusal(&error) {
                                admission_window::refused(&scope, &job);
                            }
                            attempt.reason = Some(judge_error_reason(&error));
                            let remaining = admission_window::remaining(&scope);
                            attempt.wait_until = (!remaining.is_zero())
                                .then(|| now() + remaining.as_millis() as i64);
                        } else {
                            attempt.reason = Some(judge_error_reason(&error));
                        }
                    }
                }
                if matches!(attempt.reason.as_deref(), Some(JUDGES_BUSY | RENDERER_BUSY)) {
                    attempt.wait_until = Some(now() + JUDGE_BUSY_RETRY.as_millis() as i64);
                }
                mark_phase(&mut attempt, "judgeFinished");
            }
            Some(Ok(false)) => {
                attempt.reason =
                    Some("Judge calls are not covered by this saved run's execution budget".into());
            }
            Some(Err(message)) => {
                attempt.reason = Some(format!(
                    "Judge reservation could not be verified: {message}"
                ));
            }
            None => {}
        }
        attempt
    }

    /// Whether a run's saved plan reserved judge calls for this case; known
    /// before any paid turn. Old plans may predate the reservation.
    pub(in super::super) async fn judge_budget(
        &self,
        run: &BenchmarkRun,
        version: &BenchmarkVersion,
    ) -> Option<std::result::Result<bool, String>> {
        if version.manifest.evaluator.kind != "rubric" {
            return None;
        }
        Some(
            self.planned_executions(&run.request)
                .await
                .map(|count| count <= run.request.max_executions as usize)
                .map_err(|error| error.message),
        )
    }

    /// Asks the panel of one rendering a pause or busy judges held back.
    pub(in super::super) async fn resume_judging(
        &self,
        run: &BenchmarkRun,
        id: &str,
        cancel_rx: watch::Receiver<bool>,
    ) -> Result<()> {
        let waiting = self.store.attempt(id).await?;
        let version = self.store.version(&waiting.version_id).await?;
        let mut settled = waiting.clone();
        settled.phase = "terminal".into();
        // A plan saved before authored cells were left out may still hold a
        // rendering its candidate wrote; under its rule no verdict on it counts.
        if !run.request.measures_author_cells()
            && crate::services::benchmarks::routing::authored_by_candidate(
                &version.manifest,
                &waiting.configuration,
            )
        {
            settled.outcome = Some("excluded".into());
            settled.reason = Some("authored by this candidate".into());
            self.store.save_attempt(&settled).await?;
            return Ok(());
        }
        // Every vote of the batch landed before the final save: the panel
        // already settled it, and only an explicit evaluation asks again.
        if crate::services::benchmarks::analysis::score(&waiting).is_some() {
            if settled.outcome.as_deref() == Some("pending_review") {
                settled.outcome = Some("judged".into());
            }
            settled.reason = None;
            self.store.save_attempt(&settled).await?;
            return Ok(());
        }
        let judge_budget = self.judge_budget(run, &version).await;
        let mut attempt = waiting.clone();
        attempt.reason = None;
        attempt.wait_until = None;
        let stop = JudgeStop::run(&run.id, cancel_rx);
        let mut judged = self.ask_judges(attempt, &version, judge_budget, stop).await;
        judged.phase = self.settled_phase(run, &judged).await?.into();
        // A panel still waiting on busy judges records nothing new.
        if serde_json::to_value(&judged)? != serde_json::to_value(&waiting)? {
            self.store.save_attempt(&judged).await?;
        }
        Ok(())
    }

    /// Whether a recovered attempt is a rendering still owed its panel: a
    /// judged brief, a renderable output with no verdict yet, and a run that
    /// can still resume. Nothing resumes a finished run, so its rendering
    /// settles and stays open to Evaluate again. No judge is asked here.
    pub(in super::super) async fn awaits_panel(
        &self,
        attempt: &Attempt,
        version: &BenchmarkVersion,
    ) -> Result<bool> {
        let manifest = &version.manifest;
        Ok(manifest.evaluator.kind == "rubric"
            && !rubric_criteria(manifest).is_empty()
            && attempt.outcome.as_deref() == Some("pending_review")
            && crate::services::benchmarks::analysis::score(attempt).is_none()
            && judge_document(manifest, attempt.output.as_deref().unwrap_or_default()).is_some()
            && matches!(
                self.store.run_state(&attempt.run_id).await?.as_str(),
                "running" | "pausing" | "paused" | "needs_attention"
            ))
    }

    /// Judge turns a restart cut off: their placeholders are settled from the
    /// host's records, so the spend is kept and never counts as a vote.
    pub(in crate::services::benchmarks) async fn reconcile_judges(&self) -> Result<()> {
        let ids = sqlx::query_scalar::<_, String>(
            "SELECT a.id FROM attempts a WHERE EXISTS(SELECT 1 FROM json_each(a.data_json,'$.evaluations') e
               WHERE json_extract(e.value,'$.details.inFlight')=1)",
        )
        .fetch_all(&self.store.pool)
        .await?;
        for id in ids {
            let lock = crate::services::benchmarks::evaluation_lock(&id);
            let Ok(_guard) = lock.try_lock() else {
                continue;
            };
            let attempt = self.store.attempt(&id).await?;
            let attempt = self.backend.reconcile_judges(&self.store, attempt).await?;
            self.store.save_attempt(&attempt).await?;
        }
        Ok(())
    }
}
