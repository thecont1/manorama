-- Additional master operators are explicit role grants. The configured
-- Dropbox subject remains the bootstrap owner and is not stored here.
CREATE TABLE IF NOT EXISTS master_accounts (
  account_id TEXT PRIMARY KEY REFERENCES users(account_id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_master_accounts_granted_at ON master_accounts(granted_at, account_id);

-- Geo-IP is operationally useful only as a last-seen signal. It is not a
-- residence claim and may be NULL when Cloudflare cannot determine it.
ALTER TABLE users ADD COLUMN last_seen_country TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_users_last_seen_country ON users(last_seen_country);
