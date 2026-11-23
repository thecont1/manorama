# Findings

Audited commit for every finding: `c7d8002c7ee1c6f446e619e85bd09dee543611c6`.

Ranked by consequence. Nothing here is a remote-code or cross-account *read*
hole; the object-authorisation and SSRF surfaces held (see
`03-coverage-matrix.md`).

---

## R3-01 — A member's copy of an encrypted gallery is stored as manifest version 1 and renders blank for every visitor

**Class:** Verified defect (functional) · **Severity:** Medium · **CWE-684**
(Incorrect provision of specified functionality)

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

Observed at this SHA:

```
(pass) the source really is a client-gated encrypted gallery
(fail) the adopted copy keeps the encrypted manifest's version and key facts
  { client: false, version: 1 }  !=  { client: true, version: 2 }
ADOPTED-COPY visitor frame-img src=null          # no frame image at all
```

**Sensitive assets affected.** None (availability / correctness). The key custody
is unaffected — the copy holds no secret the adopter did not already have.

**Existing tests.** `app/gallery-api.test.ts` exercises adopt with a
non-encrypted gallery; `app/encrypted-gallery-api.test.ts` exercises create,
refresh and migrate but not adopt. Nothing asserts the copy's `manifestVersion`,
which is why the gap survived.

**Recommended fix (narrow).**

```ts
const result = await createGalleryWithinLimit(session.accountId, {
  slug, title: source.title, caption: source.caption, date: source.date,
  sourceUrl: source.sourceUrl,
  manifestVersion: source.manifestVersion,   // ← the whole fix
  createdAt: new Date().toISOString(),
  images,
}, dbEnv(c))
```

Defence in depth, worth doing in the same change: `encryptedGalleryGate` could
also consult `manifestIsEncryptedSource({ sourceUrl, images })` (already exported
by the same module and unused by these routes) so a row whose items are keyless
media refs can never fall to the legacy path, whatever its version column says.

**Regression test.** Adopt a v2 encrypted gallery and assert
`manifestVersion === 2`, `gate.client === true`, and that the SSR of the copy
contains a `frame-img` (or the encrypted island), not a lone placeholder.

**Confidence:** high (executed). **Assumption:** the production rows for
encrypted galleries really do carry `manifest_version = 2` (they do for rows
created or migrated after M7; `POST /api/galleries` and `/refresh` both write it).

---

## R3-02 — Owner-private JSON declares no cache policy and varies only on `Origin`

**Class:** Hardening opportunity · **Severity:** Low · **CWE-525**

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

**Recorded at this SHA** (`probe-cache.test.ts`):

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

**Recommended fix.** Apply the existing `privateNoStore` to the four routes
(it is already written and used for exactly this class of response), or add
`Cache-Control: private, no-store` in the `/api/*` middleware for anything
behind `requireSession`. The public manifest may stay cacheable.

**Regression test.** Assert `cache-control` contains `private` on the four
endpoints; extend `probe-cache.test.ts`.

**Confidence:** high for the header facts, medium for the user-visible impact.

---

## R3-03 — Privacy text understates on-device storage: the desktop vault, and video caching

**Class:** Product/privacy-policy discrepancy (implementation is *stronger* than
the text, and different) · **Severity:** Informational

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

**Recommended fix.** Rewrite those two paragraphs against the code: the desktop
does have an encrypted vault with the same custody model, and video bytes are
cached when they fit in one vault entry. **Regression test:** the repository has
no test tying policy text to capability; a small assertion that
`privacy-policy.ts` mentions the desktop vault would at least pin the sentence.

**Confidence:** high (code read; the desktop vault is exercised by
`desktop/lib/vault.roundtrip.test.ts`).

---

## R3-04 — Two routes buffer an unbounded request body

**Class:** Hardening opportunity · **Severity:** Low · **CWE-770**

**Paths**

- `app/api.ts:278-296` — `POST /api/auth/native/exchange`: **unauthenticated**,
  no `bodyLimit`, `await c.req.json()` before the token is even inspected.
- `app/api.ts:653-663` — `POST /api/galleries/scan`: authenticated, no
  `bodyLimit`.
- Contrast: `app/api.ts:300` (the desktop twin, 8 KB), `515` and `567` (4 KB),
  `627` (64 KB), `665`, `993`, `1028`, `1077` (8–16 MB).

Measured (`probe-body.test.ts`):

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

**Recommended fix.** `bodyLimit({ maxSize: 8 * 1024 })` on the native exchange
(its body is one 60-second JWT) and `bodyLimit({ maxSize: 8 * 1024 })` on scan
(the URL plus optional order/title). Reuse the constants already in the file.

**Regression test.** Extend `probe-body.test.ts`: both routes answer 413 for an
oversized body.

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
