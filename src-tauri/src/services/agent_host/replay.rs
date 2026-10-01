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
//! Everything else passes through byte for byte, in order. Valid JSON that does
//! not have the shape these rules expect is passed through as well, so passing
//! an event through unchanged is always correct and only costs replay time.
//!
//! Only events that may change are parsed; which ones is told from the tail
//! of the stored text (see [`may_compact`]). On the longest chat here, 58 549
//! events and 104 MB, the replay becomes 15 797 events and 53 MB.

use serde_json::{Map, Value};
use std::ops::Range;

/// Streamed pieces are joined only while small; one long piece is already
/// cheap to replay on its own.
const MAX_JOINED_PIECE_BYTES: usize = 64 * 1024;

/// Keep heavy completed output on disk until its tool card is opened. The
/// original event remains authoritative for exports and explicit reads.
pub fn defer_tool_result(payload: String, id: i64) -> String {
    if payload.len() < MAX_JOINED_PIECE_BYTES {
        return payload;
    }
    let Ok(mut event) = payload.parse::<Value>() else {
        return payload;
    };
    let Some(update) = event.get_mut("update").and_then(Value::as_object_mut) else {
        return payload;
    };
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("tool_call_update")
        || !matches!(
            update.get("status").and_then(Value::as_str),
            Some("completed" | "failed")
        )
    {
        return payload;
    }
    update.remove("rawOutput");
    update.remove("content");
    let meta = update
        .entry("_meta")
        .or_insert_with(|| serde_json::json!({}));
    if !meta.is_object() {
        *meta = serde_json::json!({});
    }
    if let Some(claude) = meta.get_mut("claudeCode").and_then(Value::as_object_mut) {
        claude.remove("toolResponse");
    }
    if let Some(object) = meta.as_object_mut() {
        object.remove("terminal_output");
        object.remove("terminal_output_delta");
    }
    if !meta["distill"].is_object() {
        meta["distill"] = serde_json::json!({});
    }
    meta["distill"]["resultEventId"] = serde_json::json!(id);
    event.to_string()
}

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
    text_shape: Option<TextShape>,
}

/// A validated text chunk's unchanged JSON segments. Most adjacent chunks
/// differ only in text and the host timestamp; compare the remaining bytes
/// and decode those two strings instead of rebuilding the whole JSON tree.
/// Any other change falls back to the structural compactor below.
struct TextShape {
    fields: Vec<(Range<usize>, bool)>,
}

impl TextShape {
    fn new(payload: &str, shape: &Value, created: Option<&Value>) -> Option<Self> {
        if shape.pointer("/update/content/type")?.as_str()? != "text" {
            return None;
        }
        let mut fields = vec![(string_field(payload, "\"text\":")?, true)];
        if let Some(created) = created {
            created.as_str()?;
            fields.push((string_field(payload, "\"created\":")?, false));
        }
        fields.sort_by_key(|(range, _)| range.start);
        Some(Self { fields })
    }

    fn read(&self, original: &str, payload: &str) -> Option<(String, Option<Value>)> {
        let mut old = 0;
        let mut new = 0;
        let mut text = None;
        let mut created = None;
        for (range, is_text) in &self.fields {
            let literal = &original[old..range.start];
            if !payload.get(new..)?.starts_with(literal) {
                return None;
            }
            new += literal.len();
            let end = string_end(payload, new)?;
            let Value::String(value) = payload[new..end].parse::<Value>().ok()? else {
                return None;
            };
            if *is_text {
                text = Some(value);
            } else {
                created = Some(Value::String(value));
            }
            old = range.end;
            new = end;
        }
        (original[old..] == payload[new..]).then_some((text?, created))
    }
}

fn string_field(payload: &str, key: &str) -> Option<Range<usize>> {
    let mut matches = payload.match_indices(key);
    let (start, _) = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let start = start + key.len();
    Some(start..string_end(payload, start)?)
}

fn string_end(payload: &str, start: usize) -> Option<usize> {
    let bytes = payload.as_bytes();
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    let mut index = start + 1;
    while let Some(byte) = bytes.get(index) {
        match byte {
            b'"' => return Some(index + 1),
            b'\\' => index += 2,
            _ => index += 1,
        }
    }
    None
}

impl PendingPiece {
    fn into_payload(self) -> String {
        if self.pieces == 1 {
            return self.payload;
        }
        write_piece_text(&self.payload, self.text, self.created).unwrap_or(self.payload)
    }
}

#[derive(Default)]
pub struct Compactor {
    out: Vec<String>,
    pending: Option<PendingPiece>,
}

impl Compactor {
    /// Validate and compact each stored row in one pass. Invalid JSON is
    /// skipped, as it cannot be included in a replay notification frame.
    pub fn push(&mut self, payload: String) -> bool {
        if payload.len() < MAX_JOINED_PIECE_BYTES {
            if let Some(run) = self.pending.as_mut() {
                if let Some((text, created)) = run
                    .text_shape
                    .as_ref()
                    .and_then(|shape| shape.read(&run.payload, &payload))
                {
                    run.text.push_str(&text);
                    run.created = created.or(run.created.take());
                    run.pieces += 1;
                    if run.text.len() >= MAX_JOINED_PIECE_BYTES {
                        self.out
                            .extend(self.pending.take().map(PendingPiece::into_payload));
                    }
                    return true;
                }
            }
        }
        if !may_compact(&payload) {
            let Ok(raw) = serde_json::value::RawValue::from_string(payload) else {
                return false;
            };
            self.out
                .extend(self.pending.take().map(PendingPiece::into_payload));
            self.out.push(String::from(Box::<str>::from(raw)));
            return true;
        }
        let Ok(value) = payload.parse::<Value>() else {
            return false;
        };
        let classified = classify(value, payload.len() < MAX_JOINED_PIECE_BYTES);
        let Self { out, pending } = self;
        match classified {
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
                    return true;
                }
                out.extend(pending.take().map(PendingPiece::into_payload));
                let text_shape = TextShape::new(&payload, &shape, created.as_ref());
                *pending = Some(PendingPiece {
                    payload,
                    shape,
                    text,
                    created,
                    pieces: 1,
                    text_shape,
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
        true
    }

    pub fn finish(mut self) -> Vec<String> {
        self.out
            .extend(self.pending.map(PendingPiece::into_payload));
        self.out
    }
}

#[cfg(test)]
pub fn compact(payloads: Vec<String>) -> Vec<String> {
    let mut compactor = Compactor::default();
    for payload in payloads {
        compactor.push(payload);
    }
    compactor.finish()
}

fn classify(mut value: Value, small: bool) -> Replayed {
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
    fn fast_text_chunks_preserve_unicode_escapes_and_validate_changed_strings() {
        let texts = ["a\\\"b", "Ж🙂\n\t", "\\", "\"created\":\"other\""];
        let events: Vec<_> = texts
            .iter()
            .map(|text| chunk("agent_message_chunk", "a", text, "t"))
            .collect();
        let first: Value = events[0].parse().unwrap();
        let Replayed::Piece { shape, created, .. } = classify(first, true) else {
            panic!()
        };
        let fast = TextShape::new(&events[0], &shape, created.as_ref()).unwrap();
        for (event, text) in events.iter().zip(texts) {
            assert_eq!(fast.read(&events[0], event).unwrap().0, text);
        }
        let out = parsed(&compact(events.clone()));
        assert_eq!(out[0]["update"]["content"]["text"], texts.concat());
        let invalid = events[0].replace(r#"a\\\"b"#, r#"a\qb"#);
        assert_ne!(invalid, events[0]);
        assert!(fast.read(&events[0], &invalid).is_none());
        assert!(fast
            .read(&events[0], &chunk("agent_message_chunk", "other", "x", "t"))
            .is_none());
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
        ];
        assert_eq!(compact(events.clone()), events);
    }

    #[test]
    fn invalid_stored_rows_are_skipped_without_breaking_the_valid_replay() {
        let mut compactor = Compactor::default();
        assert!(compactor.push(chunk("agent_message_chunk", "a", "one", "t1")));
        assert!(!compactor.push("not json".into()));
        assert!(!compactor.push(r#"{"sessionUpdate":"usage_update",broken}"#.into()));
        assert!(compactor.push(chunk("agent_message_chunk", "a", "two", "t2")));
        let out = parsed(&compactor.finish());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["update"]["content"]["text"], "onetwo");
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
