//! Invented grader controls test service authority, not empirical model quality.
use super::*;
use futures_util::future::BoxFuture;
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::watch;

struct PanelBackend {
    calls: AtomicUsize,
    bad_seat: bool,
    hold: bool,
}
impl runner::ExecutionBackend for PanelBackend {
    fn unsupported(&self, _: &Configuration, _: &BenchmarkDraft) -> Option<String> {
        None
    }
    fn inventory<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(async { panic!("Calibration must not discover replacement judges") })
    }
    fn execute<'a>(
        &'a self,
        _: &'a Store,
        _: Attempt,
        _: BenchmarkVersion,
        _: u32,
        _: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async { panic!("Control answers must not execute as candidates") })
    }
    fn judge_control<'a>(
        &'a self,
        store: &'a Store,
        record: &'a mut Record,
        version: &'a BenchmarkVersion,
        index: usize,
    ) -> BoxFuture<'a, Result<Evaluation>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let panel = super::super::judge_panel::frozen(&version.manifest, &[])?.unwrap();
            let batch = format!("{}-control-{index}", record.id);
            let mut marker = evaluation(version, "render", "rendered", None);
            marker.details = Some(json!({"judgeBatchId":batch, "expectedJudges":panel.len(),
                "protocol":runner::judge_protocol(&version.manifest, &panel)}));
            record.controls[index].judge_evaluations.push(marker);
            if self.hold {
                let mut placeholder = evaluation(version, "judge_failure", "abstained", None);
                placeholder.judge = Some(panel[0].clone());
                placeholder.details = Some(
                    json!({"judgeBatchId":batch,"sessionId":"invented-in-flight",
                    "requestKey":"invented-judge-call","inFlight":true,"usageComplete":false}),
                );
                record.controls[index].judge_evaluations.push(placeholder);
            }
            store.save_qualification_progress(record).await?;
            if self.hold {
                while !store.qualification_stopped(&record.id).await? {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
                return Err(invalid("Stopped fixture panel; no replay"));
            }
            let wrong = record.request.controls[index].output.starts_with("wrong");
            for (seat, judge) in panel.into_iter().enumerate() {
                let score = if wrong && !(self.bad_seat && seat == 2) {
                    0.1
                } else {
                    0.9
                };
                let mut vote = evaluation(version, "judge", "judged", Some(score));
                vote.judge = Some(judge);
                vote.details = Some(
                    json!({"judgeBatchId":batch,"sessionId":format!("{batch}-seat-{seat}"),"usageComplete":true}),
                );
                record.controls[index].judge_evaluations.push(vote);
                store.save_qualification_progress(record).await?;
            }
            Ok(evaluation(
                version,
                "judge_calibration",
                "judged",
                Some(if wrong { 0.1 } else { 0.9 }),
            ))
        })
    }
}

fn evaluation(
    version: &BenchmarkVersion,
    provenance: &str,
    verdict: &str,
    score: Option<f64>,
) -> Evaluation {
    Evaluation {
        id: uuid::Uuid::new_v4().to_string(),
        evaluator_revision: version.manifest.evaluator.revision.clone(),
        verdict: verdict.into(),
        score,
        reason: "Invented control evidence".into(),
        created_at: now(),
        provenance: provenance.into(),
        artifacts: Vec::new(),
        details: None,
        judge: None,
        usage: None,
    }
}
fn judge(model: &str) -> Configuration {
    Configuration {
        id: model.into(),
        provider_id: "claude-acp".into(),
        account_id: Some("invented-account".into()),
        model_id: model.into(),
        effort: Some("high".into()),
        fast_mode: Some(false),
        billing_mode: "subscription".into(),
        execution_profile: "native_text".into(),
        inventory_revision: Some("invented-runtime".into()),
        model_name: None,
    }
}
async fn fixture(
    root: &std::path::Path,
    bad_seat: bool,
    hold: bool,
) -> (BenchmarkService, Arc<PanelBackend>, Request) {
    let store = Store::open(root).await.unwrap();
    let mut draft = super::super::seeds::definitions().remove(0);
    draft.split = "train".into();
    draft.task_family = "invented-rubric-calibration".into();
    draft.evaluator.kind = "rubric".into();
    draft.evaluator.rubric = "Assess the correctness of the invented statement.".into();
    draft.environment = json!({"authoredBy":[],"judgeInput":"text",
        "rubricCriteria":[{"id":"meaning","weight":1}], "judgePanel":{
        "recipe":super::super::judge_panel::RECIPE,
        "judges":[judge("invented-a"),judge("invented-b"),judge("invented-c")]
    }});
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store
        .publish(&definition.id, definition.draft_revision)
        .await
        .unwrap();
    let request = Request {
        request_key: "invented-calibration".into(),
        version_id: version.id,
        content_hash: version.content_hash,
        evaluator_revision: version.manifest.evaluator.revision,
        reviewer: "Fixture operator".into(),
        contract_review: "Invented requirement".into(),
        alternative_review: "Two different correct statements".into(),
        family_review: "Invented family only".into(),
        exposure_review: "Development fixture; not held-out evidence".into(),
        requirements: vec![Requirement {
            id: "meaning".into(),
            statement: "A correct statement".into(),
            positive_controls: vec!["a".into(), "b".into()],
            negative_controls: vec!["c".into(), "d".into()],
        }],
        controls: [
            ("a", "correct statement A", "pass"),
            ("b", "correct statement B", "pass"),
            ("c", "wrong statement A", "fail"),
            ("d", "wrong statement B", "fail"),
        ]
        .into_iter()
        .map(|(id, output, expected)| Control {
            id: id.into(),
            output: output.into(),
            expected: expected.into(),
            rationale: "Invented known outcome".into(),
        })
        .collect(),
        rubric: Some(RubricCalibration {
            minimum_accepted_score: 0.8,
            maximum_rejected_score: 0.2,
            max_judge_calls: 12,
        }),
    };
    let backend = Arc::new(PanelBackend {
        calls: AtomicUsize::new(0),
        bad_seat,
        hold,
    });
    (
        BenchmarkService {
            store,
            backend: backend.clone(),
            wake: Default::default(),
            active: Default::default(),
            app: None,
        },
        backend,
        request,
    )
}
async fn settled(store: &Store, id: &str) -> Record {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let record = store.qualification(id).await.unwrap();
            if record.status != "reserved" {
                return record;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("Fixture qualification did not settle")
}

#[tokio::test]
async fn rubric_controls_are_idempotent_and_never_become_candidate_measurements() {
    let dir = tempfile::tempdir().unwrap();
    let (service, backend, request) = fixture(dir.path(), false, false).await;
    let first = service.qualify_version(request.clone()).await.unwrap();
    let duplicate = service.qualify_version(request.clone()).await.unwrap();
    assert_eq!(first.id, duplicate.id);
    let record = settled(&service.store, &first.id).await;
    assert_eq!(record.status, "controls_verified_review_attested");
    assert_eq!(record.controls.len(), 4);
    let version = service
        .store
        .version(&record.request.version_id)
        .await
        .unwrap();
    validate_protocol(&record, &version).unwrap();
    let mut changed = version.clone();
    changed
        .manifest
        .evaluator
        .rubric
        .push_str(" Different scoring rule.");
    assert!(validate_protocol(&record, &changed).is_err());
    changed = version;
    changed.manifest.environment["judgePanel"]["judges"][0]["accountId"] = json!("other-account");
    assert!(validate_protocol(&record, &changed).is_err());
    assert!(record
        .controls
        .iter()
        .all(|c| c.judge_evaluations.len() == 4));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 4);
    assert_eq!(
        hash(&record).unwrap(),
        hash(&service.qualify_version(request).await.unwrap()).unwrap()
    );
    let data = service.query_data().await.unwrap();
    assert!(data.runs.is_empty() && data.attempts.is_empty());
    let mut legacy = serde_json::to_value(&record.request).unwrap();
    legacy.as_object_mut().unwrap().remove("rubric");
    let old: Request = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(old).unwrap(), legacy);
}

#[tokio::test]
async fn a_good_median_never_hides_a_judge_accepting_a_wrong_control() {
    let dir = tempfile::tempdir().unwrap();
    let (service, backend, request) = fixture(dir.path(), true, false).await;
    let first = service.qualify_version(request.clone()).await.unwrap();
    let record = settled(&service.store, &first.id).await;
    assert_eq!(record.status, "failed");
    assert_eq!(record.controls.len(), 3);
    assert_eq!(
        record.controls[2].evaluation.as_ref().unwrap().score,
        Some(0.1)
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), 3);
    let mut replacement = request;
    replacement.request_key = "replacement".into();
    assert!(service.qualify_version(replacement).await.is_err());
}

#[tokio::test]
async fn unregistered_or_insufficient_call_budgets_are_rejected_before_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let (service, backend, mut request) = fixture(dir.path(), false, false).await;
    request.rubric.as_mut().unwrap().max_judge_calls = 11;
    assert!(service.qualify_version(request.clone()).await.is_err());
    request.rubric = None;
    assert!(service.qualify_version(request.clone()).await.is_err());
    assert!(service
        .store
        .qualification_bindings(&request.version_id)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rejecting_only_empty_or_malformed_answers_cannot_qualify_a_semantic_grader() {
    let dir = tempfile::tempdir().unwrap();
    let (service, backend, mut request) = fixture(dir.path(), false, false).await;
    request.controls[2].output = String::new();
    request.controls[3].output = " ".into();
    let first = service.qualify_version(request).await.unwrap();
    let record = settled(&service.store, &first.id).await;
    assert_eq!(record.status, "failed");
    assert!(record
        .failure
        .unwrap()
        .contains("actually assessed by every judge"));
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn revocation_or_restart_preserves_the_first_partial_panel_without_replay() {
    for restart in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (service, backend, request) = fixture(dir.path(), false, true).await;
        let first = service.qualify_version(request.clone()).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let record = service.store.qualification(&first.id).await.unwrap();
                if record
                    .controls
                    .first()
                    .is_some_and(|c| !c.judge_evaluations.is_empty())
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        if restart {
            service.store.recover().await.unwrap();
        } else {
            service
                .store
                .revoke_qualification(&first.id, "Fixture stop")
                .await
                .unwrap();
        }
        let record = settled(&service.store, &first.id).await;
        assert_eq!(record.status, "failed");
        assert_eq!(record.controls.len(), 1);
        assert_eq!(record.controls[0].judge_evaluations.len(), 2);
        service.reconcile_qualification_judges().await.unwrap();
        let reconciled = service.store.qualification(&first.id).await.unwrap();
        assert_eq!(reconciled.failure, record.failure);
        assert_eq!(reconciled.finished_at, record.finished_at);
        let placeholder = &reconciled.controls[0].judge_evaluations[1];
        assert_eq!(placeholder.score, None);
        assert_ne!(placeholder.details.as_ref().unwrap()["inFlight"], true);
        assert_eq!(service.qualify_version(request).await.unwrap().id, first.id);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    }
}
