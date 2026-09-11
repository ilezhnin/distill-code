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
