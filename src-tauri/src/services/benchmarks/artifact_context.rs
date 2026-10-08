//! Public, immutable repository progression shared by collection and deployment.
//! The source snapshot and sealed host records remain the authority for inputs.
use super::{fixtures, repository, types::*};
use serde::{Deserialize, Serialize};

pub const INPUT_KEY: &str = "repositoryArtifactInput";
pub const CLOCK_RECIPE: &str = "native-root-wall-budget-v1";
pub const CLOCK_KEY: &str = "nativeRootBudget";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetLease {
    pub recipe: String,
    pub root_id: String,
    pub root_started_at_ms: i64,
    pub root_cap_seconds: u32,
    pub step_key: String,
    pub step_started_at_ms: i64,
    pub step_cap_seconds: u32,
}
impl BudgetLease {
    pub fn remaining_ms(&self, at: i64) -> Result<u64> {
        if self.recipe != CLOCK_RECIPE
            || self.root_id.is_empty()
            || self.step_key.is_empty()
            || self.root_cap_seconds == 0
            || self.step_cap_seconds == 0
            || self.step_cap_seconds > self.root_cap_seconds
            || self.step_started_at_ms < self.root_started_at_ms
        {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native root budget authority is malformed",
            ));
        }
        let root = allowance_ms(self.root_started_at_ms, at, self.root_cap_seconds)?;
        let step = allowance_ms(self.step_started_at_ms, at, self.step_cap_seconds)?;
        Ok(root.min(step))
    }
    pub fn remaining_seconds(&self, at: i64) -> Result<u32> {
        Ok(self.remaining_ms(at)?.div_ceil(1000) as u32)
    }
    pub fn deadline_at_ms(&self) -> Result<i64> {
        self.remaining_ms(self.step_started_at_ms)?;
        let root = self
            .root_started_at_ms
            .checked_add(i64::from(self.root_cap_seconds) * 1000);
        let step = self
            .step_started_at_ms
            .checked_add(i64::from(self.step_cap_seconds) * 1000);
        match (root, step) {
            (Some(root), Some(step)) => Ok(root.min(step)),
            _ => Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native root deadline overflow",
            )),
        }
    }
}

impl super::store::Store {
    pub(super) async fn native_budget(&self, key: &str) -> Result<Option<BudgetLease>> {
        use sqlx::Row;
        let row = sqlx::query(
            "SELECT budget_json,budget_hash,root_id FROM task_budget_bindings WHERE request_key=?",
        )
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let body: String = row.try_get("budget_json")?;
        let lease: BudgetLease = serde_json::from_str(&body)?;
        if row.try_get::<String, _>("budget_hash")? != fixtures::hash(body.as_bytes())
            || row.try_get::<String, _>("root_id")? != lease.root_id
            || lease.step_key != key
        {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native budget accounting integrity changed",
            ));
        }
        Ok(Some(lease))
    }
    /// An immutable accounting row only: no second queue or dispatch journal.
    /// Same-key recovery cannot reset the root or per-step wall allowance.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn reserve_task_budget(
        &self,
        key: &str,
        input_hash: &str,
        consent_hash: &str,
        root: Option<&BudgetLease>,
        root_cap: u32,
        step_cap: u32,
        root_id: &str,
    ) -> Result<BudgetLease> {
        use sqlx::Row;
        let at = super::store::now();
        let lease = BudgetLease {
            recipe: CLOCK_RECIPE.into(),
            root_id: root.map_or_else(|| root_id.to_owned(), |root| root.root_id.clone()),
            root_started_at_ms: root.map_or(at, |root| root.root_started_at_ms),
            root_cap_seconds: root_cap,
            step_key: key.into(),
            step_started_at_ms: at,
            step_cap_seconds: step_cap,
        };
        lease.remaining_ms(at)?;
        if root.is_some_and(|root| root.root_cap_seconds != root_cap || root.recipe != CLOCK_RECIPE)
        {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "A descendant cannot reopen its root budget",
            ));
        }
        let body = serde_json::to_string(&lease)?;
        sqlx::query("INSERT INTO task_budget_bindings(request_key,input_hash,consent_hash,root_id,observed_at_ms,budget_json,budget_hash) VALUES(?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING")
            .bind(key).bind(input_hash).bind(consent_hash).bind(&lease.root_id).bind(at).bind(&body).bind(fixtures::hash(body.as_bytes())).execute(&self.pool).await?;
        let row = sqlx::query("SELECT input_hash,consent_hash,budget_json,budget_hash FROM task_budget_bindings WHERE request_key=?")
            .bind(key).fetch_one(&self.pool).await?;
        let saved_body: String = row.try_get("budget_json")?;
        let saved: BudgetLease = serde_json::from_str(&saved_body)?;
        if row.try_get::<String, _>("input_hash")? != input_hash
            || row.try_get::<String, _>("consent_hash")? != consent_hash
            || row.try_get::<String, _>("budget_hash")? != fixtures::hash(saved_body.as_bytes())
            || saved.root_id != lease.root_id
            || saved.root_started_at_ms != lease.root_started_at_ms && root.is_some()
            || saved.root_cap_seconds != root_cap
            || saved.step_cap_seconds != step_cap
            || saved.step_key != key
        {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Frozen native budget belongs to a different request or root",
            ));
        }
        saved.remaining_ms(at)?;
        self.verify_task_budget(&saved, input_hash, consent_hash)
            .await?;
        Ok(saved)
    }
    pub(super) async fn verify_task_budget(
        &self,
        lease: &BudgetLease,
        input_hash: &str,
        consent_hash: &str,
    ) -> Result<()> {
        self.verify_task_budget_clock(lease, input_hash, consent_hash, None)
            .await
    }
    async fn verify_task_budget_clock(
        &self,
        lease: &BudgetLease,
        input_hash: &str,
        consent_hash: &str,
        clock: Option<i64>,
    ) -> Result<()> {
        use sqlx::Row;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let at = clock.unwrap_or_else(super::store::now);
        let row=sqlx::query("SELECT input_hash,consent_hash,root_id,budget_json,budget_hash FROM task_budget_bindings WHERE request_key=?")
            .bind(&lease.step_key).fetch_optional(&mut *tx).await?
            .ok_or_else(||BenchmarkError::new("budget_clock_conflict","Native root accounting record is absent"))?;
        let body: String = row.try_get("budget_json")?;
        let saved: BudgetLease = serde_json::from_str(&body)?;
        if row.try_get::<String, _>("input_hash")? != input_hash
            || row.try_get::<String, _>("consent_hash")? != consent_hash
            || row.try_get::<String, _>("budget_hash")? != fixtures::hash(body.as_bytes())
            || &saved != lease
        {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native root accounting record differs from bound authority",
            ));
        }
        if row.try_get::<String, _>("root_id")? != lease.root_id {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native accounting root identity changed",
            ));
        }
        let high_water: i64 = sqlx::query_scalar(
            "SELECT MAX(observed_at_ms) FROM task_budget_bindings WHERE root_id=?",
        )
        .bind(&lease.root_id)
        .fetch_one(&mut *tx)
        .await?;
        if at < high_water {
            return Err(BenchmarkError::new(
                "budget_clock_conflict",
                "Native root wall clock decreased after a committed observation",
            ));
        }
        lease.remaining_ms(at)?;
        sqlx::query("UPDATE task_budget_bindings SET observed_at_ms=? WHERE root_id=?")
            .bind(at)
            .bind(&lease.root_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub before: repository::Artifact,
    pub lineage: Vec<repository::Artifact>,
    pub access_all: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicResult {
    pub schema_version: u32,
    pub recipe: String,
    pub report: String,
    pub artifact: repository::Artifact,
}

impl PublicResult {
    pub fn validate(&self, max_bytes: usize) -> Result<()> {
        if self.schema_version != 2
            || self.recipe != repository::ARTIFACT_RECIPE
            || self.artifact.recipe != self.recipe
            || self.report.len() > 128 * 1024
            || self.artifact.patch.len() > max_bytes
            || fixtures::hash(self.artifact.patch.as_bytes()) != self.artifact.patch_hash
            || [
                &self.artifact.root_tree,
                &self.artifact.before_tree,
                &self.artifact.after_tree,
            ]
            .iter()
            .any(|value| ![40, 64].contains(&value.len()) || !hex_digest(value))
            || self.artifact.before_tree.len() != self.artifact.root_tree.len()
            || self.artifact.after_tree.len() != self.artifact.root_tree.len()
            || self.artifact.archive_hash.len() != 64
            || !hex_digest(&self.artifact.archive_hash)
        {
            return Err(BenchmarkError::new(
                "evidence_mismatch",
                "Sealed repository public result is malformed or exceeds its bounds",
            ));
        }
        Ok(())
    }
    pub fn encode(&self, max_bytes: usize) -> Result<String> {
        self.validate(max_bytes)?;
        Ok(serde_json::to_string(self)?)
    }
}
fn hex_digest(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Legacy strings are unchanged. A declared schema-2 result is never treated
/// as legacy after a parse/integrity failure.
pub fn decode(raw: &str, max_bytes: usize) -> Result<Option<PublicResult>> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Ok(None);
    };
    if value.get("schemaVersion") != Some(&serde_json::json!(2)) || value.get("recipe").is_none() {
        return Ok(None);
    }
    let result: PublicResult = serde_json::from_value(value)?;
    result.validate(max_bytes)?;
    Ok(Some(result))
}

pub fn input(draft: &BenchmarkDraft) -> Result<Option<Input>> {
    draft
        .environment
        .get(INPUT_KEY)
        .map(|value| serde_json::from_value(value.clone()).map_err(Into::into))
        .transpose()
}

/// Integer seconds are an upper bound for one native turn; the root wall
/// deadline is checked before actual provider handoff. Durable native records
/// separately enforce their root's persisted high-water clock on recovery.
pub fn remaining_seconds(started_at_ms: i64, current_at_ms: i64, cap_seconds: u32) -> Result<u32> {
    Ok(allowance_ms(started_at_ms, current_at_ms, cap_seconds)?.div_ceil(1000) as u32)
}
fn allowance_ms(started_at_ms: i64, current_at_ms: i64, cap_seconds: u32) -> Result<u64> {
    let elapsed = current_at_ms
        .checked_sub(started_at_ms)
        .filter(|elapsed| *elapsed >= 0)
        .ok_or_else(|| {
            BenchmarkError::new("budget_clock_conflict", "Native root clock moved backwards")
        })? as u64;
    let remaining = u64::from(cap_seconds)
        .checked_mul(1000)
        .unwrap()
        .saturating_sub(elapsed);
    if remaining == 0 {
        return Err(BenchmarkError::new(
            "budget_timeout",
            "Native root wall budget is exhausted",
        ));
    }
    Ok(remaining)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn common_root_clock_counts_preparation_and_refuses_exhaustion_or_rollback() {
        assert_eq!(remaining_seconds(10_000, 13_251, 10).unwrap(), 7);
        assert_eq!(remaining_seconds(10_000, 19_999, 10).unwrap(), 1);
        assert_eq!(
            remaining_seconds(10_000, 20_000, 10).unwrap_err().code,
            "budget_timeout"
        );
        assert_eq!(
            remaining_seconds(10_000, 9_999, 10).unwrap_err().code,
            "budget_clock_conflict"
        );
    }
    #[test]
    fn legacy_output_stays_legacy_and_declared_corrupt_artifact_does_not() {
        assert!(decode("Legacy report", 4096).unwrap().is_none());
        assert!(decode(
            r#"{"schemaVersion":2,"recipe":"repository-cumulative-v1","report":"ok"}"#,
            4096
        )
        .is_err());
    }
    #[tokio::test]
    async fn root_high_water_survives_reopen_and_refuses_backward_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let store = super::super::store::Store::open(directory.path())
            .await
            .unwrap();
        let lease = store
            .reserve_task_budget(
                "invented-root-key",
                "invented-input",
                "invented-consent",
                None,
                10,
                10,
                "invented-root",
            )
            .await
            .unwrap();
        let later = lease.root_started_at_ms + 5_000;
        store
            .verify_task_budget_clock(&lease, "invented-input", "invented-consent", Some(later))
            .await
            .unwrap();
        store.pool.close().await;
        let reopened = super::super::store::Store::open(directory.path())
            .await
            .unwrap();
        let error = reopened
            .verify_task_budget_clock(
                &lease,
                "invented-input",
                "invented-consent",
                Some(later - 1_000),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "budget_clock_conflict");
        reopened
            .verify_task_budget_clock(
                &lease,
                "invented-input",
                "invented-consent",
                Some(later + 1),
            )
            .await
            .unwrap();
    }
}
