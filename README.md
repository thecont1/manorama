# manorama

Manorama is a photography-first publishing experience for sharing beautiful galleries with friends and family. The current prototype has one owner namespace, `thecontrarian`, and accepts public Dropbox folder URLs without asking gallery providers to connect their Dropbox accounts.

## Current workflow

Open the noindex admin at `https://manorama.thecontrarian.workers.dev/`. Paste a public, download-enabled Dropbox folder URL and choose **Manorama-fy it!**. Manorama uses its server-side Dropbox app credentials to enumerate the shared folder, ignores non-image files, loads a low-resolution preview strip, and lets the owner arrange the images before adding the gallery.

Added galleries are stored in Airtable as metadata and ordered image manifests. Original image bytes remain in Dropbox and are streamed through same-origin Manorama routes when the public gallery is viewed. Removing a gallery removes Manorama’s reference only; it does not delete anything in Dropbox.

The admin lists Dropbox-backed galleries newest first. Clicking a title or caption opens an inline editor. Beneath each title and caption is a full-viewport-width, 100px image rail containing the gallery thumbnails. Images can be dragged into a new position, moved with the keyboard when focused, and panned within the rail using horizontal trackpad/wheel input or touch-style pointer movement. Each gallery row exposes its public URL, a copy action, and a delete action. Gallery links open in a new tab.

## Public URLs

The canonical public URL shape is:

```text
https://manorama.xyz/thecontrarian/{gallery-slug}
```

While DNS propagation is in progress, the same path is available through the Worker fallback:

```text
https://manorama.thecontrarian.workers.dev/thecontrarian/{gallery-slug}
```

The previous single-segment path, such as `/kashmir`, redirects to the owner-scoped path when the gallery exists. The bundled Italy fixture remains available only for local development and is not listed or served in the Airtable-backed production environment.

## Airtable setup

Airtable is used as an internal metadata registry rather than as an image store. The Worker expects these server-side secrets:

| Secret | Purpose |
| --- | --- |
| `AIRTABLE_PAT` | Personal Access Token with read/write access to the Manorama base/table |
| `AIRTABLE_BASE_ID` | Airtable base identifier |
| `AIRTABLE_GALLERIES_TABLE` | Table name, normally `Galleries` |

The `Galleries` table uses these fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `slug` | Single line text | Stable gallery URL segment |
| `title` | Single line text | Opening curtain and admin title |
| `caption` | Long text | Opening curtain and admin caption |
| `date` | Single line text | Optional displayed gallery date |
| `sourceUrl` | URL or text | Public Dropbox folder URL |
| `createdAt` | Date/text | Recency ordering |
| `imagesJson` | Long text | Ordered image metadata and transient source references |

Only records with a non-empty `sourceUrl` and at least one parsed image are shown in the production admin. This keeps incomplete planning records out of the public list.

## Dropbox setup

The Worker expects these server-side secrets:

| Secret | Purpose |
| --- | --- |
| `DROPBOX_APP_KEY` | Manorama’s Dropbox app key |
| `DROPBOX_APP_SECRET` | Manorama’s Dropbox app secret |

The Dropbox app must have the read scopes needed for public shared-link metadata and file content. End users do not authorize Dropbox. They only provide a public shared-folder URL with downloading enabled.

Dropbox enumeration uses the official shared-link API path. The initial scan returns image metadata and thumbnail routes; the Worker uses cursors internally for the folder listing. The delivery routes proxy thumbnails and originals without persisting the image bytes in Manorama.

## Run locally

The project uses Bun:

```sh
bun install
bun run gallery
bun run dev
```

Open `http://localhost:5173/` for the admin. The local bundled Italy fixture is available at `http://localhost:5173/thecontrarian/italy-2018`; it is a development fallback used by the viewer acceptance suite when Airtable is not configured.

## Deploy to Cloudflare

The repository is one-command deployable to the Worker account:

```sh
bun run deploy
```

`wrangler.toml` configures the `manorama` Worker, Static Assets, `PUBLIC_HOST=manorama.xyz`, `OWNER_SLUG=thecontrarian`, and both the `workers.dev` fallback and the `manorama.xyz` custom domain.

Cloudflare currently has a `manorama.xyz` zone and the custom domain attached to the Worker. The domain remains pending until the registrar publishes only the Cloudflare nameservers:

```text
oswald.ns.cloudflare.com
zara.ns.cloudflare.com
```

After delegation has propagated, verify:

```sh
dig +short NS manorama.xyz
curl -I https://manorama.xyz/
curl -I https://manorama.xyz/thecontrarian/kashmir
```

The admin root and public galleries send `X-Robots-Tag: noindex, nofollow, noarchive`. The admin is intentionally not authenticated in this prototype and must be protected before inviting other users.

## ImageSource and gallery model

The viewer consumes the `ImageSource` interface in `app/lib/imagesource.ts`. `BundledSource` reads the generated local manifest and is retained as a development fallback. Dropbox-backed records use the same manifest shape and are delivered through the Worker’s transient Dropbox proxy routes, so the viewer does not need to know where the image originated.

Each image has a stable ID, filename, dimensions, alt text, optional caption and EXIF data, C2PA state, placeholder, and responsive variants. The ordered image sequence is persisted in `imagesJson`; dragging or keyboard-moving an image changes only the gallery order, not the Dropbox files. The admin rail renders 100px thumbnails with preserved aspect ratios and does not alter the source images.

The asset pipeline treats Content Credentials and ICC profiles as part of the image bytes. Originals are never recompressed, cropped, stretched, upscaled, or converted into a sole alternate format. C2PA verification remains client-side and lazy-loaded.

## Viewer contract

During gallery viewing, the stage contains only the quiet Gallery controls dot. The full-screen modal is the single home for view modes, captions, image information, Content Credentials, curtain recall, current position, navigation arrows, and shortcuts. The viewer supports strip, vertical-scroll, and one-at-a-time modes, pointer and touch dragging, wheel input, keyboard navigation, deep links, and reduced-motion preferences.

## Project layout

| Path | Responsibility |
| --- | --- |
| `app/routes/index.tsx` | Root noindex admin route |
| `app/routes/[owner]/[slug].tsx` | Canonical owner-scoped gallery route |
| `app/routes/[slug].tsx` | Legacy single-segment redirect into the owner namespace |
| `app/islands/Admin.tsx` | Dropbox intake, image arrangement, gallery list, inline editing, copy, and delete |
| `app/islands/Viewer.tsx` | Hydrated strip viewer, modal, modes, gestures, and C2PA trigger |
| `app/lib/dropbox-public.ts` | Public shared-link scan, thumbnail, and original delivery helpers |
| `app/lib/gallery-repository.ts` | Airtable-backed gallery persistence and local fallback |
| `app/lib/gallery-registry.ts` | Earlier generated registry seam retained for compatibility |
| `app/lib/gallery-settings.ts` | Per-gallery viewer settings and browser fallback |
| `app/lib/imagesource.ts` | ImageSource interface and bundled adapter |
| `build-gallery.mjs` | EXIF, dimensions, placeholders, variants, and integrity report |
| `qa.spec.ts` | Playwright acceptance contract |
| `wrangler.toml` | Worker, environment variables, Static Assets, and custom domain route |

## Verification

Run the local acceptance suite against the local server:

```sh
GALLERY_URL=http://localhost:5173 GALLERY_OWNER=thecontrarian GALLERY_SLUG=italy-2018 bunx playwright test qa.spec.ts
```

The required matrix is 375×812 touch, 1440×900 desktop, and 2560×1440 wide, with reduced motion enabled and disabled. It checks the one-visible-control rule, strip physics, gesture and keyboard navigation, curtain and modal behavior, alternate modes, CLS, accessibility, C2PA panel state, owner-scoped routing, admin branding, inline metadata editing, 100px admin image-rail ordering and panning, new-tab gallery links, copyable gallery URLs, and noindex privacy behavior.

## Prototype limitations

This prototype deliberately has no login or payment system. Anyone who can reach the root admin can currently attempt admin mutations, so the admin/API surface should be placed behind an access layer before the application becomes a public multi-tenant service. Airtable stores metadata and references only; the current Worker does not store user photographs.
