//! Typed, durable execution contract for application-owned benchmark sessions.
//! The native text profile disables tools; it is not a filesystem sandbox.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const NATIVE_TEXT_POLICY_REVISION: &str = "distill-native-text-policy-v2";
pub const NATIVE_TEXT_ADAPTER: &str =
    include_str!("../../../resources/benchmark-claude-policy.mjs");

pub fn validate_native_runtime(entrypoint: &std::path::Path) -> Result<(), String> {
    let directory = entrypoint
        .parent()
        .ok_or("capability_missing: unknown Claude entrypoint")?;
    for (name, expected) in [
        (
            "acp-agent.js",
            "a17444ae89c5dd8f6cccaf278107438100521cf5cb367fb8991e48ce0f46bbf1",
        ),
        (
            "session-titles.js",
            "a78f6ed7e85193fbb0ebc97b37c0adde70d1000eac94e70e310e75dd580e079a",
        ),
    ] {
        let source = std::fs::read(directory.join(name)).map_err(|_| {
            "capability_missing: pinned Claude benchmark adapter source is unavailable"
        })?;
        if digest(source) != expected {
            return Err("capability_missing: installed Claude bridge changed; benchmark adapter requires verification".into());
        }
    }
    Ok(())
}

pub(super) fn native_preload_argument(entrypoint: &std::path::Path) -> Result<String, String> {
    validate_native_runtime(entrypoint)?;
    Ok(format!(
        "data:text/javascript;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(NATIVE_TEXT_ADAPTER)
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionProfile {
    NativeTextV1,
    ProtectedRepositoryV1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedSessionRequest {
    pub owner_id: String,
    pub provider_id: String,
    pub account_id: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub cwd: String,
    pub title: String,
    pub profile: ExecutionProfile,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservedSelection {
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedSession {
    pub session_id: String,
    pub owner_id: String,
    pub policy_hash: String,
    pub selection: ObservedSelection,
    pub substitutions: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedTurnRequest {
    pub session_id: String,
    pub request_key: String,
    pub prompt: String,
    pub policy_hash: String,
    pub timeout_ms: u64,
    /// Images sent after the text, base64 with their media type.
    #[serde(default)]
    pub images: Vec<OwnedTurnImage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedTurnImage {
    pub data: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDispatch {
    pub request_key: String,
    pub session_id: String,
    pub run_id: String,
    pub user_message_id: String,
    pub phase: String,
    pub event_cursor: i64,
    pub result: Option<Value>,
    pub error: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedEvent {
    pub event_id: i64,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedEventPage {
    pub events: Vec<OwnedEvent>,
    pub cursor: i64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountActivity {
    pub active_sessions: Vec<String>,
    pub generation: u64,
}

pub(super) fn digest(value: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(value.as_ref()))
}

pub(super) fn native_text_meta(model: &str) -> Value {
    json!({
        "distillNativePolicy": { "revision": NATIVE_TEXT_POLICY_REVISION, "adapterHash": digest(NATIVE_TEXT_ADAPTER) },
        "systemPrompt": "Complete the supplied benchmark task. Return only the requested answer.",
        "claudeCode": { "options": {
            "model": model,
            // The SDK otherwise generates a title through a separate model call.
            "title": "Benchmark execution",
            "tools": [], "settingSources": [], "skills": [], "plugins": [], "agents": {},
            "mcpServers": {}, "strictMcpConfig": true,
            "persistSession": false, "allowDangerouslySkipPermissions": false,
            "managedSettings": { "disableAllHooks": true, "autoMemoryEnabled": false },
            "settings": { "disableAllHooks": true, "autoMemoryEnabled": false },
            "maxTurns": 1
        }}
    })
}

pub(super) fn validate_request(request: &OwnedSessionRequest) -> Result<(), String> {
    if request.profile != ExecutionProfile::NativeTextV1 || request.provider_id != "claude-acp" {
        return Err(
            "capability_missing: this provider has no verified native no-tool execution profile"
                .into(),
        );
    }
    for (name, value) in [
        ("owner", &request.owner_id),
        ("account", &request.account_id),
        ("model", &request.model_id),
    ] {
        if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
            return Err(format!("validation: invalid {name}"));
        }
    }
    if !std::path::Path::new(&request.cwd).is_absolute() {
        return Err("validation: benchmark workspace must be absolute".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_policy_removes_native_tools_context_and_mcp() {
        let meta = native_text_meta("exact-model");
        let options = &meta["claudeCode"]["options"];
        for field in ["tools", "settingSources", "skills", "plugins"] {
            assert_eq!(options[field], json!([]), "{field}");
        }
        assert_eq!(options["strictMcpConfig"], true);
        assert_eq!(options["managedSettings"]["disableAllHooks"], true);
        assert_eq!(options["managedSettings"]["autoMemoryEnabled"], false);
        assert_eq!(options["persistSession"], false);
        assert_eq!(options["model"], "exact-model");
        assert_eq!(options["title"], "Benchmark execution");
        assert_eq!(
            meta["distillNativePolicy"]["adapterHash"],
            digest(NATIVE_TEXT_ADAPTER)
        );
    }

    #[test]
    fn native_adapter_rejects_missing_or_changed_pinned_sources() {
        let directory = tempfile::tempdir().unwrap();
        let entrypoint = directory.path().join("index.js");
        assert!(native_preload_argument(&entrypoint)
            .unwrap_err()
            .starts_with("capability_missing:"));
        std::fs::write(directory.path().join("acp-agent.js"), "changed bridge").unwrap();
        assert!(native_preload_argument(&entrypoint)
            .unwrap_err()
            .contains("installed Claude bridge changed"));
    }
}
