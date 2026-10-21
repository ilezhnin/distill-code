//! A cell the local resource broker refused before any provider process
//! started waits in the queue, at whatever stage it was refused, and counts
//! neither as an attempt nor as a failure. Anything a provider saw settles.
use super::tests::{serial_request, setup};
use super::*;
use std::sync::atomic::Ordering;

/// The refusals the trusted pre-spawn path reported on 2026-10-16, and the
/// one an admission window that closes in the queue reports instead of an
/// expired native deadline.
const UNSTARTED: [&str; 3] = [
    "resource_busy: benchmark resource capacity is queued; no provider process started",
    "resource_busy: Windows headroom evidence expired before execution; no provider process started",
    "resource_busy: benchmark preparation queue expired before worker startup",
];

/// A one-cell run of a two-step workflow on the native wall clock, like the
/// v4 cases the live run lost.
pub(super) async fn workflow_request(
    service: &BenchmarkService,
    retry_policy: RunRetryPolicy,
) -> RunRequest {
    let mut draft = seed_definitions().remove(0);
    draft.split = "train".into();
    draft.environment["nativeBudgetRecipe"] = json!(super::super::artifact_context::CLOCK_RECIPE);
    draft.limits.timeout_seconds = 600;
    draft.workflow = Some(WorkflowSpec {
        schema_version: 1,
        driver_revision: "unstarted-admission-test-v1".into(),
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
    let mut request = serial_request(service).await;
    request.version_ids = vec![version.id];
    request.repetitions = 1;
    // One turn per step.
    request.max_executions = 2;
    request.timeout_seconds = 600;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy,
        dispatch_not_after_ms: None,
    });
    request
}

/// The prepared step rows and frozen clocks a root holds.
async fn prepared(service: &BenchmarkService, root: &str) -> (i64, i64) {
    let steps = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_steps WHERE root_attempt_id=?")
        .bind(root)
        .fetch_one(&service.store.pool)
        .await
        .unwrap();
    let clocks = sqlx::query_scalar("SELECT COUNT(*) FROM task_budget_bindings WHERE root_id=?")
        .bind(root)
        .fetch_one(&service.store.pool)
        .await
        .unwrap();
    (steps, clocks)
}

#[tokio::test]
async fn only_untouched_attempts_in_preparation_count_as_never_started() {
    let (dir, service, _) = setup().await;
    let run = service
        .start_run(serial_request(&service).await)
        .await
        .unwrap();
    let mut attempt = run.attempts[0].clone();
    attempt.phase = "preparing".into();
    for message in UNSTARTED {
        let error = host_error(message.into());
        assert_eq!(error.code, "resource_busy");
        assert!(never_started(&attempt, &error), "{message}");
    }
    let busy = host_error(UNSTARTED[0].into());
    let step = WorkflowStepEvidence {
        root_task_id: attempt.id.clone(),
        step_id: "plan".into(),
        parent_step_id: None,
        entry_state_hash: "invented-entry".into(),
        attempt_id: "invented-step".into(),
        session_id: None,
        host_run_id: None,
        evidence_hash: None,
        outcome: None,
    };
    let mut prepared_step = attempt.clone();
    prepared_step.workflow_steps = vec![step.clone()];
    assert!(never_started(&prepared_step, &busy));
    let mut seen = Vec::new();
    let mut a = attempt.clone();
    a.session_id = Some("invented-session".into());
    seen.push(a);
    let mut a = attempt.clone();
    a.host_run_id = Some("invented-turn".into());
    seen.push(a);
    let mut a = attempt.clone();
    a.observed = Some(a.configuration.clone());
    seen.push(a);
    let mut a = attempt.clone();
    a.workflow_steps = vec![WorkflowStepEvidence {
        host_run_id: Some("invented-turn".into()),
        ..step
    }];
    seen.push(a);
    let mut a = attempt.clone();
    a.phase = "terminal".into();
    seen.push(a);
    for a in &seen {
        assert!(!never_started(a, &busy));
    }
    let refused = BenchmarkError::new("capability_missing", "the sign-in expires soon");
    assert!(!never_started(&attempt, &refused));
    dir.close().await;
}

/// The cells the live run lost: a workflow whose first step the broker
/// refused before any provider process. It waits instead of settling, under
/// either retry policy, keeps nothing of the refused try, and later runs as
/// a first attempt on a clock that starts with that admission.
#[tokio::test]
async fn a_workflow_refused_before_any_provider_waits_and_starts_afresh() {
    for retry_policy in [RunRetryPolicy::None, RunRetryPolicy::Automatic] {
        let (dir, service, backend) = setup().await;
        backend.resource_refusals.store(1, Ordering::SeqCst);
        let run = service
            .start_run(workflow_request(&service, retry_policy).await)
            .await
            .unwrap();
        service.tick().await.unwrap();
        let refused_at = now();
        let waiting = service.store.run(&run.id).await.unwrap();
        assert_eq!(waiting.state, "running", "{retry_policy:?}");
        let root = &waiting.attempts[0];
        assert_eq!(root.phase, "pending", "{retry_policy:?}");
        assert_eq!(root.outcome, None);
        assert!(root.started_at.is_none() && root.session_id.is_none());
        assert!(root.workflow_steps.is_empty());
        assert!(root.wait_until.is_some());
        assert!(root
            .reason
            .as_deref()
            .unwrap()
            .starts_with("Waiting for local resources"));
        assert_eq!(prepared(&service, &root.id).await, (0, 0));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        admission_window::expire_wait(&service.store.root.display().to_string());
        for _ in 0..3 {
            service.tick().await.unwrap();
        }
        let done = service.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed", "{retry_policy:?}");
        assert_eq!(done.attempts.len(), 1);
        let root = &done.attempts[0];
        assert_eq!(root.phase, "terminal");
        assert_eq!(root.outcome.as_deref(), Some("pass"));
        assert_eq!(root.workflow_steps.len(), 2);
        assert!(root.started_at.unwrap() >= refused_at);
        let clock = service
            .store
            .native_budget(&format!("workflow-root:{}", root.id))
            .await
            .unwrap()
            .unwrap();
        assert!(clock.root_started_at_ms >= refused_at);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        dir.close().await;
    }
}

/// A workflow a provider already worked on has started, and its later step
/// the local broker refused waits for room on the root's seat instead of
/// losing the paid steps (2026-10-17: e245dd7d, ed4eaa5a and e1d07e6f lost
/// theirs to a host build's commit headroom). Under either retry policy the
/// step asks again, with a new owner, and the root finishes.
#[tokio::test]
async fn a_later_step_refused_for_local_resources_waits_on_its_root() {
    for retry_policy in [RunRetryPolicy::None, RunRetryPolicy::Automatic] {
        let (dir, service, backend) = setup().await;
        backend.resource_refusal_after.store(1, Ordering::SeqCst);
        backend.resource_refusal_repeats.store(2, Ordering::SeqCst);
        let run = service
            .start_run(workflow_request(&service, retry_policy).await)
            .await
            .unwrap();
        for _ in 0..3 {
            service.tick().await.unwrap();
        }
        let settled = service.store.run(&run.id).await.unwrap();
        assert_eq!(settled.state, "completed", "{retry_policy:?}");
        assert_eq!(settled.attempts.len(), 1);
        let root = &settled.attempts[0];
        assert_eq!(root.phase, "terminal");
        assert_eq!(root.outcome.as_deref(), Some("pass"), "{retry_policy:?}");
        assert_eq!(root.workflow_steps.len(), 2);
        assert!(root
            .workflow_steps
            .iter()
            .all(|step| step.host_run_id.is_some()));
        assert_eq!(prepared(&service, &root.id).await, (2, 3));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        dir.close().await;
    }
}

/// The wait has a bound: a later step still refused once a quarter of its
/// allowance has passed settles as the refusal, which is unscored, with
/// every step record and clock it used. No second turn is paid for.
#[tokio::test]
async fn a_later_step_settles_its_refusal_after_a_quarter_of_its_allowance() {
    let (dir, service, backend) = setup().await;
    backend.resource_refusal_after.store(1, Ordering::SeqCst);
    backend
        .resource_refusal_repeats
        .store(10_000, Ordering::SeqCst);
    let mut request = workflow_request(&service, RunRetryPolicy::None).await;
    // A quarter of four seconds: one second of asking.
    request.timeout_seconds = 4;
    let run = service.start_run(request).await.unwrap();
    let started = Instant::now();
    for _ in 0..2 {
        service.tick().await.unwrap();
    }
    let settled = service.store.run(&run.id).await.unwrap();
    let root = &settled.attempts[0];
    assert_eq!(root.phase, "terminal");
    assert_eq!(root.outcome.as_deref(), Some("resource_busy"));
    assert!(!super::super::analysis::is_measured(root));
    assert_eq!(
        root.workflow_steps[1].outcome.as_deref(),
        Some("resource_busy")
    );
    assert!(root.workflow_steps[0].host_run_id.is_some());
    assert_eq!(prepared(&service, &root.id).await, (2, 3));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    // It asked for about a second, not for the whole allowance.
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "{:?}",
        started.elapsed()
    );
    backend.resource_refusal_after.store(0, Ordering::SeqCst);
    dir.close().await;
}

#[test]
fn a_later_step_asks_again_only_inside_the_first_quarter_of_its_allowance() {
    let retry = super::super::workflow::LATER_STEP_RETRY.as_millis() as i64;
    assert!(super::super::workflow::later_step_may_wait(0, 600, 0));
    assert!(super::super::workflow::later_step_may_wait(
        0,
        600,
        150_000 - retry
    ));
    assert!(!super::super::workflow::later_step_may_wait(
        0,
        600,
        150_001 - retry
    ));
    assert!(!super::super::workflow::later_step_may_wait(0, 0, 0));
}
