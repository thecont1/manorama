-- The account's device list. Deliberately anonymous: a random device id, its
-- kind, the number that names it ("Mac 2") and the colour slot its pill wears.
-- No machine name, serial or hardware id is ever stored — the label column on
-- device_galleries carried the owner's ComputerName and is dropped below.
CREATE TABLE IF NOT EXISTS devices (
  owner_id TEXT NOT NULL REFERENCES users(account_id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('mac', 'windows', 'linux', 'iphone', 'ipad', 'android')),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
  colour INTEGER NOT NULL CHECK(colour BETWEEN 0 AND 11),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, kind, ordinal),
  UNIQUE (owner_id, colour)
);

CREATE INDEX IF NOT EXISTS idx_devices_owner_seen ON devices(owner_id, last_seen_at);

-- Backfill: every mirror row that exists today came from the macOS app, so
-- each distinct device_id becomes a Mac, numbered in first-sync order.
INSERT OR IGNORE INTO devices (owner_id, id, kind, ordinal, colour, first_seen_at, last_seen_at)
  SELECT owner_id, device_id, 'mac', rn, (rn - 1) % 12, first_seen, last_seen FROM (
    SELECT owner_id, device_id, MIN(updated_at) AS first_seen, MAX(updated_at) AS last_seen,
      ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY MIN(updated_at), device_id) AS rn
    FROM device_galleries GROUP BY owner_id, device_id);
