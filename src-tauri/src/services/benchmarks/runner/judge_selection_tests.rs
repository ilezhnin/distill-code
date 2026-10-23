//! Synthetic setup refusals: no real accounts, prompts or provider requests.
use super::*;

fn fixture() -> (Attempt, Evaluation) {
    let judge = Configuration {
        id: "invented-judge".into(),
        provider_id: "codex-acp".into(),
        account_id: Some("invented-account".into()),
        model_id: "invented-model".into(),
        effort: Some("high".into()),
        fast_mode: Some(false),
        billing_mode: "subscription".into(),
        execution_profile: "native_text".into(),
        inventory_revision: Some("invented-runtime".into()),
        model_name: None,
    };
    let mut attempt = super::super::pending_attempt("run", "version", &judge, 1);
    attempt.output = Some("Sealed invented answer".into());
    attempt.evidence_hash = Some("invented-seal".into());
    let failure = Evaluation {
        id: "refusal".into(),
        evaluator_revision: "r1".into(),
        verdict: "abstained".into(),
        score: None,
        reason: "Judge selection was not acknowledged".into(),
        created_at: 2,
        provenance: "judge_failure".into(),
        artifacts: vec![],
        judge: Some(judge.clone()),
        usage: None,
        details: Some(json!({"judgeBatchId":"batch", "sessionId":"unpaid-session",
            "dispatched":false, "usageComplete":true, "inFlight":false,
            "selectionNotAcknowledged":true})),
    };
    let mut marker = failure.clone();
    marker.id = "marker".into();
    marker.provenance = "render".into();
    marker.judge = None;
    marker.artifacts = vec![Artifact {
        kind: "text".into(),
        path: "invented.txt".into(),
        hash: "seal".into(),
        label: "Response".into(),
    }];
    let mut other = judge.clone();
    other.id = "other-judge".into();
    other.model_id = "other-model".into();
    marker.details = Some(json!({"judgeBatchId":"batch", "expectedJudges":2,
        "protocol":{"panel":[other,judge],"prompt":"instructions","renderer":"text"}}));
    let mut vote = failure.clone();
    vote.id = "paid-vote".into();
    vote.provenance = "judge".into();
    vote.verdict = "scored".into();
    vote.score = Some(0.8);
    vote.judge = Some(other);
    vote.details = Some(json!({"judgeBatchId":"batch","sessionId":"paid-session",
        "requestKey":"paid-request","usageComplete":true,"inFlight":false}));
    attempt.evaluations = vec![marker, vote];
    (attempt, failure)
}

#[test]
fn unpaid_selection_retries_keep_paid_votes_and_use_fresh_session_owners() {
    let (mut attempt, failure) = fixture();
    let original = attempt.clone();
    let judge = failure.judge.as_ref().unwrap();
    for index in 0..2 {
        assert!(retry_unpaid_judge_selection(&attempt, &failure));
        assert_eq!(judge_call_index(&attempt, "batch", 1, judge), 1 + index * 2);
        let mut saved = failure.clone();
        saved.id = format!("refusal-{index}");
        insert_judge_evaluation(&mut attempt, "batch", saved);
        let open = compatible_open_batch(&attempt.evaluations, "instructions", "text").unwrap();
        assert_eq!(open.asked.len(), 1);
        assert_eq!(
            seat_samples(&open.panel, 1, &open.asked),
            vec![(1, judge.clone())]
        );
    }
    assert!(!retry_unpaid_judge_selection(&attempt, &failure));
    assert_eq!(judge_call_index(&attempt, "batch", 1, judge), 5);
    assert_eq!(attempt.output, original.output);
    assert_eq!(attempt.evidence_hash, original.evidence_hash);
    assert_eq!(
        serde_json::to_value(&attempt.evaluations[..2]).unwrap(),
        serde_json::to_value(&original.evaluations).unwrap()
    );
}

#[test]
fn paid_uncertain_and_unrelated_judge_failures_never_retry_automatically() {
    let (attempt, failure) = fixture();
    for (key, value) in [
        ("dispatched", json!(true)),
        ("dispatched", Value::Null),
        ("usageComplete", json!(false)),
        ("inFlight", json!(true)),
        ("requestKey", json!("possibly-paid")),
        ("sessionId", Value::Null),
        ("selectionNotAcknowledged", json!(false)),
        ("judgeBatchId", Value::Null),
    ] {
        let mut changed = failure.clone();
        changed.details.as_mut().unwrap()[key] = value;
        assert!(!retry_unpaid_judge_selection(&attempt, &changed), "{key}");
    }
    let mut scored = failure.clone();
    scored.score = Some(0.5);
    assert!(!retry_unpaid_judge_selection(&attempt, &scored));
    let mut generic = failure;
    generic.details = Some(json!({"judgeBatchId":"batch","usageComplete":true}));
    assert!(!retry_unpaid_judge_selection(&attempt, &generic));
}

#[test]
fn incomplete_panel_exposes_only_its_current_failure() {
    let (mut attempt, mut failure) = fixture();
    assert_eq!(incomplete_panel_reason(&attempt, "batch"), PANEL_INCOMPLETE);
    failure.reason =
        "Frozen judge settings, billing or runtime changed; no replacement was selected".into();
    attempt.evaluations.push(failure.clone());
    assert_eq!(
        incomplete_panel_reason(&attempt, "batch"),
        format!("Judging failed: {}", failure.reason)
    );
    failure.details.as_mut().unwrap()["judgeBatchId"] = json!("other-batch");
    failure.reason = "Unrelated refusal".into();
    attempt.evaluations.push(failure);
    assert!(incomplete_panel_reason(&attempt, "batch").contains("Frozen judge"));
}
