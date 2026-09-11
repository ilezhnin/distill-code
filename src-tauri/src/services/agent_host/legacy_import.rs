//! One-time import of chat history from the goose `sessions.db` that the
//! pre-host builds wrote. Every goose session becomes a host session with the
//! same id (so sidebar state, conductor graphs and unread markers keyed by
//! session id keep pointing at the right chat), and its messages become the
//! same `session/update` events the host records for live sessions, so replay
//! and search treat imported history exactly like native history.
//!
//! The import runs once per host database and records its outcome under
//! `kv(import, goose_sessions)`; deleting that row re-runs it (existing host
//! sessions are never overwritten).

use chrono::{DateTime, NaiveDateTime, SecondsFormat};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::harness;
use super::protocol::now_iso;
use super::store::{SessionRecord, SessionStore};

const KV_SCOPE: &str = "import";
const KV_KEY: &str = "goose_sessions";
const SNIPPET_MAX_CHARS: usize = 160;
/// The renderer used to hand a persona's system prompt to goose in-band as
/// plain user text. Live sessions mark that block assistant-only; imported
/// history gets the same annotation so it stays hidden.
const PERSONA_HANDOFF_PREFIX: &str =
    "You are operating under the following context and instructions for this ";

/// `<data dir>/Block/goose/data/sessions/sessions.db` on every platform goose
/// supported; goose derived it from the same `dirs::data_dir()`.
pub fn default_goose_sessions_db() -> Option<PathBuf> {
    Some(
        dirs::data_dir()?
            .join("Block")
            .join("goose")
            .join("data")
            .join("sessions")
            .join("sessions.db"),
    )
}

/// Import goose sessions into `store` unless a previous run already did.
/// Returns the number of sessions imported this run. Never fails startup:
/// callers only log the error.
pub async fn import_goose_sessions_once(store: &SessionStore) -> Result<usize, String> {
    if store.kv_get(KV_SCOPE, KV_KEY).await?.is_some() {
        return Ok(0);
    }
    let Some(db_path) = default_goose_sessions_db() else {
        return Ok(0);
    };
    let imported = if db_path.is_file() {
        import_from(store, &db_path).await?
    } else {
        0
    };
    store
        .kv_set(
            KV_SCOPE,
            KV_KEY,
            &json!({
                "importedSessions": imported,
                "source": db_path.to_string_lossy(),
                "at": now_iso(),
            }),
        )
        .await?;
    Ok(imported)
}

async fn import_from(store: &SessionStore, db_path: &Path) -> Result<usize, String> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .read_only(true);
    let pool: SqlitePool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| format!("failed to open {}: {error}", db_path.display()))?;

    let sessions = sqlx::query(
        "SELECT id, name, user_set_name, working_dir, created_at, updated_at, provider_name, \
         model_config_json, archived_at, project_id FROM sessions ORDER BY created_at",
    )
    .fetch_all(&pool)
    .await
    .map_err(|error| format!("failed to read goose sessions: {error}"))?;

    let mut imported = 0usize;
    for row in sessions {
        let id: String = row.try_get("id").unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        if store.get_session(&id).await?.is_some() {
            continue;
        }
        let messages = sqlx::query(
            "SELECT message_id, role, content_json, created_timestamp, metadata_json \
             FROM messages WHERE session_id = ? ORDER BY id",
        )
        .bind(&id)
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("failed to read goose messages for {id}: {error}"))?;

        let mut converter = Converter::new(&id);
        for message in &messages {
            converter.push(
                &message
                    .try_get::<String, _>("message_id")
                    .unwrap_or_default(),
                &message.try_get::<String, _>("role").unwrap_or_default(),
                &message
                    .try_get::<String, _>("content_json")
                    .unwrap_or_default(),
                message.try_get::<i64, _>("created_timestamp").unwrap_or(0),
                message
                    .try_get::<Option<String>, _>("metadata_json")
                    .ok()
                    .flatten()
                    .as_deref(),
            );
        }

        let name: String = row.try_get("name").unwrap_or_default();
        let user_set_name = row
            .try_get::<i64, _>("user_set_name")
            .map(|flag| flag != 0)
            .unwrap_or(false);
        if converter.visible_messages == 0 && !user_set_name {
            // goose kept every "New Chat" that was ever opened; nothing to show.
            continue;
        }

        let provider: String = row
            .try_get::<Option<String>, _>("provider_name")
            .ok()
            .flatten()
            .unwrap_or_default();
        let harness_id = if harness::harness(&provider).is_some() {
            provider
        } else {
            "claude-acp".to_string()
        };
        let model_id = row
            .try_get::<Option<String>, _>("model_config_json")
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|config| {
                config
                    .get("model_name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|model| !model.is_empty());
        let created_at = goose_timestamp(
            row.try_get::<Option<String>, _>("created_at")
                .ok()
                .flatten(),
        );
        let updated_at = goose_timestamp(
            row.try_get::<Option<String>, _>("updated_at")
                .ok()
                .flatten(),
        );
        let archived_at = row
            .try_get::<Option<String>, _>("archived_at")
            .ok()
            .flatten()
            .filter(|value| !value.is_empty())
            .map(|value| goose_timestamp(Some(value)));

        let record = SessionRecord {
            id: id.clone(),
            harness: harness_id,
            bridge_session_id: converter.provider_session_id.clone(),
            cwd: row.try_get("working_dir").unwrap_or_default(),
            title: Some(name).filter(|value| !value.trim().is_empty()),
            user_set_name,
            project_id: row
                .try_get::<Option<String>, _>("project_id")
                .ok()
                .flatten()
                .filter(|value| !value.is_empty()),
            persona_id: None,
            model_id,
            hidden: false,
            created_at,
            updated_at,
            last_message_at: converter.last_message_at.clone(),
            archived_at,
            message_count: converter.visible_messages,
            last_snippet: converter.last_snippet.clone(),
            snapshot: None,
        };
        store.import_session(&record, &converter.events).await?;
        imported += 1;
    }
    pool.close().await;
    Ok(imported)
}

/// Folds goose message rows into host session events. One goose "turn" starts
/// at a visible user message; every assistant row until the next one shares a
/// single host message id so the renderer shows one assistant bubble with its
/// thinking and tool calls, like a live turn.
struct Converter {
    session_id: String,
    events: Vec<(String, Value)>,
    visible_messages: i64,
    last_snippet: Option<String>,
    last_message_at: Option<String>,
    provider_session_id: Option<String>,
    run_id: Option<String>,
    assistant_message_id: Option<String>,
    /// Tool call id → the assistant message that issued it.
    tool_owner: HashMap<String, String>,
}

impl Converter {
    fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            events: Vec::new(),
            visible_messages: 0,
            last_snippet: None,
            last_message_at: None,
            provider_session_id: None,
            run_id: None,
            assistant_message_id: None,
            tool_owner: HashMap::new(),
        }
    }

    fn push(
        &mut self,
        message_id: &str,
        role: &str,
        content_json: &str,
        created_timestamp: i64,
        metadata_json: Option<&str>,
    ) {
        let metadata: Value = metadata_json
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or(Value::Null);
        if let Some(provider_session) = metadata
            .pointer("/inference/providerSessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.provider_session_id = Some(provider_session.to_string());
        }
        let user_visible = metadata
            .get("userVisible")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let steer = metadata
            .get("steer")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let blocks: Vec<Value> = serde_json::from_str(content_json).unwrap_or_default();
        let created = epoch_seconds_to_iso(created_timestamp);
        let message_id = if message_id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            message_id.to_string()
        };

        match role {
            "user" => {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if !user_visible {
                                // Turn context goose injected for the model only.
                                continue;
                            }
                            let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                            if text.trim().is_empty() {
                                continue;
                            }
                            self.start_turn(&message_id);
                            let mut distill = self.distill_meta(&message_id, &created);
                            if steer {
                                distill["steer"] = json!(true);
                            }
                            let assistant_only = text.starts_with(PERSONA_HANDOFF_PREFIX);
                            let mut content = json!({ "type": "text", "text": text });
                            if assistant_only {
                                content["annotations"] = json!({ "audience": ["assistant"] });
                            }
                            self.emit(
                                &created,
                                json!({
                                    "sessionUpdate": "user_message_chunk",
                                    "content": content,
                                    "_meta": { "distill": distill },
                                }),
                            );
                            if !assistant_only {
                                self.note_visible(text, &created);
                            }
                        }
                        Some("image") => {
                            if !user_visible {
                                continue;
                            }
                            let (Some(data), Some(mime)) = (
                                block.get("data").and_then(Value::as_str),
                                block.get("mimeType").and_then(Value::as_str),
                            ) else {
                                continue;
                            };
                            self.start_turn(&message_id);
                            let distill = self.distill_meta(&message_id, &created);
                            self.emit(
                                &created,
                                json!({
                                    "sessionUpdate": "user_message_chunk",
                                    "content": { "type": "image", "data": data, "mimeType": mime },
                                    "_meta": { "distill": distill },
                                }),
                            );
                            self.visible_messages += 1;
                            self.last_message_at = Some(created.clone());
                        }
                        Some("toolResponse") => self.push_tool_response(&block, &created),
                        _ => {}
                    }
                }
            }
            "assistant" => {
                if self.assistant_message_id.is_none() {
                    self.assistant_message_id = Some(message_id.clone());
                }
                let owner = self
                    .assistant_message_id
                    .clone()
                    .unwrap_or_else(|| message_id.clone());
                let mut has_text = false;
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                            if text.is_empty() {
                                continue;
                            }
                            has_text = true;
                            let distill = self.distill_meta(&owner, &created);
                            self.emit(
                                &created,
                                json!({
                                    "sessionUpdate": "agent_message_chunk",
                                    "content": { "type": "text", "text": text },
                                    "_meta": { "distill": distill },
                                }),
                            );
                            self.last_snippet = Some(snippet(text));
                        }
                        Some("thinking") => {
                            let text = block.get("thinking").and_then(Value::as_str).unwrap_or("");
                            if text.trim().is_empty() {
                                continue;
                            }
                            let distill = self.distill_meta(&owner, &created);
                            self.emit(
                                &created,
                                json!({
                                    "sessionUpdate": "agent_thought_chunk",
                                    "content": { "type": "text", "text": text },
                                    "_meta": { "distill": distill },
                                }),
                            );
                        }
                        Some("toolRequest") => self.push_tool_request(&block, &owner, &created),
                        _ => {}
                    }
                }
                if has_text {
                    self.visible_messages += 1;
                    self.last_message_at = Some(created.clone());
                }
            }
            _ => {}
        }
    }

    fn push_tool_request(&mut self, block: &Value, owner: &str, created: &str) {
        let Some(call_id) = block.get("id").and_then(Value::as_str) else {
            return;
        };
        let call = block.get("toolCall").cloned().unwrap_or(Value::Null);
        let failed = call.get("status").and_then(Value::as_str) == Some("error");
        let value = call.get("value").cloned().unwrap_or(Value::Null);
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let kind = block
            .pointer("/_meta/goose.acp.kind")
            .and_then(Value::as_str)
            .unwrap_or("other")
            .to_string();
        let mut update = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": call_id,
            "title": name,
            "kind": kind,
            "status": if failed { "failed" } else { "in_progress" },
            "_meta": { "distill": self.distill_meta(owner, created) },
        });
        if let Some(arguments) = value.get("arguments") {
            update["rawInput"] = arguments.clone();
        }
        if failed {
            if let Some(error) = call.get("error").and_then(Value::as_str) {
                update["content"] =
                    json!([{ "type": "content", "content": { "type": "text", "text": error } }]);
            }
        }
        self.tool_owner
            .insert(call_id.to_string(), owner.to_string());
        self.emit(created, update);
    }

    fn push_tool_response(&mut self, block: &Value, created: &str) {
        let Some(call_id) = block.get("id").and_then(Value::as_str) else {
            return;
        };
        let Some(owner) = self.tool_owner.get(call_id).cloned() else {
            return;
        };
        let result = block.get("toolResult").cloned().unwrap_or(Value::Null);
        let value = result.get("value").cloned().unwrap_or(Value::Null);
        let errored = result.get("status").and_then(Value::as_str) == Some("error")
            || value
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        let mut texts: Vec<String> = Vec::new();
        if let Some(items) = value.get("content").and_then(Value::as_array) {
            for item in items {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            texts.push(text.to_string());
                        }
                    }
                }
            }
        }
        if texts.is_empty() {
            if let Some(error) = result.get("error").and_then(Value::as_str) {
                texts.push(error.to_string());
            }
        }
        let content: Vec<Value> = texts
            .into_iter()
            .map(|text| json!({ "type": "content", "content": { "type": "text", "text": text } }))
            .collect();
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": call_id,
            "status": if errored { "failed" } else { "completed" },
            "content": content,
            "_meta": { "distill": self.distill_meta(&owner, created) },
        });
        self.emit(created, update);
    }

    fn start_turn(&mut self, user_message_id: &str) {
        self.run_id = Some(user_message_id.to_string());
        self.assistant_message_id = None;
    }

    fn note_visible(&mut self, text: &str, created: &str) {
        self.visible_messages += 1;
        self.last_message_at = Some(created.to_string());
        self.last_snippet = Some(snippet(text));
    }

    fn distill_meta(&self, message_id: &str, created: &str) -> Value {
        let mut meta = json!({
            "messageId": message_id,
            "created": created,
            "imported": "goose",
        });
        if let Some(run_id) = &self.run_id {
            meta["runId"] = json!(run_id);
        }
        meta
    }

    fn emit(&mut self, created: &str, update: Value) {
        self.events.push((
            created.to_string(),
            json!({ "sessionId": self.session_id, "update": update }),
        ));
    }
}

fn snippet(text: &str) -> String {
    let single_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single_line.chars().count() <= SNIPPET_MAX_CHARS {
        return single_line;
    }
    let mut cut: String = single_line.chars().take(SNIPPET_MAX_CHARS).collect();
    cut.push('…');
    cut
}

fn epoch_seconds_to_iso(seconds: i64) -> String {
    DateTime::from_timestamp(seconds, 0)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(now_iso)
}

/// goose wrote `YYYY-MM-DD HH:MM:SS` in UTC; anything else is passed through.
fn goose_timestamp(raw: Option<String>) -> String {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return now_iso();
    };
    NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S%.f"))
        .map(|naive| naive.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_a_goose_turn_into_one_assistant_message() {
        let mut converter = Converter::new("s1");
        converter.push(
            "u1",
            "user",
            r#"[{"type":"text","text":"<turn-context>x</turn-context>"}]"#,
            1_700_000_000,
            Some(r#"{"userVisible":false,"agentVisible":true,"turnContext":true}"#),
        );
        converter.push(
            "u2",
            "user",
            r#"[{"type":"text","text":"hello"}]"#,
            1_700_000_001,
            Some(r#"{"userVisible":true,"agentVisible":true,"inference":{"providerSessionId":"bridge-1"}}"#),
        );
        converter.push(
            "a1",
            "assistant",
            r#"[{"type":"thinking","thinking":"hmm","signature":""}]"#,
            1_700_000_002,
            Some(r#"{"userVisible":true,"agentVisible":false}"#),
        );
        converter.push(
            "a2",
            "assistant",
            r#"[{"type":"toolRequest","id":"call-1","toolCall":{"status":"success","value":{"name":"shell","arguments":{"command":"ls"}}},"_meta":{"goose.acp.kind":"execute"}}]"#,
            1_700_000_003,
            Some(r#"{"userVisible":true,"agentVisible":true}"#),
        );
        converter.push(
            "u3",
            "user",
            r#"[{"type":"toolResponse","id":"call-1","toolResult":{"status":"success","value":{"content":[{"type":"text","text":"a.txt"}],"isError":false}}}]"#,
            1_700_000_004,
            Some(r#"{"userVisible":true,"agentVisible":true}"#),
        );
        converter.push(
            "a3",
            "assistant",
            r#"[{"type":"text","text":"Done."}]"#,
            1_700_000_005,
            Some(r#"{"userVisible":true,"agentVisible":true}"#),
        );

        let kinds: Vec<&str> = converter
            .events
            .iter()
            .map(|(_, event)| event["update"]["sessionUpdate"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            [
                "user_message_chunk",
                "agent_thought_chunk",
                "tool_call",
                "tool_call_update",
                "agent_message_chunk",
            ]
        );
        let assistant_ids: Vec<&str> = converter.events[1..]
            .iter()
            .map(|(_, event)| {
                event["update"]["_meta"]["distill"]["messageId"]
                    .as_str()
                    .unwrap()
            })
            .collect();
        assert_eq!(assistant_ids, ["a1", "a1", "a1", "a1"]);
        assert_eq!(
            converter.events[0].1["update"]["_meta"]["distill"]["runId"],
            "u2"
        );
        assert_eq!(converter.events[3].1["update"]["status"], "completed");
        assert_eq!(converter.events[2].1["update"]["rawInput"]["command"], "ls");
        assert_eq!(converter.visible_messages, 2);
        assert_eq!(converter.last_snippet.as_deref(), Some("Done."));
        assert_eq!(converter.provider_session_id.as_deref(), Some("bridge-1"));
        assert_eq!(converter.events[0].0, "2023-11-14T22:13:21.000Z");
    }

    #[test]
    fn marks_in_band_persona_handoffs_assistant_only() {
        let mut converter = Converter::new("s2");
        converter.push(
            "u1",
            "user",
            r#"[{"type":"text","text":"You are operating under the following context and instructions for this session. Adopt them."}]"#,
            1_700_000_000,
            Some(r#"{"userVisible":true,"agentVisible":true}"#),
        );
        converter.push(
            "u2",
            "user",
            r#"[{"type":"text","text":"real question"}]"#,
            1_700_000_001,
            Some(r#"{"userVisible":true,"agentVisible":true}"#),
        );
        assert_eq!(
            converter.events[0].1["update"]["content"]["annotations"]["audience"],
            json!(["assistant"])
        );
        assert!(converter.events[1].1["update"]["content"]["annotations"].is_null());
        assert_eq!(converter.visible_messages, 1);
        assert_eq!(converter.last_snippet.as_deref(), Some("real question"));
    }

    #[test]
    fn converts_goose_session_timestamps_to_rfc3339() {
        assert_eq!(
            goose_timestamp(Some("2026-09-04 06:14:21".to_string())),
            "2026-09-04T06:14:21.000Z"
        );
        assert_eq!(goose_timestamp(Some("weird".to_string())), "weird");
    }
}
