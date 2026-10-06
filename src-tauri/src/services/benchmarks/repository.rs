//! Working copies and the hidden check of the `protected_repository`
//! profile.
//!
//! A repository case is a snapshot of a local git repository at one commit
//! (`environment.repository`: its path, the commit and that commit's tree)
//! and a hidden check sealed in its manifest (`evaluator.kind` is
//! `repository`; `evaluator.expected` holds the check's files and command).
//! The candidate works in a fresh copy that holds the snapshot alone, one
//! commit with no history, so no later commit and no check can be found in
//! it; its answer is the patch it leaves there. The check runs in another
//! fresh copy with that patch applied and the hidden files added, and its
//! exit status scores the attempt: 0 passes, anything else fails.

use super::{fixtures, types::*};
use crate::services::benchmark_sandbox as sandbox;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// The snapshot a repository case starts from.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// A local git repository that holds the commit.
    pub path: PathBuf,
    pub commit: String,
    /// The commit's tree, so a rewritten history is noticed before a turn.
    pub tree: String,
}

/// The check that scores a repository case, kept out of every working copy.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenCheck {
    /// Files added to the check copy only, paths relative to its root.
    #[serde(default)]
    pub files: Vec<Fixture>,
    /// The program and its arguments, run in the check copy's root.
    pub command: Vec<String>,
    #[serde(default = "default_check_seconds")]
    pub timeout_seconds: u64,
}

fn default_check_seconds() -> u64 {
    600
}

/// The evaluator kind of a repository case.
pub const EVALUATOR: &str = "repository";
/// The outcome of a turn that left the snapshot as it was.
pub const NO_ANSWER: &str = "no_answer";
const MAX_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;

pub fn snapshot(manifest: &BenchmarkDraft) -> Result<Snapshot> {
    serde_json::from_value(manifest.environment["repository"].clone()).map_err(|error| {
        BenchmarkError::new(
            "validation",
            format!(
                "A repository case needs environment.repository {{path, commit, tree}}: {error}"
            ),
        )
    })
}

pub fn hidden_check(evaluator: &Evaluator) -> Result<HiddenCheck> {
    let check: HiddenCheck = serde_json::from_str(&evaluator.expected).map_err(|error| {
        BenchmarkError::new(
            "validation",
            format!("A repository check needs {{files, command, timeoutSeconds}}: {error}"),
        )
    })?;
    if check.command.is_empty() || check.command[0].trim().is_empty() {
        return Err(BenchmarkError::new(
            "validation",
            "A repository check needs a command",
        ));
    }
    if check
        .files
        .iter()
        .any(|file| !fixtures::safe_relative(&file.path))
    {
        return Err(BenchmarkError::new(
            "validation",
            "A hidden check file escapes the copy",
        ));
    }
    if check.timeout_seconds == 0 || check.timeout_seconds > 3_600 {
        return Err(BenchmarkError::new(
            "validation",
            "A repository check runs for 1 to 3600 seconds",
        ));
    }
    Ok(check)
}

/// What a repository case lacks, as validation issues. The repository check
/// is what makes a case run as a tool session; a case of the profile scored
/// by another evaluator is a code artifact answered as text, as before.
pub fn validate(draft: &BenchmarkDraft) -> Vec<String> {
    let mut issues = Vec::new();
    if draft.evaluator.kind != EVALUATOR {
        return issues;
    }
    if draft.execution_profile != "protected_repository" {
        issues.push("The repository check scores only the protected repository profile".into());
    }
    if let Err(error) = snapshot(draft) {
        issues.push(error.message);
    }
    if let Err(error) = hidden_check(&draft.evaluator) {
        issues.push(error.message);
    }
    if draft.evaluator.known_good.trim().is_empty() {
        issues.push("A repository case needs the reference patch that passes its check".into());
    }
    issues
}

/// Whether `manifest` runs as an ordinary session with tools in a copy of
/// its snapshot.
pub fn is_repository_case(manifest: &BenchmarkDraft) -> bool {
    manifest.evaluator.kind == EVALUATOR
}

/// A git command in `dir`, with no window, no prompt, no line ending
/// conversion and no hooks, failing after two minutes.
async fn git(dir: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut command = tokio::process::Command::new("git");
    command
        .args([
            "-c",
            "core.autocrlf=false",
            "-c",
            "core.hooksPath=",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::services::process::apply_no_window_async(&mut command);
    let mut child = command.spawn()?;
    let tree = crate::services::process::ProcessTree::contain(&child);
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped git stdout");
    let stderr = child.stderr.take().expect("piped git stderr");
    let run = async {
        let (written, out, err, status) = tokio::join!(
            async {
                if let (Some(bytes), Some(mut stdin)) = (input, stdin) {
                    stdin.write_all(bytes).await?;
                    stdin.shutdown().await?;
                }
                Ok::<_, std::io::Error>(())
            },
            sandbox::read_tail(stdout, MAX_SNAPSHOT_BYTES),
            sandbox::read_tail(stderr, 8192),
            child.wait()
        );
        let status = status?;
        if status.success() {
            written?;
        }
        Ok::<_, BenchmarkError>((status, out?, err?.0))
    };
    let output = tokio::time::timeout(Duration::from_secs(120), run)
        .await
        .map_err(|_| BenchmarkError::new("infrastructure_failure", "git did not finish"))??;
    drop(tree);
    let (status, (stdout, truncated), stderr) = output;
    if !status.success() {
        return Err(BenchmarkError::new(
            "infrastructure_failure",
            format!(
                "git {} failed: {}",
                args.first().unwrap_or(&""),
                String::from_utf8_lossy(&stderr).trim()
            ),
        ));
    }
    if truncated {
        return Err(BenchmarkError::new(
            "validation",
            "Repository snapshot exceeds 256 MiB",
        ));
    }
    Ok(stdout)
}

/// A git command against the snapshot's repository: a working repository
/// in its own directory, a bare store (the private snapshot store is one)
/// named with `--git-dir`, as `safe.bareRepository=explicit` requires.
async fn source_git(snapshot: &Snapshot, args: &[&str]) -> Result<Vec<u8>> {
    if snapshot.path.join(".git").exists() {
        return git(&snapshot.path, args, None).await;
    }
    let git_dir = snapshot.path.to_string_lossy().into_owned();
    let mut bare = vec!["--git-dir", git_dir.as_str()];
    bare.extend_from_slice(args);
    let cwd = snapshot.path.parent().unwrap_or(&snapshot.path);
    git(cwd, &bare, None).await
}

/// Verify the frozen tree and export only its files. Archiving the tree also
/// avoids Git's global PAX comment carrying the source commit identity.
pub async fn archive(snapshot: &Snapshot) -> Result<Vec<u8>> {
    if [&snapshot.commit, &snapshot.tree]
        .iter()
        .any(|id| ![40, 64].contains(&id.len()) || !id.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(BenchmarkError::new(
            "validation",
            "Snapshot commit and tree must be full git object ids",
        ));
    }
    let tree = source_git(
        snapshot,
        &["rev-parse", &format!("{}^{{tree}}", snapshot.commit)],
    )
    .await?;
    if String::from_utf8_lossy(&tree).trim() != snapshot.tree {
        return Err(BenchmarkError::new(
            "evidence_missing",
            "The snapshot commit no longer holds the published tree",
        ));
    }
    let archive = source_git(snapshot, &["archive", "--format=tar", &snapshot.tree]).await?;
    if archive.len() > MAX_SNAPSHOT_BYTES {
        return Err(BenchmarkError::new(
            "validation",
            "Repository snapshot exceeds 256 MiB",
        ));
    }
    validate_archive(&archive)?;
    Ok(archive)
}

// Archives enter root-owned staging. Until link-preserving extraction has its
// own confinement proof, reject links and special files before crossing WSL.
fn validate_archive(bytes: &[u8]) -> Result<()> {
    let mut archive = tar::Archive::new(bytes);
    for entry in archive.entries()? {
        let entry = entry?;
        let path = entry.path()?;
        let path = path.to_string_lossy();
        let kind = entry.header().entry_type();
        if !fixtures::safe_relative(path.trim_end_matches('/'))
            || path
                .split('/')
                .any(|part| part.eq_ignore_ascii_case(".git"))
            || !(kind.is_file() || kind.is_dir())
        {
            return Err(BenchmarkError::new(
                "validation",
                format!("Unsupported or unsafe snapshot entry: {path}"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
async fn materialize(snapshot: &Snapshot, dir: &Path) -> Result<()> {
    let archive = archive(snapshot).await?;
    tokio::fs::create_dir_all(dir).await?;
    let target = dir.to_owned();
    tokio::task::spawn_blocking(move || tar::Archive::new(archive.as_slice()).unpack(&target))
        .await
        .map_err(|error| BenchmarkError::new("infrastructure_failure", error.to_string()))??;
    git(dir, &["init", "-q"], None).await?;
    git(dir, &["add", "-A"], None).await?;
    git(
        dir,
        &[
            "-c",
            "user.name=Distill benchmark",
            "-c",
            "user.email=benchmark@distill.invalid",
            "commit",
            "-q",
            "--no-verify",
            "-m",
            "snapshot",
        ],
        None,
    )
    .await?;
    Ok(())
}

/// Everything the candidate changed in its copy since the snapshot, new
/// files included, as a binary patch; empty when it changed nothing.
#[cfg(test)]
async fn patch(dir: &Path, max_bytes: usize) -> Result<String> {
    git(dir, &["add", "-A"], None).await?;
    let bytes = git(dir, &["diff", "--cached", "--binary", "HEAD"], None).await?;
    if bytes.len() > max_bytes {
        return Err(BenchmarkError::new(
            "budget_reached",
            "The patch exceeds the artifact budget",
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Scores the sealed answer. Empty answers remain a separate model outcome.
pub async fn evaluate_patch(manifest: &BenchmarkDraft, patch: &str) -> Result<Evaluation> {
    if patch.trim().is_empty() {
        return Ok(evaluation(
            manifest,
            NO_ANSWER,
            0.0,
            "The turn left the snapshot unchanged".into(),
            None,
        ));
    }
    evaluate_reference(manifest, patch).await
}

fn evaluation(
    manifest: &BenchmarkDraft,
    verdict: &str,
    score: f64,
    reason: String,
    details: Option<serde_json::Value>,
) -> Evaluation {
    Evaluation {
        id: uuid::Uuid::new_v4().to_string(),
        evaluator_revision: manifest.evaluator.revision.clone(),
        verdict: verdict.into(),
        score: Some(score),
        reason,
        created_at: super::store::now(),
        provenance: "objective".into(),
        artifacts: vec![],
        details,
        judge: None,
        usage: None,
    }
}

fn sandbox_error(error: std::io::Error) -> BenchmarkError {
    BenchmarkError::new("evaluation_error", format!("Repository sandbox: {error}"))
}

fn append_file(builder: &mut tar::Builder<Vec<u8>>, path: &str, bytes: &[u8]) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_data(&mut header, path, bytes)?;
    Ok(())
}

fn check_archive(snapshot: &[u8], patch: &str, check: &HiddenCheck) -> Result<Vec<u8>> {
    validate_archive(snapshot)?;
    let mut builder = tar::Builder::new(Vec::new());
    // Include the directory even for an empty snapshot.
    let mut directory = tar::Header::new_gnu();
    directory.set_entry_type(tar::EntryType::Directory);
    directory.set_size(0);
    directory.set_mode(0o755);
    directory.set_cksum();
    builder.append_data(&mut directory, "snapshot", std::io::empty())?;
    for entry in tar::Archive::new(snapshot).entries()? {
        let mut entry = entry?;
        let path = PathBuf::from("snapshot").join(entry.path()?);
        let mut header = entry.header().clone();
        builder.append_data(&mut header, path, &mut entry)?;
    }
    append_file(&mut builder, "answer.patch", patch.as_bytes())?;
    for file in &check.files {
        append_file(
            &mut builder,
            &format!("hidden/{}", file.path),
            file.content.as_bytes(),
        )?;
    }
    Ok(builder.into_inner()?)
}

/// Publication must run even an empty known-bad answer against the real
/// check. Otherwise a check that always succeeds could pass publication.
pub async fn evaluate_reference(manifest: &BenchmarkDraft, patch: &str) -> Result<Evaluation> {
    let status = sandbox::ready()
        .await
        .map_err(|error| BenchmarkError::new("capability_missing", error.to_string()))?;
    let check = hidden_check(&manifest.evaluator)?;
    let snapshot = archive(&snapshot(manifest)?).await?;
    let package = check_archive(&snapshot, patch, &check)?;
    let id = format!("check-{}", uuid::Uuid::new_v4());
    let mut cleanup = sandbox::Cleanup(Some(id.clone()));
    let details = Some(
        serde_json::json!({"sandbox": sandbox::DISTRIBUTION, "runtimeRevision": status.revision, "checkId": id}),
    );
    let result = async {
        let prepared = sandbox::prepare_check(&id, &package)
            .await
            .map_err(sandbox_error)?;
        if prepared.code == Some(2) {
            return Ok(evaluation(
                manifest,
                "fail",
                0.0,
                prepared.reason(),
                details,
            ));
        }
        match sandbox::check(&id, &check.command, check.timeout_seconds).await {
            Ok(output) => {
                // A missing executable is an evaluator defect, not a model failure.
                if matches!(output.code, Some(126 | 127)) {
                    return Err(BenchmarkError::new("evaluation_error", output.reason()));
                }
                Ok(evaluation(
                    manifest,
                    if output.success() { "pass" } else { "fail" },
                    if output.success() { 1.0 } else { 0.0 },
                    output.reason(),
                    details,
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => Ok(evaluation(
                manifest,
                "fail",
                0.0,
                "The check exceeded its time limit".into(),
                details,
            )),
            Err(error) => Err(sandbox_error(error)),
        }
    }
    .await;
    sandbox::clean(&id).await.map_err(sandbox_error)?;
    cleanup.0 = None;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repository with a defect at its first commit and the fix at its
    /// second, as a task is cut from a real commit.
    async fn source(root: &Path) -> (Snapshot, String) {
        let repo = root.join("source");
        tokio::fs::create_dir_all(&repo).await.unwrap();
        git(&repo, &["init", "-q"], None).await.unwrap();
        tokio::fs::write(repo.join("sum.js"), "exports.sum = (a, b) => a - b;\n")
            .await
            .unwrap();
        let commit = |message: &'static str| {
            let repo = repo.clone();
            async move {
                git(&repo, &["add", "-A"], None).await.unwrap();
                git(
                    &repo,
                    &[
                        "-c",
                        "user.name=t",
                        "-c",
                        "user.email=t@t",
                        "commit",
                        "-q",
                        "-m",
                        message,
                    ],
                    None,
                )
                .await
                .unwrap();
            }
        };
        commit("defect").await;
        let head = String::from_utf8(git(&repo, &["rev-parse", "HEAD"], None).await.unwrap())
            .unwrap()
            .trim()
            .to_owned();
        let tree = String::from_utf8(
            git(&repo, &["rev-parse", "HEAD^{tree}"], None)
                .await
                .unwrap(),
        )
        .unwrap()
        .trim()
        .to_owned();
        tokio::fs::write(repo.join("sum.js"), "exports.sum = (a, b) => a + b;\n")
            .await
            .unwrap();
        commit("fix").await;
        let fix = String::from_utf8(
            git(&repo, &["diff", "--binary", "HEAD~1", "HEAD"], None)
                .await
                .unwrap(),
        )
        .unwrap();
        (
            Snapshot {
                path: repo,
                commit: head,
                tree,
            },
            fix,
        )
    }

    fn manifest(snapshot: &Snapshot) -> BenchmarkDraft {
        let mut draft = super::super::seeds::definitions().remove(0);
        draft.execution_profile = "protected_repository".into();
        draft.environment["repository"] = serde_json::json!({
            "path": snapshot.path, "commit": snapshot.commit, "tree": snapshot.tree,
        });
        draft.evaluator.kind = EVALUATOR.into();
        draft.evaluator.expected = serde_json::json!({
            "files": [{"path": "hidden/sum.test.js", "content":
                "const assert = require('node:assert');\nassert.strictEqual(require('../sum.js').sum(2, 3), 5);\n"}],
            "command": ["node", "hidden/sum.test.js"],
            "timeoutSeconds": 60,
        })
        .to_string();
        draft
    }

    #[tokio::test]
    #[ignore = "requires the provisioned distill-bench WSL distribution"]
    async fn a_copy_holds_the_snapshot_alone_and_the_check_scores_the_patch() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, fix) = source(root.path()).await;
        let mut draft = manifest(&snapshot);
        draft.evaluator.known_good.clone_from(&fix);
        assert!(validate(&draft).is_empty(), "{:?}", validate(&draft));
        // The working copy has the defect and one commit: the fix is nowhere.
        let copy = root.path().join("workspace");
        materialize(&snapshot, &copy).await.unwrap();
        let file = tokio::fs::read_to_string(copy.join("sum.js"))
            .await
            .unwrap();
        assert!(file.contains("a - b"));
        let log = git(&copy, &["log", "--oneline"], None).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&log).lines().count(), 1);
        assert!(!copy.join("hidden").exists());
        // Unchanged: no answer.
        let none = patch(&copy, 1 << 20).await.unwrap();
        let scored = evaluate_patch(&draft, &none).await.unwrap();
        assert_eq!(scored.verdict, NO_ANSWER);
        assert_eq!(scored.score, Some(0.0));
        // The candidate fixes the file and adds a note: the check passes.
        tokio::fs::write(copy.join("sum.js"), "exports.sum = (a, b) => a + b;\n")
            .await
            .unwrap();
        tokio::fs::write(copy.join("NOTES.md"), "fixed\n")
            .await
            .unwrap();
        let fixed = patch(&copy, 1 << 20).await.unwrap();
        assert!(fixed.contains("NOTES.md"));
        let scored = evaluate_patch(&draft, &fixed).await.unwrap();
        assert_eq!(scored.verdict, "pass", "{}", scored.reason);
        // A wrong change fails, and the reference patch passes.
        let wrong = fixed.replace("a + b", "a * b");
        let scored = evaluate_patch(&draft, &wrong).await.unwrap();
        assert_eq!(scored.verdict, "fail");
        let scored = evaluate_patch(&draft, &fix).await.unwrap();
        assert_eq!(scored.verdict, "pass", "{}", scored.reason);
        assert_eq!(scored.details.as_ref().unwrap()["sandbox"], "distill-bench");
        // An empty publication reference must actually fail the hidden check,
        // whereas an empty candidate answer is the no_answer outcome above.
        let scored = evaluate_reference(&draft, "").await.unwrap();
        assert_eq!(scored.verdict, "fail", "{}", scored.reason);
        let mut broken_check = draft.clone();
        broken_check.evaluator.expected = serde_json::json!({
            "files": [], "command": ["true"], "timeoutSeconds": 30,
        })
        .to_string();
        assert_eq!(
            evaluate_reference(&broken_check, "").await.unwrap().verdict,
            "pass"
        );
        // No check copy is left behind.
        let mut entries = tokio::fs::read_dir(root.path()).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            assert!(!entry.file_name().to_string_lossy().starts_with("check-"));
        }
    }

    #[tokio::test]
    async fn a_bare_snapshot_store_serves_copies() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, _) = source(root.path()).await;
        let store = root.path().join("snapshots.git");
        git(
            root.path(),
            &["init", "-q", "--bare", "snapshots.git"],
            None,
        )
        .await
        .unwrap();
        let path = snapshot.path.to_string_lossy().into_owned();
        let store_dir = store.to_string_lossy().into_owned();
        git(
            root.path(),
            &[
                "--git-dir",
                &store_dir,
                "fetch",
                "-q",
                &path,
                &snapshot.commit,
            ],
            None,
        )
        .await
        .unwrap();
        let stored = Snapshot {
            path: store,
            ..snapshot
        };
        let copy = root.path().join("copy");
        materialize(&stored, &copy).await.unwrap();
        assert!(tokio::fs::read_to_string(copy.join("sum.js"))
            .await
            .unwrap()
            .contains("a - b"));
    }
    #[tokio::test]
    async fn a_rewritten_snapshot_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let (mut snapshot, _) = source(root.path()).await;
        snapshot.tree = "0".repeat(40);
        let error = materialize(&snapshot, &root.path().join("copy"))
            .await
            .unwrap_err();
        assert_eq!(error.code, "evidence_missing");
    }

    #[test]
    fn snapshot_links_and_git_metadata_are_refused_before_root_extraction() {
        for (path, kind) in [
            ("linked", tar::EntryType::Symlink),
            ("pipe", tar::EntryType::Fifo),
            (".git/config", tar::EntryType::Regular),
        ] {
            let mut builder = tar::Builder::new(Vec::new());
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(kind);
            header.set_size(0);
            header.set_mode(0o644);
            if kind.is_symlink() {
                header.set_link_name("/etc").unwrap();
            }
            header.set_cksum();
            builder
                .append_data(&mut header, path, std::io::empty())
                .unwrap();
            assert!(validate_archive(&builder.into_inner().unwrap()).is_err());
        }
    }

    #[tokio::test]
    #[ignore = "requires the provisioned distill-bench WSL distribution"]
    async fn sandbox_checks_bound_output_kill_timeouts_and_reject_hidden_file_links() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, fix) = source(root.path()).await;
        let mut draft = manifest(&snapshot);
        draft.evaluator.expected = serde_json::json!({
            "files": [], "command": ["bash", "-c", "test $(id -un) = checker && test ! -e /mnt/c && python3 -c 'import sys; sys.stdout.write(\"o\" * 200000); sys.stderr.write(\"e\" * 200000)'"], "timeoutSeconds": 30,
        }).to_string();
        let scored = evaluate_reference(&draft, &fix).await.unwrap();
        assert_eq!(scored.verdict, "pass", "{}", scored.reason);
        assert!(scored.reason.len() <= 2_000);

        draft.evaluator.expected = serde_json::json!({
            "files": [], "command": ["bash", "-c", "setsid sleep 600 >/dev/null 2>&1 & sleep 600"], "timeoutSeconds": 3,
        }).to_string();
        let scored = evaluate_reference(&draft, &fix).await.unwrap();
        assert_eq!(scored.verdict, "fail");
        assert!(scored.reason.contains("time limit"));
        let id = scored.details.as_ref().unwrap()["checkId"]
            .as_str()
            .unwrap();
        let probe = sandbox::command(
            "bash",
            &[
                "-c",
                &format!(
            "test ! -e /sys/fs/cgroup/distill-bench/check-{id} && test ! -e /srv/bench/checks/{id}"
        ),
            ],
        )
        .output()
        .await
        .unwrap();
        assert!(
            probe.status.success(),
            "timeout left Linux processes or a workspace"
        );

        draft = manifest(&snapshot);
        // This only names a sandbox path. Root staging must refuse it before
        // copying a hidden file through the candidate's symlink.
        let linked = "diff --git a/hidden b/hidden\nnew file mode 120000\nindex 0000000..0000000\n--- /dev/null\n+++ b/hidden\n@@ -0,0 +1 @@\n+/tmp\n\\ No newline at end of file\n";
        let scored = evaluate_reference(&draft, linked).await.unwrap();
        assert_eq!(scored.verdict, "fail");
        assert!(
            scored.reason.contains("obstructs a hidden check"),
            "{}",
            scored.reason
        );
    }
}
