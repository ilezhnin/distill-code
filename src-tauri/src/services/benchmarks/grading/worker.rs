//! Linux-only bounded artifact evaluation. Expected values stay in the trusted
//! controller; candidate JavaScript executes only in sandboxed Chromium.
use crate::services::benchmark_sandbox as sandbox;
use crate::services::benchmarks::{store::now, types::*};
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
    let root = crate::services::flock_root::app_root(app)
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
        include_bytes!("../../../../resources/benchmark-browser-worker.mjs"),
    );
    digest.update([0]);
    update_canonical(
        &mut digest,
        include_bytes!("../../../../resources/benchmark-sandbox/browser-runtime.json"),
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

/// The waits before the renderer's status is asked again after it failed.
/// 11-15: one failed status stopped a run of 24 tests for the operator with
/// three left; asked 40 times two hours later, with runs in flight, the
/// helper answered every time, in a tenth of a second.
const STATUS_PAUSES: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];

/// Verify the deployed renderer before submitting any paid candidate work.
/// A status that fails is asked again (see [`STATUS_PAUSES`]) before the
/// renderer counts as unavailable.
pub async fn ready() -> Result<String> {
    sandbox::ready()
        .await
        .map_err(|error| sandbox_error(error, "capability_missing"))?;
    let output = sandbox::again_while_failed("renderer status", &STATUS_PAUSES, || {
        sandbox::invoke_bounded(
            "/usr/local/sbin/bench-browser",
            &["status"],
            None,
            16 * 1024,
            Duration::from_secs(120),
        )
    })
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
    // Refused room before it started, the job made nothing to clean, and a
    // clean would only start more processes in a sandbox that is out of
    // them.
    if outcome
        .as_ref()
        .is_err_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
    {
        cleanup.0.take();
        return Err(sandbox_error(outcome.unwrap_err(), "evaluation_error"));
    }
    sandbox::clean(&id)
        .await
        .map_err(|error| BenchmarkError::new("infrastructure_failure", error.to_string()))?;
    cleanup.0.take();
    let outcome = outcome.map_err(|error| sandbox_error(error, "evaluation_error"))?;
    if let Some(reason) = outcome.infrastructure_error() {
        return Err(BenchmarkError::new("infrastructure_failure", reason));
    }
    if let Some(limit) = outcome.candidate_limit() {
        return Err(BenchmarkError::new(
            CANDIDATE_LIMIT,
            format!("The candidate's page drove its browser job past the job's {limit} ceiling"),
        ));
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

/// A rendering, with the installed renderer revision the job itself reported.
pub async fn render(html: &str, width: u32, height: u32) -> Result<(Vec<u8>, String)> {
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
    let png = screenshot(&envelope)?.ok_or_else(|| {
        BenchmarkError::new("evaluation_error", "Linux renderer returned no screenshot")
    })?;
    // `execute` already checked this is a 64-digit hex revision.
    let installed = envelope["installedRevision"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    Ok((png, installed))
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

/// One browser job in the sandbox: the worker's request and its time budget,
/// to the helper's envelope.
type Job = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>>;
type Run<'a> = &'a (dyn Fn(Value, Duration) -> Job + Sync);

/// A browser job that ran: its envelope, or the fail the candidate earned by
/// driving the job past a ceiling or its time budget.
enum Settled {
    Envelope(Value),
    Graded(Box<Evaluation>),
}

async fn settle(draft: &BenchmarkDraft, outcome: Result<Value>) -> Result<Settled> {
    let envelope = match outcome {
        // The candidate's page drove the job past its ceiling: a graded fail
        // that names the renderer and worker that ran it, so a certificate
        // can tell which renderer this zero came from.
        Err(error) if error.code == CANDIDATE_LIMIT => {
            let installed = Box::pin(ready()).await?;
            return Ok(Settled::Graded(Box::new(failed_artifact(
                draft,
                &error.message,
                &installed,
            ))));
        }
        result => result?,
    };
    if envelope.get("error").is_some() {
        if envelope["candidateTimedOut"] == true {
            return Ok(Settled::Graded(Box::new(failed_artifact(
                draft,
                "Candidate exceeded the published evaluator time budget",
                envelope["installedRevision"].as_str().unwrap_or_default(),
            ))));
        }
        return Err(BenchmarkError::new(
            "evaluation_error",
            "Linux browser startup exceeded the evaluator time budget",
        ));
    }
    Ok(Settled::Envelope(envelope))
}

fn stripped_note(fence_stripped: bool, export_stripped: bool) -> &'static str {
    match (fence_stripped, export_stripped) {
        (true, true) => "; Markdown fence and module export stripped",
        (true, false) => "; Markdown fence stripped",
        (false, true) => "; module export stripped",
        (false, false) => "",
    }
}

pub async fn evaluate_with_runtime(
    runtime: &WorkerRuntime,
    draft: &BenchmarkDraft,
    output: &str,
) -> Result<Evaluation> {
    evaluate_through(runtime, draft, output, &|request, timeout| {
        Box::pin(execute(request, timeout))
    })
    .await
}

/// Share scoring (see [`crate::services::benchmarks::mutation`]): one browser job per
/// implementation position, each over the unchanged bundles, then the counts.
async fn evaluate_share(
    runtime: &WorkerRuntime,
    draft: &BenchmarkDraft,
    plan: &crate::services::benchmarks::mutation::Plan,
    output: &str,
    timeout: Duration,
    note: &str,
    run: Run<'_>,
) -> Result<Evaluation> {
    if output.len() + plan.source_overhead() > MAX_SCREENSHOT {
        return Err(BenchmarkError::new(
            "capability_missing",
            "Artifact is within the published size cap but exceeds this Linux renderer's 2 MiB source capacity",
        ));
    }
    let source = plan.source(output);
    let mut results = Vec::with_capacity(plan.passes());
    let mut identity: Option<Value> = None;
    for position in 0..plan.passes() {
        let request = json!({"kind":"javascript","spec":plan.pass_spec(position),"output":source});
        let envelope = match settle(draft, run(request, timeout).await).await? {
            Settled::Envelope(envelope) => envelope,
            // A suite that cannot be run to the end scores nothing.
            Settled::Graded(evaluation) => return Ok(*evaluation),
        };
        // One evaluation is one renderer: a sandbox updated between passes
        // would grade some implementations on another.
        if identity.as_ref().is_some_and(|first| {
            first["installedRevision"] != envelope["installedRevision"]
                || first["result"]["browserVersion"] != envelope["result"]["browserVersion"]
        }) {
            return Err(BenchmarkError::new(
                "capability_missing",
                "Linux renderer identity changed during the evaluation; evaluate again",
            ));
        }
        results.push(envelope["result"].clone());
        identity.get_or_insert(envelope);
    }
    let identity = identity.ok_or_else(|| {
        BenchmarkError::new("invalid_definition", "Share scoring has no implementation")
    })?;
    let outcome = plan.outcome(&results);
    let id = uuid::Uuid::new_v4().to_string();
    let directory = runtime.root.join("evaluations").join(&id);
    tokio::fs::create_dir_all(&directory).await?;
    tokio::fs::write(
        directory.join("checks.json"),
        serde_json::to_vec_pretty(&json!({"mutation":outcome.details(),"passes":results}))?,
    )
    .await?;
    Ok(Evaluation {
        id,
        evaluator_revision: draft.evaluator.revision.clone(),
        verdict: if outcome.passed() { "pass" } else { "fail" }.into(),
        score: Some(outcome.score()),
        reason: format!(
            "Protected {} implementations: {}; Linux Chromium {}; isolated-linux-chromium-v2{note}",
            outcome.implementations.len(),
            outcome.summary(),
            identity["result"]["browserVersion"]
                .as_str()
                .unwrap_or("unknown"),
        ),
        created_at: now(),
        provenance: "protected_browser".into(),
        artifacts: Vec::new(),
        details: Some(
            json!({"runtimeRevision":identity["runtimeRevision"],"installedRevision":identity["installedRevision"],"runtime":identity["runtime"],"mutation":outcome.details()}),
        ),
        judge: None,
        usage: None,
    })
}

async fn evaluate_through(
    runtime: &WorkerRuntime,
    draft: &BenchmarkDraft,
    output: &str,
    run: Run<'_>,
) -> Result<Evaluation> {
    let (output, fence_stripped) =
        crate::services::benchmarks::evaluation::strip_markdown_fence(output);
    let (output, export_stripped) = if draft.evaluator.kind == "javascript" {
        crate::services::benchmarks::evaluation::strip_module_export(output)
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
    // A specification that declares share scoring is asked position by
    // position; every other one is sent to the worker as it is.
    if draft.evaluator.kind == "javascript" {
        if let Some(plan) = crate::services::benchmarks::mutation::Plan::parse(&spec)
            .map_err(|issue| BenchmarkError::new("invalid_definition", issue))?
        {
            let note = stripped_note(fence_stripped, export_stripped);
            return evaluate_share(runtime, draft, &plan, output, timeout, note, run).await;
        }
    }
    let request = json!({"kind":draft.evaluator.kind,"spec":spec,"output":output});
    let envelope = match settle(draft, run(request, timeout).await).await? {
        Settled::Envelope(envelope) => envelope,
        Settled::Graded(evaluation) => return Ok(*evaluation),
    };
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
            stripped_note(fence_stripped, export_stripped)
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
    /// An invented suite task: two bundles of words, one correct and three
    /// defective implementations, declared share-scored or not.
    fn suite_draft(share: bool) -> BenchmarkDraft {
        let mut draft = crate::services::benchmarks::seeds::definitions()
            .into_iter()
            .find(|draft| draft.evaluator.kind == "javascript")
            .unwrap();
        let mut spec = json!({"functionName":"gradeImplementations","argsCases":[
            {"args":[["sound","leaky"]],"expected":["accept","reject"]},
            {"args":[["stale","lossy"]],"expected":["reject","reject"]}]});
        if share {
            spec["scoring"] = json!(crate::services::benchmarks::mutation::SCORING);
        }
        draft.evaluator.expected = spec.to_string();
        draft.evaluator.revision = if share {
            "invented-share-1"
        } else {
            "invented-all-1"
        }
        .into();
        draft
    }

    /// Grades `answer` through a sandbox job that stands for the worker: the
    /// suite rejects the words `answer` lists and throws on `"throw"`. Returns
    /// the evaluation and every request the job was sent.
    async fn graded(draft: &BenchmarkDraft, answer: &str) -> (Evaluation, Vec<Value>) {
        let directory = tempfile::tempdir().unwrap();
        let runtime = WorkerRuntime {
            root: directory.path().to_path_buf(),
        };
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        let evaluation = evaluate_through(&runtime, draft, answer, &move |request, _| {
            seen.lock().unwrap().push(request.clone());
            Box::pin(async move {
                let rejects = request["output"].as_str().unwrap().to_owned();
                let suite = |args: &[Value]| {
                    if rejects.starts_with("throw") {
                        return None;
                    }
                    Some(json!(args[0]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|word| if rejects.contains(word.as_str().unwrap()) {
                            "reject"
                        } else {
                            "accept"
                        })
                        .collect::<Vec<_>>()))
                };
                let result = crate::services::benchmarks::mutation::simulated_worker(
                    &request["spec"],
                    &suite,
                );
                Ok(
                    json!({"result":result,"screenshot":null,"runtimeRevision":runtime_revision(),
                    "installedRevision":"a".repeat(64),"runtime":{"renderer":"invented"}}),
                )
            })
        })
        .await
        .unwrap();
        let checks = directory
            .path()
            .join("evaluations")
            .join(&evaluation.id)
            .join("checks.json");
        assert!(checks.is_file());
        let requests = requests.lock().unwrap().clone();
        (evaluation, requests)
    }

    #[tokio::test]
    async fn a_share_scored_suite_scores_the_defects_it_catches() {
        let draft = suite_draft(true);
        // Catches two of the three defective implementations.
        let (partial, requests) = graded(&draft, "leaky stale").await;
        assert_eq!(partial.verdict, "fail");
        assert_eq!(partial.score, Some(2.0 / 3.0));
        assert_eq!(partial.evaluator_revision, "invented-share-1");
        assert_eq!(partial.provenance, "protected_browser");
        assert_eq!(
            partial.reason,
            "Protected 4 implementations: accepted 1/1 correct implementations, caught 2/3 defective ones; Linux Chromium invented; isolated-linux-chromium-v2"
        );
        let details = partial.details.as_ref().unwrap();
        assert_eq!(details["runtimeRevision"], runtime_revision());
        assert_eq!(details["installedRevision"], "a".repeat(64));
        let mutation = &details["mutation"];
        assert_eq!(
            (&mutation["correctAccepted"], &mutation["correctTotal"]),
            (&json!(1), &json!(1))
        );
        assert_eq!(
            (&mutation["defectsCaught"], &mutation["defectTotal"]),
            (&json!(2), &json!(3))
        );
        assert_eq!(
            mutation["implementations"][3],
            json!({"case":1,"position":1,"expected":"reject","matched":false})
        );
        // One job per implementation position, each over the unchanged bundles.
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["kind"], "javascript");
        assert_eq!(
            requests[1]["spec"]["argsCases"][0]["args"],
            json!([1, 2, ["sound", "leaky"]])
        );
        assert!(requests[0]["output"]
            .as_str()
            .unwrap()
            .starts_with("leaky stale\n;async function"));
        // Every defect caught is the only pass.
        let (full, _) = graded(&draft, "leaky stale lossy").await;
        assert_eq!((full.verdict.as_str(), full.score), ("pass", Some(1.0)));
        // A rejected correct implementation is 0 whatever else was caught.
        let (strict, _) = graded(&draft, "sound leaky stale lossy").await;
        assert_eq!((strict.verdict.as_str(), strict.score), ("fail", Some(0.0)));
        assert_eq!(strict.details.unwrap()["mutation"]["defectsCaught"], 3);
        // A suite that cannot be loaded or run is 0.
        let (broken, _) = graded(&draft, "throw").await;
        assert_eq!((broken.verdict.as_str(), broken.score), ("fail", Some(0.0)));
        assert_eq!(
            broken.details.unwrap()["mutation"]["implementations"][0]["threw"],
            true
        );
    }

    #[tokio::test]
    async fn a_specification_without_scoring_keeps_the_all_cases_verdict() {
        let draft = suite_draft(false);
        // The same partial suite: one bundle of two matches, so all or nothing.
        let (partial, requests) = graded(&draft, "leaky stale").await;
        assert_eq!(
            (partial.verdict.as_str(), partial.score),
            ("fail", Some(0.0))
        );
        assert_eq!(
            partial.reason,
            "Protected 2 checks; Linux Chromium invented; isolated-linux-chromium-v2"
        );
        assert_eq!(partial.evaluator_revision, "invented-all-1");
        assert_eq!(
            partial.details.unwrap(),
            json!({"runtimeRevision":runtime_revision(),"installedRevision":"a".repeat(64),
                "runtime":{"renderer":"invented"}})
        );
        // The worker gets the published specification and the answer as they are.
        assert_eq!(
            requests,
            [json!({"kind":"javascript",
                "spec":serde_json::from_str::<Value>(&draft.evaluator.expected).unwrap(),
                "output":"leaky stale"})]
        );
        let (full, _) = graded(&draft, "leaky stale lossy").await;
        assert_eq!((full.verdict.as_str(), full.score), ("pass", Some(1.0)));
    }
    #[test]
    fn renderer_revision_binds_linux_worker_and_pinned_renderer_spec() {
        assert_eq!(runtime_revision().len(), 64);
        let spec: Value = serde_json::from_str(include_str!(
            "../../../../resources/benchmark-sandbox/browser-runtime.json"
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
