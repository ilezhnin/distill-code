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

/// A usage limit no wait of the run reaches is its account's, not the run's:
/// that account's tests are left for the operator, the run measures its
/// other account's, and it stops only once nothing else of it can go on.
#[tokio::test]
async fn a_limit_out_of_reach_leaves_its_accounts_tests_and_the_run_measures_the_rest() {
    let (dir, service, backend) = setup().await;
    let mut request = request(&service).await;
    let mut other = request.configurations[0].clone();
    other.id = "fake-fail".into();
    other.model_id = "fake-fail".into();
    other.account_id = Some("available".into());
    request.configurations.push(other);
    request.max_executions = 4;
    backend
        .spent_accounts
        .lock()
        .unwrap()
        .push("isolated".into());
    let run = service.start_run(request).await.unwrap();
    let on = |attempt: &Attempt, account: &str| {
        attempt.configuration.account_id.as_deref() == Some(account)
    };
    // The account has refused for longer than a run waits.
    let spent = run.attempts.iter().find(|a| on(a, "isolated")).unwrap();
    let refusal = json!({"data":{"kind":QUOTA_WAIT}}).to_string();
    let long_ago = now() - QUOTA_WAIT_LIMIT_MS - 60_000;
    quota_plan(
        &run.id,
        &quota_scope(&spent.configuration),
        &refusal,
        long_ago,
    );
    let mut stopped = None;
    let mut last = Vec::new();
    for _ in 0..50 {
        service.tick().await.unwrap();
        let seen = service.store.run(&run.id).await.unwrap();
        if seen.state != "running" {
            stopped = Some(seen);
            break;
        }
        last = seen
            .attempts
            .iter()
            .map(|a| {
                (
                    a.configuration.account_id.clone(),
                    a.phase.clone(),
                    a.outcome.clone(),
                    a.reason.clone(),
                    a.wait_until.map(|until| until - now()),
                    left_for_operator(a),
                )
            })
            .collect();
    }
    let stopped = stopped.unwrap_or_else(|| panic!("the run never stopped: {last:?}"));
    assert_eq!(stopped.state, "needs_attention");
    let (left, measured): (Vec<&Attempt>, Vec<&Attempt>) =
        stopped.attempts.iter().partition(|a| on(a, "isolated"));
    assert_eq!((left.len(), measured.len()), (2, 2));
    assert!(measured
        .iter()
        .all(|a| a.phase == "terminal" && a.outcome.as_deref() == Some("fail")));
    assert!(left
        .iter()
        .all(|a| a.phase == "pending" && a.outcome.is_none()));
    // One refusal told the run: the account's other test was not sent to be
    // refused in its turn.
    let refused = left
        .iter()
        .filter(|a| {
            a.reason
                .as_deref()
                .is_some_and(|reason| reason.starts_with(QUOTA_STOPPED))
        })
        .count();
    assert_eq!(refused, 1);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    // The operator resumed once the limit was lifted.
    backend.spent_accounts.lock().unwrap().clear();
    service.control(&run.id, "resume").await.unwrap();
    for _ in 0..10 {
        service.tick().await.unwrap();
    }
    let done = service.store.run(&run.id).await.unwrap();
    assert_eq!(done.state, "completed");
    assert!(done.attempts.iter().all(|a| a.phase == "terminal"
        && a.outcome.as_deref() == Some(if on(a, "isolated") { "pass" } else { "fail" })));
    dir.close().await;
}
