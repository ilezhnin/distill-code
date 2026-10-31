//! The benchmark sandbox, set up and repaired by the installed app itself.
//!
//! [`status`] says what stands between this computer and a sandbox this
//! build accepts. [`run`] takes the next step the app can take, observes
//! again and goes on, until the sandbox is ready or only the operator can
//! act: restart Windows, turn on virtualization, free disk space. Each run is
//! an explicit operator action. Nothing here runs at app start, and nothing
//! removes a distribution or the data in it: provisioning again keeps the
//! sandbox's sign-ins, and a distribution whose disk is still in place is
//! registered again instead of being replaced.

use super::{
    agent_host::{execution::NativeProvider, text_execution},
    benchmark_policy_check,
    benchmark_sandbox::{self as sandbox, Drift, DISTRIBUTION},
    benchmark_sandbox_sign_in as sign_in,
    benchmarks::worker,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::VecDeque,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

/// The image the sandbox is made from; `browser-provision` requires it.
const UBUNTU: &str = "Ubuntu-24.04";
/// The event that carries setup progress to the app.
pub(crate) const EVENT: &str = "benchmark-sandbox-setup";
const LOG_LINES: usize = 200;
const LINE_CHARS: usize = 400;
const EMIT_INTERVAL: Duration = Duration::from_millis(250);
/// The free space sandbox admission requires on the sandbox's drive.
const FREE_SPACE_FLOOR: u64 = 30 * 1024 * 1024 * 1024;

const ACP_TOOLS_LOCK: &str = include_str!("../../../acp-tools.lock.json");
const RUNTIME_SOURCES: &str =
    include_str!("../../resources/benchmark-sandbox/runtime-sources.json");

/// Provisioning inputs besides the helpers [`sandbox::FILES`] pins.
const PROVISIONING: &[(&str, &[u8])] = &[
    (
        "provision.sh",
        include_bytes!("../../resources/benchmark-sandbox/provision.sh"),
    ),
    (
        "install-helpers.sh",
        include_bytes!("../../resources/benchmark-sandbox/install-helpers.sh"),
    ),
    (
        "browser-provision",
        include_bytes!("../../resources/benchmark-sandbox/browser-provision"),
    ),
    (
        "browser-apparmor",
        include_bytes!("../../resources/benchmark-sandbox/browser-apparmor"),
    ),
    ("runtime-sources.json", RUNTIME_SOURCES.as_bytes()),
    (
        "benchmark-browser-worker.mjs",
        include_bytes!("../../resources/benchmark-browser-worker.mjs"),
    ),
];

/// Unpacks the staged archive from standard input and provisions from it,
/// as `scripts/benchmark-sandbox.mjs` does from a checkout.
const UNPACK_AND_PROVISION: &str = "rm -rf /tmp/distill-provision && mkdir -p /tmp/distill-provision && tar -x -C /tmp/distill-provision && bash /tmp/distill-provision/provision.sh \"$@\"";
/// The reviewed, network-free helper update (`install-helpers.sh`).
const UPDATE_HELPERS: &str = "import subprocess,sys,tempfile; p=tempfile.mkdtemp(prefix='distill-helper-update.',dir='/tmp'); subprocess.run(['tar','-x','-C',p],stdin=sys.stdin.buffer,check=True); subprocess.run(['bash',p+'/install-helpers.sh',p],check=True)";

/// What stands between this computer and a sandbox this build accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// Benchmark sandboxes need Windows with WSL 2.
    Unsupported,
    /// WSL, or the Virtual Machine Platform it runs on, is not installed.
    WslMissing,
    /// Windows must restart to finish enabling WSL.
    RestartRequired,
    /// Virtualization is off in the computer's firmware.
    VirtualizationOff,
    /// There is no sandbox distribution yet.
    NotSetUp,
    /// The sandbox differs from what this build pins.
    NeedsRepair,
    /// The sandbox's drive lacks the free space admission requires.
    LowDisk,
    /// The computer cannot spare the memory now, or jobs are draining.
    Busy,
    /// The sandbox could not be checked.
    Unavailable,
    Ready,
}

/// What the operator can ask the app to do about a [`Stage`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    /// Install WSL and its Virtual Machine Platform (asks Windows for
    /// administrator permission).
    InstallWsl,
    /// Create or restore the distribution and bring it to this build.
    SetUp,
}

/// The step a running setup is on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Checking,
    InstallingWsl,
    CreatingDistribution,
    RestoringDistribution,
    Provisioning,
    UpdatingHelpers,
    VerifyingBrowser,
    CheckingPolicy,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub step: Step,
    /// The last line the step printed.
    pub line: Option<String>,
    /// The last lines of the whole run, oldest first.
    pub log: Vec<String>,
    pub started_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    pub stage: Stage,
    pub action: Option<Action>,
    /// Technical detail for the operator: what was observed, never a secret.
    pub detail: Option<String>,
    /// The setup running now, if any.
    pub running: Option<Progress>,
}

/// A repair the app can make itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Need {
    /// Install Ubuntu as the sandbox distribution.
    Create,
    /// Register the distribution again from the disk it left behind.
    Restore,
    /// Network-free update of the sandbox helpers.
    Helpers,
    /// Full provisioning: runtime, tools, helpers and browser.
    Provision,
    /// The browser's readiness receipt, from a real sandboxed launch.
    Browser,
}

#[derive(Debug)]
struct Diagnosis {
    stage: Stage,
    detail: Option<String>,
    need: Option<Need>,
}

impl Diagnosis {
    fn state(&self) -> SetupState {
        let action = match self.stage {
            Stage::WslMissing => Some(Action::InstallWsl),
            Stage::NotSetUp | Stage::NeedsRepair => Some(Action::SetUp),
            _ => None,
        };
        SetupState {
            stage: self.stage,
            action,
            detail: self.detail.clone(),
            running: None,
        }
    }
}

fn blocked(stage: Stage, detail: impl Into<String>) -> Diagnosis {
    Diagnosis {
        stage,
        detail: Some(detail.into()),
        need: None,
    }
}

fn repair(stage: Stage, need: Need, detail: impl Into<String>) -> Diagnosis {
    Diagnosis {
        stage,
        detail: Some(detail.into()),
        need: Some(need),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One setup at a time.
static RUN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// The running setup's progress, and when it was last sent.
static PROGRESS: Mutex<(Option<Progress>, Option<Instant>)> = Mutex::new((None, None));
/// The last finished diagnosis, shown beside a running setup.
static LAST: Mutex<Option<SetupState>> = Mutex::new(None);

fn remember(state: SetupState) -> SetupState {
    *lock(&LAST) = Some(state.clone());
    state
}

/// Whether a setup is running now.
pub(crate) fn running() -> bool {
    lock(&PROGRESS).0.is_some()
}

/// Keeps a setup from starting while the guard lives, so what setup must
/// wait for (a sign-in window) is claimed in one step with this check; or
/// refuses while a setup runs.
pub(crate) fn hold() -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    RUN.try_lock().map_err(|_| {
        "resource_busy: the sandbox is being set up; sign in once setup is done".to_owned()
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    running: Option<Progress>,
    /// When a setup ends: what the sandbox needs after it, or none when it
    /// failed (the app then asks again).
    state: Option<SetupState>,
}

/// Keeps the running setup's progress and sends it to the app.
struct Reporter {
    app: Option<AppHandle>,
}

impl Reporter {
    fn step(&self, step: Step) {
        {
            let mut progress = lock(&PROGRESS);
            match &mut progress.0 {
                Some(running) => {
                    running.step = step;
                    running.line = None;
                }
                None => {
                    progress.0 = Some(Progress {
                        step,
                        line: None,
                        log: Vec::new(),
                        started_at: chrono::Utc::now().timestamp_millis(),
                    })
                }
            }
        }
        self.emit(true);
    }

    fn line(&self, line: String) {
        {
            let mut progress = lock(&PROGRESS);
            if let Some(running) = &mut progress.0 {
                if running.log.len() >= LOG_LINES {
                    running.log.remove(0);
                }
                running.log.push(line.clone());
                running.line = Some(line);
            }
        }
        self.emit(false);
    }

    fn emit(&self, now: bool) {
        let Some(app) = &self.app else {
            return;
        };
        let running = {
            let mut progress = lock(&PROGRESS);
            if !now && progress.1.is_some_and(|at| at.elapsed() < EMIT_INTERVAL) {
                return;
            }
            progress.1 = Some(Instant::now());
            progress.0.clone()
        };
        let _ = app.emit(
            EVENT,
            ProgressEvent {
                running,
                state: None,
            },
        );
    }
}

/// Ends the running setup's progress however the run ends, with the state
/// it reached when it reached one.
struct Finish<'a> {
    reporter: &'a Reporter,
    state: Option<SetupState>,
}
impl Drop for Finish<'_> {
    fn drop(&mut self) {
        *lock(&PROGRESS) = (None, None);
        if let Some(app) = &self.reporter.app {
            let _ = app.emit(
                EVENT,
                ProgressEvent {
                    running: None,
                    state: self.state.take(),
                },
            );
        }
    }
}

/// What the sandbox needs now. While a setup runs, its progress beside the
/// last finished diagnosis: observing meanwhile would race its steps.
pub(crate) async fn status(location: &Path) -> SetupState {
    if let Some(running) = lock(&PROGRESS).0.clone() {
        let mut state = lock(&LAST).clone().unwrap_or(SetupState {
            stage: Stage::Unavailable,
            action: None,
            detail: None,
            running: None,
        });
        state.running = Some(running);
        return state;
    }
    remember(diagnose(location).await.state())
}

/// Carries out `action`, then reports what the sandbox needs after it.
/// `provider`, when given, also renews that provider's offline policy check
/// once the sandbox is ready, so its run dialog can dispatch.
pub(crate) async fn run(
    app: AppHandle,
    location: PathBuf,
    action: Action,
    provider: Option<NativeProvider>,
) -> Result<SetupState, String> {
    let _run = RUN
        .try_lock()
        .map_err(|_| "resource_busy: the sandbox is already being set up".to_owned())?;
    // Provisioning restarts the sandbox, and so ends a sign-in under way.
    if sign_in::any_open() {
        return Err("resource_busy: a sign-in window for the sandbox is open; finish or close it, then set the sandbox up".into());
    }
    let reporter = Reporter { app: Some(app) };
    let mut finish = Finish {
        reporter: &reporter,
        state: None,
    };
    match action {
        Action::InstallWsl => {
            reporter.step(Step::InstallingWsl);
            install_wsl().await?;
        }
        Action::SetUp => converge(&reporter, &location, provider).await?,
    }
    reporter.step(Step::Checking);
    let state = remember(diagnose(&location).await.state());
    finish.state = Some(state.clone());
    Ok(state)
}

/// Repairs until nothing the app can do is left. A repair that did not
/// help gives way to a heavier one, and none is taken twice in a row.
async fn converge(
    reporter: &Reporter,
    location: &Path,
    provider: Option<NativeProvider>,
) -> Result<(), String> {
    let mut taken = Vec::new();
    for _ in 0..8 {
        reporter.step(Step::Checking);
        let diagnosis = diagnose(location).await;
        let Some(need) = diagnosis.need else {
            if diagnosis.stage == Stage::Ready {
                if let Some(provider) = provider {
                    renew_policy(reporter, provider).await?;
                }
            }
            return Ok(());
        };
        let Some(step) = next_step(need, &taken) else {
            return Err(format!(
                "The sandbox still differs from this build after setup: {}",
                diagnosis.detail.unwrap_or_default()
            ));
        };
        perform(reporter, step, location).await?;
        taken.push(step);
    }
    Err("Sandbox setup stopped after too many steps".into())
}

/// The repair to make for `need`, given the repairs already `taken`:
/// helpers before full provisioning, a browser receipt before and after it.
fn next_step(need: Need, taken: &[Need]) -> Option<Need> {
    let last = |step: Need| taken.iter().rposition(|taken| *taken == step);
    let provisioned = last(Need::Provision);
    match need {
        Need::Create | Need::Restore => last(need).is_none().then_some(need),
        Need::Helpers if last(Need::Helpers).is_none() && provisioned.is_none() => {
            Some(Need::Helpers)
        }
        Need::Browser
            if match (last(Need::Browser), provisioned) {
                (None, _) => true,
                (Some(browser), Some(provisioned)) => provisioned > browser,
                (Some(_), None) => false,
            } =>
        {
            Some(Need::Browser)
        }
        Need::Helpers | Need::Browser | Need::Provision => {
            provisioned.is_none().then_some(Need::Provision)
        }
    }
}

async fn perform(reporter: &Reporter, step: Need, location: &Path) -> Result<(), String> {
    match step {
        Need::Create => {
            reporter.step(Step::CreatingDistribution);
            create(reporter, location).await
        }
        Need::Restore => {
            reporter.step(Step::RestoringDistribution);
            restore(reporter, &location.join("ext4.vhdx")).await
        }
        Need::Provision => {
            reporter.step(Step::Provisioning);
            provision(reporter).await
        }
        Need::Helpers => {
            reporter.step(Step::UpdatingHelpers);
            update_helpers(reporter).await
        }
        Need::Browser => {
            reporter.step(Step::VerifyingBrowser);
            browser_receipt().await
        }
    }
}

async fn renew_policy(reporter: &Reporter, provider: NativeProvider) -> Result<(), String> {
    let status = sandbox::observe_now()
        .await
        .map_err(|error| error.to_string())?;
    if text_execution::require_proof(provider, &status)
        .await
        .is_ok()
    {
        return Ok(());
    }
    reporter.step(Step::CheckingPolicy);
    benchmark_policy_check::renew(provider).await
}

async fn diagnose(location: &Path) -> Diagnosis {
    if !cfg!(windows) {
        return blocked(
            Stage::Unsupported,
            "Benchmark sandboxes need Windows with WSL 2",
        );
    }
    if sandbox::registered_path().is_err() {
        let platform = observe_platform().await;
        if let Some((stage, reason)) = platform_blocker(&platform) {
            return blocked(stage, describe(reason, &platform));
        }
        if let Some(free) = free_space(location).filter(|free| *free < FREE_SPACE_FLOOR) {
            return blocked(
                Stage::LowDisk,
                format!(
                    "The drive of {} has {} GiB free; benchmarks need 30 GiB",
                    location.display(),
                    free / (1024 * 1024 * 1024)
                ),
            );
        }
        let disk = location.join("ext4.vhdx");
        if disk.is_file() {
            return repair(
                Stage::NotSetUp,
                Need::Restore,
                format!(
                    "{DISTRIBUTION} is not registered; its disk is kept at {}",
                    disk.display()
                ),
            );
        }
        return repair(
            Stage::NotSetUp,
            Need::Create,
            format!("{DISTRIBUTION} is not registered"),
        );
    }
    if let Err(detail) = start_probe().await {
        let platform = observe_platform().await;
        if let Some((stage, reason)) = platform_blocker(&platform) {
            return blocked(stage, format!("{}; {detail}", describe(reason, &platform)));
        }
        return blocked(Stage::Unavailable, detail);
    }
    match sandbox::status_report().await {
        Err(error) if error.to_string().contains("resource_busy") => {
            return blocked(Stage::Busy, error.to_string())
        }
        // No helpers answer: a distribution provisioning never finished.
        Err(error) => return repair(Stage::NeedsRepair, Need::Provision, error.to_string()),
        Ok(report) => match sandbox::drift(&report) {
            Drift::Runtime(missing) => {
                return repair(Stage::NeedsRepair, Need::Provision, differs(&missing))
            }
            Drift::Helpers(missing) => {
                return repair(Stage::NeedsRepair, Need::Helpers, differs(&missing))
            }
            Drift::Current => {}
        },
    }
    if let Err(error) = sandbox::observe_now().await {
        let detail = error.to_string();
        return if error.kind() == io::ErrorKind::WouldBlock {
            let stage = if detail.contains("sandbox volume") {
                Stage::LowDisk
            } else {
                Stage::Busy
            };
            blocked(stage, detail)
        } else {
            repair(Stage::NeedsRepair, Need::Provision, detail)
        };
    }
    match worker::ready().await {
        Ok(_) => Diagnosis {
            stage: Stage::Ready,
            detail: None,
            need: None,
        },
        Err(error) if error.code == "resource_busy" => blocked(Stage::Busy, error.message),
        Err(error) => repair(Stage::NeedsRepair, Need::Browser, error.message),
    }
}

fn differs(missing: &[String]) -> String {
    format!("Differs from this build: {}", missing.join(", "))
}

/// Whether WSL starts the sandbox at all, with WSL's own words if not.
async fn start_probe() -> Result<(), String> {
    let mut command = in_sandbox(&["/bin/true"]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    super::process::apply_no_window_async(&mut command);
    match tokio::time::timeout(Duration::from_secs(180), command.output()).await {
        Err(_) => Err("WSL did not start the sandbox within three minutes".into()),
        Ok(Err(error)) => Err(format!("WSL could not be started: {error}")),
        Ok(Ok(output)) if output.status.success() => Ok(()),
        Ok(Ok(output)) => {
            let text = [output.stdout, output.stderr]
                .iter()
                .flat_map(|bytes| {
                    String::from_utf8_lossy(bytes)
                        .lines()
                        .filter_map(clean_line)
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>()
                .join(" ");
            Err(if text.is_empty() {
                "WSL could not start the sandbox".into()
            } else {
                text
            })
        }
    }
}

/// The facts that decide whether WSL 2 can run a distribution here.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Platform {
    /// The WSL service is installed (the WSL package, not only the inbox
    /// `wsl.exe` that offers to install it).
    wsl_installed: bool,
    /// The Hyper-V compute service WSL 2 starts its VM through is
    /// registered: the Virtual Machine Platform is enabled and active.
    compute_service: bool,
    /// Windows waits for a restart to finish changing its components.
    restart_pending: bool,
    /// The Windows hypervisor runs.
    hypervisor_running: bool,
    /// The firmware offers virtualization (only visible without a hypervisor).
    firmware_virtualization: bool,
}

/// What keeps WSL 2 from running a distribution here, if anything.
fn platform_blocker(platform: &Platform) -> Option<(Stage, &'static str)> {
    if !platform.wsl_installed {
        return Some((Stage::WslMissing, "WSL is not installed"));
    }
    if !platform.hypervisor_running && !platform.firmware_virtualization {
        return Some((
            Stage::VirtualizationOff,
            "virtualization is turned off in the firmware",
        ));
    }
    if platform.compute_service && platform.hypervisor_running {
        return None;
    }
    if platform.restart_pending {
        return Some((
            Stage::RestartRequired,
            "Windows has a restart pending and the Virtual Machine Platform is not active yet",
        ));
    }
    if platform.compute_service {
        return Some((
            Stage::VirtualizationOff,
            "the Windows hypervisor is not running",
        ));
    }
    Some((
        Stage::WslMissing,
        "the Virtual Machine Platform is not enabled",
    ))
}

fn describe(reason: &str, platform: &Platform) -> String {
    let yes = |value: bool| if value { "yes" } else { "no" };
    format!(
        "{reason} (WSL service: {}, Hyper-V compute service: {}, hypervisor running: {}, firmware virtualization: {}, restart pending: {})",
        yes(platform.wsl_installed),
        yes(platform.compute_service),
        yes(platform.hypervisor_running),
        yes(platform.firmware_virtualization),
        yes(platform.restart_pending),
    )
}

#[cfg(windows)]
async fn observe_platform() -> Platform {
    tokio::task::spawn_blocking(|| {
        use windows_sys::Win32::System::Threading::{
            IsProcessorFeaturePresent, PF_VIRT_FIRMWARE_ENABLED,
        };
        Platform {
            wsl_installed: machine_key_exists(r"SYSTEM\CurrentControlSet\Services\WSLService"),
            compute_service: machine_key_exists(r"SYSTEM\CurrentControlSet\Services\vmcompute"),
            restart_pending: machine_key_exists(
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
            ),
            hypervisor_running: hypervisor_running(),
            firmware_virtualization: unsafe {
                IsProcessorFeaturePresent(PF_VIRT_FIRMWARE_ENABLED)
            } != 0,
        }
    })
    .await
    .unwrap_or_default()
}

#[cfg(not(windows))]
async fn observe_platform() -> Platform {
    Platform::default()
}

/// Whether `HKEY_LOCAL_MACHINE\{path}` exists. A key this account may not
/// open still exists.
#[cfg(windows)]
fn machine_key_exists(path: &str) -> bool {
    use windows_sys::Win32::{
        Foundation::{ERROR_ACCESS_DENIED, ERROR_SUCCESS},
        System::Registry::{RegCloseKey, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ},
    };
    let name: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let mut key: HKEY = std::ptr::null_mut();
    let result = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, name.as_ptr(), 0, KEY_READ, &mut key) };
    if result == ERROR_SUCCESS {
        unsafe { RegCloseKey(key) };
    }
    result == ERROR_SUCCESS || result == ERROR_ACCESS_DENIED
}

/// The CPUID "hypervisor present" bit: set in every partition, the host's
/// included, while the Windows hypervisor runs.
#[cfg(all(windows, target_arch = "x86_64"))]
fn hypervisor_running() -> bool {
    #[allow(unused_unsafe)]
    let leaf = unsafe { std::arch::x86_64::__cpuid(1) };
    leaf.ecx & (1 << 31) != 0
}

#[cfg(all(windows, not(target_arch = "x86_64")))]
fn hypervisor_running() -> bool {
    true
}

/// Free bytes on the drive that holds `path` (or its nearest existing parent).
#[cfg(windows)]
fn free_space(path: &Path) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let existing = path.ancestors().find(|candidate| candidate.is_dir())?;
    let wide: Vec<u16> = existing
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut available = 0_u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(available)
}

#[cfg(not(windows))]
fn free_space(_: &Path) -> Option<u64> {
    None
}

async fn install_wsl() -> Result<(), String> {
    tokio::task::spawn_blocking(install_wsl_elevated)
        .await
        .map_err(|error| error.to_string())?
}

/// Runs `wsl.exe --install --no-distribution` as administrator. Windows asks
/// the operator for that permission; its console shows the installation.
#[cfg(windows)]
fn install_wsl_elevated() -> Result<(), String> {
    use super::process::{system_program, ShellProcess};
    use windows_sys::Win32::Foundation::ERROR_CANCELLED;
    let started = ShellProcess::start(
        "runas",
        &system_program("wsl.exe"),
        "--install --no-distribution",
        None,
    )
    .map_err(|error| {
        if error.raw_os_error() == Some(ERROR_CANCELLED as i32) {
            "cancelled: Windows did not get administrator permission, so WSL was not installed"
                .to_owned()
        } else {
            format!(
                "WSL installation could not start (Windows error {})",
                error.raw_os_error().unwrap_or_default()
            )
        }
    })?;
    let Some(process) = started else {
        return Ok(());
    };
    match process.wait() {
        // 3010 and 1641: installed, and Windows restarts to finish.
        None | Some(0) | Some(3010) | Some(1641) => Ok(()),
        Some(code) => Err(format!("WSL installation exited with code {code}")),
    }
}

#[cfg(not(windows))]
fn install_wsl_elevated() -> Result<(), String> {
    Err("WSL is available on Windows only".into())
}

fn wsl_command() -> tokio::process::Command {
    let mut command = tokio::process::Command::new("wsl.exe");
    // wsl.exe's own messages in UTF-8 rather than UTF-16.
    command.env("WSL_UTF8", "1");
    command
}

fn in_sandbox(args: &[&str]) -> tokio::process::Command {
    let mut command = wsl_command();
    command
        .args(["-d", DISTRIBUTION, "-u", "root", "--exec"])
        .args(args);
    command
}

async fn create(reporter: &Reporter, location: &Path) -> Result<(), String> {
    std::fs::create_dir_all(location)
        .map_err(|error| format!("{} could not be created: {error}", location.display()))?;
    let mut command = wsl_command();
    command
        .args(["--install", UBUNTU, "--name", DISTRIBUTION, "--location"])
        .arg(location)
        .args(["--no-launch", "--web-download"]);
    run_logged(
        reporter,
        "Ubuntu installation",
        command,
        None,
        Duration::from_secs(45 * 60),
    )
    .await
}

async fn restore(reporter: &Reporter, disk: &Path) -> Result<(), String> {
    let mut command = wsl_command();
    command.args(["--import-in-place", DISTRIBUTION]).arg(disk);
    run_logged(
        reporter,
        "Registering the kept sandbox disk",
        command,
        None,
        Duration::from_secs(10 * 60),
    )
    .await
}

async fn provision(reporter: &Reporter) -> Result<(), String> {
    let command = in_sandbox(&["bash", "-c", UNPACK_AND_PROVISION, "provision"]);
    run_logged(
        reporter,
        "Sandbox provisioning",
        command,
        Some(stage()?),
        Duration::from_secs(120 * 60),
    )
    .await?;
    // The boot configuration (no Windows drives, no interop) applies from
    // the next start.
    let mut command = wsl_command();
    command.args(["--terminate", DISTRIBUTION]);
    run_logged(
        reporter,
        "Restarting the sandbox",
        command,
        None,
        Duration::from_secs(120),
    )
    .await
}

async fn update_helpers(reporter: &Reporter) -> Result<(), String> {
    let command = in_sandbox(&["python3", "-c", UPDATE_HELPERS]);
    run_logged(
        reporter,
        "Sandbox helper update",
        command,
        Some(stage()?),
        Duration::from_secs(15 * 60),
    )
    .await
}

/// Issues the browser's readiness receipt from a real sandboxed launch and
/// interaction, under its own browser lease (as
/// `scripts/benchmark-browser-ready.mjs` does).
async fn browser_receipt() -> Result<(), String> {
    let id = format!("browser-ready-{}", uuid::Uuid::new_v4());
    let mut cleanup = sandbox::Cleanup(Some(id.clone()));
    let outcome = sandbox::invoke_bounded(
        "/usr/local/sbin/bench-browser",
        &["provision-receipt", &id],
        None,
        64 * 1024,
        Duration::from_secs(6 * 60),
    )
    .await;
    if sandbox::clean(&id).await.is_ok() {
        cleanup.0 = None;
    }
    let output = outcome.map_err(|error| error.to_string())?;
    if !output.success() || output.truncated {
        return Err(format!(
            "The sandboxed browser check failed, so no receipt was issued: {}",
            output.reason()
        ));
    }
    let identity: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "The browser check returned no identity".to_owned())?;
    let digest = |value: &Value| {
        value
            .as_str()
            .is_some_and(|text| text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()))
    };
    if !digest(&identity["revision"]) || !digest(&identity["expectedRevision"]) {
        return Err("The browser readiness identity is invalid".into());
    }
    Ok(())
}

/// The provisioning folder as `/tmp/distill-provision` expects it: every
/// file with Linux line endings (as the pinned digests hash them), the
/// locked provider tools and the exact specs of the others.
fn stage() -> Result<Vec<u8>, String> {
    let mut tar = tar::Builder::new(Vec::new());
    let mut append = |path: &str, bytes: &[u8]| append_linux_text(&mut tar, path, bytes);
    for (name, bytes) in sandbox::FILES.iter().chain(PROVISIONING) {
        append(name, bytes)?;
    }
    let lock: Value = serde_json::from_str(ACP_TOOLS_LOCK).map_err(|error| error.to_string())?;
    for id in ["claude-acp", "codex-acp"] {
        let tool = &lock["tools"][id];
        for (file, key) in [
            ("package.json", "packageJson"),
            ("package-lock.json", "packageLock"),
        ] {
            if tool[key].is_null() {
                return Err(format!("acp-tools.lock.json has no {key} for {id}"));
            }
            let text = serde_json::to_string_pretty(&tool[key]).map_err(|e| e.to_string())?;
            append(
                &format!("tools/{id}/{file}"),
                format!("{text}\n").as_bytes(),
            )?;
        }
    }
    let sources: Value = serde_json::from_str(RUNTIME_SOURCES).map_err(|e| e.to_string())?;
    for (id, spec) in sources["tools"].as_object().into_iter().flatten() {
        let spec = spec
            .as_str()
            .ok_or_else(|| format!("runtime-sources.json names no package for {id}"))?;
        append(&format!("tools/{id}/spec"), spec.as_bytes())?;
    }
    tar.into_inner().map_err(|error| error.to_string())
}

fn append_linux_text(
    tar: &mut tar::Builder<Vec<u8>>,
    path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let bytes = linux_text(bytes);
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, path, bytes.as_slice())
        .map_err(|error| error.to_string())
}

fn linux_text(bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .enumerate()
        .filter(|(index, byte)| **byte != b'\r' || bytes.get(index + 1) != Some(&b'\n'))
        .map(|(_, byte)| *byte)
        .collect()
}

/// A printed line as the operator reads it: no terminal escapes or control
/// characters, bounded, or nothing when it is blank.
fn clean_line(raw: &str) -> Option<String> {
    let mut text = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        if c.is_control() && c != '\t' {
            continue;
        }
        text.push(c);
    }
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(LINE_CHARS).collect())
}

/// Runs `command`, feeding it `input`, and reports each line it prints;
/// fails with its last lines when it fails or outlives `timeout`.
async fn run_logged(
    reporter: &Reporter,
    what: &str,
    mut command: tokio::process::Command,
    input: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<(), String> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    super::process::apply_no_window_async(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("{what} could not start: {error}"))?;
    let stdin = child.stdin.take();
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(format!("{what} has no output"));
    };
    let tail = Mutex::new(VecDeque::new());
    let feed = async move {
        if let (Some(mut stdin), Some(bytes)) = (stdin, input) {
            // A step that stops reading has failed, and says so itself.
            let _ = stdin.write_all(&bytes).await;
            let _ = stdin.shutdown().await;
        }
    };
    let finished = tokio::time::timeout(timeout, async {
        let (_, _, _, status) = tokio::join!(
            feed,
            pump(stdout, reporter, &tail),
            pump(stderr, reporter, &tail),
            child.wait()
        );
        status
    })
    .await;
    let tail = lock(&tail).iter().cloned().collect::<Vec<_>>().join("\n");
    let tail = if tail.is_empty() {
        String::new()
    } else {
        format!(":\n{tail}")
    };
    match finished {
        Err(_) => Err(format!(
            "{what} did not finish within {} minutes{tail}",
            timeout.as_secs() / 60
        )),
        Ok(Err(error)) => Err(format!("{what} failed: {error}")),
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!(
            "{what} failed (exit code {}){tail}",
            status
                .code()
                .map_or_else(|| "none".to_owned(), |code| code.to_string())
        )),
    }
}

async fn pump(
    mut reader: impl AsyncRead + Unpin,
    reporter: &Reporter,
    tail: &Mutex<VecDeque<String>>,
) {
    let mut pending = Vec::new();
    let mut block = [0_u8; 8192];
    let flush = |pending: &mut Vec<u8>| {
        if let Some(line) = clean_line(&String::from_utf8_lossy(pending)) {
            {
                let mut tail = lock(tail);
                if tail.len() >= 12 {
                    tail.pop_front();
                }
                tail.push_back(line.clone());
            }
            reporter.line(line);
        }
        pending.clear();
    };
    loop {
        let read = match reader.read(&mut block).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        for &byte in &block[..read] {
            if byte == b'\n' || byte == b'\r' {
                flush(&mut pending);
            } else if pending.len() < 64 * 1024 {
                pending.push(byte);
            }
        }
    }
    flush(&mut pending);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn platform() -> Platform {
        Platform {
            wsl_installed: true,
            compute_service: true,
            restart_pending: false,
            hypervisor_running: true,
            firmware_virtualization: false,
        }
    }

    #[test]
    fn a_working_platform_blocks_nothing_whatever_is_pending() {
        assert_eq!(platform_blocker(&platform()), None);
        let pending = Platform {
            restart_pending: true,
            ..platform()
        };
        assert_eq!(platform_blocker(&pending), None);
    }

    #[test]
    fn each_platform_gap_names_what_the_operator_or_app_can_do() {
        let stage = |platform: Platform| platform_blocker(&platform).map(|(stage, _)| stage);
        assert_eq!(
            stage(Platform {
                wsl_installed: false,
                ..platform()
            }),
            Some(Stage::WslMissing)
        );
        // Enabled, but Windows has not restarted since.
        assert_eq!(
            stage(Platform {
                compute_service: false,
                restart_pending: true,
                ..platform()
            }),
            Some(Stage::RestartRequired)
        );
        // Never enabled: installing WSL enables it.
        assert_eq!(
            stage(Platform {
                compute_service: false,
                ..platform()
            }),
            Some(Stage::WslMissing)
        );
        // Neither a hypervisor nor firmware support: only the firmware can.
        assert_eq!(
            stage(Platform {
                hypervisor_running: false,
                firmware_virtualization: false,
                restart_pending: true,
                ..platform()
            }),
            Some(Stage::VirtualizationOff)
        );
        assert_eq!(
            stage(Platform {
                hypervisor_running: false,
                firmware_virtualization: true,
                restart_pending: true,
                ..platform()
            }),
            Some(Stage::RestartRequired)
        );
    }

    #[test]
    fn only_states_the_app_can_change_offer_an_action() {
        let action = |stage| blocked(stage, "").state().action;
        assert_eq!(action(Stage::WslMissing), Some(Action::InstallWsl));
        assert_eq!(action(Stage::NotSetUp), Some(Action::SetUp));
        assert_eq!(action(Stage::NeedsRepair), Some(Action::SetUp));
        for stage in [
            Stage::Unsupported,
            Stage::RestartRequired,
            Stage::VirtualizationOff,
            Stage::LowDisk,
            Stage::Busy,
            Stage::Unavailable,
            Stage::Ready,
        ] {
            assert_eq!(action(stage), None, "{stage:?}");
        }
    }

    #[test]
    fn repairs_escalate_and_never_repeat_without_progress() {
        use Need::*;
        assert_eq!(next_step(Create, &[]), Some(Create));
        assert_eq!(next_step(Create, &[Create]), None);
        assert_eq!(next_step(Restore, &[Restore]), None);
        assert_eq!(next_step(Provision, &[Create]), Some(Provision));
        assert_eq!(next_step(Provision, &[Create, Provision]), None);
        // The light update first; full provisioning when it was not enough.
        assert_eq!(next_step(Helpers, &[]), Some(Helpers));
        assert_eq!(next_step(Helpers, &[Helpers]), Some(Provision));
        assert_eq!(next_step(Helpers, &[Helpers, Provision]), None);
        // A receipt first; after a failed one, provisioning, then one more.
        assert_eq!(next_step(Browser, &[]), Some(Browser));
        assert_eq!(next_step(Browser, &[Browser]), Some(Provision));
        assert_eq!(next_step(Browser, &[Browser, Provision]), Some(Browser));
        assert_eq!(next_step(Browser, &[Browser, Provision, Browser]), None);
        assert_eq!(next_step(Browser, &[Create, Provision]), Some(Browser));
    }

    #[test]
    fn printed_lines_lose_escapes_and_control_characters() {
        assert_eq!(
            clean_line("\u{1b}[32mprovision: tool zai\u{1b}[0m\0"),
            Some("provision: tool zai".into())
        );
        assert_eq!(clean_line("  \u{7}  "), None);
        assert_eq!(
            clean_line(&"x".repeat(1000)).map(|line| line.len()),
            Some(LINE_CHARS)
        );
    }

    #[test]
    fn the_staged_folder_holds_every_input_with_linux_line_endings() {
        let bytes = stage().unwrap();
        let mut archive = tar::Archive::new(bytes.as_slice());
        let mut entries = std::collections::BTreeMap::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().to_string_lossy().into_owned();
            let mut contents = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut contents).unwrap();
            assert!(!contents.windows(2).any(|pair| pair == b"\r\n"), "{path}");
            entries.insert(path, contents);
        }
        for (name, _) in sandbox::FILES.iter().chain(PROVISIONING) {
            assert!(entries.contains_key(*name), "{name} is staged");
        }
        for path in [
            "tools/claude-acp/package.json",
            "tools/claude-acp/package-lock.json",
            "tools/codex-acp/package.json",
            "tools/codex-acp/package-lock.json",
        ] {
            let json: Value = serde_json::from_slice(&entries[path]).unwrap();
            assert!(json.is_object(), "{path}");
        }
        assert_eq!(
            entries["tools/zai/spec"],
            b"opencode-linux-x64@1.18.35".to_vec()
        );
        // Every helper the identity pins reaches the sandbox as pinned.
        for (name, bytes) in sandbox::FILES {
            assert_eq!(entries[*name], linux_text(bytes), "{name}");
        }
    }
}
