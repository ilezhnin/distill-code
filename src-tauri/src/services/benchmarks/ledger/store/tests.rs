use super::*;
use serde_json::{json, Value};

#[tokio::test]
async fn activity_survives_stale_flight_saves_retries_and_pause_resume() {
    let dir = crate::test_support::TempRoot::new();
    let store = Store::open(dir.path()).await.unwrap();
    dir.register(&store.pool);
    let definition = store
        .save_draft(
            None,
            None,
            crate::services::benchmarks::seeds::definitions().remove(0),
        )
        .await
        .unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let config = json!({"id":"c","providerId":"provider","accountId":"account","modelId":"native","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let request = json!({"requestKey":"clock","versionIds":[version.id],"configurations":[config],"repetitions":1,"timeoutSeconds":30,"maxExecutions":3});
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('clock','clock','running',1,0,0,?)")
        .bind(request.to_string()).execute(&store.pool).await.unwrap();
    let mut attempt = crate::services::benchmarks::pending_attempt(
        "clock",
        &version.id,
        &serde_json::from_value(config).unwrap(),
        0,
    );
    store.insert_attempt(&attempt).await.unwrap();
    let original_wait = attempt.activity.as_ref().unwrap().spans[0].started_at;
    attempt.phase = "running".into();
    attempt.started_at = Some(now());
    store.save_attempt(&attempt).await.unwrap();
    // The flight does not reload timing on every phase transition.
    attempt.activity = None;
    attempt.phase = "awaiting_judges".into();
    attempt.output = Some("Retained example answer".into());
    attempt.reason = Some("Waiting for local resources: preparation capacity".into());
    store.save_attempt(&attempt).await.unwrap();
    store.save_attempt(&attempt).await.unwrap();
    let saved = store.attempt(&attempt.id).await.unwrap();
    let spans = &saved.activity.as_ref().unwrap().spans;
    assert_eq!(spans.len(), 3);
    assert_eq!(spans[0].started_at, original_wait);
    assert_eq!(spans[1].kind, ActivityKind::Execution);
    assert_eq!(spans[2].kind, ActivityKind::Waiting);
    assert!(spans[2].finished_at.is_none());
    let paused_at = now();
    store
        .set_run_state_at("clock", "paused", paused_at)
        .await
        .unwrap();
    let paused = store.attempt(&attempt.id).await.unwrap();
    assert_eq!(
        paused.activity.unwrap().spans.last().unwrap().finished_at,
        Some(paused_at)
    );
    let resumed_at = paused_at + 7_200_000;
    store
        .set_run_state_at("clock", "running", resumed_at)
        .await
        .unwrap();
    let resumed = store.attempt(&attempt.id).await.unwrap();
    let spans = &resumed.activity.as_ref().unwrap().spans;
    assert_eq!(spans.len(), 4);
    assert_eq!(spans.last().unwrap().started_at, resumed_at);
    assert_eq!(resumed.output.as_deref(), Some("Retained example answer"));
    store
        .set_run_state("clock", "needs_attention")
        .await
        .unwrap();
    let stopped = store.attempt(&attempt.id).await.unwrap();
    assert!(stopped
        .activity
        .as_ref()
        .unwrap()
        .spans
        .last()
        .unwrap()
        .finished_at
        .is_some());
    // Accepted calls keep draining when another cell stops dispatch.
    store.set_run_state("clock", "running").await.unwrap();
    attempt.phase = "running".into();
    attempt.reason = None;
    store.save_attempt(&attempt).await.unwrap();
    store
        .set_run_state("clock", "needs_attention")
        .await
        .unwrap();
    store.save_attempt(&attempt).await.unwrap();
    let draining = store.attempt(&attempt.id).await.unwrap();
    let last = draining.activity.as_ref().unwrap().spans.last().unwrap();
    assert_eq!(last.kind, ActivityKind::Execution);
    assert!(last.finished_at.is_none());
    attempt.phase = "terminal".into();
    store.save_attempt(&attempt).await.unwrap();
    let finished = store.attempt(&attempt.id).await.unwrap();
    assert!(finished
        .activity
        .unwrap()
        .spans
        .last()
        .unwrap()
        .finished_at
        .is_some());
    dir.close().await;
}

/// Complete each fixture's protocol without changing which rendering is
/// newest. Copies precede the original row in the gallery's ordering.
async fn add_gallery_repetitions(store: &Store) {
    let rows = sqlx::query("SELECT data_json FROM attempts")
        .fetch_all(&store.pool)
        .await
        .unwrap();
    for row in rows {
        let original: Attempt = serde_json::from_str(row.get(0)).unwrap();
        for copy in 1..=2 {
            let mut attempt = original.clone();
            attempt.id = format!("{}-copy-{copy}", original.id);
            attempt.repetition = sqlx::query_scalar::<_, i64>("SELECT MAX(repetition)+1 FROM attempts WHERE run_id=? AND version_id=? AND configuration_id=?")
                .bind(&attempt.run_id).bind(&attempt.version_id).bind(&attempt.configuration.id)
                .fetch_one(&store.pool).await.unwrap() as u32;
            sqlx::query("INSERT INTO attempts(rowid,id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES((SELECT MIN(0,MIN(rowid))-1 FROM attempts),?,?,?,?,?,?,?)")
                .bind(&attempt.id).bind(&attempt.run_id).bind(&attempt.version_id)
                .bind(&attempt.configuration.id).bind(attempt.repetition)
                .bind(&attempt.phase).bind(serde_json::to_string(&attempt).unwrap())
                .execute(&store.pool).await.unwrap();
        }
    }
}

/// sqlx stores the checksum of every migration it applies and refuses to
/// open a database whose applied migration no longer matches its file,
/// comments included; every benchmark surface would then fail to open. A
/// migration that has shipped is frozen; this says so at test time
/// instead of at the operator's next launch. New migrations are appended
/// here once they ship.
#[test]
fn a_shipped_migration_is_never_edited() {
    const SHIPPED: &[(i64, &str)] = &[
        (20260930000000, "9eeb1cf55d05eedf82f94eb8009fbcd480b0ddc74877111f1c91b30009c4cf147ec120098b50f1bedbc850c990c05d4c"),
        (20261001000000, "971a3d5b40baa96b542add5ac54841ed9592a59a58cdf79fc11c65db8f918fcce210966a05aa2e0a2fc8f9da47cacf02"),
        (20261002000000, "82d4743341e09aa8ef814312ac1ca61dd9b0db4de8d534357c04f0a1c3c642ba583e861e6fae6551804ec1761fc42fad"),
        (20261003000000, "31579022d9cc8b18e883bd695f77a4613a2e596d9726d201400a399b89ae9970132e38d19a5f027b19970c29e647883c"),
        (20261003000001, "168178b0ce15869346cc3d80450b00b6c7bd097ee87e168d8051410ed83cdad2f02bcd9d8627818302b4c1989d719ccd"),
        (20261004000000, "e962b9e07105c1df071a37c7c2d76913bc38a622bf4f37eda08fdaeb9c4ff097c1be29046eee9fd12832e2e74f921d8c"),
    ];
    let migrator = sqlx::migrate!("./migrations_benchmarks");
    for (version, checksum) in SHIPPED {
        let migration = migrator
            .iter()
            .find(|migration| migration.version == *version)
            .unwrap_or_else(|| panic!("shipped migration {version} is gone"));
        assert_eq!(
            hex::encode(&migration.checksum),
            *checksum,
            "migration {version} changed after it shipped; restore the file and add a new migration instead"
        );
    }
}

#[tokio::test]
async fn the_design_gallery_keeps_the_newest_rendering_per_brief_and_configuration() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions()
        .into_iter()
        .find(|d| d.work_class_id == "creative")
        .unwrap();
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let configuration = json!({"id":"candidate","providerId":"provider","accountId":null,"modelId":"native-model","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let mut tx = store.pool.begin().await.unwrap();
    for (run, created_at, preview) in [("run-1", 1, false), ("run-2", 2, false), ("run-3", 3, true)]
    {
        let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[configuration],"repetitions":1,"timeoutSeconds":600,"maxExecutions":1,"preview":preview});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,?,?,?)")
            .bind(run).bind(run).bind(created_at).bind(created_at).bind(request.to_string())
            .execute(&mut *tx).await.unwrap();
        let evaluations = if run == "run-2" {
            json!([{"id":"objective","evaluatorRevision":"1","verdict":"pending_review","score":null,"reason":"waiting","createdAt":5,"provenance":"objective","artifacts":[]},{"id":"review","evaluatorRevision":"1","verdict":"fail","score":0.7,"reason":"Lighthouse present","createdAt":6,"provenance":"human","artifacts":[],"details":{"adherence":0.8,"craft":0.6}}])
        } else {
            json!([{"id":"objective","evaluatorRevision":"1","verdict":"pending_review","score":null,"reason":"waiting","createdAt":5,"provenance":"objective","artifacts":[]}])
        };
        let attempt = json!({"id":format!("attempt-{run}"),"runId":run,"versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":"pending_review","output":format!("<svg data-run='{run}'/>"),"usage":{"schema":"native","output":120,"cost":0.05},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[]});
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'candidate',0,'terminal',?)")
            .bind(format!("attempt-{run}")).bind(run).bind(&version.id).bind(attempt.to_string())
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    // The preview run never shows; the newest real run wins and carries its review.
    add_gallery_repetitions(&store).await;
    let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].attempt_id, "attempt-run-2");
    assert_eq!(
        entries[0].output.as_deref(),
        Some("<svg data-run='run-2'/>")
    );
    assert_eq!(entries[0].output_format.as_deref(), Some("svg"));
    let review = entries[0].review.as_ref().unwrap();
    assert_eq!(review.score, 0.7);
    assert!(entries[0].judges.is_empty());
    assert_eq!(review.details.as_ref().unwrap()["craft"], json!(0.6));
    // Each scored repetition of the measurement is a point of its own.
    let points = &entries[0].points;
    assert_eq!(points.len(), 3);
    assert!(points.iter().all(|point| point.run_id == "run-2"));
    assert!(points
        .iter()
        .any(|point| point.attempt_id == "attempt-run-2"));
    let mut repetitions: Vec<u32> = points.iter().map(|point| point.repetition).collect();
    repetitions.sort_unstable();
    assert_eq!(repetitions, vec![0, 1, 2]);
    assert!(points.iter().all(|point| point.score == Some(0.7)));
    assert_eq!(entries[0].rendering, None);
    // A run whose rendering is not reviewed is not a completed result.
    let older = store
        .list_designs(&ResultQuery {
            run_id: Some("run-1".into()),
            ..ResultQuery::default()
        })
        .await
        .unwrap();
    assert!(older.is_empty());
    let none = store
        .list_designs(&ResultQuery {
            version_ids: Some(vec![]),
            ..ResultQuery::default()
        })
        .await
        .unwrap();
    assert!(none.is_empty());
    directory.close().await;
}
#[test]
fn a_design_shows_the_image_its_scoring_batch_rendered() {
    let evaluations: Vec<Evaluation> = serde_json::from_value(json!([
        {"id":"r1","evaluatorRevision":"1","verdict":"rendered","score":null,"reason":"","createdAt":1,"provenance":"render","artifacts":[{"kind":"screenshot","path":"old.png","hash":"a","label":"Rendering"}],"details":{"expectedJudges":1}},
        {"id":"j1","evaluatorRevision":"1","verdict":"judged","score":0.4,"reason":"","createdAt":2,"provenance":"judge","artifacts":[]},
        {"id":"r2","evaluatorRevision":"1","verdict":"rendered","score":null,"reason":"","createdAt":3,"provenance":"render","artifacts":[{"kind":"screenshot","path":"new.png","hash":"b","label":"Rendering"}],"details":{"expectedJudges":1}},
        {"id":"j2","evaluatorRevision":"1","verdict":"judged","score":0.9,"reason":"","createdAt":4,"provenance":"judge","artifacts":[]},
        {"id":"r3","evaluatorRevision":"1","verdict":"rendered","score":null,"reason":"","createdAt":5,"provenance":"render","artifacts":[{"kind":"screenshot","path":"unsettled.png","hash":"c","label":"Rendering"}],"details":{"expectedJudges":2}}
    ]))
    .unwrap();
    // The newest settled batch scores the attempt, so its image is shown.
    assert_eq!(
        batch_rendering(&evaluations[scoring_batch(&evaluations)]).as_deref(),
        Some("new.png")
    );
    assert_eq!(batch_rendering(&evaluations[1..2]), None);
    assert_eq!(batch_rendering(&[]), None);
}
/// A rendering the old runner stopped for the size of its event record
/// scored a fixed 0 and, being the newest scored one, took the card. Read
/// as unscored, it leaves the card to the older scored rendering, and its
/// own run has no completed gallery result.
#[tokio::test]
async fn a_rendering_stopped_by_its_event_record_is_unscored_in_the_gallery() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions()
        .into_iter()
        .find(|d| d.work_class_id == "creative")
        .unwrap();
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let configuration = json!({"id":"candidate","providerId":"provider","accountId":null,"modelId":"native-model","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let reviewed = json!([{"id":"objective","evaluatorRevision":"1","verdict":"pending_review","score":null,"reason":"waiting","createdAt":5,"provenance":"objective","artifacts":[]},{"id":"review","evaluatorRevision":"1","verdict":"fail","score":0.7,"reason":"ok","createdAt":6,"provenance":"human","artifacts":[]}]);
    let mut tx = store.pool.begin().await.unwrap();
    for (run, created_at) in [("run-1", 1), ("run-2", 2)] {
        let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[configuration],"repetitions":1,"timeoutSeconds":600,"maxExecutions":1,"preview":false});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,?,?,?)")
            .bind(run).bind(run).bind(created_at).bind(created_at).bind(request.to_string())
            .execute(&mut *tx).await.unwrap();
        let mut attempt = json!({"id":format!("attempt-{run}"),"runId":run,"versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":"pending_review","output":format!("<svg data-run='{run}'/>"),"usage":{"schema":"native"},"evaluations":reviewed,"eventCursor":0,"workflowSteps":[]});
        if run == "run-2" {
            attempt["outcome"] = json!("budget_reached");
            attempt["reason"] = json!(crate::services::benchmarks::evidence::LEGACY_CAP_REASON);
            attempt["evaluations"] = json!([]);
        }
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'candidate',0,'terminal',?)")
            .bind(format!("attempt-{run}")).bind(run).bind(&version.id).bind(attempt.to_string())
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    add_gallery_repetitions(&store).await;
    let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].attempt_id, "attempt-run-1");
    assert_eq!(entries[0].score, Some(0.7));
    let stopped = store
        .list_designs(&ResultQuery {
            run_id: Some("run-2".into()),
            ..ResultQuery::default()
        })
        .await
        .unwrap();
    assert!(stopped.is_empty());
    // The store keeps what it settled with, for run detail.
    assert_eq!(
        store
            .attempt("attempt-run-2")
            .await
            .unwrap()
            .outcome
            .as_deref(),
        Some("budget_reached")
    );
    directory.close().await;
}
#[tokio::test]
async fn one_gallery_card_per_model_shows_its_scored_rendering_and_generation_cost() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions()
        .into_iter()
        .find(|d| d.work_class_id == "creative")
        .unwrap();
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let configuration = |revision: &str, fast: Option<bool>| json!({"id":"sonnet","providerId":"claude-acp","accountId":"account","modelId":"sonnet","effort":"high","fastMode":fast,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":revision});
    let judge = configuration("r1", None);
    // Two batches: only the newer one shows, with its criteria unwrapped.
    let judged = json!([
        {"id":"objective","evaluatorRevision":"1","verdict":"pending_review","score":null,"reason":"waiting","createdAt":5,"provenance":"objective","artifacts":[]},
        {"id":"render-1","evaluatorRevision":"1","verdict":"rendered","score":null,"reason":"r","createdAt":6,"provenance":"render","artifacts":[],"details":{"expectedJudges":2}},
        {"id":"legacy","evaluatorRevision":"1","verdict":"judged","score":0.9,"reason":"old","createdAt":7,"provenance":"judge","artifacts":[],"details":{"adherence":0.9},"judge":judge},
        {"id":"render-2","evaluatorRevision":"1","verdict":"rendered","score":null,"reason":"r","createdAt":8,"provenance":"render","artifacts":[],"details":{"expectedJudges":2}},
        {"id":"new-1","evaluatorRevision":"1","verdict":"judged","score":0.6,"reason":"one","createdAt":9,"provenance":"judge","artifacts":[],"details":{"judgeBatchId":"b","sessionId":"s1","usageComplete":true,"criteria":{"adherence":0.6}},"judge":judge,"usage":{"schema":"native","cost":0.1}},
        {"id":"new-2","evaluatorRevision":"1","verdict":"judged","score":0.8,"reason":"two","createdAt":10,"provenance":"judge","artifacts":[],"details":{"judgeBatchId":"b","sessionId":"s2","usageComplete":true,"criteria":{"adherence":0.8}},"judge":judge},
        {"id":"failed","evaluatorRevision":"1","verdict":"abstained","score":null,"reason":"busy","createdAt":11,"provenance":"judge_failure","artifacts":[],"details":{"judgeBatchId":"b","usageComplete":true,"criteria":null},"judge":judge}
    ]);
    // Newest first: a pending retest under a new runtime, a cancelled one whose
    // session acknowledged another model, then the judged rendering.
    let mut substituted = configuration("r2", None);
    substituted["modelId"] = json!("default");
    let attempts = [
        (
            "run-3",
            3,
            "pending",
            None,
            configuration("r2", None),
            Value::Null,
            json!([]),
            None,
        ),
        (
            "run-2",
            2,
            "terminal",
            Some("cancelled"),
            configuration("r2", None),
            substituted,
            json!([]),
            Some("<svg data-run='2'/>"),
        ),
        (
            "run-1",
            1,
            "terminal",
            Some("judged"),
            configuration("r1", None),
            configuration("r1", Some(false)),
            judged,
            Some("<svg data-run='1'/>"),
        ),
    ];
    let mut tx = store.pool.begin().await.unwrap();
    for (run, created_at, phase, outcome, requested, observed, evaluations, output) in attempts {
        let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[requested],"repetitions":1,"timeoutSeconds":600,"maxExecutions":4,"preview":false});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'running',1,?,?,?)")
            .bind(run).bind(run).bind(created_at).bind(created_at).bind(request.to_string())
            .execute(&mut *tx).await.unwrap();
        let attempt = json!({"id":format!("attempt-{run}"),"runId":run,"versionId":version.id,"configuration":requested,"observed":observed,"repetition":0,"phase":phase,"outcome":outcome,"output":output,"finishedAt":created_at,"durationMs":1000,"usage":{"schema":"native","output":120,"cost":0.05},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[]});
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'sonnet',0,?,?)")
            .bind(format!("attempt-{run}")).bind(run).bind(&version.id).bind(phase).bind(attempt.to_string())
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    add_gallery_repetitions(&store).await;
    let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
    assert_eq!(entries.len(), 1);
    let card = &entries[0];
    assert_eq!(card.attempt_id, "attempt-run-1");
    assert_eq!(card.score, Some(0.7));
    // The card's cost is the candidate's own generation, whatever the judges cost.
    assert_eq!(card.cost, Some(0.05));
    assert_eq!(
        card.judges.iter().map(|j| j.score).collect::<Vec<_>>(),
        [0.6, 0.8]
    );
    assert_eq!(card.judges[0].details, Some(json!({"adherence":0.6})));
    directory.close().await;
}
#[tokio::test]
async fn an_excluded_authored_cell_is_no_gallery_entry() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let mut draft = crate::services::benchmarks::seeds::definitions()
        .into_iter()
        .find(|d| d.work_class_id == "creative")
        .unwrap();
    draft.environment["authoredBy"] =
        json!([{"providerId":"claude-acp","modelId":"claude-fable-5-1","effort":null}]);
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let configuration = json!({"id":"fable","providerId":"claude-acp","accountId":"account","modelId":"claude-fable-5-1","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"r1"});
    let insert = |run: &'static str, created_at: i64, attempt: Value| {
        let store = &store;
        let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[configuration],"repetitions":1,"timeoutSeconds":600,"maxExecutions":1,"preview":false});
        async move {
            sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'running',1,?,?,?)")
                .bind(run).bind(run).bind(created_at).bind(created_at).bind(request.to_string())
                .execute(&store.pool).await.unwrap();
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'fable',0,'terminal',?)")
                .bind(attempt["id"].as_str().unwrap()).bind(run).bind(attempt["versionId"].as_str().unwrap()).bind(attempt.to_string())
                .execute(&store.pool).await.unwrap();
        }
    };
    // The runner settled the planned cell without a model call.
    insert("run-2", 2, json!({"id":"excluded","runId":"run-2","versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":"excluded","reason":"authored by this candidate","output":null,"finishedAt":2,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]})).await;
    let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
    assert!(entries.is_empty());
    // An unreviewed rendering from an older run is not a complete cell.
    insert("run-1", 1, json!({"id":"rendering","runId":"run-1","versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":"pending_review","output":"<svg/>","finishedAt":1,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]})).await;
    let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
    assert!(entries.is_empty());
    directory.close().await;
}
#[tokio::test]
async fn a_measured_rendering_of_its_own_brief_is_a_gallery_entry_like_any_other() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let mut draft = crate::services::benchmarks::seeds::definitions()
        .into_iter()
        .find(|d| d.work_class_id == "creative")
        .unwrap();
    draft.environment["authoredBy"] =
        json!([{"providerId":"claude-acp","modelId":"writer","effort":null}]);
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let configuration = |model: &str| json!({"id":model,"providerId":"claude-acp","accountId":"account","modelId":model,"effort":null,"fastMode":false,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"r1"});
    let mut tx = store.pool.begin().await.unwrap();
    let request = json!({"requestKey":"run-1","versionIds":[version.id],"configurations":[],"repetitions":1,"timeoutSeconds":600,"maxExecutions":2,"preview":false,"authorPolicy":"author-cells-measured-v1"});
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run-1','run-1','completed',1,0,0,?)")
        .bind(request.to_string())
        .execute(&mut *tx).await.unwrap();
    for model in ["writer", "reader"] {
        let attempt = json!({"id":model,"runId":"run-1","versionId":version.id,"configuration":configuration(model),"observed":configuration(model),"repetition":0,"phase":"terminal","outcome":"pass","output":format!("<svg data-id='{model}'/>"),"finishedAt":1,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run-1',?,?,0,'terminal',?)")
            .bind(model).bind(&version.id).bind(model).bind(attempt.to_string())
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    add_gallery_repetitions(&store).await;
    let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
    let mut shown: Vec<_> = entries.iter().map(|e| e.attempt_id.as_str()).collect();
    shown.sort_unstable();
    assert_eq!(shown, ["reader", "writer"]);
    directory.close().await;
}
#[tokio::test]
async fn a_rendering_of_an_unknown_effort_is_no_gallery_entry() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions()
        .into_iter()
        .find(|d| d.work_class_id == "creative")
        .unwrap();
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let configuration = |model: &str, effort: Option<&str>| json!({"id":model,"providerId":"claude-acp","accountId":"account","modelId":model,"effort":effort,"fastMode":false,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"r1"});
    let acknowledged = |model: &str, effort: Option<&str>| Some(configuration(model, effort));
    // Sonnet asked for the CLI's default. Opus left the effort unset: one
    // attempt was acknowledged at the default, and another of the same
    // request in that run never was. Haiku has no effort control.
    let attempts = [
        (
            "sonnet",
            "run-1",
            configuration("sonnet", Some("default")),
            acknowledged("sonnet", Some("default")),
        ),
        (
            "opus-2",
            "run-2",
            configuration("opus", None),
            acknowledged("opus", Some("default")),
        ),
        ("opus-3", "run-2", configuration("opus", None), None),
        (
            "haiku",
            "run-3",
            configuration("haiku", None),
            acknowledged("haiku", None),
        ),
    ];
    let mut tx = store.pool.begin().await.unwrap();
    for run in ["run-1", "run-2", "run-3"] {
        let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[],"repetitions":1,"timeoutSeconds":600,"maxExecutions":1,"preview":false});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,0,0,?)")
            .bind(run).bind(run).bind(request.to_string())
            .execute(&mut *tx).await.unwrap();
    }
    for (repetition, (id, run, requested, observed)) in attempts.into_iter().enumerate() {
        let attempt = json!({"id":id,"runId":run,"versionId":version.id,"configuration":requested,"observed":observed,"repetition":repetition,"phase":"terminal","outcome":"pass","output":format!("<svg data-id='{id}'/>"),"finishedAt":1,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,?,'terminal',?)")
            .bind(id).bind(run).bind(&version.id).bind(requested["id"].as_str().unwrap()).bind(repetition as i64).bind(attempt.to_string())
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    add_gallery_repetitions(&store).await;
    let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|e| e.attempt_id.as_str())
            .collect::<Vec<_>>(),
        ["haiku"]
    );
    // The archive keeps every attempt for audit.
    for id in ["sonnet", "opus-2", "opus-3"] {
        assert!(store.attempt(id).await.is_ok());
    }
    directory.close().await;
}
#[tokio::test]
async fn a_rendering_awaiting_its_panel_is_not_a_completed_gallery_result() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions()
        .into_iter()
        .find(|d| d.work_class_id == "creative")
        .unwrap();
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let configuration = json!({"id":"sonnet","providerId":"claude-acp","accountId":"account","modelId":"sonnet","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"r1"});
    let objective = json!([{"id":"objective","evaluatorRevision":"1","verdict":"pending_review","score":null,"reason":"waiting","createdAt":5,"provenance":"objective","artifacts":[]}]);
    // An older run was cancelled before its cell ran; a newer one holds a
    // rendering whose panel a pause deferred.
    for (run, created_at, state, phase, outcome, output, evaluations) in [
        (
            "run-1",
            1,
            "cancelled",
            "terminal",
            "cancelled",
            None,
            json!([]),
        ),
        (
            "run-2",
            2,
            "paused",
            "awaiting_judges",
            "pending_review",
            Some("<svg/>"),
            objective,
        ),
    ] {
        let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[configuration],"repetitions":1,"timeoutSeconds":600,"maxExecutions":4,"preview":false});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,?,1,?,?,?)")
            .bind(run).bind(run).bind(state).bind(created_at).bind(created_at).bind(request.to_string())
            .execute(&store.pool).await.unwrap();
        let attempt = json!({"id":format!("attempt-{run}"),"runId":run,"versionId":version.id,"configuration":configuration,"repetition":0,"phase":phase,"outcome":outcome,"output":output,"finishedAt":created_at,"usage":{"schema":"native","cost":0.05},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[]});
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'sonnet',0,?,?)")
            .bind(format!("attempt-{run}")).bind(run).bind(&version.id).bind(phase).bind(attempt.to_string())
            .execute(&store.pool).await.unwrap();
    }
    let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
    assert!(entries.is_empty());
    assert_eq!(
        store
            .attempt("attempt-run-2")
            .await
            .unwrap()
            .output
            .as_deref(),
        Some("<svg/>")
    );
    directory.close().await;
}
#[tokio::test]
async fn the_gallery_requires_a_whole_cell_from_one_run_and_keeps_failed_triples() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions()
        .into_iter()
        .find(|d| d.work_class_id == "creative")
        .unwrap();
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    for (run, model, outcomes, required) in [
        ("one", "partial", vec!["pass"], 3),
        ("two", "partial", vec!["pass", "pass"], 3),
        ("retired", "retired", vec!["superseded"; 3], 3),
        ("refused", "refused", vec!["unsupported"; 3], 3),
        (
            "unreviewed",
            "unreviewed",
            vec!["pass", "pass", "pending_review"],
            3,
        ),
        ("mixed", "mixed", vec!["pass", "pass", "superseded"], 3),
        ("failed", "failed", vec!["fail"; 3], 3),
        ("complete", "complete", vec!["pass"; 3], 3),
        ("four", "four", vec!["pass"; 3], 4),
    ] {
        let configuration = json!({"id":model,"providerId":"provider","accountId":null,"modelId":model,"effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let request = json!({"requestKey":run,"versionIds":[version.id],"configurations":[configuration],"repetitions":required,"timeoutSeconds":600,"maxExecutions":4,"preview":false});
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,1,1,?)")
            .bind(run).bind(run).bind(request.to_string()).execute(&store.pool).await.unwrap();
        for (repetition, outcome) in outcomes.into_iter().enumerate() {
            let id = format!("{run}-{repetition}");
            let attempt = json!({"id":id,"runId":run,"versionId":version.id,"configuration":configuration,"repetition":repetition,"phase":"terminal","outcome":outcome,"output":"<svg/>","finishedAt":1,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,?,?,'terminal',?)")
                .bind(id).bind(run).bind(&version.id).bind(model).bind(repetition as i64).bind(attempt.to_string())
                .execute(&store.pool).await.unwrap();
        }
    }
    let entries = store.list_designs(&ResultQuery::default()).await.unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|e| e.configuration.model_id.as_str())
            .collect::<std::collections::BTreeSet<_>>(),
        ["complete", "failed"].into_iter().collect()
    );
    assert!(entries
        .iter()
        .all(|e| e.required_repetitions == 3 && e.completed_repetitions == 3));
    assert_eq!(
        entries
            .iter()
            .find(|e| e.configuration.model_id == "failed")
            .unwrap()
            .score,
        Some(0.0)
    );
    directory.close().await;
}
#[test]
fn a_refused_rendering_stays_on_the_requested_card() {
    let requested = json!({"id":"opus","providerId":"claude-acp","accountId":"account","modelId":"opus","effort":"high","fastMode":true,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"r1"});
    let mut observed = requested.clone();
    observed["effort"] = json!("medium");
    let mut attempt: Attempt = serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v","configuration":requested,"observed":observed,"repetition":0,"phase":"terminal","outcome":"selection_changed","usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]})).unwrap();
    assert_eq!(card_configuration(&attempt).effort.as_deref(), Some("high"));
    attempt.observed.as_mut().unwrap().effort = Some("high".into());
    attempt.observed.as_mut().unwrap().fast_mode = Some(false);
    assert_eq!(card_configuration(&attempt).fast_mode, Some(true));
}
/// A catalog from before October 5, 2026 carries the retired classes; the
/// first open moves every case and draft, keeps version ids and their
/// cells, and the second open leaves them alone.
#[tokio::test]
async fn legacy_work_classes_move_once_and_keep_their_versions() {
    let directory = crate::test_support::TempRoot::new();
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    draft.work_class_id = "coding-simple".into();
    draft.name = "Repair bounded clamp".into();
    draft.facets.difficulty = None;
    let mut planning = crate::services::benchmarks::seeds::definitions().remove(1);
    planning.work_class_id = "planning".into();
    planning.facets.difficulty = Some("hard".into());
    {
        let store = Store::open(directory.path()).await.unwrap();
        directory.register(&store.pool);
        let json = |d: &BenchmarkDraft| serde_json::to_string(d).unwrap();
        for (id, d) in [("d1", &draft), ("d2", &planning)] {
            sqlx::query("INSERT INTO benchmark_definitions(id,draft_json,revision,archived) VALUES(?,?,1,0)")
                .bind(id).bind(json(d)).execute(&store.pool).await.unwrap();
            sqlx::query("INSERT INTO benchmark_versions(id,definition_id,content_hash,manifest_json,published_at) VALUES(?,?,?,?,1)")
                .bind(format!("{id}-v")).bind(id).bind(format!("old-{id}")).bind(json(d)).execute(&store.pool).await.unwrap();
        }
        // The marker the first open wrote applies to an empty catalog; drop
        // it to replay the move over these rows.
        sqlx::query("DELETE FROM catalog_seed_sets WHERE id='work-classes-2026-10-05'")
            .execute(&store.pool)
            .await
            .unwrap();
        store.pool.close().await;
    }
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let moved = store.version("d1-v").await.unwrap();
    assert_eq!(moved.manifest.work_class_id, "debug");
    assert_eq!(moved.manifest.facets.difficulty.as_deref(), Some("easy"));
    assert_ne!(moved.content_hash, "old-d1");
    assert!(directory
        .path()
        .join("versions")
        .join(&moved.content_hash)
        .is_dir());
    assert_eq!(
        store.definition("d1").await.unwrap().draft.work_class_id,
        "debug"
    );
    // A class still in force keeps its row and its declared difficulty.
    let kept = store.version("d2-v").await.unwrap();
    assert_eq!(kept.manifest.work_class_id, "planning");
    assert_eq!(kept.manifest.facets.difficulty.as_deref(), Some("hard"));
    assert_eq!(kept.content_hash, "old-d2");
    store.pool.close().await;
    let again = Store::open(directory.path()).await.unwrap();
    directory.register(&again.pool);
    assert_eq!(
        again.version("d1-v").await.unwrap().content_hash,
        moved.content_hash
    );
    directory.close().await;
}
#[test]
fn a_run_summary_names_the_attempt_that_parked_it() {
    let parsed = run_issues(Some(
        r#"[["dispatch_uncertain","Remote acceptance cannot be established after restart","attempt",100]]"#
            .into(),
    ))
    .0.unwrap();
    assert_eq!(parsed.outcome.as_deref(), Some("dispatch_uncertain"));
    assert!(parsed.reason.starts_with("Remote acceptance"));
    // A pending quota wait carries no outcome yet.
    let waiting = run_issues(Some(
        r#"[[null,"the usage limit ran out","attempt",null]]"#.into(),
    ))
    .0
    .unwrap();
    assert_eq!(waiting.outcome, None);
    assert_eq!(run_issues(None), (None, None));
    assert_eq!(run_issues(Some("[]".into())), (None, None));
}
#[test]
fn temporary_warnings_require_provider_evidence_and_keep_quota_failures_actionable() {
    for reason in [
        r#"{"message":"Internal error: Rate limit reached for requests","data":{"accountId":"private-account"}}"#,
        "Too many requests",
    ] {
        assert_eq!(
            temporary_provider_issue(Some("infrastructure_failure"), reason),
            Some("rate_limited")
        );
        assert_eq!(
            temporary_provider_issue(Some("budget_timeout"), reason),
            None
        );
    }
    assert_eq!(
        temporary_provider_issue(
            Some("infrastructure_failure"),
            "The service may be temporarily overloaded, please try again later"
        ),
        Some("provider_overloaded")
    );
    assert_eq!(
        temporary_provider_issue(None, r#"{"data":{"kind":"account_quota_wait"}}"#),
        Some("quota_wait")
    );
    for reason in [
        "Weekly/Monthly Limit Exhausted",
        "HTTP 429: Insufficient balance",
        "Authentication failed",
        r#"{"message":"Request failed","data":{"accountId":"rate limit"}}"#,
        r#"{"message":"rate limit""#,
    ] {
        assert_eq!(
            temporary_provider_issue(Some("infrastructure_failure"), reason),
            None,
            "{reason}"
        );
    }
}

#[tokio::test]
async fn run_warnings_do_not_mask_actionable_errors_or_change_attempt_history() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let definition = store
        .save_draft(
            None,
            None,
            crate::services::benchmarks::seeds::definitions().remove(0),
        )
        .await
        .unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let config = json!({"id":"c","providerId":"provider","accountId":null,"modelId":"model","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let req = json!({"requestKey":"warnings","versionIds":[version.id],"configurations":[config],"repetitions":3,"timeoutSeconds":30,"maxExecutions":3});
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','warnings','running',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
    let rate_reason = json!({"code":-32603,"message":"Internal error: Rate limit reached for requests","data":{"dispatchStarted":true,"promptNotAccepted":false}}).to_string();
    let rate = json!({"outcome":"infrastructure_failure","reason":rate_reason,"finishedAt":200,"output":"retained private evidence","evaluations":[]}).to_string();
    sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES('rate','run',?,'c',1,'terminal',?)").bind(&version.id).bind(&rate).execute(&store.pool).await.unwrap();
    for state in ["running", "pausing", "paused", "completed"] {
        store.set_run_state("run", state).await.unwrap();
        let summary = store.runs().await.unwrap().remove(0);
        assert!(summary.attention.is_none(), "{state}");
        let warning = summary.warning.unwrap();
        assert_eq!(warning.attempt_id, "rate");
        assert_eq!(warning.occurred_at, 200);
        assert_eq!(warning.kind, "rate_limited");
    }
    let blocker = json!({"outcome":"infrastructure_failure","reason":"Sign-in required","finishedAt":100,"evaluations":[]});
    sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES('blocker','run',?,'c',2,'terminal',?)").bind(&version.id).bind(blocker.to_string()).execute(&store.pool).await.unwrap();
    let summary = store.runs().await.unwrap().remove(0);
    assert_eq!(summary.attention.unwrap().reason, "Sign-in required");
    assert_eq!(summary.warning.unwrap().kind, "rate_limited");
    let retained: String = sqlx::query_scalar("SELECT data_json FROM attempts WHERE id='rate'")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    assert_eq!(retained, rate);
    directory.close().await;
}
#[tokio::test]
async fn catalog_seed_sets_insert_new_vendors_once() {
    let directory = crate::test_support::TempRoot::new();
    // A catalog seeded before seed sets were recorded, whose user then
    // deleted one Anthropic seed.
    {
        let options = SqliteConnectOptions::new()
            .filename(directory.path().join("benchmarks.db"))
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .connect_with(options)
            .await
            .unwrap();
        let mut migrator = sqlx::migrate!("./migrations_benchmarks");
        migrator.migrations = std::borrow::Cow::Owned(
            migrator
                .migrations
                .iter()
                .filter(|migration| migration.version < 20261004000000)
                .cloned()
                .collect(),
        );
        migrator.run(&pool).await.unwrap();
        let store = Store {
            pool,
            root: directory.path().to_owned(),
            parsed: Arc::default(),
        };
        let (_, anthropic) = crate::services::benchmarks::model_catalog::seed_sets().remove(0);
        for entry in anthropic.iter().skip(1) {
            store.save_catalog_entry(entry).await.unwrap();
        }
        store.pool.close().await;
    }
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let entries = store.catalog_entries().await.unwrap();
    assert!(!entries.iter().any(|e| e.id == "seed-anthropic-fable-5-1"));
    // Four kept Anthropic rows, fourteen vendor rows, two estimates, the
    // two Sonnet rows of the dated context correction and its three
    // other context rows, Kimi K3.1 Pro and Highspeed, and the 11-01
    // window rows: eight OpenAI rows at the served window, six at the
    // raised one and four Grok rows, and Fable 5.2.
    assert_eq!(entries.len(), 4 + 14 + 2 + 2 + 3 + 2 + 18 + 1);
    assert!(entries
        .iter()
        .any(|e| e.id == "seed-moonshot-k3.1-pro-2026-10-23"));
    assert!(entries
        .iter()
        .any(|e| e.id == "seed-moonshot-k3.1-pro-highspeed-2026-10-23"));
    assert!(entries
        .iter()
        .any(|e| e.id == "seed-anthropic-sonnet-5-2026-10-22"));
    assert!(entries.iter().any(|e| e.id == "seed-moonshot-k3"));
    assert!(entries
        .iter()
        .any(|e| e.id == "seed-estimate-kimi-k2-8-preview"));
    // A vendor seed the user deletes stays deleted.
    store
        .delete_catalog_entry("seed-xai-grok-4-5")
        .await
        .unwrap();
    let again = store.catalog_entries().await.unwrap();
    assert_eq!(again.len(), 45);
    assert!(!again.iter().any(|e| e.id == "seed-xai-grok-4-5"));
    // A new catalog gets every set.
    let fresh_directory = crate::test_support::TempRoot::new();
    let fresh = Store::open(fresh_directory.path()).await.unwrap();
    fresh_directory.register(&fresh.pool);
    assert_eq!(
        fresh.catalog_entries().await.unwrap().len(),
        5 + 14 + 2 + 2 + 3 + 2 + 18 + 1
    );
    directory.close().await;
    fresh_directory.close().await;
}
#[test]
fn a_policy_violation_never_stands_as_a_rendering() {
    let attempt = |outcome: &str| -> Attempt {
        serde_json::from_value(json!({"id":"a","runId":"r","versionId":"v","configuration":{"id":"c","providerId":"claude-acp","accountId":"x","modelId":"m","billingMode":"subscription","executionProfile":"native_text"},"repetition":0,"phase":"terminal","outcome":outcome,"output":"<svg/>","usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]})).unwrap()
    };
    assert_eq!(card_tier(&attempt("pending_review")), 2);
    assert_eq!(card_tier(&attempt("execution_violation")), 1);
    assert_eq!(card_tier(&attempt("selection_changed")), 1);
}
#[test]
fn a_card_shows_the_newest_settled_judge_batch() {
    let evaluation = |provenance: &str, score: Option<f64>| -> Evaluation {
        let details = if provenance == "render" {
            json!({"expectedJudges": 2})
        } else {
            Value::Null
        };
        serde_json::from_value(json!({"id":"e","evaluatorRevision":"1","verdict":"v","score":score,"reason":"r","createdAt":1,"provenance":provenance,"artifacts":[],"details":details})).unwrap()
    };
    let mut evaluations = vec![
        evaluation("objective", None),
        evaluation("render", None),
        evaluation("judge", Some(0.6)),
        evaluation("judge", Some(0.8)),
    ];
    assert_eq!(scoring_batch(&evaluations), 1..4);
    // An unfinished re-evaluation keeps the settled panel on the card.
    evaluations.extend([
        evaluation("render", None),
        evaluation("judge", Some(0.2)),
        evaluation("judge_failure", None),
    ]);
    assert_eq!(scoring_batch(&evaluations), 1..4);
    evaluations.push(evaluation("judge", Some(0.4)));
    assert_eq!(scoring_batch(&evaluations), 4..8);
    assert_eq!(scoring_batch(&evaluations[..1]), 0..1);
}
#[tokio::test]
async fn the_usage_ledger_counts_each_judge_session_once() {
    let dir = crate::test_support::TempRoot::new();
    let store = Store::open(dir.path()).await.unwrap();
    dir.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions().remove(0);
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let config = json!({"id":"c","providerId":"claude-acp","accountId":"account","modelId":"sonnet","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let judge = json!({"id":"j","providerId":"claude-acp","accountId":"account","modelId":"haiku","effort":"low","fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let req = json!({"requestKey":"ledger","versionIds":[version.id],"configurations":[config],"repetitions":1,"timeoutSeconds":30,"maxExecutions":4});
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','ledger','completed',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
    let evaluations = json!([
        {"id":"vote","evaluatorRevision":"1","verdict":"judged","score":0.7,"reason":"ok","createdAt":200,"provenance":"judge","artifacts":[],"details":{"sessionId":"judge-1","durationMs":40},"judge":judge,"usage":{"schema":"native","input":7,"output":3,"cost":0.01}},
        {"id":"abstained","evaluatorRevision":"1","verdict":"abstained","score":null,"reason":"off form","createdAt":150,"provenance":"judge_failure","artifacts":[],"details":{"sessionId":"judge-2","durationMs":20},"judge":judge,"usage":{"schema":"native","input":5,"output":2,"cost":0.02}},
        {"id":"busy","evaluatorRevision":"1","verdict":"abstained","score":null,"reason":"busy","createdAt":160,"provenance":"judge_failure","artifacts":[],"details":{"judgeBatchId":"b"},"judge":judge}
    ]);
    let attempt = json!({"id":"candidate","runId":"run","versionId":version.id,"configuration":config,"repetition":0,"phase":"terminal","outcome":"judged","sessionId":"candidate-session","observed":config,"finishedAt":100,"durationMs":10,"evidenceHash":"sealed","usage":{"input":30,"output":9,"cost":0.2,"schema":"native"},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[]});
    sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES('candidate','run',?,'c',0,'terminal',?)").bind(&version.id).bind(attempt.to_string()).execute(&store.pool).await.unwrap();
    let ledger = store.usage_ledger().await.unwrap();
    assert_eq!(
        ledger
            .iter()
            .map(|e| (e.session_id.as_str(), e.model_id.as_str(), e.finished_at))
            .collect::<Vec<_>>(),
        [
            ("candidate-session", "sonnet", 100),
            ("judge-2", "haiku", 150),
            ("judge-1", "haiku", 200)
        ]
    );
    assert_eq!(ledger[2].cost_usd, Some(0.01));
    assert_eq!(ledger[2].effort.as_deref(), Some("low"));
    assert_eq!(ledger[2].duration_ms, Some(40));
    assert_eq!(ledger[1].input_tokens, Some(5));
    dir.close().await;
}
#[tokio::test]
async fn workflow_summary_keeps_the_sole_terminal_root_result_without_evidence() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions().remove(0);
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let configuration = json!({"id":"candidate","providerId":"provider","accountId":null,"modelId":"native-model","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let request = json!({
        "requestKey":"history", "versionIds":[version.id], "configurations":[configuration],
        "repetitions":1, "timeoutSeconds":30, "maxExecutions":1, "preview":false,
        "workflowPolicy":{"modelId":"fit","mode":"fixed","candidates":[configuration],
            "priorIds":["candidate"],"fixedCandidateId":"candidate","minQuality":0.5}
    });
    let cases = [
        (
            "timeout",
            "completed",
            Some("budget_timeout"),
            "terminal",
            1,
        ),
        (
            "infra",
            "completed",
            Some("infrastructure_failure"),
            "terminal",
            1,
        ),
        ("cancelled", "cancelled", Some("pass"), "terminal", 1),
        ("absent", "completed", Some("pass"), "terminal", 0),
        ("multiple", "completed", Some("pass"), "terminal", 2),
        ("pending", "running", None, "pending", 1),
        ("quota-wait", "running", None, "pending", 1),
        (
            "paused-infra",
            "paused",
            Some("infrastructure_failure"),
            "terminal",
            1,
        ),
        (
            "running-infra",
            "running",
            Some("infrastructure_failure"),
            "terminal",
            1,
        ),
        ("no-outcome", "completed", None, "terminal", 1),
        ("ordinary", "completed", Some("pass"), "terminal", 1),
        ("superseded", "completed", Some("pass"), "terminal", 2),
    ];
    for (run_id, state, outcome, phase, roots) in cases {
        let mut run_request = request.clone();
        if run_id == "ordinary" {
            run_request
                .as_object_mut()
                .unwrap()
                .remove("workflowPolicy");
        }
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,?,1,1,1,?)")
            .bind(run_id).bind(run_id).bind(state).bind(run_request.to_string())
            .execute(&store.pool).await.unwrap();
        for index in 0..roots {
            let id = format!("{run_id}-{index}");
            let outcome = if run_id == "superseded" && index == 1 {
                Some("superseded")
            } else {
                outcome
            };
            let reason = if run_id == "quota-wait" {
                json!({"data":{"kind":"account_quota_wait","nextReset":9_000_000_000_000_i64}})
                    .to_string()
            } else {
                "Recorded diagnostic".into()
            };
            let attempt = json!({
                "outcome":outcome, "reason":reason,
                "output":"private output must remain lazy", "evaluations":["private evaluation"],
                "workflowSteps":["private step evidence"], "sessionId":"private session identity"
            });
            sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'candidate',?,?,?)")
                .bind(id).bind(run_id).bind(&version.id).bind(index).bind(phase).bind(attempt.to_string())
                .execute(&store.pool).await.unwrap();
        }
    }
    let summaries = store.runs().await.unwrap();
    assert_eq!(summaries.len(), cases.len());
    for (run_id, state, outcome, _, _) in cases {
        let summary = summaries.iter().find(|row| row.id == run_id).unwrap();
        assert_eq!(summary.state, state);
        let expected = matches!(
            run_id,
            "timeout" | "infra" | "cancelled" | "superseded" | "paused-infra" | "running-infra"
        )
        .then(|| WorkflowRunResult {
            outcome: outcome.unwrap().into(),
            reason: Some("Recorded diagnostic".into()),
        });
        assert_eq!(summary.workflow_result, expected, "{run_id}");
        assert_eq!(
            summary.attention.is_some(),
            outcome == Some("infrastructure_failure"),
            "{run_id}"
        );
        assert_eq!(
            summary
                .warning
                .as_ref()
                .map(|warning| warning.kind.as_str()),
            (run_id == "quota-wait").then_some("quota_wait")
        );
    }
    let serialized = serde_json::to_value(&summaries).unwrap();
    assert!(!serialized.to_string().contains("private "));
    let mut old_summary = serde_json::to_value(&summaries[0]).unwrap();
    old_summary
        .as_object_mut()
        .unwrap()
        .remove("workflowResult");
    assert!(serde_json::from_value::<RunSummary>(old_summary)
        .unwrap()
        .workflow_result
        .is_none());
    directory.close().await;
}

/// The Attempts table and the model-page grid price an attempt as the
/// boards, the points and the evidence do: list price first, the
/// provider's own figure only for a model the catalog does not price.
#[tokio::test]
async fn the_attempts_table_prices_list_first_like_the_boards() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let definition = store
        .save_draft(
            None,
            None,
            crate::services::benchmarks::seeds::definitions().remove(0),
        )
        .await
        .unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    store
        .save_catalog_entry(&CatalogEntry {
            id: "invented-list-price".into(),
            kind: "model".into(),
            provider_id: Some("invented-provider".into()),
            needle: "invented-priced-model".into(),
            display_name: None,
            vendor: None,
            input_per_million: Some(3.0),
            output_per_million: Some(15.0),
            cache_read_per_million: None,
            cache_write_per_million: None,
            context_tokens: None,
            max_context_tokens: None,
            effective_from: 1,
            checked_at: 1,
            source: "https://example.test".into(),
            created_at: 1,
        })
        .await
        .unwrap();
    let request = json!({"requestKey":"pricing","versionIds":[version.id],"configurations":[],"repetitions":1,"timeoutSeconds":30,"maxExecutions":2,"preview":false});
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','pricing','completed',1,1,1,?)")
        .bind(request.to_string())
        .execute(&store.pool)
        .await
        .unwrap();
    // The provider reports a third of the list price for the priced model.
    for (id, model, reported) in [
        ("priced", "invented-priced-model", 1.0),
        ("unpriced", "invented-unpriced-model", 0.25),
    ] {
        let configuration = json!({"id":id,"providerId":"invented-provider","accountId":null,"modelId":model,"effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
        let attempt = json!({"id":id,"runId":"run","versionId":version.id,"configuration":configuration,"repetition":0,"phase":"terminal","outcome":"pass","finishedAt":1000,"usage":{"input":1_000_000,"output":0,"cost":reported,"schema":"provider_turn_usage_v1"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,?,0,'terminal',?)")
            .bind(id)
            .bind(&version.id)
            .bind(id)
            .bind(attempt.to_string())
            .execute(&store.pool)
            .await
            .unwrap();
    }
    let listed = store.list_attempts(&ResultQuery::default()).await.unwrap();
    let cost = |id: &str| listed.iter().find(|a| a.id == id).unwrap().cost;
    assert_eq!(cost("priced"), Some(3.0));
    assert_eq!(cost("unpriced"), Some(0.25));
    directory.close().await;
}

#[test]
fn history_progress_requires_the_whole_panel_and_every_repetition() {
    let evaluation = |provenance: &str, score: Option<f64>| {
        serde_json::json!({
        "id":provenance,"evaluatorRevision":"1","verdict":"judged","score":score,
        "reason":"","createdAt":1,"provenance":provenance,"artifacts":[],
        "details":{"expectedJudges":2}})
    };
    let partial = serde_json::json!([evaluation("render", None), evaluation("judge", Some(0.8))]);
    let complete = serde_json::json!([
        evaluation("render", None),
        evaluation("judge", Some(0.8)),
        evaluation("judge", Some(0.6))
    ]);
    let rows = serde_json::json!([
        ["model", "partial", "terminal", "pending_review", partial],
        ["model", "partial", "terminal", "pass", null],
        ["model", "complete", "terminal", "pending_review", complete],
        ["model", "objective", "terminal", "pass", null],
        ["model", "unfinished", "terminal", "pass", null],
        ["model", "unfinished", "pending", null, null]
    ]);
    assert_eq!(settled_cells(&rows.to_string()).unwrap(), 2);
}

#[tokio::test]
async fn history_summaries_and_result_pages_do_not_load_attempt_evidence() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    let definition = store.save_draft(None, None, draft.clone()).await.unwrap();
    let first = store.publish(&definition.id, 1).await.unwrap();
    draft.name.push_str(" second version");
    store
        .save_draft(Some(&definition.id), Some(1), draft)
        .await
        .unwrap();
    let second = store.publish(&definition.id, 2).await.unwrap();
    let configuration = json!({"id":"candidate","providerId":"provider","accountId":null,"modelId":"native-model","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let request = json!({"requestKey":"history","versionIds":[first.id,second.id],"configurations":[configuration],"repetitions":125,"timeoutSeconds":30,"maxExecutions":250,"preview":false});
    let output = "private evidence must remain lazy ".repeat(256);
    let mut tx = store.pool.begin().await.unwrap();
    for index in 0..105 {
        let id = format!("run-{index}");
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,?,?,?)")
            .bind(&id).bind(&id).bind(index).bind(index).bind(request.to_string())
            .execute(&mut *tx).await.unwrap();
    }
    for index in 0..126 {
        let id = format!("attempt-{index}");
        let run_id = if index == 125 { "run-0" } else { "run-104" };
        let version_id = if index % 2 == 0 || index == 125 {
            &first.id
        } else {
            &second.id
        };
        let phase = if index % 2 == 0 {
            "terminal"
        } else {
            "pending"
        };
        // Two settled repetitions a resume set aside count nowhere.
        let outcome = if index == 2 || index == 4 {
            Some("superseded")
        } else if phase == "terminal" {
            Some("pass")
        } else {
            None
        };
        let mut attempt = json!({"id":id,"runId":run_id,"versionId":version_id,"configuration":configuration,"repetition":index,"phase":phase,"outcome":outcome,"output":output,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
        if outcome.is_some() {
            attempt["resolvedModel"] = json!("native-model-2026");
        }
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,?,?,'candidate',?,?,?)")
            .bind(&id).bind(run_id).bind(version_id).bind(index).bind(phase).bind(attempt.to_string())
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();

    let summaries = store.runs().await.unwrap();
    assert_eq!(summaries.len(), 100);
    assert_eq!(summaries[0].id, "run-104");
    assert_eq!(summaries[0].attempt_count, 123);
    assert_eq!(summaries[0].settled_count, 61);
    // Two cells: the first case's repetitions all settled, the second's pending.
    assert_eq!(summaries[0].cell_count, 2);
    assert_eq!(summaries[0].settled_cell_count, 1);
    assert_eq!(summaries[1].attempt_count, 0);
    assert!(!summaries.iter().any(|r| r.id == "run-0"));
    let serialized = serde_json::to_value(&summaries).unwrap();
    assert!(serialized[0].get("attempts").is_none());
    assert!(!serialized.to_string().contains("private evidence"));

    let first_page = store.list_attempts(&ResultQuery::default()).await.unwrap();
    assert_eq!(first_page.len(), 50);
    assert_eq!(first_page[0].id, "attempt-0");
    assert_eq!(first_page[0].model_id, "native-model");
    // The model the attempt's usage named, beside the one it asked for.
    assert_eq!(
        first_page[0].resolved_model.as_deref(),
        Some("native-model-2026")
    );
    assert_eq!(first_page[1].resolved_model, None);
    // A pass scores 1; a pending attempt has no score yet.
    assert_eq!(first_page[0].score, Some(1.0));
    assert_eq!(first_page[1].score, None);
    let projection = serde_json::to_value(&first_page[0]).unwrap();
    assert_eq!(projection.as_object().unwrap().len(), 13);
    assert!(projection.get("output").is_none());
    assert!(projection.get("evaluations").is_none());
    assert_eq!(
        store
            .list_attempts(&ResultQuery {
                limit: Some(1000),
                ..Default::default()
            })
            .await
            .unwrap()
            .len(),
        100
    );
    let query = ResultQuery {
        run_id: Some("run-104".into()),
        version_ids: Some(vec![first.id.clone()]),
        attempt_ids: None,
        as_of: None,
        offset: Some(50),
        limit: Some(50),
        exclude_judge_flags: None,
    };
    let filtered = store.list_attempts(&query).await.unwrap();
    assert_eq!(filtered.len(), 13);
    assert_eq!(filtered[0].id, "attempt-100");
    assert_eq!(filtered[12].id, "attempt-124");
    assert!(filtered
        .iter()
        .all(|a| a.outcome.as_deref() == Some("pass")));
    assert_eq!(
        serde_json::to_value(&filtered).unwrap(),
        serde_json::to_value(store.list_attempts(&query).await.unwrap()).unwrap()
    );
    let old_page = store
        .list_attempts(&ResultQuery {
            run_id: Some("run-0".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(old_page.len(), 1);
    assert_eq!(old_page[0].id, "attempt-125");
    assert!(store
        .list_attempts(&ResultQuery {
            run_id: Some("run-0".into()),
            version_ids: Some(vec![second.id]),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .list_attempts(&ResultQuery {
            version_ids: Some(vec![]),
            ..Default::default()
        })
        .await
        .unwrap()
        .is_empty());
    // Reports hand exact attempt ids to the evidence dialog.
    let picked = store
        .list_attempts(&ResultQuery {
            attempt_ids: Some(vec!["attempt-125".into(), "attempt-3".into()]),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        picked.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
        ["attempt-3", "attempt-125"]
    );

    // Full internal records and direct evidence remain independently available.
    assert_eq!(store.all_runs().await.unwrap().len(), 105);
    assert_eq!(store.run("run-104").await.unwrap().attempts.len(), 125);
    assert_eq!(
        store.attempt("attempt-0").await.unwrap().output.as_deref(),
        Some(output.as_str())
    );
    directory.close().await;
}

#[tokio::test]
async fn a_listed_attempt_without_a_reported_cost_is_priced_from_the_catalog() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions().remove(0);
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let config = json!({"id":"c","providerId":"kimi-acp","accountId":null,"modelId":"kimi-code/k3","effort":"low","fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1","modelName":"Kimi K3"});
    let req = json!({"requestKey":"priced","versionIds":[version.id],"configurations":[config],"repetitions":1,"timeoutSeconds":30,"maxExecutions":3});
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','priced','completed',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
    // The shipped Moonshot seed prices K3 at $3 in and $15 out per million.
    let finished = 1_800_000_000_000i64;
    for (id, cost) in [("unpriced", Value::Null), ("reported", json!(0.42))] {
        let a = json!({"id":id,"runId":"run","versionId":version.id,"configuration":config,"repetition":0,"phase":"terminal","outcome":"pass","startedAt":finished - 10,"finishedAt":finished,"durationMs":10,"usage":{"input":1_000_000,"output":100_000,"cacheRead":0,"cacheWrite":0,"cost":cost,"schema":"provider_turn_usage_v1"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,?,0,'terminal',?)").bind(id).bind(&version.id).bind(id).bind(a.to_string()).execute(&store.pool).await.unwrap();
    }
    let listed = store.list_attempts(&ResultQuery::default()).await.unwrap();
    let cost = |id: &str| listed.iter().find(|a| a.id == id).unwrap().cost;
    assert!((cost("unpriced").unwrap() - 4.5).abs() < 1e-9);
    // A reported figure gives way to the list price, as on every board.
    assert!((cost("reported").unwrap() - 4.5).abs() < 1e-9);
    directory.close().await;
}

#[tokio::test]
async fn a_dated_attempt_listing_shows_each_attempt_as_it_stood_then() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions().remove(0);
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let config = json!({"id":"c","providerId":"provider","accountId":"account","modelId":"native","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let req = json!({"requestKey":"dated","versionIds":[version.id],"configurations":[config],"repetitions":1,"timeoutSeconds":30,"maxExecutions":3});
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','dated','completed',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
    let evaluation = |id: &str, at: i64, provenance: &str, verdict: &str, score: Value| json!({"id":id,"evaluatorRevision":"1","verdict":verdict,"score":score,"reason":"r","createdAt":at,"provenance":provenance,"artifacts":[]});
    let mut marker = evaluation("marker", 10, "render", "rendered", Value::Null);
    marker["details"] = json!({"expectedJudges": 2});
    let attempts = [
        // Failed at 2; a human review at 10 flipped it and its stored outcome.
        (
            "reviewed",
            "pass",
            Some(2),
            json!([
                evaluation("objective", 2, "objective", "fail", json!(0.0)),
                evaluation("review", 10, "human", "pass", json!(1.0))
            ]),
        ),
        // Waiting for its panel at 3; judged at 11 and 12.
        (
            "rendering",
            "judged",
            Some(2),
            json!([
                evaluation("pending", 3, "objective", "pending_review", Value::Null),
                marker,
                evaluation("vote-1", 11, "judge", "judged", json!(0.6)),
                evaluation("vote-2", 12, "judge", "judged", json!(0.8))
            ]),
        ),
        // Still running at 5; it finished at 9.
        (
            "later",
            "fail",
            Some(9),
            json!([evaluation("late", 9, "objective", "fail", json!(0.0))]),
        ),
    ];
    for (id, outcome, finished, evaluations) in attempts {
        let a = json!({"id":id,"runId":"run","versionId":version.id,"configuration":config,"repetition":0,"phase":"terminal","outcome":outcome,"startedAt":1,"finishedAt":finished,"durationMs":10,"usage":{"output":4,"cost":0.5,"schema":"native"},"evaluations":evaluations,"eventCursor":0,"workflowSteps":[],"resolvedModel":"native-2026"});
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,?,0,'terminal',?)").bind(id).bind(&version.id).bind(id).bind(a.to_string()).execute(&store.pool).await.unwrap();
    }
    let listed = |as_of: Option<i64>| {
        let store = &store;
        async move {
            store
                .list_attempts(&ResultQuery {
                    attempt_ids: Some(vec!["reviewed".into(), "rendering".into(), "later".into()]),
                    as_of,
                    ..Default::default()
                })
                .await
                .unwrap()
                .into_iter()
                .map(|a| (a.id.clone(), a))
                .collect::<std::collections::BTreeMap<_, _>>()
        }
    };
    let today = listed(None).await;
    assert_eq!(today["reviewed"].outcome.as_deref(), Some("pass"));
    assert_eq!(today["rendering"].outcome.as_deref(), Some("judged"));
    assert_eq!(today["later"].outcome.as_deref(), Some("fail"));
    let then = listed(Some(5)).await;
    assert_eq!(then["reviewed"].outcome.as_deref(), Some("fail"));
    assert_eq!(then["rendering"].outcome.as_deref(), Some("pending_review"));
    let later = &then["later"];
    assert_eq!(
        (later.outcome.as_deref(), later.phase.as_str()),
        (None, "running")
    );
    assert_eq!((later.finished_at, later.cost), (None, None));
    // Which model answered is known only once it has.
    assert_eq!(later.resolved_model, None);
    assert_eq!(
        then["reviewed"].resolved_model.as_deref(),
        Some("native-2026")
    );
    directory.close().await;
}

#[tokio::test]
async fn a_run_summary_names_the_selections_its_attempts_ran_with() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions().remove(0);
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let config = json!({"id":"sonnet","providerId":"claude-acp","accountId":"account","modelId":"sonnet","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let req = json!({"requestKey":"observed","versionIds":[version.id],"configurations":[config],"repetitions":4,"timeoutSeconds":30,"maxExecutions":4});
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','observed','running',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
    let observed = |model: &str, effort: &str| {
        let mut observed = config.clone();
        observed["modelId"] = json!(model);
        observed["effort"] = json!(effort);
        observed["fastMode"] = json!(false);
        observed
    };
    for (repetition, outcome, acknowledged) in [
        (0, "pass", observed("sonnet", "high")),
        (1, "fail", observed("sonnet", "high")),
        // A refusal and a substituted model ran no candidate selection.
        (2, "selection_changed", observed("sonnet", "low")),
        (3, "selection_changed", observed("default", "medium")),
    ] {
        let a = json!({"id":format!("a{repetition}"),"runId":"run","versionId":version.id,"configuration":config,"observed":acknowledged,"repetition":repetition,"phase":"terminal","outcome":outcome,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,'sonnet',?,'terminal',?)").bind(format!("a{repetition}")).bind(&version.id).bind(repetition).bind(a.to_string()).execute(&store.pool).await.unwrap();
    }
    let summary = store.runs().await.unwrap().remove(0);
    assert_eq!(
        summary.observed_selections,
        vec![ObservedRunSelection {
            configuration_id: "sonnet".into(),
            effort: Some("high".into()),
            fast_mode: Some(false),
        }]
    );
    // A finished run starts nothing, so its evidence is never read here.
    store.set_run_state("run", "completed").await.unwrap();
    assert!(store.runs().await.unwrap()[0]
        .observed_selections
        .is_empty());
    directory.close().await;
}

#[tokio::test]
async fn a_run_summary_lists_only_the_cells_its_run_has_yet_to_settle() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    let definition = store.save_draft(None, None, draft.clone()).await.unwrap();
    let first = store.publish(&definition.id, 1).await.unwrap();
    draft.name.push_str(" second version");
    store
        .save_draft(Some(&definition.id), Some(1), draft)
        .await
        .unwrap();
    let second = store.publish(&definition.id, 2).await.unwrap();
    let config = |id: &str| json!({"id":id,"providerId":"claude-acp","accountId":"account","modelId":id,"effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let req = json!({"requestKey":"open","versionIds":[first.id,second.id],"configurations":[config("sonnet"),config("haiku")],"repetitions":2,"timeoutSeconds":30,"maxExecutions":8});
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','open','running',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
    for (id, configuration, version, repetition, phase, outcome) in [
        // Settled without a score: the run never retries it.
        (
            "a0",
            "sonnet",
            &first.id,
            0,
            "terminal",
            Some("infrastructure_failure"),
        ),
        ("a1", "sonnet", &first.id, 1, "terminal", Some("pass")),
        ("a2", "sonnet", &second.id, 0, "pending", None),
        (
            "a3",
            "sonnet",
            &second.id,
            1,
            "awaiting_judges",
            Some("pending_review"),
        ),
        ("a4", "haiku", &first.id, 0, "running", None),
        ("a5", "haiku", &second.id, 0, "terminal", Some("cancelled")),
        ("a6", "haiku", &second.id, 1, "pending", None),
    ] {
        let a = json!({"id":id,"runId":"run","versionId":version,"configuration":config(configuration),"repetition":repetition,"phase":phase,"outcome":outcome,"usage":{"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]});
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,?,?,?,?)").bind(id).bind(version).bind(configuration).bind(repetition).bind(phase).bind(a.to_string()).execute(&store.pool).await.unwrap();
    }
    let summary = store.runs().await.unwrap().remove(0);
    let cell = |configuration: &str, version: &str, running: bool| OpenRunCell {
        configuration_id: configuration.into(),
        version_id: version.into(),
        running,
    };
    // One entry per cell, in plan order, however many attempts it holds;
    // a cell runs while any attempt of it left the queue.
    assert_eq!(
        summary.open_cells,
        vec![
            cell("sonnet", &second.id, true),
            cell("haiku", &first.id, true),
            cell("haiku", &second.id, false),
        ]
    );
    assert_eq!(
        serde_json::to_value(&summary).unwrap()["openCells"][0],
        json!({"configurationId":"sonnet","versionId":second.id,"running":true})
    );
    // A run finished or being cancelled starts nothing, so its attempts are never read here.
    for state in ["completed", "cancelling", "cancelled"] {
        store.set_run_state("run", state).await.unwrap();
        assert!(store.runs().await.unwrap()[0].open_cells.is_empty());
    }
    directory.close().await;
}

#[tokio::test]
async fn a_stop_outlives_a_completion_read_before_it() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','key','running',1,0,0,'{}')")
        .execute(&store.pool)
        .await
        .unwrap();
    let state = || async {
        sqlx::query_scalar::<_, String>("SELECT state FROM run_plans WHERE id='run'")
            .fetch_one(&store.pool)
            .await
            .unwrap()
    };
    // The dispatcher read this run as running, then found nothing of it
    // flying once the owner had stopped it: completed never takes the
    // stop back.
    for stop in ["cancelling", "cancelled"] {
        store.set_run_state("run", stop).await.unwrap();
        store.set_run_state("run", "completed").await.unwrap();
        assert_eq!(state().await, stop);
    }
    // Going on again, the run completes as before.
    store.set_run_state("run", "running").await.unwrap();
    store.set_run_state("run", "completed").await.unwrap();
    assert_eq!(state().await, "completed");
    directory.close().await;
}

#[tokio::test]
async fn historical_definitions_and_filtered_usage_survive_ui_window_limits() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions().remove(0);
    let oldest = store.save_draft(None, None, draft.clone()).await.unwrap();
    let version = store.publish(&oldest.id, 1).await.unwrap();
    let mut tx = store.pool.begin().await.unwrap();
    for id in ["old-run", "new-run"] {
        sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES(?,?,'completed',1,0,0,'{}')")
            .bind(id).bind(id).execute(&mut *tx).await.unwrap();
    }
    let draft_json = serde_json::to_string(&draft).unwrap();
    for index in 0..1005 {
        sqlx::query(
            "INSERT INTO benchmark_definitions(id,draft_json,revision,archived) VALUES(?,?,1,0)",
        )
        .bind(format!("definition-{index}"))
        .bind(&draft_json)
        .execute(&mut *tx)
        .await
        .unwrap();
        let run_id = if index == 0 { "old-run" } else { "new-run" };
        let sample = json!({"id":format!("sample-{index}"),"runId":run_id,"accountScope":"account","windowId":"window","capturedAt":index,"attribution":"unknown","status":"unavailable","completedTasks":0,"reason":"test historical evidence","attemptIds":[]});
        sqlx::query("INSERT INTO usage_observations(id,run_id,data_json) VALUES(?,?,?)")
            .bind(format!("sample-{index}"))
            .bind(run_id)
            .bind(sample.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let visible = store.definition_summaries().await.unwrap();
    assert_eq!(visible.len(), 1000);
    assert!(!visible.iter().any(|d| d.id == oldest.id));
    let historical = store.all_definitions().await.unwrap();
    assert_eq!(historical.len(), 1006);
    assert!(historical
        .iter()
        .flat_map(|d| &d.versions)
        .any(|v| v.id == version.id));
    let samples = store.usage_samples().await.unwrap();
    assert_eq!(samples.len(), 1005);
    assert!(samples.iter().any(|s| s.id == "sample-0"));
    directory.close().await;
}

/// A catalog of large tasks once listed every prompt, fixture, check and
/// mutant in one reply, hundreds of megabytes, and the app ran out of
/// memory. The list carries summaries whose size does not grow with the
/// tasks. Every byte of filler here is invented.
#[tokio::test]
async fn catalog_summaries_stay_small_however_large_the_tasks_are() {
    let directory = crate::test_support::TempRoot::new();
    let store = Store::open(directory.path()).await.unwrap();
    directory.register(&store.pool);
    let filler = "invented-filler-".repeat(512);
    let mut draft = crate::services::benchmarks::seeds::definitions().remove(0);
    draft.name = "Invented large task".into();
    draft.task_family = "invented-family".into();
    draft.split = "held_out".into();
    draft.work_class_id = "debug".into();
    draft.facets.difficulty = Some("hard".into());
    draft.description = filler.clone();
    draft.prompt = filler.clone();
    draft.role_prompt = filler.clone();
    draft.evaluator = Evaluator {
        kind: "rubric".into(),
        expected: filler.clone(),
        rubric: filler.clone(),
        revision: "invented-revision".into(),
        known_good: filler.clone(),
        known_bad: filler.clone(),
    };
    draft.fixtures = (0..4)
        .map(|index| Fixture {
            path: format!("fixtures/input-{index}.txt"),
            content: filler.clone(),
        })
        .collect();
    draft.environment = json!({
        "mutants": [filler, filler, filler, filler],
        "alternatives": [{ "answer": filler }],
        "repositoryArtifactInput": { "before": { "patch": filler } },
        "authoredBy": [
            { "providerId": "example-provider", "modelId": "example-model", "effort": "xhigh" },
            "legacy-tag",
            { "providerId": "example-provider", "modelId": "other-model", "effort": null, "notes": filler },
        ],
        "splitGroup": "invented-group",
        "judgePanel": {
            "recipe": "frozen-native-panel-v1",
            "judges": [
                { "providerId": "judge-a", "modelId": "judge-model", "effort": "high", "accountId": "account-a" },
                { "providerId": "judge-b", "modelId": "judge-model", "effort": null, "accountId": "account-b" },
            ],
        },
        "generator": { "family": "invented-generator", "template": filler },
    });
    draft.entry_state = Some(EntryState {
        schema_version: 1,
        root_task_id: "root".into(),
        step_id: "step".into(),
        parent_step_id: None,
        fixture_snapshot_hash: "snapshot".into(),
        conversation_prefix: filler.clone(),
        previous_reports: vec![filler.clone()],
        remaining_budget_seconds: 60,
        content_hash: "entry-hash".into(),
    });
    draft.workflow = Some(WorkflowSpec {
        schema_version: 2,
        driver_revision: "driver".into(),
        steps: vec![
            WorkflowStep {
                id: "implement".into(),
                prompt: filler.clone(),
                include_previous_output: false,
                scope: Some(WorkflowScope {
                    role_id: "implementer".into(),
                    role_prompt: filler.clone(),
                    work_class_id: "debug".into(),
                    purpose: "implement".into(),
                    step_budget_seconds: 60,
                }),
            },
            WorkflowStep {
                id: "review".into(),
                prompt: filler.clone(),
                include_previous_output: true,
                scope: None,
            },
        ],
    });
    let manifest = serde_json::to_string(&draft).unwrap();
    assert!(manifest.len() > 150_000, "{}", manifest.len());
    const DEFINITIONS: usize = 160;
    let mut tx = store.pool.begin().await.unwrap();
    for index in 0..DEFINITIONS {
        let id = format!("definition-{index}");
        sqlx::query(
            "INSERT INTO benchmark_definitions(id,draft_json,revision,archived) VALUES(?,?,3,?)",
        )
        .bind(&id)
        .bind(&manifest)
        .bind(index == 0)
        .execute(&mut *tx)
        .await
        .unwrap();
        for version in 0..2 {
            sqlx::query("INSERT INTO benchmark_versions(id,definition_id,content_hash,manifest_json,published_at) VALUES(?,?,?,?,?)")
                .bind(format!("{id}-v{version}")).bind(&id).bind(format!("hash-{index}-{version}"))
                .bind(&manifest).bind(version).execute(&mut *tx).await.unwrap();
        }
    }
    tx.commit().await.unwrap();
    let stored: i64 = sqlx::query_scalar(
        "SELECT (SELECT SUM(LENGTH(draft_json)) FROM benchmark_definitions)+(SELECT SUM(LENGTH(manifest_json)) FROM benchmark_versions)",
    )
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert!(stored > 90_000_000, "{stored}");

    let listed = store.definition_summaries().await.unwrap();
    let reply = serde_json::to_string(&listed).unwrap();
    assert_eq!(listed.len(), DEFINITIONS);
    assert!(reply.len() < 1_000_000, "{} bytes", reply.len());
    assert!(!reply.contains("invented-filler-"));
    assert!(!reply.contains("account-a"));

    // The listed facts read the same paths as the full manifest.
    let first = listed.last().unwrap();
    assert_eq!(first.id, "definition-0");
    assert!(first.archived);
    assert_eq!(first.draft_revision, 3);
    let ids: Vec<&str> = first.versions.iter().map(|v| v.id.as_str()).collect();
    assert_eq!(ids, ["definition-0-v1", "definition-0-v0"]);
    let summary = &first.versions[0].manifest;
    assert_eq!(summary, &first.draft);
    assert_eq!(summary.name, draft.name);
    assert_eq!(summary.task_family, draft.task_family);
    assert_eq!(summary.split, "held_out");
    assert_eq!(summary.work_class_id, "debug");
    assert_eq!(summary.facets, draft.facets);
    assert_eq!(summary.limits, draft.limits);
    assert_eq!(summary.repetitions, draft.repetitions);
    assert_eq!(summary.evaluator.kind, "rubric");
    assert_eq!(summary.evaluator.revision, "invented-revision");
    assert_eq!(
        summary
            .entry_state
            .as_ref()
            .map(|e| e.content_hash.as_str()),
        Some("entry-hash")
    );
    let workflow = summary.workflow.as_ref().unwrap();
    assert_eq!(workflow.steps.len(), 2);
    assert_eq!(
        workflow.steps[0]
            .scope
            .as_ref()
            .map(|s| s.work_class_id.as_str()),
        Some("debug")
    );
    assert!(workflow.steps[1].scope.is_none());
    assert_eq!(
        summary.environment,
        json!({
            "authoredBy": [
                { "providerId": "example-provider", "modelId": "example-model", "effort": "xhigh" },
                { "providerId": "example-provider", "modelId": "other-model", "effort": null },
            ],
            "splitGroup": "invented-group",
            "judgePanel": { "judges": [
                { "providerId": "judge-a", "modelId": "judge-model", "effort": "high" },
                { "providerId": "judge-b", "modelId": "judge-model", "effort": null },
            ] },
            "generator": { "family": "invented-generator" },
        })
    );

    // A manifest from before the defaulted fields lists their defaults,
    // and an environment without the listed keys lists none of them.
    let mut legacy: Value = serde_json::from_str(&manifest).unwrap();
    let object = legacy.as_object_mut().unwrap();
    for key in ["workClassId", "roleContextHash", "entryState", "workflow"] {
        object.remove(key);
    }
    object.insert("environment".into(), json!({ "mutants": [filler] }));
    sqlx::query("UPDATE benchmark_definitions SET draft_json=? WHERE id='definition-1'")
        .bind(legacy.to_string())
        .execute(&store.pool)
        .await
        .unwrap();
    let listed = store.definition_summaries().await.unwrap();
    let legacy = &listed
        .iter()
        .find(|d| d.id == "definition-1")
        .unwrap()
        .draft;
    assert_eq!(legacy.work_class_id, "general");
    assert_eq!(legacy.role_context_hash, "clean-v1");
    assert!(legacy.entry_state.is_none() && legacy.workflow.is_none());
    assert_eq!(legacy.environment, json!({}));
    directory.close().await;
}

#[tokio::test]
async fn ledger_counts_native_children_once_and_recovery_preserves_sealed_cancellation() {
    let dir = crate::test_support::TempRoot::new();
    let store = Store::open(dir.path()).await.unwrap();
    dir.register(&store.pool);
    let draft = crate::services::benchmarks::seeds::definitions().remove(0);
    let definition = store.save_draft(None, None, draft).await.unwrap();
    let version = store.publish(&definition.id, 1).await.unwrap();
    let config = json!({"id":"c","providerId":"provider","accountId":"account","modelId":"native","effort":null,"fastMode":null,"billingMode":"subscription","executionProfile":"native_text","inventoryRevision":"v1"});
    let req = json!({"requestKey":"test","versionIds":[version.id],"configurations":[config],"repetitions":1,"timeoutSeconds":30,"maxExecutions":3});
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','test','running',1,0,0,?)").bind(req.to_string()).execute(&store.pool).await.unwrap();
    let make = |id: &str, input: u64| -> Attempt {
        serde_json::from_value(json!({"id":id,"runId":"run","versionId":version.id,"configuration":config,"repetition":0,"phase":"terminal","outcome":"completed","sessionId":format!("session-{id}"),"observed":config,"finishedAt":100,"durationMs":10,"evidenceHash":"sealed","usage":{"input":input,"output":1,"schema":"native"},"evaluations":[],"eventCursor":0,"workflowSteps":[]})).unwrap()
    };
    for (id, input) in [("root", 30), ("single", 5), ("cancelled", 0)] {
        let mut a = make(id, input);
        if id == "cancelled" {
            a.phase = "collecting".into();
            a.outcome = Some("cancelled".into());
            a.session_id = None;
        }
        sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES(?,'run',?,?,0,?,?)").bind(id).bind(&version.id).bind(id).bind(&a.phase).bind(serde_json::to_string(&a).unwrap()).execute(&store.pool).await.unwrap();
    }
    for (index, (id, input)) in [("child-1", 10), ("child-2", 20)].into_iter().enumerate() {
        let a = make(id, input);
        sqlx::query("INSERT INTO workflow_steps(attempt_id,root_attempt_id,step_index,step_id,entry_state_hash,entry_state_json,prompt,phase,data_json) VALUES(?,'root',?,?,'hash','{}','prompt','terminal',?)").bind(id).bind(index as i64).bind(id).bind(serde_json::to_string(&a).unwrap()).execute(&store.pool).await.unwrap();
    }
    let ledger = store.usage_ledger().await.unwrap();
    assert_eq!(ledger.len(), 3);
    assert_eq!(
        ledger.iter().filter_map(|e| e.input_tokens).sum::<u64>(),
        35
    );
    assert!(!ledger.iter().any(|e| e.attempt_id == "root"));
    // A rendering awaiting its panel has paid for its generation.
    let mut waiting = make("waiting", 4);
    waiting.phase = "awaiting_judges".into();
    waiting.outcome = Some("pending_review".into());
    sqlx::query("INSERT INTO attempts(id,run_id,version_id,configuration_id,repetition,phase,data_json) VALUES('waiting','run',?,'waiting',0,'awaiting_judges',?)").bind(&version.id).bind(serde_json::to_string(&waiting).unwrap()).execute(&store.pool).await.unwrap();
    let ledger = store.usage_ledger().await.unwrap();
    assert!(ledger
        .iter()
        .any(|e| e.attempt_id == "waiting" && e.input_tokens == Some(4)));
    store.recover().await.unwrap();
    let cancelled = store.attempt("cancelled").await.unwrap();
    assert_eq!(cancelled.outcome.as_deref(), Some("cancelled"));
    assert!(cancelled.output.is_none());
    // A sealed rendering awaiting its panel is no uncertain dispatch.
    let waiting = store.attempt("waiting").await.unwrap();
    assert_eq!(waiting.phase, "awaiting_judges");
    assert_eq!(waiting.outcome.as_deref(), Some("pending_review"));
    dir.close().await;
}
