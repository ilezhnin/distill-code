//! What a judge call left: a vote, an abstention, a failure.
use super::*;

/// Why a panel cannot settle a rendering, before any judge is asked.
pub(crate) fn panel_issue(panel: &[Configuration]) -> Option<String> {
    (panel.len() < MIN_JUDGES).then(|| {
        format!(
            "No judge panel: {} eligible judge(s), at least {MIN_JUDGES} are required",
            panel.len()
        )
    })
}

/// Why a settled judge turn cannot count as a vote: the host flagged it, or
/// the model that answered is not the judge that was asked.
pub(in super::super) fn judge_turn_failure(
    judge: &Configuration,
    status: &ExecutionDispatch,
) -> Option<String> {
    if let Some(error) = &status.error {
        let summary = error["message"].as_str().filter(|v| !v.is_empty());
        let detail = error
            .pointer("/data/message")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty());
        return Some(match (summary, detail) {
            (Some(summary), Some(detail)) if summary != detail => {
                format!("{summary}: {detail}")
            }
            (Some(message), _) | (_, Some(message)) => message.to_owned(),
            _ => error.to_string(),
        });
    }
    let Some(selection) = status
        .result
        .as_ref()
        .and_then(|result| result.get("observedSelection"))
    else {
        return Some("Judge turn has no acknowledged selection".into());
    };
    let mut observed = judge.clone();
    observed.model_id = selection["modelId"].as_str().unwrap_or_default().into();
    observed.effort = selection["reasoningEffort"].as_str().map(str::to_owned);
    observed.fast_mode = selection["fastMode"].as_bool();
    (!matches_selection(judge, &observed)).then(|| "Judge selection changed during the turn".into())
}

pub(in super::super) fn in_flight(evaluation: &Evaluation) -> bool {
    evaluation
        .details
        .as_ref()
        .is_some_and(|d| d["inFlight"] == true)
}

/// Settles a judge receipt an interruption cut off. Complete recovery replaces
/// partial usage; failed recovery preserves it. The reply never becomes a vote.
pub(in super::super) fn settle_interrupted_judge(
    evaluation: &mut Evaluation,
    usage: Option<TokenUsage>,
) {
    let complete = usage.is_some();
    evaluation.reason = format!(
        "{JUDGE_INTERRUPTED}; {}",
        if complete {
            "usage recovered from the host"
        } else {
            "complete usage is unknown"
        }
    );
    if let Some(usage) = usage {
        evaluation.usage = Some(usage);
    }
    if let Some(details) = evaluation.details.as_mut().and_then(Value::as_object_mut) {
        details.insert("inFlight".into(), json!(false));
        details.insert("usageComplete".into(), json!(complete));
    }
}

/// An abstention recorded without any judge session.
pub(in super::super) fn judge_abstention(
    version: &BenchmarkVersion,
    judge: &Configuration,
    batch: &str,
    reason: String,
) -> Evaluation {
    Evaluation {
        id: uuid::Uuid::new_v4().to_string(),
        evaluator_revision: version.manifest.evaluator.revision.clone(),
        verdict: "abstained".into(),
        score: None,
        reason,
        created_at: now(),
        provenance: "judge_failure".into(),
        artifacts: Vec::new(),
        details: Some(json!({"judgeBatchId": batch, "usageComplete": true})),
        judge: Some(judge.clone()),
        usage: None,
    }
}

pub(in super::super) fn valid_vote(evaluation: &Evaluation) -> bool {
    evaluation.provenance == "judge"
        && evaluation
            .score
            .is_some_and(|s| s.is_finite() && (0.0..=1.0).contains(&s))
}

pub(in super::super) const PANEL_INCOMPLETE: &str =
    "The judge panel is incomplete; every judge must return a valid score sheet";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn flagged_or_substituted_judge_turns_abstain() {
        let judge = judge_row("sonnet");
        let status = |result: Option<Value>, error: Option<Value>| ExecutionDispatch {
            request_key: "key".into(),
            session_id: "session".into(),
            run_id: "run".into(),
            user_message_id: "message".into(),
            phase: "terminal".into(),
            event_cursor: 4,
            result,
            error,
        };
        let acknowledged =
            |model: &str| Some(json!({"observedSelection": {"modelId": model, "fastMode": false}}));
        assert!(judge_turn_failure(&judge, &status(acknowledged("sonnet"), None)).is_none());
        let violated = status(
            None,
            Some(json!({"kind": "execution_violation",
                "message": "execution_violation: native execution violated the declared no-tool policy"})),
        );
        assert!(judge_turn_failure(&judge, &violated)
            .unwrap()
            .contains("no-tool policy"));
        for (error, expected) in [
            (
                json!({"code": -32603, "message": "Internal error", "data": {
                    "http_status": 403, "message": "API error (status 403 Forbidden): permission-denied"}}),
                "Internal error: API error (status 403 Forbidden): permission-denied",
            ),
            (
                json!({"message": "Host unavailable", "data": {"message": "Host unavailable"}}),
                "Host unavailable",
            ),
            (
                json!({"data": {"message": "Provider unavailable"}}),
                "Provider unavailable",
            ),
        ] {
            assert_eq!(
                judge_turn_failure(&judge, &status(None, Some(error))).as_deref(),
                Some(expected),
            );
        }
        assert!(judge_turn_failure(&judge, &status(acknowledged("opus[1m]"), None)).is_some());
        assert!(judge_turn_failure(&judge, &status(Some(json!({})), None)).is_some());
    }

    #[test]
    fn interrupted_judge_usage_retains_partial_evidence_when_recovery_fails() {
        let mut evaluation = Evaluation {
            id: "judge".into(),
            evaluator_revision: "1".into(),
            verdict: "abstained".into(),
            score: None,
            reason: "Judge turn in flight".into(),
            created_at: 1,
            provenance: "judge_failure".into(),
            artifacts: Vec::new(),
            details: Some(
                json!({"sessionId": "s", "requestKey": "k", "usageComplete": false, "inFlight": true}),
            ),
            judge: Some(judge_row("sonnet")),
            usage: None,
        };
        let mut recovered = evaluation.clone();
        settle_interrupted_judge(
            &mut recovered,
            Some(TokenUsage {
                output: Some(40),
                cost: Some(0.02),
                ..Default::default()
            }),
        );
        assert_eq!(recovered.details.as_ref().unwrap()["usageComplete"], true);
        assert_eq!(recovered.usage.as_ref().unwrap().cost, Some(0.02));
        evaluation.usage = Some(TokenUsage {
            output: Some(12),
            ..Default::default()
        });
        settle_interrupted_judge(&mut evaluation, None);
        assert!(!in_flight(&evaluation));
        assert_eq!(evaluation.details.as_ref().unwrap()["usageComplete"], false);
        assert_eq!(evaluation.details.as_ref().unwrap()["requestKey"], "k");
        assert_eq!(evaluation.usage.as_ref().unwrap().output, Some(12));
        assert_eq!(evaluation.usage.as_ref().unwrap().cost, None);
        assert!(evaluation.score.is_none());
    }

    #[tokio::test]
    async fn completed_turn_wakes_the_resource_queue_and_fills_available_slots() {
        let (dir, service, backend) = setup().await;
        let mut request = serial_request(&service).await;
        request.repetitions = 6;
        request.max_executions = 6;
        backend.hold_turns.store(true, Ordering::SeqCst);
        let run = service.start_run(request).await.unwrap();
        let scope = service.store.root.display().to_string();
        let mut flights = tokio::task::JoinSet::new();
        let mut tried = std::collections::HashSet::new();
        service.fill(&mut flights, &mut tried).await.unwrap();
        assert_eq!(flights.len(), 1);
        service.set_parallelism(&run.id, 3).await.unwrap();
        backend.resource_busy.store(true, Ordering::SeqCst);
        service.fill(&mut flights, &mut tried).await.unwrap();
        assert!(!admission_window::remaining(&scope).is_zero());
        assert_eq!(flights.len(), 1);
        backend.resource_busy.store(false, Ordering::SeqCst);
        backend.turn_release.notify_one();
        tokio::time::timeout(Duration::from_secs(10), flights.join_next())
            .await
            .unwrap();
        assert!(admission_window::remaining(&scope).is_zero());
        assert_eq!(
            service
                .store
                .run(&run.id)
                .await
                .unwrap()
                .attempts
                .iter()
                .filter(|a| a.outcome.as_deref() == Some("pass"))
                .count(),
            1
        );
        service.fill(&mut flights, &mut tried).await.unwrap();
        assert_eq!(
            flights.len(),
            3,
            "completion fills capacity beyond a single replacement"
        );
        tokio::time::timeout(Duration::from_secs(10), async {
            while backend.in_flight.load(Ordering::SeqCst) < 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(backend.peak_in_flight.load(Ordering::SeqCst) >= 3);
        service.control(&run.id, "cancel").await.unwrap();
        while flights.join_next().await.is_some() {}
        service.tick().await.unwrap();
        dir.close().await;
    }

    #[tokio::test]
    async fn resume_retries_an_incomplete_panel_without_regenerating_the_sealed_answer() {
        let (dir, s, backend) = setup().await;
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let id = &run.attempts[0].id;
        let mut attempt = s.store.attempt(id).await.unwrap();
        let output = attempt.output.clone();
        let seal = attempt.evidence_hash.clone();
        attempt.phase = "terminal".into();
        attempt.outcome = Some("pending_review".into());
        attempt.reason = Some(PANEL_INCOMPLETE.into());
        attempt.evaluations.clear();
        s.store.save_attempt(&attempt).await.unwrap();
        s.store
            .set_run_state(&run.id, "needs_attention")
            .await
            .unwrap();
        *backend.inventory_revision.lock().unwrap() = Some("fake-v2".into());
        s.control(&run.id, "resume").await.unwrap();
        let queued = s.store.attempt(id).await.unwrap();
        assert_eq!(
            queued.configuration.inventory_revision.as_deref(),
            Some("fake-v1")
        );
        assert_eq!(
            s.store.run(&run.id).await.unwrap().request.configurations[0]
                .inventory_revision
                .as_deref(),
            Some("fake-v1")
        );
        assert_eq!(queued.phase, AWAITING_JUDGES);
        assert_eq!(queued.output, output);
        s.tick().await.unwrap();
        let judged = s.store.attempt(id).await.unwrap();
        assert_eq!(judged.output, output);
        assert_eq!(judged.evidence_hash, seal);
        assert_eq!(judged.phase, "terminal");
        assert!(judged.reason.is_none());
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.judges.load(Ordering::SeqCst), 2);
        dir.close().await;
    }
}
