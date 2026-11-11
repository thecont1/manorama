# Security audit — Manorama (adversarial review)

Audit of `thecont1/manorama`. The review began at
`ffdcd867a3f0a89bd1dce3370bcb141a6650feef` and is delivered against
**`b0e70ee72fa437ff9098ce929970aa365a87f782`** (`origin/main`, "docs(agents): the unit
mirror sweeps in untracked files"), to which `main` advanced during the audit. The three
intervening commits touch only `AGENTS.md`, two homepage components and one native island
test — `git diff --name-only ffdcd86..b0e70ee` intersects no audited file — and every PoC
below was re-run on the delivered snapshot.

Independent adversarial review, read-only against application code. Nothing here was
committed, pushed, deployed or run against production. All fixtures are local.

## Result in one line

Five exploitable-or-consequential weaknesses were demonstrated with runnable evidence
(two of them in the macOS native shell and its OAuth/namespace seams); no critical
(remote-unauthenticated, data-loss) break was found in the web API's object-level
authorisation, provider proxying or billing verification, all of which held under
hostile input.

## Read in this order

| File | Contents |
| --- | --- |
| `00-executive-summary.md` | Overall assessment, ranked risks, what was and was not tested |
| `01-architecture-and-threat-model.md` | Real surfaces, trust boundaries, attacker models |
| `02-findings.md` | Every finding with evidence, impact, repro and fix |
| `03-coverage-matrix.md` | Area-by-area: reviewed / tested / not tested, with limits |
| `04-remediation-sequence.md` | Blockers, then hardening, with dependencies |
| `05-verification-appendix.md` | Exact commands, outputs, environment, what failed to run |

## Reproduction assets

```
poc/login-csrf.test.ts                 F-03  (bun test, miniflare D1, local JWKS)
poc/owner-slug-reuse.test.ts           F-04  (bun test, in-memory stores)
poc/key-vault-clobber.test.ts          F-05  (bun test, stubbed fetch)
poc/guards.test.ts                     boundaries that hold (green)
poc/macos-bridge-origin/run.sh         F-01/F-02 (compiles the shipped Swift, runs it)
```

Run the API-side PoCs (the suite mirrors the tree to a scratch root first, per
`VERIFICATION.md`, because `bun test` at the repo root dies on the nested worktrees):

```sh
bun run test:unit -- security-audit
```

Run the macOS probe (needs Xcode command-line tools; arm64 macOS; no network):

```sh
security-audit/poc/macos-bridge-origin/run.sh
```

Both are safe to repeat. The macOS probe writes only under `$TMPDIR` and never touches
the real app-support directory or the login Keychain.

## Files created

```
security-audit/00-executive-summary.md
security-audit/01-architecture-and-threat-model.md
security-audit/02-findings.md
security-audit/03-coverage-matrix.md
security-audit/04-remediation-sequence.md
security-audit/05-verification-appendix.md
security-audit/README.md
security-audit/poc/login-csrf.test.ts
security-audit/poc/owner-slug-reuse.test.ts
security-audit/poc/key-vault-clobber.test.ts
security-audit/poc/guards.test.ts
security-audit/poc/macos-bridge-origin/main.swift
security-audit/poc/macos-bridge-origin/run.sh
```

## Files changed

```
tsconfig.json   one added `include` entry ("security-audit") so `bunx tsc --noEmit`
                covers the PoC files. No compiler options changed, no runtime effect.
```

No application source, test, migration, config or asset was modified.

## Handling notes

- No secret value appears in this report. Bindings are referenced by name only; the
  one credential-shaped string in the PoCs (a canary) is invented.
- The audit used the primary worktree, whose tree was clean at the pinned commit
  (verified: `git status --porcelain` → 0 lines, `git worktree list` → `b0e70ee [main]`).
  A sibling branch worktree (`feat/web-homepage`) existed and was **not** audited.
