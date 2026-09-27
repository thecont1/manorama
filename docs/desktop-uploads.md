# Desktop share/upload lane

The explicit-share slice of the macOS shell (`docs/desktop-local-viewer.md`
covers the viewer contract). A saved gallery can be uploaded to the owner's
own Dropbox or Google Drive and turned into a public Manorama gallery —
**only on explicit user action**. Nothing uploads on open, on rescan, on
launch, or on mount: the "Share…" button is the only entry point, and its
confirmation step (`shareLocalGallery`'s `confirm` gate) precedes the first
network call, which `desktop/lib/share.test.ts` asserts.

## What crosses the network

| Destination | Payload |
|---|---|
| Provider (Dropbox / Drive) | Original bytes, byte-for-byte, under sanitized basenames inside `manorama/<gallery>` |
| Worker (`POST /api/galleries`) | Exactly `{ url: <public share link> }` — the Worker scans the link server-side |
| Worker (`PUT /api/device-galleries/:id`) | The usual metadata projection + `publicGallerySlug` |

No path, filename list, or byte ever reaches the Worker. The provider
share link is the ONLY string that does. Both providers expose
provider-hosted originals, so no image bytes transit manorama infra.

## OAuth — a second, separate authorization

Provider grants are independent of Manorama sign-in: the system browser
goes straight to the provider's authorize endpoint with an installed-app
authorization-code + PKCE flow, and the resulting tokens live in
`providers.json` (private-store allowlist, 0600 — the same tradeoff as
`session.json`; a keychain plugin is the documented upgrade for both).
The state+nonce+PKCE binding is single-use, in-memory, and provider-bound
(`pendingOAuth` in `desktop/lib/providers/oauth.ts`) — deliberately NOT
the Worker's `auth_flows`, which exist for sign-in identity only. The
Manorama session token is never sent to a provider.

Redirect delivery differs by provider:

- **Dropbox** — custom scheme `in.thecontrarian.manorama.desktop://oauth/dropbox`,
  same scheme sign-in already registers; `session.ts`'s deep-link router
  hands non-handoff URLs to `handleProviderDeepLink`.
- **Google Drive** — Google's installed-app clients only allow the loopback
  form. `src-tauri` binds an ephemeral `http://127.0.0.1:<port>` with a
  plain `TcpListener` (`oauth_loopback_begin`/`oauth_loopback_finish`, std
  lib only — no new crates), answers the one redirect with a "return to
  the app" page, and hands the request target back for parsing.

Both flows have the paste-the-link fallback for dev builds (unbundled
binaries cannot receive scheme links; the paste field accepts either the
scheme URL or the loopback URL the browser lands on).

## Provider request shapes

**Dropbox** — `files/upload` (`mode: "add"`, `autorename: true`: the
documented conflict policy — retries add renamed copies rather than
overwriting or erroring), then `sharing/create_shared_link_with_settings`
(public, viewer) on `manorama/<album>`; a `shared_link_already_exists`
conflict falls back to `sharing/list_shared_links` and reuses the existing
link. `files/upload` creates parent folders implicitly. Hard cap:
`DROPBOX_MAX_SINGLE_UPLOAD_BYTES` (140 MB) with a named-file error —
`files/upload_session/*` is the documented extension for larger files.
Scope: default files access; `token_access_type=offline` for the refresh
token.

**Google Drive** — `files.list`/`files.create` for `manorama/<album>`
folders (existing folders are reused), resumable sessions
(`uploadType=resumable` → session URI → PUT raw bytes), then
`permissions.create` `reader`/`anyone` on the album folder; the share link
is `https://drive.google.com/drive/folders/<id>` — the shape the Worker's
Drive scanner already reads. Scope: **`drive.file` only** — file-level
access to files this app created; no full-drive, no openid mixing.
`access_type=offline` + `prompt=consent` guarantees a refresh token.

## Failure and retry semantics

There are NO destructive provider calls anywhere — no delete, no
overwrite, no revoke. A failure aborts mid-album leaving partial provider
content in place; retrying re-adds files (Dropbox autorenames on conflict,
Drive permits same-name siblings) and reuses or recreates the folder link.
`disconnect()` forgets the local grant only — revocation is the owner's
action on the provider's site. In-album name collisions resolve
deterministically (`name (2).ext`) so rescans reshare the same set.
`POST /api/galleries` 409 (link already scanned) reuses the existing
gallery slug rather than erroring.

## Build-time client identifiers

Provider OAuth client IDs are PUBLIC app identifiers — they name the app,
they are not secrets — injected via `import.meta.env` (the desktop vite
config exposes the `MANORAMA_DESKTOP_` prefix and reads env from the repo
root). Empty means "not configured in this build" and the share sheet
renders the provider row disabled.

| Variable | Purpose |
|---|---|
| `MANORAMA_DESKTOP_DROPBOX_CLIENT_ID` | Dropbox app key for the desktop upload app |
| `MANORAMA_DESKTOP_GOOGLE_CLIENT_ID` | Google Cloud OAuth client id (Desktop type) |
| `MANORAMA_DESKTOP_GOOGLE_CLIENT_SECRET` | Optional — the desktop client's public-by-design secret if your client type requires it at exchange time; most desktop clients do not |

## Owner console setup (required before a live upload)

**Dropbox** — https://www.dropbox.com/developers/apps: create an app
(Scoped access; "App folder" or "Full Dropbox" both work — `manorama/<album>`
lands at the app's visible root either way; files.read/write implied by
scoped-file permissions — enable `files.content.write` and
`sharing.write`). Register the redirect URI
`in.thecontrarian.manorama.desktop://oauth/dropbox`. The app key becomes
`MANORAMA_DESKTOP_DROPBOX_CLIENT_ID`. No secret ships in the client — the
PKCE flow needs none.

**Google** — Google Cloud Console: create an OAuth consent screen
(external), then an OAuth 2.0 Client ID of type **Desktop app**. Enable
the Google Drive API on the project. The sensitive-scope verification for
`drive.file` is required before non-test users can consent (add
`…/auth/drive.file` on the consent screen; test-user mode works while
unverified). The client id becomes `MANORAMA_DESKTOP_GOOGLE_CLIENT_ID`;
loopback redirects need no registered URI for Desktop-type clients.
