CREATE TABLE selector_holdout_rules (
    plan_id TEXT PRIMARY KEY REFERENCES selector_holdouts(id),
    request_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    request_json TEXT NOT NULL,
    artifact_hash TEXT NOT NULL
);
CREATE TABLE selector_holdout_promotions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL UNIQUE REFERENCES selector_holdouts(id),
    created_at INTEGER NOT NULL,
    artifact_json TEXT NOT NULL,
    artifact_hash TEXT NOT NULL,
    revoked_at INTEGER,
    revocation_reason TEXT
);
