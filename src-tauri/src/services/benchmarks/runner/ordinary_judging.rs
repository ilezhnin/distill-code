//! Ordinary scores belong to the retained artifact, not a calibration's runtime.
//! Reseating appends a new batch referencing the same artifact and paid votes;
//! it never rewrites the original receipts or charges their usage twice.
use super::*;

const POLICY: &str = "retained-artifact-panel-v1";

pub(super) fn recoverable(
    attempt: &Attempt,
    draft: &BenchmarkDraft,
    prompt: &str,
) -> Option<OpenBatch> {
    open_batch_matching(&attempt.evaluations, |marker| {
        marker.evaluator_revision == draft.evaluator.revision
            && marker
                .details
                .as_ref()
                .is_some_and(|d| d["protocol"]["prompt"] == prompt)
    })
}

pub(super) async fn for_attempt(store: &Store, attempt: &Attempt) -> Result<bool> {
    let policy: Option<Option<String>> = sqlx::query_scalar(
        "SELECT json_extract(request_json,'$.workflowPolicy') FROM run_plans WHERE id=?",
    )
    .bind(&attempt.run_id)
    .fetch_optional(&store.pool)
    .await?;
    match policy {
        Some(policy) => Ok(policy.is_none()),
        None => Err(BenchmarkError::new(
            "evidence_missing",
            "Judging run not found",
        )),
    }
}

pub(super) fn protocol(draft: &BenchmarkDraft, panel: &[Configuration]) -> Value {
    let mut protocol = judge_protocol(draft, panel);
    let details = protocol.as_object_mut().expect("judge protocol object");
    details.remove("panelRecipe");
    details.remove("panelBinding");
    details.insert("artifactJudgingPolicy".into(), json!(POLICY));
    details.insert(
        "ordinaryPanelRecipe".into(),
        json!(super::super::judge_pool::PANEL_RECIPE),
    );
    details.insert(
        "calibrationRecipe".into(),
        json!(super::super::judge_pool::RECIPE),
    );
    protocol
}

fn same_model(left: &Configuration, right: &Configuration) -> bool {
    left.provider_id == right.provider_id
        && match (
            model_identity(&left.provider_id, &left.model_id),
            model_identity(&right.provider_id, &right.model_id),
        ) {
            (Some(left), Some(right)) => left == right,
            _ => left.model_id == right.model_id,
        }
}

/// Already completed seats do not need available accounts again. The combined
/// replacement panel below still has to keep every original seat and sample.
pub(super) fn available_replacements(
    candidates: &[&Configuration],
    draft: &BenchmarkDraft,
    offered: Vec<(Option<f64>, Configuration)>,
    available: impl Fn(&Configuration) -> bool,
) -> Vec<Configuration> {
    if candidate_vendors(candidates).is_none() {
        return Vec::new();
    }
    // A new panel's one-per-lab shortlist hides same-lab replacements needed
    // to finish a saved three-seat panel after one provider runs out of quota.
    seatable(
        draft,
        by_headroom(
            offered
                .into_iter()
                .filter(|(_, judge)| available(judge))
                .collect(),
        ),
        &[],
    )
    .into_iter()
    .map(|(judge, _)| judge)
    .filter(|judge| super::super::judge_pool::vendor(&judge.provider_id).is_some())
    .collect()
}

/// Complete the saved panel before classifying a wait. Paid seats require no
/// current account capacity; only eligible missing seats may defer on quota.
pub(super) fn available_panel(
    open: &OpenBatch,
    candidates: &[&Configuration],
    draft: &BenchmarkDraft,
    offered: Vec<(Option<f64>, Configuration)>,
    available: impl Fn(&Configuration) -> bool,
    mut quota: Vec<(i64, Configuration)>,
    deferred: Option<BenchmarkError>,
) -> Result<Vec<Configuration>> {
    let ready = available_replacements(candidates, draft, offered.clone(), available);
    if let Some(panel) = replacement_panel(open, ready) {
        return Ok(panel);
    }
    let all = available_replacements(candidates, draft, offered.clone(), |_| true);
    if replacement_panel(open, all).is_some() {
        return Err(BenchmarkError::new(ACCOUNT_BUSY, JUDGES_BUSY));
    }
    quota.sort_by_key(|(until, _)| *until);
    let mut potential = offered;
    for (until, judge) in quota {
        potential.push((None, judge));
        let eligible = available_replacements(candidates, draft, potential.clone(), |_| true);
        if replacement_panel(open, eligible).is_some() {
            return Err(judge_quota_wait(Some(until)));
        }
    }
    Err(deferred.unwrap_or_else(|| {
        BenchmarkError::new(
            "judge_panel_unavailable",
            "The saved panel needs another eligible calibrated judge; add one to the judge pool",
        )
    }))
}

/// Paid seats stay. Only unfilled seats may take a currently eligible judge.
/// The original panel size and samples keep the admitted call budget bounded.
pub(super) fn replacement_panel(
    open: &OpenBatch,
    offered: Vec<Configuration>,
) -> Option<Vec<Configuration>> {
    let mut panel: Vec<_> = open
        .panel
        .iter()
        .filter(|judge| open.asked.contains(judge) || offered.contains(judge))
        .cloned()
        .collect();
    // Prefer an unrepresented lab, then another distinct calibrated model.
    for distinct_lab in [true, false] {
        for judge in &offered {
            if panel.len() == open.panel.len() {
                break;
            }
            if !panel.iter().any(|paid| same_model(paid, judge))
                && (!distinct_lab
                    || !panel.iter().any(|paid| {
                        super::super::judge_pool::vendor(&paid.provider_id)
                            == super::super::judge_pool::vendor(&judge.provider_id)
                    }))
            {
                panel.push(judge.clone());
            }
        }
    }
    (panel.len() == open.panel.len()).then_some(panel)
}

pub(super) fn quota_interrupted(attempt: &Attempt, batch: &str) -> bool {
    attempt.evaluations.iter().any(|e| {
        e.provenance == "judge_failure"
            && !in_flight(e)
            && e.details.as_ref().is_some_and(|d| {
                d["judgeBatchId"] == batch && judge_quota_stop(&d["providerError"])
            })
    })
}

fn marker<'a>(attempt: &'a Attempt, batch: &str) -> Option<&'a Evaluation> {
    attempt.evaluations.iter().find(|e| {
        e.provenance == "render"
            && e.details
                .as_ref()
                .is_some_and(|d| d["judgeBatchId"] == batch)
    })
}

pub(super) fn needs_reseating(
    attempt: &Attempt,
    open: &OpenBatch,
    panel: &[Configuration],
) -> bool {
    open.panel != panel
        || marker(attempt, &open.id).is_some_and(|e| {
            e.details
                .as_ref()
                .is_some_and(|d| d["protocol"]["panelRecipe"] == super::super::judge_panel::RECIPE)
        })
}

pub(super) fn reseat(
    attempt: &mut Attempt,
    draft: &BenchmarkDraft,
    open: &OpenBatch,
    panel: Vec<Configuration>,
    candidates: &[&Configuration],
) -> Result<OpenBatch> {
    let mut next = marker(attempt, &open.id)
        .cloned()
        .ok_or_else(|| BenchmarkError::new("evidence_missing", "Saved judge batch not found"))?;
    let previous = next.details.as_ref().expect("open batch details");
    let prompt = previous["protocol"]["prompt"].as_str().unwrap_or_default();
    let renderer = previous["protocol"]["renderer"]
        .as_str()
        .unwrap_or_default();
    let batch = uuid::Uuid::new_v4().to_string();
    let samples = open.expected / open.panel.len();
    let mut protocol = protocol(draft, &panel);
    // The old pixels/text and rubric are exactly what the retained votes saw.
    protocol["prompt"] = json!(prompt);
    protocol["renderer"] = json!(renderer);
    protocol["samplesPerJudge"] = json!(samples);
    protocol["expectedJudges"] = json!(open.expected);
    if let Some(installed) = previous["protocol"].get("installedRendererRevision") {
        protocol["installedRendererRevision"] = installed.clone();
    }
    let hash = sampled_protocol_hash(
        &panel,
        prompt,
        renderer,
        Some(super::super::judge_pool::PANEL_RECIPE),
        samples,
    );
    let at = now();
    let retained: Vec<_> = judge_corrections::effective_answers(&attempt.evaluations)
        .into_iter()
        .filter(|e| {
            valid_vote(e)
                && e.evaluator_revision == next.evaluator_revision
                && e.details
                    .as_ref()
                    .is_some_and(|d| d["judgeBatchId"] == open.id)
                && e.judge.as_ref().is_some_and(|j| open.asked.contains(j))
        })
        .map(|original| {
            let mut vote = original.clone();
            vote.id = uuid::Uuid::new_v4().to_string();
            vote.created_at = at;
            vote.usage = None;
            let details = vote.details.as_mut().unwrap().as_object_mut().unwrap();
            // These are references to completed scores, never new provider turns.
            for field in ["sessionId", "requestKey", "durationMs"] {
                details.remove(field);
            }
            details.insert("judgeBatchId".into(), json!(batch));
            details.insert("reusedEvaluationId".into(), json!(original.id));
            details.insert("reusedJudgeBatchId".into(), json!(open.id));
            vote
        })
        .collect();
    if retained.len() != open.asked.len() {
        return Err(BenchmarkError::new(
            "evidence_mismatch",
            "Saved judge votes changed during reseating",
        ));
    }
    next.id = uuid::Uuid::new_v4().to_string();
    next.created_at = at;
    next.reason = "Saved artifact retained for the current judge panel".into();
    next.details = Some(json!({
        "judgeBatchId":batch,"expectedJudges":open.expected,"protocolHash":hash,"protocol":protocol,
        "judgeRecovery":{"recipe":POLICY,"sourceBatchId":open.id},
        "sameVendor":same_vendor(candidates,&panel),"ownModel":own_model(candidates,&panel),
        "authorModel":author_model_judges(draft,&panel),
    }));
    attempt.evaluations.push(next);
    attempt.evaluations.extend(retained);
    Ok(OpenBatch {
        id: batch,
        panel,
        asked: open.asked.clone(),
        expected: open.expected,
        rendering: open.rendering.clone(),
        rendering_hash: open.rendering_hash.clone(),
    })
}

#[cfg(test)]
mod tests;
