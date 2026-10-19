//! Class certificates from a held-out evaluation: the journaled replay of
//! one frozen fit on the class's permanent held-out cells. Such a certificate
//! speaks for the class's ordinary chats and waves; owned native deployments
//! still need a workflow campaign certificate, so policy discovery for them
//! never reads this table. Certificates of the retired executor holdout
//! remain history and never authorize anything.
use super::*;
use crate::services::benchmarks::learned::certify::{self, ClassEvaluation};

/// A certificate issued from a journaled held-out evaluation.
pub(super) const SOURCE: &str = "held_out_certification";
/// A certificate of the retired single-use executor holdout: history only.
pub(super) const LEGACY_SOURCE: &str = "executor_holdout";

/// How one counted repetition relates to the renderer its qualification
/// verified: `None` when an evaluation names another renderer (or, for
/// browser checks, another worker) or a graded repetition names none;
/// `Some(true)` when it names the qualified one; `Some(false)` for a zero
/// scored without the renderer: a budget failure without a grader, or a
/// rubric answer without any markup to render (a native structural zero).
pub(crate) fn qualified_renderer_grading(
    evaluations: &[&Evaluation],
    installed: &str,
    worker: Option<&str>,
) -> Option<bool> {
    let mut named = false;
    for details in evaluations.iter().filter_map(|e| e.details.as_ref()) {
        if let Some(revision) = details.get("installedRevision") {
            if revision.as_str() != Some(installed)
                || worker.is_some_and(|w| details["runtimeRevision"].as_str() != Some(w))
            {
                return None;
            }
            named = true;
        }
        if let Some(revision) = details.pointer("/protocol/installedRendererRevision") {
            if revision.as_str() != Some(installed) {
                return None;
            }
            named = true;
        }
    }
    // Browser checks never produce an objective verdict; the rubric's
    // structural zero is the one judge_panel::validate_evidence accepts.
    let structural_zero = worker.is_none()
        && evaluations
            .iter()
            .all(|e| e.provenance == "objective" && e.verdict == "fail" && e.score == Some(0.0));
    match (named, evaluations.is_empty() || structural_zero) {
        (true, _) => Some(true),
        (false, true) => Some(false),
        (false, false) => None,
    }
}

impl Store {
    /// Records the certificate a passing evaluation issues; the evaluation is
    /// its whole evidence, so its id and snapshot bind the certificate.
    pub(in crate::services::benchmarks) async fn issue_class_certificate(
        &self,
        evaluation: &ClassEvaluation,
        model: &learned::LearnedModel,
        qualifications: Vec<qualification::Binding>,
        contract: Contract,
    ) -> Result<String> {
        let assessment = evaluation
            .assessment
            .clone()
            .filter(|a| a.passed)
            .ok_or_else(|| invalid("Only a passing evaluation issues a certificate"))?;
        let mut certificate = Certificate {
            id: String::new(),
            created_at: now(),
            model_id: model.id.clone(),
            model_snapshot_hash: model.snapshot_hash.clone(),
            campaign_id: evaluation.id.clone(),
            campaign_plan_hash: evaluation.snapshot_hash.clone(),
            report_hash: evaluation.snapshot_hash.clone(),
            rule_hash: hash(&certify::rule())?,
            contract,
            assessment,
            qualifications,
            prior_keys: evaluation.persona_keys.clone(),
            min_prediction_quality: 0.5,
            artifact_hash: String::new(),
            native_inventory: None,
            trajectory: None,
            source: Some(SOURCE.into()),
        };
        certificate.id = hash(&certificate)?;
        certificate.artifact_hash = hash(&certificate)?;
        sqlx::query("INSERT OR IGNORE INTO selector_class_certificates(id,evaluation_id,created_at,artifact_json,artifact_hash) VALUES(?,?,?,?,?)")
            .bind(&certificate.id).bind(&evaluation.id).bind(certificate.created_at)
            .bind(serde_json::to_string(&certificate)?).bind(&certificate.artifact_hash).execute(&self.pool).await?;
        Ok(certificate.id)
    }

    /// Authority of a held-out certificate: its journaled evaluation, its
    /// qualifications and its fit, never the renderer installed now.
    pub(super) async fn require_active_holdout_promotion(
        &self,
        certificate: Certificate,
    ) -> Result<Certificate> {
        if certificate.source.as_deref() != Some(SOURCE)
            || certificate.trajectory.is_some()
            || certificate.native_inventory.is_some()
        {
            return Err(invalid(
                "A retired executor-holdout certificate is history and authorizes nothing",
            ));
        }
        let evaluation = self
            .class_evaluation(&certificate.campaign_id)
            .await
            .map_err(|_| invalid("Held-out certificate evidence disappeared"))?;
        if evaluation.model_id != certificate.model_id
            || evaluation.snapshot_hash != certificate.report_hash
            || evaluation.certificate_id.as_deref() != Some(certificate.id.as_str())
            || evaluation.status != "certified"
        {
            return Err(invalid("Held-out certificate evidence changed"));
        }
        self.verify_qualification_authority(&certificate.qualifications, false)
            .await?;
        let model = self.selector_model(&certificate.model_id).await?;
        if model.snapshot_hash != certificate.model_snapshot_hash {
            return Err(invalid("Promoted fit changed"));
        }
        Ok(certificate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graded(provenance: &str, details: Option<serde_json::Value>) -> Evaluation {
        Evaluation {
            id: "evaluation".into(),
            evaluator_revision: "revision".into(),
            verdict: "pass".into(),
            score: Some(1.0),
            reason: String::new(),
            created_at: 1,
            provenance: provenance.into(),
            artifacts: vec![],
            details,
            judge: None,
            usage: None,
        }
    }

    #[test]
    fn counted_attempts_must_name_the_qualified_renderer() {
        let browser = |installed: &str, worker: &str| {
            graded(
                "protected_browser",
                Some(
                    serde_json::json!({"installedRevision": installed, "runtimeRevision": worker}),
                ),
            )
        };
        let check = |evaluations: &[Evaluation], worker: Option<&str>| {
            qualified_renderer_grading(&evaluations.iter().collect::<Vec<_>>(), "r1", worker)
        };
        let named = Some(true);
        let unnamed_zero = Some(false);
        assert_eq!(check(&[browser("r1", "w1")], Some("w1")), named);
        // Another installed renderer or worker on any evaluation refuses it.
        assert_eq!(check(&[browser("r2", "w1")], Some("w1")), None);
        assert_eq!(check(&[browser("r1", "w2")], Some("w1")), None);
        assert_eq!(
            check(&[browser("r1", "w1"), browser("r2", "w1")], Some("w1")),
            None
        );
        // A graded repetition that names no renderer cannot prove which one it used.
        assert_eq!(
            check(&[graded("protected_browser", None)], Some("w1")),
            None
        );
        assert_eq!(
            check(&[graded("exact", Some(serde_json::json!({})))], None),
            None
        );
        // A budget failure is scored without a grader.
        assert_eq!(check(&[], Some("w1")), unnamed_zero);
        // Rubric renderings name the renderer in their judge protocol.
        let render = |installed: &str| {
            graded(
                "render",
                Some(serde_json::json!({"protocol": {"installedRendererRevision": installed}})),
            )
        };
        assert_eq!(check(&[render("r1"), graded("judge", None)], None), named);
        assert_eq!(check(&[render("r2"), graded("judge", None)], None), None);
        // A rubric answer without markup is a native zero nothing rendered;
        // a browser check never produces one.
        let mut structural = graded("objective", None);
        structural.verdict = "fail".into();
        structural.score = Some(0.0);
        assert_eq!(check(std::slice::from_ref(&structural), None), unnamed_zero);
        assert_eq!(check(std::slice::from_ref(&structural), Some("w1")), None);
        let mut passed = structural.clone();
        passed.verdict = "pass".into();
        passed.score = Some(1.0);
        assert_eq!(check(&[passed], None), None);
    }
}
