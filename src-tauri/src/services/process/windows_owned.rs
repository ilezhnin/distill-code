//! Explicit Windows lowbox launch with verified LPAC, exact stdio and a strict Job.
//!
//! This primitive does not certify an ordinary provider/tool contract. Its first
//! policy grants no network capabilities and only freshly staged owned paths.
//! The caller must keep using the host's existing protocol/receipt consumers.

#[path = "windows_owned/security.rs"]
mod security;
#[cfg(test)]
#[path = "windows_owned/tests.rs"]
mod tests;

use std::ffi::{OsStr, OsString};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};

use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use uuid::Uuid;
use windows_sys::Win32::Foundation::{
    GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::{SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use security::{Capabilities, Profile, ProtectedPaths};
pub(crate) use security::{OwnedWindowsStaging, WindowsSecurityFacts};

/// Node inside a lowbox cannot read the attributes of the drive root or any
/// other ancestor it was not granted, and a medium-integrity user cannot add
/// that grant to `C:\` or `E:\` without elevation. Node's module loader and
/// its JavaScript `realpath` walk every ancestor; the native `realpath` asks
/// the kernel for the opened file's final path and needs no ancestor access.
const NODE_REALPATH_PRELOAD: &str = r#"'use strict';
// Distill protected launch: fall back to the kernel's final path when the
// ancestor walk is denied. Every other error is reported unchanged.
const fs = require('fs');
const walkSync = fs.realpathSync;
const nativeSync = fs.realpathSync.native;
function realpathSync(path, options) {
  try { return walkSync(path, options); } catch (error) {
    if (error && error.code === 'EPERM') return nativeSync(path, options);
    throw error;
  }
}
realpathSync.native = nativeSync;
fs.realpathSync = realpathSync;
const walk = fs.realpath;
const native = fs.realpath.native;
function realpath(path, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  walk(path, options, (error, resolved) => error && error.code === 'EPERM'
    ? native(path, options, callback) : callback(error, resolved));
}
realpath.native = native;
fs.realpath = realpath;
"#;

/// Stage the Node preload into the read-only runtime and return the
/// `NODE_OPTIONS` entry that loads it. Descendants inherit the variable.
pub(crate) fn stage_node_runtime(
    staging: &OwnedWindowsStaging,
) -> io::Result<(OsString, OsString)> {
    let preload = staging.runtime().join("distill-lowbox-node.cjs");
    std::fs::write(&preload, NODE_REALPATH_PRELOAD)?;
    // NODE_OPTIONS treats a backslash inside quotes as an escape.
    let path = preload.to_string_lossy().replace('\\', "/");
    if path.contains('"') {
        return Err(io::Error::other("Node preload path cannot be quoted"));
    }
    Ok((
        "NODE_OPTIONS".into(),
        format!("--preserve-symlinks --preserve-symlinks-main --require \"{path}\"").into(),
    ))
}

const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT: u32 = 1;

pub(crate) struct OwnedWindowsPlan {
    pub staging: OwnedWindowsStaging,
    /// Must be a real executable inside `staging.runtime()`; never a shell alias.
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// A cleared environment. HOME/USERPROFILE/APPDATA/TEMP/TMP are enforced below.
    pub environment: Vec<(OsString, OsString)>,
    /// Named capabilities from `ALLOWED_CAPABILITIES`; the child token must
    /// carry exactly these.
    pub capabilities: Vec<&'static str>,
}

pub(crate) struct OwnedWindowsSpawn {
    pub child: OwnedWindowsChild,
    pub stdin: NamedPipeServer,
    pub stdout: NamedPipeServer,
    pub stderr: NamedPipeServer,
}

/// Kernel process/Job ownership independent of Tokio's nonconstructible Child.
/// Stdio is IOCP-backed and can feed the existing Bridge's AsyncRead/Write loops.
pub(crate) struct OwnedWindowsChild {
    process: OwnedHandle,
    job: Option<StrictJob>,
    paths: Option<ProtectedPaths>,
    profile: Option<Profile>,
    /// The exact capabilities granted; descendants are verified against them.
    granted: Capabilities,
    pid: u32,
    pub security: WindowsSecurityFacts,
}

impl OwnedWindowsChild {
    pub(crate) fn id(&self) -> u32 {
        self.pid
    }

    pub(crate) fn start_kill(&mut self) -> io::Result<()> {
        self.job.as_ref().map_or(Ok(()), StrictJob::kill)
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        // SAFETY: the process handle remains owned for the whole call.
        match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                // SAFETY: `code` is writable and the process has signalled exit.
                win32(
                    unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) },
                    "read protected process exit",
                )?;
                Ok(Some(ExitStatus::from_raw(code)))
            }
            _ => Err(last_error("wait for protected process")),
        }
    }

    pub(crate) async fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Cancel the entire job and revoke/restore only this attempt's grants.
    /// An uncertain cleanup is returned; its staged files must then be retained.
    pub(crate) fn close(mut self) -> io::Result<()> {
        self.cleanup()
    }

    fn cleanup(&mut self) -> io::Result<()> {
        if let Some(job) = &self.job {
            job.kill()?;
            job.wait_empty(CLEANUP_TIMEOUT)?;
        }
        // Closing the sole Job handle also kills descendants if the host dies.
        self.job.take();
        if let Some(paths) = &mut self.paths {
            paths.restore()?;
        }
        self.paths.take();
        if let Some(profile) = &mut self.profile {
            profile.delete()?;
        }
        self.profile.take();
        Ok(())
    }
}

impl Drop for OwnedWindowsChild {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            log::warn!(
                "Protected Windows cleanup is unresolved for {}: {error}",
                self.pid
            );
        }
    }
}

pub(crate) async fn spawn(plan: OwnedWindowsPlan) -> io::Result<OwnedWindowsSpawn> {
    let program = plan.staging.validate_program(&plan.program)?;
    let mut command = command_line(&program, &plan.args)?;
    let mut control_command = command.clone();
    let environment = environment_block(&plan.environment, &plan.staging)?;
    let cwd = wide(plan.staging.workspace().as_os_str())?;
    let application = wide(program.as_os_str())?;
    // Derived before any OS mutation: an unknown capability refuses here.
    let granted = Capabilities::derive(&plan.capabilities)?;
    let mut profile = Profile::create(plan.staging.id())?;
    let mut paths = ProtectedPaths::grant(&plan.staging, &profile)?;
    let (stdin, stdin_child) = stdio_pipe(plan.staging.id(), "stdin", false).await?;
    let (stdout, stdout_child) = stdio_pipe(plan.staging.id(), "stdout", true).await?;
    let (stderr, stderr_child) = stdio_pipe(plan.staging.id(), "stderr", true).await?;
    let inherited = [
        stdin_child.as_raw_handle(),
        stdout_child.as_raw_handle(),
        stderr_child.as_raw_handle(),
    ];
    let mut capability_list = granted.attributes();
    let mut capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid(),
        Capabilities: if capability_list.is_empty() {
            null_mut()
        } else {
            capability_list.as_mut_ptr()
        },
        CapabilityCount: capability_list.len() as u32,
        Reserved: 0,
    };
    let mut package_policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    let mut attributes = Attributes::new(3)?;
    attributes.set(
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        &mut capabilities,
    )?;
    attributes.set(
        PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
        &mut package_policy,
    )?;
    attributes.set_slice(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &inherited)?;
    // SAFETY: zero initialization is valid before setting cb, stdio and attributes.
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
    startup.lpAttributeList = attributes.pointer();
    let job = StrictJob::create()?;
    let suspended = create_suspended(&application, &mut command, &environment, &cwd, &startup)?;
    job.assign(&suspended.process)?;
    job.verify(&suspended.process)?;
    // A separate ordinary AppContainer is diagnostic only and never resumes.
    // It uses the same SID/capability/stdio setup but omits the opt-out attribute.
    // Both access checks must establish the expected difference before execution.
    let mut control_attributes = Attributes::new(2)?;
    control_attributes.set(
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        &mut capabilities,
    )?;
    control_attributes.set_slice(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &inherited)?;
    let mut control_startup = startup;
    control_startup.lpAttributeList = control_attributes.pointer();
    let control = create_suspended(
        &application,
        &mut control_command,
        &environment,
        &cwd,
        &control_startup,
    )?;
    job.assign(&control.process)?;
    job.verify(&control.process)?;
    profile.verify_ordinary_control(&control.process, paths.canary(), &granted)?;
    control.stop()?;
    let security = profile.verify_child(&suspended.process, paths.canary(), &granted)?;
    paths.verify()?;
    job.verify(&suspended.process)?;
    paths.release_writable_children();
    // SAFETY: the thread is suspended exactly once by CreateProcessW. Its token,
    // stdio, path grants and non-breakaway Job have all been checked before resume.
    let prior = unsafe { ResumeThread(suspended.thread.as_raw_handle()) };
    if prior == u32::MAX {
        return Err(last_error("resume verified protected process"));
    }
    if prior != 1 {
        return Err(io::Error::other(format!(
            "Protected resume had unexpected suspension count {prior}"
        )));
    }
    let pid = suspended.pid;
    let process = suspended.into_process();
    // Parent never keeps copies of the inherited child ends; EOF follows real exit.
    drop((
        stdin_child,
        stdout_child,
        stderr_child,
        attributes,
        control_attributes,
        capability_list,
    ));
    profile.mark_launched();
    Ok(OwnedWindowsSpawn {
        child: OwnedWindowsChild {
            process,
            job: Some(job),
            paths: Some(paths),
            profile: Some(profile),
            granted,
            pid,
            security,
        },
        stdin,
        stdout,
        stderr,
    })
}

fn create_suspended(
    application: &[u16],
    command: &mut [u16],
    environment: &[u16],
    cwd: &[u16],
    startup: &STARTUPINFOEXW,
) -> io::Result<SuspendedProcess> {
    // SAFETY: pointers reference live, NUL-terminated, owned buffers. Attributes
    // carry only the exact three inheritable child pipe ends. No parent handles
    // or environment are implicitly inherited. The first instruction is suspended.
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    win32(
        unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED
                    | CREATE_NO_WINDOW
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                environment.as_ptr().cast(),
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            )
        },
        "create suspended protected process",
    )?;
    SuspendedProcess::new(info)
}

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut result: Vec<_> = value.encode_wide().collect();
    if result.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Embedded NUL in Windows launch input",
        ));
    }
    result.push(0);
    Ok(result)
}

fn command_line(program: &Path, args: &[OsString]) -> io::Result<Vec<u16>> {
    if args.len() > 512 {
        return Err(io::Error::other("Too many protected process arguments"));
    }
    let mut encoded = Vec::new();
    for value in std::iter::once(program.as_os_str()).chain(args.iter().map(OsString::as_os_str)) {
        if !encoded.is_empty() {
            encoded.push(b' ' as u16);
        }
        let units = wide(value)?;
        encoded.push(b'"' as u16);
        let mut slashes = 0;
        for &unit in &units[..units.len() - 1] {
            if unit == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            encoded.extend(std::iter::repeat_n(
                b'\\' as u16,
                if unit == b'"' as u16 {
                    slashes * 2 + 1
                } else {
                    slashes
                },
            ));
            slashes = 0;
            encoded.push(unit);
        }
        encoded.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        encoded.push(b'"' as u16);
    }
    encoded.push(0);
    if encoded.len() > 32767 {
        return Err(io::Error::other(
            "Protected Windows command line exceeds 32767 UTF-16 units",
        ));
    }
    Ok(encoded)
}

fn environment_block(
    input: &[(OsString, OsString)],
    staging: &OwnedWindowsStaging,
) -> io::Result<Vec<u16>> {
    if input.len() > 256 {
        return Err(io::Error::other("Too many protected environment entries"));
    }
    let mut values = std::collections::BTreeMap::new();
    for (key, value) in input {
        let text = key
            .to_str()
            .ok_or_else(|| io::Error::other("Environment keys must be valid Unicode"))?;
        if text.is_empty()
            || !text.is_ascii()
            || text.contains(['=', '\0'])
            || text.starts_with('=')
        {
            return Err(io::Error::other("Invalid protected environment key"));
        }
        wide(value)?;
        let canonical = text.to_ascii_uppercase();
        if values.insert(canonical, value.clone()).is_some() {
            return Err(io::Error::other("Duplicate protected environment key"));
        }
    }
    for key in ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
        values.insert(key.into(), staging.home().as_os_str().to_owned());
    }
    for key in ["TEMP", "TMP"] {
        values.insert(key.into(), staging.temp().as_os_str().to_owned());
    }
    let mut block = Vec::new();
    for (key, value) in values {
        let pair = OsString::from(format!("{key}="));
        block.extend(pair.encode_wide());
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    if block.len() > 32767 {
        return Err(io::Error::other(
            "Protected environment exceeds 32767 UTF-16 units",
        ));
    }
    Ok(block)
}

async fn stdio_pipe(
    id: Uuid,
    suffix: &str,
    parent_reads: bool,
) -> io::Result<(NamedPipeServer, OwnedHandle)> {
    let name = format!(r"\\.\pipe\LOCAL\Distill.Owned.{}.{}", id.simple(), suffix);
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(true)
        .max_instances(1)
        .reject_remote_clients(true)
        .access_inbound(parent_reads)
        .access_outbound(!parent_reads);
    // The pipe name is private to this host token. Lowbox children use only the
    // inherited handles and receive no permission to reopen the pipe by name.
    let server = options.create(&name)?;
    let name = wide(OsStr::new(&name))?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    // SAFETY: host opens its newly created local pipe synchronously; only this
    // child end is inheritable, and HANDLE_LIST excludes every other handle.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            if parent_reads {
                GENERIC_WRITE
            } else {
                GENERIC_READ
            },
            0,
            &attributes,
            OPEN_EXISTING,
            0,
            null_mut(),
        )
    };
    let child = owned_handle(handle, "open protected child stdio")?;
    tokio::time::timeout(Duration::from_secs(2), server.connect())
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Connect protected stdio pipe"))??;
    Ok((server, child))
}

struct Attributes {
    storage: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    fn new(count: u32) -> io::Result<Self> {
        let mut bytes = 0;
        // SAFETY: documented size query has a null list and writable size.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 65536 {
            return Err(io::Error::other("Unknown Windows attribute-list size"));
        }
        let mut result = Self {
            storage: vec![0; bytes.div_ceil(std::mem::size_of::<usize>())],
            initialized: false,
        };
        win32(
            unsafe { InitializeProcThreadAttributeList(result.pointer(), count, 0, &mut bytes) },
            "initialize protected attributes",
        )?;
        result.initialized = true;
        Ok(result)
    }
    fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
    fn set<T>(&mut self, attribute: u32, value: &mut T) -> io::Result<()> {
        win32(
            unsafe {
                UpdateProcThreadAttribute(
                    self.pointer(),
                    0,
                    attribute as usize,
                    std::ptr::from_mut(value).cast(),
                    std::mem::size_of::<T>(),
                    null_mut(),
                    null_mut(),
                )
            },
            "set protected process attribute",
        )
    }
    fn set_slice<T>(&mut self, attribute: u32, value: &[T]) -> io::Result<()> {
        win32(
            unsafe {
                UpdateProcThreadAttribute(
                    self.pointer(),
                    0,
                    attribute as usize,
                    value.as_ptr().cast_mut().cast(),
                    std::mem::size_of_val(value),
                    null_mut(),
                    null_mut(),
                )
            },
            "set exact inherited handles",
        )
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.pointer());
            }
        }
    }
}

struct SuspendedProcess {
    process: Option<OwnedHandle>,
    thread: OwnedHandle,
    pid: u32,
}
impl SuspendedProcess {
    fn new(info: PROCESS_INFORMATION) -> io::Result<Self> {
        let process = owned_handle(info.hProcess, "own protected process handle")?;
        let thread = match owned_handle(info.hThread, "own protected thread handle") {
            Ok(thread) => thread,
            Err(error) => {
                unsafe {
                    TerminateProcess(process.as_raw_handle(), 1);
                    WaitForSingleObject(
                        process.as_raw_handle(),
                        CLEANUP_TIMEOUT.as_millis() as u32,
                    );
                }
                return Err(error);
            }
        };
        Ok(Self {
            process: Some(process),
            thread,
            pid: info.dwProcessId,
        })
    }
    fn into_process(mut self) -> OwnedHandle {
        self.process.take().expect("suspended process owned")
    }
    fn stop(mut self) -> io::Result<()> {
        if let Some(process) = &self.process {
            win32(
                unsafe { TerminateProcess(process.as_raw_handle(), 1) },
                "stop suspended diagnostic control",
            )?;
            if unsafe {
                WaitForSingleObject(process.as_raw_handle(), CLEANUP_TIMEOUT.as_millis() as u32)
            } != WAIT_OBJECT_0
            {
                return Err(io::Error::other("Suspended diagnostic cleanup unresolved"));
            }
        }
        self.process.take();
        Ok(())
    }
}
impl Drop for SuspendedProcess {
    fn drop(&mut self) {
        if let Some(process) = &self.process {
            // No unverified child ever executes, even if assignment/token setup fails.
            unsafe {
                TerminateProcess(process.as_raw_handle(), 1);
                WaitForSingleObject(process.as_raw_handle(), CLEANUP_TIMEOUT.as_millis() as u32);
            }
        }
    }
}

struct StrictJob {
    handle: OwnedHandle,
}
impl StrictJob {
    fn create() -> io::Result<Self> {
        let handle = owned_handle(
            unsafe { CreateJobObjectW(null(), null()) },
            "create strict protected Job",
        )?;
        let result = Self { handle };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit = 64;
        win32(
            unsafe {
                SetInformationJobObject(
                    result.handle.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&limits).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            },
            "set strict protected Job limits",
        )?;
        Ok(result)
    }
    fn assign(&self, process: &Option<OwnedHandle>) -> io::Result<()> {
        let handle = process
            .as_ref()
            .ok_or_else(|| io::Error::other("Missing suspended process"))?;
        win32(
            unsafe {
                AssignProcessToJobObject(self.handle.as_raw_handle(), handle.as_raw_handle())
            },
            "assign suspended process to strict Job",
        )
    }
    fn verify(&self, process: &Option<OwnedHandle>) -> io::Result<()> {
        let process = process
            .as_ref()
            .ok_or_else(|| io::Error::other("Missing protected process"))?;
        let mut member = 0;
        win32(
            unsafe {
                IsProcessInJob(
                    process.as_raw_handle(),
                    self.handle.as_raw_handle(),
                    &mut member,
                )
            },
            "verify strict Job membership",
        )?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        win32(
            unsafe {
                QueryInformationJobObject(
                    self.handle.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_mut(&mut limits).cast(),
                    std::mem::size_of_val(&limits) as u32,
                    null_mut(),
                )
            },
            "verify strict Job limits",
        )?;
        let flags = limits.BasicLimitInformation.LimitFlags;
        if member == 0
            || flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0
            || flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) != 0
        {
            return Err(io::Error::other(
                "Protected Job is not strict and non-breakaway",
            ));
        }
        Ok(())
    }
    fn kill(&self) -> io::Result<()> {
        win32(
            unsafe { TerminateJobObject(self.handle.as_raw_handle(), 1) },
            "terminate protected Job",
        )
    }
    fn wait_empty(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            win32(
                unsafe {
                    QueryInformationJobObject(
                        self.handle.as_raw_handle(),
                        JobObjectBasicAccountingInformation,
                        std::ptr::from_mut(&mut info).cast(),
                        std::mem::size_of_val(&info) as u32,
                        null_mut(),
                    )
                },
                "wait for protected descendants",
            )?;
            if info.ActiveProcesses == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Protected Job cleanup remains unresolved",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn owned_handle(handle: HANDLE, operation: &str) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(last_error(operation));
    }
    // SAFETY: caller transfers a newly returned unique owning Win32 handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}
fn win32(value: i32, operation: &str) -> io::Result<()> {
    if value == 0 {
        Err(last_error(operation))
    } else {
        Ok(())
    }
}
fn last_error(operation: &str) -> io::Error {
    let error = io::Error::last_os_error();
    io::Error::new(error.kind(), format!("{operation}: {error}"))
}
