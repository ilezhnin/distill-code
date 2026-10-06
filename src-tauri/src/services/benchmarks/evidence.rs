//! What a sealed attempt keeps of its turn, and the attempts an earlier
//! runner stopped for the size of that record rather than for their answer.
//!
//! The published artifact cap (`limits.max_artifact_bytes`) bounds the
//! candidate's answer. The events of a turn are the benchmark's own record
//! of it: a provider streams its answer and its reasoning in thousands of
//! small chunks, and each chunk carries transport telemetry (Grok's
//! timestamps, chunk and event ids, the host's per-update stamp) that is many
//! times the size of its text. That telemetry is left out of the sealed
//! record, and the record has a ceiling of its own; reaching it stops the
//! record, never the turn.
use super::types::*;
use serde_json::{json, Value};
use std::collections::HashMap;

/// The most a sealed record of one turn keeps of its events. Twice the
/// largest artifact cap the catalog admits, so a turn whose answer stays
/// within any cap is recorded whole.
pub(crate) const EVIDENCE_CEILING_BYTES: usize = 32 * 1024 * 1024;

/// The updates a provider streams in pieces; each piece carries per-chunk
/// telemetry.
const STREAMED_UPDATES: [&str; 2] = ["agent_message_chunk", "agent_thought_chunk"];

/// The `_meta` keys the service reads from an event: the host's policy
/// violation tag (`violation_of`), Grok's raw turn usage and the host's copy
/// of a prompt response (`consume_event`, `resolved_model_of`), and per-model
/// quota usage (`resolved_model_of`). Every other key a streamed chunk
/// carries is telemetry.
const READ_META_KEYS: [&str; 4] = [
    "executionViolation",
    "xaiTurnUsage",
    "benchmarkRawResult",
    "quota",
];

/// `payload` as a sealed record keeps it: a streamed chunk without the
/// `_meta` keys the service never reads, at every level an event may carry
/// one (the event, its `params`, its `update`); any other event whole.
pub(crate) fn sealed_event(mut payload: Value) -> Value {
    let streamed = {
        let params = payload.get("params").unwrap_or(&payload);
        let update = params.get("update").unwrap_or(params);
        update["sessionUpdate"]
            .as_str()
            .is_some_and(|kind| STREAMED_UPDATES.contains(&kind))
    };
    if !streamed {
        return payload;
    }
    strip_telemetry(&mut payload);
    let params = match payload.get_mut("params") {
        Some(params) => {
            strip_telemetry(params);
            params
        }
        None => &mut payload,
    };
    if let Some(update) = params.get_mut("update") {
        strip_telemetry(update);
    }
    payload
}

fn strip_telemetry(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let Some(meta) = object.get_mut("_meta").and_then(Value::as_object_mut) else {
        return;
    };
    meta.retain(|key, _| READ_META_KEYS.contains(&key.as_str()));
    if meta.is_empty() {
        object.remove("_meta");
    }
}

/// The events of one turn as its sealed record keeps them, in order: each
/// through [`sealed_event`], until the next would pass the ceiling. From
/// there on nothing more is appended, and the record closes with a marker
/// that says how much was left out. Neither ends the turn nor changes its
/// outcome.
#[derive(Debug)]
pub(crate) struct EvidenceLog {
    ceiling: usize,
    events: Vec<Value>,
    bytes: usize,
    dropped_events: usize,
    dropped_bytes: usize,
}

impl Default for EvidenceLog {
    fn default() -> Self {
        Self::with_ceiling(EVIDENCE_CEILING_BYTES)
    }
}

impl EvidenceLog {
    pub(crate) fn with_ceiling(ceiling: usize) -> Self {
        Self {
            ceiling,
            events: Vec::new(),
            bytes: 0,
            dropped_events: 0,
            dropped_bytes: 0,
        }
    }

    pub(crate) fn push(&mut self, payload: Value) -> Result<()> {
        let event = sealed_event(payload);
        let size = serde_json::to_vec(&event)?.len();
        if self.dropped_events == 0 && self.bytes.saturating_add(size) <= self.ceiling {
            self.bytes += size;
            self.events.push(event);
        } else {
            self.dropped_events += 1;
            self.dropped_bytes = self.dropped_bytes.saturating_add(size);
        }
        Ok(())
    }

    /// Ends the record with the host's terminal dispatch record, which is
    /// always kept, after the truncation marker when the ceiling was reached.
    pub(crate) fn close(mut self, terminal: Value) -> Value {
        if self.dropped_events > 0 {
            self.events.push(json!({"evidenceTruncated": {
                "ceilingBytes": self.ceiling,
                "keptBytes": self.bytes,
                "droppedEvents": self.dropped_events,
                "droppedBytes": self.dropped_bytes,
            }}));
        }
        self.events.push(terminal);
        Value::Array(self.events)
    }
}

/// The reason runners before this record kept gave an attempt they stopped
/// at the artifact cap. They counted the events' serialized size against the
/// cap as well as the answer, so per-chunk telemetry alone could end a turn.
pub(crate) const LEGACY_CAP_REASON: &str =
    "Output/evidence exceeded the published artifact cap; cancellation acknowledged";

/// What the analyses read for such an attempt instead.
pub(crate) const EVIDENCE_STOP_REASON: &str =
    "Stopped by the size of its event record, not by its answer; not a measurement";

/// Whether `attempt` settled as a budget failure because its event record,
/// not its answer, passed the cap of `max_artifact_bytes`: the old runner's
/// reason on an answer that never reached the cap. An answer that did was
/// cut back to the cap on a character boundary, at most three bytes short of
/// it, so only an answer at least four bytes short was stopped by its
/// events.
pub(crate) fn stopped_by_evidence(attempt: &Attempt, max_artifact_bytes: u64) -> bool {
    attempt.outcome.as_deref() == Some("budget_reached")
        && attempt.reason.as_deref() == Some(LEGACY_CAP_REASON)
        && (attempt.output.as_deref().map_or(0, str::len) as u64).saturating_add(4)
            <= max_artifact_bytes
}

/// Reads an attempt [`stopped_by_evidence`] as the unscored infrastructure
/// failure it was: the benchmark stopped it, not the candidate. The store
/// keeps the outcome it settled with.
fn read_as_unscored(attempt: &mut Attempt, caps: &HashMap<String, u64>) {
    if caps
        .get(&attempt.version_id)
        .is_some_and(|cap| stopped_by_evidence(attempt, *cap))
    {
        attempt.outcome = Some("infrastructure_failure".into());
        attempt.reason = Some(EVIDENCE_STOP_REASON.into());
    }
}

fn caps(versions: &[BenchmarkVersion]) -> HashMap<String, u64> {
    versions
        .iter()
        .map(|version| {
            (
                version.id.clone(),
                version.manifest.limits.max_artifact_bytes,
            )
        })
        .collect()
}

/// Analysis data in which every attempt [`stopped_by_evidence`] is unscored
/// rather than a budget failure: its cell counts as not measured, so a
/// catch-up offers it again, and an older measured cell of the same case
/// stands. Nothing in the store changes, and run detail shows what it holds.
pub fn with_answer_caps(mut data: QueryData) -> QueryData {
    let caps = caps(&data.versions);
    for attempt in data
        .attempts
        .iter_mut()
        .chain(data.runs.iter_mut().flat_map(|run| run.attempts.iter_mut()))
    {
        read_as_unscored(attempt, &caps);
    }
    data
}

/// One Design Bench rendering, read the same way against its brief's cap.
pub(crate) fn rendering_with_answer_cap(attempt: &mut Attempt, max_artifact_bytes: u64) {
    if stopped_by_evidence(attempt, max_artifact_bytes) {
        attempt.outcome = Some("infrastructure_failure".into());
        attempt.reason = Some(EVIDENCE_STOP_REASON.into());
    }
}

#[cfg(test)]
mod tests {
    use super::super::analysis::{self, tests::dataset};
    use super::*;

    /// A Grok answer chunk as the host stores it: Grok's per-chunk telemetry
    /// on the notification, the host's stamp and owner on the update.
    fn grok_chunk(kind: &str, text: &str, n: usize) -> Value {
        json!({
            "_meta": {"agentTimestampMs": 1_791_142_991_804u64 + n as u64, "chunkId": n,
                "eventId": format!("01a10871-0ea6-7042-b71f-98eb341afd73-{n}"),
                "promptId": "ddf932fe-1f3b-47f4-a036-120ad519f902", "streamStartMs": 1_791_142_990_182u64,
                "totalTokens": 207, "turnStartMs": 1_791_142_989_637u64, "updateType": "AgentMessageChunk"},
            "sessionId": "7ce99634-5aee-4928-9ab8-57085d4c26a3",
            "update": {
                "_meta": {
                    "distill": {"assistantMessageId": "c373d081-b2d1-4b26-93d4-7e9c8f400d74",
                        "created": "2026-10-04T19:43:15.247Z", "messageId": "30b2e7ec-a1c6-484a-8316-affdf9f8bca1",
                        "runId": "808dd1f8-1cc5-4ba8-964e-da06df71a147"},
                    "executionOwner": {"id": "89663cb7-d49e-4dca-a9cf-6a7637dc82e1:1791142989445", "kind": "benchmark"}
                },
                "content": {"text": text, "type": "text"},
                "sessionUpdate": kind
            }
        })
    }

    #[test]
    fn streamed_chunks_lose_their_telemetry_and_keep_their_text() {
        let sealed = sealed_event(grok_chunk("agent_message_chunk", " standalone", 18));
        assert_eq!(
            sealed,
            json!({"sessionId": "7ce99634-5aee-4928-9ab8-57085d4c26a3",
                "update": {"content": {"text": " standalone", "type": "text"},
                    "sessionUpdate": "agent_message_chunk"}})
        );
        let thought = sealed_event(grok_chunk("agent_thought_chunk", "I need", 1));
        assert!(thought.get("_meta").is_none() && thought["update"].get("_meta").is_none());
        // A chunk the host wrapped in `params` is stripped at each level.
        let wrapped = sealed_event(
            json!({"_meta": {"x": 1}, "params": grok_chunk("agent_message_chunk", "a", 2)}),
        );
        assert!(wrapped.get("_meta").is_none());
        assert!(wrapped["params"].get("_meta").is_none());
        assert_eq!(wrapped["params"]["update"]["content"]["text"], "a");
    }

    #[test]
    fn what_the_service_reads_is_kept_and_other_events_stay_whole() {
        // A violation tag, usage and model usage survive on any event.
        let mut tagged = grok_chunk("agent_message_chunk", "x", 3);
        tagged["update"]["_meta"]["executionViolation"] = json!("native tool activity");
        tagged["_meta"]["quota"] = json!({"model_usage": [{"model": "m"}]});
        let sealed = sealed_event(tagged);
        assert_eq!(
            sealed["update"]["_meta"],
            json!({"executionViolation": "native tool activity"})
        );
        assert_eq!(
            sealed["_meta"],
            json!({"quota": {"model_usage": [{"model": "m"}]}})
        );
        for event in [
            json!({"update": {"sessionUpdate": "message_usage", "_meta": {"xaiTurnUsage": {"modelCalls": 1}, "distill": {}}}}),
            json!({"update": {"sessionUpdate": "session_summary_generated", "session_summary": "t", "_meta": {"distill": {}}}}),
            json!({"update": {"sessionUpdate": "user_message_chunk", "_meta": {"verbatim": true}}}),
            json!({"terminalDispatch": {"phase": "terminal"}}),
        ] {
            assert_eq!(sealed_event(event.clone()), event);
        }
    }

    /// The screening run's Grok attempts: about 1,450 chunks of a few bytes
    /// each, a megabyte with their telemetry.
    #[test]
    fn a_long_stream_records_whole_far_below_the_size_its_telemetry_had() {
        let chunks: Vec<Value> = (0..1_500)
            .map(|n| grok_chunk("agent_message_chunk", " word", n))
            .collect();
        let raw: usize = chunks
            .iter()
            .map(|c| serde_json::to_vec(c).unwrap().len())
            .sum();
        assert!(raw > 1024 * 1024, "{raw}");
        let mut log = EvidenceLog::default();
        for chunk in chunks {
            log.push(chunk).unwrap();
        }
        let sealed = log.close(json!({"terminalDispatch": {}}));
        let events = sealed.as_array().unwrap();
        assert_eq!(events.len(), 1_501);
        assert!(events.iter().all(|e| e.get("evidenceTruncated").is_none()));
        // Less than a quarter of what the stream took with its telemetry.
        assert!(serde_json::to_vec(&sealed).unwrap().len() * 4 < raw);
    }

    #[test]
    fn past_the_ceiling_the_record_stops_and_says_so() {
        let mut log = EvidenceLog::with_ceiling(1_000);
        for n in 0..20 {
            log.push(grok_chunk("agent_message_chunk", "0123456789", n))
                .unwrap();
        }
        // A small event after the first one left out is left out as well:
        // the record is a prefix of the turn.
        log.push(json!({"update": {"sessionUpdate": "usage_update"}}))
            .unwrap();
        let sealed = log.close(json!({"terminalDispatch": {"phase": "terminal"}}));
        let events = sealed.as_array().unwrap();
        let kept = events.len() - 2;
        assert!(kept > 0 && kept < 20, "{kept}");
        let marker = &events[kept]["evidenceTruncated"];
        assert_eq!(marker["ceilingBytes"], 1_000);
        assert_eq!(marker["droppedEvents"], (21 - kept) as u64);
        assert!(marker["keptBytes"].as_u64().unwrap() <= 1_000);
        assert_eq!(events[kept + 1]["terminalDispatch"]["phase"], "terminal");
    }

    fn capped(output: &str) -> Attempt {
        let data = dataset();
        let mut attempt = data.attempts[0].clone();
        attempt.outcome = Some("budget_reached".into());
        attempt.reason = Some(LEGACY_CAP_REASON.into());
        attempt.output = Some(output.into());
        attempt.evaluations.clear();
        attempt
    }

    #[test]
    fn only_an_answer_short_of_the_cap_was_stopped_by_its_events() {
        assert!(stopped_by_evidence(&capped("<html>…</html>"), 1024 * 1024));
        // An answer cut back to the cap, or up to three bytes short of it
        // on a character boundary, was the candidate's.
        assert!(!stopped_by_evidence(&capped(&"a".repeat(100)), 100));
        assert!(!stopped_by_evidence(&capped(&"a".repeat(97)), 100));
        assert!(stopped_by_evidence(&capped(&"a".repeat(96)), 100));
        // Another reason, or another outcome, is not this stop.
        let mut timed = capped("x");
        timed.outcome = Some("budget_timeout".into());
        assert!(!stopped_by_evidence(&timed, 100));
        let mut answer = capped("x");
        answer.reason = Some(
            "The answer exceeded the published artifact cap; cancellation acknowledged".into(),
        );
        assert!(!stopped_by_evidence(&answer, 100));
    }

    /// Run 607f8612: an attempt stopped by its event record scored a fixed 0
    /// as a budget failure. Read at load, it is unscored: its case is a gap
    /// the catch-up offers again, while the store keeps what it settled with.
    #[test]
    fn an_attempt_stopped_by_its_events_is_a_gap_not_a_zero() {
        let mut data = dataset();
        let query = ResultQuery::default();
        let version = data.attempts[0].version_id.clone();
        let cap = data
            .versions
            .iter()
            .find(|v| v.id == version)
            .unwrap()
            .manifest
            .limits
            .max_artifact_bytes;
        assert!(cap > 4);
        let stopped = {
            let mut attempt = capped("<html></html>");
            attempt.version_id = version.clone();
            attempt
        };
        for attempt in data
            .attempts
            .iter_mut()
            .chain(data.runs.iter_mut().flat_map(|r| r.attempts.iter_mut()))
            .filter(|a| a.version_id == version)
        {
            attempt.outcome = stopped.outcome.clone();
            attempt.reason = stopped.reason.clone();
            attempt.output = stopped.output.clone();
            attempt.evaluations.clear();
        }
        let before = analysis::leaderboard(&data, &query);
        assert!(before.rows[0].missing_version_ids.is_empty());
        let read = with_answer_caps(data.clone());
        assert!(read
            .attempts
            .iter()
            .chain(read.runs.iter().flat_map(|r| r.attempts.iter()))
            .filter(|a| a.version_id == version)
            .all(|a| a.outcome.as_deref() == Some("infrastructure_failure")
                && analysis::score(a).is_none()));
        let after = analysis::leaderboard(&read, &query);
        assert_eq!(after.rows[0].missing_version_ids, vec![version.clone()]);
        // The data handed in is untouched.
        assert!(data
            .attempts
            .iter()
            .any(|a| a.outcome.as_deref() == Some("budget_reached")));
    }
}
