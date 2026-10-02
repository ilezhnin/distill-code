//! Bounded JavaScript/HTML artifact evaluation in a disposable Chromium sandbox.
//! This profile never gives the model native filesystem or shell tools.
use super::{store::now, types::*};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, process::Stdio, sync::OnceLock, time::Duration};
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone)]
pub struct WorkerRuntime {
    pub node: PathBuf,
    pub module: PathBuf,
    pub browser: PathBuf,
    pub root: PathBuf,
}
static RUNTIME: OnceLock<WorkerRuntime> = OnceLock::new();

pub fn configure(app: &tauri::AppHandle) -> Result<()> {
    let root = crate::services::distill_root::app_root(app)
        .map_err(|e| BenchmarkError::new("storage_unavailable", e))?
        .join("benchmarks");
    let node = crate::services::managed_node::managed_node_bin_dir(app)
        .map(|p| p.join("node.exe"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| BenchmarkError::new("capability_missing", e.to_string()))?;
    let mut module = resources.join("benchmark-worker/node_modules/playwright-core/index.mjs");
    if cfg!(debug_assertions) && !module.is_file() {
        module = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/playwright-core/index.mjs");
    }
    let browser = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
    .unwrap_or_default();
    if !node.is_file() || !module.is_file() || !browser.is_file() {
        return Err(BenchmarkError::new("capability_missing","Artifact evaluation requires installed Node, bundled Playwright Core and Microsoft Edge"));
    }
    let _ = RUNTIME.set(WorkerRuntime {
        node,
        module,
        browser,
        root,
    });
    Ok(())
}

pub fn available() -> bool {
    RUNTIME.get().is_some()
}

fn failed_artifact(draft: &BenchmarkDraft, reason: &str) -> Evaluation {
    Evaluation {
        id: uuid::Uuid::new_v4().to_string(),
        evaluator_revision: draft.evaluator.revision.clone(),
        verdict: "fail".into(),
        score: Some(0.0),
        reason: reason.into(),
        created_at: now(),
        provenance: "protected_browser".into(),
        artifacts: Vec::new(),
    }
}

pub async fn evaluate(draft: &BenchmarkDraft, output: &str) -> Result<Evaluation> {
    let runtime = RUNTIME.get().ok_or_else(|| {
        BenchmarkError::new(
            "capability_missing",
            "Isolated browser evaluator runtime is unavailable",
        )
    })?;
    evaluate_with_runtime(runtime, draft, output).await
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
    if output.len() > draft.limits.max_artifact_bytes.min(2 * 1024 * 1024) as usize {
        return Ok(failed_artifact(
            draft,
            "Artifact exceeds its published size cap",
        ));
    }
    let spec: Value = serde_json::from_str(&draft.evaluator.expected)?;
    let id = uuid::Uuid::new_v4().to_string();
    let directory = runtime.root.join("evaluations").join(&id);
    tokio::fs::create_dir_all(&directory).await?;
    let script = directory.join("worker.mjs");
    tokio::fs::write(
        &script,
        include_str!("../../../resources/benchmark-browser-worker.mjs"),
    )
    .await?;
    let screenshot = directory.join("preview.png");
    let progress = directory.join("candidate-started");
    let request = serde_json::to_vec(
        &json!({"kind":draft.evaluator.kind,"spec":spec,"output":output,
        "progressPath":progress,
        "screenshotPath":if draft.evaluator.kind == "browser" { Some(&screenshot) } else { None }}),
    )?;
    let mut command = tokio::process::Command::new(&runtime.node);
    command
        .arg(&script)
        .arg(&runtime.module)
        .arg(&runtime.browser)
        .current_dir(&directory)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // OS runtime paths only; no account credentials, IPC, proxy or personal context.
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    crate::services::process::apply_no_window_async(&mut command);
    let mut child = command.spawn()?;
    let tree = crate::services::process::ProcessTree::contain(&child);
    if cfg!(windows) && tree.is_none() {
        let _ = child.kill().await;
        return Err(BenchmarkError::new(
            "capability_missing",
            "Cannot contain evaluator process tree",
        ));
    }
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| BenchmarkError::new("infrastructure_failure", "Worker stdin unavailable"))?;
    let stdout = child.stdout.take().ok_or_else(|| {
        BenchmarkError::new("infrastructure_failure", "Worker stdout unavailable")
    })?;
    let run = async {
        stdin.write_all(&request).await?;
        stdin.shutdown().await?;
        drop(stdin);
        let mut bytes = Vec::new();
        stdout.take(262_145).read_to_end(&mut bytes).await?;
        if bytes.len() > 262_144 {
            return Err(BenchmarkError::new(
                "budget_reached",
                "Evaluator output cap exceeded",
            ));
        }
        let status = child.wait().await?;
        let result: Value = serde_json::from_slice(&bytes)?;
        if !status.success() || result.get("error").is_some() {
            return Err(BenchmarkError::new(
                "evaluation_error",
                result["error"]
                    .as_str()
                    .unwrap_or("Browser evaluator failed"),
            ));
        }
        Ok(result)
    };
    let result = match tokio::time::timeout(
        Duration::from_secs(u64::from(draft.limits.timeout_seconds.clamp(1, 60))),
        run,
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            if let Some(tree) = &tree {
                tree.kill();
            }
            let _ = child.kill().await;
            if progress.is_file() {
                return Ok(failed_artifact(
                    draft,
                    "Candidate exceeded the published evaluator time budget",
                ));
            }
            return Err(BenchmarkError::new(
                "evaluation_error",
                "Browser startup exceeded the evaluator time budget",
            ));
        }
    };
    let mut artifacts = Vec::new();
    if screenshot.is_file() {
        let bytes = tokio::fs::read(&screenshot).await?;
        if bytes.len() as u64 > draft.limits.max_artifact_bytes {
            return Err(BenchmarkError::new(
                "budget_reached",
                "Screenshot exceeds artifact cap",
            ));
        }
        artifacts.push(Artifact {
            kind: "image".into(),
            path: screenshot.to_string_lossy().into_owned(),
            hash: format!("{:x}", Sha256::digest(bytes)),
            label: "Browser interaction result".into(),
        });
    }
    let pass = result["pass"].as_bool().unwrap_or(false);
    tokio::fs::write(
        directory.join("checks.json"),
        serde_json::to_vec_pretty(&result)?,
    )
    .await?;
    Ok(Evaluation {
        id,
        evaluator_revision: draft.evaluator.revision.clone(),
        verdict: if pass { "pass" } else { "fail" }.into(),
        score: Some(if pass { 1.0 } else { 0.0 }),
        reason: format!(
            "Protected {} checks; Chromium {}; isolated-artifact-v1{}",
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
    })
}
