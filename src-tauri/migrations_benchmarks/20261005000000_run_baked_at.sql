-- When a run's 24-hour window closed and its cells became final.
ALTER TABLE run_plans ADD COLUMN baked_at INTEGER;
