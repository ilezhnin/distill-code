use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

const SKILL_FILE_NAME: &str = "SKILL.md";
const AGENTS_SKILLS_DIR: &str = ".agents/skills";
const MAX_SKILL_FILE_BYTES: u64 = 262_144;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentSkillsRequest {
    pub provider_id: Option<String>,
    pub workspace_paths: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillEntry {
    pub name: String,
    pub description: String,
    pub content: String,
    pub path: String,
    pub file_location: String,
    pub source_kind: String,
    pub source_label: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentSkillsResponse {
    pub skills: Vec<AgentSkillEntry>,
}

#[derive(Deserialize)]
struct SkillFrontmatter {
    name: Option<String>,
    description: Option<String>,
    metadata: Option<serde_json::Value>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SkillRootScope {
    App,
    User,
    Workspace,
}

struct SkillRoot {
    path: PathBuf,
    source_label: String,
    scope: SkillRootScope,
}

fn is_gemini_provider(provider_id: Option<&str>) -> bool {
    provider_id
        .unwrap_or_default()
        .to_ascii_lowercase()
        .contains("gemini")
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

fn workspace_search_dirs(workspace_path: &Path) -> Vec<PathBuf> {
    let root = find_git_root(workspace_path).unwrap_or_else(|| workspace_path.to_path_buf());
    let mut dirs: Vec<PathBuf> = workspace_path
        .ancestors()
        .take_while(|dir| dir.starts_with(&root))
        .map(Path::to_path_buf)
        .collect();
    dirs.reverse();
    dirs
}

fn display_name_for_path(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn skill_frontmatter(contents: &str) -> Option<(&str, &str)> {
    // SKILL.md files checked out on Windows usually have CRLF line endings
    // (core.autocrlf) and editors there may add a BOM; both are still skills.
    let contents = contents.strip_prefix('\u{feff}').unwrap_or(contents);
    let contents = contents
        .strip_prefix("---\n")
        .or_else(|| contents.strip_prefix("---\r\n"))?;
    let end = contents.find("\n---")?;
    let frontmatter = &contents[..end];
    let body_start = end + "\n---".len();
    let body = contents[body_start..]
        .strip_prefix("\r\n")
        .or_else(|| contents[body_start..].strip_prefix('\n'))
        .unwrap_or(&contents[body_start..]);
    Some((frontmatter, body))
}

fn read_skill(skill_dir: &Path, root: &SkillRoot) -> Option<AgentSkillEntry> {
    let skill_file = skill_dir.join(SKILL_FILE_NAME);
    let metadata = match root.scope {
        SkillRootScope::App | SkillRootScope::User => std::fs::metadata(&skill_file).ok()?,
        SkillRootScope::Workspace => std::fs::symlink_metadata(&skill_file).ok()?,
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_SKILL_FILE_BYTES {
        return None;
    }

    let content = std::fs::read_to_string(&skill_file).ok()?;
    let (frontmatter, _body) = skill_frontmatter(&content)?;
    let parsed = yaml_serde::from_str::<SkillFrontmatter>(frontmatter).ok()?;
    let name = parsed.name?.trim().to_string();
    let description = parsed.description?.trim().to_string();
    if name.is_empty() || description.is_empty() {
        return None;
    }

    let canonical_skill_dir = dunce::canonicalize(skill_dir).ok()?;
    let canonical_skill_file = dunce::canonicalize(skill_file).ok()?;

    Some(AgentSkillEntry {
        name,
        description,
        content,
        path: canonical_skill_dir.to_string_lossy().into_owned(),
        file_location: canonical_skill_file.to_string_lossy().into_owned(),
        source_kind: match root.scope {
            SkillRootScope::App => "app",
            SkillRootScope::User => {
                if parsed
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get("distillBundled"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    "app"
                } else {
                    "global"
                }
            }
            SkillRootScope::Workspace => "project",
        }
        .to_string(),
        source_label: root.source_label.clone(),
    })
}

fn add_skill_root(
    roots: &mut Vec<SkillRoot>,
    seen_roots: &mut HashSet<PathBuf>,
    root_path: PathBuf,
    scope: SkillRootScope,
    source_label: String,
    workspace_root: Option<&Path>,
) {
    let metadata = match scope {
        SkillRootScope::App | SkillRootScope::User => std::fs::metadata(&root_path),
        SkillRootScope::Workspace => std::fs::symlink_metadata(&root_path),
    };
    let Ok(metadata) = metadata else {
        return;
    };
    if !metadata.file_type().is_dir() {
        return;
    }
    let Ok(canonical_root) = dunce::canonicalize(root_path) else {
        return;
    };
    if matches!(scope, SkillRootScope::Workspace)
        && !workspace_root
            .map(|root| canonical_root.starts_with(root))
            .unwrap_or(false)
    {
        return;
    }
    if !seen_roots.insert(canonical_root.clone()) {
        return;
    }
    roots.push(SkillRoot {
        path: canonical_root,
        source_label,
        scope,
    });
}

fn collect_skill_roots(
    workspace_paths: Vec<String>,
    app_skills_root: Option<&Path>,
    personal_skills_root: Option<&Path>,
) -> Vec<SkillRoot> {
    let mut roots = Vec::new();
    let mut seen_roots = HashSet::new();

    if let Some(personal_skills_root) = personal_skills_root {
        add_skill_root(
            &mut roots,
            &mut seen_roots,
            personal_skills_root.to_path_buf(),
            SkillRootScope::User,
            "Personal".to_string(),
            None,
        );
    } else if let Some(home) = dirs::home_dir() {
        add_skill_root(
            &mut roots,
            &mut seen_roots,
            home.join(AGENTS_SKILLS_DIR),
            SkillRootScope::User,
            "Personal".to_string(),
            None,
        );
    }
    // Keep Personal roots ahead of Distill-owned app skills so any bare-name
    // activation chooses the user's skill while exact selection remains
    // path-based and can still target either entry.
    if let Some(app_skills_root) = app_skills_root {
        add_skill_root(
            &mut roots,
            &mut seen_roots,
            app_skills_root.to_path_buf(),
            SkillRootScope::App,
            "Distill app".to_string(),
            None,
        );
    }

    let mut seen_workspaces = HashSet::new();
    for raw_workspace_path in workspace_paths {
        let trimmed = raw_workspace_path.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(workspace_path) = dunce::canonicalize(expand_home_prefix(trimmed)) else {
            continue;
        };
        if !workspace_path.is_dir() || !seen_workspaces.insert(workspace_path.clone()) {
            continue;
        }

        for search_dir in workspace_search_dirs(&workspace_path) {
            add_skill_root(
                &mut roots,
                &mut seen_roots,
                search_dir.join(".distill").join("skills"),
                SkillRootScope::Workspace,
                display_name_for_path(&search_dir),
                Some(&search_dir),
            );
            add_skill_root(
                &mut roots,
                &mut seen_roots,
                search_dir.join(AGENTS_SKILLS_DIR),
                SkillRootScope::Workspace,
                display_name_for_path(&search_dir),
                Some(&search_dir),
            );
        }
    }

    roots
}

fn skill_source_priority(source_kind: &str) -> u8 {
    match source_kind {
        "project" => 0,
        "global" => 1,
        "app" => 2,
        _ => 3,
    }
}

fn collect_skills_from_roots(
    roots: Vec<SkillRoot>,
    provider_id: Option<&str>,
) -> Vec<AgentSkillEntry> {
    let mut seen_skill_paths = HashSet::new();
    let mut skills = Vec::new();

    for root in roots {
        let mut candidate_dirs = Vec::new();
        if root.path.join(SKILL_FILE_NAME).is_file() {
            candidate_dirs.push(root.path.clone());
        }
        if let Ok(entries) = std::fs::read_dir(&root.path) {
            for entry in entries.flatten() {
                let path = entry.path();
                let metadata = match root.scope {
                    SkillRootScope::App | SkillRootScope::User => std::fs::metadata(&path),
                    SkillRootScope::Workspace => std::fs::symlink_metadata(&path),
                };
                let Ok(metadata) = metadata else {
                    continue;
                };
                if !metadata.file_type().is_dir() {
                    continue;
                }
                if path.join(SKILL_FILE_NAME).is_file() {
                    candidate_dirs.push(path);
                }
            }
        }

        for candidate_dir in candidate_dirs {
            let Ok(canonical_candidate_dir) = dunce::canonicalize(candidate_dir) else {
                continue;
            };
            if !seen_skill_paths.insert(canonical_candidate_dir.clone()) {
                continue;
            }
            if let Some(skill) = read_skill(&canonical_candidate_dir, &root) {
                skills.push(skill);
            }
        }
    }

    if is_gemini_provider(provider_id) {
        // Discovery order carries workspace specificity: roots are visited from
        // repository root toward the active nested workspace, so a later skill
        // of the same source tier is the nearer one. A higher-priority source
        // (project, then Personal, then app) wins regardless of order.
        let mut order = Vec::new();
        let mut skills_by_name = HashMap::new();
        for skill in skills {
            let key = skill.name.to_ascii_lowercase();
            let replace = skills_by_name
                .get(&key)
                .map(|existing: &AgentSkillEntry| {
                    skill_source_priority(&skill.source_kind)
                        <= skill_source_priority(&existing.source_kind)
                })
                .unwrap_or(true);
            if !skills_by_name.contains_key(&key) {
                order.push(key.clone());
            }
            if replace {
                skills_by_name.insert(key, skill);
            }
        }
        skills = order
            .into_iter()
            .filter_map(|key| skills_by_name.remove(&key))
            .collect();
    }

    skills.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then_with(|| {
                skill_source_priority(&a.source_kind).cmp(&skill_source_priority(&b.source_kind))
            })
            .then_with(|| {
                let compatibility =
                    |path: &str| path.replace('\\', "/").contains("/.agents/skills/");
                compatibility(&a.path).cmp(&compatibility(&b.path))
            })
            .then_with(|| a.file_location.cmp(&b.file_location))
    });
    skills
}

#[cfg(test)]
fn collect_agent_skills(
    provider_id: Option<String>,
    workspace_paths: Vec<String>,
    app_skills_root: Option<&Path>,
    personal_skills_root: Option<&Path>,
) -> Vec<AgentSkillEntry> {
    let roots = collect_skill_roots(workspace_paths, app_skills_root, personal_skills_root);
    collect_skills_from_roots(roots, provider_id.as_deref())
}

#[tauri::command]
pub async fn list_distill_app_skills(
    app: AppHandle,
    bundled_skills_state: State<'_, crate::services::bundled_skills::BundledSkillsState>,
) -> Result<ListAgentSkillsResponse, String> {
    bundled_skills_state.wait_until_ready().await;
    let app_data_dir = crate::services::distill_root::app_root(&app)?;
    let app_skills_root = app_data_dir.join("skills");
    let skills = tokio::task::spawn_blocking(move || {
        let mut roots = Vec::new();
        let mut seen_roots = HashSet::new();
        add_skill_root(
            &mut roots,
            &mut seen_roots,
            app_skills_root,
            SkillRootScope::User,
            "Distill app".to_string(),
            None,
        );
        collect_skills_from_roots(roots, None)
            .into_iter()
            .filter(|skill| skill.source_kind == "app")
            .collect()
    })
    .await
    .map_err(|err| format!("Failed to list Distill app skills: {err}"))?;
    Ok(ListAgentSkillsResponse { skills })
}

#[tauri::command]
pub async fn list_agent_skills(
    app: AppHandle,
    bundled_skills_state: State<'_, crate::services::bundled_skills::BundledSkillsState>,
    request: ListAgentSkillsRequest,
) -> Result<ListAgentSkillsResponse, String> {
    bundled_skills_state.wait_until_ready().await;
    let app_data_dir = crate::services::distill_root::app_root(&app)?;
    let e2e_skills_root = app
        .try_state::<crate::services::e2e_mode::E2eMode>()
        .map(|mode| mode.skills_dir());
    let isolated = e2e_skills_root.is_some();
    let personal_skills_root = e2e_skills_root.unwrap_or_else(|| app_data_dir.join("skills"));
    let skills = tokio::task::spawn_blocking(move || {
        let mut roots =
            collect_skill_roots(request.workspace_paths, None, Some(&personal_skills_root));
        if !isolated {
            if let Some(home) = dirs::home_dir() {
                let mut seen = roots.iter().map(|root| root.path.clone()).collect();
                add_skill_root(
                    &mut roots,
                    &mut seen,
                    home.join(AGENTS_SKILLS_DIR),
                    SkillRootScope::User,
                    "Compatibility".into(),
                    None,
                );
            }
        }
        let mut skills = collect_skills_from_roots(roots, request.provider_id.as_deref());
        let primary_names: HashSet<_> = skills
            .iter()
            .filter(|skill| Path::new(&skill.path).starts_with(&personal_skills_root))
            .map(|skill| skill.name.to_lowercase())
            .collect();
        skills.retain(|skill| {
            skill.source_kind == "project"
                || Path::new(&skill.path).starts_with(&personal_skills_root)
                || !primary_names.contains(&skill.name.to_lowercase())
        });
        // Sorted by name and source priority: project overrides global/app.
        let mut seen_names = HashSet::new();
        skills.retain(|skill| seen_names.insert(skill.name.to_lowercase()));
        skills
    })
    .await
    .map_err(|err| format!("Failed to list agent skills: {err}"))?;
    Ok(ListAgentSkillsResponse { skills })
}

#[cfg(test)]
mod tests {
    use super::{collect_skill_roots, collect_skills_from_roots, SkillRoot, SkillRootScope};
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn reads_skills_written_with_windows_line_endings_and_a_bom() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("skills");
        let skill_dir = root.join("crlf");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "\u{feff}---\r\nname: crlf\r\ndescription: Checked out on Windows\r\n---\r\n\r\nUse it.\r\n",
        )
        .unwrap();

        let skills = collect_skills_from_roots(
            vec![SkillRoot {
                path: root,
                source_label: "Personal".to_string(),
                scope: SkillRootScope::User,
            }],
            None,
        );

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "crlf");
        assert_eq!(skills[0].description, "Checked out on Windows");
    }

    #[test]
    fn workspace_scan_reads_only_agents_skills() {
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path().join("repo");
        for (rel, name) in [
            (".agents/skills/keep", "keep"),
            (".claude/skills/skip-claude", "skip-claude"),
            (".codex/skills/skip-codex", "skip-codex"),
            (".gemini/skills/skip-gemini", "skip-gemini"),
        ] {
            let dir = workspace.join(rel);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: x\n---\n\nbody\n"),
            )
            .unwrap();
        }

        let roots = collect_skill_roots(
            vec![workspace.to_string_lossy().into_owned()],
            None,
            Some(&tmp.path().join("missing-personal")),
        );
        let skills = collect_skills_from_roots(roots, None);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "keep");
    }
}
