# Architecture and threat model at `c7d8002`

Only what the code and the active build configuration contain. Where a
document and the code disagree, the code wins and the disagreement is noted
(R3-03).

## What is deployed

One Cloudflare Worker (`wrangler.toml`, `main = ./dist/index.js`, D1 `manorama`,
R2 `manorama-downloads`, cron `17 3 * * *`) serving three hostnames:

| Host | Role |
| --- | --- |
| `manorama.xyz` | Marketing homepage, dashboard `/{owner}`, public gallery `/{owner}/{slug}`, quick-add catch-all, `/api/*` |
| `signin.manorama.xyz` | The chooser at `/` and the whole `/auth/*` OAuth surface; every other path 302s back to the apex |
| `downloads.manorama.xyz` | R2-backed installer and release history, plus `latest.json` for the shells' update check |

The `/auth/*` routes on the apex redirect to the sign-in host (except
`/auth/logout`); session cookies become `Domain=.manorama.xyz` cookies when
`SIGNIN_HOST` is configured, and every deletion carries the same domain.

## Clients

| Client | What it is | Boundary |
| --- | --- | --- |
| Web | HonoX SSR + islands; bearer cookie `manorama_session` (HS256 JWT, 7 days, `HttpOnly`, `SameSite=Lax`) | Browser ↔ Worker |
| iOS / Android | Capacitor WebView of `native/` bundle, `capacitor://localhost` / `https://localhost`; bearer token in the secure store | WebView ↔ Keychain/Keystore, WebView ↔ Worker |
| Tauri (macOS, Windows, Linux) | `tauri://localhost`; Rust commands for the picker, app-private files, vault and keyring; runtime fs/asset scopes | WebView ↔ Rust ↔ filesystem/keyring |
| SwiftUI macOS shell | Serves the *desktop* bundle from `manorama://localhost`, answers `window.__TAURI_INTERNALS__` through `desktop-shell/bridge.ts`, and proxies the API through the custom scheme | WebView ↔ `WKScriptMessageHandler` ↔ filesystem/Keychain |

The SwiftUI shell is a second implementation of the same native API, not a
wrapper around the Rust one: `NativeBridge.swift` re-implements the Tauri
command names, and the media scheme (`manorama://media/…`) replaces
`asset://localhost`. Each is audited as its own boundary.

## Server-side data

D1 only, no provider bytes (invariant 1):

`users`, `auth_identities`, `auth_flows`, `galleries` (metadata plus an ordered
manifest in `images_json`), `device_galleries`, `devices`, `gallery_keys`,
`owner_key_vault`, `owner_slug_reservations`, `master_accounts`,
`ad_suppressions`.

Assets:

- the session JWT (a 7-day bearer for the whole account);
- `sourceUrl` — the provider share link, i.e. the gallery's only capability.
  Served to the owner in `/api/galleries`, `/api/library`,
  `/api/galleries/:slug`, and to nobody else except as the keyless form in a
  public encrypted manifest;
- `gallery_keys` / `owner_key_vault` ciphertext (undecryptable server-side);
- email, display name, country/colo of last sign-in, tier.

Nothing in D1 is encrypted at the application level except the key escrow, and
the plan does not claim otherwise.

## Trust boundaries and who is hostile

1. **Renderer → Worker.** Every request body, header, path segment and query is
   attacker input. A signed-in owner is also an attacker: the API must not
   trust a client-supplied tier, gallery id, owner id, retention or manifest.
2. **Renderer → native bridge (macOS).** A compromised renderer is the attacker.
   The bridge answers only when `frameInfo.isMainFrame`, `trustedDocument` (set
   at commit/finish from the committed URL) and the frame's
   `securityOrigin` scheme+host are `manorama`/`localhost`
   (`ViewerWebView.swift:71-139`). Commands are a fixed switch; the private
   files are an allowlist of five names; every renderer-supplied path is checked
   against picker-granted roots or the vault prefix.
3. **Renderer → filesystem.** Grants come from the folder picker only — Swift
   bookmarks in `FolderStore`, Rust `roots.json` written by the picker — never
   from the renderer-writable catalogue. Containment is proven on resolved
   components, never on string prefixes.
4. **Worker → provider.** Fixed hosts; Dropbox with app key/secret, Drive with an
   API key, iCloud and Google Photos with no credential. Response bytes are
   sniffed and the outgoing `Content-Type` is pinned by an allowlist with an
   `application/octet-stream` fallback, so a shared `.html` cannot become
   same-origin script.
5. **Client → encrypted provider.** MEGA, Ente and Proton are scanned and
   decrypted on the device; the server receives a validated keyless manifest.
   Proton is native-only because it will not serve a browser.
6. **Provider → billing.** Stripe and RevenueCat webhooks are the only
   anonymous endpoints that move privilege; both verify an HMAC over
   `timestamp.body` and an ordering watermark.
7. **Device → local data.** The encrypted vault: AES-256-GCM per record, key per
   gallery in Keychain/Keystore, `galleryId\0entryId` plus record header as AAD.

## Attacker models used

| Model | Applied to |
| --- | --- |
| Anonymous internet | Public manifest, proxies, OG cards, quick-add, auth callbacks, webhooks |
| Authenticated stranger | Every `/api/galleries/*`, `/api/account/*`, adopt, device routes |
| Malicious gallery owner | Titles, captions, filenames, per-item metadata, encrypted manifests, slugs |
| Compromised renderer | The macOS bridge, the media scheme, the API proxy, the vault commands |
| Hostile provider response | Malformed, slow, oversized, differently-typed upstream answers |
| Local tampering | A `roots.json`, catalogue or symlink inside a granted folder changed by another local process |
| Local-network attacker | The OAuth loopback listener on `127.0.0.1:<ephemeral>` |

Excluded: production traffic and load, real provider behaviour, real user data,
credential stuffing, and any machine already running code as the user (a local
attacker is treated as able to read and modify app-private files, not the
Keychain of a running app).

## Active versus deprecated

- The **Tauri build is active** for Windows/Linux; on macOS it ships alongside
  the SwiftUI shell and reads the same config directory and vault
  (`NativeBridge.defaultConfigDir()` matches Tauri's `app_config_dir`).
- **`desktop-viewer/` holds no tracked file** at this SHA (the primary checkout
  has an empty directory there; git does not carry empty directories) — nothing
  to audit.
- The web app keeps its deliberate forgetfulness: no vault, no offline, no
  persisted thumbnails.
- Legacy encrypted rows (`manifestVersion` absent/1 with a keyed `sourceUrl`)
  are still rendered through the legacy path with per-item delivery URLs
  stripped; `encryptedGalleryGate` is the switch, and R3-01 is a case where a
  copy path forgets the field that switch reads.
