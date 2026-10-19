-- Time a run spent paused, which its 24-hour window leaves out: the paused
-- time already over, and when the current pause began.
ALTER TABLE run_plans ADD COLUMN paused_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_plans ADD COLUMN paused_since INTEGER;
