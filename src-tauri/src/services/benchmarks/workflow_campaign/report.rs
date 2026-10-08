//! First planned whole trajectories, including every registered repetition.
use super::*;
use crate::services::benchmarks::{learned::report::*, selector::RoleWeights, workflow::Trace};

pub(super) fn protocol(weights: RoleWeights) -> ReportProtocol {
    let mut value = ReportProtocol::new(weights);
    value.recipe = "workflow-first-trajectory-paired-v1".into();
    value.cell_selection = "frozen_campaign_order_first_root_all_repetitions_no_replacement".into();
    value.score_selection = "first_terminal_snapshot_published_objective_evaluator".into();
    value.primary_metric =
        "quality_weighted_relative_whole_wall_time_reported_cost_requires_resources".into();
    value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub campaign_id: String,
    pub plan_hash: String,
    pub artifact_hash: String,
    pub created_at: i64,
    pub protocol: ReportProtocol,
    pub trace_hashes: Vec<String>,
    pub cases: Vec<ReportCase>,
    pub policies: Vec<PolicyResult>,
    pub groups: usize,
    pub dispatch_allowed: bool,
    pub limitations: Vec<String>,
}
fn incomplete(message: &str) -> BenchmarkError {
    BenchmarkError::new("incomplete_workflow_evidence", message)
}
fn mean(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    let values: Option<Vec<_>> = values.collect();
    values
        .filter(|v| !v.is_empty())
        .map(|v| v.iter().sum::<f64>() / v.len() as f64)
}
fn arm_key(policy: &WorkflowPolicy) -> String {
    policy
        .fixed_candidate_id
        .as_ref()
        .map(|id| format!("worker:{id}"))
        .unwrap_or_else(|| policy.mode.clone())
}

impl Store {
    pub async fn workflow_campaign_report(&self, id: &str) -> Result<Report> {
        let saved = self.workflow_campaign(id).await?;
        if let Some(row) = sqlx::query(
            "SELECT report_json,report_hash FROM workflow_campaign_reports WHERE campaign_id=?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        {
            let report: Report = serde_json::from_str(row.try_get("report_json")?)?;
            let mut body = report.clone();
            body.artifact_hash.clear();
            if hash(&body)? != report.artifact_hash
                || report.artifact_hash != row.try_get::<String, _>("report_hash")?
                || report.plan_hash != saved.plan_hash
            {
                return Err(invalid("Workflow report integrity check failed"));
            }
            return Ok(report);
        }
        if saved.state != "completed" || saved.next_cell != saved.plan.cells.len() {
            return Err(incomplete(
                "Every registered trajectory must settle before reporting",
            ));
        }
        let plan = &saved.plan;
        let fit = self.selector_fit(&plan.request.model_id).await?;
        let mut class_changed =
            plan.class_snapshot_hashes.len() != plan.request.class_model_ids.len();
        for (class, id) in &plan.request.class_model_ids {
            class_changed |= plan.class_snapshot_hashes.get(class)
                != Some(&self.selector_model(id).await?.snapshot_hash);
        }
        if fit.model.snapshot_hash != plan.model_snapshot_hash
            || class_changed
            || hash(&protocol(fit.model.weights))? != hash(&plan.evaluation)?
        {
            return Err(invalid(
                "Workflow report protocol or fitted snapshot changed",
            ));
        }
        let mut evidence: BTreeMap<(usize, usize), Vec<RepeatEvidence>> = BTreeMap::new();
        let mut trace_hashes = Vec::new();
        let mut first_runs = BTreeMap::new();
        let mut fallback_cases = BTreeSet::new();
        for (index, cell) in plan.cells.iter().enumerate() {
            let request = plan.run_request(index)?;
            let row = sqlx::query("SELECT request_hash,result_json,result_hash FROM workflow_campaign_cells WHERE request_key=?").bind(&request.request_key).fetch_one(&self.pool).await?;
            let body: Option<String> = row.try_get("result_json")?;
            let trace: Trace = serde_json::from_str(
                &body.ok_or_else(|| incomplete("First trajectory snapshot is missing"))?,
            )?;
            let trace_hash: Option<String> = row.try_get("result_hash")?;
            let digest = hash(&trace)?;
            let case = &plan.cases[cell.case_index];
            let version = self.version(&case.version_id).await?;
            if trace_hash.as_ref() != Some(&digest)
                || row.try_get::<String, _>("request_hash")? != hash(&request)?
                || hash(&trace.policy)? != hash(&request.workflow_policy)?
                || trace.root.version_id != case.version_id
                || trace.root.configuration != request.configurations[0]
                || hash(&version.manifest)? != case.manifest_hash
                || version.content_hash != case.content_hash
            {
                return Err(invalid("Frozen workflow trajectory integrity check failed"));
            }
            let mut repeat = first_score(&trace.root, &case.evaluator_revision, plan.created_at)?;
            if plan.policies[cell.policy_index].mode == "learned"
                && trace.steps.iter().any(|s| {
                    s.executor_decision
                        .as_ref()
                        .is_none_or(|d| d.source != "research_learned")
                })
            {
                fallback_cases.insert(cell.case_index);
            }
            first_runs
                .entry((cell.case_index, cell.policy_index))
                .or_insert_with(|| trace.root.run_id.clone());
            if repeat.evidence_hash.is_none() {
                return Err(incomplete("Whole workflow evidence is not sealed"));
            }
            // Complete successes require actual observed settings and committed
            // per-step decisions. A missing acknowledgement is not a match.
            if repeat.quality > 0.0
                && (trace.steps.len() != case.steps as usize
                    || trace.steps.iter().any(|s| {
                        s.executor_decision
                            .as_ref()
                            .and_then(|d| d.chosen.as_ref())
                            .is_none_or(|c| c != &s.attempt.configuration)
                            || s.input_hash.is_none()
                            || s.attempt.evidence_hash.is_none()
                            || s.attempt.observed.as_ref().is_none_or(|c| {
                                routing::candidate_key(c)
                                    != routing::candidate_key(&s.attempt.configuration)
                                    || c.inventory_revision
                                        != s.attempt.configuration.inventory_revision
                            })
                    }))
            {
                return Err(incomplete(
                    "Successful trajectory lacks committed or observed executor evidence",
                ));
            }
            repeat.repetition = cell.repetition;
            repeat.duration_ms = trace
                .root
                .started_at
                .zip(trace.root.finished_at)
                .filter(|(a, b)| b >= a)
                .map(|(a, b)| (b - a) as f64);
            evidence
                .entry((cell.case_index, cell.policy_index))
                .or_default()
                .push(repeat);
            trace_hashes.push(digest);
        }
        let mut cases = Vec::new();
        for (case_index, case) in plan.cases.iter().enumerate() {
            let mut cells = Vec::new();
            for (policy_index, policy) in plan.policies.iter().enumerate() {
                let mut repeats = evidence
                    .remove(&(case_index, policy_index))
                    .ok_or_else(|| incomplete("Policy trajectory is absent"))?;
                repeats.sort_by_key(|r| r.repetition);
                if repeats.len() != plan.request.repetitions as usize
                    || repeats
                        .iter()
                        .enumerate()
                        .any(|(i, r)| r.repetition as usize != i)
                {
                    return Err(incomplete("All planned repetitions are required"));
                }
                cells.push(ReportCell {
                    candidate_key: arm_key(policy),
                    run_id: first_runs[&(case_index, policy_index)].clone(),
                    quality: mean(repeats.iter().map(|r| Some(r.quality))).expect("nonempty"),
                    utility: 0.0,
                    mean_duration_ms: mean(repeats.iter().map(|r| r.duration_ms)),
                    mean_cost: mean(repeats.iter().map(|r| r.cost)),
                    repeats,
                });
            }
            let weights = plan.evaluation.weights;
            let successful: Vec<_> = cells.iter().filter(|c| c.quality > 0.0).collect();
            let fastest = mean(successful.iter().map(|c| c.mean_duration_ms)).map(|_| {
                successful
                    .iter()
                    .filter_map(|c| c.mean_duration_ms)
                    .min_by(f64::total_cmp)
                    .unwrap()
            });
            let cheapest = mean(successful.iter().map(|c| c.mean_cost)).map(|_| {
                successful
                    .iter()
                    .filter_map(|c| c.mean_cost)
                    .min_by(f64::total_cmp)
                    .unwrap()
            });
            if !successful.is_empty()
                && (weights.speed > 0.0 && fastest.is_none()
                    || weights.cost > 0.0 && cheapest.is_none())
            {
                return Err(incomplete("Weighted resources are unknown; no utility or replacement score can be inferred"));
            }
            let share = |best: Option<f64>, own: Option<f64>| match (best, own) {
                (Some(b), Some(o)) if o > 0.0 => (b / o).min(1.0),
                (Some(_), Some(_)) => 1.0,
                _ => 0.0,
            };
            for cell in &mut cells {
                cell.utility = cell.quality
                    * (weights.quality
                        + weights.speed * share(fastest, cell.mean_duration_ms)
                        + weights.cost * share(cheapest, cell.mean_cost))
                    / (weights.quality + weights.speed + weights.cost);
            }
            cases.push(ReportCase {
                version_id: case.version_id.clone(),
                group: case.group.clone(),
                learned_key: "learned".into(),
                aggregate_key: "aggregate".into(),
                used_fallback: fallback_cases.contains(&case_index),
                cells,
            });
        }
        let keys: Vec<_> = plan
            .request
            .candidates
            .iter()
            .map(|c| format!("worker:{}", c.id))
            .collect();
        let mut policies: Vec<String> = ["learned", "aggregate", "persona", "best_fixed", "oracle"]
            .into_iter()
            .map(String::from)
            .collect();
        policies.extend(keys.iter().map(|k| format!("fixed:{k}")));
        let mut report = Report { campaign_id:plan.id.clone(),plan_hash:saved.plan_hash,artifact_hash:String::new(),created_at:now(),protocol:plan.evaluation.clone(),trace_hashes,
            policies:summarize_policies(&cases,&plan.evaluation,&policies,&keys,"persona"),groups:cases.iter().map(|c| &c.group).collect::<BTreeSet<_>>().len(),cases,dispatch_allowed:false,
            limitations:vec!["Declared groups still require independent semantic and grader qualification".into(),"Equal-group paired percentile intervals are exploratory, conditional on recorded repetitions, and unadjusted for multiple comparisons".into(),"Best fixed is reselected within every resample; oracle is the hindsight best registered whole-trajectory policy per case, not a deployable step oracle".into(),"Wall time includes orchestration and interruptions; cost is provider-reported generation cost, with absent resources left unknown".into(),"This research report grants no production promotion or deployment-scope authority".into()] };
        report.artifact_hash = hash(&report)?;
        sqlx::query("INSERT OR IGNORE INTO workflow_campaign_reports(campaign_id,report_json,report_hash) VALUES(?,?,?)").bind(id).bind(serde_json::to_string(&report)?).bind(&report.artifact_hash).execute(&self.pool).await?;
        // Concurrent readers return the same stored artifact, including timestamp.
        let body: String = sqlx::query_scalar(
            "SELECT report_json FROM workflow_campaign_reports WHERE campaign_id=?",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await?;
        Ok(serde_json::from_str(&body)?)
    }
}
