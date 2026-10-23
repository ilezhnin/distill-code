use super::*;
use serde_json::json;

async fn fixture() -> (crate::test_support::TempRoot, Store, String, Configuration) {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let mut draft = super::super::seeds::definitions().remove(0);
    draft.workflow = Some(WorkflowSpec {
        schema_version: 1,
        driver_revision: "activity-fixture-v1".into(),
        steps: ["first", "second"]
            .into_iter()
            .enumerate()
            .map(|(index, id)| WorkflowStep {
                id: id.into(),
                prompt: "Invented workflow activity fixture".into(),
                include_previous_output: index > 0,
                scope: None,
            })
            .collect(),
    });
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let configuration = serde_json::from_value(json!({
        "id":"candidate","providerId":"example-provider","accountId":null,
        "modelId":"example-model","effort":null,"fastMode":null,
        "billingMode":"subscription","executionProfile":"native_text",
        "inventoryRevision":"example-v1"
    }))
    .unwrap();
    (directory, store, version.id, configuration)
}

async fn run(
    store: &Store,
    version: &str,
    configuration: &Configuration,
    id: &str,
    state: &str,
    created_at: i64,
) {
    let request = json!({
        "requestKey":id,"versionIds":[version],"configurations":[configuration],
        "repetitions":1,"timeoutSeconds":30,"maxExecutions":1000
    });
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,?,1,?,?,?)")
        .bind(id).bind(id).bind(state).bind(created_at).bind(created_at)
        .bind(request.to_string()).execute(&store.pool).await.unwrap();
}

fn attempt(
    version: &str,
    configuration: &Configuration,
    run_id: &str,
    id: &str,
    phase: &str,
    repetition: u32,
) -> Attempt {
    let mut a = super::super::pending_attempt(run_id, version, configuration, repetition);
    a.id = id.into();
    a.phase = phase.into();
    a.started_at = (phase != "pending").then_some(100);
    a.session_id = Some(format!("{id}-session"));
    a.host_run_id = Some(format!("{id}-turn"));
    a.output = Some("INVENTED_PRIVATE_OUTPUT".repeat(2048));
    a.evidence_hash = Some(format!("{id}-sealed"));
    if phase == "terminal" {
        a.outcome = Some("completed".into());
        a.finished_at = Some(200);
    }
    a
}

async fn child(store: &Store, root: &Attempt, a: &Attempt, index: u32) {
    sqlx::query("INSERT INTO workflow_steps(attempt_id,root_attempt_id,step_index,step_id,entry_state_hash,entry_state_json,prompt,phase,data_json,decision_json) VALUES(?,?,?,?,'sealed-entry',?,?,?, ?,?)")
        .bind(&a.id).bind(&root.id).bind(i64::from(index)).bind(format!("step-{index}"))
        .bind(json!({"privateEntry":"INVENTED_PRIVATE_ENTRY"}).to_string())
        .bind("INVENTED_PRIVATE_PROMPT").bind(&a.phase)
        .bind(serde_json::to_string(a).unwrap())
        .bind(json!({"privateDecision":"INVENTED_PRIVATE_DECISION"}).to_string())
        .execute(&store.pool).await.unwrap();
}

async fn evidence_rows(store: &Store) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT data_json FROM attempts UNION ALL SELECT data_json FROM workflow_steps",
    )
    .fetch_all(&store.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn workflow_activity_uses_current_child_without_rewriting_root_or_evidence() {
    let (directory, store, version, configuration) = fixture().await;
    run(&store, &version, &configuration, "run", "pausing", 0).await;
    let mut root = attempt(&version, &configuration, "run", "root", "preparing", 0);
    root.session_id = Some("old-session".into());
    root.host_run_id = Some("old-turn".into());
    store.insert_attempt(&root).await.unwrap();
    // A root admitted before its first child is saved must not borrow the
    // root's historical session as if that child were already executing.
    assert!(store.runs().await.unwrap()[0].workflow_activity[0]
        .steps
        .is_empty());
    let first = attempt(&version, &configuration, "run", "old", "terminal", 0);
    let mut current = attempt(&version, &configuration, "run", "current", "running", 0);
    let mut observed = configuration.clone();
    observed.effort = Some("high".into());
    current.observed = Some(observed.clone());
    // Insert out of order to prove the view follows the authored step index.
    child(&store, &root, &current, 1).await;
    child(&store, &root, &first, 0).await;
    let before = evidence_rows(&store).await;
    let before_run = serde_json::to_value(store.run("run").await.unwrap()).unwrap();
    let summary = store.runs().await.unwrap().remove(0);
    assert!(summary.request.workflow_policy.is_none());
    assert_eq!(summary.workflow_activity.len(), 1);
    let activity = &summary.workflow_activity[0];
    assert_eq!(activity.root_attempt_id, "root");
    assert_eq!(activity.phase, "preparing");
    assert!(activity.outcome.is_none());
    assert_eq!(activity.steps.len(), 2);
    assert_eq!(activity.steps[0].attempt_id, "old");
    assert_eq!(activity.steps[0].configuration, configuration);
    assert_eq!(activity.steps[1].attempt_id, "current");
    assert_eq!(activity.steps[1].index, 1);
    assert_eq!(
        activity.steps[1].session_id.as_deref(),
        Some("current-session")
    );
    assert_eq!(
        activity.steps[1].host_run_id.as_deref(),
        Some("current-turn")
    );
    assert_eq!(activity.steps[1].configuration, observed);
    let projected = serde_json::to_value(activity).unwrap();
    assert!(projected["outcome"].is_null());
    assert!(projected["steps"][1]["finishedAt"].is_null());
    assert_eq!(projected.as_object().unwrap().len(), 5);
    assert_eq!(projected["steps"][1].as_object().unwrap().len(), 9);
    assert!(!projected.to_string().contains("INVENTED_PRIVATE_"));
    assert_eq!(before, evidence_rows(&store).await);
    assert_eq!(
        before_run,
        serde_json::to_value(store.run("run").await.unwrap()).unwrap()
    );
    let mut legacy = serde_json::to_value(summary).unwrap();
    legacy.as_object_mut().unwrap().remove("workflowActivity");
    assert!(serde_json::from_value::<RunSummary>(legacy)
        .unwrap()
        .workflow_activity
        .is_empty());
    directory.close().await;
}

#[tokio::test]
async fn workflow_activity_excludes_stopped_unentered_and_judging_roots() {
    let (directory, store, version, configuration) = fixture().await;
    for (index, state) in [
        "running",
        "pausing",
        "cancelling",
        "needs_attention",
        "paused",
        "completed",
        "cancelled",
    ]
    .into_iter()
    .enumerate()
    {
        run(&store, &version, &configuration, state, state, index as i64).await;
        let root = attempt(&version, &configuration, state, state, "preparing", 0);
        store.insert_attempt(&root).await.unwrap();
        child(
            &store,
            &root,
            &attempt(
                &version,
                &configuration,
                state,
                &format!("{state}-child"),
                "running",
                0,
            ),
            0,
        )
        .await;
    }
    for (index, phase) in ["pending", "terminal", "interrupted", "awaiting_judges"]
        .into_iter()
        .enumerate()
    {
        let root = attempt(
            &version,
            &configuration,
            "running",
            phase,
            phase,
            index as u32 + 1,
        );
        store.insert_attempt(&root).await.unwrap();
        child(
            &store,
            &root,
            &attempt(
                &version,
                &configuration,
                "running",
                &format!("{phase}-child"),
                "running",
                0,
            ),
            0,
        )
        .await;
    }
    let mut unentered = attempt(
        &version,
        &configuration,
        "running",
        "unentered",
        "preparing",
        5,
    );
    unentered.started_at = None;
    store.insert_attempt(&unentered).await.unwrap();
    let mut superseded = attempt(
        &version,
        &configuration,
        "running",
        "superseded",
        "running",
        6,
    );
    superseded.outcome = Some("superseded".into());
    store.insert_attempt(&superseded).await.unwrap();
    let ordinary = store
        .save_draft(None, None, super::super::seeds::definitions().remove(0))
        .await
        .unwrap();
    let ordinary = store.publish(&ordinary.id, 1).await.unwrap();
    store
        .insert_attempt(&attempt(
            &ordinary.id,
            &configuration,
            "running",
            "ordinary",
            "running",
            0,
        ))
        .await
        .unwrap();
    for summary in store.runs().await.unwrap() {
        if ["running", "pausing", "cancelling", "needs_attention"].contains(&summary.state.as_str())
        {
            assert_eq!(summary.workflow_activity.len(), 1, "{}", summary.state);
            assert_eq!(summary.workflow_activity[0].root_attempt_id, summary.id);
        } else {
            assert!(summary.workflow_activity.is_empty(), "{}", summary.state);
        }
    }
    directory.close().await;
}

#[tokio::test]
async fn workflow_activity_keeps_completed_steps_separate_from_root_grading() {
    let (directory, store, version, configuration) = fixture().await;
    run(&store, &version, &configuration, "run", "running", 0).await;
    let mut root = attempt(&version, &configuration, "run", "root", "collecting", 0);
    store.insert_attempt(&root).await.unwrap();
    for index in 0..2 {
        child(
            &store,
            &root,
            &attempt(
                &version,
                &configuration,
                "run",
                &format!("step-{index}"),
                "terminal",
                0,
            ),
            index,
        )
        .await;
    }
    let summary = store.runs().await.unwrap().remove(0);
    assert_eq!(summary.settled_count, 0);
    assert_eq!(summary.workflow_activity[0].phase, "collecting");
    assert!(summary.workflow_activity[0].outcome.is_none());
    assert!(summary.workflow_activity[0]
        .steps
        .iter()
        .all(|step| step.phase == "terminal"));
    root.phase = "terminal".into();
    root.outcome = Some("pass".into());
    store.save_attempt(&root).await.unwrap();
    let summary = store.runs().await.unwrap().remove(0);
    assert_eq!(summary.settled_count, 1);
    assert!(summary.workflow_activity.is_empty());
    directory.close().await;
}

#[tokio::test]
async fn workflow_activity_is_bounded_to_entered_roots_and_uses_child_index() {
    let (directory, store, version, configuration) = fixture().await;
    run(&store, &version, &configuration, "run", "running", 0).await;
    let mut tx = store.pool.begin().await.unwrap();
    for index in 0..1000 {
        let phase = if index < 2 { "preparing" } else { "pending" };
        let mut root = attempt(
            &version,
            &configuration,
            "run",
            &format!("root-{index}"),
            phase,
            index,
        );
        root.output = None;
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,'candidate',?,?,?)")
            .bind(&root.id).bind(&version).bind(i64::from(index)).bind(phase)
            .bind(serde_json::to_string(&root).unwrap()).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    for index in 0..2 {
        let root = store.attempt(&format!("root-{index}")).await.unwrap();
        child(
            &store,
            &root,
            &attempt(
                &version,
                &configuration,
                "run",
                &format!("child-{index}"),
                "running",
                0,
            ),
            0,
        )
        .await;
    }
    let summary = store.runs().await.unwrap().remove(0);
    assert_eq!(summary.attempt_count, 1000);
    assert_eq!(summary.workflow_activity.len(), 2);
    let bytes = serde_json::to_vec(&summary.workflow_activity).unwrap();
    assert!(bytes.len() < 4096);
    assert!(!String::from_utf8(bytes)
        .unwrap()
        .contains("INVENTED_PRIVATE_"));
    let plan = sqlx::query(&format!("EXPLAIN QUERY PLAN {WORKFLOW_ACTIVITY_SQL}"))
        .bind("[\"run\"]")
        .fetch_all(&store.pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.get::<String, _>(3))
        .collect::<Vec<_>>();
    assert!(
        plan.iter()
            .any(|detail| detail.contains("attempts_run_phase")),
        "{plan:?}"
    );
    assert!(
        plan.iter()
            .any(|detail| detail.contains("SEARCH s USING INDEX")
                && detail.contains("root_attempt_id=?")),
        "{plan:?}"
    );
    directory.close().await;
}

#[tokio::test]
async fn workflow_activity_shares_a_snapshot_with_its_run_state() {
    let (directory, store, version, configuration) = fixture().await;
    run(&store, &version, &configuration, "run", "running", 0).await;
    let root = attempt(&version, &configuration, "run", "root", "preparing", 0);
    store.insert_attempt(&root).await.unwrap();
    let mut step = attempt(&version, &configuration, "run", "step", "running", 0);
    child(&store, &root, &step, 0).await;
    let mut reader = store.pool.begin().await.unwrap();
    let state: String = sqlx::query_scalar("SELECT state FROM run_plans WHERE id='run'")
        .fetch_one(&mut *reader)
        .await
        .unwrap();
    assert_eq!(state, "running");
    step.phase = "terminal".into();
    step.outcome = Some("completed".into());
    store.save_attempt(&step).await.unwrap();
    store.set_run_state("run", "paused").await.unwrap();
    let activity = workflow_activity(&mut reader, &["run".into()])
        .await
        .unwrap();
    assert_eq!(activity["run"][0].steps[0].phase, "running");
    reader.commit().await.unwrap();
    assert!(store.runs().await.unwrap()[0].workflow_activity.is_empty());
    directory.close().await;
}

#[tokio::test]
async fn workflow_activity_is_limited_to_listed_runs_and_reports_invalid_metadata() {
    let (directory, store, version, configuration) = fixture().await;
    for index in 0..101 {
        run(
            &store,
            &version,
            &configuration,
            &format!("run-{index}"),
            "running",
            index,
        )
        .await;
    }
    for index in [0, 100] {
        let run_id = format!("run-{index}");
        let root = attempt(
            &version,
            &configuration,
            &run_id,
            &format!("root-{index}"),
            "preparing",
            0,
        );
        store.insert_attempt(&root).await.unwrap();
        child(
            &store,
            &root,
            &attempt(
                &version,
                &configuration,
                &run_id,
                &format!("child-{index}"),
                "running",
                0,
            ),
            0,
        )
        .await;
    }
    let summaries = store.runs().await.unwrap();
    assert_eq!(summaries.len(), 100);
    assert!(summaries.iter().all(|summary| summary.id != "run-0"));
    assert_eq!(
        summaries
            .iter()
            .map(|summary| summary.workflow_activity.len())
            .sum::<usize>(),
        1
    );
    sqlx::query("UPDATE workflow_steps SET data_json=json_set(data_json,'$.configuration',json('{}')) WHERE attempt_id='child-100'")
        .execute(&store.pool).await.unwrap();
    assert!(store.runs().await.is_err());
    directory.close().await;
}
