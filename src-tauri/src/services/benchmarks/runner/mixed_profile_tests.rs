//! A model's suite mixes bounded text cases and repository cases, and each
//! runs on its own execution profile: one run of the model carries one
//! configuration per profile and plans each case on its own only.
use super::super::{join_configurations, owed_executions, planned_cells, profile_gaps};
use super::tests::{request, setup};
use super::*;
use crate::services::benchmarks::repository;

/// A repository case beside `text`, in memory: publishing one needs the
/// sandbox's repository helper, and planning reads only the manifest.
fn repository_case(text: &BenchmarkVersion) -> BenchmarkVersion {
    let mut version = text.clone();
    version.id = "invented-repository-case".into();
    version.manifest.name = "Invented repository case".into();
    version.manifest.execution_profile = "protected_repository".into();
    version.manifest.evaluator.kind = repository::EVALUATOR.into();
    version
}

/// The repository configuration of the fake model.
fn repository_configuration(native: &Configuration) -> Configuration {
    Configuration {
        id: "fake-pass-repository".into(),
        execution_profile: "protected_repository".into(),
        // Unpinned: the fake inventory lists only its text profile.
        inventory_revision: None,
        ..native.clone()
    }
}

#[tokio::test]
async fn a_mixed_plan_pairs_each_case_with_its_profile_once() {
    let (dir, s, _) = setup().await;
    let mut req = request(&s).await;
    let text = s.store.version(&req.version_ids[0]).await.unwrap();
    let repo = repository_case(&text);
    req.version_ids.push(repo.id.clone());
    let native = req.configurations[0].clone();
    req.configurations.push(repository_configuration(&native));
    req.repetitions = 3;
    let versions = vec![text.clone(), repo.clone()];
    let cells = planned_cells(&req, &versions).unwrap();
    assert_eq!(cells.len(), 6);
    for (version, configuration, _) in &cells {
        let expected = if *version == repo.id {
            "protected_repository"
        } else {
            assert_eq!(*version, text.id);
            "native_text"
        };
        assert_eq!(configuration.execution_profile, expected);
    }
    // Each case three times, once per repetition, on one configuration.
    let mut repetitions: Vec<(String, u32)> = cells
        .iter()
        .map(|(version, _, repetition)| (version.clone(), *repetition))
        .collect();
    repetitions.sort();
    repetitions.dedup();
    assert_eq!(repetitions.len(), 6);
    assert_eq!(owed_executions(&versions, &req), 6);
    // Both profiles present: nothing to report.
    assert!(profile_gaps(&versions, &req.configurations).is_empty());
    dir.close().await;
}

#[tokio::test]
async fn a_case_without_a_configuration_of_its_profile_is_named() {
    let (dir, s, _) = setup().await;
    let req = request(&s).await;
    let text = s.store.version(&req.version_ids[0]).await.unwrap();
    let repo = repository_case(&text);
    let native = req.configurations[0].clone();
    let gaps = profile_gaps(&[text.clone(), repo.clone()], std::slice::from_ref(&native));
    assert_eq!(
        gaps,
        vec!["Invented repository case: add the repository configuration of this model to run this case"]
    );
    let gaps = profile_gaps(&[text, repo], &[repository_configuration(&native)]);
    assert_eq!(gaps.len(), 1);
    assert!(gaps[0].contains("add the native text configuration"));
    dir.close().await;
}

#[tokio::test]
async fn only_the_same_model_on_a_new_profile_joins_a_run() {
    let (dir, s, _) = setup().await;
    let req = request(&s).await;
    let native = req.configurations[0].clone();
    let joined = join_configurations(&req, &[repository_configuration(&native)]).unwrap();
    assert_eq!(joined.configurations.len(), 2);
    let mut other = repository_configuration(&native);
    other.model_id = "another-model".into();
    assert!(join_configurations(&req, &[other]).is_err());
    let mut same_profile = native.clone();
    same_profile.id = "another-text-configuration".into();
    assert!(join_configurations(&req, &[same_profile]).is_err());
    assert!(join_configurations(
        &joined,
        &[Configuration {
            id: "again".into(),
            ..repository_configuration(&native)
        }]
    )
    .is_err());
    dir.close().await;
}

#[tokio::test]
async fn finish_takes_the_repository_configuration_into_a_text_run() {
    let (dir, s, _) = setup().await;
    let mut req = request(&s).await;
    req.repetitions = 3;
    req.max_executions = 3;
    let native = req.configurations[0].clone();
    let run = s.start_run(req).await.unwrap();
    // Another model's configuration never joins; nothing changes.
    let mut other = repository_configuration(&native);
    other.model_id = "another-model".into();
    assert!(s.extend_run(&run.id, &[], &[other]).await.is_err());
    assert_eq!(
        s.store
            .run(&run.id)
            .await
            .unwrap()
            .request
            .configurations
            .len(),
        1
    );
    // The model's repository configuration joins the same run, which keeps
    // its text cases on their configuration.
    let grown = s
        .extend_run(&run.id, &[], &[repository_configuration(&native)])
        .await
        .unwrap();
    assert_eq!(grown.id, run.id);
    assert_eq!(grown.request.configurations.len(), 2);
    assert_eq!(grown.attempts.len(), 3);
    assert!(grown
        .attempts
        .iter()
        .all(|a| a.configuration.execution_profile == "native_text"));
    dir.close().await;
}
