use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const AGENTS_FILENAME: &str = "AGENTS.md";
const MAX_CONTEXT_FILE_BYTES: u64 = 131_072;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceContextRequest {
    pub workspace_paths: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInstructionFile {
    pub path: String,
    pub workspace_paths: Vec<String>,
    pub content: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceContextResponse {
    pub instruction_files: Vec<WorkspaceInstructionFile>,
}

#[derive(Clone)]
struct InstructionFileAccumulator {
    path: PathBuf,
    workspace_paths: Vec<String>,
    content: String,
}

fn expand_home_prefix(path: &str) -> PathBuf {
    match dirs::home_dir() {
        Some(home) if path == "~" => home,
        Some(home) => path
            .strip_prefix("~/")
            .or_else(|| path.strip_prefix("~\\"))
            .map_or_else(|| PathBuf::from(path), |relative| home.join(relative)),
        None => PathBuf::from(path),
    }
}

fn find_git_root(start_dir: &Path) -> Option<PathBuf> {
    let mut check_dir = start_dir;

    loop {
        if check_dir.join(".git").exists() {
            return Some(check_dir.to_path_buf());
        }
        if let Some(parent) = check_dir.parent() {
            check_dir = parent;
        } else {
            return None;
        }
    }
}

fn instruction_search_dirs(workspace_path: &Path) -> Vec<PathBuf> {
    let root = find_git_root(workspace_path).unwrap_or_else(|| workspace_path.to_path_buf());
    let mut dirs: Vec<PathBuf> = workspace_path
        .ancestors()
        .take_while(|dir| dir.starts_with(&root))
        .map(Path::to_path_buf)
        .collect();
    dirs.reverse();
    dirs
}

fn read_instruction_file(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CONTEXT_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn collect_workspace_instruction_files(
    workspace_paths: Vec<String>,
) -> Vec<WorkspaceInstructionFile> {
    let mut seen_workspaces = HashSet::new();
    let mut files_by_path: HashMap<PathBuf, InstructionFileAccumulator> = HashMap::new();
    let mut ordered_paths: Vec<PathBuf> = Vec::new();

    for raw_workspace_path in workspace_paths {
        let trimmed = raw_workspace_path.trim();
        if trimmed.is_empty() {
            continue;
        }

        let workspace_path = expand_home_prefix(trimmed);
        let Ok(canonical_workspace_path) = dunce::canonicalize(workspace_path) else {
            continue;
        };
        if !canonical_workspace_path.is_dir() {
            continue;
        }

        let workspace_label = canonical_workspace_path.to_string_lossy().into_owned();
        if !seen_workspaces.insert(workspace_label.clone()) {
            continue;
        }

        for dir in instruction_search_dirs(&canonical_workspace_path) {
            let candidates = [
                dir.join(AGENTS_FILENAME),
                dir.join(".distill").join(AGENTS_FILENAME),
            ];
            for instruction_path in candidates {
                let Some(content) = read_instruction_file(&instruction_path) else {
                    continue;
                };
                let Ok(canonical_instruction_path) = dunce::canonicalize(&instruction_path) else {
                    continue;
                };

                match files_by_path.get_mut(&canonical_instruction_path) {
                    Some(existing) => existing.workspace_paths.push(workspace_label.clone()),
                    None => {
                        ordered_paths.push(canonical_instruction_path.clone());
                        files_by_path.insert(
                            canonical_instruction_path.clone(),
                            InstructionFileAccumulator {
                                path: canonical_instruction_path,
                                workspace_paths: vec![workspace_label.clone()],
                                content,
                            },
                        );
                    }
                }
            }
        }
    }

    ordered_paths
        .into_iter()
        .filter_map(|path| files_by_path.remove(&path))
        .map(|file| WorkspaceInstructionFile {
            path: file.path.to_string_lossy().into_owned(),
            workspace_paths: file.workspace_paths,
            content: file.content,
        })
        .collect()
}

#[tauri::command]
pub async fn load_workspace_context(
    request: LoadWorkspaceContextRequest,
) -> Result<LoadWorkspaceContextResponse, String> {
    let instruction_files = tokio::task::spawn_blocking(move || {
        collect_workspace_instruction_files(request.workspace_paths)
    })
    .await
    .map_err(|err| format!("Failed to load workspace context: {err}"))?;
    Ok(LoadWorkspaceContextResponse { instruction_files })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temp_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ws-ctx-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(".git")).unwrap();
        dir
    }

    fn write_agents(dir: &Path, relative: &str, contents: &str) {
        let path = dir.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn is_repo_agents(path: &str) -> bool {
        let normalized = path.replace('\\', "/");
        normalized.ends_with("/AGENTS.md") && !normalized.contains("/.distill/")
    }

    fn is_distill_agents(path: &str) -> bool {
        path.replace('\\', "/").ends_with("/.distill/AGENTS.md")
    }

    #[test]
    fn collects_only_repo_agents_md() {
        let root = temp_repo();
        write_agents(&root, "AGENTS.md", "from repo");

        let files = collect_workspace_instruction_files(vec![root.to_string_lossy().into_owned()]);
        assert_eq!(files.len(), 1);
        assert!(is_repo_agents(&files[0].path), "{}", files[0].path);
        assert_eq!(files[0].content, "from repo");
    }

    #[test]
    fn collects_repo_agents_md_before_distill_agents_md() {
        let root = temp_repo();
        write_agents(&root, "AGENTS.md", "from repo");
        write_agents(&root, ".distill/AGENTS.md", "from distill");

        let files = collect_workspace_instruction_files(vec![root.to_string_lossy().into_owned()]);
        assert_eq!(files.len(), 2);
        assert!(is_repo_agents(&files[0].path), "{}", files[0].path);
        assert_eq!(files[0].content, "from repo");
        assert!(is_distill_agents(&files[1].path), "{}", files[1].path);
        assert_eq!(files[1].content, "from distill");
    }

    #[test]
    fn collects_distill_agents_md_in_a_subfolder_workspace() {
        let root = temp_repo();
        let sub = root.join("pkg");
        write_agents(&sub, ".distill/AGENTS.md", "from sub distill");

        let files = collect_workspace_instruction_files(vec![sub.to_string_lossy().into_owned()]);
        assert_eq!(files.len(), 1);
        assert!(is_distill_agents(&files[0].path), "{}", files[0].path);
        assert_eq!(files[0].content, "from sub distill");
    }
}
