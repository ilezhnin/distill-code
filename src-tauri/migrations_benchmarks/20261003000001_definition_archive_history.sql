CREATE TABLE benchmark_definition_archives (definition_id TEXT NOT NULL REFERENCES benchmark_definitions(id), archived_at INTEGER NOT NULL, restored_at INTEGER NOT NULL);
CREATE INDEX benchmark_definition_archives_definition ON benchmark_definition_archives(definition_id);
