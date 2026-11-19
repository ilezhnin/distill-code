//! A republication the operator asked to keep its measured answers: the new
//! version carries the old one's cells and evaluates their saved answers
//! again, locally, beside the evaluations already on record.
use super::super::tests::{request, setup};
use super::*;
use std::sync::atomic::Ordering;

async fn finished(s: &Arc<BenchmarkService>, run_id: &str) -> BenchmarkRun {
    for _ in 0..12 {
        s.tick().await.unwrap();
        let run = s.store.run(run_id).await.unwrap();
        if run.state == "completed" {
            return run;
        }
    }
    panic!("run {run_id} did not complete");
}

#[tokio::test]
async fn a_carrying_republication_evaluates_saved_answers_again_without_a_model() {
    let (dir, s, backend) = setup().await;
    let mut req = request(&s).await;
    req.repetitions = super::super::super::analysis::REQUIRED_REPETITIONS;
    req.max_executions = super::super::super::analysis::REQUIRED_REPETITIONS;
    let run = s.start_run(req).await.unwrap();
    let run = finished(&s, &run.id).await;
    let answers = run.attempts.len() as u32;
    assert!(answers > 0);
    assert!(run
        .attempts
        .iter()
        .all(|attempt| attempt.outcome.as_deref() == Some("pass")));
    let calls = backend.calls.load(Ordering::SeqCst);
    let first = s.store.version(&run.request.version_ids[0]).await.unwrap();

    // The same task under an evaluator that expects another answer.
    let mut changed = first.manifest.clone();
    assert_eq!(first.manifest.evaluator.kind, "json");
    changed.evaluator.expected = json!({"invented": "another answer"}).to_string();
    changed.evaluator.known_good = changed.evaluator.expected.clone();
    changed.evaluator.known_bad = "null".into();
    changed.evaluator.revision = "invented-revision-2".into();
    let second = s.republish_evaluator(changed.clone()).await.unwrap();
    assert_eq!(second.carries_from.as_deref(), Some(first.id.as_str()));
    assert_eq!(second.definition_id, first.definition_id);

    // Publishing evaluated nothing: the answers wait for the operator.
    let waiting = s.carry_status(&second.id).await.unwrap();
    assert_eq!(
        (waiting.total, waiting.evaluated, waiting.running),
        (answers, 0, false)
    );
    // The activity strip shows the answers left, so the work is never
    // invisible, and stops showing them once all are evaluated.
    assert_eq!(
        s.carry_activity().await.unwrap(),
        vec![CarryActivity {
            definition_id: first.definition_id.clone(),
            name: changed.name.clone(),
            status: waiting,
        }]
    );
    let done = s.evaluate_carried(&second.id).await.unwrap();
    assert_eq!((done.total, done.evaluated), (answers, answers));
    assert_eq!((done.running, done.last_error), (false, None));
    assert!(s.carry_activity().await.unwrap().is_empty());
    assert_eq!(backend.calls.load(Ordering::SeqCst), calls);
    for attempt in &run.attempts {
        let saved = s.store.attempt(&attempt.id).await.unwrap();
        // Where it ran, with what was recorded, and the new verdict beside it.
        assert_eq!(saved.version_id, first.id);
        assert_eq!(saved.evaluations.len(), 2);
        assert_eq!(
            saved.evaluations[0].evaluator_revision,
            first.manifest.evaluator.revision
        );
        assert_eq!(saved.evaluations[0].verdict, "pass");
        assert_eq!(
            saved.evaluations[1].evaluator_revision,
            "invented-revision-2"
        );
        assert_eq!(saved.evaluations[1].verdict, "fail");
        assert_eq!(
            saved.evaluations[1].details.as_ref().unwrap()["carriedTo"],
            second.id
        );
        assert_eq!(saved.outcome.as_deref(), Some("fail"));
    }
    // The boards read them as the carrying version's cells.
    let data = s.query_data().await.unwrap();
    let report = super::super::super::analysis::leaderboard(&data, &ResultQuery::default());
    assert!(report
        .rows
        .iter()
        .any(|row| row.scored_version_ids.contains(&second.id)));

    // Asked again, nothing is left to evaluate.
    let again = s.evaluate_carried(&second.id).await.unwrap();
    assert_eq!((again.total, again.evaluated), (answers, answers));
    let id = &run.attempts[0].id;
    assert_eq!(s.store.attempt(id).await.unwrap().evaluations.len(), 2);
    // "Evaluate again" on a carried answer asks the carrying evaluator.
    let rescored = s.rescore(id).await.unwrap();
    assert_eq!(rescored.evaluations.len(), 3);
    assert_eq!(
        rescored.evaluations[2].evaluator_revision,
        "invented-revision-2"
    );
    assert_eq!(backend.calls.load(Ordering::SeqCst), calls);

    // A draft that changes the task keeps nothing and replaces no draft.
    let mut reworded = changed;
    reworded.prompt.push_str(" Answer in one line.");
    reworded.evaluator.revision = "invented-revision-3".into();
    assert_eq!(
        s.republish_evaluator(reworded).await.unwrap_err().code,
        "validation"
    );
    let definition = s.store.definition(&first.definition_id).await.unwrap();
    assert_eq!(definition.draft, second.manifest);
    assert_eq!(definition.versions.len(), 2);
    // Only a version that carries answers evaluates them.
    assert_eq!(
        s.evaluate_carried(&first.id).await.unwrap_err().code,
        "validation"
    );
    dir.close().await;
}

/// A run that holds a version an evaluator-only republication carries goes
/// on: its remaining turns are the same task, evaluated with the carrying
/// version's check (11-16: three paused runs held the six suite-writing
/// tests republished for share scoring). An ordinary republication still
/// retires the version for the run.
#[tokio::test]
async fn a_run_resumes_on_a_version_a_republication_only_carries() {
    let (dir, s, _backend) = setup().await;
    let mut req = request(&s).await;
    req.repetitions = super::super::super::analysis::REQUIRED_REPETITIONS;
    req.max_executions = super::super::super::analysis::REQUIRED_REPETITIONS;
    let run = s.start_run(req).await.unwrap();
    s.store.set_run_state(&run.id, "paused").await.unwrap();
    let first = s.store.version(&run.request.version_ids[0]).await.unwrap();
    let mut changed = first.manifest.clone();
    changed.evaluator.expected = json!({"invented": "another answer"}).to_string();
    changed.evaluator.known_good = changed.evaluator.expected.clone();
    changed.evaluator.known_bad = "null".into();
    changed.evaluator.revision = "invented-revision-2".into();
    let second = s.republish_evaluator(changed).await.unwrap();
    assert_eq!(second.carries_from.as_deref(), Some(first.id.as_str()));
    assert!(s
        .store
        .require_current_versions(&run.request.version_ids)
        .await
        .is_err());
    s.store
        .require_continuable_versions(&run.request.version_ids)
        .await
        .unwrap();
    let resumed = s.control(&run.id, "resume").await.unwrap();
    assert_eq!(resumed.state, "running");
    if let Err(error) = s.extend_run(&run.id, &[], &[]).await {
        assert_ne!(error.code, "version_retired", "{}", error.message);
    }
    dir.close().await;
}

/// A publication that meets another writer waits for it: it reads the test's
/// versions before it writes the new one, and SQLite refuses at once to
/// upgrade a read another connection's write has overtaken (11-16: one of
/// six suite republications failed with "database is locked" while the
/// answers of the one before it were evaluated in the background).
#[tokio::test]
async fn a_publication_waits_for_a_concurrent_write_instead_of_failing() {
    let (dir, s, _backend) = setup().await;
    let req = request(&s).await;
    let first = s.store.version(&req.version_ids[0]).await.unwrap();
    let mut changed = first.manifest.clone();
    changed.evaluator.expected = json!({"invented": "another answer"}).to_string();
    changed.evaluator.known_good = changed.evaluator.expected.clone();
    changed.evaluator.known_bad = "null".into();
    changed.evaluator.revision = "invented-revision-2".into();
    let definition = s.store.definition(&first.definition_id).await.unwrap();
    let saved = s
        .store
        .save_draft(
            Some(&first.definition_id),
            Some(definition.draft_revision),
            changed,
        )
        .await
        .unwrap();

    let mut writer = s.store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("INSERT INTO benchmark_events(entity_id,kind,created_at) VALUES(?,?,?)")
        .bind("invented-writer")
        .bind("concurrent_write")
        .bind(0_i64)
        .execute(&mut *writer)
        .await
        .unwrap();
    let publishing = tokio::spawn({
        let s = s.clone();
        let id = first.definition_id.clone();
        async move { s.store.publish_carrying(&id, saved.draft_revision).await }
    });
    // Long enough for the publication to read what it checks.
    tokio::time::sleep(Duration::from_millis(500)).await;
    writer.commit().await.unwrap();
    let second = publishing.await.unwrap().unwrap();
    assert_eq!(second.carries_from.as_deref(), Some(first.id.as_str()));
    dir.close().await;
}
