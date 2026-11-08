//! What a chat's agent sees of the Cua Driver and which calls Flock refuses.
//!
//! The driver advertises 63 tools whose listing alone is about 226,000
//! characters, sent with every turn of every harness that does not defer MCP
//! tools. A capability manifest only refuses calls; it leaves the listing
//! whole. So Flock rewrites the listing itself: the few tools a chat needs to
//! find, read and operate one window, without output schemas, and with the
//! foreground and desktop-wide routes taken out. Every call is checked again
//! here, because a model can send arguments a schema no longer shows.

use serde_json::{json, Value};

/// The tools a chat with computer use gets, in the driver's own names.
/// Everything else the driver offers — self-update, extension installs,
/// scripts, recordings, clipboard, killing apps, cursor styling, browser
/// automation — stays out.
pub const ALLOWED_TOOLS: &[&str] = &[
    "list_apps",
    "list_windows",
    "launch_app",
    "get_window_state",
    "click",
    "type_text",
    "hotkey",
    "set_value",
    "scroll",
    "invoke_menu",
    "zoom",
    "get_desktop_state",
    "get_guide",
];

/// Replaces the driver's own server instructions, which name tools this chat
/// does not have (`run_steps`, `verify_state`, the browser tools).
pub const INSTRUCTIONS: &str = "Flock computer use: operate apps on this Windows desktop in the background, without taking the user's focus or cursor.\n\n\
1. Find the window: `list_windows({app:\"Name\"})`, or start the app with `launch_app` (it opens without taking focus). Note `pid` and `window_id`.\n\
2. Read narrowly: `get_window_state({pid, window_id, query:\"Save\"})`. Row `[N]` is the element token `<snapshot_id>:N`. Re-read with `since:\"latest\"`.\n\
3. Act by `element_token` with `click`, `type_text`, `set_value`, `scroll`, `hotkey` or `invoke_menu`. Use pixels only for surfaces missing from the tree, from a fresh screenshot of the same window.\n\
4. Read the window again to confirm the outcome. `effect:\"unverifiable\"` is not success.\n\n\
Everything stays in the background: Flock refuses foreground delivery and desktop-wide input. When a call reports `background_unavailable`, try another route (`set_value`, `invoke_menu`, another element) or tell the user which step needs them. More: `get_guide({topic})`.";

/// Why Flock refuses a `tools/call`, or `None` to pass it to the driver.
pub fn refusal(params: &Value) -> Option<String> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    if !ALLOWED_TOOLS.contains(&name) {
        return Some(format!(
            "`{name}` is not one of the computer tools Flock offers in this chat. Available: {}.",
            ALLOWED_TOOLS.join(", ")
        ));
    }
    let arguments = params.get("arguments").unwrap_or(&Value::Null);
    if arguments.get("delivery_mode").and_then(Value::as_str) == Some("foreground") {
        return Some(
            "Flock keeps computer use in the background, so `delivery_mode:\"foreground\"` is refused. \
             Try another route (an element_token, `set_value`, `invoke_menu`), or tell the user this step needs them."
                .to_string(),
        );
    }
    let desktop_scope = arguments.get("scope").and_then(Value::as_str) == Some("desktop");
    let desktop_target =
        arguments.pointer("/target/kind").and_then(Value::as_str) == Some("desktop");
    if desktop_scope || desktop_target {
        return Some(
            "Flock refuses desktop-wide input in computer use. Act on one window by `pid` and `window_id`."
                .to_string(),
        );
    }
    None
}

/// The JSON-RPC answer to a refused call: a tool result marked as an error, so
/// the model reads the reason instead of a transport failure.
pub fn refused_call(id: &Value, reason: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{ "type": "text", "text": reason }],
            "isError": true,
        },
    })
}

/// Rewrite the result of a request whose answer advertises the server:
/// `initialize`, the modern `server/discover`, or `tools/list`.
pub fn present_result(result: &mut Value) {
    let Some(object) = result.as_object_mut() else {
        return;
    };
    if object.contains_key("instructions") {
        object.insert("instructions".to_string(), json!(INSTRUCTIONS));
    }
    if let Some(Value::Array(tools)) = object.get_mut("tools") {
        present_tools(tools);
    }
}

/// Keep the allowed tools only, each with its name, description, input schema
/// and the standard annotations — no output schema and no driver-private keys
/// — and with the routes Flock refuses taken out of the schema.
pub fn present_tools(tools: &mut Vec<Value>) {
    tools.retain(|tool| {
        tool.get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| ALLOWED_TOOLS.contains(&name))
    });
    for tool in tools.iter_mut() {
        let Some(object) = tool.as_object_mut() else {
            continue;
        };
        object.retain(|key, _| {
            matches!(
                key.as_str(),
                "name" | "title" | "description" | "inputSchema" | "annotations"
            )
        });
        if let Some(properties) = object
            .get_mut("inputSchema")
            .and_then(|schema| schema.get_mut("properties"))
            .and_then(Value::as_object_mut)
        {
            properties.remove("delivery_mode");
            if let Some(scope) = properties.get_mut("scope") {
                if let Some(values) = scope.get_mut("enum").and_then(Value::as_array_mut) {
                    values.retain(|value| value.as_str() != Some("desktop"));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_outside_the_set_is_refused_by_name() {
        let reason =
            refusal(&json!({ "name": "kill_app", "arguments": { "pid": 1 } })).expect("refused");
        assert!(reason.contains("`kill_app`"));
        assert!(reason.contains("get_window_state"));
    }

    #[test]
    fn a_background_call_on_a_window_passes() {
        assert_eq!(
            refusal(&json!({
                "name": "type_text",
                "arguments": { "pid": 4, "window_id": 9, "element_token": "s1:0", "text": "hi" }
            })),
            None
        );
    }

    #[test]
    fn foreground_delivery_and_desktop_input_are_refused() {
        assert!(refusal(&json!({
            "name": "click",
            "arguments": { "pid": 4, "window_id": 9, "x": 1, "y": 2, "delivery_mode": "foreground" }
        }))
        .is_some_and(|reason| reason.contains("foreground")));
        assert!(refusal(&json!({
            "name": "click",
            "arguments": { "scope": "desktop", "x": 1, "y": 2 }
        }))
        .is_some_and(|reason| reason.contains("desktop-wide")));
        assert!(refusal(&json!({
            "name": "scroll",
            "arguments": { "target": { "kind": "desktop", "display_id": "primary" } }
        }))
        .is_some());
    }

    #[test]
    fn a_missing_or_odd_name_is_refused_rather_than_forwarded() {
        assert!(refusal(&json!({})).is_some());
        assert!(refusal(&json!({ "name": 3 })).is_some());
    }

    #[test]
    fn the_listing_keeps_allowed_tools_without_output_schemas_or_foreground() {
        let mut result = json!({
            "tools": [
                {
                    "name": "click",
                    "description": "Left-click",
                    "inputSchema": { "type": "object", "properties": {
                        "pid": { "type": "integer" },
                        "delivery_mode": { "type": "string", "enum": ["background", "foreground"] },
                        "scope": { "type": "string", "enum": ["window", "desktop"] }
                    } },
                    "outputSchema": { "type": "object" },
                    "annotations": { "readOnlyHint": false },
                    "risk": { "class": "r1" },
                    "capabilities": ["input.pointer.click"]
                },
                { "name": "run_script", "description": "JS", "inputSchema": { "type": "object" } }
            ],
            "nextCursor": null
        });
        present_result(&mut result);
        let tools = result["tools"].as_array().expect("tools");
        assert_eq!(tools.len(), 1);
        let click = &tools[0];
        assert_eq!(click["name"], "click");
        assert!(click.get("outputSchema").is_none());
        assert!(click.get("risk").is_none());
        assert!(click.get("capabilities").is_none());
        assert_eq!(click["annotations"]["readOnlyHint"], false);
        let properties = &click["inputSchema"]["properties"];
        assert!(properties.get("delivery_mode").is_none());
        assert_eq!(properties["scope"]["enum"], json!(["window"]));
        assert!(result.get("nextCursor").is_some());
    }

    #[test]
    fn server_instructions_are_replaced_and_absent_ones_are_not_added() {
        let mut initialized = json!({ "instructions": "use run_steps", "capabilities": {} });
        present_result(&mut initialized);
        assert_eq!(initialized["instructions"], INSTRUCTIONS);
        let mut bare = json!({ "capabilities": {} });
        present_result(&mut bare);
        assert!(bare.get("instructions").is_none());
    }

    #[test]
    fn the_instructions_name_only_tools_the_chat_has() {
        for tool in ["run_steps", "verify_state", "run_script", "browser_"] {
            assert!(!INSTRUCTIONS.contains(tool), "{tool}");
        }
    }

    #[test]
    fn a_refused_call_answers_with_a_tool_error_under_the_same_id() {
        let answer = refused_call(&json!("req-7"), "no");
        assert_eq!(answer["id"], "req-7");
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(answer["result"]["content"][0]["text"], "no");
    }
}
