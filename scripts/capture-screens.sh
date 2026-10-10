#!/usr/bin/env bash
#
# Regenerate the native screenshot matrix for one device class.
#
#   bash scripts/capture-screens.sh --device iphone
#   bash scripts/capture-screens.sh --device ipad
#
# Produces, into the submission screens folder:
#
#   01-opening-screen.png    the sign-in door, from the plain bundle
#   02-gallery-curtain.png   the curtain over a public gallery
#   03-first-image.png       the strip with its controls
#   04-controls-popover.png  the display-settings modal
#   05-account-admin.png     the signed-in account surface
#   06-global-view.png       the production photo picker with owner originals
#
# 05 is signed in, which the simulator cannot be: no Keychain entry exists for a
# manorama session and there is no way to tap a sign-in button. The harness seeds
# the session and the two session-gated answers, and takes the gallery list from
# the owner's own public gallery rather than inventing one. Screen 06 mounts the
# production GlobalView island against an in-memory grid catalog sourced from
# that same gallery, and serves unchanged originals; it never writes a fake
# encrypted vault. See .work/capture-server.ts and global-view-fixture.tsx.
#
# Why this exists: the iOS Simulator on this machine has no GUI and `simctl` has
# no tap command, so the app cannot be driven from outside. The gallery states
# are therefore reached from inside the page — the harness serves the real
# `native/dist` bundle and injects a driver that dispatches the same clicks a
# finger would. See .work/capture-server.ts.
#
# The harness reports what each state reached over `GET /__capture/report`, and
# this script waits for that instead of sleeping a fixed number of seconds.
#
# The harness needs `server.url` in capacitor.config.ts. This script sets it,
# builds, and restores the file on exit, trap or interrupt.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=4181
DEVICE=iphone
# SwiftPM compiles and runs every package manifest under `sandbox-exec`, and the
# macOS sandbox does not nest: inside an already-sandboxed shell xcodebuild dies
# with "sandbox-exec: sandbox_apply: Operation not permitted" before it can
# resolve a single dependency. These build settings turn the manifest and plugin
# sandboxes off for this build only, and are harmless in an ordinary shell.
XCODE_PACKAGE_FLAGS=(
  -IDEPackageSupportDisableManifestSandbox=1
  -IDEPackageSupportDisablePluginExecutionSandbox=1
  # ...and the Swift flag that stops the compiler wrapping macro plugin servers
  # in a sandbox of their own. Without it RevenueCat never emits its module.
  'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox'
)
# Those two settings are not enough on their own. Xcode also spawns the Swift
# *macro* plugin server under `sandbox-exec`, so RevenueCat — whose RulesEngine
# uses `@TaskLocal` and `@State` — fails with "external macro implementation
# type 'SwiftMacros.TaskLocalMacro' could not be found ... produced malformed
# response". A passthrough `sandbox-exec` ahead of the real one on PATH is the
# workaround SwiftPM and Homebrew users settled on. Every package here is
# already resolved and pinned in `Package.resolved`, and the shim exists only
# for the length of this script.
SHIM_DIR="$(mktemp -d /tmp/manorama-capture-shims.XXXXXX)"
printf '%s\n' \
  '#!/bin/sh' \
  'while [ $# -gt 0 ]; do case "$1" in -p|-f) shift 2 ;; -*) shift ;; *) break ;; esac; done' \
  'exec "$@"' > "$SHIM_DIR/sandbox-exec"
chmod +x "$SHIM_DIR/sandbox-exec"
export PATH="$SHIM_DIR:$PATH"
OUT=""
SKIP_BUILD=0
KEEP_CONFIG_BACKUP=""
SERVER_PID=""
REQUESTED_UDID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --udid) REQUESTED_UDID="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The type name alone, not the type plus a paren: the simulators on this machine
# carry suffixes ("iPhone 13 Pro Max r265", "iPhone 13 Pro Max capture"), and
# anchoring on the paren quietly matched nothing and took the script down.
case "$DEVICE" in
  iphone) TYPE_RE='iPhone 13 Pro Max' ; DEFAULT_OUT="$REPO/demo-captures/ios" ;;
  ipad)   TYPE_RE='iPad Pro 13-inch'  ; DEFAULT_OUT="$REPO/demo-captures/ipad" ;;
  *) echo "--device must be iphone or ipad" >&2; exit 2 ;;
esac
OUT="${OUT:-$DEFAULT_OUT}"

CONFIG="$REPO/capacitor.config.ts"
HARNESS_APP=/tmp/capture-harness-build/Build/Products/Debug-iphonesimulator/App.app
PLAIN_APP=/tmp/capture-plain-build/Build/Products/Debug-iphonesimulator/App.app

log() { printf '\033[1m%s\033[0m\n' "$*"; }

cleanup() {
  # Restore the committed config and stop the harness, whatever happened.
  if [[ -n "$KEEP_CONFIG_BACKUP" && -f "$KEEP_CONFIG_BACKUP" ]]; then
    cp "$KEEP_CONFIG_BACKUP" "$CONFIG"
    log "restored capacitor.config.ts"
  fi
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  if [[ -n "${SHIM_DIR:-}" ]]; then rm -rf "$SHIM_DIR"; fi
}
trap cleanup EXIT INT TERM

# --- the device ---------------------------------------------------------------

# `sed -n 1p` rather than `head -1`: under `set -o pipefail` a `head` that exits
# after one line sends SIGPIPE back up the pipeline and takes the whole script
# with it. sed reads the stream to the end and prints only the first line. Each
# lookup ends in `|| true` because finding nothing is a normal case here — the
# script creates the simulator when one is missing, and `set -e` would otherwise
# kill it before it could.
existing="$(xcrun simctl list devices available | grep -E "$TYPE_RE" | sed -n '1p' | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/' || true)"
runtime="$(xcrun simctl list runtimes | grep -oE 'com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+' | sed -n '$p' || true)"
type_id="$(xcrun simctl list devicetypes | grep -E "$TYPE_RE" | sed -n '1p' | sed -E 's/.*\((com\.apple[^)]*)\).*/\1/' || true)"

if [[ -n "$REQUESTED_UDID" ]]; then
  UDID="$REQUESTED_UDID"
elif [[ -n "$existing" ]]; then
  UDID="$existing"
  log "using simulator $UDID"
else
  UDID="$(xcrun simctl create "$DEVICE capture" "$type_id" "$runtime")"
  log "created simulator $UDID"
fi
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

# --- the two builds -----------------------------------------------------------

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  log "building the bundle"
  ( cd "$REPO" && bun run build:native >/dev/null 2>&1 )

  log "building the harness app (temporary server.url)"
  KEEP_CONFIG_BACKUP="$(mktemp /tmp/capacitor.config.ts.XXXXXX)"
  cp "$CONFIG" "$KEEP_CONFIG_BACKUP"
  python3 - "$CONFIG" "$PORT" <<'PY'
import pathlib, sys
path, port = pathlib.Path(sys.argv[1]), sys.argv[2]
s = path.read_text()
marker = "  plugins: {"
assert s.count(marker) == 1, "capacitor.config.ts shape changed"
s = s.replace(marker, (
    "  // TEMPORARY - written and restored by scripts/capture-screens.sh.\n"
    "  server: {\n"
    "    url: 'http://localhost:%s/?owner=thecontrarian&slug=italy',\n"
    "    cleartext: true,\n"
    "  },\n" % port
) + marker, 1)
path.write_text(s)
PY
  ( cd "$REPO" && bunx cap sync ios >/dev/null 2>&1 )
  xcodebuild -project "$REPO/ios/App/App.xcodeproj" -scheme App -configuration Debug \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath /tmp/capture-harness-build \
    "${XCODE_PACKAGE_FLAGS[@]}" build >/tmp/capture-harness.log 2>&1

  log "building the plain app"
  cp "$KEEP_CONFIG_BACKUP" "$CONFIG"
  ( cd "$REPO" && bunx cap sync ios >/dev/null 2>&1 )
  xcodebuild -project "$REPO/ios/App/App.xcodeproj" -scheme App -configuration Debug \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath /tmp/capture-plain-build \
    "${XCODE_PACKAGE_FLAGS[@]}" build >/tmp/capture-plain.log 2>&1
fi

# Allow the harness to reach localhost, then re-sign the ad-hoc copy.
prep_app() {
  # Two statements, not one: under `set -u` bash rejects a `local` that reads a
  # name it is declaring on the same line.
  local src="$1"
  local dest
  dest="$(mktemp -d /tmp/manorama-capture-app.XXXXXX)"
  cp -R "$src" "$dest/App.app"
  local plist="$dest/App.app/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true" "$plist" 2>/dev/null || true
  # Capture-only orientation lock, and only on the staged copy. The shipped app
  # allows every iPad orientation; the submission evidence is landscape
  # 2752x2064, and this machine's Simulator cannot be rotated from the command
  # line — `simctl` has no rotate verb and UI scripting is denied. Declaring
  # landscape for the staged bundle makes iOS launch it that way, so the pixels
  # are the real app's pixels in the orientation the evidence calls for.
  if [[ "$DEVICE" == "ipad" ]]; then
    /usr/libexec/PlistBuddy -c "Add :UIInterfaceOrientation string UIInterfaceOrientationLandscapeLeft" "$plist" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c "Set :UIInterfaceOrientation UIInterfaceOrientationLandscapeLeft" "$plist"
    /usr/libexec/PlistBuddy -c "Delete :UISupportedInterfaceOrientations~ipad" "$plist" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations~ipad array" "$plist"
    /usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations~ipad:0 string UIInterfaceOrientationLandscapeLeft" "$plist"
    /usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations~ipad:1 string UIInterfaceOrientationLandscapeRight" "$plist"
    # iPad only enforces the orientation mask for an app that requires full
    # screen. Without this the system grants every orientation and the app
    # launches portrait, mask or no mask.
    /usr/libexec/PlistBuddy -c "Add :UIRequiresFullScreen bool true" "$plist" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c "Set :UIRequiresFullScreen true" "$plist"
  fi
  codesign --force -s - "$dest/App.app" >/dev/null 2>&1
  echo "$dest/App.app"
}

# --- the harness --------------------------------------------------------------

( cd "$REPO" && bun .work/build-global-view-fixture.ts >/tmp/capture-global-build.log )
( cd "$REPO" && exec bun .work/capture-server.ts ) >/tmp/capture-server.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/__capture/status" >/dev/null; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then cat /tmp/capture-server.log >&2; exit 1; fi
  sleep 1
done
curl -sf "http://localhost:$PORT/state/0" >/dev/null || { echo "harness did not start; see /tmp/capture-server.log" >&2; exit 1; }

mkdir -p "$OUT"

shoot() { # <name> <countdown seconds>
  sleep "$2"
  xcrun simctl io "$UDID" screenshot "$OUT/$1" >/dev/null 2>&1
  printf '  %-30s %s\n' "$1" "$(sips -g pixelWidth -g pixelHeight "$OUT/$1" 2>/dev/null | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}')"
}

log "01 opening screen"
xcrun simctl terminate "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$(prep_app "$PLAIN_APP")" >/dev/null 2>&1
xcrun simctl launch "$UDID" in.thecontrarian.manorama >/dev/null 2>&1
shoot 01-opening-screen.png 5

log "02 curtain, 03 first image, 04 controls"
xcrun simctl install "$UDID" "$(prep_app "$HARNESS_APP")" >/dev/null 2>&1
for pair in "0:02-gallery-curtain.png" "1:03-first-image-hover.png" "2:04-controls-popover.png"; do
  state="${pair%%:*}"; name="${pair#*:}"
  curl -sf "http://localhost:$PORT/state/$state" >/dev/null
  xcrun simctl terminate "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || true
  xcrun simctl launch "$UDID" in.thecontrarian.manorama >/dev/null 2>&1
  log "state $state -> $name"
  ready=0
  for _ in $(seq 1 45); do
    sleep 2
    if curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null | grep -q '"ready":true'; then
      ready=1
      break
    fi
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "state $state never reported a decoded first image; last report:" >&2
    curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null >&2 || echo "(none)" >&2
    exit 1
  fi
  shoot "$name" 1
done

# 05 is the slow one: a seeded session, four live and stubbed answers, and a
# row of remote thumbnails before it is worth photographing. The harness says
# when it got there; the timeout is the backstop, and a timeout is a failure
# rather than a picture of a half-built screen.
log "05 account admin"
curl -sf "http://localhost:$PORT/state/3" >/dev/null
xcrun simctl terminate "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || true
xcrun simctl launch "$UDID" in.thecontrarian.manorama >/dev/null 2>&1
ready=0
for _ in $(seq 1 60); do
  sleep 2
  if curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null | grep -q '"ready":true'; then
    ready=1
    break
  fi
done
if [[ "$ready" -ne 1 ]]; then
  echo "state 3 never reported ready; last report:" >&2
  curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null >&2 || echo "(none)" >&2
  echo "see /tmp/capture-server.log" >&2
  exit 1
fi
# The last thumbnail lands with the layout; one more beat lets the strip settle.
shoot 05-account-admin.png 3

log "06 photo picker"
curl -sf "http://localhost:$PORT/state/4" >/dev/null
xcrun simctl terminate "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || true
xcrun simctl launch "$UDID" in.thecontrarian.manorama >/dev/null 2>&1
ready=0
for _ in $(seq 1 60); do
  sleep 2
  if curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null | grep -q '"ready":true'; then
    ready=1
    break
  fi
done
if [[ "$ready" -ne 1 ]]; then
  echo "state 4 never reported a complete visible photo matrix; last report:" >&2
  curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null >&2 || echo "(none)" >&2
  echo "see /tmp/capture-server.log" >&2
  exit 1
fi
shoot 06-global-view.png 2

echo
log "done"
