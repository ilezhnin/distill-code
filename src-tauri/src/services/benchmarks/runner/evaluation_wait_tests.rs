//! A paid answer whose evaluation the local sandbox refused before any worker
//! started waits for the sandbox and is evaluated then. The refusal is no
//! verdict and never generates the answer again.
use super::tests::{serial_request, setup};
use super::*;
use std::sync::atomic::Ordering;

/// One cell, one turn, and no replacement attempt, like a measurement run.
async fn one_cell(service: &BenchmarkService) -> RunRequest {
    let mut request = serial_request(service).await;
    request.repetitions = 1;
    request.max_executions = 1;
    request.execution_limits = Some(RunExecutionLimits {
        retry_policy: RunRetryPolicy::None,
        dispatch_not_after_ms: None,
    });
    request
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what}"));
}

#[tokio::test]
async fn a_paid_answer_waits_for_its_evaluation_instead_of_failing() {
    let (dir, service, backend) = setup().await;
    backend.evaluation_refusals.store(3, Ordering::SeqCst);
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let ticking = tokio::spawn({
        let service = service.clone();
        async move { service.tick().await }
    });
    let scope = service.store.root.display().to_string();
    for count in 1..=3 {
        until("the evaluation never waited", || {
            backend.evaluations.load(Ordering::SeqCst) >= count
                && !admission_window::remaining(&scope).is_zero()
        })
        .await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(backend.evaluations.load(Ordering::SeqCst), count);
        admission_window::expire_wait(&scope);
    }
    ticking.await.unwrap().unwrap();
    let settled = service.store.run(&run.id).await.unwrap();
    let attempt = &settled.attempts[0];
    assert_eq!(attempt.phase, "terminal");
    assert_eq!(attempt.outcome.as_deref(), Some("pass"));
    assert_eq!(attempt.evaluations.len(), 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(backend.evaluations.load(Ordering::SeqCst), 4);
    dir.close().await;
}

/// Cancelling the run ends the wait; the sealed answer keeps its refusal and
/// stays open to Evaluate again.
#[tokio::test]
async fn cancelling_the_run_ends_an_evaluation_wait() {
    let (dir, service, backend) = setup().await;
    backend
        .evaluation_refusals
        .store(u64::MAX, Ordering::SeqCst);
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let ticking = tokio::spawn({
        let service = service.clone();
        async move { service.tick().await }
    });
    until("the evaluation never waited", || {
        backend.evaluations.load(Ordering::SeqCst) >= 1
    })
    .await;
    service.control(&run.id, "cancel").await.unwrap();
    ticking.await.unwrap().unwrap();
    let attempt = service.store.run(&run.id).await.unwrap().attempts[0].clone();
    assert_eq!(attempt.phase, "terminal");
    assert_eq!(attempt.outcome.as_deref(), Some("evaluation_error"));
    assert!(attempt.reason.unwrap().starts_with(EVALUATION_WAIT));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    dir.close().await;
}

/// A generation sealed before a restart is evaluated on recovery. A refusal
/// keeps it interrupted, without recovering the turn again, and its run
/// neither completes nor bakes until the evaluation lands.
#[tokio::test]
async fn a_recovered_generation_waits_for_its_evaluation() {
    let (dir, service, backend) = setup().await;
    let run = service.start_run(one_cell(&service).await).await.unwrap();
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
    backend.evaluation_refusals.store(2, Ordering::SeqCst);
    service.tick().await.unwrap();
    let waiting = service.store.attempt(&sealed.id).await.unwrap();
    assert_eq!(waiting.phase, "interrupted");
    assert_eq!(waiting.outcome.as_deref(), Some("completed"));
    assert!(waiting.reason.unwrap().starts_with(EVALUATION_WAIT));
    assert!(waiting.wait_until.is_some());
    assert!(waiting.evaluations.is_empty());
    assert_eq!(service.store.run(&run.id).await.unwrap().state, "running");
    for _ in 0..50 {
        if service.store.attempt(&sealed.id).await.unwrap().phase == "terminal" {
            break;
        }
        let mut waiting = service.store.attempt(&sealed.id).await.unwrap();
        waiting.wait_until = Some(now() - 1);
        service.store.save_attempt(&waiting).await.unwrap();
        admission_window::expire_wait(&service.store.root.display().to_string());
        service.tick().await.unwrap();
    }
    let settled = service.store.attempt(&sealed.id).await.unwrap();
    assert_eq!(settled.phase, "terminal");
    assert_eq!(settled.outcome.as_deref(), Some("pass"));
    assert_eq!(settled.reason, None);
    assert_eq!(settled.wait_until, None);
    assert_eq!(settled.evaluations.len(), 1);
    assert_eq!(settled.evidence_hash, sealed.evidence_hash);
    assert_eq!(backend.evaluations.load(Ordering::SeqCst), 3);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    service.tick().await.unwrap();
    assert_eq!(service.store.run(&run.id).await.unwrap().state, "completed");
    dir.close().await;
}

/// Every unstarted refusal the sandbox reports reaches the runner as one,
/// the host preparation queue included; busy renderers defer a panel.
#[tokio::test]
async fn unstarted_refusals_are_recognised_where_they_arrive() {
    for message in [
        "resource_busy: benchmark resource capacity is queued; no provider process started",
        "resource_busy: benchmark preparation queue expired before worker startup",
        "resource_busy: benchmark host preparation queue expired before worker startup",
        "resource_busy: Windows headroom evidence expired before execution; no provider process started",
    ] {
        let error = std::io::Error::new(std::io::ErrorKind::WouldBlock, message);
        assert!(unstarted_refusal(&sandbox_setup_error(error, Some(1))));
    }
    let timed_out = std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "Sandbox operation exceeded its time limit",
    );
    assert!(!unstarted_refusal(&sandbox_setup_error(timed_out, Some(1))));
    assert!(!unstarted_refusal(&BenchmarkError::new(
        "evaluation_error",
        "Isolated Linux browser failed",
    )));
    let (dir, service, _) = setup().await;
    let run = service.start_run(one_cell(&service).await).await.unwrap();
    let mut attempt = run.attempts[0].clone();
    attempt.reason = Some(RENDERER_BUSY.into());
    assert!(judging_deferred(&attempt));
    attempt.reason = Some("Rendering failed: evaluation_error".into());
    assert!(!judging_deferred(&attempt));
    dir.close().await;
}

/// A workspace check that could not read the workspace is the sandbox's
/// failure; only a diff it found means the acknowledged copy changed.
#[test]
fn only_a_found_diff_reads_as_a_changed_workspace() {
    let changed = "The native text context changed after setup";
    for kind in [
        std::io::ErrorKind::FileTooLarge,
        std::io::ErrorKind::InvalidData,
    ] {
        let error = untouched_check_error(std::io::Error::new(kind, "diff"), changed);
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("selection_changed", changed)
        );
    }
    let busy = std::io::Error::new(
        std::io::ErrorKind::WouldBlock,
        "resource_busy: benchmark preparation queue expired before worker startup",
    );
    assert_eq!(untouched_check_error(busy, changed).code, "resource_busy");
    for error in [
        std::io::Error::new(std::io::ErrorKind::TimedOut, "slow broker"),
        std::io::Error::other("Sandbox patch failed: wsl.exe exited"),
    ] {
        assert_eq!(
            untouched_check_error(error, changed).code,
            "infrastructure_failure"
        );
    }
}

/// A workspace the sandbox could not build stops the run, and its reason
/// names the sandbox like a check's does.
#[test]
fn a_failed_workspace_copy_names_the_sandbox_and_stops_the_run() {
    let error = sandbox_setup_error(
        std::io::Error::other("Sandbox copy failed: bench-copy: unprotected parent"),
        Some(1),
    );
    assert_eq!(error.code, "storage_unavailable");
    assert_eq!(
        error.message,
        "Repository sandbox: Sandbox copy failed: bench-copy: unprotected parent"
    );
}
