use serde::Serialize;
use std::path::Path;
use std::time::Duration;
use tokio::time::timeout;

use super::git::{
    is_git_repo_async, resolve_repo_path, run_git_success_async, GIT_STATUS_COMMAND_TIMEOUT,
};

const CHANGED_FILES_OPERATION_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_LINE_COUNT_SIZE: u64 = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[tauri::command]
pub async fn get_changed_files(path: String) -> Result<Vec<ChangedFile>, String> {
    match timeout(
        CHANGED_FILES_OPERATION_TIMEOUT,
        get_changed_files_inner(path),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!(
            "Git changes timed out after {} seconds",
            CHANGED_FILES_OPERATION_TIMEOUT.as_secs()
        )),
    }
}

async fn get_changed_files_inner(path: String) -> Result<Vec<ChangedFile>, String> {
    let repo_path = resolve_repo_path(&path)?;

    if !is_git_repo_async(&repo_path).await? {
        return Ok(Vec::new());
    }

    // `-z`: paths come through verbatim. Without it git C-quotes any path with
    // a non-ASCII character (`"\320\237...txt"`), which was shown as-is.
    let status_output = run_git_success_async(
        &repo_path,
        &["status", "--porcelain", "-z", "--untracked-files=all"],
        GIT_STATUS_COMMAND_TIMEOUT,
    )
    .await?;
    if status_output.trim().is_empty() {
        return Ok(Vec::new());
    }

    let head_numstat = read_head_numstat(&repo_path).await?;
    let head_stats = parse_numstat(&head_numstat);

    let mut files: Vec<ChangedFile> = Vec::new();

    for (index_status, worktree_status, file_path) in parse_porcelain_status(&status_output) {
        let status = parse_status_codes(index_status, worktree_status);

        let (additions, deletions) = match head_stats.get(&file_path).copied() {
            Some(stats) => stats,
            None => count_file_lines(&repo_path, &file_path).await,
        };

        files.push(ChangedFile {
            path: file_path,
            status,
            additions,
            deletions,
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

async fn read_head_numstat(repo_path: &Path) -> Result<String, String> {
    match run_git_success_async(
        repo_path,
        &["diff", "HEAD", "--numstat", "-z"],
        GIT_STATUS_COMMAND_TIMEOUT,
    )
    .await
    {
        Ok(output) => Ok(output),
        Err(error) if is_missing_head_error(&error) => Ok(String::new()),
        Err(error) => Err(error),
    }
}

fn is_missing_head_error(error: &str) -> bool {
    error.contains("ambiguous argument 'HEAD'") || error.contains("bad revision 'HEAD'")
}

async fn count_file_lines(repo_path: &Path, file_path: &str) -> (u32, u32) {
    let full = repo_path.join(file_path);
    let meta = match tokio::fs::metadata(&full).await {
        Ok(meta) => meta,
        Err(_) => return (0, 0),
    };
    if meta.len() > MAX_LINE_COUNT_SIZE {
        return (0, 0);
    }
    match tokio::fs::read_to_string(&full).await {
        Ok(contents) => (contents.lines().count() as u32, 0),
        Err(_) => (0, 0),
    }
}

fn parse_status_codes(index: u8, worktree: u8) -> String {
    if index == b'?' && worktree == b'?' {
        return "untracked".to_string();
    }
    if index == b'A' || (index == b'?' && worktree != b'?') {
        return "added".to_string();
    }
    if index == b'D' || worktree == b'D' {
        return "deleted".to_string();
    }
    if index == b'R' {
        return "renamed".to_string();
    }
    if index == b'C' {
        return "copied".to_string();
    }
    "modified".to_string()
}

/// Parses `git status --porcelain -z` into `(X, Y, path)` entries.
///
/// Each entry is `XY <path>` terminated by NUL; a rename or copy is followed
/// by one more NUL-terminated field holding the original path, which is
/// skipped because the changed file is the new one.
fn parse_porcelain_status(output: &str) -> Vec<(u8, u8, String)> {
    let mut entries = Vec::new();
    let mut fields = output.split('\0');
    while let Some(field) = fields.next() {
        let bytes = field.as_bytes();
        if bytes.len() < 4 || bytes[2] != b' ' {
            continue;
        }
        let (index_status, worktree_status) = (bytes[0], bytes[1]);
        if matches!(index_status, b'R' | b'C') || matches!(worktree_status, b'R' | b'C') {
            fields.next();
        }
        entries.push((index_status, worktree_status, field[3..].to_string()));
    }
    entries
}

/// Parses `git diff --numstat -z` into additions/deletions per path.
///
/// A plain entry is `<added>\t<deleted>\t<path>` terminated by NUL. A rename
/// leaves the path empty and is followed by two NUL-terminated fields, the
/// old path and the new one; the new one is the key.
fn parse_numstat(output: &str) -> std::collections::HashMap<String, (u32, u32)> {
    let mut map = std::collections::HashMap::new();
    let mut fields = output.split('\0');
    while let Some(field) = fields.next() {
        let mut parts = field.splitn(3, '\t');
        let (Some(additions), Some(deletions), Some(path)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            fields.next();
            match fields.next() {
                Some(new_path) => new_path,
                None => break,
            }
        } else {
            path
        };
        let additions = additions.parse::<u32>().unwrap_or(0);
        let deletions = deletions.parse::<u32>().unwrap_or(0);
        map.insert(path.to_string(), (additions, deletions));
    }
    map
}

#[cfg(test)]
mod tests {
    use super::{parse_numstat, parse_porcelain_status};

    #[test]
    fn porcelain_paths_arrive_unquoted_and_renames_report_the_new_path() {
        let output = "R  new name.txt\0old name.txt\0 M Привет.txt\0?? unt räcked.txt\0";

        assert_eq!(
            parse_porcelain_status(output),
            vec![
                (b'R', b' ', "new name.txt".to_string()),
                (b' ', b'M', "Привет.txt".to_string()),
                (b'?', b'?', "unt räcked.txt".to_string()),
            ]
        );
    }

    #[test]
    fn numstat_keys_renames_by_their_new_path() {
        let output = "0\t0\t\0old name.txt\0new name.txt\x001\t0\tПривет.txt\0-\t-\timage.png\0";

        let stats = parse_numstat(output);

        assert_eq!(stats.get("new name.txt"), Some(&(0, 0)));
        assert_eq!(stats.get("Привет.txt"), Some(&(1, 0)));
        assert_eq!(stats.get("image.png"), Some(&(0, 0)));
        assert_eq!(stats.len(), 3);
    }
}
