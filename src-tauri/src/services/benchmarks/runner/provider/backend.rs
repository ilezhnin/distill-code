//! The port a run executes through.
use super::*;

/// Whether `error` refused an evaluation before any evaluator worker started:
/// the local broker queued it, its admission window closed in a queue, the
/// host preparation queue expired, the host gate's evidence expired or the
/// host lacked headroom. Only the trusted pre-start path reports
/// `resource_busy`, so nothing graded the answer and nothing was spent: the
/// same evaluation may be asked again, and the refusal is no verdict.
pub(in crate::services::benchmarks) fn unstarted_refusal(error: &BenchmarkError) -> bool {
    error.code == "resource_busy"
}

pub trait ExecutionBackend: Send + Sync {
    fn validate_owned_task_context<'a>(
        &'a self,
        _binding: &'a crate::services::benchmarks::task_execution::Binding,
        _session: &'a crate::services::benchmarks::task_execution::Session,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn reopen_owned_task<'a>(
        &'a self,
        _binding: &'a crate::services::benchmarks::task_execution::Binding,
        _session: &'a crate::services::benchmarks::task_execution::Session,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async {
            Err(BenchmarkError::new(
                "capability_missing",
                "This backend cannot reopen an owned transcript",
            ))
        })
    }
    fn owned_task_output<'a>(
        &'a self,
        _binding: &'a crate::services::benchmarks::task_execution::Binding,
        _session: &'a crate::services::benchmarks::task_execution::Session,
    ) -> BoxFuture<'a, Result<crate::services::benchmarks::task_execution::NativeOutput>> {
        Box::pin(async {
            Err(BenchmarkError::new(
                "capability_missing",
                "This backend cannot attest native predecessor outputs",
            ))
        })
    }
    fn prepare_owned_task<'a>(
        &'a self,
        _store: &'a Store,
        _binding: &'a crate::services::benchmarks::task_execution::Binding,
        _chosen: &'a Configuration,
    ) -> BoxFuture<'a, Result<crate::services::benchmarks::task_execution::Session>> {
        Box::pin(async {
            Err(BenchmarkError::new(
                "capability_missing",
                "This backend has no application owned adapter",
            ))
        })
    }
    fn recover_owned_task_preparation<'a>(
        &'a self,
        _binding: &'a crate::services::benchmarks::task_execution::Binding,
    ) -> BoxFuture<'a, Result<crate::services::benchmarks::task_execution::NativePreparationLookup>>
    {
        Box::pin(async {
            Ok(
                crate::services::benchmarks::task_execution::NativePreparationLookup {
                    session_id: None,
                    no_provider_start: false,
                },
            )
        })
    }
    fn dispatch_owned_task<'a>(
        &'a self,
        _store: &'a Store,
        _binding: &'a crate::services::benchmarks::task_execution::Binding,
        _session: &'a crate::services::benchmarks::task_execution::Session,
        _admission: tokio::sync::OwnedMutexGuard<()>,
    ) -> BoxFuture<'a, Result<ExecutionDispatch>> {
        Box::pin(async {
            Err(BenchmarkError::new(
                "capability_missing",
                "This backend has no application owned dispatch",
            ))
        })
    }
    /// Records the native no-prompt terminal outcome for a prepared task whose
    /// root budget expired before dispatch. Only the host can prove absence.
    fn refuse_owned_task_dispatch<'a>(
        &'a self,
        _binding: &'a crate::services::benchmarks::task_execution::Binding,
        _session: &'a crate::services::benchmarks::task_execution::Session,
    ) -> BoxFuture<'a, Result<ExecutionDispatch>> {
        Box::pin(async {
            Err(BenchmarkError::new(
                "capability_missing",
                "This backend cannot record a native budget refusal",
            ))
        })
    }
    fn owned_task_status<'a>(
        &'a self,
        _binding: &'a crate::services::benchmarks::task_execution::Binding,
        _session: &'a crate::services::benchmarks::task_execution::Session,
    ) -> BoxFuture<'a, Result<Option<ExecutionDispatch>>> {
        Box::pin(async {
            Err(BenchmarkError::new(
                "capability_missing",
                "This backend has no application owned status",
            ))
        })
    }
    fn cancel_owned_task<'a>(
        &'a self,
        _binding: &'a crate::services::benchmarks::task_execution::Binding,
        _session: &'a crate::services::benchmarks::task_execution::Session,
        _close: bool,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async {
            Err(BenchmarkError::new(
                "capability_missing",
                "This backend has no application owned cancellation",
            ))
        })
    }
    fn unsupported(&self, configuration: &Configuration, draft: &BenchmarkDraft) -> Option<String>;
    /// The benchmark sessions the host no longer needs for itself (see
    /// `session_retention`). Fixture backends open no host sessions.
    fn settled_sessions<'a>(
        &'a self,
    ) -> BoxFuture<'a, Result<Vec<crate::services::agent_host::store::BenchmarkSessionEntry>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    /// Removes finished benchmark sessions from the host.
    fn purge_sessions<'a>(
        &'a self,
        _sessions: &'a [String],
    ) -> BoxFuture<'a, Result<crate::services::agent_host::store::PurgeStats>> {
        Box::pin(async { Ok(Default::default()) })
    }
    fn readiness<'a>(&'a self, _configuration: &'a Configuration) -> BoxFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    /// Renews `provider`'s offline sandbox check when it went stale, as each
    /// update of the app makes it. Fixture backends have no sandbox.
    fn renew_stale_policy_check<'a>(&'a self, _provider: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    /// Resource waits happen before creating a provider session or spending a
    /// model turn. Fixture backends do not consume local sandbox resources.
    fn resource_admission<'a>(
        &'a self,
        _configuration: &'a Configuration,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    /// Whether this backend's attempts ask the local sandbox for admission
    /// when their session opens, so the runner paces how many it prepares at
    /// once by the answers (see `admission_window`). Fixture backends ask
    /// nothing.
    fn paces_preparation(&self) -> bool {
        false
    }
    /// When `account`'s spent usage limit for `model_id` resets, as its last
    /// usage read says; none where it shows no spent limit or nothing is
    /// known. Fixture backends know nothing.
    fn spent_until<'a>(
        &'a self,
        _account: &'a str,
        _model_id: &'a str,
    ) -> BoxFuture<'a, Option<i64>> {
        Box::pin(async { None })
    }
    fn readiness_for_budget<'a>(
        &'a self,
        configuration: &'a Configuration,
        _timeout_seconds: u32,
    ) -> BoxFuture<'a, Result<()>> {
        self.readiness(configuration)
    }
    /// Grades `output` with the published evaluator. The local sandbox may
    /// refuse before any evaluator worker starts; see [`unstarted_refusal`].
    fn evaluate_output<'a>(
        &'a self,
        draft: &'a BenchmarkDraft,
        output: &'a str,
    ) -> BoxFuture<'a, Result<Evaluation>> {
        Box::pin(evaluate(draft, output))
    }
    /// Scores a creative rendering with a panel of other models; nothing happens
    /// where no panel can be assembled.
    fn judge<'a>(
        &'a self,
        _store: &'a Store,
        attempt: Attempt,
        _version: &'a BenchmarkVersion,
        _stop: JudgeStop,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move { Ok(attempt) })
    }
    fn judge_control<'a>(
        &'a self,
        _store: &'a Store,
        _record: &'a mut crate::services::benchmarks::qualification::Record,
        _version: &'a BenchmarkVersion,
        _index: usize,
    ) -> BoxFuture<'a, Result<Evaluation>> {
        Box::pin(async {
            Err(BenchmarkError::new(
                "capability_missing",
                "This backend cannot calibrate a rubric panel",
            ))
        })
    }
    /// The judge a judge pool calibration of `entry` asks: the roomiest
    /// enabled account that offers its model and effort.
    fn calibration_judge<'a>(
        &'a self,
        _entry: &'a crate::services::benchmarks::judge_pool::Entry,
        _calibration: &'a str,
    ) -> BoxFuture<'a, Result<Configuration>> {
        Box::pin(async {
            Err(BenchmarkError::new(
                "capability_missing",
                "This backend cannot calibrate a judge",
            ))
        })
    }
    /// One rubric qualification control judged by `judge` alone, for a judge
    /// pool calibration: the judged carrier, kept out of the record.
    fn calibrate_control<'a>(
        &'a self,
        _store: &'a Store,
        _version: &'a BenchmarkVersion,
        _record: &'a crate::services::benchmarks::qualification::Record,
        _index: usize,
        _judge: &'a Configuration,
        _directory: std::path::PathBuf,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async {
            Err(BenchmarkError::new(
                "capability_missing",
                "This backend cannot calibrate a judge",
            ))
        })
    }
    /// Settles judge turns a restart cut off. Without host records their usage
    /// stays unknown; the reply never counts as a vote.
    fn reconcile_judges<'a>(
        &'a self,
        _store: &'a Store,
        mut attempt: Attempt,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            for evaluation in attempt.evaluations.iter_mut().filter(|e| in_flight(e)) {
                settle_interrupted_judge(evaluation, None);
            }
            Ok(attempt)
        })
    }
    fn execute<'a>(
        &'a self,
        store: &'a Store,
        attempt: Attempt,
        version: BenchmarkVersion,
        timeout: u32,
        cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>>;
    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        refresh: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>>;
    fn recover<'a>(
        &'a self,
        _store: &'a Store,
        attempt: Attempt,
    ) -> BoxFuture<'a, Result<Option<Attempt>>> {
        Box::pin(async move {
            Ok((attempt.evidence_hash.is_some() && attempt.output.is_some()).then_some(attempt))
        })
    }
    fn activity<'a>(
        &'a self,
        _configuration: &'a Configuration,
    ) -> BoxFuture<'a, Result<AccountActivity>> {
        Box::pin(async {
            Ok(AccountActivity {
                active_sessions: Vec::new(),
                generation: 0,
            })
        })
    }
    /// The enabled accounts of `provider` a turn may run on, its default
    /// first; none for a provider with only the CLI's own sign-in. With
    /// `credits`, an account whose plan usage is spent but whose purchased
    /// credits cover it still has room.
    fn accounts<'a>(
        &'a self,
        _provider: &'a str,
        _credits: bool,
    ) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// Host errors read "code: reason". Any other text, such as a provider's own
/// "Internal error: ..." message, is an infrastructure failure.
pub fn host_error(message: String) -> BenchmarkError {
    match message.split_once(':') {
        Some((code, reason))
            if !code.is_empty() && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') =>
        {
            BenchmarkError::new(code, reason.trim())
        }
        _ => BenchmarkError::new("infrastructure_failure", message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_violation_is_its_own_unscored_outcome() {
        assert_eq!(
            terminal_error_outcome(
                &json!({"kind":"execution_violation","message":"execution_violation: native execution violated the declared no-tool policy"})
            ),
            "execution_violation"
        );
        assert_eq!(
            terminal_error_outcome(&json!({"kind":"capability_missing"})),
            "unsupported"
        );
        let tagged = json!({"params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","_meta":{"executionViolation":"native tool activity in no-tool profile"}}}});
        assert_eq!(
            violation_of(&tagged).as_deref(),
            Some("native tool activity in no-tool profile")
        );
        assert_eq!(
            violation_of(&tagged["params"]).as_deref(),
            Some("native tool activity in no-tool profile")
        );
        assert_eq!(
            violation_of(&json!({"update":{"sessionUpdate":"agent_message_chunk"}})),
            None
        );
        let attempt = |outcome: &str| -> Attempt {
            serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v",
                "configuration":{"id":"c","providerId":"claude-acp","accountId":"x","modelId":"m","billingMode":"subscription","executionProfile":"native_text"},
                "repetition":0,"phase":"terminal","outcome":outcome,"output":"answer","finishedAt":1,
                "usage":{"schema":"native"},"eventCursor":0,"workflowSteps":[],
                "evaluations":[{"id":"e","evaluatorRevision":"r","verdict":"pass","score":1.0,"reason":"","createdAt":1,"provenance":"deterministic"}]}))
            .unwrap()
        };
        assert_eq!(
            crate::services::benchmarks::analysis::score(&attempt("pass")),
            Some(1.0)
        );
        assert_eq!(
            crate::services::benchmarks::analysis::score(&attempt("execution_violation")),
            None
        );
    }
}
