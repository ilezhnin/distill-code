//! HTTP client for the broker's `/v1/ping` + `/v1/call` routes, and the
//! mapping from HTTP outcomes to the CLI's exit-code contract:
//! 0 ok, 1 command error, 2 transport, 3 environment/reachability/version.

use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::broker_proof::{self, PingResponse, NONCE_HEADER};
use crate::discovery::{self, PROTOCOL_VERSION};

pub const EXIT_COMMAND: u8 = 1;
pub const EXIT_TRANSPORT: u8 = 2;
pub const EXIT_ENV: u8 = 3;

const PING_TIMEOUT: Duration = Duration::from_secs(2);
/// Above the broker's 900s command-timeout ceiling, so the broker's
/// structured 504 always arrives before this client-side timeout fires.
const CALL_TIMEOUT: Duration = Duration::from_secs(910);

const APP_UPDATED: &str = "app updated — restart Flock";
const CONTROL_REMEDIATION: &str = "confirm Flock is running, app control is enabled, and this command is running inside a Flock-started agent session.";

#[derive(Debug)]
pub struct Failure {
    pub exit: u8,
    pub message: String,
}

impl Failure {
    pub fn env(message: impl Into<String>) -> Self {
        Self {
            exit: EXIT_ENV,
            message: message.into(),
        }
    }

    /// Exit 1: the app refused the command. stderr carries the registry's
    /// `code: message` verbatim so the agent can act on the code.
    pub fn command(code: &str, message: &str) -> Self {
        Self {
            exit: EXIT_COMMAND,
            message: format!("{code}: {message}"),
        }
    }

    pub fn transport(detail: impl Into<String>) -> Self {
        Self {
            exit: EXIT_TRANSPORT,
            message: format!("{}\n{CONTROL_REMEDIATION}", detail.into()),
        }
    }
}

pub struct Endpoint {
    pub port: u16,
    /// The discovery file's token, sent with every call.
    pub token: String,
}

/// The header the broker reads the token from.
const TOKEN_HEADER: &str = "x-flock-token";

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        // The default config picks up HTTP(S)_PROXY / ALL_PROXY from the
        // environment. The broker only ever listens on loopback, so a
        // corporate proxy inherited by the agent session must never see these
        // requests (they fail there, and `/v1/call` bodies carry prompt text).
        .proxy(None)
        .timeout_global(Some(timeout))
        // Non-2xx responses carry the broker's structured error body; read it
        // instead of treating the status as a transport error.
        .http_status_as_error(false)
        .build()
        .new_agent()
}

/// Probe the listener before sending any payload (command args can contain
/// prompt text, which must not be sprayed at an unknown local service). The
/// probe carries the nonce and nothing else: the token goes only to a
/// listener whose answer proves it already holds it.
/// Returns the failure detail only; callers decide the exit class.
pub fn ping(port: u16, nonce: &str) -> Result<PingResponse, String> {
    let url = format!("http://127.0.0.1:{port}/v1/ping");
    let mut response = agent(PING_TIMEOUT)
        .get(&url)
        .header(NONCE_HEADER, nonce)
        .call()
        .map_err(|err| format!("nothing answered on 127.0.0.1:{port} ({err})"))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!(
            "the listener on 127.0.0.1:{port} does not look like the Flock app \
             control endpoint (ping returned status {status})"
        ));
    }
    response
        .body_mut()
        .read_json::<PingResponse>()
        .map_err(|err| {
            format!(
                "the listener on 127.0.0.1:{port} does not look like the Flock app \
                 control endpoint (unrecognized ping response: {err})"
            )
        })
}

/// Read the discovery file and verify the broker behind it echoes the file's
/// generation and this binary's protocol version, and proves it holds the
/// file's token. A generation mismatch means the file was read across a
/// broker restart: re-read once and retry once.
pub fn handshake(lock_path: &Path) -> Result<Endpoint, Failure> {
    let mut file = discovery::load_with_retry(lock_path)?;
    for attempt in 0..2 {
        if file.protocol_version != PROTOCOL_VERSION {
            return Err(Failure::env(APP_UPDATED));
        }
        let nonce = broker_proof::new_nonce().map_err(Failure::env)?;
        let ping = ping(file.port, &nonce).map_err(|detail| {
            Failure::env(format!(
                "the Flock desktop app is not reachable: {detail}. The app may have \
                 quit; {CONTROL_REMEDIATION}"
            ))
        })?;
        // An older app answers without a proof: it is refused for its
        // version, never let through unproven.
        if ping.protocol_version != PROTOCOL_VERSION {
            return Err(Failure::env(APP_UPDATED));
        }
        if ping.generation == file.generation {
            // Generation and version are public; only the token is not. The
            // port of an app that quit may belong to anyone by now.
            if !broker_proof::proves_token(&file.token, &nonce, ping.proof.as_deref()) {
                return Err(Failure::env(format!(
                    "the app listening on 127.0.0.1:{} is not the Flock app the discovery \
                     file {} names: it could not prove it holds that file's control token, \
                     so flockctl sent it nothing but a one-time nonce. The app that wrote the \
                     file may have quit \
                     and another program taken its port; {CONTROL_REMEDIATION}",
                    file.port,
                    lock_path.display()
                )));
            }
            return Ok(Endpoint {
                port: file.port,
                token: file.token,
            });
        }
        if attempt == 0 {
            file = discovery::load(lock_path).map_err(|err| {
                Failure::env(format!(
                    "the Flock desktop app restarted its control endpoint and the new \
                     one could not be read ({err}); {CONTROL_REMEDIATION}"
                ))
            })?;
        }
    }
    Err(Failure::env(
        "the Flock desktop app's control endpoint restarted while flockctl was \
         connecting; retry the command, and confirm Flock is running, app control is \
         enabled, and this command is running inside a Flock-started agent session if \
         it keeps failing.",
    ))
}

/// POST one command. `args` already contains the `action` discriminator.
/// `actor` and `agent_shell` ride the envelope, not `args`: they are
/// transport identity, not command flags, so they stay out of the generated
/// contract and out of argv.
pub fn call(
    endpoint: &Endpoint,
    command: &str,
    args: Map<String, Value>,
    timeout_ms: Option<u64>,
    actor: Option<&str>,
    agent_shell: bool,
) -> Result<Value, Failure> {
    let url = format!("http://127.0.0.1:{}/v1/call", endpoint.port);
    let mut payload = Map::new();
    payload.insert("command".into(), Value::String(command.into()));
    payload.insert("args".into(), Value::Object(args));
    if let Some(ms) = timeout_ms {
        payload.insert("timeout_ms".into(), Value::from(ms));
    }
    if let Some(actor) = actor {
        payload.insert("actor".into(), Value::String(actor.into()));
    }
    if agent_shell {
        payload.insert("agent".into(), Value::Bool(true));
    }
    let mut response = agent(CALL_TIMEOUT)
        .post(&url)
        .header(TOKEN_HEADER, &endpoint.token)
        .send_json(Value::Object(payload))
        .map_err(|err| transport_error_failure(endpoint.port, &err))?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|err| {
        Failure::transport(format!(
            "the app control endpoint's response could not be read ({err})"
        ))
    })?;
    classify_response(status, &body)
}

/// The app quitting between ping and call surfaces as a refused connection —
/// that is the environment class (exit 3), not a transport fault (exit 2).
fn transport_error_failure(port: u16, err: &ureq::Error) -> Failure {
    if is_connection_refused(err) {
        Failure::env(format!(
            "the Flock desktop app is not reachable on 127.0.0.1:{port} (connection \
             refused); the app may have quit. {CONTROL_REMEDIATION}"
        ))
    } else {
        Failure::transport(format!(
            "the call to the app control endpoint failed ({err})"
        ))
    }
}

fn is_connection_refused(err: &ureq::Error) -> bool {
    match err {
        ureq::Error::Io(io) => io.kind() == std::io::ErrorKind::ConnectionRefused,
        _ => false,
    }
}

/// Exit-code classification for `/v1/call` responses:
/// - 200 `{"ok":true}` → success, result on stdout
/// - 200 `{"ok":false}`, 400, 429 → exit 1, `code: message` verbatim
/// - anything else (5xx, unparseable, unexpected statuses) → exit 2 with
///   direct app-control remediation
pub fn classify_response(status: u16, body: &str) -> Result<Value, Failure> {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    match status {
        200 => {
            if let Some(value) = &parsed {
                match value.get("ok").and_then(Value::as_bool) {
                    Some(true) => {
                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                    Some(false) => {
                        if let Some((code, message)) = error_parts(value) {
                            return Err(Failure::command(&code, &message));
                        }
                    }
                    None => {}
                }
            }
            Err(Failure::transport(
                "the app control endpoint returned an unrecognized response (status 200)",
            ))
        }
        400 | 429 => match parsed.as_ref().and_then(error_parts) {
            Some((code, message)) => Err(Failure::command(&code, &message)),
            None => Err(Failure::transport(format!(
                "the app control endpoint returned an unreadable error (status {status})"
            ))),
        },
        _ => {
            let detail = parsed
                .as_ref()
                .and_then(error_parts)
                .map(|(code, message)| format!("{code}: {message}"))
                .unwrap_or_else(|| {
                    format!(
                        "the app control endpoint returned an unexpected response \
                         (status {status})"
                    )
                });
            Err(Failure::transport(detail))
        }
    }
}

fn error_parts(value: &Value) -> Option<(String, String)> {
    let error = value.get("error")?;
    Some((
        error.get("code")?.as_str()?.to_string(),
        error.get("message")?.as_str()?.to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    const HEAD_END: &str = "\r\n\r\n";
    const TOKEN: &str = "invented-control-token";
    const GENERATION: u64 = 5;
    /// Text only a call carries, so a test can tell whether one was sent.
    const PROMPT: &str = "invented prompt text";

    /// One request as it arrived: the headers, then the body their
    /// Content-Length names.
    fn read_request(stream: &mut TcpStream) -> String {
        // A request that never completes must fail the test, not hang it.
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        let mut request = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let Ok(read) = stream.read(&mut chunk) else {
                break;
            };
            request.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&request).to_string();
            let complete = text.find(HEAD_END).is_some_and(|head_end| {
                let length = text[..head_end]
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                request.len() >= head_end + HEAD_END.len() + length
            });
            if complete || read == 0 {
                break;
            }
        }
        String::from_utf8_lossy(&request).to_string()
    }

    fn write_json(stream: &mut TcpStream, body: &str) {
        let head = [
            "HTTP/1.1 200 OK".to_string(),
            "Content-Type: application/json".to_string(),
            format!("Content-Length: {}", body.len()),
            "Connection: close".to_string(),
        ]
        .join("\r\n");
        write!(stream, "{head}{HEAD_END}{body}").expect("write");
    }

    fn header<'a>(request: &'a str, name: &str) -> Option<&'a str> {
        request.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }

    /// Whatever listens on the discovery file's port: it answers each ping
    /// with `answer(nonce)` and each call with success, and keeps every
    /// request it was sent.
    struct StandIn {
        port: u16,
        stop: Arc<AtomicBool>,
        server: std::thread::JoinHandle<Vec<String>>,
    }

    impl StandIn {
        fn start(answer: fn(&str) -> Value) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
            let port = listener.local_addr().expect("addr").port();
            listener.set_nonblocking(true).expect("nonblocking");
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let server = std::thread::spawn(move || {
                let mut requests = Vec::new();
                while !stopped.load(Ordering::SeqCst) {
                    let mut stream = match listener.accept() {
                        Ok((stream, _)) => stream,
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(err) => panic!("accept failed: {err}"),
                    };
                    stream.set_nonblocking(false).expect("blocking");
                    let request = read_request(&mut stream);
                    let body = if request.starts_with("GET /v1/ping ") {
                        answer(header(&request, NONCE_HEADER).unwrap_or_default())
                    } else {
                        json!({ "ok": true, "result": null })
                    };
                    write_json(&mut stream, &body.to_string());
                    requests.push(request);
                }
                requests
            });
            Self { port, stop, server }
        }

        /// Every request it was sent. The client is synchronous, so once it
        /// has returned, everything it sent has been answered and kept.
        fn requests(self) -> Vec<String> {
            self.stop.store(true, Ordering::SeqCst);
            self.server.join().expect("stand-in thread")
        }
    }

    /// A discovery file naming `port`, as this build's app writes it.
    fn discovery_file(name: &str, port: u16) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "flockctl-client-test-{}-{name}.json",
            std::process::id()
        ));
        let file = json!({
            "port": port,
            "pid": 1,
            "generation": GENERATION,
            "protocolVersion": PROTOCOL_VERSION,
            "token": TOKEN,
        });
        std::fs::write(&path, file.to_string()).expect("write the discovery file");
        path
    }

    /// What `main::run` does: the handshake, then the call it gates.
    fn connect_and_call(lock: &Path) -> Result<Value, Failure> {
        let endpoint = handshake(lock)?;
        let mut args = Map::new();
        args.insert("action".into(), Value::String("send".into()));
        args.insert("prompt".into(), Value::String(PROMPT.into()));
        call(&endpoint, "sessions", args, None, None, false)
    }

    fn assert_only_a_ping_with_a_nonce(case: &str, requests: &[String]) {
        assert_eq!(requests.len(), 1, "{case}: {requests:?}");
        let ping = &requests[0];
        assert!(ping.starts_with("GET /v1/ping "), "{case}: {ping}");
        let nonce = header(ping, NONCE_HEADER).expect("the ping carries a nonce");
        assert_eq!(nonce.len(), 64, "{case}");
        assert!(nonce.bytes().all(|byte| byte.is_ascii_hexdigit()), "{case}");
        assert!(header(ping, TOKEN_HEADER).is_none(), "{case}");
        assert!(!ping.contains(TOKEN), "{case}");
        assert!(!ping.contains(PROMPT), "{case}");
    }

    /// A listener that cannot prove it holds the discovery file's token, such
    /// as a process that took the port of an app that quit, is sent the nonce
    /// and nothing else: no token, no command, no prompt. Refused as not the
    /// app the file names.
    fn assert_unproven_listener_is_sent_only_the_nonce(case: &str, answer: fn(&str) -> Value) {
        let stand_in = StandIn::start(answer);
        let port = stand_in.port;
        let lock = discovery_file(case, port);
        let outcome = connect_and_call(&lock);
        let requests = stand_in.requests();
        std::fs::remove_file(&lock).ok();

        assert_only_a_ping_with_a_nonce(case, &requests);
        let failure = outcome.expect_err(case);
        assert_eq!(failure.exit, EXIT_ENV, "{case}");
        assert!(
            failure.message.starts_with(&format!(
                "the app listening on 127.0.0.1:{port} is not the Flock app the discovery \
                 file {} names",
                lock.display()
            )),
            "{case}: {}",
            failure.message
        );
        assert!(!failure.message.contains(TOKEN), "{case}");
    }

    #[test]
    fn a_listener_without_a_proof_is_sent_only_the_nonce() {
        assert_unproven_listener_is_sent_only_the_nonce(
            "no-proof",
            |_| json!({ "generation": GENERATION, "protocolVersion": PROTOCOL_VERSION }),
        );
    }

    #[test]
    fn a_listener_with_a_wrong_proof_is_sent_only_the_nonce() {
        assert_unproven_listener_is_sent_only_the_nonce("wrong-proof", |nonce| {
            json!({
                "generation": GENERATION,
                "protocolVersion": PROTOCOL_VERSION,
                "proof": broker_proof::expected_proof("another-token", nonce),
            })
        });
        assert_unproven_listener_is_sent_only_the_nonce("not-a-proof", |_| {
            json!({
                "generation": GENERATION,
                "protocolVersion": PROTOCOL_VERSION,
                "proof": "yes",
            })
        });
    }

    /// A proof the real broker once gave, replayed for another nonce.
    #[test]
    fn a_listener_with_a_proof_for_another_nonce_is_sent_only_the_nonce() {
        assert_unproven_listener_is_sent_only_the_nonce("proof-for-another-nonce", |_| {
            json!({
                "generation": GENERATION,
                "protocolVersion": PROTOCOL_VERSION,
                "proof": broker_proof::expected_proof(TOKEN, &"ab".repeat(32)),
            })
        });
    }

    /// The broker that wrote the file proves it, and only then is sent the
    /// token and the call.
    #[test]
    fn a_listener_that_proves_the_token_is_sent_the_call() {
        let stand_in = StandIn::start(|nonce| {
            json!({
                "generation": GENERATION,
                "protocolVersion": PROTOCOL_VERSION,
                "proof": broker_proof::expected_proof(TOKEN, nonce),
            })
        });
        let lock = discovery_file("proven", stand_in.port);
        let outcome = connect_and_call(&lock);
        let requests = stand_in.requests();
        std::fs::remove_file(&lock).ok();

        outcome.expect("a proven broker is called");
        assert_eq!(requests.len(), 2, "{requests:?}");
        assert_only_a_ping_with_a_nonce("proven", &requests[..1]);
        assert!(requests[1].starts_with("POST /v1/call "), "{}", requests[1]);
        assert_eq!(header(&requests[1], TOKEN_HEADER), Some(TOKEN));
        assert!(requests[1].contains(PROMPT));
    }

    /// An app from before the proof answers version 7 and no proof: it is
    /// refused as an updated app, never called unproven.
    #[test]
    fn an_older_app_without_a_proof_is_refused_as_updated() {
        let stand_in =
            StandIn::start(|_| json!({ "generation": GENERATION, "protocolVersion": 7 }));
        let lock = discovery_file("older-app", stand_in.port);
        let outcome = connect_and_call(&lock);
        let requests = stand_in.requests();
        std::fs::remove_file(&lock).ok();

        let failure = outcome.expect_err("an older app is refused");
        assert_eq!(failure.exit, EXIT_ENV);
        assert_eq!(failure.message, APP_UPDATED);
        assert_only_a_ping_with_a_nonce("older-app", &requests);
    }

    /// Every ping gets its own nonce, and nothing proves an empty token,
    /// which anyone could hash.
    #[test]
    fn nonces_are_fresh_and_an_empty_token_proves_nothing() {
        let first = broker_proof::new_nonce().expect("a nonce");
        let second = broker_proof::new_nonce().expect("a nonce");
        assert_ne!(first, second);
        let proof = broker_proof::expected_proof("", &first);
        assert!(!broker_proof::proves_token("", &first, Some(&proof)));
        assert!(!broker_proof::proves_token(TOKEN, &first, None));
    }

    /// The broker answers no call without the discovery file's token, so a
    /// call must carry it: this listener plays the broker and keeps what it
    /// was sent.
    #[test]
    fn a_call_carries_the_discovery_files_token() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let request = read_request(&mut stream);
            write_json(&mut stream, r#"{"ok":true,"result":{"listed":0}}"#);
            request
        });

        let endpoint = Endpoint {
            port,
            token: "invented-control-token".to_string(),
        };
        let mut args = Map::new();
        args.insert("action".into(), Value::String("list".into()));
        let result = call(&endpoint, "sessions", args, None, None, true).expect("call succeeds");
        assert_eq!(result["listed"], 0);

        let request = server.join().expect("server thread");
        let token_line = request
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("x-flock-token:"))
            .unwrap_or_else(|| panic!("no token header in: {request}"));
        assert_eq!(
            token_line.split_once(':').map(|(_, value)| value.trim()),
            Some("invented-control-token")
        );
        // The agent-shell mark rides the same envelope.
        let compact: String = request.split_whitespace().collect();
        assert!(compact.contains(r#""agent":true"#), "{request}");
    }

    #[test]
    fn ok_true_yields_the_result_verbatim() {
        let result = classify_response(200, r#"{"ok":true,"result":{"session_id":"s1"}}"#)
            .expect("ok response succeeds");
        assert_eq!(result, serde_json::json!({"session_id": "s1"}));
    }

    #[test]
    fn ok_false_is_exit_1_with_code_message_verbatim() {
        let failure = classify_response(
            200,
            r#"{"ok":false,"error":{"code":"session_not_found","message":"No session \"x\""}}"#,
        )
        .expect_err("command error fails");
        assert_eq!(failure.exit, EXIT_COMMAND);
        assert_eq!(failure.message, "session_not_found: No session \"x\"");
    }

    #[test]
    fn bad_request_is_exit_1() {
        let failure = classify_response(
            400,
            r#"{"ok":false,"error":{"code":"bad_request","message":"missing command"}}"#,
        )
        .expect_err("400 fails");
        assert_eq!(failure.exit, EXIT_COMMAND);
        assert_eq!(failure.message, "bad_request: missing command");
    }

    #[test]
    fn server_errors_are_exit_2_with_app_control_remediation() {
        for status in [500, 503, 504] {
            let failure = classify_response(
                status,
                r#"{"ok":false,"error":{"code":"app_unavailable","message":"renderer gone"}}"#,
            )
            .expect_err("5xx fails");
            assert_eq!(failure.exit, EXIT_TRANSPORT);
            assert!(failure
                .message
                .starts_with("app_unavailable: renderer gone"));
            assert!(failure.message.contains("app control is enabled"));
        }
    }

    #[test]
    fn unparseable_bodies_are_exit_2_with_app_control_remediation() {
        for status in [200, 400, 500] {
            let failure =
                classify_response(status, "<html>nope</html>").expect_err("garbage fails");
            assert_eq!(failure.exit, EXIT_TRANSPORT);
            assert!(failure.message.contains("app control is enabled"));
        }
    }

    #[test]
    fn unexpected_statuses_are_exit_2() {
        // 403 forbidden (header validation) should never hit a CLI caller;
        // if it does, something environmental is rewriting requests.
        let failure = classify_response(
            403,
            r#"{"ok":false,"error":{"code":"forbidden","message":"origin rejected"}}"#,
        )
        .expect_err("403 fails");
        assert_eq!(failure.exit, EXIT_TRANSPORT);
        assert!(failure.message.starts_with("forbidden: origin rejected"));
    }
}
