use super::super::store::Store;
use super::*;
use sqlx::Row;

impl Store {
    pub async fn save_selector_fit(&self, artifact: &FitArtifact) -> Result<FitSummary> {
        validate_model(&artifact.model)?;
        if artifact.model.snapshot_hash != hash(&artifact.snapshot)? {
            return Err(BenchmarkError::new(
                "invalid_model",
                "Training snapshot hash mismatch",
            ));
        }
        // Content-addressed fits are immutable and safe to retry.
        sqlx::query("INSERT OR IGNORE INTO selector_fits(id,created_at,work_class_id,model_json,snapshot_json) VALUES(?,?,?,?,?)")
            .bind(&artifact.model.id).bind(artifact.created_at).bind(&artifact.model.work_class_id)
            .bind(serde_json::to_string(&artifact.model)?).bind(serde_json::to_string(&artifact.snapshot)?)
            .execute(&self.pool).await?;
        Ok(self.selector_fit(&artifact.model.id).await?.summary())
    }

    pub async fn selector_fit(&self, id: &str) -> Result<FitArtifact> {
        let row =
            sqlx::query("SELECT created_at,model_json,snapshot_json FROM selector_fits WHERE id=?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| {
                    BenchmarkError::new("not_found", "Learned selector fit was not found")
                })?;
        let artifact = FitArtifact {
            created_at: row.try_get("created_at")?,
            model: serde_json::from_str(row.try_get("model_json")?)?,
            snapshot: serde_json::from_str(row.try_get("snapshot_json")?)?,
        };
        validate_model(&artifact.model)?;
        if artifact.model.id != id || artifact.model.snapshot_hash != hash(&artifact.snapshot)? {
            return Err(BenchmarkError::new(
                "invalid_model",
                "Stored fit integrity check failed",
            ));
        }
        Ok(artifact)
    }

    /// Production inference cannot accidentally load labels through this path.
    pub async fn selector_model(&self, id: &str) -> Result<LearnedModel> {
        let body: String = sqlx::query_scalar("SELECT model_json FROM selector_fits WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| {
                BenchmarkError::new("not_found", "Learned selector model was not found")
            })?;
        let model: LearnedModel = serde_json::from_str(&body)?;
        validate_model(&model)?;
        if model.id != id {
            return Err(BenchmarkError::new(
                "invalid_model",
                "Stored model identity mismatch",
            ));
        }
        Ok(model)
    }

    pub async fn selector_fits(&self) -> Result<Vec<FitSummary>> {
        let rows = sqlx::query("SELECT id,created_at,model_json FROM selector_fits ORDER BY created_at DESC,id LIMIT 100")
            .fetch_all(&self.pool).await?;
        rows.iter()
            .map(|row| {
                let model: LearnedModel = serde_json::from_str(row.try_get("model_json")?)?;
                validate_model(&model)?;
                if model.id != row.try_get::<String, _>("id")? {
                    return Err(BenchmarkError::new(
                        "invalid_model",
                        "Stored model identity mismatch",
                    ));
                }
                Ok(FitSummary {
                    id: model.id,
                    created_at: row.try_get("created_at")?,
                    work_class_id: model.work_class_id,
                    training_cases: model.training_cases,
                    common_cases: model.common_cases,
                    groups: model.training_groups.len(),
                    candidates: model.candidates.len(),
                    dispatch_allowed: false,
                    status: "research_only".into(),
                })
            })
            .collect()
    }
}
