use super::collection_context::{self, Context};
use super::*;
use crate::services::benchmarks::{artifact_context, repository};

fn opted_in(mut version: BenchmarkVersion) -> BenchmarkVersion {
    version.manifest.execution_profile = "protected_repository".into();
    version.manifest.evaluator.kind = "repository".into();
    version.manifest.permissions = Permissions {
        tools: vec!["filesystem".into(), "terminal".into()],
        network: true,
        context: "clean".into(),
    };
    version.manifest.environment["nativeRepositoryRecipe"] = json!(repository::ARTIFACT_RECIPE);
    version.manifest.environment["nativeBudgetRecipe"] = json!(artifact_context::CLOCK_RECIPE);
    version.manifest.environment["repository"] = json!({
        "path":"invented-snapshot", "commit":"a".repeat(40), "tree":"b".repeat(40)
    });
    version.manifest.entry_state = Some(EntryState {
        schema_version: 1,
        root_task_id: "invented-root".into(),
        step_id: "implement".into(),
        parent_step_id: None,
        fixture_snapshot_hash: String::new(),
        conversation_prefix: String::new(),
        previous_reports: vec![],
        remaining_budget_seconds: version.manifest.limits.timeout_seconds,
        content_hash: String::new(),
    });
    version
}

fn invented_input() -> artifact_context::Input {
    artifact_context::Input {
        before: repository::Artifact {
            recipe: repository::ARTIFACT_RECIPE.into(),
            root_tree: "b".repeat(40),
            before_tree: "b".repeat(40),
            after_tree: "b".repeat(40),
            patch: String::new(),
            patch_hash: fixtures::hash(b""),
            archive_hash: fixtures::hash(b"invented native helper archive"),
        },
        lineage: vec![],
        access_all: false,
    }
}

#[tokio::test]
async fn legacy_collection_does_not_gain_a_context_or_native_clock() {
    let (_dir, service, _) = tests::setup().await;
    let run = service
        .start_run(tests::request(&service).await)
        .await
        .unwrap();
    let mut attempt = run.attempts[0].clone();
    let version = service.store.version(&attempt.version_id).await.unwrap();
    let original = serde_json::to_vec(&version).unwrap();
    let prepared = collection_context::prepare(&service.store, &mut attempt, version, 10)
        .await
        .unwrap();
    assert_eq!(serde_json::to_vec(&prepared).unwrap(), original);
    assert!(serde_json::to_value(attempt)
        .unwrap()
        .get("collectionContext")
        .is_none());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM task_budget_bindings")
        .fetch_one(&service.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn standalone_clock_retry_keeps_origin_and_rejects_a_changed_cap() {
    let (_dir, service, _) = tests::setup().await;
    let run = service
        .start_run(tests::request(&service).await)
        .await
        .unwrap();
    let mut attempt = run.attempts[0].clone();
    let version = opted_in(service.store.version(&attempt.version_id).await.unwrap());
    attempt.started_at = Some(now() - 1000);
    let first = collection_context::reserve(&service.store, &attempt, &version, 60)
        .await
        .unwrap();
    attempt.started_at = Some(now());
    let resumed = collection_context::reserve(&service.store, &attempt, &version, 60)
        .await
        .unwrap();
    assert_eq!(resumed, first);
    assert!(resumed.remaining_ms(now()).unwrap() <= 59_000);
    assert_eq!(
        collection_context::reserve(&service.store, &attempt, &version, 120)
            .await
            .unwrap_err()
            .code,
        "budget_clock_conflict"
    );
}

#[tokio::test]
async fn persisted_context_recovers_exact_input_and_refuses_changed_bindings() {
    let (_dir, service, _) = tests::setup().await;
    let run = service
        .start_run(tests::request(&service).await)
        .await
        .unwrap();
    let mut attempt = run.attempts[0].clone();
    let version = opted_in(service.store.version(&attempt.version_id).await.unwrap());
    let budget = collection_context::reserve(&service.store, &attempt, &version, 60)
        .await
        .unwrap();
    attempt.collection_context =
        Some(Context::new(&attempt, &version, 60, budget.clone(), invented_input()).unwrap());
    service.store.save_attempt(&attempt).await.unwrap();
    let saved = service.store.attempt(&attempt.id).await.unwrap();
    let recovered = collection_context::recover(&service.store, &saved, version.clone())
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_value::<artifact_context::BudgetLease>(
            recovered.manifest.environment[artifact_context::CLOCK_KEY].clone()
        )
        .unwrap(),
        budget
    );
    assert_eq!(
        artifact_context::input(&recovered.manifest).unwrap(),
        Some(invented_input())
    );
    let mut changed = saved.clone();
    changed
        .collection_context
        .as_mut()
        .unwrap()
        .repository
        .before
        .archive_hash = "0".repeat(64);
    assert_eq!(
        collection_context::recover(&service.store, &changed, version.clone())
            .await
            .unwrap_err()
            .code,
        "collection_context_conflict"
    );
    let mut changed_version = version.clone();
    changed_version.manifest.prompt.push_str(" changed");
    assert_eq!(
        collection_context::recover(&service.store, &saved, changed_version)
            .await
            .unwrap_err()
            .code,
        "collection_context_conflict"
    );
    changed.collection_context = None;
    assert_eq!(
        collection_context::recover(&service.store, &changed, version.clone())
            .await
            .unwrap_err()
            .code,
        "collection_context_conflict"
    );
    sqlx::query("UPDATE task_budget_bindings SET input_hash='changed' WHERE request_key=?")
        .bind(&budget.step_key)
        .execute(&service.store.pool)
        .await
        .unwrap();
    assert_eq!(
        collection_context::recover(&service.store, &saved, version)
            .await
            .unwrap_err()
            .code,
        "collection_context_conflict"
    );
}

#[tokio::test]
async fn terminal_recovery_after_expiry_never_reopens_execution_budget() {
    let (_dir, service, _) = tests::setup().await;
    let run = service
        .start_run(tests::request(&service).await)
        .await
        .unwrap();
    let mut attempt = run.attempts[0].clone();
    let version = opted_in(service.store.version(&attempt.version_id).await.unwrap());
    attempt.started_at = Some(now() - 1000);
    let budget = collection_context::reserve(&service.store, &attempt, &version, 2)
        .await
        .unwrap();
    attempt.collection_context =
        Some(Context::new(&attempt, &version, 2, budget.clone(), invented_input()).unwrap());
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let recovered = collection_context::recover(&service.store, &attempt, version.clone())
        .await
        .unwrap();
    let frozen = collection_budget(&recovered.manifest).unwrap().unwrap();
    assert_eq!(frozen, budget);
    assert_eq!(
        frozen.remaining_ms(now()).unwrap_err().code,
        "budget_timeout"
    );
    attempt.started_at = Some(now());
    assert_eq!(
        collection_context::reserve(&service.store, &attempt, &version, 2)
            .await
            .unwrap_err()
            .code,
        "budget_timeout"
    );
}

#[tokio::test]
#[ignore = "requires the reviewed bench-artifact helper in the existing distill-bench WSL distribution"]
async fn real_repository_initial_input_is_persisted_and_recovered_without_provider_calls() {
    let (dir, service, backend) = tests::setup().await;
    let root = dir.path().join("source");
    tokio::fs::create_dir(&root).await.unwrap();
    async fn git(root: &std::path::Path, args: &[&str]) -> String {
        let mut command = tokio::process::Command::new("git");
        command
            .args([
                "-c",
                "core.autocrlf=false",
                "-c",
                "core.hooksPath=",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(root);
        crate::services::process::apply_no_window_async(&mut command);
        let result = command.output().await.unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8(result.stdout).unwrap().trim().into()
    }
    git(&root, &["init", "-q"]).await;
    tokio::fs::write(root.join("answer.txt"), "wrong\n")
        .await
        .unwrap();
    git(&root, &["add", "answer.txt"]).await;
    git(
        &root,
        &[
            "-c",
            "user.name=Benchmark Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "Invented collection fixture",
        ],
    )
    .await;
    let commit = git(&root, &["rev-parse", "HEAD"]).await;
    let tree = git(&root, &["rev-parse", "HEAD^{tree}"]).await;
    tokio::fs::write(root.join("answer.txt"), "correct\n")
        .await
        .unwrap();
    let patch = format!("{}\n", git(&root, &["diff", "--binary"]).await);
    let mut request = tests::request(&service).await;
    let base = service
        .store
        .version(&request.version_ids[0])
        .await
        .unwrap();
    let mut draft = opted_in(base).manifest;
    draft.task_family = "invented-initial-collection".into();
    draft.limits.timeout_seconds = 120;
    draft.entry_state.as_mut().unwrap().remaining_budget_seconds = 120;
    draft.environment["repository"] = json!({"path":root,"commit":commit,"tree":tree});
    draft.evaluator.expected = json!({"files":[], "command":["python3","-c","assert open('answer.txt').read() == 'correct\\n'"], "timeoutSeconds":10}).to_string();
    draft.evaluator.known_good = patch;
    draft.evaluator.known_bad.clear();
    let definition = service.store.save_draft(None, None, draft).await.unwrap();
    let version = service
        .publish_version(&definition.id, definition.draft_revision)
        .await
        .unwrap();
    request.version_ids = vec![version.id.clone()];
    request.configurations[0].execution_profile = "protected_repository".into();
    // This smoke exercises the real repository helper, not provider inventory.
    // The fake backend has only text inventory and must never execute a turn.
    request.configurations[0].inventory_revision = None;
    request.timeout_seconds = 120;
    request.repetitions = 1;
    request.max_executions = 1;
    let run = service.start_run(request).await.unwrap();
    let mut attempt = run.attempts[0].clone();
    attempt.started_at = Some(now());
    let prepared = collection_context::prepare(&service.store, &mut attempt, version.clone(), 120)
        .await
        .unwrap();
    let saved = service.store.attempt(&attempt.id).await.unwrap();
    let recovered = super::super::workflow::effective_version_for_attempt(&service.store, &saved)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&prepared).unwrap(),
        serde_json::to_value(recovered).unwrap()
    );
    let input = artifact_context::input(&prepared.manifest)
        .unwrap()
        .unwrap();
    assert_eq!(input.before.root_tree, tree);
    assert_eq!(input.before.after_tree, tree);
    assert!(input.before.patch.is_empty());
    let second = collection_context::prepare(&service.store, &mut attempt, version, 120)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(second).unwrap(),
        serde_json::to_value(prepared).unwrap()
    );
    assert_eq!(backend.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}
