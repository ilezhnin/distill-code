//! Z.ai Coding Plan runs through OpenCode's native ACP agent. Keep its
//! provider selection, endpoint and storage scoped to the Distill account.

use std::path::Path;

use serde_json::json;

use super::env_key;

pub const CODING_ENDPOINT: &str = "https://api.z.ai/api/coding/paas/v4";

pub fn scoped_env(
    home: &Path,
    mut env: Vec<(String, String)>,
    key: String,
) -> Vec<(String, String)> {
    for (name, folder) in [
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_STATE_HOME", "state"),
    ] {
        env_key::upsert_vec(&mut env, name, home.join(folder).to_string_lossy().into());
    }
    env_key::upsert_vec(&mut env, "DISTILL_ZAI_API_KEY", key);
    env_key::upsert_vec(&mut env, "OPENCODE_DISABLE_AUTOUPDATE", "true".into());
    env_key::upsert_vec(&mut env, "OPENCODE_DISABLE_PROJECT_CONFIG", "true".into());
    env_key::upsert_vec(&mut env, "OPENCODE_DISABLE_CLAUDE_CODE", "true".into());
    env_key::upsert_vec(
        &mut env,
        "OPENCODE_CONFIG_CONTENT",
        json!({
            "$schema": "https://opencode.ai/config.json",
            "enabled_providers": ["zai-coding-plan"],
            "model": "zai-coding-plan/glm-5.3",
            "small_model": "zai-coding-plan/glm-5.3-flash",
            "share": "disabled",
            "autoupdate": false,
            "provider": {
                "zai-coding-plan": {
                    "options": {
                        "baseURL": CODING_ENDPOINT,
                        "apiKey": "{env:DISTILL_ZAI_API_KEY}"
                    }
                }
            },
            "permission": "ask",
            "agent": {
                "distill-auto": {
                    "description": "Execute tasks with automatic tool approval",
                    "mode": "primary",
                    "permission": "allow"
                },
                "distill-edit": {
                    "description": "Edit files and ask before running commands",
                    "mode": "primary",
                    "permission": {
                        "*": "ask",
                        "read": "allow",
                        "list": "allow",
                        "glob": "allow",
                        "grep": "allow",
                        "edit": "allow"
                    }
                }
            }
        })
        .to_string(),
    );
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn coding_plan_has_no_pay_as_you_go_provider_or_shared_storage() {
        let home = Path::new("account-home");
        let env: HashMap<_, _> = scoped_env(home, vec![], "test-key".into())
            .into_iter()
            .collect();
        let config: serde_json::Value =
            serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
        assert_eq!(config["enabled_providers"], json!(["zai-coding-plan"]));
        assert_eq!(
            config["provider"]["zai-coding-plan"]["options"]["baseURL"],
            CODING_ENDPOINT
        );
        assert!(!env["OPENCODE_CONFIG_CONTENT"].contains("test-key"));
        assert_eq!(env["DISTILL_ZAI_API_KEY"], "test-key");
        assert_eq!(config["share"], "disabled");
        assert_eq!(config["permission"], "ask");
        assert_eq!(config["agent"]["distill-auto"]["permission"], "allow");
        assert_eq!(
            config["agent"]["distill-edit"]["permission"]["bash"],
            serde_json::Value::Null
        );
        assert_eq!(env["XDG_DATA_HOME"], home.join("data").to_string_lossy());
        assert_eq!(env["OPENCODE_DISABLE_PROJECT_CONFIG"], "true");
    }
}
