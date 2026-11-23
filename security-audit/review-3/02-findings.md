# Findings

Audited commit for every finding: `c7d8002c7ee1c6f446e619e85bd09dee543611c6`.
R3-01 was fixed at `e5385cabbc2d2fe37649025bd651d97b5e851d05` and re-verified
there; each finding carries its own status line.

Ranked by consequence. Nothing here is a remote-code or cross-account *read*
hole; the object-authorisation and SSRF surfaces held (see
`03-coverage-matrix.md`).

---

## R3-01 — A member's copy of an encrypted gallery is stored as manifest version 1 and renders blank for every visitor

**Class:** Verified defect (functional) · **Severity:** Medium · **CWE-684**
(Incorrect provision of specified functionality)
**Status:** **Fixed** at `e5385cabbc2d2fe37649025bd651d97b5e851d05`
(`feat/local-gallery-report-fixes`), re-verified; the fix is described below the
original evidence.

**Affected surface:** `POST /api/galleries/adopt` → the public gallery page of
the *new* row. Web, and any shell that renders the adopted row.

**Paths**

| Path | Lines | Role |
| --- | --- | --- |
| `app/api.ts` | 795-859 | The adopt handler. The create call at 826-835 passes `slug, title, caption, date, sourceUrl, createdAt, images` and **omits `manifestVersion`**. |
| `app/lib/gallery-repository.ts` | 171-183 | `recordToRow` writes `manifest_version: gallery.manifestVersion ?? 1`. |
| `app/lib/gallery-repository.ts` | 260-273 | The INSERT binds that default. |
| `packages/core/encrypted-source.ts` | 212-224 | `encryptedGalleryGate`: `client = viewerOwner \|\| keyRetiredAt \|\| manifestVersion === 2`. |
| `app/routes/[owner]/[slug].tsx` | 112-131 | `clientGate` decides `<EncryptedGallery>` vs `<Viewer>`. |
| `app/lib/encrypted-public.ts` | 14-20 | `stripLegacyDeliveryCapabilities` blanks `src` and keeps only `media`-bearing variants. |

**Prerequisite:** any signed-in member, one shared encrypted gallery
(MEGA/Ente/Proton), one tap on "Add to Library". No attacker.

**Input → impact.** The copy is *correct by construction*: it keeps the
encrypted items, whose `src` is `''` and whose `media` reference carries the
keyless identity. But the copy's row says `manifest_version = 1` and carries no
`key_retired_at`, so `encryptedGalleryGate` answers `client: false` for anyone
who is not the row's owner. The page then renders the **legacy** `Viewer`, whose
frame markup is built from `item.src` — which is empty — so the viewer emits only
the placeholder tile and never an `img.frame-img`. No resolver is mounted on
that path, so nothing can ever fill it.

- Owner of the copy: the client gate *is* taken (`viewerOwner`), the key store
  has no entry for the new gallery id and the URL carries no `#source=`, so
  `EncryptedGallery` shows its locked panel — "This device does not hold the
  gallery key. Paste the full Manorama link, or the original provider link."
  Recoverable, but a dead end on first open.
- Every visitor: placeholders forever, regardless of what the owner does, because
  the row's version never changes.

**Reproduction.** `security-audit/review-3/probe-adopt.test.ts`. It creates a
valid v2 MEGA manifest through `POST /api/galleries`, has a second account adopt
it, and then asserts the copy's gate inputs and the rendered page.

Observed at the pinned SHA:

```
(pass) the source really is a client-gated encrypted gallery
(fail) the adopted copy keeps the encrypted manifest's version and key facts
  { client: false, version: 1 }  !=  { client: true, version: 2 }
ADOPTED-COPY visitor frame-img src=null          # no frame image at all
```

**Fix applied** (`e5385cab`, four files, +12/−5). Both halves of the
recommendation, in one change:

| File | Change |
| --- | --- |
| `app/api.ts:842` | `manifestVersion: source.manifestVersion` on the adopt create. |
| `packages/core/encrypted-source.ts:212-229` | `encryptedGalleryGate` takes `images` and ORs in `manifestIsEncryptedSource({ images })`, so a row whose items carry keyless `media` refs takes the client path whatever its version column says. |
| `app/routes/[owner]/[slug].tsx:112-115` | Passes the row's images to the gate (the only caller that decides a render path). |
| `security-audit/review-3/probe-adopt.test.ts` | The legacy-path comment updated; the visitor-render assertion kept (the copy now SSRs the client shell, so the `<img class="frame-img">` still appears only after hydration). |

Re-verified at `e5385cab`:

```
(pass) the adopted copy keeps the encrypted manifest's version and key facts   # version 2, client true
(pass) the gate's item check > a v1 row with keyless refs takes the client gate
(pass) the gate's item check > a v1 row with server-proxied refs keeps the legacy path
40 pass / 0 fail   # all six probe files
```

The second gate test exists because the belt must not over-claim: a genuinely
legacy row (server-proxied `src`, no keyless refs) still renders through the
legacy path. The probe now pins both directions.

**Backfill.** None required. Rows adopted before the fix still carry
`manifest_version = 1`, and the route's item check is what puts them on the
client path at render time. A backfill would tidy the column but is not
load-bearing.

`POST /api/gallery/:owner/:slug` passes no `images` to the gate and is unaffected:
there, only `legacySourceUrl` is read from the result, never `client`
(`app/api.ts:346-353`).

**Sensitive assets affected.** None (availability / correctness). The key custody
is unaffected — the copy holds no secret the adopter did not already have.

**Existing tests.** `app/gallery-api.test.ts` exercises adopt with a
non-encrypted gallery; `app/encrypted-gallery-api.test.ts` exercises create,
refresh and migrate but not adopt. Nothing asserted the copy's
`manifestVersion`, which is why the gap survived; `probe-adopt.test.ts` now does.

**Recommended fix (narrow) — applied as written** at `e5385cab`.

```ts
const result = await createGalleryWithinLimit(session.accountId, {
  slug, title: source.title, caption: source.caption, date: source.date,
  sourceUrl: source.sourceUrl,
  manifestVersion: source.manifestVersion,   // ← the whole fix
  createdAt: new Date().toISOString(),
  images,
}, dbEnv(c))
```

Defence in depth, done in the same change: `encryptedGalleryGate` now also
consults `manifestIsEncryptedSource({ images })`, so a row whose items are
keyless media refs can never fall to the legacy path, whatever its version
column says.

**Regression test.** `probe-adopt.test.ts` asserts `manifestVersion === 2` and
`gate.client === true` for the adopted copy, and pins the gate's item check in
both directions (keyless refs → client, server-proxied refs → legacy). The SSR
assertion stays as it is: the client shell still emits only the placeholder at
SSR, because the resolver fills frames after hydration.

**Confidence:** high (executed). **Assumption:** the production rows for
encrypted galleries really do carry `manifest_version = 2` (they do for rows
created or migrated after M7; `POST /api/galleries` and `/refresh` both write it).

---

## R3-02 — Owner-private JSON declares no cache policy and varies only on `Origin`

**Class:** Hardening opportunity · **Severity:** Low · **CWE-525**
**Status:** **Fixed** at `626dd2fbac47ce0515b20b6ede0e61814aa00f70`
(`feat/local-gallery-report-fixes`), re-verified: `probe-cache.test.ts` now
asserts `private, no-store` on all four routes.

**Affected surface:** `GET /api/galleries`, `GET /api/library`,
`GET /api/account`, `GET /api/galleries/:slug`.

**Paths**

- `app/api.ts:233-272` — the `/api/*` group sets CORS, `Vary: Origin` and
  `X-Content-Type-Options`; no `Cache-Control`, no `Vary: Cookie`.
- `app/api.ts:597-621` — the two library reads.
- `app/api.ts:642-651`, `1174-1182` — the gallery summary and the account read.
- `app/lib/session.ts:271-275` — `privateNoStore` exists and is applied to
  `/api/devices`, `/api/device-galleries` only
  (`app/device-api.ts:18-19`, `app/device-gallery-api.ts:15-16`).

**Recorded before the fix (pinned SHA)** (`probe-cache.test.ts`):

```
HEADERS /api/galleries              cache-control=(none) vary=Origin etag=(none)
HEADERS /api/library               cache-control=(none) vary=Origin etag=(none)
HEADERS /api/account               cache-control=(none) vary=Origin etag=(none)
HEADERS /api/galleries/:slug       cache-control=(none) vary=Origin etag=(none)
```

Every one of them is authenticated *and* carries `sourceUrl` — the gallery's only
capability. Because the cache key is the URL, not the cookie, a shared browser
profile that signs out of one account and into another is free to reuse the
first account's `/api/library` response for the same URL, including the second
account's *absence* of those galleries and the first account's share links.

**Preconditions and honesty about severity.** Browsers with no validator and no
explicit freshness usually revalidate by re-fetching, so in practice the stale
window is short and often zero. This is a missing declaration, not a
demonstrated leak; the probe records headers, it does not reproduce a cache hit.

**Fix applied** at `626dd2fb`: `privateNoStore` is composed ahead of
`requireSession` on the `/api/galleries`, `/api/library` and `/api/account`
groups (`app/api.ts:498-502`), so every session-gated response now carries
`Cache-Control: private, no-store`. The public manifest
(`/api/gallery/:owner/:slug`) is untouched and stays cacheable — it carries no
capability.

**Regression test.** `probe-cache.test.ts` now asserts `private` and `no-store`
on all four routes; the pinned run above is kept as the before-evidence.

**Confidence:** high for the header facts, medium for the user-visible impact.

---

## R3-03 — Privacy text understates on-device storage: the desktop vault, and video caching

**Class:** Product/privacy-policy discrepancy (implementation is *stronger* than
the text, and different) · **Severity:** Informational
**Status:** **Fixed** at `1aefd3da3a96cc850ff015ce051f2dad64aa5de2`
(`feat/local-gallery-report-fixes`): both the markdown source and the rendered
`/privacy` copy now describe the desktop vault and video caching as built.

**Paths**

- `docs/privacy-policy.md:43` — "The desktop app … **does not provide the mobile
  cloud-gallery encrypted-vault guarantee.**"
  The desktop ships `desktop/lib/vault.ts` (an `EncryptedVault` over the shell's
  `vault_read`/`vault_write` commands), `desktop/lib/offline-gallery.ts`, and the
  Rust/Swift implementations behind them
  (`src-tauri/src/lib.rs:137-338`, `macos/ManoramaMac/NativeBridge.swift:394-450`).
  Both shells use the same vault directory and the same Keychain service.
- `docs/privacy-policy.md:39` — "Galleries that include video are **not cached
  for offline use today.**"
  `native/lib/offline-gallery.ts:652-689` writes a video's poster *and* its MP4
  into the vault (subject to the single-entry cap), and the privacy text two
  sentences earlier already says a cached image "is either the source's own bytes
  or a smaller version the source provides".
- The same two sentences are duplicated in `packages/core/privacy-policy.ts:163-185`,
  which is what the `/privacy` route renders, so the drift is in what users read.

**Why it matters.** Not a privacy over-claim, but the policy is the document a
store reviewer and a user read to decide what is on the device. A desktop user is
told they do not have the vault they do have; a mobile user is told their videos
are not kept offline when they are. Both are the kind of sentence that becomes
wrong silently as features land.

**Fix applied** at `1aefd3da`, in both places the text lives:
`docs/privacy-policy.md:39,43` and `packages/core/privacy-policy.ts:169,185`.
The video sentence now reads "Galleries that include video are cached as well: a
video keeps its poster image and, when the clip fits within a single vault
entry, the clip itself", and the desktop paragraph now states that the desktop
keeps the same encrypted vault as the mobile app, with keys in the device's
credential store. Both statements match `native/lib/offline-gallery.ts:652-689`
and `desktop/islands/Catalogue.tsx:2890` (`desktopOfflineStore.cache`).

**Regression test.** None added; the repository still has no test tying policy
text to capability. A one-line assertion that the rendered `/privacy` copy
mentions the desktop vault would pin it.

**Confidence:** high (code read; the desktop vault is exercised by
`desktop/lib/vault.roundtrip.test.ts`).

---

## R3-04 — Two routes buffer an unbounded request body

**Class:** Hardening opportunity · **Severity:** Low · **CWE-770**
**Status:** **Fixed** at `626dd2fbac47ce0515b20b6ede0e61814aa00f70`
(`feat/local-gallery-report-fixes`), re-verified: `probe-body.test.ts` asserts
413 outside the 8 KB bound on both routes.

**Paths**

- `app/api.ts:278-296` — `POST /api/auth/native/exchange`: **unauthenticated**,
  no `bodyLimit`, `await c.req.json()` before the token is even inspected.
- `app/api.ts:653-663` — `POST /api/galleries/scan`: authenticated, no
  `bodyLimit`.
- Contrast: `app/api.ts:300` (the desktop twin, 8 KB), `515` and `567` (4 KB),
  `627` (64 KB), `665`, `993`, `1028`, `1077` (8–16 MB).

Measured before the fix (`probe-body.test.ts`):

```
(pass) a route with bodyLimit refuses an oversized body with 413     # desktop exchange, 9 KB
(pass) the native exchange has no bound                              # 4 MB parsed, then 401
(pass) the scan endpoint has no bound                                # 2 MB parsed, then 422
```

**Input → impact.** An anonymous caller chooses the JSON parser's working set,
bounded only by Cloudflare's 100 MB request cap and the isolate's 128 MB. One
large request is not an outage; a handful in one isolate is memory pressure
shared with every other request it serves. The scan route also parses before it
looks at the link.

**Fix applied** at `626dd2fb`: `bodyLimit({ maxSize: 8 * 1024 })` on
`/api/auth/native/exchange` (`app/api.ts:289`) and on `/api/galleries/scan`
(`app/api.ts:666`). Both bodies are a token plus a URL, so 8 KB is generous.

**Regression test.** `probe-body.test.ts` now asserts 413 outside the bound on
both routes, and that a body *inside* it still reaches the handler (401 on a
malformed token, 400/422 on an unrecognised link) — a bound that swallowed real
requests would fail the second half.

**Confidence:** high (executed).

---

## Checked, and held (evidence in `03-coverage-matrix.md`)

- Cross-owner mutation on eight routes; hidden-item visibility; the public
  manifest's omission of `sourceUrl`; pipeline read-only and expiry semantics.
- Provider URL canonicalisation, including lookalike hosts, userinfo tricks and
  the Google Photos `?u=` fetcher.
- SSR escaping of title, caption, alt and OG metadata; the quick-add path.
- The shipped macOS boundary suite (media resolution, grants, capabilities,
  OAuth loopback, invoke replies, deep-link bookkeeping): `ALL PASS`.
- Billing webhook verification, replay ordering and the `setUserTier` batch,
  through the repository's own tests, which pass at this SHA.
