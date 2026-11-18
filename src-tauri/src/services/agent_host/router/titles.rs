//! Naming an untitled session.
use super::*;

impl Inner {
    /// Have a chat nothing has named yet summarized, in the background, by its
    /// own harness and model from the message starting this turn. The
    /// renderer shows its own title from
    /// that message meanwhile; a summary that fails leaves the chat untitled,
    /// so the next message tries again. Hidden sessions are never shown, so
    /// they are not named.
    pub(super) fn name_untitled_session(self: &Arc<Self>, record: &SessionRecord, prompt: &Value) {
        if record.title.is_some() || record.user_set_name || record.hidden {
            return;
        }
        let text = Self::prompt_text(prompt);
        if text.trim().is_empty() {
            return;
        }
        let host = Arc::clone(self);
        let session_id = record.id.clone();
        let harness_id = record.harness.clone();
        let account_id = record.account_id.clone();
        let model_id = record.model_id.clone();
        tokio::spawn(async move {
            match host
                .summarize_title(
                    &harness_id,
                    account_id.as_deref(),
                    model_id.as_deref(),
                    &text,
                )
                .await
            {
                Ok(Some(title)) => host.apply_host_title(&session_id, &title).await,
                Ok(None) => {
                    log::info!("[agent-host] the title summary for {session_id} came back empty")
                }
                Err(error) => log::info!(
                    "[agent-host] no title summary for {session_id}: {}",
                    error_text(&error)
                ),
            }
        });
    }

    /// Store a title the host chose and show it, unless the user has named
    /// the chat in the meantime.
    pub(super) async fn apply_host_title(&self, session_id: &str, title: &str) {
        match self.store.set_agent_title(session_id, title).await {
            Ok(true) => self.notify_frontend(
                "session/update",
                json!({
                    "sessionId": session_id,
                    "update": { "sessionUpdate": "session_info_update", "title": title },
                }),
            ),
            Ok(false) => {}
            Err(error) => log::warn!("[agent-host] failed to store the chat title: {error}"),
        }
    }

    /// Ask the chat's own harness and model for a few-word title in a
    /// throwaway session (see `session_title::naming_session_params`), then
    /// end it: deleted where the bridge keeps sessions and allows that, closed
    /// otherwise. `Ok(None)` when the answer held nothing usable.
    pub(super) async fn summarize_title(
        &self,
        harness_id: &str,
        account_id: Option<&str>,
        model_id: Option<&str>,
        user_text: &str,
    ) -> Result<Option<String>, Value> {
        let bridge = self.ensure_account_bridge(harness_id, account_id).await?;
        let cwd = dirs::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string());
        let opened = tokio::time::timeout(
            session_title::TITLE_TIMEOUT,
            bridge.request(
                "session/new",
                session_title::naming_session_params(harness_id, &cwd, model_id),
            ),
        )
        .await
        .map_err(|_| protocol::internal("the naming session did not open in time"))??;
        let naming_id = protocol::session_id(&opened)
            .ok_or_else(|| protocol::internal("bridge returned no sessionId"))?;
        let key = Self::naming_key(&account_route_key(harness_id, account_id), &naming_id);
        if let Ok(mut replies) = self.naming_replies.lock() {
            replies.insert(key.clone(), String::new());
            self.activity_generations
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .record(harness_id, account_id);
        }
        let keeps_no_transcript = session_title::keeps_no_transcript(harness_id);
        // Claude Code's naming session is opened on the model
        // (`naming_session_params`); the others take it after opening.
        if let (Some(model_id), false) = (model_id, keeps_no_transcript) {
            let snapshot = Self::snapshot_from(&opened);
            if let Err(error) =
                Self::apply_title_model(&bridge, &naming_id, model_id, &snapshot).await
            {
                log::info!(
                    "[agent-host] the naming session stays on its default model: {}",
                    error_text(&error)
                );
            }
        }
        let asked = tokio::time::timeout(
            session_title::TITLE_TIMEOUT,
            bridge.request(
                "session/prompt",
                json!({
                    "sessionId": naming_id,
                    "prompt": session_title::naming_prompt(user_text),
                }),
            ),
        )
        .await;
        if asked.is_err() {
            bridge.notify("session/cancel", json!({ "sessionId": naming_id }));
        }
        self.drain_bridge_events().await?;
        let reply = self
            .naming_replies
            .lock()
            .ok()
            .and_then(|mut replies| replies.remove(&key))
            .unwrap_or_default();
        let ending = if !keeps_no_transcript && bridge.supports_session_capability("delete") {
            "session/delete"
        } else {
            "session/close"
        };
        let ended = tokio::time::timeout(
            session_title::TITLE_TIMEOUT,
            bridge.request(ending, json!({ "sessionId": naming_id })),
        )
        .await;
        if !matches!(ended, Ok(Ok(_))) {
            log::info!(
                "[agent-host] the naming session {naming_id} did not end cleanly ({ending})"
            );
        }
        match asked {
            Ok(Ok(_)) => Ok(session_title::clean_summary(&reply)),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(protocol::internal("the title summary timed out")),
        }
    }

    /// Put a naming session on the chat's own model and on nothing else. A
    /// title is three words long: it is written by the model the chat runs on
    /// so it reads like the chat, but never at that chat's effort or in its
    /// fast mode, and a stored id that still folds an effort into the model's
    /// name contributes only the model half.
    pub(super) async fn apply_title_model(
        bridge: &Bridge,
        naming_id: &str,
        model_id: &str,
        snapshot: &Value,
    ) -> Result<Value, Value> {
        if !Self::has_model_option(snapshot) {
            return bridge
                .request(
                    "session/set_model",
                    json!({ "sessionId": naming_id, "modelId": model_id }),
                )
                .await;
        }
        let model_id = Self::split_effort_model(snapshot, model_id)
            .map(|split| split.model)
            .unwrap_or_else(|| model_id.to_string());
        bridge
            .request(
                "session/set_config_option",
                json!({
                    "sessionId": naming_id,
                    "configId": Self::model_option_id(snapshot),
                    "value": model_id,
                }),
            )
            .await
    }

    /// Collect a naming session's reply text (see `summarize_title`).
    pub(super) fn capture_naming_reply(
        &self,
        harness: &str,
        bridge_session_id: &str,
        params: &Value,
    ) {
        let Some(text) = session_title::agent_message_text(params) else {
            return;
        };
        if let Ok(mut replies) = self.naming_replies.lock() {
            if let Some(reply) = replies.get_mut(&Self::naming_key(harness, bridge_session_id)) {
                reply.push_str(text);
            }
        }
    }
}
