# Authentication

Manorama has exactly one human identity: the gallery owner (Mahesh), acting
through the owner administration surface at `/<OWNER_SLUG>` and the gallery
management API under `/api/galleries`. Identity is Cloudflare Access — there
is deliberately no password database, no magic-link store, and no anonymous
or demo principal.

## Application-level verification (authoritative)

Every gated request is verified by `app/lib/session.ts`
(`resolveManoramaSession`), which is the single resolver for both the
management API middleware (`app/lib/session.ts` `requireSession`, applied at
the route-group boundary in `app/api.ts`) and the Vendo principal
(`vendo/server.ts`). It verifies the Cloudflare Access JWT from the
`Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie, through
the identical verification path) against the Access team JWKS:

- issuer: `https://<CF_ACCESS_TEAM_DOMAIN>.cloudflareaccess.com`
- audience: `CF_ACCESS_AUD` (the Access application's AUD tag)
- signature (RS256, team JWKS at `<issuer>/cdn-cgi/access/certs`)
- expiry / not-before
- a non-empty immutable `sub` claim

Failures — missing configuration, missing token, wrong audience or issuer,
expired or not-yet-valid tokens, bad signatures, missing `sub` — resolve to
`null` and the request is refused with `401` JSON. Emails are surfaced only
as verified token claims, never accepted from headers, query strings, or
bodies. Subjects are `cf-access:<sub>` and never the email address.

Gated surfaces:

- `GET/POST /api/galleries`, `POST /api/galleries/scan`,
  `PATCH/DELETE /api/galleries/:slug`, `POST /api/galleries/:slug/refresh`
- the owner administration page `/<OWNER_SLUG>` (middleware gate plus a
  fail-closed check in `app/routes/[owner].tsx`)

Intentionally public surfaces:

- public gallery pages `/<OWNER_SLUG>/<slug>`
- `/api/dropbox/thumbnail` and `/api/dropbox/file` (public gallery pages load
  Dropbox-sourced images through this proxy; the underlying Dropbox folders
  are public share links)
- `/api/vendo/*` (the Vendo composition applies the same resolver and fails
  closed on its own)

## Cloudflare Access configuration (defence in depth)

The application verifies tokens itself, so a mis-scoped Access policy can
never silently open the admin surface. Access in front of the origin is
still required so the owner gets a login flow and the Worker receives
assertions. Configure in the Cloudflare Zero Trust dashboard (or IaC) for
the `manorama.xyz` zone:

1. **Self-hosted Access application** covering the admin and management
   paths:
   - `manorama.xyz/<OWNER_SLUG>` (the administration page)
   - `manorama.xyz/api/galleries*` (the management API)
   Exclude the public image proxy paths
   `manorama.xyz/api/dropbox/thumbnail` and `manorama.xyz/api/dropbox/file`
   and the public gallery pages `manorama.xyz/<OWNER_SLUG>/*` from the
   application's path rules, or scope the application to the exact paths
   above only.
2. **Policy**: `Allow`, `Include` → `Emails` → the owner's email address
   only. No open registration, no bypass rules.
3. **Record the application's AUD tag** and set it as the Worker
   configuration value `CF_ACCESS_AUD` (see below).

Because the Worker re-verifies issuer/audience/signature, an origin or
preview bypass that skips Access still cannot reach the management API or
render the admin page.

## Environment configuration

Non-secret configuration (Wrangler `[vars]` or dashboard settings):

- `CF_ACCESS_TEAM_DOMAIN` — the Zero Trust team domain (the `<team>` in
  `<team>.cloudflareaccess.com`).
- `CF_ACCESS_AUD` — the Access application's audience (AUD) tag. This is
  configuration, not identity: possession of it grants nothing without a
  valid signed token.

Secrets (Wrangler secret store only, never in TOML or committed files):

- `VENDO_API_KEY` — the Vendo Cloud key (see `vendo/server.ts`).

Local development sets these in `.env.local` (never committed). Tests inject
a local JOSE verifier (`app/lib/session.test.ts`, `app/server.test.ts`) so
no test ever contacts Cloudflare.
