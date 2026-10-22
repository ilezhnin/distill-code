//! Explicit, isolated app-driver runtime fixture. It never attests production.
use super::execution::digest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, OnceLock},
    time::SystemTime,
};

type FileVersion = (u64, Option<SystemTime>, Option<SystemTime>);

/// The sha256 of a file, computed once per version of it. A replaced file
/// changes its size, modification or creation time; npm stamps one fixed
/// modification time on every file it unpacks, so the creation time is what
/// tells two installs apart.
fn file_digest(path: &Path) -> Result<String, String> {
    static CACHE: LazyLock<Mutex<HashMap<PathBuf, (FileVersion, String)>>> =
        LazyLock::new(Mutex::default);
    let version = |metadata: std::fs::Metadata| -> FileVersion {
        (
            metadata.len(),
            metadata.modified().ok(),
            metadata.created().ok(),
        )
    };
    let before = version(std::fs::metadata(path).map_err(|error| error.to_string())?);
    if let Some((cached, digest)) = CACHE.lock().ok().and_then(|cache| cache.get(path).cloned()) {
        if cached == before {
            return Ok(digest);
        }
    }
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash).map_err(|error| error.to_string())?;
    let digest = hex::encode(hash.finalize());
    // A file replaced while it was read is hashed again on the next call.
    if let Ok(metadata) = file.metadata() {
        if version(metadata) == before {
            if let Ok(mut cache) = CACHE.lock() {
                cache.insert(path.to_path_buf(), (before, digest.clone()));
            }
        }
    }
    Ok(digest)
}

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
    crate::services::flock_root::reject_document_links(&declared_root, manifest_path)?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let path = manifest_path.canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(&root) {
        return Err("fixture manifest is outside the isolated run root".into());
    }
    crate::services::flock_root::reject_document_links(&root, &path)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 {
        return Err("fixture manifest exceeds its cap".into());
    }
    let mut manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let declared_entrypoint = manifest.entrypoint.clone();
    crate::services::flock_root::reject_document_links(&declared_root, &declared_entrypoint)?;
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
    crate::services::flock_root::reject_document_links(&root, &manifest.entrypoint)?;
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
    let Some(path) = std::env::var_os("FLOCK_E2E_NATIVE_FIXTURE_MANIFEST") else {
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
    crate::services::flock_root::reject_document_links(
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

    #[test]
    fn a_file_digest_follows_the_file_it_names() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runtime.bin");
        std::fs::write(&path, "first build").unwrap();
        let first = file_digest(&path).unwrap();
        assert_eq!(first, digest("first build"));
        assert_eq!(file_digest(&path).unwrap(), first);
        std::fs::write(&path, "second, longer build").unwrap();
        assert_eq!(file_digest(&path).unwrap(), digest("second, longer build"));
        assert!(file_digest(&directory.path().join("missing")).is_err());
    }
}
