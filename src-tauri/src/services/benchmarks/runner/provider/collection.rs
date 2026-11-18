//! Collecting a repository attempt's answer from its sandbox.
use super::*;

/// A repository answer comes from the stopped working copy, never the agent's
/// final message. A collection error cannot masquerade as an empty patch.
#[cfg(test)]
async fn collect_repository(attempt: &mut Attempt, id: &str, cap: u64) -> Result<()> {
    collect_repository_until(attempt, id, cap, None).await
}

/// Removes the sandbox of an attempt whose answer is already sealed and
/// saved. A clean that fails (a credential conflict, its time limit on a large
/// tree, a process stuck in the kernel, a second clean of the same id) is
/// logged and left armed, so the guard's drop and the reaper try again; it
/// never turns a paid, scored attempt into a storage failure.
pub(in super::super) async fn clean_sealed<F, Fut>(cleanup: &mut sandbox::Cleanup, clean: F)
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = std::io::Result<()>>,
{
    let Some(id) = cleanup.0.clone() else {
        return;
    };
    match clean(id.clone()).await {
        Ok(()) => cleanup.0 = None,
        Err(error) => {
            log::warn!("[benchmarks] sealed attempt sandbox {id} not cleaned yet: {error}")
        }
    }
}

/// Why the check that a workspace is still its acknowledged copy failed: a
/// diff past one byte (`FileTooLarge`) or one Git cannot encode
/// (`InvalidData`) is the copy having `changed`; a broker refusal waits like
/// any other; anything else is the sandbox failing, never a changed selection.
pub(in super::super) fn untouched_check_error(
    error: std::io::Error,
    changed: &str,
) -> BenchmarkError {
    match error.kind() {
        std::io::ErrorKind::FileTooLarge | std::io::ErrorKind::InvalidData => {
            BenchmarkError::new("selection_changed", changed)
        }
        std::io::ErrorKind::WouldBlock if error.to_string().starts_with("resource_busy:") => {
            BenchmarkError::new("resource_busy", error.to_string())
        }
        _ => BenchmarkError::new(
            "infrastructure_failure",
            format!("Sandbox workspace check: {error}"),
        ),
    }
}

/// A `*_until` helper reports `TimedOut` only once the native deadline has
/// passed. Without a deadline a timeout is the helper's own control limit,
/// an infrastructure failure rather than budget exhaustion.
pub(in super::super) fn sandbox_setup_error(
    error: std::io::Error,
    deadline: Option<u64>,
) -> BenchmarkError {
    if error.kind() == std::io::ErrorKind::WouldBlock
        && error.to_string().starts_with("resource_busy:")
    {
        BenchmarkError::new("resource_busy", error.to_string())
    } else if deadline.is_some() && error.kind() == std::io::ErrorKind::TimedOut {
        BenchmarkError::new("budget_timeout", error.to_string())
    } else {
        // Still storage_unavailable, which stops the run for the operator: a
        // sandbox that cannot build workspaces fails every attempt alike. The
        // reason names the sandbox, as the check path's does.
        BenchmarkError::new(
            "storage_unavailable",
            format!("Repository sandbox: {error}"),
        )
    }
}

pub(in super::super) fn unsigned_deadline(deadline: i64) -> Result<u64> {
    deadline
        .try_into()
        .map_err(|_| BenchmarkError::new("budget_clock_conflict", "Native deadline is invalid"))
}

async fn preparation_gate(deadline: Option<u64>) -> Result<sandbox::HostPreparation> {
    let admission_deadline = deadline.unwrap_or((now() as u64).saturating_add(420_000));
    sandbox::host_preparation(admission_deadline)
        .await
        .map_err(|error| sandbox_setup_error(error, deadline))
}

/// Builds workspace `id` from the published, already verified `snapshot`:
/// the sandbox's cached copy of its tree when it held one at its last use.
/// Otherwise the snapshot is archived here, under the host preparation gate,
/// and sent, and the sandbox keeps it for the attempts and checks after.
///
/// Boxed: an attempt awaits it under many layers on a runtime worker stack.
pub(in super::super) fn copy_snapshot<'a>(
    id: &'a str,
    snapshot: &'a crate::services::benchmarks::repository::Snapshot,
    deadline: Option<u64>,
) -> BoxFuture<'a, Result<()>> {
    Box::pin(async move {
        let setup_error = |error| sandbox_setup_error(error, deadline);
        if sandbox::snapshot_cached(&snapshot.tree)
            && sandbox::copy_tree(id, &snapshot.tree, None, deadline)
                .await
                .map_err(setup_error)?
        {
            return Ok(());
        }
        let _preparation = preparation_gate(deadline).await?;
        let archive = match deadline {
            Some(deadline) => {
                crate::services::benchmarks::repository::archive_until(snapshot, deadline).await?
            }
            None => crate::services::benchmarks::repository::archive(snapshot).await?,
        };
        sandbox::copy_tree(id, &snapshot.tree, Some(&archive), deadline)
            .await
            .map_err(setup_error)?;
        Ok(())
    })
}

pub(in super::super) fn collection_budget(
    draft: &BenchmarkDraft,
) -> Result<Option<crate::services::benchmarks::artifact_context::BudgetLease>> {
    draft
        .environment
        .get(crate::services::benchmarks::artifact_context::CLOCK_KEY)
        .map(|value| serde_json::from_value(value.clone()).map_err(Into::into))
        .transpose()
}

/// [`collection_budget`] with its root's credited idle time (see
/// `artifact_context::BudgetLease::credits`).
pub(in super::super) async fn credited_budget(
    store: &Store,
    draft: &BenchmarkDraft,
) -> Result<Option<crate::services::benchmarks::artifact_context::BudgetLease>> {
    let mut budget = collection_budget(draft)?;
    if let Some(lease) = budget.as_mut() {
        store.credit(lease).await?;
    }
    Ok(budget)
}

pub(in super::super) fn turn_timeout_ms(
    seconds: u32,
    budget: Option<&crate::services::benchmarks::artifact_context::BudgetLease>,
) -> Result<u64> {
    let cap = u64::from(seconds) * 1000;
    budget.map_or(Ok(cap), |budget| Ok(cap.min(budget.remaining_ms(now())?)))
}

pub(in super::super) async fn collect_repository_until(
    attempt: &mut Attempt,
    id: &str,
    cap: u64,
    deadline: Option<u64>,
) -> Result<()> {
    sandbox::kill("session", id).await?;
    let limit = usize::try_from(cap).unwrap_or(usize::MAX);
    let patch = match deadline {
        Some(deadline) => sandbox::patch_until(id, limit, deadline).await,
        None => sandbox::patch(id, limit).await,
    };
    match patch {
        Ok(bytes) => {
            attempt.output = Some(String::from_utf8(bytes).map_err(|_| {
                BenchmarkError::new("infrastructure_failure", "Repository patch is not UTF-8")
            })?);
        }
        Err(error) if error.kind() == std::io::ErrorKind::FileTooLarge => {
            attempt.output = Some(String::new());
            attempt.outcome = Some("budget_reached".into());
            attempt.reason = Some("The repository patch exceeds the published artifact cap".into());
        }
        Err(error) if deadline.is_some() && error.kind() == std::io::ErrorKind::InvalidData => {
            return Err(BenchmarkError::new(
                "candidate_artifact_invalid",
                error.to_string(),
            ));
        }
        Err(error) => return Err(sandbox_setup_error(error, deadline)),
    }
    Ok(())
}

pub(in super::super) async fn finalize_repository(
    attempt: &mut Attempt,
    id: &str,
    draft: &BenchmarkDraft,
    input: Option<&crate::services::benchmarks::artifact_context::Input>,
    deadline: Option<u64>,
) -> Result<()> {
    let report = attempt.output.clone().unwrap_or_default();
    if input.is_some() && report.len() > 128 * 1024 {
        return Err(BenchmarkError::new(
            "budget_reached",
            "Repository report exceeds its sealed report limit",
        ));
    }
    collect_repository_until(attempt, id, draft.limits.max_artifact_bytes, deadline).await?;
    if attempt.outcome.as_deref() == Some("budget_reached") {
        return Ok(());
    }
    if let Some(input) = input {
        let snapshot = crate::services::benchmarks::repository::snapshot(draft)?;
        let deadline = deadline.ok_or_else(|| {
            BenchmarkError::new(
                "budget_clock_conflict",
                "Cumulative repository collection has no native root deadline",
            )
        })?;
        let sealed = crate::services::benchmarks::repository::seal_until(
            &snapshot,
            &input.before,
            attempt.output.as_deref().unwrap_or_default(),
            draft.limits.max_artifact_bytes as usize,
            deadline,
        )
        .await?;
        let result = crate::services::benchmarks::artifact_context::PublicResult {
            schema_version: 2,
            recipe: crate::services::benchmarks::repository::ARTIFACT_RECIPE.into(),
            report,
            artifact: sealed.artifact,
        };
        result.validate(draft.limits.max_artifact_bytes as usize)?;
        attempt.output = Some(result.artifact.patch.clone());
        attempt.repository_result = Some(result);
    }
    Ok(())
}

/// Seal the heavy-lane setting and competing load the candidate session was
/// admitted under with the attempt, so speed comparisons can account for it.
pub(in super::super) fn record_sandbox_admission(
    attempt: &mut Attempt,
    evidence: &mut Value,
    sandbox_id: Option<&str>,
) {
    if let Some(admission) = sandbox_id.and_then(sandbox::take_session_admission) {
        evidence["sandboxAdmission"] = json!(admission);
        attempt.sandbox_admission = Some(admission);
    }
}

/// A session's own memory ceiling that killed a command the agent ran for
/// the candidate takes the bridge with the leaf, so the turn ends as an
/// infrastructure failure. The broker keeps that verdict for the session's
/// job `id`; with it the attempt is the candidate's answer past its budget,
/// scored 0 like a check past its own ceiling. Returns the verdict to seal
/// with the evidence; one that cannot be read leaves the outcome as it was.
pub(in super::super) async fn settle_session_limit(
    attempt: &mut Attempt,
    id: &str,
) -> Option<Value> {
    if attempt.outcome.as_deref() != Some("infrastructure_failure") {
        return None;
    }
    let verdict = match sandbox::session_verdict(id).await {
        Ok(verdict) => verdict?,
        Err(error) => {
            log::warn!("[benchmarks] cannot read the session verdict of sandbox {id}: {error}");
            return None;
        }
    };
    apply_session_limit(attempt, &verdict);
    Some(json!(verdict))
}

fn apply_session_limit(attempt: &mut Attempt, verdict: &sandbox::SessionVerdict) {
    if attempt.outcome.as_deref() != Some("infrastructure_failure") {
        return;
    }
    let command = verdict
        .victim
        .as_deref()
        .map(|name| format!(" ({name})"))
        .unwrap_or_default();
    let ended = attempt
        .reason
        .take()
        .map(|reason| format!("; the session then ended with {reason}"))
        .unwrap_or_default();
    attempt.outcome = Some("budget_reached".into());
    attempt.reason = Some(format!(
        "A command the agent ran for the candidate{command} passed the session's own {} ceiling{ended}",
        verdict.candidate_limit
    ));
}

pub(in super::super) fn repository_collection_failure(
    attempt: &mut Attempt,
    error: &BenchmarkError,
) {
    if attempt
        .outcome
        .as_deref()
        .is_none_or(|outcome| outcome == "completed")
    {
        attempt.outcome = Some(
            match error.code.as_str() {
                "budget_timeout" => "budget_timeout",
                "budget_reached" => "budget_reached",
                "candidate_artifact_invalid" => "fail",
                _ => "infrastructure_failure",
            }
            .into(),
        );
    }
    let diagnostic = format!("Repository artifact: {}", error.message);
    attempt.reason = Some(
        attempt
            .reason
            .as_ref()
            .map_or(diagnostic.clone(), |reason| {
                format!("{reason}; {diagnostic}")
            }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;

    #[test]
    fn a_session_s_own_memory_ceiling_on_the_candidate_s_command_is_its_budget() {
        // A Grok session (10-18): the session's own memory.max killed the
        // candidate's python3, the bridge died with the leaf, and the turn
        // ended as an infrastructure failure the broker's verdict corrects.
        let row = judge_row("sonnet");
        let mut attempt = crate::services::benchmarks::pending_attempt(
            "invented-run",
            "invented-version",
            &row,
            0,
        );
        attempt.outcome = Some("infrastructure_failure".into());
        attempt.reason = Some(r#"{"code":-32603,"message":"bridge exited"}"#.into());
        let verdict = sandbox::SessionVerdict {
            candidate_limit: "memory".into(),
            victim: Some("python3".into()),
        };
        apply_session_limit(&mut attempt, &verdict);
        assert_eq!(attempt.outcome.as_deref(), Some("budget_reached"));
        let reason = attempt.reason.as_deref().unwrap();
        assert!(
            reason.contains("(python3) passed the session's own memory ceiling"),
            "{reason}"
        );
        assert!(reason.contains("bridge exited"), "{reason}");
        // Only an infrastructure failure is the verdict's to settle.
        for outcome in ["completed", "budget_timeout", "execution_violation"] {
            attempt.outcome = Some(outcome.into());
            attempt.reason = None;
            apply_session_limit(&mut attempt, &verdict);
            assert_eq!(attempt.outcome.as_deref(), Some(outcome));
            assert!(attempt.reason.is_none());
        }
        assert_eq!(
            json!(verdict),
            json!({"candidateLimit": "memory", "victim": "python3"})
        );
    }

    #[test]
    fn the_session_admission_is_sealed_with_its_attempt_once() {
        let row = judge_row("sonnet");
        let mut attempt = crate::services::benchmarks::pending_attempt(
            "invented-run",
            "invented-version",
            &row,
            0,
        );
        let admission: sandbox::Admission = serde_json::from_value(json!({
            "heavyLanes": 3, "lane": "heavy", "competing": {"repository": 2},
            "competingHeavy": 2, "reservedMemory": 12_u64 << 30, "reservedCpu": 4,
            "memoryCurrent": 9_u64 << 30, "guestLoad": [4.0, 3.5, 2.0], "guestCpus": 16,
            "guestMemAvailable": 20_u64 << 30, "hostAvailableRam": 30_u64 << 30,
            "hostAvailableCommit": 18_u64 << 30, "hostCpuBusy": 0.5,
        }))
        .unwrap();
        sandbox::record_session_admission("invented-sealed-sandbox", admission.clone());
        let mut evidence = json!({"turnEvents": []});
        record_sandbox_admission(&mut attempt, &mut evidence, Some("invented-sealed-sandbox"));
        assert_eq!(attempt.sandbox_admission.as_ref(), Some(&admission));
        assert_eq!(evidence["sandboxAdmission"]["heavyLanes"], 3);
        assert_eq!(evidence["sandboxAdmission"]["competingHeavy"], 2);
        assert_eq!(evidence["sandboxAdmission"]["hostCpuBusy"], 0.5);
        // The record belongs to one attempt; a later seal finds nothing.
        let mut later = crate::services::benchmarks::pending_attempt(
            "invented-run",
            "invented-version",
            &row,
            1,
        );
        let mut empty = json!({});
        record_sandbox_admission(&mut later, &mut empty, Some("invented-sealed-sandbox"));
        assert!(later.sandbox_admission.is_none());
        assert!(empty.get("sandboxAdmission").is_none());
    }

    /// A sealed attempt whose sandbox will not clean stays armed for the
    /// guard's drop and the reaper, and the clean's failure is no error of
    /// the attempt, so it keeps its score and its run goes on.
    #[tokio::test]
    async fn a_sandbox_that_will_not_clean_after_sealing_costs_no_score() {
        // An id the guard's drop never sends to the sandbox.
        let id = "invented/never-sent";
        let mut cleanup = sandbox::Cleanup(Some(id.into()));
        clean_sealed(&mut cleanup, |_| async {
            Err(std::io::Error::other("bench-clean timed out after 25 s"))
        })
        .await;
        assert_eq!(cleanup.0.as_deref(), Some(id));
        clean_sealed(&mut cleanup, |_| async { Ok(()) }).await;
        assert!(cleanup.0.is_none());
    }

    /// A sealed turn whose answer could not be collected before its deadline
    /// because the sandbox had no room is unscored infrastructure, never the
    /// model's timeout; a deadline the answer itself ran out keeps its score.
    #[test]
    fn collection_that_found_no_room_before_its_deadline_is_unscored() {
        let row = judge_row("sonnet");
        let mut attempt = crate::services::benchmarks::pending_attempt(
            "invented-run",
            "invented-version",
            &row,
            0,
        );
        attempt.outcome = Some("completed".into());
        repository_collection_failure(
            &mut attempt,
            &sandbox_setup_error(
                std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "resource_busy: benchmark preparation queue expired before worker startup",
                ),
                Some(1),
            ),
        );
        assert_eq!(attempt.outcome.as_deref(), Some("infrastructure_failure"));
        attempt.phase = "terminal".into();
        assert!(!crate::services::benchmarks::analysis::is_measured(
            &attempt
        ));
        let mut timed = crate::services::benchmarks::pending_attempt(
            "invented-run",
            "invented-version",
            &row,
            1,
        );
        timed.outcome = Some("completed".into());
        repository_collection_failure(
            &mut timed,
            &BenchmarkError::new("budget_timeout", "Native sandbox deadline expired"),
        );
        assert_eq!(timed.outcome.as_deref(), Some("budget_timeout"));
    }

    #[tokio::test]
    #[ignore = "requires the provisioned distill-bench WSL distribution"]
    async fn repository_answer_is_the_stopped_patch_and_never_the_final_message() {
        sandbox::ready().await.unwrap();
        let id = format!("collect-{}", uuid::Uuid::new_v4());
        let mut cleanup = sandbox::Cleanup(Some(id.clone()));
        let mut archive = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(4);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, "answer.txt", b"old\n".as_slice())
            .unwrap();
        sandbox::copy(&id, &archive.into_inner().unwrap())
            .await
            .unwrap();
        let mut attempt: Attempt = serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v",
            "configuration":{"id":"c","providerId":"codex-acp","accountId":"a","modelId":"m","billingMode":"subscription","executionProfile":"protected_repository"},
            "repetition":0,"phase":"collecting","outcome":"completed","output":"I changed everything",
            "usage":{"schema":"native"},"eventCursor":0,"workflowSteps":[],"evaluations":[]})).unwrap();
        collect_repository(&mut attempt, &id, 4096).await.unwrap();
        assert_eq!(attempt.output.as_deref(), Some(""));
        let result = sandbox::command("/usr/local/sbin/bench-run", &["session", &id, "--", "/bin/sh", "-c",
            "printf 'new\\n' >answer.txt; setsid sh -c 'sleep 5; echo late >>answer.txt' </dev/null >/dev/null 2>&1 &"])
            .output().await.unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        collect_repository(&mut attempt, &id, 4096).await.unwrap();
        let patch = attempt.output.clone().unwrap();
        assert!(patch.contains("+new"));
        tokio::time::sleep(Duration::from_secs(6)).await;
        collect_repository(&mut attempt, &id, 4096).await.unwrap();
        assert_eq!(
            attempt.output.as_deref(),
            Some(patch.as_str()),
            "detached child survived collection"
        );
        collect_repository(&mut attempt, &id, 4).await.unwrap();
        assert_eq!(attempt.outcome.as_deref(), Some("budget_reached"));
        sandbox::clean(&id).await.unwrap();
        cleanup.0 = None;
        assert!(
            collect_repository(&mut attempt, &id, 4096).await.is_err(),
            "a missing recovery copy is not an empty answer"
        );
    }
}
