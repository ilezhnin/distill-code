-- Every selection the orchestrator made, with its evidence and reasons: the
-- decision snapshot a later review reads.
CREATE TABLE selector_decisions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    work_class_id TEXT NOT NULL,
    data_json TEXT NOT NULL
);
