//! Host-owned dispatch evidence. Renderer intent never supplies observed fields.
use super::store::SessionStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteRow, Row};

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
    pub rejection: Option<ReceiptRejection>,
    pub attempt_index: i64,
    pub previous_attempts: Vec<ExecutorAttempt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptRejection {
    reason: String,
    confirmed_at: String,
    account_id: String,
    pub automatic_account_routing: bool,
}

impl ReceiptRejection {
    /// Called only after the host has withdrawn this turn's recorded prompt.
    pub(super) fn quota_not_accepted(
        error: &Value,
        automatic_account_routing: bool,
    ) -> Option<Self> {
        if error
            .pointer("/data/dispatchStarted")
            .and_then(Value::as_bool)
            != Some(false)
            || error
                .pointer("/data/promptNotAccepted")
                .and_then(Value::as_bool)
                != Some(true)
            || !crate::services::provider_account_status::is_quota_error(error)
        {
            return None;
        }
        Some(Self {
            reason: "quota_not_accepted".into(),
            confirmed_at: super::protocol::now_iso(),
            account_id: error.pointer("/data/accountId")?.as_str()?.to_string(),
            automatic_account_routing,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorAttempt {
    pub start: ReceiptStart,
    pub finish: Option<ReceiptFinish>,
    pub rejection: Option<ReceiptRejection>,
    pub attempt_index: i64,
}

fn hash<T: Serialize>(value: &T) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(|e| e.to_string())?)
    ))
}

impl SessionStore {
    /// Unknown, accepted and ordinary failed attempts remain claimed forever.
    #[cfg(test)]
    pub async fn claim_executor_receipt(&self, start: &ReceiptStart) -> Result<bool, String> {
        self.claim_executor_receipt_with_routing(start, false).await
    }

    pub(super) async fn claim_executor_receipt_with_routing(
        &self,
        start: &ReceiptStart,
        automatic_account_routing: bool,
    ) -> Result<bool, String> {
        let previous = self.executor_receipt(&start.link.decision_key).await?;
        let Some(previous) = previous else {
            let result = sqlx::query("INSERT OR IGNORE INTO executor_receipts(decision_key,session_id,host_run_id,start_json,start_hash) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM executor_rejected_attempts WHERE session_id=? AND host_run_id=?)")
            .bind(&start.link.decision_key).bind(&start.session_id).bind(&start.host_run_id)
            .bind(serde_json::to_string(start).map_err(|e| e.to_string())?).bind(hash(start)?)
            .bind(&start.session_id).bind(&start.host_run_id)
            .execute(&self.pool).await.map_err(|e| e.to_string())?;
            return Ok(result.rows_affected() == 1);
        };
        let Some(rejection) = previous.rejection.as_ref() else {
            return Ok(false);
        };
        if previous.start.link != start.link
            || previous.start.session_id != start.session_id
            || previous.start.provider_id != start.provider_id
            || previous.start == *start
            || (previous.start.account_id != start.account_id
                && !(rejection.automatic_account_routing && automatic_account_routing))
        {
            return Ok(false);
        }
        let next_index = previous
            .attempt_index
            .checked_add(1)
            .ok_or("Too many executor attempts")?;
        let start_hash = hash(&previous.start)?;
        let rejection_hash = rejection_hash(
            &previous.start,
            previous.attempt_index,
            previous.finish.as_ref().unwrap(),
            rejection,
        )?;
        let mut transaction = self.pool.begin().await.map_err(|e| e.to_string())?;
        // This write acquires SQLite's writer lock before replacing the latest
        // attempt. A racing retry can archive this exact attempt only once.
        let archived = sqlx::query("INSERT INTO executor_rejected_attempts SELECT decision_key,attempt_index,session_id,host_run_id,start_json,start_hash,finish_json,finish_hash,rejection_json,rejection_hash FROM executor_receipts WHERE decision_key=? AND attempt_index=? AND start_hash=? AND rejection_hash=?")
            .bind(&start.link.decision_key).bind(previous.attempt_index).bind(&start_hash).bind(rejection_hash)
            .execute(&mut *transaction).await.map_err(|e| e.to_string())?;
        if archived.rows_affected() != 1 {
            return Ok(false);
        }
        let updated = sqlx::query("UPDATE executor_receipts SET session_id=?,host_run_id=?,start_json=?,start_hash=?,finish_json=NULL,finish_hash=NULL,rejection_json=NULL,rejection_hash=NULL,attempt_index=? WHERE decision_key=? AND attempt_index=? AND start_hash=? AND NOT EXISTS (SELECT 1 FROM executor_rejected_attempts WHERE session_id=? AND host_run_id=? AND decision_key<>?)")
            .bind(&start.session_id).bind(&start.host_run_id).bind(serde_json::to_string(start).map_err(|e| e.to_string())?).bind(hash(start)?).bind(next_index)
            .bind(&start.link.decision_key).bind(previous.attempt_index).bind(start_hash)
            .bind(&start.session_id).bind(&start.host_run_id).bind(&start.link.decision_key)
            .execute(&mut *transaction).await.map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            return Ok(false);
        }
        transaction.commit().await.map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub(super) async fn mark_executor_prompt_unaccepted(
        &self,
        link: &ExecutorLink,
        session_id: &str,
        host_run_id: &str,
        rejection: &ReceiptRejection,
    ) -> Result<(), String> {
        let receipt = self
            .executor_receipt(&link.decision_key)
            .await?
            .ok_or("Executor dispatch was not recorded")?;
        if receipt.start.link != *link
            || receipt.start.session_id != session_id
            || receipt.start.host_run_id != host_run_id
            || receipt.start.account_id.as_deref() != Some(rejection.account_id.as_str())
            || receipt
                .finish
                .as_ref()
                .is_none_or(|finish| finish.status != "failed")
        {
            return Err("Unaccepted prompt proof does not match the failed host attempt".into());
        }
        let finish = receipt.finish.as_ref().unwrap();
        sqlx::query("UPDATE executor_receipts SET rejection_json=?,rejection_hash=? WHERE decision_key=? AND start_hash=? AND finish_hash=? AND rejection_json IS NULL")
            .bind(serde_json::to_string(rejection).map_err(|e| e.to_string())?)
            .bind(rejection_hash(&receipt.start, receipt.attempt_index, finish, rejection)?)
            .bind(&link.decision_key).bind(hash(&receipt.start)?).bind(hash(&(&link.decision_key, finish))?)
            .execute(&self.pool).await.map_err(|e| e.to_string())?;
        let saved = self
            .executor_receipt(&link.decision_key)
            .await?
            .ok_or("Executor dispatch disappeared")?;
        if saved.start != receipt.start || saved.rejection.as_ref() != Some(rejection) {
            return Err("Unaccepted prompt proof is immutable".into());
        }
        Ok(())
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
            if receipt
                .previous_attempts
                .iter()
                .any(|attempt| attempt.start == *start && attempt.finish.as_ref() == Some(finish))
            {
                return Ok(());
            }
            return Err("Executor dispatch identity changed".into());
        }
        let payload = serde_json::to_string(finish).map_err(|e| e.to_string())?;
        sqlx::query("UPDATE executor_receipts SET finish_json=?,finish_hash=? WHERE decision_key=? AND start_hash=? AND finish_json IS NULL")
            .bind(payload).bind(hash(&(&start.link.decision_key, finish))?).bind(&start.link.decision_key)
            .bind(hash(start)?)
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
        // A single read transaction joins one consistent attempt history.
        let mut transaction = self.pool.begin().await.map_err(|e| e.to_string())?;
        let row = sqlx::query("SELECT * FROM executor_receipts WHERE decision_key=?")
            .bind(key)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        let Some(row) = row else { return Ok(None) };
        let current = decode_attempt(&row, key)?;
        let archived = sqlx::query(
            "SELECT * FROM executor_rejected_attempts WHERE decision_key=? ORDER BY attempt_index",
        )
        .bind(key)
        .fetch_all(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
        let previous_attempts = archived
            .iter()
            .map(|row| decode_attempt(row, key))
            .collect::<Result<Vec<_>, _>>()?;
        if current.attempt_index != previous_attempts.len() as i64
            || previous_attempts
                .iter()
                .enumerate()
                .any(|(index, attempt)| {
                    attempt.attempt_index != index as i64
                        || attempt.rejection.is_none()
                        || attempt.start.link != current.start.link
                        || attempt.start.session_id != current.start.session_id
                        || attempt.start.provider_id != current.start.provider_id
                })
        {
            return Err("Executor attempt history integrity check failed".into());
        }
        transaction.commit().await.map_err(|e| e.to_string())?;
        Ok(Some(ExecutorReceipt {
            start: current.start,
            finish: current.finish,
            rejection: current.rejection,
            attempt_index: current.attempt_index,
            previous_attempts,
        }))
    }
}

fn rejection_hash(
    start: &ReceiptStart,
    attempt_index: i64,
    finish: &ReceiptFinish,
    rejection: &ReceiptRejection,
) -> Result<String, String> {
    hash(&(start, attempt_index, finish, rejection))
}

fn decode_attempt(row: &SqliteRow, key: &str) -> Result<ExecutorAttempt, String> {
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
    let attempt_index = row.get::<i64, _>("attempt_index");
    let rejection = row
        .get::<Option<String>, _>("rejection_json")
        .map(|payload| serde_json::from_str::<ReceiptRejection>(&payload))
        .transpose()
        .map_err(|e| e.to_string())?;
    let expected_rejection_hash = match &rejection {
        Some(rejection) => {
            let finish = finish
                .as_ref()
                .ok_or("An unaccepted attempt must be terminal")?;
            if rejection.reason != "quota_not_accepted"
                || finish.status != "failed"
                || start.account_id.as_deref() != Some(rejection.account_id.as_str())
            {
                return Err("Unaccepted prompt proof is invalid".into());
            }
            Some(rejection_hash(&start, attempt_index, finish, rejection)?)
        }
        None => None,
    };
    if attempt_index < 0
        || expected_rejection_hash != row.get::<Option<String>, _>("rejection_hash")
    {
        return Err("Unaccepted prompt evidence integrity check failed".into());
    }
    Ok(ExecutorAttempt {
        start,
        finish,
        rejection,
        attempt_index,
    })
}

#[cfg(test)]
mod tests;
