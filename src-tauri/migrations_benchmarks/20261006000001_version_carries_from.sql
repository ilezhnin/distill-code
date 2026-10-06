-- The version an evaluator-only republish carries the cells of: its stored
-- outputs are evaluated again instead of the case opening a gap.
ALTER TABLE benchmark_versions ADD COLUMN carries_from TEXT;
