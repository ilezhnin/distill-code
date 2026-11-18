//! The backend the isolated end-to-end mode and the tests run on.
use super::*;

/// How the fake backend grades an answer. It has no sandbox, so a
/// repository case is graded here, never by the repository check: its
/// answers are the case's references, the reference patch passes and any
/// other output fails. Every other evaluator runs as the service runs it.
#[cfg(test)]
pub(in super::super) async fn fake_evaluate(
    draft: &BenchmarkDraft,
    output: &str,
) -> Result<Evaluation> {
    if draft.evaluator.kind != crate::services::benchmarks::repository::EVALUATOR {
        return evaluate(draft, output).await;
    }
    let reference = Evaluator {
        kind: "exact".into(),
        expected: draft.evaluator.known_good.clone(),
        ..draft.evaluator.clone()
    };
    crate::services::benchmarks::evaluation::evaluate(&reference, output)
}

/// Used only when the app has registered its validated, isolated E2E mode.
#[derive(Default)]
pub struct FakeBackend {
    pub calls: std::sync::atomic::AtomicU64,
    /// Judge panels asked, and those that found their run stopped.
    pub judges: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    pub(in super::super) judged_attempts: std::sync::Mutex<Vec<String>>,
    pub stopped_judges: std::sync::atomic::AtomicU64,
    /// Tests hold a panel open to act on its run meanwhile.
    pub hold_judges: std::sync::atomic::AtomicBool,
    pub judge_entered: tokio::sync::Notify,
    pub judge_release: tokio::sync::Notify,
    /// Judge accounts report activity, as a native panel sees them.
    pub busy_judges: std::sync::atomic::AtomicBool,
    /// The panel fails before it records anything.
    pub fail_judges: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(in super::super) panic_judges: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(in super::super) busy_renderer: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(in super::super) judge_admission_waits: std::sync::atomic::AtomicU64,
    /// Local discovery refusals, before any judge prompt is sent.
    #[cfg(test)]
    pub(in super::super) judge_listing_refusals: std::sync::atomic::AtomicU64,
    /// Quota known before any judge call or placeholder, independently of the
    /// candidate's account. Zero means the invented judge is available.
    #[cfg(test)]
    pub(in super::super) judge_quota_until: std::sync::atomic::AtomicI64,
    #[cfg(test)]
    pub(in super::super) judge_quota_refusals: std::sync::atomic::AtomicU64,
    /// Turns the host refuses for quota before any provider call.
    pub quota_waits: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    pub(in super::super) accepted_quota_waits: std::sync::atomic::AtomicU64,
    /// Sessions that acknowledge another model than the one asked for.
    #[cfg(test)]
    pub(in super::super) wrong_selections: std::sync::atomic::AtomicU64,
    /// Accepted turns that report a usage limit after their answer was
    /// already evaluated.
    #[cfg(test)]
    pub(in super::super) evaluated_quota_waits: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    pub(in super::super) inventory_delay_ms: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    pub(in super::super) inventory_revision: std::sync::Mutex<Option<String>>,
    /// Models listed as refused by a stale sandbox check until it is renewed;
    /// with `failing_policy_renewal`, renewing fails.
    #[cfg(test)]
    pub(in super::super) stale_policy_check: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(in super::super) failing_policy_renewal: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(in super::super) policy_renewals: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    pub(in super::super) resource_busy: std::sync::atomic::AtomicBool,
    /// Host headroom probes the dispatcher made.
    #[cfg(test)]
    pub(in crate::services::benchmarks) resource_probes: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    pub(in super::super) resource_refusals: std::sync::atomic::AtomicU64,
    /// Once this many turns ran (zero: never), the next one is refused for
    /// local resources, once and then `resource_refusal_repeats` more times.
    #[cfg(test)]
    pub(in super::super) resource_refusal_after: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    pub(in crate::services::benchmarks) resource_refusal_repeats: std::sync::atomic::AtomicU64,
    /// Evaluations the local sandbox refuses before any worker starts, and
    /// the evaluations asked in all.
    #[cfg(test)]
    pub(in crate::services::benchmarks) evaluation_refusals: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    pub(in crate::services::benchmarks) evaluations: std::sync::atomic::AtomicU64,
    /// Evaluations the sandbox's infrastructure ends after their worker
    /// started, without a verdict.
    #[cfg(test)]
    pub(in crate::services::benchmarks) evaluation_infrastructure_failures:
        std::sync::atomic::AtomicU64,
    /// Evaluations the candidate's own code drives past the job's ceiling.
    #[cfg(test)]
    pub(in crate::services::benchmarks) evaluation_candidate_limits: std::sync::atomic::AtomicU64,
    /// Turns an infrastructure failure ends after their prompt was sent, and
    /// the provider's words for it (a lost bridge when none are set).
    #[cfg(test)]
    pub(in crate::services::benchmarks) infrastructure_turn_failures: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    pub(in crate::services::benchmarks) infrastructure_turn_words: std::sync::Mutex<Option<String>>,
    /// Once this many turns ran (zero: never), the next one waits, once, for
    /// a sandbox sign-in renewal that other sessions hold up.
    #[cfg(test)]
    pub(in super::super) busy_sign_in_after: std::sync::atomic::AtomicU64,
    /// How long each evaluation takes, and, while `hold_evaluations` is set,
    /// evaluations wait after entering until a test grants a permit.
    #[cfg(test)]
    pub(in crate::services::benchmarks) evaluation_ms: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    pub(in crate::services::benchmarks) hold_evaluations: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    pub(in crate::services::benchmarks) evaluations_entered: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    pub(in crate::services::benchmarks) evaluation_permits: std::sync::atomic::AtomicU64,
    /// How long a turn takes when set (default 300 ms).
    #[cfg(test)]
    pub(in crate::services::benchmarks) turn_ms: std::sync::atomic::AtomicU64,
    /// Sessions whose provider refuses the requested model before dispatch.
    pub refused_selections: std::sync::atomic::AtomicU64,
    /// Sessions the host refuses to open before any provider call (a sign-in
    /// near expiry, a refused preflight).
    pub capability_refusals: std::sync::atomic::AtomicU64,
    /// Turns held back until the Grok CLI renews its sign-in.
    pub sign_in_waits: std::sync::atomic::AtomicU64,
    /// Turns held back while another still runs on the due sign-in.
    pub busy_sign_ins: std::sync::atomic::AtomicU64,
    /// Turns refused because the account's seats are taken.
    pub busy_accounts: std::sync::atomic::AtomicU64,
    /// The effort levels every fake model lists: none, so no effort control,
    /// unless a test gives them some.
    pub effort_levels: std::sync::Mutex<Vec<String>>,
    /// Turns in flight now, and the most ever at once.
    pub in_flight: std::sync::atomic::AtomicU64,
    pub peak_in_flight: std::sync::atomic::AtomicU64,
    /// Cancellation tests keep every dispatched turn open until cancelled.
    pub hold_turns: std::sync::atomic::AtomicBool,
    /// A concurrency test may finish one held turn normally.
    #[cfg(test)]
    pub(in super::super) turn_release: tokio::sync::Notify,
    /// When set, no turn finishes before this many have been in flight at
    /// once, so overlap tests do not race a slow machine's clock.
    pub gate_in_flight: std::sync::atomic::AtomicU64,
    /// The accounts the fake provider lists, and those whose limit ran out.
    pub accounts_of: std::sync::Mutex<Vec<String>>,
    pub spent_accounts: std::sync::Mutex<Vec<String>>,
}

impl ExecutionBackend for FakeBackend {
    fn resource_admission<'a>(&'a self, _: &'a Configuration) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            #[cfg(test)]
            self.resource_probes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            #[cfg(test)]
            if self.resource_busy.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(BenchmarkError::new(
                    "resource_busy",
                    "Invented host pressure",
                ));
            }
            Ok(())
        })
    }
    fn unsupported(&self, _: &Configuration, _: &BenchmarkDraft) -> Option<String> {
        None
    }
    #[cfg(test)]
    fn evaluate_output<'a>(
        &'a self,
        draft: &'a BenchmarkDraft,
        output: &'a str,
    ) -> BoxFuture<'a, Result<Evaluation>> {
        use std::sync::atomic::Ordering;
        Box::pin(async move {
            self.evaluations.fetch_add(1, Ordering::SeqCst);
            if self
                .evaluation_refusals
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(1)
                })
                .is_ok()
            {
                return Err(BenchmarkError::new(
                    "resource_busy",
                    "resource_busy: benchmark preparation queue expired before worker startup",
                ));
            }
            self.evaluations_entered.fetch_add(1, Ordering::SeqCst);
            #[cfg(test)]
            if self
                .evaluation_infrastructure_failures
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(1)
                })
                .is_ok()
            {
                return Err(BenchmarkError::new(
                    "infrastructure_failure",
                    "infrastructure_error: benchmark process tree reached its memory ceiling",
                ));
            }
            #[cfg(test)]
            if self
                .evaluation_candidate_limits
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(1)
                })
                .is_ok()
            {
                return Err(BenchmarkError::new(
                    CANDIDATE_LIMIT,
                    "The candidate's code drove its check past the job's memory ceiling",
                ));
            }
            while self.hold_evaluations.load(Ordering::SeqCst)
                && self
                    .evaluation_permits
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                    .is_err()
            {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            tokio::time::sleep(Duration::from_millis(
                self.evaluation_ms.load(Ordering::SeqCst),
            ))
            .await;
            fake_evaluate(draft, output).await
        })
    }
    fn accounts<'a>(&'a self, _: &'a str, _: bool) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async move {
            Ok(self
                .accounts_of
                .lock()
                .map(|a| a.clone())
                .unwrap_or_default())
        })
    }
    fn judge<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
        _version: &'a BenchmarkVersion,
        stop: JudgeStop,
    ) -> BoxFuture<'a, Result<Attempt>> {
        use std::sync::atomic::Ordering;
        Box::pin(async move {
            #[cfg(test)]
            {
                let until = self.judge_quota_until.load(Ordering::SeqCst);
                if until > now() {
                    self.judge_quota_refusals.fetch_add(1, Ordering::SeqCst);
                    return Err(judge_quota_wait(Some(until)));
                }
            }
            #[cfg(test)]
            if self
                .judge_admission_waits
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(1)
                })
                .is_ok()
            {
                return Err(BenchmarkError::new(
                    JUDGE_ADMISSION_WAIT,
                    "Invented preparation contention",
                ));
            }
            #[cfg(test)]
            if self
                .judge_listing_refusals
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(1)
                })
                .is_ok()
            {
                return Err(BenchmarkError::new("resource_busy", "measured CPU load is above the light-job admission line; no provider process started"));
            }
            self.judges.fetch_add(1, Ordering::SeqCst);
            #[cfg(test)]
            self.judged_attempts
                .lock()
                .unwrap()
                .push(attempt.id.clone());
            #[cfg(test)]
            assert!(
                !self.panic_judges.load(Ordering::SeqCst),
                "Invented judge panic"
            );
            if self.fail_judges.load(Ordering::SeqCst) {
                return Err(BenchmarkError::new("infrastructure_failure", "host down"));
            }
            if self.hold_judges.load(Ordering::SeqCst) {
                self.judge_entered.notify_one();
                self.judge_release.notified().await;
            }
            if stop.halted(store).await? {
                self.stopped_judges.fetch_add(1, Ordering::SeqCst);
                attempt.reason = Some(JUDGING_STOPPED.into());
            } else if self.busy_judges.load(Ordering::SeqCst) {
                attempt.reason = Some(JUDGES_BUSY.into());
            }
            #[cfg(test)]
            if self.busy_renderer.load(Ordering::SeqCst) {
                attempt.reason = Some(RENDERER_BUSY.into());
            }
            Ok(attempt)
        })
    }
    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        _: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(async move {
            // Fake models have no effort control unless a test lists levels,
            // so their measurements are fully specified with the effort unset.
            #[cfg(test)]
            tokio::time::sleep(Duration::from_millis(
                self.inventory_delay_ms
                    .load(std::sync::atomic::Ordering::SeqCst),
            ))
            .await;
            let efforts = self
                .effort_levels
                .lock()
                .map(|levels| levels.clone())
                .unwrap_or_default();
            let revision = "fake-v1".to_owned();
            #[cfg(test)]
            let revision = self
                .inventory_revision
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(revision);
            let refusal: Option<String> = None;
            #[cfg(test)]
            let refusal = self
                .stale_policy_check
                .load(std::sync::atomic::Ordering::SeqCst)
                .then(|| {
                    "capability_missing: Linux text policy proof is absent, stale or its pinned runtime changed; run the isolated loopback policy probe".to_owned()
                })
                .or(refusal);
            Ok(["fake-pass", "fake-fail"]
                .into_iter()
                .map(|id| InventoryModel {
                    configuration: Configuration {
                        id: id.into(),
                        provider_id: provider.into(),
                        account_id: account.map(str::to_owned),
                        model_id: id.into(),
                        effort: None,
                        fast_mode: None,
                        billing_mode: "simulated".into(),
                        execution_profile: "native_text".into(),
                        inventory_revision: Some(revision.clone()),
                        model_name: None,
                    },
                    name: id.into(),
                    efforts: efforts.clone(),
                    supports_fast_mode: false,
                    available: refusal.is_none(),
                    reason: refusal.clone(),
                })
                .collect())
        })
    }
    #[cfg(test)]
    fn renew_stale_policy_check<'a>(&'a self, _provider: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            use std::sync::atomic::Ordering;
            self.policy_renewals.fetch_add(1, Ordering::SeqCst);
            if self.failing_policy_renewal.load(Ordering::SeqCst) {
                return Err(BenchmarkError::new(
                    "infrastructure_failure",
                    "Sandbox check failed: invented probe failure",
                ));
            }
            self.stale_policy_check.store(false, Ordering::SeqCst);
            Ok(())
        })
    }
    fn execute<'a>(
        &'a self,
        store: &'a Store,
        mut a: Attempt,
        v: BenchmarkVersion,
        _: u32,
        mut cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            use std::sync::atomic::Ordering;
            let take = |counter: &std::sync::atomic::AtomicU64| {
                counter
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                    .is_ok()
            };
            #[cfg(test)]
            if take(&self.resource_refusals) {
                return Err(BenchmarkError::new(
                    "resource_busy",
                    "Invented admission race",
                ));
            }
            #[cfg(test)]
            {
                let after = self.resource_refusal_after.load(Ordering::SeqCst);
                if after > 0 && self.calls.load(Ordering::SeqCst) >= after {
                    if self
                        .resource_refusal_repeats
                        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                        .is_err()
                    {
                        self.resource_refusal_after.store(0, Ordering::SeqCst);
                    }
                    return Err(BenchmarkError::new(
                        "resource_busy",
                        "Invented admission race after a provider turn",
                    ));
                }
                let after = self.busy_sign_in_after.load(Ordering::SeqCst);
                if after > 0 && self.calls.load(Ordering::SeqCst) >= after {
                    self.busy_sign_in_after.store(0, Ordering::SeqCst);
                    return Err(BenchmarkError::new(
                        SIGN_IN_WAIT,
                        crate::services::provider_account_status::grok::BENCHMARK_BRIDGE_BUSY,
                    ));
                }
            }
            #[cfg(test)]
            if take(&self.wrong_selections) {
                a.session_id = Some(format!("substituted-session-{}", a.id));
                let mut observed = a.configuration.clone();
                observed.model_id = "invented-substitute".into();
                a.observed = Some(observed);
                store.save_attempt(&a).await?;
                return Err(BenchmarkError::new(
                    "selection_changed",
                    "Provider did not acknowledge the exact model, effort and fast mode",
                ));
            }
            if take(&self.capability_refusals) {
                return Err(BenchmarkError::new(
                    "capability_missing",
                    "the Grok sign-in expires within 15 minutes; open a Grok chat so the Grok CLI refreshes it",
                ));
            }
            if take(&self.sign_in_waits) {
                hold_provider_until(&a.run_id, &a.configuration.provider_id, now() + 60_000);
                return Err(BenchmarkError::new(SIGN_IN_WAIT, SIGN_IN_WAIT_REASON));
            }
            if take(&self.busy_sign_ins) {
                return Err(BenchmarkError::new(
                    SIGN_IN_WAIT,
                    crate::services::provider_account_status::grok::BENCHMARK_BRIDGE_BUSY,
                ));
            }
            if take(&self.busy_accounts) {
                return Err(BenchmarkError::new(
                    ACCOUNT_BUSY,
                    "Workflow worker slots are occupied",
                ));
            }
            if take(&self.refused_selections) {
                let mut observed = a.configuration.clone();
                observed.model_id = "default".into();
                a.observed = Some(observed);
                store.save_attempt(&a).await?;
                return Err(BenchmarkError::new(
                    "selection_changed",
                    "Provider did not acknowledge the exact model, effort and fast mode",
                ));
            }
            let spent = a.configuration.account_id.as_ref().is_some_and(|account| {
                self.spent_accounts
                    .lock()
                    .is_ok_and(|spent| spent.contains(account))
            });
            if take(&self.quota_waits) || spent {
                a.phase = "running".into();
                a.host_run_id = Some(format!("fake-{}", a.id));
                store.save_attempt(&a).await?;
                let error = json!({"code":-32010,"data":{"kind":QUOTA_WAIT,
                    "dispatchStarted":false,"nextReset":now() + 60_000}});
                return Err(BenchmarkError::new(QUOTA_WAIT, error.to_string()));
            }
            self.calls.fetch_add(1, Ordering::SeqCst);
            #[cfg(test)]
            if take(&self.accepted_quota_waits) {
                a.phase = "running".into();
                a.session_id = Some(format!("accepted-session-{}", a.id));
                a.host_run_id = Some(format!("accepted-turn-{}", a.id));
                mark_phase(&mut a, "sessionOpened");
                mark_phase(&mut a, "dispatched");
                a.usage.input = Some(7);
                store.save_attempt(&a).await?;
                return Err(BenchmarkError::new(
                    QUOTA_WAIT,
                    json!({"kind":QUOTA_WAIT,"dispatchStarted":true,"nextReset":now()+60_000})
                        .to_string(),
                ));
            }
            #[cfg(test)]
            if take(&self.evaluated_quota_waits) {
                a.phase = "running".into();
                a.session_id = Some(format!("evaluated-session-{}", a.id));
                a.host_run_id = Some(format!("evaluated-turn-{}", a.id));
                a.usage.input = Some(7);
                let output = v.manifest.evaluator.known_good.clone();
                a.evaluations
                    .push(fake_evaluate(&v.manifest, &output).await?);
                a.output = Some(output);
                store.save_attempt(&a).await?;
                return Err(BenchmarkError::new(
                    QUOTA_WAIT,
                    json!({"kind":QUOTA_WAIT,"dispatchStarted":true}).to_string(),
                ));
            }
            #[cfg(test)]
            if take(&self.infrastructure_turn_failures) {
                a.phase = "running".into();
                a.session_id = Some(format!("failed-session-{}", a.id));
                a.host_run_id = Some(format!("failed-turn-{}", a.id));
                a.observed = Some(a.configuration.clone());
                store.save_attempt(&a).await?;
                let words = self
                    .infrastructure_turn_words
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| {
                        "The agent's bridge exited before this turn finished".into()
                    });
                a.outcome = Some("infrastructure_failure".into());
                a.reason = Some(
                    json!({"code":-32603,"message":words,"data":{"accountId":"invented",
                        "dispatchStarted":true,"promptNotAccepted":false}})
                    .to_string(),
                );
                a.output = Some(String::new());
                a.usage.input = Some(7);
                a.finished_at = Some(now());
                a.evidence_hash = Some(
                    fixtures::seal(&store.root, &a, &json!({"provider":"isolated_e2e_fake"}))
                        .await?,
                );
                return Ok(a);
            }
            let flying = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak_in_flight.fetch_max(flying, Ordering::SeqCst);
            a.phase = "running".into();
            a.host_run_id = Some(format!("fake-{}", a.id));
            a.observed = Some(a.configuration.clone());
            store.save_attempt(&a).await?;
            let gate = self.gate_in_flight.load(Ordering::SeqCst);
            let opened = std::time::Instant::now() + Duration::from_secs(10);
            while self.peak_in_flight.load(Ordering::SeqCst) < gate
                && std::time::Instant::now() < opened
            {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            if self.hold_turns.load(Ordering::SeqCst) {
                while !*cancel.borrow() {
                    #[cfg(test)]
                    tokio::select! {
                        changed = cancel.changed() => if changed.is_err() { break; },
                        _ = self.turn_release.notified() => break,
                    }
                    #[cfg(not(test))]
                    if cancel.changed().await.is_err() {
                        break;
                    }
                }
            } else {
                #[cfg(not(test))]
                let turn = Duration::from_millis(300);
                #[cfg(test)]
                let turn = Duration::from_millis(match self.turn_ms.load(Ordering::SeqCst) {
                    0 => 300,
                    ms => ms,
                });
                tokio::select! {_=tokio::time::sleep(turn)=>{},_=cancel.changed()=>{}}
            }
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            if *cancel.borrow() {
                a.outcome = Some("cancelled".into());
            } else {
                a.outcome = Some("completed".into());
                a.output = Some(if a.configuration.model_id == "fake-fail" {
                    v.manifest.evaluator.known_bad
                } else {
                    v.manifest.evaluator.known_good
                });
            }
            a.usage = TokenUsage {
                input: Some(10),
                output: Some(5),
                schema: "fake_nonoverlapping_v1".into(),
                ..Default::default()
            };
            a.duration_ms = Some(300);
            a.finished_at = Some(now());
            a.evidence_hash = Some(
                fixtures::seal(&store.root, &a, &json!({"provider":"isolated_e2e_fake"})).await?,
            );
            Ok(a)
        })
    }
    fn activity<'a>(&'a self, _: &'a Configuration) -> BoxFuture<'a, Result<AccountActivity>> {
        Box::pin(async move {
            Ok(AccountActivity {
                active_sessions: Vec::new(),
                generation: self.calls.load(std::sync::atomic::Ordering::SeqCst),
            })
        })
    }
}
