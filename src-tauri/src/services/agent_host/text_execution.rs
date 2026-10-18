//! Tool-free owned execution in the dedicated Linux sandbox. Location and
//! permissions are independent: this never selects the repository tool policy.
use super::{
    bridge::OwnedLaunch,
    execution::{self, NativeProvider, OwnedSessionRequest},
};
use crate::services::benchmark_sandbox as sandbox;
use base64::Engine;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::LazyLock, time::Duration};

const BOOTSTRAP: &str = include_str!("../../../resources/benchmark-linux-text-bootstrap.mjs");
const KIMI: &str = include_str!("../../../resources/benchmark-linux-text-kimi.mjs");
const ATTESTATION: &str = include_str!("../../../resources/benchmark-linux-text-attestation.py");
const POLICIES: &str = include_str!("../../../resources/benchmark-native-policies.json");
pub(crate) const RECIPE: &str = "linux-native-text-v1";

fn admission_error(error: impl std::fmt::Display) -> String {
    let message = error.to_string();
    if let Some(start) = message.find("resource_busy:") {
        message[start..].to_owned()
    } else {
        format!("capability_missing: {message}")
    }
}

pub(crate) fn attempt_id(owner: &str) -> String {
    format!("text-{}", execution::digest(owner))
}

pub(super) fn profile_key(owner: &str) -> String {
    format!("text:{}", execution::digest(owner))
}

pub(super) fn is_route(profile: &str) -> bool {
    profile.starts_with("text:")
}

fn adapter(provider: NativeProvider) -> Option<&'static str> {
    if provider == NativeProvider::Kimi {
        Some(KIMI)
    } else {
        provider.adapter()
    }
}

/// Shared with scripts/benchmark-linux-text-policy-probe.mjs. The Windows
/// resource is policy input only, never evidence that Linux has been probed.
/// Including launcher source makes changes to environment, permissions and
/// handshake behavior invalidate the local proof as well as adapter edits.
pub(crate) fn policy_fingerprint(provider: NativeProvider) -> String {
    static FINGERPRINTS: LazyLock<BTreeMap<&'static str, String>> = LazyLock::new(|| {
        NativeProvider::ALL
            .iter()
            .map(|&provider| (provider.key(), calculate_policy_fingerprint(provider)))
            .collect()
    });
    FINGERPRINTS[provider.key()].clone()
}

fn calculate_policy_fingerprint(provider: NativeProvider) -> String {
    execution::digest(execution::canonical_json(&json!({
        "recipe": RECIPE,
        "provider": provider.key(),
        "policies": serde_json::from_str::<Value>(POLICIES).expect("native policies"),
        "adapter": adapter(provider),
        "bootstrap": BOOTSTRAP,
        "attestation": ATTESTATION,
        "launcher": include_str!("text_execution.rs"),
        "contract": include_str!("execution.rs"),
        "router": include_str!("router.rs"),
    })))
}

pub(crate) fn revision(provider: NativeProvider, status: &sandbox::Status) -> String {
    execution::digest(execution::canonical_json(&json!({
        "profile": RECIPE, "sandbox": status.revision,
        "policy": policy_fingerprint(provider),
    })))
}

pub(crate) fn policy_hash(request: &OwnedSessionRequest, revision: &str) -> Result<String, String> {
    serde_json::to_vec(&json!({"request":request,"textRuntimeRevision":revision}))
        .map(execution::digest)
        .map_err(|error| error.to_string())
}

pub(crate) async fn readiness(
    provider: NativeProvider,
    account: &str,
) -> Result<sandbox::Status, String> {
    let status = sandbox::ready().await.map_err(admission_error)?;
    status
        .require_account(provider.key(), account)
        .map_err(|e| format!("capability_missing: {e}"))?;
    let artifacts = require_proof(provider, &status).await?;
    Ok(with_artifacts(status, &artifacts))
}

/// What a sign-in renewal session starts on: the runtime [`readiness`] proves,
/// for an account whose sandbox OAuth grant its CLI can renew, still current
/// or already expired, with that grant's expiry. A renewal makes no model
/// call, and every session after it passes the unchanged admission window.
///
/// It always observes the sandbox afresh, never sharing an earlier
/// observation: the expiry it reads after a renewal session must be the
/// grant that session saved, and the readiness checks after it then share
/// this observation.
pub(crate) async fn renewal_readiness(
    provider: NativeProvider,
    account: &str,
) -> Result<(sandbox::Status, i64), String> {
    let status = sandbox::observe_now().await.map_err(admission_error)?;
    let expiry = status.oauth_expiry(provider.key(), account).ok_or_else(|| {
        format!(
            "capability_missing: The {} account {account} has no sandbox sign-in to renew; run bench-login in {}",
            provider.key(),
            sandbox::DISTRIBUTION
        )
    })?;
    let artifacts = require_proof(provider, &status).await?;
    Ok((with_artifacts(status, &artifacts), expiry))
}

/// Whether `provider`'s sandbox sign-in renews early, before a session needs
/// it: Grok's in a renewal session (see [`renewal_env`]); Claude's by
/// `bench-login claude ACCOUNT --renew`, which hands the grant's own stored
/// refresh token to `claude auth login`, since the Claude CLI itself renews
/// only in the last five minutes of a sign-in, a window admission keeps every
/// session out of. Codex and Kimi renew inside their sessions, and admission
/// checks no expiry of theirs; a Z.ai key does not expire.
pub(crate) fn renews_sign_in(provider: NativeProvider) -> bool {
    renewal_env(provider, 0, 0).is_some() || provider == NativeProvider::Claude
}

/// What starts `provider`'s CLI so that it renews the sandbox sign-in that
/// expires at `expires_at_ms` before its first request, at `now`. Only Grok
/// has such a setting (Claude renews by a sign-in command instead, see
/// [`renews_sign_in`]).
pub(crate) fn renewal_env(
    provider: NativeProvider,
    expires_at_ms: i64,
    now: i64,
) -> Option<(String, String)> {
    (provider == NativeProvider::Grok).then(|| {
        crate::services::provider_rate_limits::grok::sandbox_renewal_env(expires_at_ms, now)
    })
}

fn with_artifacts(mut status: sandbox::Status, artifacts: &Value) -> sandbox::Status {
    // The baseline manifest can pin a JS launcher while the process uses an
    // ELF executable below it. Preserve that executable identity in every
    // model inventory and durable receipt, not only in the proof gate.
    status.revision = execution::digest(execution::canonical_json(&json!({
        "sandbox": status.revision, "nativeArtifacts": artifacts,
    })));
    status
}

/// Verified proofs by provider and sandbox revision. The revision covers
/// every executable a proof attests, so the checks of one preparation share
/// one verification within the same window as the sandbox status itself.
static PROOFS: sandbox::Recent<(&'static str, String), Value> =
    sandbox::Recent::new(sandbox::OBSERVATION_REUSE);

pub(crate) async fn require_proof(
    provider: NativeProvider,
    status: &sandbox::Status,
) -> Result<Value, String> {
    PROOFS
        .get((provider.key(), status.revision.clone()), false, || {
            verify_proof(provider, status)
        })
        .await
}

async fn verify_proof(provider: NativeProvider, status: &sandbox::Status) -> Result<Value, String> {
    let fingerprint = policy_fingerprint(provider);
    let output = sandbox::invoke_bounded(
        "/usr/local/sbin/bench-budget",
        &[
            "control",
            "--",
            "/usr/bin/python3",
            "-c",
            ATTESTATION,
            "verify",
            provider.key(),
            &status.revision,
            &fingerprint,
        ],
        None,
        8192,
        Duration::from_secs(15),
    )
    .await
    .map_err(admission_error)?;
    if !output.success() {
        return Err(admission_error(output.reason()));
    }
    if output.truncated {
        return Err("capability_missing: Linux text proof exceeded its bound".into());
    }
    serde_json::from_slice(&output.stdout).map_err(admission_error)
}

/// Clears the sandbox of `owner`'s attempt before its admission. Only an
/// owner with no live bridge/dispatch reaches this, and a prior failed
/// handshake may have left an empty workspace or credential copy. It comes
/// before the reservation, whose groups bench-clean would end.
pub(crate) async fn clear(owner: &str) -> Result<(), String> {
    sandbox::clean(&attempt_id(owner))
        .await
        .map_err(admission_error)
}

/// The admitted session's empty workspace, made only once the broker
/// reserved the session, so a refused retry prepares nothing. Its lease is
/// asked for within the session's pending lease; past that, the refusal is
/// the queue's and the session is asked for again.
pub(crate) async fn prepare(owner: &str) -> Result<(), String> {
    let archive = tar::Builder::new(Vec::new())
        .into_inner()
        .map_err(|e| e.to_string())?;
    sandbox::copy_within(&attempt_id(owner), &archive, sandbox::PENDING_PREPARATION)
        .await
        .map_err(admission_error)
}

fn environment(provider: NativeProvider) -> Vec<(String, String)> {
    let policies: Value = serde_json::from_str(POLICIES).expect("native policies");
    let mut env = vec![
        ("DISTILL_BENCH_RESOURCE_CLASS".into(), "text".into()),
        ("DISTILL_BENCH_TEXT_PROVIDER".into(), provider.key().into()),
        (
            "DISTILL_BENCH_INSTRUCTIONS".into(),
            execution::SYSTEM_PROMPT.into(),
        ),
    ];
    if let Some(values) = policies[provider.key()]["env"].as_object() {
        env.extend(values.iter().map(|(key, value)| {
            (
                key.clone(),
                value.as_str().expect("policy env string").into(),
            )
        }));
    }
    match provider {
        NativeProvider::Claude => {
            env.push(("CLAUDE_CONFIG_DIR".into(), "/tmp/provider".into()));
            env.push(("DISABLE_AUTOUPDATER".into(), "1".into()));
            env.push((
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
                "1".into(),
            ));
        }
        NativeProvider::Codex => {
            let mut config = policies["codex"]["config"].clone();
            config["model_instructions_file"] = json!("/tmp/repository-instructions.md");
            config["cli_auth_credentials_store"] = json!("file");
            env.push(("CODEX_CONFIG".into(), config.to_string()));
            env.push(("CODEX_HOME".into(), "/tmp/provider".into()));
            env.push((
                "DISTILL_BENCH_MODEL_CATALOG_POLICY".into(),
                policies["codex"]["modelCatalog"].to_string(),
            ));
        }
        NativeProvider::Grok => {
            env.push(("GROK_HOME".into(), "/home/candidate/.grok".into()));
            env.push(("GROK_AUTH_PATH".into(), "/tmp/provider/auth.json".into()));
            env.push((
                "DISTILL_BENCH_GROK_CONFIG".into(),
                policies["grok"]["configToml"]
                    .as_str()
                    .expect("Grok config")
                    .into(),
            ));
        }
        NativeProvider::Kimi => {
            env.push(("KIMI_CODE_HOME".into(), "/home/candidate/.kimi-code".into()));
        }
        NativeProvider::Zai => env.extend(super::zai::sandbox_env(
            &provider.policy_config().expect("Z.ai configuration"),
            adapter(provider).expect("Z.ai policy plugin"),
        )),
    }
    env
}

pub(super) fn launch(
    request: &OwnedSessionRequest,
    provider: NativeProvider,
    revision: String,
) -> OwnedLaunch {
    let id = attempt_id(&request.owner_id);
    let mut args = vec![
        "-d".into(),
        sandbox::DISTRIBUTION.into(),
        "-u".into(),
        "root".into(),
        "--exec".into(),
        "/usr/local/sbin/bench-run".into(),
        "session".into(),
        id.clone(),
        format!(
            "DISTILL_BENCH_ACCOUNT_HOME=/home/candidate/accounts/{}/{}",
            request.account_id,
            provider.key()
        ),
    ];
    args.extend(
        environment(provider)
            .into_iter()
            .map(|(key, value)| format!("{key}={value}")),
    );
    args.push("--".into());
    // OpenCode and Grok are native executables; the others are Node bridges
    // that load their adapter before their entrypoint.
    if provider == NativeProvider::Zai {
        args.extend(["/opt/distill-tools/bin/opencode", "acp"].map(str::to_owned));
    } else if let Some(adapter) = adapter(provider) {
        let adapter_url = format!(
            "data:text/javascript;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(adapter)
        );
        let preload = format!(
            "{BOOTSTRAP}\nawait import({});",
            serde_json::to_string(&adapter_url).expect("adapter URL")
        );
        args.extend([
            "/usr/local/bin/node".into(),
            "--import".into(),
            format!(
                "data:text/javascript;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(preload)
            ),
        ]);
        args.push(match provider {
            NativeProvider::Claude => "/opt/distill-tools/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
            NativeProvider::Codex => "/opt/distill-tools/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
            NativeProvider::Kimi => "/opt/distill-tools/kimi/node_modules/@moonshot-ai/kimi-code/dist/main.mjs",
            NativeProvider::Grok | NativeProvider::Zai => unreachable!(),
        }.into());
        if provider == NativeProvider::Kimi {
            args.push("acp".into());
        }
    } else {
        args.extend(
            [
                "/opt/distill-tools/bin/grok",
                "agent",
                "--no-leader",
                "stdio",
            ]
            .map(str::to_owned),
        );
    }
    OwnedLaunch {
        program: PathBuf::from("wsl.exe"),
        args,
        fingerprint_target: PathBuf::new(),
        sandbox: Some((id, revision)),
    }
}

/// [`launch`] for a sign-in renewal session: the same process, policy and
/// private copy of the account's sign-in, with `renewal` (from
/// [`renewal_env`]) in its environment. bench-clean saves the grant its CLI
/// renewed back to the account once the session is stopped.
pub(super) fn renewal_launch(
    request: &OwnedSessionRequest,
    provider: NativeProvider,
    revision: String,
    renewal: (String, String),
) -> OwnedLaunch {
    let mut launch = launch(request, provider, revision);
    let separator = launch
        .args
        .iter()
        .position(|arg| arg == "--")
        .expect("isolated launch command separator");
    launch
        .args
        .insert(separator, format!("{}={}", renewal.0, renewal.1));
    launch
}

#[cfg(test)]
mod tests {
    use super::super::execution::ExecutionProfile;
    use super::*;

    #[test]
    fn every_text_provider_uses_a_private_linux_launch_without_repository_tools() {
        for &provider in NativeProvider::ALL {
            let request = OwnedSessionRequest {
                owner_id: "invented-owner".into(),
                provider_id: provider.harness_id().into(),
                account_id: "invented-account".into(),
                model_id: "invented-model".into(),
                reasoning_effort: None,
                fast_mode: None,
                cwd: "/workspace".into(),
                title: "Synthetic text task".into(),
                profile: ExecutionProfile::NativeTextV1,
            };
            let launch = launch(&request, provider, "revision".into());
            assert_eq!(launch.program, PathBuf::from("wsl.exe"));
            assert!(launch
                .args
                .contains(&"DISTILL_BENCH_RESOURCE_CLASS=text".into()));
            assert!(
                !launch
                    .args
                    .iter()
                    .any(|arg| arg.contains("danger-full-access")
                        || arg.contains("agent-full-access"))
            );
            assert_eq!(
                launch.sandbox.as_ref().unwrap().0,
                attempt_id("invented-owner")
            );
            assert_ne!(profile_key("invented-owner"), profile_key("another-owner"));
            assert_eq!(policy_fingerprint(provider).len(), 64);
        }
    }

    /// A renewal session starts the same process on the same private copy of
    /// the account's sign-in, adding only the Grok CLI's renewal window; no
    /// benchmark session ever starts with that window.
    #[test]
    fn only_a_grok_renewal_session_starts_with_the_renewal_window() {
        let request = |provider: NativeProvider| OwnedSessionRequest {
            owner_id: "renewal:invented-owner".into(),
            provider_id: provider.harness_id().into(),
            account_id: "invented-account".into(),
            model_id: String::new(),
            reasoning_effort: None,
            fast_mode: None,
            cwd: "/workspace".into(),
            title: "Synthetic renewal".into(),
            profile: ExecutionProfile::NativeTextV1,
        };
        for &provider in NativeProvider::ALL {
            let plain = launch(&request(provider), provider, "revision".into());
            assert!(!plain
                .args
                .iter()
                .any(|arg| arg.starts_with("GROK_AUTH_EARLY_INVALIDATION_SECS=")));
            assert_eq!(
                renews_sign_in(provider),
                matches!(provider, NativeProvider::Grok | NativeProvider::Claude)
            );
            assert_eq!(
                renewal_env(provider, 1, 0).is_some(),
                provider == NativeProvider::Grok
            );
        }
        let now = 1_800_000_000_000;
        let renewal = renewal_env(NativeProvider::Grok, now + 3_600_000, now).unwrap();
        let grok = request(NativeProvider::Grok);
        let renewing = renewal_launch(&grok, NativeProvider::Grok, "revision".into(), renewal);
        let plain = launch(&grok, NativeProvider::Grok, "revision".into());
        let separator = renewing.args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(
            renewing.args[separator - 1],
            "GROK_AUTH_EARLY_INVALIDATION_SECS=3660"
        );
        let mut without = renewing.args.clone();
        without.remove(separator - 1);
        assert_eq!(without, plain.args);
        assert_eq!(renewing.sandbox.unwrap().0, plain.sandbox.unwrap().0);
        assert!(without.contains(
            &"DISTILL_BENCH_ACCOUNT_HOME=/home/candidate/accounts/invented-account/grok".into()
        ));
        assert!(without.contains(&"GROK_AUTH_PATH=/tmp/provider/auth.json".into()));
    }

    /// OpenCode runs as its own executable with the account's sandbox home,
    /// the policy configuration and plugin, and no key on its command line.
    #[test]
    fn zai_text_launch_runs_opencode_with_its_policy_and_no_secret() {
        let request = OwnedSessionRequest {
            owner_id: "invented-owner".into(),
            provider_id: "zai-acp".into(),
            account_id: "invented-account".into(),
            model_id: "zai-coding-plan/glm-5.3".into(),
            reasoning_effort: Some("high".into()),
            fast_mode: Some(false),
            cwd: "/workspace".into(),
            title: "Synthetic text task".into(),
            profile: ExecutionProfile::NativeTextV1,
        };
        let launch = launch(&request, NativeProvider::Zai, "revision".into());
        assert!(launch.args.contains(
            &"DISTILL_BENCH_ACCOUNT_HOME=/home/candidate/accounts/invented-account/zai".into()
        ));
        assert!(launch.args.ends_with(&[
            "--".into(),
            "/opt/distill-tools/bin/opencode".into(),
            "acp".into()
        ]));
        let env: BTreeMap<String, String> = environment(NativeProvider::Zai).into_iter().collect();
        assert_eq!(env["DISTILL_BENCH_RESOURCE_CLASS"], "text");
        assert_eq!(env["OPENCODE_DISABLE_MODELS_FETCH"], "true");
        assert_eq!(env["XDG_CONFIG_HOME"], "/tmp/opencode-config");
        assert_eq!(
            env["DISTILL_BENCH_OPENCODE_PLUGIN"],
            NativeProvider::Zai.adapter().unwrap()
        );
        let config: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
        assert_eq!(config, NativeProvider::Zai.policy_config().unwrap());
        assert!(!env.contains_key("DISTILL_ZAI_API_KEY"));
        // The Linux proof covers the plugin as its adapter.
        assert_eq!(adapter(NativeProvider::Zai), NativeProvider::Zai.adapter());
    }

    #[test]
    fn linux_policy_cannot_share_historical_windows_or_another_owner_identity() {
        let request = OwnedSessionRequest {
            owner_id: "synthetic-owner".into(),
            provider_id: "codex-acp".into(),
            account_id: "synthetic-account".into(),
            model_id: "synthetic-model".into(),
            reasoning_effort: Some("high".into()),
            fast_mode: Some(false),
            cwd: "/workspace".into(),
            title: "Synthetic".into(),
            profile: ExecutionProfile::NativeTextV1,
        };
        assert_ne!(
            policy_hash(&request, "linux-one").unwrap(),
            NativeProvider::Codex.policy_hash(&request).unwrap()
        );
        assert_ne!(
            policy_hash(&request, "linux-one").unwrap(),
            policy_hash(&request, "linux-two").unwrap()
        );
        let environment = environment(NativeProvider::Codex);
        let config: Value = serde_json::from_str(
            &environment
                .iter()
                .find(|(key, _)| key == "CODEX_CONFIG")
                .unwrap()
                .1,
        )
        .unwrap();
        assert_eq!(config["features"]["multi_agent"], false);
        assert_eq!(
            config["model_instructions_file"],
            "/tmp/repository-instructions.md"
        );
        assert_eq!(
            environment
                .iter()
                .find(|(key, _)| key == "CODEX_HOME")
                .unwrap()
                .1,
            "/tmp/provider"
        );
        assert_eq!(
            admission_error("Sandbox command: resource_busy: queued"),
            "resource_busy: queued"
        );
        // A preparation lease whose window closed in the queue stays a busy
        // refusal, never a missing capability.
        assert_eq!(
            admission_error(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "resource_busy: benchmark preparation queue expired before worker startup",
            )),
            "resource_busy: benchmark preparation queue expired before worker startup"
        );
    }
}
