//! Process environment for bridge children: the user's login-shell env, the
//! managed bridge shims in front of PATH, and the berdctl shim/discovery
//! variables that let an agent running inside a session drive the app.

use std::collections::HashMap;
#[cfg(feature = "berdctl")]
use std::path::Path;
use std::path::PathBuf;
use tauri::Manager;

use super::bridge::SpawnEnv;
use crate::services::{dir_env, managed_acp_tools};

pub async fn build_spawn_env(app: &tauri::AppHandle) -> SpawnEnv {
    let mut shell_env: HashMap<String, String> = dir_env::capture_home_interactive_env().await;
    crate::services::shell_env::sanitize_shell_env(&mut shell_env);
    let mut prepend_dirs: Vec<PathBuf> = Vec::new();
    if let Some(bundle) = app
        .try_state::<crate::services::distro_bundle::DistroBundleState>()
        .and_then(|state| state.bundle().cloned())
    {
        if let Some(bin_dir) = bundle.bin_dir.as_ref() {
            prepend_dirs.push(bin_dir.clone());
        }
    }
    prepend_dirs.extend(managed_acp_tools::managed_prepend_dirs(app));
    let mut extra_env = Vec::new();
    install_berdctl_shims(app, &mut prepend_dirs, &mut extra_env);
    SpawnEnv {
        shell_env,
        prepend_dirs,
        extra_env,
    }
}

#[cfg(feature = "berdctl")]
fn install_berdctl_shims(
    app: &tauri::AppHandle,
    prepend_dirs: &mut Vec<PathBuf>,
    extra_env: &mut Vec<(String, String)>,
) {
    let berdctl_bin = resolve_cli_bin("BERDCTL_BIN", &binary_name("berdctl"));
    let berd_monitor_bin = resolve_cli_bin("BERD_MONITOR_BIN", &binary_name("berd-monitor"));
    let app_data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(error) => {
            log::warn!("Skipping berdctl PATH shim: failed to resolve app data dir: {error}");
            return;
        }
    };
    let shim_dir = app_data_dir.join("bin");
    let mut installed_any = false;
    if let Some(cli_path) = berdctl_bin.as_deref() {
        match create_cli_shim(&shim_dir, cli_path, shim_name("berdctl")) {
            Ok(()) => installed_any = true,
            Err(error) => log::warn!("Skipping berdctl PATH shim: {error}"),
        }
    }
    if let Some(cli_path) = berd_monitor_bin.as_deref() {
        match create_cli_shim(&shim_dir, cli_path, shim_name("berd-monitor")) {
            Ok(()) => installed_any = true,
            Err(error) => log::warn!("Skipping berd-monitor PATH shim: {error}"),
        }
    }
    if installed_any {
        prepend_dirs.push(shim_dir);
    }
    extra_env.push((
        "BERDCTL_LOCK".to_string(),
        tauri_plugin_berdctl::discovery_file_path(&app_data_dir, std::process::id())
            .to_string_lossy()
            .into_owned(),
    ));
    match berdctl_bin {
        Some(bin) => extra_env.push((
            "BERDCTL_BIN".to_string(),
            bin.to_string_lossy().into_owned(),
        )),
        None => log::warn!("Skipping BERDCTL_BIN: could not resolve the berdctl binary path"),
    }
}

#[cfg(not(feature = "berdctl"))]
fn install_berdctl_shims(
    _app: &tauri::AppHandle,
    _prepend_dirs: &mut Vec<PathBuf>,
    _extra_env: &mut Vec<(String, String)>,
) {
}

/// Explicit env override (exported by `just dev`, where externalBin is
/// empty) wins; otherwise the externalBin sidecar sits next to the app
/// executable.
#[cfg(feature = "berdctl")]
fn resolve_cli_bin(override_env: &str, binary_name: &str) -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var(override_env) {
        if !override_path.is_empty() {
            return Some(PathBuf::from(override_path));
        }
    }
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(binary_name))
}

#[cfg(feature = "berdctl")]
fn binary_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

#[cfg(feature = "berdctl")]
fn shim_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.cmd")
    } else {
        stem.to_string()
    }
}

/// Create or refresh the PATH shim that lets harness children run a bare
/// `berdctl`. Unix uses a symlink so the bundled binary stays authoritative;
/// Windows uses a `.cmd` wrapper because symlinks need elevated shells.
#[cfg(feature = "berdctl")]
fn create_cli_shim(shim_dir: &Path, cli_path: &Path, shim_name: String) -> Result<(), String> {
    if !cli_path.exists() {
        return Err(format!(
            "agent CLI binary not found at {}",
            cli_path.display()
        ));
    }
    std::fs::create_dir_all(shim_dir)
        .map_err(|error| format!("failed to create {}: {error}", shim_dir.display()))?;
    let link = shim_dir.join(shim_name);
    match std::fs::remove_file(&link) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to remove stale shim {}: {error}",
                link.display()
            ));
        }
    }
    create_cli_shim_file(cli_path, &link)
}

#[cfg(all(feature = "berdctl", unix))]
fn create_cli_shim_file(cli_path: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(cli_path, link).map_err(|error| {
        format!(
            "failed to symlink {} -> {}: {error}",
            link.display(),
            cli_path.display()
        )
    })
}

#[cfg(all(feature = "berdctl", windows))]
fn create_cli_shim_file(cli_path: &Path, link: &Path) -> Result<(), String> {
    let content = format!("@echo off\r\n\"{}\" %*\r\n", cli_path.to_string_lossy());
    std::fs::write(link, content).map_err(|error| {
        format!(
            "failed to write {} wrapper for {}: {error}",
            link.display(),
            cli_path.display()
        )
    })
}
