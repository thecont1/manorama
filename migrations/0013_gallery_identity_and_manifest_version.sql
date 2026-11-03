-- Immutable client-key identity and explicit manifest shape versioning.
-- Existing rows retain their legacy keyed manifests until the reversible
-- client migration completes; no source_url or images_json is rewritten here.
ALTER TABLE galleries ADD COLUMN id TEXT;
ALTER TABLE galleries ADD COLUMN manifest_version INTEGER NOT NULL DEFAULT 1;

UPDATE galleries
SET id = lower(hex(randomblob(16)))
WHERE id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_galleries_owner_id
  ON galleries(owner_id, id)
  WHERE id IS NOT NULL;
