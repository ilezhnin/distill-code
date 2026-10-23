//! The ordinary judge pool. Which models take an ordinary rubric judge seat
//! is the owner's data, `judgePool` in the benchmark settings document, not a
//! rule in code, and an entry seats only after it passed calibration: alone,
//! it judged the accepted and rejected controls of the rubric qualification
//! records and scored every one inside its band. A frozen panel
//! (`environment.judgePanel`) names its own seats and never uses the pool.

use std::{panic::AssertUnwindSafe, path::Path};

use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    data_use::DataUse, qualification, runner, store::now, store::Store, types::*, BenchmarkService,
};
use crate::services::agent_host::execution::NativeProvider;
use crate::services::provider_account_status::Headroom;

/// The calibration recipe: a calibration counts for this recipe only.
pub(crate) const RECIPE: &str = "strong-pool-v1";
/// How an ordinary panel seats the pool's calibrated judges (owner, 10-18):
/// one per lab, a candidate's own lab and model included (see
/// `runner::ordinary_judges`). It enters the judge protocol and its hash.
pub(crate) const PANEL_RECIPE: &str = "three-lab-v1";
/// The benchmark settings document the renderer writes.
const SETTINGS: &str = "settings.json";
const CALIBRATIONS: &str = "judge-calibrations.json";
const MAX_ENTRIES: usize = 32;
/// Calibrations kept, newest first; older ones are dropped.
const KEPT: usize = 256;
/// How long one control waits for a busy judge account or renderer.
const BUSY_WAIT_MS: i64 = 30 * 60 * 1000;

/// One read-modify-write of the calibrations at a time.
static CALIBRATIONS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Calibrations this process runs. A stored running one that is not here
/// was cut off by a restart.
static RUNNING: std::sync::Mutex<Vec<(String, Entry)>> = std::sync::Mutex::new(Vec::new());

fn running() -> std::sync::MutexGuard<'static, Vec<(String, Entry)>> {
    RUNNING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A stopped or panicking task must never keep a judge's live reservation.
struct RunningCalibration(String);

impl Drop for RunningCalibration {
    fn drop(&mut self) {
        running().retain(|(id, _)| id != &self.0);
    }
}

/// A model the owner lets judge, at an effort.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub provider_id: String,
    pub model_id: String,
    /// The effort it judges at; its default when absent.
    #[serde(default)]
    pub effort: Option<String>,
    /// The rubrics it judges, `text` and `visual`; both when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Vec<String>>,
    /// The accounts it may sit on (their ids); any enabled account of its
    /// provider when absent. Steers seats off a shared login (10-18: every
    /// Claude seat landed on the owner's own Claude Code login while it
    /// neared its limit). Seating and calibration both keep to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accounts: Option<Vec<String>>,
    /// Read and ignored: whether a provider may judge is its data use
    /// (see [`super::data_use`]), one rule for judges and candidates. Kept
    /// so pools written before that still read.
    #[serde(default)]
    pub disclosure_confirmed: bool,
}

impl Entry {
    fn valid(&self) -> bool {
        let bounded = |value: &str, limit: usize| {
            !value.is_empty() && value.trim() == value && value.len() <= limit
        };
        bounded(&self.provider_id, 128)
            && bounded(&self.model_id, 256)
            && self
                .effort
                .as_deref()
                .is_none_or(|effort| bounded(effort, 64))
            && self.inputs.as_ref().is_none_or(|inputs| {
                !inputs.is_empty()
                    && inputs
                        .iter()
                        .all(|input| input == "text" || input == "visual")
            })
            && self.accounts.as_ref().is_none_or(|accounts| {
                !accounts.is_empty()
                    && accounts.len() <= 16
                    && accounts.iter().all(|account| bounded(account, 128))
            })
    }

    /// Whether it may sit on `account` (see [`Self::accounts`]).
    pub fn sits_on(&self, account: Option<&str>) -> bool {
        self.accounts.as_ref().is_none_or(|accounts| {
            account.is_some_and(|account| accounts.iter().any(|allowed| allowed == account))
        })
    }

    /// Whether it judges a text rubric (`textual`) or a visual one.
    pub fn judges(&self, textual: bool) -> bool {
        let kind = if textual { "text" } else { "visual" };
        self.inputs
            .as_ref()
            .is_none_or(|inputs| inputs.iter().any(|input| input == kind))
    }

    /// The model it names, aliases resolved.
    fn model(&self) -> Option<String> {
        runner::concrete_model(&self.provider_id, &self.model_id)
    }

    /// Whether `other` names the same judge: provider, model (aliases
    /// resolved) and effort.
    fn same_judge(&self, other: &Entry) -> bool {
        let model = self.model();
        self.provider_id == other.provider_id
            && model.is_some()
            && model == other.model()
            && self.effort == other.effort
    }
}

/// Who makes a provider's models. An ordinary judge never sits on a
/// rendering of its own vendor's model.
pub(crate) fn vendor(provider_id: &str) -> Option<&'static str> {
    Some(match NativeProvider::for_harness(provider_id)? {
        NativeProvider::Claude => "Anthropic",
        NativeProvider::Codex => "OpenAI",
        NativeProvider::Grok => "xAI",
        NativeProvider::Kimi => "Moonshot AI",
        NativeProvider::Zai => "Z.ai",
    })
}

/// The pool in a benchmark settings document: its valid entries without
/// repeats, at most 32. An entry that is not one is left out.
pub fn entries(settings: &Value) -> Vec<Entry> {
    let mut pool: Vec<Entry> = Vec::new();
    for value in settings["judgePool"].as_array().into_iter().flatten() {
        let Ok(entry) = serde_json::from_value::<Entry>(value.clone()) else {
            continue;
        };
        if entry.valid()
            && !pool.iter().any(|seen| {
                seen.provider_id == entry.provider_id
                    && seen.model_id == entry.model_id
                    && seen.effort == entry.effort
            })
        {
            pool.push(entry);
        }
        if pool.len() == MAX_ENTRIES {
            break;
        }
    }
    pool
}

/// The pool the owner set for benchmarks under `root`; none without one.
pub async fn pool(root: &Path) -> Vec<Entry> {
    let settings = tokio::fs::read_to_string(root.join(SETTINGS))
        .await
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_default();
    entries(&settings)
}

/// One control a calibration judged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlScore {
    pub record_id: String,
    pub control_id: String,
    /// `pass` for an accepted answer, `fail` for a known violation.
    pub expected: String,
    /// The judge's score from 0 to 1; none when it gave no valid sheet or
    /// abstained.
    pub score: Option<f64>,
    pub in_band: bool,
    pub reason: String,
}

/// One judge's calibration on the rubric controls.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    pub id: String,
    pub entry: Entry,
    pub recipe: String,
    /// `running`, `passed`, `failed` or `interrupted` (a restart cut it off).
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub account_id: Option<String>,
    pub controls: Vec<ControlScore>,
    pub failure: Option<String>,
    /// For a judge whose provider has not been checked to see images: its
    /// visual controls, judged once the text ones passed (see
    /// [`VisualCalibration`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual: Option<VisualCalibration>,
}

/// Whether a judge of a provider not yet checked to see images judges them:
/// the visual rubrics' controls, accepted and rejected renderings with their
/// bands, which a judge that does not see the image cannot score inside
/// both, so they are also the image probe. Passing seats the entry on visual
/// rubrics; failing leaves its text seats as they are.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualCalibration {
    /// `running`, `passed`, `failed` or `interrupted` (a restart cut it off).
    pub status: String,
    pub controls: Vec<ControlScore>,
    pub failure: Option<String>,
}

/// Whether the entry's provider is checked to see images, or its newest
/// calibration passed the visual controls.
fn sees_images(entry: &Entry, calibration: Option<&Calibration>) -> bool {
    runner::judge_provider_allowed(&entry.provider_id)
        || calibration
            .and_then(|calibration| calibration.visual.as_ref())
            .is_some_and(|visual| visual.status == "passed")
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Document {
    #[serde(default)]
    calibrations: Vec<Calibration>,
}

fn storage(error: impl std::fmt::Display) -> BenchmarkError {
    BenchmarkError::new(
        "storage_unavailable",
        format!("Cannot read or save judge calibrations: {error}"),
    )
}

async fn read(root: &Path) -> Result<Vec<Calibration>> {
    match tokio::fs::read_to_string(root.join(CALIBRATIONS)).await {
        Ok(text) => serde_json::from_str::<Document>(&text)
            .map(|document| document.calibrations)
            .map_err(storage),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(storage(error)),
    }
}

/// The stored calibrations, newest first; a running one this process no
/// longer runs reads as interrupted.
pub async fn calibrations(root: &Path) -> Result<Vec<Calibration>> {
    let mut all = read(root).await?;
    let live: Vec<String> = running().iter().map(|(id, _)| id.clone()).collect();
    for calibration in &mut all {
        let cut = !live.contains(&calibration.id);
        if calibration.status == "running" && cut {
            calibration.status = "interrupted".into();
        }
        if let Some(visual) = calibration
            .visual
            .as_mut()
            .filter(|visual| visual.status == "running" && cut)
        {
            visual.status = "interrupted".into();
        }
    }
    all.sort_by_key(|calibration| std::cmp::Reverse(calibration.started_at));
    Ok(all)
}

async fn save(root: &Path, calibration: &Calibration) -> Result<()> {
    let _guard = CALIBRATIONS_LOCK.lock().await;
    let mut all = read(root).await?;
    match all.iter_mut().find(|stored| stored.id == calibration.id) {
        Some(stored) => *stored = calibration.clone(),
        None => all.push(calibration.clone()),
    }
    all.sort_by_key(|stored| std::cmp::Reverse(stored.started_at));
    all.truncate(KEPT);
    let contents = serde_json::to_string_pretty(&Document { calibrations: all })?;
    let target = root.join(CALIBRATIONS);
    tokio::task::spawn_blocking(move || {
        let temporary = target.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
        crate::commands::flock_store::write_file_synced(&temporary, contents.as_bytes())
            .and_then(|()| std::fs::rename(&temporary, &target))
            .inspect_err(|_| {
                let _ = std::fs::remove_file(&temporary);
            })
    })
    .await
    .map_err(storage)?
    .map_err(storage)
}

/// The entry's newest calibration for this recipe.
fn latest<'a>(all: &'a [Calibration], entry: &Entry) -> Option<&'a Calibration> {
    all.iter()
        .filter(|calibration| calibration.recipe == RECIPE && entry.same_judge(&calibration.entry))
        .max_by_key(|calibration| calibration.started_at)
}

/// Why a pool entry cannot take seats now, or nothing when it can. A judge
/// reads private rubrics and the conditions a right answer meets, so a
/// provider that may train on submitted data never judges.
fn refusal(entry: &Entry, calibration: Option<&Calibration>, data_use: &DataUse) -> Option<String> {
    if vendor(&entry.provider_id).is_none() {
        return Some("Its provider has no native judge profile".into());
    }
    if let Some(reason) = data_use.judge_refusal(&entry.provider_id) {
        return Some(reason);
    }
    let Some(calibration) = calibration else {
        return Some("Not calibrated yet".into());
    };
    match calibration.status.as_str() {
        "passed" => None,
        "running" => Some("Calibrating".into()),
        "interrupted" => Some("Its calibration was interrupted; calibrate it again".into()),
        _ => Some(format!(
            "Its calibration failed: {}",
            calibration
                .failure
                .as_deref()
                .unwrap_or("a control was out of band")
        )),
    }
}

/// The pool's entries that may take seats on a text rubric (`textual`) or a
/// visual one: they judge it, their vendor is known and their newest
/// calibration for this recipe passed. Calibrations that cannot be read
/// seat nobody.
pub async fn seatable(root: &Path, textual: bool) -> Result<Vec<Entry>> {
    let all = match calibrations(root).await {
        Ok(all) => all,
        Err(error) => {
            log::warn!("[benchmarks] judge pool seats nobody: {}", error.message);
            Vec::new()
        }
    };
    let data_use = DataUse::load(root).await;
    Ok(pool(root)
        .await
        .into_iter()
        .filter(|entry| {
            let calibration = latest(&all, entry);
            entry.judges(textual)
                && refusal(entry, calibration, &data_use).is_none()
                && (textual || sees_images(entry, calibration))
        })
        .collect())
}

/// The offered model rows that are pool entries, each as the seat it is:
/// the entry's effort, which the row must offer and its provider's profile
/// allow, on an account the entry lets it sit on. A row no entry names never
/// seats.
pub(crate) fn seat_rows(
    pool: &[Entry],
    offered: Vec<(Option<Headroom>, InventoryModel)>,
) -> Vec<(Option<Headroom>, Configuration)> {
    offered
        .into_iter()
        .filter_map(|(headroom, row)| {
            let provider = &row.configuration.provider_id;
            let model = runner::concrete_model(provider, &row.configuration.model_id)?;
            // The first entry of the model that may sit on this row's account
            // at an effort the row offers: entries of one model may differ in
            // effort or accounts.
            pool.iter().find_map(|entry| {
                if &entry.provider_id != provider
                    || entry.model().as_deref() != Some(model.as_str())
                    || entry
                        .effort
                        .as_ref()
                        .is_some_and(|effort| !row.efforts.contains(effort))
                    || !entry.sits_on(row.configuration.account_id.as_deref())
                {
                    return None;
                }
                let mut judge = row.configuration.clone();
                judge.effort = entry.effort.clone();
                runner::profile_refusal(&judge)
                    .is_none()
                    .then_some((headroom, judge))
            })
        })
        .collect()
}

/// A pool entry as the owner sees it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub entry: Entry,
    pub vendor: Option<&'static str>,
    pub calibration: Option<Calibration>,
    pub seats: bool,
    /// Whether it also seats on visual rubrics (see [`sees_images`]).
    pub seats_visual: bool,
    pub reason: Option<String>,
}

/// The pool, each entry with its newest calibration and whether it seats,
/// and every stored calibration, also of models outside the pool.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub recipe: &'static str,
    pub pool: Vec<Row>,
    pub calibrations: Vec<Calibration>,
}

pub async fn status(root: &Path) -> Result<Status> {
    let calibrations = calibrations(root).await?;
    let data_use = DataUse::load(root).await;
    let pool = pool(root)
        .await
        .into_iter()
        .map(|entry| {
            let calibration = latest(&calibrations, &entry).cloned();
            let reason = refusal(&entry, calibration.as_ref(), &data_use);
            Row {
                vendor: vendor(&entry.provider_id),
                seats: reason.is_none(),
                seats_visual: reason.is_none()
                    && entry.judges(false)
                    && sees_images(&entry, calibration.as_ref()),
                entry,
                calibration,
                reason,
            }
        })
        .collect();
    Ok(Status {
        recipe: RECIPE,
        pool,
        calibrations,
    })
}

type ControlSets = Vec<(qualification::Record, BenchmarkVersion)>;

/// The rubric qualification records whose controls `entry` is calibrated on,
/// with their versions: every text rubric's, and a visual rubric's when the
/// entry judges visual rubrics and its provider is checked to see images.
/// Second, for an entry that judges visual rubrics on a provider not yet
/// checked, the visual rubrics' records its visual calibration judges.
async fn control_sets(store: &Store, entry: &Entry) -> Result<(ControlSets, ControlSets)> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM selector_qualifications WHERE revoked_at IS NULL ORDER BY created_at,id",
    )
    .fetch_all(&store.pool)
    .await?;
    let checked = runner::judge_provider_allowed(&entry.provider_id);
    let (mut sets, mut visual) = (Vec::new(), Vec::new());
    for id in ids {
        let record = store.qualification(&id).await?;
        if record.request.rubric.is_none() || record.request.controls.is_empty() {
            continue;
        }
        let version = store.version(&record.request.version_id).await?;
        if version.manifest.evaluator.kind != "rubric" {
            continue;
        }
        if runner::text_judged(&version.manifest) || (entry.judges(false) && checked) {
            sets.push((record, version));
        } else if entry.judges(false) {
            visual.push((record, version));
        }
    }
    Ok((sets, visual))
}

/// Why a calibration stopped without a verdict on the judge.
const UNAVAILABLE: &str = "judge_unavailable";

/// Whether a scoreless answer is the judge's own: a sheet it got wrong or
/// conditions it left unresolved.
fn judged_itself(evaluation: &Evaluation) -> bool {
    evaluation
        .reason
        .starts_with("Judge returned no valid score sheet")
        || evaluation.reason.starts_with("Critical checks unresolved")
}

/// Judges every control of `sets` with the entry's seat and records each
/// score; the calibration fails on the first control out of its band. Once
/// the text controls passed, a judge of a provider not yet checked to see
/// images judges `visual`, whose verdict only decides its visual seats.
async fn run(
    store: &Store,
    backend: &dyn runner::ExecutionBackend,
    calibration: &mut Calibration,
    sets: &[(qualification::Record, BenchmarkVersion)],
    visual: &[(qualification::Record, BenchmarkVersion)],
) -> Result<()> {
    let judge = backend
        .calibration_judge(&calibration.entry, &calibration.id)
        .await?;
    calibration.account_id = judge.account_id.clone();
    save(&store.root, calibration).await?;
    calibration.failure = judge_controls(store, backend, calibration, &judge, sets, false).await?;
    if calibration.failure.is_some() || visual.is_empty() {
        return Ok(());
    }
    // The text verdict stands whatever happens to the visual phase, a
    // restart included.
    calibration.status = "passed".into();
    calibration.visual = Some(VisualCalibration {
        status: "running".into(),
        controls: Vec::new(),
        failure: None,
    });
    save(&store.root, calibration).await?;
    let judged = judge_controls(store, backend, calibration, &judge, visual, true).await;
    let settled = calibration
        .visual
        .as_mut()
        .expect("visual calibration started");
    match judged {
        Ok(None) => settled.status = "passed".into(),
        Ok(Some(failure)) => {
            settled.status = "failed".into();
            settled.failure = Some(failure);
        }
        // No visual verdict was measured. Keep the passed text phase, and
        // leave visual seats unavailable until another explicit calibration.
        Err(error) => {
            settled.status = "interrupted".into();
            settled.failure = Some(format!(
                "The judge gave no answer on a rendering: {}: {}",
                error.code, error.message
            ));
        }
    }
    save(&store.root, calibration).await
}

/// Judges every control of `sets` with `judge`, recording each score in the
/// calibration's text controls or, for `visual`, its visual ones, and
/// returns the first control out of its band as the failure.
async fn judge_controls(
    store: &Store,
    backend: &dyn runner::ExecutionBackend,
    calibration: &mut Calibration,
    judge: &Configuration,
    sets: &[(qualification::Record, BenchmarkVersion)],
    visual: bool,
) -> Result<Option<String>> {
    for (record, version) in sets {
        let Some(band) = record.request.rubric.as_ref() else {
            continue;
        };
        for (index, control) in record.request.controls.iter().enumerate() {
            let directory = store
                .root
                .join("judge-calibrations")
                .join(&calibration.id)
                .join(format!("{}-{index}", record.id));
            let asked = now();
            let judged = loop {
                let judged = backend
                    .calibrate_control(store, version, record, index, judge, directory.clone())
                    .await?;
                let busy = matches!(
                    judged.reason.as_deref(),
                    Some(runner::JUDGES_BUSY | runner::RENDERER_BUSY)
                );
                if !busy || now() - asked >= BUSY_WAIT_MS {
                    break judged;
                }
                tokio::time::sleep(runner::EVALUATION_RETRY).await;
            };
            let vote = judged.evaluations.iter().rev().find(|evaluation| {
                matches!(evaluation.provenance.as_str(), "judge" | "judge_failure")
            });
            let score = vote.and_then(|evaluation| evaluation.score);
            // An invalid sheet or an abstention on an unresolved condition is
            // the judge's own answer; no answer at all (a spent quota, a bridge
            // that failed, a time budget, judges that stayed busy) says
            // nothing about the judge, so the calibration is interrupted.
            if score.is_none() && !vote.is_some_and(judged_itself) {
                return Err(BenchmarkError::new(
                    UNAVAILABLE,
                    vote.map(|evaluation| evaluation.reason.clone())
                        .or_else(|| judged.reason.clone())
                        .unwrap_or_else(|| "The judge gave no answer".into()),
                ));
            }
            let reason = vote
                .map(|evaluation| evaluation.reason.clone())
                .or_else(|| judged.reason.clone())
                .unwrap_or_default();
            let scored = ControlScore {
                record_id: record.id.clone(),
                control_id: control.id.clone(),
                expected: control.expected.clone(),
                score,
                in_band: qualification::in_band(band, &control.expected, score),
                reason: reason.chars().take(500).collect(),
            };
            let miss = (!scored.in_band).then(|| control_failure(&scored));
            match calibration.visual.as_mut().filter(|_| visual) {
                Some(visual) => visual.controls.push(scored),
                None => calibration.controls.push(scored),
            }
            save(&store.root, calibration).await?;
            if miss.is_some() {
                return Ok(miss);
            }
        }
    }
    Ok(None)
}

fn control_failure(miss: &ControlScore) -> String {
    format!(
        "Control {} expected {} and scored {}",
        miss.control_id,
        if miss.expected == "pass" {
            "an accepted answer"
        } else {
            "a rejected answer"
        },
        miss.score
            .map_or("no valid sheet".to_owned(), |score| format!("{score:.2}"))
    )
}

impl BenchmarkService {
    /// The judge pool with each entry's calibration (see [`status`]).
    pub async fn judge_pool(&self) -> Result<Status> {
        status(&self.store.root).await
    }

    /// Starts a calibration of the pool entry `entry` names in the background
    /// and returns it as it starts. One calibration of a judge runs at a time.
    pub async fn calibrate_judge(&self, entry: Entry) -> Result<Calibration> {
        if !entry.valid() || vendor(&entry.provider_id).is_none() || entry.model().is_none() {
            return Err(BenchmarkError::new(
                "validation",
                "A judge needs a native provider, a model and a bounded effort",
            ));
        }
        // A calibration sends private rubric controls to the provider too, so
        // only a pool entry of a provider that does not train on submitted
        // data is calibrated.
        let Some(entry) = pool(&self.store.root)
            .await
            .into_iter()
            .find(|stored| stored.same_judge(&entry))
        else {
            return Err(BenchmarkError::new(
                "validation",
                "Add this judge to the pool before calibrating it",
            ));
        };
        if let Some(reason) = DataUse::load(&self.store.root)
            .await
            .judge_refusal(&entry.provider_id)
        {
            return Err(BenchmarkError::new("validation", reason));
        }
        let (sets, visual) = control_sets(&self.store, &entry).await?;
        if sets.is_empty() {
            return Err(BenchmarkError::new(
                "validation",
                "No rubric qualification has controls to calibrate a judge on",
            ));
        }
        let calibration = Calibration {
            id: uuid::Uuid::new_v4().to_string(),
            entry: entry.clone(),
            recipe: RECIPE.into(),
            status: "running".into(),
            started_at: now(),
            finished_at: None,
            account_id: None,
            controls: Vec::new(),
            failure: None,
            visual: None,
        };
        {
            let mut live = running();
            if live.iter().any(|(_, judge)| judge.same_judge(&entry)) {
                return Err(BenchmarkError::new(
                    "validation",
                    "This judge is already being calibrated",
                ));
            }
            live.push((calibration.id.clone(), entry.clone()));
        }
        let reservation = RunningCalibration(calibration.id.clone());
        save(&self.store.root, &calibration).await?;
        let store = self.store.clone();
        let backend = self.backend.clone();
        let app = self.app.clone();
        let mut settled = calibration.clone();
        tokio::spawn(async move {
            let result = AssertUnwindSafe(Box::pin(run(
                &store,
                backend.as_ref(),
                &mut settled,
                &sets,
                &visual,
            )))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                let message = "Judge calibration worker panicked; inspect the application log";
                // The text phase already passed. A visual worker failure
                // cannot erase that verdict or authorize visual seats.
                if settled.status == "passed" {
                    if let Some(visual) = settled.visual.as_mut() {
                        visual.status = "interrupted".into();
                        visual.failure = Some(message.into());
                        return Ok(());
                    }
                }
                Err(BenchmarkError::new(UNAVAILABLE, message))
            });
            let interrupted = match result {
                Ok(()) => false,
                Err(error) => {
                    settled.failure = Some(format!("{}: {}", error.code, error.message));
                    // Only a completed control outside its score band is a
                    // failed quality verdict. Preparation/worker errors mean
                    // the judge was not measured, whatever their error code.
                    true
                }
            };
            settled.status = if interrupted {
                "interrupted"
            } else if settled.failure.is_none() {
                "passed"
            } else {
                "failed"
            }
            .into();
            settled.finished_at = Some(now());
            if let Err(error) = save(&store.root, &settled).await {
                log::warn!(
                    "[benchmarks] judge calibration {} not saved: {}",
                    settled.id,
                    error.message
                );
            }
            drop(reservation);
            log::info!(
                "[benchmarks] judge calibration {} of {} {} at {}: {} ({} controls{}){}",
                settled.id,
                settled.entry.provider_id,
                settled.entry.model_id,
                settled.entry.effort.as_deref().unwrap_or("default effort"),
                settled.status,
                settled.controls.len(),
                settled
                    .failure
                    .as_deref()
                    .map(|failure| format!("; {failure}"))
                    .unwrap_or_default(),
                settled
                    .visual
                    .as_ref()
                    .map(|visual| format!(
                        "; visual {} ({} controls{})",
                        visual.status,
                        visual.controls.len(),
                        visual
                            .failure
                            .as_deref()
                            .map(|failure| format!("; {failure}"))
                            .unwrap_or_default()
                    ))
                    .unwrap_or_default()
            );
            super::notify_changed(&store, app.as_ref()).await;
        });
        Ok(calibration)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(provider: &str, model: &str, effort: Option<&str>) -> Entry {
        Entry {
            provider_id: provider.into(),
            model_id: model.into(),
            effort: effort.map(str::to_owned),
            inputs: None,
            accounts: None,
            disclosure_confirmed: true,
        }
    }

    fn calibration(entry: Entry, status: &str, started_at: i64) -> Calibration {
        Calibration {
            id: format!("calibration-{started_at}"),
            entry,
            recipe: RECIPE.into(),
            status: status.into(),
            started_at,
            finished_at: Some(started_at + 1),
            account_id: None,
            controls: Vec::new(),
            failure: (status == "failed")
                .then(|| "Control c expected a rejected answer and scored 0.41".into()),
            visual: None,
        }
    }

    #[test]
    fn the_pool_is_the_owners_valid_entries_without_repeats() {
        let settings = json!({"timeLimitMinutes": 240, "judgePool": [
            {"providerId": "claude-acp", "modelId": "opus", "effort": "high"},
            {"providerId": "codex-acp", "modelId": "invented-sol", "effort": "high", "inputs": ["text"]},
            {"providerId": "claude-acp", "modelId": "opus", "effort": "high"},
            {"providerId": "claude-acp", "modelId": "opus", "effort": "max"},
            {"providerId": " grok-acp", "modelId": "invented-grok"},
            {"providerId": "grok-acp", "modelId": ""},
            {"providerId": "grok-acp", "modelId": "invented-grok", "inputs": []},
            {"providerId": "grok-acp", "modelId": "invented-grok", "inputs": ["audio"]},
            {"providerId": "grok-acp", "modelId": "invented-grok", "seat": 1},
            "opus",
        ]});
        let pool = entries(&settings);
        assert_eq!(
            pool.iter()
                .map(|e| (
                    e.provider_id.as_str(),
                    e.model_id.as_str(),
                    e.effort.as_deref()
                ))
                .collect::<Vec<_>>(),
            [
                ("claude-acp", "opus", Some("high")),
                ("codex-acp", "invented-sol", Some("high")),
                ("claude-acp", "opus", Some("max")),
            ]
        );
        assert!(pool[1].judges(true) && !pool[1].judges(false));
        // A pool written with the old per-entry flag still reads.
        let older = entries(&json!({"judgePool": [
            {"providerId": "claude-acp", "modelId": "opus", "disclosureConfirmed": true}
        ]}));
        assert_eq!(older.len(), 1);
        assert!(pool[0].judges(true) && pool[0].judges(false));
        assert!(entries(&json!({})).is_empty());
        let many: Vec<_> = (0..40)
            .map(|i| json!({"providerId": "claude-acp", "modelId": format!("m{i}")}))
            .collect();
        assert_eq!(entries(&json!({ "judgePool": many })).len(), MAX_ENTRIES);
    }

    #[test]
    fn vendors_are_provider_families() {
        assert_eq!(vendor("claude-acp"), Some("Anthropic"));
        assert_eq!(vendor("codex-acp"), Some("OpenAI"));
        assert_eq!(vendor("grok-acp"), Some("xAI"));
        assert_eq!(vendor("kimi-acp"), Some("Moonshot AI"));
        assert_eq!(vendor("zai-acp"), Some("Z.ai"));
        assert_eq!(vendor("invented-provider"), None);
    }

    #[test]
    fn only_a_newest_passed_calibration_of_the_same_judge_seats() {
        let opus = entry("claude-acp", "opus", Some("high"));
        let sol = entry("codex-acp", "invented-sol", Some("high"));
        let grok = entry("grok-acp", "invented-grok", None);
        let mut other_recipe = calibration(grok.clone(), "passed", 9);
        other_recipe.recipe = "older-recipe".into();
        let all = vec![
            calibration(opus.clone(), "failed", 1),
            calibration(opus.clone(), "passed", 2),
            calibration(sol.clone(), "passed", 3),
            calibration(sol.clone(), "failed", 4),
            other_recipe,
            calibration(entry("claude-acp", "opus", Some("max")), "passed", 5),
        ];
        let defaults = DataUse::from_settings(&json!({}));
        assert!(refusal(&opus, latest(&all, &opus), &defaults).is_none());
        assert!(refusal(&sol, latest(&all, &sol), &defaults)
            .unwrap()
            .starts_with("Its calibration failed: Control c"));
        assert_eq!(
            refusal(&grok, latest(&all, &grok), &defaults).as_deref(),
            Some("Not calibrated yet")
        );
        let unknown = entry("invented-provider", "model", None);
        assert!(refusal(&unknown, None, &defaults).is_some());
        // A passed calibration never seats a provider that may train on
        // submitted data, by default or by the owner's word.
        let glm = entry("zai-acp", "invented-glm", Some("high"));
        let passed = calibration(glm.clone(), "passed", 6);
        assert!(refusal(&glm, Some(&passed), &defaults)
            .unwrap()
            .contains("may train on submitted data"));
        let opus_trains = DataUse::from_settings(
            &json!({"providerDataUse": {"claude-acp": {"trainsOnSubmissions": true}}}),
        );
        assert!(refusal(&opus, latest(&all, &opus), &opus_trains).is_some());
    }

    #[tokio::test]
    async fn seats_come_from_the_settings_and_the_stored_calibrations() {
        let root = tempfile::tempdir().unwrap();
        let opus = entry("claude-acp", "opus", Some("high"));
        let mut visual = entry("claude-acp", "sonnet", None);
        visual.inputs = Some(vec!["visual".into()]);
        let sol = entry("codex-acp", "invented-sol", Some("high"));
        std::fs::write(
            root.path().join(SETTINGS),
            json!({"timeLimitMinutes": 60, "judgePool": [opus, visual, sol]}).to_string(),
        )
        .unwrap();
        // Nothing calibrated yet: nobody seats.
        assert!(seatable(root.path(), true).await.unwrap().is_empty());
        save(root.path(), &calibration(opus.clone(), "passed", 1))
            .await
            .unwrap();
        save(root.path(), &calibration(visual.clone(), "passed", 2))
            .await
            .unwrap();
        // A running calibration this process does not run was interrupted.
        save(root.path(), &calibration(sol.clone(), "running", 3))
            .await
            .unwrap();
        assert_eq!(
            seatable(root.path(), true).await.unwrap(),
            std::slice::from_ref(&opus)
        );
        assert_eq!(
            seatable(root.path(), false).await.unwrap(),
            [opus.clone(), visual.clone()]
        );
        let status = status(root.path()).await.unwrap();
        assert_eq!(status.recipe, RECIPE);
        assert_eq!(status.pool.len(), 3);
        assert_eq!(
            status.pool[2].calibration.as_ref().unwrap().status,
            "interrupted"
        );
        assert!(!status.pool[2].seats);
        assert_eq!(status.calibrations.len(), 3);
        assert_eq!(status.calibrations[0].started_at, 3);
        // A save replaces the calibration with the same id.
        save(root.path(), &calibration(sol.clone(), "passed", 3))
            .await
            .unwrap();
        assert_eq!(calibrations(root.path()).await.unwrap().len(), 3);
        assert_eq!(
            seatable(root.path(), true).await.unwrap(),
            [opus.clone(), sol.clone()]
        );
        // A provider not checked to see images seats on visual rubrics only
        // once its calibration passed the visual controls, which leave its
        // text seat alone when they fail.
        assert_eq!(
            seatable(root.path(), false).await.unwrap(),
            [opus.clone(), visual.clone()]
        );
        let mut probed = calibration(sol.clone(), "passed", 3);
        probed.visual = Some(VisualCalibration {
            status: "failed".into(),
            controls: Vec::new(),
            failure: Some("Control v expected an accepted answer and scored 0.20".into()),
        });
        save(root.path(), &probed).await.unwrap();
        assert_eq!(
            seatable(root.path(), true).await.unwrap(),
            [opus.clone(), sol.clone()]
        );
        assert_eq!(
            seatable(root.path(), false).await.unwrap(),
            [opus.clone(), visual.clone()]
        );
        probed.visual.as_mut().unwrap().status = "passed".into();
        save(root.path(), &probed).await.unwrap();
        assert_eq!(
            seatable(root.path(), false).await.unwrap(),
            [opus.clone(), visual, sol.clone()]
        );
        let status = super::status(root.path()).await.unwrap();
        assert!(status.pool.iter().all(|row| row.seats_visual));
        // A restart during the visual phase keeps the passed text verdict
        // and reads the visual phase as interrupted: text seats only.
        probed.visual.as_mut().unwrap().status = "running".into();
        save(root.path(), &probed).await.unwrap();
        let stored = calibrations(root.path()).await.unwrap();
        let cut = stored.iter().find(|stored| stored.id == probed.id).unwrap();
        assert_eq!(cut.status, "passed");
        assert_eq!(cut.visual.as_ref().unwrap().status, "interrupted");
        assert!(seatable(root.path(), true).await.unwrap().contains(&sol));
        assert!(!seatable(root.path(), false).await.unwrap().contains(&sol));
        // Calibrations that cannot be read seat nobody.
        std::fs::write(root.path().join(CALIBRATIONS), "{").unwrap();
        assert!(seatable(root.path(), true).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn only_a_pool_entry_whose_data_use_is_confirmed_is_calibrated() {
        let root = crate::test_support::TempRoot::new();
        let store = Store::open(root.path()).await.unwrap();
        root.register(&store.pool);
        let service = BenchmarkService {
            store,
            backend: std::sync::Arc::new(runner::FakeBackend::default()),
            wake: Default::default(),
            active: Default::default(),
            queries: Default::default(),
            app: None,
        };
        let sol = entry("codex-acp", "invented-sol", Some("high"));
        let refusal = |result: Result<Calibration>| result.unwrap_err().message;
        // Not in the pool: nothing is sent, whatever the request says.
        assert_eq!(
            refusal(service.calibrate_judge(sol.clone()).await),
            "Add this judge to the pool before calibrating it"
        );
        // In the pool, but its provider may train on submitted data: no
        // private control is sent, whatever the entry or the request says.
        std::fs::write(
            root.path().join(SETTINGS),
            json!({
                "judgePool": [sol.clone()],
                "providerDataUse": {"codex-acp": {"trainsOnSubmissions": true}},
            })
            .to_string(),
        )
        .unwrap();
        assert!(refusal(service.calibrate_judge(sol.clone()).await)
            .contains("may train on submitted data"));
        // Confirmed, but no rubric qualification has controls yet.
        std::fs::write(
            root.path().join(SETTINGS),
            json!({ "judgePool": [sol.clone()] }).to_string(),
        )
        .unwrap();
        assert_eq!(
            refusal(service.calibrate_judge(sol).await),
            "No rubric qualification has controls to calibrate a judge on"
        );
        assert!(calibrations(root.path()).await.unwrap().is_empty());
        drop(service);
        root.close().await;
    }

    #[test]
    fn a_row_seats_as_its_entry_at_the_entrys_effort() {
        let judge = |provider: &str, model: &str, efforts: &[&str]| InventoryModel {
            configuration: Configuration {
                id: format!("{provider}:{model}"),
                provider_id: provider.into(),
                account_id: Some("invented-account".into()),
                model_id: model.into(),
                effort: None,
                fast_mode: Some(false),
                billing_mode: "subscription".into(),
                execution_profile: "native_text".into(),
                inventory_revision: Some("invented-runtime".into()),
                model_name: None,
            },
            name: model.into(),
            efforts: efforts.iter().map(|effort| (*effort).to_owned()).collect(),
            supports_fast_mode: false,
            available: true,
            reason: None,
        };
        let pool = vec![
            entry("codex-acp", "invented-sol", Some("high")),
            entry("grok-acp", "invented-grok", Some("high")),
        ];
        let seats = seat_rows(
            &pool,
            vec![
                (None, judge("codex-acp", "invented-sol", &["low", "high"])),
                // Not in the pool.
                (None, judge("codex-acp", "invented-luna", &["high"])),
                // The entry's effort is not offered.
                (None, judge("grok-acp", "invented-grok", &["low"])),
            ],
        );
        assert_eq!(seats.len(), 1);
        assert_eq!(seats[0].1.model_id, "invented-sol");
        assert_eq!(seats[0].1.effort.as_deref(), Some("high"));
        // An entry that names its accounts sits only on those.
        let mut steered = entry("codex-acp", "invented-sol", Some("high"));
        steered.accounts = Some(vec!["invented-second".into()]);
        let mut second = judge("codex-acp", "invented-sol", &["high"]);
        second.configuration.account_id = Some("invented-second".into());
        let seats = seat_rows(
            &[steered.clone()],
            vec![
                (None, judge("codex-acp", "invented-sol", &["high"])),
                (None, second),
            ],
        );
        assert_eq!(seats.len(), 1);
        assert_eq!(seats[0].1.account_id.as_deref(), Some("invented-second"));
        // Two entries of one model on different accounts each seat on theirs.
        let mut first = entry("codex-acp", "invented-sol", Some("high"));
        first.accounts = Some(vec!["invented-account".into()]);
        let mut second_row = judge("codex-acp", "invented-sol", &["high"]);
        second_row.configuration.account_id = Some("invented-second".into());
        let seats = seat_rows(
            &[first, steered.clone()],
            vec![
                (None, judge("codex-acp", "invented-sol", &["high"])),
                (None, second_row),
            ],
        );
        assert_eq!(seats.len(), 2);
        assert!(steered.valid());
        // A list must name something, within bounds.
        steered.accounts = Some(Vec::new());
        assert!(!steered.valid());
        let read: Entry = serde_json::from_value(json!({"providerId":"codex-acp",
            "modelId":"invented-sol","accounts":["invented-second"]}))
        .unwrap();
        assert_eq!(read.accounts, Some(vec!["invented-second".to_owned()]));
        assert!(entry("codex-acp", "invented-sol", None).sits_on(None));
    }
}
