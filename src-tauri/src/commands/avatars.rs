//! Avatars the app stores on disk: images and animations users import
//! (`user-avatar:<id>`) and the PNGs bundled with the distro's agents
//! (`agent-avatar:<id>`).
//!
//! Earlier builds also downloaded an `app-avatar:<id>` library from Block's
//! CDN. That library is gone; persisted `app-avatar:` refs resolve to nothing
//! and render as a missing avatar.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const USER_AVATAR_REF_PREFIX: &str = "user-avatar:";
const AGENT_AVATAR_REF_PREFIX: &str = "agent-avatar:";
const USER_AVATAR_CATALOG_VERSION: &str = "user-generated";
const USER_AVATAR_COLLECTION_ID: &str = "generated-gloopies";
const AGENT_AVATAR_CATALOG_VERSION: &str = "bundled-agent-avatars";
const AGENT_AVATAR_COLLECTION_ID: &str = "agents";
const MAX_IMPORTED_AVATAR_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMPORTED_IMAGE_AVATAR_BYTES: usize = 10 * 1024 * 1024;
const MAX_IMPORTED_POSTER_BYTES: usize = 5 * 1024 * 1024;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const JPEG_SIGNATURE: &[u8; 3] = b"\xff\xd8\xff";
const GIF87A_SIGNATURE: &[u8; 6] = b"GIF87a";
const GIF89A_SIGNATURE: &[u8; 6] = b"GIF89a";
const RIFF_SIGNATURE: &[u8; 4] = b"RIFF";
const WEBP_SIGNATURE: &[u8; 4] = b"WEBP";
const WEBM_SIGNATURE: &[u8; 4] = b"\x1a\x45\xdf\xa3";
const MP4_FILE_TYPE_BOX: &[u8; 4] = b"ftyp";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAvatarAsset {
    pub id: String,
    pub path: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poster_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAvatar {
    pub catalog_version: String,
    pub collection_id: String,
    pub asset: CachedAvatarAsset,
}

#[derive(Debug, Clone)]
struct UserAvatarPaths {
    meta: PathBuf,
    media: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserAvatarManifest {
    id: String,
    path: String,
    mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    alpha_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    poster_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_source_path: Option<String>,
    byte_size: u64,
    created_at_ms: u128,
}

#[tauri::command]
pub async fn import_user_avatar_data_url(
    app: AppHandle,
    data_url: String,
    alpha_mode: Option<String>,
    poster_data_url: Option<String>,
) -> Result<String, String> {
    let (bytes, mime_type) = decode_imported_avatar_data_url(&data_url)?;
    let poster = poster_data_url
        .as_deref()
        .map(decode_imported_poster_data_url)
        .transpose()?;
    write_user_avatar_with_poster(
        &app,
        &bytes,
        mime_type,
        alpha_mode.as_deref(),
        poster.as_deref().map(|bytes| (bytes, "image/png")),
    )
}

#[tauri::command]
pub async fn import_agent_avatar_file(
    app: AppHandle,
    agent_path: String,
    source_path: String,
) -> Result<String, String> {
    let trusted_roots = trusted_agent_roots(&app)?;
    let agent_path = validate_agent_source_path_with_roots(&agent_path, &trusted_roots)?;
    let source_path = validate_imported_image_avatar_path(&source_path)?;
    let bytes = read_imported_image_avatar(&source_path)?;
    let (mime_type, extension) = imported_image_avatar_format(&bytes)
        .ok_or_else(|| "Avatar file must be a PNG, JPEG, GIF, or WebP image.".to_string())?;
    write_agent_image_avatar(&app, &agent_path, &bytes, mime_type, extension)
}

fn decode_imported_avatar_data_url(data_url: &str) -> Result<(Vec<u8>, &'static str), String> {
    const WEBM_PREFIX: &str = "data:video/webm;base64,";
    const MP4_PREFIX: &str = "data:video/mp4;base64,";
    let (mime_type, encoded) = data_url
        .strip_prefix(WEBM_PREFIX)
        .map(|encoded| ("video/webm", encoded))
        .or_else(|| {
            data_url
                .strip_prefix(MP4_PREFIX)
                .map(|encoded| ("video/mp4", encoded))
        })
        .ok_or_else(|| "Imported avatar animation has an unsupported format".to_string())?;
    let decoded_size = decoded_base64_len(encoded)
        .ok_or_else(|| "Imported avatar animation contains invalid base64".to_string())?;
    if decoded_size == 0 || decoded_size > MAX_IMPORTED_AVATAR_BYTES {
        return Err("Imported avatar animation must be 5 MB or smaller".to_string());
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "Imported avatar animation contains invalid base64".to_string())?;
    validate_imported_avatar_signature(&bytes, mime_type)?;
    Ok((bytes, mime_type))
}

fn decoded_base64_len(encoded: &str) -> Option<usize> {
    if encoded.is_empty() || !encoded.len().is_multiple_of(4) {
        return None;
    }
    let padding = encoded
        .as_bytes()
        .iter()
        .rev()
        .take_while(|&&byte| byte == b'=')
        .count();
    if padding > 2 {
        return None;
    }
    encoded
        .len()
        .checked_div(4)?
        .checked_mul(3)?
        .checked_sub(padding)
}

fn validate_imported_avatar_signature(bytes: &[u8], mime_type: &str) -> Result<(), String> {
    let valid = match mime_type {
        "video/webm" => bytes.starts_with(WEBM_SIGNATURE),
        // ISO BMFF files begin with a sized box; imported MP4 must identify its
        // first box as the mandatory file-type box.
        "video/mp4" => bytes.get(4..8) == Some(MP4_FILE_TYPE_BOX.as_slice()),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Imported avatar animation is not a valid {} file",
            mime_type.strip_prefix("video/").unwrap_or("video")
        ))
    }
}

fn decode_imported_poster_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    const PNG_PREFIX: &str = "data:image/png;base64,";
    let encoded = data_url
        .strip_prefix(PNG_PREFIX)
        .ok_or_else(|| "Imported avatar poster has an unsupported format".to_string())?;
    let max_encoded_len = MAX_IMPORTED_POSTER_BYTES.div_ceil(3) * 4;
    if encoded.is_empty() || encoded.len() > max_encoded_len {
        return Err("Imported avatar poster must be 5 MB or smaller".to_string());
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "Imported avatar poster contains invalid base64".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMPORTED_POSTER_BYTES {
        return Err("Imported avatar poster must be 5 MB or smaller".to_string());
    }
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("Imported avatar poster is not a valid PNG".to_string());
    }
    Ok(bytes)
}

fn trusted_agent_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();
    if let Some(e2e_mode) = app.try_state::<crate::services::e2e_mode::E2eMode>() {
        roots.push(e2e_mode.agents_dir());
        return Ok(roots);
    }
    roots.push(crate::services::distill_root::app_root(app)?.join("agents"));
    roots.push(
        dirs::home_dir()
            .ok_or_else(|| "Failed to resolve home directory for agent avatar import".to_string())?
            .join(".agents")
            .join("agents"),
    );
    Ok(roots)
}

fn validate_agent_source_path_with_roots(
    source_path: &str,
    trusted_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let path = PathBuf::from(source_path);
    let metadata = validate_existing_regular_file(&path, "agent source")?;
    if metadata.len() == 0 {
        return Err("Agent source file is empty".to_string());
    }
    let lower_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Agent source file is missing a valid filename".to_string())?
        .to_ascii_lowercase();
    if !lower_name.ends_with(".md") {
        return Err("Unsupported agent source file type. Expected a .md file.".to_string());
    }
    let canonical_path = canonicalize_existing_path(&path, "agent source")?;
    if trusted_roots.iter().any(|root| {
        dunce::canonicalize(root)
            .is_ok_and(|canonical_root| canonical_path.starts_with(canonical_root))
    }) {
        Ok(canonical_path)
    } else {
        Err(format!(
            "Agent source file '{}' is outside the trusted agent source directory",
            path.display()
        ))
    }
}

fn validate_imported_image_avatar_path(source_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(source_path);
    let metadata = validate_existing_regular_file(&path, "avatar image")?;
    if metadata.len() == 0 || metadata.len() > MAX_IMPORTED_IMAGE_AVATAR_BYTES as u64 {
        return Err("Avatar image must be 10 MB or smaller.".to_string());
    }
    canonicalize_existing_path(&path, "avatar image")
}

fn validate_existing_regular_file(
    path: &Path,
    context: &'static str,
) -> Result<std::fs::Metadata, String> {
    if path.as_os_str().is_empty() {
        return Err(format!("Selected {context} path is empty"));
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Failed to access selected {context} '{}': {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Selected {context} path '{}' is a symbolic link. Choose the target file directly.",
            path.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!(
            "Selected {context} path '{}' is not a file",
            path.display()
        ));
    }
    Ok(metadata)
}

fn canonicalize_existing_path(path: &Path, context: &'static str) -> Result<PathBuf, String> {
    dunce::canonicalize(path).map_err(|error| {
        format!(
            "Failed to resolve selected {context} '{}': {error}",
            path.display()
        )
    })
}

fn read_imported_image_avatar(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Failed to open avatar image '{}': {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_IMPORTED_IMAGE_AVATAR_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read avatar image '{}': {error}", path.display()))?;
    if bytes.is_empty() || bytes.len() > MAX_IMPORTED_IMAGE_AVATAR_BYTES {
        return Err("Avatar image must be 10 MB or smaller.".to_string());
    }
    Ok(bytes)
}

fn imported_image_avatar_format(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(PNG_SIGNATURE) {
        return Some(("image/png", "png"));
    }
    if bytes.starts_with(JPEG_SIGNATURE) {
        return Some(("image/jpeg", "jpg"));
    }
    if bytes.starts_with(GIF87A_SIGNATURE) || bytes.starts_with(GIF89A_SIGNATURE) {
        return Some(("image/gif", "gif"));
    }
    if bytes.len() >= 12
        && bytes.get(0..4) == Some(RIFF_SIGNATURE.as_slice())
        && bytes.get(8..12) == Some(WEBP_SIGNATURE.as_slice())
    {
        return Some(("image/webp", "webp"));
    }
    None
}

#[tauri::command]
pub async fn delete_user_avatar(app: AppHandle, avatar_ref: String) -> Result<(), String> {
    delete_user_avatar_by_ref(&app, &avatar_ref)
}

/// Synchronous delete for backend callers that need to clean up their own
/// partially written avatars (for example, when a multi-option generation
/// fails after some options were already persisted).
pub(crate) fn delete_user_avatar_by_ref(app: &AppHandle, avatar_ref: &str) -> Result<(), String> {
    let paths = user_avatar_paths(app)?;
    delete_user_avatar_at_with_app(app, &paths, avatar_ref)
}

/// Deletes a generated avatar's media and manifest.
///
/// Deleting an avatar that is already gone is a success: callers clean up
/// abandoned generations best-effort and must not fail on a double delete.
fn delete_user_avatar_at_with_app(
    app: &AppHandle,
    paths: &UserAvatarPaths,
    avatar_ref: &str,
) -> Result<(), String> {
    let trusted_roots = trusted_agent_roots(app)?;
    delete_user_avatar_at_with_roots(paths, avatar_ref, &trusted_roots)
}

#[cfg(test)]
fn delete_user_avatar_at(paths: &UserAvatarPaths, avatar_ref: &str) -> Result<(), String> {
    delete_user_avatar_at_with_roots(paths, avatar_ref, &[])
}

fn delete_user_avatar_at_with_roots(
    paths: &UserAvatarPaths,
    avatar_ref: &str,
    trusted_roots: &[PathBuf],
) -> Result<(), String> {
    let avatar_id = parse_user_avatar_ref(avatar_ref)?
        .ok_or_else(|| "Invalid user avatar reference".to_string())?;
    let manifest_path = paths.meta.join(format!("{avatar_id}.json"));
    if !manifest_path.exists() {
        return Ok(());
    }

    let manifest = read_user_avatar_manifest(paths, &avatar_id)?;
    let media_path = user_avatar_media_path_with_roots(paths, &manifest, trusted_roots)?;
    let poster_path = manifest
        .poster_path
        .as_deref()
        .map(|relative_path| paths.media.join(relative_path));
    delete_file_if_exists(&media_path)?;
    if let Some(poster_path) = poster_path {
        delete_file_if_exists(&poster_path)?;
    }
    delete_file_if_exists(&manifest_path)
}

/// Resolves user and bundled agent avatar refs to files on disk. Every other
/// ref, including a persisted `app-avatar:` ref, resolves to `None`.
#[tauri::command]
pub async fn get_cached_avatars_for_refs(
    app: AppHandle,
    avatar_refs: Vec<String>,
) -> Result<HashMap<String, Option<CachedAvatar>>, String> {
    Ok(avatar_refs
        .into_iter()
        .map(|avatar_ref| {
            let avatar = cached_avatar_for_ref(&app, &avatar_ref);
            (avatar_ref, avatar)
        })
        .collect())
}

fn cached_avatar_for_ref(app: &AppHandle, avatar_ref: &str) -> Option<CachedAvatar> {
    if let Ok(Some(avatar_id)) = parse_user_avatar_ref(avatar_ref) {
        return cached_user_avatar_for_id(app, &avatar_id).unwrap_or(None);
    }
    if let Ok(Some(avatar_id)) = parse_agent_avatar_ref(avatar_ref) {
        return cached_agent_avatar_for_id(app, &avatar_id).unwrap_or(None);
    }
    None
}

fn cached_agent_avatar_for_id(
    app: &AppHandle,
    avatar_id: &str,
) -> Result<Option<CachedAvatar>, String> {
    // Prefer the installed agents directory. Those files live under $HOME,
    // which the webview asset protocol can actually load. Distro copies on
    // E:\ or in Program Files are outside that scope, so looking there first
    // would resolve a path the UI cannot display.
    let installed = crate::services::distill_root::app_root(app)?.join("agents/.avatars");
    if let Some(avatar) = cached_agent_avatar_for_id_at(&installed, avatar_id)? {
        return Ok(Some(avatar));
    }
    if let Some(home_dir) = dirs::home_dir() {
        let user_avatars = home_dir.join(".agents").join("agents").join(".avatars");
        if let Some(avatar) = cached_agent_avatar_for_id_at(&user_avatars, avatar_id)? {
            return Ok(Some(avatar));
        }
    }

    let Some(distro_state) = app.try_state::<crate::services::distro_bundle::DistroBundleState>()
    else {
        return Ok(None);
    };
    let Some(bundle) = distro_state.bundle() else {
        return Ok(None);
    };
    cached_agent_avatar_for_id_at(&bundle.root_dir.join("agents").join(".avatars"), avatar_id)
}

fn cached_agent_avatar_for_id_at(
    avatar_dir: &Path,
    avatar_id: &str,
) -> Result<Option<CachedAvatar>, String> {
    validate_avatar_id(avatar_id)?;
    for (extension, mime_type) in [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("gif", "image/gif"),
        ("webp", "image/webp"),
    ] {
        let path = avatar_dir.join(format!("{avatar_id}.{extension}"));
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to inspect bundled agent avatar '{}': {error}",
                    path.display()
                ));
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "Bundled agent avatar '{}' must be a regular file",
                path.display()
            ));
        }
        if metadata.len() == 0 {
            return Ok(None);
        }
        return Ok(Some(CachedAvatar {
            catalog_version: AGENT_AVATAR_CATALOG_VERSION.to_string(),
            collection_id: AGENT_AVATAR_COLLECTION_ID.to_string(),
            asset: CachedAvatarAsset {
                id: avatar_id.to_string(),
                path: path.to_string_lossy().into_owned(),
                mime_type: mime_type.to_string(),
                alpha_mode: None,
                poster_path: None,
            },
        }));
    }

    Ok(None)
}

fn read_json_file<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read '{}': {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to parse '{}': {error}", path.display()))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Avatar cache target has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create avatar cache directory: {error}"))?;
    let part_path = unique_part_path(path);
    {
        let mut file = fs::File::create(&part_path)
            .map_err(|error| format!("Failed to create avatar cache part file: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Failed to write avatar cache part file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Failed to sync avatar cache part file: {error}"))?;
    }
    fs::rename(&part_path, path).map_err(|error| {
        let _ = fs::remove_file(&part_path);
        format!("Failed to finalize avatar cache file: {error}")
    })
}

fn unique_part_path(target: &Path) -> PathBuf {
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    target.with_extension(format!("{extension}.{}.{}.part", std::process::id(), nonce))
}

fn user_avatar_paths(app: &AppHandle) -> Result<UserAvatarPaths, String> {
    let app_data_dir = crate::services::distill_root::app_root(app)?;
    let root = app_data_dir.join("user-avatars");
    Ok(UserAvatarPaths {
        meta: root.join("meta"),
        media: root.join("media"),
    })
}

pub(crate) fn write_user_avatar_with_poster(
    app: &AppHandle,
    bytes: &[u8],
    mime_type: &str,
    alpha_mode: Option<&str>,
    poster: Option<(&[u8], &str)>,
) -> Result<String, String> {
    let id = format!("gloopie-{}", Uuid::new_v4());
    let paths = user_avatar_paths(app)?;
    write_user_avatar_at(&paths, &id, bytes, mime_type, alpha_mode, poster)
}

fn write_agent_image_avatar(
    app: &AppHandle,
    agent_path: &Path,
    bytes: &[u8],
    mime_type: &str,
    extension: &str,
) -> Result<String, String> {
    let id = format!("agent-{}", Uuid::new_v4());
    let paths = user_avatar_paths(app)?;
    write_agent_image_avatar_at(&paths, agent_path, &id, bytes, mime_type, extension)
}

fn write_agent_image_avatar_at(
    paths: &UserAvatarPaths,
    agent_path: &Path,
    id: &str,
    bytes: &[u8],
    mime_type: &str,
    extension: &str,
) -> Result<String, String> {
    validate_avatar_id(id)?;
    if user_avatar_extension(mime_type) != Some(extension) {
        return Err(format!("Unsupported avatar image media type: {mime_type}"));
    }
    let agent_dir = agent_path
        .parent()
        .ok_or_else(|| "Agent source file has no parent directory".to_string())?;
    let media_relative_path = format!(".avatars/{id}.{extension}");
    validate_safe_relative_path(&media_relative_path)?;
    let media_path = agent_dir.join(&media_relative_path);
    atomic_write(&media_path, bytes)?;

    let created_at_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    let manifest = UserAvatarManifest {
        id: id.to_string(),
        path: media_relative_path,
        mime_type: mime_type.to_string(),
        alpha_mode: None,
        poster_path: None,
        agent_source_path: Some(agent_path.to_string_lossy().into_owned()),
        byte_size: bytes.len() as u64,
        created_at_ms,
    };
    let result = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Failed to serialize avatar manifest: {error}"))
        .and_then(|bytes| atomic_write(&paths.meta.join(format!("{id}.json")), &bytes));
    if let Err(error) = result {
        rollback_user_avatar_files(&[media_path.as_path()]);
        return Err(error);
    }

    Ok(format!("{USER_AVATAR_REF_PREFIX}{id}"))
}

fn write_user_avatar_at(
    paths: &UserAvatarPaths,
    id: &str,
    bytes: &[u8],
    mime_type: &str,
    alpha_mode: Option<&str>,
    poster: Option<(&[u8], &str)>,
) -> Result<String, String> {
    validate_user_avatar_alpha_mode(alpha_mode)?;
    validate_avatar_id(id)?;
    let extension = user_avatar_extension(mime_type)
        .ok_or_else(|| format!("Unsupported generated avatar media type: {mime_type}"))?;
    let poster_extension = poster
        .map(|(_, poster_mime_type)| {
            user_avatar_extension(poster_mime_type)
                .filter(|_| poster_mime_type.starts_with("image/"))
                .ok_or_else(|| "Unsupported generated avatar poster type".to_string())
        })
        .transpose()?;

    let media_relative_path = format!("{id}.{extension}");
    let media_path = paths.media.join(&media_relative_path);
    atomic_write(&media_path, bytes)?;

    let poster_relative_path = poster_extension.map(|extension| format!("{id}.poster.{extension}"));
    let poster_path = poster_relative_path
        .as_deref()
        .map(|relative_path| paths.media.join(relative_path));
    if let (Some((poster_bytes, _)), Some(poster_path)) = (poster, poster_path.as_ref()) {
        if let Err(error) = atomic_write(poster_path, poster_bytes) {
            rollback_user_avatar_files(&[&media_path]);
            return Err(error);
        }
    }

    let created_at_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    let manifest = UserAvatarManifest {
        id: id.to_string(),
        path: media_relative_path,
        mime_type: mime_type.to_string(),
        alpha_mode: alpha_mode.map(str::to_string),
        poster_path: poster_relative_path,
        agent_source_path: None,
        byte_size: bytes.len() as u64,
        created_at_ms,
    };
    let result = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Failed to serialize generated avatar manifest: {error}"))
        .and_then(|bytes| atomic_write(&paths.meta.join(format!("{id}.json")), &bytes));
    if let Err(error) = result {
        let mut written_paths: Vec<&Path> = vec![media_path.as_path()];
        if let Some(poster_path) = poster_path.as_ref() {
            written_paths.push(poster_path.as_path());
        }
        rollback_user_avatar_files(&written_paths);
        return Err(error);
    }

    Ok(format!("{USER_AVATAR_REF_PREFIX}{id}"))
}

fn rollback_user_avatar_files(paths: &[&Path]) {
    for path in paths {
        if let Err(error) = delete_file_if_exists(path) {
            log::warn!(
                "Failed to roll back generated avatar file '{}': {error}",
                path.display()
            );
        }
    }
}

fn cached_user_avatar_for_id(
    app: &AppHandle,
    avatar_id: &str,
) -> Result<Option<CachedAvatar>, String> {
    let paths = user_avatar_paths(app)?;
    cached_user_avatar_for_id_at(app, &paths, avatar_id)
}

fn cached_user_avatar_for_id_at(
    app: &AppHandle,
    paths: &UserAvatarPaths,
    avatar_id: &str,
) -> Result<Option<CachedAvatar>, String> {
    let manifest_path = paths.meta.join(format!("{avatar_id}.json"));
    if !manifest_path.exists() {
        return Ok(None);
    }
    let manifest = read_user_avatar_manifest(paths, avatar_id)?;
    let media_path = user_avatar_media_path(app, paths, &manifest)?;
    if !media_path.exists() {
        return Ok(None);
    }
    Ok(Some(CachedAvatar {
        catalog_version: USER_AVATAR_CATALOG_VERSION.to_string(),
        collection_id: USER_AVATAR_COLLECTION_ID.to_string(),
        asset: CachedAvatarAsset {
            id: manifest.id,
            path: media_path.to_string_lossy().to_string(),
            mime_type: manifest.mime_type,
            alpha_mode: manifest.alpha_mode,
            poster_path: manifest
                .poster_path
                .map(|poster| paths.media.join(poster).to_string_lossy().to_string()),
        },
    }))
}

fn read_user_avatar_manifest(
    paths: &UserAvatarPaths,
    avatar_id: &str,
) -> Result<UserAvatarManifest, String> {
    validate_avatar_id(avatar_id)?;
    let manifest: UserAvatarManifest =
        read_json_file(&paths.meta.join(format!("{avatar_id}.json")))?;
    if manifest.id != avatar_id {
        return Err("Generated avatar manifest id mismatch".to_string());
    }
    validate_user_avatar_manifest_paths(&manifest)?;
    if user_avatar_extension(&manifest.mime_type).is_none() {
        return Err("Generated avatar manifest has unsupported media type".to_string());
    }
    validate_user_avatar_alpha_mode(manifest.alpha_mode.as_deref())?;
    Ok(manifest)
}

fn validate_user_avatar_manifest_paths(manifest: &UserAvatarManifest) -> Result<(), String> {
    let extension = user_avatar_extension(&manifest.mime_type)
        .ok_or_else(|| "Generated avatar manifest has unsupported media type".to_string())?;
    let expected_media_path = if manifest.agent_source_path.is_some() {
        format!(".avatars/{}.{}", manifest.id, extension)
    } else {
        format!("{}.{}", manifest.id, extension)
    };
    if manifest.path != expected_media_path {
        return Err("Generated avatar manifest media path does not belong to its id".to_string());
    }
    validate_safe_relative_path(&manifest.path)?;

    if manifest.agent_source_path.is_some() && manifest.poster_path.is_some() {
        return Err("Agent avatar manifest cannot have a poster path".to_string());
    }

    if let Some(poster_path) = manifest.poster_path.as_deref() {
        validate_safe_relative_path(poster_path)?;
        let prefix = format!("{}.poster.", manifest.id);
        let poster_extension = poster_path.strip_prefix(&prefix);
        if !matches!(poster_extension, Some("png" | "jpg" | "webp" | "gif")) {
            return Err(
                "Generated avatar manifest poster path does not belong to its id".to_string(),
            );
        }
    }
    Ok(())
}

fn user_avatar_media_path(
    app: &AppHandle,
    paths: &UserAvatarPaths,
    manifest: &UserAvatarManifest,
) -> Result<PathBuf, String> {
    if manifest.agent_source_path.is_some() {
        let trusted_roots = trusted_agent_roots(app)?;
        return user_avatar_media_path_with_roots(paths, manifest, &trusted_roots);
    }
    user_avatar_media_path_with_roots(paths, manifest, &[])
}

fn user_avatar_media_path_with_roots(
    paths: &UserAvatarPaths,
    manifest: &UserAvatarManifest,
    trusted_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    validate_safe_relative_path(&manifest.path)?;
    if let Some(agent_source_path) = manifest.agent_source_path.as_deref() {
        let agent_path = validate_agent_source_path_with_roots(agent_source_path, trusted_roots)?;
        let agent_dir = agent_path
            .parent()
            .ok_or_else(|| "Agent source file has no parent directory".to_string())?;
        return Ok(agent_dir.join(&manifest.path));
    }
    Ok(paths.media.join(&manifest.path))
}

fn user_avatar_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "video/webm" => Some("webm"),
        "video/mp4" => Some("mp4"),
        "video/quicktime" => Some("mov"),
        "video/x-m4v" => Some("m4v"),
        _ => None,
    }
}

fn validate_user_avatar_alpha_mode(value: Option<&str>) -> Result<(), String> {
    match value {
        Some("stacked") | None => Ok(()),
        Some(other) => Err(format!("Unsupported generated avatar alpha mode: {other}")),
    }
}

fn validate_safe_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\\') || path.contains('\0') {
        return Err("Invalid avatar artifact path".to_string());
    }
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Invalid avatar artifact path".to_string());
    }
    Ok(())
}

fn validate_avatar_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        || !value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'))
    {
        return Err("Invalid avatar id".to_string());
    }
    Ok(())
}

fn parse_user_avatar_ref(value: &str) -> Result<Option<String>, String> {
    let Some(id) = value.trim().strip_prefix(USER_AVATAR_REF_PREFIX) else {
        return Ok(None);
    };
    validate_avatar_id(id)?;
    Ok(Some(id.to_string()))
}

fn parse_agent_avatar_ref(value: &str) -> Result<Option<String>, String> {
    let Some(id) = value.trim().strip_prefix(AGENT_AVATAR_REF_PREFIX) else {
        return Ok(None);
    };
    validate_avatar_id(id)?;
    Ok(Some(id.to_string()))
}

fn delete_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to delete avatar cache file: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_user_avatar_paths() -> (tempfile::TempDir, UserAvatarPaths) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("user-avatars");
        let paths = UserAvatarPaths {
            meta: root.join("meta"),
            media: root.join("media"),
        };
        fs::create_dir_all(&paths.meta).unwrap();
        fs::create_dir_all(&paths.media).unwrap();
        (dir, paths)
    }

    fn seed_user_avatar(paths: &UserAvatarPaths, id: &str) -> PathBuf {
        let media_relative_path = format!("{id}.png");
        let media_path = paths.media.join(&media_relative_path);
        fs::write(&media_path, b"png-bytes").unwrap();
        let manifest = UserAvatarManifest {
            id: id.to_string(),
            path: media_relative_path,
            mime_type: "image/png".to_string(),
            alpha_mode: None,
            poster_path: None,
            agent_source_path: None,
            byte_size: 9,
            created_at_ms: 0,
        };
        fs::write(
            paths.meta.join(format!("{id}.json")),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        media_path
    }

    #[test]
    fn delete_user_avatar_rejects_refs_it_does_not_own() {
        let (_dir, paths) = temp_user_avatar_paths();

        // Bundled catalog avatars are not ours to delete.
        assert!(delete_user_avatar_at(&paths, "app-avatar:gloopy-1").is_err());
        assert!(delete_user_avatar_at(&paths, "gloopie-1").is_err());
        assert!(delete_user_avatar_at(&paths, "user-avatar:").is_err());
    }

    #[test]
    fn delete_user_avatar_rejects_path_traversal_in_the_ref() {
        let (_dir, paths) = temp_user_avatar_paths();
        let outside = paths.meta.parent().unwrap().join("secret.json");
        fs::write(&outside, b"keep me").unwrap();

        assert!(delete_user_avatar_at(&paths, "user-avatar:../secret").is_err());
        assert!(delete_user_avatar_at(&paths, "user-avatar:/etc/passwd").is_err());
        assert!(outside.exists());
    }

    #[test]
    fn corrupted_manifest_for_avatar_a_cannot_delete_avatar_b_files() {
        let (_dir, paths) = temp_user_avatar_paths();
        let avatar_a_media = seed_user_avatar(&paths, "gloopie-a");
        let avatar_b_media = seed_user_avatar(&paths, "gloopie-b");
        let avatar_b_poster = paths.media.join("gloopie-b.poster.png");
        fs::write(&avatar_b_poster, b"poster").unwrap();
        let avatar_a_manifest_path = paths.meta.join("gloopie-a.json");

        let mut manifest: UserAvatarManifest = read_json_file(&avatar_a_manifest_path).unwrap();
        manifest.path = "gloopie-b.png".to_string();
        manifest.poster_path = Some("gloopie-b.poster.png".to_string());
        fs::write(
            &avatar_a_manifest_path,
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        assert!(delete_user_avatar_at(&paths, "user-avatar:gloopie-a").is_err());
        assert!(avatar_a_media.exists());
        assert!(avatar_b_media.exists());
        assert!(avatar_b_poster.exists());
        assert!(avatar_a_manifest_path.exists());
    }

    #[test]
    fn delete_user_avatar_rejects_a_manifest_pointing_outside_the_media_dir() {
        let (_dir, paths) = temp_user_avatar_paths();
        let escaped = paths.media.parent().unwrap().join("escaped.png");
        fs::write(&escaped, b"keep me").unwrap();
        let manifest = serde_json::json!({
            "id": "gloopie-1",
            "path": "../escaped.png",
            "mimeType": "image/png",
            "byteSize": 7,
            "createdAtMs": 0,
        });
        fs::write(
            paths.meta.join("gloopie-1.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        // A tampered manifest must not turn delete into arbitrary file removal.
        assert!(delete_user_avatar_at(&paths, "user-avatar:gloopie-1").is_err());
        assert!(escaped.exists());
    }

    #[test]
    fn atomic_write_uses_part_then_final_path() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("meta/v1/manifest.json");
        atomic_write(&target, br#"{"ok":true}"#).unwrap();
        assert_eq!(fs::read(&target).unwrap(), br#"{"ok":true}"#);
        let part_files = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".part"))
            .count();
        assert_eq!(part_files, 0);
    }
}
