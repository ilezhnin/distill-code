CREATE TABLE session_execution_owners (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE RESTRICT,
    owner_kind TEXT NOT NULL CHECK(owner_kind = 'benchmark'),
    owner_id TEXT NOT NULL UNIQUE,
    policy_json TEXT NOT NULL,
    policy_hash TEXT NOT NULL
);
CREATE TABLE execution_dispatches (
    request_key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES session_execution_owners(session_id) ON DELETE RESTRICT,
    turn_index INTEGER NOT NULL DEFAULT 0,
    prompt_hash TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    user_message_id TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL CHECK(phase IN ('reserved','running','terminal','uncertain')),
    outcome_json TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(session_id, turn_index)
);
CREATE INDEX execution_dispatches_phase ON execution_dispatches(phase);
