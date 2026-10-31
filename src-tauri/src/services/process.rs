//! Generic process helpers.

/// Suppress the console window a GUI-subsystem parent would otherwise allocate
/// when spawning a console-subsystem child. Redirecting or piping stdio does
/// not prevent that flash on Windows; `CREATE_NO_WINDOW` does.
pub(crate) fn apply_no_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Tokio equivalent of [`apply_no_window`]. Keep both entry points here so
/// synchronous and asynchronous subprocesses follow the same policy.
pub(crate) fn apply_no_window_async(command: &mut tokio::process::Command) {
    apply_no_window(command.as_std_mut());
}

/// `name` in the Windows system folder, so neither the working folder nor
/// PATH picks the program; the bare name when that folder lacks it.
#[cfg(windows)]
pub(crate) fn system_program(name: &str) -> std::path::PathBuf {
    std::env::var_os("SystemRoot")
        .map(|root| std::path::PathBuf::from(root).join("System32").join(name))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| name.into())
}

/// A program Windows started the way a person starting it would, in a
/// window of its own (`ShellExecuteExW`): a console program gets a new
/// console the operator reads and types in, which this process never sees,
/// and the `runas` verb asks for administrator permission first.
#[cfg(windows)]
pub(crate) struct ShellProcess(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a process handle is a kernel object handle, usable from any thread.
#[cfg(windows)]
unsafe impl Send for ShellProcess {}

#[cfg(windows)]
impl ShellProcess {
    /// Starts `program` with `parameters` exactly as given. `Ok(None)` when
    /// Windows started it without a process to follow; the error carries
    /// the Windows error code (`ERROR_CANCELLED` when the operator declined
    /// the permission `runas` asked for).
    pub(crate) fn start(
        verb: &str,
        program: &std::path::Path,
        parameters: &str,
        directory: Option<&std::path::Path>,
    ) -> std::io::Result<Option<Self>> {
        use windows_sys::Win32::{
            Foundation::GetLastError,
            UI::{
                Shell::{
                    ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
                },
                WindowsAndMessaging::SW_SHOWNORMAL,
            },
        };
        let wide = |text: &std::ffi::OsStr| {
            use std::os::windows::ffi::OsStrExt;
            text.encode_wide().chain(Some(0)).collect::<Vec<u16>>()
        };
        let verb = wide(verb.as_ref());
        let file = wide(program.as_os_str());
        let parameters = wide(parameters.as_ref());
        let directory = directory.map(|directory| wide(directory.as_os_str()));
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = parameters.as_ptr();
        if let Some(directory) = &directory {
            info.lpDirectory = directory.as_ptr();
        }
        info.nShow = SW_SHOWNORMAL;
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            return Err(std::io::Error::from_raw_os_error(
                unsafe { GetLastError() } as i32
            ));
        }
        Ok((!info.hProcess.is_null()).then_some(Self(info.hProcess)))
    }

    /// Waits until it ends, then its exit code, when Windows reports one.
    pub(crate) fn wait(self) -> Option<u32> {
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, WaitForSingleObject, INFINITE,
        };
        let mut code = 0_u32;
        let read = unsafe {
            WaitForSingleObject(self.0, INFINITE);
            GetExitCodeProcess(self.0, &mut code)
        };
        (read != 0).then_some(code)
    }
}

#[cfg(windows)]
impl Drop for ShellProcess {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// A child process together with everything it goes on to start, so the whole
/// tree can be ended at once — and is, by the OS, if this process dies first.
///
/// Windows kills no process tree on its own: killing a child leaves its own
/// children running, and a parent that is killed (a `tauri dev` relaunch, Task
/// Manager, a crash) runs no cleanup at all. A Job Object with
/// `KILL_ON_JOB_CLOSE` covers both. Its only handle lives here, so dropping
/// this — or the process holding it going away however it goes — ends every
/// process in it.
///
/// A descendant started before [`ProcessTree::contain`] returns is not in the
/// job. The caller contains a child right after spawning it, well before the
/// child has got as far as starting anything.
///
/// A descendant that asks to break away (`CREATE_BREAKAWAY_FROM_JOB`) is let
/// go: that flag is how a program says the thing it starts is meant to outlive
/// it, and refusing it fails the launch instead.
pub(crate) struct ProcessTree {
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

// SAFETY: a job handle is a kernel object handle, usable from any thread.
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
unsafe impl Sync for ProcessTree {}

impl ProcessTree {
    /// Put `child` in a job of its own. `None` when the OS refuses — the child
    /// then runs as it always did, outside any job.
    #[cfg(windows)]
    pub(crate) fn contain(child: &tokio::process::Child) -> Option<Self> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let process = child.raw_handle()?;
        // SAFETY: null attributes and name ask for an anonymous job whose
        // handle no child inherits.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return None;
        }
        // Owns the handle from here on, so every early return closes it.
        let tree = Self { job };
        // SAFETY: all-zero is a valid "no limits" value for this plain struct.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        // SAFETY: `limits` is the struct the information class names, passed
        // with its own size; `process` stays valid while `child` is borrowed.
        let contained = unsafe {
            SetInformationJobObject(
                tree.job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
                && AssignProcessToJobObject(tree.job, process.cast()) != 0
        };
        contained.then_some(tree)
    }

    #[cfg(not(windows))]
    pub(crate) fn contain(_child: &tokio::process::Child) -> Option<Self> {
        // Job Objects are a Windows facility, and Windows is what Flock ships on.
        None
    }

    /// End every process in the tree now.
    pub(crate) fn kill(&self) {
        #[cfg(windows)]
        // SAFETY: `job` is the live handle this value owns.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        // SAFETY: `job` is the live handle this value owns, closed exactly once.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[cfg(unix)]
pub(crate) type ProcessId = libc::pid_t;
#[cfg(windows)]
pub(crate) type ProcessId = u32;

pub(crate) fn pid_t_from_u32(pid: u32) -> Option<ProcessId> {
    platform_pid_from_u32(pid)
}

#[cfg(unix)]
fn platform_pid_from_u32(pid: u32) -> Option<ProcessId> {
    pid.try_into().ok()
}

#[cfg(windows)]
fn platform_pid_from_u32(pid: u32) -> Option<ProcessId> {
    Some(pid)
}

#[cfg(unix)]
pub(crate) fn process_is_alive(pid: ProcessId) -> bool {
    // SAFETY: sending signal 0 to check process existence.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }

    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
pub(crate) fn process_is_alive(pid: ProcessId) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system.process(pid).is_some()
}

/// How many running processes have one of `names` (an executable's file
/// name, such as `grok.exe`; any case) as their name.
pub(crate) fn count_processes_named(names: &[&str]) -> usize {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    system
        .processes()
        .values()
        .filter(|process| {
            let name = process.name().to_string_lossy();
            names.iter().any(|wanted| name.eq_ignore_ascii_case(wanted))
        })
        .count()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn processes_are_counted_by_name() {
        assert_eq!(count_processes_named(&["no-such-process-invented.exe"]), 0);
        let own = std::env::current_exe().unwrap();
        let own = own.file_name().unwrap().to_string_lossy().to_uppercase();
        assert!(count_processes_named(&[own.as_str()]) >= 1);
    }

    const CONSOLE_WINDOW_PROBE: &str = r#"
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }';
        if ([ConsoleProbe]::GetConsoleWindow() -ne [IntPtr]::Zero) { exit 7 }
    "#;

    #[test]
    fn std_background_command_has_no_console_window() {
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            CONSOLE_WINDOW_PROBE,
        ]);
        apply_no_window(&mut command);

        let output = command.output().expect("run console-window probe");
        assert!(
            output.status.success(),
            "background child had a console window: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Starts a grandchild that outlives any direct kill, prints its pid, and
    /// waits.
    const GRANDCHILD_PROBE: &str = r#"
        $grandchild = Start-Process -PassThru -WindowStyle Hidden powershell.exe -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep 120'
        [Console]::Out.WriteLine($grandchild.Id)
        Start-Sleep 120
    "#;

    async fn wait_until_gone(pid: ProcessId) -> bool {
        for _ in 0..50 {
            if !process_is_alive(pid) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        false
    }

    #[tokio::test]
    async fn killing_a_contained_tree_ends_the_grandchild_too() {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                GRANDCHILD_PROBE,
            ])
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true);
        apply_no_window_async(&mut command);
        let mut child = command.spawn().expect("spawn the probe");
        let tree = ProcessTree::contain(&child).expect("contain the probe in a job");

        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("probe stdout"))
            .read_line(&mut line)
            .await
            .expect("read the grandchild pid");
        let grandchild: ProcessId = line.trim().parse().expect("a pid");
        assert!(process_is_alive(grandchild));

        tree.kill();
        assert!(
            wait_until_gone(grandchild).await,
            "the grandchild outlived its tree"
        );
    }

    #[tokio::test]
    async fn async_background_command_has_no_console_window() {
        let mut command = tokio::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            CONSOLE_WINDOW_PROBE,
        ]);
        apply_no_window_async(&mut command);

        let output = command.output().await.expect("run console-window probe");
        assert!(
            output.status.success(),
            "background child had a console window: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
