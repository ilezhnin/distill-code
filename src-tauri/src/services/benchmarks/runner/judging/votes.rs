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
