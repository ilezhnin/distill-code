//! The pinned Cua Driver release: where it lives under the Flock root and how
//! it gets there.
//!
//! `cua-driver.lock.json` names one release archive per target with its exact
//! size and SHA-256. The archive is downloaded only when a chat turns computer
//! use on, checked against both before anything is unpacked, and only the
//! files the lock names are taken out of it: the driver itself and its
//! licence texts. The bundled uiAccess worker, cursor-theme compiler and SDK
//! library stay behind, since a chat never uses them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

const DRIVER_LOCK_JSON: &str = include_str!("../../../../cua-driver.lock.json");

/// The driver's file name inside an install, and the lock's key for it.
pub const DRIVER_FILE: &str = "cua-driver.exe";

/// Upper bound on one unpacked file; the driver is about 38 MB.
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// `cua-driver --version` answers at once; anything near this is stuck.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverLock {
    pub version: String,
    pub release: String,
    pub source_commit: String,
    pub signer: String,
    pub license: String,
    pub artifacts: BTreeMap<String, DriverArtifact>,
}

#[derive(Debug, Deserialize)]
pub struct DriverArtifact {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    /// Installed file name → its path inside the archive.
    pub files: BTreeMap<String, String>,
}

pub fn driver_lock() -> &'static DriverLock {
    static LOCK: OnceLock<DriverLock> = OnceLock::new();
    LOCK.get_or_init(|| {
        serde_json::from_str(DRIVER_LOCK_JSON).expect("embedded cua-driver.lock.json must parse")
    })
}

fn current_artifact(lock: &DriverLock) -> Result<(&'static str, &DriverArtifact), String> {
    let unsupported = || "Computer use is available on 64-bit Windows only.".to_string();
    let target = crate::services::managed_node::current_target_triple().ok_or_else(unsupported)?;
    let artifact = lock.artifacts.get(target).ok_or_else(unsupported)?;
    Ok((target, artifact))
}

/// `<flock root>/cache/packages/cua-driver`: every installed driver version
/// lives under here.
pub fn driver_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let root = crate::services::flock_root::app_root(app)
        .map_err(|error| format!("The Flock folder is unavailable: {error}"))?;
    Ok(root.join("cache").join("packages").join("cua-driver"))
}

fn install_dir(root: &Path, version: &str, target: &str) -> PathBuf {
    root.join(version).join(target)
}

/// The folder the driver keeps its own state in, beside the installs so a
/// version change keeps it.
pub fn driver_home(root: &Path) -> PathBuf {
    root.join(HOME_DIR)
}

const HOME_DIR: &str = "home";

/// The pinned driver under `root` when its file is there. A cheap check for
/// the attach path, which must not start a download or a process; the toggle
/// runs [`ensure_driver_at`] before a chat relies on it.
pub fn installed_driver(root: &Path) -> Option<PathBuf> {
    let lock = driver_lock();
    let (target, _) = current_artifact(lock).ok()?;
    let driver = install_dir(root, &lock.version, target).join(DRIVER_FILE);
    driver.is_file().then_some(driver)
}

/// Make sure the pinned driver is installed and answers with its version,
/// downloading and swapping it into place when it is not. Returns the driver's
/// path. Installs are serialized and re-check readiness under the lock.
pub async fn ensure_driver_at(root: &Path, lock: &DriverLock) -> Result<PathBuf, String> {
    let (target, artifact) = current_artifact(lock)?;
    let final_dir = install_dir(root, &lock.version, target);
    let driver = final_dir.join(DRIVER_FILE);
    let home = driver_home(root);
    if reports_version(&driver, &lock.version, &home).await {
        return Ok(driver);
    }
    let _guard = install_serialization_lock().lock().await;
    if reports_version(&driver, &lock.version, &home).await {
        return Ok(driver);
    }
    log::info!(
        "[computer-use] installing Cua Driver {} ({} at {}, {} licence, signed by {})",
        lock.version,
        lock.release,
        lock.source_commit,
        lock.license,
        lock.signer
    );
    install(root, &final_dir, artifact).await?;
    if !reports_version(&driver, &lock.version, &home).await {
        return Err(format!(
            "The computer use driver was installed but does not start: {}",
            driver.display()
        ));
    }
    prune_superseded(root, &lock.version);
    Ok(driver)
}

fn install_serialization_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// The environment every driver process Flock starts gets, on top of an
/// inherited one cleared of the driver's own settings: no telemetry, no update
/// checks, the standard permission mode, and its state under the Flock root.
pub fn driver_env(home: &Path) -> Vec<(&'static str, std::ffi::OsString)> {
    vec![
        ("DO_NOT_TRACK", "1".into()),
        ("CUA_TELEMETRY", "0".into()),
        ("CUA_TELEMETRY_ENABLED", "false".into()),
        ("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0".into()),
        ("CUA_DRIVER_RS_UPDATE_CHECK", "0".into()),
        ("CUA_DRIVER_PERMISSION_MODE", "standard".into()),
        ("CUA_DRIVER_RS_HOME", home.as_os_str().to_owned()),
    ]
}

/// Whether an inherited variable is one of the driver's own settings, which a
/// user's environment must not hand to the process Flock runs (an unrestricted
/// permission mode, a capability manifest, a debugging port).
pub fn is_driver_setting(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    name.starts_with("CUA_") || name == "DO_NOT_TRACK"
}

/// Run `<driver> --version` and compare it with `cua-driver <version>`.
async fn reports_version(driver: &Path, version: &str, home: &Path) -> bool {
    if !driver.is_file() {
        return false;
    }
    let mut command = tokio::process::Command::new(driver);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    for (name, _) in std::env::vars_os() {
        if is_driver_setting(&name) {
            command.env_remove(name);
        }
    }
    command.envs(driver_env(home));
    crate::services::process::apply_no_window_async(&mut command);
    let output = match tokio::time::timeout(VERSION_PROBE_TIMEOUT, command.output()).await {
        Ok(output) => output,
        Err(_) => {
            log::warn!(
                "[computer-use] driver version probe timed out: {}",
                driver.display()
            );
            return false;
        }
    };
    output
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| {
            String::from_utf8_lossy(&output.stdout).trim() == format!("cua-driver {version}")
        })
}

/// Download the archive, unpack the files the lock names into a fresh folder
/// beside `final_dir`, and swap that folder into place.
async fn install(root: &Path, final_dir: &Path, artifact: &DriverArtifact) -> Result<(), String> {
    let parent = final_dir
        .parent()
        .ok_or_else(|| "The driver folder has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let archive = root.join("driver.zip.download");
    let staged = final_dir.with_extension("tmp");
    if staged.exists() {
        std::fs::remove_dir_all(&staged)
            .map_err(|error| format!("Could not clear {}: {error}", staged.display()))?;
    }
    if let Err(error) = download(&artifact.url, &archive, &artifact.sha256, artifact.size).await {
        let _ = std::fs::remove_file(&archive);
        return Err(error);
    }
    let unpacked = {
        let archive = archive.clone();
        let staged = staged.clone();
        let files = artifact.files.clone();
        tokio::task::spawn_blocking(move || unpack(&archive, &staged, &files))
            .await
            .map_err(|error| format!("Unpacking the driver stopped: {error}"))?
    };
    let _ = std::fs::remove_file(&archive);
    if let Err(error) = unpacked {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(error);
    }
    swap_into_place(&staged, final_dir)
}

async fn download(url: &str, dest: &Path, sha256: &str, size: u64) -> Result<(), String> {
    let failed = |error: &dyn std::fmt::Display| {
        format!("Could not download the computer use driver: {error}")
    };
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|error| failed(&error))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| failed(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(failed(&format!("the server answered {status}")));
    }
    if response
        .content_length()
        .is_some_and(|length| length != size)
    {
        return Err(failed(&"the archive is not the size Flock pins"));
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|error| failed(&error))?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut received = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| failed(&error))?;
        received += chunk.len() as u64;
        if received > size {
            return Err(failed(&"the archive is larger than the one Flock pins"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| failed(&error))?;
    }
    file.flush().await.map_err(|error| failed(&error))?;
    drop(file);
    if received != size {
        return Err(failed(&"the archive is smaller than the one Flock pins"));
    }
    let actual = hex::encode(hasher.finalize());
    if !actual.eq_ignore_ascii_case(sha256) {
        return Err(failed(&format!(
            "the archive's SHA-256 is {actual}, not the pinned {sha256}"
        )));
    }
    Ok(())
}

/// Take exactly the named entries out of the archive into `dest`, each under
/// its plain installed name and within the size bound.
fn unpack(archive: &Path, dest: &Path, files: &BTreeMap<String, String>) -> Result<(), String> {
    let failed = |error: &dyn std::fmt::Display| format!("Could not unpack the driver: {error}");
    let reader = std::fs::File::open(archive).map_err(|error| failed(&error))?;
    let mut zip = zip::ZipArchive::new(reader).map_err(|error| failed(&error))?;
    std::fs::create_dir_all(dest).map_err(|error| failed(&error))?;
    for (installed, entry_name) in files {
        if !is_plain_file_name(installed) {
            return Err(failed(&format!("`{installed}` is not a plain file name")));
        }
        let mut entry = zip
            .by_name(entry_name)
            .map_err(|error| failed(&format!("{entry_name}: {error}")))?;
        if entry.is_dir() {
            return Err(failed(&format!("{entry_name} is a folder")));
        }
        let out_path = dest.join(installed);
        let mut out = std::fs::File::create(&out_path).map_err(|error| failed(&error))?;
        let mut limited = std::io::Read::take(&mut entry, MAX_FILE_BYTES + 1);
        let copied = std::io::copy(&mut limited, &mut out).map_err(|error| failed(&error))?;
        if copied > MAX_FILE_BYTES {
            return Err(failed(&format!("{entry_name} is too large")));
        }
    }
    Ok(())
}

fn is_plain_file_name(name: &str) -> bool {
    let path = Path::new(name);
    !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && path.file_name().is_some_and(|file_name| file_name == name)
        && name != "."
        && name != ".."
}

/// Replace `final_dir` with `staged`, keeping the previous install aside until
/// the new one is in place and putting it back when the swap fails.
fn swap_into_place(staged: &Path, final_dir: &Path) -> Result<(), String> {
    let old = final_dir.with_extension("old");
    if old.exists() {
        std::fs::remove_dir_all(&old)
            .map_err(|error| format!("Could not clear {}: {error}", old.display()))?;
    }
    if final_dir.exists() {
        std::fs::rename(final_dir, &old)
            .map_err(|error| format!("Could not move the previous driver aside: {error}"))?;
    }
    if let Err(error) = std::fs::rename(staged, final_dir) {
        if old.exists() {
            let _ = std::fs::rename(&old, final_dir);
        }
        return Err(format!("Could not put the driver in place: {error}"));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// Remove driver versions other than the pin. Best effort: a version a running
/// chat still holds open stays until the next install.
fn prune_superseded(root: &Path, version: &str) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if !path.is_dir() || name == version || name == HOME_DIR {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&path) {
            log::info!(
                "[computer-use] kept superseded driver {}: {error}",
                path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use tokio::io::AsyncReadExt;

    fn sha256_hex(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    async fn serve_once(body: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
            let _ = socket.shutdown().await;
        });
        format!("http://{addr}/driver.zip")
    }

    fn release_zip() -> Vec<u8> {
        use zip::write::SimpleFileOptions;
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        for (name, contents) in [
            ("release/cua-driver.exe", &b"MZ driver"[..]),
            ("release/cua-driver-uia.exe", b"MZ worker"),
            ("release/LICENSE", b"MIT"),
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(contents).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn artifact(url: String, body: &[u8]) -> DriverArtifact {
        DriverArtifact {
            url,
            sha256: sha256_hex(body),
            size: body.len() as u64,
            files: BTreeMap::from([
                (
                    DRIVER_FILE.to_string(),
                    "release/cua-driver.exe".to_string(),
                ),
                ("LICENSE".to_string(), "release/LICENSE".to_string()),
            ]),
        }
    }

    #[test]
    fn the_embedded_lock_pins_a_signed_windows_release() {
        let lock = driver_lock();
        let windows = &lock.artifacts["x86_64-pc-windows-msvc"];
        assert_eq!(windows.sha256.len(), 64);
        assert!(windows.sha256.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(windows
            .url
            .starts_with("https://github.com/trycua/cua/releases/download/"));
        assert!(windows.url.contains(&lock.release));
        assert!(lock
            .signer
            .ends_with(&format!("@refs/tags/{}", lock.release)));
        assert_eq!(lock.source_commit.len(), 40);
        assert_eq!(lock.license, "MIT");
        assert!(windows.files.contains_key(DRIVER_FILE));
        assert!(windows.files.keys().all(|name| is_plain_file_name(name)));
    }

    #[tokio::test]
    async fn install_takes_only_the_named_files() {
        let root = tempfile::tempdir().unwrap();
        let body = release_zip();
        let artifact = artifact(serve_once(body.clone()).await, &body);
        let final_dir = install_dir(root.path(), "9.9.9", "test-target");
        install(root.path(), &final_dir, &artifact).await.unwrap();
        assert_eq!(
            std::fs::read(final_dir.join(DRIVER_FILE)).unwrap(),
            b"MZ driver"
        );
        assert_eq!(std::fs::read(final_dir.join("LICENSE")).unwrap(), b"MIT");
        assert!(!final_dir.join("cua-driver-uia.exe").exists());
        assert!(!root.path().join("driver.zip.download").exists());
        assert!(!final_dir.with_extension("tmp").exists());
    }

    #[tokio::test]
    async fn a_wrong_checksum_installs_nothing() {
        let root = tempfile::tempdir().unwrap();
        let body = release_zip();
        let mut artifact = artifact(serve_once(body.clone()).await, &body);
        artifact.sha256 = "0".repeat(64);
        let final_dir = install_dir(root.path(), "9.9.9", "test-target");
        let error = install(root.path(), &final_dir, &artifact)
            .await
            .unwrap_err();
        assert!(error.contains("SHA-256"), "{error}");
        assert!(!final_dir.exists());
        assert!(!root.path().join("driver.zip.download").exists());
    }

    #[tokio::test]
    async fn an_archive_of_another_size_installs_nothing() {
        let root = tempfile::tempdir().unwrap();
        let body = release_zip();
        let mut artifact = artifact(serve_once(body.clone()).await, &body);
        artifact.size -= 1;
        let final_dir = install_dir(root.path(), "9.9.9", "test-target");
        let error = install(root.path(), &final_dir, &artifact)
            .await
            .unwrap_err();
        assert!(error.contains("size"), "{error}");
        assert!(!final_dir.exists());
    }

    #[tokio::test]
    async fn a_named_file_missing_from_the_archive_installs_nothing() {
        let root = tempfile::tempdir().unwrap();
        let body = release_zip();
        let mut artifact = artifact(serve_once(body.clone()).await, &body);
        artifact
            .files
            .insert("THIRD_PARTY_NOTICES.md".into(), "release/NOTICES.md".into());
        let final_dir = install_dir(root.path(), "9.9.9", "test-target");
        assert!(install(root.path(), &final_dir, &artifact).await.is_err());
        assert!(!final_dir.exists());
        assert!(!final_dir.with_extension("tmp").exists());
    }

    #[test]
    fn installed_names_must_be_plain() {
        assert!(is_plain_file_name("cua-driver.exe"));
        for name in ["", ".", "..", "../x.exe", "a/b", "a\\b", "C:x.exe"] {
            assert!(!is_plain_file_name(name), "{name}");
        }
    }

    #[test]
    fn the_driver_env_turns_telemetry_and_updates_off() {
        let env: BTreeMap<_, _> = driver_env(Path::new("home")).into_iter().collect();
        assert_eq!(env["DO_NOT_TRACK"], "1");
        assert_eq!(env["CUA_DRIVER_RS_TELEMETRY_ENABLED"], "0");
        assert_eq!(env["CUA_TELEMETRY_ENABLED"], "false");
        assert_eq!(env["CUA_DRIVER_RS_UPDATE_CHECK"], "0");
        assert_eq!(env["CUA_DRIVER_PERMISSION_MODE"], "standard");
        assert!(is_driver_setting(std::ffi::OsStr::new(
            "cua_driver_dangerously_bypass_approvals"
        )));
        assert!(!is_driver_setting(std::ffi::OsStr::new("PATH")));
    }

    #[test]
    fn prune_keeps_the_pinned_version() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("1.0.0").join("t")).unwrap();
        std::fs::create_dir_all(root.path().join("0.9.0").join("t")).unwrap();
        std::fs::create_dir_all(driver_home(root.path())).unwrap();
        prune_superseded(root.path(), "1.0.0");
        assert!(root.path().join("1.0.0").exists());
        assert!(driver_home(root.path()).exists());
        assert!(!root.path().join("0.9.0").exists());
    }
}
