# Second review — fixes for the first audit

PR #203 (`fix/security-audit`) merged to `main` as
**`14e74a8bfc74264ccd07465d41341e0c69a0f3a5`**. Working tree is at `a91b534`, whose tree is
byte-identical to the merge (`git diff a91b534 origin/main` → empty), so this review is
against `origin/main`'s content.

## What this pass is

A re-review, not a fresh audit. Two questions, in this order:

1. **Does each fix actually close what it claims** — with evidence, not by reading the
   commit message.
2. **Did the fixes break anything, or open something new?**

Everything was re-derived from the pinned tree. The prior report
(`security-audit/00..05`) is untouched and now stale: it still describes every finding as
open. Status for each is in `findings.md` here.

## Result

F-01, F-02, F-03, F-04, F-05, F-08, F-09, F-11 and F-12 are **closed and verified**. F-10 is
substantially improved with one documented limit. F-06 and F-07 remain **open** as the
remediation plan intended (both were in its "longer term" tier).

The fixes hold. The boundary probe now returns `BRIDGE-NOT-REACHABLE` with the trusted
reply, the gestured `_blank` route, `window.open`, `location.assign`, the child-frame
drop and the untrusted-document drop all independently asserted. Five smaller items were
found in the new code; one is behavioural (an installed pre-merge app build can no longer
escrow a key), the rest are hygiene.

## Files

```
README.md                      this file
findings.md                    per-finding verdicts F-01…F-12, then new findings R-01…R-05
verification.md                commands, outputs, limits
../poc/review-2-edges.test.ts  new: the fixed properties' corners (6 tests, all green)
```

## Run

```sh
bun run test:unit -- security-audit                     # 25 tests: prior PoCs re-pointed at the fixed behaviour, guards, and review-2 edges
security-audit/poc/macos-bridge-origin/run.sh          # the boundary probe, now expected to end BRIDGE-NOT-REACHABLE
```

Both are safe and repeatable; the probe writes only under `$TMPDIR`.

## Files created this pass

```
security-audit/review-2/README.md
security-audit/review-2/findings.md
security-audit/review-2/verification.md
security-audit/poc/review-2-edges.test.ts
```

No application file was modified.
