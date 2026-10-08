-- Preserve every existing benchmark owner and mutation guard. Purpose controls
-- only the explicit application adapter and visibility, never ordinary ACP.
ALTER TABLE session_execution_owners ADD COLUMN owner_purpose TEXT NOT NULL DEFAULT 'benchmark'
    CHECK(owner_purpose IN ('benchmark','task'));
