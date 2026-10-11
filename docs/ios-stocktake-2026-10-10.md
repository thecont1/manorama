# manorama iOS — stock-take against the web app

**Date:** 10 Oct 2026 · **Branch:** `main` @ `2862ef7` · **Device:** iPhone 13 Pro Max simulator
(Xcode 27.1, iOS 26.5, 1284×2778 px @3×, 428×926 pt)

The web app is the reference. This report says where the iOS shell already matches it, where it
does not, what caused each difference, and what has been changed already.

---

## 1. How this was verified

I did not read code and guess. I built the app and drove it on a simulator, then photographed the
same surfaces on the web at an iPhone-sized viewport.

| | |
| --- | --- |
| iOS bundle | `bun run build:native` → `native/dist`, synced with `bunx cap sync ios`, built with `xcodebuild` for the iOS 26.5 simulator |
| Driving the app | `simctl` has no tap verb, so the states are reached from inside the page. `.work/stocktake/driver-server.ts` answers on the port the app's `server.url` already points at, serves the real `native/dist` **unmodified**, and injects one script that clicks and presses keys exactly as a finger and a keyboard would |
| Data | Live. The harness deliberately does **not** intercept `fetch`: the manifest and all 22 photographs come from `manorama.xyz` and its Dropbox proxy, as they do on a device |
| Web reference | `manorama.xyz/thecontrarian/italy` and `manorama.xyz/` in Chromium at 393×852 @3× DPR, mobile/touch emulation |
| Evidence | `.work/stocktake/ios/` (before), `.work/stocktake/ios-after/` (after), `.work/stocktake/web/` (reference) |

A useful side-finding: **images do load in the app.** The WebView mounted 22 frames and 29 `img`
elements, all decoded, first frame at its natural 2560×1707. The bundled capture harness
(`.work/capture-server.ts`) reports `firstImageWidth: 0` and never reaches `ready` on this commit,
which is a fault in the harness, not in the app. The new driver in `.work/stocktake/` replaces it
for this pass.

---

## 2. What already matches the web

- **The photograph itself.** Same bytes, same aspect, no crop, correct colour. The Dropbox proxy
  path works in the app exactly as in the browser.
- **The information sheet (`I`).** Section order, wording, values and the bordered `Close`
  affordance are identical to the web, down to `Position 1 / 22`, `File MS201810-Italy0005.jpg`,
  and the Content Credentials state. Side-by-side this is a match.
- **The picker (`G`).** The same photo matrix — thumbnails hanging closely, the active frame in
  shocking pink, header with `title · 22 photos` and `Close`. Verified identical after the fix in
  §4.1.
- **Display settings.** The same three sections (View mode, Background, then the action row) with
  the same copy.
- **Curtain.** Title, caption and dismissal behave as the web's does.

---

## 3. Where iOS diverges from the web

### D1 — Photographs render at two-thirds size and letterbox *(the big one)*

This is the first thing the eye sees side by side.

| | frame size | stage | result |
| --- | --- | --- | --- |
| **Web**, 393×852 @3× | 1278 × 852 CSS px | 852 tall | fills the screen, photograph runs under the status bar |
| **iOS app**, 428×926 @3× | 853 × 569 CSS px | 879 tall | 155 pt of black above and below every landscape |

**Cause.** `app/islands/Viewer.tsx:17`:

```ts
const deviceReportedDpr = typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || 'Capacitor' in window)
```

Inside the shell this is `true`, so `imageStageSize` receives `trustDeviceDpr` and uses the
uncapped `deviceImageDpr(3)`; the web uses `effectiveImageDpr`, which caps at 2. In
`packages/core/image-staging.ts:38` strip mode scales by `min(stageHeight / h, 1 / dpr)`:

- web: `min(852/1707, 1/2)` = **0.499** → full stage height
- app: `min(879/1707, 1/3)` = **0.333** → 569 px, letterboxed

**This is deliberate, not a regression.** The comment above the rule says a source without the
pixels for a full-height render *at this density* should "float shorter and centred rather than
fabricate pixels" — that is invariant #2 (never upscale) applied honestly. The consequence is that
on a 3× phone any source shorter than 2778 px is shrunk, and the owner's own gallery is 2560×1707
renditions, so it letterboxes by a third. On the web the same photograph is upscaled 1.5× to fill
the screen — the "perfect" web rendering is the less honest one.

**This needs your decision, so I did not change it.** Two options:

1. **Match the web** — stop passing `trustDeviceDpr` for Capacitor (keep it for Tauri, or drop it
   everywhere). One line, and the app instantly looks like the web; it also re-introduces a 1.5×
   upscale on 3× screens, which contradicts invariant #2 and `image-staging.test.ts`.
2. **Keep honest pixels, change the presentation** — accept the smaller render but drop the
   letterboxing: fill the vacated stage with the photograph's own blurred ground, or let the strip
   centre a short frame on a canvas that reads as intentional rather than as a bug. Preserves the
   invariant; costs a small amount of CSS.

My recommendation is **2 for the strip and 1 nowhere**: the invariant is load-bearing and the
project exists because of it, but a screen with a third of its height black reads as broken and
that is what a reviewer will see.

### D2 — A black band above the opening screen *(fixed — see §4.2)*

`rgb(10,10,10)` from y=0 to y≈150 px, then the landing's own `#111312`. Owner-reported.

### D3 — The chrome row: no way back, and a wide dead gap

The app's bottom row on a phone is `[ wordmark pill ][ 1 ][ → ]`, with `←` removed on narrow
viewports (`native/styles.css:1016-1047`). Measured on device: pill at x=12 w=182, bubble at
x=278, arrow at x=351 — **84 pt of empty space between the pill and the bubble**, and no back
control at all.

This is owner-directed work from 1 Oct ("the index is always a circle, so there is room for a more
elegant arrangement than three equal-width pills"). It has **never been photographed until now**:
`demo-captures/ios/03-first-image-hover.png` is from 30 Sep and shows the older
`[ ← ][ wordmark + 1 ][ → ]` row. The current arrangement is not yet an improvement on it.

Also, in the app the forward arrow is always visible (`alwaysShowNavigation` is passed by
`native/islands/GalleryList.tsx:481`), where the web hides arrows by default and offers
"show navigation arrows" in the modal. Same modal string appears in both, so the app is
permanently in the "arrows on" state.

### D4 — The app reports every photograph as 256 × 171 pixels *(shared with the web)*

Both the web and the app print `Dimensions 256 × 171` for a 2560×1707 photograph. The cause is in
the scanner, not the viewer — `app/lib/dropbox-public.ts:67`:

```ts
const response = await contentRequest('files/get_thumbnail_v2', {
  … size: 'w256h256', mode: 'strict',
}, env, fetchImpl)
const dimensions = parseJpegDimensions(new Uint8Array(await response.arrayBuffer()))
if (dimensions) return dimensions
```

It measures Dropbox's **256 px thumbnail** and stores that as the photograph's size, before the
ranged head-probe of the original (`sharing/get_shared_link_file`, `Range: bytes=0-131071`) that
would give the truth. Aspect is preserved, so nothing is mis-shaped — the count is simply wrong,
and it is wrong on the web too. This is a defect worth fixing independently of the iOS work.

### D5 — The curtain composes differently

The web holds the wordmark, title and caption as one centred block. The app splits them: wordmark
in the upper half, title and caption in the lower (`native/styles.css:4-28`). Deliberate; judge it
on `.work/stocktake/ios-after/01-curtain.png` against `.work/stocktake/web/iphone-01-curtain.png`.

### D6 — Minor

- The landing tagline wraps to two lines in the app and three in the browser (wider effective
  viewport once the WebView is full-screen). Cosmetic.
- The curtain's prompt/kicker line is absent in both, so no divergence.

---

## 4. Changes made in this pass

### 4.1 The native viewer now receives the gallery title

`native/islands/GalleryList.tsx` mounted `<Viewer>` without `galleryTitle`, so the picker header
and its `aria-label`s fell back to the slug. The web passes `galleryTitle={gallery.title}`
(`app/routes/[owner]/[slug].tsx`). One prop added.

*Verified:* picker header now reads `italia, amore mio · 22 photos`, matching the web exactly
(`.work/stocktake/ios-after/05-selector.png`).

### 4.2 The WebView paints under the status bar

The native root background (`#0a0a0a`) showed through the safe-area strip above any surface on a
lighter canvas. `capacitor.config.ts` and `native/main.tsx` now set `overlaysWebView: true`, and
`native/styles.css` paints the body to match whichever surface is mounted:

```css
body.manorama-native:has(.native-landing),
body.manorama-native:has(.native-list-shell) { background: #111312; }
```

The page already carries `env(safe-area-inset-top)` as body padding, so content stays clear of the
notch.

*Verified:* the opening screen is now a single `rgb(17,19,18)` field from y=0 — no seam. The
WebView reports `innerHeight` 926 (was 879), so it really is full-screen. The curtain now shows
the photograph behind it, as the web's does, because the stage covers the full viewport.

### Checks

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | clean |
| `bun run test:unit` | **1050 pass / 0 fail** (82 files) |
| `bun run build:native` | green |
| Simulator build + install + launch | green, both apps |

The first suite run showed 2 timeouts (`deterministic Vendo sync`, and a `(d1)` case in
`gallery-retention`). They were the sandbox artifacts `VERIFICATION.md` documents — a writable
`~/.wrangler` and a loopback bind — not regressions; with both granted the suite is green.

The working tree is 4 files, 19 insertions: `capacitor.config.ts`, `native/main.tsx`,
`native/styles.css`, `native/islands/GalleryList.tsx`. `native/dist` is ignored, so the rebuilt
bundle adds no commit noise. (These, and the rest of the work, are committed — see §7.)

---

## 5. What still needs doing

Ranked by what a viewer notices first.

| # | Item | Status |
| --- | --- | --- |
| 1 | **D1** — strip sizing on 3× screens | **Resolved** — the staging rule is untouched; the vacated canvas is presented as a mount. See §7. |
| 2 | **D3** — the chrome row's dead gap, missing back control, permanently-on arrows | **Resolved** — see §7. |
| 3 | **D4** — scanner records thumbnail dimensions | **Resolved** — `imageDimensions()` probes the original first; four tests in `app/lib/dropbox-public.test.ts`. |
| 4 | Re-run the six-state evidence matrix for iPhone, iPad and macOS (the current `demo-captures/` predate both the Oct 1 redesign and these fixes) | Outstanding |
| 5 | Repair `.work/capture-server.ts`, which no longer reaches `ready` on this commit | Outstanding — `.work/stocktake/driver-server.ts` replaces it for now |
| 6 | **D5** — curtain composition | Open, cosmetic |

### Not verified in this pass

Deliberately out of scope for a comparison pass, but they are part of the same claim and should be
checked before any "iOS matches the web" statement is made:

- the signed-in account/dashboard surface (`05` in the old matrix), the paywall, and Global View —
  all need a Keychain session the simulator cannot obtain, so the old harness seeded them and this
  pass did not
- iPad layout and the fold/diptych geometry
- vertical and one-at-a-time modes, video playback, the magnifier
- end-to-end C2PA *validation* (the panel renders and reports the correct state; the WASM verify
  path was not exercised)

---

## 6. Reproducing this

```sh
# 1. bundle + simulator apps (restores capacitor.config.ts on exit)
bash .work/stocktake/build-ios-app.sh

# 2. the driver, on the port the app's server.url points at
bun .work/stocktake/driver-server.ts &

# 3. install the harness app, then photograph states 0..4
bash .work/stocktake/shoot-ios.sh 0 1 2 3 4

# 4. the web reference
bun .work/stocktake/web-capture.ts iphone
bun .work/stocktake/web-capture2.ts
```

`xcodebuild` needs `~/Library/Caches/org.swift.swiftpm` writable, and `bun` needs
`BUN_INSTALL_CACHE_DIR` pointed inside the workspace — `$HOME` is read-only in this shell.

---

## 7. What was done after this stock-take

Five commits on `main`. The staging rule was not touched in any of them.

### D1 — the strip presents an honest-size photograph as a plate on a mount

`feat(viewer): present an honest-size photograph as a plate on a mount`

`imageStageSize` still decides the photograph's size from the source's dimensions against this
screen's format and density — that is the project's founding rule and nothing second-guesses it.
What changed is what the *frame* does with the room left over.

Previously the frame shrank to the staged size, which punched a hole in the strip: the strip is
one continuous canvas, so a short frame broke the run and the break read as a rendering fault.
Now the frame keeps the stage's full height and the photograph stays centred inside it at its
honest size. The canvas above and below is the mount, marked in the app's existing quiet
vocabulary:

- a **2.8% white lift** on the frame. Over the app's `#0a0a0a` ground that lands on `#111111`,
  the top of the range Rule 3 allows, and it stays correct on any ground a theme sets because it
  lifts whatever is behind it instead of naming a tone. (`--gallery-canvas` was the wrong source:
  it is `transparent` for the default "no background" gallery, so mixing into it produced
  nothing.)
- a **hairline at the photograph's own edge**, `rgba(var(--ink), .14)` — the same rule the modal
  and every divider use.

No colour, no rounding, no shadow: Rule 3 allows a photograph none of them.

*Measured on device:* frame 853 × 926 CSS px (full stage), photograph 853 × 569 at `y=226` —
centred, unchanged in size; mount `rgb(17,17,17)` above and below; hairline present at the
plate's top and bottom edges.

### D3 — the bottom control row

`fix(native): centre the bottom control row and let the modal own the arrows`

The wordmark was pinned to the row's leading edge, leaving 84 pt of dead space, and the forward
arrow was forced on by `alwaysShowNavigation`, so the modal's "show navigation arrows" toggle
could not turn it off. The wordmark now centres on the stage — in the room the circles leave when
arrows are shown — and the arrows follow the web's default.

Centring uses `left: 0; right: 0; margin-inline: auto` with a `fit-content` width rather than a
transform, because this button paints its own bar: a stretched box turned that bar into a
full-width rule across the bottom of the stage. *Measured on device:* pill at x=120 w=189 (centre
214.5 — the stage centre), position circle at x=340, no overlap, no dead gap.

The same commit passes `galleryTitle` to the viewer, which the web mount always did.

### D2 — the status-bar strip

`fix(native): paint the WebView under the status bar`

### D4 — the scanner

`fix(dropbox): resolve dimensions from the original, not the 256px preview`

Resolution order is now `media_info` → a ranged read of the original's head → the preview, which
survives only as the last resort. Four tests, including one that asserts the preview is still
fetched as the placeholder rendition but is barred from answering how big the photograph is.

### Checks after the changes

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | clean |
| `bun run test:unit` | **1054 pass / 0 fail** (83 files) |
| Simulator build, install, launch | green |
| Strip, chrome and mount measured on device | as recorded above |

One caveat on the suite: across four runs it reported a single 5 s timeout twice, in different
places, and was green the other times. Both were the miniflare-backed specs `VERIFICATION.md`
already flags. Not attributable to these changes, but not fully explained either.
