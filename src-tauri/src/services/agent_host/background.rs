//! Work a provider continues after its foreground prompt has returned.
//! Keep this separate from dispatch ownership: an autonomous reply is not a
//! second submission of the user's prompt and must never acquire its receipt.

use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct BackgroundActivity {
    parent_message_id: Option<String>,
    continuation: Option<(String, String)>,
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
        self.continuation.as_ref().map(|(run, _)| run.as_str())
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

    pub fn disconnected(&mut self) -> Value {
        self.cancel();
        for task in self.tasks.values_mut() {
            if matches!(task["state"].as_str(), Some("running" | "paused")) {
                task["state"] = json!("interrupted");
                task["canStop"] = json!(false);
            }
        }
        self.snapshot()
    }

    /// Translate the negotiated extension into a standard ACP update so the
    /// renderer SDK validates it without discarding an unknown union variant.
    pub fn task_update(&mut self, params: &mut Value) -> bool {
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
            .or_insert_with(|| json!({"id": id, "state": "running"}));
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

    /// Only the caller's verified ordinary Claude route may enter this lane.
    /// An explicitly correlated stale run must never be reclassified here.
    pub fn stamp_continuation(&mut self, params: &mut Value, created: &str) -> bool {
        let Some(parent) = self.parent_message_id.as_ref() else {
            return false;
        };
        let kind = params["update"]["sessionUpdate"].as_str().unwrap_or("");
        if !matches!(
            kind,
            "agent_message_chunk"
                | "agent_thought_chunk"
                | "tool_call"
                | "tool_call_update"
                | "plan"
                | "usage_update"
        ) {
            return false;
        }
        // An unsolicited usage heartbeat alone is not a new assistant reply.
        if self.continuation.is_none() && kind == "usage_update" {
            return false;
        }
        // Every model cycle ends in one result, which the bridge reports as the
        // only `usage_update` carrying the cycle's `cost` (and its
        // `_claude/origin` when the CLI names one). Any result ends the reply:
        // a scheduled wake-up (CronCreate) names no origin at all, and waiting
        // for an autonomous origin kept that reply open for good, refusing
        // every prompt and steer of the chat behind it.
        let finished = kind == "usage_update"
            && (params["update"].get("cost").is_some()
                || params["update"]["_meta"].get("_claude/origin").is_some());
        let (run, reply) = self.continuation.get_or_insert_with(|| {
            (
                uuid::Uuid::new_v4().to_string(),
                uuid::Uuid::new_v4().to_string(),
            )
        });
        params["update"]["_meta"]["distill"] = json!({
            "messageId": parent, "assistantMessageId": reply, "runId": run,
            "created": created, "autonomous": true, "autonomousFinished": finished
        });
        if finished {
            self.continuation = None;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_command_remains_live_after_the_foreground_result() {
        let mut activity = BackgroundActivity::default();
        let mut spawned = json!({"update":{"sessionUpdate":"async_task_spawned","asyncTaskId":"pack","description":"Pack example","toolCallId":"shell"}});
        assert!(activity.task_update(&mut spawned));
        assert_eq!(spawned["update"]["sessionUpdate"], "session_info_update");
        assert!(activity.is_busy());
        let mut ended = json!({"update":{"sessionUpdate":"async_task_state_update","asyncTaskId":"pack","state":"completed","summary":"Exit 0"}});
        activity.task_update(&mut ended);
        assert!(!activity.is_busy());
        assert_eq!(activity.snapshot()[0]["description"], "Pack example");
        assert_eq!(activity.snapshot()[0]["state"], "completed");
    }

    #[test]
    fn autonomous_reply_has_its_own_identity_and_ends_on_its_result() {
        let mut activity = BackgroundActivity::default();
        activity.allow("user-message");
        let chunk = || json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Verified"}}});
        let mut first = chunk();
        assert!(activity.stamp_continuation(&mut first, "now"));
        let mut second = chunk();
        activity.stamp_continuation(&mut second, "later");
        assert_eq!(
            first["update"]["_meta"]["distill"]["assistantMessageId"],
            second["update"]["_meta"]["distill"]["assistantMessageId"]
        );
        let mut result = json!({"update":{"sessionUpdate":"usage_update","_meta":{"_claude/origin":{"kind":"task-notification"}}}});
        assert!(activity.stamp_continuation(&mut result, "end"));
        assert_eq!(
            result["update"]["_meta"]["distill"]["autonomousFinished"],
            true
        );
        assert!(activity.active_run_id().is_none());
        activity.cancel();
        assert!(!activity.stamp_continuation(&mut chunk(), "cancelled"));
    }

    #[test]
    fn scheduled_wake_up_without_an_origin_ends_on_its_result() {
        let mut activity = BackgroundActivity::default();
        activity.allow("user-message");
        let chunk = || json!({"update":{"sessionUpdate":"tool_call","toolCallId":"date"}});
        let mut first = chunk();
        assert!(activity.stamp_continuation(&mut first, "01:26"));
        let mut heartbeat =
            json!({"update":{"sessionUpdate":"usage_update","used":627066,"size":1000000}});
        activity.stamp_continuation(&mut heartbeat, "01:26");
        assert_eq!(
            heartbeat["update"]["_meta"]["distill"]["autonomousFinished"],
            false
        );
        let mut result = json!({"update":{"sessionUpdate":"usage_update","used":628309,"size":1000000,"cost":{"amount":50.4,"currency":"USD"}}});
        assert!(activity.stamp_continuation(&mut result, "01:26"));
        assert_eq!(
            result["update"]["_meta"]["distill"]["autonomousFinished"],
            true
        );
        assert!(activity.active_run_id().is_none());
        assert!(!activity.is_busy());
        let mut next_wake_up = chunk();
        assert!(activity.stamp_continuation(&mut next_wake_up, "01:56"));
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
            assert!(
                !activity.stamp_continuation(&mut json!({"update":{"sessionUpdate":kind}}), "now")
            );
        }
        assert!(!activity.is_busy());
    }
}
