//! What a turn captured: events, usage, the resolved model, violations.
use super::*;

pub(in super::super) struct TurnCapture {
    pub(in super::super) cap: usize,
    pub(in super::super) output: String,
    pub(in super::super) violation: Option<String>,
    /// Whether the provider's runtime said the model declined the request
    /// before anything else answered it (see [`declined_notice`]).
    pub(in super::super) declined: bool,
    /// Whether the runtime changed the selection while the turn ran: what
    /// streams after that is not the selected configuration's answer.
    pub(in super::super) swapped: bool,
    /// What a connection the provider's runtime lost mid-answer leaves of
    /// the answer (see [`reconnect::Restarts`]).
    pub(in super::super) restarts: reconnect::Restarts,
    pub(in super::super) answer_capped: bool,
    pub(in super::super) evidence: crate::services::benchmarks::evidence::EvidenceLog,
}

impl TurnCapture {
    pub(in super::super) fn new(max_artifact_bytes: u64) -> Self {
        Self::with_evidence(
            max_artifact_bytes,
            crate::services::benchmarks::evidence::EvidenceLog::default(),
        )
    }

    pub(in super::super) fn with_evidence(
        max_artifact_bytes: u64,
        evidence: crate::services::benchmarks::evidence::EvidenceLog,
    ) -> Self {
        Self {
            cap: usize::try_from(max_artifact_bytes).unwrap_or(usize::MAX),
            output: String::new(),
            violation: None,
            declined: false,
            swapped: false,
            restarts: reconnect::Restarts::default(),
            answer_capped: false,
            evidence,
        }
    }

    pub(in super::super) fn read(&mut self, payload: Value, attempt: &mut Attempt) -> Result<()> {
        let answered = self.output.len();
        consume_event(&payload, &mut self.output, &mut attempt.usage);
        if self.swapped {
            self.output.truncate(answered);
        } else {
            self.restarts.turn_of(&attempt.configuration);
            self.restarts.settle(&payload, &mut self.output, answered);
        }
        if let Some(model) = resolved_model_of(&payload) {
            attempt.resolved_model = Some(model);
        }
        if self.violation.is_none() {
            self.declined |= declined_notice(&payload);
            self.violation = violation_of(&payload);
            self.swapped = self.violation.as_deref()
                == Some(crate::services::agent_host::execution::violation::SELECTION);
        }
        self.evidence.push(payload)
    }

    /// Cuts an answer that passed the cap back to it, on a character
    /// boundary, and says whether it ever passed it.
    pub(in super::super) fn cap_answer(&mut self) -> bool {
        if self.output.len() > self.cap {
            self.answer_capped = true;
            let mut end = self.cap;
            while !self.output.is_char_boundary(end) {
                end -= 1;
            }
            self.output.truncate(end);
        }
        self.answer_capped
    }
}

pub(in super::super) fn consume_event(event: &Value, output: &mut String, usage: &mut TokenUsage) {
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
            if let Some(raw) = update.pointer("/_meta/xaiTurnUsage") {
                consume_xai_turn_usage(raw, usage);
            }
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

/// The parts of Grok's raw turn usage the host's rewrite leaves out. Its cost
/// counts only when Grok reports it complete: session sign-ins often leave
/// calls unpriced, and an undercounted cost is worse than none (D1). More than
/// one model call in the turn is auxiliary work inside it.
pub(in super::super) fn consume_xai_turn_usage(raw: &Value, usage: &mut TokenUsage) {
    if let Some(v) = raw["reasoningTokens"].as_u64() {
        usage.reasoning = Some(v);
    }
    let missing_calls = match raw.get("costMissingCalls") {
        None | Some(Value::Null) => Some(0),
        Some(count) => count.as_u64(),
    };
    let complete = raw["costIsPartial"].as_bool() != Some(true) && missing_calls == Some(0);
    if let Some(ticks) = raw["costUsdTicks"].as_u64().filter(|_| complete) {
        // 1 USD = 1e10 ticks.
        let amount = ticks as f64 / 1e10;
        usage.cost = Some(usage.cost.map_or(amount, |previous| previous.max(amount)));
    }
    if raw["modelCalls"].as_u64().is_some_and(|calls| calls > 1) {
        usage.schema = "provider_turn_with_auxiliary_v2".into();
    }
}

/// What the host found broken in the no-tool policy, if this event shows it.
pub(in super::super) fn violation_of(event: &Value) -> Option<String> {
    let params = event.get("params").unwrap_or(event);
    let update = params.get("update").unwrap_or(params);
    update
        .pointer("/_meta/executionViolation")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Whether this event is the provider's runtime saying the model declined
/// the request: the notice the pinned Claude bridge sends when Claude Code
/// answers a refused turn with another model ("claude-sonnet-5-5 declined
/// this request (cyber); retried with claude-sonnet-5 ...").
pub(in super::super) fn declined_notice(event: &Value) -> bool {
    let params = event.get("params").unwrap_or(event);
    let update = params.get("update").unwrap_or(params);
    update["sessionUpdate"] == "notice"
        && ["title", "description"].iter().any(|field| {
            update[*field]
                .as_str()
                .is_some_and(|text| text.contains("declined this request"))
        })
}

/// Settles an attempt whose turn broke its test's policy, by whose doing
/// that was. The model's own work against the rules (a tool, a plan,
/// background work or another agent where the test allows none) is its
/// failure, scored 0. A change the provider's runtime made is no answer of
/// the model's and is not counted: a selection it changed is a changed
/// selection, a hook it ran or a mode it changed is an infrastructure
/// failure. Only a model swap after the model declined the request is the
/// model's: its refusal fails the test, and another model's answer never
/// counts for it. A violation this build does not know stays one.
pub(in super::super) fn settle_violation(attempt: &mut Attempt, violation: String, declined: bool) {
    use crate::services::agent_host::execution::violation as kind;
    let (outcome, reason) = match kind::origin(&violation) {
        Some(kind::Origin::Model) => {
            let broke = match violation.as_str() {
                kind::TOOL => "it used a tool in a test that allows none",
                kind::PLAN => "it kept a task plan in a test that allows only an answer",
                kind::BACKGROUND => "it started background work in a test that allows none",
                _ => "it handed the work to another agent, which the test does not allow",
            };
            (
                "fail",
                format!("The model broke the test's rules: {broke} ({violation})"),
            )
        }
        Some(kind::Origin::Runtime) if violation == kind::SELECTION && declined => (
            "fail",
            format!(
                "The model refused the task, and the provider's runtime switched to another \
                 model to answer it; that answer is not the selected model's ({violation})"
            ),
        ),
        Some(kind::Origin::Runtime) if violation == kind::SELECTION => (
            "selection_changed",
            format!(
                "The provider's runtime changed the model, effort or fast mode while the turn \
                 ran, so the answer is not counted ({violation})"
            ),
        ),
        Some(kind::Origin::Runtime) => (
            "infrastructure_failure",
            format!(
                "The provider's runtime ran a hook or changed its mode while the turn ran, \
                 which the test's policy turns off; the answer is not counted ({violation})"
            ),
        ),
        None => ("execution_violation", violation),
    };
    attempt.outcome = Some(outcome.into());
    attempt.reason = Some(reason);
}

pub(in super::super) fn mark_auxiliary_profile(attempt: &mut Attempt) {
    if attempt.configuration.execution_profile == "native_text"
        && attempt.usage.schema == "provider_turn_with_auxiliary_v2"
    {
        if let Some(observed) = attempt.observed.as_mut() {
            observed.execution_profile = "native_text_auxiliary".into();
        }
    }
}

pub(in super::super) fn consume_terminal_result(result: &Value, attempt: &mut Attempt) {
    if let Some(usage) = result.get("usage") {
        consume_usage(usage, &mut attempt.usage);
    }
    if let Some(models) = result
        .pointer("/_meta/quota/model_usage")
        .and_then(Value::as_array)
    {
        consume_model_usage(models, &mut attempt.usage);
    }
    if let Some(model) = resolved_model_of(result) {
        attempt.resolved_model = Some(model);
    }
    mark_auxiliary_profile(attempt);
}

/// The model a provider's usage names as the one that answered, if this
/// prompt response or event reports usage by model: Claude's, Codex's and
/// Kimi's `_meta.quota.model_usage[].model` (in a prompt response, or the
/// host's `benchmark_turn_result` copy of it), or the keys of `modelUsage` in
/// Grok's raw turn usage. Claude names what an alias such as `sonnet` ran
/// (`claude-sonnet-5`); Codex and Grok name the selected model; Kimi names
/// its own model alias, never the K2.x behind it. Where several models
/// worked, the one that wrote the most output answered.
pub(in super::super) fn resolved_model_of(value: &Value) -> Option<String> {
    let params = value.get("params").unwrap_or(value);
    let update = params.get("update").unwrap_or(params);
    let named: Vec<(&str, u64)> = if let Some(models) = value
        .pointer("/_meta/quota/model_usage")
        .or_else(|| update.pointer("/_meta/benchmarkRawResult/quota/model_usage"))
        .and_then(Value::as_array)
    {
        models
            .iter()
            .filter_map(|row| {
                let model = row["model"].as_str()?;
                Some((
                    model,
                    row["token_count"]["outputTokens"].as_u64().unwrap_or(0),
                ))
            })
            .collect()
    } else if let Some(models) = update
        .pointer("/_meta/xaiTurnUsage/modelUsage")
        .and_then(Value::as_object)
    {
        models
            .iter()
            .map(|(model, usage)| (model.as_str(), usage["outputTokens"].as_u64().unwrap_or(0)))
            .collect()
    } else {
        return None;
    };
    named
        .into_iter()
        .filter(|(model, _)| !model.is_empty())
        .max_by_key(|(_, output)| *output)
        .map(|(model, _)| model.to_owned())
}

pub(in super::super) fn consume_model_usage(models: &[Value], usage: &mut TokenUsage) {
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

pub(in super::super) fn consume_usage(data: &Value, usage: &mut TokenUsage) {
    if usage.schema == "provider_turn_with_auxiliary_v2" {
        return;
    }
    if let Some(v) = data["inputTokens"].as_u64() {
        usage.input = Some(v);
    }
    if let Some(v) = data["outputTokens"].as_u64() {
        usage.output = Some(v);
    }
    // Bridges spell the cache counters differently: ACP's `cachedReadTokens`,
    // the host's rewrite of Grok's turn usage `cacheReadTokens`.
    if let Some(v) = data["cachedReadTokens"]
        .as_u64()
        .or_else(|| data["cacheReadTokens"].as_u64())
    {
        usage.cache_read = Some(v);
    }
    if let Some(v) = data["cachedWriteTokens"]
        .as_u64()
        .or_else(|| data["cacheCreationTokens"].as_u64())
        .or_else(|| data["cacheWriteTokens"].as_u64())
    {
        usage.cache_write = Some(v);
    }
    // Reasoning is informational and never added to output. Claude and Codex
    // count it inside output; Claude reports none separately, and its
    // synthetic zero in quota metadata is not a measurement.
    if let Some(v) = data["thoughtTokens"]
        .as_u64()
        .or_else(|| data["reasoningTokens"].as_u64())
    {
        usage.reasoning = Some(v);
    }
    usage.schema = "provider_turn_usage_v1".into();
}
