CREATE TABLE workflow_campaigns (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    plan_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','running','paused','cancelled','completed')),
    state_reason TEXT,
    next_cell INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE workflow_campaign_cells (
    request_key TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES workflow_campaigns(id),
    cell_index INTEGER NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT,
    result_hash TEXT,
    UNIQUE(campaign_id, cell_index)
);
CREATE TABLE evaluation_reservations (
    kind TEXT NOT NULL CHECK(kind IN ('family','group')),
    value TEXT NOT NULL,
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('executor_holdout','workflow_campaign')),
    owner_id TEXT NOT NULL,
    PRIMARY KEY(kind,value)
);
INSERT INTO evaluation_reservations(kind,value,owner_kind,owner_id)
    SELECT kind,value,'executor_holdout',plan_id FROM selector_holdout_reservations;
CREATE TABLE workflow_campaign_reports (
    campaign_id TEXT PRIMARY KEY REFERENCES workflow_campaigns(id),
    report_json TEXT NOT NULL,
    report_hash TEXT NOT NULL
);
