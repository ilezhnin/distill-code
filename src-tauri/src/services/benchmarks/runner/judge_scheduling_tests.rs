//! Invented saved answers exercise scheduling without provider calls.
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

#[derive(Default)]
struct SchedulingBackend {
    fake: FakeBackend,
    blocked: Mutex<Option<String>>,
    probes: Mutex<Vec<String>>,
    paced: AtomicBool,
}

impl ExecutionBackend for SchedulingBackend {
    fn paces_preparation(&self) -> bool {
        self.paced.load(Ordering::SeqCst)
    }

    fn resource_admission<'a>(
        &'a self,
        configuration: &'a Configuration,
    ) -> BoxFuture<'a, Result<()>> {
        self.fake.resource_admission(configuration)
    }

    fn unsupported(&self, _: &Configuration, _: &BenchmarkDraft) -> Option<String> {
        None
    }

    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        refresh: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        self.fake.inventory(provider, account, refresh)
    }

    fn execute<'a>(
        &'a self,
        store: &'a Store,
        attempt: Attempt,
        version: BenchmarkVersion,
        timeout: u32,
        cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            admission_window::admitted(&store.root.display().to_string(), &attempt.id);
            self.fake
                .execute(store, attempt, version, timeout, cancel)
                .await
        })
    }

    fn judge<'a>(
        &'a self,
        store: &'a Store,
        attempt: Attempt,
        version: &'a BenchmarkVersion,
        stop: JudgeStop,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            self.probes.lock().unwrap().push(attempt.id.clone());
            if self.blocked.lock().unwrap().as_deref() == Some(attempt.id.as_str()) {
                return Err(BenchmarkError::new(
                    "resource_busy",
                    "Invented rendering cannot fit; no judge turn started",
                ));
            }
            admission_window::admitted(
                &store.root.display().to_string(),
                &format!("judge:{}", attempt.id),
            );
            self.fake.judge(store, attempt, version, stop).await
        })
    }
}

#[tokio::test]
async fn judge_scheduler_reserves_preparation_before_fresh_candidates_can_take_it() {
    let (dir, service, backend) = setup().await;
    backend.paced.store(true, Ordering::SeqCst);
    backend.fake.turn_ms.store(1, Ordering::SeqCst);
    let run = saved_answers(&service, 2).await;
    // Only one answer was generated. The second cell still needs its first
    // candidate; both share one unconfirmed preparation place.
    let mut pending = run.attempts[1].clone();
    pending.phase = "pending".into();
    pending.outcome = None;
    pending.output = None;
    pending.session_id = None;
    pending.evidence_hash = None;
    pending.reason = None;
    service.store.save_attempt(&pending).await.unwrap();

    let mut flights = tokio::task::JoinSet::new();
    let mut tried = std::collections::HashSet::new();
    assert!(
        service
            .start_waiting_judge(&run, run.attempts[0].id.clone(), &mut flights, &mut tried,)
            .await
    );
    // The selected worker need not be polled before fill continues to new
    // candidates. Exercise that valid interleaving without timing sleeps.
    let scope = service.store.root.display().to_string();
    let competing = admission_window::begin(&scope, &pending.id);
    let candidate_took_place = competing.is_some();
    drop(competing);
    while let Some(result) = flights.join_next().await {
        result.unwrap();
    }
    assert_eq!(
        candidate_took_place, false,
        "a selected sealed answer must own its place before candidate resource probes"
    );
    assert_eq!(backend.fake.judges.load(Ordering::SeqCst), 1);
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
    assert_eq!(service.flying(&run.id).await, 0);
    assert!(admission_window::has_room(
        &service.store.root.display().to_string()
    ));
    let saved = service.store.attempt(&run.attempts[0].id).await.unwrap();
    assert_eq!(saved.output, run.attempts[0].output);
    assert_eq!(saved.session_id, run.attempts[0].session_id);
    assert_eq!(saved.evidence_hash, run.attempts[0].evidence_hash);
    // Reserving the panel did not lose or disable untouched candidate work.
    fill_once(&service, &mut tried).await;
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 1);
    dir.close().await;
}

async fn setup() -> (
    crate::test_support::TempRoot,
    Arc<BenchmarkService>,
    Arc<SchedulingBackend>,
) {
    let dir = crate::test_support::TempRoot::new();
    let store = Store::open(dir.path()).await.unwrap();
    dir.register(&store.pool);
    let backend = Arc::new(SchedulingBackend::default());
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

async fn saved_answers(service: &BenchmarkService, count: u32) -> BenchmarkRun {
    let mut request = tests::creative_request(service).await;
    request.repetitions = count;
    request.max_executions = count * 4;
    let run = service.start_run(request).await.unwrap();
    for a in &run.attempts {
        let mut saved = a.clone();
        saved.phase = AWAITING_JUDGES.into();
        saved.outcome = Some("pending_review".into());
        saved.output = Some("Invented sealed response".into());
        saved.session_id = Some(format!("invented-paid-session-{}", a.repetition));
        saved.evidence_hash = Some(format!("invented-paid-evidence-{}", a.repetition));
        saved.reason = Some(JUDGE_DISCOVERY_WAIT.into());
        service.store.save_attempt(&saved).await.unwrap();
    }
    let mut saved = service.store.run(&run.id).await.unwrap();
    // Run summaries deliberately omit output. Read authoritative receipts
    // for the no-replay/evidence comparison, including the saved activity.
    for attempt in &mut saved.attempts {
        *attempt = service.store.attempt(&attempt.id).await.unwrap();
    }
    saved
}

#[tokio::test]
async fn judge_scheduler_older_deferred_answers_precede_fresh_arrivals_but_not_quota() {
    let (dir, service, backend) = setup().await;
    let run = saved_answers(&service, 3).await;
    let at = now();
    let mut fresh = run.attempts[0].clone();
    fresh.finished_at = Some(at - 1_000);
    service.store.save_attempt(&fresh).await.unwrap();
    let mut older = run.attempts[1].clone();
    older
        .phase_times
        .get_or_insert_with(Default::default)
        .insert("judgeStarted".into(), at - 60_000);
    service.store.save_attempt(&older).await.unwrap();
    let mut quota = run.attempts[2].clone();
    quota.reason = Some(JUDGE_QUOTA_REASON.into());
    quota.wait_until = Some(at + 60_000);
    quota
        .phase_times
        .get_or_insert_with(Default::default)
        .insert("judgeStarted".into(), at - 120_000);
    service.store.save_attempt(&quota).await.unwrap();
    let mut tried = std::collections::HashSet::new();
    fill_once(&service, &mut tried).await;
    assert_eq!(*backend.probes.lock().unwrap(), vec![older.id]);
    assert_eq!(
        service.store.attempt(&quota.id).await.unwrap().wait_until,
        quota.wait_until
    );
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
    dir.close().await;
}

async fn fill_once(service: &Arc<BenchmarkService>, tried: &mut std::collections::HashSet<String>) {
    let mut flights = tokio::task::JoinSet::new();
    service.fill(&mut flights, tried).await.unwrap();
    while let Some(result) = flights.join_next().await {
        result.unwrap();
    }
}

#[tokio::test]
async fn judge_scheduler_rotates_after_an_unstarted_resource_refusal() {
    let (dir, service, backend) = setup().await;
    let run = saved_answers(&service, 3).await;
    *backend.blocked.lock().unwrap() = Some(run.attempts[0].id.clone());
    let scope = service.store.root.display().to_string();
    let mut tried = std::collections::HashSet::new();

    fill_once(&service, &mut tried).await;
    assert_eq!(backend.probes.lock().unwrap().len(), 1);
    assert!(!admission_window::remaining(&scope).is_zero());
    fill_once(&service, &mut tried).await;
    assert_eq!(
        backend.probes.lock().unwrap().len(),
        1,
        "other panels must respect the actual resource cooldown"
    );

    // A later broker retry is permitted, but the first rendering still
    // needs resources the two remaining saved answers do not need.
    admission_window::expire_wait(&scope);
    fill_once(&service, &mut tried).await;
    admission_window::expire_wait(&scope);
    fill_once(&service, &mut tried).await;

    assert_eq!(
        *backend.probes.lock().unwrap(),
        run.attempts
            .iter()
            .map(|a| a.id.clone())
            .collect::<Vec<_>>(),
        "a repeatedly refused first row must not monopolize every legal probe"
    );
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
    assert_eq!(backend.fake.judges.load(Ordering::SeqCst), 2);
    for original in &run.attempts {
        let current = service.store.attempt(&original.id).await.unwrap();
        assert_eq!(current.output, original.output);
        assert_eq!(current.session_id, original.session_id);
        assert_eq!(current.evidence_hash, original.evidence_hash);
    }
    assert_eq!(service.flying(&run.id).await, 0);
    dir.close().await;
}

#[tokio::test]
async fn judge_scheduler_duplicate_lane_claim_keeps_the_current_reservation() {
    let (dir, service, backend) = setup().await;
    let run = saved_answers(&service, 2).await;
    let scope = service.store.root.display().to_string();
    let mut flights = tokio::task::JoinSet::new();
    let mut tried = std::collections::HashSet::new();
    assert!(
        service
            .start_waiting_judge(&run, run.attempts[0].id.clone(), &mut flights, &mut tried)
            .await
    );
    assert!(
        !service
            .start_waiting_judge(&run, run.attempts[0].id.clone(), &mut flights, &mut tried)
            .await
    );
    assert!(
        !service
            .start_waiting_judge(&run, run.attempts[1].id.clone(), &mut flights, &mut tried)
            .await
    );
    assert!(!admission_window::has_room(&scope));
    assert_eq!(service.flying(&run.id).await, 1);
    while let Some(result) = flights.join_next().await {
        result.unwrap();
    }
    assert_eq!(backend.fake.judges.load(Ordering::SeqCst), 1);
    assert_eq!(service.flying(&run.id).await, 0);
    assert!(admission_window::has_room(&scope));
    dir.close().await;
}

#[tokio::test]
async fn judge_scheduler_full_preparation_releases_its_unstarted_lane() {
    let (dir, service, backend) = setup().await;
    let run = saved_answers(&service, 1).await;
    let scope = service.store.root.display().to_string();
    let other = admission_window::begin(&scope, "invented-other-preparation").unwrap();
    let mut flights = tokio::task::JoinSet::new();
    let mut tried = std::collections::HashSet::new();
    assert!(
        !service
            .start_waiting_judge(&run, run.attempts[0].id.clone(), &mut flights, &mut tried)
            .await
    );
    assert!(flights.is_empty());
    assert!(tried.is_empty());
    assert_eq!(service.flying(&run.id).await, 0);
    assert_eq!(backend.fake.judges.load(Ordering::SeqCst), 0);
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
    drop(other);
    fill_once(&service, &mut tried).await;
    assert_eq!(backend.fake.judges.load(Ordering::SeqCst), 1);
    dir.close().await;
}

#[tokio::test]
async fn judge_scheduler_pause_and_panic_release_reserved_preparation() {
    for panic in [false, true] {
        let (dir, service, backend) = setup().await;
        let run = saved_answers(&service, 1).await;
        let original = &run.attempts[0];
        backend.fake.panic_judges.store(panic, Ordering::SeqCst);
        backend.fake.hold_judges.store(!panic, Ordering::SeqCst);
        let scope = service.store.root.display().to_string();
        let job = format!("judge:{}", original.id);
        let mut flights = tokio::task::JoinSet::new();
        let mut tried = std::collections::HashSet::new();
        assert!(
            service
                .start_waiting_judge(&run, original.id.clone(), &mut flights, &mut tried)
                .await
        );
        if !panic {
            tokio::time::timeout(
                Duration::from_secs(5),
                backend.fake.judge_entered.notified(),
            )
            .await
            .unwrap();
            service.control(&run.id, "pause").await.unwrap();
            backend.fake.judge_release.notify_one();
        }
        while let Some(result) = flights.join_next().await {
            result.unwrap();
        }
        assert_eq!(service.flying(&run.id).await, 0);
        assert!(admission_window::has_room(&scope));
        assert!(
            !admission_window::finished(&scope, &job),
            "no admitted marker survives worker exit"
        );
        let after = service.store.attempt(&original.id).await.unwrap();
        assert_eq!(after.output, original.output);
        assert_eq!(after.session_id, original.session_id);
        assert_eq!(after.evidence_hash, original.evidence_hash);
        assert_eq!(
            serde_json::to_value(&after.evaluations).unwrap(),
            serde_json::to_value(&original.evaluations).unwrap()
        );
        assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 0);
        if !panic {
            assert_eq!(after.reason.as_deref(), Some(JUDGING_STOPPED));
        } else {
            assert!(after.reason.as_deref().unwrap().contains("panicked"));
        }
        dir.close().await;
    }
}
