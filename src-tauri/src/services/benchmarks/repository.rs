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
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// The snapshot a repository case starts from.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// A local git repository that holds the commit.
    pub path: PathBuf,
    pub commit: String,
    /// The commit's tree, so a rewritten history is noticed before a turn.
    pub tree: String,
}

/// A sealed filesystem transition; `patch` is always relative to `root_tree`.
/// The native owner supplies the ordering of these records, never a renderer.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub recipe: String,
    pub root_tree: String,
    pub before_tree: String,
    pub after_tree: String,
    pub patch: String,
    pub patch_hash: String,
    pub archive_hash: String,
}

/// Immutable bytes for the next isolated working copy. These are persisted
/// with their native binding, not read later from a mutable candidate copy.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedArtifact {
    pub artifact: Artifact,
    pub archive: Vec<u8>,
}

pub const ARTIFACT_RECIPE: &str = "repository-cumulative-v1";
const MAX_ARTIFACT_PREDECESSORS: usize = 32;
const MAX_ARTIFACT_PACKAGE_BYTES: usize = 512 * 1024 * 1024;

fn object_id(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_artifact(snapshot: &Snapshot, artifact: &Artifact, max_bytes: usize) -> Result<()> {
    if artifact.recipe != ARTIFACT_RECIPE
        || artifact.root_tree != snapshot.tree
        || !object_id(&artifact.root_tree, snapshot.tree.len())
        || !object_id(&artifact.before_tree, snapshot.tree.len())
        || !object_id(&artifact.after_tree, snapshot.tree.len())
        || !object_id(&artifact.archive_hash, 64)
        || artifact.patch_hash != fixtures::hash(artifact.patch.as_bytes())
    {
        return Err(BenchmarkError::new(
            "evidence_missing",
            "Repository artifact identity or patch evidence differs",
        ));
    }
    if artifact.patch.len() > max_bytes {
        return Err(BenchmarkError::new(
            "budget_reached",
            "The cumulative patch exceeds the artifact budget",
        ));
    }
    Ok(())
}

fn validate_chain(snapshot: &Snapshot, predecessors: &[Artifact], max_bytes: usize) -> Result<()> {
    if predecessors.len() > MAX_ARTIFACT_PREDECESSORS {
        return Err(BenchmarkError::new(
            "validation",
            "Too many repository artifact predecessors",
        ));
    }
    let mut previous = snapshot.tree.as_str();
    for artifact in predecessors {
        validate_artifact(snapshot, artifact, max_bytes)?;
        if artifact.before_tree != previous {
            return Err(BenchmarkError::new(
                "evidence_missing",
                "Repository artifact predecessors diverge from their ordered lineage",
            ));
        }
        previous = &artifact.after_tree;
    }
    Ok(())
}

fn artifact_package(
    snapshot: &Snapshot,
    root_archive: &[u8],
    predecessors: &[Artifact],
    step_patch: &str,
    mode: &str,
    max_bytes: usize,
) -> Result<Vec<u8>> {
    if max_bytes == 0 || max_bytes > MAX_SNAPSHOT_BYTES || step_patch.len() > max_bytes {
        return Err(BenchmarkError::new(
            "budget_reached",
            "The repository artifact budget is invalid or exceeded",
        ));
    }
    let mut metadata = predecessors.to_vec();
    for artifact in &mut metadata {
        artifact.patch.clear();
    }
    let request = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 1, "rootTree": snapshot.tree, "maxBytes": max_bytes,
        "mode": mode, "predecessors": metadata,
    }))?;
    let total = predecessors
        .iter()
        .try_fold(
            root_archive
                .len()
                .saturating_add(request.len())
                .saturating_add(step_patch.len()),
            |bytes, artifact| bytes.checked_add(artifact.patch.len()),
        )
        .ok_or_else(|| {
            BenchmarkError::new("budget_reached", "Artifact package exceeds its byte limit")
        })?;
    if total > MAX_ARTIFACT_PACKAGE_BYTES - 64 * 1024 {
        return Err(BenchmarkError::new(
            "budget_reached",
            "Artifact package exceeds its byte limit",
        ));
    }
    let mut package = tar::Builder::new(Vec::new());
    append_file(&mut package, "request.json", &request)?;
    append_file(&mut package, "snapshot.tar", root_archive)?;
    append_file(&mut package, "step.patch", step_patch.as_bytes())?;
    for (index, artifact) in predecessors.iter().enumerate() {
        append_file(
            &mut package,
            &format!("predecessor-{index}.patch"),
            artifact.patch.as_bytes(),
        )?;
    }
    Ok(package.into_inner()?)
}

fn parse_artifact_result(
    snapshot: &Snapshot,
    bytes: &[u8],
    max_bytes: usize,
) -> Result<PreparedArtifact> {
    if bytes.len() > MAX_ARTIFACT_PACKAGE_BYTES {
        return Err(BenchmarkError::new(
            "budget_reached",
            "Artifact result exceeds its byte limit",
        ));
    }
    let mut files = std::collections::BTreeMap::new();
    for entry in tar::Archive::new(bytes).entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let name = path.to_str().unwrap_or_default();
        let cap = match name {
            "artifact.json" => 4096,
            "artifact.patch" => max_bytes,
            "snapshot.tar" => MAX_SNAPSHOT_BYTES,
            _ => {
                return Err(BenchmarkError::new(
                    "evidence_missing",
                    "Unexpected artifact result entry",
                ))
            }
        };
        if !entry.header().entry_type().is_file()
            || entry.size() > cap as u64
            || files.contains_key(name)
        {
            return Err(BenchmarkError::new(
                "evidence_missing",
                "Unsafe or over-budget artifact result entry",
            ));
        }
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut data)?;
        files.insert(name.to_owned(), data);
    }
    let missing = || BenchmarkError::new("evidence_missing", "Incomplete artifact result");
    let mut artifact: Artifact =
        serde_json::from_slice(files.get("artifact.json").ok_or_else(missing)?)?;
    if !artifact.patch.is_empty() {
        return Err(BenchmarkError::new(
            "evidence_missing",
            "Artifact metadata contains unbound patch bytes",
        ));
    }
    artifact.patch = String::from_utf8(files.remove("artifact.patch").ok_or_else(missing)?)
        .map_err(|_| BenchmarkError::new("evidence_missing", "Repository patch is not UTF-8"))?;
    let archive = files.remove("snapshot.tar").ok_or_else(missing)?;
    validate_artifact(snapshot, &artifact, max_bytes)?;
    validate_archive(&archive)?;
    if fixtures::hash(&archive) != artifact.archive_hash {
        return Err(BenchmarkError::new(
            "evidence_missing",
            "Repository artifact archive evidence differs",
        ));
    }
    Ok(PreparedArtifact { artifact, archive })
}

async fn transform_artifact(
    snapshot: &Snapshot,
    predecessors: &[Artifact],
    step_patch: &str,
    mode: &str,
    max_bytes: usize,
    deadline_ms: u64,
) -> Result<PreparedArtifact> {
    let remaining = |deadline: u64| -> Result<Duration> {
        deadline
            .checked_sub(super::store::now() as u64)
            .filter(|value| *value > 0)
            .map(Duration::from_millis)
            .ok_or_else(|| {
                BenchmarkError::new("budget_timeout", "Native repository deadline expired")
            })
    };
    let root_archive = tokio::time::timeout(remaining(deadline_ms)?, archive(snapshot))
        .await
        .map_err(|_| {
            BenchmarkError::new(
                "budget_timeout",
                "Native repository snapshot exceeded its remaining wall budget",
            )
        })??;
    let package = artifact_package(
        snapshot,
        &root_archive,
        predecessors,
        step_patch,
        mode,
        max_bytes,
    )?;
    remaining(deadline_ms)?;
    // Readiness hashes the actual helper. A changed artifact recipe therefore
    // changes the real sandbox runtime revision instead of relabeling old runs.
    sandbox::ready_until(deadline_ms).await.map_err(|error| {
        BenchmarkError::new(
            if error.kind() == std::io::ErrorKind::TimedOut {
                "budget_timeout"
            } else {
                "capability_missing"
            },
            error.to_string(),
        )
    })?;
    let id = format!("artifact-{}", uuid::Uuid::new_v4());
    let bytes = sandbox::artifact(&id, &package, deadline_ms)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                BenchmarkError::new(
                    "budget_timeout",
                    format!("Native repository operation: {error}"),
                )
            } else {
                sandbox_error(error)
            }
        })?;
    let result = parse_artifact_result(snapshot, &bytes, max_bytes)?;
    if mode == "advance" {
        if let Some(last) = predecessors.last() {
            if &result.artifact != last {
                return Err(BenchmarkError::new(
                    "evidence_missing",
                    "Repository artifact changed while reopening",
                ));
            }
        } else if result.artifact.before_tree != snapshot.tree
            || result.artifact.after_tree != snapshot.tree
            || !result.artifact.patch.is_empty()
        {
            return Err(BenchmarkError::new(
                "evidence_missing",
                "Repository root artifact differs",
            ));
        }
    } else if result.artifact.before_tree != predecessors[0].after_tree {
        return Err(BenchmarkError::new(
            "evidence_missing",
            "Repository artifact step starts from another tree",
        ));
    } else if step_patch.is_empty()
        && (result.artifact.after_tree != predecessors[0].after_tree
            || result.artifact.patch != predecessors[0].patch
            || result.artifact.patch_hash != predecessors[0].patch_hash
            || result.artifact.archive_hash != predecessors[0].archive_hash)
    {
        return Err(BenchmarkError::new(
            "evidence_missing",
            "A no-patch repository step changed its cumulative artifact",
        ));
    }
    Ok(result)
}

/// `access=[]` receives only the published root. With `access=all`, every
/// ordered predecessor is reverified from root-relative cumulative bytes.
#[cfg(test)]
pub async fn advance(
    snapshot: &Snapshot,
    predecessors: &[Artifact],
    access_all: bool,
    max_bytes: usize,
) -> Result<PreparedArtifact> {
    advance_until(
        snapshot,
        predecessors,
        access_all,
        max_bytes,
        (super::store::now() as u64).saturating_add(110_000),
    )
    .await
}

/// Native root/step leases supply their absolute expiry before any preparation.
pub async fn advance_until(
    snapshot: &Snapshot,
    predecessors: &[Artifact],
    access_all: bool,
    max_bytes: usize,
    deadline_ms: u64,
) -> Result<PreparedArtifact> {
    let visible = if access_all { predecessors } else { &[] };
    validate_chain(snapshot, visible, max_bytes)?;
    transform_artifact(snapshot, visible, "", "advance", max_bytes, deadline_ms).await
}

/// Seal a step-relative patch against `before.after_tree`. No-op review/QA
/// keeps the cumulative filesystem bytes but records an equal-tree transition.
#[cfg(test)]
pub async fn seal(
    snapshot: &Snapshot,
    before: &Artifact,
    step_patch: &str,
    max_bytes: usize,
) -> Result<PreparedArtifact> {
    seal_until(
        snapshot,
        before,
        step_patch,
        max_bytes,
        (super::store::now() as u64).saturating_add(110_000),
    )
    .await
}

pub async fn seal_until(
    snapshot: &Snapshot,
    before: &Artifact,
    step_patch: &str,
    max_bytes: usize,
    deadline_ms: u64,
) -> Result<PreparedArtifact> {
    validate_artifact(snapshot, before, max_bytes)?;
    transform_artifact(
        snapshot,
        std::slice::from_ref(before),
        step_patch,
        "seal",
        max_bytes,
        deadline_ms,
    )
    .await
}

/// The files of the final tree of an ordered cumulative chain. The tree is
/// regenerated from the published root and the sealed bytes through the same
/// helper that prepared each step; no candidate copy or conductor folder is read.
pub async fn final_tree_files(
    snapshot: &Snapshot,
    chain: &[Artifact],
    max_bytes: usize,
    deadline_ms: u64,
) -> Result<std::collections::BTreeSet<String>> {
    let Some(last) = chain.last() else {
        return Err(BenchmarkError::new(
            "validation",
            "A final tree needs at least one sealed repository artifact",
        ));
    };
    let prepared = advance_until(snapshot, chain, true, max_bytes, deadline_ms).await?;
    if &prepared.artifact != last {
        return Err(BenchmarkError::new(
            "evidence_missing",
            "The regenerated repository tree differs from its sealed artifact",
        ));
    }
    archive_files(&prepared.archive)
}

fn archive_files(bytes: &[u8]) -> Result<std::collections::BTreeSet<String>> {
    let mut files = std::collections::BTreeSet::new();
    for entry in tar::Archive::new(bytes).entries()? {
        let entry = entry?;
        if entry.header().entry_type().is_file() {
            let path = entry.path()?;
            files.insert(path.to_string_lossy().trim_start_matches("./").to_owned());
        }
    }
    Ok(files)
}

/// A reported artifact path as a path inside the task's repository copy, or
/// `None` when it cannot name a file there (a URI, a home path, a path
/// outside the copy). A trailing `:line` or `:line:col` citation is dropped.
pub fn workspace_relative(reported: &str) -> Option<String> {
    let mut path = reported.trim();
    if path.is_empty() || path.starts_with('~') || path.contains("://") {
        return None;
    }
    for _ in 0..2 {
        match path.rsplit_once(':') {
            Some((head, tail))
                if !head.is_empty()
                    && !tail.is_empty()
                    && tail.bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                path = head;
            }
            _ => break,
        }
    }
    let path = path.replace('\\', "/");
    let path = path.strip_prefix("/workspace/").unwrap_or(&path);
    let path = path.trim_start_matches("./");
    fixtures::safe_relative(path).then(|| path.to_owned())
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
    /// A separate untrusted process that receives only public probe inputs.
    /// The check reads the submitted files as data and executes code only in
    /// this process through DISTILL_BENCH_RPC_FD. The probe never sees checks.
    /// DISTILL_BENCH_ARTIFACT_FD is a check-only JSON-lines channel: send
    /// {"path":"relative/file"}; receive base64 {"data":"..."} or an error.
    /// It reads actual probe files without following links, up to 8 MiB each.
    /// {"path":"relative/file","op":"range","offset":0,"length":1024}
    /// reads exactly that byte range and returns data plus the full file size.
    /// Offset is an integer from 0 to 2^63-1; length is an integer from 0 to
    /// 8 MiB. The range must lie within the file; zero length at EOF is valid.
    /// Range reads allow larger files, retaining the same regular-file and link
    /// checks. The check must ensure quiescence before a multi-call reconstruction.
    /// {"path":"relative/entry","op":"stat"} instead returns metadata with
    /// kind, mode, size, links and (for symlinks) targetBase64, without following
    /// the final link. Each response pins one entry, not a multi-call snapshot.
    /// {"path":"relative/dir","op":"list"} returns sorted base64 child names
    /// in entries, capped at 1024 names / 256 KiB raw name bytes, without traversal.
    #[serde(default)]
    pub probe: Option<CheckProbe>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckProbe {
    /// Public driver files installed beside the submitted repository.
    #[serde(default)]
    pub files: Vec<Fixture>,
    pub command: Vec<String>,
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
    if !valid_command(&check.command)
        || check
            .probe
            .as_ref()
            .is_some_and(|p| !valid_command(&p.command))
    {
        return Err(BenchmarkError::new(
            "validation",
            "A repository check and each probe need a bounded command without NUL bytes",
        ));
    }
    if check
        .files
        .iter()
        .chain(check.probe.iter().flat_map(|p| &p.files))
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

fn valid_command(argv: &[String]) -> bool {
    !argv.is_empty()
        && argv.len() <= 256
        && !argv[0].trim().is_empty()
        && argv.iter().all(|arg| !arg.contains('\0'))
        && argv.iter().map(String::len).sum::<usize>() <= 32 * 1024
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
    if let Some(issue) = permission_issue(draft) {
        issues.push(issue);
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

/// Native shell tools share the candidate's public-internet namespace.
/// This fixed profile cannot honestly promise a narrower per-case policy.
pub fn permission_issue(draft: &BenchmarkDraft) -> Option<String> {
    let mut tools: Vec<&str> = draft.permissions.tools.iter().map(String::as_str).collect();
    tools.sort_unstable();
    (tools != ["filesystem", "terminal"]
        || !draft.permissions.network
        || draft.permissions.context != "clean")
        .then(|| "Repository execution requires filesystem and terminal tools, public network access and clean context; a narrower policy is unavailable".into())
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

/// Bound only the trusted local Git exporter; no candidate command runs here.
pub async fn archive_until(snapshot: &Snapshot, deadline_ms: u64) -> Result<Vec<u8>> {
    let remaining = deadline_ms
        .checked_sub(super::store::now() as u64)
        .filter(|remaining| *remaining > 0)
        .ok_or_else(|| {
            BenchmarkError::new("budget_timeout", "Native repository deadline expired")
        })?;
    tokio::time::timeout(Duration::from_millis(remaining), archive(snapshot))
        .await
        .map_err(|_| {
            BenchmarkError::new(
                "budget_timeout",
                "Native repository snapshot exceeded its remaining wall budget",
            )
        })?
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
    if let Some(probe) = &check.probe {
        append_file(
            &mut builder,
            "probe.json",
            &serde_json::to_vec(&serde_json::json!({"command": probe.command}))?,
        )?;
        for file in &probe.files {
            append_file(
                &mut builder,
                &format!("probe/{}", file.path),
                file.content.as_bytes(),
            )?;
        }
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

    #[tokio::test]
    #[ignore = "requires the reviewed bench-artifact helper in the existing distill-bench WSL distribution"]
    async fn cumulative_artifacts_use_the_actual_root_helper_transport_and_reopen_immutable_bytes()
    {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, fix) = source(root.path()).await;
        let base = advance(&snapshot, &[], false, 1 << 20).await.unwrap();
        let implemented = seal(&snapshot, &base.artifact, &fix, 1 << 20)
            .await
            .unwrap();
        let review = seal(&snapshot, &implemented.artifact, "", 1 << 20)
            .await
            .unwrap();
        let qa = seal(&snapshot, &review.artifact, "", 1 << 20)
            .await
            .unwrap();
        assert_eq!(implemented.artifact.after_tree, review.artifact.before_tree);
        assert_eq!(review.archive, implemented.archive);
        assert_eq!(review.artifact.patch, implemented.artifact.patch);
        assert_eq!(qa, review);
        let reopened = advance(
            &snapshot,
            &[
                implemented.artifact.clone(),
                review.artifact.clone(),
                qa.artifact.clone(),
            ],
            true,
            1 << 20,
        )
        .await
        .unwrap();
        assert_eq!(reopened, review);
        let final_files = final_tree_files(
            &snapshot,
            &[
                implemented.artifact.clone(),
                review.artifact.clone(),
                qa.artifact.clone(),
            ],
            1 << 20,
            (super::super::store::now() as u64).saturating_add(110_000),
        )
        .await
        .unwrap();
        assert!(final_files.contains("sum.js"));
        assert_eq!(
            advance(&snapshot, &[implemented.artifact], false, 1 << 20)
                .await
                .unwrap(),
            base
        );
        let mut corrupt = review.artifact;
        corrupt.archive_hash = "0".repeat(64);
        assert!(seal(&snapshot, &corrupt, "", 1 << 20).await.is_err());
        assert!(git(&snapshot.path, &["status", "--porcelain"], None)
            .await
            .unwrap()
            .is_empty());
        println!("Actual WSL root helper/transport: cumulative implement->no-patch review->QA, immutable reopen/root access[] and corrupt archive refusal PASS");
    }

    // Execute the same object/index implementation with invented local data.
    // Only the privileged WSL entrypoint is omitted; no candidate/check runs.
    async fn local_artifact(
        snapshot: &Snapshot,
        predecessors: &[Artifact],
        step: &str,
        mode: &str,
        max_bytes: usize,
    ) -> Result<PreparedArtifact> {
        let root = tempfile::tempdir()?;
        let package = artifact_package(
            snapshot,
            &archive(snapshot).await?,
            predecessors,
            step,
            mode,
            max_bytes,
        )?;
        let mut command =
            tokio::process::Command::new(if cfg!(windows) { "python" } else { "python3" });
        command.args([
            "-c", "import runpy,sys; from pathlib import Path; helper=runpy.run_path(sys.argv[1]); sys.stdout.buffer.write(helper['transform'](sys.stdin.buffer.read(),Path(sys.argv[2])))",
            concat!(env!("CARGO_MANIFEST_DIR"), "/resources/benchmark-sandbox/bench-artifact"),
        ]).arg(root.path())
            .env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", "diff.external")
            .env("GIT_CONFIG_VALUE_0", "forbidden-artifact-external-driver")
            .env("GIT_CONFIG_KEY_1", "core.fsmonitor")
            .env("GIT_CONFIG_VALUE_1", "forbidden-artifact-fsmonitor")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        crate::services::process::apply_no_window_async(&mut command);
        let mut child = command.spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        let (written, output) = tokio::join!(
            async {
                stdin.write_all(&package).await?;
                stdin.shutdown().await?;
                drop(stdin);
                Ok::<_, std::io::Error>(())
            },
            child.wait_with_output()
        );
        let output = output?;
        if !output.status.success() {
            return Err(BenchmarkError::new(
                "evidence_missing",
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ));
        }
        written?;
        parse_artifact_result(snapshot, &output.stdout, max_bytes)
    }

    async fn local_advance(
        snapshot: &Snapshot,
        predecessors: &[Artifact],
        access_all: bool,
        max_bytes: usize,
    ) -> Result<PreparedArtifact> {
        let visible = if access_all { predecessors } else { &[] };
        validate_chain(snapshot, visible, max_bytes)?;
        local_artifact(snapshot, visible, "", "advance", max_bytes).await
    }

    async fn local_seal(
        snapshot: &Snapshot,
        before: &Artifact,
        step: &str,
        max_bytes: usize,
    ) -> Result<PreparedArtifact> {
        validate_artifact(snapshot, before, max_bytes)?;
        local_artifact(
            snapshot,
            std::slice::from_ref(before),
            step,
            "seal",
            max_bytes,
        )
        .await
    }

    fn file_from_archive(archive: &[u8], path: &str) -> Vec<u8> {
        for entry in tar::Archive::new(archive).entries().unwrap() {
            let mut entry = entry.unwrap();
            if entry.path().unwrap() == Path::new(path) {
                let mut bytes = Vec::new();
                std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
                return bytes;
            }
        }
        panic!("missing artifact file {path}");
    }

    #[tokio::test]
    async fn artifact_helper_bounds_git_output_blob_reads_and_tar_overhead() {
        let root = tempfile::tempdir().unwrap();
        let script = r#"import runpy, sys
from pathlib import Path
h = runpy.run_path(sys.argv[1])
objects = h['Objects'](Path(sys.argv[2]), '0' * 40)
blob = objects.git('hash-object', '-w', '--stdin', data=b'x' * 32768).strip()
objects.git('update-index', '-z', '--index-info', data=b'100644 ' + blob + b'\tfile.txt\0')
tree = objects.tree()
try:
    objects.git('cat-file', 'blob', blob.decode(), limit=16)
except ValueError as error:
    assert 'output exceeds' in str(error)
else:
    raise AssertionError('Git output limit was not enforced')
calls = []
original = objects.git
def observed(*args, **kwargs):
    calls.append(args)
    return original(*args, **kwargs)
objects.git = observed
h['Objects'].__init__.__globals__['MAX_ARCHIVE'] = 16
try:
    objects.export(tree, tree, 1024)
except ValueError as error:
    assert 'contents exceed' in str(error)
else:
    raise AssertionError('Oversized blob was accepted')
assert not any(call[:2] == ('cat-file', 'blob') for call in calls)
try:
    h['pack_files']([(f'file{i}', b'', 0o644) for i in range(32)], 10240)
except ValueError as error:
    assert 'byte limit' in str(error)
else:
    raise AssertionError('Tar header overhead escaped its limit')
"#;
        let mut command =
            tokio::process::Command::new(if cfg!(windows) { "python" } else { "python3" });
        command
            .args([
                "-c",
                script,
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/resources/benchmark-sandbox/bench-artifact"
                ),
            ])
            .arg(root.path())
            .kill_on_drop(true);
        crate::services::process::apply_no_window_async(&mut command);
        let output = command.output().await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn cumulative_artifacts_preserve_implementation_through_no_patch_review_and_qa() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, fix) = source(root.path()).await;
        let original = git(&snapshot.path, &["rev-parse", "HEAD"], None)
            .await
            .unwrap();
        let base = local_advance(&snapshot, &[], false, 1 << 20).await.unwrap();
        assert_eq!(base.artifact.before_tree, snapshot.tree);
        assert_eq!(base.artifact.after_tree, snapshot.tree);
        assert!(base.artifact.patch.is_empty());
        let implemented = local_seal(&snapshot, &base.artifact, &fix, 1 << 20)
            .await
            .unwrap();
        assert_eq!(implemented.artifact.before_tree, snapshot.tree);
        assert_ne!(implemented.artifact.after_tree, snapshot.tree);
        assert_eq!(
            file_from_archive(&implemented.archive, "sum.js"),
            b"exports.sum = (a, b) => a + b;\n"
        );
        let reviewed = local_seal(&snapshot, &implemented.artifact, "", 1 << 20)
            .await
            .unwrap();
        assert_eq!(
            reviewed.artifact.before_tree,
            implemented.artifact.after_tree
        );
        assert_eq!(
            reviewed.artifact.after_tree,
            implemented.artifact.after_tree
        );
        assert_eq!(reviewed.artifact.patch, implemented.artifact.patch);
        assert_eq!(
            reviewed.artifact.patch_hash,
            implemented.artifact.patch_hash
        );
        assert_eq!(reviewed.archive, implemented.archive);
        assert_eq!(
            reviewed.artifact.archive_hash,
            implemented.artifact.archive_hash
        );
        let qa = local_seal(&snapshot, &reviewed.artifact, "", 1 << 20)
            .await
            .unwrap();
        assert_eq!(qa, reviewed);
        let reopened = local_advance(
            &snapshot,
            &[
                implemented.artifact.clone(),
                reviewed.artifact.clone(),
                qa.artifact,
            ],
            true,
            1 << 20,
        )
        .await
        .unwrap();
        assert_eq!(reopened, reviewed);
        assert_eq!(
            archive_files(&reopened.archive).unwrap(),
            ["sum.js".to_owned()].into()
        );
        let isolated = local_advance(&snapshot, &[implemented.artifact], false, 1 << 20)
            .await
            .unwrap();
        assert_eq!(isolated, base);
        assert_eq!(
            git(&snapshot.path, &["rev-parse", "HEAD"], None)
                .await
                .unwrap(),
            original
        );
        assert!(git(&snapshot.path, &["status", "--porcelain"], None)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn reported_paths_resolve_inside_the_task_copy_only() {
        for (reported, expected) in [
            ("src/sum.js", Some("src/sum.js")),
            ("./src/sum.js:12", Some("src/sum.js")),
            ("src\\sum.js:12:4", Some("src/sum.js")),
            ("/workspace/src/sum.js", Some("src/sum.js")),
            ("  sum.js  ", Some("sum.js")),
            ("/etc/passwd", None),
            ("C:/invented/sum.js", None),
            ("../outside.js", None),
            ("~/notes.md", None),
            ("https://example.invalid/run/1", None),
            ("", None),
        ] {
            assert_eq!(
                workspace_relative(reported).as_deref(),
                expected,
                "{reported}"
            );
        }
    }

    #[tokio::test]
    async fn cumulative_step_uses_the_predecessor_tree_and_refuses_divergence_and_corruption() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, fix) = source(root.path()).await;
        let base = local_advance(&snapshot, &[], true, 1 << 20).await.unwrap();
        let first = local_seal(&snapshot, &base.artifact, &fix, 1 << 20)
            .await
            .unwrap();
        let next_patch = "diff --git a/sum.js b/sum.js\n--- a/sum.js\n+++ b/sum.js\n@@ -1 +1,2 @@\n exports.sum = (a, b) => a + b;\n+exports.checked = true;\n";
        let second = local_seal(&snapshot, &first.artifact, next_patch, 1 << 20)
            .await
            .unwrap();
        assert_eq!(second.artifact.before_tree, first.artifact.after_tree);
        assert_ne!(second.artifact.after_tree, first.artifact.after_tree);
        assert!(second.artifact.patch.contains("+exports.checked = true;"));
        assert!(!second
            .artifact
            .patch
            .contains(" exports.sum = (a, b) => a + b;"));
        assert!(local_seal(&snapshot, &base.artifact, next_patch, 1 << 20)
            .await
            .is_err());
        assert!(local_seal(&snapshot, &first.artifact, &fix, 1 << 20)
            .await
            .is_err());
        let reopened = local_advance(
            &snapshot,
            &[first.artifact.clone(), second.artifact.clone()],
            true,
            1 << 20,
        )
        .await
        .unwrap();
        assert_eq!(reopened, second);
        let mut divergent = second.artifact.clone();
        divergent.before_tree.clone_from(&snapshot.tree);
        assert!(local_advance(
            &snapshot,
            &[first.artifact.clone(), divergent],
            true,
            1 << 20
        )
        .await
        .is_err());
        for field in ["patch", "archive", "after", "root"] {
            let mut corrupt = first.artifact.clone();
            match field {
                "patch" => corrupt.patch.push('!'),
                "archive" => corrupt.archive_hash = "0".repeat(64),
                "after" => corrupt.after_tree = "0".repeat(40),
                _ => corrupt.root_tree = "0".repeat(40),
            }
            assert!(
                local_advance(&snapshot, &[corrupt], true, 1 << 20)
                    .await
                    .is_err(),
                "accepted corrupt {field}"
            );
        }
        assert!(local_seal(&snapshot, &base.artifact, &fix, 8)
            .await
            .is_err());
        let mut wrong_root = snapshot.clone();
        wrong_root.tree = "0".repeat(40);
        assert!(local_advance(&wrong_root, &[], false, 1 << 20)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cumulative_artifacts_refuse_symlinks_gitlinks_and_metadata_paths() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, _) = source(root.path()).await;
        let base = local_advance(&snapshot, &[], true, 1 << 20).await.unwrap();
        for patch in [
            "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n".to_owned(),
            format!("diff --git a/module b/module\nnew file mode 160000\n--- /dev/null\n+++ b/module\n@@ -0,0 +1 @@\n+Subproject commit {}\n", snapshot.commit),
            "diff --git a/.git/config b/.git/config\nnew file mode 100644\n--- /dev/null\n+++ b/.git/config\n@@ -0,0 +1 @@\n+[core]\n".to_owned(),
            "diff --git a/../escape b/../escape\nnew file mode 100644\n--- /dev/null\n+++ b/../escape\n@@ -0,0 +1 @@\n+escape\n".to_owned(),
        ] {
            assert!(local_seal(&snapshot, &base.artifact, &patch, 1 << 20).await.is_err());
        }
        assert!(git(&snapshot.path, &["status", "--porcelain"], None)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn cumulative_archive_preserves_binary_files_and_executable_modes() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, _) = source(root.path()).await;
        tokio::fs::write(snapshot.path.join("binary.dat"), [0, 255, 1, 128])
            .await
            .unwrap();
        tokio::fs::write(snapshot.path.join("entry.sh"), "#!/bin/sh\necho invented\n")
            .await
            .unwrap();
        tokio::fs::create_dir(snapshot.path.join("λ space"))
            .await
            .unwrap();
        tokio::fs::write(snapshot.path.join("λ space/雪.txt"), "invented unicode\n")
            .await
            .unwrap();
        tokio::fs::write(snapshot.path.join("literal.txt"), "$Format:%H$\n")
            .await
            .unwrap();
        tokio::fs::write(
            snapshot.path.join(".gitattributes"),
            "entry.sh filter=deny diff=deny\nliteral.txt export-subst\n",
        )
        .await
        .unwrap();
        git(&snapshot.path, &["add", "-A"], None).await.unwrap();
        git(
            &snapshot.path,
            &["update-index", "--chmod=+x", "entry.sh"],
            None,
        )
        .await
        .unwrap();
        git(
            &snapshot.path,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                "invented files",
            ],
            None,
        )
        .await
        .unwrap();
        let mut snapshot = snapshot;
        snapshot.commit = String::from_utf8(
            git(&snapshot.path, &["rev-parse", "HEAD"], None)
                .await
                .unwrap(),
        )
        .unwrap()
        .trim()
        .into();
        snapshot.tree = String::from_utf8(
            git(&snapshot.path, &["rev-parse", "HEAD^{tree}"], None)
                .await
                .unwrap(),
        )
        .unwrap()
        .trim()
        .into();
        let base = local_advance(&snapshot, &[], true, 1 << 20).await.unwrap();
        assert_eq!(base.artifact.after_tree, snapshot.tree);
        assert_eq!(
            file_from_archive(&base.archive, "binary.dat"),
            [0, 255, 1, 128]
        );
        assert_eq!(
            file_from_archive(&base.archive, "λ space/雪.txt"),
            b"invented unicode\n"
        );
        assert_eq!(
            file_from_archive(&base.archive, "literal.txt"),
            b"$Format:%H$\n"
        );
        let mut archive = tar::Archive::new(base.archive.as_slice());
        let executable = archive
            .entries()
            .unwrap()
            .map(|e| e.unwrap())
            .find(|e| e.path().unwrap() == Path::new("entry.sh"))
            .unwrap();
        assert_eq!(executable.header().mode().unwrap(), 0o755);
        assert_eq!(
            local_seal(&snapshot, &base.artifact, "", 1 << 20)
                .await
                .unwrap(),
            base
        );
        tokio::fs::write(snapshot.path.join("binary.dat"), [0, 128, 255, 42, 0])
            .await
            .unwrap();
        let binary_patch = String::from_utf8(
            git(&snapshot.path, &["diff", "--binary", "HEAD"], None)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(binary_patch.contains("GIT binary patch"));
        let changed = local_seal(&snapshot, &base.artifact, &binary_patch, 1 << 20)
            .await
            .unwrap();
        assert_eq!(
            file_from_archive(&changed.archive, "binary.dat"),
            [0, 128, 255, 42, 0]
        );
        assert_eq!(
            local_advance(
                &snapshot,
                std::slice::from_ref(&changed.artifact),
                true,
                1 << 20
            )
            .await
            .unwrap(),
            changed
        );
    }

    #[tokio::test]
    async fn cumulative_artifacts_refuse_git_archive_attribute_transformations() {
        let root = tempfile::tempdir().unwrap();
        let (mut snapshot, _) = source(root.path()).await;
        tokio::fs::write(
            snapshot.path.join(".gitattributes"),
            "sum.js export-ignore\n",
        )
        .await
        .unwrap();
        git(&snapshot.path, &["add", "-A"], None).await.unwrap();
        git(
            &snapshot.path,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-qm",
                "archive attributes",
            ],
            None,
        )
        .await
        .unwrap();
        snapshot.commit = String::from_utf8(
            git(&snapshot.path, &["rev-parse", "HEAD"], None)
                .await
                .unwrap(),
        )
        .unwrap()
        .trim()
        .into();
        snapshot.tree = String::from_utf8(
            git(&snapshot.path, &["rev-parse", "HEAD^{tree}"], None)
                .await
                .unwrap(),
        )
        .unwrap()
        .trim()
        .into();
        let error = local_advance(&snapshot, &[], true, 1 << 20)
            .await
            .unwrap_err();
        assert!(
            error.message.contains("published root tree"),
            "{}",
            error.message
        );
    }

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
        draft.permissions.tools = vec!["filesystem".into(), "terminal".into()];
        draft.permissions.network = true;
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

    #[test]
    fn isolated_probe_commands_and_paths_are_validated() {
        let mut evaluator = super::super::seeds::definitions().remove(0).evaluator;
        let valid = serde_json::json!({
            "command": ["python3", "hidden/check.py"],
            "files": [{"path": "hidden/check.py", "content": "pass"}],
            "probe": {"command": ["node", "driver.mjs"], "files": [{"path": "driver.mjs", "content": ""}]},
        });
        evaluator.expected = valid.to_string();
        assert!(hidden_check(&evaluator).unwrap().probe.is_some());
        for command in [
            serde_json::json!([]),
            serde_json::json!([" "]),
            serde_json::json!(["node", "\0"]),
            serde_json::json!(["x".repeat(32769)]),
        ] {
            let mut invalid = valid.clone();
            invalid["probe"]["command"] = command;
            evaluator.expected = invalid.to_string();
            assert!(hidden_check(&evaluator).is_err());
        }
        let mut invalid = valid;
        invalid["probe"]["files"][0]["path"] = "../escape".into();
        evaluator.expected = invalid.to_string();
        assert!(hidden_check(&evaluator).is_err());
    }

    #[tokio::test]
    #[ignore = "requires the provisioned distill-bench WSL distribution"]
    async fn isolated_verdict_cannot_be_rewritten_by_submitted_code() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, fix) = source(root.path()).await;
        let mut draft = manifest(&snapshot);
        draft.evaluator.expected = serde_json::json!({
            "files": [{"path":"hidden/check.py", "content": r#"import base64,json,os,socket
from pathlib import Path
assert not Path('sum.js').exists()
assert Path('/submission/sum.js').is_file()
channel=socket.socket(fileno=int(os.environ['DISTILL_BENCH_RPC_FD'])).makefile('rwb')
channel.write(b'{"a":17,"b":29}\n');channel.flush()
assert json.loads(channel.readline(1024)) == 46
artifacts=socket.socket(fileno=int(os.environ['DISTILL_BENCH_ARTIFACT_FD'])).makefile('rwb')
artifacts.write(b'{"path":"actual.txt"}\n');artifacts.flush()
assert base64.b64decode(json.loads(artifacts.readline(1024))['data']) == b'46'
artifacts.write(b'{"path":"actual.txt","op":"range","offset":1,"length":1}\n');artifacts.flush()
assert json.loads(artifacts.readline(1024)) == {'data':'Ng==','size':2}
artifacts.write(b'{"path":"actual.txt","op":"stat"}\n');artifacts.flush()
assert json.loads(artifacts.readline(1024))['metadata'] == {'kind':'file','mode':384,'size':2,'links':1}
artifacts.write(b'{"path":"unresolved-link","op":"stat"}\n');artifacts.flush()
link=json.loads(artifacts.readline(1024))['metadata']
assert link['kind']=='symlink' and base64.b64decode(link['targetBase64'])==b'/private-not-present'
print('Independent verdict passed')
"#}],
            "command": ["python3", "hidden/check.py"],
            "timeoutSeconds": 15,
            "probe": {"command":["node","driver.cjs"],"files":[{"path":"driver.cjs","content":r#"const net=require('node:net');
const {sum}=require('./sum.js');
if (process.env.DISTILL_BENCH_ARTIFACT_FD) throw Error('Trusted artifact channel leaked');
require('node:fs').symlinkSync('/private-not-present','unresolved-link');
const socket=new net.Socket({fd:Number(process.env.DISTILL_BENCH_RPC_FD),readable:true,writable:true});
require('node:readline').createInterface({input:socket}).on('line',line=>{const {a,b}=JSON.parse(line);const result=sum(a,b);require('node:fs').writeFileSync('actual.txt',String(result),{mode:0o600});socket.write(JSON.stringify(result)+'\n');});
"#}]},
        }).to_string();
        assert_eq!(
            evaluate_reference(&draft, &fix).await.unwrap().verdict,
            "pass"
        );
        assert_eq!(
            evaluate_reference(&draft, "").await.unwrap().verdict,
            "fail"
        );
        // Same wrong implementation, plus the previously successful attack.
        let attack = "diff --git a/sum.js b/sum.js\n--- a/sum.js\n+++ b/sum.js\n@@ -1 +1,2 @@\n+require('node:assert/strict').equal = () => {};\n exports.sum = (a, b) => a - b;\n";
        let verdict = evaluate_reference(&draft, attack).await.unwrap();
        assert_eq!(verdict.verdict, "fail", "{}", verdict.reason);
        let id = verdict.details.unwrap()["checkId"]
            .as_str()
            .unwrap()
            .to_owned();
        let result = sandbox::command("python3", &["-c", &format!("from pathlib import Path; assert all(not (Path('/srv/bench')/d/'{id}').exists() for d in ['checks','probes','submissions']); assert not Path('/srv/bench/pairs/{id}.json').exists()")]).output().await.unwrap();
        assert!(result.status.success());
    }

    #[test]
    fn repository_permissions_must_describe_the_enforced_profile() {
        let mut draft = super::super::seeds::definitions().remove(0);
        assert!(permission_issue(&draft).is_some());
        draft.permissions.tools = vec!["terminal".into(), "filesystem".into()];
        draft.permissions.network = true;
        assert!(permission_issue(&draft).is_none());
        draft.permissions.network = false;
        assert!(permission_issue(&draft).is_some());
        draft.permissions.network = true;
        draft.permissions.tools.push("delegation".into());
        assert!(permission_issue(&draft).is_some());
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
