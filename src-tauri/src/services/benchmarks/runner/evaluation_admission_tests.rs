//! Invented evaluator leases exercise the real runner's preparation lifecycle.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
struct EvaluatorBackend {
    fake: FakeBackend,
    evaluations: AtomicU64,
    waiting: tokio::sync::Notify,
    grant: tokio::sync::Notify,
    admitted: tokio::sync::Notify,
    finish: tokio::sync::Notify,
}

impl ExecutionBackend for EvaluatorBackend {
    fn unsupported(&self, _: &Configuration, _: &BenchmarkDraft) -> Option<String> {
        None
    }
    fn paces_preparation(&self) -> bool {
        true
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
    fn evaluate_output<'a>(
        &'a self,
        draft: &'a BenchmarkDraft,
        output: &'a str,
    ) -> BoxFuture<'a, Result<Evaluation>> {
        Box::pin(async move {
            if self.evaluations.fetch_add(1, Ordering::SeqCst) == 0 {
                self.waiting.notify_one();
                self.grant.notified().await;
                // This event is supplied by the native lease boundary in
                // production, never by merely entering evaluate_output.
                sandbox::test_workload_admission(sandbox::ResourceClass::PairedCheck);
                self.admitted.notify_one();
                self.finish.notified().await;
            }
            fake_evaluate(draft, output).await
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
            admission_window::admitted(
                &store.root.display().to_string(),
                &format!("judge:{}", attempt.id),
            );
            self.fake.judges.fetch_add(1, Ordering::SeqCst);
            attempt.outcome = Some("judged".into());
            Ok(attempt)
        })
    }
}

async fn notified(notice: &tokio::sync::Notify) {
    tokio::time::timeout(Duration::from_secs(5), notice.notified())
        .await
        .unwrap();
}

#[tokio::test]
async fn evaluation_admission_releases_preparing_before_the_slow_check_finishes() {
    let dir = crate::test_support::TempRoot::new();
    let store = Store::open(dir.path()).await.unwrap();
    dir.register(&store.pool);
    let backend = Arc::new(EvaluatorBackend::default());
    backend.fake.turn_ms.store(1, Ordering::SeqCst);
    let service = Arc::new(BenchmarkService {
        store,
        backend: backend.clone(),
        wake: tokio::sync::Notify::new(),
        active: Default::default(),
        queries: Default::default(),
        app: None,
    });
    let mut request = tests::serial_request(&service).await;
    request.repetitions = 1;
    request.max_executions = 1;
    let run = service.start_run(request.clone()).await.unwrap();
    service
        .store
        .set_run_state(&run.id, "paused")
        .await
        .unwrap();
    let mut version = service
        .store
        .version(&run.attempts[0].version_id)
        .await
        .unwrap();
    // This backend grades a repository patch against the invented reference;
    // no native worker or real repository is needed to exercise admission.
    version.manifest.evaluator.kind = super::super::repository::EVALUATOR.into();
    let mut completed = run.attempts[0].clone();
    completed.phase = "collecting".into();
    completed.outcome = Some("completed".into());
    completed.output = Some(version.manifest.evaluator.known_good.clone());
    service.store.save_attempt(&completed).await.unwrap();
    let scope = service.store.root.display().to_string();
    let evaluation_scope = admission_window::evaluation_scope(&scope);
    let job = format!("evaluation:{}", completed.id);
    let (_cancel, receiver) = watch::channel(false);
    let evaluator = {
        let service = service.clone();
        tokio::spawn(async move {
            service
                .settle(completed, &version, None, JudgeStop::run(&run.id, receiver))
                .await
        })
    };
    notified(&backend.waiting).await;
    assert!(
        !admission_window::has_room(&evaluation_scope),
        "unconfirmed evaluation is still preparing"
    );
    assert!(
        admission_window::has_room(&scope),
        "a queued evaluator never occupies the light lane"
    );
    assert!(!evaluator.is_finished());

    let mut draft = seed_definitions()
        .into_iter()
        .find(|draft| draft.work_class_id == "creative")
        .unwrap();
    draft.name = "Invented concurrent light panel".into();
    draft.split = "train".into();
    let definition = service.store.save_draft(None, None, draft).await.unwrap();
    request.version_ids = vec![service.store.publish(&definition.id, 1).await.unwrap().id];
    request.request_key = "invented-concurrent-light".into();
    request.max_executions = 4;
    let light = service.start_run(request).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), service.tick())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(backend.fake.calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.fake.judges.load(Ordering::SeqCst), 1);
    let settled = service.store.run(&light.id).await.unwrap();
    assert_eq!(settled.attempts[0].phase, "terminal");
    // The invented panel records no signed votes, so its result correctly
    // remains incomplete. Its invocation proves throughput, not certification.
    assert_eq!(
        settled.attempts[0].outcome.as_deref(),
        Some("pending_review")
    );
    assert!(
        !evaluator.is_finished(),
        "light generation, local grading and judging did not wait for the queued checker"
    );
    assert!(!admission_window::has_room(&evaluation_scope));
    backend.grant.notify_one();
    notified(&backend.admitted).await;
    assert!(
        admission_window::has_room(&evaluation_scope),
        "an admitted evaluator no longer counts as preparing"
    );
    assert!(!evaluator.is_finished());
    backend.finish.notify_one();
    assert_eq!(
        evaluator.await.unwrap().unwrap().outcome.as_deref(),
        Some("pass")
    );
    assert!(
        !admission_window::finished(&evaluation_scope, &job),
        "no running marker leaks after completion"
    );
    dir.close().await;
}

#[tokio::test]
async fn evaluation_admission_observer_filters_helpers_and_is_task_local() {
    let count = Arc::new(AtomicU64::new(0));
    let observed = count.clone();
    sandbox::with_workload_admission(
        move || {
            observed.fetch_add(1, Ordering::SeqCst);
        },
        async {
            sandbox::test_workload_admission(sandbox::ResourceClass::Preparation);
            sandbox::test_workload_admission(sandbox::ResourceClass::Text);
            assert_eq!(count.load(Ordering::SeqCst), 0);
            tokio::spawn(async {
                sandbox::test_workload_admission(sandbox::ResourceClass::Check);
            })
            .await
            .unwrap();
            assert_eq!(
                count.load(Ordering::SeqCst),
                0,
                "another task cannot admit this evaluator"
            );
            sandbox::with_workload_admission(|| {}, async {
                sandbox::test_workload_admission(sandbox::ResourceClass::Check);
            })
            .await;
            assert_eq!(
                count.load(Ordering::SeqCst),
                0,
                "a nested evaluator owns its own observer"
            );
            for class in [
                sandbox::ResourceClass::Check,
                sandbox::ResourceClass::PairedCheck,
                sandbox::ResourceClass::Browser,
            ] {
                sandbox::test_workload_admission(class);
            }
            assert_eq!(count.load(Ordering::SeqCst), 3);
        },
    )
    .await;
    sandbox::test_workload_admission(sandbox::ResourceClass::Check);
    assert_eq!(
        count.load(Ordering::SeqCst),
        3,
        "completed observers do not survive their scope"
    );
}

#[tokio::test]
async fn restored_preparation_waits_stay_in_their_lane_and_preserve_account_waits() {
    for (phase, reason, light_wait, evaluation_wait) in [
        ("collecting", EVALUATION_WAIT, false, true),
        ("interrupted", EVALUATION_WAIT, false, true),
        ("terminal", EVALUATION_WAIT, false, false),
        (
            "pending",
            "Waiting for local resources: invented pressure",
            true,
            false,
        ),
        (
            "pending",
            "Waiting for quota reset: invented account",
            false,
            false,
        ),
    ] {
        let (dir, service, _) = tests::setup().await;
        let mut request = tests::serial_request(&service).await;
        request.repetitions = 1;
        request.max_executions = 1;
        let run = service.start_run(request).await.unwrap();
        let mut attempt = run.attempts[0].clone();
        attempt.phase = phase.into();
        attempt.reason = Some(reason.into());
        attempt.wait_until = Some(now() + 90_000);
        service.store.save_attempt(&attempt).await.unwrap();
        // fill restores durable deadlines but does not dispatch a pausing run.
        service
            .store
            .set_run_state(&run.id, "pausing")
            .await
            .unwrap();
        service
            .fill(&mut tokio::task::JoinSet::new(), &mut Default::default())
            .await
            .unwrap();
        let scope = service.store.root.display().to_string();
        assert_eq!(
            !admission_window::remaining(&scope).is_zero(),
            light_wait,
            "{phase}: {reason}"
        );
        assert_eq!(
            !admission_window::remaining(&admission_window::evaluation_scope(&scope)).is_zero(),
            evaluation_wait,
            "{phase}: {reason}"
        );
        let saved = service.store.attempt(&attempt.id).await.unwrap();
        assert_eq!(saved.wait_until, attempt.wait_until);
        assert_eq!(saved.reason, attempt.reason);
        dir.close().await;
    }
}
