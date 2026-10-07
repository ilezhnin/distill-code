CREATE TABLE executor_receipts (
    decision_key TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    host_run_id TEXT NOT NULL,
    start_json TEXT NOT NULL,
    start_hash TEXT NOT NULL,
    finish_json TEXT,
    finish_hash TEXT,
    UNIQUE(session_id, host_run_id)
);
