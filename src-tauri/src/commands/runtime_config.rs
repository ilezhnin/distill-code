use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const RUNTIME_CONFIG_DIR_NAME: &str = "runtime-config";
const FAKE_RUNTIME_CONFIG_FILE_NAME: &str = "fake-endpoint.json";
// Bundled runtime config staged into the Tauri resource dir (see the `resources`
// map in `tauri.conf.json`). This file is the runtime config source of truth,
// replacing the compiled-in `default_runtime_config()`.
pub(crate) const BUNDLED_RUNTIME_CONFIG_FILE_NAME: &str = "runtime-config.json";
const RUNTIME_CONFIG_SCHEMA_VERSION: u16 = 1;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeConfig {
    pub schema_version: u16,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub customer: Option<RuntimeIdentity>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace: Option<RuntimeIdentity>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub feature_toggles: Option<HashMap<String, bool>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub doctor: Option<RuntimeDoctorConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeIdentity {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDoctorConfig {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub internal_tooling_checks: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeConfigSource {
    AppDefault,
    BundledFile,
    FakeEndpoint,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeConfigUnavailableReason {
    Invalid,
    Missing,
    ReadFailed,
    UnsupportedBuild,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RuntimeConfigLoadResult {
    Ready {
        source: RuntimeConfigSource,
        config: Box<RuntimeConfig>,
    },
    Unavailable {
        source: RuntimeConfigSource,
        reason: RuntimeConfigUnavailableReason,
        message: String,
    },
}

pub struct RuntimeConfigState {
    fake_config_path: PathBuf,
    bundled_config_path: Option<PathBuf>,
    cached: Mutex<Option<RuntimeConfigLoadResult>>,
}

impl RuntimeConfigState {
    pub fn new(app_data_dir: PathBuf, bundled_config_path: Option<PathBuf>) -> Self {
        Self {
            fake_config_path: fake_runtime_config_path(&app_data_dir),
            bundled_config_path,
            cached: Mutex::new(None),
        }
    }

    pub async fn get(&self) -> Result<RuntimeConfigLoadResult, String> {
        if let Some(result) = self
            .cached
            .lock()
            .map_err(|_| "Runtime config cache lock poisoned".to_string())?
            .clone()
        {
            return Ok(result);
        }
        let result = load_runtime_config_from_source(
            &self.fake_config_path,
            self.bundled_config_path.as_deref(),
        )
        .await;
        self.replace_cache(result)
    }

    pub async fn ready_config(&self) -> Result<RuntimeConfig, String> {
        match self.get().await? {
            RuntimeConfigLoadResult::Ready { config, .. } => Ok(*config),
            RuntimeConfigLoadResult::Unavailable {
                reason, message, ..
            } => Err(format!(
                "Runtime config unavailable ({reason:?}): {message}"
            )),
        }
    }

    pub async fn refresh(&self) -> Result<RuntimeConfigLoadResult, String> {
        let result = load_runtime_config_from_source(
            &self.fake_config_path,
            self.bundled_config_path.as_deref(),
        )
        .await;
        self.replace_cache(result)
    }

    #[cfg(debug_assertions)]
    pub fn set_fake_config(
        &self,
        config: RuntimeConfig,
    ) -> Result<RuntimeConfigLoadResult, String> {
        validate_runtime_config(&config)?;
        write_fake_runtime_config_to_path(&self.fake_config_path, &config)?;
        self.replace_cache(RuntimeConfigLoadResult::Ready {
            source: RuntimeConfigSource::FakeEndpoint,
            config: Box::new(config),
        })
    }

    #[cfg(not(debug_assertions))]
    pub fn set_fake_config(
        &self,
        _config: RuntimeConfig,
    ) -> Result<RuntimeConfigLoadResult, String> {
        Ok(unsupported_fake_runtime_config())
    }

    #[cfg(debug_assertions)]
    pub async fn clear_fake_config(&self) -> Result<RuntimeConfigLoadResult, String> {
        match std::fs::remove_file(&self.fake_config_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to remove fake runtime config '{}': {error}",
                    self.fake_config_path.display()
                ))
            }
        }
        let result = load_runtime_config_from_source(
            &self.fake_config_path,
            self.bundled_config_path.as_deref(),
        )
        .await;
        self.replace_cache(result)
    }

    #[cfg(not(debug_assertions))]
    pub async fn clear_fake_config(&self) -> Result<RuntimeConfigLoadResult, String> {
        Ok(unsupported_fake_runtime_config())
    }

    fn replace_cache(
        &self,
        result: RuntimeConfigLoadResult,
    ) -> Result<RuntimeConfigLoadResult, String> {
        let mut cached = self
            .cached
            .lock()
            .map_err(|_| "Runtime config cache lock poisoned".to_string())?;
        *cached = Some(result.clone());
        Ok(result)
    }
}

fn fake_runtime_config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir
        .join(RUNTIME_CONFIG_DIR_NAME)
        .join(FAKE_RUNTIME_CONFIG_FILE_NAME)
}

async fn load_runtime_config_from_source(
    fake_config_path: &Path,
    bundled_config_path: Option<&Path>,
) -> RuntimeConfigLoadResult {
    #[cfg(debug_assertions)]
    if fake_config_path.exists() {
        return read_fake_runtime_config_from_path(fake_config_path);
    }
    #[cfg(not(debug_assertions))]
    let _ = fake_config_path;

    load_bundled_runtime_config_from_source(
        bundled_config_path,
        allow_bundled_runtime_config_default_fallback(),
    )
}

/// Read the bundled `runtime-config.json` staged into the Tauri resource dir.
/// Used as the runtime config source of truth.
fn load_bundled_runtime_config_from_source(
    bundled_config_path: Option<&Path>,
    allow_default_fallback: bool,
) -> RuntimeConfigLoadResult {
    match bundled_config_path {
        Some(path) if path.exists() => match read_bundled_runtime_config_from_path(path) {
            Ok(config) => {
                log::info!("using bundled runtime config '{}'", path.display());
                RuntimeConfigLoadResult::Ready {
                    source: RuntimeConfigSource::BundledFile,
                    config: Box::new(config),
                }
            }
            Err((reason, message)) => bundled_runtime_config_unavailable_or_default(
                reason,
                message,
                allow_default_fallback,
            ),
        },
        Some(path) => bundled_runtime_config_unavailable_or_default(
            RuntimeConfigUnavailableReason::Missing,
            format!("Bundled runtime config '{}' not found", path.display()),
            allow_default_fallback,
        ),
        None => bundled_runtime_config_unavailable_or_default(
            RuntimeConfigUnavailableReason::Missing,
            "Bundled runtime config path unavailable".to_string(),
            allow_default_fallback,
        ),
    }
}

fn allow_bundled_runtime_config_default_fallback() -> bool {
    cfg!(any(debug_assertions, test))
}

fn bundled_runtime_config_unavailable_or_default(
    reason: RuntimeConfigUnavailableReason,
    message: String,
    allow_default_fallback: bool,
) -> RuntimeConfigLoadResult {
    if allow_default_fallback {
        log::warn!("{message}; using compiled-in default runtime config");
        return default_runtime_config_result(RuntimeConfigSource::AppDefault);
    }

    log::error!("{message}");
    RuntimeConfigLoadResult::Unavailable {
        source: RuntimeConfigSource::BundledFile,
        reason,
        message,
    }
}

fn read_bundled_runtime_config_from_path(
    path: &Path,
) -> Result<RuntimeConfig, (RuntimeConfigUnavailableReason, String)> {
    let contents = std::fs::read_to_string(path).map_err(|error| {
        (
            RuntimeConfigUnavailableReason::ReadFailed,
            format!(
                "Failed to read bundled runtime config '{}': {error}",
                path.display()
            ),
        )
    })?;
    let config = serde_json::from_str::<RuntimeConfig>(&contents).map_err(|error| {
        (
            RuntimeConfigUnavailableReason::Invalid,
            format!(
                "Failed to parse bundled runtime config '{}': {error}",
                path.display()
            ),
        )
    })?;
    validate_runtime_config(&config).map_err(|error| {
        (
            RuntimeConfigUnavailableReason::Invalid,
            format!(
                "Bundled runtime config '{}' failed validation: {error}",
                path.display()
            ),
        )
    })?;
    Ok(config)
}

#[cfg(debug_assertions)]
fn read_fake_runtime_config_from_path(path: &Path) -> RuntimeConfigLoadResult {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) => {
            return RuntimeConfigLoadResult::Unavailable {
                source: RuntimeConfigSource::FakeEndpoint,
                reason: if error.kind() == std::io::ErrorKind::NotFound {
                    RuntimeConfigUnavailableReason::Missing
                } else {
                    RuntimeConfigUnavailableReason::ReadFailed
                },
                message: format!(
                    "Failed to read fake runtime config '{}': {error}",
                    path.display()
                ),
            }
        }
    };
    let config = match serde_json::from_str::<RuntimeConfig>(&contents) {
        Ok(config) => config,
        Err(error) => {
            return invalid_fake_runtime_config(format!(
                "Failed to parse fake runtime config '{}': {error}",
                path.display()
            ))
        }
    };
    if let Err(error) = validate_runtime_config(&config) {
        return invalid_fake_runtime_config(format!(
            "Fake runtime config '{}' failed validation: {error}",
            path.display()
        ));
    }
    RuntimeConfigLoadResult::Ready {
        source: RuntimeConfigSource::FakeEndpoint,
        config: Box::new(config),
    }
}

fn default_runtime_config_result(source: RuntimeConfigSource) -> RuntimeConfigLoadResult {
    let config = default_runtime_config();
    if let Err(error) = validate_runtime_config(&config) {
        return RuntimeConfigLoadResult::Unavailable {
            source,
            reason: RuntimeConfigUnavailableReason::Invalid,
            message: format!("Default runtime config failed validation: {error}"),
        };
    }
    RuntimeConfigLoadResult::Ready {
        source,
        config: Box::new(config),
    }
}

pub(crate) fn default_runtime_config() -> RuntimeConfig {
    RuntimeConfig {
        schema_version: RUNTIME_CONFIG_SCHEMA_VERSION,
        customer: None,
        workspace: None,
        feature_toggles: None,
        doctor: None,
    }
}

#[cfg(debug_assertions)]
fn invalid_fake_runtime_config(message: String) -> RuntimeConfigLoadResult {
    RuntimeConfigLoadResult::Unavailable {
        source: RuntimeConfigSource::FakeEndpoint,
        reason: RuntimeConfigUnavailableReason::Invalid,
        message,
    }
}

#[cfg(not(debug_assertions))]
fn unsupported_fake_runtime_config() -> RuntimeConfigLoadResult {
    RuntimeConfigLoadResult::Unavailable {
        source: RuntimeConfigSource::FakeEndpoint,
        reason: RuntimeConfigUnavailableReason::UnsupportedBuild,
        message: "Fake runtime config is only available in non-release builds.".to_string(),
    }
}

#[cfg(debug_assertions)]
fn write_fake_runtime_config_to_path(path: &Path, config: &RuntimeConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create fake runtime config directory '{}': {error}",
                parent.display()
            )
        })?;
    }
    let serialized = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Failed to serialize fake runtime config: {error}"))?;
    std::fs::write(path, serialized).map_err(|error| {
        format!(
            "Failed to write fake runtime config '{}': {error}",
            path.display()
        )
    })
}

fn validate_runtime_config(config: &RuntimeConfig) -> Result<(), String> {
    if config.schema_version != RUNTIME_CONFIG_SCHEMA_VERSION {
        return Err(format!(
            "schemaVersion must be {RUNTIME_CONFIG_SCHEMA_VERSION}"
        ));
    }
    if let Some(customer) = &config.customer {
        validate_identity(customer, "customer")?;
    }
    if let Some(workspace) = &config.workspace {
        validate_identity(workspace, "workspace")?;
    }
    if let Some(feature_toggles) = &config.feature_toggles {
        validate_feature_toggles(feature_toggles)?;
    }
    Ok(())
}

fn validate_identity(identity: &RuntimeIdentity, field: &str) -> Result<(), String> {
    validate_non_empty(&identity.id, &format!("{field}.id"))?;
    validate_optional_non_empty(
        identity.display_name.as_deref(),
        &format!("{field}.displayName"),
    )
}
fn validate_feature_toggles(feature_toggles: &HashMap<String, bool>) -> Result<(), String> {
    for key in feature_toggles.keys() {
        validate_non_empty(key, "featureToggles keys")?;
    }
    Ok(())
}
fn validate_optional_non_empty(value: Option<&str>, field: &str) -> Result<(), String> {
    if let Some(value) = value {
        validate_non_empty(value, field)?;
    }
    Ok(())
}
fn validate_non_empty(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    Ok(())
}

#[tauri::command]
pub async fn get_runtime_config(
    state: State<'_, RuntimeConfigState>,
) -> Result<RuntimeConfigLoadResult, String> {
    state.get().await
}

#[tauri::command]
pub async fn refresh_runtime_config(
    state: State<'_, RuntimeConfigState>,
) -> Result<RuntimeConfigLoadResult, String> {
    state.refresh().await
}

#[tauri::command]
pub fn set_fake_runtime_config(
    state: State<'_, RuntimeConfigState>,
    config: RuntimeConfig,
) -> Result<RuntimeConfigLoadResult, String> {
    state.set_fake_config(config)
}

#[tauri::command]
pub async fn clear_fake_runtime_config(
    state: State<'_, RuntimeConfigState>,
) -> Result<RuntimeConfigLoadResult, String> {
    state.clear_fake_config().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn valid_config() -> RuntimeConfig {
        RuntimeConfig {
            schema_version: RUNTIME_CONFIG_SCHEMA_VERSION,
            customer: Some(RuntimeIdentity {
                id: "customer-1".to_string(),
                display_name: Some("Customer One".to_string()),
            }),
            workspace: Some(RuntimeIdentity {
                id: "workspace-1".to_string(),
                display_name: Some("Workspace One".to_string()),
            }),
            feature_toggles: Some(HashMap::from([("doctor".to_string(), true)])),
            doctor: Some(RuntimeDoctorConfig {
                enabled: Some(true),
                internal_tooling_checks: Some(true),
            }),
        }
    }

    fn temp_state() -> (tempfile::TempDir, RuntimeConfigState) {
        let dir = tempdir().expect("temp dir");
        let state = RuntimeConfigState::new(dir.path().to_path_buf(), None);
        (dir, state)
    }

    fn restricted_bundled_config() -> RuntimeConfig {
        let mut config = default_runtime_config();
        config.feature_toggles = Some(HashMap::from([
            ("sampleFeature".to_string(), false),
            ("otherFeature".to_string(), false),
        ]));
        config
    }

    fn write_bundled_config(path: &Path, config: &RuntimeConfig) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create bundled config dir");
        }
        std::fs::write(
            path,
            serde_json::to_vec_pretty(config).expect("serialize bundled config"),
        )
        .expect("write bundled config");
    }

    // Build a state whose bundled config path lives under the temp dir. When
    // `bundled` is provided, the file is written; otherwise the path is supplied
    // but the file is absent (exercising the missing-file fallback).
    fn temp_state_with_bundled(
        bundled: Option<&RuntimeConfig>,
    ) -> (tempfile::TempDir, RuntimeConfigState) {
        let dir = tempdir().expect("temp dir");
        let bundled_path = dir
            .path()
            .join("resources")
            .join(BUNDLED_RUNTIME_CONFIG_FILE_NAME);
        if let Some(config) = bundled {
            write_bundled_config(&bundled_path, config);
        }
        let state = RuntimeConfigState::new(dir.path().to_path_buf(), Some(bundled_path));
        (dir, state)
    }

    fn expect_ready(result: RuntimeConfigLoadResult) -> (RuntimeConfigSource, RuntimeConfig) {
        match result {
            RuntimeConfigLoadResult::Ready { source, config } => (source, *config),
            other => panic!("expected ready result, got {other:?}"),
        }
    }

    fn expect_unavailable(
        result: RuntimeConfigLoadResult,
    ) -> (RuntimeConfigSource, RuntimeConfigUnavailableReason, String) {
        match result {
            RuntimeConfigLoadResult::Unavailable {
                source,
                reason,
                message,
            } => (source, reason, message),
            other => panic!("expected unavailable result, got {other:?}"),
        }
    }

    #[test]
    fn validates_complete_runtime_config() {
        validate_runtime_config(&valid_config()).expect("valid config");
    }

    #[test]
    fn default_runtime_config_is_valid() {
        validate_runtime_config(&default_runtime_config()).expect("default config");
    }

    #[test]
    fn bundled_runtime_config_resource_is_valid_and_carries_no_restrictive_toggles() {
        // Pins the checked-in resource that ships as the official default source
        // of truth (bundled via tauri.conf.json `resources`). It must parse
        // against the real `deny_unknown_fields` struct and validate.
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(BUNDLED_RUNTIME_CONFIG_FILE_NAME);
        let contents = std::fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("read bundled runtime config '{}': {error}", path.display())
        });
        let config = serde_json::from_str::<RuntimeConfig>(&contents)
            .unwrap_or_else(|error| panic!("parse bundled runtime config: {error}"));
        validate_runtime_config(&config).expect("bundled runtime config must validate");

        // The official default disables nothing: all features ship ON. Feature
        // disabling is supplied only at custom-build time and is not committed
        // here.
        let toggles = config.feature_toggles.clone().unwrap_or_default();
        assert!(
            toggles.is_empty(),
            "official default must not carry feature toggles, got {toggles:?}"
        );
    }

    #[test]
    fn read_fake_runtime_config_from_path_round_trips_and_reports_errors() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("fake.json");
        write_fake_runtime_config_to_path(&path, &valid_config()).expect("write fake config");

        let (source, config) = expect_ready(read_fake_runtime_config_from_path(&path));
        assert_eq!(source, RuntimeConfigSource::FakeEndpoint);
        assert_eq!(config, valid_config());

        std::fs::write(&path, r#"{"schemaVersion":2}"#).expect("write invalid config");
        let (source, reason, message) =
            expect_unavailable(read_fake_runtime_config_from_path(&path));
        assert_eq!(source, RuntimeConfigSource::FakeEndpoint);
        assert_eq!(reason, RuntimeConfigUnavailableReason::Invalid);
        assert!(message.contains("failed validation") || message.contains("Failed to parse"));

        let missing = dir.path().join("missing.json");
        let (source, reason, message) =
            expect_unavailable(read_fake_runtime_config_from_path(&missing));
        assert_eq!(source, RuntimeConfigSource::FakeEndpoint);
        assert_eq!(reason, RuntimeConfigUnavailableReason::Missing);
        assert!(message.contains("Failed to read fake runtime config"));
    }

    #[tokio::test]
    async fn runtime_config_state_get_caches_until_refresh() {
        let (_dir, state) = temp_state();
        let mut first = valid_config();
        first.feature_toggles = Some(HashMap::from([("first".to_string(), true)]));
        let mut second = valid_config();
        second.feature_toggles = Some(HashMap::from([("second".to_string(), true)]));
        write_fake_runtime_config_to_path(&state.fake_config_path, &first).expect("write first");

        let (_, config) = expect_ready(state.get().await.expect("get first"));
        assert_eq!(config.feature_toggles, first.feature_toggles);

        write_fake_runtime_config_to_path(&state.fake_config_path, &second).expect("write second");
        let (_, cached) = expect_ready(state.get().await.expect("get cached"));
        assert_eq!(cached.feature_toggles, first.feature_toggles);

        let (_, refreshed) = expect_ready(state.refresh().await.expect("refresh"));
        assert_eq!(refreshed.feature_toggles, second.feature_toggles);
    }

    #[tokio::test]
    async fn runtime_config_state_clear_fake_config_restores_default_and_removes_file() {
        let (_dir, state) = temp_state();
        state
            .set_fake_config(valid_config())
            .expect("set fake config");
        assert!(state.fake_config_path.exists());

        let (source, config) =
            expect_ready(state.clear_fake_config().await.expect("clear fake config"));
        assert_eq!(source, RuntimeConfigSource::AppDefault);
        assert_eq!(config, default_runtime_config());
        assert!(!state.fake_config_path.exists());
    }

    #[tokio::test]
    async fn runtime_config_state_ready_config_returns_default_when_none_saved() {
        let (_dir, state) = temp_state();

        let result = state.get().await.expect("get default");
        let (source, config) = expect_ready(result);
        assert_eq!(source, RuntimeConfigSource::AppDefault);
        assert_eq!(config, default_runtime_config());

        let ready = state.ready_config().await.expect("ready default config");
        assert_eq!(ready, default_runtime_config());
    }

    #[tokio::test]
    async fn runtime_config_state_ready_config_surfaces_validation_errors() {
        let (_dir, state) = temp_state();
        std::fs::create_dir_all(state.fake_config_path.parent().expect("parent"))
            .expect("create dir");
        std::fs::write(&state.fake_config_path, r#"{"schemaVersion":2}"#)
            .expect("write invalid fake config");

        let error = state
            .ready_config()
            .await
            .expect_err("invalid fake config should fail ready_config");
        assert!(error.contains("Runtime config unavailable"));
        assert!(error.contains("Invalid"));
    }

    #[tokio::test]
    async fn load_uses_bundled_runtime_config_when_present() {
        let bundled = restricted_bundled_config();
        let (_dir, state) = temp_state_with_bundled(Some(&bundled));

        let (source, config) = expect_ready(state.get().await.expect("get bundled config"));
        assert_eq!(source, RuntimeConfigSource::BundledFile);
        assert_eq!(config, bundled);
        assert_eq!(
            config.feature_toggles,
            Some(HashMap::from([
                ("sampleFeature".to_string(), false),
                ("otherFeature".to_string(), false),
            ]))
        );
    }

    #[tokio::test]
    async fn load_uses_dev_default_fallback_when_bundled_runtime_config_missing() {
        let (_dir, state) = temp_state_with_bundled(None);

        let (source, config) = expect_ready(state.get().await.expect("get default config"));
        assert_eq!(source, RuntimeConfigSource::AppDefault);
        assert_eq!(config, default_runtime_config());
    }

    #[tokio::test]
    async fn load_uses_dev_default_fallback_when_bundled_runtime_config_invalid() {
        let dir = tempdir().expect("temp dir");
        let bundled_path = dir
            .path()
            .join("resources")
            .join(BUNDLED_RUNTIME_CONFIG_FILE_NAME);
        std::fs::create_dir_all(bundled_path.parent().expect("parent")).expect("create dir");
        std::fs::write(&bundled_path, r#"{"schemaVersion":2}"#)
            .expect("write invalid bundled config");
        let state = RuntimeConfigState::new(dir.path().to_path_buf(), Some(bundled_path));

        let (source, config) =
            expect_ready(state.get().await.expect("get fallback default config"));
        assert_eq!(source, RuntimeConfigSource::AppDefault);
        assert_eq!(config, default_runtime_config());
    }

    #[test]
    fn bundled_runtime_config_fails_closed_when_missing_and_fallback_disabled() {
        let dir = tempdir().expect("temp dir");
        let bundled_path = dir
            .path()
            .join("resources")
            .join(BUNDLED_RUNTIME_CONFIG_FILE_NAME);

        let (source, reason, message) = expect_unavailable(
            load_bundled_runtime_config_from_source(Some(&bundled_path), false),
        );

        assert_eq!(source, RuntimeConfigSource::BundledFile);
        assert_eq!(reason, RuntimeConfigUnavailableReason::Missing);
        assert!(message.contains("not found"));
    }

    #[test]
    fn bundled_runtime_config_fails_closed_when_path_unavailable_and_fallback_disabled() {
        let (source, reason, message) =
            expect_unavailable(load_bundled_runtime_config_from_source(None, false));

        assert_eq!(source, RuntimeConfigSource::BundledFile);
        assert_eq!(reason, RuntimeConfigUnavailableReason::Missing);
        assert!(message.contains("path unavailable"));
    }

    #[test]
    fn bundled_runtime_config_fails_closed_when_invalid_and_fallback_disabled() {
        let dir = tempdir().expect("temp dir");
        let bundled_path = dir
            .path()
            .join("resources")
            .join(BUNDLED_RUNTIME_CONFIG_FILE_NAME);
        std::fs::create_dir_all(bundled_path.parent().expect("parent")).expect("create dir");
        std::fs::write(&bundled_path, r#"{"schemaVersion":2}"#)
            .expect("write invalid bundled config");

        let (source, reason, message) = expect_unavailable(
            load_bundled_runtime_config_from_source(Some(&bundled_path), false),
        );

        assert_eq!(source, RuntimeConfigSource::BundledFile);
        assert_eq!(reason, RuntimeConfigUnavailableReason::Invalid);
        assert!(message.contains("failed validation") || message.contains("Failed to parse"));
    }
}
