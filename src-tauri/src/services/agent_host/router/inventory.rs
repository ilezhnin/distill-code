//! What a harness can run: model listings, probes and stored model ids.
use super::*;

impl Inner {
    /// Boxed for the same stack reason as [`Self::ensure_execution_bridge`]:
    /// a benchmark attempt checks its inventory deep inside the runner.
    pub fn benchmark_inventory<'a>(
        self: &'a Arc<Self>,
        provider: &'a str,
        account: &'a str,
        refresh: bool,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let native = NativeProvider::for_harness(provider)
                .ok_or("capability_missing: provider has no isolated benchmark runtime")?;
            let catalog = ext::model_inventory(self, provider, Some(account), refresh)
                .await
                .map_err(|error| error_text(&error))?;
            // The listing runs on a lease of the account's Flock sign-in:
            // one too short for its session below, or whose renewal waits,
            // is renewed first.
            let until = crate::services::benchmark_sandbox::admission_deadline(
                chrono::Utc::now().timestamp_millis(),
                120,
            )
            .map_err(|error| error.to_string())?
            // The listing session's lease must cover 120 s and its 480 s
            // start margin, plus a minute for the checks before it starts.
            .saturating_add(240_000);
            self.renew_app_sign_in(provider, account, until, true)
                .await?;
            let status = text_execution::readiness(native, account).await?;
            let revision = text_execution::revision(native, &status);
            let cache_key = format!(
                "{}\u{1f}{revision}\u{1f}{}",
                account_route_key(provider, Some(account)),
                execution::digest(execution::canonical_json(&catalog["models"]))
            );
            let inventory_lock = self.owned_lock(&format!("inventory:{cache_key}")).await;
            let _inventory_guard = inventory_lock.lock().await;
            {
                let mut cache = TEXT_INVENTORY
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                cache.retain(|_, (observed, _)| observed.elapsed() < TEXT_INVENTORY_TTL);
                if !refresh {
                    if let Some((_, inventory)) = cache.get(&cache_key) {
                        return Ok(inventory.clone());
                    }
                }
            }
            let request = OwnedSessionRequest {
                owner_id: format!("inventory:{}", uuid::Uuid::new_v4()),
                provider_id: provider.into(),
                account_id: account.into(),
                model_id: String::new(),
                reasoning_effort: None,
                fast_mode: None,
                cwd: "/workspace".into(),
                title: "Benchmark model inventory".into(),
                profile: ExecutionProfile::NativeTextV1,
            };
            let id = text_execution::attempt_id(&request.owner_id);
            let profile_key = text_execution::profile_key(&request.owner_id);
            let route_key = format!(
                "{}{BENCHMARK_ROUTE}{profile_key}",
                account_route_key(provider, Some(account))
            );
            let mut cleanup = crate::services::benchmark_sandbox::Cleanup(Some(id.clone()));
            let result = async {
                let bridge = self
                    .ensure_execution_bridge(
                        provider,
                        Some(account),
                        Some(OwnedBridge {
                            profile_key: &profile_key,
                            request: &request,
                            revision: &revision,
                            provider: native,
                            turn_limit_ms: 120_000,
                        }),
                    )
                    .await
                    .map_err(|error| inventory_start_error(&error))?;
                let mut meta = native.session_meta("");
                if let Some(options) = meta
                    .pointer_mut("/claudeCode/options")
                    .and_then(Value::as_object_mut)
                {
                    options.remove("model");
                }
                let opened = bridge
                    .request(
                        "session/new",
                        json!({"cwd":"/workspace","mcpServers":[],"_meta":meta}),
                    )
                    .await
                    .map_err(|error| error_text(&error))?;
                let probe_session = protocol::session_id(&opened)
                    .ok_or("capability_missing: Linux model probe returned no session")?;
                if let Some(mode) = native.permission_mode() {
                    bridge
                        .request(
                            "session/set_mode",
                            json!({"sessionId":probe_session,"modeId":mode}),
                        )
                        .await
                        .map_err(|error| error_text(&error))?;
                }
                let select = |config_id: String, model_id: String| {
                    let bridge = Arc::clone(&bridge);
                    let session = probe_session.clone();
                    async move {
                        bridge
                            .request(
                                "session/set_config_option",
                                json!({"sessionId":session,"configId":config_id,"value":model_id}),
                            )
                            .await
                    }
                };
                let close = || {
                    let bridge = Arc::clone(&bridge);
                    let session = probe_session.clone();
                    async move {
                        bridge.close_session(&session).await;
                    }
                };
                let observed = Self::probe_model_rows(&opened, select, close).await;
                let models = ext::benchmark_models(&catalog, &observed);
                bridge.stop_sandbox().await?;
                Ok::<_, String>((
                    models,
                    json!({"sandbox":"distill-bench","revision":revision}),
                ))
            }
            .await;
            if let Some(bridge) = self.bridges.lock().await.remove(&route_key) {
                bridge.kill();
            }
            crate::services::benchmark_sandbox::clean(&id)
                .await
                .map_err(|error| error.to_string())?;
            cleanup.0 = None;
            let (models, executable) = result?;
            let inventory = json!({"models":models,"executable":executable,"providerId":provider,"accountId":account,"observedAt":now_iso()});
            // At most 8 MiB of serialized inventory across all local accounts.
            if serde_json::to_vec(&inventory).is_ok_and(|bytes| bytes.len() <= 512 * 1024) {
                let mut cache = TEXT_INVENTORY
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if cache.len() >= 16 {
                    let oldest = cache
                        .iter()
                        .min_by_key(|(_, (observed, _))| *observed)
                        .map(|(key, _)| key.clone());
                    if let Some(oldest) = oldest {
                        cache.remove(&oldest);
                    }
                }
                cache.insert(cache_key, (std::time::Instant::now(), inventory.clone()));
            }
            Ok(inventory)
        })
    }

    /// The executable that would answer [`Self::benchmark_inventory`] for
    /// `provider` and `account` now, found without a session or a new
    /// process (see [`Self::serving_executable`]). An inventory listed by the
    /// same executable still describes the runtime.
    pub async fn benchmark_serving_executable(&self, provider: &str, account: &str) -> Value {
        let Some(provider) = NativeProvider::for_harness(provider) else {
            return Value::Null;
        };
        match text_execution::readiness(provider, account).await {
            Ok(status) => {
                json!({"sandbox":"distill-bench","revision":text_execution::revision(provider, &status)})
            }
            Err(_) => Value::Null,
        }
    }

    /// A stored session, with any model id that still carries a folded effort
    /// split first. Every single-session read goes through here, so a chat is
    /// converted on the load that first looks at it and never by a sweep over
    /// rows nobody opened.
    pub async fn session_record(&self, session_id: &str) -> Result<SessionRecord, Value> {
        let mut record = self
            .store
            .get_session(session_id)
            .await
            .map_err(protocol::internal)?
            .ok_or_else(|| invalid_params(format!("Unknown session {session_id}")))?;
        self.split_stored_model_id(&mut record).await;
        Ok(record)
    }

    /// Split a stored `model[effort]` id into the two selections it always
    /// was, keeping the original in `legacy_model_id`.
    ///
    /// Only ever for a session nothing has chosen an effort for, and only when
    /// the harness itself advertises that effort for that base model. Anything
    /// else is left byte for byte: claude's `[1m]` context lanes are model ids
    /// and not pairs, `default` and `current` are aliases, and an id whose
    /// suffix no harness advertises is a model name the app has no business
    /// rewriting.
    pub(super) async fn split_stored_model_id(&self, record: &mut SessionRecord) {
        if record.reasoning_effort.is_some() || record.legacy_model_id.is_some() {
            return;
        }
        let Some(model_id) = record.model_id.clone() else {
            return;
        };
        if !model_id.ends_with(']') || !self.selection_split_enabled().await {
            return;
        }
        let models =
            ext::known_models(&self.store, &record.harness, record.account_id.as_deref()).await;
        let Some((base, effort)) = Self::legacy_split(&model_id, &models) else {
            return;
        };
        match self
            .store
            .split_legacy_model_id(&record.id, &base, &effort)
            .await
        {
            Ok(true) => {
                log::info!(
                    "[agent-host] session {} runs {base} at {effort}, split out of the stored {model_id}",
                    record.id
                );
                record.legacy_model_id = Some(model_id);
                record.model_id = Some(base);
                record.reasoning_effort = Some(effort);
            }
            // Something chose for this session first; its choice stands.
            Ok(false) => {}
            Err(error) => log::warn!(
                "[agent-host] failed to split the stored model id of session {}: {error}",
                record.id
            ),
        }
    }

    /// The base id and effort a stored `model[effort]` id splits into, when
    /// the harness's own inventory advertises that effort for that base model.
    /// `None` — leave the id exactly as it is — for every other id, including
    /// one whose harness has not been probed yet, which is a "not now" rather
    /// than a "never".
    pub(super) fn legacy_split(model_id: &str, models: &[Value]) -> Option<(String, String)> {
        let advertised = |id: &str| models.iter().find(|model| model["id"] == id);
        // A harness that lists the whole id means it: that is a model.
        if advertised(model_id).is_some() {
            return None;
        }
        let (base, effort) = model_id.strip_suffix(']')?.split_once('[')?;
        if base.is_empty() || effort.is_empty() || effort.contains('[') {
            return None;
        }
        let offers = advertised(base)?["efforts"]
            .as_array()
            .is_some_and(|efforts| efforts.iter().any(|entry| entry["value"] == effort));
        offers.then(|| (base.to_string(), effort.to_string()))
    }

    /// Whether the lazy split still runs. It does unless the kv row
    /// `migrations/selection_split` says `false` (or `{"enabled": false}`),
    /// which is how it is retired — by condition, not by date: once no
    /// `sessions.legacy_model_id` row is left and no client can still send a
    /// folded id, nothing is gained by asking again.
    pub(super) async fn selection_split_enabled(&self) -> bool {
        match self.selection_split.load(Ordering::Relaxed) {
            1 => return true,
            2 => return false,
            _ => {}
        }
        let enabled = match self
            .store
            .kv_get(SELECTION_SPLIT_SCOPE, SELECTION_SPLIT_KEY)
            .await
            .ok()
            .flatten()
        {
            Some(Value::Bool(enabled)) => enabled,
            Some(value) => value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            None => true,
        };
        self.selection_split
            .store(if enabled { 1 } else { 2 }, Ordering::Relaxed);
        enabled
    }

    /// Where the model probe opens its throwaway session. The app's own data
    /// directory, not the user's home: a bridge files a session under its
    /// `cwd`, and the probe has no business appearing in the history of the
    /// directory the user actually works in.
    pub(super) fn probe_cwd(&self) -> String {
        crate::services::flock_root::app_root(&self.app)
            .ok()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string())
    }

    /// The file that answers for `harness_id` right now: the one its running
    /// bridge was started from while that bridge lives, the one on disk
    /// otherwise. `Null` where the harness is not installed.
    ///
    /// The distinction matters for a CLI updated while its bridge is up: the
    /// old process keeps serving the old models until it exits, and probing
    /// it again would only confirm what the inventory already says.
    pub async fn serving_executable(&self, harness_id: &str, account_id: Option<&str>) -> Value {
        if let Some(bridge) = self
            .live_bridge(&account_route_key(harness_id, account_id))
            .await
        {
            return bridge.executable();
        }
        let Some(spec) = harness::harness(harness_id) else {
            return Value::Null;
        };
        let env = self.spawn_env().await;
        crate::services::agent_host::bridge::executable_fingerprint(spec, &env)
            .unwrap_or(Value::Null)
    }

    /// Open a throwaway session to learn which models a harness offers and
    /// what each of them can do, then close it. Answers the rows and the
    /// executable of the bridge that listed them, so the inventory can tell
    /// when a later build of the CLI has something else to say.
    ///
    /// The row list is the session's own `model` option: base ids under the
    /// bridge's own names. `models.availableModels` is not the list — codex
    /// builds that array as a display-only cross product of every model with
    /// every effort (`gpt-6-astra[low]` and 30 more), and reading the
    /// inventory from there is where Flock learned to treat an effort as
    /// part of a model id. Each model is then selected in turn so the effort
    /// values and fast toggle recorded against it are its own. No prompt is
    /// ever sent, so nothing runs and nothing is billed.
    pub async fn probe_models(
        self: &Arc<Self>,
        harness_id: &str,
        account_id: Option<&str>,
    ) -> Result<(Vec<Value>, Value), Value> {
        let bridge = self.ensure_account_bridge(harness_id, account_id).await?;
        let probed_on = bridge.executable();
        let mut params = json!({ "cwd": self.probe_cwd(), "mcpServers": [] });
        if let Some(meta) = harness::probe_session_meta(harness_id) {
            params["_meta"] = meta;
        }
        let opened = bridge.request("session/new", params).await?;
        let Some(probe_session) = protocol::session_id(&opened) else {
            log::info!("[agent-host] {harness_id} named no session to probe its models in");
            return Ok((Self::probe_rows(&opened), probed_on));
        };
        let select = |config_id: String, model_id: String| {
            let bridge = Arc::clone(&bridge);
            let session = probe_session.clone();
            async move {
                bridge
                    .request(
                        "session/set_config_option",
                        json!({ "sessionId": session, "configId": config_id, "value": model_id }),
                    )
                    .await
            }
        };
        let close = || {
            let bridge = Arc::clone(&bridge);
            let session = probe_session.clone();
            async move {
                // Closed, never deleted: a session that was never prompted is
                // not persisted, and both bridges answer `session/delete` for
                // one with an error that reads like a leak but is the proof
                // there is nothing to delete.
                let closed = tokio::time::timeout(
                    BRIDGE_CLOSE_TIMEOUT,
                    bridge.request("session/close", json!({ "sessionId": session })),
                )
                .await;
                if !matches!(closed, Ok(Ok(_))) {
                    log::info!("[agent-host] the model probe session {session} did not close");
                }
            }
        };
        let mut models = Self::probe_model_rows(&opened, select, close).await;
        if harness_id == "kimi-acp" {
            let env = self.spawn_env().await;
            let catalog = crate::services::agent_host::kimi::model_catalog(&env.shell_env)
                .map_err(protocol::internal)?;
            crate::services::agent_host::kimi::annotate_models(&mut models, &catalog);
        }
        Ok((models, probed_on))
    }

    /// Walk a throwaway session's model list. `select` puts the session on
    /// one model and answers with the bridge's refreshed options; `close`
    /// ends the session, and runs whether the walk finished or gave up.
    pub(super) async fn probe_model_rows<S, SFut, C, CFut>(
        opened: &Value,
        mut select: S,
        close: C,
    ) -> Vec<Value>
    where
        S: FnMut(String, String) -> SFut,
        SFut: std::future::Future<Output = Result<Value, Value>>,
        C: FnOnce() -> CFut,
        CFut: std::future::Future<Output = ()>,
    {
        let mut rows = Self::probe_rows(opened);
        if let Some(config_id) = Self::model_option(opened)
            .and_then(|option| option.get("id"))
            .and_then(Value::as_str)
        {
            for row in rows.iter_mut() {
                let Some(model_id) = row["id"].as_str().map(str::to_string) else {
                    continue;
                };
                match select(config_id.to_string(), model_id.clone()).await {
                    Ok(answer) => Self::record_capabilities(row, &answer),
                    Err(error) => {
                        // A listed model can be refused independently (for
                        // example an account cannot confirm one preview model).
                        // Keep that row unknown and still ask the remaining
                        // models; one refusal says nothing about their options.
                        log::info!(
                            "[agent-host] the model probe skipped {model_id}: {}",
                            error_text(&error)
                        );
                    }
                }
            }
        }
        close().await;
        rows
    }

    pub(super) fn model_option(snapshot: &Value) -> Option<&Value> {
        snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_model_option(option))
    }

    /// The models a freshly opened session offers, before any of them has
    /// been selected: names and ids, plus whatever the bridge already said
    /// about their effort levels.
    pub(super) fn probe_rows(opened: &Value) -> Vec<Value> {
        let mut rows = Self::probe_row_list(opened, Self::model_option(opened));
        for row in rows.iter_mut() {
            Self::apply_advertised_details(row, opened);
        }
        rows
    }

    /// The models a session offers, as the bridge's own model option lists
    /// them. A bridge with no model option at all still names them in its
    /// `models` block.
    pub(super) fn probe_row_list(opened: &Value, model_option: Option<&Value>) -> Vec<Value> {
        let listed: Vec<Value> = model_option
            .and_then(|option| option["options"].as_array())
            .map(|choices| {
                choices
                    .iter()
                    .filter_map(|choice| {
                        let value = choice.get("value").and_then(Value::as_str)?;
                        Some(Self::probe_row(
                            value,
                            choice.get("name").and_then(Value::as_str),
                            choice.get("description"),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !listed.is_empty() {
            return listed;
        }
        opened
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| {
                        let id = model.get("modelId").and_then(Value::as_str)?;
                        Some(Self::probe_row(
                            id,
                            model.get("name").and_then(Value::as_str),
                            model.get("description"),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A model nobody has asked anything about yet. An empty effort list next
    /// to `capabilitySource: "unknown"` means exactly that, and never "this
    /// model has no effort control".
    pub(super) fn probe_row(id: &str, name: Option<&str>, description: Option<&Value>) -> Value {
        json!({
            "id": id,
            "name": name.unwrap_or(id),
            "description": description.cloned().unwrap_or(Value::Null),
            "efforts": [],
            "defaultEffort": Value::Null,
            "supportsFast": Value::Null,
            "capabilitySource": "unknown",
        })
    }

    /// What the session reports after moving to this model: the effort values
    /// it offers, and whether it has a fast toggle at all.
    pub(super) fn record_capabilities(row: &mut Value, answer: &Value) {
        // An answer with no options at all says nothing about the model; one
        // that lists options without an effort or fast option says the model
        // has none, which is a different thing and has to stay different.
        let Some(options) = answer["configOptions"].as_array() else {
            return;
        };
        let efforts: Vec<Value> = options
            .iter()
            .find(|option| Self::is_effort_option(option))
            .and_then(|option| option["options"].as_array())
            .map(|choices| {
                choices
                    .iter()
                    .filter_map(|choice| {
                        let value = choice.get("value").and_then(Value::as_str)?;
                        Some(harness::effort(
                            value,
                            choice.get("name").and_then(Value::as_str),
                            choice.get("description").and_then(Value::as_str),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !efforts.is_empty() {
            let recommended = options
                .iter()
                .find(|option| Self::is_effort_option(option))
                .and_then(|option| option.pointer("/_meta/jetbrains/air/recommendedValue"))
                .and_then(Value::as_str);
            if let Some(value) = recommended.filter(|value| {
                efforts
                    .iter()
                    .any(|effort| effort["value"].as_str() == Some(value))
            }) {
                row["defaultEffort"] = json!(value);
            }
            row["efforts"] = json!(efforts);
        }
        row["supportsFast"] = json!(options.iter().any(Self::is_fast_option));
        row["capabilitySource"] = json!("probed");
    }

    /// What a bridge says about a model beside its own model option: the
    /// description it only puts in the `models` block, and — for the one
    /// bridge that states it (grok) — the model's effort menu with the
    /// `default: true` flag, the only place any harness names a default.
    pub(super) fn apply_advertised_details(row: &mut Value, opened: &Value) {
        let Some(model) = opened
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .and_then(|models| {
                models
                    .iter()
                    .find(|model| model["modelId"] == row["id"] && model["modelId"].is_string())
            })
        else {
            return;
        };
        if row["description"].is_null() {
            if let Some(description) = model.get("description").filter(|value| value.is_string()) {
                row["description"] = description.clone();
            }
        }
        let Some(efforts) = model
            .pointer("/_meta/reasoningEfforts")
            .and_then(Value::as_array)
        else {
            return;
        };
        let mut listed = Vec::new();
        let mut default_effort = Value::Null;
        for entry in efforts {
            let Some(value) = entry
                .get("value")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if entry.get("default").and_then(Value::as_bool) == Some(true) {
                default_effort = json!(value);
            }
            listed.push(harness::effort(
                value,
                entry
                    .get("label")
                    .or_else(|| entry.get("name"))
                    .and_then(Value::as_str),
                entry.get("description").and_then(Value::as_str),
            ));
        }
        if listed.is_empty() {
            return;
        }
        row["efforts"] = json!(listed);
        row["defaultEffort"] = default_effort;
        row["capabilitySource"] = json!("probed");
    }

    /// Whether a config option is the model's fast/speed toggle: the
    /// dedicated `fast` option, or a `model_config` on/off select or boolean.
    /// The renderer reads it the same way (`acpSessionConfigSnapshots.ts`),
    /// and the host deliberately does not rename either bridge's own id.
    pub(super) fn is_fast_option(option: &Value) -> bool {
        let id = option.get("id").and_then(Value::as_str).unwrap_or_default();
        if id != "fast" && option.get("category").and_then(Value::as_str) != Some("model_config") {
            return false;
        }
        match option.get("type").and_then(Value::as_str) {
            Some("boolean") => true,
            Some("select") => {
                id == "fast"
                    || option["options"].as_array().is_some_and(|choices| {
                        let offers =
                            |wanted: &str| choices.iter().any(|choice| choice["value"] == wanted);
                        offers("on") && offers("off")
                    })
            }
            _ => false,
        }
    }
}
