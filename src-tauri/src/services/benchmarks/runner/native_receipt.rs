//! Native execution identity from durable host owner/session/terminal records.
//! Caller selection intent cannot manufacture a provider acknowledgement.
use super::super::{fixtures, types::*};
use crate::services::agent_host::{
    execution::{
        ExecutionDispatch, ExecutionProfile, NativeProvider, ObservedSelection, OwnedSessionRequest,
    },
    repository_execution,
    store::SessionStore,
};
use serde::{Deserialize, Serialize};

pub(crate) const SOURCE: &str = "distill-native-owned-terminal-v1";

/// Attestation is an eligibility boundary, not permission to discard a failed
/// native turn. Its captured output, failure classification and terminal bytes
/// are sealed even when no deployment receipt can be issued.
pub(crate) fn sealed_events(
    turn_events: serde_json::Value,
    receipt: Result<Option<NativeExecutionReceipt>>,
) -> serde_json::Value {
    match receipt {
        Ok(Some(receipt)) => {
            serde_json::json!({"nativeExecutionReceipt":receipt,"turnEvents":turn_events})
        }
        Ok(None) => {
            serde_json::json!({"nativeExecutionReceiptAbsent":"terminal acknowledgement/runtime is absent or legacy","turnEvents":turn_events})
        }
        Err(error) => {
            serde_json::json!({"nativeExecutionReceiptError":{"code":error.code,"message":error.message},"turnEvents":turn_events})
        }
    }
}

/// Constructed by NativeBackend's verified inventory path; never deserialized
/// from a renderer request or an Attempt.configuration.
pub(crate) struct VerifiedRuntime {
    pub provider_id: String,
    pub account_id: String,
    pub model_id: String,
    pub execution_profile: String,
    pub inventory_revision: String,
    pub repository_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeExecutionReceipt {
    pub schema_version: u32,
    pub source: String,
    pub owner_purpose: String,
    pub request_key: String,
    pub session_id: String,
    pub host_run_id: String,
    pub owner_id: String,
    pub provider_id: String,
    pub account_id: String,
    pub policy_hash: String,
    pub execution_profile: String,
    pub model_id: String,
    pub effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub inventory_revision: String,
    pub repository_revision: Option<String>,
    pub owner_request: OwnedSessionRequest,
    pub user_message_id: String,
    pub terminal_dispatch_hash: String,
    pub terminal_observed_selection: ObservedSelection,
    pub terminal_stop_reason: String,
    pub native_execution_ms: u64,
}

fn invalid(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("native_receipt_conflict", message)
}
fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(crate) fn profile(owner: &OwnedSessionRequest) -> &'static str {
    match owner.profile {
        ExecutionProfile::NativeTextV1 => "native_text",
        ExecutionProfile::ProtectedRepositoryV1 => "protected_repository",
    }
}
fn dispatch_hash(dispatch: &ExecutionDispatch) -> Result<String> {
    // The terminal turnEvents record is a JSON Value. Hash that canonical
    // representation so issuance can recheck the exact same persisted bytes.
    Ok(fixtures::hash(&serde_json::to_vec(&serde_json::to_value(
        dispatch,
    )?)?))
}
fn terminal(dispatch: &ExecutionDispatch) -> Result<(ObservedSelection, String, u64)> {
    if dispatch.phase != "terminal" || dispatch.error.is_some() {
        return Err(invalid(
            "An unknown or failed host dispatch cannot attest a terminal acknowledgement",
        ));
    }
    let result = dispatch
        .result
        .as_ref()
        .ok_or_else(|| invalid("Native terminal result is absent"))?;
    let selection = result
        .get("observedSelection")
        .ok_or_else(|| invalid("Native terminal selection is unknown"))?;
    if ["modelId", "reasoningEffort", "fastMode"]
        .iter()
        .any(|key| selection.get(key).is_none())
    {
        return Err(invalid("Native terminal selection fields are unknown"));
    }
    let selection: ObservedSelection = serde_json::from_value(selection.clone())?;
    if selection.model_id.as_ref().is_none_or(String::is_empty) {
        return Err(invalid("Native terminal model is unknown"));
    }
    let stop = result["stopReason"]
        .as_str()
        .filter(|stop| {
            matches!(
                *stop,
                "end_turn" | "max_tokens" | "max_turn_requests" | "refusal"
            )
        })
        .ok_or_else(|| invalid("Native terminal stop reason is unknown or cancelled"))?;
    let elapsed = result["nativeExecutionMs"]
        .as_u64()
        .ok_or_else(|| invalid("Native execution clock is absent"))?;
    Ok((selection, stop.into(), elapsed))
}
impl NativeExecutionReceipt {
    pub(crate) fn validate_policy_metadata(&self) -> Result<()> {
        let owner = &self.owner_request;
        let provider = NativeProvider::for_harness(&owner.provider_id)
            .ok_or_else(|| invalid("Native receipt provider is unsupported"))?;
        let policy = match owner.profile {
            ExecutionProfile::NativeTextV1 => {
                if self.repository_revision.is_some() {
                    return Err(invalid(
                        "Native text receipt contains a repository policy revision",
                    ));
                }
                provider.policy_hash(owner)
            }
            ExecutionProfile::ProtectedRepositoryV1 => {
                let revision = self
                    .repository_revision
                    .as_deref()
                    .filter(|value| digest_valid(value))
                    .ok_or_else(|| {
                        invalid("Repository receipt lacks its actual runtime revision")
                    })?;
                repository_execution::policy_hash(owner, revision)
            }
        }
        .map_err(invalid)?;
        if self.schema_version != 1
            || self.source != SOURCE
            || self.owner_purpose != "benchmark"
            || self.owner_id != owner.owner_id
            || self.owner_id.is_empty()
            || self.provider_id != owner.provider_id
            || self.account_id != owner.account_id
            || self.account_id.is_empty()
            || self.model_id != owner.model_id
            || self.effort != owner.reasoning_effort
            || self.fast_mode != owner.fast_mode
            || self.execution_profile != profile(owner)
            || self.policy_hash != policy
            || !digest_valid(&self.inventory_revision)
            || !digest_valid(&self.terminal_dispatch_hash)
            || self.terminal_observed_selection.model_id.as_ref() != Some(&self.model_id)
            || self.terminal_observed_selection.reasoning_effort != self.effort
            || self.terminal_observed_selection.fast_mode != self.fast_mode
            || self.request_key.is_empty()
            || self.session_id.is_empty()
            || self.host_run_id.is_empty()
            || self.user_message_id.is_empty()
        {
            return Err(invalid(
                "Native receipt policy, runtime or actual owner acknowledgement differs",
            ));
        }
        Ok(())
    }
    pub(crate) fn validate_terminal_dispatch(&self, dispatch: &ExecutionDispatch) -> Result<()> {
        self.validate_policy_metadata()?;
        let (selection, stop, elapsed) = terminal(dispatch)?;
        if self.request_key != dispatch.request_key
            || self.session_id != dispatch.session_id
            || self.host_run_id != dispatch.run_id
            || self.user_message_id != dispatch.user_message_id
            || self.terminal_observed_selection != selection
            || self.terminal_stop_reason != stop
            || self.native_execution_ms != elapsed
            || self.terminal_dispatch_hash != dispatch_hash(dispatch)?
        {
            return Err(invalid(
                "Native receipt differs from the committed terminal dispatch",
            ));
        }
        Ok(())
    }
}

pub(crate) async fn attest(
    store: &SessionStore,
    request_key: &str,
    session_id: &str,
    host_run_id: &str,
    owner_id: &str,
    runtime: &VerifiedRuntime,
) -> Result<NativeExecutionReceipt> {
    let fail = |message: String| invalid(message);
    let purpose = store
        .owned_session_purpose(session_id)
        .await
        .map_err(fail)?;
    let (owner, policy_hash) = store
        .execution_owner(session_id)
        .await
        .map_err(fail)?
        .ok_or_else(|| invalid("Native host owner is absent"))?;
    let record = store
        .get_session(session_id)
        .await
        .map_err(fail)?
        .ok_or_else(|| invalid("Native host session is absent"))?;
    let dispatch = store
        .execution_dispatch(request_key)
        .await
        .map_err(fail)?
        .ok_or_else(|| invalid("Native host dispatch is absent"))?;
    let (selection, stop, elapsed) = terminal(&dispatch)?;
    if purpose.as_deref() != Some("benchmark")
        || owner.owner_id != owner_id
        || record.id != session_id
        || dispatch.session_id != session_id
        || dispatch.run_id != host_run_id
        || dispatch.request_key != request_key
        || record.harness != owner.provider_id
        || record.account_id.as_deref() != Some(owner.account_id.as_str())
        || record.cwd != owner.cwd
        || record.model_id.as_ref() != Some(&owner.model_id)
        || record.reasoning_effort != owner.reasoning_effort
        || record.fast_mode != owner.fast_mode
        || selection.model_id != record.model_id
        || selection.reasoning_effort != record.reasoning_effort
        || selection.fast_mode != record.fast_mode
        || runtime.provider_id != owner.provider_id
        || runtime.account_id != owner.account_id
        || runtime.model_id != owner.model_id
        || runtime.execution_profile != profile(&owner)
    {
        return Err(invalid(
            "Host owner, session, terminal acknowledgement or runtime belongs to another execution",
        ));
    }
    let value = NativeExecutionReceipt {
        schema_version: 1,
        source: SOURCE.into(),
        owner_purpose: "benchmark".into(),
        request_key: request_key.into(),
        session_id: session_id.into(),
        host_run_id: host_run_id.into(),
        owner_id: owner.owner_id.clone(),
        provider_id: owner.provider_id.clone(),
        account_id: owner.account_id.clone(),
        policy_hash,
        execution_profile: profile(&owner).into(),
        model_id: selection.model_id.clone().unwrap(),
        effort: selection.reasoning_effort.clone(),
        fast_mode: selection.fast_mode,
        inventory_revision: runtime.inventory_revision.clone(),
        repository_revision: runtime.repository_revision.clone(),
        owner_request: owner,
        user_message_id: dispatch.user_message_id.clone(),
        terminal_dispatch_hash: dispatch_hash(&dispatch)?,
        terminal_observed_selection: selection,
        terminal_stop_reason: stop,
        native_execution_ms: elapsed,
    };
    value.validate_terminal_dispatch(&dispatch)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent_host::store::SessionRecord;
    use serde_json::json;

    // Invented host-store plumbing. No actual runtime/provider attestation is
    // claimed by these fixtures; production uses NativeBackend's inventory.
    async fn fixture(
        profile: ExecutionProfile,
        purpose: &str,
        unknown: bool,
    ) -> (tempfile::TempDir, SessionStore, VerifiedRuntime) {
        let root = tempfile::tempdir().unwrap();
        let store = SessionStore::open(&root.path().join("host.db"))
            .await
            .unwrap();
        let owner = OwnedSessionRequest {
            owner_id: "invented-owner:1".into(),
            provider_id: "claude-acp".into(),
            account_id: "invented-account".into(),
            model_id: "invented-model".into(),
            reasoning_effort: Some("high".into()),
            fast_mode: Some(false),
            cwd: root.path().to_string_lossy().into_owned(),
            title: "Invented native receipt".into(),
            profile,
        };
        let repository_revision = (profile == ExecutionProfile::ProtectedRepositoryV1)
            .then(|| fixtures::hash(b"invented-repository-runtime"));
        let policy = match repository_revision.as_deref() {
            Some(revision) => repository_execution::policy_hash(&owner, revision).unwrap(),
            None => NativeProvider::Claude.policy_hash(&owner).unwrap(),
        };
        let record = SessionRecord {
            id: "invented-session".into(),
            harness: owner.provider_id.clone(),
            account_id: Some(owner.account_id.clone()),
            bridge_session_id: None,
            cwd: owner.cwd.clone(),
            title: Some(owner.title.clone()),
            user_set_name: false,
            project_id: None,
            persona_id: None,
            model_id: Some(owner.model_id.clone()),
            reasoning_effort: owner.reasoning_effort.clone(),
            fast_mode: owner.fast_mode,
            legacy_model_id: None,
            hidden: true,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            last_message_at: None,
            archived_at: None,
            message_count: 0,
            last_snippet: None,
            snapshot: None,
        };
        store
            .insert_owned_session_for_purpose(&record, &owner, &policy, purpose)
            .await
            .unwrap();
        let dispatch = ExecutionDispatch {
            request_key: "benchmark:invented-owner:1".into(),
            session_id: record.id,
            run_id: "invented-run".into(),
            user_message_id: "invented-user".into(),
            phase: "reserved".into(),
            event_cursor: 0,
            result: None,
            error: None,
        };
        store
            .reserve_dispatch(&dispatch, "invented prompt hash")
            .await
            .unwrap();
        let result = json!({"stopReason":"end_turn","nativeExecutionMs":17,"observedSelection":{
            "modelId":owner.model_id,"reasoningEffort":owner.reasoning_effort,"fastMode":owner.fast_mode}});
        store
            .settle_dispatch(
                &dispatch.request_key,
                if unknown { "uncertain" } else { "terminal" },
                (!unknown).then_some(&result),
                unknown.then_some(&json!({"kind":"dispatch_uncertain"})),
            )
            .await
            .unwrap();
        let runtime = VerifiedRuntime {
            execution_profile: super::profile(&owner).into(),
            provider_id: owner.provider_id,
            account_id: owner.account_id,
            model_id: owner.model_id,
            inventory_revision: fixtures::hash(b"invented-fixture-runtime-domain"),
            repository_revision,
        };
        (root, store, runtime)
    }
    async fn receipt(
        store: &SessionStore,
        runtime: &VerifiedRuntime,
    ) -> Result<NativeExecutionReceipt> {
        attest(
            store,
            "benchmark:invented-owner:1",
            "invented-session",
            "invented-run",
            "invented-owner:1",
            runtime,
        )
        .await
    }
    #[tokio::test]
    async fn native_receipt_joins_actual_stored_owner_ack_policy_and_terminal_bytes() {
        for profile in [
            ExecutionProfile::NativeTextV1,
            ExecutionProfile::ProtectedRepositoryV1,
        ] {
            let (_root, store, runtime) = fixture(profile, "benchmark", false).await;
            let value = receipt(&store, &runtime).await.unwrap();
            value.validate_policy_metadata().unwrap();
            let dispatch = store
                .execution_dispatch(&value.request_key)
                .await
                .unwrap()
                .unwrap();
            value.validate_terminal_dispatch(&dispatch).unwrap();
            assert_eq!(value.source, SOURCE);
            assert_eq!(value.account_id, "invented-account");
            assert_eq!(value.native_execution_ms, 17);
            let mut changed = value.clone();
            changed.policy_hash = "0".repeat(64);
            assert!(changed.validate_policy_metadata().is_err());
            let mut changed_dispatch = dispatch;
            changed_dispatch.user_message_id = "another-user".into();
            assert!(value.validate_terminal_dispatch(&changed_dispatch).is_err());
            let mut changed = value;
            changed.owner_request.account_id = "another-account".into();
            assert!(changed.validate_policy_metadata().is_err());
        }
    }
    #[tokio::test]
    async fn native_receipt_refuses_unknown_wrong_owner_and_intent_only_runtime() {
        let (_root, store, runtime) =
            fixture(ExecutionProfile::NativeTextV1, "benchmark", true).await;
        assert!(receipt(&store, &runtime).await.is_err());
        let (_root, store, runtime) = fixture(ExecutionProfile::NativeTextV1, "task", false).await;
        assert!(receipt(&store, &runtime).await.is_err());
        let (_root, store, mut runtime) =
            fixture(ExecutionProfile::NativeTextV1, "benchmark", false).await;
        assert!(attest(
            &store,
            "benchmark:invented-owner:1",
            "invented-session",
            "other-run",
            "invented-owner:1",
            &runtime
        )
        .await
        .is_err());
        assert!(attest(
            &store,
            "benchmark:invented-owner:1",
            "invented-session",
            "invented-run",
            "other-owner",
            &runtime
        )
        .await
        .is_err());
        runtime.account_id = "selected-but-not-observed-account".into();
        assert!(receipt(&store, &runtime).await.is_err());
    }
    #[tokio::test]
    async fn native_receipt_never_fills_missing_or_changed_terminal_settings_from_owner() {
        for selection in [
            json!({"modelId":"invented-model"}),
            json!({"modelId":"other-model","reasoningEffort":"high","fastMode":false}),
            json!({"modelId":"invented-model","reasoningEffort":null,"fastMode":false}),
        ] {
            let (_root, store, runtime) =
                fixture(ExecutionProfile::NativeTextV1, "benchmark", false).await;
            store.settle_dispatch("benchmark:invented-owner:1","terminal",Some(&json!({"stopReason":"end_turn","nativeExecutionMs":17,"observedSelection":selection})),None).await.unwrap();
            assert!(receipt(&store, &runtime).await.is_err());
        }
    }

    #[tokio::test]
    async fn failed_native_receipt_keeps_raw_failed_attempt_output_and_terminal_evidence() {
        let (root, store, runtime) =
            fixture(ExecutionProfile::NativeTextV1, "benchmark", false).await;
        let changed_terminal = json!({"stopReason":"end_turn","nativeExecutionMs":17,"observedSelection":{
            "modelId":"actually-different-model","reasoningEffort":"high","fastMode":false}});
        store
            .settle_dispatch(
                "benchmark:invented-owner:1",
                "terminal",
                Some(&changed_terminal),
                None,
            )
            .await
            .unwrap();
        let mut attempt = super::super::super::pending_attempt(
            "invented-run",
            "invented-version",
            &Configuration {
                id: "invented".into(),
                provider_id: "claude-acp".into(),
                account_id: Some("invented-account".into()),
                model_id: "invented-model".into(),
                model_name: None,
                effort: Some("high".into()),
                fast_mode: Some(false),
                billing_mode: "unknown".into(),
                execution_profile: "native_text".into(),
                inventory_revision: Some(runtime.inventory_revision.clone()),
            },
            0,
        );
        attempt.session_id = Some("invented-session".into());
        attempt.host_run_id = Some("invented-run".into());
        attempt.output = Some("captured wrong-model reply or cumulative patch".into());
        attempt.outcome = Some("selection_changed".into());
        attempt.reason = Some("Actual terminal selection differs".into());
        let dispatch = store
            .execution_dispatch("benchmark:invented-owner:1")
            .await
            .unwrap()
            .unwrap();
        let events = json!([{"rawReply":attempt.output},{"terminalDispatch":dispatch}]);
        let sealed = sealed_events(events.clone(), receipt(&store, &runtime).await.map(Some));
        assert_eq!(sealed["turnEvents"], events);
        assert!(sealed.get("nativeExecutionReceipt").is_none());
        assert!(sealed["nativeExecutionReceiptError"]["message"].is_string());
        let digest = fixtures::seal(root.path(), &attempt, &sealed)
            .await
            .unwrap();
        let bytes = tokio::fs::read(
            root.path()
                .join("runs/invented-run")
                .join(&attempt.id)
                .join("evidence")
                .join(format!("{digest}.json")),
        )
        .await
        .unwrap();
        assert_eq!(fixtures::hash(&bytes), digest);
        let saved: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(saved["output"], attempt.output.as_deref().unwrap());
        assert_eq!(saved["events"]["turnEvents"], events);
        assert!(saved.pointer("/events/nativeExecutionReceipt").is_none());
        assert_eq!(attempt.outcome.as_deref(), Some("selection_changed"));
        assert_eq!(
            attempt.reason.as_deref(),
            Some("Actual terminal selection differs")
        );
        let missing = sealed_events(events.clone(), Ok(None));
        assert_eq!(missing["turnEvents"], events);
        assert!(missing.get("nativeExecutionReceipt").is_none());
    }
}
