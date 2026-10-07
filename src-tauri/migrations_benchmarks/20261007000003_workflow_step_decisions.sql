-- Existing steps remain explicitly legacy; never reconstruct a prior decision
-- from an outcome or invent a preparation timestamp during migration.
ALTER TABLE workflow_steps ADD COLUMN decision_json TEXT;
