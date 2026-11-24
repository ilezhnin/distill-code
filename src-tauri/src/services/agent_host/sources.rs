//! Skills, agents (personas), and projects as files on disk, read and written
//! only under the Flock root (`<root>/skills/<name>/SKILL.md`,
//! `<root>/agents/<slug>.md`, `<root>/projects/<slug>.md`) and a project's own
//! `.distill` folder (`<project>/.distill/skills`, `<project>/.distill/agents`).
//! Folders other tools keep — `~/.agents`, a project's `.agents`, `.claude`,
//! `.codex`, `.gemini`, `.goose` — are never sources.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::protocol::{self, invalid_params};
use crate::commands::project_store::PROJECT_STORE_DIR;
use crate::services::windows_names::reject_unusable_windows_name;

static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Write `contents` to `path` through a temporary file in the same directory.
///
/// `fs::write` truncates the live file before writing it, so an agent whose turn
/// reads a skill while the user is editing it sees an empty `SKILL.md` — and a
/// crash in that window leaves it empty for good. Writing beside the file and
/// renaming makes the replacement all-or-nothing; the temporary file is fsynced
/// first so a power cut cannot persist the rename without the bytes.
fn write_source_file(path: &Path, contents: &str) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let sequence = WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        ".flock-source-write-{}-{sequence}.tmp",
        std::process::id()
    ));
    let result = crate::commands::flock_store::write_file_synced(&temp, contents.as_bytes())
        .and_then(|()| fs::rename(&temp, path));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

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
    /// The Flock root: global `skills/` and `agents/` live here.
    pub root: PathBuf,
    /// `<root>/projects` — where projects live.
    pub projects_dir: PathBuf,
    /// `<root>/skills` — where the app installs its bundled skills.
    pub builtin_skills_dir: PathBuf,
    /// Legacy goose data dir to migrate projects from, once.
    pub legacy_projects_dir: Option<PathBuf>,
}

impl SourceRoots {
    /// Every source folder under the Flock `root`, the way the agent host
    /// opens them; `legacy_projects_dir` is goose's projects folder, imported
    /// once when present.
    pub fn new(root: PathBuf, legacy_projects_dir: Option<PathBuf>) -> Self {
        Self {
            projects_dir: root.join("projects"),
            builtin_skills_dir: root.join("skills"),
            root,
            legacy_projects_dir,
        }
    }
}

/// The project's `.distill/<kind>` (when a project is named), then the Flock
/// root's `<kind>`. Nothing else is ever scanned or written.
fn source_roots(kind: &str, project_dir: Option<&Path>, roots: &SourceRoots) -> Vec<Root> {
    let mut result = Vec::new();
    if let Some(project) = project_dir {
        result.push(Root {
            path: project.join(PROJECT_STORE_DIR).join(kind),
            global: false,
            writable: true,
        });
    }
    result.push(Root {
        path: roots.root.join(kind),
        global: true,
        writable: true,
    });
    result
}

fn skill_roots(project_dir: Option<&Path>, roots: &SourceRoots) -> Vec<Root> {
    source_roots("skills", project_dir, roots)
}

fn agent_roots(project_dir: Option<&Path>, roots: &SourceRoots) -> Vec<Root> {
    source_roots("agents", project_dir, roots)
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

/// Whether a skill's `properties` (its frontmatter `metadata`) carry the
/// app's bundled marker, under its current name or one an earlier build
/// wrote.
fn properties_mark_bundled(properties: &Value) -> bool {
    properties
        .as_object()
        .is_some_and(crate::services::upstream_names::metadata_marks_bundled)
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
            if !properties_mark_bundled(&skill["properties"]) {
                continue;
            }
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
    // `create_dir_all("...\\CON")` fails with "The parameter is incorrect" and
    // `Path::exists("...\\NUL")` reports the directory as already there, so a
    // reserved name produces a baffling failure rather than a skill.
    reject_unusable_windows_name(name, "Skill name").map_err(invalid_params)?;
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
    // An agent called "con" or "nul" would become `<agents>/con.md`, which on
    // Windows is the console device rather than a file. Derived names cannot be
    // rejected — the caller chose a perfectly reasonable display name — so give
    // them the same fallback shape an empty slug gets.
    if slug.is_empty() || crate::services::windows_names::is_reserved_windows_device_name(&slug) {
        format!("{slug}-agent").trim_start_matches('-').to_string()
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

fn initialize_project_folders(project: &Value) {
    if let Some(dirs) = project["properties"]["workingDirs"].as_array() {
        for dir in dirs
            .iter()
            .filter_map(Value::as_str)
            .map(Path::new)
            .filter(|path| path.is_dir())
        {
            if let Err(error) = crate::services::flock_root::ensure_project_layout(dir) {
                log::warn!(
                    "Cannot initialize project context at {}: {error}",
                    dir.display()
                );
            }
        }
    }
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
    // `<projects>/con.md` addresses the console device, not a project file.
    reject_unusable_windows_name(slug, "Project id").map_err(invalid_params)?;
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
                for root in skill_roots(project_dir.as_deref(), roots) {
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
                for root in agent_roots(project_dir.as_deref(), roots) {
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
                            initialize_project_folders(&project);
                            out.push(project);
                        }
                    }
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|source| {
        let kind = source["type"].as_str().unwrap_or_default();
        if kind == "skill"
            && source["global"].as_bool() == Some(true)
            && properties_mark_bundled(&source["properties"])
        {
            return false;
        }
        let name = source["name"].as_str().unwrap_or_default();
        seen.insert((kind.to_owned(), name.to_lowercase()))
    });
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
    create_source(params, roots, false)
}

/// `create`, and what `import` does once it has checked the file: an
/// `imported` source is refused when its name is already taken (see
/// [`refuse_a_taken_name`]), where a source the operator creates is not.
fn create_source(params: &Value, roots: &SourceRoots, imported: bool) -> Result<Value, Value> {
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
    if imported {
        refuse_a_taken_name(source_type, &name, project_dir.as_deref(), roots)?;
    }
    let source = match source_type {
        SourceType::Skill => {
            validate_skill_name(&name)?;
            let base = if global {
                roots.root.join("skills")
            } else {
                project_dir
                    .clone()
                    .ok_or_else(|| invalid_params("project directory required"))?
                    .join(".distill")
                    .join("skills")
            };
            let dir = base.join(&name);
            if dir.exists() {
                return Err(invalid_params(format!("Skill '{name}' already exists")));
            }
            fs::create_dir_all(&dir).map_err(|error| {
                protocol::internal(format!("failed to create skill dir: {error}"))
            })?;
            write_source_file(
                &dir.join("SKILL.md"),
                &build_skill_markdown(&name, &description, &content, &properties),
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
                roots.root.join("agents")
            } else {
                project_dir
                    .clone()
                    .ok_or_else(|| invalid_params("project directory required"))?
                    .join(".distill")
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
            write_source_file(
                &file,
                &build_markdown(&name, &description, &content, &properties),
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
            write_source_file(
                &file,
                &build_markdown(&title, &description, &content, &properties),
            )
            .map_err(|error| {
                protocol::internal(format!("failed to write project file: {error}"))
            })?;
            project_entry(&file).ok_or_else(|| protocol::internal("failed to read back project"))?
        }
        SourceType::BuiltinSkill => return Err(invalid_params("Built-in skills are read-only")),
    };
    if source_type == SourceType::Project {
        initialize_project_folders(&source);
    }
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
                &skill_roots(None, roots)
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
            write_source_file(
                &target_dir.join("SKILL.md"),
                &build_skill_markdown(&name, &description, &content, &properties),
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
                &agent_roots(None, roots)
                    .into_iter()
                    .chain(project_root_guess(&path, "agents"))
                    .collect::<Vec<_>>(),
            )?;
            let properties = properties_param(params).unwrap_or_else(|| {
                agent_entry(&file, &root)
                    .and_then(|agent| agent["properties"].as_object().cloned())
                    .unwrap_or_default()
            });
            write_source_file(
                &file,
                &build_markdown(&name, &description, &content, &properties),
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
            write_source_file(
                &file,
                &build_markdown(&title, &description, &content, &properties),
            )
            .map_err(|error| {
                protocol::internal(format!("failed to write project file: {error}"))
            })?;
            project_entry(&file).ok_or_else(|| protocol::internal("failed to read back project"))?
        }
        SourceType::BuiltinSkill => return Err(invalid_params("Built-in skills are read-only")),
    };
    if source_type == SourceType::Project {
        initialize_project_folders(&source);
    }
    Ok(json!({ "source": source }))
}

/// A source path inside a project's `.distill/<kind>` is writable even when
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
                == Some(PROJECT_STORE_DIR)
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
                &skill_roots(None, roots)
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
                &agent_roots(None, roots)
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

/// Frontmatter keys an agent file carries for the agent builder's own use: a
/// draft is left out of the Agents list and belongs to one builder chat.
const BUILDER_STATE_KEYS: &[&str] = &["draft", "builderSessionId"];

/// The longest name a refusal repeats.
const SHOWN_NAME_CHARS: usize = 80;

/// Why an import was refused, for the screen that asked for it. The message
/// says it in English; `data.importRefused` names the reason and what it is
/// about, so the screen can say it in the operator's language.
fn import_refused(message: String, detail: Value) -> Value {
    protocol::error_with_data(
        protocol::INVALID_PARAMS,
        message,
        json!({ "importRefused": detail }),
    )
}

/// A kind as a refusal names it. A kind the file made up is not repeated.
fn kind_words(kind: Option<SourceType>) -> &'static str {
    match kind {
        Some(SourceType::Skill) => "a skill",
        Some(SourceType::BuiltinSkill) => "a built-in skill",
        Some(SourceType::Agent) => "an agent",
        Some(SourceType::Project) => "a project",
        None => "a kind of source Flock does not know",
    }
}

/// A name as a refusal repeats it: on one line and no longer than a name has
/// any reason to be. The file chose it, and the operator reads the refusal.
fn shown_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(SHOWN_NAME_CHARS)
        .collect()
}

/// Whether a frontmatter `metadata` key is the app's to write: the bundled
/// ownership marker, and the note of which bundled agent a file was made
/// from, under every name builds have written them by.
fn is_app_reserved_metadata_key(key: &str) -> bool {
    use crate::services::upstream_names::is_bundled_marker_key;
    is_bundled_marker_key(key)
        || key
            .strip_suffix("Source")
            .is_some_and(is_bundled_marker_key)
}

/// Take the app's own keys out of what an imported file brought, wherever in
/// it they sit. A skill that carries the marker is listed as built in, with
/// no way to edit or delete it, and is offered to every chat as one of the
/// app's; an agent that names a bundled agent as its origin is taken for that
/// role by the conductor.
fn drop_app_reserved_keys(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|key, _| !is_app_reserved_metadata_key(key));
            object.values_mut().for_each(drop_app_reserved_keys);
        }
        Value::Array(items) => items.iter_mut().for_each(drop_app_reserved_keys),
        _ => {}
    }
}

/// An agent's name as agents are matched by name (`normalizeAgentRef` in the
/// renderer): lower case, with spaces and underscores as hyphens. Characters
/// that take no room are left out, so a name cannot differ from another only
/// in what nobody can see.
fn agent_ref(name: &str) -> String {
    let mut folded = String::new();
    let mut in_a_gap = false;
    for letter in name.trim().chars() {
        if letter.is_whitespace() || letter == '_' {
            if !in_a_gap {
                folded.push('-');
            }
            in_a_gap = true;
        } else if !super::transcript_import::is_invisible(letter) {
            folded.extend(letter.to_lowercase());
            in_a_gap = false;
        }
    }
    folded
}

/// Refuse to import a skill or an agent under a name one already answers to
/// where the import would land: in the target folder, and for a project's
/// folder in the Flock root behind it.
///
/// The listing keeps one source per name, the first in file order, and an
/// agent whose file name is taken is written as `<slug>-2.md`, which sorts
/// ahead of `<slug>.md`. So an imported agent named after one the operator
/// trusts used to replace it in every list, under the same name and with
/// instructions nobody had read.
fn refuse_a_taken_name(
    kind: SourceType,
    name: &str,
    project_dir: Option<&Path>,
    roots: &SourceRoots,
) -> Result<(), Value> {
    let mut existing = Vec::new();
    let taken_by = match kind {
        SourceType::Skill => {
            for root in skill_roots(project_dir, roots) {
                scan_skill_root(&root, &mut existing);
            }
            let wanted = name.trim().to_lowercase();
            existing.iter().find(|skill| {
                skill["name"]
                    .as_str()
                    .is_some_and(|taken| taken.trim().to_lowercase() == wanted)
            })
        }
        SourceType::Agent => {
            for root in agent_roots(project_dir, roots) {
                scan_agent_root(&root, &mut existing);
            }
            let wanted = agent_ref(name);
            existing.iter().find(|agent| {
                let display_name = agent["name"].as_str().map(agent_ref);
                // An agent also answers to the name of its file.
                let file_name = agent["path"]
                    .as_str()
                    .and_then(|path| Path::new(path).file_stem())
                    .map(|stem| agent_ref(&stem.to_string_lossy()));
                display_name.as_deref() == Some(wanted.as_str())
                    || file_name.as_deref() == Some(wanted.as_str())
            })
        }
        SourceType::BuiltinSkill | SourceType::Project => None,
    };
    let Some(taken_by) = taken_by else {
        return Ok(());
    };
    let name = shown_name(name);
    let taken_by = shown_name(taken_by["name"].as_str().unwrap_or_default());
    Err(import_refused(
        format!(
            "The name \"{name}\" is already taken by the {} \"{taken_by}\". Nothing was imported: rename or remove that one first, or change the name in the file.",
            kind.wire()
        ),
        json!({
            "reason": "nameTaken",
            "kind": kind.wire(),
            "name": name,
            "existing": taken_by,
        }),
    ))
}

/// Create a skill or an agent from an exported file (`data`).
///
/// The file may come from anyone, so it decides nothing but its own content.
/// The request says which kind is being imported (`type`: `skill` from the
/// Skills screen, `agent` from Agents) and a file of another kind is refused;
/// a project is imported from neither. The app's own metadata keys are not
/// taken from the file, and a name that is already taken refuses the import
/// instead of the file being written beside the source it names.
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
    let expected = match params.get("type") {
        // The Agents import (`importPersonas` in the renderer) does not name
        // its kind: a request without one is held to an agent, the only kind
        // that caller sends.
        None | Some(Value::Null) => SourceType::Agent,
        Some(requested) => match requested.as_str().and_then(SourceType::parse) {
            Some(kind @ (SourceType::Skill | SourceType::Agent)) => kind,
            _ => return Err(invalid_params("Only a skill or an agent can be imported")),
        },
    };
    // A file that names no kind is a skill, as it always was.
    let found = match value.get("type") {
        None => Some(SourceType::Skill),
        Some(kind) => kind.as_str().and_then(SourceType::parse),
    };
    if found != Some(expected) {
        return Err(import_refused(
            format!(
                "This file holds {}, and this import takes {}. Nothing was imported.",
                kind_words(found),
                kind_words(Some(expected))
            ),
            json!({
                "reason": "otherKind",
                "expected": expected.wire(),
                "found": found.map_or("unknown", SourceType::wire),
            }),
        ));
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
    if expected == SourceType::Skill && description.is_empty() {
        return Err(invalid_params("Source description must not be empty"));
    }
    let content = value
        .get("content")
        .or_else(|| value.get("instructions"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut properties = value
        .get("properties")
        .filter(|properties| properties.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    drop_app_reserved_keys(&mut properties);
    if expected == SourceType::Agent {
        if let Some(properties) = properties.as_object_mut() {
            properties.retain(|key, _| !BUILDER_STATE_KEYS.contains(&key.as_str()));
        }
    }
    let target = params
        .get("target")
        .cloned()
        .unwrap_or_else(|| json!({ "scope": "global" }));
    let created = create_source(
        &json!({
            "type": expected.wire(),
            "name": name,
            "description": description,
            "content": content,
            "target": target,
            "properties": properties,
        }),
        roots,
        true,
    )?;
    Ok(json!({ "sources": [created["source"]] }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_names_that_windows_reads_as_a_device_are_refused() {
        for name in ["CON", "nul", "Aux", "COM1", "lpt9", "PRN"] {
            assert!(
                validate_skill_name(name).is_err(),
                "skill name '{name}' must be refused"
            );
            assert!(
                validate_slug(name).is_err(),
                "project id '{name}' must be refused"
            );
        }
        // Names that merely start with a device word are ordinary names.
        for name in ["console", "com10", "auxiliary", "nullable"] {
            assert!(validate_skill_name(name).is_ok(), "{name}");
            assert!(validate_slug(name).is_ok(), "{name}");
        }
    }

    #[test]
    fn a_derived_agent_slug_is_never_a_device_name() {
        // Slugs come from a display name the user is entitled to choose, so they
        // are steered away from the device names rather than rejected.
        for name in ["con", "NUL", "Com1", "lpt 9"] {
            let slug = slugify(name);
            assert!(
                !crate::services::windows_names::is_reserved_windows_device_name(&slug),
                "'{name}' produced the device name '{slug}'"
            );
        }
        assert_eq!(slugify("con"), "con-agent");
        // The existing fallbacks are unchanged.
        assert_eq!(slugify(""), "agent");
        assert_eq!(slugify("   "), "agent");
        assert_eq!(slugify("Release Manager"), "release-manager");
    }

    #[test]
    fn a_source_file_is_never_visible_half_written() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("SKILL.md");
        write_source_file(&file, "first version").expect("first write");
        assert_eq!(fs::read_to_string(&file).unwrap(), "first version");

        write_source_file(&file, "second version").expect("second write");
        assert_eq!(fs::read_to_string(&file).unwrap(), "second version");
        // The replacement is a rename, so nothing is left beside the file for a
        // reader (or the skill scanner) to trip over.
        let leftovers = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(leftovers, vec!["SKILL.md".to_string()]);
    }

    /// Only the project's `.distill` and the Flock root are roots: the
    /// project's `.agents` and every vendor folder are never Flock
    /// configuration.
    #[test]
    fn a_vendor_folder_is_never_a_root() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("repo");
        for vendor in [
            ".distill", ".agents", ".claude", ".codex", ".gemini", ".goose",
        ] {
            std::fs::create_dir_all(project.join(vendor).join("skills")).unwrap();
            std::fs::create_dir_all(project.join(vendor).join("agents")).unwrap();
        }
        let sources = SourceRoots {
            root: dir.path().join("global"),
            projects_dir: dir.path().join("projects"),
            builtin_skills_dir: dir.path().join("skills"),
            legacy_projects_dir: None,
        };
        for (kind, roots) in [
            ("skills", skill_roots(Some(&project), &sources)),
            ("agents", agent_roots(Some(&project), &sources)),
        ] {
            let paths: Vec<_> = roots.iter().map(|root| root.path.clone()).collect();
            assert_eq!(
                paths,
                vec![project.join(".distill").join(kind), sources.root.join(kind)]
            );
            assert!(roots.iter().all(|root| root.writable));
        }
    }

    fn write_agent(dir: &Path, slug: &str, body: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join(format!("{slug}.md")),
            format!("---\nname: {slug}\ndescription: Example\n---\n{body}"),
        )
        .unwrap();
    }

    fn write_skill(dir: &Path, name: &str) {
        let skill = dir.join(name);
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Example\n---\nbody"),
        )
        .unwrap();
    }

    /// A home that still has the folder older builds shared with other tools
    /// (`~/.agents`) next to the Flock root: only the root is listed. The
    /// roots are built the way the agent host builds them.
    #[test]
    fn the_legacy_home_agents_folder_is_ignored() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".distill");
        let legacy = home.path().join(".agents");
        write_agent(&root.join("agents"), "own", "root");
        write_agent(&legacy.join("agents"), "legacy", "legacy");
        write_skill(&root.join("skills"), "own-skill");
        write_skill(&legacy.join("skills"), "legacy-skill");
        let roots = SourceRoots::new(root.clone(), None);
        assert_eq!(roots.projects_dir, root.join("projects"));
        assert_eq!(roots.builtin_skills_dir, root.join("skills"));

        let listed = list(&json!({}), &roots).unwrap();
        let names: Vec<_> = listed["sources"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|source| source["type"] != "project")
            .map(|source| source["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["own-skill".to_string(), "own".to_string()]);
    }

    /// A skill the app installed under an earlier name's marker is still a
    /// built-in skill: listed once, as such, and not again as one of the
    /// user's global skills.
    #[test]
    fn a_skill_marked_by_an_earlier_build_is_still_built_in() {
        use crate::services::upstream_names::{BUNDLED_KEY, OLD_BUNDLED_KEYS};
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".distill");
        let mut marked: Vec<(String, &str)> = vec![("flock-help".to_string(), BUNDLED_KEY)];
        for key in OLD_BUNDLED_KEYS {
            assert_ne!(*key, BUNDLED_KEY);
            marked.push((format!("old-{}", key.to_lowercase()), *key));
        }
        for (name, key) in &marked {
            let skill = root.join("skills").join(name);
            fs::create_dir_all(&skill).unwrap();
            fs::write(
                skill.join("SKILL.md"),
                format!(
                    "---\nname: {name}\ndescription: Example\nmetadata:\n  {key}: true\n---\nbody"
                ),
            )
            .unwrap();
        }
        write_skill(&root.join("skills"), "own");
        let roots = SourceRoots::new(root, None);

        let listed = list(&json!({}), &roots).unwrap();
        let mut found: Vec<_> = listed["sources"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|source| source["type"] != "project")
            .map(|source| {
                (
                    source["name"].as_str().unwrap().to_string(),
                    source["type"].as_str().unwrap().to_string(),
                    source["path"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        found.sort();
        let mut expected: Vec<_> = marked
            .iter()
            .map(|(name, _)| {
                (
                    name.clone(),
                    "builtinSkill".to_string(),
                    format!("builtin://skills/{name}"),
                )
            })
            .collect();
        expected.push((
            "own".to_string(),
            "skill".to_string(),
            display(&roots.root.join("skills").join("own")),
        ));
        expected.sort();
        assert_eq!(found, expected);
    }

    /// A project's `.agents` folder is not a project source: it is neither
    /// listed nor accepted for an edit or a delete.
    #[test]
    fn a_project_agents_folder_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("repo");
        let root = dir.path().join("root");
        write_agent(&project.join(".distill/agents"), "local", "distill");
        write_agent(&project.join(".agents/agents"), "stray", "agents");
        write_skill(&project.join(".agents/skills"), "stray-skill");
        let roots = SourceRoots {
            projects_dir: root.join("projects"),
            builtin_skills_dir: root.join("skills"),
            root,
            legacy_projects_dir: None,
        };

        let listed = list(&json!({ "projectDir": project }), &roots).unwrap();
        let names: Vec<_> = listed["sources"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|source| source["type"] != "project")
            .map(|source| source["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["local".to_string()]);

        let stray_agent = project.join(".agents/agents/stray.md");
        let edit = update(
            &json!({
                "type": "agent",
                "path": stray_agent,
                "name": "stray",
                "content": "rewritten",
            }),
            &roots,
        );
        assert!(edit.is_err());
        let removal = delete(
            &json!({ "type": "skill", "path": project.join(".agents/skills/stray-skill") }),
            &roots,
        );
        assert!(removal.is_err());
        assert!(fs::read_to_string(&stray_agent)
            .unwrap()
            .ends_with("agents"));
        assert!(project
            .join(".agents/skills/stray-skill/SKILL.md")
            .is_file());
    }

    #[test]
    fn project_agent_overrides_global_without_leaking_into_general_sources() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("repo");
        let root = dir.path().join("global");
        for (folder, body) in [
            (project.join(".distill/agents"), "local"),
            (root.join("agents"), "global"),
        ] {
            fs::create_dir_all(&folder).unwrap();
            fs::write(
                folder.join("worker.md"),
                format!("---\nname: Worker\ndescription: Example\n---\n{body}"),
            )
            .unwrap();
        }
        let roots = SourceRoots {
            projects_dir: root.join("projects"),
            builtin_skills_dir: root.join("skills"),
            root,
            legacy_projects_dir: None,
        };
        let local = list(&json!({"type":"agent", "projectDir": project}), &roots).unwrap();
        let general = list(&json!({"type":"agent"}), &roots).unwrap();
        assert_eq!(local["sources"].as_array().unwrap().len(), 1);
        assert_eq!(local["sources"][0]["content"], "local");
        assert_eq!(general["sources"][0]["content"], "global");
    }

    #[test]
    fn a_write_that_cannot_start_leaves_the_previous_version_in_place() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("nested").join("SKILL.md");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        write_source_file(&file, "keep me").expect("first write");

        // A path whose parent does not exist: the temporary file cannot even be
        // created, so the live file must be untouched rather than truncated.
        let missing = dir.path().join("absent").join("SKILL.md");
        assert!(write_source_file(&missing, "never lands").is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "keep me");
    }

    /// Import `file` the way a screen does: `kind` is what the Skills screen
    /// (`skill`) or a caller that names its kind sends; `None` is the request
    /// the Agents screen sends.
    fn import_file(roots: &SourceRoots, kind: Option<&str>, file: Value) -> Result<Value, Value> {
        let mut params = json!({ "data": file.to_string(), "target": { "scope": "global" } });
        if let Some(kind) = kind {
            params["type"] = json!(kind);
        }
        import(&params, roots)
    }

    /// What the screen is told when an import is refused.
    fn refusal(result: Result<Value, Value>) -> Value {
        let error = result.expect_err("the import was accepted");
        assert!(
            error["data"]["importRefused"].is_object(),
            "refused for another reason: {error}"
        );
        error["data"]["importRefused"].clone()
    }

    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    /// The audit's file: an agent, dropped on Skills > Import. It used to be
    /// written as `agents/reviewer-2.md` under a "skill imported" message,
    /// and from then on answered to the operator's own agent's name.
    #[test]
    fn an_import_creates_only_the_kind_its_screen_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        let roots = SourceRoots::new(dir.path().join("root"), None);
        let agents = roots.root.join("agents");
        write_agent(&agents, "reviewer", "TRUSTED");
        let agent_file = json!({
            "version": 1, "type": "agent", "name": "Reviewer",
            "description": "d", "content": "MARKER-PERSONA"
        });
        let refused = import_file(&roots, Some("skill"), agent_file).unwrap_err();
        assert_eq!(
            refused["data"]["importRefused"],
            json!({ "reason": "otherKind", "expected": "skill", "found": "agent" })
        );
        let message = refused["message"].as_str().unwrap();
        assert!(
            message.contains("an agent") && message.contains("a skill"),
            "{message}"
        );

        let skill_file = json!({
            "version": 1, "type": "skill", "name": "notes", "description": "d", "content": "c"
        });
        for agents_request in [Some("agent"), None] {
            assert_eq!(
                refusal(import_file(&roots, agents_request, skill_file.clone())),
                json!({ "reason": "otherKind", "expected": "agent", "found": "skill" })
            );
        }

        // A project is imported from neither screen: every folder it names
        // as a working directory would be probed and given a `.distill` on
        // each listing, a network path as readily as this local one.
        let named_folder = dir.path().join("elsewhere");
        fs::create_dir_all(&named_folder).unwrap();
        let project_file = json!({
            "version": 1, "type": "project", "name": "p1",
            "properties": { "workingDirs": [named_folder], "archivedAt": "2026-01-01" }
        });
        for request in [Some("skill"), Some("agent"), None] {
            assert_eq!(
                refusal(import_file(&roots, request, project_file.clone()))["found"],
                "project"
            );
        }
        for request in ["project", "builtinSkill", "recipe", ""] {
            assert!(import_file(&roots, Some(request), project_file.clone()).is_err());
            assert!(import_file(&roots, Some(request), skill_file.clone()).is_err());
        }

        // A kind the file made up is refused without being repeated.
        for made_up in [
            json!("<b>agent</b>"),
            json!(7),
            json!(["skill"]),
            json!(null),
        ] {
            let refused = import_file(
                &roots,
                Some("skill"),
                json!({ "version": 1, "type": made_up, "name": "n", "description": "d" }),
            )
            .unwrap_err();
            assert_eq!(refused["data"]["importRefused"]["found"], "unknown");
            assert!(!refused["message"].as_str().unwrap().contains("<b>"));
        }

        // None of it wrote anything.
        assert_eq!(file_names(&agents), ["reviewer.md"]);
        assert!(!roots.root.join("skills").exists());
        assert!(!roots.projects_dir.exists());
        assert_eq!(file_names(&named_folder), Vec::<String>::new());
        let listed = list(&json!({ "type": "agent" }), &roots).unwrap();
        assert_eq!(listed["sources"].as_array().unwrap().len(), 1);
        assert_eq!(listed["sources"][0]["content"], "TRUSTED");
    }

    /// A skill whose file said `flockBundled: true` used to be listed as one
    /// of the app's own: read-only, with no way to delete it, and offered to
    /// every chat.
    #[test]
    fn an_imported_file_cannot_claim_to_be_the_apps_own() {
        use crate::services::upstream_names::{BUNDLED_KEY, OLD_BUNDLED_KEYS};
        let dir = tempfile::tempdir().unwrap();
        let roots = SourceRoots::new(dir.path().join("root"), None);
        let markers: Vec<&str> = std::iter::once(BUNDLED_KEY)
            .chain(OLD_BUNDLED_KEYS.iter().copied())
            .collect();
        for (index, marker) in markers.iter().enumerate() {
            let name = format!("claimed-{index}");
            let origin = format!("{marker}Source");
            let created = import_file(
                &roots,
                Some("skill"),
                json!({
                    "version": 1, "type": "skill", "name": name,
                    "description": "d", "content": "body",
                    "properties": {
                        *marker: true,
                        origin.as_str(): "flock-help",
                        "color": "blue",
                        "nested": [{ *marker: true, "kept": 1 }]
                    }
                }),
            )
            .expect("the skill itself is imported");
            assert_eq!(created["sources"][0]["type"], "skill");
            assert_eq!(
                created["sources"][0]["properties"],
                json!({ "color": "blue", "nested": [{ "kept": 1 }] })
            );
            let written =
                fs::read_to_string(roots.root.join("skills").join(&name).join("SKILL.md")).unwrap();
            assert!(!written.contains("Bundled"), "{written}");
        }
        let listed = list(&json!({}), &roots).unwrap();
        let kinds: Vec<(&str, &str)> = listed["sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|source| {
                (
                    source["name"].as_str().unwrap(),
                    source["type"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            [
                ("claimed-0", "skill"),
                ("claimed-1", "skill"),
                ("claimed-2", "skill")
            ]
        );

        // An agent that named a bundled agent as its origin was taken for
        // that role; one marked as a builder draft was hidden from the list.
        let created = import_file(
            &roots,
            Some("agent"),
            json!({
                "version": 1, "type": "agent", "name": "Scout",
                "description": "d", "content": "prompt",
                "properties": {
                    "provider": "example",
                    "draft": true,
                    "builderSessionId": "s-1",
                    "metadata": {
                        "flockBundled": true,
                        "flockBundledSource": "acceptor",
                        "distillBundledSource": "conductor",
                        "tone": "direct"
                    },
                    "sprout": { "frontmatter": { "metadata": { "berdBundled": true, "kept": 1 } } }
                }
            }),
        )
        .expect("the agent itself is imported");
        assert_eq!(
            created["sources"][0]["properties"],
            json!({
                "provider": "example",
                "metadata": { "tone": "direct" },
                "sprout": { "frontmatter": { "metadata": { "kept": 1 } } }
            })
        );
    }

    /// An agent imported under a name that was taken used to be written as
    /// `<slug>-2.md`, which the listing reads first: the operator's own agent
    /// dropped out of every list and the imported one answered to its name.
    #[test]
    fn an_import_never_takes_a_name_that_is_already_taken() {
        let dir = tempfile::tempdir().unwrap();
        let roots = SourceRoots::new(dir.path().join("root"), None);
        let agents = roots.root.join("agents");
        fs::create_dir_all(&agents).unwrap();
        for (file, name) in [
            ("reviewer.md", "Reviewer"),
            ("acceptor.md", "Acceptance Check"),
        ] {
            fs::write(
                agents.join(file),
                format!("---\nname: {name}\ndescription: Example\n---\nTRUSTED"),
            )
            .unwrap();
        }
        for (name, taken_by) in [
            ("Reviewer", "Reviewer"),
            ("reviewer", "Reviewer"),
            ("REVIEWER", "Reviewer"),
            ("  Reviewer ", "Reviewer"),
            ("Re\u{200b}viewer", "Reviewer"),
            ("Acceptance_Check", "Acceptance Check"),
            ("acceptance  check", "Acceptance Check"),
            // The name of its file is a name an agent answers to as well.
            ("acceptor", "Acceptance Check"),
        ] {
            for agents_request in [Some("agent"), None] {
                let refused = import_file(
                    &roots,
                    agents_request,
                    json!({
                        "version": 1, "type": "agent", "name": name,
                        "description": "d", "content": "MARKER-PERSONA"
                    }),
                )
                .unwrap_err();
                assert_eq!(
                    refused["data"]["importRefused"],
                    json!({
                        "reason": "nameTaken", "kind": "agent",
                        "name": shown_name(name), "existing": taken_by
                    }),
                    "{name:?}"
                );
                let message = refused["message"].as_str().unwrap();
                assert!(
                    message.contains(&format!("the agent \"{taken_by}\"")),
                    "{message}"
                );
            }
        }
        assert_eq!(file_names(&agents), ["acceptor.md", "reviewer.md"]);
        let listed = list(&json!({ "type": "agent" }), &roots).unwrap();
        let listed = listed["sources"].as_array().unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|agent| agent["content"] == "TRUSTED"));

        // A skill the operator has, and one the app installed.
        let skills = roots.root.join("skills");
        write_skill(&skills, "release-notes");
        fs::create_dir_all(skills.join("flock-help")).unwrap();
        fs::write(
            skills.join("flock-help").join("SKILL.md"),
            "---\nname: flock-help\ndescription: Example\nmetadata:\n  flockBundled: true\n---\nbody",
        )
        .unwrap();
        for (name, taken_by) in [
            ("release-notes", "release-notes"),
            ("Release-Notes", "release-notes"),
            ("FLOCK-HELP", "flock-help"),
        ] {
            assert_eq!(
                refusal(import_file(
                    &roots,
                    Some("skill"),
                    json!({
                        "version": 1, "type": "skill", "name": name,
                        "description": "d", "content": "MARKER"
                    }),
                )),
                json!({
                    "reason": "nameTaken", "kind": "skill", "name": name, "existing": taken_by
                })
            );
        }
        assert_eq!(file_names(&skills), ["flock-help", "release-notes"]);

        // A name nobody has is imported as before.
        let created = import_file(
            &roots,
            Some("agent"),
            json!({
                "version": 1, "type": "agent", "name": "Reviewer of docs",
                "description": "d", "content": "new"
            }),
        )
        .expect("a free name");
        assert_eq!(created["sources"][0]["name"], "Reviewer of docs");
        assert_eq!(
            file_names(&agents),
            ["acceptor.md", "reviewer-of-docs.md", "reviewer.md"]
        );
    }

    /// What the app itself exports is imported back as it was, by the request
    /// each screen sends.
    #[test]
    fn the_apps_own_exports_are_imported_back() {
        let dir = tempfile::tempdir().unwrap();
        let roots = SourceRoots::new(dir.path().join("root"), None);
        let created = create(
            &json!({
                "type": "skill", "name": "release-notes", "description": "Writes notes",
                "content": "Do it.", "target": { "scope": "global" },
                "properties": { "color": "blue" }
            }),
            &roots,
        )
        .unwrap();
        let path = created["source"]["path"].as_str().unwrap().to_string();
        let exported = export(&json!({ "type": "skill", "path": path }), &roots).unwrap();
        assert_eq!(exported["filename"], "release-notes.skill.json");
        let request = json!({
            "data": exported["json"], "target": { "scope": "global" }, "type": "skill"
        });
        // Beside the original it is the clash the operator is told about.
        assert_eq!(refusal(import(&request, &roots))["reason"], "nameTaken");
        delete(&json!({ "type": "skill", "path": path }), &roots).unwrap();
        let imported = import(&request, &roots).unwrap();
        let skill = &imported["sources"][0];
        assert_eq!(skill["type"], "skill");
        assert_eq!(skill["name"], "release-notes");
        assert_eq!(skill["description"], "Writes notes");
        assert_eq!(skill["content"], "Do it.");
        assert_eq!(skill["path"].as_str(), Some(path.as_str()));

        let created = create(
            &json!({
                "type": "agent", "name": "Release Manager", "description": "Ships",
                "content": "Ship it.", "target": { "scope": "global" }
            }),
            &roots,
        )
        .unwrap();
        let path = created["source"]["path"].as_str().unwrap().to_string();
        let exported = export(&json!({ "type": "agent", "path": path }), &roots).unwrap();
        assert_eq!(exported["filename"], "release-manager.agent.json");
        delete(&json!({ "type": "agent", "path": path }), &roots).unwrap();
        // The Agents screen's request names no kind.
        let imported = import(
            &json!({ "data": exported["json"], "target": { "scope": "global" } }),
            &roots,
        )
        .unwrap();
        let agent = &imported["sources"][0];
        assert_eq!(agent["type"], "agent");
        assert_eq!(agent["name"], "Release Manager");
        assert_eq!(agent["content"], "Ship it.");
        assert_eq!(agent["path"].as_str(), Some(path.as_str()));

        // A file that names no kind is still a skill.
        let plain = import_file(
            &roots,
            Some("skill"),
            json!({ "version": 1, "name": "plain", "description": "d", "content": "c" }),
        )
        .unwrap();
        assert_eq!(plain["sources"][0]["type"], "skill");
    }

    /// Creating a source in the app is not an import: the agent builder
    /// promotes a draft by creating the agent under the draft's own name.
    #[test]
    fn creating_an_agent_under_a_taken_name_is_still_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let roots = SourceRoots::new(dir.path().join("root"), None);
        let request = json!({
            "type": "agent", "name": "Scout", "description": "d", "content": "c",
            "target": { "scope": "global" }, "properties": { "draft": true }
        });
        create(&request, &roots).unwrap();
        create(&request, &roots).unwrap();
        assert_eq!(
            file_names(&roots.root.join("agents")),
            ["scout-2.md", "scout.md"]
        );
    }
}
