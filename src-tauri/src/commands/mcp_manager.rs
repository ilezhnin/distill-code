//! Explicit MCP management actions. Inventory reads never run these checks.

use std::{collections::HashMap, fs, io::Write, path::Path, time::Duration};

use rmcp::{
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::local_mcp_inventory::{
    codex_config_files, configuration_revision, effective_workspace_paths, locate_server,
    ConfigFile, LocatedMcpServer, McpConfigScope, McpHarnessId,
};

const CHECK_TIMEOUT: Duration = Duration::from_secs(40);
const MAX_CONFIGURATION_BYTES: usize = 1024 * 1024;
static CONFIGURATION_WRITE: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCheckResult {
    pub status: String,
    pub checked_at: String,
    pub configuration_revision: String,
    pub message: Option<String>,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    pub tools: Vec<Value>,
}

/// What a check of a server defined inside a project folder would start or
/// contact. Environment variables and headers are named, never valued.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLaunchPreview {
    /// The configuration file the server is defined in.
    pub file: String,
    /// The program that would start: its full path when it is found on PATH,
    /// otherwise the name as the file writes it.
    pub program: Option<String>,
    pub args: Vec<String>,
    pub env_names: Vec<String>,
    /// A remote server's address, without credentials, query or fragment.
    pub endpoint: Option<String>,
    pub header_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCheckConfirmation {
    /// Always `needsConfirmation`, so the renderer can tell this answer apart.
    pub status: &'static str,
    /// What the operator confirms: the next check passes it back.
    pub configuration_revision: String,
    pub launch: McpLaunchPreview,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum McpCheckOutcome {
    Checked(McpCheckResult),
    NeedsConfirmation(McpCheckConfirmation),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfiguration {
    pub configuration: Value,
    pub revision: String,
    pub source: String,
}

pub(crate) fn validate_configuration(value: &Value) -> Result<(), String> {
    if !value.is_object() || value.to_string().len() > MAX_CONFIGURATION_BYTES {
        return Err("MCP configuration must be a JSON object smaller than 1 MiB.".into());
    }
    let command = value.get("command").or_else(|| value.get("cmd"));
    let url = value
        .get("url")
        .or_else(|| value.get("uri"))
        .or_else(|| value.get("httpUrl"));
    if command.is_some() {
        let valid = command.is_some_and(|command| {
            command.as_str().is_some_and(|s| !s.trim().is_empty())
                || command.as_array().is_some_and(|a| {
                    !a.is_empty() && a.iter().all(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                })
        });
        if !valid {
            return Err("A local MCP needs a command and string arguments.".into());
        }
        if value.get("args").is_some_and(|args| {
            !args
                .as_array()
                .is_some_and(|args| args.iter().all(Value::is_string))
        }) {
            return Err("MCP arguments must be a JSON array of strings.".into());
        }
    } else if let Some(raw) = url.and_then(Value::as_str) {
        let url = url::Url::parse(raw).map_err(|_| "The MCP endpoint is not a valid URL.")?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("A remote MCP needs an HTTP or HTTPS endpoint.".into());
        }
    } else {
        return Err("Provide a local command or a remote MCP endpoint.".into());
    }
    for key in ["env", "envs", "environment", "headers", "http_headers"] {
        if value.get(key).is_some_and(|map| {
            !map.as_object()
                .is_some_and(|map| map.values().all(Value::is_string))
        }) {
            return Err(format!("{key} must be a JSON object with string values."));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn read_local_mcp_configuration(
    app: tauri::AppHandle,
    id: String,
    workspace_paths: Option<Vec<String>>,
) -> Result<McpConfiguration, String> {
    let workspace_paths = effective_workspace_paths(&app, workspace_paths)?;
    tauri::async_runtime::spawn_blocking(move || {
        let located = locate_server(&id, &workspace_paths)?;
        Ok(McpConfiguration {
            configuration: located.config,
            revision: configuration_revision(&located.contents),
            source: located.file.label,
        })
    })
    .await
    .map_err(|_| "Cannot read MCP configuration".to_string())?
}

// The parameters are the command's IPC contract with the renderer.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn update_local_mcp_configuration(
    app: tauri::AppHandle,
    id: String,
    revision: String,
    configuration: Option<Value>,
    enabled: Option<bool>,
    remove: Option<bool>,
    confirmed: Option<bool>,
    workspace_paths: Option<Vec<String>>,
) -> Result<(), String> {
    let _guard = CONFIGURATION_WRITE.lock().await;
    let root = crate::services::flock_root::app_root(&app)?;
    let workspace_paths = effective_workspace_paths(&app, workspace_paths)?;
    tauri::async_runtime::spawn_blocking(move || {
        let located = locate_server(&id, &workspace_paths)?;
        if located.file.scope == McpConfigScope::Plugin {
            return Err(
                "This MCP is provided by a plugin. Manage the plugin in its provider's settings."
                    .into(),
            );
        }
        if id.starts_with("grok-inherited:") && enabled.is_none() {
            return Err(
                "Configure or remove an inherited MCP in its original provider's settings.".into(),
            );
        }
        if configuration_revision(&located.contents) != revision {
            return Err(
                "The configuration changed in another application. Refresh before saving.".into(),
            );
        }
        if remove == Some(true) && confirmed != Some(true) {
            return Err("Confirm removal of this MCP configuration.".into());
        }
        if let Some(configuration) = &configuration {
            validate_configuration(configuration)?;
        }
        if [
            configuration.is_some(),
            enabled.is_some(),
            remove == Some(true),
        ]
        .into_iter()
        .filter(|v| *v)
        .count()
            != 1
        {
            return Err("Choose one MCP configuration action.".into());
        }
        // Grok's inherited entries are toggled in Grok's own settings, never
        // by disabling the same server for its original provider.
        if let Some(enabled) = enabled.filter(|_| {
            id.starts_with("grok-inherited:") || located.harness == McpHarnessId::ClaudeCode
        }) {
            return toggle_inherited(&root, &id, &located.config_key, enabled, &workspace_paths);
        }
        if let Some(enabled) = enabled.filter(|_| located.harness == McpHarnessId::Gemini) {
            let path = dirs::home_dir()
                .ok_or("Cannot locate Gemini settings")?
                .join(".gemini/mcp-server-enablement.json");
            let raw = match fs::read_to_string(&path) {
                Ok(raw) => Some(raw),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err("Cannot read Gemini MCP enablement settings".into()),
            };
            let mut state: Value = serde_json::from_str(raw.as_deref().unwrap_or("{}"))
                .map_err(|_| "Invalid Gemini MCP enablement settings")?;
            let map = state
                .as_object_mut()
                .ok_or("Invalid Gemini MCP enablement settings")?;
            let key = located.config_key.trim().to_ascii_lowercase();
            if enabled {
                map.remove(&key);
            } else {
                map.insert(key, json!({"enabled":false}));
            }
            let output = serde_json::to_string_pretty(&state)
                .map_err(|_| "Cannot encode Gemini MCP settings")?;
            return match raw {
                Some(raw) => replace_with_backup(&path, &raw, &output, &root),
                None => atomic_write(&path, output.as_bytes()),
            };
        }
        let output = edit_configuration(
            &located.contents,
            &located.pointer,
            configuration.as_ref(),
            enabled,
            remove == Some(true),
            located.file.path.extension().is_some_and(|v| v == "toml"),
        )?;
        replace_with_backup(&located.file.path, &located.contents, &output, &root)
    })
    .await
    .map_err(|_| "Cannot update MCP configuration".to_string())?
}

fn edit_configuration(
    raw: &str,
    pointer: &[String],
    config: Option<&Value>,
    enabled: Option<bool>,
    remove: bool,
    toml: bool,
) -> Result<String, String> {
    let (key, parents) = pointer.split_last().ok_or("Missing MCP entry")?;
    if toml {
        let mut document = raw
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "Invalid TOML configuration")?;
        let mut parent = document.as_item_mut();
        for part in parents {
            parent = parent.get_mut(part).ok_or("MCP source changed")?;
        }
        if remove {
            parent
                .as_table_like_mut()
                .ok_or("Invalid MCP section")?
                .remove(key);
        } else if let Some(enabled) = enabled {
            parent[key]["enabled"] = toml_edit::value(enabled);
        } else if let Some(config) = config {
            let rendered = toml::to_string(&json!({"entry":config}))
                .map_err(|_| "Cannot encode MCP settings as TOML")?;
            let mut replacement = rendered
                .parse::<toml_edit::DocumentMut>()
                .map_err(|_| "Cannot encode MCP settings")?;
            parent[key] = replacement.remove("entry").ok_or("Missing MCP entry")?;
        }
        Ok(document.to_string())
    } else {
        let mut document: Value =
            serde_json::from_str(raw).map_err(|_| "Invalid JSON configuration")?;
        let mut parent = &mut document;
        for part in parents {
            parent = parent.get_mut(part).ok_or("MCP source changed")?;
        }
        if remove {
            parent
                .as_object_mut()
                .ok_or("Invalid MCP section")?
                .remove(key);
        } else if let Some(enabled) = enabled {
            parent[key]["enabled"] = json!(enabled);
        } else if let Some(config) = config {
            parent[key] = config.clone();
        }
        serde_json::to_string_pretty(&document)
            .map(|raw| format!("{raw}\n"))
            .map_err(|_| "Cannot encode MCP configuration".into())
    }
}

fn toggle_inherited(
    root: &Path,
    id: &str,
    key: &str,
    enabled: bool,
    workspaces: &[String],
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot locate the provider home")?;
    if id.starts_with("grok-inherited:") {
        let path = crate::services::shell_env::user_env_var("GROK_HOME")
            .map(std::path::PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".grok"))
            .join("config.toml");
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(_) => return Err("Cannot read Grok settings".into()),
        };
        let mut document = raw
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "Invalid Grok settings")?;
        let mut disabled = document
            .get("disabled_mcp_servers")
            .and_then(toml_edit::Item::as_array)
            .cloned()
            .unwrap_or_default();
        disabled.retain(|name| name.as_str() != Some(key));
        if !enabled {
            disabled.push(key);
        }
        document["disabled_mcp_servers"] = toml_edit::value(disabled);
        if path.exists() {
            replace_with_backup(&path, &raw, &document.to_string(), root)
        } else {
            atomic_write(&path, document.to_string().as_bytes())
        }
    } else {
        let path = home.join(".claude.json");
        let raw = fs::read_to_string(&path).map_err(|_| "Cannot read Claude Code settings")?;
        let mut document: Value =
            serde_json::from_str(&raw).map_err(|_| "Invalid Claude Code settings")?;
        let workspace = workspaces
            .first()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| root.join("artifacts"));
        let workspace = workspace
            .canonicalize()
            .unwrap_or(workspace)
            .to_string_lossy()
            .replace('\\', "/");
        let slot = &mut document["projects"][workspace]["disabledMcpServers"];
        let mut disabled = slot.as_array().cloned().unwrap_or_default();
        disabled.retain(|name| name.as_str() != Some(key));
        if !enabled {
            disabled.push(json!(key));
        }
        *slot = json!(disabled);
        replace_with_backup(
            &path,
            &raw,
            &format!(
                "{}\n",
                serde_json::to_string_pretty(&document)
                    .map_err(|_| "Cannot encode Claude Code settings")?
            ),
            root,
        )
    }
}

fn replace_with_backup(path: &Path, before: &str, after: &str, root: &Path) -> Result<(), String> {
    if fs::read_to_string(path).map_err(|_| "Cannot re-read MCP source")? != before {
        return Err(
            "The configuration changed in another application. Refresh before saving.".into(),
        );
    }
    let backup_dir = root.join("backups/mcp");
    fs::create_dir_all(&backup_dir).map_err(|_| "Cannot create an MCP configuration backup")?;
    atomic_write(
        &backup_dir.join(format!("{}.backup", uuid::Uuid::new_v4())),
        before.as_bytes(),
    )?;
    atomic_write(path, after.as_bytes())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("MCP file has no parent directory")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create MCP data directory")?;
    let temp = parent.join(format!(".mcp-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|_| "Cannot save MCP data".into())
}

#[tauri::command]
pub async fn list_mcp_diagnostics(
    app: tauri::AppHandle,
) -> Result<HashMap<String, McpCheckResult>, String> {
    let path = crate::services::flock_root::app_root(&app)?.join("state/mcp-diagnostics.json");
    match fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "Cannot read MCP diagnostics".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(_) => Err("Cannot read MCP diagnostics".into()),
    }
}

#[tauri::command]
pub async fn check_mcp_connection(
    app: tauri::AppHandle,
    id: String,
    configuration: Option<Value>,
    workspace_paths: Option<Vec<String>>,
    confirmed_revision: Option<String>,
) -> Result<McpCheckOutcome, String> {
    if id.is_empty() || id.len() > 2048 {
        return Err("Invalid MCP configuration id".into());
    }
    let env = crate::services::managed_acp_tools::provider_env(&app).await;
    let config = match configuration {
        Some(config) => {
            validate_configuration(&config)?;
            config
        }
        None => {
            let workspace_paths = effective_workspace_paths(&app, workspace_paths)?;
            let located = locate_server(&id, &workspace_paths)?;
            validate_configuration(&located.config)?;
            if let Some(question) = confirmation_before_start(
                &located,
                &workspace_paths,
                confirmed_revision.as_deref(),
                crate::services::env_key::get(&env, "PATH"),
            ) {
                return Ok(McpCheckOutcome::NeedsConfirmation(question));
            }
            located.config
        }
    };
    let checked = tokio::time::timeout(CHECK_TIMEOUT, probe_connection(&config, &env)).await;
    let mut result = McpCheckResult {
        status: "connected".into(),
        checked_at: chrono::Utc::now().to_rfc3339(),
        configuration_revision: configuration_revision(&config.to_string()),
        message: None,
        server_name: None,
        server_version: None,
        tools: Vec::new(),
    };
    match checked {
        Ok(Ok((info, tools))) => {
            result.server_name = info
                .pointer("/serverInfo/name")
                .and_then(Value::as_str)
                .map(|s| scrub(s, &config));
            result.server_version = info
                .pointer("/serverInfo/version")
                .and_then(Value::as_str)
                .map(|s| scrub(s, &config));
            result.tools = tools.into_iter().take(500).map(|tool| json!({"name":scrub(tool.get("name").and_then(Value::as_str).unwrap_or(""), &config),"description":scrub(tool.get("description").and_then(Value::as_str).unwrap_or(""), &config)})).collect();
        }
        Ok(Err(error)) => {
            let lower = error.to_ascii_lowercase();
            result.status = if lower.contains("authrequired")
                || lower.contains("auth required")
                || lower.contains("401")
                || lower.contains("unauthorized")
            {
                "needsAuth"
            } else {
                "error"
            }
            .into();
            result.message = Some(scrub(&error, &config));
        }
        Err(_) => {
            result.status = "error".into();
            result.message = Some("The MCP did not respond within 40 seconds.".into());
        }
    }
    let _guard = CONFIGURATION_WRITE.lock().await;
    let root = crate::services::flock_root::app_root(&app)?;
    let path = root.join("state/mcp-diagnostics.json");
    let mut records: HashMap<String, McpCheckResult> = fs::read(&path)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default();
    records.insert(id, result.clone());
    if records.len() > 1024 {
        if let Some(oldest) = records
            .iter()
            .min_by_key(|(_, row)| &row.checked_at)
            .map(|(key, _)| key.clone())
        {
            records.remove(&oldest);
        }
    }
    atomic_write(
        &path,
        &serde_json::to_vec(&records).map_err(|_| "Cannot encode MCP diagnostics")?,
    )?;
    Ok(McpCheckOutcome::Checked(result))
}

/// The question "Check" asks before it starts or contacts a server defined in
/// a file inside a project folder, or `None` when it may go ahead.
///
/// Such a file is content: a cloned repository can put any program behind a
/// friendly name and description, and the list shows neither the program nor
/// its arguments. So the operator is shown what would run and asked, every
/// time. The answer names the revision that was shown; a file that changed
/// since is asked about again instead of started. Servers from the operator's
/// own configuration are not asked about.
fn confirmation_before_start(
    located: &LocatedMcpServer,
    workspace_paths: &[String],
    confirmed_revision: Option<&str>,
    path: Option<&str>,
) -> Option<McpCheckConfirmation> {
    if !comes_from_a_project(&located.file, workspace_paths) {
        return None;
    }
    let revision = configuration_revision(&located.config.to_string());
    if confirmed_revision == Some(revision.as_str()) {
        return None;
    }
    Some(McpCheckConfirmation {
        status: "needsConfirmation",
        configuration_revision: revision,
        launch: launch_preview(&located.file.path, &located.config, path),
    })
}

/// Whether a configuration file lies inside one of the project folders.
///
/// A Codex profile gets its own scope whichever file it is in, so where that
/// file lives decides; the inventory's own file list says which Codex file
/// belongs to a project.
fn comes_from_a_project(file: &ConfigFile, workspace_paths: &[String]) -> bool {
    match file.scope {
        McpConfigScope::Project => true,
        McpConfigScope::Profile => codex_config_files(workspace_paths)
            .iter()
            .any(|codex| codex.path == file.path && codex.scope == McpConfigScope::Project),
        McpConfigScope::User | McpConfigScope::LocalProject | McpConfigScope::Plugin => false,
    }
}

fn launch_preview(file: &Path, config: &Value, path: Option<&str>) -> McpLaunchPreview {
    let mut preview = McpLaunchPreview {
        file: dunce::simplified(file).display().to_string(),
        program: None,
        args: Vec::new(),
        env_names: Vec::new(),
        endpoint: None,
        header_names: Vec::new(),
    };
    if let Some(launch) = local_launch(config) {
        preview.program = launch.program.map(|program| {
            crate::services::path_env::resolve_executable(program, &[], path)
                .map(|resolved| resolved.display().to_string())
                .unwrap_or_else(|| program.to_string())
        });
        preview.env_names = launch
            .env
            .iter()
            .map(|(name, _)| name.to_string())
            .collect();
        preview.args = launch.args;
    } else {
        preview.endpoint = remote_endpoint(config).map(|raw| scrub(raw, config));
        preview.header_names = remote_headers(config)
            .map(|headers| headers.keys().cloned().collect())
            .unwrap_or_default();
    }
    preview
}

/// What a local configuration starts: the program as written, its arguments
/// and the variables it adds to the environment.
struct LocalLaunch<'a> {
    program: Option<&'a str>,
    args: Vec<String>,
    env: Vec<(&'a str, &'a str)>,
}

/// Read one way for both the spawn and the question, so the operator is shown
/// exactly what runs. `None` for a remote server.
fn local_launch(config: &Value) -> Option<LocalLaunch<'_>> {
    let command = config.get("command").or_else(|| config.get("cmd"))?;
    let mut args = command
        .as_array()
        .map(|v| {
            v.iter()
                .filter_map(Value::as_str)
                .skip(1)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    args.extend(
        config
            .get("args")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string),
    );
    let env = config
        .get("env")
        .or_else(|| config.get("envs"))
        .or_else(|| config.get("environment"))
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| Some((key.as_str(), value.as_str()?)))
        .collect();
    Some(LocalLaunch {
        program: command
            .as_str()
            .or_else(|| command.as_array()?.first()?.as_str()),
        args,
        env,
    })
}

fn remote_endpoint(config: &Value) -> Option<&str> {
    config
        .get("url")
        .or_else(|| config.get("uri"))
        .or_else(|| config.get("httpUrl"))
        .and_then(Value::as_str)
}

fn remote_headers(config: &Value) -> Option<&serde_json::Map<String, Value>> {
    config
        .get("headers")
        .or_else(|| config.get("http_headers"))
        .and_then(Value::as_object)
}

fn scrub(text: &str, config: &Value) -> String {
    let mut text = text.to_string();
    for key in ["url", "uri", "httpUrl"] {
        if let Some(raw) = config.get(key).and_then(Value::as_str) {
            if let Ok(mut url) = url::Url::parse(raw) {
                let _ = url.set_username("");
                let _ = url.set_password(None);
                url.set_query(None);
                url.set_fragment(None);
                text = text.replace(raw, url.as_str());
            }
        }
    }
    text = crate::services::log_redaction::redact_log_line(&text);
    for key in ["env", "envs", "environment", "headers", "http_headers"] {
        if let Some(map) = config.get(key).and_then(Value::as_object) {
            for secret in map
                .values()
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                text = text.replace(secret, "[redacted]");
            }
        }
    }
    text.chars().take(2048).collect()
}

async fn probe_connection(
    config: &Value,
    env: &HashMap<String, String>,
) -> Result<(Value, Vec<Value>), String> {
    let mut child = None;
    let mut tree = None;
    let client = if let Some(launch) = local_launch(config) {
        let program = launch.program.ok_or("Missing MCP command")?;
        let resolved = crate::services::path_env::resolve_executable(
            program,
            &[],
            crate::services::env_key::get(env, "PATH"),
        )
        .ok_or("The MCP command is not installed or is not on PATH.")?;
        let mut command = tokio::process::Command::new(resolved);
        command.args(launch.args).env_clear().envs(env);
        crate::services::shell_env::remove_inherited_launcher_env(command.as_std_mut());
        crate::services::process::apply_no_window_async(&mut command);
        for (key, value) in launch.env {
            command.env(key, value);
        }
        let mut spawned = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "Cannot start the MCP command")?;
        tree = crate::services::process::ProcessTree::contain(&spawned);
        if cfg!(windows) && tree.is_none() {
            return Err("Cannot contain the MCP process for cleanup.".into());
        }
        let stdout = spawned.stdout.take().ok_or("MCP stdout unavailable")?;
        let stdin = spawned.stdin.take().ok_or("MCP stdin unavailable")?;
        child = Some(spawned);
        ().serve((stdout, stdin))
            .await
            .map_err(|error| error.to_string())?
    } else {
        let url = remote_endpoint(config).ok_or("Missing MCP endpoint")?;
        let mut transport = StreamableHttpClientTransportConfig::with_uri(url);
        if let Some(headers) = remote_headers(config) {
            for (name, value) in headers {
                let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| "Invalid MCP header name")?;
                let value = reqwest::header::HeaderValue::from_str(
                    value.as_str().ok_or("Invalid MCP header value")?,
                )
                .map_err(|_| "Invalid MCP header value")?;
                transport.custom_headers.insert(name, value);
            }
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(|_| "Cannot create an MCP HTTP client")?;
        ().serve(StreamableHttpClientTransport::with_client(http, transport))
            .await
            .map_err(|error| error.to_string())?
    };
    let info = client
        .peer_info()
        .and_then(|info| serde_json::to_value(info.as_ref()).ok())
        .unwrap_or(Value::Null);
    let tools = client
        .list_all_tools()
        .await
        .map_err(|error| error.to_string());
    let _ = tokio::time::timeout(Duration::from_secs(3), client.cancel()).await;
    if let Some(mut child) = child {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    }
    drop(tree);
    let tools = tools?;
    Ok((
        info,
        tools
            .into_iter()
            .filter_map(|tool| serde_json::to_value(tool).ok())
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toml_edit_preserves_comments_and_other_servers() {
        let raw = "# user settings\nmodel = 'example'\n[mcp_servers.first]\ncommand = 'node' # keep this\n[mcp_servers.second]\ncommand = 'python'\n";
        let edited = edit_configuration(
            raw,
            &["mcp_servers".into(), "first".into()],
            None,
            Some(false),
            false,
            true,
        )
        .unwrap();
        assert!(edited.contains("# user settings"));
        assert!(edited.contains("# keep this"));
        assert!(edited.contains("command = 'python'"));
        assert!(edited.contains("enabled = false"));
        let removed = edit_configuration(
            &edited,
            &["mcp_servers".into(), "first".into()],
            None,
            None,
            true,
            true,
        )
        .unwrap();
        assert!(!removed.contains("[mcp_servers.first]"));
        assert!(removed.contains("[mcp_servers.second]"));
    }

    #[test]
    fn diagnostics_do_not_echo_configured_secrets() {
        let config = json!({"url":"https://user:password@example.com/mcp?token=query-secret", "headers":{"Authorization":"Bearer header-secret"}, "env":{"TOKEN":"environment-secret"}});
        let result = scrub("Failed https://user:password@example.com/mcp?token=query-secret Bearer header-secret environment-secret", &config);
        for secret in [
            "password",
            "query-secret",
            "header-secret",
            "environment-secret",
        ] {
            assert!(!result.contains(secret), "{secret}");
        }
    }

    #[test]
    fn rejects_invalid_configuration_before_starting_any_transport() {
        for config in [
            json!({}),
            json!({"url":"file:///credentials"}),
            json!({"command":"node","args":"--version"}),
            json!({"url":"https://example.com/mcp","headers":{"Authorization":42}}),
        ] {
            assert!(validate_configuration(&config).is_err());
        }
        assert!(validate_configuration(&json!({"command":"node","args":["server.mjs"]})).is_ok());
        assert!(
            validate_configuration(&json!({"type":"http","url":"https://example.com/mcp"})).is_ok()
        );
        assert!(validate_configuration(&json!({"httpUrl":"https://example.com/mcp"})).is_ok());
    }

    /// A server defined in a project folder's `.mcp.json`, as a cloned
    /// repository carries it, located with the path and scope the inventory
    /// gives such a file.
    fn project_server(config: Value) -> (tempfile::TempDir, Vec<String>, LocatedMcpServer) {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("Cloned Project");
        fs::create_dir_all(&project).unwrap();
        let workspace_paths = vec![project.to_string_lossy().into_owned()];
        let located = LocatedMcpServer {
            file: ConfigFile {
                path: project.canonicalize().unwrap().join(".mcp.json"),
                scope: McpConfigScope::Project,
                label: "Claude Code project config".into(),
            },
            harness: McpHarnessId::ClaudeCode,
            pointer: vec!["mcpServers".into(), "github".into()],
            config_key: "github".into(),
            config,
            contents: String::new(),
        };
        (dir, workspace_paths, located)
    }

    /// Check on a project's server stops at a question that names the
    /// program, every argument, the names of the variables it sets and the
    /// file, and carries no variable's value.
    #[test]
    fn a_project_server_is_shown_and_asked_about_before_it_starts() {
        let (_dir, workspaces, located) = project_server(json!({
            "command": ["cmd.exe", "/d"],
            "args": ["/c", "echo ran> %TEMP%\\flock-mcp-check-ran"],
            "env": {"GITHUB_TOKEN": "environment-secret"},
            "description": "GitHub"
        }));

        let question = confirmation_before_start(&located, &workspaces, None, None)
            .expect("a question before anything starts");

        assert_eq!(question.status, "needsConfirmation");
        assert_eq!(question.launch.program.as_deref(), Some("cmd.exe"));
        assert_eq!(
            question.launch.args,
            ["/d", "/c", "echo ran> %TEMP%\\flock-mcp-check-ran"]
        );
        assert_eq!(question.launch.env_names, ["GITHUB_TOKEN"]);
        assert_eq!(
            question.launch.file,
            dunce::simplified(&located.file.path).display().to_string()
        );
        assert!(question.launch.file.ends_with(".mcp.json"));
        assert!(!question.launch.file.starts_with(r"\\?\"));
        let shown = serde_json::to_string(&question).unwrap();
        assert!(!shown.contains("environment-secret"), "{shown}");
        // The spawn reads the program and arguments the same way.
        let launch = local_launch(&located.config).unwrap();
        assert_eq!(launch.program, Some("cmd.exe"));
        assert_eq!(launch.args, question.launch.args);
    }

    /// The program is shown by the full path it would start from.
    #[test]
    fn the_question_names_the_program_by_the_path_it_would_start_from() {
        let (dir, workspaces, located) =
            project_server(json!({"command": "fixture-tool.exe", "args": []}));
        let bin = dir.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("fixture-tool.exe"), b"fixture").unwrap();
        let path = std::env::join_paths([&bin]).unwrap();

        let question =
            confirmation_before_start(&located, &workspaces, None, path.to_str()).unwrap();

        assert_eq!(
            question.launch.program.map(std::path::PathBuf::from),
            Some(bin.join("fixture-tool.exe"))
        );
    }

    /// Only the revision that was shown lets the check go ahead, and only for
    /// that one check: a changed definition is asked about again.
    #[test]
    fn a_project_server_starts_only_with_the_revision_the_operator_was_shown() {
        let (_dir, workspaces, located) =
            project_server(json!({"command": "cmd.exe", "args": ["/c", "echo first"]}));
        let shown = confirmation_before_start(&located, &workspaces, None, None)
            .unwrap()
            .configuration_revision;

        let shown = Some(shown.as_str());

        assert!(confirmation_before_start(&located, &workspaces, shown, None).is_none());
        assert!(confirmation_before_start(&located, &workspaces, Some("stale"), None).is_some());

        let mut changed = located;
        changed.config["args"] = json!(["/c", "echo second"]);
        assert!(confirmation_before_start(&changed, &workspaces, shown, None).is_some());
    }

    /// A remote server from a project is not contacted before the question
    /// either; the address is shown without credentials, headers by name.
    #[test]
    fn a_project_remote_server_is_asked_about_before_it_is_contacted() {
        let (_dir, workspaces, located) = project_server(json!({
            "url": "https://user:password@example.com/mcp?token=query-secret",
            "headers": {"Authorization": "Bearer header-secret"}
        }));

        let question = confirmation_before_start(&located, &workspaces, None, None).unwrap();

        assert_eq!(
            question.launch.endpoint.as_deref(),
            Some("https://example.com/mcp")
        );
        assert_eq!(question.launch.header_names, ["Authorization"]);
        assert_eq!(question.launch.program, None);
        let shown = serde_json::to_string(&question).unwrap();
        for secret in ["password", "query-secret", "header-secret"] {
            assert!(!shown.contains(secret), "{secret}");
        }
    }

    /// Servers from the operator's own configuration check as before. A Codex
    /// profile is asked about when it sits in the project's Codex file.
    #[test]
    fn servers_from_the_operators_own_configuration_start_without_a_question() {
        let (dir, workspaces, mut located) = project_server(json!({"command": "cmd.exe"}));
        located.file.path = dir.path().join("home").join(".claude.json");
        for scope in [
            McpConfigScope::User,
            McpConfigScope::LocalProject,
            McpConfigScope::Plugin,
            McpConfigScope::Profile,
        ] {
            located.file.scope = scope;
            assert!(
                confirmation_before_start(&located, &workspaces, None, None).is_none(),
                "{scope:?}"
            );
        }

        let project_codex = codex_config_files(&workspaces)
            .into_iter()
            .find(|file| file.scope == McpConfigScope::Project)
            .expect("the project's Codex file");
        located.file.path = project_codex.path;
        located.file.scope = McpConfigScope::Profile;
        assert!(confirmation_before_start(&located, &workspaces, None, None).is_some());
    }

    #[test]
    fn saves_backup_and_rejects_stale_file_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let before = r#"{"mcpServers":{"first":{"command":"node"}}}"#;
        let after = r#"{"mcpServers":{}}"#;
        fs::write(&path, before).unwrap();
        replace_with_backup(&path, before, after, dir.path()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), after);
        let backups = fs::read_dir(dir.path().join("backups/mcp"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), before);
        assert!(replace_with_backup(&path, before, "{}", dir.path()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), after);
    }
}
