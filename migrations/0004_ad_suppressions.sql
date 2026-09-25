-- The master's plate kill switch: suppress the house cadence for a UTC day
-- or a viewer region. Rows are written by the session-gated API; the public
-- visibility endpoint reads them per request and never logs who asked.
CREATE TABLE IF NOT EXISTS ad_suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('day', 'region')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (kind, value)
);
