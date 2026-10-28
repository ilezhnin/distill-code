//! Steering uses provider acknowledgement, never an in-memory next-turn queue.
use super::*;

pub(super) struct PendingSteer {
    message_id: String,
    run_id: String,
    blocks: Vec<Value>,
    delivered: Arc<AtomicBool>,
}

fn delivery_update(session_id: &str, message_id: &str, delivery: &str) -> Value {
    json!({"sessionId": session_id, "update": {
        "sessionUpdate": "session_info_update",
        "_meta": {"steeringDelivery": {"messageId": message_id, "delivery": delivery}}
    }})
}

pub(super) fn acknowledge_echo(
    pending: &mut Vec<PendingSteer>,
    received_run: Option<&str>,
    params: &mut Value,
) -> Option<String> {
    if params
        .pointer("/update/sessionUpdate")
        .and_then(Value::as_str)
        != Some("user_message_chunk")
    {
        return None;
    }
    let content = params.pointer("/update/content")?;
    let matching = pending.iter_mut().find_map(|entry| {
        if received_run != Some(entry.run_id.as_str()) {
            return None;
        }
        let index = entry.blocks.iter().position(|block| {
            // Echoes may add provider annotations. Match the actual payload.
            ["type", "text", "data", "mimeType", "resource", "uri"]
                .iter()
                .all(|key| block.get(key) == content.get(key))
        })?;
        entry.blocks.remove(index);
        let first = !entry.delivered.swap(true, Ordering::SeqCst);
        Some((entry.message_id.clone(), first))
    });
    if let Some((message_id, first)) = matching {
        *params = delivery_update(
            params["sessionId"].as_str().unwrap_or_default(),
            &message_id,
            "steer",
        );
        pending.retain(|entry| !entry.blocks.is_empty());
        return first.then_some(message_id);
    }
    None
}

impl Inner {
    pub async fn steer(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let lock = self.attach_lock(&session_id).await;
        let _guard = lock.lock().await;
        let prompt = params.get("prompt").cloned().unwrap_or(Value::Null);
        let blocks = prompt
            .as_array()
            .filter(|blocks| !blocks.is_empty())
            .ok_or_else(|| invalid_params("Non-empty prompt required"))?;
        let ids = TurnIds::new();
        let queued =
            || json!({"runId": ids.run_id, "messageId": ids.message_id, "delivery": "queued"});
        let (route, bridge_session_id, generation, run_id, harness) = {
            let mut sessions = self.sessions.lock().await;
            if self.shutdown_prepared.load(Ordering::SeqCst) {
                return Err(invalid_params("Flock is closing"));
            }
            let Some(runtime) = sessions.get_mut(&session_id) else {
                return Ok(queued());
            };
            let Some(run) = &runtime.run else {
                return Ok(queued());
            };
            runtime
                .native_steers
                .retain(|entry| entry.run_id == run.run_id);
            let expected = params["expectedRunId"].as_str().unwrap_or_default();
            if expected != run.run_id && expected != "__flock_unknown_active_run__" {
                return Err(protocol::error_with_data(
                    protocol::INVALID_PARAMS,
                    format!("expected run `{expected}` but found `{}`", run.run_id),
                    json!({"actualRunId": run.run_id}),
                ));
            }
            let Some((route, bridge_session_id, generation)) = runtime.route() else {
                return Ok(queued());
            };
            if runtime.execution_profile.is_some() || runtime.native_steers.len() >= 64 {
                return Ok(queued());
            }
            (
                route,
                bridge_session_id,
                generation,
                run.run_id.clone(),
                runtime.harness.clone(),
            )
        };
        let Some(bridge) = self.live_bridge(&route).await else {
            return Ok(queued());
        };
        // Claude's extension can refuse idle injection without starting an
        // unowned turn. The installed Codex bridge cannot: its startedNewTurn
        // outcome has no completion response. Keep that input in the durable
        // renderer queue until this lifecycle is supported by its adapter.
        if harness != "claude-acp"
            || !bridge.supports_steering()
            || bridge.generation() != generation
        {
            return Ok(queued());
        }
        let mut meta = params
            .get("_meta")
            .cloned()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        meta["nativeSteering"] = json!(true);
        // Save before dispatch. A crash or uncertain transport outcome must
        // leave inspectable input, not silently retry a possibly executed steer.
        let recorded = self
            .record_user_prompt(&session_id, &prompt, &meta, &ids, false)
            .await?;
        let delivered = Arc::new(AtomicBool::new(false));
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.get_mut(&session_id) {
                // Input already has a durable transcript position. Stream its
                // continuation under a separate reply id even when the adapter
                // consumes the SDK echo internally (Claude does).
                if let Some(run) = runtime.run.as_mut().filter(|run| run.run_id == run_id) {
                    run.assistant_message_id = format!("{}:reply", ids.message_id);
                }
                runtime.native_steers.push(PendingSteer {
                    message_id: ids.message_id.clone(),
                    run_id: run_id.clone(),
                    blocks: blocks.clone(),
                    delivered: Arc::clone(&delivered),
                });
            }
        }
        meta["steering"] = json!({"idleBehavior": "promptRequired"});
        let response = bridge
            .request_within(
                "_session/steering",
                json!({"sessionId": bridge_session_id, "prompt": prompt, "_meta": meta}),
                Some(std::time::Duration::from_secs(30)),
            )
            .await;
        let _ = self.drain_bridge_events().await;
        let outcome = response
            .as_ref()
            .ok()
            .and_then(|value| value["outcome"].as_str());
        if outcome == Some("promptRequired") && !delivered.load(Ordering::SeqCst) {
            if let Some(recorded) = recorded {
                self.store
                    .discard_prompt(&session_id, &recorded.event_ids, &recorded.undo)
                    .await
                    .map_err(protocol::internal)?;
            }
            if let Some(runtime) = self.sessions.lock().await.get_mut(&session_id) {
                runtime
                    .native_steers
                    .retain(|entry| entry.message_id != ids.message_id);
            }
            return Ok(queued());
        }
        let delivery = if delivered.load(Ordering::SeqCst) || outcome == Some("injected") {
            "steer"
        } else if outcome == Some("failed") {
            "steer_failed"
        } else {
            "steer_unconfirmed"
        };
        let update = delivery_update(&session_id, &ids.message_id, delivery);
        if let Err(error) = self
            .store
            .append_events(&session_id, &[update.clone()])
            .await
        {
            log::warn!("[agent-host] could not persist steering receipt: {error}");
        }
        self.notify_frontend("session/update", update);
        Ok(json!({"runId": run_id, "messageId": ids.message_id, "delivery": delivery}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> (Vec<PendingSteer>, Arc<AtomicBool>) {
        let delivered = Arc::new(AtomicBool::new(false));
        (
            vec![PendingSteer {
                message_id: "monitor-input".into(),
                run_id: "active".into(),
                blocks: vec![
                    json!({"type": "text", "text": "event"}),
                    json!({"type": "image", "data": "image", "mimeType": "image/png"}),
                ],
                delivered: Arc::clone(&delivered),
            }],
            delivered,
        )
    }

    #[test]
    fn native_echo_receipts_do_not_duplicate_input_or_use_the_active_prompt_id() {
        let (mut pending, delivered) = pending();
        let mut echo = json!({"sessionId": "bridge-session", "update": {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "event", "annotations": {"audience": ["user"]}}}});
        acknowledge_echo(&mut pending, Some("active"), &mut echo);
        assert_eq!(
            echo,
            delivery_update("bridge-session", "monitor-input", "steer")
        );
        assert!(delivered.load(Ordering::SeqCst));
        assert_eq!(pending[0].blocks.len(), 1);
        echo = json!({"sessionId": "bridge-session", "update": {"sessionUpdate": "user_message_chunk", "content": {"type": "image", "data": "image", "mimeType": "image/png"}}});
        acknowledge_echo(&mut pending, Some("active"), &mut echo);
        assert!(pending.is_empty());
        assert_eq!(
            echo.pointer("/update/_meta/steeringDelivery/messageId"),
            Some(&json!("monitor-input"))
        );
    }

    #[test]
    fn unrelated_updates_cannot_confirm_pending_input() {
        let (mut pending, delivered) = pending();
        for (kind, text) in [
            ("agent_message_chunk", "event"),
            ("user_message_chunk", "different input"),
        ] {
            let mut update = json!({"sessionId": "bridge-session", "update": {"sessionUpdate": kind, "content": {"type": "text", "text": text}}});
            let original = update.clone();
            acknowledge_echo(&mut pending, Some("active"), &mut update);
            assert_eq!(update, original);
        }
        assert!(!delivered.load(Ordering::SeqCst));
        assert_eq!(pending[0].blocks.len(), 2);
    }

    #[test]
    fn saved_pending_input_stays_unconfirmed_until_a_receipt_survives_replay() {
        let ids = TurnIds::new();
        let events = Inner::user_prompt_events(
            "session",
            &json!([{ "type": "text", "text": "event" }]),
            &json!({"nativeSteering": true, "origin": "distillctl_cross_session", "distillDeliveryId": "idempotency-key"}),
            &ids,
            "now",
            false,
        );
        assert_eq!(
            events[0].pointer("/update/_meta/distill/delivery"),
            Some(&json!("steer_unconfirmed"))
        );
        assert_eq!(
            events[0].pointer("/update/_meta/distillDeliveryId"),
            Some(&json!("idempotency-key"))
        );
        assert!(events[0].pointer("/update/_meta/distill/steer").is_none());
    }
}
