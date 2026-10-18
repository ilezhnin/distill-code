use super::super::tests::data;
use super::*;

/// The training fixture plus eight measured held-out cases in eight groups,
/// copied from training cases of the same prompt kind, and a train-only
/// vendor that solves every case.
fn measured() -> QueryData {
    let mut data = data();
    let mut vendor = data.runs[0].request.configurations[0].clone();
    vendor.id = "vendor".into();
    vendor.provider_id = "zai-acp".into();
    vendor.model_id = "vendor-model".into();
    let solved: Vec<_> = data
        .attempts
        .iter()
        .filter(|a| a.configuration.model_id == "parser")
        .cloned()
        .map(|mut a| {
            a.id = format!("{}-vendor", a.id);
            a.configuration = vendor.clone();
            a.observed = Some(vendor.clone());
            a.outcome = Some("pass".into());
            a
        })
        .collect();
    data.attempts.extend(solved);
    data.runs[0].request.configurations.push(vendor);
    let train = data.versions.clone();
    let attempts = data.attempts.clone();
    for (index, source) in train.iter().take(8).enumerate() {
        let mut version = source.clone();
        version.id = format!("held-{index}");
        version.definition_id = version.id.clone();
        version.content_hash = format!("held-hash-{index}");
        version.manifest.split = "held_out".into();
        version.manifest.task_family = format!("held-family-{index}");
        version.manifest.environment =
            serde_json::json!({"splitGroup": format!("held-group-{index}")});
        for attempt in attempts.iter().filter(|a| a.version_id == source.id) {
            let mut attempt = attempt.clone();
            attempt.id = format!("{}-{}", version.id, attempt.id);
            attempt.version_id = version.id.clone();
            data.attempts.push(attempt);
        }
        data.runs[0].request.version_ids.push(version.id.clone());
        data.versions.push(version);
    }
    data
}

/// The default provider data use: Z.ai and Kimi may train on submissions.
fn data_use() -> DataUse {
    DataUse::from_settings(&serde_json::Value::Null)
}

fn request() -> PreviewRequest {
    PreviewRequest {
        work_class_id: "debug".into(),
        excluded_providers: vec![],
    }
}

#[test]
fn candidates_come_from_training_cells_and_skip_train_only_vendors() {
    let data = measured();
    let fit_request = training_request(&data, &request(), 10, &data_use()).unwrap();
    let models: BTreeSet<_> = fit_request
        .configurations
        .iter()
        .map(|c| c.model_id.as_str())
        .collect();
    assert_eq!(models, BTreeSet::from(["painter", "parser"]));
    assert_eq!(fit_request.version_ids.len(), 16);
    assert!(fit_request.version_ids.iter().all(|id| data
        .versions
        .iter()
        .any(|v| &v.id == id && v.manifest.split == "train")));
    assert_eq!(fit_request.runtime_match, Some(RuntimeMatch::ModelIdentity));
    // The same vendor list guards every held-out comparison pool.
    assert!(require_held_out_pool(&fit_request.configurations, &data_use()).is_ok());
    assert!(require_held_out_pool(&data.runs[0].request.configurations, &data_use()).is_err());
    assert!(
        fit_request
            .configurations
            .iter()
            .all(|c| c.account_id.is_none()
                && c.inventory_revision.as_deref() == Some("runtime-hash"))
    );
    // A user exclusion applies on top; with no pair left there is no fit.
    let mut excluded = request();
    excluded.excluded_providers = vec![" claude ".into()];
    assert_eq!(
        training_request(&data, &excluded, 10, &data_use())
            .unwrap_err()
            .code,
        "insufficient_training_evidence"
    );
    let mut unknown = request();
    unknown.work_class_id = "invented-class".into();
    assert!(training_request(&data, &unknown, 10, &data_use()).is_err());
}

#[test]
fn a_frozen_fit_previews_only_complete_held_out_cases_without_authority() {
    let mut data = measured();
    // One incomplete held-out cell removes its case from the comparison.
    data.attempts.retain(|a| {
        !(a.version_id == "held-7" && a.configuration.model_id == "painter" && a.repetition == 2)
    });
    let fit_request = training_request(&data, &request(), 10, &data_use()).unwrap();
    let artifact = fit(&data, fit_request).unwrap();
    assert!(artifact
        .model
        .training_families
        .iter()
        .all(|family| family.starts_with("family-")));
    let preview = preview(&data, &artifact, &request(), 10, &data_use()).unwrap();
    assert_eq!(preview.status, "retrospective_preview");
    assert!(!preview.dispatch_allowed);
    assert_eq!(preview.cases.len(), 7);
    assert_eq!(preview.groups, 7);
    assert_eq!(preview.fallback_cases, 0);
    assert_eq!(
        preview.excluded_providers,
        vec!["kimi-acp".to_owned(), "zai-acp".to_owned()]
    );
    let model_of = |key: &str| {
        preview
            .candidates
            .iter()
            .find(|c| c.candidate_key == key)
            .unwrap()
            .model_id
            .clone()
    };
    // The task-conditioned choice transfers to unseen prompts of each kind.
    for case in &preview.cases {
        let index: usize = case.version_id["held-".len()..].parse().unwrap();
        let expected = if index.is_multiple_of(2) {
            "parser"
        } else {
            "painter"
        };
        assert_eq!(model_of(&case.learned_key), expected, "{}", case.version_id);
        assert_eq!(case.cells.len(), 2);
    }
    assert_eq!(
        preview
            .candidates
            .iter()
            .map(|c| c.learned_cases)
            .sum::<usize>(),
        7
    );
    let policy = |name: &str| preview.policies.iter().find(|p| p.policy == name).unwrap();
    assert!(policy("learned").utility > policy("best_fixed").utility);
    assert!((policy("learned").utility - policy("oracle").utility).abs() < 1e-12);
    assert!(policy("best_fixed").selected_fixed_key.is_some());
    assert_eq!(preview.policies.len(), 6);
    let summary = preview.summary();
    assert_eq!(summary.held_out_cases, 7);
    assert_eq!(summary.learned.unwrap().policy, "learned");
}

#[test]
fn a_class_without_measured_held_out_cases_says_so() {
    let data = data();
    let artifact = fit(
        &data,
        training_request(&data, &request(), 10, &data_use()).unwrap(),
    )
    .unwrap();
    let preview = preview(&data, &artifact, &request(), 10, &data_use()).unwrap();
    assert_eq!(preview.status, "no_held_out_cases");
    assert!(preview.cases.is_empty() && preview.policies.is_empty());
}

#[tokio::test]
async fn the_newest_preview_of_a_class_reaches_its_policy_and_resists_tampering() {
    let data = measured();
    let artifact = fit(
        &data,
        training_request(&data, &request(), 10, &data_use()).unwrap(),
    )
    .unwrap();
    let first = preview(&data, &artifact, &request(), 10, &data_use()).unwrap();
    let mut second = first.clone();
    second.created_at = first.created_at + 1;
    second.artifact_hash.clear();
    second.artifact_hash = hash(&second).unwrap();
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    store.save_selector_fit(&artifact).await.unwrap();
    store.save_selector_preview(&first).await.unwrap();
    store.save_selector_preview(&second).await.unwrap();
    // Retrying a save is harmless; a forged artifact is refused.
    store.save_selector_preview(&first).await.unwrap();
    let mut forged = first.clone();
    forged.dispatch_allowed = true;
    assert!(store.save_selector_preview(&forged).await.is_err());
    let latest = store.latest_selector_previews().await.unwrap();
    assert_eq!(latest.len(), 1);
    assert_eq!(latest[0].artifact_hash, second.artifact_hash);
    let policies = store.class_policies().await.unwrap();
    let debug = policies
        .iter()
        .find(|p| p.work_class_id == "debug")
        .unwrap();
    let summary = debug.preview.as_ref().unwrap();
    assert_eq!(summary.held_out_cases, 8);
    assert_eq!(summary.model_id, artifact.model.id);
    assert!(debug.certificate_id.is_none());
    assert_eq!(debug.fits, 1);
    assert!(policies
        .iter()
        .filter(|p| p.work_class_id != "debug")
        .all(|p| p.preview.is_none()));
    // An unreadable newest row falls back to the class's previous preview.
    sqlx::query(
        "UPDATE selector_previews SET data_json=json_set(data_json,'$.status','certified') WHERE id=?",
    )
    .bind(&second.artifact_hash)
    .execute(&store.pool)
    .await
    .unwrap();
    let latest = store.latest_selector_previews().await.unwrap();
    assert_eq!(latest.len(), 1);
    assert_eq!(latest[0].artifact_hash, first.artifact_hash);
    // With none readable, every class's status still reads, without a preview.
    sqlx::query("UPDATE selector_previews SET data_json='{\"invented\":true}'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(store.latest_selector_previews().await.unwrap().is_empty());
    let policies = store.class_policies().await.unwrap();
    assert_eq!(policies.len(), routing::WORK_CLASSES.len());
    assert!(policies.iter().all(|p| p.preview.is_none()));
    directory.close().await;
}

#[test]
fn fit_requests_name_only_known_runtime_rules() {
    let body = |rule: &str| {
        serde_json::json!({
            "workClassId": "debug", "versionIds": [], "configurations": [],
            "cutoffAt": 1, "runtimeMatch": rule
        })
    };
    assert_eq!(
        serde_json::from_value::<FitRequest>(body("model_identity"))
            .unwrap()
            .runtime_match,
        Some(RuntimeMatch::ModelIdentity)
    );
    assert!(serde_json::from_value::<FitRequest>(body("loose")).is_err());
    // Requests without the field keep the exact rule and their hashes.
    let mut legacy = body("exact");
    legacy.as_object_mut().unwrap().remove("runtimeMatch");
    let parsed: FitRequest = serde_json::from_value(legacy.clone()).unwrap();
    assert!(parsed.runtime_match.is_none());
    assert!(serde_json::to_value(&parsed)
        .unwrap()
        .get("runtimeMatch")
        .is_none());
}
