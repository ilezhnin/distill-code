//! Putting a session on the model, effort and fast mode it is meant to run with.
use super::*;

impl Inner {
    pub(super) async fn forward(
        self: &Arc<Self>,
        method: &str,
        mut params: Value,
    ) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let record = self.session_record(&session_id).await?;
        let (bridge, bridge_session_id) = self.attach_session(&record).await?;
        params["sessionId"] = json!(bridge_session_id);
        let mut result = bridge.request(method, params).await?;
        if let Some(object) = result.as_object_mut() {
            if object.contains_key("sessionId") {
                object.insert("sessionId".to_string(), json!(session_id));
            }
        }
        Ok(result)
    }

    /// What putting a bridge session on `model_id` takes (see `apply_model`),
    /// decided from the options the bridge last stated and nothing else.
    pub(super) fn model_write(snapshot: &Value, model_id: &str) -> ModelWrite {
        if !Self::has_model_option(snapshot) {
            return ModelWrite::SetModel;
        }
        match Self::split_effort_model(snapshot, model_id) {
            Some(split) => ModelWrite::Folded(split),
            None => ModelWrite::ConfigOption {
                config_id: Self::model_option_id(snapshot).to_string(),
                model: model_id.to_string(),
            },
        }
    }

    /// Put a bridge session on `model_id`: one `set_config_option` under the
    /// bridge's own model option id, carrying the bridge's own model id.
    ///
    /// The other two arms are for what the ACP bridges are, not for what
    /// Flock sends. A bridge with no model option takes the older
    /// `session/set_model` — and only such a bridge may: codex's
    /// `unstable_setSessionModel` insists on `model[effort]` and throws on a
    /// base id, which is why that arm is behind `has_model_option` rather than
    /// behind a per-harness rule. A folded id is legacy inbound tolerance
    /// (`split_effort_model`): it arrives from history, never from us, and is
    /// sent as the two values the bridge actually keeps.
    pub(super) async fn apply_model(
        &self,
        bridge: &Bridge,
        bridge_session_id: &str,
        model_id: &str,
        snapshot: &Value,
    ) -> Result<Value, Value> {
        match Self::model_write(snapshot, model_id) {
            ModelWrite::SetModel => {
                bridge
                    .request(
                        "session/set_model",
                        json!({ "sessionId": bridge_session_id, "modelId": model_id }),
                    )
                    .await
            }
            ModelWrite::ConfigOption { config_id, model } => {
                bridge
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId": bridge_session_id,
                            "configId": config_id,
                            "value": model,
                        }),
                    )
                    .await
            }
            ModelWrite::Folded(split) => {
                bridge
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId": bridge_session_id,
                            "configId": Self::model_option_id(snapshot),
                            "value": split.model,
                        }),
                    )
                    .await?;
                bridge
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId": bridge_session_id,
                            "configId": split.effort_option,
                            "value": split.effort,
                        }),
                    )
                    .await
            }
        }
    }

    /// Put a bridge session on the model, effort and fast mode a chat is meant
    /// to run with (see `apply_selection`), routing the model step through
    /// `apply_model` so a bridge with no model option — and a stored id that
    /// still folds an effort into a model's name — are both still served.
    pub(super) async fn apply_to_session(
        &self,
        harness_id: &str,
        bridge: &Arc<Bridge>,
        bridge_session_id: &str,
        snapshot: &mut Value,
        wanted: &Selection,
        assert_model: bool,
    ) -> Vec<Value> {
        // The model is always the first step, so `apply_model` reads the
        // session exactly as the bridge last described it.
        let opening = Arc::new(snapshot.clone());
        Self::apply_selection(
            harness_id,
            snapshot,
            wanted,
            assert_model,
            |role, request| {
                let host = self;
                let bridge = Arc::clone(bridge);
                let session = bridge_session_id.to_string();
                let opening = Arc::clone(&opening);
                async move {
                    match role {
                        OptionRole::Model => {
                            let model_id = request["value"].as_str().unwrap_or_default();
                            host.apply_model(&bridge, &session, model_id, &opening)
                                .await
                        }
                        _ => {
                            let mut params = request;
                            params["sessionId"] = json!(session);
                            bridge.request("session/set_config_option", params).await
                        }
                    }
                }
            },
        )
        .await
    }

    /// Put a session on the model, effort and fast mode a chat is meant to run
    /// with, in the only order that works: the model first, then the two knobs
    /// that belong to it. A step is skipped unless the options the bridge
    /// answered the previous one with advertise that option and list that
    /// value, and every answer is folded into `snapshot`, so each step reads
    /// what the bridge said after the one before it.
    ///
    /// Nothing here fails. A bridge that refuses one of the three is recorded
    /// in the returned `_meta.substitutions` entries and the sequence carries
    /// on: an attach must never fall over because a model stopped offering an
    /// effort level, and the chat's stored intent stays as it is so the next
    /// model that offers it gets it back.
    ///
    /// `write` sends one option write and answers with the bridge's own option
    /// list, under the bridge's own option id — the host classifies a write by
    /// role to know what it means, never to rename it.
    pub(super) async fn apply_selection<W, WFut>(
        harness_id: &str,
        snapshot: &mut Value,
        wanted: &Selection,
        assert_model: bool,
        mut write: W,
    ) -> Vec<Value>
    where
        W: FnMut(OptionRole, Value) -> WFut,
        WFut: std::future::Future<Output = Result<Value, Value>>,
    {
        let wanted = Self::unfold_speed_selection(harness_id, snapshot, wanted);
        let mut substitutions = Vec::new();
        if let Some(model_id) = wanted.model.as_deref() {
            // A model the harness runs only in a session opened on it is
            // asserted even where the bridge lists no such value:
            // claude-agent-acp answers `session/new` with
            // `_meta.claudeCode.options.model` still reporting `default`, and
            // until the assert its effort and fast options describe that alias
            // instead — which is how Opus 4.6 came to advertise an `xhigh` it
            // does not have and a fast toggle it does not offer.
            let offered = assert_model || Self::lists_model(snapshot, model_id);
            if Self::current_model(snapshot).as_deref() != Some(model_id) {
                if offered {
                    let request =
                        json!({ "configId": Self::model_option_id(snapshot), "value": model_id });
                    let mut answer = write(OptionRole::Model, request.clone()).await;
                    // A refusal that says to try again is no substitution
                    // yet: the same write goes again in this session.
                    for pause in MODEL_RETRY_PAUSES {
                        if !answer.as_ref().is_err_and(asks_again) {
                            break;
                        }
                        log::info!(
                            "[agent-host] {harness_id} asks to try {model_id} again; asking in {} ms",
                            pause.as_millis()
                        );
                        tokio::time::sleep(pause).await;
                        answer = write(OptionRole::Model, request.clone()).await;
                    }
                    match answer {
                        Ok(answer) => {
                            Self::take_options(snapshot, &answer);
                            Self::capture_reported(snapshot, &answer, Some(OptionRole::Model));
                            // A bridge that also lists models reports the
                            // chosen one there and answers the write itself
                            // with nothing.
                            if let Some(models) =
                                snapshot.get_mut("models").and_then(Value::as_object_mut)
                            {
                                models.insert("currentModelId".to_string(), json!(model_id));
                            }
                            // A stored id that still folds an effort into the
                            // model's name is applied as the two halves its
                            // bridge keeps apart (legacy inbound only — see
                            // `split_effort_model`), and the bridge names the
                            // model half back. That is the model that was
                            // asked for, not one substituted for it.
                            let asked = Self::split_effort_model(snapshot, model_id)
                                .map(|split| split.model)
                                .unwrap_or_else(|| model_id.to_string());
                            Self::hold_declared_model(harness_id, &asked, snapshot);
                            let applied = Self::current_model(snapshot);
                            if applied.as_deref() != Some(asked.as_str()) {
                                substitutions.push(Self::substitution(
                                    "model",
                                    model_id,
                                    applied.as_deref(),
                                    format!("not offered by {harness_id}"),
                                ));
                            }
                        }
                        Err(error) => {
                            Self::capture_reported(snapshot, &Value::Null, Some(OptionRole::Model));
                            let reason = error_text(&error);
                            log::info!(
                                "[agent-host] {harness_id} would not run {model_id}: {reason}"
                            );
                            substitutions.push(Self::substitution(
                                "model",
                                model_id,
                                Self::current_model(snapshot).as_deref(),
                                reason,
                            ));
                        }
                    }
                } else {
                    substitutions.push(Self::substitution(
                        "model",
                        model_id,
                        Self::current_model(snapshot).as_deref(),
                        format!("not offered by {harness_id}"),
                    ));
                }
            }
        }
        // The model the remaining two belong to, as it is now: both are its
        // own, and a model that does not offer one is what the entry names.
        let model = Self::current_model(snapshot).unwrap_or_else(|| harness_id.to_string());
        if let Some(effort) = wanted.effort.as_deref() {
            match Self::effort_state(snapshot, effort) {
                // The model has no effort control at all (claude on haiku).
                None => substitutions.push(Self::substitution(
                    "effort",
                    effort,
                    None,
                    format!("{model} has no effort control"),
                )),
                Some((_, current, _)) if current.as_deref() == Some(effort) => {}
                Some((_, current, false)) => substitutions.push(Self::substitution(
                    "effort",
                    effort,
                    current.as_deref(),
                    format!("not offered by {model}"),
                )),
                Some((config_id, _, true)) => {
                    let request = json!({ "configId": config_id, "value": effort });
                    match write(OptionRole::Effort, request).await {
                        Ok(answer) => {
                            Self::take_options(snapshot, &answer);
                            Self::capture_reported(snapshot, &answer, Some(OptionRole::Effort));
                            let applied = Self::effort_state(snapshot, effort)
                                .and_then(|(_, current, _)| current);
                            if applied.as_deref() != Some(effort) {
                                substitutions.push(Self::substitution(
                                    "effort",
                                    effort,
                                    applied.as_deref(),
                                    format!("not offered by {model}"),
                                ));
                            }
                        }
                        Err(error) => {
                            Self::capture_reported(
                                snapshot,
                                &Value::Null,
                                Some(OptionRole::Effort),
                            );
                            let reason = error_text(&error);
                            log::info!("[agent-host] {harness_id} kept its effort: {reason}");
                            substitutions.push(Self::substitution("effort", effort, None, reason));
                        }
                    }
                }
            }
        }
        if let Some(fast) = wanted.fast {
            match Self::fast_state(snapshot) {
                // A model without this control already runs with fast mode off.
                None if !fast => {}
                // Writing a fast toggle a model does not have answers
                // "Unknown config option: fast"; the intent survives for the
                // next model that offers one.
                None => substitutions.push(Self::substitution(
                    "fast",
                    Self::fast_word(fast),
                    None,
                    format!("{model} has no fast mode"),
                )),
                Some((_, current, _)) if current == Some(fast) => {}
                Some((config_id, _, boolean)) => {
                    let request = if boolean {
                        // The ACP boolean arm is a discriminated union and is
                        // rejected without its `type`.
                        json!({ "configId": config_id, "value": fast, "type": "boolean" })
                    } else {
                        json!({ "configId": config_id, "value": Self::fast_word(fast) })
                    };
                    match write(OptionRole::Fast, request).await {
                        Ok(answer) => {
                            Self::take_options(snapshot, &answer);
                            Self::capture_reported(snapshot, &answer, Some(OptionRole::Fast));
                            let applied = Self::fast_state(snapshot).and_then(|(_, on, _)| on);
                            if !execution::fast_mode_acknowledged(Some(fast), applied) {
                                substitutions.push(Self::substitution(
                                    "fast",
                                    Self::fast_word(fast),
                                    applied.map(Self::fast_word),
                                    format!("not offered by {model}"),
                                ));
                            }
                        }
                        Err(error) => {
                            Self::capture_reported(snapshot, &Value::Null, Some(OptionRole::Fast));
                            let reason = error_text(&error);
                            log::info!("[agent-host] {harness_id} kept its fast mode: {reason}");
                            substitutions.push(Self::substitution(
                                "fast",
                                Self::fast_word(fast),
                                None,
                                reason,
                            ));
                        }
                    }
                }
            }
        }
        // The effort and fast answers restate the model under the bridge's
        // own id again.
        if let Some(model_id) = wanted.model.as_deref() {
            Self::hold_declared_model(harness_id, model_id, snapshot);
        }
        substitutions
    }

    pub(super) fn unfold_speed_selection(
        harness_id: &str,
        snapshot: &Value,
        wanted: &Selection,
    ) -> Selection {
        let mut wanted = wanted.clone();
        if harness_id == "zai-acp" {
            if let Some(model) = wanted.model.as_deref() {
                if let Some(base) =
                    crate::services::agent_host::zai::highspeed_base(model).filter(|base| {
                        !Self::lists_model(snapshot, model) && Self::lists_model(snapshot, base)
                    })
                {
                    wanted.model = Some(base.to_string());
                    wanted.fast.get_or_insert(true);
                }
            }
        }
        wanted
    }

    /// What a bridge did differently from what was asked of it, read off one
    /// answer rather than a sequence: an entry per selection whose read-back
    /// value is not the requested one, with `applied: null` where the model
    /// turned out to have no such control. Only ever called with an answer
    /// that stated its options — one that states none teaches nothing and
    /// must not read as a refusal.
    pub(super) fn substitutions_for(wanted: &Selection, applied: &Selection) -> Vec<Value> {
        let model = applied.model.clone().or_else(|| wanted.model.clone());
        let named = model.as_deref().unwrap_or("the model");
        let mut out = Vec::new();
        if let Some(requested) = wanted.model.as_deref() {
            if let Some(got) = applied.model.as_deref().filter(|got| *got != requested) {
                out.push(Self::substitution(
                    "model",
                    requested,
                    Some(got),
                    format!("the agent is on {got}"),
                ));
            }
        }
        if let Some(requested) = wanted.effort.as_deref() {
            if applied.effort.as_deref() != Some(requested) {
                let reason = match applied.effort {
                    Some(_) => format!("not offered by {named}"),
                    None => format!("{named} has no effort control"),
                };
                out.push(Self::substitution(
                    "effort",
                    requested,
                    applied.effort.as_deref(),
                    reason,
                ));
            }
        }
        if let Some(requested) = wanted.fast {
            if !execution::fast_mode_acknowledged(Some(requested), applied.fast) {
                let reason = match applied.fast {
                    Some(_) => format!("not offered by {named}"),
                    None => format!("{named} has no fast mode"),
                };
                out.push(Self::substitution(
                    "fast",
                    Self::fast_word(requested),
                    applied.fast.map(Self::fast_word),
                    reason,
                ));
            }
        }
        out
    }

    pub(super) async fn set_config_option(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let config_id = params
            .get("configId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let record = self.session_record(&session_id).await?;
        if config_id == "provider" {
            let requested = params.get("value").and_then(Value::as_str).unwrap_or("");
            if requested != record.harness {
                return self.move_to_harness(&session_id, requested).await;
            }
        }
        if config_id == "model" {
            let model_id = params.get("value").and_then(Value::as_str).unwrap_or("");
            if let Some(current) = record.account_id.as_deref() {
                if let Some(serving) = self
                    .account_for_model(&record.harness, current, model_id)
                    .await
                {
                    return self
                        .move_session_to_account(&session_id, &serving, Some(model_id))
                        .await;
                }
            }
        }
        let (bridge, bridge_session_id) = self.attach_session(&record).await?;
        let (mut snapshot, has_model_option, standing) = {
            let sessions = self.sessions.lock().await;
            let runtime = sessions
                .get(&session_id)
                .ok_or_else(|| protocol::internal("session vanished"))?;
            (
                runtime.snapshot.clone(),
                runtime.has_model_option,
                runtime.substitutions.clone(),
            )
        };
        // What this write turned out to mean, when it meant one of the three
        // selections at all. A write about something else — a mode, an agent —
        // says nothing about them, so what a model would not do before it
        // still stands.
        let mut written: Option<Vec<Value>> = None;
        match config_id.as_str() {
            // Already on the requested harness (a move returned above).
            "provider" => {}
            "model" => {
                let model_id = params
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if Self::opens_on_model(&record.harness, &snapshot, &model_id) {
                    return self.reopen_on_model(&session_id, &model_id).await;
                }
                // An in-flight or failed write is not confirmation that the
                // previous value still applies.
                self.invalidate_reported_write(&session_id, OptionRole::Model)
                    .await;
                let result = self
                    .apply_model(&bridge, &bridge_session_id, &model_id, &snapshot)
                    .await?;
                Self::capture_reported(&mut snapshot, &result, Some(OptionRole::Model));
                if has_model_option {
                    if let Some(options) = result.get("configOptions") {
                        snapshot["configOptions"] = options.clone();
                    }
                }
                // A bridge that also lists models reports the chosen id there.
                if let Some(models) = snapshot.get_mut("models").and_then(Value::as_object_mut) {
                    models.insert("currentModelId".to_string(), json!(model_id));
                }
                // A model change moves the other two knobs with it: codex
                // clamps the effort to the new model's default and claude
                // drops it to `default`, both without saying so. Store what
                // the bridge answered, not what was asked for.
                let acknowledged = Self::selection_from(&result["configOptions"]);
                let _ = self
                    .store
                    .set_model(
                        &session_id,
                        Some(acknowledged.model.as_deref().unwrap_or(&model_id)),
                    )
                    .await;
                if result.get("configOptions").is_some() {
                    let _ = self
                        .store
                        .set_run_settings(
                            &session_id,
                            acknowledged.effort.as_deref(),
                            acknowledged.fast,
                        )
                        .await;
                    // What the chat was running at is what it asked to keep;
                    // the host does not write it back — putting a downgraded
                    // value where a model offers one again is the renderer's
                    // to decide — but a downgrade nobody is told about is how
                    // a chat quietly drops from xhigh to medium.
                    let wanted = Selection {
                        model: Some(model_id),
                        effort: record.reasoning_effort.clone(),
                        fast: record.fast_mode,
                    };
                    written = Some(Self::substitutions_for(
                        &Self::unfold_speed_selection(&record.harness, &snapshot, &wanted),
                        &acknowledged,
                    ));
                }
            }
            _ => {
                self.invalidate_reported_write(
                    &session_id,
                    Self::option_role(&snapshot, &config_id),
                )
                .await;
                let result = bridge
                    .request(
                        "session/set_config_option",
                        Self::forwarded_config_write(&params, &bridge_session_id),
                    )
                    .await?;
                let role = Self::write_role(&snapshot, &result, &config_id);
                Self::capture_reported(&mut snapshot, &result, Some(role));
                // The write went out under the bridge's own id and value
                // shape; only what it means to this session is ours. An answer
                // with no options at all states nothing, so nothing moves.
                if let Some(options) = result.get("configOptions") {
                    let held = Self::current_model(&snapshot);
                    snapshot["configOptions"] = options.clone();
                    // An effort or fast answer restates the model under the
                    // bridge's own id; the session keeps the one it holds.
                    if let Some(held) = held {
                        Self::hold_declared_model(&record.harness, &held, &mut snapshot);
                    }
                    let acknowledged = Self::selection_from(&snapshot["configOptions"]);
                    // A bridge answers a write it cannot honour with the value
                    // it kept, not with an error.
                    let requested = params.get("value").unwrap_or(&Value::Null);
                    let stored = match role {
                        OptionRole::Effort => {
                            let wanted = Selection {
                                effort: requested.as_str().map(str::to_string),
                                ..Selection::default()
                            };
                            written = Some(Self::substitutions_for(&wanted, &acknowledged));
                            self.store
                                .set_reasoning_effort(&session_id, acknowledged.effort.as_deref())
                                .await
                        }
                        OptionRole::Fast => {
                            let wanted = Selection {
                                fast: Self::fast_enabled(requested),
                                ..Selection::default()
                            };
                            written = Some(Self::substitutions_for(&wanted, &acknowledged));
                            self.store
                                .set_fast_mode(&session_id, acknowledged.fast)
                                .await
                        }
                        // A harness naming its model option something other
                        // than `model` (none of the three live ones do).
                        OptionRole::Model => match acknowledged.model.as_deref() {
                            Some(model_id) => {
                                self.store.set_model(&session_id, Some(model_id)).await
                            }
                            None => Ok(()),
                        },
                        // A mode, an agent, a verbosity: none of the three, so
                        // what a model would not do still stands.
                        OptionRole::Other => Ok(()),
                    };
                    if let Err(error) = stored {
                        log::warn!("[agent-host] failed to store a session selection: {error}");
                    }
                }
            }
        }
        let substitutions = written.unwrap_or(standing);
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.get_mut(&session_id) {
                runtime.snapshot = snapshot.clone();
                Self::record_configuration_change(runtime);
                // The last word on this session, so a chat reopened later is
                // told the same thing — and a write the bridge did honour
                // clears a notice left by one it did not.
                runtime.substitutions = substitutions.clone();
                runtime.touch();
            }
        }
        let _ = self.store.set_snapshot(&session_id, &snapshot).await;
        Ok(Self::with_substitutions(
            Self::presented_snapshot(&record.harness, &snapshot, has_model_option),
            &substitutions,
        ))
    }
}
