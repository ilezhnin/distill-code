//! The tool-using owned profile. Its process and every native tool run in WSL.
use super::{
    bridge::OwnedLaunch,
    execution::{self, NativeProvider, OwnedSessionRequest},
};
use crate::services::benchmark_sandbox as sandbox;
use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;

pub(super) const PROMPT: &str = "Complete the supplied repository task in /workspace. Use tools to inspect and change files. Do not delegate to other agents. Finish when the requested change is ready.";
const CODEX: &str = include_str!("../../../resources/benchmark-repository-codex.mjs");
const KIMI: &str = include_str!("../../../resources/benchmark-repository-kimi.mjs");

pub(crate) fn attempt_id(owner: &str) -> String {
    format!("attempt-{}", execution::digest(owner))
}

pub(super) fn profile_key(owner: &str) -> String {
    // The mount namespace has exactly one workspace, so bridges cannot be
    // shared between attempts even when their provider and account match.
    format!("repository:{}", execution::digest(owner))
}

pub(super) fn is_route(profile: &str) -> bool {
    profile.starts_with("repository:")
}

pub(crate) async fn readiness(
    provider: NativeProvider,
    account: &str,
) -> Result<sandbox::Status, String> {
    let status = sandbox::ready()
        .await
        .map_err(|error| format!("capability_missing: {error}"))?;
    status
        .require_account(provider.key(), account)
        .map_err(|error| format!("capability_missing: {error}"))?;
    Ok(status)
}

fn adapter(provider: NativeProvider) -> Option<&'static str> {
    match provider {
        NativeProvider::Claude => Some(execution::NATIVE_TEXT_ADAPTER),
        NativeProvider::Codex => Some(CODEX),
        NativeProvider::Kimi => Some(KIMI),
        NativeProvider::Grok => None,
    }
}

pub(crate) fn revision(provider: NativeProvider, status: &sandbox::Status) -> String {
    execution::digest(execution::canonical_json(&json!({
        "profile":"protected_repository_v1", "sandbox":status.revision,
        "provider":provider.key(), "adapter":adapter(provider),
        "environment":environment(provider), "session":session_meta(provider, ""),
        "permissionMode":permission_mode(provider),
    })))
}

pub(crate) fn policy_hash(request: &OwnedSessionRequest, revision: &str) -> Result<String, String> {
    serde_json::to_vec(&json!({"request":request,"runtimeRevision":revision}))
        .map(execution::digest)
        .map_err(|error| error.to_string())
}

fn native_policies() -> Value {
    serde_json::from_str(include_str!(
        "../../../resources/benchmark-native-policies.json"
    ))
    .expect("native policies")
}

fn environment(provider: NativeProvider) -> Vec<(String, String)> {
    let mut env = vec![("DISTILL_BENCH_INSTRUCTIONS".into(), PROMPT.into())];
    match provider {
        NativeProvider::Claude => {
            env.push(("CLAUDE_CONFIG_DIR".into(), "/tmp/provider".into()));
            env.push(("DISABLE_AUTOUPDATER".into(), "1".into()));
        }
        NativeProvider::Codex => {
            let mut config = native_policies()["codex"]["config"].clone();
            config["features"]["shell_tool"] = json!(true);
            config["features"]["unified_exec"] = json!(true);
            config["features"]["unified_exec_tty"] = json!(true);
            config["model_instructions_file"] = json!("/tmp/repository-instructions.md");
            config["cli_auth_credentials_store"] = json!("file");
            config["approval_policy"] = json!("never");
            config["sandbox_mode"] = json!("danger-full-access");
            env.push(("CODEX_CONFIG".into(), config.to_string()));
            env.push(("CODEX_HOME".into(), "/tmp/provider".into()));
            env.push(("INITIAL_AGENT_MODE".into(), "agent-full-access".into()));
        }
        NativeProvider::Grok => {
            for (key, value) in native_policies()["grok"]["env"]
                .as_object()
                .expect("Grok env")
            {
                env.push((key.clone(), value.as_str().expect("env string").into()));
            }
            env.push(("GROK_HOME".into(), "/home/candidate/.grok".into()));
            env.push(("GROK_AUTH_PATH".into(), "/tmp/provider/auth.json".into()));
            env.push((
                "DISTILL_BENCH_GROK_CONFIG".into(),
                native_policies()["grok"]["configToml"]
                    .as_str()
                    .expect("Grok config")
                    .into(),
            ));
        }
        NativeProvider::Kimi => {
            env.push(("KIMI_CODE_HOME".into(), "/home/candidate/.kimi-code".into()));
            env.push(("KIMI_CODE_NO_AUTO_UPDATE".into(), "1".into()));
        }
    }
    env
}

pub(super) fn permission_mode(provider: NativeProvider) -> Option<&'static str> {
    match provider {
        NativeProvider::Claude => Some("bypassPermissions"),
        NativeProvider::Codex => Some("agent-full-access"),
        NativeProvider::Kimi => Some("auto"),
        NativeProvider::Grok => None,
    }
}

pub(super) fn session_meta(provider: NativeProvider, model: &str) -> Value {
    match provider {
        NativeProvider::Claude => json!({"systemPrompt":PROMPT,"claudeCode":{"options":{
            "model":model,"title":"Benchmark execution",
            "tools":["Bash","Read","Write","Edit","Glob","Grep"],
            "settingSources":[],"skills":[],"plugins":[],"agents":{},
            "mcpServers":{},"strictMcpConfig":true,"persistSession":false,
            "allowDangerouslySkipPermissions":true,
            "managedSettings":{"disableAllHooks":true,"autoMemoryEnabled":false},
            "settings":{"disableAllHooks":true,"autoMemoryEnabled":false}
        }}}),
        NativeProvider::Grok => {
            let mut meta = native_policies()["grok"]["sessionMeta"].clone();
            meta["systemPromptOverride"] = json!(PROMPT);
            meta["yoloMode"] = json!(true);
            let profile = &mut meta["agentProfile"];
            profile["description"] = json!("Repository benchmark tools");
            profile["tools"] = json!([
                "run_terminal_cmd",
                "read_file",
                "search_replace",
                "list_dir",
                "grep",
                "kill_command_or_subagent",
                "get_command_or_subagent_output",
                "wait_commands_or_subagents"
            ]);
            profile["disallowedTools"] = json!(["Agent", "search_tool", "use_tool"]);
            profile.as_object_mut().unwrap().remove("maxTurns");
            meta
        }
        NativeProvider::Codex | NativeProvider::Kimi => json!({}),
    }
}

pub(super) fn permission_answer(method: &str, params: &Value) -> Option<Value> {
    if method != "session/request_permission" {
        return None;
    }
    let options = params["options"].as_array()?;
    let option = options
        .iter()
        .find(|option| option["kind"] == "allow_once")
        .or_else(|| {
            options
                .iter()
                .find(|option| option["kind"] == "allow_always")
        })?;
    Some(json!({"outcome":{"outcome":"selected","optionId":option["optionId"].as_str()?}}))
}

pub(super) fn launch(
    request: &OwnedSessionRequest,
    provider: NativeProvider,
    revision: String,
) -> OwnedLaunch {
    let id = attempt_id(&request.owner_id);
    let mut args = vec![
        "-d".into(),
        sandbox::DISTRIBUTION.into(),
        "-u".into(),
        "root".into(),
        "--exec".into(),
        "/usr/local/sbin/bench-run".into(),
        "session".into(),
        id.clone(),
        format!(
            "DISTILL_BENCH_ACCOUNT_HOME=/home/candidate/accounts/{}/{}",
            request.account_id,
            provider.key()
        ),
    ];
    args.extend(
        environment(provider)
            .into_iter()
            .map(|(key, value)| format!("{key}={value}")),
    );
    args.push("--".into());
    // No shell interprets the host's environment or arguments.
    if let Some(adapter) = adapter(provider) {
        args.extend([
            "/usr/local/bin/node".into(),
            "--import".into(),
            format!(
                "data:text/javascript;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(adapter)
            ),
        ]);
        let entrypoint = match provider {
            NativeProvider::Claude => "/opt/distill-tools/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
            NativeProvider::Codex => "/opt/distill-tools/codex-acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
            NativeProvider::Kimi => "/opt/distill-tools/kimi/node_modules/@moonshot-ai/kimi-code/dist/main.mjs",
            NativeProvider::Grok => unreachable!(),
        };
        args.push(entrypoint.into());
        if provider == NativeProvider::Kimi {
            args.push("acp".into());
        }
    } else {
        args.extend(
            [
                "/opt/distill-tools/bin/grok",
                "agent",
                "--no-leader",
                "stdio",
            ]
            .map(str::to_owned),
        );
    }
    OwnedLaunch {
        program: PathBuf::from("wsl.exe"),
        args,
        fingerprint_target: PathBuf::new(),
        sandbox: Some((id, revision)),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        bridge::{Bridge, BridgeEvent, SpawnEnv},
        execution::ExecutionProfile,
        harness,
    };
    use super::*;

    #[tokio::test]
    #[ignore = "requires WSL and DISTILL_BENCH_PROBE_ACCOUNTS provider/account JSON"]
    async fn installed_bridges_open_an_isolated_workspace_and_acknowledge_the_mode() {
        let accounts: std::collections::BTreeMap<String, String> = serde_json::from_str(
            &std::env::var("DISTILL_BENCH_PROBE_ACCOUNTS").expect("explicit probe accounts"),
        )
        .unwrap();
        for (harness_id, account) in accounts {
            let provider = NativeProvider::for_harness(&harness_id).unwrap();
            let status = readiness(provider, &account).await.unwrap();
            let owner = uuid::Uuid::new_v4().to_string();
            let id = attempt_id(&owner);
            let mut cleanup = sandbox::Cleanup(Some(id.clone()));
            let mut archive = tar::Builder::new(Vec::new());
            let mut header = tar::Header::new_gnu();
            header.set_size(5);
            header.set_mode(0o644);
            header.set_cksum();
            archive
                .append_data(&mut header, "probe.txt", "probe".as_bytes())
                .unwrap();
            sandbox::copy(&id, &archive.into_inner().unwrap())
                .await
                .unwrap();
            let request = OwnedSessionRequest {
                owner_id: owner.clone(),
                provider_id: harness_id.clone(),
                account_id: account,
                model_id: if provider == NativeProvider::Claude {
                    "haiku"
                } else {
                    ""
                }
                .into(),
                reasoning_effort: None,
                fast_mode: None,
                cwd: "/workspace".into(),
                title: "Repository bridge handshake".into(),
                profile: ExecutionProfile::ProtectedRepositoryV1,
            };
            let env = SpawnEnv {
                shell_env: crate::services::env_key::process_vars_lossy()
                    .into_iter()
                    .filter(|(key, _)| {
                        [
                            "SYSTEMROOT",
                            "WINDIR",
                            "USERPROFILE",
                            "LOCALAPPDATA",
                            "APPDATA",
                            "TEMP",
                            "TMP",
                        ]
                        .iter()
                        .any(|name| key.eq_ignore_ascii_case(name))
                    })
                    .collect(),
                prepend_dirs: vec![],
                extra_env: vec![],
                remove_env: vec![],
            };
            let launch = launch(&request, provider, revision(provider, &status));
            let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
            let bridge = Bridge::spawn_scoped(
                harness::harness(&harness_id).unwrap(),
                &env,
                sender,
                &format!("{harness_id}\u{1f}benchmark:{}", profile_key(&owner)),
                Some(&launch),
            )
            .await
            .unwrap();
            let answering = std::sync::Arc::clone(&bridge);
            let answers = tokio::spawn(async move {
                while let Some(event) = events.recv().await {
                    if let BridgeEvent::Request {
                        id, method, params, ..
                    } = event
                    {
                        answering.respond(
                            id,
                            permission_answer(&method, &params).ok_or_else(
                                || json!({"code":-32601,"message":"unsupported client request"}),
                            ),
                        );
                    }
                }
            });
            let opened=bridge.request("session/new",json!({"cwd":"/workspace","mcpServers":[],"_meta":session_meta(provider,&request.model_id)})).await.unwrap();
            let session = opened["sessionId"].as_str().expect("session id");
            if let Some(mode) = permission_mode(provider) {
                bridge
                    .request(
                        "session/set_mode",
                        json!({"sessionId":session,"modeId":mode}),
                    )
                    .await
                    .unwrap();
            }
            bridge.stop_sandbox().await.unwrap();
            answers.abort();
            sandbox::clean(&id).await.unwrap();
            cleanup.0 = None;
        }
    }
    #[test]
    fn sandbox_permission_selects_an_explicit_allow_option_only() {
        let request = json!({"options":[{"kind":"reject_once","optionId":"no"},{"kind":"allow_once","optionId":"yes"}]});
        assert_eq!(
            permission_answer("session/request_permission", &request).unwrap()["outcome"]
                ["optionId"],
            "yes"
        );
        assert!(permission_answer("fs/read_text_file", &request).is_none());
        assert!(permission_answer(
            "session/request_permission",
            &json!({"options":[{"kind":"reject_once","optionId":"no"}]})
        )
        .is_none());
    }
    #[test]
    fn repository_policies_allow_local_tools_without_delegation_or_mcp() {
        let meta = session_meta(NativeProvider::Claude, "model");
        assert_eq!(meta["claudeCode"]["options"]["tools"][0], "Bash");
        assert_eq!(meta["claudeCode"]["options"]["agents"], json!({}));
        let codex: Value = serde_json::from_str(
            &environment(NativeProvider::Codex)
                .into_iter()
                .find(|(key, _)| key == "CODEX_CONFIG")
                .unwrap()
                .1,
        )
        .unwrap();
        assert_eq!(codex["features"]["unified_exec"], true);
        assert_eq!(codex["features"]["multi_agent"], false);
        assert_ne!(attempt_id("one"), attempt_id("two"));
        assert!(sandbox::valid_id(&attempt_id("owner:with/slashes")).is_ok());
    }
}
