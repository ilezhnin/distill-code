//! Host-owned dispatch evidence. Renderer intent never supplies observed fields.
use super::store::SessionStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::Row;

pub(super) const REPORTED_KEY: &str = "__distillReportedSelection";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedSelection {
    pub model_id: Option<String>,
    pub model_name: Option<String>,
    pub effort: Option<String>,
    pub fast: Option<bool>,
}

impl ReportedSelection {
    pub(super) fn read(snapshot: &Value) -> Self {
        snapshot
            .get(REPORTED_KEY)
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutorLink {
    pub decision_key: String,
    pub logical_run_id: String,
}

impl ExecutorLink {
    /// Consume local attribution. It must never be forwarded to a provider.
    pub(super) fn take(meta: &mut Value) -> Result<Option<Self>, String> {
        let Some(value) = meta
            .as_object_mut()
            .and_then(|map| map.remove("executorSelection"))
        else {
            return Ok(None);
        };
        let link: Self =
            serde_json::from_value(value).map_err(|_| "Invalid executor selection attribution")?;
        if [&link.decision_key, &link.logical_run_id]
            .iter()
            .any(|id| id.trim().is_empty() || id.len() > 256)
        {
            return Err("Invalid executor selection attribution".into());
        }
        Ok(Some(link))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptStart {
    pub link: ExecutorLink,
    pub session_id: String,
    pub host_run_id: String,
    pub message_id: String,
    pub bridge_generation: u64,
    pub provider_id: String,
    pub account_id: Option<String>,
    pub started_at: String,
    pub selection: ReportedSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptFinish {
    pub finished_at: String,
    pub status: String,
    pub selection: ReportedSelection,
    pub changes: Vec<ReportedSelection>,
    pub changes_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorReceipt {
    pub start: ReceiptStart,
    pub finish: Option<ReceiptFinish>,
}

fn hash<T: Serialize>(value: &T) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(|e| e.to_string())?)
    ))
}

impl SessionStore {
    /// A second claim is refused even after restart or a lost response. The
    /// caller must never resend an externally ambiguous turn automatically.
    pub async fn claim_executor_receipt(&self, start: &ReceiptStart) -> Result<bool, String> {
        let result = sqlx::query("INSERT OR IGNORE INTO executor_receipts(decision_key,session_id,host_run_id,start_json,start_hash) VALUES(?,?,?,?,?)")
            .bind(&start.link.decision_key).bind(&start.session_id).bind(&start.host_run_id)
            .bind(serde_json::to_string(start).map_err(|e| e.to_string())?).bind(hash(start)?)
            .execute(&self.pool).await.map_err(|e| e.to_string())?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn finish_executor_receipt(
        &self,
        start: &ReceiptStart,
        finish: &ReceiptFinish,
    ) -> Result<(), String> {
        let receipt = self
            .executor_receipt(&start.link.decision_key)
            .await?
            .ok_or("Executor dispatch was not recorded")?;
        if receipt.start != *start {
            return Err("Executor dispatch identity changed".into());
        }
        let payload = serde_json::to_string(finish).map_err(|e| e.to_string())?;
        sqlx::query("UPDATE executor_receipts SET finish_json=?,finish_hash=? WHERE decision_key=? AND finish_json IS NULL")
            .bind(payload).bind(hash(&(&start.link.decision_key, finish))?).bind(&start.link.decision_key)
            .execute(&self.pool).await.map_err(|e| e.to_string())?;
        let saved = self
            .executor_receipt(&start.link.decision_key)
            .await?
            .ok_or("Executor dispatch disappeared")?;
        if saved.finish.as_ref() != Some(finish) {
            return Err("Executor terminal evidence is immutable".into());
        }
        Ok(())
    }

    pub async fn executor_receipt(&self, key: &str) -> Result<Option<ExecutorReceipt>, String> {
        let row = sqlx::query("SELECT session_id,host_run_id,start_json,start_hash,finish_json,finish_hash FROM executor_receipts WHERE decision_key=?")
            .bind(key).fetch_optional(&self.pool).await.map_err(|e| e.to_string())?;
        let Some(row) = row else { return Ok(None) };
        let start: ReceiptStart =
            serde_json::from_str(row.get("start_json")).map_err(|e| e.to_string())?;
        if start.link.decision_key != key
            || start.session_id != row.get::<String, _>("session_id")
            || start.host_run_id != row.get::<String, _>("host_run_id")
            || hash(&start)? != row.get::<String, _>("start_hash")
        {
            return Err("Executor dispatch evidence integrity check failed".into());
        }
        let finish = row
            .get::<Option<String>, _>("finish_json")
            .map(|json| serde_json::from_str::<ReceiptFinish>(&json))
            .transpose()
            .map_err(|e| e.to_string())?;
        if finish
            .as_ref()
            .map(|finish| hash(&(key, finish)))
            .transpose()?
            != row.get::<Option<String>, _>("finish_hash")
        {
            return Err("Executor terminal evidence integrity check failed".into());
        }
        Ok(Some(ExecutorReceipt { start, finish }))
    }
}

#[cfg(test)]
mod tests;
