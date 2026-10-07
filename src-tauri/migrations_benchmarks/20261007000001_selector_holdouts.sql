CREATE TABLE selector_holdouts (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    model_id TEXT NOT NULL REFERENCES selector_fits(id),
    created_at INTEGER NOT NULL,
    data_json TEXT NOT NULL
);
CREATE TABLE selector_holdout_reservations (
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    plan_id TEXT NOT NULL REFERENCES selector_holdouts(id),
    PRIMARY KEY(kind, value)
);
