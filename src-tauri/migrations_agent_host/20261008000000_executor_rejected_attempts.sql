ALTER TABLE executor_receipts ADD COLUMN attempt_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE executor_receipts ADD COLUMN rejection_json TEXT;
ALTER TABLE executor_receipts ADD COLUMN rejection_hash TEXT;

CREATE TABLE executor_rejected_attempts (
    decision_key TEXT NOT NULL,
    attempt_index INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    host_run_id TEXT NOT NULL,
    start_json TEXT NOT NULL,
    start_hash TEXT NOT NULL,
    finish_json TEXT NOT NULL,
    finish_hash TEXT NOT NULL,
    rejection_json TEXT NOT NULL,
    rejection_hash TEXT NOT NULL,
    PRIMARY KEY(decision_key, attempt_index)
);

CREATE INDEX executor_rejected_attempt_runs
ON executor_rejected_attempts(session_id, host_run_id);
