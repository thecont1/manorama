# Authentication

Manorama is a consumer app with three kinds of participants:

- **Viewers** — no authentication. Anyone with a gallery link
  (`/<owner_slug>/<slug>`) can view its photos.
- **Gallery editors** — Dropbox sign-in. Up to 3 galleries.
- **Paying editors** (future) — Dropbox sign-in. Unlimited galleries and
  richer customisations. The `tier` column already carries this seam.

There is deliberately no password database, no magic-link store, and no
sign-up form: Dropbox owns the account lifecycle, we only accept
signed-in Dropbox users.

## Identity

The user's immutable Dropbox account ID (`dbid:…`) is the identity and
the repository owner key. The owner slug (`/<owner_slug>/…`) is
user-facing and changeable at any time; galleries reference the account
ID, so a slug change never orphans them. Emails surface only as verified
Dropbox account claims.

## The sign-in flow

1. `GET /` — the landing page carries the one quiet "Continue with
   Dropbox" button and doubles as the sign-in door: an existing session
   skips straight to the dashboard.
2. `GET /auth/dropbox` — sets a short-lived CSRF state cookie and
   redirects to Dropbox's OAuth2 authorize endpoint. The redirect URI is
   derived from the request origin (register both
   `https://manorama.xyz/auth/dropbox/callback` and the dev origin in
   the Dropbox app console).
3. `GET /auth/dropbox/callback` — verifies the state cookie, exchanges
   the code, fetches the account, upserts the user (minting a unique
   owner slug from the display name on first sign-in), and sets the
   session cookie.
4. `POST /auth/logout` — clears the session.

## Sessions

`app/lib/dropbox-session.ts` mints an HS256 JWT (signed with
`HOST_API_JWT_SECRET`) into the `manorama_session` httpOnly cookie. The
token carries only the Dropbox account ID; the owner slug, name, and
tier are loaded from D1 on every request, so profile changes apply
immediately. Missing secret, missing cookie, invalid/expired token, or
a deleted account all fail closed to `null` → `401` JSON for API
routes, a `/` redirect for the dashboard.

## Storage (D1)

- `users` — one row per Dropbox account: `dropbox_account_id` (PK),
  unique `owner_slug`, display name, email, `tier`.
- `galleries` — keyed `(owner_id, slug)`: two owners may share a gallery
  slug. Public URLs resolve through the owner slug first.

The free-tier limit (3 galleries) is enforced in `POST /api/galleries`
via a per-owner count, returning a polite `403`.

## Gated surfaces

- `GET/POST /api/galleries`, `POST /api/galleries/scan`,
  `PATCH/DELETE /api/galleries/:slug`, `POST /api/galleries/:slug/refresh`
  — scoped to the signed-in owner.
- `PATCH /api/account` — changes the signed-in owner's URL segment.
- `GET /<owner_slug>` — the dashboard; renders only for that owner.
- `/api/vendo/*` — the Vendo composition applies the same resolver
  (`vendo/server.ts`) and fails closed on its own.

## Intentionally public surfaces

- Public gallery pages `/<owner_slug>/<slug>`
- `/` and the OAuth redirect endpoints
- `/api/dropbox/thumbnail` and `/api/dropbox/file` (public gallery pages
  load Dropbox-sourced images through this proxy; the underlying folders
  are public share links)

## Environment configuration

Non-secret configuration (Wrangler `[vars]` or dashboard settings):

- `PUBLIC_HOST` — the public origin.
- `VENDO_BASE_URL` — the public origin for Vendo's resource URLs.

Secrets (Wrangler secret store only, never in TOML or committed files):

- `HOST_API_JWT_SECRET` — signs the session cookie.
- `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` — the Dropbox app powering
  both the OAuth sign-in and the gallery folder scanner.
- `VENDO_API_KEY` — the Vendo Cloud key (see `vendo/server.ts`).
- `AIRTABLE_PAT` / `AIRTABLE_BASE_ID` — legacy; only needed while the
  one-time gallery migration to D1 is pending
  (`scripts/migrate-galleries.ts`).

Local development sets these in `.env.local` (never committed). Tests
mint real HS256 tokens with a test secret and seed the in-memory user
store (`app/lib/test-fixtures.ts`) — no test ever contacts Dropbox or
Cloudflare.
