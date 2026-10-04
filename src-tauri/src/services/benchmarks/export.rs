//! Portable evidence exports exclude protected evaluators and account identities.
use super::{
    store::{now, Store},
    types::*,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

fn pseudonym(salt: &str, id: &str) -> String {
    format!("account-{:x}", Sha256::digest(format!("{salt}:{id}")))
}
fn public_configuration(c: &Configuration, salt: &str) -> Value {
    json!({"id":pseudonym(salt,&format!("configuration:{}",c.id)),"candidateKey":super::routing::candidate_key(c),"providerId":c.provider_id,"account":c.account_id.as_ref().map(|id|pseudonym(salt,id)),
        "modelId":c.model_id,"effort":c.effort,"fastMode":c.fast_mode,"billingMode":c.billing_mode,
        "executionProfile":c.execution_profile,"inventoryRevision":c.inventory_revision})
}

pub fn rows(data: &QueryData, include_held_out: bool, salt: &str) -> Result<Vec<Value>> {
    let mut splits: BTreeMap<&str, &str> = BTreeMap::new();
    for version in &data.versions {
        let split = version.manifest.split.as_str();
        if splits
            .insert(&version.manifest.task_family, split)
            .is_some_and(|previous| previous != split)
        {
            return Err(BenchmarkError::new(
                "validation",
                "A task family crosses dataset splits",
            ));
        }
    }
    let mut result = Vec::new();
    for run in data.runs.iter().filter(|run| !run.request.preview) {
        for version_id in &run.request.version_ids {
            let version = data
                .versions
                .iter()
                .find(|version| &version.id == version_id)
                .ok_or_else(|| {
                    BenchmarkError::new("evidence_missing", "Dataset version is unavailable")
                })?;
            if version.manifest.split == "held_out" && !include_held_out {
                continue;
            }
            let mut matrix = Vec::new();
            for config in &run.request.configurations {
                let attempts: Vec<_> = data
                    .attempts
                    .iter()
                    .filter(|a| {
                        a.run_id == run.id
                            && a.version_id == *version_id
                            && a.configuration.id == config.id
                    })
                    .collect();
                let authored = super::routing::authored_by_candidate(&version.manifest, config);
                let observations:Vec<_>=(0..run.request.repetitions).map(|repetition|{
                    let attempt=attempts.iter().find(|a|a.repetition==repetition);
                    let reward=if authored { None } else { attempt.and_then(|a|super::analysis::score(a)) };
                    json!({"repetition":repetition,"attemptId":attempt.map(|a|&a.id),"reward":reward,"observed":reward.is_some(),
                        "excluded":authored.then_some("authored_by_candidate"),
                        "outcome":attempt.and_then(|a|super::analysis::effective_outcome(a.outcome.as_deref(),&a.evaluations)),"phase":attempt.map(|a|&a.phase),"startedAt":attempt.and_then(|a|a.started_at),"finishedAt":attempt.and_then(|a|a.finished_at),"durationMs":attempt.and_then(|a|a.duration_ms),
                        "usage":attempt.map(|a|&a.usage),"evidenceHash":attempt.and_then(|a|a.evidence_hash.as_ref()),
                        "observedConfiguration":attempt.and_then(|a|a.observed.as_ref()).map(|c|public_configuration(c,salt)),
                        "workflowSteps":attempt.map(|a|&a.workflow_steps),
                        "evaluationRevisions":attempt.map(|a|a.evaluations.iter().map(|e|json!({"id":e.id,"revision":e.evaluator_revision,"provenance":e.provenance,"verdict":e.verdict,"score":e.score,"createdAt":e.created_at,"usage":e.usage,
                            "judge":e.judge.as_ref().map(|c|public_configuration(c,salt)),
                            "judgeBatchId":e.details.as_ref().and_then(|d|d.get("judgeBatchId")),
                            "protocolHash":e.details.as_ref().and_then(|d|d.get("protocolHash"))})).collect::<Vec<_>>()),
                        "subscriptionCharge":null,"subscriptionChargeReason":"See batch-level quota evidence; never allocated by token share"})
                }).collect();
                matrix.push(json!({"configuration":public_configuration(config,salt),"outcomes":observations}));
            }
            result.push(json!({"schemaVersion":2,"candidateKeyAlgorithm":super::routing::CANDIDATE_KEY_ALGORITHM,
                "runId":run.id,"taskVersion":version.id,"contentHash":version.content_hash,
                "runCreatedAt":run.created_at,"protocol":{"timeoutSeconds":run.request.timeout_seconds,"repetitions":run.request.repetitions,"maxExecutions":run.request.max_executions},
                "family":version.manifest.task_family,"split":version.manifest.split,"category":version.manifest.category,
                "features":{"prompt":version.manifest.prompt,"fixtures":version.manifest.fixtures,
                    "workClassId":version.manifest.work_class_id,"roleId":version.manifest.role_id,"rolePrompt":version.manifest.role_prompt,
                    "facets":version.manifest.facets,"roleContextHash":version.manifest.role_context_hash,"entryState":version.manifest.entry_state,
                    "workflow":version.manifest.workflow,"executionProfile":version.manifest.execution_profile,"measurementProfile":version.manifest.measurement_profile,"limits":version.manifest.limits},
                "candidates":run.request.configurations.iter().map(|c|public_configuration(c,salt)).collect::<Vec<_>>(),
                "matrix":matrix,"evaluatorRevision":version.manifest.evaluator.revision}));
        }
    }
    Ok(result)
}

/// Current cases joined across runs, with an explicit missing cell for every
/// measured candidate. Historical outcome rows remain a separate archive.
pub fn ledger_rows(data: &QueryData, include_held_out: bool, salt: &str) -> Result<Vec<Value>> {
    let archive = rows(data, include_held_out, salt)?;
    let runs: BTreeMap<_, _> = data
        .runs
        .iter()
        .filter(|r| !r.request.preview)
        .map(|r| (r.id.as_str(), r))
        .collect();
    let versions: BTreeMap<_, _> = data.versions.iter().map(|v| (v.id.as_str(), v)).collect();
    // A column needs one countable score on an exported case. Identities seen
    // only through unscored attempts (a changed model selection, failed
    // infrastructure) or only on withheld or self-authored cases are no candidates.
    let order = |a: &Attempt| (runs[a.run_id.as_str()].created_at, a.started_at);
    let mut newest: BTreeMap<String, &Attempt> = BTreeMap::new();
    for a in data.attempts.iter().filter(|a| {
        let c = super::analysis::execution_configuration(a);
        runs.contains_key(a.run_id.as_str())
            && versions.get(a.version_id.as_str()).is_some_and(|v| {
                (include_held_out || v.manifest.split != "held_out")
                    && !super::routing::authored_by_candidate(&v.manifest, &c)
            })
            && super::analysis::score(a).is_some()
    }) {
        let key = super::analysis::leaderboard_key(&super::analysis::execution_configuration(a));
        let entry = newest.entry(key).or_insert(a);
        if (order(a), &a.id) > (order(entry), &entry.id) {
            *entry = a;
        }
    }
    // A column names its newest scored configuration, as the leaderboard row
    // does, without the runner's `_auxiliary` marker of one attempt.
    let candidates: BTreeMap<String, Configuration> = newest
        .into_iter()
        .map(|(key, a)| {
            let mut c = super::analysis::execution_configuration(a).into_owned();
            if let Some(profile) = c.execution_profile.strip_suffix("_auxiliary") {
                c.execution_profile = profile.to_owned();
            }
            (key, c)
        })
        .collect();
    // A candidate owes only the cases some run planned for it, matched by
    // definition so a newer version of a planned case stays owed. A run plans
    // every case for its requested configuration and for each selection that
    // configuration's attempts in the run acknowledged, reached or not yet.
    let mut planned: BTreeSet<(String, &str)> = BTreeSet::new();
    for run in runs.values() {
        for configuration in &run.request.configurations {
            let requested = super::analysis::leaderboard_key(configuration);
            let mut keys: BTreeSet<String> = data
                .attempts
                .iter()
                .filter(|a| {
                    a.run_id == run.id
                        && super::analysis::leaderboard_key(&a.configuration) == requested
                })
                .map(|a| {
                    super::analysis::leaderboard_key(&super::analysis::execution_configuration(a))
                })
                .collect();
            keys.insert(requested);
            for id in &run.request.version_ids {
                if let Some(version) = versions.get(id.as_str()) {
                    for key in &keys {
                        planned.insert((key.clone(), version.definition_id.as_str()));
                    }
                }
            }
        }
    }
    // Attempts whose run no longer names their configuration still count.
    for a in data
        .attempts
        .iter()
        .filter(|a| runs.contains_key(a.run_id.as_str()))
    {
        if let Some(version) = versions.get(a.version_id.as_str()) {
            planned.insert((
                super::analysis::leaderboard_key(&super::analysis::execution_configuration(a)),
                version.definition_id.as_str(),
            ));
        }
    }
    let mut result = Vec::new();
    for version in super::analysis::pool(data, &ResultQuery::default()) {
        if version.manifest.split == "held_out" && !include_held_out {
            continue;
        }
        let mut matrix = Vec::new();
        for (key, configuration) in &candidates {
            let list: Vec<_> = data
                .attempts
                .iter()
                .filter(|a| {
                    a.version_id == version.id
                        && runs.contains_key(a.run_id.as_str())
                        && super::analysis::leaderboard_key(
                            &super::analysis::execution_configuration(a),
                        ) == *key
                })
                .collect();
            let selected = super::analysis::latest_cell_attempts(&list, &runs, None);
            let excluded = super::routing::authored_by_candidate(&version.manifest, configuration);
            let mut outcomes = Vec::new();
            for a in &selected {
                if let Some(observation) = archive
                    .iter()
                    .flat_map(|r| r["matrix"].as_array().into_iter().flatten())
                    .flat_map(|c| c["outcomes"].as_array().into_iter().flatten())
                    .find(|o| o["attemptId"] == a.id)
                {
                    outcomes.push(observation.clone());
                }
            }
            let complete = !excluded
                && !selected.is_empty()
                && selected.iter().all(|a| super::analysis::score(a).is_some());
            let reward = complete.then(|| {
                selected
                    .iter()
                    .filter_map(|a| super::analysis::score(a))
                    .sum::<f64>()
                    / selected.len() as f64
            });
            // An author never owes its own case, and nobody owes a case no run
            // planned for it: those cells are masked, not missing.
            let not_planned = !planned.contains(&(key.clone(), version.definition_id.as_str()));
            let owed = !excluded && !not_planned;
            matrix.push(json!({"configuration":public_configuration(configuration,salt), "owed":owed, "observed":complete,
                "notPlanned":not_planned,
                "reward":reward,"excluded":excluded.then_some("authored_by_candidate"),"outcomes":outcomes,
                "meanCost":super::analysis::mean_case_cost(&selected,None),
                "runId":selected.first().map(|a|&a.run_id),
                "effectiveTimeoutSeconds":selected.first().map(|a|runs[a.run_id.as_str()].request.timeout_seconds.min(version.manifest.limits.timeout_seconds)),
                "repetitions":selected.len()}));
        }
        // Complete means every owed cell is observed, and at least one is owed.
        let owed = matrix.iter().filter(|c| c["owed"] == true).count();
        let complete_matrix = owed > 0
            && matrix
                .iter()
                .filter(|c| c["owed"] == true)
                .all(|c| c["observed"] == true);
        result.push(json!({"schemaVersion":3,"candidateKeyAlgorithm":super::routing::CANDIDATE_KEY_ALGORITHM,
            "selectionProvenance":"current_pool_latest_settled_cell",
            "taskVersion":version.id,"contentHash":version.content_hash,"family":version.manifest.task_family,"split":version.manifest.split,
            "features":{"prompt":version.manifest.prompt,"fixtures":version.manifest.fixtures,"workClassId":version.manifest.work_class_id,
                "roleId":version.manifest.role_id,"rolePrompt":version.manifest.role_prompt,"facets":version.manifest.facets,
                "roleContextHash":version.manifest.role_context_hash,"entryState":version.manifest.entry_state,
                "workflow":version.manifest.workflow,"executionProfile":version.manifest.execution_profile,"limits":version.manifest.limits},
            "matrix":matrix,"owedCandidates":owed,"completeMatrix":complete_matrix,
            "evaluatorRevision":version.manifest.evaluator.revision}));
    }
    Ok(result)
}

/// The pre-dispatch decision. A recorded pin may predate the current key
/// algorithm, so it is re-derived from the pinned configuration to join the
/// row's `candidateKey`s; the stored value stays as `recordedHardCandidateKey`.
fn decision_record(snapshot: &DecisionSnapshot, salt: &str) -> Value {
    let recorded = snapshot.constraints.hard_candidate_key.as_ref();
    let pin = match snapshot.request.configurations.as_slice() {
        [only] if recorded.is_some() => Some(super::routing::candidate_key(only)),
        _ => None,
    };
    let mut constraints = json!(snapshot.constraints);
    constraints["hardCandidateKey"] = json!(pin);
    constraints["recordedHardCandidateKey"] = json!(recorded);
    json!({"id":snapshot.id,"createdAt":snapshot.created_at,"featureExtractionVersion":snapshot.feature_extraction_version,
        "selectionProvenance":snapshot.selection_provenance,"schemaVersion":snapshot.schema_version,
        "candidateKeyAlgorithm":super::routing::CANDIDATE_KEY_ALGORITHM,
        "objective":snapshot.objective,"constraints":constraints,"permissions":snapshot.permissions,
        "executionProfile":snapshot.execution_profile,"measurementProfile":snapshot.measurement_profile,
        "budget":{"timeoutSeconds":snapshot.request.timeout_seconds,"maxExecutions":snapshot.request.max_executions,"repetitions":snapshot.request.repetitions},
        "candidateAvailability":snapshot.candidates.iter().map(|candidate|json!({"configuration":public_configuration(&candidate.configuration,salt),"available":candidate.available,"reason":candidate.reason})).collect::<Vec<_>>()})
}

/// One JSON record per line, each newline-terminated: no rows is an empty file.
fn jsonl(rows: &[Value]) -> Result<String> {
    let mut body = String::new();
    for row in rows {
        body.push_str(&serde_json::to_string(row)?);
        body.push('\n');
    }
    Ok(body)
}

pub async fn export(
    store: &Store,
    data: QueryData,
    include_held_out: bool,
) -> Result<ExportResult> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut rows = rows(&data, include_held_out, &id)?;
    let snapshots = store.decision_snapshots().await?;
    for row in &mut rows {
        let snapshot = snapshots
            .iter()
            .find(|snapshot| {
                row["runId"] == snapshot.run_id && row["taskVersion"] == snapshot.version_id
            })
            .ok_or_else(|| {
                BenchmarkError::new(
                    "evidence_missing",
                    "Export requires a committed pre-dispatch decision snapshot",
                )
            })?;
        row["decision"] = decision_record(snapshot, &id);
    }
    let included: BTreeSet<_> = rows
        .iter()
        .filter_map(|row| row["runId"].as_str())
        .collect();
    let quota:Vec<_>=store.usage_samples().await?.into_iter().filter(|sample|included.contains(sample.run_id.as_str())).map(|sample|{
        json!({"id":sample.id,"runId":sample.run_id,"scope":pseudonym(&id,&sample.account_scope),"windowId":sample.window_id,
            "attribution":sample.attribution,"status":sample.status,"attemptIds":sample.attempt_ids,
            "batchPercentagePoints":if sample.attribution=="controlled_batch"{sample.used_percentage_points}else{None},
            "reason":sample.reason,"perTaskCharge":null})
    }).collect();
    let directory = store.root.join("exports").join(&id);
    tokio::fs::create_dir_all(&directory).await?;
    let outcomes_jsonl = jsonl(&rows)?;
    let hash = format!("{:x}", Sha256::digest(outcomes_jsonl.as_bytes()));
    let prepared = ledger_rows(&data, include_held_out, &id)?;
    let ledger_jsonl = jsonl(&prepared)?;
    let ledger_hash = format!("{:x}", Sha256::digest(ledger_jsonl.as_bytes()));
    let manifest = json!({"schemaVersion":2,"id":id,"createdAt":now(),"rowCount":rows.len(),"contentHash":hash,"catalogDefinitions":data.definitions.len(),
        "candidateKeyAlgorithm":super::routing::CANDIDATE_KEY_ALGORITHM,
        "purpose":if include_held_out{"explicit_evaluation_export"}else{"training"},"includesHeldOut":include_held_out,
        "aggregation":"equal frozen-case means over observed repetitions; missing values stay null",
        "archive":"outcomes.jsonl",
        "currentPool":{"path":"ledger.jsonl","rowCount":prepared.len(),"contentHash":ledger_hash,
            "selection":"latest settled repetitions per candidate and current task version; explicit observation masks",
            "trainingPolicy":"exclude held-out cases; require compatible protocols and every owed candidate cell observed (completeMatrix) before fitting soft targets; a candidate owes only the cases some run planned for it, so author-excluded and not-planned cells are masked, not missing"},
        "quotaSemantics":"whole controlled batch only; mixed and unknown charges are omitted",
        "quota":quota,"versions":rows.iter().map(|row|json!({"version":row["taskVersion"],"family":row["family"],"split":row["split"],"hash":row["contentHash"]})).collect::<Vec<_>>()});
    let path = directory.join("outcomes.jsonl");
    let manifest_path = directory.join("manifest.json");
    tokio::fs::write(&path, outcomes_jsonl).await?;
    tokio::fs::write(directory.join("ledger.jsonl"), ledger_jsonl).await?;
    tokio::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?).await?;
    let mut tx = store.pool.begin().await?;
    sqlx::query("INSERT INTO exports(id,data_json) VALUES(?,?)")
        .bind(&id)
        .bind(serde_json::to_string(&manifest)?)
        .execute(&mut *tx)
        .await?;
    super::store::event(&mut tx, &id, "dataset_exported").await?;
    tx.commit().await?;
    Ok(ExportResult {
        id,
        path: path.to_string_lossy().into_owned(),
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        row_count: rows.len() as u32,
        content_hash: hash,
    })
}

#[cfg(test)]
mod tests {
    use super::super::analysis::tests::dataset;
    use super::*;

    /// A completed run of one configuration over the named cases.
    fn add_run(
        data: &mut QueryData,
        id: &str,
        configuration: &Configuration,
        outcome: &str,
        version_ids: &[&str],
    ) {
        let mut run = data.runs[0].clone();
        run.id = id.into();
        run.created_at = 7;
        run.updated_at = 8;
        run.request.configurations = vec![configuration.clone()];
        run.request.version_ids = version_ids.iter().map(|v| (*v).to_string()).collect();
        for version in version_ids {
            let mut attempt = data.attempts[0].clone();
            attempt.id = format!("{id}-{version}");
            attempt.run_id = id.into();
            attempt.version_id = (*version).into();
            attempt.configuration = configuration.clone();
            attempt.observed = Some(configuration.clone());
            attempt.outcome = Some(outcome.into());
            data.attempts.push(attempt);
        }
        data.runs.push(run);
    }
    fn columns(row: &Value) -> usize {
        row["matrix"].as_array().map_or(0, Vec::len)
    }

    #[test]
    fn an_exported_pin_joins_the_candidate_keys_of_its_row() {
        let (data, _) = dataset();
        let request = &data.runs[0].request;
        let configuration = &request.configurations[0];
        let mut snapshot = super::super::routing::snapshot("before", &data.versions[0], request);
        // Recorded before the key covered account and billing.
        let legacy = super::super::fixtures::hash(
            serde_json::to_string(&json!([
                configuration.provider_id,
                configuration.model_id,
                configuration.effort,
                configuration.fast_mode,
                configuration.execution_profile
            ]))
            .unwrap()
            .as_bytes(),
        );
        snapshot.constraints.hard_candidate_key = Some(legacy.clone());
        let decision = decision_record(&snapshot, "export");
        assert_eq!(
            decision["constraints"]["hardCandidateKey"],
            public_configuration(configuration, "export")["candidateKey"]
        );
        assert_ne!(decision["constraints"]["hardCandidateKey"], legacy);
        assert_eq!(decision["constraints"]["recordedHardCandidateKey"], legacy);
        assert_eq!(
            decision["candidateKeyAlgorithm"],
            super::super::routing::CANDIDATE_KEY_ALGORITHM
        );
        snapshot.constraints.hard_candidate_key = None;
        let unpinned = decision_record(&snapshot, "export");
        assert!(unpinned["constraints"]["hardCandidateKey"].is_null());
        assert!(unpinned["constraints"]["recordedHardCandidateKey"].is_null());
    }

    #[test]
    fn an_author_excluded_cell_is_masked_not_missing() {
        let (mut data, _) = dataset();
        let mut author = data.runs[0].request.configurations[0].clone();
        author.id = "author".into();
        author.model_id = "author-model".into();
        let all: Vec<String> = data.versions.iter().map(|v| v.id.clone()).collect();
        let all: Vec<&str> = all.iter().map(String::as_str).collect();
        add_run(&mut data, "author-run", &author, "pass", &all);
        data.versions[0].manifest.environment["authoredBy"] = json!(["author-model"]);
        let rows = ledger_rows(&data, false, "t").unwrap();
        let authored = rows.iter().find(|r| r["taskVersion"] == "v0").unwrap();
        assert_eq!(columns(authored), 2);
        assert_eq!(authored["owedCandidates"], 1);
        let cell = authored["matrix"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["excluded"] == "authored_by_candidate")
            .unwrap();
        assert_eq!(cell["owed"], false);
        assert_eq!(cell["observed"], false);
        assert!(cell["reward"].is_null());
        // Every owed cell is measured, so every row is a complete matrix.
        assert!(rows.iter().all(|r| r["completeMatrix"] == true));
    }

    #[test]
    fn unscored_and_withheld_identities_add_no_column() {
        let (mut data, _) = dataset();
        let planned = data.runs[0].request.configurations[0].clone();
        // Another model whose every attempt failed on infrastructure, and one
        // whose run was cancelled before any attempt started.
        let mut broken = planned.clone();
        broken.id = "broken".into();
        broken.model_id = "broken-model".into();
        add_run(
            &mut data,
            "broken-run",
            &broken,
            "infrastructure_failure",
            &["v0", "v1", "v2", "v3", "v4", "v5"],
        );
        let mut gone = planned.clone();
        gone.id = "gone".into();
        gone.model_id = "gone-model".into();
        add_run(&mut data, "gone-run", &gone, "cancelled", &["v0", "v1"]);
        for a in data.attempts.iter_mut().filter(|a| a.run_id == "gone-run") {
            a.observed = None;
            a.started_at = None;
        }
        // A refused selection stays under the requested candidate's key.
        add_run(
            &mut data,
            "changed",
            &planned,
            "selection_changed",
            &["v0", "v1"],
        );
        for a in data.attempts.iter_mut().filter(|a| a.run_id == "changed") {
            a.observed.as_mut().unwrap().model_id = "default".into();
        }
        // This candidate was measured only on a held-out case.
        data.versions[5].manifest.split = "held_out".into();
        let mut withheld = planned.clone();
        withheld.id = "withheld".into();
        withheld.model_id = "withheld-model".into();
        add_run(&mut data, "withheld-run", &withheld, "pass", &["v5"]);
        let rows = ledger_rows(&data, false, "t").unwrap();
        assert_eq!(rows.len(), 5);
        assert!(rows
            .iter()
            .all(|r| columns(r) == 1 && r["completeMatrix"] == true));
        // An evaluation export adds the held-out candidate, which owes only the
        // case its run planned.
        let rows = ledger_rows(&data, true, "t").unwrap();
        assert!(rows.iter().all(|r| columns(r) == 2));
        assert!(rows.iter().all(|r| r["completeMatrix"] == true));
    }

    #[test]
    fn a_one_case_check_never_empties_the_training_set() {
        let (mut data, _) = dataset();
        let mut smoke = data.runs[0].request.configurations[0].clone();
        smoke.id = "smoke".into();
        smoke.model_id = "smoke-model".into();
        add_run(&mut data, "smoke", &smoke, "pass", &["v1"]);
        let rows = ledger_rows(&data, false, "t").unwrap();
        assert_eq!(rows.len(), 6);
        assert!(rows.iter().all(|r| columns(r) == 2));
        assert!(rows.iter().all(|r| r["completeMatrix"] == true));
        let cell = |row: &Value| {
            row["matrix"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["configuration"]["modelId"] == "smoke-model")
                .unwrap()
                .clone()
        };
        for row in &rows {
            let planned = row["taskVersion"] == "v1";
            let smoke = cell(row);
            assert_eq!(smoke["owed"], planned, "{}", row["taskVersion"]);
            assert_eq!(smoke["notPlanned"], !planned);
            assert_eq!(smoke["observed"], planned);
        }
        // Planned on every case but measured on one, it still owes the rest.
        let run = data.runs.iter_mut().find(|r| r.id == "smoke").unwrap();
        run.request.version_ids = (0..6).map(|i| format!("v{i}")).collect();
        let rows = ledger_rows(&data, false, "t").unwrap();
        assert_eq!(
            rows.iter()
                .filter(|r| r["completeMatrix"] == true)
                .map(|r| r["taskVersion"].clone())
                .collect::<Vec<_>>(),
            vec![json!("v1")]
        );
    }

    #[test]
    fn cases_a_paused_run_has_not_reached_stay_owed_under_the_acknowledged_selection() {
        let (mut data, _) = dataset();
        // The request left effort to the provider, which acknowledged "high".
        let mut asked = data.runs[0].request.configurations[0].clone();
        asked.id = "asked".into();
        asked.model_id = "other-model".into();
        asked.effort = None;
        add_run(
            &mut data,
            "partial",
            &asked,
            "pass",
            &["v0", "v1", "v2", "v3", "v4", "v5"],
        );
        data.runs.last_mut().unwrap().state = "paused".into();
        for a in data.attempts.iter_mut().filter(|a| a.run_id == "partial") {
            if a.version_id == "v0" || a.version_id == "v1" {
                a.observed.as_mut().unwrap().effort = Some("high".into());
            } else {
                a.phase = "pending".into();
                a.outcome = None;
                a.observed = None;
                a.started_at = None;
                a.finished_at = None;
                a.output = None;
            }
        }
        let rows = ledger_rows(&data, false, "t").unwrap();
        assert_eq!(rows.len(), 6);
        for row in &rows {
            assert_eq!(columns(row), 2);
            let cell = row["matrix"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["configuration"]["modelId"] == "other-model")
                .unwrap();
            assert_eq!(cell["configuration"]["effort"], "high");
            let reached = row["taskVersion"] == "v0" || row["taskVersion"] == "v1";
            assert_eq!(cell["owed"], true, "{}", row["taskVersion"]);
            assert_eq!(cell["notPlanned"], false, "{}", row["taskVersion"]);
            assert_eq!(cell["observed"], reached, "{}", row["taskVersion"]);
            assert_eq!(row["completeMatrix"], reached, "{}", row["taskVersion"]);
        }
    }

    #[test]
    fn a_display_id_never_splits_a_ledger_column() {
        let (mut data, _) = dataset();
        data.runs[1].request.configurations[0].id = "catch-up-label".into();
        for a in data.attempts.iter_mut().filter(|a| a.run_id == "after") {
            a.configuration.id = "catch-up-label".into();
            a.observed.as_mut().unwrap().id = "catch-up-label".into();
        }
        let rows = ledger_rows(&data, false, "t").unwrap();
        assert_eq!(rows.len(), 6);
        assert!(rows
            .iter()
            .all(|r| columns(r) == 1 && r["matrix"][0]["runId"] == "after"));
    }

    #[test]
    fn a_ledger_column_names_the_runnable_configuration_of_its_newest_run() {
        let (mut data, _) = dataset();
        // The newest run made auxiliary calls; the older one ran another runtime.
        for a in &mut data.attempts {
            let observed = a.observed.as_mut().unwrap();
            if a.run_id == "after" {
                a.usage.schema = "provider_turn_with_auxiliary_v2".into();
                observed.execution_profile = "native_text_auxiliary".into();
            } else {
                observed.inventory_revision = Some("older-runtime".into());
            }
        }
        // Whichever attempt comes last, the column is the same.
        for _ in 0..2 {
            let rows = ledger_rows(&data, false, "t").unwrap();
            assert_eq!(rows.len(), 6);
            for row in &rows {
                assert_eq!(columns(row), 1);
                let configuration = &row["matrix"][0]["configuration"];
                assert_eq!(configuration["executionProfile"], "native_text");
                assert_eq!(configuration["inventoryRevision"], "runtime-hash");
            }
            data.attempts.reverse();
        }
    }

    #[tokio::test]
    async fn an_empty_export_writes_empty_jsonl_files() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let data = QueryData {
            definitions: vec![],
            versions: vec![],
            runs: vec![],
            attempts: vec![],
        };
        let result = export(&store, data, false).await.unwrap();
        let ledger = std::path::Path::new(&result.path).with_file_name("ledger.jsonl");
        assert_eq!(tokio::fs::read_to_string(&ledger).await.unwrap(), "");
        assert_eq!(tokio::fs::read_to_string(&result.path).await.unwrap(), "");
        let manifest: Value =
            serde_json::from_slice(&tokio::fs::read(&result.manifest_path).await.unwrap()).unwrap();
        assert_eq!(manifest["currentPool"]["rowCount"], 0);
        assert_eq!(
            manifest["currentPool"]["contentHash"],
            format!("{:x}", Sha256::digest(b""))
        );
    }

    #[test]
    fn pseudonyms_do_not_expose_ids() {
        assert!(!pseudonym("export", "private-label").contains("private-label"));
        assert_eq!(pseudonym("export", "id"), pseudonym("export", "id"));
        assert_ne!(pseudonym("export", "id"), pseudonym("other", "id"));
    }
    #[test]
    fn matrix_roundtrip_preserves_nulls_failures_and_split_boundaries() {
        let (mut data, _) = super::super::analysis::tests::dataset();
        data.versions[0].manifest.split = "held_out".into();
        data.versions[1].manifest.evaluator.expected = "private-evaluator-canary".into();
        data.attempts.retain(|a| a.id != "after-v1");
        let exported = rows(&data, false, "export").unwrap();
        assert_eq!(exported.len(), 10);
        let missing = exported
            .iter()
            .find(|r| r["runId"] == "after" && r["taskVersion"] == "v1")
            .unwrap();
        assert!(missing["matrix"][0]["outcomes"][0]["reward"].is_null());
        assert_eq!(missing["matrix"][0]["outcomes"][0]["observed"], false);
        let failed = exported
            .iter()
            .find(|r| r["runId"] == "after" && r["taskVersion"] == "v2")
            .unwrap();
        assert_eq!(failed["matrix"][0]["outcomes"][0]["reward"], 0.0);
        assert!(failed["matrix"][0]["outcomes"][0]["subscriptionCharge"].is_null());
        let encoded = serde_json::to_string(&exported).unwrap();
        for private in [
            "private-account",
            "private-evaluator-canary",
            "private output",
        ] {
            assert!(!encoded.contains(private));
        }
        let restored: Vec<Value> = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored, exported);
        assert_eq!(rows(&data, true, "export").unwrap().len(), 12);
        let total: f64 = restored
            .iter()
            .filter_map(|r| r["matrix"][0]["outcomes"][0]["reward"].as_f64())
            .sum();
        assert_eq!(total, 5.0);
    }

    #[tokio::test]
    async fn exported_decision_precedes_outcomes_and_reloads_with_missing_cost() {
        let directory = tempfile::tempdir().unwrap();
        let service = super::super::BenchmarkService {
            store: Store::open(directory.path()).await.unwrap(),
            backend: std::sync::Arc::new(super::super::runner::FakeBackend::default()),
            wake: tokio::sync::Notify::new(),
            active: tokio::sync::Mutex::new(None),
            app: None,
        };
        let definition = service
            .store
            .save_draft(
                None,
                None,
                super::super::runner::seed_definitions().remove(0),
            )
            .await
            .unwrap();
        let version = service.store.publish(&definition.id, 1).await.unwrap();
        let inventory = service
            .backend
            .inventory("fake", Some("private-account"), false)
            .await
            .unwrap();
        let run = service
            .start_run(RunRequest {
                request_key: "export-test".into(),
                version_ids: vec![version.id],
                configurations: inventory.into_iter().map(|m| m.configuration).collect(),
                repetitions: 1,
                timeout_seconds: 10,
                max_executions: 2,
                preview: false,
            })
            .await
            .unwrap();
        let snapshot = service.store.decision_snapshots().await.unwrap().remove(0);
        let mut attempt = run.attempts[0].clone();
        attempt.phase = "terminal".into();
        attempt.outcome = Some("pass".into());
        attempt.finished_at = Some(now());
        attempt.output = Some("private-answer-not-a-feature".into());
        attempt.evidence_hash = Some("sealed".into());
        service.store.save_attempt(&attempt).await.unwrap();
        assert_eq!(
            serde_json::to_value(&snapshot).unwrap(),
            serde_json::to_value(service.store.decision_snapshots().await.unwrap().remove(0))
                .unwrap()
        );
        let result = export(&service.store, service.query_data().await.unwrap(), false)
            .await
            .unwrap();
        let body = tokio::fs::read_to_string(&result.path).await.unwrap();
        let row: Value = serde_json::from_str(body.trim()).unwrap();
        assert_eq!(row["decision"]["id"], snapshot.id);
        assert_eq!(row["matrix"].as_array().unwrap().len(), 2);
        assert!(row["matrix"][0]["outcomes"][0]["usage"]["cost"].is_null());
        assert!(!body.contains("private-account"));
        assert!(!body.contains("private-answer-not-a-feature"));
        let manifest: Value =
            serde_json::from_slice(&tokio::fs::read(&result.manifest_path).await.unwrap()).unwrap();
        assert_eq!(
            manifest["contentHash"],
            format!("{:x}", Sha256::digest(body.as_bytes()))
        );
        let ledger = tokio::fs::read_to_string(
            std::path::Path::new(&result.path).with_file_name("ledger.jsonl"),
        )
        .await
        .unwrap();
        assert!(ledger.ends_with('\n'));
        assert!(ledger
            .lines()
            .all(|line| serde_json::from_str::<Value>(line).is_ok()));
    }
}
