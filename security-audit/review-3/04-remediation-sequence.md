# Remediation sequence

Ordered by consequence, with the dependencies that actually bind.

## 1. Before the next native build goes out

**R3-01 — carry `manifestVersion` through adopt.**
One argument in `app/api.ts` (the adopt handler's `createGalleryWithinLimit`
call) plus one regression test. Nothing depends on it; it is independent of
everything else here. Do it with the defensive gate change
(`manifestIsEncryptedSource` in `encryptedGalleryGate`) if the change is being
made anyway — the gate change alone would fix new copies but leave existing
rows dark, so a backfill (`UPDATE galleries SET manifest_version = 2 WHERE …`
for rows whose items are encrypted refs) is the only way to repair rows already
adopted. Backfill is a data change: prepare it, do not run it here.

**R3-02 — declare a cache policy on authenticated JSON.**
Two lines if the middleware is used (`Cache-Control: private, no-store` for
anything behind `requireSession`), or four route-level calls to the existing
`privateNoStore`. Independent of R3-01. No backfill.

## 2. Next hardening pass

**R3-04 — bound the two unbounded bodies.**
Independent, small, and lower value than the two above. Pairs naturally with any
work that touches the API group's middleware, since the alternative is to bound
`/api/*` once.

## 3. Documentation, no code

**R3-03 — bring the privacy text up to the code.**
`docs/privacy-policy.md` and `packages/core/privacy-policy.ts` must be edited
together (the route renders the latter). If the repository wants the text to
stop drifting, the cheapest pin is a test asserting the presence of the claims
it makes — not a parser.

## Dependencies and non-dependencies

- R3-01's backfill depends on knowing which existing rows are affected:
  `manifest_version = 1` with `source_url` an encrypted provider URL and items
  carrying `media.kind = 'encrypted'`. The code fix does not depend on the
  backfill.
- R3-02 and R3-04 both touch `app/api.ts`. Land them in one change if the branch
  discipline allows it; they cannot conflict with R3-01, which touches a handler
  body.
- R3-03 is text only and can land at any time.

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
