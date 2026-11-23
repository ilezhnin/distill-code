//! The agent host proper: a local WebSocket endpoint speaking ACP to the
//! renderer, routed onto one bridge process per harness, with sessions,
//! history, and settings persisted in SQLite.

mod steering;

use futures_util::future::BoxFuture;
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
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::app_sign_in;
use super::bridge::{error_text, Bridge, BridgeEvent, SpawnEnv};
use super::execution::ExecutionProfile;
use super::execution::{
    self, violation, AccountActivity, ExecutionDispatch, NativeProvider, ObservedSelection,
    OwnedEventPage, OwnedSession, OwnedSessionRequest, OwnedTurnImage, OwnedTurnRequest,
};
use super::executor_receipts::{
    EvidenceError, ExecutorLink, ReceiptFinish, ReceiptRejection, ReceiptStart, ReportedSelection,
    REPORTED_KEY,
};
use super::ext;
use super::harness::{self, HarnessSpec};
use super::harness_env::build_spawn_env;
use super::legacy_import;
use super::protocol::{self, invalid_params, now_iso, Message};
use super::repository_execution;
use super::sandbox_sign_in::SignInRenewals;
use super::session_title;
use super::sources::SourceRoots;
use super::store::{
    message_snippet, ForkBoundary, MessageSide, SessionRecord, SessionStore, SessionTouchUndo,
    SNIPPET_CHARS,
};
use super::text_execution;
use crate::services::computer_use;
use crate::services::credential_lease;
use crate::services::managed_acp_tools;
use crate::services::provider_account_status::grok;
use crate::services::provider_accounts;

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

/// CLI sign-ins have the same quota as their benchmark leases, even though
/// Flock does not store those accounts or offer automatic switching for them.
fn account_quota_id<'a>(
    harness: &str,
    account_id: Option<&'a str>,
) -> Result<Option<&'a str>, Value> {
    if provider_accounts::supports_managed_accounts(harness) {
        return account_validation_id(harness, account_id);
    }
    Ok(account_id.filter(|id| provider_accounts::is_cli_login_account(harness, id)))
}

/// The account a chat's allowance is checked against: the one it names, or
/// for an ordinary chat of a CLI sign-in (such a chat stores no account) the
/// sign-in itself. `true` marks the sign-in supplied here: it is asked only
/// whether its allowance is spent, never written onto the chat and never
/// signed in from here (the bridge's auth flow keeps that).
fn quota_identity(
    harness: &str,
    account_id: Option<&str>,
) -> Result<Option<(String, bool)>, Value> {
    if let Some(id) = account_quota_id(harness, account_id)? {
        return Ok(Some((id.to_string(), false)));
    }
    Ok(account_id
        .is_none()
        .then(|| provider_accounts::cli_login_account_id(harness))
        .flatten()
        .map(|id| (id, true)))
}

/// The renderer's socket takes a message of any size. A prompt carries its
/// images inline, and how much a prompt may carry is the provider's call, not
/// this transport's: tungstenite's default 16 MiB frame limit closed the
/// socket, and every open chat with it, on a prompt the provider would have
/// taken. Frames are only read after the handshake checked the host's token.
fn frontend_socket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(None)
        .max_frame_size(None)
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
    purpose: &str,
) -> Value {
    let mut meta = provider
        .and_then(NativeProvider::prompt_meta)
        .cloned()
        .unwrap_or_default();
    meta.insert(
        "executionOwner".into(),
        json!({"kind":purpose,"id":owner_id}),
    );
    json!({"sessionId":session_id,"prompt":blocks,"_meta":meta})
}

/// How long a model write waits before it is sent again, in the same session,
/// when the provider's refusal itself says to try again. Claude Code confirms
/// a model with the API when a session is put on it and answers "Couldn't
/// confirm model ... with the API. Try again, or run /model ..." when that
/// call fails: on 11-18 two benchmark runs stopped within a minute of their
/// start on one such refusal each, beside sessions that took the same model.
#[cfg(not(test))]
const MODEL_RETRY_PAUSES: [std::time::Duration; 2] = [
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(5),
];
#[cfg(test)]
const MODEL_RETRY_PAUSES: [std::time::Duration; 2] = [std::time::Duration::from_millis(1); 2];

/// Whether a refusal asks, in the provider's own words, for the same request
/// again.
fn asks_again(error: &Value) -> bool {
    error_text(error).to_ascii_lowercase().contains("try again")
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

/// Being inside Linux grants no tools. Only the persisted repository profile
/// may answer a tool approval; missing ownership and text/judge sessions deny.
fn owned_permission_answer(
    profile: Option<ExecutionProfile>,
    method: &str,
    params: &Value,
) -> Option<Value> {
    if profile == Some(ExecutionProfile::ProtectedRepositoryV1) {
        repository_execution::permission_answer(method, params)
    } else {
        None
    }
}

/// What marks a bridge route as a host-owned benchmark bridge.
const BENCHMARK_ROUTE: &str = "\u{1f}benchmark:";
/// The longest an owned (benchmark) turn may run. It only stops a turn that
/// never ends; models on the highest efforts can work for hours.
pub const MAX_OWNED_TURN_MS: u64 = 24 * 60 * 60 * 1000;

// This cache contains only isolated benchmark inventory. Native chat model
// probes never populate it. A short TTL and explicit refresh cover account
// catalog changes; the runtime/policy revision prevents stale bridge reuse.
static TEXT_INVENTORY: std::sync::LazyLock<StdMutex<HashMap<String, (std::time::Instant, Value)>>> =
    std::sync::LazyLock::new(|| StdMutex::new(HashMap::new()));
const TEXT_INVENTORY_TTL: std::time::Duration = std::time::Duration::from_secs(300);

/// The host-owned benchmark bridge a session is opened on: its profile's
/// route key, its provider, and the longest turn the session may run, which a
/// sign-in the bridge cannot refresh (Grok's) must outlast.
#[derive(Clone, Copy)]
struct OwnedBridge<'a> {
    profile_key: &'a str,
    request: &'a OwnedSessionRequest,
    revision: &'a str,
    provider: NativeProvider,
    turn_limit_ms: u64,
}

/// JSON-RPC error code of an owned text bridge the broker refused before
/// reserving anything, in a sandbox cleared just before: setup has nothing to
/// clean after it.
const CLEAR_SANDBOX_REFUSAL: i64 = -32001;

/// Preserve the trusted broker's pre-spawn refusal across inventory's string API.
fn inventory_start_error(error: &Value) -> String {
    let message = error_text(error);
    if error["code"] == CLEAR_SANDBOX_REFUSAL && !message.starts_with("resource_busy:") {
        format!("resource_busy: {message}")
    } else {
        message
    }
}

/// Where owned bridges of every provider kept their runtime files, under the
/// Flock root `root`.
fn owned_runtime_root(root: &std::path::Path) -> PathBuf {
    root.join("benchmarks").join("runtime")
}

/// Removes the sign-in copy an owned bridge on `route_key` may have left in
/// its runtime directory under `runtime_root`; nothing for any other route.
fn discard_route_sign_in(runtime_root: &std::path::Path, route_key: &str) -> std::io::Result<()> {
    if route_key
        .split_once(BENCHMARK_ROUTE)
        .is_some_and(|(_, profile)| sandbox_account_route(profile))
    {
        return Ok(());
    }
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
/// bridge session. Every chat explicitly prepared for a send
/// is attached, and without a limit each one keeps its agent context loaded in
/// the bridge, and keeps that bridge from ever being shut down, for the rest of
/// the run. The price is paid by the next prompt or model change in that chat,
/// which has to resume the bridge session first: one to three seconds, more if
/// the bridge itself was shut down meanwhile. Half an hour keeps a conversation
/// with pauses attached; merely reading history never opens a bridge session.
const SESSION_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);
/// How often the host reads the session records of ordinary Kimi chats for
/// the turns the Kimi ACP adapter never forwards (`kimi_relay`).
const KIMI_FOLLOW_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);
/// How often the host looks again for a Kimi session record it has not found:
/// a new session has none until its first prompt.
const KIMI_RECORD_LOOK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
/// A record the CLI created this close to when the host began to follow the
/// chat, or later, is a new session's: all of it is new.
const KIMI_NEW_RECORD_GRACE: std::time::Duration = std::time::Duration::from_secs(5);
/// How long a bridge has to end a turn it was told to cancel before the host
/// ends it itself (see `end_cancelled_turn_if_unanswered`).
const CANCEL_ANSWER_GRACE: std::time::Duration = std::time::Duration::from_secs(15);
/// How long a close that stops the active chats waits for their agents to end
/// the cancelled turns before ending them itself (see `stop_chats_for_close`).
const CLOSE_STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(3);
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
pub const EXT_PREFIX: &str = "_flock/";

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
    owned_deadline: Option<tokio::time::Instant>,
    /// Whether the turn may run on purchased credits once plan usage is
    /// spent: always for the operator's own turns, by request for owned ones.
    allow_credits: bool,
}

fn owned_turn_deadline(timeout_ms: u64, absolute_ms: Option<i64>) -> tokio::time::Instant {
    let remaining = absolute_ms
        .map(|deadline| {
            deadline
                .saturating_sub(chrono::Utc::now().timestamp_millis())
                .max(0) as u64
        })
        .unwrap_or(timeout_ms)
        .min(timeout_ms);
    tokio::time::Instant::now() + std::time::Duration::from_millis(remaining)
}

/// Whether an owned session's runtime runs in the Linux sandbox: repository
/// and tool-free text sessions both do, on leases of the app's sign-in.
fn sandbox_account_route(profile: &str) -> bool {
    repository_execution::is_route(profile) || text_execution::is_route(profile)
}

/// What a failed `bench-auth stage` tells the runner: the helper refusing
/// the lease itself (a refresh token, a shape it does not take) is a missing
/// capability; anything else (the WSL transport, a time limit, a folder left
/// from before) is a busy refusal before any provider process started, so the
/// test waits in the queue instead of stopping the run.
fn stage_failure(error: &str) -> String {
    // The helper names the error it stopped on; only these pass with a retry
    // (a folder left from before goes with the attempt's next cleanup).
    const TRANSIENT: &[&str] = &[
        "FileExistsError",
        "BlockingIOError",
        "TimeoutError",
        "InterruptedError",
    ];
    let transient = match error.split_once("bench-auth: ") {
        Some((_, reason)) => TRANSIENT.iter().any(|name| reason.trim().starts_with(name)),
        // Not the helper's own word: the WSL transport or a time limit.
        None => true,
    };
    if transient {
        format!(
            "resource_busy: the sign-in for this test was not staged ({error}); it starts again"
        )
    } else {
        format!("capability_missing: {error}")
    }
}

fn check_owned_deadline(deadline: Option<tokio::time::Instant>) -> Result<(), Value> {
    if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
        return Err(protocol::error_with_data(
            -32000,
            "Native root budget expired before provider submission",
            json!({"kind":"budget_timeout"}),
        ));
    }
    Ok(())
}

impl TurnIds {
    fn new() -> Self {
        Self {
            run_id: uuid::Uuid::new_v4().to_string(),
            message_id: uuid::Uuid::new_v4().to_string(),
            assistant_message_id: uuid::Uuid::new_v4().to_string(),
            owned_deadline: None,
            allow_credits: true,
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
    configuration_changes: Vec<ReportedSelection>,
    changes_truncated: bool,
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
            configuration_changes: Vec::new(),
            changes_truncated: false,
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
/// flockctl client or a stored `sessions.model_id` the lazy split has not
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

/// Why a close waits for ordinary chats.
pub const CHATS_ACTIVE: &str = "Wait for active chats to finish or stop them before closing Flock.";

/// Turns a close would cut among `sessions`: ordinary chats loading, running
/// or with prompts queued, and owned (benchmark) sessions likewise.
fn active_turns<'a>(sessions: impl Iterator<Item = &'a SessionRuntime>) -> (usize, usize) {
    sessions
        .filter(|runtime| runtime.has_pending_chat_work())
        .fold((0, 0), |(chats, tests), runtime| {
            if runtime.execution_profile.is_some() {
                (chats, tests + 1)
            } else {
                (chats + 1, tests)
            }
        })
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
    background: super::background::BackgroundActivity,
    /// The context window as the bridge last counted it, for the compaction
    /// updates that pass (see [`super::context_meter`]).
    context: super::context_meter::ContextMeter,
    steer_queue: VecDeque<QueuedPrompt>,
    native_steers: Vec<steering::PendingSteer>,
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

    fn active_run_id(&self) -> Option<&str> {
        self.background
            .active_run_id()
            .or_else(|| self.run.as_ref().map(|run| run.run_id.as_str()))
    }

    fn has_pending_chat_work(&self) -> bool {
        self.loading || self.active_run_id().is_some() || !self.steer_queue.is_empty()
    }

    fn accepts_continuations(&self) -> bool {
        self.execution_profile.is_none() && self.harness != "kimi-acp"
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

    /// Stop means stop: the messages steered into the turn being cancelled
    /// are not started as turns of their own once it returns, and a reply the
    /// agent continued on its own ends here. Reports the steers dropped and
    /// the closing update for the reply the host has to settle itself.
    fn stop(&mut self, session_id: &str) -> (usize, Option<Value>) {
        let ended_background = self.background.finish(session_id);
        self.background.cancel();
        (self.drop_queued_steers(), ended_background)
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
    /// What the host follows of each ordinary Kimi chat's session record, by
    /// host session id: the turns the Kimi ACP adapter never forwards (see
    /// `kimi_relay`). Taken before `sessions` whenever both are held.
    kimi_follows: Mutex<HashMap<String, super::kimi_relay::KimiFollow>>,
    /// One lock per session so an explicit configuration and a prompt
    /// arriving together never race to attach twice; the
    /// second caller waits and then takes the already-attached fast path.
    attach_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
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
    /// Renewals of the Flock sign-ins benchmark sessions lease, by account.
    sign_in_renewals: SignInRenewals,
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

    /// Whether ordinary chats have turns a close would cut. A close checks
    /// this before it pauses the benchmark runs, so a refused close pauses
    /// nothing.
    pub async fn chats_active(&self) -> bool {
        self.active_chat_count().await > 0
    }

    /// Ordinary chats a close would cut: loading, running, or with steers
    /// queued. The close asks the operator before stopping them.
    pub async fn active_chat_count(&self) -> usize {
        let Some(inner) = self.inner.lock().await.clone() else {
            return 0;
        };
        let sessions = inner.sessions.lock().await;
        active_turns(sessions.values()).0
    }

    /// Stop every ordinary chat a close would cut, for an operator who chose
    /// to close anyway. See [`Inner::stop_chats_for_close`].
    pub async fn stop_chats_for_close(&self) -> usize {
        let Some(inner) = self.inner.lock().await.clone() else {
            return 0;
        };
        inner.stop_chats_for_close().await
    }

    /// `chats_stopped`: the operator chose to close over active chats and
    /// [`Self::stop_chats_for_close`] stopped them, so a chat still opening
    /// its session no longer holds the close.
    pub async fn prepare_shutdown(
        &self,
        prepared: bool,
        chats_stopped: bool,
    ) -> Result<(), String> {
        let inner = self.inner.lock().await.clone();
        let Some(inner) = inner else {
            return Ok(());
        };
        {
            let sessions = inner.sessions.lock().await;
            if prepared {
                let (chats, tests) = active_turns(sessions.values());
                if chats > 0 && !chats_stopped {
                    return Err(CHATS_ACTIVE.into());
                }
                if tests > 0 {
                    return Err(format!(
                        "Benchmark runs are pausing: {tests} benchmark or task turn(s) still finish. Close Flock again once they settle."
                    ));
                }
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
            runtime.account_id.as_deref() == Some(account_id) && runtime.has_pending_chat_work()
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

/// What a renewal of an app sign-in does through the host.
struct AppRenewal<'a> {
    host: &'a Arc<Inner>,
    native: NativeProvider,
    account: &'a str,
    key: &'a str,
}

impl app_sign_in::RenewalIo for AppRenewal<'_> {
    fn expiry(&mut self) -> Result<Option<i64>, String> {
        crate::services::credential_lease::read(
            &self.host.app,
            self.native,
            self.account,
            self.now(),
        )
        .map(|lease| lease.expires_at_ms())
    }

    fn live_leases(&mut self) -> BoxFuture<'_, usize> {
        Box::pin(self.host.live_benchmark_bridges(self.key))
    }

    fn other_holders(&mut self) -> BoxFuture<'_, usize> {
        Box::pin(async move {
            let mut routes = vec![self.key.to_owned()];
            if provider_accounts::is_cli_login_account(self.native.harness_id(), self.account) {
                routes.push(self.native.harness_id().to_owned());
            }
            let chats = self.host.live_chat_bridges(&routes).await;
            // The user's own Grok sign-in is shared by every Grok process;
            // which Codex home a codex process runs on is not visible, so
            // every one counts.
            let image = match self.native {
                NativeProvider::Grok => Some("grok.exe"),
                NativeProvider::Codex => Some("codex.exe"),
                _ => None,
            };
            let processes = match image {
                Some(image) => tokio::task::spawn_blocking(move || {
                    crate::services::process::count_processes_named(&[image])
                })
                .await
                .unwrap_or(1),
                None => 0,
            };
            chats + processes
        })
    }

    fn renew(&mut self, natural: bool) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            if self.native == NativeProvider::Grok {
                let expiry = self.expiry()?.unwrap_or_default();
                return self.host.windows_grok_renewal(expiry).await;
            }
            let account = provider_accounts::account(&self.host.app, self.account)?;
            let renewed = crate::services::provider_account_status::renew_app_grant(
                &self.host.app,
                &account,
                natural,
            )
            .await;
            crate::services::provider_account_status::invalidate(&self.host.app, self.account)
                .await;
            renewed
        })
    }

    fn renewed(&mut self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            // Grok chats run on the CLI sign-in without an account.
            let mut routes = vec![self.key.to_owned()];
            if provider_accounts::is_cli_login_account(self.native.harness_id(), self.account) {
                routes.push(self.native.harness_id().to_owned());
            }
            self.host.retire_idle_chat_bridges(&routes).await;
        })
    }

    fn now(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

mod bridges;
mod events;
mod frontend;
mod inventory;
mod kimi_follow;
mod moves;
mod options;
mod owned;
mod prompts;
mod selection;
mod sessions;
mod sign_in;
mod titles;
mod turns;

#[cfg(test)]
mod tests;
