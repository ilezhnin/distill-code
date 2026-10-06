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
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
/// Why a repository case is not run yet: its candidate would work unattended
/// with tools on this machine, which waits for the operator's decision on
/// how such a session is confined.
pub const SESSION_UNAVAILABLE: &str = "Repository cases need an unattended session with tools, which is not enabled until its confinement is decided";
/// The outcome of a turn that left the snapshot as it was.
pub const NO_ANSWER: &str = "no_answer";
/// Output a check may print before its tail is kept as the reason.
const REASON_TAIL: usize = 2_000;

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
    if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(bytes).await?;
        stdin.shutdown().await?;
    }
    let output = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
        .await
        .map_err(|_| BenchmarkError::new("infrastructure_failure", "git did not finish"))??;
    if !output.status.success() {
        return Err(BenchmarkError::new(
            "infrastructure_failure",
            format!(
                "git {} failed: {}",
                args.first().unwrap_or(&""),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    Ok(output.stdout)
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

/// Writes the snapshot into `dir`, a new directory, as a repository of one
/// commit: the snapshot's files and nothing of the history behind them.
pub async fn materialize(snapshot: &Snapshot, dir: &Path) -> Result<()> {
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
    let archive = source_git(snapshot, &["archive", "--format=tar", &snapshot.commit]).await?;
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
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "read by the repository session once its confinement is decided"
    )
)]
pub async fn patch(dir: &Path, max_bytes: usize) -> Result<String> {
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

/// Scores `patch` against `manifest`'s hidden check in a fresh copy under
/// `scratch`, which it removes afterwards.
pub async fn evaluate_patch(
    manifest: &BenchmarkDraft,
    patch: &str,
    scratch: &Path,
) -> Result<Evaluation> {
    let evaluation = |verdict: &str, score: f64, reason: String| Evaluation {
        id: uuid::Uuid::new_v4().to_string(),
        evaluator_revision: manifest.evaluator.revision.clone(),
        verdict: verdict.into(),
        score: Some(score),
        reason,
        created_at: super::store::now(),
        provenance: "objective".into(),
        artifacts: vec![],
        details: None,
        judge: None,
        usage: None,
    };
    if patch.trim().is_empty() {
        return Ok(evaluation(
            NO_ANSWER,
            0.0,
            "The turn left the snapshot unchanged".into(),
        ));
    }
    let snapshot = snapshot(manifest)?;
    let check = hidden_check(&manifest.evaluator)?;
    let dir = scratch.join(format!("check-{}", uuid::Uuid::new_v4()));
    let result = async {
        materialize(&snapshot, &dir).await?;
        if let Err(error) = git(
            &dir,
            &["apply", "--whitespace=nowarn", "--binary", "-"],
            Some(patch.as_bytes()),
        )
        .await
        {
            return Ok(evaluation(
                "fail",
                0.0,
                format!(
                    "The patch does not apply to the snapshot: {}",
                    error.message
                ),
            ));
        }
        for file in &check.files {
            let path = dir.join(&file.path);
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(&path, file.content.as_bytes()).await?;
        }
        let (passed, tail) = run_check(&check, &dir).await?;
        Ok(if passed {
            evaluation("pass", 1.0, tail)
        } else {
            evaluation("fail", 0.0, tail)
        })
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&dir).await;
    result
}

/// Runs the check's command in `dir`; whether it exited 0, and the tail of
/// what it printed.
async fn run_check(check: &HiddenCheck, dir: &Path) -> Result<(bool, String)> {
    let mut command = tokio::process::Command::new(&check.command[0]);
    command
        .args(&check.command[1..])
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::services::process::apply_no_window_async(&mut command);
    let mut child = command.spawn().map_err(|error| {
        BenchmarkError::new(
            "evaluation_error",
            format!("The check command could not start: {error}"),
        )
    })?;
    let tree = crate::services::process::ProcessTree::contain(&child);
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let run = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        if let Some(stream) = stdout.as_mut() {
            stream.read_to_end(&mut out).await?;
        }
        if let Some(stream) = stderr.as_mut() {
            stream.read_to_end(&mut err).await?;
        }
        let status = child.wait().await?;
        out.extend_from_slice(&err);
        Ok::<_, BenchmarkError>((status.success(), out))
    };
    match tokio::time::timeout(Duration::from_secs(check.timeout_seconds), run).await {
        Ok(result) => {
            let (passed, output) = result?;
            let text = String::from_utf8_lossy(&output);
            let tail: String = text
                .chars()
                .rev()
                .take(REASON_TAIL)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            Ok((passed, tail.trim().to_owned()))
        }
        Err(_) => {
            if let Some(tree) = &tree {
                tree.kill();
            }
            Ok((false, "The check exceeded its time limit".into()))
        }
    }
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
        let scored = evaluate_patch(&draft, &none, root.path()).await.unwrap();
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
        let scored = evaluate_patch(&draft, &fixed, root.path()).await.unwrap();
        assert_eq!(scored.verdict, "pass", "{}", scored.reason);
        // A wrong change fails, and the reference patch passes.
        let wrong = fixed.replace("a + b", "a * b");
        let scored = evaluate_patch(&draft, &wrong, root.path()).await.unwrap();
        assert_eq!(scored.verdict, "fail");
        let scored = evaluate_patch(&draft, &fix, root.path()).await.unwrap();
        assert_eq!(scored.verdict, "pass", "{}", scored.reason);
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
}
