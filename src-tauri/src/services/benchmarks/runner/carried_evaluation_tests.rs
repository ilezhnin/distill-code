//! A republication the operator asked to keep its measured answers: the new
//! version carries the old one's cells and evaluates their saved answers
//! again, locally, beside the evaluations already on record.
use super::tests::{request, setup};
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
    req.repetitions = super::super::analysis::REQUIRED_REPETITIONS;
    req.max_executions = super::super::analysis::REQUIRED_REPETITIONS;
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
    let done = s.evaluate_carried(&second.id).await.unwrap();
    assert_eq!((done.total, done.evaluated), (answers, answers));
    assert_eq!((done.running, done.last_error), (false, None));
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
    let report = super::super::analysis::leaderboard(&data, &ResultQuery::default());
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
