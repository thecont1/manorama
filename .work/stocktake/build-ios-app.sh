#!/usr/bin/env bash
#
# Rebuild the two simulator apps from the current working tree:
#
#   harness  native/dist served from http://localhost:4181 (the driver server),
#            so the gallery states are reachable without a Keychain session
#   plain    the shipped configuration, for the opening screen
#
# Mirrors scripts/capture-screens.sh, including the SwiftPM sandbox flags and the
# temporary server.url toggle, which is restored on every exit path.
set -euo pipefail

REPO=/Users/home/DEV/tools/manorama
UDID="${UDID:-650056B7-209D-435F-892F-4D9391C5C3C7}"
PORT=4181
OUT_HARNESS=/tmp/capture-harness-build
OUT_PLAIN=/tmp/capture-plain-build

XCODE_PACKAGE_FLAGS=(
  -IDEPackageSupportDisableManifestSandbox=1
  -IDEPackageSupportDisablePluginExecutionSandbox=1
  'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox'
)

SHIM_DIR="$(mktemp -d /tmp/manorama-build-shims.XXXXXX)"
printf '%s\n' \
  '#!/bin/sh' \
  'while [ $# -gt 0 ]; do case "$1" in -p|-f) shift 2 ;; -*) shift ;; *) break ;; esac; done' \
  'exec "$@"' > "$SHIM_DIR/sandbox-exec"
chmod +x "$SHIM_DIR/sandbox-exec"
export PATH="$SHIM_DIR:$PATH"

CONFIG="$REPO/capacitor.config.ts"
BACKUP="$(mktemp /tmp/capacitor.config.ts.XXXXXX)"
cp "$CONFIG" "$BACKUP"

cleanup() {
  cp "$BACKUP" "$CONFIG"
  rm -rf "$SHIM_DIR"
  echo "restored capacitor.config.ts"
}
trap cleanup EXIT INT TERM

log() { printf '\033[1m%s\033[0m\n' "$*"; }

log "building the bundle"
( cd "$REPO" && bun run build:native >/dev/null )

log "harness app (temporary server.url)"
python3 - "$CONFIG" "$PORT" <<'PY'
import pathlib, sys
path, port = pathlib.Path(sys.argv[1]), sys.argv[2]
s = path.read_text()
marker = "  plugins: {"
assert s.count(marker) == 1, "capacitor.config.ts shape changed"
s = s.replace(marker, (
    "  // TEMPORARY - written and restored by .work/stocktake/build-ios-app.sh.\n"
    "  server: {\n"
    "    url: 'http://localhost:%s/?owner=thecontrarian&slug=italy',\n"
    "    cleartext: true,\n"
    "  },\n" % port
) + marker, 1)
path.write_text(s)
PY
( cd "$REPO" && bunx cap sync ios >/dev/null )
xcodebuild -project "$REPO/ios/App/App.xcodeproj" -scheme App -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$OUT_HARNESS" \
  "${XCODE_PACKAGE_FLAGS[@]}" build > /tmp/build-harness.log 2>&1

log "plain app (shipped configuration)"
cp "$BACKUP" "$CONFIG"
( cd "$REPO" && bunx cap sync ios >/dev/null )
xcodebuild -project "$REPO/ios/App/App.xcodeproj" -scheme App -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$OUT_PLAIN" \
  "${XCODE_PACKAGE_FLAGS[@]}" build > /tmp/build-plain.log 2>&1

log "done"