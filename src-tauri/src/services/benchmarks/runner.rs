use super::{
    evaluation, fixtures,
    store::{now, Store},
    types::*,
    BenchmarkService,
};
use crate::services::agent_host::{execution::*, AgentHost};
use crate::services::provider_account_status::benchmark_sampling::{self, AccountMeasurement};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::sync::watch;

pub trait ExecutionBackend: Send + Sync {
    fn unsupported(&self, configuration: &Configuration, draft: &BenchmarkDraft) -> Option<String>;
    fn execute<'a>(
        &'a self,
        store: &'a Store,
        attempt: Attempt,
        version: BenchmarkVersion,
        timeout: u32,
        cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>>;
    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        refresh: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>>;
    fn recover<'a>(
        &'a self,
        _store: &'a Store,
        attempt: Attempt,
    ) -> BoxFuture<'a, Result<Option<Attempt>>> {
        Box::pin(async move {
            Ok((attempt.evidence_hash.is_some() && attempt.output.is_some()).then_some(attempt))
        })
    }
    fn sample<'a>(
        &'a self,
        _configuration: &'a Configuration,
        _not_before: i64,
    ) -> BoxFuture<'a, Result<Option<AccountMeasurement>>> {
        Box::pin(async { Ok(None) })
    }
    fn activity<'a>(
        &'a self,
        _configuration: &'a Configuration,
    ) -> BoxFuture<'a, Result<AccountActivity>> {
        Box::pin(async {
            Ok(AccountActivity {
                active_sessions: Vec::new(),
                generation: 0,
            })
        })
    }
}
pub struct NativeBackend {
    pub app: tauri::AppHandle,
}
pub fn host_error(message: String) -> BenchmarkError {
    let (code, reason) = message
        .split_once(':')
        .unwrap_or(("infrastructure_failure", &message));
    BenchmarkError::new(code, reason.trim())
}

impl ExecutionBackend for NativeBackend {
    fn unsupported(&self, c: &Configuration, d: &BenchmarkDraft) -> Option<String> {
        if c.provider_id != "claude-acp" || c.account_id.as_deref().is_none_or(str::is_empty) {
            return Some(
                "This provider/account has no verified native text execution policy".into(),
            );
        }
        if c.execution_profile != "native_text" {
            return Some(
                "Choose the native text configuration for bounded artifact generation".into(),
            );
        }
        if d.execution_profile != "native_text"
            && !matches!(d.evaluator.kind.as_str(), "javascript" | "browser")
        {
            return Some(
                "General repository execution requires a verified filesystem boundary".into(),
            );
        }
        if matches!(d.evaluator.kind.as_str(), "javascript" | "browser")
            && !super::worker::available()
        {
            return Some("The isolated artifact evaluator is unavailable".into());
        }
        if !d.permissions.tools.is_empty()
            || d.permissions.network
            || d.permissions.context != "clean"
        {
            return Some(
                "The text profile requires clean context, no native tools and no network tools"
                    .into(),
            );
        }
        None
    }
    fn sample<'a>(
        &'a self,
        c: &'a Configuration,
        not_before: i64,
    ) -> BoxFuture<'a, Result<Option<AccountMeasurement>>> {
        Box::pin(async move {
            match c.account_id.as_deref() {
                Some(account) => {
                    match benchmark_sampling::sample_account(&self.app, account, not_before).await {
                        Ok(sample) => Ok(Some(sample)),
                        Err(error) => {
                            log::info!("[benchmarks] quota unavailable: {error}");
                            Ok(None)
                        }
                    }
                }
                None => Ok(None),
            }
        })
    }
    fn activity<'a>(&'a self, c: &'a Configuration) -> BoxFuture<'a, Result<AccountActivity>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            host.account_activity(&c.provider_id, "*")
                .await
                .map_err(host_error)
        })
    }
    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        refresh: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(async move {
            let account = account.ok_or_else(|| {
                BenchmarkError::new("capability_missing", "Choose a managed account")
            })?;
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            let result = host
                .benchmark_inventory(provider, account, refresh)
                .await
                .map_err(host_error)?;
            let billing = crate::services::provider_accounts::account(&self.app, account)
                .map_err(host_error)?
                .auth_method;
            let revision = Some(inventory_fingerprint(&result).await?);
            let unavailable = if provider != "claude-acp" {
                Some("Native execution restrictions have not been verified".to_string())
            } else {
                result
                    .pointer("/executable/path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Native executable provenance is missing".to_string())
                    .and_then(|path| validate_native_runtime(std::path::Path::new(path)))
                    .err()
            };
            Ok(result["models"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|row| {
                    let id = row
                        .get("modelId")
                        .or_else(|| row.get("id"))
                        .and_then(Value::as_str)?;
                    let efforts = row
                        .get("reasoningEfforts")
                        .or_else(|| row.get("efforts"))
                        .and_then(Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(|v| {
                                    v.as_str()
                                        .or_else(|| v["value"].as_str())
                                        .map(str::to_owned)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(InventoryModel {
                        configuration: Configuration {
                            id: format!("{provider}:{account}:{id}"),
                            provider_id: provider.into(),
                            account_id: Some(account.into()),
                            model_id: id.into(),
                            effort: None,
                            fast_mode: None,
                            billing_mode: if billing
                                == crate::services::provider_accounts::AuthMethod::ApiKey
                            {
                                "api"
                            } else {
                                "subscription"
                            }
                            .into(),
                            execution_profile: "native_text".into(),
                            inventory_revision: revision.clone(),
                        },
                        name: row["name"].as_str().unwrap_or(id).into(),
                        efforts,
                        supports_fast_mode: row["supportsFast"].as_bool().unwrap_or(false),
                        available: unavailable.is_none(),
                        reason: unavailable.clone(),
                    })
                })
                .collect())
        })
    }
    fn execute<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
        version: BenchmarkVersion,
        timeout: u32,
        mut cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            if *cancel.borrow()
                || !matches!(
                    store.run(&attempt.run_id).await?.state.as_str(),
                    "running" | "pausing"
                )
            {
                return Err(BenchmarkError::new(
                    "cancelled",
                    "Run stopped before preparation",
                ));
            }
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            let account = attempt.configuration.account_id.clone().ok_or_else(|| {
                BenchmarkError::new("capability_missing", "Managed account is required")
            })?;
            let inventory = host
                .benchmark_inventory(&attempt.configuration.provider_id, &account, true)
                .await
                .map_err(host_error)?;
            let runtime_revision = inventory_fingerprint(&inventory).await?;
            if attempt
                .configuration
                .inventory_revision
                .as_ref()
                .is_some_and(|revision| revision != &runtime_revision)
            {
                return Err(BenchmarkError::new("selection_changed","Installed runtime or model capabilities changed since configuration selection; refresh inventory"));
            }
            let activity = host
                .account_activity(&attempt.configuration.provider_id, &account)
                .await
                .map_err(host_error)?;
            if !activity.active_sessions.is_empty() {
                return Err(BenchmarkError::new(
                    "account_busy",
                    "Interactive work has priority; account is active",
                ));
            }
            let cwd = store
                .root
                .join("runs")
                .join(&attempt.run_id)
                .join(&attempt.id)
                .join("workspace");
            tokio::fs::create_dir_all(&cwd).await?;
            let session = host
                .create_owned_session(OwnedSessionRequest {
                    owner_id: attempt.id.clone(),
                    provider_id: attempt.configuration.provider_id.clone(),
                    account_id: account,
                    model_id: attempt.configuration.model_id.clone(),
                    reasoning_effort: attempt.configuration.effort.clone(),
                    fast_mode: attempt.configuration.fast_mode,
                    cwd: cwd.to_string_lossy().into_owned(),
                    title: format!(
                        "Benchmark: {} [{}]",
                        version.manifest.name,
                        attempt.repetition + 1
                    ),
                    profile: ExecutionProfile::NativeTextV1,
                })
                .await
                .map_err(host_error)?;
            attempt.session_id = Some(session.session_id.clone());
            let mut observed = attempt.configuration.clone();
            observed.model_id = session.selection.model_id.unwrap_or_default();
            observed.effort = session.selection.reasoning_effort;
            observed.fast_mode = session.selection.fast_mode;
            observed.inventory_revision = Some(runtime_revision);
            attempt.observed = Some(observed.clone());
            if !session.substitutions.is_empty()
                || !matches_selection(&attempt.configuration, &observed)
            {
                store.save_attempt(&attempt).await?;
                return Err(BenchmarkError::new(
                    "selection_changed",
                    "Provider did not acknowledge the exact model, effort and fast mode",
                ));
            }
            attempt.phase = "dispatching".into();
            if *cancel.borrow()
                || !matches!(
                    store.run(&attempt.run_id).await?.state.as_str(),
                    "running" | "pausing"
                )
            {
                return Err(BenchmarkError::new(
                    "cancelled",
                    "Run stopped before prompt dispatch",
                ));
            }
            store.save_attempt(&attempt).await?;
            let key = format!("benchmark:{}:0", attempt.id);
            let timeout_seconds = effective_timeout_seconds(timeout, &version.manifest);
            let started = Instant::now();
            let dispatch = host
                .dispatch_owned_turn(OwnedTurnRequest {
                    session_id: session.session_id.clone(),
                    request_key: key.clone(),
                    prompt: prompt_with_fixtures(&version.manifest)?,
                    policy_hash: session.policy_hash,
                    timeout_ms: u64::from(timeout_seconds) * 1000,
                })
                .await
                .map_err(host_error)?;
            attempt.host_run_id = Some(dispatch.run_id);
            attempt.phase = "running".into();
            store.save_attempt(&attempt).await?;
            let mut cancelled = false;
            let mut timed_out = false;
            let mut cancellation_started = None;
            let mut output_capped = false;
            let mut evidence = Vec::new();
            let mut evidence_bytes = 0usize;
            let mut output = String::new();
            loop {
                if (*cancel.borrow()
                    || started.elapsed() > Duration::from_secs(u64::from(timeout_seconds)))
                    && !cancelled
                {
                    timed_out = !*cancel.borrow();
                    host.cancel_owned_turn(&key).await.map_err(host_error)?;
                    cancelled = true;
                    cancellation_started = Some(Instant::now());
                }
                if cancellation_started.is_some_and(|t| t.elapsed() > Duration::from_secs(15)) {
                    return Err(BenchmarkError::new(
                        "dispatch_uncertain",
                        "Cancellation was not confirmed; account requires inspection",
                    ));
                }
                let page = host
                    .read_owned_events(&session.session_id, attempt.event_cursor, 200)
                    .await
                    .map_err(host_error)?;
                for event in page.events {
                    consume_event(&event.payload, &mut output, &mut attempt.usage);
                    let bytes = serde_json::to_vec(&event.payload)?.len();
                    evidence_bytes = evidence_bytes.saturating_add(bytes);
                    if evidence_bytes <= version.manifest.limits.max_artifact_bytes as usize {
                        evidence.push(event.payload);
                    } else {
                        output_capped = true;
                    }
                }
                attempt.event_cursor = page.cursor;
                if output.len() > version.manifest.limits.max_artifact_bytes as usize {
                    output_capped = true;
                    let mut end = version.manifest.limits.max_artifact_bytes as usize;
                    while !output.is_char_boundary(end) {
                        end -= 1;
                    }
                    output.truncate(end);
                }
                if output_capped && !cancelled {
                    host.cancel_owned_turn(&key).await.map_err(host_error)?;
                    cancelled = true;
                    cancellation_started = Some(Instant::now());
                }
                let status = host
                    .execution_status(&key)
                    .await
                    .map_err(host_error)?
                    .ok_or_else(|| {
                        BenchmarkError::new(
                            "dispatch_uncertain",
                            "Host dispatch record disappeared",
                        )
                    })?;
                if status.phase == "terminal"
                    && !page.has_more
                    && attempt.event_cursor >= status.event_cursor
                {
                    evidence.push(json!({"terminalDispatch":status}));
                    if let Some(result) = status.result.as_ref() {
                        consume_terminal_result(result, &mut attempt);
                    }
                    if let Some(selection) = status
                        .result
                        .as_ref()
                        .and_then(|r| r.get("observedSelection"))
                    {
                        let observed = ObservedSelection {
                            model_id: selection["modelId"].as_str().map(str::to_owned),
                            reasoning_effort: selection["reasoningEffort"]
                                .as_str()
                                .map(str::to_owned),
                            fast_mode: selection["fastMode"].as_bool(),
                        };
                        if observed.model_id.as_deref()
                            != Some(attempt.configuration.model_id.as_str())
                            || attempt
                                .configuration
                                .effort
                                .as_ref()
                                .is_some_and(|e| Some(e) != observed.reasoning_effort.as_ref())
                            || attempt
                                .configuration
                                .fast_mode
                                .is_some_and(|f| Some(f) != observed.fast_mode)
                        {
                            attempt.outcome = Some("selection_changed".into());
                            attempt.reason =
                                Some("Provider selection changed during execution".into());
                            break;
                        }
                    }
                    if output_capped {
                        attempt.outcome = Some("budget_reached".into());
                        attempt.reason=Some("Output/evidence exceeded the published artifact cap; cancellation acknowledged".into());
                    } else if let Some(error) = status.error {
                        attempt.outcome = Some(terminal_error_outcome(&error).into());
                        attempt.reason = Some(error.to_string());
                    } else if cancelled {
                        attempt.outcome = Some(
                            if timed_out {
                                "budget_timeout"
                            } else {
                                "cancelled"
                            }
                            .into(),
                        );
                    } else {
                        attempt.outcome = Some("completed".into());
                    }
                    break;
                }
                if status.phase == "uncertain" {
                    return Err(BenchmarkError::new(
                        "dispatch_uncertain",
                        "Host cannot determine remote acceptance",
                    ));
                }
                if !page.has_more {
                    tokio::select! {_ = tokio::time::sleep(Duration::from_millis(250))=>{},_ = cancel.changed()=>{}}
                }
            }
            attempt.output = Some(output);
            attempt.duration_ms = Some(started.elapsed().as_millis() as u64);
            attempt.finished_at = Some(now());
            attempt.phase = "collecting".into();
            mark_auxiliary_profile(&mut attempt);
            attempt.evidence_hash =
                Some(fixtures::seal(&store.root, &attempt, &json!(evidence)).await?);
            store.save_attempt(&attempt).await?;
            Ok(attempt)
        })
    }
    fn recover<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
    ) -> BoxFuture<'a, Result<Option<Attempt>>> {
        Box::pin(async move {
            if attempt.evidence_hash.is_some()
                && attempt
                    .outcome
                    .as_deref()
                    .is_some_and(|outcome| !matches!(outcome, "interrupted" | "dispatch_uncertain"))
            {
                return Ok(Some(attempt));
            }
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            let key = format!("benchmark:{}:0", attempt.id);
            let Some(status) = host.execution_status(&key).await.map_err(host_error)? else {
                return Ok(None);
            };
            if status.phase != "terminal" {
                return Ok(None);
            }
            attempt.session_id = Some(status.session_id.clone());
            attempt.host_run_id = Some(status.run_id.clone());
            attempt.event_cursor = 0;
            attempt.usage = TokenUsage::default();
            let mut output = String::new();
            let mut evidence = Vec::new();
            loop {
                let page = host
                    .read_owned_events(&status.session_id, attempt.event_cursor, 200)
                    .await
                    .map_err(host_error)?;
                for event in page.events {
                    consume_event(&event.payload, &mut output, &mut attempt.usage);
                    evidence.push(event.payload);
                }
                attempt.event_cursor = page.cursor;
                if output.len() > 16 * 1024 * 1024 {
                    return Err(BenchmarkError::new(
                        "budget_reached",
                        "Recovered evidence exceeds artifact cap",
                    ));
                }
                if !page.has_more && attempt.event_cursor >= status.event_cursor {
                    break;
                }
            }
            if let Some(result) = status.result.as_ref() {
                consume_terminal_result(result, &mut attempt);
            }
            evidence.push(json!({"terminalDispatch":status}));
            attempt.output = Some(output);
            attempt.finished_at = Some(now());
            attempt.outcome = Some(
                status
                    .error
                    .as_ref()
                    .map(terminal_error_outcome)
                    .unwrap_or("completed")
                    .into(),
            );
            attempt.reason = status.error.map(|v| v.to_string());
            if let Some(selection) = status
                .result
                .as_ref()
                .and_then(|v| v.get("observedSelection"))
            {
                if selection["modelId"].as_str() != Some(attempt.configuration.model_id.as_str())
                    || attempt
                        .configuration
                        .effort
                        .as_ref()
                        .is_some_and(|e| selection["reasoningEffort"].as_str() != Some(e.as_str()))
                    || attempt
                        .configuration
                        .fast_mode
                        .is_some_and(|f| selection["fastMode"].as_bool() != Some(f))
                {
                    attempt.outcome = Some("selection_changed".into());
                    attempt.reason = Some(
                        "Recovered terminal selection differs from the requested configuration"
                            .into(),
                    );
                }
            } else if attempt.outcome.as_deref() == Some("completed") {
                attempt.outcome = Some("selection_changed".into());
                attempt.reason =
                    Some("Recovered terminal state lacks acknowledged selection".into());
            }
            mark_auxiliary_profile(&mut attempt);
            attempt.evidence_hash =
                Some(fixtures::seal(&store.root, &attempt, &json!(evidence)).await?);
            Ok(Some(attempt))
        })
    }
}

fn consume_event(event: &Value, output: &mut String, usage: &mut TokenUsage) {
    let params = event.get("params").unwrap_or(event);
    let update = params.get("update").unwrap_or(params);
    match update["sessionUpdate"].as_str() {
        Some("agent_message_chunk") => {
            if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                output.push_str(text);
            }
        }
        Some("usage_update") => {
            // Each owned session has exactly one submitted turn. This is its inclusive
            // cumulative native USD cost, not context occupancy or subscription debit.
            if update.pointer("/cost/currency").and_then(Value::as_str) == Some("USD") {
                if let Some(amount) = update
                    .pointer("/cost/amount")
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite() && *v >= 0.0)
                {
                    usage.cost = Some(usage.cost.map_or(amount, |previous| previous.max(amount)));
                }
            }
        }
        Some("message_usage") => {
            consume_usage(update.get("usage").unwrap_or(update), usage);
        }
        Some("benchmark_turn_result") => {
            if let Some(raw) = update.pointer("/_meta/benchmarkRawResult/usage") {
                consume_usage(raw, usage);
            }
            if let Some(models) = update
                .pointer("/_meta/benchmarkRawResult/quota/model_usage")
                .and_then(Value::as_array)
            {
                consume_model_usage(models, usage);
            }
        }
        _ => {}
    }
}
fn mark_auxiliary_profile(attempt: &mut Attempt) {
    if attempt.usage.schema == "provider_turn_with_auxiliary_v2" {
        if let Some(observed) = attempt.observed.as_mut() {
            observed.execution_profile = "native_text_auxiliary".into();
        }
    }
}
fn consume_terminal_result(result: &Value, attempt: &mut Attempt) {
    if let Some(usage) = result.get("usage") {
        consume_usage(usage, &mut attempt.usage);
    }
    if let Some(models) = result
        .pointer("/_meta/quota/model_usage")
        .and_then(Value::as_array)
    {
        consume_model_usage(models, &mut attempt.usage);
    }
    mark_auxiliary_profile(attempt);
}
fn consume_model_usage(models: &[Value], usage: &mut TokenUsage) {
    // Disjoint per-model turn deltas include auxiliary native calls. Replace the
    // primary-turn totals; never add both. Preserve them on failed paid turns too.
    let active: Vec<_> = models
        .iter()
        .filter(|model| {
            [
                "totalTokens",
                "inputTokens",
                "outputTokens",
                "cachedInputTokens",
                "cachedWriteTokens",
            ]
            .iter()
            .any(|field| model["token_count"][*field].as_u64().is_some_and(|n| n > 0))
        })
        .collect();
    if active.is_empty() {
        return;
    }
    let sum = |field: &str| {
        active.iter().try_fold(0u64, |total, model| {
            total.checked_add(model["token_count"][field].as_u64()?)
        })
    };
    let totals = [
        sum("inputTokens"),
        sum("outputTokens"),
        sum("cachedInputTokens"),
        sum("cachedWriteTokens"),
    ];
    let primary = [
        usage.input,
        usage.output,
        usage.cache_read,
        usage.cache_write,
    ];
    // A rejected primary turn may leave only a paid auxiliary call. Native model
    // aliases cannot identify that call reliably; compare the measured counters.
    // Missing primary counters cannot establish a pure-model measurement either.
    let extra_work = primary.iter().all(|value| value.is_none_or(|v| v == 0))
        || totals
            .iter()
            .zip(primary)
            .any(|(total, main)| total.is_some_and(|n| n > 0 && main.is_none_or(|m| n > m)));
    if active.len() == 1 && !extra_work {
        return;
    }
    usage.input = totals[0];
    usage.output = totals[1];
    usage.cache_read = totals[2];
    usage.cache_write = totals[3];
    usage.schema = "provider_turn_with_auxiliary_v2".into();
}

fn consume_usage(data: &Value, usage: &mut TokenUsage) {
    if usage.schema == "provider_turn_with_auxiliary_v2" {
        return;
    }
    if let Some(v) = data["inputTokens"].as_u64() {
        usage.input = Some(v);
    }
    if let Some(v) = data["outputTokens"].as_u64() {
        usage.output = Some(v);
    }
    if let Some(v) = data["cachedReadTokens"].as_u64() {
        usage.cache_read = Some(v);
    }
    if let Some(v) = data["cachedWriteTokens"]
        .as_u64()
        .or_else(|| data["cacheCreationTokens"].as_u64())
    {
        usage.cache_write = Some(v);
    }
    // Native Claude reasoning is included in output; synthetic zero in quota metadata is not a separate measurement.
    usage.schema = "provider_turn_usage_v1".into();
}
async fn inventory_fingerprint(inventory: &Value) -> Result<String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncReadExt;
    let path = inventory
        .pointer("/executable/path")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            BenchmarkError::new(
                "capability_missing",
                "Host inventory has no executable provenance",
            )
        })?;
    let mut file = tokio::fs::File::open(path).await?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    hash.update(include_bytes!("../../../../acp-tools.lock.json"));
    hash.update(NATIVE_TEXT_POLICY_REVISION.as_bytes());
    hash.update(NATIVE_TEXT_ADAPTER.as_bytes());
    hash.update(serde_json::to_vec(&inventory["models"])?);
    Ok(hex::encode(hash.finalize()))
}
fn matches_selection(requested: &Configuration, observed: &Configuration) -> bool {
    requested.model_id == observed.model_id
        && requested
            .effort
            .as_ref()
            .is_none_or(|e| Some(e) == observed.effort.as_ref())
        && requested
            .fast_mode
            .is_none_or(|f| Some(f) == observed.fast_mode)
}
fn effective_timeout_seconds(requested: u32, draft: &BenchmarkDraft) -> u32 {
    requested.min(draft.limits.timeout_seconds).min(
        draft
            .entry_state
            .as_ref()
            .map_or(u32::MAX, |entry| entry.remaining_budget_seconds),
    )
}

fn terminal_error_outcome(error: &Value) -> &'static str {
    match error["kind"]
        .as_str()
        .or_else(|| error.pointer("/data/kind").and_then(Value::as_str))
    {
        Some("budget_timeout") => "budget_timeout",
        Some("cancelled") => "cancelled",
        Some("selection_changed") => "selection_changed",
        Some("quota_blocked" | "quota_exhausted") => "quota_blocked",
        Some("dispatch_uncertain") => "dispatch_uncertain",
        Some("policy_violation" | "capability_missing") => "unsupported",
        _ => "infrastructure_failure",
    }
}
fn prompt_with_fixtures(draft: &BenchmarkDraft) -> Result<String> {
    let mut prompt = String::new();
    if !draft.role_prompt.is_empty() {
        prompt.push_str("Authored role context:\n");
        prompt.push_str(&draft.role_prompt);
        prompt.push_str("\n\n");
    }
    if let Some(entry) = &draft.entry_state {
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
pub async fn evaluate(draft: &BenchmarkDraft, output: &str) -> Result<Evaluation> {
    if matches!(draft.evaluator.kind.as_str(), "javascript" | "browser") {
        super::worker::evaluate(draft, output).await
    } else {
        evaluation::evaluate(&draft.evaluator, output)
    }
}

impl BenchmarkService {
    pub async fn run_loop(self: Arc<Self>) {
        loop {
            if let Err(error) = self.tick().await {
                log::warn!("[benchmarks] runner paused: {}", error.message);
            }
            tokio::select! {_ = self.wake.notified()=>{},_ = tokio::time::sleep(Duration::from_secs(1))=>{}}
        }
    }
    async fn tick(&self) -> Result<()> {
        let interrupted = sqlx::query_scalar::<_, String>(
            "SELECT data_json FROM attempts WHERE phase='interrupted'",
        )
        .fetch_all(&self.store.pool)
        .await?;
        for data in interrupted {
            let mut a: Attempt = serde_json::from_str(&data)?;
            let version = self.store.version(&a.version_id).await?;
            let recovered = if version.manifest.workflow.is_some() {
                super::workflow::recover(self, a.clone(), version.clone()).await?
            } else {
                self.backend.recover(&self.store, a.clone()).await?
            };
            match recovered {
                Some(mut restored) => {
                    // A recovered prefix waits for an explicit resume before another paid step.
                    if restored.phase == "pending" {
                        self.store.save_attempt(&restored).await?;
                        continue;
                    }
                    if restored.outcome.as_deref() == Some("completed") {
                        match evaluate(
                            &version.manifest,
                            restored.output.as_deref().unwrap_or_default(),
                        )
                        .await
                        {
                            Ok(e) => {
                                restored.outcome = Some(e.verdict.clone());
                                restored.evaluations.push(e);
                            }
                            Err(e) => {
                                restored.outcome = Some("evaluation_error".into());
                                restored.reason = Some(e.message);
                            }
                        }
                    }
                    restored.phase = "terminal".into();
                    self.store.save_attempt(&restored).await?;
                    self.changed().await;
                }
                None => {
                    a.phase = "terminal".into();
                    a.outcome = Some("dispatch_uncertain".into());
                    a.reason=Some("Remote acceptance cannot be established after restart; explicitly create a new run to retry".into());
                    a.finished_at = Some(now());
                    self.store.save_attempt(&a).await?;
                    self.changed().await;
                }
            }
        }
        super::campaigns::tick(self).await?;
        for run in self.store.active_runs().await? {
            if run.state == "pausing" {
                self.store.set_run_state(&run.id, "paused").await?;
                self.changed().await;
                continue;
            }
            if run.state == "cancelling" {
                for mut a in run.attempts {
                    if a.phase == "pending" {
                        a.phase = "terminal".into();
                        a.outcome = Some("cancelled".into());
                        a.finished_at = Some(now());
                        self.store.save_attempt(&a).await?;
                    }
                }
                self.store.set_run_state(&run.id, "cancelled").await?;
                self.changed().await;
                continue;
            }
            if run.state != "running" {
                continue;
            }
            let Some(mut a) = run.attempts.iter().find(|a| a.phase == "pending").cloned() else {
                self.finish_measurement(&run).await?;
                self.store.set_run_state(&run.id, "completed").await?;
                self.changed().await;
                continue;
            };
            let version = self.store.version(&a.version_id).await?;
            fixtures::verify_blob(&self.store.root, &version.content_hash, &version.manifest)
                .await?;
            if version.manifest.measurement_profile != "task_metrics"
                && !self.begin_measurement(&run).await?
            {
                continue;
            }
            a.phase = "preparing".into();
            a.started_at = Some(now());
            self.store.save_attempt(&a).await?;
            let (cancel_tx, cancel_rx) = watch::channel(false);
            *self.active.lock().await = Some((run.id.clone(), cancel_tx));
            if self.store.run(&run.id).await?.state != "running" {
                a.phase = "pending".into();
                a.started_at = None;
                self.store.save_attempt(&a).await?;
                *self.active.lock().await = None;
                continue;
            }
            let result = if version.manifest.workflow.is_some() {
                super::workflow::execute(
                    self,
                    a.clone(),
                    version.clone(),
                    run.request.timeout_seconds,
                    cancel_rx,
                )
                .await
            } else {
                self.backend
                    .execute(
                        &self.store,
                        a.clone(),
                        version.clone(),
                        run.request.timeout_seconds,
                        cancel_rx,
                    )
                    .await
            };
            *self.active.lock().await = None;
            match result {
                Ok(mut completed) => {
                    if completed.outcome.as_deref() == Some("completed") {
                        match evaluate(
                            &version.manifest,
                            completed.output.as_deref().unwrap_or_default(),
                        )
                        .await
                        {
                            Ok(e) => {
                                completed.outcome = Some(e.verdict.clone());
                                completed.evaluations.push(e);
                            }
                            Err(e) => {
                                completed.outcome = Some("evaluation_error".into());
                                completed.reason = Some(e.message);
                            }
                        }
                    }
                    completed.phase = "terminal".into();
                    self.store.save_attempt(&completed).await?;
                }
                Err(error) => {
                    let mut failed = self.store.attempt(&a.id).await?;
                    if error.code == "account_busy" {
                        failed.phase = "pending".into();
                        failed.started_at = None;
                        self.store.save_attempt(&failed).await?;
                        return Ok(());
                    }
                    failed.phase = "terminal".into();
                    failed.outcome = Some(error.code.clone());
                    failed.reason = Some(error.message);
                    failed.finished_at = Some(now());
                    self.store.save_attempt(&failed).await?;
                    if ["dispatch_uncertain", "storage_unavailable"].contains(&error.code.as_str())
                    {
                        self.store.set_run_state(&run.id, "needs_attention").await?;
                    }
                }
            }
            self.changed().await;
            break;
        }
        Ok(())
    }
    async fn begin_measurement(&self, run: &BenchmarkRun) -> Result<bool> {
        use sqlx::Row;
        let config = &run.request.configurations[0];
        let activity = self.backend.activity(config).await?;
        let previous=sqlx::query("SELECT activity_generation,attempt_ids_json FROM run_measurements WHERE run_id=? AND finished=0").bind(&run.id).fetch_optional(&self.store.pool).await?;
        if let Some(row) = previous {
            let ids: Vec<String> = serde_json::from_str(row.get(1))?;
            let expected = run
                .attempts
                .iter()
                .filter(|a| ids.contains(&a.id) && a.host_run_id.is_some())
                .count() as u64;
            if activity.active_sessions.is_empty()
                && activity
                    .generation
                    .saturating_sub(row.get::<i64, _>(0) as u64)
                    == expected
            {
                return Ok(true);
            }
            self.finish_measurement(run).await?;
            self.store.set_run_state(&run.id, "paused").await?;
            return Ok(false);
        }
        if !activity.active_sessions.is_empty() {
            return Ok(false);
        }
        let sample = self.backend.sample(config, now()).await?;
        let ids: Vec<&String> = run
            .attempts
            .iter()
            .filter(|a| a.phase == "pending")
            .map(|a| &a.id)
            .collect();
        sqlx::query(
            "INSERT INTO run_measurements(run_id,group_id,before_json,activity_generation,attempt_ids_json,started_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET group_id=excluded.group_id,before_json=excluded.before_json,activity_generation=excluded.activity_generation,attempt_ids_json=excluded.attempt_ids_json,started_at=excluded.started_at,finished=0",
        )
        .bind(&run.id)
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(serde_json::to_string(&sample)?)
        .bind(activity.generation as i64)
        .bind(serde_json::to_string(&ids)?)
        .bind(now())
        .execute(&self.store.pool)
        .await?;
        Ok(true)
    }
    async fn finish_measurement(&self, run: &BenchmarkRun) -> Result<()> {
        use sqlx::Row;
        let Some(row) = sqlx::query(
            "SELECT before_json,activity_generation,finished,group_id,attempt_ids_json,started_at FROM run_measurements WHERE run_id=?",
        )
        .bind(&run.id)
        .fetch_optional(&self.store.pool)
        .await?
        else {
            return Ok(());
        };
        if row.get::<bool, _>(2) {
            return Ok(());
        }
        let config = &run.request.configurations[0];
        let member_ids: Vec<String> = serde_json::from_str(row.get(4))?;
        let attempts: Vec<Attempt> = run
            .attempts
            .iter()
            .filter(|a| member_ids.contains(&a.id) && a.phase == "terminal")
            .cloned()
            .collect();
        let before: Option<AccountMeasurement> = serde_json::from_str(row.get(0))?;
        let after = self.backend.sample(config, now()).await?;
        let activity = self.backend.activity(config).await?;
        let expected = attempts.iter().filter(|a| a.host_run_id.is_some()).count() as u64;
        let changed = !activity.active_sessions.is_empty()
            || activity
                .generation
                .saturating_sub(row.get::<i64, _>(1) as u64)
                != expected;
        let version = self.store.version(&run.request.version_ids[0]).await?;
        let declared = version.manifest.environment["externalIsolationDeclared"]
            .as_bool()
            .unwrap_or(false);
        let mut samples = match (before, after) {
            (Some(before), Some(after)) => {
                super::usage::sample(&run.id, &attempts, &before, &after, changed, declared)
            }
            _ => Vec::new(),
        };
        if version.manifest.measurement_profile == "capacity" || samples.is_empty() {
            let (status, reason) = if version.manifest.measurement_profile == "capacity" {
                super::usage::capacity_result(
                    run.attempts
                        .iter()
                        .filter(|a| a.outcome.as_deref() == Some("pass"))
                        .count() as u32,
                    false,
                    false,
                    false,
                )
            } else {
                (
                    "not_measured".into(),
                    "Provider returned no resolvable quota window".into(),
                )
            };
            samples.push(UsageSample{id:uuid::Uuid::new_v4().to_string(),run_id:run.id.clone(),account_scope:config.account_id.clone().unwrap_or_else(||config.provider_id.clone()),window_id:"unreported".into(),captured_at:now(),before_used_percent:None,after_used_percent:None,resolution_percent:None,reset_at:None,attribution:"unknown".into(),status,completed_tasks:run.attempts.iter().filter(|a|a.outcome.as_deref()==Some("pass")).count() as u32,used_percentage_points:None,reason,attempt_ids:run.attempts.iter().map(|a|a.id.clone()).collect(),evidence:json!({"boundedExecutions":run.request.max_executions,"exhaustionVerified":false,"startingBalance":"unknown"})});
        }
        for mut sample in samples {
            sample.attempt_ids = attempts.iter().map(|a| a.id.clone()).collect();
            sample.completed_tasks = attempts
                .iter()
                .filter(|a| a.outcome.as_deref() == Some("pass"))
                .count() as u32;
            sample.evidence["workloadHash"]=json!(fixtures::hash(serde_json::to_string(&json!({"versions":run.request.version_ids,"configuration":config,"observed":attempts.iter().map(|a|&a.observed).collect::<Vec<_>>(),"repetitions":run.request.repetitions}))?.as_bytes()));
            sample.evidence["measurementPeriod"] = json!(format!(
                "{}:{}",
                sample.window_id,
                sample
                    .reset_at
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| format!("unknown-{}", row.get::<i64, _>(5)))
            ));
            sample.evidence["groupId"] = json!(row.get::<String, _>(3));
            sample.id = fixtures::hash(
                format!(
                    "{}:{}:{}:{}",
                    run.id,
                    row.get::<String, _>(3),
                    sample.window_id,
                    sample.account_scope
                )
                .as_bytes(),
            );
            self.store.save_usage(&sample).await?;
        }
        sqlx::query("UPDATE run_measurements SET finished=1 WHERE run_id=?")
            .bind(&run.id)
            .execute(&self.store.pool)
            .await?;
        Ok(())
    }
}

/// Used only when the app has registered its validated, isolated E2E mode.
#[derive(Default)]
pub struct FakeBackend {
    pub calls: std::sync::atomic::AtomicU64,
}
impl ExecutionBackend for FakeBackend {
    fn unsupported(&self, _: &Configuration, _: &BenchmarkDraft) -> Option<String> {
        None
    }
    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        _: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(async move {
            Ok(["fake-pass", "fake-fail"]
                .into_iter()
                .map(|id| InventoryModel {
                    configuration: Configuration {
                        id: id.into(),
                        provider_id: provider.into(),
                        account_id: account.map(str::to_owned),
                        model_id: id.into(),
                        effort: Some("default".into()),
                        fast_mode: None,
                        billing_mode: "simulated".into(),
                        execution_profile: "native_text".into(),
                        inventory_revision: Some("fake-v1".into()),
                    },
                    name: id.into(),
                    efforts: vec!["default".into()],
                    supports_fast_mode: false,
                    available: true,
                    reason: None,
                })
                .collect())
        })
    }
    fn execute<'a>(
        &'a self,
        store: &'a Store,
        mut a: Attempt,
        v: BenchmarkVersion,
        _: u32,
        mut cancel: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            a.phase = "running".into();
            a.host_run_id = Some(format!("fake-{}", a.id));
            a.observed = Some(a.configuration.clone());
            store.save_attempt(&a).await?;
            tokio::select! {_=tokio::time::sleep(Duration::from_millis(300))=>{},_=cancel.changed()=>{}}
            if *cancel.borrow() {
                a.outcome = Some("cancelled".into());
            } else {
                a.outcome = Some("completed".into());
                a.output = Some(if a.configuration.model_id == "fake-fail" {
                    v.manifest.evaluator.known_bad
                } else {
                    v.manifest.evaluator.known_good
                });
            }
            a.usage = TokenUsage {
                input: Some(10),
                output: Some(5),
                schema: "fake_nonoverlapping_v1".into(),
                ..Default::default()
            };
            a.duration_ms = Some(300);
            a.finished_at = Some(now());
            a.evidence_hash = Some(
                fixtures::seal(&store.root, &a, &json!({"provider":"isolated_e2e_fake"})).await?,
            );
            Ok(a)
        })
    }
    fn activity<'a>(&'a self, _: &'a Configuration) -> BoxFuture<'a, Result<AccountActivity>> {
        Box::pin(async move {
            Ok(AccountActivity {
                active_sessions: Vec::new(),
                generation: self.calls.load(std::sync::atomic::Ordering::SeqCst),
            })
        })
    }
}

pub fn seed_definitions() -> Vec<BenchmarkDraft> {
    super::seeds::definitions()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use tokio::sync::{Mutex, Notify};
    async fn setup() -> (tempfile::TempDir, Arc<BenchmarkService>, Arc<FakeBackend>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        let backend = Arc::new(FakeBackend::default());
        let service = Arc::new(BenchmarkService {
            store,
            backend: backend.clone(),
            wake: Notify::new(),
            active: Mutex::new(None),
            app: None,
        });
        (dir, service, backend)
    }
    async fn request(s: &BenchmarkService) -> RunRequest {
        let d = s
            .store
            .save_draft(None, None, seed_definitions().remove(0))
            .await
            .unwrap();
        let v = s.store.publish(&d.id, 1).await.unwrap();
        RunRequest {
            request_key: "test-key".into(),
            version_ids: vec![v.id],
            configurations: vec![Configuration {
                id: "fake-pass".into(),
                provider_id: "fake".into(),
                account_id: Some("isolated".into()),
                model_id: "fake-pass".into(),
                effort: None,
                fast_mode: None,
                billing_mode: "simulated".into(),
                execution_profile: "native_text".into(),
                inventory_revision: Some("fake-v1".into()),
            }],
            repetitions: 2,
            timeout_seconds: 10,
            max_executions: 2,
            preview: false,
        }
    }
    #[tokio::test]
    async fn durable_matrix_and_idempotent_start_do_not_duplicate() {
        let (_dir, s, backend) = setup().await;
        let req = request(&s).await;
        let run = s.start_run(req.clone()).await.unwrap();
        let again = s.start_run(req.clone()).await.unwrap();
        assert_eq!(run.id, again.id);
        assert_eq!(again.attempts.len(), 2);
        let mut changed = req;
        changed.repetitions = 1;
        assert_eq!(
            s.start_run(changed).await.unwrap_err().code,
            "revision_conflict"
        );
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let completed = s.store.run(&run.id).await.unwrap();
        assert_eq!(completed.state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        assert!(completed
            .attempts
            .iter()
            .all(|a| a.outcome.as_deref() == Some("pass")));
        assert!(completed.attempts.iter().all(|a| a.output.is_none()));
        assert!(s
            .store
            .attempt(&completed.attempts[0].id)
            .await
            .unwrap()
            .output
            .is_some());
    }
    #[tokio::test]
    async fn matrix_order_is_seeded_repeatable_and_frozen_before_dispatch() {
        let (_dir, service, backend) = setup().await;
        let mut req = request(&service).await;
        req.repetitions = 6;
        req.max_executions = 12;
        let mut second = req.configurations[0].clone();
        second.id = "second".into();
        req.configurations.push(second);
        let identities = |cells: Vec<(String, Configuration, u32)>| {
            cells
                .into_iter()
                .map(|(v, c, r)| (v, c.id, r))
                .collect::<Vec<_>>()
        };
        let first = identities(super::super::randomized_matrix(&req).unwrap());
        let mut permuted = req.clone();
        permuted.configurations.reverse();
        assert_eq!(
            first,
            identities(super::super::randomized_matrix(&permuted).unwrap())
        );
        let mut other_seed = req.clone();
        other_seed.request_key = "different-request-key".into();
        assert_ne!(
            first,
            identities(super::super::randomized_matrix(&other_seed).unwrap())
        );
        let run = service.start_run(req.clone()).await.unwrap();
        assert_eq!(
            first,
            run.attempts
                .iter()
                .map(|a| (
                    a.version_id.clone(),
                    a.configuration.id.clone(),
                    a.repetition
                ))
                .collect::<Vec<_>>()
        );
        let manifest: Value = serde_json::from_slice(
            &tokio::fs::read(
                service
                    .store
                    .root
                    .join("runs")
                    .join(&run.id)
                    .join("manifest.json"),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            manifest["executionOrder"]["algorithm"],
            "sha256-cell-order-v1"
        );
        assert_eq!(
            manifest["executionOrder"]["seed"],
            super::super::matrix_order_seed(&req.request_key)
        );
        assert_eq!(
            manifest["executionOrder"]["cells"]
                .as_array()
                .unwrap()
                .len(),
            12
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        assert_eq!(run.id, service.start_run(req).await.unwrap().id);
    }
    #[test]
    fn continuation_timeout_is_the_smallest_frozen_budget() {
        let mut draft = seed_definitions().remove(0);
        draft.limits.timeout_seconds = 120;
        assert_eq!(effective_timeout_seconds(90, &draft), 90);
        draft.entry_state = Some(EntryState {
            schema_version: 1,
            root_task_id: "task".into(),
            step_id: "continue".into(),
            parent_step_id: None,
            fixture_snapshot_hash: String::new(),
            conversation_prefix: String::new(),
            previous_reports: vec![],
            remaining_budget_seconds: 30,
            content_hash: String::new(),
        });
        assert_eq!(effective_timeout_seconds(90, &draft), 30);
        assert_eq!(effective_timeout_seconds(10, &draft), 10);
        draft.limits.timeout_seconds = 5;
        assert_eq!(effective_timeout_seconds(90, &draft), 5);
    }
    #[tokio::test]
    async fn workflow_tick_dispatches_children_once_and_evaluates_only_root() {
        let (_dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        let mut draft = seed_definitions().remove(0);
        draft.workflow = Some(WorkflowSpec {
            schema_version: 1,
            driver_revision: "runner-workflow-test-v1".into(),
            steps: vec![
                WorkflowStep {
                    id: "plan".into(),
                    prompt: "Prepare the public plan.".into(),
                    include_previous_output: false,
                },
                WorkflowStep {
                    id: "answer".into(),
                    prompt: "Produce the final structured answer.".into(),
                    include_previous_output: true,
                },
            ],
        });
        let definition = s.store.save_draft(None, None, draft).await.unwrap();
        let version = s.store.publish(&definition.id, 1).await.unwrap();
        req.version_ids = vec![version.id];
        req.repetitions = 1;
        let run = s.start_run(req).await.unwrap();
        s.tick().await.unwrap();
        s.tick().await.unwrap();
        s.tick().await.unwrap();
        let completed = s.store.run(&run.id).await.unwrap();
        assert_eq!(completed.state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        assert_eq!(completed.attempts.len(), 1);
        let root = &completed.attempts[0];
        assert_eq!(root.outcome.as_deref(), Some("pass"));
        assert_eq!(root.evaluations.len(), 1);
        assert_eq!(root.workflow_steps.len(), 2);
        assert_eq!(root.usage.input, Some(20));
        for child in &root.workflow_steps {
            let attempt = s.store.attempt(&child.attempt_id).await.unwrap();
            assert_eq!(attempt.phase, "terminal");
            assert_eq!(attempt.outcome.as_deref(), Some("completed"));
            assert!(attempt.evaluations.is_empty());
        }
    }

    #[tokio::test]
    async fn interrupted_dispatch_is_never_requeued() {
        let (_dir, s, backend) = setup().await;
        let req = request(&s).await;
        let run = s.start_run(req).await.unwrap();
        let mut a = run.attempts[0].clone();
        a.phase = "dispatching".into();
        s.store.save_attempt(&a).await.unwrap();
        s.store.recover().await.unwrap();
        s.tick().await.unwrap();
        let recovered = s.store.run(&run.id).await.unwrap();
        assert_eq!(recovered.state, "needs_attention");
        assert_eq!(
            recovered.attempts[0].outcome.as_deref(),
            Some("dispatch_uncertain")
        );
        assert_eq!(recovered.attempts[1].phase, "pending");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn pause_and_cancel_never_send_queued_work() {
        let (_dir, s, backend) = setup().await;
        let req = request(&s).await;
        let run = s.start_run(req).await.unwrap();
        s.control(&run.id, "pause").await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "paused");
        s.control(&run.id, "cancel").await.unwrap();
        s.tick().await.unwrap();
        let run = s.store.run(&run.id).await.unwrap();
        assert_eq!(run.state, "cancelled");
        assert!(run
            .attempts
            .iter()
            .all(|a| a.outcome.as_deref() == Some("cancelled")));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn active_cancel_retains_sealed_evidence() {
        let (_dir, s, backend) = setup().await;
        let req = request(&s).await;
        let run = s.start_run(req).await.unwrap();
        let background = s.clone();
        let tick = tokio::spawn(async move { background.tick().await });
        for _ in 0..100 {
            if s.active.lock().await.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        s.control(&run.id, "cancel").await.unwrap();
        tick.await.unwrap().unwrap();
        s.tick().await.unwrap();
        let run = s.store.run(&run.id).await.unwrap();
        assert_eq!(run.state, "cancelled");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert!(run.attempts[0].evidence_hash.is_some());
    }
    #[tokio::test]
    async fn baseline_is_a_frozen_copy() {
        let (_dir, s, _) = setup().await;
        let req = request(&s).await;
        let run = s.start_run(req).await.unwrap();
        assert!(s
            .create_baseline("Early".into(), vec![run.id.clone()], 0.1)
            .await
            .is_err());
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let b = s
            .create_baseline("Reference".into(), vec![run.id.clone()], 0.1)
            .await
            .unwrap();
        let id = b.snapshots[0].id.clone();
        s.rescore(&id).await.unwrap();
        assert_eq!(
            s.store.baselines().await.unwrap()[0].snapshots[0]
                .evaluations
                .len(),
            1
        );
        assert_eq!(s.store.attempt(&id).await.unwrap().evaluations.len(), 2);
    }
    #[test]
    fn usage_presence_and_context_occupancy_stay_distinct() {
        let mut usage = TokenUsage::default();
        let mut output = String::new();
        consume_event(
            &json!({"update":{"sessionUpdate":"usage_update","used":100,"size":200,"cost":{"amount":0.01,"currency":"USD"}}}),
            &mut output,
            &mut usage,
        );
        assert!(usage.input.is_none());
        assert_eq!(usage.cost, Some(0.01));
        consume_usage(
            &json!({"inputTokens":20,"outputTokens":5,"cachedWriteTokens":2}),
            &mut usage,
        );
        consume_usage(&json!({"inputTokens":30}), &mut usage);
        assert_eq!(usage.input, Some(30));
        assert_eq!(usage.output, Some(5));
        assert_eq!(usage.cache_write, Some(2));
        assert_eq!(usage.reasoning, None);
    }
    #[tokio::test]
    async fn native_auxiliary_usage_is_inclusive_and_kept_out_of_pure_profile() {
        let (_dir, service, _) = setup().await;
        let req = request(&service).await;
        let run = service.start_run(req).await.unwrap();
        let mut attempt = run.attempts[0].clone();
        attempt.observed = Some(attempt.configuration.clone());
        let result = json!({"usage":{"inputTokens":603,"outputTokens":5},"_meta":{"quota":{"model_usage":[
            {"model":"haiku","token_count":{"inputTokens":902,"outputTokens":11,"cachedInputTokens":0,"cachedWriteTokens":0,"totalTokens":913}},
            {"model":"sonnet","token_count":{"inputTokens":603,"outputTokens":5,"cachedInputTokens":0,"cachedWriteTokens":0,"totalTokens":608}}
        ]}}});
        let mut output = String::new();
        consume_event(
            &json!({"update":{"sessionUpdate":"benchmark_turn_result","_meta":{"benchmarkRawResult":{"usage":result["usage"],"quota":result["_meta"]["quota"]}}}}),
            &mut output,
            &mut attempt.usage,
        );
        mark_auxiliary_profile(&mut attempt);
        assert_eq!(attempt.usage.input, Some(1505));
        consume_terminal_result(&result, &mut attempt);
        consume_terminal_result(&result, &mut attempt);
        assert_eq!(attempt.usage.input, Some(1505));
        assert_eq!(attempt.usage.output, Some(16));
        assert_eq!(attempt.usage.schema, "provider_turn_with_auxiliary_v2");
        assert_eq!(
            attempt.observed.as_ref().unwrap().execution_profile,
            "native_text_auxiliary"
        );
        let mut output = String::new();
        for (amount, currency) in [
            (0.002213, "USD"),
            (0.001, "USD"),
            (900.0, "EUR"),
            (-1.0, "USD"),
        ] {
            consume_event(
                &json!({"update":{"sessionUpdate":"usage_update","used":9000,"cost":{"amount":amount,"currency":currency}}}),
                &mut output,
                &mut attempt.usage,
            );
        }
        assert_eq!(attempt.usage.cost, Some(0.002213));
        assert_eq!(attempt.usage.input, Some(1505));
    }
    #[tokio::test]
    async fn a_paid_auxiliary_only_failure_is_not_a_zero_cost_pure_turn() {
        let (_dir, service, _) = setup().await;
        let req = request(&service).await;
        let run = service.start_run(req).await.unwrap();
        for primary in [json!({"inputTokens":0,"outputTokens":0}), Value::Null] {
            let mut attempt = run.attempts[0].clone();
            attempt.observed = Some(attempt.configuration.clone());
            attempt.outcome = Some("budget_timeout".into());
            attempt.usage.cost = Some(0.001);
            let event = json!({"update":{"sessionUpdate":"benchmark_turn_result","_meta":{"benchmarkRawResult":{"usage":primary,"quota":{"model_usage":[{"model":"unmapped-provider-native-id","token_count":{"inputTokens":902,"outputTokens":11,"cachedInputTokens":0,"totalTokens":913}}]}}}}});
            let mut output = String::new();
            consume_event(&event, &mut output, &mut attempt.usage);
            consume_event(&event, &mut output, &mut attempt.usage);
            consume_usage(
                &json!({"inputTokens":0,"outputTokens":0}),
                &mut attempt.usage,
            );
            mark_auxiliary_profile(&mut attempt);
            assert_eq!(attempt.usage.input, Some(902));
            assert_eq!(attempt.usage.output, Some(11));
            assert_eq!(attempt.usage.cache_write, None);
            assert_eq!(attempt.usage.reasoning, None);
            assert_eq!(attempt.usage.cost, Some(0.001));
            assert_eq!(
                attempt.observed.unwrap().execution_profile,
                "native_text_auxiliary"
            );
        }
        let mut pure = TokenUsage {
            input: Some(603),
            output: Some(5),
            cache_read: Some(0),
            cache_write: Some(0),
            schema: "provider_turn_usage_v1".into(),
            ..Default::default()
        };
        consume_model_usage(
            &[
                json!({"model":"native-id-differs-from-config-alias","token_count":{"inputTokens":603,"outputTokens":5,"cachedInputTokens":0,"cachedWriteTokens":0,"totalTokens":608}}),
            ],
            &mut pure,
        );
        assert_eq!(pure.schema, "provider_turn_usage_v1");
        assert_eq!(pure.input, Some(603));
    }

    #[tokio::test]
    async fn sealed_recovery_evaluates_without_new_dispatch() {
        let (_dir, s, backend) = setup().await;
        let req = request(&s).await;
        let run = s.start_run(req).await.unwrap();
        let mut a = run.attempts[0].clone();
        let v = s.store.version(&a.version_id).await.unwrap();
        a.phase = "collecting".into();
        a.outcome = Some("completed".into());
        a.output = Some(v.manifest.evaluator.known_good);
        a.evidence_hash = Some(fixtures::seal(&s.store.root, &a, &json!({})).await.unwrap());
        s.store.save_attempt(&a).await.unwrap();
        s.store.recover().await.unwrap();
        s.tick().await.unwrap();
        let a = s.store.attempt(&a.id).await.unwrap();
        assert_eq!(a.outcome.as_deref(), Some("pass"));
        assert_eq!(a.evaluations.len(), 1);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn rubric_review_settles_quality() {
        let (_dir, s, _) = setup().await;
        let mut draft = seed_definitions().remove(0);
        draft.evaluator.kind = "rubric".into();
        draft.evaluator.rubric = "The response must correctly identify Mira and total five.".into();
        let d = s.store.save_draft(None, None, draft).await.unwrap();
        let v = s.store.publish(&d.id, 1).await.unwrap();
        let mut req = request(&s).await;
        req.version_ids = vec![v.id];
        req.repetitions = 1;
        let run = s.start_run(req).await.unwrap();
        s.tick().await.unwrap();
        let a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        assert_eq!(a.outcome.as_deref(), Some("pending_review"));
        let a = s
            .review(&a.id, 1.0, "Meets the declared rubric".into())
            .await
            .unwrap();
        assert_eq!(a.outcome.as_deref(), Some("pass"));
        assert_eq!(a.evaluations[1].provenance, "human");
    }
    #[tokio::test]
    async fn manifest_failure_never_admits_work() {
        let (dir, s, backend) = setup().await;
        let req = request(&s).await;
        tokio::fs::write(dir.path().join("runs"), "blocked directory")
            .await
            .unwrap();
        assert!(s.start_run(req).await.is_err());
        assert!(s.store.all_runs().await.unwrap().is_empty());
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn old_active_runs_and_export_history_are_not_limited_to_recent_page() {
        let (_dir, s, backend) = setup().await;
        let req = request(&s).await;
        let old = s.start_run(req.clone()).await.unwrap();
        for index in 0..101 {
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,?,?,?)").bind(format!("history-{index}")).bind(format!("history-{index}")).bind(now()+index).bind(now()+index).bind(serde_json::to_string(&req).unwrap()).execute(&s.store.pool).await.unwrap();
        }
        assert_eq!(s.store.runs().await.unwrap().len(), 100);
        assert_eq!(s.query_data().await.unwrap().runs.len(), 102);
        s.tick().await.unwrap();
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            s.store.run(&old.id).await.unwrap().attempts[0]
                .outcome
                .as_deref(),
            Some("pass")
        );
    }
    #[tokio::test]
    async fn capacity_without_exhaustion_is_only_a_lower_bound() {
        let (_dir, s, _) = setup().await;
        let mut draft = seed_definitions().remove(0);
        draft.measurement_profile = "capacity".into();
        let d = s.store.save_draft(None, None, draft).await.unwrap();
        let v = s.store.publish(&d.id, 1).await.unwrap();
        let mut req = request(&s).await;
        req.version_ids = vec![v.id];
        req.repetitions = 1;
        let run = s.start_run(req).await.unwrap();
        s.tick().await.unwrap();
        s.tick().await.unwrap();
        let samples = s.store.usage_samples().await.unwrap();
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].status, "lower_bound");
        assert_eq!(samples[0].attempt_ids, vec![run.attempts[0].id.clone()]);
        assert!(samples[0].used_percentage_points.is_none());
    }
    #[test]
    fn typed_terminal_outcomes_and_public_fixtures_are_preserved() {
        for (kind, wanted) in [
            ("budget_timeout", "budget_timeout"),
            ("cancelled", "cancelled"),
            ("selection_changed", "selection_changed"),
            ("quota_blocked", "quota_blocked"),
        ] {
            assert_eq!(terminal_error_outcome(&json!({"kind":kind})), wanted);
        }
        let mut draft = seed_definitions().remove(0);
        draft.fixtures.push(Fixture {
            path: "input.txt".into(),
            content: "visible fixture".into(),
        });
        let prompt = prompt_with_fixtures(&draft).unwrap();
        assert!(prompt.contains("visible fixture"));
        assert!(!prompt.contains(&draft.evaluator.known_good));
    }
    #[test]
    fn exact_selection_accepts_only_unspecified_native_defaults() {
        let c = Configuration {
            id: "a".into(),
            provider_id: "fake".into(),
            account_id: None,
            model_id: "m".into(),
            effort: None,
            fast_mode: None,
            billing_mode: "simulated".into(),
            execution_profile: "native_text".into(),
            inventory_revision: None,
        };
        let mut observed = c.clone();
        observed.effort = Some("high".into());
        assert!(matches_selection(&c, &observed));
        let mut requested = c;
        requested.effort = Some("low".into());
        assert!(!matches_selection(&requested, &observed));
    }
}
