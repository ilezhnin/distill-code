//! The stdio server a chat's agent starts for computer use.
//!
//! Flock's own executable runs in this mode when a bridge starts the
//! `computer_use` server Flock gave the chat. It starts the pinned driver's
//! `mcp` server with Flock's environment and relays newline-delimited JSON-RPC
//! both ways.
//!
//! From the agent it passes on only what it has read and knows how to police:
//! the requests that open a session, list its tools and keep it alive, a
//! `tools/call` that [`policy`] lets through, the notifications a session
//! consists of, and the answers to the driver's own requests. Anything else —
//! a line that is not JSON, a request without a proper id, a method it does
//! not know — it refuses itself, and the driver never sees it.
//!
//! What the driver sends back — tool results, notifications, its own requests
//! — goes through byte for byte, except what [`policy`] rewrites: the
//! server's instructions, capabilities and tool listing.
//!
//! The relay ends with either side: a closed stdin closes the driver's, and
//! the driver exiting ends this process with its exit code.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::{install, policy};

/// The requests that go to the driver unexamined: what opens a session
/// (`initialize`, or `server/discover` in its place), lists the tools and
/// answers a liveness check. None of them makes the driver touch the desktop,
/// and no session works without them.
const PASSED_REQUESTS: &[&str] = &["initialize", "ping", "tools/list", "server/discover"];

/// The requests whose answers describe the server and so get rewritten.
const PRESENTED_METHODS: &[&str] = &["initialize", "tools/list", "server/discover"];

/// The notifications a client sends in the course of a session: that it is
/// ready, that it gave up on a request or how far one has got, and that its
/// roots changed. They report; none of them asks the driver for an action.
const PASSED_NOTIFICATIONS: &[&str] = &[
    "notifications/initialized",
    "notifications/cancelled",
    "notifications/progress",
    "notifications/roots/list_changed",
];

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;

/// What to do with one line from the agent.
#[derive(Debug, PartialEq)]
enum FromClient {
    /// Send the driver this message: the one that was read and checked.
    Forward(Value),
    /// Answer the agent with this message and send the driver nothing.
    Answer(Value),
    /// Send nothing either way.
    Drop,
}

struct Options {
    driver: PathBuf,
    home: PathBuf,
}

impl Options {
    fn parse(args: &[String]) -> Option<Self> {
        let value = |flag: &str| {
            args.iter()
                .position(|arg| arg == flag)
                .and_then(|index| args.get(index + 1))
                .map(PathBuf::from)
        };
        Some(Self {
            driver: value(super::DRIVER_FLAG)?,
            home: value(super::HOME_FLAG)?,
        })
    }
}

/// Run the relay until either side closes, and return the exit code.
pub fn run(args: &[String]) -> i32 {
    let Some(options) = Options::parse(args) else {
        eprintln!(
            "flock computer use: expected {} <path> and {} <path>",
            super::DRIVER_FLAG,
            super::HOME_FLAG
        );
        return 64;
    };
    let _ = std::fs::create_dir_all(&options.home);
    let mut command = Command::new(&options.driver);
    command
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    for (name, _) in std::env::vars_os() {
        if install::is_driver_setting(&name) {
            command.env_remove(name);
        }
    }
    command.envs(install::driver_env(&options.home));
    crate::services::process::apply_no_window(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "flock computer use: could not start {}: {error}",
                options.driver.display()
            );
            return 69;
        }
    };
    let (Some(driver_in), Some(driver_out)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return 70;
    };
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let pending = Arc::new(Mutex::new(HashSet::new()));
    {
        let out = Arc::clone(&out);
        let pending = Arc::clone(&pending);
        std::thread::spawn(move || {
            relay_from_client(std::io::stdin().lock(), driver_in, &out, &pending);
        });
    }
    relay_from_driver(BufReader::new(driver_out), &out, &pending);
    child
        .wait()
        .ok()
        .and_then(|status| status.code())
        .unwrap_or(1)
}

fn relay_from_client(
    mut input: impl BufRead,
    mut driver: impl Write,
    out: &Mutex<impl Write>,
    pending: &Mutex<HashSet<String>>,
) {
    let mut line = Vec::new();
    loop {
        line.clear();
        match input.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let action = {
            let mut pending = pending.lock().unwrap_or_else(|poison| poison.into_inner());
            from_client(&line, &mut pending)
        };
        match action {
            FromClient::Forward(message) => {
                // The driver is sent the relay's own writing of the message
                // it checked, never the agent's bytes: a line two parsers
                // read differently (a key given twice) would otherwise be
                // checked as one call and carried out as another.
                let Ok(mut checked) = serde_json::to_vec(&message) else {
                    return;
                };
                checked.push(b'\n');
                if driver
                    .write_all(&checked)
                    .and_then(|()| driver.flush())
                    .is_err()
                {
                    return;
                }
            }
            FromClient::Answer(message) => {
                if write_message(out, &message).is_err() {
                    return;
                }
            }
            FromClient::Drop => {}
        }
    }
}

fn relay_from_driver(
    mut input: impl BufRead,
    out: &Mutex<impl Write>,
    pending: &Mutex<HashSet<String>>,
) {
    let mut line = Vec::new();
    loop {
        line.clear();
        match input.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let rewritten = {
            let mut pending = pending.lock().unwrap_or_else(|poison| poison.into_inner());
            from_driver(&line, &mut pending)
        };
        let written = match rewritten {
            Some(message) => write_message(out, &message),
            None => write_raw(out, &line),
        };
        if written.is_err() {
            return;
        }
    }
}

fn write_message(out: &Mutex<impl Write>, message: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(message).map_err(std::io::Error::other)?;
    line.push(b'\n');
    write_raw(out, &line)
}

fn write_raw(out: &Mutex<impl Write>, line: &[u8]) -> std::io::Result<()> {
    let mut out = out.lock().unwrap_or_else(|poison| poison.into_inner());
    out.write_all(line)?;
    out.flush()
}

/// The JSON-RPC error that refuses a message. `id` is null when the message
/// had none an answer could go under.
fn refused(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

/// Whether `id` is one a request may carry: text or a whole number. An answer
/// under anything else could not be matched to its request.
fn is_request_id(id: &Value) -> bool {
    match id {
        Value::String(_) => true,
        Value::Number(number) => number.is_i64() || number.is_u64(),
        _ => false,
    }
}

/// Decide about one line from the agent, noting the ids of requests whose
/// answers [`from_driver`] has to rewrite.
///
/// The driver gets a message only when the relay has read all of it and
/// knows what it asks for. Whatever falls outside that is refused here with a
/// JSON-RPC error — under the request's id when it has a proper one, under a
/// null id otherwise — because a message that goes on unread is one the
/// checks in [`policy`] never saw.
fn from_client(line: &[u8], pending: &mut HashSet<String>) -> FromClient {
    if line.iter().all(u8::is_ascii_whitespace) {
        return FromClient::Drop;
    }
    let Ok(message) = serde_json::from_slice::<Value>(line) else {
        return FromClient::Answer(refused(
            Value::Null,
            PARSE_ERROR,
            "Flock's computer use server could not read this line as JSON",
        ));
    };
    if let Value::Array(batch) = &message {
        // Batches left MCP in 2025-06-18 and no bridge sends them; answering
        // each request keeps a tool call from riding past the checks inside one.
        let refusals: Vec<Value> = batch
            .iter()
            .filter_map(|request| request.get("id"))
            .map(|id| {
                refused(
                    id.clone(),
                    INVALID_REQUEST,
                    "Flock's computer use server does not take batched requests",
                )
            })
            .collect();
        return if refusals.is_empty() {
            FromClient::Drop
        } else {
            FromClient::Answer(Value::Array(refusals))
        };
    }
    let id = message.get("id").cloned();
    let method = message.get("method").cloned();
    // A refusal goes under the id of the request it refuses when that id is a
    // proper one, so the client is not left waiting. The id of an answer is
    // the driver's, and no refusal goes under it: the client may be waiting
    // on a request of its own with the same number.
    let request_id = match (&method, &id) {
        (Some(_), Some(id)) if is_request_id(id) => id.clone(),
        _ => Value::Null,
    };
    let malformed = |id: Value| {
        FromClient::Answer(refused(
            id,
            INVALID_REQUEST,
            "Flock's computer use server takes JSON-RPC 2.0 messages whose id is text or a whole number",
        ))
    };
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return malformed(request_id);
    }
    let method = match method {
        Some(Value::String(method)) => method,
        Some(_) => return malformed(request_id),
        None => {
            // An answer to a request the driver made of the client.
            let answers = message.get("result").is_some() != message.get("error").is_some();
            return if answers && id.as_ref().is_some_and(is_request_id) {
                FromClient::Forward(message)
            } else {
                malformed(Value::Null)
            };
        }
    };
    let Some(id) = id else {
        return if PASSED_NOTIFICATIONS.contains(&method.as_str()) {
            FromClient::Forward(message)
        } else if method.starts_with("notifications/") {
            // JSON-RPC allows no answer to a notification, so one the relay
            // does not know is neither passed on nor answered.
            FromClient::Drop
        } else {
            // A request sent without an id — `tools/call` above all — would
            // otherwise reach the driver with no check and no answer.
            FromClient::Answer(refused(
                Value::Null,
                INVALID_REQUEST,
                "Flock's computer use server takes this method only as a request with an id",
            ))
        };
    };
    if !is_request_id(&id) {
        return malformed(Value::Null);
    }
    if method == "tools/call" {
        let params = message.get("params").unwrap_or(&Value::Null);
        if let Some(reason) = policy::refusal(params) {
            return FromClient::Answer(policy::refused_call(&id, &reason));
        }
    } else if PASSED_REQUESTS.contains(&method.as_str()) {
        if PRESENTED_METHODS.contains(&method.as_str()) {
            pending.insert(id.to_string());
        }
    } else {
        // Whatever else the driver may serve — resources, prompts, a method
        // a later release adds — has no check here, so it is not passed on.
        return FromClient::Answer(refused(
            id,
            METHOD_NOT_FOUND,
            "Flock's computer use server does not offer this method",
        ));
    }
    FromClient::Forward(message)
}

/// The rewritten message for a line from the driver, or `None` to pass the
/// line on unchanged. Only answers to noted requests are parsed, so tool
/// results with screenshots go through without a round trip through JSON.
fn from_driver(line: &[u8], pending: &mut HashSet<String>) -> Option<Value> {
    if pending.is_empty() {
        return None;
    }
    let mut message = serde_json::from_slice::<Value>(line).ok()?;
    if message.get("method").is_some() {
        return None;
    }
    let id = message.get("id")?.to_string();
    if !pending.remove(&id) {
        return None;
    }
    if let Some(result) = message.get_mut("result") {
        policy::present_result(result);
    }
    Some(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(value: Value) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        bytes
    }

    /// What the relay does with `message`, written the way a client writes it.
    fn decided(message: Value) -> FromClient {
        from_client(&line(message), &mut HashSet::new())
    }

    /// The code and id of the JSON-RPC error that refused `message`.
    fn refusal_of(message: Value) -> (i64, Value) {
        let FromClient::Answer(answer) = decided(message.clone()) else {
            panic!("{message} was not refused");
        };
        assert_eq!(answer["jsonrpc"], "2.0");
        assert!(answer.get("result").is_none(), "{answer}");
        (
            answer["error"]["code"].as_i64().expect("an error code"),
            answer["id"].clone(),
        )
    }

    #[test]
    fn a_refused_call_is_answered_here_and_an_allowed_one_forwarded() {
        let mut pending = HashSet::new();
        let refused = from_client(
            &line(
                json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kill_app","arguments":{}}}),
            ),
            &mut pending,
        );
        let FromClient::Answer(answer) = refused else {
            panic!("refused call was forwarded");
        };
        assert_eq!(answer["id"], 3);
        assert_eq!(answer["result"]["isError"], true);
        let call = json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_windows","arguments":{}}});
        let allowed = from_client(&line(call.clone()), &mut pending);
        assert_eq!(allowed, FromClient::Forward(call));
        assert!(pending.is_empty());
    }

    #[test]
    fn the_listing_answer_is_rewritten_and_other_answers_pass_untouched() {
        let mut pending = HashSet::new();
        let listing_request = json!({"jsonrpc":"2.0","id":"a","method":"tools/list"});
        assert_eq!(
            from_client(&line(listing_request.clone()), &mut pending),
            FromClient::Forward(listing_request)
        );
        // An answer with the same number but another id type is not it.
        assert_eq!(
            from_driver(
                &line(json!({"jsonrpc":"2.0","id":1,"result":{}})),
                &mut pending
            ),
            None
        );
        let listing = json!({"jsonrpc":"2.0","id":"a","result":{"tools":[
            {"name":"click","inputSchema":{"type":"object"},"outputSchema":{}},
            {"name":"run_script","inputSchema":{"type":"object"}}
        ]}});
        let rewritten = from_driver(&line(listing), &mut pending).expect("rewritten");
        let tools = rewritten["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert!(tools[0].get("outputSchema").is_none());
        assert!(pending.is_empty());
        // The next answer with that id is not a listing any more.
        assert_eq!(
            from_driver(
                &line(json!({"jsonrpc":"2.0","id":"a","result":{}})),
                &mut pending
            ),
            None
        );
    }

    #[test]
    fn a_driver_request_with_a_noted_id_is_not_taken_for_the_answer() {
        let mut pending = HashSet::from([json!(1).to_string()]);
        assert_eq!(
            from_driver(
                &line(json!({"jsonrpc":"2.0","id":1,"method":"roots/list"})),
                &mut pending
            ),
            None
        );
        assert_eq!(pending.len(), 1);
    }

    /// What a session cannot do without goes through: the requests that open
    /// it, list its tools and check it is alive, the notifications a client
    /// sends along the way, and the client's answers to the driver.
    #[test]
    fn what_a_session_consists_of_is_forwarded() {
        for message in [
            json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"example"}}}),
            json!({"jsonrpc":"2.0","id":"discover-1","method":"server/discover"}),
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"cursor":"next"}}),
            json!({"jsonrpc":"2.0","id":2,"method":"ping"}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1,"reason":"gave up"}}),
            json!({"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"t","progress":1}}),
            json!({"jsonrpc":"2.0","method":"notifications/roots/list_changed"}),
            json!({"jsonrpc":"2.0","id":7,"result":{"roots":[]}}),
            json!({"jsonrpc":"2.0","id":"driver-8","error":{"code":-32601,"message":"no sampling"}}),
        ] {
            assert_eq!(
                decided(message.clone()),
                FromClient::Forward(message.clone()),
                "{message}"
            );
        }
    }

    #[test]
    fn only_the_requests_that_describe_the_server_are_noted_for_rewriting() {
        let mut pending = HashSet::new();
        for (id, method) in [
            (1, "initialize"),
            (2, "tools/list"),
            (3, "server/discover"),
            (4, "ping"),
        ] {
            from_client(
                &line(json!({"jsonrpc":"2.0","id":id,"method":method})),
                &mut pending,
            );
        }
        assert_eq!(
            pending,
            HashSet::from(["1".to_string(), "2".to_string(), "3".to_string()])
        );
    }

    /// The relay used to pass these on unread.
    #[test]
    fn a_line_the_relay_cannot_read_is_refused_instead_of_forwarded() {
        let mut pending = HashSet::new();
        for unreadable in [
            &b"not json\n"[..],
            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\"\n",
            b"\xff\xfe{}\n",
        ] {
            let FromClient::Answer(answer) = from_client(unreadable, &mut pending) else {
                panic!("an unreadable line was not refused");
            };
            assert_eq!(answer["error"]["code"], PARSE_ERROR);
            assert_eq!(answer["id"], Value::Null);
        }
        // A blank line says nothing: nothing goes either way.
        assert_eq!(from_client(b"\r\n", &mut pending), FromClient::Drop);
        for not_a_message in [
            json!("tools/call"),
            json!(7),
            json!(null),
            json!({"jsonrpc":"2.0","id":1}),
            json!({"jsonrpc":"2.0","id":1,"result":{},"error":{"code":1,"message":"both"}}),
            json!({"jsonrpc":"2.0","result":{}}),
            json!({"id":1,"result":{}}),
        ] {
            assert_eq!(
                refusal_of(not_a_message.clone()),
                (INVALID_REQUEST, Value::Null),
                "{not_a_message}"
            );
        }
        // A request that is not well formed is refused under its own id, so
        // the client is not left waiting for an answer.
        for not_a_request in [
            json!({"id":1,"method":"tools/list"}),
            json!({"jsonrpc":"1.0","id":1,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":1,"method":["tools/call"]}),
        ] {
            assert_eq!(
                refusal_of(not_a_request.clone()),
                (INVALID_REQUEST, json!(1)),
                "{not_a_request}"
            );
        }
    }

    /// A `tools/call` sent as a notification used to reach the driver with no
    /// check at all: only requests were looked at, and it is not one.
    #[test]
    fn a_tool_call_without_an_id_is_refused() {
        for name in ["kill_app", "click"] {
            assert_eq!(
                refusal_of(json!({
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "params": { "name": name, "arguments": { "scope": "desktop" } }
                })),
                (INVALID_REQUEST, Value::Null)
            );
        }
        assert_eq!(
            refusal_of(json!({"jsonrpc":"2.0","method":"initialize"})),
            (INVALID_REQUEST, Value::Null)
        );
    }

    #[test]
    fn an_id_that_is_neither_text_nor_a_whole_number_is_refused() {
        for id in [
            json!(null),
            json!(true),
            json!(1.5),
            json!([1]),
            json!({"n":1}),
        ] {
            for method in ["tools/list", "tools/call", "ping"] {
                assert_eq!(
                    refusal_of(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "method": method,
                        "params": { "name": "list_windows" }
                    })),
                    (INVALID_REQUEST, Value::Null),
                    "{id} {method}"
                );
            }
        }
    }

    /// Only `tools/call` was checked, so every other method the driver serves
    /// went straight through.
    #[test]
    fn a_method_the_relay_does_not_know_is_refused_under_its_id() {
        for method in [
            "resources/list",
            "resources/read",
            "resources/subscribe",
            "prompts/list",
            "prompts/get",
            "completion/complete",
            "logging/setLevel",
            "tools/call/raw",
            "Tools/Call",
            "notifications/initialized",
            "",
        ] {
            assert_eq!(
                refusal_of(
                    json!({"jsonrpc":"2.0","id":"r-9","method":method,"params":{"uri":"file:///c:/"}})
                ),
                (METHOD_NOT_FOUND, json!("r-9")),
                "{method}"
            );
        }
    }

    #[test]
    fn a_notification_the_relay_does_not_know_goes_nowhere() {
        assert_eq!(
            decided(json!({"jsonrpc":"2.0","method":"notifications/driver/reset","params":{}})),
            FromClient::Drop
        );
    }

    /// The driver is written the message that was checked, so a line that
    /// names a key twice cannot be read one way here and another way there.
    #[test]
    fn the_driver_is_sent_the_message_that_was_checked() {
        let twice = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","method":"ping","params":{"name":"kill_app"}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"click","arguments":{"scope":"desktop","scope":"window"}}}
"#;
        let mut to_driver = Vec::new();
        let out = Mutex::new(Vec::new());
        let pending = Mutex::new(HashSet::new());
        relay_from_client(&twice[..], &mut to_driver, &out, &pending);
        let forwarded = String::from_utf8(to_driver).unwrap();
        let mut lines = forwarded.lines();
        let first = lines.next().expect("the first line");
        assert_eq!(first.matches("\"method\"").count(), 1, "{first}");
        assert!(!first.contains("tools/call"), "{first}");
        let second = lines.next().expect("the second line");
        assert_eq!(second.matches("\"scope\"").count(), 1, "{second}");
        assert!(!second.contains("desktop"), "{second}");
        assert_eq!(lines.next(), None);
        assert!(out.into_inner().unwrap().is_empty());
    }

    #[test]
    fn a_batch_is_refused_whole() {
        let mut pending = HashSet::new();
        let batch = json!([
            {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_script"}},
            {"jsonrpc":"2.0","method":"notifications/initialized"}
        ]);
        let FromClient::Answer(Value::Array(answers)) = from_client(&line(batch), &mut pending)
        else {
            panic!("batch was forwarded");
        };
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0]["id"], 1);
        assert_eq!(answers[0]["error"]["code"], -32600);
        let notifications = json!([{"jsonrpc":"2.0","method":"notifications/initialized"}]);
        assert_eq!(
            from_client(&line(notifications), &mut pending),
            FromClient::Drop
        );
    }

    #[test]
    fn the_relay_answers_refusals_itself_and_forwards_the_rest() {
        let client = [
            line(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"clipboard_read"}})),
            b"clipboard_read, please\n".to_vec(),
            line(json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":"clipboard_read"}})),
            line(json!({"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"clipboard_read"}})),
            line(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})),
        ]
        .concat();
        let mut to_driver = Vec::new();
        let out = Mutex::new(Vec::new());
        let pending = Mutex::new(HashSet::new());
        relay_from_client(&client[..], &mut to_driver, &out, &pending);
        let forwarded = String::from_utf8(to_driver).unwrap();
        assert!(forwarded.contains("tools/list"));
        assert!(!forwarded.contains("clipboard_read"));
        assert_eq!(forwarded.lines().count(), 1);
        let answered = String::from_utf8(out.into_inner().unwrap()).unwrap();
        assert!(answered.contains("\"isError\":true"));
        assert_eq!(answered.lines().count(), 4);

        let driver = [
            line(json!({"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"kill_app"}]}})),
            b"{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{\"content\":[]}}\n".to_vec(),
        ]
        .concat();
        let out = Mutex::new(Vec::new());
        relay_from_driver(&driver[..], &out, &pending);
        let to_client = String::from_utf8(out.into_inner().unwrap()).unwrap();
        let mut lines = to_client.lines();
        let listing: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(listing["result"]["tools"], json!([]));
        assert_eq!(
            lines.next().unwrap(),
            "{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{\"content\":[]}}"
        );
    }

    #[test]
    fn options_need_both_paths() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        assert!(Options::parse(&args(&[super::super::PROXY_FLAG])).is_none());
        let options = Options::parse(&args(&[
            super::super::PROXY_FLAG,
            super::super::DRIVER_FLAG,
            "C:\\d\\cua-driver.exe",
            super::super::HOME_FLAG,
            "C:\\h",
        ]))
        .expect("parsed");
        assert_eq!(options.driver, PathBuf::from("C:\\d\\cua-driver.exe"));
        assert_eq!(options.home, PathBuf::from("C:\\h"));
    }
}
