# Submission state — 1 Oct 2026, 02:28

## Screenshots: the iOS set is now correct

`screens/ios/` — all six are **1284×2778**, the size the ASC dialog asks for.

| File | Captured | Content |
| --- | --- | --- |
| `01-opening-screen.png` | 02:22 | opening screen, real content |
| `02-gallery-curtain.png` | 02:27 | curtain, giant background wordmark gone |
| `03-first-image.png` | 02:27 | strip; three-control row, no previous arrow |
| `04-controls-popover.png` | 02:27 | display-settings modal |
| `05-account-admin.png` | 30 Sep 23:06 | **stale** — needs a signed-in session |
| `06-global-view.png` | 30 Sep 23:06 | **stale** — needs the owner's photo library |

01–04 came from the iOS 26.5 build of the current source. 05 and 06 cannot be
regenerated on this machine; see the blocking constraint below.

### What renders, and what does not

| Simulator | Runtime | Result |
| --- | --- | --- |
| **iPhone 13 Pro Max** | **iOS 26.5** | **renders correctly at 1284×2778** |
| iPhone 17 Pro Max | iOS 27.0 | renders correctly, 1320×2868 |
| iPad Pro 13-inch (M5) | iOS 27.0 | renders, but portrait 2064×2752 only |
| iPhone 13 / 14 Pro Max, 16 Pro | iOS 27.0 | **black frames** |

The black frames were a runtime/device-type mismatch: older device types do not
render on the iOS 27 runtime. Boot the capture device on **iOS 26.5** and it works.
This is the single most important fact in this file.

### Known-good frames still on disk (1320×2868, real content)

```
/tmp/cap-ios-01.png          opening screen
/tmp/burst-iphone/05.png     gallery curtain
/tmp/burst-iphone/07.png     first image with controls
/tmp/burst-iphone/10.png     controls popover
```

## The pipeline

- `.work/capture-server.ts` — state-driven harness. Serves the real `native/dist`
  bundle and injects a driver that dispatches the clicks a finger would. The state
  is chosen over HTTP (`GET /state/<n>`) before each launch, so captures are
  deterministic rather than timing-dependent.
  - `0` curtain · `1` curtain dismissed · `2` controls popover
- `scripts/capture-screens.sh` — the pipeline: builds the bundle, builds the
  harness app (temporarily setting `server.url`, restored by a trap), builds the
  plain app, boots the device, then captures 01–04 into
  `/Users/home/DEV/manorama-submission/screens/{ios,ipad}/`.
  - `--device iphone|ipad`, `--out DIR`, `--skip-build`
  - It never touches 05/06; those need a signed-in session and the owner's photos.

**This script has not yet been run end to end.** It was written after the manual
pass, and the manual pass is what produced the blank files.

## The blocking constraint, stated plainly

- `simctl` has no tap command and **`Simulator.app` is not installed** on this
  machine (`/Applications/Xcode.app/Contents/Developer` holds only `Library`,
  `Makefiles`, `Platforms`, `Toolchains`, `Tools`, `usr`).
- Accessibility scripting for `osascript` is **denied**, so there is no OS-level
  click path into the Simulator or the macOS app either.
- Therefore states 05 (account/admin) and 06 (photo picker / Global View) cannot
  be produced here by anyone — they need a signed-in session and the owner's photo
  library. Restoring `Simulator.app` would unblock both, and would also let the
  iPad rotate to landscape.

## Shipaton rules that matter (fetched 02:00)

Source: <https://revenuecat-shipaton-2026.devpost.com/rules>

- "must be **fully published** to Apple's App Store … **by the submission
  deadline**. Note: The App Review process can take multiple days or more."
- "**Newly Submitted Apps Only**: The first public version … must be released
  during the Submission Period."
- Required in the Devpost submission:
  - a URL to a **fully published** app store listing
  - a **1024×1024 app icon** (`AppIcon-512@2x.png` exists in the asset catalog)
  - **at least one screenshot at 1179×2556, without device frames** — that is the
    iPhone 15 Pro / 16 size, not any size the ASC dialog quoted
  - a **demonstration video under 2 minutes** on YouTube or Vimeo
  - a free trial **or a promo code** for judges (the one-month intro offer covers this)

## Other staleness in the submission folder

| Item | State |
| --- | --- |
| `manorama-final-evidence-2026-09-30.zip` (22:51) | predates the fixes and build 5 — regenerate |
| `02-app-review-notes.md`, `03-app-privacy-answers.md` (21:50) | not yet re-checked against the final build |
| `04-devpost.md`, `05-devpost-copy.md` (22:21) | not yet re-checked |
| `video/` | empty — the demo video does not exist yet |
| `demo-captures/` in the repo | has `ios` and `macos`, no `ipad` |
