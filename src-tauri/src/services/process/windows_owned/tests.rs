//! Real Windows probes. Profile/ACL mutations require an explicit private QA root.

use super::*;
use std::fs;
use std::os::windows::process::CommandExt;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};
use windows_sys::Win32::UI::Shell::CommandLineToArgvW;

#[test]
fn windows_arguments_roundtrip_through_the_native_parser() {
    let arguments = [
        "",
        "plain",
        "with space",
        "quote\"inside",
        "trailing\\",
        "\\\"",
        "λ🌱",
    ];
    let command = command_line(
        Path::new(r"C:\Public Runtime\node.exe"),
        &arguments.map(OsString::from),
    )
    .unwrap();
    let mut count = 0;
    // Only parses an invented command line; no process or security profile.
    let argv = unsafe { CommandLineToArgvW(command.as_ptr(), &mut count) };
    assert!(!argv.is_null());
    let actual: Vec<_> = (1..count as usize)
        .map(|index| {
            let value = unsafe { *argv.add(index) };
            let mut length = 0;
            while unsafe { *value.add(length) } != 0 {
                length += 1;
            }
            String::from_utf16(unsafe { std::slice::from_raw_parts(value, length) }).unwrap()
        })
        .collect();
    unsafe {
        LocalFree(argv.cast());
    }
    assert_eq!(actual, arguments);
}

#[test]
fn unknown_or_repeated_capabilities_refuse_before_any_os_mutation() {
    for requested in [
        vec!["internetClient"],
        vec!["registryRead", "registryRead"],
        vec!["privateNetworkClientServer"],
    ] {
        assert!(security::Capabilities::derive(&requested).is_err());
    }
}

#[test]
fn invalid_launch_arguments_refuse_before_any_os_mutation() {
    assert!(command_line(
        Path::new(r"C:\Public Runtime\node.exe"),
        &[OsString::from("bad\0argument")]
    )
    .is_err());
    assert!(command_line(
        Path::new(r"C:\Public Runtime\node.exe"),
        &vec![OsString::from("x"); 513]
    )
    .is_err());
    assert!(command_line(
        Path::new(r"C:\Public Runtime\node.exe"),
        &[OsString::from("x".repeat(32768))]
    )
    .is_err());
}

struct Probe {
    run: PathBuf,
    staging: Option<OwnedWindowsStaging>,
    private: PathBuf,
    sibling: PathBuf,
}
impl Probe {
    fn create() -> io::Result<Self> {
        struct ProbeLogger;
        impl log::Log for ProbeLogger {
            fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
                metadata.level() <= log::Level::Warn
            }
            fn log(&self, record: &log::Record<'_>) {
                if self.enabled(record.metadata()) {
                    eprintln!("{}: {}", record.level(), record.args());
                }
            }
            fn flush(&self) {}
        }
        static LOGGER: ProbeLogger = ProbeLogger;
        static INITIALIZE: std::sync::Once = std::sync::Once::new();
        INITIALIZE.call_once(|| {
            if log::set_logger(&LOGGER).is_ok() {
                log::set_max_level(log::LevelFilter::Warn);
            }
        });
        let requested = std::env::var_os("DISTILL_WINDOWS_OWNED_PROBE_ROOT").ok_or_else(|| {
            io::Error::other("Actual OS probes need explicit DISTILL_WINDOWS_OWNED_PROBE_ROOT")
        })?;
        let base = dunce::canonicalize(requested)?;
        if !base.is_absolute() || base.file_name() != Some(OsStr::new("windows-owned-2026-10-08")) {
            return Err(io::Error::other(
                "OS probe root must be the approved private Windows QA directory",
            ));
        }
        let run = base.join(format!("probe-{}", Uuid::new_v4()));
        fs::create_dir(&run)?;
        let staging = OwnedWindowsStaging::create(&run)?;
        assert_eq!(staging.root().parent(), Some(run.as_path()));
        let private = run.join("private-canary.txt");
        let sibling = run.join("sibling").join("private.txt");
        fs::create_dir(sibling.parent().unwrap())?;
        fs::write(&private, "invented-private-canary")?;
        fs::write(&sibling, "invented-sibling-canary")?;
        fs::write(
            staging.workspace().join("public.txt"),
            "invented-public-input",
        )?;
        fs::write(
            staging.runtime().join("runtime-public.txt"),
            "invented-read-only-runtime",
        )?;
        let node = std::env::var_os("DISTILL_WINDOWS_OWNED_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
        fs::copy(node, staging.runtime().join("node.exe"))?;
        eprintln!("Owned Windows probe run: {}", run.display());
        Ok(Self {
            run,
            staging: Some(staging),
            private,
            sibling,
        })
    }
    fn staging(&self) -> &OwnedWindowsStaging {
        self.staging.as_ref().unwrap()
    }
    fn plan(&mut self, program: PathBuf, args: Vec<OsString>) -> OwnedWindowsPlan {
        let staging = self.staging.take().unwrap();
        let mut environment = vec![(
            OsString::from("PATH"),
            staging.runtime().as_os_str().to_owned(),
        )];
        for key in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(key) {
                environment.push((key.into(), value));
            }
        }
        OwnedWindowsPlan {
            staging,
            program,
            args,
            environment,
            // Process creation and Winsock startup read machine registry
            // configuration; registryRead grants nothing else.
            capabilities: vec!["registryRead"],
        }
    }
    fn compile_fixture(&self, name: &str, body: &str) -> io::Result<PathBuf> {
        let source = self.run.join(format!("{name}.rs"));
        fs::write(&source, body)?;
        let executable = self.staging().runtime().join(format!("{name}.exe"));
        let compiler = std::env::var_os("DISTILL_WINDOWS_OWNED_RUSTC").ok_or_else(|| {
            io::Error::other("Explicit installed Rust compiler required for own native fixture")
        })?;
        let compiled = std::process::Command::new(compiler)
            .args([
                OsStr::new("--edition=2021"),
                OsStr::new("-C"),
                OsStr::new("panic=abort"),
                source.as_os_str(),
                OsStr::new("-o"),
                executable.as_os_str(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()?;
        if !compiled.status.success() {
            return Err(io::Error::other(format!(
                "Own offline fixture compile failed: {}",
                String::from_utf8_lossy(&compiled.stderr)
            )));
        }
        Ok(executable)
    }
    fn cleanup(self) -> io::Result<()> {
        // Preserve real failed/uncertain runs: tests call this only after native
        // child/profile/ACL cleanup succeeded. Reject links before recursive removal.
        drop(self.staging);
        fn no_links(path: &Path) -> io::Result<()> {
            use std::os::windows::fs::MetadataExt;
            let metadata = fs::symlink_metadata(path)?;
            if metadata.file_attributes()
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                != 0
            {
                return Err(io::Error::other("Retaining QA run with a reparse point"));
            }
            let handle = security::open_object(path, true, false)?;
            let information = security::object_info(&handle)?;
            if !metadata.is_dir() && information.nNumberOfLinks != 1 {
                return Err(io::Error::other("Retaining QA run with extra hard links"));
            }
            if metadata.is_dir() {
                for entry in fs::read_dir(path)? {
                    no_links(&entry?.path())?;
                }
            }
            Ok(())
        }
        let resolved = dunce::canonicalize(&self.run)?;
        let base =
            dunce::canonicalize(std::env::var_os("DISTILL_WINDOWS_OWNED_PROBE_ROOT").unwrap())?;
        if resolved.parent() != Some(base.as_path())
            || !resolved
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("probe-"))
        {
            return Err(io::Error::other(
                "Refusing cleanup outside the exact created QA run",
            ));
        }
        no_links(&resolved)?;
        fs::remove_dir_all(resolved)
    }
}

async fn read_json(reader: &mut BufReader<NamedPipeServer>) -> io::Result<serde_json::Value> {
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(20), reader.read_line(&mut line))
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                "Real Windows probe produced no stdout",
            )
        })??;
    if line.len() > 64 * 1024 {
        return Err(io::Error::other("Probe output exceeded its bound"));
    }
    eprintln!("Owned Windows observed stdout: {}", line.trim());
    serde_json::from_str(&line).map_err(io::Error::other)
}

const NODE_BOUNDARY_PROBE: &str = r#"
const fs = require('fs');
const net = require('net');
const cp = require('child_process');
const [privatePath, siblingPath, workspace, home, temp, runtimeFile, port, lpacCanary] = process.argv.slice(2);
function read(path) { try { return { ok: true, value: fs.readFileSync(path, 'utf8') }; } catch (e) { return { ok: false, code: e.code }; } }
function write(path) { try { fs.writeFileSync(path, 'child-write'); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; } }
if (process.argv[2] === '--baseline') {
  console.log(JSON.stringify({ private: read(process.argv[3]), sibling: read(process.argv[4]) }));
} else {
  process.stdin.once('data', async input => {
    process.stderr.write('owned-stderr-marker\n');
    const result = {
      input: input.toString(), pid: process.pid,
      public: read(workspace + '/public.txt'),
      workspaceWrite: write(workspace + '/child-output.txt'), homeWrite: write(home + '/child-output.txt'), tempWrite: write(temp + '/child-output.txt'),
      privateRead: read(privatePath), privateWrite: write(privatePath), siblingRead: read(siblingPath), siblingWrite: write(siblingPath), runtimeWrite: write(runtimeFile), lpacCanaryRead: read(lpacCanary),
      environment: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP },
      realpath: (() => { try { return { ok: true, value: fs.realpathSync(workspace) }; } catch (e) { return { ok: false, code: e.code }; } })()
    };
    process.stderr.write('stage:files\n');
    result.loopback = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
      socket.once('connect', () => { socket.destroy(); resolve({ connected: true }); });
      socket.once('error', error => resolve({ connected: false, code: error.code }));
      socket.setTimeout(3000, () => { socket.destroy(); resolve({ connected: false, code: 'unknown-timeout' }); });
    });
    process.stderr.write('stage:loopback ' + JSON.stringify(result.loopback) + '\n');
    const childCode = `const fs=require('fs'); const result={pid:process.pid}; try {fs.readFileSync(process.argv[1]);result.privateRead=true} catch(e) {result.privateRead=false;result.code=e.code} console.log(JSON.stringify(result)); setInterval(()=>{},1000);`;
    const child = cp.spawn(process.execPath, ['-e', childCode, privatePath], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, windowsHide: true });
    process.stderr.write('stage:spawned ' + child.pid + '\n');
    let line = '';
    child.stdout.on('data', data => { line += data.toString(); if (line.includes('\n')) {result.grandchild=JSON.parse(line.split('\n')[0]);console.log(JSON.stringify(result));} });
    child.stderr.on('data', data => process.stderr.write(data));
    child.once('error', error => {result.grandchildError=error.code;console.log(JSON.stringify(result));});
    child.once('exit', (code, signal) => { if (!result.grandchild) { result.grandchildExit = { code, signal }; console.log(JSON.stringify(result)); } });
    setInterval(()=>{},1000);
  });
}
"#;

#[tokio::test]
#[ignore = "Explicit approved Windows QA root; real AppContainer/ACL and localhost probes"]
async fn actual_lpac_node_denies_siblings_loopback_and_preserves_async_stdio_and_descendants(
) -> io::Result<()> {
    let mut probe = Probe::create()?;
    let script = probe.staging().workspace().join("probe.js");
    fs::write(&script, NODE_BOUNDARY_PROBE)?;
    let node = probe.staging().runtime().join("node.exe");
    let node_options = stage_node_runtime(probe.staging())?;
    // Positive control: the same actual public runtime and script can read both
    // invented canaries with the host's ordinary token. ENOENT is never a denial.
    let baseline = std::process::Command::new(&node)
        .args([
            script.as_os_str(),
            OsStr::new("--baseline"),
            probe.private.as_os_str(),
            probe.sibling.as_os_str(),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    assert!(
        baseline.status.success(),
        "Ordinary Node positive control: {}",
        String::from_utf8_lossy(&baseline.stderr)
    );
    let baseline: serde_json::Value = serde_json::from_slice(&baseline.stdout)?;
    assert_eq!(baseline["private"]["value"], "invented-private-canary");
    assert_eq!(baseline["sibling"]["value"], "invented-sibling-canary");
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let workspace = probe.staging().workspace().to_owned();
    let home = probe.staging().home().to_owned();
    let temp = probe.staging().temp().to_owned();
    let runtime_file = probe.staging().runtime().join("runtime-public.txt");
    let lpac_canary = probe.staging().lpac_canary().to_owned();
    let args = vec![
        script.into_os_string(),
        probe.private.as_os_str().to_owned(),
        probe.sibling.as_os_str().to_owned(),
        workspace.as_os_str().to_owned(),
        home.as_os_str().to_owned(),
        temp.as_os_str().to_owned(),
        runtime_file.as_os_str().to_owned(),
        port.to_string().into(),
        lpac_canary.into_os_string(),
    ];
    let OwnedWindowsSpawn {
        mut child,
        mut stdin,
        stdout,
        stderr,
    } = spawn({
        let mut plan = probe.plan(node, args);
        plan.environment.push(node_options);
        plan
    })
    .await?;
    eprintln!(
        "Actual Windows native security facts: {}",
        serde_json::to_string(&child.security)?
    );
    assert!(child.security.less_privileged && child.security.strict_job);
    assert_eq!(child.security.network_capability_count, 0);
    let collected = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let stderr = tokio::spawn({
        let collected = collected.clone();
        async move {
            let mut stderr = stderr;
            let mut chunk = [0u8; 1024];
            loop {
                let read = stderr.read(&mut chunk).await?;
                let mut all = collected.lock().unwrap();
                if read == 0 || all.len() >= 8192 {
                    return Ok::<_, io::Error>(all.clone());
                }
                all.extend_from_slice(&chunk[..read]);
            }
        }
    });
    stdin.write_all(b"public-probe-input\n").await?;
    stdin.flush().await?;
    let mut reader = BufReader::new(stdout);
    let observed = match read_json(&mut reader).await {
        Ok(observed) => observed,
        Err(error) => {
            eprintln!("Actual Node early-exit status: {:?}", child.try_wait()?);
            tokio::time::sleep(Duration::from_secs(1)).await;
            eprintln!(
                "Actual Node stderr so far: {:?}",
                String::from_utf8_lossy(&collected.lock().unwrap())
            );
            return Err(error);
        }
    };
    assert_eq!(observed["pid"], child.id());
    assert_eq!(observed["input"], "public-probe-input\n");
    assert_eq!(observed["public"]["value"], "invented-public-input");
    for name in ["workspaceWrite", "homeWrite", "tempWrite"] {
        assert_eq!(observed[name]["ok"], true, "{name}: {observed}");
    }
    for name in [
        "privateRead",
        "privateWrite",
        "siblingRead",
        "siblingWrite",
        "runtimeWrite",
        "lpacCanaryRead",
    ] {
        assert_eq!(observed[name]["ok"], false, "{name}: {observed}");
        assert!(
            matches!(observed[name]["code"].as_str(), Some("EACCES" | "EPERM")),
            "Unknown denial {name}: {observed}"
        );
    }
    assert_eq!(observed["loopback"]["connected"], false);
    assert!(
        matches!(
            observed["loopback"]["code"].as_str(),
            Some("EACCES" | "EPERM")
        ),
        "Unknown loopback denial: {observed}"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err(),
        "The own localhost control listener received a child connection"
    );
    assert_eq!(
        observed["environment"]["HOME"],
        home.to_string_lossy().as_ref()
    );
    assert_eq!(
        observed["environment"]["TEMP"],
        temp.to_string_lossy().as_ref()
    );
    // The preload resolves a granted path although its ancestors are denied.
    assert_eq!(observed["realpath"]["ok"], true, "{observed}");
    assert!(observed["realpath"]["value"]
        .as_str()
        .is_some_and(|value| value.eq_ignore_ascii_case(&workspace.to_string_lossy())));
    let grandchild = observed["grandchild"]["pid"]
        .as_u64()
        .expect("real detached Node grandchild") as u32;
    assert_eq!(observed["grandchild"]["privateRead"], false);
    assert!(matches!(
        observed["grandchild"]["code"].as_str(),
        Some("EACCES" | "EPERM")
    ));
    let handle = owned_handle(
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, grandchild) },
        "query actual protected grandchild",
    )?;
    let handle = Some(handle);
    let grandchild_facts = child.profile.as_ref().unwrap().verify_child(
        &handle,
        child.paths.as_ref().unwrap().canary(),
        &child.granted,
    )?;
    assert_eq!(
        grandchild_facts.app_container_sid,
        child.security.app_container_sid
    );
    child.job.as_ref().unwrap().verify(&handle)?;
    child.start_kill()?;
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| io::Error::other("Protected child cancellation unresolved"))??;
    child.close()?;
    let remaining =
        tokio::time::timeout(Duration::from_secs(5), reader.read_to_end(&mut Vec::new()))
            .await
            .map_err(|_| io::Error::other("Protected stdout EOF unresolved"))??;
    assert_eq!(remaining, 0);
    let stderr = tokio::time::timeout(Duration::from_secs(5), stderr)
        .await
        .map_err(|_| io::Error::other("Protected stderr EOF unresolved"))??;
    assert!(String::from_utf8_lossy(&stderr?).contains("owned-stderr-marker"));
    for path in [
        workspace.join("child-output.txt"),
        home.join("child-output.txt"),
        temp.join("child-output.txt"),
    ] {
        assert_eq!(fs::read_to_string(path)?, "child-write");
    }
    assert_eq!(
        fs::read_to_string(&probe.private)?,
        "invented-private-canary"
    );
    assert_eq!(
        fs::read_to_string(&probe.sibling)?,
        "invented-sibling-canary"
    );
    assert_eq!(
        fs::read_to_string(runtime_file)?,
        "invented-read-only-runtime"
    );
    drop(handle);
    probe.cleanup()
}

#[tokio::test]
#[ignore = "Explicit approved Windows QA root; real hardlink refusal before granting"]
async fn actual_extra_hardlink_refuses_before_launch_without_touching_canary() -> io::Result<()> {
    let mut probe = Probe::create()?;
    let link = probe.staging().workspace().join("linked-private.txt");
    fs::hard_link(&probe.private, &link)?;
    let node = probe.staging().runtime().join("node.exe");
    let error = match spawn(probe.plan(
        node,
        vec!["-e".into(), "console.log('must-not-run')".into()],
    ))
    .await
    {
        Ok(spawned) => {
            spawned.child.close()?;
            panic!("Extra hardlink reached launch")
        }
        Err(error) => error,
    };
    eprintln!("Actual hardlink refusal: {error}");
    assert!(error.to_string().contains("hard links"));
    assert_eq!(
        fs::read_to_string(&probe.private)?,
        "invented-private-canary"
    );
    fs::remove_file(link)?;
    probe.cleanup()
}

#[tokio::test]
#[ignore = "Explicit approved Windows QA root; own NTFS junction refusal"]
async fn actual_reparse_junction_refuses_before_launch() -> io::Result<()> {
    let mut probe = Probe::create()?;
    let junction = probe.staging().workspace().join("sibling-junction");
    let target = probe.sibling.parent().unwrap();
    let made = std::process::Command::new("cmd.exe")
        .args([
            OsStr::new("/D"),
            OsStr::new("/C"),
            OsStr::new("mklink"),
            OsStr::new("/J"),
            junction.as_os_str(),
            target.as_os_str(),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    assert!(
        made.status.success(),
        "Create own invented junction: {}{}",
        String::from_utf8_lossy(&made.stdout),
        String::from_utf8_lossy(&made.stderr)
    );
    let node = probe.staging().runtime().join("node.exe");
    let error = match spawn(probe.plan(
        node,
        vec!["-e".into(), "console.log('must-not-run')".into()],
    ))
    .await
    {
        Ok(spawned) => {
            spawned.child.close()?;
            panic!("Reparse point reached launch")
        }
        Err(error) => error,
    };
    eprintln!("Actual reparse refusal: {error}");
    assert!(error.to_string().contains("reparse"));
    fs::remove_dir(junction)?; // Removes this exact junction, never its target.
    assert_eq!(
        fs::read_to_string(&probe.sibling)?,
        "invented-sibling-canary"
    );
    probe.cleanup()
}

#[tokio::test]
#[ignore = "Explicit approved Windows QA root; compiled own native breakaway probe"]
async fn actual_strict_job_refuses_create_breakaway_from_job() -> io::Result<()> {
    let mut probe = Probe::create()?;
    let source = probe.run.join("breakaway-probe.rs");
    fs::write(&source, include_str!("breakaway_probe.rs"))?;
    let executable = probe.staging().runtime().join("breakaway-probe.exe");
    let compiler = std::env::var_os("DISTILL_WINDOWS_OWNED_RUSTC").ok_or_else(|| {
        io::Error::other("Explicit installed Rust compiler required for own breakaway fixture")
    })?;
    let compiled = std::process::Command::new(compiler)
        .args([
            OsStr::new("--edition=2021"),
            OsStr::new("-C"),
            OsStr::new("panic=abort"),
            source.as_os_str(),
            OsStr::new("-o"),
            executable.as_os_str(),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    assert!(
        compiled.status.success(),
        "Own offline breakaway fixture compile: {}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let node = probe.staging().runtime().join("node.exe");
    let OwnedWindowsSpawn {
        mut child,
        stdin,
        stdout,
        stderr,
    } = spawn(probe.plan(executable, vec![node.into_os_string()])).await?;
    let mut reader = BufReader::new(stdout);
    let observed = read_json(&mut reader).await?;
    assert_eq!(
        observed["breakawayError"], 5,
        "Unexpected breakaway refusal: {observed}"
    );
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| io::Error::other("Breakaway probe exit unresolved"))??;
    assert!(status.success());
    child.close()?;
    drop((reader, stdin, stderr));
    probe.cleanup()
}

#[tokio::test]
#[ignore = "Explicit approved Windows QA root; real LPAC native filesystem/stdio/descendant probes"]
async fn actual_native_lpac_filesystem_stdio_descendants_and_cleanup() -> io::Result<()> {
    let mut probe = Probe::create()?;
    let executable =
        probe.compile_fixture("native-public-probe", include_str!("native_probe.rs"))?;
    fs::write(
        probe.staging().workspace().join("existing-edit.txt"),
        "invented-editable-input",
    )?;
    fs::create_dir(probe.staging().workspace().join("existing-dir"))?;
    fs::write(
        probe
            .staging()
            .workspace()
            .join("existing-dir")
            .join("nested.txt"),
        "invented-nested-input",
    )?;
    let workspace = probe.staging().workspace().to_owned();
    let home = probe.staging().home().to_owned();
    let temp = probe.staging().temp().to_owned();
    let runtime_file = probe.staging().runtime().join("runtime-public.txt");
    let args = vec![
        probe.private.as_os_str().to_owned(),
        probe.sibling.as_os_str().to_owned(),
        workspace.as_os_str().to_owned(),
        home.as_os_str().to_owned(),
        temp.as_os_str().to_owned(),
        runtime_file.as_os_str().to_owned(),
        probe.staging().lpac_canary().as_os_str().to_owned(),
    ];
    let OwnedWindowsSpawn {
        mut child,
        mut stdin,
        stdout,
        stderr,
    } = spawn(probe.plan(executable, args)).await?;
    eprintln!(
        "Actual native LPAC security facts: {}",
        serde_json::to_string(&child.security)?
    );
    assert!(child.security.less_privileged && child.security.strict_job);
    assert_eq!(child.security.network_capability_count, 0);
    assert_eq!(
        child.security.lpac_proof,
        "kernel_access_check_all_application_packages_denied_with_ordinary_control"
    );
    let stderr = tokio::spawn(async move {
        let mut result = Vec::new();
        stderr
            .take(8192)
            .read_to_end(&mut result)
            .await
            .map(|_| result)
    });
    stdin.write_all(b"public-native-input\n").await?;
    stdin.flush().await?;
    let mut reader = BufReader::new(stdout);
    let observed = match read_json(&mut reader).await {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Actual native early-exit status: {:?}", child.try_wait()?);
            let stderr = tokio::time::timeout(Duration::from_secs(3), stderr).await;
            eprintln!(
                "Actual native early-exit stderr: {:?}",
                stderr.map(|value| value
                    .map(|bytes| bytes.map(|bytes| String::from_utf8_lossy(&bytes).into_owned())))
            );
            return Err(error);
        }
    };
    assert_eq!(observed["pid"], child.id());
    let second = read_json(&mut reader).await?;
    let (observed, grandchild_observed) = if observed.get("input").is_some() {
        (observed, second)
    } else {
        (second, observed)
    };
    assert_eq!(observed["pid"], child.id());
    assert_eq!(observed["input"], "public-native-input\n");
    assert_eq!(observed["public"]["value"], "invented-public-input");
    for name in ["workspaceWrite", "homeWrite", "tempWrite"] {
        assert_eq!(observed[name]["ok"], true, "{name}: {observed}");
    }
    for name in [
        "existingRename",
        "existingWrite",
        "existingDelete",
        "existingDirectoryRename",
        "directoryCreate",
        "directoryRename",
        "directoryDelete",
    ] {
        assert_eq!(observed[name]["ok"], true, "{name}: {observed}");
    }
    for name in [
        "privateRead",
        "privateWrite",
        "siblingRead",
        "siblingWrite",
        "runtimeWrite",
        "lpacCanaryRead",
    ] {
        assert_eq!(observed[name]["ok"], false, "{name}: {observed}");
        assert_eq!(
            observed[name]["error"], 5,
            "Unknown denial {name}: {observed}"
        );
    }
    assert_eq!(observed["home"], home.to_string_lossy().as_ref());
    assert_eq!(observed["temp"], temp.to_string_lossy().as_ref());
    let grandchild = observed["grandchildPid"]
        .as_u64()
        .expect("actual detached native grandchild") as u32;
    assert_eq!(grandchild_observed["pid"], grandchild);
    assert_eq!(grandchild_observed["privateRead"]["ok"], false);
    assert_eq!(grandchild_observed["privateRead"]["error"], 5);
    let handle = Some(owned_handle(
        unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                grandchild,
            )
        },
        "query actual native LPAC grandchild",
    )?);
    let descendant = child.profile.as_ref().unwrap().verify_child(
        &handle,
        child.paths.as_ref().unwrap().canary(),
        &child.granted,
    )?;
    assert_eq!(
        descendant.app_container_sid,
        child.security.app_container_sid
    );
    child.job.as_ref().unwrap().verify(&handle)?;
    child.start_kill()?;
    tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| io::Error::other("Native LPAC cancellation unresolved"))??;
    let profile = child.security.profile_name.clone();
    child.close()?;
    assert_eq!(
        unsafe { WaitForSingleObject(handle.as_ref().unwrap().as_raw_handle(), 0) },
        WAIT_OBJECT_0,
        "Actual grandchild still running after Job cancellation"
    );
    let remaining =
        tokio::time::timeout(Duration::from_secs(5), reader.read_to_end(&mut Vec::new()))
            .await
            .map_err(|_| io::Error::other("Native stdout EOF unresolved"))??;
    assert_eq!(remaining, 0);
    let stderr = tokio::time::timeout(Duration::from_secs(5), stderr)
        .await
        .map_err(|_| io::Error::other("Native stderr EOF unresolved"))??;
    assert!(String::from_utf8_lossy(&stderr?).contains("owned-native-stderr-marker"));
    for path in [
        workspace.join("child-output.txt"),
        home.join("child-output.txt"),
        temp.join("child-output.txt"),
    ] {
        assert_eq!(fs::read_to_string(path)?, "child-write");
    }
    assert_eq!(
        fs::read_to_string(&probe.private)?,
        "invented-private-canary"
    );
    assert_eq!(
        fs::read_to_string(&probe.sibling)?,
        "invented-sibling-canary"
    );
    assert_eq!(
        fs::read_to_string(runtime_file)?,
        "invented-read-only-runtime"
    );
    drop((handle, reader, stdin));
    let run = probe.run.clone();
    probe.cleanup()?;
    assert!(!run.exists());
    eprintln!("Actual native cleanup PASS: Job drained; DACL/label read-back restored; DeleteAppContainerProfile returned success for {profile}; exact QA run removed: {}", run.display());
    Ok(())
}
