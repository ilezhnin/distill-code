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
/// The error code of a turn the host refused before any provider call because
/// every eligible account waits for quota.
const QUOTA_WAIT: &str = "account_quota_wait";
/// How long a run waits when the host names no quota reset.
const QUOTA_RETRY_MS: i64 = 5 * 60 * 1000;

/// Runs whose account waits for quota, with the time to try again. Kept in
/// memory: after a restart the next dispatch asks the host again, at no cost.
static QUOTA_HOLDS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, i64>>> =
    std::sync::LazyLock::new(Default::default);

/// Whether a host error is a quota wait that never reached the provider.
fn is_quota_wait(error: &Value) -> bool {
    let data = error.get("data").unwrap_or(error);
    (data["kind"] == QUOTA_WAIT || data["type"] == QUOTA_WAIT)
        && data["dispatchStarted"] == Value::Bool(false)
}

/// Holds a run until the quota reset the host named, or a short retry.
fn hold_for_quota(run_id: &str, error: &str) {
    let reset = serde_json::from_str::<Value>(error)
        .ok()
        .and_then(|e| e.pointer("/data/nextReset").and_then(Value::as_i64));
    let until = reset
        .filter(|at| *at > now())
        .unwrap_or_else(|| now() + QUOTA_RETRY_MS);
    QUOTA_HOLDS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(run_id.to_owned(), until);
}

fn held_for_quota(run_id: &str) -> bool {
    let mut holds = QUOTA_HOLDS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match holds.get(run_id) {
        Some(until) if *until > now() => true,
        Some(_) => {
            holds.remove(run_id);
            false
        }
        None => false,
    }
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

impl NativeBackend {
    /// The panel for one rendering from every enabled account's available models.
    async fn judge_panel(
        &self,
        attempt: &Attempt,
        draft: &BenchmarkDraft,
    ) -> Result<Vec<Configuration>> {
        let snapshot =
            crate::services::provider_accounts::snapshot(&self.app).map_err(host_error)?;
        let mut offered = Vec::new();
        for account in snapshot.accounts.iter().filter(|account| account.enabled) {
            let Ok(models) = self
                .inventory(&account.provider_id, Some(&account.id), false)
                .await
            else {
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
        let session = host
            .create_owned_session(OwnedSessionRequest {
                owner_id: format!("{}:judge:{batch}:{index}", attempt.id),
                provider_id: judge.provider_id.clone(),
                account_id: account,
                model_id: judge.model_id.clone(),
                reasoning_effort: judge.effort.clone(),
                fast_mode: judge.fast_mode,
                cwd: cwd.to_string_lossy().into_owned(),
                title: format!("Benchmark judge: {}", version.manifest.name),
                profile: ExecutionProfile::NativeTextV1,
            })
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
        let timeout = Duration::from_secs(180);
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
        if c.provider_id != "claude-acp" || c.account_id.as_deref().is_none_or(str::is_empty) {
            return Some(
                "This provider/account has no verified native text execution policy".into(),
            );
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
                BenchmarkError::new("capability_missing", "Choose a managed account")
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
            let billing = crate::services::provider_accounts::account(&self.app, account)
                .map_err(host_error)?
                .auth_method;
            let revision = Some(inventory_fingerprint(&result).await?);
            let unavailable = if provider != "claude-acp" {
                Some("Native execution restrictions have not been verified".to_string())
            } else {
                result
                    .pointer("/executable/path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Native executable provenance is missing".to_string())
                    .and_then(|path| validate_native_runtime(std::path::Path::new(path)))
                    .err()
            };
            Ok(result["models"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|row| {
                    let id = row
                        .get("modelId")
                        .or_else(|| row.get("id"))
                        .and_then(Value::as_str)?;
                    let efforts = row
                        .get("reasoningEfforts")
                        .or_else(|| row.get("efforts"))
                        .and_then(Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(|v| {
                                    v.as_str()
                                        .or_else(|| v["value"].as_str())
                                        .map(str::to_owned)
                                })
                                .collect()
                        })
                        .unwrap_or_default();
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
                            inventory_revision: revision.clone(),
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
                BenchmarkError::new("capability_missing", "Managed account is required")
            })?;
            let inventory = host
                .benchmark_inventory(&attempt.configuration.provider_id, &account, true)
                .await
                .map_err(host_error)?;
            let runtime_revision = inventory_fingerprint(&inventory).await?;
            if attempt
                .configuration
                .inventory_revision
                .as_ref()
                .is_some_and(|revision| revision != &runtime_revision)
            {
                return Err(BenchmarkError::new("selection_changed","Installed runtime or model capabilities changed since configuration selection; refresh inventory"));
            }
            let activity = host
                .account_activity(&attempt.configuration.provider_id, &account)
                .await
                .map_err(host_error)?;
            if !activity.active_sessions.is_empty() {
                return Err(BenchmarkError::new(
                    "account_busy",
                    "Interactive work has priority; account is active",
                ));
            }
            let cwd = store
                .root
                .join("runs")
                .join(&attempt.run_id)
                .join(&attempt.id)
                .join("workspace");
            tokio::fs::create_dir_all(&cwd).await?;
            let session = host
                .create_owned_session(OwnedSessionRequest {
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
                })
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
            let timeout_seconds = effective_timeout_seconds(timeout, &version.manifest);
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
            let mut output_capped = false;
            let mut evidence = Vec::new();
            let mut evidence_bytes = 0usize;
            let mut output = String::new();
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
                    consume_event(&event.payload, &mut output, &mut attempt.usage);
                    let bytes = serde_json::to_vec(&event.payload)?.len();
                    evidence_bytes = evidence_bytes.saturating_add(bytes);
                    if evidence_bytes <= version.manifest.limits.max_artifact_bytes as usize {
                        evidence.push(event.payload);
                    } else {
                        output_capped = true;
                    }
                }
                attempt.event_cursor = page.cursor;
                if output.len() > version.manifest.limits.max_artifact_bytes as usize {
                    output_capped = true;
                    let mut end = version.manifest.limits.max_artifact_bytes as usize;
                    while !output.is_char_boundary(end) {
                        end -= 1;
                    }
                    output.truncate(end);
                }
                if output_capped && !cancelled {
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
                    if let Some(error) = status.error.as_ref().filter(|e| is_quota_wait(e)) {
                        return Err(BenchmarkError::new(QUOTA_WAIT, error.to_string()));
                    }
                    evidence.push(json!({"terminalDispatch":status}));
                    if let Some(result) = status.result.as_ref() {
                        consume_terminal_result(result, &mut attempt);
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
                    if output_capped {
                        attempt.outcome = Some("budget_reached".into());
                        attempt.reason=Some("Output/evidence exceeded the published artifact cap; cancellation acknowledged".into());
                    } else if let Some(error) = status.error {
                        attempt.outcome = Some(terminal_error_outcome(&error).into());
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
            attempt.output = Some(output);
            attempt.duration_ms = Some(started.elapsed().as_millis() as u64);
            attempt.finished_at = Some(now());
            attempt.phase = "collecting".into();
            mark_auxiliary_profile(&mut attempt);
            attempt.evidence_hash =
                Some(fixtures::seal(&store.root, &attempt, &json!(evidence)).await?);
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
            let mut output = String::new();
            let mut evidence = Vec::new();
            loop {
                let page = host
                    .read_owned_events(&status.session_id, attempt.event_cursor, 200)
                    .await
                    .map_err(host_error)?;
                for event in page.events {
                    consume_event(&event.payload, &mut output, &mut attempt.usage);
                    evidence.push(event.payload);
                }
                attempt.event_cursor = page.cursor;
                if output.len() > 16 * 1024 * 1024 {
                    return Err(BenchmarkError::new(
                        "budget_reached",
                        "Recovered evidence exceeds artifact cap",
                    ));
                }
                if !page.has_more && attempt.event_cursor >= status.event_cursor {
                    break;
                }
            }
            if let Some(result) = status.result.as_ref() {
                consume_terminal_result(result, &mut attempt);
            }
            evidence.push(json!({"terminalDispatch":status}));
            attempt.output = Some(output);
            attempt.finished_at = Some(now());
            attempt.outcome = Some(
                status
                    .error
                    .as_ref()
                    .map(terminal_error_outcome)
                    .unwrap_or("completed")
                    .into(),
            );
            attempt.reason = status.error.map(|v| v.to_string());
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
            mark_auxiliary_profile(&mut attempt);
            attempt.evidence_hash =
                Some(fixtures::seal(&store.root, &attempt, &json!(evidence)).await?);
            Ok(Some(attempt))
        })
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
    mark_auxiliary_profile(attempt);
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
    if let Some(v) = data["cachedReadTokens"].as_u64() {
        usage.cache_read = Some(v);
    }
    if let Some(v) = data["cachedWriteTokens"]
        .as_u64()
        .or_else(|| data["cacheCreationTokens"].as_u64())
    {
        usage.cache_write = Some(v);
    }
    // Native Claude reasoning is included in output; synthetic zero in quota metadata is not a separate measurement.
    usage.schema = "provider_turn_usage_v1".into();
}
async fn inventory_fingerprint(inventory: &Value) -> Result<String> {
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
fn effective_timeout_seconds(requested: u32, draft: &BenchmarkDraft) -> u32 {
    requested.min(draft.limits.timeout_seconds).min(
        draft
            .entry_state
            .as_ref()
            .map_or(u32::MAX, |entry| entry.remaining_budget_seconds),
    )
}

fn terminal_error_outcome(error: &Value) -> &'static str {
    match error["kind"]
        .as_str()
        .or_else(|| error.pointer("/data/kind").and_then(Value::as_str))
    {
        Some("budget_timeout") => "budget_timeout",
        Some("cancelled") => "cancelled",
        Some("selection_changed") => "selection_changed",
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
    async fn tick(&self) -> Result<()> {
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
                    a.reason=Some("Remote acceptance cannot be established after restart; explicitly create a new run to retry".into());
                    a.finished_at = Some(now());
                    self.store.save_attempt(&a).await?;
                    self.changed().await;
                }
            }
        }
        super::campaigns::tick(self).await?;
        for run in self.store.active_runs().await? {
            if run.state == "pausing" {
                self.store.set_run_state(&run.id, "paused").await?;
                self.changed().await;
                continue;
            }
            if run.state == "cancelling" {
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
            if run.state != "running" || held_for_quota(&run.id) {
                continue;
            }
            // A rendering a pause or busy judges held back is judged before any
            // new generation; the run completes only once none is waiting.
            let mut judges_busy = false;
            if let Some(waiting) = run.attempts.iter().find(|a| a.phase == AWAITING_JUDGES) {
                judges_busy = self.resume_judging(&run, &waiting.id).await?;
                if !judges_busy {
                    self.changed().await;
                    break;
                }
            }
            let Some((mut a, version)) = self.next_dispatchable(&run).await? else {
                if !judges_busy {
                    self.finish_measurement(&run).await?;
                    self.store.set_run_state(&run.id, "completed").await?;
                    self.changed().await;
                }
                continue;
            };
            fixtures::verify_blob(&self.store.root, &version.content_hash, &version.manifest)
                .await?;
            if version.manifest.measurement_profile != "task_metrics"
                && !self.begin_measurement(&run).await?
            {
                continue;
            }
            // Judges run only where the saved plan reserved their calls; known
            // before the paid turn.
            let judge_budget = self.judge_budget(&run, &version).await;
            a.phase = "preparing".into();
            a.started_at = Some(now());
            self.store.save_attempt(&a).await?;
            let (cancel_tx, cancel_rx) = watch::channel(false);
            *self.active.lock().await = Some((run.id.clone(), cancel_tx));
            if self.store.run_state(&run.id).await? != "running" {
                a.phase = "pending".into();
                a.started_at = None;
                self.store.save_attempt(&a).await?;
                *self.active.lock().await = None;
                continue;
            }
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
            *self.active.lock().await = None;
            match result {
                Ok(mut completed) => {
                    completed.phase = self.settled_phase(&run, &completed).await?.into();
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
                    // holds the run until the reset, and a model the provider
                    // refused to select waits for the operator.
                    let refused = error.code == "selection_changed" && failed.phase == "preparing";
                    if error.code == QUOTA_WAIT || refused {
                        failed.phase = "pending".into();
                        failed.started_at = None;
                        failed.session_id = None;
                        failed.host_run_id = None;
                        failed.observed = None;
                        failed.event_cursor = 0;
                        failed.usage = TokenUsage::default();
                        failed.reason = Some(error.message.clone());
                        self.store.save_attempt(&failed).await?;
                        if refused {
                            self.store.set_run_state(&run.id, "needs_attention").await?;
                        } else {
                            hold_for_quota(&run.id, &error.message);
                        }
                        self.changed().await;
                        return Ok(());
                    }
                    failed.phase = "terminal".into();
                    failed.outcome = Some(error.code.clone());
                    failed.reason = Some(error.message);
                    failed.finished_at = Some(now());
                    self.store.save_attempt(&failed).await?;
                    if ["dispatch_uncertain", "storage_unavailable"].contains(&error.code.as_str())
                    {
                        self.store.set_run_state(&run.id, "needs_attention").await?;
                    }
                }
            }
            self.changed().await;
            break;
        }
        Ok(())
    }
    /// The next pending attempt to dispatch. A pending cell whose candidate
    /// authored the case settles as excluded here, without any model call.
    async fn next_dispatchable(
        &self,
        run: &BenchmarkRun,
    ) -> Result<Option<(Attempt, BenchmarkVersion)>> {
        let mut versions: std::collections::HashMap<String, BenchmarkVersion> =
            std::collections::HashMap::new();
        for pending in run.attempts.iter().filter(|a| a.phase == "pending") {
            if !versions.contains_key(&pending.version_id) {
                let version = self.store.version(&pending.version_id).await?;
                versions.insert(pending.version_id.clone(), version);
            }
            let version = &versions[&pending.version_id];
            if !super::routing::authored_by_candidate(&version.manifest, &pending.configuration) {
                return Ok(Some((pending.clone(), version.clone())));
            }
            let mut excluded = pending.clone();
            excluded.phase = "terminal".into();
            excluded.outcome = Some("excluded".into());
            excluded.reason = Some("authored by this candidate".into());
            excluded.finished_at = Some(now());
            self.store.save_attempt(&excluded).await?;
            self.changed().await;
        }
        Ok(None)
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
    /// Asks the panel of one rendering a pause or busy judges held back. True
    /// when the panel is still held back by busy judges.
    async fn resume_judging(&self, run: &BenchmarkRun, id: &str) -> Result<bool> {
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
            return Ok(false);
        }
        // Every vote of the batch landed before the final save: the panel
        // already settled it, and only an explicit evaluation asks again.
        if super::analysis::score(&waiting).is_some() {
            if settled.outcome.as_deref() == Some("pending_review") {
                settled.outcome = Some("judged".into());
            }
            settled.reason = None;
            self.store.save_attempt(&settled).await?;
            return Ok(false);
        }
        let judge_budget = self.judge_budget(run, &version).await;
        let (cancel_tx, cancel_rx) = watch::channel(false);
        *self.active.lock().await = Some((run.id.clone(), cancel_tx));
        let mut attempt = waiting.clone();
        attempt.reason = None;
        let stop = JudgeStop::run(&run.id, cancel_rx);
        let mut judged = self.ask_judges(attempt, &version, judge_budget, stop).await;
        *self.active.lock().await = None;
        judged.phase = self.settled_phase(run, &judged).await?.into();
        let busy = judged.phase == AWAITING_JUDGES && judged.reason.as_deref() == Some(JUDGES_BUSY);
        // A panel still waiting on busy judges records nothing new.
        if serde_json::to_value(&judged)? != serde_json::to_value(&waiting)? {
            self.store.save_attempt(&judged).await?;
        }
        Ok(busy)
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
            Ok(["fake-pass", "fake-fail"]
                .into_iter()
                .map(|id| InventoryModel {
                    configuration: Configuration {
                        id: id.into(),
                        provider_id: provider.into(),
                        account_id: account.map(str::to_owned),
                        model_id: id.into(),
                        effort: Some("default".into()),
                        fast_mode: None,
                        billing_mode: "simulated".into(),
                        execution_profile: "native_text".into(),
                        inventory_revision: Some("fake-v1".into()),
                        model_name: None,
                    },
                    name: id.into(),
                    efforts: vec!["default".into()],
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
            a.phase = "running".into();
            a.host_run_id = Some(format!("fake-{}", a.id));
            a.observed = Some(a.configuration.clone());
            store.save_attempt(&a).await?;
            tokio::select! {_=tokio::time::sleep(Duration::from_millis(300))=>{},_=cancel.changed()=>{}}
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
            Some(json!({"kind": "selection_changed",
                "message": "capability_missing: native execution violated the declared no-tool policy"})),
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
    use tokio::sync::{Mutex, Notify};
    async fn setup() -> (tempfile::TempDir, Arc<BenchmarkService>, Arc<FakeBackend>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        let backend = Arc::new(FakeBackend::default());
        let service = Arc::new(BenchmarkService {
            store,
            backend: backend.clone(),
            wake: Notify::new(),
            active: Mutex::new(None),
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
    fn continuation_timeout_is_the_smallest_frozen_budget() {
        let mut draft = seed_definitions().remove(0);
        draft.limits.timeout_seconds = 120;
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
        assert_eq!(effective_timeout_seconds(90, &draft), 5);
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
        for _ in 0..100 {
            if s.active.lock().await.is_some() {
                break;
            }
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
        QUOTA_HOLDS.lock().unwrap().remove(&run.id);
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
        let executable = directory.path().join("bridge.js");
        tokio::fs::write(&executable, "bridge").await.unwrap();
        let path = executable.to_string_lossy().into_owned();
        let before = json!({"executable":{"path":path},"models":[{"modelId":"sonnet","reasoningEfforts":[]},{"modelId":"opus","reasoningEfforts":["low"]}]});
        let learned = json!({"executable":{"path":path},"models":[{"modelId":"opus","reasoningEfforts":["low","high"],"supportsFast":true},{"modelId":"sonnet","reasoningEfforts":["low"]}]});
        let grown = json!({"executable":{"path":path},"models":[{"modelId":"sonnet"},{"modelId":"opus"},{"modelId":"haiku"}]});
        let first = inventory_fingerprint(&before).await.unwrap();
        assert_eq!(first, inventory_fingerprint(&learned).await.unwrap());
        assert_ne!(first, inventory_fingerprint(&grown).await.unwrap());
        tokio::fs::write(&executable, "updated bridge")
            .await
            .unwrap();
        assert_ne!(first, inventory_fingerprint(&before).await.unwrap());
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
        assert!(s.active.lock().await.is_some());
        s.control(&run.id, action).await.unwrap();
        backend.hold_judges.store(false, Ordering::SeqCst);
        backend.judge_release.notify_one();
        tick.await.unwrap().unwrap();
        assert_eq!(backend.stopped_judges.load(Ordering::SeqCst), 1, "{action}");
        assert!(s.active.lock().await.is_none());
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
        s: &BenchmarkService,
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
        // A human override cannot turn a budget failure into a verdict either.
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
