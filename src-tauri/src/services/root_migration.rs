//! Adopt old Distill stores once. Originals remain available for rollback;
//! after adoption only the root copy is opened by this version of the app.
use sqlx::Connection;
use sqlx::Row;

fn rebase_agent_path(value: &str, home: &Path, root: &Path) -> Option<String> {
    let prefix = format!(
        "{}/",
        home.join(".agents/agents")
            .to_string_lossy()
            .replace('\\', "/")
    );
    let normalized = value.replace('\\', "/");
    if !normalized
        .to_lowercase()
        .starts_with(&prefix.to_lowercase())
    {
        return None;
    }
    let relative = &normalized[prefix.len()..];
    let target = root.join("agents").join(relative);
    target
        .is_file()
        .then(|| dunce::simplified(&target).to_string_lossy().into_owned())
}

/// Configuration identities only. Never rewrite message text or instructions.
pub fn rebase_agent_references(value: &mut serde_json::Value, home: &Path, root: &Path) -> bool {
    let mut changed = false;
    match value {
        serde_json::Value::Object(map) => {
            for key in map.keys().cloned().collect::<Vec<_>>() {
                let replacement = rebase_agent_path(&key, home, root);
                if let Some(new_key) = replacement {
                    if let Some(value) = map.remove(&key) {
                        map.entry(new_key).or_insert(value);
                        changed = true;
                    }
                }
            }
            for (key, value) in map.iter_mut() {
                if matches!(
                    key.as_str(),
                    "personaId"
                        | "persona_id"
                        | "targetPersonaId"
                        | "initiatorPersonaId"
                        | "targetAgentPath"
                        | "defaultPersonaId"
                ) {
                    if let Some(rebased) = value
                        .as_str()
                        .and_then(|path| rebase_agent_path(path, home, root))
                    {
                        *value = serde_json::Value::String(rebased);
                        changed = true;
                    }
                } else if !matches!(
                    key.as_str(),
                    "text" | "content" | "prompt" | "systemPrompt" | "executionSystemPrompt"
                ) {
                    changed |= rebase_agent_references(value, home, root);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                changed |= rebase_agent_references(item, home, root);
            }
        }
        _ => {}
    }
    changed
}

fn rebase_config_file(path: &Path, home: &Path, root: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(());
    };
    if !rebase_agent_references(&mut value, home, root) {
        return Ok(());
    }
    let backup = path.with_extension("before-root-migration.json");
    if !backup.exists() {
        fs::copy(path, backup).map_err(|e| e.to_string())?;
    }
    let pending = path.with_extension("root-migration.tmp");
    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    crate::commands::distill_store::write_file_synced(&pending, &bytes)
        .map_err(|e| e.to_string())?;
    fs::rename(pending, path).map_err(|e| e.to_string())
}
use std::fs;
use std::path::Path;

pub fn copy_missing_tree(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    if source.is_dir() {
        fs::create_dir_all(target).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            // Shared .agents can contain links to other tools. Keep those as
            // compatibility sources; do not follow a cycle during adoption.
            if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
                continue;
            }
            copy_missing_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if !target.exists() {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let pending = target.with_extension(format!("migration-{}", uuid::Uuid::new_v4()));
        fs::copy(source, &pending)
            .map_err(|e| format!("Cannot copy '{}': {e}", source.display()))?;
        fs::OpenOptions::new()
            .write(true)
            .open(&pending)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(pending, target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn adopt_files(root: &Path, legacy: &Path, home: &Path) -> Result<(), String> {
    let marker = root.join("state/legacy-files-adopted.json");
    if marker.exists() {
        return Ok(());
    }
    // Personal content wins a same-name collision with a bundled skill.
    for kind in ["agents", "skills"] {
        copy_missing_tree(&home.join(".agents").join(kind), &root.join(kind))?;
    }
    for (from, to) in [
        ("projects", "projects"),
        ("skills", "skills"),
        ("message-queues.json", "state/message-queues.json"),
        ("user-avatars", "user-avatars"),
        ("runtime-config", "runtime-config"),
        ("packages", "cache/packages"),
        ("bin", "cache/bin"),
    ] {
        copy_missing_tree(&legacy.join(from), &root.join(to))?;
    }
    for file in [
        "state/message-queues.json",
        "conductor/graph.json",
        "conductor/waves.json",
        "settings.json",
    ] {
        rebase_config_file(&root.join(file), home, root)?;
    }
    crate::commands::distill_store::write_file_synced(&marker, b"{\"version\":1}\n")
        .map_err(|e| e.to_string())
}

/// SQLite produces a consistent snapshot, including committed WAL contents.
/// A raw copy of a live database (or independent copies of db/wal/shm) cannot.
pub async fn adopt_sessions(root: &Path, legacy: &Path) -> Result<(), String> {
    let source = legacy.join("agent-host/agent-host.db");
    let target = root.join("sessions/agent-host.db");
    if !source.is_file() {
        return Ok(());
    }
    if target.exists() {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&target)
            .read_only(true);
        let mut db = sqlx::SqliteConnection::connect_with(&options)
            .await
            .map_err(|e| e.to_string())?;
        let adopted =
            sqlx::query_scalar::<_, String>("SELECT source FROM _distill_root_adoption LIMIT 1")
                .fetch_optional(&mut db)
                .await
                .ok()
                .flatten();
        db.close().await.map_err(|e| e.to_string())?;
        if adopted.as_deref() == Some(source.to_string_lossy().as_ref()) {
            return Ok(());
        }
        return Err(format!("Both '{}' and '{}' exist without a completed migration. Choose the database to keep before starting Distill.", source.display(), target.display()));
    }
    let pending = root.join("sessions/agent-host.migrating.db");
    // An interrupted snapshot is never promoted or opened as the live store.
    if pending.exists() {
        fs::remove_file(&pending).map_err(|e| e.to_string())?;
    }
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&source)
        .read_only(true);
    let mut connection = sqlx::SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("VACUUM INTO ?")
        .bind(pending.to_string_lossy().as_ref())
        .execute(&mut connection)
        .await
        .map_err(|e| format!("Cannot migrate sessions: {e}"))?;
    connection.close().await.map_err(|e| e.to_string())?;
    // The marker and the snapshot become live in one rename. A crash between
    // promoting the database and writing a sidecar marker cannot strand it.
    let mut snapshot = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&pending),
    )
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("BEGIN")
        .execute(&mut snapshot)
        .await
        .map_err(|e| e.to_string())?;
    let has_sessions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
    )
    .fetch_one(&mut snapshot)
    .await
    .map_err(|e| e.to_string())?;
    if has_sessions != 0 {
        if let Some(home) = dirs::home_dir() {
            let rows = sqlx::query("SELECT id, persona_id, snapshot_json FROM sessions")
                .fetch_all(&mut snapshot)
                .await
                .map_err(|e| e.to_string())?;
            for row in rows {
                let id: String = row.get("id");
                let persona: Option<String> = row.get("persona_id");
                let rebased = persona
                    .as_deref()
                    .and_then(|path| rebase_agent_path(path, &home, root))
                    .or_else(|| persona.clone());
                let raw: Option<String> = row.get("snapshot_json");
                let updated = raw
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                    .and_then(|mut value| {
                        rebase_agent_references(&mut value, &home, root).then(|| value.to_string())
                    })
                    .or_else(|| raw.clone());
                if rebased == persona && updated == raw {
                    continue;
                }
                sqlx::query("UPDATE sessions SET persona_id = ?, snapshot_json = ? WHERE id = ?")
                    .bind(rebased)
                    .bind(updated)
                    .bind(id)
                    .execute(&mut snapshot)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    sqlx::query("CREATE TABLE _distill_root_adoption (source TEXT NOT NULL)")
        .execute(&mut snapshot)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO _distill_root_adoption (source) VALUES (?)")
        .bind(source.to_string_lossy().as_ref())
        .execute(&mut snapshot)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("COMMIT")
        .execute(&mut snapshot)
        .await
        .map_err(|e| e.to_string())?;
    snapshot.close().await.map_err(|e| e.to_string())?;
    fs::rename(&pending, &target).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Executor;

    #[test]
    fn persona_identities_move_without_rewriting_instructions_or_messages() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let root = temp.path().join("distill");
        fs::create_dir_all(root.join("agents")).unwrap();
        fs::write(root.join("agents/worker.md"), "persona").unwrap();
        let old = home
            .join(".agents/agents/worker.md")
            .to_string_lossy()
            .into_owned();
        let mut value = serde_json::json!({ "personaId": old, "nested": {"personaId": old}, "text": old, "executionSystemPrompt": old });
        assert!(rebase_agent_references(&mut value, &home, &root));
        assert_eq!(
            value["personaId"],
            root.join("agents")
                .join("worker.md")
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(value["nested"]["personaId"], value["personaId"]);
        assert_eq!(value["text"], old);
        assert_eq!(value["executionSystemPrompt"], old);
        assert!(!rebase_agent_references(&mut value, &home, &root));
    }

    #[test]
    fn adoption_preserves_edits_and_does_not_reimport_deleted_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let legacy = temp.path().join("legacy");
        crate::services::distill_root::ensure_root_layout(&root).unwrap();
        fs::create_dir_all(legacy.join("projects")).unwrap();
        fs::write(legacy.join("projects/a.md"), "old").unwrap();
        fs::write(root.join("projects/a.md"), "edited").unwrap();
        adopt_files(&root, &legacy, temp.path()).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("projects/a.md")).unwrap(),
            "edited"
        );
        fs::remove_file(root.join("projects/a.md")).unwrap();
        adopt_files(&root, &legacy, temp.path()).unwrap();
        assert!(!root.join("projects/a.md").exists());
        assert!(legacy.join("projects/a.md").exists());
    }

    #[tokio::test]
    async fn session_snapshot_includes_wal_and_preserves_source() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let legacy = temp.path().join("legacy");
        crate::services::distill_root::ensure_root_layout(&root).unwrap();
        fs::create_dir_all(legacy.join("agent-host")).unwrap();
        let source = legacy.join("agent-host/agent-host.db");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&source)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let mut db = sqlx::SqliteConnection::connect_with(&options)
            .await
            .unwrap();
        db.execute("CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('kept');")
            .await
            .unwrap();
        db.execute("CREATE TABLE sessions (id TEXT, persona_id TEXT, snapshot_json TEXT);")
            .await
            .unwrap();
        let old = dirs::home_dir()
            .unwrap()
            .join(".agents")
            .join("agents")
            .join("migration-test.md")
            .to_string_lossy()
            .into_owned();
        fs::write(root.join("agents/migration-test.md"), "test persona").unwrap();
        sqlx::query("INSERT INTO sessions VALUES ('one', ?, ?)")
            .bind(&old)
            .bind(serde_json::json!({"personaId": old, "text": old}).to_string())
            .execute(&mut db)
            .await
            .unwrap();
        adopt_sessions(&root, &legacy).await.unwrap();
        let mut copy = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .filename(root.join("sessions/agent-host.db")),
        )
        .await
        .unwrap();
        let value: String = sqlx::query_scalar("SELECT text FROM messages")
            .fetch_one(&mut copy)
            .await
            .unwrap();
        assert_eq!(value, "kept");
        let persona: String = sqlx::query_scalar("SELECT persona_id FROM sessions")
            .fetch_one(&mut copy)
            .await
            .unwrap();
        assert_eq!(
            persona,
            root.join("agents")
                .join("migration-test.md")
                .to_string_lossy()
        );
        let original: String = sqlx::query_scalar("SELECT persona_id FROM sessions")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(original, old);
        assert!(source.exists());
        adopt_sessions(&root, &legacy).await.unwrap();
    }
}
