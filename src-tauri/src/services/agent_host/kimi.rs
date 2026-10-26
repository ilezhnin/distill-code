//! Kimi owns its credentials. Ask its ACP auth gate instead of reading token
//! files or starting a conversation to determine whether it is ready.

use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use doctor::types::AuthStatus;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
    sync::{mpsc, Mutex},
    time::timeout,
};

use super::{
    bridge::{Bridge, SpawnEnv},
    harness,
};

const AUTH_TIMEOUT: Duration = Duration::from_secs(15);

/// Public model definitions from the same CLI configuration chats use. Only
/// declared model fields cross into an isolated runtime: no providers, URLs,
/// credentials, hooks or user configuration. The account there keeps its own
/// sign-in and provider connection.
pub(super) fn model_catalog(env: &HashMap<String, String>) -> Result<Value, String> {
    let home = home(env).ok_or("Kimi Code home is unknown")?;
    let path = home.join("config.toml");
    if std::fs::metadata(&path)
        .map_err(|_| "Kimi model configuration is unavailable")?
        .len()
        > 1024 * 1024
    {
        return Err("Kimi model configuration exceeds its size limit".into());
    }
    let raw =
        std::fs::read_to_string(path).map_err(|_| "Kimi model configuration is unavailable")?;
    public_model_catalog(&raw)
}

fn public_model_catalog(raw: &str) -> Result<Value, String> {
    let config: toml::Value =
        toml::from_str(raw).map_err(|_| "Kimi model configuration is invalid")?;
    let mut models = serde_json::Map::new();
    for (id, model) in config
        .get("models")
        .and_then(toml::Value::as_table)
        .into_iter()
        .flatten()
    {
        if !id.starts_with("kimi-code/")
            || model.get("provider").and_then(toml::Value::as_str) != Some("managed:kimi-code")
        {
            continue;
        }
        let Some(name) = model
            .get("model")
            .and_then(toml::Value::as_str)
            .filter(|name| {
                !name.is_empty() && name.len() <= 160 && !name.chars().any(char::is_control)
            })
        else {
            continue;
        };
        let mut entry = json!({"provider":"managed:kimi-code", "model":name});
        for key in [
            "max_context_size",
            "capabilities",
            "display_name",
            "support_efforts",
            "default_effort",
        ] {
            if let Some(value) = model.get(key) {
                let valid_text = |value: &toml::Value| {
                    value.as_str().is_some_and(|text| {
                        text.len() <= 160 && !text.chars().any(char::is_control)
                    })
                };
                let valid = match key {
                    "max_context_size" => value
                        .as_integer()
                        .is_some_and(|size| (1..=i64::from(u32::MAX)).contains(&size)),
                    "capabilities" | "support_efforts" => value
                        .as_array()
                        .is_some_and(|values| values.len() <= 32 && values.iter().all(valid_text)),
                    _ => valid_text(value),
                };
                if !valid {
                    return Err("Kimi model definition has an invalid public field".into());
                }
                entry[key] =
                    serde_json::to_value(value).map_err(|_| "Kimi model definition is invalid")?;
            }
        }
        models.insert(id.clone(), entry);
    }
    Ok(Value::Object(models))
}

/// Where the Kimi Code CLI keeps its configuration and sessions: its own
/// `KIMI_CODE_HOME`, else `~/.kimi-code`.
pub(super) fn home(env: &HashMap<String, String>) -> Option<PathBuf> {
    crate::services::env_key::get(env, "KIMI_CODE_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".kimi-code")))
}

// Kimi Code 2.1 answers a failed turn over ACP with a plain `end_turn` and
// keeps the error to itself: its stop-reason mapping reads "`failed` ->
// `end_turn` (with the out-of-band `error` logged by the caller)". Only a
// filtered response becomes `refusal` and only an auth failure a JSON-RPC
// error. So a chat whose quota ran out (HTTP 429) ends in silence on the
// wire, while the session record under the Kimi home ends the turn with
// `turn.ended`, its reason and the provider error (seen 2026-10-25). The
// host reads that record after an `end_turn` and fails the prompt the way
// the Claude and Codex bridges do in their `sessionFailure`.

/// The session index and the wire record are files of the CLI; bound what
/// is read of them.
const SESSION_INDEX_LIMIT_BYTES: u64 = 32 * 1024 * 1024;
const WIRE_TAIL_BYTES: u64 = 512 * 1024;
const FAILURE_MESSAGE_CHARS: usize = 2_000;

/// The error a Kimi session recorded for a turn that ended `failed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TurnFailure {
    pub code: Option<String>,
    pub name: Option<String>,
    pub message: String,
    pub status_code: Option<u64>,
    pub retryable: Option<bool>,
}

/// How the last turn on a session record ended, relative to the prompt the
/// host sent at `since_ms`.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum TurnOutcome {
    /// A turn ended after the prompt was sent, and it failed.
    Failed(TurnFailure),
    /// A turn ended after the prompt was sent, and it did not fail.
    Ended,
    /// No turn that ended after the prompt was sent is on record (yet), or
    /// there is no record to read.
    Unknown,
}

impl TurnFailure {
    /// An exhausted allowance, which the CLI names; a 429 that speaks of a
    /// usage limit is the same thing under an older or renamed class.
    pub(super) fn is_quota(&self) -> bool {
        self.name.as_deref() == Some("APIProviderQuotaExhaustedError")
            || (self.status_code == Some(429)
                && self.message.to_ascii_lowercase().contains("usage limit"))
    }

    /// The prompt error the host answers with instead of the empty
    /// `end_turn`: the kinds the Claude and Codex bridges report, so account
    /// routing (`is_quota_error`) and the renderer treat all three alike.
    pub(super) fn prompt_error(&self) -> Value {
        let kind = if self.is_quota() {
            "quota_exhausted"
        } else {
            "provider_failure"
        };
        super::protocol::error_with_data(
            super::protocol::INTERNAL_ERROR,
            format!("Kimi Code: {}", self.message),
            json!({
                "errorKind": kind,
                "kimiTurnError": {
                    "code": self.code,
                    "name": self.name,
                    "statusCode": self.status_code,
                    "retryable": self.retryable,
                },
            }),
        )
    }
}

/// The directory `session_index.jsonl` names for `session_id`. The last row
/// wins: the CLI appends a new one when a session moves.
fn session_dir_from_index(index: &str, session_id: &str) -> Option<PathBuf> {
    index
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|row| row["sessionId"].as_str() == Some(session_id))
        .and_then(|row| row["sessionDir"].as_str().map(PathBuf::from))
}

/// The session directory under `home`: what the index says, else the
/// `sessions/<work dir>/<session id>` layout, which a session too new for the
/// index already has.
fn session_dir(home: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    let index = home.join("session_index.jsonl");
    if std::fs::metadata(&index).is_ok_and(|meta| meta.len() <= SESSION_INDEX_LIMIT_BYTES) {
        if let Some(dir) = std::fs::read_to_string(&index)
            .ok()
            .and_then(|text| session_dir_from_index(&text, session_id))
            .filter(|dir| dir.is_dir())
        {
            return Some(dir);
        }
    }
    std::fs::read_dir(home.join("sessions"))
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(session_id))
        .find(|dir| dir.is_dir())
}

/// The last `WIRE_TAIL_BYTES` of `path`, cut to whole lines.
fn read_tail(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(WIRE_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        // The first line is cut in the middle; the turn is at the end.
        let cut = text.find('\n')?;
        text.drain(..=cut);
    }
    Some(text)
}

/// How the last turn in `wire_tail` ended, for a prompt sent at `since_ms`.
/// Both clocks are the same machine, so a turn that ended before the prompt
/// went out is an earlier turn, not this one.
fn last_turn_outcome(wire_tail: &str, since_ms: i64) -> TurnOutcome {
    let Some(ended) = wire_tail
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|event| event["type"].as_str() == Some("turn.ended"))
    else {
        return TurnOutcome::Unknown;
    };
    if ended["time"].as_i64().is_none_or(|time| time < since_ms) {
        return TurnOutcome::Unknown;
    }
    if ended["reason"].as_str() != Some("failed") {
        return TurnOutcome::Ended;
    }
    let error = &ended["error"];
    let text = |key: &str| {
        error[key]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| text.chars().take(FAILURE_MESSAGE_CHARS).collect::<String>())
    };
    TurnOutcome::Failed(TurnFailure {
        code: text("code"),
        name: text("name"),
        message: text("message").unwrap_or_else(|| "the turn failed without a message".into()),
        status_code: error["details"]["statusCode"].as_u64(),
        retryable: error["retryable"].as_bool(),
    })
}

/// How the Kimi session `session_id` under `home` ended its last turn, for a
/// prompt the host sent at `since_ms` (Unix milliseconds).
pub(super) fn turn_outcome(home: &Path, session_id: &str, since_ms: i64) -> TurnOutcome {
    let Some(dir) = session_dir(home, session_id) else {
        return TurnOutcome::Unknown;
    };
    let Some(tail) = read_tail(&dir.join("agents").join("main").join("wire.jsonl")) else {
        return TurnOutcome::Unknown;
    };
    last_turn_outcome(&tail, since_ms)
}

pub(super) fn annotate_models(rows: &mut [Value], catalog: &Value) {
    for row in rows {
        let model = row["id"].as_str().and_then(|id| catalog.get(id));
        let context = model
            .and_then(|model| model["max_context_size"].as_u64())
            .filter(|context| *context > 0);
        let configured = model.cloned().unwrap_or(Value::Null);
        row["contextLimit"] = json!(context);
        row["kimiModel"] = configured;
    }
}

pub(super) fn sandbox_catalog(rows: &[Value]) -> Result<String, String> {
    let models: serde_json::Map<String, Value> = rows
        .iter()
        .filter_map(|row| {
            let id = row["id"].as_str()?;
            let model = row.get("kimiModel").filter(|model| model.is_object())?;
            Some((id.to_owned(), model.clone()))
        })
        .collect();
    if models.is_empty() {
        return Err(
            "capability_missing: refresh Kimi's shared model catalogue before starting a benchmark"
                .into(),
        );
    }
    let serialized = serde_json::to_string(&models)
        .map_err(|_| "Kimi model catalogue could not be serialized")?;
    if serialized.len() > 16 * 1024 {
        return Err("capability_missing: Kimi model catalogue exceeds its launch limit".into());
    }
    Ok(serialized)
}

async fn request(method: &str, env: HashMap<String, String>) -> Result<Value, Value> {
    let operation = async {
        let (events, _receiver) = mpsc::unbounded_channel();
        let bridge = Bridge::spawn(
            harness::harness("kimi-acp").expect("registered Kimi harness"),
            &SpawnEnv {
                shell_env: env,
                prepend_dirs: vec![],
                extra_env: vec![],
                remove_env: vec![],
            },
            events,
        )
        .await
        .map_err(|_| json!({ "code": -32603 }))?;
        let params = if method == "authenticate" {
            json!({ "methodId": "login" })
        } else {
            json!({})
        };
        let result = bridge.request(method, params).await;
        bridge.kill();
        result
    };
    timeout(AUTH_TIMEOUT, operation)
        .await
        .unwrap_or_else(|_| Err(json!({ "code": -32603 })))
}

fn status_from_result(result: &Result<Value, Value>) -> AuthStatus {
    match result {
        Ok(_) => AuthStatus::Authenticated,
        Err(error) if error.get("code").and_then(Value::as_i64) == Some(-32000) => {
            AuthStatus::NotAuthenticated
        }
        Err(_) => AuthStatus::Unknown,
    }
}

pub(crate) async fn auth_status(env: HashMap<String, String>) -> AuthStatus {
    status_from_result(&request("authenticate", env).await)
}

pub(crate) async fn logout(env: HashMap<String, String>) -> Result<(), String> {
    request("logout", env).await.map(|_| ()).map_err(|_| {
        "Kimi Code could not sign out through ACP. Check the CLI installation and try again."
            .to_string()
    })
}

// ACP has no quota method. Kimi's authenticated local API does, and owns the
// refresh-token transaction shared with its chats. A short-lived loopback
// process avoids duplicating OAuth or leaving a background server behind.
static USAGE_LOCK: Mutex<()> = Mutex::const_new(());

struct UsageEndpoint {
    origin: String,
    token: String,
}

fn usage_endpoint(line: &str) -> Option<UsageEndpoint> {
    let line = line.trim();
    // Native Kimi prints an indented `Local:` row. Retain the earlier CLI
    // banner as well; both must still identify an authenticated loopback URL.
    let address = line
        .strip_prefix("Local:")
        .or_else(|| line.strip_prefix("Kimi server:"))?
        .trim();
    let url = reqwest::Url::parse(address).ok()?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.path() != "/"
    {
        return None;
    }
    let token = url.fragment()?.strip_prefix("token=")?;
    if token.is_empty()
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    Some(UsageEndpoint {
        origin: url.origin().ascii_serialization(),
        token: token.into(),
    })
}

async fn request_managed_usage(
    client: &reqwest::Client,
    endpoint: &UsageEndpoint,
) -> Result<Value, String> {
    let mut usage = request_managed_data(client, endpoint, "usage").await?;
    // Profile metadata is optional: a failed profile read must not hide quotas.
    if usage["kind"] == "ok" {
        if let Ok(profile) = request_managed_data(client, endpoint, "userinfo").await {
            if profile["kind"] == "ok" && profile["userInfo"].is_object() {
                usage["userInfo"] = profile["userInfo"].clone();
            }
        }
    }
    Ok(usage)
}

async fn request_managed_data(
    client: &reqwest::Client,
    endpoint: &UsageEndpoint,
    resource: &str,
) -> Result<Value, String> {
    let response = client
        .get(format!("{}/api/v1/oauth/{resource}", endpoint.origin))
        .bearer_auth(&endpoint.token)
        .send()
        .await
        .map_err(|_| "Kimi Code usage request failed".to_string())?;
    if !response.status().is_success() {
        return Err("Kimi Code local usage API rejected the request".into());
    }
    let envelope: Value = response
        .json()
        .await
        .map_err(|_| "Kimi Code usage response was invalid".to_string())?;
    if envelope.get("code").and_then(Value::as_i64) != Some(0) {
        return Err("Kimi Code local usage API returned an error".into());
    }
    envelope
        .get("data")
        .cloned()
        .ok_or_else(|| "Kimi Code usage response was empty".into())
}

pub(crate) async fn managed_usage(
    root: &Path,
    env: &HashMap<String, String>,
) -> Result<Value, String> {
    let operation = async {
        let _guard = USAGE_LOCK.lock().await;
        let executable = crate::services::path_env::resolve_executable(
            harness::harness("kimi-acp")
                .expect("registered Kimi harness")
                .command,
            &[],
            crate::services::env_key::get(env, "PATH"),
        )
        .ok_or_else(|| "Kimi Code CLI is not installed".to_string())?;
        let mut command = Command::new(executable);
        command
            .args(["web", "--port", "0", "--no-open", "--log-level", "silent"])
            .current_dir(root)
            .envs(env)
            .env("KIMI_CODE_HOME", root)
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .env("KIMI_DISABLE_TELEMETRY", "1")
            .env("KIMI_DISABLE_CRON", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        crate::services::shell_env::remove_inherited_launcher_env(command.as_std_mut());
        crate::services::process::apply_no_window_async(&mut command);
        let mut child = command
            .spawn()
            .map_err(|_| "Kimi Code usage helper could not start".to_string())?;
        let tree = crate::services::process::ProcessTree::contain(&child);
        if cfg!(windows) && tree.is_none() {
            let _ = child.kill().await;
            return Err("Kimi Code usage helper could not be contained".into());
        }
        let output = child
            .stdout
            .take()
            .ok_or_else(|| "Kimi Code usage output is unavailable".to_string())?;
        let mut lines = BufReader::new(output.take(64 * 1024)).lines();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "Kimi Code local HTTP client could not start".to_string())?;
        let response = async {
            while let Some(line) = lines
                .next_line()
                .await
                .map_err(|_| "Kimi Code usage helper stopped".to_string())?
            {
                let Some(endpoint) = usage_endpoint(&line) else {
                    continue;
                };
                let response = request_managed_usage(&client, &endpoint).await;
                // Graceful shutdown lets Kimi remove its server registration.
                let _ = client
                    .post(format!("{}/api/v1/shutdown", endpoint.origin))
                    .bearer_auth(&endpoint.token)
                    .timeout(Duration::from_secs(2))
                    .send()
                    .await;
                return response;
            }
            Err("Kimi Code did not provide its local usage API. Update the CLI and retry.".into())
        }
        .await;
        if timeout(Duration::from_secs(1), child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
        drop(tree);
        response
    };
    timeout(Duration::from_secs(30), operation)
        .await
        .unwrap_or_else(|_| Err("Kimi Code usage request timed out".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUOTA_TURN_ENDED: &str = r#"{"type":"turn.ended","agentId":"main","turnId":175,"reason":"failed","error":{"code":"provider.api_error","message":"429 You have reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.","name":"APIProviderQuotaExhaustedError","details":{"statusCode":429,"requestId":null,"traceId":"3b9f074fa79447b28e8d8350c32c2b70"},"retryable":false},"durationMs":2225,"traceId":"3b9f074fa79447b28e8d8350c32c2b70","time":1792969992996}"#;

    fn wire(lines: &[&str]) -> String {
        let mut text = String::new();
        for line in lines {
            text.push_str(line);
            text.push('\n');
        }
        text
    }

    #[test]
    fn a_quota_failure_on_record_fails_the_prompt_as_an_exhausted_allowance() {
        let tail = wire(&[
            r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"step.end","turnId":"175","step":1,"finishReason":"error"},"time":1792969992971}"#,
            QUOTA_TURN_ENDED,
            r#"{"type":"prompt.completed","agentId":"main","promptId":"msg_1","finishedAt":"2026-10-25T23:13:13.008Z","reason":"failed","time":1792969993008}"#,
        ]);
        let TurnOutcome::Failed(failure) = last_turn_outcome(&tail, 1792969990000) else {
            panic!("a failed turn after the prompt");
        };
        assert!(failure.is_quota());
        assert_eq!(failure.status_code, Some(429));
        assert_eq!(failure.retryable, Some(false));
        let error = failure.prompt_error();
        assert_eq!(error["code"], super::super::protocol::INTERNAL_ERROR);
        assert_eq!(error["data"]["errorKind"], "quota_exhausted");
        assert_eq!(
            error["data"]["kimiTurnError"]["name"],
            "APIProviderQuotaExhaustedError"
        );
        assert!(error["message"]
            .as_str()
            .unwrap()
            .starts_with("Kimi Code: 429 You have reached your 5-hour usage limit"));
        // Account routing reads it the way it reads a Claude or Codex limit.
        assert!(crate::services::provider_account_status::is_quota_error(
            &error
        ));
    }

    #[test]
    fn other_failures_are_provider_failures_and_a_clean_turn_is_none() {
        let server = r#"{"type":"turn.ended","agentId":"main","turnId":3,"reason":"failed","error":{"code":"provider.api_error","message":"502 upstream unavailable","name":"APIProviderError","details":{"statusCode":502}},"time":2000}"#;
        let TurnOutcome::Failed(failure) = last_turn_outcome(&wire(&[server]), 1000) else {
            panic!("a failed turn");
        };
        assert!(!failure.is_quota());
        let error = failure.prompt_error();
        assert_eq!(error["data"]["errorKind"], "provider_failure");
        assert!(!crate::services::provider_account_status::is_quota_error(
            &error
        ));
        // A 429 speaking of a usage limit counts even under another name.
        let renamed = r#"{"type":"turn.ended","agentId":"main","turnId":4,"reason":"failed","error":{"code":"provider.api_error","message":"429 usage limit reached","name":"APIProviderError","details":{"statusCode":429}},"time":2000}"#;
        let TurnOutcome::Failed(failure) = last_turn_outcome(&wire(&[renamed]), 1000) else {
            panic!("a failed turn");
        };
        assert!(failure.is_quota());
        let completed = r#"{"type":"turn.ended","agentId":"main","turnId":5,"reason":"completed","durationMs":10,"time":2000}"#;
        assert_eq!(
            last_turn_outcome(&wire(&[QUOTA_TURN_ENDED, completed]), 1000),
            TurnOutcome::Ended
        );
        let cancelled =
            r#"{"type":"turn.ended","agentId":"main","turnId":6,"reason":"cancelled","time":2000}"#;
        assert_eq!(
            last_turn_outcome(&wire(&[cancelled]), 1000),
            TurnOutcome::Ended
        );
        // A missing error message still names a failure.
        let bare =
            r#"{"type":"turn.ended","agentId":"main","turnId":7,"reason":"failed","time":2000}"#;
        let TurnOutcome::Failed(failure) = last_turn_outcome(&wire(&[bare]), 1000) else {
            panic!("a failed turn");
        };
        assert!(!failure.is_quota());
        assert!(!failure.message.is_empty());
    }

    #[test]
    fn a_turn_that_ended_before_the_prompt_is_not_this_turn() {
        // The record ends at 1792969992996; a prompt sent later finds nothing.
        assert_eq!(
            last_turn_outcome(&wire(&[QUOTA_TURN_ENDED]), 1792969992997),
            TurnOutcome::Unknown
        );
        assert_eq!(last_turn_outcome("", 0), TurnOutcome::Unknown);
        assert_eq!(
            last_turn_outcome("not json\n{\"type\":\"other\"}\n", 0),
            TurnOutcome::Unknown
        );
        let untimed = r#"{"type":"turn.ended","agentId":"main","turnId":8,"reason":"failed"}"#;
        assert_eq!(
            last_turn_outcome(&wire(&[untimed]), 0),
            TurnOutcome::Unknown
        );
    }

    #[test]
    fn the_session_record_is_found_through_the_index_or_the_sessions_layout() {
        let home = tempfile::tempdir().unwrap();
        let moved = home
            .path()
            .join("sessions")
            .join("wd_old_1")
            .join("session_a");
        let current = home
            .path()
            .join("sessions")
            .join("wd_new_2")
            .join("session_a");
        let fresh = home
            .path()
            .join("sessions")
            .join("wd_new_2")
            .join("session_b");
        for dir in [&moved, &current, &fresh] {
            std::fs::create_dir_all(dir.join("agents").join("main")).unwrap();
        }
        let row = |dir: &Path| {
            format!(
                "{}\n",
                json!({"sessionId":"session_a","sessionDir":dir.to_string_lossy(),"workDir":"E:/x"})
            )
        };
        std::fs::write(
            home.path().join("session_index.jsonl"),
            format!("{}{}", row(&moved), row(&current)),
        )
        .unwrap();
        // The last index row wins.
        assert_eq!(session_dir(home.path(), "session_a").unwrap(), current);
        // A session the index has not caught up with is found by layout.
        assert_eq!(session_dir(home.path(), "session_b").unwrap(), fresh);
        assert!(session_dir(home.path(), "session_c").is_none());
        assert!(session_dir(home.path(), "../session_a").is_none());

        // The whole read: a record long enough to need the tail cut.
        let wire_path = current.join("agents").join("main").join("wire.jsonl");
        let mut text = String::new();
        let filler = format!(
            "{}\n",
            json!({"type":"llm.request","agentId":"main","payload":"x".repeat(4000)})
        );
        while (text.len() as u64) < WIRE_TAIL_BYTES + 100_000 {
            text.push_str(&filler);
        }
        text.push_str(QUOTA_TURN_ENDED);
        text.push('\n');
        std::fs::write(&wire_path, text).unwrap();
        let TurnOutcome::Failed(failure) = turn_outcome(home.path(), "session_a", 1792969990000)
        else {
            panic!("the failure at the end of the record");
        };
        assert!(failure.is_quota());
        assert_eq!(
            turn_outcome(home.path(), "session_a", 1792969999999),
            TurnOutcome::Unknown
        );
        assert_eq!(
            turn_outcome(home.path(), "session_b", 0),
            TurnOutcome::Unknown
        );
        assert_eq!(
            turn_outcome(home.path(), "session_c", 0),
            TurnOutcome::Unknown
        );
    }

    #[test]
    fn shared_kimi_catalogue_projects_new_models_without_account_configuration() {
        let catalog = public_model_catalog(
            r#"
default_model = "kimi-code/future"
[providers."managed:kimi-code"]
api_key = "synthetic-secret-must-not-cross"
[models."kimi-code/future"]
provider = "managed:kimi-code"
model = "future"
display_name = "Future model"
max_context_size = 1048576
capabilities = ["thinking", "tool_use"]
support_efforts = ["low", "max"]
default_effort = "max"
api_key = "synthetic-secret-must-not-cross"
hooks = ["must-not-cross"]
[models."custom/private"]
provider = "custom"
model = "private"
"#,
        )
        .unwrap();
        let mut rows = vec![
            json!({"id":"kimi-code/future"}),
            json!({"id":"custom/private"}),
        ];
        annotate_models(&mut rows, &catalog);
        assert_eq!(rows[0]["contextLimit"], 1048576);
        assert!(rows[1]["contextLimit"].is_null());
        // Both the inventory response and known_models merge the stored
        // probe with display defaults before the sandbox launch reads it.
        let rows = harness::merge_inventory("kimi-acp", rows);
        let rows = harness::merge_inventory("kimi-acp", rows);
        let merged = rows
            .iter()
            .find(|row| row["id"] == "kimi-code/future")
            .unwrap();
        assert_eq!(merged["contextLimit"], 1048576);
        let projected = sandbox_catalog(&rows).unwrap();
        let parsed: Value = serde_json::from_str(&projected).unwrap();
        assert_eq!(parsed["kimi-code/future"]["model"], "future");
        assert_eq!(parsed.as_object().unwrap().len(), 1);
        assert!(!projected.contains("must-not-cross"));
        assert!(!projected.contains("api_key"));
        assert!(sandbox_catalog(&[]).is_err());
        assert!(public_model_catalog(
            r#"[models."kimi-code/invalid"]
provider = "managed:kimi-code"
model = "invalid"
capabilities = [{ api_key = "not-a-capability" }]
"#
        )
        .is_err());
    }

    fn usage_server(
        paths: &[&'static str],
        body: &'static str,
    ) -> (UsageEndpoint, std::thread::JoinHandle<()>) {
        use std::io::{BufRead, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = UsageEndpoint {
            origin: format!("http://{}", listener.local_addr().unwrap()),
            token: "test-token".into(),
        };
        let paths = paths.to_vec();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            for expected in paths {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "usage helper never requested {expected}"
                            );
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                // Windows can inherit the listener's nonblocking mode.
                // Header reads below wait for a complete bounded request.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                // TCP may split the headers across reads. Bound their size and
                // wait for the entire request before checking authorization.
                let mut reader = std::io::BufReader::new((&mut stream).take(4096));
                let mut request = String::new();
                while !request.ends_with("\r\n\r\n") {
                    assert!(
                        reader.read_line(&mut request).unwrap() > 0,
                        "incomplete HTTP headers"
                    );
                }
                let request = request.to_ascii_lowercase();
                assert!(request.starts_with(expected));
                assert!(request.contains("\r\nauthorization: bearer test-token\r\n"));
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (endpoint, server)
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn usage_runs_with_the_private_cli_and_runtime_from_setup() {
        let root = tempfile::tempdir().unwrap();
        let prefix = root.path().join("managed npm prefix");
        let runtime = root.path().join("managed node runtime");
        std::fs::create_dir_all(&prefix).unwrap();
        std::fs::create_dir_all(&runtime).unwrap();
        let (endpoint, server) = usage_server(
            &[
                "get /api/v1/oauth/usage ",
                "get /api/v1/oauth/userinfo ",
                "post /api/v1/shutdown ",
            ],
            r#"{"code":0,"data":{"kind":"ok","quota":{"usages":{"monthTotal":{"usedRatio":0.25}}}}}"#,
        );
        std::fs::write(
            prefix.join("kimi.cmd"),
            "@echo off\r\nif not \"%~1\"==\"web\" exit /b 2\r\nif not \"%DISTILL_KIMI_CAPTURED_TEST%\"==\"captured\" exit /b 3\r\nif not \"%KIMI_CODE_HOME%\"==\"%CD%\" exit /b 4\r\ncall kimi-test-runtime.cmd\r\n",
        ).unwrap();
        std::fs::write(
            runtime.join("kimi-test-runtime.cmd"),
            format!(
                "@echo off\r\necho   Local:    {}#token={}\r\n",
                endpoint.origin, endpoint.token
            ),
        )
        .unwrap();
        let captured = HashMap::from([
            ("Path".into(), String::new()),
            ("DISTILL_KIMI_CAPTURED_TEST".into(), "captured".into()),
        ]);
        let env = crate::services::path_env::env_vars_with_extended_path_and_prepended_dirs(
            &captured,
            &[prefix, runtime],
        )
        .into_iter()
        .collect();
        let response = managed_usage(root.path(), &env).await;
        server.join().unwrap();
        assert_eq!(
            response.unwrap()["quota"]["usages"]["monthTotal"]["usedRatio"],
            0.25
        );
    }

    #[test]
    fn usage_handshake_accepts_only_an_authenticated_loopback_endpoint() {
        for line in [
            "  Local:    http://127.0.0.1:3456#token=test-token",
            "Kimi server: http://127.0.0.1:3456#token=test-token",
        ] {
            let ready = usage_endpoint(line).unwrap();
            assert_eq!(ready.origin, "http://127.0.0.1:3456");
            assert_eq!(ready.token, "test-token");
        }
        for line in [
            "  Local:    https://example.com#token=secret",
            "  Network:  http://127.0.0.1:3456#token=secret",
            "  Local:    http://127.0.0.1:3456",
            "Kimi server: https://example.com#token=secret",
            "Kimi server: http://0.0.0.0:3456#token=secret",
            "Kimi server: http://127.0.0.1:3456",
            "Kimi server: http://127.0.0.1:3456#token=",
            "Kimi server: http://user@127.0.0.1:3456#token=secret",
            "Kimi server: http://127.0.0.1:3456?redirect=other#token=secret",
        ] {
            assert!(usage_endpoint(line).is_none());
        }
    }

    #[tokio::test]
    async fn reads_usage_and_profile_from_kimis_authenticated_local_api() {
        let (endpoint, server) = usage_server(
            &["get /api/v1/oauth/usage ", "get /api/v1/oauth/userinfo "],
            r#"{"code":0,"data":{"kind":"ok","quota":{"usages":{"limit5h":{"usedRatio":0.5}}},"userInfo":{"email":"kimi@example.test","userLevelName":"Plus"}}}"#,
        );
        let data = request_managed_usage(
            &reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            &endpoint,
        )
        .await;
        server.join().unwrap();
        let data = data.unwrap();
        assert_eq!(data["quota"]["usages"]["limit5h"]["usedRatio"], 0.5);
        assert_eq!(data["userInfo"]["userLevelName"], "Plus");
    }

    #[tokio::test]
    async fn profile_failure_does_not_discard_successful_usage() {
        let (endpoint, server) = usage_server(
            &["get /api/v1/oauth/usage "],
            r#"{"code":0,"data":{"kind":"ok","quota":{"usages":{"limit5h":{"usedRatio":0.5}}}}}"#,
        );
        let data = request_managed_usage(
            &reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            &endpoint,
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(data["quota"]["usages"]["limit5h"]["usedRatio"], 0.5);
        assert!(data.get("userInfo").is_none());
    }

    #[test]
    fn auth_required_is_distinct_from_a_broken_or_unavailable_cli() {
        assert_eq!(
            status_from_result(&Ok(json!({}))),
            AuthStatus::Authenticated
        );
        assert_eq!(
            status_from_result(&Err(
                json!({ "code": -32000, "message": "Authentication required" })
            )),
            AuthStatus::NotAuthenticated
        );
        for code in [-32601, -32602, -32603] {
            assert_eq!(
                status_from_result(&Err(json!({ "code": code }))),
                AuthStatus::Unknown
            );
        }
    }
}
