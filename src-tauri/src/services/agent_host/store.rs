//! SQLite-backed persistence for the agent host: session records, the
//! append-only session event log used for history replay, a small key/value
//! store for defaults and preferences, and the MCP server configuration.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
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
    /// The effort value the harness acknowledged, in its own vocabulary
    /// (`xhigh`, `default`, `ultra`). `None` means nobody has chosen one.
    pub reasoning_effort: Option<String>,
    /// Whether the harness acknowledged fast mode. `None` where the model has
    /// no fast toggle, or nobody has touched it.
    pub fast_mode: Option<bool>,
    /// The model id this session was stored under before the effort was split
    /// out of it (`gpt-5.6-sol[xhigh]`); `None` for a session that never
    /// carried one.
    pub legacy_model_id: Option<String>,
    pub hidden: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_message_at: Option<String>,
    pub archived_at: Option<String>,
    pub message_count: i64,
    pub last_snippet: Option<String>,
    pub snapshot: Option<Value>,
}

/// The session-list fields a prompt's [`SessionStore::touch`] overwrites, read
/// before the prompt is recorded so that a prompt the bridge then rejects can
/// be taken back out of the list as well as out of the event log.
#[derive(Debug, Clone)]
pub struct SessionTouchUndo {
    pub updated_at: String,
    pub last_message_at: Option<String>,
    pub last_snippet: Option<String>,
    pub message_count: i64,
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
            // Every streamed chunk of every chat is one commit here, and
            // sqlx leaves `synchronous` at FULL, which fsyncs the WAL on each
            // of them. In WAL mode NORMAL keeps the database consistent after
            // a crash and only risks the very last commits after a power cut
            // — a cheap trade for the transcript of a chat the user is
            // watching arrive.
            .synchronous(SqliteSynchronous::Normal)
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
            reasoning_effort: row.get("reasoning_effort"),
            fast_mode: row.get::<Option<i64>, _>("fast_mode").map(|fast| fast != 0),
            legacy_model_id: row.get("legacy_model_id"),
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
            "INSERT INTO sessions (id, harness, bridge_session_id, cwd, title, user_set_name, project_id, persona_id, model_id, reasoning_effort, fast_mode, legacy_model_id, hidden, created_at, updated_at, last_message_at, archived_at, message_count, last_snippet, snapshot_json) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        .bind(&record.reasoning_effort)
        .bind(record.fast_mode.map(|fast| fast as i64))
        .bind(&record.legacy_model_id)
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

    /// Name a session. An empty `title` clears the name rather than storing a
    /// blank one, so `Option<String>` still means "named or not".
    pub async fn set_title(&self, id: &str, title: &str, user_set: bool) -> Result<(), String> {
        sqlx::query(
            "UPDATE sessions SET title = ?, user_set_name = ?, updated_at = ? WHERE id = ?",
        )
        .bind(Some(title).filter(|title| !title.is_empty()))
        .bind(user_set as i64)
        .bind(now_iso())
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|error| db_error("failed to rename session", error))?;
        Ok(())
    }

    /// A title the host chose for the chat. A name the user chose is never
    /// replaced, and the list order is left alone. Returns whether it was
    /// stored.
    pub async fn set_agent_title(&self, id: &str, title: &str) -> Result<bool, String> {
        let result =
            sqlx::query("UPDATE sessions SET title = ? WHERE id = ? AND user_set_name = 0")
                .bind(title)
                .bind(id)
                .execute(&self.pool)
                .await
                .map_err(|error| db_error("failed to store the session title", error))?;
        Ok(result.rows_affected() > 0)
    }

    /// A title a harness proposed (`session_info_update`). It only names a
    /// chat that has no title yet. Returns whether it was stored.
    pub async fn set_title_if_untitled(&self, id: &str, title: &str) -> Result<bool, String> {
        let result = sqlx::query(
            "UPDATE sessions SET title = ? WHERE id = ? AND user_set_name = 0 AND title IS NULL",
        )
        .bind(title)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|error| db_error("failed to store the session title", error))?;
        Ok(result.rows_affected() > 0)
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

    /// Both model-scoped knobs at once, as one bridge answer reported them.
    /// `None` means the harness no longer offers that control for the model
    /// the session is on, which is a fact worth storing and not a reason to
    /// keep the old value.
    pub async fn set_run_settings(
        &self,
        id: &str,
        reasoning_effort: Option<&str>,
        fast_mode: Option<bool>,
    ) -> Result<(), String> {
        sqlx::query("UPDATE sessions SET reasoning_effort = ?, fast_mode = ? WHERE id = ?")
            .bind(reasoning_effort)
            .bind(fast_mode.map(|fast| fast as i64))
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to update session run settings", error))?;
        Ok(())
    }

    pub async fn set_reasoning_effort(
        &self,
        id: &str,
        reasoning_effort: Option<&str>,
    ) -> Result<(), String> {
        sqlx::query("UPDATE sessions SET reasoning_effort = ? WHERE id = ?")
            .bind(reasoning_effort)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to update session reasoning effort", error))?;
        Ok(())
    }

    pub async fn set_fast_mode(&self, id: &str, fast_mode: Option<bool>) -> Result<(), String> {
        sqlx::query("UPDATE sessions SET fast_mode = ? WHERE id = ?")
            .bind(fast_mode.map(|fast| fast as i64))
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| db_error("failed to update session fast mode", error))?;
        Ok(())
    }

    /// Split a stored `model[effort]` id into its two halves, keeping the
    /// original in `legacy_model_id`. One session at a time and never a batch
    /// rewrite: a model id is operator history, and the only rows that move are
    /// the ones whose harness confirms both halves.
    ///
    /// The statement re-checks that nothing has been chosen for this session
    /// yet, so a second attempt (or one racing an operator's own effort click)
    /// changes nothing and returns `false`.
    pub async fn split_legacy_model_id(
        &self,
        id: &str,
        model_id: &str,
        reasoning_effort: &str,
    ) -> Result<bool, String> {
        let result = sqlx::query(
            "UPDATE sessions SET legacy_model_id = model_id, model_id = ?, reasoning_effort = ? \
             WHERE id = ? AND legacy_model_id IS NULL AND reasoning_effort IS NULL",
        )
        .bind(model_id)
        .bind(reasoning_effort)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|error| db_error("failed to split the stored model id", error))?;
        Ok(result.rows_affected() > 0)
    }

    /// Record which bridge session a chat is running on, or clear it (`None`)
    /// once that bridge session must never be resumed again — see
    /// `Inner::release_bridge_session`.
    pub async fn set_bridge_session_id(
        &self,
        id: &str,
        bridge_session_id: Option<&str>,
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

    /// Move a session nobody has written in yet onto another harness: the new
    /// bridge session, its model and snapshot replace the old ones, and the
    /// events the previous agent reported before the first message (its
    /// command list, config updates) are dropped so they never replay into
    /// the new one. Returns `false`, changing nothing, once the session has a
    /// message — from then on its history belongs to the harness it ran on.
    pub async fn rebind_unstarted_session(
        &self,
        id: &str,
        harness: &str,
        bridge_session_id: &str,
        model_id: Option<&str>,
        snapshot: &Value,
    ) -> Result<bool, String> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|error| db_error("failed to start rebind transaction", error))?;
        let rebound = sqlx::query(
            "UPDATE sessions SET harness = ?, bridge_session_id = ?, model_id = ?, snapshot_json = ?, updated_at = ? \
             WHERE id = ? AND message_count = 0",
        )
        .bind(harness)
        .bind(bridge_session_id)
        .bind(model_id)
        .bind(snapshot.to_string())
        .bind(now_iso())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|error| db_error("failed to rebind session", error))?
        .rows_affected()
            == 1;
        if !rebound {
            return Ok(false);
        }
        sqlx::query("DELETE FROM session_events WHERE session_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to clear rebound session events", error))?;
        tx.commit()
            .await
            .map_err(|error| db_error("failed to commit rebind", error))?;
        Ok(true)
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

    /// The session-list fields as they are now, to hand back to
    /// [`Self::discard_prompt`] if the prompt about to be recorded is rejected.
    pub async fn touch_undo(&self, id: &str) -> Result<Option<SessionTouchUndo>, String> {
        let row = sqlx::query(
            "SELECT updated_at, last_message_at, last_snippet, message_count FROM sessions WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| db_error("failed to read session", error))?;
        Ok(row.map(|row| SessionTouchUndo {
            updated_at: row.get("updated_at"),
            last_message_at: row.get("last_message_at"),
            last_snippet: row.get("last_snippet"),
            message_count: row.get("message_count"),
        }))
    }

    /// Take a prompt the bridge rejected back out: drop the events it was
    /// recorded under and put the session-list fields back where they were, so
    /// a retry of the same message is not a second copy of it and the message
    /// count still counts only turns that were accepted. One transaction — the
    /// log and the count must never disagree.
    pub async fn discard_prompt(
        &self,
        session_id: &str,
        event_ids: &[i64],
        undo: &SessionTouchUndo,
    ) -> Result<(), String> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|error| db_error("failed to start discard transaction", error))?;
        for id in event_ids {
            sqlx::query("DELETE FROM session_events WHERE id = ? AND session_id = ?")
                .bind(id)
                .bind(session_id)
                .execute(&mut *tx)
                .await
                .map_err(|error| db_error("failed to remove a rejected prompt", error))?;
        }
        sqlx::query(
            "UPDATE sessions SET updated_at = ?, last_message_at = ?, last_snippet = ?, message_count = ? WHERE id = ?",
        )
        .bind(&undo.updated_at)
        .bind(undo.last_message_at.as_deref())
        .bind(undo.last_snippet.as_deref())
        .bind(undo.message_count)
        .bind(session_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| db_error("failed to restore the session after a rejected prompt", error))?;
        tx.commit()
            .await
            .map_err(|error| db_error("failed to commit the prompt discard", error))?;
        Ok(())
    }

    /// Delete a session and its events together. One transaction: the schema
    /// has no cascade, so a crash or an error between the two statements would
    /// leave the events behind as rows no session ever reads, lists or
    /// reclaims.
    pub async fn delete_session(&self, id: &str) -> Result<(), String> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|error| db_error("failed to start delete transaction", error))?;
        sqlx::query("DELETE FROM session_events WHERE session_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to delete session events", error))?;
        sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to delete session", error))?;
        tx.commit()
            .await
            .map_err(|error| db_error("failed to commit the session delete", error))?;
        Ok(())
    }

    /// Append several events of one session in one transaction, in the order
    /// given, and return the row ids they were stored under. One commit for a
    /// whole prompt instead of one per content block, and the ids are what
    /// makes a turn the bridge then rejects removable again.
    pub async fn append_events(
        &self,
        session_id: &str,
        payloads: &[Value],
    ) -> Result<Vec<i64>, String> {
        if payloads.is_empty() {
            return Ok(Vec::new());
        }
        let now = now_iso();
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|error| db_error("failed to start append transaction", error))?;
        let mut ids = Vec::with_capacity(payloads.len());
        for payload in payloads {
            let inserted = sqlx::query(
                "INSERT INTO session_events (session_id, created_at, payload_json) VALUES (?, ?, ?)",
            )
            .bind(session_id)
            .bind(&now)
            .bind(payload.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|error| db_error("failed to append session event", error))?;
            ids.push(inserted.last_insert_rowid());
        }
        tx.commit()
            .await
            .map_err(|error| db_error("failed to commit session events", error))?;
        Ok(ids)
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
            reasoning_effort: None,
            fast_mode: None,
            legacy_model_id: None,
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

    #[tokio::test]
    async fn an_unstarted_session_moves_to_another_harness_without_its_old_events() {
        let (_dir, store) = store_with_history().await;
        store
            .append_events("b", &[event("commands")])
            .await
            .expect("event");
        let snapshot = json!({ "models": { "currentModelId": "gpt-5" } });
        let rebound = store
            .rebind_unstarted_session("b", "codex-acp", "codex-1", Some("gpt-5"), &snapshot)
            .await
            .expect("rebind");
        assert!(rebound);
        let moved = store.get_session("b").await.expect("read").expect("row");
        assert_eq!(moved.harness, "codex-acp");
        assert_eq!(moved.bridge_session_id.as_deref(), Some("codex-1"));
        assert_eq!(moved.model_id.as_deref(), Some("gpt-5"));
        assert_eq!(moved.snapshot, Some(snapshot));
        assert!(store.list_events("b").await.expect("events").is_empty());
    }

    #[tokio::test]
    async fn a_session_with_a_message_keeps_its_harness_and_history() {
        let (_dir, store) = store_with_history().await;
        store.touch("a", 1, Some("one")).await.expect("touch");
        let rebound = store
            .rebind_unstarted_session("a", "codex-acp", "codex-1", None, &json!({}))
            .await
            .expect("rebind");
        assert!(!rebound);
        let kept = store.get_session("a").await.expect("read").expect("row");
        assert_eq!(kept.harness, "claude-acp");
        assert_eq!(store.list_events("a").await.expect("events").len(), 3);
    }

    /// sqlx stores the checksum of every migration it applies and refuses to
    /// open a database whose applied migration no longer matches its file —
    /// comments included. A rename sweep once reworded a comment in
    /// `session_selection` and every existing install stopped starting. A
    /// migration that has shipped is frozen; this is what says so at test time
    /// instead of at the operator's next launch. New migrations are appended
    /// here once they ship.
    #[test]
    fn a_shipped_migration_is_never_edited() {
        const SHIPPED: &[(i64, &str)] = &[
            (20260904000000, "06b3b3d5988b76720d7b755b70a222241d9c81a63aa796d4eeff9cbdd7784a6347036d1a024ed549834d1fc1e4b1174e"),
            (20260914000000, "c0ce78fac3f4997f7756256844dc51018683db031fa6eef2dd19cf4c364d6a9a5ef1bef9fdb491ff226c6c51d2a5ed81"),
            (20260920000000, "2187befa6dc6279fcf5081f84f59a39442234f43c5908ced65552a3863fe7c714329f3ac5ef009419a72fb639f3b5e6c"),
        ];
        let migrator = sqlx::migrate!("./migrations_agent_host");
        for (version, checksum) in SHIPPED {
            let migration = migrator
                .iter()
                .find(|migration| migration.version == *version)
                .unwrap_or_else(|| panic!("shipped migration {version} is gone"));
            assert_eq!(
                hex::encode(&migration.checksum),
                *checksum,
                "migration {version} changed after it shipped; restore the file and add a new migration instead"
            );
        }
    }

    #[tokio::test]
    async fn the_cleanup_migration_drops_command_lists_and_nothing_else() {
        let (_dir, store) = store_with_history().await;
        let command_list = json!({
            "sessionId": "b",
            "update": { "sessionUpdate": "available_commands_update", "availableCommands": [] },
        });
        let quoting_it = json!({
            "sessionId": "b",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "\"available_commands_update\"" },
            },
        });
        for payload in [
            command_list.to_string(),
            quoting_it.to_string(),
            // Not JSON at all: must neither match nor fail the statement.
            "\"available_commands_update\" {".to_string(),
        ] {
            sqlx::query(
                "INSERT INTO session_events (session_id, created_at, payload_json) VALUES ('b', '2026-09-20T00:00:00.000Z', ?)",
            )
            .bind(payload)
            .execute(&store.pool)
            .await
            .expect("insert");
        }

        sqlx::query(include_str!(
            "../../../migrations_agent_host/20260920000000_drop_command_list_events.sql"
        ))
        .execute(&store.pool)
        .await
        .expect("the migration runs over rows that are not JSON");

        let left: Vec<String> = sqlx::query(
            "SELECT payload_json FROM session_events WHERE session_id = 'b' ORDER BY id",
        )
        .fetch_all(&store.pool)
        .await
        .expect("read")
        .iter()
        .map(|row| row.get("payload_json"))
        .collect();
        assert_eq!(
            left,
            [
                quoting_it.to_string(),
                "\"available_commands_update\" {".to_string()
            ]
        );
        assert_eq!(store.list_events("a").await.expect("events").len(), 3);
    }

    #[tokio::test]
    async fn the_rename_migration_moves_stored_names_and_leaves_prose_about_them() {
        let (_dir, store) = store_with_history().await;
        let stored = json!({
            "sessionId": "b",
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": {
                    "type": "text",
                    "text": "see berd://session/abc and the \"berdctl_cross_session\" origin",
                },
                "_meta": {
                    "origin": "berdctl_cross_session",
                    "berdSenderLabel": "Planner",
                    "berdDeliveryId": "d-1",
                },
            },
        });
        sqlx::query(
            "INSERT INTO session_events (session_id, created_at, payload_json) VALUES ('b', '2026-09-20T00:00:00.000Z', ?)",
        )
        .bind(stored.to_string())
        .execute(&store.pool)
        .await
        .expect("insert");

        sqlx::query(include_str!(
            "../../../migrations_agent_host/20260921000000_rename_upstream_names.sql"
        ))
        .execute(&store.pool)
        .await
        .expect("migrate");

        let payload: String =
            sqlx::query("SELECT payload_json FROM session_events WHERE session_id = 'b'")
                .fetch_one(&store.pool)
                .await
                .expect("read")
                .get("payload_json");
        let migrated: Value = serde_json::from_str(&payload).expect("still json");
        let update = &migrated["update"];
        assert_eq!(update["_meta"]["origin"], "distillctl_cross_session");
        assert_eq!(update["_meta"]["distillSenderLabel"], "Planner");
        assert_eq!(update["_meta"]["distillDeliveryId"], "d-1");
        assert!(update["_meta"].get("berdSenderLabel").is_none());
        assert_eq!(
            update["content"]["text"],
            "see distill://session/abc and the \"berdctl_cross_session\" origin"
        );
    }

    #[tokio::test]
    async fn a_session_stored_before_the_run_settings_existed_reads_back_with_none() {
        let (_dir, store) = store_with_history().await;
        let existing = store.get_session("a").await.expect("read").expect("row");
        assert_eq!(existing.reasoning_effort, None);
        assert_eq!(existing.fast_mode, None);
        assert_eq!(existing.legacy_model_id, None);
    }

    #[tokio::test]
    async fn the_effort_and_the_fast_toggle_are_stored_and_cleared_on_their_own() {
        let (_dir, store) = store_with_history().await;
        store
            .set_run_settings("a", Some("xhigh"), Some(true))
            .await
            .expect("run settings");
        let stored = store.get_session("a").await.expect("read").expect("row");
        assert_eq!(stored.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(stored.fast_mode, Some(true));

        // A model with no effort control says so; the fast toggle it does have
        // is not disturbed by that.
        store.set_reasoning_effort("a", None).await.expect("effort");
        let narrowed = store.get_session("a").await.expect("read").expect("row");
        assert_eq!(narrowed.reasoning_effort, None);
        assert_eq!(narrowed.fast_mode, Some(true));

        store.set_fast_mode("a", Some(false)).await.expect("fast");
        assert_eq!(
            store
                .get_session("a")
                .await
                .expect("read")
                .expect("row")
                .fast_mode,
            Some(false)
        );

        // Another session is left alone by all of it.
        let untouched = store.get_session("b").await.expect("read").expect("row");
        assert_eq!(untouched.reasoning_effort, None);
        assert_eq!(untouched.fast_mode, None);
    }

    #[tokio::test]
    async fn splitting_a_folded_model_id_keeps_the_original_and_happens_once() {
        let (_dir, store) = store_with_history().await;
        store
            .set_model("a", Some("gpt-5.6-sol[xhigh]"))
            .await
            .expect("model");
        assert!(store
            .split_legacy_model_id("a", "gpt-5.6-sol", "xhigh")
            .await
            .expect("split"));
        let split = store.get_session("a").await.expect("read").expect("row");
        assert_eq!(split.model_id.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(split.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(split.legacy_model_id.as_deref(), Some("gpt-5.6-sol[xhigh]"));

        // Asked again — after a move to another model, say — it changes
        // nothing and says so.
        store
            .set_model("a", Some("gpt-5.6-luna[low]"))
            .await
            .expect("model");
        assert!(!store
            .split_legacy_model_id("a", "gpt-5.6-luna", "low")
            .await
            .expect("split"));
        let kept = store.get_session("a").await.expect("read").expect("row");
        assert_eq!(kept.model_id.as_deref(), Some("gpt-5.6-luna[low]"));
        assert_eq!(kept.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(kept.legacy_model_id.as_deref(), Some("gpt-5.6-sol[xhigh]"));
    }

    #[tokio::test]
    async fn a_batch_of_events_is_stored_in_order_under_the_ids_it_reports() {
        let (_dir, store) = store_with_history().await;
        let of_b = |text: &str| {
            let mut payload = event(text);
            payload["sessionId"] = json!("b");
            payload
        };
        let ids = store
            .append_events("b", &[of_b("first"), of_b("second")])
            .await
            .expect("append");
        assert_eq!(ids.len(), 2);
        assert!(ids[0] < ids[1], "{ids:?}");
        let stored: Vec<String> = texts_and_times(&store, "b")
            .await
            .into_iter()
            .map(|(text, _)| text)
            .collect();
        assert_eq!(stored, vec!["first".to_string(), "second".to_string()]);
        assert!(store
            .append_events("b", &[])
            .await
            .expect("empty append")
            .is_empty());
    }

    #[tokio::test]
    async fn a_prompt_the_bridge_rejects_leaves_no_trace_in_the_log_or_the_count() {
        let (_dir, store) = store_with_history().await;
        let of_b = |text: &str| {
            let mut payload = event(text);
            payload["sessionId"] = json!("b");
            payload
        };
        // Session b already carries one accepted message.
        store
            .append_events("b", &[of_b("accepted")])
            .await
            .expect("append");
        store.touch("b", 1, Some("accepted")).await.expect("touch");

        let undo = store
            .touch_undo("b")
            .await
            .expect("read")
            .expect("session b exists");
        assert_eq!(undo.message_count, 1);
        assert_eq!(undo.last_snippet.as_deref(), Some("accepted"));

        // A send the bridge then rejects: recorded first, withdrawn after.
        let rejected = store
            .append_events("b", &[of_b("rejected"), of_b("second block")])
            .await
            .expect("append");
        store.touch("b", 1, Some("rejected")).await.expect("touch");
        store
            .discard_prompt("b", &rejected, &undo)
            .await
            .expect("discard");

        let stored: Vec<String> = texts_and_times(&store, "b")
            .await
            .into_iter()
            .map(|(text, _)| text)
            .collect();
        assert_eq!(stored, vec!["accepted".to_string()]);
        let after = store
            .touch_undo("b")
            .await
            .expect("read")
            .expect("session b exists");
        assert_eq!(after.message_count, 1);
        assert_eq!(after.last_snippet.as_deref(), Some("accepted"));
        assert_eq!(after.updated_at, undo.updated_at);
        assert_eq!(after.last_message_at, undo.last_message_at);
        // The other session's history is none of the discard's business.
        assert_eq!(texts_and_times(&store, "a").await.len(), 3);
    }

    #[tokio::test]
    async fn deleting_a_session_takes_its_events_with_it() {
        let (_dir, store) = store_with_history().await;
        assert_eq!(texts_and_times(&store, "a").await.len(), 3);
        store.delete_session("a").await.expect("delete");
        assert!(store.get_session("a").await.expect("get").is_none());
        // The schema has no cascade, so the events only go if the delete takes
        // them: orphan rows here are never read, listed or reclaimed again.
        assert!(texts_and_times(&store, "a").await.is_empty());
        assert!(store.get_session("b").await.expect("get").is_some());
    }

    #[tokio::test]
    async fn a_bridge_session_can_be_recorded_and_given_up_again() {
        let (_dir, store) = store_with_history().await;
        store
            .set_bridge_session_id("b", Some("bridge-1"))
            .await
            .expect("record");
        assert_eq!(
            store
                .get_session("b")
                .await
                .expect("read")
                .expect("row")
                .bridge_session_id
                .as_deref(),
            Some("bridge-1")
        );

        // A chat that moved folders lets go of its bridge session for good: the
        // row must stop naming it, or the next attach resumes it and the chat
        // keeps running in the folder it was created in.
        store.set_bridge_session_id("b", None).await.expect("clear");
        assert_eq!(
            store
                .get_session("b")
                .await
                .expect("read")
                .expect("row")
                .bridge_session_id,
            None
        );
    }

    #[tokio::test]
    async fn the_database_fsyncs_only_at_checkpoints() {
        let (_dir, store) = store_with_history().await;
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&store.pool)
            .await
            .expect("journal mode");
        assert_eq!(mode.to_ascii_lowercase(), "wal");
        let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
            .fetch_one(&store.pool)
            .await
            .expect("synchronous");
        // 1 == NORMAL; sqlx's default is 2 (FULL), an fsync per commit.
        assert_eq!(synchronous, 1);
    }

    #[tokio::test]
    async fn an_agent_title_never_replaces_a_name_the_user_chose() {
        let (_dir, store) = store_with_history().await;
        store
            .set_agent_title("a", "Fix the build")
            .await
            .expect("title");
        let titled = store.get_session("a").await.expect("read").expect("row");
        assert_eq!(titled.title.as_deref(), Some("Fix the build"));
        assert!(!titled.user_set_name);

        store.set_title("a", "Mine", true).await.expect("rename");
        assert!(!store.set_agent_title("a", "Other").await.expect("title"));
        let renamed = store.get_session("a").await.expect("read").expect("row");
        assert_eq!(renamed.title.as_deref(), Some("Mine"));
    }

    #[tokio::test]
    async fn a_harness_title_only_names_an_untitled_chat() {
        let (_dir, store) = store_with_history().await;
        assert!(store
            .set_title_if_untitled("a", "first prompt echoed back")
            .await
            .expect("title"));
        assert!(store
            .set_agent_title("a", "Model picker names")
            .await
            .expect("summary"));
        assert!(!store
            .set_title_if_untitled("a", "first prompt echoed back")
            .await
            .expect("title"));
        let titled = store.get_session("a").await.expect("read").expect("row");
        assert_eq!(titled.title.as_deref(), Some("Model picker names"));
    }

    #[tokio::test]
    async fn clearing_a_name_hands_the_naming_back_to_the_agent() {
        let (_dir, store) = store_with_history().await;
        store.set_title("a", "Mine", true).await.expect("rename");

        // An empty rename is "I have no name for this", not "its name is the
        // empty string": it must not be stored as a name the user chose, or the
        // agent's proposed title would be blocked forever.
        store.set_title("a", "", false).await.expect("clear");
        let cleared = store.get_session("a").await.expect("read").expect("row");
        assert_eq!(cleared.title, None);
        assert!(!cleared.user_set_name);

        store
            .set_agent_title("a", "Fix the build")
            .await
            .expect("title");
        let named = store.get_session("a").await.expect("read").expect("row");
        assert_eq!(named.title.as_deref(), Some("Fix the build"));
    }
}
