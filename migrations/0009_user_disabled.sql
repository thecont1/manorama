-- A disabled account cannot sign in or keep a session, but its rows stay —
-- disabling is the non-destructive way to suspend a member. NULL means active.
ALTER TABLE users ADD COLUMN disabled_at TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_users_disabled_at ON users(disabled_at);
