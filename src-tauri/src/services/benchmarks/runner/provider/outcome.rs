//! How a turn ended, in the terms of an attempt.
use super::*;

/// ACP's `auth_required` error code.
const ACP_AUTH_REQUIRED: i64 = -32000;

/// The outcome of a turn that ended with `error` on `model_id`: a task the
/// provider refused as content ([`refused_task`]) is the candidate's failed
/// answer; a provider that refuses the model to this account
/// ([`refuses_model`]) makes the configuration unsupported; anything else
/// as [`terminal_error_outcome`] reads it.
pub(in super::super) fn terminal_outcome(error: &Value, model_id: &str) -> &'static str {
    if exceeded_output_cap(error) {
        "budget_reached"
    } else if refused_task(error) {
        "fail"
    } else if refuses_model(error, model_id) {
        "unsupported"
    } else {
        terminal_error_outcome(error)
    }
}

/// Providers whose CLI output-token stop the runner recognizes, as an error
/// ([`exceeded_output_cap`]) or a quiet stop ([`runtime_output_cap_stop`]);
/// a holdout report names the others as a limitation.
pub(crate) const OUTPUT_CAP_PROVIDERS: [&str; 3] = ["claude-acp", "grok-acp", "zai-acp"];

/// Whether a turn that ended without an error completed no model request
/// and answered nothing: Kimi Code's way of ending a turn its request
/// failed ([`crate::services::benchmarks::analysis::KIMI_UNANSWERED`]). Not the model's answer, so
/// not graded: the cell stays open for the operator, as for any failure of
/// the provider's runtime.
pub(in super::super) fn unanswered_turn(attempt: &Attempt, answer: &str) -> bool {
    answer.trim().is_empty()
        && crate::services::benchmarks::analysis::kimi_never_answered(
            &attempt.configuration.provider_id,
            &attempt.usage,
        )
}

/// Why a turn that ended without an error stopped at the output-token maximum
/// of its provider's CLI, if it did. OpenCode, the Z.ai runtime, says so as
/// ACP's `max_tokens` stop only when the provider flags the cut; usually a
/// request its maximum cuts off just ends the turn with `end_turn`, and the
/// usage OpenCode reports is that last request's. Its output and reasoning
/// reaching the maximum is then the cut (11-16: 91 GLM turns stopped at
/// exactly 32000, most with no answer). The cut answer is the model's own, as
/// Claude's past Claude Code's maximum is: a budget failure scored zero.
pub(in super::super) fn runtime_output_cap_stop(
    provider_id: &str,
    result: &Value,
) -> Option<String> {
    if provider_id != "zai-acp" {
        return None;
    }
    let max = crate::services::agent_host::execution::zai_output_token_max();
    if result["stopReason"] == "max_tokens" {
        return Some(format!(
            "OpenCode stopped the model's last request at its {max}-token output maximum"
        ));
    }
    let usage = &result["usage"];
    let spent = usage["outputTokens"]
        .as_u64()?
        .saturating_add(usage["thoughtTokens"].as_u64().unwrap_or(0));
    (result["stopReason"] == "end_turn" && spent >= max).then(|| {
        format!(
            "OpenCode stopped the model's last request at its {max}-token output maximum, \
             reasoning included ({spent} tokens)"
        )
    })
}

/// Whether the provider's own CLI stopped a turn because the answer passed its
/// output-token maximum (Claude Code: "Claude's response exceeded the 32000
/// output token maximum"; Grok Build: "response truncated by max_tokens").
/// The reason keeps the provider's words, which name the cap in effect. The over-long answer is the model's own, so the
/// attempt is a budget failure scored zero, like an answer past the published
/// cap, never an unscored infrastructure failure. The CLI's limit belongs to
/// its pinned runtime, which every inventory revision already names.
pub(in super::super) fn exceeded_output_cap(error: &Value) -> bool {
    // Grok Build names its stop by kind: "response truncated by max_tokens".
    let kind = |path: &str| error.pointer(path).and_then(Value::as_str);
    if [
        "/data/error_kind",
        "/data/errorKind",
        "/error_kind",
        "/errorKind",
    ]
    .into_iter()
    .any(|path| kind(path) == Some("max_tokens_truncation"))
    {
        return true;
    }
    let failure = error
        .pointer("/data/sessionFailure")
        .or_else(|| error.get("sessionFailure"));
    let said = |text: Option<&str>| {
        text.map(str::to_ascii_lowercase).is_some_and(|text| {
            text.contains("exceeded the") && text.contains("output token maximum")
        })
    };
    failure.is_some_and(|f| f["category"] == "limit" && f["severity"] == "error")
        && (said(failure.and_then(|f| f["title"].as_str()))
            || said(error["message"].as_str())
            || said(error.pointer("/data/message").and_then(Value::as_str)))
}

/// Whether the candidate's provider refused the task itself as content it
/// will not work on. OpenAI's safeguards answer a prompt they flag with a
/// failed turn in place of an answer ("This content was flagged for possible
/// cybersecurity risk", "Invalid prompt: your prompt was flagged as
/// potentially violating our usage policy"; 11-14). The refusal is the
/// candidate's answer to the case, as a Claude refusal is: a model that
/// will not do the work failed the test, scored 0, and the cell is measured
/// (owner, 11-14). It was an unscored infrastructure failure, which left
/// the cell open and scored one lab's refusals and not another's. xAI's and
/// Z.ai's safeguards refuse in their own words ([`grok_declined_task`],
/// [`zai_declined_task`]). The reason keeps the provider's words. A turn the
/// provider never took, a usage limit and a refusal of the account or of
/// the model are none. Claude's, Kimi's and a GLM answer's refusals end the
/// turn with ACP's `refusal` stop instead, an answer graded like any other.
pub(in super::super) fn refused_task(error: &Value) -> bool {
    let data = &error["data"];
    let failure = &data["sessionFailure"];
    let said = |text: &Value| {
        text.as_str()
            .is_some_and(|text| text.to_ascii_lowercase().contains("was flagged"))
    };
    let flagged = data["errorKind"] == "provider_failure"
        && failure["severity"] == "error"
        && (said(&failure["title"]) || said(&error["message"]));
    let sent = data["dispatchStarted"] == true && data["promptNotAccepted"] != true;
    (sent && (flagged || grok_declined_task(data))) || zai_declined_task(error)
}

/// Z.ai's verdict on a request its safeguards will not work on: business
/// code 1301, HTTP 400, "System detected potentially unsafe or sensitive
/// content in input or generation." (docs.z.ai/api-reference/api-code,
/// 11-16; its mainland API says the same in Chinese). OpenCode forwards it
/// as the turn's error, often before it streams anything, so the host may
/// see no dispatch: the verdict itself is the provider's answer to the
/// prompt it received. A refusal of the generation mid-stream ends the turn
/// with a `sensitive` finish, which OpenCode settles as a plain turn.
fn zai_declined_task(error: &Value) -> bool {
    let said = |text: &Value| {
        text.as_str().is_some_and(|text| {
            text.to_ascii_lowercase()
                .contains("potentially unsafe or sensitive content")
                || text.contains("不安全或敏感内容")
        })
    };
    said(&error["message"]) || said(&error["data"]["message"])
}

/// Whether xAI's safeguards refused the task: its API answers a request
/// they will not work on with HTTP 403 and the model's refusal, which Grok
/// Build forwards as its error ("API error (status 403 Forbidden):
/// permission-denied: I'm sorry, I can't help with that request."; 11-16,
/// one repetition of a repository case whose other two passed). It stopped
/// the run as an infrastructure failure. A 403 without those words (an
/// account or a model the API does not allow) is no refusal of the task.
fn grok_declined_task(data: &Value) -> bool {
    let Some(message) = data["message"].as_str() else {
        return false;
    };
    let message = message.to_ascii_lowercase().replace('\u{2019}', "'");
    data["http_status"] == 403
        && message.contains("permission-denied")
        && ["can't help with that", "cannot help with that"]
            .iter()
            .any(|words| message.contains(words))
}

/// The words with which a provider's message refuses the model it names:
/// Kimi's API, forwarded verbatim by the pinned Kimi Code bundle, says the
/// subscription "does not have access to" the model.
const MODEL_REFUSAL: &str = "does not have access to";

/// Whether a turn's error is the provider refusing the requested model to
/// the account: ACP's `auth_required` code with a provider message that
/// refuses that very model, in [`MODEL_REFUSAL`]'s words right before its
/// name. Kimi Code maps a 401 from its API to `auth_required` with the API's
/// message, which for a model the plan leaves out reads "Authentication
/// required: 401 Your current subscription does not have access to
/// kimi-for-coding-highspeed. ...". A sign-in that failed or expired refuses
/// no model, even when its message mentions one, and stays an
/// infrastructure failure; the attempt's reason keeps the whole message
/// either way.
fn refuses_model(error: &Value, model_id: &str) -> bool {
    let code = error["code"]
        .as_i64()
        .or_else(|| error.pointer("/data/code").and_then(Value::as_i64));
    if code != Some(ACP_AUTH_REQUIRED) {
        return false;
    }
    let Some(message) = error["message"].as_str() else {
        return false;
    };
    // A model is named by its id or, for an id the bridge scopes
    // (`kimi-code/kimi-for-coding-highspeed`), by the provider's own name for
    // it after the last slash.
    let message = message.to_lowercase();
    let model = model_id.to_lowercase();
    let own = model.rsplit('/').next().unwrap_or(&model);
    let refuses = |name: &str| names(&message, &format!("{MODEL_REFUSAL} {name}"));
    refuses(&model) || refuses(own)
}

/// Whether `text` holds `name` as a whole name: not inside a longer model id
/// (`kimi-for-coding` in `kimi-for-coding-highspeed`, `grok-4` in `grok-4.7`).
pub(in super::super) fn names(text: &str, name: &str) -> bool {
    if name.len() < 3 {
        return false;
    }
    let part = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/');
    text.match_indices(name).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let mut after = text[at + name.len()..].chars();
        let next = after.next();
        before.is_none_or(|c| !part(c) && c != '.')
            && next.is_none_or(|c| {
                !part(c) && (c != '.' || after.next().is_none_or(|c| !c.is_ascii_alphanumeric()))
            })
    })
}

pub(in super::super) fn terminal_error_outcome(error: &Value) -> &'static str {
    match error["kind"]
        .as_str()
        .or_else(|| error.pointer("/data/kind").and_then(Value::as_str))
    {
        // The host's deadline passed before the turn reached the provider.
        Some("budget_timeout")
            if error["proof"] == NO_PROVIDER_START
                || error.pointer("/data/proof").and_then(Value::as_str)
                    == Some(NO_PROVIDER_START) =>
        {
            "infrastructure_failure"
        }
        Some("budget_timeout") => "budget_timeout",
        Some("cancelled") => "cancelled",
        Some("selection_changed") => "selection_changed",
        Some("execution_violation") => "execution_violation",
        Some("candidate_artifact_invalid") => "fail",
        Some("quota_blocked" | "quota_exhausted") => "quota_blocked",
        Some("dispatch_uncertain") => "dispatch_uncertain",
        Some("policy_violation" | "capability_missing") => "unsupported",
        _ => "infrastructure_failure",
    }
}
