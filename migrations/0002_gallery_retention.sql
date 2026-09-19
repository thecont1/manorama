ALTER TABLE galleries ADD COLUMN retention TEXT NOT NULL DEFAULT 'retained' CHECK (retention IN ('retained', 'pipeline'));
ALTER TABLE galleries ADD COLUMN expires_at TEXT DEFAULT NULL;
CREATE INDEX idx_galleries_retained_owner ON galleries(owner_id) WHERE retention = 'retained';
CREATE INDEX idx_galleries_pipeline_expiry ON galleries(expires_at, owner_id, slug) WHERE retention = 'pipeline';
