//! Account activity and keeping app sign-ins alive.
use super::*;

impl Inner {
    pub async fn account_activity(
        &self,
        provider: &str,
        account: &str,
    ) -> Result<AccountActivity, String> {
        let sessions = self.sessions.lock().await;
        let mut active_sessions: Vec<String> = sessions
            .iter()
            .filter(|(_, runtime)| {
                // Benchmark turns are not the user's work; they run side by side.
                runtime.harness == provider
                    && (runtime.execution_profile.is_none()
                        || runtime
                            .snapshot
                            .pointer("/_meta/executionOwner/kind")
                            .and_then(Value::as_str)
                            == Some("task"))
                    && activity_scope_matches(
                        &account_route_key(&runtime.harness, runtime.account_id.as_deref()),
                        provider,
                        account,
                    )
                    && (runtime.loading || runtime.run.is_some())
            })
            .map(|(id, _)| id.clone())
            .collect();
        let naming = self
            .naming_replies
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        active_sessions.extend(
            naming
                .keys()
                .filter(|key| {
                    activity_scope_matches(key.split('\0').next().unwrap_or(key), provider, account)
                })
                .map(|key| format!("auxiliary:{key}")),
        );
        Ok(AccountActivity {
            active_sessions,
            generation: self
                .activity_generations
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .snapshot(provider, account),
        })
    }

    /// Stages a lease of the app's sign-in of `account` for `provider`'s
    /// session `id`, which may run until `deadline_ms`. Refused before the
    /// session starts when the grant no longer lasts that long: its next try
    /// renews the grant first (see [`Self::renew_app_sign_in`]).
    pub(super) async fn stage_lease(
        &self,
        provider: NativeProvider,
        account: &str,
        id: &str,
        until: i64,
    ) -> Result<(), Value> {
        let now = chrono::Utc::now().timestamp_millis();
        let lease = credential_lease::read(&self.app, provider, account, now)
            .map_err(|error| protocol::internal(format!("capability_missing: {error}")))?;
        if !credential_lease::covers(provider, lease.expires_at_ms(), until) {
            return Err(protocol::internal(format!(
                "sign_in_wait: {}",
                app_sign_in::APP_SIGN_IN_SHORT
            )));
        }
        crate::services::benchmark_sandbox::stage_lease(id, &lease)
            .await
            .map_err(|error| protocol::internal(stage_failure(&error.to_string())))
    }

    /// Makes the app's sign-in of `provider`'s `account` last until `until_ms`
    /// for a lease, renewing it on Windows when it does not (see
    /// [`app_sign_in::ensure`]), and returns its expiry (none: it does not
    /// expire, or the provider is not leased). A renewal holds the account's
    /// gate alone: no lease is staged while it runs, and it waits for every
    /// live lease of the account to end.
    ///
    /// Boxed for the same stack reason as [`Self::ensure_execution_bridge`].
    pub fn renew_app_sign_in<'a>(
        self: &'a Arc<Self>,
        provider: &'a str,
        account: &'a str,
        until_ms: i64,
        asker: app_sign_in::Asker,
    ) -> BoxFuture<'a, Result<Option<i64>, String>> {
        Box::pin(async move {
            let Some(native) = NativeProvider::for_harness(provider)
                .filter(|native| crate::services::credential_lease::leased(*native))
            else {
                return Ok(None);
            };
            // Its own task: a caller that gives up (a stopped run, a closed
            // listing) never cuts a token exchange in half, which could leave
            // the app holding a refresh token the provider already rotated.
            // The gate stays held until the renewal settles.
            let host = Arc::clone(self);
            let account = account.to_owned();
            tokio::spawn(async move {
                host.renew_app_sign_in_now(native, account, until_ms, asker)
                    .await
            })
            .await
            .map_err(|error| format!("capability_missing: the sign-in renewal stopped: {error}"))?
        })
    }

    pub(super) async fn renew_app_sign_in_now(
        self: Arc<Self>,
        native: NativeProvider,
        account: String,
        until_ms: i64,
        asker: app_sign_in::Asker,
    ) -> Result<Option<i64>, String> {
        {
            let key = account_route_key(native.harness_id(), Some(&account));
            let gate = self.sign_in_renewals.gate(&key);
            let _renewing = gate.write().await;
            let mut io = AppRenewal {
                host: &self,
                native,
                account: &account,
                key: &key,
            };
            app_sign_in::ensure(
                &self.sign_in_renewals,
                &key,
                native,
                until_ms,
                asker,
                &mut io,
            )
            .await
        }
    }

    /// Every [`app_sign_in::KEEPALIVE_INTERVAL`], renew each app sign-in a
    /// benchmark can lease that would otherwise reach its CLI's own window
    /// within [`app_sign_in::KEEPALIVE_LEAD_MS`], whether or not anything
    /// runs on it. Holds the host weakly, as the bridge reaper does.
    pub(super) async fn keep_app_sign_ins_alive_periodically(host: Weak<Inner>) {
        let mut wait = app_sign_in::KEEPALIVE_FIRST_PASS;
        loop {
            tokio::time::sleep(wait).await;
            wait = app_sign_in::KEEPALIVE_INTERVAL;
            let Some(host) = host.upgrade() else {
                return;
            };
            host.keep_app_sign_ins_alive().await;
        }
    }

    pub(super) async fn keep_app_sign_ins_alive(self: &Arc<Self>) {
        let mut accounts: Vec<(String, String)> = provider_accounts::snapshot(&self.app)
            .map(|snapshot| snapshot.accounts)
            .unwrap_or_default()
            .into_iter()
            .filter(|account| {
                account.enabled
                    && account.auth_method == provider_accounts::AuthMethod::OAuth
                    && matches!(account.provider_id.as_str(), "claude-acp" | "codex-acp")
            })
            .map(|account| (account.provider_id, account.id))
            .collect();
        let grok = NativeProvider::Grok.harness_id();
        if matches!(
            grok::read_grok_auth_session(),
            grok::GrokAuthReadResult::Ok(ref session) if session.expires_at_ms.is_some()
        ) {
            if let Some(id) = provider_accounts::cli_login_account_id(grok) {
                accounts.push((grok.to_owned(), id));
            }
        }
        for (provider, account) in accounts {
            let until = chrono::Utc::now()
                .timestamp_millis()
                .saturating_add(app_sign_in::KEEPALIVE_LEAD_MS);
            // Failures are logged where the renewal ran; a wait for live
            // leases is retried on the next pass.
            if let Err(error) = self
                .renew_app_sign_in(&provider, &account, until, app_sign_in::Asker::New)
                .await
            {
                log::debug!(
                    "[agent-host] keep-alive of the {provider} sign-in of {account}: {error}"
                );
            }
        }
    }

    /// How many chat bridges on `routes` are alive.
    pub(super) async fn live_chat_bridges(&self, routes: &[String]) -> usize {
        self.bridges
            .lock()
            .await
            .iter()
            .filter(|(route, bridge)| routes.contains(route) && bridge.is_alive())
            .count()
    }

    /// Shuts down the app's idle chat processes on `routes` once their
    /// account's sign-in was renewed: a CLI keeps the refresh token it
    /// started with, which the renewal replaced. One that a chat is attached
    /// to, that a request waits on, or that a task holds, stays; its CLI
    /// reads the renewed grant the next time it refreshes.
    pub(super) async fn retire_idle_chat_bridges(&self, routes: &[String]) {
        let mut chats: HashMap<String, usize> = HashMap::new();
        for runtime in self.sessions.lock().await.values() {
            *chats.entry(runtime.route_key()).or_default() += 1;
        }
        let mut idle = Vec::new();
        self.bridges.lock().await.retain(|route, bridge| {
            let retire = routes.contains(route)
                && chats.get(route).copied().unwrap_or(0) == 0
                && bridge.in_flight() == 0
                && Arc::strong_count(bridge) == 1;
            if retire {
                idle.push(Arc::clone(bridge));
            }
            !retire
        });
        for bridge in idle {
            log::info!(
                "[agent-host] {} bridge retired after its sign-in was renewed",
                bridge.harness
            );
            bridge.kill();
        }
    }

    /// One renewal of the user's Grok sign-in on Windows: a Grok process
    /// started with a renewal window a minute longer than what is left of the
    /// grant (`expiry`), so it renews it before its first request, the model
    /// listing of the session it opens. No model is called.
    pub(super) async fn windows_grok_renewal(&self, expiry: i64) -> Result<(), String> {
        let spec = harness::harness(NativeProvider::Grok.harness_id())
            .ok_or("capability_missing: Grok is not available")?;
        let mut env = (*self.spawn_env().await).clone();
        let renewal = grok::renewal_env(expiry, chrono::Utc::now().timestamp_millis());
        env.extra_env.retain(|(key, _)| key != &renewal.0);
        env.extra_env.push(renewal);
        let route = format!("{}\u{1f}renewal:{}", spec.id, uuid::Uuid::new_v4());
        let bridge = Bridge::spawn_scoped(spec, &env, self.events_tx.clone(), &route, None).await?;
        let result = async {
            let cwd = crate::services::flock_root::app_root(&self.app)?;
            let opened = bridge
                .request("session/new", json!({"cwd": cwd, "mcpServers": []}))
                .await
                .map_err(|error| error_text(&error))?;
            if let Some(session) = protocol::session_id(&opened) {
                bridge.close_session(&session).await;
            }
            Ok::<_, String>(())
        }
        .await;
        if let Err(error) = &result {
            log::warn!(
                "[agent-host] the Grok sign-in renewal did not finish ({error}); if the provider already rotated its refresh token, Grok needs one sign-in"
            );
        }
        bridge.kill();
        result
    }

    /// How many benchmark bridges of the account `account_key` names are
    /// alive: each runs on a lease of the account's Flock sign-in.
    pub(super) async fn live_benchmark_bridges(&self, account_key: &str) -> usize {
        let prefix = format!("{account_key}{BENCHMARK_ROUTE}");
        self.bridges
            .lock()
            .await
            .iter()
            .filter(|(route, bridge)| route.starts_with(&prefix) && bridge.is_alive())
            .count()
    }
}
