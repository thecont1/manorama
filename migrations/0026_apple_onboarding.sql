-- The first Sign in with Apple consent is the only one that ever carries the
-- user's name. On the macOS shell that consent now happens in the native
-- sheet, whose unknown-identity answer is a 404 — without this table the name
-- is discarded there, and the web round trip that follows cannot recover it
-- because Apple never sends it twice. The native endpoint stashes the verified
-- name here keyed by the Apple subject; the account-creation interstitial
-- consumes it when the same subject completes the web flow. Rows expire
-- unconsulted in fifteen minutes — onboarding either happens promptly or the
-- name was never owed.
CREATE TABLE apple_onboarding (
  subject TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
