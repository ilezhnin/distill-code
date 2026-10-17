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

fn text_config() -> Value {
    super::super::execution::NativeProvider::Zai
        .policy_config()
        .expect("Z.ai configuration")
}

/// The owned OpenCode reaches the Coding Plan alone, reads the key from the
/// attempt's private copy and never carries it in its configuration.
#[test]
fn sandbox_configuration_uses_only_the_coding_plan_and_names_the_key_by_file() {
    let config = text_config();
    assert_eq!(config["enabled_providers"], json!(["zai-coding-plan"]));
    let options = &config["provider"]["zai-coding-plan"]["options"];
    assert_eq!(options["baseURL"], crate::services::zai::CODING_ENDPOINT);
    assert_eq!(options["apiKey"], "{file:/tmp/provider/api-key}");
    assert_eq!(
        config["provider"].as_object().unwrap().len(),
        1,
        "no other provider is configured"
    );
    for (field, off) in [
        ("share", json!("disabled")),
        ("autoupdate", json!(false)),
        ("snapshot", json!(false)),
        ("lsp", json!(false)),
        ("formatter", json!(false)),
        ("instructions", json!([])),
        ("mcp", json!({})),
    ] {
        assert_eq!(config[field], off, "{field}");
    }
    // A title is a second model request; the title agent is removed.
    assert_eq!(config["agent"]["title"], json!({"disable": true}));
    assert!(config.get("small_model").is_none());
    let env = sandbox_env(&config, "invented plugin source");
    let names: Vec<&str> = env.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        [
            "XDG_CONFIG_HOME",
            "PATH",
            "OPENCODE_CONFIG_CONTENT",
            "DISTILL_BENCH_OPENCODE_PLUGIN"
        ]
    );
    assert_eq!(env[0].1, SANDBOX_CONFIG_HOME);
    assert!(env[1].1.starts_with("/opt/distill-tools/zai/bin:"));
    assert_eq!(
        serde_json::from_str::<Value>(&env[2].1).unwrap(),
        config,
        "the configuration reaches OpenCode as written"
    );
}

/// The text profile's agent answers with no tool; its requests carry the
/// benchmark prompt as their whole system prompt through the policy plugin,
/// which bench-enter writes where the configuration loads it from.
#[test]
fn text_agent_denies_every_tool_and_the_plugin_gets_its_prompt() {
    let config = text_config();
    let prompt = super::super::execution::SYSTEM_PROMPT;
    assert_eq!(config["default_agent"], "distill-benchmark");
    let agent = &config["agent"]["distill-benchmark"];
    assert_eq!(agent["mode"], "primary");
    assert_eq!(agent["prompt"], prompt);
    assert_eq!(agent["permission"], json!({"*": "deny"}));
    // A step limit would add OpenCode's own "maximum steps" message.
    assert!(agent.get("steps").is_none());
    assert_eq!(config["permission"], json!({"*": "deny"}));
    let plugin = format!("file://{SANDBOX_CONFIG_HOME}/distill-benchmark-policy.mjs");
    assert_eq!(config["plugin"], json!([[plugin, {"prompt": prompt}]]));
    let enter = include_str!("../../../../resources/benchmark-sandbox/bench-enter");
    assert!(enter.contains(&format!(">{}", plugin.trim_start_matches("file://"))));
    assert!(enter.contains(&format!(
        "install -d -m 755 -o root -g root {SANDBOX_CONFIG_HOME} "
    )));
}

/// The repository agent works with local file and shell tools, delegates to
/// no subagent and fetches nothing from the web.
#[test]
fn repository_agent_allows_local_tools_only() {
    let text = text_config();
    let config = repository_config(&text, "Invented repository prompt.");
    assert_eq!(config["default_agent"], REPOSITORY_AGENT);
    let agents = config["agent"].as_object().unwrap();
    let mut names: Vec<&str> = agents.keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(names, ["distill-repository", "title"]);
    let permission = &agents[REPOSITORY_AGENT]["permission"];
    assert_eq!(permission["*"], "deny");
    for tool in ["read", "list", "glob", "grep", "edit", "bash", "todowrite"] {
        assert_eq!(permission[tool], "allow", "{tool}");
    }
    for denied in ["task", "webfetch", "websearch", "skill", "question"] {
        assert!(permission.get(denied).is_none(), "{denied}");
    }
    assert_eq!(
        config["plugin"][0][1],
        json!({"prompt": "Invented repository prompt."})
    );
    assert_eq!(
        agents[REPOSITORY_AGENT]["prompt"],
        "Invented repository prompt."
    );
    // Everything else is the text profile's.
    for field in [
        "provider",
        "enabled_providers",
        "permission",
        "snapshot",
        "share",
    ] {
        assert_eq!(config[field], text[field], "{field}");
    }
}
