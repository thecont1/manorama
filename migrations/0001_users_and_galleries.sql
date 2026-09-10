-- Manorama multi-user model: Dropbox-authenticated gallery owners.
-- Users are identified by their immutable Dropbox account ID; the
-- owner_slug is the user-facing URL segment and can change over time.
CREATE TABLE IF NOT EXISTS users (
  dropbox_account_id TEXT PRIMARY KEY,
  owner_slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  tier TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Galleries are owned by exactly one user. The slug is unique per user
-- (not globally): /<owner_slug>/<slug> resolves through the user first.
CREATE TABLE IF NOT EXISTS galleries (
  slug TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(dropbox_account_id),
  title TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  images_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_galleries_owner ON galleries(owner_id);

-- A Dropbox folder can back at most one gallery per owner. source_url is
-- NULL for the bundled italy-2018 fixture and any local-only gallery, so
-- the partial index applies only to explicitly sourced galleries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_galleries_owner_source
  ON galleries(owner_id, source_url)
  WHERE source_url IS NOT NULL;
