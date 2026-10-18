CREATE TABLE selector_previews (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL REFERENCES selector_fits(id),
    work_class_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    data_json TEXT NOT NULL
);
CREATE INDEX selector_previews_by_class ON selector_previews(work_class_id, created_at);
