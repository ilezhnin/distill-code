//! Read-only, versioned evidence contract. This module never selects or starts a model.
use super::{
    fixtures::hash,
    store::{now, Store},
    types::*,
};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

/// The kinds of work a model is chosen for: one board per class on the
/// leaderboard, one routing class per persona. Difficulty is a facet, not a
/// class, since October 5, 2026 (`legacy_work_class`).
pub const WORK_CLASSES: [&str; 14] = [
    "code-implement",
    "algorithms",
    "debug",
    "code-review",
    "security",
    "testing",
    "architecture",
    "planning",
    "frontend-ui",
    "creative",
    "writing",
    "research-data",
    "ops",
    "general",
];

/// Where a case of a class retired on October 5, 2026 belongs now, and the
/// difficulty its old class implied. The old classes split work by weight
/// (light, medium, heavy) rather than by kind; a few cases were classed by
/// their family and move by name.
pub fn legacy_work_class(class: &str, name: &str) -> Option<(&'static str, Option<&'static str>)> {
    let by_name = match hash(name.as_bytes()).as_str() {
        "162d29d7782cb2681d8f4657465960d1cbe708596d38610980ade97589979bfd" => Some("security"),
        "d8a00c06d4d89407c414c28c60ae43ea32d56461453b99382c31a12745d82e3d"
        | "80b95d5ec59cd758186ccb8a76cb82e3469e8e3de282c5b9ac934a103167c73d"
        | "5fd7048aaa6eef7834730932f5eed03570807b25ee1a191af5046951d82ab606"
        | "6c9eae9dc1f52276f41be154b7366f68f8f1199cdf065b9355fcb3ac5ff8b29a"
        | "0569ab96208b53167a1ef792792dacf2d43c5692f79fe91d69301d0605c6b9a2"
        | "08b37bbba08e8fe11b0f0c9ffd5c8091c3db505354a82eef7705f9430a6861eb" => Some("debug"),
        "5709ae53f8c0d47ef6c2cb8fec63c4e12845bd353c284289910dae53219317c6" => Some("writing"),
        "8cc96d191a9122c52a7a01b9136c0dfe81bc0928eb20e486aeb97c6b47da517c"
        | "342c6087a46dff944e8a3482e79cec0a809620d1e0729f46d8f1f828baacc136"
        | "bf672287285dbd306d9b8a888725f76a7eb620e584ecdc22c4548ed61fcb6866"
        | "b83b9c91dc906f47bd980f1b29f4ea11fc29b30c49078e01e29e92b54f931564"
        | "c64d166f8adce8437a95c728f9b0f914215aaf7ac403ae02e9336c51d56aee71"
        | "ee72cd13ff72ad00b90cbc5618197086bf62fe00565a4e15df988fb067337ca9"
        | "850fe749b35c9037839b5ec9d58888dd0d4ee396a1dc53d6c32e7ac4dba0e6ef" => {
            Some("research-data")
        }
        _ => None,
    };
    let (by_class, difficulty) = match class {
        "coding-simple" => ("algorithms", Some("easy")),
        "coding-complex" => ("algorithms", Some("hard")),
        "testing-light" => ("testing", Some("easy")),
        "testing-heavy" => ("testing", Some("hard")),
        "general-light" => ("general", Some("easy")),
        "general-medium" => ("research-data", Some("medium")),
        "one-shot" => ("general", None),
        _ => return by_name.map(|class| (class, None)),
    };
    Some((by_name.unwrap_or(by_class), difficulty))
}
/// Names how `candidate_key` is derived. Keys recorded under an earlier
/// algorithm (decision snapshot pins) are not comparable with current ones.
pub const CANDIDATE_KEY_ALGORITHM: &str = "leaderboard-identity-v2";
pub fn candidate_key(c: &Configuration) -> String {
    hash(super::analysis::leaderboard_key(c).as_bytes())
}
/// A candidate that helped write a test must not be scored on it. Authors are
/// declared as lowercase needles in `environment.authoredBy`; a needle matches
/// when it appears in the model or provider ID of the candidate, or in the
/// model a declared alias stands for, as for judges.
pub fn authored_by_candidate(draft: &BenchmarkDraft, configuration: &Configuration) -> bool {
    let model = configuration.model_id.to_lowercase();
    let provider = configuration.provider_id.to_lowercase();
    let target = super::runner::concrete_model(&configuration.provider_id, &configuration.model_id)
        .unwrap_or_default();
    draft
        .environment
        .get("authoredBy")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|authors| {
            authors
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|needle| {
                    let needle = needle.trim().to_lowercase();
                    !needle.is_empty()
                        && (model.contains(&needle)
                            || provider.contains(&needle)
                            || target.contains(&needle))
                })
        })
}
pub fn context_hash(d: &BenchmarkDraft) -> String {
    if d.role_id.is_none() && d.role_prompt.is_empty() {
        default_context_hash()
    } else {
        hash(
            serde_json::to_string(
                &json!({"role":d.role_id,"prompt":d.role_prompt,"permissions":d.permissions}),
            )
            .unwrap_or_default()
            .as_bytes(),
        )
    }
}
pub fn entry_hash(e: &EntryState) -> String {
    // Execution lineage identifies a run, not the public state shared by candidates.
    hash(serde_json::to_string(&json!({"schemaVersion":e.schema_version,"stepId":e.step_id,"fixtureSnapshotHash":e.fixture_snapshot_hash,"conversationPrefix":e.conversation_prefix,"previousReports":e.previous_reports,"remainingBudgetSeconds":e.remaining_budget_seconds})).unwrap_or_default().as_bytes())
}
pub fn normalize_draft(d: &mut BenchmarkDraft) {
    d.role_context_hash = context_hash(d);
    if let Some(e) = &mut d.entry_state {
        e.fixture_snapshot_hash = hash(&serde_json::to_vec(&d.fixtures).unwrap_or_default());
        e.content_hash = entry_hash(e);
    }
    d.facets.input_bytes = Some(
        (d.prompt.len()
            + d.fixtures.iter().map(|f| f.content.len()).sum::<usize>()
            + d.role_prompt.len()
            + d.entry_state
                .as_ref()
                .map(|e| {
                    e.conversation_prefix.len()
                        + e.previous_reports.iter().map(String::len).sum::<usize>()
                })
                .unwrap_or(0)) as u64,
    );
}
pub fn validate_draft(d: &BenchmarkDraft) -> Vec<String> {
    let mut issues = Vec::new();
    if !WORK_CLASSES.contains(&d.work_class_id.as_str()) {
        issues.push("Unknown Distill work class".into());
    }
    if d.facets
        .difficulty
        .as_ref()
        .is_some_and(|v| !["easy", "medium", "hard", "unspecified"].contains(&v.as_str()))
    {
        issues.push("Difficulty must be declared as easy, medium, hard or unspecified".into());
    }
    if d.role_prompt.len() > 64 * 1024 {
        issues.push("Role context exceeds 64 KiB".into());
    }
    if let Some(e) = &d.entry_state {
        if e.schema_version != 1
            || e.root_task_id.trim().is_empty()
            || e.step_id.trim().is_empty()
            || e.remaining_budget_seconds == 0
            || e.remaining_budget_seconds > super::MAX_TIME_LIMIT_SECONDS
            || e.conversation_prefix.len()
                + e.previous_reports.iter().map(String::len).sum::<usize>()
                > 128 * 1024
        {
            issues.push("Entry state requires versioned identity, a bounded visible prefix and remaining budget".into());
        }
    }
    if let Some(w) = &d.workflow {
        let ids: BTreeSet<_> = w.steps.iter().map(|s| &s.id).collect();
        if w.schema_version != 1
            || w.driver_revision.trim().is_empty()
            || !(2..=4).contains(&w.steps.len())
            || ids.len() != w.steps.len()
            || w.steps.first().is_some_and(|s| s.include_previous_output)
            || w.steps.iter().any(|s| {
                s.id.is_empty() || s.prompt.trim().is_empty() || s.prompt.len() > 128 * 1024
            })
        {
            issues.push("Workflow requires 2–4 unique bounded steps, a driver revision, and no previous output on the initial step".into());
        }
    }
    issues
}
pub fn snapshot(
    run_id: &str,
    version: &BenchmarkVersion,
    request: &RunRequest,
) -> DecisionSnapshot {
    let d = &version.manifest;
    DecisionSnapshot {
        schema_version: 1,
        id: uuid::Uuid::new_v4().to_string(),
        run_id: run_id.into(),
        version_id: version.id.clone(),
        task_family: d.task_family.clone(),
        split: d.split.clone(),
        created_at: now(),
        work_class_id: d.work_class_id.clone(),
        role_id: d.role_id.clone(),
        facets: d.facets.clone(),
        role_context_hash: d.role_context_hash.clone(),
        entry_state: d.entry_state.clone(),
        public_prompt: d.prompt.clone(),
        public_fixtures: d.fixtures.clone(),
        role_prompt: d.role_prompt.clone(),
        candidates: request
            .configurations
            .iter()
            .map(|c| RoutingCandidate {
                configuration: c.clone(),
                available: true,
                reason: Some(
                    "Selected in the frozen matrix; fresh dispatch admission is checked separately"
                        .into(),
                ),
            })
            .collect(),
        selection_provenance: "full_matrix".into(),
        request: request.clone(),
        feature_extraction_version: "public-input-bytes-v1".into(),
        objective: RoutingObjective {
            kind: "quality".into(),
            min_quality: 0.0,
        },
        constraints: RoutingConstraints {
            provider_ids: request
                .configurations
                .iter()
                .map(|c| c.provider_id.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            hard_candidate_key: (request.configurations.len() == 1)
                .then(|| candidate_key(&request.configurations[0])),
            max_duration_ms: Some(f64::from(request.timeout_seconds) * 1000.0),
            max_cost: None,
        },
        permissions: d.permissions.clone(),
        execution_profile: d.execution_profile.clone(),
        measurement_profile: d.measurement_profile.clone(),
    }
}
pub async fn persist_snapshot(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &DecisionSnapshot,
) -> Result<()> {
    sqlx::query("INSERT INTO decision_snapshots(id,run_id,version_id,created_at,data_json) VALUES(?,?,?,?,?)").bind(&record.id).bind(&record.run_id).bind(&record.version_id).bind(record.created_at).bind(serde_json::to_string(record)?).execute(&mut **tx).await?;
    Ok(())
}
impl Store {
    pub async fn decision_snapshots(&self) -> Result<Vec<DecisionSnapshot>> {
        sqlx::query_scalar::<_, String>(
            "SELECT data_json FROM decision_snapshots ORDER BY created_at,id",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|v| serde_json::from_str(&v).map_err(Into::into))
        .collect()
    }
    pub async fn candidate_observations(&self) -> Result<Vec<CandidateObservation>> {
        sqlx::query_scalar::<_, String>(
            "SELECT data_json FROM candidate_observations ORDER BY captured_at DESC LIMIT 1000",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|v| serde_json::from_str(&v).map_err(Into::into))
        .collect()
    }
    pub async fn record_inventory(
        &self,
        provider: &str,
        account: Option<&str>,
        models: &[InventoryModel],
    ) -> Result<()> {
        let observation = CandidateObservation {
            id: uuid::Uuid::new_v4().to_string(),
            captured_at: now(),
            provider_id: provider.into(),
            account_id: account.map(str::to_owned),
            models: models.to_vec(),
            authoritative: true,
        };
        sqlx::query("INSERT INTO candidate_observations(id,captured_at,provider_id,account_id,data_json) VALUES(?,?,?,?,?)").bind(&observation.id).bind(observation.captured_at).bind(provider).bind(account).bind(serde_json::to_string(&observation)?).execute(&self.pool).await?;
        Ok(())
    }
}
/// Declared facets narrow a class. The input size is a measurement every saved
/// draft records (`public-input-bytes-v1`), not a declared facet, so it never
/// narrows one: two cases of a class almost never have the same byte count.
fn facets_match(wanted: &TaskFacets, known: &TaskFacets) -> bool {
    wanted
        .language
        .as_ref()
        .is_none_or(|v| Some(v) == known.language.as_ref())
        && wanted
            .domain
            .as_ref()
            .is_none_or(|v| Some(v) == known.domain.as_ref())
        && wanted
            .difficulty
            .as_ref()
            .is_none_or(|v| Some(v) == known.difficulty.as_ref())
        && wanted
            .output_format
            .as_ref()
            .is_none_or(|v| Some(v) == known.output_format.as_ref())
}
fn average(values: impl Iterator<Item = f64>) -> Option<f64> {
    let values: Vec<f64> = values.collect();
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}
pub fn get_evidence(data: &QueryData, q: &RoutingEvidenceQuery) -> Result<RoutingEvidence> {
    if q.schema_version != 1
        || !["exact", "class"].contains(&q.mode.as_str())
        || !["analysis", "selector"].contains(&q.purpose.as_str())
        || !["quality", "latency", "cost"].contains(&q.objective.kind.as_str())
        || !q.objective.min_quality.is_finite()
        || !(0.0..=1.0).contains(&q.objective.min_quality)
        || q.candidates.len() > 200
        || q.max_age_ms > 10 * 365 * 24 * 3600 * 1000u64
        || q.cutoff_at > now()
        || q.timeout_seconds
            .is_some_and(|v| v == 0 || v > super::MAX_TIME_LIMIT_SECONDS)
        || q.constraints
            .max_cost
            .is_some_and(|v| !v.is_finite() || v < 0.0)
        || q.constraints
            .max_duration_ms
            .is_some_and(|v| !v.is_finite() || v <= 0.0)
        || q.permitted_splits
            .iter()
            .any(|s| !["development", "train", "held_out"].contains(&s.as_str()))
    {
        return Err(BenchmarkError::new(
            "validation",
            "Invalid routing evidence contract, objective or bounds",
        ));
    }
    if q.purpose == "selector"
        && (q.target_family.trim().is_empty() || q.permitted_splits.iter().any(|s| s == "held_out"))
    {
        return Err(BenchmarkError::new(
            "validation",
            "Selector input requires a target family and cannot include held-out labels",
        ));
    }
    if q.mode == "exact" && q.target_version_id.is_none() {
        return Err(BenchmarkError::new(
            "validation",
            "Exact evidence requires a frozen version ID",
        ));
    }
    if !WORK_CLASSES.contains(&q.work_class_id.as_str()) || q.permitted_splits.is_empty() {
        return Err(BenchmarkError::new(
            "validation",
            "Specify a known work class and permitted evidence splits",
        ));
    }
    let versions: BTreeMap<_, _> = data.versions.iter().map(|v| (v.id.as_str(), v)).collect();
    if let Some(id) = &q.target_version_id {
        if let Some(target) = versions.get(id.as_str()) {
            if q.purpose == "selector" && target.manifest.task_family != q.target_family {
                return Err(BenchmarkError::new(
                    "validation",
                    "Target family does not match the frozen target version",
                ));
            }
        } else if q.mode == "exact" {
            return Err(BenchmarkError::new(
                "validation",
                "Exact target version is not present in the catalog",
            ));
        }
    }
    let runs: BTreeMap<_, _> = data.runs.iter().map(|r| (r.id.as_str(), r)).collect();
    let compatible_version = |v: &BenchmarkVersion| {
        let d = &v.manifest;
        q.permitted_splits.contains(&d.split)
            && !(q.purpose == "selector" && d.task_family == q.target_family)
            && d.role_context_hash == q.role_context_hash
            && d.entry_state.as_ref().map(|e| &e.content_hash) == q.entry_state_hash.as_ref()
            && if q.mode == "exact" {
                q.target_version_id.as_deref() == Some(v.id.as_str())
            } else {
                d.work_class_id == q.work_class_id && facets_match(&q.facets, &d.facets)
            }
    };
    // Class evidence owes the pool as it stood at the cutoff, so a later
    // publication never changes an earlier answer. Exact queries name a frozen case.
    let cutoff_pool = super::analysis::pool(
        data,
        &ResultQuery {
            as_of: Some(q.cutoff_at),
            ..Default::default()
        },
    );
    let expected_cases: BTreeSet<_> = data
        .versions
        .iter()
        .filter(|v| {
            compatible_version(v) && (q.mode == "exact" || cutoff_pool.iter().any(|p| p.id == v.id))
        })
        .map(|v| v.id.as_str())
        .collect();
    let protocol_timeout = q.timeout_seconds;
    // The run filter: an explicit timeout keeps only runs with exactly that
    // timeout, otherwise a run must give the case its published time budget.
    let within_protocol = |run: &BenchmarkRun, version: &BenchmarkVersion| match protocol_timeout {
        Some(t) => run.request.timeout_seconds == t,
        None => run.request.timeout_seconds >= version.manifest.limits.timeout_seconds,
    };
    let mut rows = Vec::new();
    for candidate in &q.candidates {
        let key = candidate_key(&candidate.configuration);
        // Runs outside the protocol are left out before the newest cell is
        // chosen, so a shorter smoke run never hides an older compliant cell.
        let mut by_case: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
        for a in data.attempts.iter().filter(|a| {
            expected_cases.contains(a.version_id.as_str())
                && runs.get(a.run_id.as_str()).is_some_and(|r| {
                    !r.request.preview
                        && r.created_at <= q.cutoff_at
                        && versions
                            .get(a.version_id.as_str())
                            .is_some_and(|v| within_protocol(r, v))
                })
                && candidate_key(&super::analysis::execution_configuration(a)) == key
        }) {
            by_case.entry(&a.version_id).or_default().push(a);
        }
        let selected: BTreeSet<_> = by_case
            .iter()
            .flat_map(|(version, list)| {
                let required = versions
                    .get(version)
                    .map_or(data.required_repetitions.max(1), |v| {
                        super::analysis::required_repetitions(data, v)
                    });
                super::analysis::latest_cell_attempts(list, &runs, Some(q.cutoff_at), required)
            })
            .map(|a| &a.id)
            .collect();
        let mut samples = Vec::new();
        let mut stale_seen = false;
        for a in data.attempts.iter().filter(|a| selected.contains(&a.id)) {
            let Some(run) = runs.get(a.run_id.as_str()) else {
                continue;
            };
            let Some(v) = versions.get(a.version_id.as_str()) else {
                continue;
            };
            let d = &v.manifest;
            if run.request.preview || !within_protocol(run, v) {
                continue;
            }
            if !q.permitted_splits.contains(&d.split)
                || a.finished_at.is_none_or(|t| t > q.cutoff_at)
                || a.phase != "terminal"
                || (q.purpose == "selector" && d.task_family == q.target_family)
            {
                continue;
            }
            if d.role_context_hash != q.role_context_hash
                || d.entry_state.as_ref().map(|e| &e.content_hash) != q.entry_state_hash.as_ref()
            {
                continue;
            }
            if q.mode == "exact" {
                if q.target_version_id.as_deref() != Some(a.version_id.as_str()) {
                    continue;
                }
            } else if d.work_class_id != q.work_class_id || !facets_match(&q.facets, &d.facets) {
                continue;
            }
            let config = super::analysis::execution_configuration(a);
            if candidate_key(&config) != key {
                continue;
            }
            if authored_by_candidate(d, &candidate.configuration) {
                continue;
            }
            if candidate
                .configuration
                .inventory_revision
                .as_ref()
                .is_some_and(|r| Some(r) != config.inventory_revision.as_ref())
                || a.finished_at
                    .is_some_and(|t| t < q.cutoff_at.saturating_sub(q.max_age_ms as i64))
            {
                stale_seen = true;
                continue;
            }
            samples.push((a, *v));
        }
        let covered_cases: BTreeSet<_> = samples.iter().map(|(_, v)| v.id.as_str()).collect();
        // Cases this candidate helped author are neither owed nor counted.
        let owed_cases: BTreeSet<_> = expected_cases
            .iter()
            .copied()
            .filter(|id| {
                versions
                    .get(id)
                    .is_none_or(|v| !authored_by_candidate(&v.manifest, &candidate.configuration))
            })
            .collect();
        let missing_count = samples
            .iter()
            .filter(|(a, _)| score_at(a, q.cutoff_at).is_none())
            .count() as u32
            + owed_cases.difference(&covered_cases).count() as u32;
        samples.retain(|(a, _)| score_at(a, q.cutoff_at).is_some());
        let mut cases: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
        let mut families = BTreeSet::new();
        for (a, v) in &samples {
            let score = score_at(a, q.cutoff_at);
            if let Some(score) = score {
                cases.entry(&a.version_id).or_default().push(score);
                families.insert(&v.manifest.task_family);
            }
        }
        let quality = average(
            cases
                .values()
                .map(|scores| scores.iter().sum::<f64>() / scores.len() as f64),
        );
        let duration = if samples.iter().all(|(a, _)| a.duration_ms.is_some()) {
            average(
                samples
                    .iter()
                    .filter_map(|(a, _)| a.duration_ms.map(|v| v as f64)),
            )
        } else {
            None
        };
        let cost = super::analysis::mean_case_cost(
            &samples.iter().map(|(a, _)| *a).collect::<Vec<_>>(),
            Some(q.cutoff_at),
        );
        let mut row = RoutingEvidenceRow {
            candidate_key: key.clone(),
            configuration: candidate.configuration.clone(),
            available: candidate.available,
            eligible: true,
            status: "preliminary".into(),
            reason: if q.mode == "class" {
                "Declared class/facet aggregate; not a measured probability for the unseen target"
            } else {
                "Observed outcomes for the frozen exact case"
            }
            .into(),
            quality,
            mean_duration_ms: duration,
            mean_cost: cost,
            sample_count: samples.len() as u32,
            missing_count,
            protocol_timeout_seconds: protocol_timeout,
            family_count: families.len() as u32,
            latest_evidence_at: samples.iter().filter_map(|(a, _)| a.finished_at).max(),
            attempt_ids: samples.iter().map(|(a, _)| a.id.clone()).collect(),
        };
        let denial = if !candidate.available {
            Some((
                "unavailable",
                candidate.reason.clone().unwrap_or_else(|| {
                    "Candidate is absent from the caller's current eligible inventory".into()
                }),
            ))
        } else if q
            .constraints
            .hard_candidate_key
            .as_ref()
            .is_some_and(|pin| pin != &key)
            || (!q.constraints.provider_ids.is_empty()
                && !q
                    .constraints
                    .provider_ids
                    .contains(&candidate.configuration.provider_id))
        {
            Some((
                "excluded",
                "Candidate violates a hard identity or provider constraint".into(),
            ))
        } else if quality.is_none() && !expected_cases.is_empty() && owed_cases.is_empty() {
            // Authored cells are never planned, so the case sets decide this,
            // not attempts on them.
            Some((
                "excluded",
                "Candidate helped author every compatible case; its own answers cannot count"
                    .into(),
            ))
        } else if quality.is_none() {
            Some((
                if stale_seen { "stale" } else { "untested" },
                if stale_seen {
                    "Only older or incompatible runtime evidence is available"
                } else {
                    "No permitted earlier evidence matches the declared task/context"
                }
                .into(),
            ))
        } else if missing_count > 0 {
            Some((
                "insufficient_evidence",
                "Relevant attempts are missing valid quality outcomes".into(),
            ))
        } else if (q.objective.kind == "cost" || q.constraints.max_cost.is_some()) && cost.is_none()
        {
            Some((
                "insufficient_evidence",
                "Measured cost is unknown; missing resource use cannot qualify as free".into(),
            ))
        } else if (q.objective.kind == "latency" || q.constraints.max_duration_ms.is_some())
            && duration.is_none()
        {
            Some((
                "insufficient_evidence",
                "Duration is not measured for all observations".into(),
            ))
        } else if quality.is_some_and(|value| value < q.objective.min_quality)
            || q.constraints
                .max_cost
                .zip(cost)
                .is_some_and(|(cap, value)| value > cap)
            || q.constraints
                .max_duration_ms
                .zip(duration)
                .is_some_and(|(cap, value)| value > cap)
        {
            Some((
                "below_requirement",
                "Observed quality or measured resource use does not meet the declared objective"
                    .into(),
            ))
        } else {
            None
        };
        if let Some((status, reason)) = denial {
            row.eligible = false;
            row.status = status.into();
            row.reason = reason;
        }
        rows.push(row);
    }
    Ok(RoutingEvidence {
        schema_version: 1,
        generated_at: now(),
        query_hash: hash(&serde_json::to_vec(q)?),
        mode: q.mode.clone(),
        candidates: rows,
    })
}
fn score_at(attempt: &Attempt, cutoff: i64) -> Option<f64> {
    super::analysis::score_as_of(attempt, Some(cutoff))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(effort: &str) -> Configuration {
        Configuration {
            id: format!("model-{effort}"),
            provider_id: "provider-native".into(),
            account_id: Some("account".into()),
            model_id: "model-native".into(),
            effort: Some(effort.into()),
            fast_mode: Some(false),
            billing_mode: "subscription".into(),
            execution_profile: "native_text".into(),
            inventory_revision: Some("runtime-v1".into()),
            model_name: None,
        }
    }
    fn request(configurations: Vec<Configuration>) -> RunRequest {
        RunRequest {
            request_key: "key".into(),
            version_ids: vec![],
            configurations,
            repetitions: 1,
            timeout_seconds: 120,
            max_executions: 20,
            preview: false,
            top_up: false,
        }
    }
    fn matrix() -> (QueryData, RoutingEvidenceQuery) {
        let mut data = QueryData {
            definitions: vec![],
            versions: vec![],
            runs: vec![],
            attempts: vec![],
            required_repetitions: 1,
        };
        let candidates = vec![config("low"), config("high")];
        for difficulty in ["easy", "hard"] {
            for family in 0..2 {
                let mut manifest = super::super::seeds::definitions().remove(0);
                manifest.task_family = format!("calibration-{difficulty}-{family}");
                manifest.split = "train".into();
                manifest.facets.difficulty = Some(difficulty.into());
                let version = BenchmarkVersion {
                    id: format!("{difficulty}-{family}"),
                    definition_id: format!("def-{difficulty}-{family}"),
                    content_hash: "hash".into(),
                    published_at: 100,
                    manifest,
                };
                data.versions.push(version.clone());
                for configuration in &candidates {
                    let pass =
                        difficulty == "easy" || configuration.effort.as_deref() == Some("high");
                    let id = format!("{}-{}", version.id, configuration.id);
                    let mut run_request = request(candidates.clone());
                    run_request.version_ids = vec![version.id.clone()];
                    data.runs.push(BenchmarkRun {
                        id: id.clone(),
                        state: "completed".into(),
                        revision: 1,
                        created_at: 900,
                        updated_at: 1000,
                        request: run_request,
                        attempts: vec![],
                    });
                    data.attempts.push(Attempt {
                        id: id.clone(),
                        run_id: id,
                        version_id: version.id.clone(),
                        configuration: configuration.clone(),
                        repetition: 0,
                        phase: "terminal".into(),
                        outcome: Some(if pass { "pass" } else { "fail" }.into()),
                        reason: None,
                        wait_until: None,
                        session_id: None,
                        host_run_id: None,
                        observed: Some(configuration.clone()),
                        started_at: Some(900),
                        finished_at: Some(1000),
                        duration_ms: Some(if configuration.effort.as_deref() == Some("low") {
                            10
                        } else {
                            100
                        }),
                        output: Some("final answer must never enter features".into()),
                        evidence_hash: Some("evidence".into()),
                        usage: TokenUsage {
                            cost: None,
                            ..Default::default()
                        },
                        evaluations: vec![Evaluation {
                            id: "eval".into(),
                            evaluator_revision: "1".into(),
                            verdict: if pass { "pass" } else { "fail" }.into(),
                            score: Some(if pass { 1.0 } else { 0.0 }),
                            reason: String::new(),
                            created_at: 1000,
                            provenance: "objective".into(),
                            artifacts: vec![],
                            details: None,
                            judge: None,
                            usage: None,
                        }],
                        event_cursor: 1,
                        workflow_steps: vec![],
                        resolved_model: None,
                    });
                }
            }
        }
        let q = RoutingEvidenceQuery {
            schema_version: 1,
            mode: "class".into(),
            purpose: "selector".into(),
            target_version_id: None,
            target_family: "unseen-target".into(),
            work_class_id: default_work_class(),
            facets: TaskFacets {
                difficulty: Some("easy".into()),
                ..Default::default()
            },
            role_context_hash: default_context_hash(),
            entry_state_hash: None,
            candidates: candidates
                .into_iter()
                .map(|configuration| RoutingCandidate {
                    configuration,
                    available: true,
                    reason: None,
                })
                .collect(),
            cutoff_at: 2000,
            permitted_splits: vec!["train".into()],
            objective: RoutingObjective {
                kind: "latency".into(),
                min_quality: 0.9,
            },
            constraints: RoutingConstraints {
                provider_ids: vec![],
                hard_candidate_key: None,
                max_duration_ms: None,
                max_cost: None,
            },
            max_age_ms: 10_000,
            timeout_seconds: None,
        };
        (data, q)
    }
    // Deliberately lives in tests: production only returns evidence and constraints.
    fn consumer(evidence: &RoutingEvidence) -> Option<String> {
        evidence
            .candidates
            .iter()
            .filter(|c| c.eligible)
            .min_by(|a, b| {
                a.mean_duration_ms
                    .unwrap_or(f64::INFINITY)
                    .total_cmp(&b.mean_duration_ms.unwrap_or(f64::INFINITY))
            })
            .map(|c| c.candidate_key.clone())
    }
    #[test]
    fn consumer_distinguishes_difficulty_and_exact_native_controls() {
        let (data, mut q) = matrix();
        let easy = get_evidence(&data, &q).unwrap();
        assert_eq!(consumer(&easy), Some(candidate_key(&config("low"))));
        assert_eq!(easy.candidates[0].family_count, 2);
        q.facets.difficulty = Some("hard".into());
        let hard = get_evidence(&data, &q).unwrap();
        assert_eq!(consumer(&hard), Some(candidate_key(&config("high"))));
        assert_eq!(hard.candidates[0].quality, Some(0.0));
        assert_ne!(
            candidate_key(&config("low")),
            candidate_key(&config("high"))
        );
        // A display id never splits a candidate; an account does.
        let mut label = config("low");
        label.id = "unrelated display label".into();
        assert_eq!(candidate_key(&label), candidate_key(&config("low")));
        let mut account = config("low");
        account.account_id = Some("another account".into());
        assert_ne!(candidate_key(&account), candidate_key(&config("low")));
    }
    #[test]
    fn class_evidence_owes_the_pool_as_it_stood_at_the_cutoff() {
        let (mut data, q) = matrix();
        let mut replacement = data.versions[0].clone();
        assert_eq!(replacement.definition_id, "def-easy-0");
        replacement.id = "easy-0-v2".into();
        replacement.published_at = 3000;
        data.versions.push(replacement);
        // Published after the cutoff: the earlier version still counts.
        let before = get_evidence(&data, &q).unwrap();
        assert_eq!(before.candidates[0].sample_count, 2);
        assert_eq!(before.candidates[0].missing_count, 0);
        assert_eq!(consumer(&before), Some(candidate_key(&config("low"))));
        // Published before the cutoff: the replacement is owed and unmeasured.
        data.versions.last_mut().unwrap().published_at = 1500;
        let after = get_evidence(&data, &q).unwrap();
        assert_eq!(after.candidates[0].sample_count, 1);
        assert_eq!(after.candidates[0].missing_count, 1);
        assert_eq!(after.candidates[0].status, "insufficient_evidence");
    }
    #[test]
    fn live_availability_new_candidates_pins_unknown_cost_and_staleness_are_explicit() {
        let (data, mut q) = matrix();
        q.candidates[0].available = false;
        let e = get_evidence(&data, &q).unwrap();
        assert_eq!(e.candidates[0].quality, Some(1.0));
        assert_eq!(e.candidates[0].status, "unavailable");
        assert_eq!(consumer(&e), Some(candidate_key(&config("high"))));
        let mut new = q.candidates[1].clone();
        new.configuration.model_id = "unseen-model-id".into();
        q.candidates.push(new);
        assert_eq!(
            get_evidence(&data, &q).unwrap().candidates[2].status,
            "untested"
        );
        q.constraints.hard_candidate_key = Some(candidate_key(&config("low")));
        assert!(consumer(&get_evidence(&data, &q).unwrap()).is_none());
        q.constraints.hard_candidate_key = None;
        q.candidates[0].available = true;
        q.objective.kind = "cost".into();
        assert!(get_evidence(&data, &q)
            .unwrap()
            .candidates
            .iter()
            .all(|c| !c.eligible));
        q.objective.kind = "quality".into();
        q.max_age_ms = 100;
        assert_eq!(
            get_evidence(&data, &q).unwrap().candidates[0].status,
            "stale"
        );
        q.max_age_ms = 10_000;
        q.role_context_hash = "unseen-role-context".into();
        assert_eq!(
            get_evidence(&data, &q).unwrap().candidates[0].status,
            "untested"
        );
    }
    #[test]
    fn target_preview_held_out_future_and_incomplete_labels_never_qualify() {
        let (mut data, mut q) = matrix();
        q.target_version_id = Some("easy-0".into());
        q.mode = "exact".into();
        assert!(get_evidence(&data, &q).is_err());
        q.target_family = "calibration-easy-0".into();
        assert!(get_evidence(&data, &q)
            .unwrap()
            .candidates
            .iter()
            .all(|c| c.sample_count == 0));
        q.mode = "class".into();
        q.target_version_id = None;
        q.target_family = "unseen-target".into();
        data.runs
            .iter_mut()
            .filter(|r| r.id.starts_with("easy-"))
            .for_each(|r| r.request.preview = true);
        assert!(get_evidence(&data, &q)
            .unwrap()
            .candidates
            .iter()
            .all(|c| c.sample_count == 0));
        for r in &mut data.runs {
            r.request.preview = false;
        }
        data.versions
            .iter_mut()
            .filter(|v| v.id.starts_with("easy-"))
            .for_each(|v| v.manifest.split = "held_out".into());
        assert!(get_evidence(&data, &q)
            .unwrap()
            .candidates
            .iter()
            .all(|c| c.sample_count == 0));
        q.permitted_splits.push("held_out".into());
        assert!(get_evidence(&data, &q).is_err());
        q.permitted_splits = vec!["train".into()];
        for v in &mut data.versions {
            v.manifest.split = "train".into();
        }
        for a in &mut data.attempts {
            a.evaluations[0].created_at = 3000;
        }
        assert!(get_evidence(&data, &q)
            .unwrap()
            .candidates
            .iter()
            .all(|c| c.sample_count == 0 && !c.eligible));
    }
    #[test]
    fn explicit_budget_filter_and_fractional_reviews_are_preserved() {
        let (mut data, mut q) = matrix();
        data.runs[0].request.timeout_seconds = 30;
        data.attempts[0].finished_at = Some(1100);
        let e = get_evidence(&data, &q).unwrap();
        assert!(e
            .candidates
            .iter()
            .all(|c| c.protocol_timeout_seconds.is_none()));
        assert_eq!(e.candidates[0].sample_count, 1);
        assert_eq!(e.candidates[1].sample_count, 2);
        q.timeout_seconds = Some(120);
        let e = get_evidence(&data, &q).unwrap();
        assert_eq!(e.candidates[0].sample_count, 1);
        assert_eq!(e.candidates[1].sample_count, 2);
        data.attempts[2].evaluations.push(Evaluation {
            id: "review".into(),
            evaluator_revision: "1".into(),
            verdict: "pass".into(),
            score: Some(0.5),
            reason: String::new(),
            created_at: 1500,
            provenance: "human".into(),
            artifacts: vec![],
            details: None,
            judge: None,
            usage: None,
        });
        assert_eq!(score_at(&data.attempts[2], 2000), Some(0.5));
        assert_eq!(score_at(&data.attempts[2], 1200), Some(1.0));
    }
    #[test]
    fn public_decision_and_contract_round_trip_have_no_outcome_inputs() {
        let (data, q) = matrix();
        let before = get_evidence(&data, &q).unwrap();
        let encoded = serde_json::to_string(&before).unwrap();
        assert!(!encoded.contains("final answer must never enter features"));
        let after: RoutingEvidence = serde_json::from_str(&encoded).unwrap();
        assert_eq!(consumer(&before), consumer(&after));
        assert_eq!(before.candidates[0].quality, after.candidates[0].quality);
        let decision = snapshot("run", &data.versions[0], &data.runs[0].request);
        let public = serde_json::to_value(&decision).unwrap();
        assert!(public.get("evaluator").is_none());
        assert!(public.get("evaluations").is_none());
        assert!(public.get("outcomes").is_none());
        assert_eq!(public["objective"]["kind"], "quality");
        let reloaded: DecisionSnapshot = serde_json::from_value(public).unwrap();
        assert_eq!(reloaded.public_prompt, decision.public_prompt);
        assert_eq!(
            candidate_key(&reloaded.candidates[0].configuration),
            candidate_key(&decision.candidates[0].configuration)
        );
    }
    #[test]
    fn a_candidate_that_authored_the_cases_is_excluded_not_scored() {
        let (mut data, mut q) = matrix();
        for version in &mut data.versions {
            version.manifest.environment["authoredBy"] = serde_json::json!(["model-native"]);
        }
        let evidence = get_evidence(&data, &q).unwrap();
        assert!(evidence
            .candidates
            .iter()
            .all(|c| c.status == "excluded" && !c.eligible && c.sample_count == 0));
        for version in &mut data.versions {
            version.manifest.environment["authoredBy"] = serde_json::json!(["provider-native"]);
        }
        assert_eq!(
            get_evidence(&data, &q).unwrap().candidates[0].status,
            "excluded"
        );
        for version in &mut data.versions {
            version.manifest.environment["authoredBy"] = serde_json::json!(["someone-else"]);
        }
        q.facets.difficulty = Some("easy".into());
        assert_eq!(
            get_evidence(&data, &q).unwrap().candidates[0].status,
            "preliminary"
        );
        let mut other = config("low");
        other.model_id = "Model-Native".into();
        assert!(!authored_by_candidate(
            &data.versions[0].manifest,
            &config("low")
        ));
        data.versions[0].manifest.environment["authoredBy"] = serde_json::json!([" native "]);
        assert!(authored_by_candidate(&data.versions[0].manifest, &other));
    }
    #[test]
    fn an_alias_authors_what_its_target_wrote() {
        let (data, _) = matrix();
        let mut draft = data.versions[0].manifest.clone();
        draft.environment["authoredBy"] = serde_json::json!(["opus"]);
        let mut alias = config("low");
        alias.provider_id = "claude-acp".into();
        alias.model_id = "default".into();
        assert!(authored_by_candidate(&draft, &alias));
        alias.model_id = "sonnet".into();
        assert!(!authored_by_candidate(&draft, &alias));
    }
    #[test]
    fn a_newer_run_outside_the_protocol_never_hides_an_older_compliant_cell() {
        let (mut data, mut q) = matrix();
        // A later 30 s smoke run failed a case the 120 s run passed.
        let mut run = data.runs[0].clone();
        assert_eq!(run.id, "easy-0-model-low");
        run.id = "smoke".into();
        run.created_at = 950;
        run.request.timeout_seconds = 30;
        let mut attempt = data.attempts[0].clone();
        attempt.id = "smoke".into();
        attempt.run_id = "smoke".into();
        attempt.outcome = Some("fail".into());
        attempt.finished_at = Some(1050);
        attempt.evaluations[0].verdict = "fail".into();
        attempt.evaluations[0].score = Some(0.0);
        data.runs.push(run);
        data.attempts.push(attempt);
        for timeout in [None, Some(120)] {
            q.timeout_seconds = timeout;
            let e = get_evidence(&data, &q).unwrap();
            assert_eq!(e.candidates[0].sample_count, 2, "{timeout:?}");
            assert_eq!(e.candidates[0].missing_count, 0, "{timeout:?}");
            assert_eq!(e.candidates[0].quality, Some(1.0), "{timeout:?}");
            assert_eq!(e.candidates[0].status, "preliminary", "{timeout:?}");
        }
        // Under the protocol, the newer scored cell still replaces the older one.
        q.timeout_seconds = None;
        data.runs.last_mut().unwrap().request.timeout_seconds = 120;
        let e = get_evidence(&data, &q).unwrap();
        assert_eq!(e.candidates[0].sample_count, 2);
        assert_eq!(e.candidates[0].quality, Some(0.5));
    }
    #[test]
    fn a_candidate_that_wrote_every_compatible_case_is_excluded_without_attempts() {
        let (mut data, mut q) = matrix();
        for version in &mut data.versions {
            version.manifest.environment["authoredBy"] = serde_json::json!(["model-native"]);
        }
        // Authored cells are no longer planned, and an older plan's authored
        // cells settle as excluded without starting.
        for a in &mut data.attempts {
            a.started_at = None;
            a.outcome = Some("excluded".into());
            a.evaluations.clear();
        }
        let settled = get_evidence(&data, &q).unwrap();
        data.attempts.clear();
        let unplanned = get_evidence(&data, &q).unwrap();
        for evidence in [settled, unplanned] {
            assert!(evidence
                .candidates
                .iter()
                .all(|c| c.status == "excluded" && !c.eligible && c.sample_count == 0));
        }
        // No compatible case at all stays untested.
        q.role_context_hash = "unseen-role-context".into();
        assert_eq!(
            get_evidence(&data, &q).unwrap().candidates[0].status,
            "untested"
        );
    }
    #[test]
    fn a_measured_input_size_never_narrows_a_class() {
        let (mut data, mut q) = matrix();
        for (index, version) in data.versions.iter_mut().enumerate() {
            version.manifest.facets.input_bytes = Some(1000 + index as u64);
        }
        // The target's own measured size, as the routing dialog sends it.
        q.facets.input_bytes = Some(5000);
        let e = get_evidence(&data, &q).unwrap();
        assert_eq!(e.candidates[0].sample_count, 2);
        assert_eq!(e.candidates[0].quality, Some(1.0));
        assert_eq!(e.candidates[0].status, "preliminary");
        assert_eq!(consumer(&e), Some(candidate_key(&config("low"))));
    }
    #[test]
    fn partial_case_coverage_cannot_win_a_comparable_class_cohort() {
        let (mut data, q) = matrix();
        data.attempts.retain(|a| a.id != "easy-1-model-low");
        let evidence = get_evidence(&data, &q).unwrap();
        assert_eq!(evidence.candidates[0].sample_count, 1);
        assert_eq!(evidence.candidates[0].missing_count, 1);
        assert_eq!(evidence.candidates[0].status, "insufficient_evidence");
        assert_eq!(consumer(&evidence), Some(candidate_key(&config("high"))));
    }
}
