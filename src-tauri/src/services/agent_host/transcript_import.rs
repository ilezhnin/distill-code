//! Load an exported chat into a session that already exists.
//!
//! The file becomes the same `session/update` events a live turn records, so
//! replay, search and the chat window treat the loaded messages as native.
//! They are appended after whatever the session already has. The next prompt
//! is handed the loaded text once, as a block only the agent sees.

use serde_json::{json, Value};
use uuid::Uuid;

use super::protocol::now_iso;
use super::store::SessionStore;

pub const HANDOFF_SCOPE: &str = "import-handoff";
const HANDOFF_BUDGET_CHARS: usize = 120_000;
const SNIPPET_MAX_CHARS: usize = 160;

#[derive(Debug)]
pub struct LoadedChat {
    pub events: Vec<Value>,
    pub visible_messages: i64,
    pub last_snippet: Option<String>,
    pub title: Option<String>,
    pub handoff: String,
}

/// Parse an export and append it to `session_id`. A parse failure writes
/// nothing. Returns the number of visible messages appended.
pub async fn apply(store: &SessionStore, session_id: &str, text: &str) -> Result<Value, String> {
    let loaded = parse_export(text)?;
    let record = store
        .get_session(session_id)
        .await?
        .ok_or_else(|| format!("session {session_id} is gone"))?;
    if record.archived_at.is_some() {
        return Err("Unarchive the chat before loading into it".into());
    }
    if loaded.events.is_empty() {
        return Err("The file has no messages".into());
    }
    let events: Vec<Value> = loaded
        .events
        .into_iter()
        .map(|mut event| {
            event["sessionId"] = json!(session_id);
            event
        })
        .collect();
    store.append_events(session_id, &events).await?;
    store
        .touch(
            session_id,
            loaded.visible_messages,
            loaded.last_snippet.as_deref(),
        )
        .await?;
    if let Some(title) = loaded.title.as_deref() {
        store.set_title_if_untitled(session_id, title).await?;
    }
    remember_handoff(store, session_id, &loaded.handoff).await?;
    let titled = store
        .get_session(session_id)
        .await?
        .and_then(|session| session.title);
    Ok(json!({
        "messageCount": loaded.visible_messages,
        "lastSnippet": loaded.last_snippet,
        "title": titled.or(loaded.title),
    }))
}

pub async fn remember_handoff(
    store: &SessionStore,
    session_id: &str,
    text: &str,
) -> Result<(), String> {
    let previous = store
        .kv_get(HANDOFF_SCOPE, session_id)
        .await?
        .and_then(|value| {
            value
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let combined = match previous {
        Some(previous) if !previous.trim().is_empty() => format!("{previous}\n\n{text}"),
        _ => text.to_string(),
    };
    store
        .kv_set(
            HANDOFF_SCOPE,
            session_id,
            &json!({ "text": cap_tail(&combined, HANDOFF_BUDGET_CHARS) }),
        )
        .await
}

pub fn parse_export(text: &str) -> Result<LoadedChat, String> {
    let body = json_body(text)?;
    let document: Value = serde_json::from_str(body)
        .map_err(|error| format!("The file is not valid JSON ({error})"))?;
    let document = flatten_parts(&document)?;
    let title = document
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let source = document
        .get("source")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("export");
    let messages = document
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "The file has no messages array".to_string())?;

    let mut events = Vec::new();
    let mut visible_messages = 0i64;
    let mut last_snippet = None;
    let mut handoff_parts: Vec<String> = Vec::new();
    let session_stamp = "loaded";

    for (index, message) in messages.iter().enumerate() {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Message {index} has no role"))?;
        let created = message
            .get("createdAt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(now_iso);
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        match role {
            "user" => {
                let text = message.get("text").and_then(Value::as_str).unwrap_or("");
                if text.trim().is_empty() {
                    continue;
                }
                events.push(user_event(session_stamp, &id, &created, text, source));
                visible_messages += 1;
                last_snippet = Some(snippet(text));
                handoff_parts.push(format!("## User\n\n{text}"));
            }
            "assistant" => {
                let text = message.get("text").and_then(Value::as_str).unwrap_or("");
                let thinking = message
                    .get("thinking")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty());
                let steps = message
                    .get("steps")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if text.trim().is_empty() && thinking.is_none() && steps.is_empty() {
                    continue;
                }
                let reply_id = format!("{id}:reply");
                let mut reply = String::new();
                if let Some(thinking) = thinking {
                    events.push(thought_event(
                        session_stamp,
                        &id,
                        &reply_id,
                        &created,
                        thinking,
                        source,
                    ));
                    reply.push_str(&format!("thinking:\n{thinking}\n\n"));
                }
                for (step_index, step) in steps.iter().enumerate() {
                    let call_id = step
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("{id}:step:{step_index}"));
                    let name = step
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("tool");
                    let status = step_status(step, index, step_index)?;
                    let input = step_input(step.get("input"));
                    let output = step_output(step.get("output"));
                    let error = step
                        .get("error")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty());
                    events.push(tool_call_event(
                        session_stamp,
                        &id,
                        &reply_id,
                        &created,
                        &call_id,
                        name,
                        &input,
                        source,
                    ));
                    let shown = if status == "failed" {
                        error.unwrap_or(output.as_str()).to_string()
                    } else {
                        output.clone()
                    };
                    events.push(tool_result_event(
                        session_stamp,
                        &id,
                        &reply_id,
                        &created,
                        &call_id,
                        status,
                        &shown,
                        source,
                    ));
                    reply.push_str(&format!("[tool {name}]\n{shown}\n\n"));
                }
                if !text.is_empty() {
                    events.push(assistant_event(
                        session_stamp,
                        &id,
                        &reply_id,
                        &created,
                        text,
                        source,
                    ));
                    reply.push_str(text);
                    last_snippet = Some(snippet(text));
                } else if last_snippet.is_none() {
                    last_snippet = Some(snippet(&reply));
                }
                visible_messages += 1;
                let reply = reply.trim();
                if !reply.is_empty() {
                    handoff_parts.push(format!("## Assistant\n\n{reply}"));
                }
            }
            other => {
                return Err(format!(
                    "Message {index} has role \"{other}\"; expected user or assistant"
                ));
            }
        }
    }

    if events.is_empty() {
        return Err("The file has no messages".into());
    }
    let mut handoff = format!(
        "A chat exported from {source} was loaded into this conversation. \
         It is part of the chat you are in. The user's next message follows it. \
         Do not answer the transcript itself and do not mention the load unless it matters.\n\n\
         <loaded_chat>\n{}\n</loaded_chat>",
        handoff_parts.join("\n\n")
    );
    handoff = cap_tail(&handoff, HANDOFF_BUDGET_CHARS);
    Ok(LoadedChat {
        events,
        visible_messages,
        last_snippet,
        title,
        handoff,
    })
}

fn flatten_parts(document: &Value) -> Result<Value, String> {
    if let Some(parts) = document.as_array() {
        return merge_parts(parts);
    }
    match (
        document.get("part").and_then(Value::as_i64),
        document.get("parts").and_then(Value::as_i64),
    ) {
        (Some(part), Some(total)) if total > 1 => Err(format!(
            "This file is part {part} of {total}. Load one file that contains the whole chat"
        )),
        _ => Ok(document.clone()),
    }
}

fn merge_parts(parts: &[Value]) -> Result<Value, String> {
    if parts.is_empty() {
        return Err("The file has no messages".into());
    }
    let mut indexed: Vec<(i64, &Value)> = Vec::new();
    let mut total = None;
    for part in parts {
        let index = part
            .get("part")
            .and_then(Value::as_i64)
            .ok_or_else(|| "A multi-part export needs part and parts on every part".to_string())?;
        let parts_total = part
            .get("parts")
            .and_then(Value::as_i64)
            .ok_or_else(|| "A multi-part export needs part and parts on every part".to_string())?;
        if total.unwrap_or(parts_total) != parts_total {
            return Err("The parts disagree on how many parts the chat has".into());
        }
        total = Some(parts_total);
        indexed.push((index, part));
    }
    let total = total.unwrap_or(0);
    if total != indexed.len() as i64 {
        return Err(format!(
            "The file has {} of {total} parts. Load the whole chat",
            indexed.len()
        ));
    }
    indexed.sort_by_key(|(index, _)| *index);
    for (expected, (index, _)) in indexed.iter().enumerate() {
        if *index != expected as i64 + 1 {
            return Err(
                "The parts are not numbered 1..N. Load one file that contains the whole chat"
                    .into(),
            );
        }
    }
    let mut messages = Vec::new();
    for (_, part) in &indexed {
        let Some(batch) = part.get("messages").and_then(Value::as_array) else {
            return Err("A part has no messages array".into());
        };
        messages.extend(batch.clone());
    }
    let first = indexed[0].1;
    Ok(json!({
        "title": first.get("title"),
        "source": first.get("source"),
        "messages": messages,
    }))
}

fn json_body(text: &str) -> Result<&str, String> {
    let trimmed = text.trim().trim_start_matches('\u{feff}').trim();
    // A JSON string can itself contain Markdown fences. Only strip an outer
    // response fence when the file is not already a JSON document.
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return Ok(trimmed);
    }
    let fenced = extract_fence(trimmed).unwrap_or(trimmed).trim();
    if fenced.starts_with('{') || fenced.starts_with('[') {
        return Ok(fenced);
    }
    Err("The file is not a chat export. Expected a JSON object.".into())
}

fn extract_fence(text: &str) -> Option<&str> {
    let start = text.find("```")?;
    let after = &text[start + 3..];
    let after = after
        .strip_prefix("json")
        .or_else(|| after.strip_prefix("JSON"))
        .unwrap_or(after);
    let after = after.trim_start_matches(['\r', '\n']);
    let end = after.rfind("```")?;
    Some(&after[..end])
}

fn step_status(
    step: &Value,
    message_index: usize,
    step_index: usize,
) -> Result<&'static str, String> {
    match step.get("status").and_then(Value::as_str) {
        None => Ok("completed"),
        Some("completed") => Ok("completed"),
        Some("failed") => Ok("failed"),
        Some("in_progress") => Ok("in_progress"),
        Some(other) => Err(format!(
            "Message {message_index} step {step_index} has status \"{other}\"; expected completed, failed or in_progress"
        )),
    }
}

fn step_input(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => json!({}),
        Some(Value::Object(_)) => value.cloned().unwrap_or_else(|| json!({})),
        Some(Value::String(text)) => {
            serde_json::from_str(text).unwrap_or_else(|_| json!({ "value": text }))
        }
        Some(other) => json!({ "value": other }),
    }
}

fn step_output(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

fn distill(message_id: &str, reply_id: Option<&str>, created: &str, source: &str) -> Value {
    let mut meta = json!({
        "messageId": message_id,
        "created": created,
        "runId": message_id,
        "imported": source,
    });
    if let Some(reply_id) = reply_id {
        meta["assistantMessageId"] = json!(reply_id);
    }
    meta
}

fn user_event(
    session_id: &str,
    message_id: &str,
    created: &str,
    text: &str,
    source: &str,
) -> Value {
    json!({
        "sessionId": session_id,
        "update": {
            "sessionUpdate": "user_message_chunk",
            "content": { "type": "text", "text": text },
            "_meta": { "distill": distill(message_id, None, created, source) },
        }
    })
}

fn assistant_event(
    session_id: &str,
    message_id: &str,
    reply_id: &str,
    created: &str,
    text: &str,
    source: &str,
) -> Value {
    json!({
        "sessionId": session_id,
        "update": {
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": text },
            "_meta": { "distill": distill(message_id, Some(reply_id), created, source) },
        }
    })
}

fn thought_event(
    session_id: &str,
    message_id: &str,
    reply_id: &str,
    created: &str,
    text: &str,
    source: &str,
) -> Value {
    json!({
        "sessionId": session_id,
        "update": {
            "sessionUpdate": "agent_thought_chunk",
            "content": { "type": "text", "text": text },
            "_meta": { "distill": distill(message_id, Some(reply_id), created, source) },
        }
    })
}

fn tool_call_event(
    session_id: &str,
    message_id: &str,
    reply_id: &str,
    created: &str,
    call_id: &str,
    name: &str,
    input: &Value,
    source: &str,
) -> Value {
    json!({
        "sessionId": session_id,
        "update": {
            "sessionUpdate": "tool_call",
            "toolCallId": call_id,
            "title": name,
            "kind": "other",
            "status": "in_progress",
            "rawInput": input,
            "_meta": { "distill": distill(message_id, Some(reply_id), created, source) },
        }
    })
}

fn tool_result_event(
    session_id: &str,
    message_id: &str,
    reply_id: &str,
    created: &str,
    call_id: &str,
    status: &str,
    output: &str,
    source: &str,
) -> Value {
    json!({
        "sessionId": session_id,
        "update": {
            "sessionUpdate": "tool_call_update",
            "toolCallId": call_id,
            "status": status,
            "content": [{ "type": "content", "content": { "type": "text", "text": output } }],
            "_meta": { "distill": distill(message_id, Some(reply_id), created, source) },
        }
    })
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

fn cap_tail(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let note = "[earlier loaded text left out]\n";
    let keep = limit.saturating_sub(note.chars().count());
    let start = text.chars().count().saturating_sub(keep);
    let byte = text
        .char_indices()
        .nth(start)
        .map_or(text.len(), |(index, _)| index);
    format!("{note}{}", &text[byte..])
}

#[cfg(test)]
mod tests {
    use super::super::store::SessionRecord;
    use super::*;

    fn export() -> &'static str {
        r#"{
          "title": "From Z.ai",
          "source": "z.ai",
          "messages": [
            {"id": "u1", "role": "user", "text": "Hello"},
            {
              "id": "a1",
              "role": "assistant",
              "text": "Done",
              "thinking": "look",
              "steps": [{
                "id": "call-1",
                "name": "search",
                "status": "completed",
                "input": {"q": "flock"},
                "output": "found",
                "error": null
              }]
            }
          ]
        }"#
    }

    #[test]
    fn a_loaded_turn_keeps_the_user_the_thought_the_step_and_the_reply() {
        let loaded = parse_export(export()).expect("parse");
        let kinds: Vec<&str> = loaded
            .events
            .iter()
            .map(|event| event["update"]["sessionUpdate"].as_str().unwrap())
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
        assert_eq!(loaded.visible_messages, 2);
        assert_eq!(loaded.title.as_deref(), Some("From Z.ai"));
        assert!(loaded.handoff.contains("Hello"));
        assert!(loaded.handoff.contains("found"));
        assert_eq!(
            loaded.events[3]["update"]["status"].as_str(),
            Some("completed")
        );
    }

    #[test]
    fn a_bad_role_parses_as_an_error_and_builds_no_events() {
        let error = parse_export(r#"{"messages":[{"role":"tool","text":"x"}]}"#).unwrap_err();
        assert!(error.contains("role"), "{error}");
    }

    #[test]
    fn one_part_of_a_split_export_is_refused() {
        let error =
            parse_export(r#"{"part":1,"parts":2,"messages":[{"role":"user","text":"hi"}]}"#)
                .unwrap_err();
        assert!(error.contains("part 1 of 2"), "{error}");
    }

    #[test]
    fn a_fenced_export_parses() {
        let text = format!("Here is the chat:\n```json\n{}\n```\n", export());
        let loaded = parse_export(&text).expect("fence");
        assert_eq!(loaded.visible_messages, 2);
    }

    #[test]
    fn code_fences_inside_messages_survive_raw_and_fenced_exports() {
        let code = "Example:\n```rust\nfn main() {}\n```";
        let document = json!({
            "messages": [{ "role": "assistant", "text": code }]
        })
        .to_string();
        for text in [document.clone(), format!("```json\n{document}\n```")] {
            let loaded = parse_export(&text).expect("export with code");
            assert_eq!(loaded.events[0]["update"]["content"]["text"], code);
        }
    }

    #[test]
    fn a_utf8_bom_export_parses() {
        let loaded = parse_export(&format!("\u{feff}{}", export())).expect("UTF-8 BOM");
        assert_eq!(loaded.visible_messages, 2);
    }

    fn record(id: &str) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            harness: "grok-acp".into(),
            account_id: None,
            bridge_session_id: None,
            cwd: "C:\\chat".into(),
            title: Some("Already named".into()),
            user_set_name: true,
            project_id: None,
            persona_id: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: None,
            legacy_model_id: None,
            hidden: false,
            created_at: "2026-11-09T00:00:00.000Z".into(),
            updated_at: "2026-11-09T00:00:00.000Z".into(),
            last_message_at: None,
            archived_at: None,
            message_count: 1,
            last_snippet: Some("before".into()),
            snapshot: None,
        }
    }

    #[tokio::test]
    async fn loading_appends_after_the_messages_the_chat_already_has() {
        let dir = crate::test_support::TempRoot::new();
        let store = SessionStore::open(&dir.path().join("host.db"))
            .await
            .expect("open");
        dir.register(&store.pool);
        let prior = json!({
            "sessionId": "chat",
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": { "type": "text", "text": "before" }
            }
        });
        store
            .import_session(
                &record("chat"),
                &[("2026-11-09T00:00:00.000Z".into(), prior)],
            )
            .await
            .expect("seed");

        let rejected = apply(&store, "chat", "not json").await.unwrap_err();
        assert!(
            rejected.contains("JSON") || rejected.contains("not a chat"),
            "{rejected}"
        );
        let after_reject = store.list_events("chat").await.expect("read");
        assert_eq!(after_reject.len(), 1);

        apply(&store, "chat", export()).await.expect("load");
        let events = store.list_events("chat").await.expect("read");
        assert_eq!(events[0]["update"]["content"]["text"], "before");
        assert_eq!(events.len(), 6);
        let session = store.get_session("chat").await.expect("session").unwrap();
        assert_eq!(session.title.as_deref(), Some("Already named"));
        assert_eq!(session.message_count, 3);
        let handoff = store
            .kv_get(HANDOFF_SCOPE, "chat")
            .await
            .expect("kv")
            .unwrap();
        assert!(handoff["text"].as_str().unwrap().contains("Hello"));
        dir.close().await;
    }

    #[tokio::test]
    async fn an_archived_chat_keeps_its_events() {
        let dir = crate::test_support::TempRoot::new();
        let store = SessionStore::open(&dir.path().join("host.db"))
            .await
            .expect("open");
        dir.register(&store.pool);
        let mut archived = record("chat");
        archived.archived_at = Some("2026-11-09T00:00:00.000Z".into());
        archived.message_count = 0;
        store.insert_session(&archived).await.expect("insert");
        let error = apply(&store, "chat", export()).await.unwrap_err();
        assert!(error.contains("Unarchive"), "{error}");
        assert!(store.list_events("chat").await.expect("read").is_empty());
        dir.close().await;
    }
}
