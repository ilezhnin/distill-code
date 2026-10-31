//! A provider's own sign-in inside the benchmark sandbox, started from the
//! installed app.
//!
//! Kimi is the one provider whose sandbox sessions sign in with a grant the
//! sandbox keeps; every other provider's sessions run on a lease of the
//! app's own sign-in. [`open`] runs `bench-login` for one account in a
//! console window of its own, with the Windows headroom sampled just before
//! (bench-run admits no sign-in without it), and the operator signs in there
//! with the provider's own flow. The app never reads, writes or keeps what
//! that window shows: it waits for the window to close, then observes the
//! sandbox again and says whether the account is signed in now.

use super::{
    agent_host::{execution::NativeProvider, text_execution},
    benchmark_sandbox::{self as sandbox, DISTRIBUTION},
    benchmark_sandbox_setup as setup,
};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    sync::{Mutex, MutexGuard, PoisonError},
};
use tauri::{AppHandle, Emitter};

/// The event that says a sign-in window closed, with the state after it.
pub(crate) const EVENT: &str = "benchmark-sandbox-sign-in";

/// What an account of a provider needs from the sandbox to run benchmarks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInState {
    /// This provider's sandbox sessions sign in with a grant the sandbox
    /// keeps, so the account must sign in there once.
    pub required: bool,
    /// Whether the sandbox holds the account's sign-in; unknown when it is
    /// not required or the sandbox itself cannot be checked (its setup says
    /// why).
    pub signed_in: Option<bool>,
    /// A sign-in window for the account is open now.
    pub open: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Closed {
    provider_id: &'static str,
    account_id: String,
    state: SignInState,
}

/// The accounts whose sign-in window is open, by provider key.
static OPEN: Mutex<BTreeSet<(&'static str, String)>> = Mutex::new(BTreeSet::new());

fn windows() -> MutexGuard<'static, BTreeSet<(&'static str, String)>> {
    OPEN.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether any sign-in window is open: setup waits until none is, as
/// provisioning restarts the sandbox under it.
pub(crate) fn any_open() -> bool {
    !windows().is_empty()
}

fn is_open(provider: NativeProvider, account: &str) -> bool {
    windows().contains(&(provider.key(), account.to_owned()))
}

/// An account's open sign-in window, until this is dropped.
#[derive(Debug)]
struct Window((&'static str, String));

impl Window {
    fn claim(provider: NativeProvider, account: &str) -> Result<Self, String> {
        let key = (provider.key(), account.to_owned());
        if !windows().insert(key.clone()) {
            return Err(
                "resource_busy: a sign-in window for this account is already open".to_owned(),
            );
        }
        Ok(Self(key))
    }
}

impl Drop for Window {
    fn drop(&mut self) {
        windows().remove(&self.0);
    }
}

/// The state of `provider`'s account, given whether the sandbox was seen
/// to hold its sign-in (`observed`) and whether its window is open.
fn state(provider: NativeProvider, observed: Option<bool>, open: bool) -> SignInState {
    let required = text_execution::requires_sandbox_sign_in(provider);
    SignInState {
        required,
        signed_in: if required { observed } else { None },
        open,
    }
}

fn signed_in(status: &sandbox::Status, provider: NativeProvider, account: &str) -> bool {
    status.require_account(provider.key(), account).is_ok()
}

/// Whether `account` of `provider` must sign in inside the sandbox, and
/// whether it has. Asks the sandbox only for a provider that keeps its sign-in
/// there, and not while a setup changes it.
pub(crate) async fn status(provider: NativeProvider, account: &str) -> Result<SignInState, String> {
    sandbox::valid_id(account).map_err(|error| format!("validation: {error}"))?;
    let open = is_open(provider, account);
    if !text_execution::requires_sandbox_sign_in(provider) || setup::running() {
        return Ok(state(provider, None, open));
    }
    let observed = sandbox::ready()
        .await
        .ok()
        .map(|status| signed_in(&status, provider, account));
    Ok(state(provider, observed, open))
}

/// Opens a console window in which the operator signs `account` of
/// `provider` in inside the sandbox, and returns once it is open. When it
/// closes, the app observes the sandbox again and sends [`EVENT`].
pub(crate) async fn open(
    app: AppHandle,
    provider: NativeProvider,
    account: String,
) -> Result<SignInState, String> {
    if !text_execution::requires_sandbox_sign_in(provider) {
        return Err(format!(
            "validation: {} signs in in Flock, not inside the sandbox",
            provider.key()
        ));
    }
    sandbox::valid_id(&account).map_err(|error| format!("validation: {error}"))?;
    let window = {
        let _setup = setup::hold()?;
        Window::claim(provider, &account)?
    };
    // bench-run admits the sign-in against this sample only while it is
    // fresh, so it is taken right before the window starts.
    let gate = tokio::task::spawn_blocking(sandbox::host_gate)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("The Windows headroom could not be sampled: {error}"))?;
    let process = launch(console_line(&wsl_program(), &gate, provider, &account)?).await?;
    log::info!(
        "Opened the {} sandbox sign-in window for account {account}",
        provider.key()
    );
    let opened = state(provider, None, true);
    tauri::async_runtime::spawn(async move {
        if let Some(process) = process {
            let _ = tokio::task::spawn_blocking(move || wait(process)).await;
        }
        drop(window);
        let observed = sandbox::observe_now()
            .await
            .ok()
            .map(|status| signed_in(&status, provider, &account));
        let state = state(provider, observed, is_open(provider, &account));
        let _ = app.emit(
            EVENT,
            Closed {
                provider_id: provider.harness_id(),
                account_id: account,
                state,
            },
        );
    });
    Ok(opened)
}

/// The command line `cmd.exe` runs in the window: `bench-login` for
/// `account` with the headroom sample `gate`, then, when it fails, a pause,
/// so its last lines stay readable until the operator closes the window.
/// `cmd.exe` gives meaning to characters like `&`, `%` and `"`: each part is
/// checked to hold none.
fn console_line(
    wsl: &str,
    gate: &str,
    provider: NativeProvider,
    account: &str,
) -> Result<String, String> {
    let fields = gate.split(',').collect::<Vec<_>>();
    if fields.len() != 5
        || fields
            .iter()
            .any(|field| field.is_empty() || !field.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(format!("The Windows headroom sample is malformed: {gate}"));
    }
    sandbox::valid_id(account).map_err(|error| error.to_string())?;
    if wsl.is_empty() || wsl.contains(['"', '%', '!', '^', '\r', '\n']) {
        return Err(format!("The WSL program path cannot be passed on: {wsl}"));
    }
    let provider = provider.key();
    Ok(format!(
        "/d /s /c \"title Flock - {DISTRIBUTION} - {provider} & \"{wsl}\" -d {DISTRIBUTION} -u root --exec /usr/bin/env DISTILL_BENCH_HOST_GATE={gate} /usr/local/sbin/bench-login {provider} {account} || (pause & exit /b 1)\""
    ))
}

#[cfg(windows)]
type Process = super::process::ShellProcess;
#[cfg(not(windows))]
type Process = ();

#[cfg(windows)]
fn wsl_program() -> String {
    super::process::system_program("wsl.exe")
        .to_string_lossy()
        .into_owned()
}

#[cfg(not(windows))]
fn wsl_program() -> String {
    "wsl.exe".into()
}

/// Starts `cmd.exe` with `line` in a new console window.
#[cfg(windows)]
async fn launch(line: String) -> Result<Option<Process>, String> {
    use super::process::{system_program, ShellProcess};
    tokio::task::spawn_blocking(move || {
        let cmd = system_program("cmd.exe");
        let folder = cmd.parent().filter(|folder| folder.is_dir());
        ShellProcess::start("open", &cmd, &line, folder).map_err(|error| {
            format!(
                "The sign-in window could not be opened (Windows error {})",
                error.raw_os_error().unwrap_or_default()
            )
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(windows))]
async fn launch(_line: String) -> Result<Option<Process>, String> {
    Err("Benchmark sandboxes need Windows with WSL 2".into())
}

#[cfg(windows)]
fn wait(process: Process) {
    process.wait();
}

#[cfg(not(windows))]
fn wait(_process: Process) {}

#[cfg(test)]
mod tests {
    use super::*;

    const GATE: &str = "1800000000000,8589934592,17179869184,107374182400,1001";

    #[test]
    fn only_a_provider_that_keeps_its_sign_in_in_the_sandbox_needs_one() {
        for provider in NativeProvider::ALL {
            let needed = state(*provider, Some(false), false);
            if *provider == NativeProvider::Kimi {
                assert!(needed.required);
                assert_eq!(needed.signed_in, Some(false));
            } else {
                // A leased provider signs in in Flock: nothing to offer,
                // whatever the sandbox holds.
                assert!(!needed.required, "{provider:?}");
                assert_eq!(needed.signed_in, None, "{provider:?}");
            }
        }
        assert_eq!(
            state(NativeProvider::Kimi, None, false).signed_in,
            None,
            "an unchecked sandbox claims no sign-in either way"
        );
        assert_eq!(
            state(NativeProvider::Kimi, Some(true), false).signed_in,
            Some(true)
        );
    }

    #[tokio::test]
    async fn a_leased_provider_is_neither_checked_nor_opened() {
        let state = status(NativeProvider::Claude, "account-1").await.unwrap();
        assert_eq!(
            state,
            SignInState {
                required: false,
                signed_in: None,
                open: false
            }
        );
        assert!(status(NativeProvider::Kimi, "bad id").await.is_err());
    }

    #[test]
    fn one_window_per_account_and_setup_waits_for_all() {
        let account = "sign-in-test-account";
        let first = Window::claim(NativeProvider::Kimi, account).unwrap();
        assert!(is_open(NativeProvider::Kimi, account));
        assert!(any_open());
        assert!(Window::claim(NativeProvider::Kimi, account)
            .unwrap_err()
            .starts_with("resource_busy:"));
        let other = Window::claim(NativeProvider::Kimi, "sign-in-test-other").unwrap();
        drop(first);
        assert!(!is_open(NativeProvider::Kimi, account));
        assert!(any_open(), "another account's window is still open");
        drop(other);
        assert!(Window::claim(NativeProvider::Kimi, account).is_ok());
    }

    #[test]
    fn the_window_runs_bench_login_with_a_fresh_gate_and_pauses_on_failure() {
        let line = console_line(
            r"C:\Windows\System32\wsl.exe",
            GATE,
            NativeProvider::Kimi,
            "account-1",
        )
        .unwrap();
        assert_eq!(
            line,
            format!(
                "/d /s /c \"title Flock - distill-bench - kimi & \"C:\\Windows\\System32\\wsl.exe\" -d distill-bench -u root --exec /usr/bin/env DISTILL_BENCH_HOST_GATE={GATE} /usr/local/sbin/bench-login kimi account-1 || (pause & exit /b 1)\""
            )
        );
    }

    #[test]
    fn nothing_cmd_would_interpret_reaches_the_window() {
        let line = |wsl: &str, gate: &str, account: &str| {
            console_line(wsl, gate, NativeProvider::Kimi, account)
        };
        let wsl = r"C:\Windows\System32\wsl.exe";
        assert!(line(wsl, GATE, "a&calc").is_err());
        assert!(line(wsl, GATE, "a b").is_err());
        assert!(line(wsl, GATE, "").is_err());
        assert!(line(wsl, "1,2,3,4", "account-1").is_err());
        assert!(line(wsl, "1,2,3,4,5&calc", "account-1").is_err());
        assert!(line(wsl, "1,2,,4,5", "account-1").is_err());
        assert!(line(r"C:\%PATH%\wsl.exe", GATE, "account-1").is_err());
        assert!(line(r#"C:\a" & calc & "\wsl.exe"#, GATE, "account-1").is_err());
        assert!(line(wsl, "1,2,3,4,5", "account-1").is_ok());
    }
}
