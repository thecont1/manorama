# Working notes — 2026-10-11 (regression sweep, preferences, deep links, builds)

Branch: `feat/deeplinks-and-refresh`, based on `origin/main` = `6a43e86`
(Merge PR #116, which contains PR #115 and all of the native-capture work).
Local `main` was stale and was fast-forwarded to `origin/main`.

## 1. Regression sweep on merged main

### Fast checks — green
- `bunx tsc --noEmit` → clean
- `bun run test:unit` → **1080 pass, 0 fail** (85 files)

### Full acceptance suite — 180 passed / 65 failed / 9 skipped (42.3 min, serial)
Command used:

```sh
GALLERY_URL=http://localhost:5173 GALLERY_VIDEO_SLUG=mixed-album \
WEB_URL=http://127.0.0.1:5173 DESKTOP_URL=http://127.0.0.1:5175 \
CAPTURE_URL=http://localhost:4182 NATIVE_GALLERY_URL=http://localhost:5174 \
bunx playwright test --workers=1
```

Failures by spec: `qa.playwright.ts` ~50, `fold.playwright.ts` 7,
`native/global-view.playwright.ts` 4, `video-playback.playwright.ts` 4,
`doodle-background.playwright.ts` 2.

**All admin, desktop, vendo, capture-harness and video-size specs passed**,
including `admin-appearance`, `admin-fold`, `desktop-admin`,
`desktop-auth-local`, `desktop-catalogue`, `theme-persistence`.

### Verdict: the qa failures are a LOADING-TIMEOUT ARTIFACT, not a regression
Evidence:
1. They reproduce in isolation and with a freshly restarted seed (93 pass /
   52 fail), so they are not run-order or seed pollution. `qa.playwright.ts`
   has its own `beforeEach` reset seam anyway.
2. Root cause in the log: `page.goto: Test timeout of 30000ms exceeded ...
   navigating to "http://localhost:5173/thecontrarian/dev-dropbox", waiting
   until "load"`, plus an empty geometry array (images never arrived).
3. The seed live-scans *remote public share links* (`.env.local`
   `MANORAMA_DEV_SOURCE_{ICLOUD,MEGA,DROPBOX,GDRIVE}`), so
   `/thecontrarian/dev-dropbox` holds **30 full-size originals** proxied from
   Dropbox at ~1–2 s and 1.8–3.7 MB each. The spec waits for `load`, i.e. every
   image, which exceeds the 30 s per-test timeout.
4. Decisive test — same tests, longer timeout:

```sh
GALLERY_URL=http://localhost:5173 GALLERY_VIDEO_SLUG=mixed-album \
bunx playwright test qa.playwright.ts \
  --grep 'drag pans the canvas one-to-one|strip keeps source proportions|touch upward swipe lifts' \
  --timeout=240000 --workers=1
# → 2 skipped, 7 passed (27.2s)
```

So the viewer behaviour is intact; the suite needs either a smaller seeded
album or a larger navigation budget. **This is the headline for the owner:
main is not regression-broken, but the committed matrix does not run green on
this machine as configured.**

Still to classify the same way (job `job_zKl4T9gu`, log
`/tmp/regress-rest.log`): `fold`, `native/global-view`, `video-playback`,
`doodle-background` with `--timeout=240000`. One suspect that is probably
genuine: `doodle-background.playwright.ts:140` asserts the background radios
are ordered Light/Dark/None but the first radio observed is `value="none"` —
an assertion/markup mismatch, not a load timeout.

## 2. The two standing preferences

- **Clean URLs / refresh resets to the first photograph — ALREADY SATISFIED.**
  `app/islands/Viewer.tsx:477` does
  `if (window.location.hash || window.location.search) history.replaceState(null, '', window.location.pathname)`.
  The opening index comes from the `initialIndex` prop (default 0) and is never
  persisted, so a reload always starts at the first frame.
  **Verify by test before changing anything.**
- **Gallery links open in a new tab — ALREADY SATISFIED in the dashboard's
  open action.** `app/islands/Admin.tsx` renders the open control as
  `<a class="admin-icon-action" title="Open gallery in a new tab"
  href={galleryPath(gallery.slug)} target="_blank" rel="noreferrer">`.
  Check whether any *other* gallery link (card title, sequence bubble, the
  native/desktop catalogue) still navigates in the same tab, and cover the
  contract with a test.

## 3. Deep links — mostly ALREADY IMPLEMENTED

Existing plumbing found:

- `ios/App/App/App.entitlements` declares
  `com.apple.developer.associated-domains` → `applinks:manorama.xyz`.
- `app/routes/[...src].tsx` serves `/.well-known/apple-app-site-association`
  with `appID: 373K7W3LKU.in.thecontrarian.manorama` and components:
  `/auth/*`, `/api/*`, `/.well-known/*` excluded; `/https://*` (wrapped public
  cloud imports) and `/*/*` (public galleries) claimed.
- The same route serves `/.well-known/assetlinks.json` for Android, gated on
  the `ANDROID_APP_LINK_SHA256` secret (503 while unset).
- The same catch-all is the quick-add interstitial for
  `manorama.xyz/<share URL>`, reassembling MEGA/iCloud fragments client-side in
  `app/quickadd.ts` and round-tripping `location.href` through `?next=`.
- Policy doc: `docs/native-gallery-links-vault-policy.md`; behaviour doc:
  `docs/manorama-operations.md` § "Quick-add links".

Gaps to close:
1. **Does the iOS app handle the delivered link?** Confirm the applinks
   delivery path (AppDelegate/SceneDelegate or a Capacitor listener) opens the
   two-segment gallery cold and warm, and delivers the wrapped-provider import
   intent (signed-out waits for sign-in).
2. **macOS has no `manorama.xyz` association** — only the custom scheme
   `in.thecontrarian.manorama.desktop://`. Add the associated-domains
   entitlement and a handler; note that universal links on macOS require a
   properly signed build (our test builds are ad-hoc signed), so this can only
   be proven with a real signing identity.
3. AASA is only effective when served from the real `manorama.xyz` over HTTPS —
   iOS never fetches it from localhost.

## 4. Environment

- Web dev server: port **5173** (`bun run dev --port 5173 --strictPort`),
  fresh-seeded service `job_lEoYnFzs`, log `/tmp/manorama-server-fresh.log`.
- Desktop bundle: port **5175** (`bun run dev:desktop`), service `job_7wvB3IKw`.
- Capture fixture: port **4182**, service `job_ThWOpRpS`.
- Native viewer fixture: port **5174**, service `job_T4fVM6uk`.
- Dev-server terminals here are repeatedly killed with SIGINT; each kill needs
  a device re-handshake before commands dispatch again.

## 5. Remaining work in this turn

1. Finish classifying `fold` / `native/global-view` / `video-playback` /
   `doodle-background` failures.
2. Prove the two preferences with tests; change code only where a gap exists.
3. Deep links: verify the iOS delivery path, add the macOS association.
4. Fresh **iOS build for a physical device** and a fresh **macOS build**.