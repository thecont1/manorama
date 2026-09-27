CREATE TABLE auth_flows (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('dropbox', 'google', 'apple')),
  intent TEXT NOT NULL CHECK (intent IN ('signin', 'link')),
  account_id TEXT REFERENCES users(account_id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  code_verifier TEXT,
  app_challenge TEXT,
  native TEXT NOT NULL DEFAULT '',
  next_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_auth_flows_expires_at ON auth_flows(expires_at);
