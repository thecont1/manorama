# manorama — Italy, seen slowly

manorama is a single-album, link-shared photography gallery. This instance contains the supplied nine-image Italy sequence and is served at the unguessable gallery path `/italy-2018`. There is no gallery index, account system, discovery page, or link to another album.

## Run locally

The project uses Bun for the local workflow. Install dependencies, generate the image manifest and responsive assets, then start the HonoX development server:

```sh
bun install
bun run gallery
bun run dev
```

Open `http://localhost:5173/italy-2018` to view the album, or open `http://localhost:5173/` for the gallery settings workbench. The root admin is noindex and does not expose a gallery index. In this bundled v1, edits are scoped to the gallery slug and stored in the current browser; use Export/Import to move a settings JSON between browsers or into a later deployment-backed store.

## Deploy to Cloudflare

The repository is prepared for a one-command Worker deployment to the owner’s Cloudflare account:

```sh
bun run deploy
```

The command rebuilds the gallery assets, runs the HonoX client and Worker builds, and invokes `wrangler deploy`. Authenticate Wrangler once with `wrangler login` before the first deployment. The Worker name is `manorama-italy-2018`; no custom domain is hardcoded. `wrangler.toml` uses Cloudflare Workers Static Assets for the bundled `dist/` tree. An optional commented R2 binding documents the future storage switch.

## Gallery manifest

`build-gallery.mjs` writes both `public/images/italy-2018/manifest.json` and `app/lib/gallery-manifest.ts`. The generated manifest remains the deployment default. The root admin edits a separate `GallerySettings` object in `app/lib/gallery-settings.ts`, preserving stable image IDs and the immutable photo bytes. The manifest shape is:

```ts
type GalleryManifest = {
  slug: string
  title: string
  caption: string
  date: string
  images: Array<{
    id: string
    filename: string
    src: string
    width: number
    height: number
    alt: string
    caption?: string
    exif?: {
      dateOriginal?: string
      camera?: string
      lens?: string
      aperture?: string
      shutter?: string
      iso?: number
      focalLength?: string
      description?: string
    }
    c2pa: boolean
    placeholder: string
    variants?: Array<{ width: number; src: string; format: string }>
  }>
}
```

Stable image IDs are generated from the source frame number, for example `italy-2018-0100`. They are used by the URL hash (`#img-2`) and are the future join key for per-image comments. Comments are deliberately out of scope for v1; a later comments store and route can attach to these IDs without changing the viewer model or adding stage chrome.

## ImageSource adapters

The viewer consumes the `ImageSource` interface in `app/lib/imagesource.ts`:

```ts
interface ImageSource {
  list(): readonly GalleryImage[]
  url(id: string, variant?: number | 'original'): string
}
```

`BundledSource` reads the checked-in deployment manifest and public files. `R2Source` is included as the future adapter shape and resolves the same manifest entries against a configured public base URL. Moving to Cloudflare R2 means selecting that adapter and enabling the `IMAGES` binding in `wrangler.toml`; the route and viewer remain unchanged. A Dropbox adapter would follow the same interface.

## C2PA preservation and verification

The asset pipeline treats Content Credentials as part of the image bytes. The supplied `MS201810-Italy0100.jpg` carries a C2PA marker and is copied byte-for-byte into `public/images/italy-2018/`; it is never resized or transcoded. The browser panel lazy-loads `@contentauth/c2pa-web`, its separate Wasm binary, and `c2pa-wc` on the first verification request. The manifest store is read and validated locally from the same-origin served bytes, then passed to `cai-manifest-summary`.

Unsigned WebP sources are copied as the full primary source and receive additional same-format ICC-preserving responsive WebP variants. No original is recompressed, upscaled, sharpened, or converted to a sole WebP/AVIF source. The pipeline writes `integrity-report.json` and exits non-zero on a failed credential byte or dimension check. Cloudflare Images is not enabled in v1; if it is introduced later, its **Preserve Content Credentials** option must remain enabled for credentialed variants.

## Viewer controls

During viewing the stage contains only the quiet 44px Gallery controls dot. The full-screen modal is the single home for view mode, captions, image information, Content Credentials, current position, curtain recall, navigation arrows, and shortcut reference. Navigation arrows are absent by default and can be enabled from the modal. The opening curtain is server-rendered and recalls from the modal. The viewer supports strip, vertical-scroll, and one-at-a-time modes, preserves the current image while switching, responds to pointer/touch drag, wheel, keyboard, and hash deep-links, and honours `prefers-reduced-motion`.

## Project layout

| Path | Responsibility |
| --- | --- |
| `app/routes/index.tsx` | Root noindex admin route for the current gallery |
| `app/routes/[slug].tsx` | The one valid gallery route and server-rendered curtain |
| `app/routes/_renderer.tsx` | Document shell, noindex metadata, stylesheet, and island client entry |
| `app/islands/Admin.tsx` | Root settings island with edit, reset, import, and export actions |
| `app/islands/Viewer.tsx` | The hydrated viewer island: strip physics, modal, modes, C2PA trigger |
| `app/lib/gallery-settings.ts` | Per-gallery settings model, normalization, and browser-local persistence seam |
| `app/lib/imagesource.ts` | ImageSource interface, bundled adapter, future R2 adapter |
| `app/lib/gallery-manifest.ts` | Generated typed manifest used by the Worker route |
| `build-gallery.mjs` | EXIF, dimensions, placeholders, variants, and integrity report |
| `qa.spec.ts` | Playwright acceptance contract supplied with the project |
| `wrangler.toml` | Cloudflare Worker and Static Assets configuration |

## Verification

Run the supplied suite against a reachable local server with:

```sh
GALLERY_URL=http://localhost:5173 GALLERY_SLUG=italy-2018 bunx playwright test qa.spec.ts
```

The required QA matrix is 375×812 touch, 1440×900 desktop, and 2560×1440 wide, with reduced motion both enabled and disabled. The suite checks the one-visible-control rule, drag and hash navigation, the modal, curtain, arrows, CLS, accessibility, C2PA panel state, root admin rendering, mobile admin layout, settings handoff, and noindex privacy behavior.
