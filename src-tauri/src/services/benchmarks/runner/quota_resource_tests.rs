//! Quota waits retain evidence and queue position, never an account seat or
//! shared preparation slot. All accounts and responses here are invented.
use super::tests::serial_request;
use super::*;
use std::sync::{atomic::AtomicU64, atomic::Ordering, Mutex};

struct QuotaBackend {
    fake: FakeBackend,
    reset: i64,
    accepted: bool,
    candidate_quota: bool,
    refusals: AtomicU64,
    probes: Mutex<Vec<String>>,
    judges: Mutex<Vec<String>>,
}

impl ExecutionBackend for QuotaBackend {
    fn unsupported(&self, _: &Configuration, _: &BenchmarkDraft) -> Option<String> {
        None
    }

    fn paces_preparation(&self) -> bool {
        true
    }

    fn resource_admission<'a>(&'a self, c: &'a Configuration) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.probes
                .lock()
                .unwrap()
                .push(c.account_id.clone().unwrap());
            Ok(())
        })
    }

    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        refresh: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(async move {
            let mut inventory = self.fake.inventory(provider, account, refresh).await?;
            let mut available = inventory[0].clone();
            available.configuration.id = "fake-available".into();
            available.configuration.model_id = "fake-available".into();
            inventory.push(available);
            Ok(inventory)
        })
    }

    fn execute<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
        version: BenchmarkVersion,
        timeout: u32,
        cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            let scope = store.root.display().to_string();
            if self.candidate_quota
                && attempt.configuration.account_id.as_deref() == Some("isolated")
            {
                self.refusals.fetch_add(1, Ordering::SeqCst);
                if self.accepted {
                    admission_window::admitted(&scope, &attempt.id);
                    attempt.phase = "running".into();
                    attempt.session_id = Some(format!("invented-session-{}", attempt.id));
                    attempt.host_run_id = Some(format!("invented-turn-{}", attempt.id));
                    attempt.usage.input = Some(7);
                    store.save_attempt(&attempt).await?;
                }
                return Err(self.quota_error());
            }
            admission_window::admitted(&scope, &attempt.id);
            self.fake
                .execute(store, attempt, version, timeout, cancel)
                .await
        })
    }

    fn judge<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
        _: &'a BenchmarkVersion,
        _: JudgeStop,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            let account = attempt.configuration.account_id.clone().unwrap();
            self.judges.lock().unwrap().push(account.clone());
            if account == "isolated" {
                // A quota refusal before a judge session is admitted must
                // drop the enclosing preparation guard, including its lane.
                return Err(self.quota_error());
            }
            admission_window::admitted(
                &store.root.display().to_string(),
                &format!("judge:{}", attempt.id),
            );
            attempt.outcome = Some("judged".into());
            attempt.reason = None;
            Ok(attempt)
        })
    }
}

impl QuotaBackend {
    fn quota_error(&self) -> BenchmarkError {
        BenchmarkError::new(
            QUOTA_WAIT,
            json!({"message":"Invented account waits for its four-hour reset",
                "data":{"kind":QUOTA_WAIT,"dispatchStarted":self.accepted,"nextReset":self.reset}})
            .to_string(),
        )
    }
}

async fn setup_quota(
    accepted: bool,
    candidate_quota: bool,
) -> (
    crate::test_support::TempRoot,
    Arc<BenchmarkService>,
    Arc<QuotaBackend>,
) {
    let dir = crate::test_support::TempRoot::new();
    let store = Store::open(dir.path()).await.unwrap();
    dir.register(&store.pool);
    let backend = Arc::new(QuotaBackend {
        fake: FakeBackend::default(),
        reset: now() + 4 * 60 * 60 * 1000,
        accepted,
        candidate_quota,
        refusals: AtomicU64::new(0),
        probes: Mutex::new(Vec::new()),
        judges: Mutex::new(Vec::new()),
    });
    backend.fake.turn_ms.store(1, Ordering::SeqCst);
    let service = Arc::new(BenchmarkService {
        store,
        backend: backend.clone(),
        wake: tokio::sync::Notify::new(),
        active: Default::default(),
        queries: Default::default(),
        app: None,
    });
    (dir, service, backend)
}

async fn two_accounts(service: &BenchmarkService, judged: bool) -> RunRequest {
    let mut request = serial_request(service).await;
    request.repetitions = 1;
    request.max_executions = if judged { 8 } else { 2 };
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    let mut available = request.configurations[0].clone();
    available.id = "invented-available".into();
    available.model_id = "fake-available".into();
    available.account_id = Some("available".into());
    request.configurations.push(available);
    if judged {
        let mut draft = seed_definitions()
            .into_iter()
            .find(|draft| draft.work_class_id == "creative")
            .unwrap();
        draft.name = "Invented quota panel".into();
        draft.split = "train".into();
        let definition = service.store.save_draft(None, None, draft).await.unwrap();
        request.version_ids = vec![service.store.publish(&definition.id, 1).await.unwrap().id];
    }
    request
}

async fn tick(service: &Arc<BenchmarkService>) {
    tokio::time::timeout(Duration::from_secs(10), service.tick())
        .await
        .expect("a quota reset must not be awaited by a flight")
        .unwrap();
}

#[tokio::test]
async fn quota_resources_candidate_wait_releases_seats_for_an_available_account() {
    for accepted in [false, true] {
        let (dir, service, backend) = setup_quota(accepted, true).await;
        let run = service
            .start_run(two_accounts(&service, false).await)
            .await
            .unwrap();
        for _ in 0..3 {
            tick(&service).await;
        }
        let current = service.store.run(&run.id).await.unwrap();
        let blocked = current
            .attempts
            .iter()
            .find(|attempt| attempt.configuration.account_id.as_deref() == Some("isolated"))
            .unwrap();
        let available = current
            .attempts
            .iter()
            .find(|attempt| attempt.configuration.account_id.as_deref() == Some("available"))
            .unwrap();
        assert_eq!(blocked.phase, "pending");
        assert_eq!(blocked.wait_until, Some(backend.reset));
        assert_eq!(available.outcome.as_deref(), Some("pass"));
        assert_eq!(backend.refusals.load(Ordering::SeqCst), 1);
        assert!(service.active.lock().await.is_empty());
        assert!(admission_window::has_room(
            &service.store.root.display().to_string()
        ));
        assert_eq!(current.state, "running");
        dir.close().await;
    }
}

#[tokio::test]
async fn quota_resources_saved_wait_does_not_reacquire_capacity_after_restart() {
    let (dir, service, backend) = setup_quota(false, true).await;
    let request = two_accounts(&service, false).await;
    let run = service.start_run(request.clone()).await.unwrap();
    for _ in 0..3 {
        tick(&service).await;
    }
    // Memory-only holds disappear on process restart; persisted wait_until
    // must still keep this account out of preparation and provider dispatch.
    forget_quota_waits(&run.id);
    let mut available = request;
    available.request_key = "invented-next-available".into();
    available
        .configurations
        .retain(|c| c.account_id.as_deref() == Some("available"));
    available.max_executions = 1;
    let next = service.start_run(available).await.unwrap();
    for _ in 0..3 {
        tick(&service).await;
    }
    assert_eq!(
        backend.refusals.load(Ordering::SeqCst),
        1,
        "a persisted future reset was ignored"
    );
    assert_eq!(
        backend
            .probes
            .lock()
            .unwrap()
            .iter()
            .filter(|account| account.as_str() == "isolated")
            .count(),
        1
    );
    assert_eq!(
        service.store.run(&next.id).await.unwrap().state,
        "completed"
    );
    assert_eq!(service.store.run(&run.id).await.unwrap().state, "running");
    assert!(service.active.lock().await.is_empty());
    dir.close().await;
}

#[tokio::test]
async fn quota_resources_judge_refusal_releases_shared_preparation_and_run_lane() {
    let (dir, service, backend) = setup_quota(false, false).await;
    let run = service
        .start_run(two_accounts(&service, true).await)
        .await
        .unwrap();
    // Both generations are already sealed; exercise the shared run-wide
    // judge lane, not the candidate lane's independent completion path.
    for mut attempt in run.attempts.clone() {
        attempt.phase = AWAITING_JUDGES.into();
        attempt.outcome = Some("pending_review".into());
        attempt.output = Some("<svg/>".into());
        service.store.save_attempt(&attempt).await.unwrap();
    }
    for _ in 0..4 {
        tick(&service).await;
    }
    let current = service.store.run(&run.id).await.unwrap();
    let blocked = current
        .attempts
        .iter()
        .find(|attempt| attempt.configuration.account_id.as_deref() == Some("isolated"))
        .unwrap();
    let available = current
        .attempts
        .iter()
        .find(|attempt| attempt.configuration.account_id.as_deref() == Some("available"))
        .unwrap();
    assert!(blocked
        .reason
        .as_deref()
        .unwrap()
        .contains("four-hour reset"));
    assert_eq!(available.outcome.as_deref(), Some("judged"));
    assert_eq!(backend.judges.lock().unwrap().len(), 2);
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
    assert!(service.active.lock().await.is_empty());
    assert!(admission_window::has_room(
        &service.store.root.display().to_string()
    ));
    dir.close().await;
}

#[tokio::test]
async fn quota_resources_future_judge_wait_does_not_claim_the_run_lane() {
    let (dir, service, backend) = setup_quota(false, false).await;
    let run = service
        .start_run(two_accounts(&service, true).await)
        .await
        .unwrap();
    for mut attempt in run.attempts.clone() {
        attempt.phase = AWAITING_JUDGES.into();
        attempt.outcome = Some("pending_review".into());
        attempt.output = Some("<svg/>".into());
        if attempt.configuration.account_id.as_deref() == Some("isolated") {
            attempt.wait_until = Some(backend.reset);
            attempt.reason = Some(JUDGES_BUSY.into());
        }
        service.store.save_attempt(&attempt).await.unwrap();
    }
    for _ in 0..4 {
        tick(&service).await;
    }
    let current = service.store.run(&run.id).await.unwrap();
    assert_eq!(current.state, "running");
    assert_eq!(*backend.judges.lock().unwrap(), vec!["available"]);
    assert!(service.active.lock().await.is_empty());
    assert!(admission_window::has_room(
        &service.store.root.display().to_string()
    ));
    assert!(current
        .attempts
        .iter()
        .any(|a| a.phase == AWAITING_JUDGES && a.wait_until == Some(backend.reset)));
    dir.close().await;
}

#[tokio::test]
async fn quota_resources_expired_persisted_wait_dispatches_without_manual_reset() {
    let (dir, service, backend) = setup_quota(false, false).await;
    let run = service
        .start_run(two_accounts(&service, false).await)
        .await
        .unwrap();
    let mut expired = run.attempts[0].clone();
    expired.wait_until = Some(now() - 1);
    expired.reason = Some(backend.quota_error().message);
    service.store.save_attempt(&expired).await.unwrap();
    hold_provider_until(&run.id, &quota_scope(&expired.configuration), now() - 1);
    for _ in 0..3 {
        tick(&service).await;
    }
    assert_eq!(service.store.run(&run.id).await.unwrap().state, "completed");
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 2);
    dir.close().await;
}

#[tokio::test]
async fn quota_resources_pending_backoff_does_not_probe_each_tick_or_complete_early() {
    let (dir, service, backend) = setup_quota(false, false).await;
    let run = service
        .start_run(two_accounts(&service, false).await)
        .await
        .unwrap();
    let mut waiting = run
        .attempts
        .iter()
        .find(|a| a.configuration.account_id.as_deref() == Some("isolated"))
        .unwrap()
        .clone();
    waiting.wait_until = Some(backend.reset);
    waiting.reason = Some("Refused before any answer; tried again. invented account busy".into());
    service.store.save_attempt(&waiting).await.unwrap();
    for _ in 0..4 {
        tick(&service).await;
    }
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 1);
    assert_eq!(*backend.probes.lock().unwrap(), vec!["available"]);
    assert_eq!(service.store.run(&run.id).await.unwrap().state, "running");
    assert!(service.active.lock().await.is_empty());
    let scope = service.store.root.display().to_string();
    assert!(pending_waiting(&waiting, &scope, backend.reset - 1));
    assert!(!pending_waiting(&waiting, &scope, backend.reset));
    dir.close().await;
}

#[tokio::test]
async fn quota_resources_wait_can_pause_and_cancel_without_waiting_for_reset() {
    let (dir, service, backend) = setup_quota(false, true).await;
    let run = service
        .start_run(two_accounts(&service, false).await)
        .await
        .unwrap();
    for _ in 0..3 {
        tick(&service).await;
    }
    service.control(&run.id, "pause").await.unwrap();
    tick(&service).await;
    assert_eq!(service.store.run(&run.id).await.unwrap().state, "paused");
    service.control(&run.id, "cancel").await.unwrap();
    tick(&service).await;
    let cancelled = service.store.run(&run.id).await.unwrap();
    assert_eq!(cancelled.state, "cancelled");
    assert_eq!(backend.refusals.load(Ordering::SeqCst), 1);
    assert!(cancelled.attempts.iter().all(|a| a.phase == "terminal"));
    assert!(service.active.lock().await.is_empty());
    dir.close().await;
}

#[tokio::test]
async fn quota_resources_explicit_resume_and_finish_probe_account_again() {
    for (extend, accepted) in [(false, false), (false, true), (true, false), (true, true)] {
        let (dir, service, backend) = setup_quota(accepted, true).await;
        let mut request = two_accounts(&service, false).await;
        if extend {
            // Finish is only offered for an extendable, automatic-retry plan.
            request.execution_limits.as_mut().unwrap().retry_policy = RunRetryPolicy::Automatic;
        }
        let run = service.start_run(request).await.unwrap();
        for _ in 0..3 {
            tick(&service).await;
        }
        service.control(&run.id, "pause").await.unwrap();
        tick(&service).await;
        let resumed = if extend {
            service.extend_run(&run.id, &[], &[]).await.unwrap()
        } else {
            service.control(&run.id, "resume").await.unwrap()
        };
        assert_eq!(resumed.state, "running");
        assert!(resumed
            .attempts
            .iter()
            .filter(|a| a.phase == "pending")
            .all(|a| a.wait_until.is_none()));
        tick(&service).await;
        assert_eq!(backend.refusals.load(Ordering::SeqCst), 2);
        dir.close().await;
    }
}

#[tokio::test]
async fn quota_resources_resume_preserves_other_backoffs_and_dispatch_deadline() {
    let (dir, service, backend) = setup_quota(false, false).await;
    let request = two_accounts(&service, false).await;
    let run = service.start_run(request.clone()).await.unwrap();
    service
        .store
        .set_run_state(&run.id, "paused")
        .await
        .unwrap();
    for (index, mut attempt) in run.attempts.clone().into_iter().enumerate() {
        attempt.wait_until = Some(backend.reset);
        attempt.reason = Some(if index == 0 {
            "Waiting for local resources: invented contention".into()
        } else {
            "Refused before any answer; tried again. invented transient failure".into()
        });
        service.store.save_attempt(&attempt).await.unwrap();
    }
    let resumed = service.control(&run.id, "resume").await.unwrap();
    assert!(resumed
        .attempts
        .iter()
        .all(|a| a.wait_until == Some(backend.reset)));
    service
        .store
        .set_run_state(&run.id, "paused")
        .await
        .unwrap();
    let mut expired = request;
    expired
        .execution_limits
        .as_mut()
        .unwrap()
        .dispatch_not_after_ms = Some(now() - 1);
    service
        .store
        .set_run_request(&run.id, &expired)
        .await
        .unwrap();
    let error = service.control(&run.id, "resume").await.unwrap_err();
    assert_eq!(error.code, "dispatch_deadline");
    let stopped = service.store.run(&run.id).await.unwrap();
    assert_eq!(stopped.state, "paused");
    assert_eq!(
        stopped
            .request
            .execution_limits
            .unwrap()
            .dispatch_not_after_ms,
        expired.execution_limits.unwrap().dispatch_not_after_ms
    );
    assert!(stopped
        .attempts
        .iter()
        .all(|a| a.wait_until == Some(backend.reset)));
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
    dir.close().await;
}
