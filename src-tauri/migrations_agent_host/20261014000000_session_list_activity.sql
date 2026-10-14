-- List the visible page in activity order before reading ownership metadata.
CREATE INDEX sessions_visible_activity
    ON sessions (updated_at DESC, created_at DESC) WHERE hidden = 0;
