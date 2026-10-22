//! OpenCode names Z.ai's speed setting as a second model. Present the pair as
//! one model plus ACP's usual fast option, and translate writes at the boundary.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::protocol;

pub const ADAPTER_REVISION: u32 = 1;

/// Where bench-enter puts OpenCode's configuration home for an owned run in
/// the benchmark sandbox: root-owned, so OpenCode installs nothing into it,
/// and holding only the policy plugin the configuration loads from it.
pub(super) const SANDBOX_CONFIG_HOME: &str = "/tmp/opencode-config";
/// The sandbox tools, after the ripgrep that Z.ai sessions alone have for
/// OpenCode's grep and glob tools.
const SANDBOX_PATH: &str =
    "/opt/distill-tools/zai/bin:/opt/distill-tools/bin:/usr/local/bin:/usr/bin:/bin";
/// The OpenCode agent of the protected repository profile.
pub(super) const REPOSITORY_AGENT: &str = "distill-repository";

/// The environment of an owned OpenCode in the benchmark sandbox, after the
/// policy's own flags: the configuration home, the PATH, the configuration
/// and the policy plugin bench-enter writes from
/// `DISTILL_BENCH_OPENCODE_PLUGIN`. The configuration names the account key
/// by its file in the attempt's private copy; no secret is part of it.
pub(super) fn sandbox_env(config: &Value, plugin: &str) -> Vec<(String, String)> {
    vec![
        ("XDG_CONFIG_HOME".into(), SANDBOX_CONFIG_HOME.into()),
        ("PATH".into(), SANDBOX_PATH.into()),
        ("OPENCODE_CONFIG_CONTENT".into(), config.to_string()),
        ("DISTILL_BENCH_OPENCODE_PLUGIN".into(), plugin.into()),
    ]
}

/// The protected repository profile's configuration: the text profile's,
/// whose agent answers with no tools, with an agent of its own instead that
/// works in the workspace with OpenCode's local file and shell tools. It
/// delegates to no subagent and fetches nothing from the web, and the policy
/// plugin gives its requests `prompt` as their whole system prompt.
pub(super) fn repository_config(text: &Value, prompt: &str) -> Value {
    let mut config = text.clone();
    config["default_agent"] = json!(REPOSITORY_AGENT);
    config["plugin"] = json!([[
        format!("file://{SANDBOX_CONFIG_HOME}/distill-benchmark-policy.mjs"),
        {"prompt": prompt}
    ]]);
    let agents = config["agent"]
        .as_object_mut()
        .expect("the Z.ai policy configures agents");
    agents.retain(|name, _| name == "title");
    agents.insert(
        REPOSITORY_AGENT.into(),
        json!({
            "description": "Flock repository benchmark: local tools, no delegation",
            "mode": "primary",
            "prompt": prompt,
            "permission": {
                "*": "deny",
                "read": "allow", "list": "allow", "glob": "allow", "grep": "allow",
                "edit": "allow", "bash": "allow", "todowrite": "allow",
                "external_directory": "allow", "doom_loop": "allow"
            }
        }),
    );
    config
}

pub fn highspeed_base(id: &str) -> Option<&str> {
    id.starts_with("zai-coding-plan/glm-")
        .then(|| id.strip_suffix("-highspeed"))
        .flatten()
}

fn model_option(options: &Value) -> Option<&Value> {
    options
        .as_array()?
        .iter()
        .find(|option| option["category"] == "model")
}

fn offers(option: &Value, model: &str) -> bool {
    option["options"].as_array().is_some_and(|choices| {
        choices
            .iter()
            .any(|choice| choice["value"].as_str() == Some(model))
    })
}

fn paired_base<'a>(option: &Value, model: &'a str) -> Option<&'a str> {
    let base = highspeed_base(model).unwrap_or(model);
    (base.starts_with("zai-coding-plan/glm-")
        && offers(option, base)
        && offers(option, &format!("{base}-highspeed")))
    .then_some(base)
}

#[derive(Default)]
pub struct ConfigAdapter {
    /// Native options, retained separately from the menu the host sees.
    sessions: HashMap<String, Value>,
}

impl ConfigAdapter {
    pub fn request(&self, method: &str, mut params: Value) -> Result<Value, Value> {
        if method != "session/set_config_option" || params["configId"] != "fast" {
            return Ok(params);
        }
        let fast = match &params["value"] {
            Value::Bool(value) => *value,
            Value::String(value) if value == "on" => true,
            Value::String(value) if value == "off" => false,
            _ => return Err(protocol::invalid_params("Fast mode must be on or off")),
        };
        let option = params["sessionId"]
            .as_str()
            .and_then(|id| self.sessions.get(id))
            .and_then(model_option)
            .ok_or_else(|| protocol::invalid_params("Z.ai model options are unavailable"))?;
        let base = option["currentValue"]
            .as_str()
            .and_then(|model| paired_base(option, model))
            .ok_or_else(|| protocol::invalid_params("This Z.ai model has no Highspeed variant"))?;
        params["configId"] = option["id"].clone();
        params["value"] = json!(if fast {
            format!("{base}-highspeed")
        } else {
            base.to_string()
        });
        // The native model option is a select, even when the caller used a boolean.
        params
            .as_object_mut()
            .expect("config request")
            .remove("type");
        Ok(params)
    }

    pub fn response(&mut self, method: &str, session: Option<&str>, answer: &mut Value) {
        let session = answer["sessionId"].as_str().or(session).map(str::to_string);
        let Some(session) = session else { return };
        if method == "session/close" {
            self.sessions.remove(&session);
            return;
        }
        if let Some(options) = answer.get_mut("configOptions") {
            self.options(&session, options);
        }
    }

    pub fn notification(&mut self, method: &str, params: &mut Value) {
        if method != "session/update" {
            return;
        }
        let Some(session) = params["sessionId"].as_str().map(str::to_string) else {
            return;
        };
        if params
            .pointer("/update/sessionUpdate")
            .and_then(Value::as_str)
            == Some("config_option_update")
        {
            if let Some(options) = params.pointer_mut("/update/configOptions") {
                self.options(&session, options);
            }
        }
    }

    fn options(&mut self, session: &str, options: &mut Value) {
        let Some(native_model) = model_option(options).cloned() else {
            return;
        };
        self.sessions.insert(session.to_string(), options.clone());
        let current = native_model["currentValue"].as_str().unwrap_or_default();
        let base = paired_base(&native_model, current);
        let Some(options) = options.as_array_mut() else {
            return;
        };
        for option in options
            .iter_mut()
            .filter(|option| option["category"] == "model")
        {
            if let Some(base) = base {
                option["currentValue"] = json!(base);
            }
            if let Some(choices) = option["options"].as_array_mut() {
                choices.retain(|choice| {
                    !choice["value"].as_str().is_some_and(|id| {
                        highspeed_base(id).is_some() && paired_base(&native_model, id).is_some()
                    })
                });
            }
        }
        if base.is_some() {
            options.push(json!({
                "id": "fast", "name": "Fast mode", "category": "model_config",
                "type": "select", "currentValue": if highspeed_base(current).is_some() { "on" } else { "off" },
                "options": [{ "value": "off", "name": "Off" }, { "value": "on", "name": "On" }]
            }));
        }
    }

    /// A speed toggle must retain the selected effort when both variants offer it.
    pub fn effort_to_keep(&self, session: &str) -> Option<(String, String)> {
        let options = self.sessions.get(session)?.as_array()?;
        let option = options
            .iter()
            .find(|option| option["category"] == "thought_level")?;
        Some((
            option["id"].as_str()?.into(),
            option["currentValue"].as_str()?.into(),
        ))
    }
}

#[cfg(test)]
mod tests;
