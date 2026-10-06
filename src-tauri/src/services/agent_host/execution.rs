//! Typed, durable execution contract for application-owned benchmark sessions.
//! The native text profile disables tools; it is not a filesystem sandbox.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

pub const NATIVE_TEXT_POLICY_REVISION: &str = "distill-native-text-policy-v2";
pub const NATIVE_TEXT_ADAPTER: &str =
    include_str!("../../../resources/benchmark-claude-policy.mjs");
const CODEX_ADAPTER: &str = include_str!("../../../resources/benchmark-codex-policy.mjs");
const KIMI_ADAPTER: &str = include_str!("../../../resources/benchmark-kimi-policy.mjs");
/// The system prompt every native text profile puts in place of the vendor's.
/// `resources/benchmark-native-policies.json` carries the same text for the
/// providers configured there; a test keeps the two equal.
pub const SYSTEM_PROMPT: &str =
    "Complete the supplied benchmark task. Return only the requested answer.";
/// The file in a Codex runtime directory that replaces the model's base
/// instructions (`model_instructions_file`).
const CODEX_INSTRUCTIONS: &str = "instructions.md";
/// The folder in a Codex runtime directory holding the model catalog each
/// account's owned CLI starts with (see [`prepare_codex_model_catalog`]).
const CODEX_MODEL_CATALOGS: &str = "model-catalogs";
/// The model list the Codex CLI caches in its home, as the server sent it.
const CODEX_MODELS_CACHE: &str = "models_cache.json";
/// Grok's private home in its runtime directory (`GROK_HOME`).
const GROK_HOME: &str = "home";
/// The sign-in file Grok keeps in its home. Benchmarks hand Grok the user's
/// sign-in from a file outside it (see [`OwnedSignIn`]); a copy Grok writes
/// there is removed (see [`discard_owned_sign_in`]).
const GROK_AUTH_FILE: &str = "auth.json";
/// The owner-only folder in Grok's runtime directory that holds the sign-in
/// an owned Grok is starting with, and only while it starts.
const GROK_SIGN_IN: &str = "sign-in";
/// What Grok creates in a directory of [`GROK_FORBIDDEN_HOME_ENTRIES`] on its
/// own, which adds nothing to a session: its plugin registry lock.
const GROK_OWN_HOME_FILES: &[(&str, &str)] = &[("installed-plugins", "registry.lock")];
/// What in Grok's private home would add instructions, hooks, skills, agents,
/// plugins, memory, managed policy, MCP sign-ins or trusted project folders
/// to every session. Grok reads `$GROK_HOME` as always-trusted global
/// configuration, and no setting turns its hooks off: `hooks-paths` lists
/// more hook files, and `trusted_folders.toml` lets a folder's instructions,
/// skills, hooks and MCP servers load. A directory counts once it has
/// entries other than Grok's own ([`GROK_OWN_HOME_FILES`]).
const GROK_FORBIDDEN_HOME_ENTRIES: &[&str] = &[
    "AGENTS.md",
    "Agents.md",
    "AGENT.md",
    "CLAUDE.md",
    "Claude.md",
    "CLAUDE.local.md",
    "rules",
    "hooks",
    "skills",
    "agents",
    "plugins",
    "installed-plugins",
    "memory",
    "memory-v2",
    "managed_config.toml",
    "requirements.toml",
    "mcp_credentials.json",
    "hooks-paths",
    "trusted_folders.toml",
];

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
    /// `CODEX_CONFIG`.
    #[serde(default)]
    config: Option<Map<String, Value>>,
    /// Codex: the fields set on every entry of the model catalog the owned
    /// CLI starts with (see [`codex_model_catalog`]).
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
    /// The sha256 of each pinned file, by its role in [`RuntimePaths`].
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

/// The files an owned launch runs, as the host resolves them.
pub struct RuntimePaths<'a> {
    /// The file the bridge's executable fingerprint names: the node
    /// entrypoint behind a managed launcher or an npm shim (Kimi, see
    /// [`kimi_entrypoint`]), or the executable itself for a bridge that is a
    /// native CLI (Grok).
    pub entrypoint: &'a Path,
    /// The native CLI the bridge drives (`managed_acp_tools::native_cli_path`).
    pub native_cli: Option<&'a Path>,
}

impl RuntimePaths<'_> {
    /// The file a pinned role of the policy resource names.
    fn file(&self, role: &str) -> Option<&Path> {
        match role {
            "entrypoint" | "executable" => Some(self.entrypoint),
            "nativeCli" => self.native_cli,
            _ => None,
        }
    }
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
}

impl NativeProvider {
    /// Every provider with a verified profile, in the order the benchmark
    /// capabilities list them.
    pub const ALL: &'static [NativeProvider] = &[
        NativeProvider::Claude,
        NativeProvider::Codex,
        NativeProvider::Grok,
        NativeProvider::Kimi,
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
        }
    }

    /// The short name of the provider in the policy resource and profile key.
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Grok => "grok",
            Self::Kimi => "kimi",
        }
    }

    /// The provider's entry in the policy resource; Claude's policy is inline.
    fn policy(self) -> Option<&'static ProviderPolicy> {
        match self {
            Self::Claude => None,
            Self::Codex => Some(&POLICIES.codex),
            Self::Grok => Some(&POLICIES.grok),
            Self::Kimi => Some(&POLICIES.kimi),
        }
    }

    pub fn policy_revision(self) -> &'static str {
        self.policy()
            .map_or(NATIVE_TEXT_POLICY_REVISION, |policy| &policy.revision)
    }

    /// The preload module that edits the bridge as Node loads it, for a
    /// provider whose bridge runs under Node.
    pub fn adapter(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some(NATIVE_TEXT_ADAPTER),
            Self::Codex => Some(CODEX_ADAPTER),
            Self::Kimi => Some(KIMI_ADAPTER),
            Self::Grok => None,
        }
    }

    /// The canonical bytes of the provider's resource entry, which the runtime
    /// fingerprint covers; empty for Claude.
    pub fn policy_bytes(self) -> Vec<u8> {
        self.policy()
            .and_then(|policy| serde_json::to_vec(policy).ok())
            .unwrap_or_default()
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
    /// clean-context policy. Codex and Kimi read none of it (their policy
    /// reaches the process through the environment and the adapter); Grok's
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
    /// model. Kimi's `default` asks the host for every approval.
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

    /// Shell variables the owned process keeps besides the fixed allowlist:
    /// the provider CLI's own home or key, where its sign-in lives there.
    /// Codex signs in through the managed account's home instead; Grok gets
    /// its session from the file `GROK_AUTH_PATH` names (see [`OwnedSignIn`])
    /// and falls back to the user's API key; Kimi keeps the user's Kimi home
    /// and endpoint settings, as in chats.
    pub fn inherited_env_keys(self) -> &'static [&'static str] {
        match self {
            Self::Claude | Self::Codex => &[],
            Self::Grok => &["XAI_API_KEY"],
            Self::Kimi => &[
                "KIMI_CODE_HOME",
                "KIMI_API_KEY",
                "KIMI_BASE_URL",
                "KIMI_CODE_BASE_URL",
                "KIMI_CODE_OAUTH_HOST",
                "KIMI_OAUTH_HOST",
                "KIMI_CODE_CUSTOM_HEADERS",
            ],
        }
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
            Self::Claude | Self::Codex | Self::Grok => &[],
        }
    }

    /// Whether this provider's models may sit on a judge panel. Only Claude
    /// has been checked to read the rendered image a judge is shown; another
    /// provider joining would also change scores in the middle of a campaign.
    pub fn judges_images(self) -> bool {
        match self {
            Self::Claude => true,
            Self::Codex | Self::Grok | Self::Kimi => false,
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
                "bridgeVersion":"0.81.0", "sdkVersion":"0.3.280"
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

    /// The route key of this profile's bridge processes, separate from chats.
    pub fn profile_key(self) -> String {
        match self.policy() {
            None => digest("native_text_v1:claude:0.81.0:sdk:0.3.280"),
            Some(policy) => digest(format!(
                "native_text_v1:{}:{}",
                self.key(),
                policy.runtime.label
            )),
        }
    }

    /// Checks that `runtime` is the build the profile was verified against.
    pub fn verify_runtime(self, runtime: &RuntimePaths) -> Result<(), String> {
        let Some(policy) = self.policy() else {
            return validate_native_runtime(runtime.entrypoint);
        };
        let label = self.harness_label();
        for (role, expected) in &policy.runtime.files {
            let path = runtime.file(role).ok_or_else(|| {
                format!("capability_missing: the managed {label} runtime is not installed")
            })?;
            let actual = file_digest(path).map_err(|_| {
                format!("capability_missing: pinned {label} benchmark runtime is unavailable")
            })?;
            if &actual != expected {
                return Err(format!("capability_missing: installed {label} runtime changed; benchmark profile requires verification"));
            }
        }
        Ok(())
    }

    /// The sha256 of each file the resource pins, by role, as `runtime` has it
    /// now (`None` where it is missing). Empty for Claude, whose fingerprint
    /// reads its entrypoint itself.
    pub fn pinned_digests(self, runtime: &RuntimePaths) -> Vec<(&'static str, Option<String>)> {
        self.policy()
            .into_iter()
            .flat_map(|policy| policy.runtime.files.keys())
            .map(|role| {
                let digest = runtime.file(role).and_then(|path| file_digest(path).ok());
                (role.as_str(), digest)
            })
            .collect()
    }

    /// The arguments an owned process runs with in place of the harness's
    /// own, for a provider whose resource names them.
    pub fn launch_args(self) -> &'static [String] {
        self.policy().map_or(&[], |policy| policy.args.as_slice())
    }

    /// The variables an owned process of this provider gets on top of the
    /// account environment, given its runtime directory `dir` (see
    /// [`prepare_owned_runtime`]), for Kimi the user's Kimi home `cli_home`
    /// (see [`kimi_home`]), for Grok the file `sign_in` holding the session
    /// to run on (see [`OwnedSignIn`]), and for Codex the model catalog file
    /// `catalog` (see [`prepare_codex_model_catalog`]). Every provider
    /// configured by the resource runs with its OS home and application data
    /// folders redirected to an empty directory, so no personal skills or
    /// settings under the user's profile reach a CLI that finds the profile
    /// through the environment (Kimi, Grok); the policy probe runs it the same
    /// way. codex.exe asks the operating system instead (see
    /// [`codex_user_skills_preflight`]).
    pub fn process_env(
        self,
        dir: &Path,
        cli_home: Option<&Path>,
        sign_in: Option<&Path>,
        catalog: Option<&Path>,
    ) -> Vec<(String, String)> {
        let Some(policy) = self.policy() else {
            return Vec::new();
        };
        let mut env: Vec<(String, String)> = policy
            .env
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let os_home = dir.join("os-home").to_string_lossy().into_owned();
        for key in ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"] {
            env.push((key.into(), os_home.clone()));
        }
        if self == Self::Codex {
            // codex-acp merges this into every `thread/start`; the account's
            // `CODEX_HOME` and key come from the account environment.
            let mut config = policy.config.clone().unwrap_or_default();
            config.insert(
                "model_instructions_file".into(),
                json!(dir.join(CODEX_INSTRUCTIONS).to_string_lossy()),
            );
            // A thread ignores it; the adapter starts the CLI with it, and
            // without it the adapter does not start the bridge.
            if let Some(catalog) = catalog {
                config.insert(
                    "model_catalog_json".into(),
                    json!(catalog.to_string_lossy()),
                );
            }
            env.push(("CODEX_CONFIG".into(), Value::Object(config).to_string()));
        }
        if self == Self::Grok {
            // Grok reads its configuration, instructions, hooks and skills
            // from its home: a private one, which holds no credentials. The
            // session it runs on it reads once, at `initialize`, from a file
            // outside that home. Grok 1.0.40 accepts no session through
            // `GROK_AUTH`: an ACP session refuses to open without a sign-in
            // method, and the model request carries no token.
            env.push((
                "GROK_HOME".into(),
                dir.join(GROK_HOME).to_string_lossy().into_owned(),
            ));
            if let Some(sign_in) = sign_in {
                env.push((
                    "GROK_AUTH_PATH".into(),
                    sign_in.to_string_lossy().into_owned(),
                ));
            }
        }
        if let Some(home) = cli_home.filter(|_| self == Self::Kimi) {
            // Kimi keeps its sign-in, and refreshes it, in its own home; with
            // the OS home redirected it would otherwise look under the empty
            // one. What it loads from there the adapter removes.
            env.push(("KIMI_CODE_HOME".into(), home.to_string_lossy().into_owned()));
        }
        env
    }

    fn harness_label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Grok => "Grok",
            Self::Kimi => "Kimi Code",
        }
    }
}

/// The Kimi home the user's chats run on, from the shell environment an owned
/// bridge starts with: `KIMI_CODE_HOME`, else `.kimi-code` in the OS home, as
/// Kimi itself resolves it.
pub fn kimi_home(shell_env: &HashMap<String, String>) -> Option<PathBuf> {
    let set = |key: &str| {
        crate::services::env_key::get(shell_env, key)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    set("KIMI_CODE_HOME").or_else(|| {
        set("USERPROFILE")
            .or_else(|| set("HOME"))
            .map(|home| home.join(".kimi-code"))
    })
}

/// The Grok binary that chats run behind `executable`. Distill's Node
/// installs Grok's npm package, whose `grok` shim starts the binary in
/// `<GROK_HOME>/bin` (else `~/.grok/bin`), as its bootstrap does; the profile
/// pins and runs that binary itself. An executable already named `grok` is
/// that binary.
pub fn grok_binary(executable: &Path) -> PathBuf {
    grok_binary_in(executable, std::env::var_os("GROK_HOME").map(PathBuf::from))
}

fn grok_binary_in(executable: &Path, grok_home: Option<PathBuf>) -> PathBuf {
    let name = if cfg!(windows) { "grok.exe" } else { "grok" };
    if executable
        .file_name()
        .is_some_and(|file| file.eq_ignore_ascii_case(name))
    {
        return executable.to_path_buf();
    }
    grok_home
        .or_else(|| {
            dirs::home_dir().map(|home| std::fs::canonicalize(&home).unwrap_or(home).join(".grok"))
        })
        .unwrap_or_default()
        .join("bin")
        .join(name)
}

/// The package entrypoint the npm shim `shim` runs:
/// `<shim dir>/node_modules/@moonshot-ai/kimi-code/dist/main.mjs`, which the
/// Kimi profile pins and starts under Node with its adapter. A `kimi` that is
/// not that layout (a native install, a hand-written shim) is refused.
pub fn kimi_entrypoint(shim: &Path) -> Result<PathBuf, String> {
    let entrypoint = shim
        .parent()
        .map(|dir| {
            dir.join("node_modules")
                .join("@moonshot-ai")
                .join("kimi-code")
                .join("dist")
                .join("main.mjs")
        })
        .filter(|entrypoint| entrypoint.is_file())
        .ok_or("capability_missing: Kimi Code is not a recognized npm install")?;
    Ok(entrypoint)
}

/// Creates or rewrites what an owned process of `provider` reads from its
/// runtime directory `dir`, under the Distill root `root`: never through a
/// link, and deleting nothing but copies of the Grok sign-in (one Grok left
/// in its private home, or one a stopped Distill left in the sign-in
/// folder). Codex: the instructions file and the empty OS home. Grok: the
/// empty OS home and a private home holding only the policy's `config.toml`
/// and Grok's own runtime files. Kimi: the empty OS home. Claude needs none.
/// The host calls it under the harness's spawn lock, so no other bridge of
/// the provider is starting meanwhile.
pub fn prepare_owned_runtime(
    provider: NativeProvider,
    root: &Path,
    dir: &Path,
) -> Result<(), String> {
    if provider == NativeProvider::Claude {
        return Ok(());
    }
    let unavailable = |error: String| {
        format!("capability_missing: benchmark runtime directory is unavailable: {error}")
    };
    let os_home = dir.join("os-home");
    crate::services::distill_root::reject_document_links(root, &os_home).map_err(unavailable)?;
    std::fs::create_dir_all(&os_home).map_err(|error| unavailable(error.to_string()))?;
    // Codex and Kimi read personal skills from `~/.agents/skills`; the
    // redirected home must not grow its own.
    let skills = os_home.join(".agents").join("skills");
    if std::fs::read_dir(&skills).is_ok_and(|mut entries| entries.next().is_some()) {
        return Err(format!(
            "capability_missing: the benchmark OS home gained skills; remove {} to continue",
            skills.display()
        ));
    }
    if provider == NativeProvider::Codex {
        replace_file(root, &dir.join(CODEX_INSTRUCTIONS), SYSTEM_PROMPT).map_err(unavailable)?;
    }
    if provider == NativeProvider::Grok {
        let home = dir.join(GROK_HOME);
        crate::services::distill_root::reject_document_links(root, &home).map_err(unavailable)?;
        std::fs::create_dir_all(&home).map_err(|error| unavailable(error.to_string()))?;
        // First, so a home the check below refuses keeps no sign-in either.
        discard_owned_sign_in(provider, dir).map_err(|error| unavailable(error.to_string()))?;
        discard_stale_sign_ins(dir).map_err(|error| unavailable(error.to_string()))?;
        grok_home_preflight(&home)?;
        let config = provider
            .policy()
            .and_then(|policy| policy.config_toml.as_deref())
            .unwrap_or_default();
        replace_file(root, &home.join("config.toml"), config).map_err(unavailable)?;
    }
    Ok(())
}

/// Writes `contents` to `path` unless it already holds them. Another bridge
/// may be reading it, so it is replaced whole.
fn replace_file(root: &Path, path: &Path, contents: &str) -> Result<(), String> {
    crate::services::distill_root::reject_document_links(root, path)?;
    if std::fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = path.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, contents)
        .and_then(|()| std::fs::rename(&temp, path))
        .map_err(|error| {
            let _ = std::fs::remove_file(&temp);
            error.to_string()
        })
}

/// Refuses a private Grok home that gained a source of instructions, hooks,
/// skills, agents, plugins, memory, managed policy or MCP sign-ins. Grok's
/// own docs, sessions, caches and plugin registry lock there are none of
/// these, and an empty directory adds nothing.
fn grok_home_preflight(home: &Path) -> Result<(), String> {
    for entry in GROK_FORBIDDEN_HOME_ENTRIES {
        let path = home.join(entry);
        let own = |name: &std::ffi::OsStr| {
            GROK_OWN_HOME_FILES
                .iter()
                .any(|(dir, file)| dir == entry && name == *file)
        };
        let present = match path.symlink_metadata() {
            Ok(metadata) if metadata.is_dir() => std::fs::read_dir(&path)
                .map_or(true, |mut items| {
                    items.any(|item| item.map_or(true, |item| !own(&item.file_name())))
                }),
            Ok(_) => true,
            Err(_) => false,
        };
        if present {
            return Err(format!(
                "capability_missing: Grok's private benchmark home gained {entry}; remove {} to continue",
                path.display()
            ));
        }
    }
    Ok(())
}

/// Removes the sign-in file Grok may have written into its private home
/// from the session it was handed, so the user's access token never stays
/// in the Distill root after the bridge that needed it. Nothing for other
/// providers. The file an owned Grok starts with is its spawner's to remove
/// (see [`OwnedSignIn`]): a bridge stopping meanwhile must not take away the
/// one another is reading.
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

/// Removes every file in Grok's sign-in folder under `dir`: what a Distill
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
/// quits, so a token a stopped Distill left on disk does not wait for the
/// next Grok benchmark.
pub fn discard_left_sign_ins(runtime_root: &Path) -> std::io::Result<()> {
    let dir = runtime_root.join(NativeProvider::Grok.harness_id());
    discard_stale_sign_ins(&dir)?;
    discard_owned_sign_in(NativeProvider::Grok, &dir)
}

/// The user's Grok sign-in on disk for exactly as long as an owned Grok
/// needs it: Grok reads the file `GROK_AUTH_PATH` names once, while it
/// answers `initialize`, and keeps the session in memory; it neither copies
/// the file into its home nor writes it back. The file lives in an
/// owner-only folder outside Grok's private home, under a name of its own,
/// and is removed when this is dropped: by the spawner, once the bridge has
/// answered `initialize` or failed to.
pub struct OwnedSignIn {
    path: PathBuf,
}

impl OwnedSignIn {
    /// Where the next owned Grok in the runtime directory `dir` reads its
    /// sign-in from; nothing is written yet.
    pub fn path_in(dir: &Path) -> PathBuf {
        dir.join(GROK_SIGN_IN)
            .join(format!("{}.json", uuid::Uuid::new_v4()))
    }

    /// Writes `document` to `path` (see [`Self::path_in`]), under the Distill
    /// root `root`, in a folder only the user can read.
    pub fn write(root: &Path, path: &Path, document: &str) -> Result<Self, String> {
        let folder = path
            .parent()
            .ok_or("capability_missing: the Grok sign-in folder is unavailable")?;
        crate::services::distill_root::reject_document_links(root, path)?;
        std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
        crate::services::provider_accounts::protect_directory(folder)?;
        let written = Self {
            path: path.to_path_buf(),
        };
        std::fs::write(path, document).map_err(|error| error.to_string())?;
        Ok(written)
    }
}

impl Drop for OwnedSignIn {
    fn drop(&mut self) {
        if let Err(error) = remove_if_present(&self.path) {
            log::warn!(
                "[agent-host] the Grok benchmark sign-in {} was not removed: {error}",
                self.path.display()
            );
        }
    }
}

/// Refuses a Codex account home that would add context the policy cannot
/// take away: Codex loads the home's `AGENTS.md` and hooks into every thread,
/// and every key of its `config.toml` (MCP servers, profiles, instructions)
/// merges under the policy instead of being replaced by it. Distill writes
/// only the credential store setting there.
pub fn codex_home_preflight(home: &Path) -> Result<(), String> {
    for entry in ["AGENTS.md", "AGENTS.override.md", "hooks.json", "hooks"] {
        if home.join(entry).symlink_metadata().is_ok() {
            return Err("capability_missing: The account's Codex home has global instructions or hooks; benchmarks need a clean account home".into());
        }
    }
    // A skill there is injected when the task names it (`$name`), and no
    // setting turns user skills off. The bundled ones the CLI keeps in
    // `skills/.system` the policy turns off.
    if let Ok(entries) = std::fs::read_dir(home.join("skills")) {
        if entries
            .flatten()
            .any(|entry| entry.file_name() != ".system")
        {
            return Err("capability_missing: The account's Codex home has skills of its own; benchmarks need a clean account home".into());
        }
    }
    let text = match std::fs::read_to_string(home.join("config.toml")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "capability_missing: the account's Codex configuration cannot be read: {error}"
            ))
        }
    };
    let config: toml::Table = toml::from_str(&text).map_err(|_| {
        "capability_missing: the account's Codex configuration is not valid TOML".to_string()
    })?;
    let unknown: Vec<&str> = config
        .keys()
        .map(String::as_str)
        .filter(|key| *key != "cli_auth_credentials_store")
        .collect();
    if !unknown.is_empty() {
        return Err(format!(
            "capability_missing: the account's Codex configuration sets {}; benchmarks need one with only the credential store",
            unknown.join(", ")
        ));
    }
    Ok(())
}

/// The user's own profile folder as the Codex CLI finds it: through the
/// operating system (the Windows known-folder API), which the redirected
/// `USERPROFILE` and `HOME` of an owned process do not change.
pub fn codex_user_profile() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Refuses Codex while the user's own profile `profile` (see
/// [`codex_user_profile`]) has personal skills. codex.exe reads
/// `.agents/skills` there whatever the owned process's environment says, and
/// a task that names one of those skills (`$name`) gets the skill's whole
/// file added to the model input, sent to the vendor; no Codex setting turns
/// that off (`skills.enabled`, `features.skip_host_skill_discovery` and
/// `features.mentions_v2` all still add it). The policy probe shows that
/// folder is the only one this reaches.
pub fn codex_user_skills_preflight(profile: Option<&Path>) -> Result<(), String> {
    let profile = profile.ok_or(
        "capability_missing: the user profile Codex reads personal skills from cannot be located",
    )?;
    let skills = profile.join(".agents").join("skills");
    let present = match std::fs::read_dir(&skills) {
        Ok(mut entries) => entries.next().is_some(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        // Unreadable, or not a folder: Codex may still find skills there.
        Err(_) => true,
    };
    if present {
        return Err(format!(
            "capability_missing: Codex adds the personal skills in {} to any task that names one, and no setting turns that off; Codex benchmarks need that folder empty",
            skills.display()
        ));
    }
    Ok(())
}

/// The model catalog an owned Codex CLI starts with: the list the CLI cached
/// in the account's home `home`, as the server sent it for this account and
/// CLI version, with the policy's `modelCatalog` fields set on every entry.
/// A catalog entry, not configuration, gives a model code mode and its extra
/// tools and `apply_patch` (`tool_mode`, `experimental_supported_tools`,
/// `apply_patch_tool_type`), so only a catalog without them makes a turn
/// without tool definitions. Everything else the entry says is kept.
pub fn codex_model_catalog(home: &Path) -> Result<String, String> {
    let text = match std::fs::read_to_string(home.join(CODEX_MODELS_CACHE)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("capability_missing: the account's Codex model list is not cached yet; open a Codex chat with this account once".into())
        }
        Err(error) => {
            return Err(format!(
                "capability_missing: the account's Codex model list cannot be read: {error}"
            ))
        }
    };
    let unreadable = || {
        "capability_missing: the account's Codex model list is not one the CLI wrote".to_string()
    };
    let cache: Value = serde_json::from_str(&text).map_err(|_| unreadable())?;
    let models = cache["models"].as_array().ok_or_else(unreadable)?;
    if models.is_empty() {
        return Err(unreadable());
    }
    let fields = POLICIES.codex.model_catalog.clone().unwrap_or_default();
    let models = models
        .iter()
        .map(|model| {
            let mut model = model.as_object().cloned().ok_or_else(unreadable)?;
            model.extend(fields.clone());
            Ok(Value::Object(model))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({ "models": models }).to_string())
}

/// Writes [`codex_model_catalog`] of the account `account_id`, whose Codex
/// home is `home`, into the Codex runtime directory `dir` under the Distill
/// root `root`, and returns the file. One file per account: a running CLI
/// read its own when it started, and a new one starts only once that one
/// is gone.
pub fn prepare_codex_model_catalog(
    root: &Path,
    dir: &Path,
    account_id: &str,
    home: &Path,
) -> Result<PathBuf, String> {
    let catalog = codex_model_catalog(home)?;
    let folder = dir.join(CODEX_MODEL_CATALOGS);
    let unavailable = |error: String| {
        format!("capability_missing: benchmark runtime directory is unavailable: {error}")
    };
    crate::services::distill_root::reject_document_links(root, &folder).map_err(unavailable)?;
    std::fs::create_dir_all(&folder).map_err(|error| unavailable(error.to_string()))?;
    // Account ids name files only through their digest.
    let path = folder.join(format!("{}.json", &digest(account_id)[..16]));
    replace_file(root, &path, &catalog).map_err(unavailable)?;
    Ok(path)
}

type FileVersion = (u64, Option<SystemTime>, Option<SystemTime>);

/// The sha256 of a file, computed once per version of it. Pinned runtimes are
/// checked on every inventory read and launch, and a native CLI runs to
/// hundreds of megabytes. A replaced file changes its size, modification or
/// creation time; npm stamps one fixed modification time on every file it
/// unpacks, so the creation time is what tells two installs apart.
pub fn file_digest(path: &Path) -> Result<String, String> {
    static CACHE: LazyLock<Mutex<HashMap<PathBuf, (FileVersion, String)>>> =
        LazyLock::new(Mutex::default);
    let version = |metadata: std::fs::Metadata| -> FileVersion {
        (
            metadata.len(),
            metadata.modified().ok(),
            metadata.created().ok(),
        )
    };
    let before = version(std::fs::metadata(path).map_err(|error| error.to_string())?);
    if let Some((cached, digest)) = CACHE.lock().ok().and_then(|cache| cache.get(path).cloned()) {
        if cached == before {
            return Ok(digest);
        }
    }
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash).map_err(|error| error.to_string())?;
    let digest = hex::encode(hash.finalize());
    // A file replaced while it was read is hashed again on the next call.
    if let Ok(metadata) = file.metadata() {
        if version(metadata) == before {
            if let Ok(mut cache) = CACHE.lock() {
                cache.insert(path.to_path_buf(), (before, digest.clone()));
            }
        }
    }
    Ok(digest)
}

fn validate_native_runtime(entrypoint: &Path) -> Result<(), String> {
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
        let source = file_digest(&directory.join(name)).map_err(|_| {
            "capability_missing: pinned Claude benchmark adapter source is unavailable"
        })?;
        if source != expected {
            return Err("capability_missing: installed Claude bridge changed; benchmark adapter requires verification".into());
        }
    }
    Ok(())
}

/// The `--import` argument that loads `provider`'s adapter, once the runtime
/// it edits is verified.
pub(super) fn native_preload_argument(
    provider: NativeProvider,
    runtime: &RuntimePaths,
) -> Result<String, String> {
    provider.verify_runtime(runtime)?;
    let adapter = provider
        .adapter()
        .ok_or("capability_missing: this provider has no benchmark adapter")?;
    Ok(format!(
        "data:text/javascript;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(adapter)
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
    if request.profile == ExecutionProfile::ProtectedRepositoryV1 {
        crate::services::benchmark_sandbox::valid_id(&request.account_id)
            .map_err(|error| format!("validation: {error}"))?;
        if request.cwd != "/workspace" {
            return Err("validation: repository workspace must be /workspace".into());
        }
        return Ok(provider);
    }
    if !Path::new(&request.cwd).is_absolute() {
        return Err("validation: benchmark workspace must be absolute".into());
    }
    // codex-acp trusts the session's folder, and a trusted project's
    // `.codex/config.toml` adds MCP servers and hooks the policy cannot
    // remove; its `.agents/skills` are injected when the task names them.
    // The runner's workspaces start empty; anything else is refused.
    if provider == NativeProvider::Codex
        && [".codex", ".agents"]
            .iter()
            .any(|entry| Path::new(&request.cwd).join(entry).exists())
    {
        return Err(
            "capability_missing: the benchmark workspace has its own Codex configuration".into(),
        );
    }
    Ok(provider)
}

#[cfg(test)]
mod grok_binary_tests {
    use super::*;

    #[test]
    fn the_npm_shim_runs_the_binary_in_grok_home() {
        let name = if cfg!(windows) { "grok.exe" } else { "grok" };
        let home = PathBuf::from("C:/grok-home");
        let shim = Path::new("C:/distill/node/grok.cmd");
        assert_eq!(
            grok_binary_in(shim, Some(home.clone())),
            home.join("bin").join(name)
        );
        let native = Path::new("C:/somewhere/bin").join(name);
        assert_eq!(grok_binary_in(&native, Some(home)), native);
    }
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
        let runtime = RuntimePaths {
            entrypoint: &entrypoint,
            native_cli: None,
        };
        let claude = NativeProvider::Claude;
        assert!(native_preload_argument(claude, &runtime)
            .unwrap_err()
            .starts_with("capability_missing:"));
        std::fs::write(directory.path().join("acp-agent.js"), "changed bridge").unwrap();
        assert!(native_preload_argument(claude, &runtime)
            .unwrap_err()
            .contains("installed Claude bridge changed"));
    }

    #[test]
    fn codex_runtime_requires_both_pinned_files() {
        let directory = tempfile::tempdir().unwrap();
        let entrypoint = directory.path().join("index.js");
        let native = directory.path().join("codex.exe");
        std::fs::write(&entrypoint, "another build").unwrap();
        std::fs::write(&native, "another binary").unwrap();
        let codex = NativeProvider::Codex;
        let without_cli = RuntimePaths {
            entrypoint: &entrypoint,
            native_cli: None,
        };
        let changed = RuntimePaths {
            entrypoint: &entrypoint,
            native_cli: Some(&native),
        };
        // Roles are checked in the resource's order: entrypoint first.
        assert_eq!(
            codex.verify_runtime(&changed),
            Err("capability_missing: installed Codex runtime changed; benchmark profile requires verification".into())
        );
        assert!(native_preload_argument(codex, &without_cli)
            .unwrap_err()
            .starts_with("capability_missing:"));
        let digests = codex.pinned_digests(&changed);
        assert_eq!(
            digests,
            vec![
                ("entrypoint", Some(digest("another build"))),
                ("nativeCli", Some(digest("another binary"))),
            ]
        );
        assert_eq!(codex.pinned_digests(&without_cli)[1], ("nativeCli", None));
        assert!(NativeProvider::Claude.pinned_digests(&changed).is_empty());
    }

    fn request(provider: &str) -> OwnedSessionRequest {
        OwnedSessionRequest {
            owner_id: "attempt-1".into(),
            provider_id: provider.into(),
            account_id: "account-1".into(),
            model_id: "exact-model".into(),
            reasoning_effort: Some("high".into()),
            fast_mode: Some(false),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            title: "Benchmark: case [1]".into(),
            profile: ExecutionProfile::NativeTextV1,
        }
    }

    /// Existing owners' policy hashes, configurations' runtime pins and the
    /// bridges already running for them were made from exactly these inputs.
    #[test]
    fn claude_policy_hash_profile_key_and_meta_are_unchanged() {
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
                "bridgeVersion":"0.81.0", "sdkVersion":"0.3.280"
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
        assert_eq!(
            claude.profile_key(),
            digest("native_text_v1:claude:0.81.0:sdk:0.3.280")
        );
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
            assert!(provider.launch_args().is_empty(), "{provider:?}");
            assert!(policy.session_meta.is_none(), "{provider:?}");
            assert!(policy.config_toml.is_none(), "{provider:?}");
        }
        assert!(POLICIES.kimi.config.is_none());
        for provider in [NativeProvider::Grok, NativeProvider::Kimi] {
            assert!(provider.policy().unwrap().model_catalog.is_none());
        }
    }

    /// A provider runs only on a passed loopback probe of exactly what this
    /// build ships. Kimi, Codex and Grok passed on October 4.
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
        assert!(codex.inherited_env_keys().is_empty());
    }

    #[test]
    fn codex_process_env_carries_config_mode_and_home() {
        let dir = Path::new(r"C:\distill\benchmarks\runtime\codex-acp");
        let catalog = dir.join("model-catalogs").join("0123456789abcdef.json");
        let env: HashMap<String, String> = NativeProvider::Codex
            .process_env(
                dir,
                Some(Path::new("ignored-home")),
                Some(Path::new("ignored-sign-in")),
                Some(&catalog),
            )
            .into_iter()
            .collect();
        assert_eq!(env["INITIAL_AGENT_MODE"], "read-only");
        let os_home = dir.join("os-home").to_string_lossy().into_owned();
        for redirected in ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"] {
            assert_eq!(env[redirected], os_home, "{redirected}");
        }
        let config: Value = serde_json::from_str(&env["CODEX_CONFIG"]).unwrap();
        assert_eq!(
            config["model_instructions_file"],
            dir.join("instructions.md").to_string_lossy().as_ref()
        );
        // The adapter starts the CLI with the catalog it names.
        assert_eq!(
            config["model_catalog_json"],
            catalog.to_string_lossy().as_ref()
        );
        let mut without_files = config.as_object().unwrap().clone();
        without_files.remove("model_instructions_file");
        without_files.remove("model_catalog_json");
        assert_eq!(&without_files, POLICIES.codex.config.as_ref().unwrap());
        let uncatalogued: Value = serde_json::from_str(
            &NativeProvider::Codex
                .process_env(dir, None, None, None)
                .into_iter()
                .find(|(key, _)| key == "CODEX_CONFIG")
                .unwrap()
                .1,
        )
        .unwrap();
        assert!(uncatalogued.get("model_catalog_json").is_none());
        // The account's home and key come from the account environment.
        let mut keys: Vec<&str> = env.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "APPDATA",
                "CODEX_CONFIG",
                "HOME",
                "INITIAL_AGENT_MODE",
                "LOCALAPPDATA",
                "USERPROFILE"
            ]
        );
        assert!(NativeProvider::Claude
            .process_env(dir, None, None, Some(&catalog))
            .is_empty());
    }

    #[test]
    fn codex_rejects_ultra_effort() {
        let workspace = tempfile::tempdir().unwrap();
        let mut ultra = request("codex-acp");
        ultra.cwd = workspace.path().to_string_lossy().into_owned();
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
    fn codex_workspace_with_its_own_configuration_is_refused() {
        let workspace = tempfile::tempdir().unwrap();
        let mut codex = request("codex-acp");
        codex.cwd = workspace.path().to_string_lossy().into_owned();
        let refused: Result<NativeProvider, String> = Err(
            "capability_missing: the benchmark workspace has its own Codex configuration".into(),
        );
        // Project skills are injected when the task names them.
        std::fs::create_dir_all(workspace.path().join(".agents").join("skills")).unwrap();
        assert_eq!(validate_request(&codex), refused);
        std::fs::remove_dir_all(workspace.path().join(".agents")).unwrap();
        assert_eq!(validate_request(&codex), Ok(NativeProvider::Codex));
        std::fs::create_dir(workspace.path().join(".codex")).unwrap();
        assert_eq!(validate_request(&codex), refused);
        // Claude reads no Codex project layer.
        let mut claude = codex.clone();
        claude.provider_id = "claude-acp".into();
        assert_eq!(validate_request(&claude), Ok(NativeProvider::Claude));
    }

    #[test]
    fn codex_home_preflight_rejects_instructions_hooks_and_unknown_config() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(codex_home_preflight(home.path()), Ok(()));
        std::fs::write(
            home.path().join("config.toml"),
            "cli_auth_credentials_store = \"file\"\n",
        )
        .unwrap();
        assert_eq!(codex_home_preflight(home.path()), Ok(()));
        for entry in ["AGENTS.md", "AGENTS.override.md", "hooks.json"] {
            std::fs::write(home.path().join(entry), "context").unwrap();
            assert!(
                codex_home_preflight(home.path())
                    .unwrap_err()
                    .contains("global instructions or hooks"),
                "{entry}"
            );
            std::fs::remove_file(home.path().join(entry)).unwrap();
        }
        std::fs::create_dir(home.path().join("hooks")).unwrap();
        assert!(codex_home_preflight(home.path()).is_err());
        std::fs::remove_dir(home.path().join("hooks")).unwrap();
        // The bundled skills every account home has are turned off by the
        // policy; a skill of the account's own is not.
        let system = home.path().join("skills").join(".system").join("imagegen");
        std::fs::create_dir_all(&system).unwrap();
        std::fs::write(system.join("SKILL.md"), "bundled").unwrap();
        assert_eq!(codex_home_preflight(home.path()), Ok(()));
        let own = home.path().join("skills").join("personal");
        std::fs::create_dir(&own).unwrap();
        assert_eq!(
            codex_home_preflight(home.path()),
            Err("capability_missing: The account's Codex home has skills of its own; benchmarks need a clean account home".into())
        );
        std::fs::remove_dir(&own).unwrap();
        std::fs::write(
            home.path().join("config.toml"),
            "cli_auth_credentials_store = \"file\"\ndeveloper_instructions = \"x\"\n[mcp_servers.tool]\ncommand = \"tool\"\n",
        )
        .unwrap();
        assert_eq!(
            codex_home_preflight(home.path()),
            Err("capability_missing: the account's Codex configuration sets developer_instructions, mcp_servers; benchmarks need one with only the credential store".into())
        );
        std::fs::write(home.path().join("config.toml"), "not = [toml").unwrap();
        assert!(codex_home_preflight(home.path())
            .unwrap_err()
            .contains("not valid TOML"));
    }

    /// codex.exe reads personal skills from the profile the operating system
    /// names, which the redirected home does not move; a task naming one
    /// would carry the skill to the vendor.
    #[test]
    fn codex_is_refused_while_the_user_profile_has_personal_skills() {
        let profile = tempfile::tempdir().unwrap();
        assert_eq!(codex_user_skills_preflight(Some(profile.path())), Ok(()));
        let skills = profile.path().join(".agents").join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        assert_eq!(codex_user_skills_preflight(Some(profile.path())), Ok(()));
        std::fs::create_dir(skills.join("caveman")).unwrap();
        let refusal = codex_user_skills_preflight(Some(profile.path())).unwrap_err();
        assert!(refusal.starts_with("capability_missing: "), "{refusal}");
        assert!(refusal.contains(&skills.display().to_string()), "{refusal}");
        std::fs::remove_dir(skills.join("caveman")).unwrap();
        // A skills path Codex cannot be shown to ignore is refused too.
        std::fs::remove_dir(&skills).unwrap();
        std::fs::write(&skills, "not a folder").unwrap();
        assert!(codex_user_skills_preflight(Some(profile.path())).is_err());
        assert!(codex_user_skills_preflight(None).is_err());
    }

    #[test]
    fn codex_runtime_directory_holds_the_instructions_and_an_empty_home() {
        let root = tempfile::tempdir().unwrap();
        let dir = root
            .path()
            .join("benchmarks")
            .join("runtime")
            .join("codex-acp");
        prepare_owned_runtime(NativeProvider::Codex, root.path(), &dir).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("instructions.md")).unwrap(),
            SYSTEM_PROMPT
        );
        assert_eq!(std::fs::read_dir(dir.join("os-home")).unwrap().count(), 0);
        // A changed file is replaced; nothing else is left behind.
        std::fs::write(dir.join("instructions.md"), "Be someone else.").unwrap();
        prepare_owned_runtime(NativeProvider::Codex, root.path(), &dir).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("instructions.md")).unwrap(),
            SYSTEM_PROMPT
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        // An empty skills folder adds nothing; a skill in it refuses the launch.
        let skills = dir.join("os-home").join(".agents").join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        prepare_owned_runtime(NativeProvider::Codex, root.path(), &dir).unwrap();
        std::fs::create_dir(skills.join("personal")).unwrap();
        assert!(
            prepare_owned_runtime(NativeProvider::Codex, root.path(), &dir)
                .unwrap_err()
                .contains("gained skills")
        );
        // Claude runs without one.
        let claude = root
            .path()
            .join("benchmarks")
            .join("runtime")
            .join("claude-acp");
        prepare_owned_runtime(NativeProvider::Claude, root.path(), &claude).unwrap();
        assert!(!claude.exists());
    }

    /// A cached model list shaped like the one codex 0.155.1 writes: a
    /// Responses Lite model that declares code mode, extra tools and
    /// subagents, and a classic one.
    fn codex_models_cache(home: &Path) {
        let cache = json!({
            "fetched_at": "2026-10-04T09:13:14Z",
            "etag": null,
            "client_version": "0.155.1",
            "identity": "account identity",
            "models": [
                {
                    "slug": "gpt-6-sol",
                    "display_name": "GPT-6-Sol",
                    "tool_mode": "code_mode_only",
                    "experimental_supported_tools": ["send_user_message_async", "clock"],
                    "apply_patch_tool_type": "freeform",
                    "use_responses_lite": true,
                    "multi_agent_version": "v2",
                    "supported_reasoning_levels": [{"effort": "max"}, {"effort": "ultra"}],
                },
                {
                    "slug": "gpt-5.5",
                    "display_name": "GPT-5.5",
                    "experimental_supported_tools": [],
                    "apply_patch_tool_type": "freeform",
                    "use_responses_lite": false,
                },
            ],
        });
        std::fs::write(home.join("models_cache.json"), cache.to_string()).unwrap();
    }

    #[test]
    fn codex_model_catalog_removes_the_tools_models_declare() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            codex_model_catalog(home.path()),
            Err("capability_missing: the account's Codex model list is not cached yet; open a Codex chat with this account once".into())
        );
        codex_models_cache(home.path());
        let catalog: Value =
            serde_json::from_str(&codex_model_catalog(home.path()).unwrap()).unwrap();
        // Only the model list goes into the catalog.
        assert_eq!(
            catalog.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["models"]
        );
        let models = catalog["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        for model in models {
            assert_eq!(model["tool_mode"], Value::Null, "{model}");
            assert!(model.as_object().unwrap().contains_key("tool_mode"));
            assert_eq!(model["experimental_supported_tools"], json!([]), "{model}");
            assert_eq!(model["apply_patch_tool_type"], Value::Null, "{model}");
        }
        // Everything else the server said about a model is kept.
        assert_eq!(models[0]["slug"], "gpt-6-sol");
        assert_eq!(models[0]["display_name"], "GPT-6-Sol");
        assert_eq!(models[0]["use_responses_lite"], true);
        assert_eq!(models[0]["multi_agent_version"], "v2");
        assert_eq!(
            models[0]["supported_reasoning_levels"],
            json!([{"effort": "max"}, {"effort": "ultra"}])
        );
        assert_eq!(models[1]["use_responses_lite"], false);
        for broken in ["not json", "{}", r#"{"models": []}"#, r#"{"models": [1]}"#] {
            std::fs::write(home.path().join("models_cache.json"), broken).unwrap();
            assert_eq!(
                codex_model_catalog(home.path()),
                Err(
                    "capability_missing: the account's Codex model list is not one the CLI wrote"
                        .into()
                ),
                "{broken}"
            );
        }
    }

    #[test]
    fn codex_model_catalog_is_written_per_account_in_the_runtime_directory() {
        let root = tempfile::tempdir().unwrap();
        let dir = root
            .path()
            .join("benchmarks")
            .join("runtime")
            .join("codex-acp");
        let home = tempfile::tempdir().unwrap();
        codex_models_cache(home.path());
        let first =
            prepare_codex_model_catalog(root.path(), &dir, "account-1", home.path()).unwrap();
        let second =
            prepare_codex_model_catalog(root.path(), &dir, "account-2", home.path()).unwrap();
        assert_eq!(first.parent(), Some(dir.join("model-catalogs").as_path()));
        assert_eq!(
            first.file_name().unwrap().to_string_lossy(),
            format!("{}.json", &digest("account-1")[..16])
        );
        assert_ne!(first, second);
        assert_eq!(
            std::fs::read_to_string(&first).unwrap(),
            codex_model_catalog(home.path()).unwrap()
        );
        // An account whose list is not cached starts nothing.
        let uncached = tempfile::tempdir().unwrap();
        assert!(
            prepare_codex_model_catalog(root.path(), &dir, "account-3", uncached.path())
                .unwrap_err()
                .contains("not cached yet")
        );
        assert_eq!(
            std::fs::read_dir(dir.join("model-catalogs"))
                .unwrap()
                .count(),
            2
        );
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
        assert_eq!(
            codex.profile_key(),
            digest("native_text_v1:codex:codex-acp:1.13.0:cli:0.155.1")
        );
        assert_ne!(codex.profile_key(), NativeProvider::Claude.profile_key());
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
        assert_eq!(grok.launch_args(), ["agent", "--no-leader", "stdio"]);
        // The policy hash covers the session policy; the route names the build.
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
        assert_eq!(
            grok.profile_key(),
            digest("native_text_v1:grok:grok:1.0.40")
        );
    }

    #[test]
    fn grok_process_env_redirects_homes_and_disables_side_features() {
        let dir = Path::new(r"C:\distill\benchmarks\runtime\grok-acp");
        let sign_in = OwnedSignIn::path_in(dir);
        let env: HashMap<String, String> = NativeProvider::Grok
            .process_env(dir, None, Some(&sign_in), None)
            .into_iter()
            .collect();
        for (key, value) in &POLICIES.grok.env {
            assert_eq!(&env[key], value, "{key}");
        }
        for side in [
            "GROK_DISABLE_AUTOUPDATER",
            "GROK_BACKEND_SEARCH",
            "GROK_WEB_FETCH",
            "GROK_SUBAGENTS",
            "GROK_MEMORY",
            "GROK_TITLE_REFRESH",
            "GROK_TURN_SUMMARY",
            "GROK_SESSION_RECAP",
            "GROK_CLAUDE_HOOKS_ENABLED",
            "GROK_CLAUDE_RULES_ENABLED",
        ] {
            assert!(env.contains_key(side), "{side}");
        }
        assert_eq!(env["GROK_HOME"], dir.join("home").to_string_lossy());
        let os_home = dir.join("os-home").to_string_lossy().into_owned();
        for redirected in ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"] {
            assert_eq!(env[redirected], os_home, "{redirected}");
        }
        // The environment names the sign-in file, outside the private home,
        // and carries no token; `GROK_AUTH` is not used.
        assert_eq!(env["GROK_AUTH_PATH"], sign_in.to_string_lossy());
        assert!(sign_in.starts_with(dir.join("sign-in")));
        assert!(!env.contains_key("GROK_AUTH"));
        let without: HashMap<String, String> = NativeProvider::Grok
            .process_env(dir, None, None, None)
            .into_iter()
            .collect();
        assert!(!without.contains_key("GROK_AUTH_PATH"));
        assert_eq!(NativeProvider::Grok.inherited_env_keys(), ["XAI_API_KEY"]);
        // Each start reads a file of its own.
        assert_ne!(OwnedSignIn::path_in(dir), sign_in);
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

    #[test]
    fn grok_sign_in_file_lives_only_while_its_bridge_starts() {
        let root = tempfile::tempdir().unwrap();
        let dir = root
            .path()
            .join("benchmarks")
            .join("runtime")
            .join("grok-acp");
        let path = OwnedSignIn::path_in(&dir);
        let written =
            OwnedSignIn::write(root.path(), &path, r#"{"fabricated":"session"}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"fabricated":"session"}"#
        );
        assert!(!path.starts_with(dir.join("home")));
        // A bridge stopping meanwhile leaves the file its successor reads.
        discard_owned_sign_in(NativeProvider::Grok, &dir).unwrap();
        assert!(path.exists());
        drop(written);
        assert!(!path.exists());
        // What a Distill stopped mid-start left is removed before the next
        // start.
        std::fs::write(OwnedSignIn::path_in(&dir), "{}").unwrap();
        prepare_owned_runtime(NativeProvider::Grok, root.path(), &dir).unwrap();
        assert_eq!(std::fs::read_dir(dir.join("sign-in")).unwrap().count(), 0);
        // Nothing is written outside the Distill root.
        let elsewhere = tempfile::tempdir().unwrap();
        assert!(
            OwnedSignIn::write(root.path(), &OwnedSignIn::path_in(elsewhere.path()), "{}").is_err()
        );
    }

    /// A Distill stopped while a Grok bridge started leaves its sign-in on
    /// disk; the host removes it when it starts again or quits, without
    /// waiting for another Grok benchmark.
    #[test]
    fn sign_ins_left_on_disk_go_without_a_grok_spawn() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("benchmarks").join("runtime");
        // Nothing there yet is not an error.
        discard_left_sign_ins(&runtime).unwrap();
        let dir = runtime.join("grok-acp");
        let left = OwnedSignIn::path_in(&dir);
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
    }

    #[test]
    fn grok_private_home_refuses_instruction_sources() {
        let root = tempfile::tempdir().unwrap();
        let dir = root
            .path()
            .join("benchmarks")
            .join("runtime")
            .join("grok-acp");
        let grok = NativeProvider::Grok;
        prepare_owned_runtime(grok, root.path(), &dir).unwrap();
        let home = dir.join("home");
        let config = POLICIES.grok.config_toml.as_deref().unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("config.toml")).unwrap(),
            config
        );
        assert!(toml::from_str::<toml::Table>(config).is_ok());
        assert_eq!(std::fs::read_dir(dir.join("os-home")).unwrap().count(), 0);
        // Grok's own runtime files and empty directories are kept; a changed
        // configuration is rewritten. Grok creates its plugin registry lock
        // on every start.
        std::fs::create_dir_all(home.join("sessions").join("one")).unwrap();
        std::fs::create_dir(home.join("skills")).unwrap();
        std::fs::create_dir(home.join("installed-plugins")).unwrap();
        std::fs::write(home.join("installed-plugins").join("registry.lock"), "").unwrap();
        std::fs::write(home.join("config.toml"), "[subagents]\nenabled = true\n").unwrap();
        prepare_owned_runtime(grok, root.path(), &dir).unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("config.toml")).unwrap(),
            config
        );
        assert!(home.join("sessions").join("one").exists());
        for (entry, file) in [
            ("AGENTS.md", None),
            ("hooks", Some("x.json")),
            ("skills", Some("SKILL.md")),
            ("rules", Some("x.md")),
            ("mcp_credentials.json", None),
            ("installed-plugins", Some("hostile")),
            // More hook files, and a folder trusted to load its own context.
            ("hooks-paths", None),
            ("trusted_folders.toml", None),
        ] {
            let path = home.join(entry);
            match file {
                Some(file) => {
                    std::fs::create_dir_all(&path).unwrap();
                    std::fs::write(path.join(file), "hostile").unwrap();
                }
                None => std::fs::write(&path, "hostile").unwrap(),
            }
            // A home that is refused keeps no sign-in copy either.
            std::fs::write(home.join("auth.json"), "{}").unwrap();
            let refused = prepare_owned_runtime(grok, root.path(), &dir).unwrap_err();
            assert!(
                refused.starts_with("capability_missing: Grok's private benchmark home gained"),
                "{entry}: {refused}"
            );
            assert!(!home.join("auth.json").exists(), "{entry}");
            match file {
                Some(_) => std::fs::remove_dir_all(&path).unwrap(),
                None => std::fs::remove_file(&path).unwrap(),
            }
        }
        // A sign-in copy Grok left behind is removed before the next launch,
        // and only that file.
        std::fs::write(home.join("auth.json"), "{}").unwrap();
        std::fs::write(home.join("auth.json.lock"), "").unwrap();
        prepare_owned_runtime(grok, root.path(), &dir).unwrap();
        assert!(!home.join("auth.json").exists());
        assert!(home.join("auth.json.lock").exists());
        discard_owned_sign_in(grok, &dir).unwrap();
        std::fs::write(home.join("auth.json"), "{}").unwrap();
        discard_owned_sign_in(NativeProvider::Codex, &dir).unwrap();
        assert!(home.join("auth.json").exists());
        discard_owned_sign_in(grok, &dir).unwrap();
        assert!(!home.join("auth.json").exists());
    }

    #[test]
    fn grok_runtime_requires_the_verified_build() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("grok.exe");
        let runtime = RuntimePaths {
            entrypoint: &executable,
            native_cli: None,
        };
        let grok = NativeProvider::Grok;
        assert_eq!(
            grok.verify_runtime(&runtime),
            Err("capability_missing: pinned Grok benchmark runtime is unavailable".into())
        );
        std::fs::write(&executable, "another grok build").unwrap();
        assert_eq!(
            grok.verify_runtime(&runtime),
            Err("capability_missing: installed Grok runtime changed; benchmark profile requires verification".into())
        );
        assert_eq!(
            grok.pinned_digests(&runtime),
            vec![("executable", Some(digest("another grok build")))]
        );
    }

    /// The npm layout a `kimi.cmd` shim runs: the package under
    /// `node_modules` beside it.
    fn kimi_install(prefix: &Path, bundle: &str) -> PathBuf {
        let shim = prefix.join("kimi.cmd");
        std::fs::write(&shim, "@ECHO off").unwrap();
        let dist = prefix
            .join("node_modules")
            .join("@moonshot-ai")
            .join("kimi-code")
            .join("dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("main.mjs"), bundle).unwrap();
        shim
    }

    #[test]
    fn kimi_entrypoint_resolves_main_from_the_npm_shim() {
        let prefix = tempfile::tempdir().unwrap();
        let shim = kimi_install(prefix.path(), "another kimi build");
        let main = kimi_entrypoint(&shim).unwrap();
        assert_eq!(
            main,
            prefix
                .path()
                .join("node_modules")
                .join("@moonshot-ai")
                .join("kimi-code")
                .join("dist")
                .join("main.mjs")
        );
        // The pin covers the bundle the shim runs, not the shim.
        let kimi = NativeProvider::Kimi;
        let runtime = RuntimePaths {
            entrypoint: &main,
            native_cli: None,
        };
        assert_eq!(
            kimi.verify_runtime(&runtime),
            Err("capability_missing: installed Kimi Code runtime changed; benchmark profile requires verification".into())
        );
        assert_eq!(
            kimi.pinned_digests(&runtime),
            vec![("entrypoint", Some(digest("another kimi build")))]
        );
        // A native install has no package beside it.
        let native = tempfile::tempdir().unwrap();
        let executable = native.path().join("kimi.exe");
        std::fs::write(&executable, "native build").unwrap();
        assert_eq!(
            kimi_entrypoint(&executable),
            Err("capability_missing: Kimi Code is not a recognized npm install".into())
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
        assert_eq!(
            kimi.profile_key(),
            digest("native_text_v1:kimi:kimi-code:2.1.0")
        );
        let request = request("kimi-acp");
        assert_ne!(
            kimi.policy_hash(&request).unwrap(),
            NativeProvider::Codex.policy_hash(&request).unwrap()
        );
    }

    #[test]
    fn kimi_process_env_keeps_the_kimi_home_and_redirects_the_os_home() {
        let dir = Path::new(r"C:\distill\benchmarks\runtime\kimi-acp");
        let home = Path::new(r"C:\Users\someone\.kimi-code");
        let env: HashMap<String, String> = NativeProvider::Kimi
            .process_env(
                dir,
                Some(home),
                Some(Path::new("ignored-sign-in")),
                Some(Path::new("ignored-catalog")),
            )
            .into_iter()
            .collect();
        let os_home = dir.join("os-home").to_string_lossy().into_owned();
        // The environment the policy probe passed in: the user's Kimi home,
        // and the OS home and application data folders empty.
        for redirected in ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"] {
            assert_eq!(env[redirected], os_home, "{redirected}");
        }
        assert_eq!(env["KIMI_CODE_HOME"], home.to_string_lossy());
        assert_eq!(env["KIMI_CODE_NO_AUTO_UPDATE"], "1");
        let mut keys: Vec<&str> = env.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "APPDATA",
                "HOME",
                "KIMI_CODE_HOME",
                "KIMI_CODE_NO_AUTO_UPDATE",
                "LOCALAPPDATA",
                "USERPROFILE"
            ]
        );
        // The user's own Kimi home and endpoints pass through, as in chats.
        for key in ["KIMI_CODE_HOME", "KIMI_API_KEY", "KIMI_CODE_BASE_URL"] {
            assert!(NativeProvider::Kimi.inherited_env_keys().contains(&key));
        }
        // Its runtime directory is the empty OS home alone.
        let root = tempfile::tempdir().unwrap();
        let runtime = root
            .path()
            .join("benchmarks")
            .join("runtime")
            .join("kimi-acp");
        prepare_owned_runtime(NativeProvider::Kimi, root.path(), &runtime).unwrap();
        assert_eq!(std::fs::read_dir(&runtime).unwrap().count(), 1);
        assert_eq!(
            std::fs::read_dir(runtime.join("os-home")).unwrap().count(),
            0
        );
    }

    #[test]
    fn kimi_home_follows_kimi_code_home_then_the_os_home() {
        let env = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect()
        };
        assert_eq!(
            kimi_home(&env(&[
                ("USERPROFILE", r"C:\Users\someone"),
                ("KIMI_CODE_HOME", r"D:\kimi")
            ])),
            Some(PathBuf::from(r"D:\kimi"))
        );
        assert_eq!(
            kimi_home(&env(&[
                ("USERPROFILE", r"C:\Users\someone"),
                ("KIMI_CODE_HOME", " ")
            ])),
            Some(Path::new(r"C:\Users\someone").join(".kimi-code"))
        );
        assert_eq!(kimi_home(&env(&[])), None);
    }

    #[test]
    fn a_file_digest_follows_the_file_it_names() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runtime.bin");
        std::fs::write(&path, "first build").unwrap();
        let first = file_digest(&path).unwrap();
        assert_eq!(first, digest("first build"));
        assert_eq!(file_digest(&path).unwrap(), first);
        std::fs::write(&path, "second, longer build").unwrap();
        assert_eq!(file_digest(&path).unwrap(), digest("second, longer build"));
        assert!(file_digest(&directory.path().join("missing")).is_err());
    }
}
