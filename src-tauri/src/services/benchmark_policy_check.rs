//! Explicit, offline policy renewal from the app. Only bundled public probe
//! inputs enter the sandbox; no account, candidate artifact or paid model is used.
use super::{
    agent_host::{
        execution::{self, NativeProvider},
        text_execution,
    },
    benchmark_sandbox as sandbox,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

const ATTESTATION: &str = include_str!("../../resources/benchmark-linux-text-attestation.py");
const PREPARE: &str = include_str!("../../resources/benchmark-linux-text-probe-prepare.py");
const DEADLINE: Duration = Duration::from_secs(12 * 60);
static CHECK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// Preserve the paths the existing offline suites import, even in an installed
// app without a checkout or a host Node installation.
const INPUTS: &[(&str, &str)] = &[
    (
        "scripts/benchmark-native-policy-probe.mjs",
        include_str!("../../../scripts/benchmark-native-policy-probe.mjs"),
    ),
    (
        "scripts/benchmark-provider-policy-probe.mjs",
        include_str!("../../../scripts/benchmark-provider-policy-probe.mjs"),
    ),
    (
        "scripts/benchmark-linux-text-probe-entry.mjs",
        include_str!("../../../scripts/benchmark-linux-text-probe-entry.mjs"),
    ),
    (
        "src-tauri/src/services/agent_host/execution.rs",
        include_str!("agent_host/execution.rs"),
    ),
    (
        "src-tauri/resources/benchmark-native-policies.json",
        include_str!("../../resources/benchmark-native-policies.json"),
    ),
    (
        "src-tauri/resources/benchmark-claude-policy.mjs",
        include_str!("../../resources/benchmark-claude-policy.mjs"),
    ),
    (
        "src-tauri/resources/benchmark-codex-policy.mjs",
        include_str!("../../resources/benchmark-codex-policy.mjs"),
    ),
    (
        "src-tauri/resources/benchmark-kimi-policy.mjs",
        include_str!("../../resources/benchmark-kimi-policy.mjs"),
    ),
    (
        "src-tauri/resources/benchmark-linux-text-kimi.mjs",
        include_str!("../../resources/benchmark-linux-text-kimi.mjs"),
    ),
    (
        "src-tauri/resources/benchmark-linux-text-bootstrap.mjs",
        include_str!("../../resources/benchmark-linux-text-bootstrap.mjs"),
    ),
    (
        "src-tauri/resources/benchmark-zai-policy.mjs",
        include_str!("../../resources/benchmark-zai-policy.mjs"),
    ),
];

fn archive() -> Result<Vec<u8>, String> {
    let mut tar = tar::Builder::new(Vec::new());
    for (path, text) in INPUTS {
        let mut header = tar::Header::new_gnu();
        header.set_size(text.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, path, text.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    tar.into_inner().map_err(|e| e.to_string())
}

async fn call(
    program: &str,
    args: &[&str],
    input: Option<&[u8]>,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let out = sandbox::invoke_bounded(program, args, input, 256 * 1024, timeout)
        .await
        .map_err(|e| e.to_string())?;
    if !out.success() {
        return Err(format!("Sandbox check failed: {}", out.reason()));
    }
    if out.truncated {
        return Err("Sandbox check exceeded its output limit".into());
    }
    Ok(out.stdout)
}

async fn attest(args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut command = vec!["control", "--", "/usr/bin/python3", "-c", ATTESTATION];
    command.extend_from_slice(args);
    call(
        "/usr/local/sbin/bench-budget",
        &command,
        input,
        Duration::from_secs(120),
    )
    .await
}

fn decode(bytes: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("Invalid sandbox check report: {e}"))
}

fn receipt(
    provider: NativeProvider,
    revision: &str,
    artifacts: &Value,
    report: &Value,
    after_revision: &str,
    after_artifacts: &Value,
) -> Result<Value, String> {
    if report["status"] != "passed" || !report["checks"].as_array().is_some_and(|c| c.len() >= 5) {
        return Err("The offline sandbox policy check did not pass".into());
    }
    if revision != after_revision || artifacts != after_artifacts {
        return Err("The sandbox runtime changed during the check. Check again.".into());
    }
    Ok(json!({
        "schemaVersion": 1, "recipe": text_execution::RECIPE,
        "provider": provider.key(), "sandboxRevision": revision,
        "policyFingerprint": text_execution::policy_fingerprint(provider),
        "runtimeArtifacts": artifacts, "status": "passed",
        "qualifiedAt": chrono::Utc::now().to_rfc3339(),
        "probeReportHash": hex::encode(Sha256::digest(execution::canonical_json(report))),
    }))
}

pub(crate) async fn renew(provider: NativeProvider) -> Result<(), String> {
    let _lock = CHECK
        .try_lock()
        .map_err(|_| "resource_busy: a sandbox check is already running")?;
    let status = sandbox::observe_now().await.map_err(|e| e.to_string())?;
    let artifacts = decode(&attest(&["inspect", provider.key()], None).await?)?;
    let id = format!("policy-{}-{}", provider.key(), uuid::Uuid::new_v4());
    let mut cleanup = sandbox::Cleanup(Some(id.clone()));
    let result = async {
        call(
            "/usr/local/sbin/bench-budget",
            &["prep", &id, "--", "/usr/bin/python3", "-c", PREPARE, &id],
            Some(&archive()?),
            Duration::from_secs(120),
        )
        .await?;
        let installed = match provider {
            NativeProvider::Claude => {
                "/opt/distill-tools/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp"
            }
            NativeProvider::Codex => {
                "/opt/distill-tools/codex-acp/node_modules/@agentclientprotocol/codex-acp"
            }
            NativeProvider::Kimi => "/opt/distill-tools/kimi/node_modules/@moonshot-ai/kimi-code",
            NativeProvider::Grok => artifacts["grokNative"]["path"]
                .as_str()
                .ok_or("Missing Grok runtime")?,
            NativeProvider::Zai => artifacts["entrypoint"]["path"]
                .as_str()
                .ok_or("Missing Z.ai runtime")?,
        };
        let deadline = format!(
            "DISTILL_BENCH_DEADLINE_MS={}",
            chrono::Utc::now().timestamp_millis() + DEADLINE.as_millis() as i64
        );
        let native = format!("DISTILL_LINUX_PROBE_ARTIFACTS={artifacts}");
        let plugin = format!(
            "DISTILL_BENCH_OPENCODE_PLUGIN={}",
            provider.adapter().unwrap_or("")
        );
        let mut args = vec![
            "probe",
            &id,
            "DISTILL_BENCH_RESOURCE_CLASS=text",
            &deadline,
            "DISTILL_LINUX_POLICY_PROBE=offline-v1",
            &native,
        ];
        if provider == NativeProvider::Zai {
            args.push(&plugin);
        }
        args.extend([
            "--",
            "/usr/local/bin/node",
            "/workspace/scripts/benchmark-linux-text-probe-entry.mjs",
            provider.key(),
        ]);
        if provider == NativeProvider::Claude {
            args.push("/workspace/scripts/benchmark-native-policy-probe.mjs");
        } else {
            args.extend([
                "/workspace/scripts/benchmark-provider-policy-probe.mjs",
                provider.key(),
            ]);
        }
        args.extend([installed, "--linux-sandbox"]);
        let report = decode(&call("/usr/local/sbin/bench-run", &args, None, DEADLINE).await?)?;
        let after = sandbox::observe_now().await.map_err(|e| e.to_string())?;
        let after_artifacts = decode(&attest(&["inspect", provider.key()], None).await?)?;
        let proof = receipt(
            provider,
            &status.revision,
            &artifacts,
            &report,
            &after.revision,
            &after_artifacts,
        )?;
        let fingerprint = text_execution::policy_fingerprint(provider);
        attest(
            &["write", provider.key(), &status.revision, &fingerprint],
            Some(proof.to_string().as_bytes()),
        )
        .await?;
        // Read the protected receipt through the same gate used by dispatch.
        text_execution::require_proof(provider, &after).await?;
        Ok(())
    }
    .await;
    if sandbox::clean(&id).await.is_ok() {
        cleanup.0 = None;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_probe_contains_only_the_public_allowlist() {
        let bytes = archive().unwrap();
        let mut tar = tar::Archive::new(bytes.as_slice());
        let paths: Vec<_> = tar
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().into_owned())
            .collect();
        assert_eq!(paths.len(), INPUTS.len());
        for (path, (expected, _)) in paths.iter().zip(INPUTS) {
            assert_eq!(path.to_str().unwrap(), *expected);
            assert!(!path.is_absolute());
            assert!(!path
                .components()
                .any(|c| c == std::path::Component::ParentDir));
        }
    }

    #[test]
    fn receipt_requires_a_pass_and_unchanged_runtime() {
        let artifacts = json!({"entrypoint": {"sha256": "fixture"}});
        let report = json!({"status":"passed", "checks":["a","b","c","d","e"]});
        let make = |report: &Value, revision: &str, after: &Value| {
            receipt(
                NativeProvider::Zai,
                "revision",
                &artifacts,
                report,
                revision,
                after,
            )
        };
        assert!(make(&report, "revision", &artifacts).is_ok());
        assert!(make(
            &json!({"status":"failed", "checks":[1,2,3,4,5]}),
            "revision",
            &artifacts
        )
        .is_err());
        assert!(make(
            &json!({"status":"passed", "checks":[]}),
            "revision",
            &artifacts
        )
        .is_err());
        assert!(make(&report, "changed", &artifacts).is_err());
        assert!(make(&report, "revision", &json!({})).is_err());
    }
}
