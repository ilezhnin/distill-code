//! Linux-only bounded artifact evaluation. Expected values stay in the trusted
//! controller; candidate JavaScript executes only in sandboxed Chromium.
use super::{store::now, types::*};
use crate::services::benchmark_sandbox as sandbox;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::OnceLock, time::Duration};

const MAX_REQUEST: usize = 4 * 1024 * 1024;
const MAX_SCREENSHOT: usize = 2 * 1024 * 1024;
const MAX_ENVELOPE: usize = 3 * 1024 * 1024 + 262_144;

#[derive(Clone)]
pub struct WorkerRuntime {
    pub root: PathBuf,
}
static RUNTIME: OnceLock<WorkerRuntime> = OnceLock::new();

/// Local metadata only: startup neither boots WSL nor installs a renderer.
pub fn configure(app: &tauri::AppHandle) -> Result<()> {
    let root = crate::services::distill_root::app_root(app)
        .map_err(|error| BenchmarkError::new("storage_unavailable", error))?
        .join("benchmarks");
    let _ = RUNTIME.set(WorkerRuntime { root });
    Ok(())
}

pub fn available() -> bool {
    RUNTIME.get().is_some()
}

/// Deterministic renderer specification for frozen contracts. The helper also
/// verifies actual installed binaries/libraries/fonts against its root receipt.
pub fn runtime_revision() -> String {
    let mut digest = Sha256::new();
    update_canonical(
        &mut digest,
        include_bytes!("../../../resources/benchmark-browser-worker.mjs"),
    );
    digest.update([0]);
    update_canonical(
        &mut digest,
        include_bytes!("../../../resources/benchmark-sandbox/browser-runtime.json"),
    );
    format!("{:x}", digest.finalize())
}

fn update_canonical(digest: &mut Sha256, bytes: &[u8]) {
    // Deployment canonicalizes Windows checkout line endings to Linux LF.
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\r' || bytes.get(index + 1) != Some(&b'\n') {
            digest.update([*byte]);
        }
    }
}

fn failed_artifact(draft: &BenchmarkDraft, reason: &str, installed_revision: &str) -> Evaluation {
    Evaluation {
        id: uuid::Uuid::new_v4().to_string(),
        evaluator_revision: draft.evaluator.revision.clone(),
        verdict: "fail".into(),
        score: Some(0.0),
        reason: reason.into(),
        created_at: now(),
        provenance: "protected_browser".into(),
        artifacts: Vec::new(),
        details: Some(
            json!({"runtimeRevision":runtime_revision(),"installedRevision":installed_revision}),
        ),
        judge: None,
        usage: None,
    }
}

fn browser_timeout(spec: &Value, draft_seconds: u32) -> Result<Duration> {
    let seconds = match spec.get("timeoutSeconds") {
        None => u64::from(draft_seconds.clamp(1, 60)),
        Some(value) => value
            .as_f64()
            .filter(|seconds| {
                seconds.is_finite() && seconds.fract() == 0.0 && (1.0..=1200.0).contains(seconds)
            })
            .map(|seconds| seconds as u64)
            .ok_or_else(|| {
                BenchmarkError::new(
                    "invalid_definition",
                    "Browser timeoutSeconds must be an integer from 1 to 1200",
                )
            })?
            .min(u64::from(draft_seconds.max(1))),
    };
    Ok(Duration::from_secs(seconds))
}

fn screenshot(envelope: &Value) -> Result<Option<Vec<u8>>> {
    match envelope.get("screenshot") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(encoded)) if encoded.len() <= MAX_SCREENSHOT.div_ceil(3) * 4 => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| {
                    BenchmarkError::new(
                        "evaluation_error",
                        "Browser screenshot encoding is invalid",
                    )
                })?;
            if bytes.len() > MAX_SCREENSHOT || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err(BenchmarkError::new(
                    "budget_reached",
                    "Browser screenshot is invalid or exceeds cap",
                ));
            }
            Ok(Some(bytes))
        }
        _ => Err(BenchmarkError::new(
            "budget_reached",
            "Browser screenshot exceeds cap",
        )),
    }
}

/// Verify the deployed renderer before submitting any paid candidate work.
pub async fn ready() -> Result<String> {
    sandbox::ready()
        .await
        .map_err(|error| sandbox_error(error, "capability_missing"))?;
    let output = sandbox::invoke_bounded(
        "/usr/local/sbin/bench-browser",
        &["status"],
        None,
        16 * 1024,
        Duration::from_secs(120),
    )
    .await
    .map_err(|error| sandbox_error(error, "capability_missing"))?;
    if !output.success() || output.truncated {
        return Err(BenchmarkError::new(
            "capability_missing",
            "Pinned Linux renderer is unavailable; provision the sandbox before evaluation",
        ));
    }
    let identity: Value = serde_json::from_slice(&output.stdout)?;
    let expected = runtime_revision();
    if identity["expectedRevision"].as_str() != Some(expected.as_str()) {
        return Err(BenchmarkError::new(
            "capability_missing",
            "Installed Linux renderer differs from this build; provision and requalify",
        ));
    }
    let installed = identity["revision"]
        .as_str()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            BenchmarkError::new(
                "capability_missing",
                "Linux renderer has no valid installed identity",
            )
        })?;
    Ok(installed.to_owned())
}

static RENDERER: sandbox::Recent<(), String> = sandbox::Recent::new(sandbox::OBSERVATION_REUSE);

/// [`ready`] for an attempt about to prepare: attempts that prepare side by
/// side share one renderer observation within the sandbox's reuse window.
/// Qualification and promotion compare renderers with their own checks.
pub async fn ready_for_attempt() -> Result<String> {
    RENDERER.get((), false, ready).await
}

fn bounded_request(value: &Value) -> Result<Vec<u8>> {
    struct Request {
        bytes: Vec<u8>,
    }
    impl std::io::Write for Request {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_REQUEST.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::other("browser request exceeds cap"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut request = Request { bytes: Vec::new() };
    serde_json::to_writer(&mut request, value).map_err(|_| {
        BenchmarkError::new("budget_reached", "Browser request exceeds its byte cap")
    })?;
    Ok(request.bytes)
}

fn sandbox_error(error: std::io::Error, fallback: &str) -> BenchmarkError {
    let code = if error.kind() == std::io::ErrorKind::WouldBlock {
        "resource_busy"
    } else {
        fallback
    };
    BenchmarkError::new(code, error.to_string())
}

async fn execute(request: Value, timeout: Duration) -> Result<Value> {
    let bytes = bounded_request(&request)?;
    sandbox::ready()
        .await
        .map_err(|error| sandbox_error(error, "capability_missing"))?;
    let id = format!("browser-{}", uuid::Uuid::new_v4());
    let mut cleanup = sandbox::Cleanup(Some(id.clone()));
    let seconds = timeout.as_secs().clamp(1, 1200).to_string();
    // Shared admission refreshes headroom while waiting at most five minutes.
    // The child is submitted exactly once; no post-start failure is retried.
    let outcome = sandbox::invoke_bounded(
        "/usr/local/sbin/bench-browser",
        &["evaluate", &id, &seconds],
        Some(&bytes),
        MAX_ENVELOPE,
        timeout + Duration::from_secs(420),
    )
    .await;
    sandbox::clean(&id)
        .await
        .map_err(|error| BenchmarkError::new("infrastructure_failure", error.to_string()))?;
    cleanup.0.take();
    let outcome = outcome.map_err(|error| sandbox_error(error, "evaluation_error"))?;
    if let Some(reason) = outcome.infrastructure_error() {
        return Err(BenchmarkError::new("infrastructure_failure", reason));
    }
    if outcome.truncated {
        return Err(BenchmarkError::new(
            "budget_reached",
            "Browser envelope exceeded its byte cap",
        ));
    }
    if !outcome.success() {
        return Err(BenchmarkError::new(
            "evaluation_error",
            "Isolated Linux browser failed; inspect runtime readiness and resource limits",
        ));
    }
    let envelope: Value = serde_json::from_slice(&outcome.stdout)?;
    if envelope["runtimeRevision"].as_str() != Some(runtime_revision().as_str())
        || envelope["installedRevision"].as_str().is_none_or(|value| {
            value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        || (envelope.get("error").is_none() && !envelope["result"].is_object())
    {
        return Err(BenchmarkError::new(
            "capability_missing",
            "Linux renderer identity changed; provision and requalify the evaluator",
        ));
    }
    Ok(envelope)
}

pub async fn evaluate(draft: &BenchmarkDraft, output: &str) -> Result<Evaluation> {
    let runtime = RUNTIME.get().ok_or_else(|| {
        BenchmarkError::new(
            "capability_missing",
            "Isolated Linux browser evaluator is unavailable",
        )
    })?;
    evaluate_with_runtime(runtime, draft, output).await
}

pub async fn render(html: &str, width: u32, height: u32) -> Result<Vec<u8>> {
    if !available() {
        return Err(BenchmarkError::new(
            "capability_missing",
            "Isolated Linux browser evaluator is unavailable",
        ));
    }
    if html.len() > MAX_SCREENSHOT {
        return Err(BenchmarkError::new(
            "budget_reached",
            "Rendering exceeds the artifact cap",
        ));
    }
    let envelope = execute(
        json!({"kind":"render", "output":html,
        "spec":{"viewport":{"width":width.clamp(320,1600),"height":height.clamp(320,1600)}}}),
        Duration::from_secs(45),
    )
    .await?;
    if envelope.get("error").is_some() {
        return Err(BenchmarkError::new(
            "evaluation_error",
            "Linux rendering exceeded its time budget",
        ));
    }
    screenshot(&envelope)?.ok_or_else(|| {
        BenchmarkError::new("evaluation_error", "Linux renderer returned no screenshot")
    })
}

#[derive(Debug, PartialEq)]
enum SourceLimit {
    Accepted,
    Published,
    Renderer,
}

fn source_limit(bytes: usize, published: u64) -> SourceLimit {
    if bytes as u64 > published {
        SourceLimit::Published
    } else if bytes > MAX_SCREENSHOT {
        SourceLimit::Renderer
    } else {
        SourceLimit::Accepted
    }
}

pub async fn evaluate_with_runtime(
    runtime: &WorkerRuntime,
    draft: &BenchmarkDraft,
    output: &str,
) -> Result<Evaluation> {
    let (output, fence_stripped) = super::evaluation::strip_markdown_fence(output);
    let (output, export_stripped) = if draft.evaluator.kind == "javascript" {
        super::evaluation::strip_module_export(output)
    } else {
        (output, false)
    };
    if source_limit(output.len(), draft.limits.max_artifact_bytes) == SourceLimit::Published {
        let installed = ready().await?;
        return Ok(failed_artifact(
            draft,
            "Artifact exceeds its published size cap",
            &installed,
        ));
    }
    if source_limit(output.len(), draft.limits.max_artifact_bytes) == SourceLimit::Renderer {
        return Err(BenchmarkError::new(
            "capability_missing",
            "Artifact is within the published size cap but exceeds this Linux renderer's 2 MiB source capacity",
        ));
    }
    if draft.evaluator.expected.len() > MAX_REQUEST {
        return Err(BenchmarkError::new(
            "invalid_definition",
            "Protected browser specification exceeds its byte cap",
        ));
    }
    let spec: Value = serde_json::from_str(&draft.evaluator.expected)?;
    let timeout = if draft.evaluator.kind == "browser" {
        browser_timeout(&spec, draft.limits.timeout_seconds)?
    } else {
        Duration::from_secs(u64::from(draft.limits.timeout_seconds.clamp(1, 60)))
    };
    let envelope = execute(
        json!({"kind":draft.evaluator.kind,"spec":spec,"output":output}),
        timeout,
    )
    .await?;
    if envelope.get("error").is_some() {
        if envelope["candidateTimedOut"] == true {
            return Ok(failed_artifact(
                draft,
                "Candidate exceeded the published evaluator time budget",
                envelope["installedRevision"].as_str().unwrap_or_default(),
            ));
        }
        return Err(BenchmarkError::new(
            "evaluation_error",
            "Linux browser startup exceeded the evaluator time budget",
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let directory = runtime.root.join("evaluations").join(&id);
    let image = screenshot(&envelope)?;
    if image
        .as_ref()
        .is_some_and(|bytes| bytes.len() as u64 > draft.limits.max_artifact_bytes)
    {
        return Err(BenchmarkError::new(
            "budget_reached",
            "Screenshot exceeds artifact cap",
        ));
    }
    tokio::fs::create_dir_all(&directory).await?;
    let mut artifacts = Vec::new();
    if let Some(bytes) = image {
        let path = directory.join("preview.png");
        tokio::fs::write(&path, &bytes).await?;
        artifacts.push(Artifact {
            kind: "image".into(),
            path: path.to_string_lossy().into_owned(),
            hash: format!("{:x}", Sha256::digest(bytes)),
            label: "Browser interaction result".into(),
        });
    }
    let result = &envelope["result"];
    tokio::fs::write(
        directory.join("checks.json"),
        serde_json::to_vec_pretty(result)?,
    )
    .await?;
    let pass = result["pass"].as_bool().unwrap_or(false);
    Ok(Evaluation {
        id,
        evaluator_revision: draft.evaluator.revision.clone(),
        verdict: if pass { "pass" } else { "fail" }.into(),
        score: Some(if pass { 1.0 } else { 0.0 }),
        reason: format!(
            "Protected {} checks; Linux Chromium {}; isolated-linux-chromium-v2{}",
            result["checks"].as_array().map_or(0, Vec::len),
            result["browserVersion"].as_str().unwrap_or("unknown"),
            match (fence_stripped, export_stripped) {
                (true, true) => "; Markdown fence and module export stripped",
                (true, false) => "; Markdown fence stripped",
                (false, true) => "; module export stripped",
                (false, false) => "",
            }
        ),
        created_at: now(),
        provenance: "protected_browser".into(),
        artifacts,
        details: Some(
            json!({"runtimeRevision":envelope["runtimeRevision"],"installedRevision":envelope["installedRevision"],"runtime":envelope["runtime"]}),
        ),
        judge: None,
        usage: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn published_artifact_limit_and_renderer_capacity_have_distinct_outcomes() {
        // A valid answer cannot be scored wrong merely because the evaluator
        // cannot process the size its manifest permitted.
        let larger_published = MAX_SCREENSHOT as u64 * 4;
        assert_eq!(
            source_limit(MAX_SCREENSHOT, larger_published),
            SourceLimit::Accepted
        );
        assert_eq!(
            source_limit(MAX_SCREENSHOT + 1, larger_published),
            SourceLimit::Renderer
        );
        assert_eq!(
            source_limit(MAX_SCREENSHOT + 1, MAX_SCREENSHOT as u64),
            SourceLimit::Published
        );
        assert_eq!(source_limit(1024, 1024), SourceLimit::Accepted);
        assert_eq!(source_limit(1025, 1024), SourceLimit::Published);
    }
    #[test]
    fn browser_timeout_preserves_defaults_and_limits_opt_in() {
        for (spec, draft, expected) in [
            (json!({}), 1800, 60),
            (json!({}), 12, 12),
            (json!({}), 0, 1),
            (json!({"timeoutSeconds":540}), 1800, 540),
            (json!({"timeoutSeconds":1200}), 600, 600),
            (json!({"timeoutSeconds":1}), 1800, 1),
        ] {
            assert_eq!(browser_timeout(&spec, draft).unwrap().as_secs(), expected);
        }
    }
    #[test]
    fn browser_timeout_rejects_invalid_protected_limits() {
        for value in [
            json!(null),
            json!(true),
            json!("60"),
            json!(0),
            json!(-1),
            json!(1201),
            json!(1.5),
        ] {
            assert!(browser_timeout(&json!({"timeoutSeconds":value}), 1800).is_err());
        }
    }
    #[test]
    fn screenshot_rejects_bad_encoding_types_and_oversized_images() {
        assert!(screenshot(&json!({"screenshot":"!"})).is_err());
        assert!(screenshot(&json!({"screenshot":true})).is_err());
        assert!(screenshot(&json!({"screenshot":"a".repeat(MAX_SCREENSHOT*2)})).is_err());
        assert!(screenshot(&json!({"screenshot":null})).unwrap().is_none());
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture");
        assert!(screenshot(&json!({"screenshot":encoded}))
            .unwrap()
            .is_some());
    }
    #[test]
    fn renderer_revision_binds_linux_worker_and_pinned_renderer_spec() {
        assert_eq!(runtime_revision().len(), 64);
        let spec: Value = serde_json::from_str(include_str!(
            "../../../resources/benchmark-sandbox/browser-runtime.json"
        ))
        .unwrap();
        assert_eq!(spec["platform"], "linux-x64-ubuntu-24.04");
        assert_eq!(spec["deviceScaleFactor"], 1);
        let mut windows = Sha256::new();
        update_canonical(&mut windows, b"a\r\nb\r\nc");
        let mut linux = Sha256::new();
        update_canonical(&mut linux, b"a\nb\nc");
        assert_eq!(windows.finalize(), linux.finalize());
    }
}
