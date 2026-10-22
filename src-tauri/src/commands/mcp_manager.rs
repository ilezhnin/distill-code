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
    configuration_revision, effective_workspace_paths, locate_server, McpConfigScope, McpHarnessId,
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
) -> Result<McpCheckResult, String> {
    if id.is_empty() || id.len() > 2048 {
        return Err("Invalid MCP configuration id".into());
    }
    let config = match configuration {
        Some(config) => config,
        None => locate_server(&id, &effective_workspace_paths(&app, workspace_paths)?)?.config,
    };
    validate_configuration(&config)?;
    let env = crate::services::managed_acp_tools::provider_env(&app).await;
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
    Ok(result)
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
    let client = if let Some(command) = config.get("command").or_else(|| config.get("cmd")) {
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
        let program = command
            .as_str()
            .or_else(|| command.as_array()?.first()?.as_str())
            .ok_or("Missing MCP command")?;
        let resolved = crate::services::path_env::resolve_executable(
            program,
            &[],
            crate::services::env_key::get(env, "PATH"),
        )
        .ok_or("The MCP command is not installed or is not on PATH.")?;
        let mut command = tokio::process::Command::new(resolved);
        command.args(args).env_clear().envs(env);
        crate::services::shell_env::remove_inherited_launcher_env(command.as_std_mut());
        crate::services::process::apply_no_window_async(&mut command);
        if let Some(vars) = config
            .get("env")
            .or_else(|| config.get("envs"))
            .or_else(|| config.get("environment"))
            .and_then(Value::as_object)
        {
            for (key, value) in vars {
                if let Some(value) = value.as_str() {
                    command.env(key, value);
                }
            }
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
        let url = config
            .get("url")
            .or_else(|| config.get("uri"))
            .or_else(|| config.get("httpUrl"))
            .and_then(Value::as_str)
            .ok_or("Missing MCP endpoint")?;
        let mut transport = StreamableHttpClientTransportConfig::with_uri(url);
        if let Some(headers) = config
            .get("headers")
            .or_else(|| config.get("http_headers"))
            .and_then(Value::as_object)
        {
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
