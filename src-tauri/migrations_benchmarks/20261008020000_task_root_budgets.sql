-- Immutable native wall accounting. Existing decisions/dispatches remain the
-- sole selection and execution journals.
CREATE TABLE task_budget_bindings (
    request_key TEXT PRIMARY KEY,
    input_hash TEXT NOT NULL,
    consent_hash TEXT NOT NULL,
    root_id TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    refusal_json TEXT,
    refusal_hash TEXT,
    budget_json TEXT NOT NULL,
    budget_hash TEXT NOT NULL
);
CREATE INDEX task_budget_root ON task_budget_bindings(root_id);
