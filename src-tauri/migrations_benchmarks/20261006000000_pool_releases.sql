-- Dated, frozen sets of case versions. The newest release at a date is the
-- pool the boards measure; before the first release the pool is every live
-- test's newest published version.
CREATE TABLE pool_releases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    data_json TEXT NOT NULL
);
