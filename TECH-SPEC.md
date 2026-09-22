# manorama — technical specification

The user-facing overview lives in [README.md](README.md). This document is the engineering reference: architecture, the media model, the viewer contract, provider ingestion, and how to run and ship the thing.

## Stack

A Cloudflare Worker running Hono/HonoX (TypeScript, TSX islands hydrated client-side). D1 (`DB` binding) is the production store — vite dev and tests use in-memory repositories instead. Media bytes are never persisted: they stream through same-origin proxy routes at view time. Bun is the toolchain (`bun install`, `bun run dev`, `bun test`); Playwright is the acceptance harness.

## Gallery lifecycle

Owners sign in with Dropbox and get a namespace — `manorama.xyz/{owner}/{gallery}` — fed by public Dropbox folder, Google Drive folder, iCloud shared album, and MEGA folder or collection URLs without asking gallery providers to connect their accounts. iCloud shared albums can contribute video alongside photos.

Pasting a supported link runs a server-side scan using platform credentials (Dropbox app credentials, a Drive API key, or none for iCloud and MEGA), ignores undisplayable files, loads a low-resolution preview strip, and lets the owner arrange the gallery before adding it.

Added galleries are stored as metadata and ordered media manifests in D1. Original media bytes remain with the provider and are streamed through same-origin Manorama routes when the public gallery is viewed. Removing a gallery removes Manorama's reference only; it does not delete anything at the source.

Free accounts retain up to 3 editable galleries. Creates beyond that land as temporary `pipeline` galleries — public and listed, but read-only: their cards show a deadline panel with an upgrade link, and title/caption/slug edits, image reordering, and refresh announce the lock instead of acting. Upgrading to pro (up to 99 retained galleries) promotes every still-live pipeline gallery back to editable. Pipeline galleries can still be opened, shared, copied, and deleted. See Gallery retention below.

The dashboard lists link-sourced galleries newest first. Clicking a title or caption opens an inline editor; the slug is editable too, and the public URL follows it. Beneath each title is a full-viewport-width, 100px media rail containing the gallery thumbnails — videos carry a `▶ mm:ss` badge. Items can be dragged into a new position, moved with the keyboard when focused, and panned within the rail using horizontal trackpad/wheel input or touch-style pointer movement. Each gallery row exposes its public URL, a copy action, and a delete action. Gallery links open in a new tab.

## Quick-add: `manorama.xyz/<share-url>`

Appending a supported share URL to the origin creates the gallery and opens it — `manorama.xyz/https://www.dropbox.com/scl/fo/…` or `manorama.xyz/mega.nz/collection/…#key` both work. Signed-in owners get zero-click creation; signed-out visitors see a branded interstitial whose **Continue with Dropbox** button round-trips the full URL through OAuth so the gallery completes on return. MEGA and iCloud keys live in the URL fragment, which browsers never send — the catch-all route (`app/routes/[...src].tsx`) recognizes provider-shaped paths, renders the interstitial, and the client (`app/quickadd.ts`) reassembles the complete URL from `pathname` + `search` + `hash`. Non-provider paths fall through to the real routes untouched, and revisiting a link opens the existing gallery (`409` + `galleryUrl`). Quick-add galleries are named by the platform rather than the provider's folder name — three hyphenated words drawn from a fixed evocative list (`ember-tide-fern`), so the public URL reads like a title; dashboard creates keep the scanned folder name.

## Public URLs

The canonical public URL shape is:

```text
https://manorama.xyz/{owner}/{gallery-slug}
```

The same path is available through the Worker fallback:

```text
https://manorama.thecontrarian.workers.dev/{owner}/{gallery-slug}
```

Gallery pages emit per-gallery Open Graph cards: `og:image` points at `/api/og/{owner}/{slug}?i={first-item}`, a 1200×630 JPEG composite of the first frame (a video's poster, when the gallery opens with one) with the wordmark pill superimposed. The endpoint caches for a day, keys off the first item so reorders bust edge caches, and falls back to a static card rather than serving a broken image.

## Storage and sign-in

D1 is the production store (`DB` binding, `migrations/`); vite dev and tests use in-memory repositories instead. The `users` table maps Dropbox accounts to owner slugs and tiers; the `galleries` table stores per-owner manifests:

| Field | Purpose |
| --- | --- |
| `slug` | Stable gallery URL segment (per-owner unique) |
| `title`, `caption`, `date` | Curtain, admin, and OG copy |
| `sourceUrl` | The public provider link |
| `createdAt` | Recency ordering |
| `imagesJson` | Ordered media manifest — `image` and `video` items in one union |
| `retention` | `retained` (editable) or `pipeline` (temporary, read-only) |
| `expires_at` | Pipeline removal deadline; `NULL` on retained rows |

### Gallery retention

Free accounts keep at most 3 `retained` galleries; further creates insert as `pipeline` rows with `expires_at` exactly 30 days after `created_at`. Paid accounts cap at 99 retained galleries — a create beyond that is a typed `GALLERY_LIMIT` 403. The public cutoff is enforced at read time: once `expires_at` passes, lists and gallery/OG reads hide the row immediately, while stored-record reads keep it reachable for owner deletes and the expiry walk. A daily cron (`17 3 * * *`, 03:17 UTC) physically removes expired rows with a guarded delete — a gallery recreated under the same slug after the scan survives, and manual deletes/upgrades mid-scan are safe skips. Deletion removes only the Manorama row; nothing at the provider is ever touched.

All galleries present before `migrations/0002_gallery_retention.sql` normalize to `retained` with `NULL` expiry — nothing existing goes temporary.

Upgrades run through `setUserTier`, the trusted seam: it writes the tier and promotes every unexpired pipeline gallery (`expires_at > now`, strictly — a deadline equal to now stays expired) in one idempotent batch, so a repeated pro write is safe. Never update the D1 `tier` column alone — that would leave pipeline galleries locked on a pro account. Payment verification is the caller's responsibility; there is no public upgrade API, billing integration, or webhook. Promotion can lift an owner past 99 retained galleries; the cap applies only to subsequent creates.

A gallery's Manorama-owned state is the D1 row only — no per-gallery persisted assets or auxiliary tables exist. Pipeline OG cards are served `Cache-Control: no-store` (composite and fallback alike); retained cards keep the existing day cache. Provider-keyed transient caches and browser-local viewer preferences are unchanged and hold no gallery copies.

Sign-in is Dropbox OAuth (`/auth/dropbox` → callback → HS256 `manorama_session` cookie signed by `HOST_API_JWT_SECRET`). The dashboard route `/{owner}` requires the session to match that owner; anything else redirects to the landing page or 404s. Server-side secrets:

| Secret | Purpose |
| --- | --- |
| `HOST_API_JWT_SECRET` | Signs the `manorama_session` cookie |
| `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` | Dropbox OAuth and public shared-link ingestion |
| `GOOGLE_DRIVE_API_KEY` | Public Drive folder ingestion |
| `VENDO_API_KEY` | Unused for now — the Vendo surface is disabled platform-wide |

## Provider ingestion

### Dropbox

The Dropbox app needs the scopes for OAuth sign-in plus public shared-link metadata and file content. End users only ever provide a public shared-folder URL with downloading enabled — ingestion uses the shared-link API path, and delivery routes proxy thumbnails and originals without persisting bytes.

### Google Drive

Google Drive ingestion reads folders shared with "Anyone with the link" using a server-side API key — no end-user OAuth. Create a Google Cloud project, enable the Google Drive API, and create an API key (optionally restricted to the Drive API). Listing uses `files.list` scoped to the folder; originals stream through `/api/drive/file` (`alt=media`) and thumbnails through `/api/drive/thumbnail`. HEIC files display via Drive's JPEG thumbnail rendition.

### iCloud

iCloud shared album links (`icloud.com/sharedalbum/#…` or `share.icloud.com/photos/…`) need no credentials — the album token is the only key. Manorama uses the undocumented `sharedstreams` endpoints that power Apple's own public album web viewer. Two consequences: the endpoint is unsupported and may change without notice, and shared albums serve web-optimized derivatives (~2048px JPEGs, ~720p H.264 MP4s) rather than originals, so iCloud media is never marked `c2pa`.

Albums containing video produce mixed galleries: the scanner picks the video derivative and a poster derivative per entry — derivative key names (`720p`, `PosterFrame`) and the asset's URL extension identify them on older album payloads, with a content-type probe as fallback. Video streams through `/api/icloud/video` with `Range` forwarding so seeking does not download the whole clip; posters come through `/api/icloud/image` like any other derivative.

iCloud **Drive** share links (`icloud.com/iclouddrive/…`) are a different product: folder contents sit behind authenticated CloudKit sharing and cannot be scanned anonymously, so they are rejected with guidance to use a Photos Shared Album instead.

### MEGA

MEGA shared folder links (`mega.nz/folder/{id}#{key}`) and collection links (`mega.nz/collection/{id}#{key}`, MEGA's "Sets") need no credentials — the share key in the link fragment is the decryption key. Manorama enumerates the source through MEGA's public API (`a:'f'` for folders, `a:'aft'` for collections), decrypts node keys and attributes client-side, and decrypts image content at proxy time (`/api/mega/file`) using AES-128-CTR with each file's node key. Formats browsers cannot render (HEIC, HEIF) are served through MEGA's generated JPEG/WebP previews (`/api/mega/preview`); images with no preview are excluded.

Caveats: the API is undocumented; decryption happens per view so large sources mean per-request CPU cost; MEGA's free-tier bandwidth quota (HTTP 509) surfaces as a temporary failure; and the decrypted node key rides in the image proxy URL — equivalent in exposure to the public link itself. MEGA images are decrypted originals, so `c2pa` is preserved.

## Media model

The viewer consumes the `ImageSource` interface in `app/lib/imagesource.ts`; `BundledSource` adapts a stored gallery record into the runtime sequence. A gallery is a `GalleryMediaItem[]` union — `image` items and `video` items interleaved, with an absent `type` implying image so all-photo manifests are unchanged. Video items carry a proxy `src`, a poster derivative, dimensions, and an optional duration. Link-sourced records are delivered through the Worker's transient per-provider proxy routes (`/api/dropbox/*`, `/api/drive/*`, `/api/icloud/*`, `/api/mega/*`), so the viewer does not need to know where the media originated.

Each item has a stable ID, an optional provider `ref` (Drive file ID, iCloud photo GUID) used for ordering and refresh dedupe, filename, dimensions, alt text, optional caption and EXIF data, C2PA state, placeholder, and responsive variants. The ordered sequence is persisted in `imagesJson`; dragging or keyboard-moving an item changes only the gallery order, not the source files.

The asset pipeline treats Content Credentials and ICC profiles as part of the image bytes. Originals are never recompressed, cropped, stretched, upscaled, or converted into a sole alternate format. C2PA verification remains client-side and lazy-loaded.

## Viewer contract

The stage shows only a half-hidden brand pill bobbing at the bottom edge — everything else is quiet chrome. The pill opens display settings, which holds view modes, arrows, fullscreen, shortcuts, and the in-gallery information sheet (position, caption, EXIF, Content Credentials). `I` opens the in-gallery information sheet; `⇧I` deep-links the current photograph into the standalone C2PA viewer (`c2pa.thecontrarian.in/?uri=…`) in a new tab, falling back to the in-gallery sheet for sources it cannot fetch (videos, non-http origins). Navigation arrows ship on for fine pointers and hide by default on touch — enabled there, they dock at the viewport's bottom corners. Vertical scroll keeps them off by default at any pointer; enabling the toggle stacks ↑/↓ at the bottom-right corner, stepping the feed one photograph at a time. A sequence bubble riding just left of the button cluster (or docked in its corner slot when arrows are off) counts the active photograph. The viewer supports strip, vertical-scroll, and one-at-a-time modes, pointer and touch dragging, wheel input, keyboard navigation, and reduced-motion preferences — images fit the stage without cropping and are never upscaled past their natural size. One-at-a-time steps sweep the incoming photograph directionally over the current one behind an opaque card, so the background treatment never ghosts through mid-transition. Sizing is density-aware rather than purely CSS-driven: the horizontal strip fits height-first so neighbouring photographs abut edge-to-edge like a photostrip, vertical scroll fits width-first (portraits included — a tall frame simply runs long), and one-at-a-time contains both axes — all with the effective device pixel ratio capped at 2, so a displayed pixel never claims more source pixels than exist. A source short on pixels floats smaller and centred rather than stretching — in a mixed folder, hi-res photographs fill the stage while low-res ones keep their honest size. Beneath the photographs sits a stable plain canvas, independent of the optional background treatment. Display settings' Background choice offers None, Light, and Dark: None — the default — leaves photographs strictly abutting on the plain dark canvas, while Light and Dark wake a seeded doodle field (dark ink on the paper canvas, light ink on near-black) and give every image a 10px margin — top, bottom, and right in the horizontal strip, left, right, and bottom in vertical scroll. The viewer applies no provider transforms and preserves original bytes; where a source serves only derivatives — iCloud web derivatives, Drive/MEGA previews for formats the browser cannot decode, or the existing HEIC fallback — the safe display size caps to the actual served pixels, with no new canvas re-encoding.

Video slides are ambient: the active slide mounts the only `<video>` element — muted, looping, `playsInline` — while neighbors render posters only. A pause/play control, an unmute megaphone (sound is a viewer-level toggle), and a `VIDEO · mm:ss` chip overlay the slide; leaving the slide pauses and rewinds, and `prefers-reduced-motion` swaps autoplay for a poster plus an explicit Play control.

On fine-pointer desktops, `M` summons a glass-ball magnifier that follows the cursor over the stage at 3× (a decorative DOM mirror — `aria-hidden`, dismissed by `Esc`, `M`, or opening a dialog). The `M` shortcut row in display settings appears only where the key works; the `I` row is always listed.

## Run locally

The project uses Bun:

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

In dev only, quick-add accepts a folder straight off disk: append an absolute path to the dev origin — `localhost:5173//Users/you/photos/album` — and the catch-all claims it when the path resolves to a real directory. Signed out, the interstitial's **Sign in (dev)** button mints a session for the seeded owner via `/.dev-seed/login` (no Dropbox round-trip); signed in, the gallery is created immediately. The dashboard paste box accepts `file:///…` and bare absolute paths too.

Local items stream through `/api/local/file?path=…`, which is confined to directories scanned during the dev session and an image/video extension allowlist; `&w=` serves sharp-resized WebP thumbnails. The whole feature is gated behind a flag the `apply: 'serve'` plugin sets on `globalThis` — production builds can never claim a local path, and the route 404s. Media stays in place: nothing is copied or uploaded.

## Deploy to Cloudflare

The repository is one-command deployable to the Worker account — but the retention migration must be applied to the production database BEFORE the first deploy of a build that expects the columns:

```sh
bunx wrangler d1 migrations apply manorama --remote
bun run deploy
```

`wrangler.toml` configures the `manorama` Worker, the `DB` D1 binding, Static Assets, `PUBLIC_HOST=manorama.xyz`, and both the `workers.dev` fallback and the `manorama.xyz` custom domain.

Cloudflare currently has a `manorama.xyz` zone and the custom domain attached to the Worker. The domain remains pending until the registrar publishes only the Cloudflare nameservers:

```text
oswald.ns.cloudflare.com
zara.ns.cloudflare.com
```

After delegation has propagated, verify:

```sh
dig +short NS manorama.xyz
curl -I https://manorama.xyz/
curl -I https://manorama.xyz/thecontrarian/{gallery-slug}
```

The admin, galleries, and quick-add interstitials send `X-Robots-Tag: noindex, nofollow, noarchive`.

## Project layout

| Path | Responsibility |
| --- | --- |
| `app/routes/index.tsx` | Landing page and sign-in door (redirects sessions to `/{owner}`) |
| `app/routes/[owner].tsx` | Per-owner dashboard route (session-gated) |
| `app/routes/[owner]/[slug].tsx` | Canonical owner-scoped gallery route |
| `app/routes/[...src].tsx` | Quick-add catch-all — provider-shaped paths only, else `next()` |
| `app/routes/auth/` | Dropbox OAuth start/callback and logout |
| `app/routes/privacy.tsx` | Privacy policy |
| `app/islands/Admin.tsx` | Gallery dashboard: intake, arrangement, inline editing |
| `app/islands/Viewer.tsx` | Hydrated strip viewer: modes, gestures, modals, magnifier, C2PA |
| `app/islands/VideoSlide.tsx` | Ambient video leaf — mounts `<video>` only while its frame is active |
| `app/lib/magnifier.ts` | DOM-mirror lens for the `M` magnifier |
| `app/lib/og-card.ts` | Per-gallery OG compositor (`cf.image` primary, jimp/sharp fallback) |
| `app/lib/sources.ts` | Source link detection (`embeddedSourceCandidate`) and scanner dispatch |
| `app/lib/source-errors.ts` | Visitor-facing scan-failure copy, shared by admin and quick-add |
| `app/lib/dropbox-session.ts` | `manorama_session` cookie verification and env access |
| `app/lib/user-repository.ts` | User/owner persistence (D1, in-memory in dev) |
| `app/lib/gallery-repository.ts` | Gallery persistence (D1, in-memory in dev) |
| `app/lib/dropbox-public.ts` | Public shared-link scan, thumbnail, and original delivery helpers |
| `app/lib/gdrive-public.ts` | Link-shared Drive folder scan and image delivery helpers |
| `app/lib/icloud-shared.ts` | Public iCloud shared album scan — photos and video derivatives |
| `app/lib/mega-public.ts` | Public MEGA folder/collection scan and decrypting file + preview delivery |
| `app/lib/mega-crypto.ts` | Pure-JS AES-128 (ECB/CBC/CTR/CCM) + AES-GCM TLV for MEGA's client-side encryption |
| `app/lib/gallery-settings.ts` | Per-gallery viewer settings and browser fallback |
| `app/lib/imagesource.ts` | `ImageSource` interface, `GalleryMediaItem` union, `BundledSource` adapter |
| `app/quickadd.ts` | Quick-add client: URL reconstruction, create, sign-in handoff |
| `vite.config.ts` | Dev-seed plugin (`MANORAMA_DEV_SOURCE_*` scans, `/.dev-seed/reset`) |
| `vendo/`, `app/vendo-client.tsx`, `.vendo/` | Vendo surface — **disabled platform-wide for now**: no route, no mount, no client bundle; code and `vendo:*` tooling retained for re-enable |
| `*.playwright.ts` | Playwright acceptance specs (`qa`, `vendo-surface`, `vendo-slot`) |
| `wrangler.toml` | Worker, `DB` binding, environment variables, custom domain route |

## Verification

Unit tests and typecheck:

```sh
bunx tsc --noEmit
bun test
```

Run the local acceptance suite against the seeded dev server (`bun run dev`). The specs default to `GALLERY_SLUG=dev-dropbox` and need `GALLERY_VIDEO_SLUG` pointing at a video-containing gallery — so the corresponding `MANORAMA_DEV_SOURCE_*` vars must be set:

```sh
GALLERY_URL=http://localhost:5173 GALLERY_VIDEO_SLUG=mixed-album bunx playwright test
```

The matrix is 375×812 touch, 1440×900 desktop, and 2560×1440 wide. It covers curtain behavior, strip physics, gesture and keyboard navigation, modal and focus behavior, alternate modes, CLS, accessibility, C2PA, owner-scoped routing, admin editing and reordering, quick-add interstitials and zero-click creation, the `M` magnifier, ambient video slides, per-gallery OG cards, and noindex privacy. Contract drift is checked with `bun run vendo:check`.

## Prototype limitations

iCloud shared albums are the only video source in v1 — Dropbox, Drive, and MEGA scans remain image-only, and there is no transcode pipeline for master files. MEGA and iCloud ingestion rely on undocumented provider endpoints that may change without notice. Metadata and references are all Manorama stores; original media bytes are proxied, never persisted.
