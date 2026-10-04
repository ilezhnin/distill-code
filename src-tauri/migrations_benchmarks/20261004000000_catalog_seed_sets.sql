CREATE TABLE catalog_seed_sets(id TEXT PRIMARY KEY, seeded_at INTEGER NOT NULL);
-- A catalog that already holds entries was seeded with the Anthropic set.
INSERT INTO catalog_seed_sets(id, seeded_at)
  SELECT 'anthropic-2026-10-02', 1790942400000 WHERE EXISTS (SELECT 1 FROM catalog_entries);
