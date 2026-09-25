# manorama native — launch plan (Shipaton, ship by Sep 26 2026)

Status: plan. Owner: Mahesh. Written 2026-09-22.

This document is the working brief for coding agents. It is deliberately split into
**Track SHIP** (must be in the binary that goes to review) and **Track GROW** (lands after
submission, drives the post-release growth story). Agents must not pull GROW work into
SHIP scope without an explicit instruction.

---

## 0. The deadline arithmetic

| Date | Event |
| --- | --- |
| Tue Sep 22 | Plan approved, dev accounts confirmed, repo scaffolded |
| Wed Sep 23 | Capacitor shell runs the existing viewer on device |
| Thu Sep 24 | Vault + RevenueCat + ads functional |
| Fri Sep 25 | Store assets, privacy manifest, internal build on TestFlight |
| **Sat Sep 26** | **Submit to App Store review + Galaxy Store** |
| Sep 27–29 | Review buffer; fix any rejection and resubmit |
| **Wed Sep 30** | **Hard deadline — app must be RELEASED, 11:45 PM PDT** |

Shipaton requires the app to be a brand-new release to the App Store, Google Play, or the
Samsung Galaxy Store between Aug 1 and Sep 30 2026, and to use the RevenueCat SDK to power
at least one in-app purchase **or** serve ads through RevenueCat Ads
([RevenueCat](https://www.revenuecat.com/blog/company/announcing-shipaton-2026)).
Submission closes Sep 30 at 11:45 PM PDT, with judging Oct 1–13
([The App Launchpad](https://theapplaunchpad.com/blog/revenuecat-shipaton-2026/)).

Set the App Store release to **manual** so release date is under our control, then release
the moment approval lands — do not let an automatic release slip past Sep 30.

Owner-only setup — Apple, RevenueCat, AdMob, the Mac — is sequenced in
[`docs/owner-setup-runbook.md`](./owner-setup-runbook.md).

### Two blockers that must be cleared today, before any code

1. **Apple Developer Program membership.** Individual enrollment is normally 24–48 hours to
   1–3 days ([Webtonative](https://www.webtonative.com/blog/apple-developer-program-enrollment)),
   but developers in 2026 have reported multi-week waits with no communication
   ([Apple Developer Forums](https://developer.apple.com/forums/thread/822540)). If the account
   is not already active, iOS cannot be the primary target this week.
2. **Google Play is out.** A new personal Play account faces the 12-tester / 14-day closed
   testing gate. It cannot complete by Sep 30. Do not spend an hour on it.

**Therefore: iOS is the target. Android exists only as break-glass.**

- **Primary — Apple App Store, iOS and iPadOS.** Fast review, and the platform manorama is
  aesthetically for. All ship-week effort goes here.
- **Break-glass — Samsung Galaxy Store.** One caveat worth stating plainly: Galaxy Store is
  only "an easier route" if an Android binary already exists. So `npx cap add android` stays in
  scope (task A4) and the Android project must remain buildable — but it gets no polish, no
  store metadata, and no attention unless Apple membership stalls. Generating it is an hour of
  insurance against being locked out of Shipaton entirely; if the Apple account clears, Android
  goes back in the drawer until Nearby Discovery is ready.
- **Android as a real platform** is deliberately post-Shipaton, shipped together with Nearby
  Discovery, where time is not a constraint.

---

## 1. Architecture decision (read before writing code)

manorama is HonoX SSR on a Cloudflare Worker. A Capacitor app cannot SSR. **Do not point a
native WebView at `manorama.xyz`** — that is the "lazy wrapper" that Guideline 4.2 rejects.

The build becomes three-headed off one codebase:

```
packages/core        extracted from app/lib — ImageSource, GalleryMediaItem, scanners,
                     sizing math, gallery-settings. Zero platform imports. Pure TS.
app/  (worker)       unchanged. HonoX SSR, /api/*, proxy routes. The portable web viewer.
native/  (new)       vite --mode native → static SPA. Mounts Viewer.tsx + native shell.
                     Bundled into the app; talks to the Worker's /api/* over HTTPS.
```

The native SPA is offline-first: it boots from bundled assets and its local vault, never from
the network. That single property is what makes it a real app rather than a wrapped site.

**Agent lane discipline.** Each task below names the files it owns. No two concurrent agents
may write the same file. `packages/core` extraction (task A2) blocks everything else and must
land first, alone.

---

## 2. Track SHIP

### A. Shell and core extraction

| ID | Task | Owns | Done when |
| --- | --- | --- | --- |
| A1 | Confirm Apple + Samsung seller accounts active; reserve bundle id `in.thecontrarian.manorama`; create App Store Connect record | — | Bundle id reserved, app record exists |
| A2 | ~~**Blocking.** Extract `packages/core` from `app/lib`~~ **✓ landed on `feat/native-core`.** `imagesource.ts`, `image-dims.ts`, `image-staging.ts` (the DPR cap and stage-sizing math) and `gallery-settings.ts` now live in `packages/core`, with `app/lib/*.ts` re-export shims so no Worker or test import changed. 449 tests pass, `tsc --noEmit` clean, `bun run build` green | `packages/core/**` | Done |
| A2b | Next extraction slice, **not** blocking: lift the stage-geometry helpers out of `app/islands/Viewer.tsx` into `packages/core/sizing.ts`. Riskier — `Viewer.tsx` is the largest island — so do it as its own PR with the Playwright matrix green before and after | `packages/core/sizing.ts`, `app/islands/Viewer.tsx` | Matrix green, no behaviour change |
| A3 | `vite build --mode native` → static SPA in `native/dist`. New entry mounts `Viewer.tsx` and a `GalleryList` shell. Auth via the existing Dropbox OAuth in a system browser (ASWebAuthenticationSession / Custom Tabs), session token into secure storage | `native/**`, `vite.config.ts` | `bun run build:native` emits a bundle that opens a gallery with no Worker SSR |
| A4 | Capacitor init; `npx cap add ios`; `npx cap add android`. Icons, splash, safe-area insets, status bar. Verify on a physical iPhone and an Android emulator | `capacitor.config.ts`, `ios/**`, `android/**` | App launches and views a gallery on device |

Capacitor plugin set — all first-party or actively maintained:
`@capacitor/preferences`, `@capacitor/filesystem`, `@capacitor/share`,
`@capacitor/browser`, `@capacitor-community/admob`, `@revenuecat/purchases-capacitor`.

### B. Monetisation — RevenueCat, and two ad placements

This is the Shipaton eligibility gate *and* a run at the new Catvertising Award.

**The north star, stated for the record.** The ambition is the WIRED magazine era, when a
full-page ad was as good to look at as the editorial was to read, and was art-directed in
house. A manorama ad server that delivers that is a project for after Shipaton. For now we
**rent the inventory and own the frame** — the creative is somebody else's, but the mount,
the typography, the pacing and the surrounding canvas are ours.

**The privacy rule:** non-personalised ads only. Ship UMP consent and App Tracking
Transparency through the plugin, default to non-personalised, do not request IDFA. The plugin
covers UMP consent and ATT helpers on iOS
([capacitor-community/admob](https://github.com/capacitor-community/admob)).

#### Placement 1 — the plate: house creative on a seeded ~25-image cadence

House plates enter the strip like a photograph does — mounted as a borderless faux
frame in the same language as the "The End." card. Rules, all testable:

1. **Cadence, not rotation.** A plate lands around every 25th photograph, jittered
   ±4 positions from a seeded draw so it never reads as a metronome — never the
   first frame, never the last, never two adjacent.
2. **The draw re-rolls per gallery per UTC day.** `platePositionsFor(count,
   slug:date)` is deterministic inside the day — a re-opened strip keeps the
   morning's layout — and re-seeded tomorrow. Short galleries fall below the
   first window (~21st image) and simply carry no plate.
3. **Runtime-only insertion.** Positions are composed into the runtime sequence;
   the plate is **never written into `imagesJson`**. The stored manifest stays the
   photographer's record, and a tier change needs no migration.
4. **Not counted.** Position readout, item numbering and keyboard stepping count
   photographs. "7 of 24" never includes an ad.
5. **Dressed like the endcard.** A plate is the same borderless faux frame as
   "The End." — stable plain canvas, wordmark display face, honest size, never
   stretched, cropped or upscaled to fill the stage. The disclosure badge keeps
   the small quiet type.
6. **Labelled in the existing quiet vocabulary.** AdMob requires a visible
   `Ad` / `Advertisement` / `Sponsored` badge of at least 15px, rendered in your
   own code for native formats, plus the AdChoices overlay
   ([AdMob](https://support.google.com/admob/answer/6329638)). House plates carry
   the same label — `Sponsored`, not "ad-free-looking editorial."
7. **Click safety — the most important line in this section, now per plate.** A
   CTA arms only while *its own* plate is dead-centre on the stage with the strip
   at rest; taps during a drag or glide stay inert even though they stop the
   motion. A swipe-through strip is an accidental-click machine, and invalid
   click traffic gets AdMob accounts suspended; this is a ban risk, not polish.
8. **`I` on a plate** shows the advertiser, not EXIF. No C2PA claim is ever
   implied for an ad.
9. **Every tier sees house plates; Pro is house-only.** The cadence applies to
   all users, but the AdMob adapter is never consulted for Pro — the house
   plate *is* the Pro creative. Book pose suppresses the cadence entirely: a
   diptych spread cannot carry a plate.
10. **The master user holds the kill switch.** Plates are suppressed when the
    owner toggles them off for the day or for the viewer's region — the region
    decision arrives via the Worker (geo-IP), with an explicit "show" fallback
    when the region can't be determined.

#### Placement 2 — the account page slot

Top-right of the dashboard header, opposite the logo and welcome line. One fixed
slot, no rotation while the page is open, rendered inside manorama's own type
scale so it reads as part of the page's design rather than an injection. **Native
app only** — the web dashboard stays clean. Every resolved tier sees it (the
creative follows the same rule as the strip: Pro gets the house frame), and the
master switch suppresses it together with the strip plates.

#### Format reality, and the seam to the in-house server

`@capacitor-community/admob` supports banner, interstitial, rewarded, rewarded interstitial and
app-open formats — **not native advanced**. Native-ad support was requested twice and closed
without landing ([#110](https://github.com/capacitor-community/admob/issues/110),
[#333](https://github.com/capacitor-community/admob/issues/333)). Native advanced is the format
that hands you unstyled assets — headline, image, advertiser, call to action — to compose
yourself, and it is the only route to a plate that genuinely looks art-directed.

So define the seam now, adapter-style, exactly as `ImageSource` already does for media:

```ts
// packages/core/adframe.ts
export interface AdFrame {
  id: string
  advertiser: string
  headline?: string
  image?: { src: string; width: number; height: number }
  cta?: { label: string; url: string }
  badge: 'Ad' | 'Advertisement' | 'Sponsored'
  provider: 'admob-banner' | 'admob-native' | 'manorama-house'
}
```

Three adapters, in order of arrival — the viewer only ever knows `AdFrame`:

| Adapter | When | What it is |
| --- | --- | --- |
| `admob-banner` | **This week** | A 300×250 medium rectangle mounted inside the plate. Zero plugin risk; ships with the supported plugin. The mount is ours, the rectangle is rented. |
| `admob-native` | October | Either `capacitor-admob-ads`, or ~150 lines of Swift wrapping `GADNativeAd` as a first-party plugin. iOS-only scope makes writing it cheap. |
| `manorama-house` | Later | Your own inventory, your own typography. The WIRED idea, properly. The interface does not change. |

| ID | Task | Owns | Done when |
| --- | --- | --- | --- |
| B1 | `npm install @revenuecat/purchases-capacitor && npx cap sync`; configure API keys; wire the existing `tier` column to entitlement `pro` ([RevenueCat docs](https://www.revenuecat.com/docs/getting-started/installation/capacitor)) | `native/lib/billing.ts` | `customerInfo.entitlements.active.pro` gates vault size and ads |
| B2 | Products in App Store Connect: `manorama_pro_monthly`, `manorama_pro_yearly`, `manorama_forever` (one-time). Offerings configured in the RevenueCat dashboard | dashboard only | Products fetch on device |
| B3 | Paywall: **Free** (3 galleries, small vault, house + network plates on the cadence, account slot), **Pro** (99 galleries, unlimited vault, house plates only — no third-party ad network — P2P host later), **Forever** (one-time). Copy plain and unhurried; no countdown timers, no dark patterns | `native/islands/Paywall.tsx` | Purchase → entitlement → Pro creative is the house frame, verified end to end in sandbox |
| B4 | `AdFrame` interface + `admob-banner` adapter + the seeded cadence composer. Implements rules 1–10 above | `packages/core/adframe.ts`, `native/lib/ads.ts` | Plates land on the seeded ~25-image cadence (deterministic per gallery-day), absent below ~22 items, house-only for pro |
| B5 | **Server seam.** RevenueCat webhook → Worker endpoint → `setUserTier` (the existing trusted seam that also promotes unexpired pipeline galleries). Never write the D1 `tier` column directly | `app/routes/api/revenuecat-webhook.ts` | Sandbox purchase promotes pipeline galleries in one idempotent batch |
| B6 | Account page slot, native dashboard header top-right | `native/islands/GalleryList.tsx` | Renders for every resolved tier (house creative for pro), hidden while entitlement is unresolved |
| B7 | **House fallback plate** — a designed manorama plate shown when no paid ad fills. Cheap, and it means the slot is never an empty void, including in front of an App Store reviewer whose test device may fill nothing | `native/lib/ads.ts` | Ad-fill failure shows the house plate, not a blank frame |
| B8 | Playwright: seeded cadence + per-day re-roll, endcard styling, suppression in short galleries, exclusion from the position readout, inert-while-moving click safety, per-plate arming when several ride the strip, pro gets the house plate, manifest left unmodified | `native/ads.playwright.ts` | All assertions green |

`setUserTier` already handles tier + pipeline promotion atomically. B5 must call it and nothing
else — a direct `tier` UPDATE would leave a pro account with locked galleries.

B7 is worth its small cost twice over: it removes the blank-frame failure mode, and it is the
first brick of the house ad server — a plate promoting another photographer's gallery on
manorama is both a decent ad and a growth loop.

### C. The local encrypted vault — the differentiator and the 4.2 defence

Guideline 4.2 rejects apps "not sufficiently different from a mobile web browsing experience"
([Base Terms](https://www.baseterms.com/rejections/guideline-4-2-minimum-functionality)), and
reviewers look for genuine native utility rather than a feature checklist
([Accept My App](https://acceptmy.app/guides/app-store-rejected-minimum-functionality)).
Offline mode plus on-device storage plus native purchase is the answer. It also happens to be
the feature the web app can never have, which is the whole strategic point.

| ID | Task | Owns | Done when |
| --- | --- | --- | --- |
| C1 | Vault schema: SQLite (or Filesystem + index) at app-support, excluded from iCloud/Drive backup. AES-256-GCM per-gallery, key in Keychain / Android Keystore, generated on first run, never leaves the device, never synced | `native/lib/vault.ts` | Unit tests cover write/read/evict/corrupt-entry recovery |
| C2 | Thumbnail derivation **on device** from the provider stream — decode, downscale to the vault tier, encrypt, discard the original bytes. Nothing is uploaded. Respects the no-upscale rule: a source short on pixels stores its honest size | `native/lib/thumbs.ts` | A 200-item gallery caches with bounded memory; no temp plaintext survives |
| C3 | Offline gallery open: airplane mode → previously viewed gallery opens from the vault at thumbnail fidelity, upgrading to full resolution when connectivity returns. Clear, calm offline indicator | `native/islands/GalleryList.tsx` | Airplane-mode cold launch opens a cached gallery |
| C4 | **Global view.** Grid of every frame in the gallery, vault-backed, tap to enter the stage at that frame. Free tier: current gallery only. Pro: every gallery. Off by default, and honest about what it is | `native/islands/GlobalView.tsx` | Grid renders 500 items at 60fps from vault, zero network |
| C5 | Vault settings: size cap, per-gallery purge, "forget everything" that zeroes the key. Surface actual bytes used | `native/islands/VaultSettings.tsx` | Purge is verifiable on disk |

### D. Display truth

| ID | Task | Owns | Done when |
| --- | --- | --- | --- |
| D1 | `CADisableMinimumFrameDurationOnPhone = true` in `Info.plist` to unlock ProMotion; instrument a `requestAnimationFrame` counter in a debug overlay to prove 120Hz on device. **Do not use private WebKit `_features` APIs** — App Store rejection ([tauri-plugin-macos-fps](https://github.com/userFRM/tauri-plugin-macos-fps)) | `ios/App/App/Info.plist`, `native/lib/fps-probe.ts` | Overlay reads ~120 on a ProMotion iPhone |
| D2 | Colour management: declare wide-gamut, author stage chrome in `color(display-p3 …)` behind `@media (dynamic-range: high)` / `(color-gamut: p3)`, and pass image ICC profiles through untouched — the pipeline already refuses recompression | `native/styles/display.css` | A P3 test target renders saturated on an XDR panel, clamps gracefully on sRGB |
| D3 | HDR: pass gain-map JPEG/AVIF straight through; WebKit shipped HDR images in 2025 ([WWDC25](https://developer.apple.com/videos/play/wwdc2025/233/)). **Do not trust `dynamic-range: high` alone** — it has reported false positives ([WebKit #254489](https://bugs.webkit.org/show_bug.cgi?id=254489)). Gate on a rendering probe, and keep gain-map files safe on SDR ([Greg Benz](https://gregbenzphotography.com/hdr/)) | `native/lib/hdr.ts` | Gain-map image shows headroom on XDR, correct on SDR |
| D4 | Raise the DPR cap on native: the web viewer caps effective DPR at 2 to avoid claiming pixels that do not exist. On device the true scale factor is knowable, so cap at the real value instead. The no-upscale invariant stays | `packages/core/sizing.ts` | Existing sizing tests pass; native reports true DPR |

### E. Fold-aware layout (iPhone Duo and existing Android foldables)

One diptych implementation, two detection paths. Book pose shows a **spread** — two frames,
hinge as the centre line of the mount. This is the showpiece, and it is genuinely photographic
rather than a gimmick.

Apple's guidance: design for two size classes (compact outer, regular inner) rather than a
layout per pose, use layout margins and safe-area insets, avoid fixed widths, and note that
continuously scrolling content is exempt from fold displacement
([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo),
[Tech Talks](https://developer.apple.com/videos/play/tech-talks/111466/)). Strip mode is
scrolling content and therefore already compliant. Full-edge layout needs Xcode 27.1
([Blake Crosley](https://blakecrosley.com/blog/iphone-duo-for-developers)); design kits are
published ([Apple Developer](https://developer.apple.com/news/?id=nyuppv9r)).

Android foldables expose `@media (horizontal-viewport-segments: 2)` with
`env(viewport-segment-width …)` in Chromium; Safari does not support it yet, so feature-detect
([Smashing Magazine](https://www.smashingmagazine.com/2022/03/building-web-layouts-dual-screen-foldable-devices/),
[bug0](https://bug0.com/blog/how-to-make-a-website-mobile-friendly-in-2026)).

| ID | Task | Owns | Done when |
| --- | --- | --- | --- |
| E1 | Diptych mode in the viewer: two frames, gutter aligned to the fold, no cropping or upscaling of either frame; falls back to one-at-a-time on a single segment | `native/islands/Diptych.tsx` | Renders correctly in Chrome's foldable emulation at 2 segments |
| E2 | Segment detection: viewport-segments on Chromium, size-class + safe-area on iOS. Interactive controls displace off the fold; the scrolling strip does not | `packages/core/fold.ts` | Playwright covers 1-segment and 2-segment layouts |
| E3 | Duo polish once Xcode 27.1 is installed: build against iOS 27.1 SDK, verify vertical bar behaviour, confirm no control lands in the hinge | `ios/**` | Duo simulator clean in all poses |

E3 is P1 — ship without it if Xcode 27.1 is not installed by Sep 25. E1 and E2 are pure CSS/TS
and testable on the desktop today, so they can land regardless.

### F. Store submission

| ID | Task | Done when |
| --- | --- | --- |
| F1 | Privacy: App Privacy questionnaire + `PrivacyInfo.xcprivacy`. The honest answer is strong — metadata only server-side, pixels never leave the device. Say so plainly | Submitted, matches the existing privacy policy |
| F2 | Screenshots: 6.9" and 6.5" iPhone, 13" iPad. Use real photographs at full bleed. This is a photography app; the screenshots are the pitch | Approved set uploaded |
| F3 | **Reviewer notes** explicitly listing the native capabilities that clear 4.2: encrypted on-device vault, full offline operation, global view, native IAP, native share, ProMotion/P3 rendering. Include a demo account and a sample gallery link | Written into App Review Information |
| F4 | **Conditional — only if Apple membership has not cleared by Sep 24.** Galaxy Store: seller account, tax/bank verification upfront, store-specific metadata (not copy-pasted from Apple), signed AAB, IAP in production mode | Submitted, or formally skipped |
| F5 | Manual release configured; release triggered immediately on approval | Live before Sep 30, 11:45 PM PDT |

---

## 3. Track GROW (starts Sep 27, drives the Build & Grow story)

Judging runs Oct 1–13 and the Grand Prize rewards post-release traction, so shipping on Sep 26
leaves two weeks of legitimate growth work that is itself part of the entry.

### G. Presence — nearby discovery and synchronised viewing

The plane scenario: internet off, Bluetooth on, manorama finds other manorama galleries in the
cabin. Feasible and delightful, but it is the single riskiest item in the whole plan — it needs
a native plugin, two different OS frameworks, and physical multi-device testing. **It must not
be in the submission build.**

- Android: Nearby Connections works peer-to-peer regardless of network connectivity, and a
  Capacitor plugin exists ([capacitor-nearby-connections](https://github.com/trancee/capacitor-nearby-connections)).
- iOS: Multipeer Connectivity, needing `NSLocalNetworkUsageDescription` and `NSBonjourServices`
  ([Apple](https://developer.apple.com/documentation/nearbyinteraction/discovering-peers-with-multipeer-connectivity)).
- A tiered Nearby-Connections-plus-Multipeer precedent for large offline transfers already
  exists ([@picsa/capacitor-offline-transfer](https://libraries.io/npm/@picsa%2Fcapacitor-offline-transfer)).

Design notes: discovery is **opt-in per session and ephemeral** — you raise a hand to be found,
and it lapses. No persistent broadcast, no identity beyond a chosen display name. Synchronised
viewing is host-led: the host advances a frame and the room advances with them. Pro hosts,
anyone joins.

### H. Local compute — curation

Perceptual hashing for near-duplicate collapse, on-device embeddings for "find frames like this
one" and sequencing suggestions. All local, nothing leaves the device, no vectors uploaded. The
vault (C1) is the prerequisite, which is another reason it ships first.

### I. Desktop

Tauri for macOS and Windows: folder and memory-card ingest, watch folders, the studio half of
the product. Mac App Store distribution via notarisation. Deliberately post-Shipaton.

---

## 4. Guardrails for agents

1. **Never persist image bytes or thumbnails server-side.** The Cloudflare side stays
   metadata-only. Any change that puts pixels in D1, R2, or KV is wrong by definition.
2. **Never upscale, recompress, crop, or re-encode a source image.** The honest-size rule and
   ICC/C2PA passthrough are load-bearing product values, not implementation details.
3. **Ads obey the plate rules (B, rules 1–10) and are enforced by tests, not convention.** One
   per gallery, midpoint, never first or last, never in `imagesJson`, never counted in the
   position readout, never stretched or cropped, never tappable while the strip is moving,
   never present for pro.
4. **No private Apple APIs.** Any frame-rate or WebView trick that touches `_features` is
   forbidden — it is an automatic Mac App Store rejection.
5. **Tier changes go through `setUserTier`.** Never a bare `tier` UPDATE.
6. **No ambient surfaces.** No screensaver, widget, Lock Screen, StandBy, or Vision Pro work.
   manorama is a place people come to with the intent to look at photographs. Out of scope,
   permanently, unless the owner says otherwise.
7. **Keep `bunx tsc --noEmit` and `bun test` green on every commit.** The Playwright matrix
   (375×812 touch, 1440×900, 2560×1440) gains a foldable 2-segment viewport.
8. **The web app receives no feature requiring persistence.** It is the portable version, and
   its forgetfulness is intentional.

## 5. Cut list, in order

If Sep 25 arrives and the build is not submittable, drop in this order and no other:
E3 (Duo SDK polish) → B6 (account slot) → C4 (global view) → D3 (HDR) → C5 (vault settings) →
D4 (DPR cap).

Never cut: A2–A4 (shell), B1/B3/B4/B7/B8 (eligibility and ad safety), C1–C3 (vault and offline —
the 4.2 defence), D1 (one plist line), F1–F3/F5 (submission).

**B7 was promoted out of the cut list on Sep 22.** A new AdMob app stays in limited ad serving
until it is published and store-linked, so the plate will barely fill before launch. Without a
house plate a reviewer sees an empty frame, and Shipaton eligibility shifts onto the IAP (B3)
rather than RevenueCat Ads. Owner-side prerequisites are in
[`docs/owner-setup-runbook.md`](./owner-setup-runbook.md).
