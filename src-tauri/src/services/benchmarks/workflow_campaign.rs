//! Frozen, serial comparisons of complete research workflows. No promotion.
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
        {
            return Err(invalid("Campaign requires distinct held-out cases, a request key and bounded repetitions, time and executions"));
        }
        if let Some(saved) = self.store.workflow_campaign_retry(&request).await? {
            return Ok(saved);
        }
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
        let evaluation = report::protocol_for_cases(fit.model.weights, &cases);
        let mut plan = Plan {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now(),
            request,
            model_snapshot_hash: fit.model.snapshot_hash.clone(),
            cases,
            policies,
            cells: vec![],
            order_algorithm: "sha256-campaign-cell-v1".into(),
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
        Ok(Campaign {
            plan,
            plan_hash,
            state: row.try_get("state")?,
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
        let mut tx = self.pool.begin().await?;
        let inserted = sqlx::query("INSERT OR IGNORE INTO workflow_campaigns(id,request_key,request_hash,plan_hash,created_at,plan_json,state) VALUES(?,?,?,?,?,?,'reserved')")
            .bind(&plan.id).bind(&plan.request.request_key).bind(hash(&plan.request)?).bind(hash(plan)?).bind(plan.created_at).bind(serde_json::to_string(plan)?).execute(&mut *tx).await?.rows_affected();
        if inserted == 0 {
            tx.rollback().await?;
            return self
                .workflow_campaign_retry(&plan.request)
                .await?
                .ok_or_else(|| invalid("Campaign identity conflict"));
        }
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
        let runs: Vec<String> = sqlx::query_scalar("SELECT request_json FROM run_plans")
            .fetch_all(&mut *tx)
            .await?;
        for body in runs {
            let run: RunRequest = serde_json::from_str(&body)?;
            if run.version_ids.iter().any(|id| related.contains(id)) {
                return Err(invalid("Campaign family already appeared in a run plan"));
            }
        }
        let attempted: Vec<String> = sqlx::query_scalar("SELECT DISTINCT version_id FROM attempts")
            .fetch_all(&mut *tx)
            .await?;
        if attempted.iter().any(|id| related.contains(id)) {
            return Err(invalid("Campaign family already has an attempt"));
        }
        for (kind, values) in [("family", families), ("group", groups)] {
            for value in values {
                if sqlx::query("INSERT OR IGNORE INTO evaluation_reservations(kind,value,owner_kind,owner_id) VALUES(?,?,'workflow_campaign',?)")
                .bind(kind).bind(value).bind(&plan.id).execute(&mut *tx).await?.rows_affected() == 0 { return Err(invalid("Family is reserved by another evaluation")); }
            }
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
    let registered = sqlx::query("SELECT c.campaign_id,c.cell_index,c.request_hash,p.state,p.next_cell FROM workflow_campaign_cells c JOIN workflow_campaigns p ON p.id=c.campaign_id WHERE c.request_key=?")
        .bind(&request.request_key).fetch_optional(&mut **tx).await?;
    let owner: Option<String> = if let Some(row) = registered {
        if row.try_get::<String, _>("request_hash")? != hash(request)?
            || row.try_get::<String, _>("state")? != "running"
            || row.try_get::<i64, _>("cell_index")? != row.try_get::<i64, _>("next_cell")?
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
    pub async fn control_workflow_campaign(&self, id: &str, action: &str) -> Result<Campaign> {
        let saved = self.store.workflow_campaign(id).await?;
        let state = match (action, saved.state.as_str()) {
            ("start", "reserved") | ("resume", "paused") => "running",
            ("pause", "running" | "paused") => "paused",
            ("cancel", "reserved" | "running" | "paused" | "cancelled") => "cancelled",
            _ => return Err(invalid("Campaign does not permit this transition")),
        };
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
        let key = saved
            .plan
            .run_request(saved.next_cell)
            .ok()
            .map(|r| r.request_key);
        let child: Option<String> = if let Some(key) = key {
            sqlx::query_scalar("SELECT id FROM run_plans WHERE request_key=?")
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?
        } else {
            None
        };
        if let Some(child) = &child {
            // Resume changes state only. Terminal/uncertain first attempts are
            // retained; the ordinary partial-cell retry path is never called.
            let (next, eligible) = match state {
                "running" => ("running", "'paused','needs_attention'"),
                "paused" => ("pausing", "'running'"),
                _ => (
                    "cancelling",
                    "'running','pausing','paused','needs_attention'",
                ),
            };
            sqlx::query(&format!("UPDATE run_plans SET state=?,revision=revision+1,updated_at=? WHERE id=? AND state IN ({eligible})"))
                .bind(next).bind(now()).bind(child).execute(&mut *tx).await?;
        }
        event(&mut tx, id, "workflow_campaign_changed").await?;
        tx.commit().await?;
        if state == "cancelled" {
            for flight in self.active.lock().await.values() {
                if Some(&flight.run_id) == child.as_ref() {
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
