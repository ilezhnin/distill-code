//! A tick lasts while anything of any run flies, so under nonstop
//! measurement it hardly ends. What a tick does at its start (a waited-out
//! cell starting again, recovery, baking, campaign admission) must also
//! happen while it lasts. Each test keeps another run's turn open throughout.
use super::tests::{serial_request, setup};
use super::*;
use std::sync::atomic::Ordering;

/// The first attempt of `run_id` once `ready` holds for it, within a bound
/// against a hang.
async fn attempt_when(
    service: &BenchmarkService,
    run_id: &str,
    what: &str,
    ready: impl Fn(&Attempt) -> bool,
) -> Attempt {
    let bound = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let attempt = service.store.run(run_id).await.unwrap().attempts[0].clone();
        if ready(&attempt) {
            return attempt;
        }
        assert!(
            std::time::Instant::now() < bound,
            "never {what}: {attempt:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// One cell and one turn, like a measurement run.
async fn one_cell(service: &BenchmarkService, key: &str) -> RunRequest {
    let mut request = serial_request(service).await;
    request.request_key = key.into();
    request.repetitions = 1;
    request.max_executions = 1;
    request
}

/// A tick held open by another run's turn, as the Z.ai and Grok turns held
/// it on 2026-10-17. Every fake turn stays open until its run is cancelled.
struct HeldPass {
    run: BenchmarkRun,
    pass: tokio::task::JoinHandle<Result<()>>,
}

impl HeldPass {
    async fn open(service: &Arc<BenchmarkService>, backend: &FakeBackend) -> Self {
        backend.hold_turns.store(true, Ordering::SeqCst);
        let run = service
            .start_run(one_cell(service, "held-pass-run").await)
            .await
            .unwrap();
        let pass = tokio::spawn({
            let service = service.clone();
            async move { service.tick().await }
        });
        attempt_when(service, &run.id, "flew", |a| a.phase == "running").await;
        Self { run, pass }
    }

    /// Asserts the holding turn still flies, so what happened did so within
    /// the same tick.
    async fn still_open(&self, service: &BenchmarkService) {
        let holder = service.store.run(&self.run.id).await.unwrap().attempts[0].clone();
        assert_eq!(holder.phase, "running");
        assert!(!self.pass.is_finished());
    }

    async fn close(self, service: &BenchmarkService, others: &[&str]) {
        for id in others.iter().copied().chain([self.run.id.as_str()]) {
            service.control(id, "cancel").await.unwrap();
        }
        tokio::time::timeout(Duration::from_secs(30), self.pass)
            .await
            .expect("the tick ends once its turns are cancelled")
            .unwrap()
            .unwrap();
    }
}

/// Pauses `run_id` until it is paused, gives its first cell the wait that
/// ends at `until`, and resumes it.
async fn pause_and_resume(service: &BenchmarkService, run_id: &str, until: i64) {
    service.control(run_id, "pause").await.unwrap();
    let bound = std::time::Instant::now() + Duration::from_secs(15);
    while service.store.run_state(run_id).await.unwrap() != "paused" {
        assert!(std::time::Instant::now() < bound, "never paused");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let mut waiting = service.store.run(run_id).await.unwrap().attempts[0].clone();
    waiting.wait_until = Some(until);
    service.store.save_attempt(&waiting).await.unwrap();
    service.control(run_id, "resume").await.unwrap();
}

/// Run 3adab45e: a cell put back to wait for local resources stayed pending
/// for 18 minutes after its wait, through two pauses and resumes, because a
/// tick started each cell once. A cell keeps a wait still ahead through a
/// pause and a resume, and starts again within the tick once the wait is
/// over, whether it ended before the second resume or after it.
#[tokio::test]
async fn a_waited_out_cell_starts_again_while_another_run_flies() {
    for wait_left_at_resume_ms in [-1_000, 1_500] {
        let (dir, service, backend) = setup().await;
        let held = HeldPass::open(&service, &backend).await;
        let mut request = one_cell(&service, "held-pass-waiting-run").await;
        request.configurations[0].account_id = Some("second-account".into());
        request.execution_limits = Some(RunExecutionLimits {
            retry_policy: RunRetryPolicy::None,
            dispatch_not_after_ms: None,
        });
        backend.resource_refusals.store(1, Ordering::SeqCst);
        let run = service.start_run(request).await.unwrap();
        service.wake.notify_one();
        attempt_when(&service, &run.id, "waited for local resources", |a| {
            a.phase == "pending" && a.wait_until.is_some()
        })
        .await;
        pause_and_resume(&service, &run.id, now() + 60_000).await;
        tokio::time::sleep(Duration::from_millis(1_200)).await;
        let still = service.store.run(&run.id).await.unwrap().attempts[0].clone();
        assert_eq!(still.phase, "pending", "a wait still ahead holds the cell");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        pause_and_resume(&service, &run.id, now() + wait_left_at_resume_ms).await;
        let started =
            attempt_when(&service, &run.id, "started again", |a| a.phase == "running").await;
        assert!(started.started_at.is_some(), "{wait_left_at_resume_ms}");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        held.still_open(&service).await;
        held.close(&service, &[run.id.as_str()]).await;
        dir.close().await;
    }
}

/// A sealed generation whose evaluation the sandbox refused asks again once
/// its short pause is over, not once every other run's turns have landed.
#[tokio::test]
async fn a_refused_evaluation_is_asked_again_while_another_run_flies() {
    let (dir, service, backend) = setup().await;
    let run = service
        .start_run(one_cell(&service, "held-pass-evaluation-run").await)
        .await
        .unwrap();
    let version = service
        .store
        .version(&run.attempts[0].version_id)
        .await
        .unwrap();
    let mut sealed = run.attempts[0].clone();
    sealed.phase = "interrupted".into();
    sealed.outcome = Some("completed".into());
    sealed.output = Some(version.manifest.evaluator.known_good.clone());
    sealed.started_at = Some(now());
    sealed.finished_at = Some(now());
    sealed.evidence_hash = Some(
        fixtures::seal(&service.store.root, &sealed, &json!({}))
            .await
            .unwrap(),
    );
    service.store.save_attempt(&sealed).await.unwrap();
    // The tick's first recovery meets the refusal; only a later one in the
    // same tick can evaluate.
    backend.evaluation_refusals.store(1, Ordering::SeqCst);
    let held = HeldPass::open(&service, &backend).await;
    let settled = attempt_when(&service, &run.id, "evaluated", |a| a.phase == "terminal").await;
    assert_eq!(settled.outcome.as_deref(), Some("pass"));
    assert_eq!(backend.evaluations.load(Ordering::SeqCst), 2);
    held.still_open(&service).await;
    held.close(&service, &[]).await;
    dir.close().await;
}

/// A run whose window closed while nothing of it flies is baked within the
/// tick, so its sitting does not stay open behind other runs' turns.
#[tokio::test]
async fn a_closed_window_is_baked_while_another_run_flies() {
    let (dir, service, backend) = setup().await;
    let held = HeldPass::open(&service, &backend).await;
    // The same configuration: its lane is taken, so the cell never starts.
    let run = service
        .start_run(one_cell(&service, "held-pass-closed-run").await)
        .await
        .unwrap();
    sqlx::query("UPDATE run_plans SET created_at=? WHERE id=?")
        .bind(now() - super::super::analysis::RUN_WINDOW_MS - 60_000)
        .bind(&run.id)
        .execute(&service.store.pool)
        .await
        .unwrap();
    let bound = std::time::Instant::now() + Duration::from_secs(15);
    while service.store.run(&run.id).await.unwrap().baked_at.is_none() {
        assert!(std::time::Instant::now() < bound, "never baked");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    held.still_open(&service).await;
    held.close(&service, &[]).await;
    dir.close().await;
}

/// A campaign schedule that falls due starts its run within the tick.
#[tokio::test]
async fn a_due_schedule_starts_its_run_while_another_run_flies() {
    let (dir, service, backend) = setup().await;
    let held = HeldPass::open(&service, &backend).await;
    let mut request = one_cell(&service, "held-pass-schedule-request").await;
    request.configurations[0].account_id = Some("second-account".into());
    let schedule = service
        .save_schedule(Schedule {
            id: String::new(),
            name: "Held pass campaign".into(),
            enabled: true,
            interval_minutes: 60,
            next_due_at: now() + 500,
            request,
            missed: false,
            discovery: None,
            max_runs: 2,
            max_total_executions: 10,
            generated_run_ids: Vec::new(),
            paused_reason: None,
        })
        .await
        .unwrap();
    let prefix = format!("schedule:{}:", schedule.id);
    let bound = std::time::Instant::now() + Duration::from_secs(15);
    let started = loop {
        let runs = service.store.all_runs().await.unwrap();
        if let Some(run) = runs
            .into_iter()
            .find(|run| run.request.request_key.starts_with(&prefix))
        {
            break run;
        }
        assert!(std::time::Instant::now() < bound, "the schedule never ran");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    held.still_open(&service).await;
    held.close(&service, &[started.id.as_str()]).await;
    dir.close().await;
}

#[test]
fn repeated_local_refusals_wait_longer_up_to_a_minute() {
    let waits: Vec<i64> = (1..=8).map(unstarted_wait_ms).collect();
    assert_eq!(
        waits,
        [2_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]
    );
    let id = "invented-refused-attempt";
    assert_eq!(local_refusal_wait(id), 2_000);
    assert_eq!(local_refusal_wait(id), 5_000);
    local_refusals_cleared(id);
    assert_eq!(local_refusal_wait(id), 2_000);
    local_refusals_cleared(id);
}

/// The broker refuses a cell's turn before any provider process, so the
/// runner puts the cell back itself (and, for a workflow root, discards the
/// refused try's steps and clocks); it starts again within the tick by its
/// own wait, which grows when the refusal repeats.
#[tokio::test]
async fn a_cell_the_broker_refused_starts_again_within_the_tick() {
    for workflow in [false, true] {
        let (dir, service, backend) = setup().await;
        let held = HeldPass::open(&service, &backend).await;
        let mut request = one_cell(&service, "held-pass-refused-run").await;
        if workflow {
            let mut draft = seed_definitions().remove(0);
            draft.split = "train".into();
            draft.workflow = Some(WorkflowSpec {
                schema_version: 1,
                driver_revision: "held-pass-test-v1".into(),
                steps: vec![
                    WorkflowStep {
                        id: "plan".into(),
                        prompt: "Prepare the public plan.".into(),
                        include_previous_output: false,
                        scope: None,
                    },
                    WorkflowStep {
                        id: "answer".into(),
                        prompt: "Produce the final structured answer.".into(),
                        include_previous_output: true,
                        scope: None,
                    },
                ],
            });
            let definition = service.store.save_draft(None, None, draft).await.unwrap();
            let version = service.store.publish(&definition.id, 1).await.unwrap();
            request.version_ids = vec![version.id];
            request.max_executions = 2;
        }
        request.configurations[0].account_id = Some("second-account".into());
        request.execution_limits = Some(RunExecutionLimits {
            retry_policy: RunRetryPolicy::None,
            dispatch_not_after_ms: None,
        });
        let refusals = if workflow { 1 } else { 2 };
        backend.resource_refusals.store(refusals, Ordering::SeqCst);
        let run = service.start_run(request).await.unwrap();
        service.wake.notify_one();
        let waiting = |a: &Attempt| a.phase == "pending" && a.wait_until.is_some();
        let first = attempt_when(&service, &run.id, "waited", waiting)
            .await
            .wait_until
            .unwrap();
        if !workflow {
            let again = attempt_when(&service, &run.id, "waited again", |a| {
                waiting(a) && a.wait_until != Some(first)
            })
            .await;
            assert!(again.wait_until.unwrap() >= first + 5_000);
        }
        let started = attempt_when(&service, &run.id, "started again", |a| {
            a.started_at.is_some() && matches!(a.phase.as_str(), "preparing" | "running")
        })
        .await;
        assert_eq!(started.outcome, None, "{workflow}");
        let calls = std::time::Instant::now() + Duration::from_secs(15);
        while backend.calls.load(Ordering::SeqCst) < 2 {
            assert!(
                std::time::Instant::now() < calls,
                "no turn after the refusal"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        held.still_open(&service).await;
        held.close(&service, &[run.id.as_str()]).await;
        dir.close().await;
    }
}
