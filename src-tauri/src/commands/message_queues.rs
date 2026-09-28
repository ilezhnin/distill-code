use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const MESSAGE_QUEUES_FILENAME: &str = "message-queues.json";
static MESSAGE_QUEUES_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn message_queues_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::services::distill_root::app_root(app)
        .map(|dir| dir.join("state").join(MESSAGE_QUEUES_FILENAME))
}

/// Reads the persisted queues.
///
/// `spawn_blocking`: the body is `std::fs`, and a blocking read on a Tokio
/// worker starves every other async command sharing it.
#[tauri::command]
pub async fn load_message_queues(app: AppHandle) -> Result<Option<String>, String> {
    app.state::<crate::services::bundled_skills::BundledSkillsState>()
        .wait_until_ready()
        .await;
    let path = message_queues_path(&app)?;
    tokio::task::spawn_blocking(move || match fs::read_to_string(&path) {
        Ok(serialized) => Ok(Some(serialized)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read message queues: {error}")),
    })
    .await
    .map_err(|error| format!("Failed to read message queues: {error}"))?
}

/// Merges the renderer's updates into the persisted queues.
///
/// `spawn_blocking`: the body reads, serializes and `fsync`s. See
/// `load_message_queues`.
#[tauri::command]
pub async fn persist_message_queue_updates(
    app: AppHandle,
    serialized_updates: String,
) -> Result<(), String> {
    let path = message_queues_path(&app)?;
    tokio::task::spawn_blocking(move || {
        persist_message_queue_updates_at_path(&path, &serialized_updates)
    })
    .await
    .map_err(|error| format!("Failed to write message queues: {error}"))?
}

/// Preserve malformed data before accepting a replacement. A failed recovery
/// copy must leave the only original intact and fail the write.
fn quarantine_unparseable_queues(path: &Path) -> Result<(), String> {
    let quarantined = path.with_extension(format!("corrupt-{}.json", uuid::Uuid::new_v4()));
    fs::rename(path, &quarantined)
        .map_err(|error| format!("Cannot preserve malformed message queues: {error}"))
}

fn persist_message_queue_updates_at_path(
    path: &Path,
    serialized_updates: &str,
) -> Result<(), String> {
    let _guard = MESSAGE_QUEUES_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Message queue persistence lock was poisoned".to_string())?;
    let updates: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(serialized_updates)
            .map_err(|error| format!("Failed to parse message queue updates: {error}"))?;
    let mut queues = match fs::read_to_string(path) {
        Ok(serialized) => {
            match serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&serialized) {
                Ok(queues) => queues,
                // Not an error for this write: a corrupt file that aborted every
                // future persist is how queued messages were lost for good.
                Err(_) => {
                    quarantine_unparseable_queues(path)?;
                    serde_json::Map::new()
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(error) => return Err(format!("Failed to read message queues: {error}")),
    };
    for (session_id, records) in updates {
        if records.is_null() {
            queues.remove(&session_id);
        } else {
            queues.insert(session_id, records);
        }
    }
    let serialized = if queues.is_empty() {
        None
    } else {
        Some(
            serde_json::to_string(&queues)
                .map_err(|error| format!("Failed to serialize message queues: {error}"))?,
        )
    };
    persist_message_queues_at_path(path, serialized.as_deref())
}

fn persist_message_queues_at_path(path: &Path, serialized: Option<&str>) -> Result<(), String> {
    // An empty document remains authoritative across renderer restarts.
    let serialized = serialized.unwrap_or("{}");
    let parent = path
        .parent()
        .ok_or_else(|| "Message queue path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create message queue directory: {error}"))?;
    let pending_path = path.with_extension("json.pending");
    super::distill_store::write_file_synced(&pending_path, serialized.as_bytes())
        .map_err(|error| format!("Failed to write message queues: {error}"))?;
    fs::rename(&pending_path, path)
        .map_err(|error| format!("Failed to commit message queues: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_session_updates_without_losing_other_renderers_queues() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(MESSAGE_QUEUES_FILENAME);
        persist_message_queues_at_path(
            &path,
            Some(r#"{"main-only":[{"recordId":"large-image"}]}"#),
        )
        .unwrap();

        persist_message_queue_updates_at_path(&path, r#"{"detached":[{"recordId":"secondary"}]}"#)
            .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"detached":[{"recordId":"secondary"}],"main-only":[{"recordId":"large-image"}]}"#
        );

        persist_message_queue_updates_at_path(&path, r#"{"detached":null}"#).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"main-only":[{"recordId":"large-image"}]}"#
        );
    }

    #[test]
    fn writes_replaces_and_removes_queue_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(MESSAGE_QUEUES_FILENAME);

        persist_message_queues_at_path(&path, Some(r#"{"s1":[]}"#)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"s1":[]}"#);

        persist_message_queues_at_path(&path, Some(r#"{"s2":[1]}"#)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"s2":[1]}"#);

        persist_message_queues_at_path(&path, None).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}");
    }

    #[test]
    fn an_unparseable_queue_file_is_quarantined_and_persistence_resumes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(MESSAGE_QUEUES_FILENAME);
        fs::write(&path, b"{not json at all").unwrap();

        persist_message_queue_updates_at_path(&path, r#"{"s1":[{"recordId":"after"}]}"#).unwrap();

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"s1":[{"recordId":"after"}]}"#
        );
        let quarantined: Vec<String> = fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        assert_eq!(quarantined.len(), 1, "{quarantined:?}");
        assert!(quarantined[0].ends_with(".json"), "{quarantined:?}");
        assert_eq!(
            fs::read_to_string(temp.path().join(&quarantined[0])).unwrap(),
            "{not json at all"
        );

        // And the next write no longer sees a corrupt file, so it merges.
        persist_message_queue_updates_at_path(&path, r#"{"s2":[{"recordId":"later"}]}"#).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"s1":[{"recordId":"after"}],"s2":[{"recordId":"later"}]}"#
        );
    }
}
