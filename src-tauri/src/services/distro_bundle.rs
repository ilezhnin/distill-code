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

/// The override for the bundled `distro` folder: the current spelling first,
/// then the one Distill builds read, so an existing developer environment
/// keeps working for one release.
const DISTRO_DIR_ENV: [&str; 2] = ["FLOCK_DISTRO_DIR", "DISTILL_DISTRO_DIR"];

fn resolve_distro_root(app_handle: &AppHandle) -> Result<Option<PathBuf>, String> {
    if let Some((name, override_dir)) = DISTRO_DIR_ENV
        .iter()
        .find_map(|name| env::var(name).ok().map(|value| (*name, value)))
    {
        let path = PathBuf::from(override_dir);
        if path.is_dir() {
            return Ok(Some(path));
        }
        return Err(format!(
            "{name} points to a non-directory path: {}",
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

    /// Compatibility pin: the current spelling first, the one Distill builds
    /// read second. A rename sweep that rewrites the fallback collapses the
    /// two and fails here.
    #[test]
    fn the_distro_dir_override_keeps_its_earlier_spelling_as_fallback() {
        assert_eq!(DISTRO_DIR_ENV[0], "FLOCK_DISTRO_DIR");
        assert_eq!(
            DISTRO_DIR_ENV[1],
            format!("{}_DISTRO_DIR", ["DIS", "TILL"].concat())
        );
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
