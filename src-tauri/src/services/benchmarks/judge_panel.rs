//! Optional immutable judge seats for repeatable rubric measurement.
use super::{fixtures, runner, types::*};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub(super) const RECIPE: &str = "frozen-native-panel-v1";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Panel {
    recipe: String,
    judges: Vec<Configuration>,
}

fn invalid(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("invalid_judge_panel", message)
}

/// A frozen panel cannot silently lose a seat, substitute an account or admit
/// an author/candidate. Absence retains the ordinary discovery behavior.
pub(super) fn frozen(
    draft: &BenchmarkDraft,
    candidates: &[&Configuration],
) -> Result<Option<Vec<Configuration>>> {
    let Some(value) = draft.environment.get("judgePanel") else {
        return Ok(None);
    };
    let panel: Panel = serde_json::from_value(value.clone())
        .map_err(|_| invalid("Judge panel requires a recipe and exact judge configurations"))?;
    if draft.evaluator.kind != "rubric"
        || panel.recipe != RECIPE
        || !(runner::MIN_JUDGES..=runner::MAX_JUDGES).contains(&panel.judges.len())
    {
        return Err(invalid(
            "A frozen rubric panel requires two or three judges",
        ));
    }
    let criteria = draft.environment["rubricCriteria"]
        .as_array()
        .ok_or_else(|| invalid("A frozen panel requires explicit rubric criteria"))?;
    let mut ids = BTreeSet::new();
    let mut total_weight = 0.0;
    if criteria.is_empty() || criteria.len() > 32 {
        return Err(invalid(
            "A frozen panel requires 1-32 weighted rubric criteria",
        ));
    }
    for criterion in criteria {
        let id = criterion["id"].as_str().unwrap_or_default();
        let weight = criterion["weight"].as_f64().unwrap_or(f64::NAN);
        if id.is_empty()
            || id.trim() != id
            || id.len() > 64
            || !ids.insert(id)
            || !weight.is_finite()
            || weight <= 0.0
            || criterion
                .get("label")
                .is_some_and(|label| label.as_str().is_none_or(|label| label.len() > 1024))
        {
            return Err(invalid(
                "Rubric criteria require distinct IDs and finite positive weights",
            ));
        }
        total_weight += weight;
    }
    if !total_weight.is_finite() {
        return Err(invalid("Rubric criterion weights overflow"));
    }
    let mut seats = BTreeSet::new();
    for judge in &panel.judges {
        for (value, limit) in [
            (judge.provider_id.as_str(), 128),
            (judge.model_id.as_str(), 256),
            (judge.account_id.as_deref().unwrap_or_default(), 256),
            (judge.inventory_revision.as_deref().unwrap_or_default(), 256),
        ] {
            if value.is_empty() || value.trim() != value || value.len() > limit {
                return Err(invalid(
                    "Frozen judge identities and runtime pins must be nonempty bounded values",
                ));
            }
        }
        let model = runner::concrete_model(&judge.provider_id, &judge.model_id)
            .ok_or_else(|| invalid("Judge model must resolve to a concrete identity"))?;
        if !seats.insert((judge.provider_id.clone(), model))
            || judge.execution_profile != "native_text"
            || !matches!(judge.billing_mode.as_str(), "subscription" | "api")
            || judge
                .inventory_revision
                .as_deref()
                .is_none_or(str::is_empty)
            || judge.effort.as_deref().is_some_and(|effort| {
                effort.is_empty() || effort.trim() != effort || effort.len() > 64
            })
            || judge.fast_mode.is_none()
            || runner::profile_refusal(judge).is_some()
            || (!runner::text_judged(draft) && !runner::judge_provider_allowed(&judge.provider_id))
        {
            return Err(invalid("Judge seats need distinct models, supported input, explicit settings, account, billing and runtime pins"));
        }
    }
    if runner::select_judges(candidates, draft, panel.judges.clone()).len() != panel.judges.len() {
        return Err(invalid(
            "A frozen judge is an author, candidate or unresolved model",
        ));
    }
    Ok(Some(panel.judges))
}

fn identity(judge: &Configuration) -> Value {
    json!({"providerId":judge.provider_id,"accountId":judge.account_id,
        "modelId":judge.model_id,"effort":judge.effort,"fastMode":judge.fast_mode,
        "billingMode":judge.billing_mode,"executionProfile":judge.execution_profile,
        "inventoryRevision":judge.inventory_revision})
}

/// Unlike the display protocol hash, calibration authority binds accounts and
/// runtime pins as well as the exact scoring prompt and renderer.
pub(super) fn binding(panel: &[Configuration], prompt: &str, renderer: &str) -> String {
    fixtures::hash(
        json!({"recipe":RECIPE,"judges":panel.iter().map(identity).collect::<Vec<_>>(),
            "prompt":prompt,"renderer":renderer,"samplesPerJudge":1})
        .to_string()
        .as_bytes(),
    )
}

pub(super) fn offered(judge: &Configuration, row: &InventoryModel) -> bool {
    let current = &row.configuration;
    row.available
        && judge.provider_id == current.provider_id
        && judge.account_id == current.account_id
        && judge.model_id == current.model_id
        && judge.billing_mode == current.billing_mode
        && judge.execution_profile == current.execution_profile
        && judge.inventory_revision == current.inventory_revision
        && judge.effort.as_ref().map_or_else(
            || row.efforts.is_empty(),
            |effort| row.efforts.contains(effort),
        )
        && (judge.fast_mode != Some(true) || row.supports_fast_mode)
}

/// Research labels must use the same native protocol as the published task's
/// calibration. A human override or a different panel cannot inherit it.
pub(super) fn validate_evidence(
    draft: &BenchmarkDraft,
    attempt: &Attempt,
    as_of: i64,
) -> Result<()> {
    let mut candidates = vec![&attempt.configuration];
    candidates.extend(attempt.observed.as_ref());
    let Some(_) = frozen(draft, &candidates)? else {
        return Ok(());
    };
    let score = super::analysis::score_as_of(attempt, Some(as_of))
        .ok_or_else(|| invalid("Frozen rubric evidence has no settled native score"))?;
    let evaluations: Vec<_> = attempt
        .evaluations
        .iter()
        .filter(|e| e.created_at <= as_of)
        .collect();
    if evaluations.iter().any(|e| {
        e.evaluator_revision != draft.evaluator.revision
            || matches!(e.provenance.as_str(), "human" | "human_visual")
    }) {
        return Err(invalid(
            "A frozen rubric label cannot use a different evaluator or human override",
        ));
    }
    if matches!(
        attempt.outcome.as_deref(),
        Some("budget_reached" | "budget_timeout")
    ) && score == 0.0
    {
        return Ok(());
    }
    let markers: Vec<_> = evaluations
        .iter()
        .enumerate()
        .filter_map(|(i, e)| (e.provenance == "render").then_some(i))
        .collect();
    if markers.is_empty() {
        // A structural contract violation is a native zero without judge calls.
        return if score == 0.0
            && evaluations
                .iter()
                .any(|e| e.provenance == "objective" && e.verdict == "fail" && e.score == Some(0.0))
        {
            Ok(())
        } else {
            Err(invalid("Frozen rubric label lacks its native panel"))
        };
    }
    let expected = runner::frozen_judge_binding(draft)?;
    let mut complete = false;
    for (position, start) in markers.iter().copied().enumerate() {
        let marker = evaluations[start];
        if marker
            .details
            .as_ref()
            .and_then(|d| d.pointer("/protocol/panelBinding"))
            .and_then(Value::as_str)
            != Some(expected.as_str())
        {
            return Err(invalid(
                "Rubric measurement differs from its frozen calibration protocol",
            ));
        }
        let end = markers
            .get(position + 1)
            .copied()
            .unwrap_or(evaluations.len());
        complete |= bound_evaluations(marker, &evaluations[start + 1..end]).is_some();
    }
    if !complete {
        return Err(invalid("Frozen rubric label lacks a complete native panel"));
    }
    Ok(())
}

/// One complete, attributable vote per seat. Duplicate, foreign or cross-batch
/// votes cannot complete a frozen panel. Legacy records use their own reader.
pub(super) fn bound_evaluations<'a>(
    marker: &Evaluation,
    answers: &[&'a Evaluation],
) -> Option<Vec<&'a Evaluation>> {
    let details = marker.details.as_ref()?;
    let protocol = &details["protocol"];
    let batch = details["judgeBatchId"].as_str()?;
    let panel: Vec<Configuration> = serde_json::from_value(protocol["panel"].clone()).ok()?;
    if batch.is_empty()
        || protocol["panelRecipe"] != RECIPE
        || protocol["samplesPerJudge"] != 1
        || !(runner::MIN_JUDGES..=runner::MAX_JUDGES).contains(&panel.len())
        || details["expectedJudges"].as_u64()? != panel.len() as u64
        || protocol["panelBinding"].as_str()?
            != binding(
                &panel,
                protocol["prompt"].as_str()?,
                protocol["renderer"].as_str()?,
            )
    {
        return None;
    }
    let mut seats = BTreeSet::new();
    let mut sessions = BTreeSet::new();
    let mut result = Vec::new();
    for answer in answers.iter().filter(|answer| answer.provenance == "judge") {
        let evidence = answer.details.as_ref()?;
        let answered = identity(answer.judge.as_ref()?);
        let seat = panel.iter().position(|judge| identity(judge) == answered)?;
        let session = evidence["sessionId"].as_str()?;
        if !seats.insert(seat)
            || session.is_empty()
            || !sessions.insert(session)
            || evidence["judgeBatchId"].as_str() != Some(batch)
            || evidence["usageComplete"] != true
            || answer.evaluator_revision != marker.evaluator_revision
            || answer.verdict != "judged"
            || answer
                .score
                .is_none_or(|score| !score.is_finite() || !(0.0..=1.0).contains(&score))
        {
            return None;
        }
        result.push(*answer);
    }
    (seats.len() == panel.len()).then_some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn judge(model: &str) -> Configuration {
        Configuration {
            id: model.into(),
            provider_id: "claude-acp".into(),
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

    fn draft() -> BenchmarkDraft {
        let mut draft = super::super::seeds::definitions().remove(0);
        draft.evaluator.kind = "rubric".into();
        draft.environment = json!({"authoredBy": [], "judgeInput":"text",
            "rubricCriteria":[{"id":"meaning","weight":1}], "judgePanel": {
            "recipe":RECIPE, "judges":[judge("sonnet"), judge("haiku")]
        }});
        draft
    }

    #[test]
    fn frozen_seats_refuse_authors_candidates_alias_duplicates_and_missing_pins() {
        let base = draft();
        assert_eq!(frozen(&base, &[]).unwrap().unwrap().len(), 2);
        assert!(frozen(&base, &[&judge("sonnet")]).is_err());
        let concrete = runner::concrete_model("claude-acp", "haiku").unwrap();
        assert!(frozen(&base, &[&judge(&concrete)]).is_err());
        let mut authored = base.clone();
        authored.environment["authoredBy"] = json!(["sonnet"]);
        assert!(frozen(&authored, &[]).is_err());
        let mut duplicate = base.clone();
        duplicate.environment["judgePanel"]["judges"][0] = json!(judge(&concrete));
        assert!(frozen(&duplicate, &[]).is_err());
        for field in ["accountId", "inventoryRevision", "fastMode"] {
            let mut unpinned = base.clone();
            unpinned.environment["judgePanel"]["judges"][0][field] = Value::Null;
            assert!(frozen(&unpinned, &[]).is_err(), "{field}");
        }
        let mut malformed = base.clone();
        malformed.environment["judgePanel"]["judegs"] = json!([]);
        assert!(frozen(&malformed, &[]).is_err());
        malformed.environment["judgePanel"] = Value::Null;
        assert!(frozen(&malformed, &[]).is_err());
        for criteria in [
            json!([]),
            json!([{"id":"a","weight":0}]),
            json!([{"id":"a","weight":1},{"id":"a","weight":2}]),
        ] {
            let mut invalid_criteria = base.clone();
            invalid_criteria.environment["rubricCriteria"] = criteria;
            assert!(frozen(&invalid_criteria, &[]).is_err());
        }
        let mut legacy = base;
        legacy
            .environment
            .as_object_mut()
            .unwrap()
            .remove("judgePanel");
        assert!(frozen(&legacy, &[]).unwrap().is_none());
    }

    #[test]
    fn runtime_binding_ignores_display_but_never_account_or_execution_settings() {
        let original = judge("sonnet");
        let key = binding(
            std::slice::from_ref(&original),
            "prompt",
            "text-evidence-v1",
        );
        let mut renamed = original.clone();
        renamed.id = "other-row-name".into();
        renamed.model_name = Some("Other display name".into());
        assert_eq!(key, binding(&[renamed], "prompt", "text-evidence-v1"));
        for field in [
            "accountId",
            "inventoryRevision",
            "modelId",
            "effort",
            "billingMode",
            "executionProfile",
        ] {
            let mut changed = json!(original);
            changed[field] = json!("different");
            let changed = serde_json::from_value(changed).unwrap();
            assert_ne!(
                key,
                binding(&[changed], "prompt", "text-evidence-v1"),
                "{field}"
            );
        }
        assert_ne!(
            key,
            binding(
                std::slice::from_ref(&original),
                "changed prompt",
                "text-evidence-v1"
            )
        );
        assert_ne!(key, binding(&[original], "prompt", "other renderer"));
    }

    #[test]
    fn frozen_text_and_visual_panels_observe_provider_input_capabilities() {
        let mut task = draft();
        let mut text_only = judge("invented-text-model");
        text_only.provider_id = "codex-acp".into();
        text_only.effort = Some("low".into());
        task.environment["judgePanel"]["judges"][0] = json!(text_only);
        assert!(frozen(&task, &[]).is_ok());
        task.environment["judgeInput"] = json!("visual");
        assert!(frozen(&task, &[]).is_err());
        task.environment["judgeInput"] = json!("text");
        task.environment["judgePanel"]["judges"][0]["providerId"] = json!("unknown-provider");
        assert!(frozen(&task, &[]).is_err());
    }

    #[test]
    fn live_inventory_must_still_offer_the_exact_pinned_runtime_and_capabilities() {
        let selected = judge("sonnet");
        let row = InventoryModel {
            configuration: selected.clone(),
            name: "Invented".into(),
            efforts: vec!["high".into()],
            supports_fast_mode: false,
            available: true,
            reason: None,
        };
        assert!(offered(&selected, &row));
        let mut changed = row.clone();
        changed.configuration.inventory_revision = Some("updated-runtime".into());
        assert!(!offered(&selected, &changed));
        changed = row.clone();
        changed.configuration.billing_mode = "api".into();
        assert!(!offered(&selected, &changed));
        changed = row.clone();
        changed.efforts.clear();
        assert!(!offered(&selected, &changed));
        let mut no_effort = selected.clone();
        no_effort.effort = None;
        assert!(!offered(&no_effort, &row));
        assert!(offered(&no_effort, &changed));
        changed = row.clone();
        changed.available = false;
        assert!(!offered(&selected, &changed));
        let mut fast = selected;
        fast.fast_mode = Some(true);
        assert!(!offered(&fast, &row));
    }

    fn evidence() -> (Evaluation, Vec<Evaluation>) {
        let panel = vec![judge("sonnet"), judge("haiku")];
        let marker = Evaluation {
            id: "marker".into(),
            evaluator_revision: "invented-v1".into(),
            verdict: "rendered".into(),
            score: None,
            reason: String::new(),
            created_at: 1,
            provenance: "render".into(),
            artifacts: vec![],
            judge: None,
            usage: None,
            details: Some(
                json!({"judgeBatchId":"batch", "expectedJudges":2, "protocol": {
                    "panel":panel, "prompt":"prompt", "renderer":"text-evidence-v1",
                    "samplesPerJudge":1,
                    "panelRecipe":RECIPE, "panelBinding":binding(&panel,"prompt","text-evidence-v1")
                }}),
            ),
        };
        let answers = panel.into_iter().enumerate().map(|(i, judge)| Evaluation {
            id:format!("vote-{i}"), evaluator_revision:"invented-v1".into(),
            verdict:"judged".into(), score:Some(0.8), reason:String::new(), created_at:2,
            provenance:"judge".into(), artifacts:vec![], judge:Some(judge), usage:None,
            details:Some(json!({"judgeBatchId":"batch", "sessionId":format!("session-{i}"), "usageComplete":true})),
        }).collect();
        (marker, answers)
    }

    #[test]
    fn only_complete_distinct_bound_votes_score_the_frozen_panel() {
        let (marker, answers) = evidence();
        let score = |marker: &Evaluation, answers: &[Evaluation]| {
            super::super::analysis::score_of(
                Some("judged"),
                Some(2),
                &[vec![marker.clone()], answers.to_vec()].concat(),
                None,
            )
        };
        assert_eq!(score(&marker, &answers), Some(0.8));
        assert_eq!(score(&marker, &answers[..1]), None);
        assert_eq!(
            score(&marker, &[answers[0].clone(), answers[0].clone()]),
            None
        );
        for field in ["sessionId", "judgeBatchId", "usageComplete"] {
            let mut bad = answers.clone();
            bad[1].details.as_mut().unwrap()[field] = match field {
                "sessionId" => json!("session-0"),
                "judgeBatchId" => json!("other-batch"),
                _ => json!(false),
            };
            assert_eq!(score(&marker, &bad), None, "{field}");
        }
        let mut foreign = answers.clone();
        foreign[1].judge.as_mut().unwrap().account_id = Some("other-account".into());
        assert_eq!(score(&marker, &foreign), None);
        let mut changed = marker.clone();
        changed.details.as_mut().unwrap()["protocol"]["prompt"] = json!("changed after voting");
        assert_eq!(score(&changed, &answers), None);
        let mut revised = answers;
        revised[1].evaluator_revision = "other-revision".into();
        assert_eq!(score(&marker, &revised), None);
    }

    #[test]
    fn research_labels_require_the_calibrated_protocol_and_no_human_override() {
        let mut draft = draft();
        draft.evaluator.revision = "invented-v1".into();
        let panel = frozen(&draft, &[]).unwrap().unwrap();
        let (mut marker, answers) = evidence();
        marker.details.as_mut().unwrap()["protocol"] = runner::judge_protocol(&draft, &panel);
        let mut attempt =
            super::super::pending_attempt("run", "version", &judge("invented-worker"), 0);
        attempt.outcome = Some("judged".into());
        attempt.finished_at = Some(2);
        attempt.evaluations = [vec![marker], answers].concat();
        validate_evidence(&draft, &attempt, 2).unwrap();
        let mut changed = draft.clone();
        changed.evaluator.rubric.push_str(" Changed instruction.");
        assert!(validate_evidence(&changed, &attempt, 2).is_err());
        let mut human = attempt.evaluations[1].clone();
        human.provenance = "human".into();
        human.created_at = 3;
        attempt.evaluations.push(human);
        validate_evidence(&draft, &attempt, 2).unwrap();
        assert!(validate_evidence(&draft, &attempt, 3).is_err());
        attempt.evaluations.clear();
        attempt.outcome = Some("budget_timeout".into());
        validate_evidence(&draft, &attempt, 2).unwrap();
    }
}
