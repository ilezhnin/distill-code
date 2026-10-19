//! Class certificates from a preregistered executor holdout: the frozen
//! learned choices of one class, measured once on unseen families. Such a
//! certificate speaks for the class's ordinary chats and waves; owned native
//! deployments still need a workflow campaign certificate, so policy
//! discovery for them never reads this table.
use super::*;
use crate::services::benchmarks::learned::{
    holdout::HoldoutPlan,
    report::{HoldoutReport, ReportCase},
};

pub(super) const SOURCE: &str = "executor_holdout";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HoldoutRegistration {
    pub request_key: String,
    pub plan_id: String,
    pub operator: String,
    pub rule: acceptance::Rule,
    /// Attested first qualifications of every frozen held-out version.
    pub qualification_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredHoldoutRule {
    pub request: HoldoutRegistration,
    pub created_at: i64,
    pub plan_hash: String,
    pub qualification_hashes: Vec<String>,
    pub artifact_hash: String,
}

/// The report's candidate cells as the acceptance arms: each frozen policy's
/// pick per case, and every fixed worker.
fn policy_cases(report: &HoldoutReport, persona: &str) -> Result<Vec<ReportCase>> {
    report
        .cases
        .iter()
        .map(|case| {
            let pick = |policy: &str, key: &str| {
                let mut cell = case
                    .cells
                    .iter()
                    .find(|c| c.candidate_key == key)
                    .cloned()
                    .ok_or_else(|| invalid("A frozen policy names an unmeasured candidate"))?;
                cell.candidate_key = policy.into();
                Ok::<_, BenchmarkError>(cell)
            };
            let mut cells = vec![
                pick("learned", &case.learned_key)?,
                pick("aggregate", &case.aggregate_key)?,
                pick("persona", persona)?,
            ];
            cells.extend(case.cells.iter().map(|cell| {
                let mut cell = cell.clone();
                cell.candidate_key = format!("worker:{}", cell.candidate_key);
                cell
            }));
            Ok(ReportCase {
                cells,
                ..case.clone()
            })
        })
        .collect()
}

/// How one counted repetition relates to the renderer its qualification
/// verified: `None` when an evaluation names another renderer (or, for
/// browser checks, another worker) or a graded repetition names none;
/// `Some(true)` when it names the qualified one; `Some(false)` for a zero
/// scored without the renderer: a budget failure without a grader, or a
/// rubric answer without any markup to render (a native structural zero).
fn qualified_renderer_grading(
    evaluations: &[&Evaluation],
    installed: &str,
    worker: Option<&str>,
) -> Option<bool> {
    let mut named = false;
    for details in evaluations.iter().filter_map(|e| e.details.as_ref()) {
        if let Some(revision) = details.get("installedRevision") {
            if revision.as_str() != Some(installed)
                || worker.is_some_and(|w| details["runtimeRevision"].as_str() != Some(w))
            {
                return None;
            }
            named = true;
        }
        if let Some(revision) = details.pointer("/protocol/installedRendererRevision") {
            if revision.as_str() != Some(installed) {
                return None;
            }
            named = true;
        }
    }
    // Browser checks never produce an objective verdict; the rubric's
    // structural zero is the one judge_panel::validate_evidence accepts.
    let structural_zero = worker.is_none()
        && evaluations
            .iter()
            .all(|e| e.provenance == "objective" && e.verdict == "fail" && e.score == Some(0.0));
    match (named, evaluations.is_empty() || structural_zero) {
        (true, _) => Some(true),
        (false, true) => Some(false),
        (false, false) => None,
    }
}

/// The groups the report lost to unusable first cells stay within the
/// tolerance the rule registered before any measurement (none by default).
fn within_tolerance(report: &HoldoutReport, rule: &acceptance::Rule) -> Result<()> {
    let lost = report
        .excluded
        .iter()
        .map(|e| &e.group)
        .collect::<BTreeSet<_>>()
        .len();
    let tolerated = rule.max_incomplete_groups.unwrap_or(0) as usize;
    if lost > tolerated {
        return Err(invalid(format!(
            "{lost} held-out groups have an unusable first measurement; the registered rule tolerates {tolerated}"
        )));
    }
    Ok(())
}

impl Store {
    /// The frozen held-out versions qualify before their reservation, on the
    /// exact published content and evaluator the plan froze. With
    /// `installed_renderer`, a renderer-bound qualification must also name
    /// the renderer installed now; promotion instead checks the renderer that
    /// graded the counted attempts.
    async fn holdout_qualifications(
        &self,
        plan: &HoldoutPlan,
        ids: &[String],
        installed_renderer: bool,
    ) -> Result<Vec<qualification::Binding>> {
        let mut covered = BTreeSet::new();
        let mut bindings = Vec::new();
        for id in ids {
            let record = self.qualification(id).await?;
            let binding = self
                .qualification_bindings(&record.request.version_id)
                .await?
                .into_iter()
                .find(|b| &b.id == id)
                .ok_or_else(|| invalid("Qualification binding disappeared"))?;
            let version = self.version(&binding.version_id).await?;
            qualification::validate_protocol(&record, &version)?;
            if installed_renderer {
                Box::pin(qualification::validate_renderer_runtime(&record, &version)).await?;
            }
            let frozen = plan
                .cases
                .iter()
                .find(|case| case.version_id == binding.version_id);
            if frozen.is_none_or(|case| {
                case.content_hash != version.content_hash
                    || case.evaluator_revision != binding.evaluator_revision
            }) || !covered.insert(binding.version_id.clone())
                || binding.revoked_at.is_some()
                || binding.status != "controls_verified_review_attested"
                || record.finished_at.is_none_or(|at| at >= plan.created_at)
                || binding.content_hash != version.content_hash
                || binding.manifest_hash != hash(&version.manifest)?
                || binding.evaluator_revision != version.manifest.evaluator.revision
            {
                return Err(invalid(
                    "Every frozen held-out version needs its exact unrevoked first qualification before the reservation",
                ));
            }
            bindings.push(binding);
        }
        if covered.len() != plan.cases.len() {
            return Err(invalid("Qualification coverage is incomplete"));
        }
        bindings.sort_by(|a, b| a.version_id.cmp(&b.version_id));
        Ok(bindings)
    }

    /// Every stored version in the family/group component the plan reserved,
    /// sibling revisions and renamed relatives included.
    async fn holdout_component(&self, plan: &HoldoutPlan) -> Result<Vec<String>> {
        let reserved: Vec<(String, String)> =
            sqlx::query_as("SELECT kind,value FROM selector_holdout_reservations WHERE plan_id=?")
                .bind(&plan.id)
                .fetch_all(&self.pool)
                .await?;
        let wanted = |kind: &str| -> BTreeSet<String> {
            reserved
                .iter()
                .filter(|(k, _)| k == kind)
                .map(|(_, v)| v.clone())
                .collect()
        };
        let (mut families, mut groups) = (wanted("family"), wanted("group"));
        let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as("SELECT id,CASE WHEN json_type(manifest_json,'$.taskFamily')='text' THEN json_extract(manifest_json,'$.taskFamily') END,CASE WHEN json_type(manifest_json,'$.environment.splitGroup')='text' THEN json_extract(manifest_json,'$.environment.splitGroup') END FROM benchmark_versions")
            .fetch_all(&self.pool).await?;
        let rows: Vec<(String, String, String)> = rows
            .into_iter()
            .map(|(id, family, group)| {
                let family = family.unwrap_or_default();
                let group = group
                    .filter(|group| !group.trim().is_empty())
                    .unwrap_or_else(|| family.clone());
                (id, family, group)
            })
            .collect();
        // The same fixed point as the reservation: a relative of a relative,
        // through a shared family or group name, belongs to the component.
        loop {
            let before = (families.len(), groups.len());
            for (_, family, group) in &rows {
                if families.contains(family) || groups.contains(group) {
                    families.insert(family.clone());
                    groups.insert(group.clone());
                }
            }
            if before == (families.len(), groups.len()) {
                break;
            }
        }
        let mut ids: BTreeSet<String> = plan.request.version_ids.iter().cloned().collect();
        ids.extend(
            rows.into_iter()
                .filter(|(_, family, group)| families.contains(family) || groups.contains(group))
                .map(|(id, _, _)| id),
        );
        Ok(ids.into_iter().collect())
    }

    /// Each counted repetition of a renderer-bound version was graded by the
    /// renderer its qualification verified, so the certificate does not
    /// depend on the renderer installed when a later chat consults it. A
    /// browser-checked version was graded under it at least once: a zero
    /// scored without the renderer cannot carry the whole version. The report
    /// stays frozen while judge receipts are reconciled, so the evaluations
    /// are read again rather than matched to its hash; receipts name no
    /// renderer.
    async fn require_qualified_grading(
        &self,
        report: &HoldoutReport,
        qualifications: &[qualification::Binding],
    ) -> Result<()> {
        for binding in qualifications {
            let Some(installed) = binding.evaluator_runtime_revision.as_deref() else {
                continue;
            };
            let record = self.qualification(&binding.id).await?;
            // validate_protocol already holds every browser control to one
            // worker revision; rubric renderings carry none.
            let worker = record
                .controls
                .iter()
                .find_map(|control| control.evaluation.as_ref()?.details.as_ref())
                .and_then(|details| details.get("runtimeRevision")?.as_str());
            // A case its group lost under the registered tolerance counts
            // for nothing, so its grading is not part of the evidence.
            if report
                .excluded
                .iter()
                .any(|e| e.version_id == binding.version_id)
            {
                continue;
            }
            let case = report
                .cases
                .iter()
                .find(|case| case.version_id == binding.version_id)
                .ok_or_else(|| invalid("A qualified held-out version has no counted cell"))?;
            let mut graded = false;
            for repeat in case.cells.iter().flat_map(|cell| &cell.repeats) {
                let attempt = self.attempt(&repeat.attempt_id).await?;
                let evaluations: Vec<_> = attempt
                    .evaluations
                    .iter()
                    .filter(|e| e.created_at <= repeat.scored_at)
                    .collect();
                match qualified_renderer_grading(&evaluations, installed, worker) {
                    Some(named) => graded |= named,
                    None => {
                        return Err(invalid(
                            "A counted attempt was graded by another renderer than its qualification verified",
                        ))
                    }
                }
            }
            if worker.is_some() && !graded {
                return Err(invalid(
                    "No counted attempt of a renderer-bound version names its qualified renderer",
                ));
            }
        }
        Ok(())
    }

    /// The runs that ever named a version of the component, from run plans
    /// and attempts, previews and unscored runs included.
    async fn holdout_runs(
        connection: &mut sqlx::SqliteConnection,
        component: &[String],
    ) -> Result<BTreeSet<String>> {
        let ids = serde_json::to_string(component)?;
        let mut runs: BTreeSet<String> = sqlx::query_scalar("SELECT r.id FROM run_plans r WHERE EXISTS (SELECT 1 FROM json_each(json_extract(r.request_json,'$.versionIds')) j WHERE j.value IN (SELECT value FROM json_each(?)))")
            .bind(&ids).fetch_all(&mut *connection).await?.into_iter().collect();
        let attempted: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT run_id FROM attempts WHERE version_id IN (SELECT value FROM json_each(?))",
        )
        .bind(&ids)
        .fetch_all(&mut *connection)
        .await?;
        runs.extend(attempted);
        Ok(runs)
    }

    /// The frozen pool, its declared order and its abstention fallback are
    /// what deployment uses: no provider that may train on held-out tasks,
    /// and an abstaining prediction falls back to the head of the declared
    /// order, as an ordinary chat keeps its own order when the policy abstains.
    async fn require_deployable_plan(&self, plan: &HoldoutPlan) -> Result<()> {
        learned::require_held_out_pool(
            &plan.configurations,
            &super::super::data_use::DataUse::load(&self.root).await,
        )?;
        if plan.request.persona_prior.first() != Some(&plan.request.fallback_key) {
            return Err(invalid(
                "A certifying holdout falls back to the head of its declared order",
            ));
        }
        Ok(())
    }

    /// Commit the operator's rule before any measurement of the frozen cases.
    pub async fn register_holdout_rule(
        &self,
        mut request: HoldoutRegistration,
    ) -> Result<RegisteredHoldoutRule> {
        request.qualification_ids.sort();
        if request.request_key.trim().is_empty()
            || request.request_key.len() > 128
            || request.operator.trim().is_empty()
            || request.operator.len() > 256
            || request.qualification_ids.len() > 512
            || request
                .qualification_ids
                .windows(2)
                .any(|ids| ids[0] == ids[1])
        {
            return Err(invalid(
                "Registration needs bounded request/operator IDs and distinct qualification records",
            ));
        }
        request.rule.validate()?;
        let bound: Option<String> =
            sqlx::query_scalar("SELECT plan_id FROM selector_holdout_rules WHERE request_key=?")
                .bind(&request.request_key)
                .fetch_optional(&self.pool)
                .await?;
        if bound.is_some_and(|plan| plan != request.plan_id) {
            return Err(invalid(
                "This rule request key is already bound to another holdout",
            ));
        }
        if let Some(saved) = self.holdout_rule(&request.plan_id).await? {
            if hash(&saved.request)? != hash(&request)? {
                return Err(invalid("An immutable rule already exists for this holdout"));
            }
            return Ok(saved);
        }
        let plan = self.selector_holdout(&request.plan_id).await?;
        let model = self.selector_model(&plan.request.model_id).await?;
        self.require_deployable_plan(&plan).await?;
        self.require_holdout_reserved(&plan).await?;
        if plan.evaluation.is_none() || model.snapshot_hash != plan.model_snapshot_hash {
            return Err(invalid(
                "Only a holdout with a predeclared report recipe and its unchanged fit can be registered",
            ));
        }
        let component = self.holdout_component(&plan).await?;
        if !Self::holdout_runs(&mut *self.pool.acquire().await?, &component)
            .await?
            .is_empty()
        {
            return Err(invalid(
                "The comparison rule must be registered before any run names a reserved held-out family",
            ));
        }
        let bindings = self
            .holdout_qualifications(&plan, &request.qualification_ids, true)
            .await?;
        let mut saved = RegisteredHoldoutRule {
            request,
            created_at: now(),
            plan_hash: hash(&plan)?,
            qualification_hashes: bindings.iter().map(|b| b.record_hash.clone()).collect(),
            artifact_hash: String::new(),
        };
        saved.artifact_hash = hash(&saved)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if !Self::holdout_runs(&mut tx, &component).await?.is_empty() {
            return Err(invalid(
                "The comparison rule must be registered before any run names a reserved held-out family",
            ));
        }
        sqlx::query("INSERT INTO selector_holdout_rules(plan_id,request_key,request_hash,created_at,request_json,artifact_hash) VALUES(?,?,?,?,?,?)")
            .bind(&saved.request.plan_id).bind(&saved.request.request_key).bind(hash(&saved.request)?)
            .bind(saved.created_at).bind(serde_json::to_string(&saved)?).bind(&saved.artifact_hash).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(saved)
    }

    pub async fn holdout_rule(&self, plan_id: &str) -> Result<Option<RegisteredHoldoutRule>> {
        let row = sqlx::query("SELECT request_json,artifact_hash,request_hash FROM selector_holdout_rules WHERE plan_id=?")
            .bind(plan_id).fetch_optional(&self.pool).await?;
        let Some(row) = row else { return Ok(None) };
        let value: RegisteredHoldoutRule = serde_json::from_str(row.try_get("request_json")?)?;
        let mut body = value.clone();
        body.artifact_hash.clear();
        if hash(&body)? != value.artifact_hash
            || row.try_get::<String, _>("artifact_hash")? != value.artifact_hash
            || hash(&value.request)? != row.try_get::<String, _>("request_hash")?
            || value.request.plan_id != plan_id
        {
            return Err(invalid("Registered holdout rule integrity check failed"));
        }
        Ok(Some(value))
    }

    async fn require_holdout_reserved(&self, plan: &HoldoutPlan) -> Result<()> {
        let reserved: Vec<_> = plan
            .cases
            .iter()
            .map(|case| (case.family.clone(), case.split_group.clone()))
            .collect();
        self.require_reserved("executor_holdout", &plan.id, &reserved)
            .await
    }

    async fn holdout_promotion_for_plan(&self, plan_id: &str) -> Result<Option<State>> {
        let id: Option<String> =
            sqlx::query_scalar("SELECT id FROM selector_holdout_promotions WHERE plan_id=?")
                .bind(plan_id)
                .fetch_optional(&self.pool)
                .await?;
        match id {
            Some(id) => self.promotion(&id).await.map(Some),
            None => Ok(None),
        }
    }

    /// Issue the class certificate once the frozen measurement is complete
    /// and passes the registered rule. A failed comparison issues nothing.
    pub async fn promote_holdout_selector(&self, plan_id: &str) -> Result<State> {
        if let Some(state) = self.holdout_promotion_for_plan(plan_id).await? {
            return Ok(state);
        }
        let rule = self
            .holdout_rule(plan_id)
            .await?
            .ok_or_else(|| invalid("No preregistered holdout rule exists"))?;
        let plan = self.selector_holdout(plan_id).await?;
        let model = self.selector_model(&plan.request.model_id).await?;
        let qualifications = self
            .holdout_qualifications(&plan, &rule.request.qualification_ids, false)
            .await?;
        if hash(&plan)? != rule.plan_hash
            || model.snapshot_hash != plan.model_snapshot_hash
            || qualifications
                .iter()
                .map(|b| &b.record_hash)
                .collect::<Vec<_>>()
                != rule.qualification_hashes.iter().collect::<Vec<_>>()
        {
            return Err(invalid("Registered evidence bindings changed"));
        }
        self.require_deployable_plan(&plan).await?;
        // A released family is open to ordinary runs and cannot certify.
        self.require_holdout_reserved(&plan).await?;
        // Complete first measurements only; an incomplete holdout errors here.
        let report = self.evaluate_selector_holdout(plan_id).await?;
        within_tolerance(&report, &rule.request.rule)?;
        Box::pin(self.require_qualified_grading(&report, &qualifications)).await?;
        // The counted runs are the only runs that ever named the reserved
        // families: no preview, sibling revision or extra run could be read
        // before the comparison was settled.
        let counted: BTreeSet<String> = report
            .cases
            .iter()
            .flat_map(|case| case.cells.iter().map(|cell| cell.run_id.clone()))
            .chain(
                report
                    .excluded
                    .iter()
                    .flat_map(|e| e.run_ids.iter().cloned()),
            )
            .collect();
        let component = self.holdout_component(&plan).await?;
        let runs = Self::holdout_runs(&mut *self.pool.acquire().await?, &component).await?;
        if !runs.is_subset(&counted) {
            return Err(invalid(
                "Only the counted measurement may ever have run on the reserved held-out families",
            ));
        }
        let persona = plan
            .request
            .persona_prior
            .first()
            .ok_or_else(|| invalid("The frozen holdout has no declared order"))?;
        let keys: Vec<_> = plan
            .configurations
            .iter()
            .map(super::super::routing::candidate_key)
            .collect();
        let assessment =
            acceptance::assess(&rule.request.rule, &policy_cases(&report, persona)?, &keys)?;
        if !assessment.passed {
            return Err(invalid(format!(
                "Preregistered comparison failed: {}",
                assessment.reasons.join(", ")
            )));
        }
        let first = self.version(&plan.cases[0].version_id).await?;
        let mut certificate = Certificate {
            id: String::new(),
            created_at: now(),
            model_id: model.id.clone(),
            model_snapshot_hash: model.snapshot_hash.clone(),
            campaign_id: plan.id.clone(),
            campaign_plan_hash: rule.plan_hash.clone(),
            report_hash: report.artifact_hash.clone(),
            rule_hash: rule.artifact_hash.clone(),
            contract: Contract::from_task(&learned::PublicTask::from(&first.manifest)),
            assessment,
            qualifications,
            prior_keys: plan.request.persona_prior.clone(),
            min_prediction_quality: plan.request.min_quality,
            artifact_hash: String::new(),
            native_inventory: None,
            trajectory: None,
            source: Some(SOURCE.into()),
        };
        certificate.id = hash(&certificate)?;
        certificate.artifact_hash = hash(&certificate)?;
        sqlx::query("INSERT OR IGNORE INTO selector_holdout_promotions(id,plan_id,created_at,artifact_json,artifact_hash) VALUES(?,?,?,?,?)")
            .bind(&certificate.id).bind(plan_id).bind(certificate.created_at)
            .bind(serde_json::to_string(&certificate)?).bind(&certificate.artifact_hash).execute(&self.pool).await?;
        self.holdout_promotion_for_plan(plan_id)
            .await?
            .ok_or_else(|| invalid("Promotion disappeared"))
    }

    /// Authority of a holdout certificate: its immutable plan, rule,
    /// qualifications and fit, never comparison outcomes. Promotion proved
    /// which renderer graded the evidence; the renderer installed now plays
    /// no part in choosing a model for a chat.
    pub(super) async fn require_active_holdout_promotion(
        &self,
        certificate: Certificate,
    ) -> Result<Certificate> {
        if certificate.source.as_deref() != Some(SOURCE)
            || certificate.trajectory.is_some()
            || certificate.native_inventory.is_some()
        {
            return Err(invalid("Holdout promotion authority changed"));
        }
        let plan = self
            .selector_holdout(&certificate.campaign_id)
            .await
            .map_err(|_| invalid("Holdout promotion authority disappeared"))?;
        let rule = self
            .holdout_rule(&plan.id)
            .await?
            .ok_or_else(|| invalid("Holdout promotion authority disappeared"))?;
        if hash(&plan)? != certificate.campaign_plan_hash
            || rule.artifact_hash != certificate.rule_hash
            || rule.plan_hash != certificate.campaign_plan_hash
            || plan.request.model_id != certificate.model_id
        {
            return Err(invalid("Holdout promotion authority changed"));
        }
        self.verify_qualification_authority(&certificate.qualifications, false)
            .await?;
        let model = self.selector_model(&certificate.model_id).await?;
        if model.snapshot_hash != certificate.model_snapshot_hash {
            return Err(invalid("Promoted fit changed"));
        }
        Ok(certificate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::benchmarks::learned::report::ReportCell;

    fn report(cases: usize) -> HoldoutReport {
        HoldoutReport {
            plan_id: "plan".into(),
            plan_hash: "hash".into(),
            artifact_hash: "artifact".into(),
            created_at: 1,
            protocol: learned::report::ReportProtocol::new(Default::default()),
            cases: (0..cases)
                .map(|index| ReportCase {
                    version_id: format!("case-{index}"),
                    group: format!("group-{index}"),
                    learned_key: if index % 2 == 0 { "a" } else { "b" }.into(),
                    aggregate_key: "a".into(),
                    used_fallback: false,
                    cells: ["a", "b"]
                        .into_iter()
                        .map(|key| {
                            let solved = (index % 2 == 0) == (key == "a");
                            ReportCell {
                                candidate_key: key.into(),
                                run_id: "run".into(),
                                quality: f64::from(u8::from(solved)),
                                utility: if solved { 0.9 } else { 0.0 },
                                mean_duration_ms: Some(1.0),
                                mean_cost: None,
                                repeats: vec![],
                            }
                        })
                        .collect(),
                })
                .collect(),
            groups: cases,
            fallback_cases: 0,
            policies: vec![],
            limitations: vec![],
            status: "research_only".into(),
            dispatch_allowed: false,
            excluded: vec![],
        }
    }

    fn selection_rule() -> acceptance::Rule {
        acceptance::Rule {
            recipe: acceptance::SELECTION_RECIPE.into(),
            alpha: 0.05,
            minimum_group_utility_gain: 0.0,
            minimum_observed_quality: 0.8,
            non_inferiority_margin: Some(0.05),
            max_incomplete_groups: None,
        }
    }

    #[test]
    fn policy_arms_are_the_frozen_picks_and_every_worker() {
        let cases = policy_cases(&report(16), "b").unwrap();
        let keys = ["a".to_owned(), "b".to_owned()];
        for case in &cases {
            let names: BTreeSet<_> = case
                .cells
                .iter()
                .map(|c| c.candidate_key.as_str())
                .collect();
            assert_eq!(
                names,
                BTreeSet::from(["aggregate", "learned", "persona", "worker:a", "worker:b"])
            );
            let arm = |name: &str| case.cells.iter().find(|c| c.candidate_key == name).unwrap();
            assert_eq!(arm("learned").utility, 0.9);
            assert_eq!(arm("persona").utility, arm("worker:b").utility);
            assert_eq!(arm("aggregate").utility, arm("worker:a").utility);
        }
        let assessment = acceptance::assess(&selection_rule(), &cases, &keys).unwrap();
        assert!(assessment.passed, "{:?}", assessment.reasons);
        // Too few independent groups cannot certify, whatever the outcomes.
        let few = policy_cases(&report(8), "b").unwrap();
        assert!(
            !acceptance::assess(&selection_rule(), &few, &keys)
                .unwrap()
                .passed
        );
        // A pick outside the measured candidates is refused, not imputed.
        let mut broken = report(16);
        broken.cases[0].learned_key = "unmeasured".into();
        assert!(policy_cases(&broken, "b").is_err());
    }

    #[test]
    fn lost_groups_need_a_registered_tolerance() {
        let mut lost = report(16);
        for (index, group) in ["group-3", "group-3", "group-5"].into_iter().enumerate() {
            lost.excluded.push(learned::report::ExcludedCase {
                version_id: format!("lost-{index}"),
                group: group.into(),
                reasons: vec![],
                run_ids: vec!["run".into()],
            });
        }
        // Two groups lost (two cases of one group count once).
        let mut rule = selection_rule();
        assert!(within_tolerance(&report(16), &rule).is_ok());
        assert!(within_tolerance(&lost, &rule)
            .unwrap_err()
            .message
            .contains("tolerates 0"));
        rule.max_incomplete_groups = Some(1);
        assert!(within_tolerance(&lost, &rule).is_err());
        rule.max_incomplete_groups = Some(2);
        assert!(rule.validate().is_ok());
        assert!(within_tolerance(&lost, &rule).is_ok());
        // Only the selection recipe takes a tolerance, and only a small one.
        rule.max_incomplete_groups = Some(acceptance::MAX_INCOMPLETE_GROUPS + 1);
        assert!(rule.validate().is_err());
        rule.max_incomplete_groups = Some(1);
        rule.recipe = "independent-group-sign-holm-v1".into();
        rule.non_inferiority_margin = None;
        assert!(rule.validate().is_err());
    }

    fn graded(provenance: &str, details: Option<serde_json::Value>) -> Evaluation {
        Evaluation {
            id: "evaluation".into(),
            evaluator_revision: "revision".into(),
            verdict: "pass".into(),
            score: Some(1.0),
            reason: String::new(),
            created_at: 1,
            provenance: provenance.into(),
            artifacts: vec![],
            details,
            judge: None,
            usage: None,
        }
    }

    #[test]
    fn counted_attempts_must_name_the_qualified_renderer() {
        let browser = |installed: &str, worker: &str| {
            graded(
                "protected_browser",
                Some(
                    serde_json::json!({"installedRevision": installed, "runtimeRevision": worker}),
                ),
            )
        };
        let check = |evaluations: &[Evaluation], worker: Option<&str>| {
            qualified_renderer_grading(&evaluations.iter().collect::<Vec<_>>(), "r1", worker)
        };
        let named = Some(true);
        let unnamed_zero = Some(false);
        assert_eq!(check(&[browser("r1", "w1")], Some("w1")), named);
        // Another installed renderer or worker on any evaluation refuses it.
        assert_eq!(check(&[browser("r2", "w1")], Some("w1")), None);
        assert_eq!(check(&[browser("r1", "w2")], Some("w1")), None);
        assert_eq!(
            check(&[browser("r1", "w1"), browser("r2", "w1")], Some("w1")),
            None
        );
        // A graded repetition that names no renderer cannot prove which one it used.
        assert_eq!(
            check(&[graded("protected_browser", None)], Some("w1")),
            None
        );
        assert_eq!(
            check(&[graded("exact", Some(serde_json::json!({})))], None),
            None
        );
        // A budget failure is scored without a grader.
        assert_eq!(check(&[], Some("w1")), unnamed_zero);
        // Rubric renderings name the renderer in their judge protocol.
        let render = |installed: &str| {
            graded(
                "render",
                Some(serde_json::json!({"protocol": {"installedRendererRevision": installed}})),
            )
        };
        assert_eq!(check(&[render("r1"), graded("judge", None)], None), named);
        assert_eq!(check(&[render("r2"), graded("judge", None)], None), None);
        // A rubric answer without markup is a native zero nothing rendered;
        // a browser check never produces one.
        let mut structural = graded("objective", None);
        structural.verdict = "fail".into();
        structural.score = Some(0.0);
        assert_eq!(check(std::slice::from_ref(&structural), None), unnamed_zero);
        assert_eq!(check(std::slice::from_ref(&structural), Some("w1")), None);
        let mut passed = structural.clone();
        passed.verdict = "pass".into();
        passed.score = Some(1.0);
        assert_eq!(check(&[passed], None), None);
    }
}
