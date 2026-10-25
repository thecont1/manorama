# manorama — orientation briefing

> **Superseded.** This was the read-only orientation snapshot taken at 23:18. The test
> invocation, the three account-slot failures and the iOS artifact have since been fixed;
> see `manorama-session-report-2026-09-30.md` for the current state. This file is kept for
> the record of what the repository looked like before that work.

**Prepared:** 2026-09-30, 23:18 IST (= 10:48 AM PDT)
**Scope:** read-only survey of `/Users/home/DEV/tools/manorama` plus the attached
`session-handoff-2026-09-30.md`. Nothing in the repository was modified.
**Headline:** the product is live and the macOS binary is built and signed, but the
iOS release artifact does **not** yet contain the last two commits, the macOS DMG
step has not completed for the current build, and the project's own
definition-of-done command (`bun test`) cannot be trusted — or even run — on this
checkout.

---

## 1. Time and deadline

| | |
| --- | --- |
| Hard deadline | Wed **30 Sep 2026, 23:45 PDT** = Thu 1 Oct, **12:15 IST** |
| Remaining at time of writing | **≈ 13 hours** |
| Submission target | Sat 26 Sep (passed) |
| Judging | 1–13 Oct; Shipaton requires a new release + RevenueCat IAP or ads |

The handoff's own "Remaining limitations" section already concedes items 1–4. Two of
them are worse than stated — see §4.

---

## 2. Repository truth as of now

| | |
| --- | --- |
| Branch | `main`, in sync with `origin/main` |
| HEAD | `1092f6c` — `fix(desktop): align macOS shell with native gallery design` (committed **23:09 IST**, pushed) |
| Working tree | clean, apart from a `?? .work/` scratch directory created by this survey |
| Typecheck | `bunx tsc --noEmit` → **clean (exit 0)** at `1092f6c` |

**HEAD moved while this survey was running.** At 23:01 the tree had two modified
desktop files (`desktop/islands/Catalogue.tsx`, `desktop/styles.css`) and HEAD was
`c5a28d7`. At 23:09 that work was committed as `1092f6c` and pushed. Between 23:00
and 23:08 a Tauri universal build was also writing into `src-tauri/target/`.

Conclusion: **another agent or session is actively working in this same checkout.**
The attached handoff is already superseded in its "current source state" section.
Before touching anything, re-check `git log -1` and `git status`; and respect the
AGENTS.md one-issue/one-branch/one-PR lane discipline, because a concurrent writer is
demonstrably present.

---

## 3. What is verified working

| Surface | Evidence |
| --- | --- |
| Web deployment | `https://manorama.xyz/thecontrarian/italy` fetched and rendered: curtain "italia, amore mio", caption "family trip to Italy in October 2018", 22 items, picker + `The End.` card present |
| macOS binary | `src-tauri/target/universal-apple-darwin/release/bundle/macos/manorama.app` — universal (`x86_64 arm64`), `Identifier=in.thecontrarian.manorama.desktop`, `Authority=Developer ID Application: Mahesh Shantaram (373K7W3LKU)`, `flags=0x10000(runtime)`, `Timestamp=30 Sep 2026 at 23:08:50`, `codesign --verify --deep --strict` → exit 0 |
| Typecheck | clean at HEAD |
| Evidence inventory | submission workspace has 6 iPhone + 6 iPad + 6 macOS screenshots, listing/review/privacy/devpost docs, and a 24.9 MB evidence zip |

---

## 4. What is verified *not* in the state the handoff describes

### 4.1 The native bundle is one commit stale

`native/dist/` is timestamped **22:39–22:40**. Commit `c5a28d7` (22:50) changed
`native/styles.css` (+188 lines), `native/islands/GalleryList.tsx`,
`native/styles/global-view.css` and `app/islands/Viewer.tsx`. The bundle therefore
**cannot contain** the curtain control alignment and admin-row refinements the
handoff says it contains. (It does contain the *earlier* `e014bab` work — the
`native-gallery-row-with-thumb` marker is present.)

### 4.2 The macOS DMG does not exist for the current build

The handoff names
`src-tauri/target/universal-apple-darwin/release/bundle/dmg/manorama_0.1.0_universal.dmg`.
That directory now holds only `bundle_dmg.sh` and `icon.icns`. The only DMG-like file
is a **read-write staging image** `bundle/macos/rw.86998.manorama_0.1.0_universal.dmg`
(66 MB, **23:01**) — older than the 23:08 app binary. So the DMG packaging stage of
the current build did not finish. Notarisation was never run (no credentials).

### 4.3 The iOS artifact predates both recent native commits

The only IPA on this machine is
`/Users/home/DEV/manorama-submission/build/manorama-1.0-build-3.ipa` (today, 17:22).
`c5a28d7` (22:50) and `1092f6c` (23:09) are both after it. Whatever ships must be
re-archived from a freshly built `native/dist`.

---

## 5. The verification problem — the most consequential finding

AGENTS.md defines done as `bunx tsc --noEmit` clean, `bun test` green, Playwright
matrix green. Two independent things currently prevent an honest claim about the
middle one.

### 5.1 `bun test` cannot run from the repository root at all

```
error: EMFILE reading ".../test/hono-jsx-dom.ts"
error: Cannot read directory ".../app": EMFILE
```

Cause, measured: **`.worktrees/` contains 17 git worktrees each with their own
`node_modules` — 1,048,549 files reachable from the repo root.** bun's test runner
scans from the working directory, and the process exhausts file descriptors before
it can even load the `bunfig.toml` preload. The per-process limit is not the problem
(a bun process here can open 122,876 descriptors).

So the documented command in AGENTS.md §4 does not work in this checkout. It has to
be run from a clean worktree, or walked explicitly. This is repository hygiene
turning into a process failure.

### 5.2 Test colour depends on the directory you run from

Same code. Same worktree. Two invocations:

| Invocation | Result |
| --- | --- |
| `bun test` from repo root (clean worktree at HEAD) | **938 pass / 26 fail**, 964 tests, 82 files |
| `bun test` from `app/` in that same worktree | **569 pass / 62 fail**, 631 tests, 45 files |
| `bun test ./app/server.test.ts` from repo root | **30 pass / 0 fail** |
| `bun test ./server.test.ts` from `app/` | **25 pass / 5 fail** |

`app/server.test.ts` passes or fails purely on the working directory. This is the
hazard `bunfig.toml` already documents for `hono/jsx/dom` renderer ordering, and it
is live. **Any green/red claim produced from a subdirectory is invalid.** The only
authoritative invocation is from the repo root — the one §5.1 blocks.

### 5.3 Breakdown of the 26 root-invocation failures

- **≈23 are environmental, not defects.** They stood up a miniflare/wrangler loopback
  server and failed with `EADDRINUSE: Failed to start server. Is port 0 in use?` plus
  `EPERM: operation not permitted, open '~/.wrangler/logs/…'`. Affected suites:
  `retained vs pipeline allocation (d1)`, `pipeline galleries are read-only (d1)`,
  `upgrading to pro promotes live pipeline galleries (d1)`, `migration 0002 on a
  legacy database`, `deleteAccount`, `account-deletion-api`. The `(memory)` variants
  of the same suites **pass**. This sandbox blocks binding a listener and writes
  outside the workspace; on an unrestricted machine these should be green.
- **3 are real assertion failures** in `native/islands/GalleryList.account.test.tsx`,
  and they are deterministic — they fail in isolation and in the full run, and they
  fail at `8239b1c`, `e014bab`, `c5a28d7` and `1092f6c` alike:
  - `account slot entitlement > pro renders the slot under its own tier` — expected 1
    slot, received 2; expected the loader called once, received 2.
  - `account slot resolution lifecycle > a creative resolved after the tier changed
    cannot overwrite the new one` — expected 1 pending request, received 2.
  - `account slot resolution lifecycle > re-renders do not rotate the creative` —
    the DOM contains `Creative 2`, i.e. the creative rotated on a re-render.

  An isolated probe of the same island (scratch file, now removed) measured
  `loader calls = 2`, `slots = 1`, and the slot rendering on the **pre-session landing
  branch** (`main.landing-page > .landing-brand > header.native-account-header >
  aside.native-account-ad`) while session resolution was outstanding. So the loader is
  genuinely invoked more than once per entitlement state; the "received 2 slots" reading
  in the file itself looks compounded by cross-test pollution (the file appends each
  mount into `document.body` and never removes it).

  Why this matters beyond a red test: these three tests are exactly the tests that
  encode the account-slot guarantees — asked once per entitlement state, never rotates
  while the page is open, never shows a stale creative. Rule 10 of the plate rules and
  issue #19 rest on that behaviour. Either the component re-requests (a real defect) or
  the harness is unsound (a test defect). It needs an owner decision, not a silent
  loosening of the assertions — AGENTS.md forbids weakening a test to make it pass.

---

## 6. Limits of this survey — what I could not check

| Not checked | Why |
| --- | --- |
| Playwright acceptance matrix | Needs a seeded dev server + `MANORAMA_DEV_SOURCE_*`; not run |
| GitHub issues/PRs (#12–#44) | No outbound network from this sandbox: `gh` → `error connecting to api.github.com` |
| App Store Connect / TestFlight state | No network, no credentials — the handoff's claim that review submission was *not* completed is unverified either way. **Confirm ASC by hand before assuming anything.** |
| RevenueCat / AdMob dashboards | No network |
| Notarisation | Credentials unavailable (per handoff) |
| Native device runs | No device interaction attempted |

Environment facts worth knowing for the next session: **outbound network is blocked**,
`ps` is not permitted, and writes outside the workspace are refused (that is what
breaks wrangler's log file). The `fetch` tool still works because it executes remotely.

---

## 7. Suggested order of work

Ordered by deadline risk, not by difficulty.

1. **Decide the shipping artifact.** The binary that goes to review must contain
   `c5a28d7` + `1092f6c`. Rebuild `native/dist`, `cap sync`, re-archive, re-upload.
   The existing IPA predates both.
2. **Finish the macOS DMG** for the 23:08 universal app, then notarise if credentials
   exist. Do not cite the handoff's DMG path — it is empty.
3. **Restore a trustworthy test invocation before trusting any future green.** Either
   prune the orphaned/stale worktrees (23 registered; one unregistered leftover at
   `/tmp/manorama-verify` dated 27 Sep) or standardise on a clean throwaway worktree.
   Record the working command in VERIFICATION.md, because AGENTS.md §4's command is
   currently inoperable here.
4. **Adjudicate the three account-slot failures.** They are ad-safety behaviour, and
   the definition-of-done gate is red because of them.
5. **Confirm App Store Connect by hand** — I cannot see it, and the deadline is ~13 h out.

## 8. Invariants I am carrying forward

Never persist image bytes or thumbnails server-side (D1 is metadata only) · never
upscale, recompress, crop, stretch or re-encode a source image, and keep ICC/C2PA in
the bytes · plate rules are enforced by tests, not convention · tier changes go
through `setUserTier` only · no private Apple APIs · `packages/core` stays
platform-free · deletion never touches a provider · no ambient surfaces · no
invented procedures.

## 9. Scratch left behind

`outputs/` (this file) and `.work/` (survey scratch) are **untracked and not covered
by `.gitignore`** — git now reports `?? .work/`. Delete them or ignore them as you
prefer; nothing else in the repository was touched.
