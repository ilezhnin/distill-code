//! Host extension methods (`_distill/...`): everything the renderer needs
//! beyond core ACP — session metadata, defaults and preferences, MCP server
//! configuration, the harness inventory, and skill/agent/project sources.

use serde_json::{json, Value};
use std::sync::Arc;

use super::harness;
use super::protocol::{self, invalid_params};
use super::router::Inner;
use super::sources;
use super::store::{MessagePart, MessageSide, SessionStore};

fn session_id(params: &Value) -> Result<String, Value> {
    protocol::session_id(params).ok_or_else(|| invalid_params("sessionId required"))
}

/// The message an edit or a removal names: its id and whose it is.
fn message_target(params: &Value) -> Result<(String, MessageSide), Value> {
    let message_id = params
        .get("messageId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_params("messageId required"))?;
    let side = match params.get("role").and_then(Value::as_str) {
        Some("user") => MessageSide::User,
        Some("assistant") => MessageSide::Assistant,
        _ => return Err(invalid_params("role must be user or assistant")),
    };
    Ok((message_id.to_string(), side))
}

/// The step an edit or a removal names, when it names one.
fn message_part(params: &Value) -> Result<Option<MessagePart>, Value> {
    match params.get("part") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => MessagePart::from_json(value).map(Some).ok_or_else(|| {
            invalid_params(
                "part must name a text or reasoning run by ordinal, or a tool call by id",
            )
        }),
    }
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
            // The updates of a chat that is streaming right now may still be
            // waiting for their commit in the event loop; a transcript read has
            // to wait for them or it stops short of the live reply.
            host.drain_bridge_events().await;
            let events = host
                .store
                .list_events(&id)
                .await
                .map_err(protocol::internal)?;
            Ok(json!({ "messages": transcript_messages(&events) }))
        }
        "session/message/update" => {
            let id = session_id(&params)?;
            let (message_id, side) = message_target(&params)?;
            let part = message_part(&params)?;
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| invalid_params("text required"))?;
            // The chunks of a chat streaming right now may still be waiting
            // for their commit in the event loop; the rewrite reads the log,
            // so it has to wait for them or it edits a transcript missing its
            // tail. The message itself is settled: the renderer offers no
            // edit on a reply still being written.
            host.drain_bridge_events().await;
            let rewrite = host
                .store
                .rewrite_message_text(&id, side, &message_id, text, part.as_ref())
                .await
                .map_err(protocol::internal)?;
            if rewrite.chunks == 0 {
                return Err(invalid_params(format!(
                    "No text to edit in message {message_id} of session {id}"
                )));
            }
            // The list snippet quotes the last message with text; when that
            // is the one just edited, it quotes the edit — and only then, so
            // an edit further up never rewrites what the chat currently ends
            // on. The times stay: nothing new was said.
            if rewrite.was_last {
                let snippet = Inner::snippet(text);
                host.store
                    .set_last_snippet(&id, snippet.as_deref())
                    .await
                    .map_err(protocol::internal)?;
            }
            Ok(json!({ "chunks": rewrite.chunks, "lastMessage": rewrite.was_last }))
        }
        "session/message/remove" => {
            let id = session_id(&params)?;
            let (message_id, side) = message_target(&params)?;
            let part = message_part(&params)?.ok_or_else(|| invalid_params("part required"))?;
            // As for an edit: the log has to hold the whole turn first.
            host.drain_bridge_events().await;
            let removal = host
                .store
                .remove_message_part(&id, side, &message_id, &part)
                .await
                .map_err(protocol::internal)?;
            if removal.removed == 0 {
                return Err(invalid_params(format!(
                    "No such step in message {message_id} of session {id}"
                )));
            }
            // The step held the chat's last word: the list now quotes
            // whatever text the chat ends on, or nothing.
            let mut snippet = None;
            if removal.was_last {
                snippet = removal.last_text.as_deref().and_then(Inner::snippet);
                host.store
                    .set_last_snippet(&id, snippet.as_deref())
                    .await
                    .map_err(protocol::internal)?;
            }
            Ok(json!({
                "removed": removal.removed,
                "lastMessage": removal.was_last,
                "snippet": snippet,
            }))
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
                let cached = cached_inventory(host, spec.id).await;
                let models = harness::merge_inventory(spec.id, cached.models);
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
            let cached = cached_inventory(host, &provider_id).await;
            let serving = host.serving_executable(&provider_id).await;
            let (models, updated_at) = if cached.models.is_empty()
                || !inventory_is_current(cached.probed_on.as_ref(), &serving)
            {
                if !cached.models.is_empty() {
                    log::info!(
                        "[agent-host] {provider_id} is not the build its model list was read from; probing it again"
                    );
                }
                let (models, updated_at) = refresh_models(host, &provider_id).await?;
                (models, Some(updated_at))
            } else {
                (cached.models, cached.updated_at)
            };
            Ok(inventory_response(
                &provider_id,
                models,
                updated_at.as_deref(),
            ))
        }
        "providers/inventory/refresh" => {
            let provider_id = params
                .get("providerId")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("providerId required"))?
                .to_string();
            let (models, updated_at) = refresh_models(host, &provider_id).await?;
            Ok(inventory_response(&provider_id, models, Some(&updated_at)))
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

/// KV scope of each harness's probed model list. Renamed from
/// `harness_models` when a row grew the model's effort values and fast
/// support, as that one was renamed from `models` when rows gained a
/// `description`: a list is only re-probed while it is empty or while the
/// harness executable it was read from has changed, so rows cached without
/// the new fields would never have picked them up.
///
/// Each record carries `probedOn`, the [`super::bridge::executable_fingerprint`]
/// of the CLI build that listed the models. A CLI updated in place — Grok's
/// own updater, `npm install -g`, the doctor — serves new models the moment it
/// restarts, and without that stamp the list it replaced would have stayed
/// the inventory for as long as the install lived.
const MODELS_KV_SCOPE: &str = "harness_models_v2";

/// Shape of an inventory row. The renderer caches rows under this number and
/// drops anything else on load, so a build whose rows mean something new is
/// never read back through the old meaning. Bump it with the row shape.
///
/// 3: a row also says where it belongs and what it can do -- `group`,
/// `order`, `aliasOf`, `efforts`, `defaultEffort`, `supportsFast`,
/// `opensOnModel`, `capabilitySource` -- and the renderer now reads them.
/// Moved together with `MODEL_CACHE_SCHEMA_VERSION` in
/// `providerModelCacheStore.ts`, so a cache of rows without capabilities is
/// dropped rather than read back as models that have none.
const INVENTORY_SCHEMA_VERSION: u32 = 3;

/// Generation of the *content* the host serves, within one schema. Bumped
/// whenever the models Distill itself contributes change -- those are merged
/// in at request time and never touch the probe's `updatedAt`, so without this
/// a renderer holding a cached list has no way to notice them.
const SHAPE_REVISION: u32 = 3;

/// The answer every model-list endpoint returns.
///
/// The stamp is what makes a renderer-side cache self-correcting: a build's
/// rows are only read back by a build that shapes them the same way, and a
/// changed `revision` says the list was rebuilt without anyone having to time
/// it. What Distill declares about a harness's models is merged in here
/// rather than at each call site, because `providers/inventory/refresh` used
/// to answer without it -- the same list, one endpoint short.
fn inventory_response(harness_id: &str, models: Vec<Value>, updated_at: Option<&str>) -> Value {
    json!({
        "providerId": harness_id,
        "models": harness::merge_inventory(harness_id, models),
        "schemaVersion": INVENTORY_SCHEMA_VERSION,
        "revision": inventory_revision(updated_at),
    })
}

/// `<SHAPE_REVISION>:<probe updatedAt>`, e.g. `2:2026-09-13T20:03:09Z`. A
/// harness that has never been probed carries the empty half, and starts
/// carrying a timestamp the moment one lands.
fn inventory_revision(updated_at: Option<&str>) -> String {
    format!("{SHAPE_REVISION}:{}", updated_at.unwrap_or_default())
}

/// A harness's whole model list as the host knows it right now, for a caller
/// outside the model endpoints: the same rows `providers/supported_models/list`
/// answers, with no probe and no bridge. Empty until the harness has been
/// probed once, which is the honest answer to "what does it advertise".
pub(super) async fn known_models(store: &SessionStore, harness_id: &str) -> Vec<Value> {
    let probed = store
        .kv_get(MODELS_KV_SCOPE, harness_id)
        .await
        .ok()
        .flatten()
        .and_then(|record| record.get("models").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    harness::merge_inventory(harness_id, probed)
}

/// A harness's probed rows, when they were probed, and the executable of the
/// bridge that listed them (`None` on a record older than the stamp).
struct CachedInventory {
    models: Vec<Value>,
    updated_at: Option<String>,
    probed_on: Option<Value>,
}

impl CachedInventory {
    fn empty() -> Self {
        Self {
            models: Vec::new(),
            updated_at: None,
            probed_on: None,
        }
    }

    fn from_record(record: &Value) -> Self {
        Self {
            models: record
                .get("models")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            updated_at: record
                .get("updatedAt")
                .and_then(Value::as_str)
                .map(str::to_string),
            probed_on: record.get("probedOn").filter(|on| !on.is_null()).cloned(),
        }
    }
}

async fn cached_inventory(host: &Arc<Inner>, harness_id: &str) -> CachedInventory {
    host.store
        .kv_get(MODELS_KV_SCOPE, harness_id)
        .await
        .ok()
        .flatten()
        .as_ref()
        .map(CachedInventory::from_record)
        .unwrap_or_else(CachedInventory::empty)
}

/// Whether a cached list still describes what the harness serves: it was read
/// from the executable that answers for the harness now.
///
/// `serving` is `Null` where nothing answers — the harness is not installed
/// — and then the cache is all there is, so it stands. A record that predates
/// the stamp cannot say what it was read from, and is read again once.
fn inventory_is_current(probed_on: Option<&Value>, serving: &Value) -> bool {
    if serving.is_null() {
        return true;
    }
    probed_on.is_some_and(|on| on == serving)
}

async fn refresh_models(
    host: &Arc<Inner>,
    harness_id: &str,
) -> Result<(Vec<Value>, String), Value> {
    let (models, probed_on) = host.probe_models(harness_id).await?;
    let updated_at = protocol::now_iso();
    let value = inventory_record(&models, &updated_at, &probed_on);
    host.store
        .kv_set(MODELS_KV_SCOPE, harness_id, &value)
        .await
        .map_err(protocol::internal)?;
    Ok((models, updated_at))
}

/// The KV record a probe leaves behind; `CachedInventory::from_record` reads
/// it back.
fn inventory_record(models: &[Value], updated_at: &str, probed_on: &Value) -> Value {
    json!({ "models": models, "updatedAt": updated_at, "probedOn": probed_on })
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

    fn executable(modified: u64) -> Value {
        json!({ "path": "C:\\Users\\dev\\.grok\\bin\\grok.exe", "len": 153720832, "modified": modified })
    }

    #[test]
    fn a_list_read_from_another_build_of_the_cli_is_probed_again() {
        let probed_on = executable(1_757_800_000);
        // The same file answers: the list stands.
        assert!(inventory_is_current(Some(&probed_on), &probed_on));
        // The CLI was updated in place: same path, another file.
        assert!(!inventory_is_current(
            Some(&probed_on),
            &executable(1_758_400_000)
        ));
        // A record from before the stamp does not know what it was read
        // from, so it is read again once.
        assert!(!inventory_is_current(None, &probed_on));
    }

    #[test]
    fn a_harness_nothing_answers_for_keeps_the_list_it_has() {
        // Not installed any more: no probe could replace the list, and an
        // uninstall is not news about the models the CLI served.
        assert!(inventory_is_current(Some(&executable(1)), &Value::Null));
        assert!(inventory_is_current(None, &Value::Null));
    }

    #[test]
    fn a_probe_records_the_executable_it_read_the_list_from() {
        let record = inventory_record(
            &[json!({ "id": "grok-4.7", "name": "Grok 4.7" })],
            "2026-09-21T17:03:39Z",
            &executable(1_758_400_000),
        );
        let cached = CachedInventory::from_record(&record);
        assert_eq!(cached.models.len(), 1);
        assert_eq!(cached.updated_at.as_deref(), Some("2026-09-21T17:03:39Z"));
        assert_eq!(cached.probed_on, Some(executable(1_758_400_000)));
        assert!(inventory_is_current(
            cached.probed_on.as_ref(),
            &executable(1_758_400_000)
        ));
        // The record every install already holds, written before the stamp.
        let legacy = CachedInventory::from_record(
            &json!({ "models": [{ "id": "grok-4.6" }], "updatedAt": "2026-09-14T02:46:25Z" }),
        );
        assert_eq!(legacy.probed_on, None);
    }

    #[test]
    fn an_inventory_answer_says_which_shape_and_which_generation_it_is() {
        let answer = inventory_response(
            "codex-acp",
            vec![json!({ "id": "gpt-5.6-luna", "name": "GPT-5.6 Luna" })],
            Some("2026-09-13T20:03:09Z"),
        );
        assert_eq!(answer["providerId"], "codex-acp");
        assert_eq!(answer["schemaVersion"], INVENTORY_SCHEMA_VERSION);
        assert_eq!(
            answer["revision"],
            format!("{SHAPE_REVISION}:2026-09-13T20:03:09Z")
        );
        // A harness with no probe yet still answers a revision, so the
        // renderer sees it change the moment one lands.
        assert_eq!(
            inventory_response("codex-acp", Vec::new(), None)["revision"],
            format!("{SHAPE_REVISION}:")
        );
    }

    #[test]
    fn every_endpoint_lists_the_models_distill_adds_to_the_harness() {
        // `providers/inventory/refresh` answered without them until the merge
        // moved into the shared response builder.
        let answer = inventory_response(
            "claude-acp",
            vec![json!({
                "id": "opus[1m]",
                "name": "Opus (1M context)",
                "efforts": [{ "value": "high", "name": "High", "description": null }],
                "defaultEffort": null,
                "supportsFast": true,
                "capabilitySource": "probed",
            })],
            Some("2026-09-13T20:03:09Z"),
        );
        let models = answer["models"].as_array().expect("models");
        let ids: Vec<&str> = models
            .iter()
            .filter_map(|model| model["id"].as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "claude-fable-5-1[1m]",
                "opus[1m]",
                "claude-fable-5[1m]",
                "claude-opus-4-8",
                "claude-opus-4-7",
                "claude-opus-4-6",
                "claude-sonnet-4-6",
            ]
        );

        // Every row says what the model can do and where that came from, so
        // the picker can offer an effort before a session exists.
        let row = |id: &str| {
            models
                .iter()
                .find(|model| model["id"] == id)
                .cloned()
                .expect("row")
        };
        let bridge_listed = row("opus[1m]");
        assert_eq!(bridge_listed["capabilitySource"], "probed");
        assert_eq!(bridge_listed["supportsFast"], true);
        assert_eq!(bridge_listed["group"], "main");
        let opened_on = row("claude-sonnet-4-6");
        assert_eq!(opened_on["capabilitySource"], "declared");
        assert_eq!(opened_on["opensOnModel"], true);
        assert_eq!(opened_on["group"], "more");
        assert_eq!(
            opened_on["efforts"]
                .as_array()
                .expect("efforts")
                .iter()
                .filter_map(|value| value["value"].as_str())
                .collect::<Vec<_>>(),
            ["default", "low", "medium", "high", "max"]
        );
    }

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
