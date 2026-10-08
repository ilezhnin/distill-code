//! Explicit, isolated app-driver runtime fixture. It never attests production.
use super::execution::{digest, file_digest};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    kind: String,
    entrypoint: PathBuf,
    sha256: String,
}
struct Fixture {
    manifest: Manifest,
    revision: String,
    declared_root: PathBuf,
    declared_entrypoint: PathBuf,
}
static FIXTURE: OnceLock<Fixture> = OnceLock::new();

fn validate(root: &Path, manifest_path: &Path) -> Result<Fixture, String> {
    let declared_root = root.to_path_buf();
    if !manifest_path.is_absolute() {
        return Err("fixture manifest must be absolute".into());
    }
    crate::services::distill_root::reject_document_links(&declared_root, manifest_path)?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let path = manifest_path.canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(&root) {
        return Err("fixture manifest is outside the isolated run root".into());
    }
    crate::services::distill_root::reject_document_links(&root, &path)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 {
        return Err("fixture manifest exceeds its cap".into());
    }
    let mut manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let declared_entrypoint = manifest.entrypoint.clone();
    crate::services::distill_root::reject_document_links(&declared_root, &declared_entrypoint)?;
    if manifest.schema_version != 1
        || manifest.kind != "invented-native-text"
        || manifest.sha256.len() != 64
    {
        return Err("unsupported invented runtime manifest".into());
    }
    manifest.entrypoint = manifest
        .entrypoint
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !manifest.entrypoint.starts_with(&root) {
        return Err("fixture runtime is outside the isolated run root".into());
    }
    crate::services::distill_root::reject_document_links(&root, &manifest.entrypoint)?;
    if file_digest(&manifest.entrypoint)? != manifest.sha256 {
        return Err("fixture runtime bytes differ from the truthful manifest".into());
    }
    let revision = digest(format!(
        "invented-native-text-fixture-v1\0{}\0{}",
        digest(&bytes),
        manifest.sha256
    ));
    Ok(Fixture {
        manifest,
        revision,
        declared_root,
        declared_entrypoint,
    })
}

pub(crate) fn initialize(mode: &crate::services::e2e_mode::E2eMode) -> Result<(), String> {
    let Some(path) = std::env::var_os("DISTILL_E2E_NATIVE_FIXTURE_MANIFEST") else {
        return Ok(());
    };
    let fixture = validate(mode.driver_run_root(), Path::new(&path))?;
    FIXTURE
        .set(fixture)
        .map_err(|_| "native fixture was already initialized".to_string())
}

/// Rehash on every inventory/admission; a later edit cannot retain authority.
pub(crate) fn verified(path: &Path) -> Result<Option<String>, String> {
    let Some(fixture) = FIXTURE.get() else {
        return Ok(None);
    };
    crate::services::distill_root::reject_document_links(
        &fixture.declared_root,
        &fixture.declared_entrypoint,
    )?;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if path != fixture.manifest.entrypoint {
        return Ok(None);
    }
    if file_digest(&path)? != fixture.manifest.sha256 {
        return Err("invented runtime changed after isolation validation".into());
    }
    Ok(Some(fixture.revision.clone()))
}

pub(crate) fn active() -> bool {
    FIXTURE.get().is_some()
}
pub(crate) fn metadata() -> serde_json::Value {
    FIXTURE.get().map_or(serde_json::Value::Null, |fixture| serde_json::json!({"kind":"invented-native-text", "revision":fixture.revision, "entrypointSha256":fixture.manifest.sha256, "productionCompatible":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixture_requires_truthful_bytes_and_isolated_paths() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = root.path().join("invented.mjs");
        std::fs::write(&file, "invented protocol fixture").unwrap();
        let manifest = root.path().join("fixture.json");
        let write = |entry: &Path, hash: String| {
            std::fs::write(
                &manifest,
                serde_json::to_vec(&Manifest {
                    schema_version: 1,
                    kind: "invented-native-text".into(),
                    entrypoint: entry.to_path_buf(),
                    sha256: hash,
                })
                .unwrap(),
            )
            .unwrap()
        };
        write(&file, file_digest(&file).unwrap());
        let first = validate(root.path(), &manifest).unwrap().revision;
        assert_ne!(first, digest("production-native-text"));
        write(&file, "0".repeat(64));
        assert!(validate(root.path(), &manifest).is_err());
        let other = outside.path().join("other.mjs");
        std::fs::write(&other, "invented").unwrap();
        write(&other, file_digest(&other).unwrap());
        assert!(validate(root.path(), &manifest).is_err());
    }
}
