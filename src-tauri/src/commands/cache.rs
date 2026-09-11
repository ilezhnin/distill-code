use std::path::Path;

use tauri::{AppHandle, Manager};

/// Cache directories, relative to app data, that earlier builds filled with
/// avatar and project artwork downloaded from Block's CDN. Nothing writes
/// them anymore; clearing them only reclaims the disk space an older install
/// left behind.
const LEGACY_MEDIA_CACHE_DIRS: [&str; 5] = [
    "avatars/meta",
    "avatars/media",
    "artifacts/meta",
    "artifacts/media",
    "project-artifacts",
];

#[tauri::command]
pub async fn clear_local_media_caches(app: AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    clear_legacy_media_caches(&app_data_dir).await
}

async fn clear_legacy_media_caches(app_data_dir: &Path) -> Result<(), String> {
    let mut errors = Vec::new();
    for relative_dir in LEGACY_MEDIA_CACHE_DIRS {
        match tokio::fs::remove_dir_all(app_data_dir.join(relative_dir)).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => errors.push(format!("{relative_dir}: {error}")),
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Failed to clear local media caches: {}",
            errors.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn clears_every_legacy_cache_dir_and_leaves_user_avatars_alone() {
        let dir = tempfile::tempdir().unwrap();
        for relative_dir in LEGACY_MEDIA_CACHE_DIRS {
            let cache_dir = dir.path().join(relative_dir);
            std::fs::create_dir_all(&cache_dir).unwrap();
            std::fs::write(cache_dir.join("blob"), b"cached").unwrap();
        }
        let user_avatar = dir.path().join("user-avatars/media/gloopie-1.png");
        std::fs::create_dir_all(user_avatar.parent().unwrap()).unwrap();
        std::fs::write(&user_avatar, b"mine").unwrap();

        clear_legacy_media_caches(dir.path()).await.unwrap();

        for relative_dir in LEGACY_MEDIA_CACHE_DIRS {
            assert!(!dir.path().join(relative_dir).exists());
        }
        assert!(user_avatar.exists());
    }
}
