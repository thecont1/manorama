# manorama — current fixes and verification

## Status

The requested source fixes are implemented and the development server is running at **http://localhost:5173**. This is **not a release-complete declaration**: actual Mac app→browser→app authentication, the iPad landscape evidence matrix, and the full live-provider viewer acceptance matrix remain open.

## Changes

### macOS authentication

- Restored the repository's previously removed Tauri shell from its historical source, retaining its existing plugins and private-store implementation.
- Corrected the opener capability from an unscoped `opener:allow-open-url` to explicit HTTPS and localhost:5173 / 127.0.0.1:5173 URL permissions. The app uses the system-browser opener, never an embedded provider login.
- Deduplicated simultaneous deep-link delivery, read cold-start URLs after listener registration, and preserved retries following persistence failures.
- Added useful expired-link, wrong-instance and unreachable-server errors.
- Built and verified an ad-hoc-signed local Mac test bundle with API origin `http://localhost:5173` and a separate development CSP overlay.
- The explicit loopback build opens a **development-account browser door**, `/.dev-seed/desktop-login`. This creates a verifier-bound handoff and exercises the real PKCE exchange/session endpoint. It does **not** prove Dropbox/Google/Apple OAuth against production.

**Native authentication gate:** macOS Accessibility authorization was not available. The actual app→system browser→same app path has not been driven to completion. The rebuilt app is a test artifact, not a notarized distribution build. Open only one copy when testing: callback URLs must return to the instance holding the verifier.

### Admin layout and pane

- Left top quadrant: wordmark, subtitle and welcome/quota note.
- Right top quadrant: public cloud-link importer.
- `Your galleries` follows both; phone layouts stack these quadrants.
- Theme-aware foreground, surface, button and form colors fix the invisible Light-mode elements.
- Intrinsic logo width and container bounds prevent clipping.
- Removed repeated `Photo Editor` labels; web editor thumbnails remain one horizontal row. Picker/Global View retain their vertical matrices.
- The account tab protrudes from the middle of the left edge. The sliding pane traps focus, closes through Esc/backdrop/close, and returns focus to its trigger.
- Feature-detected physical segment regions constrain copy, import controls and the pane away from a simulated vertical hinge. Photograph rails remain continuous.
- Fixed WebKit native-pane Esc delivery after viewport resize by handling Escape on the live dialog as well as the document trap.

**Duo gate:** browser tests simulate fold geometry; no physical Duo or Duo simulator verification was performed. Wide-screen quadrant compatibility is not a substitute for native posture/hardware testing.

### Ad traversal and slight navigation jerk

Two separate causes were corrected:

1. Ads share the visual endcap class, so the old endcap query could mistake an inserted ad for the terminal card and subtract its width from strip bounds. The actual terminal card now has a distinct `data-endcard` selector. Navigation walks photograph, ad and terminal frames in DOM sequence.
2. An image decode can heal geometry while a navigation animation is running. Incremental easing continues from the actual current position instead of recalculating the already-travelled path from its original start. Resize notifications with unchanged width/height/DPR no longer redock a running strip.

Original image bytes and honest-pixel stage sizing were not altered.

### Dev-server and capture reliability

- Web, native and desktop each have their own Vite optimized-dependency cache. Concurrent builds no longer overwrite the same optimized modules.
- Hono's dev routing lets Vite serve the web optimizer assets.
- Capture outputs, MCP result files and native toolchain outputs are excluded from the web watcher so they do not restart authentication during testing.
- Development seeding/login errors and waits are bounded rather than silently hanging.
- Removed historical Xcode/SwiftPM sandbox-disabling workarounds. Native builds were performed with normal Xcode protections.
- iPad captures now fail if actual screenshot dimensions differ from **2752×2064**. Invalid portrait/letterboxed shots are not promoted to evidence.

## Verification performed

| Check | Result |
| --- | --- |
| TypeScript | `bunx tsc --noEmit` clean |
| Full unit suite | **1,066 pass, 0 fail**, 83 files, 20,089 assertions; explicit 15-second per-process test budget |
| Focused admin/auth/sizing units | **57 pass, 0 fail** |
| Production web build | Pass; existing large-chunk warning remains |
| Ad safety and traversal | **14 pass**; includes 375, 1440 and 2560px traversal past ads, terminal photograph, unchanged-resize glide continuity, CTA safety and unchanged manifests |
| Chromium admin/fold/local-auth matrix | **12 pass**; themes, logo bounds, edge tab, focus, reduced motion, single-row editor, simulated hinge regions and real local PKCE exchange |
| WebKit admin/fold matrix | 9 initial checks passed; native resize/Esc regression was identified and repaired. Strengthened native WebKit test then **passed** separately |
| Live-provider viewer subset | **14 pass**, **2 fail**, **1 interrupted**, **1 not run**; not green |
| iPhone native capture | All six states generated, **1284×2778**, reviewed and promoted |
| iPad native capture | Build passed. Capture still **2064×2752**, with a landscape app canvas letterboxed in a portrait simulator screen; rejected |
| macOS native bundle | Built, signature and ZIP integrity verified; native UI/authentication capture blocked by authorization |

The live-provider failures are phone and desktop vertical-mode tests waiting on `Display settings` while the page repeatedly navigates/reloads to `dev-dropbox`. The wide vertical case was interrupted rather than extending the run; the final wide C2PA case did not run. Phone and desktop C2PA checks passed their current panel contract, but that existing test accepts either credentials or the quiet unsigned state; it does **not independently prove cryptographic validation of a signed fixture**.

## Evidence

- `iphone-six-state.zip`: fresh opening, curtain, first photograph, settings, signed-in admin and Global View screenshots.
- `web-admin-theme-matrix.zip`: browser admin/pane evidence at phone, tablet, desktop and wide dimensions in Dark and Light themes. These are browser captures, not native Mac/iPad screenshots.
- `../current-macos-local/manorama-local-auth.zip`: local-development Mac test bundle.

No new native macOS six-state matrix is claimed. Previously checked-in iPad/macOS screenshots must not be interpreted as current evidence.

## Remaining work, in order

1. Authorize macOS app control and drive the rebuilt Mac app's sign-in through the system browser. Confirm the same instance receives the handoff and can access its authenticated account.
2. Rotate the iPad simulator through its supported UI, then capture all six states at actual **2752×2064**. A public scene-geometry experiment did not fix the portrait simulator screen and was removed; no private API or rotated screenshot was retained.
3. Resolve the live-provider vertical-mode readiness/reload behavior and rerun the complete viewer/input/mode matrix, including touch and an explicitly signed C2PA fixture.
4. Capture and review the native Mac six-state matrix from the current bundle.

No production deploy, remote D1 migration, force-push or provider modification was performed.
