ALTER TABLE users RENAME COLUMN dropbox_account_id TO account_id;
CREATE TABLE auth_identities (
  provider TEXT NOT NULL CHECK (provider IN ('dropbox', 'google', 'apple')),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) > 0),
  account_id TEXT NOT NULL REFERENCES users(account_id),
  email TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, provider_subject),
  UNIQUE (account_id, provider)
);
CREATE INDEX idx_auth_identities_account ON auth_identities(account_id);
INSERT INTO auth_identities (provider, provider_subject, account_id, email, display_name)
SELECT 'dropbox', account_id, account_id, email, display_name FROM users;
