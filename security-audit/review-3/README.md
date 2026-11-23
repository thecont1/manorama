# Security audit — third pass (adversarial review)

Pinned target: **`c7d8002c7ee1c6f446e619e85bd09dee543611c6`** (`main`, "Merge pull
request #269 from thecont1/fix/desktop-publish-provider-env", 2026-11-22).

**Status of the findings:** all four are fixed on
`feat/local-gallery-report-fixes` — R3-01 at
**`e5385cabbc2d2fe37649025bd651d97b5e851d05`**, R3-02 and R3-04 at
**`626dd2fbac47ce0515b20b6ede0e61814aa00f70`**, R3-03 at
**`1aefd3da3a96cc850ff015ce051f2dad64aa5de2`** — and re-verified (see
`02-findings.md` status lines and `05-verification-appendix.md` § Fix
verification).

The audit ran in a detached worktree of the pinned SHA
(`.worktrees/audit-c7d8002`, `git rev-parse HEAD` = the SHA above) so the
checkout's own branch and its uncommitted files could not influence the
result. Nothing here was committed, pushed, deployed or pointed at production.
Every provider interaction is mocked; every account, gallery and file is
synthetic.

## Read in this order

| File | Contents |
| --- | --- |
| `00-executive-summary.md` | Verdict, the findings that matter, what was and was not tested |
| `01-architecture-and-threat-model.md` | The surfaces that actually exist at this SHA, assets, boundaries, attacker models |
| `02-findings.md` | Four findings with evidence, repro, impact and fix |
| `03-coverage-matrix.md` | Area-by-area: reviewed, tested, not applicable, not tested |
| `04-remediation-sequence.md` | What to fix first, and what depends on what |
| `05-verification-appendix.md` | Commands, outputs, environment, what failed to run |

## Reproduction assets

```
probe-web.test.ts       object-level authorisation matrix, public manifest shape, pipeline expiry
probe-ssr.test.ts       title/caption/alt injection through SSR, quick-add path
probe-sources.test.ts   provider URL canonicalisation and the Google Photos `?u=` fetcher
probe-cache.test.ts     what authenticated JSON tells caches (records headers)
probe-body.test.ts      which endpoints bound request bodies
probe-adopt.test.ts     adopting an encrypted gallery, plus the gate's item check (R3-01)
run-boundary.sh         compiles and runs the shipped macOS boundary suite
```

Run the API-side probes (the suite mirrors the tree to a scratch root first,
per `VERIFICATION.md`, because `bun test` at the repository root dies on the
nested worktrees):

```sh
bun run test:unit -- security-audit/review-3
```

Run the macOS probe (Xcode command-line tools, arm64 macOS, no network):

```sh
security-audit/review-3/run-boundary.sh
```

All six probe files are green at `d5ee928e` (40 tests), the head of the branch
that carries the fixes. At the pinned SHA, `probe-adopt.test.ts` had one
intentionally failing assertion and `probe-cache`/`probe-body` recorded the
unfixed behaviour — that failure was R3-01, and the fixes turn all of them green;
`probe-adopt.test.ts` now also pins the gate's item check in both directions, so a
future row that loses its version still cannot fall to the legacy path silently.

## Files created

```
security-audit/review-3/README.md
security-audit/review-3/00-executive-summary.md
security-audit/review-3/01-architecture-and-threat-model.md
security-audit/review-3/02-findings.md
security-audit/review-3/03-coverage-matrix.md
security-audit/review-3/04-remediation-sequence.md
security-audit/review-3/05-verification-appendix.md
security-audit/review-3/probe-web.test.ts
security-audit/review-3/probe-ssr.test.ts
security-audit/review-3/probe-sources.test.ts
security-audit/review-3/probe-cache.test.ts
security-audit/review-3/probe-body.test.ts
security-audit/review-3/probe-adopt.test.ts
security-audit/review-3/run-boundary.sh
```

## Files changed

None. No application source, test, migration, config or asset was modified;
the probes are new files inside the new directory. The previous passes left
`tsconfig.json` with a `security-audit` include entry, which already covers
this directory.

## Handling notes

No secret value appears in this report. Worker bindings are named, never
printed. The only credential-shaped strings are invented fixtures
(`synthetic-key`, `synthetic-secret`, `CAPABILITY`).
