//! Corrections to the interpretation of retained sheets. The original reply,
//! usage and verdict stay intact; a dated correction belongs to its batch.
use super::*;

const REVISION: &str = "critical-failure-precedence-v1";
const ABSTAINED: &str = "Critical checks unresolved; judge abstained. ";

fn corrects(correction: &Evaluation, original: &Evaluation) -> bool {
    correction.provenance == "judge"
        && correction.verdict == "judged"
        && correction.score == Some(0.0)
        && correction.judge == original.judge
        && correction.evaluator_revision == original.evaluator_revision
        && correction.details.as_ref().is_some_and(|details| {
            details
                .pointer("/correction/revision")
                .and_then(Value::as_str)
                == Some(REVISION)
                && details
                    .pointer("/correction/originalEvaluationId")
                    .and_then(Value::as_str)
                    == Some(original.id.as_str())
                && details["criticalCheckStatus"] == "fail"
                && original.details.as_ref().is_some_and(|source| {
                    ["judgeBatchId", "sessionId", "requestKey"]
                        .iter()
                        .all(|key| details[*key] == source[*key])
                })
        })
}

/// A corrected abstention is kept as evidence, but no longer prevents the
/// remaining seats of that same batch from being asked on explicit resume.
pub(super) fn effective_answers(evaluations: &[Evaluation]) -> Vec<&Evaluation> {
    evaluations
        .iter()
        .filter(|original| {
            !evaluations
                .iter()
                .any(|correction| corrects(correction, original))
        })
        .collect()
}

pub(super) fn repair(attempt: &mut Attempt, draft: &BenchmarkDraft, at: i64) -> usize {
    if !text_judged(draft) || attempt.evidence_hash.is_none() {
        return 0;
    }
    let Some(response) = attempt.output.as_deref() else {
        return 0;
    };
    let criteria = rubric_criteria(draft);
    let mut repairs = Vec::new();
    for (index, original) in attempt.evaluations.iter().enumerate() {
        if original.provenance != "judge_failure"
            || original.verdict != "abstained"
            || original.score.is_some()
            || original.judge.is_none()
            || original.evaluator_revision != draft.evaluator.revision
            || attempt.evaluations.iter().any(|e| corrects(e, original))
        {
            continue;
        }
        let Some(details) = original.details.as_ref() else {
            continue;
        };
        if details["criticalCheckPolicy"] != judge_checks::POLICY
            || details["criticalCheckStatus"] != "unknown"
            || details["usageComplete"] != true
            || details["inFlight"] == true
            || ["judgeBatchId", "sessionId", "requestKey"]
                .iter()
                .any(|key| details[*key].as_str().is_none_or(str::is_empty))
        {
            continue;
        }
        let Some(notes) = original.reason.strip_prefix(ABSTAINED) else {
            continue;
        };
        let Some(checks) = details["criticalChecks"].as_object() else {
            continue;
        };
        if !checks.values().any(|check| check["verdict"] == "fail")
            || !checks.values().any(|check| check["verdict"] == "unknown")
        {
            continue;
        }
        // Stored criterion shares are on 0..1; the declared sheet uses 0..10.
        let Some(scores) = details["criteria"].as_object().and_then(|shares| {
            shares
                .iter()
                .map(|(id, share)| {
                    let share = share.as_f64()?;
                    (share.is_finite() && (0.0..=1.0).contains(&share))
                        .then(|| (id.clone(), json!(share * 10.0)))
                })
                .collect::<Option<serde_json::Map<String, Value>>>()
        }) else {
            continue;
        };
        let reply = json!({"scores": scores, "notes": notes, "checks": checks}).to_string();
        // Recheck the immutable rubric, every condition and every quote against
        // the sealed candidate answer. No score is inferred from a reason.
        let Some(sheet) =
            judge_score_sheet(draft, &reply, Some(response), &criteria).filter(|sheet| {
                sheet.score == Some(0.0)
                    && sheet
                        .critical
                        .as_ref()
                        .is_some_and(|check| check.status == "fail")
            })
        else {
            continue;
        };
        let mut correction = original.clone();
        correction.id = uuid::Uuid::new_v4().to_string();
        correction.provenance = "judge".into();
        correction.verdict = "judged".into();
        correction.score = sheet.score;
        correction.reason = sheet.reason;
        correction.created_at = at.max(original.created_at);
        // This is an interpretation, not another model call or another charge.
        correction.usage = None;
        let details = correction.details.as_mut().unwrap();
        details.as_object_mut().unwrap().remove("durationMs");
        details["criticalCheckStatus"] = json!("fail");
        details["correction"] = json!({"revision": REVISION, "originalEvaluationId": original.id});
        repairs.push((index + 1, correction));
    }
    let count = repairs.len();
    // Its logical position keeps the correction in the source's batch, while
    // created_at keeps historical views unchanged before the correction date.
    for (index, correction) in repairs.into_iter().rev() {
        attempt.evaluations.insert(index, correction);
    }
    count
}

impl BenchmarkService {
    pub(super) async fn repair_saved_judge_assessments(&self) -> Result<()> {
        let at = now();
        // Only open, resumable runs. Archived and deliberately finished runs
        // retain their measurements exactly as recorded.
        let ids = sqlx::query_scalar::<_, String>(
            "SELECT a.id FROM run_plans r JOIN attempts a ON a.run_id=r.id
             WHERE r.baked_at IS NULL AND r.state IN ('running','paused','needs_attention')
               AND (r.paused_since IS NOT NULL OR r.created_at+r.paused_ms>?)
               AND a.phase='terminal' AND json_extract(a.data_json,'$.outcome')='pending_review'
               AND EXISTS(SELECT 1 FROM json_each(a.data_json,'$.evaluations') e
                 WHERE json_extract(e.value,'$.details.criticalCheckStatus')='unknown')",
        )
        .bind(at - super::super::analysis::RUN_WINDOW_MS)
        .fetch_all(&self.store.pool)
        .await?;
        let mut repaired = 0;
        for id in ids {
            let lock = super::super::evaluation_lock(&id);
            let Ok(_guard) = lock.try_lock() else {
                continue;
            };
            let mut attempt = self.store.attempt(&id).await?;
            let version = self.store.version(&attempt.version_id).await?;
            let count = repair(&mut attempt, &version.manifest, at);
            if count == 0 {
                continue;
            }
            attempt = super::super::analysis::normalize_outcome(attempt);
            if super::super::analysis::score(&attempt).is_some() {
                attempt.reason = None;
            }
            self.store.save_attempt(&attempt).await?;
            repaired += count;
        }
        if repaired > 0 {
            log::info!("[benchmarks] corrected {repaired} retained critical judge assessments");
            self.changed().await;
        }
        Ok(())
    }
}
