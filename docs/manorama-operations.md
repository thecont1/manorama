# Manorama operations manual

This is the operator knowledge base for Manorama. It documents gallery
lifecycle, source-link expectations, slug policy, image ordering, Content
Credentials preservation, error recovery, and destructive-action policy.
When something is not covered here, say so plainly — never invent
procedures.

## Gallery lifecycle

A gallery moves through these states:

1. **Candidate** — a public source link (Dropbox folder, Google Drive
   folder, or iCloud shared album) has been scanned through
   `POST /api/galleries/scan`, and the image inventory and metadata are
   visible to the owner, but nothing is persisted. The admin UI skips
   this preview and creates directly; scan exists for tool-assisted
   flows.
2. **Published** — the gallery exists at
   `https://manorama.xyz/<owner>/<slug>` and is publicly readable.
   Gallery pages send `X-Robots-Tag: noindex, nofollow, noarchive` —
   public, but unlisted. Publication does not copy images; Manorama
   proxies source-hosted originals and derivative sizes on request.
3. **Stale** — the source folder or album changed (files added, removed,
   or renamed) since the last refresh. Staleness is not detected
   automatically; refresh is a manual action
   (`POST /api/galleries/:slug/refresh`, or the refresh button in the
   admin). A refresh reconciles the inventory while preserving the
   owner's ordering — see "Image ordering".
4. **Deleted** — deletion removes the gallery record and its metadata.
   Original source files are never touched. Deletion is irreversible
   from the operator side; recovery requires recreating the gallery from
   the source link.

Free-tier owners are limited to 3 galleries; creates beyond the limit
fail with a 403 ("Remove one to add another — or write to us about
keeping more"). Pro is unlimited. A second gallery from the same source
link is rejected with a 409.

## Source link expectations

- Only **public share links** are accepted. Login-walled or
  password-protected links cannot be scanned.
- Four providers are recognized: Dropbox shared folders
  (`dropbox.com/scl/fo/…` or `/sh/…`), Google Drive folders shared with
  "Anyone with the link" (`drive.google.com/drive/folders/…`, plus the
  `/drive/u/{n}/folders/…` and `open?id=…` spellings), iCloud shared
  albums (`icloud.com/sharedalbum/#…`, `share.icloud.com/photos/…`),
  and MEGA shared folders or collections (`mega.nz/folder/{id}#{key}`,
  `mega.nz/collection/{id}#{key}`; legacy `#F!`/`#C!` fragments work too).
- iCloud **Drive** links (`icloud.com/iclouddrive/…`) are a different
  product: folder contents sit behind authenticated sharing and cannot
  be scanned anonymously. They are rejected with guidance to share a
  Photos Shared Album instead.
- Dropbox and Google Drive deliver originals (C2PA preserved; HEIC is
  transcoded to JPEG renditions for web display). iCloud shared albums
  serve web-optimized JPEG derivatives only — ~2048px maximum, no
  originals, no Content Credentials.
- iCloud support rides Apple's undocumented shared-album web endpoints
  and can break without notice; treat iCloud galleries as best-effort.
- MEGA links must carry the `#key` fragment — it is the share's
  decryption key. Manorama decrypts node keys, attributes, and image
  content client-side (AES-128 ECB/CBC/CTR; Set metadata additionally
  uses AES-GCM/CCM TLV containers). The decrypted per-file node key
  travels in the image proxy URL (`?k=`), equivalent in exposure to
  the public link itself. MEGA serves decrypted originals (`c2pa`
  preserved); formats browsers cannot render (HEIC, HEIF, TIFF) are
  served through MEGA's own generated JPEG/WebP preview via
  `/api/mega/preview`, and images with no generated preview are
  excluded. Free-tier MEGA bandwidth limits (HTTP 509) can interrupt
  image delivery — these surface as 503s; retry later.
- Accepted image formats: JPEG, WebP, TIFF, HEIC, and HEIF.
- Only the top level of a folder is scanned; subfolders are not
  descended into.
- Files that are not images are ignored, not deleted.
- Video files are ignored today. Do not promise video support.

## Slug policy

Every public gallery URL is `/<owner>/<slug>` — two slugs, two rule
sets.

- **Owner slug** identifies the account. 3–48 characters: lowercase
  `a-z`, `0-9`, single hyphens, starting and ending with an alphanum.
  Globally unique; minted from the display name on first sign-in
  (`name`, `name-2`, `name-3`, …). Changeable via `PATCH /api/account`;
  galleries follow the account, so every gallery URL changes with it.
- **Gallery slug** is unique per owner, not globally —
  `/mahesh/italy` and `/sarah/italy` can coexist. Auto-derived from the
  source title: diacritics stripped, lowercased, non-alphanumerics
  become hyphens, capped at 48 characters, `gallery` if nothing usable
  remains. Collisions get `-2`, `-3`, … suffixes automatically.
- Manual renames (`newSlug` in `PATCH /api/galleries/:slug`) must match
  `^[a-z0-9]+(?:-[a-z0-9]+)*$` — lowercase letters, numbers, and single
  hyphens only. A rename that collides with another of the owner's
  galleries fails; slugs are never silently overwritten.

## Image ordering

- Order is persisted in the gallery's stored image manifest; reordering
  never affects source files.
- Images are keyed by `ref ?? filename`: Drive file ID, iCloud photo
  GUID, or Dropbox filename (unique within a folder). Reorder and
  refresh dedupe both use that key.
- The owner reorders by dragging or keyboard-moving thumbnails in the
  admin rail; the result is saved through `PATCH /api/galleries/:slug`
  as an `order` array of keys. Images missing from the submitted order
  keep their relative position at the end.
- A refresh **preserves owner ordering**: matched images stay in their
  stored gallery positions but are replaced with the freshly scanned
  objects, so updated scanner metadata and source references flow
  through. Images removed from the source drop out; newly discovered
  images append at the end in scan order. Custom ordering survives a
  refresh.

## Content Credentials preservation

- Originals are proxied byte-for-byte through the same-origin routes
  (`/api/dropbox/file`, `/api/drive/file`). They are never recompressed,
  cropped, or converted, so embedded C2PA manifests survive intact.
- The `c2pa` flag is true for Dropbox and Drive images and false for
  iCloud images, which exist only as web derivatives — there is no
  original to verify.
- HEIC originals carry credentials, but browsers cannot render HEIC, so
  the display rendition is a transcoded JPEG. Verification reads the
  served display bytes, so a HEIC image's credentials do not verify
  from that rendition even though the flag is set — say so rather than
  calling it a failed verification.
- Verification is lazy and client-side: the viewer loads the C2PA
  toolkit and reads the manifest only when a viewer asks, inside their
  own browser. Manorama never validates or strips credentials
  server-side.

## Error recovery

- Scan failures return a 422 with a provider-specific message:
  unrecognized link, folder not shared publicly, no images found, or —
  for iCloud Drive links — a steer to Shared Albums. Nothing is
  persisted on a failed scan.
- A failed refresh leaves the stored gallery untouched; the manifest is
  rewritten only after a successful rescan.
- Duplicate source link → 409 "A gallery from that link already
  exists". Free-tier limit → 403.
- Slug conflicts on create retry automatically with the next numeric
  suffix. A rename colliding with an existing slug returns "That
  gallery URL is already in use".
- A malformed stored manifest reads as an empty gallery rather than
  crashing; empty galleries are hidden from the admin list and the
  public route 404s.
- iCloud image URLs expire, so delivery URLs are resolved fresh per
  view from the persisted checksum. If a derivative disappears upstream
  the image 404s until the gallery is refreshed.
- Proxy failures distinguish confirmed misses from temporary provider
  failures. A confirmed missing asset returns **404** on the image
  route — recheck the source link and refresh. Missing provider
  configuration, network errors, and upstream 429 or 5xx responses
  return **503** — these are temporary provider-side failures; retry
  before investigating further. Other upstream statuses pass through.

## Destructive-action policy

- Deleting a gallery removes only the Manorama record. Source files —
  images and non-images alike — are never modified or deleted, on any
  provider.
- There is no trash, undo, or retention window. The only recovery path
  is recreating the gallery from the same source link; title, caption,
  slug suffix, and custom ordering must be redone by hand.
- Refreshes and reorders are non-destructive to the source but
  overwrite the stored manifest — see the ordering caveat above.
