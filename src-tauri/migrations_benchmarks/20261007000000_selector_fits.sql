CREATE TABLE selector_fits (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    work_class_id TEXT NOT NULL,
    model_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
);
