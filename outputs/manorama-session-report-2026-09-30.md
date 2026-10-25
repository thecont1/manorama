# manorama — work report, 30 September 2026

**Session window:** 23:00 – 23:47 IST (30 Sep) · **Deadline:** Wed 30 Sep, 23:45 PDT = Thu 1 Oct, 12:15 IST → **≈ 12.5 hours left**
**Base commit:** `1092f6c` on `main` · **Nothing committed** — see §5.
**Supersedes** `state-of-manorama-2026-09-30-2318.md` wherever the two disagree.

---

## 1. Outcome

| Lane | Status | Evidence |
| --- | --- | --- |
| Restore a trustworthy test invocation | **Done** | `bun run test:unit` → **1050 pass / 0 fail**, 82 files, 23 s |
| Fix the three account-slot ad-safety failures | **Done** | that file 26/26; full suite green; master-switch assertion still holds |
| Rebuild native + re-archive the iOS IPA | **Done** | `manorama-1.0-build-4.ipa`, distribution-signed, verified |
| macOS app for Apple Silicon only | **Done, answered** | `manorama_0.1.0_aarch64.dmg`, arm64 only, signed |

---

## 2. The test invocation (lane 1)

### Why `bun test` could not run

The git worktrees live inside the repository at `.worktrees/` — **23 registered, 17 carrying their own `node_modules`**. That puts **1,048,549 files under bun's scan root**, so the runner exhausts its file-descriptor budget before it can load the `bunfig.toml` preload:

```
error: EMFILE reading ".../test/hono-jsx-dom.ts"
error: Cannot read directory ".../app": EMFILE
```

The per-process limit is not the problem — a bun process here opens 122,876 descriptors happily. Adding `.worktrees/` to `.gitignore` does **not** help: bun's scanner does not consult it.

### Why running from a subdirectory is not a substitute

The preloaded DOM renderer is order-sensitive, so which specs share a process changes the result. Same commit, same tree:

| Invocation | Result |
| --- | --- |
| `bun test ./app/server.test.ts` from the repo root | **30 pass / 0 fail** |
| `cd app && bun test ./server.test.ts` | **25 pass / 5 fail** |
| `cd app && bun test` | 569 pass / 62 fail, 45 files |
| `bun run test:unit` | **1050 pass / 0 fail**, 82 files |

Only the repository-root invocation is authoritative — which is the one the worktrees block.

### The fix

`scripts/test-mirror.sh`, wired as `bun run test:unit`. It mirrors the working tree into a scratch root holding no worktrees and no build output, symlinks the single `node_modules`, and runs `bun test` there. The checkout is only read; extra arguments pass through:

```sh
bun run test:unit
bun run test:unit -- ./native/islands
bun run test:unit -- -t 'account slot entitlement'
```

Documented in `AGENTS.md` §4 and § Definition of done, and at length in `VERIFICATION.md` § Running the unit suite.

### One caveat worth knowing

Two files — `app/lib/gallery-retention.test.ts` and `app/account-deletion-api.test.ts` — stand up a local miniflare server. They need a **writable `~/.wrangler`** and permission to **bind a loopback port**. Where either is refused they fail with `EPERM` / `EADDRINUSE: Failed to start server. Is port 0 in use?`, plus cascading `(unnamed)` errors from their `afterAll` `dispose()` calls, and the reported test count drops from 1050 to 964 because those describes abort partway. If you see that, it is the sandbox, not a regression — do not "fix" the tests.

---

## 3. The account-slot failures (lane 2)

### Root cause

`fetchAdVisibility` is **fail-open by design** and always resolves — it returns `{ show: true }` even when the endpoint is unreachable. So `visibility` moves `null → { show: true }`, and `visibility?.show` moves **`undefined` → `true`**.

That value was in the account-slot effect's dependency array, so the answer *landing* looked like a change of entitlement state and asked the loader a **second** time:

```ts
}, [galleryOpen, billingState?.tier, billingState?.isPro, visibility?.show])
```

Measured with an isolated probe of the same island: `loader calls = 2`. The three failing tests assert exactly one request per entitlement state, which is the contract the comment above the effect states:

> The account slot asks once per entitlement state, so ordinary re-renders can never rotate the creative while the page is open.

### Fix

One derived value, fail-open **and stable**, used both in the call and in the dependency array:

```ts
const platesVisible = visibility?.show ?? true
```

Only a real suppression moves it. Consequences:

- Happy path unchanged — the slot still renders immediately; fail-open semantics are preserved.
- A genuine suppression still works: the value flips to `false`, the effect re-asks with `visible: false` (so no third-party adapter is ever consulted for a suppressed viewer) and the render gate drops the slot.
- The double request disappears, so the creative can no longer rotate under a viewer who asked for nothing.

### Verified

- `native/islands/GalleryList.account.test.tsx` → **26 pass / 0 fail** (was 23/3).
- Full suite → **1050 pass / 0 fail**.
- The master-switch test — which asserts the loader's last call carried `visible: false` and that no slot renders — still passes, so the suppression path is intact.
- No test was weakened or skipped.

Note on the earlier diagnosis: in the file context the *slot-count* assertion also failed (2 slots, not 1). Run alone, only the request-count assertion fails. The extra slot in the file context is test-harness pollution — each mount appends a container to `document.body` and never removes it. That is a test-quality issue, not product behaviour, and I left it alone rather than reach outside the fix.

---

## 4. Release artifacts (lane 3 and the macOS build)

### iOS — `manorama-1.0-build-4.ipa`

`/Users/home/DEV/manorama-submission/build/manorama-1.0-build-4.ipa` · 21,181,969 bytes · SHA-256 `027d7f663c80dc50349e6541b344408b3007b3253f0de57d351da5fe75e63f67`

Verified in the exported binary:

| | |
| --- | --- |
| Bundle id / version | `in.thecontrarian.manorama`, `1.0` (4) |
| Minimum OS | 15.0 |
| Signature | `Apple Distribution: Mahesh Shantaram (373K7W3LKU)` |
| Entitlements | `get-task-allow = false`, `beta-reports-active = true`, `com.apple.developer.associated-domains = applinks:manorama.xyz` |
| ProMotion lever | `CADisableMinimumFrameDurationOnPhone = true` |
| Bundled web assets | `assets/index-DUQgDXyX.js` — the native build from `1092f6c` |

Two blockers had to be cleared, and **both predate this session**:

1. **Associated Domains.** `App.entitlements` declares `applinks:manorama.xyz` (added at 18:22 today). The installed profile did not carry the capability, so archiving failed with *"Provisioning profile … doesn't include the associated-domains entitlement"*. `-allowProvisioningUpdates` let Xcode reconcile the capability with the profile, and the entitlement is present in the exported binary.
2. **The export's rsync step.** `xcodebuild -exportArchive` failed with a bare `error: exportArchive Copy failed`. The real cause was in the distribution log: Xcode's IPA step runs `/usr/bin/rsync -8aPhhE`, and the *rsync server* it spawns resolved to **Homebrew rsync 3.5.1** (first on `PATH`), which rejects Apple's `-E`:

   ```
   rsync: on remote machine: --extended-attributes: unknown option
   rsync error: syntax or usage error (code 1) [server=3.5.1]
   ```

   Running xcodebuild with a system-first `PATH` fixes it. **Both prior export logs in the submission workspace read `** EXPORT FAILED **`** — this path was already broken, which is why no build 4 existed.

Also: the execution sandbox denies login-keychain access, which the export needs for the distribution identity, so the archive/export had to run outside it.

**Build number raised 3 → 4.** `CURRENT_PROJECT_VERSION` in `ios/App/App.xcodeproj/project.pbxproj`. Build 3's IPA may already have reached App Store Connect; a duplicate build number is a hard upload rejection. Confirm the highest build in App Store Connect before uploading.

### macOS — Apple Silicon only

**Yes.** Both Rust targets are installed, so:

```sh
bunx tauri build --target aarch64-apple-darwin
```

writes to `src-tauri/target/aarch64-apple-darwin/release/bundle/` instead of the `universal-apple-darwin` tree. Result:

| | Apple Silicon only | Universal (for comparison) |
| --- | --- | --- |
| App | **18.72 MiB** | ~35 MB |
| DMG | **10.82 MiB** | 66 MB (staging image only) |
| Rust compile | 51 s (incremental) | — |
| Architecture | `arm64` | `x86_64 arm64` |

Verified: `lipo -archs` → `arm64`; `codesign --verify --deep --strict` → OK; `Developer ID Application: Mahesh Shantaram (373K7W3LKU)`, hardened runtime flag, timestamp 23:45:02; DMG CRC valid and Developer ID signed.

Trade-off, stated plainly: an Intel Mac cannot run this build. The DMG bundling step, which had never completed for the universal build, **succeeded** here — the universal tree still holds only a stale `rw.86998.manorama_0.1.0_universal.dmg` staging image from 23:01.

**Gatekeeper rejects the app — `source=Unnotarized Developer ID`.** Notarisation needs `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` (or the API-key trio) in the environment. Owner-only.

---

## 5. Repository changes — nothing committed

Five files modified, one added, awaiting your decision on branch and PR per the working agreement (`feat/<area>-<slug>`, one issue, one PR):

```
 M AGENTS.md                              §4 command, DoD line, why-the-mirror note
 M VERIFICATION.md                        § Running the unit suite (new, 55 lines)
 M native/islands/GalleryList.tsx          the account-slot fix (11 lines)
 M package.json                            "test:unit" script
 M ios/App/App.xcodeproj/project.pbxproj   CURRENT_PROJECT_VERSION 3 -> 4
?? scripts/test-mirror.sh                  the mirror runner
?? outputs/                                this report + the earlier briefing (untracked)
```

Outside the repo, in the submission workspace: `build/manorama-1.0-build-4.ipa`, the build-4 archive and export dir, and edits to `01-app-store-listing.md` and `06-app-store-connect-fields.md` pointing them at build 4 with the verified facts and a do-not-upload warning for build 3.

---

## 6. What is still open

**Owner-only, cannot be actioned from here**

- Notarise the macOS DMG and staple the ticket.
- Upload build 4 to App Store Connect; confirm the highest existing build number first.
- The App Privacy questionnaire, screenshots and IAP review screenshot against the uploaded binary.

**Worth deciding**

- The universal macOS bundle is now stale — this session's build regenerated `desktop/dist`, which the 23:08 universal app predates. Rebuild it or discard it; do not ship it as current.
- `.worktrees/` inside the repository is the root cause of the broken documented test command. The mirror works around it, but moving worktrees outside the working tree (e.g. `../manorama-worktrees`) would fix it properly. There is also an **orphan worktree checkout at `/tmp/manorama-verify` dated 27 Sep** that is no longer registered in `git worktree list`.
- The Playwright acceptance matrix has not been run this session — it needs the dev seed and `MANORAMA_DEV_SOURCE_*` in `.env.local`.

**Environment limits to expect in a future session**

Outbound network is blocked by default (so `gh` cannot reach `api.github.com`, and App Store Connect, RevenueCat and AdMob are invisible), `ps` is refused, writes outside the workspace are refused, the login keychain is denied, and nested `sandbox-exec` is refused — which is what stops xcodebuild without elevation. The `fetch` tool still works because it executes remotely.

---

## 7. Verification log

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | clean |
| `bun run test:unit` | **1050 pass / 0 fail**, 82 files, 23.4 s |
| `native/islands/GalleryList.account.test.tsx` | 26 pass / 0 fail |
| IPA identity, signature, entitlements, assets | verified as tabulated in §4 |
| macOS `lipo -archs` / `codesign --verify --deep --strict` | `arm64` / OK |
| macOS DMG `hdiutil verify` | checksum VALID |
| macOS `spctl -a -t exec` | rejected — `Unnotarized Developer ID` (expected) |

---

## Addendum — 1 October, 00:20–00:45

Three further review findings came in while the first pass was being handed over. All three are in
**PR #114** as a second commit (`5019e6b`). Everything below supersedes §5 and §6 of this report.

### The provider row

The three cells were sized by their labels, so "Google Drive" — more than twice "Apple" — set
unequal intervals between the glyphs and dragged the row off centre. Each cell is now
`flex: 0 0 clamp(88px, 26vw, 112px)`, and the row keeps its full width so `justify-content`
centres the cells under "Continue with", rather than depending on a width that has to agree with
the landing column's inset.

Measured cell widths after the change: **101 / 101 / 101** at 390×844 and **112 / 112 / 112** at
1440×900, in both shells.

### The footer

The same legal line read three different ways:

| Surface | Privacy Policy | Copyright |
| --- | --- | --- |
| web landing | `<a href="/privacy">` | © 2026 Mahesh Shantaram · thecontrarian.in |
| iOS account | `<a href="https://manorama.xyz/privacy">` | © 2026 Mahesh Shantaram · thecontrarian.in |
| macOS | `<button onClick=openExternal>` | © 2026 Mahesh Shantaram |

Both Mac footers now carry the web's markup verbatim — an anchor and the author link — with the
click routed through the opener plugin, because a bare external href would navigate the Tauri
webview away from the catalogue. Fonts were already shared: all three surfaces load the same
`.site-footer-link` / `.site-footer-copy` rules from `app/styles.css`.

The iOS **opening screen** had no footer at all, which left the privacy policy unreachable before
sign-in on the one surface a signed-out viewer ever sees. It now carries the same footer as the
web landing. Worth a confirmation — it is a visible addition to the iOS door.

### The giant wordmark

`.control-logo` is `position: fixed`, so the `height: 100%` it shared with the row's buttons
resolved against the viewport rather than the row; `.brand-mark-wrap { height: 78% }` compounded
it. The wordmark painted at 1693×566 at iPhone width and its magenta pill drew two full-width
rules across the photograph. One `--native-chrome-height` / `--desktop-chrome-height` per shell
now drives the row, the button and the wordmark: **81×62** (iPhone) and **344×67** (wide), with
the wordmark at **146×49** / **155×52**.

### The Mac opening screen

"Start locally / Choose a folder or card" is gone. A signed-out launch now lands on the sign-in
door whatever the saved catalogue holds, matching the mobile shells; the folder affordance stays
in the catalogue toolbar, behind the session. `desktopScreen` lost its `galleryCount` input along
with the rule it encoded, and the test that asserted the old behaviour was replaced — the suite
is 1048 rather than 1050 because those two cases are gone, deliberately.

### Release state

- `bunx tsc --noEmit` clean; unit suite **1048 pass / 0 fail**, 82 files.
- Rebuilt the arm64 app and DMG from the final tree, launched it, and captured the opening
  screen: the row is even, the footer reads "Privacy Policy" / "© 2026 Mahesh Shantaram ·
  thecontrarian.in", and there is no local-folder action.
- **The macOS DMG is now notarized.** §4 above said Gatekeeper rejected it; that is fixed.
  Submission `36c22e0f-694f-4a6c-af66-39ed6a87ac2c` **Accepted**, stapled. `spctl` reports
  `accepted, source=Notarized Developer ID` for both the DMG and the app. The keychain profile
  `notarytool` exists and works — no environment variables were needed. The DMG's SHA-256 begins
  `e0d91572bc961891f423f77a`.
- The stale universal bundle was deleted, along with its still-attached staging image.

### Where things stand

| PR | What it carries |
| --- | --- |
| [#111](https://github.com/thecont1/manorama/pull/111) | account-slot single request (ad safety) |
| [#112](https://github.com/thecont1/manorama/pull/112) | working unit-test invocation |
| [#113](https://github.com/thecont1/manorama/pull/113) | iOS build 4 |
| [#114](https://github.com/thecont1/manorama/pull/114) | bounded gallery chrome, sign-in-door opening screen, even provider row, matched footers |

Still owner-only: uploading build 4 to App Store Connect, and the App Privacy questionnaire and
screenshots. The Playwright acceptance matrix has still not been run — it needs the dev seed.

---

## Addendum 2 — 1 October, 01:00–01:05

### How the legal links open

The question was whether Privacy Policy and thecontrarian.in should hand off to the system browser
or load inside the app. The codebase had already answered it in two places: the paywall opens
Terms of Use and Privacy Policy through `@capacitor/browser`, and the OAuth flow uses the same
plugin with a toned toolbar. That is an `SFSafariViewController` sheet — in-app, dismissible, with
the domain visible and a Done button — which is the pattern Apple recommends for showing
third-party web content from an app, and the one that keeps a reviewer from meeting a dead link.

The footers were the odd ones out: bare `target="_blank"` anchors, which a Capacitor webview does
not reliably act on. Both now use an anchor with a real href — so the link still works, and still
reads as a link, without JS — whose click hands off to the sheet. The Mac keeps the system browser
through the opener plugin, which is the desktop convention. The web keeps a same-tab
`<a href="/privacy">`, since `/privacy` is a route in the same app.

### Fitting both on one line

They do not have to. `.site-footer` is a `space-between` row that already stacks into a column
below 720px, so a phone gets:

```
Privacy Policy
© 2026 Mahesh Shantaram · thecontrarian.in
```

and the copyright line wraps on its own if it ever has to. That is the right trade: a legal footer
on two lines is unremarkable, while shrinking the type below 12px or dropping the author's name
would cost more than it saves. Both links are present on every opening screen — web, iOS and macOS.

### Build 4 is stale; build 5 is the one to upload

Worth catching: the IPA from 23:43 was archived **before** the chrome and opening-screen fixes, so
its bundled CSS still paints the viewport-scale wordmark and its provider row is the old triangle.
The bundled JS in that archive matches the pre-fix `native/dist` exactly.

Rebuilt and re-archived as **`manorama-1.0-build-5.ipa`**:

| | |
| --- | --- |
| Path | `/Users/home/DEV/manorama-submission/build/manorama-1.0-build-5.ipa` |
| Size | 21,184,039 bytes |
| SHA-256 | `7fb651493f6c3a83c19a312f0e332fa363e5957365d734de9f66d2c407fdde87` |
| Bundle / version | `in.thecontrarian.manorama`, `1.0` (5) |
| Signature | `Apple Distribution: Mahesh Shantaram (373K7W3LKU)` |
| Entitlements | `get-task-allow` false, `beta-reports-active` true, `applinks:manorama.xyz` |
| Bundled CSS / JS | `assets/index-B1IPWgaB.css`, `assets/index-C7rM0Iwa.js` |

The bundled CSS now contains `native-chrome-height`, so the archive is provably post-fix.
`01-app-store-listing.md` and `06-app-store-connect-fields.md` point at build 5, and both now warn
against uploading build 4 as well as build 3. The project build number is `5`
(`CURRENT_PROJECT_VERSION` in `ios/App/App.xcodeproj/project.pbxproj`), raised on the branch
`fix/native-opening-screen-and-chrome` at `e854300`.

Verification for this pass: `bunx tsc --noEmit` clean, unit suite **1048 pass / 0 fail**,
`bun run build:native` + `bunx cap sync ios` + archive + export all exit 0.
