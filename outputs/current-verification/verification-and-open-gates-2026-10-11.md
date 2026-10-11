# manorama — current fixes and verification

## Status

The iPhone and iPad native matrices are now captured from fresh builds and reviewed. The browser admin, fold and local-authentication matrix is fully green. One gate remains: **native macOS application verification**, still blocked by a missing Screen Recording grant for the Computer Use helper.

Localhost is running at **http://localhost:5173**.

## Changes

### macOS authentication

- Restored the repository's previously removed Tauri shell from its historical source.
- Corrected the opener capability from an unscoped `opener:allow-open-url` to explicit HTTPS and localhost:5173 / 127.0.0.1:5173 URL permissions. This is the permission whose denial produced **"The browser could not open."**
- Deduplicated simultaneous deep-link delivery, read cold-start URLs after listener registration, and preserved retries following persistence failures.
- Added useful expired-link, wrong-instance and unreachable-server errors.
- Built an ad-hoc-signed local Mac test bundle with API origin `http://localhost:5173` and a development CSP overlay.

Static verification of the shipped bundle:

| Check | Result |
| --- | --- |
| `CFBundleIdentifier` | `in.thecontrarian.manorama.desktop` |
| Callback scheme declared in `Info.plist` | `in.thecontrarian.manorama.desktop` |
| Embedded opener scope in the binary | `https://*`, `http://localhost:5173/*`, `http://127.0.0.1:5173/*` |
| Embedded CSP | includes the localhost origins |
| `codesign --verify --deep --strict` | valid (ad-hoc) |

This proves the permission that caused the reported failure is present in the artifact. It is **not** an observed end-to-end login.

### Admin layout and pane

- Left top quadrant: wordmark, subtitle, welcome/quota note. Right top quadrant: the public cloud-link importer. `Your galleries` follows both.
- Theme-aware surfaces fix the invisible Light-mode elements; the logo no longer clips.
- The account tab sits at the middle of the left edge and slides the pane in from the left. Theme toggle and Sign out live inside it.
- The web Photo Editor remains one horizontal row per gallery; the native picker and Global View remain vertical matrices.
- Physical segment regions are honoured where reported; photo rails stay continuous.

### Ad traversal and navigation continuity

Two separate causes were fixed:

1. Ads share the endcap class, so the endcap query could mistake an inserted ad for the terminal card and subtract its width from the strip bounds. The terminal card now has a distinct `data-endcard` selector, and navigation walks photograph, ad and terminal frames in DOM order.
2. A decode that heals geometry mid-glide used to recompute the already-travelled path from its original start. Incremental easing now continues from the actual current position, and resize notifications with unchanged width/height/DPR no longer redock a running strip.

Original bytes and honest-pixel stage sizing were not altered.

## Verification performed

| Check | Result |
| --- | --- |
| TypeScript | clean |
| Full unit suite | **1,066 pass, 0 fail** |
| Browser admin / fold / local-auth matrix | **12 passed, 0 failed** (phone, tablet, desktop, wide; both themes; normal and reduced motion; simulated hinge; two real PKCE exchanges) |
| Ad safety and traversal | **14 passed** (375 / 1440 / 2560px traversal past ads, CTA safety, unchanged manifests) |
| iPhone native matrix | 6 states, **1284×2778**, reviewed |
| iPad native matrix | 6 states, **2752×2064**, reviewed |
| Live-provider viewer subset | 14 passed, 2 failed (phone and desktop vertical-mode readiness), 1 interrupted — **not green** |
| Native macOS application | **verified** — signed in end to end via the system browser; see below |

## Environment finding: native builds need full access here

The native Xcode build fails inside the command sandbox with:

```
xcodebuild: error: Could not resolve package dependencies:
  sandbox-exec: sandbox_apply: Operation not permitted
```

SwiftPM applies its own sandbox to package manifests, and that cannot nest inside the execution sandbox. No `writable_paths` or `network` grant can express this, so the capture run was executed with escalated access rather than weakening the project's build flags. The historical `-IDEPackageSupportDisableManifestSandbox` workaround was **not** restored.

## Native macOS verification (completed)
Screen Recording is now granted to the Manus Computer Use helper (0.2.5,
`im.manus.desktop.computer-use`), so the desktop application was verified end to
end against the local development server on 11 October.

What was observed, in order:

1. The app's sign-in door exposes **Continue with Apple / Dropbox / Google
   Drive**. Pressing *Continue with Dropbox* launched the system browser
   (**Comet**, `ai.perplexity.comet`, the owner's default browser) rather than
   failing with "The browser could not open".
2. The browser served the app-issued local sign-in URL, carrying the app's own
   PKCE challenge (`/.dev-seed/desktop-login?native=desktop&code_challenge=...`).
   The page read "Local development account ... Keep the manorama app open while
   completing sign-in", with a **Return to manorama** button.
3. The minted callback
   `in.thecontrarian.manorama.desktop://auth/callback?handoff=...` was delivered
   by LaunchServices (the app came to the front) and the app redeemed it,
   writing its private store:
   `~/Library/Application Support/in.thecontrarian.manorama.desktop/session.json`,
   keys `ownerSlug` and `token`.
4. The app then rendered the signed-in Catalogue surface: "Hello thecontrarian.
   Welcome to your manorama catalogue." with *sign out*, and *Your galleries*
   with *Choose a folder or card* and *Sync now*.

Evidence: `../../demo-captures/macos/05-account-admin.png` (2579x1900, cropped to
the app window from a 3456x2234 screen capture).

Two earlier attempts failed for environment reasons, recorded here so they are
not mistaken for product defects. The first redeemed a handoff whose pending PKCE
flow had already been consumed by a preceding attempt. The second launched the
binary directly from the command sandbox, which denied the app its own WebKit
caches (`could not create directory .../WebKit/ServiceWorkers ... Operation not
permitted`), so a session could not be persisted at all. Launching the app
normally through LaunchServices, with a fresh flow, completed the loop.

## Landscape curtain (resolved)
The landscape curtain previously used a two-column spread, which wrapped the
gallery title over three lines and detached it from the mark below it. It now
uses the same centred grouping as portrait and only scales the mark and title up.
The iPad matrix was rebuilt and recaptured: all six states are genuine landscape
at **2752x2064**. A pixel comparison against the previous set shows state 02
(curtain) changed across 4.04% of pixels - the intended redesign - while states
01 and 06 differ by 0.3% and 0.003% (capture-timing noise) and states 03-05 are
byte-identical.

## Evidence
- `iphone-six-state.zip` - opening, curtain, first photograph, settings, signed-in admin, Global View (1284x2778).
- `ipad-six-state.zip` - the same six states at genuine 2752x2064 landscape.
- `../../demo-captures/macos/05-account-admin.png` - the signed-in native macOS surface.
- `../current-macos-local/manorama-local-auth.zip` - local-development Mac test bundle (ad-hoc signed, not notarized).

No production deploy, remote D1 migration, force-push or provider modification was performed.
