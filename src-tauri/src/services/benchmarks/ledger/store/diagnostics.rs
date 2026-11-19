//! Append-only operational history. Never put evidence, prompts, provider
//! payloads or token measurements here. Callers supply explicit metadata;
//! arbitrary error.details and unknown context keys are deliberately omitted.
use super::*;
use crate::services::log_redaction::redact_log_line;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_MESSAGE_BYTES: usize = 4096;
const MAX_METADATA_BYTES: usize = 256;

fn bounded(value: &str, limit: usize) -> String {
    let value = redact_log_line(value);
    if value.len() <= limit {
        return value;
    }
    const MARKER: &str = "...[truncated]";
    let mut end = limit.saturating_sub(MARKER.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{MARKER}", &value[..end])
}

fn configuration(value: &Configuration) -> DiagnosticConfiguration {
    let text = |v: &str| bounded(v, MAX_METADATA_BYTES);
    DiagnosticConfiguration {
        provider_id: text(&value.provider_id),
        account_id: value.account_id.as_deref().map(text),
        model_id: text(&value.model_id),
        effort: value.effort.as_deref().map(text),
        fast_mode: value.fast_mode,
        billing_mode: text(&value.billing_mode),
        execution_profile: text(&value.execution_profile),
        inventory_revision: value.inventory_revision.as_deref().map(text),
    }
}

fn context(value: Value) -> Value {
    let mut result = serde_json::Map::new();
    if let Some(source) = value.as_object() {
        for key in [
            "sessionId",
            "providerId",
            "accountId",
            "hostRunId",
            "judgeBatchId",
            "judgeIndex",
            "jobId",
            "waitUntil",
            "retryAfterMs",
            "resourceKind",
            "resourceStage",
            "admissionReason",
            "source",
            "reasonTransition",
            "requestKey",
            "versionId",
            "elapsedMs",
            "dispatched",
            "usageComplete",
            "inFlight",
            "nextReset",
            "operation",
            "renderer",
            "limitMs",
        ] {
            if let Some(value) = source.get(key) {
                let clean = match value {
                    Value::String(text) => Value::String(bounded(text, MAX_METADATA_BYTES)),
                    Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
                    _ => continue,
                };
                result.insert(key.into(), clean);
            }
        }
        if let Some(snapshot) = source.get("resourceSnapshot").and_then(Value::as_object) {
            let mut entries: Vec<_> = snapshot.iter().collect();
            entries.sort_by_key(|(key, _)| *key);
            let mut safe = serde_json::Map::new();
            for (key, value) in entries.into_iter().filter(|(_, v)| v.is_number()).take(32) {
                // Numeric measurements only; no arbitrary broker/provider output.
                safe.insert(bounded(key, 64), value.clone());
            }
            result.insert("resourceSnapshot".into(), Value::Object(safe));
        }
    }
    result.insert("appVersion".into(), json!(env!("FLOCK_BUILD_VERSION")));
    Value::Object(result)
}

async fn record(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    attempt: &Attempt,
    phase: &str,
    stage: &str,
    error: &BenchmarkError,
    judge: Option<&Configuration>,
    metadata: Value,
) -> Result<()> {
    let candidate = serde_json::to_string(&configuration(&attempt.configuration))?;
    let judge = serde_json::to_string(&judge.map(configuration))?;
    let metadata = serde_json::to_string(&context(metadata))?;
    // Hash the complete redacted cause before display truncation. Two long
    // causes that differ after the display bound must remain distinct events.
    let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&(
        &attempt.run_id,
        phase,
        stage,
        &error.code,
        redact_log_line(&error.message),
        &candidate,
        &judge,
        &metadata,
    ))?));
    let latest = sqlx::query(
        "SELECT sequence,fingerprint FROM attempt_diagnostics WHERE attempt_id=? ORDER BY sequence DESC LIMIT 1",
    ).bind(&attempt.id).fetch_optional(&mut **tx).await?;
    let at = now();
    if let Some(latest) = latest.filter(|row| row.get::<String, _>(1) == fingerprint) {
        sqlx::query("UPDATE attempt_diagnostics SET last_at=MAX(last_at,?),occurrences=occurrences+1 WHERE sequence=?")
            .bind(at).bind(latest.get::<i64, _>(0)).execute(&mut **tx).await?;
    } else {
        sqlx::query("INSERT INTO attempt_diagnostics(first_at,last_at,occurrences,run_id,attempt_id,phase,stage,code,message,candidate_json,judge_json,context_json,fingerprint) VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?)")
            .bind(at).bind(at).bind(&attempt.run_id).bind(&attempt.id)
            .bind(bounded(phase,64)).bind(bounded(stage,64)).bind(bounded(&error.code,128))
            .bind(bounded(&error.message,MAX_MESSAGE_BYTES)).bind(candidate).bind(judge)
            .bind(metadata).bind(fingerprint).execute(&mut **tx).await?;
    }
    Ok(())
}

/// Runs inside save_attempt's transaction. Only reason changes are events;
/// ordinary saves of the same waiting reason must not inflate occurrences.
pub(super) async fn capture_reason(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    attempt: &Attempt,
    previous_reason: Option<String>,
    previous_phase: String,
) -> Result<()> {
    let old = previous_reason.as_deref().filter(|s| !s.is_empty());
    let new = attempt.reason.as_deref().filter(|s| !s.is_empty());
    // At the upgrade boundary preserve a pre-existing reason before its first
    // overwrite/clear. Subsequent saves never synthesize this observation again.
    if let Some(old) = old {
        let captured: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attempt_diagnostics WHERE attempt_id=? AND stage='attempt_reason')")
            .bind(&attempt.id).fetch_one(&mut **tx).await?;
        if !captured {
            record(
                tx,
                attempt,
                &previous_phase,
                "attempt_reason",
                &BenchmarkError::new("reason_changed", old),
                None,
                json!({"reasonTransition":"previous_reason_observed"}),
            )
            .await?;
        }
    }
    if old != new {
        let (code, message, transition) = match new {
            Some(reason) => ("reason_changed", reason, "changed"),
            None => ("reason_cleared", "Attempt reason cleared", "cleared"),
        };
        record(
            tx,
            attempt,
            &attempt.phase,
            "attempt_reason",
            &BenchmarkError::new(code, message),
            None,
            json!({"reasonTransition":transition}),
        )
        .await?;
    }
    Ok(())
}

impl Store {
    pub async fn record_diagnostic(
        &self,
        attempt: &Attempt,
        stage: &str,
        error: &BenchmarkError,
        judge: Option<&Configuration>,
        context: Value,
    ) -> Result<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        record(
            &mut tx,
            attempt,
            &attempt.phase,
            stage,
            error,
            judge,
            context,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Exclusive sequence cursor, newest first. Pagination bounds the read,
    /// never the stored history. Coalescing only changes a row's count/time.
    pub async fn diagnostics(
        &self,
        attempt_id: &str,
        before: Option<i64>,
        limit: u32,
    ) -> Result<DiagnosticPage> {
        let limit = limit.clamp(1, 100) as usize;
        let rows = sqlx::query("SELECT sequence,first_at,last_at,occurrences,run_id,attempt_id,phase,stage,code,message,candidate_json,judge_json,context_json FROM attempt_diagnostics WHERE attempt_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?")
            .bind(attempt_id).bind(before.unwrap_or(i64::MAX)).bind((limit+1) as i64)
            .fetch_all(&self.pool).await?;
        let more = rows.len() > limit;
        let mut items = Vec::with_capacity(rows.len().min(limit));
        for row in rows.into_iter().take(limit) {
            items.push(Diagnostic {
                sequence: row.get(0),
                first_at: row.get(1),
                last_at: row.get(2),
                occurrences: row.get::<i64, _>(3) as u64,
                run_id: row.get(4),
                attempt_id: row.get(5),
                phase: row.get(6),
                stage: row.get(7),
                code: row.get(8),
                message: row.get(9),
                candidate: serde_json::from_str(row.get(10))?,
                judge: serde_json::from_str(row.get(11))?,
                context: serde_json::from_str(row.get(12))?,
            });
        }
        let next_before = more.then(|| items.last().expect("nonempty page").sequence);
        Ok(DiagnosticPage { items, next_before })
    }
}

#[cfg(test)]
mod tests;
