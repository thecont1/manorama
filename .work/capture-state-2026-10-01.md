# Capture state, 2026-10-01 (working notes)

## What is done
- **iPhone set** (`manorama-submission/screens/ios/`): six screens, signed off by the owner.
- **Copy review**: native account surface now says *This device*, *House cards*,
  *How galleries load*, *Photo picker*, *Temporary galleries*. Desktop catalogue says
  *Folder on this device* / *folders and cards you have opened on this device*.
  AdminOps says *gallery cards*, not *plates*. Tests updated:
  `native/islands/GalleryList.account.test.tsx`.
- **Fresh Xcode build works.** Two blockers had to be solved, both recorded in
  `scripts/capture-screens.sh`:
  1. SwiftPM/plugin sandboxing — `-IDEPackageSupportDisableManifestSandbox=1`,
     `-IDEPackageSupportDisablePluginExecutionSandbox=1`, and
     `OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox'` (RevenueCat's `@TaskLocal`
     macro needs the third). Without them: `sandbox-exec: sandbox_apply: Operation
     not permitted`.
  2. `prep_app` declared `src` and read `$src` in one `local` statement; under
     `set -u` that aborts. Split into two statements.
- Built apps (fresh, today): `/tmp/capture-harness-build/.../App.app`,
  `/tmp/capture-plain-build/.../App.app`. Re-run captures with `--skip-build`.
- **macOS desktop app rebuilt and signed** with the current frontend:
  `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/manorama.app`
  (`bunx tauri build --bundles app --target aarch64-apple-darwin`, ~2 min warm).
  Use `--target aarch64-apple-darwin`; without it cargo picks the host target dir
  and the build goes cold and slow.

## What is still open
- **iPad must be horizontal (2752x2064).** A capture-only landscape mask on the
  staged copy is NOT enough: iPadOS 26 ignores `UISupportedInterfaceOrientations~ipad`
  even with `UIRequiresFullScreen=true` (installed plist verified). The device itself
  has to rotate. `simctl` has no rotate verb and System Events scripting is denied
  (`privilege violation -10004`), so the Simulator GUI is the only lever left —
  Computer Use, or the owner rotating it by hand.
- **macOS six screens.** App launches (`manorama-desktop` pid seen), and
  `screencapture` works, but no manorama window was on screen when probed.
  Window targeting helper: `/tmp/list-windows.swift` (compile with
  `xcrun swiftc -module-cache-path /tmp/mcache ... -o /tmp/list-windows`; the default
  clang module cache is not writable here). Window size is 1280x840 from
  `src-tauri/tauri.conf.json`; the submission's macOS evidence is 1440x900, so the
  window size needs a temporary config change + rebuild.
- The macOS evidence that existed before today showed `/Users/mahesh/...` paths.
  `/Users/mahesh` is not visible from this sandboxed shell (HOME=/Users/home), so the
  desktop catalogue the app reads in the GUI session is not readable from here.

## Owner-reported bug, not yet diagnosed
- "Not able to log into the macOS app using the Dropbox button — sign-in could not be
  completed." Note there are two copies of the app: `/Applications/manorama.app`
  (universal) and the freshly built `src-tauri/target/.../manorama.app` (arm64 only).
  The `in.thecontrarian.manorama.desktop` scheme is registered in LaunchServices;
  which copy owns it decides where the OAuth callback lands.