//! Computer use: a chat's agent operates apps on this Windows desktop in the
//! background, without taking the user's focus or cursor.
//!
//! It is part of Flock's harness, not an app the user connects. A chat with
//! computer use on gets one more tool server from Flock when its agent session
//! is opened: Flock's own executable in relay mode ([`proxy`]), which runs the
//! pinned Cua Driver ([`install`]) and shows the agent only the background,
//! single-window tools [`policy`] allows. Chats with it off — the default — and
//! every benchmark run never see it.

mod install;
mod policy;
mod proxy;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// The tool server's name, which harnesses put in front of its tools
/// (`mcp__computer_use__click`).
pub const SERVER_NAME: &str = "computer_use";
/// The first argument that starts Flock's executable as the relay.
pub const PROXY_FLAG: &str = "--flock-computer-use-mcp";
const DRIVER_FLAG: &str = "--driver";
const HOME_FLAG: &str = "--home";
/// The store scope that holds, per chat, whether computer use is on.
pub const KV_SCOPE: &str = "computerUse";

/// Run the relay when this process was started as one, returning its exit
/// code; `None` for a normal start. Called first thing in `main`, before the
/// app's single-instance check would hand the launch to the running Flock.
pub fn run_proxy_if_requested() -> Option<i32> {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    (args.first().map(String::as_str) == Some(PROXY_FLAG)).then(|| proxy::run(&args))
}

/// Install the pinned driver when it is missing or broken, and return its path.
pub async fn ensure_driver<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    let root = install::driver_root(app)?;
    install::ensure_driver_at(&root, install::driver_lock()).await
}

/// The version of the driver Flock pins.
pub fn driver_version() -> &'static str {
    &install::driver_lock().version
}

/// The tool server a chat with computer use on is given, when the driver is
/// installed. `None` otherwise: the chat then opens without it, and turning
/// computer use on again installs the driver.
pub fn server_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Value> {
    let root = install::driver_root(app).ok()?;
    let driver = install::installed_driver(&root)?;
    let exe = std::env::current_exe().ok()?;
    Some(server_entry(&exe, &driver, &install::driver_home(&root)))
}

fn server_entry(exe: &Path, driver: &Path, home: &Path) -> Value {
    json!({
        "name": SERVER_NAME,
        "command": exe.to_string_lossy(),
        "args": [
            PROXY_FLAG,
            DRIVER_FLAG,
            driver.to_string_lossy(),
            HOME_FLAG,
            home.to_string_lossy(),
        ],
        "env": [],
    })
}

/// Whether the store value for a chat says computer use is on.
pub fn is_on(value: Option<&Value>) -> bool {
    value
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_entry_starts_flock_as_the_relay() {
        let entry = server_entry(
            Path::new("C:\\Flock\\levocat_flock.exe"),
            Path::new("C:\\root\\cua-driver.exe"),
            Path::new("C:\\root\\home"),
        );
        assert_eq!(entry["name"], SERVER_NAME);
        assert_eq!(entry["command"], "C:\\Flock\\levocat_flock.exe");
        assert_eq!(entry["args"][0], PROXY_FLAG);
        assert_eq!(entry["args"][2], "C:\\root\\cua-driver.exe");
        assert_eq!(entry["args"][4], "C:\\root\\home");
        assert_eq!(entry["env"], json!([]));
    }

    #[test]
    fn computer_use_is_off_unless_stored_on() {
        assert!(!is_on(None));
        assert!(!is_on(Some(&json!({}))));
        assert!(!is_on(Some(&json!({ "enabled": "yes" }))));
        assert!(is_on(Some(&json!({ "enabled": true }))));
    }
}
