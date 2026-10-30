//! Benchmark chats live only while their attempt may still need them.
//!
//! Each benchmark turn runs as a hidden host session. Once its attempt is
//! final, what the benchmark keeps of the turn is in this store and in the
//! sealed evidence file: the answer, the turn's events, usage and the native
//! receipt. Scoring, judging, certification, promotion and exports read only
//! those, and the evidence view shows the transcript from the sealed file. The
//! host session is then removed with its records
//! (`agent_host::router::Inner::purge_benchmark_sessions`): right after an
//! attempt's flight ends, and for everything that settles elsewhere (judge
//! panels of qualifications and calibrations, model inventory probes, the
//! backlog of earlier builds) on start and every [`SWEEP_EVERY`].
//!
//! A session stays while anything may still read it: a turn the host has not
//! settled, an attempt that is not final or whose outcome a restart left
//! unknown, a judge vote recorded as in flight, and an attempt being
//! evaluated right now.
use super::{
    store::{now, Store},
    types::*,
    BenchmarkService,
};
use crate::services::agent_host::store::{BenchmarkSessionEntry, PurgeStats};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// How long a session that names no stored attempt stays after its last turn
/// record: judges of qualifications and judge-pool calibrations, inventory
/// probes, tries the runner put back. Their answers are read as their turn
/// ends; an hour is far past that.
pub(super) const UNNAMED_GRACE_MS: i64 = 60 * 60 * 1000;
/// How often the full pass runs while Flock is open.
pub(super) const SWEEP_EVERY: Duration = Duration::from_secs(30 * 60);
/// Attempt ids per query of the benchmark store.
const QUERY_CHUNK: usize = 400;
/// Attempts whose sessions one purge call removes together.
const PURGE_BATCH: usize = 256;

/// Whether the attempt (or workflow step) behind a session may still read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OwnerState {
    /// Settled for good: nothing reads its sessions again.
    Final,
    /// Queued, running, waiting for judges, or left by a restart with an
    /// outcome still to recover.
    Open,
}

/// What the benchmark store says about the sessions of one pass.
#[derive(Debug, Default)]
pub(super) struct Facts {
    /// Attempt and workflow step ids, the prefix of their sessions' owners.
    pub owners: HashMap<String, OwnerState>,
    /// Sessions a judge vote recorded as in flight names: a restart settles
    /// such a vote from them.
    pub protected: HashSet<String>,
}

/// The attempt or step an owner names: candidate turns are
/// `<attempt>:<started>`, judges `<attempt>:judge:<batch>:<index>`.
pub(super) fn owner_prefix(owner: &str) -> &str {
    owner.split(':').next().unwrap_or(owner)
}

/// An attempt is final once it is terminal with an outcome a restart does not
/// recover again.
pub(super) fn attempt_state(phase: &str, outcome: Option<&str>) -> OwnerState {
    if phase == "terminal" && !matches!(outcome, Some("interrupted" | "dispatch_uncertain")) {
        OwnerState::Final
    } else {
        OwnerState::Open
    }
}

/// The sessions of `entries` that may go now, by owner prefix.
pub(super) fn releasable(
    entries: &[BenchmarkSessionEntry],
    facts: &Facts,
    now_ms: i64,
) -> BTreeMap<String, Vec<String>> {
    let mut release: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in entries {
        if facts.protected.contains(&entry.session_id) {
            continue;
        }
        let prefix = owner_prefix(&entry.owner_id);
        let go = match facts.owners.get(prefix) {
            Some(OwnerState::Final) => true,
            Some(OwnerState::Open) => false,
            None => chrono::DateTime::parse_from_rfc3339(&entry.last_activity)
                .is_ok_and(|at| now_ms - at.timestamp_millis() >= UNNAMED_GRACE_MS),
        };
        if go {
            release
                .entry(prefix.to_owned())
                .or_default()
                .push(entry.session_id.clone());
        }
    }
    release
}

/// Every `details.sessionId` of a judge vote marked `details.inFlight` in
/// `value`, at any depth.
fn in_flight_sessions(value: &serde_json::Value, found: &mut HashSet<String>) {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(details) = object.get("details") {
                if details["inFlight"] == true {
                    if let Some(session) = details["sessionId"].as_str() {
                        found.insert(session.to_owned());
                    }
                }
            }
            for child in object.values() {
                in_flight_sessions(child, found);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                in_flight_sessions(item, found);
            }
        }
        _ => {}
    }
}

/// What the store says about the attempts and steps `prefixes` name, and the
/// sessions any in-flight judge vote names.
pub(super) async fn facts(store: &Store, prefixes: &[String]) -> Result<Facts> {
    let mut facts = Facts::default();
    for chunk in prefixes.chunks(QUERY_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        let query = format!(
            "SELECT id, phase, json_extract(data_json,'$.outcome') FROM attempts WHERE id IN ({marks})"
        );
        let mut rows = sqlx::query_as::<_, (String, String, Option<String>)>(&query);
        for id in chunk {
            rows = rows.bind(id);
        }
        for (id, phase, outcome) in rows.fetch_all(&store.pool).await? {
            facts
                .owners
                .insert(id, attempt_state(&phase, outcome.as_deref()));
        }
        // A workflow step is done once its root is; a step whose outcome a
        // restart left unknown is recovered from its session first.
        let query = format!(
            "SELECT s.attempt_id, json_extract(s.data_json,'$.outcome'), a.phase, json_extract(a.data_json,'$.outcome') \
             FROM workflow_steps s JOIN attempts a ON a.id = s.root_attempt_id WHERE s.attempt_id IN ({marks})"
        );
        let mut rows =
            sqlx::query_as::<_, (String, Option<String>, String, Option<String>)>(&query);
        for id in chunk {
            rows = rows.bind(id);
        }
        for (id, step_outcome, root_phase, root_outcome) in rows.fetch_all(&store.pool).await? {
            let state = if attempt_state(&root_phase, root_outcome.as_deref()) == OwnerState::Final
                && !matches!(
                    step_outcome.as_deref(),
                    Some("interrupted" | "dispatch_uncertain")
                ) {
                OwnerState::Final
            } else {
                OwnerState::Open
            };
            facts.owners.insert(id, state);
        }
        for table in ["attempts", "workflow_steps"] {
            let key = if table == "attempts" {
                "id"
            } else {
                "attempt_id"
            };
            let query = format!(
                "SELECT json_extract(e.value,'$.details.sessionId') FROM {table} a, json_each(a.data_json,'$.evaluations') e \
                 WHERE a.{key} IN ({marks}) AND json_extract(e.value,'$.details.inFlight') = 1"
            );
            let mut rows = sqlx::query_scalar::<_, Option<String>>(&query);
            for id in chunk {
                rows = rows.bind(id);
            }
            facts
                .protected
                .extend(rows.fetch_all(&store.pool).await?.into_iter().flatten());
        }
    }
    // Qualification panels keep their votes in their record.
    for record in sqlx::query_scalar::<_, String>(
        "SELECT record_json FROM selector_qualifications WHERE record_json LIKE '%\"inFlight\":true%'",
    )
    .fetch_all(&store.pool)
    .await?
    {
        if let Ok(value) = serde_json::from_str(&record) {
            in_flight_sessions(&value, &mut facts.protected);
        }
    }
    Ok(facts)
}

/// The session updates of a sealed record: `events.turnEvents`, or `events`
/// itself in records sealed before the native receipt.
fn transcript_events(
    evidence: &serde_json::Value,
    session_id: &Option<String>,
) -> Vec<serde_json::Value> {
    evidence
        .pointer("/events/turnEvents")
        .or_else(|| evidence.get("events"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|event| {
            event
                .pointer("/update/sessionUpdate")
                .is_some_and(serde_json::Value::is_string)
                && !event.to_string().contains("\"evidenceOnly\":true")
        })
        .map(|event| {
            let mut event = event.clone();
            if event.get("sessionId").is_none() {
                event["sessionId"] = serde_json::json!(session_id);
            }
            event
        })
        .collect()
}

static SWEEPING: AtomicBool = AtomicBool::new(false);
static LAST_SWEEP_MS: AtomicI64 = AtomicI64::new(0);

impl BenchmarkService {
    /// Remove the host sessions of finished attempts. `only` limits the pass
    /// to one attempt and its workflow steps, as its flight ends.
    pub(super) async fn release_settled_sessions(&self, only: Option<&str>) -> Result<PurgeStats> {
        let mut entries = self.backend.settled_sessions().await?;
        if let Some(root) = only {
            let mut names: HashSet<String> = sqlx::query_scalar::<_, String>(
                "SELECT attempt_id FROM workflow_steps WHERE root_attempt_id = ?",
            )
            .bind(root)
            .fetch_all(&self.store.pool)
            .await?
            .into_iter()
            .collect();
            names.insert(root.to_owned());
            entries.retain(|entry| names.contains(owner_prefix(&entry.owner_id)));
        }
        let mut total = PurgeStats::default();
        if entries.is_empty() {
            return Ok(total);
        }
        let prefixes: Vec<String> = entries
            .iter()
            .map(|entry| owner_prefix(&entry.owner_id).to_owned())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let facts = facts(&self.store, &prefixes).await?;
        let release: Vec<_> = releasable(&entries, &facts, now()).into_iter().collect();
        for batch in release.chunks(PURGE_BATCH) {
            // An attempt being evaluated right now may be opening a judge
            // session; the next pass takes its sessions. The others stay
            // unevaluable only while their batch is removed.
            let mut held = Vec::with_capacity(batch.len());
            let mut sessions = Vec::new();
            for (prefix, ids) in batch {
                if let Ok(guard) = super::evaluation_lock(prefix).try_lock_owned() {
                    held.push(guard);
                    sessions.extend(ids.iter().cloned());
                }
            }
            if sessions.is_empty() {
                continue;
            }
            let purged = self.backend.purge_sessions(&sessions).await?;
            total.add(&purged);
            drop(held);
        }
        Ok(total)
    }

    /// [`Self::release_settled_sessions`], logged; a failure keeps the
    /// sessions for the next pass.
    pub(super) async fn release_settled_sessions_logged(&self, only: Option<&str>) {
        match self.release_settled_sessions(only).await {
            Ok(stats) if stats.sessions > 0 => log::info!(
                "[benchmarks] removed {} finished benchmark chat(s): {} event(s), {:.1} MB",
                stats.sessions,
                stats.events,
                stats.bytes as f64 / 1_048_576.0
            ),
            Ok(_) => {}
            Err(error) => log::warn!(
                "[benchmarks] finished benchmark chats kept for the next pass: {}",
                error.message
            ),
        }
    }

    /// The turn of an attempt as its sealed evidence keeps it, in the form a
    /// chat replays its history (`{sessionId, update}`): its session updates,
    /// without the native receipt, the host's terminal record, the
    /// truncation marker or evidence-only events. A workflow's attempt shows
    /// the step its session names.
    pub async fn attempt_transcript(&self, id: &str) -> Result<Vec<serde_json::Value>> {
        let attempt = self.store.attempt(id).await?;
        let mut sealed: Vec<(&str, &str)> = Vec::new();
        if let Some(digest) = attempt.evidence_hash.as_deref() {
            sealed.push((&attempt.id, digest));
        }
        for step in attempt.workflow_steps.iter().rev() {
            if let (Some(_), Some(digest)) = (&step.session_id, &step.evidence_hash) {
                if step.session_id == attempt.session_id {
                    sealed.push((&step.attempt_id, digest));
                }
            }
        }
        let mut failure = "this attempt has no sealed evidence".to_string();
        for (owner, digest) in sealed {
            match super::fixtures::sealed_record(
                &self.store.root,
                &attempt.run_id,
                owner,
                attempt.session_id.as_deref(),
                digest,
            )
            .await
            {
                Ok(evidence) => return Ok(transcript_events(&evidence, &attempt.session_id)),
                Err(error) => failure = error,
            }
        }
        Err(BenchmarkError::new(
            "evidence_missing",
            format!("No sealed transcript: {failure}"),
        ))
    }

    /// Start a full pass in the background unless one runs or one ran within
    /// [`SWEEP_EVERY`]; `force` skips the interval (start).
    pub(super) fn sweep_settled_sessions(self: &Arc<Self>, force: bool) {
        let at = now();
        if !force && at - LAST_SWEEP_MS.load(Ordering::SeqCst) < SWEEP_EVERY.as_millis() as i64 {
            return;
        }
        if SWEEPING.swap(true, Ordering::SeqCst) {
            return;
        }
        LAST_SWEEP_MS.store(at, Ordering::SeqCst);
        let service = Arc::clone(self);
        tokio::spawn(async move {
            service.release_settled_sessions_logged(None).await;
            SWEEPING.store(false, Ordering::SeqCst);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(session: &str, owner: &str, last: &str) -> BenchmarkSessionEntry {
        BenchmarkSessionEntry {
            session_id: session.into(),
            owner_id: owner.into(),
            last_activity: last.into(),
        }
    }

    #[test]
    fn an_attempt_is_final_only_when_terminal_with_a_settled_outcome() {
        assert_eq!(attempt_state("terminal", Some("pass")), OwnerState::Final);
        assert_eq!(attempt_state("terminal", None), OwnerState::Final);
        assert_eq!(
            attempt_state("terminal", Some("interrupted")),
            OwnerState::Open
        );
        assert_eq!(
            attempt_state("terminal", Some("dispatch_uncertain")),
            OwnerState::Open
        );
        for phase in [
            "pending",
            "running",
            "collecting",
            "awaiting_judges",
            "interrupted",
        ] {
            assert_eq!(
                attempt_state(phase, Some("pass")),
                OwnerState::Open,
                "{phase}"
            );
        }
    }

    #[test]
    fn owners_name_their_attempt_before_the_first_colon() {
        assert_eq!(owner_prefix("attempt-1:1790000000000"), "attempt-1");
        assert_eq!(owner_prefix("attempt-1:judge:2:0"), "attempt-1");
        assert_eq!(owner_prefix("inventory:invented"), "inventory");
        assert_eq!(owner_prefix("bare"), "bare");
    }

    #[test]
    fn only_final_attempts_and_idle_unnamed_sessions_are_released() {
        let now_ms = chrono::DateTime::parse_from_rfc3339("2026-10-30T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        let entries = [
            entry("candidate", "done:1", "2026-10-30T11:59:00Z"),
            entry("judge", "done:judge:1:0", "2026-10-30T11:59:30Z"),
            entry("voting", "done:judge:2:0", "2026-10-30T11:59:40Z"),
            entry("open", "running:1", "2026-10-01T00:00:00Z"),
            entry("step", "step-a:1", "2026-10-30T11:58:00Z"),
            entry("old-probe", "inventory:x", "2026-10-30T10:30:00Z"),
            entry("new-probe", "inventory:y", "2026-10-30T11:30:00Z"),
            entry("unreadable", "carrier:judge:0:0", "not a time"),
        ];
        let facts = Facts {
            owners: HashMap::from([
                ("done".into(), OwnerState::Final),
                ("running".into(), OwnerState::Open),
                ("step-a".into(), OwnerState::Final),
            ]),
            protected: HashSet::from(["voting".to_string()]),
        };
        let released = releasable(&entries, &facts, now_ms);
        assert_eq!(
            released,
            BTreeMap::from([
                ("done".into(), vec!["candidate".to_string(), "judge".into()]),
                ("inventory".into(), vec!["old-probe".to_string()]),
                ("step-a".into(), vec!["step".to_string()]),
            ])
        );
    }

    #[test]
    fn a_transcript_keeps_only_the_session_updates_of_the_turn() {
        let update = |kind: &str| serde_json::json!({"sessionUpdate": kind, "content": {"type":"text","text":"x"}});
        let turn = serde_json::json!([
            {"sessionId": "s", "update": update("user_message_chunk")},
            {"update": update("agent_message_chunk")},
            {"sessionId": "s", "update": {"sessionUpdate": "agent_message_chunk", "_meta": {"evidenceOnly": true}}},
            {"evidenceTruncated": {"droppedEvents": 3}},
            {"phase": "terminal"},
        ]);
        let session = Some("s".to_string());
        for evidence in [
            serde_json::json!({"events": {"nativeExecutionReceipt": {}, "turnEvents": turn}}),
            serde_json::json!({"events": turn}),
        ] {
            let events = transcript_events(&evidence, &session);
            assert_eq!(events.len(), 2);
            assert!(events.iter().all(|event| event["sessionId"] == "s"));
            assert_eq!(events[1]["update"]["sessionUpdate"], "agent_message_chunk");
        }
        assert!(transcript_events(&serde_json::json!({}), &session).is_empty());
    }

    #[test]
    fn in_flight_votes_are_found_at_any_depth() {
        let record = serde_json::json!({"controls": [
            {"judgeEvaluations": [
                {"details": {"inFlight": true, "sessionId": "asking"}},
                {"details": {"inFlight": false, "sessionId": "answered"}},
            ]},
            {"judgeEvaluations": [{"details": {"inFlight": true}}]},
        ]});
        let mut found = HashSet::new();
        in_flight_sessions(&record, &mut found);
        assert_eq!(found, HashSet::from(["asking".to_string()]));
    }
}
