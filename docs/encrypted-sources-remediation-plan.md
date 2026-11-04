# Encrypted sources — remediation plan for the HO1 review of PR #168

Source review: independent privacy audit of `88ad5fc` against
`docs/encrypted-sources-and-original-media-fidelity.md`. Finding IDs (F1–F8, H1–H4) are
stable references into that report; each task below names the one it closes.

Baseline: no invariant was contradicted. Tier 1, Tier 2 for new/migrated galleries, the
canary set, and the vault-at-rest rule all held under falsification. What follows is the
seam work: a stale public policy, silent image loss on retirement, an uncompared native
fragment, a dev seed that deleted the only end-to-end coverage, and guards that do not guard
what they are named for.

## Goal

Make every finding either fixed or explicitly dispositioned, and leave a canary suite in CI
that fails if the privacy boundary regresses. No new provider surface: MEGA only, Ente still
deferred to M8.

## Ground rules

- One concern per commit; the branch stays `feat/encrypted-sources-media-fidelity` for phases
  0–5, with phase 6+ on `fix/encrypted-*` branches if review wants them separated. Never mix
  a wording change with a behaviour change in one commit.
- Do **not** run a remote D1 migration, `wrangler deploy`, force-push, or delete a branch.
  Prepare and hand over.
- Definition of done per task: `bunx tsc --noEmit` clean, the task's new test red-then-green,
  `bun run test:unit` green, and — for anything touching the viewer or a gallery route — the
  Playwright matrix green at 375×812, 1440×900, 2560×1440.
- Files owned by another open issue are read-only; comment instead of reaching across.
  `app/islands/Viewer.tsx` is the shared hot spot — phases 2 and 7 touch it and nothing else
  should.

## Current state of the suite

`app/encrypted-privacy-audit.test.ts` (untracked, 30 tests) is the audit harness. Two of its
tests fail on this commit **by design** and are the acceptance gate for phases 1 and 5:

    bun run test:unit -- app/encrypted-privacy-audit.test.ts
    # today: 29 pass, 1 fail (policy wording) + F1 seam documented

Full suite today: 1622 pass, 1 fail (that policy test). Land the file in phase 0 so the
remaining work is visible in CI, and do not loosen either failing assertion to get green.

---

## Phase 0 — land the canary suite (F-canary)

### Task 0.1: rename and place the audit harness

- Move `app/encrypted-privacy-audit.test.ts` → `app/encrypted-privacy-canary.test.ts`.
- Rewrite the header comment to state the contract: this file is the §L canary gate; a
  failure here is a privacy regression, not a flake.
- Keep the F1/F2 assertions failing until their phases land. Note them in the PR body as
  "expected red, closed by tasks 1.1 and 5.1".

Verify: `bun run test:unit -- app/encrypted-privacy-canary.test.ts` → 29 pass, 1 fail.

### Task 0.2: make the canary a declared gate

- Add the file to the list of gates in `VERIFICATION.md` under a new "Privacy canaries
  (encrypted sources)" heading, with the exact command above.
- Cross-reference it from `AGENTS.md` §4 so nobody deletes it as duplication.

Commit: `test(encrypted): land privacy canary suite as a declared gate`

---

## Phase 1 — restore end-to-end coverage (F1)

The dev seed calls the server scanner, which now always throws for MEGA, so
`MANORAMA_DEV_SOURCE_MEGA` seeds nothing and every spec naming `dev-mega` 404s. This is the
reason the feature has zero browser coverage.

### Task 1.1: seed the MEGA slot from the client scanner

- Modify `vite.config.ts:114-127`. Branch on the URL shape; call the client scanner through
  `ssrLoadModule`, exactly as the existing code loads `sources.ts`:

```ts
const clientScan = async (url: string) => {
  if (/\/file\//i.test(new URL(url).pathname)) throw new Error('Use a public MEGA folder or collection link')
  const { scanMegaSource } = await server.ssrLoadModule('/app/lib/mega-client.ts') as
    typeof import('./app/lib/mega-client')
  return scanMegaSource(url)
}
// inside the map, replacing the single call site:
const scan = isEncryptedSourceUrl(url) ? await clientScan(url) : await sources!.scanSource(url, process.env)
```

- Stamp `manifestVersion: isEncryptedSourceUrl(url) ? 2 : 1` on the seeded record at
  `vite.config.ts:136-147`, or the gallery renders through the legacy gate.
- Import `isEncryptedSourceUrl` from `./packages/core/encrypted-source` at the top of the
  config.

Verify: with `MANORAMA_DEV_SOURCE_MEGA` set, `bun run dev` logs
`[dev-seed] live scan: N items (0 video) → dev-mega`; opening
`http://localhost:5173/thecontrarian/dev-mega?…` shows photographs resolved as `blob:` URLs
and the network panel shows **no** `/api/mega/file` or `/api/mega/preview` request. Without
the env var, the warning path is unchanged.

### Task 1.2: a network-free encrypted fixture

The live slot is env-gated, so CI still has no encrypted coverage on a bare checkout.

- Extend `/.dev-seed/spawn` (`vite.config.ts:359-390`) with an `encrypted: true` mode that
  stamps `manifestVersion: 2` and items whose `media` is a synthetic
  `{kind:'encrypted', provider:'mega', sourceKind:'folder', sourceId:'DevSeedFolder', nodeId}`
  with `src: ''`.
- Spawned encrypted galleries need no provider call for the locked path; use that in phase 8.

Verify: `POST /.dev-seed/spawn {"encrypted":true}` then GET the returned slug as a visitor →
locked panel, `200`, no outbound request.

Commit: `fix(dev-seed): scan MEGA on the client and add an encrypted spawn fixture`

---

## Phase 2 — stop silent data loss on retirement (F3)

`POST /api/galleries/:slug/migrate` rewrites `images` from the submitted manifest and retires
the key in the same request; a probe-budget or cap truncation therefore deletes the tail
permanently. `refresh` may stay permissive (its tail can be re-added later), `migrate` may
not.

### Task 2.1: failing test

Add to `app/encrypted-gallery-api.test.ts`:

```ts
test('migrate refuses a truncated manifest', async () => {
  // seed two items, post a one-item manifest with truncated: 40
  expect(response.status).toBe(422)
  expect((await response.json() as any).code).toBe('PARTIAL_SCAN')
  expect((await getGallery(TEST_OWNER.accountId, 'legacy-mega'))?.images).toHaveLength(2)
  expect((await getGallery(TEST_OWNER.accountId, 'legacy-mega'))?.keyRetiredAt).toBeNull()
})
```

Run: expect 200 today.

### Task 2.2: implement the guard

In `app/api.ts`, immediately after `validateEncryptedManifest(payload.manifest)` in the
migrate handler (~:860), before any write:

```ts
// A truncated listing would silently delete the items the scan never reached,
// and the key retires in the same request — there is no second chance.
if (submitted.truncated !== undefined) {
  return c.json({ code: 'PARTIAL_SCAN', error: 'That folder could not be read completely — try again before removing the server key' }, 422)
}
```

`truncated` is only ever set when the listing was cut (`mega-client.ts:387,443`), so its
presence is the partial signal.

### Task 2.3: surface it

`app/islands/EncryptedGallery.tsx:submitMigration` already renders a thrown error into the
migration note; extend the note for `PARTIAL_SCAN` so the owner is not told "this device could
not be verified" when the device was fine.

Commit: `fix(encrypted): refuse a truncated manifest when retiring the server key`

---

## Phase 3 — native custody correctness (F4, F5)

### Task 3.1: compare the fragment before adopting a key (F4)

- `native/lib/offline-gallery.ts:152-155` (`openNativeEncryptedSession`): accept a
  `compareWith?: string` option; when set, reject with a new
  `EncryptedSourceMismatchError` unless `keylessSourceUrl(source) === keylessSourceUrl(compareWith)`.
- `native/lib/offline-gallery.ts:664-666`: pass `gallery.manifest.sourceUrl` as
  `compareWith`.
- `native/islands/GalleryList.tsx:363-368`: only `persistEncryptedSourceForSelection` after
  the compare passes — move the persist inside the open, or re-read through the store.

Test, in `native/lib/offline-encrypted-network.test.ts` style: a selection whose `sourceUrl`
names `OTHERALBUM` against a manifest whose `sourceUrl` is `REALALBUM` now rejects and does
not persist. `app/encrypted-privacy-canary.test.ts` "F4: the native deep link trusts the
fragment…" is the seam test — update it to assert the reject once the guard exists.

### Task 3.2: keep the key on the web handoff (F5)

`native/islands/GalleryList.tsx:433` and `:508` build the external URL without the fragment
even when the device holds the key.

```ts
const externalUrl = async () => {
  const hash = selection.galleryId
    ? await resolveEncryptedSourceForSelection(selection.galleryId).then((s) => s && selection.galleryId ? galleryHashForSource(s, selection.galleryId) : '')
    : ''
  return `${normalizeApiBase(base)}/${encodeURIComponent(selection.owner)}/${encodeURIComponent(selection.slug)}${hash}`
}
```

Test: stub `Browser.open`, assert the captured URL contains `#source=` when the key store has
an entry, and does not when it does not.

Commit: `fix(native): compare the deep-link fragment and keep the key on the web handoff`

---

## Phase 4 — guards that actually guard (F6)

### Task 4.1: fix the false comment

`app/lib/sources.ts:174-178` still says MEGA matching requires the access key. Rewrite to
"identity is (kind, handle); the access secret is separate and is not compared".

### Task 4.2: collapse the duplicated decryptor

`app/lib/mega-public.ts` is a near-verbatim copy of `app/lib/mega-client.ts`, kept alive only
for the 410-gated endpoints. Two copies will drift.

- Point `app/api.ts` at `./lib/mega-client` and delete `app/lib/mega-public.ts`.
- `mega-client.ts` feature-detects `Worker` (`mega-decrypt.ts:7`), so it loads in the Worker
  without a browser.
- Grep for remaining importers first: `search_files("from './mega-public'")`.

If review prefers to defer the deletion, the fallback is a symbol-parity test asserting both
modules export the same names; do not leave it unguarded either way.

### Task 4.3: make the arch test mean what it says

`app/encrypted-architecture.test.ts:23-25` checks one import edge. Replace with a check over
the whole Worker surface: `app/api.ts`, `app/server.ts`, every `app/routes/**`, every
`app/lib/**` except `mega-client|mega-crypto|mega-decrypt`, asserting none imports a
decryptor; and assert `app/api.ts` imports exactly one decryptor module (the switch
implementation), so a second copy cannot reappear unnoticed.

Commit: `refactor(encrypted): single Worker decryptor and a real import-graph guard`

---

## Phase 5 — public wording (F2)

### Task 5.1: rewrite the shipped policy

`packages/core/privacy-policy.ts:120` is the *shipped* model (web `/privacy`, native Privacy
view); only `docs/privacy-policy.md` was updated. Replace the paragraph with the fragment
explanation, the shared-static-card statement, and the legacy exception, all three verbatim
from `docs/privacy-policy.md` where they already exist. Bump `updated` at :49.

### Task 5.2: same correction in the manifest

`ios/App/App/PrivacyInfo.xcprivacy:63` (purpose string) and `:77-78` (comment) both describe
the retired preview cache.

### Task 5.3: parity test

So the two documents cannot drift again: parse the paragraph sets of `docs/privacy-policy.md`
and `PRIVACY_POLICY`, normalise whitespace and smart quotes, and assert equality. Assert the
inverse of the current canary too (no `in-memory cache`, has `fragment`, has
`static social preview image`, has `second device`).

`app/encrypted-privacy-canary.test.ts` "F2/F3 regressions: … shipped policy wording" goes
green here.

### Task 5.4: owner sign-off

Public wording, so Mahesh reviews the diff before the branch moves. Decide one thing first —
see Decisions.

Commit: `docs(privacy): state fragment custody, the shared card, and the legacy exception`

---

## Phase 6 — configuration and limits (F7, F8)

### Task 6.1: make the kill switch configurable (F7)

`LEGACY_ENCRYPTED_DECRYPT` exists only in prose. Add an `[env.staging]` block to
`wrangler.toml` carrying the same D1 binding and `LEGACY_ENCRYPTED_DECRYPT = "enabled"`, and
document the var (commented, both values explained) in `.env.example`. Production stays
without it so the default remains retired.

### Task 6.2: bound the manifest body and the row (F8)

- `bodyLimit({ maxSize: 8 * 1024 * 1024 })` on `POST /api/galleries`, `/refresh`, `/migrate`.
- Before insert, reject `JSON.stringify(orderedImages).length > 1_800_000` with
  `code: 'MANIFEST_TOO_LARGE'` — D1's row ceiling is the real constraint and the 1,000-item
  cap alone allows ~33 MB of worst-case exif/placeholder.

Test: a synthetic 1,000-item manifest with 16 KB `exif` on each → 422 with that code, not a
D1 error.

Commit: `fix(api): bound manifest bodies and refuse rows past the D1 limit`

---

## Phase 7 — client robustness (H3, H4)

Advisory, but cheap and both are user-visible.

- H3: `app/lib/encrypted-resolver.ts:102-105` — before `this.entries.delete(key)`, confirm
  the map still holds *this* entry (`if (this.entries.get(key) === entry) …`). Test: abort,
  re-acquire the same reference, assert a fresh fetch rather than the stale rejection.
- H4: `app/quickadd.ts:190` and `app/islands/Admin.tsx:626-629` — wrap the key-store write so
  a storage failure (quota, private mode) degrades to a warning and never swallows a
  successful create. Test: a throwing `Storage`, assert `location.replace` still fires.

Commit: `fix(encrypted): guard the resolver cache and survive a failed key write`

---

## Phase 8 — browser coverage and handover

### Task 8.1: locked-path spec

New `specs/encrypted-gallery.playwright.ts`, seeded from task 1.2's spawn fixture, across the
three matrix viewports:

- `og:image` is `/og-image.png`, `og:image:type` is `image/png`, `og:url` has no query.
- No `k=` and no `#` key material anywhere in the document.
- No request to `/api/mega/*` (route-intercepted and asserted empty).
- The locked panel renders, is announced, and accepts a pasted full link which becomes the
  document fragment.
- A v2 gallery's SSR frames carry the stored aspect ratio (CLS check per §L).

### Task 8.2: evidence

Six-state captures per `AGENTS.md` for iOS/iPad/macOS after phase 3, reviewed before commit.
Refresh `docs/encrypted-sources-current-state.md` with the phase 5 wording and the phase 6
config.

### Task 8.3: follow-up tickets (open, do not implement here)

1. MEGA MAC verification for full-file retrieval; document the partial-read limit (§F4).
2. `*.userstorage.mega.co.nz` allowlist maintenance: hosts rotate, and no host in that suffix
   resolves from this network, so the CSP line is currently unproven.
3. H1 — the client scan inherits the Worker's 950-subrequest budget
   (`mega-client.ts:384,436`); measure a 300+ item folder and set a browser-appropriate limit.
4. Cohort close: delete `LEGACY_ENCRYPTED_DECRYPT`, `app/lib/mega-public.ts` (if not already
   gone), and the two legacy exceptions from the policy.

---

## Decisions needed before phase 5

1. **Staging posture.** Keep the kill switch on in staging for the cohort migration (planned
   above), or run staging retired and use production as the cohort? The first is what the ADR
   implies; the second makes staging a better canary for M7.
2. **Policy wording strength.** "Our server never receives the key" is true for new and
   migrated galleries and false until a legacy gallery is migrated. Keep the qualified form
   (recommended, already drafted in `docs/privacy-policy.md`) or state it unqualified with the
   exception in a following paragraph.
3. **Owner props trade.** Owners of unretired galleries receive `legacySourceUrl` in island
   props, so the key rides their HTML. Accept (recommended — it is what makes the migration
   call possible) or gate it behind the fragment only and require a paste.
4. **`dev-mega` strategy.** Keep the env-gated live slot plus the spawn fixture (recommended),
   or replace the live slot entirely so CI depends on no third-party share.

## Risks

- Phase 1.1 puts a network scan back in the dev boot path. It is already how every other
  provider seeds, and the existing 4-second budget and try/catch bound it, but a MEGA outage
  will slow boot — verify the failure is still a warning, not a hang.
- Phase 4.2 touches the 410-gated path that the cohort migration depends on. Prove it with
  the existing `SERVER_DECRYPT_RETIRED` test plus one live decrypt against a real share
  before deleting the copy.
- Phase 6.2 adds a hard ceiling; a legitimate 1,000-item gallery with heavy captions could
  reach it. The 1.8 MB figure leaves ~10% headroom under D1's ~2 MB row limit — confirm
  against a real insert, not the in-memory repository.
- Every phase touches files the review already read. Rebase before starting and re-run the
  canary after each rebase, or a silent revert of a landed fix will read as a new failure.

## Dispositions

Executed on `feat/encrypted-sources-media-fidelity` (PR #168), one concern per commit:

| Phase | Commit | Outcome |
|---|---|---|
| 0 | `851e2ce` | Canary suite landed as declared gate (AGENTS.md §4, VERIFICATION.md) |
| 1 | `4d889b2` | Dev seed scans MEGA client-side; encrypted spawn fixture; live 69-item scan verified |
| 2 | `9672347` | Truncated manifest refused — `PARTIAL_SCAN` 422 |
| 3 | `503cadc` | Native deep-link source-identity compare; key preserved on web handoff |
| 4 | `f635761` | Single Worker decryptor (`mega-public.ts` deleted) + import-graph guard |
| 5 | `5a4db92`, `cabda7b`, `4be2d93` | Shipped policy + docs parity; retirement paths stated accurately |
| 6 | `a109939` | Staging retired (M7 canary); 8 MiB bodies; `MANIFEST_TOO_LARGE` 422 |
| — | `5ac6f92` | Operator cohort script → reviewable SQL (key-bearing guard documented, `out/` git-ignored) |
| 7 | `5c31c82` | Resolver cache eviction; key-write failure survives create |
| 8 | `ae904f5` | Locked-path spec ×3 viewports; curtain dead-end fixed; current-state refreshed |

Post-audit review rounds: `88ad5fc` (15 findings), `ac5a77b` (9 findings), `5be860b` (flaky delete-account purge), `f56e457` (custody + CAS). Independent audit of `f56e457`: all eight findings verified closed. Auditor follow-ups: N1 (statement ceiling → conditional guard + documented trade), N2 (literal backtick → `code('#')`), N3 (CAS unit test), N4/N5 (keyed-open spec, matching-folder paste), N6 (import extension), N7 → issue #173.
