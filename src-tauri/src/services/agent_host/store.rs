//! SQLite-backed persistence for the agent host: session records, the
//! append-only session event log used for history replay, a small key/value
//! store for defaults and preferences, and the MCP server configuration.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::path::Path;

use super::protocol::now_iso;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub harness: String,
    pub bridge_session_id: Option<String>,
    pub cwd: String,
    pub title: Option<String>,
    pub user_set_name: bool,
    pub project_id: Option<String>,
    pub persona_id: Option<String>,
    pub model_id: Option<String>,
    pub hidden: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_message_at: Option<String>,
    pub archived_at: Option<String>,
    pub message_count: i64,
    pub last_snippet: Option<String>,
    pub snapshot: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct McpServerRecord {
    pub config_key: String,
    pub config: Value,
    pub enabled: bool,
}

#[derive(Clone)]
pub struct SessionStore {
    pool: SqlitePool,
}

fn db_error(context: &str, error: sqlx::Error) -> String {
    format!("{context}: {error}")
}

impl SessionStore {
    pub async fn open(db_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create agent host data dir: {error}"))?;
        }
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .map_err(|error| db_error("failed to open agent host database", error))?;
        sqlx::migrate!("./migrations_agent_host")
            .run(&pool)
            .await
            .map_err(|error| format!("failed to migrate agent host database: {error}"))?;
        Ok(Self { pool })
    }

    fn row_to_session(row: &sqlx::sqlite::SqliteRow) -> SessionRecord {
        let snapshot: Option<String> = row.get("snapshot_json");
        SessionRecord {
            id: row.get("id"),
            harness: row.get("harness"),
            bridge_session_id: row.get("bridge_session_id"),
            cwd: row.get("cwd"),
            title: row.get("title"),
            user_set_name: row.get::<i64, _>("user_set_name") != 0,
            project_id: row.get("project_id"),
            persona_id: row.get("persona_id"),
            model_id: row.get("model_id"),
            hidden: row.get::<i64, _>("hidden") != 0,
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            last_message_at: row.get("last_message_at"),
            archived_at: row.get("archived_at"),
            message_count: row.get("message_count"),
            last_snippet: row.get("last_snippet"),
            snapshot: snapshot.and_then(|raw| serde_json::from_str(&raw).ok()),
        }
    }

    pub async fn insert_session(&self, record: &SessionRecord) -> Result<(), String> {
        Self::insert_session_query(record)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to insert session", error))?;
        Ok(())
    }

    /// Insert a session together with its pre-built history in one
    /// transaction (legacy import). `events` carry their own `created_at`.
    pub async fn import_session(
        &self,
        record: &SessionRecord,
        events: &[(String, Value)],
    ) -> Result<(), String> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|error| db_error("failed to start import transaction", error))?;
        Self::insert_session_query(record)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to insert imported session", error))?;
        for (created_at, payload) in events {
            sqlx::query(
                "INSERT INTO session_events (session_id, created_at, payload_json) VALUES (?, ?, ?)",
            )
            .bind(&record.id)
            .bind(created_at)
            .bind(payload.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to insert imported event", error))?;
        }
        tx.commit()
            .await
            .map_err(|error| db_error("failed to commit import", error))?;
        Ok(())
    }

    fn insert_session_query(
        record: &SessionRecord,
    ) -> sqlx::query::Query<'_, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'_>> {
        let snapshot = record.snapshot.as_ref().map(|value| value.to_string());
        sqlx::query(
            "INSERT INTO sessions (id, harness, bridge_session_id, cwd, title, user_set_name, project_id, persona_id, model_id, hidden, created_at, updated_at, last_message_at, archived_at, message_count, last_snippet, snapshot_json) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&record.id)
        .bind(&record.harness)
        .bind(&record.bridge_session_id)
        .bind(&record.cwd)
        .bind(&record.title)
        .bind(record.user_set_name as i64)
        .bind(&record.project_id)
        .bind(&record.persona_id)
        .bind(&record.model_id)
        .bind(record.hidden as i64)
        .bind(&record.created_at)
        .bind(&record.updated_at)
        .bind(&record.last_message_at)
        .bind(&record.archived_at)
        .bind(record.message_count)
        .bind(&record.last_snippet)
        .bind(snapshot)
    }

    pub async fn get_session(&self, id: &str) -> Result<Option<SessionRecord>, String> {
        let row = sqlx::query("SELECT * FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| db_error("failed to read session", error))?;
        Ok(row.as_ref().map(Self::row_to_session))
    }

    /// Sessions ordered by most recent activity. Hidden sessions (private
    /// background work such as conductor probes) are excluded.
    pub async fn list_sessions(
        &self,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<SessionRecord>, String> {
        let rows = sqlx::query(
            "SELECT * FROM sessions WHERE hidden = 0 ORDER BY updated_at DESC, created_at DESC LIMIT ? OFFSET ?",
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| db_error("failed to list sessions", error))?;
        Ok(rows.iter().map(Self::row_to_session).collect())
    }

    pub async fn set_title(&self, id: &str, title: &str, user_set: bool) -> Result<(), String> {
        sqlx::query(
            "UPDATE sessions SET title = ?, user_set_name = ?, updated_at = ? WHERE id = ?",
        )
        .bind(title)
        .bind(user_set as i64)
        .bind(now_iso())
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|error| db_error("failed to rename session", error))?;
        Ok(())
    }

    pub async fn set_archived(&self, id: &str, archived: bool) -> Result<(), String> {
        let archived_at = archived.then(now_iso);
        sqlx::query("UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?")
            .bind(archived_at)
            .bind(now_iso())
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to archive session", error))?;
        Ok(())
    }

    pub async fn set_project(&self, id: &str, project_id: Option<&str>) -> Result<(), String> {
        sqlx::query("UPDATE sessions SET project_id = ?, updated_at = ? WHERE id = ?")
            .bind(project_id)
            .bind(now_iso())
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to update session project", error))?;
        Ok(())
    }

    pub async fn set_cwd(&self, id: &str, cwd: &str) -> Result<(), String> {
        sqlx::query("UPDATE sessions SET cwd = ?, updated_at = ? WHERE id = ?")
            .bind(cwd)
            .bind(now_iso())
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to update session working dir", error))?;
        Ok(())
    }

    pub async fn set_model(&self, id: &str, model_id: Option<&str>) -> Result<(), String> {
        sqlx::query("UPDATE sessions SET model_id = ? WHERE id = ?")
            .bind(model_id)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to update session model", error))?;
        Ok(())
    }

    pub async fn set_bridge_session_id(
        &self,
        id: &str,
        bridge_session_id: &str,
    ) -> Result<(), String> {
        sqlx::query("UPDATE sessions SET bridge_session_id = ? WHERE id = ?")
            .bind(bridge_session_id)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to update bridge session id", error))?;
        Ok(())
    }

    pub async fn set_snapshot(&self, id: &str, snapshot: &Value) -> Result<(), String> {
        sqlx::query("UPDATE sessions SET snapshot_json = ? WHERE id = ?")
            .bind(snapshot.to_string())
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to update session snapshot", error))?;
        Ok(())
    }

    /// Record activity on a session: bumps `updated_at`/`last_message_at`,
    /// adds `message_delta` to the message count, and replaces the snippet
    /// when one is given.
    pub async fn touch(
        &self,
        id: &str,
        message_delta: i64,
        snippet: Option<&str>,
    ) -> Result<(), String> {
        let now = now_iso();
        match snippet {
            Some(snippet) => {
                sqlx::query(
                    "UPDATE sessions SET updated_at = ?, last_message_at = ?, message_count = message_count + ?, last_snippet = ? WHERE id = ?",
                )
                .bind(&now)
                .bind(&now)
                .bind(message_delta)
                .bind(snippet)
                .bind(id)
                .execute(&self.pool)
                .await
            }
            None => {
                sqlx::query(
                    "UPDATE sessions SET updated_at = ?, last_message_at = ?, message_count = message_count + ? WHERE id = ?",
                )
                .bind(&now)
                .bind(&now)
                .bind(message_delta)
                .bind(id)
                .execute(&self.pool)
                .await
            }
        }
        .map_err(|error| db_error("failed to touch session", error))?;
        Ok(())
    }

    pub async fn delete_session(&self, id: &str) -> Result<(), String> {
        sqlx::query("DELETE FROM session_events WHERE session_id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to delete session events", error))?;
        sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to delete session", error))?;
        Ok(())
    }

    pub async fn append_event(&self, session_id: &str, payload: &Value) -> Result<(), String> {
        sqlx::query(
            "INSERT INTO session_events (session_id, created_at, payload_json) VALUES (?, ?, ?)",
        )
        .bind(session_id)
        .bind(now_iso())
        .bind(payload.to_string())
        .execute(&self.pool)
        .await
        .map_err(|error| db_error("failed to append session event", error))?;
        Ok(())
    }

    pub async fn list_events(&self, session_id: &str) -> Result<Vec<Value>, String> {
        let rows = sqlx::query(
            "SELECT payload_json FROM session_events WHERE session_id = ? ORDER BY id ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| db_error("failed to read session events", error))?;
        Ok(rows
            .iter()
            .filter_map(|row| serde_json::from_str(&row.get::<String, _>("payload_json")).ok())
            .collect())
    }

    /// The session's events as the JSON text they were stored as, in order,
    /// for callers that only forward them: replaying a transcript is the one
    /// hot read of this table and parsing megabytes of history into a tree
    /// just to print it again was a measurable share of opening a chat.
    /// Rows that are not valid JSON are skipped, as `list_events` skips them.
    pub async fn list_event_payloads(&self, session_id: &str) -> Result<Vec<String>, String> {
        let rows = sqlx::query(
            "SELECT payload_json FROM session_events WHERE session_id = ? ORDER BY id ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| db_error("failed to read session events", error))?;
        Ok(rows
            .into_iter()
            .map(|row| row.get::<String, _>("payload_json"))
            .filter(|payload| serde_json::from_str::<serde::de::IgnoredAny>(payload).is_ok())
            .collect())
    }

    /// Copy a session's history onto another session (a fork), keeping each
    /// event's original time. With `before` (Unix seconds), only events
    /// recorded before that second are copied, which is how a fork from a
    /// given message drops what came after it.
    pub async fn copy_events(
        &self,
        from: &str,
        to: &str,
        before: Option<i64>,
    ) -> Result<(), String> {
        let rows = sqlx::query(
            "SELECT created_at, payload_json FROM session_events WHERE session_id = ? ORDER BY id ASC",
        )
        .bind(from)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| db_error("failed to read session events", error))?;
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|error| db_error("failed to start fork transaction", error))?;
        for row in rows {
            let created_at: String = row.get("created_at");
            if before.is_some_and(|cutoff| !recorded_before(&created_at, cutoff)) {
                continue;
            }
            let Ok(mut event) =
                serde_json::from_str::<Value>(&row.get::<String, _>("payload_json"))
            else {
                continue;
            };
            if let Some(object) = event.as_object_mut() {
                object.insert("sessionId".to_string(), Value::String(to.to_string()));
            }
            sqlx::query(
                "INSERT INTO session_events (session_id, created_at, payload_json) VALUES (?, ?, ?)",
            )
            .bind(to)
            .bind(&created_at)
            .bind(event.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to copy session event", error))?;
        }
        tx.commit()
            .await
            .map_err(|error| db_error("failed to commit fork", error))?;
        Ok(())
    }

    pub async fn kv_get(&self, scope: &str, key: &str) -> Result<Option<Value>, String> {
        let row = sqlx::query("SELECT value_json FROM kv WHERE scope = ? AND key = ?")
            .bind(scope)
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| db_error("failed to read setting", error))?;
        Ok(row.and_then(|row| serde_json::from_str(&row.get::<String, _>("value_json")).ok()))
    }

    pub async fn kv_set(&self, scope: &str, key: &str, value: &Value) -> Result<(), String> {
        sqlx::query(
            "INSERT INTO kv (scope, key, value_json) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json",
        )
        .bind(scope)
        .bind(key)
        .bind(value.to_string())
        .execute(&self.pool)
        .await
        .map_err(|error| db_error("failed to write setting", error))?;
        Ok(())
    }

    pub async fn kv_delete(&self, scope: &str, key: &str) -> Result<(), String> {
        sqlx::query("DELETE FROM kv WHERE scope = ? AND key = ?")
            .bind(scope)
            .bind(key)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to delete setting", error))?;
        Ok(())
    }

    pub async fn kv_list(&self, scope: &str) -> Result<Vec<(String, Value)>, String> {
        let rows = sqlx::query("SELECT key, value_json FROM kv WHERE scope = ? ORDER BY key")
            .bind(scope)
            .fetch_all(&self.pool)
            .await
            .map_err(|error| db_error("failed to list settings", error))?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let value = serde_json::from_str(&row.get::<String, _>("value_json")).ok()?;
                Some((row.get::<String, _>("key"), value))
            })
            .collect())
    }

    pub async fn mcp_list(&self) -> Result<Vec<McpServerRecord>, String> {
        let rows = sqlx::query(
            "SELECT config_key, config_json, enabled FROM mcp_servers ORDER BY created_at ASC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| db_error("failed to list MCP servers", error))?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let config = serde_json::from_str(&row.get::<String, _>("config_json")).ok()?;
                Some(McpServerRecord {
                    config_key: row.get("config_key"),
                    config,
                    enabled: row.get::<i64, _>("enabled") != 0,
                })
            })
            .collect())
    }

    pub async fn mcp_upsert(
        &self,
        config_key: &str,
        config: &Value,
        enabled: bool,
    ) -> Result<(), String> {
        sqlx::query(
            "INSERT INTO mcp_servers (config_key, config_json, enabled, created_at) VALUES (?, ?, ?, ?) \
             ON CONFLICT(config_key) DO UPDATE SET config_json = excluded.config_json, enabled = excluded.enabled",
        )
        .bind(config_key)
        .bind(config.to_string())
        .bind(enabled as i64)
        .bind(now_iso())
        .execute(&self.pool)
        .await
        .map_err(|error| db_error("failed to save MCP server", error))?;
        Ok(())
    }

    pub async fn mcp_set_enabled(&self, config_key: &str, enabled: bool) -> Result<bool, String> {
        let result = sqlx::query("UPDATE mcp_servers SET enabled = ? WHERE config_key = ?")
            .bind(enabled as i64)
            .bind(config_key)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to toggle MCP server", error))?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn mcp_delete(&self, config_key: &str) -> Result<bool, String> {
        let result = sqlx::query("DELETE FROM mcp_servers WHERE config_key = ?")
            .bind(config_key)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to delete MCP server", error))?;
        Ok(result.rows_affected() > 0)
    }
}

/// Whether an event stored at `created_at` (RFC 3339) precedes the Unix
/// second `cutoff`. An unreadable time keeps the event.
fn recorded_before(created_at: &str, cutoff: i64) -> bool {
    chrono::DateTime::parse_from_rfc3339(created_at)
        .map(|at| at.timestamp() < cutoff)
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(id: &str) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            harness: "claude-acp".to_string(),
            bridge_session_id: None,
            cwd: "C:\\work".to_string(),
            title: None,
            user_set_name: false,
            project_id: None,
            persona_id: None,
            model_id: None,
            hidden: false,
            created_at: "2026-09-11T00:00:00.000Z".to_string(),
            updated_at: "2026-09-11T00:00:00.000Z".to_string(),
            last_message_at: None,
            archived_at: None,
            message_count: 0,
            last_snippet: None,
            snapshot: None,
        }
    }

    fn event(text: &str) -> Value {
        json!({
            "sessionId": "a",
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": { "type": "text", "text": text },
            }
        })
    }

    async fn store_with_history() -> (tempfile::TempDir, SessionStore) {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = SessionStore::open(&dir.path().join("host.db"))
            .await
            .expect("open store");
        // 2026-09-11T00:00:10Z is Unix 1789084810.
        let history = vec![
            ("2026-09-11T00:00:09.500Z".to_string(), event("one")),
            ("2026-09-11T00:00:10.000Z".to_string(), event("two")),
            ("2026-09-11T00:00:11.250Z".to_string(), event("three")),
        ];
        store
            .import_session(&record("a"), &history)
            .await
            .expect("import");
        store.insert_session(&record("b")).await.expect("insert");
        (dir, store)
    }

    async fn texts_and_times(store: &SessionStore, id: &str) -> Vec<(String, String)> {
        sqlx::query(
            "SELECT created_at, payload_json FROM session_events WHERE session_id = ? ORDER BY id",
        )
        .bind(id)
        .fetch_all(&store.pool)
        .await
        .expect("read")
        .iter()
        .map(|row| {
            let payload: Value =
                serde_json::from_str(&row.get::<String, _>("payload_json")).expect("json");
            assert_eq!(payload["sessionId"], id);
            (
                payload["update"]["content"]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                row.get::<String, _>("created_at"),
            )
        })
        .collect()
    }

    #[tokio::test]
    async fn a_fork_keeps_the_history_and_its_times() {
        let (_dir, store) = store_with_history().await;
        store.copy_events("a", "b", None).await.expect("copy");
        let copied = texts_and_times(&store, "b").await;
        assert_eq!(copied, texts_and_times(&store, "a").await);
        assert_eq!(copied.len(), 3);
        assert_eq!(copied[0].1, "2026-09-11T00:00:09.500Z");
    }

    #[tokio::test]
    async fn a_fork_from_a_message_drops_what_came_after_it() {
        let (_dir, store) = store_with_history().await;
        store
            .copy_events("a", "b", Some(1_789_084_810))
            .await
            .expect("copy");
        let copied: Vec<String> = texts_and_times(&store, "b")
            .await
            .into_iter()
            .map(|(text, _)| text)
            .collect();
        assert_eq!(copied, vec!["one".to_string()]);
    }
}
