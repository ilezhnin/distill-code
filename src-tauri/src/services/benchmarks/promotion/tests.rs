use super::*;
use crate::services::benchmarks::{
    runner::{ExecutionBackend, JudgeStop},
    seeds::definitions as seed_definitions,
    BenchmarkService,
};
use futures_util::future::BoxFuture;
use std::sync::Arc;
use tokio::sync::watch;

struct NoProvider;
impl ExecutionBackend for NoProvider {
    fn unsupported(&self, _: &Configuration, _: &BenchmarkDraft) -> Option<String> {
        None
    }
    fn inventory<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: bool,
    ) -> BoxFuture<'a, Result<Vec<InventoryModel>>> {
        Box::pin(async { panic!("Qualification must not discover providers") })
    }
    fn execute<'a>(
        &'a self,
        _: &'a Store,
        _: Attempt,
        _: BenchmarkVersion,
        _: u32,
        _: watch::Receiver<bool>,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async { panic!("Qualification must not invoke providers") })
    }
    fn judge<'a>(
        &'a self,
        _: &'a Store,
        _: Attempt,
        _: &'a BenchmarkVersion,
        _: JudgeStop,
    ) -> BoxFuture<'a, Result<Attempt>> {
        Box::pin(async { panic!("Qualification must not invoke judges") })
    }
}
async fn fixture(root: &std::path::Path) -> (BenchmarkService, qualification::Request) {
    let store = Store::open(root).await.unwrap();
    let mut draft = seed_definitions().remove(0);
    draft.split = "train".into();
    draft.task_family = "invented-control-boundary".into();
    draft.evaluator = Evaluator {
        kind: "exact".into(),
        expected: "ok".into(),
        known_good: "ok".into(),
        known_bad: "wrong".into(),
        rubric: String::new(),
        revision: "invented-v1".into(),
    };
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store
        .publish(&definition.id, definition.draft_revision)
        .await
        .unwrap();
    let request = qualification::Request {
        rubric: None,
        request_key: "panel-one".into(),
        version_id: version.id,
        content_hash: version.content_hash,
        evaluator_revision: "invented-v1".into(),
        reviewer: "fixture operator".into(),
        contract_review: "Invented exact text contract".into(),
        alternative_review: "Whitespace is explicitly immaterial".into(),
        family_review: "Independent fixture; no empirical claim".into(),
        exposure_review: "Development fixture only".into(),
        requirements: vec![qualification::Requirement {
            id: "value".into(),
            statement: "Return the required value".into(),
            positive_controls: vec!["a".into(), "b".into()],
            negative_controls: vec!["c".into(), "d".into()],
        }],
        controls: [
            ("a", "ok", "pass"),
            ("b", " ok ", "pass"),
            ("c", "wrong", "fail"),
            ("d", "missing", "fail"),
        ]
        .into_iter()
        .map(|(id, output, expected)| qualification::Control {
            id: id.into(),
            output: output.into(),
            expected: expected.into(),
            rationale: "Explicit invented outcome".into(),
        })
        .collect(),
    };
    (
        BenchmarkService {
            store,
            backend: Arc::new(NoProvider),
            wake: Default::default(),
            active: Default::default(),
            app: None,
        },
        request,
    )
}
#[tokio::test]
async fn failed_first_qualification_is_durable_and_cannot_be_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let (service, mut request) = fixture(dir.path()).await;
    request.controls[2].output = "ok\n".into();
    let failed = service.qualify_version(request.clone()).await.unwrap();
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.controls.len(), 3);
    assert!(failed.failure.is_some());
    let retry = service.qualify_version(request.clone()).await.unwrap();
    assert_eq!(hash(&retry).unwrap(), hash(&failed).unwrap());
    let reopened = Store::open(dir.path()).await.unwrap();
    assert_eq!(
        hash(&reopened.qualification(&failed.id).await.unwrap()).unwrap(),
        hash(&failed).unwrap()
    );
    request.request_key = "different-key".into();
    request.controls[2].output = "wrong".into();
    assert!(service.qualify_version(request).await.is_err());
}
#[tokio::test]
async fn qualifications_keep_request_identity_and_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let (service, request) = fixture(dir.path()).await;
    let record = service.qualify_version(request.clone()).await.unwrap();
    assert_eq!(record.status, "controls_verified_review_attested");
    let mut changed = request;
    changed.contract_review = "Changed review".into();
    assert!(service.qualify_version(changed).await.is_err());
    service
        .store
        .revoke_qualification(&record.id, "Control invalidated")
        .await
        .unwrap();
    let binding = service
        .store
        .qualification_bindings(&record.request.version_id)
        .await
        .unwrap()
        .remove(0);
    assert!(binding.revoked_at.is_some());
}
