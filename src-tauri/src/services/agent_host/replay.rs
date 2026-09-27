//! What a chat's replay carries. The log keeps every event the way the bridge
//! sent it; opening a chat only needs what its transcript shows, and two kinds
//! of event make up most of a long chat without adding anything to it:
//!
//! - Streamed text arrives one token or word per event: 44 000 of the 58 000
//!   events of one long chat, 14 000 terminal output deltas of another.
//!   Consecutive pieces of the same message, or of the same call's terminal,
//!   are sent as one event.
//! - A tool call that is still running reports the output so far, again and
//!   again: a grok terminal call sent 41 updates, each carrying the whole
//!   output up to then, and a claude image read carries the image three
//!   times. The renderer's replay reads a call's result only from its final
//!   (`completed` or `failed`) update, so the output of the earlier ones is
//!   left out. Their title, kind, locations and terminal output stay.
//!
//! Everything else passes through byte for byte, in order. An event that does
//! not parse the way these rules expect is passed through as well, so passing
//! an event through unchanged is always correct and only costs replay time.
//!
//! Only events that may change are parsed; which ones is told from the tail
//! of the stored text (see [`may_compact`]). On the longest chat here, 58 549
//! events and 104 MB, the replay becomes 15 797 events and 53 MB.

use serde_json::{Map, Value};

/// Streamed pieces are joined only while small; one long piece is already
/// cheap to replay on its own.
const MAX_JOINED_PIECE_BYTES: usize = 64 * 1024;

enum Replayed {
    /// A piece of streamed text, keyed by everything but its text and time:
    /// it joins the pending run of the same shape.
    Piece {
        shape: Value,
        text: String,
        /// `_meta.distill.created`, when the piece has one.
        created: Option<Value>,
    },
    /// The event without the output replay never shows.
    Trimmed(String),
    Unchanged,
}

struct PendingPiece {
    /// The first event of the run, which the joined text is written into.
    payload: String,
    shape: Value,
    text: String,
    /// The time of the run's last piece. The renderer stamps a message with
    /// the time of the last event that touched it, so the joined event
    /// carries the time the run ended.
    created: Option<Value>,
    pieces: usize,
}

impl PendingPiece {
    fn into_payload(self) -> String {
        if self.pieces == 1 {
            return self.payload;
        }
        write_piece_text(&self.payload, self.text, self.created).unwrap_or(self.payload)
    }
}

pub fn compact(payloads: Vec<String>) -> Vec<String> {
    let mut out = Vec::with_capacity(payloads.len());
    let mut pending: Option<PendingPiece> = None;
    for payload in payloads {
        match classify(&payload) {
            Replayed::Piece {
                shape,
                text,
                created,
            } => {
                if let Some(run) = pending.as_mut().filter(|run| run.shape == shape) {
                    run.text.push_str(&text);
                    run.created = created.or(run.created.take());
                    run.pieces += 1;
                    if run.text.len() >= MAX_JOINED_PIECE_BYTES {
                        out.extend(pending.take().map(PendingPiece::into_payload));
                    }
                    continue;
                }
                out.extend(pending.take().map(PendingPiece::into_payload));
                pending = Some(PendingPiece {
                    payload,
                    shape,
                    text,
                    created,
                    pieces: 1,
                });
            }
            Replayed::Trimmed(trimmed) => {
                out.extend(pending.take().map(PendingPiece::into_payload));
                out.push(trimmed);
            }
            Replayed::Unchanged => {
                out.extend(pending.take().map(PendingPiece::into_payload));
                out.push(payload);
            }
        }
    }
    out.extend(pending.map(PendingPiece::into_payload));
    out
}

fn classify(payload: &str) -> Replayed {
    if !may_compact(payload) {
        return Replayed::Unchanged;
    }
    let Ok(mut value) = payload.parse::<Value>() else {
        return Replayed::Unchanged;
    };
    let small = payload.len() < MAX_JOINED_PIECE_BYTES;
    match value
        .pointer("/update/sessionUpdate")
        .and_then(Value::as_str)
    {
        Some("agent_message_chunk" | "agent_thought_chunk") if small => {
            match take_text(&mut value) {
                Some(text) => piece(value, text),
                None => Replayed::Unchanged,
            }
        }
        Some("tool_call_update") => {
            let Some(update) = value.get_mut("update").and_then(Value::as_object_mut) else {
                return Replayed::Unchanged;
            };
            if matches!(
                update.get("status").and_then(Value::as_str),
                Some("completed" | "failed")
            ) {
                return Replayed::Unchanged;
            }
            if small {
                if let Some(text) = take_terminal_output(update) {
                    return piece(value, text);
                }
            }
            trim_progress(value)
        }
        _ => Replayed::Unchanged,
    }
}

/// Whether an event is worth parsing: a text chunk or a tool call update that
/// is not final. Final tool results hold most of a long chat's bytes and always
/// pass through. The log is written with sorted keys, so `sessionUpdate` and
/// `status` come after the output and the tail of the event tells, without
/// parsing it. A wrong guess only means an event is parsed and then passed
/// through, or passed through as it is.
fn may_compact(payload: &str) -> bool {
    let mut start = payload.len().saturating_sub(1024);
    while !payload.is_char_boundary(start) {
        start += 1;
    }
    let tail = &payload[start..];
    if tail.contains(r#""sessionUpdate":"tool_call_update""#) {
        return !tail.contains(r#""status":"completed""#) && !tail.contains(r#""status":"failed""#);
    }
    if tail.contains(r#""sessionUpdate":"agent_message_chunk""#)
        || tail.contains(r#""sessionUpdate":"agent_thought_chunk""#)
    {
        return payload.len() < MAX_JOINED_PIECE_BYTES;
    }
    // Any other kind named in the tail passes through. An event whose kind is
    // not in the tail at all (a long command as a call's title follows it) is
    // left to the parse.
    !tail.contains(r#""sessionUpdate":""#)
}

/// The text of a text chunk, taken out of it.
fn take_text(value: &mut Value) -> Option<String> {
    let content = value.pointer_mut("/update/content")?.as_object_mut()?;
    if content.get("type")?.as_str()? != "text" || !content.get("text")?.is_string() {
        return None;
    }
    match content.remove("text") {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

/// The output of an update that carries nothing but terminal output (both
/// extension names carry deltas), taken out of it.
fn take_terminal_output(update: &mut Map<String, Value>) -> Option<String> {
    if update
        .keys()
        .any(|key| !matches!(key.as_str(), "sessionUpdate" | "toolCallId" | "_meta"))
    {
        return None;
    }
    let meta = update.get_mut("_meta")?.as_object_mut()?;
    if meta.keys().any(|key| {
        !matches!(
            key.as_str(),
            "distill" | "terminal_output" | "terminal_output_delta"
        )
    }) {
        return None;
    }
    let mut outputs = ["terminal_output_delta", "terminal_output"]
        .into_iter()
        .filter(|key| meta.contains_key(*key));
    let (Some(output_key), None) = (outputs.next(), outputs.next()) else {
        return None;
    };
    let output = meta.get_mut(output_key)?.as_object_mut()?;
    if !output.get("data")?.is_string() {
        return None;
    }
    match output.remove("data") {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

/// A piece whose text was taken out, keyed by what is left without its time
/// (`_meta.distill.created`) and without the notification's own `_meta`, where
/// a bridge may number every chunk (grok's `chunkId`, `eventId`, timestamps).
/// The renderer does not read the latter; the joined event keeps the first
/// piece's.
fn piece(mut value: Value, text: String) -> Replayed {
    if let Some(envelope) = value.as_object_mut() {
        envelope.remove("_meta");
    }
    let created = value
        .pointer_mut("/update/_meta/distill")
        .and_then(Value::as_object_mut)
        .and_then(|distill| distill.remove("created"));
    Replayed::Piece {
        shape: value,
        text,
        created,
    }
}

/// A running call's update without the output so far.
fn trim_progress(mut value: Value) -> Replayed {
    let Some(update) = value.get_mut("update").and_then(Value::as_object_mut) else {
        return Replayed::Unchanged;
    };
    let content = update.remove("content").is_some();
    let raw_output = update.remove("rawOutput").is_some();
    let tool_response = update
        .get_mut("_meta")
        .and_then(|meta| meta.get_mut("claudeCode"))
        .and_then(Value::as_object_mut)
        .and_then(|claude| claude.remove("toolResponse"))
        .is_some();
    if content || raw_output || tool_response {
        Replayed::Trimmed(value.to_string())
    } else {
        Replayed::Unchanged
    }
}

/// The first event of a run, carrying the text and the end time of the whole
/// run.
fn write_piece_text(payload: &str, text: String, created: Option<Value>) -> Option<String> {
    let mut value = payload.parse::<Value>().ok()?;
    if let Some(created) = created {
        value
            .pointer_mut("/update/_meta/distill")?
            .as_object_mut()?
            .insert("created".to_string(), created);
    }
    let text = Value::String(text);
    if let Some(content) = value
        .pointer_mut("/update/content")
        .and_then(Value::as_object_mut)
    {
        content.insert("text".to_string(), text);
    } else {
        let meta = value.pointer_mut("/update/_meta")?.as_object_mut()?;
        let key = if meta.contains_key("terminal_output_delta") {
            "terminal_output_delta"
        } else {
            "terminal_output"
        };
        meta.get_mut(key)?
            .as_object_mut()?
            .insert("data".to_string(), text);
    }
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chunk(kind: &str, message: &str, text: &str, created: &str) -> String {
        json!({
            "sessionId": "s",
            "update": {
                "_meta": { "distill": { "assistantMessageId": message, "created": created, "runId": "r" } },
                "content": { "type": "text", "text": text },
                "sessionUpdate": kind,
            }
        })
        .to_string()
    }

    fn parsed(payloads: &[String]) -> Vec<Value> {
        payloads
            .iter()
            .map(|payload| serde_json::from_str(payload).unwrap())
            .collect()
    }

    #[test]
    fn streamed_text_of_one_message_replays_as_one_event() {
        let events = vec![
            chunk("agent_thought_chunk", "a", "The", "t1"),
            chunk("agent_thought_chunk", "a", " user", "t2"),
            chunk("agent_message_chunk", "a", "Hello", "t3"),
            chunk("agent_message_chunk", "a", ", world", "t4"),
            chunk("agent_message_chunk", "b", "Next", "t5"),
        ];
        let out = parsed(&compact(events));
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["update"]["content"]["text"], "The user");
        assert_eq!(out[0]["update"]["_meta"]["distill"]["created"], "t2");
        assert_eq!(out[1]["update"]["sessionUpdate"], "agent_message_chunk");
        assert_eq!(out[1]["update"]["content"]["text"], "Hello, world");
        assert_eq!(out[1]["update"]["_meta"]["distill"]["created"], "t4");
        assert_eq!(out[2]["update"]["content"]["text"], "Next");
    }

    #[test]
    fn chunks_numbered_by_the_bridge_still_join() {
        let numbered = |id: u32, text: &str| {
            let mut value: Value =
                serde_json::from_str(&chunk("agent_thought_chunk", "a", text, "t")).unwrap();
            value["_meta"] = json!({ "chunkId": id, "eventId": format!("e-{id}") });
            value.to_string()
        };
        let out = parsed(&compact(vec![numbered(1, "a"), numbered(2, "b")]));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["update"]["content"]["text"], "ab");
        assert_eq!(out[0]["_meta"]["chunkId"], 1);
    }

    #[test]
    fn text_is_never_joined_across_another_event() {
        let tool = json!({
            "sessionId": "s",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "c", "title": "Read" }
        })
        .to_string();
        let events = vec![
            chunk("agent_message_chunk", "a", "one", "t1"),
            tool.clone(),
            chunk("agent_message_chunk", "a", "two", "t2"),
        ];
        let out = compact(events.clone());
        assert_eq!(out, events);
    }

    #[test]
    fn a_single_event_passes_through_byte_for_byte() {
        let events = vec![
            chunk("agent_message_chunk", "a", "only", "t1"),
            r#"{"sessionId":"s","update":{"sessionUpdate":"usage_update","used":1}}"#.to_string(),
            "not json".to_string(),
        ];
        assert_eq!(compact(events.clone()), events);
    }

    #[test]
    fn a_running_call_keeps_what_replay_reads_and_drops_its_output_so_far() {
        let progress = json!({
            "sessionId": "s",
            "update": {
                "_meta": {
                    "claudeCode": { "toolName": "Read", "toolResponse": { "file": "x".repeat(1000) } },
                    "distill": { "assistantMessageId": "a", "created": "t1" }
                },
                "content": [{ "type": "content", "content": { "type": "text", "text": "partial" } }],
                "kind": "read",
                "locations": [{ "path": "C:/f.png" }],
                "rawOutput": { "output": "partial" },
                "sessionUpdate": "tool_call_update",
                "status": "in_progress",
                "title": "Read f.png",
                "toolCallId": "c"
            }
        })
        .to_string();
        let done = json!({
            "sessionId": "s",
            "update": {
                "content": [{ "type": "content", "content": { "type": "text", "text": "all" } }],
                "rawOutput": { "output": "all" },
                "sessionUpdate": "tool_call_update",
                "status": "completed",
                "toolCallId": "c"
            }
        })
        .to_string();
        let out = compact(vec![progress, done.clone()]);
        assert_eq!(out[1], done);
        let trimmed: Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(
            trimmed,
            json!({
                "sessionId": "s",
                "update": {
                    "_meta": {
                        "claudeCode": { "toolName": "Read" },
                        "distill": { "assistantMessageId": "a", "created": "t1" }
                    },
                    "kind": "read",
                    "locations": [{ "path": "C:/f.png" }],
                    "sessionUpdate": "tool_call_update",
                    "status": "in_progress",
                    "title": "Read f.png",
                    "toolCallId": "c"
                }
            })
        );
    }

    #[test]
    fn a_running_call_with_a_long_title_is_still_trimmed() {
        // The title sorts after `sessionUpdate`, so a long one pushes the kind
        // out of the tail the event is first judged by.
        let progress = json!({
            "sessionId": "s",
            "update": {
                "rawOutput": { "output": "partial" },
                "sessionUpdate": "tool_call_update",
                "title": "x".repeat(4000),
                "toolCallId": "c"
            }
        })
        .to_string();
        let out = parsed(&compact(vec![progress]));
        assert_eq!(out[0]["update"].get("rawOutput"), None);
        assert_eq!(out[0]["update"]["title"].as_str().unwrap().len(), 4000);
    }

    fn delta(call: &str, data: &str, created: &str) -> String {
        json!({
            "sessionId": "s",
            "update": {
                "_meta": {
                    "distill": { "assistantMessageId": "a", "created": created },
                    "terminal_output_delta": { "data": data, "terminal_id": call }
                },
                "sessionUpdate": "tool_call_update",
                "toolCallId": call
            }
        })
        .to_string()
    }

    #[test]
    fn terminal_output_of_one_call_replays_as_one_delta() {
        let out = parsed(&compact(vec![
            delta("c1", "line 1\n", "t1"),
            delta("c1", "line 2\n", "t2"),
            delta("c2", "other\n", "t3"),
            delta("c1", "line 3\n", "t4"),
        ]));
        let data: Vec<_> = out
            .iter()
            .map(|event| {
                (
                    event["update"]["toolCallId"].as_str().unwrap(),
                    event["update"]["_meta"]["terminal_output_delta"]["data"]
                        .as_str()
                        .unwrap(),
                )
            })
            .collect();
        assert_eq!(
            data,
            [
                ("c1", "line 1\nline 2\n"),
                ("c2", "other\n"),
                ("c1", "line 3\n")
            ]
        );
        assert_eq!(out[0]["update"]["_meta"]["distill"]["created"], "t2");
    }

    #[test]
    fn a_delta_with_anything_else_is_not_joined() {
        let mut with_title: Value = serde_json::from_str(&delta("c", "x", "t2")).unwrap();
        with_title["update"]["title"] = json!("Run");
        let with_title = with_title.to_string();
        let events = vec![delta("c", "a", "t1"), with_title.clone()];
        let out = compact(events);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1], with_title);
    }

    #[test]
    fn long_runs_are_split_to_keep_events_bounded() {
        let piece = "x".repeat(1000);
        let events: Vec<_> = (0..200)
            .map(|i| chunk("agent_message_chunk", "a", &piece, &format!("t{i}")))
            .collect();
        let out = parsed(&compact(events));
        assert!(out.len() > 1);
        let text: String = out
            .iter()
            .map(|event| event["update"]["content"]["text"].as_str().unwrap())
            .collect();
        assert_eq!(text, piece.repeat(200));
    }
}
