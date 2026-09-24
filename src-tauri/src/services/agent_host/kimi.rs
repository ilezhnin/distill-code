//! Kimi owns its credentials. Ask its ACP auth gate instead of reading token
//! files or starting a conversation to determine whether it is ready.

use std::{collections::HashMap, path::Path, process::Stdio, time::Duration};

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

async fn request(method: &str, env: HashMap<String, String>) -> Result<Value, Value> {
    let operation = async {
        let (events, _receiver) = mpsc::unbounded_channel();
        let bridge = Bridge::spawn(
            harness::harness("kimi-acp").expect("registered Kimi harness"),
            &SpawnEnv {
                shell_env: env,
                prepend_dirs: vec![],
                extra_env: vec![],
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
    let url = reqwest::Url::parse(line.trim().strip_prefix("Kimi server: ")?).ok()?;
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
    let response = client
        .get(format!("{}/api/v1/oauth/usage", endpoint.origin))
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

pub(crate) async fn managed_usage(root: &Path) -> Result<Value, String> {
    let operation = async {
        let _guard = USAGE_LOCK.lock().await;
        let path = crate::services::path_env::build_extended_path_with_prepended_dirs(
            crate::services::shell_env::user_env_var("PATH").as_deref(),
            &[],
        );
        let executable = super::bridge::resolve_executable("kimi", &[], Some(&path))
            .ok_or_else(|| "Kimi Code CLI is not installed".to_string())?;
        let mut command = Command::new(executable);
        command
            .args(["web", "--port", "0", "--no-open", "--log-level", "silent"])
            .current_dir(root)
            .env("PATH", path)
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

    #[test]
    fn usage_handshake_accepts_only_an_authenticated_loopback_endpoint() {
        let ready = usage_endpoint("Kimi server: http://127.0.0.1:3456#token=test-token").unwrap();
        assert_eq!(ready.origin, "http://127.0.0.1:3456");
        assert_eq!(ready.token, "test-token");
        for line in [
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
    async fn reads_structured_usage_from_kimis_authenticated_local_api() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let count = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..count]).to_lowercase();
            assert!(request.starts_with("get /api/v1/oauth/usage "));
            assert!(request.contains("authorization: bearer test-token"));
            let body = r#"{"code":0,"data":{"kind":"ok","quota":{"usages":{"limit5h":{"usedRatio":0.5}}}}}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let data = request_managed_usage(
            &reqwest::Client::builder().no_proxy().build().unwrap(),
            &UsageEndpoint {
                origin: format!("http://{address}"),
                token: "test-token".into(),
            },
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(data["quota"]["usages"]["limit5h"]["usedRatio"], 0.5);
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
