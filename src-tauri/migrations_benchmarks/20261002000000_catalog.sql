CREATE TABLE catalog_entries(id TEXT PRIMARY KEY, kind TEXT NOT NULL, effective_from INTEGER NOT NULL, created_at INTEGER NOT NULL, data_json TEXT NOT NULL);
CREATE INDEX catalog_entries_kind ON catalog_entries(kind,effective_from);
