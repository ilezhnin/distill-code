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
    /// Reserve before any execution. A interrupted or failed first panel is
    /// retained; another request cannot replace that version's qualification.
    pub async fn qualify_version(&self, request: Request) -> Result<Record> {
        validate(&request)?;
        let version = self.store.version(&request.version_id).await?;
        if request.content_hash != version.content_hash
            || request.evaluator_revision != version.manifest.evaluator.revision
            || !matches!(version.manifest.split.as_str(), "train" | "held_out")
            || !matches!(
                version.manifest.evaluator.kind.as_str(),
                "exact" | "json" | "javascript" | "browser" | "repository"
            )
        {
            return Err(invalid(
                "Controls must bind an exact published rating version and objective evaluator",
            ));
        }
        let mut record = Record {
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
        for control in &record.request.controls {
            match runner::evaluate(&version.manifest, &control.output).await {
                Ok(evaluation) => {
                    let agrees = evaluation.verdict == control.expected
                        && evaluation.evaluator_revision == record.request.evaluator_revision
                        && evaluation.score
                            == Some(if control.expected == "pass" { 1.0 } else { 0.0 });
                    record.controls.push(ControlResult {
                        control_id: control.id.clone(),
                        output_hash: fixtures::hash(control.output.as_bytes()),
                        evaluation: Some(evaluation),
                        error: None,
                    });
                    if !agrees {
                        record.failure = Some(format!(
                            "Control {} disagrees with its registered expectation",
                            control.id
                        ));
                    }
                }
                Err(error) => {
                    record.failure = Some(format!(
                        "Control {} did not complete: {}",
                        control.id, error.message
                    ));
                    record.controls.push(ControlResult {
                        control_id: control.id.clone(),
                        output_hash: fixtures::hash(control.output.as_bytes()),
                        evaluation: None,
                        error: Some(format!("{}: {}", error.code, error.message)),
                    });
                }
            }
            self.store.save_qualification_progress(&record).await?;
            if record.failure.is_some() {
                break;
            }
        }
        record.status = if record.failure.is_none() {
            "controls_verified_review_attested"
        } else {
            "failed"
        }
        .into();
        record.finished_at = Some(now());
        let mut tx = self.store.pool.begin_with("BEGIN IMMEDIATE").await?;
        let updated = sqlx::query("UPDATE selector_qualifications SET phase='terminal',status=?,record_json=?,record_hash=? WHERE id=? AND phase='reserved'")
            .bind(&record.status).bind(serde_json::to_string(&record)?).bind(hash(&record)?).bind(&record.id)
            .execute(&mut *tx).await?.rows_affected();
        if updated != 1 {
            return Err(invalid("Qualification first result is already settled"));
        }
        event(&mut tx, &record.id, "qualification_settled").await?;
        tx.commit().await?;
        self.changed().await;
        self.store.qualification(&record.id).await
    }
}
impl Store {
    async fn save_qualification_progress(&self, record: &Record) -> Result<()> {
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
