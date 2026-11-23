# Remediation sequence

Ordered by consequence, with the dependencies that actually bind.
Status as of `d5ee928e` on `feat/local-gallery-report-fixes`: all four findings
are closed.

## 1. Done

**R3-01 — carry `manifestVersion` through adopt. Fixed at `e5385cab`.**
The adopt create now passes `source.manifestVersion`, and `encryptedGalleryGate`
also consults the row's items (`manifestIsEncryptedSource`), so a row that lost
its version — including every copy adopted before the fix — still renders through
the client path. `app/routes/[owner]/[slug].tsx` hands the gate the images; the
only other gate caller (`/api/gallery/:owner/:slug`) reads just
`legacySourceUrl` and needed no change.

No backfill is load-bearing. The column stays `1` on rows adopted before the fix
and the item check covers them at render time; a one-off
`UPDATE galleries SET manifest_version = 2 WHERE …` would only tidy the column.

Verified: `probe-adopt.test.ts` 5/5, including the gate's item check in both
directions; the whole probe set is 40/40 at `d5ee928e`.

## 2. Done

**R3-02 — declare a cache policy on authenticated JSON. Fixed at `626dd2fb`.**
`privateNoStore` is chained onto each session-gated prefix ahead of
`requireSession`, so every `/api/galleries`, `/api/library` and `/api/account`
response — rejections included — answers `Cache-Control: private, no-store`.
The public manifest keeps its cacheable path. `probe-cache.test.ts` asserts the
header on all four routes.

**R3-04 — bound the two unbounded bodies. Fixed at `626dd2fb`.**
`bodyLimit({ maxSize: 8 * 1024 })` on `/api/auth/native/exchange` and on
`/api/galleries/scan`, matching the desktop exchange's precedent.
`probe-body.test.ts` asserts 413 outside the bound and that a body inside it
still reaches the handler's own refusal.

## 3. Done

**R3-03 — bring the privacy text up to the code. Fixed at `1aefd3da`.**
`docs/privacy-policy.md` and `packages/core/privacy-policy.ts` were edited
together: the desktop vault is described as built (same custody model, keys in
the device credential store) and video caching is described honestly (poster,
plus the clip when it fits one vault entry). No pin test was added — the claim
list would drift the same way the text did.

## Dependencies and non-dependencies

- R3-02 and R3-04 both touched `app/api.ts` and landed in one change.
- Nothing depended on anything else; all four landed independently.

## What this pass would look at next

1. A live-provider round trip for the redirect-following question under §C: the
   Worker's `fetch` follows provider redirects without re-applying the host
   allowlist to the final URL. That is almost certainly intended (the provider
   is the one issuing the redirect) but it is unverified.
2. The island serialisation path at runtime: build, serve, and assert that a
   title containing `</script>` still hydrates.
3. The Tauri build executed, not read — the scope semantics of an empty
   `plugins.fs.scope` are the one assumption in `capabilities/default.json`
   that this pass could not test.
