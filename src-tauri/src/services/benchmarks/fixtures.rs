use super::types::*;
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

pub fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains(':')
        && !path.starts_with('/')
        && path.split('/').all(|v| {
            !v.is_empty()
                && v != "."
                && v != ".."
                && !v.ends_with(['.', ' '])
                && !v.chars().any(char::is_control)
                && !matches!(
                    v.split('.')
                        .next()
                        .unwrap_or_default()
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
pub fn validate(draft: &BenchmarkDraft) -> Vec<String> {
    let mut issues = Vec::new();
    let mut paths = std::collections::HashSet::new();
    let mut size = 0usize;
    for f in &draft.fixtures {
        if !safe_relative(&f.path) || !paths.insert(f.path.to_lowercase()) {
            issues.push(format!("Unsafe or duplicate fixture path: {}", f.path));
        }
        size = size.saturating_add(f.content.len());
    }
    if size > 8 * 1024 * 1024 {
        issues.push("Fixture content exceeds 8 MiB".into());
    }
    issues
}
pub async fn publish_blob(root: &Path, draft: &BenchmarkDraft) -> Result<String> {
    let bytes = serde_json::to_vec(draft)?;
    let digest = hash(&bytes);
    let versions = root.join("versions");
    tokio::fs::create_dir_all(&versions).await?;
    let final_dir = versions.join(&digest);
    crate::services::distill_root::reject_document_links(root, &final_dir)
        .map_err(|e| BenchmarkError::new("validation", e))?;
    if tokio::fs::try_exists(&final_dir).await? {
        verify_blob(root, &digest, draft).await?;
        return Ok(digest);
    }
    let stage = versions.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir(&stage).await?;
    write_synced(&stage.join("manifest.json"), &bytes).await?;
    for fixture in &draft.fixtures {
        if !safe_relative(&fixture.path) {
            return Err(BenchmarkError::new("validation", "Unsafe fixture path"));
        }
        let path = stage.join("fixtures").join(&fixture.path);
        if let Some(p) = path.parent() {
            tokio::fs::create_dir_all(p).await?;
        }
        write_synced(&path, fixture.content.as_bytes()).await?;
    }
    // The publication row is committed only after this complete directory is promoted.
    match tokio::fs::rename(&stage, &final_dir).await {
        Ok(()) => {}
        Err(e) => {
            if !tokio::fs::try_exists(&final_dir).await? {
                return Err(e.into());
            }
            verify_blob(root, &digest, draft).await?;
        }
    }
    Ok(digest)
}
pub(crate) async fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(path).await?;
    file.write_all(bytes).await?;
    file.sync_all().await?;
    Ok(())
}
pub async fn verify_blob(root: &Path, digest: &str, draft: &BenchmarkDraft) -> Result<()> {
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(BenchmarkError::new("validation", "Invalid version hash"));
    }
    let base = root.join("versions").join(digest);
    crate::services::distill_root::reject_document_links(root, &base.join("manifest.json"))
        .map_err(|e| BenchmarkError::new("validation", e))?;
    let manifest = tokio::fs::read(base.join("manifest.json")).await?;
    if hash(&manifest) != digest || manifest != serde_json::to_vec(draft)? {
        return Err(BenchmarkError::new(
            "evidence_missing",
            "Published manifest failed hash verification",
        ));
    }
    for f in &draft.fixtures {
        let path = base.join("fixtures").join(&f.path);
        crate::services::distill_root::reject_document_links(root, &path)
            .map_err(|e| BenchmarkError::new("validation", e))?;
        let meta = tokio::fs::symlink_metadata(&path).await?;
        if meta.file_type().is_symlink() || tokio::fs::read(&path).await? != f.content.as_bytes() {
            return Err(BenchmarkError::new(
                "evidence_missing",
                "Fixture failed verification",
            ));
        }
    }
    Ok(())
}
pub async fn seal(root: &Path, attempt: &Attempt, events: &serde_json::Value) -> Result<String> {
    let path = root
        .join("runs")
        .join(&attempt.run_id)
        .join(&attempt.id)
        .join("evidence");
    tokio::fs::create_dir_all(&path).await?;
    let bytes = serde_json::to_vec(
        &serde_json::json!({"attemptId":attempt.id,"sessionId":attempt.session_id,"output":attempt.output,"observed":attempt.observed,"usage":attempt.usage,"events":events}),
    )?;
    let digest = hash(&bytes);
    write_synced(&path.join(format!("{digest}.json")), &bytes).await?;
    Ok(digest)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_cannot_escape() {
        for p in [
            "../answer",
            "C:/answer",
            "a\\b",
            "/tmp/a",
            "a/../b",
            "a.",
            "a:b",
        ] {
            assert!(!safe_relative(p), "{p}");
        }
        assert!(safe_relative("src/main.js"));
    }
}
