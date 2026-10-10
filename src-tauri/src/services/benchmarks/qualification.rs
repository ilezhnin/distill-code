//! Native grader controls plus an explicit, attributable contract review.
//! Control agreement cannot itself establish semantic coverage or independence.
use super::{
    fixtures, runner,
    store::{event, now, Store},
    types::*,
    BenchmarkService,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
mod tests;

fn invalid(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("invalid_qualification", message)
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(fixtures::hash(&serde_json::to_vec(value)?))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Control {
    pub id: String,
    pub output: String,
    /// `pass` for an accepted alternative, `fail` for a known contract violation.
    pub expected: String,
    pub rationale: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Requirement {
    pub id: String,
    pub statement: String,
    pub positive_controls: Vec<String>,
    pub negative_controls: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RubricCalibration {
    pub minimum_accepted_score: f64,
    pub maximum_rejected_score: f64,
    pub max_judge_calls: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub request_key: String,
    pub version_id: String,
    pub content_hash: String,
    pub evaluator_revision: String,
    /// This identifies the reviewing operator, not a scored candidate.
    pub reviewer: String,
    pub contract_review: String,
    pub alternative_review: String,
    pub family_review: String,
    pub exposure_review: String,
    pub requirements: Vec<Requirement>,
    pub controls: Vec<Control>,
    /// Explicit remote-call budget and outcome bands, frozen before calibration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rubric: Option<RubricCalibration>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    pub version_id: String,
    pub content_hash: String,
    pub manifest_hash: String,
    pub evaluator_revision: String,
    pub created_at: i64,
    pub record_hash: String,
    pub status: String,
    pub revoked_at: Option<i64>,
    pub revocation_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResult {
    pub control_id: String,
    pub output_hash: String,
    pub evaluation: Option<Evaluation>,
    pub error: Option<String>,
    /// Calibration evidence never enters candidate attempts or model boards.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub judge_evaluations: Vec<Evaluation>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub created_at: i64,
    pub request: Request,
    pub manifest_hash: String,
    pub controls: Vec<ControlResult>,
    pub status: String,
    pub finished_at: Option<i64>,
    pub failure: Option<String>,
    pub limitations: Vec<String>,
}

fn validate(request: &Request) -> Result<()> {
    if let Some(rubric) = &request.rubric {
        if !rubric.minimum_accepted_score.is_finite()
            || !rubric.maximum_rejected_score.is_finite()
            || !(0.5..=1.0).contains(&rubric.minimum_accepted_score)
            || !(0.0..0.5).contains(&rubric.maximum_rejected_score)
            || rubric.max_judge_calls > 384
        {
            return Err(invalid("Rubric controls require accepted scores in [0.5,1], rejected scores in [0,0.5), and at most 384 judge calls"));
        }
    }
    for (text, maximum) in [
        (&request.request_key, 128),
        (&request.version_id, 128),
        (&request.content_hash, 128),
        (&request.evaluator_revision, 256),
        (&request.reviewer, 256),
        (&request.contract_review, 16_384),
        (&request.alternative_review, 16_384),
        (&request.family_review, 16_384),
        (&request.exposure_review, 16_384),
    ] {
        if text.trim().is_empty() || text.len() > maximum {
            return Err(invalid(
                "Qualification needs bounded version identifiers and explicit attributable reviews",
            ));
        }
    }
    if !(1..=64).contains(&request.requirements.len())
        || !(4..=128).contains(&request.controls.len())
        || serde_json::to_vec(request)?.len() > 8 * 1024 * 1024
    {
        return Err(invalid(
            "Qualification requires 1-64 requirements and 4-128 controls within 8 MiB",
        ));
    }
    let mut controls = BTreeMap::new();
    let mut outputs = BTreeSet::new();
    for control in &request.controls {
        if control.id.trim().is_empty()
            || control.id.len() > 128
            || control.output.len() > 1024 * 1024
            || control.rationale.trim().is_empty()
            || control.rationale.len() > 16_384
            || !matches!(control.expected.as_str(), "pass" | "fail")
            || controls.insert(&control.id, &control.expected).is_some()
            || !outputs.insert(fixtures::hash(control.output.as_bytes()))
        {
            return Err(invalid(
                "Controls need distinct IDs/outputs, pass/fail expectations and a rationale",
            ));
        }
    }
    if request
        .controls
        .iter()
        .filter(|c| c.expected == "pass")
        .count()
        < 2
        || request
            .controls
            .iter()
            .filter(|c| c.expected == "fail")
            .count()
            < 2
    {
        return Err(invalid(
            "At least two accepted alternatives and two negative controls are required",
        ));
    }
    let mut requirements = BTreeSet::new();
    let mut used = BTreeSet::new();
    for requirement in &request.requirements {
        if requirement.id.trim().is_empty()
            || requirement.id.len() > 128
            || !requirements.insert(&requirement.id)
            || requirement.statement.trim().is_empty()
            || requirement.statement.len() > 16_384
        {
            return Err(invalid(
                "Requirements need unique bounded IDs and review statements",
            ));
        }
        for (ids, expected) in [
            (&requirement.positive_controls, "pass"),
            (&requirement.negative_controls, "fail"),
        ] {
            if ids.is_empty()
                || ids.len() > 128
                || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
                || ids.iter().any(|id| {
                    controls
                        .get(id)
                        .is_none_or(|value| value.as_str() != expected)
                })
            {
                return Err(invalid("Every requirement needs positive and negative controls with matching expectations"));
            }
            used.extend(ids.iter());
        }
    }
    if used.len() != controls.len() {
        return Err(invalid(
            "Each control must substantiate a reviewed requirement",
        ));
    }
    Ok(())
}

impl BenchmarkService {
    /// Reconcile spend after restart without turning an interrupted vote into
    /// calibration evidence or changing the failed first outcome.
    pub(super) async fn reconcile_qualification_judges(&self) -> Result<()> {
        let ids = sqlx::query_scalar::<_, String>(
            "SELECT id FROM selector_qualifications WHERE phase='terminal' AND status='failed'",
        )
        .fetch_all(&self.store.pool)
        .await?;
        for id in ids {
            let mut record = self.store.qualification(&id).await?;
            if record.request.rubric.is_none() {
                continue;
            }
            let old_hash = hash(&record)?;
            let version = self.store.version(&record.request.version_id).await?;
            for index in 0..record.controls.len() {
                if !record.controls[index]
                    .judge_evaluations
                    .iter()
                    .any(|evaluation| {
                        evaluation
                            .details
                            .as_ref()
                            .is_some_and(|details| details["inFlight"] == true)
                    })
                {
                    continue;
                }
                let mut carrier = runner::qualification_carrier(&record, &version, index);
                carrier.evaluations = record.controls[index].judge_evaluations.clone();
                let reconciled = self.backend.reconcile_judges(&self.store, carrier).await?;
                record.controls[index].judge_evaluations = reconciled.evaluations;
            }
            if hash(&record)? != old_hash {
                let mut tx = self.store.pool.begin().await?;
                let updated = sqlx::query("UPDATE selector_qualifications SET record_json=?,record_hash=? WHERE id=? AND phase='terminal' AND status='failed' AND record_hash=?")
                    .bind(serde_json::to_string(&record)?).bind(hash(&record)?).bind(&record.id).bind(old_hash)
                    .execute(&mut *tx).await?.rows_affected();
                if updated != 1 {
                    return Err(invalid(
                        "Qualification evidence changed during reconciliation",
                    ));
                }
                event(&mut tx, &record.id, "qualification_judges_reconciled").await?;
                tx.commit().await?;
                self.changed().await;
            }
        }
        Ok(())
    }
    /// Reserve before any execution. A interrupted or failed first panel is
    /// retained; another request cannot replace that version's qualification.
    pub async fn qualify_version(&self, request: Request) -> Result<Record> {
        validate(&request)?;
        let version = self.store.version(&request.version_id).await?;
        let rubric = version.manifest.evaluator.kind == "rubric";
        if rubric {
            let panel = super::judge_panel::frozen(&version.manifest, &[])?
                .ok_or_else(|| invalid("Rubric qualification requires frozen judge seats"))?;
            if request.rubric.as_ref().is_none_or(|registered| {
                (registered.max_judge_calls as usize) < panel.len() * request.controls.len()
            }) {
                return Err(invalid("Register score bands and a call budget covering every frozen judge/control pair"));
            }
            let issues = super::catalog::validate(&version.manifest).issues;
            if !issues.is_empty() {
                return Err(invalid(format!(
                    "Rubric version is invalid: {}",
                    issues.join("; ")
                )));
            }
        } else if request.rubric.is_some() {
            return Err(invalid("Objective controls do not use a judge-call budget"));
        }
        if request.content_hash != version.content_hash
            || request.evaluator_revision != version.manifest.evaluator.revision
            || !matches!(version.manifest.split.as_str(), "train" | "held_out")
            || !matches!(
                version.manifest.evaluator.kind.as_str(),
                "exact" | "json" | "javascript" | "browser" | "repository" | "rubric"
            )
        {
            return Err(invalid(
                "Controls must bind an exact published rating version and supported evaluator",
            ));
        }
        let record = Record {
            id: uuid::Uuid::new_v4().to_string(), created_at: now(),
            manifest_hash: hash(&version.manifest)?, request,
            controls: Vec::new(), status: "reserved".into(),
            finished_at: None, failure: None,
            limitations: vec![
                "Controls verify declared outcomes; expert coverage, alternative mechanisms, independence and exposure remain explicit attributable reviews".into(),
                "Qualification grants neither model discrimination nor dispatch authority".into()
            ],
        };
        let mut tx = self.store.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(row) =
            sqlx::query("SELECT id,request_hash FROM selector_qualifications WHERE request_key=?")
                .bind(&record.request.request_key)
                .fetch_optional(&mut *tx)
                .await?
        {
            if row.try_get::<String, _>("request_hash")? != hash(&record.request)? {
                return Err(invalid("Qualification key is bound to different inputs"));
            }
            let id: String = row.try_get("id")?;
            tx.commit().await?;
            return self.store.qualification(&id).await;
        }
        if sqlx::query_scalar::<_, String>(
            "SELECT id FROM selector_qualifications WHERE version_id=?",
        )
        .bind(&record.request.version_id)
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
        {
            return Err(invalid("This immutable version already has a first qualification; publish a reviewed revision instead of replacing its panel"));
        }
        sqlx::query("INSERT INTO selector_qualifications(id,request_key,request_hash,version_id,content_hash,manifest_hash,evaluator_revision,created_at,phase,status,record_json,record_hash) VALUES(?,?,?,?,?,?,?,?, 'reserved','reserved',?,?)")
            .bind(&record.id).bind(&record.request.request_key).bind(hash(&record.request)?)
            .bind(&record.request.version_id).bind(&record.request.content_hash).bind(&record.manifest_hash)
            .bind(&record.request.evaluator_revision).bind(record.created_at)
            .bind(serde_json::to_string(&record)?).bind(hash(&record)?).execute(&mut *tx).await?;
        event(&mut tx, &record.id, "qualification_reserved").await?;
        tx.commit().await?;
        self.changed().await;
        if rubric {
            let store = self.store.clone();
            let backend = self.backend.clone();
            let app = self.app.clone();
            let pending_id = record.id.clone();
            let failed_id = pending_id.clone();
            tokio::spawn(async move {
                if let Err(error) =
                    run_controls(&store, backend.as_ref(), &version, record, app.as_ref()).await
                {
                    // Keep the last committed placeholder and any partial spend;
                    // no second request may replay an ambiguous judge call.
                    if let Ok(mut failed) = store.qualification(&failed_id).await {
                        if failed.status == "reserved" {
                            failed.failure = Some(format!("{}: {}", error.code, error.message));
                            let _ = store.finish_qualification(&mut failed).await;
                        }
                    }
                    log::warn!("[benchmarks] rubric calibration stopped: {}", error.code);
                    super::notify_changed(&store, app.as_ref()).await;
                }
            });
            return self.store.qualification(&pending_id).await;
        }
        // Keep the rendering/evaluation future off the caller's stack. This
        // service is also awaited from larger qualification/promotion flows.
        Box::pin(run_controls(
            &self.store,
            self.backend.as_ref(),
            &version,
            record,
            self.app.as_ref(),
        ))
        .await
    }
}

fn in_band(rubric: &RubricCalibration, expected: &str, score: Option<f64>) -> bool {
    score.is_some_and(|score| {
        score.is_finite()
            && (0.0..=1.0).contains(&score)
            && if expected == "pass" {
                score >= rubric.minimum_accepted_score
            } else {
                score <= rubric.maximum_rejected_score
            }
    })
}

pub(super) fn validate_protocol(record: &Record, version: &BenchmarkVersion) -> Result<()> {
    if version.manifest.evaluator.kind != "rubric" {
        return Ok(());
    }
    if record.request.rubric.is_none()
        || record.controls.len() != record.request.controls.len()
        || record.controls.len() < 4
    {
        return Err(invalid("Rubric calibration has incomplete native controls"));
    }
    for index in 0..record.controls.len() {
        if !control_agrees(record, version, index)? {
            return Err(invalid(
                "Rubric calibration no longer matches the native scoring protocol",
            ));
        }
    }
    Ok(())
}

fn control_agrees(record: &Record, version: &BenchmarkVersion, index: usize) -> Result<bool> {
    let result = &record.controls[index];
    let expected = &record.request.controls[index].expected;
    let Some(evaluation) = &result.evaluation else {
        return Ok(false);
    };
    if evaluation.evaluator_revision != record.request.evaluator_revision {
        return Ok(false);
    }
    let Some(rubric) = &record.request.rubric else {
        return Ok(evaluation.verdict == *expected
            && evaluation.score == Some(if expected == "pass" { 1.0 } else { 0.0 }));
    };
    if !in_band(rubric, expected, evaluation.score) {
        return Ok(false);
    }
    if evaluation.verdict == "fail" && evaluation.provenance == "objective" {
        return Ok(expected == "fail" && evaluation.score == Some(0.0));
    }
    let Some(marker) = result
        .judge_evaluations
        .first()
        .filter(|e| e.provenance == "render")
    else {
        return Ok(false);
    };
    if marker
        .details
        .as_ref()
        .and_then(|details| details.pointer("/protocol/panelBinding"))
        .and_then(serde_json::Value::as_str)
        != Some(runner::frozen_judge_binding(&version.manifest)?.as_str())
    {
        return Ok(false);
    }
    let answers: Vec<_> = result.judge_evaluations[1..].iter().collect();
    let Some(votes) = super::judge_panel::bound_evaluations(marker, &answers) else {
        return Ok(false);
    };
    // Every seat must agree: a good median cannot qualify a judge that rewards
    // consequentially wrong controls or rejects a valid alternative.
    Ok(evaluation.verdict == "judged"
        && votes
            .iter()
            .all(|vote| in_band(rubric, expected, vote.score)))
}

async fn run_controls(
    store: &Store,
    backend: &dyn runner::ExecutionBackend,
    version: &BenchmarkVersion,
    mut record: Record,
    app: Option<&tauri::AppHandle>,
) -> Result<Record> {
    for index in 0..record.request.controls.len() {
        if store.qualification_stopped(&record.id).await? {
            record.failure = Some("Qualification was revoked before completion".into());
            break;
        }
        let control = &record.request.controls[index];
        record.controls.push(ControlResult {
            control_id: control.id.clone(),
            output_hash: fixtures::hash(control.output.as_bytes()),
            evaluation: None,
            error: None,
            judge_evaluations: Vec::new(),
        });
        store.save_qualification_progress(&record).await?;
        let evaluated = runner::evaluate(&version.manifest, &control.output).await;
        let evaluated = match evaluated {
            Ok(evaluation)
                if record.request.rubric.is_some() && evaluation.verdict == "pending_review" =>
            {
                backend
                    .judge_control(store, &mut record, version, index)
                    .await
            }
            other => other,
        };
        match evaluated {
            Ok(evaluation) => {
                record.controls[index].evaluation = Some(evaluation);
                if !control_agrees(&record, version, index)? {
                    record.failure = Some(format!(
                        "Control {} disagrees with its registered expectation",
                        record.controls[index].control_id
                    ));
                }
            }
            Err(error) => {
                record.failure = Some(format!(
                    "Control {} did not complete: {}",
                    record.controls[index].control_id, error.message
                ));
                record.controls[index].error = Some(format!("{}: {}", error.code, error.message));
            }
        }
        store.save_qualification_progress(&record).await?;
        super::notify_changed(store, app).await;
        if record.failure.is_some() {
            break;
        }
    }
    if record.failure.is_none() && record.request.rubric.is_some() {
        for expected in ["pass", "fail"] {
            let panels = record
                .request
                .controls
                .iter()
                .zip(&record.controls)
                .filter(|(control, result)| {
                    control.expected == expected
                        && result
                            .evaluation
                            .as_ref()
                            .is_some_and(|e| e.verdict == "judged")
                })
                .count();
            if panels < 2 {
                record.failure = Some("Rubric calibration needs at least two accepted and two rejected controls actually assessed by every judge; formatting checks alone do not qualify semantics".into());
            }
        }
    }
    if store.qualification_stopped(&record.id).await? {
        record.failure = Some("Qualification was revoked before completion".into());
    }
    store.finish_qualification(&mut record).await?;
    super::notify_changed(store, app).await;
    store.qualification(&record.id).await
}

impl Store {
    pub(super) async fn qualification_stopped(&self, id: &str) -> Result<bool> {
        let active = sqlx::query_scalar::<_, bool>(
            "SELECT phase='reserved' AND revoked_at IS NULL FROM selector_qualifications WHERE id=?")
            .bind(id).fetch_optional(&self.pool).await?;
        Ok(active != Some(true))
    }
    pub(super) async fn finish_qualification(&self, record: &mut Record) -> Result<()> {
        record.status = if record.failure.is_none() {
            "controls_verified_review_attested"
        } else {
            "failed"
        }
        .into();
        record.finished_at = Some(now());
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let updated = sqlx::query("UPDATE selector_qualifications SET phase='terminal',status=?,record_json=?,record_hash=? WHERE id=? AND phase='reserved'")
            .bind(&record.status).bind(serde_json::to_string(record)?).bind(hash(record)?).bind(&record.id)
            .execute(&mut *tx).await?.rows_affected();
        if updated != 1 {
            return Err(invalid("Qualification first result is already settled"));
        }
        event(&mut tx, &record.id, "qualification_settled").await?;
        tx.commit().await?;
        Ok(())
    }
    pub(super) async fn recover_qualifications(&self) -> Result<()> {
        let ids = sqlx::query_scalar::<_, String>(
            "SELECT id FROM selector_qualifications WHERE phase='reserved'",
        )
        .fetch_all(&self.pool)
        .await?;
        for id in ids {
            let mut record = self.qualification(&id).await?;
            record.failure = Some("Application restarted before the first qualification settled; partial judge evidence and unknown usage are preserved without replay".into());
            self.finish_qualification(&mut record).await?;
        }
        Ok(())
    }
    pub(super) async fn save_qualification_progress(&self, record: &Record) -> Result<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let changed=sqlx::query("UPDATE selector_qualifications SET record_json=?,record_hash=? WHERE id=? AND phase='reserved'")
            .bind(serde_json::to_string(record)?).bind(hash(record)?).bind(&record.id).execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            return Err(invalid("Qualification is no longer reserved"));
        }
        event(&mut tx, &record.id, "qualification_control_recorded").await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn qualification(&self, id: &str) -> Result<Record> {
        let row = sqlx::query("SELECT * FROM selector_qualifications WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| invalid("Qualification record not found"))?;
        let record: Record = serde_json::from_str(row.try_get("record_json")?)?;
        if record.id != id
            || hash(&record)? != row.try_get::<String, _>("record_hash")?
            || hash(&record.request)? != row.try_get::<String, _>("request_hash")?
            || record.request.version_id != row.try_get::<String, _>("version_id")?
            || record.request.content_hash != row.try_get::<String, _>("content_hash")?
            || record.manifest_hash != row.try_get::<String, _>("manifest_hash")?
            || record.request.evaluator_revision
                != row.try_get::<String, _>("evaluator_revision")?
            || record.created_at != row.try_get::<i64, _>("created_at")?
            || record.status != row.try_get::<String, _>("status")?
            || (record.finished_at.is_some() != (row.try_get::<String, _>("phase")? == "terminal"))
        {
            return Err(invalid("Qualification integrity check failed"));
        }
        Ok(record)
    }
    /// Binding metadata only: inference must not read hidden control answers.
    pub async fn qualification_bindings(&self, version_id: &str) -> Result<Vec<Binding>> {
        sqlx::query("SELECT id,version_id,content_hash,manifest_hash,evaluator_revision,created_at,record_hash,status,revoked_at,revocation_reason FROM selector_qualifications WHERE version_id=? ORDER BY created_at,id")
            .bind(version_id).fetch_all(&self.pool).await?.into_iter().map(|row| Ok(Binding {
                id:row.try_get("id")?,version_id:row.try_get("version_id")?,content_hash:row.try_get("content_hash")?,manifest_hash:row.try_get("manifest_hash")?,evaluator_revision:row.try_get("evaluator_revision")?,
                created_at:row.try_get("created_at")?,record_hash:row.try_get("record_hash")?,status:row.try_get("status")?,revoked_at:row.try_get("revoked_at")?,revocation_reason:row.try_get("revocation_reason")?
            })).collect()
    }
    pub async fn revoke_qualification(&self, id: &str, reason: &str) -> Result<()> {
        let gate = super::promotion::admission_gate();
        let _guard = gate.lock().await;
        if reason.trim().is_empty() || reason.len() > 16_384 {
            return Err(invalid("Revocation needs a bounded reason"));
        }
        self.qualification(id).await?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE selector_qualifications SET revoked_at=?,revocation_reason=? WHERE id=? AND revoked_at IS NULL").bind(now()).bind(reason).bind(id).execute(&mut *tx).await?;
        event(&mut tx, id, "qualification_revoked").await?;
        tx.commit().await?;
        Ok(())
    }
}
