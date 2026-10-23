//! Offline manual judging failures: a new error must not leave an older
//! cancellation reason on a retained answer or discard newly saved votes.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

struct InterruptedPanel {
    fake: Arc<FakeBackend>,
    error: BenchmarkError,
    paid_vote: bool,
    calls: AtomicU64,
    saved: std::sync::Mutex<Option<Attempt>>,
}

impl ExecutionBackend for InterruptedPanel {
    fn unsupported(&self, c: &Configuration, d: &BenchmarkDraft) -> Option<String> {
        self.fake.unsupported(c, d)
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
        _: &'a Store,
        _: Attempt,
        _: BenchmarkVersion,
        _: u32,
        _: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async { panic!("Manual judging must never regenerate the candidate") })
    }

    fn judge<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
        version: &'a BenchmarkVersion,
        stop: JudgeStop,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            assert!(!stop.halted(store).await?);
            self.calls.fetch_add(1, Ordering::SeqCst);
            let marker = Evaluation {
                id: "invented-new-render".into(),
                evaluator_revision: version.manifest.evaluator.revision.clone(),
                verdict: "rendered".into(),
                score: None,
                reason: "Invented text preserved for the panel".into(),
                created_at: now(),
                provenance: "render".into(),
                artifacts: Vec::new(),
                details: Some(json!({"judgeBatchId":"invented-new-batch"})),
                judge: None,
                usage: None,
            };
            attempt.evaluations.push(marker.clone());
            if self.paid_vote {
                attempt.evaluations.push(Evaluation {
                    id: "invented-new-paid-vote".into(),
                    provenance: "judge".into(),
                    verdict: "judged".into(),
                    score: Some(0.8),
                    judge: Some(attempt.configuration.clone()),
                    usage: Some(TokenUsage {
                        input: Some(10),
                        output: Some(5),
                        cost: Some(0.01),
                        ..Default::default()
                    }),
                    ..marker
                });
            }
            store.save_attempt(&attempt).await?;
            let saved = store.attempt(&attempt.id).await?;
            *self.saved.lock().unwrap() = Some(saved);
            Err(self.error.clone())
        })
    }
}

async fn retained_answer(service: &BenchmarkService) -> Attempt {
    let request = tests::creative_request(service).await;
    let run = service.start_run(request).await.unwrap();
    let mut attempt = run.attempts[0].clone();
    let version = service.store.version(&attempt.version_id).await.unwrap();
    attempt.phase = "terminal".into();
    attempt.outcome = Some("pending_review".into());
    attempt.reason = Some(JUDGING_STOPPED.into());
    attempt.started_at = Some(now() - 1000);
    attempt.finished_at = Some(now());
    attempt.output = Some(version.manifest.evaluator.known_good.clone());
    attempt.evaluations.push(
        evaluate(&version.manifest, attempt.output.as_deref().unwrap())
            .await
            .unwrap(),
    );
    attempt.session_id = Some("invented-paid-candidate-session".into());
    attempt.host_run_id = Some("invented-paid-candidate-turn".into());
    attempt.usage.input = Some(123);
    attempt.usage.output = Some(45);
    attempt.evidence_hash = Some(
        fixtures::seal(&service.store.root, &attempt, &json!({"invented":true}))
            .await
            .unwrap(),
    );
    service.store.save_attempt(&attempt).await.unwrap();
    service
        .store
        .set_run_state(&run.id, "cancelled")
        .await
        .unwrap();
    service.store.attempt(&attempt.id).await.unwrap()
}

#[tokio::test]
async fn manual_judge_admission_failure_replaces_stale_cancel_reason_without_replay() {
    interrupted_panel(
        BenchmarkError::new(
            JUDGE_ADMISSION_WAIT,
            "The resource queue is waiting for admission",
        ),
        false,
        "Waiting for local resources to judge: The resource queue is waiting for admission",
    )
    .await;
}

#[tokio::test]
async fn manual_judge_failure_preserves_latest_paid_vote_and_original_error() {
    interrupted_panel(
        BenchmarkError::new("infrastructure_failure", "Invented judge transport failure")
            .with_details(json!({"inventedDiagnostic":17})),
        true,
        "Judging failed: Invented judge transport failure",
    )
    .await;
}

async fn interrupted_panel(error: BenchmarkError, paid_vote: bool, reason: &str) {
    let (dir, mut service, fake) = tests::setup().await;
    let backend = Arc::new(InterruptedPanel {
        fake,
        error: error.clone(),
        paid_vote,
        calls: AtomicU64::new(0),
        saved: Default::default(),
    });
    Arc::get_mut(&mut service).unwrap().backend = backend.clone();
    let before = retained_answer(&service).await;
    let actual = service.rescore(&before.id).await.unwrap_err();
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(&error).unwrap()
    );
    let after = service.store.attempt(&before.id).await.unwrap();
    assert_eq!(after.reason.as_deref(), Some(reason));
    let history = service
        .store
        .diagnostics(&before.id, None, 100)
        .await
        .unwrap();
    let failure = history
        .items
        .iter()
        .find(|entry| entry.stage == "manual_judging")
        .unwrap();
    assert_eq!(failure.code, error.code);
    assert_eq!(failure.message, error.message);
    assert_eq!(failure.run_id, before.run_id);
    assert_eq!(failure.context["source"], "manual_rescore");
    // The new failure and the previous cancellation both survive independently
    // of the mutable reason displayed for the latest manual attempt.
    assert!(history
        .items
        .iter()
        .any(|entry| entry.message == JUDGING_STOPPED));
    let mut latest = backend.saved.lock().unwrap().take().unwrap();
    latest.reason = Some(reason.into());
    assert_eq!(
        serde_json::to_value(&after).unwrap(),
        serde_json::to_value(latest).unwrap(),
        "Only the reason may change after the panel saved its latest receipt"
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        after.evaluations.len(),
        before.evaluations.len() + 1 + usize::from(paid_vote)
    );
    assert_eq!(
        after.evaluations[before.evaluations.len()].id,
        "invented-new-render"
    );
    assert_eq!(
        serde_json::to_value(&after.evaluations[..before.evaluations.len()]).unwrap(),
        serde_json::to_value(&before.evaluations).unwrap()
    );
    if paid_vote {
        let vote = after.evaluations.last().unwrap();
        assert_eq!(vote.id, "invented-new-paid-vote");
        assert_eq!(vote.usage.as_ref().unwrap().cost, Some(0.01));
    }
    let mut expected = serde_json::to_value(&before).unwrap();
    let mut saved = serde_json::to_value(&after).unwrap();
    // Outcome is derived from the saved votes; the candidate receipt is not.
    for key in ["reason", "evaluations", "outcome"] {
        expected.as_object_mut().unwrap().remove(key);
        saved.as_object_mut().unwrap().remove(key);
    }
    assert_eq!(
        saved, expected,
        "The candidate receipt must remain unchanged"
    );
    assert_eq!(
        service.store.run_state(&before.run_id).await.unwrap(),
        "cancelled"
    );
    dir.close().await;
}

#[tokio::test]
async fn manual_judge_stop_is_independent_of_closed_signal_and_cancelled_run() {
    let (dir, service, _) = tests::setup().await;
    let attempt = retained_answer(&service).await;
    let manual = JudgeStop::manual();
    assert!(!manual.cancelled());
    assert!(!manual.turn_cancelled(&service.store).await.unwrap());
    assert!(!manual.halted(&service.store).await.unwrap());
    let (_sender, receiver) = watch::channel(false);
    let automatic = JudgeStop::run(&attempt.run_id, receiver);
    assert!(automatic.halted(&service.store).await.unwrap());
    dir.close().await;
}
