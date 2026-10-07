CREATE TABLE selector_holdout_reports (
    plan_id TEXT PRIMARY KEY REFERENCES selector_holdouts(id),
    created_at INTEGER NOT NULL,
    artifact_hash TEXT NOT NULL,
    data_json TEXT NOT NULL
);
