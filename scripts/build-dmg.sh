#!/bin/bash
# Package an already-built manorama.app into a styled DMG.
#
# This ONLY assembles the disk image (app + Applications symlink + styled
# Finder background from macos/dmg/). It does not sign or notarize — the
# desktop-release workflow notarizes and staples the result afterwards.
#
# Usage: scripts/build-dmg.sh /abs/path/manorama.app /abs/path/out.dmg
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <app-bundle> <output.dmg>" >&2
  exit 2
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: build-dmg.sh requires macOS (hdiutil/dmgbuild)" >&2
  exit 1
fi

# Absolutize before anything else so spaces and relative paths behave.
APP_BUNDLE="$1"
if [ ! -d "$APP_BUNDLE" ]; then
  echo "error: app bundle not found: $APP_BUNDLE" >&2
  exit 1
fi
APP_BUNDLE="$(cd "$APP_BUNDLE" && pwd)"
if [ "${APP_BUNDLE##*.}" != "app" ]; then
  echo "error: $APP_BUNDLE is not a .app bundle" >&2
  exit 1
fi

if [ ! -f "$APP_BUNDLE/Contents/Resources/icon.icns" ]; then
  echo "error: required icon resource missing: $APP_BUNDLE/Contents/Resources/icon.icns" >&2
  exit 1
fi

DMG="$2"
if [ "${DMG##*.}" != "dmg" ]; then
  echo "error: output must end in .dmg: $DMG" >&2
  exit 1
fi
DMG_DIR="$(cd "$(dirname "$DMG")" 2>/dev/null && pwd || true)"
if [ -z "$DMG_DIR" ]; then
  DMG_DIR="$(dirname "$DMG")"
  mkdir -p "$DMG_DIR"
  DMG_DIR="$(cd "$DMG_DIR" && pwd)"
fi
DMG="$DMG_DIR/$(basename "$DMG")"

if [ -e "$DMG" ]; then
  echo "error: output already exists, refusing to overwrite: $DMG" >&2
  echo "       remove it or choose a different output path" >&2
  exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' \
  "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true)"
if [ -z "$VERSION" ]; then
  echo "error: could not read CFBundleShortVersionString from $APP_BUNDLE/Contents/Info.plist" >&2
  exit 1
fi

uvx --python 3.12 --from 'dmgbuild==1.6.7' dmgbuild \
  -s "$ROOT/macos/dmg/settings.py" \
  -D "app=$APP_BUNDLE" -D "assets=$ROOT/macos/dmg" \
  "manorama $VERSION" "$DMG"

echo "wrote $DMG"
