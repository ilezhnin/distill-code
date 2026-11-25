use super::*;

/// A prompt with a handful of screenshots is one text frame well past
/// tungstenite's default 16 MiB limit; the renderer's socket must deliver
/// it instead of closing.
#[tokio::test]
async fn the_renderer_socket_delivers_a_frame_past_the_default_limit() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let host = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket =
            tokio_tungstenite::accept_async_with_config(stream, Some(frontend_socket_config()))
                .await
                .unwrap();
        match socket.next().await {
            Some(Ok(WsMessage::Text(text))) => text.len(),
            other => panic!("the frame did not arrive: {other:?}"),
        }
    });
    let stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let (mut renderer, _) = tokio_tungstenite::client_async(format!("ws://{address}/"), stream)
        .await
        .unwrap();
    let prompt = "x".repeat(20 * 1024 * 1024);
    renderer
        .send(WsMessage::Text(prompt.clone().into()))
        .await
        .unwrap();
    assert_eq!(host.await.unwrap(), prompt.len());
}

#[test]
fn inventory_keeps_only_the_trusted_pre_spawn_refusal_retryable() {
    let message =
        "measured CPU load is above the light-job admission line; no provider process started";
    assert_eq!(
        inventory_start_error(&json!({"code": CLEAR_SANDBOX_REFUSAL, "message": message})),
        format!("resource_busy: {message}")
    );
    assert_eq!(
        inventory_start_error(&json!({"code": -32603, "message": message})),
        message
    );
    assert_eq!(
        inventory_start_error(
            &json!({"code": CLEAR_SANDBOX_REFUSAL, "message": "resource_busy: queued"})
        ),
        "resource_busy: queued"
    );
}

/// A transport or helper hiccup while staging requeues the test; only a
/// lease the helper refuses is a missing capability.
#[test]
fn a_staging_hiccup_waits_and_a_refused_lease_does_not() {
    for transient in [
        "Sandbox credential lease failed: bench-auth: FileExistsError",
        "timed out",
        "The system cannot find the file specified. (os error 2)",
    ] {
        assert!(
            stage_failure(transient).starts_with("resource_busy:"),
            "{transient}"
        );
    }
    for refused in [
        "Sandbox credential lease failed: bench-auth: a lease must never carry a refresh token",
        "Sandbox credential lease failed: bench-auth: invalid lease document",
        "Sandbox credential lease failed: bench-auth: unsafe credential directory",
        "Sandbox credential lease failed: bench-auth: PermissionError",
    ] {
        assert!(
            stage_failure(refused).starts_with("capability_missing:"),
            "{refused}"
        );
    }
}

/// A benchmark text session runs on its account's sandbox grant, like a
/// repository session, so a Windows sign-in that needs re-auth (b55a,
/// 2026-10-19) never refuses it; an ordinary profile stays on Windows.
#[test]
fn sandbox_sessions_take_their_account_status_from_the_sandbox() {
    assert!(sandbox_account_route(&text_execution::profile_key("owner")));
    assert!(sandbox_account_route("repository:invented"));
    assert!(!sandbox_account_route("native"));
    assert!(!sandbox_account_route(""));
}

#[test]
fn sandbox_location_never_grants_text_or_judge_tool_permissions() {
    let request = json!({"options":[
        {"kind":"allow_once","optionId":"allow"},
        {"kind":"reject_once","optionId":"deny"}
    ]});
    for profile in [None, Some(ExecutionProfile::NativeTextV1)] {
        assert!(owned_permission_answer(profile, "session/request_permission", &request).is_none());
        assert!(owned_permission_answer(profile, "fs/read_text_file", &request).is_none());
        assert!(owned_permission_answer(profile, "terminal/create", &request).is_none());
    }
    assert_eq!(
        owned_permission_answer(
            Some(ExecutionProfile::ProtectedRepositoryV1),
            "session/request_permission",
            &request
        )
        .unwrap()["outcome"]["optionId"],
        "allow"
    );
    assert!(owned_permission_answer(
        Some(ExecutionProfile::ProtectedRepositoryV1),
        "fs/read_text_file",
        &request
    )
    .is_none());
}

#[tokio::test]
async fn legacy_zai_highspeed_selection_becomes_base_model_and_fast_intent() {
    let mut snapshot = json!({"configOptions":[
        {"id":"model","category":"model","type":"select","currentValue":"zai-coding-plan/glm-5.3","options":[{"value":"zai-coding-plan/glm-5.3"}]},
        {"id":"fast","category":"model_config","type":"select","currentValue":"off","options":[{"value":"off"},{"value":"on"}]}
    ]});
    let mut answer = snapshot.clone();
    answer["configOptions"][1]["currentValue"] = json!("on");
    let wanted = Selection {
        model: Some("zai-coding-plan/glm-5.3-highspeed".into()),
        ..Default::default()
    };
    let substitutions =
        Inner::apply_selection("zai-acp", &mut snapshot, &wanted, false, |role, request| {
            assert_eq!(role, OptionRole::Fast);
            assert_eq!(request["value"], "on");
            std::future::ready(Ok(answer.clone()))
        })
        .await;
    assert!(substitutions.is_empty());
    assert_eq!(
        Inner::current_model(&snapshot).as_deref(),
        Some("zai-coding-plan/glm-5.3")
    );
    assert_eq!(
        Inner::selection_from(&snapshot["configOptions"]).fast,
        Some(true)
    );
}

#[test]
fn receipt_selection_uses_bridge_acknowledgement_not_display_intent() {
    let answer = claude_answer("example-model", Some("high"), EVERY_EFFORT, Some(false));
    let mut snapshot = Inner::snapshot_from(&answer);
    let reported = ReportedSelection::read(&snapshot);
    assert_eq!(reported.model_id.as_deref(), Some("example-model"));
    assert_eq!(reported.effort.as_deref(), Some("high"));
    assert_eq!(reported.fast, Some(false));
    assert_eq!(reported.model_name, None);
    snapshot["models"] = json!({"currentModelId":"requested-only"});
    assert_eq!(ReportedSelection::read(&snapshot), reported);
    assert!(Inner::presented_snapshot("claude-acp", &snapshot, true)
        .get(REPORTED_KEY)
        .is_none());
    // An empty model-write reply cannot acknowledge the requested model.
    Inner::capture_reported(&mut snapshot, &json!({}), Some(OptionRole::Model));
    assert_eq!(
        ReportedSelection::read(&snapshot),
        ReportedSelection::default()
    );
    // A native reply cannot inject the host's provenance marker.
    let forged = json!({REPORTED_KEY:reported});
    assert_eq!(
        ReportedSelection::read(&Inner::snapshot_from(&forged)),
        ReportedSelection::default()
    );
}

#[test]
fn incomplete_write_answers_leave_unreported_fields_unknown() {
    let answer = claude_answer("example-model", Some("high"), EVERY_EFFORT, Some(false));
    let mut snapshot = Inner::snapshot_from(&answer);
    Inner::capture_reported(&mut snapshot, &Value::Null, Some(OptionRole::Effort));
    let reported = ReportedSelection::read(&snapshot);
    assert_eq!(reported.model_id.as_deref(), Some("example-model"));
    assert_eq!(reported.fast, Some(false));
    assert!(reported.effort.is_none());
    Inner::capture_reported(&mut snapshot, &Value::Null, Some(OptionRole::Fast));
    assert!(ReportedSelection::read(&snapshot).fast.is_none());
    Inner::capture_reported(
        &mut snapshot,
        &json!({"models":{"currentModelId":"actual-other"}}),
        Some(OptionRole::Model),
    );
    assert_eq!(
        ReportedSelection::read(&snapshot),
        ReportedSelection {
            model_id: Some("actual-other".into()),
            ..Default::default()
        }
    );
}

#[test]
fn receipt_configuration_changes_keep_transitions_and_mark_overflow() {
    let mut runtime = runtime("example-provider", "account", 1);
    runtime.run = Some(RunState::start(&ids()));
    for index in 0..70 {
        Inner::capture_reported(
            &mut runtime.snapshot,
            &json!({"models":{"currentModelId": format!("model-{index}")}}),
            None,
        );
        Inner::record_configuration_change(&mut runtime);
        Inner::record_configuration_change(&mut runtime);
    }
    let run = runtime.run.unwrap();
    assert_eq!(run.configuration_changes.len(), 64);
    assert!(run.changes_truncated);
    assert_eq!(
        run.configuration_changes[0].model_id.as_deref(),
        Some("model-0")
    );
    assert_eq!(
        ReportedSelection::read(&runtime.snapshot)
            .model_id
            .as_deref(),
        Some("model-69")
    );
}

#[test]
fn benchmark_activity_generation_matches_provider_and_account_scope() {
    let mut generations = ActivityGenerations::default();
    generations.record("claude-acp", Some("a"));
    generations.record("codex-acp", Some("a"));
    generations.record("codex-acp", Some("a"));
    assert_eq!(generations.snapshot("claude-acp", "*"), 1);
    assert_eq!(generations.snapshot("claude-acp", "a"), 1);
    generations.record("claude-acp", Some("ab"));
    assert_eq!(generations.snapshot("claude-acp", "a"), 1);
    assert_eq!(generations.snapshot("claude-acp", "*"), 2);
    generations.record("claude-acp", None);
    assert_eq!(generations.snapshot("claude-acp", "*"), 3);
    assert_eq!(generations.snapshot("codex-acp", "*"), 2);
    assert_eq!(generations.snapshot("unknown", "*"), 0);
    assert!(!activity_scope_matches(
        "claude-acp\u{1f}ab",
        "claude-acp",
        "a"
    ));
}

#[test]
fn cli_login_activity_counts_chats_without_an_account() {
    let mut generations = ActivityGenerations::default();
    // A Grok chat runs without an account; a benchmark on the CLI sign-in.
    generations.record("grok-acp", None);
    generations.record("grok-acp", Some("cli-login-grok-acp"));
    assert_eq!(generations.snapshot("grok-acp", "cli-login-grok-acp"), 2);
    assert_eq!(generations.snapshot("grok-acp", "*"), 2);
    assert!(activity_scope_matches(
        "grok-acp",
        "grok-acp",
        "cli-login-grok-acp"
    ));
    // Another provider's identity, or a managed account, never borrows the
    // provider's account-less chats.
    assert!(!activity_scope_matches(
        "grok-acp",
        "grok-acp",
        "cli-login-kimi-acp"
    ));
    assert!(!activity_scope_matches("claude-acp", "claude-acp", "a"));
}

/// The idle reaper, a sign-in replacement and a credential change take a
/// bridge out of the map before it exits; its exit still ends the route
/// and drops what the host kept for it, unless a replacement serves it.
#[test]
fn a_bridge_the_host_stopped_ends_its_route_when_it_exits() {
    assert!(Inner::exit_ends_route(None, 3));
    assert!(Inner::exit_ends_route(Some(3), 3));
    assert!(!Inner::exit_ends_route(Some(4), 3));
}

#[test]
fn a_stopped_owned_grok_bridge_leaves_no_sign_in_copy() {
    let root = tempfile::tempdir().unwrap();
    let runtime = owned_runtime_root(root.path());
    let copy = |harness: &str| runtime.join(harness).join("home").join("auth.json");
    for harness in ["grok-acp", "codex-acp"] {
        std::fs::create_dir_all(copy(harness).parent().unwrap()).unwrap();
        std::fs::write(copy(harness), "{}").unwrap();
    }
    // A chat route is the user's own Grok; nothing there is the host's.
    discard_route_sign_in(&runtime, "grok-acp").unwrap();
    discard_route_sign_in(&runtime, "codex-acp\u{1f}a\u{1f}benchmark:p").unwrap();
    assert!(copy("grok-acp").exists());
    assert!(copy("codex-acp").exists());
    discard_route_sign_in(
        &runtime,
        "grok-acp\u{1f}cli-login-grok-acp\u{1f}benchmark:p",
    )
    .unwrap();
    assert!(!copy("grok-acp").exists());
    // Already gone is fine.
    discard_route_sign_in(
        &runtime,
        "grok-acp\u{1f}cli-login-grok-acp\u{1f}benchmark:p",
    )
    .unwrap();
}

#[test]
fn terminal_error_kind_names_execution_violation() {
    assert_eq!(
        terminal_error_kind(
            "execution_violation: native execution violated the declared no-tool policy"
        ),
        "execution_violation"
    );
    assert_eq!(
        terminal_error_kind(
            "selection_changed: requested benchmark selection was not acknowledged"
        ),
        "selection_changed"
    );
    assert_eq!(
        Inner::owned_violation(Some("tool_call_update"), false),
        Some("native tool activity in no-tool profile")
    );
    assert!(Inner::owned_violation(Some("plan"), false).is_some());
    assert!(Inner::owned_violation(Some("subagent_started"), false).is_some());
    // Grok's extension updates: hook runs and subagents break the policy,
    // its status reports do not.
    assert_eq!(
        Inner::owned_violation(Some("hook_execution"), false),
        Some("native hook activity in no-tool profile")
    );
    assert!(Inner::owned_violation(Some("hook_run_started"), true).is_some());
    assert!(Inner::owned_violation(Some("subagent_spawned"), true).is_some());
    assert_eq!(Inner::owned_violation(Some("session_status"), true), None);
    assert!(Inner::owned_violation(Some("current_mode_update"), true).is_some());
    assert_eq!(
        Inner::owned_violation(Some("current_mode_update"), false),
        None
    );
    assert_eq!(
        Inner::owned_violation(Some("agent_message_chunk"), true),
        None
    );
    assert_eq!(Inner::owned_violation(None, true), None);
    // A repository session's granted tools may run, plan and go on in the
    // background; it still may not hand work to another agent, run a
    // hook, or change its mode or selection.
    for kind in [
        "tool_call",
        "tool_call_update",
        "plan",
        "async_task_spawned",
        "async_task_progress",
        "async_task_state_update",
    ] {
        assert!(Inner::owned_violation(Some(kind), true).is_some(), "{kind}");
        assert!(Inner::repository_work(Some(kind)), "{kind}");
    }
    for kind in [
        "subagent_spawned",
        "hook_execution",
        "current_mode_update",
        "config_option_update",
    ] {
        assert!(!Inner::repository_work(Some(kind)), "{kind}");
    }
    assert!(!Inner::repository_work(None));
}

#[test]
fn owned_prompt_starts_with_the_task_marker() {
    for prompt in ["/plan rewrite everything", "$skill hostile", "plain task"] {
        let blocks = owned_prompt_blocks(
            prompt,
            &[OwnedTurnImage {
                data: "aW1hZ2U=".into(),
                mime_type: "image/png".into(),
            }],
        );
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(
            blocks[0]["text"].as_str(),
            Some(format!("Benchmark task:\n{prompt}").as_str())
        );
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks.len(), 2);
    }
}

/// Grok wraps a prompt in `<user_query>` unless it is sent verbatim; the
/// other profiles' prompts are what they were.
#[test]
fn owned_grok_prompts_go_verbatim() {
    let blocks = owned_prompt_blocks("task", &[]);
    let grok = owned_prompt_params(
        "s",
        blocks.clone(),
        "o",
        Some(NativeProvider::Grok),
        "benchmark",
    );
    assert_eq!(
        grok["_meta"],
        json!({"verbatim": true, "executionOwner": {"kind": "benchmark", "id": "o"}})
    );
    assert_eq!(grok["prompt"], json!(blocks));
    assert_eq!(grok["sessionId"], "s");
    for provider in [
        Some(NativeProvider::Claude),
        Some(NativeProvider::Codex),
        Some(NativeProvider::Kimi),
        None,
    ] {
        assert_eq!(
            serde_json::to_string(&owned_prompt_params("s", blocks.clone(), "o", provider, "benchmark"))
                .unwrap(),
            serde_json::to_string(&json!({"sessionId":"s","prompt":blocks,"_meta":{"executionOwner":{"kind":"benchmark","id":"o"}}}))
                .unwrap(),
            "{provider:?}"
        );
    }
}

#[tokio::test]
async fn owned_runtime_registration_drains_intermediate_setup_notifications() {
    let sessions = Arc::new(Mutex::new(SessionTable::default()));
    let routed = Arc::new(StdMutex::new(Vec::new()));
    let (events, mut received) = mpsc::unbounded_channel();
    let receiver_sessions = sessions.clone();
    let receiver_routed = routed.clone();
    let mut final_runtime = runtime("claude-acp", "native-owned", 71);
    final_runtime.account_id = Some("a".into());
    final_runtime.execution_profile = Some("text".into());
    final_runtime.snapshot = json!({"configOptions":[{"id":"effort","currentValue":"high"}]});
    let route = final_runtime.route_key();
    let worker = tokio::spawn(async move {
        while let Some(event) = received.recv().await {
            match event {
                BridgeEvent::Notification {
                    harness,
                    generation,
                    params,
                    ..
                } => {
                    let table = receiver_sessions.lock().await;
                    let target = table.host_session_for_generation(
                        &harness,
                        generation,
                        params["sessionId"].as_str().unwrap(),
                    );
                    receiver_routed
                        .lock()
                        .unwrap()
                        .push((params["update"]["stage"].clone(), target.is_some()));
                }
                BridgeEvent::Drained { ack } => {
                    let _ = ack.send(Ok(()));
                }
                _ => unreachable!(),
            }
        }
    });
    let notification = |stage: &str| BridgeEvent::Notification {
        harness: route.clone(),
        generation: 71,
        run_id: None,
        method: "session/update".into(),
        params: json!({"sessionId":"native-owned","update":{"sessionUpdate":"config_option_update","stage":stage}}),
    };
    events.send(notification("default effort")).unwrap();
    events.send(notification("selected effort")).unwrap();
    install_owned_runtime(&events, &sessions, "owned".into(), final_runtime)
        .await
        .unwrap();
    events.send(notification("later selection change")).unwrap();
    drain_queued_bridge_events(&events).await.unwrap();
    assert_eq!(
        *routed.lock().unwrap(),
        vec![
            (json!("default effort"), false),
            (json!("selected effort"), false),
            (json!("later selection change"), true),
        ]
    );
    assert_eq!(
        sessions.lock().await.get("owned").unwrap().snapshot["configOptions"][0]["currentValue"],
        "high"
    );
    drop(events);
    worker.await.unwrap();
}

#[tokio::test]
async fn owned_runtime_is_not_registered_when_setup_barrier_fails() {
    let (events, received) = mpsc::unbounded_channel();
    drop(received);
    let sessions = Mutex::new(SessionTable::default());
    assert!(install_owned_runtime(
        &events,
        &sessions,
        "owned".into(),
        runtime("claude-acp", "s", 1)
    )
    .await
    .is_err());
    assert!(sessions.lock().await.get("owned").is_none());
}

#[tokio::test]
async fn failed_history_batch_retains_the_uncommitted_suffix_for_retry() {
    let dir = crate::test_support::TempRoot::new();
    let path = dir.path().join("host.db");
    let store = SessionStore::open(&path).await.unwrap();
    dir.register(&store.pool);
    for id in ["a", "b"] {
        let record: SessionRecord = serde_json::from_value(json!({
            "id": id, "harness": "goose", "cwd": "C:\\work", "user_set_name": false,
            "hidden": false, "created_at": now_iso(), "updated_at": now_iso(), "message_count": 0
        }))
        .unwrap();
        store.insert_session(&record).await.unwrap();
    }
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    dir.register(&pool);
    sqlx::query("CREATE TRIGGER fail_append BEFORE INSERT ON session_events WHEN NEW.session_id = 'b' BEGIN SELECT RAISE(FAIL, 'simulated full disk'); END")
        .execute(&pool).await.unwrap();
    let mut pending = vec![
        ("a".into(), json!({"n":1})),
        ("b".into(), json!({"n":2})),
        ("a".into(), json!({"n":3})),
    ];
    assert!(
        Inner::persist_pending_events(&store, &mut pending, |_, _| {})
            .await
            .is_err()
    );
    assert_eq!(pending.len(), 2);
    assert_eq!(store.list_events("a").await.unwrap(), vec![json!({"n":1})]);
    assert!(store.list_events("b").await.unwrap().is_empty());
    sqlx::query("DROP TRIGGER fail_append")
        .execute(&pool)
        .await
        .unwrap();
    Inner::persist_pending_events(&store, &mut pending, |_, _| {})
        .await
        .unwrap();
    assert!(pending.is_empty());
    assert_eq!(
        store.list_events("a").await.unwrap(),
        vec![json!({"n":1}), json!({"n":3})]
    );
    assert_eq!(store.list_events("b").await.unwrap(), vec![json!({"n":2})]);
    dir.close().await;
}

#[tokio::test]
async fn owned_extension_stays_evidence_only_through_run_stamp_and_flush() {
    let dir = crate::test_support::TempRoot::new();
    let store = SessionStore::open(&dir.path().join("host.db"))
        .await
        .unwrap();
    dir.register(&store.pool);
    let record: SessionRecord = serde_json::from_value(json!({
        "id": "invented-owned", "harness": "grok-acp", "cwd": "C:\\invented",
        "user_set_name": false, "hidden": true, "created_at": now_iso(),
        "updated_at": now_iso(), "message_count": 0
    }))
    .unwrap();
    store.insert_session(&record).await.unwrap();
    let mut summary = json!({"sessionId": record.id, "update": {
        "sessionUpdate": "session_summary_generated", "session_summary": "Invented summary",
        "_meta": {"executionOwner": {"kind": "benchmark", "id": "invented-owner"},
            "distill": {"runId": "stale-provider-id", "created": "stale-provider-time"}}
    }});
    // stage_notification classifies the provider extension, then uses
    // this shared stamping path before the ordinary batch flush.
    assert!(Inner::is_xai_session_extension(
        "_x.ai/session_notification"
    ));
    Inner::mark_evidence_only(&mut summary);
    let mut run = RunState::start(&ids());
    Inner::stamp_staged_update(&mut summary, &mut run, "2026-09-11T00:00:00.000Z", true);
    let mut chunk = json!({"sessionId": record.id, "update": {
        "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Invented answer"},
        "_meta": {"distill": {"evidenceOnly": true, "runId": "provider-forged-id"}}
    }});
    Inner::stamp_staged_update(&mut chunk, &mut run, "2026-09-11T00:00:01.000Z", false);
    let mut pending = vec![(record.id.clone(), summary), (record.id.clone(), chunk)];
    let mut visible = Vec::new();
    Inner::persist_pending_events(&store, &mut pending, |payload, id| {
        if let Some(payload) = Inner::frontend_event(payload, id) {
            visible.push(payload);
        }
    })
    .await
    .unwrap();
    assert!(pending.is_empty());
    let saved = store.list_events(&record.id).await.unwrap();
    assert_eq!(
        saved.len(),
        2,
        "the private extension remains durable evidence"
    );
    assert_eq!(saved[0]["update"]["session_summary"], "Invented summary");
    assert_eq!(
        saved[0]["update"]["_meta"]["executionOwner"]["id"],
        "invented-owner"
    );
    assert_eq!(saved[0]["update"]["_meta"]["distill"]["runId"], "run-1");
    assert_eq!(
        saved[0]["update"]["_meta"]["distill"]["created"],
        "2026-09-11T00:00:00.000Z"
    );
    assert!(Inner::evidence_only(&saved[0]));
    assert_eq!(
        visible.len(),
        1,
        "only standard ACP updates reach the renderer"
    );
    assert_eq!(visible[0]["update"]["sessionUpdate"], "agent_message_chunk");
    assert!(visible[0]["update"]["_meta"]["distill"]["eventId"]
        .as_i64()
        .is_some());
    let (replay, _) = store.replay_payloads(&record.id).await.unwrap();
    assert_eq!(replay.len(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&replay[0]).unwrap()["update"]["sessionUpdate"],
        "agent_message_chunk"
    );
    dir.close().await;
}

fn ids() -> TurnIds {
    TurnIds {
        run_id: "run-1".to_string(),
        message_id: "user-1".to_string(),
        assistant_message_id: "reply-1".to_string(),
        owned_deadline: None,
        allow_credits: true,
    }
}

#[test]
fn a_prompt_runs_under_the_message_id_the_renderer_named() {
    let mut params = json!({
        "sessionId": "s1",
        "prompt": [],
        "_meta": { "messageId": "renderer-m1", "personaId": "p1" }
    });
    let ids = TurnIds::for_prompt(&mut params);
    assert_eq!(ids.message_id, "renderer-m1");
    // The name was for the host; the bridge sees the rest of the meta.
    assert!(params["_meta"].get("messageId").is_none());
    assert_eq!(params["_meta"]["personaId"], "p1");
    assert_ne!(ids.assistant_message_id, ids.message_id);

    // No name, a blank one, or one too long to be an id: the host's own.
    let mut unnamed = json!({ "sessionId": "s1", "prompt": [] });
    assert!(!TurnIds::for_prompt(&mut unnamed).message_id.is_empty());
    let mut blank = json!({ "_meta": { "messageId": "   " } });
    assert!(!TurnIds::for_prompt(&mut blank).message_id.trim().is_empty());
    let mut long = json!({ "_meta": { "messageId": "x".repeat(129) } });
    assert_ne!(TurnIds::for_prompt(&mut long).message_id, "x".repeat(129));
}

#[test]
fn xai_turn_completed_becomes_message_usage() {
    let mut params = json!({
        "sessionId": "s1",
        "update": {
            "sessionUpdate": "turn_completed",
            "stop_reason": "end_turn",
            "usage": {
                "inputTokens": 17042,
                "outputTokens": 168,
                "totalTokens": 17210,
                "cachedReadTokens": 2944,
                "cacheCreationTokens": 0,
                "reasoningTokens": 159,
                "modelCalls": 1,
                "apiDurationMs": 3899,
                "costUsdTicks": 104_298_400u64
            }
        }
    });
    assert!(Inner::normalize_xai_turn_usage(
        "_x.ai/session/update",
        &mut params
    ));
    let usage = &params["update"]["usage"];
    assert_eq!(params["update"]["sessionUpdate"], "message_usage");
    assert_eq!(params["sessionId"], "s1");
    assert_eq!(usage["inputTokens"], 14098);
    assert_eq!(usage["outputTokens"], 168);
    assert_eq!(usage["cacheReadTokens"], 2944);
    assert_eq!(usage["cacheWriteTokens"], 0);
    assert_eq!(usage["elapsedMs"], 3899);
    assert!(usage.get("cost").is_none());
    // The raw usage is kept whole for benchmarks.
    let raw = &params["update"]["_meta"]["xaiTurnUsage"];
    assert_eq!(raw["costUsdTicks"], 104_298_400u64);
    assert_eq!(raw["reasoningTokens"], 159);
    assert_eq!(raw["modelCalls"], 1);
    assert_eq!(raw["inputTokens"], 17042);
}

/// Grok 1.0.40 reports the turn on `_x.ai/session_notification` (seen in
/// the policy probe), not on `_x.ai/session/update`.
#[test]
fn grok_turn_completed_notification_becomes_message_usage() {
    let mut params = json!({
        "sessionId": "s1",
        "update": {
            "sessionUpdate": "turn_completed",
            "prompt_id": "p",
            "stop_reason": "end_turn",
            "usage": {
                "inputTokens": 10,
                "outputTokens": 5,
                "totalTokens": 15,
                "cachedReadTokens": 2,
                "cacheCreationTokens": 0,
                "reasoningTokens": 1,
                "modelCalls": 1,
                "apiDurationMs": 8
            }
        }
    });
    assert!(Inner::normalize_xai_turn_usage(
        "_x.ai/session_notification",
        &mut params
    ));
    assert_eq!(params["update"]["sessionUpdate"], "message_usage");
    assert_eq!(params["update"]["usage"]["inputTokens"], 8);
    assert_eq!(params["update"]["usage"]["cacheReadTokens"], 2);
    assert_eq!(
        params["update"]["_meta"]["xaiTurnUsage"]["reasoningTokens"],
        1
    );
    // Its other session events stay grok's own.
    let mut retry = json!({
        "sessionId": "s1",
        "update": { "sessionUpdate": "retry_state", "attempt": 1 }
    });
    assert!(!Inner::normalize_xai_turn_usage(
        "_x.ai/session_notification",
        &mut retry
    ));
    assert_eq!(retry["update"]["sessionUpdate"], "retry_state");
    // Both channels are kept as evidence of an owned session.
    assert!(Inner::is_xai_session_extension(
        "_x.ai/session_notification"
    ));
    assert!(Inner::is_xai_session_extension("_x.ai/session/update"));
    assert!(!Inner::is_xai_session_extension("_x.ai/sessions/changed"));
    // Kept as evidence, never sent to the renderer, whose ACP client
    // rejects such updates.
    let mut summary = json!({"sessionId": "s1", "update": {
        "sessionUpdate": "session_summary_generated", "session_summary": "t"}});
    assert!(!Inner::evidence_only(&summary));
    Inner::mark_evidence_only(&mut summary);
    assert!(Inner::evidence_only(&summary));
    assert_eq!(summary["update"]["session_summary"], "t");
    assert!(!Inner::evidence_only(&retry));
}

#[test]
fn a_close_counts_chats_and_benchmark_turns_apart() {
    let runtime = |owned: bool, loading: bool| SessionRuntime {
        harness: "invented-acp".into(),
        account_id: None,
        execution_profile: owned.then(|| "native-text-v1".into()),
        bridge_session_id: "invented-bridge-session".into(),
        generation: 1,
        loading,
        run: None,
        background: Default::default(),
        context: Default::default(),
        steer_queue: VecDeque::new(),
        native_steers: Vec::new(),
        snapshot: json!({}),
        has_model_option: false,
        substitutions: Vec::new(),
        last_active: std::time::Instant::now(),
    };
    let sessions = [
        runtime(false, false),
        runtime(true, true),
        runtime(true, true),
        runtime(true, false),
    ];
    // Only benchmark turns: the close pauses the runs and says how many
    // still finish, instead of refusing before anything for a chat.
    assert_eq!(active_turns(sessions.iter()), (0, 2));
    let busy_chat = [runtime(false, true), runtime(true, true)];
    assert_eq!(active_turns(busy_chat.iter()), (1, 1));
}

#[test]
fn other_xai_updates_and_standard_methods_pass_through_unclaimed() {
    let mut hook = json!({
        "sessionId": "s1",
        "update": { "sessionUpdate": "hook_execution", "event_name": "session_start" }
    });
    assert!(!Inner::normalize_xai_turn_usage(
        "_x.ai/session/update",
        &mut hook
    ));
    assert_eq!(hook["update"]["sessionUpdate"], "hook_execution");

    let mut standard = json!({
        "sessionId": "s1",
        "update": { "sessionUpdate": "turn_completed", "usage": { "inputTokens": 5 } }
    });
    assert!(!Inner::normalize_xai_turn_usage(
        "session/update",
        &mut standard
    ));
    assert_eq!(standard["update"]["sessionUpdate"], "turn_completed");
}

#[test]
fn a_steered_prompt_is_recorded_as_a_steer_under_its_acknowledged_ids() {
    let prompt = json!([
        { "type": "text", "text": "skill", "annotations": { "audience": ["assistant"] } },
        { "type": "text", "text": "also check the tests" }
    ]);
    let events = Inner::user_prompt_events(
        "s1",
        &prompt,
        &json!({ "personaId": "p1" }),
        &ids(),
        "2026-09-11T00:00:00.000Z",
        true,
    );
    assert_eq!(events.len(), 2);
    for event in &events {
        assert_eq!(event["sessionId"], "s1");
        assert_eq!(event["update"]["sessionUpdate"], "user_message_chunk");
        let distill = &event["update"]["_meta"]["distill"];
        assert_eq!(distill["messageId"], "user-1");
        assert_eq!(distill["runId"], "run-1");
        assert_eq!(distill["steer"], true);
        assert_eq!(distill["personaId"], "p1");
    }
    assert_eq!(
        events[1]["update"]["content"]["text"],
        "also check the tests"
    );
}

fn said(kind: &str, message_id: &str, content: Value) -> Value {
    json!({
        "sessionId": "s1",
        "update": {
            "sessionUpdate": kind,
            "content": content,
            "_meta": { "distill": { "messageId": message_id } },
        }
    })
}

fn carried_text(events: &[Value]) -> String {
    let block = Inner::carryover_block(events).expect("a transcript");
    assert_eq!(block["annotations"]["audience"], json!(["assistant"]));
    block["text"].as_str().expect("text").to_string()
}

#[test]
fn a_chat_that_changes_agents_takes_what_was_said_and_nothing_else() {
    let events = vec![
        said(
            "user_message_chunk",
            "m1",
            json!({ "type": "text", "text": "persona", "annotations": { "audience": ["assistant"] } }),
        ),
        said(
            "user_message_chunk",
            "m1",
            json!({ "type": "text", "text": "rename the crate" }),
        ),
        said(
            "agent_thought_chunk",
            "m1",
            json!({ "type": "text", "text": "hmm" }),
        ),
        said(
            "agent_message_chunk",
            "m1",
            json!({ "type": "text", "text": "Renam" }),
        ),
        said(
            "agent_message_chunk",
            "m1",
            json!({ "type": "text", "text": "ing." }),
        ),
        json!({ "sessionId": "s1", "update": {
            "sessionUpdate": "tool_call", "title": "Edit Cargo.toml", "toolCallId": "t1",
            "_meta": { "distill": { "messageId": "m1" } },
        }}),
        said(
            "agent_message_chunk",
            "m1",
            json!({ "type": "text", "text": "Done." }),
        ),
        said(
            "user_message_chunk",
            "m2",
            json!({ "type": "text", "text": "and the tests?" }),
        ),
        said(
            "user_message_chunk",
            "m3",
            json!({ "type": "text", "text": "hello?" }),
        ),
    ];
    let messages = Inner::carryover_messages(&events);
    assert_eq!(
        messages,
        vec![
            (true, "rename the crate".to_string()),
            (
                false,
                "Renaming.\n[ran a tool: Edit Cargo.toml]\nDone.".to_string()
            ),
            // Two prompts in a row are two messages, not one.
            (true, "and the tests?".to_string()),
            (true, "hello?".to_string()),
        ]
    );
    let text = carried_text(&events);
    assert!(text.starts_with(CARRYOVER_OPENING));
    assert!(!text.contains("persona"));
    assert!(!text.contains("hmm"));
    assert!(text.contains("## User\n\nrename the crate\n\n## Previous agent\n\nRenaming."));
    assert!(!text.contains("left out"));
}

#[test]
fn a_chat_in_which_nothing_was_said_has_nothing_to_hand_over() {
    let events = vec![said(
        "user_message_chunk",
        "m1",
        json!({ "type": "text", "text": "skill", "annotations": { "audience": ["assistant"] } }),
    )];
    assert_eq!(Inner::carryover_block(&events), None);
}

#[test]
fn a_long_conversation_hands_over_its_newest_messages_and_says_what_it_left_out() {
    let long = "й".repeat(CARRYOVER_MESSAGE_CHARS * 2);
    let shortened = Inner::shortened(&long, CARRYOVER_MESSAGE_CHARS);
    assert!(shortened.contains(&format!("{CARRYOVER_MESSAGE_CHARS} characters left out")));
    assert_eq!(
        shortened.chars().filter(|letter| *letter == 'й').count(),
        CARRYOVER_MESSAGE_CHARS
    );

    let turns = CARRYOVER_BUDGET_CHARS / CARRYOVER_MESSAGE_CHARS + 5;
    let events: Vec<Value> = (0..turns)
        .map(|turn| {
            said(
                "user_message_chunk",
                &format!("m{turn}"),
                json!({ "type": "text", "text": format!("turn {turn} {long}") }),
            )
        })
        .collect();
    let text = carried_text(&events);
    assert!(text.contains(&format!("turn {} ", turns - 1)));
    assert!(!text.contains("turn 0 "));
    assert!(text.contains("earlier message(s) left out"));
    assert!(text.chars().count() < CARRYOVER_BUDGET_CHARS + CARRYOVER_MESSAGE_CHARS);
}

#[test]
fn an_earlier_hand_over_a_bridge_echoed_back_is_not_handed_over_again() {
    let echoed = carried_text(&[said(
        "user_message_chunk",
        "m1",
        json!({ "type": "text", "text": "first" }),
    )]);
    let events = vec![
        said(
            "user_message_chunk",
            "m1",
            json!({ "type": "text", "text": "first" }),
        ),
        said(
            "user_message_chunk",
            "m2",
            json!({ "type": "text", "text": echoed }),
        ),
        said(
            "user_message_chunk",
            "m2",
            json!({ "type": "text", "text": "second" }),
        ),
    ];
    assert_eq!(
        Inner::carryover_messages(&events),
        vec![(true, "first".to_string()), (true, "second".to_string())]
    );
}

#[test]
fn the_transcript_goes_ahead_of_what_the_user_just_sent() {
    let block = json!({ "type": "text", "text": "history" });
    let prompt = json!([{ "type": "text", "text": "go on" }]);
    assert_eq!(
        Inner::prompt_after(&block, &prompt),
        json!([{ "type": "text", "text": "history" }, { "type": "text", "text": "go on" }])
    );
}

#[test]
fn an_ordinary_prompt_is_not_marked_as_a_steer() {
    let events = Inner::user_prompt_events(
        "s1",
        &json!([{ "type": "text", "text": "hi" }]),
        &json!({}),
        &ids(),
        "2026-09-11T00:00:00.000Z",
        false,
    );
    assert_eq!(events.len(), 1);
    assert!(events[0]["update"]["_meta"]["distill"]
        .get("steer")
        .is_none());
}

#[test]
fn agent_updates_of_a_turn_name_the_reply_apart_from_the_prompt() {
    let mut run = RunState::start(&ids());
    let mut chunk = json!({
        "sessionId": "bridge-1",
        "update": {
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "hello" },
            "_meta": { "claudeCode": { "parentToolUseId": null } },
        }
    });
    Inner::stamp_run_update(&mut chunk, &mut run, "2026-09-11T00:00:00.000Z");
    let meta = &chunk["update"]["_meta"];
    assert_eq!(meta["distill"]["messageId"], "user-1");
    assert_eq!(meta["distill"]["assistantMessageId"], "reply-1");
    assert_eq!(meta["distill"]["runId"], "run-1");
    assert!(meta.get("claudeCode").is_some());
    assert!(run.saw_agent_message);
    assert_eq!(run.agent_text, "hello");

    let mut tool = json!({
        "update": { "sessionUpdate": "tool_call", "toolCallId": "t1" }
    });
    Inner::stamp_run_update(&mut tool, &mut run, "2026-09-11T00:00:00.000Z");
    assert_eq!(
        tool["update"]["_meta"]["distill"]["assistantMessageId"],
        "reply-1"
    );
}

#[test]
fn a_user_chunk_of_a_turn_keeps_only_the_prompt_id() {
    let mut run = RunState::start(&ids());
    let mut echo = json!({
        "update": {
            "sessionUpdate": "user_message_chunk",
            "content": { "type": "text", "text": "hi" },
        }
    });
    Inner::stamp_run_update(&mut echo, &mut run, "2026-09-11T00:00:00.000Z");
    let distill = &echo["update"]["_meta"]["distill"];
    assert_eq!(distill["messageId"], "user-1");
    assert!(distill.get("assistantMessageId").is_none());
    assert!(!run.saw_agent_message);
}

#[test]
fn a_restated_command_list_is_not_a_transcript_event() {
    assert!(Inner::is_command_list_update(&json!({
        "sessionId": "bridge-1",
        "update": { "sessionUpdate": "available_commands_update", "availableCommands": [] },
    })));
    assert!(!Inner::is_command_list_update(&json!({
        "update": {
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "available_commands_update" },
        }
    })));
    assert!(!Inner::is_command_list_update(&json!({})));
}

fn air_failure(category: &str, actions: Value) -> Value {
    json!({"jetbrains":{"air":{"version":1,"sessionFailure":{
        "id":"turn-1:error", "revision":1, "category":category,
        "severity":"error", "title":"Provider condition", "actions":actions
    }}}})
}

#[test]
fn negotiated_terminal_failure_is_an_error_and_only_quota_policy_can_rotate() {
    let quota = Inner::prompt_response(Ok(
        json!({"stopReason":"end_turn","_meta":air_failure("limit",json!([]))}),
    ))
    .unwrap_err();
    assert!(crate::services::provider_account_status::is_quota_error(
        &quota
    ));
    assert_eq!(quota["data"]["sessionFailure"]["id"], "turn-1:error");
    for (category, actions) in [
        ("limit", json!(["retry"])),
        ("limit", json!(["new_session"])),
        ("service", json!(["retry"])),
    ] {
        let error = Inner::prompt_response(Ok(
            json!({"stopReason":"end_turn","_meta":air_failure(category,actions)}),
        ))
        .unwrap_err();
        assert!(!crate::services::provider_account_status::is_quota_error(
            &error
        ));
    }
    let mut warning = air_failure("limit", json!([]));
    warning["jetbrains"]["air"]["sessionFailure"]["severity"] = json!("warning");
    assert!(Inner::prompt_response(Ok(json!({"stopReason":"end_turn","_meta":warning}))).is_ok());
    assert!(Inner::prompt_response(Ok(json!({"stopReason":"end_turn"}))).is_ok());
}

#[test]
fn failure_metadata_and_zero_usage_do_not_turn_a_rejection_into_model_activity() {
    let metadata = json!({"update":{"sessionUpdate":"session_info_update","_meta":air_failure("limit",json!([]))}});
    assert!(Inner::is_failure_state_update(&metadata));
    let zero_usage = json!({"update":{"sessionUpdate":"usage_update","used":0,"size":200000,"cost":{"amount":0,"currency":"USD"}}});
    assert!(Inner::is_zero_usage_update(&zero_usage));
    for kind in [
        "user_message_chunk",
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "plan",
    ] {
        let mut substantive = json!({"update":{"sessionUpdate":kind,"content":{"type":"text","text":"usage limit"},"_meta":air_failure("limit",json!([]))}});
        assert!(!Inner::is_failure_state_update(&substantive));
        assert!(!Inner::is_zero_usage_update(&substantive));
        let mut run = RunState::start(&ids());
        Inner::stamp_run_update(&mut substantive, &mut run, "2026-09-28T00:00:00Z");
        assert!(run.saw_update, "{kind} must prevent automatic replay");
    }
    let mut positive = zero_usage.clone();
    positive["update"]["used"] = json!(1);
    assert!(!Inner::is_zero_usage_update(&positive));
    positive["update"]["used"] = json!(0);
    positive["update"]["cost"]["amount"] = json!(0.01);
    assert!(!Inner::is_zero_usage_update(&positive));
    let mut with_content = metadata;
    with_content["update"]["content"] = json!({"type":"text","text":"actual content"});
    assert!(!Inner::is_failure_state_update(&with_content));
}

#[test]
fn codex_thread_status_is_provider_state_not_the_turn_starting() {
    // What codex-acp sends at the start of every turn, before the model
    // says anything, and when the provider then refuses it.
    for status in ["active", "systemError", "idle"] {
        let update = json!({"sessionId":"bridge-1","update":{
            "sessionUpdate":"session_info_update",
            "_meta":{"codex":{"threadStatus":{"type":status,"activeFlags":[]}}}
        }});
        assert!(Inner::is_thread_status_update(&update), "{status}");
    }
    // A title, any other provider field, or another update kind is
    // substantive and keeps the turn's ordinary bookkeeping.
    let mut titled = json!({"update":{"sessionUpdate":"session_info_update","title":"Plan",
        "_meta":{"codex":{"threadStatus":{"type":"active"}}}}});
    assert!(!Inner::is_thread_status_update(&titled));
    titled["update"].as_object_mut().unwrap().remove("title");
    titled["update"]["_meta"]["codex"]["tokenUsage"] = json!({"total":1});
    assert!(!Inner::is_thread_status_update(&titled));
    assert!(!Inner::is_thread_status_update(&json!({"update":{
        "sessionUpdate":"session_info_update","_meta":{"codex":{}}}})));
    assert!(!Inner::is_thread_status_update(&json!({"update":{
        "sessionUpdate":"session_info_update","_meta":{"codex":{"threadStatus":{}},"other":1}}})));
    assert!(!Inner::is_thread_status_update(&json!({"update":{
        "sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"},
        "_meta":{"codex":{"threadStatus":{"type":"active"}}}}})));
}

#[test]
fn a_rate_limited_refusal_before_the_turn_waits_in_the_queue() {
    // Codex's words after it gave up retrying a 429, withdrawn by the host.
    let refused = json!({"code":-32603,"message":"exceeded retry limit, last status: 429 Too Many Requests",
        "data":{"accountId":"account-a","dispatchStarted":false,"promptNotAccepted":true}});
    let wait = Inner::rate_limit_wait(&refused).expect("a wait");
    assert_eq!(wait["code"], -32011);
    assert_eq!(wait["data"]["kind"], "provider_rate_limit_wait");
    assert_eq!(wait["data"]["accountId"], "account-a");
    assert_eq!(wait["data"]["promptNotAccepted"], true);
    assert_eq!(wait["data"]["dispatchStarted"], false);
    assert_eq!(
        wait["data"]["refused"],
        "exceeded retry limit, last status: 429 Too Many Requests"
    );
    // Not for a quota rejection: it has its own wait.
    let mut quota = refused.clone();
    quota["message"] = json!("You've hit your usage limit.");
    assert!(Inner::rate_limit_wait(&quota).is_none());
    // Not once the turn began, nor while the chat still holds the prompt.
    let mut started = refused.clone();
    started["data"]["dispatchStarted"] = json!(true);
    assert!(Inner::rate_limit_wait(&started).is_none());
    let mut kept = refused.clone();
    kept["data"]["promptNotAccepted"] = json!(false);
    assert!(Inner::rate_limit_wait(&kept).is_none());
    // Any other refusal fails as before.
    let mut other = refused;
    other["message"] = json!("Internal error: overloaded");
    assert!(Inner::rate_limit_wait(&other).is_none());
}

#[test]
fn manual_routing_parks_a_quota_rejection_only_after_proven_prompt_rollback() {
    let rejected = json!({"code":-32603,"data":{
        "errorKind":"quota_exhausted", "accountId":"saved-account",
        "dispatchStarted":false, "promptNotAccepted":true,
    }});
    let wait = Inner::rejected_quota_wait(&rejected, None).unwrap();
    assert_eq!(wait["code"], -32010);
    assert_eq!(wait["data"]["type"], "account_quota_wait");
    assert_eq!(wait["data"]["accountId"], "saved-account");
    assert_eq!(wait["data"]["promptNotAccepted"], true);
    let known_wait = Inner::quota_wait_error(
        "saved-account",
        Some(1900000000000),
        true,
        &std::collections::HashSet::new(),
    );
    assert_eq!(
        Inner::rejected_quota_wait(&rejected, Some(known_wait.clone())),
        Some(known_wait)
    );
    let mut partial = rejected.clone();
    partial["data"]["dispatchStarted"] = json!(true);
    assert!(Inner::rejected_quota_wait(&partial, None).is_none());
    partial = rejected.clone();
    partial["data"]["promptNotAccepted"] = json!(false);
    assert!(Inner::rejected_quota_wait(&partial, None).is_none());
    partial = rejected;
    partial["data"]["errorKind"] = json!("rate_limit");
    assert!(Inner::rejected_quota_wait(&partial, None).is_none());
}

#[test]
fn a_turn_cut_off_by_its_accounts_limit_goes_on_only_under_another_ready_account() {
    use crate::services::provider_account_status::AccountSelection;
    // Claude Code's words when the account runs dry partway through.
    let cut_off = json!({"code":-32603,"data":{
        "accountId":"spent", "dispatchStarted":true, "promptNotAccepted":false,
    },"message":"Internal error: Claude AI usage limit reached|1794070800"});
    assert!(Inner::cut_off_by_quota(&cut_off));
    // Codex names the kind.
    assert!(Inner::cut_off_by_quota(&json!({"code":-32603,"data":{
        "dispatchStarted":true, "codexErrorInfo":"usageLimitExceeded",
    },"message":"Internal error: You've hit your usage limit."})));
    // A refusal before the turn began is `prompt`'s own retry.
    let mut refused = cut_off.clone();
    refused["data"]["dispatchStarted"] = json!(false);
    assert!(!Inner::cut_off_by_quota(&refused));
    // Any other failure stops the chat as before.
    assert!(!Inner::cut_off_by_quota(&json!({"code":-32603,
        "data":{"dispatchStarted":true},"message":"Internal error: overloaded"})));

    let ready = |id: &str| AccountSelection::Ready {
        account_id: id.into(),
    };
    assert_eq!(
        Inner::spare_from("spent", ready("spare")).as_deref(),
        Some("spare")
    );
    // The spent account itself is no place to go on.
    assert_eq!(Inner::spare_from("spent", ready("spent")), None);
    // Nor is waiting for a reset.
    assert_eq!(
        Inner::spare_from(
            "spent",
            AccountSelection::Wait {
                account_id: "spare".into(),
                next_reset: Some(1_900_000_000_000),
                reset_tokens_available: false,
            }
        ),
        None
    );
}

#[test]
fn a_lasting_refusal_says_why_and_is_never_parked_for_a_reset() {
    // Z.ai's refusal of a key with nothing to spend (a Standard key on an
    // empty balance, or a Coding Plan key without a plan), as OpenCode
    // reports it.
    let mut refused = json!({"code":-32603,"data":{
        "service":"session", "errorName":"APIError", "accountId":"saved-account",
        "dispatchStarted":false, "promptNotAccepted":true,
    },"message":"Internal error: Insufficient balance or no resource package. Please recharge."});
    let mut elsewhere = refused.clone();
    Inner::explain_refusal(&mut refused, "zai-acp");
    assert_eq!(
        refused["data"]["refused"],
        "Insufficient balance or no resource package. Please recharge."
    );
    let notice = refused["data"]["message"].as_str().unwrap();
    assert!(notice.starts_with("Z.ai refused this account's request"));
    assert!(notice.contains("Insufficient balance or no resource package"));
    // Both ways out, without assuming which API the key is meant for.
    assert!(notice.contains("Top up the balance or use a Coding Plan key"));
    assert!(!notice.contains("wrong"));
    // Another provider names what can change the answer.
    Inner::explain_refusal(&mut elsewhere, "invented-acp");
    assert!(elsewhere["data"]["message"]
        .as_str()
        .unwrap()
        .contains("balance, plan or key is in order"));
    // The bridge's own words stay where they were, and a second pass
    // keeps the notice from wrapping itself.
    assert_eq!(
        refused["message"],
        "Internal error: Insufficient balance or no resource package. Please recharge."
    );
    let once = refused.clone();
    Inner::explain_refusal(&mut refused, "zai-acp");
    assert_eq!(refused, once);
    assert!(crate::services::provider_account_status::is_quota_error(
        &refused
    ));
    assert!(Inner::rejected_quota_wait(&refused, None).is_none());
    // A limit that resets is left as the provider said it.
    let mut weekly = json!({"code":-32603,"data":{"dispatchStarted":true},
        "message":"Internal error: Weekly/Monthly Limit Exhausted."});
    let before = weekly.clone();
    Inner::explain_refusal(&mut weekly, "zai-acp");
    assert_eq!(weekly, before);
}

#[test]
fn only_an_undelivered_prompt_answer_settles_the_turn_it_ran() {
    let params = json!({ "sessionId": "s1", "prompt": [] });
    assert_eq!(
        Inner::turn_request_session("session/prompt", &params).as_deref(),
        Some("s1")
    );
    // Other answers end no turn; a prompt with no session names none.
    assert_eq!(Inner::turn_request_session("session/steer", &params), None);
    assert_eq!(Inner::turn_request_session("session/cancel", &params), None);
    assert_eq!(
        Inner::turn_request_session("session/prompt", &json!({ "prompt": [] })),
        None
    );
}

#[test]
fn one_write_puts_a_session_on_a_model_and_a_legacy_folded_id_still_arrives() {
    // The whole story: the bridge's own option id, the bridge's own model
    // id, one call.
    let codex = codex_session();
    assert_eq!(
        Inner::model_write(&codex, "gpt-5.5"),
        ModelWrite::ConfigOption {
            config_id: "model".to_string(),
            model: "gpt-5.5".to_string(),
        }
    );

    // A stored id from before the split still reaches `apply_model` inside
    // a send, and is sent as the two values the bridge keeps apart.
    assert_eq!(
        Inner::model_write(&codex, "gpt-5.5[low]"),
        ModelWrite::Folded(SplitModel {
            model: "gpt-5.5".to_string(),
            effort_option: "reasoning_effort".to_string(),
            effort: "low".to_string(),
        })
    );

    // Only a folded id whose BOTH halves the bridge offers is split. An
    // effort it does not advertise is not one, so the id goes out whole
    // and the bridge answers for itself rather than the host inventing a
    // pair of writes out of a model's name.
    assert_eq!(
        Inner::model_write(&codex, "gpt-5.5[ultra]"),
        ModelWrite::ConfigOption {
            config_id: "model".to_string(),
            model: "gpt-5.5[ultra]".to_string(),
        }
    );

    // `[1m]` is a context lane, not an effort: claude's own model option
    // lists the id, so it is never taken apart.
    assert_eq!(
        Inner::model_write(&claude_session(), "opus[1m]"),
        ModelWrite::ConfigOption {
            config_id: "model".to_string(),
            model: "opus[1m]".to_string(),
        }
    );

    // The older method is reached only by a bridge with no model option:
    // codex's `unstable_setSessionModel` requires `model[effort]` and
    // throws on a base id, so it must never see one.
    let optionless = json!({
        "models": { "currentModelId": "some-model", "availableModels": [{ "modelId": "some-model" }] },
        "configOptions": [],
    });
    assert_eq!(
        Inner::model_write(&optionless, "some-model"),
        ModelWrite::SetModel
    );
    for id in ["gpt-5.5", "gpt-5.5[low]", "gpt-5.5[ultra]"] {
        assert_ne!(Inner::model_write(&codex, id), ModelWrite::SetModel);
    }
}

#[test]
fn a_model_reaches_the_renderer_under_the_name_its_own_bridge_gave_it() {
    // codex names one model two ways: `gpt-6-astra` in the option it takes
    // writes on, and `gpt-6-astra[xhigh]` in the display block whose rows
    // are every model crossed with every effort. The host used to present
    // the folded one, which is how an effort click came to read as a model
    // change everywhere above it.
    let snapshot = codex_session();
    let presented = Inner::presented_snapshot("codex-acp", &snapshot, true);
    let option = |id: &str| {
        presented["configOptions"]
            .as_array()
            .expect("options")
            .iter()
            .find(|option| option["id"] == id)
            .expect("option")
            .clone()
    };
    assert_eq!(option("model")["currentValue"], "gpt-6-astra");
    // The effort stays where its bridge keeps it.
    assert_eq!(option("reasoning_effort")["currentValue"], "xhigh");
    // Every option the bridge stated is presented exactly as it stated it,
    // behind the synthesized provider option the renderer reads the agent
    // from.
    assert_eq!(presented["configOptions"][0]["id"], "provider");
    assert_eq!(
        presented["configOptions"]
            .as_array()
            .expect("options")
            .iter()
            .skip(1)
            .cloned()
            .collect::<Vec<_>>(),
        snapshot["configOptions"]
            .as_array()
            .cloned()
            .expect("stated"),
    );

    // And a bridge's own notification passes through unrewritten.
    let params = json!({
        "sessionId": "s",
        "update": {
            "sessionUpdate": "config_option_update",
            "configOptions": snapshot["configOptions"].clone(),
        }
    });
    assert_eq!(
        Inner::config_option_update(&params),
        snapshot["configOptions"]
            .as_array()
            .cloned()
            .map(Value::Array),
    );
}

/// A session as codex-acp opens one: base ids in the model option, and a
/// `models` block whose 31 rows are every model crossed with every
/// effort. The probe must read the option and ignore the block.
fn codex_session() -> Value {
    json!({
        "sessionId": "probe-1",
        "models": {
            "currentModelId": "gpt-6-astra[xhigh]",
            "availableModels": [
                { "modelId": "gpt-6-astra[low]", "name": "GPT-6-Astra (low)" },
                { "modelId": "gpt-6-astra[ultra]", "name": "GPT-6-Astra (ultra)" },
                { "modelId": "gpt-5.5[xhigh]", "name": "GPT-5.5 (xhigh)" },
            ]
        },
        "configOptions": [
            {
                "id": "model",
                "name": "Model",
                "category": "model",
                "type": "select",
                "currentValue": "gpt-6-astra",
                "options": [
                    { "value": "gpt-6-astra", "name": "GPT-6-Astra", "description": "Our most capable model." },
                    { "value": "gpt-5.5", "name": "GPT-5.5" },
                    { "value": "gpt-5.3-codex-spark", "name": "GPT-5.3-Codex-Spark" },
                ]
            },
            { "id": "reasoning_effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "low", "name": "Low" }] },
            { "id": "fast-mode", "category": "model_config", "type": "select", "currentValue": "off", "options": [{ "value": "on" }, { "value": "off" }] },
        ]
    })
}

/// What codex answers when a model is selected: the full option array,
/// rebuilt for that model.
fn codex_answer(efforts: &[&str], fast: bool) -> Value {
    let mut options = vec![
        json!({ "id": "model", "category": "model", "type": "select" }),
        json!({
            "id": "reasoning_effort",
            "category": "thought_level",
            "type": "select",
            "options": efforts
                .iter()
                .map(|value| json!({ "value": value, "name": value }))
                .collect::<Vec<_>>(),
        }),
    ];
    if fast {
        options.push(json!({
            "id": "fast-mode",
            "category": "model_config",
            "type": "select",
            "options": [{ "value": "on" }, { "value": "off" }],
        }));
    }
    json!({ "configOptions": options })
}

fn effort_values(row: &Value) -> Vec<&str> {
    row["efforts"]
        .as_array()
        .expect("efforts")
        .iter()
        .filter_map(|effort| effort["value"].as_str())
        .collect()
}

#[tokio::test]
async fn the_model_list_is_the_model_option_and_never_the_folded_cross_product() {
    let opened = codex_session();
    let asked = StdMutex::new(Vec::new());
    let closed = StdMutex::new(false);
    let rows = Inner::probe_model_rows(
        &opened,
        |config_id, model_id| {
            asked
                .lock()
                .expect("asked")
                .push(format!("{config_id}={model_id}"));
            async move {
                Ok(match model_id.as_str() {
                    "gpt-6-astra" => {
                        codex_answer(&["low", "medium", "high", "xhigh", "max", "ultra"], true)
                    }
                    "gpt-5.5" => codex_answer(&["low", "medium", "high", "xhigh"], true),
                    _ => codex_answer(&["low", "medium", "high", "xhigh"], false),
                })
            }
        },
        || async {
            *closed.lock().expect("closed") = true;
        },
    )
    .await;

    let ids: Vec<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
    assert_eq!(ids, ["gpt-6-astra", "gpt-5.5", "gpt-5.3-codex-spark"]);
    assert!(
        !ids.iter().any(|id| id.contains('[')),
        "no folded id survives the probe"
    );
    assert_eq!(rows[0]["name"], "GPT-6-Astra");
    assert_eq!(rows[0]["description"], "Our most capable model.");
    assert_eq!(
        *asked.lock().expect("asked"),
        [
            "model=gpt-6-astra",
            "model=gpt-5.5",
            "model=gpt-5.3-codex-spark",
        ]
    );

    // Each model's own effort set, not the session's current one.
    assert_eq!(
        effort_values(&rows[0]),
        ["low", "medium", "high", "xhigh", "max", "ultra"]
    );
    assert_eq!(effort_values(&rows[1]), ["low", "medium", "high", "xhigh"]);
    assert_eq!(rows[0]["supportsFast"], true);
    // Spark's fast option disappears from the array while it is current.
    assert_eq!(rows[2]["supportsFast"], false);
    assert_eq!(rows[2]["capabilitySource"], "probed");
    assert!(
        *closed.lock().expect("closed"),
        "the probe session is closed"
    );
}

#[tokio::test]
async fn a_refused_model_does_not_hide_later_models_reasoning() {
    let closed = StdMutex::new(false);
    let rows = Inner::probe_model_rows(
        &codex_session(),
        |_, model_id| async move {
            if model_id == "gpt-5.5" {
                Err(protocol::internal(
                    "Could not confirm this model with the API",
                ))
            } else {
                Ok(codex_answer(&["low", "high"], false))
            }
        },
        || async {
            *closed.lock().unwrap() = true;
        },
    )
    .await;
    assert_eq!(rows[1]["capabilitySource"], "unknown");
    assert_eq!(rows[2]["capabilitySource"], "probed");
    assert_eq!(effort_values(&rows[2]), ["low", "high"]);
    assert!(*closed.lock().unwrap());
}

#[tokio::test]
async fn a_probe_that_gives_up_still_closes_its_session() {
    let opened = codex_session();
    let closed = StdMutex::new(false);
    let rows = Inner::probe_model_rows(
        &opened,
        |_, model_id| async move {
            if model_id == "gpt-6-astra" {
                Ok(codex_answer(&["low", "medium"], true))
            } else {
                Err(protocol::internal("the bridge went away"))
            }
        },
        || async {
            *closed.lock().expect("closed") = true;
        },
    )
    .await;

    assert!(*closed.lock().expect("closed"), "closed on the error path");
    // The list survives the failure; what could not be read stays unknown,
    // which is not the same as having no effort control.
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["capabilitySource"], "probed");
    assert_eq!(rows[1]["capabilitySource"], "unknown");
    assert_eq!(rows[1]["supportsFast"], Value::Null);
    assert!(effort_values(&rows[1]).is_empty());
}

#[test]
fn codex_recommended_effort_is_kept_only_when_offered() {
    let mut row = Inner::probe_row("gpt-6-sol", Some("6 Sol"), None);
    for (recommended, expected) in [("ultra", json!("ultra")), ("unsupported", Value::Null)] {
        row["defaultEffort"] = Value::Null;
        Inner::record_capabilities(
            &mut row,
            &json!({ "configOptions": [{
            "id": "reasoning_effort", "category": "thought_level", "type": "select",
            "options": [{"value": "high", "name": "High"}, {"value": "ultra", "name": "Ultra"}],
            "_meta": {"jetbrains": {"air": {"recommendedValue": recommended}}}
        }] }),
        );
        assert_eq!(row["defaultEffort"], expected);
    }
}

#[tokio::test]
async fn grok_keeps_the_effort_menu_and_default_it_states_in_model_meta() {
    let opened = json!({
        "sessionId": "probe-1",
        "models": {
            "currentModelId": "grok-4.6",
            "availableModels": [
                {
                    "modelId": "grok-4.6",
                    "name": "Grok 4.6",
                    "description": "SpaceXAI's latest frontier model",
                    "_meta": { "reasoningEfforts": [
                        { "id": "xhigh", "value": "xhigh", "label": "Extra High Effort", "default": false },
                        { "id": "high", "value": "high", "label": "High Effort", "default": true },
                    ] }
                },
                {
                    "modelId": "grok-4.5",
                    "name": "Grok 4.5",
                    "_meta": { "reasoningEfforts": [
                        { "id": "high", "value": "high", "label": "High Effort", "default": true },
                    ] }
                },
            ]
        },
        "configOptions": [
            {
                "id": "model",
                "category": "model",
                "type": "select",
                "currentValue": "grok-4.6",
                "options": [{ "value": "grok-4.6", "name": "Grok 4.6" }, { "value": "grok-4.5", "name": "Grok 4.5" }]
            },
            { "id": "reasoning_effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "xhigh" }] },
        ]
    });
    let rows = Inner::probe_model_rows(
        &opened,
        |_, model_id| async move {
            let efforts: Vec<Value> = if model_id == "grok-4.6" {
                vec![json!({ "value": "xhigh", "name": "Extra High Effort" })]
            } else {
                vec![json!({ "value": "high", "name": "High Effort" })]
            };
            Ok(json!({ "configOptions": [
                { "id": "model", "category": "model", "type": "select" },
                { "id": "reasoning_effort", "category": "thought_level", "type": "select", "options": efforts },
            ] }))
        },
        || async {},
    )
    .await;

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["defaultEffort"], "high");
    assert_eq!(rows[1]["defaultEffort"], "high");
    // The model option carries no description; the models block does.
    assert_eq!(rows[0]["description"], "SpaceXAI's latest frontier model");
    // The selected model's own menu wins over the advertised one.
    assert_eq!(effort_values(&rows[0]), ["xhigh"]);
    // Grok has no fast mode anywhere, and says so rather than shrugging.
    assert_eq!(rows[0]["supportsFast"], false);
    assert_eq!(rows[0]["capabilitySource"], "probed");
}

#[tokio::test]
async fn a_context_lane_in_a_model_id_is_left_alone() {
    let opened = json!({
        "sessionId": "probe-1",
        "configOptions": [
            {
                "id": "model",
                "category": "model",
                "type": "select",
                "currentValue": "default",
                "options": [
                    { "value": "default", "name": "Default" },
                    { "value": "opus[1m]", "name": "Opus (1M context)" },
                    { "value": "haiku", "name": "Haiku 4.5" },
                ]
            },
            { "id": "effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "default" }] },
            { "id": "fast", "category": "model_config", "type": "select", "currentValue": "off", "options": [{ "value": "on" }, { "value": "off" }] },
        ]
    });
    let rows = Inner::probe_model_rows(
        &opened,
        |_, model_id| async move {
            // Haiku offers neither control; the others offer both.
            Ok(if model_id == "haiku" {
                json!({ "configOptions": [{ "id": "model", "category": "model", "type": "select" }] })
            } else {
                json!({ "configOptions": [
                    { "id": "model", "category": "model", "type": "select" },
                    { "id": "effort", "category": "thought_level", "type": "select", "options": [{ "value": "default" }, { "value": "max" }] },
                    { "id": "fast", "category": "model_config", "type": "select", "options": [{ "value": "on" }, { "value": "off" }] },
                ] })
            })
        },
        || async {},
    )
    .await;

    let ids: Vec<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
    assert_eq!(ids, ["default", "opus[1m]", "haiku"]);
    assert_eq!(rows[1]["name"], "Opus (1M context)");
    assert_eq!(effort_values(&rows[1]), ["default", "max"]);
    assert_eq!(rows[1]["supportsFast"], true);
    // Haiku has no effort control at all, and that is a probed answer.
    assert!(effort_values(&rows[2]).is_empty());
    assert_eq!(rows[2]["capabilitySource"], "probed");
    assert_eq!(rows[2]["supportsFast"], false);
}

#[test]
fn a_fast_toggle_is_recognised_under_either_bridge_s_own_name() {
    assert!(Inner::is_fast_option(&json!({
        "id": "fast", "category": "model_config", "type": "select",
        "options": [{ "value": "on" }, { "value": "off" }]
    })));
    assert!(Inner::is_fast_option(&json!({
        "id": "fast-mode", "category": "model_config", "type": "select",
        "options": [{ "value": "off" }, { "value": "on" }]
    })));
    assert!(Inner::is_fast_option(
        &json!({ "id": "fast-mode", "category": "model_config", "type": "boolean" })
    ));
    // Another model_config knob that happens to be a select is not it.
    assert!(!Inner::is_fast_option(&json!({
        "id": "verbosity", "category": "model_config", "type": "select",
        "options": [{ "value": "terse" }, { "value": "verbose" }]
    })));
    assert!(!Inner::is_fast_option(
        &json!({ "id": "reasoning_effort", "category": "thought_level", "type": "select" })
    ));
}

/// A claude-acp session as the bridge opens one: no `models` block at
/// all, the model in its own option, and an effort seeded from the
/// operator's `~/.claude/settings.json` rather than from the model.
fn claude_session() -> Value {
    json!({
        "models": Value::Null,
        "configOptions": [
            { "id": "mode", "category": "mode", "type": "select", "currentValue": "default", "options": [{ "value": "default" }] },
            {
                "id": "model", "category": "model", "type": "select", "currentValue": "opus[1m]",
                "options": [
                    { "value": "default" }, { "value": "opus[1m]" },
                    { "value": "claude-fable-5[1m]" }, { "value": "sonnet" }, { "value": "haiku" },
                ]
            },
            {
                "id": "effort", "category": "thought_level", "type": "select", "currentValue": "xhigh",
                "options": [{ "value": "default" }, { "value": "low" }, { "value": "high" }, { "value": "xhigh" }, { "value": "max" }]
            },
            {
                "id": "fast", "category": "model_config", "type": "select", "currentValue": "off",
                "options": [{ "value": "on" }, { "value": "off" }]
            },
            { "id": "agent", "category": "agent", "type": "select", "currentValue": "default", "options": [{ "value": "default" }] },
        ]
    })
}

#[test]
fn whichever_fable_the_bridge_does_not_list_is_the_one_a_session_is_opened_on() {
    // This bridge's Claude Code runs Fable 5, so that is the one it lists
    // and takes as a plain write; Fable 5.1 it would refuse.
    let lists_5 = claude_session();
    assert!(!Inner::opens_on_model(
        "claude-acp",
        &lists_5,
        "claude-fable-5[1m]"
    ));
    assert!(Inner::opens_on_model(
        "claude-acp",
        &lists_5,
        "claude-fable-5-1[1m]"
    ));

    // The next machine runs Fable 5.1 and the two swap. Writing Fable 5
    // there answered "Invalid value for config option model", which took
    // a chat that had just moved to Claude straight back off it.
    let mut lists_5_1 = claude_session();
    lists_5_1["configOptions"][1]["options"][2]["value"] = json!("claude-fable-5-1[1m]");
    assert!(Inner::opens_on_model(
        "claude-acp",
        &lists_5_1,
        "claude-fable-5[1m]"
    ));
    assert!(!Inner::opens_on_model(
        "claude-acp",
        &lists_5_1,
        "claude-fable-5-1[1m]"
    ));
    // An alias every bridge lists is never opened on.
    assert!(!Inner::opens_on_model("claude-acp", &lists_5_1, "sonnet"));
}

/// grok-acp: a real `thought_level` option under the same id codex uses,
/// and no fast toggle of any kind.
fn grok_session() -> Value {
    json!({
        "models": { "currentModelId": "grok-4.6" },
        "configOptions": [
            { "id": "model", "category": "model", "type": "select", "currentValue": "grok-4.6", "options": [{ "value": "grok-4.6" }] },
            { "id": "reasoning_effort", "category": "thought_level", "type": "select", "currentValue": "xhigh", "options": [{ "value": "xhigh" }] },
        ]
    })
}

/// An inventory row as `probe_models` writes it, before `merge_inventory`
/// places it.
fn probed_row(id: &str, efforts: &[&str]) -> Value {
    json!({
        "id": id,
        "name": id,
        "description": Value::Null,
        "efforts": efforts.iter().map(|value| harness::effort(value, None, None)).collect::<Vec<_>>(),
        "defaultEffort": Value::Null,
        "supportsFast": false,
        "capabilitySource": "probed",
    })
}

#[test]
fn a_write_is_routed_by_role_and_keeps_the_bridges_own_name() {
    let claude = claude_session();
    assert_eq!(Inner::option_role(&claude, "model"), OptionRole::Model);
    assert_eq!(Inner::option_role(&claude, "effort"), OptionRole::Effort);
    assert_eq!(Inner::option_role(&claude, "fast"), OptionRole::Fast);
    assert_eq!(Inner::option_role(&claude, "mode"), OptionRole::Other);
    assert_eq!(Inner::option_role(&claude, "agent"), OptionRole::Other);

    // The same three roles under each bridge's own ids.
    let codex = codex_session();
    assert_eq!(
        Inner::option_role(&codex, "reasoning_effort"),
        OptionRole::Effort
    );
    assert_eq!(Inner::option_role(&codex, "fast-mode"), OptionRole::Fast);
    assert_eq!(
        Inner::option_role(&codex, "collaboration_mode"),
        OptionRole::Other
    );
    assert_eq!(
        Inner::option_role(&grok_session(), "reasoning_effort"),
        OptionRole::Effort
    );
    assert_eq!(
        Inner::option_role(&grok_session(), "fast"),
        OptionRole::Other
    );

    // A session whose stored snapshot arrived with no options (grok's cold
    // session/new) is classified from the bridge's own answer instead.
    let cold = json!({ "configOptions": [] });
    assert_eq!(
        Inner::write_role(&cold, &claude, "effort"),
        OptionRole::Effort
    );
    assert_eq!(
        Inner::write_role(&claude, &cold, "effort"),
        OptionRole::Effort
    );
    assert_eq!(Inner::write_role(&cold, &cold, "effort"), OptionRole::Other);

    // What goes to the bridge is the client's own request, session id
    // aside: the id and the value shape are never rewritten.
    let write =
        json!({ "sessionId": "host-1", "configId": "fast-mode", "value": true, "type": "boolean" });
    assert_eq!(
        Inner::forwarded_config_write(&write, "bridge-1"),
        json!({ "sessionId": "bridge-1", "configId": "fast-mode", "value": true, "type": "boolean" })
    );
}

#[test]
fn what_is_stored_is_what_the_bridge_answered_not_what_was_asked() {
    // Asked for gpt-5.5 at xhigh, codex clamps the effort to the model's
    // own default and reports it nowhere but in the options it answers with.
    let clamped = json!([
        { "id": "model", "category": "model", "currentValue": "gpt-5.5" },
        { "id": "reasoning_effort", "category": "thought_level", "currentValue": "medium" },
        {
            "id": "fast-mode", "category": "model_config", "type": "select", "currentValue": "on",
            "options": [{ "value": "on" }, { "value": "off" }]
        },
    ]);
    assert_eq!(
        Inner::selection_from(&clamped),
        Selection {
            model: Some("gpt-5.5".to_string()),
            effort: Some("medium".to_string()),
            fast: Some(true),
        }
    );

    // A full list without an effort or a fast option is the model saying
    // it has neither (claude on haiku), which is not the same as silence.
    let haiku = json!([
        { "id": "mode", "category": "mode", "currentValue": "default" },
        { "id": "model", "category": "model", "currentValue": "haiku" },
    ]);
    assert_eq!(
        Inner::selection_from(&haiku),
        Selection {
            model: Some("haiku".to_string()),
            effort: None,
            fast: None,
        }
    );
    // An answer carrying no options at all teaches nothing.
    assert_eq!(
        Inner::selection_from(&json!({})["configOptions"]),
        Selection::default()
    );

    assert_eq!(Inner::fast_enabled(&json!(true)), Some(true));
    assert_eq!(Inner::fast_enabled(&json!("on")), Some(true));
    assert_eq!(Inner::fast_enabled(&json!("off")), Some(false));
    assert_eq!(Inner::fast_enabled(&json!("sometimes")), None);
}

#[test]
fn the_model_a_session_is_on_is_the_one_its_bridge_would_take_back() {
    // codex keeps a folded display id in its models block while its own
    // option holds the base id it accepts; reading the block first is how
    // `gpt-6-astra[xhigh]` used to reach sessions.model_id.
    let codex = json!({
        "models": { "currentModelId": "gpt-6-astra[xhigh]" },
        "configOptions": [
            { "id": "model", "category": "model", "currentValue": "gpt-6-astra" },
            { "id": "reasoning_effort", "category": "thought_level", "currentValue": "xhigh" },
        ]
    });
    assert_eq!(Inner::current_model(&codex).as_deref(), Some("gpt-6-astra"));
    assert_eq!(
        Inner::current_model(&claude_session()).as_deref(),
        Some("opus[1m]")
    );
    // A bridge with no model option is still read from its models block.
    let listed = json!({ "models": { "currentModelId": "amp-1" }, "configOptions": [] });
    assert_eq!(Inner::current_model(&listed).as_deref(), Some("amp-1"));
    assert_eq!(Inner::current_model(&json!({})), None);
}

#[test]
fn only_a_folded_id_its_harness_can_explain_is_split() {
    let codex = harness::merge_inventory(
        "codex-acp",
        vec![
            probed_row(
                "gpt-6-astra",
                &["low", "medium", "high", "xhigh", "max", "ultra"],
            ),
            probed_row(
                "gpt-5.6-sol",
                &["low", "medium", "high", "xhigh", "max", "ultra"],
            ),
            probed_row("gpt-5.6-luna", &["low", "medium", "high", "xhigh", "max"]),
            probed_row("gpt-5.4-mini", &[]),
        ],
    );
    // The four ids the live store actually holds folded.
    for (folded, model, effort) in [
        ("gpt-5.6-sol[xhigh]", "gpt-5.6-sol", "xhigh"),
        ("gpt-5.6-sol[low]", "gpt-5.6-sol", "low"),
        ("gpt-6-astra[xhigh]", "gpt-6-astra", "xhigh"),
        ("gpt-5.6-luna[low]", "gpt-5.6-luna", "low"),
    ] {
        assert_eq!(
            Inner::legacy_split(folded, &codex),
            Some((model.to_string(), effort.to_string())),
            "{folded}"
        );
    }
    // An effort that model does not offer, a model the harness does not
    // list, and every shape that is not a pair at all.
    for id in [
        "gpt-5.6-luna[ultra]",
        "gpt-5.3-codex-spark[high]",
        "gpt-5.4-mini",
        "current",
        "a[b][c]",
        "[low]",
        "gpt-5.6-sol[]",
        "gpt-5.6-sol[xhigh",
    ] {
        assert_eq!(Inner::legacy_split(id, &codex), None, "{id}");
    }
    // A harness nobody has probed yet answers "not now", never a guess.
    assert_eq!(
        Inner::legacy_split(
            "gpt-5.6-sol[xhigh]",
            &harness::merge_inventory("codex-acp", vec![])
        ),
        None
    );

    // claude's `[1m]` ids are context lanes, not efforts, and `default` is
    // an alias — with or without a probe behind them.
    let claude = harness::merge_inventory(
        "claude-acp",
        vec![
            probed_row("default", &["default", "low", "high", "xhigh", "max"]),
            probed_row("opus[1m]", &["default", "low", "high", "xhigh", "max"]),
            probed_row(
                "claude-fable-5[1m]",
                &["default", "low", "high", "xhigh", "max"],
            ),
            probed_row("sonnet", &["default", "low", "high", "xhigh", "max"]),
            probed_row("haiku", &[]),
        ],
    );
    let declared = harness::merge_inventory("claude-acp", vec![]);
    for id in [
        "opus[1m]",
        "claude-fable-5[1m]",
        "claude-fable-5-1[1m]",
        "default",
        "haiku",
        "claude-opus-4-7",
    ] {
        assert_eq!(Inner::legacy_split(id, &claude), None, "{id}");
        assert_eq!(Inner::legacy_split(id, &declared), None, "{id} declared");
    }

    let grok = harness::merge_inventory(
        "grok-acp",
        vec![probed_row("grok-4.6", &["xhigh", "high", "medium", "low"])],
    );
    assert_eq!(Inner::legacy_split("grok-4.6", &grok), None);
    assert_eq!(Inner::legacy_split("current", &grok), None);
}

#[test]
fn a_configuration_the_bridge_changes_by_itself_is_read_off_the_notification() {
    let update = |options: Value| {
        json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "config_option_update", "configOptions": options },
        })
    };
    // grok sends the whole list, so one notification states everything.
    let grok = update(json!([
        { "id": "model", "category": "model", "currentValue": "grok-4.6" },
        { "id": "reasoning_effort", "category": "thought_level", "currentValue": "low" },
    ]));
    let options = Inner::config_option_update(&grok).expect("options");
    assert_eq!(
        Inner::selection_from(&options),
        Selection {
            model: Some("grok-4.6".to_string()),
            effort: Some("low".to_string()),
            fast: None,
        }
    );

    // claude's SDK flipping fast mode back after a cooldown, with nobody
    // watching.
    let cooled = update(json!([
        { "id": "model", "category": "model", "currentValue": "opus[1m]" },
        { "id": "effort", "category": "thought_level", "currentValue": "max" },
        {
            "id": "fast", "category": "model_config", "type": "select", "currentValue": "off",
            "options": [{ "value": "on" }, { "value": "off" }]
        },
    ]));
    let selection = Inner::selection_from(&Inner::config_option_update(&cooled).expect("options"));
    assert_eq!(selection.effort.as_deref(), Some("max"));
    assert_eq!(selection.fast, Some(false));

    // Nothing to apply from an empty list or another kind of update.
    assert!(Inner::config_option_update(&update(json!([]))).is_none());
    assert!(Inner::config_option_update(
        &json!({ "update": { "sessionUpdate": "agent_message_chunk" } })
    )
    .is_none());
}

/// Everything claude-agent-acp offers, and the five values the 4.6-class
/// models drop `xhigh` from.
const EVERY_EFFORT: &[&str] = &["default", "low", "medium", "high", "xhigh", "max"];
const NO_XHIGH: &[&str] = &["default", "low", "medium", "high", "max"];

/// What claude-agent-acp answers a write with: its whole option list,
/// rebuilt for the model the session is now on. `effort` is `None` for a
/// model with no effort control at all (haiku) and `fast` `None` for one
/// with no fast toggle (every model but the Opus rows).
fn claude_answer(model: &str, effort: Option<&str>, efforts: &[&str], fast: Option<bool>) -> Value {
    let mut options = vec![json!({
        "id": "model", "category": "model", "type": "select", "currentValue": model,
        "options": [
            { "value": "default" }, { "value": "opus[1m]" },
            { "value": "claude-fable-5[1m]" }, { "value": "sonnet" }, { "value": "haiku" },
        ]
    })];
    if let Some(effort) = effort {
        options.push(json!({
            "id": "effort", "category": "thought_level", "type": "select",
            "currentValue": effort,
            "options": efforts.iter().map(|value| json!({ "value": value })).collect::<Vec<_>>(),
        }));
    }
    if let Some(fast) = fast {
        options.push(json!({
            "id": "fast", "category": "model_config", "type": "select",
            "currentValue": Inner::fast_word(fast),
            "options": [{ "value": "on" }, { "value": "off" }],
        }));
    }
    json!({ "configOptions": options })
}

#[tokio::test]
async fn a_chat_is_put_on_its_model_then_its_effort_then_its_fast_mode() {
    let mut snapshot = claude_session();
    let asked = StdMutex::new(Vec::new());
    let wanted = Selection {
        model: Some("sonnet".to_string()),
        effort: Some("high".to_string()),
        fast: Some(true),
    };
    let substitutions =
        Inner::apply_selection("claude-acp", &mut snapshot, &wanted, false, |_, request| {
            let config_id = request["configId"].as_str().unwrap_or_default().to_string();
            asked
                .lock()
                .expect("asked")
                .push(format!("{config_id}={}", request["value"]));
            // Sonnet keeps the effort it was on and has no fast toggle.
            let answer = match config_id.as_str() {
                "model" => claude_answer("sonnet", Some("xhigh"), EVERY_EFFORT, None),
                _ => claude_answer("sonnet", Some("high"), EVERY_EFFORT, None),
            };
            async move { Ok(answer) }
        })
        .await;

    assert_eq!(
        *asked.lock().expect("asked"),
        vec!["model=\"sonnet\"", "effort=\"high\""]
    );
    assert_eq!(Inner::current_model(&snapshot).as_deref(), Some("sonnet"));
    assert_eq!(
        Inner::effort_state(&snapshot, "high").map(|(_, current, _)| current),
        Some(Some("high".to_string()))
    );
    // The step nothing advertised is the only one that did not happen, and
    // it is the one the chat is told about.
    assert_eq!(substitutions.len(), 1, "{substitutions:?}");
    assert_eq!(substitutions[0]["role"], "fast");
    assert_eq!(substitutions[0]["requested"], "on");
    assert_eq!(substitutions[0]["applied"], Value::Null);
    assert_eq!(substitutions[0]["reason"], "sonnet has no fast mode");
}

#[tokio::test]
async fn fast_off_does_not_substitute_a_model_without_the_control() {
    let mut snapshot = claude_session();
    let wanted = Selection {
        model: Some("sonnet".into()),
        effort: Some("high".into()),
        fast: Some(false),
    };
    let asked = StdMutex::new(Vec::new());
    let substitutions =
        Inner::apply_selection("claude-acp", &mut snapshot, &wanted, true, |role, _| {
            asked.lock().expect("asked").push(role);
            async { Ok(claude_answer("sonnet", Some("high"), EVERY_EFFORT, None)) }
        })
        .await;
    assert_eq!(*asked.lock().expect("asked"), vec![OptionRole::Model]);
    assert!(substitutions.is_empty(), "{substitutions:?}");
    let observed = Inner::selection_from(&snapshot["configOptions"]);
    assert_eq!(observed.model, wanted.model);
    assert_eq!(observed.effort, wanted.effort);
    assert_eq!(observed.fast, None);
    assert!(Inner::substitutions_for(&wanted, &observed).is_empty());
    let fast = Selection {
        fast: Some(true),
        ..wanted
    };
    assert_eq!(
        Inner::substitutions_for(&fast, &observed)[0]["role"],
        "fast"
    );
}

#[tokio::test]
async fn a_lane_the_bridge_names_by_its_declared_alias_is_the_lane() {
    // 11-01: a chat moved to Opus 5.5 opened on `opus[1m]`, Claude Code
    // answered every write with `opus`, and the chat read a substitution
    // and fell back to Default.
    let mut snapshot = json!({
        "models": Value::Null,
        "configOptions": claude_answer("default", Some("high"), EVERY_EFFORT, Some(false))["configOptions"],
    });
    let wanted = Selection {
        model: Some("opus[1m]".into()),
        effort: Some("xhigh".into()),
        fast: Some(false),
    };
    let substitutions =
        Inner::apply_selection("claude-acp", &mut snapshot, &wanted, true, |role, _| {
            let effort = if role == OptionRole::Model {
                "high"
            } else {
                "xhigh"
            };
            async move {
                Ok(claude_answer(
                    "opus",
                    Some(effort),
                    EVERY_EFFORT,
                    Some(false),
                ))
            }
        })
        .await;
    assert!(substitutions.is_empty(), "{substitutions:?}");
    assert_eq!(Inner::current_model(&snapshot).as_deref(), Some("opus[1m]"));
    // What the bridge itself said stays the evidence.
    assert_eq!(
        ReportedSelection::read(&snapshot).model_id.as_deref(),
        Some("opus")
    );
    // A bridge's own update later keeps the name too, and only for a
    // declared pairing: `default` is no other name for anything, and
    // Codex declares no `opus`.
    let mut later = claude_answer("opus", Some("high"), EVERY_EFFORT, Some(false));
    assert!(Inner::hold_declared_model(
        "claude-acp",
        "opus[1m]",
        &mut later
    ));
    assert_eq!(Inner::current_model(&later).as_deref(), Some("opus[1m]"));
    let mut moved = claude_answer("default", Some("high"), EVERY_EFFORT, None);
    assert!(!Inner::hold_declared_model(
        "claude-acp",
        "opus[1m]",
        &mut moved
    ));
    assert_eq!(Inner::current_model(&moved).as_deref(), Some("default"));
    let mut other = claude_answer("sonnet", Some("high"), EVERY_EFFORT, None);
    assert!(!Inner::hold_declared_model(
        "claude-acp",
        "opus[1m]",
        &mut other
    ));
    let mut elsewhere = claude_answer("opus", Some("high"), EVERY_EFFORT, None);
    assert!(!Inner::hold_declared_model(
        "codex-acp",
        "opus[1m]",
        &mut elsewhere
    ));
    let mut fable = claude_answer("fable", Some("high"), EVERY_EFFORT, None);
    assert!(Inner::hold_declared_model(
        "claude-acp",
        "claude-fable-5-2[1m]",
        &mut fable
    ));
    // 11-10: `fable` names Fable 5.2, and Fable 5.1 answers by its full id.
    let mut previous = claude_answer("claude-fable-5-1", Some("high"), EVERY_EFFORT, None);
    assert!(Inner::hold_declared_model(
        "claude-acp",
        "claude-fable-5-1[1m]",
        &mut previous
    ));
    let mut moved_on = claude_answer("fable", Some("high"), EVERY_EFFORT, None);
    assert!(!Inner::hold_declared_model(
        "claude-acp",
        "claude-fable-5-1[1m]",
        &mut moved_on
    ));
}

#[tokio::test]
async fn a_model_the_bridge_only_opens_on_is_asserted_and_not_assumed() {
    // A session opened through `_meta.claudeCode.options.model`: the bridge
    // reports `default` and its effort and fast options describe that
    // alias, which is how Opus 4.6 came to advertise an xhigh it has not.
    let opened = || {
        json!({
            "models": Value::Null,
            "configOptions": claude_answer("default", Some("xhigh"), EVERY_EFFORT, Some(false))["configOptions"],
        })
    };
    let wanted = Selection {
        model: Some("claude-opus-4-6".to_string()),
        effort: Some("xhigh".to_string()),
        fast: None,
    };

    let mut snapshot = opened();
    let asked = StdMutex::new(Vec::new());
    let substitutions =
        Inner::apply_selection("claude-acp", &mut snapshot, &wanted, true, |_, request| {
            asked
                .lock()
                .expect("asked")
                .push(request["value"].as_str().unwrap_or_default().to_string());
            // Asserted, the session finally describes the model it is for.
            let answer = claude_answer("claude-opus-4-6", Some("default"), NO_XHIGH, None);
            async move { Ok(answer) }
        })
        .await;
    assert_eq!(*asked.lock().expect("asked"), vec!["claude-opus-4-6"]);
    assert_eq!(
        Inner::current_model(&snapshot).as_deref(),
        Some("claude-opus-4-6")
    );
    assert!(Inner::fast_state(&snapshot).is_none(), "4.6 has no fast");
    // And the effort the session showed before the assert belonged to the
    // alias: 4.6 does not offer it, so it is left alone and reported.
    assert_eq!(substitutions.len(), 1, "{substitutions:?}");
    assert_eq!(substitutions[0]["role"], "effort");
    assert_eq!(substitutions[0]["requested"], "xhigh");
    assert_eq!(substitutions[0]["applied"], "default");
    assert_eq!(substitutions[0]["reason"], "not offered by claude-opus-4-6");

    // Without the assert — an ordinary model — a value the bridge does not
    // list is never written at it.
    let mut untouched = opened();
    let refused =
        Inner::apply_selection("claude-acp", &mut untouched, &wanted, false, |_, _| async {
            panic!("nothing may be written for a model the bridge does not list")
        })
        .await;
    assert_eq!(refused[0]["role"], "model");
    assert_eq!(refused[0]["applied"], "default");
    assert_eq!(untouched, opened());
}

#[tokio::test]
async fn a_model_the_provider_says_to_try_again_is_asked_again_in_its_session() {
    // 11-18: one Claude session of a run could not confirm its model with
    // the API beside others that did, and the refusal stopped the run.
    let opened = || {
        json!({
            "models": Value::Null,
            "configOptions": claude_answer("default", Some("high"), EVERY_EFFORT, Some(false))["configOptions"],
        })
    };
    let wanted = Selection {
        model: Some("claude-opus-4-6".to_string()),
        effort: None,
        fast: None,
    };
    let try_again = || {
        protocol::internal(
            "Couldn't confirm model \"claude-opus-4-6\" with the API. Try again, or run /model to see available models.",
        )
    };
    // Refused once, taken the second time: nothing was substituted.
    let mut snapshot = opened();
    let asked = StdMutex::new(0u32);
    let substitutions =
        Inner::apply_selection("claude-acp", &mut snapshot, &wanted, true, |_, _| {
            let mut asked = asked.lock().expect("asked");
            *asked += 1;
            let answer = if *asked == 1 {
                Err(try_again())
            } else {
                Ok(claude_answer(
                    "claude-opus-4-6",
                    Some("default"),
                    NO_XHIGH,
                    None,
                ))
            };
            async move { answer }
        })
        .await;
    assert_eq!(*asked.lock().expect("asked"), 2);
    assert!(substitutions.is_empty(), "{substitutions:?}");
    assert_eq!(
        Inner::current_model(&snapshot).as_deref(),
        Some("claude-opus-4-6")
    );
    // Refused every time: asked three times, then the refusal stands.
    let mut snapshot = opened();
    let asked = StdMutex::new(0u32);
    let substitutions =
        Inner::apply_selection("claude-acp", &mut snapshot, &wanted, true, |_, _| {
            *asked.lock().expect("asked") += 1;
            let answer = Err(try_again());
            async move { answer }
        })
        .await;
    assert_eq!(*asked.lock().expect("asked"), 3);
    assert_eq!(substitutions.len(), 1, "{substitutions:?}");
    assert_eq!(substitutions[0]["role"], "model");
    assert_eq!(substitutions[0]["requested"], "claude-opus-4-6");
    // A refusal that does not ask for another try is written once.
    let mut snapshot = opened();
    let asked = StdMutex::new(0u32);
    let substitutions =
        Inner::apply_selection("claude-acp", &mut snapshot, &wanted, true, |_, _| {
            *asked.lock().expect("asked") += 1;
            async { Err(protocol::internal("Invalid params")) }
        })
        .await;
    assert_eq!(*asked.lock().expect("asked"), 1);
    assert_eq!(substitutions.len(), 1, "{substitutions:?}");
}

#[tokio::test]
async fn an_effort_is_never_written_at_a_model_that_has_none() {
    // Haiku has no effort option at all, and writing one answers "Unknown
    // config option: effort".
    let mut snapshot = json!({
        "models": Value::Null,
        "configOptions": claude_answer("haiku", None, &[], None)["configOptions"],
    });
    let wanted = Selection {
        model: None,
        effort: Some("xhigh".to_string()),
        fast: Some(true),
    };
    let substitutions =
        Inner::apply_selection("claude-acp", &mut snapshot, &wanted, false, |_, _| async {
            panic!("haiku offers neither knob")
        })
        .await;
    assert_eq!(substitutions.len(), 2);
    assert_eq!(substitutions[0]["reason"], "haiku has no effort control");
    assert_eq!(substitutions[1]["reason"], "haiku has no fast mode");
    for entry in &substitutions {
        assert_eq!(entry["applied"], Value::Null);
    }
}

#[tokio::test]
async fn the_value_a_bridge_answers_with_is_the_one_that_stuck() {
    // A bridge answers a write it will not honour with the value it kept
    // rather than with an error: what came back is what the session runs
    // at, whatever was asked for.
    let mut snapshot = claude_session();
    let wanted = Selection {
        model: None,
        effort: Some("max".to_string()),
        fast: None,
    };
    let substitutions =
        Inner::apply_selection("claude-acp", &mut snapshot, &wanted, false, |_, _| async {
            Ok(claude_answer(
                "opus[1m]",
                Some("high"),
                EVERY_EFFORT,
                Some(false),
            ))
        })
        .await;
    assert_eq!(substitutions.len(), 1);
    assert_eq!(substitutions[0]["requested"], "max");
    assert_eq!(substitutions[0]["applied"], "high");
    assert_eq!(
        Inner::effort_state(&snapshot, "max").map(|(_, current, _)| current),
        Some(Some("high".to_string()))
    );

    // A refusal is not a failure either: the sequence records it and goes on.
    let mut refused = claude_session();
    let substitutions =
        Inner::apply_selection("claude-acp", &mut refused, &wanted, false, |_, _| async {
            Err(protocol::internal("Unknown config option: effort"))
        })
        .await;
    assert_eq!(substitutions.len(), 1);
    assert_eq!(substitutions[0]["applied"], Value::Null);
    assert_eq!(ReportedSelection::read(&refused).effort, None);
    assert_eq!(
        Inner::presented_snapshot("claude-acp", &refused, true),
        Inner::presented_snapshot("claude-acp", &claude_session(), true)
    );
}

#[tokio::test]
async fn a_stored_id_that_still_folds_an_effort_is_applied_as_its_two_halves() {
    // Until its harness has been probed once, a session stored before the
    // effort was split out of the model's name still carries the folded
    // id. `apply_model` sends the two halves the bridge keeps apart, and
    // the model it names back is the model half — which is the model that
    // was asked for, not one substituted for it.
    let mut snapshot = codex_session();
    let wanted = Selection {
        model: Some("gpt-5.5[xhigh]".to_string()),
        effort: None,
        fast: None,
    };
    let asked = StdMutex::new(Vec::new());
    let substitutions = Inner::apply_selection(
        "codex-acp",
        &mut snapshot,
        &wanted,
        false,
        |role, request| {
            asked
                .lock()
                .expect("asked")
                .push((role, request["value"].clone()));
            let answer = json!({ "configOptions": [
                { "id": "model", "category": "model", "type": "select", "currentValue": "gpt-5.5",
                  "options": [{ "value": "gpt-6-astra" }, { "value": "gpt-5.5" }] },
                { "id": "reasoning_effort", "category": "thought_level", "type": "select",
                  "currentValue": "xhigh", "options": [{ "value": "low" }, { "value": "xhigh" }] },
            ] });
            async move { Ok(answer) }
        },
    )
    .await;
    assert_eq!(
        *asked.lock().expect("asked"),
        vec![(OptionRole::Model, json!("gpt-5.5[xhigh]"))]
    );
    assert!(substitutions.is_empty(), "{substitutions:?}");
    assert_eq!(Inner::current_model(&snapshot).as_deref(), Some("gpt-5.5"));
}

#[test]
fn a_bridge_answer_that_states_no_options_never_silences_a_chats_controls() {
    // grok's cold `session/new` carries its models and no `configOptions`
    // key at all; storing that left the chat's effort control looking
    // unsupported for good.
    let cold = json!({ "models": { "currentModelId": "grok-4.6" }, "configOptions": [] });
    assert!(!Inner::replaces_snapshot(&cold, &grok_session()));
    // With nothing to lose it still gets through, so a bridge that keeps
    // its models outside the option list is not left without any.
    assert!(Inner::replaces_snapshot(
        &cold,
        &json!({ "configOptions": [] })
    ));
    assert!(Inner::replaces_snapshot(&grok_session(), &cold));

    // The same rule mid-sequence: `session/set_model` answers with nothing.
    let mut snapshot = grok_session();
    Inner::take_options(&mut snapshot, &json!({}));
    Inner::take_options(&mut snapshot, &json!({ "configOptions": [] }));
    assert_eq!(snapshot, grok_session());
}

/// A stored chat, as everything but its four selections is beside the
/// point here.
fn record_on(model: Option<&str>, effort: Option<&str>, fast: Option<bool>) -> SessionRecord {
    SessionRecord {
        id: "s1".to_string(),
        harness: "codex-acp".to_string(),
        account_id: None,
        bridge_session_id: Some("bridge-1".to_string()),
        cwd: "/work".to_string(),
        title: None,
        user_set_name: false,
        project_id: Some("p1".to_string()),
        persona_id: Some("agent-1".to_string()),
        model_id: model.map(str::to_string),
        reasoning_effort: effort.map(str::to_string),
        fast_mode: fast,
        legacy_model_id: None,
        hidden: false,
        created_at: "2026-09-14T00:00:00.000Z".to_string(),
        updated_at: "2026-09-14T00:00:00.000Z".to_string(),
        last_message_at: None,
        archived_at: None,
        message_count: 3,
        last_snippet: None,
        snapshot: None,
    }
}

#[test]
fn a_fork_opens_on_everything_the_chat_it_was_taken_from_was_running() {
    let meta = Inner::fork_meta(&record_on(Some("gpt-6-astra"), Some("ultra"), Some(true)));
    assert_eq!(
        meta,
        json!({
            "provider": "codex-acp",
            "projectId": "p1",
            "personaId": "agent-1",
            "model": "gpt-6-astra",
            "reasoningEffort": "ultra",
            "fastMode": true,
        })
    );
    // And `session/new` reads back exactly what the fork wrote.
    assert_eq!(
        Inner::wanted_from_meta(&json!({ "_meta": meta })),
        Selection {
            model: Some("gpt-6-astra".to_string()),
            effort: Some("ultra".to_string()),
            fast: Some(true),
        }
    );

    // A chat nobody chose for names nothing, and opens on whatever its
    // harness starts with.
    let bare = Inner::fork_meta(&record_on(None, None, None));
    assert_eq!(bare["model"], Value::Null);
    assert_eq!(
        Inner::wanted_from_meta(&json!({ "_meta": bare })),
        Selection::default()
    );
    assert_eq!(Inner::wanted_from_meta(&json!({})), Selection::default());
}

#[test]
fn what_a_bridge_would_not_do_is_the_only_record_of_a_downgrade() {
    // codex clamps the effort to the target model's own default on a model
    // change, and says so nowhere but in the options it answers with.
    let wanted = Selection {
        model: Some("gpt-5.5".to_string()),
        effort: Some("xhigh".to_string()),
        fast: None,
    };
    let clamped = Selection {
        model: Some("gpt-5.5".to_string()),
        effort: Some("medium".to_string()),
        fast: None,
    };
    let entries = Inner::substitutions_for(&wanted, &clamped);
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0],
        json!({
            "role": "effort",
            "requested": "xhigh",
            "applied": "medium",
            "reason": "not offered by gpt-5.5",
        })
    );

    // claude drops the effort entirely on a model that has none, and keeps
    // the fast intent it cannot show.
    let haiku = Selection {
        model: Some("haiku".to_string()),
        effort: None,
        fast: None,
    };
    let asked = Selection {
        model: Some("haiku".to_string()),
        effort: Some("xhigh".to_string()),
        fast: Some(true),
    };
    let entries = Inner::substitutions_for(&asked, &haiku);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["applied"], Value::Null);
    assert_eq!(entries[0]["reason"], "haiku has no effort control");
    assert_eq!(entries[1]["requested"], "on");
    assert_eq!(entries[1]["reason"], "haiku has no fast mode");

    // A model the agent would not take is named for what it is on.
    let elsewhere = Inner::substitutions_for(
        &wanted,
        &Selection {
            model: Some("gpt-6-astra".to_string()),
            effort: Some("xhigh".to_string()),
            fast: None,
        },
    );
    assert_eq!(elsewhere.len(), 1);
    assert_eq!(elsewhere[0]["role"], "model");
    assert_eq!(elsewhere[0]["applied"], "gpt-6-astra");

    // Nothing to report when the bridge did as it was asked.
    assert!(Inner::substitutions_for(&wanted, &wanted).is_empty());
    assert!(Inner::substitutions_for(&Selection::default(), &haiku).is_empty());
}

#[test]
fn a_presented_snapshot_carries_a_downgrade_next_to_the_provider_that_made_it() {
    let mut presented = Inner::presented_snapshot("claude-acp", &claude_session(), true);
    presented["_meta"] = json!({ "providerId": "claude-acp" });
    let entry = Inner::substitution("effort", "xhigh", Some("high"), "no".to_string());
    let carried = Inner::with_substitutions(presented.clone(), std::slice::from_ref(&entry));
    assert_eq!(carried["_meta"]["providerId"], "claude-acp");
    assert_eq!(carried["_meta"]["substitutions"], json!([entry]));
    // Nothing was refused, nothing is said.
    assert_eq!(Inner::with_substitutions(presented.clone(), &[]), presented);
}

/// A live session, as `claim_turn` reads one.
fn runtime_on(bridge_session_id: &str) -> SessionRuntime {
    SessionRuntime {
        harness: "claude-acp".to_string(),
        account_id: None,
        execution_profile: None,
        bridge_session_id: bridge_session_id.to_string(),
        generation: 0,
        loading: false,
        run: None,
        background: Default::default(),
        context: Default::default(),
        steer_queue: VecDeque::new(),
        native_steers: Vec::new(),
        snapshot: claude_session(),
        has_model_option: true,
        substitutions: Vec::new(),
        last_active: std::time::Instant::now(),
    }
}

#[test]
fn a_prompt_goes_to_the_bridge_session_its_runtime_names_as_the_run_is_registered() {
    let mut runtime = runtime_on("bridge-1");
    // A `reopen_on_model` that got in between the attach and the claim
    // closed `bridge-1` and opened another; the prompt must go to that one.
    runtime.bridge_session_id = "bridge-2".to_string();
    assert_eq!(
        Inner::claim_turn(&mut runtime, &ids()),
        Ok("bridge-2".to_string())
    );
    assert_eq!(
        runtime.run.as_ref().map(|run| run.run_id.as_str()),
        Some("run-1")
    );

    // The second prompt is told which run it found, and takes neither the
    // turn nor the session from it.
    let mut second = TurnIds::new();
    second.run_id = "run-2".to_string();
    assert_eq!(
        Inner::claim_turn(&mut runtime, &second),
        Err("run-1".to_string())
    );
    assert_eq!(
        runtime.run.as_ref().map(|run| run.run_id.as_str()),
        Some("run-1")
    );
}

#[test]
fn only_a_real_session_info_title_is_kept() {
    fn info(title: &str) -> Value {
        json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "session_info_update", "title": title },
        })
    }
    assert_eq!(
        Inner::agent_title(&info("  Fix the build ")),
        Some("Fix the build")
    );
    assert_eq!(Inner::agent_title(&info("   ")), None);
    let handoff = format!("{}chat", legacy_import::PERSONA_HANDOFF_PREFIX);
    assert_eq!(Inner::agent_title(&info(&handoff)), None);
    let chunk = json!({
        "update": { "sessionUpdate": "agent_message_chunk", "title": "no" }
    });
    assert_eq!(Inner::agent_title(&chunk), None);
}

fn runtime(harness: &str, bridge_session_id: &str, generation: u64) -> SessionRuntime {
    SessionRuntime {
        harness: harness.to_string(),
        account_id: None,
        execution_profile: None,
        bridge_session_id: bridge_session_id.to_string(),
        generation,
        loading: false,
        run: None,
        background: Default::default(),
        context: Default::default(),
        steer_queue: VecDeque::new(),
        native_steers: Vec::new(),
        snapshot: Value::Null,
        has_model_option: false,
        substitutions: Vec::new(),
        last_active: std::time::Instant::now(),
    }
}

#[test]
fn account_routes_isolate_identical_native_session_ids_and_bridge_exits() {
    let mut first = runtime("codex-acp", "native-shared", 1);
    first.account_id = Some("account-one".into());
    let first_key = first.route_key();
    let mut second = runtime("codex-acp", "native-shared", 2);
    second.account_id = Some("account-two".into());
    let second_key = second.route_key();
    let mut table = SessionTable::default();
    table.insert("host-one".into(), first);
    table.insert("host-two".into(), second);
    assert_ne!(first_key, second_key);
    assert_eq!(
        table.host_session_for(&first_key, "native-shared"),
        Some("host-one")
    );
    assert_eq!(
        table.host_session_for(&second_key, "native-shared"),
        Some("host-two")
    );
    table.retain(|runtime| !runtime.served_by(&first_key, 1));
    assert!(table.get("host-one").is_none());
    assert_eq!(
        table.host_session_for(&second_key, "native-shared"),
        Some("host-two")
    );
    table.rebind("host-two", "native-new".into());
    assert!(table
        .host_session_for(&second_key, "native-shared")
        .is_none());
    assert_eq!(
        table.host_session_for(&second_key, "native-new"),
        Some("host-two")
    );
}

#[test]
fn provider_account_bridges_require_an_explicit_identity() {
    assert_ne!(
        account_route_key("codex-acp", None),
        account_route_key("codex-acp", Some("account-one"))
    );
    assert_ne!(
        account_route_key("codex-acp", Some("account-one")),
        account_route_key("claude-acp", Some("account-one"))
    );
    for provider in ["codex-acp", "claude-acp"] {
        assert!(account_validation_id(provider, None).is_err());
        assert_eq!(
            account_validation_id(provider, Some("saved-account")).unwrap(),
            Some("saved-account")
        );
    }
    assert_eq!(account_validation_id("kimi", None).unwrap(), None);
}

#[test]
fn cli_benchmark_identities_are_checked_before_dispatch() {
    for provider in ["kimi-acp", "grok-acp"] {
        let identity = provider_accounts::cli_login_account_id(provider).unwrap();
        assert_eq!(
            account_quota_id(provider, Some(&identity)).unwrap(),
            Some(identity.as_str())
        );
        assert_eq!(account_quota_id(provider, None).unwrap(), None);
        assert_eq!(
            account_quota_id(provider, Some("cli-login-other")).unwrap(),
            None
        );
    }
    assert!(account_quota_id("codex-acp", None).is_err());
    assert_eq!(
        account_quota_id("codex-acp", Some("saved")).unwrap(),
        Some("saved")
    );
}

#[test]
fn an_ordinary_chat_of_a_cli_sign_in_checks_the_sign_ins_allowance() {
    for provider in ["kimi-acp", "grok-acp"] {
        let identity = provider_accounts::cli_login_account_id(provider).unwrap();
        // The chat stores no account: the sign-in is asked, and only asked.
        assert_eq!(
            quota_identity(provider, None).unwrap(),
            Some((identity.clone(), true))
        );
        // A benchmark lease names it outright.
        assert_eq!(
            quota_identity(provider, Some(&identity)).unwrap(),
            Some((identity, false))
        );
        // An account of some other provider is nobody's allowance here.
        assert_eq!(
            quota_identity(provider, Some("cli-login-other")).unwrap(),
            None
        );
    }
    // Saved-account providers keep their own rule: a chat has to name one.
    assert!(quota_identity("codex-acp", None).is_err());
    assert_eq!(
        quota_identity("claude-acp", Some("saved")).unwrap(),
        Some(("saved".into(), false))
    );
}

#[test]
fn a_fork_keeps_its_account_and_unassigned_chats_do_not_invent_one() {
    let mut record = record_on(None, None, None);
    record.account_id = Some("account-one".into());
    assert_eq!(Inner::fork_meta(&record)["accountId"], "account-one");
    record.account_id = None;
    assert!(Inner::fork_meta(&record).get("accountId").is_none());
}

#[test]
fn a_chat_that_let_go_of_its_bridge_session_does_not_resume_it() {
    let mut record = SessionRecord {
        id: "session-1".to_string(),
        harness: "claude-acp".to_string(),
        account_id: None,
        bridge_session_id: Some("bridge-1".to_string()),
        cwd: "C:\\work".to_string(),
        title: None,
        user_set_name: false,
        project_id: None,
        persona_id: None,
        model_id: None,
        reasoning_effort: None,
        fast_mode: None,
        legacy_model_id: None,
        hidden: false,
        created_at: "2026-09-11T00:00:00.000Z".to_string(),
        updated_at: "2026-09-11T00:00:00.000Z".to_string(),
        last_message_at: None,
        archived_at: None,
        message_count: 1,
        last_snippet: None,
        snapshot: None,
    };
    assert_eq!(
        Inner::resumable_bridge_session(&record),
        Some("bridge-1"),
        "an attach resumes the bridge session the row names"
    );

    // Never prompted: the agent never saved that bridge session.
    record.message_count = 0;
    assert_eq!(Inner::resumable_bridge_session(&record), None);
    record.message_count = 1;

    // What `release_bridge_session` leaves behind after a folder move: the
    // bridge session it ran in is gone for good, so the attach has to open a
    // new one in the new folder instead of loading the old one — never the
    // chat's own id, which for an imported chat *is* the old bridge session.
    record.bridge_session_id = None;
    assert_eq!(Inner::resumable_bridge_session(&record), None);
    record.bridge_session_id = Some(String::new());
    assert_eq!(Inner::resumable_bridge_session(&record), None);
}

#[test]
fn a_session_still_being_attached_has_no_route() {
    let mut loading = runtime("claude-acp", "stored-id", 7);
    loading.loading = true;
    assert_eq!(loading.route(), None);
    loading.loading = false;
    assert_eq!(
        loading.route(),
        Some(("claude-acp".to_string(), "stored-id".to_string(), 7))
    );
}

#[test]
fn only_the_sessions_of_the_bridge_that_died_are_forgotten() {
    let old = runtime("claude-acp", "a", 1);
    let replacement = runtime("claude-acp", "b", 2);
    let other_harness = runtime("codex-acp", "c", 1);

    // The crashed process is generation 1: its own session goes, the one
    // already re-attached to the replacement stays, and a same-generation
    // session of another harness is none of its business.
    assert!(old.served_by("claude-acp", 1));
    assert!(!replacement.served_by("claude-acp", 1));
    assert!(!other_harness.served_by("claude-acp", 1));
}

#[test]
fn a_bridge_nobody_uses_is_shut_down_once_its_idle_window_has_passed() {
    let last_used = std::time::Instant::now();
    // Spawned for a model list, then left alone: no chat, no request, no
    // task holding it.
    assert!(Inner::bridge_is_reapable(
        0,
        0,
        0,
        last_used,
        last_used + BRIDGE_IDLE_TIMEOUT
    ));
    assert!(Inner::bridge_is_reapable(
        0,
        0,
        0,
        last_used,
        last_used + BRIDGE_IDLE_TIMEOUT * 12
    ));
}

#[test]
fn a_bridge_with_a_chat_attached_is_never_shut_down() {
    let last_used = std::time::Instant::now();
    // However long the chat has sat there: shutting its bridge down would
    // lose the agent's context behind it.
    for idle in [BRIDGE_IDLE_TIMEOUT, BRIDGE_IDLE_TIMEOUT * 1000] {
        assert!(!Inner::bridge_is_reapable(
            1,
            0,
            0,
            last_used,
            last_used + idle
        ));
    }
}

#[test]
fn a_bridge_used_within_its_idle_window_is_kept() {
    let last_used = std::time::Instant::now();
    let one_second = std::time::Duration::from_secs(1);
    assert!(!Inner::bridge_is_reapable(0, 0, 0, last_used, last_used));
    assert!(!Inner::bridge_is_reapable(
        0,
        0,
        0,
        last_used,
        last_used + BRIDGE_IDLE_TIMEOUT - one_second
    ));
    // A clock read before the last use (the use raced the check) is no
    // idle time at all.
    assert!(!Inner::bridge_is_reapable(
        0,
        0,
        0,
        last_used + one_second,
        last_used
    ));
}

#[test]
fn a_bridge_with_work_in_hand_is_kept_however_long_ago_it_was_touched() {
    let last_used = std::time::Instant::now();
    let long_after = last_used + BRIDGE_IDLE_TIMEOUT * 12;
    // A request still waiting for its answer, such as a turn that has run
    // for an hour.
    assert!(!Inner::bridge_is_reapable(0, 1, 0, last_used, long_after));
    // A task that took the bridge for an attach or a probe and has not
    // sent anything yet.
    assert!(!Inner::bridge_is_reapable(0, 0, 1, last_used, long_after));
}

/// An attached chat last used at `last_active`, with nothing running.
fn idle_since(last_active: std::time::Instant) -> SessionRuntime {
    let mut idle = runtime("claude-acp", "a", 1);
    idle.last_active = last_active;
    idle
}

#[test]
fn only_an_ordinary_kimi_chat_keeps_turns_read_from_its_session_record() {
    let chunk = || json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Next step"}}});
    let mut kimi = runtime("kimi-acp", "session_example", 3);
    // The bridge sending a turn no prompt of the chat runs is refused...
    assert!(!Inner::accept_update(&mut kimi, None, &mut chunk(), false));
    // ...while the host's reading of the record is the chat's.
    assert!(Inner::accept_update(&mut kimi, None, &mut chunk(), true));
    let mut owned = runtime("kimi-acp", "session_owned", 3);
    owned.execution_profile = Some("text".into());
    assert!(!Inner::accept_update(&mut owned, None, &mut chunk(), true));
    let mut claude = runtime("claude-acp", "example", 3);
    assert!(!Inner::accept_update(&mut claude, None, &mut chunk(), true));
}

#[test]
fn ordinary_claude_continues_after_prompt_without_accepting_stale_or_cancelled_runs() {
    let mut live = runtime("claude-acp", "example", 7);
    let turn = TurnIds::new();
    Inner::claim_turn(&mut live, &turn).unwrap();
    live.run = None; // The foreground prompt returned end_turn.
    let chunk = || json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Verified output"}}});
    assert!(!Inner::accept_turn_update(
        &mut live,
        Some(&turn.run_id),
        &mut chunk()
    ));
    let mut followup = chunk();
    assert!(Inner::accept_turn_update(&mut live, None, &mut followup));
    assert_eq!(
        followup["update"]["_meta"]["distill"]["messageId"],
        turn.message_id
    );
    assert_ne!(
        followup["update"]["_meta"]["distill"]["assistantMessageId"],
        turn.assistant_message_id
    );
    live.background.cancel();
    assert!(!Inner::accept_turn_update(&mut live, None, &mut chunk()));
}

mod self_started {
    use super::super::events::UpdateDelivery;
    use super::*;

    fn active_chat(provider: &str) -> (SessionRuntime, TurnIds) {
        let mut live = runtime(provider, "bridge", 7);
        let turn = TurnIds::new();
        Inner::claim_turn(&mut live, &turn).unwrap();
        live.run = None;
        (live, turn)
    }

    fn text(value: &str) -> Value {
        json!({"sessionUpdate":"agent_message_chunk","messageId":format!("msg_{value}"),
            "content":{"type":"text","text":value},"_meta":{"jetbrains":{"air":{"version":1,"phase":"final_answer"}}}})
    }

    fn status(state: &str) -> Value {
        let mut status = json!({"type":state});
        if state == "active" {
            status["activeFlags"] = json!([]);
        }
        json!({"sessionUpdate":"session_info_update","_meta":{"codex":{"threadStatus":status}}})
    }

    // The managed ACP v1 capture. Split and cached counts are the bridge's
    // own per-turn totals. The third turn performed two model calls.
    fn usage(used: u64, total: u64, input: u64, cached: u64, output: u64) -> Value {
        json!({"sessionUpdate":"usage_update","used":used,"size":475000,"_meta":{"codexTurnUsage":{
            "totalTokens":total,"inputTokens":input,"cachedReadTokens":cached,"cachedWriteTokens":0,
            "outputTokens":output,"thoughtTokens":0}}})
    }

    fn route(
        live: &mut SessionRuntime,
        run: Option<&str>,
        update: Value,
        pending: &mut Vec<(String, Value)>,
    ) {
        let mut params = json!({"sessionId":"s1","update":update});
        if Inner::route_update(live, run, &mut params, false, false) == UpdateDelivery::Store {
            Inner::stage_background_result(pending, ("s1".into(), params));
        }
    }

    #[tokio::test]
    async fn codex_goal_stores_and_delivers_all_three_replies() {
        let dir = crate::test_support::TempRoot::new();
        let store = SessionStore::open(&dir.path().join("host.db"))
            .await
            .unwrap();
        dir.register(&store.pool);
        store
            .insert_session(&record_on(None, None, None))
            .await
            .unwrap();
        let mut live = runtime("codex-acp", "bridge", 7);
        let turn = TurnIds::new();
        Inner::claim_turn(&mut live, &turn).unwrap();
        let mut pending = Vec::new();
        for prompt in Inner::user_prompt_events(
            "s1",
            &json!([{"type":"text","text":"count to three"}]),
            &json!({}),
            &turn,
            "now",
            false,
        ) {
            pending.push(("s1".into(), prompt));
        }
        for update in [
            status("active"),
            text("1"),
            usage(17805, 17805, 3848, 13952, 5),
            status("idle"),
        ] {
            route(&mut live, Some(&turn.run_id), update, &mut pending);
        }
        // The reader has resolved session/prompt. Even if its host future is
        // still draining the store, the next wire events have no prompt tag.
        for update in [
            status("active"),
            text("2"),
            usage(20527, 20527, 2986, 17536, 5),
            status("idle"),
            status("active"),
            usage(21771, 21771, 1398, 20352, 21),
            text("3"),
            usage(21990, 43761, 9431, 34304, 26),
            status("idle"),
        ] {
            route(&mut live, None, update, &mut pending);
        }
        live.run = None;
        let mut visible = Vec::new();
        Inner::persist_pending_events(&store, &mut pending, |payload, id| {
            visible.extend(Inner::frontend_event(payload, id));
        })
        .await
        .unwrap();
        assert_eq!(
            store.latest_prompt_id("s1").await.unwrap().as_deref(),
            Some(turn.message_id.as_str())
        );
        let stored = store.list_events("s1").await.unwrap();
        let page = store.history_page("s1", None).await.unwrap();
        let snapshot: Vec<String> = page.events.iter().map(|row| row.get().to_owned()).collect();
        let (legacy, _) = store.replay_payloads("s1").await.unwrap();
        for history in [snapshot, legacy] {
            let mut bubbles: Vec<String> = Vec::new();
            let mut new_reply = true;
            for row in history {
                let event: Value = row.parse().unwrap();
                let update = &event["update"];
                if update["_meta"].get("activeRunId") == Some(&Value::Null) {
                    new_reply = true;
                } else if update["sessionUpdate"] == "agent_message_chunk" {
                    if new_reply {
                        bubbles.push(String::new());
                        new_reply = false;
                    }
                    bubbles
                        .last_mut()
                        .unwrap()
                        .push_str(update["content"]["text"].as_str().unwrap());
                }
            }
            assert_eq!(bubbles, ["1", "2", "3"]);
        }
        let mut cursor = Some(page.high_water_event_id + 1);
        for number in ["3", "2", "1"] {
            let page = store.history_page("s1", cursor).await.unwrap();
            let answers: Vec<Value> = page
                .events
                .iter()
                .map(|row| row.get().parse::<Value>().unwrap())
                .filter(|row| row["update"]["sessionUpdate"] == "agent_message_chunk")
                .map(|row| row["update"]["content"]["text"].clone())
                .collect();
            assert_eq!(answers, [json!(number)]);
            cursor = page.older_cursor;
        }
        assert!(cursor.is_none());
        for events in [stored, visible] {
            let replies: Vec<_> = events
                .iter()
                .map(|p| &p["update"])
                .filter(|u| u["sessionUpdate"] == "agent_message_chunk")
                .collect();
            assert_eq!(
                replies
                    .iter()
                    .map(|u| u["content"]["text"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["1", "2", "3"]
            );
            let stamps: Vec<_> = replies.iter().map(|u| &u["_meta"]["distill"]).collect();
            assert_eq!(stamps[0]["assistantMessageId"], turn.assistant_message_id);
            for i in 1..3 {
                assert_eq!(stamps[i]["messageId"], turn.message_id);
                assert_eq!(replies[i]["messageId"], stamps[i]["assistantMessageId"]);
                assert_eq!(stamps[i]["autonomous"], true);
                assert_ne!(
                    stamps[i]["assistantMessageId"],
                    stamps[i - 1]["assistantMessageId"]
                );
                assert_ne!(stamps[i]["runId"], stamps[i - 1]["runId"]);
                assert!(events.iter().any(|p| p["update"]["_meta"]["distill"]
                    ["autonomousFinished"]
                    == true
                    && p["update"]["_meta"]["codex"]["threadStatus"]["type"] == "idle"
                    && p["update"]["_meta"]["distill"]["runId"] == stamps[i]["runId"]));
            }
        }
        assert!(live.background.active_run_id().is_none());
        Inner::claim_turn(&mut live, &TurnIds::new()).unwrap();
        dir.close().await;
    }

    #[test]
    fn codex_bills_the_final_turn_total_once() {
        let (mut live, _) = active_chat("codex-acp");
        let mut pending = Vec::new();
        for update in [
            status("active"),
            usage(21771, 21771, 1398, 20352, 21),
            text("3"),
            usage(21990, 43761, 9431, 34304, 26),
            status("idle"),
            status("idle"),
        ] {
            route(&mut live, None, update, &mut pending);
        }
        let deltas: Vec<_> = pending
            .iter()
            .map(|(_, p)| &p["update"])
            .filter(|u| u["sessionUpdate"] == "message_usage")
            .collect();
        assert_eq!(deltas.len(), 1);
        assert_eq!(
            deltas[0]["usage"],
            json!({"inputTokens":9431,"outputTokens":26,"cacheReadTokens":34304,"cacheWriteTokens":0})
        );
    }

    #[test]
    fn grok_completion_bills_and_settles_even_when_the_ledger_uses_a_separate_channel() {
        let (mut live, _) = active_chat("grok-acp");
        let mut pending = Vec::new();
        route(&mut live, None, text("2"), &mut pending);
        // Grok 1.0.40, after the foreground response: a background command
        // finished, the model sent "2", then this billed terminal arrived.
        let mut end = json!({"sessionId":"bridge","update":{"sessionUpdate":"turn_completed",
            "prompt_id":"task-completed-cdea056d-c3e2-4154-9299-3da48cc2137a",
            "stop_reason":"end_turn","elapsed_ms":1176,"usage":{
                "inputTokens":19709,"outputTokens":45,"totalTokens":19754,"cachedReadTokens":19456,
                "cacheCreationTokens":0,"reasoningTokens":44,"modelCalls":1,"apiDurationMs":1082,
                "costUsdTicks":105040000,"numTurns":1}}});
        assert!(Inner::normalize_xai_turn_usage(
            "_x.ai/session_notification",
            &mut end
        ));
        route(&mut live, None, end["update"].take(), &mut pending);
        assert_eq!(pending.len(), 3);
        assert_eq!(
            pending[1].1["update"]["usage"],
            json!({
                "inputTokens":253,"outputTokens":45,"cacheReadTokens":19456,"cacheWriteTokens":0,"elapsedMs":1082
            })
        );
        assert_eq!(
            pending[2].1["update"]["sessionUpdate"],
            "session_info_update"
        );
        assert_eq!(
            pending[2].1["update"]["_meta"]["distill"]["autonomousFinished"],
            true
        );
        assert!(!live.background.is_busy());
    }

    #[test]
    fn grok_error_completion_without_usage_settles_without_a_ledger_entry() {
        let (mut live, _) = active_chat("grok-acp");
        let mut pending = Vec::new();
        route(&mut live, None, text("2"), &mut pending);
        let mut end = json!({"sessionId":"bridge","update":{"sessionUpdate":"turn_completed",
            "prompt_id":"p","stop_reason":"error","agent_result":"API error (status 402 Payment Required): Grok Build usage balance exhausted",
            "elapsed_ms":342}});
        assert!(!Inner::normalize_xai_turn_usage(
            "_x.ai/session_notification",
            &mut end
        ));
        assert!(
            Inner::unbilled_xai_completion("_x.ai/session_notification", Some("old"), &end)
                .is_none()
        );
        let closing =
            Inner::unbilled_xai_completion("_x.ai/session_notification", None, &end).unwrap();
        route(&mut live, None, closing, &mut pending);
        assert_eq!(pending.len(), 2);
        assert_eq!(
            pending[1].1["update"]["_meta"]["distill"]["autonomousFinished"],
            true
        );
        assert!(!live.background.is_busy());
    }

    #[test]
    fn ordinary_background_turn_holds_the_chat_and_its_dispatch_slot() {
        let (mut live, _) = active_chat("example");
        let mut pending = Vec::new();
        route(&mut live, None, text("2"), &mut pending);
        assert!(live.has_pending_chat_work());
        assert!(!Inner::session_is_evictable(
            &live,
            true,
            live.last_active + SESSION_IDLE_TIMEOUT
        ));
        assert_eq!(
            Inner::claim_turn(&mut live, &TurnIds::new()).unwrap_err(),
            live.background.active_run_id().unwrap()
        );
        route(
            &mut live,
            None,
            json!({"sessionUpdate":"message_usage",
            "usage":{"inputTokens":8,"outputTokens":5,"cacheReadTokens":2}}),
            &mut pending,
        );
        assert!(!live.has_pending_chat_work());
        assert_eq!(
            pending.last().unwrap().1["update"]["_meta"]["distill"]["autonomousFinished"],
            true
        );
        Inner::claim_turn(&mut live, &TurnIds::new()).unwrap();
    }

    #[test]
    fn stop_closes_the_reply_and_rejects_its_tail() {
        for provider in ["codex-acp", "grok-acp", "example"] {
            let (mut live, _) = active_chat(provider);
            let mut pending = Vec::new();
            route(&mut live, None, text("2"), &mut pending);
            let id = live.background.active_run_id().unwrap().to_owned();
            let (_, stopped) = live.stop("s1");
            assert_eq!(stopped.unwrap()["update"]["_meta"]["distill"]["runId"], id);
            route(&mut live, None, text("late"), &mut pending);
            assert_eq!(pending.len(), 1);
            assert!(!live.has_pending_chat_work());
        }
    }

    #[test]
    fn silent_turn_releases_the_composer_only_after_its_last_update_expires() {
        let (mut live, _) = active_chat("example");
        let mut pending = Vec::new();
        route(&mut live, None, text("2"), &mut pending);
        let now = std::time::Instant::now();
        assert!(live.background.expire(now, "s1").is_none());
        let end = live
            .background
            .expire(
                now + crate::services::agent_host::background::CONTINUATION_SILENCE,
                "s1",
            )
            .unwrap();
        assert_eq!(
            end["update"]["_meta"]["distill"]["autonomousFinished"],
            true
        );
        assert!(live.background.active_run_id().is_none());
        Inner::claim_turn(&mut live, &TurnIds::new()).unwrap();
    }

    #[test]
    fn a_finished_prompts_tag_cannot_open_or_join_a_background_reply() {
        let (mut live, turn) = active_chat("codex-acp");
        let mut pending = Vec::new();
        route(&mut live, Some(&turn.run_id), text("stale"), &mut pending);
        assert!(pending.is_empty());
        route(&mut live, None, text("2"), &mut pending);
        route(&mut live, Some(&turn.run_id), text("stale"), &mut pending);
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn owned_and_kimi_routes_reject_unsolicited_bridge_replies() {
        for provider in ["claude-acp", "codex-acp", "grok-acp", "kimi-acp", "example"] {
            let (mut live, _) = active_chat(provider);
            let mut pending = Vec::new();
            for profile in ["text-only", "repository"] {
                live.execution_profile = Some(profile.into());
                route(&mut live, None, text("owned"), &mut pending);
            }
            if provider == "kimi-acp" {
                live.execution_profile = None;
                route(&mut live, None, text("relay only"), &mut pending);
            }
            assert!(pending.is_empty(), "{provider}");
        }
    }
}

#[test]
fn background_jobs_keep_an_idle_chat_attached_until_they_finish() {
    let now = std::time::Instant::now();
    let mut live = idle_since(now);
    let mut spawned = json!({"update":{"sessionUpdate":"async_task_spawned","asyncTaskId":"job"}});
    assert!(Inner::accept_turn_update(&mut live, None, &mut spawned));
    assert!(!Inner::session_is_evictable(
        &live,
        true,
        now + SESSION_IDLE_TIMEOUT * 10
    ));
    let mut ended = json!({"update":{"sessionUpdate":"async_task_state_update","asyncTaskId":"job","state":"completed"}});
    assert!(Inner::accept_turn_update(&mut live, None, &mut ended));
    assert!(Inner::session_is_evictable(
        &live,
        true,
        now + SESSION_IDLE_TIMEOUT * 10
    ));
}

#[test]
fn a_chat_nobody_uses_lets_go_of_its_bridge_session_once_its_idle_window_has_passed() {
    let last_active = std::time::Instant::now();
    let idle = idle_since(last_active);
    assert!(Inner::session_is_evictable(
        &idle,
        true,
        last_active + SESSION_IDLE_TIMEOUT
    ));
    assert!(Inner::session_is_evictable(
        &idle,
        true,
        last_active + SESSION_IDLE_TIMEOUT * 10
    ));

    let one_second = std::time::Duration::from_secs(1);
    assert!(!Inner::session_is_evictable(&idle, true, last_active));
    assert!(!Inner::session_is_evictable(
        &idle,
        true,
        last_active + SESSION_IDLE_TIMEOUT - one_second
    ));
    // A clock read before the last use (the use raced the check) is no
    // idle time at all.
    assert!(!Inner::session_is_evictable(
        &idle_since(last_active + one_second),
        true,
        last_active
    ));
}

#[test]
fn a_chat_with_work_in_hand_or_no_way_back_keeps_its_bridge_session() {
    let last_active = std::time::Instant::now();
    let long_after = last_active + SESSION_IDLE_TIMEOUT * 10;

    // A turn that has run for hours: its updates route through the runtime.
    let mut running = idle_since(last_active);
    running.run = Some(RunState::start(&ids()));
    assert!(!Inner::session_is_evictable(&running, true, long_after));

    // A message steered in, waiting for its turn.
    let mut queued = idle_since(last_active);
    queued.steer_queue.push_back(QueuedPrompt {
        prompt: json!([{ "type": "text", "text": "also this" }]),
        meta: json!({}),
        ids: TurnIds::new(),
    });
    assert!(!Inner::session_is_evictable(&queued, true, long_after));

    // An attach in flight, which makes the runtime live when it is done.
    let mut loading = idle_since(last_active);
    loading.loading = true;
    assert!(!Inner::session_is_evictable(&loading, true, long_after));

    // A bridge that cannot load the session again would start the chat
    // over without the agent's context.
    assert!(!Inner::session_is_evictable(
        &idle_since(last_active),
        false,
        long_after
    ));
}

#[test]
fn only_a_bridge_that_cannot_load_sessions_keeps_its_chats_attached() {
    // The process that accepted the session is the one running.
    assert!(Inner::resumable_after_release(Some((3, true)), 3));
    assert!(!Inner::resumable_after_release(Some((3, false)), 3));
    // That process is gone, replaced or not: its sessions went with it,
    // so letting go of the runtime loses nothing.
    assert!(Inner::resumable_after_release(Some((4, false)), 3));
    assert!(Inner::resumable_after_release(None, 3));
}

#[test]
fn an_update_finds_its_chat_by_the_bridge_session_it_came_from() {
    let mut table = SessionTable::default();
    table.insert("chat-1".to_string(), runtime("claude-acp", "a", 1));
    table.insert("chat-2".to_string(), runtime("codex-acp", "a", 1));
    table.insert("chat-3".to_string(), runtime("claude-acp", "b", 1));
    assert_eq!(table.host_session_for("claude-acp", "a"), Some("chat-1"));
    // The same bridge id under another harness is another session.
    assert_eq!(table.host_session_for("codex-acp", "a"), Some("chat-2"));
    assert_eq!(table.host_session_for("claude-acp", "b"), Some("chat-3"));
    // A probe or naming session nobody attached.
    assert_eq!(table.host_session_for("claude-acp", "probe"), None);
    assert_eq!(table.host_session_for("grok", "a"), None);

    // An attach that could not resume the stored session opened another.
    let rebound = table.rebind("chat-1", "c".to_string());
    assert_eq!(
        rebound.map(|runtime| runtime.bridge_session_id.as_str()),
        Some("c")
    );
    assert_eq!(table.host_session_for("claude-acp", "a"), None);
    assert_eq!(table.host_session_for("claude-acp", "c"), Some("chat-1"));
    assert!(table.rebind("nobody", "d".to_string()).is_none());

    // Re-registering a chat (a reopen, a move) replaces its old route.
    table.insert("chat-3".to_string(), runtime("codex-acp", "e", 2));
    assert_eq!(table.host_session_for("claude-acp", "b"), None);
    assert_eq!(table.host_session_for("codex-acp", "e"), Some("chat-3"));

    // Let go of, deleted, or gone with its bridge process.
    assert!(table.remove("chat-1").is_some());
    assert!(table.remove("chat-1").is_none());
    assert_eq!(table.host_session_for("claude-acp", "c"), None);
    table.retain(|runtime| !runtime.served_by("codex-acp", 2));
    assert_eq!(table.host_session_for("codex-acp", "e"), None);
    assert_eq!(table.host_session_for("codex-acp", "a"), Some("chat-2"));
    assert_eq!(table.values().count(), 1);
}

#[test]
fn a_restarted_bridge_cannot_reuse_the_old_process_session_route() {
    let mut table = SessionTable::default();
    table.insert("old-chat".into(), runtime("codex-acp", "reused-id", 7));
    assert_eq!(
        table.host_session_for_generation("codex-acp", 7, "reused-id"),
        Some("old-chat")
    );
    table.remove("old-chat");
    table.insert("new-chat".into(), runtime("codex-acp", "reused-id", 8));
    assert_eq!(
        table.host_session_for_generation("codex-acp", 7, "reused-id"),
        None
    );
    assert_eq!(
        table.host_session_for_generation("codex-acp", 8, "reused-id"),
        Some("new-chat")
    );
    assert_eq!(
        table.host_session_for_generation("claude-acp", 8, "reused-id"),
        None
    );
}

#[test]
fn permission_responses_cannot_answer_requests_from_a_replacement_process() {
    let (original, mut original_output) = super::super::bridge::tests::silent_bridge();
    let (replacement, mut replacement_output) = super::super::bridge::tests::silent_bridge();
    let request = || ClientRequest {
        harness: "test-acp".into(),
        generation: original.generation(),
        bridge_id: json!(7),
        method: "session/request_permission".into(),
    };
    let approved = Ok(json!({"outcome": {"outcome": "selected", "optionId": "allow-once"}}));
    request().respond(&replacement, approved.clone());
    assert!(replacement_output.try_recv().is_err());
    assert!(original_output.try_recv().is_err());
    request().respond(&original, approved);
    let response: Value = serde_json::from_str(&original_output.try_recv().unwrap()).unwrap();
    assert_eq!(response["id"], 7);
    assert_eq!(response["result"]["outcome"]["optionId"], "allow-once");
}

#[test]
fn a_second_chat_on_one_bridge_session_is_still_found_when_the_first_goes() {
    let mut table = SessionTable::default();
    table.insert("chat-1".to_string(), runtime("claude-acp", "a", 1));
    table.insert("chat-2".to_string(), runtime("claude-acp", "a", 1));
    let first = table
        .host_session_for("claude-acp", "a")
        .map(str::to_string);
    let first = first.expect("one of the two chats is found");
    table.remove(&first);
    let second = if first == "chat-1" {
        "chat-2"
    } else {
        "chat-1"
    };
    assert_eq!(table.host_session_for("claude-acp", "a"), Some(second));
    table.remove(second);
    assert_eq!(table.host_session_for("claude-acp", "a"), None);
}

#[test]
fn an_answer_goes_to_the_socket_that_asked_and_nowhere_else() {
    let (socket_a, mut heard_a) = mpsc::unbounded_channel::<String>();
    let (_socket_b, mut heard_b) = mpsc::unbounded_channel::<String>();
    Inner::reply_on(
        &socket_a,
        "session/new",
        protocol::response(json!(0), json!({ "sessionId": "s1" })),
    );
    assert!(heard_a.try_recv().is_ok());
    assert!(heard_b.try_recv().is_err());

    // The renderer gave up on that socket: its answer is dropped rather
    // than delivered to the next connection, where id 0 is another call.
    drop(heard_a);
    Inner::reply_on(
        &socket_a,
        "session/new",
        protocol::response(json!(0), json!({ "sessionId": "s2" })),
    );
    assert!(heard_b.try_recv().is_err());
}

#[test]
fn stopping_a_turn_forgets_the_messages_steered_into_it() {
    let mut live = runtime("claude-acp", "a", 1);
    live.run = Some(RunState::start(&ids()));
    for _ in 0..2 {
        live.steer_queue.push_back(QueuedPrompt {
            prompt: json!([{ "type": "text", "text": "also this" }]),
            meta: json!({}),
            ids: TurnIds::new(),
        });
    }

    assert_eq!(live.drop_queued_steers(), 2);
    assert!(live.steer_queue.is_empty());
    // Cancelling does not end the turn itself: its `session/prompt` is
    // still in flight and its run state still stamps the updates arriving.
    assert!(live.run.is_some());
    assert_eq!(live.drop_queued_steers(), 0);
}

#[test]
fn a_burst_of_updates_is_stored_per_chat_without_reordering_the_log() {
    let chunk = |text: &str| json!({ "update": { "content": { "text": text } } });
    let grouped = Inner::group_events_by_session(vec![
        ("a".to_string(), chunk("a1")),
        ("a".to_string(), chunk("a2")),
        // Another chat streaming at the same time: merging across it would
        // put "a3" in the log before "b1", which is not the order the
        // updates arrived in.
        ("b".to_string(), chunk("b1")),
        ("a".to_string(), chunk("a3")),
    ]);

    let shape: Vec<(&str, Vec<&str>)> = grouped
        .iter()
        .map(|(session_id, payloads)| {
            (
                session_id.as_str(),
                payloads
                    .iter()
                    .map(|payload| payload["update"]["content"]["text"].as_str().unwrap_or(""))
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        shape,
        vec![
            ("a", vec!["a1", "a2"]),
            ("b", vec!["b1"]),
            ("a", vec!["a3"])
        ]
    );
    assert!(Inner::group_events_by_session(Vec::new()).is_empty());
}

#[test]
fn a_rejected_prompt_is_withdrawn_only_on_proof_that_its_turn_produced_nothing() {
    let mut live = runtime("claude-acp", "a", 1);
    live.run = Some(RunState::start(&ids()));

    // The bridge answered the prompt with an error and sent nothing at all:
    // the turn never happened, so the message comes back out of the log.
    assert!(Inner::turn_produced_nothing(Some(&live), "run-1"));

    // One update is enough to make it a turn that happened.
    live.run.as_mut().expect("run").saw_update = true;
    assert!(!Inner::turn_produced_nothing(Some(&live), "run-1"));

    // The bridge died mid-turn: `fail_pending_on_exit` failed the prompt and
    // the `Exited` behind it removed the runtime while the turn was still
    // unwinding. The reply it streamed is in the transcript, so the absence
    // of evidence must not be read as "nothing happened".
    assert!(!Inner::turn_produced_nothing(None, "run-1"));

    // Same for a runtime that is no longer running this turn, or is running
    // the next one.
    live.run = None;
    assert!(!Inner::turn_produced_nothing(Some(&live), "run-1"));
    live.run = Some(RunState::start(&TurnIds::new()));
    assert!(!Inner::turn_produced_nothing(Some(&live), "run-1"));
}

#[test]
fn a_turn_that_failed_after_producing_output_records_the_reason_with_its_end() {
    let update = Inner::turn_failed_update("s1", "bridge exited");
    assert_eq!(update["sessionId"], "s1");
    assert_eq!(update["update"]["sessionUpdate"], "session_info_update");
    let meta = &update["update"]["_meta"];
    // Ends the run the way `run_settled_update` does, and says why.
    assert!(meta["activeRunId"].is_null());
    assert_eq!(meta["turnFailed"]["reason"], "bridge exited");
}

#[test]
fn a_turn_nobody_awaits_reports_its_end_as_a_cleared_active_run() {
    let update = protocol::run_settled_update("s1");
    assert_eq!(update["sessionId"], "s1");
    assert_eq!(update["update"]["sessionUpdate"], "session_info_update");
    // `acpSessionInfoUpdate.ts` keys off `"activeRunId" in meta` and treats
    // a non-string as null, so the key has to be present and explicitly
    // null rather than omitted.
    let meta = &update["update"]["_meta"];
    assert!(meta
        .as_object()
        .is_some_and(|meta| meta.get("activeRunId").is_some_and(Value::is_null)));
}

#[test]
fn stopping_a_background_reply_ends_the_run_the_chat_waits_on() {
    let mut live = runtime("claude-acp", "a", 1);
    live.background.allow("user-message");
    let mut wake_up = json!({"update":{"sessionUpdate":"tool_call","toolCallId":"date"}});
    assert!(live
        .background
        .stamp_continuation(&mut wake_up, "now", "claude-acp"));
    assert!(live.stop("a").1.is_some());
    assert!(live.background.active_run_id().is_none());
    assert!(!live.background.stamp_continuation(
        &mut json!({"update":{"sessionUpdate":"agent_message_chunk"}}),
        "later",
        "claude-acp"
    ));

    // A prompt the renderer sent settles through its own answer instead.
    live.background.allow("next-message");
    live.run = Some(RunState::start(&ids()));
    assert_eq!(live.stop("a"), (0, None));
    live.run = None;
    assert_eq!(live.stop("a"), (0, None));
}

#[test]
fn a_request_nobody_can_answer_is_cancelled_or_failed() {
    assert_eq!(
        Inner::unanswered_client_request("session/request_permission"),
        Ok(json!({ "outcome": { "outcome": "cancelled" } }))
    );
    assert!(Inner::unanswered_client_request("fs/read_text_file").is_err());
}

// 2026-11-25 hunt, D-1: a turn that failed between its claim and its prompt
// kept the run claimed, and the chat refused every prompt after it.
#[test]
fn a_turn_that_ends_before_its_prompt_lets_go_of_the_chat() {
    let mut chat = runtime("claude-acp", "a", 1);
    Inner::claim_turn(&mut chat, &ids()).expect("an idle chat takes the turn");
    chat.steer_queue.push_back(QueuedPrompt {
        prompt: json!([{ "type": "text", "text": "also this" }]),
        meta: json!({}),
        ids: TurnIds::new(),
    });
    // Another run is not this turn's to let go of.
    assert_eq!(Inner::release_claim(&mut chat, "another-run"), None);
    assert_eq!(chat.active_run_id(), Some("run-1"));
    assert_eq!(Inner::release_claim(&mut chat, "run-1"), Some(1));
    assert_eq!(chat.active_run_id(), None);
    assert!(chat.steer_queue.is_empty());
    let mut next = ids();
    next.run_id = "run-2".into();
    assert!(
        Inner::claim_turn(&mut chat, &next).is_ok(),
        "the next prompt is taken, not refused as already running"
    );
}

// 2026-11-25 hunt, D-2: a Stop pressed while a dormant chat's prompt was still
// on its way to its claim found no turn, and the whole turn ran.
#[test]
fn a_stop_that_finds_no_turn_stops_only_a_prompt_sent_before_it() {
    let mut prompt = json!({"sessionId": "h2-dormant-chat", "prompt": []});
    Inner::stamp_arrival(&mut prompt, 10);
    let arrival = Inner::take_arrival(&mut prompt);
    assert_eq!(arrival, Some(10));
    // Taken out again: never recorded with the prompt or sent to a bridge.
    assert_eq!(prompt["_meta"], json!({}));
    assert!(!Inner::stopped_after("h2-dormant-chat", arrival));
    Inner::note_stop_without_turn("h2-dormant-chat", 11);
    assert!(Inner::stopped_after("h2-dormant-chat", arrival));
    // Not a prompt sent after that Stop, whichever the host handles first;
    // not another chat's; not one the host sends itself.
    assert!(!Inner::stopped_after("h2-dormant-chat", Some(12)));
    assert!(!Inner::stopped_after("h2-other-chat", arrival));
    assert!(!Inner::stopped_after("h2-dormant-chat", None));
    // An earlier Stop handled late does not move the mark back.
    Inner::note_stop_without_turn("h2-dormant-chat", 5);
    assert!(Inner::stopped_after("h2-dormant-chat", arrival));
}

fn invented_store_session(id: &str, harness: &str) -> SessionRecord {
    serde_json::from_value(json!({
        "id": id, "harness": harness, "cwd": "/workspace", "user_set_name": false,
        "hidden": true, "created_at": now_iso(), "updated_at": now_iso(), "message_count": 0
    }))
    .unwrap()
}

// 2026-11-25 hunt, D-4: a failed evidence write after the provider answered
// turned a completed, paid benchmark turn into a failed one.
#[tokio::test]
async fn a_provider_answer_outlasts_a_failed_turn_result_write() {
    let dir = crate::test_support::TempRoot::new();
    let path = dir.path().join("host.db");
    let store = SessionStore::open(&path).await.unwrap();
    dir.register(&store.pool);
    let owner = OwnedSessionRequest {
        owner_id: "invented-owner".into(),
        provider_id: "codex-acp".into(),
        account_id: "invented-account".into(),
        model_id: "invented-model".into(),
        reasoning_effort: None,
        fast_mode: None,
        cwd: "/workspace".into(),
        title: "Invented task".into(),
        profile: ExecutionProfile::NativeTextV1,
    };
    store
        .insert_owned_session(
            &invented_store_session("h4-owned", "codex-acp"),
            &owner,
            "invented-hash",
        )
        .await
        .unwrap();
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    dir.register(&pool);
    sqlx::query("CREATE TRIGGER fail_turn_result BEFORE INSERT ON session_events WHEN NEW.payload_json LIKE '%benchmark_turn_result%' BEGIN SELECT RAISE(FAIL, 'simulated locked store'); END")
        .execute(&pool).await.unwrap();
    let answered =
        Ok(json!({"stopReason": "end_turn", "usage": {"inputTokens": 3, "outputTokens": 5}}));
    let writer = store.clone();
    let commit = tokio::spawn(async move {
        Inner::commit_turn_result(
            &writer,
            "h4-owned",
            &answered,
            std::time::Duration::from_millis(5),
        )
        .await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    // Still retrying: nothing it could return would stand in for the answer.
    assert!(!commit.is_finished());
    assert!(store.list_events("h4-owned").await.unwrap().is_empty());
    sqlx::query("DROP TRIGGER fail_turn_result")
        .execute(&pool)
        .await
        .unwrap();
    commit.await.unwrap();
    let saved = store.list_events("h4-owned").await.unwrap();
    assert_eq!(saved.len(), 1, "written once: {saved:?}");
    assert_eq!(saved[0]["update"]["sessionUpdate"], "benchmark_turn_result");
    assert_eq!(
        saved[0]["update"]["_meta"]["benchmarkRawResult"]["stopReason"],
        "end_turn"
    );
    assert_eq!(
        saved[0]["update"]["_meta"]["executionOwner"]["id"],
        "invented-owner"
    );
    // An ordinary chat has no evidence to write and is not held up.
    store
        .insert_session(&invented_store_session("h4-chat", "codex-acp"))
        .await
        .unwrap();
    Inner::commit_turn_result(
        &store,
        "h4-chat",
        &Ok(json!({"stopReason": "end_turn"})),
        std::time::Duration::from_millis(5),
    )
    .await;
    assert!(store.list_events("h4-chat").await.unwrap().is_empty());
    dir.close().await;
}

// 2026-11-25 hunt, D-8: a forbidden client request whose evidence could not
// be written left the benchmark session counting as clean.
#[tokio::test]
async fn a_policy_violation_counts_even_when_its_evidence_cannot_be_written() {
    let dir = crate::test_support::TempRoot::new();
    let path = dir.path().join("host.db");
    let store = SessionStore::open(&path).await.unwrap();
    dir.register(&store.pool);
    for id in ["h5-violated", "h5-clean"] {
        store
            .insert_session(&invented_store_session(id, "grok-acp"))
            .await
            .unwrap();
    }
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    dir.register(&pool);
    sqlx::query("CREATE TRIGGER fail_violation BEFORE INSERT ON session_events WHEN NEW.payload_json LIKE '%executionViolation%' BEGIN SELECT RAISE(FAIL, 'simulated locked store'); END")
        .execute(&pool).await.unwrap();
    let event = json!({"sessionId": "h5-violated", "update": {"sessionUpdate": "notice",
        "_meta": {"executionViolation": "Unexpected native client request: fs/read_text_file"}}});
    assert!(!Inner::policy_violated(&store, "h5-violated").await.unwrap());
    Inner::hold_violation("h5-violated");
    assert!(
        !Inner::write_violation(
            &store,
            "h5-violated",
            &event,
            2,
            std::time::Duration::from_millis(1)
        )
        .await
    );
    // The store has no evidence of it, and the session counts as violated.
    assert!(!store
        .execution_policy_violation("h5-violated")
        .await
        .unwrap());
    assert!(Inner::policy_violated(&store, "h5-violated").await.unwrap());
    sqlx::query("DROP TRIGGER fail_violation")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        Inner::write_violation(
            &store,
            "h5-violated",
            &event,
            2,
            std::time::Duration::from_millis(1)
        )
        .await
    );
    assert!(store
        .execution_policy_violation("h5-violated")
        .await
        .unwrap());
    assert!(Inner::policy_violated(&store, "h5-violated").await.unwrap());
    assert!(!Inner::policy_violated(&store, "h5-clean").await.unwrap());
    dir.close().await;
}

// 2026-11-25 hunt, D-3: every turn start, dispatch and settlement of a
// benchmark session scanned all its stored payloads for a violation.
#[tokio::test]
async fn the_policy_verdict_is_read_from_the_store_once_per_session() {
    let dir = crate::test_support::TempRoot::new();
    let store = SessionStore::open(&dir.path().join("host.db"))
        .await
        .unwrap();
    dir.register(&store.pool);
    for id in ["h8-violated-earlier", "h8-clean"] {
        store
            .insert_session(&invented_store_session(id, "grok-acp"))
            .await
            .unwrap();
    }
    let violation = |id: &str| {
        json!({"sessionId": id, "update": {"sessionUpdate": "tool_call",
            "_meta": {"executionViolation": "native tool activity"}}})
    };
    // Written by an earlier run: read from the store the first time.
    store
        .append_events("h8-violated-earlier", &[violation("h8-violated-earlier")])
        .await
        .unwrap();
    assert!(Inner::policy_violated(&store, "h8-violated-earlier")
        .await
        .unwrap());
    assert!(!Inner::policy_violated(&store, "h8-clean").await.unwrap());
    // The store is not scanned again for a session already asked about: a
    // row this run did not stamp is not seen.
    store
        .append_events("h8-clean", &[violation("h8-clean")])
        .await
        .unwrap();
    assert!(!Inner::policy_violated(&store, "h8-clean").await.unwrap());
    // What this run stamps counts at once.
    Inner::hold_violation("h8-clean");
    assert!(Inner::policy_violated(&store, "h8-clean").await.unwrap());
    dir.close().await;
}

// 2026-11-25 hunt, D-6: a CLI that cannot speak ACP was started again for
// every model list the renderer asked for. A chat start never consults this
// memory (`ensure_bridge` with `probe` false), so only probes are held back,
// and only for a while.
#[test]
fn a_bridge_that_failed_to_initialize_is_not_probed_again_for_a_while() {
    let route = "h6-invented-acp";
    let shim = json!({"path": "C:\\invented\\bin\\agent.bat", "len": 120, "modified": 1});
    let now = std::time::Instant::now();
    assert!(Inner::refused_start(route, &shim, now).is_none());
    Inner::remember_failed_start(
        route,
        shim.clone(),
        "Invented Agent bridge failed to initialize: The agent's bridge exited before this turn finished",
    );
    let refusal = Inner::refused_start(route, &shim, std::time::Instant::now())
        .expect("a probe does not start the same CLI again at once");
    assert!(
        refusal.starts_with("Invented Agent bridge failed to initialize"),
        "{refusal}"
    );
    let later =
        |minutes: u64| std::time::Instant::now() + std::time::Duration::from_secs(minutes * 60);
    assert!(Inner::refused_start(route, &shim, later(9)).is_some());
    // The memory runs out.
    assert!(Inner::refused_start(route, &shim, later(11)).is_none());
    // Another account of the harness is its own route.
    assert!(Inner::refused_start("h6-invented-acp\u{1f}other-account", &shim, now).is_none());
    // A changed executable (installed, updated, another first on PATH) is tried.
    let installed = json!({"path": "C:\\invented\\bin\\agent.exe", "len": 9000, "modified": 2});
    assert!(Inner::refused_start(route, &installed, std::time::Instant::now()).is_none());
    // So is the same one once it started (for a chat) or was refreshed.
    Inner::forget_failed_start(route);
    assert!(Inner::refused_start(route, &shim, std::time::Instant::now()).is_none());
}
