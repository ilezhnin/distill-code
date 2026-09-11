use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use url::Url;

const DISTRO_DIR_NAME: &str = "distro";
const DISTRO_JSON_NAME: &str = "distro.json";
const DISTRO_BIN_DIR_NAME: &str = "bin";

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistroManifest {
    pub app_version: Option<String>,
    pub distribution: Option<DistributionDistroConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionDistroConfig {
    npm_registry_url: String,
    node_dist_base_url: String,
}

impl DistributionDistroConfig {
    pub fn npm_registry_url(&self) -> &str {
        &self.npm_registry_url
    }

    pub fn node_dist_base_url(&self) -> &str {
        &self.node_dist_base_url
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistroBundleInfo {
    pub present: bool,
    #[serde(flatten)]
    pub manifest: DistroManifest,
}

#[derive(Debug, Clone)]
pub struct DistroBundle {
    pub root_dir: PathBuf,
    pub bin_dir: Option<PathBuf>,
    pub manifest: DistroManifest,
}

pub struct DistroBundleState {
    bundle: Option<DistroBundle>,
}

impl DistroBundleState {
    pub fn new(app_handle: &AppHandle) -> Self {
        let bundle = load_distro_bundle(app_handle)
            .map_err(|error| {
                log::warn!("Failed to load distro bundle: {error}");
                error
            })
            .ok()
            .flatten();

        Self { bundle }
    }

    #[cfg(test)]
    pub(crate) fn empty_for_tests() -> Self {
        Self { bundle: None }
    }

    #[cfg(test)]
    pub(crate) fn with_manifest_for_tests(manifest: DistroManifest) -> Self {
        Self {
            bundle: Some(DistroBundle {
                root_dir: PathBuf::new(),
                bin_dir: None,
                manifest,
            }),
        }
    }

    pub fn info(&self) -> DistroBundleInfo {
        match &self.bundle {
            Some(bundle) => DistroBundleInfo {
                present: true,
                manifest: bundle.manifest.clone(),
            },
            None => DistroBundleInfo {
                present: false,
                manifest: DistroManifest::default(),
            },
        }
    }

    pub fn bundle(&self) -> Option<&DistroBundle> {
        self.bundle.as_ref()
    }

    pub fn distribution_config(&self) -> Option<&DistributionDistroConfig> {
        self.bundle
            .as_ref()
            .and_then(|bundle| bundle.manifest.distribution.as_ref())
    }
}

fn load_distro_bundle(app_handle: &AppHandle) -> Result<Option<DistroBundle>, String> {
    let Some(root_dir) = resolve_distro_root(app_handle)? else {
        return Ok(None);
    };

    Ok(Some(load_distro_bundle_from_root(root_dir)?))
}

fn load_distro_bundle_from_root(root_dir: PathBuf) -> Result<DistroBundle, String> {
    let manifest_path = root_dir.join(DISTRO_JSON_NAME);
    let manifest = if manifest_path.exists() {
        read_manifest(&manifest_path)?
    } else {
        DistroManifest::default()
    };
    let bin_dir = root_dir.join(DISTRO_BIN_DIR_NAME);

    Ok(DistroBundle {
        root_dir,
        bin_dir: bin_dir.is_dir().then_some(bin_dir),
        manifest,
    })
}

fn resolve_distro_root(app_handle: &AppHandle) -> Result<Option<PathBuf>, String> {
    if let Ok(override_dir) = env::var("DISTILL_DISTRO_DIR") {
        let path = PathBuf::from(override_dir);
        if path.is_dir() {
            return Ok(Some(path));
        }
        return Err(format!(
            "DISTILL_DISTRO_DIR points to a non-directory path: {}",
            path.display()
        ));
    }

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve Tauri resource dir: {error}"))?;
    let distro_dir = resource_dir.join(DISTRO_DIR_NAME);

    Ok(distro_dir.is_dir().then_some(distro_dir))
}

fn read_manifest(path: &Path) -> Result<DistroManifest, String> {
    let contents = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "Failed to read distro manifest '{}': {error}",
            path.display()
        )
    })?;

    let mut manifest = serde_json::from_str::<DistroManifest>(&contents).map_err(|error| {
        format!(
            "Failed to parse distro manifest '{}': {error}",
            path.display()
        )
    })?;

    if let Some(distribution) = manifest.distribution.as_mut() {
        validate_distribution_config(distribution)?;
    }

    Ok(manifest)
}

fn validate_distribution_config(config: &mut DistributionDistroConfig) -> Result<(), String> {
    for (name, value) in [
        ("npmRegistryUrl", &mut config.npm_registry_url),
        ("nodeDistBaseUrl", &mut config.node_dist_base_url),
    ] {
        let mut url = Url::parse(value)
            .map_err(|error| format!("distribution.{name} must be a valid URL: {error}"))?;
        if url.scheme() != "https" {
            return Err(format!("distribution.{name} must use HTTPS"));
        }
        if url.host_str().is_none() {
            return Err(format!("distribution.{name} must include a host"));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(format!("distribution.{name} must not include credentials"));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(format!(
                "distribution.{name} must not include a query or fragment"
            ));
        }
        if !url.path().ends_with('/') {
            url.set_path(&format!("{}/", url.path()));
        }
        *value = url.into();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_bundle_assets_without_manifest() {
        let root_dir = tempfile::tempdir().expect("temp distro root");
        let bin_dir = root_dir.path().join(DISTRO_BIN_DIR_NAME);
        std::fs::create_dir(&bin_dir).expect("create bin dir");

        let bundle = load_distro_bundle_from_root(root_dir.path().to_path_buf())
            .expect("bundle should load without manifest");

        assert_eq!(bundle.root_dir, root_dir.path());
        assert_eq!(bundle.bin_dir.as_deref(), Some(bin_dir.as_path()));
        assert!(bundle.manifest.app_version.is_none());
    }

    #[test]
    fn parses_partial_manifest() {
        let manifest = parse_manifest(
            r#"{
                "appVersion": "development"
            }"#,
        )
        .expect("manifest should parse");

        assert_eq!(manifest.app_version.as_deref(), Some("development"));
        assert!(manifest.distribution.is_none());
    }

    #[test]
    fn parses_complete_distribution_and_normalizes_base_urls() {
        let manifest = parse_manifest(r#"{"distribution":{"npmRegistryUrl":"https://packages.example.test/npm","nodeDistBaseUrl":"https://node.example.test"}}"#).expect("complete distribution should parse");
        let distribution = manifest
            .distribution
            .expect("distribution should be present");
        assert_eq!(
            distribution.npm_registry_url(),
            "https://packages.example.test/npm/"
        );
        assert_eq!(
            distribution.node_dist_base_url(),
            "https://node.example.test/"
        );
    }

    #[test]
    fn rejects_partial_distribution() {
        let error = parse_manifest(
            r#"{"distribution":{"npmRegistryUrl":"https://packages.example.test/"}}"#,
        )
        .expect_err("partial distribution should be rejected");
        assert!(error.contains("missing field"), "{error}");
    }

    #[test]
    fn rejects_insecure_or_credential_bearing_distribution_urls() {
        for url in [
            "http://packages.example.test/npm/",
            "https://user:password@packages.example.test/npm/",
        ] {
            let error = parse_manifest(&distribution_manifest(url)).expect_err("URL should fail");
            assert!(
                error.contains("must use HTTPS") || error.contains("must not include credentials"),
                "{error}"
            );
        }
    }

    fn parse_manifest(contents: &str) -> Result<DistroManifest, String> {
        let path = tempfile::NamedTempFile::new().expect("temporary manifest");
        std::fs::write(path.path(), contents).expect("write temporary manifest");
        read_manifest(path.path())
    }

    fn distribution_manifest(npm_registry_url: &str) -> String {
        format!(
            r#"{{"distribution":{{"npmRegistryUrl":"{npm_registry_url}","nodeDistBaseUrl":"https://node.example.test/dist/"}}}}"#
        )
    }
}
