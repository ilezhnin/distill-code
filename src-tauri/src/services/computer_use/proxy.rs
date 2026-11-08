//! The stdio server a chat's agent starts for computer use.
//!
//! Flock's own executable runs in this mode when a bridge starts the
//! `computer_use` server Flock gave the chat. It starts the pinned driver's
//! `mcp` server with Flock's environment and relays newline-delimited JSON-RPC
//! both ways, changing only what [`policy`] decides: the server's
//! instructions and tool listing on the way out, and refused tool calls,
//! which it answers itself instead of passing on. Everything else — tool
//! results, notifications, the driver's own requests and the answers to them
//! — goes through byte for byte.
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

/// The requests whose answers describe the server and so get rewritten.
const PRESENTED_METHODS: &[&str] = &["initialize", "tools/list", "server/discover"];

/// What to do with one line from the agent.
#[derive(Debug, PartialEq)]
enum FromClient {
    /// Pass the line to the driver as it is.
    Forward,
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
            FromClient::Forward => {
                if driver
                    .write_all(&line)
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

/// Decide about one line from the agent, noting the ids of requests whose
/// answers [`from_driver`] has to rewrite.
fn from_client(line: &[u8], pending: &mut HashSet<String>) -> FromClient {
    let Ok(message) = serde_json::from_slice::<Value>(line) else {
        return FromClient::Forward;
    };
    if let Value::Array(batch) = &message {
        // Batches left MCP in 2025-06-18 and no bridge sends them; answering
        // each request keeps a tool call from riding past the checks inside one.
        let refusals: Vec<Value> = batch
            .iter()
            .filter_map(|request| request.get("id"))
            .map(|id| {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32600, "message": "Flock's computer use server does not take batched requests" },
                })
            })
            .collect();
        return if refusals.is_empty() {
            FromClient::Drop
        } else {
            FromClient::Answer(Value::Array(refusals))
        };
    }
    let (Some(method), Some(id)) = (
        message.get("method").and_then(Value::as_str),
        message.get("id"),
    ) else {
        return FromClient::Forward;
    };
    if method == "tools/call" {
        let params = message.get("params").unwrap_or(&Value::Null);
        if let Some(reason) = policy::refusal(params) {
            return FromClient::Answer(policy::refused_call(id, &reason));
        }
    } else if PRESENTED_METHODS.contains(&method) {
        pending.insert(id.to_string());
    }
    FromClient::Forward
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
        let allowed = from_client(
            &line(
                json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_windows","arguments":{}}}),
            ),
            &mut pending,
        );
        assert_eq!(allowed, FromClient::Forward);
        assert!(pending.is_empty());
    }

    #[test]
    fn the_listing_answer_is_rewritten_and_other_answers_pass_untouched() {
        let mut pending = HashSet::new();
        assert_eq!(
            from_client(
                &line(json!({"jsonrpc":"2.0","id":"a","method":"tools/list"})),
                &mut pending
            ),
            FromClient::Forward
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

    #[test]
    fn notifications_and_unreadable_lines_are_forwarded() {
        let mut pending = HashSet::new();
        assert_eq!(
            from_client(
                &line(json!({"jsonrpc":"2.0","method":"notifications/initialized"})),
                &mut pending
            ),
            FromClient::Forward
        );
        assert_eq!(
            from_client(b"not json\n", &mut pending),
            FromClient::Forward
        );
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
        let answered = String::from_utf8(out.into_inner().unwrap()).unwrap();
        assert!(answered.contains("\"isError\":true"));

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
