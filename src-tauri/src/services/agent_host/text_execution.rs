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
    let mut status = sandbox::ready().await.map_err(admission_error)?;
    status
        .require_account(provider.key(), account)
        .map_err(|e| format!("capability_missing: {e}"))?;
    let artifacts = require_proof(provider, &status).await?;
    // The baseline manifest can pin a JS launcher while the process uses an
    // ELF executable below it. Preserve that executable identity in every
    // model inventory and durable receipt, not only in the proof gate.
    status.revision = execution::digest(execution::canonical_json(&json!({
        "sandbox": status.revision, "nativeArtifacts": artifacts,
    })));
    Ok(status)
}

pub(crate) async fn require_proof(
    provider: NativeProvider,
    status: &sandbox::Status,
) -> Result<Value, String> {
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

pub(crate) async fn prepare(owner: &str) -> Result<(), String> {
    let id = attempt_id(owner);
    // Only an owner with no live bridge/dispatch reaches preparation. A prior
    // failed handshake may have left an empty workspace or credential copy.
    sandbox::clean(&id).await.map_err(admission_error)?;
    let archive = tar::Builder::new(Vec::new())
        .into_inner()
        .map_err(|e| e.to_string())?;
    sandbox::copy(&id, &archive).await.map_err(admission_error)
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
    if let Some(adapter) = adapter(provider) {
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
            NativeProvider::Grok => unreachable!(),
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
