//! How full a chat's context window is, as its bridge last said, written on
//! the compaction updates that pass.
//!
//! A bridge reports that a compaction started and that it ended. Only
//! claude-agent-acp says what it freed; codex-acp reports the status alone.
//! Every bridge that counts its context reports the count as `usage_update`,
//! before a compaction starts and again once it has ended, so the figure the
//! host last saw is the window before on the update that starts a compaction
//! and the window after on the update that ends it. It is written on the
//! update itself, which is what a replayed transcript is read from.

use serde_json::{json, Value};

#[derive(Default)]
pub(super) struct ContextMeter {
    used: Option<Value>,
    size: Option<Value>,
}

impl ContextMeter {
    /// Note the figure of a `usage_update`; write the latest figure on a
    /// `compaction_update` as `_meta.distill.contextUsage`.
    pub fn observe(&mut self, params: &mut Value) {
        let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) else {
            return;
        };
        match update.get("sessionUpdate").and_then(Value::as_str) {
            // A bridge may leave either field out of an update, so each is
            // kept from the newest update that names it.
            Some("usage_update") => {
                for (key, slot) in [("used", &mut self.used), ("size", &mut self.size)] {
                    if let Some(value) = update.get(key).filter(|value| value.is_number()) {
                        *slot = Some(value.clone());
                    }
                }
            }
            Some("compaction_update") => {
                let Some(used) = self.used.clone() else {
                    return;
                };
                let mut usage = json!({ "used": used });
                if let Some(size) = &self.size {
                    usage["size"] = size.clone();
                }
                let bridge_meta = update.get("_meta").cloned();
                let mut meta = match &bridge_meta {
                    Some(Value::Object(meta)) => meta.clone(),
                    Some(Value::Null) | None => Default::default(),
                    // Not a metadata object: nothing of ours belongs in it.
                    Some(_) => return,
                };
                let distill = meta.entry("distill").or_insert_with(|| json!({}));
                let Some(distill) = distill.as_object_mut() else {
                    return;
                };
                // The update's own `_meta` is a patch whose absence means
                // "unchanged". An update the run stamp did not reach still
                // has to say whether its bridge sent one, now that ours is
                // on it (see `Inner::stamp_run_update`).
                distill.entry("compactionMetaPatch").or_insert_with(|| {
                    let mut patch = json!({});
                    if let Some(meta) = bridge_meta {
                        patch["value"] = meta;
                    }
                    patch
                });
                distill.insert("contextUsage".into(), usage);
                update.insert("_meta".into(), Value::Object(meta));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(used: Option<u64>, size: Option<u64>) -> Value {
        let mut update = json!({ "sessionUpdate": "usage_update" });
        if let Some(used) = used {
            update["used"] = json!(used);
        }
        if let Some(size) = size {
            update["size"] = json!(size);
        }
        json!({ "update": update })
    }

    fn compaction(status: &str) -> Value {
        json!({"update":{"sessionUpdate":"compaction_update","compactionId":"c","status":status}})
    }

    #[test]
    fn a_compaction_carries_the_window_before_it_and_the_window_after_it() {
        let mut meter = ContextMeter::default();
        meter.observe(&mut usage(Some(244_380), Some(258_400)));
        let mut started = compaction("in_progress");
        meter.observe(&mut started);
        assert_eq!(
            started["update"]["_meta"]["distill"]["contextUsage"],
            json!({"used": 244_380, "size": 258_400})
        );

        // The bridge counts again once the summary has replaced the history,
        // and names only what changed.
        meter.observe(&mut usage(Some(14_494), None));
        let mut ended = compaction("completed");
        meter.observe(&mut ended);
        assert_eq!(
            ended["update"]["_meta"]["distill"]["contextUsage"],
            json!({"used": 14_494, "size": 258_400})
        );
    }

    #[test]
    fn a_bridge_that_never_counted_its_context_gets_no_figure() {
        let mut meter = ContextMeter::default();
        meter.observe(&mut usage(None, Some(258_400)));
        let mut started = compaction("in_progress");
        meter.observe(&mut started);
        assert!(started["update"].get("_meta").is_none());
    }

    #[test]
    fn the_figure_joins_the_run_stamp_and_leaves_the_bridges_own_metadata_readable() {
        let mut meter = ContextMeter::default();
        meter.observe(&mut usage(Some(10), Some(100)));

        // Stamped by the run: the stamp already says what the bridge sent.
        let mut stamped = compaction("completed");
        stamped["update"]["_meta"] = json!({
            "jetbrains": {"air": {"contextCompaction": {"preTokens": 9}}},
            "distill": {"runId": "run", "compactionMetaPatch": {"value": {"kept": true}}}
        });
        meter.observe(&mut stamped);
        let distill = &stamped["update"]["_meta"]["distill"];
        assert_eq!(distill["runId"], "run");
        assert_eq!(
            distill["compactionMetaPatch"],
            json!({"value": {"kept": true}})
        );
        assert_eq!(distill["contextUsage"]["used"], 10);
        assert_eq!(
            stamped["update"]["_meta"]["jetbrains"]["air"]["contextCompaction"]["preTokens"],
            9
        );

        // Outside a run: an omitted `_meta` stays an omission, a null stays a
        // null, and a patch stays the patch it was.
        let mut omitted = compaction("completed");
        meter.observe(&mut omitted);
        assert_eq!(
            omitted["update"]["_meta"]["distill"]["compactionMetaPatch"],
            json!({})
        );
        let mut cleared = compaction("completed");
        cleared["update"]["_meta"] = Value::Null;
        meter.observe(&mut cleared);
        assert_eq!(
            cleared["update"]["_meta"]["distill"]["compactionMetaPatch"],
            json!({"value": null})
        );
        let mut patched = compaction("completed");
        patched["update"]["_meta"] = json!({"facts": 1});
        meter.observe(&mut patched);
        assert_eq!(
            patched["update"]["_meta"]["distill"]["compactionMetaPatch"],
            json!({"value": {"facts": 1}})
        );
    }
}
