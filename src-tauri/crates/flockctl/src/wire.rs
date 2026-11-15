//! Maps parsed ArgMatches onto the wire contract pinned by cli-surface.json
//! — `("<group>", {"action": "<verb>", ...flags})` — and extracts the global
//! flags. Field traversal is driven by the same api-surface.json specs
//! `tree::build_cli` built the args from, so the two sides cannot disagree
//! about a flag's name or type.

use std::path::PathBuf;

use clap::ArgMatches;
use serde_json::{Map, Value};

use crate::contract::Contract;

/// The top-level flags, valid at any position (clap globals).
pub struct Globals {
    pub lock_path: Option<PathBuf>,
    pub json: bool,
    pub timeout_ms: Option<u64>,
    /// The calling agent session's identity, from AGENT_SESSION_ID. Empty
    /// values are dropped here so the wire never carries an empty actor.
    pub actor: Option<String>,
    /// Whether the call is made from an agent session's shell, from
    /// FLOCK_AGENT_SHELL. Empty and "0" read as unset.
    pub agent_shell: bool,
}

pub fn globals(matches: &ArgMatches) -> Globals {
    Globals {
        lock_path: matches.get_one::<PathBuf>("lock_path").cloned(),
        json: matches.get_flag("json"),
        timeout_ms: matches.get_one::<u64>("timeout_ms").copied(),
        actor: matches
            .get_one::<String>("actor")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        agent_shell: matches
            .get_one::<String>("agent_shell")
            .map(|value| value.trim())
            .is_some_and(|value| !value.is_empty() && value != "0"),
    }
}

pub enum Invocation {
    Call {
        /// The wire command (registry group), e.g. "sessions".
        group: String,
        /// `{"action": "<verb>", ...flags}`.
        body: Map<String, Value>,
    },
}

/// The variable a script reads its session's token from.
///
/// A session that may start others is told a token and passes it as
/// `--session-token`. A script the session starts to do its work — a
/// dispatcher that fans a job out over many sessions — has no place to
/// pass a flag it was written without, and was refused every session it
/// tried to start: its conductor then asked the operator to run the
/// script from their own terminal (11-16). The session sets this variable
/// in the script's environment instead, and every `flockctl` the script
/// runs carries the token as if the flag had been given. The flag wins
/// when both are present.
pub const SESSION_TOKEN_ENV: &str = "FLOCK_SESSION_TOKEN";
const SESSION_TOKEN_FIELD: &str = "session_token";

pub fn invocation(contract: &Contract, matches: &ArgMatches) -> Invocation {
    invocation_with_env(contract, matches, |name| std::env::var(name).ok())
}

/// [`invocation`], with the environment handed in so a test names its own.
pub fn invocation_with_env(
    contract: &Contract,
    matches: &ArgMatches,
    env: impl Fn(&str) -> Option<String>,
) -> Invocation {
    let (noun, noun_matches) = matches
        .subcommand()
        .expect("clap enforces subcommand_required");
    let spec = contract
        .surface
        .nouns
        .get(noun)
        .unwrap_or_else(|| panic!("clap only parses contract nouns, got `{noun}`"));
    let (verb, verb_matches) = noun_matches
        .subcommand()
        .expect("clap enforces subcommand_required");
    let action = &spec
        .verbs
        .get(verb)
        .unwrap_or_else(|| panic!("clap only parses contract verbs, got `{noun} {verb}`"))
        .action;

    let mut body = built_body(contract, &spec.group, action, verb_matches);
    let takes_token = contract
        .field_specs(&spec.group, action)
        .is_some_and(|fields| fields.iter().any(|field| field.name == SESSION_TOKEN_FIELD));
    if takes_token && !body.contains_key(SESSION_TOKEN_FIELD) {
        // An exported-but-empty variable is no token, like an unset one.
        if let Some(token) = env(SESSION_TOKEN_ENV)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
        {
            body.insert(SESSION_TOKEN_FIELD.into(), Value::String(token));
        }
    }
    Invocation::Call {
        group: spec.group.clone(),
        body,
    }
}

fn action_body(verb: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("action".into(), Value::String(verb.into()));
    map
}

/// Generic flag → wire-field mapping: absent optionals are omitted entirely
/// (the registry's strict schemas reject null), and numbers stay numbers.
fn built_body(
    contract: &Contract,
    group: &str,
    action: &str,
    matches: &ArgMatches,
) -> Map<String, Value> {
    let mut map = action_body(action);
    let specs = contract
        .field_specs(group, action)
        .unwrap_or_else(|| panic!("validated: api-surface has `{group}.{action}`"));
    for field in specs {
        let value = match field.kind.as_str() {
            "string" => matches
                .get_one::<String>(&field.name)
                .map(|value| Value::String(value.clone())),
            "string_array" => matches
                .get_many::<String>(&field.name)
                .map(|values| Value::Array(values.cloned().map(Value::String).collect())),
            "number" => matches
                .get_one::<u32>(&field.name)
                .map(|value| Value::from(*value)),
            "boolean" => matches
                .get_one::<bool>(&field.name)
                .copied()
                .filter(|value| *value)
                .map(Value::Bool),
            other => unreachable!("validation rejects wire kind `{other}`"),
        };
        if let Some(value) = value {
            map.insert(field.name.clone(), value);
        }
    }
    map
}
