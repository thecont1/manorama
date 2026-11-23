-- The ops console no longer surfaces the Cloudflare edge code: it described
-- the datacenter that answered the request, not the owner. Stored values are
-- cleared; the column stays (nothing reads it) — dropping it buys nothing.
UPDATE users SET last_seen_colo = NULL;
