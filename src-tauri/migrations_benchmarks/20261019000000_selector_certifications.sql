-- Journal of held-out evaluations of learned class selectors: one row per
-- look (a fit evaluated on one snapshot of held-out cells).
CREATE TABLE selector_certifications (
    id TEXT PRIMARY KEY,
    work_class_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    artifact_hash TEXT NOT NULL
);
CREATE INDEX selector_certifications_by_class ON selector_certifications(work_class_id, created_at);
-- Class certificates issued by a passing held-out evaluation. The evaluation
-- id names the journaled look that issued it.
CREATE TABLE selector_class_certificates (
    id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL UNIQUE REFERENCES selector_certifications(id),
    created_at INTEGER NOT NULL,
    artifact_json TEXT NOT NULL,
    artifact_hash TEXT NOT NULL,
    revoked_at INTEGER,
    revocation_reason TEXT
);
