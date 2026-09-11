//! Validated process-isolation contract for app-driver E2E runs.
//!
//! This mode is intentionally gated twice: the binary must include the
//! `app-test-driver` feature and the launcher must explicitly set
//! `BERD_E2E_MODE=1`. A feature-only developer build therefore does not expose
//! the loopback driver or redirect persistent state.

use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};

pub(crate) const MODE_ENV: &str = "BERD_E2E_MODE";
pub(crate) const RUN_ID_ENV: &str = "BERD_E2E_RUN_ID";
pub(crate) const RUN_ROOT_ENV: &str = "BERD_E2E_RUN_ROOT";
pub(crate) const DRIVER_TOKEN_ENV: &str = "APP_TEST_DRIVER_TOKEN";
pub(crate) const RUNTIME_CONFIG_ENV: &str = "BERD_E2E_RUNTIME_CONFIG";
pub(crate) const APP_IDENTIFIER_PREFIX: &str = "xyz.block.berd.e2e.";

pub(crate) const BB_HOME_ENV: &str = "BB_HOME";
pub(crate) const BB_AUTH_STORAGE_ENV: &str = "BB_AUTH_STORAGE";
pub(crate) const BB_AUTH_STORAGE_FILE_ENV: &str = "BB_AUTH_STORAGE_FILE";

const AGENTS_DIR_NAME: &str = "home";
const BUILDERBOT_DIR_NAME: &str = "builderbot";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct E2eMode {
    run_id: String,
    run_root: PathBuf,
    agents_home: PathBuf,
    builderbot_root: PathBuf,
    driver_token: String,
    runtime_config_path: Option<PathBuf>,
}

impl E2eMode {
    pub(crate) fn from_process_env(app_identifier: &str) -> Result<Option<Self>, String> {
        Self::from_values(
            cfg!(feature = "app-test-driver"),
            std::env::var_os(MODE_ENV),
            std::env::var_os(RUN_ID_ENV),
            std::env::var_os(RUN_ROOT_ENV),
            std::env::var_os(DRIVER_TOKEN_ENV),
            std::env::var_os(RUNTIME_CONFIG_ENV),
            app_identifier,
        )
    }

    fn from_values(
        driver_feature_enabled: bool,
        mode: Option<OsString>,
        expected_run_id: Option<OsString>,
        run_root: Option<OsString>,
        driver_token: Option<OsString>,
        runtime_config_path: Option<OsString>,
        app_identifier: &str,
    ) -> Result<Option<Self>, String> {
        match mode.as_deref() {
            None => return Ok(None),
            Some(value) if value != OsStr::new("1") => {
                return Err(format!("{MODE_ENV} must be exactly 1 when set"));
            }
            Some(_) => {}
        }

        if !driver_feature_enabled {
            return Err(format!(
                "{MODE_ENV}=1 requires a binary built with the app-test-driver feature"
            ));
        }

        let run_id = validate_app_identifier(app_identifier)?;
        let expected_run_id = expected_run_id
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{RUN_ID_ENV} is required when {MODE_ENV}=1"))?;
        if expected_run_id != OsStr::new(run_id) {
            return Err(format!(
                "{RUN_ID_ENV} must match the E2E app identifier run ID '{run_id}'"
            ));
        }
        let run_root = run_root
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| format!("{RUN_ROOT_ENV} is required when {MODE_ENV}=1"))?;
        validate_run_root(&run_root)?;
        validate_run_root_matches_identifier(&run_root, run_id)?;
        let driver_token = validate_driver_token(driver_token)?;
        let runtime_config_path = validate_runtime_config_path(runtime_config_path, &run_root)?;

        Ok(Some(Self {
            run_id: run_id.to_string(),
            agents_home: run_root.join(AGENTS_DIR_NAME),
            builderbot_root: run_root.join(BUILDERBOT_DIR_NAME),
            run_root,
            driver_token,
            runtime_config_path,
        }))
    }

    pub(crate) fn enforce_process_env(&self) -> Result<(), String> {
        for path in [&self.run_root, &self.agents_home, &self.builderbot_root] {
            std::fs::create_dir_all(path).map_err(|error| {
                format!(
                    "failed to create isolated E2E directory {}: {error}",
                    path.display()
                )
            })?;
        }

        // SAFETY: `run` calls this on the main thread before Tauri starts any
        // worker threads or app services. The values remain fixed for the life
        // of the process; no production code mutates these variables later.
        unsafe {
            std::env::set_var(BB_HOME_ENV, &self.builderbot_root);
            std::env::set_var(BB_AUTH_STORAGE_ENV, "memory");
            std::env::remove_var(BB_AUTH_STORAGE_FILE_ENV);
        }
        Ok(())
    }

    pub(crate) fn agents_root(&self) -> PathBuf {
        self.agents_home.join(".agents")
    }

    pub(crate) fn agents_dir(&self) -> PathBuf {
        self.agents_root().join("agents")
    }

    pub(crate) fn skills_dir(&self) -> PathBuf {
        self.agents_root().join("skills")
    }

    #[cfg(feature = "app-test-driver")]
    pub(crate) fn driver_token(&self) -> &str {
        &self.driver_token
    }

    #[cfg(feature = "app-test-driver")]
    pub(crate) fn driver_run_root(&self) -> &Path {
        &self.run_root
    }

    pub(crate) fn runtime_config_path(&self) -> Option<&Path> {
        self.runtime_config_path.as_deref()
    }

    pub(crate) fn log_enabled(&self) {
        log::info!("Isolated E2E mode enabled for run {}", self.run_id);
    }
}

fn validate_runtime_config_path(
    value: Option<OsString>,
    run_root: &Path,
) -> Result<Option<PathBuf>, String> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!("{RUNTIME_CONFIG_ENV} must be an absolute path"));
    }
    if path.parent() != Some(run_root)
        || path.file_name() != Some(OsStr::new("runtime-config.json"))
    {
        return Err(format!(
            "{RUNTIME_CONFIG_ENV} must be the run-scoped runtime-config.json"
        ));
    }
    if !path.is_file() {
        return Err(format!(
            "{RUNTIME_CONFIG_ENV} must reference an existing file"
        ));
    }
    Ok(Some(path))
}

fn validate_driver_token(value: Option<OsString>) -> Result<String, String> {
    let value = value
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{DRIVER_TOKEN_ENV} is required when {MODE_ENV}=1"))?;
    let token = value
        .into_string()
        .map_err(|_| format!("{DRIVER_TOKEN_ENV} must be valid UTF-8"))?;
    if token.len() < 32
        || token.len() > 128
        || !token.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(format!(
            "{DRIVER_TOKEN_ENV} must be 32-128 ASCII letters or digits"
        ));
    }
    Ok(token)
}

fn validate_app_identifier(identifier: &str) -> Result<&str, String> {
    let run_id = identifier
        .strip_prefix(APP_IDENTIFIER_PREFIX)
        .ok_or_else(|| {
            format!("{MODE_ENV}=1 requires an app identifier under {APP_IDENTIFIER_PREFIX}<run-id>")
        })?;

    if run_id.is_empty()
        || run_id.len() > 64
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(
            "E2E app identifier run ID must be 1-64 ASCII letters, digits, or '-'".to_string(),
        );
    }

    Ok(run_id)
}

fn validate_run_root(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{RUN_ROOT_ENV} must be an absolute path"));
    }
    if !path
        .components()
        .any(|component| matches!(component, Component::Normal(_)))
    {
        return Err(format!("{RUN_ROOT_ENV} must not be a filesystem root"));
    }
    if path
        .as_os_str()
        .to_string_lossy()
        .split(std::path::is_separator)
        .any(|segment| matches!(segment, "." | ".."))
    {
        return Err(format!(
            "{RUN_ROOT_ENV} must be normalized and cannot contain '.' or '..' components"
        ));
    }
    Ok(())
}

fn validate_run_root_matches_identifier(path: &Path, run_id: &str) -> Result<(), String> {
    if path.file_name() != Some(OsStr::new(run_id)) {
        return Err(format!(
            "{RUN_ROOT_ENV} must end with the E2E app identifier run ID '{run_id}'"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    const RUN_ID: &str = "run-123";
    const IDENTIFIER: &str = "xyz.block.berd.e2e.run-123";

    #[test]
    fn feature_only_and_runtime_only_do_not_enable_e2e_mode() {
        assert_eq!(
            E2eMode::from_values(true, None, None, None, None, None, "xyz.block.berd.dev").unwrap(),
            None
        );
        assert!(E2eMode::from_values(
            false,
            Some(OsString::from("1")),
            Some(OsString::from(RUN_ID)),
            Some(absolute_test_root()),
            Some(valid_driver_token()),
            None,
            IDENTIFIER,
        )
        .unwrap_err()
        .contains("app-test-driver"));
    }

    #[test]
    fn rejects_production_dev_and_malformed_identifiers() {
        for identifier in [
            "xyz.block.berd",
            "xyz.block.berd.dev",
            "xyz.block.berd.e2e.",
            "xyz.block.berd.e2e.run.with.dot",
            "xyz.block.berd.e2e.run_with_underscore",
            "xyz.block.berd.e2e.run/escape",
        ] {
            assert!(E2eMode::from_values(
                true,
                Some(OsString::from("1")),
                Some(OsString::from(RUN_ID)),
                Some(absolute_test_root()),
                Some(valid_driver_token()),
                None,
                identifier,
            )
            .is_err());
        }
    }

    #[test]
    fn requires_a_strong_ascii_driver_token() {
        for token in [
            None,
            Some(OsString::from("too-short")),
            Some(OsString::from("invalid-token-with-punctuation!!!!!!!!")),
        ] {
            let error = E2eMode::from_values(
                true,
                Some(OsString::from("1")),
                Some(OsString::from(RUN_ID)),
                Some(absolute_test_root()),
                token,
                None,
                IDENTIFIER,
            )
            .unwrap_err();
            assert!(
                error.contains(DRIVER_TOKEN_ENV),
                "unexpected error: {error}"
            );
        }
    }

    #[test]
    fn process_setup_creates_only_run_scoped_state() {
        let _guard = crate::test_support::env_lock().lock().expect("env lock");
        let temp = tempfile::tempdir().unwrap();
        let run_root = temp.path().join(RUN_ID);
        let normal_berd_root = temp.path().join("xyz.block.berd.dev");
        let normal_builderbot_root = temp.path().join("normal-builderbot");
        std::fs::create_dir_all(&normal_berd_root).unwrap();
        std::fs::create_dir_all(&normal_builderbot_root).unwrap();
        std::fs::write(normal_berd_root.join("sentinel"), b"berd").unwrap();
        std::fs::write(normal_builderbot_root.join("sentinel"), b"builderbot").unwrap();

        let saved = save_env([BB_HOME_ENV, BB_AUTH_STORAGE_ENV, BB_AUTH_STORAGE_FILE_ENV]);
        // SAFETY: this test holds the crate-wide environment lock.
        unsafe {
            std::env::set_var(BB_HOME_ENV, &normal_builderbot_root);
            std::env::set_var(BB_AUTH_STORAGE_ENV, "file");
            std::env::set_var(
                BB_AUTH_STORAGE_FILE_ENV,
                normal_builderbot_root.join("auth.json"),
            );
        }

        enabled_mode(run_root.clone())
            .enforce_process_env()
            .unwrap();

        assert_eq!(
            std::env::var_os(BB_HOME_ENV),
            Some(run_root.join(BUILDERBOT_DIR_NAME).into_os_string())
        );
        assert_eq!(
            std::env::var_os(BB_AUTH_STORAGE_ENV),
            Some(OsString::from("memory"))
        );
        assert_eq!(std::env::var_os(BB_AUTH_STORAGE_FILE_ENV), None);
        assert_eq!(
            std::fs::read(normal_berd_root.join("sentinel")).unwrap(),
            b"berd"
        );
        assert_eq!(
            std::fs::read(normal_builderbot_root.join("sentinel")).unwrap(),
            b"builderbot"
        );
        assert_eq!(std::fs::read_dir(&normal_berd_root).unwrap().count(), 1);
        assert_eq!(
            std::fs::read_dir(&normal_builderbot_root).unwrap().count(),
            1
        );

        restore_env(saved);
    }

    fn enabled_mode(run_root: PathBuf) -> E2eMode {
        E2eMode::from_values(
            true,
            Some(OsString::from("1")),
            Some(OsString::from(RUN_ID)),
            Some(run_root.into_os_string()),
            Some(valid_driver_token()),
            None,
            IDENTIFIER,
        )
        .unwrap()
        .unwrap()
    }

    fn valid_driver_token() -> OsString {
        OsString::from("0123456789abcdef0123456789abcdef")
    }

    fn absolute_test_base() -> PathBuf {
        #[cfg(windows)]
        {
            PathBuf::from(r"C:\berd-e2e-mode-tests")
        }
        #[cfg(not(windows))]
        {
            PathBuf::from("/tmp/berd-e2e-mode-tests")
        }
    }

    fn absolute_test_root() -> OsString {
        absolute_test_base().join(RUN_ID).into_os_string()
    }

    fn save_env<const N: usize>(names: [&'static str; N]) -> Vec<(&'static str, Option<OsString>)> {
        names
            .into_iter()
            .map(|name| (name, std::env::var_os(name)))
            .collect()
    }

    fn restore_env(saved: Vec<(&'static str, Option<OsString>)>) {
        // SAFETY: this test still holds the crate-wide environment lock.
        unsafe {
            for (name, value) in saved {
                if let Some(value) = value {
                    std::env::set_var(name, value);
                } else {
                    std::env::remove_var(name);
                }
            }
        }
    }
}
