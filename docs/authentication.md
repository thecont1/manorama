# Authentication

Manorama is a consumer app with three kinds of participants:

- **Viewers** — no authentication. Anyone with a gallery link
  (`/<owner_slug>/<slug>`) can view its photos.
- **Gallery editors** — Dropbox, Google, or Apple sign-in. Up to 3
  galleries.
- **Paying editors** (future) — the same three providers. Unlimited
  galleries and richer customisations. The `tier` column already carries
  this seam.

There is deliberately no password database, no magic-link store, and no
sign-up form: the providers own the account lifecycle, we only accept
signed-in provider identities.

## Identity

The user's immutable account ID is the identity and the repository owner
key. Accounts created before provider-neutral identity keep their legacy
Dropbox IDs (`dbid:…`); accounts minted since get `acct_<UUID>`. Sign-in
resolves a provider identity row — `(provider, provider_subject)` — to
that account ID via `auth_identities`, so a person can carry more than
one sign-in method. The owner slug (`/<owner_slug>/…`) is user-facing
and changeable at any time; galleries reference the account ID, so a
slug change never orphans them. Emails surface only as verified provider
account claims.

## The sign-in flow

Every provider runs the same transaction (`app/lib/oauth-flow.ts`):

1. `GET /` — the landing page carries a quiet three-provider chooser
   (Dropbox, Google, Apple) and doubles as the sign-in door: an existing
   session skips straight to the dashboard. The `manorama_returning`
   marker only shortens the button copy; the chooser stays the same.
2. `GET /auth/{provider}` — creates a row in `auth_flows` (crypto-random
   `state`, nonce, optional PKCE verifier, handoff flavour, post-login
   destination) and redirects to the provider's authorize endpoint. The
   redirect URI is derived from the request origin (register both
   `https://manorama.xyz/auth/{provider}/callback` and the dev origin in
   each provider console). `?link=1` upgrades to a link flow only when the
   caller already holds a session; `native=1` and `native=desktop` (with a
   `code_challenge`) select the client handoffs.
3. `GET /auth/{provider}/callback` — consumes the `auth_flows` row
   **first** (a `DELETE … RETURNING`, so state is single-use and no
   provider call ever runs on a replayed or expired state), exchanges the
   code, verifies the identity, then either signs in or links:
   - **sign-in** resolves the `(provider, subject)` identity row (creating
     an `acct_…` account and a unique owner slug on first sign-in), sets
     the session + returning cookies, and lands on the stored `next` URL
     (same-origin only) or `/{owner_slug}`.
   - **link** re-verifies the browser session against the flow's bound
     `account_id`, attaches the identity, and lands on
     `/{owner_slug}?linked=<provider>` (`?link=conflict` when the subject
     belongs to another account). Linking is web-only for now: the intent
     is bound to the session that started it, so `?link=1` needs the
     session cookie riding the top-level navigation — the dashboard's
     "Connect" anchors rely on exactly that.
   - Without a D1 binding the callback answers a generic no-store `503`
     rather than a misleading credential error.
4. `POST /auth/apple/callback` — Apple's `response_mode=form_post`
   arrives cross-site as a form POST carrying `code`, `state` and a
   one-time `user` JSON (the only place a display name ever appears).
   Because all flow state is server-side, no `SameSite=None` cookie is
   needed. A bare GET on this route just errors.
5. `POST /auth/logout` — clears the session.

There are no OAuth cookies anywhere: `state`, `nonce`, the Google PKCE
verifier, the desktop `code_challenge` and `next` all live in
`auth_flows` behind the random `state` key, with a ten-minute TTL and an
opportunistic purge on each create.

### Client handoffs

The native shell offers the same three providers
(`beginProviderSignIn` in `native/lib/session.ts`, three buttons in
`native/islands/GalleryList.tsx`): each opens `/auth/{provider}?native=1`
in the system browser. Account linking stays on the web dashboard.

- `native=1` redirects the callback to
  `in.thecontrarian.manorama://auth/callback?handoff=…`, a one-minute
  purpose-bound JWT that `POST /api/auth/native/exchange` trades for the
  normal bearer session.
- `native=desktop` binds the app's PKCE `code_challenge` into a
  `desktop-handoff` token on
  `in.thecontrarian.manorama.desktop://auth/callback?handoff=…`;
  `POST /api/auth/desktop/exchange` (body-limit 8 KB, `no-store`) mints
  the session only for the holder of the matching verifier. The Tauri
  origin `tauri://localhost` is allowed by the API's CORS list.

### Provider adapters

All three routes exist, but Google and Apple still need owner-side
console configuration before they work in production: `GOOGLE_AUTH_CLIENT_ID`
/`GOOGLE_AUTH_CLIENT_SECRET` (Web client, PKCE is mandatory — the
verifier lives in `auth_flows`) and `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` /
`APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` (Services ID with the callback as a
return URL). `.env.example` carries commented placeholders for all of
them. A missing configuration lands on the generic `/?error=1`.
Apple's refresh token — returned on the first authorization only — is
currently **discarded**; it stays unused until an encrypted revocation
design exists.

## Sessions

`app/lib/session.ts` mints an HS256 JWT (signed with
`HOST_API_JWT_SECRET`) into the `manorama_session` httpOnly cookie. The
token carries only the account ID (`sub`, including legacy `dbid:…`
values); the owner slug, name, and tier are loaded from D1 on every
request, so profile changes apply immediately. Missing secret, missing cookie, invalid/expired token, or
a deleted account all fail closed to `null` → `401` JSON for API
routes, a `/` redirect for the dashboard.

## Storage (D1)

- `users` — one row per account: `account_id` (PK), unique `owner_slug`,
  display name, email, `tier`.
- `auth_identities` — `(provider, provider_subject)` PK mapping to
  `account_id`, with `UNIQUE (account_id, provider)`: one subject per
  provider per account. Migration 0005 backfills every existing user as
  `('dropbox', account_id)`; `GET /auth/{provider}?link=1` attaches
  further rows, `DELETE /api/account/identities/:provider` detaches them
  (the last one is protected). The dashboard's "Sign-in methods" section
  is the owner-facing UI for both — connect anchors for unlinked
  providers, a remove action for every linked row beyond the first, and
  the `?linked=` / `?link=conflict` landing notes.
- `auth_flows` — single-use OAuth transactions keyed by `state`:
  provider, intent (`signin`/`link`), bound `account_id` for links,
  nonce, PKCE verifier, app challenge, handoff flavour and `next_url`,
  with `expires_at` (10 minutes) and an index for the purge. Consuming is
  a `DELETE`, so nothing about a flow can ever be replayed.
- `galleries` — keyed `(owner_id, slug)`: two owners may share a gallery
  slug. Public URLs resolve through the owner slug first.

The free-tier limit (3 galleries) is enforced in `POST /api/galleries`
via a per-owner count, returning a polite `403`.

## Migration rollout gate

Migration 0005 renames the `users` primary key to `account_id`, so it is
an owner-only coordinated cutover: apply the migration and deploy the
new Worker together. Worker code older than the cutover is incompatible
with the renamed column, and once new `acct_…` accounts exist there is
no automatic rollback to old code. The migration has been rehearsed on
local D1 (row preservation, identity backfill and foreign-key integrity
are verified in `app/lib/account-migration.test.ts`). Migration 0006 adds
`auth_flows` and is safe to apply ahead of or alongside the deploy — old
code simply ignores the table. The Google and Apple routes are live but
inert until the owner registers each provider's client credentials.

## Gated surfaces

- `GET/POST /api/galleries`, `POST /api/galleries/scan`,
  `PATCH/DELETE /api/galleries/:slug`, `POST /api/galleries/:slug/refresh`
  — scoped to the signed-in owner.
- `PATCH /api/account` — changes the signed-in owner's URL segment.
- `GET /api/account/identities` — lists the account's sign-in methods
  (`provider`, display name, verified email — never `provider_subject`).
- `DELETE /api/account/identities/:provider` — removes one method; `404`
  when absent, `409 {error:"last-identity"}` when it is the only one left.
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

- `HOST_API_JWT_SECRET` — signs the session cookie and the native/desktop
  handoff tokens.
- `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` — the Dropbox app powering
  both the OAuth sign-in and the gallery folder scanner.
- `GOOGLE_AUTH_CLIENT_ID` / `GOOGLE_AUTH_CLIENT_SECRET` — the Google Web
  client for `/auth/google` (owner setup pending).
- `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` /
  `APPLE_PRIVATE_KEY` — the Sign in with Apple Services ID, team and
  ES256 key for `/auth/apple` (owner setup pending).
- `VENDO_API_KEY` — the Vendo Cloud key (see `vendo/server.ts`).
- `AIRTABLE_PAT` / `AIRTABLE_BASE_ID` — legacy; only needed while the
  one-time gallery migration to D1 is pending
  (`scripts/migrate-galleries.ts`).

Local development sets these in `.env.local` (never committed). Tests
mint real HS256 tokens with a test secret and seed the in-memory user
store (`app/lib/test-fixtures.ts`) — no test ever contacts Dropbox or
Cloudflare.
