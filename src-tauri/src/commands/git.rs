use serde::Serialize;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

use crate::services::{dir_env, env_key};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    pub is_git_repo: bool,
    pub current_branch: Option<String>,
    pub dirty_file_count: u32,
    pub incoming_commit_count: u32,
    pub worktrees: Vec<WorktreeInfo>,
    pub is_worktree: bool,
    pub main_worktree_path: Option<String>,
    pub local_branches: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub is_main: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorktree {
    pub path: String,
    pub branch: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStateChangedPayload {
    operation: &'static str,
    path: String,
    affected_paths: Vec<String>,
    branch: Option<String>,
}

const GIT_STATE_CHANGED_EVENT: &str = "flock:git-state-changed";
pub(crate) const GIT_READ_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const GIT_STATUS_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const GIT_MUTATING_COMMAND_TIMEOUT: Duration = Duration::from_secs(300);
// Large monorepo worktrees can legitimately spend 5–10 minutes checking out
// (LFS smudge filters, huge trees); keep other Git mutations on the shorter
// cap. Repository hooks do not run here — see `git_hardening_args`.
const GIT_WORKTREE_CREATE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const GIT_STATE_OPERATION_TIMEOUT: Duration = Duration::from_secs(90);

fn dir_env_capture_timeout(command_timeout: Duration) -> Duration {
    command_timeout
        .checked_add(command_timeout / 2)
        .unwrap_or(command_timeout)
        .min(GIT_MUTATING_COMMAND_TIMEOUT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnvSource {
    /// Try the inherited environment first and retry with captured env only for
    /// failures that plausibly depend on directory-scoped shell activation.
    Smart,
    /// Inherited process env with repository-targeting Git controls stripped.
    Lite,
    /// Per-directory interactive-login-shell env; falls back to Lite on
    /// capture failure.
    Captured,
}

enum GitRunError {
    TimedOut,
    Spawn(io::Error),
}

#[tauri::command]
pub async fn get_git_state(path: String) -> Result<GitState, String> {
    match timeout(GIT_STATE_OPERATION_TIMEOUT, get_git_state_inner(path)).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "Git status timed out after {} seconds",
            GIT_STATE_OPERATION_TIMEOUT.as_secs()
        )),
    }
}

async fn get_git_state_inner(path: String) -> Result<GitState, String> {
    let repo_path = PathBuf::from(&path);
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if !is_git_repo_async(&repo_path).await? {
        return Ok(GitState {
            is_git_repo: false,
            current_branch: None,
            dirty_file_count: 0,
            incoming_commit_count: 0,
            worktrees: Vec::new(),
            is_worktree: false,
            main_worktree_path: None,
            local_branches: Vec::new(),
        });
    }

    let current_root = trim_to_option(
        run_git_success_async(
            &repo_path,
            &["rev-parse", "--show-toplevel"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    )
    .ok_or("Could not determine repository root")?;
    let current_branch = trim_to_option(
        run_git_success_async(
            &repo_path,
            &["branch", "--show-current"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    );
    let dirty_file_count = count_lines(
        &run_git_success_async(
            &repo_path,
            &["status", "--porcelain"],
            GIT_STATUS_COMMAND_TIMEOUT,
        )
        .await?,
    );
    // Asked from the toplevel: `--git-common-dir` prints a path relative to the
    // cwd, and `resolve_main_worktree_path` joins it onto the toplevel.
    let git_common_dir = trim_to_option(
        run_git_success_async(
            Path::new(&current_root),
            &["rev-parse", "--git-common-dir"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    );
    let main_worktree_path = git_common_dir
        .as_deref()
        .and_then(|git_common_dir| resolve_main_worktree_path(git_common_dir, &current_root))
        .as_deref()
        .map(normalize_path_string);
    let worktrees_output = run_git_success_async(
        &repo_path,
        &["worktree", "list", "--porcelain"],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;
    let listed = parse_worktrees(&worktrees_output, main_worktree_path.as_deref());
    // Joined onto the toplevel it was asked from, like the main worktree path.
    let common_dir = Path::new(&current_root).join(
        git_common_dir
            .as_deref()
            .ok_or("Could not determine the repository's git folder")?,
    );
    let asked_from = repo_path.clone();
    // File reads, possibly on a slow or sleeping drive: off the async runtime.
    let worktrees = tokio::task::spawn_blocking(move || {
        worktrees_of_this_repository(listed, &common_dir, &asked_from)
    })
    .await
    .map_err(|error| format!("Failed to inspect worktrees: {error}"))?;
    let is_worktree = main_worktree_path
        .as_deref()
        .map(|main_path| normalize_path_string(&current_root) != main_path)
        .unwrap_or(false);
    let incoming_commit_count = count_incoming_commits_async(&repo_path).await.unwrap_or(0);

    let local_branches = list_local_branches_async(&repo_path)
        .await
        .unwrap_or_default();

    Ok(GitState {
        is_git_repo: true,
        current_branch,
        dirty_file_count,
        incoming_commit_count,
        worktrees,
        is_worktree,
        main_worktree_path,
        local_branches,
    })
}

#[tauri::command]
pub async fn git_switch_branch(app: AppHandle, path: String, branch: String) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    let branch = require_branch_name(&branch, "Branch name")?;
    run_git_success_async(
        &repo_path,
        &["switch", &branch],
        GIT_MUTATING_COMMAND_TIMEOUT,
    )
    .await?;
    emit_git_state_changed(&app, "switch_branch", &path, Vec::new(), Some(branch));
    Ok(())
}

#[tauri::command]
pub async fn git_stash(app: AppHandle, path: String) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    run_git_success_async(&repo_path, &["stash"], GIT_MUTATING_COMMAND_TIMEOUT).await?;
    emit_git_state_changed(&app, "stash", &path, Vec::new(), None);
    Ok(())
}

#[tauri::command]
pub async fn git_init(app: AppHandle, path: String) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    run_git_success_async(&repo_path, &["init"], GIT_MUTATING_COMMAND_TIMEOUT).await?;
    emit_git_state_changed(&app, "init", &path, Vec::new(), None);
    Ok(())
}

#[tauri::command]
pub async fn git_fetch(app: AppHandle, path: String) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    run_git_success_async(
        &repo_path,
        &["fetch", "--prune"],
        GIT_MUTATING_COMMAND_TIMEOUT,
    )
    .await?;
    emit_git_state_changed(&app, "fetch", &path, Vec::new(), None);
    Ok(())
}

#[tauri::command]
pub async fn git_pull(app: AppHandle, path: String) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    run_git_success_async(
        &repo_path,
        &["pull", "--ff-only"],
        GIT_MUTATING_COMMAND_TIMEOUT,
    )
    .await?;
    emit_git_state_changed(&app, "pull", &path, Vec::new(), None);
    Ok(())
}

#[tauri::command]
pub async fn git_create_branch(
    app: AppHandle,
    path: String,
    name: String,
    base_branch: String,
) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    let branch_name = require_branch_name(&name, "Branch name")?;
    let base_branch = require_branch_name(&base_branch, "Base branch")?;
    run_git_success_async(
        &repo_path,
        &["switch", "-c", branch_name.as_str(), base_branch.as_str()],
        GIT_MUTATING_COMMAND_TIMEOUT,
    )
    .await?;
    emit_git_state_changed(&app, "create_branch", &path, Vec::new(), Some(branch_name));
    Ok(())
}

#[tauri::command]
pub async fn git_has_ignored_files(path: String) -> Result<bool, String> {
    let repo_path = resolve_repo_path(&path)?;
    let output = run_git_success_async(
        &repo_path,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
        ],
        GIT_STATUS_COMMAND_TIMEOUT,
    )
    .await?;
    Ok(!output.trim().is_empty())
}

#[tauri::command]
pub async fn git_count_branch_commits_not_in_base(
    path: String,
    branch: String,
    base_branch: String,
) -> Result<u32, String> {
    let repo_path = resolve_repo_path(&path)?;
    let branch_name = require_branch_name(&branch, "Branch name")?;
    let base_branch_name = require_branch_name(&base_branch, "Base branch")?;
    let range = format!("refs/heads/{base_branch_name}..refs/heads/{branch_name}");
    let output = run_git_success_async(
        &repo_path,
        &["rev-list", "--count", &range],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;
    output
        .trim()
        .parse::<u32>()
        .map_err(|error| format!("Failed to parse branch commit count: {error}"))
}

#[tauri::command]
pub async fn git_delete_branch(
    path: String,
    branch: String,
    force: bool,
    switch_to_branch: Option<String>,
) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    let branch_name = require_branch_name(&branch, "Branch name")?;
    let current_branch = trim_to_option(
        run_git_success_async(
            &repo_path,
            &["branch", "--show-current"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    );

    if current_branch.as_deref() == Some(branch_name.as_str()) {
        let target_branch = require_branch_name(
            switch_to_branch.as_deref().unwrap_or_default(),
            "Switch target branch",
        )?;
        if target_branch == branch_name {
            return Err(
                "Switch target branch must differ from the branch being deleted".to_string(),
            );
        }

        let switch_args = delete_branch_switch_args(force, target_branch.as_str());
        run_git_success_async(&repo_path, &switch_args, GIT_MUTATING_COMMAND_TIMEOUT).await?;
    }

    let delete_flag = if force { "-D" } else { "-d" };
    run_git_success_async(
        &repo_path,
        &["branch", delete_flag, "--", branch_name.as_str()],
        GIT_MUTATING_COMMAND_TIMEOUT,
    )
    .await?;
    Ok(())
}

fn delete_branch_switch_args(force: bool, target_branch: &str) -> Vec<&str> {
    let mut switch_args = vec!["switch"];
    if force {
        switch_args.push("-f");
    }
    if target_branch == "HEAD" {
        switch_args.push("--detach");
        switch_args.push(target_branch);
    } else {
        switch_args.push("--");
        switch_args.push(target_branch);
    }
    switch_args
}

async fn run_git_worktree_add_success(path: &Path, args: &[&str]) -> Result<String, String> {
    match timeout(
        GIT_WORKTREE_CREATE_TIMEOUT,
        run_git_success_async(path, args, GIT_WORKTREE_CREATE_TIMEOUT),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!(
            "git {} timed out after {} seconds",
            args.join(" "),
            GIT_WORKTREE_CREATE_TIMEOUT.as_secs()
        )),
    }
}

#[tauri::command]
pub async fn git_create_worktree(
    app: AppHandle,
    path: String,
    name: String,
    branch: String,
    create_branch: bool,
    base_branch: Option<String>,
) -> Result<CreatedWorktree, String> {
    let repo_path = resolve_repo_path(&path)?;
    let worktree_name = validate_worktree_name(&name)?;
    let branch_name = require_branch_name(&branch, "Branch name")?;
    let (_, main_worktree_path) = git_repo_context_async(&repo_path).await?;
    let target_path = derive_worktree_path(
        main_worktree_path.as_deref().unwrap_or(path.as_str()),
        &worktree_name,
    )?;

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create worktree directory: {}", error))?;
    }

    let target_path_string = target_path.to_string_lossy().to_string();

    if create_branch {
        let base_branch =
            require_branch_name(base_branch.as_deref().unwrap_or_default(), "Base branch")?;
        run_git_worktree_add_success(
            &repo_path,
            &[
                "worktree",
                "add",
                "-b",
                branch_name.as_str(),
                target_path_string.as_str(),
                base_branch.as_str(),
            ],
        )
        .await?;
    } else {
        run_git_worktree_add_success(
            &repo_path,
            &[
                "worktree",
                "add",
                target_path_string.as_str(),
                branch_name.as_str(),
            ],
        )
        .await?;
    }

    let created_worktree = CreatedWorktree {
        path: normalize_path_string(&target_path_string),
        branch: branch_name,
    };
    emit_git_state_changed(
        &app,
        "create_worktree",
        &path,
        vec![created_worktree.path.clone()],
        Some(created_worktree.branch.clone()),
    );
    Ok(created_worktree)
}

fn emit_git_state_changed(
    app: &AppHandle,
    operation: &'static str,
    path: &str,
    affected_paths: Vec<String>,
    branch: Option<String>,
) {
    if let Err(error) = app.emit(
        GIT_STATE_CHANGED_EVENT,
        GitStateChangedPayload {
            operation,
            path: normalize_path_string(path),
            affected_paths,
            branch,
        },
    ) {
        log::warn!("Failed to emit git state changed event: {error}");
    }
}

#[tauri::command]
pub async fn git_remove_worktree(
    path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    let worktree_path = require_nonempty(&worktree_path, "Worktree path")?;
    if !force {
        let output = run_git_output_async(
            Path::new(&worktree_path),
            &[
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--ignored",
            ],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?;
        if !output.status.success() || !output.stdout.is_empty() {
            return Err("Worktree contains local or ignored files; it was preserved".into());
        }
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push("--");
    args.push(worktree_path.as_str());
    run_git_success_async(&repo_path, &args, GIT_MUTATING_COMMAND_TIMEOUT).await?;
    Ok(())
}

pub(crate) async fn is_git_repo_async(path: &Path) -> Result<bool, String> {
    let output = run_git_output_async(
        path,
        &["rev-parse", "--is-inside-work-tree"],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;

    Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true")
}

pub(crate) fn resolve_repo_path(path: &str) -> Result<PathBuf, String> {
    let repo_path = PathBuf::from(path);
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    Ok(repo_path)
}

async fn run_git_output_async(
    path: &Path,
    args: &[&str],
    command_timeout: Duration,
) -> Result<Output, String> {
    run_git_output_with_env_source_async(path, args, command_timeout, env_source_for_git_args(args))
        .await
}

async fn run_git_output_with_env_source_async(
    path: &Path,
    args: &[&str],
    command_timeout: Duration,
    env_source: EnvSource,
) -> Result<Output, String> {
    let rendered_args = args.join(" ");
    match env_source {
        EnvSource::Smart => {
            warm_dir_env_async(path, command_timeout);
            run_with_smart_env(path, &rendered_args, |env_source| {
                run_git_once_async(path, args, command_timeout, env_source)
            })
            .await
            .map_err(|error| format_git_run_error(error, &rendered_args, command_timeout))
        }
        EnvSource::Lite | EnvSource::Captured => {
            run_git_once_async(path, args, command_timeout, env_source)
                .await
                .map_err(|error| format_git_run_error(error, &rendered_args, command_timeout))
        }
    }
}

/// The `Smart` order: the lite environment first, and the captured one when
/// the lite run fails in a way the user's own environment may mend. A folder
/// where the lite run failed so once goes straight to the captured
/// environment for the rest of the session: the sidebar reads a project's
/// status on every window focus, and each read ran git twice there and
/// logged the retry without saying why the lite run failed (bug hunt of
/// 2026-11-25, D-9). `run` runs git once with the environment it is given.
async fn run_with_smart_env<Run, Ran>(
    path: &Path,
    rendered_args: &str,
    run: Run,
) -> Result<Output, GitRunError>
where
    Run: Fn(EnvSource) -> Ran,
    Ran: std::future::Future<Output = Result<Output, GitRunError>>,
{
    if lite_env_failed_in(path) {
        return run(EnvSource::Captured).await;
    }
    match run(EnvSource::Lite).await {
        Ok(output) if output.status.success() || !should_retry_with_captured_output(&output) => {
            Ok(output)
        }
        Ok(output) => {
            remember_lite_env_failure(path, rendered_args, &output);
            run(EnvSource::Captured).await
        }
        Err(error) if should_retry_with_captured_error(&error) => {
            log::info!(
                "Retrying git {} with captured env after lite-env spawn failure in {}",
                rendered_args,
                path.display()
            );
            run(EnvSource::Captured).await
        }
        Err(error) => Err(error),
    }
}

/// The folders where git failed with the lite environment this session, as
/// the app names them to git.
fn lite_env_failures() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>> {
    static FAILED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    FAILED.get_or_init(Default::default)
}

fn lite_env_failed_in(path: &Path) -> bool {
    lite_env_failures()
        .lock()
        .is_ok_and(|failed| failed.contains(path))
}

/// Remembers that git failed with the lite environment in `path`, and logs
/// why the first time: the exit code and what git wrote on stderr.
fn remember_lite_env_failure(path: &Path, rendered_args: &str, output: &Output) {
    let first_time = lite_env_failures()
        .lock()
        .is_ok_and(|mut failed| failed.insert(path.to_path_buf()));
    if first_time {
        log::warn!("{}", lite_env_failure_note(path, rendered_args, output));
    }
}

/// How much of the lite run's stderr reaches the log: git's own message and
/// a hint fit; a hook's or a helper's full output does not.
const LITE_ENV_STDERR_LOG_CHARS: usize = 300;

fn lite_env_failure_note(path: &Path, rendered_args: &str, output: &Output) -> String {
    // Redacted line by line before it is cut: a credential a helper printed
    // must not survive as a fragment the redactor no longer recognizes.
    let stderr = String::from_utf8_lossy(&output.stderr)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(crate::services::log_redaction::redact_log_line)
        .collect::<Vec<_>>()
        .join(" | ");
    let stderr = if stderr.is_empty() {
        "nothing on stderr".to_string()
    } else if stderr.chars().count() > LITE_ENV_STDERR_LOG_CHARS {
        let cut: String = stderr.chars().take(LITE_ENV_STDERR_LOG_CHARS).collect();
        format!("{cut}…")
    } else {
        stderr
    };
    let exit_code = output
        .status
        .code()
        .map_or_else(|| "none".to_string(), |code| code.to_string());
    format!(
        "git {rendered_args} failed with the lite env in {} (exit code {exit_code}): {stderr}. \
         Git in this folder runs with the captured env for the rest of this session",
        path.display()
    )
}

/// A folder the user opens may carry a `.git/config` and `.git/hooks` written
/// by someone else (an extracted archive, a shared drive). Git reads that
/// config with the same authority as the user's own, and several keys name
/// programs to run: `core.fsmonitor` during the index refresh every `status`
/// and `diff` performs — which the sidebar triggers on its own — hook scripts
/// on checkout and ref updates, the `ext::` remote helper on fetch, and
/// `remote.<name>.uploadpack` (see [`git_transport_args`]).
///
/// What these overrides do and do not cover, precisely, because the difference
/// matters when the next key is added:
///
/// * A command-line `-c` outranks every config file, so the four keys spelled
///   out here cannot run code through the app, whatever the repository says.
/// * The sidebar runs `status` and `diff` on mount and on window focus, with
///   no action of the user's. Three things in a repository's own config run
///   a program during those two, and each is closed for them:
///   `core.fsmonitor` by its override; the `post-index-change` hook, which
///   `status` fires when it refreshes the index, by `core.hooksPath`, which
///   every command now carries; and a `filter.<driver>.clean` the
///   repository defines, which `diff` and `status` run on a changed file,
///   by [`repository_filter_overrides`]. `diff` also takes `--no-ext-diff`
///   and `--no-textconv`. All three were seen running on git 2.56.
/// * Two more ways the same reads reach a program the repository names go
///   around those three, and were seen running on git 2.56 as well. A
///   repository that declares a promisor remote has git fetch any object it
///   finds missing, with `remote.<name>.uploadpack` from its own config: see
///   [`GIT_NO_LAZY_FETCH_ENV`]. And `status` and `diff` start a second git
///   inside every nested repository, which reads the config found there and
///   runs its filters: see [`GIT_SUBMODULE_OVERRIDE`].
/// * Keys with no `-c` spelling that would neutralise them are *not* covered
///   for the commands the user asks for: `credential.helper`,
///   `filter.<driver>.smudge`/`clean` on a checkout, and `core.gitProxy` still
///   run what the repository names there. Disabling them would break the
///   user's own setup (Git Credential Manager, Git LFS), which is the reason
///   `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL` are deliberately not used
///   either, and why only drivers the repository itself defines are switched
///   off for `status` and `diff`: the user's own, from the global or system
///   config, keep working.
const GIT_FSMONITOR_OVERRIDE: &str = "core.fsmonitor=false";
const GIT_EXT_PROTOCOL_OVERRIDE: &str = "protocol.ext.allow=never";
/// The remote-side program `fetch`/`pull` ask for, spelled out so
/// `remote.<name>.uploadpack` from the repository's own config cannot name
/// another one. There is no useful `-c` form: the key is per remote, and the
/// app does not know what the repository called its remotes — the option,
/// however, outranks the config for every remote at once. (Git's own default is
/// exactly this program, so nothing changes for an honest repository; HTTP
/// transports ignore both the key and the option.)
const GIT_UPLOAD_PACK_OVERRIDE: &str = "--upload-pack=git-upload-pack";

/// The hooks directory git is pointed at for mutating commands. It never
/// exists: a fresh per-process name under the temp dir, so neither the
/// repository nor anything that guessed a fixed name can populate it.
fn disabled_git_hooks_dir() -> &'static Path {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        std::env::temp_dir().join(format!(
            "flock-git-hooks-disabled-{}",
            uuid::Uuid::new_v4().simple()
        ))
    })
}

/// Commands that update refs or the worktree, and so would run the
/// repository's hooks (`post-checkout`, `reference-transaction`, `post-merge`)
/// or contact its remotes.
///
/// BEHAVIOUR: these commands run with `core.hooksPath` pointed at a directory
/// that does not exist, so a repository's own hooks do **not** run for an
/// app-initiated `switch`/`checkout`, `worktree add|remove`, `fetch`, `pull`,
/// `stash`, `branch` or `init` — the same operation in the user's terminal still
/// runs them. Setups that bootstrap through `post-checkout` (husky, lefthook) or
/// `git lfs post-checkout`, and `post-merge` hooks, will therefore diverge from
/// the terminal. That is the accepted trade for closing the vector; it is the
/// one difference to remember when a git operation "works in the terminal".
/// The match is deliberately coarse: read-only `git branch --show-current` and
/// `git stash list` take the override too, where it has nothing to suppress.
fn git_args_mutate_repository(args: &[&str]) -> bool {
    matches!(
        args,
        ["switch", ..]
            | ["checkout", ..]
            | ["stash", ..]
            | ["init", ..]
            | ["fetch", ..]
            | ["pull", ..]
            | ["branch", ..]
            | ["worktree", "add" | "remove", ..]
    )
}

pub(crate) fn git_hardening_args(args: &[&str]) -> Vec<String> {
    // No command the app issues needs a repository's hooks, and a read is
    // not exempt: `status` writes the index it refreshed and fires
    // `post-index-change`, which the sidebar would run on its own.
    let mut hardening = vec![
        "-c".to_string(),
        GIT_FSMONITOR_OVERRIDE.to_string(),
        "-c".to_string(),
        format!("core.hooksPath={}", disabled_git_hooks_dir().display()),
    ];
    if git_args_mutate_repository(args) {
        hardening.push("-c".to_string());
        hardening.push(GIT_EXT_PROTOCOL_OVERRIDE.to_string());
    }
    hardening
}

/// The hardening a command needs *after* its subcommand, because it is an
/// option of that subcommand rather than a config key. Empty for everything
/// that does not talk to a remote.
fn git_transport_args(args: &[&str]) -> &'static [&'static str] {
    match args {
        ["fetch", ..] | ["pull", ..] => std::slice::from_ref(&GIT_UPLOAD_PACK_OVERRIDE),
        // `diff.external` and a `diff.<driver>.textconv` in the repository's
        // config name programs a diff runs; the app reads numbers and
        // patches, and needs neither.
        ["diff", ..] => &GIT_DIFF_OVERRIDES,
        ["status", ..] => std::slice::from_ref(&GIT_SUBMODULE_OVERRIDE),
        _ => &[],
    }
}

/// Keeps `status` and `diff` out of nested repositories. For a folder the
/// index lists as one (a submodule, or any folder with its own `.git` that
/// was added), both start a second git inside it to ask whether its files
/// changed. That git reads the config of the nested repository, and a filter
/// defined only there is not among the drivers
/// [`repository_filter_overrides`] switches off. With this option a nested
/// repository counts as changed when its commit moved and is not looked
/// into. What it costs an honest repository: uncommitted edits inside a
/// submodule do not show in the app's own status and diff.
const GIT_SUBMODULE_OVERRIDE: &str = "--ignore-submodules=dirty";
const GIT_DIFF_OVERRIDES: [&str; 3] = ["--no-ext-diff", "--no-textconv", GIT_SUBMODULE_OVERRIDE];

/// Tells git not to fetch an object it finds missing. A repository whose
/// config declares a promisor remote has every command that reads an object
/// fetch a missing one on its own, and that fetch runs what the same config
/// names: `remote.<name>.uploadpack`, an `ext::` address, a credential
/// helper. One branch pointing at an object that is not there is enough for
/// `status`. Git 2.45 and later honour the variable; an older git ignores it
/// and is not protected.
const GIT_NO_LAZY_FETCH_ENV: &str = "GIT_NO_LAZY_FETCH";

/// The commands the user asks for that may need objects a partial clone left
/// on its remote. Every other command runs with [`GIT_NO_LAZY_FETCH_ENV`].
fn git_args_may_fetch_missing_objects(args: &[&str]) -> bool {
    matches!(
        args,
        ["switch", ..] | ["checkout", ..] | ["fetch", ..] | ["pull", ..] | ["worktree", "add", ..]
    )
}

/// The commands the app runs on its own, with no action of the user's, that
/// read changed files through the repository's filters.
fn git_args_read_changed_files_unasked(args: &[&str]) -> bool {
    matches!(args, ["status", ..] | ["diff", ..])
}

/// Each repository's filter drivers and when they were listed.
type FilterListings = HashMap<PathBuf, (Instant, Vec<String>)>;

/// How long one listing of a repository's filter drivers stands: the sidebar
/// asks for status and diff together, and again on every window focus.
const FILTER_LISTING_TTL: Duration = Duration::from_secs(5);

/// The filter drivers a repository's own config defines, from one line each
/// of `git config --show-scope --name-only --get-regexp ^filter\.`:
/// `<scope>\tfilter.<driver>.<variable>`. Drivers from the user's global or
/// the system config are the user's own and are left out. A driver's name may
/// hold dots, spaces and `=`, never a line break.
fn repository_filter_drivers(listing: &str) -> Vec<String> {
    let mut drivers: Vec<String> = Vec::new();
    for line in listing.lines() {
        let Some((scope, key)) = line.split_once('\t') else {
            continue;
        };
        if scope != "local" && scope != "worktree" {
            continue;
        }
        let driver = key
            .get(..7)
            .filter(|prefix| prefix.eq_ignore_ascii_case("filter."))
            .and_then(|_| key[7..].rsplit_once('.'))
            .map(|(driver, _)| driver);
        if let Some(driver) = driver.filter(|driver| !driver.is_empty()) {
            if !drivers.iter().any(|known| known == driver) {
                drivers.push(driver.to_string());
            }
        }
    }
    drivers
}

/// The config that switches those drivers off, as the `GIT_CONFIG_KEY_n` /
/// `GIT_CONFIG_VALUE_n` pairs git reads from the environment. The environment
/// and not `-c`, because `-c` splits a key at its first `=` and a driver's
/// name may hold one. An empty command is no filter; `required` goes with
/// it, or git would fail the read for a filter it was told not to run.
fn filter_overrides_for(drivers: &[String]) -> Vec<(String, String)> {
    drivers
        .iter()
        .flat_map(|driver| {
            ["clean", "smudge", "process"]
                .into_iter()
                .map(move |variable| (format!("filter.{driver}.{variable}"), String::new()))
                .chain(std::iter::once((
                    format!("filter.{driver}.required"),
                    "false".to_string(),
                )))
        })
        .collect()
}

/// The overrides that keep `status` and `diff` from running a filter the
/// repository itself names.
///
/// A folder that came with its `.git` — an archive, a shared or synced
/// folder — can define `filter.<driver>.clean` in its config and assign the
/// driver to every path in `.gitattributes`. Git then runs that program on
/// each changed file whenever it compares the working tree, which the
/// sidebar does when the folder is opened. Reading the config runs nothing,
/// so the drivers are listed first and switched off for the read.
///
/// What this costs an honest repository: one with a filter in its own
/// config (`git-crypt`, `git lfs install --local`) has its touched files
/// compared unfiltered in the app's own status and diff, so they can show as
/// changed there when their content is not. Nothing is written with the
/// filter off: staging, committing and checking out are the user's own
/// commands and keep every filter.
async fn repository_filter_overrides(git: &Path, path: &Path) -> Vec<(String, String)> {
    static LISTINGS: std::sync::OnceLock<std::sync::Mutex<FilterListings>> =
        std::sync::OnceLock::new();
    let listings = LISTINGS.get_or_init(Default::default);
    if let Some((listed_at, drivers)) = listings
        .lock()
        .ok()
        .and_then(|known| known.get(path).cloned())
    {
        if listed_at.elapsed() < FILTER_LISTING_TTL {
            return filter_overrides_for(&drivers);
        }
    }
    let mut command = build_git_command(
        git,
        path,
        &[
            "config",
            "--show-scope",
            "--name-only",
            "--get-regexp",
            r"^filter\.",
        ],
    );
    apply_lite_git_env(&mut command);
    force_non_interactive(&mut command);
    pin_c_locale(&mut command);
    detach_from_ctty(&mut command);
    crate::services::process::apply_no_window_async(&mut command);
    // No match is exit 1 with nothing printed; a folder that is no
    // repository fails the same way. Either has no driver to switch off.
    let drivers = match timeout(Duration::from_secs(5), command.output()).await {
        Ok(Ok(output)) => repository_filter_drivers(&String::from_utf8_lossy(&output.stdout)),
        _ => Vec::new(),
    };
    if let Ok(mut known) = listings.lock() {
        known.retain(|_, (listed_at, _)| listed_at.elapsed() < FILTER_LISTING_TTL);
        known.insert(path.to_path_buf(), (Instant::now(), drivers.clone()));
    }
    filter_overrides_for(&drivers)
}

/// Everything the app hands to git: the `-c` overrides first (they have to
/// precede the subcommand), then the subcommand, then its own transport
/// hardening, then the caller's remaining arguments.
fn git_command_args(args: &[&str]) -> Vec<String> {
    let mut built = git_hardening_args(args);
    let transport = git_transport_args(args);
    match args.split_first().filter(|_| !transport.is_empty()) {
        Some((subcommand, rest)) => {
            built.push((*subcommand).to_string());
            built.extend(transport.iter().map(|arg| (*arg).to_string()));
            built.extend(rest.iter().map(|arg| (*arg).to_string()));
        }
        None => built.extend(args.iter().map(|arg| (*arg).to_string())),
    }
    built
}

fn build_git_command(git: &Path, path: &Path, args: &[&str]) -> TokioCommand {
    let mut command = TokioCommand::new(git);
    command
        .args(git_command_args(args))
        .current_dir(path)
        .kill_on_drop(true);
    command
}

async fn run_git_once_async(
    path: &Path,
    args: &[&str],
    command_timeout: Duration,
    env_source: EnvSource,
) -> Result<Output, GitRunError> {
    let git = dir_env::resolve_control_executable("git").ok_or_else(|| {
        GitRunError::Spawn(io::Error::new(
            io::ErrorKind::NotFound,
            "trusted Git executable was not found",
        ))
    })?;
    let mut command = build_git_command(&git, path, args);

    apply_git_environment(
        &mut command,
        path,
        env_source,
        dir_env_capture_timeout(command_timeout),
    )
    .await;
    // After the environment: every inherited `GIT_*` control was removed
    // there, and these are the app's own.
    if !git_args_may_fetch_missing_objects(args) {
        command.env(GIT_NO_LAZY_FETCH_ENV, "1");
    }
    if git_args_read_changed_files_unasked(args) {
        let overrides = repository_filter_overrides(&git, path).await;
        if !overrides.is_empty() {
            command.env("GIT_CONFIG_COUNT", overrides.len().to_string());
            for (index, (key, value)) in overrides.iter().enumerate() {
                command.env(format!("GIT_CONFIG_KEY_{index}"), key);
                command.env(format!("GIT_CONFIG_VALUE_{index}"), value);
            }
        }
    }

    crate::services::process::apply_no_window_async(&mut command);
    timeout(command_timeout, command.output())
        .await
        .map_err(|_| GitRunError::TimedOut)?
        .map_err(GitRunError::Spawn)
}

/// Which environment a command runs with. `Captured` — the user's own
/// environment, with no folder of the project on PATH — is for the commands whose work
/// still reaches programs the user's setup names: checkout *filters*
/// (`filter.lfs.smudge` on a `switch`/`worktree add`/`stash`, which git runs
/// itself, not through a hook) and credential helpers plus `GIT_SSH_COMMAND` on
/// `fetch`/`pull`. Repository *hooks* are no longer a reason: they do not run for
/// these commands at all (see [`git_args_mutate_repository`]).
fn env_source_for_git_args(args: &[&str]) -> EnvSource {
    match args {
        ["switch", ..]
        | ["stash", ..]
        | ["init", ..]
        | ["fetch", ..]
        | ["pull", ..]
        | ["branch", "-d" | "-D", ..]
        | ["worktree", "add", ..]
        | ["worktree", "remove", ..] => EnvSource::Captured,
        _ => EnvSource::Smart,
    }
}

#[cfg(not(test))]
fn warm_dir_env_async(path: &Path, command_timeout: Duration) {
    let path = path.to_path_buf();
    let capture_timeout = dir_env_capture_timeout(command_timeout);
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let _ = dir_env::capture_dir_env(&path, capture_timeout).await;
        });
    }
}

#[cfg(test)]
fn warm_dir_env_async(_path: &Path, _command_timeout: Duration) {}

fn should_retry_with_captured_error(error: &GitRunError) -> bool {
    matches!(error, GitRunError::Spawn(error) if error.kind() == io::ErrorKind::NotFound)
}

fn format_git_run_error(
    error: GitRunError,
    rendered_args: &str,
    command_timeout: Duration,
) -> String {
    match error {
        GitRunError::TimedOut => format!(
            "git {} timed out after {} seconds",
            rendered_args,
            command_timeout.as_secs()
        ),
        GitRunError::Spawn(error) => format!("Failed to run git: {}", error),
    }
}

async fn apply_git_environment(
    command: &mut TokioCommand,
    path: &Path,
    env_source: EnvSource,
    capture_timeout: Duration,
) {
    match env_source {
        EnvSource::Smart | EnvSource::Lite => apply_lite_git_env(command),
        EnvSource::Captured => {
            if let Some(mut env) = dir_env::capture_dir_env(path, capture_timeout).await {
                sanitize_git_env(&mut env);
                apply_captured_git_env(command, &env);
            } else {
                apply_lite_git_env(command);
            }
        }
    }

    force_non_interactive(command);
    pin_c_locale(command);
    detach_from_ctty(command);
}

fn apply_captured_git_env(command: &mut TokioCommand, env: &HashMap<String, String>) {
    command.env_clear();
    command.envs(env);
}

/// Git transport variables Flock deliberately carries across repository
/// boundaries. Every other inherited `GIT_*` variable is removed so newly
/// introduced Git controls fail closed instead of bypassing a stale denylist.
const PRESERVED_GIT_TRANSPORT_ENV_KEYS: &[&str] =
    &["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT"];

fn sanitize_git_env(env: &mut HashMap<String, String>) {
    env.retain(|key, _| !is_git_env_key(key) || is_preserved_git_transport_key(key));
}

fn is_git_env_key(key: &str) -> bool {
    key.get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("GIT_"))
}

fn is_preserved_git_transport_key(key: &str) -> bool {
    PRESERVED_GIT_TRANSPORT_ENV_KEYS
        .iter()
        .any(|preserved| env_key::matches(key, preserved))
}

fn apply_lite_git_env(command: &mut TokioCommand) {
    let explicit_git_env = command
        .as_std()
        .get_envs()
        .filter_map(|(key, value)| {
            let key_text = key.to_str()?;
            is_git_env_key(key_text)
                .then(|| (key.to_os_string(), value.map(std::ffi::OsStr::to_os_string)))
        })
        .collect::<Vec<_>>();
    let explicitly_configured_transport_keys = explicit_git_env
        .iter()
        .filter_map(|(key, _)| {
            key.to_str()
                .filter(|key| is_preserved_git_transport_key(key))
        })
        .collect::<Vec<_>>();
    let inherited_transport = env_key::process_vars_lossy()
        .into_iter()
        .filter(|(key, _)| {
            is_preserved_git_transport_key(key)
                && !explicitly_configured_transport_keys
                    .iter()
                    .any(|explicit| env_key::matches(explicit, key))
        });

    for key in std::env::vars_os()
        .map(|(key, _)| key)
        .chain(explicit_git_env.iter().map(|(key, _)| key.clone()))
    {
        if key.to_str().is_some_and(is_git_env_key) {
            command.env_remove(key);
        }
    }
    command.envs(inherited_transport);
    for (key, value) in explicit_git_env {
        if !key.to_str().is_some_and(is_preserved_git_transport_key) {
            continue;
        }
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
}

fn force_non_interactive(command: &mut TokioCommand) {
    command.env("GIT_TERMINAL_PROMPT", "0");
    if !has_env(command, "GIT_SSH_COMMAND") && !has_env(command, "GIT_SSH") {
        command.env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=10",
        );
    }
}

fn has_env(command: &TokioCommand, key: &str) -> bool {
    command.as_std().get_envs().any(|(existing_key, value)| {
        value.is_some()
            && existing_key
                .to_str()
                .is_some_and(|existing| env_key::matches(existing, key))
    })
}

fn pin_c_locale(command: &mut TokioCommand) {
    command.env("LC_ALL", "C");
    command.env("LANG", "C");
}

fn detach_from_ctty(command: &mut TokioCommand) {
    #[cfg(unix)]
    unsafe {
        // SAFETY: `setsid()` is async-signal-safe.
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    #[cfg(not(unix))]
    let _ = command;
}

pub(crate) async fn run_git_success_async(
    path: &Path,
    args: &[&str],
    command_timeout: Duration,
) -> Result<String, String> {
    let output = run_git_output_async(path, args, command_timeout).await?;

    if !output.status.success() {
        let message = output_failure_message(&output);
        let rendered_args = args.join(" ");
        return Err(format!("git {} failed: {}", rendered_args, message));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn should_retry_with_captured_output(output: &Output) -> bool {
    if output.status.success() {
        return false;
    }

    let message = output_failure_message(output);
    !is_not_git_repo_error(&message) && !is_missing_ref_or_object_error(&message)
}

fn output_failure_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }

    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn is_not_git_repo_error(message: &str) -> bool {
    message.contains("not a git repository")
}

fn is_missing_ref_or_object_error(message: &str) -> bool {
    const REF_RESOLVE_FAILURE_PATTERNS: &[&str] = &[
        "Needed a single revision",
        "unknown revision or path",
        "no upstream configured",
        "Not a valid object name",
        "Not a valid commit name",
        "bad revision",
        "bad object",
    ];

    REF_RESOLVE_FAILURE_PATTERNS
        .iter()
        .any(|pattern| message.contains(pattern))
}

pub(crate) fn trim_to_option(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn require_nonempty(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{} cannot be empty", label))
    } else {
        Ok(trimmed.to_string())
    }
}

/// A branch or revision name passed to git as a positional argument.
///
/// Git refuses ref names that start with `-`, so such a value can only be an
/// option: `git switch --orphan=x` or `git worktree add -b -f` would run a
/// different command than the one the UI offered.
fn require_branch_name(value: &str, label: &str) -> Result<String, String> {
    let name = require_nonempty(value, label)?;
    if name.starts_with('-') {
        return Err(format!("{} cannot start with '-'", label));
    }
    Ok(name)
}

fn count_lines(value: &str) -> u32 {
    value
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count()
        .try_into()
        .unwrap_or(u32::MAX)
}

async fn count_incoming_commits_async(path: &Path) -> Result<u32, String> {
    let has_upstream = run_git_output_async(
        path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;

    if !has_upstream.status.success() {
        return Ok(0);
    }

    let output = run_git_success_async(
        path,
        &["rev-list", "--count", "HEAD..@{upstream}"],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;
    let count = output
        .trim()
        .parse::<u32>()
        .map_err(|error| format!("Failed to parse incoming commit count: {}", error))?;
    Ok(count)
}

fn resolve_main_worktree_path(git_common_dir: &str, current_root: &str) -> Option<String> {
    let path = PathBuf::from(git_common_dir);
    let absolute = if path.is_absolute() {
        path
    } else {
        PathBuf::from(current_root).join(path)
    };

    if absolute.file_name().is_some_and(|name| name == ".git") {
        absolute
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
    } else {
        None
    }
}

async fn git_repo_context_async(path: &Path) -> Result<(String, Option<String>), String> {
    let current_root = trim_to_option(
        run_git_success_async(
            path,
            &["rev-parse", "--show-toplevel"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    )
    .ok_or("Could not determine repository root")?;
    // Asked from the toplevel for the same reason as in `get_git_state_inner`.
    let git_common_dir = trim_to_option(
        run_git_success_async(
            Path::new(&current_root),
            &["rev-parse", "--git-common-dir"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    );
    let main_worktree_path = git_common_dir
        .as_deref()
        .and_then(|git_common_dir| resolve_main_worktree_path(git_common_dir, &current_root))
        .as_deref()
        .map(normalize_path_string);

    Ok((current_root, main_worktree_path))
}

fn validate_worktree_name(value: &str) -> Result<String, String> {
    let worktree_name = require_nonempty(value, "Worktree name")?;
    if worktree_name == "." || worktree_name == ".." {
        return Err("Worktree name must be a real folder name".to_string());
    }
    if worktree_name.contains('/') || worktree_name.contains('\\') {
        return Err("Worktree name cannot contain path separators".to_string());
    }
    // `C:name` is drive-relative on Windows: joining it replaces the base
    // path, so the worktree would land outside `<repo>-worktrees`.
    if worktree_name.contains(':') {
        return Err("Worktree name cannot contain ':'".to_string());
    }
    // `CON` is a device, not a folder, and `foo ` is silently trimmed to `foo`:
    // either way the worktree is not where the caller was told it is.
    crate::services::windows_names::reject_unusable_windows_name(&worktree_name, "Worktree name")?;
    Ok(worktree_name)
}

fn derive_worktree_path(main_worktree_path: &str, worktree_name: &str) -> Result<PathBuf, String> {
    let main_root = PathBuf::from(main_worktree_path);
    let repo_name = main_root
        .file_name()
        .ok_or("Could not determine repository name")?
        .to_string_lossy()
        .to_string();
    let repo_parent = main_root
        .parent()
        .ok_or("Could not determine repository parent")?;
    let target_path = repo_parent
        .join(format!("{}-worktrees", repo_name))
        .join(worktree_name);

    if target_path.exists() {
        return Err(format!(
            "Worktree path already exists: {}",
            target_path.to_string_lossy()
        ));
    }

    Ok(target_path)
}

fn parse_worktrees(output: &str, main_worktree_path: Option<&str>) -> Vec<WorktreeInfo> {
    let mut worktrees = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in output.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(path) = current_path.take() {
                worktrees.push(build_worktree(
                    path,
                    current_branch.take(),
                    main_worktree_path,
                ));
            }
            current_path = Some(path.to_string());
            current_branch = None;
            continue;
        }

        if let Some(branch) = line.strip_prefix("branch ") {
            current_branch = Some(branch_name(branch));
        }
    }

    if let Some(path) = current_path {
        worktrees.push(build_worktree(path, current_branch, main_worktree_path));
    }

    worktrees
}

fn build_worktree(
    path: String,
    branch: Option<String>,
    main_worktree_path: Option<&str>,
) -> WorktreeInfo {
    let normalized_path = normalize_path_string(&path);
    let is_main = main_worktree_path
        .map(|main_path| normalized_path == main_path)
        .unwrap_or(false);

    WorktreeInfo {
        path: normalized_path,
        branch,
        is_main,
    }
}

/// The folders `git worktree list` printed that are worktrees of the
/// repository `asked_from` is in, by their own account as well as git's.
///
/// The renderer takes every worktree in a chat folder's git state for an
/// authorized workspace root: an agent may attach any folder under one. Git's
/// list is no proof of that. It prints one folder for each
/// `worktrees/<id>/gitdir` file in the repository's git folder, whatever the
/// file says, so a folder that came with its own `.git` (an archive, a shared
/// or synced folder) can name `C:/Users` there and have it listed. And a
/// folder whose `.git` is one line pointing at another repository's git
/// folder is shown that repository's whole list, though the repository knows
/// nothing of the folder.
///
/// So a listed folder is kept when it holds the repository itself (the main
/// worktree, or a bare repository's own folder) or when its `.git` file
/// points back at this repository's `worktrees/<id>`. And nothing is kept
/// unless `asked_from` lies in one of the folders kept: a folder that is no
/// worktree of a repository does not get that repository's list.
///
/// What it costs an honest repository: a worktree whose folder was deleted or
/// moved without `git worktree remove` or `repair` is no longer listed, and
/// nothing is listed for a folder whose `.git` file names a git folder
/// directly (`git init --separate-git-dir`, a submodule), which the registry
/// cannot tell from the borrowed list.
fn worktrees_of_this_repository(
    listed: Vec<WorktreeInfo>,
    common_dir: &Path,
    asked_from: &Path,
) -> Vec<WorktreeInfo> {
    let Ok(real_common_dir) = dunce::canonicalize(common_dir) else {
        warn_once_about_worktrees(format!(
            "Listing no worktree of '{}': the git folder cannot be resolved",
            common_dir.display()
        ));
        return Vec::new();
    };
    // Git writes its own spelling of the repository into a worktree's `.git`
    // file, and on a network drive that is not the resolved one.
    let registries = [
        lexically_normalized(&real_common_dir.join("worktrees")),
        lexically_normalized(&common_dir.join("worktrees")),
    ];
    let mut confirmed: Vec<(PathBuf, WorktreeInfo)> = Vec::new();
    for worktree in listed {
        match confirmed_worktree_root(Path::new(&worktree.path), &real_common_dir, &registries) {
            Some(root) => confirmed.push((root, worktree)),
            None => warn_once_about_worktrees(format!(
                "Not listing '{}' as a worktree of '{}': nothing there points back at it",
                worktree.path,
                common_dir.display()
            )),
        }
    }
    // Under one spelling a prefix of the path says it; a worktree reached
    // through the other spelling of its disk (a drive letter and its share)
    // is found by the folders themselves.
    let asked_from_a_worktree = dunce::canonicalize(asked_from).is_ok_and(|asked_from| {
        confirmed
            .iter()
            .any(|(root, _)| asked_from.starts_with(root))
            || lies_in_one_of(
                &asked_from,
                confirmed.iter().map(|(root, _)| root.as_path()),
            )
    });
    if !asked_from_a_worktree {
        warn_once_about_worktrees(format!(
            "Listing no worktree of '{}' for '{}', which is in none of them",
            common_dir.display(),
            asked_from.display()
        ));
        return Vec::new();
    }
    confirmed
        .into_iter()
        .map(|(_, worktree)| worktree)
        .collect()
}

/// The resolved folder of a worktree git listed, when the folder itself says
/// it belongs to the repository whose git folder is `common_dir`.
fn confirmed_worktree_root(
    listed: &Path,
    common_dir: &Path,
    registries: &[PathBuf],
) -> Option<PathBuf> {
    let root = dunce::canonicalize(listed).ok()?;
    // A bare repository is listed as its own folder.
    if root == common_dir {
        return Some(root);
    }
    let dot_git = root.join(".git");
    // The main worktree holds the repository's git folder.
    if dunce::canonicalize(&dot_git).is_ok_and(|git_dir| git_dir == common_dir) {
        return Some(root);
    }
    // A linked worktree's `.git` is a file that names its entry in the
    // registry, from the worktree when the path is relative. Git writes the
    // spelling the worktree was added through: a drive letter, or the share
    // the same disk is reached by. So a name spelled otherwise is compared
    // as the folder it opens, but only on a volume this question already
    // opened: whoever owns the folder chose the name, and it may as well
    // name another machine, which the app must not contact for it.
    let entry = lexically_normalized(&root.join(gitfile_target(&dot_git)?));
    let registry = entry.parent()?;
    let named_here = registries
        .iter()
        .any(|known| same_spelling(registry, known))
        || (on_a_reached_volume(registry, &[root.as_path(), common_dir])
            && registries
                .first()
                .is_some_and(|known| same_folder_on_disk(registry, known)));
    named_here.then_some(root)
}

/// No path is this long; a `.git` file that is, is not read to its end.
const GITFILE_READ_LIMIT: u64 = 64 * 1024;

/// What a `.git` file names: `gitdir: <path>`, as git reads it. `None` for a
/// folder and for a file that says anything else.
fn gitfile_target(dot_git: &Path) -> Option<PathBuf> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(dot_git)
        .ok()?
        .take(GITFILE_READ_LIMIT)
        .read_to_string(&mut text)
        .ok()?;
    let named = text
        .strip_prefix("gitdir: ")?
        .trim_end_matches(['\n', '\r']);
    (!named.is_empty()).then(|| PathBuf::from(named))
}

/// `path` with its `.` and `..` resolved by name alone: nothing on disk is
/// asked.
fn lexically_normalized(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            named => normalized.push(named),
        }
    }
    normalized
}

/// Whether two normalized paths are spelled alike, compared the way the file
/// system compares names: without case on Windows.
fn same_spelling(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
    } else {
        a == b
    }
}

/// What tells one folder from every other on this machine, whichever
/// spelling reached it: the volume serial number and the file index on
/// Windows (the same through `E:\`, `\\localhost\E$\`, a mapped drive letter
/// and its UNC path), the device and inode elsewhere.
type FolderIdentity = (u64, u64);

/// The identity of the folder at `path`, or `None` when it cannot be opened;
/// then the caller has only the spelling to go by.
#[cfg(windows)]
fn folder_identity(path: &Path) -> Option<FolderIdentity> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_READ_ATTRIBUTES,
    };
    // A folder opens only with backup semantics; reading its identity needs
    // no right beyond its attributes.
    let folder = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle stays open for the call and `info` is writable.
    if unsafe { GetFileInformationByHandle(folder.as_raw_handle(), &mut info) } == 0 {
        return None;
    }
    Some((
        u64::from(info.dwVolumeSerialNumber),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}

#[cfg(unix)]
fn folder_identity(path: &Path) -> Option<FolderIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(any(windows, unix)))]
fn folder_identity(_path: &Path) -> Option<FolderIdentity> {
    None
}

/// Whether two paths are the same folder on disk. `false` when either
/// cannot be opened.
fn same_folder_on_disk(a: &Path, b: &Path) -> bool {
    folder_identity(a).is_some_and(|a| folder_identity(b) == Some(a))
}

/// Whether `path`, or a folder it lies in, is one of `roots` on disk.
fn lies_in_one_of<'a>(path: &Path, roots: impl Iterator<Item = &'a Path>) -> bool {
    let roots: Vec<FolderIdentity> = roots.filter_map(folder_identity).collect();
    !roots.is_empty()
        && path
            .ancestors()
            .filter_map(folder_identity)
            .any(|folder| roots.contains(&folder))
}

/// Whether `path` lies on the volume of one of `reached`: the same drive
/// letter, or the same server and share, however spelled (`/` or `\`,
/// `\\?\`, any case). A name in a `.git` file is opened only there, so it
/// never makes the app reach a machine the question did not already reach.
#[cfg(windows)]
fn on_a_reached_volume(path: &Path, reached: &[&Path]) -> bool {
    fn volume(path: &Path) -> Option<String> {
        use std::path::{Component, Prefix};
        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return None;
        };
        match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                Some(format!("{}:", char::from(letter.to_ascii_uppercase())))
            }
            Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => Some(
                format!(
                    r"\\{}\{}",
                    server.to_string_lossy(),
                    share.to_string_lossy()
                )
                .to_uppercase(),
            ),
            _ => None,
        }
    }
    volume(path).is_some_and(|wanted| {
        reached
            .iter()
            .any(|reached| volume(reached).as_deref() == Some(wanted.as_str()))
    })
}

/// One tree of folders with no machine in its names: every path is on a
/// volume already reached.
#[cfg(not(windows))]
fn on_a_reached_volume(_path: &Path, _reached: &[&Path]) -> bool {
    true
}

/// Logs a worktree left out of the list once per run. The git state is read
/// again on every window focus, and a worktree someone deleted by hand would
/// fill the log.
fn warn_once_about_worktrees(message: String) {
    static SAID: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    let first_time = SAID
        .get_or_init(Default::default)
        .lock()
        .is_ok_and(|mut said| said.insert(message.clone()));
    if first_time {
        log::warn!("{message}");
    }
}

fn branch_name(branch_ref: &str) -> String {
    branch_ref
        .strip_prefix("refs/heads/")
        .unwrap_or(branch_ref)
        .to_string()
}

fn normalize_path_string(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

async fn list_local_branches_async(path: &Path) -> Result<Vec<String>, String> {
    let output = run_git_success_async(
        path,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)",
            "refs/heads",
        ],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;
    Ok(output
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn env_value(command: &TokioCommand, key: &str) -> Option<OsString> {
        command.as_std().get_envs().find_map(|(env_key, value)| {
            if env_key == key {
                value.map(|value| value.to_os_string())
            } else {
                None
            }
        })
    }

    fn env_is_removed(command: &TokioCommand, key: &str) -> bool {
        command
            .as_std()
            .get_envs()
            .any(|(env_key, value)| env_key == key && value.is_none())
    }

    #[tokio::test]
    async fn ignored_file_probe_reports_files_hidden_by_git_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        run_git_success_async(temp.path(), &["init", "-q"], GIT_MUTATING_COMMAND_TIMEOUT)
            .await
            .expect("initialize git repo");
        let path = temp.path().to_string_lossy().to_string();

        assert!(!git_has_ignored_files(path.clone())
            .await
            .expect("probe empty repo"));

        std::fs::write(temp.path().join(".gitignore"), "*.secret\n").expect("write gitignore");
        std::fs::write(temp.path().join("local.secret"), "do not delete")
            .expect("write ignored file");

        assert!(git_has_ignored_files(path)
            .await
            .expect("probe ignored file"));
    }

    #[tokio::test]
    async fn main_worktree_resolves_from_a_repository_subfolder() {
        let temp = tempfile::tempdir().expect("temp dir");
        run_git_success_async(temp.path(), &["init", "-q"], GIT_MUTATING_COMMAND_TIMEOUT)
            .await
            .expect("initialize git repo");
        let nested = temp.path().join("packages").join("app");
        std::fs::create_dir_all(&nested).expect("nested folder");

        let (current_root, main_worktree_path) = git_repo_context_async(&nested)
            .await
            .expect("repository context");

        assert_eq!(
            main_worktree_path,
            Some(normalize_path_string(&current_root))
        );
    }

    fn command_args(command: &TokioCommand) -> Vec<String> {
        command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn every_git_command_disables_the_repository_fsmonitor() {
        let git = Path::new("git");
        let repo = Path::new("/repo");

        for args in [
            ["status", "--porcelain"].as_slice(),
            ["rev-parse", "--is-inside-work-tree"].as_slice(),
            ["diff", "HEAD", "--numstat", "-z"].as_slice(),
            ["fetch", "--prune"].as_slice(),
        ] {
            let built = command_args(&build_git_command(git, repo, args));
            assert_eq!(
                &built[..2],
                ["-c", "core.fsmonitor=false"],
                "git {} must start with the fsmonitor override, got {built:?}",
                args.join(" ")
            );
            // No command needs the repository's hooks: `status` itself fires
            // `post-index-change` when it refreshes the index.
            assert_eq!(
                built[2..4],
                [
                    "-c".to_string(),
                    format!("core.hooksPath={}", disabled_git_hooks_dir().display())
                ],
                "git {} must disable repository hooks, got {built:?}",
                args.join(" ")
            );
            assert!(
                built.ends_with(
                    &args[1..]
                        .iter()
                        .map(|arg| arg.to_string())
                        .collect::<Vec<_>>()
                ),
                "git {} must keep its own arguments last, got {built:?}",
                args.join(" ")
            );
            let subcommand_at = built
                .iter()
                .position(|arg| arg == args[0])
                .expect("the subcommand is passed");
            for own in &args[1..] {
                let own_at = built
                    .iter()
                    .position(|arg| arg == own)
                    .expect("the caller's argument is passed");
                assert!(
                    own_at > subcommand_at,
                    "git {} must pass its subcommand first, got {built:?}",
                    args.join(" ")
                );
            }
        }
    }

    #[test]
    fn fetching_names_the_remote_side_program_itself() {
        let git = Path::new("git");
        let repo = Path::new("/repo");

        // `remote.<name>.uploadpack` in the repository's own config names a
        // program git runs on every fetch, and `-c` cannot neutralise a
        // per-remote key the app does not know the name of. The option can, and
        // it has to sit after the subcommand it belongs to.
        for args in [
            ["fetch", "--prune"].as_slice(),
            ["pull", "--ff-only"].as_slice(),
        ] {
            let built = command_args(&build_git_command(git, repo, args));
            assert_eq!(
                &built[built.len() - 3..],
                [args[0], "--upload-pack=git-upload-pack", args[1]],
                "git {} must name the upload-pack program, got {built:?}",
                args.join(" ")
            );
        }

        // Nothing else carries it: it is not a valid option for them.
        for args in [
            ["status", "--porcelain"].as_slice(),
            ["switch", "main"].as_slice(),
            ["worktree", "add", "../wt", "main"].as_slice(),
        ] {
            let built = command_args(&build_git_command(git, repo, args));
            assert!(
                !built.iter().any(|arg| arg.starts_with("--upload-pack")),
                "git {} must not take a transport option, got {built:?}",
                args.join(" ")
            );
        }
    }

    #[test]
    fn mutating_git_commands_run_without_repository_hooks_or_ext_remotes() {
        let git = Path::new("git");
        let repo = Path::new("/repo");
        let hooks_override = format!("core.hooksPath={}", disabled_git_hooks_dir().display());
        assert!(
            disabled_git_hooks_dir().is_absolute(),
            "a relative hooks path would resolve inside the repository's .git"
        );
        assert!(!disabled_git_hooks_dir().exists());

        for args in [
            ["fetch", "--prune"].as_slice(),
            ["pull", "--ff-only"].as_slice(),
            ["switch", "-c", "feature", "main"].as_slice(),
            ["checkout", "main"].as_slice(),
            ["worktree", "add", "-b", "feature", "../wt", "main"].as_slice(),
            ["branch", "-D", "--", "feature"].as_slice(),
            ["stash"].as_slice(),
        ] {
            let built = command_args(&build_git_command(git, repo, args));
            let overrides: Vec<&str> = built
                .windows(2)
                .filter(|pair| pair[0] == "-c")
                .map(|pair| pair[1].as_str())
                .collect();
            assert!(
                overrides.contains(&hooks_override.as_str()),
                "git {} must disable repository hooks, got {built:?}",
                args.join(" ")
            );
            assert!(
                overrides.contains(&"protocol.ext.allow=never"),
                "git {} must refuse ext:: remotes, got {built:?}",
                args.join(" ")
            );
        }

        // A read is not exempt from the hooks override, and takes no ext::
        // override, which is for the commands that reach a remote.
        for args in [
            ["status", "--porcelain"].as_slice(),
            ["for-each-ref", "refs/heads"].as_slice(),
            ["worktree", "list", "--porcelain"].as_slice(),
        ] {
            let built = command_args(&build_git_command(git, repo, args));
            assert!(
                built.contains(&hooks_override),
                "read-only git {} must disable repository hooks too, got {built:?}",
                args.join(" ")
            );
            assert!(
                !built.iter().any(|arg| arg == "protocol.ext.allow=never"),
                "read-only git {} reaches no remote, got {built:?}",
                args.join(" ")
            );
        }
    }

    /// A folder that came with its own `.git` plants a hook and a filter; the
    /// two reads the sidebar makes on its own must run neither. The same
    /// reads made without the app's hardening run both, which is what shows
    /// the plant works and the test can fail.
    #[tokio::test]
    async fn status_and_diff_run_neither_the_repositorys_hook_nor_its_filter() {
        let Some(git) = dir_env::resolve_control_executable("git") else {
            eprintln!("skipped: no git on this machine");
            return;
        };
        let scratch = tempfile::tempdir().expect("scratch folder");
        let repo = scratch.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo folder");
        // The planted programs are shell lines; they want forward slashes.
        let marks = scratch.path().to_string_lossy().replace('\\', "/");
        let hook_mark = scratch.path().join("hook-ran");
        let filter_mark = scratch.path().join("filter-ran");

        let plain = |args: &[&str]| {
            let output = std::process::Command::new(&git)
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .expect("git runs");
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        plain(&["init", "-q", "."]);
        plain(&["config", "user.email", "invented@example.invalid"]);
        plain(&["config", "user.name", "Invented"]);
        plain(&["config", "core.autocrlf", "false"]);
        std::fs::write(repo.join("tracked.txt"), "one\n").expect("write");
        plain(&["add", "tracked.txt"]);
        plain(&["commit", "-q", "-m", "first"]);

        let hooks = repo.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).expect("hooks folder");
        let hook = hooks.join("post-index-change");
        std::fs::write(
            &hook,
            format!("#!/bin/sh\necho hook >> \"{marks}/hook-ran\"\n"),
        )
        .expect("write hook");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755))
                .expect("mark hook executable");
        }
        plain(&[
            "config",
            "filter.planted.clean",
            &format!("sh -c 'echo clean >> {marks}/filter-ran; cat'"),
        ]);
        std::fs::write(repo.join(".gitattributes"), "* filter=planted\n").expect("write");

        // A file whose timestamp moved and whose content did not: git must
        // read it again, through the filter, and then writes the index it
        // refreshed, which is what fires the hook.
        let age = |hours: u64| {
            std::fs::write(repo.join("tracked.txt"), "one\n").expect("write");
            std::fs::File::options()
                .write(true)
                .open(repo.join("tracked.txt"))
                .and_then(|file| {
                    file.set_modified(
                        std::time::SystemTime::now() - Duration::from_secs(hours * 3600),
                    )
                })
                .expect("set the file's time");
        };
        let change = |round: &str| {
            std::fs::write(repo.join("tracked.txt"), format!("two {round}\n")).expect("write");
        };
        let clear = || {
            let _ = std::fs::remove_file(&hook_mark);
            let _ = std::fs::remove_file(&filter_mark);
        };

        // The control: git as anything else would run it.
        age(2);
        plain(&["status", "--porcelain"]);
        assert!(
            hook_mark.exists(),
            "the planted hook did not run in the control"
        );
        assert!(
            filter_mark.exists(),
            "the planted filter did not run in the control"
        );
        clear();
        change("control diff");
        plain(&["diff", "HEAD", "--numstat"]);
        assert!(
            filter_mark.exists(),
            "the planted filter did not run in the control diff"
        );

        // The app's own reads of the same two states.
        clear();
        age(3);
        let status =
            run_git_output_async(&repo, &["status", "--porcelain"], Duration::from_secs(30))
                .await
                .expect("the app's status runs");
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        assert!(
            !hook_mark.exists(),
            "the app's status ran the repository's hook"
        );
        assert!(
            !filter_mark.exists(),
            "the app's status ran the repository's filter"
        );

        change("app diff");
        let diff = run_git_output_async(
            &repo,
            &["diff", "HEAD", "--numstat", "-z"],
            Duration::from_secs(30),
        )
        .await
        .expect("the app's diff runs");
        assert!(
            diff.status.success(),
            "{}",
            String::from_utf8_lossy(&diff.stderr)
        );
        assert!(
            String::from_utf8_lossy(&diff.stdout).contains("tracked.txt"),
            "the app's diff did not report the changed file"
        );
        assert!(
            !hook_mark.exists(),
            "the app's diff ran the repository's hook"
        );
        assert!(
            !filter_mark.exists(),
            "the app's diff ran the repository's filter"
        );
    }

    #[test]
    fn a_diff_runs_no_program_the_repository_names() {
        let built = command_args(&build_git_command(
            Path::new("git"),
            Path::new("/repo"),
            &["diff", "HEAD", "--numstat", "-z"],
        ));
        assert_eq!(
            built[built.len() - 7..],
            [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=dirty",
                "HEAD",
                "--numstat",
                "-z"
            ]
        );
        // The first two are options of `diff` alone; `status` shares the third.
        let status = command_args(&build_git_command(
            Path::new("git"),
            Path::new("/repo"),
            &["status", "--porcelain"],
        ));
        assert!(!status.iter().any(|arg| arg.starts_with("--no-")));
        assert_eq!(
            status[status.len() - 3..],
            ["status", "--ignore-submodules=dirty", "--porcelain"]
        );
    }

    /// A folder that came with its own `.git` holds a nested repository whose
    /// config names a filter. The outer repository defines none, so nothing
    /// is switched off by name; the two reads the sidebar makes on its own
    /// must still not run it. The same reads made without the app's
    /// hardening do, which is what shows the plant works.
    #[tokio::test]
    async fn status_and_diff_do_not_run_a_nested_repositorys_filter() {
        let Some(git) = dir_env::resolve_control_executable("git") else {
            eprintln!("skipped: no git on this machine");
            return;
        };
        let scratch = tempfile::tempdir().expect("scratch folder");
        let repo = scratch.path().join("repo");
        let nested = repo.join("nested");
        std::fs::create_dir_all(&nested).expect("nested folder");
        let marks = scratch.path().to_string_lossy().replace('\\', "/");
        let filter_mark = scratch.path().join("filter-ran");

        let plain = |folder: &Path, args: &[&str]| {
            let output = std::process::Command::new(&git)
                .args(args)
                .current_dir(folder)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .expect("git runs");
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        let identify = |folder: &Path| {
            plain(folder, &["init", "-q", "."]);
            plain(
                folder,
                &["config", "user.email", "invented@example.invalid"],
            );
            plain(folder, &["config", "user.name", "Invented"]);
            plain(folder, &["config", "core.autocrlf", "false"]);
        };
        identify(&nested);
        std::fs::write(nested.join("tracked.txt"), "one\n").expect("write");
        plain(&nested, &["add", "tracked.txt"]);
        plain(&nested, &["commit", "-q", "-m", "first"]);
        plain(
            &nested,
            &[
                "config",
                "filter.planted.clean",
                &format!("sh -c 'echo clean >> {marks}/filter-ran; cat'"),
            ],
        );
        std::fs::write(nested.join(".gitattributes"), "* filter=planted\n").expect("write");
        identify(&repo);
        plain(&repo, &["add", "nested"]);
        plain(&repo, &["commit", "-q", "-m", "outer"]);

        // A tracked file inside the nested repository whose time moved: the
        // git started there reads it again, through the filter.
        let age = |hours: u64| {
            std::fs::File::options()
                .write(true)
                .open(nested.join("tracked.txt"))
                .and_then(|file| {
                    file.set_modified(
                        std::time::SystemTime::now() - Duration::from_secs(hours * 3600),
                    )
                })
                .expect("set the file's time");
        };

        // The control: git as anything else would run it.
        age(2);
        plain(&repo, &["status", "--porcelain"]);
        assert!(
            filter_mark.exists(),
            "the planted filter did not run in the control"
        );

        // The app's own reads of the same state.
        for args in [
            &["status", "--porcelain"][..],
            &["diff", "HEAD", "--numstat", "-z"][..],
        ] {
            let _ = std::fs::remove_file(&filter_mark);
            age(3);
            let output = run_git_output_async(&repo, args, Duration::from_secs(30))
                .await
                .expect("the app's read runs");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                !filter_mark.exists(),
                "the app's {} ran the nested repository's filter",
                args[0]
            );
        }
    }

    /// A folder that came with its own `.git` declares a promisor remote and
    /// points its branch at an object that is not there. Git answers a
    /// missing object by fetching it, with the program that config names.
    /// The reads the app makes on its own must not start that fetch; the
    /// same read made without the app's hardening does.
    #[tokio::test]
    async fn the_apps_own_reads_do_not_fetch_a_missing_object() {
        let Some(git) = dir_env::resolve_control_executable("git") else {
            eprintln!("skipped: no git on this machine");
            return;
        };
        let scratch = tempfile::tempdir().expect("scratch folder");
        let repo = scratch.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo folder");
        let marks = scratch.path().to_string_lossy().replace('\\', "/");
        let fetch_mark = scratch.path().join("fetch-ran");

        let plain = |args: &[&str]| {
            std::process::Command::new(&git)
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .expect("git runs")
        };
        assert!(plain(&["init", "-q", "-b", "main", "."]).status.success());
        plain(&["config", "remote.planted.url", "."]);
        plain(&["config", "remote.planted.promisor", "true"]);
        plain(&[
            "config",
            "remote.planted.uploadpack",
            &format!("sh -c 'echo fetch >> {marks}/fetch-ran' #"),
        ]);
        std::fs::write(
            repo.join(".git").join("refs").join("heads").join("main"),
            "1111111111111111111111111111111111111111\n",
        )
        .expect("write the branch");

        // The control: git as anything else would run it. The read itself
        // fails, the object being nowhere; the fetch was started first.
        plain(&["status", "--porcelain"]);
        assert!(
            fetch_mark.exists(),
            "the planted program did not run in the control"
        );

        for args in [
            &["status", "--porcelain"][..],
            &["diff", "HEAD", "--numstat", "-z"][..],
            &["rev-list", "--count", "HEAD"][..],
        ] {
            let _ = std::fs::remove_file(&fetch_mark);
            let _ = run_git_output_async(&repo, args, Duration::from_secs(30)).await;
            assert!(
                !fetch_mark.exists(),
                "the app's {} fetched from the repository's remote",
                args[0]
            );
        }
    }

    /// What the user asks for in a partial clone may need the objects it left
    /// on its remote, so those commands keep fetching them.
    #[test]
    fn only_the_users_own_commands_may_fetch_missing_objects() {
        for asked in [
            &["switch", "main"][..],
            &["checkout", "main"][..],
            &["fetch", "origin"][..],
            &["pull", "--ff-only"][..],
            &["worktree", "add", "../tree"][..],
        ] {
            assert!(git_args_may_fetch_missing_objects(asked), "{asked:?}");
        }
        for unasked in [
            &["status", "--porcelain"][..],
            &["diff", "HEAD", "--numstat", "-z"][..],
            &["rev-list", "--count", "HEAD"][..],
            &["for-each-ref", "refs/heads"][..],
            &["worktree", "list", "--porcelain"][..],
            &["stash", "list"][..],
            &["branch", "--show-current"][..],
        ] {
            assert!(!git_args_may_fetch_missing_objects(unasked), "{unasked:?}");
        }
    }

    #[test]
    fn only_the_repositorys_own_filter_drivers_are_switched_off() {
        // As `git config --show-scope --name-only --get-regexp` prints them.
        let listing = [
            "system\tfilter.lfs.clean",
            "system\tfilter.lfs.smudge",
            "global\tfilter.mine.clean",
            "local\tfilter.planted.clean",
            "local\tfilter.planted.smudge",
            "local\tfilter.odd=name with.dots.process",
            "worktree\tFilter.per-tree.required",
            "local\tcore.bare",
            "local\tfilter..clean",
            "no scope here",
        ]
        .join("\n");
        let drivers = repository_filter_drivers(&listing);
        assert_eq!(drivers, ["planted", "odd=name with.dots", "per-tree"]);

        let overrides = filter_overrides_for(&drivers[..1]);
        assert_eq!(
            overrides,
            [
                ("filter.planted.clean".to_string(), String::new()),
                ("filter.planted.smudge".to_string(), String::new()),
                ("filter.planted.process".to_string(), String::new()),
                ("filter.planted.required".to_string(), "false".to_string()),
            ]
        );
        assert!(filter_overrides_for(&[]).is_empty());

        // The two reads the sidebar makes on its own, and nothing the
        // operator asks for: a commit made with a filter off would write
        // what the filter was there to change.
        assert!(git_args_read_changed_files_unasked(&[
            "status",
            "--porcelain"
        ]));
        assert!(git_args_read_changed_files_unasked(&["diff", "HEAD"]));
        for asked in [
            ["add", "-A"].as_slice(),
            ["commit", "-m", "x"].as_slice(),
            ["stash"].as_slice(),
            ["switch", "main"].as_slice(),
            ["checkout", "main"].as_slice(),
        ] {
            assert!(!git_args_read_changed_files_unasked(asked), "{asked:?}");
        }
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, contents).expect("write script");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .expect("mark script executable");
    }

    #[cfg(unix)]
    fn marker_script(marker: &Path) -> String {
        format!("#!/bin/sh\ntouch '{}'\nexit 0\n", marker.display())
    }

    #[cfg(unix)]
    async fn untrusted_repo_fixture() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().expect("temp dir");
        let repo = temp.path().join("untrusted");
        std::fs::create_dir_all(&repo).expect("repo dir");
        let setup = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("run setup git");
            assert!(
                output.status.success(),
                "setup git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        setup(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("tracked.txt"), "tracked\n").expect("tracked file");
        setup(&["add", "tracked.txt"]);
        setup(&[
            "-c",
            "user.name=Flock Test",
            "-c",
            "user.email=flock@example.test",
            "commit",
            "-qm",
            "fixture",
        ]);
        (temp, repo)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn repository_fsmonitor_program_does_not_run_during_status() {
        let (temp, repo) = untrusted_repo_fixture().await;
        let marker = temp.path().join("fsmonitor-ran");
        let script = temp.path().join("fsmonitor.sh");
        write_executable(&script, &marker_script(&marker));
        let output = std::process::Command::new("git")
            .args(["config", "core.fsmonitor", &script.to_string_lossy()])
            .current_dir(&repo)
            .output()
            .expect("configure fsmonitor");
        assert!(output.status.success());
        std::fs::write(repo.join("tracked.txt"), "changed\n").expect("dirty the worktree");

        let status = run_git_success_async(
            &repo,
            &["status", "--porcelain", "-z", "--untracked-files=all"],
            GIT_STATUS_COMMAND_TIMEOUT,
        )
        .await
        .expect("git status");
        run_git_success_async(
            &repo,
            &["diff", "HEAD", "--numstat", "-z"],
            GIT_STATUS_COMMAND_TIMEOUT,
        )
        .await
        .expect("git diff");

        assert!(
            status.contains("tracked.txt"),
            "status still reports changes"
        );
        assert!(
            !marker.exists(),
            "the repository's core.fsmonitor program ran during git status"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn repository_hooks_do_not_run_during_branch_switch() {
        let (temp, repo) = untrusted_repo_fixture().await;
        let marker = temp.path().join("post-checkout-ran");
        let hooks = repo.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).expect("hooks dir");
        write_executable(&hooks.join("post-checkout"), &marker_script(&marker));

        run_git_success_async(
            &repo,
            &["switch", "-c", "feature", "main"],
            GIT_MUTATING_COMMAND_TIMEOUT,
        )
        .await
        .expect("git switch");

        let branch = run_git_success_async(
            &repo,
            &["branch", "--show-current"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await
        .expect("current branch");
        assert_eq!(branch.trim(), "feature");
        assert!(
            !marker.exists(),
            "the repository's post-checkout hook ran during git switch"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn repository_ext_remote_is_refused_on_fetch() {
        let (temp, repo) = untrusted_repo_fixture().await;
        let marker = temp.path().join("ext-remote-ran");
        let script = temp.path().join("remote-helper.sh");
        write_executable(&script, &marker_script(&marker));
        // Git refuses `ext::` on its own unless config allows it — and the
        // repository's own `.git/config` is config.
        for args in [
            ["config", "protocol.ext.allow", "always"].as_slice(),
            [
                "remote",
                "add",
                "origin",
                &format!("ext::{}", script.display()),
            ]
            .as_slice(),
        ] {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("configure ext remote");
            assert!(output.status.success());
        }

        let result =
            run_git_success_async(&repo, &["fetch", "--prune"], GIT_MUTATING_COMMAND_TIMEOUT).await;

        assert!(result.is_err(), "fetch over ext:: must fail");
        assert!(
            !marker.exists(),
            "the repository's ext:: remote command ran during git fetch"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn repository_upload_pack_program_does_not_run_on_fetch() {
        let (temp, repo) = untrusted_repo_fixture().await;
        let marker = temp.path().join("upload-pack-ran");
        let script = temp.path().join("upload-pack.sh");
        // Still a working upload-pack, so a fetch that honours the key succeeds
        // and the only observable difference is the marker.
        write_executable(
            &script,
            &format!(
                "#!/bin/sh\ntouch '{}'\nexec git-upload-pack \"$@\"\n",
                marker.display()
            ),
        );
        // The remote is the fixture itself: a fetch needs no network, and the
        // program git runs for it comes from the repository's own config.
        let origin = temp.path().join("origin");
        std::fs::create_dir_all(&origin).expect("origin dir");
        let clone = std::process::Command::new("git")
            .args(["clone", "-q", "--bare", ".", &origin.to_string_lossy()])
            .current_dir(&repo)
            .output()
            .expect("clone the fixture");
        assert!(
            clone.status.success(),
            "clone failed: {}",
            String::from_utf8_lossy(&clone.stderr)
        );
        for args in [
            ["remote", "add", "origin", &origin.to_string_lossy()].as_slice(),
            [
                "config",
                "remote.origin.uploadpack",
                &script.to_string_lossy(),
            ]
            .as_slice(),
        ] {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("configure the remote");
            assert!(output.status.success());
        }

        run_git_success_async(&repo, &["fetch", "--prune"], GIT_MUTATING_COMMAND_TIMEOUT)
            .await
            .expect("git fetch");

        assert!(
            !marker.exists(),
            "the repository's remote.origin.uploadpack program ran during git fetch"
        );
    }

    #[test]
    fn branch_names_cannot_be_read_as_git_options() {
        assert!(require_branch_name("--orphan=wipe", "Branch name").is_err());
        assert!(require_branch_name(" -f", "Branch name").is_err());
        assert_eq!(
            require_branch_name(" feature/x ", "Branch name").as_deref(),
            Ok("feature/x")
        );
        assert_eq!(
            require_branch_name("HEAD", "Base branch").as_deref(),
            Ok("HEAD")
        );
    }

    #[test]
    fn worktree_names_cannot_leave_the_worktrees_folder() {
        for name in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "C:evil",
            "C:\\evil",
            "name:stream",
            // DOS devices, which are not folders at all.
            "CON",
            "nul",
            "Aux",
            "COM1",
            "lpt9",
            "PRN.md",
            // Windows trims these, so the worktree would not be where the
            // caller was told it is.
            "feature.",
        ] {
            assert!(validate_worktree_name(name).is_err(), "accepted {name:?}");
        }
        assert_eq!(
            validate_worktree_name(" feature-x ").as_deref(),
            Ok("feature-x")
        );
        // Only the exact device names: a name that merely starts with one is a
        // perfectly good folder.
        for name in ["console", "contrib", "com10", "auxiliary"] {
            assert_eq!(validate_worktree_name(name).as_deref(), Ok(name));
        }
    }

    fn real(path: &Path) -> PathBuf {
        dunce::canonicalize(path).expect("a path that resolves")
    }

    fn sorted(mut folders: Vec<PathBuf>) -> Vec<PathBuf> {
        folders.sort();
        folders
    }

    /// The folders git itself lists as worktrees when asked in `folder`.
    async fn folders_git_lists(folder: &Path) -> Vec<PathBuf> {
        let raw = run_git_success_async(
            folder,
            &["worktree", "list", "--porcelain"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await
        .expect("git lists worktrees");
        parse_worktrees(&raw, None)
            .iter()
            .map(|worktree| real(Path::new(&worktree.path)))
            .collect()
    }

    /// The folders the app offers as worktrees when asked in `folder`.
    async fn folders_the_app_offers(folder: &Path) -> Vec<PathBuf> {
        let state = get_git_state_inner(folder.to_string_lossy().into_owned())
            .await
            .expect("git state");
        assert!(state.is_git_repo, "{} is a repository", folder.display());
        sorted(
            state
                .worktrees
                .iter()
                .map(|worktree| real(Path::new(&worktree.path)))
                .collect(),
        )
    }

    /// `<scratch>/repo` with one commit and `<scratch>/linked`, a worktree
    /// git added to it: what an honest repository looks like.
    fn repository_with_a_linked_worktree(git: &Path, scratch: &Path) -> (PathBuf, PathBuf) {
        let repo = scratch.join("repo");
        let linked = scratch.join("linked");
        std::fs::create_dir_all(&repo).expect("repo folder");
        let plain = |args: &[&str]| {
            let output = std::process::Command::new(git)
                .args(args)
                .current_dir(&repo)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .expect("git runs");
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        plain(&["init", "-q", "-b", "main", "."]);
        plain(&["config", "user.email", "invented@example.invalid"]);
        plain(&["config", "user.name", "Invented"]);
        plain(&["commit", "-q", "--allow-empty", "-m", "first"]);
        plain(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "side",
            &linked.to_string_lossy(),
        ]);
        (repo, linked)
    }

    /// An honest repository keeps every worktree it had, whichever of its
    /// folders the question is asked from.
    #[tokio::test]
    async fn real_worktrees_are_offered_from_every_folder_of_the_repository() {
        let Some(git) = dir_env::resolve_control_executable("git") else {
            eprintln!("skipped: no git on this machine");
            return;
        };
        let scratch = tempfile::tempdir().expect("scratch folder");
        let (repo, linked) = repository_with_a_linked_worktree(&git, scratch.path());
        let nested = repo.join("packages").join("app");
        std::fs::create_dir_all(&nested).expect("nested folder");

        let both = sorted(vec![real(&repo), real(&linked)]);
        for asked_from in [&repo, &linked, &nested] {
            assert_eq!(
                folders_the_app_offers(asked_from).await,
                both,
                "asked from {}",
                asked_from.display()
            );
        }
        let state = get_git_state_inner(repo.to_string_lossy().into_owned())
            .await
            .expect("git state");
        let main: Vec<_> = state
            .worktrees
            .iter()
            .filter(|worktree| worktree.is_main)
            .map(|worktree| real(Path::new(&worktree.path)))
            .collect();
        assert_eq!(main, [real(&repo)]);
    }

    /// A folder that came with its own `.git` adds an entry to the worktree
    /// registry that names a folder it has nothing to do with. Git lists
    /// that folder. The app lets a chat attach anything under a worktree it
    /// lists, so it must not.
    #[tokio::test]
    async fn a_folder_a_fabricated_worktree_entry_names_is_not_offered() {
        let Some(git) = dir_env::resolve_control_executable("git") else {
            eprintln!("skipped: no git on this machine");
            return;
        };
        let scratch = tempfile::tempdir().expect("scratch folder");
        let (repo, linked) = repository_with_a_linked_worktree(&git, scratch.path());
        let unrelated = scratch.path().join("unrelated");
        std::fs::create_dir_all(&unrelated).expect("unrelated folder");
        let planted = repo.join(".git").join("worktrees").join("planted");
        std::fs::create_dir_all(&planted).expect("registry entry");
        std::fs::write(
            planted.join("gitdir"),
            format!("{}/.git\n", unrelated.to_string_lossy().replace('\\', "/")),
        )
        .expect("write the entry");

        // The control: git lists the folder the entry names.
        assert!(
            folders_git_lists(&repo).await.contains(&real(&unrelated)),
            "git does not list the planted entry"
        );

        let honest = sorted(vec![real(&repo), real(&linked)]);
        for asked_from in [&repo, &linked] {
            assert_eq!(
                folders_the_app_offers(asked_from).await,
                honest,
                "asked from {}",
                asked_from.display()
            );
        }
    }

    /// A folder says, in one line, that its repository is someone else's.
    /// Git asked there lists that repository's worktrees, all of them real.
    /// That repository never heard of the folder, which must gain nothing.
    #[tokio::test]
    async fn a_folder_cannot_borrow_the_worktrees_of_a_repository_it_points_at() {
        let Some(git) = dir_env::resolve_control_executable("git") else {
            eprintln!("skipped: no git on this machine");
            return;
        };
        let scratch = tempfile::tempdir().expect("scratch folder");
        let (repo, linked) = repository_with_a_linked_worktree(&git, scratch.path());
        let repo_git = repo.join(".git").to_string_lossy().replace('\\', "/");

        // A `.git` file naming the other repository's git folder.
        let by_file = scratch.path().join("by-file");
        std::fs::create_dir_all(&by_file).expect("folder");
        std::fs::write(by_file.join(".git"), format!("gitdir: {repo_git}\n")).expect("write");
        // A git folder of its own that shares the other repository's.
        let by_folder = scratch.path().join("by-folder");
        std::fs::create_dir_all(by_folder.join(".git")).expect("folder");
        std::fs::write(
            by_folder.join(".git").join("HEAD"),
            "ref: refs/heads/main\n",
        )
        .expect("write");
        std::fs::write(
            by_folder.join(".git").join("commondir"),
            format!("{repo_git}\n"),
        )
        .expect("write");

        for borrower in [&by_file, &by_folder] {
            // The control: git lists the other repository's worktrees there.
            let listed = folders_git_lists(borrower).await;
            assert!(
                listed.contains(&real(&repo)) && listed.contains(&real(&linked)),
                "git does not list the other repository from {}",
                borrower.display()
            );
            assert_eq!(
                folders_the_app_offers(borrower).await,
                Vec::<PathBuf>::new(),
                "asked from {}",
                borrower.display()
            );
        }
    }

    /// The folders kept out of `listed`, for the checks that need no git.
    fn folders_kept(listed: &[&Path], common_dir: &Path, asked_from: &Path) -> Vec<PathBuf> {
        let listed = listed
            .iter()
            .map(|folder| build_worktree(folder.to_string_lossy().into_owned(), None, None))
            .collect();
        sorted(
            worktrees_of_this_repository(listed, common_dir, asked_from)
                .iter()
                .map(|worktree| real(Path::new(&worktree.path)))
                .collect(),
        )
    }

    /// What a folder's own `.git` file has to say before it counts as a
    /// worktree, on folders made by hand: the spellings git writes, and the
    /// ones that prove nothing.
    #[test]
    fn a_linked_worktree_is_confirmed_by_its_own_git_file() {
        let temp = tempfile::tempdir().expect("scratch folder");
        let scratch = real(temp.path());
        let spelled = scratch.to_string_lossy().replace('\\', "/");
        let folder_with_git_file = |name: &str, contents: String| {
            let folder = scratch.join(name);
            std::fs::create_dir_all(&folder).expect("folder");
            std::fs::write(folder.join(".git"), contents).expect("write");
            folder
        };
        let repo = scratch.join("repo");
        let common_dir = repo.join(".git");
        std::fs::create_dir_all(common_dir.join("worktrees")).expect("registry");
        std::fs::create_dir_all(scratch.join("other").join(".git").join("worktrees"))
            .expect("another repository");

        // As git writes it, and as git writes it with relative paths on.
        let absolute = folder_with_git_file(
            "absolute",
            format!("gitdir: {spelled}/repo/.git/worktrees/absolute\n"),
        );
        let relative = folder_with_git_file(
            "relative",
            "gitdir: ../repo/.git/worktrees/relative\r\n".to_string(),
        );
        let unconfirmed = [
            // A worktree of some other repository.
            folder_with_git_file(
                "of-another",
                format!("gitdir: {spelled}/other/.git/worktrees/of-another\n"),
            ),
            // The same, spelled to start inside this repository's registry.
            folder_with_git_file(
                "climbing",
                format!("gitdir: {spelled}/repo/.git/worktrees/../../../other/.git/worktrees/x\n"),
            ),
            // The git folder itself and not an entry of its registry.
            folder_with_git_file("git-folder", format!("gitdir: {spelled}/repo/.git\n")),
            // A registry on another machine. The name is compared and never
            // opened; opened, this address would stall the test for seconds.
            folder_with_git_file(
                "elsewhere",
                "gitdir: //192.0.2.10/share/repo/.git/worktrees/elsewhere\n".to_string(),
            ),
            // Not what git writes in a `.git` file.
            folder_with_git_file(
                "not-a-pointer",
                format!("{spelled}/repo/.git/worktrees/not-a-pointer\n"),
            ),
            // No `.git` at all, and no folder at all.
            {
                std::fs::create_dir_all(scratch.join("no-git")).expect("folder");
                scratch.join("no-git")
            },
            scratch.join("gone"),
        ];

        let mut listed: Vec<&Path> = vec![&repo, &absolute, &relative];
        listed.extend(unconfirmed.iter().map(PathBuf::as_path));
        let confirmed = sorted(vec![absolute.clone(), relative.clone(), repo.clone()]);
        for asked_from in [&repo, &absolute, &relative] {
            assert_eq!(
                folders_kept(&listed, &common_dir, asked_from),
                confirmed,
                "asked from {}",
                asked_from.display()
            );
        }
        // Listed by git is not enough to ask from either.
        for asked_from in [&unconfirmed[0], &unconfirmed[5]] {
            assert_eq!(
                folders_kept(&listed, &common_dir, asked_from),
                Vec::<PathBuf>::new(),
                "asked from {}",
                asked_from.display()
            );
        }

        // Windows compares names without case, and so must this.
        if cfg!(windows) {
            let shouted = folder_with_git_file(
                "shouted",
                format!(
                    "gitdir: {}/REPO/.GIT/WORKTREES/shouted\n",
                    spelled.to_uppercase()
                ),
            );
            assert_eq!(
                folders_kept(&[&repo, &shouted], &common_dir, &repo),
                sorted(vec![repo.clone(), shouted.clone()])
            );
        }
    }

    /// A bare repository is listed as its own folder, next to its worktrees.
    #[test]
    fn a_bare_repositorys_own_folder_stays_listed() {
        let temp = tempfile::tempdir().expect("scratch folder");
        let scratch = real(temp.path());
        let spelled = scratch.to_string_lossy().replace('\\', "/");
        let store = scratch.join("store.git");
        std::fs::create_dir_all(store.join("worktrees")).expect("registry");
        let linked = scratch.join("linked");
        std::fs::create_dir_all(&linked).expect("folder");
        std::fs::write(
            linked.join(".git"),
            format!("gitdir: {spelled}/store.git/worktrees/linked\n"),
        )
        .expect("write");
        let outside = scratch.join("outside");
        std::fs::create_dir_all(&outside).expect("folder");

        assert_eq!(
            folders_kept(&[&store, &linked], &store, &linked),
            sorted(vec![linked.clone(), store.clone()])
        );
        assert_eq!(
            folders_kept(&[&store, &linked], &store, &outside),
            Vec::<PathBuf>::new()
        );
    }

    /// `path` as the admin share of its own drive spells it
    /// (`\\localhost\C$\...`): the same folder reached as a share, as a mapped
    /// drive letter and its UNC path are. `None` where no such share can be
    /// reached (not Windows, admin shares off); the tests that need it say
    /// they were skipped.
    fn share_spelling(path: &Path) -> Option<PathBuf> {
        let real = real(path);
        let (drive, rest) = real.to_str()?.split_once(":\\")?;
        if !cfg!(windows) || drive.len() != 1 {
            return None;
        }
        let shared = PathBuf::from(format!(r"\\localhost\{drive}$\{rest}"));
        shared.is_dir().then_some(shared)
    }

    /// A drive and the share it is reached by are two spellings of one disk
    /// (bug hunt of 2026-11-25, C-4). A worktree whose `.git` file git wrote
    /// through either of them points back at this repository all the same,
    /// and a question asked through the other spelling of a worktree is asked
    /// from inside it. A folder that points at another repository gains
    /// nothing under either spelling.
    #[test]
    fn a_worktree_is_confirmed_under_either_spelling_of_its_disk() {
        let temp = tempfile::tempdir().expect("scratch folder");
        let scratch = real(temp.path());
        let Some(shared) = share_spelling(&scratch) else {
            eprintln!("skipped: no share spelling of {}", scratch.display());
            return;
        };
        let spelled = scratch.to_string_lossy().replace('\\', "/");
        let shared_spelled = shared.to_string_lossy().replace('\\', "/");
        let folder_with_git_file = |name: &str, contents: String| {
            let folder = scratch.join(name);
            std::fs::create_dir_all(&folder).expect("folder");
            std::fs::write(folder.join(".git"), contents).expect("write");
            folder
        };
        let repo = scratch.join("repo");
        let common_dir = repo.join(".git");
        std::fs::create_dir_all(common_dir.join("worktrees")).expect("registry");
        std::fs::create_dir_all(scratch.join("other").join(".git").join("worktrees"))
            .expect("another repository");
        let by_drive = folder_with_git_file(
            "by-drive",
            format!("gitdir: {spelled}/repo/.git/worktrees/by-drive\n"),
        );
        folder_with_git_file(
            "by-share",
            format!("gitdir: {shared_spelled}/repo/.git/worktrees/by-share\n"),
        );
        // Git lists a worktree as its `gitdir` entry spells it.
        let by_share = shared.join("by-share");
        // The control: through the share, a worktree of another repository.
        let of_another = folder_with_git_file(
            "of-another",
            format!("gitdir: {shared_spelled}/other/.git/worktrees/of-another\n"),
        );

        // The repository opened through the drive letter.
        let listed: [&Path; 4] = [&repo, &by_drive, &by_share, &of_another];
        let confirmed = sorted(vec![by_drive.clone(), real(&by_share), repo.clone()]);
        for asked_from in [
            repo.clone(),
            by_drive.clone(),
            shared.join("by-drive"),
            scratch.join("by-share"),
        ] {
            assert_eq!(
                folders_kept(&listed, &common_dir, &asked_from),
                confirmed,
                "asked from {}",
                asked_from.display()
            );
        }
        // The repository opened through the share: git spells its folder
        // and the main worktree that way, the rest as their entries say.
        let shared_repo = shared.join("repo");
        let listed: [&Path; 4] = [&shared_repo, &by_drive, &by_share, &of_another];
        let confirmed = sorted(vec![real(&shared_repo), by_drive.clone(), real(&by_share)]);
        for asked_from in [shared_repo.clone(), by_drive.clone(), by_share.clone()] {
            assert_eq!(
                folders_kept(&listed, &shared_repo.join(".git"), &asked_from),
                confirmed,
                "asked from {}",
                asked_from.display()
            );
        }
        // Listed is not enough under either spelling.
        for asked_from in [of_another.clone(), shared.join("of-another")] {
            assert_eq!(
                folders_kept(&listed, &common_dir, &asked_from),
                Vec::<PathBuf>::new(),
                "asked from {}",
                asked_from.display()
            );
        }
    }

    /// The same made by git: a worktree added through the share of the
    /// repository's disk is offered when the repository is opened through
    /// its drive letter (C-4).
    #[tokio::test]
    async fn a_worktree_git_added_through_the_share_of_its_disk_is_offered() {
        let Some(git) = dir_env::resolve_control_executable("git") else {
            eprintln!("skipped: no git on this machine");
            return;
        };
        let scratch = tempfile::tempdir().expect("scratch folder");
        let (repo, linked) = repository_with_a_linked_worktree(&git, scratch.path());
        let Some(shared) = share_spelling(scratch.path()) else {
            eprintln!("skipped: no share spelling of {}", scratch.path().display());
            return;
        };
        let via_share = shared.join("via-share");
        // Through the share as its user would run git there, who trusts the
        // share in their own config.
        let output = std::process::Command::new(&git)
            .args(["-c", "safe.directory=*", "-C"])
            .arg(shared.join("repo"))
            .args(["worktree", "add", "-q", "-b", "via-share"])
            .arg(&via_share)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git worktree add: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        // The control: git lists it, under the spelling it was added with.
        assert!(
            folders_git_lists(&repo).await.contains(&real(&via_share)),
            "git does not list the worktree added through the share"
        );
        assert_eq!(
            folders_the_app_offers(&repo).await,
            sorted(vec![real(&repo), real(&linked), real(&via_share)])
        );
    }

    /// A name in a `.git` file is opened only on a volume the question
    /// already reached: never on a machine it alone names.
    #[cfg(windows)]
    #[test]
    fn a_name_on_another_volume_is_never_opened() {
        let reached = [
            Path::new(r"E:\work\repo\.git"),
            Path::new(r"\\localhost\E$\work\linked"),
        ];
        for same in [
            r"e:\work\other",
            r"\\?\E:\work",
            "//localhost/E$/work/repo/.git/worktrees",
            r"\\?\UNC\LOCALHOST\e$\work",
        ] {
            assert!(on_a_reached_volume(Path::new(same), &reached), "{same}");
        }
        for elsewhere in [
            "//192.0.2.10/share/repo/.git/worktrees",
            r"\\server\E$\work",
            r"D:\work",
            "relative/work",
        ] {
            assert!(
                !on_a_reached_volume(Path::new(elsewhere), &reached),
                "{elsewhere}"
            );
        }
    }

    fn git_output(code: i32, stderr: &str) -> Output {
        #[cfg(windows)]
        let status =
            <std::process::ExitStatus as std::os::windows::process::ExitStatusExt>::from_raw(
                code as u32,
            );
        #[cfg(unix)]
        let status = <std::process::ExitStatus as std::os::unix::process::ExitStatusExt>::from_raw(
            code << 8,
        );
        Output {
            status,
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    /// Reads `folder`'s status `polls` times in the `Smart` order, with a git
    /// whose lite run ends as `lite` and whose captured run succeeds, and
    /// says which environments git ran with, in order.
    async fn smart_polls(folder: &Path, polls: usize, lite: &Output) -> Vec<EnvSource> {
        let ran = std::sync::Mutex::new(Vec::new());
        for _ in 0..polls {
            let read = run_with_smart_env(folder, "status --porcelain", |env_source| {
                ran.lock().expect("record").push(env_source);
                let output = match env_source {
                    EnvSource::Lite => lite.clone(),
                    _ => git_output(0, ""),
                };
                async move { Ok(output) }
            })
            .await;
            assert!(read.is_ok(), "git ran");
        }
        ran.into_inner().expect("record")
    }

    /// A folder where git failed with the lite environment goes straight to
    /// the captured one on every later read (bug hunt of 2026-11-25, D-9).
    #[tokio::test]
    async fn a_folder_where_the_lite_env_failed_goes_straight_to_the_captured_env() {
        let failing = tempfile::tempdir().expect("folder");
        let other = tempfile::tempdir().expect("folder");
        let lite_failure = git_output(
            128,
            "fatal: bad config line 1 in file C:/Users/example/.gitconfig",
        );
        assert_eq!(
            smart_polls(failing.path(), 3, &lite_failure).await,
            [
                EnvSource::Lite,
                EnvSource::Captured,
                EnvSource::Captured,
                EnvSource::Captured
            ]
        );
        assert!(lite_env_failed_in(failing.path()));

        // The controls: a folder where the lite run succeeds stays on it, and
        // a failure the captured environment cannot mend is neither retried
        // nor remembered.
        assert_eq!(
            smart_polls(other.path(), 2, &git_output(0, "")).await,
            [EnvSource::Lite, EnvSource::Lite]
        );
        let not_a_repository = git_output(
            128,
            "fatal: not a git repository (or any of the parent directories): .git",
        );
        assert_eq!(
            smart_polls(other.path(), 2, &not_a_repository).await,
            [EnvSource::Lite, EnvSource::Lite]
        );
        assert!(!lite_env_failed_in(other.path()));
    }

    /// The one line a folder's lite-env failure gets in the log: the exit
    /// code and git's stderr, credentials masked, a long stderr cut.
    #[test]
    fn a_lite_env_failure_is_logged_with_its_exit_code_and_stderr() {
        let folder = Path::new("E:/projects/example");
        let note = lite_env_failure_note(
            folder,
            "status --porcelain",
            &git_output(
                128,
                "fatal: unable to access 'https://example.test/': token=invented-1\nhint: check the helper\n",
            ),
        );
        assert!(note.contains("exit code 128"), "{note}");
        assert!(
            note.contains(
                "fatal: unable to access 'https://example.test/': token=[redacted] | hint: check the helper"
            ),
            "{note}"
        );
        assert!(!note.contains("invented-1"), "{note}");

        let long = lite_env_failure_note(
            folder,
            "status --porcelain",
            &git_output(1, &"x".repeat(5_000)),
        );
        assert!(
            long.contains(&format!("{}…", "x".repeat(LITE_ENV_STDERR_LOG_CHARS))),
            "{long}"
        );
        assert!(!long.contains(&"x".repeat(LITE_ENV_STDERR_LOG_CHARS + 1)));
        assert!(lite_env_failure_note(folder, "status", &git_output(1, ""))
            .contains("nothing on stderr"));
    }

    #[test]
    fn captured_git_env_replaces_command_env_and_preserves_full_snapshot() {
        let mut command = TokioCommand::new("git");
        command.env("STALE_VAR", "remove-me");
        let mut env = HashMap::from([
            (
                "PATH".to_string(),
                "/repo/.hermit/bin:/repo/bin:/usr/bin".to_string(),
            ),
            ("CUSTOM_DIR_ENV".to_string(), "forwarded".to_string()),
            ("GIT_DIR".to_string(), "/wrong/repo/.git".to_string()),
            ("GIT_WORK_TREE".to_string(), "/wrong/repo".to_string()),
            ("GIT_INDEX_FILE".to_string(), "/wrong/index".to_string()),
            ("GIT_NAMESPACE".to_string(), "wrong-namespace".to_string()),
            (
                "GIT_CONFIG_GLOBAL".to_string(),
                "/wrong/global.gitconfig".to_string(),
            ),
            (
                "GIT_CONFIG_SYSTEM".to_string(),
                "/wrong/system.gitconfig".to_string(),
            ),
            ("GIT_CEILING_DIRECTORIES".to_string(), "/repo".to_string()),
            (
                "GIT_DISCOVERY_ACROSS_FILESYSTEM".to_string(),
                "false".to_string(),
            ),
            (
                "GIT_OBJECT_DIRECTORY".to_string(),
                "/wrong/objects".to_string(),
            ),
            (
                "GIT_ALTERNATE_OBJECT_DIRECTORIES".to_string(),
                "/wrong/alternate-objects".to_string(),
            ),
            (
                "GIT_SSH_COMMAND".to_string(),
                "/usr/local/bin/company-ssh".to_string(),
            ),
        ]);

        sanitize_git_env(&mut env);
        apply_captured_git_env(&mut command, &env);

        assert_eq!(
            env_value(&command, "PATH"),
            Some(OsString::from("/repo/.hermit/bin:/repo/bin:/usr/bin"))
        );
        assert_eq!(
            env_value(&command, "CUSTOM_DIR_ENV"),
            Some(OsString::from("forwarded"))
        );
        assert_eq!(env_value(&command, "STALE_VAR"), None);
        assert_eq!(env_value(&command, "GIT_DIR"), None);
        assert_eq!(env_value(&command, "GIT_WORK_TREE"), None);
        assert_eq!(env_value(&command, "GIT_INDEX_FILE"), None);
        assert_eq!(env_value(&command, "GIT_NAMESPACE"), None);
        assert_eq!(env_value(&command, "GIT_CONFIG_GLOBAL"), None);
        assert_eq!(env_value(&command, "GIT_CONFIG_SYSTEM"), None);
        assert_eq!(env_value(&command, "GIT_CEILING_DIRECTORIES"), None);
        assert_eq!(env_value(&command, "GIT_DISCOVERY_ACROSS_FILESYSTEM"), None);
        assert_eq!(env_value(&command, "GIT_OBJECT_DIRECTORY"), None);
        assert_eq!(
            env_value(&command, "GIT_ALTERNATE_OBJECT_DIRECTORIES"),
            None
        );
        assert_eq!(
            env_value(&command, "GIT_SSH_COMMAND"),
            Some(OsString::from("/usr/local/bin/company-ssh"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn captured_windows_env_strips_mixed_case_git_controls() {
        let mut command = TokioCommand::new("git");
        let mut env = HashMap::from([
            ("git_work_tree".to_string(), "C:\\wrong".to_string()),
            (
                "git_ssh_command".to_string(),
                "C:\\Tools\\company-ssh.cmd".to_string(),
            ),
        ]);

        sanitize_git_env(&mut env);
        apply_captured_git_env(&mut command, &env);
        force_non_interactive(&mut command);

        assert_eq!(env_value(&command, "git_work_tree"), None);
        assert_eq!(
            env_value(&command, "git_ssh_command"),
            Some(OsString::from("C:\\Tools\\company-ssh.cmd"))
        );
    }

    #[test]
    fn git_env_sanitizer_fails_closed_for_unknown_git_variables() {
        let mut env = HashMap::from([
            (
                "GIT_FUTURE_REPOSITORY_CONTROL".to_string(),
                "unsafe".to_string(),
            ),
            ("GIT_SSH_COMMAND".to_string(), "company-ssh".to_string()),
            ("PATH".to_string(), "/usr/bin".to_string()),
        ]);

        sanitize_git_env(&mut env);

        assert!(!env.contains_key("GIT_FUTURE_REPOSITORY_CONTROL"));
        assert_eq!(env.get("GIT_SSH_COMMAND"), Some(&"company-ssh".to_string()));
        assert_eq!(env.get("PATH"), Some(&"/usr/bin".to_string()));
    }

    #[test]
    fn lite_git_env_preserves_explicit_transport_and_strips_explicit_controls() {
        let mut command = TokioCommand::new("git");
        command.env("GIT_SSH_COMMAND", "explicit-company-ssh");
        command.env("GIT_FUTURE_REPOSITORY_CONTROL", "unsafe");

        apply_lite_git_env(&mut command);

        assert_eq!(
            env_value(&command, "GIT_SSH_COMMAND"),
            Some(OsString::from("explicit-company-ssh"))
        );
        assert!(env_is_removed(&command, "GIT_FUTURE_REPOSITORY_CONTROL"));
    }

    /// What a captured environment hands a git child on Windows, observed
    /// through a hook because a hook is the one place a child of git can report
    /// the environment it received.
    ///
    /// It is NOT a test of app behaviour: it builds the command directly instead
    /// of through [`build_git_command`], so it does not carry the
    /// `core.hooksPath` override, and a repository's hooks deliberately do not
    /// run for any git command the app issues (see `git_args_mutate_repository`;
    /// `repository_hooks_do_not_run_during_branch_switch` is the pin for that).
    /// The environment it checks is what checkout filters — `git lfs` through
    /// `filter.lfs.smudge` — and credential helpers still need.
    ///
    /// What it must not hand over is a way into the project: a tool planted in
    /// the repository's own `.hermit\bin` is not on the child's PATH, so the
    /// hook, which did run, cannot start it.
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_captured_env_gives_a_git_child_no_path_into_the_project() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repo = temp.path().join("Project With Spaces");
        let hook = repo.join(".git").join("hooks").join("post-checkout");
        let hermit_bin = repo.join(".hermit").join("bin");
        let marker = repo.join("hermit-hook-ran.txt");
        std::fs::create_dir_all(&repo).expect("repo");
        let run_setup_git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("run setup git");
            assert!(
                output.status.success(),
                "setup git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_setup_git(&["init", "-q"]);
        std::fs::write(repo.join("tracked.txt"), "tracked\n").expect("tracked file");
        run_setup_git(&["add", "tracked.txt"]);
        run_setup_git(&[
            "-c",
            "user.name=Flock Test",
            "-c",
            "user.email=flock@example.test",
            "commit",
            "-qm",
            "fixture",
        ]);
        std::fs::create_dir_all(&hermit_bin).expect("Hermit bin");
        std::fs::write(
            hermit_bin.join("hermit-hook-tool.CMD"),
            format!("@echo off\r\n>\"{}\" echo managed\r\n", marker.display()),
        )
        .expect("managed CMD tool");
        // Git for Windows runs hooks under an MSYS sh, which rewrites `/d`
        // and `/c` into paths before cmd.exe sees them. Disable MSYS argument
        // conversion for this invocation so cmd receives its native switches.
        // Seed PATHEXT with `.CMD` inside the hook so this Hermit PATH test is
        // independent of the parent runner's executable-extension policy;
        // PATHEXT inheritance and extensionless lookup are covered by dedicated
        // child-process regressions. `exit "$?"` ensures a failed tool lookup
        // cannot silently pass.
        std::fs::write(
            &hook,
            "#!/bin/sh\necho ran > hook-ran.txt\nPATHEXT=\".CMD${PATHEXT:+;$PATHEXT}\"\nexport PATHEXT\nMSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c hermit-hook-tool\nexit \"$?\"\n",
        )
        .expect("hook");
        let mut command = TokioCommand::new("git");
        command
            .args(["checkout", "-b", "hook-test"])
            .current_dir(&repo);

        apply_git_environment(
            &mut command,
            &repo,
            EnvSource::Captured,
            Duration::from_secs(5),
        )
        .await;
        assert!(
            command
                .as_std()
                .get_envs()
                .any(|(key, value)| key.eq_ignore_ascii_case("PATHEXT") && value.is_some()),
            "captured Rust child env must carry PATHEXT; Git owns the downstream hook environment"
        );
        let output = command.output().await.expect("run Git hook");

        // The hook's exit status is the checkout's, and the hook fails for
        // want of the tool: that failure is the expected one.
        assert!(
            repo.join("hook-ran.txt").exists(),
            "the hook did not run: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !marker.exists(),
            "a tool from the project's own folder ran for a git child"
        );
    }

    #[cfg(windows)]
    #[test]
    fn git_command_program_is_not_resolved_from_captured_path() {
        let trusted_git = PathBuf::from(r"C:\Program Files\Git\cmd\git.exe");
        let project_bin = PathBuf::from(r"C:\repo\.hermit\bin");
        let mut command = build_git_command(&trusted_git, Path::new(r"C:\repo"), &["status"]);
        let env = HashMap::from([(
            "Path".to_string(),
            std::env::join_paths([project_bin.clone(), PathBuf::from(r"C:\Windows\System32")])
                .expect("captured PATH")
                .to_string_lossy()
                .into_owned(),
        )]);

        apply_captured_git_env(&mut command, &env);

        assert_eq!(command.as_std().get_program(), trusted_git.as_os_str());
        // Windows keeps the captured spelling of the variable ("Path"), so the
        // lookup has to match the way the platform compares environment keys.
        let path_value = command
            .as_std()
            .get_envs()
            .find_map(|(key, value)| {
                key.to_str()
                    .is_some_and(|key| env_key::matches(key, "PATH"))
                    .then(|| value.map(std::ffi::OsStr::to_os_string))
            })
            .flatten()
            .expect("command PATH");
        assert_eq!(
            std::env::split_paths(&path_value).next().as_deref(),
            Some(project_bin.as_path())
        );
    }

    #[test]
    fn env_source_policy_uses_captured_for_filter_and_credential_sensitive_commands() {
        assert_eq!(
            env_source_for_git_args(&["switch", "main"]),
            EnvSource::Captured
        );
        assert_eq!(env_source_for_git_args(&["stash"]), EnvSource::Captured);
        assert_eq!(env_source_for_git_args(&["init"]), EnvSource::Captured);
        assert_eq!(
            env_source_for_git_args(&["fetch", "--prune"]),
            EnvSource::Captured
        );
        assert_eq!(
            env_source_for_git_args(&["pull", "--ff-only"]),
            EnvSource::Captured
        );
        assert_eq!(
            env_source_for_git_args(&["worktree", "add", "../repo-worktrees/foo", "main"]),
            EnvSource::Captured
        );
        assert_eq!(
            env_source_for_git_args(&["worktree", "remove", "--force", "../repo-worktrees/foo"]),
            EnvSource::Captured
        );
        assert_eq!(
            env_source_for_git_args(&["branch", "-D", "--", "feature/foo"]),
            EnvSource::Captured
        );
    }

    #[test]
    fn force_non_interactive_sets_git_prompt_ssh_and_locale_defaults() {
        let mut command = TokioCommand::new("git");

        force_non_interactive(&mut command);
        pin_c_locale(&mut command);

        assert_eq!(
            env_value(&command, "GIT_TERMINAL_PROMPT"),
            Some(OsString::from("0"))
        );
        assert_eq!(
            env_value(&command, "GIT_SSH_COMMAND"),
            Some(OsString::from("ssh -o BatchMode=yes -o ConnectTimeout=10"))
        );
        assert_eq!(env_value(&command, "LC_ALL"), Some(OsString::from("C")));
        assert_eq!(env_value(&command, "LANG"), Some(OsString::from("C")));
    }
}
