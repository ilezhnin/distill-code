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

    fn with_evidence(
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
fn consume_xai_turn_usage(raw: &Value, usage: &mut TokenUsage) {
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
fn declined_notice(event: &Value) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::runner::tests::*;
    use crate::services::benchmarks::runner::*;

    /// Run 607f8612: a Grok answer of 3,844 bytes and its reasoning came in
    /// some 1,450 chunks that, with their telemetry, passed the 1 MiB cap;
    /// the old runner cancelled the turn and settled a budget failure. The
    /// cap is the answer's: the turn runs on and its record is kept whole.
    #[test]
    fn the_artifact_cap_counts_the_answer_not_the_events() {
        let mut capture = TurnCapture::new(1024 * 1024);
        let mut attempt = blank_attempt();
        let mut events_bytes = 0;
        let mut answer = String::new();
        for n in 0..1_500 {
            let (kind, text) = if n % 10 == 0 {
                ("agent_thought_chunk", " thinking")
            } else {
                ("agent_message_chunk", "<b>")
            };
            if kind == "agent_message_chunk" {
                answer.push_str(text);
            }
            let event = telemetry_chunk(kind, text, n);
            events_bytes += serde_json::to_vec(&event).unwrap().len();
            capture.read(event, &mut attempt).unwrap();
        }
        assert!(events_bytes > 1024 * 1024, "{events_bytes}");
        assert!(!capture.cap_answer());
        assert_eq!(capture.output, answer);
        assert!(capture.violation.is_none());
        let record = capture.evidence.close(json!({"terminalDispatch": {}}));
        let events = record.as_array().unwrap();
        // Adjacent chunks are compacted without losing their text or the
        // distinction between the answer and reasoning.
        let recorded_answer: String = events
            .iter()
            .filter(|event| event["update"]["sessionUpdate"] == "agent_message_chunk")
            .filter_map(|event| event["update"]["content"]["text"].as_str())
            .collect();
        assert_eq!(recorded_answer, answer);
        let thoughts: String = events
            .iter()
            .filter(|event| event["update"]["sessionUpdate"] == "agent_thought_chunk")
            .filter_map(|event| event["update"]["content"]["text"].as_str())
            .collect();
        assert_eq!(thoughts, " thinking".repeat(150));
        assert_eq!(events.last().unwrap(), &json!({"terminalDispatch": {}}));
        assert!(events.iter().all(|e| e.get("evidenceTruncated").is_none()));
        assert!(events[1].get("_meta").is_none() && events[1]["update"].get("_meta").is_none());
    }

    #[test]
    fn an_answer_past_the_cap_is_cut_back_to_it_and_ends_the_turn() {
        let mut capture = TurnCapture::new(4);
        let mut attempt = blank_attempt();
        capture
            .read(
                telemetry_chunk("agent_message_chunk", "ab€€", 0),
                &mut attempt,
            )
            .unwrap();
        assert!(capture.cap_answer());
        // Cut on a character boundary, never inside "€".
        assert_eq!(capture.output, "ab");
        // Once past it, the answer stays capped.
        capture
            .read(telemetry_chunk("agent_message_chunk", "c", 1), &mut attempt)
            .unwrap();
        assert!(capture.cap_answer());
        assert_eq!(capture.output, "abc");
    }

    /// The record's ceiling stops the record, not the turn: the answer, the
    /// usage and a violation tag after it are still read.
    #[test]
    fn a_record_past_its_ceiling_still_reads_the_turn() {
        let mut capture = TurnCapture::with_evidence(
            1024,
            crate::services::benchmarks::evidence::EvidenceLog::with_ceiling(2_000),
        );
        let mut attempt = blank_attempt();
        for n in 0..50 {
            capture
                .read(telemetry_chunk("agent_message_chunk", "x", n), &mut attempt)
                .unwrap();
        }
        capture
            .read(
                json!({"update": {"sessionUpdate": "tool_call",
                    "_meta": {"executionViolation": "native tool activity in no-tool profile"}}}),
                &mut attempt,
            )
            .unwrap();
        capture
            .read(
                json!({"update": {"sessionUpdate": "usage_update",
                    "cost": {"amount": 0.25, "currency": "USD"}}}),
                &mut attempt,
            )
            .unwrap();
        assert!(!capture.cap_answer());
        assert_eq!(capture.output, "x".repeat(50));
        assert_eq!(
            capture.violation.as_deref(),
            Some("native tool activity in no-tool profile")
        );
        assert_eq!(attempt.usage.cost, Some(0.25));
        let record = capture.evidence.close(json!({"terminalDispatch": {}}));
        let events = record.as_array().unwrap();
        let marker = events
            .iter()
            .find_map(|e| e.get("evidenceTruncated"))
            .expect("truncation marker");
        assert!(marker["droppedEvents"].as_u64().unwrap() >= 2);
        assert!(events.last().unwrap().get("terminalDispatch").is_some());
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

    #[test]
    fn consume_usage_reads_both_cache_spellings_and_reasoning() {
        // The host's rewrite of a Grok turn.
        let mut grok = TokenUsage::default();
        let mut output = String::new();
        consume_event(
            &json!({"update":{"sessionUpdate":"message_usage","usage":{"inputTokens":40,"outputTokens":9,"cacheReadTokens":300,"cacheWriteTokens":7,"elapsedMs":12}}}),
            &mut output,
            &mut grok,
        );
        assert_eq!(
            (grok.input, grok.output, grok.cache_read, grok.cache_write),
            (Some(40), Some(9), Some(300), Some(7))
        );
        assert_eq!(grok.reasoning, None);
        // ACP's own spelling wins where a bridge sends both.
        let mut both = TokenUsage::default();
        consume_usage(
            &json!({"cachedReadTokens":5,"cacheReadTokens":6,"cacheCreationTokens":1,"cacheWriteTokens":2}),
            &mut both,
        );
        assert_eq!((both.cache_read, both.cache_write), (Some(5), Some(1)));
        // Reasoning is kept apart and never added to output.
        let mut codex = TokenUsage::default();
        consume_usage(
            &json!({"inputTokens":100,"outputTokens":50,"thoughtTokens":30}),
            &mut codex,
        );
        assert_eq!((codex.output, codex.reasoning), (Some(50), Some(30)));
        let mut reported = TokenUsage::default();
        consume_usage(&json!({"reasoningTokens":4}), &mut reported);
        assert_eq!(reported.reasoning, Some(4));
    }

    /// The model's own breach of a test's rules is its failure; a change the
    /// provider's runtime made is not counted, unless it answered a refusal
    /// with another model (10-31: Sonnet 5.5 declined a cyber-flagged task
    /// and Claude Code went on with claude-sonnet-5, which Flock stopped).
    #[test]
    fn a_violation_settles_by_whose_doing_it_was() {
        use crate::services::agent_host::execution::violation as kind;
        let settled = |violation: &str, declined: bool| {
            let mut attempt = blank_attempt();
            settle_violation(&mut attempt, violation.into(), declined);
            (attempt.outcome.unwrap(), attempt.reason.unwrap())
        };
        for violation in [kind::TOOL, kind::PLAN, kind::BACKGROUND, kind::SUBAGENT] {
            let (outcome, reason) = settled(violation, false);
            assert_eq!(outcome, "fail", "{violation}");
            assert!(reason.starts_with("The model broke the test's rules: "));
            assert!(reason.ends_with(&format!("({violation})")));
        }
        let (outcome, reason) = settled(kind::SELECTION, false);
        assert_eq!(outcome, "selection_changed");
        assert!(reason.starts_with("The provider's runtime changed the model"));
        let (outcome, reason) = settled(kind::SELECTION, true);
        assert_eq!(outcome, "fail");
        assert!(reason.starts_with("The model refused the task"));
        for violation in [kind::HOOK, kind::MODE] {
            assert_eq!(settled(violation, true).0, "infrastructure_failure");
        }
        assert_eq!(
            settled("invented violation", false),
            ("execution_violation".into(), "invented violation".into())
        );
        // A breach the model made is a measured 0; the runtime's are not.
        let mut broke = blank_attempt();
        broke.evaluations.clear();
        settle_violation(&mut broke, kind::TOOL.into(), false);
        broke.phase = "terminal".into();
        broke.finished_at = Some(1);
        assert_eq!(
            crate::services::benchmarks::analysis::score(&broke),
            Some(0.0)
        );
        assert!(crate::services::benchmarks::analysis::is_measured(&broke));

        // The bridge's refusal notice, and nothing else, marks a decline;
        // only the first violation's lead-up counts.
        let notice = |title: &str| {
            json!({"params": {"sessionId": "s", "update": {"sessionUpdate": "notice",
                "severity": "warning", "title": title}}})
        };
        assert!(declined_notice(&notice(
            "claude-sonnet-5-5 declined this request (cyber); retried with claude-sonnet-5. \
             The session will continue on claude-sonnet-5."
        )));
        assert!(declined_notice(
            &json!({"update": {"sessionUpdate": "notice",
            "title": "Model fallback",
            "description": "claude-sonnet-5-5 declined this request; retried with claude-sonnet-5."}})
        ));
        assert!(!declined_notice(&notice(
            "Sonnet 5.5's safeguards stopped the response above · continuing once with that noted"
        )));
        assert!(!declined_notice(
            &json!({"update": {"sessionUpdate": "agent_message_chunk",
            "content": {"text": "I declined this request"}}})
        ));
        let mut capture = TurnCapture::new(1024);
        let mut attempt = blank_attempt();
        for event in [
            json!({"update": {"sessionUpdate": "agent_message_chunk",
                "content": {"text": "partial "}}}),
            notice(
                "claude-sonnet-5-5 declined this request (cyber); retried with claude-sonnet-5.",
            ),
            json!({"update": {"sessionUpdate": "config_option_update",
                "_meta": {"executionViolation": kind::SELECTION}}}),
            // The other model's answer streams before the cancel lands.
            json!({"update": {"sessionUpdate": "agent_message_chunk",
                "content": {"text": "ANSWER_FROM_claude-sonnet-5"}}}),
        ] {
            capture.read(event, &mut attempt).unwrap();
        }
        assert!(capture.declined);
        assert_eq!(capture.violation.as_deref(), Some(kind::SELECTION));
        assert_eq!(capture.output, "partial ");
        let mut late = TurnCapture::new(1024);
        for event in [
            json!({"update": {"sessionUpdate": "config_option_update",
                "_meta": {"executionViolation": kind::SELECTION}}}),
            notice(
                "claude-sonnet-5-5 declined this request (cyber); retried with claude-sonnet-5.",
            ),
        ] {
            late.read(event, &mut attempt).unwrap();
        }
        assert!(!late.declined);
    }

    #[test]
    fn kimi_prompt_usage_and_model_usage_are_read() {
        // A Kimi prompt response under the adapter: the engine's turn usage
        // with uncached input apart from the cache, and the same per model.
        let result = json!({"stopReason":"end_turn",
            "usage":{"inputTokens":812,"outputTokens":95,"cachedReadTokens":3072,"cachedWriteTokens":0,"totalTokens":3979},
            "_meta":{"quota":{"model_usage":[{"model":"kimi-code/k3","token_count":{"inputTokens":812,"outputTokens":95,"cachedWriteTokens":0,"totalTokens":3979,"cachedInputTokens":3072}}]}}});
        let mut attempt: Attempt = serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v",
            "configuration":{"id":"c","providerId":"kimi-acp","accountId":"cli-login-kimi-acp","modelId":"kimi-code/k3","billingMode":"subscription","executionProfile":"native_text"},
            "repetition":0,"phase":"dispatching","usage":{"schema":"native"},"eventCursor":0,"workflowSteps":[],"evaluations":[]}))
        .unwrap();
        consume_terminal_result(&result, &mut attempt);
        let usage = &attempt.usage;
        assert_eq!(
            (
                usage.input,
                usage.output,
                usage.cache_read,
                usage.cache_write
            ),
            (Some(812), Some(95), Some(3072), Some(0))
        );
        // Kimi reports no reasoning apart and no cost.
        assert_eq!((usage.reasoning, usage.cost), (None, None));
        assert_eq!(usage.schema, "provider_turn_usage_v1");
        // The same response as the host's turn result event.
        let mut evented = TokenUsage::default();
        let mut output = String::new();
        consume_event(
            &json!({"update":{"sessionUpdate":"benchmark_turn_result","_meta":{"benchmarkRawResult":{"usage":result["usage"],"quota":result["_meta"]["quota"]}}}}),
            &mut output,
            &mut evented,
        );
        assert_eq!(
            (evented.input, evented.output, evented.cache_read),
            (Some(812), Some(95), Some(3072))
        );
        // A second model in the session is auxiliary work, and its tokens
        // count.
        let mut auxiliary = attempt.clone();
        auxiliary.usage = TokenUsage::default();
        let mut two = result.clone();
        two["_meta"]["quota"]["model_usage"]
            .as_array_mut()
            .unwrap()
            .push(json!({"model":"kimi-code/kimi-for-coding","token_count":{"inputTokens":100,"outputTokens":10,"cachedInputTokens":0,"cachedWriteTokens":0,"totalTokens":110}}));
        consume_terminal_result(&two, &mut auxiliary);
        assert_eq!(auxiliary.usage.schema, "provider_turn_with_auxiliary_v2");
        assert_eq!(auxiliary.usage.input, Some(912));
    }

    #[test]
    fn grok_ticks_become_cost_only_when_complete() {
        let turn = |meta: Value| {
            let mut usage = TokenUsage::default();
            let mut output = String::new();
            consume_event(
                &json!({"update":{"sessionUpdate":"message_usage",
                    "usage":{"inputTokens":14098,"outputTokens":168,"cacheReadTokens":2944,"cacheWriteTokens":0,"elapsedMs":3899},
                    "_meta":{"xaiTurnUsage":meta}}}),
                &mut output,
                &mut usage,
            );
            usage
        };
        let raw = json!({"inputTokens":17042,"outputTokens":168,"cachedReadTokens":2944,
            "reasoningTokens":159,"modelCalls":1,"costUsdTicks":104_298_400u64});
        let usage = turn(raw.clone());
        assert_eq!(
            (usage.input, usage.output, usage.cache_read, usage.reasoning),
            (Some(14098), Some(168), Some(2944), Some(159))
        );
        // 1 USD = 1e10 ticks.
        assert_eq!(usage.cost, Some(0.01042984));
        assert_eq!(usage.schema, "provider_turn_usage_v1");
        for incomplete in [
            json!({"costIsPartial": true}),
            json!({"costMissingCalls": 1}),
            json!({"costMissingCalls": "unknown"}),
        ] {
            let mut partial = raw.clone();
            partial
                .as_object_mut()
                .unwrap()
                .extend(incomplete.as_object().unwrap().clone());
            assert_eq!(turn(partial).cost, None, "{incomplete}");
        }
        let mut complete = raw.clone();
        complete["costIsPartial"] = json!(false);
        complete["costMissingCalls"] = json!(0);
        assert_eq!(turn(complete).cost, Some(0.01042984));
        // A session sign-in that stamps no cost leaves it unknown, never zero.
        let mut unpriced = raw;
        unpriced.as_object_mut().unwrap().remove("costUsdTicks");
        assert_eq!(turn(unpriced).cost, None);
    }

    #[test]
    fn grok_multiple_model_calls_mark_auxiliary() {
        let mut attempt: Attempt = serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v",
            "configuration":{"id":"c","providerId":"grok-acp","accountId":"cli-login-grok-acp","modelId":"grok-4.7","billingMode":"subscription","executionProfile":"native_text"},
            "observed":{"id":"c","providerId":"grok-acp","accountId":"cli-login-grok-acp","modelId":"grok-4.7","billingMode":"subscription","executionProfile":"native_text"},
            "repetition":0,"phase":"dispatching","usage":{"schema":"native"},"eventCursor":0,"workflowSteps":[],"evaluations":[]}))
        .unwrap();
        let mut output = String::new();
        consume_event(
            &json!({"update":{"sessionUpdate":"message_usage",
                "usage":{"inputTokens":900,"outputTokens":40,"cacheReadTokens":0,"cacheWriteTokens":0,"elapsedMs":10},
                "_meta":{"xaiTurnUsage":{"inputTokens":900,"outputTokens":40,"modelCalls":2}}}}),
            &mut output,
            &mut attempt.usage,
        );
        assert_eq!(attempt.usage.schema, "provider_turn_with_auxiliary_v2");
        assert_eq!(
            (attempt.usage.input, attempt.usage.output),
            (Some(900), Some(40))
        );
        mark_auxiliary_profile(&mut attempt);
        assert_eq!(
            attempt.observed.as_ref().unwrap().execution_profile,
            "native_text_auxiliary"
        );
        // Tool turns normally need several calls; they retain the repository
        // profile and all inclusive usage instead of becoming text rows.
        attempt.configuration.execution_profile = "protected_repository".into();
        attempt.observed.as_mut().unwrap().execution_profile = "protected_repository".into();
        mark_auxiliary_profile(&mut attempt);
        assert_eq!(
            attempt.observed.unwrap().execution_profile,
            "protected_repository"
        );
    }

    /// Each provider's usage names the model that answered, which for an
    /// alias is its target; a retry starts without it.
    #[test]
    fn the_resolved_model_comes_from_each_providers_usage() {
        let mut attempt: Attempt = serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v",
            "configuration":{"id":"c","providerId":"claude-acp","accountId":"x","modelId":"sonnet","billingMode":"subscription","executionProfile":"native_text"},
            "repetition":0,"phase":"dispatching","usage":{"schema":"native"},"eventCursor":0,"workflowSteps":[],"evaluations":[]}))
        .unwrap();
        // Claude's prompt response: the `sonnet` alias ran Sonnet 5, beside
        // a smaller auxiliary call.
        let claude = json!({"stopReason":"end_turn","usage":{"inputTokens":40,"outputTokens":30},
            "_meta":{"quota":{"model_usage":[
                {"model":"claude-haiku-4-5-20251001","token_count":{"inputTokens":5,"outputTokens":2}},
                {"model":"claude-sonnet-5","token_count":{"inputTokens":35,"outputTokens":28}}]}}});
        consume_terminal_result(&claude, &mut attempt);
        assert_eq!(attempt.resolved_model.as_deref(), Some("claude-sonnet-5"));
        // The host's copy of a prompt response among the events (Codex).
        let codex = json!({"update":{"sessionUpdate":"benchmark_turn_result","_meta":{"benchmarkRawResult":{
            "usage":{"inputTokens":80,"outputTokens":60},
            "quota":{"model_usage":[{"model":"gpt-6-sol","token_count":{"inputTokens":80,"outputTokens":60}}]}}}}});
        assert_eq!(resolved_model_of(&codex).as_deref(), Some("gpt-6-sol"));
        // Grok's raw turn usage, keyed by model.
        let grok = json!({"params":{"update":{"sessionUpdate":"message_usage","usage":{"inputTokens":8,"outputTokens":5},
            "_meta":{"xaiTurnUsage":{"inputTokens":10,"outputTokens":5,"modelCalls":1,
                "modelUsage":{"grok-4.7":{"inputTokens":10,"outputTokens":5,"modelCalls":1}}}}}}});
        assert_eq!(resolved_model_of(&grok).as_deref(), Some("grok-4.7"));
        // Kimi names its own model alias.
        let kimi = json!({"stopReason":"end_turn","_meta":{"quota":{"model_usage":[
            {"model":"kimi-code/kimi-for-coding","token_count":{"inputTokens":8,"outputTokens":5}}]}}});
        assert_eq!(
            resolved_model_of(&kimi).as_deref(),
            Some("kimi-code/kimi-for-coding")
        );
        // Usage without models, or no usage, names nothing and keeps what an
        // earlier report named.
        for silent in [
            json!({"stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":1}}),
            json!({"stopReason":"end_turn","_meta":{"quota":{"model_usage":[]}}}),
            json!({"update":{"sessionUpdate":"message_usage","usage":{"inputTokens":1},"_meta":{"xaiTurnUsage":{"inputTokens":1}}}}),
            json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"hi"}}}),
        ] {
            assert_eq!(resolved_model_of(&silent), None, "{silent}");
            consume_terminal_result(&silent, &mut attempt);
        }
        assert_eq!(attempt.resolved_model.as_deref(), Some("claude-sonnet-5"));
        requeue(&mut attempt, "refused".into());
        assert_eq!(attempt.resolved_model, None);
        // Kept only where present, so earlier attempts read back unchanged.
        let serialized = serde_json::to_value(&attempt).unwrap();
        assert!(serialized.get("resolvedModel").is_none());
    }

    #[test]
    fn codex_thought_tokens_become_reasoning() {
        // A Codex prompt response under the adapter: thread totals, with
        // cached input outside `inputTokens` and reasoning inside output.
        let result = json!({"stopReason":"end_turn",
            "usage":{"totalTokens":160,"inputTokens":80,"cachedReadTokens":20,"outputTokens":60,"thoughtTokens":25},
            "_meta":{"quota":{"token_count":{"totalTokens":160,"inputTokens":80,"cachedInputTokens":20,"outputTokens":60,"reasoningOutputTokens":25},
                "model_usage":[{"model":"gpt-6-sol","token_count":{"totalTokens":160,"inputTokens":80,"cachedInputTokens":20,"outputTokens":60,"reasoningOutputTokens":25}}]}}});
        let mut attempt: Attempt = serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v",
            "configuration":{"id":"c","providerId":"codex-acp","accountId":"x","modelId":"gpt-6-sol","billingMode":"subscription","executionProfile":"native_text"},
            "repetition":0,"phase":"dispatching","usage":{"schema":"native"},"eventCursor":0,"workflowSteps":[],"evaluations":[]}))
        .unwrap();
        consume_terminal_result(&result, &mut attempt);
        let usage = &attempt.usage;
        assert_eq!(
            (usage.input, usage.output, usage.cache_read, usage.reasoning),
            (Some(80), Some(60), Some(20), Some(25))
        );
        // One model whose counters match the turn's is not auxiliary work.
        assert_eq!(usage.schema, "provider_turn_usage_v1");
        assert_eq!(usage.cost, None);
    }

    #[tokio::test]
    async fn native_auxiliary_usage_is_inclusive_and_kept_out_of_pure_profile() {
        let (dir, service, _) = setup().await;
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
        dir.close().await;
    }

    #[tokio::test]
    async fn a_paid_auxiliary_only_failure_is_not_a_zero_cost_pure_turn() {
        let (dir, service, _) = setup().await;
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
        dir.close().await;
    }
}
