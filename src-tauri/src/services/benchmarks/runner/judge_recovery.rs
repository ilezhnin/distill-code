//! A rejected request is not a candidate verdict. On explicit recovery an
//! ordinary panel is selected afresh, without that judge for the same answer
//! and scoring instructions. Preregistered panels and calibrations never substitute.
use super::*;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Rejection {
    evaluation_id: String,
    judge_batch_id: String,
    judge: Configuration,
    reason: String,
}

/// Use the provider's structured status, never words in a candidate answer,
/// a malformed score sheet, a quota response, or a generic internal error.
pub(super) fn request_rejected(error: &Value) -> bool {
    error.pointer("/data/http_status").and_then(Value::as_u64) == Some(403)
}

fn same_judge(left: &Configuration, right: &Configuration) -> bool {
    let model = model_identity(&left.provider_id, &left.model_id);
    left.provider_id == right.provider_id
        && model.is_some()
        && model == model_identity(&right.provider_id, &right.model_id)
        && left.effort == right.effort
}

pub(super) fn excluded(judge: &Configuration, rejected: &[Rejection]) -> bool {
    rejected.iter().any(|r| same_judge(judge, &r.judge))
}

pub(super) fn accepts_marker(marker: &Evaluation, rejected: &[Rejection]) -> bool {
    rejected.is_empty()
        || marker
            .details
            .as_ref()
            .and_then(|d| {
                serde_json::from_value::<Vec<Configuration>>(d["protocol"]["panel"].clone()).ok()
            })
            .is_some_and(|panel| panel.iter().all(|judge| !excluded(judge, rejected)))
}

/// Bind a failure to this exact saved batch and evaluator before it can affect
/// seating. A different prompt or renderer can have a different outcome.
fn matching_failure(
    evaluation: &Evaluation,
    evaluations: &[Evaluation],
    draft: &BenchmarkDraft,
    prompt: &str,
    renderer: &str,
) -> bool {
    if evaluation.provenance != "judge_failure"
        || evaluation.score.is_some()
        || in_flight(evaluation)
        || evaluation.evaluator_revision != draft.evaluator.revision
    {
        return false;
    }
    let Some(judge) = &evaluation.judge else {
        return false;
    };
    let Some(batch) = evaluation
        .details
        .as_ref()
        .and_then(|d| d["judgeBatchId"].as_str())
    else {
        return false;
    };
    evaluations.iter().any(|marker| {
        marker.provenance == "render"
            && marker.evaluator_revision == draft.evaluator.revision
            && marker.details.as_ref().is_some_and(|d| {
                d["judgeBatchId"] == batch
                    && d["protocol"]["prompt"] == prompt
                    && d["protocol"]["renderer"] == renderer
                    && serde_json::from_value::<Vec<Configuration>>(d["protocol"]["panel"].clone())
                        .is_ok_and(|panel| panel.contains(judge))
            })
    })
}

/// Older receipts kept only "Internal error". Read their already completed
/// host dispatch, bound to both request and session, without sending a turn
/// or rewriting the original receipt.
fn rejection_from_status(evaluation: &Evaluation, status: &ExecutionDispatch) -> Option<String> {
    let details = evaluation.details.as_ref()?;
    if status.phase != "terminal"
        || details["requestKey"].as_str() != Some(status.request_key.as_str())
        || details["sessionId"].as_str() != Some(status.session_id.as_str())
        || !status.error.as_ref().is_some_and(request_rejected)
    {
        return None;
    }
    judge_turn_failure(evaluation.judge.as_ref()?, status)
}

fn recovery_allowed(draft: &BenchmarkDraft, evidence: &JudgeEvidence<'_>) -> bool {
    matches!(evidence, JudgeEvidence::OrdinaryAttempt)
        || (draft.environment.get("judgePanel").is_none()
            && matches!(evidence, JudgeEvidence::Attempt))
}

impl NativeBackend {
    pub(super) async fn rejected_judges(
        &self,
        attempt: &Attempt,
        draft: &BenchmarkDraft,
        prompt: &str,
        renderer: &str,
        evidence: &JudgeEvidence<'_>,
    ) -> Result<Vec<Rejection>> {
        if !recovery_allowed(draft, evidence) {
            return Ok(Vec::new());
        }
        let mut rejected = Vec::new();
        for evaluation in attempt
            .evaluations
            .iter()
            .rev()
            .filter(|e| matching_failure(e, &attempt.evaluations, draft, prompt, renderer))
        {
            let judge = evaluation.judge.as_ref().expect("matched judge");
            if excluded(judge, &rejected) {
                continue;
            }
            let details = evaluation.details.as_ref().expect("matched batch");
            let reason = if request_rejected(&details["providerError"]) {
                Some(evaluation.reason.clone())
            } else if let (Some(key), Some(_)) = (
                details["requestKey"].as_str(),
                details["sessionId"].as_str(),
            ) {
                let host = self
                    .app
                    .state::<AgentHost>()
                    .get_or_start(&self.app)
                    .await
                    .map_err(host_error)?;
                host.execution_status(key)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|status| rejection_from_status(evaluation, &status))
            } else {
                None
            };
            if let Some(reason) = reason {
                rejected.push(Rejection {
                    evaluation_id: evaluation.id.clone(),
                    judge_batch_id: details["judgeBatchId"].as_str().unwrap().to_owned(),
                    judge: judge.clone(),
                    reason,
                });
            }
        }
        Ok(rejected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn judge(provider: &str, model: &str) -> Configuration {
        Configuration {
            id: format!("{provider}:{model}"),
            provider_id: provider.into(),
            account_id: Some("invented-account".into()),
            model_id: model.into(),
            effort: Some("high".into()),
            fast_mode: Some(false),
            billing_mode: "subscription".into(),
            execution_profile: "native_text".into(),
            inventory_revision: Some("invented-runtime".into()),
            model_name: None,
        }
    }

    fn fixture() -> (BenchmarkDraft, Vec<Evaluation>, Rejection) {
        let draft = seed_definitions()
            .into_iter()
            .find(|draft| draft.work_class_id == "creative")
            .unwrap();
        let panel = vec![
            judge("claude-acp", "opus[1m]"),
            judge("grok-acp", "grok-4.7"),
        ];
        let marker: Evaluation = serde_json::from_value(json!({
            "id":"marker", "evaluatorRevision":draft.evaluator.revision,
            "verdict":"rendered", "reason":"", "createdAt":1, "provenance":"render",
            "artifacts":[{"kind":"text","path":"invented.txt","hash":"sealed","label":"Response"}],
            "details":{"judgeBatchId":"batch", "expectedJudges":2,
                "protocol":{"panel":panel,"prompt":"rubric","renderer":"text"}}
        }))
        .unwrap();
        let failure: Evaluation = serde_json::from_value(json!({
            "id":"failure", "evaluatorRevision":draft.evaluator.revision,
            "verdict":"abstained", "reason":"Internal error", "createdAt":2,
            "provenance":"judge_failure", "judge":panel[1],
            "details":{"judgeBatchId":"batch","requestKey":"request","sessionId":"session",
                "usageComplete":true,"inFlight":false}
        }))
        .unwrap();
        let rejected = Rejection {
            evaluation_id: failure.id.clone(),
            judge_batch_id: "batch".into(),
            judge: panel[1].clone(),
            reason: "Provider rejected the request (403)".into(),
        };
        (draft, vec![marker, failure], rejected)
    }

    #[test]
    fn only_structured_request_rejection_changes_seating() {
        assert!(request_rejected(
            &json!({"code":-32603,"message":"Internal error",
            "data":{"http_status":403,"message":"Request rejected"}})
        ));
        for status in [400, 401, 404, 408, 429, 500, 503] {
            assert!(!request_rejected(&json!({"data":{"http_status":status}})));
        }
        for error in [
            Value::Null,
            json!({"message":"403 Forbidden"}),
            json!({"data":{"message":"HTTP 403"}}),
            json!({"data":{"http_status":"403"}}),
        ] {
            assert!(!request_rejected(&error));
        }
    }

    #[test]
    fn recovered_refusal_is_bound_to_its_terminal_host_dispatch() {
        let (_, evaluations, _) = fixture();
        let failure = &evaluations[1];
        let mut status = ExecutionDispatch {
            request_key: "request".into(),
            session_id: "session".into(),
            run_id: "run".into(),
            user_message_id: "message".into(),
            phase: "terminal".into(),
            event_cursor: 2,
            result: None,
            error: Some(json!({"message":"Internal error",
                "data":{"http_status":403,"message":"Request rejected"}})),
        };
        assert_eq!(
            rejection_from_status(failure, &status).as_deref(),
            Some("Internal error: Request rejected")
        );
        status.session_id = "foreign-session".into();
        assert!(rejection_from_status(failure, &status).is_none());
        status.session_id = "session".into();
        status.request_key = "foreign-request".into();
        assert!(rejection_from_status(failure, &status).is_none());
        status.request_key = "request".into();
        status.phase = "running".into();
        assert!(rejection_from_status(failure, &status).is_none());
        status.phase = "terminal".into();
        status.error = Some(json!({"message":"Internal error"}));
        assert!(rejection_from_status(failure, &status).is_none());
    }

    #[test]
    fn failures_of_other_protocols_revisions_or_unbound_seats_do_not_exclude_judges() {
        let (draft, evaluations, _) = fixture();
        let failure = &evaluations[1];
        assert!(matching_failure(
            failure,
            &evaluations,
            &draft,
            "rubric",
            "text"
        ));
        assert!(!matching_failure(
            failure,
            &evaluations,
            &draft,
            "new rubric",
            "text"
        ));
        assert!(!matching_failure(
            failure,
            &evaluations,
            &draft,
            "rubric",
            "other renderer"
        ));
        for (key, value) in [
            ("inFlight", json!(true)),
            ("judgeBatchId", json!("foreign")),
        ] {
            let mut changed = failure.clone();
            changed.details.as_mut().unwrap()[key] = value;
            assert!(!matching_failure(
                &changed,
                &evaluations,
                &draft,
                "rubric",
                "text"
            ));
        }
        let mut changed = failure.clone();
        changed.evaluator_revision = "other revision".into();
        assert!(!matching_failure(
            &changed,
            &evaluations,
            &draft,
            "rubric",
            "text"
        ));
        changed = failure.clone();
        changed.judge.as_mut().unwrap().account_id = Some("foreign".into());
        assert!(!matching_failure(
            &changed,
            &evaluations,
            &draft,
            "rubric",
            "text"
        ));
        changed = failure.clone();
        changed.provenance = "judge".into();
        changed.score = Some(0.2);
        assert!(!matching_failure(
            &changed,
            &evaluations,
            &draft,
            "rubric",
            "text"
        ));
    }

    #[test]
    fn rejected_model_is_not_retried_on_another_account_or_speed() {
        let (_, _, rejection) = fixture();
        let mut same = rejection.judge.clone();
        same.id = "different-row".into();
        same.account_id = Some("other-account".into());
        same.inventory_revision = Some("other-runtime".into());
        same.fast_mode = Some(true);
        assert!(excluded(&same, std::slice::from_ref(&rejection)));
        assert!(!excluded(&judge("codex-acp", "gpt-6-sol"), &[rejection]));
    }

    #[test]
    fn recovery_reseats_an_ordinary_panel_without_changing_old_votes_or_quorum() {
        let (draft, mut evaluations, rejection) = fixture();
        let first = judge("claude-acp", "opus[1m]");
        let alternate = judge("codex-acp", "gpt-6-sol");
        let candidate = judge("codex-acp", "gpt-6-luna");
        let vote: Evaluation = serde_json::from_value(
            json!({"id":"vote", "evaluatorRevision":draft.evaluator.revision,
            "verdict":"judged", "score":0.8, "reason":"", "createdAt":2, "provenance":"judge",
            "judge":first,"details":{"judgeBatchId":"batch","usageComplete":true}}),
        )
        .unwrap();
        evaluations.push(vote);
        let before = serde_json::to_value(&evaluations).unwrap();
        assert_eq!(
            compatible_open_batch(&evaluations, "rubric", "text")
                .unwrap()
                .asked
                .len(),
            1
        );
        assert!(recoverable_open_batch(
            &evaluations,
            "rubric",
            "text",
            std::slice::from_ref(&rejection)
        )
        .is_none());
        let offered = vec![first.clone(), rejection.judge.clone(), alternate.clone()];
        let fresh = ordinary_judges(
            &[&candidate],
            &draft,
            offered
                .into_iter()
                .filter(|c| !excluded(c, std::slice::from_ref(&rejection)))
                .map(|c| (None, c))
                .collect(),
        );
        assert_eq!(fresh.len(), MIN_JUDGES);
        assert!(fresh.contains(&first) && fresh.contains(&alternate));
        assert_eq!(serde_json::to_value(&evaluations).unwrap(), before);
        let old_panel = vec![first.clone(), rejection.judge.clone()];
        assert_ne!(
            judge_protocol_hash(&fresh, "rubric", "text", ordinary_recipe(&draft)),
            judge_protocol_hash(&old_panel, "rubric", "text", ordinary_recipe(&draft))
        );
        assert!(panel_issue(&[first]).is_some());
    }

    #[test]
    fn frozen_panels_and_calibrations_never_use_reselection() {
        let (mut draft, _, _) = fixture();
        assert!(recovery_allowed(&draft, &JudgeEvidence::Attempt));
        let temp = tempfile::tempdir().unwrap();
        let judge = judge("claude-acp", "opus[1m]");
        assert!(!recovery_allowed(
            &draft,
            &JudgeEvidence::Calibration {
                judge: Box::new(judge),
                directory: temp.path().to_path_buf()
            }
        ));
        draft.environment["judgePanel"] = json!({"recipe":"frozen-native-panel-v1"});
        assert!(!recovery_allowed(&draft, &JudgeEvidence::Attempt));
        assert!(recovery_allowed(&draft, &JudgeEvidence::OrdinaryAttempt));
    }
}
