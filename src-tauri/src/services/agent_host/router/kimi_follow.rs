//! Following Kimi's own records of a turn.
use super::*;

impl Inner {
    /// Read every ordinary Kimi chat's session record twice a second for the
    /// turns the Kimi ACP adapter never forwards (see `kimi_relay`).
    pub(super) async fn follow_kimi_records_periodically(host: Weak<Inner>) {
        loop {
            tokio::time::sleep(KIMI_FOLLOW_INTERVAL).await;
            let Some(host) = host.upgrade() else {
                return;
            };
            host.follow_kimi_records().await;
        }
    }

    /// Read what each attached Kimi chat's record gained since the last look
    /// and show the turns of it the bridge does not: those the agent began by
    /// itself and those of prompts the CLI queued. They go through the bridge
    /// event queue, stored and ordered like every other update of the chat.
    pub(super) async fn follow_kimi_records(&self) {
        let (attached, live) = {
            let sessions = self.sessions.lock().await;
            let attached: std::collections::HashSet<String> =
                sessions.iter().map(|(id, _)| id.clone()).collect();
            let live: Vec<(String, String, u64, String)> = sessions
                .iter()
                .filter(|(_, runtime)| {
                    runtime.harness == "kimi-acp"
                        && runtime.execution_profile.is_none()
                        && !runtime.loading
                })
                .map(|(id, runtime)| {
                    (
                        id.clone(),
                        runtime.bridge_session_id.clone(),
                        runtime.generation,
                        runtime.route_key(),
                    )
                })
                .collect();
            (attached, live)
        };
        let mut follows = self.kimi_follows.lock().await;
        // A chat let go of takes its follower along; the next attach follows
        // the record from its end again. A reply it was showing ends there:
        // the CLI closed the session and its turn with it.
        let mut abandoned = Vec::new();
        follows.retain(|session_id, follow| {
            let keep = attached.contains(session_id);
            if !keep {
                abandoned.extend(
                    follow
                        .stop_shown(&now_iso())
                        .map(|closing| (session_id.clone(), closing)),
                );
            }
            keep
        });
        for (session_id, bridge_session_id, generation, route) in live {
            let (follow, closing) =
                Self::kimi_follow_for(&mut follows, &session_id, &bridge_session_id, generation);
            abandoned.extend(closing.map(|closing| (session_id.clone(), closing)));
            self.read_kimi_record(follow).await;
            Self::read_kimi_subagents(follow).await;
            let running_prompt = {
                let mut sessions = self.sessions.lock().await;
                let Some(runtime) = sessions.get_mut(&session_id).filter(|runtime| {
                    runtime.generation == generation
                        && runtime.bridge_session_id == bridge_session_id
                }) else {
                    continue;
                };
                // The agent at work is the chat in use, shown or not: a chat
                // let go of as idle mid-goal would pause the goal.
                if follow.in_turn() || follow.subagents_at_work() {
                    runtime.touch();
                }
                runtime.run.as_ref().map(|run| run.run_id.clone())
            };
            for update in follow.advance(running_prompt.is_some()) {
                let _ = self.events_tx.send(BridgeEvent::Relayed {
                    harness: route.clone(),
                    generation,
                    params: json!({ "sessionId": bridge_session_id, "update": update }),
                });
            }
            self.show_kimi_subagent_activity(
                follow,
                &route,
                generation,
                &bridge_session_id,
                running_prompt,
            );
        }
        drop(follows);
        self.close_abandoned_kimi_replies(abandoned).await;
    }

    /// Read what the records of a Kimi chat's subagents gained.
    pub(super) async fn read_kimi_subagents(
        follow: &mut crate::services::agent_host::kimi_relay::KimiFollow,
    ) {
        let mut subagents = follow.take_subagents();
        if subagents.is_empty() {
            return;
        }
        match tokio::task::spawn_blocking(move || {
            let read = subagents.read();
            (subagents, read)
        })
        .await
        {
            Ok((subagents, read)) => follow.subagents_read(subagents, read),
            Err(error) => {
                log::warn!("[agent-host] could not read Kimi subagent records: {error}");
            }
        }
    }

    /// Show a Kimi chat what its subagents did, as part of the reply whose
    /// call started them: the running prompt's, which the bridge's own
    /// updates belong to, or the agent's own turn the chat is shown. Work no
    /// reply is running for (a subagent left in the background after its
    /// turn ended) has nowhere to go, and its result reaches the agent itself.
    pub(super) fn show_kimi_subagent_activity(
        &self,
        follow: &mut crate::services::agent_host::kimi_relay::KimiFollow,
        route: &str,
        generation: u64,
        bridge_session_id: &str,
        running_prompt: Option<String>,
    ) {
        let activity = follow.take_subagent_activity();
        if activity.is_empty() {
            return;
        }
        let created = now_iso();
        for mut update in activity {
            if follow.stamp_shown(&mut update, &created) {
                let _ = self.events_tx.send(BridgeEvent::Relayed {
                    harness: route.to_string(),
                    generation,
                    params: json!({ "sessionId": bridge_session_id, "update": update }),
                });
            } else if let Some(run_id) = &running_prompt {
                let _ = self.events_tx.send(BridgeEvent::Notification {
                    harness: route.to_string(),
                    generation,
                    run_id: Some(run_id.clone()),
                    method: "session/update".to_string(),
                    params: json!({ "sessionId": bridge_session_id, "update": update }),
                });
            }
        }
    }

    /// End the replies of Kimi turns the chat stopped following because it
    /// let go of the CLI session (another agent or account, a bridge that
    /// exited): no runtime routes an update to the chat any more, so they are
    /// stored and sent here, after everything the event queue still holds.
    pub(super) async fn close_abandoned_kimi_replies(&self, closings: Vec<(String, Value)>) {
        if closings.is_empty() {
            return;
        }
        if let Err(error) = self.drain_bridge_events().await {
            log::warn!(
                "[agent-host] closing abandoned Kimi replies before their history is durable: {}",
                error_text(&error)
            );
        }
        let mut pending: Vec<(String, Value)> = closings
            .into_iter()
            .map(|(session_id, update)| {
                let params = json!({ "sessionId": session_id, "update": update });
                (session_id, params)
            })
            .collect();
        if let Err(error) =
            Self::persist_pending_events(&self.store, &mut pending, |payload, id| {
                if let Some(payload) = Self::frontend_event(payload, id) {
                    self.notify_frontend("session/update", payload);
                }
            })
            .await
        {
            log::warn!("[agent-host] could not close abandoned Kimi replies: {error}");
        }
    }

    /// The follower of `session_id`'s record, begun anew for another CLI
    /// session or process: what an old process queued went with it, and so
    /// did a turn it was running, whose reply's closing comes second.
    pub(super) fn kimi_follow_for<'a>(
        follows: &'a mut HashMap<String, crate::services::agent_host::kimi_relay::KimiFollow>,
        session_id: &str,
        bridge_session_id: &str,
        generation: u64,
    ) -> (
        &'a mut crate::services::agent_host::kimi_relay::KimiFollow,
        Option<Value>,
    ) {
        let follow = follows.entry(session_id.to_string()).or_insert_with(|| {
            crate::services::agent_host::kimi_relay::KimiFollow::new(
                bridge_session_id.to_string(),
                generation,
            )
        });
        let mut closing = None;
        if follow.bridge_session_id != bridge_session_id || follow.generation != generation {
            closing = follow.stop_shown(&now_iso());
            *follow = crate::services::agent_host::kimi_relay::KimiFollow::new(
                bridge_session_id.to_string(),
                generation,
            );
        }
        (follow, closing)
    }

    /// Read what a Kimi chat's record gained into its follower, finding the
    /// record first if need be: from its end, unless the CLI created it since
    /// the host began to follow the chat (a new session's first prompt does),
    /// when all of it is new.
    pub(super) async fn read_kimi_record(
        &self,
        follow: &mut crate::services::agent_host::kimi_relay::KimiFollow,
    ) {
        if follow.reader.is_none() {
            if follow
                .looked_for
                .is_some_and(|looked| looked.elapsed() < KIMI_RECORD_LOOK_INTERVAL)
            {
                return;
            }
            follow.looked_for = Some(std::time::Instant::now());
            let env = self.spawn_env().await;
            let Some(home) = crate::services::agent_host::kimi::home(&env.shell_env) else {
                return;
            };
            let (session, since) = (follow.bridge_session_id.clone(), follow.since);
            follow.reader = tokio::task::spawn_blocking(move || {
                let path = crate::services::agent_host::kimi::wire_path(&home, &session)?;
                let new = std::fs::metadata(&path)
                    .and_then(|meta| meta.created())
                    .is_ok_and(|created| created + KIMI_NEW_RECORD_GRACE >= since);
                Some(if new {
                    crate::services::agent_host::kimi_relay::WireReader::new(path, 0)
                } else {
                    crate::services::agent_host::kimi_relay::WireReader::at_end(path)
                })
            })
            .await
            .ok()
            .flatten();
        }
        let Some(mut reader) = follow.reader.take() else {
            return;
        };
        let path = reader.path().to_path_buf();
        match tokio::task::spawn_blocking(move || {
            let lines = reader.read_lines();
            (reader, lines)
        })
        .await
        {
            Ok((reader, lines)) => {
                follow.reader = Some(reader);
                follow.push_lines(lines);
            }
            Err(error) => {
                log::warn!(
                    "[agent-host] could not read Kimi session record {}: {error}",
                    path.display()
                );
            }
        }
    }

    /// Follow a Kimi chat's record from before a prompt goes out, so the turn
    /// the prompt begins is read as that prompt's, and note the message the
    /// agent's later turns follow.
    pub(super) async fn follow_kimi_prompt(
        &self,
        session_id: &str,
        bridge_session_id: &str,
        generation: u64,
        message_id: &str,
    ) {
        let closing = {
            let mut follows = self.kimi_follows.lock().await;
            let (follow, closing) =
                Self::kimi_follow_for(&mut follows, session_id, bridge_session_id, generation);
            follow.latest_message = Some(message_id.to_string());
            if follow.reader.is_none() {
                follow.looked_for = None;
            }
            self.read_kimi_record(follow).await;
            closing
        };
        self.close_abandoned_kimi_replies(
            closing
                .map(|closing| (session_id.to_string(), closing))
                .into_iter()
                .collect(),
        )
        .await;
    }

    /// After a Kimi prompt sent at `sent_at_ms` was answered with an empty
    /// `end_turn`: whether the CLI queued it behind a turn it was running
    /// rather than ran it. A queued prompt's answer is shown under its message
    /// when the CLI runs it (`kimi_relay`), and the chat is told it waits.
    pub(super) async fn settle_kimi_prompt(
        &self,
        session_id: &str,
        bridge_session_id: &str,
        generation: u64,
        message_id: &str,
        sent_at_ms: i64,
    ) {
        let queued = {
            let mut follows = self.kimi_follows.lock().await;
            // The follower was begun before the prompt went out, for this
            // very process and session; a newer one is not this prompt's.
            let Some(follow) = follows.get_mut(session_id).filter(|follow| {
                follow.bridge_session_id == bridge_session_id && follow.generation == generation
            }) else {
                return;
            };
            if follow.reader.is_none() {
                follow.looked_for = None;
            }
            self.read_kimi_record(follow).await;
            let queued = follow.reader.is_some() && !follow.prompt_turn_ran(sent_at_ms);
            if queued {
                follow.queued.push_back(message_id.to_string());
            }
            queued
        };
        if !queued {
            return;
        }
        log::info!(
            "[agent-host] Kimi queued message {message_id} of {session_id} behind the turn it is running; its answer is shown from the session record"
        );
        self.notify_frontend(
            "session/update",
            json!({
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "notice",
                    "severity": "info",
                    "title": "Kimi will answer after its current turn",
                    "description": "Kimi was busy with a turn of its own, so it queued this message. Its answer appears here when Kimi gets to it.",
                },
            }),
        );
    }

    /// Stop the turn a Kimi agent began by itself, as the chat's Stop asks.
    /// Kimi's ACP adapter cancels only a turn a prompt of its own began, so
    /// the host closes the chat's Kimi session instead: the CLI cancels the
    /// turn and pauses the goal driving it. The chat keeps its session id,
    /// and its next message resumes the session.
    pub(super) async fn stop_kimi_own_turn(&self, session_id: &str) {
        let stopped = {
            let mut follows = self.kimi_follows.lock().await;
            follows.get_mut(session_id).and_then(|follow| {
                let closing = follow.stop_shown(&now_iso())?;
                Some((closing, follow.bridge_session_id.clone(), follow.generation))
            })
        };
        let Some((closing, bridge_session_id, generation)) = stopped else {
            return;
        };
        let route = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .filter(|runtime| runtime.generation == generation)
            .map(SessionRuntime::route_key);
        let Some(route) = route else {
            return;
        };
        let _ = self.events_tx.send(BridgeEvent::Relayed {
            harness: route.clone(),
            generation,
            params: json!({ "sessionId": bridge_session_id, "update": closing }),
        });
        if let Err(error) = self.drain_bridge_events().await {
            log::warn!(
                "[agent-host] the stopped Kimi turn of {session_id} is not stored yet: {}",
                error_text(&error)
            );
        }
        let Some(bridge) = self
            .live_bridge(&route)
            .await
            .filter(|bridge| bridge.generation() == generation)
        else {
            return;
        };
        if !bridge.supports_load_session() {
            log::warn!(
                "[agent-host] Kimi cannot resume sessions here, so the turn it began by itself in {session_id} runs on"
            );
            self.notify_frontend(
                "session/update",
                json!({
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "notice",
                        "severity": "warning",
                        "title": "Kimi keeps working",
                        "description": "This Kimi setup cannot reopen a session, so its own turn could not be stopped without losing the conversation.",
                    },
                }),
            );
            return;
        }
        let lock = self.attach_lock(session_id).await;
        let _stopping = lock.lock().await;
        let released = {
            let mut sessions = self.sessions.lock().await;
            let idle = sessions.get(session_id).is_some_and(|runtime| {
                runtime.generation == generation
                    && runtime.bridge_session_id == bridge_session_id
                    && runtime.run.is_none()
                    && !runtime.loading
            });
            if idle {
                sessions.remove(session_id)
            } else {
                None
            }
        };
        if released.is_some() {
            log::info!(
                "[agent-host] stopped the turn Kimi began by itself in {session_id}: closed its Kimi session, which pauses its goal"
            );
            bridge.close_session(&bridge_session_id).await;
        }
    }
}
