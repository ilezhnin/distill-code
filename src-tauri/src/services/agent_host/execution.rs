//! Typed, durable execution contract for application-owned benchmark sessions.
//! The native text profile disables tools. Owned launches additionally use the
//! Linux isolation implemented by text_execution; location grants no tools.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

pub const NATIVE_TEXT_POLICY_REVISION: &str = "distill-native-text-policy-v2";
pub const NATIVE_TEXT_ADAPTER: &str =
    include_str!("../../../resources/benchmark-claude-policy.mjs");
const CODEX_ADAPTER: &str = include_str!("../../../resources/benchmark-codex-policy.mjs");
const KIMI_ADAPTER: &str = include_str!("../../../resources/benchmark-kimi-policy.mjs");
/// OpenCode's policy plugin for Z.ai, loaded in place of a Node preload.
const ZAI_ADAPTER: &str = include_str!("../../../resources/benchmark-zai-policy.mjs");
/// The system prompt every native text profile puts in place of the vendor's.
/// `resources/benchmark-native-policies.json` carries the same text for the
/// providers configured there; a test keeps the two equal.
pub const SYSTEM_PROMPT: &str =
    "Complete the supplied benchmark task. Return only the requested answer.";
/// Grok's private home in its runtime directory (`GROK_HOME`).
const GROK_HOME: &str = "home";
/// The sign-in file Grok keeps in its home. A copy an earlier Windows-native
/// benchmark left there is removed (see [`discard_owned_sign_in`]).
const GROK_AUTH_FILE: &str = "auth.json";
/// The owner-only folder in Grok's runtime directory that holds the sign-in
/// an owned Grok is starting with, and only while it starts.
const GROK_SIGN_IN: &str = "sign-in";

/// The checked-in policy of the providers configured outside Rust. Claude
/// keeps its inline policy, so its stored hashes never change. The policy
/// probe script reads the same file, so what it verifies is what runs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativePolicies {
    /// For the probe script; a test keeps it equal to [`SYSTEM_PROMPT`].
    #[cfg_attr(not(test), allow(dead_code))]
    system_prompt: String,
    codex: ProviderPolicy,
    grok: ProviderPolicy,
    kimi: ProviderPolicy,
    zai: ProviderPolicy,
}

/// One provider's entry in the policy resource.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderPolicy {
    revision: String,
    runtime: RuntimePin,
    permission_mode: Option<String>,
    #[serde(default)]
    excluded_efforts: Vec<String>,
    /// Fixed variables of the owned process.
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// Codex: the configuration every thread starts with, through
    /// `CODEX_CONFIG`. Z.ai: OpenCode's whole configuration, through
    /// `OPENCODE_CONFIG_CONTENT`.
    #[serde(default)]
    config: Option<Map<String, Value>>,
    /// Codex: the fields set on every entry of the model catalog the owned
    /// CLI starts with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_catalog: Option<Map<String, Value>>,
    /// Grok: the arguments the owned process runs with in place of the
    /// harness's own.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    args: Vec<String>,
    /// Grok: the `config.toml` of its private home, rewritten before each
    /// launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    config_toml: Option<String>,
    /// Grok: the `session/new` `_meta` that replaces the system prompt and
    /// removes tools, rules and context for the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_meta: Option<Map<String, Value>>,
    /// Grok: what every owned `session/prompt` adds to its `_meta`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt_meta: Option<Map<String, Value>>,
    /// What the loopback policy probe last passed on; absent until it has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    verified: Option<ProbeRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimePin {
    /// Names the verified build in the route profile key.
    label: String,
    /// The sha256 of each pinned file, by its role.
    files: BTreeMap<String, String>,
}

/// A passed run of `scripts/benchmark-provider-policy-probe.mjs`, as the probe
/// prints it for the provider's entry. It stands only for the entry and
/// adapter it was made with (see [`NativeProvider::admission_issue`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeRecord {
    /// The day the probe passed.
    date: String,
    /// The runtime it ran.
    runtime: RuntimePin,
    /// The sha256 of the entry without this record, as [`canonical_json`]
    /// writes it.
    policy: String,
    /// The sha256 of the adapter source it loaded, for a provider with one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    adapter: Option<String>,
}

const POLICY_RESOURCE: &str = include_str!("../../../resources/benchmark-native-policies.json");

static POLICIES: LazyLock<NativePolicies> = LazyLock::new(|| {
    serde_json::from_str(POLICY_RESOURCE).expect("the checked-in benchmark policy resource parses")
});

/// The resource as written, for the digest the probe also computes: the typed
/// entries above fill in defaults the file does not spell out.
static POLICY_DOCUMENT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(POLICY_RESOURCE).expect("the checked-in benchmark policy resource parses")
});

/// `value` as JSON with every object's keys sorted and no whitespace, the
/// form the policy probe hashes a resource entry in (its `canonical`).
pub(crate) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(entries) => {
            let mut keys: Vec<&String> = entries.keys().collect();
            keys.sort();
            let fields: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        Value::String(key.clone()),
                        canonical_json(&entries[key])
                    )
                })
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

/// Why a probe record does not admit `policy` (labelled `label`), whose entry
/// hashes to `policy_digest` and whose adapter source hashes to `adapter`.
fn probe_record_issue(
    label: &str,
    policy: &ProviderPolicy,
    policy_digest: Option<&str>,
    adapter: Option<&str>,
) -> Option<String> {
    let Some(record) = policy.verified.as_ref() else {
        return Some(format!(
            "The {label} benchmark profile has not passed its policy probe"
        ));
    };
    let current = record.runtime == policy.runtime
        && Some(record.policy.as_str()) == policy_digest
        && record.adapter.as_deref() == adapter;
    (!current).then(|| {
        format!("The {label} benchmark profile changed since its policy probe passed; run the probe again")
    })
}

/// The providers whose native CLI can run one clean, tool-free benchmark
/// turn. Each variant is the whole difference between them: how the bridge
/// is started, what it is told, and which runtime it must be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeProvider {
    Claude,
    Codex,
    Grok,
    Kimi,
    Zai,
}

impl NativeProvider {
    /// Every provider with a verified profile, in the order the benchmark
    /// capabilities list them.
    pub const ALL: &'static [NativeProvider] = &[
        NativeProvider::Claude,
        NativeProvider::Codex,
        NativeProvider::Grok,
        NativeProvider::Kimi,
        NativeProvider::Zai,
    ];

    pub fn for_harness(harness_id: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|provider| provider.harness_id() == harness_id)
    }

    pub fn harness_id(self) -> &'static str {
        match self {
            Self::Claude => "claude-acp",
            Self::Codex => "codex-acp",
            Self::Grok => "grok-acp",
            Self::Kimi => "kimi-acp",
            Self::Zai => "zai-acp",
        }
    }

    /// The short name of the provider in the policy resource and profile key.
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Grok => "grok",
            Self::Kimi => "kimi",
            Self::Zai => "zai",
        }
    }

    /// The provider's entry in the policy resource; Claude's policy is inline.
    fn policy(self) -> Option<&'static ProviderPolicy> {
        match self {
            Self::Claude => None,
            Self::Codex => Some(&POLICIES.codex),
            Self::Grok => Some(&POLICIES.grok),
            Self::Kimi => Some(&POLICIES.kimi),
            Self::Zai => Some(&POLICIES.zai),
        }
    }

    pub fn policy_revision(self) -> &'static str {
        self.policy()
            .map_or(NATIVE_TEXT_POLICY_REVISION, |policy| &policy.revision)
    }

    /// The policy module the bridge loads: the preload that edits a Node
    /// bridge as Node loads it, or the plugin OpenCode loads for Z.ai.
    pub fn adapter(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some(NATIVE_TEXT_ADAPTER),
            Self::Codex => Some(CODEX_ADAPTER),
            Self::Kimi => Some(KIMI_ADAPTER),
            Self::Zai => Some(ZAI_ADAPTER),
            Self::Grok => None,
        }
    }

    /// The sha256 of the provider's entry as the resource writes it, without
    /// its probe record: what the probe hashes. `None` for Claude.
    fn policy_digest(self) -> Option<String> {
        let mut entry = POLICY_DOCUMENT.get(self.key())?.as_object()?.clone();
        entry.remove("verified");
        Some(digest(canonical_json(&Value::Object(entry))))
    }

    /// Why this profile may not run benchmark work yet: the loopback policy
    /// probe has not passed on exactly the runtime, entry and adapter this
    /// build ships, so whether the CLI honours them is unproven. `None` for
    /// Claude, whose inline policy has its own probe
    /// (`scripts/benchmark-native-policy-probe.mjs`).
    pub fn admission_issue(self) -> Option<String> {
        let policy = self.policy()?;
        probe_record_issue(
            self.harness_label(),
            policy,
            self.policy_digest().as_deref(),
            self.adapter().map(digest).as_deref(),
        )
    }

    /// `session/new` `_meta`: the provider's own spelling of the no-tool,
    /// clean-context policy. Codex, Kimi and Z.ai read none of it (their
    /// policy reaches the process through the environment and the adapter); Grok's
    /// replaces the system prompt and gives the session an agent profile
    /// without tools, rules or context. The revision is kept as evidence.
    pub fn session_meta(self, model: &str) -> Value {
        let Some(policy) = self.policy() else {
            return native_text_meta(model);
        };
        let mut meta = policy.session_meta.clone().unwrap_or_default();
        let mut evidence = json!({ "revision": self.policy_revision() });
        if let Some(adapter) = self.adapter() {
            evidence["adapterHash"] = json!(digest(adapter));
        }
        meta.insert("distillNativePolicy".into(), evidence);
        Value::Object(meta)
    }

    /// What every owned `session/prompt` of this profile adds to its `_meta`:
    /// for Grok `verbatim`, so the task reaches the model as written instead
    /// of inside Grok's `<user_query>` wrapper. `None` for the others.
    pub fn prompt_meta(self) -> Option<&'static Map<String, Value>> {
        self.policy()?.prompt_meta.as_ref()
    }

    /// The mode set with `session/set_mode` right after `session/new`; `None`
    /// skips the call for a provider that declares no modes (Grok; with no
    /// tools nothing asks, and the host refuses and tags any request). Codex
    /// refuses `default`, and its `agent` mode sends approvals to a reviewer
    /// model. Kimi's `default` asks the host for every approval. Z.ai's mode
    /// is the OpenCode agent its configuration defines.
    pub fn permission_mode(self) -> Option<&'static str> {
        match self.policy() {
            None => Some("default"),
            Some(policy) => policy.permission_mode.as_deref(),
        }
    }

    /// Efforts this profile refuses because they hand the turn to other
    /// models instead of answering it with the selected one (Codex: `ultra`,
    /// "automatic task delegation").
    pub fn excluded_efforts(self) -> &'static [String] {
        self.policy()
            .map_or(&[], |policy| policy.excluded_efforts.as_slice())
    }

    /// Why `effort` cannot run under this profile, as a reason without a code.
    pub fn effort_refusal(self, effort: Option<&str>) -> Option<String> {
        let effort = effort.filter(|effort| {
            self.excluded_efforts()
                .iter()
                .any(|excluded| excluded == effort)
        })?;
        Some(format!(
            "effort '{effort}' delegates to subagents and is not a single-model no-tool configuration"
        ))
    }

    /// Model ids the vendor points at another model without changing the
    /// id, whose display name says which one it is now: Kimi Code's
    /// `kimi-for-coding` was K2.7 Code and is K2.8 Preview. The leaderboard
    /// keeps one candidate per display name of such an id. Claude's own
    /// aliases (`sonnet`, `opus`, `haiku`) move too, but keep one candidate
    /// per id as their configurations were first recorded; the model each
    /// attempt resolved to is recorded instead.
    pub fn moving_aliases(self) -> &'static [&'static str] {
        match self {
            Self::Kimi => &[
                "kimi-code/kimi-for-coding",
                "kimi-code/kimi-for-coding-highspeed",
            ],
            Self::Claude | Self::Codex | Self::Grok | Self::Zai => &[],
        }
    }

    /// Whether this provider's models may sit on a judge panel. Only Claude
    /// has been checked to read the rendered image a judge is shown; another
    /// provider joining would also change scores in the middle of a campaign.
    pub fn judges_images(self) -> bool {
        match self {
            Self::Claude => true,
            Self::Codex | Self::Grok | Self::Kimi | Self::Zai => false,
        }
    }

    /// What an owner's stored policy hash covers: the request, the policy the
    /// bridge is given and the runtime it must be. No secret or machine path
    /// enters it.
    pub fn policy_hash(self, request: &OwnedSessionRequest) -> Result<String, String> {
        let input = match self.policy() {
            None => json!({
                "request":request,
                "nativePolicy":native_text_meta(&request.model_id),
                "processPolicy":"clear-environment-no-distill-shims-v1",
                "bridgeVersion":"0.99.1", "sdkVersion":"0.3.312"
            }),
            Some(policy) => self.configured_hash_input(policy, request),
        };
        Ok(digest(
            serde_json::to_vec(&input).map_err(|error| error.to_string())?,
        ))
    }

    /// The policy hash input of a provider configured by the resource.
    fn configured_hash_input(
        self,
        policy: &ProviderPolicy,
        request: &OwnedSessionRequest,
    ) -> Value {
        json!({
            "request": request,
            "provider": self.key(),
            "policy": policy,
            "systemPrompt": SYSTEM_PROMPT,
            "adapterHash": self.adapter().map(digest),
            // v2: the application data folders are redirected with the home.
            "processPolicy": "clear-environment-redirected-home-v2",
        })
    }

    fn harness_label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Grok => "Grok",
            Self::Kimi => "Kimi Code",
            Self::Zai => "Z.ai Coding Plan",
        }
    }

    /// The configuration document the resource gives this provider's process
    /// (Codex: `CODEX_CONFIG`; Z.ai: OpenCode's), as written.
    pub(crate) fn policy_config(self) -> Option<Value> {
        self.policy()?.config.clone().map(Value::Object)
    }

    /// The fixed variables of this provider's process in the resource.
    pub(crate) fn policy_env(self) -> Vec<(String, String)> {
        self.policy()
            .map(|policy| {
                policy
                    .env
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Removes the sign-in file Grok may have written into its private home
/// from the session it was handed, so the user's access token never stays
/// in the Flock root after the bridge that needed it. Nothing for other
/// providers.
pub fn discard_owned_sign_in(provider: NativeProvider, dir: &Path) -> std::io::Result<()> {
    if provider != NativeProvider::Grok {
        return Ok(());
    }
    remove_if_present(&dir.join(GROK_HOME).join(GROK_AUTH_FILE))
}

fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Removes every file in Grok's sign-in folder under `dir`: what a Flock
/// that stopped while a bridge was starting left there.
fn discard_stale_sign_ins(dir: &Path) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(dir.join(GROK_SIGN_IN)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        other => other?,
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            remove_if_present(&entry.path())?;
        }
    }
    Ok(())
}

/// Removes every sign-in copy owned bridges may have left under
/// `runtime_root` (`<root>/benchmarks/runtime`): the files in Grok's sign-in
/// folder and the session Grok may have written into its private home. The
/// host calls it when it starts, before any owned bridge runs, and as the app
/// quits, so a token a stopped Flock left on disk does not wait for the
/// next Grok benchmark.
pub fn discard_left_sign_ins(runtime_root: &Path) -> std::io::Result<()> {
    let dir = runtime_root.join(NativeProvider::Grok.harness_id());
    discard_stale_sign_ins(&dir)?;
    discard_owned_sign_in(NativeProvider::Grok, &dir)
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

impl ObservedSelection {
    pub(crate) fn matches(&self, request: &OwnedSessionRequest) -> bool {
        self.model_id.as_deref() == Some(request.model_id.as_str())
            && request
                .reasoning_effort
                .as_ref()
                .is_none_or(|effort| self.reasoning_effort.as_ref() == Some(effort))
            && fast_mode_acknowledged(request.fast_mode, self.fast_mode)
    }
}

/// Models without a fast-mode control acknowledge none, which is off.
/// Missing support never acknowledges a request to turn fast mode on.
pub(crate) fn fast_mode_acknowledged(requested: Option<bool>, observed: Option<bool>) -> bool {
    requested.is_none_or(|fast| fast == observed.unwrap_or(false))
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
    /// Whether the turn may run on the account's purchased credits once its
    /// plan usage is spent. Off unless the owner of the turn allows it.
    #[serde(default)]
    pub allow_credits: bool,
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
        "systemPrompt": SYSTEM_PROMPT,
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

/// What the host tags an update of an owned session with when it breaks the
/// session's policy (`_meta.executionViolation`), and whose doing each is.
pub mod violation {
    pub const TOOL: &str = "native tool activity in no-tool profile";
    pub const PLAN: &str = "native plan activity in no-tool profile";
    pub const BACKGROUND: &str = "native background activity in no-tool profile";
    pub const SUBAGENT: &str = "native subagent activity in no-tool profile";
    pub const HOOK: &str = "native hook activity in no-tool profile";
    pub const MODE: &str = "native mode changed during owned execution";
    pub const SELECTION: &str = "native selection changed during owned execution";

    /// Who broke the policy a violation names.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Origin {
        /// The model's own work against the test's rules: a tool, a plan,
        /// background work or another agent where the test allows none.
        Model,
        /// The provider's runtime: a hook it ran, or a mode or selection it
        /// changed while the turn ran. No model asks for either.
        Runtime,
    }

    /// Whose doing `reason` is; none for a reason this build does not know.
    pub fn origin(reason: &str) -> Option<Origin> {
        match reason {
            TOOL | PLAN | BACKGROUND | SUBAGENT => Some(Origin::Model),
            HOOK | MODE | SELECTION => Some(Origin::Runtime),
            _ => None,
        }
    }
}

/// The variable that keeps every owned Claude session on its selected model.
/// Claude Code otherwise answers a turn the model refused with another model
/// and keeps the session on it, or swaps models when the selected one is
/// overloaded or not open to the account. A benchmark measures the selected
/// model: its refusal is its own answer, and no other model answers for it
/// (10-31: Sonnet 5.5 declined a cyber-flagged task and Claude Code went on
/// with claude-sonnet-5). With it a refusal ends the turn as `refusal`.
pub(super) fn claude_no_model_fallback() -> (String, String) {
    ("CLAUDE_CODE_NO_MODEL_FALLBACK".into(), "1".into())
}

/// The provider whose profile serves `request`, once the request is one an
/// owned session may be opened for.
pub(super) fn validate_request(request: &OwnedSessionRequest) -> Result<NativeProvider, String> {
    let provider = NativeProvider::for_harness(&request.provider_id).ok_or(
        "capability_missing: this provider has no verified native no-tool execution profile",
    )?;
    if let Some(reason) = provider.effort_refusal(request.reasoning_effort.as_deref()) {
        return Err(format!("capability_missing: {reason}"));
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
    crate::services::benchmark_sandbox::valid_id(&request.account_id)
        .map_err(|error| format!("validation: {error}"))?;
    // Both owned profiles are Linux. Never inspect a Windows folder or its
    // personal configuration to decide whether an isolated text task may run.
    if request.cwd != "/workspace" {
        return Err("validation: isolated benchmark workspace must be /workspace".into());
    }
    Ok(provider)
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

    fn request(provider: &str) -> OwnedSessionRequest {
        OwnedSessionRequest {
            owner_id: "attempt-1".into(),
            provider_id: provider.into(),
            account_id: "account-1".into(),
            model_id: "exact-model".into(),
            reasoning_effort: Some("high".into()),
            fast_mode: Some(false),
            cwd: "/workspace".into(),
            title: "Benchmark: case [1]".into(),
            profile: ExecutionProfile::NativeTextV1,
        }
    }

    #[test]
    fn owned_selection_accepts_absent_fast_only_when_off() {
        let mut requested = request("claude-acp");
        let mut observed = ObservedSelection {
            model_id: Some(requested.model_id.clone()),
            reasoning_effort: requested.reasoning_effort.clone(),
            fast_mode: None,
        };
        assert!(observed.matches(&requested));
        requested.fast_mode = Some(true);
        assert!(!observed.matches(&requested));
        requested.fast_mode = Some(false);
        observed.fast_mode = Some(true);
        assert!(!observed.matches(&requested));
        observed.fast_mode = Some(false);
        assert!(observed.matches(&requested));
        observed.reasoning_effort = Some("low".into());
        assert!(!observed.matches(&requested));
        observed.reasoning_effort = None;
        assert!(!observed.matches(&requested));
        observed.reasoning_effort = requested.reasoning_effort.clone();
        observed.model_id = Some("another-model".into());
        assert!(!observed.matches(&requested));
        observed.model_id = None;
        assert!(!observed.matches(&requested));
    }

    /// Existing owners' policy hashes, configurations' runtime pins and the
    /// bridges already running for them were made from exactly these inputs.
    #[test]
    fn claude_policy_hash_and_meta_are_unchanged() {
        let request = request("claude-acp");
        let meta = json!({
            "distillNativePolicy": { "revision": "distill-native-text-policy-v2", "adapterHash": digest(NATIVE_TEXT_ADAPTER) },
            "systemPrompt": "Complete the supplied benchmark task. Return only the requested answer.",
            "claudeCode": { "options": {
                "model": "exact-model",
                "title": "Benchmark execution",
                "tools": [], "settingSources": [], "skills": [], "plugins": [], "agents": {},
                "mcpServers": {}, "strictMcpConfig": true,
                "persistSession": false, "allowDangerouslySkipPermissions": false,
                "managedSettings": { "disableAllHooks": true, "autoMemoryEnabled": false },
                "settings": { "disableAllHooks": true, "autoMemoryEnabled": false },
                "maxTurns": 1
            }}
        });
        let hash = digest(
            serde_json::to_vec(&json!({
                "request":request,
                "nativePolicy":meta,
                "processPolicy":"clear-environment-no-distill-shims-v1",
                "bridgeVersion":"0.99.1", "sdkVersion":"0.3.312"
            }))
            .unwrap(),
        );
        let claude = NativeProvider::Claude;
        assert_eq!(claude.session_meta("exact-model"), meta);
        assert_eq!(
            serde_json::to_vec(&claude.session_meta("exact-model")).unwrap(),
            serde_json::to_vec(&meta).unwrap()
        );
        assert_eq!(claude.policy_hash(&request).unwrap(), hash);
        assert_eq!(claude.permission_mode(), Some("default"));
    }

    #[test]
    fn policy_resource_parses_and_names_every_provider() {
        assert_eq!(POLICIES.system_prompt, SYSTEM_PROMPT);
        assert_eq!(
            native_text_meta("exact-model")["systemPrompt"],
            SYSTEM_PROMPT
        );
        // Every provider but Claude is configured by the resource, under its
        // own key, with a runtime pin for each file it runs.
        let resource: Value = serde_json::from_str(include_str!(
            "../../../resources/benchmark-native-policies.json"
        ))
        .unwrap();
        for provider in NativeProvider::ALL {
            let Some(policy) = provider.policy() else {
                assert_eq!(*provider, NativeProvider::Claude);
                continue;
            };
            assert!(resource.get(provider.key()).is_some(), "{provider:?}");
            assert!(!policy.runtime.files.is_empty(), "{provider:?}");
            for (role, pin) in &policy.runtime.files {
                assert!(
                    matches!(role.as_str(), "entrypoint" | "nativeCli" | "executable"),
                    "{role}"
                );
                assert_eq!(pin.len(), 64, "{role}");
            }
            assert_ne!(provider.policy_revision(), NATIVE_TEXT_POLICY_REVISION);
        }
        assert_eq!(
            NativeProvider::Codex.policy_revision(),
            "distill-native-text-codex-v1"
        );
        assert_eq!(
            NativeProvider::Grok.policy_revision(),
            "distill-native-text-grok-v1"
        );
        assert_eq!(
            NativeProvider::Kimi.policy_revision(),
            "distill-native-text-kimi-v1"
        );
        // Codex and Kimi run the harness's own arguments and no session policy.
        for provider in [NativeProvider::Codex, NativeProvider::Kimi] {
            let policy = provider.policy().unwrap();
            assert!(policy.args.is_empty(), "{provider:?}");
            assert!(policy.session_meta.is_none(), "{provider:?}");
            assert!(policy.config_toml.is_none(), "{provider:?}");
        }
        assert!(POLICIES.kimi.config.is_none());
        for provider in [NativeProvider::Grok, NativeProvider::Kimi] {
            assert!(provider.policy().unwrap().model_catalog.is_none());
        }
    }

    /// A provider runs only on a passed loopback probe of exactly what this
    /// build ships. Kimi, Codex and Grok passed on October 4, Z.ai on
    /// October 17.
    /// The native policy revision is recorded in every measurement; it keeps
    /// the name the measurements were taken under, whatever the product is
    /// called. A rename sweep that rewrites it fails here.
    #[test]
    fn the_policy_revision_keeps_the_name_the_measurements_carry() {
        assert!(NATIVE_TEXT_POLICY_REVISION.starts_with(&["dis", "till"].concat()));
    }

    #[test]
    fn only_a_probe_of_the_shipped_entry_and_adapter_admits_a_provider() {
        assert_eq!(NativeProvider::Claude.admission_issue(), None);
        assert_eq!(NativeProvider::Kimi.admission_issue(), None);
        let kimi = POLICIES.kimi.verified.as_ref().unwrap();
        assert_eq!(kimi.runtime, POLICIES.kimi.runtime);
        assert_eq!(kimi.date, "2026-10-04");
        // The probe hashes the entry as the file writes it, without the record.
        assert_eq!(
            NativeProvider::Kimi.policy_digest().as_deref(),
            Some("22745085402d29498340f352793947eab3ee9171b66747f197aa10e010bc66fd")
        );
        assert_eq!(kimi.adapter, Some(digest(KIMI_ADAPTER)));
        // Codex passed on the pinned codex-acp and CLI with the catalog
        // control (scripts/benchmark-provider-policy-probe.mjs codex).
        assert_eq!(NativeProvider::Codex.admission_issue(), None);
        let codex = POLICIES.codex.verified.as_ref().unwrap();
        assert_eq!(codex.runtime, POLICIES.codex.runtime);
        assert_eq!(codex.date, "2026-10-04");
        assert_eq!(
            NativeProvider::Codex.policy_digest().as_deref(),
            Some("76d8a7cd1626d8194c0d576436d929329fc331e5f5d9619aa24aff018b6d1381")
        );
        assert_eq!(codex.adapter, Some(digest(CODEX_ADAPTER)));
        // Grok passed on the pinned grok.exe with the session sign-in read
        // from `GROK_AUTH_PATH` and its auxiliary endpoints closed; it has no
        // adapter.
        assert_eq!(NativeProvider::Grok.admission_issue(), None);
        let grok = POLICIES.grok.verified.as_ref().unwrap();
        assert_eq!(grok.runtime, POLICIES.grok.runtime);
        assert_eq!(grok.date, "2026-10-04");
        assert_eq!(
            NativeProvider::Grok.policy_digest().as_deref(),
            Some("b93232ee921370b27b8b0fd219f0e2c91bfe89586c65dfc3e564fa17d053f5ef")
        );
        assert_eq!(grok.adapter, None);
        // Z.ai passed on the pinned opencode.exe with its policy plugin
        // (scripts/benchmark-provider-policy-probe.mjs zai).
        assert_eq!(NativeProvider::Zai.admission_issue(), None);
        let zai = POLICIES.zai.verified.as_ref().unwrap();
        assert_eq!(zai.runtime, POLICIES.zai.runtime);
        assert_eq!(zai.date, "2026-10-17");
        assert_eq!(
            NativeProvider::Zai.policy_digest().as_deref(),
            Some("d38dd24d555227bb7aa23343e69860f0a60ecab823de631c46b6a67a7cf9c3d6")
        );
        assert_eq!(zai.adapter, Some(digest(ZAI_ADAPTER)));
        let mut unprobed = POLICIES.grok.clone();
        unprobed.verified = None;
        assert_eq!(
            probe_record_issue(
                "Grok",
                &unprobed,
                NativeProvider::Grok.policy_digest().as_deref(),
                None
            ),
            Some("The Grok benchmark profile has not passed its policy probe".into())
        );
        // A record stands only for what it was made with.
        let policy = &POLICIES.kimi;
        let entry = NativeProvider::Kimi.policy_digest();
        let adapter = Some(digest(KIMI_ADAPTER));
        let issue = |policy: &ProviderPolicy, entry: Option<&str>, adapter: Option<&str>| {
            probe_record_issue("Kimi Code", policy, entry, adapter)
        };
        assert_eq!(issue(policy, entry.as_deref(), adapter.as_deref()), None);
        let changed = Some(
            "The Kimi Code benchmark profile changed since its policy probe passed; run the probe again"
                .to_string(),
        );
        assert_eq!(
            issue(policy, Some("another entry"), adapter.as_deref()),
            changed
        );
        assert_eq!(
            issue(policy, entry.as_deref(), Some("another adapter")),
            changed
        );
        assert_eq!(issue(policy, entry.as_deref(), None), changed);
        let mut updated = policy.clone();
        updated.runtime.label = "kimi-code:2.2.0".into();
        assert_eq!(
            issue(&updated, entry.as_deref(), adapter.as_deref()),
            changed
        );
        updated.verified = None;
        assert!(issue(&updated, entry.as_deref(), adapter.as_deref())
            .unwrap()
            .ends_with("has not passed its policy probe"));
        // The form the probe's `canonical` writes.
        assert_eq!(
            canonical_json(&json!({"b": [1, {"d": "\n", "c": null}], "a": true})),
            r#"{"a":true,"b":[1,{"c":null,"d":"\n"}]}"#
        );
    }

    #[test]
    fn codex_policy_disables_every_tool_feature() {
        let config = POLICIES.codex.config.as_ref().unwrap();
        for feature in [
            "shell_tool",
            "unified_exec",
            "unified_exec_tty",
            "shell_snapshot",
            "view_image",
            "image_generation",
            "apps",
            "plugins",
            "remote_plugin",
            "plugin_sharing",
            "browser_use",
            "browser_use_external",
            "browser_use_full_cdp_access",
            "in_app_browser",
            "in_app_local_automation",
            "computer_use",
            "multi_agent",
            "multi_agent_v2",
            "code_mode_host",
            "goals",
            "hooks",
            "memories",
            "personality",
            "skill_search",
            "skill_mcp_dependency_install",
            "tool_suggest",
            "tool_call_mcp_elicitation",
            "sleep_tool",
            "workspace_dependencies",
            "guardian_approval",
        ] {
            assert_eq!(config["features"][feature], false, "{feature}");
        }
        // The policy only ever turns features off.
        assert!(config["features"]
            .as_object()
            .unwrap()
            .values()
            .all(|enabled| enabled == false));
        assert_eq!(config["web_search"], "disabled");
        // Built-in tools outside the feature flags.
        for tool in ["update_plan", "experimental_request_user_input"] {
            assert_eq!(config["tools"][tool]["enabled"], false, "{tool}");
        }
        // A model's catalog entry turns subagents on whatever the feature
        // flags say; only this setting turns them off.
        assert_eq!(config["agents"], json!({"enabled": false}));
        // What a catalog entry declares besides: code mode, extra tools and
        // apply_patch.
        assert_eq!(
            POLICIES.codex.model_catalog,
            Some(
                json!({
                    "tool_mode": null,
                    "experimental_supported_tools": [],
                    "apply_patch_tool_type": null,
                })
                .as_object()
                .unwrap()
                .clone()
            )
        );
        assert_eq!(config["project_doc_max_bytes"], 0);
        assert_eq!(config["skills"]["include_instructions"], false);
        assert_eq!(config["history"]["persistence"], "none");
        for instructions in [
            "include_permissions_instructions",
            "include_environment_context",
            "include_apps_instructions",
            "include_collaboration_mode_instructions",
        ] {
            assert_eq!(config[instructions], false, "{instructions}");
        }
        // Nothing that adds context or tools of its own: the instructions file
        // is the host's, and project trust is codex-acp's.
        for added in [
            "projects",
            "mcp_servers",
            "developer_instructions",
            "profiles",
            "profile",
            "model_instructions_file",
            "hooks",
        ] {
            assert!(config.get(added).is_none(), "{added}");
        }
        let codex = NativeProvider::Codex;
        assert_eq!(codex.permission_mode(), Some("read-only"));
        assert!(!codex.judges_images());
    }

    #[test]
    fn codex_rejects_ultra_effort() {
        let mut ultra = request("codex-acp");
        assert_eq!(validate_request(&ultra), Ok(NativeProvider::Codex));
        ultra.reasoning_effort = Some("ultra".into());
        assert_eq!(
            validate_request(&ultra),
            Err("capability_missing: effort 'ultra' delegates to subagents and is not a single-model no-tool configuration".into())
        );
        assert_eq!(NativeProvider::Codex.effort_refusal(Some("max")), None);
        assert_eq!(NativeProvider::Codex.effort_refusal(None), None);
        assert_eq!(NativeProvider::Codex.excluded_efforts(), ["ultra"]);
    }

    #[test]
    fn owned_text_never_accepts_a_host_workspace_or_unsafe_account_path() {
        for &provider in NativeProvider::ALL {
            let mut owned = request(provider.harness_id());
            assert_eq!(validate_request(&owned), Ok(provider));
            owned.cwd = "C:/Users/invented/private".into();
            assert!(validate_request(&owned)
                .unwrap_err()
                .starts_with("validation:"));
            owned.cwd = "/workspace".into();
            owned.account_id = "../another-account".into();
            assert!(validate_request(&owned)
                .unwrap_err()
                .starts_with("validation:"));
        }
    }

    #[test]
    fn codex_adapter_pins_the_resource_hash() {
        let codex = NativeProvider::Codex;
        assert_eq!(codex.adapter(), Some(CODEX_ADAPTER));
        assert!(CODEX_ADAPTER.contains(&POLICIES.codex.runtime.files["entrypoint"]));
        // The app-server reads its model catalog only at startup, so the
        // adapter starts it with the one `CODEX_CONFIG` names.
        assert!(CODEX_ADAPTER.contains("`model_catalog_json=${JSON.stringify(catalog)}`"));
        // A call codex refuses inside the turn sends no update of its own; the
        // adapter reports the raw call item as a `tool_call`, which the host
        // tags as a violation (the probe checks it reaches the client).
        assert!(CODEX_ADAPTER.contains("experimentalRawEvents: true"));
        assert!(CODEX_ADAPTER.contains(r#"case "rawResponseItem/completed": {"#));
        assert!(CODEX_ADAPTER.contains(r#"sessionUpdate: "tool_call","#));
        assert_eq!(
            codex.session_meta("gpt-6-sol"),
            json!({"distillNativePolicy": {
                "revision": "distill-native-text-codex-v1",
                "adapterHash": digest(CODEX_ADAPTER),
            }})
        );
    }

    #[test]
    fn codex_policy_hash_differs_from_claude_and_tracks_config() {
        let request = request("codex-acp");
        let codex = NativeProvider::Codex;
        let hash = codex.policy_hash(&request).unwrap();
        assert_ne!(hash, NativeProvider::Claude.policy_hash(&request).unwrap());
        assert_eq!(
            hash,
            digest(
                serde_json::to_vec(&codex.configured_hash_input(&POLICIES.codex, &request))
                    .unwrap()
            )
        );
        let mut changed = POLICIES.codex.clone();
        changed
            .config
            .as_mut()
            .unwrap()
            .insert("web_search".into(), json!("live"));
        assert_ne!(
            codex.configured_hash_input(&changed, &request),
            codex.configured_hash_input(&POLICIES.codex, &request)
        );
    }

    #[test]
    fn validate_request_admits_only_known_native_providers() {
        assert_eq!(
            validate_request(&request("claude-acp")),
            Ok(NativeProvider::Claude)
        );
        assert_eq!(
            NativeProvider::for_harness("codex-acp"),
            Some(NativeProvider::Codex)
        );
        assert_eq!(
            NativeProvider::for_harness("grok-acp"),
            Some(NativeProvider::Grok)
        );
        assert_eq!(
            NativeProvider::for_harness("kimi-acp"),
            Some(NativeProvider::Kimi)
        );
        assert_eq!(
            validate_request(&request("kimi-acp")),
            Ok(NativeProvider::Kimi)
        );
        for provider in ["copilot-acp", "amp-acp"] {
            assert_eq!(
                validate_request(&request(provider)),
                Err("capability_missing: this provider has no verified native no-tool execution profile".into()),
                "{provider}"
            );
        }
        let mut repository = request("claude-acp");
        repository.profile = ExecutionProfile::ProtectedRepositoryV1;
        repository.cwd = "C:/invented-repository".into();
        assert!(validate_request(&repository)
            .unwrap_err()
            .starts_with("validation:"));
        repository.cwd = "/workspace".into();
        assert_eq!(validate_request(&repository), Ok(NativeProvider::Claude));
        let mut relative = request("claude-acp");
        relative.cwd = "workspace".into();
        assert!(validate_request(&relative)
            .unwrap_err()
            .starts_with("validation:"));
        assert_eq!(NativeProvider::Claude.effort_refusal(Some("max")), None);
        assert!(NativeProvider::Claude.judges_images());
    }

    #[test]
    fn grok_session_meta_removes_tools_rules_and_context() {
        let grok = NativeProvider::Grok;
        let meta = grok.session_meta("grok-4.7");
        assert_eq!(meta["systemPromptOverride"], SYSTEM_PROMPT);
        assert_eq!(meta["rules"], "");
        assert_eq!(meta["yoloMode"], false);
        assert_eq!(meta["autoMode"], false);
        let profile = &meta["agentProfile"];
        for empty in ["tools", "skills", "mcpServers"] {
            assert_eq!(profile[empty], json!([]), "{empty}");
        }
        for off in [
            "injectDefaultTools",
            "discoverSkills",
            "inheritSkills",
            "agentsMd",
        ] {
            assert_eq!(profile[off], false, "{off}");
        }
        // An empty `tools` restricts nothing: Grok 1.0.40 removes a tool only
        // when the profile denies it, by its internal id (the shell is
        // `run_terminal_cmd`, which the model sees as `run_terminal_command`),
        // and `Agent` removes subagents.
        let denied: Vec<&str> = profile["disallowedTools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for tool in [
            "Agent",
            "run_terminal_cmd",
            "read_file",
            "search_replace",
            "list_dir",
            "grep",
            "todo_write",
            "monitor",
            "search_tool",
            "use_tool",
            "update_goal",
            "web_search",
            "web_fetch",
        ] {
            assert!(denied.contains(&tool), "{tool}");
        }
        // Grok's first user message (system details and its own built-in
        // rules) is rendered from this template.
        assert_eq!(profile["userMessageTemplate"], "");
        assert_eq!(profile["hooks"], json!({}));
        assert_eq!(profile["mcpInheritance"], "none");
        assert_eq!(profile["maxTurns"], 1);
        // Every owned prompt goes to the model as written.
        assert_eq!(
            grok.prompt_meta().cloned().map(Value::Object),
            Some(json!({"verbatim": true}))
        );
        for other in [
            NativeProvider::Claude,
            NativeProvider::Codex,
            NativeProvider::Kimi,
            NativeProvider::Zai,
        ] {
            assert_eq!(other.prompt_meta(), None, "{other:?}");
        }
        assert_eq!(
            meta["distillNativePolicy"],
            json!({"revision": "distill-native-text-grok-v1"})
        );
        // Grok declares no modes, refuses no effort and never judges.
        assert_eq!(grok.permission_mode(), None);
        assert!(grok.excluded_efforts().is_empty());
        assert!(!grok.judges_images());
        assert_eq!(grok.adapter(), None);
        assert_eq!(POLICIES.grok.args, ["agent", "--no-leader", "stdio"]);
        // The policy hash covers the session policy.
        let request = request("grok-acp");
        let mut changed = POLICIES.grok.clone();
        changed
            .session_meta
            .as_mut()
            .unwrap()
            .insert("yoloMode".into(), json!(true));
        assert_ne!(
            grok.configured_hash_input(&changed, &request),
            grok.configured_hash_input(&POLICIES.grok, &request)
        );
        assert_ne!(
            grok.policy_hash(&request).unwrap(),
            NativeProvider::Codex.policy_hash(&request).unwrap()
        );
    }

    /// Grok fetches settings and platform skill and subagent bundles from its
    /// chat proxy base, and managed configuration, conversations, modes,
    /// workspaces, telemetry and feedback from endpoints of their own, all
    /// with the session it runs on. The policy closes every one of them and
    /// keeps only the model list live; model requests go to the endpoint
    /// each listed model names.
    #[test]
    fn grok_policy_closes_every_auxiliary_endpoint() {
        let env = &POLICIES.grok.env;
        for switch in ["GROK_TELEMETRY_ENABLED", "GROK_FEEDBACK_ENABLED"] {
            assert_eq!(env.get(switch).map(String::as_str), Some("0"), "{switch}");
        }
        for closed in [
            "GROK_CLI_CHAT_PROXY_BASE_URL",
            "GROK_CLI_BASE_URL",
            "GROK_SKILLS_BASE_URL",
            "GROK_MODES_BASE_URL",
            "GROK_CONVERSATIONS_BASE_URL",
            "GROK_WORKSPACES_BASE_URL",
            "GROK_FEEDBACK_BASE_URL",
            "GROK_MANAGED_CONFIG_URL",
        ] {
            assert_eq!(
                env.get(closed).map(String::as_str),
                Some("http://127.0.0.1:0"),
                "{closed}"
            );
        }
        assert_eq!(
            env.get("GROK_MODELS_BASE_URL").map(String::as_str),
            Some("https://cli-chat-proxy.grok.com/v1")
        );
        // The model list is the only endpoint the policy names and keeps open.
        let endpoints: Vec<&String> = env
            .keys()
            .filter(|key| key.ends_with("_URL"))
            .filter(|key| env[*key] != "http://127.0.0.1:0")
            .collect();
        assert_eq!(endpoints, ["GROK_MODELS_BASE_URL"]);
        // The policy never ungates folder trust.
        assert!(!env.contains_key("GROK_FOLDER_TRUST"));
    }

    /// Grok titles a session with a second model request carrying the task,
    /// and `features.title_refresh` covers only later refreshes. The private
    /// home points that helper model at a closed loopback port, with a key of
    /// its own so the user's session token is never attached, and no retry.
    #[test]
    fn grok_titles_go_to_a_closed_local_port() {
        let config: toml::Table =
            toml::from_str(POLICIES.grok.config_toml.as_deref().unwrap()).unwrap();
        let summary = config["models"]["session_summary"].as_str().unwrap();
        let model = &config["model"][summary];
        assert_eq!(model["base_url"].as_str(), Some("http://127.0.0.1:0/v1"));
        assert!(model["api_key"].as_str().is_some());
        assert_eq!(model["max_retries"].as_integer(), Some(0));
        assert_eq!(model["hidden"].as_bool(), Some(true));
        assert_eq!(config["features"]["title_refresh"].as_bool(), Some(false));
    }

    /// A Flock stopped while a Grok bridge started leaves its sign-in on
    /// disk; the host removes it when it starts again or quits, without
    /// waiting for another Grok benchmark.
    #[test]
    fn sign_ins_left_on_disk_go_without_a_grok_spawn() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("benchmarks").join("runtime");
        // Nothing there yet is not an error.
        discard_left_sign_ins(&runtime).unwrap();
        let dir = runtime.join("grok-acp");
        let left = dir.join("sign-in").join("left.json");
        std::fs::create_dir_all(left.parent().unwrap()).unwrap();
        std::fs::write(&left, r#"{"fabricated":"session"}"#).unwrap();
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join("home").join("auth.json"), "{}").unwrap();
        std::fs::write(dir.join("home").join("config.toml"), "").unwrap();
        discard_left_sign_ins(&runtime).unwrap();
        assert!(!left.exists());
        assert!(!dir.join("home").join("auth.json").exists());
        // Grok's own files stay.
        assert!(dir.join("home").join("config.toml").exists());
        assert!(dir.join("sign-in").is_dir());
        // Only Grok keeps a sign-in copy in its home.
        std::fs::write(dir.join("home").join("auth.json"), "{}").unwrap();
        discard_owned_sign_in(NativeProvider::Codex, &dir).unwrap();
        assert!(dir.join("home").join("auth.json").exists());
        discard_owned_sign_in(NativeProvider::Grok, &dir).unwrap();
        assert!(!dir.join("home").join("auth.json").exists());
    }

    /// Z.ai runs OpenCode: its policy is the configuration, the environment
    /// flags and the plugin that makes the profile's prompt the whole system
    /// prompt. None of it carries a key.
    #[test]
    fn zai_policy_is_opencode_configuration_flags_and_plugin() {
        let zai = NativeProvider::Zai;
        assert_eq!(NativeProvider::for_harness("zai-acp"), Some(zai));
        assert_eq!(validate_request(&request("zai-acp")), Ok(zai));
        assert_eq!(zai.policy_revision(), "distill-native-text-zai-v1");
        assert_eq!(zai.adapter(), Some(ZAI_ADAPTER));
        assert!(ZAI_ADAPTER.contains("experimental.chat.system.transform"));
        assert_eq!(
            zai.session_meta("zai-coding-plan/glm-5.3"),
            json!({"distillNativePolicy": {
                "revision": "distill-native-text-zai-v1",
                "adapterHash": digest(ZAI_ADAPTER),
            }})
        );
        // The mode is the OpenCode agent the configuration defines.
        assert_eq!(zai.permission_mode(), Some("distill-benchmark"));
        let config = zai.policy_config().unwrap();
        assert!(config["agent"]["distill-benchmark"].is_object());
        assert_eq!(
            config["agent"]["distill-benchmark"]["prompt"],
            SYSTEM_PROMPT
        );
        assert_eq!(config["plugin"][0][1]["prompt"], SYSTEM_PROMPT);
        let env: BTreeMap<String, String> = zai.policy_env().into_iter().collect();
        for flag in [
            "OPENCODE_DISABLE_AUTOUPDATE",
            "OPENCODE_DISABLE_CLAUDE_CODE",
            "OPENCODE_DISABLE_DEFAULT_PLUGINS",
            "OPENCODE_DISABLE_EXTERNAL_SKILLS",
            "OPENCODE_DISABLE_LSP_DOWNLOAD",
            "OPENCODE_DISABLE_MODELS_FETCH",
            "OPENCODE_DISABLE_PROJECT_CONFIG",
            "OPENCODE_DISABLE_SHARE",
        ] {
            assert_eq!(env.get(flag).map(String::as_str), Some("true"), "{flag}");
        }
        // Skipping external plugins would also skip the policy plugin.
        assert!(!env.contains_key("OPENCODE_PURE"));
        assert_eq!(env.len(), 8);
        assert!(zai.excluded_efforts().is_empty());
        assert!(zai.moving_aliases().is_empty());
        assert!(!zai.judges_images());
        assert!(POLICIES.zai.args.is_empty());
        assert!(POLICIES.zai.session_meta.is_none());
        assert!(POLICIES.zai.config_toml.is_none());
        assert!(POLICIES.zai.model_catalog.is_none());
        let request = request("zai-acp");
        assert_ne!(
            zai.policy_hash(&request).unwrap(),
            NativeProvider::Kimi.policy_hash(&request).unwrap()
        );
        let mut changed = POLICIES.zai.clone();
        changed
            .config
            .as_mut()
            .unwrap()
            .insert("snapshot".into(), json!(true));
        assert_ne!(
            zai.configured_hash_input(&changed, &request),
            zai.configured_hash_input(&POLICIES.zai, &request)
        );
    }

    #[test]
    fn kimi_adapter_pins_the_resource_hash_and_prompt() {
        let kimi = NativeProvider::Kimi;
        assert_eq!(kimi.adapter(), Some(KIMI_ADAPTER));
        assert!(KIMI_ADAPTER.contains(&POLICIES.kimi.runtime.files["entrypoint"]));
        assert!(KIMI_ADAPTER.contains(&format!("\"{SYSTEM_PROMPT}\"")));
        assert_eq!(
            kimi.session_meta("kimi-code/k3"),
            json!({"distillNativePolicy": {
                "revision": "distill-native-text-kimi-v1",
                "adapterHash": digest(KIMI_ADAPTER),
            }})
        );
        // Kimi asks the host for every approval, refuses no effort and never
        // judges.
        assert_eq!(kimi.permission_mode(), Some("default"));
        assert!(kimi.excluded_efforts().is_empty());
        assert!(!kimi.judges_images());
        let request = request("kimi-acp");
        assert_ne!(
            kimi.policy_hash(&request).unwrap(),
            NativeProvider::Codex.policy_hash(&request).unwrap()
        );
    }
}
