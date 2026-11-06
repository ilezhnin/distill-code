//! The Kimi turns its ACP adapter never sends.
//!
//! Kimi Code 2.1's ACP adapter forwards the events of one turn only: the one
//! the prompt it is answering launched (`driverFor(turnId)` in its
//! acp-server). Every other turn the CLI runs in the session stays off ACP:
//! the turns its goal feature starts on its own (`goal_continuation`), task
//! notifications and scheduled jobs, and the answer to a prompt that arrived
//! while a turn was running. The CLI queues such a prompt, answers the
//! request at once with an empty `end_turn` (its prompt channel returns no
//! launch), and runs it later as a turn of its own. A chat therefore saw the
//! agent fall silent while it worked toward its goal, and every question
//! asked meanwhile looked never answered (2026-11-05).
//!
//! The CLI writes every turn to its session record (`wire.jsonl`). The host
//! follows the record of each ordinary Kimi chat and shows those turns as the
//! agent's own continued work, the way it shows Claude's background results.
//!
//! The adapter forwards nothing a subagent does either: an `Agent` call shows
//! as one card until the subagent's answer comes back, however long it works.
//! Each subagent keeps a record of its own beside the main one
//! (`agents/<id>/wire.jsonl`), which the main record announces
//! (`subagent.spawned`). The host follows those too, and shows the tool calls
//! a subagent makes under the call that started it, as Claude Code's adapter
//! shows a subagent's.
//! This module reads the record, translates its events into the ACP updates
//! the adapter sends for the turns it does forward, and decides which turns
//! to show; the router supplies what only it knows (whether a prompt of the
//! chat is running) and delivers the updates.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// The most the follower reads of a record in one look; the rest waits for
/// the next one.
const READ_LIMIT_BYTES: u64 = 8 * 1024 * 1024;
/// A record line longer than this is passed over rather than held in memory.
const LINE_LIMIT_BYTES: usize = 64 * 1024 * 1024;
/// Lines read but not yet handled, which pile up only while a prompt runs.
const PENDING_LIMIT: usize = 200_000;
/// The agent a chat talks to; every other agent of a session is a subagent.
const MAIN_AGENT: &str = "main";
/// The tool through which a Kimi agent starts a subagent.
const AGENT_TOOL: &str = "Agent";
/// Subagent calls remembered until their subagent is announced: more than a
/// turn ever starts at once.
const AGENT_CALL_LIMIT: usize = 256;
/// Subagents followed at once in one chat.
const SUBAGENT_LIMIT: usize = 64;

/// Reads what the CLI appends to a session record, one complete line at a
/// time.
#[derive(Debug)]
pub(super) struct WireReader {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    /// Whether the line being read has outgrown [`LINE_LIMIT_BYTES`].
    oversized: bool,
}

impl WireReader {
    pub(super) fn new(path: PathBuf, offset: u64) -> Self {
        Self {
            path,
            offset,
            partial: Vec::new(),
            oversized: false,
        }
    }

    /// A reader of `path` that starts at its end: what is on it already is
    /// history the chat has.
    pub(super) fn at_end(path: PathBuf) -> Self {
        let offset = std::fs::metadata(&path).map_or(0, |meta| meta.len());
        Self::new(path, offset)
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    /// The lines completed since the last call.
    pub(super) fn read_lines(&mut self) -> Vec<String> {
        let Ok(mut file) = std::fs::File::open(&self.path) else {
            return Vec::new();
        };
        let Ok(len) = file.metadata().map(|meta| meta.len()) else {
            return Vec::new();
        };
        if len < self.offset {
            // The CLI only appends; a shorter record is a new one. What it
            // holds already is not this chat's to replay.
            log::warn!(
                "[agent-host] Kimi session record {} shrank; following it from its end",
                self.path.display()
            );
            self.offset = len;
            self.partial.clear();
            self.oversized = false;
            return Vec::new();
        }
        if len == self.offset || file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut bytes = Vec::new();
        if file
            .take((len - self.offset).min(READ_LIMIT_BYTES))
            .read_to_end(&mut bytes)
            .is_err()
        {
            return Vec::new();
        }
        self.offset += bytes.len() as u64;
        let mut lines = Vec::new();
        let mut start = 0;
        for (index, byte) in bytes.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            if !self.oversized {
                self.partial.extend_from_slice(&bytes[start..index]);
                let line = String::from_utf8_lossy(&self.partial);
                lines.push(line.trim_end_matches('\r').to_string());
            }
            self.partial.clear();
            self.oversized = false;
            start = index + 1;
        }
        if !self.oversized {
            self.partial.extend_from_slice(&bytes[start..]);
            if self.partial.len() > LINE_LIMIT_BYTES {
                log::warn!(
                    "[agent-host] a Kimi session record line in {} is over {LINE_LIMIT_BYTES} bytes; it is not shown",
                    self.path.display()
                );
                self.partial = Vec::new();
                self.oversized = true;
            }
        }
        lines
    }
}

/// One event of a session record, as the chat would see it.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum WireEvent {
    /// A turn begins. `user` when a prompt began it, as opposed to the agent
    /// going on by itself (its goal, a task notification, a scheduled job).
    TurnStarted { turn: String, user: bool },
    /// Something the turn shows, as the `update` of an ACP `session/update`.
    Update { turn: String, update: Value },
    /// The turn is over; `failure` is why, for one that failed.
    TurnEnded {
        turn: String,
        failure: Option<String>,
    },
}

/// The turn id of a record: the CLI writes it as a number on turn records and
/// as a string on loop events.
fn turn_id(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// The ACP tool kind of a Kimi tool, as the adapter infers it.
fn tool_kind(name: &str) -> &'static str {
    match name {
        "Read" | "Glob" | "Grep" => "read",
        "Write" | "Edit" => "edit",
        "Bash" | "Terminal" => "execute",
        "WebFetch" | "WebSearch" => "fetch",
        "Think" => "think",
        _ => "other",
    }
}

/// The absolute path a tool call works on, if it names one.
fn locations(args: &Value, display: &Value) -> Option<Value> {
    let display_path = matches!(display["kind"].as_str(), Some("diff" | "file_io"))
        .then(|| display["path"].as_str())
        .flatten();
    let path = [
        display_path,
        args["file_path"].as_str(),
        args["path"].as_str(),
    ]
    .into_iter()
    .flatten()
    .find(|path| Path::new(path).is_absolute())?;
    Some(json!([{ "path": path }]))
}

/// The diff a display block shows, as the adapter renders it.
fn diff_content(display: &Value) -> Option<Value> {
    let edits = match display["kind"].as_str() {
        Some("diff") => true,
        Some("file_io") => display.get("before").is_some() && display.get("after").is_some(),
        _ => false,
    };
    edits.then(|| {
        json!({
            "type": "diff",
            "path": display["path"],
            "oldText": display["before"],
            "newText": display["after"],
        })
    })
}

/// The plan a to-do display block carries.
fn plan(display: &Value) -> Option<Value> {
    if display["kind"].as_str() != Some("todo_list") {
        return None;
    }
    let entries: Vec<Value> = display["items"]
        .as_array()?
        .iter()
        .map(|item| {
            let status = match item["status"].as_str() {
                Some("in_progress") => "in_progress",
                Some("done" | "completed") => "completed",
                _ => "pending",
            };
            json!({
                "content": item["title"].as_str().unwrap_or_default(),
                "priority": "medium",
                "status": status,
            })
        })
        .collect();
    (!entries.is_empty()).then(|| json!({ "sessionUpdate": "plan", "entries": entries }))
}

fn text_content(text: String) -> Value {
    json!({ "type": "content", "content": { "type": "text", "text": text } })
}

/// Turns session record lines into [`WireEvent`]s. It remembers which turn
/// each running tool call belongs to, since the CLI's result record names
/// the call but not its turn.
#[derive(Debug)]
pub(super) struct Translator {
    /// The agent whose record this is: `main`, or a subagent's id.
    agent: String,
    tool_turns: HashMap<String, String>,
}

impl Default for Translator {
    fn default() -> Self {
        Self::of(MAIN_AGENT)
    }
}

impl Translator {
    pub(super) fn of(agent: &str) -> Self {
        Self {
            agent: agent.to_string(),
            tool_turns: HashMap::new(),
        }
    }

    pub(super) fn events(&mut self, record: &Value) -> Vec<WireEvent> {
        // Each agent keeps its own record; what another agent wrote is not
        // this one's.
        if record
            .get("agentId")
            .and_then(Value::as_str)
            .is_some_and(|agent| agent != self.agent)
        {
            return Vec::new();
        }
        match record["type"].as_str() {
            Some("turn.prompt") => turn_id(&record["turnId"])
                .map(|turn| WireEvent::TurnStarted {
                    turn,
                    user: record["origin"]["kind"].as_str() == Some("user"),
                })
                .into_iter()
                .collect(),
            Some("turn.ended") => {
                let Some(turn) = turn_id(&record["turnId"]) else {
                    return Vec::new();
                };
                self.tool_turns.retain(|_, owner| *owner != turn);
                let failure = (record["reason"].as_str() == Some("failed")).then(|| {
                    record["error"]["message"]
                        .as_str()
                        .map(str::trim)
                        .filter(|message| !message.is_empty())
                        .unwrap_or("The turn failed without a message")
                        .to_string()
                });
                vec![WireEvent::TurnEnded { turn, failure }]
            }
            Some("context.append_loop_event") => self.loop_event(&record["event"]),
            _ => Vec::new(),
        }
    }

    fn loop_event(&mut self, event: &Value) -> Vec<WireEvent> {
        match event["type"].as_str() {
            Some("content.part") => {
                let Some(turn) = turn_id(&event["turnId"]) else {
                    return Vec::new();
                };
                let part = &event["part"];
                let (kind, text) = match part["type"].as_str() {
                    Some("text") => ("agent_message_chunk", part["text"].as_str()),
                    Some("think") => ("agent_thought_chunk", part["think"].as_str()),
                    _ => return Vec::new(),
                };
                let Some(text) = text.filter(|text| !text.is_empty()) else {
                    return Vec::new();
                };
                vec![WireEvent::Update {
                    turn,
                    update: json!({
                        "sessionUpdate": kind,
                        "content": { "type": "text", "text": text },
                    }),
                }]
            }
            Some("tool.call") => {
                let (Some(turn), Some(call)) =
                    (turn_id(&event["turnId"]), event["toolCallId"].as_str())
                else {
                    return Vec::new();
                };
                self.tool_turns.insert(call.to_string(), turn.clone());
                let name = event["name"].as_str().unwrap_or("tool");
                let args = &event["args"];
                let display = &event["display"];
                let mut content: Vec<Value> = diff_content(display).into_iter().collect();
                content.push(text_content(
                    serde_json::to_string(args).unwrap_or_default(),
                ));
                let mut update = json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": format!("{turn}:{call}"),
                    "title": name,
                    "kind": tool_kind(name),
                    "status": "in_progress",
                    "rawInput": args,
                    "content": content,
                });
                if let Some(locations) = locations(args, display) {
                    update["locations"] = locations;
                }
                let mut events = vec![WireEvent::Update {
                    turn: turn.clone(),
                    update,
                }];
                if let Some(plan) = plan(display) {
                    events.push(WireEvent::Update { turn, update: plan });
                }
                events
            }
            Some("tool.result") => {
                let Some(call) = event["toolCallId"].as_str() else {
                    return Vec::new();
                };
                let Some(turn) = self.tool_turns.remove(call) else {
                    return Vec::new();
                };
                let result = &event["result"];
                let output = &result["output"];
                let content: Vec<Value> = match output {
                    Value::Null => Vec::new(),
                    Value::String(text) if text.is_empty() => Vec::new(),
                    Value::String(text) => vec![text_content(text.clone())],
                    other => vec![text_content(other.to_string())],
                };
                let failed = result["isError"].as_bool() == Some(true);
                vec![WireEvent::Update {
                    update: json!({
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": format!("{turn}:{call}"),
                        "status": if failed { "failed" } else { "completed" },
                        "content": content,
                        "rawOutput": output,
                    }),
                    turn,
                }]
            }
            _ => Vec::new(),
        }
    }
}

/// The ACP id of a tool call: the adapter's own `turn:call` for the main
/// agent's, and the same under the subagent's id for a subagent's, whose turn
/// numbers start over.
fn acp_tool_call_id(agent: &str, turn: &str, call: &str) -> String {
    if agent == MAIN_AGENT {
        format!("{turn}:{call}")
    } else {
        format!("{agent}:{turn}:{call}")
    }
}

/// Whether `id` can name a subagent's folder under the session's `agents`.
fn is_agent_folder(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id != MAIN_AGENT
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A subagent of the chat's agent, followed through its own record while it
/// works. Kimi's ACP adapter forwards none of a subagent's work, so a chat
/// whose agent waited on one showed only the call that started it, for as
/// long as the subagent ran (2026-11-06: 36 minutes of an explore subagent
/// hashing asset bundles, with no sign of it in the chat).
#[derive(Debug)]
struct Subagent {
    /// The ACP id of the call that started it.
    parent: String,
    /// The kind of subagent the CLI started (`explore`, `coder`, ...).
    name: Option<String>,
    /// The task it was given, as the call that started it describes it.
    task: Option<String>,
    reader: WireReader,
    translator: Translator,
    /// Its parent's record has said it is over: what remains of its own
    /// record is read once more, and then it is let go of.
    over: bool,
}

impl Subagent {
    fn identity(&self, id: &str) -> Value {
        json!({ "id": id, "name": self.name, "task": self.task })
    }
}

/// The subagents a chat's agent has at work, by id. Moved out of the follower
/// while their records are read off the async runtime.
#[derive(Debug, Default)]
pub(super) struct Subagents(HashMap<String, Subagent>);

impl Subagents {
    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// What each subagent's record gained since the last look.
    pub(super) fn read(&mut self) -> Vec<(String, Vec<String>)> {
        self.0
            .iter_mut()
            .map(|(id, subagent)| (id.clone(), subagent.reader.read_lines()))
            .filter(|(_, lines)| !lines.is_empty())
            .collect()
    }
}

/// A turn the chat shows as the agent's own: its reply's run and message, and
/// the user message it answers or follows.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Shown {
    pub run_id: String,
    pub reply_id: String,
    pub parent: Option<String>,
    /// Whether any of it has been shown yet: a turn that showed nothing and
    /// ended cleanly has nothing to close.
    pub started: bool,
}

/// The turn the follower is in, and whether the chat shows it.
#[derive(Debug, Clone, PartialEq)]
enum Reading {
    Shown(String, Shown),
    /// A turn the ACP adapter forwards itself, or one already under way when
    /// the host began to follow the record.
    Passed(String),
}

/// What the host knows of one Kimi chat's session record and of the turns it
/// shows from it.
#[derive(Debug)]
pub(super) struct KimiFollow {
    pub bridge_session_id: String,
    pub generation: u64,
    /// `None` until the record is found; a new session has none yet.
    pub reader: Option<WireReader>,
    /// When the host began to follow the chat, which tells a record the
    /// CLI created since from one that holds history.
    pub since: std::time::SystemTime,
    /// When the host last looked for a record it had not found.
    pub looked_for: Option<std::time::Instant>,
    pending: VecDeque<String>,
    translator: Translator,
    reading: Option<Reading>,
    /// Prompts the CLI queued instead of running, by the user message each
    /// carries, in the order they were sent. The CLI runs its queue in order,
    /// and a prompt it starts at once only ever finds the queue empty.
    pub queued: VecDeque<String>,
    /// The chat's latest user message, which a turn the agent starts by
    /// itself follows.
    pub latest_message: Option<String>,
    /// `Agent` calls whose subagent the record has not announced yet: the
    /// ACP id of each, by the agent that made the call and the call's id.
    agent_calls: HashMap<(String, String), String>,
    subagents: Subagents,
    /// What the subagents did since the chat was last shown it, in order.
    activity: Vec<Value>,
}

impl KimiFollow {
    pub(super) fn new(bridge_session_id: String, generation: u64) -> Self {
        Self {
            bridge_session_id,
            generation,
            reader: None,
            since: std::time::SystemTime::now(),
            looked_for: None,
            pending: VecDeque::new(),
            translator: Translator::default(),
            reading: None,
            queued: VecDeque::new(),
            latest_message: None,
            agent_calls: HashMap::new(),
            subagents: Subagents::default(),
            activity: Vec::new(),
        }
    }

    /// Lines the reader returned, to be handled in order. What they say of
    /// subagents is noted at once: a subagent works while the prompt that
    /// started it runs, when the turns themselves wait.
    pub(super) fn push_lines(&mut self, lines: Vec<String>) {
        for line in &lines {
            self.note_subagent_line(line);
        }
        self.pending.extend(lines);
        if self.pending.len() > PENDING_LIMIT {
            // Only a prompt running for very long holds lines back, and then
            // they are its own turn's, which the adapter forwards.
            let excess = self.pending.len() - PENDING_LIMIT;
            log::warn!(
                "[agent-host] Kimi session {} held back {excess} record lines too many while a prompt ran; passing them over",
                self.bridge_session_id
            );
            self.pending.drain(..excess);
        }
    }

    fn note_subagent_line(&mut self, line: &str) {
        // Most lines are neither; spare them the parse.
        if !(line.contains("\"subagent.") || line.contains("\"Agent\"")) {
            return;
        }
        if let Ok(record) = serde_json::from_str::<Value>(line) {
            self.note_subagent_record(&record);
        }
    }

    /// Note what a record says of subagents: an `Agent` call, the subagent
    /// the CLI started for one, a subagent that is over.
    fn note_subagent_record(&mut self, record: &Value) {
        match record["type"].as_str() {
            Some("context.append_loop_event") => {
                let event = &record["event"];
                if event["type"].as_str() != Some("tool.call")
                    || event["name"].as_str() != Some(AGENT_TOOL)
                {
                    return;
                }
                let (Some(turn), Some(call)) =
                    (turn_id(&event["turnId"]), event["toolCallId"].as_str())
                else {
                    return;
                };
                let agent = record["agentId"].as_str().unwrap_or(MAIN_AGENT);
                if self.agent_calls.len() >= AGENT_CALL_LIMIT {
                    // Calls whose subagent never came (a refused call) are
                    // all that can pile up.
                    self.agent_calls.clear();
                }
                self.agent_calls.insert(
                    (agent.to_string(), call.to_string()),
                    acp_tool_call_id(agent, &turn, call),
                );
            }
            Some("subagent.spawned") => self.subagent_started(record),
            Some("subagent.completed" | "subagent.failed" | "subagent.cancelled") => {
                if let Some(subagent) = record["subagentId"]
                    .as_str()
                    .and_then(|id| self.subagents.0.get_mut(id))
                {
                    subagent.over = true;
                }
            }
            _ => {}
        }
    }

    /// Follow a subagent the CLI started for an `Agent` call the chat is
    /// shown, and say on that call which subagent it started and for what.
    fn subagent_started(&mut self, record: &Value) {
        let Some(id) = record["subagentId"]
            .as_str()
            .filter(|id| is_agent_folder(id))
        else {
            return;
        };
        let caller = record["parentAgentId"]
            .as_str()
            .or_else(|| record["callerAgentId"].as_str())
            .unwrap_or(MAIN_AGENT);
        let Some(call) = record["parentToolCallId"].as_str() else {
            return;
        };
        // A call made before the host began to follow the record is not
        // known, and neither is the place its work would be shown.
        let Some(parent) = self
            .agent_calls
            .remove(&(caller.to_string(), call.to_string()))
        else {
            return;
        };
        // The main record is `<session>/agents/main/wire.jsonl`; each
        // subagent keeps `<session>/agents/<id>/wire.jsonl` beside it.
        let Some(agents) = self
            .reader
            .as_ref()
            .and_then(|reader| reader.path().parent()?.parent())
        else {
            return;
        };
        if self.subagents.0.contains_key(id) || self.subagents.0.len() >= SUBAGENT_LIMIT {
            return;
        }
        let text = |key: &str| {
            record[key]
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        let subagent = Subagent {
            parent,
            name: text("subagentName"),
            task: text("description"),
            // A subagent's record is new: all of it is its work.
            reader: WireReader::new(agents.join(id).join("wire.jsonl"), 0),
            translator: Translator::of(id),
            over: false,
        };
        self.activity.push(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": subagent.parent,
            "_meta": { "kimiCode": {
                "toolName": AGENT_TOOL,
                "subagent": subagent.identity(id),
            } },
        }));
        self.subagents.0.insert(id.to_string(), subagent);
    }

    /// Whether a subagent of the chat's agent is at work.
    pub(super) fn subagents_at_work(&self) -> bool {
        !self.subagents.is_empty()
    }

    /// The subagents at work, for their records to be read off the async
    /// runtime; they come back through [`Self::subagents_read`].
    pub(super) fn take_subagents(&mut self) -> Subagents {
        std::mem::take(&mut self.subagents)
    }

    /// Take back the subagents [`Self::take_subagents`] lent out, with what
    /// their records gained: each tool call a subagent made becomes one of
    /// the chat's, under the call that started the subagent. What a subagent
    /// says or thinks stays out, as Claude Code's adapter leaves it out: its
    /// answer is the result of that call.
    pub(super) fn subagents_read(
        &mut self,
        subagents: Subagents,
        read: Vec<(String, Vec<String>)>,
    ) {
        for (id, subagent) in subagents.0 {
            self.subagents.0.entry(id).or_insert(subagent);
        }
        for (id, lines) in read {
            for line in lines {
                let Ok(record) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                // A subagent may start subagents of its own.
                self.note_subagent_record(&record);
                let Some(subagent) = self.subagents.0.get_mut(&id) else {
                    break;
                };
                for event in subagent.translator.events(&record) {
                    let WireEvent::Update { mut update, .. } = event else {
                        continue;
                    };
                    if !matches!(
                        update["sessionUpdate"].as_str(),
                        Some("tool_call" | "tool_call_update")
                    ) {
                        continue;
                    }
                    let call = update["toolCallId"].as_str().unwrap_or_default();
                    update["toolCallId"] = json!(format!("{id}:{call}"));
                    update["_meta"]["kimiCode"] = json!({
                        "parentToolCallId": subagent.parent,
                        "subagent": subagent.identity(&id),
                    });
                    self.activity.push(update);
                }
            }
        }
        self.subagents.0.retain(|_, subagent| !subagent.over);
    }

    /// What the subagents did since the last call, in order, for the chat.
    pub(super) fn take_subagent_activity(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.activity)
    }

    /// Make `update` a part of the turn the chat is shown as the agent's own,
    /// if it is shown one: the reply a subagent of that turn works for.
    pub(super) fn stamp_shown(&mut self, update: &mut Value, created: &str) -> bool {
        let Some(Reading::Shown(_, open)) = self.reading.as_mut() else {
            return false;
        };
        open.started = true;
        update["_meta"]["distill"] = Self::stamp(open, created, false);
        true
    }

    /// Whether a turn a prompt began at or after `since_ms` has ended on the
    /// record, as read so far: how a prompt the CLI ran tells itself from one
    /// it queued. Such a turn is held back unread while its prompt runs, so it
    /// is among the pending lines.
    pub(super) fn prompt_turn_ran(&self, since_ms: i64) -> bool {
        super::kimi::ran_prompt_turn_since(self.pending.iter().map(String::as_str), since_ms)
    }

    /// Whether the follower is inside a turn of the record.
    pub(super) fn in_turn(&self) -> bool {
        self.reading.is_some()
    }

    /// The run of the turn the chat is shown, if it is shown one.
    #[cfg(test)]
    pub(super) fn shown_run(&self) -> Option<&Shown> {
        match &self.reading {
            Some(Reading::Shown(_, shown)) => Some(shown),
            _ => None,
        }
    }

    /// The run the chat shows as under way: a shown turn that has shown
    /// something, and so will be closed when it ends.
    pub(super) fn running_reply(&self) -> Option<&str> {
        match &self.reading {
            Some(Reading::Shown(_, shown)) if shown.started => Some(&shown.run_id),
            _ => None,
        }
    }

    /// Stop showing the turn under way: the user stopped it, or the chat let
    /// go of the session. Its reply is closed with the update this returns,
    /// if it showed anything, and the rest of the turn is passed over.
    pub(super) fn stop_shown(&mut self, created: &str) -> Option<Value> {
        let Some(Reading::Shown(turn, shown)) = self.reading.take() else {
            return None;
        };
        self.reading = Some(Reading::Passed(turn));
        shown.started.then(|| Self::closing(&shown, None, created))
    }

    /// Handle the pending lines and return the updates the chat shows, each
    /// already stamped with its reply's identity. `prompt_running` says
    /// whether a prompt of this chat is in flight: a turn a prompt began is
    /// then possibly that prompt's own, which the adapter forwards, so it is
    /// not judged until the prompt has settled (and has said, by settling,
    /// whether the CLI queued it).
    pub(super) fn advance(&mut self, prompt_running: bool) -> Vec<Value> {
        let mut shown = Vec::new();
        while let Some(line) = self.pending.pop_front() {
            let Ok(record) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let created = record["time"]
                .as_i64()
                .and_then(chrono::DateTime::from_timestamp_millis)
                .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                .unwrap_or_else(super::protocol::now_iso);
            let events = self.translator.events(&record);
            if prompt_running
                && events
                    .iter()
                    .any(|event| matches!(event, WireEvent::TurnStarted { user: true, .. }))
            {
                // Read again once the prompt settles; a turn's first record
                // teaches the translator nothing, so reading it twice is safe.
                self.pending.push_front(line);
                break;
            }
            for event in events {
                self.handle(event, &created, &mut shown);
            }
        }
        shown
    }

    fn handle(&mut self, event: WireEvent, created: &str, shown: &mut Vec<Value>) {
        match event {
            WireEvent::TurnStarted { turn, user } => {
                if let Some(Reading::Shown(_, open)) = self.reading.take() {
                    // A turn the record never ended (the CLI stopped).
                    if open.started {
                        shown.push(Self::closing(&open, None, created));
                    }
                }
                // A prompt's turn is shown only for a prompt the CLI queued;
                // any other is the turn the adapter forwards itself.
                let parent = if user {
                    self.queued.pop_front().map(Some)
                } else {
                    Some(self.latest_message.clone())
                };
                self.reading = Some(match parent {
                    Some(parent) => Reading::Shown(
                        turn,
                        Shown {
                            run_id: uuid::Uuid::new_v4().to_string(),
                            reply_id: uuid::Uuid::new_v4().to_string(),
                            parent,
                            started: false,
                        },
                    ),
                    None => Reading::Passed(turn),
                });
            }
            WireEvent::Update { turn, mut update } => {
                let Some(Reading::Shown(current, open)) = self.reading.as_mut() else {
                    return;
                };
                if *current != turn {
                    return;
                }
                open.started = true;
                update["_meta"]["distill"] = Self::stamp(open, created, false);
                shown.push(update);
            }
            WireEvent::TurnEnded { turn, failure } => {
                let current = match &self.reading {
                    Some(Reading::Shown(current, _) | Reading::Passed(current)) => current,
                    None => return,
                };
                if *current != turn {
                    return;
                }
                if let Some(Reading::Shown(_, open)) = self.reading.take() {
                    if open.started || failure.is_some() {
                        shown.push(Self::closing(&open, failure.as_deref(), created));
                    }
                }
            }
        }
    }

    fn stamp(shown: &Shown, created: &str, finished: bool) -> Value {
        let mut stamp = json!({
            "assistantMessageId": shown.reply_id,
            "runId": shown.run_id,
            "created": created,
            "autonomous": true,
            "autonomousFinished": finished,
        });
        if let Some(parent) = &shown.parent {
            stamp["messageId"] = json!(parent);
        }
        stamp
    }

    /// The update that ends a shown turn's reply: the chat's run settles, and
    /// a turn that failed says why, as a prompt's failed turn does.
    fn closing(shown: &Shown, failure: Option<&str>, created: &str) -> Value {
        let mut meta = json!({
            "activeRunId": Value::Null,
            "distill": Self::stamp(shown, created, true),
        });
        if let Some(reason) = failure {
            meta["turnFailed"] = json!({ "reason": format!("Kimi Code: {reason}") });
        }
        json!({ "sessionUpdate": "session_info_update", "_meta": meta })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOAL: &str = r#"{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"Continue working toward the active goal."}],"origin":{"kind":"system_trigger","name":"goal_continuation"},"turnId":12,"time":1800000000000}"#;

    fn user_turn(turn: u64) -> String {
        format!(
            r#"{{"type":"turn.prompt","agentId":"main","input":[{{"type":"text","text":"How far along is the parser?"}}],"origin":{{"kind":"user"}},"promptId":"msg_{turn}","turnId":{turn},"time":1800000001000}}"#
        )
    }

    fn text(turn: u64, text: &str) -> String {
        format!(
            r#"{{"type":"context.append_loop_event","agentId":"main","event":{{"type":"content.part","turnId":"{turn}","step":1,"part":{{"type":"text","text":"{text}"}}}},"time":1800000002000}}"#
        )
    }

    fn ended(turn: u64, reason: &str) -> String {
        format!(
            r#"{{"type":"turn.ended","agentId":"main","turnId":{turn},"reason":"{reason}","time":1800000003000}}"#
        )
    }

    fn follow(lines: &[String], prompt_running: bool, follow: &mut KimiFollow) -> Vec<Value> {
        follow.push_lines(lines.to_vec());
        follow.advance(prompt_running)
    }

    #[test]
    fn a_goal_turn_is_shown_as_the_agents_own_reply_and_closed() {
        let mut state = KimiFollow::new("session_example".into(), 1);
        state.latest_message = Some("user-1".into());
        let think = r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"content.part","turnId":"12","step":1,"part":{"type":"think","think":"Check the tests first.","reasoningKey":"reasoning_content"}},"time":1800000000500}"#;
        let call = r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.call","turnId":"12","step":1,"toolCallId":"tool_a","name":"Read","args":{"path":"C:/work/example/src/lib.rs"},"display":{"kind":"file_io","operation":"read","path":"C:/work/example/src/lib.rs"}},"time":1800000000600}"#;
        let result = r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.result","parentUuid":"u","toolCallId":"tool_a","result":{"output":"fn main() {}","durationMs":3}},"time":1800000000700}"#;
        let updates = follow(
            &[
                GOAL.into(),
                think.into(),
                call.into(),
                result.into(),
                text(12, "The parser handles every fixture."),
                ended(12, "completed"),
            ],
            false,
            &mut state,
        );
        let kinds: Vec<_> = updates
            .iter()
            .map(|update| update["sessionUpdate"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            [
                "agent_thought_chunk",
                "tool_call",
                "tool_call_update",
                "agent_message_chunk",
                "session_info_update"
            ]
        );
        let run = &updates[0]["_meta"]["distill"]["runId"];
        let reply = &updates[0]["_meta"]["distill"]["assistantMessageId"];
        for update in &updates {
            let stamp = &update["_meta"]["distill"];
            assert_eq!(&stamp["runId"], run);
            assert_eq!(&stamp["assistantMessageId"], reply);
            assert_eq!(stamp["messageId"], "user-1");
            assert_eq!(stamp["autonomous"], true);
        }
        assert_eq!(updates[1]["toolCallId"], "12:tool_a");
        assert_eq!(updates[1]["kind"], "read");
        assert_eq!(updates[2]["toolCallId"], "12:tool_a");
        assert_eq!(updates[2]["status"], "completed");
        assert_eq!(updates[2]["content"][0]["content"]["text"], "fn main() {}");
        assert_eq!(
            updates[3]["_meta"]["distill"]["created"],
            "2027-01-15T08:00:02.000Z"
        );
        assert_eq!(updates[4]["_meta"]["distill"]["autonomousFinished"], true);
        assert!(updates[4]["_meta"]["activeRunId"].is_null());
        assert!(!state.in_turn());
    }

    #[test]
    fn a_prompt_the_cli_queued_is_answered_under_its_message() {
        let mut state = KimiFollow::new("session_example".into(), 1);
        state.queued.push_back("user-7".into());
        let updates = follow(
            &[
                user_turn(13),
                text(13, "About half."),
                ended(13, "completed"),
            ],
            false,
            &mut state,
        );
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0]["content"]["text"], "About half.");
        assert_eq!(updates[0]["_meta"]["distill"]["messageId"], "user-7");
        assert!(state.queued.is_empty());
    }

    #[test]
    fn a_prompts_own_turn_waits_for_the_prompt_and_is_left_to_the_adapter() {
        let mut state = KimiFollow::new("session_example".into(), 1);
        let lines = [user_turn(14), text(14, "Done."), ended(14, "completed")];
        // While the prompt runs, nothing of its turn is judged.
        assert!(follow(&lines, true, &mut state).is_empty());
        assert!(!state.in_turn());
        // It settled without the CLI queuing it: the adapter sent the turn.
        assert!(state.advance(false).is_empty());
        assert!(!state.in_turn());
        // A goal turn that follows is shown.
        let updates = follow(
            &[GOAL.into(), text(12, "Next step."), ended(12, "completed")],
            false,
            &mut state,
        );
        assert_eq!(updates.len(), 2);
        assert!(updates[0]["_meta"]["distill"].get("messageId").is_none());
    }

    #[test]
    fn a_prompts_held_back_turn_tells_whether_the_cli_ran_or_queued_it() {
        let mut state = KimiFollow::new("session_example".into(), 1);
        state.latest_message = Some("user-1".into());
        // The prompt went out at 1800000000900, while a goal turn ran: the
        // goal turn is shown, and no turn of the prompt has run.
        follow(&[GOAL.into(), text(12, "Working.")], true, &mut state);
        assert!(!state.prompt_turn_ran(1800000000900));
        // A prompt the CLI ran at once: its turn is held back, and ended.
        let mut ran = KimiFollow::new("session_example".into(), 1);
        follow(
            &[user_turn(14), text(14, "Done."), ended(14, "completed")],
            true,
            &mut ran,
        );
        assert!(ran.prompt_turn_ran(1800000000900));
        // A turn an earlier prompt began before this one went out does not count.
        assert!(!ran.prompt_turn_ran(1800000001001));
    }

    #[test]
    fn goal_turns_run_on_while_a_queued_prompt_is_sent() {
        let mut state = KimiFollow::new("session_example".into(), 1);
        state.latest_message = Some("user-1".into());
        // The agent's own turn is shown even while a prompt is in flight.
        let updates = follow(&[GOAL.into(), text(12, "Working.")], true, &mut state);
        assert_eq!(updates.len(), 1);
        assert!(state.shown_run().is_some());
    }

    #[test]
    fn a_failed_turn_says_why_even_when_it_showed_nothing() {
        let mut state = KimiFollow::new("session_example".into(), 1);
        let failed = r#"{"type":"turn.ended","agentId":"main","turnId":12,"reason":"failed","error":{"message":"429 You have reached your usage limit."},"time":1800000003000}"#;
        let updates = follow(&[GOAL.into(), failed.into()], false, &mut state);
        assert_eq!(updates.len(), 1);
        assert_eq!(
            updates[0]["_meta"]["turnFailed"]["reason"],
            "Kimi Code: 429 You have reached your usage limit."
        );
        // One that ended cleanly having shown nothing leaves no trace.
        let quiet = follow(&[GOAL.into(), ended(12, "cancelled")], false, &mut state);
        assert!(quiet.is_empty());
    }

    #[test]
    fn a_turn_under_way_when_following_began_is_passed_over() {
        let mut state = KimiFollow::new("session_example".into(), 1);
        let updates = follow(
            &[text(11, "Halfway through."), ended(11, "completed")],
            false,
            &mut state,
        );
        assert!(updates.is_empty());
    }

    #[test]
    fn stopping_closes_the_shown_reply_and_passes_over_the_rest() {
        let mut state = KimiFollow::new("session_example".into(), 1);
        follow(&[GOAL.into()], false, &mut state);
        assert!(state.running_reply().is_none());
        follow(&[text(12, "Working.")], false, &mut state);
        assert!(state.running_reply().is_some());
        let closing = state.stop_shown("now").expect("a shown turn");
        assert_eq!(closing["_meta"]["distill"]["autonomousFinished"], true);
        assert!(state.shown_run().is_none());
        let rest = follow(
            &[text(12, "More."), ended(12, "cancelled")],
            false,
            &mut state,
        );
        assert!(rest.is_empty());
        assert!(!state.in_turn());
    }

    #[test]
    fn plans_and_failed_tools_are_shown_as_the_adapter_shows_them() {
        let mut translator = Translator::default();
        let call: Value = serde_json::from_str(r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.call","turnId":"3","toolCallId":"t1","name":"TodoWrite","args":{},"display":{"kind":"todo_list","items":[{"title":"Map the format","status":"done"},{"title":"Write the reader","status":"in_progress"}]}}}"#).unwrap();
        let events = translator.events(&call);
        assert_eq!(events.len(), 2);
        let WireEvent::Update { update, .. } = &events[1] else {
            panic!("a plan update");
        };
        assert_eq!(update["sessionUpdate"], "plan");
        assert_eq!(update["entries"][0]["status"], "completed");
        assert_eq!(update["entries"][1]["status"], "in_progress");
        let result: Value = serde_json::from_str(r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.result","toolCallId":"t1","result":{"output":"denied","isError":true}}}"#).unwrap();
        let WireEvent::Update { update, turn } = &translator.events(&result)[0] else {
            panic!("a tool update");
        };
        assert_eq!(turn, "3");
        assert_eq!(update["status"], "failed");
        // An edit shows its diff first.
        let edit: Value = serde_json::from_str(r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.call","turnId":"3","toolCallId":"t2","name":"Edit","args":{"path":"C:/work/example/a.txt"},"display":{"kind":"file_io","operation":"edit","path":"C:/work/example/a.txt","before":"old","after":"new"}}}"#).unwrap();
        let WireEvent::Update { update, .. } = &translator.events(&edit)[0] else {
            panic!("a tool call");
        };
        assert_eq!(update["kind"], "edit");
        assert_eq!(update["content"][0]["type"], "diff");
        assert_eq!(update["content"][0]["newText"], "new");
        assert_eq!(update["locations"][0]["path"], "C:/work/example/a.txt");
        // A subagent's record is not the chat's.
        let other: Value = serde_json::from_str(
            r#"{"type":"turn.prompt","agentId":"helper","origin":{"kind":"user"},"turnId":1}"#,
        )
        .unwrap();
        assert!(translator.events(&other).is_empty());
    }

    fn append(path: &Path, lines: &[&str]) {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    fn read_subagents(state: &mut KimiFollow) {
        let mut subagents = state.take_subagents();
        let read = subagents.read();
        state.subagents_read(subagents, read);
    }

    const AGENT_CALL: &str = r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.call","turnId":"3","step":3,"toolCallId":"tool_a","name":"Agent","args":{"description":"Audit the backups","subagent_type":"explore","prompt":"Read-only audit."}},"time":1800000000100}"#;
    const SPAWNED: &str = r#"{"type":"subagent.spawned","subagentId":"agent-1","subagentName":"explore","parentToolCallId":"tool_a","parentAgentId":"main","callerAgentId":"main","description":"Audit the backups","runInBackground":false,"time":1800000000200}"#;

    #[test]
    fn a_subagents_tool_calls_are_shown_under_the_call_that_started_it() {
        let dir = tempfile::tempdir().unwrap();
        let agents = dir.path().join("agents");
        std::fs::create_dir_all(agents.join("main")).unwrap();
        std::fs::create_dir_all(agents.join("agent-1")).unwrap();
        let mut state = KimiFollow::new("session_example".into(), 1);
        state.reader = Some(WireReader::new(agents.join("main").join("wire.jsonl"), 0));
        // The prompt's own turn waits while the prompt runs; its subagent
        // does not.
        follow(
            &[user_turn(3), AGENT_CALL.into(), SPAWNED.into()],
            true,
            &mut state,
        );
        assert!(state.subagents_at_work());
        let named = state.take_subagent_activity();
        assert_eq!(named.len(), 1);
        assert_eq!(named[0]["sessionUpdate"], "tool_call_update");
        assert_eq!(named[0]["toolCallId"], "3:tool_a");
        let kimi = &named[0]["_meta"]["kimiCode"];
        assert_eq!(kimi["toolName"], "Agent");
        assert_eq!(kimi["subagent"]["name"], "explore");
        assert_eq!(kimi["subagent"]["task"], "Audit the backups");

        let record = agents.join("agent-1").join("wire.jsonl");
        append(
            &record,
            &[
                r#"{"type":"turn.prompt","agentId":"agent-1","origin":{"kind":"user"},"turnId":0,"time":1800000000300}"#,
                r#"{"type":"context.append_loop_event","agentId":"agent-1","event":{"type":"content.part","turnId":"0","step":1,"part":{"type":"think","think":"Hash the bundles."}},"time":1800000000400}"#,
                r#"{"type":"context.append_loop_event","agentId":"agent-1","event":{"type":"tool.call","turnId":"0","step":1,"toolCallId":"tool_b","name":"Bash","args":{"command":"python hash.py"}},"time":1800000000500}"#,
            ],
        );
        read_subagents(&mut state);
        let started = state.take_subagent_activity();
        assert_eq!(started.len(), 1, "thoughts stay with the subagent");
        assert_eq!(started[0]["sessionUpdate"], "tool_call");
        assert_eq!(started[0]["toolCallId"], "agent-1:0:tool_b");
        assert_eq!(started[0]["kind"], "execute");
        assert_eq!(started[0]["status"], "in_progress");
        let kimi = &started[0]["_meta"]["kimiCode"];
        assert_eq!(kimi["parentToolCallId"], "3:tool_a");
        assert_eq!(kimi["subagent"]["id"], "agent-1");
        assert!(kimi.get("toolName").is_none());

        // It ends: the rest of its record is shown, then it is let go of.
        append(
            &record,
            &[
                r#"{"type":"context.append_loop_event","agentId":"agent-1","event":{"type":"tool.result","toolCallId":"tool_b","result":{"output":"hashed 5000"}},"time":1800000000600}"#,
                r#"{"type":"context.append_loop_event","agentId":"agent-1","event":{"type":"content.part","turnId":"0","step":2,"part":{"type":"text","text":"Done."}},"time":1800000000700}"#,
            ],
        );
        follow(
            &[
                r#"{"type":"subagent.completed","subagentId":"agent-1","time":1800000000800}"#
                    .into(),
            ],
            true,
            &mut state,
        );
        read_subagents(&mut state);
        let finished = state.take_subagent_activity();
        assert_eq!(finished.len(), 1);
        assert_eq!(finished[0]["toolCallId"], "agent-1:0:tool_b");
        assert_eq!(finished[0]["status"], "completed");
        assert!(!state.subagents_at_work());
    }

    #[test]
    fn a_subagent_of_an_unseen_call_is_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = KimiFollow::new("session_example".into(), 1);
        state.reader = Some(WireReader::new(
            dir.path().join("agents").join("main").join("wire.jsonl"),
            0,
        ));
        // Its call came before the host began to follow the record.
        follow(&[SPAWNED.into()], false, &mut state);
        assert!(!state.subagents_at_work());
        assert!(state.take_subagent_activity().is_empty());
        // A subagent id that is no folder name is never a path.
        let escape = SPAWNED.replace("agent-1", "../main");
        follow(&[AGENT_CALL.into(), escape], false, &mut state);
        assert!(!state.subagents_at_work());
    }

    #[test]
    fn subagent_work_joins_the_agents_own_shown_turn() {
        let mut state = KimiFollow::new("session_example".into(), 1);
        state.latest_message = Some("user-1".into());
        let mut update = json!({ "sessionUpdate": "tool_call", "toolCallId": "agent-1:0:t" });
        assert!(!state.stamp_shown(&mut update, "now"));
        follow(&[GOAL.into()], false, &mut state);
        assert!(state.stamp_shown(&mut update, "now"));
        assert_eq!(update["_meta"]["distill"]["messageId"], "user-1");
        assert_eq!(update["_meta"]["distill"]["autonomous"], true);
        // Having shown something, the turn is closed when it ends.
        assert!(state.running_reply().is_some());
    }

    #[test]
    fn the_reader_returns_whole_lines_as_they_are_completed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wire.jsonl");
        std::fs::write(&path, "{\"history\":1}\n").unwrap();
        let mut reader = WireReader::at_end(path.clone());
        assert!(reader.read_lines().is_empty());
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        use std::io::Write;
        file.write_all(b"{\"a\":1}\r\n{\"b\":").unwrap();
        assert_eq!(reader.read_lines(), ["{\"a\":1}"]);
        file.write_all(b"2}\n").unwrap();
        assert_eq!(reader.read_lines(), ["{\"b\":2}"]);
        // A record started over is followed from its new end.
        std::fs::write(&path, "{\"c\":3}\n").unwrap();
        assert!(reader.read_lines().is_empty());
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(b"{\"d\":4}\n").unwrap();
        assert_eq!(reader.read_lines(), ["{\"d\":4}"]);
    }
}
