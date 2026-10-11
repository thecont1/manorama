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
| Native macOS application | **not verified** — see below |

## Environment finding: native builds need full access here

The native Xcode build fails inside the command sandbox with:

```
xcodebuild: error: Could not resolve package dependencies:
  sandbox-exec: sandbox_apply: Operation not permitted
```

SwiftPM applies its own sandbox to package manifests, and that cannot nest inside the execution sandbox. No `writable_paths` or `network` grant can express this, so the capture run was executed with escalated access rather than weakening the project's build flags. The historical `-IDEPackageSupportDisableManifestSandbox` workaround was **not** restored.

## Remaining gate: native macOS verification

The Computer Use helper reports `permissions_required`:

- Accessibility: **granted**
- Screen Recording: **missing**
- Helper: Manus Computer Use 0.2.5, `im.manus.desktop.computer-use`
- Path: the version-numbered `manus-computer-use/1.0.25/helper/darwin/Manus Computer Use.app`

A grant to Manus Studio or Manus itself does not satisfy this, and a grant to an earlier versioned helper path does not carry over. Until it is granted, the app → system browser → app login cannot be observed end to end, and no native macOS six-state matrix can be captured.

There is **no headless alternative**: `xcrun simctl ui` supports only appearance and contrast (no orientation verb), and DeviceHub ships no scripting dictionary. The iPad rotation that unblocked the iPad matrix was performed manually by the owner in DeviceHub.

## Observation for owner decision

The landscape curtain uses its two-column composition (logo left, title right). With the large title treatment the gallery title wraps to three lines — "italia," / "amore" / "mio" — where the portrait composition shows it on one line. The portrait grouping fix does not apply to landscape. This is a presentation judgement call, not a defect: it can either stay as an editorial two-column spread or adopt the portrait grouping with a capped title size.

## Evidence

- `iphone-six-state.zip` — opening, curtain, first photograph, settings, signed-in admin, Global View (1284×2778).
- `ipad-six-state.zip` — the same six states at genuine **2752×2064** landscape.
- `../current-macos-local/manorama-local-auth.zip` — local-development Mac test bundle (ad-hoc signed, not notarized).

No production deploy, remote D1 migration, force-push or provider modification was performed.