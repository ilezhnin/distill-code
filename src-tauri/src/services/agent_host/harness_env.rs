//! Process environment for bridge children: the user's login-shell env, the
//! managed bridge shims in front of PATH, and the distillctl shim/discovery
//! variables that let an agent running inside a session drive the app.

#[cfg(feature = "distillctl")]
use std::path::Path;
use std::path::PathBuf;
use tauri::Manager;

use super::bridge::SpawnEnv;
use crate::services::managed_acp_tools;

pub async fn build_spawn_env(app: &tauri::AppHandle) -> SpawnEnv {
    let shell_env = managed_acp_tools::provider_env(app).await;
    let mut prepend_dirs: Vec<PathBuf> = Vec::new();
    if let Some(bundle) = app
        .try_state::<crate::services::distro_bundle::DistroBundleState>()
        .and_then(|state| state.bundle().cloned())
    {
        if let Some(bin_dir) = bundle.bin_dir.as_ref() {
            prepend_dirs.push(bin_dir.clone());
        }
    }
    let mut extra_env = Vec::new();
    install_distillctl_shims(app, &mut prepend_dirs, &mut extra_env);
    SpawnEnv {
        shell_env,
        prepend_dirs,
        extra_env,
    }
}

#[cfg(feature = "distillctl")]
fn install_distillctl_shims(
    app: &tauri::AppHandle,
    prepend_dirs: &mut Vec<PathBuf>,
    extra_env: &mut Vec<(String, String)>,
) {
    let distillctl_bin = resolve_cli_bin("DISTILLCTL_BIN", &binary_name("distillctl"));
    let distill_monitor_bin =
        resolve_cli_bin("DISTILL_MONITOR_BIN", &binary_name("distill-monitor"));
    let app_data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(error) => {
            log::warn!("Skipping distillctl PATH shim: failed to resolve app data dir: {error}");
            return;
        }
    };
    let Ok(root) = crate::services::distill_root::app_root(app) else {
        return;
    };
    let shim_dir = root.join("cache").join("bin");
    let mut installed_any = false;
    if let Some(cli_path) = distillctl_bin.as_deref() {
        match create_cli_shim(&shim_dir, cli_path, shim_name("distillctl")) {
            Ok(()) => installed_any = true,
            Err(error) => log::warn!("Skipping distillctl PATH shim: {error}"),
        }
    }
    if let Some(cli_path) = distill_monitor_bin.as_deref() {
        match create_cli_shim(&shim_dir, cli_path, shim_name("distill-monitor")) {
            Ok(()) => installed_any = true,
            Err(error) => log::warn!("Skipping distill-monitor PATH shim: {error}"),
        }
    }
    if installed_any {
        prepend_dirs.push(shim_dir);
    }
    extra_env.push((
        "DISTILLCTL_LOCK".to_string(),
        tauri_plugin_distillctl::discovery_file_path(&app_data_dir, std::process::id())
            .to_string_lossy()
            .into_owned(),
    ));
    match distillctl_bin {
        Some(bin) => extra_env.push((
            "DISTILLCTL_BIN".to_string(),
            bin.to_string_lossy().into_owned(),
        )),
        None => log::warn!("Skipping DISTILLCTL_BIN: could not resolve the distillctl binary path"),
    }
}

#[cfg(not(feature = "distillctl"))]
fn install_distillctl_shims(
    _app: &tauri::AppHandle,
    _prepend_dirs: &mut Vec<PathBuf>,
    _extra_env: &mut Vec<(String, String)>,
) {
}

/// Explicit env override (exported by `just dev`, where externalBin is
/// empty) wins; otherwise the externalBin sidecar sits next to the app
/// executable.
#[cfg(feature = "distillctl")]
fn resolve_cli_bin(override_env: &str, binary_name: &str) -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var(override_env) {
        if !override_path.is_empty() {
            return Some(PathBuf::from(override_path));
        }
    }
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(binary_name))
}

#[cfg(feature = "distillctl")]
fn binary_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

#[cfg(feature = "distillctl")]
fn shim_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.cmd")
    } else {
        stem.to_string()
    }
}

/// Create or refresh the PATH shim that lets harness children run a bare
/// `distillctl`. Unix uses a symlink so the bundled binary stays authoritative;
/// Windows uses a `.cmd` wrapper because symlinks need elevated shells.
#[cfg(feature = "distillctl")]
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

#[cfg(all(feature = "distillctl", unix))]
fn create_cli_shim_file(cli_path: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(cli_path, link).map_err(|error| {
        format!(
            "failed to symlink {} -> {}: {error}",
            link.display(),
            cli_path.display()
        )
    })
}

#[cfg(all(feature = "distillctl", windows))]
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
