-- Zero-knowledge gallery-key escrow. Every payload column is client-written
-- ciphertext or KDF parameters; the server never sees a plaintext key, the
-- sync passphrase, or the vault key it protects. owner_key_vault is one row
-- per account; gallery_keys hangs off the immutable gallery id the client's
-- own key store already uses.
CREATE TABLE IF NOT EXISTS owner_key_vault (
  owner_id TEXT PRIMARY KEY,
  kdf_salt TEXT NOT NULL,
  kdf_iterations INTEGER NOT NULL,
  wrapped_vk TEXT NOT NULL,
  vk_nonce TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gallery_keys (
  owner_id TEXT NOT NULL,
  gallery_id TEXT NOT NULL,
  wrapped_source TEXT NOT NULL,
  nonce TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, gallery_id)
);
