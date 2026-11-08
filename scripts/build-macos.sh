# macOS prototype build
#
# The viewer bundle is built by vite (see vite.config.viewer.ts) and copied
# into the app's Resources as "ViewerBundle". The app serves it over the
# manorama:// scheme, which is how the WKWebView reaches both the page and
# the user's originals.
#
# Usage: scripts/build-macos.sh [debug|release]

set -euo pipefail

cd "$(dirname "$0")/.."

CONFIG="${1:-debug}"
APP="macos/ManoramaMac"
BUILD_DIR="$APP/build"
BUNDLE_ID="in.thecontrarian.manorama.mac"

echo "==> building the viewer bundle"
bunx vite build --config vite.config.viewer.ts

echo "==> staging the viewer bundle into the app resources"
rm -rf "$APP/Resources/ViewerBundle"
mkdir -p "$APP/Resources/ViewerBundle"
cp -R desktop-viewer/dist/. "$APP/Resources/ViewerBundle/"

echo "==> compiling the Swift app"
# The app is assembled as a plain .app bundle rather than through an Xcode
# project: the shell is a handful of Swift files and the viewer bundle is a
# copied resource, so an Xcode project would add ceremony without adding
# capability. Signing and notarisation come later, from the same Developer
# ID identity the Tauri build already uses.
mkdir -p "$BUILD_DIR"
swiftc \
  -O \
  -target arm64-apple-macosx13.0 \
  -framework AppKit \
  -framework SwiftUI \
  -framework WebKit \
  -o "$BUILD_DIR/ManoramaMac" \
  "$APP"/*.swift

echo "==> assembling the .app bundle"
APP_BUNDLE="$BUILD_DIR/ManoramaMac.app"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
cp "$BUILD_DIR/ManoramaMac" "$APP_BUNDLE/Contents/MacOS/ManoramaMac"
cp -R "$APP/Resources/ViewerBundle" "$APP_BUNDLE/Contents/Resources/ViewerBundle"

cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>manorama</string>
  <key>CFBundleDisplayName</key><string>manorama</string>
  <key>CFBundleExecutable</key><string>ManoramaMac</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Folder</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSItemContentTypes</key><string>public.folder</string>
    </dict>
  </array>
</dict>
</plist>
PLIST

echo "==> done: $APP_BUNDLE"
echo "    run: open '$APP_BUNDLE'"
