-- A released owner slug stays reserved for the account that held it: a
-- rename or delete no longer frees the address for a stranger to claim,
-- so a previously shared link 404s instead of serving someone else's
-- galleries. Reservations never expire and deliberately survive the
-- account itself — a deleted account's links stay dead forever.
--
-- Accepted exposure: the table starts empty, and nothing records which
-- slugs were released before it existed — deleted accounts removed every
-- trace of themselves, and renames overwrote the single owner_slug field.
-- A slug released before this migration can therefore still be claimed by
-- a different account, and an old shared link to it would resolve to the
-- new owner. There is no reliable source to backfill from, so the window
-- is accepted: releases after this migration are covered; releases before
-- it are not, and the users table is NOT a safe source of truth for them.
CREATE TABLE IF NOT EXISTS owner_slug_reservations (
  owner_slug TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  reserved_at TEXT NOT NULL DEFAULT (datetime('now'))
);
