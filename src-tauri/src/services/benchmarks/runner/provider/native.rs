//! The native backend: sandbox readiness, model identity, receipts and credit use.
use super::*;

pub struct NativeBackend {
    pub app: tauri::AppHandle,
    pub(in super::super) inventories: RunInventories,
}

/// What a candidate turn may do with its account's purchased credits,
/// decided just before it is sent.
pub(in super::super) struct CreditTurn {
    /// The turn may run on credits once plan usage is spent.
    pub(in super::super) allow: bool,
    /// Plan usage was already spent: the turn runs on credits from its start.
    pub(in super::super) from_start: bool,
    /// The credit balance before the turn, where the provider reports one.
    pub(in super::super) balance: Option<f64>,
    /// Timestamp of the before-sample already recorded in the credit ledger.
    pub(in super::super) balance_observed_at: i64,
    /// Keeps concurrent admissions from mistaking a long turn for idle time.
    pub(in super::super) _active_sample: Option<crate::services::benchmarks::credits::ActiveSample>,
}

/// A turn whose plan usage is spent, refused before any provider call
/// because it may not run on credits: it waits for plan usage to reset like
/// any usage limit, with `reason` on the test.
fn credit_wait(account: &str, plan_reset: Option<i64>, reason: &str) -> BenchmarkError {
    BenchmarkError::new(
        QUOTA_WAIT,
        json!({"code":-32010,"message":reason,"data":{"kind":QUOTA_WAIT,"type":QUOTA_WAIT,
            "accountId":account,"nextReset":plan_reset,"resetTokensAvailable":false,
            "dispatchStarted":false,"promptNotAccepted":true}})
        .to_string(),
    )
}

impl NativeBackend {
    /// Whether a candidate turn on `configuration` may draw on its account's
    /// credits once plan usage is spent: only within the owner's benchmark
    /// credit limit, and only where the provider reports the balance that
    /// measures it. A turn whose plan usage is spent already, and that may
    /// not, waits for plan usage to reset.
    pub(in super::super) async fn credit_turn(
        &self,
        root: &std::path::Path,
        configuration: &Configuration,
        track_turn: bool,
    ) -> Result<CreditTurn> {
        use crate::services::provider_account_status as accounts;
        let mut turn = CreditTurn {
            allow: false,
            from_start: false,
            balance: None,
            balance_observed_at: 0,
            _active_sample: None,
        };
        let Some(account) = configuration
            .account_id
            .as_deref()
            .filter(|_| accounts::plan_credits_supported(&configuration.provider_id))
        else {
            return Ok(turn);
        };
        let Ok(status) = accounts::account_status(&self.app, account).await else {
            return Ok(turn);
        };
        turn.balance = crate::services::benchmarks::credits::current_balance(&status, now());
        let spend = if let Some(balance) = turn.balance {
            turn.balance_observed_at = status.last_updated_at;
            // An unsaved drop cannot authorize more spending against the old
            // ledger. Preserve the error for the existing quota-wait reason.
            crate::services::benchmarks::credits::observe_and_spend(
                root,
                account,
                balance,
                status.last_updated_at,
            )
            .await
        } else {
            crate::services::benchmarks::credits::spend(root).await
        };
        turn.allow = turn.balance.is_some()
            && spend
                .as_ref()
                .is_ok_and(crate::services::benchmarks::credits::CreditSpend::allows);
        let (from_start, plan_reset) =
            accounts::credits_only(&status, Some(&configuration.model_id), now());
        turn.from_start = from_start;
        if from_start && !turn.allow {
            let reason = match (&spend, turn.balance) {
                (Err(error), _) => error.message.clone(),
                (Ok(_), None) => crate::services::benchmarks::credits::UNMEASURED.to_owned(),
                (Ok(spend), Some(_)) => spend.refusal(),
            };
            return Err(credit_wait(account, plan_reset, &reason));
        }
        if track_turn && turn.balance.is_some() && spend.is_ok() {
            turn._active_sample = Some(
                crate::services::benchmarks::credits::active_sample(
                    root,
                    account,
                    turn.balance_observed_at,
                    now(),
                )
                .await
                .map_err(|error| credit_wait(account, plan_reset, &error.message))?,
            );
        }
        Ok(turn)
    }

    /// Records the credits a finished candidate turn drew on, from a provider
    /// sample taken after it, with the attempt and in its evidence: a turn
    /// sent on credits, or one that ran out of plan usage on the way.
    pub(in super::super) async fn record_credit_use(
        &self,
        root: &std::path::Path,
        attempt: &mut Attempt,
        evidence: &mut Value,
        turn: &mut CreditTurn,
    ) {
        use crate::services::provider_account_status as accounts;
        let Some(account) = attempt.configuration.account_id.clone() else {
            return;
        };
        if turn.balance.is_none() {
            return;
        }
        let after = accounts::account_status_after_turn(&self.app, &account)
            .await
            .ok();
        let balance_after = after.as_ref().and_then(|status| {
            crate::services::benchmarks::credits::current_balance(status, now())
        });
        if let (Some(status), Some(balance)) = (&after, balance_after) {
            match crate::services::benchmarks::credits::observe_after_turn(
                root,
                &account,
                balance,
                status.last_updated_at,
                turn.balance_observed_at,
            )
            .await
            {
                Ok(()) => {
                    // Successful settlement can release the durable marker only
                    // after this turn stops contributing to active accounting.
                    turn._active_sample.take();
                    if let Err(error) = crate::services::benchmarks::credits::clear_settled(
                        root,
                        &account,
                        status.last_updated_at,
                    )
                    .await
                    {
                        log::warn!("[benchmarks] {}", error.message);
                    }
                }
                Err(error) => log::warn!("[benchmarks] {}", error.message),
            }
        }
        let ended_on_credits = after.as_ref().is_some_and(|status| {
            accounts::credits_only(status, Some(&attempt.configuration.model_id), now()).0
        });
        let spent = turn
            .balance
            .zip(balance_after)
            .is_some_and(|(before, after)| after < before);
        if !(turn.from_start || ended_on_credits || spent) {
            return;
        }
        let credit_use = CreditUse {
            account_id: account,
            from_start: turn.from_start,
            balance_before: turn.balance,
            balance_after,
        };
        evidence["creditUse"] = json!(credit_use);
        attempt.credit_use = Some(credit_use);
    }

    pub(in super::super) async fn native_execution_receipt(
        &self,
        host: &Arc<crate::services::agent_host::router::Inner>,
        attempt: &Attempt,
        terminal: &Value,
    ) -> Result<Option<native_receipt::NativeExecutionReceipt>> {
        let dispatch: ExecutionDispatch =
            serde_json::from_value(terminal["terminalDispatch"].clone())?;
        if dispatch.phase != "terminal"
            || dispatch.error.is_some()
            || dispatch.result.is_none()
            || dispatch.request_key != dispatch_key(attempt)
            || attempt
                .observed
                .as_ref()
                .and_then(|value| value.inventory_revision.as_ref())
                .is_none()
        {
            // Legacy/failed/unknown turns retain their evidence; none can gain
            // a native deployment attestation from selected intent.
            return Ok(None);
        }
        let (owner, _) = host
            .store
            .execution_owner(&dispatch.session_id)
            .await
            .map_err(host_error)?
            .ok_or_else(|| {
                BenchmarkError::new(
                    "native_receipt_conflict",
                    "Native execution owner disappeared",
                )
            })?;
        let provider = NativeProvider::for_harness(&owner.provider_id).ok_or_else(|| {
            BenchmarkError::new(
                "native_receipt_conflict",
                "Native receipt provider is unsupported",
            )
        })?;
        // The receipt attests the runtime as it is after the turn, so it
        // observes the sandbox again instead of sharing an observation made
        // before the turn ended; the checks below then use this one.
        sandbox::observe_now().await.map_err(|error| {
            let message = error.to_string();
            host_error(match message.find("resource_busy:") {
                Some(start) => message[start..].to_owned(),
                None => format!("capability_missing: {message}"),
            })
        })?;
        let inventory = self
            .run_inventory(host, &attempt.run_id, &owner.provider_id, &owner.account_id)
            .await?;
        let repository_revision = if owner.profile == ExecutionProfile::ProtectedRepositoryV1 {
            let status = repository_execution::readiness(provider, &owner.account_id)
                .await
                .map_err(host_error)?;
            Some(repository_execution::revision(provider, &status))
        } else {
            None
        };
        let text_revision = if owner.profile == ExecutionProfile::NativeTextV1 {
            let status = text_execution::readiness(provider, &owner.account_id)
                .await
                .map_err(host_error)?;
            Some(text_execution::revision(provider, &status))
        } else {
            None
        };
        let inventory_revision = if let Some(revision) = &repository_revision {
            repository_inventory_revision(revision, &inventory, &owner.model_id)
        } else {
            text_inventory_revision(
                text_revision.as_deref().expect("validated text revision"),
                &inventory,
                &owner.model_id,
            )
        };
        if attempt
            .observed
            .as_ref()
            .and_then(|value| value.inventory_revision.as_ref())
            != Some(&inventory_revision)
        {
            return Err(BenchmarkError::new(
                "native_receipt_conflict",
                "Actual native runtime changed since execution acknowledgement",
            ));
        }
        let receipt = native_receipt::attest(
            &host.store,
            &dispatch.request_key,
            attempt.session_id.as_deref().ok_or_else(|| {
                BenchmarkError::new(
                    "native_receipt_conflict",
                    "Native session identity is absent",
                )
            })?,
            attempt.host_run_id.as_deref().ok_or_else(|| {
                BenchmarkError::new("native_receipt_conflict", "Native run identity is absent")
            })?,
            &turn_owner(attempt),
            &native_receipt::VerifiedRuntime {
                provider_id: owner.provider_id.clone(),
                account_id: owner.account_id.clone(),
                model_id: owner.model_id.clone(),
                execution_profile: native_receipt::profile(&owner).into(),
                inventory_revision,
                repository_revision,
                text_revision,
            },
        )
        .await?;
        receipt.validate_terminal_dispatch(&dispatch)?;
        Ok(Some(receipt))
    }

    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            inventories: RunInventories::default(),
        }
    }
}

/// A session opened on a context lane that its bridge acknowledges under the
/// lane's declared alias acknowledged the lane: Claude Code 2.1.312 runs
/// `opus[1m]` at Opus 5.5's native 1M window and names it `opus` (10-31),
/// and every Opus row, judge and task turn was refused as another model. The
/// host's substitution for it is dropped and the selection names the lane
/// the row measures; any other substitution stands.
pub(crate) fn acknowledge_lane(
    provider: &str,
    requested: &str,
    session: &mut crate::services::agent_host::execution::OwnedSession,
) {
    let lane = |applied: &str| {
        requested.strip_suffix("[1m]") == Some(applied)
            && crate::services::agent_host::harness::harness(provider)
                .and_then(|spec| spec.models.iter().find(|model| model.id == applied))
                .and_then(|model| model.alias_of)
                == Some(requested)
    };
    session.substitutions.retain(|substitution| {
        !(substitution["role"] == "model"
            && substitution["requested"] == requested
            && substitution["applied"].as_str().is_some_and(lane))
    });
    if session.selection.model_id.as_deref().is_some_and(lane) {
        session.selection.model_id = Some(requested.to_string());
    }
}

/// Why a configuration asking for fast mode never runs in a benchmark.
pub(in crate::services::benchmarks) const FAST_MODE_REFUSED: &str =
    "Fast mode is never used in benchmarks; choose the configuration without it";

/// What an inventory without an account asks for: a managed account, or the
/// CLI sign-in of a provider whose CLI keeps its own.
pub(in super::super) fn account_refusal(provider: &str) -> &'static str {
    if crate::services::provider_accounts::uses_cli_login(provider) {
        "Choose the CLI sign-in"
    } else {
        "Choose a managed account"
    }
}

/// Why a configuration cannot run under any verified native profile: fast
/// mode (never used for benchmarks: candidates, judges and campaign lanes
/// all run at normal speed, owner 10-18), an unknown provider, no account
/// (worded for what the provider signs in with), or an effort its profile
/// refuses.
pub(in crate::services::benchmarks) fn profile_refusal(c: &Configuration) -> Option<String> {
    if c.fast_mode == Some(true) {
        return Some(FAST_MODE_REFUSED.into());
    }
    let Some(provider) = NativeProvider::for_harness(&c.provider_id) else {
        return Some("This provider/account has no verified native text execution policy".into());
    };
    if c.account_id.as_deref().is_none_or(str::is_empty) {
        return Some(account_refusal(&c.provider_id).into());
    }
    provider.effort_refusal(c.effort.as_deref())
}

/// Static policy restrictions. Linux proof and account readiness are checked
/// asynchronously against the actual sandbox runtime before admission.
pub(in super::super) fn native_refusal(c: &Configuration) -> Option<String> {
    profile_refusal(c)
}

pub(in super::super) async fn text_runtime_snapshot(
    c: &Configuration,
    budget: Option<u32>,
) -> Result<(String, sandbox::Status)> {
    if let Some(reason) = profile_refusal(c) {
        return Err(BenchmarkError::new("capability_missing", reason));
    }
    let provider = NativeProvider::for_harness(&c.provider_id).expect("validated provider");
    let status = text_execution::readiness(provider, c.account_id.as_deref().unwrap_or_default())
        .await
        .map_err(host_error)?;
    // A leased provider's credentials are the Flock grant `with_app_sign_in`
    // checked; only a sandbox sign-in (Kimi) is checked here.
    if let Some(timeout) = budget.filter(|_| !credential_lease::leased(provider)) {
        status
            .require_account_window(
                provider.key(),
                c.account_id.as_deref().unwrap_or_default(),
                now(),
                timeout,
            )
            .map_err(|error| BenchmarkError::new("capability_missing", error.to_string()))?;
    }
    Ok((text_execution::revision(provider, &status), status))
}

pub(in super::super) async fn repository_runtime_for_budget(
    c: &Configuration,
    budget: Option<u32>,
) -> Result<String> {
    repository_runtime_snapshot(c, budget)
        .await
        .map(|(revision, _)| revision)
}

async fn repository_runtime_snapshot(
    c: &Configuration,
    budget: Option<u32>,
) -> Result<(String, sandbox::Status)> {
    if let Some(reason) = profile_refusal(c) {
        return Err(BenchmarkError::new("capability_missing", reason));
    }
    let provider = NativeProvider::for_harness(&c.provider_id).expect("validated provider");
    let status =
        repository_execution::readiness(provider, c.account_id.as_deref().unwrap_or_default())
            .await
            .map_err(host_error)?;
    // A leased provider's credentials are the Flock grant `with_app_sign_in`
    // checked; only a sandbox sign-in (Kimi) is checked here.
    if let Some(timeout) = budget.filter(|_| !credential_lease::leased(provider)) {
        status
            .require_account_window(
                provider.key(),
                c.account_id.as_deref().unwrap_or_default(),
                now(),
                timeout,
            )
            .map_err(|error| BenchmarkError::new("capability_missing", error.to_string()))?;
    }
    Ok((repository_execution::revision(provider, &status), status))
}

impl NativeBackend {
    /// Whether the sandbox can run `c`, for an attempt of `budget` seconds
    /// (planning: none), once the Flock sign-in its lease comes from lasts
    /// for it (see [`with_app_sign_in`]).
    pub(in super::super) fn sandbox_readiness<'a>(
        &'a self,
        c: &'a Configuration,
        budget: Option<u32>,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let repository = match c.execution_profile.as_str() {
                "protected_repository" => true,
                "native_text" => false,
                _ => return Ok(()),
            };
            let check = move || async move {
                if repository {
                    repository_runtime_for_budget(c, budget).await?;
                } else {
                    text_runtime_snapshot(c, budget).await?;
                }
                Ok::<_, BenchmarkError>(())
            };
            if !NativeProvider::for_harness(&c.provider_id).is_some_and(credential_lease::leased) {
                return check().await;
            }
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            with_app_sign_in(&host, c, budget, false, check)
                .await
                .map(|((), _)| ())
        })
    }

    /// The model inventory, runtime revision and sandbox credential snapshot
    /// an attempt of `timeout` seconds on `c` in `run` is admitted with.
    ///
    /// Boxed: it runs under the runner's deep attempt futures (see
    /// `Inner::ensure_execution_bridge`).
    pub(in super::super) fn admitted_runtime<'a>(
        &'a self,
        host: &'a Arc<crate::services::agent_host::router::Inner>,
        run: &'a str,
        c: &'a Configuration,
        account: &'a str,
        timeout: u32,
        repository: bool,
    ) -> BoxFuture<'a, Result<(Value, String, sandbox::Status)>> {
        Box::pin(async move {
            let inventory = self
                .run_inventory(host, run, &c.provider_id, account)
                .await?;
            let (revision, status) = if repository {
                let (runtime, status) = repository_runtime_snapshot(c, Some(timeout)).await?;
                (
                    repository_inventory_revision(&runtime, &inventory, &c.model_id),
                    status,
                )
            } else {
                let (runtime, status) = text_runtime_snapshot(c, Some(timeout)).await?;
                (
                    text_inventory_revision(&runtime, &inventory, &c.model_id),
                    status,
                )
            };
            Ok((inventory, revision, status))
        })
    }
}

/// Reuse the account's model catalog, but pin the WSL runtime rather than the
/// Windows executable that listed it. Renamed aliases
/// invalidate the selected configuration as they do for native text.
pub(in super::super) fn repository_inventory_revision(
    runtime: &str,
    inventory: &Value,
    model: &str,
) -> String {
    model_revision(
        Sha256::new().chain_update(runtime.as_bytes()),
        inventory,
        model,
    )
}

pub(in super::super) fn text_inventory_revision(
    runtime: &str,
    inventory: &Value,
    model: &str,
) -> String {
    model_revision(
        Sha256::new()
            .chain_update(b"isolated-linux-text-inventory-v1\0")
            .chain_update(runtime.as_bytes()),
        inventory,
        model,
    )
}

/// The revision of a configuration on `model_id` pinned to `runtime`, which
/// each row completes with its own model, so a change to another row of the
/// vendor's list leaves a configuration's revision alone.
fn model_revision(mut hash: Sha256, inventory: &Value, model_id: &str) -> String {
    hash.update(b"committed-entry-v2\0");
    match model_row_identity(inventory, model_id) {
        Some(row) => {
            hash.update(b"model\0");
            hash.update(row.as_bytes());
        }
        None => {
            hash.update(b"unlisted\0");
            hash.update(model_id.as_bytes());
        }
    }
    hex::encode(hash.finalize())
}

/// The effort levels a bridge row offers that the profile does not refuse.
/// The CLI's "default" names no level, so it is never offered: a model whose
/// only entry is "default" has no effort control here and runs unset.
pub(in super::super) fn offered_efforts(row: &Value, excluded: &[String]) -> Vec<String> {
    row.get("reasoningEfforts")
        .or_else(|| row.get("efforts"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().or_else(|| v["value"].as_str()))
        .filter(|effort| !crate::services::benchmarks::effort::names_cli_default(Some(*effort)))
        .filter(|effort| !excluded.iter().any(|refused| refused == effort))
        .map(str::to_owned)
        .collect()
}

/// The row of `model_id` in an inventory as `id` and display name, for
/// profiles configured by the policy resource; `None` when it is not listed.
fn model_row_identity(inventory: &Value, model_id: &str) -> Option<String> {
    inventory["models"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|row| {
            let id = row
                .get("modelId")
                .or_else(|| row.get("id"))
                .and_then(Value::as_str)
                .filter(|id| *id == model_id)?;
            Some(format!("{id}\u{1f}{}", row["name"].as_str().unwrap_or(id)))
        })
}

pub(in super::super) fn prompt_with_fixtures(draft: &BenchmarkDraft) -> Result<String> {
    public_task_prompt(&crate::services::benchmarks::learned::PublicTask::from(
        draft,
    ))
}

/// Collection and application deployment use byte-identical role, entry and
/// fixture composition. Neither adapter accepts a second renderer system prompt.
pub(in crate::services::benchmarks) fn public_task_prompt(
    draft: &crate::services::benchmarks::learned::PublicTask,
) -> Result<String> {
    let mut prompt = String::new();
    if !draft.role_prompt.is_empty() {
        prompt.push_str("Authored role context:\n");
        prompt.push_str(&draft.role_prompt);
        prompt.push_str("\n\n");
    }
    if let Some(entry) = &draft.entry {
        prompt.push_str("Frozen continuation context:\n");
        prompt.push_str(&entry.conversation_prefix);
        for report in &entry.previous_reports {
            prompt.push_str("\nPermitted previous report:\n");
            prompt.push_str(report);
        }
        prompt.push_str("\n\n");
    }
    prompt.push_str(&draft.prompt);
    for fixture in &draft.fixtures {
        prompt.push_str("\n\nPublic fixture ");
        prompt.push_str(&fixture.path);
        prompt.push_str(":\n");
        prompt.push_str(&fixture.content);
    }
    if prompt.len() > 256 * 1024 {
        return Err(BenchmarkError::new(
            "validation",
            "Prompt and public fixtures exceed 256 KiB for the native text profile",
        ));
    }
    Ok(prompt)
}
