//! Host extension methods (`_distill/...`): everything the renderer needs
//! beyond core ACP — session metadata, defaults and preferences, MCP server
//! configuration, the harness inventory, and skill/agent/project sources.

use serde_json::{json, Value};
use std::sync::Arc;

use super::harness;
use super::protocol::{self, invalid_params};
use super::router::Inner;
use super::sources;

fn session_id(params: &Value) -> Result<String, Value> {
    protocol::session_id(params).ok_or_else(|| invalid_params("sessionId required"))
}

pub async fn handle(host: &Arc<Inner>, method: &str, params: Value) -> Result<Value, Value> {
    match method {
        // --- sessions -------------------------------------------------------
        "session/info" => {
            let id = session_id(&params)?;
            let record = host.session_record(&id).await?;
            let active = host.active_run_id(&id).await;
            Ok(json!({ "session": Inner::session_info(&record, active.as_deref()) }))
        }
        "session/rename" => {
            let id = session_id(&params)?;
            let title = params
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            // Clearing the name is not choosing the empty one: storing `""` as
            // a user-set title would block the agent's proposed title forever
            // and leave the chat nameless. An empty rename hands the naming
            // back to the agent.
            host.store
                .set_title(&id, &title, !title.is_empty())
                .await
                .map_err(protocol::internal)?;
            Ok(json!({}))
        }
        "session/archive" => {
            let id = session_id(&params)?;
            host.store
                .set_archived(&id, true)
                .await
                .map_err(protocol::internal)?;
            Ok(json!({}))
        }
        "session/unarchive" => {
            let id = session_id(&params)?;
            host.store
                .set_archived(&id, false)
                .await
                .map_err(protocol::internal)?;
            Ok(json!({}))
        }
        "session/project/update" => {
            let id = session_id(&params)?;
            let project_id = params
                .get("projectId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            host.store
                .set_project(&id, project_id)
                .await
                .map_err(protocol::internal)?;
            Ok(json!({}))
        }
        "session/working_dir/update" => {
            let id = session_id(&params)?;
            let cwd = params
                .get("workingDir")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("workingDir required"))?;
            let moved = host
                .session_record(&id)
                .await
                .is_ok_and(|record| record.cwd != cwd);
            host.store
                .set_cwd(&id, cwd)
                .await
                .map_err(protocol::internal)?;
            // A bridge session runs in the folder it was created in and cannot
            // be moved, so a chat that changed folders has to stop using the
            // one it has — otherwise the next prompt still runs in the old one.
            if moved && !host.release_bridge_session(&id).await {
                log::warn!(
                    "[agent-host] session {id} moved folders while a turn was running; the running turn stays in the old one"
                );
            }
            Ok(json!({}))
        }
        "session/steer" => host.steer(params).await,
        "session/extensions/list" => {
            let records = host.store.mcp_list().await.map_err(protocol::internal)?;
            let extensions: Vec<Value> = records
                .into_iter()
                .filter(|record| record.enabled)
                .map(|record| record.config)
                .collect();
            Ok(json!({ "extensions": extensions }))
        }
        "session/extensions/remove" => Ok(json!({})),
        "session/messages" => {
            let id = session_id(&params)?;
            let events = host
                .store
                .list_events(&id)
                .await
                .map_err(protocol::internal)?;
            Ok(json!({ "messages": transcript_messages(&events) }))
        }

        // --- preferences ----------------------------------------------------
        "preferences/read" => {
            let keys: Vec<String> = params
                .get("keys")
                .and_then(Value::as_array)
                .map(|keys| {
                    keys.iter()
                        .filter_map(|key| key.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let all = host
                .store
                .kv_list("preferences")
                .await
                .map_err(protocol::internal)?;
            let values: Vec<Value> = all
                .into_iter()
                .filter(|(key, _)| keys.is_empty() || keys.contains(key))
                .map(|(key, value)| json!({ "key": key, "value": value }))
                .collect();
            Ok(json!({ "values": values }))
        }
        "preferences/save" => {
            for entry in params
                .get("values")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let Some(key) = entry.get("key").and_then(Value::as_str) else {
                    continue;
                };
                let value = entry.get("value").cloned().unwrap_or(Value::Null);
                host.store
                    .kv_set("preferences", key, &value)
                    .await
                    .map_err(protocol::internal)?;
            }
            Ok(json!({}))
        }
        "preferences/remove" => {
            for key in params
                .get("keys")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                if let Some(key) = key.as_str() {
                    host.store
                        .kv_delete("preferences", key)
                        .await
                        .map_err(protocol::internal)?;
                }
            }
            Ok(json!({}))
        }
        "settings/read" => {
            let key = params
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("key required"))?;
            let value = host
                .store
                .kv_get("settings", key)
                .await
                .map_err(protocol::internal)?;
            Ok(json!({ "value": value }))
        }
        "settings/save" => {
            let key = params
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("key required"))?;
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            host.store
                .kv_set("settings", key, &value)
                .await
                .map_err(protocol::internal)?;
            Ok(json!({}))
        }

        // --- MCP servers ---------------------------------------------------
        "config/extensions/list" => {
            let records = host.store.mcp_list().await.map_err(protocol::internal)?;
            let extensions: Vec<Value> = records
                .into_iter()
                .map(|record| json!({ "extension": record.config, "enabled": record.enabled, "configKey": record.config_key }))
                .collect();
            Ok(json!({ "extensions": extensions, "warnings": [] }))
        }
        "config/extensions/add" => {
            let extension = params
                .get("extension")
                .cloned()
                .ok_or_else(|| invalid_params("extension required"))?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let key = extension_config_key(&extension)
                .ok_or_else(|| invalid_params("extension needs a name"))?;
            host.store
                .mcp_upsert(&key, &extension, enabled)
                .await
                .map_err(protocol::internal)?;
            Ok(json!({}))
        }
        "config/extensions/remove" => {
            let key = params
                .get("configKey")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("configKey required"))?;
            host.store
                .mcp_delete(key)
                .await
                .map_err(protocol::internal)?;
            Ok(json!({}))
        }
        "config/extensions/set_enabled" => {
            let key = params
                .get("configKey")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("configKey required"))?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            host.store
                .mcp_set_enabled(key, enabled)
                .await
                .map_err(protocol::internal)?;
            Ok(json!({}))
        }

        // --- harness inventory ---------------------------------------------
        "providers/list" => {
            let installed = host.installed_harnesses().await;
            let mut entries = Vec::new();
            for spec in harness::HARNESSES {
                let is_installed = installed.iter().any(|candidate| candidate.id == spec.id);
                let models = cached_models(host, spec.id).await;
                entries.push(json!({
                    "providerId": spec.id,
                    "providerName": spec.label,
                    "description": spec.description,
                    "defaultModel": "",
                    "configured": is_installed,
                    "available": is_installed,
                    "providerType": "acp",
                    "category": "agent",
                    "acp": true,
                    "visibleInSetup": true,
                    "deprecated": false,
                    "replacement": null,
                    "configKeys": [],
                    "setupSteps": [],
                    "supportsRefresh": true,
                    "refreshing": false,
                    "models": models,
                    "lastUpdatedAt": null,
                    "lastRefreshAttemptAt": null,
                    "lastRefreshError": null,
                    "stale": false,
                    "modelSelectionHint": null,
                }));
            }
            Ok(json!({ "providers": entries }))
        }
        "providers/supported_models/list" => {
            let provider_id = params
                .get("providerId")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("providerId required"))?
                .to_string();
            let mut models = cached_models(host, &provider_id).await;
            if models.is_empty() {
                models = refresh_models(host, &provider_id).await?;
            }
            let ids: Vec<Value> = models
                .iter()
                .filter_map(|model| model.get("id").cloned())
                .collect();
            Ok(json!({ "providerId": provider_id, "models": ids }))
        }
        "providers/inventory/refresh" => {
            let provider_id = params
                .get("providerId")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("providerId required"))?
                .to_string();
            let models = refresh_models(host, &provider_id).await?;
            Ok(json!({ "providerId": provider_id, "models": models }))
        }

        // --- sources -------------------------------------------------------
        "sources/list" => sources::list(&params, &host.roots),
        "sources/create" => sources::create(&params, &host.roots),
        "sources/update" => sources::update(&params, &host.roots),
        "sources/delete" => sources::delete(&params, &host.roots),
        "sources/export" => sources::export(&params, &host.roots),
        "sources/import" => sources::import(&params, &host.roots),

        _ => Err(protocol::error(
            protocol::METHOD_NOT_FOUND,
            format!("Unsupported host method {method}"),
        )),
    }
}

async fn cached_models(host: &Arc<Inner>, harness_id: &str) -> Vec<Value> {
    host.store
        .kv_get("models", harness_id)
        .await
        .ok()
        .flatten()
        .and_then(|value| value.get("models")?.as_array().cloned())
        .unwrap_or_default()
}

async fn refresh_models(host: &Arc<Inner>, harness_id: &str) -> Result<Vec<Value>, Value> {
    let models = host.probe_models(harness_id).await?;
    let value = json!({ "models": models, "updatedAt": protocol::now_iso() });
    host.store
        .kv_set("models", harness_id, &value)
        .await
        .map_err(protocol::internal)?;
    Ok(models)
}

pub fn extension_config_key(extension: &Value) -> Option<String> {
    let name = extension
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| extension.pointer("/server/name").and_then(Value::as_str))?;
    let key: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// Translate a stored extension config (the goose-era shape the renderer
/// still edits) into the ACP `McpServer` a bridge accepts.
pub fn mcp_server_from_extension(extension: &Value) -> Option<Value> {
    let name = extension
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| extension.pointer("/server/name").and_then(Value::as_str))?
        .to_string();
    let kind = extension
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio");
    let env_pairs = |value: Option<&Value>| -> Vec<Value> {
        value
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .map(|(key, value)| json!({ "name": key, "value": value }))
                    .collect()
            })
            .unwrap_or_default()
    };
    match kind {
        "stdio" => {
            let command = extension
                .get("cmd")
                .or_else(|| extension.get("command"))
                .and_then(Value::as_str)?;
            let args = extension.get("args").cloned().unwrap_or_else(|| json!([]));
            let env = env_pairs(extension.get("envs").or_else(|| extension.get("env")));
            Some(json!({ "name": name, "command": command, "args": args, "env": env }))
        }
        "streamable_http" | "http" => {
            let url = extension
                .get("uri")
                .or_else(|| extension.get("url"))
                .and_then(Value::as_str)?;
            let headers: Vec<Value> = extension
                .get("headers")
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .map(|(key, value)| json!({ "name": key, "value": value }))
                        .collect()
                })
                .unwrap_or_default();
            Some(json!({ "type": "http", "name": name, "url": url, "headers": headers }))
        }
        "sse" => {
            let url = extension
                .get("uri")
                .or_else(|| extension.get("url"))
                .and_then(Value::as_str)?;
            let headers: Vec<Value> = extension
                .get("headers")
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .map(|(key, value)| json!({ "name": key, "value": value }))
                        .collect()
                })
                .unwrap_or_default();
            Some(json!({ "type": "sse", "name": name, "url": url, "headers": headers }))
        }
        _ => None,
    }
}

/// Fold the persisted `session/update` stream into whole text messages:
/// consecutive user/agent chunks that share a host message id become one
/// message. Tool calls, thoughts and images are left out on purpose; this is
/// the corpus for search and cross-session recall, not a replay.
fn transcript_messages(events: &[Value]) -> Vec<Value> {
    let mut messages: Vec<(String, &str, Option<String>, String)> = Vec::new();
    for event in events {
        let Some(update) = event.get("update") else {
            continue;
        };
        let role = match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("user_message_chunk") => "user",
            Some("agent_message_chunk") => "assistant",
            _ => continue,
        };
        let Some(text) = update
            .get("content")
            .filter(|content| content.get("type").and_then(Value::as_str) == Some("text"))
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let meta = update.get("_meta").and_then(|meta| meta.get("distill"));
        // A reply carries its own id next to the prompt's; older history
        // stamped agent chunks with the prompt's id only.
        let own_id = match role {
            "assistant" => meta.and_then(|meta| meta.get("assistantMessageId")),
            _ => None,
        };
        let message_id = own_id
            .or_else(|| meta.and_then(|meta| meta.get("messageId")))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{role}-{}", messages.len()));
        let created = meta
            .and_then(|meta| meta.get("created"))
            .and_then(Value::as_str)
            .map(str::to_string);
        match messages.last_mut() {
            Some((id, last_role, _, body)) if *id == message_id && *last_role == role => {
                body.push_str(text)
            }
            _ => messages.push((message_id, role, created, text.to_string())),
        }
    }
    messages
        .into_iter()
        .map(|(id, role, created, text)| {
            json!({
                "id": id,
                "role": role,
                "created": created,
                "content": [{ "type": "text", "text": text }],
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(kind: &str, text: &str, distill: Value) -> Value {
        json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": kind,
                "content": { "type": "text", "text": text },
                "_meta": { "distill": distill },
            }
        })
    }

    #[test]
    fn a_reply_is_its_own_message_when_it_carries_an_assistant_id() {
        let events = [
            chunk("user_message_chunk", "hi", json!({ "messageId": "u1" })),
            chunk(
                "agent_message_chunk",
                "hel",
                json!({ "messageId": "u1", "assistantMessageId": "a1" }),
            ),
            chunk(
                "agent_message_chunk",
                "lo",
                json!({ "messageId": "u1", "assistantMessageId": "a1" }),
            ),
            chunk("user_message_chunk", "again", json!({ "messageId": "u2" })),
            chunk(
                "agent_message_chunk",
                "ok",
                json!({ "messageId": "u2", "assistantMessageId": "a2" }),
            ),
        ];
        let messages = transcript_messages(&events);
        let summary: Vec<(String, String, String)> = messages
            .iter()
            .map(|message| {
                (
                    message["id"].as_str().unwrap_or_default().to_string(),
                    message["role"].as_str().unwrap_or_default().to_string(),
                    message["content"][0]["text"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                )
            })
            .collect();
        let expected: Vec<(String, String, String)> = [
            ("u1", "user", "hi"),
            ("a1", "assistant", "hello"),
            ("u2", "user", "again"),
            ("a2", "assistant", "ok"),
        ]
        .iter()
        .map(|(id, role, text)| (id.to_string(), role.to_string(), text.to_string()))
        .collect();
        assert_eq!(summary, expected);
    }

    #[test]
    fn older_history_without_an_assistant_id_still_folds_by_the_prompt_id() {
        let events = [
            chunk("user_message_chunk", "hi", json!({ "messageId": "u1" })),
            chunk("agent_message_chunk", "a", json!({ "messageId": "u1" })),
            chunk("agent_message_chunk", "b", json!({ "messageId": "u1" })),
        ];
        let messages = transcript_messages(&events);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["id"], "u1");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["text"], "ab");
    }
}
