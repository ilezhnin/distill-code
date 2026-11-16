//! A turn in which the provider's runtime lost its connection mid-answer.
//!
//! Codex asks for the response again when its stream breaks, and the answer
//! streams from its start as a new message. The pieces of the broken stream
//! are already among the session's events, so an answer read as every piece
//! of every message carried them in front of the complete one, and a checker
//! saw two or more starts of one answer (attempts fd2e614e, 3d57f2cd and
//! 98a8022d; 11-16). A turn the runtime damaged is not the model's answer:
//! the complete message after the reconnect is (owner, 11-16).
//!
//! The bridge reports a lost connection as a session failure of category
//! `connection` ("Reconnecting... 2/5"). Codex does not report its first
//! retry and announces its last one, a change of transport, as a notice, so
//! a broken stream may precede the failure unannounced or follow it. Hence
//! the rule: a lost connection drops the answer streamed until it, and from
//! then on each new message is the answer streamed again.
//!
//! An unannounced retry leaves no event at all, so a Codex text turn reads
//! its answer as its last message whether or not a failure was reported
//! (owner, 11-16): of 4351 Codex text turns on record, the 8 of several
//! messages were all streams a reconnect broke, three with no marker.
use super::*;

/// What the lost connections of a turn leave of its answer, as its events
/// are read in order.
#[derive(Default)]
pub(super) struct Restarts {
    /// The message the newest piece of the answer belongs to.
    message: Option<String>,
    /// Whether a lost connection interrupted the answer.
    interrupted: bool,
    /// Whether every new message is the answer streamed again
    /// ([`last_message_answers`]).
    last_message_only: bool,
}

impl Restarts {
    /// The reading of a turn of `provider_id` in `profile`.
    pub(super) fn for_turn(provider_id: &str, profile: &str) -> Self {
        Self {
            last_message_only: last_message_answers(provider_id, profile),
            ..Self::default()
        }
    }

    /// Reads the turn of `configuration` from now on as [`Self::for_turn`]
    /// would, for a capture made before it knew the attempt.
    pub(super) fn turn_of(&mut self, configuration: &Configuration) {
        self.last_message_only =
            last_message_answers(&configuration.provider_id, &configuration.execution_profile);
    }

    /// Reads `event`, whose answer text, if it had any, is `answer` from
    /// `answered` on. A connection lost before the answer began interrupted
    /// nothing, and an answer of several messages that no lost connection
    /// interrupted is kept whole. A piece without a message id continues the
    /// message before it.
    pub(super) fn settle(&mut self, event: &Value, answer: &mut String, answered: usize) {
        let params = event.get("params").unwrap_or(event);
        let update = params.get("update").unwrap_or(params);
        if update["sessionUpdate"] == "agent_message_chunk" {
            let Some(message) = update["messageId"].as_str() else {
                return;
            };
            if self.message.as_deref() != Some(message) {
                if self.interrupted || self.last_message_only {
                    answer.drain(..answered.min(answer.len()));
                }
                self.message = Some(message.to_owned());
            }
        } else if connection_lost(update) && !answer.is_empty() {
            self.interrupted = true;
            answer.clear();
        }
    }
}

/// Whether a turn's answer is its last message: a Codex text turn, which
/// answers in one message and streams it again from its start, as a new
/// message, after a retry it may never announce. A repository turn's report
/// and a Claude answer of several messages stay whole.
pub(super) fn last_message_answers(provider_id: &str, profile: &str) -> bool {
    provider_id == "codex-acp" && profile == "native_text"
}

/// Whether `update` is the provider's runtime saying it lost its connection
/// and is asking again: the session failure of category `connection` the
/// Codex and Claude bridges send with a session update.
fn connection_lost(update: &Value) -> bool {
    update
        .pointer("/_meta/jetbrains/air/sessionFailure/category")
        .and_then(Value::as_str)
        == Some("connection")
}

/// The answer of a finished attempt as its sealed turn reads today, when the
/// attempt records what an older capture made of that turn: every piece of
/// every message, the broken streams of a reconnect in front of the complete
/// answer. `None` for every other record: an answer no lost connection
/// interrupted, one that is not the turn's text (a repository patch), one
/// past its cap, a turn that streamed nothing after its reconnect, and
/// evidence that is missing or fails its seal. The sealed record is only
/// read; it keeps the answer the attempt settled with.
pub(in crate::services::benchmarks) async fn rebuilt_answer(
    root: &std::path::Path,
    attempt: &Attempt,
    max_artifact_bytes: u64,
) -> Option<String> {
    let recorded = attempt.output.as_deref()?;
    let evidence = fixtures::sealed_record(
        root,
        &attempt.run_id,
        &attempt.id,
        attempt.session_id.as_deref(),
        attempt.evidence_hash.as_deref()?,
    )
    .await
    .ok()?;
    // `events` itself in records sealed before the native receipt.
    let events = evidence
        .pointer("/events/turnEvents")
        .or_else(|| evidence.get("events"))
        .and_then(Value::as_array)?;
    recaptured(recorded, events, attempt, max_artifact_bytes)
}

/// `events` read by the capture of a live turn, when `recorded` is their
/// text as the older capture kept it and the two differ.
fn recaptured(
    recorded: &str,
    events: &[Value],
    attempt: &Attempt,
    max_artifact_bytes: u64,
) -> Option<String> {
    // The capture reads usage and the resolved model into an attempt; this
    // copy takes them, the stored attempt keeps its own.
    let mut reader = attempt.clone();
    reader.output = None;
    let mut capture = TurnCapture::new(max_artifact_bytes);
    let mut glued = String::new();
    let mut usage = TokenUsage::default();
    for event in events {
        consume_event(event, &mut glued, &mut usage);
        capture.read(event.clone(), &mut reader).ok()?;
    }
    let capped = capture.cap_answer();
    (glued == recorded && capture.output != glued && !capture.output.is_empty() && !capped)
        .then_some(capture.output)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{request, setup};
    use super::*;

    /// One piece of an answer as the host stores a Codex or Claude chunk.
    fn piece(message: &str, text: &str) -> Value {
        json!({"sessionId": "invented-session", "update": {
            "content": {"text": text, "type": "text"},
            "messageId": message, "sessionUpdate": "agent_message_chunk"}})
    }

    /// A session failure as the bridge sends it with a session update
    /// (attempt 98a8022d, 11-16).
    fn failure(category: &str, title: &str) -> Value {
        json!({"sessionId": "invented-session", "update": {
            "_meta": {
                "distill": {"assistantMessageId": "invented-assistant",
                    "created": "2026-11-16T19:52:54.716Z", "messageId": "invented-user",
                    "runId": "invented-run"},
                "executionOwner": {"id": "invented-attempt:1", "kind": "benchmark"},
                "jetbrains": {"air": {"sessionFailure": {"actions": [], "category": category,
                    "id": "invented-failure:error", "revision": 1, "severity": "warning",
                    "title": title}, "version": 1}}},
            "sessionUpdate": "session_info_update"}})
    }

    fn reconnecting(retry: u8) -> Value {
        failure("connection", &format!("Reconnecting... {retry}/5"))
    }

    fn blank_attempt() -> Attempt {
        let data = crate::services::benchmarks::analysis::tests::dataset();
        let mut attempt = data.attempts[0].clone();
        attempt.usage = TokenUsage::default();
        attempt
    }

    /// The answer the capture reads from `events`, and the record it keeps
    /// of them.
    fn captured(events: Vec<Value>) -> (String, Vec<Value>) {
        let mut capture = TurnCapture::new(1024);
        let mut attempt = blank_attempt();
        for event in events {
            capture.read(event, &mut attempt).unwrap();
        }
        assert!(!capture.cap_answer());
        let record = capture.evidence.close(json!({"terminalDispatch": {}}));
        (capture.output, record.as_array().unwrap().clone())
    }

    /// The text of every answer piece a record keeps, in order.
    fn streamed(record: &[Value]) -> String {
        record
            .iter()
            .filter(|event| event["update"]["sessionUpdate"] == "agent_message_chunk")
            .filter_map(|event| event["update"]["content"]["text"].as_str())
            .collect()
    }

    /// Attempts fd2e614e and 98a8022d: two broken streams, the first one's
    /// retry unannounced, then the complete answer, whose last pieces arrive
    /// after the turn's result.
    #[test]
    fn a_lost_connection_leaves_the_answer_streamed_after_it() {
        let (answer, record) = captured(vec![
            json!({"sessionId": "invented-session", "update": {
                "content": {"text": "Planning the suite.", "type": "text"},
                "messageId": "rs_invented", "sessionUpdate": "agent_thought_chunk"}}),
            piece("msg_first", "const total = "),
            piece("msg_first", "items.red"),
            piece("msg_second", "const total = it"),
            reconnecting(2),
            piece("msg_third", "const total = "),
            piece("msg_third", "items.length;"),
            json!({"update": {"sessionUpdate": "benchmark_turn_result", "_meta": {}}}),
            piece("msg_third", "\nreturn total;"),
        ]);
        assert_eq!(answer, "const total = items.length;\nreturn total;");
        // The record keeps the turn as it streamed, the broken streams and
        // the failure included.
        assert_eq!(
            streamed(&record),
            "const total = items.redconst total = itconst total = items.length;\nreturn total;"
        );
        let failures = record
            .iter()
            .filter(|event| connection_lost(&event["update"]))
            .count();
        assert_eq!(failures, 1);
        assert!(record
            .iter()
            .any(|event| event["update"]["sessionUpdate"] == "agent_thought_chunk"));
    }

    /// Attempt 3d57f2cd: every retry breaks, and the stream after the last
    /// one, announced by a notice instead of a failure, breaks as well.
    #[test]
    fn a_stream_restarted_without_a_failure_replaces_the_one_before() {
        let (answer, record) = captured(vec![
            piece("msg_1", "Half an ans"),
            reconnecting(2),
            piece("msg_2", "Half an answ"),
            reconnecting(3),
            piece("msg_3", "Half a"),
            json!({"update": {"sessionUpdate": "notice", "severity": "warning",
                "title": "Falling back from WebSockets to HTTPS transport. stream disconnected \
                          before completion: idle timeout waiting for websocket"}}),
            piece("msg_4", "The whole "),
            piece("msg_4", "answer."),
        ]);
        assert_eq!(answer, "The whole answer.");
        assert_eq!(
            streamed(&record),
            "Half an ansHalf an answHalf aThe whole answer."
        );
    }

    #[test]
    fn only_a_lost_connection_restarts_an_answer() {
        let turn = |category: &str| {
            captured(vec![
                piece("msg_1", "First part. "),
                failure(category, "Invented failure"),
                piece("msg_2", "Second part."),
            ])
            .0
        };
        assert_eq!(turn("connection"), "Second part.");
        for category in ["limit", "authentication", "agent"] {
            assert_eq!(turn(category), "First part. Second part.", "{category}");
        }
    }

    /// Claude answers in several messages. No failure, or the reconnect its
    /// bridge reports before the answer begins (attempt 90079d66), leaves
    /// every message of it.
    #[test]
    fn an_answer_of_several_messages_is_whole_unless_a_reconnect_interrupted_it() {
        let messages = || {
            vec![
                piece("msg_011a", "One. "),
                piece("msg_011b", "Two. "),
                piece("msg_011b", "Still two. "),
                piece("msg_011c", "Three."),
            ]
        };
        let whole = "One. Two. Still two. Three.";
        assert_eq!(captured(messages()).0, whole);
        let before = failure("connection", "Reconnecting to Claude, attempt 1 of 10.");
        let mut early = vec![before.clone()];
        early.extend(messages());
        assert_eq!(captured(early).0, whole);
        // A piece without a message id continues its message.
        let mut unnamed = messages();
        unnamed.push(json!({"update": {"sessionUpdate": "agent_message_chunk",
            "content": {"text": " Four."}}}));
        unnamed.insert(1, before.clone());
        assert_eq!(captured(unnamed).0, "Three. Four.");
        // The same failure once the answer has begun interrupts it.
        let mut interrupted = messages();
        interrupted.insert(1, before);
        assert_eq!(captured(interrupted).0, "Three.");
    }

    /// A Codex text turn answers in one message; a second one is the answer
    /// streamed again after a retry its runtime never announced (attempts
    /// 714ff31b, 65ac519d and 8b9d4382, 11-16). A Codex repository report
    /// and a Claude answer keep every message, and a judge's reply reads as
    /// its provider's answer does.
    #[test]
    fn a_codex_text_turn_answers_with_its_last_message() {
        let events = || {
            vec![
                piece("msg_1", "const total = it"),
                piece("msg_2", "const total = items.length;"),
            ]
        };
        let glued = "const total = itconst total = items.length;";
        let turn = |provider: &str, profile: &str| {
            let mut capture = TurnCapture::new(1024);
            let mut attempt = blank_attempt();
            attempt.configuration.provider_id = provider.into();
            attempt.configuration.execution_profile = profile.into();
            for event in events() {
                capture.read(event, &mut attempt).unwrap();
            }
            capture.output
        };
        assert_eq!(
            turn("codex-acp", "native_text"),
            "const total = items.length;"
        );
        assert_eq!(turn("codex-acp", "protected_repository"), glued);
        assert_eq!(turn("claude-acp", "native_text"), glued);
        let reply = |provider: &str| {
            let mut restarts = Restarts::for_turn(provider, "native_text");
            let mut reply = String::new();
            let mut usage = TokenUsage::default();
            for event in events() {
                let answered = reply.len();
                consume_event(&event, &mut reply, &mut usage);
                restarts.settle(&event, &mut reply, answered);
            }
            reply
        };
        assert_eq!(reply("codex-acp"), "const total = items.length;");
        assert_eq!(reply("claude-acp"), glued);
        // An answer recorded the old way is read again on Evaluate again.
        let mut codex = blank_attempt();
        codex.configuration.provider_id = "codex-acp".into();
        assert_eq!(
            recaptured(glued, &events(), &codex, 1024).as_deref(),
            Some("const total = items.length;")
        );
        assert_eq!(recaptured(glued, &events(), &blank_attempt(), 1024), None);
    }

    /// The sealed turn of a finished attempt: its events as a receipt keeps
    /// them, sealed with the answer the attempt recorded.
    async fn sealed(s: &BenchmarkService, id: &str, output: &str, events: &[Value]) -> Attempt {
        let mut attempt = s.store.attempt(id).await.unwrap();
        attempt.output = Some(output.into());
        attempt.outcome = Some("fail".into());
        attempt.evaluations.clear();
        attempt.evidence_hash = Some(
            fixtures::seal(
                &s.store.root,
                &attempt,
                &json!({"nativeExecutionReceiptAbsent": "invented", "turnEvents": events}),
            )
            .await
            .unwrap(),
        );
        s.store.save_attempt(&attempt).await.unwrap();
        attempt
    }

    #[tokio::test]
    async fn evaluating_again_reads_a_reconnected_answer_from_its_sealed_turn() {
        let (dir, s, _) = setup().await;
        let run = s.start_run(request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let good = s
            .store
            .version(&run.attempts[0].version_id)
            .await
            .unwrap()
            .manifest
            .evaluator
            .known_good;
        let (start, end) = good.split_at(good.len() / 2);
        let events = [
            piece("msg_first", start),
            piece("msg_second", "{\"broken\": "),
            reconnecting(2),
            piece("msg_third", start),
            piece("msg_third", end),
            json!({"terminalDispatch": {"phase": "terminal"}}),
        ];
        // What the older capture recorded: both broken streams, then the
        // answer.
        let glued = format!("{start}{{\"broken\": {good}");
        let damaged = sealed(&s, &run.attempts[0].id, &glued, &events).await;
        let rescored = s.rescore(&damaged.id).await.unwrap();
        assert_eq!(rescored.output.as_deref(), Some(good.as_str()));
        assert_eq!(rescored.outcome.as_deref(), Some("pass"));
        let stored = s.store.attempt(&damaged.id).await.unwrap();
        assert_eq!(stored.output.as_deref(), Some(good.as_str()));
        assert_eq!(
            crate::services::benchmarks::analysis::score(&stored),
            Some(1.0)
        );
        // The seal is the one the attempt settled with, and still verifies.
        assert_eq!(stored.evidence_hash, damaged.evidence_hash);
        let record = fixtures::sealed_record(
            &s.store.root,
            &stored.run_id,
            &stored.id,
            stored.session_id.as_deref(),
            stored.evidence_hash.as_deref().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(record["output"], glued);
        assert_eq!(record["events"]["turnEvents"], json!(events));
        // Evaluated once more, the answer stays the rebuilt one.
        let again = s.rescore(&damaged.id).await.unwrap();
        assert_eq!(again.output.as_deref(), Some(good.as_str()));
        assert_eq!(again.outcome.as_deref(), Some("pass"));
        assert_eq!(again.evaluations.len(), 2);
        // An answer that is not its turn's text is evaluated as recorded.
        let other = sealed(&s, &run.attempts[1].id, "not the turn's text", &events).await;
        let kept = s.rescore(&other.id).await.unwrap();
        assert_eq!(kept.output.as_deref(), Some("not the turn's text"));
        assert_eq!(kept.outcome.as_deref(), Some("fail"));
        dir.close().await;
    }
}
