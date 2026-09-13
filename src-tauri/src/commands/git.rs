use serde::Serialize;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;
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

const GIT_STATE_CHANGED_EVENT: &str = "berd:git-state-changed";
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
    let worktrees = parse_worktrees(&worktrees_output, main_worktree_path.as_deref());
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
            match run_git_once_async(path, args, command_timeout, EnvSource::Lite).await {
                Ok(output)
                    if output.status.success() || !should_retry_with_captured_output(&output) =>
                {
                    Ok(output)
                }
                Ok(_) => {
                    log::info!(
                        "Retrying git {} with captured env after lite-env failure in {}",
                        rendered_args,
                        path.display()
                    );
                    run_git_once_async(path, args, command_timeout, EnvSource::Captured)
                        .await
                        .map_err(|error| {
                            format_git_run_error(error, &rendered_args, command_timeout)
                        })
                }
                Err(error) if should_retry_with_captured_error(&error) => {
                    log::info!(
                        "Retrying git {} with captured env after lite-env spawn failure in {}",
                        rendered_args,
                        path.display()
                    );
                    run_git_once_async(path, args, command_timeout, EnvSource::Captured)
                        .await
                        .map_err(|error| {
                            format_git_run_error(error, &rendered_args, command_timeout)
                        })
                }
                Err(error) => Err(format_git_run_error(error, &rendered_args, command_timeout)),
            }
        }
        EnvSource::Lite | EnvSource::Captured => {
            run_git_once_async(path, args, command_timeout, env_source)
                .await
                .map_err(|error| format_git_run_error(error, &rendered_args, command_timeout))
        }
    }
}

/// A folder the user opens may carry a `.git/config` and `.git/hooks` written
/// by someone else (an extracted archive, a shared drive). Git reads that
/// config with the same authority as the user's own, and several keys name
/// programs to run: `core.fsmonitor` during the index refresh every `status`
/// and `diff` performs — which the sidebar triggers on its own — hook scripts
/// on checkout and ref updates, and the `ext::` remote helper on fetch. These
/// command-line overrides outrank every config file, so the repository's
/// settings cannot run code through the app. The user's global config
/// (credential helpers, `safe.directory`, `autocrlf`) still applies.
const GIT_FSMONITOR_OVERRIDE: &str = "core.fsmonitor=false";
const GIT_EXT_PROTOCOL_OVERRIDE: &str = "protocol.ext.allow=never";

/// The hooks directory git is pointed at for mutating commands. It never
/// exists: a fresh per-process name under the temp dir, so neither the
/// repository nor anything that guessed a fixed name can populate it.
fn disabled_git_hooks_dir() -> &'static Path {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        std::env::temp_dir().join(format!(
            "berd-git-hooks-disabled-{}",
            uuid::Uuid::new_v4().simple()
        ))
    })
}

/// Commands that update refs or the worktree, and so would run the
/// repository's hooks (`post-checkout`, `reference-transaction`, `post-merge`)
/// or contact its remotes.
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
    let mut hardening = vec!["-c".to_string(), GIT_FSMONITOR_OVERRIDE.to_string()];
    if git_args_mutate_repository(args) {
        hardening.push("-c".to_string());
        hardening.push(format!(
            "core.hooksPath={}",
            disabled_git_hooks_dir().display()
        ));
        hardening.push("-c".to_string());
        hardening.push(GIT_EXT_PROTOCOL_OVERRIDE.to_string());
    }
    hardening
}

fn build_git_command(git: &Path, path: &Path, args: &[&str]) -> TokioCommand {
    let mut command = TokioCommand::new(git);
    command
        .args(git_hardening_args(args))
        .args(args)
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

    crate::services::process::apply_no_window_async(&mut command);
    timeout(command_timeout, command.output())
        .await
        .map_err(|_| GitRunError::TimedOut)?
        .map_err(GitRunError::Spawn)
}

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

/// Git transport variables Berd deliberately carries across repository
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
    let inherited_transport = std::env::vars().filter(|(key, _)| {
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
            assert!(
                built.ends_with(&args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>()),
                "git {} must keep its own arguments last, got {built:?}",
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

        for args in [
            ["status", "--porcelain"].as_slice(),
            ["for-each-ref", "refs/heads"].as_slice(),
            ["worktree", "list", "--porcelain"].as_slice(),
        ] {
            let built = command_args(&build_git_command(git, repo, args));
            assert!(
                !built.iter().any(|arg| arg.starts_with("core.hooksPath=")),
                "read-only git {} needs no hooks override, got {built:?}",
                args.join(" ")
            );
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
            "user.name=Berd Test",
            "-c",
            "user.email=berd@example.test",
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

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_captured_env_runs_hermit_managed_cmd_git_hook() {
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
            "user.name=Berd Test",
            "-c",
            "user.email=berd@example.test",
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
            "#!/bin/sh\nPATHEXT=\".CMD${PATHEXT:+;$PATHEXT}\"\nexport PATHEXT\nMSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c hermit-hook-tool\nexit \"$?\"\n",
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

        assert!(
            output.status.success(),
            "git checkout failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(marker)
                .expect("Hermit hook marker")
                .trim(),
            "managed"
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
    fn env_source_policy_uses_captured_for_hook_sensitive_mutations() {
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
