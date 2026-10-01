//! Browser login through Codex's native account protocol. OAuth and credential
//! storage stay in the selected CLI home; no tokens enter Distill's renderer.

use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::Instant;

use super::LoginOutcome;
use crate::services::process::ProcessTree;

const MAX_MESSAGE_BYTES: u64 = 64 * 1024;
const START_TIMEOUT: Duration = Duration::from_secs(25);

pub(super) async fn run(
    mut command: Command,
    mut cancelled: watch::Receiver<bool>,
    deadline: Instant,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> Result<LoginOutcome, String> {
    if *cancelled.borrow() {
        return Ok(LoginOutcome::Cancelled);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Could not start the Codex sign-in service")?;
    // The app opens the browser, so it is never part of this process tree.
    let tree = ProcessTree::contain(&child);
    let operation = async {
        let input = child
            .stdin
            .take()
            .ok_or("Codex sign-in input unavailable")?;
        let output = child
            .stdout
            .take()
            .ok_or("Codex sign-in output unavailable")?;
        let mut client = LoginClient {
            input,
            output: BufReader::new(output),
        };
        client.login(open_browser).await.map(LoginOutcome::Exited)
    };
    let outcome = tokio::select! {
        biased;
        _ = cancelled.wait_for(|cancel| *cancel) => Ok(LoginOutcome::Cancelled),
        _ = tokio::time::sleep_until(deadline) => Ok(LoginOutcome::TimedOut),
        result = operation => result,
    };
    // Always reap the process before releasing the account/provider guards,
    // including malformed replies, browser launch failures and cancellation.
    if let Some(tree) = &tree {
        tree.kill();
    }
    child
        .kill()
        .await
        .map_err(|_| "Could not stop the Codex sign-in service")?;
    outcome
}

struct LoginClient<W, R> {
    input: W,
    output: R,
}

impl<W: AsyncWrite + Unpin, R: AsyncBufRead + Unpin> LoginClient<W, R> {
    async fn send(&mut self, message: Value) -> Result<(), String> {
        self.input
            .write_all(format!("{message}\n").as_bytes())
            .await
            .map_err(|_| "Codex sign-in service disconnected")?;
        self.input
            .flush()
            .await
            .map_err(|_| "Codex sign-in service disconnected".into())
    }

    async fn read(&mut self) -> Result<Value, String> {
        loop {
            let mut line = String::new();
            let size = (&mut self.output)
                .take(MAX_MESSAGE_BYTES + 1)
                .read_line(&mut line)
                .await
                .map_err(|_| "Could not read Codex sign-in response")?;
            if size == 0 {
                return Err("Codex sign-in service exited before completing sign-in".into());
            }
            if size as u64 > MAX_MESSAGE_BYTES {
                return Err("Codex sign-in response exceeded the size limit".into());
            }
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("method").is_some() && message.get("id").is_some() {
                self.send(json!({"id":message["id"],"error":{"code":-32601,"message":"Sign-in does not handle agent requests"}})).await?;
                continue;
            }
            return Ok(message);
        }
    }

    async fn response(&mut self, id: u64) -> Result<Value, String> {
        loop {
            let message = self.read().await?;
            if message["id"].as_u64() != Some(id) {
                continue;
            }
            // Never forward provider errors: they may include OAuth URLs/tokens.
            if message.get("error").is_some() {
                return Err("Codex could not start sign-in. Close any other Codex sign-in window and try again.".into());
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| "Codex returned an invalid sign-in reply".into());
        }
    }

    async fn start(&mut self) -> Result<(String, String), String> {
        self.send(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"distill_accounts","title":"Distill","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}})).await?;
        self.response(1).await?;
        self.send(json!({"method":"initialized","params":{}}))
            .await?;
        // The legacy CLI redirects to localhost /success and exits after its
        // first request. The hosted page remains available after login ends and
        // does not put the ID token in the success URL.
        self.send(json!({"id":2,"method":"account/login/start","params":{"type":"chatgpt","codexStreamlinedLogin":true,"useHostedLoginSuccessPage":true}})).await?;
        let started = self.response(2).await?;
        let login_id = started["loginId"].as_str().filter(|id| !id.is_empty());
        let auth_url = started["authUrl"].as_str();
        match (started["type"].as_str(), login_id, auth_url) {
            (Some("chatgpt"), Some(id), Some(url)) if valid_auth_url(url) => {
                Ok((id.into(), url.into()))
            }
            _ => Err("Codex returned an invalid sign-in page".into()),
        }
    }

    async fn login(
        &mut self,
        open_browser: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<bool, String> {
        let (login_id, auth_url) = tokio::time::timeout(START_TIMEOUT, self.start())
            .await
            .map_err(|_| "Codex sign-in service took too long to start. Try again.")??;
        open_browser(&auth_url)?;
        loop {
            let message = self.read().await?;
            if message["method"] == "account/login/completed"
                && message["params"]["loginId"] == login_id
            {
                return message["params"]["success"]
                    .as_bool()
                    .ok_or_else(|| "Codex returned an invalid sign-in result".into());
            }
        }
    }
}

fn valid_auth_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("auth.openai.com")
            && url.path() == "/oauth/authorize"
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn protocol_fixture(success: bool) {
        let (client_io, server_io) = tokio::io::duplex(8192);
        let (client_read, client_write) = tokio::io::split(client_io);
        let mut client = LoginClient {
            input: client_write,
            output: BufReader::new(client_read),
        };
        let fixture = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server_io);
            let mut lines = BufReader::new(read).lines();
            let init: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(init["method"], "initialize");
            write
                .write_all(b"{\"id\":1,\"result\":{}}\n")
                .await
                .unwrap();
            let initialized: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(initialized["method"], "initialized");
            let login: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(login["method"], "account/login/start");
            assert_eq!(login["params"]["useHostedLoginSuccessPage"], true);
            assert_eq!(login["params"]["codexStreamlinedLogin"], true);
            for message in [
                json!({"id":2,"result":{"type":"chatgpt","loginId":"selected","authUrl":"https://auth.openai.com/oauth/authorize?state=fixture"}}),
                json!({"method":"account/login/completed","params":{"loginId":"older-attempt","success":!success}}),
                json!({"method":"account/updated","params":{"authMode":"chatgpt"}}),
                json!({"method":"account/login/completed","params":{"loginId":"selected","success":success,"error":"private provider detail"}}),
            ] {
                write
                    .write_all(format!("{message}\n").as_bytes())
                    .await
                    .unwrap();
            }
        });
        let mut opened = false;
        let result = client
            .login(|url| {
                assert_eq!(url, "https://auth.openai.com/oauth/authorize?state=fixture");
                opened = true;
                Ok(())
            })
            .await
            .unwrap();
        assert!(opened);
        assert_eq!(result, success);
        fixture.await.unwrap();
    }

    #[tokio::test]
    async fn hosted_login_waits_for_its_own_completion() {
        protocol_fixture(true).await;
    }

    #[tokio::test]
    async fn failed_completion_does_not_leak_provider_details() {
        protocol_fixture(false).await;
    }

    #[test]
    fn browser_urls_must_be_openai_authorization_pages() {
        assert!(valid_auth_url(
            "https://auth.openai.com/oauth/authorize?state=fixture"
        ));
        for url in [
            "http://auth.openai.com/oauth/authorize",
            "https://auth.openai.com.evil.test/oauth/authorize",
            "http://localhost:1455/success?id_token=fixture",
            "file:///private",
            "https://auth.openai.com/success",
            "https://user@auth.openai.com/oauth/authorize",
            "https://auth.openai.com:8443/oauth/authorize",
        ] {
            assert!(!valid_auth_url(url), "{url}");
        }
    }

    #[tokio::test]
    async fn protocol_errors_and_oversized_replies_never_echo_secrets() {
        for bytes in [
            b"{\"id\":1,\"error\":{\"message\":\"private-token\"}}\n".to_vec(),
            vec![b'x'; MAX_MESSAGE_BYTES as usize + 1],
        ] {
            let mut client = LoginClient {
                input: tokio::io::sink(),
                output: BufReader::new(bytes.as_slice()),
            };
            let error = client.response(1).await.unwrap_err();
            assert!(!error.contains("private-token"));
        }
    }
}
