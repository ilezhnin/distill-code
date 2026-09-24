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
            &["get /api/v1/oauth/usage ", "post /api/v1/shutdown "],
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
    async fn reads_structured_usage_from_kimis_authenticated_local_api() {
        let (endpoint, server) = usage_server(
            &["get /api/v1/oauth/usage "],
            r#"{"code":0,"data":{"kind":"ok","quota":{"usages":{"limit5h":{"usedRatio":0.5}}}}}"#,
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
        assert_eq!(
            data.unwrap()["quota"]["usages"]["limit5h"]["usedRatio"],
            0.5
        );
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
