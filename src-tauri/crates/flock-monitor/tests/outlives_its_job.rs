//! A monitor started from inside a job that kills its members when it closes
//! outlives that job. Every agent's shell under Flock runs in such a job, and
//! Flock closing it is what an app restart or update does to it.
#![cfg(windows)]

use std::fs::{self, File};
use std::mem::{size_of, zeroed};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
    PROCESSENTRY32W, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, OpenThread, ResumeThread, PROCESS_QUERY_LIMITED_INFORMATION,
    THREAD_SUSPEND_RESUME,
};

const CREATE_SUSPENDED: u32 = 0x0000_0004;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SESSION: &str = "breakaway-check";
const STATE_KEY: &str = "breakaway";

struct Job(HANDLE);

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// The job Flock keeps an agent bridge in: everything in it dies when the
/// last handle closes, and a child may ask to leave it.
fn agent_bridge_job() -> Job {
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    assert!(!job.is_null(), "create a job");
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    assert_ne!(configured, 0, "configure the job");
    Job(job)
}

fn resume(pid: u32) {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    assert_ne!(snapshot, INVALID_HANDLE_VALUE, "snapshot threads");
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut found = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while found && entry.th32OwnerProcessID != pid {
        found = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    assert!(found, "find the suspended launcher's thread");
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
    assert!(!thread.is_null(), "open the launcher's thread");
    let resumed = unsafe { ResumeThread(thread) };
    unsafe {
        CloseHandle(thread);
    }
    assert_ne!(resumed, u32::MAX, "resume the launcher");
}

fn alive(pid: u32) -> bool {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return false;
    }
    let mut code = 0u32;
    let read = unsafe { GetExitCodeProcess(process, &mut code) } != 0;
    unsafe {
        CloseHandle(process);
    }
    read && code == STILL_ACTIVE as u32
}

/// The first process whose parent is `parent`, waiting for it to appear.
fn child_of(parent: u32, within: Duration) -> Option<u32> {
    let deadline = Instant::now() + within;
    loop {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        assert_ne!(snapshot, INVALID_HANDLE_VALUE, "snapshot processes");
        let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut found = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        let mut child = None;
        while found {
            if entry.th32ParentProcessID == parent {
                child = Some(entry.th32ProcessID);
                break;
            }
            found = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe {
            CloseHandle(snapshot);
        }
        if child.is_some() || Instant::now() >= deadline {
            return child;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn wait_until_gone(pid: u32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    !alive(pid)
}

fn monitor(state: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_flock-monitor"));
    command
        .env("DISTILL_MONITOR_STATE_DIR", state)
        .env_remove("DISTILL_MONITOR_FOREGROUND")
        .env_remove("DISTILL_MONITOR_LAUNCH_TOKEN")
        .env_remove("FLOCKCTL_LOCK")
        .stdin(Stdio::null());
    command
}

#[test]
fn a_monitor_outlives_the_job_its_launcher_ran_in() {
    let state = std::env::temp_dir().join(format!(
        "flock-monitor-breakaway-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&state).unwrap();
    // Files, not pipes: the detached monitor inherits the launcher's handles,
    // and a pipe it holds open would never reach end of file.
    let stdout_path = state.join("launcher.out");
    let stderr_path = state.join("launcher.err");

    let job = agent_bridge_job();
    let mut launcher = monitor(&state)
        .args([
            "run",
            "--session-id",
            SESSION,
            "--state-key",
            STATE_KEY,
            "--label",
            "breakaway check",
            "--silence-minutes",
            "0",
            "--",
            "cmd.exe",
            "/d",
            "/c",
            "ping -n 120 127.0.0.1 >nul",
        ])
        .stdout(File::create(&stdout_path).unwrap())
        .stderr(File::create(&stderr_path).unwrap())
        // Suspended until it is in the job, so nothing it starts escapes the
        // job by starting first.
        .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
        .spawn()
        .expect("start the launcher");
    let assigned = unsafe { AssignProcessToJobObject(job.0, launcher.as_raw_handle().cast()) };
    assert_ne!(assigned, 0, "put the launcher in the job");
    resume(launcher.id());
    let status = launcher.wait().expect("wait for the launcher");
    let stdout = fs::read_to_string(&stdout_path).unwrap();
    let stderr = fs::read_to_string(&stderr_path).unwrap();
    assert!(status.success(), "launcher failed: {stderr}");
    let monitor_pid: u32 = stdout
        .split_whitespace()
        .next()
        .and_then(|pid| pid.parse().ok())
        .unwrap_or_else(|| panic!("launcher printed no monitor pid: {stdout:?}"));
    assert!(alive(monitor_pid), "the monitor is running");
    let producer_pid =
        child_of(monitor_pid, Duration::from_secs(10)).expect("the monitor started its producer");

    // What Flock exiting does to its agent bridges' jobs.
    drop(job);
    thread::sleep(Duration::from_secs(1));
    if stderr.contains("does not let it leave") {
        // A job around this test runner refuses breakaway, so the monitor
        // was started inside it, said so, and ends with it.
        assert!(
            wait_until_gone(monitor_pid, Duration::from_secs(10)),
            "a monitor that could not leave outlived the job"
        );
    } else {
        assert!(
            alive(monitor_pid),
            "the monitor died with the job it was started in"
        );
        assert!(
            alive(producer_pid),
            "the producer died with the job its monitor was started in"
        );
        let stopped = monitor(&state)
            .args(["stop", "--session-id", SESSION, "--state-key", STATE_KEY])
            .stdout(Stdio::null())
            .status()
            .expect("run flock-monitor stop");
        assert!(stopped.success(), "flock-monitor stop failed");
        assert!(
            wait_until_gone(monitor_pid, Duration::from_secs(30)),
            "the monitor did not stop"
        );
        assert!(
            wait_until_gone(producer_pid, Duration::from_secs(10)),
            "stopping the monitor left its producer running"
        );
    }
    let _ = fs::remove_dir_all(&state);
}
