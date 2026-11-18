//! A whole run through the scheduler under the faults a long run meets. Each
//! rule has its own tests; this one holds them together: a fault that is one
//! try's never stops the run, and every cell is measured.
use super::tests::{expire_saved_waits, request, setup};
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn a_run_meets_a_transient_fault_of_every_kind_and_completes_unattended() {
    let (dir, service, backend) = setup().await;
    let mut request = request(&service).await;
    request.repetitions = 6;
    request.max_executions = 6;
    // One of each: a selection the provider would not make, a usage limit
    // seen before the call, a sign-in the CLI renews later, an account
    // without a free seat, a turn the infrastructure lost and a check the
    // sandbox ended.
    backend.refused_selections.store(1, Ordering::SeqCst);
    backend.quota_waits.store(1, Ordering::SeqCst);
    backend.sign_in_waits.store(1, Ordering::SeqCst);
    backend.busy_accounts.store(1, Ordering::SeqCst);
    backend
        .infrastructure_turn_failures
        .store(1, Ordering::SeqCst);
    backend
        .evaluation_infrastructure_failures
        .store(1, Ordering::SeqCst);
    let run = service.start_run(request).await.unwrap();
    let mut done = None;
    for _ in 0..300 {
        service.tick().await.unwrap();
        let seen = service.store.run(&run.id).await.unwrap();
        let reasons: Vec<_> = seen
            .attempts
            .iter()
            .filter_map(|a| a.reason.clone())
            .collect();
        assert_ne!(seen.state, "needs_attention", "{reasons:?}");
        if seen.state != "running" {
            done = Some(seen);
            break;
        }
        // Time passes: holds end and waits come due.
        PROVIDER_HOLDS
            .lock()
            .unwrap()
            .retain(|(held, _), _| held != &run.id);
        expire_saved_waits(&service, &run.id).await;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let done = done.expect("the run never settled");
    assert_eq!(done.state, "completed");
    let measured: Vec<&Attempt> = done
        .attempts
        .iter()
        .filter(|a| !super::super::analysis::is_superseded(a))
        .collect();
    assert_eq!(measured.len(), 6);
    assert!(
        measured
            .iter()
            .all(|a| a.phase == "terminal" && a.outcome.as_deref() == Some("pass")),
        "{:?}",
        measured
            .iter()
            .map(|a| (a.outcome.clone(), a.reason.clone()))
            .collect::<Vec<_>>()
    );
    // Every fault was met.
    for (fault, left) in [
        ("selection", &backend.refused_selections),
        ("quota", &backend.quota_waits),
        ("sign-in", &backend.sign_in_waits),
        ("busy account", &backend.busy_accounts),
        ("lost turn", &backend.infrastructure_turn_failures),
        ("ended check", &backend.evaluation_infrastructure_failures),
    ] {
        assert_eq!(left.load(Ordering::SeqCst), 0, "{fault}");
    }
    dir.close().await;
}
