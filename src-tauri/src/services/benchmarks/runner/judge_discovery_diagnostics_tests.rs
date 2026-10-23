//! Invented discovery failures must be actionable without exposing inventory
//! output or changing which judges, waits, or paid answers the runner keeps.
use super::tests::{request, setup};
use super::*;
use std::sync::atomic::Ordering;

const PROOF: &str = "Linux text policy proof is absent, stale or its pinned runtime changed; run the isolated loopback policy probe";

fn judge(provider: &str) -> Configuration {
    Configuration {
        id: format!("invented-{provider}"),
        provider_id: provider.into(),
        account_id: Some("invented-account".into()),
        model_id: "invented-judge".into(),
        effort: Some("high".into()),
        fast_mode: Some(false),
        billing_mode: "subscription".into(),
        execution_profile: "native_text".into(),
        inventory_revision: Some("invented-runtime".into()),
        model_name: None,
    }
}

fn pool(provider: &str) -> super::super::judge_pool::Entry {
    super::super::judge_pool::Entry {
        provider_id: provider.into(),
        model_id: "invented-judge".into(),
        effort: Some("high".into()),
        inputs: None,
        accounts: Some(vec!["invented-account".into()]),
        disclosure_confirmed: false,
    }
}

fn issue(provider: &str, error: BenchmarkError) -> JudgeDiscoveryIssue {
    JudgeDiscoveryIssue::from_error(provider, Some("invented-account"), &error).unwrap()
}

#[test]
fn judge_diagnostics_recognize_only_the_exact_local_proof_refusal() {
    for message in [
        PROOF.to_owned(),
        format!("capability_missing: {PROOF}"),
        format!("capability_missing: capability_missing: {PROOF}"),
    ] {
        assert_eq!(
            JudgeDiscoveryCause::from_error(&BenchmarkError::new("capability_missing", message)),
            Some(JudgeDiscoveryCause::TextPolicyProofRequired)
        );
    }
    for message in [
        format!("provider says {PROOF}"),
        format!("{PROOF}\nprivate tail"),
        format!("capability_missing: capability_missing: capability_missing: {PROOF}"),
    ] {
        assert_eq!(
            JudgeDiscoveryCause::from_error(&BenchmarkError::new("capability_missing", message)),
            Some(JudgeDiscoveryCause::CapabilityUnavailable)
        );
    }
    assert_eq!(
        JudgeDiscoveryCause::from_error(&BenchmarkError::new("provider_failure", PROOF)),
        Some(JudgeDiscoveryCause::InventoryUnavailable)
    );
    assert_eq!(
        JudgeDiscoveryCause::from_error(&BenchmarkError::new("resource_busy", PROOF)),
        None
    );
    assert!(JudgeDiscoveryIssue::from_error(
        "unknown-provider",
        None,
        &BenchmarkError::new("capability_missing", PROOF)
    )
    .is_none());
}

#[test]
fn judge_diagnostics_bound_deduplicate_and_redact_discovery_failures() {
    let private = format!("Bearer invented-secret; account=invented-account; C:\\invented\\credentials; https://invalid.example/?token=invented-secret\nprompt={} ", "private".repeat(10_000));
    let mut issues = NativeProvider::ALL
        .iter()
        .rev()
        .map(|provider| {
            issue(
                provider.harness_id(),
                BenchmarkError::new("provider_failure", &private),
            )
        })
        .collect::<Vec<_>>();
    issues.push(issue(
        "claude-acp",
        BenchmarkError::new("capability_missing", PROOF),
    ));
    let pool = NativeProvider::ALL
        .iter()
        .map(|provider| pool(provider.harness_id()))
        .collect::<Vec<_>>();
    let panel = DiscoveredJudgePanel::discovered(vec![judge("grok-acp")], issues, &pool);
    let reason = panel.issue(true).unwrap();
    assert_eq!(panel.diagnostics.len(), 5);
    assert!(reason.starts_with("No judge panel: 1 eligible judge(s), at least 2 are required. A judge rejected this request; recovery needs another calibrated judge from the pool. Judge availability: Claude: local text policy verification required; Codex: model inventory unavailable"));
    assert!(reason.len() < 800);
    for hidden in [
        "Bearer",
        "invented-secret",
        "invented-account",
        "credentials",
        "invalid.example",
        "private",
        "prompt=",
    ] {
        assert!(!reason.contains(hidden));
    }
}

#[test]
fn judge_diagnostics_only_describe_unavailable_native_rows_in_the_allowed_pool() {
    let mut row = InventoryModel {
        configuration: judge("claude-acp"),
        name: "Invented judge".into(),
        efforts: vec!["high".into()],
        supports_fast_mode: false,
        available: false,
        reason: Some(format!("capability_missing: {PROOF}")),
    };
    let eligible = vec![pool("claude-acp")];
    let diagnostic = |row: &InventoryModel, entries: &[super::super::judge_pool::Entry]| {
        DiscoveredJudgePanel::discovered(
            Vec::new(),
            JudgeDiscoveryIssue::from_model(row).into_iter().collect(),
            entries,
        )
        .diagnostics
    };
    assert_eq!(
        diagnostic(&row, &eligible),
        vec![(
            NativeProvider::Claude,
            JudgeDiscoveryCause::TextPolicyProofRequired
        )]
    );
    assert!(diagnostic(&row, &[]).is_empty());
    row.configuration.model_id = "INVENTED-JUDGE".into();
    assert_eq!(diagnostic(&row, &eligible).len(), 1);
    row.configuration.account_id = Some("unapproved-account".into());
    assert!(diagnostic(&row, &eligible).is_empty());
    row.configuration.account_id = Some("invented-account".into());
    row.configuration.model_id = "uncalibrated-model".into();
    assert!(diagnostic(&row, &eligible).is_empty());
    row.configuration.model_id = "invented-judge".into();
    row.configuration.execution_profile = "protected_repository".into();
    assert!(JudgeDiscoveryIssue::from_model(&row).is_none());
    row.configuration.execution_profile = "native_text".into();
    row.available = true;
    assert!(JudgeDiscoveryIssue::from_model(&row).is_none());
}

#[test]
fn judge_diagnostics_do_not_change_sufficient_or_frozen_panels() {
    let seats = vec![judge("claude-acp"), judge("grok-acp")];
    let panel = DiscoveredJudgePanel::discovered(
        seats.clone(),
        vec![issue(
            "codex-acp",
            BenchmarkError::new("capability_missing", PROOF),
        )],
        &[pool("codex-acp")],
    );
    assert_eq!(panel.seats, seats);
    assert!(panel.diagnostics.is_empty());
    assert!(panel.issue(true).is_none());
    let frozen = DiscoveredJudgePanel::fixed(vec![judge("claude-acp")]);
    assert!(frozen.diagnostics.is_empty());
    assert_eq!(
        frozen.issue(false).unwrap(),
        "No judge panel: 1 eligible judge(s), at least 2 are required"
    );
}

#[test]
fn judge_diagnostics_do_not_replace_quota_or_resource_deferrals() {
    let candidate = judge("grok-acp");
    let draft = seed_definitions()
        .into_iter()
        .find(|draft| draft.work_class_id == "creative")
        .unwrap();
    let until = now() + QUOTA_RETRY_MS;
    let quota = resolve_quota_panel(
        vec![judge("claude-acp")],
        &[&candidate],
        &draft,
        vec![(until, judge("codex-acp"))],
        None,
    )
    .unwrap_err();
    assert_eq!(quota.code, JUDGE_QUOTA_WAIT);
    assert_eq!(quota.details.unwrap()["nextReset"], until);
    let busy = BenchmarkError::new("resource_busy", "invented busy resource")
        .with_details(json!({"invented": true}));
    let error = resolve_quota_panel(
        vec![judge("claude-acp")],
        &[&candidate],
        &draft,
        Vec::new(),
        Some(busy.clone()),
    )
    .unwrap_err();
    assert_eq!(error.code, busy.code);
    assert_eq!(error.message, busy.message);
    assert_eq!(error.details, busy.details);
}

#[tokio::test]
async fn judge_diagnostics_survive_summary_without_replaying_or_changing_paid_evidence() {
    let (dir, service, backend) = setup().await;
    let mut request = request(&service).await;
    request.repetitions = 1;
    let run = service.start_run(request).await.unwrap();
    let mut attempt = run.attempts[0].clone();
    let panel = DiscoveredJudgePanel::discovered(
        vec![judge("grok-acp")],
        vec![issue(
            "claude-acp",
            BenchmarkError::new("capability_missing", PROOF),
        )],
        &[pool("claude-acp")],
    );
    attempt.phase = "terminal".into();
    attempt.outcome = Some("pending_review".into());
    attempt.reason = panel.issue(false);
    attempt.output = Some("Invented paid answer".into());
    attempt.evidence_hash = Some("invented-seal".into());
    attempt.session_id = Some("invented-session".into());
    attempt.host_run_id = Some("invented-host-run".into());
    attempt.observed = Some(attempt.configuration.clone());
    attempt.usage.input = Some(11);
    attempt.usage.output = Some(7);
    attempt.evaluations.push(Evaluation {
        id: "invented-objective".into(),
        evaluator_revision: "1".into(),
        verdict: "pending_review".into(),
        score: None,
        reason: "Invented sealed objective result".into(),
        created_at: now(),
        provenance: "objective".into(),
        artifacts: Vec::new(),
        details: None,
        judge: None,
        usage: None,
    });
    attempt.finished_at = Some(now());
    service.store.save_attempt(&attempt).await.unwrap();
    // Storage owns the activity clock and closes the queue span on this save.
    // Everything else must match the caller; the tick must preserve the whole
    // authoritative stored record, including that closed span.
    let preserved =
        serde_json::to_value(service.store.attempt(&attempt.id).await.unwrap()).unwrap();
    let mut submitted = serde_json::to_value(&attempt).unwrap();
    let mut stored = preserved.clone();
    submitted.as_object_mut().unwrap().remove("activity");
    stored.as_object_mut().unwrap().remove("activity");
    assert_eq!(stored, submitted);
    assert!(!judging_deferred(&attempt));
    assert_eq!(
        service.store.runs().await.unwrap()[0]
            .attention
            .as_ref()
            .unwrap()
            .reason,
        attempt.reason.clone().unwrap()
    );
    service.tick().await.unwrap();
    assert_eq!(
        service.store.run(&run.id).await.unwrap().state,
        "needs_attention"
    );
    assert_eq!(
        serde_json::to_value(service.store.attempt(&attempt.id).await.unwrap()).unwrap(),
        preserved
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
    dir.close().await;
}
