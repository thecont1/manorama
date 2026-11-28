#!/usr/bin/env bash
# macOS native shell build
#
# The Library bundle is built by vite (see vite.config.desktop-shell.ts) and
# copied into the app's Resources as "ViewerBundle". The app serves it over
# the manorama:// scheme, which is how the WKWebView reaches both the page
# and the user's originals.
#
# The bundle is the same one the Tauri shell ships — the app's own Library —
# with the shell's runtime shim installed in front of it.
#
# Usage: scripts/build-macos.sh [debug|release]

set -euo pipefail

cd "$(dirname "$0")/.."

CONFIG="${1:-debug}"
case "$CONFIG" in
  # debug compiles without optimisation — the shell is thin enough that the
  # faster build is the better iteration loop; release stays -O for the
  # artifact desktop-release.yml ships.
  debug)   OPTIMISATION=-Onone ;;
  release) OPTIMISATION=-O ;;
  *) echo "usage: scripts/build-macos.sh [debug|release]" >&2; exit 2 ;;
esac
APP="macos/ManoramaMac"
# The shared event-clustering core, compiled straight into this binary.
# It is a SwiftPM package for the iOS app and for the core's own tests, but
# the shell and the engine must not be able to drift into two builds of the
# same clustering decision — and the core has no dependencies to link,
# which is what makes taking its sources here cheap rather than a packaging
# problem. Nothing is added to the bundle: these are eight Swift files.
CORE="native/EventClustering/Sources/ManoramaEventClustering"
# Test builds may override the bundle id and output directory — a suite
# that must coexist with an installed copy needs a REAL distinct
# CFBundleIdentifier, since AX probes and `tell application id` resolve
# the bundle's own id, not a launch argument.
BUILD_DIR="${MANORAMA_MACOS_BUILD_DIR:-$APP/build}"
BUNDLE_ID="${MANORAMA_MACOS_BUNDLE_ID:-in.thecontrarian.manorama.desktop}"

echo "==> building the Library bundle"
# Avoid bundling the config through a worktree's shared node_modules symlink.
bunx vite build --config vite.config.desktop-shell.ts --configLoader runner

echo "==> staging the viewer bundle into the app resources"
rm -rf "$APP/Resources/ViewerBundle"
mkdir -p "$APP/Resources/ViewerBundle"
cp -R desktop/dist/. "$APP/Resources/ViewerBundle/"

echo "==> compiling the Swift app"
# The app is assembled as a plain .app bundle rather than through an Xcode
# project: the shell is a handful of Swift files and the viewer bundle is a
# copied resource, so an Xcode project would add ceremony without adding
# capability. Signing runs below from the Developer ID identity;
# notarisation is the remaining step, handled outside this script.
#
# The compiler and the SDK are resolved from one explicitly selected
# developer directory, so they can never come from different Xcodes.
# DEVELOPER_DIR is scoped to this process — the user's global xcode-select
# is left alone. A stray MACOSX_DEPLOYMENT_TARGET in the environment would
# otherwise override the -target flag, so it is cleared for reproducibility.
export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p)}"
unset MACOSX_DEPLOYMENT_TARGET
SWIFTC="$(xcrun --sdk macosx --find swiftc)"
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version)"
SDK_MAJOR="${SDK_VERSION%%.*}"
if [ "$SDK_MAJOR" -lt 26 ]; then
  echo "FATAL: $DEVELOPER_DIR provides macOS SDK $SDK_VERSION, but the shell needs 26 or newer (Xcode 27.x)." >&2
  exit 1
fi
# sed -n '1p', not head -1: head closes the pipe early, and under
# `set -o pipefail` the writer's SIGPIPE becomes a spurious build failure.
xcodebuild -version | sed -n '1p'
"$SWIFTC" --version | sed -n '1p'
echo "macOS SDK: $SDK_VERSION ($SDK_PATH)"
# Invoking the toolchain's swiftc directly skips the /usr/bin dispatcher's
# environment setup, and without SDKROOT the linker stamps the deployment
# target into LC_BUILD_VERSION's `sdk` field — the OS would then treat the
# app as built against macOS 15 and deny it the new system appearance.
export SDKROOT="$SDK_PATH"
mkdir -p "$BUILD_DIR"
"$SWIFTC" \
  $OPTIMISATION \
  -sdk "$SDK_PATH" \
  -target arm64-apple-macosx15.0 \
  -framework AppKit \
  -framework SwiftUI \
  -framework WebKit \
  -framework Security \
  -framework Vision \
  -o "$BUILD_DIR/manorama" \
  "$APP"/*.swift "$CORE"/*.swift

# The Mach-O headers are the truth about what the compiler emitted: the
# build fails if the minimum-OS version or the SDK it linked against does
# not agree with the toolchain this script resolved. The `sdk` field must
# record the real SDK — see the SDKROOT note above.
MINOS="$(vtool -show-build "$BUILD_DIR/manorama" | awk '$1 == "minos" {print $2}')"
LINKED_SDK="$(vtool -show-build "$BUILD_DIR/manorama" | awk '$1 == "sdk" {print $2}')"
echo "binary: minos $MINOS, linked sdk $LINKED_SDK"
if [ "$MINOS" != "15.0" ]; then
  echo "FATAL: the binary reports minimum macOS $MINOS, expected 15.0" >&2
  exit 1
fi
if [ "$LINKED_SDK" != "$SDK_VERSION" ]; then
  echo "FATAL: the binary was linked against macOS SDK $LINKED_SDK, expected $SDK_VERSION" >&2
  exit 1
fi

echo "==> assembling the .app bundle"
APP_BUNDLE="$BUILD_DIR/manorama.app"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
cp "$BUILD_DIR/manorama" "$APP_BUNDLE/Contents/MacOS/manorama"
cp -R "$APP/Resources/ViewerBundle" "$APP_BUNDLE/Contents/Resources/ViewerBundle"
if [ -f "src-tauri/icons/icon.icns" ]; then
  cp "src-tauri/icons/icon.icns" "$APP_BUNDLE/Contents/Resources/icon.icns"
fi

# The release version lives in the Tauri config; hardcoding it here let the
# macOS artifact ship as 0.5.2 inside the v0.6.0 release.
APP_VERSION="$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
[[ -n "$APP_VERSION" ]] || { echo "FATAL: could not read the release version from src-tauri/tauri.conf.json" >&2; exit 1; }

cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>manorama</string>
  <key>CFBundleDisplayName</key><string>manorama</string>
  <key>CFBundleExecutable</key><string>manorama</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$APP_VERSION</string>
  <key>CFBundleVersion</key><string>$APP_VERSION</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.photography</string>
  <!-- Mass-market exemption (5D992): the app encrypts user data at rest but
       qualifies for the standard exemption, so no per-submission export
       docs. The annual self-classification report is a separate obligation
       tracked in docs/owner-setup-runbook.md. -->
  <key>ITSAppUsesNonExemptEncryption</key><false/>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>$BUNDLE_ID</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>$BUNDLE_ID</string>
      </array>
    </dict>
  </array>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Folder</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><string>public.folder</string>
    </dict>
  </array>
  <key>NSAppTransportSecurity</key>
  <dict>
    <!-- MEGA's CDN estate is mixed: attribute/preview edges (gfs*.userstorage)
         still serve TLS ≤1.2 with non-PFS ciphers, which default ATS rejects
         with -1200 before any bytes move. Scope the exception to exactly the
         host family that needs it; the modern edges and g.api are unaffected. -->
    <key>NSExceptionDomains</key>
    <dict>
      <key>userstorage.mega.co.nz</key>
      <dict>
        <key>NSIncludesSubdomains</key><true/>
        <key>NSExceptionRequiresForwardSecrecy</key><false/>
        <key>NSExceptionMinimumTLSVersion</key><string>TLSv1.2</string>
      </dict>
    </dict>
  </dict>
</dict>
</plist>
PLIST

# The plist and the binary must agree on the floor — a bundle whose plist
# promises macOS 15 while the Mach-O was compiled for something else is a
# broken artifact either way.
PLIST_MIN="$(/usr/libexec/PlistBuddy -c 'Print LSMinimumSystemVersion' "$APP_BUNDLE/Contents/Info.plist")"
if [ "$PLIST_MIN" != "$MINOS" ]; then
  echo "FATAL: LSMinimumSystemVersion $PLIST_MIN disagrees with the binary's $MINOS" >&2
  exit 1
fi

echo "==> signing the app bundle"
# A linker-signed ad-hoc binary has no stable identity and carries no
# entitlements: any item a differently-signed build left in the file-based
# login keychain keeps an ACL bound to that signature — macOS prompts for
# the keychain password once per item on first read. A stable Developer ID
# signature keeps its own identity across rebuilds, so items it owns stay
# silent; the bridge migrates foreign-signature items on first touch.
IDENTITY="${MACOS_SIGN_IDENTITY:-Developer ID Application: Mahesh Shantaram (373K7W3LKU)}"
# App Store builds sign with ManoramaMac-AppStore.entitlements, which adds the
# application/team identifiers the distribution signature requires; direct
# (Developer ID) builds keep the leaner set.
ENTITLEMENTS="${MANORAMA_MACOS_ENTITLEMENTS:-$APP/ManoramaMac.entitlements}"
# Note: keychain-access-groups belongs ONLY in the App Store file. It is a
# restricted entitlement — on a sandboxed Developer ID build with no
# provisioning profile, AMFI cannot validate it and the kernel kills the
# process at exec ("restricted entitlements, code signature validation
# failed"). Shared custody reaches direct builds only when BOTH pieces ship
# together: an embedded Developer ID profile carrying the group AND an
# entitlements file that declares it — the profile alone changes nothing.
# Until then the bridge's legacy file-keychain path serves them unchanged.
# com.apple.developer.applesignin is restricted the same way: it lives in
# ManoramaMac-DevProfiled.entitlements, which a local build may only use
# together with MANORAMA_MACOS_PROFILE below.
#
# MANORAMA_MACOS_PROFILE embeds a provisioning profile at the location AMFI
# reads it from, so restricted entitlements declared in the entitlements
# file can be validated. The pair for local native-Sign-in-with-Apple
# testing is the manorama-mac-development-desktop profile (regenerate via
# the App Store Connect API when it expires) and the dev signing identity:
#   MANORAMA_MACOS_PROFILE=macos/ManoramaMac/build/manorama-dev.provisionprofile \
#   MANORAMA_MACOS_ENTITLEMENTS=macos/ManoramaMac/ManoramaMac-DevProfiled.entitlements \
#   MACOS_SIGN_IDENTITY="Apple Development: Mahesh Shantaram (TRF3R33X88)" \
#   scripts/build-macos.sh debug
if [ -n "${MANORAMA_MACOS_PROFILE:-}" ]; then
  cp "$MANORAMA_MACOS_PROFILE" "$APP_BUNDLE/Contents/embedded.provisionprofile"
  echo "    embedded provisioning profile: $MANORAMA_MACOS_PROFILE"
fi
codesign --force --sign "$IDENTITY" --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" "$APP_BUNDLE"

echo "==> done: $APP_BUNDLE"
echo "    run: open '$APP_BUNDLE'"
