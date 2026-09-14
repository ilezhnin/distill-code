//! Chat titles. The renderer names a chat from its first message at once
//! (`titleFromUserText` in src/features/chat/lib/sessionTitle.ts); the host
//! then stores a few-word summary written by the chat's own harness and model
//! in a throwaway session.
//!
//! No harness names chats itself: Claude Code's `summary` falls back to the
//! first prompt when it has no generated title (and it never generates one
//! when driven through the SDK), and the other bridges send no title at all.

use serde_json::{json, Value};
use std::time::Duration;

/// How long each step of the summary may take before the chat stays untitled.
pub const TITLE_TIMEOUT: Duration = Duration::from_secs(60);

/// The harness whose bridge can open a session that keeps no transcript.
const CLAUDE_HARNESS: &str = "claude-acp";

const CLAUDE_SYSTEM_PROMPT: &str = "You name chat conversations.";

const INSTRUCTION: &str = "Name this chat. Reply with only a title of 2 to 6 words that says what the user wants, in the language of their message. No quotes, no trailing punctuation, no tools, nothing else.\n\nThe user's message:\n";

/// The model sees at most this much of the message.
const MAX_PROMPT_CHARS: usize = 4000;
const MAX_SUMMARY_CHARS: usize = 80;

/// `session/new` for a naming session on `harness_id`. Claude Code's is
/// opened on the chat's model with no transcript, settings, hooks, tools or
/// extended thinking; other bridges take their model after opening.
pub fn naming_session_params(harness_id: &str, cwd: &str, model_id: Option<&str>) -> Value {
    if !keeps_no_transcript(harness_id) {
        return json!({ "cwd": cwd, "mcpServers": [] });
    }
    let mut options = json!({
        "persistSession": false,
        "settingSources": [],
        "thinking": { "type": "disabled" },
        "systemPrompt": CLAUDE_SYSTEM_PROMPT,
    });
    if let Some(model_id) = model_id {
        options["model"] = json!(model_id);
    }
    json!({
        "cwd": cwd,
        "mcpServers": [],
        "_meta": {
            "disableBuiltInTools": true,
            "claudeCode": { "options": options }
        }
    })
}

/// Whether a naming session on `harness_id` leaves nothing behind once
/// closed. Other bridges keep the session in their own history, so it is
/// deleted where the bridge allows that.
pub fn keeps_no_transcript(harness_id: &str) -> bool {
    harness_id == CLAUDE_HARNESS
}

pub fn naming_prompt(user_text: &str) -> Value {
    let message: String = user_text.chars().take(MAX_PROMPT_CHARS).collect();
    json!([{ "type": "text", "text": format!("{INSTRUCTION}{message}") }])
}

/// The text an `agent_message_chunk` update carries, if that is what it is.
pub fn agent_message_text(params: &Value) -> Option<&str> {
    let update = params.get("update")?;
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("agent_message_chunk") {
        return None;
    }
    let content = update.get("content")?;
    if content.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    content.get("text").and_then(Value::as_str)
}

/// The model's answer as a list title: its first line without quotes, markup
/// or a closing full stop. `None` when nothing usable is left.
pub fn clean_summary(reply: &str) -> Option<String> {
    let line = reply.lines().map(str::trim).find(|line| !line.is_empty())?;
    let unquoted = line.trim_matches(|c: char| {
        c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '*' | '#' | '«' | '»' | '“' | '”')
    });
    let bare = unquoted.trim_end_matches(['.', ',', ':', ';']).trim();
    let title = bare.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return None;
    }
    Some(
        title
            .chars()
            .take(MAX_SUMMARY_CHARS)
            .collect::<String>()
            .trim_end()
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claude_naming_session_runs_on_the_chat_model_and_keeps_nothing() {
        let params = naming_session_params("claude-acp", "/home", Some("claude-opus-4-7"));
        let options = &params["_meta"]["claudeCode"]["options"];
        assert_eq!(options["model"], "claude-opus-4-7");
        assert_eq!(options["persistSession"], false);
        assert_eq!(params["_meta"]["disableBuiltInTools"], true);
        let default_model = naming_session_params("claude-acp", "/home", None);
        assert!(default_model["_meta"]["claudeCode"]["options"]
            .get("model")
            .is_none());
    }

    #[test]
    fn other_bridges_open_a_plain_naming_session() {
        // The chat's model is a model, never a model and an effort folded into
        // one name: the router puts the session on it afterwards and leaves
        // the effort alone (`apply_title_model`).
        assert_eq!(
            naming_session_params("codex-acp", "/home", Some("gpt-5.6-sol")),
            json!({ "cwd": "/home", "mcpServers": [] })
        );
        assert!(!keeps_no_transcript("codex-acp"));
    }

    #[test]
    fn the_prompt_carries_the_instruction_and_the_message() {
        let prompt = naming_prompt("fix the build");
        let text = prompt[0]["text"].as_str().expect("text");
        assert!(text.starts_with("Name this chat."));
        assert!(text.ends_with("fix the build"));
    }

    #[test]
    fn a_summary_loses_quotes_and_the_closing_stop() {
        assert_eq!(
            clean_summary("\"Странные имена моделей.\"\n").as_deref(),
            Some("Странные имена моделей")
        );
        assert_eq!(
            clean_summary("\n**Fix model picker**\nextra").as_deref(),
            Some("Fix model picker")
        );
        assert_eq!(clean_summary("  \n\"\" "), None);
    }

    #[test]
    fn a_long_summary_is_cut_to_a_list_row() {
        let title = clean_summary(&"word ".repeat(40)).expect("title");
        assert!(title.chars().count() <= MAX_SUMMARY_CHARS);
        assert!(!title.ends_with(' '));
    }

    #[test]
    fn only_agent_text_chunks_are_collected() {
        let chunk = json!({
            "sessionId": "s",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "Fix" }
            }
        });
        assert_eq!(agent_message_text(&chunk), Some("Fix"));
        let thought = json!({
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "hmm" }
            }
        });
        assert_eq!(agent_message_text(&thought), None);
    }
}
