-- Operational history must survive later attempt saves, retries and stops.
-- No retention cap: only consecutive identical observations may be coalesced.
CREATE TABLE attempt_diagnostics (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    occurrences INTEGER NOT NULL CHECK (occurrences > 0),
    -- Qualification/check carriers may have no campaign row; these are
    -- correlation ids, not evidence ownership or foreign-key authority.
    run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    stage TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    candidate_json TEXT NOT NULL,
    judge_json TEXT NOT NULL,
    context_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL
);
CREATE INDEX attempt_diagnostics_attempt_sequence ON attempt_diagnostics(attempt_id,sequence DESC);
CREATE INDEX attempt_diagnostics_attempt_stage ON attempt_diagnostics(attempt_id,stage);
