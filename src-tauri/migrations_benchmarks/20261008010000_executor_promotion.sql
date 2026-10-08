CREATE TABLE selector_qualifications (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    version_id TEXT NOT NULL UNIQUE REFERENCES benchmark_versions(id),
    content_hash TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    evaluator_revision TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('reserved','terminal')),
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    revoked_at INTEGER,
    revocation_reason TEXT
);
CREATE TABLE selector_promotion_rules (
    campaign_id TEXT PRIMARY KEY REFERENCES workflow_campaigns(id),
    request_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    request_json TEXT NOT NULL,
    artifact_hash TEXT NOT NULL
);
CREATE TABLE selector_promotions (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL UNIQUE REFERENCES workflow_campaigns(id),
    created_at INTEGER NOT NULL,
    artifact_json TEXT NOT NULL,
    artifact_hash TEXT NOT NULL,
    revoked_at INTEGER,
    revocation_reason TEXT
);
CREATE TABLE task_context_bindings (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    binding_json TEXT NOT NULL,
    binding_hash TEXT NOT NULL
);
CREATE TABLE task_owned_sessions (
    binding_id TEXT PRIMARY KEY REFERENCES task_context_bindings(id),
    session_json TEXT NOT NULL,
    session_hash TEXT NOT NULL
);
CREATE TABLE task_mode_consents (
    context_id TEXT PRIMARY KEY,
    mode_json TEXT NOT NULL,
    artifact_hash TEXT NOT NULL
);
