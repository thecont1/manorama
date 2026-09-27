CREATE TABLE IF NOT EXISTS device_galleries (
  owner_id TEXT NOT NULL REFERENCES users(dropbox_account_id),
  id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('folder', 'card')),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 0 AND 1000),
  device_id TEXT NOT NULL,
  device_label TEXT NOT NULL CHECK(length(device_label) BETWEEN 1 AND 80),
  public_gallery_slug TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS idx_device_galleries_owner_updated ON device_galleries(owner_id, updated_at DESC, id);
