-- Reversible custody migration: a converted manifest keeps the legacy key
-- until two distinct devices verify decryption, or the owner explicitly
-- opts out. The device ids are non-secret random identifiers.
ALTER TABLE galleries ADD COLUMN key_retired_at TEXT;
ALTER TABLE galleries ADD COLUMN migration_devices TEXT NOT NULL DEFAULT '[]';
