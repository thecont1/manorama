-- A released owner slug stays reserved for the account that held it: a
-- rename or delete no longer frees the address for a stranger to claim,
-- so a previously shared link 404s instead of serving someone else's
-- galleries. Reservations never expire and deliberately survive the
-- account itself — a deleted account's links stay dead forever.
CREATE TABLE IF NOT EXISTS owner_slug_reservations (
  owner_slug TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  reserved_at TEXT NOT NULL DEFAULT (datetime('now'))
);
