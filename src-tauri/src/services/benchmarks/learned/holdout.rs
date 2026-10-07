//! Pre-register an unused family holdout before worker outcomes exist.
//! A reservation is not a run request, a spend allowance or promotion approval.
use super::super::{
    selector,
    store::{now, Store},
    BenchmarkService,
};
use super::*;
use sqlx::Row;
use std::collections::BTreeMap;

const PROTOCOL: &str = "unseen-family-reservation-v2";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HoldoutRequest {
    pub request_key: String,
    pub model_id: String,
    pub version_ids: Vec<String>,
    /// Complete preference order of the fitted candidate identities.
    pub persona_prior: Vec<String>,
    pub fallback_key: String,
    pub min_quality: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldoutCase {
    pub version_id: String,
    pub content_hash: String,
    pub evaluator_revision: String,
    pub required_repetitions: u32,
    pub minimum_timeout_seconds: u32,
    pub family: String,
    pub split_group: String,
    pub public_task_hash: String,
    pub learned_key: String,
    pub learned_abstention: Option<String>,
    pub aggregate_key: String,
    pub aggregate_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldoutPlan {
    pub id: String,
    pub created_at: i64,
    pub protocol: String,
    pub request: HoldoutRequest,
    pub model_snapshot_hash: String,
    pub configurations: Vec<Configuration>,
    pub cases: Vec<HoldoutCase>,
    /// Policies required by the later report, including every fixed candidate.
    pub policies: Vec<String>,
    /// Older reservations have no predeclared statistical recipe and cannot
    /// acquire one after exposure. They remain inspectable, not evaluable.
    #[serde(default)]
    pub evaluation: Option<super::report::ReportProtocol>,
    pub dispatch_allowed: bool,
    pub status: String,
}

fn split_group(draft: &BenchmarkDraft) -> &str {
    draft
        .environment
        .get("splitGroup")
        .and_then(serde_json::Value::as_str)
        .filter(|group| !group.trim().is_empty())
        .unwrap_or(&draft.task_family)
}

fn canonical(mut request: HoldoutRequest, model: &LearnedModel) -> Result<HoldoutRequest> {
    validate_model(model)?;
    let keys: BTreeSet<_> = model
        .candidates
        .iter()
        .map(|c| c.candidate_key.as_str())
        .collect();
    let prior: BTreeSet<_> = request.persona_prior.iter().map(String::as_str).collect();
    if request.request_key.trim().is_empty()
        || request.request_key.len() > 128
        || request.model_id != model.id
        || !(MIN_CASES..=MAX_CASES).contains(&request.version_ids.len())
        || !request.min_quality.is_finite()
        || !(0.0..=1.0).contains(&request.min_quality)
        || !keys.contains(request.fallback_key.as_str())
        || prior != keys
        || prior.len() != request.persona_prior.len()
    {
        return Err(invalid("Holdout requires a request key, fitted model, 8 to 256 versions, complete candidate preference order, a fitted fallback and quality floor from zero to one"));
    }
    request.version_ids.sort();
    if request
        .version_ids
        .windows(2)
        .any(|pair| pair[0] == pair[1])
    {
        return Err(invalid("Holdout versions must be distinct"));
    }
    Ok(request)
}

fn exposure_error(message: impl Into<String>) -> BenchmarkError {
    BenchmarkError::new("holdout_already_exposed", message)
}

/// Historical renames can join two declared groups through the same family.
/// Such groups must not become independent bootstrap units within one plan.
fn validate_group_separation(cases: &[HoldoutCase], drafts: &[&BenchmarkDraft]) -> Result<()> {
    let selected: BTreeSet<_> = cases.iter().map(|c| c.split_group.as_str()).collect();
    for initial in &selected {
        let mut groups = BTreeSet::from([*initial]);
        let mut families = BTreeSet::new();
        loop {
            let before = (groups.len(), families.len());
            for draft in drafts {
                if groups.contains(split_group(draft))
                    || families.contains(draft.task_family.as_str())
                {
                    groups.insert(split_group(draft));
                    families.insert(draft.task_family.as_str());
                }
            }
            if before == (groups.len(), families.len()) {
                break;
            }
        }
        if selected.intersection(&groups).count() > 1 {
            return Err(invalid("Declared holdout groups share a historical family relation; merge their group labels before reservation"));
        }
    }
    Ok(())
}

/// Freezes predictions and training-only aggregate choices before any labels
/// from these families exist. Storage rechecks exposure against unfiltered runs.
pub(super) fn prepare(
    data: &QueryData,
    model: &LearnedModel,
    request: HoldoutRequest,
) -> Result<HoldoutPlan> {
    let request = canonical(request, model)?;
    let current: BTreeMap<_, _> = super::super::analysis::pool(data, &ResultQuery::default())
        .into_iter()
        .map(|v| (v.id.as_str(), v))
        .collect();
    let configurations: Vec<_> = model
        .candidates
        .iter()
        .map(|c| c.configuration.clone())
        .collect();
    let candidates: Vec<_> = configurations
        .iter()
        .cloned()
        .map(|configuration| RoutingCandidate {
            configuration,
            available: true,
            reason: None,
        })
        .collect();
    let prior = request
        .persona_prior
        .iter()
        .map(|key| {
            model
                .candidates
                .iter()
                .find(|c| &c.candidate_key == key)
                .expect("validated prior")
                .configuration
                .clone()
        })
        .collect::<Vec<_>>();
    let mut cases = Vec::new();
    for id in &request.version_ids {
        let version = current
            .get(id.as_str())
            .ok_or_else(|| invalid(format!("Holdout version {id} is not in the current pool")))?;
        let draft = &version.manifest;
        if draft.split != "held_out"
            || draft.work_class_id != model.work_class_id
            || draft.workflow.is_some()
            || model.training_families.contains(&draft.task_family)
            || model
                .training_groups
                .iter()
                .any(|group| group == split_group(draft))
            || configurations
                .iter()
                .any(|c| routing::authored_by_candidate(draft, c))
        {
            return Err(invalid(format!(
                "Version {id} is not an independent, non-author executor holdout for this model"
            )));
        }
        let task = PublicTask::from(draft);
        if !model.scope_hashes.contains(&features::scope_hash(&task)?) {
            return Err(invalid(format!(
                "Version {id} uses an untrained role or execution context"
            )));
        }
        let prediction = predict(
            model,
            &PredictionRequest {
                task: task.clone(),
                target_family: draft.task_family.clone(),
                target_group: split_group(draft).into(),
                candidates: candidates.clone(),
                hard_candidate_key: None,
                min_quality: request.min_quality,
            },
        )?;
        let aggregate = selector::select(
            data,
            &selector::SelectionQuery {
                work_class_id: model.work_class_id.clone(),
                facets: draft.facets.clone(),
                candidates: candidates.clone(),
                weights: Some(model.weights),
                prior: prior.clone(),
                min_cases: Some(MIN_CASES as u32),
                cutoff_at: Some(model.cutoff_at),
                permitted_splits: Some(vec!["train".into()]),
                target_family: Some(draft.task_family.clone()),
            },
        )?;
        cases.push(HoldoutCase {
            version_id: id.clone(),
            content_hash: version.content_hash.clone(),
            evaluator_revision: draft.evaluator.revision.clone(),
            required_repetitions: super::super::analysis::required_repetitions(data, version),
            minimum_timeout_seconds: draft.limits.timeout_seconds,
            family: draft.task_family.clone(),
            split_group: split_group(draft).into(),
            public_task_hash: hash(&task)?,
            learned_abstention: prediction.chosen_key.is_none().then_some(prediction.reason),
            learned_key: prediction
                .chosen_key
                .unwrap_or_else(|| request.fallback_key.clone()),
            aggregate_key: aggregate
                .chosen_key
                .unwrap_or_else(|| request.fallback_key.clone()),
            aggregate_source: aggregate.source,
        });
    }
    let groups: BTreeSet<_> = cases.iter().map(|c| &c.split_group).collect();
    if groups.len() < 4 {
        return Err(invalid("Holdout requires at least four declared independent groups; qualification is a separate gate"));
    }
    validate_group_separation(
        &cases,
        &data
            .versions
            .iter()
            .map(|v| &v.manifest)
            .collect::<Vec<_>>(),
    )?;
    let mut policies = vec![
        "learned".into(),
        "aggregate".into(),
        "persona".into(),
        "best_fixed".into(),
        "oracle".into(),
    ];
    policies.extend(
        model
            .candidates
            .iter()
            .map(|c| format!("fixed:{}", c.candidate_key)),
    );
    Ok(HoldoutPlan {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: now(),
        protocol: PROTOCOL.into(),
        request,
        model_snapshot_hash: model.snapshot_hash.clone(),
        configurations,
        cases,
        policies,
        evaluation: Some(super::report::ReportProtocol::new(model.weights)),
        dispatch_allowed: false,
        status: "reserved_research_holdout".into(),
    })
}

impl BenchmarkService {
    pub async fn freeze_selector_holdout(&self, request: HoldoutRequest) -> Result<HoldoutPlan> {
        let model = self.store.selector_model(&request.model_id).await?;
        let request = canonical(request, &model)?;
        if let Some(existing) = self.store.holdout_retry(&request).await? {
            return Ok(existing);
        }
        let data = self.query_data().await?;
        let plan = tauri::async_runtime::spawn_blocking(move || prepare(&data, &model, request))
            .await
            .map_err(|e| BenchmarkError::new("infrastructure_failure", e.to_string()))??;
        self.store.reserve_selector_holdout(&plan).await
    }
}

impl Store {
    async fn holdout_retry(&self, request: &HoldoutRequest) -> Result<Option<HoldoutPlan>> {
        let row =
            sqlx::query("SELECT request_hash,data_json FROM selector_holdouts WHERE request_key=?")
                .bind(&request.request_key)
                .fetch_optional(&self.pool)
                .await?;
        row.map(|row| {
            if row.try_get::<String, _>("request_hash")? != hash(request)? {
                return Err(invalid(
                    "Holdout request key is already bound to different inputs",
                ));
            }
            Ok(serde_json::from_str(row.try_get("data_json")?)?)
        })
        .transpose()
    }

    async fn reserve_selector_holdout(&self, plan: &HoldoutPlan) -> Result<HoldoutPlan> {
        let mut tx = self.pool.begin().await?;
        // The first statement acquires the writer lock. Run admission cannot
        // race between the raw-history check and the reservation commit.
        let inserted = sqlx::query("INSERT OR IGNORE INTO selector_holdouts(id,request_key,request_hash,model_id,created_at,data_json) VALUES(?,?,?,?,?,?)")
            .bind(&plan.id).bind(&plan.request.request_key).bind(hash(&plan.request)?)
            .bind(&plan.request.model_id).bind(plan.created_at).bind(serde_json::to_string(plan)?)
            .execute(&mut *tx).await?.rows_affected();
        if inserted == 0 {
            tx.rollback().await?;
            return self
                .holdout_retry(&plan.request)
                .await?
                .ok_or_else(|| invalid("Holdout identity conflict"));
        }
        let mut families: BTreeSet<String> = plan.cases.iter().map(|c| c.family.clone()).collect();
        let mut groups: BTreeSet<String> =
            plan.cases.iter().map(|c| c.split_group.clone()).collect();
        let mut related_ids = BTreeSet::new();
        let rows = sqlx::query("SELECT id,content_hash,manifest_json FROM benchmark_versions")
            .fetch_all(&mut *tx)
            .await?;
        let versions = rows
            .iter()
            .map(|row| {
                Ok((
                    row.try_get::<String, _>("id")?,
                    row.try_get::<String, _>("content_hash")?,
                    serde_json::from_str::<BenchmarkDraft>(row.try_get("manifest_json")?)?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        validate_group_separation(
            &plan.cases,
            &versions
                .iter()
                .map(|(_, _, draft)| draft)
                .collect::<Vec<_>>(),
        )?;
        // A family may have used an earlier group name. Reserve the connected
        // component, so a rename cannot split related examples across plans.
        loop {
            let previous = (families.len(), groups.len());
            for (_, _, draft) in &versions {
                if families.contains(&draft.task_family) || groups.contains(split_group(draft)) {
                    families.insert(draft.task_family.clone());
                    groups.insert(split_group(draft).into());
                }
            }
            if previous == (families.len(), groups.len()) {
                break;
            }
        }
        let mut found = BTreeSet::new();
        for (id, content_hash, draft) in versions {
            if families.contains(&draft.task_family) || groups.contains(split_group(&draft)) {
                if draft.split != "held_out" {
                    return Err(invalid("A related holdout family crosses dataset splits"));
                }
                related_ids.insert(id.clone());
            }
            if let Some(case) = plan.cases.iter().find(|case| case.version_id == id) {
                if case.content_hash != content_hash
                    || draft.split != "held_out"
                    || case.family != draft.task_family
                    || case.split_group != split_group(&draft)
                    || case.public_task_hash != hash(&PublicTask::from(&draft))?
                    || case.evaluator_revision != draft.evaluator.revision
                {
                    return Err(invalid(
                        "Holdout version changed while its plan was being frozen",
                    ));
                }
                found.insert(id);
            }
        }
        if found.len() != plan.cases.len() {
            return Err(invalid("A frozen holdout version is missing"));
        }
        // Read every raw run, including previews, unknown efforts and failures.
        // Planning a related version consumes its independent-holdout status.
        let requests: Vec<String> = sqlx::query_scalar("SELECT request_json FROM run_plans")
            .fetch_all(&mut *tx)
            .await?;
        for body in requests {
            let request: RunRequest = serde_json::from_str(&body)?;
            if request
                .version_ids
                .iter()
                .any(|id| related_ids.contains(id))
            {
                return Err(exposure_error(
                    "A selected family or related group already appeared in a run plan",
                ));
            }
        }
        let attempted: Vec<String> = sqlx::query_scalar("SELECT DISTINCT version_id FROM attempts")
            .fetch_all(&mut *tx)
            .await?;
        if attempted.iter().any(|id| related_ids.contains(id)) {
            return Err(exposure_error(
                "A selected family or related group already has an attempt",
            ));
        }
        for (kind, values) in [("family", families), ("group", groups)] {
            for value in values {
                let reserved = sqlx::query("INSERT OR IGNORE INTO selector_holdout_reservations(kind,value,plan_id) VALUES(?,?,?)")
                    .bind(kind).bind(value).bind(&plan.id).execute(&mut *tx).await?.rows_affected();
                if reserved == 0 {
                    return Err(exposure_error(
                        "A selected family or related group is reserved by another holdout plan",
                    ));
                }
            }
        }
        super::super::store::event(&mut tx, &plan.id, "selector_holdout_reserved").await?;
        tx.commit().await?;
        Ok(plan.clone())
    }

    pub async fn selector_holdouts(&self, model_id: &str) -> Result<Vec<HoldoutPlan>> {
        let bodies: Vec<String> = sqlx::query_scalar("SELECT data_json FROM selector_holdouts WHERE model_id=? ORDER BY created_at DESC,id LIMIT 100")
            .bind(model_id).fetch_all(&self.pool).await?;
        bodies
            .into_iter()
            .map(|body| Ok(serde_json::from_str(&body)?))
            .collect()
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub(in crate::services::benchmarks::learned) fn fixture(
    ) -> (QueryData, FitArtifact, HoldoutRequest) {
        let mut data = super::super::tests::data();
        let artifact = fit(
            &data,
            FitRequest {
                work_class_id: "debug".into(),
                version_ids: data.versions.iter().map(|v| v.id.clone()).collect(),
                configurations: data.runs[0].request.configurations.clone(),
                cutoff_at: 10,
                weights: RoleWeights::default(),
            },
        )
        .unwrap();
        let mut version_ids = Vec::new();
        for index in 0..8 {
            let mut v = data.versions[index].clone();
            v.id = format!("held-{index}");
            v.definition_id = v.id.clone();
            v.content_hash = format!("held-hash-{index}");
            v.manifest.split = "held_out".into();
            v.manifest.task_family = format!("held-family-{index}");
            v.manifest.environment =
                serde_json::json!({"splitGroup":format!("held-group-{}",index/2)});
            version_ids.push(v.id.clone());
            data.versions.push(v);
        }
        let request = HoldoutRequest {
            request_key: "reservation-a".into(),
            model_id: artifact.model.id.clone(),
            version_ids,
            persona_prior: artifact
                .model
                .candidates
                .iter()
                .map(|c| c.candidate_key.clone())
                .collect(),
            fallback_key: artifact.model.candidates[0].candidate_key.clone(),
            min_quality: 0.5,
        };
        (data, artifact, request)
    }

    async fn save_versions(store: &Store, versions: &[BenchmarkVersion]) {
        // Isolated engineering fixtures only; production callers use publication.
        for version in versions {
            sqlx::query(
                "INSERT OR IGNORE INTO benchmark_definitions(id,draft_json,revision) VALUES(?,?,1)",
            )
            .bind(&version.definition_id)
            .bind(serde_json::to_string(&version.manifest).unwrap())
            .execute(&store.pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO benchmark_versions(id,definition_id,content_hash,manifest_json,published_at) VALUES(?,?,?,?,?)")
                .bind(&version.id).bind(&version.definition_id).bind(&version.content_hash)
                .bind(serde_json::to_string(&version.manifest).unwrap()).bind(version.published_at).execute(&store.pool).await.unwrap();
        }
    }

    async fn save_run(store: &Store, data: &QueryData, version: &str) {
        let mut request = data.runs[0].request.clone();
        request.version_ids = vec![version.into()];
        request.preview = true;
        // Unknown effort and no terminal outcome must not conceal exposure.
        request.configurations[0].effort = None;
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('exposed','exposed','cancelled',1,1,2,?)")
            .bind(serde_json::to_string(&request).unwrap()).execute(&store.pool).await.unwrap();
    }

    #[test]
    fn freezes_task_choices_and_all_comparators_before_measurement() {
        let (data, artifact, request) = fixture();
        let plan = prepare(&data, &artifact.model, request.clone()).unwrap();
        assert_eq!(plan.cases.len(), 8);
        assert_eq!(plan.policies.len(), 7);
        assert_eq!(plan.status, "reserved_research_holdout");
        assert!(!plan.dispatch_allowed);
        let choices: BTreeSet<_> = plan.cases.iter().map(|c| &c.learned_key).collect();
        assert_eq!(choices.len(), 2);
        assert!(plan
            .cases
            .iter()
            .all(|case| case.learned_abstention.is_none()));
        let mut refuse = request;
        refuse.min_quality = 1.0;
        let plan = prepare(&data, &artifact.model, refuse).unwrap();
        assert!(plan
            .cases
            .iter()
            .all(|c| c.learned_key == plan.request.fallback_key
                && c.learned_abstention.as_deref() == Some("below_quality_floor")));
    }

    #[test]
    fn refuses_related_authored_wrong_scope_or_insufficient_group_cases() {
        for mode in 0..4 {
            let (mut data, artifact, request) = fixture();
            let version = data.versions.iter_mut().find(|v| v.id == "held-0").unwrap();
            match mode {
                0 => version.manifest.environment["splitGroup"] = serde_json::json!("group-0"),
                1 => version.manifest.environment["authoredBy"] = serde_json::json!(["parser"]),
                2 => version.manifest.role_prompt = "different role".into(),
                _ => {
                    for version in data
                        .versions
                        .iter_mut()
                        .filter(|v| v.manifest.split == "held_out")
                    {
                        version.manifest.environment["splitGroup"] = serde_json::json!("one-group");
                    }
                }
            }
            assert!(prepare(&data, &artifact.model, request).is_err());
        }
    }

    #[tokio::test]
    async fn reservations_are_durable_idempotent_and_cannot_be_rebound() {
        let (data, artifact, request) = fixture();
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        store.save_selector_fit(&artifact).await.unwrap();
        save_versions(&store, &data.versions).await;
        let plan = prepare(&data, &artifact.model, request.clone()).unwrap();
        store.reserve_selector_holdout(&plan).await.unwrap();
        let retry = prepare(&data, &artifact.model, request.clone()).unwrap();
        assert_eq!(
            store.reserve_selector_holdout(&retry).await.unwrap().id,
            plan.id
        );
        let mut changed = request.clone();
        changed.min_quality = 0.7;
        assert!(store.holdout_retry(&changed).await.is_err());
        // A retry after measurement returns its original reservation, never a new plan.
        save_run(&store, &data, "held-0").await;
        assert_eq!(
            store.holdout_retry(&request).await.unwrap().unwrap().id,
            plan.id
        );
        store.pool.close().await;
        let store = Store::open(directory.path()).await.unwrap();
        assert_eq!(
            store.selector_holdouts(&artifact.model.id).await.unwrap()[0].id,
            plan.id
        );
    }

    #[tokio::test]
    async fn raw_unscored_preview_and_concurrently_added_relatives_block_reservation() {
        let (mut data, artifact, request) = fixture();
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        store.save_selector_fit(&artifact).await.unwrap();
        save_versions(&store, &data.versions).await;
        let plan = prepare(&data, &artifact.model, request).unwrap();
        let mut relative = data.versions.last().unwrap().clone();
        relative.id = "relative".into();
        relative.definition_id = "relative".into();
        relative.manifest.task_family = "renamed-family".into();
        save_versions(&store, &[relative.clone()]).await;
        data.versions.push(relative);
        save_run(&store, &data, "relative").await;
        assert_eq!(
            store
                .reserve_selector_holdout(&plan)
                .await
                .unwrap_err()
                .code,
            "holdout_already_exposed"
        );
        assert!(store
            .selector_holdouts(&artifact.model.id)
            .await
            .unwrap()
            .is_empty());
        let reservations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM selector_holdout_reservations")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(reservations, 0);
    }

    #[tokio::test]
    async fn overlapping_concurrent_plans_reserve_families_exactly_once() {
        let (data, artifact, request) = fixture();
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        store.save_selector_fit(&artifact).await.unwrap();
        save_versions(&store, &data.versions).await;
        let first = prepare(&data, &artifact.model, request.clone()).unwrap();
        let mut other = request;
        other.request_key = "other-plan".into();
        let second = prepare(&data, &artifact.model, other).unwrap();
        let (a, b) = tokio::join!(
            store.reserve_selector_holdout(&first),
            store.reserve_selector_holdout(&second)
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        assert_eq!(
            a.err().or_else(|| b.err()).unwrap().code,
            "holdout_already_exposed"
        );
        assert_eq!(
            store
                .selector_holdouts(&artifact.model.id)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn historical_group_names_link_related_families_transitively() {
        let (data, artifact, request) = fixture();
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        store.save_selector_fit(&artifact).await.unwrap();
        save_versions(&store, &data.versions).await;
        let plan = prepare(&data, &artifact.model, request).unwrap();
        let mut bridge = data.versions.last().unwrap().clone();
        bridge.id = "historical-bridge".into();
        bridge.definition_id = "historical-bridge".into();
        bridge.manifest.environment["splitGroup"] = serde_json::json!("old-group-name");
        let mut relative = bridge.clone();
        relative.id = "transitive-relative".into();
        relative.definition_id = relative.id.clone();
        relative.manifest.task_family = "another-family".into();
        save_versions(&store, &[bridge, relative]).await;
        save_run(&store, &data, "transitive-relative").await;
        assert_eq!(
            store
                .reserve_selector_holdout(&plan)
                .await
                .unwrap_err()
                .code,
            "holdout_already_exposed"
        );
    }

    #[tokio::test]
    async fn historical_relations_cannot_inflate_the_independent_group_count() {
        let (mut data, artifact, request) = fixture();
        let plan = prepare(&data, &artifact.model, request.clone()).unwrap();
        let mut bridge = data
            .versions
            .iter()
            .find(|v| v.id == "held-0")
            .unwrap()
            .clone();
        bridge.id = "historical-group-bridge".into();
        bridge.definition_id = bridge.id.clone();
        bridge.manifest.environment["splitGroup"] = serde_json::json!("held-group-1");
        data.versions.push(bridge);
        assert!(prepare(&data, &artifact.model, request).is_err());
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        store.save_selector_fit(&artifact).await.unwrap();
        save_versions(&store, &data.versions).await;
        assert!(store.reserve_selector_holdout(&plan).await.is_err());
        assert!(store
            .selector_holdouts(&artifact.model.id)
            .await
            .unwrap()
            .is_empty());
    }
}
