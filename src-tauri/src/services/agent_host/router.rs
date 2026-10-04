//! The agent host proper: a local WebSocket endpoint speaking ACP to the
//! renderer, routed onto one bridge process per harness, with sessions,
//! history, and settings persisted in SQLite.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use tauri::Manager;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::bridge::{error_text, Bridge, BridgeEvent, SpawnEnv};
use super::execution::{
    self, AccountActivity, ExecutionDispatch, NativeProvider, ObservedSelection, OwnedEventPage,
    OwnedSession, OwnedSessionRequest, OwnedTurnImage, OwnedTurnRequest,
};
use super::ext;
use super::harness::{self, HarnessSpec};
use super::harness_env::build_spawn_env;
use super::legacy_import;
use super::protocol::{self, invalid_params, now_iso, Message};
use super::session_title;
use super::sources::SourceRoots;
use super::store::{ForkBoundary, MessageSide, SessionRecord, SessionStore, SessionTouchUndo};
use crate::services::managed_acp_tools;
use crate::services::provider_accounts;
use crate::services::provider_rate_limits::grok;

/// Each account gets an isolated bridge, including when native session IDs match.
pub(super) fn account_route_key(harness: &str, account_id: Option<&str>) -> String {
    match account_id {
        Some(id) => format!("{harness}\u{1f}{id}"),
        None => harness.to_string(),
    }
}

fn account_validation_id<'a>(
    harness: &str,
    account_id: Option<&'a str>,
) -> Result<Option<&'a str>, Value> {
    if provider_accounts::supports_managed_accounts(harness) && account_id.is_none() {
        return Err(invalid_params("Choose a signed-in account for this chat"));
    }
    Ok(account_id)
}

/// The prompt of an owned turn: the task text first, behind a fixed marker, so
/// a task that starts with `/plan` or `$skill` is never read as a native slash
/// command or skill mention; then the images.
fn owned_prompt_blocks(prompt: &str, images: &[OwnedTurnImage]) -> Vec<Value> {
    let mut blocks = vec![json!({"type":"text","text":format!("Benchmark task:\n{prompt}")})];
    for image in images {
        blocks.push(json!({"type":"image","data":image.data,"mimeType":image.mime_type}));
    }
    blocks
}

/// The `session/prompt` of an owned turn of session `session_id` for owner
/// `owner_id`: its blocks, the owner, and what the `provider`'s profile adds
/// to every prompt (Grok: the task as written, without its wrapper).
fn owned_prompt_params(
    session_id: &str,
    blocks: Vec<Value>,
    owner_id: &str,
    provider: Option<NativeProvider>,
) -> Value {
    let mut meta = provider
        .and_then(NativeProvider::prompt_meta)
        .cloned()
        .unwrap_or_default();
    meta.insert(
        "executionOwner".into(),
        json!({"kind":"benchmark","id":owner_id}),
    );
    json!({"sessionId":session_id,"prompt":blocks,"_meta":meta})
}

/// The error kind an owned turn settles with when its terminal check fails: a
/// broken no-tool policy is its own outcome, any other failure a selection
/// the bridge did not keep.
fn terminal_error_kind(reason: &str) -> &'static str {
    if reason.starts_with("execution_violation:") {
        "execution_violation"
    } else {
        "selection_changed"
    }
}

/// What marks a bridge route as a host-owned benchmark bridge.
const BENCHMARK_ROUTE: &str = "\u{1f}benchmark:";

/// The host-owned benchmark bridge a session is opened on: its profile's
/// route key, its provider, and the longest turn the session may run, which a
/// sign-in the bridge cannot refresh (Grok's) must outlast.
#[derive(Clone, Copy)]
struct OwnedBridge<'a> {
    profile_key: &'a str,
    provider: NativeProvider,
    turn_limit_ms: u64,
}

/// Where owned bridges of every provider run from, under the Distill root
/// `root` (see [`execution::prepare_owned_runtime`]).
fn owned_runtime_root(root: &std::path::Path) -> PathBuf {
    root.join("benchmarks").join("runtime")
}

/// Removes the sign-in copy an owned bridge on `route_key` may have left in
/// its runtime directory under `runtime_root`; nothing for any other route.
fn discard_route_sign_in(runtime_root: &std::path::Path, route_key: &str) -> std::io::Result<()> {
    if !route_key.contains(BENCHMARK_ROUTE) {
        return Ok(());
    }
    let harness_id = route_key.split('\u{1f}').next().unwrap_or_default();
    match NativeProvider::for_harness(harness_id) {
        Some(provider) => {
            execution::discard_owned_sign_in(provider, &runtime_root.join(harness_id))
        }
        None => Ok(()),
    }
}

const SESSION_PAGE_SIZE: i64 = 200;
/// How long a chat has to stay on screen before its agent is woken in the
/// background. Clicking through the list attaches nothing; the prompt path
/// attaches on demand regardless.
const BACKGROUND_ATTACH_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);
/// How long closing a bridge session may take before reopening it anyway.
const BRIDGE_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// How long a bridge no chat is attached to may sit unused before the host
/// shuts it down. Listing a harness's models spawns its bridge, so without a
/// limit every installed harness keeps a process of 35 to 250 MB for the rest
/// of the run whether or not a chat ever uses it. Stopping one costs a fresh
/// spawn and `initialize`, one to three seconds, on the next prompt or model
/// probe that needs it: the window is long enough that moving between chats
/// and pickers keeps the bridge, and short enough that one woken for a model
/// list does not outlive the list by much.
const BRIDGE_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// How often the host looks for idle bridges; one lives at most this much
/// longer than [`BRIDGE_IDLE_TIMEOUT`].
const BRIDGE_REAP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
/// How long an attached chat may go unused before the host lets go of its
/// bridge session. Every chat left on screen for [`BACKGROUND_ATTACH_DELAY`]
/// is attached, and without a limit each one keeps its agent context loaded in
/// the bridge, and keeps that bridge from ever being shut down, for the rest of
/// the run. The price is paid by the next prompt or model change in that chat,
/// which has to resume the bridge session first: one to three seconds, more if
/// the bridge itself was shut down meanwhile. Opening the chat again resumes it
/// in the background instead. Half an hour keeps a conversation with pauses in
/// it attached, and still lets the chats someone merely clicked through go.
const SESSION_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);
const SNIPPET_CHARS: usize = 200;
/// How much of a conversation goes with a chat that moved to another agent
/// (`carryover_block`), in characters: roughly 30k tokens, which every model
/// the harnesses run has room for next to the work it is then asked to do. The
/// newest messages are the ones kept.
const CARRYOVER_BUDGET_CHARS: usize = 120_000;
/// The most one message of it may take, so a single pasted log cannot push the
/// rest of the conversation out of the budget.
const CARRYOVER_MESSAGE_CHARS: usize = 12_000;
/// How a carried-over transcript opens. A bridge that echoes a prompt back
/// without its annotations would otherwise put the last hand-over inside the
/// next one.
const CARRYOVER_OPENING: &str =
    "This conversation was started with a different agent and has been handed over to you.";
/// How long an attach waits for the bridge event loop to catch up with the
/// history the bridge replayed before reporting a failed synchronization.
const EVENT_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// How many streamed updates may wait for their commit before the bridge event
/// loop stops taking new ones and writes what it has. A burst of chunks then
/// costs one transaction instead of one per chunk, and nothing waits longer than
/// the burst.
const APPEND_BATCH_LIMIT: usize = 64;
pub const EXT_PREFIX: &str = "_distill/";

/// The kv row that governs the lazy split of folded model ids
/// (`gpt-5.6-sol[xhigh]` into a model and an effort). See
/// `selection_split_enabled`.
const SELECTION_SPLIT_SCOPE: &str = "migrations";
const SELECTION_SPLIT_KEY: &str = "selection_split";

/// The renderer socket a request arrived on. Its reply goes back there and
/// nowhere else: request ids are per socket (the SDK numbers them from 0 on
/// every connection), so a reply delivered to a later socket would resolve
/// whatever request happens to carry that id there. Once the socket is gone
/// the sender fails and the reply is dropped.
type ReplyTo = mpsc::UnboundedSender<String>;

/// The ids one user turn is recorded under: `message_id` is the user
/// prompt's message, `assistant_message_id` the agent's reply to it, and
/// `run_id` the turn.
#[derive(Clone)]
struct TurnIds {
    run_id: String,
    message_id: String,
    assistant_message_id: String,
}

impl TurnIds {
    fn new() -> Self {
        Self {
            run_id: uuid::Uuid::new_v4().to_string(),
            message_id: uuid::Uuid::new_v4().to_string(),
            assistant_message_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// The ids of a turn the renderer starts. The prompt's message id is the
    /// renderer's own when it names one in `_meta.messageId`, so the message
    /// it already shows and the chunks the host records agree on one id from
    /// the first render — what lets a message be edited in place before any
    /// reload has replayed the host's ids over the renderer's. The name is
    /// taken out of the meta: it is the host's bookkeeping, not the bridge's.
    /// The reply's id and the run's stay the host's, as they always were.
    fn for_prompt(params: &mut Value) -> Self {
        let mut ids = Self::new();
        let named = params
            .get_mut("_meta")
            .and_then(Value::as_object_mut)
            .and_then(|meta| meta.remove("messageId"));
        if let Some(id) = named
            .as_ref()
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.chars().count() <= 128)
        {
            ids.message_id = id.to_string();
        }
        ids
    }
}

struct RunState {
    run_id: String,
    message_id: String,
    assistant_message_id: String,
    agent_text: String,
    saw_agent_message: bool,
    /// Whether the bridge sent *any* `session/update` for this turn. A turn
    /// that produced nothing and then failed never happened, so its prompt is
    /// taken back out of the log instead of sitting there unanswered.
    saw_update: bool,
}

impl RunState {
    fn start(ids: &TurnIds) -> Self {
        Self {
            run_id: ids.run_id.clone(),
            message_id: ids.message_id.clone(),
            assistant_message_id: ids.assistant_message_id.clone(),
            agent_text: String::new(),
            saw_agent_message: false,
            saw_update: false,
        }
    }
}

/// What it takes to undo [`Inner::record_user_prompt`]: the turn the rows
/// belong to, the event rows the prompt was stored as, and the session-list
/// fields its `touch` overwrote. The run id is part of it because the undo is
/// only allowed for the turn it was recorded for — see
/// [`Inner::discard_rejected_prompt`].
struct RecordedPrompt {
    run_id: String,
    event_ids: Vec<i64>,
    undo: SessionTouchUndo,
}

struct QueuedPrompt {
    prompt: Value,
    meta: Value,
    ids: TurnIds,
}

/// A model id with an effort tier folded in, read back as the two values a
/// bridge offers in separate model and effort options (see `apply_model`).
///
/// LEGACY, INBOUND ONLY. The host itself never writes such an id any more;
/// this exists because one can still arrive from an old renderer, an old
/// distillctl client or a stored `sessions.model_id` the lazy split has not
/// reached, and a send must not fail on it. See `split_effort_model` for the
/// condition under which it can go.
#[derive(Debug, PartialEq, Eq)]
struct SplitModel {
    model: String,
    effort_option: String,
    effort: String,
}

/// What putting a bridge session on a model takes. One write is the whole
/// story — the bridge's own model option, the bridge's own model id — and the
/// other two arms exist for bridges and ids that predate it.
#[derive(Debug, PartialEq, Eq)]
enum ModelWrite {
    /// A bridge that offers no model option at all takes the older
    /// `session/set_model`. Only such a bridge may: codex's
    /// `unstable_setSessionModel` requires `model[effort]` and throws on a
    /// base id, so a base id must never reach it.
    SetModel,
    /// One `session/set_config_option` under the bridge's own option id.
    ConfigOption { config_id: String, model: String },
    /// LEGACY INBOUND: an id that still folds an effort into the model's name,
    /// sent as the two values the bridge keeps apart (see `SplitModel`).
    Folded(SplitModel),
}

/// Which of a session's four selections a config option carries. The host
/// classifies by ROLE so it knows what to persist, and then forwards the
/// bridge's own option id and value shape untouched — claude's `effort`,
/// codex's `reasoning_effort` and `fast-mode`, grok's `reasoning_effort`.
/// Renaming them here would take a per-harness table, and a gap in such a
/// table makes a control disappear rather than degrade.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OptionRole {
    Model,
    Effort,
    Fast,
    Other,
}

/// The three model-scoped selections of a session, either as a bridge's own
/// option list says it is set (`selection_from`) or as a chat is meant to run
/// (`apply_selection`). A field is `None` when it was not stated, which is
/// never the same as "off" or "no effort": an answer carrying no options at
/// all teaches nothing, while one that lists options without an effort option
/// says this model has none.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Selection {
    model: Option<String>,
    effort: Option<String>,
    fast: Option<bool>,
}

pub struct SessionRuntime {
    /// The harness and the bridge's own id for this session. Once the runtime
    /// is in a [`SessionTable`] they only change through the table, which
    /// finds a chat by them for every update a bridge streams.
    pub harness: String,
    pub account_id: Option<String>,
    execution_profile: Option<String>,
    pub bridge_session_id: String,
    /// The bridge process that accepted `bridge_session_id`. A later process
    /// for the same harness has never heard of it, and the exit of an earlier
    /// one says nothing about this session.
    generation: u64,
    loading: bool,
    run: Option<RunState>,
    steer_queue: VecDeque<QueuedPrompt>,
    /// `{ modes, models, configOptions }` as last reported by the bridge.
    snapshot: Value,
    has_model_option: bool,
    /// What the bridge would not do when this session was last put on its
    /// selections, as `_meta.substitutions` entries (see `apply_selection`).
    substitutions: Vec<Value>,
    /// When the chat was last used: attached or opened, a turn ending, a
    /// setting written, an update of its transcript arriving. What
    /// [`Inner::session_is_evictable`] measures an idle chat by. A running or
    /// queued turn keeps the chat regardless, so a turn only has to count when
    /// it ends.
    last_active: std::time::Instant,
}

impl SessionRuntime {
    fn route_key(&self) -> String {
        let key = account_route_key(&self.harness, self.account_id.as_deref());
        self.execution_profile.as_ref().map_or_else(
            || key.clone(),
            |profile| format!("{key}\u{1f}benchmark:{profile}"),
        )
    }

    /// Record that the chat is in use now (see the `last_active` field).
    fn touch(&mut self) {
        self.last_active = std::time::Instant::now();
    }

    /// The bridge session calls on this session go to, and the bridge process
    /// that accepted it. There is none while the session is still being
    /// attached: the bridge has not accepted the stored id yet (and may
    /// never), so a caller waits on the attach lock instead of routing at a
    /// session the bridge does not know.
    fn route(&self) -> Option<(String, String, u64)> {
        if self.loading {
            return None;
        }
        Some((
            self.route_key(),
            self.bridge_session_id.clone(),
            self.generation,
        ))
    }

    /// Whether this session was accepted by *that* bridge process. Used when a
    /// bridge exits: only the sessions of the process that died are forgotten,
    /// never those of a replacement that is already serving the same harness.
    fn served_by(&self, harness: &str, generation: u64) -> bool {
        self.route_key() == harness && self.generation == generation
    }

    /// Forget the messages steered into the running turn, and report how many
    /// there were. A queued steer is only persisted and echoed when it is
    /// actually sent, so a sequence the user stopped — or one the bridge cut
    /// short with an error — must drop them instead of starting fresh turns
    /// nobody asked for and recording them as sent.
    fn drop_queued_steers(&mut self) -> usize {
        let dropped = self.steer_queue.len();
        self.steer_queue.clear();
        dropped
    }
}

/// The attached chats' runtimes by host session id, with the reverse index
/// from a bridge's own session id back to the chat.
///
/// The bridge event loop maps every streamed update back to its chat, under
/// the lock this table sits behind. Scanning every runtime for it made each
/// chunk cost more the more chats had been opened, and held up every other
/// caller of the lock meanwhile; the index makes it one lookup.
///
/// The index is right only while a runtime's `harness` and
/// `bridge_session_id` change nowhere but here: through `insert`, `remove`,
/// `retain` and `rebind`.
#[derive(Default)]
struct SessionTable {
    runtimes: HashMap<String, SessionRuntime>,
    /// Harness, then the bridge's session id, to the host session id. Nested
    /// rather than keyed by the pair so a lookup borrows the two strings
    /// instead of building a key for every update.
    by_bridge: HashMap<String, HashMap<String, String>>,
}

#[derive(Default)]
struct ActivityGenerations {
    by_account: HashMap<String, u64>,
}

/// Whether work on `route` counts for `account`. The CLI sign-in identity is
/// the sign-in the user's own chats of that provider run on without an
/// account, so their work counts for it too.
fn activity_scope_matches(route: &str, provider: &str, account: &str) -> bool {
    if account == "*" {
        route == provider || route.starts_with(&format!("{provider}\u{1f}"))
    } else {
        route == account_route_key(provider, Some(account))
            || (route == provider && provider_accounts::is_cli_login_account(provider, account))
    }
}

impl ActivityGenerations {
    fn record(&mut self, provider: &str, account: Option<&str>) {
        let generation = self
            .by_account
            .entry(account_route_key(provider, account))
            .or_default();
        *generation = generation.saturating_add(1);
    }

    fn snapshot(&self, provider: &str, account: &str) -> u64 {
        self.by_account
            .iter()
            .filter(|(route, _)| activity_scope_matches(route, provider, account))
            .fold(0u64, |sum, (_, generation)| sum.saturating_add(*generation))
    }
}

async fn drain_queued_bridge_events(
    events_tx: &mpsc::UnboundedSender<BridgeEvent>,
) -> Result<(), Value> {
    let (ack, drained) = oneshot::channel();
    events_tx
        .send(BridgeEvent::Drained { ack })
        .map_err(|_| protocol::internal("The history writer stopped"))?;
    tokio::time::timeout(EVENT_DRAIN_TIMEOUT, drained)
        .await
        .map_err(|_| {
            protocol::internal("History synchronization timed out; operation was not completed")
        })?
        .map_err(|_| protocol::internal("The history writer stopped before confirming the save"))?
        .map_err(protocol::internal)
}

async fn install_owned_runtime(
    events_tx: &mpsc::UnboundedSender<BridgeEvent>,
    sessions: &Mutex<SessionTable>,
    session_id: String,
    runtime: SessionRuntime,
) -> Result<(), Value> {
    // Replies bypass the notification queue. Finish all setup notifications
    // before the final acknowledged selection becomes an immutable runtime.
    drain_queued_bridge_events(events_tx).await?;
    sessions.lock().await.insert(session_id, runtime);
    Ok(())
}

impl SessionTable {
    fn get(&self, session_id: &str) -> Option<&SessionRuntime> {
        self.runtimes.get(session_id)
    }

    fn get_mut(&mut self, session_id: &str) -> Option<&mut SessionRuntime> {
        self.runtimes.get_mut(session_id)
    }

    fn values(&self) -> impl Iterator<Item = &SessionRuntime> {
        self.runtimes.values()
    }

    fn iter(&self) -> impl Iterator<Item = (&String, &SessionRuntime)> {
        self.runtimes.iter()
    }

    /// The chat a bridge session belongs to. Checked against the runtime it
    /// names, so an index gone stale drops an update rather than handing it
    /// to another chat.
    fn host_session_for(&self, harness: &str, bridge_session_id: &str) -> Option<&str> {
        let session_id = self.by_bridge.get(harness)?.get(bridge_session_id)?;
        self.runtimes
            .get(session_id)
            .filter(|runtime| {
                runtime.route_key() == harness && runtime.bridge_session_id == bridge_session_id
            })
            .map(|_| session_id.as_str())
    }

    fn host_session_for_generation(
        &self,
        harness: &str,
        generation: u64,
        bridge_session_id: &str,
    ) -> Option<&str> {
        let session_id = self.host_session_for(harness, bridge_session_id)?;
        self.runtimes
            .get(session_id)
            .filter(|runtime| runtime.generation == generation)
            .map(|_| session_id)
    }

    /// Register a chat's runtime, replacing whatever it had.
    fn insert(&mut self, session_id: String, runtime: SessionRuntime) {
        self.remove(&session_id);
        Self::index(&mut self.by_bridge, &session_id, &runtime);
        self.runtimes.insert(session_id, runtime);
    }

    fn remove(&mut self, session_id: &str) -> Option<SessionRuntime> {
        let runtime = self.runtimes.remove(session_id)?;
        let Some(bridge_ids) = self.by_bridge.get_mut(&runtime.route_key()) else {
            return Some(runtime);
        };
        if bridge_ids
            .get(&runtime.bridge_session_id)
            .map(String::as_str)
            == Some(session_id)
        {
            bridge_ids.remove(&runtime.bridge_session_id);
            // Two chats on one bridge session is not something the host sets
            // up, but the scan this index replaced still found the other one;
            // so does this. A removal is rare, so the scan costs nothing.
            if let Some((other, _)) = self.runtimes.iter().find(|(_, other)| {
                other.route_key() == runtime.route_key()
                    && other.bridge_session_id == runtime.bridge_session_id
            }) {
                bridge_ids.insert(runtime.bridge_session_id.clone(), other.clone());
            }
        }
        Some(runtime)
    }

    fn retain(&mut self, mut keep: impl FnMut(&SessionRuntime) -> bool) {
        let before = self.runtimes.len();
        self.runtimes.retain(|_, runtime| keep(runtime));
        if self.runtimes.len() == before {
            return;
        }
        self.by_bridge.clear();
        for (session_id, runtime) in &self.runtimes {
            Self::index(&mut self.by_bridge, session_id, runtime);
        }
    }

    /// Point a chat at another bridge session, as an attach that could not
    /// resume the stored one does.
    fn rebind(
        &mut self,
        session_id: &str,
        bridge_session_id: String,
    ) -> Option<&mut SessionRuntime> {
        if self.runtimes.get(session_id)?.bridge_session_id != bridge_session_id {
            let mut runtime = self.remove(session_id)?;
            runtime.bridge_session_id = bridge_session_id;
            self.insert(session_id.to_string(), runtime);
        }
        self.runtimes.get_mut(session_id)
    }

    fn index(
        by_bridge: &mut HashMap<String, HashMap<String, String>>,
        session_id: &str,
        runtime: &SessionRuntime,
    ) {
        by_bridge
            .entry(runtime.route_key())
            .or_default()
            .insert(runtime.bridge_session_id.clone(), session_id.to_string());
    }
}

struct ClientRequest {
    harness: String,
    generation: u64,
    bridge_id: Value,
    method: String,
}

impl ClientRequest {
    fn respond(self, bridge: &Bridge, result: Result<Value, Value>) {
        if bridge.generation() == self.generation {
            bridge.respond(self.bridge_id, result);
        }
    }
}

pub struct Inner {
    pub app: tauri::AppHandle,
    pub store: SessionStore,
    pub roots: SourceRoots,
    ws_url: String,
    bridges: Mutex<HashMap<String, Arc<Bridge>>>,
    /// One lock per harness so two callers never spawn the same bridge twice,
    /// without holding `bridges` while a spawn is in flight.
    spawn_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    sessions: Mutex<SessionTable>,
    frontend: StdMutex<Option<mpsc::UnboundedSender<String>>>,
    /// Requests a bridge made of the client, by the id the renderer was
    /// asked under, including the originating process generation. A response
    /// must never answer the same numeric request ID in a replacement process.
    client_requests: StdMutex<HashMap<u64, ClientRequest>>,
    next_client_request_id: AtomicU64,
    events_tx: mpsc::UnboundedSender<BridgeEvent>,
    spawn_env: Mutex<Option<Arc<SpawnEnv>>>,
    /// One lock per session so a background attach started by `session/load`
    /// and a prompt arriving while it runs never race to attach twice; the
    /// second caller waits and then takes the already-attached fast path.
    attach_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// The session `session/load` answered most recently; a delayed background
    /// attach only proceeds if it is still this one.
    last_loaded: StdMutex<Option<String>>,
    /// Reply text of the throwaway naming sessions `summarize_title` has open,
    /// by `naming_key` (harness and bridge session id).
    naming_replies: StdMutex<HashMap<String, String>>,
    /// Whether the lazy split of folded model ids still runs: 0 not read yet,
    /// 1 on, 2 off. Every session load asks, so the kv row behind it is read
    /// once per run.
    selection_split: AtomicU8,
    shutdown_prepared: AtomicBool,
    owned_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    activity_generations: StdMutex<ActivityGenerations>,
    /// When the sign-in an owned bridge was started with expires, by route,
    /// with the generation of that bridge, for a provider whose sign-in the
    /// bridge cannot refresh (Grok).
    owned_sign_in_expiry: StdMutex<HashMap<String, (u64, i64)>>,
}

/// Tauri-managed handle; the host starts lazily on the first URL request.
pub struct AgentHost {
    inner: Mutex<Option<Arc<Inner>>>,
}

impl Default for AgentHost {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentHost {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub async fn get_or_start(&self, app: &tauri::AppHandle) -> Result<Arc<Inner>, String> {
        let mut guard = self.inner.lock().await;
        if let Some(inner) = guard.as_ref() {
            return Ok(Arc::clone(inner));
        }
        let inner = Inner::start(app.clone()).await?;
        *guard = Some(Arc::clone(&inner));
        Ok(inner)
    }

    pub async fn prepare_shutdown(&self, prepared: bool) -> Result<(), String> {
        let inner = self.inner.lock().await.clone();
        let Some(inner) = inner else {
            return Ok(());
        };
        {
            let sessions = inner.sessions.lock().await;
            if prepared
                && sessions.values().any(|runtime| {
                    runtime.loading || runtime.run.is_some() || !runtime.steer_queue.is_empty()
                })
            {
                return Err(
                    "Wait for active chats to finish or stop them before closing Distill.".into(),
                );
            }
            inner.shutdown_prepared.store(prepared, Ordering::SeqCst);
        }
        if prepared {
            if let Err(error) = inner.drain_bridge_events().await {
                inner.shutdown_prepared.store(false, Ordering::SeqCst);
                return Err(error_text(&error));
            }
        }
        Ok(())
    }

    /// Credential changes may retire an idle account's processes, but cannot
    /// replace credentials underneath a running turn. Chat history stays stored.
    pub async fn prepare_account_change(&self, account_id: &str) -> Result<(), String> {
        let Some(inner) = self.inner.lock().await.clone() else {
            return Ok(());
        };
        let account = provider_accounts::account(&inner.app, account_id)?;
        let key = account_route_key(&account.provider_id, Some(account_id));
        let spawn_lock = Arc::clone(
            inner
                .spawn_locks
                .lock()
                .await
                .entry(key.clone())
                .or_default(),
        );
        let _spawning = spawn_lock.lock().await;
        if inner.bridges.lock().await.iter().any(|(route, bridge)| {
            (route == &key || route.starts_with(&format!("{key}\u{1f}benchmark:")))
                && bridge.in_flight() > 0
        }) {
            return Err(
                "Wait for this account's provider operations before changing credentials".into(),
            );
        }
        let mut sessions = inner.sessions.lock().await;
        if sessions.values().any(|runtime| {
            runtime.account_id.as_deref() == Some(account_id)
                && (runtime.loading || runtime.run.is_some() || !runtime.steer_queue.is_empty())
        }) {
            return Err("Finish or stop this account's active chats before changing its credentials or removing it".into());
        }
        sessions.retain(|runtime| runtime.account_id.as_deref() != Some(account_id));
        drop(sessions);
        inner.bridges.lock().await.retain(|route, bridge| {
            if route == &key || route.starts_with(&format!("{key}{BENCHMARK_ROUTE}")) {
                bridge.kill();
                inner.forget_owned_bridge(route, bridge.generation());
                false
            } else {
                true
            }
        });
        Ok(())
    }

    pub fn shutdown(&self) {
        if let Ok(guard) = self.inner.try_lock() {
            if let Some(inner) = guard.as_ref() {
                inner.kill_bridges();
            }
        }
    }
}

fn legacy_goose_projects_dir() -> Option<PathBuf> {
    // goose kept `<data dir>/Block/goose/data/projects`; carry them over once.
    let base = dirs::data_dir()?;
    Some(
        base.join("Block")
            .join("goose")
            .join("data")
            .join("projects"),
    )
}

impl Inner {
    async fn start(app: tauri::AppHandle) -> Result<Arc<Inner>, String> {
        // Migration and seeding finish before opening any source or database.
        app.state::<crate::services::bundled_skills::BundledSkillsState>()
            .wait_until_ready()
            .await;
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
        let distill_root = crate::services::distill_root::app_root(&app)?;
        if app
            .try_state::<crate::services::e2e_mode::E2eMode>()
            .is_none()
            && std::env::var_os("DISTILL_ROOT").is_none()
        {
            crate::services::root_migration::adopt_sessions(&distill_root, &app_data_dir).await?;
        }
        // A sign-in an owned bridge was starting with when Distill stopped
        // goes now, not with the next Grok benchmark.
        if let Err(error) = execution::discard_left_sign_ins(&owned_runtime_root(&distill_root)) {
            log::warn!("[agent-host] benchmark sign-in copies were not removed: {error}");
        }
        let host_dir = distill_root.join("sessions");
        let store = SessionStore::open(&host_dir.join("agent-host.db")).await?;
        store.reconcile_execution_dispatches().await?;
        let isolated = app
            .try_state::<crate::services::e2e_mode::E2eMode>()
            .is_some()
            || std::env::var_os("DISTILL_ROOT").is_some();
        if !isolated {
            match legacy_import::import_goose_sessions_once(&store).await {
                Ok(0) => {}
                Ok(count) => log::info!("[agent-host] imported {count} goose sessions"),
                Err(error) => log::warn!("[agent-host] goose session import failed: {error}"),
            }
        }
        let roots = SourceRoots {
            projects_dir: distill_root.join("projects"),
            builtin_skills_dir: distill_root.join("skills"),
            root: distill_root,
            compatibility_root: if app
                .try_state::<crate::services::e2e_mode::E2eMode>()
                .is_none()
            {
                dirs::home_dir().map(|home| home.join(".agents"))
            } else {
                None
            },
            legacy_projects_dir: if isolated {
                None
            } else {
                legacy_goose_projects_dir()
            },
        };

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("failed to bind the agent host socket: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("failed to read the agent host port: {error}"))?
            .port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let ws_url = format!("ws://127.0.0.1:{port}/acp?token={token}");

        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            app,
            store,
            roots,
            ws_url,
            bridges: Mutex::new(HashMap::new()),
            spawn_locks: Mutex::new(HashMap::new()),
            sessions: Mutex::new(SessionTable::default()),
            frontend: StdMutex::new(None),
            client_requests: StdMutex::new(HashMap::new()),
            next_client_request_id: AtomicU64::new(1_000_000),
            events_tx,
            spawn_env: Mutex::new(None),
            attach_locks: Mutex::new(HashMap::new()),
            last_loaded: StdMutex::new(None),
            naming_replies: StdMutex::new(HashMap::new()),
            selection_split: AtomicU8::new(0),
            shutdown_prepared: AtomicBool::new(false),
            owned_locks: Mutex::new(HashMap::new()),
            activity_generations: StdMutex::new(ActivityGenerations::default()),
            owned_sign_in_expiry: StdMutex::new(HashMap::new()),
        });

        tokio::spawn(Arc::clone(&inner).accept_loop(listener, token));
        tokio::spawn(Arc::clone(&inner).bridge_event_loop(events_rx));
        tokio::spawn(Self::reap_idle_bridges_periodically(Arc::downgrade(&inner)));
        log::info!("[agent-host] listening on 127.0.0.1:{port}");
        Ok(inner)
    }

    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// Stops every bridge as the app quits, and with each owned one what the
    /// host kept for it: the event loop that would otherwise do that may not
    /// run again. A sign-in a bridge still starting was handed goes too.
    pub fn kill_bridges(&self) {
        if let Ok(bridges) = self.bridges.try_lock() {
            for (route, bridge) in bridges.iter() {
                bridge.kill();
                self.forget_owned_bridge(route, bridge.generation());
            }
        }
        if let Err(error) = crate::services::distill_root::app_root(&self.app).and_then(|root| {
            execution::discard_left_sign_ins(&owned_runtime_root(&root))
                .map_err(|error| error.to_string())
        }) {
            log::warn!("[agent-host] benchmark sign-in copies were not removed: {error}");
        }
    }

    // -----------------------------------------------------------------------
    // Frontend socket

    // The handshake callback's error type is tungstenite's `ErrorResponse`.
    #[allow(clippy::result_large_err)]
    async fn accept_loop(self: Arc<Self>, listener: TcpListener, token: String) {
        let handshakes = Arc::new(tokio::sync::Semaphore::new(16));
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let Ok(permit) = Arc::clone(&handshakes).try_acquire_owned() else {
                continue;
            };
            let host = Arc::clone(&self);
            let expected = token.clone();
            tokio::spawn(async move {
                let ws = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    tokio_tungstenite::accept_hdr_async(
                        stream,
                        move |request: &Request, response: Response| {
                            let query = request.uri().query().unwrap_or("");
                            let authorized = query
                                .split('&')
                                .any(|pair| pair.strip_prefix("token=") == Some(expected.as_str()));
                            if authorized {
                                Ok(response)
                            } else {
                                let mut rejection =
                                    ErrorResponse::new(Some("unauthorized".to_string()));
                                *rejection.status_mut() =
                                    tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
                                Err(rejection)
                            }
                        },
                    ),
                )
                .await;
                drop(permit);
                if let Ok(Ok(ws)) = ws {
                    host.serve_frontend(ws).await;
                }
            });
        }
    }

    async fn serve_frontend(
        self: Arc<Self>,
        ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) {
        let (mut sink, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        // Whatever the previous renderer was asked can no longer be answered.
        let orphaned = self.take_client_requests();
        {
            if let Ok(mut frontend) = self.frontend.lock() {
                *frontend = Some(tx.clone());
            }
        }
        self.answer_orphaned_client_requests(orphaned).await;
        let writer = tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if sink.send(WsMessage::Text(line.into())).await.is_err() {
                    break;
                }
            }
        });
        while let Some(message) = source.next().await {
            match message {
                Ok(WsMessage::Text(text)) => {
                    // One task per frame, deliberately: `session/prompt` runs
                    // for as long as the agent works on the turn, so handling
                    // frames in arrival order would block every other call on
                    // this socket — a `session/cancel`, another chat's prompt —
                    // for that whole turn. The cost is that two frames sent back
                    // to back can reach the bridge in either order; the renderer
                    // serialises the mutations where that matters
                    // (`serializeSessionMutation`), and a cancel that loses the
                    // race is a no-op. Sequencing per *session* inside the host
                    // is the real fix and a design change.
                    let host = Arc::clone(&self);
                    let line = text.to_string();
                    let reply_to = tx.clone();
                    tokio::spawn(async move { host.handle_frontend_line(line, reply_to).await });
                }
                Ok(WsMessage::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
        let was_current = match self.frontend.lock() {
            Ok(mut frontend) => {
                let current = frontend
                    .as_ref()
                    .is_some_and(|current| current.same_channel(&tx));
                if current {
                    *frontend = None;
                }
                current
            }
            Err(_) => false,
        };
        if was_current {
            let orphaned = self.take_client_requests();
            self.answer_orphaned_client_requests(orphaned).await;
        }
        writer.abort();
        log::info!("[agent-host] frontend disconnected");
    }

    pub fn send_to_frontend(&self, line: String) {
        if let Ok(frontend) = self.frontend.lock() {
            if let Some(tx) = frontend.as_ref() {
                let _ = tx.send(line);
            }
        }
    }

    pub fn notify_frontend(&self, method: &str, params: Value) {
        self.send_to_frontend(protocol::notification(method, params));
    }

    /// Answer a request on the socket it arrived on, never on whichever socket
    /// is current when the answer is ready: request ids are numbered per
    /// connection, so the same id belongs to a different request on the next
    /// socket and the answer would resolve that one. A renderer that dropped
    /// the socket has given up on the answer, so it is dropped with it.
    fn reply_on(reply_to: &ReplyTo, method: &str, reply: String) {
        if reply_to.send(reply).is_err() {
            log::debug!("[agent-host] dropped the answer to {method}: its socket is gone");
        }
    }

    async fn handle_frontend_line(self: Arc<Self>, line: String, reply_to: ReplyTo) {
        let Some(message) = protocol::parse(&line) else {
            log::warn!("[agent-host] unparseable frontend message");
            return;
        };
        match message {
            Message::Request { id, method, params } => {
                let result = self.handle_request(&method, params).await;
                let reply = match result {
                    Ok(result) => protocol::response(id, result),
                    Err(error) => protocol::error_response(id, error),
                };
                Self::reply_on(&reply_to, &method, reply);
            }
            Message::Notification { method, params } => {
                self.handle_client_notification(&method, params).await;
            }
            Message::Response { id, result } => {
                self.handle_client_response(id, result).await;
            }
        }
    }

    async fn handle_client_notification(&self, method: &str, params: Value) {
        if let Some(id) = protocol::session_id(&params) {
            if !matches!(self.store.execution_owner(&id).await, Ok(None)) {
                return;
            }
        }
        if method == "session/cancel" {
            if let Some(session_id) = protocol::session_id(&params) {
                // Stop means stop: the messages steered into the turn being
                // cancelled are not started as turns of their own once it
                // returns.
                let dropped = self
                    .sessions
                    .lock()
                    .await
                    .get_mut(&session_id)
                    .map(SessionRuntime::drop_queued_steers)
                    .unwrap_or(0);
                if dropped > 0 {
                    log::info!(
                        "[agent-host] session {session_id} cancelled: dropped {dropped} queued steer(s)"
                    );
                }
                if let Some((bridge, bridge_session_id)) = self.attached_route(&session_id).await {
                    let mut params = params.clone();
                    params["sessionId"] = json!(bridge_session_id);
                    bridge.notify(method, params);
                }
            }
        }
    }

    async fn handle_client_response(&self, id: Value, result: Result<Value, Value>) {
        let mapping = id
            .as_u64()
            .and_then(|key| self.client_requests.lock().ok()?.remove(&key));
        let Some(request) = mapping else {
            log::warn!("[agent-host] response for unknown client request {id}");
            return;
        };
        if let Some(bridge) = self.bridges.lock().await.get(&request.harness) {
            request.respond(bridge, result);
        }
    }

    /// The answer a bridge gets when no renderer can answer its request: a
    /// permission prompt is cancelled (the turn goes on or stops cleanly),
    /// anything else fails instead of leaving the bridge waiting forever.
    fn unanswered_client_request(method: &str) -> Result<Value, Value> {
        if method == "session/request_permission" {
            Ok(json!({ "outcome": { "outcome": "cancelled" } }))
        } else {
            Err(protocol::internal("The app is not connected"))
        }
    }

    /// Every request still waiting on the renderer; taken when the socket it
    /// was sent over is replaced or goes away.
    fn take_client_requests(&self) -> Vec<ClientRequest> {
        match self.client_requests.lock() {
            Ok(mut pending) => pending.drain().map(|(_, request)| request).collect(),
            Err(_) => Vec::new(),
        }
    }

    async fn answer_orphaned_client_requests(&self, orphaned: Vec<ClientRequest>) {
        if orphaned.is_empty() {
            return;
        }
        let bridges = self.bridges.lock().await;
        for request in orphaned {
            if let Some(bridge) = bridges.get(&request.harness) {
                let result = Self::unanswered_client_request(&request.method);
                request.respond(bridge, result);
            }
        }
    }

    async fn handle_request(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, Value> {
        if let Some(id) = protocol::session_id(&params) {
            if self
                .store
                .execution_owner(&id)
                .await
                .map_err(protocol::internal)?
                .is_some()
                && !matches!(
                    method,
                    "session/load"
                        | "session/fork"
                        | "_distill/session/info"
                        | "_distill/session/history"
                        | "_distill/session/history/result"
                        | "_distill/session/messages"
                )
            {
                return Err(invalid_params(
                    "Benchmark evidence is read-only; fork it into an ordinary chat to continue",
                ));
            }
        }
        if let Some(ext_method) = method.strip_prefix(EXT_PREFIX) {
            return ext::handle(self, ext_method, params).await;
        }
        match method {
            "initialize" => Ok(json!({
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
                    "mcpCapabilities": { "http": true, "sse": true },
                    "sessionCapabilities": { "list": {}, "fork": {} }
                },
                "agentInfo": { "name": "distill-host", "version": env!("CARGO_PKG_VERSION") },
                "authMethods": []
            })),
            "authenticate" => Ok(json!({})),
            "session/new" => self.new_session(params).await,
            "session/load" => self.load_session(params).await,
            "session/list" => self.list_sessions(params).await,
            "session/delete" => self.delete_session(params).await,
            "session/fork" => self.fork_session(params).await,
            "session/prompt" => self.prompt(params).await,
            "session/set_config_option" => self.set_config_option(params).await,
            "session/set_mode" | "session/set_model" => self.forward(method, params).await,
            _ => {
                if protocol::session_id(&params).is_some() {
                    self.forward(method, params).await
                } else {
                    Err(protocol::error(
                        protocol::METHOD_NOT_FOUND,
                        format!("Unsupported method {method}"),
                    ))
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Bridges

    async fn spawn_env(&self) -> Arc<SpawnEnv> {
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
    async fn live_bridge(&self, harness_id: &str) -> Option<Arc<Bridge>> {
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
    pub(super) fn resolve_account_id(
        &self,
        harness_id: &str,
        explicit: Option<&str>,
    ) -> Result<Option<String>, Value> {
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

    async fn ensure_account_bridge(
        &self,
        harness_id: &str,
        account_id: Option<&str>,
    ) -> Result<Arc<Bridge>, Value> {
        self.ensure_execution_bridge(harness_id, account_id, None)
            .await
    }

    /// The bridge for `harness_id` and `account_id`, or with `profile` a
    /// separate host-owned benchmark bridge.
    async fn ensure_execution_bridge(
        &self,
        harness_id: &str,
        account_id: Option<&str>,
        profile: Option<OwnedBridge<'_>>,
    ) -> Result<Arc<Bridge>, Value> {
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
        let mut env = match profile {
            Some(owned) => {
                super::harness_env::build_owned_spawn_env(
                    &self.app,
                    owned.provider.inherited_env_keys(),
                )
                .await
            }
            None => (*self.spawn_env().await).clone(),
        };
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
        // When the sign-in this bridge is handed expires (Grok).
        let mut sign_in_expiry = None;
        // The sign-in document an owned Grok starts with, and where it reads
        // it from (written just before the spawn).
        let mut sign_in = None;
        if let Some(OwnedBridge { provider, .. }) = profile {
            // What the profile tells the process; `extra_env` is applied after
            // the managed credential keys are removed, so `CODEX_CONFIG`
            // survives that.
            let (root, dir) = self
                .owned_runtime_dir(harness_id)
                .map_err(protocol::internal)?;
            execution::prepare_owned_runtime(provider, &root, &dir).map_err(protocol::internal)?;
            if provider == NativeProvider::Grok {
                sign_in = Self::owned_grok_sign_in(turn_limit_ms)?.map(|(document, expiry)| {
                    sign_in_expiry = expiry;
                    (
                        root.clone(),
                        execution::OwnedSignIn::path_in(&dir),
                        document,
                    )
                });
            }
            // Kimi runs on the user's own Kimi home, found before the OS home
            // is redirected.
            let cli_home = if provider == NativeProvider::Kimi {
                Some(execution::kimi_home(&env.shell_env).ok_or_else(|| {
                    protocol::internal("capability_missing: the Kimi Code home cannot be located")
                })?)
            } else {
                None
            };
            // Codex starts on the account's own model list without the tools
            // its entries declare.
            let catalog = if provider == NativeProvider::Codex {
                let account = account.as_ref().ok_or_else(|| {
                    protocol::internal("capability_missing: Codex benchmarks need an account")
                })?;
                let home = provider_accounts::account_home(&self.app, account)
                    .map_err(protocol::internal)?;
                Some(
                    execution::prepare_codex_model_catalog(&root, &dir, &account.id, &home)
                        .map_err(protocol::internal)?,
                )
            } else {
                None
            };
            let process_env = provider.process_env(
                &dir,
                cli_home.as_deref(),
                sign_in.as_ref().map(|(_, path, _)| path.as_path()),
                catalog.as_deref(),
            );
            if process_env.iter().any(|(key, _)| key == "USERPROFILE") {
                // The redirected profile must be the only home it can find.
                env.shell_env.retain(|key, _| {
                    !crate::services::env_key::matches(key, "HOMEDRIVE")
                        && !crate::services::env_key::matches(key, "HOMEPATH")
                });
            }
            env.extra_env.extend(process_env);
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
                if profile.is_some() {
                    return Err(protocol::internal(format!(
                        "capability_missing: pinned benchmark bridge cannot be verified: {error}"
                    )));
                }
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
        // Built under the install lock, so the runtime it verifies is the one
        // that starts. Hashing a native CLI the first time takes a moment.
        let owned = match profile {
            Some(OwnedBridge { provider, .. }) => {
                let managed_node = crate::services::managed_node::managed_node_bin_dir(&self.app)
                    .map(|dir| dir.join(if cfg!(windows) { "node.exe" } else { "node" }));
                let native_cli = managed_acp_tools::native_cli_path(&self.app, harness_id);
                let launch_env = env.clone();
                let launch = tokio::task::spawn_blocking(move || {
                    super::bridge::owned_launch(
                        provider,
                        spec,
                        &launch_env,
                        managed_node.as_deref(),
                        native_cli.as_deref(),
                    )
                })
                .await
                .map_err(|error| protocol::internal(error.to_string()))?
                .map_err(protocol::internal)?;
                Some(launch)
            }
            None => None,
        };
        // On disk only until the bridge has answered `initialize`, which is
        // when Grok reads it; dropped on every path out of this function.
        let sign_in_file = sign_in
            .map(|(root, path, document)| execution::OwnedSignIn::write(&root, &path, &document))
            .transpose()
            .map_err(|error| {
                protocol::internal(format!(
                    "capability_missing: the Grok sign-in cannot be handed over: {error}"
                ))
            })?;
        let bridge = Bridge::spawn_scoped(
            spec,
            &env,
            self.events_tx.clone(),
            &route_key,
            owned.as_ref(),
        )
        .await
        .map_err(protocol::internal)?;
        drop(sign_in_file);
        if let Ok(mut expiries) = self.owned_sign_in_expiry.lock() {
            match sign_in_expiry {
                Some(expiry) => expiries.insert(route_key.clone(), (bridge.generation(), expiry)),
                None => expiries.remove(&route_key),
            };
        }
        self.bridges
            .lock()
            .await
            .insert(route_key, Arc::clone(&bridge));
        Ok(bridge)
    }

    /// The live bridge on `route_key`, unless it is an owned bridge whose
    /// sign-in would not outlast a turn of `turn_limit_ms`: that one is shut
    /// down, so the next spawn starts on the sign-in the user's own CLI has
    /// refreshed since. While it still has requests in flight it can be
    /// neither replaced nor trusted with the turn, so the session is refused.
    async fn reusable_bridge(
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
                "capability_missing: the Grok sign-in of the busy benchmark bridge expires within {} minutes",
                grok::benchmark_sign_in_margin_ms(turn_limit_ms).saturating_add(59_999) / 60_000
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

    /// The Distill root and the runtime directory under it that owned bridges
    /// of `harness_id` run from (see [`execution::prepare_owned_runtime`]).
    fn owned_runtime_dir(&self, harness_id: &str) -> Result<(PathBuf, PathBuf), String> {
        let root = crate::services::distill_root::app_root(&self.app)?;
        let dir = owned_runtime_root(&root).join(harness_id);
        Ok((root, dir))
    }

    /// Drops what the host kept for the owned bridge of `generation` on
    /// `route_key` once it is stopped or gone: the expiry of the sign-in it
    /// ran on, and any copy of that sign-in its CLI left in the runtime
    /// directory. Every path that stops one calls this, the idle reaper, a
    /// sign-in replacement, a credential change and app quit as well as its
    /// exit, so no copy outlives the bridge. Nothing for a chat route.
    fn forget_owned_bridge(&self, route_key: &str, generation: u64) {
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
        if let Err(error) = crate::services::distill_root::app_root(&self.app).and_then(|root| {
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
    fn exit_ends_route(live: Option<u64>, exited: u64) -> bool {
        live.is_none_or(|generation| generation == exited)
    }

    /// The user's Grok session for an owned bridge to run on, as
    /// [`grok::benchmark_auth_document`] gives it; `None` when Grok signs in
    /// with `XAI_API_KEY` instead. A session that would not outlast a turn of
    /// `turn_limit_ms` and its slack is refused: the owned process cannot
    /// refresh it.
    fn owned_grok_sign_in(turn_limit_ms: u64) -> Result<Option<(String, Option<i64>)>, Value> {
        let sign_in = grok::benchmark_auth_document().map_err(|error| {
            protocol::internal(format!(
                "capability_missing: the Grok sign-in cannot be read: {error}"
            ))
        })?;
        if sign_in.as_ref().is_some_and(|(_, expiry)| {
            grok::benchmark_sign_in_expiring(
                *expiry,
                chrono::Utc::now().timestamp_millis(),
                turn_limit_ms,
            )
        }) {
            return Err(protocol::internal(format!(
                "capability_missing: the Grok sign-in expires within {} minutes; open a Grok chat so the Grok CLI refreshes it",
                grok::benchmark_sign_in_margin_ms(turn_limit_ms).saturating_add(59_999) / 60_000
            )));
        }
        Ok(sign_in)
    }

    /// Every [`BRIDGE_REAP_INTERVAL`], shut down the bridges nothing is using.
    /// Holds the host weakly, so the task never keeps a host alive on its own
    /// and ends once the host is gone.
    async fn reap_idle_bridges_periodically(host: Weak<Inner>) {
        loop {
            tokio::time::sleep(BRIDGE_REAP_INTERVAL).await;
            let Some(host) = host.upgrade() else {
                return;
            };
            // Chats first: a bridge whose last chat is let go of here is one
            // the reaper may shut down once its own idle window has passed.
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
    async fn evict_idle_sessions(&self) {
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
    async fn release_idle_session(&self, session_id: &str, generation: u64) {
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
    fn session_is_evictable(
        runtime: &SessionRuntime,
        resumable: bool,
        now: std::time::Instant,
    ) -> bool {
        resumable
            && !runtime.loading
            && runtime.run.is_none()
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
    fn resumable_after_release(holder: Option<(u64, bool)>, generation: u64) -> bool {
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
    async fn reap_idle_bridges(&self) {
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
    fn bridge_is_reapable(
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
            .filter(|spec| super::bridge::is_installed(spec, &env))
            .collect()
    }

    /// The one loop that handles every bridge's events, in the order they
    /// arrived. Writing each streamed chunk to SQLite from here is what used to
    /// make every chat's persistence queue behind every other chat's — and made
    /// [`Self::drain_bridge_events`], which every attach and every withdrawn
    /// prompt waits on, wait for that whole backlog. The chunks are therefore
    /// stamped and forwarded to the renderer immediately and committed together
    /// as soon as the loop runs out of queued work, at the latest at the drain
    /// marker or after [`APPEND_BATCH_LIMIT`] of them.
    async fn bridge_event_loop(self: Arc<Self>, mut events: mpsc::UnboundedReceiver<BridgeEvent>) {
        let mut pending: Vec<(String, Value)> = Vec::new();
        loop {
            let event = match events.try_recv() {
                Ok(event) => event,
                Err(mpsc::error::TryRecvError::Empty) => {
                    // Nothing else is waiting: store what the burst produced
                    // before parking on the channel, so a chat is never more
                    // than one idle moment away from being on disk.
                    let _ = self.flush_pending_events(&mut pending).await;
                    tokio::select! {
                        event = events.recv() => match event { Some(event) => event, None => break },
                        _ = tokio::time::sleep(std::time::Duration::from_secs(1)), if !pending.is_empty() => continue,
                    }
                }
                Err(mpsc::error::TryRecvError::Disconnected) => break,
            };
            match event {
                BridgeEvent::Notification {
                    harness,
                    generation,
                    run_id,
                    method,
                    params,
                } => {
                    if let Some(event) = self
                        .on_bridge_notification(
                            &harness,
                            generation,
                            run_id.as_deref(),
                            &method,
                            params,
                        )
                        .await
                    {
                        pending.push(event);
                        if pending.len() >= APPEND_BATCH_LIMIT {
                            let _ = self.flush_pending_events(&mut pending).await;
                        }
                    }
                }
                BridgeEvent::Request {
                    harness,
                    generation,
                    id,
                    method,
                    params,
                } => {
                    self.on_bridge_request(&harness, generation, id, &method, params)
                        .await
                }
                BridgeEvent::Drained { ack } => {
                    // Whoever waits for this marker reads the transcript, the
                    // run state, or both: everything queued before it is now
                    // handled *and* committed.
                    let result = self.flush_pending_events(&mut pending).await;
                    let _ = ack.send(result);
                }
                BridgeEvent::Exited {
                    harness,
                    generation,
                    stopped,
                } => {
                    // A bridge the host shut down itself — idle, or the app
                    // quitting — ended normally. Either way nothing may route
                    // at it any more, so the cleanup below is the same.
                    if stopped {
                        log::info!("[agent-host] {harness} bridge stopped");
                    } else {
                        log::warn!("[agent-host] {harness} bridge exited");
                    }
                    // A replacement bridge may already be running and serving
                    // sessions: only the process that actually died is
                    // forgotten, and only the sessions it was serving. The
                    // rest keep working instead of silently losing the agent's
                    // context on their next prompt.
                    let mut bridges = self.bridges.lock().await;
                    let live = bridges.get(&harness).map(|bridge| bridge.generation());
                    if live == Some(generation) {
                        bridges.remove(&harness);
                    }
                    drop(bridges);
                    if Self::exit_ends_route(live, generation) {
                        self.forget_owned_bridge(&harness, generation);
                    }
                    let mut sessions = self.sessions.lock().await;
                    sessions.retain(|runtime| !runtime.served_by(&harness, generation));
                }
            }
        }
        let _ = self.flush_pending_events(&mut pending).await;
    }

    /// Commit the session updates a burst of events produced. Consecutive
    /// events of one chat go in one transaction; the order they were handled in
    /// is the order the transcript keeps.
    async fn flush_pending_events(&self, pending: &mut Vec<(String, Value)>) -> Result<(), String> {
        Self::persist_pending_events(&self.store, pending, |mut payload, id| {
            Self::stamp_event_id(&mut payload, id);
            self.notify_frontend("session/update", payload);
        })
        .await
    }

    async fn persist_pending_events(
        store: &SessionStore,
        pending: &mut Vec<(String, Value)>,
        mut committed: impl FnMut(Value, i64),
    ) -> Result<(), String> {
        for (session_id, payloads) in Self::group_events_by_session(pending.clone()) {
            let ids = store.append_events(&session_id, &payloads).await.map_err(|error| {
                log::error!("[agent-host] history is not durable for {session_id}; retained for retry: {error}");
                error
            })?;
            pending.drain(..payloads.len());
            for (payload, id) in payloads.into_iter().zip(ids) {
                committed(payload, id);
            }
        }
        Ok(())
    }

    /// Runs of *consecutive* events belonging to the same chat. Two chats
    /// streaming at once interleave, and merging across the interleaving would
    /// reorder the log, so only neighbours are merged.
    fn group_events_by_session(events: Vec<(String, Value)>) -> Vec<(String, Vec<Value>)> {
        let mut grouped: Vec<(String, Vec<Value>)> = Vec::new();
        for (session_id, payload) in events {
            match grouped.last_mut() {
                Some((current, payloads)) if *current == session_id => payloads.push(payload),
                _ => grouped.push((session_id, vec![payload])),
            }
        }
        grouped
    }

    /// Wait until the bridge event loop has handled everything that was
    /// already queued, and has stored it. A `session/load` replays the whole
    /// transcript as notifications into that queue and only then answers; the
    /// replay is swallowed because the session is still `loading`, so the
    /// session must not become live until the loop has actually reached the
    /// marker behind it — otherwise the tail of the replay is persisted a
    /// second time. It is also how a caller that is about to read the
    /// transcript, or a turn's run state, knows the queue holds nothing about
    /// it any more.
    ///
    /// The queue is shared by every bridge, so this waits for other harnesses'
    /// events too — bounded by what the loop does per event, which is stamping
    /// and forwarding, not a database round trip.
    pub(super) async fn drain_bridge_events(&self) -> Result<(), Value> {
        drain_queued_bridge_events(&self.events_tx).await
    }

    /// Map a bridge-side session id back to the host session id: one lookup
    /// in the table's index, whatever the number of attached chats.
    async fn host_session_for(
        &self,
        harness: &str,
        generation: u64,
        bridge_session_id: &str,
    ) -> Option<String> {
        let sessions = self.sessions.lock().await;
        sessions
            .host_session_for_generation(harness, generation, bridge_session_id)
            .map(str::to_string)
    }

    async fn runtime_route(&self, session_id: &str) -> Option<(String, String, u64)> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).and_then(SessionRuntime::route)
    }

    /// Mark an attached chat as in use now; see [`SessionRuntime::touch`].
    async fn touch_session(&self, session_id: &str) {
        if let Some(runtime) = self.sessions.lock().await.get_mut(session_id) {
            runtime.touch();
        }
    }

    /// Handle one notification and report the update the transcript has to
    /// keep, for the loop to commit with the rest of the burst. `None` when
    /// there is nothing to store: a notification that is not a session update,
    /// one of a session nobody is watching, or a replay of history the session
    /// already has.
    async fn on_bridge_notification(
        &self,
        harness: &str,
        generation: u64,
        received_run: Option<&str>,
        method: &str,
        mut params: Value,
    ) -> Option<(String, Value)> {
        // Drain notifications already queued before Exited even if stdout has
        // closed. Liveness is not ownership; a replacement generation is.
        if self.bridges.lock().await.get(harness)?.generation() != generation {
            return None;
        }
        let benchmark = harness.contains("\u{1f}benchmark:");
        // An owned session also keeps grok's other session extension updates:
        // they are evidence, and grok reports its hooks and subagents there.
        let method = if Self::normalize_xai_turn_usage(method, &mut params)
            || (benchmark && Self::is_xai_session_extension(method))
        {
            "session/update"
        } else {
            method
        };
        if method != "session/update" {
            if benchmark {
                return None;
            }
            self.notify_frontend(method, params);
            return None;
        }
        let bridge_session_id = protocol::session_id(&params)?;
        let Some(session_id) = self
            .host_session_for(harness, generation, &bridge_session_id)
            .await
        else {
            // Probe sessions and history replays we asked for are not
            // surfaced to the renderer; a naming session's reply is kept.
            self.capture_naming_reply(harness, &bridge_session_id, &params);
            return None;
        };
        let mut persist = false;
        let mut reconfigured: Option<(Value, Selection)> = None;
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.get_mut(&session_id) {
                if runtime.execution_profile.is_some() {
                    params["update"]["_meta"]["executionOwner"] =
                        runtime.snapshot["_meta"]["executionOwner"].clone();
                    if let Some(violation) = Self::owned_violation(
                        params
                            .pointer("/update/sessionUpdate")
                            .and_then(Value::as_str),
                        runtime.run.is_some(),
                    ) {
                        params["update"]["_meta"]["executionViolation"] = json!(violation);
                    }
                    if params
                        .pointer("/update/sessionUpdate")
                        .and_then(Value::as_str)
                        == Some("usage_update")
                    {
                        let raw = params["update"].clone();
                        params["update"]["_meta"]["benchmarkRawUsage"] = raw;
                    }
                }
                if runtime.loading || runtime.generation != generation {
                    return None;
                }
                if Self::is_turn_update(&params)
                    && (received_run.is_none()
                        || runtime.run.as_ref().map(|run| run.run_id.as_str()) != received_run)
                {
                    return None;
                }
                if runtime.execution_profile.is_none()
                    && (Self::is_command_list_update(&params)
                        || Self::is_failure_state_update(&params)
                        || Self::is_zero_usage_update(&params)
                        || params
                            .pointer("/update/sessionUpdate")
                            .and_then(Value::as_str)
                            == Some("notice"))
                {
                    // Passed on, but neither a part of the turn nor of the
                    // transcript. Notices are explicitly live-only in ACP.
                    drop(sessions);
                    params["sessionId"] = json!(session_id);
                    self.notify_frontend("session/update", params);
                    return None;
                }
                // Only what the conversation is made of counts as use: a
                // bridge restating its command list to every session it has
                // would otherwise keep every chat of it attached for good.
                runtime.touch();
                persist = true;
                if let Some(run) = runtime
                    .run
                    .as_mut()
                    .filter(|run| Some(run.run_id.as_str()) == received_run)
                {
                    Self::stamp_run_update(&mut params, run, &now_iso());
                }
                if let Some(options) = Self::config_option_update(&params) {
                    // A bridge moves these without being asked: claude drops
                    // an effort a model does not offer, and the SDK flips fast
                    // mode back after a cooldown. Until now the host watched
                    // the update go past and kept describing the old state.
                    let selection = Self::selection_from(&options);
                    if runtime.execution_profile.is_some()
                        && selection != Self::selection_from(&runtime.snapshot["configOptions"])
                    {
                        params["update"]["_meta"]["executionViolation"] =
                            json!("native selection changed during owned execution");
                    }
                    runtime.snapshot["configOptions"] = options;
                    runtime.has_model_option = Self::has_model_option(&runtime.snapshot);
                    reconfigured = Some((runtime.snapshot.clone(), selection));
                }
            }
        }
        if let Some((snapshot, selection)) = reconfigured {
            self.store_bridge_selection(&session_id, &snapshot, &selection)
                .await;
        }
        params["sessionId"] = json!(session_id);
        let stored = if persist {
            // A harness title is at best the chat's first prompt echoed back
            // (Claude Code's `summary` falls back to it). It may name a chat
            // nothing has named yet, but must not replace the host's title in
            // the event log or on screen. It is a session-list field, not a log
            // entry, and one arrives per chat rather than per chunk.
            if let Some(title) = Self::agent_title(&params).map(str::to_string) {
                let named = self
                    .store
                    .set_title_if_untitled(&session_id, &title)
                    .await
                    .unwrap_or_else(|error| {
                        log::warn!("[agent-host] failed to store the agent's title: {error}");
                        false
                    });
                if !named {
                    if let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) {
                        update.remove("title");
                    }
                }
            }
            Some((session_id, params.clone()))
        } else {
            None
        };
        if !persist {
            self.notify_frontend("session/update", params);
        }
        stored
    }

    fn stamp_event_id(payload: &mut Value, id: i64) {
        if let Some(update) = payload.get_mut("update").and_then(Value::as_object_mut) {
            let meta = update.entry("_meta").or_insert_with(|| json!({}));
            if !meta.is_object() {
                *meta = json!({});
            }
            if !meta["distill"].is_object() {
                meta["distill"] = json!({});
            }
            meta["distill"]["eventId"] = json!(id);
        }
    }

    /// What an update of an owned session shows the no-tool policy broken by,
    /// if anything: work no single clean answer does, or a mode change while
    /// the turn runs.
    fn owned_violation(update: Option<&str>, running: bool) -> Option<&'static str> {
        match update? {
            "tool_call" | "tool_call_update" => Some("native tool activity in no-tool profile"),
            "plan" => Some("native plan activity in no-tool profile"),
            kind if kind.starts_with("subagent") => {
                Some("native subagent activity in no-tool profile")
            }
            // Grok's hook runs.
            "hook_run_started" | "hook_execution" => {
                Some("native hook activity in no-tool profile")
            }
            "current_mode_update" if running => Some("native mode changed during owned execution"),
            _ => None,
        }
    }

    fn is_turn_update(params: &Value) -> bool {
        matches!(
            params
                .pointer("/update/sessionUpdate")
                .and_then(Value::as_str),
            Some(
                "user_message_chunk"
                    | "agent_message_chunk"
                    | "agent_thought_chunk"
                    | "tool_call"
                    | "tool_call_update"
                    | "plan"
                    | "usage_update"
                    | "message_usage"
            )
        )
    }

    /// Whether `method` is one of grok's per-session extension notifications.
    /// Grok 1.0.40 sends `turn_completed`, retries and its other session
    /// events on `_x.ai/session_notification`; earlier builds sent the turn
    /// on `_x.ai/session/update`, which still carries tool and content
    /// updates.
    fn is_xai_session_extension(method: &str) -> bool {
        matches!(
            method,
            "_x.ai/session/update" | "_x.ai/session_notification"
        )
    }

    /// Rewrites grok's `turn_completed` session extension update into the
    /// standard `message_usage` update, so grok turns reach the usage ledger
    /// the way claude's and codex's do; every other `_x.ai` extension keeps
    /// its raw passthrough. Grok's `inputTokens` includes the cached share,
    /// which `message_usage` counts separately, so the cache is subtracted.
    /// The raw usage stays under `_meta.xaiTurnUsage`: its `costUsdTicks`
    /// (1 USD = 1e10 ticks) is complete only when grok says so, which
    /// benchmarks check before counting it; chats show no cost from it.
    fn normalize_xai_turn_usage(method: &str, params: &mut Value) -> bool {
        if !Self::is_xai_session_extension(method) {
            return false;
        }
        let Some(update) = params.get("update") else {
            return false;
        };
        if update.get("sessionUpdate").and_then(Value::as_str) != Some("turn_completed") {
            return false;
        }
        let Some(usage) = update.get("usage") else {
            return false;
        };
        let read = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        let input = read("inputTokens");
        let output = read("outputTokens");
        let cache_read = read("cachedReadTokens");
        let cache_write = read("cacheCreationTokens");
        if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
            return false;
        }
        let raw = usage.clone();
        params["update"] = json!({
            "sessionUpdate": "message_usage",
            "usage": {
                "inputTokens": input.saturating_sub(cache_read + cache_write),
                "outputTokens": output,
                "cacheReadTokens": cache_read,
                "cacheWriteTokens": cache_write,
                "elapsedMs": read("apiDurationMs"),
            },
            "_meta": { "xaiTurnUsage": raw },
        });
        true
    }

    /// Whether this is an `available_commands_update`: the harness restating
    /// its whole slash-command list. It describes the harness, not the
    /// conversation, and a bridge sends it whenever it likes — grok to every
    /// session each time its skill watcher fires, which a sync job touching
    /// `~/.claude/skills` makes every ten minutes. Kept as events those were 7%
    /// of a transcript store nobody reads them from, replayed on every load;
    /// and one landing in a turn that then failed made the turn look answered.
    fn is_command_list_update(params: &Value) -> bool {
        params
            .get("update")
            .and_then(|update| update.get("sessionUpdate"))
            .and_then(Value::as_str)
            == Some("available_commands_update")
    }

    /// The option list a `config_option_update` carries, as the bridge sent
    /// it. A bridge that sends one sends its whole list (verified on grok, the
    /// only one that notifies a client-initiated write), so it is a complete
    /// statement of the session's configuration; an empty array is not, and
    /// says nothing.
    fn config_option_update(params: &Value) -> Option<Value> {
        let update = params.get("update")?;
        if update.get("sessionUpdate").and_then(Value::as_str) != Some("config_option_update") {
            return None;
        }
        update
            .get("configOptions")
            .filter(|options| options.as_array().is_some_and(|list| !list.is_empty()))
            .cloned()
    }

    /// Record a change a bridge made on its own: the snapshot it now
    /// describes, the effort and fast toggle it just stated — the absence of
    /// either in a full list means the model has none — and the model, which
    /// is only ever written when named, since clearing it would send the next
    /// attach to the harness default.
    async fn store_bridge_selection(
        &self,
        session_id: &str,
        snapshot: &Value,
        selection: &Selection,
    ) {
        if let Err(error) = self.store.set_snapshot(session_id, snapshot).await {
            log::warn!("[agent-host] failed to store the session snapshot: {error}");
        }
        if let Some(model_id) = selection.model.as_deref() {
            if let Err(error) = self.store.set_model(session_id, Some(model_id)).await {
                log::warn!("[agent-host] failed to store the session model: {error}");
            }
        }
        if let Err(error) = self
            .store
            .set_run_settings(session_id, selection.effort.as_deref(), selection.fast)
            .await
        {
            log::warn!("[agent-host] failed to store the session run settings: {error}");
        }
    }

    /// The title a `session_info_update` proposes, when it is one the chat
    /// list should keep (the renderer applies the same filter live).
    fn agent_title(params: &Value) -> Option<&str> {
        let update = params.get("update")?;
        if update.get("sessionUpdate").and_then(Value::as_str) != Some("session_info_update") {
            return None;
        }
        update
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| {
                !title.is_empty() && !title.starts_with(legacy_import::PERSONA_HANDOFF_PREFIX)
            })
    }

    /// Note what a running turn's update adds to the chat snippet and stamp
    /// it with the host's bookkeeping. `messageId` is the user prompt's id,
    /// as it always was; everything but a user chunk also names the reply's
    /// own message, `assistantMessageId`, so a consumer can keep the prompt
    /// and the reply (and consecutive turns) apart.
    fn stamp_run_update(params: &mut Value, run: &mut RunState, created: &str) {
        let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) else {
            return;
        };
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        run.saw_update = true;
        if kind == "agent_message_chunk" {
            run.saw_agent_message = true;
            if let Some(text) = update
                .get("content")
                .and_then(|content| content.get("text"))
                .and_then(Value::as_str)
            {
                if run.agent_text.chars().count() < SNIPPET_CHARS * 2 {
                    run.agent_text.push_str(text);
                }
            }
        }
        let mut distill =
            json!({ "messageId": run.message_id, "runId": run.run_id, "created": created });
        if kind == "compaction_update" {
            // Our replay stamp must not turn an omitted metadata patch into
            // a replacement, or erase the distinction between omission/null.
            let mut patch = json!({});
            if let Some(meta) = update.get("_meta") {
                patch["value"] = meta.clone();
            }
            distill["compactionMetaPatch"] = patch;
        }
        if kind != "user_message_chunk" {
            distill["assistantMessageId"] = json!(run.assistant_message_id);
        }
        let mut meta = update
            .get("_meta")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        meta.insert("distill".to_string(), distill);
        update.insert("_meta".to_string(), Value::Object(meta));
    }

    fn air_session_failure(meta: &Value) -> Option<&Value> {
        let air = meta.pointer("/jetbrains/air")?;
        if air["version"].as_u64().is_none_or(|version| version < 1) {
            return None;
        }
        let failure = air.get("sessionFailure")?;
        (failure["id"].is_string() && failure["revision"].is_u64()).then_some(failure)
    }

    /// AIR failure rows describe provider state; they are not model output.
    /// Extra fields make an update substantive and retain normal bookkeeping.
    fn is_failure_state_update(params: &Value) -> bool {
        let Some(update) = params.get("update").and_then(Value::as_object) else {
            return false;
        };
        update.get("sessionUpdate").and_then(Value::as_str) == Some("session_info_update")
            && update
                .keys()
                .all(|key| key == "sessionUpdate" || key == "_meta")
            && update
                .get("_meta")
                .and_then(Self::air_session_failure)
                .is_some()
    }

    fn is_zero_usage_update(params: &Value) -> bool {
        let Some(update) = params.get("update").and_then(Value::as_object) else {
            return false;
        };
        // Claude reports zero synthetic-message usage before its terminal
        // quota failure. Positive/unknown usage remains fail-closed.
        update.get("sessionUpdate").and_then(Value::as_str) == Some("usage_update")
            && update.get("used").and_then(Value::as_f64) == Some(0.0)
            && update
                .get("cost")
                .is_none_or(|cost| cost["amount"].as_f64() == Some(0.0))
            && update.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "sessionUpdate" | "used" | "size" | "cost" | "_meta"
                )
            })
    }

    fn prompt_response(result: Result<Value, Value>) -> Result<Value, Value> {
        result.and_then(|response| {
            let Some(failure) = response
                .get("_meta")
                .and_then(Self::air_session_failure)
                .filter(|failure| failure["severity"] == "error")
            else {
                return Ok(response);
            };
            // Both pinned Claude/Codex bridges reserve this policy for quota
            // exhaustion. Temporary rate limits offer retry; context and turn
            // budgets offer new_session. Do not infer quota from error prose.
            let quota = failure["category"] == "limit"
                && failure["actions"].as_array().is_some_and(Vec::is_empty);
            Err(protocol::error_with_data(
                protocol::INTERNAL_ERROR,
                failure["title"]
                    .as_str()
                    .unwrap_or("The provider could not complete this turn"),
                json!({
                    "errorKind": if quota { "quota_exhausted" } else { "provider_failure" },
                    "sessionFailure": failure,
                }),
            ))
        })
    }

    async fn on_bridge_request(
        &self,
        harness: &str,
        generation: u64,
        id: Value,
        method: &str,
        mut params: Value,
    ) {
        let Some(origin) = self
            .live_bridge(harness)
            .await
            .filter(|bridge| bridge.generation() == generation)
        else {
            return;
        };
        if harness.contains("\u{1f}benchmark:") && protocol::session_id(&params).is_none() {
            origin.respond(id, Self::unanswered_client_request(method));
            return;
        }
        if let Some(bridge_session_id) = protocol::session_id(&params) {
            if self.is_naming_session(harness, &bridge_session_id) {
                // Nobody sees a naming session, so nothing it asks for is granted.
                {
                    let answer = if method == "session/request_permission" {
                        Ok(json!({ "outcome": { "outcome": "cancelled" } }))
                    } else {
                        Err(protocol::error(
                            protocol::METHOD_NOT_FOUND,
                            format!("{method} is not available to a naming session"),
                        ))
                    };
                    origin.respond(id, answer);
                }
                return;
            }
            if let Some(session_id) = self
                .host_session_for(harness, generation, &bridge_session_id)
                .await
            {
                if harness.contains("\u{1f}benchmark:") {
                    let owner = self
                        .store
                        .execution_owner(&session_id)
                        .await
                        .ok()
                        .flatten()
                        .map(|(owner, _)| owner.owner_id);
                    let event = json!({"sessionId":session_id,"update":{"sessionUpdate":"notice","_meta":{"executionOwner":{"kind":"benchmark","id":owner},"executionViolation":format!("Unexpected native client request: {method}")}}});
                    if let Err(error) = self.store.append_events(&session_id, &[event]).await {
                        log::error!(
                            "[agent-host] cannot retain execution policy violation: {error}"
                        );
                    }
                    origin.respond(id, Self::unanswered_client_request(method));
                    return;
                }
                params["sessionId"] = json!(session_id);
            } else {
                origin.respond(
                    id,
                    Err(invalid_params("Unknown or detached bridge session")),
                );
                return;
            }
        }
        let request_id = self.next_client_request_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut pending) = self.client_requests.lock() {
            pending.insert(
                request_id,
                ClientRequest {
                    harness: harness.to_string(),
                    generation,
                    bridge_id: id.clone(),
                    method: method.to_string(),
                },
            );
        }
        let has_frontend = self.frontend.lock().map(|f| f.is_some()).unwrap_or(false);
        if !has_frontend {
            // Nobody to ask: cancel the request so the bridge does not hang.
            if let Ok(mut pending) = self.client_requests.lock() {
                pending.remove(&request_id);
            }
            origin.respond(id, Self::unanswered_client_request(method));
            return;
        }
        self.send_to_frontend(protocol::request(json!(request_id), method, params));
    }

    // -----------------------------------------------------------------------
    // Sessions

    fn is_model_option(option: &Value) -> bool {
        option.get("id").and_then(Value::as_str) == Some("model")
            || option.get("category").and_then(Value::as_str) == Some("model")
    }

    /// Whether the bridge offers `model_id` in the session's own model list.
    fn lists_model(snapshot: &Value, model_id: &str) -> bool {
        let in_models = snapshot
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .is_some_and(|models| models.iter().any(|model| model["modelId"] == model_id));
        Self::option_lists(snapshot, Self::is_model_option, model_id) || in_models
    }

    /// Whether a select config option picked out by `matches` offers `value`.
    fn option_lists(snapshot: &Value, matches: fn(&Value) -> bool, value: &str) -> bool {
        snapshot["configOptions"].as_array().is_some_and(|options| {
            options
                .iter()
                .filter(|option| matches(option))
                .any(|option| {
                    option["options"].as_array().is_some_and(|choices| {
                        choices.iter().any(|choice| choice["value"] == value)
                    })
                })
        })
    }

    fn is_effort_option(option: &Value) -> bool {
        option.get("category").and_then(Value::as_str) == Some("thought_level")
    }

    /// The role `config_id` plays in an option list the bridge itself sent.
    fn option_role(options: &Value, config_id: &str) -> OptionRole {
        let Some(option) = options["configOptions"].as_array().and_then(|options| {
            options
                .iter()
                .find(|option| option.get("id").and_then(Value::as_str) == Some(config_id))
        }) else {
            return OptionRole::Other;
        };
        if Self::is_model_option(option) {
            OptionRole::Model
        } else if Self::is_effort_option(option) {
            OptionRole::Effort
        } else if Self::is_fast_option(option) {
            OptionRole::Fast
        } else {
            OptionRole::Other
        }
    }

    /// The role a write plays, read from the session's live snapshot and, for
    /// a session whose stored snapshot arrived with no options at all (grok's
    /// cold `session/new`), from the bridge's answer to the write itself.
    fn write_role(snapshot: &Value, answer: &Value, config_id: &str) -> OptionRole {
        match Self::option_role(snapshot, config_id) {
            OptionRole::Other => Self::option_role(answer, config_id),
            role => role,
        }
    }

    /// What the options a bridge answered with say the session is now on. This
    /// is the acknowledgement: a bridge silently clamps an effort to the
    /// model's own default (codex) or drops it to `default` (claude), so what
    /// was asked for is never what gets stored.
    fn selection_from(config_options: &Value) -> Selection {
        let Some(options) = config_options.as_array() else {
            return Selection::default();
        };
        let current = |matches: fn(&Value) -> bool| {
            options
                .iter()
                .find(|option| matches(option))
                .and_then(|option| option.get("currentValue"))
        };
        Selection {
            model: current(Self::is_model_option)
                .and_then(Value::as_str)
                .map(str::to_string),
            effort: current(Self::is_effort_option)
                .and_then(Value::as_str)
                .map(str::to_string),
            fast: current(Self::is_fast_option).and_then(Self::fast_enabled),
        }
    }

    /// A config write on its way to the bridge: the client's own request with
    /// nothing but the session id swapped. The option id and the value shape
    /// are the bridge's own and are never rewritten here — the host classifies
    /// a write by role to know what to store, not to rename it.
    fn forwarded_config_write(params: &Value, bridge_session_id: &str) -> Value {
        let mut forwarded = params.clone();
        forwarded["sessionId"] = json!(bridge_session_id);
        forwarded
    }

    /// The session's effort option as one step of `apply_selection` needs it:
    /// the bridge's own id for it, the value it is on, and whether it offers
    /// the one being asked for. `None` where the model has no effort control
    /// at all, which is a different answer and has to stay different.
    fn effort_state(snapshot: &Value, wanted: &str) -> Option<(String, Option<String>, bool)> {
        let option = snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_effort_option(option))?;
        let id = option.get("id").and_then(Value::as_str)?.to_string();
        let current = option
            .get("currentValue")
            .and_then(Value::as_str)
            .map(str::to_string);
        let offers = option["options"]
            .as_array()
            .is_some_and(|choices| choices.iter().any(|choice| choice["value"] == wanted));
        Some((id, current, offers))
    }

    /// The session's fast toggle the same way: its own id, whether it is on,
    /// and whether it takes a native boolean instead of the on/off select both
    /// live bridges send.
    fn fast_state(snapshot: &Value) -> Option<(String, Option<bool>, bool)> {
        let option = snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_fast_option(option))?;
        let id = option.get("id").and_then(Value::as_str)?.to_string();
        let current = option.get("currentValue").and_then(Self::fast_enabled);
        let boolean = option.get("type").and_then(Value::as_str) == Some("boolean");
        Some((id, current, boolean))
    }

    /// The bridge's own id for the model option, for a write that goes out
    /// under it.
    fn model_option_id(snapshot: &Value) -> &str {
        Self::model_option(snapshot)
            .and_then(|option| option.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("model")
    }

    fn fast_word(enabled: bool) -> &'static str {
        if enabled {
            "on"
        } else {
            "off"
        }
    }

    /// Fold a bridge's answer to one write into the session snapshot, so the
    /// next step reads what the bridge said after this one. An answer carrying
    /// no options — or an empty list — states nothing and changes nothing:
    /// `session/set_model` answers that way.
    fn take_options(snapshot: &mut Value, answer: &Value) {
        let stated = answer
            .get("configOptions")
            .filter(|options| options.as_array().is_some_and(|list| !list.is_empty()));
        if let Some(options) = stated {
            snapshot["configOptions"] = options.clone();
        }
    }

    /// Whether a snapshot a bridge just answered with should replace the one
    /// a session was opened with. Only one that states its options does:
    /// grok's cold `session/new` answers with its models and no
    /// `configOptions` key at all, and storing that leaves the chat's effort
    /// control looking unsupported for good. A stored snapshot that states no
    /// options either has nothing to lose, so a bridge that keeps its models
    /// outside the option list still gets through.
    fn replaces_snapshot(fresh: &Value, stored: &Value) -> bool {
        let states_options = |snapshot: &Value| {
            snapshot["configOptions"]
                .as_array()
                .is_some_and(|options| !options.is_empty())
        };
        states_options(fresh) || !states_options(stored)
    }

    /// One selection a bridge would not take as a `_meta.substitutions` entry:
    /// what was asked for, what the session is actually on — `null` where the
    /// model has no such control at all — and why. This is the only
    /// machine-readable record of a downgrade there is: codex clamps an effort
    /// to the target model's own default and claude drops it to `default`,
    /// neither of them saying so anywhere else.
    fn substitution(role: &str, requested: &str, applied: Option<&str>, reason: String) -> Value {
        json!({ "role": role, "requested": requested, "applied": applied, "reason": reason })
    }

    /// A presented snapshot carrying what the bridge would not do. Merged into
    /// `_meta` rather than set, since the callers name the provider there too.
    fn with_substitutions(mut presented: Value, substitutions: &[Value]) -> Value {
        if substitutions.is_empty() {
            return presented;
        }
        let mut meta = presented
            .get("_meta")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        meta.insert("substitutions".to_string(), json!(substitutions));
        presented["_meta"] = Value::Object(meta);
        presented
    }

    /// A fast toggle's value in either shape a bridge sends it: the on/off
    /// select both live bridges use, or the native boolean an ACP client that
    /// advertises the capability would get.
    fn fast_enabled(value: &Value) -> Option<bool> {
        match value {
            Value::Bool(enabled) => Some(*enabled),
            Value::String(text) => match text.as_str() {
                "on" | "true" | "enabled" => Some(true),
                "off" | "false" | "disabled" => Some(false),
                _ => None,
            },
            _ => None,
        }
    }

    /// `gpt-5.6-luna[low]` as the model and effort values a bridge offers in
    /// separate options instead; `None` when its model option offers the id
    /// itself, or does not offer both halves.
    ///
    /// LEGACY TOLERANCE, READ ONLY. Distill no longer names a model this way:
    /// the four selections travel separately and the renderer, the store and
    /// every answer carry the bridge's own base id. What still arrives folded
    /// is history — a chat stored before the split whose lazy conversion has
    /// not run, a renderer or a distillctl client older than protocolVersion 6 —
    /// and it reaches `apply_model` inside a send, where failing is not an
    /// option. SUNSET: this and `SplitModel` may go once no
    /// `sessions.legacy_model_id` rows remain and no pre-protocolVersion-6
    /// distillctl client is in use. Not a date: removing it earlier loses the
    /// operator's own history.
    fn split_effort_model(snapshot: &Value, model_id: &str) -> Option<SplitModel> {
        if Self::option_lists(snapshot, Self::is_model_option, model_id) {
            return None;
        }
        let (model, effort) = model_id.strip_suffix(']')?.split_once('[')?;
        if !Self::option_lists(snapshot, Self::is_model_option, model)
            || !Self::option_lists(snapshot, Self::is_effort_option, effort)
        {
            return None;
        }
        let effort_option = snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_effort_option(option))?
            .get("id")?
            .as_str()?;
        Some(SplitModel {
            model: model.to_string(),
            effort_option: effort_option.to_string(),
            effort: effort.to_string(),
        })
    }

    /// Whether moving a session to `model_id` means reopening its bridge
    /// session on that model: one the harness runs only that way, and not in
    /// the bridge's own list.
    fn opens_on_model(harness_id: &str, snapshot: &Value, model_id: &str) -> bool {
        harness::harness(harness_id)
            .and_then(|spec| harness::session_model_meta(spec, model_id))
            .is_some()
            && !Self::lists_model(snapshot, model_id)
    }

    /// Put a session on a model its bridge runs only when a session is opened
    /// on it: close the bridge session and open it again on that model, which
    /// resumes its history. Refused while a turn runs, since reopening would
    /// cut it off.
    async fn reopen_on_model(
        self: &Arc<Self>,
        session_id: &str,
        model_id: &str,
    ) -> Result<Value, Value> {
        let lock = self.attach_lock(session_id).await;
        let _reopening = lock.lock().await;
        let running = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .is_some_and(|runtime| runtime.run.is_some());
        if running {
            return Err(invalid_params(
                "The model cannot change while a turn is running",
            ));
        }
        if let Some((bridge, bridge_session_id)) = self.attached_route(session_id).await {
            let closed = tokio::time::timeout(
                BRIDGE_CLOSE_TIMEOUT,
                bridge.request("session/close", json!({ "sessionId": bridge_session_id })),
            )
            .await;
            if !matches!(closed, Ok(Ok(_))) {
                log::info!(
                    "[agent-host] session {session_id} did not close cleanly before reopening"
                );
            }
        }
        self.sessions.lock().await.remove(session_id);
        self.store
            .set_model(session_id, Some(model_id))
            .await
            .map_err(protocol::internal)?;
        let record = self.session_record(session_id).await?;
        // The attach opens the new bridge session on the model and puts the
        // chat's effort and fast mode back on it, so the reopen keeps all
        // three rather than only the one that was clicked.
        self.attach_session_locked(&record).await?;
        let sessions = self.sessions.lock().await;
        let runtime = sessions
            .get(session_id)
            .ok_or_else(|| protocol::internal("session vanished"))?;
        Ok(Self::with_substitutions(
            Self::presented_snapshot(&record.harness, &runtime.snapshot, runtime.has_model_option),
            &runtime.substitutions,
        ))
    }

    fn naming_key(harness: &str, bridge_session_id: &str) -> String {
        format!("{harness}\u{0}{bridge_session_id}")
    }

    /// Whether a bridge session is one `summarize_title` has open.
    fn is_naming_session(&self, harness: &str, bridge_session_id: &str) -> bool {
        self.naming_replies.lock().is_ok_and(|replies| {
            replies.contains_key(&Self::naming_key(harness, bridge_session_id))
        })
    }

    fn snapshot_from(result: &Value) -> Value {
        json!({
            "modes": result.get("modes").cloned().unwrap_or(Value::Null),
            "models": result.get("models").cloned().unwrap_or(Value::Null),
            "configOptions": result.get("configOptions").cloned().unwrap_or(Value::Array(vec![])),
        })
    }

    fn has_model_option(snapshot: &Value) -> bool {
        snapshot["configOptions"]
            .as_array()
            .map(|options| {
                options.iter().any(|option| {
                    option.get("id").and_then(Value::as_str) == Some("model")
                        || option.get("category").and_then(Value::as_str) == Some("model")
                })
            })
            .unwrap_or(false)
    }

    /// The model a session is on. The `model` config option's own value comes
    /// first and `models.currentModelId` is only the fallback for a bridge
    /// with no such option: a bridge that keeps both may name the model in its
    /// `models` block with the effort folded in (codex reports
    /// `gpt-6-astra[xhigh]` there while its option says `gpt-6-astra`), and
    /// that folded name is a display id the option itself refuses. Reading it
    /// first is how it used to reach `sessions.model_id`.
    fn current_model(snapshot: &Value) -> Option<String> {
        Self::model_option(snapshot)
            .and_then(|option| option.get("currentValue"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                snapshot
                    .pointer("/models/currentModelId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
    }

    /// The renderer reads the active provider and model out of select config
    /// options. Bridges expose neither a provider option nor (always) a model
    /// option, so synthesize them from what we know.
    ///
    /// Nothing the bridge did state is renamed on the way out: a model is
    /// presented under the id its own bridge gave it, with its effort left in
    /// the effort option where the bridge keeps it. The host used to fold the
    /// two into `gpt-5.6-luna[low]` here, which made an effort click read as a
    /// model change all the way up the stack.
    fn presented_snapshot(harness: &str, snapshot: &Value, has_model_option: bool) -> Value {
        let spec_label = harness::harness(harness)
            .map(|spec| spec.label)
            .unwrap_or(harness);
        let mut options: Vec<Value> = snapshot["configOptions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        options.retain(|option| option.get("id").and_then(Value::as_str) != Some("provider"));
        let provider_option = json!({
            "id": "provider",
            "name": "Agent",
            "category": "provider",
            "type": "select",
            "currentValue": harness,
            "options": [{ "value": harness, "name": spec_label }],
        });
        let mut presented = vec![provider_option];
        if !has_model_option {
            if let Some(models) = snapshot.get("models").filter(|models| !models.is_null()) {
                let current = models.get("currentModelId").cloned().unwrap_or(Value::Null);
                let choices: Vec<Value> = models["availableModels"]
                    .as_array()
                    .map(|list| {
                        list.iter()
                            .map(|model| {
                                json!({
                                    "value": model.get("modelId").cloned().unwrap_or(Value::Null),
                                    "name": model.get("name").cloned().unwrap_or(model.get("modelId").cloned().unwrap_or(Value::Null)),
                                    "description": model.get("description").cloned().unwrap_or(Value::Null),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                presented.push(json!({
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": current,
                    "options": choices,
                }));
            }
        }
        presented.extend(options);
        let mut out = snapshot.clone();
        out["configOptions"] = Value::Array(presented);
        out
    }

    async fn mcp_servers(&self, requested: &Value) -> Vec<Value> {
        let mut servers: Vec<Value> = requested.as_array().cloned().unwrap_or_default();
        match self.store.mcp_list().await {
            Ok(records) => {
                for record in records.into_iter().filter(|record| record.enabled) {
                    if let Some(server) = ext::mcp_server_from_extension(&record.config) {
                        servers.push(server);
                    }
                }
            }
            Err(error) => log::warn!("[agent-host] failed to read MCP servers: {error}"),
        }
        servers
    }

    async fn agent_mode(&self) -> String {
        self.store
            .kv_get("settings", "agentMode")
            .await
            .ok()
            .flatten()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| harness::DEFAULT_AGENT_MODE.to_string())
    }

    async fn apply_mode(&self, bridge: &Bridge, spec: &HarnessSpec, bridge_session_id: &str) {
        let mode = self.agent_mode().await;
        if let Some(bridge_mode) = harness::bridge_mode(spec, &mode) {
            if let Err(error) = bridge
                .request(
                    "session/set_mode",
                    json!({ "sessionId": bridge_session_id, "modeId": bridge_mode }),
                )
                .await
            {
                log::warn!(
                    "[agent-host] failed to set {} mode {bridge_mode}: {}",
                    spec.id,
                    error_text(&error)
                );
            }
        }
    }

    fn meta_string(params: &Value, key: &str) -> Option<String> {
        params
            .pointer(&format!("/_meta/{key}"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// The three model-scoped selections a caller can name when a chat is
    /// created, in the `_meta` of `session/new` — the renderer's pending
    /// selection, or the chat a fork was taken from. Each is optional: a chat
    /// nobody chose for opens on whatever its harness starts with.
    fn wanted_from_meta(params: &Value) -> Selection {
        Selection {
            model: Self::meta_string(params, "model"),
            effort: Self::meta_string(params, "reasoningEffort"),
            fast: params.pointer("/_meta/fastMode").and_then(Value::as_bool),
        }
    }

    async fn new_session(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        if self.shutdown_prepared.load(Ordering::SeqCst) {
            return Err(protocol::internal("Distill is closing"));
        }
        let harness_id = Self::meta_string(&params, "provider").ok_or_else(|| {
            invalid_params("session/new requires _meta.provider (the agent harness id)")
        })?;
        let spec = harness::harness(&harness_id)
            .ok_or_else(|| invalid_params(format!("Unknown harness {harness_id}")))?;
        let account_id = self.resolve_account_id(
            &harness_id,
            Self::meta_string(&params, "accountId").as_deref(),
        )?;
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| invalid_params("session/new requires cwd"))?;
        let mcp_servers = self.mcp_servers(&params["mcpServers"]).await;
        // A model this harness runs only in a session opened on it decides how
        // the session is opened; every other one is written afterwards.
        let wanted = Self::wanted_from_meta(&params);
        let open_meta = wanted
            .model
            .as_deref()
            .and_then(|model_id| harness::session_model_meta(spec, model_id));
        let (bridge, bridge_session_id, mut snapshot) = self
            .open_bridge_session(
                spec,
                account_id.as_deref(),
                &cwd,
                mcp_servers,
                open_meta.as_ref(),
            )
            .await?;
        // Native session ids are local to each account's process/home.
        let session_id = uuid::Uuid::new_v4().to_string();
        let substitutions = self
            .apply_to_session(
                &harness_id,
                &bridge,
                &bridge_session_id,
                &mut snapshot,
                &wanted,
                open_meta.is_some(),
            )
            .await;
        let acknowledged = Self::selection_from(&snapshot["configOptions"]);
        let has_model_option = Self::has_model_option(&snapshot);
        let now = now_iso();
        let record = SessionRecord {
            id: session_id.clone(),
            harness: harness_id.clone(),
            account_id: account_id.clone(),
            bridge_session_id: Some(bridge_session_id.clone()),
            cwd: cwd.clone(),
            title: None,
            user_set_name: false,
            project_id: Self::meta_string(&params, "projectId"),
            persona_id: Self::meta_string(&params, "personaId"),
            model_id: Self::current_model(&snapshot),
            // Only a choice made for this chat is stored. The effort a fresh
            // session opens on is the harness's own (claude and codex both
            // seed it from the operator's settings file), so a chat nobody
            // chose an effort for keeps none — and what is kept is what the
            // bridge acknowledged, never what was asked for.
            reasoning_effort: wanted.effort.and(acknowledged.effort),
            fast_mode: wanted.fast.and(acknowledged.fast),
            legacy_model_id: None,
            hidden: params
                .pointer("/_meta/hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            created_at: now.clone(),
            updated_at: now,
            last_message_at: None,
            archived_at: None,
            message_count: 0,
            last_snippet: None,
            snapshot: Some(snapshot.clone()),
        };
        let mut sessions = self.sessions.lock().await;
        if self.shutdown_prepared.load(Ordering::SeqCst) {
            drop(sessions);
            bridge.close_session(&bridge_session_id).await;
            return Err(protocol::internal("Distill is closing"));
        }
        if let Err(error) = self.store.insert_session(&record).await {
            // There is no chat to reach it through, so the session the bridge
            // just opened for us is unreachable: hand it back instead of
            // leaving the agent holding it until the process exits.
            drop(sessions);
            bridge.close_session(&bridge_session_id).await;
            return Err(protocol::internal(error));
        }
        sessions.insert(
            session_id.clone(),
            SessionRuntime {
                harness: harness_id.clone(),
                account_id: account_id.clone(),
                execution_profile: None,
                bridge_session_id,
                generation: bridge.generation(),
                loading: false,
                run: None,
                steer_queue: VecDeque::new(),
                snapshot: snapshot.clone(),
                has_model_option,
                substitutions: substitutions.clone(),
                last_active: std::time::Instant::now(),
            },
        );
        let mut response = Self::presented_snapshot(&harness_id, &snapshot, has_model_option);
        response["sessionId"] = json!(session_id);
        response["_meta"] = json!({
            "providerId": harness_id,
            "accountId": account_id,
            "modelId": record.model_id,
            "reasoningEffort": record.reasoning_effort,
            "fastMode": record.fast_mode,
        });
        Ok(Self::with_substitutions(response, &substitutions))
    }

    /// Start a fresh session on `spec`'s bridge in `cwd` with the configured
    /// agent mode applied, opened on a model through `open_meta` where the
    /// harness runs one only that way. Returns the bridge process that
    /// accepted it, the bridge's session id and the snapshot the bridge
    /// answered with.
    async fn open_bridge_session(
        &self,
        spec: &HarnessSpec,
        account_id: Option<&str>,
        cwd: &str,
        mcp_servers: Vec<Value>,
        open_meta: Option<&Value>,
    ) -> Result<(Arc<Bridge>, String, Value), Value> {
        let bridge = self.ensure_account_bridge(spec.id, account_id).await?;
        let mut params = json!({ "cwd": cwd, "mcpServers": mcp_servers });
        if let Some(meta) = open_meta {
            params["_meta"] = meta.clone();
        }
        let result = bridge.request("session/new", params).await?;
        let bridge_session_id = protocol::session_id(&result)
            .ok_or_else(|| protocol::internal("bridge returned no sessionId"))?;
        self.apply_mode(&bridge, spec, &bridge_session_id).await;
        Ok((bridge, bridge_session_id, Self::snapshot_from(&result)))
    }

    /// The per-session lock that serializes attaching a session to a bridge
    /// and moving it to another harness.
    async fn attach_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        Arc::clone(
            self.attach_locks
                .lock()
                .await
                .entry(session_id.to_string())
                .or_default(),
        )
    }

    /// Make sure a stored session has a live bridge session behind it,
    /// (re)attaching after a bridge restart or an app restart.
    async fn attach_session(
        self: &Arc<Self>,
        record: &SessionRecord,
    ) -> Result<(Arc<Bridge>, String), Value> {
        let lock = self.attach_lock(&record.id).await;
        let _attaching = lock.lock().await;
        let current = self.session_record(&record.id).await?;
        if self.shutdown_prepared.load(Ordering::SeqCst) || current.archived_at.is_some() {
            return Err(invalid_params("Session is archived or Distill is closing"));
        }
        if let Some(attached) = self.attached_route(&record.id).await {
            // Every caller is about to use the session. Marked under the
            // attach lock, which `release_idle_session` takes too, so the chat
            // cannot be let go of between this answer and that use.
            self.touch_session(&record.id).await;
            return Ok(attached);
        }
        if self
            .store
            .execution_owner(&record.id)
            .await
            .map_err(protocol::internal)?
            .is_some()
        {
            return Err(protocol::internal(
                "dispatch_uncertain: owned session runtime is unavailable; no automatic reopen",
            ));
        }
        // The caller's copy may predate a move to another harness made while
        // it waited for the lock (a delayed background attach, say); attach
        // what the store holds now.
        self.attach_session_locked(&current).await
    }

    /// The live bridge behind a session, when it is already attached and the
    /// bridge process it was attached to is still the one running. Never
    /// attaches.
    async fn attached_route(&self, session_id: &str) -> Option<(Arc<Bridge>, String)> {
        // Never hold the session map while waiting for the bridge map: the
        // bridge event loop needs the session map for every update it routes.
        let (harness, bridge_session_id, generation) = self.runtime_route(session_id).await?;
        let bridge = self.live_bridge(&harness).await?;
        // A replacement bridge is running: it never accepted this session id,
        // so the session has to be attached again instead of being routed at a
        // process that would answer "unknown session".
        if bridge.generation() != generation {
            return None;
        }
        Some((bridge, bridge_session_id))
    }

    async fn attach_session_locked(
        self: &Arc<Self>,
        record: &SessionRecord,
    ) -> Result<(Arc<Bridge>, String), Value> {
        let spec = harness::harness(&record.harness)
            .ok_or_else(|| invalid_params(format!("Unknown harness {}", record.harness)))?;
        let bridge = self
            .ensure_account_bridge(&record.harness, record.account_id.as_deref())
            .await?;
        let stored_bridge_id = record
            .bridge_session_id
            .clone()
            .unwrap_or_else(|| record.id.clone());
        let snapshot = record
            .snapshot
            .clone()
            .unwrap_or_else(|| Self::snapshot_from(&Value::Null));

        // Register early with `loading` so replayed history from the bridge is
        // swallowed rather than duplicated in the renderer.
        let mut sessions = self.sessions.lock().await;
        if self.shutdown_prepared.load(Ordering::SeqCst) {
            return Err(protocol::internal("Distill is closing"));
        }
        sessions.insert(
            record.id.clone(),
            SessionRuntime {
                harness: record.harness.clone(),
                account_id: record.account_id.clone(),
                execution_profile: None,
                bridge_session_id: stored_bridge_id.clone(),
                generation: bridge.generation(),
                loading: true,
                run: None,
                steer_queue: VecDeque::new(),
                snapshot: snapshot.clone(),
                has_model_option: Self::has_model_option(&snapshot),
                substitutions: Vec::new(),
                last_active: std::time::Instant::now(),
            },
        );
        drop(sessions);
        let attached = self
            .attach_registered_session(record, spec, &bridge, stored_bridge_id, snapshot)
            .await;
        if attached.is_err() {
            // The bridge accepted nothing: leave no runtime behind, or every
            // later call would route at a bridge session it never opened
            // instead of attaching again once the cause is fixed.
            self.sessions.lock().await.remove(&record.id);
        }
        attached
    }

    /// The bridge session an attach is allowed to resume: the one the record
    /// carries, which is either the id the bridge itself gave us or — for a chat
    /// imported from another tool — the agent's own session id.
    ///
    /// `None` means "open a fresh one". That is what
    /// [`Inner::update_working_dir`] leaves behind: a bridge session runs in
    /// the folder it was created in, so a chat that moved folders must not
    /// resume it, and every bridge that supports `loadSession` but not
    /// `session/close` would happily resume it forever. Falling back to the
    /// host's own session id here (the record's `id`) would do exactly that for
    /// an imported chat, whose two ids are the same.
    ///
    /// A chat nobody has prompted has nothing to resume either, and the agent
    /// never saved its bridge session: claude answers such a resume with
    /// "Resource not found" after about three seconds, and the home composer's
    /// draft paid that on every start.
    fn resumable_bridge_session(record: &SessionRecord) -> Option<&str> {
        if record.message_count == 0 {
            return None;
        }
        record
            .bridge_session_id
            .as_deref()
            .filter(|id| !id.is_empty())
    }

    /// The bridge round trips of an attach, for a session already registered
    /// as loading: resume the stored bridge session (or open a fresh one),
    /// apply the mode and model, and only then make the runtime routable.
    async fn attach_registered_session(
        self: &Arc<Self>,
        record: &SessionRecord,
        spec: &HarnessSpec,
        bridge: &Arc<Bridge>,
        stored_bridge_id: String,
        mut snapshot: Value,
    ) -> Result<(Arc<Bridge>, String), Value> {
        let mcp_servers = self.mcp_servers(&Value::Null).await;
        let mut bridge_session_id = stored_bridge_id.clone();
        let mut resumed = false;
        // A model the bridge runs only when a session is opened on it.
        let open_meta = record
            .model_id
            .as_deref()
            .and_then(|model_id| harness::session_model_meta(spec, model_id));
        if let Some(resume_id) = Self::resumable_bridge_session(record)
            .filter(|_| bridge.supports_load_session())
            .map(str::to_string)
        {
            let mut load =
                json!({ "sessionId": resume_id, "cwd": record.cwd, "mcpServers": mcp_servers });
            if let Some(meta) = &open_meta {
                load["_meta"] = meta.clone();
            }
            match bridge.request("session/load", load).await {
                Ok(result) => {
                    resumed = true;
                    let loaded = Self::snapshot_from(&result);
                    if Self::replaces_snapshot(&loaded, &snapshot) {
                        snapshot = loaded;
                    }
                }
                Err(error) => log::warn!(
                    "[agent-host] {} could not resume session {}: {}",
                    record.harness,
                    record.id,
                    error_text(&error)
                ),
            }
        }
        if !resumed {
            let mut open = json!({ "cwd": record.cwd, "mcpServers": mcp_servers });
            if let Some(meta) = &open_meta {
                open["_meta"] = meta.clone();
            }
            let result = bridge.request("session/new", open).await?;
            bridge_session_id = protocol::session_id(&result)
                .ok_or_else(|| protocol::internal("bridge returned no sessionId"))?;
            let fresh = Self::snapshot_from(&result);
            if Self::replaces_snapshot(&fresh, &snapshot) {
                snapshot = fresh;
            }
            if let Err(error) = self
                .store
                .set_bridge_session_id(&record.id, Some(bridge_session_id.as_str()))
                .await
            {
                log::warn!("[agent-host] failed to record bridge session id: {error}");
            }
        }
        self.apply_mode(bridge, spec, &bridge_session_id).await;
        // Mode, then model, then the two knobs that belong to the model — the
        // whole selection again, every time the chat wakes. No bridge keeps it
        // across a resume: claude re-seeds the effort from the operator's
        // settings file and loses it altogether after a model with none, codex
        // clamps it to the model's own default. What a model will not take is
        // recorded and left alone; the stored intent stands, so the next model
        // that offers it gets it back.
        let wanted = Selection {
            model: record.model_id.clone(),
            effort: record.reasoning_effort.clone(),
            fast: record.fast_mode,
        };
        let substitutions = self
            .apply_to_session(
                &record.harness,
                bridge,
                &bridge_session_id,
                &mut snapshot,
                &wanted,
                open_meta.is_some(),
            )
            .await;
        let has_model_option = Self::has_model_option(&snapshot);
        let _ = self.store.set_snapshot(&record.id, &snapshot).await;
        // Everything the bridge replayed for this session is already in the
        // event queue; let the loop swallow it all before the session is live,
        // or its tail would be appended to the transcript a second time.
        self.drain_bridge_events().await?;
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.rebind(&record.id, bridge_session_id.clone()) {
                runtime.loading = false;
                runtime.snapshot = snapshot;
                runtime.has_model_option = has_model_option;
                runtime.substitutions = substitutions;
                runtime.touch();
            }
        }
        Ok((Arc::clone(bridge), bridge_session_id))
    }

    async fn load_session(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let started = std::time::Instant::now();
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let mut record = self.session_record(&session_id).await?;
        let owned = self
            .store
            .execution_owner(&session_id)
            .await
            .map_err(protocol::internal)?
            .is_some();
        if !owned {
            if let Some(cwd) = params.get("cwd").and_then(Value::as_str) {
                if !cwd.is_empty() && cwd != "~" && cwd != record.cwd {
                    self.update_working_dir(&session_id, cwd).await?;
                    record.cwd = cwd.to_string();
                }
            }
        }
        // The transcript is ours: replay it from the local log and answer
        // right away. Waking the agent behind the session (spawning its
        // bridge, resuming its own context) is only needed for the next
        // prompt, so it happens in the background — the user may just read
        // the chat and never send anything.
        //
        // The log is read, so the event loop's own buffer has to be committed
        // first: a chat that is streaming right now has its last chunks there,
        // and replaying without them would show a transcript missing its tail.
        let before_drain = std::time::Instant::now();
        self.drain_bridge_events().await?;
        let before_read = std::time::Instant::now();
        let paged = params
            .pointer("/_meta/distill/historyPage")
            .and_then(Value::as_bool)
            == Some(true);
        let history = if paged {
            Some(
                self.store
                    .history_page(&session_id, None)
                    .await
                    .map_err(protocol::internal)?,
            )
        } else {
            None
        };
        let (events, event_count) = if paged {
            (Vec::new(), 0)
        } else {
            self.store
                .replay_payloads(&session_id)
                .await
                .map_err(protocol::internal)?
        };
        let before_send = std::time::Instant::now();
        let replayed_count = events.len();
        let batched = params
            .pointer("/_meta/distill/replayBatch")
            .and_then(Value::as_bool)
            == Some(true);
        let frames = protocol::send_replay_notifications(events, batched, |frame| {
            self.send_to_frontend(frame);
        });
        log::debug!(
            target: "perf",
            "[perf:host-load] {} record={}ms drain={}ms read_compact={}ms enqueue={}ms events={} replayed={} frames={} page_events={} page_bytes={}",
            session_id,
            before_drain.duration_since(started).as_millis(),
            before_read.duration_since(before_drain).as_millis(),
            before_send.duration_since(before_read).as_millis(),
            before_send.elapsed().as_millis(),
            event_count,
            replayed_count,
            frames,
            history.as_ref().map_or(0, |page| page.events.len()),
            history.as_ref().map_or(0, |page| page.events.iter().map(|event| event.get().len()).sum::<usize>()),
        );
        let attached = self.attached_route(&session_id).await.is_some();
        if attached {
            // Opening a chat whose agent is awake counts as using it: the
            // background attach that would wake it otherwise is skipped, and a
            // chat someone is looking at is the likeliest to be prompted next.
            self.touch_session(&session_id).await;
        }
        let (snapshot, has_model_option, substitutions) =
            match self.runtime_snapshot(&session_id).await {
                Some(live) if attached => live,
                _ => {
                    let stored = record
                        .snapshot
                        .clone()
                        .unwrap_or_else(|| Self::snapshot_from(&Value::Null));
                    let has_model_option = Self::has_model_option(&stored);
                    (stored, has_model_option, Vec::new())
                }
            };
        let mut response = Self::presented_snapshot(&record.harness, &snapshot, has_model_option);
        response["_meta"] = json!({ "providerId": record.harness, "accountId": record.account_id });
        if owned {
            response["_meta"]["executionOwner"] = record
                .snapshot
                .as_ref()
                .and_then(|v| v.pointer("/_meta/executionOwner"))
                .cloned()
                .unwrap_or(Value::Null);
        }
        if let Some(history) = history {
            response["_meta"]["distillHistory"] = json!(history);
        }
        let response = Self::with_substitutions(response, &substitutions);
        if let Ok(mut last) = self.last_loaded.lock() {
            *last = Some(session_id.clone());
        }
        if !owned
            && !attached
            && account_validation_id(&record.harness, record.account_id.as_deref()).is_ok()
        {
            let host = Arc::clone(self);
            let presented = response["configOptions"].clone();
            tokio::spawn(async move {
                tokio::time::sleep(BACKGROUND_ATTACH_DELAY).await;
                let still_current = host
                    .last_loaded
                    .lock()
                    .map(|last| last.as_deref() == Some(record.id.as_str()))
                    .unwrap_or(false);
                if still_current {
                    host.attach_in_background(record, presented).await;
                }
            });
        }
        Ok(response)
    }

    /// A live session's snapshot, whether its bridge names its models in an
    /// option of its own, and what that bridge would not do when the session
    /// was last put on its selections.
    async fn runtime_snapshot(&self, session_id: &str) -> Option<(Value, bool, Vec<Value>)> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).map(|runtime| {
            (
                runtime.snapshot.clone(),
                runtime.has_model_option,
                runtime.substitutions.clone(),
            )
        })
    }

    /// Wake the agent behind a session after `session/load` has already
    /// answered from the local log. When the bridge reports different config
    /// options than the stored snapshot the chat was opened with, the
    /// renderer gets the live ones as a `config_option_update`.
    async fn attach_in_background(self: Arc<Self>, record: SessionRecord, presented_before: Value) {
        if let Err(error) = self.attach_session(&record).await {
            log::warn!(
                "[agent-host] background attach of session {} to {} failed: {}",
                record.id,
                record.harness,
                error_text(&error)
            );
            return;
        }
        let Some((_, _, _)) = self.runtime_route(&record.id).await else {
            return;
        };
        let Some((snapshot, has_model_option, substitutions)) =
            self.runtime_snapshot(&record.id).await
        else {
            return;
        };
        let current = match self.session_record(&record.id).await {
            Ok(record) => record,
            Err(_) => return,
        };
        let presented = Self::presented_snapshot(&current.harness, &snapshot, has_model_option);
        if presented["configOptions"] == presented_before && substitutions.is_empty() {
            return;
        }
        // The attach happened with nobody watching, so this notification is
        // the only way a value the agent would not take reaches the screen.
        let mut update = json!({
            "sessionUpdate": "config_option_update",
            "configOptions": presented["configOptions"],
        });
        if !substitutions.is_empty() {
            update["_meta"] = json!({ "substitutions": substitutions });
        }
        self.notify_frontend(
            "session/update",
            json!({ "sessionId": record.id, "update": update }),
        );
    }

    pub fn session_info(record: &SessionRecord, active_run_id: Option<&str>) -> Value {
        json!({
            "sessionId": record.id,
            "cwd": record.cwd,
            "title": record.title,
            "updatedAt": record.updated_at,
            "_meta": {
                "createdAt": record.created_at,
                "lastMessageAt": record.last_message_at,
                "archivedAt": record.archived_at,
                "userSetName": record.user_set_name,
                "messageCount": record.message_count,
                "lastMessageSnippet": record.last_snippet,
                "projectId": record.project_id,
                "providerId": record.harness,
                "accountId": record.account_id,
                "modelId": record.model_id,
                // The two knobs that belong to the model, so a chat the
                // operator has not opened still reports what it runs at.
                "reasoningEffort": record.reasoning_effort,
                "fastMode": record.fast_mode,
                "personaId": record.persona_id,
                "activeRunId": active_run_id,
                "executionOwner": record.snapshot.as_ref().and_then(|v| v.pointer("/_meta/executionOwner")),
            }
        })
    }

    pub async fn active_run_id(&self, session_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .and_then(|runtime| runtime.run.as_ref().map(|run| run.run_id.clone()))
    }

    async fn list_sessions(&self, params: Value) -> Result<Value, Value> {
        let offset: i64 = params
            .get("cursor")
            .and_then(Value::as_str)
            .and_then(|cursor| cursor.parse().ok())
            .unwrap_or(0);
        let records = self
            .store
            .list_sessions(offset, SESSION_PAGE_SIZE)
            .await
            .map_err(protocol::internal)?;
        let next_cursor = if records.len() as i64 == SESSION_PAGE_SIZE {
            Some((offset + SESSION_PAGE_SIZE).to_string())
        } else {
            None
        };
        let mut sessions = Vec::with_capacity(records.len());
        for record in &records {
            let active = self.active_run_id(&record.id).await;
            sessions.push(Self::session_info(record, active.as_deref()));
        }
        Ok(json!({ "sessions": sessions, "nextCursor": next_cursor }))
    }

    async fn delete_session(&self, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        // Tell the agent first: forgetting the runtime does not stop the turn,
        // and a bridge session nobody will ever talk to again keeps its agent
        // context (and whatever it is doing) alive until the process exits.
        let attached = self.attached_route(&session_id).await;
        self.sessions.lock().await.remove(&session_id);
        self.attach_locks.lock().await.remove(&session_id);
        if let Some((bridge, bridge_session_id)) = attached {
            bridge.notify(
                "session/cancel",
                json!({ "sessionId": bridge_session_id.clone() }),
            );
            Self::close_in_background(bridge, bridge_session_id);
        }
        self.store
            .delete_session(&session_id)
            .await
            .map_err(protocol::internal)?;
        Ok(json!({}))
    }

    /// Cancel and hand back a bridge session nobody will talk to again, so the
    /// agent stops holding its context and whatever it was doing. Best effort:
    /// a bridge without `session/close` keeps it until the process exits.
    async fn let_go_of(&self, runtime: &SessionRuntime) {
        let Some(bridge) = self.live_bridge(&runtime.route_key()).await else {
            return;
        };
        if bridge.generation() != runtime.generation {
            return;
        }
        bridge.notify(
            "session/cancel",
            json!({ "sessionId": runtime.bridge_session_id.clone() }),
        );
        Self::close_in_background(bridge, runtime.bridge_session_id.clone());
    }

    /// Hand a bridge session back without waiting for the answer. The callers
    /// are on the renderer's request path — deleting a chat, moving one to
    /// another folder — and the host has already stopped using the session:
    /// nothing the bridge could say changes what happens next, so a bridge that
    /// takes the request and goes quiet must not delay the user's action.
    fn close_in_background(bridge: Arc<Bridge>, bridge_session_id: String) {
        tokio::spawn(async move {
            bridge.close_session(&bridge_session_id).await;
        });
    }

    pub(super) async fn update_working_dir(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Result<(), Value> {
        let lock = self.attach_lock(session_id).await;
        let _changing = lock.lock().await;
        let record = self.session_record(session_id).await?;
        if record.cwd == cwd {
            return Ok(());
        }
        if self
            .sessions
            .lock()
            .await
            .get(session_id)
            .is_some_and(|runtime| {
                runtime.loading || runtime.run.is_some() || !runtime.steer_queue.is_empty()
            })
        {
            return Err(invalid_params(
                "Wait for the session to finish before changing its working directory",
            ));
        }
        self.drain_bridge_events().await?;
        self.store
            .move_working_dir(session_id, cwd)
            .await
            .map_err(protocol::internal)?;
        let released = self.sessions.lock().await.remove(session_id);
        if let Some(runtime) = released {
            self.let_go_of(&runtime).await;
        }
        Ok(())
    }

    pub(super) async fn archive_session(&self, session_id: &str) -> Result<(), Value> {
        let lock = self.attach_lock(session_id).await;
        let _archiving = lock.lock().await;
        if self
            .sessions
            .lock()
            .await
            .get(session_id)
            .is_some_and(|runtime| {
                runtime.loading || runtime.run.is_some() || !runtime.steer_queue.is_empty()
            })
        {
            return Err(invalid_params(
                "Wait for the session to finish before archiving it",
            ));
        }
        self.drain_bridge_events().await?;
        self.store
            .set_archived(session_id, true)
            .await
            .map_err(protocol::internal)?;
        if let Some((harness, bridge_id, generation)) = self.runtime_route(session_id).await {
            let bridge = self.live_bridge(&harness).await;
            if Self::resumable_after_release(
                bridge
                    .as_ref()
                    .map(|bridge| (bridge.generation(), bridge.supports_load_session())),
                generation,
            ) {
                self.sessions.lock().await.remove(session_id);
                if let Some(bridge) = bridge {
                    bridge.close_session(&bridge_id).await;
                }
            }
        }
        Ok(())
    }

    /// The `session/new _meta` a fork opens on: everything about the chat it
    /// was taken from that a new session can be given. All four selections
    /// travel, so a fork runs what its source ran instead of starting over on
    /// the bridge's own default.
    fn fork_meta(record: &SessionRecord) -> Value {
        let mut meta = json!({ "provider": record.harness });
        if let Some(account_id) = &record.account_id {
            meta["accountId"] = json!(account_id);
        }
        if let Some(project_id) = &record.project_id {
            meta["projectId"] = json!(project_id);
        }
        if let Some(persona_id) = &record.persona_id {
            meta["personaId"] = json!(persona_id);
        }
        if let Some(model_id) = &record.model_id {
            meta["model"] = json!(model_id);
        }
        if let Some(effort) = &record.reasoning_effort {
            meta["reasoningEffort"] = json!(effort);
        }
        if let Some(fast) = record.fast_mode {
            meta["fastMode"] = json!(fast);
        }
        meta
    }

    async fn fork_session(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let lock = self.attach_lock(&session_id).await;
        let _forking = lock.lock().await;
        let record = self.session_record(&session_id).await?;
        self.drain_bridge_events().await?;
        // Resolve the selected message before creating a provider session. A
        // missing/stale identity must not silently become a full-history fork.
        let boundary = if let Some(target) = params.pointer("/_meta/conversationThrough") {
            let message_id = target
                .get("messageId")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| invalid_params("conversationThrough.messageId required"))?;
            let side = match target.get("role").and_then(Value::as_str) {
                Some("user") => MessageSide::User,
                Some("assistant") => MessageSide::Assistant,
                _ => {
                    return Err(invalid_params(
                        "conversationThrough.role must be user or assistant",
                    ))
                }
            };
            Some(ForkBoundary::ThroughEvent(
                self.store
                    .message_last_event(&session_id, side, message_id)
                    .await
                    .map_err(invalid_params)?,
            ))
        } else {
            params
                .pointer("/_meta/conversationBefore")
                .and_then(Value::as_i64)
                .map(ForkBoundary::BeforeSecond)
        };
        let meta = Self::fork_meta(&record);
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty() && *cwd != "~")
            .unwrap_or(&record.cwd)
            .to_string();
        let created = self
            .new_session(json!({ "cwd": cwd, "mcpServers": [], "_meta": meta }))
            .await?;
        let new_id = protocol::session_id(&created)
            .ok_or_else(|| protocol::internal("fork produced no session"))?;
        if let Err(error) = self.store.copy_events(&session_id, &new_id, boundary).await {
            // Do not leave an empty, attached fork when copying fails.
            if let Err(cleanup) = self.delete_session(json!({ "sessionId": new_id })).await {
                return Err(protocol::internal(format!(
                    "{error}; failed to remove incomplete fork: {cleanup}"
                )));
            }
            return Err(protocol::internal(error));
        }
        if let Some(title) = &record.title {
            let _ = self
                .store
                .set_title(&new_id, title, record.user_set_name)
                .await;
        }
        Ok(created)
    }

    async fn forward(self: &Arc<Self>, method: &str, mut params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let record = self.session_record(&session_id).await?;
        let (bridge, bridge_session_id) = self.attach_session(&record).await?;
        params["sessionId"] = json!(bridge_session_id);
        let mut result = bridge.request(method, params).await?;
        if let Some(object) = result.as_object_mut() {
            if object.contains_key("sessionId") {
                object.insert("sessionId".to_string(), json!(session_id));
            }
        }
        Ok(result)
    }

    /// What putting a bridge session on `model_id` takes (see `apply_model`),
    /// decided from the options the bridge last stated and nothing else.
    fn model_write(snapshot: &Value, model_id: &str) -> ModelWrite {
        if !Self::has_model_option(snapshot) {
            return ModelWrite::SetModel;
        }
        match Self::split_effort_model(snapshot, model_id) {
            Some(split) => ModelWrite::Folded(split),
            None => ModelWrite::ConfigOption {
                config_id: Self::model_option_id(snapshot).to_string(),
                model: model_id.to_string(),
            },
        }
    }

    /// Put a bridge session on `model_id`: one `set_config_option` under the
    /// bridge's own model option id, carrying the bridge's own model id.
    ///
    /// The other two arms are for what the ACP bridges are, not for what
    /// Distill sends. A bridge with no model option takes the older
    /// `session/set_model` — and only such a bridge may: codex's
    /// `unstable_setSessionModel` insists on `model[effort]` and throws on a
    /// base id, which is why that arm is behind `has_model_option` rather than
    /// behind a per-harness rule. A folded id is legacy inbound tolerance
    /// (`split_effort_model`): it arrives from history, never from us, and is
    /// sent as the two values the bridge actually keeps.
    async fn apply_model(
        &self,
        bridge: &Bridge,
        bridge_session_id: &str,
        model_id: &str,
        snapshot: &Value,
    ) -> Result<Value, Value> {
        match Self::model_write(snapshot, model_id) {
            ModelWrite::SetModel => {
                bridge
                    .request(
                        "session/set_model",
                        json!({ "sessionId": bridge_session_id, "modelId": model_id }),
                    )
                    .await
            }
            ModelWrite::ConfigOption { config_id, model } => {
                bridge
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId": bridge_session_id,
                            "configId": config_id,
                            "value": model,
                        }),
                    )
                    .await
            }
            ModelWrite::Folded(split) => {
                bridge
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId": bridge_session_id,
                            "configId": Self::model_option_id(snapshot),
                            "value": split.model,
                        }),
                    )
                    .await?;
                bridge
                    .request(
                        "session/set_config_option",
                        json!({
                            "sessionId": bridge_session_id,
                            "configId": split.effort_option,
                            "value": split.effort,
                        }),
                    )
                    .await
            }
        }
    }

    /// Put a bridge session on the model, effort and fast mode a chat is meant
    /// to run with (see `apply_selection`), routing the model step through
    /// `apply_model` so a bridge with no model option — and a stored id that
    /// still folds an effort into a model's name — are both still served.
    async fn apply_to_session(
        &self,
        harness_id: &str,
        bridge: &Arc<Bridge>,
        bridge_session_id: &str,
        snapshot: &mut Value,
        wanted: &Selection,
        assert_model: bool,
    ) -> Vec<Value> {
        // The model is always the first step, so `apply_model` reads the
        // session exactly as the bridge last described it.
        let opening = Arc::new(snapshot.clone());
        Self::apply_selection(
            harness_id,
            snapshot,
            wanted,
            assert_model,
            |role, request| {
                let host = self;
                let bridge = Arc::clone(bridge);
                let session = bridge_session_id.to_string();
                let opening = Arc::clone(&opening);
                async move {
                    match role {
                        OptionRole::Model => {
                            let model_id = request["value"].as_str().unwrap_or_default();
                            host.apply_model(&bridge, &session, model_id, &opening)
                                .await
                        }
                        _ => {
                            let mut params = request;
                            params["sessionId"] = json!(session);
                            bridge.request("session/set_config_option", params).await
                        }
                    }
                }
            },
        )
        .await
    }

    /// Put a session on the model, effort and fast mode a chat is meant to run
    /// with, in the only order that works: the model first, then the two knobs
    /// that belong to it. A step is skipped unless the options the bridge
    /// answered the previous one with advertise that option and list that
    /// value, and every answer is folded into `snapshot`, so each step reads
    /// what the bridge said after the one before it.
    ///
    /// Nothing here fails. A bridge that refuses one of the three is recorded
    /// in the returned `_meta.substitutions` entries and the sequence carries
    /// on: an attach must never fall over because a model stopped offering an
    /// effort level, and the chat's stored intent stays as it is so the next
    /// model that offers it gets it back.
    ///
    /// `write` sends one option write and answers with the bridge's own option
    /// list, under the bridge's own option id — the host classifies a write by
    /// role to know what it means, never to rename it.
    async fn apply_selection<W, WFut>(
        harness_id: &str,
        snapshot: &mut Value,
        wanted: &Selection,
        assert_model: bool,
        mut write: W,
    ) -> Vec<Value>
    where
        W: FnMut(OptionRole, Value) -> WFut,
        WFut: std::future::Future<Output = Result<Value, Value>>,
    {
        let mut substitutions = Vec::new();
        if let Some(model_id) = wanted.model.as_deref() {
            // A model the harness runs only in a session opened on it is
            // asserted even where the bridge lists no such value:
            // claude-agent-acp answers `session/new` with
            // `_meta.claudeCode.options.model` still reporting `default`, and
            // until the assert its effort and fast options describe that alias
            // instead — which is how Opus 4.6 came to advertise an `xhigh` it
            // does not have and a fast toggle it does not offer.
            let offered = assert_model || Self::lists_model(snapshot, model_id);
            if Self::current_model(snapshot).as_deref() != Some(model_id) {
                if offered {
                    let request =
                        json!({ "configId": Self::model_option_id(snapshot), "value": model_id });
                    match write(OptionRole::Model, request).await {
                        Ok(answer) => {
                            Self::take_options(snapshot, &answer);
                            // A bridge that also lists models reports the
                            // chosen one there and answers the write itself
                            // with nothing.
                            if let Some(models) =
                                snapshot.get_mut("models").and_then(Value::as_object_mut)
                            {
                                models.insert("currentModelId".to_string(), json!(model_id));
                            }
                            let applied = Self::current_model(snapshot);
                            // A stored id that still folds an effort into the
                            // model's name is applied as the two halves its
                            // bridge keeps apart (legacy inbound only — see
                            // `split_effort_model`), and the bridge names the
                            // model half back. That is the model that was
                            // asked for, not one substituted for it.
                            let asked = Self::split_effort_model(snapshot, model_id)
                                .map(|split| split.model)
                                .unwrap_or_else(|| model_id.to_string());
                            if applied.as_deref() != Some(asked.as_str()) {
                                substitutions.push(Self::substitution(
                                    "model",
                                    model_id,
                                    applied.as_deref(),
                                    format!("not offered by {harness_id}"),
                                ));
                            }
                        }
                        Err(error) => {
                            let reason = error_text(&error);
                            log::info!(
                                "[agent-host] {harness_id} would not run {model_id}: {reason}"
                            );
                            substitutions.push(Self::substitution(
                                "model",
                                model_id,
                                Self::current_model(snapshot).as_deref(),
                                reason,
                            ));
                        }
                    }
                } else {
                    substitutions.push(Self::substitution(
                        "model",
                        model_id,
                        Self::current_model(snapshot).as_deref(),
                        format!("not offered by {harness_id}"),
                    ));
                }
            }
        }
        // The model the remaining two belong to, as it is now: both are its
        // own, and a model that does not offer one is what the entry names.
        let model = Self::current_model(snapshot).unwrap_or_else(|| harness_id.to_string());
        if let Some(effort) = wanted.effort.as_deref() {
            match Self::effort_state(snapshot, effort) {
                // The model has no effort control at all (claude on haiku).
                None => substitutions.push(Self::substitution(
                    "effort",
                    effort,
                    None,
                    format!("{model} has no effort control"),
                )),
                Some((_, current, _)) if current.as_deref() == Some(effort) => {}
                Some((_, current, false)) => substitutions.push(Self::substitution(
                    "effort",
                    effort,
                    current.as_deref(),
                    format!("not offered by {model}"),
                )),
                Some((config_id, _, true)) => {
                    let request = json!({ "configId": config_id, "value": effort });
                    match write(OptionRole::Effort, request).await {
                        Ok(answer) => {
                            Self::take_options(snapshot, &answer);
                            let applied = Self::effort_state(snapshot, effort)
                                .and_then(|(_, current, _)| current);
                            if applied.as_deref() != Some(effort) {
                                substitutions.push(Self::substitution(
                                    "effort",
                                    effort,
                                    applied.as_deref(),
                                    format!("not offered by {model}"),
                                ));
                            }
                        }
                        Err(error) => {
                            let reason = error_text(&error);
                            log::info!("[agent-host] {harness_id} kept its effort: {reason}");
                            substitutions.push(Self::substitution("effort", effort, None, reason));
                        }
                    }
                }
            }
        }
        if let Some(fast) = wanted.fast {
            match Self::fast_state(snapshot) {
                // Writing a fast toggle a model does not have answers
                // "Unknown config option: fast"; the intent survives for the
                // next model that offers one.
                None => substitutions.push(Self::substitution(
                    "fast",
                    Self::fast_word(fast),
                    None,
                    format!("{model} has no fast mode"),
                )),
                Some((_, current, _)) if current == Some(fast) => {}
                Some((config_id, _, boolean)) => {
                    let request = if boolean {
                        // The ACP boolean arm is a discriminated union and is
                        // rejected without its `type`.
                        json!({ "configId": config_id, "value": fast, "type": "boolean" })
                    } else {
                        json!({ "configId": config_id, "value": Self::fast_word(fast) })
                    };
                    match write(OptionRole::Fast, request).await {
                        Ok(answer) => {
                            Self::take_options(snapshot, &answer);
                            let applied = Self::fast_state(snapshot).and_then(|(_, on, _)| on);
                            if applied != Some(fast) {
                                substitutions.push(Self::substitution(
                                    "fast",
                                    Self::fast_word(fast),
                                    applied.map(Self::fast_word),
                                    format!("not offered by {model}"),
                                ));
                            }
                        }
                        Err(error) => {
                            let reason = error_text(&error);
                            log::info!("[agent-host] {harness_id} kept its fast mode: {reason}");
                            substitutions.push(Self::substitution(
                                "fast",
                                Self::fast_word(fast),
                                None,
                                reason,
                            ));
                        }
                    }
                }
            }
        }
        substitutions
    }

    /// What a bridge did differently from what was asked of it, read off one
    /// answer rather than a sequence: an entry per selection whose read-back
    /// value is not the requested one, with `applied: null` where the model
    /// turned out to have no such control. Only ever called with an answer
    /// that stated its options — one that states none teaches nothing and
    /// must not read as a refusal.
    fn substitutions_for(wanted: &Selection, applied: &Selection) -> Vec<Value> {
        let model = applied.model.clone().or_else(|| wanted.model.clone());
        let named = model.as_deref().unwrap_or("the model");
        let mut out = Vec::new();
        if let Some(requested) = wanted.model.as_deref() {
            if let Some(got) = applied.model.as_deref().filter(|got| *got != requested) {
                out.push(Self::substitution(
                    "model",
                    requested,
                    Some(got),
                    format!("the agent is on {got}"),
                ));
            }
        }
        if let Some(requested) = wanted.effort.as_deref() {
            if applied.effort.as_deref() != Some(requested) {
                let reason = match applied.effort {
                    Some(_) => format!("not offered by {named}"),
                    None => format!("{named} has no effort control"),
                };
                out.push(Self::substitution(
                    "effort",
                    requested,
                    applied.effort.as_deref(),
                    reason,
                ));
            }
        }
        if let Some(requested) = wanted.fast {
            if applied.fast != Some(requested) {
                let reason = match applied.fast {
                    Some(_) => format!("not offered by {named}"),
                    None => format!("{named} has no fast mode"),
                };
                out.push(Self::substitution(
                    "fast",
                    Self::fast_word(requested),
                    applied.fast.map(Self::fast_word),
                    reason,
                ));
            }
        }
        out
    }

    async fn set_config_option(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let config_id = params
            .get("configId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let record = self.session_record(&session_id).await?;
        if config_id == "provider" {
            let requested = params.get("value").and_then(Value::as_str).unwrap_or("");
            if requested != record.harness {
                return self.move_to_harness(&session_id, requested).await;
            }
        }
        let (bridge, bridge_session_id) = self.attach_session(&record).await?;
        let (mut snapshot, has_model_option, standing) = {
            let sessions = self.sessions.lock().await;
            let runtime = sessions
                .get(&session_id)
                .ok_or_else(|| protocol::internal("session vanished"))?;
            (
                runtime.snapshot.clone(),
                runtime.has_model_option,
                runtime.substitutions.clone(),
            )
        };
        // What this write turned out to mean, when it meant one of the three
        // selections at all. A write about something else — a mode, an agent —
        // says nothing about them, so what a model would not do before it
        // still stands.
        let mut written: Option<Vec<Value>> = None;
        match config_id.as_str() {
            // Already on the requested harness (a move returned above).
            "provider" => {}
            "model" => {
                let model_id = params
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if Self::opens_on_model(&record.harness, &snapshot, &model_id) {
                    return self.reopen_on_model(&session_id, &model_id).await;
                }
                let result = self
                    .apply_model(&bridge, &bridge_session_id, &model_id, &snapshot)
                    .await?;
                if has_model_option {
                    if let Some(options) = result.get("configOptions") {
                        snapshot["configOptions"] = options.clone();
                    }
                }
                // A bridge that also lists models reports the chosen id there.
                if let Some(models) = snapshot.get_mut("models").and_then(Value::as_object_mut) {
                    models.insert("currentModelId".to_string(), json!(model_id));
                }
                // A model change moves the other two knobs with it: codex
                // clamps the effort to the new model's default and claude
                // drops it to `default`, both without saying so. Store what
                // the bridge answered, not what was asked for.
                let acknowledged = Self::selection_from(&result["configOptions"]);
                let _ = self
                    .store
                    .set_model(
                        &session_id,
                        Some(acknowledged.model.as_deref().unwrap_or(&model_id)),
                    )
                    .await;
                if result.get("configOptions").is_some() {
                    let _ = self
                        .store
                        .set_run_settings(
                            &session_id,
                            acknowledged.effort.as_deref(),
                            acknowledged.fast,
                        )
                        .await;
                    // What the chat was running at is what it asked to keep;
                    // the host does not write it back — putting a downgraded
                    // value where a model offers one again is the renderer's
                    // to decide — but a downgrade nobody is told about is how
                    // a chat quietly drops from xhigh to medium.
                    let wanted = Selection {
                        model: Some(model_id),
                        effort: record.reasoning_effort.clone(),
                        fast: record.fast_mode,
                    };
                    written = Some(Self::substitutions_for(&wanted, &acknowledged));
                }
            }
            _ => {
                let result = bridge
                    .request(
                        "session/set_config_option",
                        Self::forwarded_config_write(&params, &bridge_session_id),
                    )
                    .await?;
                let role = Self::write_role(&snapshot, &result, &config_id);
                // The write went out under the bridge's own id and value
                // shape; only what it means to this session is ours. An answer
                // with no options at all states nothing, so nothing moves.
                if let Some(options) = result.get("configOptions") {
                    let acknowledged = Self::selection_from(options);
                    snapshot["configOptions"] = options.clone();
                    // A bridge answers a write it cannot honour with the value
                    // it kept, not with an error.
                    let requested = params.get("value").unwrap_or(&Value::Null);
                    let stored = match role {
                        OptionRole::Effort => {
                            let wanted = Selection {
                                effort: requested.as_str().map(str::to_string),
                                ..Selection::default()
                            };
                            written = Some(Self::substitutions_for(&wanted, &acknowledged));
                            self.store
                                .set_reasoning_effort(&session_id, acknowledged.effort.as_deref())
                                .await
                        }
                        OptionRole::Fast => {
                            let wanted = Selection {
                                fast: Self::fast_enabled(requested),
                                ..Selection::default()
                            };
                            written = Some(Self::substitutions_for(&wanted, &acknowledged));
                            self.store
                                .set_fast_mode(&session_id, acknowledged.fast)
                                .await
                        }
                        // A harness naming its model option something other
                        // than `model` (none of the three live ones do).
                        OptionRole::Model => match acknowledged.model.as_deref() {
                            Some(model_id) => {
                                self.store.set_model(&session_id, Some(model_id)).await
                            }
                            None => Ok(()),
                        },
                        // A mode, an agent, a verbosity: none of the three, so
                        // what a model would not do still stands.
                        OptionRole::Other => Ok(()),
                    };
                    if let Err(error) = stored {
                        log::warn!("[agent-host] failed to store a session selection: {error}");
                    }
                }
            }
        }
        let substitutions = written.unwrap_or(standing);
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(runtime) = sessions.get_mut(&session_id) {
                runtime.snapshot = snapshot.clone();
                // The last word on this session, so a chat reopened later is
                // told the same thing — and a write the bridge did honour
                // clears a notice left by one it did not.
                runtime.substitutions = substitutions.clone();
                runtime.touch();
            }
        }
        let _ = self.store.set_snapshot(&session_id, &snapshot).await;
        Ok(Self::with_substitutions(
            Self::presented_snapshot(&record.harness, &snapshot, has_model_option),
            &substitutions,
        ))
    }

    /// Put a session on another harness — the "provider" option. Between
    /// turns only: a running turn belongs to the agent that is answering it.
    ///
    /// The conversation so far lives in the previous agent's own context,
    /// which cannot follow the chat to a different agent. What can is the
    /// transcript, which is the host's: a chat that has messages is marked as
    /// owing it to the new agent, and the next prompt carries it (see
    /// `carryover_block`). The new bridge session is opened before anything is
    /// changed, so a failure leaves the session on the harness it had.
    async fn move_to_harness(
        self: &Arc<Self>,
        session_id: &str,
        harness_id: &str,
    ) -> Result<Value, Value> {
        let spec = harness::harness(harness_id)
            .ok_or_else(|| invalid_params(format!("Unknown harness {harness_id}")))?;
        let lock = self.attach_lock(session_id).await;
        let _moving = lock.lock().await;
        let record = self.session_record(session_id).await?;
        let running = || {
            invalid_params(format!(
                "Session {session_id} is running a turn on {}; it can move to {harness_id} once the turn ends",
                record.harness
            ))
        };
        let account_id = self.resolve_account_id(harness_id, None)?;
        if self.active_run_id(session_id).await.is_some() {
            return Err(running());
        }
        let mcp_servers = self.mcp_servers(&Value::Null).await;
        let (bridge, bridge_session_id, snapshot) = self
            .open_bridge_session(spec, account_id.as_deref(), &record.cwd, mcp_servers, None)
            .await?;
        let model_id = Self::current_model(&snapshot);
        // Opening the bridge session took a while, and a prompt that was past
        // its attach before this move took the lock may have claimed a turn
        // on the old one meanwhile. The route is taken away under the very
        // lock a turn is claimed under, so either that turn is seen here and
        // the move is refused, or the prompt finds no runtime and fails
        // cleanly instead of being cut off by the close below.
        let previously = {
            let mut sessions = self.sessions.lock().await;
            if sessions
                .get(session_id)
                .is_some_and(|runtime| runtime.run.is_some())
            {
                None
            } else {
                Some(sessions.remove(session_id))
            }
        };
        let Some(previously) = previously else {
            // The session we just opened on the new harness is never going to
            // be used, so hand it back.
            bridge.close_session(&bridge_session_id).await;
            return Err(running());
        };
        let carried_over = match self
            .store
            .rebind_session(
                session_id,
                harness_id,
                account_id.as_deref(),
                &bridge_session_id,
                model_id.as_deref(),
                &snapshot,
            )
            .await
        {
            Ok(carried_over) => carried_over,
            Err(error) => {
                // Nothing moved: the record still names the old harness and
                // its bridge session. Put its route back, or that session
                // stays open in its bridge with nobody to hear it until the
                // next attach loads an id the bridge never let go of.
                if let Some(previously) = previously {
                    let mut sessions = self.sessions.lock().await;
                    if sessions.get(session_id).is_none() {
                        sessions.insert(session_id.to_string(), previously);
                    }
                }
                bridge.close_session(&bridge_session_id).await;
                return Err(protocol::internal(error));
            }
        };
        // The session it used to be is nobody's any more: cancel and close it
        // so the old agent stops holding its context.
        if let Some(previously) = previously {
            self.let_go_of(&previously).await;
        }
        let has_model_option = Self::has_model_option(&snapshot);
        self.sessions.lock().await.insert(
            session_id.to_string(),
            SessionRuntime {
                harness: harness_id.to_string(),
                account_id: account_id.clone(),
                execution_profile: None,
                bridge_session_id,
                generation: bridge.generation(),
                loading: false,
                run: None,
                steer_queue: VecDeque::new(),
                snapshot: snapshot.clone(),
                has_model_option,
                substitutions: Vec::new(),
                last_active: std::time::Instant::now(),
            },
        );
        log::info!(
            "[agent-host] session {session_id} moved from {} to {harness_id}{}",
            record.harness,
            if carried_over {
                "; its transcript goes with the next prompt"
            } else {
                " before its first message"
            }
        );
        let mut response = Self::presented_snapshot(harness_id, &snapshot, has_model_option);
        response["_meta"] = json!({"providerId":harness_id,"accountId":account_id});
        self.notify_frontend("session/update", json!({"sessionId":session_id,"update":{"sessionUpdate":"session_info_update","_meta":response["_meta"]}}));
        Ok(response)
    }

    /// Switch only an idle chat. A new CLI session receives context as text;
    /// historical commands are never dispatched as live tool invocations.
    pub(super) async fn set_session_account(
        self: &Arc<Self>,
        session_id: &str,
        account_id: &str,
    ) -> Result<Value, Value> {
        let lock = self.attach_lock(session_id).await;
        let _moving = lock.lock().await;
        let record = self.session_record(session_id).await?;
        let selected =
            provider_accounts::resolve_account(&self.app, &record.harness, Some(account_id))
                .map_err(invalid_params)?;
        if record.archived_at.is_some() || self.shutdown_prepared.load(Ordering::SeqCst) {
            return Err(invalid_params("Session is archived or Distill is closing"));
        }
        if account_route_key(&record.harness, record.account_id.as_deref())
            == account_route_key(&record.harness, Some(&selected.id))
        {
            let snapshot = record.snapshot.clone().unwrap_or_else(|| json!({}));
            let mut response = Self::presented_snapshot(
                &record.harness,
                &snapshot,
                Self::has_model_option(&snapshot),
            );
            response["_meta"] = json!({"providerId":record.harness,"accountId":selected.id});
            return Ok(response);
        }
        let can_switch = |runtime: &SessionRuntime| {
            !runtime.loading && runtime.run.is_none() && runtime.steer_queue.is_empty()
        };
        if self
            .sessions
            .lock()
            .await
            .get(session_id)
            .is_some_and(|runtime| !can_switch(runtime))
        {
            return Err(invalid_params(
                "Finish or stop the active turn before switching accounts",
            ));
        }
        let spec =
            harness::harness(&record.harness).ok_or_else(|| invalid_params("Unknown provider"))?;
        let wanted = Selection {
            model: record.model_id.clone(),
            effort: record.reasoning_effort.clone(),
            fast: record.fast_mode,
        };
        let open_meta = wanted
            .model
            .as_deref()
            .and_then(|model| harness::session_model_meta(spec, model));
        let (bridge, bridge_session_id, mut snapshot) = self
            .open_bridge_session(
                spec,
                Some(&selected.id),
                &record.cwd,
                self.mcp_servers(&Value::Null).await,
                open_meta.as_ref(),
            )
            .await?;
        let substitutions = self
            .apply_to_session(
                &record.harness,
                &bridge,
                &bridge_session_id,
                &mut snapshot,
                &wanted,
                open_meta.is_some(),
            )
            .await;
        if !substitutions.is_empty()
            || wanted
                .model
                .as_ref()
                .is_some_and(|model| Self::current_model(&snapshot).as_ref() != Some(model))
        {
            bridge.close_session(&bridge_session_id).await;
            return Err(protocol::error_with_data(
                protocol::INVALID_PARAMS,
                "The selected account cannot preserve this chat's model and settings",
                json!({"accountId":selected.id,"substitutions":substitutions}),
            ));
        }
        if let Err(error) = self.drain_bridge_events().await {
            bridge.close_session(&bridge_session_id).await;
            return Err(error);
        }
        // Remove the route under the same lock that claims turns. A prompt
        // admitted earlier either owns a run now or cannot dispatch here.
        let previously = {
            let mut sessions = self.sessions.lock().await;
            if self.shutdown_prepared.load(Ordering::SeqCst)
                || sessions
                    .get(session_id)
                    .is_some_and(|runtime| !can_switch(runtime))
            {
                drop(sessions);
                bridge.close_session(&bridge_session_id).await;
                return Err(invalid_params(
                    "Finish or stop the active turn before switching accounts",
                ));
            }
            sessions.remove(session_id)
        };
        if let Err(error) = self
            .store
            .switch_account(session_id, &selected.id, &bridge_session_id, &snapshot)
            .await
        {
            if let Some(runtime) = previously {
                self.sessions
                    .lock()
                    .await
                    .insert(session_id.to_string(), runtime);
            }
            bridge.close_session(&bridge_session_id).await;
            return Err(protocol::internal(error));
        }
        if let Some(runtime) = previously {
            self.let_go_of(&runtime).await;
        }
        let has_model_option = Self::has_model_option(&snapshot);
        self.sessions.lock().await.insert(
            session_id.to_string(),
            SessionRuntime {
                harness: record.harness.clone(),
                account_id: Some(selected.id.clone()),
                execution_profile: None,
                bridge_session_id,
                generation: bridge.generation(),
                loading: false,
                run: None,
                steer_queue: VecDeque::new(),
                snapshot: snapshot.clone(),
                has_model_option,
                substitutions: Vec::new(),
                last_active: std::time::Instant::now(),
            },
        );
        let meta = json!({"providerId":record.harness,"accountId":selected.id,"contextTransfer":"transcript"});
        self.notify_frontend("session/update", json!({"sessionId":session_id,"update":{"sessionUpdate":"session_info_update","_meta":meta}}));
        let mut response = Self::presented_snapshot(&record.harness, &snapshot, has_model_option);
        self.notify_frontend("session/update", json!({"sessionId":session_id,"update":{"sessionUpdate":"config_option_update","configOptions":response["configOptions"],"_meta":meta}}));
        response["_meta"] = meta;
        Ok(response)
    }

    pub(super) fn snippet(text: &str) -> Option<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        let collapsed: String = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
        Some(collapsed.chars().take(SNIPPET_CHARS).collect())
    }

    /// The text of a prompt block the user can see: a text block addressed to
    /// nobody in particular, or to the user among others. What the renderer
    /// sends the agent alone — a persona, a skill — is not what was said.
    fn user_visible_text(block: &Value) -> Option<&str> {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            return None;
        }
        let for_the_user = block
            .pointer("/annotations/audience")
            .and_then(Value::as_array)
            .map(|audience| audience.iter().any(|entry| entry == "user"))
            .unwrap_or(true);
        if !for_the_user {
            return None;
        }
        block.get("text").and_then(Value::as_str)
    }

    fn prompt_text(prompt: &Value) -> String {
        prompt
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(Self::user_visible_text)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    }

    /// A stored transcript as the messages two sides exchanged: `true` for
    /// the user's, `false` for the agent's. Chunks of one message are joined;
    /// a tool the agent ran is a line of its reply — by name only, since what
    /// a tool printed is the bulk of any log and what it *did* is in the
    /// working directory for the next agent to look at. Thoughts, plans and
    /// what the renderer told the agent behind the user's back are left out.
    fn carryover_messages(events: &[Value]) -> Vec<(bool, String)> {
        let mut messages: Vec<(bool, String)> = Vec::new();
        let mut open_message_id: Option<&str> = None;
        for event in events {
            let update = &event["update"];
            let (from_user, piece) = match update["sessionUpdate"].as_str() {
                Some("user_message_chunk") => match Self::user_visible_text(&update["content"]) {
                    Some(text) if !text.starts_with(CARRYOVER_OPENING) => (true, text.to_string()),
                    _ => continue,
                },
                Some("agent_message_chunk") => match update["content"]["text"].as_str() {
                    Some(text) => (false, text.to_string()),
                    None => continue,
                },
                Some("tool_call") => match update["title"].as_str().map(str::trim) {
                    Some(title) if !title.is_empty() => {
                        (false, format!("\n[ran a tool: {title}]\n"))
                    }
                    _ => continue,
                },
                _ => continue,
            };
            // Every event of a turn is stamped with the id of the prompt that
            // started it, so two prompts in a row stay two messages.
            let message_id = update
                .pointer("/_meta/distill/messageId")
                .and_then(Value::as_str);
            match messages.last_mut() {
                Some((last_from_user, text))
                    if *last_from_user == from_user && open_message_id == message_id =>
                {
                    // Blocks of one prompt are separate paragraphs; chunks of
                    // a streamed reply are one text cut at arbitrary places.
                    if from_user {
                        text.push('\n');
                    }
                    text.push_str(&piece);
                }
                _ => messages.push((from_user, piece)),
            }
            open_message_id = message_id;
        }
        messages.retain(|(_, text)| !text.trim().is_empty());
        messages
    }

    /// `text` cut down to `limit` characters by taking out its middle: how a
    /// message opens says what it is about and how it ends says where it got
    /// to.
    fn shortened(text: &str, limit: usize) -> String {
        let length = text.chars().count();
        if length <= limit {
            return text.to_string();
        }
        let head = limit * 2 / 3;
        let tail = limit - head;
        let byte_at = |position: usize| {
            text.char_indices()
                .nth(position)
                .map_or(text.len(), |(index, _)| index)
        };
        format!(
            "{}\n[… {} characters left out …]\n{}",
            &text[..byte_at(head)],
            length - limit,
            &text[byte_at(length - tail)..]
        )
    }

    /// The conversation so far as one prompt block for an agent that was not
    /// there for it, or `None` when nothing was said. Addressed to the agent
    /// alone, like a persona hand-off, so the renderer does not show it as
    /// something the user typed. Newest messages first in line for the budget:
    /// what was said last is what the next message most likely refers to.
    fn carryover_block(events: &[Value]) -> Option<Value> {
        let messages = Self::carryover_messages(events);
        let mut kept: Vec<String> = Vec::new();
        let mut spent = 0;
        for (from_user, text) in messages.iter().rev() {
            let text = Self::shortened(text.trim(), CARRYOVER_MESSAGE_CHARS);
            let cost = text.chars().count();
            if !kept.is_empty() && spent + cost > CARRYOVER_BUDGET_CHARS {
                break;
            }
            spent += cost;
            let side = if *from_user { "User" } else { "Previous agent" };
            kept.push(format!("## {side}\n\n{text}"));
        }
        if kept.is_empty() {
            return None;
        }
        let left_out = messages.len() - kept.len();
        kept.reverse();
        let mut text = format!(
            "{CARRYOVER_OPENING} Below is its transcript so far: the user's messages, the previous \
             agent's replies and the names of the tools it ran. Tool output is not included; \
             whatever those tools changed is in the working directory. Treat this as the history \
             of the conversation you are now part of and continue it. Previously recorded tool \
             actions have already been attempted; inspect their effects before continuing and \
             never repeat a completed action just because it appears in this transcript. Do not answer the \
             transcript itself and do not mention the hand-over unless it matters to the user's \
             request — their new message follows it.\n\n<conversation_transcript>\n"
        );
        if left_out > 0 {
            text.push_str(&format!("[{left_out} earlier message(s) left out]\n\n"));
        }
        text.push_str(&kept.join("\n\n"));
        text.push_str("\n</conversation_transcript>");
        Some(json!({
            "type": "text",
            "text": text,
            "annotations": { "audience": ["assistant"] },
        }))
    }

    /// `prompt` with `block` ahead of everything else in it.
    fn prompt_after(block: &Value, prompt: &Value) -> Value {
        let mut blocks = vec![block.clone()];
        blocks.extend(prompt.as_array().cloned().unwrap_or_default());
        Value::Array(blocks)
    }

    /// The transcript a session owes the agent it moved to, when it owes one.
    /// Refuse a prompt if the owed transcript cannot be read safely.
    async fn pending_carryover(&self, session_id: &str) -> Result<Option<Value>, Value> {
        if !self
            .store
            .carryover_pending(session_id)
            .await
            .map_err(protocol::internal)?
        {
            return Ok(None);
        }
        self.drain_bridge_events().await?;
        let events = self
            .store
            .list_events(session_id)
            .await
            .map_err(protocol::internal)?;
        let block = Self::carryover_block(&events);
        if block.is_none() {
            self.store
                .clear_carryover(session_id)
                .await
                .map_err(protocol::internal)?;
        }
        Ok(block)
    }

    /// Persist a user turn's prompt blocks. A steered turn (one the agent
    /// picks up after the turn it was steered into) is marked `steer` and
    /// echoed live once: the renderer already shows the message and needs
    /// the echo as the boundary between the previous reply and this one.
    ///
    /// Returns what it takes to undo these writes, for the case where the
    /// bridge rejects the prompt outright.
    ///
    /// The rows are written straight to the store, past the event loop that
    /// commits what the bridge streams, so every caller drains that loop first
    /// or the previous reply's tail could be committed after them. The drain
    /// happens before the turn is claimed rather than in here: once it is,
    /// anything still queued would be stamped as this turn's. `start_turn`
    /// drains before its claim, and `run_prompt` before a turn it ran ends,
    /// which is what precedes each steered turn's claim.
    async fn record_user_prompt(
        &self,
        session_id: &str,
        prompt: &Value,
        meta: &Value,
        ids: &TurnIds,
        steer: bool,
    ) -> Result<Option<RecordedPrompt>, Value> {
        let events = Self::user_prompt_events(session_id, prompt, meta, ids, &now_iso(), steer);
        let undo = self
            .store
            .touch_undo(session_id)
            .await
            .map_err(protocol::internal)?;
        let event_ids = self
            .store
            .append_events(session_id, &events)
            .await
            .map_err(protocol::internal)?;
        if steer {
            if let Some(mut echo) = events.into_iter().next() {
                echo["update"]["messageId"] = json!(ids.message_id);
                if let Some(id) = event_ids.first() {
                    Self::stamp_event_id(&mut echo, *id);
                }
                self.notify_frontend("session/update", echo);
            }
        }
        let snippet = Self::snippet(&Self::prompt_text(prompt));
        let _ = self.store.touch(session_id, 1, snippet.as_deref()).await;
        if snippet.is_none() {
            let _ = self.store.touch(session_id, 0, None).await;
        }
        Ok(undo.map(|undo| RecordedPrompt {
            run_id: ids.run_id.clone(),
            event_ids,
            undo,
        }))
    }

    /// Take a prompt the bridge rejected back out of the log and off the
    /// message count. Only when the turn produced nothing at all: once any
    /// `session/update` has arrived the turn happened, whatever `session/prompt`
    /// answered with, and the transcript has to keep it.
    ///
    /// The renderer's queue law re-dispatches a message whose send failed, so
    /// leaving it behind is what turns one rejected send into two, three, …
    /// copies of the same message with no replies — and a `message_count` that
    /// says a conversation took place in a chat nobody has answered yet.
    ///
    /// The decision fails *closed*: without proof that this very turn produced
    /// nothing, the prompt stays. Leaving an unanswered message behind costs a
    /// duplicate the user can see and delete; withdrawing a message whose reply
    /// was persisted leaves a transcript holding an answer to nothing and loses
    /// what the user typed.
    async fn discard_rejected_prompt(
        &self,
        session_id: &str,
        recorded: Option<RecordedPrompt>,
    ) -> bool {
        if !matches!(self.store.execution_owner(session_id).await, Ok(None)) {
            return false;
        }
        let Some(recorded) = recorded else {
            return false;
        };
        // The evidence lives in the bridge event queue: an update the bridge
        // emitted before it answered with an error is only stamped onto the run
        // when the event loop gets to it. Wait for the loop to catch up, or a
        // chunk that is about to be persisted reads as "nothing happened".
        if self.drain_bridge_events().await.is_err() {
            return false;
        }
        let produced_nothing = {
            let sessions = self.sessions.lock().await;
            Self::turn_produced_nothing(sessions.get(session_id), &recorded.run_id)
        };
        if !produced_nothing {
            return false;
        }
        if let Err(error) = self
            .store
            .discard_prompt(session_id, &recorded.event_ids, &recorded.undo)
            .await
        {
            log::warn!(
                "[agent-host] failed to withdraw the rejected prompt of session {session_id}: {error}"
            );
            return false;
        }
        true
    }

    /// Whether `runtime` positively says that turn `run_id` produced nothing:
    /// the session is still there, the turn it is running is this one, and no
    /// `session/update` of it has been seen.
    ///
    /// Anything else means "it happened, keep the prompt". A runtime that is
    /// gone is the case that matters: when a bridge dies mid-turn the outstanding
    /// `session/prompt` is failed and the `Exited` that follows removes the
    /// runtime, so the state that would prove the reply exists is exactly the
    /// state that has been thrown away — while the reply's chunks are already in
    /// the transcript. A `run` belonging to another turn says nothing about this
    /// one either.
    fn turn_produced_nothing(runtime: Option<&SessionRuntime>, run_id: &str) -> bool {
        runtime
            .and_then(|runtime| runtime.run.as_ref())
            .is_some_and(|run| run.run_id == run_id && !run.saw_update)
    }

    fn user_prompt_events(
        session_id: &str,
        prompt: &Value,
        meta: &Value,
        ids: &TurnIds,
        created: &str,
        steer: bool,
    ) -> Vec<Value> {
        let mut distill =
            json!({ "messageId": ids.message_id, "runId": ids.run_id, "created": created });
        if let Some(persona_id) = meta.get("personaId") {
            distill["personaId"] = persona_id.clone();
        }
        if steer {
            distill["steer"] = json!(true);
        }
        let mut update_meta = meta.as_object().cloned().unwrap_or_default();
        update_meta.insert("distill".to_string(), distill);
        prompt
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .map(|block| {
                        json!({
                            "sessionId": session_id,
                            "update": {
                                "sessionUpdate": "user_message_chunk",
                                "content": block,
                                "_meta": Value::Object(update_meta.clone()),
                            }
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    async fn prompt(self: &Arc<Self>, mut params: Value) -> Result<Value, Value> {
        let ids = TurnIds::for_prompt(&mut params);
        let mut attempted = std::collections::HashSet::new();
        loop {
            let result = self.start_turn(params.clone(), ids.clone(), false).await;
            let Err(error) = &result else {
                return result;
            };
            // Retry only an explicit quota rejection before the bridge emitted
            // any turn activity. The rejected prompt was removed by start_turn,
            // so its original message id remains the only accepted user turn.
            if error
                .pointer("/data/dispatchStarted")
                .and_then(Value::as_bool)
                != Some(false)
                || error
                    .pointer("/data/promptNotAccepted")
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                return result;
            }
            let Some(account_id) = error.pointer("/data/accountId").and_then(Value::as_str) else {
                return result;
            };
            if !attempted.insert(account_id.to_string()) || attempted.len() > 32 {
                return match Self::rejected_quota_wait(error, None) {
                    Some(wait) => Err(wait),
                    None => result,
                };
            }
            let session_id = protocol::session_id(&params)
                .ok_or_else(|| invalid_params("sessionId required"))?;
            let record = self.session_record(&session_id).await?;
            if !crate::services::provider_account_status::record_quota_error(
                &self.app, account_id, error,
            )
            .await
            {
                return result;
            }
            if !self.automatic_account_switching(&record.harness)? {
                // Manual routing still parks a proven unaccepted prompt.
                // Otherwise the renderer drops its queue entry while the host
                // has already withdrawn that same prompt from history.
                let selected_wait = self.route_account_for_dispatch(&record).await.err();
                if let Some(wait) = Self::rejected_quota_wait(error, selected_wait) {
                    return Err(wait);
                }
                return result;
            }
        }
    }

    fn quota_wait_error(
        account_id: &str,
        next_reset: Option<i64>,
        reset_tokens_available: bool,
        unavailable: &std::collections::HashSet<String>,
    ) -> Value {
        protocol::error_with_data(
            -32010,
            "All eligible accounts are waiting for quota; the message remains queued",
            json!({
                "kind":"account_quota_wait", "type":"account_quota_wait",
                "accountId":account_id, "nextReset":next_reset,
                "resetTokensAvailable":reset_tokens_available, "dispatchStarted":false,
                "promptNotAccepted":true, "unavailableAccounts":unavailable,
            }),
        )
    }

    fn rejected_quota_wait(error: &Value, selected_wait: Option<Value>) -> Option<Value> {
        if error
            .pointer("/data/dispatchStarted")
            .and_then(Value::as_bool)
            != Some(false)
            || error
                .pointer("/data/promptNotAccepted")
                .and_then(Value::as_bool)
                != Some(true)
            || !crate::services::provider_account_status::is_quota_error(error)
        {
            return None;
        }
        let account_id = error.pointer("/data/accountId").and_then(Value::as_str)?;
        Some(
            selected_wait
                .filter(|wait| {
                    wait.pointer("/data/type").and_then(Value::as_str) == Some("account_quota_wait")
                })
                .unwrap_or_else(|| {
                    // A concurrent account mutation or new telemetry can make the
                    // selection inconclusive. Keep the unaccepted message queued until
                    // the operator or a fresh status update makes it runnable again.
                    Self::quota_wait_error(
                        account_id,
                        None,
                        false,
                        &std::collections::HashSet::new(),
                    )
                }),
        )
    }

    fn automatic_account_switching(&self, harness_id: &str) -> Result<bool, Value> {
        if !provider_accounts::supports_managed_accounts(harness_id) {
            return Ok(false);
        }
        let registry = provider_accounts::snapshot(&self.app).map_err(protocol::internal)?;
        Ok(registry
            .automatic_switching
            .get(harness_id)
            .copied()
            .unwrap_or(false))
    }

    async fn route_account_for_dispatch(
        self: &Arc<Self>,
        record: &SessionRecord,
    ) -> Result<(), Value> {
        if !provider_accounts::supports_managed_accounts(&record.harness) {
            return Ok(());
        }
        let account_id = record
            .account_id
            .as_deref()
            .ok_or_else(|| invalid_params("Choose a signed-in account for this chat"))?;
        let owned = self
            .store
            .execution_owner(&record.id)
            .await
            .map_err(protocol::internal)?
            .is_some();
        let automatic = !owned && self.automatic_account_switching(&record.harness)?;
        let mut unavailable = std::collections::HashSet::new();
        loop {
            let selection = if unavailable.is_empty() {
                crate::services::provider_account_status::select_account(
                    &self.app,
                    &record.harness,
                    Some(account_id),
                    automatic,
                    record.model_id.as_deref(),
                )
                .await
            } else {
                crate::services::provider_account_status::select_account_excluding(
                    &self.app,
                    &record.harness,
                    Some(account_id),
                    automatic,
                    record.model_id.as_deref(),
                    &unavailable,
                )
                .await
            }
            .map_err(protocol::internal)?;
            match selection {
                crate::services::provider_account_status::AccountSelection::Ready {
                    account_id: selected,
                } => {
                    if selected != account_id {
                        if let Err(error) = self.set_session_account(&record.id, &selected).await {
                            if !automatic || !unavailable.insert(selected) || unavailable.len() > 32
                            {
                                return Err(error);
                            }
                            // Preparation leaves the old account/model intact on
                            // failure. A different spare may support this model.
                            continue;
                        }
                    }
                    return Ok(());
                }
                crate::services::provider_account_status::AccountSelection::Wait {
                    account_id,
                    next_reset,
                    reset_tokens_available,
                } => {
                    // Selection points to the best next account but does not open a
                    // new session until it can run. Reset credits require operator action.
                    return Err(Self::quota_wait_error(
                        &account_id,
                        next_reset,
                        reset_tokens_available,
                        &unavailable,
                    ));
                }
            }
        }
    }

    pub(super) async fn prepare_session_account(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<Value, Value> {
        let record = self.session_record(session_id).await?;
        if self.active_run_id(session_id).await.is_some() {
            return Err(invalid_params(
                "A prompt is already running for this session",
            ));
        }
        self.route_account_for_dispatch(&record).await?;
        let current = self.session_record(session_id).await?;
        Ok(
            json!({"sessionId":session_id,"accountId":current.account_id,"providerId":current.harness}),
        )
    }

    /// The update that tells the renderer a turn has ended when no request of
    /// its own will carry the answer. `_meta.activeRunId == null` is what
    /// `acpSessionInfoUpdate.ts` settles a chat's active run on.
    fn run_settled_update(session_id: &str) -> Value {
        json!({
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "session_info_update",
                "_meta": { "activeRunId": Value::Null },
            }
        })
    }

    /// Run one user turn and then every message steered into it, in order.
    /// A steered turn (`steer`) that finds another turn already running is
    /// queued behind it instead of failing: the steer was acknowledged with
    /// these ids, so it has to be delivered under them.
    async fn start_turn(
        self: &Arc<Self>,
        params: Value,
        ids: TurnIds,
        steer: bool,
    ) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let mut record = self.session_record(&session_id).await?;
        if self.active_run_id(&session_id).await.is_none() {
            self.route_account_for_dispatch(&record).await?;
            record = self.session_record(&session_id).await?;
        }
        let (bridge, _) = self.attach_session(&record).await?;
        let lock = self.attach_lock(&session_id).await;
        let admission = lock.lock().await;
        let current = self.session_record(&session_id).await?;
        if current.archived_at.is_some() {
            return Err(invalid_params(
                "Unarchive the session before sending a prompt",
            ));
        }
        if current.cwd != record.cwd
            || current.harness != record.harness
            || current.account_id != record.account_id
        {
            return Err(invalid_params(
                "Session changed while preparing the prompt; retry in its current workspace",
            ));
        }
        if provider_accounts::supports_managed_accounts(&current.harness) {
            let id = current
                .account_id
                .as_deref()
                .ok_or_else(|| invalid_params("Choose a signed-in account for this chat"))?;
            provider_accounts::resolve_account(&self.app, &current.harness, Some(id))
                .map_err(invalid_params)?;
        }
        let prompt = params
            .get("prompt")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        let meta = params.get("_meta").cloned().unwrap_or_else(|| json!({}));
        // A chat that came here from another agent owes this one the
        // conversation so far. Built before the turn is claimed: reading the
        // log means waiting for the event loop to catch up, and whatever a
        // freshly opened bridge session says about itself meanwhile would be
        // stamped onto the run as something the turn produced — which is what
        // stops a prompt the bridge then rejects from being withdrawn.
        let carryover = self.pending_carryover(&session_id).await?;
        // For the same reason, everything the bridge said before this prompt
        // is handled and stored before the turn is claimed and the prompt is
        // recorded. An update still queued would otherwise be stamped as this
        // turn's, and one still waiting for its commit would land in the log
        // after this prompt's rows. The previous turn's own tail is already in:
        // `run_prompt` drains before a turn it ran ends.
        self.drain_bridge_events().await?;
        // The bridge session the prompt goes to is the one the runtime names
        // in the very lock the run is registered in. `attach_session` released
        // its own lock before returning, and a `reopen_on_model` that took it
        // in between closes the bridge session and opens another: one that
        // finished first is answered here with its new id, and one still in
        // flight left no runtime at all, which fails the prompt cleanly
        // instead of sending it into a session the bridge has already closed.
        let bridge_session_id = {
            let mut sessions = self.sessions.lock().await;
            let runtime = sessions
                .get_mut(&session_id)
                .ok_or_else(|| protocol::internal("session vanished"))?;
            if self.shutdown_prepared.load(Ordering::SeqCst) {
                return Err(invalid_params("Distill is closing"));
            }
            match Self::claim_turn(runtime, &ids) {
                Ok(bridge_session_id) => {
                    self.activity_generations
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .record(&runtime.harness, runtime.account_id.as_deref());
                    bridge_session_id
                }
                Err(active_run_id) => {
                    if steer {
                        runtime
                            .steer_queue
                            .push_back(QueuedPrompt { prompt, meta, ids });
                        return Ok(json!({}));
                    }
                    return Err(protocol::error_with_data(
                        protocol::INVALID_PARAMS,
                        "A prompt is already running for this session",
                        json!({ "actualRunId": active_run_id }),
                    ));
                }
            }
        };
        // A move is refused from here on, so this second look is the one that
        // cannot go stale: it catches a chat that changed agents between the
        // first look and the claim. Both come before the prompt is recorded,
        // so the transcript handed over ends where this message begins.
        let recorded = match self
            .record_user_prompt(&session_id, &prompt, &meta, &ids, steer)
            .await
        {
            Ok(recorded) => recorded,
            Err(error) => {
                if let Some(runtime) = self.sessions.lock().await.get_mut(&session_id) {
                    runtime.run = None;
                }
                return Err(error);
            }
        };
        drop(admission);
        if self
            .store
            .session_execution_cancelled(&session_id)
            .await
            .map_err(protocol::internal)?
        {
            if let Some(runtime) = self.sessions.lock().await.get_mut(&session_id) {
                runtime.run = None;
            }
            return Err(protocol::error_with_data(
                -32000,
                "Benchmark was cancelled before provider dispatch",
                json!({"kind":"cancelled"}),
            ));
        }
        self.name_untitled_session(&record, &prompt);
        // What is recorded is what the user sent; what the agent is sent
        // opens with what it missed.
        let sent = match &carryover {
            Some(block) => Self::prompt_after(block, &prompt),
            None => prompt,
        };
        let mut result = self
            .run_prompt(&bridge, &session_id, &bridge_session_id, sent, meta)
            .await;
        if let Err(error) = &mut result {
            let dispatch_started = self
                .sessions
                .lock()
                .await
                .get(&session_id)
                .and_then(|runtime| runtime.run.as_ref())
                .is_none_or(|run| run.saw_update);
            let mut data = error
                .get("data")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            data.insert("dispatchStarted".into(), json!(dispatch_started));
            data.insert("accountId".into(), json!(record.account_id));
            error["data"] = Value::Object(data);
            if let Some(account_id) = &record.account_id {
                crate::services::provider_account_status::record_quota_error(
                    &self.app, account_id, error,
                )
                .await;
            }
        }
        match &mut result {
            // Only a turn the bridge saw through proves the agent has the
            // transcript. A failed one proves nothing either way — a bridge
            // that died took the prompt with it — and an agent told the same
            // history twice is a far smaller harm than one never told it.
            Ok(_) if carryover.is_some() => {
                if let Err(error) = self.store.clear_carryover(&session_id).await {
                    log::warn!(
                        "[agent-host] failed to settle the carry-over of {session_id}: {error}"
                    );
                }
            }
            Ok(_) => {}
            Err(error) => {
                let withdrawn = self.discard_rejected_prompt(&session_id, recorded).await;
                error["data"]["promptNotAccepted"] = json!(withdrawn);
            }
        }
        // Steering while the turn ran: send the queued messages one after the
        // other so the agent sees them in order.
        loop {
            let queued = {
                let mut sessions = self.sessions.lock().await;
                let Some(runtime) = sessions.get_mut(&session_id) else {
                    break;
                };
                // A turn just ended: the chat's idle time starts now, not when
                // the turn began.
                runtime.touch();
                // The turn failed (the bridge exited, the prompt was
                // rejected): the queued steers were never sent, so they are
                // dropped rather than persisted and echoed as sent messages
                // that will never get a reply — and the caller keeps the real
                // error instead of the last steer's.
                if result.is_err() {
                    let dropped = runtime.drop_queued_steers();
                    runtime.run = None;
                    if dropped > 0 {
                        log::warn!(
                            "[agent-host] session {session_id} turn failed: dropped {dropped} queued steer(s)"
                        );
                    }
                    break;
                }
                let Some(queued) = runtime.steer_queue.pop_front() else {
                    runtime.run = None;
                    break;
                };
                runtime.run = Some(RunState::start(&queued.ids));
                queued
            };
            let recorded = match self
                .record_user_prompt(&session_id, &queued.prompt, &queued.meta, &queued.ids, true)
                .await
            {
                Ok(recorded) => recorded,
                Err(error) => {
                    if let Some(runtime) = self.sessions.lock().await.get_mut(&session_id) {
                        runtime.steer_queue.push_front(queued);
                        runtime.run = None;
                    }
                    return Err(error);
                }
            };
            result = self
                .run_prompt(
                    &bridge,
                    &session_id,
                    &bridge_session_id,
                    queued.prompt,
                    queued.meta,
                )
                .await;
            if result.is_err() {
                self.discard_rejected_prompt(&session_id, recorded).await;
            }
        }
        if result.is_ok() {
            if let Some(account_id) = &record.account_id {
                crate::services::provider_account_status::invalidate(&self.app, account_id).await;
            }
        }
        result
    }

    /// Register a turn on an idle session and answer with the bridge session
    /// its prompt must go to, both read under one lock. `Err` names the run
    /// already going, which a steered prompt queues behind and an ordinary one
    /// is refused for.
    fn claim_turn(runtime: &mut SessionRuntime, ids: &TurnIds) -> Result<String, String> {
        if let Some(active) = runtime.run.as_ref() {
            return Err(active.run_id.clone());
        }
        runtime.run = Some(RunState::start(ids));
        Ok(runtime.bridge_session_id.clone())
    }

    async fn run_prompt(
        &self,
        bridge: &Bridge,
        session_id: &str,
        bridge_session_id: &str,
        prompt: Value,
        meta: Value,
    ) -> Result<Value, Value> {
        let mut request = json!({ "sessionId": bridge_session_id, "prompt": prompt });
        if meta.as_object().is_some_and(|meta| !meta.is_empty()) {
            request["_meta"] = meta;
        }
        let run_id = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .and_then(|runtime| runtime.run.as_ref())
            .map(|run| run.run_id.clone())
            .ok_or_else(|| protocol::internal("Turn ended before its provider request"))?;
        let raw_result = bridge.prompt(request, run_id).await;
        if let Some((owner, _)) = self
            .store
            .execution_owner(session_id)
            .await
            .map_err(protocol::internal)?
        {
            let raw = match &raw_result {
                Ok(value) => {
                    json!({"usage":value.get("usage"),"quota":value.pointer("/_meta/quota"),"stopReason":value.get("stopReason")})
                }
                Err(error) => json!({"error":error}),
            };
            self.store.append_events(session_id,&[json!({"sessionId":session_id,"update":{"sessionUpdate":"benchmark_turn_result","_meta":{"executionOwner":{"kind":"benchmark","id":owner.owner_id},"benchmarkRawResult":raw}}})]).await.map_err(protocol::internal)?;
        }
        let result = Self::prompt_response(raw_result);
        // The bridge writes every update of the turn before it answers the
        // prompt, but the two do not travel together: its reader hands the
        // answer straight to this request, while the updates wait in the
        // event queue (see `bridge_event_loop`). Until the loop has reached
        // the point of the answer, the reply's tail is still queued, and
        // handling it after the caller ends this run would stamp it with no
        // run or with the next steered turn's ids, storing it under the
        // wrong message; the snippet read below would miss it too. An answer
        // that is an error gets the same wait, since a failed turn may have
        // streamed as well.
        while let Err(error) = self.drain_bridge_events().await {
            log::error!(
                "[agent-host] holding turn {session_id} until history is durable: {}",
                error_text(&error)
            );
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        let (agent_text, saw_agent_message) = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .and_then(|runtime| runtime.run.as_ref())
                .map(|run| (run.agent_text.clone(), run.saw_agent_message))
                .unwrap_or_default()
        };
        let snippet = Self::snippet(&agent_text);
        let _ = self
            .store
            .touch(
                session_id,
                if saw_agent_message { 1 } else { 0 },
                snippet.as_deref(),
            )
            .await;
        result
    }

    /// Queue a message behind the running turn (or start one when idle).
    /// The answer's ids are the ones the message is recorded and run under.
    pub async fn steer(self: &Arc<Self>, params: Value) -> Result<Value, Value> {
        let session_id =
            protocol::session_id(&params).ok_or_else(|| invalid_params("sessionId required"))?;
        let expected_run = params
            .get("expectedRunId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let prompt = params
            .get("prompt")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        let meta = params.get("_meta").cloned().unwrap_or_else(|| json!({}));
        let ids = TurnIds::new();
        let queued = {
            let mut sessions = self.sessions.lock().await;
            if self.shutdown_prepared.load(Ordering::SeqCst) {
                return Err(invalid_params("Distill is closing"));
            }
            match sessions.get_mut(&session_id).and_then(|runtime| {
                runtime
                    .run
                    .as_ref()
                    .map(|run| run.run_id.clone())
                    .map(|active| (runtime, active))
            }) {
                Some((runtime, active_run)) => {
                    if expected_run != active_run
                        && expected_run != "__distill_unknown_active_run__"
                    {
                        return Err(protocol::error_with_data(
                            protocol::INVALID_PARAMS,
                            format!("expected run `{expected_run}` but found `{active_run}`"),
                            json!({ "actualRunId": active_run }),
                        ));
                    }
                    runtime.steer_queue.push_back(QueuedPrompt {
                        prompt: prompt.clone(),
                        meta: meta.clone(),
                        ids: ids.clone(),
                    });
                    true
                }
                None => false,
            }
        };
        if !queued {
            // Nothing is running: this becomes a turn of its own. Attach now
            // so a session that cannot be woken fails the steer instead of
            // being acknowledged and then dropped.
            let record = self.session_record(&session_id).await?;
            self.attach_session(&record).await?;
            let host = Arc::clone(self);
            let turn = ids.clone();
            let settle_id = session_id.clone();
            tokio::spawn(async move {
                let params =
                    json!({ "sessionId": settle_id.clone(), "prompt": prompt, "_meta": meta });
                if let Err(error) = host.start_turn(params, turn, true).await {
                    log::warn!("[agent-host] steer prompt failed: {}", error_text(&error));
                }
                // Nobody is awaiting this turn's answer — the renderer got its
                // ids from the `session/steer` reply and nothing else will ever
                // tell it the turn is over. Only settle when the session is
                // genuinely idle: a steer that raced a prompt was queued behind
                // it and that turn is still running.
                if host.active_run_id(&settle_id).await.is_none() {
                    host.notify_frontend("session/update", Self::run_settled_update(&settle_id));
                }
            });
        }
        Ok(json!({
            "runId": ids.run_id,
            "messageId": ids.message_id,
            "assistantMessageId": ids.assistant_message_id,
        }))
    }

    /// Opens the owned session `request` names, or returns the one its owner
    /// already has. `turn_limit_ms` is the longest its turn may run, which the
    /// sign-in of a bridge that cannot refresh it must outlast.
    pub async fn create_owned_session(
        self: &Arc<Self>,
        request: OwnedSessionRequest,
        turn_limit_ms: u64,
    ) -> Result<OwnedSession, String> {
        let provider = execution::validate_request(&request)?;
        // Fail closed: a profile the policy probe has not passed on what this
        // build ships never starts.
        if let Some(issue) = provider.admission_issue() {
            return Err(format!("capability_missing: {issue}"));
        }
        let policy_hash = provider.policy_hash(&request)?;
        let lock = self
            .owned_lock(&format!("owner:{}", request.owner_id))
            .await;
        let _guard = lock.lock().await;
        let existing_id = self.store.owned_session_id(&request.owner_id).await?;
        if let Some(id) = existing_id.as_ref() {
            let (_, existing_hash) = self
                .store
                .execution_owner(id)
                .await?
                .ok_or("evidence_missing: owner")?;
            if existing_hash != policy_hash {
                return Err("validation: owner already exists with another policy".into());
            }
            let record = self.session_record(id).await.map_err(|e| error_text(&e))?;
            if self.attached_route(id).await.is_some()
                || self.store.session_has_execution_dispatch(id).await?
            {
                return Ok(Self::owned_session_result(&request, &record, existing_hash));
            }
        }
        if self.shutdown_prepared.load(Ordering::SeqCst) {
            return Err("Distill is closing".into());
        }
        let account = provider_accounts::resolve_account(
            &self.app,
            &request.provider_id,
            Some(&request.account_id),
        )?;
        if provider == NativeProvider::Codex {
            // Every thread loads the account's home; it must add nothing.
            execution::codex_home_preflight(&provider_accounts::account_home(
                &self.app, &account,
            )?)?;
            // Nor may the user's own profile, which the redirect cannot hide.
            execution::codex_user_skills_preflight(execution::codex_user_profile().as_deref())?;
        }
        let profile_key = provider.profile_key();
        let bridge = self
            .ensure_execution_bridge(
                &request.provider_id,
                Some(&account.id),
                Some(OwnedBridge {
                    profile_key: &profile_key,
                    provider,
                    turn_limit_ms,
                }),
            )
            .await
            .map_err(|e| error_text(&e))?;
        let opened = bridge.request("session/new",json!({"cwd":request.cwd,"mcpServers":[],"_meta":provider.session_meta(&request.model_id)})).await.map_err(|e|error_text(&e))?;
        let bridge_session_id =
            protocol::session_id(&opened).ok_or("bridge returned no sessionId")?;
        if let Some(mode) = provider.permission_mode() {
            if let Err(error) = bridge
                .request(
                    "session/set_mode",
                    json!({"sessionId":bridge_session_id,"modeId":mode}),
                )
                .await
            {
                bridge.close_session(&bridge_session_id).await;
                return Err(format!(
                    "capability_missing: explicit permission mode was rejected: {}",
                    error_text(&error)
                ));
            }
        }
        let wanted = Selection {
            model: Some(request.model_id.clone()),
            effort: request.reasoning_effort.clone(),
            fast: request.fast_mode,
        };
        let mut snapshot = Self::snapshot_from(&opened);
        let substitutions = self
            .apply_to_session(
                &request.provider_id,
                &bridge,
                &bridge_session_id,
                &mut snapshot,
                &wanted,
                true,
            )
            .await;
        let acknowledged = Self::selection_from(&snapshot["configOptions"]);
        // A bridge that lands on a refused effort by itself must not run it.
        if let Some(reason) = provider.effort_refusal(acknowledged.effort.as_deref()) {
            bridge.close_session(&bridge_session_id).await;
            return Err(format!("capability_missing: {reason}"));
        }
        let matches = substitutions.is_empty()
            && acknowledged.model.as_deref() == Some(request.model_id.as_str())
            && request
                .reasoning_effort
                .as_ref()
                .is_none_or(|effort| acknowledged.effort.as_ref() == Some(effort))
            && request
                .fast_mode
                .is_none_or(|fast| acknowledged.fast == Some(fast));
        snapshot["_meta"]["executionOwner"] = json!({"kind":"benchmark","id":request.owner_id});
        let session_id = existing_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let now = now_iso();
        let record = SessionRecord {
            id: session_id.clone(),
            harness: request.provider_id.clone(),
            account_id: Some(account.id),
            bridge_session_id: Some(bridge_session_id.clone()),
            cwd: request.cwd.clone(),
            title: Some(request.title.clone()),
            user_set_name: true,
            project_id: None,
            persona_id: None,
            model_id: acknowledged.model.clone(),
            reasoning_effort: acknowledged.effort.clone(),
            fast_mode: acknowledged.fast,
            legacy_model_id: None,
            hidden: true,
            created_at: now.clone(),
            updated_at: now,
            last_message_at: None,
            archived_at: None,
            message_count: 0,
            last_snippet: None,
            snapshot: Some(snapshot.clone()),
        };
        let stored = if existing_id.is_some() {
            self.store
                .set_bridge_session_id(&record.id, Some(&bridge_session_id))
                .await?;
            self.store_bridge_selection(&record.id, &snapshot, &acknowledged)
                .await;
            Ok(())
        } else {
            self.store
                .insert_owned_session(&record, &request, &policy_hash)
                .await
        };
        if let Err(error) = stored {
            bridge.close_session(&bridge_session_id).await;
            return Err(error);
        }
        if let Err(error) = install_owned_runtime(
            &self.events_tx,
            &self.sessions,
            session_id.clone(),
            SessionRuntime {
                harness: request.provider_id.clone(),
                account_id: Some(request.account_id.clone()),
                execution_profile: Some(profile_key),
                bridge_session_id: bridge_session_id.clone(),
                generation: bridge.generation(),
                loading: false,
                run: None,
                steer_queue: VecDeque::new(),
                has_model_option: Self::has_model_option(&snapshot),
                snapshot,
                substitutions: substitutions.clone(),
                last_active: std::time::Instant::now(),
            },
        )
        .await
        {
            bridge.close_session(&bridge_session_id).await;
            return Err(error_text(&error));
        }
        let mut result = Self::owned_session_result(&request, &record, policy_hash);
        result.substitutions = substitutions;
        if !matches && result.substitutions.is_empty() {
            result.substitutions.push(json!({"kind":"selection_changed","message":"Requested selection was not acknowledged exactly"}));
        }
        Ok(result)
    }

    fn owned_session_result(
        request: &OwnedSessionRequest,
        record: &SessionRecord,
        policy_hash: String,
    ) -> OwnedSession {
        OwnedSession {
            session_id: record.id.clone(),
            owner_id: request.owner_id.clone(),
            policy_hash,
            selection: ObservedSelection {
                model_id: record.model_id.clone(),
                reasoning_effort: record.reasoning_effort.clone(),
                fast_mode: record.fast_mode,
            },
            substitutions: Vec::new(),
        }
    }

    async fn owned_lock(&self, key: &str) -> Arc<Mutex<()>> {
        Arc::clone(
            self.owned_locks
                .lock()
                .await
                .entry(key.to_string())
                .or_default(),
        )
    }

    pub async fn dispatch_owned_turn(
        self: &Arc<Self>,
        request: OwnedTurnRequest,
    ) -> Result<ExecutionDispatch, String> {
        if request.request_key.trim().is_empty()
            || request.request_key.len() > 256
            || request.prompt.len() > 1024 * 1024
            || request
                .images
                .iter()
                .map(|image| image.data.len())
                .sum::<usize>()
                > 6 * 1024 * 1024
            || request.timeout_ms == 0
            || request.timeout_ms > 3_600_000
        {
            return Err("validation: invalid dispatch key, prompt size or time limit".into());
        }
        let lock = self
            .owned_lock(&format!("dispatch:{}", request.session_id))
            .await;
        let _guard = lock.lock().await;
        let (owner, hash) = self
            .store
            .execution_owner(&request.session_id)
            .await?
            .ok_or("validation: session has no execution owner")?;
        if request.policy_hash != hash {
            return Err("validation: execution policy changed".into());
        }
        let prompt_hash = execution::digest(request.prompt.as_bytes());
        if let Some(existing) = self.store.execution_dispatch(&request.request_key).await? {
            self.store.reserve_dispatch(&existing, &prompt_hash).await?;
            if existing.session_id != request.session_id {
                return Err("validation: request key belongs to another session".into());
            }
            return Ok(existing);
        }
        let current = self
            .session_record(&request.session_id)
            .await
            .map_err(|e| error_text(&e))?;
        self.require_owned_selection(&owner, &current).await?;
        if self.attached_route(&request.session_id).await.is_none() {
            return Err(
                "dispatch_uncertain: owned runtime is unavailable; create an explicit rerun".into(),
            );
        }
        let provider = NativeProvider::for_harness(&current.harness);
        let ids = TurnIds::new();
        let dispatch = ExecutionDispatch {
            request_key: request.request_key.clone(),
            session_id: request.session_id.clone(),
            run_id: ids.run_id.clone(),
            user_message_id: ids.message_id.clone(),
            phase: "reserved".into(),
            event_cursor: 0,
            result: None,
            error: None,
        };
        if !self.store.reserve_dispatch(&dispatch, &prompt_hash).await? {
            return self
                .store
                .execution_dispatch(&request.request_key)
                .await?
                .ok_or("dispatch_uncertain: reservation vanished".into());
        }
        let host = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = host
                .store
                .settle_dispatch(&request.request_key, "running", None, None)
                .await
            {
                log::error!("[agent-host] owned dispatch cannot start: {error}");
                return;
            }
            if host
                .store
                .execution_cancel_requested(&request.request_key)
                .await
                .unwrap_or(true)
            {
                let error = json!({"kind":"cancelled","message":"Cancelled before dispatch"});
                let _ = host
                    .store
                    .settle_dispatch(&request.request_key, "terminal", None, Some(&error))
                    .await;
                return;
            }
            let blocks = owned_prompt_blocks(&request.prompt, &request.images);
            let prompt =
                owned_prompt_params(&request.session_id, blocks, &owner.owner_id, provider);
            let task = host.start_turn(prompt, ids, false);
            tokio::pin!(task);
            let mut timed_out = false;
            let cancellation = async {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    if host
                        .store
                        .execution_cancel_requested(&request.request_key)
                        .await
                        .unwrap_or(true)
                    {
                        break;
                    }
                }
            };
            let mut cancelled = false;
            let outcome = tokio::select! {
                result=&mut task => result,
                _=cancellation=>{
                    cancelled=true;
                    let _=host.cancel_owned_turn(&request.request_key).await;
                    match tokio::time::timeout(std::time::Duration::from_secs(15),&mut task).await {
                        Ok(result)=>result,
                        Err(_)=>{
                            let error=json!({"kind":"dispatch_uncertain","message":"Cancellation was not acknowledged; the account remains busy"});
                            let _=host.store.settle_dispatch(&request.request_key,"uncertain",None,Some(&error)).await;
                            let _=task.await;
                            return;
                        }
                    }
                }
                _=tokio::time::sleep(std::time::Duration::from_millis(request.timeout_ms))=>{
                    timed_out=true;
                    let _=host.cancel_owned_turn(&request.request_key).await;
                    match tokio::time::timeout(std::time::Duration::from_secs(15),&mut task).await {
                        Ok(result)=>result,
                        Err(_)=>{
                            let error=json!({"kind":"dispatch_uncertain","message":"Cancellation was not acknowledged; the account remains busy"});
                            let _=host.store.settle_dispatch(&request.request_key,"uncertain",None,Some(&error)).await;
                            // Keep the future alive so the live turn retains its owner and drains on completion.
                            let _=task.await;
                            return;
                        }
                    }
                }
            };
            let mut result = outcome.as_ref().ok().cloned();
            let mut error = outcome.err();
            if result
                .as_ref()
                .is_some_and(|value| value["stopReason"] == "cancelled")
            {
                cancelled = true;
            }
            if cancelled {
                error = Some(json!({"kind":"cancelled","message":"Cancelled by the operator"}));
                result = None;
            }
            if timed_out {
                error = Some(
                    json!({"kind":"budget_timeout","message":"The declared task duration expired"}),
                );
                result = None;
            }
            match host.session_record(&request.session_id).await {
                Ok(record) => {
                    if let Err(reason) = host.require_owned_selection(&owner, &record).await {
                        error = Some(json!({"kind":terminal_error_kind(&reason),"message":reason}));
                        result = None;
                    } else if let Some(value) = result.as_mut() {
                        value["observedSelection"] = json!(ObservedSelection {
                            model_id: record.model_id,
                            reasoning_effort: record.reasoning_effort,
                            fast_mode: record.fast_mode
                        });
                    }
                }
                Err(err) => {
                    error = Some(err);
                    result = None;
                }
            }
            if let Err(error) = host
                .store
                .settle_dispatch(
                    &request.request_key,
                    "terminal",
                    result.as_ref(),
                    error.as_ref(),
                )
                .await
            {
                log::error!("[agent-host] owned terminal evidence not committed: {error}");
            }
        });
        Ok(dispatch)
    }

    async fn require_owned_selection(
        &self,
        owner: &OwnedSessionRequest,
        record: &SessionRecord,
    ) -> Result<(), String> {
        if self.store.execution_policy_violation(&record.id).await? {
            return Err(
                "execution_violation: native execution violated the declared no-tool policy".into(),
            );
        }
        if record.harness != owner.provider_id
            || record.account_id.as_deref() != Some(owner.account_id.as_str())
            || record.model_id.as_deref() != Some(owner.model_id.as_str())
            || owner
                .reasoning_effort
                .as_ref()
                .is_some_and(|effort| record.reasoning_effort.as_ref() != Some(effort))
            || owner
                .fast_mode
                .is_some_and(|fast| record.fast_mode != Some(fast))
        {
            return Err(
                "selection_changed: requested benchmark selection was not acknowledged".into(),
            );
        }
        Ok(())
    }

    pub async fn execution_status(&self, key: &str) -> Result<Option<ExecutionDispatch>, String> {
        self.store.execution_dispatch(key).await
    }
    pub async fn read_owned_events(
        &self,
        id: &str,
        after: i64,
        limit: u32,
    ) -> Result<OwnedEventPage, String> {
        self.store.owned_events(id, after, limit).await
    }
    pub async fn cancel_owned_turn(&self, key: &str) -> Result<(), String> {
        let dispatch = self
            .store
            .execution_dispatch(key)
            .await?
            .ok_or("validation: unknown dispatch")?;
        if dispatch.phase == "terminal" {
            return Ok(());
        }
        self.store.request_execution_cancel(key).await?;
        if let Some((bridge, id)) = self.attached_route(&dispatch.session_id).await {
            bridge.notify("session/cancel", json!({"sessionId":id}));
            Ok(())
        } else {
            Err("dispatch_uncertain: no live runtime can confirm cancellation".into())
        }
    }
    pub async fn account_activity(
        &self,
        provider: &str,
        account: &str,
    ) -> Result<AccountActivity, String> {
        let sessions = self.sessions.lock().await;
        let mut active_sessions: Vec<String> = sessions
            .iter()
            .filter(|(_, runtime)| {
                runtime.harness == provider
                    && activity_scope_matches(
                        &account_route_key(&runtime.harness, runtime.account_id.as_deref()),
                        provider,
                        account,
                    )
                    && (runtime.loading || runtime.run.is_some())
            })
            .map(|(id, _)| id.clone())
            .collect();
        let naming = self
            .naming_replies
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        active_sessions.extend(
            naming
                .keys()
                .filter(|key| {
                    activity_scope_matches(key.split('\0').next().unwrap_or(key), provider, account)
                })
                .map(|key| format!("auxiliary:{key}")),
        );
        Ok(AccountActivity {
            active_sessions,
            generation: self
                .activity_generations
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .snapshot(provider, account),
        })
    }
    pub async fn benchmark_inventory(
        self: &Arc<Self>,
        provider: &str,
        account: &str,
        _refresh: bool,
    ) -> Result<Value, String> {
        let (models, executable) = self
            .probe_models(provider, Self::inventory_account(provider, account))
            .await
            .map_err(|e| error_text(&e))?;
        Ok(
            json!({"models":models,"executable":executable,"providerId":provider,"accountId":account,"observedAt":now_iso()}),
        )
    }

    /// The account whose bridge lists `provider`'s models for the benchmark
    /// account `account`. The CLI sign-in is the one the user's chats run on:
    /// their bridge, with no account.
    fn inventory_account<'a>(provider: &str, account: &'a str) -> Option<&'a str> {
        (!provider_accounts::is_cli_login_account(provider, account)).then_some(account)
    }

    /// The executable that would answer [`Self::benchmark_inventory`] for
    /// `provider` and `account` now, found without a session or a new
    /// process (see [`Self::serving_executable`]). An inventory listed by the
    /// same executable still describes the runtime.
    pub async fn benchmark_serving_executable(&self, provider: &str, account: &str) -> Value {
        self.serving_executable(provider, Self::inventory_account(provider, account))
            .await
    }

    /// A stored session, with any model id that still carries a folded effort
    /// split first. Every single-session read goes through here, so a chat is
    /// converted on the load that first looks at it and never by a sweep over
    /// rows nobody opened.
    pub async fn session_record(&self, session_id: &str) -> Result<SessionRecord, Value> {
        let mut record = self
            .store
            .get_session(session_id)
            .await
            .map_err(protocol::internal)?
            .ok_or_else(|| invalid_params(format!("Unknown session {session_id}")))?;
        self.split_stored_model_id(&mut record).await;
        Ok(record)
    }

    /// Split a stored `model[effort]` id into the two selections it always
    /// was, keeping the original in `legacy_model_id`.
    ///
    /// Only ever for a session nothing has chosen an effort for, and only when
    /// the harness itself advertises that effort for that base model. Anything
    /// else is left byte for byte: claude's `[1m]` context lanes are model ids
    /// and not pairs, `default` and `current` are aliases, and an id whose
    /// suffix no harness advertises is a model name the app has no business
    /// rewriting.
    async fn split_stored_model_id(&self, record: &mut SessionRecord) {
        if record.reasoning_effort.is_some() || record.legacy_model_id.is_some() {
            return;
        }
        let Some(model_id) = record.model_id.clone() else {
            return;
        };
        if !model_id.ends_with(']') || !self.selection_split_enabled().await {
            return;
        }
        let models =
            ext::known_models(&self.store, &record.harness, record.account_id.as_deref()).await;
        let Some((base, effort)) = Self::legacy_split(&model_id, &models) else {
            return;
        };
        match self
            .store
            .split_legacy_model_id(&record.id, &base, &effort)
            .await
        {
            Ok(true) => {
                log::info!(
                    "[agent-host] session {} runs {base} at {effort}, split out of the stored {model_id}",
                    record.id
                );
                record.legacy_model_id = Some(model_id);
                record.model_id = Some(base);
                record.reasoning_effort = Some(effort);
            }
            // Something chose for this session first; its choice stands.
            Ok(false) => {}
            Err(error) => log::warn!(
                "[agent-host] failed to split the stored model id of session {}: {error}",
                record.id
            ),
        }
    }

    /// The base id and effort a stored `model[effort]` id splits into, when
    /// the harness's own inventory advertises that effort for that base model.
    /// `None` — leave the id exactly as it is — for every other id, including
    /// one whose harness has not been probed yet, which is a "not now" rather
    /// than a "never".
    fn legacy_split(model_id: &str, models: &[Value]) -> Option<(String, String)> {
        let advertised = |id: &str| models.iter().find(|model| model["id"] == id);
        // A harness that lists the whole id means it: that is a model.
        if advertised(model_id).is_some() {
            return None;
        }
        let (base, effort) = model_id.strip_suffix(']')?.split_once('[')?;
        if base.is_empty() || effort.is_empty() || effort.contains('[') {
            return None;
        }
        let offers = advertised(base)?["efforts"]
            .as_array()
            .is_some_and(|efforts| efforts.iter().any(|entry| entry["value"] == effort));
        offers.then(|| (base.to_string(), effort.to_string()))
    }

    /// Whether the lazy split still runs. It does unless the kv row
    /// `migrations/selection_split` says `false` (or `{"enabled": false}`),
    /// which is how it is retired — by condition, not by date: once no
    /// `sessions.legacy_model_id` row is left and no client can still send a
    /// folded id, nothing is gained by asking again.
    async fn selection_split_enabled(&self) -> bool {
        match self.selection_split.load(Ordering::Relaxed) {
            1 => return true,
            2 => return false,
            _ => {}
        }
        let enabled = match self
            .store
            .kv_get(SELECTION_SPLIT_SCOPE, SELECTION_SPLIT_KEY)
            .await
            .ok()
            .flatten()
        {
            Some(Value::Bool(enabled)) => enabled,
            Some(value) => value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            None => true,
        };
        self.selection_split
            .store(if enabled { 1 } else { 2 }, Ordering::Relaxed);
        enabled
    }

    /// Have a chat nothing has named yet summarized, in the background, by its
    /// own harness and model from the message starting this turn. The
    /// renderer shows its own title from
    /// that message meanwhile; a summary that fails leaves the chat untitled,
    /// so the next message tries again. Hidden sessions are never shown, so
    /// they are not named.
    fn name_untitled_session(self: &Arc<Self>, record: &SessionRecord, prompt: &Value) {
        if record.title.is_some() || record.user_set_name || record.hidden {
            return;
        }
        let text = Self::prompt_text(prompt);
        if text.trim().is_empty() {
            return;
        }
        let host = Arc::clone(self);
        let session_id = record.id.clone();
        let harness_id = record.harness.clone();
        let account_id = record.account_id.clone();
        let model_id = record.model_id.clone();
        tokio::spawn(async move {
            match host
                .summarize_title(
                    &harness_id,
                    account_id.as_deref(),
                    model_id.as_deref(),
                    &text,
                )
                .await
            {
                Ok(Some(title)) => host.apply_host_title(&session_id, &title).await,
                Ok(None) => {
                    log::info!("[agent-host] the title summary for {session_id} came back empty")
                }
                Err(error) => log::info!(
                    "[agent-host] no title summary for {session_id}: {}",
                    error_text(&error)
                ),
            }
        });
    }

    /// Store a title the host chose and show it, unless the user has named
    /// the chat in the meantime.
    async fn apply_host_title(&self, session_id: &str, title: &str) {
        match self.store.set_agent_title(session_id, title).await {
            Ok(true) => self.notify_frontend(
                "session/update",
                json!({
                    "sessionId": session_id,
                    "update": { "sessionUpdate": "session_info_update", "title": title },
                }),
            ),
            Ok(false) => {}
            Err(error) => log::warn!("[agent-host] failed to store the chat title: {error}"),
        }
    }

    /// Ask the chat's own harness and model for a few-word title in a
    /// throwaway session (see `session_title::naming_session_params`), then
    /// end it: deleted where the bridge keeps sessions and allows that, closed
    /// otherwise. `Ok(None)` when the answer held nothing usable.
    async fn summarize_title(
        &self,
        harness_id: &str,
        account_id: Option<&str>,
        model_id: Option<&str>,
        user_text: &str,
    ) -> Result<Option<String>, Value> {
        let bridge = self.ensure_account_bridge(harness_id, account_id).await?;
        let cwd = dirs::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string());
        let opened = tokio::time::timeout(
            session_title::TITLE_TIMEOUT,
            bridge.request(
                "session/new",
                session_title::naming_session_params(harness_id, &cwd, model_id),
            ),
        )
        .await
        .map_err(|_| protocol::internal("the naming session did not open in time"))??;
        let naming_id = protocol::session_id(&opened)
            .ok_or_else(|| protocol::internal("bridge returned no sessionId"))?;
        let key = Self::naming_key(&account_route_key(harness_id, account_id), &naming_id);
        if let Ok(mut replies) = self.naming_replies.lock() {
            replies.insert(key.clone(), String::new());
            self.activity_generations
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .record(harness_id, account_id);
        }
        let keeps_no_transcript = session_title::keeps_no_transcript(harness_id);
        // Claude Code's naming session is opened on the model
        // (`naming_session_params`); the others take it after opening.
        if let (Some(model_id), false) = (model_id, keeps_no_transcript) {
            let snapshot = Self::snapshot_from(&opened);
            if let Err(error) =
                Self::apply_title_model(&bridge, &naming_id, model_id, &snapshot).await
            {
                log::info!(
                    "[agent-host] the naming session stays on its default model: {}",
                    error_text(&error)
                );
            }
        }
        let asked = tokio::time::timeout(
            session_title::TITLE_TIMEOUT,
            bridge.request(
                "session/prompt",
                json!({
                    "sessionId": naming_id,
                    "prompt": session_title::naming_prompt(user_text),
                }),
            ),
        )
        .await;
        if asked.is_err() {
            bridge.notify("session/cancel", json!({ "sessionId": naming_id }));
        }
        self.drain_bridge_events().await?;
        let reply = self
            .naming_replies
            .lock()
            .ok()
            .and_then(|mut replies| replies.remove(&key))
            .unwrap_or_default();
        let ending = if !keeps_no_transcript && bridge.supports_session_capability("delete") {
            "session/delete"
        } else {
            "session/close"
        };
        let ended = tokio::time::timeout(
            session_title::TITLE_TIMEOUT,
            bridge.request(ending, json!({ "sessionId": naming_id })),
        )
        .await;
        if !matches!(ended, Ok(Ok(_))) {
            log::info!(
                "[agent-host] the naming session {naming_id} did not end cleanly ({ending})"
            );
        }
        match asked {
            Ok(Ok(_)) => Ok(session_title::clean_summary(&reply)),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(protocol::internal("the title summary timed out")),
        }
    }

    /// Put a naming session on the chat's own model and on nothing else. A
    /// title is three words long: it is written by the model the chat runs on
    /// so it reads like the chat, but never at that chat's effort or in its
    /// fast mode, and a stored id that still folds an effort into the model's
    /// name contributes only the model half.
    async fn apply_title_model(
        bridge: &Bridge,
        naming_id: &str,
        model_id: &str,
        snapshot: &Value,
    ) -> Result<Value, Value> {
        if !Self::has_model_option(snapshot) {
            return bridge
                .request(
                    "session/set_model",
                    json!({ "sessionId": naming_id, "modelId": model_id }),
                )
                .await;
        }
        let model_id = Self::split_effort_model(snapshot, model_id)
            .map(|split| split.model)
            .unwrap_or_else(|| model_id.to_string());
        bridge
            .request(
                "session/set_config_option",
                json!({
                    "sessionId": naming_id,
                    "configId": Self::model_option_id(snapshot),
                    "value": model_id,
                }),
            )
            .await
    }

    /// Collect a naming session's reply text (see `summarize_title`).
    fn capture_naming_reply(&self, harness: &str, bridge_session_id: &str, params: &Value) {
        let Some(text) = session_title::agent_message_text(params) else {
            return;
        };
        if let Ok(mut replies) = self.naming_replies.lock() {
            if let Some(reply) = replies.get_mut(&Self::naming_key(harness, bridge_session_id)) {
                reply.push_str(text);
            }
        }
    }

    /// Where the model probe opens its throwaway session. The app's own data
    /// directory, not the user's home: a bridge files a session under its
    /// `cwd`, and the probe has no business appearing in the history of the
    /// directory the user actually works in.
    fn probe_cwd(&self) -> String {
        crate::services::distill_root::app_root(&self.app)
            .ok()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string())
    }

    /// The file that answers for `harness_id` right now: the one its running
    /// bridge was started from while that bridge lives, the one on disk
    /// otherwise. `Null` where the harness is not installed.
    ///
    /// The distinction matters for a CLI updated while its bridge is up: the
    /// old process keeps serving the old models until it exits, and probing
    /// it again would only confirm what the inventory already says.
    pub async fn serving_executable(&self, harness_id: &str, account_id: Option<&str>) -> Value {
        if let Some(bridge) = self
            .live_bridge(&account_route_key(harness_id, account_id))
            .await
        {
            return bridge.executable();
        }
        let Some(spec) = harness::harness(harness_id) else {
            return Value::Null;
        };
        let env = self.spawn_env().await;
        super::bridge::executable_fingerprint(spec, &env).unwrap_or(Value::Null)
    }

    /// Open a throwaway session to learn which models a harness offers and
    /// what each of them can do, then close it. Answers the rows and the
    /// executable of the bridge that listed them, so the inventory can tell
    /// when a later build of the CLI has something else to say.
    ///
    /// The row list is the session's own `model` option: base ids under the
    /// bridge's own names. `models.availableModels` is not the list — codex
    /// builds that array as a display-only cross product of every model with
    /// every effort (`gpt-6-astra[low]` and 30 more), and reading the
    /// inventory from there is where Distill learned to treat an effort as
    /// part of a model id. Each model is then selected in turn so the effort
    /// values and fast toggle recorded against it are its own. No prompt is
    /// ever sent, so nothing runs and nothing is billed.
    pub async fn probe_models(
        self: &Arc<Self>,
        harness_id: &str,
        account_id: Option<&str>,
    ) -> Result<(Vec<Value>, Value), Value> {
        let bridge = self.ensure_account_bridge(harness_id, account_id).await?;
        let probed_on = bridge.executable();
        let mut params = json!({ "cwd": self.probe_cwd(), "mcpServers": [] });
        if let Some(meta) = harness::probe_session_meta(harness_id) {
            params["_meta"] = meta;
        }
        let opened = bridge.request("session/new", params).await?;
        let Some(probe_session) = protocol::session_id(&opened) else {
            log::info!("[agent-host] {harness_id} named no session to probe its models in");
            return Ok((Self::probe_rows(&opened), probed_on));
        };
        let select = |config_id: String, model_id: String| {
            let bridge = Arc::clone(&bridge);
            let session = probe_session.clone();
            async move {
                bridge
                    .request(
                        "session/set_config_option",
                        json!({ "sessionId": session, "configId": config_id, "value": model_id }),
                    )
                    .await
            }
        };
        let close = || {
            let bridge = Arc::clone(&bridge);
            let session = probe_session.clone();
            async move {
                // Closed, never deleted: a session that was never prompted is
                // not persisted, and both bridges answer `session/delete` for
                // one with an error that reads like a leak but is the proof
                // there is nothing to delete.
                let closed = tokio::time::timeout(
                    BRIDGE_CLOSE_TIMEOUT,
                    bridge.request("session/close", json!({ "sessionId": session })),
                )
                .await;
                if !matches!(closed, Ok(Ok(_))) {
                    log::info!("[agent-host] the model probe session {session} did not close");
                }
            }
        };
        Ok((
            Self::probe_model_rows(&opened, select, close).await,
            probed_on,
        ))
    }

    /// Walk a throwaway session's model list. `select` puts the session on
    /// one model and answers with the bridge's refreshed options; `close`
    /// ends the session, and runs whether the walk finished or gave up.
    async fn probe_model_rows<S, SFut, C, CFut>(
        opened: &Value,
        mut select: S,
        close: C,
    ) -> Vec<Value>
    where
        S: FnMut(String, String) -> SFut,
        SFut: std::future::Future<Output = Result<Value, Value>>,
        C: FnOnce() -> CFut,
        CFut: std::future::Future<Output = ()>,
    {
        let mut rows = Self::probe_rows(opened);
        if let Some(config_id) = Self::model_option(opened)
            .and_then(|option| option.get("id"))
            .and_then(Value::as_str)
        {
            for row in rows.iter_mut() {
                let Some(model_id) = row["id"].as_str().map(str::to_string) else {
                    continue;
                };
                match select(config_id.to_string(), model_id.clone()).await {
                    Ok(answer) => Self::record_capabilities(row, &answer),
                    Err(error) => {
                        // Whatever is wrong with the bridge will be wrong for
                        // the rest of the list too; the models already walked
                        // keep what they answered.
                        log::info!(
                            "[agent-host] the model probe stopped at {model_id}: {}",
                            error_text(&error)
                        );
                        break;
                    }
                }
            }
        }
        close().await;
        rows
    }

    fn model_option(snapshot: &Value) -> Option<&Value> {
        snapshot["configOptions"]
            .as_array()?
            .iter()
            .find(|option| Self::is_model_option(option))
    }

    /// The models a freshly opened session offers, before any of them has
    /// been selected: names and ids, plus whatever the bridge already said
    /// about their effort levels.
    fn probe_rows(opened: &Value) -> Vec<Value> {
        let mut rows = Self::probe_row_list(opened, Self::model_option(opened));
        for row in rows.iter_mut() {
            Self::apply_advertised_details(row, opened);
        }
        rows
    }

    /// The models a session offers, as the bridge's own model option lists
    /// them. A bridge with no model option at all still names them in its
    /// `models` block.
    fn probe_row_list(opened: &Value, model_option: Option<&Value>) -> Vec<Value> {
        let listed: Vec<Value> = model_option
            .and_then(|option| option["options"].as_array())
            .map(|choices| {
                choices
                    .iter()
                    .filter_map(|choice| {
                        let value = choice.get("value").and_then(Value::as_str)?;
                        Some(Self::probe_row(
                            value,
                            choice.get("name").and_then(Value::as_str),
                            choice.get("description"),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !listed.is_empty() {
            return listed;
        }
        opened
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| {
                        let id = model.get("modelId").and_then(Value::as_str)?;
                        Some(Self::probe_row(
                            id,
                            model.get("name").and_then(Value::as_str),
                            model.get("description"),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A model nobody has asked anything about yet. An empty effort list next
    /// to `capabilitySource: "unknown"` means exactly that, and never "this
    /// model has no effort control".
    fn probe_row(id: &str, name: Option<&str>, description: Option<&Value>) -> Value {
        json!({
            "id": id,
            "name": name.unwrap_or(id),
            "description": description.cloned().unwrap_or(Value::Null),
            "efforts": [],
            "defaultEffort": Value::Null,
            "supportsFast": Value::Null,
            "capabilitySource": "unknown",
        })
    }

    /// What the session reports after moving to this model: the effort values
    /// it offers, and whether it has a fast toggle at all.
    fn record_capabilities(row: &mut Value, answer: &Value) {
        // An answer with no options at all says nothing about the model; one
        // that lists options without an effort or fast option says the model
        // has none, which is a different thing and has to stay different.
        let Some(options) = answer["configOptions"].as_array() else {
            return;
        };
        let efforts: Vec<Value> = options
            .iter()
            .find(|option| Self::is_effort_option(option))
            .and_then(|option| option["options"].as_array())
            .map(|choices| {
                choices
                    .iter()
                    .filter_map(|choice| {
                        let value = choice.get("value").and_then(Value::as_str)?;
                        Some(harness::effort(
                            value,
                            choice.get("name").and_then(Value::as_str),
                            choice.get("description").and_then(Value::as_str),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !efforts.is_empty() {
            let recommended = options
                .iter()
                .find(|option| Self::is_effort_option(option))
                .and_then(|option| option.pointer("/_meta/jetbrains/air/recommendedValue"))
                .and_then(Value::as_str);
            if let Some(value) = recommended.filter(|value| {
                efforts
                    .iter()
                    .any(|effort| effort["value"].as_str() == Some(value))
            }) {
                row["defaultEffort"] = json!(value);
            }
            row["efforts"] = json!(efforts);
        }
        row["supportsFast"] = json!(options.iter().any(Self::is_fast_option));
        row["capabilitySource"] = json!("probed");
    }

    /// What a bridge says about a model beside its own model option: the
    /// description it only puts in the `models` block, and — for the one
    /// bridge that states it (grok) — the model's effort menu with the
    /// `default: true` flag, the only place any harness names a default.
    fn apply_advertised_details(row: &mut Value, opened: &Value) {
        let Some(model) = opened
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .and_then(|models| {
                models
                    .iter()
                    .find(|model| model["modelId"] == row["id"] && model["modelId"].is_string())
            })
        else {
            return;
        };
        if row["description"].is_null() {
            if let Some(description) = model.get("description").filter(|value| value.is_string()) {
                row["description"] = description.clone();
            }
        }
        let Some(efforts) = model
            .pointer("/_meta/reasoningEfforts")
            .and_then(Value::as_array)
        else {
            return;
        };
        let mut listed = Vec::new();
        let mut default_effort = Value::Null;
        for entry in efforts {
            let Some(value) = entry
                .get("value")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if entry.get("default").and_then(Value::as_bool) == Some(true) {
                default_effort = json!(value);
            }
            listed.push(harness::effort(
                value,
                entry
                    .get("label")
                    .or_else(|| entry.get("name"))
                    .and_then(Value::as_str),
                entry.get("description").and_then(Value::as_str),
            ));
        }
        if listed.is_empty() {
            return;
        }
        row["efforts"] = json!(listed);
        row["defaultEffort"] = default_effort;
        row["capabilitySource"] = json!("probed");
    }

    /// Whether a config option is the model's fast/speed toggle: the
    /// dedicated `fast` option, or a `model_config` on/off select or boolean.
    /// The renderer reads it the same way (`acpSessionConfigSnapshots.ts`),
    /// and the host deliberately does not rename either bridge's own id.
    fn is_fast_option(option: &Value) -> bool {
        let id = option.get("id").and_then(Value::as_str).unwrap_or_default();
        if id != "fast" && option.get("category").and_then(Value::as_str) != Some("model_config") {
            return false;
        }
        match option.get("type").and_then(Value::as_str) {
            Some("boolean") => true,
            Some("select") => {
                id == "fast"
                    || option["options"].as_array().is_some_and(|choices| {
                        let offers =
                            |wanted: &str| choices.iter().any(|choice| choice["value"] == wanted);
                        offers("on") && offers("off")
                    })
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn benchmark_activity_generation_matches_provider_and_account_scope() {
        let mut generations = ActivityGenerations::default();
        generations.record("claude-acp", Some("a"));
        generations.record("codex-acp", Some("a"));
        generations.record("codex-acp", Some("a"));
        assert_eq!(generations.snapshot("claude-acp", "*"), 1);
        assert_eq!(generations.snapshot("claude-acp", "a"), 1);
        generations.record("claude-acp", Some("ab"));
        assert_eq!(generations.snapshot("claude-acp", "a"), 1);
        assert_eq!(generations.snapshot("claude-acp", "*"), 2);
        generations.record("claude-acp", None);
        assert_eq!(generations.snapshot("claude-acp", "*"), 3);
        assert_eq!(generations.snapshot("codex-acp", "*"), 2);
        assert_eq!(generations.snapshot("unknown", "*"), 0);
        assert!(!activity_scope_matches(
            "claude-acp\u{1f}ab",
            "claude-acp",
            "a"
        ));
    }

    #[test]
    fn cli_login_activity_counts_chats_without_an_account() {
        let mut generations = ActivityGenerations::default();
        // A Grok chat runs without an account; a benchmark on the CLI sign-in.
        generations.record("grok-acp", None);
        generations.record("grok-acp", Some("cli-login-grok-acp"));
        assert_eq!(generations.snapshot("grok-acp", "cli-login-grok-acp"), 2);
        assert_eq!(generations.snapshot("grok-acp", "*"), 2);
        assert!(activity_scope_matches(
            "grok-acp",
            "grok-acp",
            "cli-login-grok-acp"
        ));
        // Another provider's identity, or a managed account, never borrows the
        // provider's account-less chats.
        assert!(!activity_scope_matches(
            "grok-acp",
            "grok-acp",
            "cli-login-kimi-acp"
        ));
        assert!(!activity_scope_matches("claude-acp", "claude-acp", "a"));
    }

    /// The idle reaper, a sign-in replacement and a credential change take a
    /// bridge out of the map before it exits; its exit still ends the route
    /// and drops what the host kept for it, unless a replacement serves it.
    #[test]
    fn a_bridge_the_host_stopped_ends_its_route_when_it_exits() {
        assert!(Inner::exit_ends_route(None, 3));
        assert!(Inner::exit_ends_route(Some(3), 3));
        assert!(!Inner::exit_ends_route(Some(4), 3));
    }

    #[test]
    fn a_stopped_owned_grok_bridge_leaves_no_sign_in_copy() {
        let root = tempfile::tempdir().unwrap();
        let runtime = owned_runtime_root(root.path());
        let copy = |harness: &str| runtime.join(harness).join("home").join("auth.json");
        for harness in ["grok-acp", "codex-acp"] {
            std::fs::create_dir_all(copy(harness).parent().unwrap()).unwrap();
            std::fs::write(copy(harness), "{}").unwrap();
        }
        // A chat route is the user's own Grok; nothing there is the host's.
        discard_route_sign_in(&runtime, "grok-acp").unwrap();
        discard_route_sign_in(&runtime, "codex-acp\u{1f}a\u{1f}benchmark:p").unwrap();
        assert!(copy("grok-acp").exists());
        assert!(copy("codex-acp").exists());
        discard_route_sign_in(
            &runtime,
            "grok-acp\u{1f}cli-login-grok-acp\u{1f}benchmark:p",
        )
        .unwrap();
        assert!(!copy("grok-acp").exists());
        // Already gone is fine.
        discard_route_sign_in(
            &runtime,
            "grok-acp\u{1f}cli-login-grok-acp\u{1f}benchmark:p",
        )
        .unwrap();
    }

    #[test]
    fn terminal_error_kind_names_execution_violation() {
        assert_eq!(
            terminal_error_kind(
                "execution_violation: native execution violated the declared no-tool policy"
            ),
            "execution_violation"
        );
        assert_eq!(
            terminal_error_kind(
                "selection_changed: requested benchmark selection was not acknowledged"
            ),
            "selection_changed"
        );
        assert_eq!(
            Inner::owned_violation(Some("tool_call_update"), false),
            Some("native tool activity in no-tool profile")
        );
        assert!(Inner::owned_violation(Some("plan"), false).is_some());
        assert!(Inner::owned_violation(Some("subagent_started"), false).is_some());
        // Grok's extension updates: hook runs and subagents break the policy,
        // its status reports do not.
        assert_eq!(
            Inner::owned_violation(Some("hook_execution"), false),
            Some("native hook activity in no-tool profile")
        );
        assert!(Inner::owned_violation(Some("hook_run_started"), true).is_some());
        assert!(Inner::owned_violation(Some("subagent_spawned"), true).is_some());
        assert_eq!(Inner::owned_violation(Some("session_status"), true), None);
        assert!(Inner::owned_violation(Some("current_mode_update"), true).is_some());
        assert_eq!(
            Inner::owned_violation(Some("current_mode_update"), false),
            None
        );
        assert_eq!(
            Inner::owned_violation(Some("agent_message_chunk"), true),
            None
        );
        assert_eq!(Inner::owned_violation(None, true), None);
    }

    #[test]
    fn owned_prompt_starts_with_the_task_marker() {
        for prompt in ["/plan rewrite everything", "$skill hostile", "plain task"] {
            let blocks = owned_prompt_blocks(
                prompt,
                &[OwnedTurnImage {
                    data: "aW1hZ2U=".into(),
                    mime_type: "image/png".into(),
                }],
            );
            assert_eq!(blocks[0]["type"], "text");
            assert_eq!(
                blocks[0]["text"].as_str(),
                Some(format!("Benchmark task:\n{prompt}").as_str())
            );
            assert_eq!(blocks[1]["type"], "image");
            assert_eq!(blocks.len(), 2);
        }
    }

    /// Grok wraps a prompt in `<user_query>` unless it is sent verbatim; the
    /// other profiles' prompts are what they were.
    #[test]
    fn owned_grok_prompts_go_verbatim() {
        let blocks = owned_prompt_blocks("task", &[]);
        let grok = owned_prompt_params("s", blocks.clone(), "o", Some(NativeProvider::Grok));
        assert_eq!(
            grok["_meta"],
            json!({"verbatim": true, "executionOwner": {"kind": "benchmark", "id": "o"}})
        );
        assert_eq!(grok["prompt"], json!(blocks));
        assert_eq!(grok["sessionId"], "s");
        for provider in [
            Some(NativeProvider::Claude),
            Some(NativeProvider::Codex),
            Some(NativeProvider::Kimi),
            None,
        ] {
            assert_eq!(
                serde_json::to_string(&owned_prompt_params("s", blocks.clone(), "o", provider))
                    .unwrap(),
                serde_json::to_string(&json!({"sessionId":"s","prompt":blocks,"_meta":{"executionOwner":{"kind":"benchmark","id":"o"}}}))
                    .unwrap(),
                "{provider:?}"
            );
        }
    }

    #[tokio::test]
    async fn owned_runtime_registration_drains_intermediate_setup_notifications() {
        let sessions = Arc::new(Mutex::new(SessionTable::default()));
        let routed = Arc::new(StdMutex::new(Vec::new()));
        let (events, mut received) = mpsc::unbounded_channel();
        let receiver_sessions = sessions.clone();
        let receiver_routed = routed.clone();
        let mut final_runtime = runtime("claude-acp", "native-owned", 71);
        final_runtime.account_id = Some("a".into());
        final_runtime.execution_profile = Some("text".into());
        final_runtime.snapshot = json!({"configOptions":[{"id":"effort","currentValue":"high"}]});
        let route = final_runtime.route_key();
        let worker = tokio::spawn(async move {
            while let Some(event) = received.recv().await {
                match event {
                    BridgeEvent::Notification {
                        harness,
                        generation,
                        params,
                        ..
                    } => {
                        let table = receiver_sessions.lock().await;
                        let target = table.host_session_for_generation(
                            &harness,
                            generation,
                            params["sessionId"].as_str().unwrap(),
                        );
                        receiver_routed
                            .lock()
                            .unwrap()
                            .push((params["update"]["stage"].clone(), target.is_some()));
                    }
                    BridgeEvent::Drained { ack } => {
                        let _ = ack.send(Ok(()));
                    }
                    _ => unreachable!(),
                }
            }
        });
        let notification = |stage: &str| BridgeEvent::Notification {
            harness: route.clone(),
            generation: 71,
            run_id: None,
            method: "session/update".into(),
            params: json!({"sessionId":"native-owned","update":{"sessionUpdate":"config_option_update","stage":stage}}),
        };
        events.send(notification("default effort")).unwrap();
        events.send(notification("selected effort")).unwrap();
        install_owned_runtime(&events, &sessions, "owned".into(), final_runtime)
            .await
            .unwrap();
        events.send(notification("later selection change")).unwrap();
        drain_queued_bridge_events(&events).await.unwrap();
        assert_eq!(
            *routed.lock().unwrap(),
            vec![
                (json!("default effort"), false),
                (json!("selected effort"), false),
                (json!("later selection change"), true),
            ]
        );
        assert_eq!(
            sessions.lock().await.get("owned").unwrap().snapshot["configOptions"][0]
                ["currentValue"],
            "high"
        );
        drop(events);
        worker.await.unwrap();
    }

    #[tokio::test]
    async fn owned_runtime_is_not_registered_when_setup_barrier_fails() {
        let (events, received) = mpsc::unbounded_channel();
        drop(received);
        let sessions = Mutex::new(SessionTable::default());
        assert!(install_owned_runtime(
            &events,
            &sessions,
            "owned".into(),
            runtime("claude-acp", "s", 1)
        )
        .await
        .is_err());
        assert!(sessions.lock().await.get("owned").is_none());
    }

    #[tokio::test]
    async fn failed_history_batch_retains_the_uncommitted_suffix_for_retry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.db");
        let store = SessionStore::open(&path).await.unwrap();
        for id in ["a", "b"] {
            let record: SessionRecord = serde_json::from_value(json!({
                "id": id, "harness": "goose", "cwd": "C:\\work", "user_set_name": false,
                "hidden": false, "created_at": now_iso(), "updated_at": now_iso(), "message_count": 0
            })).unwrap();
            store.insert_session(&record).await.unwrap();
        }
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER fail_append BEFORE INSERT ON session_events WHEN NEW.session_id = 'b' BEGIN SELECT RAISE(FAIL, 'simulated full disk'); END")
            .execute(&pool).await.unwrap();
        let mut pending = vec![
            ("a".into(), json!({"n":1})),
            ("b".into(), json!({"n":2})),
            ("a".into(), json!({"n":3})),
        ];
        assert!(
            Inner::persist_pending_events(&store, &mut pending, |_, _| {})
                .await
                .is_err()
        );
        assert_eq!(pending.len(), 2);
        assert_eq!(store.list_events("a").await.unwrap(), vec![json!({"n":1})]);
        assert!(store.list_events("b").await.unwrap().is_empty());
        sqlx::query("DROP TRIGGER fail_append")
            .execute(&pool)
            .await
            .unwrap();
        Inner::persist_pending_events(&store, &mut pending, |_, _| {})
            .await
            .unwrap();
        assert!(pending.is_empty());
        assert_eq!(
            store.list_events("a").await.unwrap(),
            vec![json!({"n":1}), json!({"n":3})]
        );
        assert_eq!(store.list_events("b").await.unwrap(), vec![json!({"n":2})]);
    }

    fn ids() -> TurnIds {
        TurnIds {
            run_id: "run-1".to_string(),
            message_id: "user-1".to_string(),
            assistant_message_id: "reply-1".to_string(),
        }
    }

    #[test]
    fn a_prompt_runs_under_the_message_id_the_renderer_named() {
        let mut params = json!({
            "sessionId": "s1",
            "prompt": [],
            "_meta": { "messageId": "renderer-m1", "personaId": "p1" }
        });
        let ids = TurnIds::for_prompt(&mut params);
        assert_eq!(ids.message_id, "renderer-m1");
        // The name was for the host; the bridge sees the rest of the meta.
        assert!(params["_meta"].get("messageId").is_none());
        assert_eq!(params["_meta"]["personaId"], "p1");
        assert_ne!(ids.assistant_message_id, ids.message_id);

        // No name, a blank one, or one too long to be an id: the host's own.
        let mut unnamed = json!({ "sessionId": "s1", "prompt": [] });
        assert!(!TurnIds::for_prompt(&mut unnamed).message_id.is_empty());
        let mut blank = json!({ "_meta": { "messageId": "   " } });
        assert!(!TurnIds::for_prompt(&mut blank).message_id.trim().is_empty());
        let mut long = json!({ "_meta": { "messageId": "x".repeat(129) } });
        assert_ne!(TurnIds::for_prompt(&mut long).message_id, "x".repeat(129));
    }

    #[test]
    fn xai_turn_completed_becomes_message_usage() {
        let mut params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "turn_completed",
                "stop_reason": "end_turn",
                "usage": {
                    "inputTokens": 17042,
                    "outputTokens": 168,
                    "totalTokens": 17210,
                    "cachedReadTokens": 2944,
                    "cacheCreationTokens": 0,
                    "reasoningTokens": 159,
                    "modelCalls": 1,
                    "apiDurationMs": 3899,
                    "costUsdTicks": 104_298_400u64
                }
            }
        });
        assert!(Inner::normalize_xai_turn_usage(
            "_x.ai/session/update",
            &mut params
        ));
        let usage = &params["update"]["usage"];
        assert_eq!(params["update"]["sessionUpdate"], "message_usage");
        assert_eq!(params["sessionId"], "s1");
        assert_eq!(usage["inputTokens"], 14098);
        assert_eq!(usage["outputTokens"], 168);
        assert_eq!(usage["cacheReadTokens"], 2944);
        assert_eq!(usage["cacheWriteTokens"], 0);
        assert_eq!(usage["elapsedMs"], 3899);
        assert!(usage.get("cost").is_none());
        // The raw usage is kept whole for benchmarks.
        let raw = &params["update"]["_meta"]["xaiTurnUsage"];
        assert_eq!(raw["costUsdTicks"], 104_298_400u64);
        assert_eq!(raw["reasoningTokens"], 159);
        assert_eq!(raw["modelCalls"], 1);
        assert_eq!(raw["inputTokens"], 17042);
    }

    /// Grok 1.0.40 reports the turn on `_x.ai/session_notification` (seen in
    /// the policy probe), not on `_x.ai/session/update`.
    #[test]
    fn grok_turn_completed_notification_becomes_message_usage() {
        let mut params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "turn_completed",
                "prompt_id": "p",
                "stop_reason": "end_turn",
                "usage": {
                    "inputTokens": 10,
                    "outputTokens": 5,
                    "totalTokens": 15,
                    "cachedReadTokens": 2,
                    "cacheCreationTokens": 0,
                    "reasoningTokens": 1,
                    "modelCalls": 1,
                    "apiDurationMs": 8
                }
            }
        });
        assert!(Inner::normalize_xai_turn_usage(
            "_x.ai/session_notification",
            &mut params
        ));
        assert_eq!(params["update"]["sessionUpdate"], "message_usage");
        assert_eq!(params["update"]["usage"]["inputTokens"], 8);
        assert_eq!(params["update"]["usage"]["cacheReadTokens"], 2);
        assert_eq!(
            params["update"]["_meta"]["xaiTurnUsage"]["reasoningTokens"],
            1
        );
        // Its other session events stay grok's own.
        let mut retry = json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "retry_state", "attempt": 1 }
        });
        assert!(!Inner::normalize_xai_turn_usage(
            "_x.ai/session_notification",
            &mut retry
        ));
        assert_eq!(retry["update"]["sessionUpdate"], "retry_state");
        // Both channels are kept as evidence of an owned session.
        assert!(Inner::is_xai_session_extension(
            "_x.ai/session_notification"
        ));
        assert!(Inner::is_xai_session_extension("_x.ai/session/update"));
        assert!(!Inner::is_xai_session_extension("_x.ai/sessions/changed"));
    }

    #[test]
    fn other_xai_updates_and_standard_methods_pass_through_unclaimed() {
        let mut hook = json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "hook_execution", "event_name": "session_start" }
        });
        assert!(!Inner::normalize_xai_turn_usage(
            "_x.ai/session/update",
            &mut hook
        ));
        assert_eq!(hook["update"]["sessionUpdate"], "hook_execution");

        let mut standard = json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "turn_completed", "usage": { "inputTokens": 5 } }
        });
        assert!(!Inner::normalize_xai_turn_usage(
            "session/update",
            &mut standard
        ));
        assert_eq!(standard["update"]["sessionUpdate"], "turn_completed");
    }

    #[test]
    fn a_steered_prompt_is_recorded_as_a_steer_under_its_acknowledged_ids() {
        let prompt = json!([
            { "type": "text", "text": "skill", "annotations": { "audience": ["assistant"] } },
            { "type": "text", "text": "also check the tests" }
        ]);
        let events = Inner::user_prompt_events(
            "s1",
            &prompt,
            &json!({ "personaId": "p1" }),
            &ids(),
            "2026-09-11T00:00:00.000Z",
            true,
        );
        assert_eq!(events.len(), 2);
        for event in &events {
            assert_eq!(event["sessionId"], "s1");
            assert_eq!(event["update"]["sessionUpdate"], "user_message_chunk");
            let distill = &event["update"]["_meta"]["distill"];
            assert_eq!(distill["messageId"], "user-1");
            assert_eq!(distill["runId"], "run-1");
            assert_eq!(distill["steer"], true);
            assert_eq!(distill["personaId"], "p1");
        }
        assert_eq!(
            events[1]["update"]["content"]["text"],
            "also check the tests"
        );
    }

    fn said(kind: &str, message_id: &str, content: Value) -> Value {
        json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": kind,
                "content": content,
                "_meta": { "distill": { "messageId": message_id } },
            }
        })
    }

    fn carried_text(events: &[Value]) -> String {
        let block = Inner::carryover_block(events).expect("a transcript");
        assert_eq!(block["annotations"]["audience"], json!(["assistant"]));
        block["text"].as_str().expect("text").to_string()
    }

    #[test]
    fn a_chat_that_changes_agents_takes_what_was_said_and_nothing_else() {
        let events = vec![
            said(
                "user_message_chunk",
                "m1",
                json!({ "type": "text", "text": "persona", "annotations": { "audience": ["assistant"] } }),
            ),
            said(
                "user_message_chunk",
                "m1",
                json!({ "type": "text", "text": "rename the crate" }),
            ),
            said(
                "agent_thought_chunk",
                "m1",
                json!({ "type": "text", "text": "hmm" }),
            ),
            said(
                "agent_message_chunk",
                "m1",
                json!({ "type": "text", "text": "Renam" }),
            ),
            said(
                "agent_message_chunk",
                "m1",
                json!({ "type": "text", "text": "ing." }),
            ),
            json!({ "sessionId": "s1", "update": {
                "sessionUpdate": "tool_call", "title": "Edit Cargo.toml", "toolCallId": "t1",
                "_meta": { "distill": { "messageId": "m1" } },
            }}),
            said(
                "agent_message_chunk",
                "m1",
                json!({ "type": "text", "text": "Done." }),
            ),
            said(
                "user_message_chunk",
                "m2",
                json!({ "type": "text", "text": "and the tests?" }),
            ),
            said(
                "user_message_chunk",
                "m3",
                json!({ "type": "text", "text": "hello?" }),
            ),
        ];
        let messages = Inner::carryover_messages(&events);
        assert_eq!(
            messages,
            vec![
                (true, "rename the crate".to_string()),
                (
                    false,
                    "Renaming.\n[ran a tool: Edit Cargo.toml]\nDone.".to_string()
                ),
                // Two prompts in a row are two messages, not one.
                (true, "and the tests?".to_string()),
                (true, "hello?".to_string()),
            ]
        );
        let text = carried_text(&events);
        assert!(text.starts_with(CARRYOVER_OPENING));
        assert!(!text.contains("persona"));
        assert!(!text.contains("hmm"));
        assert!(text.contains("## User\n\nrename the crate\n\n## Previous agent\n\nRenaming."));
        assert!(!text.contains("left out"));
    }

    #[test]
    fn a_chat_in_which_nothing_was_said_has_nothing_to_hand_over() {
        let events = vec![said(
            "user_message_chunk",
            "m1",
            json!({ "type": "text", "text": "skill", "annotations": { "audience": ["assistant"] } }),
        )];
        assert_eq!(Inner::carryover_block(&events), None);
    }

    #[test]
    fn a_long_conversation_hands_over_its_newest_messages_and_says_what_it_left_out() {
        let long = "й".repeat(CARRYOVER_MESSAGE_CHARS * 2);
        let shortened = Inner::shortened(&long, CARRYOVER_MESSAGE_CHARS);
        assert!(shortened.contains(&format!("{CARRYOVER_MESSAGE_CHARS} characters left out")));
        assert_eq!(
            shortened.chars().filter(|letter| *letter == 'й').count(),
            CARRYOVER_MESSAGE_CHARS
        );

        let turns = CARRYOVER_BUDGET_CHARS / CARRYOVER_MESSAGE_CHARS + 5;
        let events: Vec<Value> = (0..turns)
            .map(|turn| {
                said(
                    "user_message_chunk",
                    &format!("m{turn}"),
                    json!({ "type": "text", "text": format!("turn {turn} {long}") }),
                )
            })
            .collect();
        let text = carried_text(&events);
        assert!(text.contains(&format!("turn {} ", turns - 1)));
        assert!(!text.contains("turn 0 "));
        assert!(text.contains("earlier message(s) left out"));
        assert!(text.chars().count() < CARRYOVER_BUDGET_CHARS + CARRYOVER_MESSAGE_CHARS);
    }

    #[test]
    fn an_earlier_hand_over_a_bridge_echoed_back_is_not_handed_over_again() {
        let echoed = carried_text(&[said(
            "user_message_chunk",
            "m1",
            json!({ "type": "text", "text": "first" }),
        )]);
        let events = vec![
            said(
                "user_message_chunk",
                "m1",
                json!({ "type": "text", "text": "first" }),
            ),
            said(
                "user_message_chunk",
                "m2",
                json!({ "type": "text", "text": echoed }),
            ),
            said(
                "user_message_chunk",
                "m2",
                json!({ "type": "text", "text": "second" }),
            ),
        ];
        assert_eq!(
            Inner::carryover_messages(&events),
            vec![(true, "first".to_string()), (true, "second".to_string())]
        );
    }

    #[test]
    fn the_transcript_goes_ahead_of_what_the_user_just_sent() {
        let block = json!({ "type": "text", "text": "history" });
        let prompt = json!([{ "type": "text", "text": "go on" }]);
        assert_eq!(
            Inner::prompt_after(&block, &prompt),
            json!([{ "type": "text", "text": "history" }, { "type": "text", "text": "go on" }])
        );
    }

    #[test]
    fn an_ordinary_prompt_is_not_marked_as_a_steer() {
        let events = Inner::user_prompt_events(
            "s1",
            &json!([{ "type": "text", "text": "hi" }]),
            &json!({}),
            &ids(),
            "2026-09-11T00:00:00.000Z",
            false,
        );
        assert_eq!(events.len(), 1);
        assert!(events[0]["update"]["_meta"]["distill"]
            .get("steer")
            .is_none());
    }

    #[test]
    fn agent_updates_of_a_turn_name_the_reply_apart_from_the_prompt() {
        let mut run = RunState::start(&ids());
        let mut chunk = json!({
            "sessionId": "bridge-1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hello" },
                "_meta": { "claudeCode": { "parentToolUseId": null } },
            }
        });
        Inner::stamp_run_update(&mut chunk, &mut run, "2026-09-11T00:00:00.000Z");
        let meta = &chunk["update"]["_meta"];
        assert_eq!(meta["distill"]["messageId"], "user-1");
        assert_eq!(meta["distill"]["assistantMessageId"], "reply-1");
        assert_eq!(meta["distill"]["runId"], "run-1");
        assert!(meta.get("claudeCode").is_some());
        assert!(run.saw_agent_message);
        assert_eq!(run.agent_text, "hello");

        let mut tool = json!({
            "update": { "sessionUpdate": "tool_call", "toolCallId": "t1" }
        });
        Inner::stamp_run_update(&mut tool, &mut run, "2026-09-11T00:00:00.000Z");
        assert_eq!(
            tool["update"]["_meta"]["distill"]["assistantMessageId"],
            "reply-1"
        );
    }

    #[test]
    fn a_user_chunk_of_a_turn_keeps_only_the_prompt_id() {
        let mut run = RunState::start(&ids());
        let mut echo = json!({
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": { "type": "text", "text": "hi" },
            }
        });
        Inner::stamp_run_update(&mut echo, &mut run, "2026-09-11T00:00:00.000Z");
        let distill = &echo["update"]["_meta"]["distill"];
        assert_eq!(distill["messageId"], "user-1");
        assert!(distill.get("assistantMessageId").is_none());
        assert!(!run.saw_agent_message);
    }

    #[test]
    fn a_restated_command_list_is_not_a_transcript_event() {
        assert!(Inner::is_command_list_update(&json!({
            "sessionId": "bridge-1",
            "update": { "sessionUpdate": "available_commands_update", "availableCommands": [] },
        })));
        assert!(!Inner::is_command_list_update(&json!({
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "available_commands_update" },
            }
        })));
        assert!(!Inner::is_command_list_update(&json!({})));
    }

    fn air_failure(category: &str, actions: Value) -> Value {
        json!({"jetbrains":{"air":{"version":1,"sessionFailure":{
            "id":"turn-1:error", "revision":1, "category":category,
            "severity":"error", "title":"Provider condition", "actions":actions
        }}}})
    }

    #[test]
    fn negotiated_terminal_failure_is_an_error_and_only_quota_policy_can_rotate() {
        let quota = Inner::prompt_response(Ok(
            json!({"stopReason":"end_turn","_meta":air_failure("limit",json!([]))}),
        ))
        .unwrap_err();
        assert!(crate::services::provider_account_status::is_quota_error(
            &quota
        ));
        assert_eq!(quota["data"]["sessionFailure"]["id"], "turn-1:error");
        for (category, actions) in [
            ("limit", json!(["retry"])),
            ("limit", json!(["new_session"])),
            ("service", json!(["retry"])),
        ] {
            let error = Inner::prompt_response(Ok(
                json!({"stopReason":"end_turn","_meta":air_failure(category,actions)}),
            ))
            .unwrap_err();
            assert!(!crate::services::provider_account_status::is_quota_error(
                &error
            ));
        }
        let mut warning = air_failure("limit", json!([]));
        warning["jetbrains"]["air"]["sessionFailure"]["severity"] = json!("warning");
        assert!(
            Inner::prompt_response(Ok(json!({"stopReason":"end_turn","_meta":warning}))).is_ok()
        );
        assert!(Inner::prompt_response(Ok(json!({"stopReason":"end_turn"}))).is_ok());
    }

    #[test]
    fn failure_metadata_and_zero_usage_do_not_turn_a_rejection_into_model_activity() {
        let metadata = json!({"update":{"sessionUpdate":"session_info_update","_meta":air_failure("limit",json!([]))}});
        assert!(Inner::is_failure_state_update(&metadata));
        let zero_usage = json!({"update":{"sessionUpdate":"usage_update","used":0,"size":200000,"cost":{"amount":0,"currency":"USD"}}});
        assert!(Inner::is_zero_usage_update(&zero_usage));
        for kind in [
            "user_message_chunk",
            "agent_message_chunk",
            "agent_thought_chunk",
            "tool_call",
            "tool_call_update",
            "plan",
        ] {
            let mut substantive = json!({"update":{"sessionUpdate":kind,"content":{"type":"text","text":"usage limit"},"_meta":air_failure("limit",json!([]))}});
            assert!(!Inner::is_failure_state_update(&substantive));
            assert!(!Inner::is_zero_usage_update(&substantive));
            let mut run = RunState::start(&ids());
            Inner::stamp_run_update(&mut substantive, &mut run, "2026-09-28T00:00:00Z");
            assert!(run.saw_update, "{kind} must prevent automatic replay");
        }
        let mut positive = zero_usage.clone();
        positive["update"]["used"] = json!(1);
        assert!(!Inner::is_zero_usage_update(&positive));
        positive["update"]["used"] = json!(0);
        positive["update"]["cost"]["amount"] = json!(0.01);
        assert!(!Inner::is_zero_usage_update(&positive));
        let mut with_content = metadata;
        with_content["update"]["content"] = json!({"type":"text","text":"actual content"});
        assert!(!Inner::is_failure_state_update(&with_content));
    }

    #[test]
    fn manual_routing_parks_a_quota_rejection_only_after_proven_prompt_rollback() {
        let rejected = json!({"code":-32603,"data":{
            "errorKind":"quota_exhausted", "accountId":"saved-account",
            "dispatchStarted":false, "promptNotAccepted":true,
        }});
        let wait = Inner::rejected_quota_wait(&rejected, None).unwrap();
        assert_eq!(wait["code"], -32010);
        assert_eq!(wait["data"]["type"], "account_quota_wait");
        assert_eq!(wait["data"]["accountId"], "saved-account");
        assert_eq!(wait["data"]["promptNotAccepted"], true);
        let known_wait = Inner::quota_wait_error(
            "saved-account",
            Some(1900000000000),
            true,
            &std::collections::HashSet::new(),
        );
        assert_eq!(
            Inner::rejected_quota_wait(&rejected, Some(known_wait.clone())),
            Some(known_wait)
        );
        let mut partial = rejected.clone();
        partial["data"]["dispatchStarted"] = json!(true);
        assert!(Inner::rejected_quota_wait(&partial, None).is_none());
        partial = rejected.clone();
        partial["data"]["promptNotAccepted"] = json!(false);
        assert!(Inner::rejected_quota_wait(&partial, None).is_none());
        partial = rejected;
        partial["data"]["errorKind"] = json!("rate_limit");
        assert!(Inner::rejected_quota_wait(&partial, None).is_none());
    }

    #[test]
    fn one_write_puts_a_session_on_a_model_and_a_legacy_folded_id_still_arrives() {
        // The whole story: the bridge's own option id, the bridge's own model
        // id, one call.
        let codex = codex_session();
        assert_eq!(
            Inner::model_write(&codex, "gpt-5.5"),
            ModelWrite::ConfigOption {
                config_id: "model".to_string(),
                model: "gpt-5.5".to_string(),
            }
        );

        // A stored id from before the split still reaches `apply_model` inside
        // a send, and is sent as the two values the bridge keeps apart.
        assert_eq!(
            Inner::model_write(&codex, "gpt-5.5[low]"),
            ModelWrite::Folded(SplitModel {
                model: "gpt-5.5".to_string(),
                effort_option: "reasoning_effort".to_string(),
                effort: "low".to_string(),
            })
        );

        // Only a folded id whose BOTH halves the bridge offers is split. An
        // effort it does not advertise is not one, so the id goes out whole
        // and the bridge answers for itself rather than the host inventing a
        // pair of writes out of a model's name.
        assert_eq!(
            Inner::model_write(&codex, "gpt-5.5[ultra]"),
            ModelWrite::ConfigOption {
                config_id: "model".to_string(),
                model: "gpt-5.5[ultra]".to_string(),
            }
        );

        // `[1m]` is a context lane, not an effort: claude's own model option
        // lists the id, so it is never taken apart.
        assert_eq!(
            Inner::model_write(&claude_session(), "opus[1m]"),
            ModelWrite::ConfigOption {
                config_id: "model".to_string(),
                model: "opus[1m]".to_string(),
            }
        );

        // The older method is reached only by a bridge with no model option:
        // codex's `unstable_setSessionModel` requires `model[effort]` and
        // throws on a base id, so it must never see one.
        let optionless = json!({
            "models": { "currentModelId": "some-model", "availableModels": [{ "modelId": "some-model" }] },
            "configOptions": [],
        });
        assert_eq!(
            Inner::model_write(&optionless, "some-model"),
            ModelWrite::SetModel
        );
        for id in ["gpt-5.5", "gpt-5.5[low]", "gpt-5.5[ultra]"] {
            assert_ne!(Inner::model_write(&codex, id), ModelWrite::SetModel);
        }
    }

    #[test]
    fn a_model_reaches_the_renderer_under_the_name_its_own_bridge_gave_it() {
        // codex names one model two ways: `gpt-6-astra` in the option it takes
        // writes on, and `gpt-6-astra[xhigh]` in the display block whose rows
        // are every model crossed with every effort. The host used to present
        // the folded one, which is how an effort click came to read as a model
        // change everywhere above it.
        let snapshot = codex_session();
        let presented = Inner::presented_snapshot("codex-acp", &snapshot, true);
        let option = |id: &str| {
            presented["configOptions"]
                .as_array()
                .expect("options")
                .iter()
                .find(|option| option["id"] == id)
                .expect("option")
                .clone()
        };
        assert_eq!(option("model")["currentValue"], "gpt-6-astra");
        // The effort stays where its bridge keeps it.
        assert_eq!(option("reasoning_effort")["currentValue"], "xhigh");
        // Every option the bridge stated is presented exactly as it stated it,
        // behind the synthesized provider option the renderer reads the agent
        // from.
        assert_eq!(presented["configOptions"][0]["id"], "provider");
        assert_eq!(
            presented["configOptions"]
                .as_array()
                .expect("options")
                .iter()
                .skip(1)
                .cloned()
                .collect::<Vec<_>>(),
            snapshot["configOptions"]
                .as_array()
                .cloned()
                .expect("stated"),
        );

        // And a bridge's own notification passes through unrewritten.
        let params = json!({
            "sessionId": "s",
            "update": {
                "sessionUpdate": "config_option_update",
                "configOptions": snapshot["configOptions"].clone(),
            }
        });
        assert_eq!(
            Inner::config_option_update(&params),
            snapshot["configOptions"]
                .as_array()
                .cloned()
                .map(Value::Array),
        );
    }

    /// A session as codex-acp opens one: base ids in the model option, and a
    /// `models` block whose 31 rows are every model crossed with every
    /// effort. The probe must read the option and ignore the block.
    fn codex_session() -> Value {
        json!({
            "sessionId": "probe-1",
            "models": {
                "currentModelId": "gpt-6-astra[xhigh]",
                "availableModels": [
                    { "modelId": "gpt-6-astra[low]", "name": "GPT-6-Astra (low)" },
                    { "modelId": "gpt-6-astra[ultra]", "name": "GPT-6-Astra (ultra)" },
                    { "modelId": "gpt-5.5[xhigh]", "name": "GPT-5.5 (xhigh)" },
                ]
            },
            "configOptions": [
                {
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "gpt-6-astra",
                    "options": [
                        { "value": "gpt-6-astra", "name": "GPT-6-Astra", "description": "Our most capable model." },
                        { "value": "gpt-5.5", "name": "GPT-5.5" },
                        { "value": "gpt-5.3-codex-spark", "name": "GPT-5.3-Codex-Spark" },
                    ]
                },
                { "id": "reasoning_effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "low", "name": "Low" }] },
                { "id": "fast-mode", "category": "model_config", "type": "select", "currentValue": "off", "options": [{ "value": "on" }, { "value": "off" }] },
            ]
        })
    }

    /// What codex answers when a model is selected: the full option array,
    /// rebuilt for that model.
    fn codex_answer(efforts: &[&str], fast: bool) -> Value {
        let mut options = vec![
            json!({ "id": "model", "category": "model", "type": "select" }),
            json!({
                "id": "reasoning_effort",
                "category": "thought_level",
                "type": "select",
                "options": efforts
                    .iter()
                    .map(|value| json!({ "value": value, "name": value }))
                    .collect::<Vec<_>>(),
            }),
        ];
        if fast {
            options.push(json!({
                "id": "fast-mode",
                "category": "model_config",
                "type": "select",
                "options": [{ "value": "on" }, { "value": "off" }],
            }));
        }
        json!({ "configOptions": options })
    }

    fn effort_values(row: &Value) -> Vec<&str> {
        row["efforts"]
            .as_array()
            .expect("efforts")
            .iter()
            .filter_map(|effort| effort["value"].as_str())
            .collect()
    }

    #[tokio::test]
    async fn the_model_list_is_the_model_option_and_never_the_folded_cross_product() {
        let opened = codex_session();
        let asked = StdMutex::new(Vec::new());
        let closed = StdMutex::new(false);
        let rows = Inner::probe_model_rows(
            &opened,
            |config_id, model_id| {
                asked
                    .lock()
                    .expect("asked")
                    .push(format!("{config_id}={model_id}"));
                async move {
                    Ok(match model_id.as_str() {
                        "gpt-6-astra" => {
                            codex_answer(&["low", "medium", "high", "xhigh", "max", "ultra"], true)
                        }
                        "gpt-5.5" => codex_answer(&["low", "medium", "high", "xhigh"], true),
                        _ => codex_answer(&["low", "medium", "high", "xhigh"], false),
                    })
                }
            },
            || async {
                *closed.lock().expect("closed") = true;
            },
        )
        .await;

        let ids: Vec<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
        assert_eq!(ids, ["gpt-6-astra", "gpt-5.5", "gpt-5.3-codex-spark"]);
        assert!(
            !ids.iter().any(|id| id.contains('[')),
            "no folded id survives the probe"
        );
        assert_eq!(rows[0]["name"], "GPT-6-Astra");
        assert_eq!(rows[0]["description"], "Our most capable model.");
        assert_eq!(
            *asked.lock().expect("asked"),
            [
                "model=gpt-6-astra",
                "model=gpt-5.5",
                "model=gpt-5.3-codex-spark",
            ]
        );

        // Each model's own effort set, not the session's current one.
        assert_eq!(
            effort_values(&rows[0]),
            ["low", "medium", "high", "xhigh", "max", "ultra"]
        );
        assert_eq!(effort_values(&rows[1]), ["low", "medium", "high", "xhigh"]);
        assert_eq!(rows[0]["supportsFast"], true);
        // Spark's fast option disappears from the array while it is current.
        assert_eq!(rows[2]["supportsFast"], false);
        assert_eq!(rows[2]["capabilitySource"], "probed");
        assert!(
            *closed.lock().expect("closed"),
            "the probe session is closed"
        );
    }

    #[tokio::test]
    async fn a_probe_that_gives_up_still_closes_its_session() {
        let opened = codex_session();
        let closed = StdMutex::new(false);
        let rows = Inner::probe_model_rows(
            &opened,
            |_, model_id| async move {
                if model_id == "gpt-6-astra" {
                    Ok(codex_answer(&["low", "medium"], true))
                } else {
                    Err(protocol::internal("the bridge went away"))
                }
            },
            || async {
                *closed.lock().expect("closed") = true;
            },
        )
        .await;

        assert!(*closed.lock().expect("closed"), "closed on the error path");
        // The list survives the failure; what was never asked stays unknown,
        // which is not the same as having no effort control.
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["capabilitySource"], "probed");
        assert_eq!(rows[1]["capabilitySource"], "unknown");
        assert_eq!(rows[1]["supportsFast"], Value::Null);
        assert!(effort_values(&rows[1]).is_empty());
    }

    #[test]
    fn codex_recommended_effort_is_kept_only_when_offered() {
        let mut row = Inner::probe_row("gpt-6-sol", Some("6 Sol"), None);
        for (recommended, expected) in [("ultra", json!("ultra")), ("unsupported", Value::Null)] {
            row["defaultEffort"] = Value::Null;
            Inner::record_capabilities(
                &mut row,
                &json!({ "configOptions": [{
                "id": "reasoning_effort", "category": "thought_level", "type": "select",
                "options": [{"value": "high", "name": "High"}, {"value": "ultra", "name": "Ultra"}],
                "_meta": {"jetbrains": {"air": {"recommendedValue": recommended}}}
            }] }),
            );
            assert_eq!(row["defaultEffort"], expected);
        }
    }

    #[tokio::test]
    async fn grok_keeps_the_effort_menu_and_default_it_states_in_model_meta() {
        let opened = json!({
            "sessionId": "probe-1",
            "models": {
                "currentModelId": "grok-4.6",
                "availableModels": [
                    {
                        "modelId": "grok-4.6",
                        "name": "Grok 4.6",
                        "description": "SpaceXAI's latest frontier model",
                        "_meta": { "reasoningEfforts": [
                            { "id": "xhigh", "value": "xhigh", "label": "Extra High Effort", "default": false },
                            { "id": "high", "value": "high", "label": "High Effort", "default": true },
                        ] }
                    },
                    {
                        "modelId": "grok-4.5",
                        "name": "Grok 4.5",
                        "_meta": { "reasoningEfforts": [
                            { "id": "high", "value": "high", "label": "High Effort", "default": true },
                        ] }
                    },
                ]
            },
            "configOptions": [
                {
                    "id": "model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "grok-4.6",
                    "options": [{ "value": "grok-4.6", "name": "Grok 4.6" }, { "value": "grok-4.5", "name": "Grok 4.5" }]
                },
                { "id": "reasoning_effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "xhigh" }] },
            ]
        });
        let rows = Inner::probe_model_rows(
            &opened,
            |_, model_id| async move {
                let efforts: Vec<Value> = if model_id == "grok-4.6" {
                    vec![json!({ "value": "xhigh", "name": "Extra High Effort" })]
                } else {
                    vec![json!({ "value": "high", "name": "High Effort" })]
                };
                Ok(json!({ "configOptions": [
                    { "id": "model", "category": "model", "type": "select" },
                    { "id": "reasoning_effort", "category": "thought_level", "type": "select", "options": efforts },
                ] }))
            },
            || async {},
        )
        .await;

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["defaultEffort"], "high");
        assert_eq!(rows[1]["defaultEffort"], "high");
        // The model option carries no description; the models block does.
        assert_eq!(rows[0]["description"], "SpaceXAI's latest frontier model");
        // The selected model's own menu wins over the advertised one.
        assert_eq!(effort_values(&rows[0]), ["xhigh"]);
        // Grok has no fast mode anywhere, and says so rather than shrugging.
        assert_eq!(rows[0]["supportsFast"], false);
        assert_eq!(rows[0]["capabilitySource"], "probed");
    }

    #[tokio::test]
    async fn a_context_lane_in_a_model_id_is_left_alone() {
        let opened = json!({
            "sessionId": "probe-1",
            "configOptions": [
                {
                    "id": "model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "default",
                    "options": [
                        { "value": "default", "name": "Default" },
                        { "value": "opus[1m]", "name": "Opus (1M context)" },
                        { "value": "haiku", "name": "Haiku 4.5" },
                    ]
                },
                { "id": "effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "default" }] },
                { "id": "fast", "category": "model_config", "type": "select", "currentValue": "off", "options": [{ "value": "on" }, { "value": "off" }] },
            ]
        });
        let rows = Inner::probe_model_rows(
            &opened,
            |_, model_id| async move {
                // Haiku offers neither control; the others offer both.
                Ok(if model_id == "haiku" {
                    json!({ "configOptions": [{ "id": "model", "category": "model", "type": "select" }] })
                } else {
                    json!({ "configOptions": [
                        { "id": "model", "category": "model", "type": "select" },
                        { "id": "effort", "category": "thought_level", "type": "select", "options": [{ "value": "default" }, { "value": "max" }] },
                        { "id": "fast", "category": "model_config", "type": "select", "options": [{ "value": "on" }, { "value": "off" }] },
                    ] })
                })
            },
            || async {},
        )
        .await;

        let ids: Vec<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
        assert_eq!(ids, ["default", "opus[1m]", "haiku"]);
        assert_eq!(rows[1]["name"], "Opus (1M context)");
        assert_eq!(effort_values(&rows[1]), ["default", "max"]);
        assert_eq!(rows[1]["supportsFast"], true);
        // Haiku has no effort control at all, and that is a probed answer.
        assert!(effort_values(&rows[2]).is_empty());
        assert_eq!(rows[2]["capabilitySource"], "probed");
        assert_eq!(rows[2]["supportsFast"], false);
    }

    #[test]
    fn a_fast_toggle_is_recognised_under_either_bridge_s_own_name() {
        assert!(Inner::is_fast_option(&json!({
            "id": "fast", "category": "model_config", "type": "select",
            "options": [{ "value": "on" }, { "value": "off" }]
        })));
        assert!(Inner::is_fast_option(&json!({
            "id": "fast-mode", "category": "model_config", "type": "select",
            "options": [{ "value": "off" }, { "value": "on" }]
        })));
        assert!(Inner::is_fast_option(
            &json!({ "id": "fast-mode", "category": "model_config", "type": "boolean" })
        ));
        // Another model_config knob that happens to be a select is not it.
        assert!(!Inner::is_fast_option(&json!({
            "id": "verbosity", "category": "model_config", "type": "select",
            "options": [{ "value": "terse" }, { "value": "verbose" }]
        })));
        assert!(!Inner::is_fast_option(
            &json!({ "id": "reasoning_effort", "category": "thought_level", "type": "select" })
        ));
    }

    /// A claude-acp session as the bridge opens one: no `models` block at
    /// all, the model in its own option, and an effort seeded from the
    /// operator's `~/.claude/settings.json` rather than from the model.
    fn claude_session() -> Value {
        json!({
            "models": Value::Null,
            "configOptions": [
                { "id": "mode", "category": "mode", "type": "select", "currentValue": "default", "options": [{ "value": "default" }] },
                {
                    "id": "model", "category": "model", "type": "select", "currentValue": "opus[1m]",
                    "options": [
                        { "value": "default" }, { "value": "opus[1m]" },
                        { "value": "claude-fable-5[1m]" }, { "value": "sonnet" }, { "value": "haiku" },
                    ]
                },
                {
                    "id": "effort", "category": "thought_level", "type": "select", "currentValue": "xhigh",
                    "options": [{ "value": "default" }, { "value": "low" }, { "value": "high" }, { "value": "xhigh" }, { "value": "max" }]
                },
                {
                    "id": "fast", "category": "model_config", "type": "select", "currentValue": "off",
                    "options": [{ "value": "on" }, { "value": "off" }]
                },
                { "id": "agent", "category": "agent", "type": "select", "currentValue": "default", "options": [{ "value": "default" }] },
            ]
        })
    }

    #[test]
    fn whichever_fable_the_bridge_does_not_list_is_the_one_a_session_is_opened_on() {
        // This bridge's Claude Code runs Fable 5, so that is the one it lists
        // and takes as a plain write; Fable 5.1 it would refuse.
        let lists_5 = claude_session();
        assert!(!Inner::opens_on_model(
            "claude-acp",
            &lists_5,
            "claude-fable-5[1m]"
        ));
        assert!(Inner::opens_on_model(
            "claude-acp",
            &lists_5,
            "claude-fable-5-1[1m]"
        ));

        // The next machine runs Fable 5.1 and the two swap. Writing Fable 5
        // there answered "Invalid value for config option model", which took
        // a chat that had just moved to Claude straight back off it.
        let mut lists_5_1 = claude_session();
        lists_5_1["configOptions"][1]["options"][2]["value"] = json!("claude-fable-5-1[1m]");
        assert!(Inner::opens_on_model(
            "claude-acp",
            &lists_5_1,
            "claude-fable-5[1m]"
        ));
        assert!(!Inner::opens_on_model(
            "claude-acp",
            &lists_5_1,
            "claude-fable-5-1[1m]"
        ));
        // An alias every bridge lists is never opened on.
        assert!(!Inner::opens_on_model("claude-acp", &lists_5_1, "sonnet"));
    }

    /// grok-acp: a real `thought_level` option under the same id codex uses,
    /// and no fast toggle of any kind.
    fn grok_session() -> Value {
        json!({
            "models": { "currentModelId": "grok-4.6" },
            "configOptions": [
                { "id": "model", "category": "model", "type": "select", "currentValue": "grok-4.6", "options": [{ "value": "grok-4.6" }] },
                { "id": "reasoning_effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "xhigh" }] },
            ]
        })
    }

    /// An inventory row as `probe_models` writes it, before `merge_inventory`
    /// places it.
    fn probed_row(id: &str, efforts: &[&str]) -> Value {
        json!({
            "id": id,
            "name": id,
            "description": Value::Null,
            "efforts": efforts.iter().map(|value| harness::effort(value, None, None)).collect::<Vec<_>>(),
            "defaultEffort": Value::Null,
            "supportsFast": false,
            "capabilitySource": "probed",
        })
    }

    #[test]
    fn a_write_is_routed_by_role_and_keeps_the_bridges_own_name() {
        let claude = claude_session();
        assert_eq!(Inner::option_role(&claude, "model"), OptionRole::Model);
        assert_eq!(Inner::option_role(&claude, "effort"), OptionRole::Effort);
        assert_eq!(Inner::option_role(&claude, "fast"), OptionRole::Fast);
        assert_eq!(Inner::option_role(&claude, "mode"), OptionRole::Other);
        assert_eq!(Inner::option_role(&claude, "agent"), OptionRole::Other);

        // The same three roles under each bridge's own ids.
        let codex = codex_session();
        assert_eq!(
            Inner::option_role(&codex, "reasoning_effort"),
            OptionRole::Effort
        );
        assert_eq!(Inner::option_role(&codex, "fast-mode"), OptionRole::Fast);
        assert_eq!(
            Inner::option_role(&codex, "collaboration_mode"),
            OptionRole::Other
        );
        assert_eq!(
            Inner::option_role(&grok_session(), "reasoning_effort"),
            OptionRole::Effort
        );
        assert_eq!(
            Inner::option_role(&grok_session(), "fast"),
            OptionRole::Other
        );

        // A session whose stored snapshot arrived with no options (grok's cold
        // session/new) is classified from the bridge's own answer instead.
        let cold = json!({ "configOptions": [] });
        assert_eq!(
            Inner::write_role(&cold, &claude, "effort"),
            OptionRole::Effort
        );
        assert_eq!(
            Inner::write_role(&claude, &cold, "effort"),
            OptionRole::Effort
        );
        assert_eq!(Inner::write_role(&cold, &cold, "effort"), OptionRole::Other);

        // What goes to the bridge is the client's own request, session id
        // aside: the id and the value shape are never rewritten.
        let write = json!({ "sessionId": "host-1", "configId": "fast-mode", "value": true, "type": "boolean" });
        assert_eq!(
            Inner::forwarded_config_write(&write, "bridge-1"),
            json!({ "sessionId": "bridge-1", "configId": "fast-mode", "value": true, "type": "boolean" })
        );
    }

    #[test]
    fn what_is_stored_is_what_the_bridge_answered_not_what_was_asked() {
        // Asked for gpt-5.5 at xhigh, codex clamps the effort to the model's
        // own default and reports it nowhere but in the options it answers with.
        let clamped = json!([
            { "id": "model", "category": "model", "currentValue": "gpt-5.5" },
            { "id": "reasoning_effort", "category": "thought_level", "currentValue": "medium" },
            {
                "id": "fast-mode", "category": "model_config", "type": "select", "currentValue": "on",
                "options": [{ "value": "on" }, { "value": "off" }]
            },
        ]);
        assert_eq!(
            Inner::selection_from(&clamped),
            Selection {
                model: Some("gpt-5.5".to_string()),
                effort: Some("medium".to_string()),
                fast: Some(true),
            }
        );

        // A full list without an effort or a fast option is the model saying
        // it has neither (claude on haiku), which is not the same as silence.
        let haiku = json!([
            { "id": "mode", "category": "mode", "currentValue": "default" },
            { "id": "model", "category": "model", "currentValue": "haiku" },
        ]);
        assert_eq!(
            Inner::selection_from(&haiku),
            Selection {
                model: Some("haiku".to_string()),
                effort: None,
                fast: None,
            }
        );
        // An answer carrying no options at all teaches nothing.
        assert_eq!(
            Inner::selection_from(&json!({})["configOptions"]),
            Selection::default()
        );

        assert_eq!(Inner::fast_enabled(&json!(true)), Some(true));
        assert_eq!(Inner::fast_enabled(&json!("on")), Some(true));
        assert_eq!(Inner::fast_enabled(&json!("off")), Some(false));
        assert_eq!(Inner::fast_enabled(&json!("sometimes")), None);
    }

    #[test]
    fn the_model_a_session_is_on_is_the_one_its_bridge_would_take_back() {
        // codex keeps a folded display id in its models block while its own
        // option holds the base id it accepts; reading the block first is how
        // `gpt-6-astra[xhigh]` used to reach sessions.model_id.
        let codex = json!({
            "models": { "currentModelId": "gpt-6-astra[xhigh]" },
            "configOptions": [
                { "id": "model", "category": "model", "currentValue": "gpt-6-astra" },
                { "id": "reasoning_effort", "category": "thought_level", "currentValue": "xhigh" },
            ]
        });
        assert_eq!(Inner::current_model(&codex).as_deref(), Some("gpt-6-astra"));
        assert_eq!(
            Inner::current_model(&claude_session()).as_deref(),
            Some("opus[1m]")
        );
        // A bridge with no model option is still read from its models block.
        let listed = json!({ "models": { "currentModelId": "amp-1" }, "configOptions": [] });
        assert_eq!(Inner::current_model(&listed).as_deref(), Some("amp-1"));
        assert_eq!(Inner::current_model(&json!({})), None);
    }

    #[test]
    fn only_a_folded_id_its_harness_can_explain_is_split() {
        let codex = harness::merge_inventory(
            "codex-acp",
            vec![
                probed_row(
                    "gpt-6-astra",
                    &["low", "medium", "high", "xhigh", "max", "ultra"],
                ),
                probed_row(
                    "gpt-5.6-sol",
                    &["low", "medium", "high", "xhigh", "max", "ultra"],
                ),
                probed_row("gpt-5.6-luna", &["low", "medium", "high", "xhigh", "max"]),
                probed_row("gpt-5.4-mini", &[]),
            ],
        );
        // The four ids the live store actually holds folded.
        for (folded, model, effort) in [
            ("gpt-5.6-sol[xhigh]", "gpt-5.6-sol", "xhigh"),
            ("gpt-5.6-sol[low]", "gpt-5.6-sol", "low"),
            ("gpt-6-astra[xhigh]", "gpt-6-astra", "xhigh"),
            ("gpt-5.6-luna[low]", "gpt-5.6-luna", "low"),
        ] {
            assert_eq!(
                Inner::legacy_split(folded, &codex),
                Some((model.to_string(), effort.to_string())),
                "{folded}"
            );
        }
        // An effort that model does not offer, a model the harness does not
        // list, and every shape that is not a pair at all.
        for id in [
            "gpt-5.6-luna[ultra]",
            "gpt-5.3-codex-spark[high]",
            "gpt-5.4-mini",
            "current",
            "a[b][c]",
            "[low]",
            "gpt-5.6-sol[]",
            "gpt-5.6-sol[xhigh",
        ] {
            assert_eq!(Inner::legacy_split(id, &codex), None, "{id}");
        }
        // A harness nobody has probed yet answers "not now", never a guess.
        assert_eq!(
            Inner::legacy_split(
                "gpt-5.6-sol[xhigh]",
                &harness::merge_inventory("codex-acp", vec![])
            ),
            None
        );

        // claude's `[1m]` ids are context lanes, not efforts, and `default` is
        // an alias — with or without a probe behind them.
        let claude = harness::merge_inventory(
            "claude-acp",
            vec![
                probed_row("default", &["default", "low", "high", "xhigh", "max"]),
                probed_row("opus[1m]", &["default", "low", "high", "xhigh", "max"]),
                probed_row(
                    "claude-fable-5[1m]",
                    &["default", "low", "high", "xhigh", "max"],
                ),
                probed_row("sonnet", &["default", "low", "high", "xhigh", "max"]),
                probed_row("haiku", &[]),
            ],
        );
        let declared = harness::merge_inventory("claude-acp", vec![]);
        for id in [
            "opus[1m]",
            "claude-fable-5[1m]",
            "claude-fable-5-1[1m]",
            "default",
            "haiku",
            "claude-opus-4-7",
        ] {
            assert_eq!(Inner::legacy_split(id, &claude), None, "{id}");
            assert_eq!(Inner::legacy_split(id, &declared), None, "{id} declared");
        }

        let grok = harness::merge_inventory(
            "grok-acp",
            vec![probed_row("grok-4.6", &["xhigh", "high", "medium", "low"])],
        );
        assert_eq!(Inner::legacy_split("grok-4.6", &grok), None);
        assert_eq!(Inner::legacy_split("current", &grok), None);
    }

    #[test]
    fn a_configuration_the_bridge_changes_by_itself_is_read_off_the_notification() {
        let update = |options: Value| {
            json!({
                "sessionId": "s1",
                "update": { "sessionUpdate": "config_option_update", "configOptions": options },
            })
        };
        // grok sends the whole list, so one notification states everything.
        let grok = update(json!([
            { "id": "model", "category": "model", "currentValue": "grok-4.6" },
            { "id": "reasoning_effort", "category": "thought_level", "currentValue": "low" },
        ]));
        let options = Inner::config_option_update(&grok).expect("options");
        assert_eq!(
            Inner::selection_from(&options),
            Selection {
                model: Some("grok-4.6".to_string()),
                effort: Some("low".to_string()),
                fast: None,
            }
        );

        // claude's SDK flipping fast mode back after a cooldown, with nobody
        // watching.
        let cooled = update(json!([
            { "id": "model", "category": "model", "currentValue": "opus[1m]" },
            { "id": "effort", "category": "thought_level", "currentValue": "max" },
            {
                "id": "fast", "category": "model_config", "type": "select", "currentValue": "off",
                "options": [{ "value": "on" }, { "value": "off" }]
            },
        ]));
        let selection =
            Inner::selection_from(&Inner::config_option_update(&cooled).expect("options"));
        assert_eq!(selection.effort.as_deref(), Some("max"));
        assert_eq!(selection.fast, Some(false));

        // Nothing to apply from an empty list or another kind of update.
        assert!(Inner::config_option_update(&update(json!([]))).is_none());
        assert!(Inner::config_option_update(
            &json!({ "update": { "sessionUpdate": "agent_message_chunk" } })
        )
        .is_none());
    }

    /// Everything claude-agent-acp offers, and the five values the 4.6-class
    /// models drop `xhigh` from.
    const EVERY_EFFORT: &[&str] = &["default", "low", "medium", "high", "xhigh", "max"];
    const NO_XHIGH: &[&str] = &["default", "low", "medium", "high", "max"];

    /// What claude-agent-acp answers a write with: its whole option list,
    /// rebuilt for the model the session is now on. `effort` is `None` for a
    /// model with no effort control at all (haiku) and `fast` `None` for one
    /// with no fast toggle (every model but the Opus rows).
    fn claude_answer(
        model: &str,
        effort: Option<&str>,
        efforts: &[&str],
        fast: Option<bool>,
    ) -> Value {
        let mut options = vec![json!({
            "id": "model", "category": "model", "type": "select", "currentValue": model,
            "options": [
                { "value": "default" }, { "value": "opus[1m]" },
                { "value": "claude-fable-5[1m]" }, { "value": "sonnet" }, { "value": "haiku" },
            ]
        })];
        if let Some(effort) = effort {
            options.push(json!({
                "id": "effort", "category": "thought_level", "type": "select",
                "currentValue": effort,
                "options": efforts.iter().map(|value| json!({ "value": value })).collect::<Vec<_>>(),
            }));
        }
        if let Some(fast) = fast {
            options.push(json!({
                "id": "fast", "category": "model_config", "type": "select",
                "currentValue": Inner::fast_word(fast),
                "options": [{ "value": "on" }, { "value": "off" }],
            }));
        }
        json!({ "configOptions": options })
    }

    #[tokio::test]
    async fn a_chat_is_put_on_its_model_then_its_effort_then_its_fast_mode() {
        let mut snapshot = claude_session();
        let asked = StdMutex::new(Vec::new());
        let wanted = Selection {
            model: Some("sonnet".to_string()),
            effort: Some("high".to_string()),
            fast: Some(true),
        };
        let substitutions =
            Inner::apply_selection("claude-acp", &mut snapshot, &wanted, false, |_, request| {
                let config_id = request["configId"].as_str().unwrap_or_default().to_string();
                asked
                    .lock()
                    .expect("asked")
                    .push(format!("{config_id}={}", request["value"]));
                // Sonnet keeps the effort it was on and has no fast toggle.
                let answer = match config_id.as_str() {
                    "model" => claude_answer("sonnet", Some("xhigh"), EVERY_EFFORT, None),
                    _ => claude_answer("sonnet", Some("high"), EVERY_EFFORT, None),
                };
                async move { Ok(answer) }
            })
            .await;

        assert_eq!(
            *asked.lock().expect("asked"),
            vec!["model=\"sonnet\"", "effort=\"high\""]
        );
        assert_eq!(Inner::current_model(&snapshot).as_deref(), Some("sonnet"));
        assert_eq!(
            Inner::effort_state(&snapshot, "high").map(|(_, current, _)| current),
            Some(Some("high".to_string()))
        );
        // The step nothing advertised is the only one that did not happen, and
        // it is the one the chat is told about.
        assert_eq!(substitutions.len(), 1, "{substitutions:?}");
        assert_eq!(substitutions[0]["role"], "fast");
        assert_eq!(substitutions[0]["requested"], "on");
        assert_eq!(substitutions[0]["applied"], Value::Null);
        assert_eq!(substitutions[0]["reason"], "sonnet has no fast mode");
    }

    #[tokio::test]
    async fn a_model_the_bridge_only_opens_on_is_asserted_and_not_assumed() {
        // A session opened through `_meta.claudeCode.options.model`: the bridge
        // reports `default` and its effort and fast options describe that
        // alias, which is how Opus 4.6 came to advertise an xhigh it has not.
        let opened = || {
            json!({
                "models": Value::Null,
                "configOptions": claude_answer("default", Some("xhigh"), EVERY_EFFORT, Some(false))["configOptions"],
            })
        };
        let wanted = Selection {
            model: Some("claude-opus-4-6".to_string()),
            effort: Some("xhigh".to_string()),
            fast: None,
        };

        let mut snapshot = opened();
        let asked = StdMutex::new(Vec::new());
        let substitutions =
            Inner::apply_selection("claude-acp", &mut snapshot, &wanted, true, |_, request| {
                asked
                    .lock()
                    .expect("asked")
                    .push(request["value"].as_str().unwrap_or_default().to_string());
                // Asserted, the session finally describes the model it is for.
                let answer = claude_answer("claude-opus-4-6", Some("default"), NO_XHIGH, None);
                async move { Ok(answer) }
            })
            .await;
        assert_eq!(*asked.lock().expect("asked"), vec!["claude-opus-4-6"]);
        assert_eq!(
            Inner::current_model(&snapshot).as_deref(),
            Some("claude-opus-4-6")
        );
        assert!(Inner::fast_state(&snapshot).is_none(), "4.6 has no fast");
        // And the effort the session showed before the assert belonged to the
        // alias: 4.6 does not offer it, so it is left alone and reported.
        assert_eq!(substitutions.len(), 1, "{substitutions:?}");
        assert_eq!(substitutions[0]["role"], "effort");
        assert_eq!(substitutions[0]["requested"], "xhigh");
        assert_eq!(substitutions[0]["applied"], "default");
        assert_eq!(substitutions[0]["reason"], "not offered by claude-opus-4-6");

        // Without the assert — an ordinary model — a value the bridge does not
        // list is never written at it.
        let mut untouched = opened();
        let refused =
            Inner::apply_selection("claude-acp", &mut untouched, &wanted, false, |_, _| async {
                panic!("nothing may be written for a model the bridge does not list")
            })
            .await;
        assert_eq!(refused[0]["role"], "model");
        assert_eq!(refused[0]["applied"], "default");
        assert_eq!(untouched, opened());
    }

    #[tokio::test]
    async fn an_effort_is_never_written_at_a_model_that_has_none() {
        // Haiku has no effort option at all, and writing one answers "Unknown
        // config option: effort".
        let mut snapshot = json!({
            "models": Value::Null,
            "configOptions": claude_answer("haiku", None, &[], None)["configOptions"],
        });
        let wanted = Selection {
            model: None,
            effort: Some("xhigh".to_string()),
            fast: Some(true),
        };
        let substitutions =
            Inner::apply_selection("claude-acp", &mut snapshot, &wanted, false, |_, _| async {
                panic!("haiku offers neither knob")
            })
            .await;
        assert_eq!(substitutions.len(), 2);
        assert_eq!(substitutions[0]["reason"], "haiku has no effort control");
        assert_eq!(substitutions[1]["reason"], "haiku has no fast mode");
        for entry in &substitutions {
            assert_eq!(entry["applied"], Value::Null);
        }
    }

    #[tokio::test]
    async fn the_value_a_bridge_answers_with_is_the_one_that_stuck() {
        // A bridge answers a write it will not honour with the value it kept
        // rather than with an error: what came back is what the session runs
        // at, whatever was asked for.
        let mut snapshot = claude_session();
        let wanted = Selection {
            model: None,
            effort: Some("max".to_string()),
            fast: None,
        };
        let substitutions =
            Inner::apply_selection("claude-acp", &mut snapshot, &wanted, false, |_, _| async {
                Ok(claude_answer(
                    "opus[1m]",
                    Some("high"),
                    EVERY_EFFORT,
                    Some(false),
                ))
            })
            .await;
        assert_eq!(substitutions.len(), 1);
        assert_eq!(substitutions[0]["requested"], "max");
        assert_eq!(substitutions[0]["applied"], "high");
        assert_eq!(
            Inner::effort_state(&snapshot, "max").map(|(_, current, _)| current),
            Some(Some("high".to_string()))
        );

        // A refusal is not a failure either: the sequence records it and goes on.
        let mut refused = claude_session();
        let substitutions =
            Inner::apply_selection("claude-acp", &mut refused, &wanted, false, |_, _| async {
                Err(protocol::internal("Unknown config option: effort"))
            })
            .await;
        assert_eq!(substitutions.len(), 1);
        assert_eq!(substitutions[0]["applied"], Value::Null);
        assert_eq!(refused, claude_session());
    }

    #[tokio::test]
    async fn a_stored_id_that_still_folds_an_effort_is_applied_as_its_two_halves() {
        // Until its harness has been probed once, a session stored before the
        // effort was split out of the model's name still carries the folded
        // id. `apply_model` sends the two halves the bridge keeps apart, and
        // the model it names back is the model half — which is the model that
        // was asked for, not one substituted for it.
        let mut snapshot = codex_session();
        let wanted = Selection {
            model: Some("gpt-5.5[xhigh]".to_string()),
            effort: None,
            fast: None,
        };
        let asked = StdMutex::new(Vec::new());
        let substitutions =
            Inner::apply_selection("codex-acp", &mut snapshot, &wanted, false, |role, request| {
                asked
                    .lock()
                    .expect("asked")
                    .push((role, request["value"].clone()));
                let answer = json!({ "configOptions": [
                    { "id": "model", "category": "model", "type": "select", "currentValue": "gpt-5.5",
                      "options": [{ "value": "gpt-6-astra" }, { "value": "gpt-5.5" }] },
                    { "id": "reasoning_effort", "category": "thought_level", "type": "select",
                      "currentValue": "xhigh", "options": [{ "value": "low" }, { "value": "xhigh" }] },
                ] });
                async move { Ok(answer) }
            })
            .await;
        assert_eq!(
            *asked.lock().expect("asked"),
            vec![(OptionRole::Model, json!("gpt-5.5[xhigh]"))]
        );
        assert!(substitutions.is_empty(), "{substitutions:?}");
        assert_eq!(Inner::current_model(&snapshot).as_deref(), Some("gpt-5.5"));
    }

    #[test]
    fn a_bridge_answer_that_states_no_options_never_silences_a_chats_controls() {
        // grok's cold `session/new` carries its models and no `configOptions`
        // key at all; storing that left the chat's effort control looking
        // unsupported for good.
        let cold = json!({ "models": { "currentModelId": "grok-4.6" }, "configOptions": [] });
        assert!(!Inner::replaces_snapshot(&cold, &grok_session()));
        // With nothing to lose it still gets through, so a bridge that keeps
        // its models outside the option list is not left without any.
        assert!(Inner::replaces_snapshot(
            &cold,
            &json!({ "configOptions": [] })
        ));
        assert!(Inner::replaces_snapshot(&grok_session(), &cold));

        // The same rule mid-sequence: `session/set_model` answers with nothing.
        let mut snapshot = grok_session();
        Inner::take_options(&mut snapshot, &json!({}));
        Inner::take_options(&mut snapshot, &json!({ "configOptions": [] }));
        assert_eq!(snapshot, grok_session());
    }

    /// A stored chat, as everything but its four selections is beside the
    /// point here.
    fn record_on(model: Option<&str>, effort: Option<&str>, fast: Option<bool>) -> SessionRecord {
        SessionRecord {
            id: "s1".to_string(),
            harness: "codex-acp".to_string(),
            account_id: None,
            bridge_session_id: Some("bridge-1".to_string()),
            cwd: "/work".to_string(),
            title: None,
            user_set_name: false,
            project_id: Some("p1".to_string()),
            persona_id: Some("agent-1".to_string()),
            model_id: model.map(str::to_string),
            reasoning_effort: effort.map(str::to_string),
            fast_mode: fast,
            legacy_model_id: None,
            hidden: false,
            created_at: "2026-09-14T00:00:00.000Z".to_string(),
            updated_at: "2026-09-14T00:00:00.000Z".to_string(),
            last_message_at: None,
            archived_at: None,
            message_count: 3,
            last_snippet: None,
            snapshot: None,
        }
    }

    #[test]
    fn a_fork_opens_on_everything_the_chat_it_was_taken_from_was_running() {
        let meta = Inner::fork_meta(&record_on(Some("gpt-6-astra"), Some("ultra"), Some(true)));
        assert_eq!(
            meta,
            json!({
                "provider": "codex-acp",
                "projectId": "p1",
                "personaId": "agent-1",
                "model": "gpt-6-astra",
                "reasoningEffort": "ultra",
                "fastMode": true,
            })
        );
        // And `session/new` reads back exactly what the fork wrote.
        assert_eq!(
            Inner::wanted_from_meta(&json!({ "_meta": meta })),
            Selection {
                model: Some("gpt-6-astra".to_string()),
                effort: Some("ultra".to_string()),
                fast: Some(true),
            }
        );

        // A chat nobody chose for names nothing, and opens on whatever its
        // harness starts with.
        let bare = Inner::fork_meta(&record_on(None, None, None));
        assert_eq!(bare["model"], Value::Null);
        assert_eq!(
            Inner::wanted_from_meta(&json!({ "_meta": bare })),
            Selection::default()
        );
        assert_eq!(Inner::wanted_from_meta(&json!({})), Selection::default());
    }

    #[test]
    fn what_a_bridge_would_not_do_is_the_only_record_of_a_downgrade() {
        // codex clamps the effort to the target model's own default on a model
        // change, and says so nowhere but in the options it answers with.
        let wanted = Selection {
            model: Some("gpt-5.5".to_string()),
            effort: Some("xhigh".to_string()),
            fast: None,
        };
        let clamped = Selection {
            model: Some("gpt-5.5".to_string()),
            effort: Some("medium".to_string()),
            fast: None,
        };
        let entries = Inner::substitutions_for(&wanted, &clamped);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0],
            json!({
                "role": "effort",
                "requested": "xhigh",
                "applied": "medium",
                "reason": "not offered by gpt-5.5",
            })
        );

        // claude drops the effort entirely on a model that has none, and keeps
        // the fast intent it cannot show.
        let haiku = Selection {
            model: Some("haiku".to_string()),
            effort: None,
            fast: None,
        };
        let asked = Selection {
            model: Some("haiku".to_string()),
            effort: Some("xhigh".to_string()),
            fast: Some(true),
        };
        let entries = Inner::substitutions_for(&asked, &haiku);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["applied"], Value::Null);
        assert_eq!(entries[0]["reason"], "haiku has no effort control");
        assert_eq!(entries[1]["requested"], "on");
        assert_eq!(entries[1]["reason"], "haiku has no fast mode");

        // A model the agent would not take is named for what it is on.
        let elsewhere = Inner::substitutions_for(
            &wanted,
            &Selection {
                model: Some("gpt-6-astra".to_string()),
                effort: Some("xhigh".to_string()),
                fast: None,
            },
        );
        assert_eq!(elsewhere.len(), 1);
        assert_eq!(elsewhere[0]["role"], "model");
        assert_eq!(elsewhere[0]["applied"], "gpt-6-astra");

        // Nothing to report when the bridge did as it was asked.
        assert!(Inner::substitutions_for(&wanted, &wanted).is_empty());
        assert!(Inner::substitutions_for(&Selection::default(), &haiku).is_empty());
    }

    #[test]
    fn a_presented_snapshot_carries_a_downgrade_next_to_the_provider_that_made_it() {
        let mut presented = Inner::presented_snapshot("claude-acp", &claude_session(), true);
        presented["_meta"] = json!({ "providerId": "claude-acp" });
        let entry = Inner::substitution("effort", "xhigh", Some("high"), "no".to_string());
        let carried = Inner::with_substitutions(presented.clone(), std::slice::from_ref(&entry));
        assert_eq!(carried["_meta"]["providerId"], "claude-acp");
        assert_eq!(carried["_meta"]["substitutions"], json!([entry]));
        // Nothing was refused, nothing is said.
        assert_eq!(Inner::with_substitutions(presented.clone(), &[]), presented);
    }

    /// A live session, as `claim_turn` reads one.
    fn runtime_on(bridge_session_id: &str) -> SessionRuntime {
        SessionRuntime {
            harness: "claude-acp".to_string(),
            account_id: None,
            execution_profile: None,
            bridge_session_id: bridge_session_id.to_string(),
            generation: 0,
            loading: false,
            run: None,
            steer_queue: VecDeque::new(),
            snapshot: claude_session(),
            has_model_option: true,
            substitutions: Vec::new(),
            last_active: std::time::Instant::now(),
        }
    }

    #[test]
    fn a_prompt_goes_to_the_bridge_session_its_runtime_names_as_the_run_is_registered() {
        let mut runtime = runtime_on("bridge-1");
        // A `reopen_on_model` that got in between the attach and the claim
        // closed `bridge-1` and opened another; the prompt must go to that one.
        runtime.bridge_session_id = "bridge-2".to_string();
        assert_eq!(
            Inner::claim_turn(&mut runtime, &ids()),
            Ok("bridge-2".to_string())
        );
        assert_eq!(
            runtime.run.as_ref().map(|run| run.run_id.as_str()),
            Some("run-1")
        );

        // The second prompt is told which run it found, and takes neither the
        // turn nor the session from it.
        let mut second = TurnIds::new();
        second.run_id = "run-2".to_string();
        assert_eq!(
            Inner::claim_turn(&mut runtime, &second),
            Err("run-1".to_string())
        );
        assert_eq!(
            runtime.run.as_ref().map(|run| run.run_id.as_str()),
            Some("run-1")
        );
    }

    #[test]
    fn only_a_real_session_info_title_is_kept() {
        fn info(title: &str) -> Value {
            json!({
                "sessionId": "s1",
                "update": { "sessionUpdate": "session_info_update", "title": title },
            })
        }
        assert_eq!(
            Inner::agent_title(&info("  Fix the build ")),
            Some("Fix the build")
        );
        assert_eq!(Inner::agent_title(&info("   ")), None);
        let handoff = format!("{}chat", legacy_import::PERSONA_HANDOFF_PREFIX);
        assert_eq!(Inner::agent_title(&info(&handoff)), None);
        let chunk = json!({
            "update": { "sessionUpdate": "agent_message_chunk", "title": "no" }
        });
        assert_eq!(Inner::agent_title(&chunk), None);
    }

    fn runtime(harness: &str, bridge_session_id: &str, generation: u64) -> SessionRuntime {
        SessionRuntime {
            harness: harness.to_string(),
            account_id: None,
            execution_profile: None,
            bridge_session_id: bridge_session_id.to_string(),
            generation,
            loading: false,
            run: None,
            steer_queue: VecDeque::new(),
            snapshot: Value::Null,
            has_model_option: false,
            substitutions: Vec::new(),
            last_active: std::time::Instant::now(),
        }
    }

    #[test]
    fn account_routes_isolate_identical_native_session_ids_and_bridge_exits() {
        let mut first = runtime("codex-acp", "native-shared", 1);
        first.account_id = Some("account-one".into());
        let first_key = first.route_key();
        let mut second = runtime("codex-acp", "native-shared", 2);
        second.account_id = Some("account-two".into());
        let second_key = second.route_key();
        let mut table = SessionTable::default();
        table.insert("host-one".into(), first);
        table.insert("host-two".into(), second);
        assert_ne!(first_key, second_key);
        assert_eq!(
            table.host_session_for(&first_key, "native-shared"),
            Some("host-one")
        );
        assert_eq!(
            table.host_session_for(&second_key, "native-shared"),
            Some("host-two")
        );
        table.retain(|runtime| !runtime.served_by(&first_key, 1));
        assert!(table.get("host-one").is_none());
        assert_eq!(
            table.host_session_for(&second_key, "native-shared"),
            Some("host-two")
        );
        table.rebind("host-two", "native-new".into());
        assert!(table
            .host_session_for(&second_key, "native-shared")
            .is_none());
        assert_eq!(
            table.host_session_for(&second_key, "native-new"),
            Some("host-two")
        );
    }

    #[test]
    fn provider_account_bridges_require_an_explicit_identity() {
        assert_ne!(
            account_route_key("codex-acp", None),
            account_route_key("codex-acp", Some("account-one"))
        );
        assert_ne!(
            account_route_key("codex-acp", Some("account-one")),
            account_route_key("claude-acp", Some("account-one"))
        );
        for provider in ["codex-acp", "claude-acp"] {
            assert!(account_validation_id(provider, None).is_err());
            assert_eq!(
                account_validation_id(provider, Some("saved-account")).unwrap(),
                Some("saved-account")
            );
        }
        assert_eq!(account_validation_id("kimi", None).unwrap(), None);
    }

    #[test]
    fn a_fork_keeps_its_account_and_unassigned_chats_do_not_invent_one() {
        let mut record = record_on(None, None, None);
        record.account_id = Some("account-one".into());
        assert_eq!(Inner::fork_meta(&record)["accountId"], "account-one");
        record.account_id = None;
        assert!(Inner::fork_meta(&record).get("accountId").is_none());
    }

    #[test]
    fn a_chat_that_let_go_of_its_bridge_session_does_not_resume_it() {
        let mut record = SessionRecord {
            id: "session-1".to_string(),
            harness: "claude-acp".to_string(),
            account_id: None,
            bridge_session_id: Some("bridge-1".to_string()),
            cwd: "C:\\work".to_string(),
            title: None,
            user_set_name: false,
            project_id: None,
            persona_id: None,
            model_id: None,
            reasoning_effort: None,
            fast_mode: None,
            legacy_model_id: None,
            hidden: false,
            created_at: "2026-09-11T00:00:00.000Z".to_string(),
            updated_at: "2026-09-11T00:00:00.000Z".to_string(),
            last_message_at: None,
            archived_at: None,
            message_count: 1,
            last_snippet: None,
            snapshot: None,
        };
        assert_eq!(
            Inner::resumable_bridge_session(&record),
            Some("bridge-1"),
            "an attach resumes the bridge session the row names"
        );

        // Never prompted: the agent never saved that bridge session.
        record.message_count = 0;
        assert_eq!(Inner::resumable_bridge_session(&record), None);
        record.message_count = 1;

        // What `release_bridge_session` leaves behind after a folder move: the
        // bridge session it ran in is gone for good, so the attach has to open a
        // new one in the new folder instead of loading the old one — never the
        // chat's own id, which for an imported chat *is* the old bridge session.
        record.bridge_session_id = None;
        assert_eq!(Inner::resumable_bridge_session(&record), None);
        record.bridge_session_id = Some(String::new());
        assert_eq!(Inner::resumable_bridge_session(&record), None);
    }

    #[test]
    fn a_session_still_being_attached_has_no_route() {
        let mut loading = runtime("claude-acp", "stored-id", 7);
        loading.loading = true;
        assert_eq!(loading.route(), None);
        loading.loading = false;
        assert_eq!(
            loading.route(),
            Some(("claude-acp".to_string(), "stored-id".to_string(), 7))
        );
    }

    #[test]
    fn only_the_sessions_of_the_bridge_that_died_are_forgotten() {
        let old = runtime("claude-acp", "a", 1);
        let replacement = runtime("claude-acp", "b", 2);
        let other_harness = runtime("codex-acp", "c", 1);

        // The crashed process is generation 1: its own session goes, the one
        // already re-attached to the replacement stays, and a same-generation
        // session of another harness is none of its business.
        assert!(old.served_by("claude-acp", 1));
        assert!(!replacement.served_by("claude-acp", 1));
        assert!(!other_harness.served_by("claude-acp", 1));
    }

    #[test]
    fn a_bridge_nobody_uses_is_shut_down_once_its_idle_window_has_passed() {
        let last_used = std::time::Instant::now();
        // Spawned for a model list, then left alone: no chat, no request, no
        // task holding it.
        assert!(Inner::bridge_is_reapable(
            0,
            0,
            0,
            last_used,
            last_used + BRIDGE_IDLE_TIMEOUT
        ));
        assert!(Inner::bridge_is_reapable(
            0,
            0,
            0,
            last_used,
            last_used + BRIDGE_IDLE_TIMEOUT * 12
        ));
    }

    #[test]
    fn a_bridge_with_a_chat_attached_is_never_shut_down() {
        let last_used = std::time::Instant::now();
        // However long the chat has sat there: shutting its bridge down would
        // lose the agent's context behind it.
        for idle in [BRIDGE_IDLE_TIMEOUT, BRIDGE_IDLE_TIMEOUT * 1000] {
            assert!(!Inner::bridge_is_reapable(
                1,
                0,
                0,
                last_used,
                last_used + idle
            ));
        }
    }

    #[test]
    fn a_bridge_used_within_its_idle_window_is_kept() {
        let last_used = std::time::Instant::now();
        let one_second = std::time::Duration::from_secs(1);
        assert!(!Inner::bridge_is_reapable(0, 0, 0, last_used, last_used));
        assert!(!Inner::bridge_is_reapable(
            0,
            0,
            0,
            last_used,
            last_used + BRIDGE_IDLE_TIMEOUT - one_second
        ));
        // A clock read before the last use (the use raced the check) is no
        // idle time at all.
        assert!(!Inner::bridge_is_reapable(
            0,
            0,
            0,
            last_used + one_second,
            last_used
        ));
    }

    #[test]
    fn a_bridge_with_work_in_hand_is_kept_however_long_ago_it_was_touched() {
        let last_used = std::time::Instant::now();
        let long_after = last_used + BRIDGE_IDLE_TIMEOUT * 12;
        // A request still waiting for its answer, such as a turn that has run
        // for an hour.
        assert!(!Inner::bridge_is_reapable(0, 1, 0, last_used, long_after));
        // A task that took the bridge for an attach or a probe and has not
        // sent anything yet.
        assert!(!Inner::bridge_is_reapable(0, 0, 1, last_used, long_after));
    }

    /// An attached chat last used at `last_active`, with nothing running.
    fn idle_since(last_active: std::time::Instant) -> SessionRuntime {
        let mut idle = runtime("claude-acp", "a", 1);
        idle.last_active = last_active;
        idle
    }

    #[test]
    fn a_chat_nobody_uses_lets_go_of_its_bridge_session_once_its_idle_window_has_passed() {
        let last_active = std::time::Instant::now();
        let idle = idle_since(last_active);
        assert!(Inner::session_is_evictable(
            &idle,
            true,
            last_active + SESSION_IDLE_TIMEOUT
        ));
        assert!(Inner::session_is_evictable(
            &idle,
            true,
            last_active + SESSION_IDLE_TIMEOUT * 10
        ));

        let one_second = std::time::Duration::from_secs(1);
        assert!(!Inner::session_is_evictable(&idle, true, last_active));
        assert!(!Inner::session_is_evictable(
            &idle,
            true,
            last_active + SESSION_IDLE_TIMEOUT - one_second
        ));
        // A clock read before the last use (the use raced the check) is no
        // idle time at all.
        assert!(!Inner::session_is_evictable(
            &idle_since(last_active + one_second),
            true,
            last_active
        ));
    }

    #[test]
    fn a_chat_with_work_in_hand_or_no_way_back_keeps_its_bridge_session() {
        let last_active = std::time::Instant::now();
        let long_after = last_active + SESSION_IDLE_TIMEOUT * 10;

        // A turn that has run for hours: its updates route through the runtime.
        let mut running = idle_since(last_active);
        running.run = Some(RunState::start(&ids()));
        assert!(!Inner::session_is_evictable(&running, true, long_after));

        // A message steered in, waiting for its turn.
        let mut queued = idle_since(last_active);
        queued.steer_queue.push_back(QueuedPrompt {
            prompt: json!([{ "type": "text", "text": "also this" }]),
            meta: json!({}),
            ids: TurnIds::new(),
        });
        assert!(!Inner::session_is_evictable(&queued, true, long_after));

        // An attach in flight, which makes the runtime live when it is done.
        let mut loading = idle_since(last_active);
        loading.loading = true;
        assert!(!Inner::session_is_evictable(&loading, true, long_after));

        // A bridge that cannot load the session again would start the chat
        // over without the agent's context.
        assert!(!Inner::session_is_evictable(
            &idle_since(last_active),
            false,
            long_after
        ));
    }

    #[test]
    fn only_a_bridge_that_cannot_load_sessions_keeps_its_chats_attached() {
        // The process that accepted the session is the one running.
        assert!(Inner::resumable_after_release(Some((3, true)), 3));
        assert!(!Inner::resumable_after_release(Some((3, false)), 3));
        // That process is gone, replaced or not: its sessions went with it,
        // so letting go of the runtime loses nothing.
        assert!(Inner::resumable_after_release(Some((4, false)), 3));
        assert!(Inner::resumable_after_release(None, 3));
    }

    #[test]
    fn an_update_finds_its_chat_by_the_bridge_session_it_came_from() {
        let mut table = SessionTable::default();
        table.insert("chat-1".to_string(), runtime("claude-acp", "a", 1));
        table.insert("chat-2".to_string(), runtime("codex-acp", "a", 1));
        table.insert("chat-3".to_string(), runtime("claude-acp", "b", 1));
        assert_eq!(table.host_session_for("claude-acp", "a"), Some("chat-1"));
        // The same bridge id under another harness is another session.
        assert_eq!(table.host_session_for("codex-acp", "a"), Some("chat-2"));
        assert_eq!(table.host_session_for("claude-acp", "b"), Some("chat-3"));
        // A probe or naming session nobody attached.
        assert_eq!(table.host_session_for("claude-acp", "probe"), None);
        assert_eq!(table.host_session_for("grok", "a"), None);

        // An attach that could not resume the stored session opened another.
        let rebound = table.rebind("chat-1", "c".to_string());
        assert_eq!(
            rebound.map(|runtime| runtime.bridge_session_id.as_str()),
            Some("c")
        );
        assert_eq!(table.host_session_for("claude-acp", "a"), None);
        assert_eq!(table.host_session_for("claude-acp", "c"), Some("chat-1"));
        assert!(table.rebind("nobody", "d".to_string()).is_none());

        // Re-registering a chat (a reopen, a move) replaces its old route.
        table.insert("chat-3".to_string(), runtime("codex-acp", "e", 2));
        assert_eq!(table.host_session_for("claude-acp", "b"), None);
        assert_eq!(table.host_session_for("codex-acp", "e"), Some("chat-3"));

        // Let go of, deleted, or gone with its bridge process.
        assert!(table.remove("chat-1").is_some());
        assert!(table.remove("chat-1").is_none());
        assert_eq!(table.host_session_for("claude-acp", "c"), None);
        table.retain(|runtime| !runtime.served_by("codex-acp", 2));
        assert_eq!(table.host_session_for("codex-acp", "e"), None);
        assert_eq!(table.host_session_for("codex-acp", "a"), Some("chat-2"));
        assert_eq!(table.values().count(), 1);
    }

    #[test]
    fn a_restarted_bridge_cannot_reuse_the_old_process_session_route() {
        let mut table = SessionTable::default();
        table.insert("old-chat".into(), runtime("codex-acp", "reused-id", 7));
        assert_eq!(
            table.host_session_for_generation("codex-acp", 7, "reused-id"),
            Some("old-chat")
        );
        table.remove("old-chat");
        table.insert("new-chat".into(), runtime("codex-acp", "reused-id", 8));
        assert_eq!(
            table.host_session_for_generation("codex-acp", 7, "reused-id"),
            None
        );
        assert_eq!(
            table.host_session_for_generation("codex-acp", 8, "reused-id"),
            Some("new-chat")
        );
        assert_eq!(
            table.host_session_for_generation("claude-acp", 8, "reused-id"),
            None
        );
    }

    #[test]
    fn permission_responses_cannot_answer_requests_from_a_replacement_process() {
        let (original, mut original_output) = super::super::bridge::tests::silent_bridge();
        let (replacement, mut replacement_output) = super::super::bridge::tests::silent_bridge();
        let request = || ClientRequest {
            harness: "test-acp".into(),
            generation: original.generation(),
            bridge_id: json!(7),
            method: "session/request_permission".into(),
        };
        let approved = Ok(json!({"outcome": {"outcome": "selected", "optionId": "allow-once"}}));
        request().respond(&replacement, approved.clone());
        assert!(replacement_output.try_recv().is_err());
        assert!(original_output.try_recv().is_err());
        request().respond(&original, approved);
        let response: Value = serde_json::from_str(&original_output.try_recv().unwrap()).unwrap();
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"]["outcome"]["optionId"], "allow-once");
    }

    #[test]
    fn a_second_chat_on_one_bridge_session_is_still_found_when_the_first_goes() {
        let mut table = SessionTable::default();
        table.insert("chat-1".to_string(), runtime("claude-acp", "a", 1));
        table.insert("chat-2".to_string(), runtime("claude-acp", "a", 1));
        let first = table
            .host_session_for("claude-acp", "a")
            .map(str::to_string);
        let first = first.expect("one of the two chats is found");
        table.remove(&first);
        let second = if first == "chat-1" {
            "chat-2"
        } else {
            "chat-1"
        };
        assert_eq!(table.host_session_for("claude-acp", "a"), Some(second));
        table.remove(second);
        assert_eq!(table.host_session_for("claude-acp", "a"), None);
    }

    #[test]
    fn an_answer_goes_to_the_socket_that_asked_and_nowhere_else() {
        let (socket_a, mut heard_a) = mpsc::unbounded_channel::<String>();
        let (_socket_b, mut heard_b) = mpsc::unbounded_channel::<String>();
        Inner::reply_on(
            &socket_a,
            "session/new",
            protocol::response(json!(0), json!({ "sessionId": "s1" })),
        );
        assert!(heard_a.try_recv().is_ok());
        assert!(heard_b.try_recv().is_err());

        // The renderer gave up on that socket: its answer is dropped rather
        // than delivered to the next connection, where id 0 is another call.
        drop(heard_a);
        Inner::reply_on(
            &socket_a,
            "session/new",
            protocol::response(json!(0), json!({ "sessionId": "s2" })),
        );
        assert!(heard_b.try_recv().is_err());
    }

    #[test]
    fn stopping_a_turn_forgets_the_messages_steered_into_it() {
        let mut live = runtime("claude-acp", "a", 1);
        live.run = Some(RunState::start(&ids()));
        for _ in 0..2 {
            live.steer_queue.push_back(QueuedPrompt {
                prompt: json!([{ "type": "text", "text": "also this" }]),
                meta: json!({}),
                ids: TurnIds::new(),
            });
        }

        assert_eq!(live.drop_queued_steers(), 2);
        assert!(live.steer_queue.is_empty());
        // Cancelling does not end the turn itself: its `session/prompt` is
        // still in flight and its run state still stamps the updates arriving.
        assert!(live.run.is_some());
        assert_eq!(live.drop_queued_steers(), 0);
    }

    #[test]
    fn a_burst_of_updates_is_stored_per_chat_without_reordering_the_log() {
        let chunk = |text: &str| json!({ "update": { "content": { "text": text } } });
        let grouped = Inner::group_events_by_session(vec![
            ("a".to_string(), chunk("a1")),
            ("a".to_string(), chunk("a2")),
            // Another chat streaming at the same time: merging across it would
            // put "a3" in the log before "b1", which is not the order the
            // updates arrived in.
            ("b".to_string(), chunk("b1")),
            ("a".to_string(), chunk("a3")),
        ]);

        let shape: Vec<(&str, Vec<&str>)> = grouped
            .iter()
            .map(|(session_id, payloads)| {
                (
                    session_id.as_str(),
                    payloads
                        .iter()
                        .map(|payload| payload["update"]["content"]["text"].as_str().unwrap_or(""))
                        .collect(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                ("a", vec!["a1", "a2"]),
                ("b", vec!["b1"]),
                ("a", vec!["a3"])
            ]
        );
        assert!(Inner::group_events_by_session(Vec::new()).is_empty());
    }

    #[test]
    fn a_rejected_prompt_is_withdrawn_only_on_proof_that_its_turn_produced_nothing() {
        let mut live = runtime("claude-acp", "a", 1);
        live.run = Some(RunState::start(&ids()));

        // The bridge answered the prompt with an error and sent nothing at all:
        // the turn never happened, so the message comes back out of the log.
        assert!(Inner::turn_produced_nothing(Some(&live), "run-1"));

        // One update is enough to make it a turn that happened.
        live.run.as_mut().expect("run").saw_update = true;
        assert!(!Inner::turn_produced_nothing(Some(&live), "run-1"));

        // The bridge died mid-turn: `fail_pending_on_exit` failed the prompt and
        // the `Exited` behind it removed the runtime while the turn was still
        // unwinding. The reply it streamed is in the transcript, so the absence
        // of evidence must not be read as "nothing happened".
        assert!(!Inner::turn_produced_nothing(None, "run-1"));

        // Same for a runtime that is no longer running this turn, or is running
        // the next one.
        live.run = None;
        assert!(!Inner::turn_produced_nothing(Some(&live), "run-1"));
        live.run = Some(RunState::start(&TurnIds::new()));
        assert!(!Inner::turn_produced_nothing(Some(&live), "run-1"));
    }

    #[test]
    fn a_turn_nobody_awaits_reports_its_end_as_a_cleared_active_run() {
        let update = Inner::run_settled_update("s1");
        assert_eq!(update["sessionId"], "s1");
        assert_eq!(update["update"]["sessionUpdate"], "session_info_update");
        // `acpSessionInfoUpdate.ts` keys off `"activeRunId" in meta` and treats
        // a non-string as null, so the key has to be present and explicitly
        // null rather than omitted.
        let meta = &update["update"]["_meta"];
        assert!(meta
            .as_object()
            .is_some_and(|meta| meta.get("activeRunId").is_some_and(Value::is_null)));
    }

    #[test]
    fn a_request_nobody_can_answer_is_cancelled_or_failed() {
        assert_eq!(
            Inner::unanswered_client_request("session/request_permission"),
            Ok(json!({ "outcome": { "outcome": "cancelled" } }))
        );
        assert!(Inner::unanswered_client_request("fs/read_text_file").is_err());
    }
}
