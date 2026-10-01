-- NULL preserves the system CLI account for existing and imported sessions.
ALTER TABLE sessions ADD COLUMN account_id TEXT;
CREATE INDEX sessions_account_id ON sessions(account_id);
