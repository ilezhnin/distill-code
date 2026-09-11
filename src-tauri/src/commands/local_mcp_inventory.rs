use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    fs,
    hash::{Hash, Hasher},
    path::PathBuf,
};

use serde::Serialize;
use serde_json::Value as JsonValue;

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpHarnessId {
    ClaudeCode,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpConfigScope {
    User,
    Project,
    LocalProject,
    Profile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTransportKind {
    Stdio,
    Http,
    Sse,
    Acp,
    Builtin,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpInventoryStatus {
    Configured,
    Unavailable,
    Partial,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigSource {
    pub scope: McpConfigScope,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfiguredServer {
    pub id: String,
    pub harness: McpHarnessId,
    pub source: McpConfigSource,
    pub config_key: String,
    pub name: String,
    pub transport: McpTransportKind,
    pub identity_fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpSourceStatus {
    Found,
    Missing,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCheckedLocation {
    pub scope: McpConfigScope,
    pub label: String,
    pub status: McpSourceStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHarnessInventory {
    pub harness: McpHarnessId,
    pub status: McpInventoryStatus,
    pub checked_locations: Vec<McpCheckedLocation>,
    pub servers: Vec<McpConfiguredServer>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInventory {
    pub harnesses: Vec<McpHarnessInventory>,
}

#[derive(Debug, Clone)]
pub struct ConfigFile {
    pub path: PathBuf,
    pub scope: McpConfigScope,
    pub label: String,
}

impl ConfigFile {
    fn with_scope(&self, scope: McpConfigScope, label: &str) -> Self {
        Self {
            path: self.path.clone(),
            scope,
            label: label.to_string(),
        }
    }
}

#[tauri::command]
pub async fn list_local_mcp_inventory(
    workspace_paths: Option<Vec<String>>,
) -> Result<McpInventory, String> {
    let workspace_paths = workspace_paths.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        list_local_mcp_inventory_blocking(&workspace_paths)
    })
    .await
    .map_err(|error| format!("MCP inventory task failed: {error}"))?
}

fn list_local_mcp_inventory_blocking(workspace_paths: &[String]) -> Result<McpInventory, String> {
    Ok(McpInventory {
        harnesses: vec![
            discover_claude_code(workspace_paths),
            discover_codex(workspace_paths),
        ],
    })
}

/// Claude Code config files Berd passively inspects. Local-project MCPs do not
/// live in a separate workspace file; they are selected from the active
/// workspace records in `~/.claude.json` during collection.
fn claude_code_config_files(workspace_paths: &[String]) -> Vec<ConfigFile> {
    let mut files = Vec::new();
    if let Some(home) = home_dir() {
        files.push(ConfigFile {
            path: home.join(".claude.json"),
            scope: McpConfigScope::User,
            label: "Claude Code user config".to_string(),
        });
    }

    for workspace in canonical_workspace_paths(workspace_paths) {
        files.push(ConfigFile {
            path: workspace.join(".mcp.json"),
            scope: McpConfigScope::Project,
            label: "Claude Code project config".to_string(),
        });
    }

    files
}

/// The complete allowlist of Codex config locations Berd will read or modify.
pub fn codex_config_files(workspace_paths: &[String]) -> Vec<ConfigFile> {
    let mut files = Vec::new();
    if let Some(home) = home_dir() {
        let codex_root = crate::services::shell_env::user_env_var("CODEX_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".codex"));
        files.push(ConfigFile {
            path: codex_root.join("config.toml"),
            scope: McpConfigScope::User,
            label: "Codex user config".to_string(),
        });
    }

    for workspace in canonical_workspace_paths(workspace_paths) {
        files.push(ConfigFile {
            path: workspace.join(".codex").join("config.toml"),
            scope: McpConfigScope::Project,
            label: "Codex project config".to_string(),
        });
    }

    files
}

fn discover_claude_code(workspace_paths: &[String]) -> McpHarnessInventory {
    let active_workspaces = canonical_workspace_paths(workspace_paths);
    let files = claude_code_config_files(workspace_paths);
    let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
    let mut messages = Vec::new();

    for file in files {
        let Some(value) = read_json_config(&file, &mut inventory, &mut messages) else {
            continue;
        };
        collect_claude_code_servers(&mut inventory.servers, &file, &value, &active_workspaces);
    }

    finish_inventory(inventory, messages)
}

fn discover_codex(workspace_paths: &[String]) -> McpHarnessInventory {
    let files = codex_config_files(workspace_paths);
    let mut inventory = empty_inventory(McpHarnessId::Codex);
    let mut messages = Vec::new();

    for file in files {
        let Some(value) = read_toml_config(&file, &mut inventory, &mut messages) else {
            continue;
        };
        collect_codex_servers(&mut inventory.servers, &file, &value);
    }

    finish_inventory(inventory, messages)
}

fn empty_inventory(harness: McpHarnessId) -> McpHarnessInventory {
    McpHarnessInventory {
        harness,
        status: McpInventoryStatus::Unavailable,
        checked_locations: Vec::new(),
        servers: Vec::new(),
        message: None,
    }
}

fn finish_inventory(
    mut inventory: McpHarnessInventory,
    messages: Vec<String>,
) -> McpHarnessInventory {
    if !inventory.servers.is_empty() {
        inventory.status = if messages.is_empty() {
            McpInventoryStatus::Configured
        } else {
            McpInventoryStatus::Partial
        };
    } else if !messages.is_empty() {
        inventory.status = McpInventoryStatus::Error;
    }

    if !messages.is_empty() {
        inventory.message = Some(messages.join(" "));
    }

    inventory
}

fn source_from_file(file: &ConfigFile) -> McpConfigSource {
    McpConfigSource {
        scope: file.scope,
        label: file.label.clone(),
    }
}

fn checked_location_from_file(file: &ConfigFile, status: McpSourceStatus) -> McpCheckedLocation {
    McpCheckedLocation {
        scope: file.scope,
        label: file.label.clone(),
        status,
    }
}

fn record_checked_location(
    inventory: &mut McpHarnessInventory,
    file: &ConfigFile,
    status: McpSourceStatus,
) {
    inventory
        .checked_locations
        .push(checked_location_from_file(file, status));
}

fn read_json_config(
    file: &ConfigFile,
    inventory: &mut McpHarnessInventory,
    messages: &mut Vec<String>,
) -> Option<JsonValue> {
    let contents = read_config_file(file, inventory, messages)?;
    match serde_json::from_str(&contents) {
        Ok(value) => {
            record_checked_location(inventory, file, McpSourceStatus::Found);
            Some(value)
        }
        Err(_error) => {
            record_checked_location(inventory, file, McpSourceStatus::Error);
            messages.push(format!("{} could not be parsed.", file.label));
            log::warn!("failed to parse {}", file.label);
            None
        }
    }
}

fn read_toml_config(
    file: &ConfigFile,
    inventory: &mut McpHarnessInventory,
    messages: &mut Vec<String>,
) -> Option<JsonValue> {
    let contents = read_config_file(file, inventory, messages)?;
    match toml::from_str::<toml::Value>(&contents) {
        Ok(value) => {
            record_checked_location(inventory, file, McpSourceStatus::Found);
            serde_json::to_value(value).ok()
        }
        Err(_error) => {
            record_checked_location(inventory, file, McpSourceStatus::Error);
            messages.push(format!("{} could not be parsed.", file.label));
            log::warn!("failed to parse {}", file.label);
            None
        }
    }
}

fn read_config_file(
    file: &ConfigFile,
    inventory: &mut McpHarnessInventory,
    messages: &mut Vec<String>,
) -> Option<String> {
    let metadata = match fs::metadata(&file.path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            record_checked_location(inventory, file, McpSourceStatus::Missing);
            return None;
        }
        Err(error) => {
            record_checked_location(inventory, file, McpSourceStatus::Error);
            messages.push(format!("{} could not be inspected.", file.label));
            log::warn!("failed to inspect {}: {}", file.label, error.kind());
            return None;
        }
    };

    if !metadata.is_file() {
        record_checked_location(inventory, file, McpSourceStatus::Error);
        messages.push(format!("{} is not a file.", file.label));
        return None;
    }

    if metadata.len() > MAX_CONFIG_BYTES {
        record_checked_location(inventory, file, McpSourceStatus::Error);
        messages.push(format!("{} is too large to inspect safely.", file.label));
        return None;
    }

    match fs::read_to_string(&file.path) {
        Ok(contents) => Some(contents),
        Err(error) => {
            record_checked_location(inventory, file, McpSourceStatus::Error);
            messages.push(format!("{} could not be read.", file.label));
            log::warn!("failed to read {}: {}", file.label, error.kind());
            None
        }
    }
}

fn collect_claude_code_servers(
    servers: &mut Vec<McpConfiguredServer>,
    file: &ConfigFile,
    value: &JsonValue,
    active_workspaces: &[PathBuf],
) {
    collect_json_server_map(
        servers,
        McpHarnessId::ClaudeCode,
        file,
        value.get("mcpServers").or_else(|| value.get("mcp_servers")),
    );

    if file.scope != McpConfigScope::User || active_workspaces.is_empty() {
        return;
    }

    let Some(projects) = value.get("projects").and_then(JsonValue::as_object) else {
        return;
    };

    for (project_path, project_config) in projects {
        if canonical_matching_workspace(project_path, active_workspaces).is_none() {
            continue;
        }
        let local_file = ConfigFile {
            path: file.path.clone(),
            scope: McpConfigScope::LocalProject,
            label: "Claude Code local project config".to_string(),
        };
        collect_json_server_map(
            servers,
            McpHarnessId::ClaudeCode,
            &local_file,
            project_config
                .get("mcpServers")
                .or_else(|| project_config.get("mcp_servers")),
        );
    }
}

fn collect_json_server_map(
    servers: &mut Vec<McpConfiguredServer>,
    harness: McpHarnessId,
    file: &ConfigFile,
    value: Option<&JsonValue>,
) {
    let Some(map) = value.and_then(JsonValue::as_object) else {
        return;
    };
    for (config_key, server_value) in map {
        let Some(server) = json_server_from_value(servers, harness, file, config_key, server_value)
        else {
            continue;
        };
        push_server(servers, server);
    }
}

fn json_server_from_value(
    servers: &[McpConfiguredServer],
    harness: McpHarnessId,
    file: &ConfigFile,
    config_key: &str,
    value: &JsonValue,
) -> Option<McpConfiguredServer> {
    let object = value.as_object()?;
    let name = object
        .get("name")
        .and_then(JsonValue::as_str)
        .unwrap_or(config_key)
        .to_string();
    let command = object
        .get("command")
        .or_else(|| object.get("cmd"))
        .and_then(JsonValue::as_str);
    let args = object
        .get("args")
        .and_then(JsonValue::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let url = object
        .get("url")
        .or_else(|| object.get("uri"))
        .and_then(JsonValue::as_str);
    let server_type = object
        .get("type")
        .or_else(|| object.get("transport"))
        .and_then(JsonValue::as_str);
    let transport = infer_transport(server_type, command, url);

    let id = server_id(harness, file, config_key);
    if servers.iter().any(|server| server.id == id) {
        return None;
    }

    Some(McpConfiguredServer {
        id,
        harness,
        source: source_from_file(file),
        config_key: config_key.to_string(),
        name,
        transport,
        identity_fingerprint: identity_fingerprint(transport, command, &args, url),
    })
}

fn collect_codex_servers(
    servers: &mut Vec<McpConfiguredServer>,
    file: &ConfigFile,
    value: &JsonValue,
) {
    collect_json_server_map(
        servers,
        McpHarnessId::Codex,
        file,
        value.get("mcp_servers").or_else(|| value.get("mcpServers")),
    );

    if let Some(profiles) = value.get("profiles").and_then(JsonValue::as_object) {
        for (profile_name, profile_value) in profiles {
            let profile_file = file.with_scope(
                McpConfigScope::Profile,
                &format!("Codex profile config ({profile_name})"),
            );
            collect_json_server_map(
                servers,
                McpHarnessId::Codex,
                &profile_file,
                profile_value
                    .get("mcp_servers")
                    .or_else(|| profile_value.get("mcpServers")),
            );
        }
    }
}

fn push_server(servers: &mut Vec<McpConfiguredServer>, server: McpConfiguredServer) {
    if server.config_key.trim().is_empty() || server.name.trim().is_empty() {
        return;
    }
    servers.push(server);
}

fn infer_transport(
    server_type: Option<&str>,
    command: Option<&str>,
    url: Option<&str>,
) -> McpTransportKind {
    match server_type
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("stdio") => McpTransportKind::Stdio,
        Some("http") | Some("streamable_http") | Some("streamable-http") => McpTransportKind::Http,
        Some("sse") => McpTransportKind::Sse,
        Some("acp") => McpTransportKind::Acp,
        Some("builtin") => McpTransportKind::Builtin,
        _ if command.is_some() => McpTransportKind::Stdio,
        _ if url.is_some() => McpTransportKind::Http,
        _ => McpTransportKind::Unknown,
    }
}

fn canonical_matching_workspace<'a>(
    project_path: &str,
    active_workspaces: &'a [PathBuf],
) -> Option<&'a PathBuf> {
    let canonical_project = expand_home_prefix(project_path.trim())
        .canonicalize()
        .ok()?;
    active_workspaces
        .iter()
        .find(|workspace| **workspace == canonical_project)
}

fn canonical_workspace_paths(paths: &[String]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for path in paths {
        let path = expand_home_prefix(path.trim());
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        if canonical.is_dir() && seen.insert(canonical.clone()) {
            result.push(canonical);
        }
    }
    result
}

fn expand_home_prefix(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

fn safe_stdio_identity(command: Option<&str>, args: &[String]) -> String {
    let executable = command
        .and_then(|value| PathBuf::from(value).file_name().map(|name| name.to_owned()))
        .and_then(|name| name.to_str().map(str::to_string))
        .unwrap_or_default();
    let safe_args = args
        .iter()
        .filter(|arg| {
            !arg.contains('=')
                && !arg.to_ascii_lowercase().contains("token")
                && !arg.to_ascii_lowercase().contains("secret")
                && !arg.to_ascii_lowercase().contains("password")
        })
        .take(4)
        .cloned()
        .collect::<Vec<_>>()
        .join("\u{0}");
    format!("{executable}\u{0}{safe_args}")
}

fn safe_remote_identity(raw_url: Option<&str>) -> String {
    let Some(mut url) = raw_url.and_then(|value| url::Url::parse(value).ok()) else {
        return String::new();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.path()
    )
}

fn identity_fingerprint(
    transport: McpTransportKind,
    command: Option<&str>,
    args: &[String],
    url: Option<&str>,
) -> String {
    let identity = match transport {
        McpTransportKind::Stdio => safe_stdio_identity(command, args),
        McpTransportKind::Http | McpTransportKind::Sse => safe_remote_identity(url),
        _ => String::new(),
    };
    let mut hasher = DefaultHasher::new();
    transport.hash(&mut hasher);
    identity.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn server_id(harness: McpHarnessId, file: &ConfigFile, config_key: &str) -> String {
    let mut hasher = DefaultHasher::new();
    file.path.hash(&mut hasher);
    format!(
        "{:?}:{:?}:{:016x}:{}",
        harness,
        file.scope,
        hasher.finish(),
        config_key
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use tempfile::tempdir;

    fn file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn json_discovery_returns_only_structural_metadata() {
        let dir = tempdir().unwrap();
        let config = ConfigFile {
            path: dir.path().join(".mcp.json"),
            scope: McpConfigScope::Project,
            label: "fixture".to_string(),
        };
        file(
            &config.path,
            r#"{
              "mcpServers": {
                "github": {
                  "command": "/opt/bin/npx",
                  "args": ["-y", "@modelcontextprotocol/server-github"],
                  "env": { "GITHUB_TOKEN": "ghp_secret" },
                  "headers": { "Authorization": "Bearer secret" }
                },
                "remote": {
                  "type": "http",
                  "url": "https://api.example.com/mcp?token=secret"
                }
              }
            }"#,
        );

        let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
        let value = read_json_config(&config, &mut inventory, &mut Vec::new()).unwrap();
        let mut servers = Vec::new();
        collect_claude_code_servers(&mut servers, &config, &value, &[]);

        assert_eq!(servers.len(), 2);
        let rendered = serde_json::to_string(&servers).unwrap();
        assert!(!rendered.contains("ghp_secret"));
        assert!(!rendered.contains("Bearer"));
        assert!(!rendered.contains("token=secret"));
    }

    #[test]
    fn serialized_inventory_contains_no_paths_or_secret_values() {
        let dir = tempdir().unwrap();
        let config = ConfigFile {
            path: dir.path().join("private-home").join(".mcp.json"),
            scope: McpConfigScope::Project,
            label: "Claude Code project config".to_string(),
        };
        file(
            &config.path,
            r#"{"mcpServers":{"github":{"command":"npx","args":["--token","secret-argument"],"env":{"TOKEN":"secret-env"},"headers":{"Authorization":"Bearer secret-header"},"url":"https://user:pass@example.com/mcp?token=secret-query"}}}"#,
        );
        let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
        let value = read_json_config(&config, &mut inventory, &mut Vec::new()).unwrap();
        collect_claude_code_servers(&mut inventory.servers, &config, &value, &[]);
        inventory = finish_inventory(inventory, Vec::new());

        let serialized = serde_json::to_string(&inventory).unwrap();
        for forbidden in [
            "private-home",
            "secret-argument",
            "secret-env",
            "secret-header",
            "secret-query",
            "user:pass",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
    }

    #[test]
    fn malformed_file_marks_harness_error_without_raw_contents() {
        let dir = tempdir().unwrap();
        let config = ConfigFile {
            path: dir.path().join("bad.json"),
            scope: McpConfigScope::User,
            label: "fixture secret-token-value".to_string(),
        };
        file(&config.path, "{ secret: ghp_secret");
        let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
        let mut messages = Vec::new();
        assert!(read_json_config(&config, &mut inventory, &mut messages).is_none());
        inventory = finish_inventory(inventory, messages);
        assert_eq!(inventory.status, McpInventoryStatus::Error);
        assert!(!inventory.message.unwrap_or_default().contains("ghp_secret"));
    }

    #[test]
    fn claude_user_config_includes_only_active_workspace_local_servers() {
        let dir = tempdir().unwrap();
        let active_workspace = dir.path().join("active");
        let unrelated_workspace = dir.path().join("unrelated");
        fs::create_dir_all(&active_workspace).unwrap();
        fs::create_dir_all(&unrelated_workspace).unwrap();
        let config = ConfigFile {
            path: dir.path().join(".claude.json"),
            scope: McpConfigScope::User,
            label: "fixture".to_string(),
        };
        file(
            &config.path,
            &format!(
                r#"{{
                  "mcpServers": {{
                    "shared": {{ "command": "node" }}
                  }},
                  "projects": {{
                    "{}": {{
                      "mcpServers": {{
                        "shared": {{ "command": "npx", "env": {{ "TOKEN": "secret" }} }}
                      }}
                    }},
                    "{}": {{
                      "mcpServers": {{
                        "unrelated": {{ "command": "node" }}
                      }}
                    }}
                  }}
                }}"#,
                active_workspace.display().to_string().replace('\\', "\\\\"),
                unrelated_workspace
                    .display()
                    .to_string()
                    .replace('\\', "\\\\"),
            ),
        );
        let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
        let value = read_json_config(&config, &mut inventory, &mut Vec::new()).unwrap();
        let mut servers = Vec::new();
        let active_workspaces = vec![active_workspace.canonicalize().unwrap()];

        collect_claude_code_servers(&mut servers, &config, &value, &active_workspaces);

        assert_eq!(
            servers
                .iter()
                .map(|server| (server.config_key.as_str(), server.source.scope))
                .collect::<Vec<_>>(),
            vec![
                ("shared", McpConfigScope::User),
                ("shared", McpConfigScope::LocalProject),
            ]
        );
        assert_ne!(servers[0].id, servers[1].id);
        let rendered = serde_json::to_string(&servers).unwrap();
        assert!(!rendered.contains("unrelated"));
        assert!(!rendered.contains("secret"));
        assert!(!rendered.contains(active_workspace.to_string_lossy().as_ref()));
        assert!(!rendered.contains("Claude Code local project config ("));
    }
}
