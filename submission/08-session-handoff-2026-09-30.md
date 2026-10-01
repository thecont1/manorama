# Manorama session handoff — 30 September 2026

## Current source state

- Repository: `/Users/home/DEV/tools/manorama`
- Branch: `main`
- Working tree before this report: clean; `main` matches `origin/main`
- Latest application commit: `c5a28d7 refine(native): align gallery curtain controls and admin rows`
- PR #110 was merged earlier; there is no active feature branch for this work.

## What was completed

- Native gallery curtain now uses two balanced halves:
  - Portrait: logo centered in the upper half; title/subtitle centered in the lower half.
  - Landscape: logo centered in the left half; title/subtitle centered in the right half.
- Native gallery controls are one bottom row with equal dynamic heights:
  - Previous
  - Manorama pill
  - Image index / picker
  - Next
- Mobile native admin gallery rows now show:
  - Alternating left/right thumbnail placement
  - One first-image thumbnail at `16dvh` height
  - Source aspect ratio preserved; no crop or stretch
  - Title with item count beside it
  - Subtitle below
  - Public gallery URL below the image/copy block
- Removed the unwanted “sequence only” wording.
- Photo picker/editor collections now use safe vertical centering when shorter than the viewport; longer collections remain vertically scrollable.
- Existing frosted interlayer, 12dvh picker/editor matrix, pink active selection, and gallery-title picker heading remain in place.

## Platform status

### iOS / native Capacitor

- Source: `native/`
- Current frontend bundle: `native/dist/`
- Build config: `vite.config.native.ts`
- Latest native bundle includes the curtain, equal-height navigation row, admin rows, picker, and centering changes.
- Six authentic iPhone evidence screenshots are current and use the real `italia, amore mio` gallery.
- No new IPA was produced in this final UI pass. The existing `build/manorama-1.0-build-3.ipa` predates later PR #110/native changes and must not be described as containing this latest source.

### iPad

- Six authentic iPad landscape evidence screenshots were regenerated at `2752×2064`.
- This is evidence for the native responsive surface, not a separate app binary.

### macOS / Tauri

- Source: `desktop/`
- Current desktop frontend bundle: `desktop/dist/`
- Tauri project/config: `src-tauri/`
- Fresh universal build from current source:
  - App: `/Users/home/DEV/tools/manorama/src-tauri/target/universal-apple-darwin/release/bundle/macos/manorama.app`
  - DMG: `/Users/home/DEV/tools/manorama/src-tauri/target/universal-apple-darwin/release/bundle/dmg/manorama_0.1.0_universal.dmg`
- ARM64 + x86_64 universal binary; code signature verified; fresh app launched.
- Notarization was not run because Apple notarization credentials were unavailable.
- macOS evidence intentionally retains the desktop horizontal folder-grid presentation; compact alternating rows apply to mobile/native admin screens.

### Web

- Source: `app/`
- Current production build: `dist/`
- Production deployment completed with `bun run deploy`.
- Cloudflare Worker version: `3ca80e43-5a45-4796-8486-1d5fab8e9e86`.
- Verified live:
  - https://manorama.xyz/privacy
  - https://manorama.xyz/thecontrarian/italy
- Web picker/editor retains the frosted vertical matrix and safe centering behavior. The web viewer still follows the photo-first navigation preference rather than forcing native-style arrows on by default.

## Validation

- `bunx tsc --noEmit` passed.
- Full tracked unit suite: **82 test files passed, 0 failed**.
- Native, desktop, and web production builds passed.
- Universal Tauri macOS build and signature verification passed.
- Evidence inventory:
  - iPhone: 6 PNGs at `1284×2778`
  - iPad: 6 PNGs at `2752×2064`
  - macOS: 6 PNGs at `1440×900`

## Asset and documentation locations

- Main checkout: `/Users/home/DEV/tools/manorama/`
- Native source/build: `/Users/home/DEV/tools/manorama/native/` and `/Users/home/DEV/tools/manorama/native/dist/`
- Desktop source/build: `/Users/home/DEV/tools/manorama/desktop/` and `/Users/home/DEV/tools/manorama/desktop/dist/`
- Tauri app/config/artifacts: `/Users/home/DEV/tools/manorama/src-tauri/`
- Web source/build: `/Users/home/DEV/tools/manorama/app/` and `/Users/home/DEV/tools/manorama/dist/`
- Shared curtain: `app/components/GalleryShell.tsx`
- Shared viewer controls: `app/islands/Viewer.tsx`
- Native picker: `native/islands/GlobalView.tsx`, `native/styles/global-view.css`
- Native account/admin list: `native/islands/GalleryList.tsx`, `native/styles.css`
- Web styling: `app/styles.css`

Submission workspace:

- `/Users/home/DEV/manorama-submission/`
- iPhone screenshots: `/Users/home/DEV/manorama-submission/screens/ios/`
- iPad screenshots: `/Users/home/DEV/manorama-submission/screens/ipad/`
- macOS screenshots: `/Users/home/DEV/manorama-submission/screens/macos/`
- App Store listing: `01-app-store-listing.md`
- App Review notes: `02-app-review-notes.md`
- App Privacy answers: `03-app-privacy-answers.md`
- Devpost evidence/copy: `04-devpost.md`, `05-devpost-copy.md`
- App Store Connect checklist: `06-app-store-connect-fields.md`
- Evidence archive: `/Users/home/DEV/manorama-submission/manorama-final-evidence-2026-09-30.zip`

Authentic capture context:

- Temporary harnesses: `/tmp/capture-manorama-six.cjs` and `/tmp/capture-manorama-ipad.cjs`
- Real source-photo directory referenced during capture: `/Users/home/Library/CloudStorage/Dropbox/italy`
- Evidence uses real Italy photographs, not fabricated screenshots.

## Remaining limitations

1. The latest native source has not been packaged into a new iOS IPA in this final pass.
2. Existing App Store build 3 is older than the current PR #110/native source.
3. The macOS universal DMG is signed but not notarized.
4. App Store review submission was not claimed as completed; verify App Store Connect before submitting.
