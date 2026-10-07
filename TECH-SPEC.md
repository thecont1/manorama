# manorama — technical specification

The user-facing overview lives in [README.md](README.md). This document is the engineering reference: architecture, the media model, the viewer contract, provider ingestion, the native and desktop shells, and how to run and ship the thing.

## Stack

One repository produces three surfaces:

- **Web** — a Cloudflare Worker running Hono/HonoX (TypeScript, TSX islands hydrated client-side). D1 (`DB` binding) is the production store; vite dev and tests use in-memory repositories instead. Media bytes are never persisted: they stream through same-origin proxy routes at view time.
- **Native** — `native/` builds to a static SPA (`vite.config.native.ts` → `native/dist`), bundled into Capacitor shells for iOS (`ios/`) and Android (`android/`). It boots from bundled assets and its on-device vault — never from the network — and talks to the Worker's `/api/*` over HTTPS for sign-in, gallery manifests, and media.
- **Desktop** — `desktop/` builds to a static SPA (`vite.config.desktop.ts` → `desktop/dist`) inside a Tauri shell (`src-tauri/`). It is a local-first gallery viewer for folders and cards on disk, with an explicit share flow as the only path by which bytes leave the device.

`packages/core` is the shared platform-free heart: `ImageSource`, `GalleryMediaItem`, sizing math, gallery settings, fold geometry, the `AdFrame` contract, device-gallery wire types. It must run unchanged in all three hosts — no Worker bindings, no `window`, no Node built-ins, no Capacitor imports. `app/lib/*.ts` carries thin re-export shims for modules moved there.

Bun is the toolchain (`bun install`, `bun run dev`, `bun run test:unit`); Playwright is the acceptance harness.

## Gallery lifecycle

Owners sign in with Apple, Google, or Dropbox and get a namespace — `manorama.xyz/{owner}/{gallery}` — fed by public Dropbox folder, Google Drive folder, iCloud shared album, and MEGA folder or collection URLs without asking gallery providers to connect their accounts. iCloud shared albums can contribute video alongside photos.

Pasting a supported link runs a server-side scan using platform credentials (Dropbox app credentials, a Drive API key, or none for iCloud and MEGA), ignores undisplayable files, loads a low-resolution preview strip, and lets the owner arrange the gallery before adding it.

Added galleries are stored as metadata and ordered media manifests in D1. Original media bytes remain with the provider and are streamed through same-origin Manorama routes when the public gallery is viewed. Removing a gallery removes Manorama's reference only; it does not delete anything at the source.

Free accounts retain up to 3 editable galleries. Creates beyond that land as temporary `pipeline` galleries — public and listed, but read-only: their cards show a deadline panel with an upgrade link, and title/caption/slug edits, image reordering, and refresh announce the lock instead of acting. Upgrading to pro (up to 99 retained galleries) promotes every still-live pipeline gallery back to editable. Pipeline galleries can still be opened, shared, copied, and deleted. See Gallery retention below.

The dashboard lists link-sourced galleries newest first. Clicking a title or caption opens an inline editor; the slug is editable too, and the public URL follows it. Beneath each title is a full-viewport-width, 100px media rail containing the gallery thumbnails — videos carry a `▶ mm:ss` badge. Items can be dragged into a new position, moved with the keyboard when focused, and panned within the rail using horizontal trackpad/wheel input or touch-style pointer movement. Each gallery row exposes its public URL, a copy action, and a delete action. Gallery links open in a new tab.

## Quick-add: `manorama.xyz/<share-url>`

Appending a supported share URL to the origin creates the gallery and opens it — `manorama.xyz/https://www.dropbox.com/scl/fo/…` or `manorama.xyz/mega.nz/collection/…#key` both work. Signed-in owners get zero-click creation; signed-out visitors see a branded interstitial whose provider orb round-trips the full URL through OAuth so the gallery completes on return. MEGA and iCloud keys live in the URL fragment, which browsers never send — the catch-all route (`app/routes/[...src].tsx`) recognizes provider-shaped paths, renders the interstitial, and the client (`app/quickadd.ts`) reassembles the complete URL from `pathname` + `search` + `hash`. Non-provider paths fall through to the real routes untouched, and revisiting a link opens the existing gallery (`409` + `galleryUrl`). Quick-add galleries are named by the platform rather than the provider's folder name — three hyphenated words drawn from a fixed evocative list (`ember-tide-fern`), so the public URL reads like a title; dashboard creates keep the scanned folder name.

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

New-account naming: a provider display name slugifies into the owner slug (`mahesh-v`, `mahesh-v-2`, …). When the provider withholds a name — Apple sends it only inside the `user` JSON on the *first* consent — the account keeps the `Photographer` display-name fallback but mints a three-word slug via the quick-add word list rather than `photographer-N`. `updateOwnerSlug` changes the URL at any time; galleries reference the account ID and follow automatically.

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
| `VENDO_API_KEY`, `VENDO_MCP_*` | Vendo surface — disabled platform-wide |

## Storage

D1 is the production store (`DB` binding, `migrations/`); vite dev and tests use in-memory repositories instead. The `users` table holds accounts; the `galleries` table stores per-owner manifests:

| Field | Purpose |
| --- | --- |
| `slug` | Stable gallery URL segment (per-owner unique) |
| `title`, `caption`, `date` | Curtain, admin, and OG copy |
| `sourceUrl` | The public provider link |
| `createdAt` | Recency ordering |
| `imagesJson` | Ordered media manifest — `image` and `video` items in one union |
| `retention` | `retained` (editable) or `pipeline` (temporary, read-only) |
| `expires_at` | Pipeline removal deadline; `NULL` on retained rows |

Remaining tables: `auth_identities` (linked sign-in methods), `auth_flows` (in-flight OAuth state), `device_galleries` (metadata-only sync rows for shell galleries), `ad_suppressions` (per-day/per-region plate switch), `master_accounts` (operations console access).

### Gallery retention

Free accounts keep at most 3 `retained` galleries; further creates insert as `pipeline` rows with `expires_at` exactly 30 days after `created_at`. Paid accounts cap at 99 retained galleries — a create beyond that is a typed `GALLERY_LIMIT` 403. The public cutoff is enforced at read time: once `expires_at` passes, lists and gallery/OG reads hide the row immediately, while stored-record reads keep it reachable for owner deletes and the expiry walk. A daily cron (`17 3 * * *`, 03:17 UTC) physically removes expired rows with a guarded delete — a gallery recreated under the same slug after the scan survives, and manual deletes/upgrades mid-scan are safe skips. Deletion removes only the Manorama row; nothing at the provider is ever touched.

All galleries present before `migrations/0002_gallery_retention.sql` normalize to `retained` with `NULL` expiry — nothing existing goes temporary.

Upgrades run through `setUserTier`, the trusted seam: it writes the tier and promotes every unexpired pipeline gallery (`expires_at > now`, strictly — a deadline equal to now stays expired) in one idempotent batch, so a repeated pro write is safe. Never update the D1 `tier` column alone — that would leave pipeline galleries locked on a pro account. Payment verification is the caller's responsibility. Two server-side callers exist: `POST /api/revenuecat-webhook` (native IAP events, ordered by billing-event fields) and `POST /api/stripe-webhook` (web checkout). Promotion can lift an owner past 99 retained galleries; the cap applies only to subsequent creates.

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

### MEGA

MEGA shared folder links (`mega.nz/folder/{id}#{key}`) and collection links (`mega.nz/collection/{id}#{key}`, MEGA's "Sets") need no credentials — the share key in the link fragment is the decryption key. Manorama enumerates the source through MEGA's public API (`a:'f'` for folders, `a:'aft'` for collections), decrypts node keys and attributes client-side, and decrypts image content at proxy time (`/api/mega/file`) using AES-128-CTR with each file's node key. Formats browsers cannot render (HEIC, HEIF) are served through MEGA's generated JPEG/WebP previews (`/api/mega/preview`); images with no preview are excluded.

Caveats: the API is undocumented; decryption happens per view so large sources mean per-request CPU cost; MEGA's free-tier bandwidth quota (HTTP 509) surfaces as a temporary failure; and the decrypted node key rides in the image proxy URL — equivalent in exposure to the public link itself. MEGA images are decrypted originals, so `c2pa` is preserved.

## Media model

The viewer consumes the `ImageSource` interface in `packages/core/imagesource.ts` (re-exported from `app/lib/imagesource.ts`); `BundledSource` adapts a stored gallery record into the runtime sequence. A gallery is a `GalleryMediaItem[]` union — `image` items and `video` items interleaved, with an absent `type` implying image so all-photo manifests are unchanged. Video items carry a proxy `src`, a poster derivative, dimensions, and an optional duration. Link-sourced records are delivered through the Worker's transient per-provider proxy routes (`/api/dropbox/*`, `/api/drive/*`, `/api/icloud/*`, `/api/mega/*`), so the viewer does not need to know where the media originated.

Each item has a stable ID, an optional provider `ref` (Drive file ID, iCloud photo GUID) used for ordering and refresh dedupe, filename, dimensions, alt text, optional caption and EXIF data, C2PA state, placeholder, and responsive variants. The ordered sequence is persisted in `imagesJson`; dragging or keyboard-moving an item changes only the gallery order, not the source files. A fresh scan canonicalizes to ascending filename (numeric-aware, so `IMG_2` precedes `IMG_10`) — provider listing order is never trusted. iCloud is the exception: shared albums carry no filenames, so the album's own order is canonical there. Refreshing a gallery keeps the owner's order for retained items, drops media deleted at the source, and appends newly discovered items at the end in ascending filename order.

The asset pipeline treats Content Credentials and ICC profiles as part of the image bytes. Originals are never recompressed, cropped, stretched, upscaled, or converted into a sole alternate format. C2PA verification remains client-side and lazy-loaded.

## Viewer contract

The stage shows only a half-hidden brand pill bobbing at the bottom edge — everything else is quiet chrome. The pill opens display settings, which holds view modes, arrows, fullscreen, shortcuts, and the in-gallery information sheet (position, caption, EXIF, Content Credentials). `I` opens the in-gallery information sheet; `⇧I` deep-links the current photograph into the standalone C2PA viewer (`c2pa.thecontrarian.in/?uri=…`) in a new tab, falling back to the in-gallery sheet for sources it cannot fetch (videos, non-http origins). Navigation arrows ship on for fine pointers and hide by default on touch — enabled there, they dock at the viewport's bottom corners. Vertical scroll keeps them off by default at any pointer; enabling the toggle stacks ↑/↓ at the bottom-right corner, stepping the feed one photograph at a time. A sequence bubble riding just left of the button cluster (or docked in its corner slot when arrows are off) counts the active photograph; it doubles as a button — hovering on a fine pointer expands the pill into the full tally ("5 of 56 items") with an "open global" hint, and clicking raises the selector filmstrip (same as `G`). The viewer supports strip, vertical-scroll, and one-at-a-time modes, pointer and touch dragging, wheel input, keyboard navigation, and reduced-motion preferences — images fit the stage without cropping and are never upscaled past their natural size. One-at-a-time steps sweep the incoming photograph directionally over the current one behind an opaque card, so the background treatment never ghosts through mid-transition. Sizing is density-aware rather than purely CSS-driven: the horizontal strip fits height-first so neighbouring photographs abut edge-to-edge like a photostrip, vertical scroll fits width-first (portraits included — a tall frame simply runs long), and one-at-a-time contains both axes — all with the effective device pixel ratio capped at 2, so a displayed pixel never claims more source pixels than it shows.

Video slides are ambient: the active slide mounts the only `<video>` element — muted, looping, `playsInline` — while neighbors render posters only. A pause/play control, an unmute megaphone (sound is a viewer-level toggle), and a `VIDEO · mm:ss` chip overlay the slide; leaving the slide pauses and rewinds, and `prefers-reduced-motion` swaps autoplay for a poster plus an explicit Play control.

On fine-pointer desktops, `M` summons a glass-ball magnifier that follows the cursor over the stage at 3× (a decorative DOM mirror — `aria-hidden`, dismissed by `Esc`, `M`, or opening a dialog). The `M` shortcut row in display settings appears only where the key works; the `I` row is always listed.

The viewer's `G` shortcut opens a centered selector overlay rather than a docked viewer. A full-viewport scrim dims and blurs the stage; the fixed-height filmstrip is vertically centered, uses `variants[0]` (falling back to `placeholder`) with lazy-loaded thumbnails, and centers the active item on open. The selector's shocking-pink `#fc0fc0` box tracks hover and arrow-key selection (with wrap-around, Home, and End); click, Enter, or Space commits the selected item and fades the overlay before calling the existing smooth `goTo(i)`. Pointer drags and dominant-axis wheel input pan its horizontal scroll position, with pointer capture delayed until movement exceeds 6px so ordinary clicks remain native. `Escape`, `G`, and scrim clicks dismiss it, while thumbnail focus and arrow keys provide keyboard selection without changing order.

## Native shell — iOS and Android (`native/`)

`vite.config.native.ts` produces `native/dist`, a client-only SPA that mounts the same `Viewer.tsx` the web hydrates. Capacitor (`capacitor.config.ts`, `webDir: native/dist`, appId `in.thecontrarian.manorama`) wraps it for iOS and Android; iOS is the shipping target, Android is generated-and-buildable only. The SPA boots from bundled assets and the local vault before any network call — this is what makes it a real app rather than a wrapped site, and it is the Guideline 4.2 defence.

The opening surface (`native/islands/GalleryList.tsx`) shows the same icon-orb sign-in as the web landing (shared `.signin-*` styles in `app/styles.css`), then the owner's gallery catalogue. Gallery rows open the viewer directly against `/api/*`.

### Encrypted vault

`native/lib/vault.ts` keeps per-gallery AES-256-GCM keys in the system keychain (`@aparajita/capacitor-secure-storage`, `whenUnlockedThisDeviceOnly`, no cloud sync) and encrypted thumbnail records in `LibraryNoCloud` under `manorama-vault-v1`. Each record carries a magic+version header, per-entry nonce, and AAD bound to gallery and entry IDs. The default cap is 256 MiB of index-recorded bytes for free accounts; `vault-settings.ts` widens it on pro and holds the vault-vs-stream load policy in ordinary app preferences — never in the vault, never on the server.

### Offline galleries and Global View

`native/lib/offline-gallery.ts` stores complete gallery manifests plus vault-encrypted media so a gallery survives with zero connectivity (`openGalleryNetworkFirst` falls back to the store). Videos are skipped rather than half-cached. **Global View** (`GlobalView.tsx`, `global-view.ts`) is an opt-in grid indexing every frame the vault holds across galleries; the flag lives in plain preferences and reads off when absent.

### On-device curation

`native/lib/local-compute.ts` runs curation entirely on the phone: 32×32 dHash near-duplicate detection (default Hamming distance 6), sequence-improvement scoring, bounded at two concurrent workers. No image bytes or features leave the device — this is the "your photos never leave your phone" story that powers smart ordering without a server round-trip. `thumbs.ts` generates bounded-concurrency thumbnails and records ICC/C2PA presence per item.

### Billing

`native/lib/billing.ts` wraps RevenueCat (`@revenuecat/purchases-capacitor`): entitlement `will_pay`, product `in.thecontrarian.manorama.visionary.annual`, `appUserId` = the account ID. The Paywall island presents the store sheet; entitlement changes update the vault cap and gallery limits locally, while `POST /api/revenuecat-webhook` (authenticated by `REVENUECAT_WEBHOOK_*`) is the server-side tier writer through `setUserTier`.

### Ad plates

`packages/core/adframe.ts` defines `AdFrame` — a viewer item that is *not* a `GalleryMediaItem`, so it is never written into `imagesJson`, never counted in the position readout, and is dropped by any gallery mutation. Plates are house campaigns on a seeded ~25-image cadence that re-rolls per gallery per UTC day, never first or last or adjacent to each other, suppressed in short galleries, dressed like "The End.", and tappable only while centred and at rest. `native/lib/ads.ts` is the deliberately narrow seam: the `/api/ads/visibility` Worker route is the master per-day/per-region switch, and the AdMob provider is declared but must not be wired until a provider can render inside the honest 300×250 plate without covering photographs — the Capacitor banner overlay cannot.

### Shell-specific behaviour

`native/lib/fold.ts` + `packages/core/fold.ts` detect dual-segment devices and drive the Diptych island (two-photo pairs in the fold layout). `native/lib/hdr.ts` reports the shell's HDR claims but trusts nothing it cannot verify — `dynamic-range: high` is treated as untrusted per WebKit #254489. `native/lib/fps-probe.ts` measures delivered frame rate; the only sanctioned 120 Hz lever is `CADisableMinimumFrameDurationOnPhone` in `Info.plist` — no private WebKit `_features`.

## Desktop shell — Tauri (`desktop/` + `src-tauri/`)

`vite.config.desktop.ts` produces `desktop/dist`, mounted inside a Tauri 2 shell. The desktop app's job is different from the shells': it is a local-first viewer for folders and cards that never copies, moves, or renames a byte.

- **Catalogue** (`desktop/lib/catalogue.ts`, `Catalogue.tsx`): every opened root lives in `catalogue.json` in the app config dir, written by the Rust private-store commands (`src-tauri/src/private_store.rs`) at mode 0600. Paths exist nowhere else — the sync payload type does not contain a path field, so they cannot leak by accident.
- **Scoped access** (`src-tauri/src/lib.rs`): a directory enters the fs and asset-protocol scopes only through the native folder picker — the grant is the directory the user picked, never a renderer-supplied path, and re-grants on launch stay inside recorded provenance. Local galleries serve originals through `convertFileSrc` in place.
- **Sign-in**: system-browser OAuth + deep-link handoff to `in.thecontrarian.manorama.desktop://auth/callback`, exchanged at `/api/auth/desktop/exchange` (see Accounts and sign-in).
- **Share flow** (`ShareFlow.tsx`, `desktop/lib/share.ts`): the *only* path by which local bytes leave the device. Explicit per-gallery user action opens a confirm gate before the first byte crosses — raw file bytes plus sanitized basenames go to the chosen provider, and the public Manorama URL comes back.
- **Sync** (`desktop/lib/sync.ts`): gallery-level metadata only — title, source kind, item count, device ID/label — to `device_galleries`. The server re-parses against `parseDeviceGalleryInput` and rejects unknown keys outright, and failures are quiet: sync must never block local viewing.

`desktop-release.yml` builds and notarizes the signed macOS DMGs (arm64 + x86_64) using the `APPLE_CERTIFICATE*`/`APPLE_SIGNING_IDENTITY`/`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` GitHub secrets — a different credential family from the SIWA Worker secrets despite the overlapping `APPLE_*` names.

## Server API surface

`app/api.ts` mounts the session-gated API on the Worker:

- `/api/galleries*` — scan, create, read, refresh, delete (session required; `requireEditableGallery` enforces pipeline locks)
- `/api/account*` — profile, linked identities (unlink refuses the last method), slug update, self-service delete
- `/api/auth/native/exchange`, `/api/auth/desktop/exchange` — one-time shell handoffs
- `/api/device-galleries*` — metadata-only shell sync (strict wire parse)
- `/api/ads/visibility` — public plate switch; `/api/ads/suppressions` — master-gated
- `/api/admin/*` — master console (overview, master flags, account deletion), gated by `requireMasterSession` against `master_accounts`/`MASTER_DROPBOX_SUBJECT`
- `/api/revenuecat-webhook`, `/api/stripe-webhook` — tier writes through `setUserTier`
- `/api/{dropbox,drive,mega,icloud}/*`, `/api/og/:owner/:slug`, dev-only `/api/local/file`

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
bunx tauri dev                            # Tauri shell around it
```

The iOS project uses SPM — there is no `App.xcworkspace`; build `ios/App/App.xcodeproj` scheme `App` directly. The signing team `373K7W3LKU` is already in `project.pbxproj` (`CODE_SIGN_STYLE = Automatic`); never pass `DEVELOPMENT_TEAM` on the command line — the `TRF3R33X88` suffix visible in the development certificate's CN is the member user ID, not the team.

## Deploy and release

Pushes to `main` trigger `.github/workflows/deploy.yml`: build → `wrangler d1 migrations apply manorama --remote` → `wrangler deploy` (the schema always lands before the code that needs it — no manual migration step on push). `wrangler.toml` configures the `manorama` Worker, the `DB` D1 binding, Static Assets, `PUBLIC_HOST=manorama.xyz`, and the `manorama.xyz` custom domain (the zone is delegated and live; `env.production` disables `workers.dev`). Local deploy is `bun run deploy`; run the migration command above by hand first if the local branch adds columns.

Other workflows: `ios.yml` archives the Capacitor app and hands it to App Store Connect (`APPSTORE_API_*` secrets); `desktop-release.yml` builds signed/notarized DMGs on tag; `verify.yml` is the CI gate.

The admin, galleries, and quick-add interstitials send `X-Robots-Tag: noindex, nofollow, noarchive`. `app/routes/app-ads.txt.ts` serves the ad-network declaration.

## Project layout

| Path | Responsibility |
| --- | --- |
| `packages/core/` | Platform-free heart: `ImageSource`, `GalleryMediaItem`, `BundledSource`, image-dims, image-staging, gallery-settings, `AdFrame`, fold geometry, device-gallery wire types. Runs in Worker, web bundle, and both shells |
| `app/routes/` | HonoX routes — landing, dashboard, gallery, quick-add catch-all, `auth/{apple,google,dropbox}` + logout, privacy, `opman` master console, `app-ads.txt` |
| `app/api.ts` | Session-gated API surface (see Server API surface) |
| `app/islands/` | `Viewer.tsx` (the stage), `Admin.tsx` (dashboard), `VideoSlide.tsx` |
| `app/lib/` | Worker-side: provider scanners, `oidc.ts`/`oauth-flow.ts`/`{apple,google,dropbox}-auth.ts`, `identity-repository`, `user-repository`/`gallery-repository`, retention, OG cards, `device-gallery-repository`, `revenuecat-webhook`, `stripe-webhook`. Thin re-export shims for `packages/core` |
| `native/` | Client-only SPA: `main.tsx` boot; `islands/` (`GalleryList`, `GlobalView`, `Paywall`, `VaultSettings`, `Diptych`); `lib/` (vault, offline-gallery, global-view, billing, ads, session, api, thumbs, local-compute, fold, hdr, fps-probe) |
| `desktop/` | Tauri SPA: `Catalogue`/`ShareFlow` islands; `lib/` (catalogue, local-scan, share, sync, session, welcome, tauri adapter) |
| `src-tauri/` | Rust shell: `lib.rs` (scoped grants, deep link, private-store commands), `private_store.rs` |
| `ios/`, `android/` | Capacitor shells (`ios/App/App.xcodeproj` — SPM, no workspace) |
| `migrations/` | D1 migrations 0001–0008 |
| `submission/` | App Store submission evidence, review notes, Connect fields |
| `demo-captures/` | Six-state screenshot matrix for iPhone/iPad/macOS |
| `vendo/`, `app/vendo-client.tsx`, `.vendo/` | Vendo surface — **disabled platform-wide for now**: no route, no mount, no client bundle; code and `vendo:*` tooling retained for re-enable |
| `*.playwright.ts` | Playwright acceptance specs (`qa`, `vendo-surface`, `vendo-slot`, `doodle-background`, `fold`, `video-playback`, `video-size-cap`); `native/ads.playwright.ts`, `native/global-view.playwright.ts` |
| `vite.config.ts` / `.native.ts` / `.desktop.ts` / `.native-fixture.ts` | The three build targets plus the native test fixture |
| `scripts/test-mirror.sh` | Mirrors the worktree into a scratch root and runs the unit suite — `bun test` at repo root dies `EMFILE` on the `.worktrees/` checkouts |
| `wrangler.toml` | Worker, `DB` binding, environment variables, custom domain route, 03:17 UTC retention cron |

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

The matrix is 375×812 touch, 1440×900 desktop, and 2560×1440 wide. It covers curtain behavior, strip physics, gesture and keyboard navigation, modal and focus behavior, alternate modes, CLS, accessibility, C2PA, owner-scoped routing, admin editing and reordering, quick-add interstitials and zero-click creation, the `M` magnifier, ambient video slides, per-gallery OG cards, noindex privacy, the fold layout, and the native ad-plate/global-view specs. Contract drift is checked with `bun run vendo:check`.

After any native or desktop presentation change, capture the six-state evidence matrix under `demo-captures/{ios,ipad,macos}/` — opening screen, gallery curtain, first image with controls, display-settings popover, signed-in account/admin surface, and Global View — from freshly built bundles.

## Known limitations

iCloud shared albums are the only video source — Dropbox, Drive, and MEGA scans remain image-only, and there is no transcode pipeline for master files. MEGA and iCloud ingestion rely on undocumented provider endpoints that may change without notice. Metadata and references are all Manorama stores; original media bytes are proxied, never persisted. The Android shell is generated and buildable but unpolished — kept as a break-glass store option, not a shipped product. Vendo is disabled platform-wide pending re-enable.
