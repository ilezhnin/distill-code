//! Frozen comparisons of complete research workflows. No promotion.
use super::{
    fixtures, learned, routing,
    store::{event, now, Store},
    types::*,
    workflow_policy::{WorkflowPolicy, WorkflowRunRequest},
    BenchmarkService,
};
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, Transaction};
use std::collections::{BTreeMap, BTreeSet};

pub mod acceptance;
pub mod report;
mod scheduler;

fn invalid(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("invalid_workflow_campaign", message)
}
pub(super) fn hash(value: &impl Serialize) -> Result<String> {
    Ok(fixtures::hash(&serde_json::to_vec(value)?))
}
fn group(draft: &BenchmarkDraft) -> &str {
    draft
        .environment
        .get("splitGroup")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&draft.task_family)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_limits: Option<RunExecutionLimits>,
    /// Maximum admitted, unfinished trajectories, any number from one: the
    /// workers' admission and accounts decide below it. Omission retains
    /// serial hashes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parallelism: Option<u32>,
    /// Worker calls one account may run at once for this campaign, any
    /// number from one. Omission keeps the shared default of four and the
    /// saved hashes. Recorded in the frozen plan: the measured conditions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_slots: Option<u32>,
    pub request_key: String,
    pub model_id: String,
    pub version_ids: Vec<String>,
    pub candidates: Vec<Configuration>,
    pub persona_prior_ids: Vec<String>,
    pub min_quality: f64,
    pub repetitions: u32,
    pub timeout_seconds: u32,
    pub max_executions: u32,
    /// Mixed-role workflows: the fitted model for every step work class.
    /// `model_id` must be one of them. Absent for single-class campaigns.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub class_model_ids: BTreeMap<String, String>,
}

/// Saved v3 plans reserve every worker their policy may select before the
/// root clock starts, for the whole trajectory. Saved v1/v2 plans retain
/// their original admission and timing semantics.
pub(super) const RESERVED_WORKERS_ORDER: &str = "sha256-campaign-cell-reserved-workers-v3";
/// New concurrent campaigns admit a root into the trajectory bound without
/// holding any account. Each step takes its selected worker's slot once the
/// step is decided and gives it back when the step ends, so a provider is
/// never held idle for a worker the policy did not choose. Waiting for that
/// slot is recorded on the step and excluded from the whole-workflow clock.
pub(super) const STEP_ADMISSION_ORDER: &str = "sha256-campaign-cell-step-admission-v4";

/// How a frozen campaign's roots take worker capacity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WorkerAdmission {
    /// One root at a time; worker waits settle as busy outcomes.
    Serial,
    /// Bounded roots; a worker wait spends the root wall budget (v2).
    QueueInClock,
    /// Bounded roots holding every selectable worker account (v3).
    ReservedPool,
    /// Bounded roots taking only each decided step's worker (v4).
    SelectedStep,
}

/// A run's frozen concurrency contract: how many roots fly, how they take
/// workers and how many calls one account runs at once.
#[derive(Debug, Clone, Copy)]
pub(super) struct CampaignConcurrency {
    pub parallelism: u32,
    pub admission: WorkerAdmission,
    pub account_slots: usize,
}
impl CampaignConcurrency {
    /// An ordinary run or a serial campaign.
    pub(super) const SERIAL: Self = Self {
        parallelism: 1,
        admission: WorkerAdmission::Serial,
        account_slots: super::runner::ACCOUNT_SLOTS,
    };
    pub(super) fn concurrent(&self) -> bool {
        self.parallelism > 1
    }
    /// Calls of one worker configuration in flight at once for this campaign:
    /// its account bound, never above the trajectory bound. One configuration
    /// cannot use more of an account than the account allows.
    pub(super) fn lane_parallelism(&self) -> u32 {
        self.parallelism.min(self.account_slots as u32).max(1)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Case {
    pub version_id: String,
    pub content_hash: String,
    pub manifest_hash: String,
    pub family: String,
    pub group: String,
    pub evaluator_revision: String,
    pub steps: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judging: Option<FrozenJudging>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrozenJudging {
    pub calls: u32,
    pub timeout_seconds: u32,
    pub panel_binding: String,
}
impl FrozenJudging {
    fn for_draft(draft: &BenchmarkDraft) -> Result<Option<Self>> {
        super::judge_panel::frozen(draft, &[])?
            .map(|panel| {
                Ok(Self {
                    calls: panel.len() as u32,
                    timeout_seconds: super::runner::JUDGE_TIMEOUT_SECONDS,
                    panel_binding: super::runner::frozen_judge_binding(draft)?,
                })
            })
            .transpose()
    }
}
impl Case {
    fn executions(&self) -> u32 {
        self.steps
            .saturating_add(self.judging.as_ref().map_or(0, |j| j.calls))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub case_index: usize,
    pub policy_index: usize,
    pub repetition: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub created_at: i64,
    pub request: Request,
    pub model_snapshot_hash: String,
    pub cases: Vec<Case>,
    pub policies: Vec<WorkflowPolicy>,
    pub cells: Vec<Cell>,
    pub order_algorithm: String,
    pub aggregate_recipe: String,
    pub evaluation: learned::report::ReportProtocol,
    /// Frozen snapshot hash of every class model of a mixed campaign.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub class_snapshot_hashes: BTreeMap<String, String>,
    /// Cancelled campaigns whose cells already measured these families. This
    /// plan replaces them after their runtime failed; its report is a repeat
    /// measurement of exposed families, never an unseen-holdout claim.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supersedes: Vec<String>,
}

/// The public task each workflow step receives, with its schema-2 scope.
pub(super) fn step_task(
    draft: &BenchmarkDraft,
    index: usize,
    remaining_budget_seconds: u32,
) -> Result<learned::PublicTask> {
    let step = draft
        .workflow
        .as_ref()
        .and_then(|workflow| workflow.steps.get(index))
        .ok_or_else(|| invalid("Unknown workflow step"))?;
    let mut scoped = draft.clone();
    if let Some(scope) = &step.scope {
        scoped.role_id = Some(scope.role_id.clone());
        scoped.role_prompt = scope.role_prompt.clone();
        scoped.work_class_id = scope.work_class_id.clone();
        scoped.limits.timeout_seconds = scope.step_budget_seconds;
    }
    let mut task = learned::PublicTask::from(&scoped);
    // Every workflow step supplies an entry, even when the root does not.
    task.entry = Some(learned::PublicEntry {
        conversation_prefix: String::new(),
        previous_reports: vec![],
        remaining_budget_seconds,
    });
    Ok(task)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Campaign {
    pub plan: Plan,
    pub plan_hash: String,
    pub state: String,
    pub state_reason: Option<String>,
    pub next_cell: usize,
    pub revision: i64,
}

impl Plan {
    pub fn run_request(&self, index: usize) -> Result<RunRequest> {
        let cell = self
            .cells
            .get(index)
            .ok_or_else(|| invalid("Unknown campaign cell"))?;
        WorkflowRunRequest {
            execution_limits: self.request.execution_limits.clone(),
            request_key: format!("workflow-campaign:{}:{index}", self.id),
            version_ids: vec![self.cases[cell.case_index].version_id.clone()],
            policy: self.policies[cell.policy_index].clone(),
            repetitions: 1,
            timeout_seconds: self.request.timeout_seconds,
            max_executions: self.cases[cell.case_index].executions(),
        }
        .try_into()
    }
}

/// Whether the training measurements recorded every resource the fit weights
/// for each successful answer. The same workers will not record it in the
/// comparison either, and its report refuses an unknown weighted resource
/// only after every execution; this lets freezing refuse first.
fn weighted_resources_recorded(fit: &learned::FitArtifact) -> bool {
    let weights = fit.model.weights;
    fit.snapshot.examples.iter().all(|example| {
        example
            .targets
            .iter()
            .filter(|target| target.reward.is_some_and(|reward| reward > 0.0))
            .all(|target| {
                (weights.speed == 0.0 || target.mean_duration_ms.is_some())
                    && (weights.cost == 0.0 || target.mean_cost.is_some())
            })
    })
}

/// Equal weight per declared training group, using only the fitted snapshot.
/// The same complete training cases determine every worker's fixed ordering.
pub(super) fn aggregate_order(
    fit: &learned::FitArtifact,
    candidates: &[Configuration],
) -> Result<Vec<String>> {
    let keys: Vec<_> = candidates.iter().map(routing::candidate_key).collect();
    let common: Vec<_> = fit
        .snapshot
        .examples
        .iter()
        .filter(|e| {
            keys.iter().all(|key| {
                e.targets
                    .iter()
                    .any(|t| &t.candidate_key == key && t.utility.is_some())
            })
        })
        .collect();
    if common.len() < 8 {
        return Err(invalid(
            "Aggregate requires eight complete fitted training cases",
        ));
    }
    let mut scores = Vec::new();
    for (candidate, key) in candidates.iter().zip(keys) {
        let mut groups: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
        for example in &common {
            let value = example
                .targets
                .iter()
                .find(|t| t.candidate_key == key)
                .and_then(|t| t.utility)
                .filter(|v| v.is_finite())
                .ok_or_else(|| invalid("Invalid fitted aggregate target"))?;
            groups.entry(&example.split_group).or_default().push(value);
        }
        let score = groups
            .values()
            .map(|v| v.iter().sum::<f64>() / v.len() as f64)
            .sum::<f64>()
            / groups.len() as f64;
        scores.push((candidate.id.clone(), key, score));
    }
    scores.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.1.cmp(&b.1)));
    Ok(scores.into_iter().map(|s| s.0).collect())
}

impl BenchmarkService {
    pub async fn freeze_workflow_campaign(&self, mut request: Request) -> Result<Campaign> {
        request.version_ids.sort();
        request.candidates.sort_by(|a, b| a.id.cmp(&b.id));
        if request.request_key.trim().is_empty()
            || request.request_key.len() > 128
            || !(8..=256).contains(&request.version_ids.len())
            || request.version_ids.windows(2).any(|v| v[0] == v[1])
            || !(1..=20).contains(&request.repetitions)
            || !(1..=3600).contains(&request.timeout_seconds)
            || !(1..=100_000).contains(&request.max_executions)
            || request.parallelism == Some(0)
            || request.account_slots == Some(0)
        {
            return Err(invalid("Campaign requires distinct held-out cases, a request key and bounded repetitions, time, executions and account slots"));
        }
        if let Some(saved) = self.store.workflow_campaign_retry(&request).await? {
            return Ok(saved);
        }
        self.store
            .require_current_versions(&request.version_ids)
            .await?;
        let fit = self.store.selector_fit(&request.model_id).await?;
        let mixed = !request.class_model_ids.is_empty();
        // Every step class of a mixed trajectory has its own fitted model;
        // all of them share candidates and the report's utility weights.
        let mut fits = BTreeMap::new();
        if mixed {
            if !request
                .class_model_ids
                .values()
                .any(|id| id == &request.model_id)
            {
                return Err(invalid("The primary model must be one of the class models"));
            }
            for (class, id) in &request.class_model_ids {
                let class_fit = self.store.selector_fit(id).await?;
                if &class_fit.model.work_class_id != class
                    || serde_json::to_value(class_fit.model.weights)?
                        != serde_json::to_value(fit.model.weights)?
                {
                    return Err(invalid(
                        "Each class model must fit its own class with the shared utility weights",
                    ));
                }
                fits.insert(class.clone(), class_fit);
            }
        } else {
            fits.insert(fit.model.work_class_id.clone(), fit.clone());
        }
        if !fits.values().all(weighted_resources_recorded) {
            return Err(invalid(
                "The fit weights speed or cost that its training measurements did not record; the comparison could not score them. Refit with those weights at zero, or measure with them recorded",
            ));
        }
        let data = self.query_data().await?;
        let pool = super::analysis::pool(&data, &ResultQuery::default());
        let mut versions = Vec::new();
        let mut cases = Vec::new();
        let mut shape: Option<Vec<String>> = None;
        for id in &request.version_ids {
            let version = pool
                .iter()
                .find(|v| &v.id == id)
                .ok_or_else(|| invalid("Campaign version is not in the current pool"))?;
            let draft = &version.manifest;
            let workflow = draft
                .workflow
                .as_ref()
                .ok_or_else(|| invalid("Campaign requires bounded workflows"))?;
            // A single-class campaign keeps its root-scope rule. A mixed one
            // checks every step against the model fitted for that step class,
            // and all cases share one class sequence: a certificate later
            // speaks for that exact trajectory shape.
            if mixed {
                let classes = super::workflow_policy::step_classes(draft);
                if shape.get_or_insert_with(|| classes.clone()) != &classes {
                    return Err(invalid(
                        "A mixed campaign needs one shared step class sequence",
                    ));
                }
            }
            // Every step is checked: a schema-2 step with another role or
            // class is outside a single-class fit even when its root is not.
            let tasks = (0..workflow.steps.len())
                .map(|index| step_task(draft, index, request.timeout_seconds))
                .collect::<Result<Vec<_>>>()?;
            let mut outside_scope = false;
            for task in &tasks {
                let Some(class_fit) = fits.get(&task.work_class_id) else {
                    outside_scope = true;
                    continue;
                };
                outside_scope |= !class_fit
                    .model
                    .scope_hashes
                    .contains(&learned::scope_hash(task)?);
            }
            if draft.split != "held_out"
                || fits.values().any(|class_fit| {
                    class_fit
                        .model
                        .training_families
                        .contains(&draft.task_family)
                        || class_fit
                            .model
                            .training_groups
                            .iter()
                            .any(|g| g == group(draft))
                })
                || outside_scope
                || request.repetitions < super::analysis::required_repetitions(&data, version)
                || request.timeout_seconds < draft.limits.timeout_seconds
            {
                return Err(invalid("Campaign needs unused held-out workflow families in the fitted scope and all required repetitions/budgets"));
            }
            cases.push(Case {
                version_id: id.clone(),
                content_hash: version.content_hash.clone(),
                manifest_hash: hash(draft)?,
                family: draft.task_family.clone(),
                group: group(draft).into(),
                evaluator_revision: draft.evaluator.revision.clone(),
                steps: workflow.steps.len() as u32,
                judging: FrozenJudging::for_draft(draft)?,
            });
            versions.push((*version).clone());
        }
        if cases
            .iter()
            .map(|c| &c.group)
            .collect::<BTreeSet<_>>()
            .len()
            < 4
        {
            return Err(invalid(
                "Campaign requires four independent declared groups",
            ));
        }
        let base = WorkflowPolicy {
            model_id: request.model_id.clone(),
            mode: "learned".into(),
            candidates: request.candidates.clone(),
            prior_ids: request.persona_prior_ids.clone(),
            fixed_candidate_id: None,
            min_quality: request.min_quality,
            class_model_ids: request.class_model_ids.clone(),
            class_prior_ids: BTreeMap::new(),
        };
        let mut policies = vec![base.clone()];
        let mut aggregate = base.clone();
        aggregate.mode = "aggregate".into();
        aggregate.prior_ids = aggregate_order(&fit, &request.candidates)?;
        if mixed {
            for (class, class_fit) in &fits {
                aggregate.class_prior_ids.insert(
                    class.clone(),
                    aggregate_order(class_fit, &request.candidates)?,
                );
            }
        }
        policies.push(aggregate);
        let mut persona = base.clone();
        persona.mode = "persona".into();
        policies.push(persona);
        // Campaign cases are held out, which a provider that may train on
        // submitted data never receives.
        let data_use = super::data_use::DataUse::load(&self.store.root).await;
        if let Some(reason) = request.candidates.iter().find_map(|candidate| {
            versions.iter().find_map(|version| {
                data_use.refusal(&candidate.provider_id, &version.manifest.split)
            })
        }) {
            return Err(BenchmarkError::new("validation", reason));
        }
        for candidate in &request.candidates {
            let mut fixed = base.clone();
            fixed.mode = "fixed".into();
            fixed.fixed_candidate_id = Some(candidate.id.clone());
            policies.push(fixed);
        }
        let total: u64 = cases.iter().map(|c| u64::from(c.executions())).sum::<u64>()
            * policies.len() as u64
            * u64::from(request.repetitions);
        if total > u64::from(request.max_executions) {
            return Err(invalid(
                "Campaign execution budget does not cover all policies and repetitions",
            ));
        }
        let mut evaluation = report::protocol_for_cases(fit.model.weights, &cases);
        // Freeze the corrected metric only for new step-admitted campaigns.
        // Existing plans retain their original wall-time utility contract.
        if request.parallelism.unwrap_or(1) > 1 {
            evaluation.primary_metric = report::QUEUE_EXCLUDED_METRIC.into();
        }
        let order_algorithm = if request.parallelism.unwrap_or(1) > 1 {
            STEP_ADMISSION_ORDER
        } else {
            "sha256-campaign-cell-v1"
        };
        let mut plan = Plan {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now(),
            request,
            model_snapshot_hash: fit.model.snapshot_hash.clone(),
            cases,
            policies,
            cells: vec![],
            order_algorithm: order_algorithm.into(),
            aggregate_recipe: "fitted-common-cases-equal-group-mean-utility-v1".into(),
            evaluation,
            class_snapshot_hashes: if mixed {
                fits.iter()
                    .map(|(class, class_fit)| {
                        (class.clone(), class_fit.model.snapshot_hash.clone())
                    })
                    .collect()
            } else {
                BTreeMap::new()
            },
            supersedes: Vec::new(),
        };
        for case_index in 0..plan.cases.len() {
            for policy_index in 0..plan.policies.len() {
                for repetition in 0..plan.request.repetitions {
                    plan.cells.push(Cell {
                        case_index,
                        policy_index,
                        repetition,
                    });
                }
            }
        }
        if plan.cells.len() > 10_000 {
            return Err(invalid("Campaign is limited to 10000 trajectories"));
        }
        let mut ordered = plan
            .cells
            .into_iter()
            .map(|cell| Ok((hash(&(&plan.id, &cell))?, cell)))
            .collect::<Result<Vec<_>>>()?;
        ordered.sort_by(|a, b| a.0.cmp(&b.0));
        plan.cells = ordered.into_iter().map(|(_, cell)| cell).collect();
        for policy in &plan.policies {
            let mut run = plan.run_request(0)?;
            run.workflow_policy = Some(policy.clone());
            run.configurations = vec![policy.configuration()?];
            policy.validate(self, &run, &versions).await?;
        }
        self.store.reserve_workflow_campaign(&plan).await
    }
}

async fn drafts(tx: &mut Transaction<'_, Sqlite>) -> Result<Vec<(String, String, BenchmarkDraft)>> {
    sqlx::query("SELECT id,content_hash,manifest_json FROM benchmark_versions")
        .fetch_all(&mut **tx)
        .await?
        .into_iter()
        .map(|r| {
            Ok((
                r.try_get("id")?,
                r.try_get("content_hash")?,
                serde_json::from_str(r.try_get("manifest_json")?)?,
            ))
        })
        .collect()
}
fn connected(
    versions: &[(String, String, BenchmarkDraft)],
    families: &mut BTreeSet<String>,
    groups: &mut BTreeSet<String>,
) {
    loop {
        let before = (families.len(), groups.len());
        for (_, _, draft) in versions {
            if families.contains(&draft.task_family) || groups.contains(group(draft)) {
                families.insert(draft.task_family.clone());
                groups.insert(group(draft).into());
            }
        }
        if before == (families.len(), groups.len()) {
            break;
        }
    }
}

impl Store {
    async fn workflow_campaign_retry(&self, request: &Request) -> Result<Option<Campaign>> {
        let row = sqlx::query("SELECT id,request_hash FROM workflow_campaigns WHERE request_key=?")
            .bind(&request.request_key)
            .fetch_optional(&self.pool)
            .await?;
        if let Some(row) = row {
            if row.try_get::<String, _>("request_hash")? != hash(request)? {
                return Err(invalid(
                    "Request key is already bound to a different campaign",
                ));
            }
            return self.workflow_campaign(row.try_get("id")?).await.map(Some);
        }
        Ok(None)
    }
    pub async fn workflow_campaign(&self, id: &str) -> Result<Campaign> {
        let row = sqlx::query("SELECT * FROM workflow_campaigns WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| invalid("Campaign not found"))?;
        let plan: Plan = serde_json::from_str(row.try_get("plan_json")?)?;
        let plan_hash: String = row.try_get("plan_hash")?;
        if plan.id != id || hash(&plan)? != plan_hash {
            return Err(invalid("Campaign integrity check failed"));
        }
        let mut state: String = row.try_get("state")?;
        if state == "paused" && plan.request.parallelism.unwrap_or(1) > 1 {
            // The persisted pause closes admission atomically. Its public state
            // stays pausing while owned trajectories drain their dependent steps.
            // No schema or serialized legacy plan changes are needed for this
            // projection of the already persisted child states.
            let draining: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM workflow_campaign_cells c JOIN run_plans r ON r.request_key=c.request_key WHERE c.campaign_id=? AND r.state IN ('running','pausing'))",
            )
            .bind(id).fetch_one(&self.pool).await?;
            if draining {
                state = "pausing".into();
            }
        }
        Ok(Campaign {
            plan,
            plan_hash,
            state,
            state_reason: row.try_get("state_reason")?,
            next_cell: row.try_get::<i64, _>("next_cell")? as usize,
            revision: row.try_get("revision")?,
        })
    }
    pub async fn workflow_campaigns(&self) -> Result<Vec<Campaign>> {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM workflow_campaigns ORDER BY created_at DESC,id LIMIT 100",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut result = Vec::new();
        for id in ids {
            result.push(self.workflow_campaign(&id).await?);
        }
        Ok(result)
    }
    async fn reserve_workflow_campaign(&self, plan: &Plan) -> Result<Campaign> {
        let mut plan = plan.clone();
        let mut tx = self.pool.begin().await?;
        let inserted = sqlx::query("INSERT OR IGNORE INTO workflow_campaigns(id,request_key,request_hash,plan_hash,created_at,plan_json,state) VALUES(?,?,?,?,?,?,'reserved')")
            .bind(&plan.id).bind(&plan.request.request_key).bind(hash(&plan.request)?).bind(hash(&plan)?).bind(plan.created_at).bind(serde_json::to_string(&plan)?).execute(&mut *tx).await?.rows_affected();
        if inserted == 0 {
            tx.rollback().await?;
            return self
                .workflow_campaign_retry(&plan.request)
                .await?
                .ok_or_else(|| invalid("Campaign identity conflict"));
        }
        Store::require_current_versions_in(&mut tx, &plan.request.version_ids).await?;
        let versions = drafts(&mut tx).await?;
        let selected: BTreeSet<_> = plan.cases.iter().map(|c| c.group.clone()).collect();
        for initial in &selected {
            let mut groups = BTreeSet::from([initial.clone()]);
            let mut families = BTreeSet::new();
            connected(&versions, &mut families, &mut groups);
            if groups.intersection(&selected).count() > 1 {
                return Err(invalid(
                    "Historical family relations join declared independent groups",
                ));
            }
        }
        let mut families = plan.cases.iter().map(|c| c.family.clone()).collect();
        let mut groups = selected;
        connected(&versions, &mut families, &mut groups);
        let related: BTreeSet<_> = versions
            .iter()
            .filter(|(_, _, v)| families.contains(&v.task_family) || groups.contains(group(v)))
            .map(|(id, _, _)| id)
            .collect();
        if versions
            .iter()
            .any(|(id, _, v)| related.contains(id) && v.split != "held_out")
        {
            return Err(invalid("Related campaign families cross dataset splits"));
        }
        for case in &plan.cases {
            let (_, content, draft) = versions
                .iter()
                .find(|(id, _, _)| id == &case.version_id)
                .ok_or_else(|| invalid("Campaign version disappeared"))?;
            if content != &case.content_hash || hash(draft)? != case.manifest_hash {
                return Err(invalid("Campaign version changed during reservation"));
            }
        }
        // A related family that any run already measured stays unavailable,
        // with one exception: cells of a campaign that was cancelled. Their
        // first outcomes stay as they are; this plan records which campaigns
        // it replaces, so no report presents the families as unseen.
        let cancelled: BTreeSet<String> =
            sqlx::query_scalar("SELECT id FROM workflow_campaigns WHERE state='cancelled'")
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .collect();
        let owners: BTreeMap<String, String> = sqlx::query_as::<_, (String, String)>(
            "SELECT request_key,campaign_id FROM workflow_campaign_cells",
        )
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();
        let mut supersedes = BTreeSet::new();
        let runs =
            sqlx::query_as::<_, (String, String)>("SELECT request_key,request_json FROM run_plans")
                .fetch_all(&mut *tx)
                .await?;
        for (key, body) in runs {
            let run: RunRequest = serde_json::from_str(&body)?;
            if !run.version_ids.iter().any(|id| related.contains(id)) {
                continue;
            }
            match owners.get(&key).filter(|owner| cancelled.contains(*owner)) {
                Some(owner) => {
                    supersedes.insert(owner.clone());
                }
                None => return Err(invalid("Campaign family already appeared in a run plan")),
            }
        }
        let attempted = sqlx::query_as::<_, (String, String)>(
            "SELECT DISTINCT a.version_id,r.request_key FROM attempts a JOIN run_plans r ON r.id=a.run_id",
        )
        .fetch_all(&mut *tx)
        .await?;
        for (version_id, key) in attempted {
            if related.contains(&version_id)
                && !owners
                    .get(&key)
                    .is_some_and(|owner| supersedes.contains(owner))
            {
                return Err(invalid("Campaign family already has an attempt"));
            }
        }
        for (kind, values) in [("family", families), ("group", groups)] {
            for value in values {
                if sqlx::query("INSERT OR IGNORE INTO evaluation_reservations(kind,value,owner_kind,owner_id) VALUES(?,?,'workflow_campaign',?)")
                .bind(kind).bind(&value).bind(&plan.id).execute(&mut *tx).await?.rows_affected() == 0 {
                    // The replaced campaign hands its reservation over; any
                    // other owner keeps the family.
                    let moved = sqlx::query("UPDATE evaluation_reservations SET owner_id=? WHERE kind=? AND value=? AND owner_kind='workflow_campaign' AND owner_id IN (SELECT id FROM workflow_campaigns WHERE state='cancelled')")
                        .bind(&plan.id).bind(kind).bind(&value).execute(&mut *tx).await?.rows_affected();
                    if moved == 0 {
                        return Err(invalid("Family is reserved by another evaluation"));
                    }
                }
            }
        }
        if !supersedes.is_empty() {
            plan.supersedes = supersedes.into_iter().collect();
            sqlx::query("UPDATE workflow_campaigns SET plan_json=?,plan_hash=? WHERE id=?")
                .bind(serde_json::to_string(&plan)?)
                .bind(hash(&plan)?)
                .bind(&plan.id)
                .execute(&mut *tx)
                .await?;
        }
        for index in 0..plan.cells.len() {
            let run = plan.run_request(index)?;
            sqlx::query("INSERT INTO workflow_campaign_cells(request_key,campaign_id,cell_index,request_hash) VALUES(?,?,?,?)")
                .bind(&run.request_key).bind(&plan.id).bind(index as i64).bind(hash(&run)?).execute(&mut *tx).await?;
        }
        event(&mut tx, &plan.id, "workflow_campaign_reserved").await?;
        tx.commit().await?;
        self.workflow_campaign(&plan.id).await
    }
    pub(super) async fn workflow_campaign_owns(&self, key: &str) -> Result<bool> {
        Ok(sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM workflow_campaign_cells WHERE request_key=?)",
        )
        .bind(key)
        .fetch_one(&self.pool)
        .await?)
    }
    pub(super) async fn workflow_campaign_parallelism(&self, key: &str) -> Result<u32> {
        Ok(self.workflow_campaign_concurrency(key).await?.parallelism)
    }
    /// The frozen concurrency contract of the campaign owning `key`; an
    /// ordinary run is serial.
    pub(super) async fn workflow_campaign_concurrency(
        &self,
        key: &str,
    ) -> Result<CampaignConcurrency> {
        let id: Option<String> = sqlx::query_scalar(
            "SELECT campaign_id FROM workflow_campaign_cells WHERE request_key=?",
        )
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        let Some(id) = id else {
            return Ok(CampaignConcurrency::SERIAL);
        };
        let plan = self.workflow_campaign(&id).await?.plan;
        let parallelism = plan.request.parallelism.unwrap_or(1);
        let admission = match plan.order_algorithm.as_str() {
            "sha256-campaign-cell-v1" => WorkerAdmission::Serial,
            "sha256-campaign-cell-bounded-refill-v2" => WorkerAdmission::QueueInClock,
            RESERVED_WORKERS_ORDER => WorkerAdmission::ReservedPool,
            STEP_ADMISSION_ORDER => WorkerAdmission::SelectedStep,
            _ => return Err(invalid("Unsupported campaign worker admission recipe")),
        };
        Ok(CampaignConcurrency {
            parallelism,
            admission,
            account_slots: plan
                .request
                .account_slots
                .map_or(super::runner::ACCOUNT_SLOTS, |slots| slots as usize),
        })
    }
    pub(super) async fn require_independent_run(&self, key: &str) -> Result<()> {
        if self.workflow_campaign_owns(key).await? {
            return Err(invalid(
                "Control the frozen campaign; its first cell attempts cannot be replaced or edited",
            ));
        }
        Ok(())
    }
    pub(super) async fn park_workflow_campaigns(&self) -> Result<()> {
        sqlx::query("UPDATE workflow_campaigns SET state='paused',state_reason='Application stopped; explicit resume is required',revision=revision+1 WHERE state='running'").execute(&self.pool).await?;
        Ok(())
    }
}

/// Called under the run admission's writer lock, before any attempt is admitted.
pub(super) async fn check_admission(
    tx: &mut Transaction<'_, Sqlite>,
    request: &RunRequest,
) -> Result<()> {
    let registered = sqlx::query("SELECT c.campaign_id,c.cell_index,c.request_hash,p.state,p.next_cell,p.plan_json FROM workflow_campaign_cells c JOIN workflow_campaigns p ON p.id=c.campaign_id WHERE c.request_key=?")
        .bind(&request.request_key).fetch_optional(&mut **tx).await?;
    let owner: Option<String> = if let Some(row) = registered {
        let plan: Plan = serde_json::from_str(row.try_get("plan_json")?)?;
        let parallelism = plan.request.parallelism.unwrap_or(1);
        let in_order = if parallelism > 1 {
            // start_run inserted the current child under this same writer lock.
            // Earlier children must all exist; unfinished children still own slots
            // until their first result has been collected, regardless of run state.
            let (admitted, unfinished): (i64, i64) = sqlx::query_as(
                "SELECT COUNT(*),COALESCE(SUM(c.result_json IS NULL),0) FROM workflow_campaign_cells c JOIN run_plans r ON r.request_key=c.request_key WHERE c.campaign_id=? AND c.request_key<>?",
            )
            .bind(&plan.id).bind(&request.request_key).fetch_one(&mut **tx).await?;
            row.try_get::<i64, _>("cell_index")? == admitted && unfinished < i64::from(parallelism)
        } else {
            row.try_get::<i64, _>("cell_index")? == row.try_get::<i64, _>("next_cell")?
        };
        if row.try_get::<String, _>("request_hash")? != hash(request)?
            || row.try_get::<String, _>("state")? != "running"
            || !in_order
        {
            return Err(invalid(
                "Campaign cell is changed, out of order or not running",
            ));
        }
        Some(row.try_get("campaign_id")?)
    } else {
        None
    };
    check_reserved_versions(tx, &request.version_ids, owner.as_deref()).await
}
pub(super) async fn check_reserved_versions(
    tx: &mut Transaction<'_, Sqlite>,
    ids: &[String],
    owner: Option<&str>,
) -> Result<()> {
    let reservations = sqlx::query("SELECT kind,value,owner_id FROM evaluation_reservations WHERE owner_kind='workflow_campaign'").fetch_all(&mut **tx).await?;
    if reservations.is_empty() {
        return Ok(());
    }
    let versions = drafts(tx).await?;
    let mut families = BTreeSet::new();
    let mut groups = BTreeSet::new();
    for (id, _, v) in &versions {
        if ids.contains(id) {
            families.insert(v.task_family.clone());
            groups.insert(group(v).into());
        }
    }
    connected(&versions, &mut families, &mut groups);
    for row in reservations {
        let value: String = row.try_get("value")?;
        let belongs = if row.try_get::<String, _>("kind")? == "family" {
            families.contains(&value)
        } else {
            groups.contains(&value)
        };
        if belongs && Some(row.try_get::<String, _>("owner_id")?.as_str()) != owner {
            return Err(invalid(
                "Workflow campaign families can only run in their frozen campaign",
            ));
        }
    }
    Ok(())
}

impl BenchmarkService {
    /// Check only the cells about to enter the scheduler. Unavailable
    /// alternatives remain in adaptive policies; a fixed policy still needs
    /// its exact worker. This does not select a step or start its clock.
    pub(super) async fn require_ready_campaign_cells(
        &self,
        plan: &Plan,
        indices: &[usize],
    ) -> Result<()> {
        if plan.order_algorithm != STEP_ADMISSION_ORDER || indices.is_empty() {
            return Ok(());
        }
        let mut inventories = BTreeMap::new();
        let mut readiness = BTreeMap::new();
        let mut activity = BTreeMap::new();
        let mut versions = BTreeMap::new();
        for &index in indices {
            let cell = plan
                .cells
                .get(index)
                .ok_or_else(|| invalid("Unknown campaign cell"))?;
            let policy = &plan.policies[cell.policy_index];
            let version_id = &plan.cases[cell.case_index].version_id;
            if !versions.contains_key(version_id) {
                versions.insert(version_id.clone(), self.store.version(version_id).await?);
            }
            let version = &versions[version_id];
            let mut ready = false;
            for candidate in policy.candidates.iter().filter(|candidate| {
                policy.mode != "fixed" || policy.fixed_candidate_id.as_ref() == Some(&candidate.id)
            }) {
                let key = (candidate.provider_id.clone(), candidate.account_id.clone());
                if !inventories.contains_key(&key) {
                    let inventory = self
                        .backend
                        .inventory(
                            &candidate.provider_id,
                            candidate.account_id.as_deref(),
                            true,
                        )
                        .await;
                    inventories.insert(key.clone(), inventory);
                }
                let available = inventories[&key].as_ref().is_ok_and(|rows| {
                    rows.iter()
                        .any(|row| super::task_execution::inventory_acknowledges(row, candidate))
                });
                if !available
                    || self
                        .backend
                        .unsupported(candidate, &version.manifest)
                        .is_some()
                {
                    continue;
                }
                if !activity.contains_key(&key) {
                    activity.insert(
                        key.clone(),
                        self.backend
                            .activity(candidate)
                            .await
                            .is_ok_and(|state| state.active_sessions.is_empty()),
                    );
                }
                if !activity[&key] {
                    continue;
                }
                let candidate_key = hash(candidate)?;
                if !readiness.contains_key(&candidate_key) {
                    readiness.insert(
                        candidate_key.clone(),
                        self.backend
                            .readiness_for_budget(candidate, plan.request.timeout_seconds)
                            .await
                            .is_ok(),
                    );
                }
                if readiness[&candidate_key] {
                    ready = true;
                    break;
                }
            }
            if !ready {
                return Err(BenchmarkError::new(
                    "campaign_not_ready",
                    format!(
                        "Workflow {} ({}) has no ready worker matching its frozen settings and runtime; restore provider readiness before starting or resuming. No new workflow was admitted",
                        index + 1,
                        policy.mode,
                    ),
                ));
            }
        }
        Ok(())
    }

    async fn require_ready_campaign_control(&self, saved: &Campaign) -> Result<()> {
        if saved.plan.order_algorithm != STEP_ADMISSION_ORDER {
            return Ok(());
        }
        let rows = sqlx::query(
            "SELECT c.cell_index,a.phase FROM workflow_campaign_cells c JOIN run_plans r ON r.request_key=c.request_key JOIN attempts a ON a.run_id=r.id WHERE c.campaign_id=? ORDER BY c.cell_index",
        )
        .bind(&saved.plan.id)
        .fetch_all(&self.store.pool)
        .await?;
        let mut indices = Vec::new();
        for row in &rows {
            if row.try_get::<String, _>("phase")? != "terminal" {
                indices.push(row.try_get::<i64, _>("cell_index")? as usize);
            }
        }
        let available =
            (saved.plan.request.parallelism.unwrap_or(1) as usize).saturating_sub(indices.len());
        indices.extend(rows.len()..(rows.len() + available).min(saved.plan.cells.len()));
        self.require_ready_campaign_cells(&saved.plan, &indices)
            .await
    }

    pub async fn control_workflow_campaign(&self, id: &str, action: &str) -> Result<Campaign> {
        let saved = self.store.workflow_campaign(id).await?;
        let state = match (action, saved.state.as_str()) {
            ("start", "reserved") | ("resume", "paused") => "running",
            ("pause", "running" | "pausing" | "paused") => "paused",
            ("cancel", "reserved" | "running" | "pausing" | "paused" | "cancelled") => "cancelled",
            _ => return Err(invalid("Campaign does not permit this transition")),
        };
        if state == "running" {
            self.require_ready_campaign_control(&saved).await?;
        }
        let mut tx = self.store.pool.begin().await?;
        if sqlx::query(
            "UPDATE workflow_campaigns SET state=?,state_reason=NULL,revision=revision+1 WHERE id=? AND revision=?",
        )
        .bind(state)
        .bind(id)
        .bind(saved.revision)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            != 1
        {
            return Err(invalid("Campaign changed; reload before controlling it"));
        }
        let children = scheduler::control_children(&mut tx, id, state).await?;
        event(&mut tx, id, "workflow_campaign_changed").await?;
        tx.commit().await?;
        if state == "cancelled" {
            for flight in self.active.lock().await.values() {
                if children.contains(&flight.run_id) {
                    let _ = flight.cancel.send(true);
                }
            }
        }
        self.wake.notify_one();
        self.changed().await;
        self.store.workflow_campaign(id).await
    }
}

pub(super) async fn tick(service: &BenchmarkService) -> Result<()> {
    // Keep the admission future out of the enclosing runner's inline state.
    // It owns complete plans and run requests while awaiting SQLite.
    Box::pin(scheduler::tick(service)).await?;
    // Query every running campaign; the bounded operator list is not a scheduler.
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM workflow_campaigns WHERE state='running' ORDER BY created_at,id",
    )
    .fetch_all(&service.store.pool)
    .await?;
    for id in ids {
        let saved = service.store.workflow_campaign(&id).await?;
        if saved.state != "running" {
            continue;
        }
        if saved.plan.request.parallelism.unwrap_or(1) > 1 {
            continue;
        }
        let request = saved.plan.run_request(saved.next_cell)?;
        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM run_plans WHERE request_key=?")
                .bind(&request.request_key)
                .fetch_optional(&service.store.pool)
                .await?;
        let mut next = saved.next_cell;
        let mut state = "running";
        let mut reason = None;
        let mut result = None;
        if let Some(run_id) = existing {
            let run = service.store.run(&run_id).await?;
            if hash(&run.request)? != hash(&request)? || run.attempts.len() != 1 {
                return Err(invalid("Campaign cell evidence changed"));
            }
            let root = &run.attempts[0];
            if root.phase == "terminal" {
                result = Some(service.store.workflow_trace(&root.id).await?);
                next += 1;
                if super::analysis::score(root).is_none() {
                    state = "paused";
                    reason = Some(root.reason.clone().unwrap_or_else(|| "First trajectory is unscored; resume preserves it and continues remaining cells".into()));
                }
                if next == saved.plan.cells.len() {
                    state = "completed";
                }
            } else if matches!(
                run.state.as_str(),
                "paused" | "pausing" | "needs_attention" | "cancelled" | "cancelling"
            ) {
                state = "paused";
                reason = Some(format!("Current trajectory is {}", run.state));
            }
        } else if let Err(error) = service.start_run(request.clone()).await {
            state = "paused";
            reason = Some(error.message);
        }
        if next == saved.next_cell && state == "running" {
            continue;
        }
        let mut tx = service.store.pool.begin().await?;
        if sqlx::query("UPDATE workflow_campaigns SET next_cell=?,state=?,state_reason=?,revision=revision+1 WHERE id=? AND revision=? AND state='running'")
            .bind(next as i64).bind(state).bind(reason).bind(&id).bind(saved.revision).execute(&mut *tx).await?.rows_affected() == 0 { continue; }
        if let Some(result) = result {
            sqlx::query("UPDATE workflow_campaign_cells SET result_json=?,result_hash=? WHERE request_key=? AND result_json IS NULL")
            .bind(serde_json::to_string(&result)?).bind(hash(&result)?).bind(&request.request_key).execute(&mut *tx).await?;
        }
        event(&mut tx, &id, "workflow_campaign_changed").await?;
        tx.commit().await?;
        service.changed().await;
    }
    Ok(())
}

pub(super) async fn refill(service: &BenchmarkService) -> Result<()> {
    Box::pin(scheduler::tick(service)).await
}
