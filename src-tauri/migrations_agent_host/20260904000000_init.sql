CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    harness TEXT NOT NULL,
    bridge_session_id TEXT,
    cwd TEXT NOT NULL,
    title TEXT,
    user_set_name INTEGER NOT NULL DEFAULT 0,
    project_id TEXT,
    persona_id TEXT,
    model_id TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_message_at TEXT,
    archived_at TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    last_snippet TEXT,
    snapshot_json TEXT
);

CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions (updated_at DESC);

CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS session_events_session ON session_events (session_id, id);

CREATE TABLE IF NOT EXISTS kv (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS mcp_servers (
    config_key TEXT PRIMARY KEY NOT NULL,
    config_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
