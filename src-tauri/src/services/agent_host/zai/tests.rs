use super::*;

fn snapshot(current: &str) -> Value {
    json!({"sessionId":"s", "configOptions":[
        {"id":"model","category":"model","type":"select","currentValue":current,"options":[
            {"value":"zai-coding-plan/glm-5.3","name":"GLM-5.3"},
            {"value":"zai-coding-plan/glm-5.3-highspeed","name":"GLM-5.3 Highspeed"},
            {"value":"zai-coding-plan/glm-5.3-flash","name":"GLM-5.3-Flash"},
            {"value":"zai-coding-plan/glm-5.2-highspeed","name":"GLM-5.2 Highspeed"}
        ]},
        {"id":"effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"low"},{"value":"high"}]}
    ]})
}

#[test]
fn speed_is_a_setting_only_when_both_native_models_exist() {
    let mut adapter = ConfigAdapter::default();
    let mut opened = snapshot("zai-coding-plan/glm-5.3-highspeed");
    adapter.response("session/load", None, &mut opened);
    assert_eq!(
        opened["configOptions"][0]["currentValue"],
        "zai-coding-plan/glm-5.3"
    );
    assert_eq!(
        opened["configOptions"][0]["options"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(opened["configOptions"][1]["currentValue"], "high");
    assert_eq!(opened["configOptions"][2]["currentValue"], "on");
    for (value, expected) in [
        (json!(false), "zai-coding-plan/glm-5.3"),
        (json!("on"), "zai-coding-plan/glm-5.3-highspeed"),
    ] {
        let request = adapter
            .request(
                "session/set_config_option",
                json!({"sessionId":"s","configId":"fast","value":value,"type":"boolean"}),
            )
            .unwrap();
        assert_eq!(request["configId"], "model");
        assert_eq!(request["value"], expected);
        assert!(request.get("type").is_none());
    }
    // Preparing a write does not optimistically change the reported selection.
    assert_eq!(
        adapter.effort_to_keep("s"),
        Some(("effort".into(), "high".into()))
    );
    let mut flash = snapshot("zai-coding-plan/glm-5.3-flash");
    adapter.response("session/set_config_option", Some("s"), &mut flash);
    assert_eq!(flash["configOptions"].as_array().unwrap().len(), 2);
    assert!(adapter
        .request(
            "session/set_config_option",
            json!({"sessionId":"s","configId":"fast","value":"on"})
        )
        .is_err());
}

#[test]
fn notifications_and_closed_sessions_keep_independent_state() {
    let mut adapter = ConfigAdapter::default();
    let mut first = snapshot("zai-coding-plan/glm-5.3");
    adapter.response("session/new", None, &mut first);
    let mut update = json!({"sessionId":"other","update":{"sessionUpdate":"config_option_update","configOptions":snapshot("zai-coding-plan/glm-5.3-highspeed")["configOptions"]}});
    adapter.notification("session/update", &mut update);
    assert_eq!(update["update"]["configOptions"][2]["currentValue"], "on");
    adapter.response("session/close", Some("other"), &mut json!({}));
    assert!(adapter.effort_to_keep("other").is_none());
    assert!(adapter.effort_to_keep("s").is_some());
    assert!(adapter
        .request(
            "session/set_config_option",
            json!({"sessionId":"s","configId":"fast","value":"invalid"})
        )
        .is_err());
}

/// Opt-in contract check against an installed native runtime. The key is a
/// fixture; prompts are sent only when a loopback mock endpoint is supplied.
#[tokio::test]
#[ignore = "requires DISTILL_ZAI_TEST_BIN pointing to an installed OpenCode executable"]
async fn live_zai_config_adapter() {
    use crate::services::agent_host::{
        bridge::{Bridge, SpawnEnv},
        harness,
    };
    let binary = std::path::PathBuf::from(std::env::var("DISTILL_ZAI_TEST_BIN").unwrap());
    let root = tempfile::tempdir().unwrap();
    let mut extra_env = crate::services::zai::scoped_env(root.path(), vec![], "fixture-key".into());
    if let Ok(endpoint) = std::env::var("DISTILL_ZAI_TEST_ENDPOINT") {
        assert!(endpoint.starts_with("http://127.0.0.1:"));
        let (_, content) = extra_env
            .iter_mut()
            .find(|(key, _)| key == "OPENCODE_CONFIG_CONTENT")
            .unwrap();
        let mut config: Value = serde_json::from_str(content).unwrap();
        config["provider"]["zai-coding-plan"]["options"]["baseURL"] = json!(endpoint);
        *content = config.to_string();
    }
    let (events, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let bridge = Bridge::spawn(
        harness::harness("zai-acp").unwrap(),
        &SpawnEnv {
            shell_env: crate::services::env_key::process_vars_lossy()
                .into_iter()
                .collect(),
            prepend_dirs: vec![binary.parent().unwrap().to_path_buf()],
            extra_env,
            remove_env: vec![],
        },
        events,
    )
    .await
    .unwrap();
    let opened = bridge
        .request("session/new", json!({"cwd":root.path(),"mcpServers":[]}))
        .await
        .unwrap();
    let session = opened["sessionId"].as_str().unwrap();
    let value = |answer: &Value, id: &str| -> Value {
        answer["configOptions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["id"] == id)
            .map(|o| o["currentValue"].clone())
            .unwrap_or(Value::Null)
    };
    let mut inventory = Vec::new();
    for choice in model_option(&opened["configOptions"]).unwrap()["options"]
        .as_array()
        .unwrap()
    {
        let answer = bridge
            .request(
                "session/set_config_option",
                json!({"sessionId":session,"configId":"model","value":choice["value"]}),
            )
            .await
            .unwrap();
        let effort = answer["configOptions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["category"] == "thought_level");
        inventory.push(json!({"id":choice["value"],"name":choice["name"],"supportsFast":!value(&answer,"fast").is_null(),"efforts":effort.map(|o| &o["options"]),"capabilitySource":"probed"}));
    }
    bridge
        .request(
            "session/set_config_option",
            json!({"sessionId":session,"configId":"model","value":"zai-coding-plan/glm-5.3"}),
        )
        .await
        .unwrap();
    bridge
        .request(
            "session/set_config_option",
            json!({"sessionId":session,"configId":"effort","value":"high"}),
        )
        .await
        .unwrap();
    let fast = bridge
        .request(
            "session/set_config_option",
            json!({"sessionId":session,"configId":"fast","value":"on"}),
        )
        .await
        .unwrap();
    assert_eq!(value(&fast, "model"), "zai-coding-plan/glm-5.3");
    assert_eq!(value(&fast, "fast"), "on");
    assert_eq!(value(&fast, "effort"), "high");
    if std::env::var_os("DISTILL_ZAI_TEST_ENDPOINT").is_some() {
        let result = bridge.request("session/prompt", json!({"sessionId":session,"prompt":[{"type":"text","text":"Reply OK without using tools."}]})).await.unwrap();
        assert_eq!(result["stopReason"], "end_turn");
    }
    let off = bridge
        .request(
            "session/set_config_option",
            json!({"sessionId":session,"configId":"fast","value":false,"type":"boolean"}),
        )
        .await
        .unwrap();
    assert_eq!(value(&off, "fast"), "off");
    assert_eq!(value(&off, "effort"), "high");
    let flash = bridge
        .request(
            "session/set_config_option",
            json!({"sessionId":session,"configId":"model","value":"zai-coding-plan/glm-5.3-flash"}),
        )
        .await
        .unwrap();
    assert_eq!(value(&flash, "fast"), Value::Null);
    assert!(bridge
        .request(
            "session/set_config_option",
            json!({"sessionId":session,"configId":"fast","value":"on"})
        )
        .await
        .is_err());
    while let Ok(event) = receiver.try_recv() {
        if let crate::services::agent_host::bridge::BridgeEvent::Notification { params, .. } = event
        {
            if let Some(options) = params.pointer("/update/configOptions") {
                if let Some(model) = model_option(options) {
                    assert!(!model["currentValue"]
                        .as_str()
                        .unwrap()
                        .ends_with("-highspeed"));
                }
            }
        }
    }
    if let Ok(path) = std::env::var("DISTILL_ZAI_TEST_RESULT") {
        std::fs::write(path, serde_json::to_vec_pretty(&json!({"inventory":harness::merge_inventory("zai-acp",inventory),"opened":opened,"fast":fast,"off":off,"flash":flash})).unwrap()).unwrap();
    }
    bridge.close_session(session).await;
    bridge.kill();
}
