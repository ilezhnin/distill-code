-- Time a root-pinned workflow sat in the queue with a paid prefix (a quota or
-- account wait) or with the app stopped is credited back to its wall budget.
-- A credit opens when the root leaves flight and closes, bound by its hash,
-- when the root's next flight starts; a closed row never changes.
CREATE TABLE budget_credits (
    root_id TEXT NOT NULL,
    from_ms INTEGER NOT NULL,
    to_ms INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('idle', 'stranded')),
    run_id TEXT NOT NULL,
    credit_json TEXT,
    credit_hash TEXT,
    PRIMARY KEY (root_id, from_ms),
    CHECK (to_ms IS NULL OR to_ms > from_ms),
    CHECK ((to_ms IS NULL) = (credit_json IS NULL) AND (to_ms IS NULL) = (credit_hash IS NULL))
);
CREATE UNIQUE INDEX budget_credits_open ON budget_credits(root_id) WHERE to_ms IS NULL;
-- When the benchmark service was last alive, so stranded time starts there.
CREATE TABLE benchmark_heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    at_ms INTEGER NOT NULL
);
