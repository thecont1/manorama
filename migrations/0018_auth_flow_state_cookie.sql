-- Binds an OAuth flow to the browser that opened it. The start route mints
-- a random verifier, keeps only its SHA-256 here, and sets the verifier in
-- an HttpOnly cookie named for the state; the callback must present it.
ALTER TABLE auth_flows ADD COLUMN state_cookie_hash TEXT;
