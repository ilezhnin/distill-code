//! What a session offers and reports: model, effort and fast mode as its bridge names them.
use super::*;

impl Inner {
    pub(super) fn is_model_option(option: &Value) -> bool {
        option.get("id").and_then(Value::as_str) == Some("model")
            || option.get("category").and_then(Value::as_str) == Some("model")
    }

    /// Keep a session that was put on `asked` named `asked` when its bridge
    /// reports the model under the id the harness declares another name for
    /// it. Claude Code 2.1.312 runs `opus[1m]` at Opus 5.5's native 1M window
    /// and calls it `opus` (and 2.1.322 `claude-fable-5-2[1m]` `fable`): read back
    /// raw, a chat moved to Opus 5.5 took that for a substitution and fell
    /// back to the model it came from (11-01), as benchmark rows did before
    /// `acknowledge_lane`. Only a declared pairing is renamed; any other
    /// model the bridge names stands. Whether anything was renamed.
    pub(super) fn hold_declared_model(harness_id: &str, asked: &str, snapshot: &mut Value) -> bool {
        let Some(current) = Self::current_model(snapshot) else {
            return false;
        };
        if current == asked || harness::alias_target(harness_id, &current) != Some(asked) {
            return false;
        }
        if let Some(option) = snapshot["configOptions"]
            .as_array_mut()
            .and_then(|options| {
                options
                    .iter_mut()
                    .find(|option| Self::is_model_option(option))
            })
        {
            option["currentValue"] = json!(asked);
        }
        if let Some(models) = snapshot.get_mut("models").and_then(Value::as_object_mut) {
            if models.get("currentModelId").and_then(Value::as_str) == Some(current.as_str()) {
                models.insert("currentModelId".to_string(), json!(asked));
            }
        }
        true
    }

    /// Whether the bridge offers `model_id` in the session's own model list.
    pub(super) fn lists_model(snapshot: &Value, model_id: &str) -> bool {
        let in_models = snapshot
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .is_some_and(|models| models.iter().any(|model| model["modelId"] == model_id));
        Self::option_lists(snapshot, Self::is_model_option, model_id) || in_models
    }

    /// Whether a select config option picked out by `matches` offers `value`.
    pub(super) fn option_lists(snapshot: &Value, matches: fn(&Value) -> bool, value: &str) -> bool {
        snapshot["configOptions"].as_array().is_some_and(|options| {
            options
                .iter()
                .filter(|option| matches(option))
                .any(|option| {
                    option["options"].as_array().is_some_and(|choices| {
                        choices.iter().any(|choice| choice["value"] == value)
                    })
                })
        })
    }

    pub(super) fn is_effort_option(option: &Value) -> bool {
        option.get("category").and_then(Value::as_str) == Some("thought_level")
    }

    /// The role `config_id` plays in an option list the bridge itself sent.
    pub(super) fn option_role(options: &Value, config_id: &str) -> OptionRole {
        let Some(option) = options["configOptions"].as_array().and_then(|options| {
            options
                .iter()
                .find(|option| option.get("id").and_then(Value::as_str) == Some(config_id))
        }) else {
            return OptionRole::Other;
        };
        if Self::is_model_option(option) {
            OptionRole::Model
        } else if Self::is_effort_option(option) {
            OptionRole::Effort
        } else if Self::is_fast_option(option) {
            OptionRole::Fast
        } else {
            OptionRole::Other
        }
    }

    /// The role a write plays, read from the session's live snapshot and, for
    /// a session whose stored snapshot arrived with no options at all (grok's
    /// cold `session/new`), from the bridge's answer to the write itself.
    pub(super) fn write_role(snapshot: &Value, answer: &Value, config_id: &str) -> OptionRole {
        match Self::option_role(snapshot, config_id) {
            OptionRole::Other => Self::option_role(answer, config_id),
            role => role,
        }
    }

    /// What the options a bridge answered with say the session is now on. This
    /// is the acknowledgement: a bridge silently clamps an effort to the
    /// model's own default (codex) or drops it to `default` (claude), so what
    /// was asked for is never what gets stored.
    pub(super) fn selection_from(config_options: &Value) -> Selection {
        let Some(options) = config_options.as_array() else {
            return Selection::default();
        };
        let current = |matches: fn(&Value) -> bool| {
            options
                .iter()
                .find(|option| matches(option))
                .and_then(|option| option.get("currentValue"))
        };
        Selection {
            model: current(Self::is_model_option)
                .and_then(Value::as_str)
                .map(str::to_string),
            effort: current(Self::is_effort_option)
                .and_then(Value::as_str)
                .map(str::to_string),
            fast: current(Self::is_fast_option).and_then(Self::fast_enabled),
        }
    }

    /// A config write on its way to the bridge: the client's own request with
    /// nothing but the session id swapped. The option id and the value shape
    /// are the bridge's own and are never rewritten here — the host classifies
    /// a write by role to know what to store, not to rename it.
    pub(super) fn forwarded_config_write(params: &Value, bridge_session_id: &str) -> Value {
        let mut forwarded = params.clone();
        forwarded["sessionId"] = json!(bridge_session_id);
        forwarded
    }

    /// The session's effort option as one step of `apply_selection` needs it:
    /// the bridge's own id for it, the value it is on, and whether it offers
    /// the one being asked for. `None` where the model has no effort control
    /// at all, which is a different answer and has to stay different.
    pub(super) fn effort_state(
        snapshot: &Value,
        wanted: &str,
    ) -> Option<(String, Option<String>, bool)> {
        let option = snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_effort_option(option))?;
        let id = option.get("id").and_then(Value::as_str)?.to_string();
        let current = option
            .get("currentValue")
            .and_then(Value::as_str)
            .map(str::to_string);
        let offers = option["options"]
            .as_array()
            .is_some_and(|choices| choices.iter().any(|choice| choice["value"] == wanted));
        Some((id, current, offers))
    }

    /// The session's fast toggle the same way: its own id, whether it is on,
    /// and whether it takes a native boolean instead of the on/off select both
    /// live bridges send.
    pub(super) fn fast_state(snapshot: &Value) -> Option<(String, Option<bool>, bool)> {
        let option = snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_fast_option(option))?;
        let id = option.get("id").and_then(Value::as_str)?.to_string();
        let current = option.get("currentValue").and_then(Self::fast_enabled);
        let boolean = option.get("type").and_then(Value::as_str) == Some("boolean");
        Some((id, current, boolean))
    }

    /// The bridge's own id for the model option, for a write that goes out
    /// under it.
    pub(super) fn model_option_id(snapshot: &Value) -> &str {
        Self::model_option(snapshot)
            .and_then(|option| option.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("model")
    }

    pub(super) fn fast_word(enabled: bool) -> &'static str {
        if enabled {
            "on"
        } else {
            "off"
        }
    }

    /// Fold a bridge's answer to one write into the session snapshot, so the
    /// next step reads what the bridge said after this one. An answer carrying
    /// no options — or an empty list — states nothing and changes nothing:
    /// `session/set_model` answers that way.
    pub(super) fn take_options(snapshot: &mut Value, answer: &Value) {
        let stated = answer
            .get("configOptions")
            .filter(|options| options.as_array().is_some_and(|list| !list.is_empty()));
        if let Some(options) = stated {
            snapshot["configOptions"] = options.clone();
        }
    }

    /// Whether a snapshot a bridge just answered with should replace the one
    /// a session was opened with. Only one that states its options does:
    /// grok's cold `session/new` answers with its models and no
    /// `configOptions` key at all, and storing that leaves the chat's effort
    /// control looking unsupported for good. A stored snapshot that states no
    /// options either has nothing to lose, so a bridge that keeps its models
    /// outside the option list still gets through.
    pub(super) fn replaces_snapshot(fresh: &Value, stored: &Value) -> bool {
        let states_options = |snapshot: &Value| {
            snapshot["configOptions"]
                .as_array()
                .is_some_and(|options| !options.is_empty())
        };
        states_options(fresh) || !states_options(stored)
    }

    /// One selection a bridge would not take as a `_meta.substitutions` entry:
    /// what was asked for, what the session is actually on — `null` where the
    /// model has no such control at all — and why. This is the only
    /// machine-readable record of a downgrade there is: codex clamps an effort
    /// to the target model's own default and claude drops it to `default`,
    /// neither of them saying so anywhere else.
    pub(super) fn substitution(
        role: &str,
        requested: &str,
        applied: Option<&str>,
        reason: String,
    ) -> Value {
        json!({ "role": role, "requested": requested, "applied": applied, "reason": reason })
    }

    /// A presented snapshot carrying what the bridge would not do. Merged into
    /// `_meta` rather than set, since the callers name the provider there too.
    pub(super) fn with_substitutions(mut presented: Value, substitutions: &[Value]) -> Value {
        if substitutions.is_empty() {
            return presented;
        }
        let mut meta = presented
            .get("_meta")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        meta.insert("substitutions".to_string(), json!(substitutions));
        presented["_meta"] = Value::Object(meta);
        presented
    }

    /// A fast toggle's value in either shape a bridge sends it: the on/off
    /// select both live bridges use, or the native boolean an ACP client that
    /// advertises the capability would get.
    pub(super) fn fast_enabled(value: &Value) -> Option<bool> {
        match value {
            Value::Bool(enabled) => Some(*enabled),
            Value::String(text) => match text.as_str() {
                "on" | "true" | "enabled" => Some(true),
                "off" | "false" | "disabled" => Some(false),
                _ => None,
            },
            _ => None,
        }
    }

    /// `gpt-5.6-luna[low]` as the model and effort values a bridge offers in
    /// separate options instead; `None` when its model option offers the id
    /// itself, or does not offer both halves.
    ///
    /// LEGACY TOLERANCE, READ ONLY. Flock no longer names a model this way:
    /// the four selections travel separately and the renderer, the store and
    /// every answer carry the bridge's own base id. What still arrives folded
    /// is history — a chat stored before the split whose lazy conversion has
    /// not run, a renderer or a flockctl client older than protocolVersion 6 —
    /// and it reaches `apply_model` inside a send, where failing is not an
    /// option. SUNSET: this and `SplitModel` may go once no
    /// `sessions.legacy_model_id` rows remain and no pre-protocolVersion-6
    /// flockctl client is in use. Not a date: removing it earlier loses the
    /// operator's own history.
    pub(super) fn split_effort_model(snapshot: &Value, model_id: &str) -> Option<SplitModel> {
        if Self::option_lists(snapshot, Self::is_model_option, model_id) {
            return None;
        }
        let (model, effort) = model_id.strip_suffix(']')?.split_once('[')?;
        if !Self::option_lists(snapshot, Self::is_model_option, model)
            || !Self::option_lists(snapshot, Self::is_effort_option, effort)
        {
            return None;
        }
        let effort_option = snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_effort_option(option))?
            .get("id")?
            .as_str()?;
        Some(SplitModel {
            model: model.to_string(),
            effort_option: effort_option.to_string(),
            effort: effort.to_string(),
        })
    }

    /// Whether moving a session to `model_id` means reopening its bridge
    /// session on that model: one the harness runs only that way, and not in
    /// the bridge's own list.
    pub(super) fn opens_on_model(harness_id: &str, snapshot: &Value, model_id: &str) -> bool {
        harness::harness(harness_id)
            .and_then(|spec| harness::session_model_meta(spec, model_id))
            .is_some()
            && !Self::lists_model(snapshot, model_id)
    }

    /// Put a session on a model its bridge runs only when a session is opened
    /// on it: close the bridge session and open it again on that model, which
    /// resumes its history. Refused while a turn runs, since reopening would
    /// cut it off.
    pub(super) async fn reopen_on_model(
        self: &Arc<Self>,
        session_id: &str,
        model_id: &str,
    ) -> Result<Value, Value> {
        let lock = self.attach_lock(session_id).await;
        let _reopening = lock.lock().await;
        let running = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .is_some_and(|runtime| runtime.run.is_some());
        if running {
            return Err(invalid_params(
                "The model cannot change while a turn is running",
            ));
        }
        if let Some((bridge, bridge_session_id)) = self.attached_route(session_id).await {
            let closed = tokio::time::timeout(
                BRIDGE_CLOSE_TIMEOUT,
                bridge.request("session/close", json!({ "sessionId": bridge_session_id })),
            )
            .await;
            if !matches!(closed, Ok(Ok(_))) {
                log::info!(
                    "[agent-host] session {session_id} did not close cleanly before reopening"
                );
            }
        }
        self.sessions.lock().await.remove(session_id);
        self.store
            .set_model(session_id, Some(model_id))
            .await
            .map_err(protocol::internal)?;
        let record = self.session_record(session_id).await?;
        // The attach opens the new bridge session on the model and puts the
        // chat's effort and fast mode back on it, so the reopen keeps all
        // three rather than only the one that was clicked.
        self.attach_session_locked(&record).await?;
        let sessions = self.sessions.lock().await;
        let runtime = sessions
            .get(session_id)
            .ok_or_else(|| protocol::internal("session vanished"))?;
        Ok(Self::with_substitutions(
            Self::presented_snapshot(&record.harness, &runtime.snapshot, runtime.has_model_option),
            &runtime.substitutions,
        ))
    }

    pub(super) fn naming_key(harness: &str, bridge_session_id: &str) -> String {
        format!("{harness}\u{0}{bridge_session_id}")
    }

    /// Whether a bridge session is one `summarize_title` has open.
    pub(super) fn is_naming_session(&self, harness: &str, bridge_session_id: &str) -> bool {
        self.naming_replies.lock().is_ok_and(|replies| {
            replies.contains_key(&Self::naming_key(harness, bridge_session_id))
        })
    }

    /// Keep receipt provenance separate from the UI snapshot, which may also
    /// contain requested values and preserved menus. Only bridge replies enter
    /// this field; an empty acknowledgement of a write invalidates that field.
    pub(super) fn capture_reported(
        snapshot: &mut Value,
        answer: &Value,
        written: Option<OptionRole>,
    ) {
        let acknowledged = Self::selection_from(&answer["configOptions"]);
        let model = Self::current_model(answer).filter(|id| !id.trim().is_empty());
        let name = model.as_deref().and_then(|id| {
            Self::model_option(answer)
                .and_then(|option| option["options"].as_array())
                .and_then(|rows| rows.iter().find(|row| row["value"].as_str() == Some(id)))
                .or_else(|| {
                    answer
                        .pointer("/models/availableModels")
                        .and_then(Value::as_array)
                        .and_then(|rows| {
                            rows.iter().find(|row| row["modelId"].as_str() == Some(id))
                        })
                })
                .and_then(|row| row["name"].as_str())
                .map(str::to_string)
        });
        let stated = model.is_some()
            || answer["configOptions"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty());
        let reported = if written.is_none() || stated || written == Some(OptionRole::Model) {
            ReportedSelection {
                model_id: model,
                model_name: name,
                effort: acknowledged.effort,
                fast: acknowledged.fast,
            }
        } else {
            let mut previous = ReportedSelection::read(snapshot);
            match written {
                Some(OptionRole::Effort) => previous.effort = None,
                Some(OptionRole::Fast) => previous.fast = None,
                _ => {}
            }
            previous
        };
        snapshot[REPORTED_KEY] = json!(reported);
    }

    pub(super) fn record_configuration_change(runtime: &mut SessionRuntime) {
        let reported = ReportedSelection::read(&runtime.snapshot);
        let Some(run) = runtime.run.as_mut() else {
            return;
        };
        if run.configuration_changes.last() == Some(&reported) {
            return;
        }
        if run.configuration_changes.len() < 64 {
            run.configuration_changes.push(reported);
        } else {
            run.changes_truncated = true;
        }
    }

    pub(super) async fn invalidate_reported_write(&self, session_id: &str, role: OptionRole) {
        if let Some(runtime) = self.sessions.lock().await.get_mut(session_id) {
            Self::capture_reported(&mut runtime.snapshot, &Value::Null, Some(role));
            Self::record_configuration_change(runtime);
        }
    }

    pub(super) fn snapshot_from(result: &Value) -> Value {
        let mut snapshot = json!({
            "modes": result.get("modes").cloned().unwrap_or(Value::Null),
            "models": result.get("models").cloned().unwrap_or(Value::Null),
            "configOptions": result.get("configOptions").cloned().unwrap_or(Value::Array(vec![])),
        });
        Self::capture_reported(&mut snapshot, result, None);
        snapshot
    }

    pub(super) fn has_model_option(snapshot: &Value) -> bool {
        snapshot["configOptions"]
            .as_array()
            .map(|options| {
                options.iter().any(|option| {
                    option.get("id").and_then(Value::as_str) == Some("model")
                        || option.get("category").and_then(Value::as_str) == Some("model")
                })
            })
            .unwrap_or(false)
    }

    /// The model a session is on. The `model` config option's own value comes
    /// first and `models.currentModelId` is only the fallback for a bridge
    /// with no such option: a bridge that keeps both may name the model in its
    /// `models` block with the effort folded in (codex reports
    /// `gpt-6-astra[xhigh]` there while its option says `gpt-6-astra`), and
    /// that folded name is a display id the option itself refuses. Reading it
    /// first is how it used to reach `sessions.model_id`.
    pub(super) fn current_model(snapshot: &Value) -> Option<String> {
        Self::model_option(snapshot)
            .and_then(|option| option.get("currentValue"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                snapshot
                    .pointer("/models/currentModelId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
    }

    /// The renderer reads the active provider and model out of select config
    /// options. Bridges expose neither a provider option nor (always) a model
    /// option, so synthesize them from what we know.
    ///
    /// Nothing the bridge did state is renamed on the way out: a model is
    /// presented under the id its own bridge gave it, with its effort left in
    /// the effort option where the bridge keeps it. The host used to fold the
    /// two into `gpt-5.6-luna[low]` here, which made an effort click read as a
    /// model change all the way up the stack.
    pub(super) fn presented_snapshot(
        harness: &str,
        snapshot: &Value,
        has_model_option: bool,
    ) -> Value {
        let spec_label = harness::harness(harness)
            .map(|spec| spec.label)
            .unwrap_or(harness);
        let mut options: Vec<Value> = snapshot["configOptions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        options.retain(|option| option.get("id").and_then(Value::as_str) != Some("provider"));
        let provider_option = json!({
            "id": "provider",
            "name": "Agent",
            "category": "provider",
            "type": "select",
            "currentValue": harness,
            "options": [{ "value": harness, "name": spec_label }],
        });
        let mut presented = vec![provider_option];
        if !has_model_option {
            if let Some(models) = snapshot.get("models").filter(|models| !models.is_null()) {
                let current = models.get("currentModelId").cloned().unwrap_or(Value::Null);
                let choices: Vec<Value> = models["availableModels"]
                    .as_array()
                    .map(|list| {
                        list.iter()
                            .map(|model| {
                                json!({
                                    "value": model.get("modelId").cloned().unwrap_or(Value::Null),
                                    "name": model.get("name").cloned().unwrap_or(model.get("modelId").cloned().unwrap_or(Value::Null)),
                                    "description": model.get("description").cloned().unwrap_or(Value::Null),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                presented.push(json!({
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": current,
                    "options": choices,
                }));
            }
        }
        presented.extend(options);
        let mut out = snapshot.clone();
        if let Some(object) = out.as_object_mut() {
            object.remove(REPORTED_KEY);
        }
        out["configOptions"] = Value::Array(presented);
        out
    }
}
