//! Skills, agents (personas), and projects as files on disk. This is the
//! host-side replacement for goose's "sources": the same on-disk layout
//! (`~/.agents/skills/<name>/SKILL.md`, `~/.agents/agents/<slug>.md`,
//! `<app data>/projects/<slug>.md`) so existing files keep working.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

use super::protocol::{self, invalid_params};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceType {
    Skill,
    BuiltinSkill,
    Agent,
    Project,
}

impl SourceType {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "skill" => Some(Self::Skill),
            "builtinSkill" => Some(Self::BuiltinSkill),
            "agent" => Some(Self::Agent),
            "project" => Some(Self::Project),
            _ => None,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            Self::Skill => "skill",
            Self::BuiltinSkill => "builtinSkill",
            Self::Agent => "agent",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Clone)]
struct Root {
    path: PathBuf,
    global: bool,
    writable: bool,
}

pub struct SourceRoots {
    /// `<app data>/projects` — where projects live.
    pub projects_dir: PathBuf,
    /// `<app data>/skills` — bundled skills seeded by the app.
    pub builtin_skills_dir: PathBuf,
    /// Legacy goose data dir to migrate projects from, once.
    pub legacy_projects_dir: Option<PathBuf>,
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn skill_roots(project_dir: Option<&Path>) -> Vec<Root> {
    let mut roots = Vec::new();
    if let Some(dir) = project_dir {
        roots.push(Root {
            path: dir.join(".agents").join("skills"),
            global: false,
            writable: true,
        });
        roots.push(Root {
            path: dir.join(".claude").join("skills"),
            global: false,
            writable: false,
        });
    }
    if let Some(home) = home() {
        roots.push(Root {
            path: home.join(".agents").join("skills"),
            global: true,
            writable: true,
        });
        roots.push(Root {
            path: home.join(".claude").join("skills"),
            global: true,
            writable: false,
        });
    }
    roots
}

fn agent_roots(project_dir: Option<&Path>) -> Vec<Root> {
    let mut roots = Vec::new();
    if let Some(dir) = project_dir {
        roots.push(Root {
            path: dir.join(".agents").join("agents"),
            global: false,
            writable: true,
        });
        roots.push(Root {
            path: dir.join(".claude").join("agents"),
            global: false,
            writable: false,
        });
    }
    if let Some(home) = home() {
        roots.push(Root {
            path: home.join(".agents").join("agents"),
            global: true,
            writable: true,
        });
        roots.push(Root {
            path: home.join(".claude").join("agents"),
            global: true,
            writable: false,
        });
    }
    roots
}

fn canonical(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn is_under(path: &Path, root: &Path) -> bool {
    let path = canonical(path);
    let root = canonical(root);
    path.starts_with(&root)
}

fn display(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Frontmatter

/// Split `---` frontmatter from a markdown body. Returns the YAML as a JSON
/// object (empty when the file has no frontmatter) and the trimmed body.
fn parse_frontmatter(raw: &str) -> (Map<String, Value>, String) {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return (Map::new(), raw.trim().to_string());
    }
    let parts: Vec<&str> = trimmed.split("---").collect();
    if parts.len() < 3 {
        return (Map::new(), raw.trim().to_string());
    }
    let yaml = parts[1].trim();
    let body = parts[2..].join("---").trim().to_string();
    let meta = yaml_serde::from_str::<Value>(yaml)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    (meta, body)
}

fn string_field(meta: &Map<String, Value>, key: &str) -> String {
    meta.get(key)
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

fn yaml_line(key: &str, value: &Value) -> String {
    let mut single = Map::new();
    single.insert(key.to_string(), value.clone());
    yaml_serde::to_string(&Value::Object(single)).unwrap_or_else(|_| format!("{key}: ''\n"))
}

/// `name` and `description` first, then every property as its own top-level
/// key: the agent/project file format.
fn build_markdown(
    name: &str,
    description: &str,
    content: &str,
    properties: &Map<String, Value>,
) -> String {
    let mut md = String::from("---\n");
    md.push_str(&yaml_line("name", &Value::String(name.to_string())));
    md.push_str(&yaml_line(
        "description",
        &Value::String(description.to_string()),
    ));
    for (key, value) in properties {
        if key == "name" || key == "description" {
            continue;
        }
        md.push_str(&yaml_line(key, value));
    }
    md.push_str("---\n");
    if !content.is_empty() {
        md.push('\n');
        md.push_str(content);
        md.push('\n');
    }
    md
}

/// SKILL.md keeps extra properties under `metadata:` (the agentskills.io
/// layout), so they never collide with reserved skill fields.
fn build_skill_markdown(
    name: &str,
    description: &str,
    content: &str,
    properties: &Map<String, Value>,
) -> String {
    let mut md = String::from("---\n");
    md.push_str(&yaml_line("name", &Value::String(name.to_string())));
    md.push_str(&yaml_line(
        "description",
        &Value::String(description.to_string()),
    ));
    if !properties.is_empty() {
        md.push_str(&yaml_line("metadata", &Value::Object(properties.clone())));
    }
    md.push_str("---\n");
    if !content.is_empty() {
        md.push('\n');
        md.push_str(content);
        md.push('\n');
    }
    md
}

fn properties_from_map(meta: &Map<String, Value>) -> Map<String, Value> {
    meta.iter()
        .filter(|(key, _)| key.as_str() != "name" && key.as_str() != "description")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn entry(
    source_type: SourceType,
    name: String,
    description: String,
    content: String,
    path: String,
    global: bool,
    writable: bool,
    properties: Map<String, Value>,
) -> Value {
    json!({
        "type": source_type.wire(),
        "name": name,
        "description": description,
        "content": content,
        "path": path,
        "global": global,
        "writable": writable,
        "supportingFiles": [],
        "properties": properties,
    })
}

// ---------------------------------------------------------------------------
// Skills

fn skill_entry(dir: &Path, root: &Root) -> Option<Value> {
    let raw = fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let (meta, body) = parse_frontmatter(&raw);
    let name = {
        let declared = string_field(&meta, "name");
        if declared.is_empty() {
            dir.file_name()?.to_string_lossy().into_owned()
        } else {
            declared
        }
    };
    let properties = meta
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut supporting: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for file in entries.flatten() {
            let file_name = file.file_name().to_string_lossy().into_owned();
            if file_name != "SKILL.md" && file.path().is_file() {
                supporting.push(file_name);
            }
        }
    }
    let mut value = entry(
        SourceType::Skill,
        name,
        string_field(&meta, "description"),
        body,
        display(dir),
        root.global,
        root.writable,
        properties,
    );
    value["supportingFiles"] = json!(supporting);
    Some(value)
}

fn scan_skill_root(root: &Root, out: &mut Vec<Value>) {
    scan_skill_dir(&root.path, root, 0, out);
}

fn scan_skill_dir(dir: &Path, root: &Root, depth: usize, out: &mut Vec<Value>) {
    if depth > 3 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    children.sort();
    for child in children {
        let name = child
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if child.join("SKILL.md").is_file() {
            if let Some(skill) = skill_entry(&child, root) {
                out.push(skill);
            }
        } else {
            scan_skill_dir(&child, root, depth + 1, out);
        }
    }
}

fn builtin_skills(roots: &SourceRoots) -> Vec<Value> {
    let mut out = Vec::new();
    let root = Root {
        path: roots.builtin_skills_dir.clone(),
        global: true,
        writable: false,
    };
    let Ok(entries) = fs::read_dir(&root.path) else {
        return out;
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.join("SKILL.md").is_file())
        .collect();
    dirs.sort();
    for dir in dirs {
        if let Some(mut skill) = skill_entry(&dir, &root) {
            let name = skill["name"].as_str().unwrap_or_default().to_string();
            skill["type"] = json!(SourceType::BuiltinSkill.wire());
            skill["path"] = json!(format!("builtin://skills/{name}"));
            out.push(skill);
        }
    }
    out
}

fn validate_skill_name(name: &str) -> Result<(), Value> {
    if name.is_empty() || name.len() > 128 {
        return Err(invalid_params("Skill name must be 1-128 characters"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(invalid_params(
            "Skill name may only contain letters, digits, '-' and '_'",
        ));
    }
    Ok(())
}

fn resolve_writable_skill_dir(path: &str, roots: &[Root]) -> Result<(PathBuf, Root), Value> {
    let dir = PathBuf::from(path);
    if !dir.join("SKILL.md").is_file() {
        return Err(invalid_params(format!("No SKILL.md at {path}")));
    }
    for root in roots {
        if root.writable && is_under(&dir, &root.path) {
            return Ok((dir, root.clone()));
        }
    }
    Err(invalid_params(format!(
        "{path} is not inside a writable skills directory"
    )))
}

// ---------------------------------------------------------------------------
// Agents

fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() {
        "agent".to_string()
    } else {
        slug
    }
}

fn agent_entry(file: &Path, root: &Root) -> Option<Value> {
    if file.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return None;
    }
    let raw = fs::read_to_string(file).ok()?;
    let (meta, body) = parse_frontmatter(&raw);
    if meta.is_empty() {
        return None;
    }
    let name = {
        let declared = string_field(&meta, "name");
        if declared.is_empty() {
            file.file_stem()?.to_string_lossy().into_owned()
        } else {
            declared
        }
    };
    Some(entry(
        SourceType::Agent,
        name,
        string_field(&meta, "description"),
        body,
        display(file),
        root.global,
        root.writable,
        properties_from_map(&meta),
    ))
}

fn scan_agent_root(root: &Root, out: &mut Vec<Value>) {
    let Ok(entries) = fs::read_dir(&root.path) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    files.sort();
    for file in files {
        if let Some(agent) = agent_entry(&file, root) {
            out.push(agent);
        }
    }
}

fn resolve_writable_agent_file(path: &str, roots: &[Root]) -> Result<(PathBuf, Root), Value> {
    let file = PathBuf::from(path);
    if !file.is_file() {
        return Err(invalid_params(format!("No agent file at {path}")));
    }
    for root in roots {
        if root.writable && is_under(&file, &root.path) {
            return Ok((file, root.clone()));
        }
    }
    Err(invalid_params(format!(
        "{path} is not inside a writable agents directory"
    )))
}

// ---------------------------------------------------------------------------
// Projects

fn ensure_projects_dir(roots: &SourceRoots) -> Result<(), Value> {
    if roots.projects_dir.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(&roots.projects_dir)
        .map_err(|error| protocol::internal(format!("failed to create projects dir: {error}")))?;
    // First run after leaving goose: carry the existing project files over.
    if let Some(legacy) = roots
        .legacy_projects_dir
        .as_ref()
        .filter(|dir| dir.is_dir())
    {
        if let Ok(entries) = fs::read_dir(legacy) {
            for file in entries.flatten() {
                let path = file.path();
                if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                    if let Some(name) = path.file_name() {
                        let _ = fs::copy(&path, roots.projects_dir.join(name));
                    }
                }
            }
            log::info!("[agent-host] migrated projects from {}", legacy.display());
        }
    }
    Ok(())
}

fn project_entry(file: &Path) -> Option<Value> {
    if file.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return None;
    }
    let slug = file.file_stem()?.to_string_lossy().into_owned();
    let raw = fs::read_to_string(file).ok()?;
    let (meta, body) = parse_frontmatter(&raw);
    let mut properties = properties_from_map(&meta);
    let title = string_field(&meta, "name");
    if !title.is_empty() && title != slug {
        properties.insert("title".to_string(), Value::String(title));
    }
    Some(entry(
        SourceType::Project,
        slug,
        string_field(&meta, "description"),
        body,
        display(file),
        true,
        true,
        properties,
    ))
}

fn validate_slug(slug: &str) -> Result<(), Value> {
    if slug.is_empty() || slug.len() > 128 {
        return Err(invalid_params("Project id must be 1-128 characters"));
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(invalid_params(
            "Project id may only contain letters, digits, '-' and '_'",
        ));
    }
    Ok(())
}

fn resolve_project_file(path: &str, roots: &SourceRoots) -> Result<PathBuf, Value> {
    let file = PathBuf::from(path);
    if !file.is_file() || !is_under(&file, &roots.projects_dir) {
        return Err(invalid_params(format!("No project file at {path}")));
    }
    Ok(file)
}

// ---------------------------------------------------------------------------
// Public API (wire shapes match the frontend's source types)

fn source_type_param(params: &Value) -> Result<SourceType, Value> {
    params
        .get("type")
        .and_then(Value::as_str)
        .and_then(SourceType::parse)
        .ok_or_else(|| invalid_params("Unsupported or missing source type"))
}

fn string_param(params: &Value, key: &str) -> Result<String, Value> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| invalid_params(format!("Missing \"{key}\"")))
}

fn properties_param(params: &Value) -> Option<Map<String, Value>> {
    params.get("properties").and_then(Value::as_object).cloned()
}

/// Resolve a `target` scope into (global, project_dir).
fn target_scope(
    params: &Value,
    project_dir_for_id: &dyn Fn(&str) -> Option<String>,
) -> Result<(bool, Option<PathBuf>), Value> {
    let target = params
        .get("target")
        .ok_or_else(|| invalid_params("Missing \"target\""))?;
    match target.get("scope").and_then(Value::as_str) {
        Some("global") | None => Ok((true, None)),
        Some("projectDir") => {
            let dir = target
                .get("projectDir")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("Missing projectDir"))?;
            Ok((false, Some(PathBuf::from(dir))))
        }
        Some("projectId") => {
            let id = target
                .get("projectId")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("Missing projectId"))?;
            let dir = project_dir_for_id(id)
                .ok_or_else(|| invalid_params(format!("Project {id} has no working directory")))?;
            Ok((false, Some(PathBuf::from(dir))))
        }
        Some(other) => Err(invalid_params(format!("Unknown target scope {other}"))),
    }
}

pub fn list(params: &Value, roots: &SourceRoots) -> Result<Value, Value> {
    let source_type = params
        .get("type")
        .and_then(Value::as_str)
        .map(|value| {
            SourceType::parse(value)
                .ok_or_else(|| invalid_params(format!("Unsupported source type {value}")))
        })
        .transpose()?;
    let project_dir = params
        .get("projectDir")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let include_project = params
        .get("includeProjectSources")
        .and_then(Value::as_bool)
        .unwrap_or(project_dir.is_some());
    let mut out = Vec::new();
    let types: Vec<SourceType> = match source_type {
        Some(kind) => vec![kind],
        None => vec![
            SourceType::Skill,
            SourceType::BuiltinSkill,
            SourceType::Agent,
            SourceType::Project,
        ],
    };
    for kind in types {
        match kind {
            SourceType::Skill => {
                for root in skill_roots(project_dir.as_deref()) {
                    if !root.global && !include_project {
                        continue;
                    }
                    if project_dir.is_some() && root.global {
                        // A project-scoped listing only wants that project's skills.
                        continue;
                    }
                    scan_skill_root(&root, &mut out);
                }
            }
            SourceType::BuiltinSkill => out.extend(builtin_skills(roots)),
            SourceType::Agent => {
                for root in agent_roots(project_dir.as_deref()) {
                    if !root.global && !include_project {
                        continue;
                    }
                    scan_agent_root(&root, &mut out);
                }
            }
            SourceType::Project => {
                ensure_projects_dir(roots)?;
                if let Ok(entries) = fs::read_dir(&roots.projects_dir) {
                    let mut files: Vec<PathBuf> =
                        entries.flatten().map(|entry| entry.path()).collect();
                    files.sort();
                    for file in files {
                        if let Some(project) = project_entry(&file) {
                            out.push(project);
                        }
                    }
                }
            }
        }
    }
    Ok(json!({ "sources": out }))
}

/// Working directories declared by a project (`properties.workingDirs`).
pub fn project_working_dirs(roots: &SourceRoots, project_id: &str) -> Vec<String> {
    let file = roots.projects_dir.join(format!("{project_id}.md"));
    project_entry(&file)
        .and_then(|project| project["properties"]["workingDirs"].as_array().cloned())
        .map(|dirs| {
            dirs.iter()
                .filter_map(|dir| dir.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub fn create(params: &Value, roots: &SourceRoots) -> Result<Value, Value> {
    let source_type = source_type_param(params)?;
    let name = string_param(params, "name")?;
    let description = params
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let properties = properties_param(params).unwrap_or_default();
    let (global, project_dir) = target_scope(params, &|id| {
        project_working_dirs(roots, id).into_iter().next()
    })?;
    let source = match source_type {
        SourceType::Skill => {
            validate_skill_name(&name)?;
            let base = if global {
                home()
                    .map(|home| home.join(".agents").join("skills"))
                    .ok_or_else(|| protocol::internal("home directory unavailable"))?
            } else {
                project_dir
                    .clone()
                    .ok_or_else(|| invalid_params("project directory required"))?
                    .join(".agents")
                    .join("skills")
            };
            let dir = base.join(&name);
            if dir.exists() {
                return Err(invalid_params(format!("Skill '{name}' already exists")));
            }
            fs::create_dir_all(&dir).map_err(|error| {
                protocol::internal(format!("failed to create skill dir: {error}"))
            })?;
            fs::write(
                dir.join("SKILL.md"),
                build_skill_markdown(&name, &description, &content, &properties),
            )
            .map_err(|error| protocol::internal(format!("failed to write SKILL.md: {error}")))?;
            let root = Root {
                path: base,
                global,
                writable: true,
            };
            skill_entry(&dir, &root)
                .ok_or_else(|| protocol::internal("failed to read back skill"))?
        }
        SourceType::Agent => {
            if name.trim().is_empty() {
                return Err(invalid_params("Agent name must not be empty"));
            }
            let base = if global {
                home()
                    .map(|home| home.join(".agents").join("agents"))
                    .ok_or_else(|| protocol::internal("home directory unavailable"))?
            } else {
                project_dir
                    .clone()
                    .ok_or_else(|| invalid_params("project directory required"))?
                    .join(".agents")
                    .join("agents")
            };
            fs::create_dir_all(&base).map_err(|error| {
                protocol::internal(format!("failed to create agents dir: {error}"))
            })?;
            let slug = slugify(&name);
            let mut file = base.join(format!("{slug}.md"));
            let mut counter = 2;
            while file.exists() {
                file = base.join(format!("{slug}-{counter}.md"));
                counter += 1;
            }
            fs::write(
                &file,
                build_markdown(&name, &description, &content, &properties),
            )
            .map_err(|error| protocol::internal(format!("failed to write agent file: {error}")))?;
            let root = Root {
                path: base,
                global,
                writable: true,
            };
            agent_entry(&file, &root)
                .ok_or_else(|| protocol::internal("failed to read back agent"))?
        }
        SourceType::Project => {
            validate_slug(&name)?;
            ensure_projects_dir(roots)?;
            let file = roots.projects_dir.join(format!("{name}.md"));
            if file.exists() {
                return Err(invalid_params(format!("Project '{name}' already exists")));
            }
            let mut properties = properties;
            let title = properties
                .remove("title")
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_else(|| name.clone());
            fs::write(
                &file,
                build_markdown(&title, &description, &content, &properties),
            )
            .map_err(|error| {
                protocol::internal(format!("failed to write project file: {error}"))
            })?;
            project_entry(&file).ok_or_else(|| protocol::internal("failed to read back project"))?
        }
        SourceType::BuiltinSkill => return Err(invalid_params("Built-in skills are read-only")),
    };
    Ok(json!({ "source": source }))
}

pub fn update(params: &Value, roots: &SourceRoots) -> Result<Value, Value> {
    let source_type = source_type_param(params)?;
    let path = string_param(params, "path")?;
    let name = string_param(params, "name")?;
    let description = params
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let source = match source_type {
        SourceType::Skill => {
            validate_skill_name(&name)?;
            let (dir, root) = resolve_writable_skill_dir(
                &path,
                &skill_roots(None)
                    .into_iter()
                    .chain(project_root_guess(&path, "skills"))
                    .collect::<Vec<_>>(),
            )?;
            let properties = properties_param(params).unwrap_or_else(|| {
                skill_entry(&dir, &root)
                    .and_then(|skill| skill["properties"].as_object().cloned())
                    .unwrap_or_default()
            });
            let mut target_dir = dir.clone();
            if dir.file_name().and_then(|current| current.to_str()) != Some(name.as_str()) {
                target_dir = dir
                    .parent()
                    .map(|parent| parent.join(&name))
                    .unwrap_or_else(|| dir.clone());
                if target_dir.exists() {
                    return Err(invalid_params(format!("Skill '{name}' already exists")));
                }
                fs::rename(&dir, &target_dir).map_err(|error| {
                    protocol::internal(format!("failed to rename skill: {error}"))
                })?;
            }
            fs::write(
                target_dir.join("SKILL.md"),
                build_skill_markdown(&name, &description, &content, &properties),
            )
            .map_err(|error| protocol::internal(format!("failed to write SKILL.md: {error}")))?;
            skill_entry(&target_dir, &root)
                .ok_or_else(|| protocol::internal("failed to read back skill"))?
        }
        SourceType::Agent => {
            if name.trim().is_empty() {
                return Err(invalid_params("Agent name must not be empty"));
            }
            let (file, root) = resolve_writable_agent_file(
                &path,
                &agent_roots(None)
                    .into_iter()
                    .chain(project_root_guess(&path, "agents"))
                    .collect::<Vec<_>>(),
            )?;
            let properties = properties_param(params).unwrap_or_else(|| {
                agent_entry(&file, &root)
                    .and_then(|agent| agent["properties"].as_object().cloned())
                    .unwrap_or_default()
            });
            fs::write(
                &file,
                build_markdown(&name, &description, &content, &properties),
            )
            .map_err(|error| protocol::internal(format!("failed to write agent file: {error}")))?;
            agent_entry(&file, &root)
                .ok_or_else(|| protocol::internal("failed to read back agent"))?
        }
        SourceType::Project => {
            let file = resolve_project_file(&path, roots)?;
            let mut properties = properties_param(params).unwrap_or_else(|| {
                project_entry(&file)
                    .and_then(|project| project["properties"].as_object().cloned())
                    .unwrap_or_default()
            });
            let slug = file
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default();
            let title = properties
                .remove("title")
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or(slug);
            fs::write(
                &file,
                build_markdown(&title, &description, &content, &properties),
            )
            .map_err(|error| {
                protocol::internal(format!("failed to write project file: {error}"))
            })?;
            project_entry(&file).ok_or_else(|| protocol::internal("failed to read back project"))?
        }
        SourceType::BuiltinSkill => return Err(invalid_params("Built-in skills are read-only")),
    };
    Ok(json!({ "source": source }))
}

/// A source path inside `<some project>/.agents/<kind>` is writable even when
/// the request carries no project directory: derive the root from the path.
fn project_root_guess(path: &str, kind: &str) -> Option<Root> {
    let path = PathBuf::from(path);
    let mut current = path.as_path();
    while let Some(parent) = current.parent() {
        if parent.file_name().and_then(|name| name.to_str()) == Some(kind)
            && parent
                .parent()
                .and_then(|grand| grand.file_name())
                .and_then(|name| name.to_str())
                == Some(".agents")
        {
            return Some(Root {
                path: parent.to_path_buf(),
                global: false,
                writable: true,
            });
        }
        current = parent;
    }
    None
}

pub fn delete(params: &Value, roots: &SourceRoots) -> Result<Value, Value> {
    let source_type = source_type_param(params)?;
    let path = string_param(params, "path")?;
    match source_type {
        SourceType::Skill => {
            let (dir, _) = resolve_writable_skill_dir(
                &path,
                &skill_roots(None)
                    .into_iter()
                    .chain(project_root_guess(&path, "skills"))
                    .collect::<Vec<_>>(),
            )?;
            fs::remove_dir_all(&dir)
                .map_err(|error| protocol::internal(format!("failed to delete skill: {error}")))?;
        }
        SourceType::Agent => {
            let (file, _) = resolve_writable_agent_file(
                &path,
                &agent_roots(None)
                    .into_iter()
                    .chain(project_root_guess(&path, "agents"))
                    .collect::<Vec<_>>(),
            )?;
            fs::remove_file(&file)
                .map_err(|error| protocol::internal(format!("failed to delete agent: {error}")))?;
        }
        SourceType::Project => {
            let file = resolve_project_file(&path, roots)?;
            fs::remove_file(&file).map_err(|error| {
                protocol::internal(format!("failed to delete project: {error}"))
            })?;
        }
        SourceType::BuiltinSkill => return Err(invalid_params("Built-in skills are read-only")),
    }
    Ok(json!({}))
}

pub fn export(params: &Value, roots: &SourceRoots) -> Result<Value, Value> {
    let source_type = source_type_param(params)?;
    let path = string_param(params, "path")?;
    let listing = list(
        &json!({ "type": source_type.wire(), "includeProjectSources": true }),
        roots,
    )?;
    let source = listing["sources"]
        .as_array()
        .and_then(|sources| {
            sources
                .iter()
                .find(|source| source["path"].as_str() == Some(path.as_str()))
                .cloned()
        })
        .or_else(|| match source_type {
            SourceType::Skill => project_root_guess(&path, "skills")
                .and_then(|root| skill_entry(Path::new(&path), &root)),
            SourceType::Agent => project_root_guess(&path, "agents")
                .and_then(|root| agent_entry(Path::new(&path), &root)),
            _ => None,
        })
        .ok_or_else(|| invalid_params(format!("No {} at {path}", source_type.wire())))?;
    let mut export = json!({
        "version": 1,
        "type": source_type.wire(),
        "name": source["name"],
        "description": source["description"],
        "content": source["content"],
    });
    let name = source["name"].as_str().unwrap_or("source").to_string();
    let filename = match source_type {
        SourceType::Project => {
            if let Some(title) = source["properties"]["title"].as_str() {
                export["title"] = json!(title);
            }
            if let Some(properties) = source["properties"]
                .as_object()
                .filter(|map| !map.is_empty())
            {
                export["properties"] = Value::Object(properties.clone());
            }
            format!("{name}.project.json")
        }
        SourceType::Agent => format!("{}.agent.json", slugify(&name)),
        _ => format!("{name}.skill.json"),
    };
    let json = serde_json::to_string_pretty(&export)
        .map_err(|error| protocol::internal(format!("failed to serialize source: {error}")))?;
    Ok(json!({ "json": json, "filename": filename }))
}

pub fn import(params: &Value, roots: &SourceRoots) -> Result<Value, Value> {
    let data = string_param(params, "data")?;
    let value: Value = serde_json::from_str(&data)
        .map_err(|error| invalid_params(format!("Invalid JSON: {error}")))?;
    let version = value
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid_params("Missing or invalid \"version\" field"))?;
    if version != 1 {
        return Err(invalid_params(format!(
            "Unsupported source export version: {version}"
        )));
    }
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("skill");
    if !matches!(kind, "skill" | "agent" | "project") {
        return Err(invalid_params(format!(
            "Source type '{kind}' import is not supported."
        )));
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return Err(invalid_params("Source name must not be empty"));
    }
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if kind == "skill" && description.is_empty() {
        return Err(invalid_params("Source description must not be empty"));
    }
    let content = value
        .get("content")
        .or_else(|| value.get("instructions"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut properties: Map<String, Value> = value
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if kind == "project" {
        if let Some(title) = value.get("title").and_then(Value::as_str) {
            properties.insert("title".to_string(), json!(title));
        }
    }
    let target = params
        .get("target")
        .cloned()
        .unwrap_or_else(|| json!({ "scope": "global" }));
    let created = create(
        &json!({
            "type": kind,
            "name": name,
            "description": description,
            "content": content,
            "target": target,
            "properties": properties,
        }),
        roots,
    )?;
    Ok(json!({ "sources": [created["source"]] }))
}
