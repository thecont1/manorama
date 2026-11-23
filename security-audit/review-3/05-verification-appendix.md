# Verification appendix

## Environment

| | |
| --- | --- |
| Host | macOS 27.2.1, arm64 |
| Swift | swift-driver 1.168.6, Swift 6.4 (Xcode 27.1 SDK) |
| Runtime | bun 1.4.4 |
| Vite | 8.3.5 |
| Audit snapshot | `.worktrees/audit-c7d8002`, detached at `c7d8002c7ee1c6f446e619e85bd09dee543611c6` |
| Fix commits | `e5385cab` (R3-01), `626dd2fb` (R3-02, R3-04), `1aefd3da` (R3-03), `d5ee928e` (probe pin) on `feat/local-gallery-report-fixes`; re-verified in the primary checkout at `d5ee928e` |
| Dependencies | `node_modules` symlinked from the primary checkout (same `bun.lock`); no install was run |
| Network | none required; the Swift suite opens a loopback listener and, in the API-proxy check, one request to the configured API base if reachable |

## The snapshot

```
$ git rev-parse HEAD
c7d8002c7ee1c6f446e619e85bd09dee543611c6
$ git log -1 --format='%H %ci %s'
c7d8002c7ee1c6f446e619e85bd09dee543611c6 2026-11-22 18:47:48 +0530 Merge pull request #269 from thecont1/fix/desktop-publish-provider-env
```

The primary checkout was **not** clean when the audit began, and its changes are
unrelated to this audit (uncommitted work on `feat/local-gallery-report-fixes`,
since committed there):

```
M macos/ManoramaMac/NativeBridge.swift
M src-tauri/src/lib.rs
?? docs/PLAN-Event-Clustering-Camera-Roll.md
```

Both diffs touch keychain-probe and dropped-root behaviour; the audit reads the
committed versions in the worktree, so neither is part of any finding.

## Commands run and results

### Typecheck

```
$ bunx tsc --noEmit
(no output, exit 0)
```

### Unit suite at the pinned commit

Without this pass's probes:

```
$ MANORAMA_TEST_ROOT=… bun run test:unit
2449 pass
   0 fail
33669 expect() calls
Ran 2449 tests across 196 files. [57.40s]
```

With them (202 files):

```
2486 pass
   1 fail          # probe-adopt.test.ts — R3-01, intentional
33758 expect() calls
Ran 2487 tests across 202 files. [54.82s]
```

### Production build at the pinned commit

```
$ bun run build
✓ built in 1.03s          # client
dist/index.js  4,740.98 kB │ gzip: 1,615.97 kB │ map: 9,536.28 kB
✓ built in 1.11s          # worker
EXIT:0
```

Warning (pre-existing): chunks over 500 kB, chiefly `heic-decode`
(2.0 MB) and `libsodium-wrappers` (534 kB). Performance, not security.

### This pass's probes at the pinned commit

```
$ bun run test:unit -- security-audit/review-3
37 pass
   1 fail
89 expect() calls
Ran 38 tests across 6 files. [98.00ms]
```

The single failure was the intended assertion in `probe-adopt.test.ts`
(R3-01). Per file:

| Probe | Result | What it records |
| --- | --- | --- |
| `probe-web.test.ts` | 14/14 | cross-owner matrix, hidden-item visibility, public manifest shape, pipeline read-only and expiry |
| `probe-ssr.test.ts` | 2/2 | title/caption/alt escaping, quick-add path |
| `probe-sources.test.ts` | 10/10 | Dropbox/Drive canonicalisation, Google Photos `?u=` fetcher |
| `probe-cache.test.ts` | 6/6 | header facts behind R3-02 |
| `probe-body.test.ts` | 3/3 | 413 vs unbounded, behind R3-04 |
| `probe-adopt.test.ts` | 2/3 | R3-01; the failing assertion was the finding |

## Fix verification (all four findings)

The fixes landed on `feat/local-gallery-report-fixes` in four commits, each
carrying its regression evidence:

| Commit | Finding | What it changes |
| --- | --- | --- |
| `e5385cab` | R3-01 | `manifestVersion` through adopt; `encryptedGalleryGate` consults the items |
| `626dd2fb` | R3-02, R3-04 | `privateNoStore` on the session-gated prefixes; 8 KB bounds on the two unbounded routes |
| `1aefd3da` | R3-03 | privacy text, both copies |
| `d5ee928e` | — | pins the gate's item check in `probe-adopt.test.ts` |

Re-run at `d5ee928e`, the last commit touching code the probes exercise:

```
$ bunx tsc --noEmit
(no output, exit 0)

$ bun run test:unit -- security-audit/review-3
40 pass
 0 fail
100 expect() calls
Ran 40 tests across 6 files. [74.00ms]

$ MANORAMA_TEST_ROOT=… bun run test:unit
2620 pass
   0 fail
34207 expect() calls
Ran 2620 tests across 211 files. [57.80s]
```

What each turned assertion now proves:

- **R3-01** — the adopted copy keeps `manifestVersion 2` and `gate.client` is
  true (`probe-adopt.test.ts`). Two tests added in `d5ee928e` pin the new belt in
  both directions: a `manifest_version = 1` row with keyless `media` refs takes
  the client path (this is what covers copies adopted **before** the fix, and why
  no backfill is required), and a `manifest_version = 1` row with server-proxied
  `src` keeps the legacy path, so the belt cannot over-claim. The visitor-render
  assertion is unchanged and still expects no `<img class="frame-img">` at SSR:
  the copy now takes `EncryptedGallery`, which SSRs the Viewer shell and lets the
  resolver fill frames after hydration. Before the fix the same markup meant
  "blank forever"; after it, "filled on hydration" — the gate assertion, not the
  markup, is the discriminator.
- **R3-02** — `probe-cache.test.ts` asserts `private` and `no-store` on
  `/api/galleries`, `/api/library`, `/api/account` and `/api/galleries/:slug`,
  and still records the public manifest as uncached.
- **R3-03** — no test; the text was read against
  `native/lib/offline-gallery.ts:652-689` and
  `desktop/islands/Catalogue.tsx:2890`.
- **R3-04** — `probe-body.test.ts` asserts 413 outside 8 KB on both routes and
  that a body inside the bound still reaches the handler's own refusal (401 /
  400-422), so a bound that swallowed real requests would fail.

The pre-fix numbers are kept above (`37 pass / 1 fail`, `2486 / 1`) as the
before-evidence.

## macOS boundary suite (shipped Swift, pinned commit)

```
$ security-audit/review-3/run-boundary.sh
… 60 checks …
ALL PASS
```

It compiles `LocalGallery, FolderStore, LocalSchemeHandler, Trace,
OAuthLoopback, NativeBridge, InvokeReply` from this SHA and runs the repository's
own `macos/BoundaryTests`. One compiler warning is emitted
(`InputStream` captured in a `@Sendable` closure in `LocalSchemeHandler.swift:467`),
which is a Swift 6 language-mode issue, not a security one.

The suite covers: bookmark round-trip across a fresh store; scope semantics;
media resolution (inside, outside, `photo..2.jpg`, escaping symlink, prefix
sibling, absolute paths, missing file, released token); deleted-folder
behaviour; bundle traversal; the stopped-task contract; opener and native-http
capability scopes including a lookalike host; the invoke-reply `value: null`
contract; the OAuth loopback (stray request, real redirect, cancel); `roots.json`
at 0600; vault-log rotation and mode; and the deep-link bookkeeping.

## What could not run

- **A browser.** No Playwright run: the suite needs a seeded dev server and the
  `MANORAMA_DEV_SOURCE_*` variables in `.env.local`. The SSR probes cover the
  server-rendered markup only; island hydration is untested here.
- **iOS / Android.** No simulator or device build was made.
- **The Tauri binary.** Read only (`src-tauri/src/lib.rs`,
  `capabilities/default.json`, `private_store.rs`).
- **Live providers.** All adapters were driven with injected fetches.
- **Live D1 for the probe matrix.** The in-memory repositories were used; the
  repository's own miniflare-backed tests cover the SQL and pass.

## Notes on the probes' design

- `probe-web.test.ts` asserts the *state after* the stranger's requests, not only
  the status codes, so a route that returns 404 after writing still fails.
- `probe-sources.test.ts` asserts which URL reached the injected fetch, so a
  refused input is proven to have been refused *before* any request, not
  answered empty by a mock.
- `probe-ssr.test.ts` strips every `<script>…</script>` element and looks for the
  payload's markup inside one, so an early element close cannot hide behind a
  passing `toContain`.
- `probe-adopt.test.ts` fails on purpose: it encodes the intended behaviour, and
  the failure is the evidence for R3-01.
