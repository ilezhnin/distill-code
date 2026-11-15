//! Host extension methods (`_flock/...`): everything the renderer needs
//! beyond core ACP — session metadata, defaults and preferences, MCP server
//! configuration, the harness inventory, and skill/agent/project sources.

use serde_json::{json, Value};
use std::sync::Arc;

use super::harness;
use super::protocol::{self, invalid_params};
use super::router::Inner;
use super::sources;
use super::store::{MessagePart, MessageSide, SessionStore};
use crate::services::provider_accounts::{self, ProviderAccount};

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
        "sessions/prepare_account" => {
            let id = session_id(&params)?;
            host.prepare_session_account(&id).await
        }
        "sessions/set_account" | "session/account/update" => {
            let id = session_id(&params)?;
            let account_id = params
                .get("accountId")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("accountId required"))?;
            host.set_session_account(&id, account_id).await
        }
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
            host.archive_session(&id).await?;
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
            host.update_working_dir(&id, cwd).await?;
            Ok(json!({}))
        }
        "session/computer_use/read" => {
            let id = session_id(&params)?;
            host.session_record(&id).await?;
            Ok(host.computer_use_state(&id).await)
        }
        "session/computer_use/update" => {
            let id = session_id(&params)?;
            let enabled = params
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| invalid_params("enabled must be true or false"))?;
            host.set_computer_use(&id, enabled).await
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
        "session/history" => {
            let id = session_id(&params)?;
            let before = params
                .get("beforeEventId")
                .and_then(Value::as_i64)
                .filter(|id| *id > 0)
                .ok_or_else(|| invalid_params("beforeEventId must be positive"))?;
            let page = host
                .store
                .history_page(&id, Some(before))
                .await
                .map_err(protocol::internal)?;
            serde_json::to_value(page).map_err(|e| protocol::internal(e.to_string()))
        }
        "session/history/result" => {
            let id = session_id(&params)?;
            let event_id = params
                .get("eventId")
                .and_then(Value::as_i64)
                .filter(|id| *id > 0)
                .ok_or_else(|| invalid_params("eventId must be positive"))?;
            host.store
                .history_event(&id, event_id)
                .await
                .map_err(protocol::internal)
        }
        "session/import_transcript" => {
            let id = session_id(&params)?;
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| invalid_params("text required"))?;
            if host.active_run_id(&id).await.is_some() {
                return Err(invalid_params(
                    "Stop the current turn before loading a chat into it",
                ));
            }
            host.drain_bridge_events().await?;
            if host.active_run_id(&id).await.is_some() {
                return Err(invalid_params(
                    "Stop the current turn before loading a chat into it",
                ));
            }
            super::transcript_import::apply(&host.store, &id, text)
                .await
                .map_err(invalid_params)
        }
        "session/messages" => {
            let id = session_id(&params)?;
            // The updates of a chat that is streaming right now may still be
            // waiting for their commit in the event loop; a transcript read has
            // to wait for them or it stops short of the live reply.
            host.drain_bridge_events().await?;
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
            host.drain_bridge_events().await?;
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
                let snippet = super::store::message_snippet(text);
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
            let part = message_part(&params)?;
            host.remove_transcript_message(&id, side, &message_id, part.as_ref())
                .await
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
                .map(|record| json!({ "configurationRevision": crate::commands::local_mcp_inventory::configuration_revision(&record.config.to_string()), "extension": record.config, "enabled": record.enabled, "configKey": record.config_key }))
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
                let account_id = host.resolve_account_id(spec.id, None).ok().flatten();
                let cached = cached_inventory(host, spec.id, account_id.as_deref()).await;
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
            let account_id = host.resolve_account_id(
                &provider_id,
                params.get("accountId").and_then(Value::as_str),
            )?;
            chat_model_inventory(host, &provider_id, account_id.as_deref(), false).await
        }
        "providers/inventory/refresh" => {
            let provider_id = params
                .get("providerId")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid_params("providerId required"))?
                .to_string();
            let account_id = host.resolve_account_id(
                &provider_id,
                params.get("accountId").and_then(Value::as_str),
            )?;
            chat_model_inventory(host, &provider_id, account_id.as_deref(), true).await
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
/// whenever the models Flock itself contributes change -- those are merged
/// in at request time and never touch the probe's `updatedAt`, so without this
/// a renderer holding a cached list has no way to notice them.
const SHAPE_REVISION: u32 = 13;

/// One account catalogue for chats and benchmark candidates. Runtime probes
/// validate this list; they do not own a second list of model identities.
pub(super) async fn model_inventory(
    host: &Arc<Inner>,
    provider: &str,
    account: Option<&str>,
    refresh: bool,
) -> Result<Value, Value> {
    let lock = host
        .owned_lock(&format!(
            "model-catalog:{}",
            super::router::account_route_key(provider, account)
        ))
        .await;
    let _guard = lock.lock().await;
    let cached = cached_inventory(host, provider, account).await;
    let serving = host.serving_executable(provider, account).await;
    let (models, updated_at) = if refresh
        || cached.models.is_empty()
        || !inventory_is_fresh(&cached, &serving, chrono::Utc::now().timestamp())
        || (provider == "kimi-acp"
            && cached
                .models
                .iter()
                .any(|row| row.get("contextLimit").is_none()))
    {
        let (models, updated_at) = refresh_models(host, provider, account).await?;
        (models, Some(updated_at))
    } else {
        (cached.models, cached.updated_at)
    };
    let mut response = inventory_response(provider, models, updated_at.as_deref());
    response["accountId"] = json!(account);
    Ok(response)
}

/// How old another account's cached list may be before it is read again
/// behind a request for this one's.
const POOL_INVENTORY_MAX_AGE_SECS: i64 = 3600;

/// The catalogue a chat picks its model from: `account`'s own models and,
/// among them, the models the provider's other accounts serve that this one
/// does not, each naming the account that serves it (`accountId`). A model
/// granted to one account is thus offered in every chat of the provider;
/// choosing it moves the chat to that account (`Inner::account_for_model`).
/// A benchmark candidate runs on one account, so it reads `model_inventory`.
pub(super) async fn chat_model_inventory(
    host: &Arc<Inner>,
    provider: &str,
    account: Option<&str>,
    refresh: bool,
) -> Result<Value, Value> {
    let mut response = model_inventory(host, provider, account, refresh).await?;
    let Some(account) = account else {
        return Ok(response);
    };
    let now = chrono::Utc::now().timestamp();
    let mut others = Vec::new();
    for other in pool_accounts(&host.app, provider, account).await {
        let cached = cached_inventory(host, provider, Some(&other.id)).await;
        let current = cached
            .updated_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .is_some_and(|read| {
                (0..POOL_INVENTORY_MAX_AGE_SECS).contains(&(now - read.timestamp()))
            });
        if cached.models.is_empty() || !current {
            // Never on this request's time: the next one reads the result.
            let (host, provider) = (Arc::clone(host), provider.to_string());
            let other = other.id.clone();
            tokio::spawn(async move {
                if model_inventory(&host, &provider, Some(&other), false)
                    .await
                    .is_err()
                {
                    log::info!(
                        "[agent-host] the models of {provider} account {other} were not read"
                    );
                }
            });
        }
        others.push((other.id, cached.models));
    }
    if let Some(rows) = response["models"].as_array_mut() {
        add_pool_rows(provider, rows, others);
    }
    Ok(response)
}

/// Files the rows other accounts list and this one does not among `rows`,
/// in menu order, each under the first account that lists it.
fn add_pool_rows(harness_id: &str, rows: &mut Vec<Value>, others: Vec<(String, Vec<Value>)>) {
    for (account_id, probed) in others {
        if probed.is_empty() {
            continue;
        }
        for mut row in harness::merge_inventory(harness_id, probed) {
            if rows.iter().any(|known| known["id"] == row["id"]) {
                continue;
            }
            row["accountId"] = json!(account_id);
            rows.push(row);
        }
    }
    rows.sort_by_key(|row| row["order"].as_u64().unwrap_or(u64::MAX));
}

/// The provider's other enabled, signed-in accounts billed the way
/// `account_id` is, its default first: the accounts a chat on `account_id`
/// can be moved to. A signed-out account is none of them: nothing reads its
/// models or weighs it as a spare.
pub(super) async fn pool_accounts(
    app: &tauri::AppHandle,
    harness_id: &str,
    account_id: &str,
) -> Vec<ProviderAccount> {
    let Ok(registry) = provider_accounts::snapshot(app) else {
        return Vec::new();
    };
    let mut pool = Vec::new();
    for account in pool_of(
        registry.accounts,
        registry.defaults.get(harness_id).map(String::as_str),
        harness_id,
        account_id,
    ) {
        if crate::services::provider_account_status::signed_in(app, &account).await {
            pool.push(account);
        }
    }
    pool
}

fn pool_of(
    accounts: Vec<ProviderAccount>,
    default: Option<&str>,
    harness_id: &str,
    account_id: &str,
) -> Vec<ProviderAccount> {
    let Some(billing) = accounts
        .iter()
        .find(|account| account.id == account_id && account.provider_id == harness_id)
        .map(|account| account.auth_method)
    else {
        return Vec::new();
    };
    let mut others: Vec<_> = accounts
        .into_iter()
        .filter(|account| {
            account.id != account_id
                && account.enabled
                && account.provider_id == harness_id
                && account.auth_method == billing
        })
        .collect();
    others.sort_by_key(|account| Some(account.id.as_str()) != default);
    others
}

/// Whether `account_id`'s own model list names `model_id`; `None` while the
/// account has never been probed, which says nothing either way.
pub(super) async fn account_lists_model(
    host: &Arc<Inner>,
    harness_id: &str,
    account_id: &str,
    model_id: &str,
) -> Option<bool> {
    let cached = cached_inventory(host, harness_id, Some(account_id)).await;
    (!cached.models.is_empty()).then(|| {
        harness::merge_inventory(harness_id, cached.models)
            .iter()
            .any(|row| row["id"] == model_id)
    })
}

/// The account catalogue owns model identities and capabilities for every
/// consumer. The isolated runtime adds readiness only; its short menu is not
/// another catalogue. Some harness models are selected when opening a session
/// and intentionally never appear in that menu.
pub(super) fn benchmark_models(catalog: &Value, runtime: &[Value]) -> Vec<Value> {
    let spec = catalog["providerId"].as_str().and_then(harness::harness);
    catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|model| {
            let mut row = model.clone();
            let listed = runtime.iter().any(|candidate| candidate["id"] == model["id"]);
            let opens_on_model = !runtime.is_empty()
                && spec.zip(model["id"].as_str()).is_some_and(|(spec, id)| {
                    harness::session_model_meta(spec, id).is_some()
                });
            if !listed && !opens_on_model {
                row["unavailable"] = json!("The installed benchmark runtime cannot select this model. Refresh or update its runtime.");
            }
            row
        })
        .collect()
}

/// The answer every model-list endpoint returns.
///
/// The stamp is what makes a renderer-side cache self-correcting: a build's
/// rows are only read back by a build that shapes them the same way, and a
/// changed `revision` says the list was rebuilt without anyone having to time
/// it. What Flock declares about a harness's models is merged in here
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
pub(super) async fn known_models(
    store: &SessionStore,
    harness_id: &str,
    account_id: Option<&str>,
) -> Vec<Value> {
    let probed = store
        .kv_get(
            MODELS_KV_SCOPE,
            &super::router::account_route_key(harness_id, account_id),
        )
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

async fn cached_inventory(
    host: &Arc<Inner>,
    harness_id: &str,
    account_id: Option<&str>,
) -> CachedInventory {
    host.store
        .kv_get(
            MODELS_KV_SCOPE,
            &super::router::account_route_key(harness_id, account_id),
        )
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

/// Model availability is also account/server state: a new model can roll out
/// without changing the CLI binary. Keep offline inventories, but never let an
/// installed harness's disk cache turn a renderer refresh into an eternal hit.
fn inventory_is_fresh(cached: &CachedInventory, serving: &Value, now: i64) -> bool {
    if serving.is_null() {
        return true;
    }
    if !inventory_is_current(cached.probed_on.as_ref(), serving) {
        return false;
    }
    cached
        .updated_at
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|updated| (0..300).contains(&(now - updated.timestamp())))
}

async fn refresh_models(
    host: &Arc<Inner>,
    harness_id: &str,
    account_id: Option<&str>,
) -> Result<(Vec<Value>, String), Value> {
    let (mut models, probed_on) = host.probe_models(harness_id, account_id).await?;
    add_granted_models(host, harness_id, account_id, &mut models).await;
    let updated_at = protocol::now_iso();
    let value = inventory_record(&models, &updated_at, &probed_on);
    host.store
        .kv_set(
            MODELS_KV_SCOPE,
            &super::router::account_route_key(harness_id, account_id),
            &value,
        )
        .await
        .map_err(protocol::internal)?;
    Ok((models, updated_at))
}

/// Adds the models the provider serves this account alone to its probed
/// list. The harness's own menu never names them (Claude Code leaves Mythos
/// out), so they are read from the provider's model list for the account;
/// `harness::merge_inventory` offers a granted-only lane only where such a
/// row stands. A read that fails says nothing about the grant, so the rows
/// the last read found are kept.
async fn add_granted_models(
    host: &Arc<Inner>,
    harness_id: &str,
    account_id: Option<&str>,
    models: &mut Vec<Value>,
) {
    let wanted = harness::granted_only_models(harness_id);
    let Some(account_id) = account_id.filter(|_| !wanted.is_empty()) else {
        return;
    };
    let granted = match crate::services::provider_account_status::account_models(
        &host.app, account_id,
    )
    .await
    {
        Ok(listed) => granted_rows(&wanted, &listed),
        Err(error) => {
            log::warn!(
                    "[agent-host] the models the provider grants account {account_id} were not read: {error}"
                );
            cached_inventory(host, harness_id, Some(account_id))
                .await
                .models
                .into_iter()
                .filter(|row| row["granted"] == true)
                .collect()
        }
    };
    for row in granted {
        if !models.iter().any(|model| model["id"] == row["id"]) {
            models.push(row);
        }
    }
}

/// The probed rows for the granted-only models an account's own list names.
/// Nothing was selected on them, so what they can do stays unknown here and
/// is declared by their lanes.
fn granted_rows(wanted: &[&str], listed: &[(String, Option<String>)]) -> Vec<Value> {
    wanted
        .iter()
        .filter_map(|id| {
            let (_, name) = listed.iter().find(|(listed, _)| listed == id)?;
            Some(json!({
                "id": id,
                "name": name.as_deref().unwrap_or(id),
                "description": Value::Null,
                "capabilitySource": "unknown",
                "granted": true,
            }))
        })
        .collect()
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

    #[test]
    fn benchmarks_use_shared_models_and_keep_runtime_support_separate() {
        let catalog = json!({"models":[
            {"id":"future","name":"Current name","contextLimit":1048576,"efforts":[{"value":"max"}]},
            {"id":"new","name":"New release","contextLimit":2000000}
        ]});
        let runtime = vec![
            json!({"id":"future","name":"Old name","efforts":[{"value":"low"}],"supportsFast":false,"capabilitySource":"probed"}),
            json!({"id":"retired","name":"Retired model"}),
        ];
        let rows = benchmark_models(&catalog, &runtime);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["name"], "Current name");
        assert_eq!(rows[0]["contextLimit"], 1048576);
        // A Linux menu must not replace the shared catalogue's capabilities.
        assert_eq!(rows[0], catalog["models"][0]);
        assert!(rows[0].get("unavailable").is_none());
        assert_eq!(rows[1]["id"], "new");
        assert!(rows[1]["unavailable"].is_string());
        let refreshed =
            benchmark_models(&catalog, &[json!({"id":"new","capabilitySource":"probed"})]);
        assert!(refreshed[1].get("unavailable").is_none());
    }

    #[test]
    fn benchmarks_use_the_shared_session_open_route_for_unlisted_claude_models() {
        let runtime = vec![json!({"id":"sonnet","efforts":[{"value":"high"}]})];
        let catalog = inventory_response("claude-acp", runtime.clone(), None);
        let rows = benchmark_models(&catalog, &runtime);
        let sonnet = rows
            .iter()
            .find(|row| row["id"] == "claude-sonnet-4-6")
            .unwrap();
        let shared = catalog["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == sonnet["id"])
            .unwrap();
        assert_eq!(sonnet, shared);
        assert!(sonnet.get("unavailable").is_none());
        assert_eq!(sonnet["opensOnModel"], true);

        // A catalogue flag cannot invent a route, and a failed runtime probe
        // cannot establish readiness even for a declared session-open model.
        let unknown = json!({"providerId":"claude-acp","models":[
            {"id":"unrecognized-model","opensOnModel":true}
        ]});
        assert!(benchmark_models(&unknown, &runtime)[0]["unavailable"].is_string());
        assert!(benchmark_models(&catalog, &[])
            .iter()
            .all(|row| row["unavailable"].is_string()));
    }

    fn executable(modified: u64) -> Value {
        json!({ "path": "C:\\Users\\dev\\.grok\\bin\\grok.exe", "len": 153720832, "modified": modified })
    }

    #[test]
    fn account_model_rollouts_expire_even_with_the_same_executable() {
        let serving = executable(1);
        let record = inventory_record(
            &[json!({"id": "grok-4.7"})],
            "2026-09-22T12:00:00Z",
            &serving,
        );
        let cached = CachedInventory::from_record(&record);
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-22T12:00:00Z")
            .unwrap()
            .timestamp();
        assert!(inventory_is_fresh(&cached, &serving, now + 299));
        assert!(!inventory_is_fresh(&cached, &serving, now + 300));
        assert!(!inventory_is_fresh(&cached, &serving, now - 1));
        assert!(!inventory_is_fresh(
            &CachedInventory::empty(),
            &serving,
            now
        ));
        assert!(inventory_is_fresh(&cached, &Value::Null, now + 86400));
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
    fn a_chats_catalogue_adds_what_the_providers_other_accounts_list() {
        let probed = |ids: &[&str]| -> Vec<Value> {
            ids.iter()
                .map(|id| json!({ "id": id, "name": id }))
                .collect()
        };
        // The chat's account lists no Mythos; another account of the provider
        // does, and a third was never probed.
        let own = inventory_response("claude-acp", probed(&["sonnet", "haiku"]), None);
        let mut rows = own["models"].as_array().unwrap().clone();
        let own_ids: Vec<Value> = rows.iter().map(|row| row["id"].clone()).collect();
        add_pool_rows(
            "claude-acp",
            &mut rows,
            vec![
                ("never-probed".into(), Vec::new()),
                (
                    "granted".into(),
                    probed(&["sonnet", "haiku", "claude-mythos-5-2"]),
                ),
                (
                    "granted-too".into(),
                    probed(&["sonnet", "claude-mythos-5-2", "claude-mythos-5-1"]),
                ),
            ],
        );
        let added: Vec<(&str, &str)> = rows
            .iter()
            .filter(|row| !own_ids.contains(&row["id"]))
            .map(|row| {
                (
                    row["id"].as_str().unwrap(),
                    row["accountId"].as_str().unwrap(),
                )
            })
            .collect();
        // Each under the first account that lists it, in menu order.
        assert_eq!(
            added,
            [
                ("claude-mythos-5-2[1m]", "granted"),
                ("claude-mythos-5-2", "granted"),
                ("claude-mythos-5-1[1m]", "granted-too"),
                ("claude-mythos-5-1", "granted-too"),
            ]
        );
        // The account's own rows name no account and keep their places.
        assert!(rows
            .iter()
            .filter(|row| own_ids.contains(&row["id"]))
            .all(|row| row.get("accountId").is_none()));
        let orders: Vec<u64> = rows
            .iter()
            .map(|row| row["order"].as_u64().unwrap())
            .collect();
        assert!(orders.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn a_chat_moves_only_among_the_providers_enabled_accounts_billed_the_same() {
        let account = |id: &str, provider: &str, auth, enabled| ProviderAccount {
            id: id.into(),
            provider_id: provider.into(),
            label: id.into(),
            auth_method: auth,
            enabled,
            auto_switch: true,
            created_at: 0,
            updated_at: 0,
        };
        use provider_accounts::AuthMethod::{ApiKey, OAuth};
        let accounts = vec![
            account("chat", "claude-acp", OAuth, true),
            account("spare", "claude-acp", OAuth, true),
            account("default", "claude-acp", OAuth, true),
            account("off", "claude-acp", OAuth, false),
            account("metered", "claude-acp", ApiKey, true),
            account("codex", "codex-acp", OAuth, true),
        ];
        let ids = |pool: Vec<ProviderAccount>| -> Vec<String> {
            pool.into_iter().map(|account| account.id).collect()
        };
        // The provider's default goes first; a subscription chat never moves
        // to a metered key, a disabled account or another provider.
        assert_eq!(
            ids(pool_of(
                accounts.clone(),
                Some("default"),
                "claude-acp",
                "chat"
            )),
            ["default", "spare"]
        );
        assert_eq!(
            ids(pool_of(accounts.clone(), None, "claude-acp", "metered")),
            Vec::<String>::new()
        );
        // An account Flock does not store has no pool.
        assert!(pool_of(accounts, None, "claude-acp", "cli-login-claude").is_empty());
    }

    #[test]
    fn an_account_gets_the_granted_models_its_own_list_names_and_no_others() {
        let wanted = harness::granted_only_models("claude-acp");
        let listed = |ids: &[&str]| -> Vec<(String, Option<String>)> {
            ids.iter()
                .map(|id| (id.to_string(), Some(format!("Claude {id}"))))
                .collect()
        };
        // The provider's whole list: only the granted-only models become rows,
        // the rest are the harness menu's to list.
        let rows = granted_rows(
            &wanted,
            &listed(&["claude-mythos-5-2", "claude-fable-5-2", "claude-opus-5-5"]),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "claude-mythos-5-2");
        assert_eq!(rows[0]["name"], "Claude claude-mythos-5-2");
        assert_eq!(rows[0]["granted"], true);
        assert!(granted_rows(&wanted, &listed(&["claude-fable-5-2"])).is_empty());
        // The catalogue of the account that was granted it offers the lane…
        let mut probed = vec![json!({ "id": "sonnet", "name": "Sonnet" })];
        probed.extend(rows);
        let answer = inventory_response("claude-acp", probed, None);
        let ids = |answer: &Value| -> Vec<String> {
            answer["models"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|model| model["id"].as_str().map(str::to_owned))
                .collect()
        };
        assert!(ids(&answer).contains(&"claude-mythos-5-2[1m]".to_string()));
        assert!(!ids(&answer).contains(&"claude-mythos-5-1[1m]".to_string()));
        // …and the catalogue of an account that was not offers none.
        let plain = inventory_response(
            "claude-acp",
            vec![json!({ "id": "sonnet", "name": "Sonnet" })],
            None,
        );
        assert!(ids(&plain).iter().all(|id| !id.contains("mythos")));
    }

    #[test]
    fn every_endpoint_lists_the_models_flock_adds_to_the_harness() {
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
                "claude-fable-5-2[1m]",
                "opus[1m]",
                "claude-fable-5-1[1m]",
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
