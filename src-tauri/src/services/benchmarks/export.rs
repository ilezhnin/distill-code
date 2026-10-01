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
                let observations:Vec<_>=(0..run.request.repetitions).map(|repetition|{
                    let attempt=attempts.iter().find(|a|a.repetition==repetition);
                    let reward=attempt.and_then(|a|super::analysis::score(a));
                    json!({"repetition":repetition,"attemptId":attempt.map(|a|&a.id),"reward":reward,"observed":reward.is_some(),
                        "outcome":attempt.and_then(|a|a.outcome.as_deref()),"phase":attempt.map(|a|&a.phase),"startedAt":attempt.and_then(|a|a.started_at),"finishedAt":attempt.and_then(|a|a.finished_at),"durationMs":attempt.and_then(|a|a.duration_ms),
                        "usage":attempt.map(|a|&a.usage),"evidenceHash":attempt.and_then(|a|a.evidence_hash.as_ref()),
                        "observedConfiguration":attempt.and_then(|a|a.observed.as_ref()).map(|c|public_configuration(c,salt)),
                        "workflowSteps":attempt.map(|a|&a.workflow_steps),
                        "evaluationRevisions":attempt.map(|a|a.evaluations.iter().map(|e|json!({"id":e.id,"revision":e.evaluator_revision,"provenance":e.provenance,"verdict":e.verdict,"score":e.score,"createdAt":e.created_at})).collect::<Vec<_>>()),
                        "subscriptionCharge":null,"subscriptionChargeReason":"See batch-level quota evidence; never allocated by token share"})
                }).collect();
                matrix.push(json!({"configuration":public_configuration(config,salt),"outcomes":observations}));
            }
            result.push(json!({"schemaVersion":1,"runId":run.id,"taskVersion":version.id,"contentHash":version.content_hash,
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
        row["decision"] = json!({"id":snapshot.id,"createdAt":snapshot.created_at,"featureExtractionVersion":snapshot.feature_extraction_version,
            "selectionProvenance":snapshot.selection_provenance,"schemaVersion":snapshot.schema_version,
            "objective":snapshot.objective,"constraints":snapshot.constraints,"permissions":snapshot.permissions,
            "executionProfile":snapshot.execution_profile,"measurementProfile":snapshot.measurement_profile,
            "budget":{"timeoutSeconds":snapshot.request.timeout_seconds,"maxExecutions":snapshot.request.max_executions,"repetitions":snapshot.request.repetitions},
            "candidateAvailability":snapshot.candidates.iter().map(|candidate|json!({"configuration":public_configuration(&candidate.configuration,&id),"available":candidate.available,"reason":candidate.reason})).collect::<Vec<_>>()});
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
    let mut jsonl = String::new();
    for row in &rows {
        jsonl.push_str(&serde_json::to_string(row)?);
        jsonl.push('\n');
    }
    let hash = format!("{:x}", Sha256::digest(jsonl.as_bytes()));
    let manifest = json!({"schemaVersion":1,"id":id,"createdAt":now(),"rowCount":rows.len(),"contentHash":hash,"catalogDefinitions":data.definitions.len(),
        "purpose":if include_held_out{"explicit_evaluation_export"}else{"training"},"includesHeldOut":include_held_out,
        "aggregation":"equal frozen-case means over observed repetitions; missing values stay null",
        "quotaSemantics":"whole controlled batch only; mixed and unknown charges are omitted",
        "quota":quota,"versions":rows.iter().map(|row|json!({"version":row["taskVersion"],"family":row["family"],"split":row["split"],"hash":row["contentHash"]})).collect::<Vec<_>>()});
    let path = directory.join("outcomes.jsonl");
    let manifest_path = directory.join("manifest.json");
    tokio::fs::write(&path, jsonl).await?;
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
    use super::*;
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
    }
}
