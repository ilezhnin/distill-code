use super::*;

fn judge(model: &str) -> Configuration {
    Configuration {
        id: format!("invented:{model}"),
        provider_id: "claude-acp".into(),
        account_id: Some("invented-account".into()),
        model_id: model.into(),
        effort: Some("high".into()),
        fast_mode: Some(false),
        billing_mode: "subscription".into(),
        execution_profile: "native_text".into(),
        inventory_revision: Some("old-runtime".into()),
        model_name: None,
    }
}

fn fixture() -> (BenchmarkDraft, Attempt, OpenBatch) {
    let mut draft = crate::services::benchmarks::seeds::definitions()
        .into_iter()
        .find(|d| d.evaluator.kind == "rubric")
        .unwrap();
    let panel = vec![judge("opus[1m]"), judge("sonnet")];
    draft.environment["judgePanel"] = json!({"recipe":"frozen-native-panel-v1","judges":panel});
    draft.environment["rubricCriteria"] = json!([{"id":"quality","weight":1.0}]);
    assert!(crate::services::benchmarks::judge_panel::frozen(&draft, &[]).is_ok());
    let mut attempt =
        crate::services::benchmarks::pending_attempt("run", "version", &judge("haiku"), 0);
    attempt.phase = "awaiting_judges".into();
    attempt.outcome = Some("pending_review".into());
    attempt.output = Some("Invented sealed candidate artifact".into());
    attempt.evidence_hash = Some("invented-seal".into());
    let marker: Evaluation = serde_json::from_value(json!({
        "id":"marker","evaluatorRevision":draft.evaluator.revision,"verdict":"rendered",
        "reason":"Saved artifact","createdAt":1,"provenance":"render",
        "artifacts":[{"kind":"text","path":"invented.txt","hash":"sealed","label":"Artifact"}],
        "details":{"judgeBatchId":"old-batch","expectedJudges":2,"protocol":{
            "panel":panel,"prompt":"invented rubric","renderer":"text",
            "panelRecipe":"frozen-native-panel-v1","panelBinding":"old-binding"}}
    }))
    .unwrap();
    let vote: Evaluation = serde_json::from_value(json!({
        "id":"paid-vote","evaluatorRevision":draft.evaluator.revision,"verdict":"judged",
        "score":0.8,"reason":"Invented score","createdAt":2,"provenance":"judge","artifacts":[],
        "judge":panel[0],"usage":{"schema":"native","input":7,"output":3,"cost":0.01},
        "details":{"judgeBatchId":"old-batch","sessionId":"paid-session","requestKey":"paid-request",
            "usageComplete":true,"inFlight":false,"durationMs":50}
    })).unwrap();
    attempt.evaluations = vec![marker, vote];
    let open = compatible_open_batch(&attempt.evaluations, "invented rubric", "text").unwrap();
    (draft, attempt, open)
}

#[test]
fn runtime_changes_and_new_judges_do_not_replay_paid_seats() {
    let (draft, mut attempt, open) = fixture();
    let original = attempt.clone();
    let mut current = judge("sonnet");
    current.inventory_revision = Some("current-runtime".into());
    current.account_id = Some("another-invented-account".into());
    let panel = replacement_panel(&open, vec![current.clone(), judge("opus[1m]")]).unwrap();
    assert_eq!(panel, vec![judge("opus[1m]"), current.clone()]);
    assert!(needs_reseating(&attempt, &open, &panel));
    let next = reseat(&mut attempt, &draft, &open, panel, &[]).unwrap();
    assert_eq!(next.rendering, open.rendering);
    assert_eq!(next.rendering_hash, open.rendering_hash);
    assert_eq!(next.expected, open.expected);
    assert_eq!(
        seat_samples(&next.panel, 1, &next.asked),
        vec![(1, current)]
    );
    assert_eq!(attempt.output, original.output);
    assert_eq!(attempt.evidence_hash, original.evidence_hash);
    assert_eq!(
        serde_json::to_value(&attempt.evaluations[..2]).unwrap(),
        serde_json::to_value(&original.evaluations).unwrap()
    );
    let carried = attempt.evaluations.last().unwrap();
    assert_eq!(carried.score, Some(0.8));
    assert_eq!(
        carried.details.as_ref().unwrap()["reusedEvaluationId"],
        "paid-vote"
    );
    assert!(carried.usage.is_none());
    assert!(carried.details.as_ref().unwrap().get("sessionId").is_none());
    assert_eq!(crate::services::benchmarks::analysis::score(&attempt), None);
    let mut new_vote = carried.clone();
    new_vote.id = "new-vote".into();
    new_vote.judge = Some(next.panel[1].clone());
    new_vote.score = Some(0.4);
    new_vote.details = Some(json!({"judgeBatchId":next.id,"usageComplete":true,"inFlight":false}));
    attempt.evaluations.push(new_vote);
    assert!((crate::services::benchmarks::analysis::score(&attempt).unwrap() - 0.6).abs() < 1e-9);
    assert_eq!(
        crate::services::benchmarks::analysis::score_as_of(&attempt, Some(2)),
        None
    );
    assert!(
        crate::services::benchmarks::judge_panel::validate_evidence(&draft, &attempt, now())
            .is_err()
    );
}

#[test]
fn rotation_preserves_panel_size_and_does_not_duplicate_models() {
    let (_, _, open) = fixture();
    assert!(replacement_panel(&open, vec![judge("opus[1m]")]).is_none());
    let replacement = judge("haiku");
    let panel = replacement_panel(&open, vec![judge("opus[1m]"), replacement.clone()]).unwrap();
    assert_eq!(panel, vec![judge("opus[1m]"), replacement]);
    // Eligible unfinished seats keep their order despite a refreshed ranking.
    assert_eq!(
        replacement_panel(&open, vec![judge("sonnet"), judge("opus[1m]")]).unwrap(),
        open.panel
    );
}

#[test]
fn paid_seats_do_not_need_idle_accounts_again() {
    let (draft, attempt, open) = fixture();
    let replacement = judge("sonnet");
    let offered = vec![
        (Some(90.0), judge("opus[1m]")),
        (Some(80.0), replacement.clone()),
    ];
    let available = available_replacements(&[&attempt.configuration], &draft, offered, |j| {
        j.model_id == "sonnet"
    });
    assert_eq!(available, vec![replacement.clone()]);
    assert_eq!(
        replacement_panel(&open, available).unwrap(),
        vec![judge("opus[1m]"), replacement]
    );
}

#[test]
fn saved_artifacts_survive_renderer_changes_but_not_rubric_changes() {
    let (mut draft, attempt, open) = fixture();
    assert_eq!(
        recoverable(&attempt, &draft, "invented rubric")
            .unwrap()
            .rendering_hash,
        open.rendering_hash
    );
    assert!(recoverable(&attempt, &draft, "changed instructions").is_none());
    draft.evaluator.revision = "different-evaluator".into();
    assert!(recoverable(&attempt, &draft, "invented rubric").is_none());
    // Runtime changes are irrelevant once the existing text/pixels are sealed.
    assert!(
        compatible_open_batch(&attempt.evaluations, "invented rubric", "new-renderer").is_none()
    );
}

#[tokio::test]
async fn run_purpose_selects_policy_and_reused_votes_are_not_charged_twice() {
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
    sqlx::query("INSERT INTO run_plans(id,request_key,state,revision,created_at,updated_at,request_json) VALUES('run','invented-run','running',1,0,0,'{}')")
        .execute(&store.pool).await.unwrap();
    let (draft, mut attempt, open) = fixture();
    attempt.version_id = version.id;
    assert!(for_attempt(&store, &attempt).await.unwrap());
    let panel = replacement_panel(&open, vec![judge("haiku")]).unwrap();
    reseat(&mut attempt, &draft, &open, panel, &[]).unwrap();
    store.insert_attempt(&attempt).await.unwrap();
    let ledger = store.usage_ledger().await.unwrap();
    assert_eq!(ledger.len(), 1);
    assert_eq!(ledger[0].session_id, "paid-session");
    assert_eq!(ledger[0].cost_usd, Some(0.01));
    sqlx::query("UPDATE run_plans SET request_json='{\"workflowPolicy\":{}}' WHERE id='run'")
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(!for_attempt(&store, &attempt).await.unwrap());
    attempt.run_id = "unknown-run".into();
    assert!(for_attempt(&store, &attempt).await.is_err());
    dir.close().await;
}
