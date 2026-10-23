//! Invented grader controls test service authority, not empirical model quality.
use super::*;
use futures_util::future::BoxFuture;
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::watch;

struct PanelBackend {
    calls: AtomicUsize,
    bad_seat: bool,
    hold: bool,
    /// Controls from this index on find the judges busy, before anything is
    /// rendered or asked; refused panels are counted apart from asked ones.
    refuse_from: AtomicUsize,
    refusals: AtomicUsize,
    panic_stage: AtomicUsize,
    marker_refusals: AtomicUsize,
    marker_refuse_from: AtomicUsize,
    local_admission: AtomicBool,
    refuse_after_placeholder: AtomicBool,
    paid_calls: AtomicUsize,
}
impl runner::ExecutionBackend for PanelBackend {
    fn calibration_judge<'a>(
        &'a self,
        entry: &'a super::super::judge_pool::Entry,
        _: &'a str,
    ) -> BoxFuture<'a, Result<Configuration>> {
        Box::pin(async move {
            if self.panic_stage.load(Ordering::SeqCst) == 4 {
                return Err(BenchmarkError::new(
                    "resource_busy",
                    "Invented unavailable sandbox",
                ));
            }
            if self.panic_stage.load(Ordering::SeqCst) >= 5 {
                let mut selected = judge(&entry.model_id);
                selected.provider_id = entry.provider_id.clone();
                return Ok(selected);
            }
            panic!("Invented judge-pool worker panic")
        })
    }
    fn calibrate_control<'a>(
        &'a self,
        _: &'a Store,
        version: &'a BenchmarkVersion,
        record: &'a Record,
        index: usize,
        _: &'a Configuration,
        _: std::path::PathBuf,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async move {
            let stage = self.panic_stage.load(Ordering::SeqCst);
            let visual = !runner::text_judged(&version.manifest);
            if visual && stage == 6 {
                return Err(BenchmarkError::new(
                    "resource_busy",
                    "Invented visual sandbox refusal",
                ));
            }
            assert!(!(visual && stage == 7), "Invented visual worker panic");
            let mut attempt = runner::qualification_carrier(record, version, index);
            let score = if stage == 5
                || (visual && stage == 8)
                || record.request.controls[index].expected == "fail"
            {
                0.1
            } else {
                0.9
            };
            attempt.evaluations = vec![evaluation(version, "judge", "judged", Some(score))];
            Ok(attempt)
        })
    }
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
            if index >= self.refuse_from.load(Ordering::SeqCst) {
                self.refusals.fetch_add(1, Ordering::SeqCst);
                return Err(BenchmarkError::new(
                    "resource_busy",
                    "Judge accounts are busy; evaluate again later",
                ));
            }
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert_ne!(
                self.panic_stage.load(Ordering::SeqCst),
                1,
                "Invented admission panic"
            );
            let panel = super::super::judge_panel::frozen(&version.manifest, &[])?.unwrap();
            let batch = format!("{}-control-{index}", record.id);
            let mut marker = evaluation(version, "render", "rendered", None);
            marker.details = Some(json!({"judgeBatchId":batch, "expectedJudges":panel.len(),
                "protocol":runner::judge_protocol(&version.manifest, &panel)}));
            record.controls[index].judge_evaluations = vec![marker];
            if self.hold {
                let mut placeholder = evaluation(version, "judge_failure", "abstained", None);
                placeholder.judge = Some(panel[0].clone());
                placeholder.details = Some(
                    json!({"judgeBatchId":batch,"sessionId":"invented-in-flight",
                    "requestKey":"invented-judge-call","inFlight":true,"usageComplete":false}),
                );
                record.controls[index].judge_evaluations.push(placeholder);
                self.paid_calls.fetch_add(1, Ordering::SeqCst);
            }
            store.save_qualification_progress(record).await?;
            if self.refuse_after_placeholder.load(Ordering::SeqCst)
                || (index >= self.marker_refuse_from.load(Ordering::SeqCst)
                    && self
                        .marker_refusals
                        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                            left.checked_sub(1)
                        })
                        .is_ok())
            {
                self.refusals.fetch_add(1, Ordering::SeqCst);
                return Err(BenchmarkError::new(
                    if self.local_admission.load(Ordering::SeqCst) {
                        "judge_admission_wait"
                    } else {
                        "resource_busy"
                    },
                    "Invented refusal after rendering",
                ));
            }
            assert_ne!(
                self.panic_stage.load(Ordering::SeqCst),
                2,
                "Invented judge panic"
            );
            if self.hold {
                while !store.qualification_stopped(&record.id).await? {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
                return Err(invalid("Stopped fixture panel; no replay"));
            }
            let wrong = record.request.controls[index].output.starts_with("wrong");
            for (seat, judge) in panel.into_iter().enumerate() {
                self.paid_calls.fetch_add(1, Ordering::SeqCst);
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
    root: &crate::test_support::TempRoot,
    bad_seat: bool,
    hold: bool,
) -> (BenchmarkService, Arc<PanelBackend>, Request) {
    let store = Store::open(root.path()).await.unwrap();
    root.register(&store.pool);
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
        refuse_from: AtomicUsize::new(usize::MAX),
        refusals: AtomicUsize::new(0),
        panic_stage: AtomicUsize::new(0),
        marker_refusals: AtomicUsize::new(0),
        marker_refuse_from: AtomicUsize::new(0),
        local_admission: AtomicBool::new(false),
        refuse_after_placeholder: AtomicBool::new(false),
        paid_calls: AtomicUsize::new(0),
    });
    (
        BenchmarkService {
            store,
            backend: backend.clone(),
            wake: Default::default(),
            active: Default::default(),
            queries: Default::default(),
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

async fn marker_only_refusal(local_admission: bool) {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, request) = fixture(&dir, false, false).await;
    backend.marker_refusals.store(2, Ordering::SeqCst);
    backend
        .local_admission
        .store(local_admission, Ordering::SeqCst);
    let started = tokio::time::Instant::now();
    let first = service.qualify_version(request).await.unwrap();
    let record = settled(&service.store, &first.id).await;
    assert_eq!(record.status, "controls_verified_review_attested");
    assert!(started.elapsed() >= runner::EVALUATION_RETRY * 2);
    assert_eq!(backend.refusals.load(Ordering::SeqCst), 2);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 6);
    assert_eq!(backend.paid_calls.load(Ordering::SeqCst), 12);
    assert!(record
        .controls
        .iter()
        .all(|c| c.judge_evaluations.len() == 4));
    dir.close().await;
}

#[tokio::test]
async fn rendered_qualification_waits_out_resource_refusals_before_any_judge_call() {
    marker_only_refusal(false).await;
}

#[tokio::test]
async fn rendered_qualification_waits_out_local_admission_before_any_judge_call() {
    marker_only_refusal(true).await;
}

#[tokio::test]
async fn qualification_never_retries_a_refusal_after_a_paid_placeholder() {
    for local_admission in [false, true] {
        let dir = crate::test_support::TempRoot::new();
        let (service, backend, request) = fixture(&dir, false, true).await;
        backend
            .local_admission
            .store(local_admission, Ordering::SeqCst);
        backend
            .refuse_after_placeholder
            .store(true, Ordering::SeqCst);
        let first = service.qualify_version(request.clone()).await.unwrap();
        let record = settled(&service.store, &first.id).await;
        assert_eq!(record.status, "failed");
        assert_eq!(record.controls[0].judge_evaluations.len(), 2);
        assert_eq!(
            record.controls[0].judge_evaluations[1].provenance,
            "judge_failure"
        );
        assert_eq!(service.qualify_version(request).await.unwrap().id, first.id);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.paid_calls.load(Ordering::SeqCst), 1);
        dir.close().await;
    }
}

async fn controls_task_stopped(backend: &Arc<PanelBackend>, idle_references: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while Arc::strong_count(backend) > idle_references {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("The qualification controls task did not exit");
}

#[tokio::test]
async fn rendered_qualification_wait_can_be_revoked_without_a_judge_call() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, request) = fixture(&dir, false, false).await;
    let idle_references = Arc::strong_count(&backend);
    backend.marker_refusals.store(usize::MAX, Ordering::SeqCst);
    backend.local_admission.store(true, Ordering::SeqCst);
    let first = service.qualify_version(request.clone()).await.unwrap();
    first_record(&service.store, &request.version_id, |record| {
        record.controls.first().is_some_and(|c| c.waiting.is_some())
    })
    .await;
    service
        .store
        .revoke_qualification(&first.id, "Fixture stop during admission")
        .await
        .unwrap();
    let record = settled(&service.store, &first.id).await;
    controls_task_stopped(&backend, idle_references).await;
    assert_eq!(record.status, "failed");
    assert_eq!(record.controls[0].judge_evaluations.len(), 1);
    assert_eq!(backend.paid_calls.load(Ordering::SeqCst), 0);
    let calls = backend.calls.load(Ordering::SeqCst);
    assert_eq!(
        service.qualify_version(request).await.unwrap().status,
        "failed"
    );
    tokio::time::sleep(runner::EVALUATION_RETRY * 3).await;
    assert_eq!(backend.calls.load(Ordering::SeqCst), calls);
    dir.close().await;
}

#[tokio::test]
async fn rendered_qualification_admission_expires_and_requires_explicit_resume() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, request) = fixture(&dir, false, false).await;
    let idle_references = Arc::strong_count(&backend);
    backend.marker_refusals.store(usize::MAX, Ordering::SeqCst);
    backend.marker_refuse_from.store(2, Ordering::SeqCst);
    backend.local_admission.store(true, Ordering::SeqCst);
    let first = service.qualify_version(request.clone()).await.unwrap();
    first_record(&service.store, &request.version_id, |record| {
        record.controls.get(2).is_some_and(|c| c.waiting.is_some())
    })
    .await;
    // A restart while only a rendering is saved also retains the first request.
    service.store.recover().await.unwrap();
    controls_task_stopped(&backend, idle_references).await;
    let interrupted = service.store.qualification(&first.id).await.unwrap();
    assert_eq!(interrupted.status, INTERRUPTED);
    assert_eq!(interrupted.controls[2].judge_evaluations.len(), 1);
    assert_eq!(backend.paid_calls.load(Ordering::SeqCst), 6);

    // Exercise the production control loop with a short admission window;
    // no wall-clock wait or test-only production deadline is necessary.
    let mut resumed = interrupted.clone();
    resumed.status = "reserved".into();
    resumed
        .controls
        .retain(|control| control.evaluation.is_some());
    assert!(service
        .store
        .take_up_qualification(&interrupted, &resumed)
        .await
        .unwrap());
    let version = service.store.version(&request.version_id).await.unwrap();
    let before = backend.calls.load(Ordering::SeqCst);
    let timeout = runner::EVALUATION_RETRY * 3;
    let started = tokio::time::Instant::now();
    let error = run_controls(
        &service.store,
        backend.as_ref(),
        &version,
        resumed,
        None,
        timeout,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "qualification_admission_timeout");
    assert!(started.elapsed() >= timeout);
    let retries = backend.calls.load(Ordering::SeqCst) - before;
    assert!(
        (1..=3).contains(&retries),
        "Admission retries must back off: {retries}"
    );
    service
        .store
        .stop_qualification(&first.id, &error)
        .await
        .unwrap();
    let expired = service.store.qualification(&first.id).await.unwrap();
    assert_eq!(expired.status, INTERRUPTED);
    assert!(expired.failure.is_none());
    assert!(expired.controls[2].error.is_none());
    assert!(expired.controls[2].waiting.is_none());
    assert_eq!(expired.controls[2].judge_evaluations.len(), 1);
    assert_eq!(backend.paid_calls.load(Ordering::SeqCst), 6);
    tokio::time::sleep(timeout).await;
    assert_eq!(backend.calls.load(Ordering::SeqCst) - before, retries);

    backend.marker_refusals.store(0, Ordering::SeqCst);
    assert_eq!(service.qualify_version(request).await.unwrap().id, first.id);
    let finished = settled(&service.store, &first.id).await;
    assert_eq!(finished.status, "controls_verified_review_attested");
    for index in 0..2 {
        assert_eq!(
            serde_json::to_value(&finished.controls[index]).unwrap(),
            serde_json::to_value(&interrupted.controls[index]).unwrap()
        );
    }
    controls_task_stopped(&backend, idle_references).await;
    assert_eq!(backend.paid_calls.load(Ordering::SeqCst), 12);
    dir.close().await;
}

#[tokio::test]
async fn panicking_qualification_stops_without_losing_or_replaying_judge_evidence() {
    for stage in [1, 2] {
        let dir = crate::test_support::TempRoot::new();
        let (service, backend, request) = fixture(&dir, false, stage == 2).await;
        backend.panic_stage.store(stage, Ordering::SeqCst);
        let first = service.qualify_version(request.clone()).await.unwrap();
        let record = settled(&service.store, &first.id).await;
        assert_eq!(
            record.status,
            if stage == 1 { INTERRUPTED } else { "failed" }
        );
        assert_eq!(record.controls.len(), 1);
        if stage == 2 {
            assert!(record.failure.as_deref().unwrap().contains("panicked"));
            assert_eq!(record.controls[0].judge_evaluations.len(), 2);
            assert_eq!(
                record.controls[0].judge_evaluations[1]
                    .details
                    .as_ref()
                    .unwrap()["inFlight"],
                true
            );
            assert_eq!(service.qualify_version(request).await.unwrap().id, first.id);
        } else {
            assert!(record.controls[0].judge_evaluations.is_empty());
        }
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
        dir.close().await;
    }
}

#[tokio::test]
async fn panicking_judge_pool_calibration_releases_its_reservation() {
    let dir = crate::test_support::TempRoot::new();
    let (service, _, request) = fixture(&dir, false, false).await;
    let first = service.qualify_version(request).await.unwrap();
    assert_eq!(
        settled(&service.store, &first.id).await.status,
        "controls_verified_review_attested"
    );
    let entry: super::super::judge_pool::Entry = serde_json::from_value(json!({
        "providerId":"claude-acp", "modelId":"invented-panicking-pool-judge",
        "inputs":["text"], "accounts":["invented-account"]
    }))
    .unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        json!({"judgePool":[entry]}).to_string(),
    )
    .unwrap();
    let started = service.calibrate_judge(entry.clone()).await.unwrap();
    let finished = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let status = service.judge_pool().await.unwrap();
            let calibration = status
                .calibrations
                .into_iter()
                .find(|c| c.id == started.id)
                .unwrap();
            if calibration.status != "running" {
                return calibration;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("Panicking pool worker left its running reservation behind");
    assert_eq!(finished.status, "interrupted");
    assert!(finished.failure.as_deref().unwrap().contains("panicked"));
    assert!(finished.finished_at.is_some());
    assert!(!service.judge_pool().await.unwrap().pool[0].seats);
    // Only another explicit request may start a replacement calibration.
    let again = service.calibrate_judge(entry).await.unwrap();
    assert_ne!(started.id, again.id);
    // Wait for the replacement to settle before closing the fixture store.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while service
            .judge_pool()
            .await
            .unwrap()
            .calibrations
            .iter()
            .any(|c| c.id == again.id && c.status == "running")
        {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    dir.close().await;
}

#[tokio::test]
async fn unavailable_judge_pool_preparation_is_not_a_failed_quality_verdict() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, request) = fixture(&dir, false, false).await;
    let first = service.qualify_version(request).await.unwrap();
    settled(&service.store, &first.id).await;
    backend.panic_stage.store(4, Ordering::SeqCst);
    let entry: super::super::judge_pool::Entry = serde_json::from_value(json!({
        "providerId":"claude-acp", "modelId":"invented-busy-pool-judge",
        "inputs":["text"], "accounts":["invented-account"]
    }))
    .unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        json!({"judgePool":[entry]}).to_string(),
    )
    .unwrap();
    let started = service.calibrate_judge(entry.clone()).await.unwrap();
    let finished = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let status = service.judge_pool().await.unwrap();
            let calibration = status
                .calibrations
                .into_iter()
                .find(|c| c.id == started.id)
                .unwrap();
            if calibration.status != "running" {
                return calibration;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(finished.status, "interrupted");
    assert!(finished.controls.is_empty());
    assert!(finished
        .failure
        .as_deref()
        .unwrap()
        .contains("resource_busy"));
    assert!(!service.judge_pool().await.unwrap().pool[0].seats);
    // By contrast, a judge that actually rejects an accepted control fails.
    backend.panic_stage.store(5, Ordering::SeqCst);
    let wrong = service.calibrate_judge(entry).await.unwrap();
    let wrong = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let status = service.judge_pool().await.unwrap();
            let calibration = status
                .calibrations
                .into_iter()
                .find(|c| c.id == wrong.id)
                .unwrap();
            if calibration.status != "running" {
                return calibration;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(wrong.status, "failed");
    assert_eq!(wrong.controls.len(), 1);
    assert!(!wrong.controls[0].in_band);
    dir.close().await;
}

#[tokio::test]
async fn visual_pool_worker_failures_preserve_the_passed_text_verdict() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, request) = fixture(&dir, false, false).await;
    let first = service.qualify_version(request).await.unwrap();
    let mut record = settled(&service.store, &first.id).await;
    let mut draft = service
        .store
        .version(&record.request.version_id)
        .await
        .unwrap()
        .manifest;
    draft.environment["judgeInput"] = json!("visual");
    let definition = service.store.save_draft(None, None, draft).await.unwrap();
    let version = service
        .store
        .publish(&definition.id, definition.draft_revision)
        .await
        .unwrap();
    // A stopped invented visual qualification still supplies its registered
    // controls for the pool's separate visual probe. No browser is launched.
    record.id = "invented-visual-controls".into();
    record.request.request_key = record.id.clone();
    record.request.version_id = version.id.clone();
    record.request.content_hash = version.content_hash.clone();
    record.manifest_hash = hash(&version.manifest).unwrap();
    record.controls.clear();
    record.status = "failed".into();
    record.failure = Some("Invented interrupted panel".into());
    sqlx::query("INSERT INTO selector_qualifications(id,request_key,request_hash,version_id,content_hash,manifest_hash,evaluator_revision,created_at,phase,status,record_json,record_hash) VALUES(?,?,?,?,?,?,?,?,'terminal','failed',?,?)")
        .bind(&record.id).bind(&record.request.request_key).bind(hash(&record.request).unwrap())
        .bind(&version.id).bind(&version.content_hash).bind(&record.manifest_hash)
        .bind(&record.request.evaluator_revision).bind(record.created_at)
        .bind(serde_json::to_string(&record).unwrap()).bind(hash(&record).unwrap())
        .execute(&service.store.pool).await.unwrap();
    for stage in [6, 7, 8] {
        backend.panic_stage.store(stage, Ordering::SeqCst);
        let entry: super::super::judge_pool::Entry = serde_json::from_value(json!({
            "providerId":"codex-acp", "modelId":format!("invented-visual-judge-{stage}"),
            "accounts":["invented-account"]
        }))
        .unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            json!({"judgePool":[entry]}).to_string(),
        )
        .unwrap();
        let started = service.calibrate_judge(entry).await.unwrap();
        let finished = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let status = service.judge_pool().await.unwrap();
                let calibration = status
                    .calibrations
                    .into_iter()
                    .find(|c| c.id == started.id)
                    .unwrap();
                if calibration.finished_at.is_some() {
                    return calibration;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(finished.status, "passed", "stage {stage}");
        assert_eq!(finished.controls.len(), 4);
        let visual = finished.visual.unwrap();
        assert_eq!(
            visual.status,
            if stage == 8 { "failed" } else { "interrupted" },
            "stage {stage}"
        );
        assert!(visual.failure.is_some());
        assert_eq!(visual.controls.len(), usize::from(stage == 8));
        let status = service.judge_pool().await.unwrap();
        assert!(status.pool[0].seats);
        assert!(!status.pool[0].seats_visual);
    }
    dir.close().await;
}

#[tokio::test]
async fn rubric_controls_are_idempotent_and_never_become_candidate_measurements() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, request) = fixture(&dir, false, false).await;
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
    dir.close().await;
}

#[tokio::test]
async fn a_good_median_never_hides_a_judge_accepting_a_wrong_control() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, request) = fixture(&dir, true, false).await;
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
    dir.close().await;
}

#[tokio::test]
async fn unregistered_or_insufficient_call_budgets_are_rejected_before_reservation() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, mut request) = fixture(&dir, false, false).await;
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
    dir.close().await;
}

#[tokio::test]
async fn rejecting_only_empty_or_malformed_answers_cannot_qualify_a_semantic_grader() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, mut request) = fixture(&dir, false, false).await;
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
    dir.close().await;
}

#[tokio::test]
async fn revocation_or_restart_preserves_the_first_partial_panel_without_replay() {
    for restart in [false, true] {
        let dir = crate::test_support::TempRoot::new();
        let (service, backend, request) = fixture(&dir, false, true).await;
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
        dir.close().await;
    }
}

/// An exact version whose controls an invented sandbox may refuse before any
/// evaluator worker starts.
async fn objective_fixture(
    root: &crate::test_support::TempRoot,
) -> (Arc<BenchmarkService>, Arc<runner::FakeBackend>, Request) {
    let store = Store::open(root.path()).await.unwrap();
    root.register(&store.pool);
    let mut draft = super::super::seeds::definitions().remove(0);
    draft.split = "train".into();
    draft.task_family = "invented-objective-qualification".into();
    draft.evaluator.kind = "exact".into();
    draft.evaluator.expected = "READY".into();
    draft.evaluator.known_good = "READY".into();
    draft.evaluator.known_bad = "WAIT".into();
    draft.evaluator.revision = "invented-exact-1".into();
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store
        .publish(&definition.id, definition.draft_revision)
        .await
        .unwrap();
    let request = Request {
        request_key: "invented-objective".into(),
        version_id: version.id,
        content_hash: version.content_hash,
        evaluator_revision: version.manifest.evaluator.revision,
        reviewer: "Fixture operator".into(),
        contract_review: "Invented requirement".into(),
        alternative_review: "A plain and a fenced answer".into(),
        family_review: "Invented family only".into(),
        exposure_review: "Development fixture; not held-out evidence".into(),
        requirements: vec![Requirement {
            id: "ready".into(),
            statement: "The answer is READY".into(),
            positive_controls: vec!["a".into(), "b".into()],
            negative_controls: vec!["c".into(), "d".into()],
        }],
        controls: [
            ("a", "READY", "pass"),
            ("b", "```text\nREADY\n```", "pass"),
            ("c", "WAIT", "fail"),
            ("d", "```\nREADY\n```\nand more", "fail"),
        ]
        .into_iter()
        .map(|(id, output, expected)| Control {
            id: id.into(),
            output: output.into(),
            expected: expected.into(),
            rationale: "Invented known outcome".into(),
        })
        .collect(),
        rubric: None,
    };
    let backend = Arc::new(runner::FakeBackend::default());
    let service = Arc::new(BenchmarkService {
        store,
        backend: backend.clone(),
        wake: Default::default(),
        active: Default::default(),
        queries: Default::default(),
        app: None,
    });
    (service, backend, request)
}

/// The first qualification of `version_id` once `ready` holds for it.
async fn first_record(store: &Store, version_id: &str, ready: impl Fn(&Record) -> bool) -> Record {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Some(binding) = store
                .qualification_bindings(version_id)
                .await
                .unwrap()
                .first()
            {
                let record = store.qualification(&binding.id).await.unwrap();
                if ready(&record) {
                    return record;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("Fixture qualification never reached the expected state")
}

/// Starts the objective qualification while the sandbox refuses every
/// evaluation, ends it like a closed app once a control waits, and recovers.
async fn interrupted_objective(
    service: &Arc<BenchmarkService>,
    backend: &runner::FakeBackend,
    request: &Request,
) -> String {
    backend
        .evaluation_refusals
        .store(u64::MAX, Ordering::SeqCst);
    let running = tokio::spawn({
        let service = service.clone();
        let request = request.clone();
        async move { service.qualify_version(request).await }
    });
    let waiting = first_record(&service.store, &request.version_id, |record| {
        record.controls.first().is_some_and(|c| c.waiting.is_some())
    })
    .await;
    assert_eq!(waiting.status, "reserved");
    assert!(waiting.controls[0]
        .waiting
        .as_deref()
        .unwrap()
        .contains("preparation queue expired before worker startup"));
    running.abort();
    let _ = running.await;
    service.store.recover().await.unwrap();
    backend.evaluation_refusals.store(0, Ordering::SeqCst);
    waiting.id
}

#[tokio::test]
async fn objective_controls_wait_out_unstarted_refusals_instead_of_failing() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, request) = objective_fixture(&dir).await;
    backend.evaluation_refusals.store(3, Ordering::SeqCst);
    let record = service.qualify_version(request).await.unwrap();
    assert_eq!(record.status, "controls_verified_review_attested");
    assert_eq!(record.failure, None);
    assert_eq!(record.controls.len(), 4);
    assert!(record
        .controls
        .iter()
        .all(|c| c.evaluation.is_some() && c.error.is_none() && c.waiting.is_none()));
    assert_eq!(backend.evaluations.load(Ordering::SeqCst), 7);
    dir.close().await;
}

/// Waiting never softens a verdict: a control evaluated and wrong fails the
/// only qualification of its version, and nothing goes on with it.
#[tokio::test]
async fn a_wrong_control_stays_final_after_any_wait() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, mut request) = objective_fixture(&dir).await;
    request.controls[2].output = "```\nREADY\n```".into();
    backend.evaluation_refusals.store(2, Ordering::SeqCst);
    let record = service.qualify_version(request.clone()).await.unwrap();
    assert_eq!(record.status, "failed");
    assert_eq!(record.controls.len(), 3);
    assert!(record
        .failure
        .as_deref()
        .unwrap()
        .contains("Control c disagrees"));
    service.store.recover().await.unwrap();
    let evaluations = backend.evaluations.load(Ordering::SeqCst);
    let again = service.qualify_version(request.clone()).await.unwrap();
    assert_eq!(hash(&again).unwrap(), hash(&record).unwrap());
    assert_eq!(backend.evaluations.load(Ordering::SeqCst), evaluations);
    let mut replacement = request;
    replacement.request_key = "replacement".into();
    assert!(service.qualify_version(replacement).await.is_err());
    dir.close().await;
}

/// A restart before the first qualification settled leaves it interrupted
/// without a verdict. Another request still cannot replace it; the same one
/// goes on with it, evaluating every control again on the current runtime.
#[tokio::test]
async fn a_restart_leaves_an_unsettled_qualification_to_its_request() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, request) = objective_fixture(&dir).await;
    let id = interrupted_objective(&service, &backend, &request).await;
    let interrupted = service.store.qualification(&id).await.unwrap();
    assert_eq!(interrupted.status, INTERRUPTED);
    assert_eq!(interrupted.failure, None);
    assert_eq!(interrupted.finished_at, None);
    assert!(interrupted.controls.iter().all(|c| c.waiting.is_none()));
    assert!(service.store.qualification_stopped(&id).await.unwrap());
    service.store.recover().await.unwrap();
    assert_eq!(
        hash(&service.store.qualification(&id).await.unwrap()).unwrap(),
        hash(&interrupted).unwrap()
    );
    let mut replacement = request.clone();
    replacement.request_key = "replacement".into();
    assert!(service.qualify_version(replacement).await.is_err());
    let before = backend.evaluations.load(Ordering::SeqCst);
    let resumed = service.qualify_version(request.clone()).await.unwrap();
    assert_eq!(resumed.id, id);
    assert_eq!(resumed.created_at, interrupted.created_at);
    assert_eq!(resumed.status, "controls_verified_review_attested");
    assert_eq!(resumed.controls.len(), 4);
    assert!(resumed.controls.iter().all(|c| c.evaluation.is_some()));
    assert_eq!(backend.evaluations.load(Ordering::SeqCst) - before, 4);
    assert_eq!(service.qualify_version(request).await.unwrap().id, id);
    assert_eq!(backend.evaluations.load(Ordering::SeqCst) - before, 4);
    dir.close().await;
}

/// Revoking an interrupted qualification settles it failed; its request then
/// finds it settled and evaluates nothing.
#[tokio::test]
async fn revoking_an_interrupted_qualification_settles_it() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, request) = objective_fixture(&dir).await;
    let id = interrupted_objective(&service, &backend, &request).await;
    service
        .store
        .revoke_qualification(&id, "Fixture stop")
        .await
        .unwrap();
    let revoked = service.store.qualification(&id).await.unwrap();
    assert_eq!(revoked.status, "failed");
    assert!(revoked.failure.as_deref().unwrap().contains("revoked"));
    let before = backend.evaluations.load(Ordering::SeqCst);
    assert_eq!(
        service.qualify_version(request).await.unwrap().status,
        "failed"
    );
    assert_eq!(backend.evaluations.load(Ordering::SeqCst), before);
    dir.close().await;
}

/// A rubric calibration whose next control finds the judges busy waits. A
/// restart then leaves it interrupted, its running loop stops, and the same
/// request keeps the paid panels and asks only the controls still open.
#[tokio::test]
async fn an_interrupted_calibration_keeps_its_paid_panels() {
    let dir = crate::test_support::TempRoot::new();
    let (service, backend, request) = fixture(&dir, false, false).await;
    let idle_references = Arc::strong_count(&backend);
    // Each background controls task owns a backend clone until it has
    // finished its final database operations. A settled record alone does
    // not prove that task exited, and a fixed sleep races a loaded runner.
    let controls_stopped = || async {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while Arc::strong_count(&backend) > idle_references {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("The calibration controls task did not exit");
    };
    backend.refuse_from.store(2, Ordering::SeqCst);
    let first = service.qualify_version(request.clone()).await.unwrap();
    let waiting = first_record(&service.store, &request.version_id, |record| {
        record.controls.get(2).is_some_and(|c| c.waiting.is_some())
    })
    .await;
    assert_eq!(waiting.id, first.id);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    service.store.recover().await.unwrap();
    let interrupted = service.store.qualification(&first.id).await.unwrap();
    assert_eq!(interrupted.status, INTERRUPTED);
    // The loop of the closed calibration stops without settling anything.
    controls_stopped().await;
    let refusals = backend.refusals.load(Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(backend.refusals.load(Ordering::SeqCst), refusals);
    assert_eq!(
        hash(&service.store.qualification(&first.id).await.unwrap()).unwrap(),
        hash(&interrupted).unwrap()
    );
    backend.refuse_from.store(usize::MAX, Ordering::SeqCst);
    assert_eq!(service.qualify_version(request).await.unwrap().id, first.id);
    let record = settled(&service.store, &first.id).await;
    assert_eq!(record.status, "controls_verified_review_attested");
    assert_eq!(record.controls.len(), 4);
    for index in 0..2 {
        assert_eq!(
            serde_json::to_value(&record.controls[index]).unwrap(),
            serde_json::to_value(&interrupted.controls[index]).unwrap()
        );
    }
    assert_eq!(backend.calls.load(Ordering::SeqCst), 4);
    controls_stopped().await;
    dir.close().await;
}
