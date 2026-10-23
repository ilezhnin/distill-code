//! Preserve operational failures before retry/stop replaces the current reason.
use super::*;

/// Metadata only: retaining a diagnostic never clones a candidate's answer,
/// screenshots, rubric, or the panel's growing evaluation payload.
pub(crate) fn identity(attempt: &Attempt) -> Attempt {
    let mut identity = super::super::pending_attempt(
        &attempt.run_id,
        &attempt.version_id,
        &attempt.configuration,
        attempt.repetition,
    );
    identity.id.clone_from(&attempt.id);
    identity.phase.clone_from(&attempt.phase);
    identity.session_id.clone_from(&attempt.session_id);
    identity.host_run_id.clone_from(&attempt.host_run_id);
    identity
}

/// Preserve the original failure even when the diagnostic store itself fails.
/// The caller still saves paid receipts; its visible error reports both failures.
pub(crate) async fn record(
    store: &Store,
    attempt: &Attempt,
    stage: &str,
    mut error: BenchmarkError,
    judge: Option<&Configuration>,
    mut context: Value,
) -> BenchmarkError {
    if !context.is_object() {
        context = json!({});
    }
    context["versionId"] = json!(attempt.version_id);
    if let Some(reset) = error.details.as_ref().and_then(|d| d["nextReset"].as_i64()) {
        context["nextReset"] = json!(reset);
    }
    if let Err(storage) = store
        .record_diagnostic(attempt, stage, &error, judge, context)
        .await
    {
        let original = crate::services::log_redaction::redact_log_line(&error.message);
        let storage = crate::services::log_redaction::redact_log_line(&storage.message);
        log::error!(
            "[benchmarks] diagnostic persistence failed for attempt {} at {stage}: {}: {original}; storage: {storage}",
            attempt.id,
            error.code,
        );
        error.message = format!("{original}. Diagnostic history could not be saved: {storage}");
        if !error.details.as_ref().is_some_and(Value::is_object) {
            error.details = Some(json!({}));
        }
        error.details.as_mut().expect("object initialized")["diagnosticPersistenceFailed"] =
            json!(true);
    }
    error
}

pub(super) struct JudgeTrace {
    pub stage: &'static str,
    pub context: Value,
}

impl JudgeTrace {
    pub fn new(batch: &str, index: usize) -> Self {
        Self {
            stage: "judge_preflight",
            context: json!({"judgeBatchId": batch, "judgeIndex": index, "dispatched": false}),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_storage_failure_is_visible_even_for_named_wait_reasons() {
        for code in [JUDGE_QUOTA_WAIT, ACCOUNT_BUSY, SIGN_IN_WAIT] {
            let error = BenchmarkError::new(
                code,
                "Original cause. Diagnostic history could not be saved",
            )
            .with_details(json!({"diagnosticPersistenceFailed":true}));
            assert!(judge_error_reason(&error).contains(&error.message));
        }
    }

    #[tokio::test]
    async fn diagnostic_storage_failure_keeps_the_original_error_visible() {
        let (directory, service, _) = super::super::tests::setup().await;
        let request = super::super::tests::request(&service).await;
        let run = service.start_run(request).await.unwrap();
        let attempt = &run.attempts[0];
        sqlx::query("CREATE TRIGGER refuse_diagnostic_write BEFORE INSERT ON attempt_diagnostics BEGIN SELECT RAISE(FAIL,'invented diagnostic write failure'); END")
            .execute(&service.store.pool).await.unwrap();
        let error = record(
            &service.store,
            attempt,
            "judge_session",
            BenchmarkError::new(
                "resource_busy",
                "Invented memory refusal token=fixture-secret",
            )
            .with_details(json!(["non-object original details"])),
            None,
            json!({"dispatched":false}),
        )
        .await;
        assert_eq!(error.code, "resource_busy");
        assert!(error.message.contains("Invented memory refusal"));
        assert!(error
            .message
            .contains("Diagnostic history could not be saved"));
        assert!(error.message.contains("invented diagnostic write failure"));
        assert!(!error.message.contains("fixture-secret"));
        assert_eq!(error.details.unwrap()["diagnosticPersistenceFailed"], true);
        directory.close().await;
    }
}
