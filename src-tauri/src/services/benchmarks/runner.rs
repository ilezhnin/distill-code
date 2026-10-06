use super::{
    analysis::matches_selection,
    evaluation, fixtures,
    store::{now, Store},
    types::*,
    BenchmarkService,
};
use crate::services::agent_host::{execution::*, AgentHost};
use crate::services::provider_account_status::benchmark_sampling::{self, AccountMeasurement};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::sync::watch;

/// Fewest judges whose votes may settle a rendering.
pub(crate) const MIN_JUDGES: usize = 2;
/// Most judges on one panel; plan admission reserves this many calls.
pub(crate) const MAX_JUDGES: usize = 3;
const JUDGING_STOPPED: &str = "Judging stopped: the run was paused or cancelled";
const JUDGES_BUSY: &str = "Judge accounts are busy; evaluate again later";
/// A rendering whose panel a pause or busy judges held back: its generation
/// is sealed and the run asks the panel before any new generation.
pub(crate) const AWAITING_JUDGES: &str = "awaiting_judges";

/// Whether a panel stopped short in a way its run can take up again.
fn judging_deferred(attempt: &Attempt) -> bool {
    matches!(
        attempt.reason.as_deref(),
        Some(JUDGING_STOPPED | JUDGES_BUSY)
    )
}

/// What stops a judge panel between its calls: the run's cancel signal and,
/// for a panel inside a run, the run leaving the running state.
#[derive(Clone)]
pub struct JudgeStop {
    cancel: watch::Receiver<bool>,
    run_id: Option<String>,
}
impl JudgeStop {
    pub fn run(run_id: &str, cancel: watch::Receiver<bool>) -> Self {
        Self {
            cancel,
            run_id: Some(run_id.to_string()),
        }
    }
    /// An operator's own request outside any running plan.
    pub fn manual() -> Self {
        Self {
            cancel: watch::channel(false).1,
            run_id: None,
        }
    }
    fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }
    /// A panel inside a run finishes a batch its own stop cut short.
    fn continues_batches(&self) -> bool {
        self.run_id.is_some()
    }
    pub async fn halted(&self, store: &Store) -> Result<bool> {
        if self.cancelled() {
            return Ok(true);
        }
        Ok(match &self.run_id {
            Some(id) => store.run_state(id).await? != "running",
            None => false,
        })
    }
}

pub trait ExecutionBackend: Send + Sync {
    fn unsupported(&self, configuration: &Configuration, draft: &BenchmarkDraft) -> Option<String>;
    /// Scores a creative rendering with a panel of other models; nothing happens
    /// where no panel can be assembled.
    fn judge<'a>(
        &'a self,
        _store: &'a Store,
        attempt: Attempt,
        _version: &'a BenchmarkVersion,
        _stop: JudgeStop,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move { Ok(attempt) })
    }
    /// Settles judge turns a restart cut off. Without host records their usage
    /// stays unknown; the reply never counts as a vote.
    fn reconcile_judges<'a>(
        &'a self,
        _store: &'a Store,
        mut attempt: Attempt,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            for evaluation in attempt.evaluations.iter_mut().filter(|e| in_flight(e)) {
                settle_interrupted_judge(evaluation, None);
            }
            Ok(attempt)
        })
    }
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
    inventories: RunInventories,
}

impl NativeBackend {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            inventories: RunInventories::default(),
        }
    }
}

/// The model inventories a run's attempts are checked against. Listing a
/// bridge's models opens a session on the bridge the user's own chats use,
/// which for Grok runs their session hooks and for Kimi files a session in
/// their history, so it happens once per run, provider and account, and
/// again only once the executable serving them changes.
#[derive(Default)]
struct RunInventories(std::sync::Mutex<std::collections::HashMap<(String, String, String), Value>>);

impl RunInventories {
    /// How many inventories are kept before those of other runs are dropped.
    const LIMIT: usize = 32;

    /// The inventory kept for `run` on `provider` and `account`, if the
    /// executable `serving` them now is the one that listed it.
    fn current(&self, run: &str, provider: &str, account: &str, serving: &Value) -> Option<Value> {
        let kept = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        kept.get(&(run.to_owned(), provider.to_owned(), account.to_owned()))
            .filter(|inventory| !serving.is_null() && inventory.get("executable") == Some(serving))
            .cloned()
    }

    fn keep(&self, run: &str, provider: &str, account: &str, inventory: Value) {
        let mut kept = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if kept.len() >= Self::LIMIT {
            kept.retain(|(kept_run, _, _), _| kept_run == run);
        }
        kept.insert(
            (run.to_owned(), provider.to_owned(), account.to_owned()),
            inventory,
        );
    }
}
/// Host errors read "code: reason". Any other text, such as a provider's own
/// "Internal error: ..." message, is an infrastructure failure.
pub fn host_error(message: String) -> BenchmarkError {
    match message.split_once(':') {
        Some((code, reason))
            if !code.is_empty() && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') =>
        {
            BenchmarkError::new(code, reason.trim())
        }
        _ => BenchmarkError::new("infrastructure_failure", message),
    }
}

/// The model a row stands for: a declared alias resolves to its target, an
/// undeclared moving alias to nothing.
pub(crate) fn concrete_model(provider: &str, model: &str) -> Option<String> {
    let declared = crate::services::agent_host::harness::harness(provider)
        .and_then(|h| h.models.iter().find(|m| m.id.eq_ignore_ascii_case(model)));
    match declared.and_then(|m| m.alias_of) {
        Some(target) => Some(target.to_lowercase()),
        None if matches!(model.to_lowercase().as_str(), "default" | "current") => None,
        None => Some(model.to_lowercase()),
    }
}

/// Up to three judges for a rendering, other providers first. A judge is never
/// the candidate's own model (aliases resolved; an unresolved candidate alias
/// admits no judge) and never an author of the case.
pub(crate) fn select_judges(
    candidates: &[&Configuration],
    draft: &BenchmarkDraft,
    mut offered: Vec<Configuration>,
) -> Vec<Configuration> {
    let excluded: Option<Vec<String>> = candidates
        .iter()
        .map(|c| concrete_model(&c.provider_id, &c.model_id))
        .collect();
    let Some(excluded) = excluded else {
        return Vec::new();
    };
    // Concrete rows first, so an alias never takes its own target's seat.
    offered.sort_by_key(|c| {
        concrete_model(&c.provider_id, &c.model_id).as_deref() != Some(&c.model_id.to_lowercase())
    });
    let mut panel: Vec<(Configuration, String)> = Vec::new();
    for configuration in offered {
        let Some(model) = concrete_model(&configuration.provider_id, &configuration.model_id)
        else {
            continue;
        };
        let mut resolved = configuration.clone();
        resolved.model_id = model.clone();
        if excluded.contains(&model)
            || super::routing::authored_by_candidate(draft, &configuration)
            || super::routing::authored_by_candidate(draft, &resolved)
            || panel.iter().any(|(judge, seated)| {
                judge.provider_id == configuration.provider_id && seated == &model
            })
        {
            continue;
        }
        panel.push((configuration, model));
    }
    let provider = candidates.first().map(|c| c.provider_id.as_str());
    panel.sort_by_key(|(judge, _)| Some(judge.provider_id.as_str()) == provider);
    panel.truncate(MAX_JUDGES);
    panel.into_iter().map(|(judge, _)| judge).collect()
}

/// Whether a provider's models may judge renderings (see
/// [`NativeProvider::judges_images`]).
fn judge_provider_allowed(provider_id: &str) -> bool {
    NativeProvider::for_harness(provider_id).is_some_and(NativeProvider::judges_images)
}

/// What an inventory without an account asks for: a managed account, or the
/// CLI sign-in of a provider whose CLI keeps its own.
fn account_refusal(provider: &str) -> &'static str {
    if crate::services::provider_accounts::uses_cli_login(provider) {
        "Choose the CLI sign-in"
    } else {
        "Choose a managed account"
    }
}

/// Why a configuration cannot run under any verified native profile: an
/// unknown provider, no account (worded for what the provider signs in
/// with), or an effort its profile refuses.
fn profile_refusal(c: &Configuration) -> Option<String> {
    let Some(provider) = NativeProvider::for_harness(&c.provider_id) else {
        return Some("This provider/account has no verified native text execution policy".into());
    };
    if c.account_id.as_deref().is_none_or(str::is_empty) {
        return Some(account_refusal(&c.provider_id).into());
    }
    provider.effort_refusal(c.effort.as_deref())
}

/// Why a configuration cannot run natively: [`profile_refusal`], or a profile
/// whose policy probe has not passed on what this build ships, which runs
/// nothing.
fn native_refusal(c: &Configuration) -> Option<String> {
    profile_refusal(c).or_else(|| {
        NativeProvider::for_harness(&c.provider_id).and_then(NativeProvider::admission_issue)
    })
}

/// Why a panel cannot settle a rendering, before any judge is asked.
pub(crate) fn panel_issue(panel: &[Configuration]) -> Option<String> {
    (panel.len() < MIN_JUDGES).then(|| {
        format!(
            "No judge panel: {} eligible judge(s), at least {MIN_JUDGES} are required",
            panel.len()
        )
    })
}

/// Why a settled judge turn cannot count as a vote: the host flagged it, or
/// the model that answered is not the judge that was asked.
fn judge_turn_failure(judge: &Configuration, status: &ExecutionDispatch) -> Option<String> {
    if let Some(error) = &status.error {
        return Some(
            error["message"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| error.to_string()),
        );
    }
    let Some(selection) = status
        .result
        .as_ref()
        .and_then(|result| result.get("observedSelection"))
    else {
        return Some("Judge turn has no acknowledged selection".into());
    };
    let mut observed = judge.clone();
    observed.model_id = selection["modelId"].as_str().unwrap_or_default().into();
    observed.effort = selection["reasoningEffort"].as_str().map(str::to_owned);
    observed.fast_mode = selection["fastMode"].as_bool();
    (!matches_selection(judge, &observed)).then(|| "Judge selection changed during the turn".into())
}

fn in_flight(evaluation: &Evaluation) -> bool {
    evaluation
        .details
        .as_ref()
        .is_some_and(|d| d["inFlight"] == true)
}

/// Settles a judge placeholder a restart cut off. Recovered usage is kept; the
/// reply never counts because its batch was interrupted.
fn settle_interrupted_judge(evaluation: &mut Evaluation, usage: Option<TokenUsage>) {
    let complete = usage.is_some();
    evaluation.reason = if complete {
        "Judge turn interrupted by a restart; usage recovered from the host"
    } else {
        "Judge turn interrupted by a restart; its usage is unknown"
    }
    .into();
    evaluation.usage = usage;
    if let Some(details) = evaluation.details.as_mut().and_then(Value::as_object_mut) {
        details.insert("inFlight".into(), json!(false));
        details.insert("usageComplete".into(), json!(complete));
    }
}

/// An abstention recorded without any judge session.
fn judge_abstention(
    version: &BenchmarkVersion,
    judge: &Configuration,
    batch: &str,
    reason: String,
) -> Evaluation {
    Evaluation {
        id: uuid::Uuid::new_v4().to_string(),
        evaluator_revision: version.manifest.evaluator.revision.clone(),
        verdict: "abstained".into(),
        score: None,
        reason,
        created_at: now(),
        provenance: "judge_failure".into(),
        artifacts: Vec::new(),
        details: Some(json!({"judgeBatchId": batch, "usageComplete": true})),
        judge: Some(judge.clone()),
        usage: None,
    }
}

/// A judge's Grok sign-in as its panel takes it: one the Grok CLI renews only
/// later answers like a busy account, so the batch waits for it and records
/// nothing, instead of losing the seat to an abstention.
fn judge_sign_in(gate: GrokSignInGate) -> Result<()> {
    match gate {
        GrokSignInGate::Ready => Ok(()),
        GrokSignInGate::WaitUntil(_) | GrokSignInGate::Busy => {
            Err(BenchmarkError::new(ACCOUNT_BUSY, JUDGE_SIGN_IN_WAIT))
        }
    }
}

fn valid_vote(evaluation: &Evaluation) -> bool {
    evaluation.provenance == "judge"
        && evaluation
            .score
            .is_some_and(|s| s.is_finite() && (0.0..=1.0).contains(&s))
}

const PANEL_INCOMPLETE: &str =
    "The judge panel is incomplete; every judge must return a valid score sheet";
/// The error code a judge whose account turned busy answers with.
const ACCOUNT_BUSY: &str = "account_busy";
/// Attempts in flight at once on one account, and across the app.
const ACCOUNT_SLOTS: usize = 4;
const TOTAL_SLOTS: usize = 12;

/// An attempt or a judge panel in flight, keyed in `BenchmarkService::active`
/// by its lane (a configuration, or a run's panel): its run, its account and
/// the signal that cancels it.
pub struct Flight {
    pub run_id: String,
    pub account: String,
    pub exclusive: bool,
    pub cancel: watch::Sender<bool>,
}
/// The error code of a turn the host refused before any provider call because
/// every eligible account waits for quota.
const QUOTA_WAIT: &str = "account_quota_wait";
/// How long a run waits when the host names no quota reset.
const QUOTA_RETRY_MS: i64 = 5 * 60 * 1000;

/// Whether a host error is a quota wait that never reached the provider.
fn is_quota_wait(error: &Value) -> bool {
    let data = error.get("data").unwrap_or(error);
    (data["kind"] == QUOTA_WAIT || data["type"] == QUOTA_WAIT)
        && data["dispatchStarted"] == Value::Bool(false)
}

/// Whether the provider refused a dispatched turn for an exhausted usage
/// allowance before answering anything. Kimi Code reports its 5-hour limit as
/// ACP's `auth_required` with "403 You've reached your 5-hour usage limit".
/// Nothing was measured, so the cell waits for the reset like a quota wait the
/// host saw coming, instead of settling as an infrastructure failure.
fn refused_for_quota(error: &Value, output: &str, usage: &TokenUsage) -> bool {
    crate::services::provider_account_status::is_quota_error(error)
        && output.is_empty()
        && usage.output.unwrap_or(0) == 0
}

/// The longest a run waits on one provider's usage limit. A 5-hour window
/// resets within it, so a reset further off, or refusals that go on past it,
/// are a limit the run cannot wait out.
const QUOTA_WAIT_LIMIT_MS: i64 = (5 * 60 + 15) * 60 * 1000;

/// When each run's provider first refused for quota, while the run waits on
/// it. Kept in memory: a restart begins the wait again.
static QUOTA_SINCE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<(String, String), i64>>,
> = std::sync::LazyLock::new(Default::default);

/// Why a run stopped instead of waiting on a provider's usage limit; the
/// provider's own words follow it.
const QUOTA_STOPPED: &str =
    "A test did not finish: the usage limit ran out and does not reset in time for the run to wait";

/// What a run does once its provider refused a turn for quota.
#[derive(Debug, PartialEq)]
enum QuotaPlan {
    /// Hold the provider's cells until this time and try again.
    WaitUntil(i64),
    /// Stop the run for the operator: the limit will not reset soon.
    Stop,
}

/// Waits for a reset the run can reach: one the host names within
/// [`QUOTA_WAIT_LIMIT_MS`], or, with no time named, a retry every
/// [`QUOTA_RETRY_MS`] while the refusals last no longer than that. A weekly or
/// longer window, a reset further off, or refusals past the limit stop it.
fn quota_plan(run_id: &str, provider_id: &str, error: &str, at: i64) -> QuotaPlan {
    let parsed = serde_json::from_str::<Value>(error).ok();
    let next_reset = parsed
        .as_ref()
        .and_then(|e| e.pointer("/data/nextReset").and_then(Value::as_i64))
        .filter(|reset| *reset > at);
    let words = parsed
        .as_ref()
        .and_then(|e| e["message"].as_str())
        .unwrap_or(error)
        .to_lowercase();
    let long_window = [
        "weekly",
        "per week",
        "monthly",
        "per month",
        "daily",
        "per day",
    ]
    .iter()
    .any(|window| words.contains(window));
    let key = (run_id.to_owned(), provider_id.to_owned());
    let mut since = QUOTA_SINCE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let first = *since.entry(key.clone()).or_insert(at);
    if long_window
        || next_reset.is_some_and(|reset| reset - at > QUOTA_WAIT_LIMIT_MS)
        || at - first > QUOTA_WAIT_LIMIT_MS
    {
        since.remove(&key);
        return QuotaPlan::Stop;
    }
    QuotaPlan::WaitUntil(next_reset.unwrap_or(at + QUOTA_RETRY_MS))
}

/// A turn of `provider_id` finished: the run no longer waits on its limit.
fn quota_recovered(run_id: &str, provider_id: &str) {
    QUOTA_SINCE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&(run_id.to_owned(), provider_id.to_owned()));
}

/// The error code of a Grok turn held back, before any session, until the
/// Grok CLI renews the user's sign-in (see [`grok_sign_in_gate`]). The run's
/// cells of that provider wait on their own, as for a quota wait, while its
/// other providers' cells go on.
const SIGN_IN_WAIT: &str = "sign_in_wait";
/// A sign-in too short for the turn that the Grok CLI renews only later: the
/// user's environment keeps its renewal window narrower than a turn needs
/// (see [`grok::cli_renewal_window_ms`]).
///
/// [`grok::cli_renewal_window_ms`]: crate::services::provider_rate_limits::grok::cli_renewal_window_ms
const SIGN_IN_WAIT_REASON: &str = "The Grok sign-in expires too soon for this test, and GROK_AUTH_EARLY_INVALIDATION_SECS in your environment lets the Grok CLI renew it only later; the run continues on its own once it does";
/// How soon a Grok turn that waits for another to leave the sign-in asks
/// again.
const SIGN_IN_RETRY_MS: i64 = 15 * 1000;
/// A due Grok sign-in that a listing on the chat bridge did not renew.
const GROK_NOT_RENEWED: &str = "the Grok sign-in expires before this turn could end and the Grok CLI did not renew it; open a Grok chat to sign in again";
/// Why a judge whose Grok sign-in waits for the Grok CLI defers its batch.
const JUDGE_SIGN_IN_WAIT: &str = "the judge's Grok sign-in waits for the Grok CLI to renew it";

/// One provider's cells of a run, held until a time the runner knows: a Grok
/// sign-in the Grok CLI renews only later holds the run's Grok cells, and
/// nothing else of the run. Kept in memory, like [`QUOTA_HOLDS`].
static PROVIDER_HOLDS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<(String, String), i64>>,
> = std::sync::LazyLock::new(Default::default);

/// Sends no cell of `provider_id` in `run_id` before `until`; the next
/// dispatch after it asks again.
fn hold_provider_until(run_id: &str, provider_id: &str, until: i64) {
    PROVIDER_HOLDS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert((run_id.to_owned(), provider_id.to_owned()), until);
}

/// Until when `provider_id`'s cells of `run_id` are held, while they are.
fn provider_hold(run_id: &str, provider_id: &str) -> Option<i64> {
    let mut holds = PROVIDER_HOLDS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let key = (run_id.to_owned(), provider_id.to_owned());
    match holds.get(&key) {
        Some(until) if *until > now() => Some(*until),
        Some(_) => {
            holds.remove(&key);
            None
        }
        None => None,
    }
}

fn provider_held(run_id: &str, provider_id: &str) -> bool {
    provider_hold(run_id, provider_id).is_some()
}

/// Whether a turn that failed with `code`, while its attempt was saved in
/// `phase`, never reached the provider, so its cell goes back to the queue
/// instead of settling: a quota wait the host refused before any provider
/// call, a wait for the Grok CLI to renew its sign-in, and anything refused
/// while the attempt was still being prepared, before its prompt was
/// dispatched: a selection the provider would not make, or a runtime,
/// sign-in, preflight or policy the host would not start.
pub(super) fn returns_to_queue(code: &str, phase: &str) -> bool {
    is_wait(code)
        || (phase == "preparing" && matches!(code, "selection_changed" | "capability_missing"))
}

/// Whether `code` holds its run until a time it already knows, rather than
/// asking the operator.
fn is_wait(code: &str) -> bool {
    matches!(code, QUOTA_WAIT | SIGN_IN_WAIT)
}

/// Whether `error` refuses `attempt`, as it was dispatched, for the very
/// reason an earlier refusal returned it to the queue with: the operator
/// resumed the run and nothing changed. Some refusals last as long as the run
/// (a Codex account whose model list is not cached, a Kimi home that cannot
/// be found, a profile changed since its probe); holding the run again would
/// refuse the same cell on every resume, so it settles with that outcome
/// instead, and the run goes on with its other cells. A quota wait and a
/// sign-in renewal wait always wait.
fn refused_again(attempt: &Attempt, error: &BenchmarkError) -> bool {
    !is_wait(&error.code) && attempt.reason.as_deref() == Some(error.message.as_str())
}

/// Puts `attempt` back in the queue with `reason`, without anything of the
/// try the provider never saw.
pub(super) fn requeue(attempt: &mut Attempt, reason: String) {
    attempt.phase = "pending".into();
    attempt.started_at = None;
    attempt.session_id = None;
    attempt.host_run_id = None;
    attempt.observed = None;
    attempt.event_cursor = 0;
    attempt.usage = TokenUsage::default();
    attempt.resolved_model = None;
    attempt.reason = Some(reason);
    attempt.wait_until = None;
}

/// The host request key of an attempt's candidate turn. A turn the host
/// refused before any provider call returns the attempt to the queue, and the
/// next dispatch starts at a new time, so it never meets the refused record.
fn dispatch_key(attempt: &Attempt) -> String {
    format!("benchmark:{}", turn_owner(attempt))
}

/// The owner of an attempt's candidate session. The host keeps one session
/// and one turn per owner, so a turn tried again after a refusal needs a new
/// owner as well as a new key; both carry the start time.
fn turn_owner(attempt: &Attempt) -> String {
    format!("{}:{}", attempt.id, attempt.started_at.unwrap_or_default())
}

/// How a panel's pass over its judges ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PanelEnd {
    /// Every judge was asked.
    Asked,
    /// The run stopped before the next judge.
    Stopped,
    /// An answer left the batch unable to reach its panel size.
    Incomplete,
    /// A judge's account turned busy; the batch waits for it.
    Busy,
}

/// One judge's answer to its batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JudgeAnswer {
    /// A valid vote.
    Vote,
    /// An abstention; the batch lost this seat.
    NoVote,
    /// The judge's account is busy; nothing was recorded or paid.
    Busy,
}

/// One batch's judges as the panel loop sees them.
trait PanelJudges: Send {
    fn halted(&mut self) -> BoxFuture<'_, Result<bool>>;
    /// Asks the judge at `index` of the panel.
    fn ask<'s>(
        &'s mut self,
        index: usize,
        judge: &'s Configuration,
    ) -> BoxFuture<'s, Result<JudgeAnswer>>;
}

/// Asks `judges` (panel index, judge) in order. It stops before a judge when
/// the run halts or a judge's account turns busy, and as soon as the batch
/// can no longer reach `expected` valid votes, so no call is paid that could
/// never count.
async fn ask_panel(
    judges: &[(usize, Configuration)],
    expected: usize,
    mut votes: usize,
    panel: &mut impl PanelJudges,
) -> Result<(PanelEnd, usize)> {
    for (position, (index, judge)) in judges.iter().enumerate() {
        if votes + (judges.len() - position) < expected {
            return Ok((PanelEnd::Incomplete, votes));
        }
        if panel.halted().await? {
            return Ok((PanelEnd::Stopped, votes));
        }
        match panel.ask(*index, judge).await? {
            JudgeAnswer::Vote => votes += 1,
            JudgeAnswer::NoVote => {}
            JudgeAnswer::Busy => return Ok((PanelEnd::Busy, votes)),
        }
    }
    let end = if votes >= expected {
        PanelEnd::Asked
    } else {
        PanelEnd::Incomplete
    };
    Ok((end, votes))
}

/// The attempt's reason after a panel pass: none once the batch settled, else
/// why it stopped short. A stop or a busy judge defers to the run, which
/// finishes the batch with the judges it has not asked yet.
fn panel_reason(
    end: PanelEnd,
    votes: usize,
    expected: usize,
    cancelled: bool,
) -> Option<&'static str> {
    if votes >= expected {
        return None;
    }
    Some(if end == PanelEnd::Stopped || cancelled {
        JUDGING_STOPPED
    } else if end == PanelEnd::Busy {
        JUDGES_BUSY
    } else {
        PANEL_INCOMPLETE
    })
}

/// The newest judge batch a stop cut short: its run finishes it with the
/// judges it has not asked yet. Only a batch whose every answer so far is a
/// valid vote qualifies, since one abstention means it can never settle.
#[derive(Debug)]
struct OpenBatch {
    id: String,
    panel: Vec<Configuration>,
    asked: Vec<Configuration>,
    expected: usize,
    rendering: String,
}

fn open_batch(evaluations: &[Evaluation]) -> Option<OpenBatch> {
    let start = evaluations.iter().rposition(|e| e.provenance == "render")?;
    let marker = &evaluations[start];
    let details = marker.details.as_ref()?;
    let panel: Vec<Configuration> =
        serde_json::from_value(details.pointer("/protocol/panel")?.clone()).ok()?;
    let expected = usize::try_from(details["expectedJudges"].as_u64()?).ok()?;
    let answers = &evaluations[start + 1..];
    if panel.len() != expected || answers.len() >= expected || !answers.iter().all(valid_vote) {
        return None;
    }
    Some(OpenBatch {
        id: details["judgeBatchId"].as_str()?.to_owned(),
        asked: answers.iter().filter_map(|e| e.judge.clone()).collect(),
        panel,
        expected,
        rendering: marker.artifacts.first()?.path.clone(),
    })
}

/// The native panel: each judge's evaluation is saved on the attempt as it lands.
struct NativePanel<'a> {
    backend: &'a NativeBackend,
    store: &'a Store,
    attempt: &'a mut Attempt,
    version: &'a BenchmarkVersion,
    batch: &'a str,
    prompt: &'a str,
    image: &'a OwnedTurnImage,
    criteria: &'a [RubricCriterion],
    stop: &'a JudgeStop,
}

impl PanelJudges for NativePanel<'_> {
    fn halted(&mut self) -> BoxFuture<'_, Result<bool>> {
        Box::pin(self.stop.halted(self.store))
    }
    fn ask<'s>(
        &'s mut self,
        index: usize,
        judge: &'s Configuration,
    ) -> BoxFuture<'s, Result<JudgeAnswer>> {
        Box::pin(async move {
            let evaluation = match self
                .backend
                .ask_judge(
                    self.store,
                    self.attempt,
                    self.version,
                    judge,
                    self.batch,
                    index,
                    self.prompt,
                    self.image,
                    self.criteria,
                    self.stop,
                )
                .await
            {
                Ok(evaluation) => evaluation,
                // A busy account is a reason to wait, not an abstention.
                Err(error) if error.code == ACCOUNT_BUSY => return Ok(JudgeAnswer::Busy),
                Err(error) => judge_abstention(self.version, judge, self.batch, error.message),
            };
            let vote = if valid_vote(&evaluation) {
                JudgeAnswer::Vote
            } else {
                JudgeAnswer::NoVote
            };
            match self
                .attempt
                .evaluations
                .iter_mut()
                .find(|e| e.id == evaluation.id)
            {
                Some(slot) => *slot = evaluation,
                None => self.attempt.evaluations.push(evaluation),
            }
            self.store.save_attempt(self.attempt).await?;
            Ok(vote)
        })
    }
}

/// What a Grok session may do about the user's sign-in now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GrokSignInGate {
    /// The sign-in outlasts the turn: open the session.
    Ready,
    /// Nothing the Grok CLI does renews it before this time; the turn waits
    /// for it, holding only what needs the sign-in.
    WaitUntil(i64),
    /// It is due, and a benchmark turn still runs on it: the renewal, and
    /// this turn, wait for that one to end.
    Busy,
}

/// The user's Grok sign-in as [`grok_sign_in_gate`] sees it: its expiry, and
/// a request on the user's own chat bridge, which the Grok CLI precedes with
/// a renewal once the sign-in is due.
trait GrokSignInSource: Sync {
    fn expiry(&self) -> std::result::Result<Option<i64>, String>;
    /// Whether a benchmark turn is running on the sign-in now.
    fn busy(&self) -> BoxFuture<'_, bool>;
    fn list(&self) -> BoxFuture<'_, Result<()>>;
}

/// The chat bridge the user's Grok chats run: the user's real `GROK_HOME`,
/// as `benchmark_get_inventory` lists it.
struct ChatBridgeSignIn<'a> {
    host: &'a Arc<crate::services::agent_host::router::Inner>,
    provider_id: &'a str,
    account: &'a str,
}

impl GrokSignInSource for ChatBridgeSignIn<'_> {
    fn expiry(&self) -> std::result::Result<Option<i64>, String> {
        crate::services::provider_rate_limits::grok::benchmark_sign_in_expiry()
    }
    fn busy(&self) -> BoxFuture<'_, bool> {
        Box::pin(
            self.host
                .benchmark_bridge_busy(self.provider_id, self.account),
        )
    }
    fn list(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            log::info!(
                "[benchmarks] the Grok sign-in is due; listing models on the chat bridge so the Grok CLI renews it"
            );
            self.host
                .benchmark_inventory(self.provider_id, self.account, true)
                .await
                .map(|_| ())
                .map_err(host_error)
        })
    }
}

/// How long a sign-in the Grok CLI renewed lasted, as last seen in this
/// process, when it fell short of the turn that asked for it. In memory: a
/// restart measures it again with the next renewal.
static GROK_RENEWED_LIFETIME: std::sync::Mutex<Option<i64>> = std::sync::Mutex::new(None);

/// Why a Grok turn of `turn_limit_ms` is refused when the sign-in the Grok
/// CLI renews does not outlast it. The same words every time for the same
/// limit, so a resumed run settles the cell instead of asking again.
fn grok_renewal_too_short(turn_limit_ms: u64) -> String {
    let minutes =
        crate::services::provider_rate_limits::grok::benchmark_sign_in_margin_ms(turn_limit_ms)
            / 60_000;
    format!(
        "the Grok CLI renewed its sign-in, but a renewed sign-in expires before the {minutes} minutes a turn of this time limit needs; run Grok with a shorter time limit"
    )
}

/// A Grok session runs on the user's own sign-in, which the owned process
/// cannot renew: benchmarks hold no refresh token. The Grok CLI the user's
/// chats run renews it, in its own home, before any request it makes once the
/// sign-in is within `renewal_window_ms` of expiry
/// ([`grok::cli_renewal_window_ms`]). So a sign-in that would not outlast a
/// turn of `turn_limit_ms` is renewed the way a chat renews it: one listing on
/// the chat bridge, then the expiry is read again every `poll` for up to ten
/// reads. The chat bridge is started with a window as long as the longest
/// turn's margin ([`grok::chat_bridge_renewal_env`]), so that listing follows
/// at once. Only a user whose environment narrows the window has turns wait
/// for it ([`GrokSignInGate::WaitUntil`]) instead of asking the operator,
/// unless a renewal was already seen to fall short of this turn, which
/// waiting would only repeat. A due sign-in that another benchmark turn still
/// runs on is not renewed under it ([`GrokSignInGate::Busy`]). A renewal that
/// fell short is refused for
/// what it is, with its lifetime kept in `renewed_lifetime`, and a due
/// sign-in the listing did not move is refused as not renewed: both for the
/// operator.
///
/// [`grok::cli_renewal_window_ms`]: crate::services::provider_rate_limits::grok::cli_renewal_window_ms
/// [`grok::chat_bridge_renewal_env`]: crate::services::provider_rate_limits::grok::chat_bridge_renewal_env
async fn grok_sign_in_gate(
    source: &impl GrokSignInSource,
    turn_limit_ms: u64,
    renewal_window_ms: i64,
    renewed_lifetime: &std::sync::Mutex<Option<i64>>,
    poll: Duration,
) -> Result<GrokSignInGate> {
    use crate::services::provider_rate_limits::grok::{self, BenchmarkSignIn};
    let read = || {
        source.expiry().map_err(|error| {
            BenchmarkError::new(
                "capability_missing",
                format!("the Grok sign-in cannot be read: {error}"),
            )
        })
    };
    let step =
        |expiry| grok::benchmark_sign_in_step(expiry, now(), turn_limit_ms, renewal_window_ms);
    let remember = |lifetime: Option<i64>| {
        *renewed_lifetime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = lifetime;
    };
    let before = read()?;
    match step(before) {
        BenchmarkSignIn::Ready => return Ok(GrokSignInGate::Ready),
        BenchmarkSignIn::WaitUntil(at) => {
            let known = *renewed_lifetime
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if known
                .is_some_and(|lifetime| lifetime < grok::benchmark_sign_in_margin_ms(turn_limit_ms))
            {
                return Err(BenchmarkError::new(
                    "capability_missing",
                    grok_renewal_too_short(turn_limit_ms),
                ));
            }
            return Ok(GrokSignInGate::WaitUntil(at));
        }
        BenchmarkSignIn::Renew => {}
    }
    // A turn in flight keeps the sign-in it started on. It also keeps its
    // bridge, which no later turn may use, so nothing is lost by waiting.
    if source.busy().await {
        return Ok(GrokSignInGate::Busy);
    }
    source.list().await?;
    // The CLI renews before the request that needs the session and writes
    // its home's auth file under a lock; allow it a few seconds.
    for read_count in 0..10 {
        if read_count > 0 {
            tokio::time::sleep(poll).await;
        }
        let after = read()?;
        if step(after) == BenchmarkSignIn::Ready {
            log::info!("[benchmarks] the Grok CLI renewed its sign-in");
            remember(None);
            return Ok(GrokSignInGate::Ready);
        }
        // Renewed, but for less than the turn needs: no wait or listing
        // makes it longer.
        if let (Some(before), Some(after)) = (before, after) {
            if after > before {
                remember(Some(after - now()));
                return Err(BenchmarkError::new(
                    "capability_missing",
                    grok_renewal_too_short(turn_limit_ms),
                ));
            }
        }
    }
    Err(BenchmarkError::new("capability_missing", GROK_NOT_RENEWED))
}

impl NativeBackend {
    /// `result`, the host inventory of `provider` on `account`, as the rows a
    /// configuration is chosen from: each pinned to its runtime identity, and
    /// unavailable, with the reason, where the profile may not run.
    async fn inventory_rows(
        &self,
        provider: &str,
        account: &str,
        result: &Value,
    ) -> Result<Vec<InventoryModel>> {
        let record =
            crate::services::provider_accounts::account(&self.app, account).map_err(host_error)?;
        let billing = record.auth_method;
        // A provider with no verified profile is listed but never pinned
        // or admitted.
        let native = NativeProvider::for_harness(provider);
        let native_cli = crate::services::managed_acp_tools::native_cli_path(&self.app, provider);
        let identity = match native {
            Some(native) => Some(runtime_identity(result, native, native_cli.clone()).await?),
            None => None,
        };
        let unavailable = match native {
            None => Some("Native execution restrictions have not been verified".to_string()),
            Some(native) => match native.admission_issue() {
                Some(issue) => Some(issue),
                None => match runtime_issue(result, native, native_cli).await {
                    Some(issue) => Some(issue),
                    // Every Codex thread loads the account's home, and the
                    // personal skills of the user's own profile.
                    None if native == NativeProvider::Codex => {
                        crate::services::provider_accounts::account_home(&self.app, &record)
                            .and_then(|home| codex_home_preflight(&home))
                            .and_then(|()| {
                                codex_user_skills_preflight(codex_user_profile().as_deref())
                            })
                            .err()
                    }
                    None => None,
                },
            },
        };
        let excluded = native.map_or(&[][..], NativeProvider::excluded_efforts);
        Ok(result["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                let id = row
                    .get("modelId")
                    .or_else(|| row.get("id"))
                    .and_then(Value::as_str)?;
                let efforts = offered_efforts(row, excluded);
                let name = row["name"].as_str().unwrap_or(id);
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
                        inventory_revision: identity
                            .as_ref()
                            .map(|identity| identity.revision(result, id)),
                        model_name: (name != id).then(|| name.to_string()),
                    },
                    name: name.into(),
                    efforts,
                    supports_fast_mode: row["supportsFast"].as_bool().unwrap_or(false),
                    available: unavailable.is_none(),
                    reason: unavailable.clone(),
                })
            })
            .collect())
    }

    /// The inventory `run`'s attempts on `provider` and `account` are checked
    /// against: listed once for the run, and again only once another
    /// executable serves them (see [`RunInventories`]).
    async fn run_inventory(
        &self,
        host: &Arc<crate::services::agent_host::router::Inner>,
        run: &str,
        provider: &str,
        account: &str,
    ) -> Result<Value> {
        let serving = host.benchmark_serving_executable(provider, account).await;
        if let Some(inventory) = self.inventories.current(run, provider, account, &serving) {
            return Ok(inventory);
        }
        let inventory = host
            .benchmark_inventory(provider, account, true)
            .await
            .map_err(host_error)?;
        self.inventories
            .keep(run, provider, account, inventory.clone());
        Ok(inventory)
    }

    /// [`grok_sign_in_gate`] for a Grok session of up to `turn_limit_ms` on
    /// `account`, renewing through the user's own chat bridge: a candidate
    /// turn and a judge turn alike.
    async fn renew_grok_sign_in(
        &self,
        host: &Arc<crate::services::agent_host::router::Inner>,
        provider_id: &str,
        account: &str,
        turn_limit_ms: u64,
    ) -> Result<GrokSignInGate> {
        grok_sign_in_gate(
            &ChatBridgeSignIn {
                host,
                provider_id,
                account,
            },
            turn_limit_ms,
            crate::services::provider_rate_limits::grok::cli_renewal_window_ms(),
            &GROK_RENEWED_LIFETIME,
            Duration::from_millis(500),
        )
        .await
    }

    /// The panel for one rendering from every enabled account's available models.
    async fn judge_panel(
        &self,
        attempt: &Attempt,
        draft: &BenchmarkDraft,
    ) -> Result<Vec<Configuration>> {
        let snapshot =
            crate::services::provider_accounts::snapshot(&self.app).map_err(host_error)?;
        let host = self
            .app
            .state::<AgentHost>()
            .get_or_start(&self.app)
            .await
            .map_err(host_error)?;
        let mut offered = Vec::new();
        for account in snapshot
            .accounts
            .iter()
            .filter(|account| account.enabled && judge_provider_allowed(&account.provider_id))
        {
            // Listed once per run, like the candidates' own bridges.
            let listed = self
                .run_inventory(&host, &attempt.run_id, &account.provider_id, &account.id)
                .await;
            let Ok(models) = (match listed {
                Ok(listed) => {
                    self.inventory_rows(&account.provider_id, &account.id, &listed)
                        .await
                }
                Err(error) => Err(error),
            }) else {
                continue;
            };
            offered.extend(
                models
                    .into_iter()
                    .filter(|model| model.available)
                    .map(|model| model.configuration),
            );
        }
        let mut candidates = vec![&attempt.configuration];
        candidates.extend(attempt.observed.as_ref());
        Ok(select_judges(&candidates, draft, offered))
    }

    /// Whether every judge's account is free before a batch starts or
    /// continues. A judge that turns busy mid-panel also defers the batch.
    async fn judges_idle(&self, panel: &[Configuration]) -> Result<bool> {
        let host = self
            .app
            .state::<AgentHost>()
            .get_or_start(&self.app)
            .await
            .map_err(host_error)?;
        for judge in panel {
            let Some(account) = judge.account_id.as_deref() else {
                return Ok(false);
            };
            let activity = host
                .account_activity(&judge.provider_id, account)
                .await
                .map_err(host_error)?;
            if !activity.active_sessions.is_empty() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// One judge's evaluation. A placeholder is saved before the turn is sent,
    /// so a restart still finds the session and its spend; the result reuses
    /// the placeholder's id.
    #[allow(clippy::too_many_arguments)]
    async fn ask_judge(
        &self,
        store: &Store,
        attempt: &mut Attempt,
        version: &BenchmarkVersion,
        judge: &Configuration,
        batch: &str,
        index: usize,
        prompt: &str,
        image: &OwnedTurnImage,
        criteria: &[RubricCriterion],
        stop: &JudgeStop,
    ) -> Result<Evaluation> {
        let host = self
            .app
            .state::<AgentHost>()
            .get_or_start(&self.app)
            .await
            .map_err(host_error)?;
        let Some(account) = judge.account_id.clone() else {
            return Ok(judge_abstention(
                version,
                judge,
                batch,
                "Judge has no managed account".into(),
            ));
        };
        let activity = host
            .account_activity(&judge.provider_id, &account)
            .await
            .map_err(host_error)?;
        // Interactive work has priority; the batch waits and nothing is paid.
        if !activity.active_sessions.is_empty() {
            return Err(BenchmarkError::new(
                ACCOUNT_BUSY,
                "Judge account became busy",
            ));
        }
        let cwd = store
            .root
            .join("runs")
            .join(&attempt.run_id)
            .join(&attempt.id)
            .join(format!("judge-{batch}-{index}"));
        tokio::fs::create_dir_all(&cwd).await?;
        let timeout = Duration::from_secs(180);
        // A Grok judge's sign-in is renewed as a candidate's is. One the
        // Grok CLI renews only later defers the batch like a busy account,
        // rather than costing it this judge's seat; a refusal abstains.
        if NativeProvider::for_harness(&judge.provider_id) == Some(NativeProvider::Grok) {
            let gate = self
                .renew_grok_sign_in(
                    &host,
                    &judge.provider_id,
                    &account,
                    timeout.as_millis() as u64,
                )
                .await?;
            judge_sign_in(gate)?;
        }
        let session = host
            .create_owned_session(
                OwnedSessionRequest {
                    owner_id: format!("{}:judge:{batch}:{index}", attempt.id),
                    provider_id: judge.provider_id.clone(),
                    account_id: account,
                    model_id: judge.model_id.clone(),
                    reasoning_effort: judge.effort.clone(),
                    fast_mode: judge.fast_mode,
                    cwd: cwd.to_string_lossy().into_owned(),
                    title: format!("Benchmark judge: {}", version.manifest.name),
                    profile: ExecutionProfile::NativeTextV1,
                },
                timeout.as_millis() as u64,
            )
            .await
            .map_err(host_error)?;
        let mut acknowledged = judge.clone();
        acknowledged.model_id = session.selection.model_id.clone().unwrap_or_default();
        acknowledged.effort = session.selection.reasoning_effort.clone();
        acknowledged.fast_mode = session.selection.fast_mode;
        if !session.substitutions.is_empty() || !matches_selection(judge, &acknowledged) {
            let mut abstention = judge_abstention(
                version,
                judge,
                batch,
                "Judge selection was not acknowledged".into(),
            );
            abstention.details = Some(json!({"judgeBatchId": batch,
                "sessionId": session.session_id, "usageComplete": true}));
            return Ok(abstention);
        }
        let key = format!("benchmark:{}:judge:{batch}:{index}", attempt.id);
        let mut placeholder =
            judge_abstention(version, judge, batch, "Judge turn in flight".into());
        placeholder.details = Some(
            json!({"judgeBatchId": batch, "sessionId": session.session_id,
            "requestKey": key, "usageComplete": false, "inFlight": true}),
        );
        let placeholder_id = placeholder.id.clone();
        attempt.evaluations.push(placeholder);
        if let Err(error) = store.save_attempt(attempt).await {
            attempt.evaluations.pop();
            return Err(error);
        }
        let dispatch = host
            .dispatch_owned_turn(OwnedTurnRequest {
                session_id: session.session_id.clone(),
                request_key: key.clone(),
                prompt: prompt.to_string(),
                policy_hash: session.policy_hash,
                timeout_ms: timeout.as_millis() as u64,
                images: vec![image.clone()],
            })
            .await;
        let started = Instant::now();
        let mut cursor = 0i64;
        let mut reply = String::new();
        let mut usage = TokenUsage::default();
        let mut failure = dispatch.err();
        let mut turn_failure = None;
        while failure.is_none() {
            if stop.cancelled() {
                let _ = host.cancel_owned_turn(&key).await;
                failure = Some("Judging cancelled".to_string());
                break;
            }
            if started.elapsed() > timeout + Duration::from_secs(15) {
                let _ = host.cancel_owned_turn(&key).await;
                failure = Some("Judge exceeded its time budget".to_string());
                break;
            }
            let page = match host
                .read_owned_events(&session.session_id, cursor, 200)
                .await
            {
                Ok(page) => page,
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            };
            for event in page.events {
                consume_event(&event.payload, &mut reply, &mut usage);
            }
            cursor = page.cursor;
            let status = match host.execution_status(&key).await {
                Ok(status) => status,
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            };
            match status {
                Some(status)
                    if status.phase == "terminal"
                        && !page.has_more
                        && cursor >= status.event_cursor =>
                {
                    // A flagged or substituted turn abstains; its spend still counts.
                    turn_failure = judge_turn_failure(judge, &status);
                    break;
                }
                None => {
                    failure = Some("Judge execution status is unavailable".into());
                    break;
                }
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let usage_complete = failure.is_none();
        if !usage_complete {
            let _ = host.cancel_owned_turn(&key).await;
        }
        let failure = failure.or(turn_failure);
        let parsed = failure
            .is_none()
            .then(|| parse_judge_reply(&reply, criteria))
            .flatten();
        let score = parsed
            .as_ref()
            .map(|(shares, _)| weighted_share(shares, criteria));
        let reason = match &parsed {
            Some((_, notes)) if !notes.is_empty() => notes.clone(),
            Some(_) => "Scored by the judge panel".into(),
            None => failure.unwrap_or_else(|| "Judge returned no valid score sheet".into()),
        };
        Ok(Evaluation {
            id: placeholder_id,
            evaluator_revision: version.manifest.evaluator.revision.clone(),
            verdict: if score.is_some() {
                "judged"
            } else {
                "abstained"
            }
            .into(),
            score,
            reason,
            created_at: now(),
            provenance: if score.is_some() {
                "judge"
            } else {
                "judge_failure"
            }
            .into(),
            artifacts: Vec::new(),
            details: Some(
                json!({"judgeBatchId": batch, "sessionId": session.session_id, "usageComplete": usage_complete,
                "durationMs": started.elapsed().as_millis() as u64,
                "criteria": parsed.map(|(shares, _)| shares)}),
            ),
            judge: Some(judge.clone()),
            usage: Some(usage),
        })
    }
}

impl ExecutionBackend for NativeBackend {
    fn judge<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
        version: &'a BenchmarkVersion,
        stop: JudgeStop,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            let criteria = rubric_criteria(&version.manifest);
            if criteria.is_empty() {
                return Ok(attempt);
            }
            // An answer without markup is settled as a failure by evaluate().
            let Some(document) = render_document(
                attempt.output.as_deref().unwrap_or_default(),
                version.manifest.facets.output_format.as_deref(),
            ) else {
                return Ok(attempt);
            };
            // Nothing is written until the panel can settle the rendering, so a
            // batch that cannot finish never replaces a settled score.
            if stop.halted(store).await? {
                attempt.reason = Some(JUDGING_STOPPED.into());
                return Ok(attempt);
            }
            let prompt = judge_prompt(&version.manifest, &criteria);
            // A batch its run's stop cut short is finished by the judges it has
            // not asked yet, so the plan's reservation still covers it.
            let open = match stop
                .continues_batches()
                .then(|| open_batch(&attempt.evaluations))
                .flatten()
            {
                Some(open) => tokio::fs::read(&open.rendering)
                    .await
                    .ok()
                    .map(|png| (open, png)),
                None => None,
            };
            let (batch, judges, expected, votes, png) = match open {
                Some((open, png)) => {
                    let judges: Vec<(usize, Configuration)> = open
                        .panel
                        .into_iter()
                        .enumerate()
                        .filter(|(_, judge)| !open.asked.contains(judge))
                        .collect();
                    let waiting: Vec<Configuration> =
                        judges.iter().map(|(_, judge)| judge.clone()).collect();
                    if !self.judges_idle(&waiting).await? {
                        attempt.reason = Some(JUDGES_BUSY.into());
                        return Ok(attempt);
                    }
                    (open.id, judges, open.expected, open.asked.len(), png)
                }
                None => {
                    let panel = self.judge_panel(&attempt, &version.manifest).await?;
                    if let Some(issue) = panel_issue(&panel) {
                        attempt.reason = Some(issue);
                        return Ok(attempt);
                    }
                    if !self.judges_idle(&panel).await? {
                        attempt.reason = Some(JUDGES_BUSY.into());
                        return Ok(attempt);
                    }
                    let png = match super::worker::render(&document, 1024, 768).await {
                        Ok(bytes) => bytes,
                        Err(error) => {
                            attempt.reason = Some(format!("Rendering failed: {}", error.message));
                            return Ok(attempt);
                        }
                    };
                    let directory = store
                        .root
                        .join("runs")
                        .join(&attempt.run_id)
                        .join(&attempt.id);
                    tokio::fs::create_dir_all(&directory).await?;
                    let batch = uuid::Uuid::new_v4().to_string();
                    let expected = panel.len();
                    let protocol = json!({"panel": panel, "prompt": prompt,
                        "renderer": JUDGE_RENDERER, "samplesPerJudge": 1, "expectedJudges": expected});
                    let protocol_hash = judge_protocol_hash(&panel, &prompt);
                    let path = directory.join(format!("rendering-{batch}.png"));
                    tokio::fs::write(&path, &png).await?;
                    let settled = super::analysis::score(&attempt).is_some();
                    attempt.evaluations.push(Evaluation {
                        id: uuid::Uuid::new_v4().to_string(),
                        evaluator_revision: version.manifest.evaluator.revision.clone(),
                        verdict: "rendered".into(),
                        score: None,
                        reason: "Rendered for the judge panel".into(),
                        created_at: now(),
                        provenance: "render".into(),
                        artifacts: vec![Artifact {
                            kind: "screenshot".into(),
                            path: path.to_string_lossy().into_owned(),
                            hash: hex::encode(Sha256::digest(&png)),
                            label: "Rendering".into(),
                        }],
                        details: Some(json!({"judgeBatchId": batch, "expectedJudges": expected,
                            "protocolHash": protocol_hash, "protocol": protocol})),
                        judge: None,
                        usage: None,
                    });
                    if !settled {
                        attempt.outcome = Some("pending_review".into());
                    }
                    store.save_attempt(&attempt).await?;
                    (
                        batch,
                        panel.into_iter().enumerate().collect(),
                        expected,
                        0,
                        png,
                    )
                }
            };
            let image = OwnedTurnImage {
                data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png),
                mime_type: "image/png".into(),
            };
            let (end, votes) = ask_panel(
                &judges,
                expected,
                votes,
                &mut NativePanel {
                    backend: self,
                    store,
                    attempt: &mut attempt,
                    version,
                    batch: &batch,
                    prompt: &prompt,
                    image: &image,
                    criteria: &criteria,
                    stop: &stop,
                },
            )
            .await?;
            if votes >= expected {
                attempt.outcome = Some("judged".into());
            }
            attempt.reason =
                panel_reason(end, votes, expected, stop.cancelled()).map(str::to_owned);
            Ok(attempt)
        })
    }
    fn reconcile_judges<'a>(
        &'a self,
        _store: &'a Store,
        mut attempt: Attempt,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            let host = self
                .app
                .state::<AgentHost>()
                .get_or_start(&self.app)
                .await
                .map_err(host_error)?;
            for evaluation in attempt.evaluations.iter_mut().filter(|e| in_flight(e)) {
                let details = evaluation.details.clone().unwrap_or_default();
                let (Some(key), Some(session)) = (
                    details["requestKey"].as_str(),
                    details["sessionId"].as_str(),
                ) else {
                    settle_interrupted_judge(evaluation, None);
                    continue;
                };
                let status = host.execution_status(key).await.ok().flatten();
                let Some(status) = status.filter(|s| s.phase == "terminal") else {
                    let _ = host.cancel_owned_turn(key).await;
                    settle_interrupted_judge(evaluation, None);
                    continue;
                };
                let mut usage = TokenUsage::default();
                let mut reply = String::new();
                let mut cursor = 0i64;
                let complete = loop {
                    let Ok(page) = host.read_owned_events(session, cursor, 200).await else {
                        break false;
                    };
                    for event in page.events {
                        consume_event(&event.payload, &mut reply, &mut usage);
                    }
                    let advanced = page.cursor > cursor;
                    cursor = page.cursor;
                    if !page.has_more || !advanced {
                        break !page.has_more && cursor >= status.event_cursor;
                    }
                };
                settle_interrupted_judge(evaluation, complete.then_some(usage));
            }
            Ok(attempt)
        })
    }
    fn unsupported(&self, c: &Configuration, d: &BenchmarkDraft) -> Option<String> {
        if let Some(reason) = native_refusal(c) {
            return Some(reason);
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
                BenchmarkError::new("capability_missing", account_refusal(provider))
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
            self.inventory_rows(provider, account, &result).await
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
                BenchmarkError::new(
                    "capability_missing",
                    account_refusal(&attempt.configuration.provider_id),
                )
            })?;
            let provider = NativeProvider::for_harness(&attempt.configuration.provider_id)
                .ok_or_else(|| {
                    BenchmarkError::new(
                        "capability_missing",
                        "This provider has no verified native no-tool execution profile",
                    )
                })?;
            // Interactive work has priority, before anything touches the
            // bridge that serves it, and again once the runtime is checked.
            let busy = || async {
                let activity = host
                    .account_activity(&attempt.configuration.provider_id, &account)
                    .await
                    .map_err(host_error)?;
                if activity.active_sessions.is_empty() {
                    Ok(())
                } else {
                    Err(BenchmarkError::new(
                        "account_busy",
                        "Interactive work has priority; account is active",
                    ))
                }
            };
            busy().await?;
            let inventory = self
                .run_inventory(
                    &host,
                    &attempt.run_id,
                    &attempt.configuration.provider_id,
                    &account,
                )
                .await?;
            let native_cli = crate::services::managed_acp_tools::native_cli_path(
                &self.app,
                &attempt.configuration.provider_id,
            );
            let runtime_revision = inventory_fingerprint(
                &inventory,
                provider,
                native_cli,
                &attempt.configuration.model_id,
            )
            .await?;
            if attempt
                .configuration
                .inventory_revision
                .as_ref()
                .is_some_and(|revision| revision != &runtime_revision)
            {
                return Err(BenchmarkError::new("selection_changed","Installed runtime or model capabilities changed since configuration selection; refresh inventory"));
            }
            busy().await?;
            let timeout_seconds = effective_timeout_seconds(timeout, &version.manifest);
            if provider == NativeProvider::Grok {
                let gate = self
                    .renew_grok_sign_in(
                        &host,
                        &attempt.configuration.provider_id,
                        &account,
                        u64::from(timeout_seconds) * 1000,
                    )
                    .await?;
                // Only this run's Grok cells wait; its other providers go on.
                match gate {
                    GrokSignInGate::Ready => {}
                    GrokSignInGate::WaitUntil(at) => {
                        hold_provider_until(
                            &attempt.run_id,
                            &attempt.configuration.provider_id,
                            at,
                        );
                        return Err(BenchmarkError::new(SIGN_IN_WAIT, SIGN_IN_WAIT_REASON));
                    }
                    GrokSignInGate::Busy => {
                        return Err(BenchmarkError::new(
                            SIGN_IN_WAIT,
                            crate::services::provider_rate_limits::grok::BENCHMARK_BRIDGE_BUSY,
                        ));
                    }
                }
            }
            let cwd = store
                .root
                .join("runs")
                .join(&attempt.run_id)
                .join(&attempt.id)
                .join("workspace");
            tokio::fs::create_dir_all(&cwd).await?;
            let session = host
                .create_owned_session(
                    OwnedSessionRequest {
                        owner_id: turn_owner(&attempt),
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
                    },
                    u64::from(timeout_seconds) * 1000,
                )
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
            let key = dispatch_key(&attempt);
            let started = Instant::now();
            let dispatch = host
                .dispatch_owned_turn(OwnedTurnRequest {
                    session_id: session.session_id.clone(),
                    request_key: key.clone(),
                    prompt: prompt_with_fixtures(&version.manifest)?,
                    policy_hash: session.policy_hash,
                    timeout_ms: u64::from(timeout_seconds) * 1000,
                    images: Vec::new(),
                })
                .await
                .map_err(host_error)?;
            attempt.host_run_id = Some(dispatch.run_id);
            attempt.phase = "running".into();
            store.save_attempt(&attempt).await?;
            let mut cancelled = false;
            let mut timed_out = false;
            let mut cancellation_started = None;
            let mut capture = TurnCapture::new(version.manifest.limits.max_artifact_bytes);
            // The host's terminal dispatch record; every way out of the loop
            // but an error sets it.
            let terminal;
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
                    capture.read(event.payload, &mut attempt)?;
                }
                attempt.event_cursor = page.cursor;
                // An answer past the published cap, or a broken no-tool
                // policy, has already decided the attempt; stop paying for
                // the rest of the turn. The size of the event record never
                // does (see `evidence`).
                if (capture.cap_answer() || capture.violation.is_some()) && !cancelled {
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
                    if let Some(error) = status.error.as_ref().filter(|e| {
                        is_quota_wait(e) || refused_for_quota(e, &capture.output, &attempt.usage)
                    }) {
                        return Err(BenchmarkError::new(QUOTA_WAIT, error.to_string()));
                    }
                    terminal = json!({"terminalDispatch":status});
                    if let Some(result) = status.result.as_ref() {
                        consume_terminal_result(result, &mut attempt);
                    }
                    if let Some(violation) = capture.violation.take() {
                        attempt.outcome = Some("execution_violation".into());
                        attempt.reason = Some(violation);
                        break;
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
                    if capture.answer_capped {
                        attempt.outcome = Some("budget_reached".into());
                        attempt.reason = Some(ANSWER_CAP_REASON.into());
                    } else if let Some(error) = status.error {
                        attempt.outcome =
                            Some(terminal_outcome(&error, &attempt.configuration.model_id).into());
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
            attempt.output = Some(std::mem::take(&mut capture.output));
            attempt.duration_ms = Some(started.elapsed().as_millis() as u64);
            attempt.finished_at = Some(now());
            attempt.phase = "collecting".into();
            mark_auxiliary_profile(&mut attempt);
            let evidence = capture.evidence.close(terminal);
            attempt.evidence_hash = Some(fixtures::seal(&store.root, &attempt, &evidence).await?);
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
            // Dispatches made before keys carried their start time used ":0".
            let mut found = None;
            for key in [
                dispatch_key(&attempt),
                format!("benchmark:{}:0", attempt.id),
            ] {
                found = host.execution_status(&key).await.map_err(host_error)?;
                if found.is_some() {
                    break;
                }
            }
            let Some(status) = found else {
                return Ok(None);
            };
            if status.phase != "terminal" {
                return Ok(None);
            }
            attempt.session_id = Some(status.session_id.clone());
            attempt.host_run_id = Some(status.run_id.clone());
            attempt.event_cursor = 0;
            attempt.usage = TokenUsage::default();
            attempt.resolved_model = None;
            // The same caps as a turn the runner watched: the published one
            // on the answer, the evidence ceiling on the record.
            let cap = store
                .version(&attempt.version_id)
                .await?
                .manifest
                .limits
                .max_artifact_bytes;
            let mut capture = TurnCapture::new(cap);
            loop {
                let page = host
                    .read_owned_events(&status.session_id, attempt.event_cursor, 200)
                    .await
                    .map_err(host_error)?;
                for event in page.events {
                    capture.read(event.payload, &mut attempt)?;
                }
                attempt.event_cursor = page.cursor;
                capture.cap_answer();
                if !page.has_more && attempt.event_cursor >= status.event_cursor {
                    break;
                }
            }
            if let Some(result) = status.result.as_ref() {
                consume_terminal_result(result, &mut attempt);
            }
            let terminal = json!({"terminalDispatch":status});
            attempt.output = Some(std::mem::take(&mut capture.output));
            attempt.finished_at = Some(now());
            attempt.outcome = Some(
                status
                    .error
                    .as_ref()
                    .map(|error| terminal_outcome(error, &attempt.configuration.model_id))
                    .unwrap_or("completed")
                    .into(),
            );
            attempt.reason = status.error.map(|v| v.to_string());
            if capture.answer_capped {
                attempt.outcome = Some("budget_reached".into());
                attempt.reason = Some(RECOVERED_ANSWER_CAP_REASON.into());
            }
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
            if let Some(violation) = capture.violation.take() {
                attempt.outcome = Some("execution_violation".into());
                attempt.reason = Some(violation);
            }
            mark_auxiliary_profile(&mut attempt);
            let evidence = capture.evidence.close(terminal);
            attempt.evidence_hash = Some(fixtures::seal(&store.root, &attempt, &evidence).await?);
            Ok(Some(attempt))
        })
    }
}

/// Why an attempt whose answer passed the published artifact cap settled as
/// a budget failure.
pub(crate) const ANSWER_CAP_REASON: &str =
    "The answer exceeded the published artifact cap; cancellation acknowledged";
/// The same, found while recovering a turn a restart cut off.
const RECOVERED_ANSWER_CAP_REASON: &str = "The recovered answer exceeds the published artifact cap";

/// What a turn's events add up to as the runner reads them: the answer, the
/// first policy violation and the record to seal, with the usage and the
/// model that answered written on the attempt. Only the answer counts
/// against the published artifact cap; the record has a ceiling of its own
/// (see [`super::evidence::EvidenceLog`]) and never ends the turn.
struct TurnCapture {
    cap: usize,
    output: String,
    violation: Option<String>,
    answer_capped: bool,
    evidence: super::evidence::EvidenceLog,
}

impl TurnCapture {
    fn new(max_artifact_bytes: u64) -> Self {
        Self::with_evidence(max_artifact_bytes, super::evidence::EvidenceLog::default())
    }

    fn with_evidence(max_artifact_bytes: u64, evidence: super::evidence::EvidenceLog) -> Self {
        Self {
            cap: usize::try_from(max_artifact_bytes).unwrap_or(usize::MAX),
            output: String::new(),
            violation: None,
            answer_capped: false,
            evidence,
        }
    }

    fn read(&mut self, payload: Value, attempt: &mut Attempt) -> Result<()> {
        consume_event(&payload, &mut self.output, &mut attempt.usage);
        if let Some(model) = resolved_model_of(&payload) {
            attempt.resolved_model = Some(model);
        }
        if self.violation.is_none() {
            self.violation = violation_of(&payload);
        }
        self.evidence.push(payload)
    }

    /// Cuts an answer that passed the cap back to it, on a character
    /// boundary, and says whether it ever passed it.
    fn cap_answer(&mut self) -> bool {
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
fn violation_of(event: &Value) -> Option<String> {
    let params = event.get("params").unwrap_or(event);
    let update = params.get("update").unwrap_or(params);
    update
        .pointer("/_meta/executionViolation")
        .and_then(Value::as_str)
        .map(str::to_owned)
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
fn resolved_model_of(value: &Value) -> Option<String> {
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
/// The runtime identity the configurations of one inventory are pinned to.
enum RuntimeIdentity {
    /// Claude: one revision for every row, the way its configurations were
    /// first pinned.
    Shared(String),
    /// A profile configured by the policy resource: the runtime, which each
    /// row completes with its own model, so a change to another row of the
    /// vendor's list leaves a configuration's revision alone.
    PerModel(Sha256),
}

impl RuntimeIdentity {
    /// The revision of a configuration on `model_id`.
    fn revision(&self, inventory: &Value, model_id: &str) -> String {
        match self {
            Self::Shared(revision) => revision.clone(),
            Self::PerModel(runtime) => {
                let mut hash = runtime.clone();
                match model_row_identity(inventory, model_id) {
                    Some(row) => {
                        hash.update(b"model\0");
                        hash.update(row.as_bytes());
                    }
                    None => {
                        hash.update(b"unlisted\0");
                        hash.update(model_id.as_bytes());
                    }
                }
                hex::encode(hash.finalize())
            }
        }
    }
}

/// The runtime identity of `inventory` under `provider`'s profile.
/// `native_cli` is the managed native CLI, for a profile that pins it.
async fn runtime_identity(
    inventory: &Value,
    provider: NativeProvider,
    native_cli: Option<std::path::PathBuf>,
) -> Result<RuntimeIdentity> {
    Ok(match provider {
        NativeProvider::Claude => {
            RuntimeIdentity::Shared(claude_inventory_fingerprint(inventory).await?)
        }
        NativeProvider::Codex | NativeProvider::Grok | NativeProvider::Kimi => {
            RuntimeIdentity::PerModel(
                configured_runtime_hash(inventory, provider, native_cli).await?,
            )
        }
    })
}

/// The runtime identity a configuration on `model_id` is pinned to.
async fn inventory_fingerprint(
    inventory: &Value,
    provider: NativeProvider,
    native_cli: Option<std::path::PathBuf>,
    model_id: &str,
) -> Result<String> {
    Ok(runtime_identity(inventory, provider, native_cli)
        .await?
        .revision(inventory, model_id))
}
/// The entrypoint an inventory's executable fingerprint names.
fn inventory_entrypoint(inventory: &Value) -> Result<std::path::PathBuf> {
    inventory
        .pointer("/executable/path")
        .and_then(Value::as_str)
        .map(std::path::PathBuf::from)
        .ok_or_else(|| {
            BenchmarkError::new(
                "capability_missing",
                "Host inventory has no executable provenance",
            )
        })
}
/// The file `provider`'s entrypoint pin describes behind `executable`, the
/// file an inventory names: that file itself, except for Kimi, whose chat
/// bridge runs the npm shim of the package entrypoint the profile pins.
fn pinned_entrypoint(
    provider: NativeProvider,
    executable: std::path::PathBuf,
) -> std::result::Result<std::path::PathBuf, String> {
    match provider {
        NativeProvider::Kimi => kimi_entrypoint(&executable),
        NativeProvider::Grok => Ok(grok_binary(&executable)),
        _ => Ok(executable),
    }
}
/// Why `provider`'s pinned runtime behind `inventory` cannot run, if it
/// cannot. Hashing a native CLI the first time takes a moment, so it runs off
/// the async workers.
async fn runtime_issue(
    inventory: &Value,
    provider: NativeProvider,
    native_cli: Option<std::path::PathBuf>,
) -> Option<String> {
    let Ok(executable) = inventory_entrypoint(inventory) else {
        return Some("Native executable provenance is missing".into());
    };
    let entrypoint = match pinned_entrypoint(provider, executable) {
        Ok(entrypoint) => entrypoint,
        Err(issue) => return Some(issue),
    };
    tokio::task::spawn_blocking(move || {
        provider
            .verify_runtime(&RuntimePaths {
                entrypoint: &entrypoint,
                native_cli: native_cli.as_deref(),
            })
            .err()
    })
    .await
    .unwrap_or_else(|error| Some(error.to_string()))
}
/// The runtime half of a profile configured by the policy resource: the
/// digest of each pinned file as it is now, the managed bridge's own lock
/// entry, the policy and the adapter. [`RuntimeIdentity::revision`] adds the
/// configured model with its name, so an alias whose name changes is a new
/// runtime.
async fn configured_runtime_hash(
    inventory: &Value,
    provider: NativeProvider,
    native_cli: Option<std::path::PathBuf>,
) -> Result<Sha256> {
    let executable = inventory_entrypoint(inventory)?;
    // An install the profile does not recognize is pinned to what it is; its
    // rows say why it cannot run.
    let entrypoint = pinned_entrypoint(provider, executable.clone()).unwrap_or(executable);
    let digests = tokio::task::spawn_blocking(move || {
        provider.pinned_digests(&RuntimePaths {
            entrypoint: &entrypoint,
            native_cli: native_cli.as_deref(),
        })
    })
    .await
    .map_err(|error| BenchmarkError::new("infrastructure_failure", error.to_string()))?;
    let mut hash = Sha256::new();
    hash.update(b"distill-native-runtime-v1\0");
    for (role, digest) in digests {
        hash.update(role.as_bytes());
        hash.update(b"\0");
        hash.update(digest.as_deref().unwrap_or("unavailable").as_bytes());
        hash.update(b"\0");
    }
    if crate::services::managed_acp_tools::is_managed(provider.harness_id()) {
        if let Some(entry) = managed_lock_entry(provider.harness_id()) {
            hash.update(entry.as_bytes());
        }
    }
    hash.update(provider.policy_revision().as_bytes());
    hash.update(provider.policy_bytes());
    if let Some(adapter) = provider.adapter() {
        hash.update(adapter.as_bytes());
    }
    Ok(hash)
}
/// A managed bridge's own entry in `acp-tools.lock.json` (package, version,
/// native executables and npm lock), canonical. Another bridge's pin bump
/// leaves it as it is.
fn managed_lock_entry(harness_id: &str) -> Option<String> {
    static LOCK: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
        serde_json::from_slice(include_bytes!("../../../../acp-tools.lock.json"))
            .unwrap_or(Value::Null)
    });
    LOCK.get("tools")
        .and_then(|tools| tools.get(harness_id))
        .map(canonical_json)
}
/// The effort levels a bridge row offers that the profile does not refuse.
/// The CLI's "default" names no level, so it is never offered: a model whose
/// only entry is "default" has no effort control here and runs unset.
fn offered_efforts(row: &Value, excluded: &[String]) -> Vec<String> {
    row.get("reasoningEfforts")
        .or_else(|| row.get("efforts"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().or_else(|| v["value"].as_str()))
        .filter(|effort| !super::effort::names_cli_default(Some(*effort)))
        .filter(|effort| !excluded.iter().any(|refused| refused == effort))
        .map(str::to_owned)
        .collect()
}
/// The launcher entrypoint, the bridge lock, the policy and adapter, and the
/// model set. Existing Claude configurations are pinned to exactly this.
async fn claude_inventory_fingerprint(inventory: &Value) -> Result<String> {
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
    hash.update(serde_json::to_vec(&model_identity(inventory))?);
    Ok(hex::encode(hash.finalize()))
}
/// The installed model set. Effort and fast-mode details are learned lazily by
/// the host probe, so they are not part of the runtime identity; the acknowledged
/// selection check guards the actual effort and fast mode of every attempt.
fn model_identity(inventory: &Value) -> Vec<String> {
    let mut ids: Vec<String> = inventory["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            row.get("modelId")
                .or_else(|| row.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    ids.sort();
    ids.dedup();
    ids
}
/// The row of `model_id` in an inventory as `id` and display name, for
/// profiles configured by the policy resource; `None` when it is not listed.
fn model_row_identity(inventory: &Value, model_id: &str) -> Option<String> {
    inventory["models"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|row| {
            let id = row
                .get("modelId")
                .or_else(|| row.get("id"))
                .and_then(Value::as_str)
                .filter(|id| *id == model_id)?;
            Some(format!("{id}\u{1f}{}", row["name"].as_str().unwrap_or(id)))
        })
}
/// The time a turn of `draft` gets from a run that allows `requested` seconds:
/// the run's limit, or a continuation's frozen remaining budget when that is
/// shorter. The case's own `limits.timeout_seconds` is the least a run must
/// allow it, never a stop: a model takes the time it needs.
pub(super) fn effective_timeout_seconds(requested: u32, draft: &BenchmarkDraft) -> u32 {
    requested.min(
        draft
            .entry_state
            .as_ref()
            .map_or(u32::MAX, |entry| entry.remaining_budget_seconds),
    )
}

/// ACP's `auth_required` error code.
const ACP_AUTH_REQUIRED: i64 = -32000;

/// The outcome of a turn that ended with `error` on `model_id`: a provider
/// that refuses the model to this account ([`refuses_model`]) makes the
/// configuration unsupported; anything else as [`terminal_error_outcome`]
/// reads it.
fn terminal_outcome(error: &Value, model_id: &str) -> &'static str {
    if refuses_model(error, model_id) {
        "unsupported"
    } else {
        terminal_error_outcome(error)
    }
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
fn names(text: &str, name: &str) -> bool {
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

fn terminal_error_outcome(error: &Value) -> &'static str {
    match error["kind"]
        .as_str()
        .or_else(|| error.pointer("/data/kind").and_then(Value::as_str))
    {
        Some("budget_timeout") => "budget_timeout",
        Some("cancelled") => "cancelled",
        Some("selection_changed") => "selection_changed",
        Some("execution_violation") => "execution_violation",
        Some("quota_blocked" | "quota_exhausted") => "quota_blocked",
        Some("dispatch_uncertain") => "dispatch_uncertain",
        Some("policy_violation" | "capability_missing") => "unsupported",
        _ => "infrastructure_failure",
    }
}
/// A weighted criterion of a creative rubric, as the brief declares it.
#[derive(Debug, Clone)]
pub(crate) struct RubricCriterion {
    pub id: String,
    pub label: String,
    pub weight: f64,
}

pub(crate) fn rubric_criteria(draft: &BenchmarkDraft) -> Vec<RubricCriterion> {
    draft.environment["rubricCriteria"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry["id"].as_str()?.trim();
            let weight = entry["weight"].as_f64()?;
            (!id.is_empty() && weight > 0.0).then(|| RubricCriterion {
                id: id.to_string(),
                label: entry["label"].as_str().unwrap_or(id).to_string(),
                weight,
            })
        })
        .collect()
}

/// The markup without a Markdown fence on either side; a lone opening fence counts too.
fn unfence_markup(output: &str) -> &str {
    let mut body = output.trim();
    if body.starts_with("```") {
        body = body.split_once('\n').map_or("", |(_, rest)| rest);
    }
    if let Some(rest) = body.trim_end().strip_suffix("```") {
        body = rest;
    }
    body.trim()
}

fn head(body: &str) -> String {
    body.chars().take(200).collect::<String>().to_lowercase()
}

/// The drawing or page in an answer: the answer itself when it starts with
/// markup, else the first `<svg>`…`</svg>` or HTML document anywhere in it.
fn markup_body<'a>(output: &'a str, format: Option<&str>) -> Option<&'a str> {
    let body = unfence_markup(output);
    let start = head(body);
    if start.starts_with("<svg")
        || start.starts_with("<!doctype html")
        || start.starts_with("<html")
        || (format == Some("svg") && start.contains("<svg"))
        || (format == Some("html") && start.contains('<'))
    {
        return Some(body);
    }
    // ASCII lowering keeps byte offsets, and every offset found sits on a '<'.
    let lowered = output.to_ascii_lowercase();
    for (opening, closing) in [
        ("<svg", "</svg>"),
        ("<!doctype html", "</html>"),
        ("<html", "</html>"),
    ] {
        if let Some(from) = lowered.find(opening) {
            if let Some(to) = lowered.rfind(closing).filter(|to| *to > from) {
                return output.get(from..to + closing.len());
            }
        }
    }
    None
}

const JUDGE_RENDERER: &str = "chromium-1024x768-v1";

/// How a rendering is judged: each judge's provider, model, effort and fast
/// mode, the prompt, the renderer and the panel size. Accounts and runtime
/// probes do not change a verdict, so they stay out of the hash that the
/// leaderboard and Nerf compare.
pub(crate) fn judge_protocol_hash(panel: &[Configuration], prompt: &str) -> String {
    let mut judges: Vec<(&str, &str, &str, bool)> = panel
        .iter()
        .map(|judge| {
            (
                judge.provider_id.as_str(),
                judge.model_id.as_str(),
                judge
                    .effort
                    .as_deref()
                    .filter(|effort| !effort.is_empty())
                    .unwrap_or("default"),
                judge.fast_mode.unwrap_or(false),
            )
        })
        .collect();
    judges.sort();
    let identity = json!({"judges": judges, "prompt": prompt, "renderer": JUDGE_RENDERER,
        "samplesPerJudge": 1, "expectedJudges": panel.len()});
    hex::encode(Sha256::digest(identity.to_string().as_bytes()))
}

/// A standalone document that shows a drawing or a page, or nothing when the
/// output is neither.
pub(crate) fn render_document(output: &str, format: Option<&str>) -> Option<String> {
    let body = markup_body(output, format)?;
    let start = head(body);
    if start.starts_with("<svg") || (format == Some("svg") && start.contains("<svg")) {
        return Some(format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{{margin:0;height:100%;display:grid;place-items:center;background:#fff}}svg{{width:100%;height:auto;max-height:100%}}</style></head><body>{body}</body></html>"
        ));
    }
    Some(body.to_string())
}

fn judge_prompt(draft: &BenchmarkDraft, criteria: &[RubricCriterion]) -> String {
    let mut prompt = String::from(
        "You are one judge on a design panel. The attached image is a candidate's rendering of the brief below. Score what you see, not what is described. Reply with JSON only, no prose and no Markdown fence, of the form {\"scores\": {\"<criterion id>\": <0-10>, ...}, \"notes\": \"<two sentences at most>\"}.\n\nBrief:\n",
    );
    prompt.push_str(&draft.prompt);
    prompt.push_str("\n\nRubric:\n");
    prompt.push_str(&draft.evaluator.rubric);
    prompt.push_str("\n\nCriteria (id, label, weight):\n");
    for criterion in criteria {
        prompt.push_str(&format!(
            "- {} ({}), weight {}\n",
            criterion.id, criterion.label, criterion.weight
        ));
    }
    prompt.push_str("\nScore every criterion from 0 to 10.");
    prompt
}

/// Per-criterion shares (0 to 1) and the judge's notes from a reply, or
/// nothing when the reply is not a complete score sheet.
pub(crate) fn parse_judge_reply(
    reply: &str,
    criteria: &[RubricCriterion],
) -> Option<(serde_json::Map<String, Value>, String)> {
    let start = reply.find('{')?;
    let end = reply.rfind('}')?;
    // A reply whose last '}' precedes its first '{' has no object at all.
    let value: Value = serde_json::from_str(reply.get(start..=end)?).ok()?;
    let scores = value.get("scores")?.as_object()?;
    let mut shares = serde_json::Map::new();
    for criterion in criteria {
        let raw = scores.get(&criterion.id)?.as_f64()?;
        if !raw.is_finite() {
            return None;
        }
        shares.insert(criterion.id.clone(), json!((raw / 10.0).clamp(0.0, 1.0)));
    }
    let notes = value["notes"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(500)
        .collect();
    Some((shares, notes))
}

fn weighted_share(shares: &serde_json::Map<String, Value>, criteria: &[RubricCriterion]) -> f64 {
    let total: f64 = criteria.iter().map(|c| c.weight).sum();
    if total <= 0.0 {
        return 0.0;
    }
    let weighted: f64 = criteria
        .iter()
        .map(|c| shares.get(&c.id).and_then(Value::as_f64).unwrap_or(0.0) * c.weight)
        .sum();
    ((weighted / total) * 1000.0).round() / 1000.0
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
        return super::worker::evaluate(draft, output).await;
    }
    let mut evaluation = evaluation::evaluate(&draft.evaluator, output)?;
    // A judged brief answered without any drawing or page leaves the panel
    // nothing to see: the candidate failed it, the evidence is not missing.
    if draft.evaluator.kind == "rubric"
        && !rubric_criteria(draft).is_empty()
        && render_document(output, draft.facets.output_format.as_deref()).is_none()
    {
        evaluation.verdict = "fail".into();
        evaluation.score = Some(0.0);
        evaluation.reason = "No renderable SVG or HTML markup in the answer".into();
    }
    Ok(evaluation)
}

impl BenchmarkService {
    pub async fn run_loop(self: Arc<Self>) {
        if let Err(error) = self.reconcile_judges().await {
            log::warn!(
                "[benchmarks] judge reconciliation failed: {}",
                error.message
            );
        }
        loop {
            if let Err(error) = self.tick().await {
                log::warn!("[benchmarks] runner paused: {}", error.message);
            }
            tokio::select! {_ = self.wake.notified()=>{},_ = tokio::time::sleep(Duration::from_secs(1))=>{}}
        }
    }
    async fn tick(self: &Arc<Self>) -> Result<()> {
        self.recover_interrupted().await?;
        self.bake_closed_windows().await?;
        super::campaigns::tick(self).await?;
        // Attempts and judge panels in flight, each its own task; each settles
        // its own attempt and frees its slot, and the next fill takes the slot
        // up again.
        let mut flights = tokio::task::JoinSet::new();
        // Each attempt and panel starts at most once a tick, so one that goes
        // straight back to the queue waits for the next tick.
        let mut tried = std::collections::HashSet::new();
        // A failed dispatch still lets what already flies land.
        let dispatched = self.fill(&mut flights, &mut tried).await;
        // The tick lasts while anything flies; the next one settles runs left
        // with nothing to do.
        while !flights.is_empty() {
            tokio::select! {
                _ = flights.join_next() => {}
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
            if flights.is_empty() {
                break;
            }
            if let Err(error) = self.fill(&mut flights, &mut tried).await {
                log::warn!("[benchmarks] dispatch paused: {}", error.message);
            }
        }
        dispatched
    }
    /// Bakes every run whose window closed, once nothing of it flies. A
    /// rendering still before its judges keeps the run open until the
    /// verdict, as its generation is paid for; no other cell starts.
    async fn bake_closed_windows(&self) -> Result<()> {
        let at = now();
        for run in self
            .store
            .unbaked_runs(at - super::analysis::RUN_WINDOW_MS)
            .await?
        {
            if self.flying(&run.id).await > 0 {
                continue;
            }
            if run.attempts.iter().any(|a| a.phase == AWAITING_JUDGES) {
                if !matches!(run.state.as_str(), "running" | "pausing" | "cancelling") {
                    self.store.set_run_state(&run.id, "running").await?;
                }
                continue;
            }
            if !matches!(run.state.as_str(), "completed" | "cancelled") {
                self.finish_measurement(&run).await?;
            }
            self.bake(&run, at).await?;
        }
        Ok(())
    }
    async fn recover_interrupted(&self) -> Result<()> {
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
                    // A rendering whose panel a restart cut off keeps its paid
                    // generation and waits for its run's resume, which asks a
                    // fresh panel; anything else settles here.
                    if self.awaits_panel(&restored, &version).await? {
                        restored.phase = AWAITING_JUDGES.into();
                        restored.reason = Some(JUDGING_STOPPED.into());
                    } else {
                        restored.phase = "terminal".into();
                    }
                    self.store.save_attempt(&restored).await?;
                    self.changed().await;
                }
                None => {
                    a.phase = "terminal".into();
                    a.outcome = Some("dispatch_uncertain".into());
                    a.reason=Some("Remote acceptance cannot be established after restart; the run continues with its other tests, and this case starts over when the run resumes".into());
                    a.finished_at = Some(now());
                    self.store.save_attempt(&a).await?;
                    self.changed().await;
                }
            }
        }
        Ok(())
    }
    /// Starts what may run now and settles runs that paused, were cancelled or
    /// have nothing left. Runs take turns, so a newer run never waits behind
    /// an older one.
    async fn fill(
        self: &Arc<Self>,
        flights: &mut tokio::task::JoinSet<()>,
        tried: &mut std::collections::HashSet<String>,
    ) -> Result<()> {
        let mut queues = Vec::new();
        for run in self.store.active_runs().await? {
            let flying = self.flying(&run.id).await;
            if run.state == "pausing" {
                if flying == 0 {
                    self.store.set_run_state(&run.id, "paused").await?;
                    self.changed().await;
                }
                continue;
            }
            if run.state == "cancelling" {
                if flying > 0 {
                    continue;
                }
                for mut a in run.attempts {
                    if a.phase == "pending" {
                        a.phase = "terminal".into();
                        a.outcome = Some("cancelled".into());
                        a.finished_at = Some(now());
                        self.store.save_attempt(&a).await?;
                    } else if a.phase == AWAITING_JUDGES {
                        // The sealed output stands; only its verdict is missing.
                        let mut waiting = self.store.attempt(&a.id).await?;
                        waiting.phase = "terminal".into();
                        waiting.reason = Some(JUDGING_STOPPED.into());
                        self.store.save_attempt(&waiting).await?;
                    }
                }
                self.store.set_run_state(&run.id, "cancelled").await?;
                self.changed().await;
                continue;
            }
            if run.state != "running" {
                continue;
            }
            // A rendering a pause or busy judges held back is judged beside the
            // run's generations; the run completes only once none is waiting.
            let waiting = run
                .attempts
                .iter()
                .find(|a| a.phase == AWAITING_JUDGES)
                .map(|a| a.id.clone());
            if let Some(id) = waiting.clone().filter(|id| !tried.contains(id)) {
                let lane = format!("judges\u{1f}{}", run.id);
                if let Some(cancel) = self.claim(&run.id, &lane, "", false).await {
                    tried.insert(id.clone());
                    let (service, run) = (self.clone(), run.clone());
                    flights.spawn(async move {
                        if let Err(error) = service.resume_judging(&run, &id, cancel).await {
                            log::warn!("[benchmarks] judging stopped: {}", error.message);
                        }
                        service.release(&lane).await;
                        service.changed().await;
                    });
                }
            }
            let ready = self.dispatchable(&run).await?;
            if ready.is_empty() {
                // Cells held for their provider still wait for it; the run
                // completes only once none is pending.
                let held = run.attempts.iter().any(|a| {
                    a.phase == "pending" && provider_held(&run.id, &a.configuration.provider_id)
                });
                if flying == 0 && waiting.is_none() && !held {
                    self.finish_measurement(&run).await?;
                    self.store.set_run_state(&run.id, "completed").await?;
                    self.changed().await;
                }
                continue;
            }
            queues.push((run, ready.into_iter()));
        }
        loop {
            let mut started = false;
            for (run, ready) in &mut queues {
                for (a, version) in ready.by_ref() {
                    if tried.contains(&a.id) {
                        continue;
                    }
                    if self.start(run, a, version, flights, tried).await? {
                        started = true;
                        break;
                    }
                }
            }
            if !started {
                return Ok(());
            }
        }
    }
    /// Attempts and panels of `run_id` in flight.
    async fn flying(&self, run_id: &str) -> usize {
        self.active
            .lock()
            .await
            .values()
            .filter(|flight| flight.run_id == run_id)
            .count()
    }
    /// Takes a slot for `lane` on `account` if one is free: one flight per
    /// lane, [`ACCOUNT_SLOTS`] per account, [`TOTAL_SLOTS`] in all; an
    /// exclusive flight shares its account with nothing. Returns its cancel
    /// signal.
    async fn claim(
        &self,
        run_id: &str,
        lane: &str,
        account: &str,
        exclusive: bool,
    ) -> Option<watch::Receiver<bool>> {
        let mut active = self.active.lock().await;
        let on_account: Vec<&Flight> = active
            .values()
            .filter(|flight| !account.is_empty() && flight.account == account)
            .collect();
        if active.len() >= TOTAL_SLOTS
            || active.contains_key(lane)
            || on_account.len() >= ACCOUNT_SLOTS
            || on_account.iter().any(|flight| flight.exclusive)
            || (exclusive && !on_account.is_empty())
        {
            return None;
        }
        let (cancel, signal) = watch::channel(false);
        active.insert(
            lane.to_owned(),
            Flight {
                run_id: run_id.to_owned(),
                account: account.to_owned(),
                exclusive,
                cancel,
            },
        );
        Some(signal)
    }
    async fn release(&self, lane: &str) {
        self.active.lock().await.remove(lane);
    }
    /// Starts `a` if its configuration, account and the app have a free slot.
    async fn start(
        self: &Arc<Self>,
        run: &BenchmarkRun,
        mut a: Attempt,
        version: BenchmarkVersion,
        flights: &mut tokio::task::JoinSet<()>,
        tried: &mut std::collections::HashSet<String>,
    ) -> Result<bool> {
        // One attempt per configuration at a time keeps its timing and quota
        // its own.
        let lane = super::analysis::configuration_key(&a.configuration);
        let account = format!(
            "{}\u{1f}{}",
            a.configuration.provider_id,
            a.configuration.account_id.as_deref().unwrap_or_default()
        );
        // An account measured around a run must not see anyone else's turns.
        let exclusive = version.manifest.measurement_profile != "task_metrics";
        let Some(cancel_rx) = self.claim(&run.id, &lane, &account, exclusive).await else {
            return Ok(false);
        };
        let ready = async {
            fixtures::verify_blob(&self.store.root, &version.content_hash, &version.manifest)
                .await?;
            Ok::<bool, BenchmarkError>(!exclusive || self.begin_measurement(run).await?)
        }
        .await;
        if !matches!(ready, Ok(true)) {
            self.release(&lane).await;
            return ready;
        }
        // Judges run only where the saved plan reserved their calls; known
        // before the paid turn.
        let judge_budget = self.judge_budget(run, &version).await;
        tried.insert(a.id.clone());
        a.phase = "preparing".into();
        a.started_at = Some(now());
        self.store.save_attempt(&a).await?;
        if self.store.run_state(&run.id).await? != "running" {
            a.phase = "pending".into();
            a.started_at = None;
            self.store.save_attempt(&a).await?;
            self.release(&lane).await;
            return Ok(false);
        }
        // Tell the app the attempt started, so a run's view shows which test
        // runs now and since when, not only which ones finished.
        self.changed().await;
        let (service, run) = (self.clone(), run.clone());
        flights.spawn(async move {
            if let Err(error) = service
                .run_attempt(&run, a, version, judge_budget, cancel_rx)
                .await
            {
                log::warn!("[benchmarks] attempt stopped: {}", error.message);
            }
            service.release(&lane).await;
            service.changed().await;
        });
        Ok(true)
    }
    /// Runs one attempt to its settlement, as the runner always has.
    async fn run_attempt(
        &self,
        run: &BenchmarkRun,
        a: Attempt,
        version: BenchmarkVersion,
        judge_budget: Option<std::result::Result<bool, String>>,
        cancel_rx: watch::Receiver<bool>,
    ) -> Result<()> {
        let result = if version.manifest.workflow.is_some() {
            super::workflow::execute(
                self,
                a.clone(),
                version.clone(),
                run.request.timeout_seconds,
                cancel_rx.clone(),
            )
            .await
        } else {
            self.backend
                .execute(
                    &self.store,
                    a.clone(),
                    version.clone(),
                    run.request.timeout_seconds,
                    cancel_rx.clone(),
                )
                .await
        };
        // The cancel signal stays live through judging.
        let result = match result {
            Ok(completed) => {
                let stop = JudgeStop::run(&run.id, cancel_rx);
                self.settle(completed, &version, judge_budget, stop).await
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(mut completed) => {
                quota_recovered(&run.id, &a.configuration.provider_id);
                completed.phase = self.settled_phase(run, &completed).await?.into();
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
                // A turn the provider never saw keeps its cell: a quota wait
                // holds the run until the reset, a sign-in wait until the
                // Grok CLI renews the sign-in, and a refusal before the
                // prompt (a model the provider would not select, a runtime,
                // sign-in or policy the host would not start) waits for the
                // operator with its reason. The same refusal again after the
                // operator resumed settles the cell instead.
                if returns_to_queue(&error.code, &failed.phase) && !refused_again(&a, &error) {
                    // A limit that ran out mid-run discards the unfinished
                    // turn; the run waits for a reset it can reach, or stops
                    // for the operator with the reason on the test.
                    let plan = (error.code == QUOTA_WAIT).then(|| {
                        quota_plan(&run.id, &a.configuration.provider_id, &error.message, now())
                    });
                    let reason = if plan == Some(QuotaPlan::Stop) {
                        format!("{QUOTA_STOPPED}. {}", error.message)
                    } else {
                        error.message.clone()
                    };
                    if version.manifest.workflow.is_some() {
                        // Its saved steps keep their sessions and usage, and
                        // the root's sums of them stand.
                        failed.phase = "pending".into();
                        failed.started_at = None;
                        failed.reason = Some(reason);
                        failed.wait_until = None;
                    } else {
                        requeue(&mut failed, reason);
                    }
                    let provider = &a.configuration.provider_id;
                    let mut stop = false;
                    match plan {
                        Some(QuotaPlan::WaitUntil(until)) => {
                            hold_provider_until(&run.id, provider, until);
                            failed.wait_until = Some(until);
                        }
                        Some(QuotaPlan::Stop) => stop = true,
                        None if error.code != SIGN_IN_WAIT => stop = true,
                        // A sign-in the Grok CLI renews later already held
                        // its provider's cells in the backend, which knows
                        // when. One that another turn still runs on names no
                        // time: ask again shortly.
                        None => match provider_hold(&run.id, provider) {
                            Some(until) => failed.wait_until = Some(until),
                            None => {
                                hold_provider_until(&run.id, provider, now() + SIGN_IN_RETRY_MS)
                            }
                        },
                    }
                    self.store.save_attempt(&failed).await?;
                    if stop {
                        self.store.set_run_state(&run.id, "needs_attention").await?;
                    }
                    self.changed().await;
                    return Ok(());
                }
                failed.phase = "terminal".into();
                failed.outcome = Some(error.code.clone());
                failed.reason = Some(error.message);
                failed.finished_at = Some(now());
                self.store.save_attempt(&failed).await?;
                if ["dispatch_uncertain", "storage_unavailable"].contains(&error.code.as_str()) {
                    self.store.set_run_state(&run.id, "needs_attention").await?;
                }
            }
        }
        Ok(())
    }
    /// The pending attempts ready to dispatch. A pending cell whose candidate
    /// authored the case settles as excluded here, without any model call. A
    /// cell whose provider is held (see [`hold_provider_until`]) waits, and
    /// nothing starts once the run's window closed.
    async fn dispatchable(&self, run: &BenchmarkRun) -> Result<Vec<(Attempt, BenchmarkVersion)>> {
        let mut ready = Vec::new();
        if now() >= super::analysis::window_closes(run) {
            return Ok(ready);
        }
        let mut versions: std::collections::HashMap<String, BenchmarkVersion> =
            std::collections::HashMap::new();
        for pending in run.attempts.iter().filter(|a| {
            a.phase == "pending" && !provider_held(&run.id, &a.configuration.provider_id)
        }) {
            if !versions.contains_key(&pending.version_id) {
                let version = self.store.version(&pending.version_id).await?;
                versions.insert(pending.version_id.clone(), version);
            }
            let version = &versions[&pending.version_id];
            if !super::routing::authored_by_candidate(&version.manifest, &pending.configuration) {
                ready.push((pending.clone(), version.clone()));
                continue;
            }
            let mut excluded = pending.clone();
            excluded.phase = "terminal".into();
            excluded.outcome = Some("excluded".into());
            excluded.reason = Some("authored by this candidate".into());
            excluded.finished_at = Some(now());
            self.store.save_attempt(&excluded).await?;
            self.changed().await;
        }
        Ok(ready)
    }
    /// Evaluates a finished generation and, for a creative brief, asks the
    /// judge panel. Evaluator and judge failures stay on the attempt.
    async fn settle(
        &self,
        mut completed: Attempt,
        version: &BenchmarkVersion,
        judge_budget: Option<std::result::Result<bool, String>>,
        stop: JudgeStop,
    ) -> Result<Attempt> {
        if completed.outcome.as_deref() != Some("completed") {
            return Ok(completed);
        }
        let evaluation = match evaluate(
            &version.manifest,
            completed.output.as_deref().unwrap_or_default(),
        )
        .await
        {
            Ok(evaluation) => evaluation,
            Err(error) => {
                completed.outcome = Some("evaluation_error".into());
                completed.reason = Some(error.message);
                return Ok(completed);
            }
        };
        let judging =
            version.manifest.evaluator.kind == "rubric" && evaluation.verdict == "pending_review";
        completed.outcome = Some(evaluation.verdict.clone());
        completed.evaluations.push(evaluation);
        if !judging {
            return Ok(completed);
        }
        Ok(self
            .ask_judges(completed, version, judge_budget, stop)
            .await)
    }
    /// Sends a rendering to its judge panel where the saved plan reserved the
    /// calls. Judge failures stay on the attempt.
    async fn ask_judges(
        &self,
        mut attempt: Attempt,
        version: &BenchmarkVersion,
        judge_budget: Option<std::result::Result<bool, String>>,
        stop: JudgeStop,
    ) -> Attempt {
        match judge_budget {
            Some(Ok(true)) => {
                let lock = super::evaluation_lock(&attempt.id);
                let _guard = lock.lock().await;
                let recorded: Vec<String> =
                    attempt.evaluations.iter().map(|e| e.id.clone()).collect();
                match self
                    .backend
                    .judge(&self.store, attempt.clone(), version, stop)
                    .await
                {
                    Ok(judged) => attempt = judged,
                    Err(error) => {
                        // Once the panel saved, the store holds this attempt's verdicts
                        // plus the judges' spend; before that only memory holds them.
                        if let Ok(saved) = self.store.attempt(&attempt.id).await {
                            if recorded
                                .iter()
                                .all(|id| saved.evaluations.iter().any(|e| &e.id == id))
                            {
                                attempt = saved;
                            }
                        }
                        attempt.reason = Some(format!("Judging failed: {}", error.message));
                    }
                }
            }
            Some(Ok(false)) => {
                attempt.reason =
                    Some("Judge calls are not covered by this saved run's execution budget".into());
            }
            Some(Err(message)) => {
                attempt.reason = Some(format!(
                    "Judge reservation could not be verified: {message}"
                ));
            }
            None => {}
        }
        attempt
    }
    /// Whether a run's saved plan reserved judge calls for this case; known
    /// before any paid turn. Old plans may predate the reservation.
    async fn judge_budget(
        &self,
        run: &BenchmarkRun,
        version: &BenchmarkVersion,
    ) -> Option<std::result::Result<bool, String>> {
        if version.manifest.evaluator.kind != "rubric" {
            return None;
        }
        Some(
            self.planned_executions(&run.request)
                .await
                .map(|count| count <= run.request.max_executions as usize && count <= 1000)
                .map_err(|error| error.message),
        )
    }
    /// Asks the panel of one rendering a pause or busy judges held back.
    async fn resume_judging(
        &self,
        run: &BenchmarkRun,
        id: &str,
        cancel_rx: watch::Receiver<bool>,
    ) -> Result<()> {
        let waiting = self.store.attempt(id).await?;
        let version = self.store.version(&waiting.version_id).await?;
        let mut settled = waiting.clone();
        settled.phase = "terminal".into();
        // A plan saved before authored cells were left out may still hold a
        // rendering its candidate wrote; no verdict on it could ever count.
        if super::routing::authored_by_candidate(&version.manifest, &waiting.configuration) {
            settled.outcome = Some("excluded".into());
            settled.reason = Some("authored by this candidate".into());
            self.store.save_attempt(&settled).await?;
            return Ok(());
        }
        // Every vote of the batch landed before the final save: the panel
        // already settled it, and only an explicit evaluation asks again.
        if super::analysis::score(&waiting).is_some() {
            if settled.outcome.as_deref() == Some("pending_review") {
                settled.outcome = Some("judged".into());
            }
            settled.reason = None;
            self.store.save_attempt(&settled).await?;
            return Ok(());
        }
        let judge_budget = self.judge_budget(run, &version).await;
        let mut attempt = waiting.clone();
        attempt.reason = None;
        let stop = JudgeStop::run(&run.id, cancel_rx);
        let mut judged = self.ask_judges(attempt, &version, judge_budget, stop).await;
        judged.phase = self.settled_phase(run, &judged).await?.into();
        // A panel still waiting on busy judges records nothing new.
        if serde_json::to_value(&judged)? != serde_json::to_value(&waiting)? {
            self.store.save_attempt(&judged).await?;
        }
        Ok(())
    }
    /// Whether a recovered attempt is a rendering still owed its panel: a
    /// judged brief, a renderable output with no verdict yet, and a run that
    /// can still resume. Nothing resumes a finished run, so its rendering
    /// settles and stays open to Evaluate again. No judge is asked here.
    async fn awaits_panel(&self, attempt: &Attempt, version: &BenchmarkVersion) -> Result<bool> {
        let manifest = &version.manifest;
        Ok(manifest.evaluator.kind == "rubric"
            && !rubric_criteria(manifest).is_empty()
            && attempt.outcome.as_deref() == Some("pending_review")
            && super::analysis::score(attempt).is_none()
            && render_document(
                attempt.output.as_deref().unwrap_or_default(),
                manifest.facets.output_format.as_deref(),
            )
            .is_some()
            && matches!(
                self.store.run_state(&attempt.run_id).await?.as_str(),
                "running" | "pausing" | "paused" | "needs_attention"
            ))
    }
    /// A panel a pause or busy judges held back waits for its run; anything
    /// else, a cancelled run included, settles the attempt.
    async fn settled_phase(&self, run: &BenchmarkRun, attempt: &Attempt) -> Result<&'static str> {
        Ok(
            if judging_deferred(attempt)
                && !matches!(
                    self.store.run_state(&run.id).await?.as_str(),
                    "cancelling" | "cancelled"
                )
            {
                AWAITING_JUDGES
            } else {
                "terminal"
            },
        )
    }
    /// Judge turns a restart cut off: their placeholders are settled from the
    /// host's records, so the spend is kept and never counts as a vote.
    pub(super) async fn reconcile_judges(&self) -> Result<()> {
        let ids = sqlx::query_scalar::<_, String>(
            "SELECT a.id FROM attempts a WHERE EXISTS(SELECT 1 FROM json_each(a.data_json,'$.evaluations') e
               WHERE json_extract(e.value,'$.details.inFlight')=1)",
        )
        .fetch_all(&self.store.pool)
        .await?;
        for id in ids {
            let lock = super::evaluation_lock(&id);
            let Ok(_guard) = lock.try_lock() else {
                continue;
            };
            let attempt = self.store.attempt(&id).await?;
            let attempt = self.backend.reconcile_judges(&self.store, attempt).await?;
            self.store.save_attempt(&attempt).await?;
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
    /// Judge panels asked, and those that found their run stopped.
    pub judges: std::sync::atomic::AtomicU64,
    pub stopped_judges: std::sync::atomic::AtomicU64,
    /// Tests hold a panel open to act on its run meanwhile.
    pub hold_judges: std::sync::atomic::AtomicBool,
    pub judge_entered: tokio::sync::Notify,
    pub judge_release: tokio::sync::Notify,
    /// Judge accounts report activity, as a native panel sees them.
    pub busy_judges: std::sync::atomic::AtomicBool,
    /// The panel fails before it records anything.
    pub fail_judges: std::sync::atomic::AtomicBool,
    /// Turns the host refuses for quota before any provider call.
    pub quota_waits: std::sync::atomic::AtomicU64,
    /// Sessions whose provider refuses the requested model before dispatch.
    pub refused_selections: std::sync::atomic::AtomicU64,
    /// Sessions the host refuses to open before any provider call (a sign-in
    /// near expiry, a refused preflight).
    pub capability_refusals: std::sync::atomic::AtomicU64,
    /// Turns held back until the Grok CLI renews its sign-in.
    pub sign_in_waits: std::sync::atomic::AtomicU64,
    /// Turns held back while another still runs on the due sign-in.
    pub busy_sign_ins: std::sync::atomic::AtomicU64,
    /// The effort levels every fake model lists: none, so no effort control,
    /// unless a test gives them some.
    pub effort_levels: std::sync::Mutex<Vec<String>>,
    /// Turns in flight now, and the most ever at once.
    pub in_flight: std::sync::atomic::AtomicU64,
    pub peak_in_flight: std::sync::atomic::AtomicU64,
}
impl ExecutionBackend for FakeBackend {
    fn unsupported(&self, _: &Configuration, _: &BenchmarkDraft) -> Option<String> {
        None
    }
    fn judge<'a>(
        &'a self,
        store: &'a Store,
        mut attempt: Attempt,
        _version: &'a BenchmarkVersion,
        stop: JudgeStop,
    ) -> BoxFuture<'a, Result<Attempt>> {
        use std::sync::atomic::Ordering;
        Box::pin(async move {
            self.judges.fetch_add(1, Ordering::SeqCst);
            if self.fail_judges.load(Ordering::SeqCst) {
                return Err(BenchmarkError::new("infrastructure_failure", "host down"));
            }
            if self.hold_judges.load(Ordering::SeqCst) {
                self.judge_entered.notify_one();
                self.judge_release.notified().await;
            }
            if stop.halted(store).await? {
                self.stopped_judges.fetch_add(1, Ordering::SeqCst);
                attempt.reason = Some(JUDGING_STOPPED.into());
            } else if self.busy_judges.load(Ordering::SeqCst) {
                attempt.reason = Some(JUDGES_BUSY.into());
            }
            Ok(attempt)
        })
    }
    fn inventory<'a>(
        &'a self,
        provider: &'a str,
        account: Option<&'a str>,
        _: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(async move {
            // Fake models have no effort control unless a test lists levels,
            // so their measurements are fully specified with the effort unset.
            let efforts = self
                .effort_levels
                .lock()
                .map(|levels| levels.clone())
                .unwrap_or_default();
            Ok(["fake-pass", "fake-fail"]
                .into_iter()
                .map(|id| InventoryModel {
                    configuration: Configuration {
                        id: id.into(),
                        provider_id: provider.into(),
                        account_id: account.map(str::to_owned),
                        model_id: id.into(),
                        effort: None,
                        fast_mode: None,
                        billing_mode: "simulated".into(),
                        execution_profile: "native_text".into(),
                        inventory_revision: Some("fake-v1".into()),
                        model_name: None,
                    },
                    name: id.into(),
                    efforts: efforts.clone(),
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
            use std::sync::atomic::Ordering;
            let take = |counter: &std::sync::atomic::AtomicU64| {
                counter
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                    .is_ok()
            };
            if take(&self.capability_refusals) {
                return Err(BenchmarkError::new(
                    "capability_missing",
                    "the Grok sign-in expires within 15 minutes; open a Grok chat so the Grok CLI refreshes it",
                ));
            }
            if take(&self.sign_in_waits) {
                hold_provider_until(&a.run_id, &a.configuration.provider_id, now() + 60_000);
                return Err(BenchmarkError::new(SIGN_IN_WAIT, SIGN_IN_WAIT_REASON));
            }
            if take(&self.busy_sign_ins) {
                return Err(BenchmarkError::new(
                    SIGN_IN_WAIT,
                    crate::services::provider_rate_limits::grok::BENCHMARK_BRIDGE_BUSY,
                ));
            }
            if take(&self.refused_selections) {
                let mut observed = a.configuration.clone();
                observed.model_id = "default".into();
                a.observed = Some(observed);
                store.save_attempt(&a).await?;
                return Err(BenchmarkError::new(
                    "selection_changed",
                    "Provider did not acknowledge the exact model, effort and fast mode",
                ));
            }
            if take(&self.quota_waits) {
                a.phase = "running".into();
                a.host_run_id = Some(format!("fake-{}", a.id));
                store.save_attempt(&a).await?;
                let error = json!({"code":-32010,"data":{"kind":QUOTA_WAIT,
                    "dispatchStarted":false,"nextReset":now() + 60_000}});
                return Err(BenchmarkError::new(QUOTA_WAIT, error.to_string()));
            }
            self.calls.fetch_add(1, Ordering::SeqCst);
            let flying = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak_in_flight.fetch_max(flying, Ordering::SeqCst);
            a.phase = "running".into();
            a.host_run_id = Some(format!("fake-{}", a.id));
            a.observed = Some(a.configuration.clone());
            store.save_attempt(&a).await?;
            tokio::select! {_=tokio::time::sleep(Duration::from_millis(300))=>{},_=cancel.changed()=>{}}
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
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
    #[test]
    fn judge_replies_become_weighted_shares_and_unfenced_markup_renders() {
        let criteria = vec![
            super::RubricCriterion {
                id: "adherence".into(),
                label: "Adherence".into(),
                weight: 50.0,
            },
            super::RubricCriterion {
                id: "craft".into(),
                label: "Craft".into(),
                weight: 50.0,
            },
        ];
        let (shares, notes) = super::parse_judge_reply(
            "Sure. {\"scores\": {\"adherence\": 8, \"craft\": 6}, \"notes\": \"Tower present.\"}",
            &criteria,
        )
        .unwrap();
        assert_eq!(shares["adherence"], serde_json::json!(0.8));
        assert_eq!(notes, "Tower present.");
        assert_eq!(super::weighted_share(&shares, &criteria), 0.7);
        // A sheet missing a criterion is no verdict at all.
        assert!(super::parse_judge_reply("{\"scores\": {\"craft\": 6}}", &criteria).is_none());
        // A closing brace before the first opening one is no sheet, never a panic.
        for reply in ["Scores} {\"scores\": {\"craft\": 7", ":} {", "}{"] {
            assert!(super::parse_judge_reply(reply, &criteria).is_none());
        }
        let document = super::render_document("```svg\n<svg xmlns='x'/>", Some("svg")).unwrap();
        assert!(document.contains("<body><svg xmlns='x'/></body>"));
        assert!(super::render_document("42", Some("text")).is_none());
        // A drawing after a long preamble is still the drawing.
        let preamble = format!(
            "{} Here it is:\n<svg xmlns='x'><rect/></svg>\nEnjoy.",
            "Prose. ".repeat(40)
        );
        let document = super::render_document(&preamble, Some("svg")).unwrap();
        assert!(document.contains("<body><svg xmlns='x'><rect/></svg></body>"));
        assert!(super::render_document("I cannot draw.", Some("svg")).is_none());
    }
    fn judge_row(model: &str) -> Configuration {
        Configuration {
            id: format!("claude-acp:account:{model}"),
            provider_id: "claude-acp".into(),
            account_id: Some("account".into()),
            model_id: model.into(),
            effort: None,
            fast_mode: None,
            billing_mode: "subscription".into(),
            execution_profile: "native_text".into(),
            inventory_revision: Some("runtime".into()),
            model_name: None,
        }
    }
    #[test]
    fn a_runtime_probe_or_account_never_changes_the_judge_protocol() {
        let panel = vec![judge_row("sonnet"), judge_row("haiku")];
        let hash = judge_protocol_hash(&panel, "prompt");
        let mut probed = panel.clone();
        probed[0].inventory_revision = Some("re-probed".into());
        probed[1].account_id = Some("other-account".into());
        probed[1].id = "relabelled".into();
        probed.reverse();
        assert_eq!(judge_protocol_hash(&probed, "prompt"), hash);
        let mut replaced = panel.clone();
        replaced[1].model_id = "opus".into();
        assert_ne!(judge_protocol_hash(&replaced, "prompt"), hash);
        assert_ne!(judge_protocol_hash(&panel[..1], "prompt"), hash);
        assert_ne!(judge_protocol_hash(&panel, "another prompt"), hash);
    }
    #[test]
    fn judge_panels_skip_the_candidate_its_alias_and_the_cases_authors() {
        let offered = || {
            [
                "default",
                "opus[1m]",
                "claude-fable-5-1[1m]",
                "sonnet",
                "haiku",
            ]
            .map(judge_row)
            .to_vec()
        };
        let ids =
            |panel: &[Configuration]| panel.iter().map(|c| c.model_id.clone()).collect::<Vec<_>>();
        let mut draft = creative();
        draft.environment["authoredBy"] = json!([]);
        // Any model but the candidate may judge a case nobody here wrote, and
        // the alias never takes its target's seat.
        let panel = select_judges(&[&judge_row("sonnet")], &draft, offered());
        assert_eq!(ids(&panel), ["opus[1m]", "claude-fable-5-1[1m]", "haiku"]);
        assert!(panel_issue(&panel).is_none());
        // The default alias is Opus, so Opus never judges it.
        let panel = select_judges(&[&judge_row("default")], &draft, offered());
        assert_eq!(ids(&panel), ["claude-fable-5-1[1m]", "sonnet", "haiku"]);
        // An author of the case never judges it; one judge cannot settle anything.
        draft.environment["authoredBy"] = json!(["haiku", "fable"]);
        let panel = select_judges(&[&judge_row("opus[1m]")], &draft, offered());
        assert_eq!(ids(&panel), ["sonnet"]);
        assert!(panel_issue(&panel).is_some());
        // An author never judges through its alias either.
        draft.environment["authoredBy"] = json!(["opus"]);
        let panel = select_judges(&[&judge_row("sonnet")], &draft, offered());
        assert_eq!(ids(&panel), ["claude-fable-5-1[1m]", "haiku"]);
        // A candidate alias with an unknown target admits no judge.
        let mut moving = judge_row("current");
        moving.provider_id = "other-provider".into();
        assert!(select_judges(&[&moving], &draft, offered()).is_empty());
        // The seeded tasks were written by Fable, so as their author it never judges them.
        let seeded = creative();
        for candidate in ["opus[1m]", "sonnet", "haiku", "claude-fable-5-1[1m]"] {
            let panel = select_judges(&[&judge_row(candidate)], &seeded, offered());
            assert!(!panel.iter().any(|j| j.model_id.contains("fable")));
            assert!(!panel.iter().any(|j| j.model_id == candidate));
        }
    }
    #[test]
    fn flagged_or_substituted_judge_turns_abstain() {
        let judge = judge_row("sonnet");
        let status = |result: Option<Value>, error: Option<Value>| ExecutionDispatch {
            request_key: "key".into(),
            session_id: "session".into(),
            run_id: "run".into(),
            user_message_id: "message".into(),
            phase: "terminal".into(),
            event_cursor: 4,
            result,
            error,
        };
        let acknowledged =
            |model: &str| Some(json!({"observedSelection": {"modelId": model, "fastMode": false}}));
        assert!(judge_turn_failure(&judge, &status(acknowledged("sonnet"), None)).is_none());
        let violated = status(
            None,
            Some(json!({"kind": "execution_violation",
                "message": "execution_violation: native execution violated the declared no-tool policy"})),
        );
        assert!(judge_turn_failure(&judge, &violated)
            .unwrap()
            .contains("no-tool policy"));
        assert!(judge_turn_failure(&judge, &status(acknowledged("opus[1m]"), None)).is_some());
        assert!(judge_turn_failure(&judge, &status(Some(json!({})), None)).is_some());
    }
    #[test]
    fn interrupted_judge_usage_is_kept_only_when_recovered() {
        let mut evaluation = Evaluation {
            id: "judge".into(),
            evaluator_revision: "1".into(),
            verdict: "abstained".into(),
            score: None,
            reason: "Judge turn in flight".into(),
            created_at: 1,
            provenance: "judge_failure".into(),
            artifacts: Vec::new(),
            details: Some(
                json!({"sessionId": "s", "requestKey": "k", "usageComplete": false, "inFlight": true}),
            ),
            judge: Some(judge_row("sonnet")),
            usage: None,
        };
        let mut recovered = evaluation.clone();
        settle_interrupted_judge(
            &mut recovered,
            Some(TokenUsage {
                output: Some(40),
                cost: Some(0.02),
                ..Default::default()
            }),
        );
        assert_eq!(recovered.details.as_ref().unwrap()["usageComplete"], true);
        assert_eq!(recovered.usage.as_ref().unwrap().cost, Some(0.02));
        settle_interrupted_judge(&mut evaluation, None);
        assert!(!in_flight(&evaluation));
        assert_eq!(evaluation.details.as_ref().unwrap()["usageComplete"], false);
        assert!(evaluation.score.is_none());
    }
    use super::*;
    use std::sync::atomic::Ordering;
    use tokio::sync::Notify;
    async fn setup() -> (tempfile::TempDir, Arc<BenchmarkService>, Arc<FakeBackend>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        let backend = Arc::new(FakeBackend::default());
        let service = Arc::new(BenchmarkService {
            store,
            backend: backend.clone(),
            wake: Notify::new(),
            active: Default::default(),
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
                model_name: None,
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
        second.effort = Some("high".into());
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
        // The plan check names the cases in the order the run dispatches them.
        let mut seen = std::collections::HashSet::new();
        let cases: Vec<String> = first
            .iter()
            .filter(|(version, _, _)| seen.insert(version.clone()))
            .map(|(version, _, _)| version.clone())
            .collect();
        assert_eq!(
            service.preview_run(&req).await.unwrap().execution_order,
            cases
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
    fn a_turn_gets_the_run_limit_or_a_shorter_frozen_budget() {
        let mut draft = seed_definitions().remove(0);
        // The case's own limit is the least a run must allow, not a stop.
        draft.limits.timeout_seconds = 120;
        assert_eq!(effective_timeout_seconds(14_400, &draft), 14_400);
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
        assert_eq!(effective_timeout_seconds(90, &draft), 30);
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
        // One lost test never retires the rest: the run resumes, the
        // uncertain repetition is superseded and measured anew as its own
        // attempt, never under the lost key.
        s.control(&run.id, "resume").await.unwrap();
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let resumed = s.store.run(&run.id).await.unwrap();
        assert_eq!(resumed.attempts[0].outcome.as_deref(), Some("superseded"));
        assert_eq!(resumed.attempts.len(), 3);
        assert!(resumed.attempts[1..]
            .iter()
            .all(|a| a.phase == "terminal" && super::super::analysis::score(a).is_some()));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    }
    /// A second case for a run, published from the next seed.
    async fn second_case(s: &BenchmarkService) -> String {
        let d = s
            .store
            .save_draft(None, None, seed_definitions().remove(1))
            .await
            .unwrap();
        s.store.publish(&d.id, 1).await.unwrap().id
    }
    fn settle(attempt: &Attempt, outcome: &str) -> Attempt {
        let mut done = attempt.clone();
        done.phase = "terminal".into();
        done.outcome = Some(outcome.into());
        done.started_at = Some(1);
        done.finished_at = Some(now());
        done
    }
    /// A run resumed inside its window measures an unfinished case from the
    /// start: a repetition scored before the stop is superseded and planned
    /// anew beside the rest, so the cell is measured in one sitting. A case
    /// complete when the run stopped, passed or failed, stands.
    #[tokio::test]
    async fn a_resumed_run_starts_its_unfinished_cases_over() {
        let (_dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        let first = req.version_ids[0].clone();
        let second = second_case(&s).await;
        req.version_ids.push(second.clone());
        req.repetitions = 3;
        req.max_executions = 6;
        let run = s.start_run(req).await.unwrap();
        // The first case failed all three repetitions; the second was measured once.
        for attempt in &run.attempts {
            if attempt.version_id == first {
                s.store
                    .save_attempt(&settle(attempt, "fail"))
                    .await
                    .unwrap();
            } else if attempt.repetition == 0 {
                s.store
                    .save_attempt(&settle(attempt, "pass"))
                    .await
                    .unwrap();
            }
        }
        s.store
            .set_run_state(&run.id, "needs_attention")
            .await
            .unwrap();
        s.control(&run.id, "resume").await.unwrap();
        let resumed = s.store.run(&run.id).await.unwrap();
        let of = |run: &BenchmarkRun, version: &str| -> Vec<Attempt> {
            run.attempts
                .iter()
                .filter(|a| a.version_id == version)
                .cloned()
                .collect()
        };
        // The failed cell is a result, not a gap: nothing of it is planned again.
        assert!(of(&resumed, &first)
            .iter()
            .all(|a| a.outcome.as_deref() == Some("fail")));
        // The unfinished cell starts over: its scored repetition is superseded
        // and all three repetitions are queued.
        let unfinished = of(&resumed, &second);
        assert_eq!(unfinished.len(), 4);
        assert_eq!(
            unfinished
                .iter()
                .filter(|a| a.outcome.as_deref() == Some("superseded"))
                .count(),
            1
        );
        let mut queued: Vec<u32> = unfinished
            .iter()
            .filter(|a| a.phase == "pending")
            .map(|a| a.repetition)
            .collect();
        queued.sort_unstable();
        assert_eq!(queued, vec![0, 1, 2]);
        for _ in 0..4 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 3);
        assert_eq!(
            of(&done, &second)
                .iter()
                .filter(|a| super::super::analysis::score(a).is_some())
                .count(),
            3
        );
    }
    #[tokio::test]
    async fn confirmed_remeasurement_seals_the_previous_sitting_atomically() {
        let (_dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        req.repetitions = 3;
        req.max_executions = 3;
        let old = s.start_run(req.clone()).await.unwrap();
        for attempt in &old.attempts {
            let mut failed = settle(attempt, "fail");
            failed.output = Some("Original failed answer".into());
            s.store.save_attempt(&failed).await.unwrap();
        }
        s.store.set_run_state(&old.id, "completed").await.unwrap();
        let before = s.store.run(&old.id).await.unwrap();
        req.request_key = "measure-again".into();
        let mut invalid = req.clone();
        invalid.max_executions = 0;
        assert!(s.start_run_replacing(invalid, Some(&old.id)).await.is_err());
        assert!(s.store.run(&old.id).await.unwrap().baked_at.is_none());
        // A failure while sealing rolls back the newly admitted plan too.
        sqlx::query("CREATE TRIGGER refuse_seal BEFORE UPDATE OF baked_at ON run_plans BEGIN SELECT RAISE(ABORT, 'test: seal failed'); END")
            .execute(&s.store.pool).await.unwrap();
        assert!(s
            .start_run_replacing(req.clone(), Some(&old.id))
            .await
            .is_err());
        assert_eq!(s.store.runs().await.unwrap().len(), 1);
        assert!(s.store.run(&old.id).await.unwrap().baked_at.is_none());
        sqlx::query("DROP TRIGGER refuse_seal")
            .execute(&s.store.pool)
            .await
            .unwrap();
        let new = s
            .start_run_replacing(req.clone(), Some(&old.id))
            .await
            .unwrap();
        let sealed = s.store.run(&old.id).await.unwrap();
        assert!(sealed.baked_at.is_some());
        assert_eq!(sealed.updated_at, before.updated_at);
        assert_eq!(sealed.attempts.len(), 3);
        assert!(sealed
            .attempts
            .iter()
            .all(|a| a.outcome.as_deref() == Some("fail")));
        assert!(s.control(&old.id, "resume").await.is_err());
        assert!(s.extend_run(&old.id, &[]).await.is_err());
        assert_ne!(new.id, old.id);
        assert_eq!(new.attempts.len(), 3);
        assert!(new.attempts.iter().all(|a| a.phase == "pending"));
        // Retrying an acknowledged request neither creates nor seals anything again.
        assert_eq!(
            s.start_run_replacing(req, Some(&old.id)).await.unwrap().id,
            new.id
        );
        assert_eq!(
            s.store.run(&old.id).await.unwrap().baked_at,
            sealed.baked_at
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        let history = super::super::analysis::history(
            &s.query_data().await.unwrap(),
            &before.request.configurations[0],
        );
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].run_id, old.id);
    }
    #[tokio::test]
    async fn sealing_and_restarting_preserve_superseded_evidence() {
        let (_dir, s, _) = setup().await;
        let mut req = request(&s).await;
        req.repetitions = 3;
        req.max_executions = 3;
        let run = s.start_run(req).await.unwrap();
        let mut original = settle(&run.attempts[0], "pass");
        original.output = Some("Paid original answer".into());
        original.usage.cost = Some(0.25);
        s.store.save_attempt(&original).await.unwrap();
        s.store.set_run_state(&run.id, "paused").await.unwrap();
        s.control(&run.id, "resume").await.unwrap();
        let archived = s.store.attempt(&original.id).await.unwrap();
        assert_eq!(archived.outcome.as_deref(), Some("superseded"));
        assert_eq!(archived.output, original.output);
        assert_eq!(archived.usage.cost, original.usage.cost);
        let resumed = s.store.run(&run.id).await.unwrap();
        let mut partial = settle(
            resumed
                .attempts
                .iter()
                .find(|a| a.phase == "pending")
                .unwrap(),
            "fail",
        );
        partial.output = Some("Second paid answer".into());
        partial.usage.cost = Some(0.5);
        s.store.save_attempt(&partial).await.unwrap();
        s.bake(&s.store.run(&run.id).await.unwrap(), now())
            .await
            .unwrap();
        let archived = s.store.attempt(&partial.id).await.unwrap();
        assert_eq!(archived.outcome.as_deref(), Some("superseded"));
        assert_eq!(archived.output, partial.output);
        assert_eq!(archived.usage.cost, partial.usage.cost);
    }
    /// A test added to a run inside its window joins that run: the sitting
    /// grows and goes on, no second run starts beside it, and what the run
    /// had measured stands.
    #[tokio::test]
    async fn a_run_inside_its_window_grows_by_the_tests_added_to_it() {
        let (_dir, s, backend) = setup().await;
        let req = request(&s).await;
        let first = req.version_ids[0].clone();
        let run = s.start_run(req).await.unwrap();
        for attempt in &run.attempts {
            s.store
                .save_attempt(&settle(attempt, "pass"))
                .await
                .unwrap();
        }
        s.store.set_run_state(&run.id, "completed").await.unwrap();
        // Complete on every test it planned, the run has nothing to resume.
        let refused = s.control(&run.id, "resume").await.unwrap_err();
        assert_eq!(refused.code, "validation");
        let second = second_case(&s).await;
        let grown = s
            .extend_run(&run.id, std::slice::from_ref(&second))
            .await
            .unwrap();
        assert_eq!(grown.state, "running");
        assert_eq!(
            grown.request.version_ids,
            vec![first.clone(), second.clone()]
        );
        assert_eq!(grown.attempts.len(), 4);
        assert!(grown
            .attempts
            .iter()
            .filter(|a| a.version_id == second)
            .all(|a| a.phase == "pending"));
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        assert!(done
            .attempts
            .iter()
            .filter(|a| a.version_id == first)
            .all(|a| a.outcome.as_deref() == Some("pass")));
        assert_eq!(
            done.attempts
                .iter()
                .filter(|a| a.version_id == second && super::super::analysis::score(a).is_some())
                .count(),
            2
        );
        // The same test again adds nothing and the run is complete.
        let again = s.extend_run(&run.id, &[second]).await.unwrap_err();
        assert_eq!(again.message, "Every case of this run is complete");
        assert_eq!(s.store.run(&run.id).await.unwrap().attempts.len(), 4);
    }
    /// Once a run's window closed it is final: nothing resumes it, and the
    /// runner bakes it, keeping the cells measured whole and dropping the
    /// rest, so a case half measured never reads as measured at all.
    #[tokio::test]
    async fn a_run_past_its_window_is_baked() {
        let (_dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        let first = req.version_ids[0].clone();
        let second = second_case(&s).await;
        req.version_ids.push(second.clone());
        req.repetitions = 3;
        req.max_executions = 6;
        let run = s.start_run(req).await.unwrap();
        // The first case is complete; the second holds one of three.
        for attempt in &run.attempts {
            if attempt.version_id == first || attempt.repetition == 0 {
                s.store
                    .save_attempt(&settle(attempt, "pass"))
                    .await
                    .unwrap();
            }
        }
        s.store
            .set_run_state(&run.id, "needs_attention")
            .await
            .unwrap();
        sqlx::query("UPDATE run_plans SET created_at=? WHERE id=?")
            .bind(now() - super::super::analysis::RUN_WINDOW_MS - 60_000)
            .bind(&run.id)
            .execute(&s.store.pool)
            .await
            .unwrap();
        let refused = s.control(&run.id, "resume").await.unwrap_err();
        assert_eq!(refused.code, "validation");
        assert!(
            refused.message.contains("window closed"),
            "{}",
            refused.message
        );
        let grown = s.extend_run(&run.id, &[]).await.unwrap_err();
        assert!(grown.message.contains("window closed"), "{}", grown.message);
        s.tick().await.unwrap();
        let baked = s.store.run(&run.id).await.unwrap();
        assert!(baked.baked_at.is_some());
        assert_eq!(baked.state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
        for attempt in &baked.attempts {
            let expected = if attempt.version_id == first {
                "pass"
            } else {
                "superseded"
            };
            assert_eq!(attempt.outcome.as_deref(), Some(expected), "{}", attempt.id);
            assert_eq!(attempt.phase, "terminal");
        }
        // The ledger holds the complete case alone.
        let data = s.query_data().await.unwrap();
        let report = super::super::analysis::leaderboard(&data, &ResultQuery::default());
        assert_eq!(report.rows.len(), 1);
        assert_eq!(report.rows[0].scored, 1);
        assert_eq!(report.rows[0].complete, 1);
        assert_eq!(report.rows[0].planned, 2);
        // Baked once: the next tick leaves it alone.
        s.tick().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().baked_at, baked.baked_at);
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
        // Cancelled once the turn reached the provider.
        while backend.in_flight.load(Ordering::SeqCst) == 0 {
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
    /// Five efforts of both fake models on each of two accounts, two turns
    /// each: 20 configurations, 40 turns.
    async fn wide_request(s: &BenchmarkService, backend: &FakeBackend) -> RunRequest {
        let efforts = ["low", "medium", "high", "xhigh", "max"];
        *backend.effort_levels.lock().unwrap() = efforts.map(String::from).to_vec();
        let mut req = request(s).await;
        let base = req.configurations.remove(0);
        for account in ["one", "two"] {
            for model in ["fake-pass", "fake-fail"] {
                for effort in efforts {
                    let mut c = base.clone();
                    c.id = format!("{account}-{model}-{effort}");
                    c.account_id = Some(account.into());
                    c.model_id = model.into();
                    c.effort = Some(effort.into());
                    req.configurations.push(c);
                }
            }
        }
        req.max_executions = 40;
        req
    }
    #[tokio::test]
    async fn a_run_flies_its_configurations_side_by_side_within_account_slots() {
        let (_dir, s, backend) = setup().await;
        let run = s.start_run(wide_request(&s, &backend).await).await.unwrap();
        for _ in 0..4 {
            s.tick().await.unwrap();
        }
        let run = s.store.run(&run.id).await.unwrap();
        assert_eq!(run.state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 40);
        assert_eq!(
            backend.peak_in_flight.load(Ordering::SeqCst),
            2 * ACCOUNT_SLOTS as u64
        );
        // A configuration's own turns never overlap.
        for a in &run.attempts {
            for b in &run.attempts {
                if a.id != b.id && a.configuration.id == b.configuration.id {
                    assert!(a.finished_at <= b.started_at || b.finished_at <= a.started_at);
                }
            }
        }
    }
    #[tokio::test]
    async fn cancel_stops_every_turn_in_flight() {
        let (_dir, s, backend) = setup().await;
        let run = s.start_run(wide_request(&s, &backend).await).await.unwrap();
        let background = s.clone();
        let tick = tokio::spawn(async move { background.tick().await });
        while backend.in_flight.load(Ordering::SeqCst) < 2 * ACCOUNT_SLOTS as u64 {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        s.control(&run.id, "cancel").await.unwrap();
        tick.await.unwrap().unwrap();
        s.tick().await.unwrap();
        let run = s.store.run(&run.id).await.unwrap();
        assert_eq!(run.state, "cancelled");
        assert_eq!(
            backend.calls.load(Ordering::SeqCst),
            2 * ACCOUNT_SLOTS as u64
        );
        assert!(run
            .attempts
            .iter()
            .all(|a| a.phase == "terminal" && a.outcome.as_deref() == Some("cancelled")));
    }
    #[test]
    fn a_provider_usage_limit_before_any_answer_waits_for_quota() {
        let limit = json!({"code":-32000,"data":{"accountId":"cli-login-kimi-acp",
            "dispatchStarted":true,"promptNotAccepted":false},
            "message":"Authentication required: 403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends."});
        let empty = TokenUsage::default();
        assert!(refused_for_quota(&limit, "", &empty));
        // An answer already under way was measured; it settles as it ended.
        assert!(!refused_for_quota(&limit, "partial", &empty));
        let answered = TokenUsage {
            output: Some(12),
            ..Default::default()
        };
        assert!(!refused_for_quota(&limit, "", &answered));
        // A model the plan leaves out is no quota.
        let refused = json!({"code":-32000,"message":"Authentication required: 401 Your current subscription does not have access to kimi-for-coding-highspeed."});
        assert!(!refused_for_quota(&refused, "", &empty));
    }
    #[tokio::test]
    async fn a_baseline_leaves_out_cells_settled_as_excluded() {
        let (_dir, s, _) = setup().await;
        let run = s.start_run(request(&s).await).await.unwrap();
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let mut excluded = s.store.run(&run.id).await.unwrap().attempts[0].clone();
        excluded.outcome = Some("excluded".into());
        excluded.evaluations.clear();
        s.store.save_attempt(&excluded).await.unwrap();
        let b = s
            .create_baseline("With an authored cell".into(), vec![run.id.clone()], 0.1)
            .await
            .unwrap();
        assert!(b.snapshots.iter().all(|a| a.id != excluded.id));
    }
    #[tokio::test]
    async fn a_quota_wait_keeps_the_cell_and_holds_the_run_until_the_reset() {
        let (_dir, s, fake) = setup().await;
        fake.quota_waits.store(1, Ordering::SeqCst);
        let run = s.start_run(request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let held = s.store.run(&run.id).await.unwrap();
        assert_eq!(held.state, "running");
        assert!(held.attempts.iter().all(|a| a.phase == "pending"));
        assert!(held.attempts.iter().all(|a| a.host_run_id.is_none()));
        // Nothing is sent before the reset.
        s.tick().await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        PROVIDER_HOLDS
            .lock()
            .unwrap()
            .retain(|(held, _), _| held != &run.id);
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert!(done
            .attempts
            .iter()
            .all(|a| a.phase == "terminal" && a.outcome.as_deref() != Some(QUOTA_WAIT)));
    }
    #[tokio::test]
    async fn a_selection_refused_before_dispatch_keeps_the_cell_for_the_operator() {
        let (_dir, s, fake) = setup().await;
        fake.refused_selections.store(1, Ordering::SeqCst);
        let run = s.start_run(request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let stopped = s.store.run(&run.id).await.unwrap();
        assert_eq!(stopped.state, "needs_attention");
        assert!(stopped
            .attempts
            .iter()
            .all(|a| a.phase == "pending" && a.observed.is_none()));
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
    }
    /// A sign-in near expiry, a refused preflight or a missing runtime stops
    /// the session before any provider call. The cell keeps its place and
    /// the reason, and the run waits for the operator instead of settling
    /// every remaining cell within seconds.
    #[tokio::test]
    async fn a_refusal_before_the_session_keeps_the_cell_for_the_operator() {
        let (_dir, s, fake) = setup().await;
        fake.capability_refusals.store(1, Ordering::SeqCst);
        let run = s.start_run(request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let stopped = s.store.run(&run.id).await.unwrap();
        assert_eq!(stopped.state, "needs_attention");
        assert!(stopped
            .attempts
            .iter()
            .all(|a| a.phase == "pending" && a.outcome.is_none() && a.started_at.is_none()));
        assert!(stopped.attempts.iter().any(|a| a
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Grok sign-in expires"))));
        // Nothing more is tried until the operator resumes.
        s.tick().await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        s.store.set_run_state(&run.id, "running").await.unwrap();
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert!(done
            .attempts
            .iter()
            .all(|a| a.phase == "terminal" && a.outcome.as_deref() != Some("capability_missing")));
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    }
    /// A refusal that lasts as long as the run (a model list never cached, a
    /// profile changed since its probe) would refuse the same cell on every
    /// resume. Refused again for the same reason after the operator resumed,
    /// the cell settles with it, and the run goes on with its other cells.
    #[tokio::test]
    async fn a_refusal_repeated_after_a_resume_settles_its_cell() {
        let (_dir, s, fake) = setup().await;
        fake.capability_refusals.store(2, Ordering::SeqCst);
        let run = s.start_run(request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "needs_attention");
        s.store.set_run_state(&run.id, "running").await.unwrap();
        for _ in 0..5 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert!(done.attempts.iter().all(|a| a.phase == "terminal"));
        let settled: Vec<&Attempt> = done
            .attempts
            .iter()
            .filter(|a| a.outcome.as_deref() == Some("capability_missing"))
            .collect();
        assert_eq!(settled.len(), 1);
        assert!(settled[0]
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Grok sign-in expires")));
        // The other cell ran; the settled one never reached the provider.
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn only_the_same_refusal_after_a_resume_settles_a_cell() {
        let (_dir, s, _) = setup().await;
        let run = s.start_run(request(&s).await).await.unwrap();
        let mut attempt = s.store.run(&run.id).await.unwrap().attempts.remove(0);
        attempt.reason = Some("the Codex model list is not cached".into());
        let again = BenchmarkError::new("capability_missing", "the Codex model list is not cached");
        assert!(refused_again(&attempt, &again));
        let other = BenchmarkError::new("capability_missing", "the Grok sign-in expires soon");
        assert!(!refused_again(&attempt, &other));
        attempt.reason = None;
        assert!(!refused_again(&attempt, &again));
        attempt.reason = Some("held".into());
        assert!(!refused_again(
            &attempt,
            &BenchmarkError::new(QUOTA_WAIT, "held")
        ));
        attempt.reason = Some(SIGN_IN_WAIT_REASON.into());
        assert!(!refused_again(
            &attempt,
            &BenchmarkError::new(SIGN_IN_WAIT, SIGN_IN_WAIT_REASON)
        ));
    }
    /// A Grok sign-in the CLI renews only later holds the provider's cells
    /// until then, without the operator, however often it comes up; the run
    /// then goes on with every cell.
    #[tokio::test]
    async fn a_sign_in_the_cli_renews_later_holds_the_run_on_its_own() {
        let (_dir, s, fake) = setup().await;
        fake.sign_in_waits.store(2, Ordering::SeqCst);
        let run = s.start_run(request(&s).await).await.unwrap();
        let release = || {
            PROVIDER_HOLDS
                .lock()
                .unwrap()
                .remove(&(run.id.clone(), "fake".to_owned()))
        };
        s.tick().await.unwrap();
        let held = s.store.run(&run.id).await.unwrap();
        assert_eq!(held.state, "running");
        assert!(held
            .attempts
            .iter()
            .all(|a| a.phase == "pending" && a.outcome.is_none()));
        // The returned test says when the run tries it again.
        assert!(held.attempts.iter().any(|a| {
            a.reason.as_deref() == Some(SIGN_IN_WAIT_REASON)
                && a.wait_until.is_some_and(|until| until > now())
        }));
        // Nothing is sent while it waits, and the run does not complete.
        s.tick().await.unwrap();
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "running");
        // The same wait again settles nothing and asks nobody.
        assert!(release().is_some());
        s.tick().await.unwrap();
        let again = s.store.run(&run.id).await.unwrap();
        assert_eq!(again.state, "running");
        assert!(again.attempts.iter().all(|a| a.phase == "pending"));
        assert!(release().is_some());
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert!(done
            .attempts
            .iter()
            .all(|a| a.phase == "terminal" && a.outcome.as_deref() == Some("pass")));
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    }
    /// A Grok turn that finds another still running on the due sign-in goes
    /// back to the queue without the operator and without a time to show,
    /// and is asked again shortly.
    #[tokio::test]
    async fn a_turn_waits_for_another_on_the_due_sign_in() {
        let (_dir, s, fake) = setup().await;
        fake.busy_sign_ins.store(1, Ordering::SeqCst);
        let run = s.start_run(request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let held = s.store.run(&run.id).await.unwrap();
        assert_eq!(held.state, "running");
        let waiting = held
            .attempts
            .iter()
            .find(|a| a.reason.is_some())
            .expect("a returned test");
        assert_eq!(waiting.phase, "pending");
        assert_eq!(
            waiting.reason.as_deref(),
            Some(crate::services::provider_rate_limits::grok::BENCHMARK_BRIDGE_BUSY)
        );
        assert_eq!(waiting.wait_until, None);
        let until = provider_hold(&run.id, "fake").expect("a short hold");
        assert!(until <= now() + SIGN_IN_RETRY_MS);
        PROVIDER_HOLDS
            .lock()
            .unwrap()
            .remove(&(run.id.clone(), "fake".to_owned()));
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert!(done
            .attempts
            .iter()
            .all(|a| a.outcome.as_deref() == Some("pass")));
    }
    /// Run 607f8612 mixed Grok and Kimi: a Grok sign-in wait holds the Grok
    /// cells alone. The other provider's cells run meanwhile, and the run
    /// does not complete while a held cell is pending.
    #[tokio::test]
    async fn a_sign_in_wait_holds_only_that_providers_cells() {
        let (_dir, s, fake) = setup().await;
        let mut req = request(&s).await;
        let mut grok = req.configurations[0].clone();
        grok.id = "grok-pass".into();
        grok.provider_id = "grok".into();
        req.configurations.push(grok);
        req.max_executions = 4;
        let run = s.start_run(req).await.unwrap();
        hold_provider_until(&run.id, "grok", now() + 60_000);
        for _ in 0..4 {
            s.tick().await.unwrap();
        }
        let held = s.store.run(&run.id).await.unwrap();
        assert_eq!(held.state, "running");
        for attempt in &held.attempts {
            if attempt.configuration.provider_id == "grok" {
                assert_eq!(attempt.phase, "pending");
            } else {
                assert_eq!(attempt.outcome.as_deref(), Some("pass"));
            }
        }
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        PROVIDER_HOLDS
            .lock()
            .unwrap()
            .remove(&(run.id.clone(), "grok".to_owned()));
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let done = s.store.run(&run.id).await.unwrap();
        assert_eq!(done.state, "completed");
        assert!(done
            .attempts
            .iter()
            .all(|a| a.outcome.as_deref() == Some("pass")));
        assert_eq!(fake.calls.load(Ordering::SeqCst), 4);
    }
    /// The user's Grok sign-in as a test sets it: the expiry it reads, and
    /// the one a listing leaves (`None`: the listing changes nothing).
    struct TestSignIn {
        expiry: std::sync::Mutex<Option<i64>>,
        renewed: Option<i64>,
        listings: std::sync::atomic::AtomicU64,
        /// Whether a benchmark turn still runs on it.
        busy: bool,
    }
    impl TestSignIn {
        fn new(expiry: i64, renewed: Option<i64>) -> Self {
            Self {
                expiry: std::sync::Mutex::new(Some(expiry)),
                renewed,
                listings: Default::default(),
                busy: false,
            }
        }
    }
    impl GrokSignInSource for TestSignIn {
        fn expiry(&self) -> std::result::Result<Option<i64>, String> {
            Ok(*self.expiry.lock().unwrap())
        }
        fn busy(&self) -> BoxFuture<'_, bool> {
            Box::pin(async move { self.busy })
        }
        fn list(&self) -> BoxFuture<'_, Result<()>> {
            Box::pin(async move {
                self.listings.fetch_add(1, Ordering::SeqCst);
                if let Some(renewed) = self.renewed {
                    *self.expiry.lock().unwrap() = Some(renewed);
                }
                Ok(())
            })
        }
    }
    const MINUTE: i64 = 60_000;
    /// A turn of `minutes` needs five more of sign-in, and never less than
    /// fifteen; the Grok CLI renews in the last five.
    async fn gate_for(
        source: &TestSignIn,
        lifetime: &std::sync::Mutex<Option<i64>>,
        minutes: i64,
    ) -> Result<GrokSignInGate> {
        grok_sign_in_gate(
            source,
            (minutes * MINUTE) as u64,
            5 * MINUTE,
            lifetime,
            Duration::from_millis(1),
        )
        .await
    }
    /// A ten-minute turn, which needs fifteen minutes of sign-in.
    async fn gate(
        source: &TestSignIn,
        lifetime: &std::sync::Mutex<Option<i64>>,
    ) -> Result<GrokSignInGate> {
        gate_for(source, lifetime, 10).await
    }
    #[tokio::test]
    async fn a_due_grok_sign_in_is_renewed_through_one_listing() {
        let lifetime = std::sync::Mutex::new(None);
        // Outlasts the turn: nothing is listed.
        let fresh = TestSignIn::new(now() + 60 * MINUTE, None);
        assert_eq!(
            gate(&fresh, &lifetime).await.unwrap(),
            GrokSignInGate::Ready
        );
        assert_eq!(fresh.listings.load(Ordering::SeqCst), 0);
        // Before the CLI's window: wait for it, without listing.
        let early = TestSignIn::new(now() + 10 * MINUTE, None);
        assert!(matches!(
            gate(&early, &lifetime).await.unwrap(),
            GrokSignInGate::WaitUntil(_)
        ));
        assert_eq!(early.listings.load(Ordering::SeqCst), 0);
        // Inside it: one listing, and the renewed sign-in runs the turn.
        let due = TestSignIn::new(now() + 3 * MINUTE, Some(now() + 60 * MINUTE));
        assert_eq!(gate(&due, &lifetime).await.unwrap(), GrokSignInGate::Ready);
        assert_eq!(due.listings.load(Ordering::SeqCst), 1);
        // A listing that renewed nothing is refused as not renewed.
        let stuck = TestSignIn::new(now() + 3 * MINUTE, None);
        let error = gate(&stuck, &lifetime).await.unwrap_err();
        assert_eq!(error.code, "capability_missing");
        assert_eq!(error.message, GROK_NOT_RENEWED);
        assert_eq!(*lifetime.lock().unwrap(), None);
        // Due while another turn still runs on it: not renewed under that turn.
        let mut shared = TestSignIn::new(now() + 3 * MINUTE, Some(now() + 60 * MINUTE));
        shared.busy = true;
        assert_eq!(
            gate(&shared, &lifetime).await.unwrap(),
            GrokSignInGate::Busy
        );
        assert_eq!(shared.listings.load(Ordering::SeqCst), 0);
    }
    /// With the window the chat bridge is started with, a sign-in too short
    /// for a turn of any time limit is renewed at once, never waited for.
    #[tokio::test]
    async fn a_sign_in_too_short_for_a_turn_is_renewed_at_once() {
        let lifetime = std::sync::Mutex::new(None);
        let window = crate::services::provider_rate_limits::grok::cli_renewal_window_ms();
        // Run 32d04afb: fifteen minutes left for a turn of up to four hours.
        let short = TestSignIn::new(now() + 15 * MINUTE, Some(now() + 360 * MINUTE));
        let gate = grok_sign_in_gate(
            &short,
            (240 * MINUTE) as u64,
            window,
            &lifetime,
            Duration::from_millis(1),
        )
        .await
        .unwrap();
        assert_eq!(gate, GrokSignInGate::Ready);
        assert_eq!(short.listings.load(Ordering::SeqCst), 1);
    }
    /// The CLI renewed the sign-in, but for eighteen minutes, short of the
    /// twenty a fifteen-minute turn needs: refused for that, not as "did not
    /// renew it"; and with that seen, a later wait for the window is refused
    /// at once, the same way, since it would end the same.
    #[tokio::test]
    async fn a_renewal_shorter_than_the_turn_is_refused_for_that_and_not_waited_for() {
        let lifetime = std::sync::Mutex::new(None);
        let short = TestSignIn::new(now() + 3 * MINUTE, Some(now() + 18 * MINUTE));
        let error = gate_for(&short, &lifetime, 15).await.unwrap_err();
        assert_eq!(error.code, "capability_missing");
        assert_ne!(error.message, GROK_NOT_RENEWED);
        assert_eq!(error.message, grok_renewal_too_short(15 * MINUTE as u64));
        assert!(error.message.contains("20 minutes"), "{}", error.message);
        assert_eq!(short.listings.load(Ordering::SeqCst), 1);
        let seen = lifetime.lock().unwrap().unwrap();
        assert!((17 * MINUTE..=18 * MINUTE).contains(&seen), "{seen}");
        // The renewed sign-in, sixteen minutes on: no wait for the window.
        let renewed = TestSignIn::new(now() + 16 * MINUTE, None);
        let again = gate_for(&renewed, &lifetime, 15).await.unwrap_err();
        assert_eq!(again.message, error.message);
        assert_eq!(renewed.listings.load(Ordering::SeqCst), 0);
        // A ten-minute turn, which such a renewal outlasts, still waits.
        let ripening = TestSignIn::new(now() + 12 * MINUTE, None);
        assert!(matches!(
            gate(&ripening, &lifetime).await,
            Ok(GrokSignInGate::WaitUntil(_))
        ));
        // A renewal that outlasts the turn forgets the short one.
        let long = TestSignIn::new(now() + 3 * MINUTE, Some(now() + 60 * MINUTE));
        assert_eq!(
            gate_for(&long, &lifetime, 15).await.unwrap(),
            GrokSignInGate::Ready
        );
        assert_eq!(*lifetime.lock().unwrap(), None);
    }
    /// A Grok judge whose sign-in the CLI renews only later answers like a
    /// busy account, so the panel defers the batch instead of recording an
    /// abstention that costs the seat.
    #[test]
    fn a_judge_waiting_for_its_grok_sign_in_defers_the_batch() {
        assert!(judge_sign_in(GrokSignInGate::Ready).is_ok());
        let deferred = judge_sign_in(GrokSignInGate::WaitUntil(now() + MINUTE)).unwrap_err();
        assert_eq!(deferred.code, ACCOUNT_BUSY);
        let shared = judge_sign_in(GrokSignInGate::Busy).unwrap_err();
        assert_eq!(shared.code, ACCOUNT_BUSY);
    }
    /// One Grok answer chunk as the host stores it, with Grok's per-chunk
    /// telemetry and the host's stamp.
    fn telemetry_chunk(kind: &str, text: &str, n: usize) -> Value {
        json!({
            "_meta": {"agentTimestampMs": 1_791_142_991_804u64 + n as u64, "chunkId": n,
                "eventId": format!("01a10871-0ea6-7042-b71f-98eb341afd73-{n}"),
                "promptId": "ddf932fe-1f3b-47f4-a036-120ad519f902",
                "streamStartMs": 1_791_142_990_182u64, "totalTokens": 207,
                "turnStartMs": 1_791_142_989_637u64, "updateType": "AgentMessageChunk"},
            "sessionId": "7ce99634-5aee-4928-9ab8-57085d4c26a3",
            "update": {"_meta": {
                    "distill": {"assistantMessageId": "c373d081-b2d1-4b26-93d4-7e9c8f400d74",
                        "created": "2026-10-04T19:43:15.247Z",
                        "messageId": "30b2e7ec-a1c6-484a-8316-affdf9f8bca1",
                        "runId": "808dd1f8-1cc5-4ba8-964e-da06df71a147"},
                    "executionOwner": {"id": "89663cb7-d49e-4dca-a9cf-6a7637dc82e1:1791142989445",
                        "kind": "benchmark"}},
                "content": {"text": text, "type": "text"}, "sessionUpdate": kind}
        })
    }
    fn blank_attempt() -> Attempt {
        let (data, _) = super::super::analysis::tests::dataset();
        let mut attempt = data.attempts[0].clone();
        attempt.usage = TokenUsage::default();
        attempt.resolved_model = None;
        attempt
    }
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
        assert_eq!(events.len(), 1_501);
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
            super::super::evidence::EvidenceLog::with_ceiling(2_000),
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
    /// Run 607f8612: Kimi answered every attempt on a model its plan leaves
    /// out with a 401 that names the model. That is the configuration being
    /// unsupported, not a broken bridge; a sign-in failure names no model.
    #[test]
    fn a_provider_refusing_the_model_makes_the_configuration_unsupported() {
        let refused = json!({"code": -32000,
            "data": {"accountId": "cli-login-kimi-acp", "dispatchStarted": true, "promptNotAccepted": false},
            "message": "Authentication required: 401 Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans. Upgrade: Upgrade: https://www.kimi.com/code?from=server_highspeed_error#pricing"});
        assert_eq!(
            terminal_outcome(&refused, "kimi-code/kimi-for-coding-highspeed"),
            "unsupported"
        );
        // The same refusal does not name the plan's own model.
        assert_eq!(
            terminal_outcome(&refused, "kimi-code/kimi-for-coding"),
            "infrastructure_failure"
        );
        // A sign-in that failed names no model.
        let signed_out = json!({"code": -32000, "message": "Authentication required"});
        assert_eq!(
            terminal_outcome(&signed_out, "kimi-code/kimi-for-coding"),
            "infrastructure_failure"
        );
        // Nor does one that mentions the model without refusing it.
        for message in [
            "Authentication required: 401 sign in again to keep using kimi-for-coding-highspeed",
            "Authentication required: your subscription for kimi-for-coding-highspeed renews today; log in again",
        ] {
            assert_eq!(
                terminal_outcome(
                    &json!({"code": -32000, "message": message}),
                    "kimi-code/kimi-for-coding-highspeed"
                ),
                "infrastructure_failure",
                "{message}"
            );
        }
        // The refusal reads the same in another case, and by the full id.
        let shouting = json!({"code": -32000,
            "message": "401 YOUR CURRENT SUBSCRIPTION DOES NOT HAVE ACCESS TO KIMI-CODE/KIMI-FOR-CODING-HIGHSPEED"});
        assert_eq!(
            terminal_outcome(&shouting, "kimi-code/kimi-for-coding-highspeed"),
            "unsupported"
        );
        // Another error that names the model is not a refusal of it.
        let crashed = json!({"code": -32603,
            "message": "Internal error: kimi-for-coding-highspeed stream reset"});
        assert_eq!(
            terminal_outcome(&crashed, "kimi-code/kimi-for-coding-highspeed"),
            "infrastructure_failure"
        );
        // Typed outcomes are read as before.
        assert_eq!(
            terminal_outcome(&json!({"kind": "budget_timeout"}), "m"),
            "budget_timeout"
        );
        assert!(names("no access to grok-4.", "grok-4"));
        assert!(!names("no access to grok-4.7", "grok-4"));
        assert!(!names("no access to grok-4-fast", "grok-4"));
        assert!(!names("no access to xgrok-4", "grok-4"));
    }
    /// Listing a bridge's models opens a session on the bridge the user's
    /// chats use; a run does it once per provider and account, again only
    /// when another executable serves them.
    #[test]
    fn a_run_lists_each_bridge_once_until_another_executable_serves_it() {
        let kept = RunInventories::default();
        let on = |len: u64| json!({"path":"bridge.js","len":len,"modified":1});
        let inventory = json!({"executable": on(1), "models": [{"modelId":"m"}]});
        assert_eq!(kept.current("run", "p", "a", &on(1)), None);
        kept.keep("run", "p", "a", inventory.clone());
        assert_eq!(
            kept.current("run", "p", "a", &on(1)),
            Some(inventory.clone())
        );
        // Another executable, account or run is listed again; nothing serving
        // is never a match.
        assert_eq!(kept.current("run", "p", "a", &on(2)), None);
        assert_eq!(kept.current("run", "p", "b", &on(1)), None);
        assert_eq!(kept.current("next", "p", "a", &on(1)), None);
        assert_eq!(kept.current("run", "p", "a", &Value::Null), None);
        // Bounded: past the limit, other runs' inventories go.
        for n in 0..RunInventories::LIMIT {
            kept.keep(&format!("old-{n}"), "p", "a", inventory.clone());
        }
        kept.keep("run", "p", "b", inventory.clone());
        assert_eq!(kept.current("old-0", "p", "a", &on(1)), None);
        assert!(kept.current("run", "p", "b", &on(1)).is_some());
    }
    #[test]
    fn only_a_turn_the_provider_never_saw_returns_to_the_queue() {
        assert!(returns_to_queue(QUOTA_WAIT, "running"));
        for code in ["selection_changed", "capability_missing"] {
            assert!(returns_to_queue(code, "preparing"), "{code}");
            // Once the prompt is on its way, the turn is the provider's.
            assert!(!returns_to_queue(code, "dispatching"), "{code}");
            assert!(!returns_to_queue(code, "running"), "{code}");
        }
        for code in ["infrastructure_failure", "cancelled", "dispatch_uncertain"] {
            assert!(!returns_to_queue(code, "preparing"), "{code}");
        }
    }
    #[tokio::test]
    async fn a_retried_turn_gets_a_new_owner_and_key() {
        let (_dir, s, _) = setup().await;
        let run = s.start_run(request(&s).await).await.unwrap();
        let mut attempt = s.store.run(&run.id).await.unwrap().attempts.remove(0);
        attempt.started_at = Some(1);
        let (owner, key) = (turn_owner(&attempt), dispatch_key(&attempt));
        attempt.started_at = Some(2);
        assert_ne!(turn_owner(&attempt), owner);
        assert_ne!(dispatch_key(&attempt), key);
    }
    #[test]
    fn only_an_identifier_before_the_colon_is_a_host_error_code() {
        assert_eq!(host_error("validation: bad key".into()).code, "validation");
        let crash = host_error("Internal error: {\"details\":\"exited\"}".into());
        assert_eq!(crash.code, "infrastructure_failure");
        assert!(crash.message.starts_with("Internal error:"));
        assert!(is_quota_wait(
            &json!({"code":-32010,"data":{"kind":QUOTA_WAIT,"dispatchStarted":false}})
        ));
        assert!(!is_quota_wait(
            &json!({"code":-32010,"data":{"kind":QUOTA_WAIT,"dispatchStarted":true}})
        ));
    }
    #[tokio::test]
    async fn a_baseline_refuses_a_configuration_frozen_under_two_protocols() {
        let (_dir, s, _) = setup().await;
        let first = s.start_run(request(&s).await).await.unwrap();
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let mut longer = request(&s).await;
        longer.timeout_seconds += 60;
        longer.request_key = "longer-key".into();
        let second = s.start_run(longer).await.unwrap();
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let both = vec![first.id.clone(), second.id.clone()];
        assert!(s.create_baseline("Mixed".into(), both, 0.1).await.is_err());
        for id in [first.id, second.id] {
            assert!(s.create_baseline("One".into(), vec![id], 0.1).await.is_ok());
        }
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
    #[test]
    fn execution_violation_is_its_own_unscored_outcome() {
        assert_eq!(
            terminal_error_outcome(
                &json!({"kind":"execution_violation","message":"execution_violation: native execution violated the declared no-tool policy"})
            ),
            "execution_violation"
        );
        assert_eq!(
            terminal_error_outcome(&json!({"kind":"capability_missing"})),
            "unsupported"
        );
        let tagged = json!({"params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","_meta":{"executionViolation":"native tool activity in no-tool profile"}}}});
        assert_eq!(
            violation_of(&tagged).as_deref(),
            Some("native tool activity in no-tool profile")
        );
        assert_eq!(
            violation_of(&tagged["params"]).as_deref(),
            Some("native tool activity in no-tool profile")
        );
        assert_eq!(
            violation_of(&json!({"update":{"sessionUpdate":"agent_message_chunk"}})),
            None
        );
        let attempt = |outcome: &str| -> Attempt {
            serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v",
                "configuration":{"id":"c","providerId":"claude-acp","accountId":"x","modelId":"m","billingMode":"subscription","executionProfile":"native_text"},
                "repetition":0,"phase":"terminal","outcome":outcome,"output":"answer","finishedAt":1,
                "usage":{"schema":"native"},"eventCursor":0,"workflowSteps":[],
                "evaluations":[{"id":"e","evaluatorRevision":"r","verdict":"pass","score":1.0,"reason":"","createdAt":1,"provenance":"deterministic"}]}))
            .unwrap()
        };
        assert_eq!(super::super::analysis::score(&attempt("pass")), Some(1.0));
        assert_eq!(
            super::super::analysis::score(&attempt("execution_violation")),
            None
        );
    }
    #[test]
    fn judge_provider_allowed_only_for_claude() {
        assert!(judge_provider_allowed("claude-acp"));
        for provider in ["codex-acp", "grok-acp", "kimi-acp", "unknown"] {
            assert!(!judge_provider_allowed(provider), "{provider}");
        }
    }
    /// Today's formula, inline: a configuration pinned before provider
    /// profiles existed must keep matching its runtime.
    #[tokio::test]
    async fn claude_inventory_fingerprint_is_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let entrypoint = directory.path().join("index.js");
        tokio::fs::write(&entrypoint, "launcher entrypoint")
            .await
            .unwrap();
        let inventory = json!({"executable":{"path":entrypoint.to_string_lossy()},"models":[{"modelId":"sonnet"},{"id":"opus","name":"Opus 5.5"},{"modelId":"sonnet"}]});
        let mut hash = Sha256::new();
        hash.update(b"launcher entrypoint");
        hash.update(include_bytes!("../../../../acp-tools.lock.json"));
        hash.update(b"distill-native-text-policy-v2");
        hash.update(NATIVE_TEXT_ADAPTER.as_bytes());
        hash.update(serde_json::to_vec(&json!(["opus", "sonnet"])).unwrap());
        let expected = hex::encode(hash.finalize());
        // One revision for every row, as Claude configurations were pinned.
        for model in ["sonnet", "opus", "unlisted"] {
            assert_eq!(
                inventory_fingerprint(&inventory, NativeProvider::Claude, None, model)
                    .await
                    .unwrap(),
                expected
            );
        }
    }
    #[tokio::test]
    async fn codex_fingerprint_follows_pinned_files_and_model_names() {
        let directory = tempfile::tempdir().unwrap();
        let entrypoint = directory.path().join("index.js");
        let native = directory.path().join("codex.exe");
        tokio::fs::write(&entrypoint, "bridge").await.unwrap();
        tokio::fs::write(&native, "cli").await.unwrap();
        let path = entrypoint.to_string_lossy();
        let inventory = json!({"executable":{"path":path},"models":[{"modelId":"gpt-6-sol","name":"GPT-6-Sol"}]});
        let codex = NativeProvider::Codex;
        let fingerprint = |inventory: Value, native: Option<std::path::PathBuf>| async move {
            inventory_fingerprint(&inventory, codex, native, "gpt-6-sol")
                .await
                .unwrap()
        };
        let first = fingerprint(inventory.clone(), Some(native.clone())).await;
        assert_eq!(
            first,
            fingerprint(inventory.clone(), Some(native.clone())).await
        );
        assert_ne!(first, fingerprint(inventory.clone(), None).await);
        assert_ne!(
            first,
            inventory_fingerprint(
                &inventory,
                NativeProvider::Claude,
                Some(native.clone()),
                "gpt-6-sol"
            )
            .await
            .unwrap()
        );
        // A moving alias: same id, another name.
        let renamed = json!({"executable":{"path":path},"models":[{"modelId":"gpt-6-sol","name":"GPT-6-Sol Preview"}]});
        assert_ne!(first, fingerprint(renamed, Some(native.clone())).await);
        // The vendor's list growing, or another row changing, leaves this
        // configuration's runtime alone; its own row leaving the list does not.
        let grown = json!({"executable":{"path":path},"models":[{"modelId":"gpt-6-sol","name":"GPT-6-Sol"},
            {"modelId":"gpt-6-luna","name":"GPT-6-Luna Preview"}]});
        assert_eq!(
            first,
            fingerprint(grown.clone(), Some(native.clone())).await
        );
        let other = inventory_fingerprint(&grown, codex, Some(native.clone()), "gpt-6-luna")
            .await
            .unwrap();
        assert_ne!(first, other);
        let without = json!({"executable":{"path":path},"models":[{"modelId":"gpt-6-luna","name":"GPT-6-Luna"}]});
        assert_ne!(first, fingerprint(without, Some(native.clone())).await);
        // Only the bridge's own lock entry counts: a Claude bridge pin bump is
        // not a Codex runtime change.
        let lock = managed_lock_entry("codex-acp").unwrap();
        assert!(lock.contains("@agentclientprotocol/codex-acp"));
        assert!(!lock.contains("claude-agent-acp"));
        assert_eq!(managed_lock_entry("grok-acp"), None);
        tokio::fs::write(&native, "updated cli").await.unwrap();
        assert_ne!(
            first,
            fingerprint(inventory.clone(), Some(native.clone())).await
        );
        // The runtime differs from the pins, so the rows say why.
        let issue = runtime_issue(&inventory, codex, Some(native))
            .await
            .unwrap();
        assert!(issue.contains("installed Codex runtime changed"), "{issue}");
        assert_eq!(
            runtime_issue(&json!({"models":[]}), codex, None)
                .await
                .as_deref(),
            Some("Native executable provenance is missing")
        );
    }
    /// What a Codex configuration's revision is made of, in order: the
    /// pinned files as installed, codex-acp's own lock entry, the policy and
    /// adapter, and the configuration's own model with its name.
    #[tokio::test]
    async fn codex_revision_is_its_own_pins_lock_entry_policy_and_model() {
        let directory = tempfile::tempdir().unwrap();
        let entrypoint = directory.path().join("index.js");
        let native = directory.path().join("codex.exe");
        tokio::fs::write(&entrypoint, "bridge").await.unwrap();
        tokio::fs::write(&native, "cli").await.unwrap();
        let inventory = json!({"executable":{"path":entrypoint.to_string_lossy()},
            "models":[{"modelId":"gpt-6-sol","name":"GPT-6-Sol"},{"modelId":"gpt-6-luna","name":"GPT-6-Luna"}]});
        let codex = NativeProvider::Codex;
        let mut hash = Sha256::new();
        hash.update(b"distill-native-runtime-v1\0");
        for (role, content) in [("entrypoint", "bridge"), ("nativeCli", "cli")] {
            hash.update(role.as_bytes());
            hash.update(b"\0");
            hash.update(hex::encode(Sha256::digest(content)).as_bytes());
            hash.update(b"\0");
        }
        if crate::services::managed_acp_tools::is_managed("codex-acp") {
            hash.update(managed_lock_entry("codex-acp").unwrap().as_bytes());
        }
        hash.update(codex.policy_revision().as_bytes());
        hash.update(codex.policy_bytes());
        hash.update(codex.adapter().unwrap().as_bytes());
        hash.update(b"model\0");
        hash.update("gpt-6-sol\u{1f}GPT-6-Sol".as_bytes());
        assert_eq!(
            inventory_fingerprint(&inventory, codex, Some(native), "gpt-6-sol")
                .await
                .unwrap(),
            hex::encode(hash.finalize())
        );
    }
    #[test]
    fn codex_inventory_drops_ultra() {
        let excluded = NativeProvider::Codex.excluded_efforts();
        let row = json!({"modelId":"gpt-6-astra","reasoningEfforts":["low","medium","high","xhigh","max","ultra"]});
        assert_eq!(
            offered_efforts(&row, excluded),
            ["low", "medium", "high", "xhigh", "max"]
        );
        let described = json!({"id":"gpt-6-sol","efforts":[{"value":"ultra"},{"value":"low"}]});
        assert_eq!(offered_efforts(&described, excluded), ["low"]);
        assert_eq!(
            offered_efforts(&row, NativeProvider::Claude.excluded_efforts()).len(),
            6
        );
        assert!(offered_efforts(&json!({"modelId":"m"}), excluded).is_empty());
    }
    #[test]
    fn codex_configurations_refuse_ultra_and_need_an_account() {
        let configuration = |effort: Option<&str>, account: Option<&str>| -> Configuration {
            serde_json::from_value(json!({"id":"c","providerId":"codex-acp","accountId":account,
                "modelId":"gpt-6-sol","effort":effort,"billingMode":"subscription","executionProfile":"native_text"}))
            .unwrap()
        };
        assert_eq!(
            profile_refusal(&configuration(Some("max"), Some("a"))),
            None
        );
        assert_eq!(
            profile_refusal(&configuration(Some("ultra"), Some("a"))).as_deref(),
            Some("effort 'ultra' delegates to subagents and is not a single-model no-tool configuration")
        );
        assert_eq!(
            profile_refusal(&configuration(None, None)).as_deref(),
            Some("Choose a managed account")
        );
        // Grok and Kimi run on their CLI sign-in identities.
        let mut grok = configuration(Some("xhigh"), Some("cli-login-grok-acp"));
        grok.provider_id = "grok-acp".into();
        assert_eq!(profile_refusal(&grok), None);
        let mut kimi = configuration(Some("max"), Some("cli-login-kimi-acp"));
        kimi.provider_id = "kimi-acp".into();
        assert_eq!(profile_refusal(&kimi), None);
        kimi.account_id = None;
        assert_eq!(
            profile_refusal(&kimi).as_deref(),
            Some("Choose the CLI sign-in")
        );
        kimi.account_id = Some(String::new());
        assert_eq!(
            profile_refusal(&kimi).as_deref(),
            Some("Choose the CLI sign-in")
        );
        let mut unknown = configuration(None, Some("a"));
        unknown.provider_id = "copilot-acp".into();
        assert_eq!(
            profile_refusal(&unknown).as_deref(),
            Some("This provider/account has no verified native text execution policy")
        );
        unknown.account_id = None;
        assert_eq!(
            profile_refusal(&unknown).as_deref(),
            Some("This provider/account has no verified native text execution policy")
        );
        // Kimi's, Codex's and Grok's profiles have passed their policy
        // probes (NativeProvider::admission_issue covers one that has not).
        kimi.account_id = Some("cli-login-kimi-acp".into());
        assert_eq!(native_refusal(&kimi), None);
        let mut codex = configuration(Some("max"), Some("a"));
        codex.provider_id = "codex-acp".into();
        assert_eq!(native_refusal(&codex), None);
        assert_eq!(native_refusal(&grok), None);
        let mut claude = configuration(Some("high"), Some("a"));
        claude.provider_id = "claude-acp".into();
        assert_eq!(native_refusal(&claude), None);
        // An inventory without an account asks for what the provider uses.
        assert_eq!(account_refusal("grok-acp"), "Choose the CLI sign-in");
        assert_eq!(account_refusal("kimi-acp"), "Choose the CLI sign-in");
        assert_eq!(account_refusal("codex-acp"), "Choose a managed account");
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
    #[tokio::test]
    async fn kimi_fingerprint_follows_the_bundle_behind_the_shim() {
        let prefix = tempfile::tempdir().unwrap();
        let shim = prefix.path().join("kimi.cmd");
        tokio::fs::write(&shim, "@ECHO off").await.unwrap();
        // The chat bridge's inventory names the shim.
        let inventory = json!({"executable":{"path":shim.to_string_lossy()},
            "models":[{"modelId":"kimi-code/kimi-for-coding","name":"K2.8 Preview"}]});
        let kimi = NativeProvider::Kimi;
        let fingerprint = |inventory: Value| async move {
            inventory_fingerprint(&inventory, kimi, None, "kimi-code/kimi-for-coding")
                .await
                .unwrap()
        };
        // Without the package beside it the rows say why, and the listing
        // still has a revision.
        assert_eq!(
            runtime_issue(&inventory, kimi, None).await.as_deref(),
            Some("capability_missing: Kimi Code is not a recognized npm install")
        );
        let unrecognized = fingerprint(inventory.clone()).await;
        let dist = prefix
            .path()
            .join("node_modules")
            .join("@moonshot-ai")
            .join("kimi-code")
            .join("dist");
        tokio::fs::create_dir_all(&dist).await.unwrap();
        tokio::fs::write(dist.join("main.mjs"), "kimi build")
            .await
            .unwrap();
        let first = fingerprint(inventory.clone()).await;
        assert_ne!(first, unrecognized);
        // The shim is not what is pinned; the bundle is.
        tokio::fs::write(&shim, "@ECHO on").await.unwrap();
        assert_eq!(first, fingerprint(inventory.clone()).await);
        tokio::fs::write(dist.join("main.mjs"), "updated kimi build")
            .await
            .unwrap();
        assert_ne!(first, fingerprint(inventory.clone()).await);
        let issue = runtime_issue(&inventory, kimi, None).await.unwrap();
        assert!(
            issue.contains("installed Kimi Code runtime changed"),
            "{issue}"
        );
        // A moving alias: the same id under a new name is a new runtime.
        let renamed = json!({"executable":{"path":shim.to_string_lossy()},
            "models":[{"modelId":"kimi-code/kimi-for-coding","name":"K2.9 Preview"}]});
        assert_ne!(
            fingerprint(inventory.clone()).await,
            fingerprint(renamed).await
        );
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
            attempt.observed.unwrap().execution_profile,
            "native_text_auxiliary"
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
        req.max_executions = 4 * req.configurations.len() as u32;
        let run = s.start_run(req).await.unwrap();
        s.tick().await.unwrap();
        let a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        assert_eq!(a.outcome.as_deref(), Some("pending_review"));
        let a = s
            .review(&a.id, 1.0, "Meets the declared rubric".into(), None)
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
    fn a_usage_limit_waits_for_a_reset_it_can_reach_and_stops_otherwise() {
        let at = 1_800_000_000_000i64;
        let hour = 3_600_000i64;
        let five_hour = r#"{"code":-32000,"message":"Authentication required: 403 You've reached your 5-hour usage limit."}"#;
        // No reset named: try again shortly, as long as the refusals last no
        // longer than a 5-hour window can.
        assert_eq!(
            quota_plan("run-a", "kimi-acp", five_hour, at),
            QuotaPlan::WaitUntil(at + QUOTA_RETRY_MS)
        );
        assert_eq!(
            quota_plan("run-a", "kimi-acp", five_hour, at + 3 * hour),
            QuotaPlan::WaitUntil(at + 3 * hour + QUOTA_RETRY_MS)
        );
        assert_eq!(
            quota_plan("run-a", "kimi-acp", five_hour, at + QUOTA_WAIT_LIMIT_MS + 1),
            QuotaPlan::Stop
        );
        // After a stop, or a turn that went through, a refusal starts a new wait.
        let later = at + QUOTA_WAIT_LIMIT_MS + 2;
        assert_eq!(
            quota_plan("run-a", "kimi-acp", five_hour, later),
            QuotaPlan::WaitUntil(later + QUOTA_RETRY_MS)
        );
        quota_recovered("run-a", "kimi-acp");
        assert_eq!(
            quota_plan("run-a", "kimi-acp", five_hour, later + 6 * hour),
            QuotaPlan::WaitUntil(later + 6 * hour + QUOTA_RETRY_MS)
        );
        // A reset the host names: wait for it when near, stop when far.
        let reset = |next: i64| {
            json!({"code":-32010,"data":{"kind":QUOTA_WAIT,"dispatchStarted":false,"nextReset":next}})
                .to_string()
        };
        assert_eq!(
            quota_plan("run-b", "claude-acp", &reset(at + hour), at),
            QuotaPlan::WaitUntil(at + hour)
        );
        assert_eq!(
            quota_plan("run-c", "claude-acp", &reset(at + 72 * hour), at),
            QuotaPlan::Stop
        );
        // A weekly or monthly limit is never waited out.
        let weekly = r#"{"message":"You've reached your weekly usage limit."}"#;
        assert_eq!(quota_plan("run-d", "kimi-acp", weekly, at), QuotaPlan::Stop);
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
    #[tokio::test]
    async fn runtime_identity_ignores_lazily_learned_efforts_but_not_the_model_set() {
        let directory = tempfile::tempdir().unwrap();
        for provider in NativeProvider::ALL.iter().copied() {
            // Grok's runtime is its native binary; any other name is the npm
            // shim, which stands for the binary in the Grok home.
            let name = match provider {
                NativeProvider::Grok if cfg!(windows) => "grok.exe",
                NativeProvider::Grok => "grok",
                _ => "bridge.js",
            };
            let executable = directory.path().join(name);
            let path = executable.to_string_lossy().into_owned();
            let before = json!({"executable":{"path":path},"models":[{"modelId":"sonnet","reasoningEfforts":[]},{"modelId":"opus","reasoningEfforts":["low"]}]});
            let learned = json!({"executable":{"path":path},"models":[{"modelId":"opus","reasoningEfforts":["low","high"],"supportsFast":true},{"modelId":"sonnet","reasoningEfforts":["low"]}]});
            let grown = json!({"executable":{"path":path},"models":[{"modelId":"sonnet"},{"modelId":"opus"},{"modelId":"haiku"}]});
            let renamed = json!({"executable":{"path":path},"models":[{"modelId":"sonnet"},{"modelId":"opus","name":"Opus Next"}]});
            tokio::fs::write(&executable, "bridge").await.unwrap();
            let fingerprint = |inventory: &Value| {
                let inventory = inventory.clone();
                async move {
                    inventory_fingerprint(&inventory, provider, None, "opus")
                        .await
                        .unwrap()
                }
            };
            let first = fingerprint(&before).await;
            assert_eq!(first, fingerprint(&learned).await, "{provider:?}");
            // Claude's configurations were pinned to the whole model set;
            // the others to their own model and its name.
            if provider == NativeProvider::Claude {
                assert_ne!(first, fingerprint(&grown).await, "{provider:?}");
            } else {
                assert_eq!(first, fingerprint(&grown).await, "{provider:?}");
                assert_ne!(first, fingerprint(&renamed).await, "{provider:?}");
            }
            tokio::fs::write(&executable, "updated bridge")
                .await
                .unwrap();
            assert_ne!(first, fingerprint(&before).await, "{provider:?}");
        }
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
            model_name: None,
        };
        let mut observed = c.clone();
        observed.effort = Some("high".into());
        assert!(matches_selection(&c, &observed));
        let mut requested = c;
        requested.effort = Some("low".into());
        assert!(!matches_selection(&requested, &observed));
    }
    fn creative() -> BenchmarkDraft {
        seed_definitions()
            .into_iter()
            .find(|d| d.work_class_id == "creative")
            .unwrap()
    }
    async fn publish(s: &BenchmarkService, draft: BenchmarkDraft) -> BenchmarkVersion {
        let definition = s.store.save_draft(None, None, draft).await.unwrap();
        s.store.publish(&definition.id, 1).await.unwrap()
    }
    /// One repetition of a creative brief for the passing fake model.
    async fn creative_request(s: &BenchmarkService) -> RunRequest {
        let version = publish(s, creative()).await;
        let mut req = request(s).await;
        req.request_key = "creative".into();
        req.version_ids = vec![version.id];
        req.repetitions = 1;
        req.max_executions = 4;
        req
    }
    async fn rewrite_plan(s: &BenchmarkService, id: &str, request: &RunRequest) {
        sqlx::query("UPDATE run_plans SET request_json=? WHERE id=?")
            .bind(serde_json::to_string(request).unwrap())
            .bind(id)
            .execute(&s.store.pool)
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn authored_cells_are_never_planned_or_dispatched() {
        let (_dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        let mut authored = seed_definitions().remove(0);
        authored.name.push_str(" written by the candidate");
        authored.environment["authoredBy"] = json!(["fake-pass"]);
        let written = publish(&s, authored).await;
        req.version_ids.push(written.id.clone());
        req.repetitions = 1;
        let mut other = req.configurations[0].clone();
        other.id = "fake-fail".into();
        other.model_id = "fake-fail".into();
        req.configurations.push(other);
        req.max_executions = 3;
        let preview = s.preview_run(&req).await.unwrap();
        assert!(preview.valid, "{:?}", preview.issues);
        assert_eq!(preview.execution_count, 3);
        let run = s.start_run(req.clone()).await.unwrap();
        assert_eq!(run.attempts.len(), 3);
        assert!(!run
            .attempts
            .iter()
            .any(|a| a.version_id == written.id && a.configuration.model_id == "fake-pass"));
        // A configuration that wrote every selected case owes nothing.
        let mut only = req.clone();
        only.request_key = "only-authored".into();
        only.version_ids = vec![written.id.clone()];
        only.configurations.truncate(1);
        let preview = s.preview_run(&only).await.unwrap();
        assert!(!preview.valid);
        assert!(preview.issues.iter().any(|i| i.contains("owes none")));
        // A plan saved before this rule still holds such a cell: it settles
        // without any model call when its turn comes.
        let mut legacy = run.attempts[0].clone();
        legacy.id = "legacy-authored".into();
        legacy.version_id = written.id.clone();
        legacy.configuration = req.configurations[0].clone();
        legacy.repetition = 0;
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,0,'pending',?)")
            .bind(&legacy.id).bind(&run.id).bind(&written.id).bind(&legacy.configuration.id)
            .bind(serde_json::to_string(&legacy).unwrap())
            .execute(&s.store.pool).await.unwrap();
        for _ in 0..5 {
            s.tick().await.unwrap();
        }
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "completed");
        let excluded = s.store.attempt("legacy-authored").await.unwrap();
        assert_eq!(excluded.phase, "terminal");
        assert_eq!(excluded.outcome.as_deref(), Some("excluded"));
        assert_eq!(
            excluded.reason.as_deref(),
            Some("authored by this candidate")
        );
        assert!(excluded.session_id.is_none());
        assert_eq!(backend.calls.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn stale_runtime_pins_and_judged_quota_briefs_are_plan_issues() {
        let (_dir, s, _) = setup().await;
        let mut req = request(&s).await;
        assert!(s.preview_run(&req).await.unwrap().valid);
        req.configurations[0].inventory_revision = Some("runtime-before-an-update".into());
        let preview = s.preview_run(&req).await.unwrap();
        assert!(!preview.valid);
        assert!(preview.issues.iter().any(|i| i.contains("Runtime changed")));
        assert!(s.start_run(req).await.is_err());
        let mut quota = creative();
        quota.measurement_profile = "controlled_quota".into();
        let version = publish(&s, quota).await;
        let mut req = creative_request(&s).await;
        req.version_ids = vec![version.id];
        let preview = s.preview_run(&req).await.unwrap();
        assert!(preview
            .issues
            .iter()
            .any(|i| i.contains("task metrics only")));
    }
    #[tokio::test]
    async fn a_cli_default_effort_is_refused_at_planning() {
        let (_dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        req.configurations[0].effort = Some("default".into());
        let preview = s.preview_run(&req).await.unwrap();
        assert!(!preview.valid);
        assert!(
            preview
                .issues
                .iter()
                .any(|issue| issue.contains("fake-pass")
                    && issue.contains("\"default\" is not an effort level")),
            "{:?}",
            preview.issues
        );
        let refused = s.start_run(req.clone()).await.unwrap_err();
        assert!(refused.message.contains("not an effort level"));
        assert!(s.store.runs().await.unwrap().is_empty());
        // An explicit level plans, and so does a model without an effort control.
        req.configurations[0].effort = Some("high".into());
        assert!(s.preview_run(&req).await.unwrap().valid);
        req.configurations[0].effort = None;
        assert!(s.preview_run(&req).await.unwrap().valid);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn the_inventory_never_offers_the_cli_default_effort() {
        let claude = NativeProvider::Claude.excluded_efforts();
        let row = json!({"modelId":"sonnet","reasoningEfforts":["default","low","high","max"]});
        assert_eq!(offered_efforts(&row, claude), ["low", "high", "max"]);
        let described = json!({"id":"opus","efforts":[{"value":"default"},{"value":"xhigh"}]});
        assert_eq!(offered_efforts(&described, claude), ["xhigh"]);
        // A model whose only entry is the CLI's default has no effort control.
        let haiku = json!({"modelId":"haiku","reasoningEfforts":["default"]});
        assert!(offered_efforts(&haiku, claude).is_empty());
        // The fake models have none either, and leave the effort unset.
        let (_dir, s, _) = setup().await;
        for model in s
            .backend
            .inventory("fake", Some("isolated"), false)
            .await
            .unwrap()
        {
            assert!(model.efforts.is_empty());
            assert_eq!(model.configuration.effort, None);
        }
    }
    #[tokio::test]
    async fn an_unset_effort_is_refused_on_a_model_that_lists_levels() {
        let (_dir, s, backend) = setup().await;
        *backend.effort_levels.lock().unwrap() = vec!["high".into()];
        let mut req = request(&s).await;
        req.configurations[0].effort = None;
        let preview = s.preview_run(&req).await.unwrap();
        assert!(!preview.valid);
        assert!(
            preview
                .issues
                .iter()
                .any(|issue| issue.contains("fake-pass")
                    && issue.contains("leaves its reasoning effort to the CLI")
                    && issue.ends_with("the model lists: high")),
            "{:?}",
            preview.issues
        );
        let refused = s.start_run(req.clone()).await.unwrap_err();
        assert!(refused
            .message
            .contains("leaves its reasoning effort to the CLI"));
        assert!(s.store.runs().await.unwrap().is_empty());
        // A level the model lists plans.
        req.configurations[0].effort = Some("high".into());
        let preview = s.preview_run(&req).await.unwrap();
        assert!(preview.valid, "{:?}", preview.issues);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn the_analysis_data_leaves_out_attempts_acknowledged_at_the_cli_default() {
        let (_dir, s, _) = setup().await;
        let run = s.start_run(request(&s).await).await.unwrap();
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        let completed = s.store.run(&run.id).await.unwrap();
        assert_eq!(completed.state, "completed");
        let counted =
            |data: &QueryData| data.attempts.iter().filter(|a| a.run_id == run.id).count();
        let ranked = |data: &QueryData| {
            super::super::analysis::leaderboard(data, &ResultQuery::default())
                .rows
                .iter()
                .any(|row| row.configuration.model_id == "fake-pass")
        };
        let data = s.query_data().await.unwrap();
        assert_eq!(counted(&data), 2);
        assert!(ranked(&data));
        // The bridge acknowledged the CLI's "default" for every attempt of the
        // unset request.
        for attempt in &completed.attempts {
            let mut attempt = s.store.attempt(&attempt.id).await.unwrap();
            attempt.observed.as_mut().unwrap().effort = Some("default".into());
            s.store.save_attempt(&attempt).await.unwrap();
        }
        let data = s.query_data().await.unwrap();
        assert_eq!(counted(&data), 0);
        assert!(!ranked(&data));
        let planned = data.runs.iter().find(|r| r.id == run.id).unwrap();
        assert!(planned.attempts.is_empty());
        assert!(planned.request.configurations.is_empty());
        // Run detail and the raw run listing keep them for audit.
        assert_eq!(s.store.run(&run.id).await.unwrap().attempts.len(), 2);
        let listed = s.store.runs().await.unwrap();
        assert_eq!(
            listed
                .iter()
                .find(|r| r.id == run.id)
                .unwrap()
                .attempt_count,
            2
        );
    }
    #[tokio::test]
    async fn judge_calls_are_reserved_and_only_the_budget_skips_them() {
        let (_dir, s, backend) = setup().await;
        let mut req = creative_request(&s).await;
        req.max_executions = 3;
        let preview = s.preview_run(&req).await.unwrap();
        assert_eq!(preview.execution_count, 4);
        assert!(!preview.valid);
        assert!(s.start_run(req.clone()).await.is_err());
        req.max_executions = 4;
        let covered = s.start_run(req.clone()).await.unwrap();
        // A pin that went stale after admission does not cost the panel its reservation.
        let mut stale = req.clone();
        stale.configurations[0].inventory_revision = Some("runtime-before-an-update".into());
        rewrite_plan(&s, &covered.id, &stale).await;
        s.tick().await.unwrap();
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        let judged = s.store.attempt(&covered.attempts[0].id).await.unwrap();
        assert_eq!(judged.phase, "terminal");
        assert!(judged.reason.is_none());
        // A plan saved before the reservation never dispatches judges.
        let mut old = req.clone();
        old.request_key = "saved-before-reservations".into();
        let old_run = s.start_run(old.clone()).await.unwrap();
        old.max_executions = 1;
        rewrite_plan(&s, &old_run.id, &old).await;
        s.tick().await.unwrap();
        s.tick().await.unwrap();
        let skipped = s.store.attempt(&old_run.attempts[0].id).await.unwrap();
        assert_eq!(skipped.phase, "terminal");
        assert_eq!(skipped.outcome.as_deref(), Some("pending_review"));
        assert_eq!(
            skipped.reason.as_deref(),
            Some("Judge calls are not covered by this saved run's execution budget")
        );
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    }
    /// Starts a creative run and stops it with `action` while its panel runs.
    async fn stop_during_the_panel(
        s: &Arc<BenchmarkService>,
        backend: &FakeBackend,
        action: &str,
    ) -> BenchmarkRun {
        backend.hold_judges.store(true, Ordering::SeqCst);
        let run = s.start_run(creative_request(s).await).await.unwrap();
        let background = s.clone();
        let tick = tokio::spawn(async move { background.tick().await });
        backend.judge_entered.notified().await;
        // The cancel signal stays live while the panel runs.
        assert!(!s.active.lock().await.is_empty());
        s.control(&run.id, action).await.unwrap();
        backend.hold_judges.store(false, Ordering::SeqCst);
        backend.judge_release.notify_one();
        tick.await.unwrap().unwrap();
        assert_eq!(backend.stopped_judges.load(Ordering::SeqCst), 1, "{action}");
        assert!(s.active.lock().await.is_empty());
        run
    }
    #[tokio::test]
    async fn a_cancel_reaches_a_running_judge_panel_and_settles_the_attempt() {
        let (_dir, s, backend) = setup().await;
        let run = stop_during_the_panel(&s, &backend, "cancel").await;
        let a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        assert_eq!(a.phase, "terminal");
        assert_eq!(a.outcome.as_deref(), Some("pending_review"));
        assert_eq!(a.reason.as_deref(), Some(JUDGING_STOPPED));
    }
    #[tokio::test]
    async fn a_paused_panel_is_asked_again_after_resume_without_a_new_generation() {
        let (_dir, s, backend) = setup().await;
        let run = stop_during_the_panel(&s, &backend, "pause").await;
        let id = &run.attempts[0].id;
        let waiting = s.store.attempt(id).await.unwrap();
        assert_eq!(waiting.phase, AWAITING_JUDGES);
        assert_eq!(waiting.outcome.as_deref(), Some("pending_review"));
        assert!(waiting.output.is_some());
        // While paused nothing is asked and the run never completes.
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "paused");
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        s.control(&run.id, "resume").await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(backend.judges.load(Ordering::SeqCst), 2);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        let judged = s.store.attempt(id).await.unwrap();
        assert_eq!(judged.phase, "terminal");
        assert!(judged.reason.is_none());
        s.tick().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn a_cancel_settles_a_rendering_that_waits_for_its_panel() {
        let (_dir, s, backend) = setup().await;
        let run = stop_during_the_panel(&s, &backend, "pause").await;
        s.tick().await.unwrap();
        s.control(&run.id, "cancel").await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "cancelled");
        let a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        assert_eq!(a.phase, "terminal");
        assert_eq!(a.outcome.as_deref(), Some("pending_review"));
        assert_eq!(a.reason.as_deref(), Some(JUDGING_STOPPED));
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn busy_judges_hold_the_run_open_until_the_panel_is_asked() {
        let (_dir, s, backend) = setup().await;
        backend.busy_judges.store(true, Ordering::SeqCst);
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        let id = &run.attempts[0].id;
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        assert_eq!(s.store.attempt(id).await.unwrap().phase, AWAITING_JUDGES);
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "running");
        backend.busy_judges.store(false, Ordering::SeqCst);
        s.tick().await.unwrap();
        let judged = s.store.attempt(id).await.unwrap();
        assert_eq!(judged.phase, "terminal");
        assert!(judged.reason.is_none());
        s.tick().await.unwrap();
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "completed");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    }
    /// Rewrites a creative run's first attempt as a killed process left it:
    /// mid-panel with a render marker and an in-flight judge turn, or sealed
    /// but not yet evaluated. Then the app restarts.
    async fn restart_during_the_first_panel(
        s: &Arc<BenchmarkService>,
        backend: &FakeBackend,
        evaluated: bool,
    ) -> String {
        let run = s.start_run(creative_request(s).await).await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        a.phase = "collecting".into();
        if evaluated {
            let mut marker = judge_abstention(
                &s.store.version(&a.version_id).await.unwrap(),
                &judge_row("sonnet"),
                "batch",
                String::new(),
            );
            marker.provenance = "render".into();
            marker.verdict = "rendered".into();
            marker.judge = None;
            marker.details = Some(json!({"judgeBatchId": "batch", "expectedJudges": 2,
                "protocol": {"panel": [judge_row("sonnet"), judge_row("haiku")]}}));
            let mut placeholder = marker.clone();
            placeholder.id = "in-flight".into();
            placeholder.provenance = "judge_failure".into();
            placeholder.verdict = "abstained".into();
            placeholder.judge = Some(judge_row("sonnet"));
            placeholder.details = Some(json!({"judgeBatchId": "batch", "sessionId": "session",
                "requestKey": "key", "usageComplete": false, "inFlight": true}));
            a.evaluations.extend([marker, placeholder]);
            assert_eq!(a.outcome.as_deref(), Some("pending_review"));
        } else {
            a.outcome = Some("completed".into());
            a.evaluations.clear();
        }
        s.store.save_attempt(&a).await.unwrap();
        s.store.recover().await.unwrap();
        s.reconcile_judges().await.unwrap();
        s.tick().await.unwrap();
        a.id
    }
    #[tokio::test]
    async fn a_restart_during_the_first_panel_waits_for_resume_without_a_new_generation() {
        for evaluated in [true, false] {
            let (_dir, s, backend) = setup().await;
            let id = restart_during_the_first_panel(&s, &backend, evaluated).await;
            let waiting = s.store.attempt(&id).await.unwrap();
            assert_eq!(waiting.phase, AWAITING_JUDGES, "{evaluated}");
            assert_eq!(waiting.reason.as_deref(), Some(JUDGING_STOPPED));
            assert_eq!(waiting.outcome.as_deref(), Some("pending_review"));
            let run = s.store.run(&waiting.run_id).await.unwrap();
            assert_eq!(run.state, "needs_attention");
            // Nothing is asked until the operator resumes.
            s.tick().await.unwrap();
            assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
            s.control(&run.id, "resume").await.unwrap();
            s.tick().await.unwrap();
            assert_eq!(backend.judges.load(Ordering::SeqCst), 2, "{evaluated}");
            assert_eq!(backend.calls.load(Ordering::SeqCst), 1, "{evaluated}");
            let judged = s.store.attempt(&id).await.unwrap();
            assert_eq!(judged.phase, "terminal");
            assert!(judged.reason.is_none());
        }
    }
    #[tokio::test]
    async fn a_restart_while_cancelling_settles_the_rendering() {
        let (_dir, s, backend) = setup().await;
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        a.phase = "collecting".into();
        s.store.save_attempt(&a).await.unwrap();
        s.store.set_run_state(&run.id, "cancelled").await.unwrap();
        s.store.recover().await.unwrap();
        s.tick().await.unwrap();
        let settled = s.store.attempt(&a.id).await.unwrap();
        assert_eq!(settled.phase, "terminal");
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn a_restart_inside_a_completed_run_settles_the_rendering() {
        let (_dir, s, backend) = setup().await;
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        // A failed final save left the rendering mid-panel; the run completed anyway.
        let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        a.phase = "collecting".into();
        s.store.save_attempt(&a).await.unwrap();
        s.store.set_run_state(&run.id, "completed").await.unwrap();
        s.store.recover().await.unwrap();
        s.tick().await.unwrap();
        // Nothing resumes a completed run, so the rendering never waits for a panel.
        let settled = s.store.attempt(&a.id).await.unwrap();
        assert_eq!(settled.phase, "terminal");
        assert_eq!(settled.outcome.as_deref(), Some("pending_review"));
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "completed");
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn a_resumed_panel_whose_votes_all_landed_asks_no_judge() {
        let (_dir, s, backend) = setup().await;
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        // Each vote was saved as it landed, but the process stopped before the
        // attempt's final save.
        let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        a.evaluations.extend(settled_batch());
        a.phase = AWAITING_JUDGES.into();
        a.reason = None;
        s.store.save_attempt(&a).await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        let settled = s.store.attempt(&a.id).await.unwrap();
        assert_eq!(settled.phase, "terminal");
        assert!(settled.reason.is_none());
        assert_eq!(super::super::analysis::score(&settled), Some(0.7));
        assert_eq!(
            s.store.stored_outcome(&a.id).await.unwrap().as_deref(),
            Some("judged")
        );
    }
    #[tokio::test]
    async fn a_recovered_rendering_its_candidate_authored_asks_no_judge() {
        let (_dir, s, backend) = setup().await;
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        // A plan saved before authored cells were left out generated one, and
        // a restart cut off its panel.
        let mut authored = creative();
        authored.name.push_str(" written by the candidate");
        authored.environment["authoredBy"] = json!(["fake-pass"]);
        let written = publish(&s, authored).await;
        let mut legacy = s.store.attempt(&run.attempts[0].id).await.unwrap();
        legacy.id = "legacy-authored".into();
        legacy.version_id = written.id.clone();
        legacy.phase = "collecting".into();
        assert_eq!(legacy.outcome.as_deref(), Some("pending_review"));
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,0,'collecting',?)")
            .bind(&legacy.id).bind(&run.id).bind(&written.id).bind(&legacy.configuration.id)
            .bind(serde_json::to_string(&legacy).unwrap())
            .execute(&s.store.pool).await.unwrap();
        s.store.recover().await.unwrap();
        s.tick().await.unwrap();
        s.control(&run.id, "resume").await.unwrap();
        for _ in 0..3 {
            s.tick().await.unwrap();
        }
        assert_eq!(s.store.run(&run.id).await.unwrap().state, "completed");
        let excluded = s.store.attempt("legacy-authored").await.unwrap();
        assert_eq!(excluded.phase, "terminal");
        assert_eq!(excluded.outcome.as_deref(), Some("excluded"));
        assert_eq!(
            excluded.reason.as_deref(),
            Some("authored by this candidate")
        );
        // The paid generation stays on record; no judge was asked.
        assert!(excluded.output.is_some());
        assert_eq!(backend.judges.load(Ordering::SeqCst), 1);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn a_panel_that_fails_before_saving_keeps_the_objective_verdict() {
        let (_dir, s, backend) = setup().await;
        backend.fail_judges.store(true, Ordering::SeqCst);
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        assert_eq!(a.phase, "terminal");
        assert_eq!(a.outcome.as_deref(), Some("pending_review"));
        assert!(a
            .evaluations
            .iter()
            .any(|e| e.provenance == "objective" && e.verdict == "pending_review"));
        assert!(a.reason.as_deref().unwrap().starts_with("Judging failed:"));
    }
    /// A scripted panel: `answers[i]` is judge `i`'s answer.
    struct ScriptedPanel {
        answers: Vec<JudgeAnswer>,
        asked: Vec<usize>,
        halt_after: Option<usize>,
    }
    impl PanelJudges for ScriptedPanel {
        fn halted(&mut self) -> BoxFuture<'_, Result<bool>> {
            let halted = self.halt_after.is_some_and(|n| self.asked.len() >= n);
            Box::pin(async move { Ok(halted) })
        }
        fn ask<'s>(
            &'s mut self,
            index: usize,
            _: &'s Configuration,
        ) -> BoxFuture<'s, Result<JudgeAnswer>> {
            self.asked.push(index);
            let answer = self.answers[index];
            Box::pin(async move { Ok(answer) })
        }
    }
    #[tokio::test]
    async fn a_panel_stops_paying_once_its_batch_cannot_settle() {
        use JudgeAnswer::{Busy, NoVote, Vote};
        let judges: Vec<(usize, Configuration)> = ["opus[1m]", "haiku", "claude-opus-4-8"]
            .into_iter()
            .map(judge_row)
            .enumerate()
            .collect();
        let run = |answers: Vec<JudgeAnswer>, halt_after: Option<usize>, votes: usize| {
            let judges = judges.clone();
            async move {
                let mut panel = ScriptedPanel {
                    answers,
                    asked: Vec::new(),
                    halt_after,
                };
                // Every judge asked before a stop cast a valid vote.
                let end = ask_panel(&judges[votes..], 3, votes, &mut panel)
                    .await
                    .unwrap();
                (end, panel.asked)
            }
        };
        // The first abstention ends the batch: nobody else is asked.
        assert_eq!(
            run(vec![NoVote, Vote, Vote], None, 0).await,
            ((PanelEnd::Incomplete, 0), vec![0])
        );
        assert_eq!(
            run(vec![Vote, NoVote, Vote], None, 0).await,
            ((PanelEnd::Incomplete, 1), vec![0, 1])
        );
        assert_eq!(
            run(vec![Vote, Vote, Vote], None, 0).await,
            ((PanelEnd::Asked, 3), vec![0, 1, 2])
        );
        // A stop leaves the rest for the run; a resumed batch asks only them.
        assert_eq!(
            run(vec![Vote, Vote, Vote], Some(1), 0).await,
            ((PanelEnd::Stopped, 1), vec![0])
        );
        assert_eq!(
            run(vec![Vote, Vote, Vote], None, 1).await,
            ((PanelEnd::Asked, 3), vec![1, 2])
        );
        // A judge whose account turned busy ends the pass without an answer.
        assert_eq!(
            run(vec![Vote, Busy, Vote], None, 0).await,
            ((PanelEnd::Busy, 1), vec![0, 1])
        );
    }
    #[test]
    fn a_judge_that_turns_busy_defers_the_batch_to_its_run() {
        assert_eq!(panel_reason(PanelEnd::Busy, 1, 3, false), Some(JUDGES_BUSY));
        assert_eq!(
            panel_reason(PanelEnd::Busy, 1, 3, true),
            Some(JUDGING_STOPPED)
        );
        assert_eq!(
            panel_reason(PanelEnd::Stopped, 1, 3, false),
            Some(JUDGING_STOPPED)
        );
        assert_eq!(
            panel_reason(PanelEnd::Incomplete, 1, 3, false),
            Some(PANEL_INCOMPLETE)
        );
        assert_eq!(panel_reason(PanelEnd::Asked, 3, 3, false), None);
        // The run keeps such an attempt waiting for its panel.
        let reason = |end: PanelEnd| {
            let mut attempt: Attempt = serde_json::from_value(json!({
                "id": "a", "runId": "r", "versionId": "v", "repetition": 0,
                "phase": "collecting", "configuration": judge_row("sonnet"),
                "usage": TokenUsage::default(), "evaluations": [], "eventCursor": 0
            }))
            .unwrap();
            attempt.reason = panel_reason(end, 1, 3, false).map(str::to_owned);
            judging_deferred(&attempt)
        };
        assert!(reason(PanelEnd::Busy));
        assert!(!reason(PanelEnd::Incomplete));
    }
    #[test]
    fn only_a_stopped_batch_of_valid_votes_is_continued() {
        let panel: Vec<Configuration> = ["opus[1m]", "haiku", "claude-opus-4-8"]
            .into_iter()
            .map(judge_row)
            .collect();
        let evaluation =
            |provenance: &str, judge: Option<&Configuration>, score: Option<f64>| Evaluation {
                id: uuid::Uuid::new_v4().to_string(),
                evaluator_revision: "1".into(),
                verdict: "v".into(),
                score,
                reason: String::new(),
                created_at: 1,
                provenance: provenance.into(),
                artifacts: Vec::new(),
                details: None,
                judge: judge.cloned(),
                usage: None,
            };
        let mut marker = evaluation("render", None, None);
        marker.artifacts.push(Artifact {
            kind: "screenshot".into(),
            path: "rendering.png".into(),
            hash: "h".into(),
            label: "Rendering".into(),
        });
        marker.details = Some(json!({"judgeBatchId": "batch", "expectedJudges": 3,
            "protocol": {"panel": panel, "expectedJudges": 3}}));
        let mut evaluations = vec![
            evaluation("objective", None, None),
            marker,
            evaluation("judge", Some(&panel[0]), Some(0.7)),
        ];
        let open = open_batch(&evaluations).unwrap();
        assert_eq!((open.id.as_str(), open.expected), ("batch", 3));
        assert_eq!(open.asked, vec![panel[0].clone()]);
        assert_eq!(open.rendering, "rendering.png");
        // An abstention can never settle the batch; a full batch is done.
        evaluations.push(evaluation("judge_failure", Some(&panel[1]), None));
        assert!(open_batch(&evaluations).is_none());
        evaluations.pop();
        evaluations.push(evaluation("judge", Some(&panel[1]), Some(0.6)));
        evaluations.push(evaluation("judge", Some(&panel[2]), Some(0.5)));
        assert!(open_batch(&evaluations).is_none());
        assert!(open_batch(&evaluations[..1]).is_none());
    }
    #[tokio::test]
    async fn evaluating_again_keeps_budget_failures_exclusions_and_human_overrides() {
        let (_dir, s, backend) = setup().await;
        let mut req = request(&s).await;
        req.repetitions = 1;
        req.max_executions = 1;
        let run = s.start_run(req).await.unwrap();
        s.tick().await.unwrap();
        let id = run.attempts[0].id.clone();
        assert_eq!(
            s.store.attempt(&id).await.unwrap().outcome.as_deref(),
            Some("pass")
        );
        // The output still holds a passing answer; the recorded outcome stands.
        for outcome in [
            "budget_timeout",
            "budget_reached",
            "cancelled",
            "selection_changed",
            "excluded",
        ] {
            let mut a = s.store.attempt(&id).await.unwrap();
            a.outcome = Some(outcome.into());
            a.evaluations.clear();
            s.store.save_attempt(&a).await.unwrap();
            assert_eq!(s.rescore(&id).await.unwrap_err().code, "validation");
            let kept = s.store.attempt(&id).await.unwrap();
            assert_eq!(kept.outcome.as_deref(), Some(outcome));
            assert!(kept.evaluations.is_empty());
        }
        // A human review overrides the panel, so no judge is asked again.
        let creative = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        s.tick().await.unwrap();
        let reviewed = s
            .review(&creative.attempts[0].id, 0.8, "Override".into(), None)
            .await
            .unwrap();
        let asked = backend.judges.load(Ordering::SeqCst);
        assert_eq!(asked, 1);
        assert_eq!(
            s.rescore(&reviewed.id).await.unwrap_err().code,
            "validation"
        );
        assert_eq!(backend.judges.load(Ordering::SeqCst), asked);
        // A human override cannot turn a timeout into a verdict either: the
        // turn failed its task, and that stands.
        let mut timed_out = s.store.attempt(&creative.attempts[0].id).await.unwrap();
        timed_out.outcome = Some("budget_timeout".into());
        timed_out.evaluations.clear();
        s.store.save_attempt(&timed_out).await.unwrap();
        let refused = s
            .review(&timed_out.id, 1.0, "Override".into(), None)
            .await
            .unwrap_err();
        assert_eq!(refused.message, "Only an evaluated result can be reviewed");
        let kept = s.store.attempt(&timed_out.id).await.unwrap();
        assert_eq!(kept.outcome.as_deref(), Some("budget_timeout"));
        assert_eq!(super::super::analysis::score(&kept), Some(0.0));
    }
    #[tokio::test]
    async fn evaluating_again_persists_the_new_verdict_of_a_finished_attempt() {
        let (_dir, s, _) = setup().await;
        let mut req = request(&s).await;
        req.repetitions = 1;
        req.max_executions = 1;
        let run = s.start_run(req).await.unwrap();
        let id = run.attempts[0].id.clone();
        let waiting = s.rescore(&id).await.unwrap_err();
        assert_eq!(waiting.code, "validation");
        assert_eq!(waiting.message, "Only a finished attempt can be rescored");
        s.tick().await.unwrap();
        // An evaluator failure on a passing answer, evaluated again.
        let mut a = s.store.attempt(&id).await.unwrap();
        a.outcome = Some("evaluation_error".into());
        a.evaluations.clear();
        s.store.save_attempt(&a).await.unwrap();
        let rescored = s.rescore(&id).await.unwrap();
        assert_eq!(rescored.outcome.as_deref(), Some("pass"));
        // The raw record, not only its normalized reading, holds the verdict.
        assert_eq!(
            s.store.stored_outcome(&id).await.unwrap().as_deref(),
            Some("pass")
        );
        let stored = s.store.attempt(&id).await.unwrap();
        assert_eq!(stored.evaluations.len(), 1);
        assert_eq!(super::super::analysis::score(&stored), Some(1.0));
    }
    #[tokio::test]
    async fn a_panel_on_one_attempt_never_blocks_a_review_of_another() {
        let (_dir, s, _) = setup().await;
        let mut req = creative_request(&s).await;
        req.repetitions = 2;
        req.max_executions = 8;
        let run = s.start_run(req).await.unwrap();
        s.tick().await.unwrap();
        s.tick().await.unwrap();
        let (first, second) = (&run.attempts[0].id, &run.attempts[1].id);
        let panel = super::super::evaluation_lock(first);
        let _held = panel.lock().await;
        let review = s.review(second, 0.5, "Reviewed meanwhile".into(), None);
        let reviewed = tokio::time::timeout(Duration::from_secs(5), review).await;
        assert!(reviewed.expect("review waited on another panel").is_ok());
        let busy = s.rescore(first).await.unwrap_err();
        assert_eq!(busy.message, "This attempt is already being evaluated");
    }
    /// A render marker for two judges and their valid votes, 0.6 and 0.8.
    fn settled_batch() -> [Evaluation; 3] {
        let vote = |id: &str, score: f64| Evaluation {
            id: id.into(),
            evaluator_revision: "1".into(),
            verdict: if id == "render" { "rendered" } else { "judged" }.into(),
            score: (id != "render").then_some(score),
            reason: "recorded".into(),
            created_at: now(),
            provenance: if id == "render" { "render" } else { "judge" }.into(),
            artifacts: Vec::new(),
            details: (id == "render").then(|| json!({"expectedJudges": 2})),
            judge: (id != "render").then(|| judge_row("sonnet")),
            usage: None,
        };
        [vote("render", 0.0), vote("first", 0.6), vote("second", 0.8)]
    }
    #[tokio::test]
    async fn evaluating_again_without_a_panel_keeps_the_settled_score() {
        let (_dir, s, backend) = setup().await;
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        a.evaluations.extend(settled_batch());
        a.outcome = Some("judged".into());
        s.store.save_attempt(&a).await.unwrap();
        let before = s.store.attempt(&a.id).await.unwrap();
        assert_eq!(super::super::analysis::score(&before), Some(0.7));
        // The fake panel starts no batch, so nothing may be written.
        let refused = s.rescore(&a.id).await.unwrap_err();
        assert_eq!(refused.code, "validation");
        assert_eq!(backend.judges.load(Ordering::SeqCst), 2);
        let after = s.store.attempt(&a.id).await.unwrap();
        assert_eq!(after.evaluations.len(), before.evaluations.len());
        assert_eq!(super::super::analysis::score(&after), Some(0.7));
    }
    #[tokio::test]
    async fn an_answer_without_markup_fails_and_asks_no_judge() {
        let (_dir, s, backend) = setup().await;
        let mut req = creative_request(&s).await;
        req.configurations[0].id = "fake-fail".into();
        req.configurations[0].model_id = "fake-fail".into();
        let run = s.start_run(req).await.unwrap();
        s.tick().await.unwrap();
        let a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        assert_eq!(a.output.as_deref(), Some("I cannot draw."));
        assert_eq!(a.outcome.as_deref(), Some("fail"));
        assert_eq!(super::super::analysis::score(&a), Some(0.0));
        assert_eq!(backend.judges.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn judge_turns_cut_off_by_a_restart_are_settled_and_never_vote() {
        let (_dir, s, _) = setup().await;
        let run = s.start_run(creative_request(&s).await).await.unwrap();
        s.tick().await.unwrap();
        let mut a = s.store.attempt(&run.attempts[0].id).await.unwrap();
        a.evaluations.push(Evaluation {
            id: "in-flight".into(),
            evaluator_revision: "1".into(),
            verdict: "abstained".into(),
            score: None,
            reason: "Judge turn in flight".into(),
            created_at: now(),
            provenance: "judge_failure".into(),
            artifacts: Vec::new(),
            details: Some(json!({"judgeBatchId": "batch", "sessionId": "session",
                "requestKey": "key", "usageComplete": false, "inFlight": true})),
            judge: Some(judge_row("sonnet")),
            usage: None,
        });
        s.store.save_attempt(&a).await.unwrap();
        s.reconcile_judges().await.unwrap();
        let a = s.store.attempt(&a.id).await.unwrap();
        let settled = a.evaluations.iter().find(|e| e.id == "in-flight").unwrap();
        assert!(!in_flight(settled));
        assert!(settled.reason.contains("restart"));
        assert!(settled.score.is_none());
        let left: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM attempts a,json_each(a.data_json,'$.evaluations') e
             WHERE json_extract(e.value,'$.details.inFlight')=1",
        )
        .fetch_one(&s.store.pool)
        .await
        .unwrap();
        assert_eq!(left, 0);
    }
}
