-- The ops console's Location column: the Cloudflare edge datacenter that
-- served the last sign-in (IATA code, e.g. SIN) beside the already-stored
-- country, plus the sign-in's own timestamp. The edge code stands in for a
-- stored IP — cf already computes it, and per-account IPs are outside what
-- the privacy policy discloses.
ALTER TABLE users ADD COLUMN last_seen_colo TEXT;
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
