-- Re-enabling an account must not resurrect sessions minted before the
-- suspension. This marker outlives disabled_at: every disable/enable flip
-- rewrites it, and session resolution rejects tokens issued before it.
ALTER TABLE users ADD COLUMN sessions_revoked_at TEXT DEFAULT NULL;
