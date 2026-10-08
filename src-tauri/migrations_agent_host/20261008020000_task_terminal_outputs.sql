CREATE TABLE task_terminal_outputs (
    request_key TEXT PRIMARY KEY REFERENCES execution_dispatches(request_key),
    session_id TEXT NOT NULL REFERENCES sessions(id),
    result_json TEXT NOT NULL,
    result_hash TEXT NOT NULL
);
