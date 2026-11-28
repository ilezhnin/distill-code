//! Bridges to the agent CLIs: starting one for an account or an execution, reusing it, and letting idle ones and idle sessions go.
use super::*;

/// Chat bridge routes whose process started for a model-list probe and then
/// failed `initialize`. A CLI that cannot speak ACP was started for every
/// model list the renderer asked for: the VS Code Copilot shim on PATH, which
/// says "GitHub Copilot CLI was not found" and exits, twice per renderer boot
/// and 12 times in 41 h (2026-11-25 hunt, D-6). Background probes do not
/// start such a route again on that executable for [`FAILED_START_MEMORY`];
/// a chat the operator opens or sends to, and a model list the operator asks
/// for, always start it, and one that starts proves the CLI works again.
static FAILED_STARTS: std::sync::LazyLock<StdMutex<HashMap<String, FailedStart>>> =
    std::sync::LazyLock::new(Default::default);

/// A probe start that failed `initialize`.
struct FailedStart {
    /// The executable it ran, as `executable_fingerprint` describes it.
    executable: Value,
    error: String,
    at: std::time::Instant,
}

/// How long a failed probe start keeps probes from starting the route again.
/// The renderer asks for model lists at boot (twice) and whenever a picker or
/// settings screen opens; ten minutes turns that into at most six starts an
/// hour for a CLI that never works, while a CLI fixed without changing its
/// file (a sign-in, an environment change) shows its models again within ten
/// minutes, or at once when the operator opens a chat on it.
const FAILED_START_MEMORY: std::time::Duration = std::time::Duration::from_secs(10 * 60);

fn failed_starts() -> std::sync::MutexGuard<'static, HashMap<String, FailedStart>> {
    FAILED_STARTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Inner {
    /// Why a probe does not start `route_key` on `executable` at `now`: its
    /// bridge failed `initialize` on that same executable for a probe less
    /// than [`FAILED_START_MEMORY`] before.
    pub(super) fn refused_start(
        route_key: &str,
        executable: &Value,
        now: std::time::Instant,
    ) -> Option<String> {
        let starts = failed_starts();
        let failed = starts.get(route_key)?;
        (failed.executable == *executable
            && now.saturating_duration_since(failed.at) < FAILED_START_MEMORY)
            .then(|| {
                format!(
                    "{} (model lists do not start it again for {} minutes unless its CLI changes; opening a chat on it tries again)",
                    failed.error,
                    FAILED_START_MEMORY.as_secs() / 60
                )
            })
    }

    /// Why a model-list probe of `route_key` on `executable` is not started
    /// at `now`; `unattended` for a background probe nobody waits on. Only
    /// such a probe waits out [`FAILED_STARTS`]: one the operator asked for
    /// (the benchmark screen's inventory or its refresh, a Resume, a run's
    /// preview) always tries the CLI. One failed `initialize` refused those
    /// for 10 minutes (2026-11-25 audit, X-4).
    pub(super) fn probe_refusal(
        route_key: &str,
        executable: &Value,
        now: std::time::Instant,
        unattended: bool,
    ) -> Option<String> {
        if !unattended {
            return None;
        }
        Self::refused_start(route_key, executable, now)
    }

    /// Remembers that a probe start of `route_key` failed `initialize` on
    /// `executable`.
    pub(super) fn remember_failed_start(route_key: &str, executable: Value, error: &str) {
        log::warn!(
            "[agent-host] {route_key} failed to initialize; model lists do not start it again for {} minutes unless its CLI changes",
            FAILED_START_MEMORY.as_secs() / 60
        );
        failed_starts().insert(
            route_key.to_string(),
            FailedStart {
                executable,
                error: error.to_string(),
                at: std::time::Instant::now(),
            },
        );
    }

    /// The route started, or the operator asked for its provider again: the
    /// next probe tries it whatever failed before.
    pub(in crate::services::agent_host) fn forget_failed_start(route_key: &str) {
        failed_starts().remove(route_key);
    }

    pub(super) async fn spawn_env(&self) -> Arc<SpawnEnv> {
        let mut cached = self.spawn_env.lock().await;
        if let Some(env) = cached.as_ref() {
            return Arc::clone(env);
        }
        let env = Arc::new(build_spawn_env(&self.app).await);
        *cached = Some(Arc::clone(&env));
        env
    }

    /// The running bridge for `harness_id`, if any. Takes the bridge map lock
    /// only for the lookup.
    pub(super) async fn live_bridge(&self, harness_id: &str) -> Option<Arc<Bridge>> {
        self.bridges
            .lock()
            .await
            .get(harness_id)
            .filter(|bridge| bridge.is_alive())
            .cloned()
    }

    /// The running bridge for `harness_id`, spawned if there is none, for a
    /// caller about to do work on it. Handing one out counts as using it (see
    /// [`Self::reap_idle_bridges`]); a mere [`Self::live_bridge`] lookup does
    /// not, or the model inventory's check of which executable is serving
    /// would keep an unused bridge up forever.
    pub(in crate::services::agent_host) fn resolve_account_id(
        &self,
        harness_id: &str,
        explicit: Option<&str>,
    ) -> Result<Option<String>, Value> {
        if harness_id == super::super::antigravity::ID {
            let id = super::super::antigravity::ACCOUNT_ID;
            if explicit.is_some_and(|named| named != id) {
                return Err(invalid_params("Choose the Google Antigravity sign-in"));
            }
            provider_accounts::resolve_account(&self.app, harness_id, Some(id))
                .map_err(invalid_params)?;
            return Ok(Some(id.into()));
        }
        if !provider_accounts::supports_managed_accounts(harness_id) {
            return if explicit.is_some() {
                Err(invalid_params(
                    "This provider does not support saved accounts",
                ))
            } else {
                Ok(None)
            };
        }
        provider_accounts::resolve_account(&self.app, harness_id, explicit)
            .map(|account| Some(account.id))
            .map_err(invalid_params)
    }

    pub(super) async fn ensure_account_bridge(
        &self,
        harness_id: &str,
        account_id: Option<&str>,
    ) -> Result<Arc<Bridge>, Value> {
        self.ensure_execution_bridge(harness_id, account_id, None)
            .await
    }

    /// The bridge a model-list probe uses: like
    /// [`Self::ensure_account_bridge`], except that a failed `initialize` is
    /// remembered and, for an `unattended` probe, a route whose last probe
    /// start failed is not started again for a while (see [`FAILED_STARTS`]).
    pub(super) async fn ensure_probe_bridge(
        &self,
        harness_id: &str,
        account_id: Option<&str>,
        unattended: bool,
    ) -> Result<Arc<Bridge>, Value> {
        self.ensure_bridge(harness_id, account_id, None, true, unattended)
            .await
    }

    /// The bridge for `harness_id` and `account_id`, or with `profile` a
    /// separate host-owned benchmark bridge.
    pub(super) fn ensure_execution_bridge<'a>(
        &'a self,
        harness_id: &'a str,
        account_id: Option<&'a str>,
        profile: Option<OwnedBridge<'a>>,
    ) -> BoxFuture<'a, Result<Arc<Bridge>, Value>> {
        self.ensure_bridge(harness_id, account_id, profile, false, false)
    }

    /// [`Self::ensure_execution_bridge`], for a model-list probe when `probe`
    /// (an `unattended` one waits out a failed start, see
    /// [`Self::probe_refusal`]).
    ///
    /// Boxed: its sandbox admission and process start would otherwise sit
    /// inline in every awaiting future, and an unoptimized build gives each
    /// awaiting poll a stack slot that size. A benchmark attempt reaches this
    /// under the runner's own deep futures on a 2 MiB worker stack.
    fn ensure_bridge<'a>(
        &'a self,
        harness_id: &'a str,
        account_id: Option<&'a str>,
        profile: Option<OwnedBridge<'a>>,
        probe: bool,
        unattended: bool,
    ) -> BoxFuture<'a, Result<Arc<Bridge>, Value>> {
        Box::pin(async move {
            let account_id = if harness_id == super::super::antigravity::ID {
                Some(account_id.unwrap_or(super::super::antigravity::ACCOUNT_ID))
            } else {
                account_id
            };
            let spec: &HarnessSpec = harness::harness(harness_id)
                .ok_or_else(|| invalid_params(format!("Unknown harness {harness_id}")))?;
            let base_key = account_route_key(harness_id, account_id);
            let route_key = profile.map_or_else(
                || base_key.clone(),
                |owned| format!("{base_key}{BENCHMARK_ROUTE}{}", owned.profile_key),
            );
            let turn_limit_ms = profile.map_or(0, |owned| owned.turn_limit_ms);
            let validation_id = account_validation_id(harness_id, account_id)?;
            if let Some(id) = validation_id {
                provider_accounts::resolve_account(&self.app, harness_id, Some(id))
                    .map_err(invalid_params)?;
            }
            if let Some(bridge) = self.reusable_bridge(&route_key, turn_limit_ms).await? {
                bridge.touch();
                return Ok(bridge);
            }
            // A benchmark session starts on a lease of its account's Flock
            // sign-in: never while that sign-in is being renewed, and a
            // renewal waits until this start has its lease. Taken before the
            // spawn lock, in the order a renewal takes both.
            let _renewal_gate = match profile {
                Some(_) => Some(self.sign_in_renewals.gate(&base_key).read_owned().await),
                None => None,
            };
            // Spawning waits on a managed install and on the bridge's
            // `initialize` answer. Serialize that per harness instead of holding
            // the shared bridge map, which every session route, cancel and
            // permission answer needs in the meantime.
            let spawn_lock = Arc::clone(
                self.spawn_locks
                    .lock()
                    .await
                    .entry(base_key.clone())
                    .or_default(),
            );
            let _spawning = spawn_lock.lock().await;
            // A credential mutation can begin while this caller was waiting.
            // Revalidate inside the same lock used when retiring this process.
            let account = validation_id
                .map(|id| {
                    provider_accounts::resolve_account(&self.app, harness_id, Some(id))
                        .map_err(invalid_params)
                })
                .transpose()?;
            if let Some(bridge) = self.reusable_bridge(&route_key, turn_limit_ms).await? {
                bridge.touch();
                return Ok(bridge);
            }
            // Every owned execution is Linux. Ordinary chats alone continue into
            // the native launcher below; no unavailable sandbox falls back to it.
            if let Some(owned) = profile {
                let (request, revision) = (owned.request, owned.revision);
                let repository = request.profile == ExecutionProfile::ProtectedRepositoryV1;
                let current = if repository {
                    repository_execution::readiness(owned.provider, &request.account_id).await
                } else {
                    text_execution::readiness(owned.provider, &request.account_id).await
                }
                .map_err(protocol::internal)?;
                let current_revision = if repository {
                    repository_execution::revision(owned.provider, &current)
                } else {
                    text_execution::revision(owned.provider, &current)
                };
                if current_revision != revision {
                    return Err(protocol::internal(
                        "capability_missing: sandbox runtime changed during admission",
                    ));
                }
                // A leased session's grant is checked where its lease is
                // staged; a sandbox sign-in (Kimi) here.
                if !credential_lease::leased(owned.provider) {
                    current
                        .require_account_window(
                            owned.provider.key(),
                            &request.account_id,
                            chrono::Utc::now().timestamp_millis(),
                            u32::try_from(owned.turn_limit_ms.div_ceil(1000)).unwrap_or(u32::MAX),
                        )
                        .map_err(|error| {
                            protocol::internal(format!("capability_missing: {error}"))
                        })?;
                }
                if !repository {
                    text_execution::clear(&request.owner_id)
                        .await
                        .map_err(protocol::internal)?;
                }
                let env =
                    crate::services::agent_host::harness_env::build_owned_spawn_env(&self.app, &[])
                        .await;
                let mut launch = if repository {
                    repository_execution::launch(request, owned.provider, revision.to_owned())
                } else {
                    text_execution::launch(request, owned.provider, revision.to_owned())
                };
                if owned.provider == NativeProvider::Kimi {
                    let models = ext::known_models(&self.store, harness_id, account_id).await;
                    let catalog = crate::services::agent_host::kimi::sandbox_catalog(&models)
                        .map_err(protocol::internal)?;
                    let separator = launch
                        .args
                        .iter()
                        .position(|arg| arg == "--")
                        .expect("isolated launch command separator");
                    launch
                        .args
                        .insert(separator, format!("DISTILL_BENCH_KIMI_MODELS={catalog}"));
                }
                let deadline = chrono::Utc::now().timestamp_millis().max(0) as u64
                    + owned.turn_limit_ms
                    + 480_000;
                let class = if repository {
                    crate::services::benchmark_sandbox::ResourceClass::Repository
                } else {
                    crate::services::benchmark_sandbox::ResourceClass::Text
                };
                let id = &launch.sandbox.as_ref().expect("owned Linux identity").0;
                // A refused reservation starts no provider process or paid turn.
                // Drop releases an unclaimed token; the Linux supervisor owns it
                // once bench-run starts, including host exit and cancellation.
                let reservation = crate::services::benchmark_sandbox::reserve(
                    class,
                    id,
                    deadline,
                    crate::services::benchmark_sandbox::continues(&request.owner_id),
                )
                .await
                .map_err(|error| {
                    let message = error.to_string();
                    // Only this trusted pre-spawn broker can establish that
                    // no provider process started. Never apply this rewrite
                    // to an arbitrary provider/bridge error after spawn.
                    let reason = message
                        .find("resource_busy:")
                        .map_or(message.as_str(), |start| &message[start..]);
                    let code = if !repository
                        && crate::services::benchmark_sandbox::reserved_nothing(&error)
                    {
                        CLEAR_SANDBOX_REFUSAL
                    } else {
                        protocol::INTERNAL_ERROR
                    };
                    protocol::error(code, reason)
                })?;
                if !repository {
                    text_execution::prepare(&request.owner_id)
                        .await
                        .map_err(protocol::internal)?;
                }
                // The session signs in with a lease of the app's own sign-in,
                // staged once the broker reserved it and before it starts,
                // under the account's renewal gate held above: no renewal
                // replaces the grant between this read and the start.
                if credential_lease::leased(owned.provider) {
                    let span = credential_lease::lease_span_ms(
                        owned.provider,
                        i64::try_from(owned.turn_limit_ms).unwrap_or(i64::MAX),
                    );
                    let until = chrono::Utc::now()
                        .timestamp_millis()
                        .saturating_add(span)
                        .saturating_add(480_000);
                    self.stage_lease(owned.provider, &request.account_id, id, until)
                        .await?;
                }
                let separator = launch
                    .args
                    .iter()
                    .position(|arg| arg == "--")
                    .expect("isolated launch command separator");
                launch
                    .args
                    .insert(separator, format!("DISTILL_BENCH_DEADLINE_MS={deadline}"));
                launch.args.insert(
                    separator,
                    format!("DISTILL_BENCH_RESERVATION={}", reservation.token),
                );
                let spawned = Bridge::spawn_scoped(
                    spec,
                    &env,
                    self.events_tx.clone(),
                    &route_key,
                    Some(&launch),
                )
                .await;
                let bridge = match spawned {
                    Ok(bridge) => {
                        // The session's bench-run owns the lease now.
                        reservation.mark_claimed();
                        bridge
                    }
                    Err(error) => {
                        if let Some((id, _)) = &launch.sandbox {
                            let _ = crate::services::benchmark_sandbox::clean(id).await;
                        }
                        return Err(protocol::internal(error));
                    }
                };
                self.bridges
                    .lock()
                    .await
                    .insert(route_key, Arc::clone(&bridge));
                return Ok(bridge);
            }
            let mut env = (*self.spawn_env().await).clone();
            if harness_id == super::super::antigravity::ID {
                let root =
                    crate::services::flock_root::app_root(&self.app).map_err(protocol::internal)?;
                super::super::antigravity::require_personal_grant(&root)
                    .map_err(protocol::internal)?;
                super::super::antigravity::scope(&root, &mut env).map_err(protocol::internal)?;
            }
            if harness_id == NativeProvider::Grok.harness_id() {
                env.extra_env.push(grok::chat_bridge_renewal_env());
            }
            if let Some(account) = account.as_ref() {
                let base = env.shell_env.into_iter().collect();
                env.shell_env = provider_accounts::scoped_env(&self.app, account, base)
                    .map_err(protocol::internal)?
                    .into_iter()
                    .collect();
                env.remove_env = provider_accounts::MANAGED_AUTH_ENV_KEYS
                    .iter()
                    .map(|key| (*key).to_string())
                    .collect();
            }
            // Startup reconciliation and the first model picker race. Waiting
            // only for an install already in flight could start yesterday's
            // bridge before reconciliation got the lock, keeping it for the
            // entire app lifetime. Verify this build's pin before first spawn.
            if managed_acp_tools::is_managed(harness_id) {
                let on_line = |line: &str| log::info!("[agent-host {harness_id}] {line}");
                if let Err(error) =
                    managed_acp_tools::install_managed_tool(&self.app, harness_id, &on_line).await
                {
                    log::warn!(
                    "[agent-host] {harness_id} update failed; trying the installed bridge: {error}"
                );
                }
            }
            // A managed bridge is installed transactionally into app data; wait
            // out any install in flight so the process is never started from a
            // tree that is being swapped underneath it.
            let _install = if managed_acp_tools::is_managed(harness_id) {
                Some(managed_acp_tools::install_lock().lock().await)
            } else {
                None
            };
            // Read after the managed install above, which may have replaced
            // the executable: a new one is always tried (see `FAILED_STARTS`).
            // Only a probe fills that memory, and only an unattended one
            // consults it; a chat the operator opens or sends to, and a model
            // list the operator asked for, always try the bridge.
            let executable =
                crate::services::agent_host::bridge::executable_fingerprint(spec, &env)
                    .unwrap_or(Value::Null);
            if probe {
                if let Some(refusal) = Self::probe_refusal(
                    &route_key,
                    &executable,
                    std::time::Instant::now(),
                    unattended,
                ) {
                    log::debug!("[agent-host] {route_key} not started: {refusal}");
                    return Err(protocol::internal(refusal));
                }
            }
            let bridge =
                match Bridge::spawn_scoped(spec, &env, self.events_tx.clone(), &route_key, None)
                    .await
                {
                    Ok(bridge) => bridge,
                    Err(error) => {
                        if probe
                            && crate::services::agent_host::bridge::failed_to_initialize(&error)
                        {
                            Self::remember_failed_start(&route_key, executable, &error);
                        }
                        return Err(protocol::internal(error));
                    }
                };
            Self::forget_failed_start(&route_key);
            if let Ok(mut expiries) = self.owned_sign_in_expiry.lock() {
                expiries.remove(&route_key);
            }
            self.bridges
                .lock()
                .await
                .insert(route_key, Arc::clone(&bridge));
            Ok(bridge)
        })
    }

    /// The live bridge on `route_key`, unless it is an owned bridge whose
    /// sign-in would not outlast a turn of `turn_limit_ms`: that one is shut
    /// down, so the next spawn starts on the sign-in the user's own CLI has
    /// refreshed since. While it still has requests in flight it can be
    /// neither replaced nor trusted with the turn, so the session is refused.
    pub(super) async fn reusable_bridge(
        &self,
        route_key: &str,
        turn_limit_ms: u64,
    ) -> Result<Option<Arc<Bridge>>, Value> {
        let Some(bridge) = self.live_bridge(route_key).await else {
            return Ok(None);
        };
        let expiring = self
            .owned_sign_in_expiry
            .lock()
            .ok()
            .and_then(|expiries| expiries.get(route_key).copied())
            .filter(|(generation, _)| *generation == bridge.generation())
            .is_some_and(|(_, expiry)| {
                grok::benchmark_sign_in_expiring(
                    Some(expiry),
                    chrono::Utc::now().timestamp_millis(),
                    turn_limit_ms,
                )
            });
        if !expiring {
            return Ok(Some(bridge));
        }
        if bridge.in_flight() > 0 {
            return Err(protocol::internal(format!(
                "sign_in_wait: {}",
                grok::BENCHMARK_BRIDGE_BUSY
            )));
        }
        log::info!("[agent-host] {route_key} bridge sign-in is about to expire; replacing it");
        let mut bridges = self.bridges.lock().await;
        if bridges
            .get(route_key)
            .is_some_and(|current| current.generation() == bridge.generation())
        {
            bridges.remove(route_key);
        }
        drop(bridges);
        bridge.kill();
        self.forget_owned_bridge(route_key, bridge.generation());
        Ok(None)
    }

    /// Drops what the host kept for the owned bridge of `generation` on
    /// `route_key` once it is stopped or gone: the expiry of the sign-in it
    /// ran on, and any copy of that sign-in its CLI left in the runtime
    /// directory. Every path that stops one calls this, the idle reaper, a
    /// sign-in replacement, a credential change and app quit as well as its
    /// exit, so no copy outlives the bridge. Nothing for a chat route.
    pub(super) fn forget_owned_bridge(&self, route_key: &str, generation: u64) {
        if !route_key.contains(BENCHMARK_ROUTE) {
            return;
        }
        if let Ok(mut expiries) = self.owned_sign_in_expiry.lock() {
            // A replacement may already have recorded its own.
            if expiries
                .get(route_key)
                .is_some_and(|(owner, _)| *owner == generation)
            {
                expiries.remove(route_key);
            }
        }
        if let Err(error) = crate::services::flock_root::app_root(&self.app).and_then(|root| {
            discard_route_sign_in(&owned_runtime_root(&root), route_key)
                .map_err(|error| error.to_string())
        }) {
            log::warn!("[agent-host] {route_key} benchmark sign-in copy was not removed: {error}");
        }
    }

    /// Whether the exit of the bridge of `exited` generation ends its route,
    /// given the generation of the bridge the map holds there now (`live`):
    /// it does unless a replacement already serves it. A bridge the host
    /// stopped itself is no longer in the map when it exits.
    pub(super) fn exit_ends_route(live: Option<u64>, exited: u64) -> bool {
        live.is_none_or(|generation| generation == exited)
    }

    /// One pass over the stored history in its replay form (see
    /// `SessionStore::compact_history`), a session at a time between the
    /// host's other work, so a database written before turns were compacted
    /// shrinks to what its chats show. A chat with a running turn is left for
    /// the next start.
    ///
    /// The pass rewrites one session at a time and nothing here rewrites the
    /// whole file: a VACUUM holds the write lock for as long as the copy
    /// takes (163 s for 12 GB on 2026-11-14, run from this task), and every
    /// send, steer and wave step of that time failed with "database is
    /// locked". The pages a pass or a removed benchmark chat frees are
    /// reused by new history; `flock-history compact` gives them back to
    /// the file system, on a database no app has open.
    pub(super) async fn compact_history_in_background(host: Weak<Inner>) {
        // Let the renderer open its first chat before the pass reads the log.
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        let Some(host) = host.upgrade() else {
            return;
        };
        // What an earlier run left in the write-ahead log goes into the
        // database now, taking no write lock, so that the next write starts
        // the log over and its size limit cuts the file back.
        match host.store.fold_wal().await {
            Ok((log, folded)) if folded < log => log::info!(
                "[agent-host] history write-ahead log: {folded} of {log} pages folded in, the rest still read"
            ),
            Ok(_) => {}
            Err(error) => log::warn!("[agent-host] history write-ahead log not folded in: {error}"),
        }
        let started = std::time::Instant::now();
        let skip = {
            let host = Arc::clone(&host);
            move |session_id: String| {
                let host = Arc::clone(&host);
                async move { host.reported_run_id(&session_id).await.is_some() }
            }
        };
        let mut sessions = 0usize;
        match host.store.compact_history(skip, |_, _| sessions += 1).await {
            Ok(total) if sessions > 0 => log::info!(
                "[agent-host] history compaction: {sessions} session(s), {} -> {} rows, {:.1} -> {:.1} MB, {:.0?}",
                total.rows_before,
                total.rows_after,
                total.bytes_before as f64 / 1_048_576.0,
                total.bytes_after as f64 / 1_048_576.0,
                started.elapsed()
            ),
            Ok(_) => {}
            Err(error) => log::warn!("[agent-host] history compaction stopped: {error}"),
        }
    }

    /// Every [`BRIDGE_REAP_INTERVAL`], shut down the bridges nothing is using.
    /// Holds the host weakly, so the task never keeps a host alive on its own
    /// and ends once the host is gone.
    pub(super) async fn reap_idle_bridges_periodically(host: Weak<Inner>) {
        loop {
            tokio::time::sleep(BRIDGE_REAP_INTERVAL).await;
            let Some(host) = host.upgrade() else {
                return;
            };
            // Chats first: a bridge whose last chat is let go of here is one
            // the reaper may shut down once its own idle window has passed.
            let _ = host.events_tx.send(BridgeEvent::ExpireContinuations);
            host.evict_idle_sessions().await;
            host.reap_idle_bridges().await;
        }
    }

    /// Let go of the bridge sessions of the chats
    /// [`Self::session_is_evictable`] finds idle, the way
    /// [`Self::release_bridge_session`] does, except that the chat keeps the
    /// bridge session's id: the next prompt, model change or visit attaches it
    /// again through the ordinary attach path, which resumes it.
    ///
    /// Which bridge processes can resume a session is read first and let go
    /// of: the session map and the bridge map are never held together (see
    /// `attached_route`). A process's capabilities are fixed at `initialize`,
    /// so what was read holds for as long as the runtime names that process.
    pub(super) async fn evict_idle_sessions(&self) {
        let holders: HashMap<String, (u64, bool)> = self
            .bridges
            .lock()
            .await
            .iter()
            .filter(|(_, bridge)| bridge.is_alive())
            .map(|(harness, bridge)| {
                (
                    harness.clone(),
                    (bridge.generation(), bridge.supports_load_session()),
                )
            })
            .collect();
        let now = std::time::Instant::now();
        let idle: Vec<(String, u64)> = self
            .sessions
            .lock()
            .await
            .iter()
            .filter(|(_, runtime)| {
                let resumable = Self::resumable_after_release(
                    holders.get(&runtime.route_key()).copied(),
                    runtime.generation,
                );
                Self::session_is_evictable(runtime, resumable, now)
            })
            .map(|(session_id, runtime)| (session_id.clone(), runtime.generation))
            .collect();
        // Side by side, so a bridge slow to close one session does not hold up
        // the others, or the bridge reaper behind them, by its full deadline.
        futures_util::future::join_all(
            idle.iter()
                .map(|(session_id, generation)| self.release_idle_session(session_id, *generation)),
        )
        .await;
    }

    /// Let go of one chat [`Self::evict_idle_sessions`] found idle, if it
    /// still is.
    ///
    /// Under the chat's attach lock, like every other change to what bridge
    /// session a chat has. An attach that takes the lock afterwards finds no
    /// runtime and resumes the bridge session only once the close below has
    /// been answered; were the close sent in the background instead, it could
    /// reach the bridge after that resume and close the session again under
    /// the new turn. And an attach that took the lock first has just marked
    /// the chat as used, so it is no longer idle here.
    pub(super) async fn release_idle_session(&self, session_id: &str, generation: u64) {
        let lock = self.attach_lock(session_id).await;
        let released = {
            let _releasing = lock.lock().await;
            let released = {
                let mut sessions = self.sessions.lock().await;
                // Still on the process the scan found able to resume it.
                let still_idle = sessions.get(session_id).is_some_and(|runtime| {
                    runtime.generation == generation
                        && Self::session_is_evictable(runtime, true, std::time::Instant::now())
                });
                if still_idle {
                    sessions.remove(session_id)
                } else {
                    None
                }
            };
            if let Some(runtime) = &released {
                log::info!(
                    "[agent-host] session {session_id} unused for {}s; letting go of its {} bridge session",
                    runtime.last_active.elapsed().as_secs(),
                    runtime.harness
                );
                // Nothing is running, so unlike `let_go_of` there is nothing
                // to cancel first.
                if let Some(bridge) = self
                    .live_bridge(&runtime.route_key())
                    .await
                    .filter(|bridge| bridge.generation() == runtime.generation)
                {
                    bridge.close_session(&runtime.bridge_session_id).await;
                }
            }
            released.is_some()
        };
        if !released {
            return;
        }
        // The attach lock goes with the runtime, as it does when a chat is
        // deleted, or the map keeps an entry for every chat ever attached.
        // Only when this task holds the last reference besides the map: a
        // caller already waiting on this lock has to get this very lock, or it
        // could attach alongside a caller that took a fresh one.
        let mut locks = self.attach_locks.lock().await;
        if locks
            .get(session_id)
            .is_some_and(|entry| Arc::ptr_eq(entry, &lock) && Arc::strong_count(&lock) == 2)
        {
            locks.remove(session_id);
        }
    }

    /// Whether an attached chat may let go of its bridge session: it is not
    /// being attached, runs no turn and has none queued, the bridge can give
    /// it back on the next attach (`resumable`, see
    /// [`Self::resumable_after_release`]), and nothing has used it for
    /// [`SESSION_IDLE_TIMEOUT`].
    pub(super) fn session_is_evictable(
        runtime: &SessionRuntime,
        resumable: bool,
        now: std::time::Instant,
    ) -> bool {
        resumable
            && !runtime.loading
            && runtime.run.is_none()
            && !runtime.background.is_busy()
            && runtime.steer_queue.is_empty()
            && now.saturating_duration_since(runtime.last_active) >= SESSION_IDLE_TIMEOUT
    }

    /// Whether letting go of a bridge session loses nothing the next attach
    /// cannot get back. `holder` is the live bridge of the session's harness,
    /// as its generation and whether it loads sessions. A bridge that cannot
    /// load one would start the chat over without the agent's context, so its
    /// chats stay attached. A process other than the one that accepted the
    /// session has never heard of it, and none at all means it went with the
    /// process that had it: either way there is nothing left to lose.
    pub(super) fn resumable_after_release(holder: Option<(u64, bool)>, generation: u64) -> bool {
        match holder {
            Some((live, loads_sessions)) if live == generation => loads_sessions,
            _ => true,
        }
    }

    /// Shut down every bridge [`Self::bridge_is_reapable`] finds idle.
    ///
    /// Which harnesses have chats is read first and let go of: the session map
    /// and the bridge map are never held together (see `attached_route`). A
    /// chat registered in between cannot slip through: every path that
    /// registers one first takes its bridge from `ensure_bridge`, which
    /// restarts the idle clock, and still holds it when it registers the chat.
    ///
    /// The decision and the removal happen under one hold of the bridge map,
    /// the only place a bridge is handed out from. A task that took the bridge
    /// before still holds it, which keeps it; one that looks for it after finds
    /// nothing, and `ensure_bridge` spawns a fresh one. The spawn lock is not
    /// needed: a spawn only starts while the map has no live bridge for the
    /// harness, and only live ones are removed here.
    pub(super) async fn reap_idle_bridges(&self) {
        let mut chats: HashMap<String, usize> = HashMap::new();
        for runtime in self.sessions.lock().await.values() {
            *chats.entry(runtime.route_key()).or_default() += 1;
        }
        let now = std::time::Instant::now();
        let mut idle = Vec::new();
        self.bridges.lock().await.retain(|harness, bridge| {
            // A bridge that already died is for the exit handler to forget.
            let reapable = bridge.is_alive()
                && Self::bridge_is_reapable(
                    chats.get(harness).copied().unwrap_or(0),
                    bridge.in_flight(),
                    // The map's own reference is not a user.
                    Arc::strong_count(bridge) - 1,
                    bridge.last_used(),
                    now,
                );
            if reapable {
                idle.push((harness.clone(), Arc::clone(bridge)));
            }
            !reapable
        });
        for (route, bridge) in idle {
            log::info!(
                "[agent-host] {} bridge idle for {}s with no chats; shutting it down",
                bridge.harness,
                now.saturating_duration_since(bridge.last_used()).as_secs()
            );
            bridge.kill();
            self.forget_owned_bridge(&route, bridge.generation());
        }
    }

    /// Whether a bridge may be shut down: no chat of its harness is attached
    /// (to it, or to an earlier process that chat will come back for), none of
    /// the host's requests to it is waiting for an answer, no task holds it for
    /// work it is about to do, and nothing has used it for
    /// [`BRIDGE_IDLE_TIMEOUT`].
    pub(super) fn bridge_is_reapable(
        attached_chats: usize,
        in_flight: usize,
        other_holders: usize,
        last_used: std::time::Instant,
        now: std::time::Instant,
    ) -> bool {
        attached_chats == 0
            && in_flight == 0
            && other_holders == 0
            && now.saturating_duration_since(last_used) >= BRIDGE_IDLE_TIMEOUT
    }

    pub async fn installed_harnesses(&self) -> Vec<&'static HarnessSpec> {
        let env = self.spawn_env().await;
        harness::HARNESSES
            .iter()
            .filter(|spec| crate::services::agent_host::bridge::is_installed(spec, &env))
            .collect()
    }
}
