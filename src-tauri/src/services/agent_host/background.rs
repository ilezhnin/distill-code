//! Work a provider continues after its foreground prompt has returned.
//! Keep this separate from dispatch ownership: an autonomous reply is not a
//! second submission of the user's prompt and must never acquire its receipt.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// A lost terminal notification must eventually release the composer. Only
/// model or tool progress renews the window; usage/status heartbeats can
/// continue after a provider loses its end marker.
pub(super) const CONTINUATION_SILENCE: Duration = Duration::from_secs(5 * 60);

struct Continuation {
    parent: String,
    run: String,
    reply: String,
    last_update: Instant,
    codex_usage: Option<Value>,
}

impl Continuation {
    fn stamp(&self, params: &mut Value, created: &str, finished: bool) {
        params["update"]["_meta"]["distill"] = json!({
            "messageId": self.parent, "assistantMessageId": self.reply, "runId": self.run,
            "created": created, "autonomous": true, "autonomousFinished": finished
        });
        if finished {
            if let Some(usage) = &self.codex_usage {
                params["update"]["_meta"]["codexTurnUsage"] = usage.clone();
            }
        }
    }
}

#[derive(Default)]
pub(super) struct BackgroundActivity {
    parent_message_id: Option<String>,
    continuation: Option<Continuation>,
    tasks: BTreeMap<String, Value>,
}

impl BackgroundActivity {
    pub fn allow(&mut self, message_id: &str) {
        self.parent_message_id = Some(message_id.into());
    }

    pub fn cancel(&mut self) {
        self.parent_message_id = None;
        self.continuation = None;
    }

    pub fn active_run_id(&self) -> Option<&str> {
        self.continuation.as_ref().map(|turn| turn.run.as_str())
    }

    pub fn is_busy(&self) -> bool {
        self.continuation.is_some()
            || self
                .tasks
                .values()
                .any(|task| matches!(task["state"].as_str(), Some("running" | "paused")))
    }

    pub fn snapshot(&self) -> Value {
        json!(self.tasks.values().collect::<Vec<_>>())
    }

    pub fn disconnected(&mut self, now: &str) -> Value {
        self.cancel();
        for task in self.tasks.values_mut() {
            if matches!(task["state"].as_str(), Some("running" | "paused")) {
                task["state"] = json!("interrupted");
                task["canStop"] = json!(false);
                task["endedAt"] = json!(now);
            }
        }
        self.snapshot()
    }

    /// Translate the negotiated extension into a standard ACP update so the
    /// renderer SDK validates it without discarding an unknown union variant.
    /// The bridge times nothing, so each task carries when this host first saw
    /// it (`startedAt`) and when it saw it end (`endedAt`).
    pub fn task_update(&mut self, params: &mut Value, now: &str) -> bool {
        let update = &params["update"];
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        if !matches!(
            kind,
            "async_task_spawned" | "async_task_progress" | "async_task_state_update"
        ) {
            return false;
        }
        let Some(id) = update["asyncTaskId"].as_str().filter(|id| !id.is_empty()) else {
            return false;
        };
        let task = self
            .tasks
            .entry(id.into())
            .or_insert_with(|| json!({"id": id, "state": "running", "startedAt": now}));
        for key in [
            "name",
            "description",
            "taskType",
            "outputFilePath",
            "toolCallId",
            "summary",
            "canStop",
        ] {
            if let Some(value) = update.get(key) {
                task[key] = value.clone();
            }
        }
        if let Some(state) = update["state"].as_str().filter(|state| {
            matches!(
                *state,
                "running" | "paused" | "completed" | "failed" | "stopped"
            )
        }) {
            task["state"] = json!(state);
        }
        if !matches!(task["state"].as_str(), Some("running" | "paused"))
            && task.get("endedAt").is_none()
        {
            task["endedAt"] = json!(now);
        }
        // Preserve every live job, but do not grow a session-wide status panel
        // without bound as a long conversation launches short-lived commands.
        while self.tasks.len() > 128 {
            let settled = self
                .tasks
                .iter()
                .find(|(_, task)| !matches!(task["state"].as_str(), Some("running" | "paused")))
                .map(|(id, _)| id.clone());
            let Some(id) = settled else {
                break;
            };
            self.tasks.remove(&id);
        }
        params["update"] = json!({
            "sessionUpdate": "session_info_update",
            "_meta": {"backgroundTasks": self.snapshot()}
        });
        true
    }

    /// The bridge reader's correlation is authoritative: a prompt response can
    /// already have arrived while the router is still draining its last events.
    pub fn stamp_continuation(&mut self, params: &mut Value, created: &str, harness: &str) -> bool {
        let Some(parent) = &self.parent_message_id else {
            return false;
        };
        let update = &params["update"];
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        let status = if kind == "session_info_update" && harness == "codex-acp" {
            update
                .pointer("/_meta/codex/threadStatus/type")
                .and_then(Value::as_str)
        } else {
            None
        };
        let finished = match harness {
            "codex-acp" => matches!(status, Some("idle" | "systemError")),
            "claude-acp" => {
                kind == "usage_update"
                    && (update.get("cost").is_some()
                        || update["_meta"].get("_claude/origin").is_some())
            }
            "grok-acp" => {
                (kind == "message_usage" && update["_meta"].get("xaiTurnUsage").is_some())
                    || (kind == "session_info_update"
                        && update["_meta"]["xaiTurnCompleted"] == true)
            }
            _ => kind == "message_usage",
        };
        let starts = matches!(
            kind,
            "agent_message_chunk"
                | "agent_thought_chunk"
                | "tool_call"
                | "tool_call_update"
                | "plan"
        ) || status == Some("active");
        if !starts
            && !(self.continuation.is_some()
                && (finished || matches!(kind, "usage_update" | "message_usage")))
        {
            return false;
        }
        let first = self.continuation.is_none();
        let turn = self.continuation.get_or_insert_with(|| Continuation {
            parent: parent.clone(),
            run: uuid::Uuid::new_v4().to_string(),
            reply: uuid::Uuid::new_v4().to_string(),
            last_update: Instant::now(),
            codex_usage: None,
        });
        if starts && status.is_none() {
            turn.last_update = Instant::now();
        }
        if harness == "codex-acp" && kind == "usage_update" {
            if let Some(usage) = update.pointer("/_meta/codexTurnUsage") {
                turn.codex_usage = Some(usage.clone());
            }
        }
        turn.stamp(params, created, finished);
        if first {
            params["update"]["_meta"]["distill"]["autonomousStarted"] = json!(true);
        }
        // The renderer prefers the wire messageId when present. The host
        // reply owns every chunk, even when Codex changes its native item id.
        if let Some(native) = params["update"].get("messageId").cloned() {
            params["update"]["_meta"]["providerMessageId"] = native;
            params["update"]["messageId"] = json!(turn.reply);
        }
        if finished {
            self.continuation = None;
        }
        true
    }

    pub fn expire(&mut self, now: Instant, session: &str) -> Option<Value> {
        let turn = self.continuation.as_ref()?;
        if now.saturating_duration_since(turn.last_update) < CONTINUATION_SILENCE {
            return None;
        }
        self.finish(session)
    }

    pub fn finish(&mut self, session: &str) -> Option<Value> {
        let turn = self.continuation.take()?;
        let mut params =
            json!({"sessionId": session, "update": {"sessionUpdate":"session_info_update"}});
        turn.stamp(&mut params, &super::protocol::now_iso(), true);
        Some(params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_command_remains_live_after_the_foreground_result() {
        let mut activity = BackgroundActivity::default();
        let mut spawned = json!({"update":{"sessionUpdate":"async_task_spawned","asyncTaskId":"pack","description":"Pack example","toolCallId":"shell"}});
        assert!(activity.task_update(&mut spawned, "t1"));
        assert_eq!(spawned["update"]["sessionUpdate"], "session_info_update");
        assert!(activity.is_busy());
        let mut ended = json!({"update":{"sessionUpdate":"async_task_state_update","asyncTaskId":"pack","state":"completed","summary":"Exit 0"}});
        activity.task_update(&mut ended, "t2");
        assert!(!activity.is_busy());
        assert_eq!(activity.snapshot()[0]["description"], "Pack example");
        assert_eq!(activity.snapshot()[0]["state"], "completed");
    }

    #[test]
    fn a_task_is_timed_from_its_first_report_to_the_first_report_of_its_end() {
        let mut activity = BackgroundActivity::default();
        let update = |kind: &str, id: &str, state: Option<&str>| {
            let mut update = json!({"sessionUpdate": kind, "asyncTaskId": id});
            if let Some(state) = state {
                update["state"] = json!(state);
            }
            json!({ "update": update })
        };
        activity.task_update(&mut update("async_task_spawned", "pack", None), "t1");
        activity.task_update(&mut update("async_task_progress", "pack", None), "t2");
        let running = activity.snapshot();
        assert_eq!(running[0]["startedAt"], "t1");
        assert!(running[0].get("endedAt").is_none());

        activity.task_update(
            &mut update("async_task_state_update", "pack", Some("completed")),
            "t3",
        );
        // A repeated terminal report (a late output path) does not move the end.
        activity.task_update(
            &mut update("async_task_state_update", "pack", Some("completed")),
            "t4",
        );
        let ended = activity.snapshot();
        assert_eq!(ended[0]["startedAt"], "t1");
        assert_eq!(ended[0]["endedAt"], "t3");

        activity.task_update(&mut update("async_task_spawned", "watch", None), "t5");
        let lost = activity.disconnected("t6");
        assert_eq!(lost[0]["endedAt"], "t3");
        assert_eq!(lost[1]["state"], "interrupted");
        assert_eq!(lost[1]["endedAt"], "t6");
    }

    #[test]
    fn autonomous_reply_has_its_own_identity_and_ends_on_its_result() {
        let mut activity = BackgroundActivity::default();
        activity.allow("user-message");
        let chunk = || json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Verified"}}});
        let mut first = chunk();
        assert!(activity.stamp_continuation(&mut first, "now", "claude-acp"));
        let mut second = chunk();
        activity.stamp_continuation(&mut second, "later", "claude-acp");
        assert_eq!(
            first["update"]["_meta"]["distill"]["assistantMessageId"],
            second["update"]["_meta"]["distill"]["assistantMessageId"]
        );
        let mut result = json!({"update":{"sessionUpdate":"usage_update","_meta":{"_claude/origin":{"kind":"task-notification"}}}});
        assert!(activity.stamp_continuation(&mut result, "end", "claude-acp"));
        assert_eq!(
            result["update"]["_meta"]["distill"]["autonomousFinished"],
            true
        );
        assert!(activity.active_run_id().is_none());
        activity.cancel();
        assert!(!activity.stamp_continuation(&mut chunk(), "cancelled", "claude-acp"));
    }

    #[test]
    fn scheduled_wake_up_without_an_origin_ends_on_its_result() {
        let mut activity = BackgroundActivity::default();
        activity.allow("user-message");
        let chunk = || json!({"update":{"sessionUpdate":"tool_call","toolCallId":"date"}});
        let mut first = chunk();
        assert!(activity.stamp_continuation(&mut first, "01:26", "claude-acp"));
        let mut heartbeat =
            json!({"update":{"sessionUpdate":"usage_update","used":627066,"size":1000000}});
        activity.stamp_continuation(&mut heartbeat, "01:26", "claude-acp");
        assert_eq!(
            heartbeat["update"]["_meta"]["distill"]["autonomousFinished"],
            false
        );
        let mut result = json!({"update":{"sessionUpdate":"usage_update","used":628309,"size":1000000,"cost":{"amount":50.4,"currency":"USD"}}});
        assert!(activity.stamp_continuation(&mut result, "01:26", "claude-acp"));
        assert_eq!(
            result["update"]["_meta"]["distill"]["autonomousFinished"],
            true
        );
        assert!(activity.active_run_id().is_none());
        assert!(!activity.is_busy());
        let mut next_wake_up = chunk();
        assert!(activity.stamp_continuation(&mut next_wake_up, "01:56", "claude-acp"));
        assert_ne!(
            next_wake_up["update"]["_meta"]["distill"]["runId"],
            first["update"]["_meta"]["distill"]["runId"]
        );
    }

    #[test]
    fn usage_and_user_echoes_cannot_invent_a_background_reply() {
        let mut activity = BackgroundActivity::default();
        activity.allow("user");
        for kind in ["usage_update", "user_message_chunk", "session_info_update"] {
            assert!(!activity.stamp_continuation(
                &mut json!({"update":{"sessionUpdate":kind}}),
                "now",
                "claude-acp"
            ));
        }
        assert!(!activity.is_busy());
    }
}
