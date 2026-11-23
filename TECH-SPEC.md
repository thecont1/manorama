# manorama — technical specification

The user-facing overview lives in [README.md](README.md). This document is the engineering reference: architecture, the media model, the viewer contract, provider ingestion, the native and desktop shells, the homepage and downloads surfaces, and how to run and ship the thing.

## Stack

One repository produces three surfaces:

- **Web** — a Cloudflare Worker running Hono/HonoX (TypeScript, TSX islands hydrated client-side). D1 (`DB` binding) is the production store; vite dev and tests use in-memory repositories instead. Media bytes are never persisted: they stream through same-origin proxy routes at view time.
- **Native** — `native/` builds to a static SPA (`vite.config.native.ts` → `native/dist`), bundled into Capacitor shells for iOS (`ios/`) and Android (`android/`). It boots from bundled assets and its on-device vault — never from the network — and talks to the Worker's `/api/*` over HTTPS for sign-in, gallery manifests, and media.
- **Desktop** — `desktop/` builds to a static SPA (`vite.config.desktop.ts` → `desktop/dist`) rendered inside the native SwiftUI shell (`macos/`, bundle `in.thecontrarian.manorama.desktop`, built by `scripts/build-macos.sh`). The shell speaks the Tauri invoke protocol back to the page through `desktop-shell/bridge.ts`, so the bundle runs unchanged. It is a local-first gallery viewer for folders and cards on disk, with an explicit share flow as the only path by which bytes leave the device. The legacy Tauri shell (`src-tauri/`) still builds — it now ships the Windows and Linux legs only, and is scheduled for removal.

`packages/core` is the shared platform-free heart: `ImageSource`, `GalleryMediaItem`, sizing math, gallery settings, fold geometry, the `AdFrame` contract, device-gallery wire types, account-tier policy, the app-version manifest contract. It must run unchanged in all three hosts — no Worker bindings, no `window`, no Node built-ins, no Capacitor imports. `app/lib/*.ts` carries thin re-export shims for modules moved there.

The Worker also serves two public surfaces from the same deployment: the marketing homepage on `manorama.xyz`, and the installer host on `downloads.manorama.xyz` (see Downloads host below). The downloads hostname short-circuits the app entirely — `app/server.ts` intercepts it before any route runs, so the installer host never touches the gallery API.

Bun is the toolchain (`bun install`, `bun run dev`, `bun run test:unit`); Playwright is the acceptance harness.

## Gallery lifecycle

Owners sign in with Apple, Google, or Dropbox and get a namespace — `manorama.xyz/{owner}/{gallery}` — fed by public Dropbox folder, Google Drive folder, iCloud shared album, Google Photos shared album, and MEGA, Ente, or Proton Drive links without asking gallery providers to connect their accounts. iCloud and Google Photos shared albums, and Dropbox folders, can contribute video alongside photos.

Pasting a supported link runs a server-side scan using platform credentials (Dropbox app credentials, a Drive API key, or none for iCloud, Google Photos, MEGA, Ente and Proton), ignores undisplayable files, loads a low-resolution preview strip, and lets the owner arrange the gallery before adding it.

Added galleries are stored as metadata and ordered media manifests in D1. Original media bytes remain with the provider and are streamed through same-origin Manorama routes when the public gallery is viewed. Removing a gallery removes Manorama's reference only; it does not delete anything at the source.

Free accounts retain up to 3 permanent galleries plus 96 temporary galleries. Creates beyond the permanent three land as temporary `pipeline` galleries — public and listed, but read-only: their cards show a deadline panel with an upgrade link, and title/caption/slug edits, image reordering, and refresh announce the lock instead of acting. Upgrading to Visionary (up to 99 retained galleries) promotes every still-live pipeline gallery back to permanent. Pipeline galleries can still be opened, shared, copied, and deleted. See Gallery retention below.

The internal tier string is `free` | `pro`; **Visionary** is the product-facing name for `pro` (`packages/core/account.ts`, `app/components/home/entitlements.ts`). Product copy, the dashboard, the ops console and the pricing table all use the customer name; only the database and the API use the short string.

## The Library (owner dashboard)

`manorama.xyz/{owner}` is the owner's Library. It is a server-rendered page with one island (`app/islands/Admin.tsx`) that owns the interactive parts, and it reads a lean list from `GET /api/library` — the same gallery summaries as `/api/galleries`, but strip galleries carry only a rail preview and compact ones only a cover. The native and desktop surfaces keep reading `/api/galleries`.

### Section model

Four sections, each collapsible, all held in island state and **not persisted** — the Library opens with every section showing, so the shape of the collection is legible before anything is folded away:

| Section | Default | Renders |
| --- | --- | --- |
| Pinned galleries | open | Full photo strips |
| Cloud galleries | open | Fluid masonry grid of compact cover cards |
| Local galleries | open | Dense tile grid of synced device galleries |
| Hidden galleries | collapsed | Compact cover cards |

The chevron is a decorative `aria-hidden` glyph (`app/components/library/SectionChevron.tsx`); the host button carries `aria-expanded` and the accessible name. Adding a gallery reveals the section it landed in — `revealGallerySection` opens the right section *before* the scroll query runs, so a card inside a folded section mounts first and can be scrolled to.

Which galleries earn a strip and which collapse to a card is decided by `libraryLayout` (`packages/core/library-layout.ts`): a gallery is a strip iff it is pinned, and pinned rows lead by `pinnedAt` so the top of the Library is stable until the owner re-pins. The pin is a display choice only — it never touches `retention` or `expires_at`.

### Fluid grid

The compact grid is a masonry, not a table of boxes. `app/lib/masonry.ts` places cards by *row span* rather than consumed pixels: heights quantize to `MASONRY_ROW_UNIT = 4`px rows, and a column is ranked by its next free row (`rowStart`), so a column can hold fewer pixels but more rows. `app/components/library/useMasonry.ts` computes the column count from the list's own width — `clamp(floor((width + 14) / (240 + 14)), 2, 6)` with a 14px gap — writes `--cols` and each card's `gridColumn` / `gridRow`, and re-places on resize, on card load, and on every render.

The cover image owns its own slot. `app/components/library/CompactCoverImg.tsx` keeps the decoded natural size in state and sets `aspect-ratio` from it, falling back to the stored dimensions; `max-width` is the natural width, so a bitmap is never stretched to fill its box (invariant 13). The anchor reserves no ratio of its own, so the card hugs the image through EXIF-rotated frames and video posters alike.

Local galleries are a different shape: `app/components/library/DeviceGalleriesSection.tsx` renders a `repeat(auto-fill, minmax(150px, 1fr))` grid of super-compact tiles with no masonry, no thumbnail and no cover — the title, the item count and the device's coloured pill (`DevicePill`, whose colour slot is unique per device on the account). The rows arrive from `GET /api/device-galleries`, which returns an **empty array** for a free account rather than a 403, and the web computes no ghost flag (that reconciliation is desktop-only, matched by `deviceId`). The device list itself is `GET /api/devices`; the web reads it and never writes it, because a browser is not a device.

Encrypted sources that this browser cannot open render an `EncryptedCoverPlaceholder` instead of a cover: the provider mark, a label and a note. Proton refuses web transport outright and its card is a dead end — no cover link, no title link. MEGA and Ente are blocked only while the tab does not hold the gallery key; a keyed tab opens them normally.

### Where editing happens

The dashboard no longer owns a reorder surface. Reordering and hiding photographs live in the **gallery's own picker**, in Edit mode (`app/components/viewer/PickerEditor.tsx`) — the picker opened with `G`, which carries an "Edit" affordance for owners and opens directly at `/{owner}/{slug}?edit=1`. The old `?reorder=1` dashboard deep-link is not dead: `app/islands/Admin.tsx` redirects it to the new location, so old links land on the picker.

Title, caption and address are edited from the Gallery Settings sheet's More Settings layer, not inline on the card. The public URL follows the slug.

## Source freshness

The Library notices new photographs at the provider without the owner pressing anything.

`POST /api/galleries/:slug/probe` (`app/api.ts`) is a cheap change probe — one metadata-only listing of the provider source, compared against the stored manifest. It returns one of:

| Status | Meaning |
| --- | --- |
| `changed` | The source provably differs → the caller runs the full refresh |
| `unchanged` | The listing matches the manifest exactly |
| `unknown` | The listing was incomplete, the budget was exhausted, or the manifest predates change tokens — the honest "we could not tell", never silently `unchanged` |
| `device` | The source is end-to-end encrypted; only a shell holding the key can list it |
| `skipped` | Nothing to probe (no source URL, a local folder, or an unrecognised source) |

The compare rules live in `app/lib/source-freshness.ts` and are platform-free, shared by the server probe and the device-side compare. `manifestKeyOf` is the provider's stable item id when it has one (`ref`) and the filename otherwise — the same key the refresh merge and reorder use. `versionedListingDiffers` compares per-item change tokens: Dropbox `rev`, Drive `md5Checksum`/`modifiedTime`, an iCloud derivative set, a CloudKit `recordChangeTag`. `unchanged` requires a version on *both* sides for every item; a missing version yields `unknown`. Providers whose share items are immutable (Google Photos) use `keyListingDiffers` — only an add or a removal counts, and order is deliberately ignored everywhere, because the refresh merge preserves the owner's ordering and a source-side reorder is not a change a refresh would act on. `deviceListingOutcome` returns `unknown` for a truncated device listing, for the same reason.

**Throttle.** `SOURCE_CHECK_INTERVAL_MS` is 24 hours. `sourceCheckDue` treats a missing or unparseable stamp as due. `{ force: true }` bypasses it for a manual check. The stamp (`last_source_check_at`, `migrations/0020_gallery_source_check.sql`) is written **before** the listing — a failed probe still spent the provider call, so the throttle must account for it.

**Device verdicts.** MEGA, Ente and Proton answer `device` *without* stamping the check, so an un-keyed device cannot suppress another device's listing. A shell that holds the key performs the compare locally and reports the verdict back with `{ reported: 'changed' | 'unchanged' | 'unknown' }`; that report is what stamps the check.

**Client trigger.** `app/islands/Admin.tsx` runs the probe on Library load for every retained, source-backed gallery whose check is due. The probes are strictly sequential, every failure is swallowed, and the only visible effect is a silent `refetchLibrary()` when something actually moved — a source check must never make the Library slower or louder. The native and desktop shells run the same effect against their own account endpoints.

**Cost protection.** `app/lib/scan-budget.ts` caps the sub-request budget at `SCAN_SUBREQUEST_BUDGET = 950` with `PROBE_CONCURRENCY = 8`; budget exhaustion returns `unknown`, never a false `unchanged`. Listings break early once more items are found than the manifest holds.

## Gallery settings

One settings surface serves the Library, the viewer, and the desktop shell. `app/components/GallerySettingsSheet.tsx` renders a `Sheet` titled "Gallery Settings" over `app/components/viewer/OwnerGalleryPanel.tsx`, which takes a `layer` prop:

| Layer | Rows |
| --- | --- |
| `quick` | Share link · Reorder photographs · Refresh gallery contents |
| `rest` | Open gallery · Name · Caption · Address · Open source · the device group ("On this Mac") · Remove from Library |
| `all` | Everything — the default when no layer is passed |

"More Settings" is a drill, not a second sheet: one panel instance owns both layers and swapping `layer` keeps the component mounted, so an in-flight refresh survives the drill. Focus follows the drill — to the "More Settings" heading on push, back to the More Settings row's button on pop — and closing steps back one layer before it closes.

The web viewer's own Settings popover (`app/components/viewer/SettingsSheet.tsx`) hosts the same panel twice — `quickPanel` at `layer="quick"`, `galleryPanel` at `layer="rest"` — with both pages mounted under `hidden` for the same reason. The desktop shell imports `app/components/GallerySettingsSheet` directly; native does not, and hands off to its own Details surface instead.

Edits save through `PATCH /api/galleries/:slug` with `{ title }`, `{ caption }` or `{ newSlug }`. The address is validated against `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`; a rename redirects to the new address at the same photograph rather than a 404. A refresh counts elapsed seconds and, past twenty, says so plainly rather than looking hung.

## Quick-add: `manorama.xyz/<share-url>`

Appending a supported share URL to the origin creates the gallery and opens it — `manorama.xyz/https://www.dropbox.com/scl/fo/…` or `manorama.xyz/mega.nz/collection/…#key` both work. Signed-in owners get zero-click creation; signed-out visitors see a branded interstitial whose provider orb round-trips the full URL through OAuth so the gallery completes on return. MEGA and iCloud keys live in the URL fragment, which browsers never send — the catch-all route (`app/routes/[...src].tsx`) recognizes provider-shaped paths, renders the interstitial, and the client (`app/quickadd.ts`) reassembles the complete URL from `pathname` + `search` + `hash`. Non-provider paths fall through to the real routes untouched, and revisiting a link opens the existing gallery (`409` + `galleryUrl`) without re-scanning the provider. Quick-add galleries are named by the platform rather than the provider's folder name — three hyphenated words drawn from a fixed evocative list (`ember-tide-fern`), so the public URL reads like a title; dashboard creates keep the scanned folder name.

## Public URLs

The canonical public URL shape is:

```text
https://manorama.xyz/{owner}/{gallery-slug}
```

`manorama.xyz` is the only live host — the `workers.dev` fallback is disabled in production. Gallery pages emit per-gallery Open Graph cards: `og:image` points at `/api/og/{owner}/{slug}?i={first-item}`, a 1200×630 JPEG composite of the first frame (a video's poster, when the gallery opens with one) with the wordmark pill superimposed. The endpoint caches for a day, keys off the first item so reorders bust edge caches, and falls back to a static card rather than serving a broken image.

## Accounts and sign-in

Accounts are provider-neutral (`migrations/0005_provider_neutral_accounts.sql`). A `users` row holds an immutable `acct_*` account ID, the owner slug, display name, email, tier, and billing-event ordering fields. Sign-in methods live in `auth_identities` — `(provider, provider_subject) → account_id` — so one account can carry Apple, Google, and Dropbox at once; `auth_flows` holds in-flight OAuth state/nonce/PKCE rows with short expiries.

Web sign-in starts at `/auth/{provider}` (orb chooser, Apple listed first), ends at `/auth/{provider}/callback`, and mints an HS256 `manorama_session` cookie signed by `HOST_API_JWT_SECRET`. Google uses a query callback with PKCE; Apple uses `response_mode=form_post` so its callback arrives as `POST`. The shared OIDC code-exchange lives in `app/lib/oidc.ts` and must use `redirect: 'manual'` — the Workers runtime rejects `redirect: 'error'`. Apple's client secret is a short-lived ES256 JWT (`iss` = Team ID, `sub` = Services ID `com.manorama.signin`, `kid` = the Sign in with Apple key ID, `aud` = `https://appleid.apple.com`, 5-minute expiry).

The dashboard route `/{owner}` requires the session to match that owner; anything else redirects to the landing page or 404s.

New-account naming: a provider display name slugifies into the owner slug (`mahesh-v`, `mahesh-v-2`, …). When the provider withholds a name — Apple sends it only inside the `user` JSON on the *first* consent — the account keeps the `Photographer` display-name fallback but mints a three-word slug via the quick-add word list rather than `photographer-N`. `updateOwnerSlug` changes the URL at any time; galleries reference the account ID and follow automatically. A released slug stays reserved for the account that held it (`migrations/0019_owner_slug_reservations.sql`), so a name cannot be picked up by a different account after it is freed.

`DELETE /api/account` is the self-service deletion endpoint (App Review requirement): it batch-removes identities, flows, galleries, device-gallery rows, and master flags, then the user row. Nothing at any provider is touched.

### Native and desktop sign-in handoff

The shells use the same `/auth/{provider}` endpoints with a handoff back to the app:

- **iOS**: `/auth/{provider}?native=1` opens in the system browser; the callback redirects to `in.thecontrarian.manorama://auth/callback` carrying a one-time handoff, which the app exchanges at `POST /api/auth/native/exchange` for a bearer token. The token lives in secure storage (`@aparajita/capacitor-secure-storage`); API calls send `Authorization: Bearer`.
- **Desktop**: PKCE happens in the webview, OAuth in the system browser, and the callback deep-links to `in.thecontrarian.manorama.desktop://auth/callback`. The one-minute, purpose-bound handoff is exchanged at `POST /api/auth/desktop/exchange`; the verifier lives only in RAM, so a cold-start callback cannot be replayed. The session persists in `session.json` via the private-store commands.

Server-side secrets:

| Secret | Purpose |
| --- | --- |
| `HOST_API_JWT_SECRET` | Signs the `manorama_session` cookie and shell bearer tokens |
| `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` | Dropbox OAuth and public shared-link ingestion |
| `GOOGLE_AUTH_CLIENT_ID` / `GOOGLE_AUTH_CLIENT_SECRET` | Google OAuth (web + shells) |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | Sign in with Apple — Services ID, Team ID, and the SIWA `.p8` key |
| `GOOGLE_DRIVE_API_KEY` | Public Drive folder ingestion |
| `REVENUECAT_WEBHOOK_AUTH` / `REVENUECAT_WEBHOOK_SIGNING_SECRET` | Authenticates the RevenueCat tier webhook |
| `STRIPE_WEBHOOK_SIGNING_SECRET` | Authenticates the Stripe webhook (web pro upgrades) |
| `MASTER_DROPBOX_SUBJECT` | Bootstrap identity for the master operations console |
| `AIRTABLE_BASE_ID` / `AIRTABLE_PAT` | Airtable-backed surfaces |

## Storage

D1 is the production store (`DB` binding, `migrations/`); vite dev and tests use in-memory repositories instead. The `users` table holds accounts; the `galleries` table stores per-owner manifests:

| Field | Purpose |
| --- | --- |
| `slug` | Stable gallery URL segment (per-owner unique) |
| `title`, `caption`, `date` | Curtain, admin, and OG copy |
| `sourceUrl` | The public provider link |
| `createdAt` | Recency ordering |
| `imagesJson` | Ordered media manifest — `image` and `video` items in one union |
| `retention` | `retained` (permanent, editable) or `pipeline` (temporary, read-only) |
| `expires_at` | Pipeline removal deadline; `NULL` on retained rows |
| `pinned_at` | Display-only pin stamp; never affects retention |
| `hidden_at` | Hidden-section stamp |
| `last_source_check_at` | When the provider source was last probed for changes |

Remaining tables: `auth_identities` (linked sign-in methods), `auth_flows` (in-flight OAuth state), `device_galleries` (metadata-only sync rows for shell galleries), `ad_suppressions` (per-day/per-region plate switch), `master_accounts` (operations console access), `owner_slug_reservations` (released slugs held for their account).

### Gallery retention

Free accounts keep at most 3 `retained` galleries; further creates insert as `pipeline` rows with `expires_at` exactly 30 days after `created_at`, up to 96 live temporaries — a create beyond the 96 is refused `pipeline-limit`, surfaced as a typed `GALLERY_LIMIT` 403 alongside the paid cap's `limit`. Paid accounts cap at 99 retained galleries — a create beyond that is the same typed `GALLERY_LIMIT` 403. The public cutoff is enforced at read time: once `expires_at` passes, lists and gallery/OG reads hide the row immediately, while stored-record reads keep it reachable for owner deletes and the expiry walk. A daily cron (`17 3 * * *`, 03:17 UTC) physically removes expired rows with a guarded delete — a gallery recreated under the same slug after the scan survives, and manual deletes/upgrades mid-scan are safe skips. Deletion removes only the Manorama row; nothing at the provider is ever touched.

All galleries present before `migrations/0002_gallery_retention.sql` normalize to `retained` with `NULL` expiry — nothing existing goes temporary.

Upgrades run through `setUserTier`, the trusted seam: it writes the tier and promotes every unexpired pipeline gallery (`expires_at > now`, strictly — a deadline equal to now stays expired) in one idempotent batch, so a repeated Visionary write is safe. Never update the D1 `tier` column alone — that would leave pipeline galleries locked on a paying account. Payment verification is the caller's responsibility. Two server-side callers exist: `POST /api/revenuecat-webhook` (native IAP events, ordered by billing-event fields) and `POST /api/stripe-webhook` (web checkout). Promotion can lift an owner past 99 retained galleries; the cap applies only to subsequent creates.

A gallery's Manorama-owned state is the D1 row only — no per-gallery persisted assets or auxiliary tables exist. Pipeline OG cards are served `Cache-Control: no-store` (composite and fallback alike); retained cards keep the existing day cache. Provider-keyed transient caches and browser-local viewer preferences are unchanged and hold no gallery copies.

## Provider ingestion

### Dropbox

The Dropbox app needs the scopes for OAuth sign-in plus public shared-link metadata and file content. End users only ever provide a public shared-folder URL with downloading enabled — ingestion uses the shared-link API path, and delivery routes proxy thumbnails and originals without persisting bytes.

### Google Drive

Google Drive ingestion reads folders shared with "Anyone with the link" using a server-side API key — no end-user OAuth. Listing uses `files.list` scoped to the folder; originals stream through `/api/drive/file` (`alt=media`) and thumbnails through `/api/drive/thumbnail`. HEIC files display via Drive's JPEG thumbnail rendition.

### iCloud

iCloud shared album links (`icloud.com/sharedalbum/#…` or `share.icloud.com/photos/…`) need no credentials — the album token is the only key. Manorama uses the undocumented `sharedstreams` endpoints that power Apple's own public album web viewer. Two consequences: the endpoint is unsupported and may change without notice, and shared albums serve web-optimized derivatives (~2048px JPEGs, ~720p H.264 MP4s) rather than originals, so iCloud media is never marked `c2pa`.

Albums containing video produce mixed galleries: the scanner picks the video derivative and a poster derivative per entry — derivative key names (`720p`, `PosterFrame`) and the asset's URL extension identify them on older album payloads, with a content-type probe as fallback. Video streams through `/api/icloud/video` with `Range` forwarding so seeking does not download the whole clip; posters come through `/api/icloud/image` like any other derivative.

iCloud **Drive** share links (`icloud.com/iclouddrive/…`) are a different product: folder contents sit behind authenticated CloudKit sharing and cannot be scanned anonymously, so they are rejected with guidance to use a Photos Shared Album instead.

### Google Photos

Google Photos shared-album links — `photos.google.com/share/…` or the short `photos.app.goo.gl/…` form — need no credentials: the album id and the `?key=` parameter *are* the access token. Like the iCloud scanner, the API is undocumented and drifts.

The scanner (`app/lib/gphotos-shared.ts`) works in two layers. The share page (fetched with `?_imcp=1` and a desktop-Chrome UA) carries `AF_initDataCallback` blocks whose `ds:\d+` keys hold the item list as a JSON literal; the real album id is recovered from the post-redirect URL, then the canonical `<link>`, then the input. The internal `batchexecute` RPC (`snAcKc`) pages the album with `[albumId, token, null, key]`.

Item nodes are matched by shape, not by index — the list is nested differently across page variants. A photo is an item whose uid begins `AF1Qip`; a **video** is an item carrying the numeric `76647426` descriptor (duration, frame size, poster base) or, in older payloads, a `=m18`/`=m22`/`=dv` rendition marker.

**Scan bound.** The enumeration loop stops at `MAX_GALLERY_ITEMS` (1000) or `MAX_PAGES` (20) or a repeated page token, deduplicating by uid as pages arrive so duplicates never spend the bound. `partial` is set when a next token remains *below* the item cap; `truncated` reports the overrun. The outer bounds are `SCAN_REQUEST_TIMEOUT_MS` (20s per request) and `SCAN_DEADLINE_MS` (90s overall). A transient 429 or 5xx is retried once, honouring server backoff up to `MAX_RETRY_WAIT_MS` (30s).

**Media routing.** There is exactly one Google Photos proxy route, `GET /api/gphotos/image?u=…&r=…`. `u` must be `https` on exactly `lh3.googleusercontent.com`, with no userinfo, search or hash; `r` must match `/^(?:w|h)(\d{1,5})$/` with the dimension between 1 and `MAX_RENDITION_DIM` (16384) — width-bound and height-bound scaling only, never a crop. The `=d` download and `=m18`/`=dv` video renditions are refused. Responses are streamed with `private, max-age=300`, a sniffed `Content-Type`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.

**Video is not proxied.** A clip's `src` is a direct `lh3` URL at the `=m22` rendition (720p H.264). The Worker-minted proxy that existed briefly was removed: a Worker-side fetch of the signed URL 403s because it arrives from a different egress IP. Range requests go browser → lh3 → googlevideo directly. Because those signed URLs bind IP, user agent *and* Referer, the viewer strips the Referer on provider video fetches (`referrerPolicy="no-referrer"` in `app/islands/VideoSlide.tsx`) and page routes serve `Referrer-Policy: same-origin` — Chrome's media stack ignores the element attribute, so the page policy is the lever that actually works. `media-src` in the page CSP allows `https://lh3.googleusercontent.com https://*.googlevideo.com`.

The album's own order is canonical — the filename sort is skipped for Google Photos exactly as it is for iCloud, because shared albums carry no filenames.

### MEGA

MEGA shared folder links (`mega.nz/folder/{id}#{key}`) and collection links (`mega.nz/collection/{id}#{key}`, MEGA's "Sets") need no credentials — the share key in the link fragment is the decryption key, and it never leaves the client. The device enumerates the source through MEGA's public API (`a:'f'` for folders, `a:'aft'` for collections), unwraps node keys, and submits only a validated keyless manifest. Media is fetched from MEGA's CDN and decrypted on-device (AES-128-CTR, in a crypto worker); whole-file retrieval verifies the uploader's meta-MAC, while ranged reads remain unverified by design. Formats browsers cannot render (HEIC, HEIF) use MEGA's generated JPEG/WebP previews decrypted the same way; images with no preview are excluded. The legacy `/api/mega/file` and `/api/mega/preview` endpoints and the `LEGACY_ENCRYPTED_DECRYPT` cohort flag are removed — the routes answer 404 and no configuration can resurrect a server decrypt path.

Caveats: the API is undocumented; decryption happens per view on the client, so large sources mean per-open CPU cost on the device; MEGA's free-tier bandwidth quota (HTTP 509) surfaces as a temporary failure. MEGA images are decrypted originals, so `c2pa` is preserved.

### Ente and Proton Drive

Both are end-to-end encrypted sources, scanned on the device, never on the server. `packages/core/encrypted-source.ts` owns the wire types: `EncryptedMediaReference` carries `{ provider, sourceKind, sourceId, nodeId, previewId }` and never a path, a URL or a secret. The server refuses them outright — `POST /api/galleries/scan` answers `422 CLIENT_SCAN_REQUIRED` ("Encrypted sources are scanned on your device, never by the server"), and the gallery is created from a client-produced `manifestVersion: 2` payload instead.

Ente album links (`albums.ente.io/…`, `albums.ente.com/…`) carry the access token in the path (or `?t=` for legacy links); Proton Drive share links (`drive.proton.me/…`) carry the password that comes with them. Proton refuses web transport outright — a Proton gallery is a dead end in the web Library — while MEGA and Ente open in a browser tab that holds the gallery key. All three answer `device` to the source-freshness probe; the shell holding the key performs the compare and reports the verdict back.

The Proton SDK (`@protontech/drive-sdk`, pinned at 0.23.0) stays behind the dynamic import in `app/lib/proton-client.ts` and never enters the Worker graph.

## Media model

The viewer consumes the `ImageSource` interface in `packages/core/imagesource.ts` (re-exported from `app/lib/imagesource.ts`); `BundledSource` adapts a stored gallery record into the runtime sequence. A gallery is a `GalleryMediaItem[]` union — `image` items and `video` items interleaved, with an absent `type` implying image so all-photo manifests are unchanged. Video items carry a proxy `src`, a poster derivative, dimensions, and an optional duration. Link-sourced records are delivered through the Worker's transient per-provider proxy routes (`/api/dropbox/*`, `/api/drive/*`, `/api/icloud/*`, `/api/gphotos/image`); encrypted-source media resolve through the client session's keyless references instead, so the viewer does not need to know where the media originated.

Each item has a stable ID, an optional provider `ref` (Drive file ID, iCloud photo GUID, Google Photos uid) used for ordering, refresh dedupe and the freshness compare, filename, dimensions, alt text, optional caption and EXIF data, C2PA state, placeholder, and responsive variants. The ordered sequence is persisted in `imagesJson`; dragging or keyboard-moving an item changes only the gallery order, not the source files. A fresh scan canonicalizes to ascending filename (numeric-aware, so `IMG_2` precedes `IMG_10`) — provider listing order is never trusted, with iCloud and Google Photos as the exceptions, whose album order is canonical. Refreshing a gallery keeps the owner's order for retained items, drops media deleted at the source, and appends newly discovered items at the end in ascending filename order.

The asset pipeline treats Content Credentials and ICC profiles as part of the image bytes. Originals are never recompressed, cropped, stretched, upscaled, or converted into a sole alternate format. C2PA verification remains client-side and lazy-loaded.

A Google Photos video enters the manifest as `type: 'video'`, `ref` = the item uid, `src` = the direct `lh3` `=m22` URL, `mimeType: 'video/mp4'`, a poster served through `/api/gphotos/image`, `durationSeconds` where the descriptor knows it, and `fidelity: 'display-derivative'` — the rendition is a derivative, never the original.

## Viewer contract

A gallery opens on the curtain: a frosted veil (28px `backdrop-filter` blur plus a dark scrim) over the first photograph, carrying the mark, title, caption and media count. Tap, click, Enter/Space or an upward swipe dissolves it — the words fade first (0.35s), then the frost thins to nothing while the veil fades out over 1.1s; the photograph stays put and nothing moves, only focus changes to the stage. Reduced motion is a plain 0.2s opacity fade. The gallery is `entered` only when the dissolve finishes, which is when the controls appear and ambient playback unlocks.

At rest the stage is bare — every control lives in temporary chrome (`ViewerChrome`): a top bar with Library (owners and signed-in members; absent for signed-out visitors) and an "N of M" position pill that opens the picker like `G`, and a bottom row with Settings and Info. There is deliberately no title and no Share control — the curtain already named the gallery and sharing lives elsewhere. A stage tap toggles the bars, a fine-pointer move, `Tab`, or the always-present "Show controls" skip button reveals them, and they hide after three idle seconds; hidden bars are `inert` and `aria-hidden`, so unfocusable. Focus or hover inside the chrome pauses the timer, drags, wheel gestures and any other key send it away, and a hide that catches focus inside the bars returns it to the stage. Settings opens a popover anchored above its pill — Layout (Strip/Scroll/One by one), Canvas (Black/Dark/Light), the Arrows switch, web-only Fullscreen and fine-pointer shortcut help first, then a role group: owners get Share link, Reorder photographs, Refresh gallery contents and Manage gallery, members get Add to Library, visitors get Sign in; Info opens a sheet with position, filename, dimensions, caption/EXIF and per-photograph Content Credentials. `I` opens the Info sheet; `⇧I` deep-links the current photograph into the standalone C2PA viewer (`c2pa.thecontrarian.in/?uri=…`) in a new tab, falling back to the Info sheet for sources it cannot fetch (videos, non-http origins). Navigation arrows ship on for fine pointers and hide by default on touch — enabled anywhere outside vertical scroll, they live in a reserved 64px bar beneath the stage (the stage cedes exactly that height, so a control never sits on a photograph): `←` pins the left corner and `→` owns the right. Vertical scroll keeps them off by default at any pointer; enabling the switch floats a stacked ↑/↓ pair at the bottom-right corner instead, stepping the feed one photograph at a time. The viewer supports strip, vertical-scroll, and one-at-a-time modes, pointer and touch dragging, wheel input, keyboard navigation, and reduced-motion preferences — images fit the stage without cropping and are never upscaled past their natural size. One-at-a-time steps run a decode-guarded crossfade — the incoming photograph's bytes decode first (the wait is capped, so a stalled fetch cannot freeze stepping), then the outgoing and incoming frames fade together over 160ms so the stage never dips to bare canvas; there is no directional wipe, and rapid presses collapse onto the latest destination. The strip ends on a "The End." card rather than wrapping; pushing past the last photograph slides it in flush, Scroll foots the feed with the same card, and one-by-one fades it in over the last slide. The card's Rewind runs home in a fixed 0.75s ease-in-out whatever the distance (an instant jump under reduced motion), and Library rides beside it where the chrome offers one. Sizing is density-aware rather than purely CSS-driven: the horizontal strip fits height-first so neighbouring photographs abut edge-to-edge like a photostrip, vertical scroll fits width-first (portraits included — a tall frame simply runs long), and one-at-a-time contains both axes — all with the effective device pixel ratio capped at 2 on the web, so a displayed pixel never claims more source pixels than it shows; native shells instead trust the device's true scale factor (`trustDeviceDpr` in `packages/core/image-staging.ts`), which is knowable on-device.

Spread is an explicit fourth mode on regular-width native layouts. Flat-open photographs are composed together at the largest common height allowed by their combined aspect ratios, available canvas and both sources’ density-aware pixel budgets; widths may differ, with an 8px outer margin and a 12px editorial gutter. An active UIKit division instead supplies two physical regions, including upper/lower laptop regions, and each photograph fits its own region independently. Photograph order never changes; navigation advances consecutive pairs, videos stand alone, and an odd final photograph is not paired with its predecessor again. A 60px trailing rail carries 44px icon targets and the visible range, reserving the same space whether controls are visible or hidden. At compact width the effective mode becomes Strip without changing the saved Spread preference; reopening restores Spread unless the visitor explicitly selected another mode. The ID anchor and explicit video pause survive that transition. `autoSpreadInBookPose` remains `false`; folding itself does not choose a mode.

Video slides are ambient: the active slide mounts the only `<video>` element — muted, looping, `playsInline` — while neighbors render posters only. A pause/play control, an unmute megaphone (sound is a viewer-level toggle), and a `VIDEO · mm:ss` chip overlay the slide; leaving the slide pauses and rewinds, and `prefers-reduced-motion` swaps autoplay for a poster plus an explicit Play control.

On fine-pointer desktops, `M` summons a glass-ball magnifier that follows the cursor over the stage at 3× (a decorative DOM mirror — `aria-hidden`, dismissed by `Esc`, `M`, or opening a dialog). The `M` shortcut row in the Display sheet appears only where the key works; the `I` row is always listed.

The viewer's `G` shortcut opens a centered selector overlay rather than a docked viewer. A full-viewport scrim dims and blurs the stage; the fixed-height filmstrip is vertically centered, uses `variants[0]` (falling back to `placeholder`) with lazy-loaded thumbnails, and centers the active item on open. The selector's shocking-pink `#fc0fc0` box tracks hover and arrow-key selection (with wrap-around, Home, and End); click, Enter, or Space commits the selected item and fades the overlay before calling the existing smooth `goTo(i)`. Pointer drags and dominant-axis wheel input pan its horizontal scroll position, with pointer capture delayed until movement exceeds 6px so ordinary clicks remain native. `Escape`, `G`, and scrim clicks dismiss it, while thumbnail focus and arrow keys provide keyboard selection without changing order.

### Liquid Glass tiers

The glass material follows a four-tier model, documented in `docs/liquid-glass-design-system.md`: native `.glassEffect` capsules on macOS/iOS 26+ where the shell replaces web chrome (`data-macos-glass`, `data-ios-glass` — takeover attributes that may hide web controls); a session-gated SVG `feDisplacementMap` bend on Android's Chromium WebView (`data-android-glass` — **pending**: no producer currently sets the attribute; the spec requires feature detection, a single-segment check and a same-session baseline before it may be set, degradable to flat for the session only, never persisted); Tier-B backdrop-filter frost inside WebViews on every OS version (`data-ios-shell`, `data-android-shell`, `data-macos-shell` — paint-only gates that never hide an element); and a solid Tier 0 under reduced transparency, increased contrast or missing filter support. Glass never wraps an `<img>` and never sits on a thumbnail. The contracts are enforced by `scripts/check-glass.test.ts` and `specs/glass-freeze.playwright.ts`; the frozen web bundle receives no markers and no repaint.

## Marketing homepage

`manorama.xyz/` is the one page the world may find, and it is the only route rendered `indexable: true`. A signed-in visitor is redirected to their dashboard unless the link asks for the marketing page with `?home` — which is how the downloads host's nav reaches it.

The page is server-rendered from `app/components/home/HomePage.tsx` and a section set under `app/components/home/sections/`: Header, Hero, Unify, HowItWorks, Features, Pricing, Faq, FinalCta, Footer. Its stylesheet (`app/home.css`) is linked only when the page is the home, and it loads four scripts: `/theme-init.js`, `/home-theme.js`, `/home-menu.js`, `/home-hero.js`.

`app/components/home/home-manifest.ts` is the single source of truth for everything a launch decision can change — the sample gallery path, the app URLs, the prices, the provider list, the footer links, and the image assets. The plan limits are **imported** from `app/lib/gallery-policy.ts` rather than written out, because a page that says "3" while the policy says 4 is a lie the owner has to find in production. A footer link whose value is `null` is not rendered at all — never a dead link.

### The live demo

The hero is not a video. `app/islands/HomeDemo.tsx` mounts the **production `Viewer`** (`app/islands/Viewer.tsx`) in `embedded` mode — the same component the app ships — with `plate={null}`, `encryptedResolver={null}` and `allowFullscreen={false}`, wrapped in a CSS device frame and its own `GalleryCurtain`. The demo cycles through four phases: `curtain` → `travel` → `end` → `rewind`, calling the viewer's `enter`, `advance`, `showChrome` and `rewind` handles in sequence. The gallery is the owner's own — title "italia, amore mio", caption "family trip to Italy in October 2018".

Device frames are pure CSS (`app/components/home/demo/presets.ts`): `desktop` (MacBook Pro 14-inch, 1512×982), `phone` (iPhone 17 Pro, 402×874), `tablet` (iPad Pro 11-inch, 834×1210) and `duo` (iPhone Duo, 951×669). The frame is chosen by viewport width — under 640px the phone, under 1024px the tablet, otherwise the desktop — and the visitor can switch it from the demo's control bar. The Foldable shows the flat-open inner display in landscape, with no hinge band and the same ordinary Strip and photographer-ordered photographs as every other preset. Its trailing status-bar space and inert vertical controls use the production `ViewerChrome`; the demo does not inject fold geometry, select a foldable from the visitor's device, or advertise Spread before native verification.

The demo never upscales. The frame is scaled to fit the stage, and the scale is capped at `min(2, 2 / devicePixelRatio)` so the viewer's density budget holds. Auto-advance pauses on user pause, on `prefers-reduced-motion`, when the tab is hidden, and when the demo scrolls out of view (an `IntersectionObserver` at threshold 0.1); under reduced motion the demo enters with the chrome visible and does not auto-advance.

### The demo's photographs

The frames are the owner's own Italy originals, cleared for the public page on 13 November 2026 — the approval string is attached to every photo in `app/components/home/demo/manifest.ts`. Renditions are produced by `scripts/home-demo-images.mjs` (Node, not bun — sharp hangs under bun) from an originals path passed at run time and **never committed**; the script writes `public/home-demo/` as AVIF (q50), WebP (q74) and JPEG (q78, mozjpeg) at two sizes (`lg` covers dpr 2, `sm` covers dpr 1), with `withoutEnlargement: true` so a pixel-short source stays at its own size. exiftool strips GPS, IPTC, serials and XMP and writes the Artist/Copyright fields.

The demo is off with the Worker var `MANORAMA_HOME_DEMO=off`: the static hero renders instead, and no demo code or demo assets load at all.

### Navigation, account panel and theme

The desktop nav leads with the Downloads menu, then Features, Pricing and FAQ; the phone menu hangs from the header edge and carries the same destinations plus Sign in and the theme toggle. The Downloads trigger is a real `<a>` to `https://downloads.manorama.xyz/` whose panel opens on hover or focus-within, listing Web app, Mac, Windows, Linux, Android, and iPhone & iPad (marked "soon" until that store listing ships).

The account panel is a popover (`div#home-account-panel`) titled "Continue with", listing the three sign-in providers Apple-first. It auto-opens on `?error=1` and opens on hover on fine pointers.

The theme is shared across hosts. `public/theme-init.js` applies the stored class before first paint; `public/home-theme.js` also writes a `manorama-theme` cookie scoped to `.manorama.xyz`, and the downloads host reads cookie-first-then-localStorage and writes both back — so the colour theme follows the visitor from `manorama.xyz` to `downloads.manorama.xyz`.

## Downloads host

`downloads.manorama.xyz` is the public installer host and release-history surface, backed by the `manorama-downloads` R2 bucket (binding `DOWNLOADS`, in `wrangler.toml` and again under `env.production`). It runs on the same Worker but is short-circuited in `app/server.ts` before any route sees the request, so it never touches the gallery API. `app/lib/downloads.ts` owns the whole surface.

**Object layout.** Installers live under `v<semver>/<file>`; `assets/<platform>/<file>` is a second accepted shape; `latest.json` and `history.json` sit at the root. The key patterns are validated, not trusted.

**`latest.json`** is the mutable release pointer and doubles as the in-app update check. The shape is owned by `packages/core/app-version.ts` so every shell parses one contract:

```json
{
  "version": "0.4.0",
  "released": "2026-11-15",
  "assets": { "mac": "v0.4.0/…", "windows": "v0.4.0/…", "linux": "v0.4.0/…", "all": ["v0.4.0/…"] },
  "mobile": { "ios": null, "android": { "version": "0.4.0", "url": "https://downloads.manorama.xyz/v0.4.0/…" } }
}
```

`version` and `assets` are absent on a mobile-only manifest — the Android pipeline can publish `mobile.android` before any desktop release has shipped, and the page renders mobile rows without desktop assets. The desktop slot covers mac, windows and linux together; the mobile slots are per-platform.

**Permalinks.** `/mac`, `/windows` and `/linux` resolve to the desktop slot; `/android` and `/ios` resolve to the mobile slot. They are *slots*, not versions, so a link published once keeps working after the target moves. An unpublished platform answers 404 "unknown platform or no release published".

**Publishing.** `scripts/build-download-history.mjs` regenerates `history.json` from the git tags — version, tag, date, commit count, and up to eight highlights filtered to `feat`/`fix`/`perf`/`refactor` subjects. The release workflows upload the installers and then read-modify-write `latest.json`.

The write path is guarded on both sides: each job writes only the slot it owns (the desktop job preserves `mobile`, the Android job preserves the desktop fields), a read failure aborts rather than clobbering fields the job does not own, a dotted semver compare makes an older publish a no-op, and both publish jobs share one concurrency group with `queue: max` so a pending publish is queued rather than cancelled. The desktop job refuses to write `latest.json` unless mac, windows and linux all resolved.

**Caching.** Versioned objects are `public, max-age=31536000, immutable`; the manifests and `assets/*` are `public, max-age=300`. App origins get CORS on every response so a webview `fetch()` can read the manifest, and every response appends `Vary: Origin`.

## Native shell — iOS and Android (`native/`)

`vite.config.native.ts` produces `native/dist`, a client-only SPA that mounts the same `Viewer.tsx` the web hydrates. Capacitor (`capacitor.config.ts`, `webDir: native/dist`, appId `in.thecontrarian.manorama`) wraps it for iOS and Android; iOS is the shipping target, Android is generated-and-buildable. The SPA boots from bundled assets and the local vault before any network call — this is what makes it a real app rather than a wrapped site, and it is the Guideline 4.2 defence.

The opening surface (`native/islands/GalleryList.tsx`) shows the same icon-orb sign-in as the web landing (shared `.signin-*` styles in `app/styles.css`), then the owner's gallery catalogue. Gallery rows open the viewer directly against `/api/*`.

### Encrypted vault

`native/lib/vault.ts` keeps per-gallery AES-256-GCM keys in the system keychain (`@aparajita/capacitor-secure-storage`, `whenUnlockedThisDeviceOnly`, no cloud sync) and encrypted thumbnail records in `LibraryNoCloud` under `manorama-vault-v1`. Each record carries a magic+version header, per-entry nonce, and AAD bound to gallery and entry IDs. The default cap is 256 MiB of index-recorded bytes for free accounts; `vault-settings.ts` widens it on Visionary and holds the vault-vs-stream load policy in ordinary app preferences — never in the vault, never on the server.

### Offline galleries and Global View

`native/lib/offline-gallery.ts` stores complete gallery manifests plus vault-encrypted media so a gallery survives with zero connectivity (`openGalleryNetworkFirst` falls back to the store). Videos are skipped rather than half-cached. **Global View** (`GlobalView.tsx`, `global-view.ts`) is an opt-in grid indexing every frame the vault holds across galleries; the flag lives in plain preferences and reads off when absent.

### On-device curation

`native/lib/local-compute.ts` runs curation entirely on the phone: a 64-bit DCT perceptual hash computed on a 32×32 luma grid for near-duplicate grouping (default Hamming distance 6), sequence-improvement scoring, bounded at two concurrent workers. No image bytes or features leave the device — this is the "your photos never leave your phone" story that powers smart ordering without a server round-trip. `thumbs.ts` generates bounded-concurrency thumbnails and records ICC/C2PA presence per item.

### Billing

`native/lib/billing.ts` wraps RevenueCat (`@revenuecat/purchases-capacitor`): entitlement `will_pay`, product `in.thecontrarian.manorama.visionary.annual`, `appUserId` = the account ID. The Paywall island presents the store sheet; entitlement changes update the vault cap and gallery limits locally, while `POST /api/revenuecat-webhook` (authenticated by `REVENUECAT_WEBHOOK_*`) is the server-side tier writer through `setUserTier`.

### Ad plates

`packages/core/adframe.ts` defines `AdFrame` — a viewer item that is *not* a `GalleryMediaItem`, so it is never written into `imagesJson`, never counted in the position readout, and is dropped by any gallery mutation. Plates are house campaigns on a seeded ~25-image cadence that re-rolls per gallery per UTC day, never first or last or adjacent to each other, suppressed in short galleries, dressed like "The End.", and tappable only while centred and at rest. `native/lib/ads.ts` is the deliberately narrow seam: the `/api/ads/visibility` Worker route is the master per-day/per-region switch, and the AdMob provider is declared but must not be wired until a provider can render inside the honest 300×250 plate without covering photographs — the Capacitor banner overlay cannot.

### Shell-specific behaviour

`native/lib/fold.ts` + `packages/core/fold.ts` detect dual-segment devices and drive the Diptych island (two-photo pairs in the fold layout). `native/lib/hdr.ts` reports the shell's HDR claims but trusts nothing it cannot verify — `dynamic-range: high` is treated as untrusted per WebKit #254489. `native/lib/fps-probe.ts` measures delivered frame rate; the only sanctioned 120 Hz lever is `CADisableMinimumFrameDurationOnPhone` in `Info.plist` — no private WebKit `_features`.

## Desktop shell — SwiftUI (`desktop/` + `desktop-shell/` + `macos/`)

`vite.config.desktop.ts` produces `desktop/dist`; `vite.config.desktop-shell.ts` wraps it with the bridge, and `scripts/build-macos.sh` compiles `macos/ManoramaMac/*.swift` and stages the bundle into **`manorama.app`** — signed with the Developer ID identity and App Sandbox entitlements (`macos/ManoramaMac/ManoramaMac.entitlements`: sandbox, network client+server, user-selected files, app-scope bookmarks). The desktop app's job is different from the shells': it is a local-first viewer for folders and cards that never copies, moves, or renames a byte.

- **Bridge** (`desktop-shell/bridge.ts` + `macos/ManoramaMac/NativeBridge.swift`): the page still speaks the Tauri protocol — `__TAURI_INTERNALS__.invoke` routes to a `WKScriptMessage` handler implementing every command the bundle calls (vault, private files, `plugin:fs|*`, `plugin:http|*`, `plugin:event|*`, `plugin:opener`, `plugin:window`, OAuth loopback, device label, folder picking). Sandboxed, `plugin:fs` is additionally gated: a path must resolve under a FolderStore security-scope bookmark, which only ever comes from the native folder picker. The bridge is bound to the bundle origin — a document from another origin cannot reach it.
- **Catalogue** (`desktop/lib/catalogue.ts`, `Catalogue.tsx`): every opened root lives in `catalogue.json` in the app config dir, written at mode 0600. Paths exist nowhere else — the sync payload type does not contain a path field, so they cannot leak by accident. Catalogue writes are serialised, so a stale snapshot can never overwrite a newer one, and side effects are gated on the write succeeding.
- **Scoped access** (`FolderStore.swift`): the grant is a security-scoped bookmark minted by the `NSOpenPanel` pick — never a renderer-supplied path — persisted in `folders.json` so re-grants survive launch. Local galleries serve originals through the `in.thecontrarian.manorama.desktop://` scheme handler only after the bookmark resolves and `startAccessingSecurityScopedResource` succeeds. Note: bookmarks are signature-bound — grants made in the pre-sandbox Tauri build do not carry over; the user re-picks each folder once.
- **Gallery keys** (`desktop/lib/key-store.ts`): gallery keys live in the Keychain (`manorama.gallery-key.v1.<id>` accounts, service `in.thecontrarian.manorama.vault`) — the data-protection store under the shared access group `373K7W3LKU.manorama.shared` on profiled builds (App Store, or a Developer ID build that embeds both a profile carrying the group and an entitlements file declaring it — the profile alone is not enough), so every team-signed build reads them without a per-item prompt; profile-less direct builds use the file-based login Keychain, where the bridge migrates each foreign-signature item lazily on first access — the custody that localStorage could never express.
- **Legacy Tauri shell** (`src-tauri/`): kept buildable for reference, and still the builder for the **Windows and Linux** legs. It no longer ships the Mac — `scripts/build-macos.sh` owns that — but its configuration still carries the same bundle identifier (`in.thecontrarian.manorama.desktop`) and the same private-file locations, so installs stay interchangeable. New work lands in the SwiftUI shell only.
- **Window**: the launch is windowed — the earlier kiosk behaviour (every launch opening into its own fullscreen Space) is now the "Open in full screen" setting in the native `Settings` scene (`openInFullScreen` in UserDefaults), applied once per launch by `AppModel.applyLaunchWindowMode`. The `--windowed` flag is a test override that always wins; a fullscreen record restored from the kiosk era is undone during the launch settle, with the correction retiring once the window is on screen (a person cannot act before that point, so every later entry is intent). Reopening the Library or a deep link never re-applies the preference. Entering and leaving fullscreen stays on the AppKit paths — the green light, `⌃⌘F`, and View ▸ Enter/Exit Full Screen. Chrome is `.windowStyle(.hiddenTitleBar)` on the `WindowGroup` — the `titlebarAppearsTransparent`/`fullSizeContentView` flags still land on macOS 27 but no longer suppress the system's own bar — and the style ships the window as `fullScreenNone`, so `configureWindow` opts the collection behaviour back into fullscreen. The window's frame restores through the scene's own restoration — `configureWindow` deliberately sets no autosave name, because a saved frame applied through the representable's update path would loop resize → update → resize. Closing the Library's window leaves the app running, and a reopen brings the Library back.
- **Shell state**: `AppModel` is `@MainActor @Observable` — the shell's own observation migration, scoped to the chrome the shell owns (status, position, gallery state, errors, the window handle). `FolderStore` stays an imperative `ObservableObject`: it is consumed through calls, not rendered from, and is out of the migration's scope. The accessibility status readout is a 1-point strip at 1% opacity — invisible, but present in the AX tree, which `.opacity(0)` would remove.
- **Sign-in**: system-browser OAuth + deep-link handoff to `in.thecontrarian.manorama.desktop://auth/callback`, exchanged at `/api/auth/desktop/exchange` (see Accounts and sign-in). The handoff is delivered to the copy holding the verifier, and the sign-in surface launches dark.
- **Share flow** (`ShareFlow.tsx`, `desktop/lib/share.ts`): the *only* path by which local bytes leave the device. Explicit per-gallery user action opens a confirm gate before the first byte crosses — raw file bytes plus sanitized basenames go to the chosen provider, and the public Manorama URL comes back.
- **Sync** (`desktop/lib/sync.ts`): gallery-level metadata only — title, source kind, item count, device ID/label — to `device_galleries`. The server re-parses against `parseDeviceGalleryInput` and rejects unknown keys outright, and failures are quiet: sync must never block local viewing. The desktop marks a synced row as a **ghost** when its `deviceId` matches this machine's own — matched by id, deliberately not by label.

## Server API surface

`app/api.ts` mounts the session-gated API on the Worker:

- `/api/galleries*` — scan, create, read, refresh, delete (session required; `requireEditableGallery` enforces pipeline locks)
- `/api/galleries/:slug/probe` — the cheap source-change probe (see Source freshness)
- `/api/library` — the lean Library list the web dashboard renders from
- `/api/account*` — profile, linked identities (unlink refuses the last method), slug update, self-service delete
- `/api/account/key-vault`, `/api/galleries/:slug/key` — key escrow (see Security posture)
- `/api/auth/native/exchange`, `/api/auth/desktop/exchange` — one-time shell handoffs
- `/api/device-galleries*` — metadata-only shell sync (strict wire parse)
- `/api/devices*` — the account's device list: `GET` accepts a cookie or bearer session, `PUT`/`DELETE` are bearer-only, so a web sign-in records no device
- `/api/ads/visibility` — public plate switch; `/api/ads/suppressions` — master-gated
- `/api/admin/*` — master console (overview, master flags, account deletion), gated by `requireMasterSession` against `master_accounts`/`MASTER_DROPBOX_SUBJECT`
- `/api/revenuecat-webhook`, `/api/stripe-webhook` — tier writes through `setUserTier`
- `/api/{dropbox,drive,mega,icloud}/*`, `/api/gphotos/image`, `/api/og/:owner/:slug`, dev-only `/api/local/file`

## Security posture

An adversarial review ran against the codebase on 11–12 November 2026 (`security-audit/`, with a second pass in `security-audit/review-2/`). Twelve findings were raised; the record lives in the repository, and the remediations that shipped are:

- **The webview bridge is scoped to the bundle origin** — a document from another origin cannot reach the Tauri invoke surface (F-01).
- **External links work through one policy seam** — a gestured `_blank` click is routed rather than spawned, `mailto:` goes through the opener, and a remote subframe cannot navigate the shell (F-02, R-04).
- **OAuth state is bound to the browser that opened it**, and the verifier cookie is swept on every non-pause completion (F-03, R-02).
- **A released owner slug stays reserved** for the account that held it, and the rename race is closed (F-04).
- **Key escrow writes are compare-and-swap** and each key is bound to its gallery, so a stale client cannot clobber a newer key (F-05). The API change is not backward compatible by design — a pre-merge build can no longer escrow (R-01).
- **The Android vault is excluded from cloud backup** (F-08).
- **Prefix-safe log sampling and purged policy text** (F-09, F-12).

Two findings were left open by design (F-06, F-07 — both in the longer-term tier of the remediation plan). The PoCs and the boundary probe are runnable: `bun run test:unit -- security-audit` and `security-audit/poc/macos-bridge-origin/run.sh`.

## Run locally

```sh
bun install
bun run dev
```

Open `http://localhost:5173/` for the landing page. Dev seeding is driven by sample-source variables in `.env.local` — each one is live-scanned at boot into a gallery under the seeded `thecontrarian` owner:

| Variable | Seeded slug |
| --- | --- |
| `MANORAMA_DEV_SOURCE_ICLOUD` | `mixed-album` |
| `MANORAMA_DEV_SOURCE_MEGA` | `dev-mega` |
| `MANORAMA_DEV_SOURCE_DROPBOX` | `dev-dropbox` |
| `MANORAMA_DEV_SOURCE_GDRIVE` | `dev-gdrive` |

(`MANORAMA_DEV_VIDEO_URL` is the older name for the iCloud slot and still works.) The plugin also serves `POST /.dev-seed/reset` so tests can restore canonical state, and mints a pro-tier `dbid:AAATESTowner1`. A checkout with no source vars seeds the owner and nothing else — everything the suite runs against is a real album fetched from a real provider.

### Local folders

In dev only, quick-add accepts a folder straight off disk: append an absolute path to the dev origin — `localhost:5173//Users/you/photos/album` — and the catch-all claims it when the path resolves to a real directory. Signed out, the interstitial's **Sign in (dev)** button mints a session for the seeded owner via `/.dev-seed/login` (no OAuth round-trip); signed in, the gallery is created immediately. The dashboard paste box accepts `file:///…` and bare absolute paths too.

Local items stream through `/api/local/file?path=…`, which is confined to directories scanned during the dev session and an image/video extension allowlist; `&w=` serves sharp-resized WebP thumbnails. The whole feature is gated behind a flag the `apply: 'serve'` plugin sets on `globalThis` — production builds can never claim a local path, and the route 404s. Media stays in place: nothing is copied or uploaded.

### Native and desktop locally

```sh
bun run build:native && bunx cap sync     # native SPA → Capacitor shells
bun run native:open:ios                   # open ios/ in Xcode
bun run dev:desktop                       # desktop SPA on :5175
bash scripts/build-macos.sh               # SwiftUI shell (sandboxed, signed)
MANORAMA_FOCUS_SESSION=/path/to/session.json \
bash scripts/test-macos-focus.sh          # boundary/focus suite against the built app
                                          # (explicit test account; never the installed session)
```

The iOS project uses SPM — there is no `App.xcworkspace`; build `ios/App/App.xcodeproj` scheme `App` directly. `IPHONEOS_DEPLOYMENT_TARGET` is **17.0**, and `ios/App/CapApp-SPM/Package.swift` declares `.iOS(.v17)` to match — regenerated by `bun run native:sync`, which derives the platform from the project. The signing team `373K7W3LKU` is already in `project.pbxproj` (`CODE_SIGN_STYLE = Automatic`); never pass `DEVELOPMENT_TEAM` on the command line — the `TRF3R33X88` suffix visible in the development certificate's CN is the member user ID, not the team.

## Deploy and release

Pushes to `main` trigger `.github/workflows/deploy.yml`: build → `wrangler d1 migrations apply manorama --remote` → `wrangler deploy`. The schema always lands before the code that needs it — no manual migration step on push. The job runs under the `production` GitHub environment with `contents: read` permission and SHA-pinned actions. The environment is *not* an approval gate: the repository has no required reviewers, so a push to `main` still deploys unattended.

Other workflows:

| Workflow | Trigger | Does |
| --- | --- | --- |
| `verify.yml` | push / PR to `main` | Typecheck, unit tests, client + worker + native + desktop builds. The CI gate |
| `ios.yml` | tag `v*` | Archives the Capacitor app and hands it to App Store Connect (`APPSTORE_API_*` secrets) |
| `desktop-release.yml` | tag `v*` | Builds the macOS DMG from the SwiftUI shell and the Windows and Linux artifacts from Tauri, notarizes the Mac, and publishes to the downloads bucket |
| `android-release.yml` | tag `v*` | Builds a signed APK and AAB, verifies the signature, and publishes to the downloads bucket |
| `desktop-windows.yml` | manual | Windows-only build for inspection |

### Android release

`android-release.yml` reads `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`, writes the keystore to `$RUNNER_TEMP` and exports it as `MANORAMA_UPLOAD_KEYSTORE`. A credential-check step (`scripts/require-env.sh`) prints presence and length only — never a value — and **fails the job** when any required secret is missing, so a tag can no longer go green with no APK; the desktop legs are unaffected because they run in their own workflow.

The build needs JDK 21 — Capacitor's Android project targets Java 21 (`sourceCompatibility`/`targetCompatibility` in `android/app/capacitor.build.gradle`) — and AGP 8.13.0 with `compileSdk`/`targetSdk` 36. `android/gradle.properties` raises the Gradle heap to `-Xmx4096m`; the 1536m default dies with `Java heap space` during `:app:packageRelease`. The signing config (`android/app/build.gradle`) resolves each key from a `-P` property *or* an environment variable, and an unsigned release build is a warning, never a failure.

The version code is `major·10000 + minor·100 + patch`; a tag whose minor or patch reaches 100 is rejected. The artifacts are `dist/manorama_<version>_android.apk` and `.aab`. Verification prints the full `apksigner verify --print-certs` output — it must not be piped through `head` under `pipefail`, which turns a SIGPIPE into a false failure — and asserts `aapt dump badging` reports the expected `versionName`. The release job creates a draft GitHub release if none exists, re-reads `isDraft` after resolution, and refuses to upload into an already-published release.

### Publishing to the downloads bucket

Both release workflows publish with `wrangler r2 object put "manorama-downloads/v${version}/${file}" --remote`, then regenerate `history.json` and update `latest.json` under the guards described in Downloads host. The desktop job refuses to move the pointer unless all three desktop platforms resolved; the Android job writes only `mobile.android`.

### macOS release

`scripts/build-macos.sh [debug|release]` builds the viewer bundle, resolves the toolchain through `xcrun` under the selected `DEVELOPER_DIR` (Xcode 27.1 in CI, which provides the macOS 27 SDK), and compiles the Swift sources with `swiftc -O -sdk <resolved macosx SDK> -target arm64-apple-macosx15.0`. The build refuses an SDK older than macOS 26, and exports `SDKROOT` before invoking the toolchain's `swiftc` directly — without it the linker stamps the deployment target into `LC_BUILD_VERSION`'s `sdk` field instead of the real SDK version, and the system would read the app as legacy-SDK-linked. `vtool` asserts the Mach-O records both `minos 15.0` and `sdk ≥ 26`. It then assembles `manorama.app` (version 0.4.0, bundle id `in.thecontrarian.manorama.desktop`, `LSMinimumSystemVersion` 15.0) and signs it with the Developer ID identity and the App Sandbox entitlements. `MACOS_SIGN_IDENTITY` overrides the identity; `MANORAMA_MACOS_BUILD_DIR` and `MANORAMA_MACOS_BUNDLE_ID` override the output.

CI builds a drag-install DMG (`build/dmg/manorama_${VERSION}_aarch64.dmg`, UDZO, `/Applications` symlink). Notarization is **required**: a credential check fails the Mac leg before the build when any `APPLE_*` secret is absent, then `notarytool submit --wait`, `stapler staple` and `stapler validate` run unconditionally — an unstapled or Invalid ticket fails the job.

### Other Worker configuration

`wrangler.toml` configures the `manorama` Worker, the `DB` D1 binding, Static Assets, `PUBLIC_HOST=manorama.xyz`, and the `manorama.xyz` custom domain (the zone is delegated and live; `env.production` disables `workers.dev`). Local deploy is `bun run deploy`; run the migration command above by hand first if the local branch adds columns. The admin, galleries, and quick-add interstitials send `X-Robots-Tag: noindex, nofollow, noarchive`; the homepage is the exception. `app/routes/app-ads.txt.ts` serves the ad-network declaration.

## Licensing

`LICENSE` is the **Business Source License 1.1**. The Licensed Work is manorama, licensed by Mahesh Shantaram / thecontrarian.in. The Additional Use Grant permits any use including production, **except** using the work alone or in a derivative to provide a photography-gallery publishing service to third parties — hosted or embedded, paid or ad-supported, or redistributed for that purpose. Each version converts to **AGPL-3.0-or-later** four years after its first public release.

`NOTICE` restates that scope and carves out the trademark: the name, logo, icon and brand assets are not licensed, no derivative may present itself under the brand without prior written permission, and nominative use ("manorama-compatible") is permitted. Third-party components keep their own licences.

## Project layout

| Path | Responsibility |
| --- | --- |
| `packages/core/` | Platform-free heart: `ImageSource`, `GalleryMediaItem`, `BundledSource`, image-dims, image-staging, gallery-settings, `AdFrame`, fold geometry, account-tier policy, library layout, app-version contract, device-gallery wire types. Runs in Worker, web bundle, and both shells |
| `app/routes/` | HonoX routes — homepage (`index.tsx`), dashboard, gallery, quick-add catch-all, `auth/{apple,google,dropbox}` + logout, privacy, `opman` master console, `app-ads.txt` |
| `app/api.ts` | Session-gated API surface (see Server API surface) |
| `app/islands/` | `Viewer.tsx` (the stage), `Admin.tsx` (the Library), `HomeDemo.tsx` (the homepage demo), `VideoSlide.tsx`, `EncryptedGallery.tsx` |
| `app/components/` | Shared UI: `library/` (masonry, section chevron, compact cover, device tiles), `home/` (page, sections, demo engine, menus), `viewer/` (chrome, settings sheet, owner panel, picker editor, info sheet), `ui/` (primitives: sheet, button, action row, segmented, switch, meter) |
| `app/lib/` | Worker-side: provider scanners, `oidc.ts`/`oauth-flow.ts`/`{apple,google,dropbox}-auth.ts`, `identity-repository`, `user-repository`/`gallery-repository`, retention, OG cards, `source-freshness.ts`/`source-probe.ts`, `masonry.ts`, `downloads.ts`, `device-gallery-repository`, `revenuecat-webhook`, `stripe-webhook`, `security-headers.ts`. Thin re-export shims for `packages/core` |
| `native/` | Client-only SPA: `main.tsx` boot; `islands/` (`GalleryList`, `GlobalView`, `Paywall`, `VaultSettings`, `Diptych`); `lib/` (vault, offline-gallery, global-view, billing, ads, session, api, thumbs, local-compute, fold, hdr, fps-probe) |
| `desktop/` | Desktop SPA: `Catalogue`/`ShareFlow` islands; `lib/` (catalogue, local-scan, share, sync, session, welcome, shell adapter) |
| `desktop-shell/` | Bridge glue: installs the Tauri-compatible invoke surface over the native `WKScriptMessage` channel |
| `macos/` | SwiftUI shell: `ManoramaMac/` (`ManoramaMacApp`, `NativeBridge`, `LocalSchemeHandler`, `FolderStore`, `OAuthLoopback`, `Trace`), `BoundaryTests/` harness |
| `src-tauri/` | Legacy Tauri shell — still the Windows and Linux builder, deprecated, slated for removal |
| `ios/`, `android/` | Capacitor shells (`ios/App/App.xcodeproj` — SPM, no workspace) |
| `migrations/` | D1 migrations 0001–0020 |
| `scripts/` | `build-macos.sh`, `build-download-history.mjs`, `home-demo-images.mjs`, `home-images.mjs`, `test-mirror.sh`, capture and migration helpers |
| `security-audit/` | The adversarial review, its PoCs, and the second-pass findings |
| `submission/` | App Store submission evidence, review notes, Connect fields |
| `demo-captures/` | Six-state screenshot matrix for iPhone/iPad/macOS |
| `specs/*.playwright.ts` | Playwright acceptance specs — `qa`, `homepage`, `home-demo`, `library-lean`, `library-hidden`, `theme-persistence`, `admin-fold`, `web-owner-integration`, `doodle-background`, `fold`, `video-playback`, `video-size-cap`, `encrypted-gallery`, `desktop-catalogue`, `desktop-auth-local` — plus the shared helpers `playwright-helpers.ts` and `desktop-admin-fixture.ts`; domain specs stay beside their surface (`native/*.playwright.ts`) |
| `vite.config.ts` / `.native.ts` / `.desktop.ts` / `.desktop-shell.ts` / `.native-fixture.ts` | The build targets plus the native test fixture |
| `wrangler.toml` | Worker, `DB` binding, `DOWNLOADS` R2 binding, environment variables, custom domains, 03:17 UTC retention cron |

## Verification

Unit tests and typecheck:

```sh
bunx tsc --noEmit
bun run test:unit
```

(`bun test` does not run at the repository root — the `.worktrees/` checkouts put ~a million files under the scan root and the runner dies `EMFILE` before preload. `test:unit` mirrors into a scratch root first. Running the suite from a subdirectory is not equivalent: the preloaded DOM renderer is order-sensitive. `app/lib/gallery-retention.test.ts` and `app/account-deletion-api.test.ts` start local miniflare servers, so they need a writable `~/.wrangler` and a loopback port.)

Run the local acceptance suite against the seeded dev server (`bun run dev`). The specs default to `GALLERY_SLUG=dev-dropbox` and need `GALLERY_VIDEO_SLUG` pointing at a video-containing gallery — so the corresponding `MANORAMA_DEV_SOURCE_*` vars must be set:

```sh
GALLERY_URL=http://localhost:5173 GALLERY_VIDEO_SLUG=mixed-album bunx playwright test
```

The matrix is 375×812 touch, 1440×900 desktop, and 2560×1440 wide. It covers curtain behavior, strip physics, gesture and keyboard navigation, modal and focus behavior, alternate modes, CLS, accessibility, C2PA, owner-scoped routing, admin editing and reordering, quick-add interstitials and zero-click creation, the `M` magnifier, ambient video slides, per-gallery OG cards, noindex privacy, the fold layout, the homepage and its live demo, the Library's lean list and hidden section, cross-host theme persistence, and the native ad-plate/global-view specs.

After any native or desktop presentation change, capture the six-state evidence matrix under `demo-captures/{ios,ipad,macos}/` — opening screen, gallery curtain, first image with controls, display-settings popover, signed-in account/admin surface, and Global View — from freshly built bundles.

## Known limitations

iCloud shared albums, Google Photos shared albums and Dropbox folders are the video sources; Drive, MEGA, Ente and Proton scans remain image-only, and there is no transcode pipeline for master files. MEGA, iCloud and Google Photos ingestion rely on undocumented provider endpoints that may change without notice — the Google Photos scanner is the most exposed, since it reads Google's internal `batchexecute` RPC and its item-shape nesting. Metadata and references are all Manorama stores; original media bytes are proxied, never persisted.

The Android shell is generated and buildable but unpolished — kept as a break-glass store option, not a shipped product. The legacy Tauri shell still builds the Windows and Linux legs and is scheduled for removal. The homepage's hero assets are all `interim` (`docs/homepage-assets.md`) — the owner's clearance for the still captures is outstanding, though the demo's photographs are cleared and published.
