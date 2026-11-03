# Encrypted Sources, Privacy Invariants, Native Vault, iCloud Originals (Plan v3.1)

Baseline: `main` @ b39e354.

---

## A. Reference status

Every code reference is marked:

- **V** = verified by reading the file at b39e354.
- **V(ext)** = verified by an independent reviewer (HO1) against b39e354;
  re-confirm at implementation and record any drift.

| Reference | Claim | Status |
|---|---|---|
| `migrations/0001_users_and_galleries.sql` | `galleries` PK is `(owner_id, slug)`, no surrogate id; `created_at` is `datetime('now')`; unique index on `(owner_id, source_url)` | V |
| `app/lib/mega-public.ts` `canonicalMegaUrl()` | Re-emits the key (fragment) into the canonical source URL | V |
| `app/lib/mega-public.ts` `fileProxy` / `previewProxy` | Item `src` and preview variant URLs embed the node key (`k=`) | V |
| `app/lib/mega-public.ts` `fetchMegaFile()` | Buffers encrypted bytes, decrypts the full file in the Worker (48 MiB cap), returns plaintext | V |
| `app/lib/mega-public.ts` `previewCache` | Module-level decrypted-preview cache, 200 entries / 64 MiB | V |
| `app/lib/mega-public.ts` :44-46, :279-301, :312 | Listing carries `s`/`ts`; probe uses preview-rendition dims, original head only for HEIC; 4:3 fallback | V(ext) |
| `app/lib/sources.ts` `canonicalSourceMatches()` | MEGA match requires equal `kind`, `id`, `key` | V |
| `app/lib/sources.ts` `scanSource()` | Server-side scan from a URL string | V |
| `native/lib/offline-gallery.ts` `offlineSourceFor()` | Identity: returns `image.src` | V |
| `native/lib/offline-gallery.ts` `cache()` :353 | `fetchImage(src)` → `arrayBuffer()` → `vault.write`; reuse gated on `priorImage.src === image.src` | V |
| `native/lib/offline-gallery.ts` `open()` :120 | Mints an object URL for every vaulted image before returning | V |
| `native/lib/vault.ts` :150-156 | AES-GCM via `crypto.subtle`, AAD bound to header / galleryId / entryId; vault is encrypted at rest | V(ext) |
| `native/lib/session.ts` :64, :47 | Gallery deep-link parser rejects any URL with `hash`; quick-add links append `url.hash` | V(ext) |
| `app/quickadd.ts`; `app/islands/Admin.tsx` :483-487 | Browser rebuilds URL incl. hash; debounced POST to `/api/galleries/scan` | V(ext) |
| `app/api.ts` :539, :574, :605-608, :622, :799-806 | Server re-scans; create path; slug uniqueness among existing rows; source_url persisted; refresh | V(ext) |
| `app/routes/_renderer.tsx` :32-37 | `og:image:type` hardcoded `image/jpeg` when an image is set; a comment asserting per-gallery cards are composited JPEG, false for a static card; `og:url` is path-only; width/height hardcoded | V(ext) |
| `app/lib/og-card.ts` :51-52, :159-183, `ogBaseImageUrl` | `ogItemKey` is the first item's `ref`; `jimp` lazy-imported; base URL for MEGA is the `/api/mega/file?…&k=…` URL | V(ext) |
| `app/routes/[owner]/[slug].tsx` :80, :102-104 | Manifest passed as island props; generic `og:description` fallback | V(ext) |
| `app/lib/security-headers.ts` :22 | `connect-src 'self'` | V(ext) |
| `app/lib/gallery-policy.ts` :15-17; `gallery-repository.ts` :291 | Pipeline galleries read-only; `retention = 'retained'` update guard | V(ext) |
| `packages/core/imagesource.ts` :30-42; `gallery-repository.ts` :489-490 | `width`/`height` required on `GalleryImage` and persisted into `images_json` | V(ext) |
| `app/islands/Viewer.tsx` :2457, :2482 | Frame geometry driven by `image.width`; staged geometry | V(ext) |
| `public/og-image.png` | 1200×630 | V(ext) |

---

## B. Starting state (state this first in every derived document)

The server currently holds every MEGA key and decrypts on view, refresh, and OG:

1. The share URL, including the fragment, is sent to the server (create, scan,
   and the debounced admin scan).
2. `canonicalMegaUrl()` persists the key in `source_url`.
3. Every MEGA item `src` carries its node key, so keys are in gallery HTML
   props and `<img src>`.
4. Refresh re-scans from the stored `sourceUrl` on the server.
5. OG generation fetches and decrypts a full original and edge-caches the
   composite.
6. A decrypted-preview cache exists in Worker memory.

**Why first.** "The backend never receives the key" is not a design option
still to be chosen; it is already false. Omitting the current state
under-scopes the work, because removing a cache does not remove key custody.

---

## C. Invariants

### Tier 1 — No server caching of decrypted media or derivatives
Scope: **encrypted sources** (MEGA, Ente). Covers photographs, thumbnails,
module-level maps, Cache API, CDN, object storage. Delivered first.

### Tier 2 — No server key custody for encrypted sources
Delivered per surface. Each remaining surface is a named exception with an
owner and an end condition.

### Exceptions
| Exception | Scope | Owner | End condition |
|---|---|---|---|
| One-day edge cache of OG composites (Dropbox/Drive) | Unencrypted providers only | Owner, at ADR sign-off | **Decision due 2027-02-01** (90 days): remove, shorten, or accept. Accepting requires public wording and is a recorded outcome, not a default. |
| Legacy server-held keys for not-yet-migrated MEGA galleries | MEGA | Implementing agent, reported at migration close | Removed by the reversible migration (section I) |
| Owner opt-in "server-assisted preview card" (**not shipped in this plan** — see D4 reversal; lands at M.10 at the earliest) | One gallery, only if the owner enables it | Owner | Ends when disabled; never default-on |

### Credential custody (not a Tier 2 failure)
iCloud tokens, Dropbox `rlkey`s, and Drive resource keys are access
capabilities, not decryption keys. The provider serves plaintext.

### Why two tiers
The product promise is "we never cache decrypted photographs or thumbnails
server-side." That is Tier 1 and is achievable now. "No key custody" is
stronger and conflicts with surfaces (refresh, scan preview, OG) that need the
key today. Collapsing them would make the promise false on day one or force a
big-bang rewrite.

### Why Tier 1 is scoped to encrypted sources
Unencrypted providers are proxied in plaintext by design. Applying Tier 1 to
their OG composites would fail the section L canary test immediately; naming
the exception is more honest than silently narrowing the promise later.

### Wording rules
- Do not claim "zero-knowledge" or "zero cost".
- State that anyone holding the full gallery link can also open the MEGA folder
  directly, because the fragment carries the same capability.
- State that every encrypted-source gallery shares one social preview image.

---

## D. Architecture Decision Record (write before code; owner sign-off required)

| # | Decision | Why |
|---|---|---|
| D1 | Fragment carries the **share key (MEGA) / album key (Ente) plus a handle**; the client re-lists on open. | Per-node keys in a URL do not scale, and MEGA nested nodes carry one key alternative per ancestor scope. Re-listing costs one listing call plus N key unwraps per open; an in-memory per-session listing cache can reduce it. |
| D2 | Owner access uses a **client-held key store keyed by an immutable gallery `id`** (new column), with export and a "lost key cannot be recovered" warning. Deleting a gallery clears its entry. | Internal navigation is slug-only, so without a store the owner's own gallery opens locked. Slug alone is unsafe: slugs are reusable after delete (PK is `(owner_id, slug)`), so a new gallery could inherit an old key. `created_at` has one-second resolution, so a surrogate id is safer than a timestamp tuple. |
| D3 | **Refresh is client-driven**, run from the owner's device, for encrypted sources. | Server refresh needs the key. Pipeline galleries are read-only, so client refresh only touches retained galleries, and the retained-only update guard still applies. |
| D4 | **Encrypted-source galleries use the static OG image**; per-gallery identity lives in `og:title` / `og:description`. The OG route and `ogBaseImageUrl` are bypassed, not merely given a fallback. | See section D4 detail below. |
| D5 | **Relay re-resolves per request** by node reference; ciphertext only; no raw `?url=`; no key accepted. | A raw URL relay is a full SSRF surface, and MEGA CDN hostnames rotate and URLs expire, which would force re-resolution anyway. |
| D6 | **The vault stays encrypted at rest.** A decrypt step is added in front of the write; vault manifests hold keyless refs; keys live in the key store. | The vault already uses AES-GCM with AAD bound to gallery and entry. Storing plaintext at rest would be a regression. |
| D7 | **Native fragment channel:** the gallery deep-link parser accepts a fragment; the selection type carries it; the key store is consulted before `fetchGallery`. | A parser that rejects hashes makes keyed gallery links fall through silently to the library. Reading `location.hash` in the SPA would not touch the parser that drops the link. |
| D8 | **No third-party scripts on gallery routes**, enforced in CI. | Today's key safety rests on the absence of such scripts; a single inline snippet would expose every fragment. |
| D9 | **Create/scan contract:** for encrypted providers the client scans and submits a validated manifest; the fragment is never POSTed. | Otherwise "keys never appear in server requests" cannot pass: create and the debounced admin scan both receive the URL today. |
| D10 | **Published dimensions and content-version marker** (see detail below). | Dimensions are already server-visible; the marker must be opaque to avoid new disclosure. |

### D4 detail — static OG image

**Decisive reason.** A per-gallery card of any kind cannot avoid a pipeline
the tree does not have:
- The OG route reads D1 only. The fragment never reaches the server, and
  crawlers do not send fragments, so a photographic card needs a server-held
  key.
- A typographic card does not avoid the problem. `cf.image.draw` accepts
  `{url}` inputs only, so text needs a pre-rendered image per gallery. `jimp`
  is deliberately lazy-imported and reached only when the transform fails, so
  using it moves text rendering onto the path the project avoids. satori +
  resvg means two dependencies plus font subsetting inside a Worker.
- A static image adds no dependency, touches no media, and keeps Tier 1 true.

**Requirements.**
1. `[slug].tsx` emits `/og-image.png` directly for encrypted providers and
   must not emit `/api/og/…` for them. Otherwise `ogCardResponse` →
   `ogBaseImageUrl(item)` would still trigger a full-origin fetch and a Worker
   AES-CTR decrypt (up to 48 MiB).
2. The OG route also short-circuits for encrypted providers, so stale
   bookmarks and cached URLs cannot reach `fetchMegaFile`.
3. Derive `og:image:type` from the asset's extension. The asset is a PNG; the
   hardcoded value is JPEG. Width/height (1200×630) are already correct. The
   inline comment at `_renderer.tsx`:33 ("per-gallery cards are composited
   JPEG") stops being true for encrypted galleries and is updated in the same
   change.
4. Do not emit `?i=` for encrypted galleries. `ogItemKey` is the first item's
   `ref`; with a static image nothing varies, so each first-item change would
   mint a new edge-cache entry for an identical asset.
5. For encrypted galleries `og:description` must never fall back to the generic
   string: carry the item count always, the date when set, and the source
   provider label. **The date is often absent** — creation writes `date: ''`
   and nothing fills it unless the owner edits metadata — so "always carry the
   date" alone is unsatisfiable. A count-only unfurl over a brand image is the
   failure mode this decision accepts.

**Acceptance.** For an encrypted gallery, no `/api/og/…` request reaches
`fetchMegaFile`. Write it as a skipped test at M.4 and unskip it at M.7, so it
cannot be forgotten. Enforceable only from rollout step M.7, when the server
decrypt path is removed; until then `ogBaseImageUrl` remains a live decryptor.
Record it and `ogBaseImageUrl`'s MEGA branch as named removals so they do not
survive the project. `/api/og/` itself survives — unencrypted providers still
need it; what goes is its reach into a decryptor.

**Reversal path.**
- Cheap: an owner opt-in, per-gallery "server-assisted preview card" — the
  server holds the key for OG only, decrypts one item, and edge-caches the
  card. This violates Tier 1 (cached card derives from plaintext) and Tier 2
  for that gallery, so it must be opt-in, listed in the exceptions table, and
  disclosed to the owner. Never default-on.
- Expensive: a rendering pipeline (dependency + fonts) as a separate project.

### D10 detail — published dimensions and content-version marker

**Decision.** Encrypted-source manifests carry owner-published, client-computed
`width`, `height`, and a content-version marker. They are server-visible.

**Dimensions cost nothing new.** `width` and `height` are already required on
`GalleryImage`, set by every scanner, and persisted into `images_json`, so
they are already in D1 and island props. This preserves the status quo. They
are also required: `image.width` drives the rendered frame, so the SSR shell
cannot hold geometry without them.

**Content-version marker.** It detects a replaced file under a stable image ID
(vault reuse is currently `priorImage.src === image.src`, a live stale-bytes
bug). MEGA listings carry size and timestamp, but unlike dimensions, raw size
and time would be **new** published metadata. Therefore:
- The client computes an opaque digest from (handle, size, timestamp, and other
  provider fields) and stores only the digest.
- It is compared for equality; the server cannot recover size or time from it.
- It is a change detector, not an integrity guarantee.

**Rules.**
1. Dimensions: integers ≥ 1, a per-side ceiling, and an aspect clamp (proposed
   1:10 to 10:1, tunable). The clamp is a placeholder: check it against real
   panoramas and the strip/fold layout before fixing numbers. A 1×10000 item
   must not wreck the layout.
2. Keep the 4:3 fallback when probing fails, so absent dimensions have a
   defined layout.
3. Stored dimensions describe layout aspect, not original resolution. For
   renderable formats the probe uses the preview rendition's dimensions and
   falls back to the original's head only for HEIC. Never advertise them as
   original size.
4. Validated dimensions are not a security boundary; section E4 still applies.

---

## E. Shared foundation (before touching providers)

### E1. Single URL helper
One helper builds and rewrites gallery URLs and always preserves `.hash`.
Lint-ban direct `history.replaceState/pushState` elsewhere. Audit: `?photo=`
stripping, `?next=` OAuth round trip, pending-source in localStorage, "Open
source" anchors, `og:url`, library cards, `galleryUrlFor()`, in-app browsers.
**Why.** A `replaceState` that rebuilds the URL without the hash silently locks
a gallery mid-session; a choke point beats scattered discipline.

### E2. Schema, identity, dedupe
- One migration adds `id` (random, immutable) and a manifest/`images_json`
  schema version.
- Source identity becomes `(provider, handle)` plus a separate access secret.
- `canonicalSourceMatches` for MEGA stops requiring key equality.
- Re-supplying a key for a known `(provider, handle)` updates the stored secret
  instead of returning 409.
**Why.** Dedupe requires matching keys today; a keyless stored URL would make
every revisit run a full scan and then fail on the unique index. There is no
schema marker, so a migration cannot tell old shapes from new.

### E3. Client media resolver and crypto worker
- Discriminated media reference (`http` | `encrypted`); key material never in
  item IDs or URLs.
- Web Worker (or native equivalent) for decrypt, with cancellation, request
  dedupe, explicit object-URL ownership and revocation.
- Byte-bounded in-memory working set, thumbnail-first loading, limited
  prefetch, separate concurrency limits for thumbnails and originals.
- Persistent plaintext only inside the encrypted vault (section H).
- Legacy manifests take the `http` branch of the discriminated reference. No
  parallel legacy viewer is built: an old-format item's `src` is already an
  http-path string, so it degrades into the existing branch until section I's
  conversion runs.
**Why.** The viewer can no longer assume every item is a fetchable URL; one
resolver serves viewer, rail, scan preview, and native clients. Naming the
legacy branch explicitly matters because the migration is reversible and
cohort-limited, so both manifest shapes coexist until M.7.

### E4. Manifest trust
Client-submitted manifests are untrusted. Enforce item caps, field lengths,
provider reference patterns, ownership checks, **URL scheme/host validation for
any field the server may later fetch**, and numeric rules: dimensions per D10,
content-version marker a fixed-length opaque string. Reject anything else.
**Why.** Manifests are server-generated today; moving scans to the client makes
every field attacker input, and the OG helper accepts any string starting with
`http`.

### E5. CSP and CORS
Spike first: can a gallery origin call the MEGA API and CDN directly? If yes,
relax `connect-src` narrowly and log it as a security-review item. If no, use
the relay (E6). **Why.** `connect-src 'self'` makes direct access impossible
today; CORS behaviour must be tested, not assumed.

### E6. Ciphertext relay (only if E5 requires it)
- Ciphertext only; accepts no key; re-resolves the upstream URL per request.
- Restrict hosts (maintained allowlist), methods, redirects, response sizes.
- Stream; never `arrayBuffer()` a full media response.
- No application/CDN caching; redact tokens and signed URLs from logs,
  including proxy-failure logging.
- Reuse the existing 16-byte CTR alignment logic for MEGA range reads; do not
  assume ciphertext ranges map to independently decryptable plaintext ranges.
- MEGA items stop being `<img>`-consumable: the relay returns ciphertext and
  the client resolver produces the displayable URL.
**Why.** The CTR alignment code already handles a subtle correctness issue;
rewriting it risks regressions. The allowlist is real maintenance because CDN
hosts rotate.

---

## F. MEGA

1. **Move to client:** link parsing, node-key and attribute decryption,
   folder/collection enumeration, titles, dimension discovery, preview and
   original decryption.
2. **SSR geometry.** Per D10, the SSR shell renders aspect-ratio frames from
   stored dimensions and unlocks media after hydration. Client scans compute
   dimensions (preview rendition first, original head for HEIC, 4:3
   fallback); the Worker no longer probes.
3. **Remove server plaintext paths:** `fetchMegaFile`, `fetchMegaPreview`,
   `previewCache`, server dimension probes, `k=` proxy URLs, and any SSR/OG
   decrypt of MEGA. **Only after** the client path and client dimension
   discovery ship (section M). **Why.** The admin rail depends on server
   previews and dimensions today.
4. **Integrity.** Research current MEGA MAC verification; implement for
   full-file retrieval; document partial-read limits; distinguish failed from
   unsupported verification. `c2pa: true` is not a verification claim.
   **Why.** The current adapter explicitly skips MAC checks.
5. **Acceptance.** No keys in backend requests or persisted records; no
   decrypted media on the server; Worker CPU/memory measured before and after;
   folders, collections, and nested folders still work.

---

## G. Ente (hosted public albums first)

1. **Spike** the current public-albums client/server code. Record the upstream
   commit and review licensing before reusing any code. Verify link formats,
   token/key separation, pagination, wrapped file keys, metadata and media
   framing, expiry, passwords, device limits, revocation, and browser/WebView
   CORS.
2. **Implement** client-side album/metadata/media decryption, thumbnails and
   originals, still images only. Defer video, Live Photos, self-hosted origins.
3. **Respect sharing controls:** expired/revoked links fail visibly; passwords
   prompted locally and never persisted; verify what "downloads disabled" means
   before surfacing download UI.
4. **Integrate across surfaces:** detection, quick-add, canonicalization,
   dedupe, scan preview, viewer, rail, refresh, errors, deep links, docs.
5. **Acceptance.** Accountless on a clean browser and supported native clients;
   tampered or truncated ciphertext fails safely; no server decrypt or
   plaintext cache; fixtures decrypt to matching bytes.
**Why Ente first, hosted only.** A single album key fits D1 naturally;
self-hosting adds arbitrary origins, an SSRF and compatibility surface that
should not block a first release.

---

## H. Native clients and the offline vault

### H1. Vault fill seam
`cache()` fetches `image.src` and writes the bytes. With keyless refs that
would store ciphertext and mislabel its MIME type. Required:
- Replace `offlineSourceFor` + `fetchImage(src)` with a `materialize(image)`
  step returning **plaintext bytes** for every provider.
- Wipe both ciphertext and plaintext buffers after the encrypted write (the
  existing `finally { bytes.fill(0) }` pattern is correct; keep it).
- Derive MIME from decrypted content or filename, not a ciphertext response
  header.

### H2. Reuse validator
Vault reuse requires an unchanged **content-version marker** (D10) in addition
to an unchanged reference. A mismatch refetches and rewrites the entry. This
also fixes the existing stale-bytes defect.

### H3. Manifest and validators
Vault metadata stores a **keyless** manifest. Update `isStillItem` /
`isManifest` for the new media-reference type, or every vaulted gallery reads
as corrupt. **Why.** The vault stores the whole manifest, srcs included.

### H4. Eager `open()`
`open()` mints an object URL for every vaulted image. Measure it (section K);
consider lazy materialization later, and do not change it without data.

### H5. Deep links and keys
Implement D7. Gallery links with fragments open the gallery; keyed quick-add
links keep working. With no key-store entry, show a locked state with a clear
message and never fall back to server decrypt. Document fragment visibility in
in-app browser URL bars, history, and Android recents.

---

## I. Migration (reversible)

1. New galleries use the new format.
2. The owner's client converts legacy MEGA records on first open.
3. **The server keeps legacy keys until the gallery has been opened and
   verified on two devices, or the owner explicitly opts out.**
4. Only then remove key-bearing fields and disable legacy decrypting endpoints.
5. Warn owners that deletion is irreversible, that historical logs and backups
   may retain keys, and recommend rotating share links.
**Why.** There is no schema version today, a lost device would otherwise lose
the only copy of the key, and key removal only works for owners who actually
open every gallery.

---

## J. iCloud originals

1. **Starting facts (verify against Apple documentation at implementation).**
   Legacy albums reduce photos to about 2048 px on the long edge; newer albums
   store full-resolution originals; upgrading an old album does not restore
   items already reduced. Original storage does not by itself prove anonymous
   byte-identical download.
2. **Read the full `icloud-shared.ts`**, the CloudKit scanner, tests, and media
   proxy routes; the earlier read was truncated.
3. **Fixture matrix** (rights-cleared): legacy; new-protocol; upgraded (old vs
   new items); edited photo; HEIC and JPEG; C2PA image; large panorama;
   video/Live Photo (later). Never upgrade a user's album automatically.
4. **Observe clean public access only.** No Apple login, no private-library
   scraping, no shared accounts.
5. **Verify bytes, not labels:** SHA-256, size, format, dimensions, EXIF/ICC,
   C2PA.
6. **Fidelity model per item:** `original | full-resolution-render |
   display-derivative | unknown`; thumbnail fidelity tracked separately.
   Refresh expiring signed URLs; never persist them indefinitely.
**Why.** A resolution match is not a byte match, and an edited render is not an
original; the label must reflect evidence.

---

## K. Vault efficacy test plan

**Question.** Does the vault measurably improve the experience compared with
streaming, without unacceptable cost?

**Design.** Vault off/on × cold/warm × (fast Wi-Fi, throttled, airplane mode);
same device, build, and gallery; randomized order; multiple runs per cell;
local-only instrumentation (no server telemetry).

| Metric | Why |
|---|---|
| Time to first thumbnail | Perceived open speed |
| Time to full image after tap/swipe; swipe latency p50/p95 | Main benefit; tails reveal stalls |
| `open()` time at 50 / 200 / 1,000 images | It materializes everything up front |
| `stream` policy behaviour | Existing complete copies stay available; new fills are skipped |
| Fill survives eviction | A fill larger than the cap evicts its own early entries; verify the post-write check |
| Stale reuse | Replace a photo under the same handle; vault must serve new bytes |
| Storage, battery, CPU, peak memory | Cost side |
| Correctness | SHA-256 of vaulted plaintext equals fixture bytes after a decrypt round trip |

Define pass thresholds before measuring; report cold and warm separately.

---

## L. Verification

- **Privacy canaries.** Synthetic keys and fixture images must never appear in
  server requests, D1, logs, analytics, error reports, native bridge messages,
  caches, or OG output for **encrypted sources**. The unencrypted-OG cache is a
  listed exception.
- **Architecture checks.** The server import graph never reaches decryption
  code; no module-level plaintext maps; no key-bearing URLs persisted; no
  third-party script on `/{owner}/{slug}`.
- **OG.** No `/api/og/…` request for an encrypted gallery reaches
  `fetchMegaFile` (skipped at M.4, enforced from M.7); `og:image:type` matches
  the asset; no `?i=`; the description contains the item count and, where set,
  the date.
- **Dimensions.** Reject zero, negative, non-integer, oversized, and
  extreme-aspect submissions; measure Cumulative Layout Shift on a cold load of
  an encrypted gallery to confirm published dimensions avoid reflow.
- **Viewer.** Web, Tauri, Capacitor; rapid navigation and cancellation; memory
  pressure; corrupt or truncated media; revoked or expired links; missing
  fragments; gallery delete → slug reuse → no inherited key.
- **Native.** A keyed gallery deep link opens the gallery; a keyless link shows
  the locked state; no silent fall-through.
- **Vault.** Stale-reuse case (replace a photo under the same handle).
- **Operational.** Worker CPU/memory before and after; client decrypt/decode
  latency; peak client memory; upstream request counts.
- **Independent review (HO1 or equivalent).** (1) Review the ADR before code.
  (2) Review the pinned commit and staging configuration with a verdict per
  invariant: demonstrated / contradicted / unverified. (3) Retest fixes.
  Authorized staging only; synthetic data; no attacks on third-party
  infrastructure; check the model provider's data-handling terms before sending
  private source.

---

## M. Rollout order

1. ADR approved; every V(ext) reference re-confirmed or corrected.
2. Foundation: URL helper, `id` + schema version, dedupe fix, key store.
3. Client resolver, crypto worker, client scan, manifest-submit create path,
   client dimension discovery.
4. Static OG for encrypted sources (D4). The bypass ships here, but
   `ogBaseImageUrl`'s decrypt path stays live until step 7.
5. MEGA client path for a limited cohort; reversible migration (section I).
6. Native: deep-link parser, selection type, key-store lookup, vault fill seam,
   validators. **Must precede step 7.** The native library renders the manifest
   inline (`native/islands/GalleryList.tsx`:811-812), so once the server
   decryptor is gone and the fragment channel is not yet built, encrypted
   galleries would be locked on native. If this step has to slip, native falls
   back to `Browser.open` for encrypted sources in the meantime.
7. Remove `previewCache`, server dimension probes, server plaintext endpoints,
   `ogBaseImageUrl`'s MEGA path, and the OG route's reach into a decryptor —
   **after** steps 5 and 6 are stable. The D4 acceptance test unskips here.
8. Ente hosted public albums.
9. iCloud originals for verified link/resource families only.
10. Later: Ente self-hosting, encrypted video, optional per-gallery rendered OG
    or the owner opt-in preview card.

**Why this order.** Removing the preview cache and server probes first would
break the admin rail, which depends on both. Rollback must never re-enable
server-side decryption silently; failure shows a clear temporary unsupported
state.

---

## N. Deliverables

ADR (D1-D10) signed off; reference table fully resolved; current-state audit;
resolver and crypto worker; refactored MEGA; Ente adapter; native and vault
changes plus efficacy report; iCloud findings with hashes and a capability
matrix; privacy, OG, dimension, and regression tests; before/after
measurements; updated public privacy wording that states exactly what is and is
not retained, including the shared preview image.