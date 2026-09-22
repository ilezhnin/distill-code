//! JSON-RPC 2.0 plumbing shared by the frontend socket and the bridge stdio
//! pipes. The host never interprets ACP payloads beyond what routing needs, so
//! everything here works on `serde_json::Value`.

use serde_json::{json, Value};

pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

/// One parsed JSON-RPC message.
#[derive(Debug, Clone)]
pub enum Message {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: Value,
        result: Result<Value, Value>,
    },
}

pub fn parse(line: &str) -> Option<Message> {
    let value: Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    let id = object.get("id").filter(|id| !id.is_null()).cloned();
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        return Some(match id {
            Some(id) => Message::Request {
                id,
                method: method.to_string(),
                params,
            },
            None => Message::Notification {
                method: method.to_string(),
                params,
            },
        });
    }
    let id = id?;
    if let Some(error) = object.get("error") {
        return Some(Message::Response {
            id,
            result: Err(error.clone()),
        });
    }
    Some(Message::Response {
        id,
        result: Ok(object.get("result").cloned().unwrap_or(Value::Null)),
    })
}

pub fn request(id: Value, method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

pub fn notification(method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}

/// A notification whose params are already serialized JSON text (validated
/// by the caller), spliced in without a parse/serialize round trip.
pub fn raw_notification(method: &str, params_json: &str) -> String {
    let method = json!(method).to_string();
    format!(r#"{{"jsonrpc":"2.0","method":{method},"params":{params_json}}}"#)
}

/// Replay the stored JSON unchanged, with bounded frames so the WebView does
/// not schedule one socket callback per historical token. Older clients keep
/// receiving individual notifications unless they explicitly opt into batches.
pub fn send_replay_notifications(
    payloads: impl IntoIterator<Item = String>,
    batched: bool,
    mut send: impl FnMut(String),
) -> usize {
    const MAX_EVENTS: usize = 128;
    const MAX_BYTES: usize = 256 * 1024;
    let mut batch = String::new();
    let mut count = 0;
    let mut frames = 0;
    for payload in payloads {
        let notification = raw_notification("session/update", &payload);
        if !batched {
            send(notification);
            frames += 1;
            continue;
        }
        if count > 0 && (count == MAX_EVENTS || batch.len() + notification.len() + 2 > MAX_BYTES) {
            batch.push(']');
            send(std::mem::take(&mut batch));
            frames += 1;
            count = 0;
        }
        batch.push(if count == 0 { '[' } else { ',' });
        batch.push_str(&notification);
        count += 1;
    }
    if count > 0 {
        batch.push(']');
        send(batch);
        frames += 1;
    }
    frames
}

pub fn response(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

pub fn error_response(id: Value, error: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": error }).to_string()
}

pub fn error(code: i64, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

pub fn error_with_data(code: i64, message: impl Into<String>, data: Value) -> Value {
    json!({ "code": code, "message": message.into(), "data": data })
}

pub fn invalid_params(message: impl Into<String>) -> Value {
    error(INVALID_PARAMS, message)
}

pub fn internal(message: impl Into<String>) -> Value {
    error(INTERNAL_ERROR, message)
}

/// `params.sessionId` as an owned string, when present.
pub fn session_id(params: &Value) -> Option<String> {
    params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod raw_notification_tests {
    use super::*;

    #[test]
    fn raw_notification_matches_the_parsed_form() {
        let params = json!({ "sessionId": "s1", "update": { "text": "a \"quoted\" line\n" } });
        let raw = raw_notification("session/update", &params.to_string());
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        let expected: Value =
            serde_json::from_str(&notification("session/update", params)).unwrap();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn replay_batches_preserve_every_update_and_bound_event_count() {
        let payloads: Vec<_> = (0..300)
            .map(|i| {
                json!({ "sessionId": "s1", "update": { "text": format!("токен {i}\n") } })
                    .to_string()
            })
            .collect();
        let mut frames = Vec::new();
        assert_eq!(
            send_replay_notifications(payloads.clone(), true, |frame| frames.push(frame)),
            3
        );
        let batches: Vec<Vec<Value>> = frames
            .iter()
            .map(|frame| serde_json::from_str(frame).unwrap())
            .collect();
        assert_eq!(
            batches.iter().map(Vec::len).collect::<Vec<_>>(),
            [128, 128, 44]
        );
        let actual: Vec<Value> = batches
            .into_iter()
            .flatten()
            .map(|message| message["params"].clone())
            .collect();
        let expected: Vec<Value> = payloads
            .iter()
            .map(|payload| serde_json::from_str(payload).unwrap())
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn replay_batches_bound_bytes_without_dropping_large_updates() {
        let payloads = [
            "я".repeat(70_000),
            "я".repeat(70_000),
            "x".repeat(300_000),
            "tail".to_string(),
        ]
        .map(|text| json!({ "sessionId": "s", "update": { "text": text } }).to_string());
        let mut frames = Vec::new();
        send_replay_notifications(payloads.clone(), true, |frame| frames.push(frame));
        assert_eq!(frames.len(), 4);
        for (frame, payload) in frames.iter().zip(payloads) {
            let parsed: Vec<Value> = serde_json::from_str(frame).unwrap();
            assert_eq!(parsed.len(), 1);
            assert_eq!(
                parsed[0]["params"],
                serde_json::from_str::<Value>(&payload).unwrap()
            );
        }
    }

    #[test]
    fn replay_keeps_legacy_frames_until_the_client_opts_in() {
        let mut frames = Vec::new();
        let payload = r#"{"sessionId":"s","update":{"text":"hello"}}"#.to_string();
        assert_eq!(
            send_replay_notifications([payload.clone()], false, |frame| frames.push(frame)),
            1
        );
        assert_eq!(frames, [raw_notification("session/update", &payload)]);
        assert_eq!(
            send_replay_notifications([], true, |_| panic!("empty history has no frames")),
            0
        );
    }
}
