#!/usr/bin/env bash
# Re-shoot the iPhone six-state matrix using the app bundles the capture script
# already built, without invoking xcodebuild again. The capture server supplies
# each state and reports when the screen is worth photographing; this script only
# drives it. It exists because a rebuild costs minutes and the fixture's live
# manifest fetch can time out inside one long build-and-shoot run.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CAPTURE_PORT:-4181}"
UDID="${UDID:-}"
OUT="$REPO/demo-captures/ios"
HARNESS_APP=/tmp/capture-harness-build/Build/Products/Debug-iphonesimulator/App.app
PLAIN_APP=/tmp/capture-plain-build/Build/Products/Debug-iphonesimulator/App.app

log() { printf '\n== %s\n' "$*"; }

prep_app() {
  local src="$1" dest
  dest="$(mktemp -d /tmp/manorama-capture-app.XXXXXX)"
  cp -R "$src" "$dest/App.app"
  local plist="$dest/App.app/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true" "$plist" 2>/dev/null || true
  codesign --force -s - "$dest/App.app" >/dev/null 2>&1
  echo "$dest/App.app"
}

if [[ -z "$UDID" ]]; then
  UDID="$(xcrun simctl list devices booted | grep -E 'iPhone' | sed -n '1p' | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
fi
[[ -n "$UDID" ]] || { echo "no booted iPhone simulator" >&2; exit 1; }
echo "simulator: $UDID"

# Never force-kill whatever happens to hold the port: it may be the owner's
# own server. Report it, and only ever stop the server this script started.
if lsof -ti :"$PORT" >/dev/null 2>&1; then
  echo "port $PORT is already in use; stop that process or set CAPTURE_PORT" >&2
  exit 1
fi
SERVER_LOG="$(mktemp /tmp/reshoot-capture-server.XXXXXX.log)"
( cd "$REPO" && exec bun .work/capture-server.ts ) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/__capture/status" >/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "capture server died" >&2; tail -20 "$SERVER_LOG" >&2; exit 1; }
  sleep 1
done

mkdir -p "$OUT"

shoot() { # <name> <settle seconds>
  sleep "$2"
  # A capture that did not happen must report failure: a missing file that the
  # driver treats as captured is how a matrix silently loses a state.
  if ! xcrun simctl io "$UDID" screenshot "$OUT/$1" >/dev/null 2>&1; then
    rm -f "$OUT/$1"
    printf '  %-30s CAPTURE FAILED\n' "$1" >&2
    return 1
  fi
  local dims
  dims="$(sips -g pixelWidth -g pixelHeight "$OUT/$1" 2>/dev/null | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}')"
  # awk prints "x" when either field is missing, so the shape is checked and
  # both numbers have to be there: a malformed size is a failed capture, not a
  # success with an odd label.
  if [[ ! "$dims" =~ ^[0-9]+x[0-9]+$ ]]; then
    rm -f "$OUT/$1"
    printf '  %-30s CAPTURE UNREADABLE (%s)\n' "$1" "${dims:-no dimensions}" >&2
    return 1
  fi
  printf '  %-30s %s\n' "$1" "$dims"
  return 0
}

drive() { # <state> <name> <settle>
  local state="$1" name="$2" settle="$3" ready=0
  curl -sf "http://localhost:$PORT/state/$state" >/dev/null || { echo "state $state not accepted" >&2; return 1; }
  xcrun simctl terminate "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || true
  xcrun simctl launch "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || { echo "state $state could not launch" >&2; return 1; }
  for _ in $(seq 1 60); do
    sleep 2
    if curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null | grep -q '"ready":true'; then
      ready=1
      break
    fi
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "state $state never reported ready; last report:" >&2
    curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null | head -c 400 >&2 || echo "(none)" >&2
    return 1
  fi
  shoot "$name" "$settle"
}

failures=""
log "01 opening screen (shipped bundle)"
xcrun simctl terminate "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$(prep_app "$PLAIN_APP")" >/dev/null 2>&1 || { echo "the plain bundle could not be installed" >&2; exit 1; }
xcrun simctl launch "$UDID" in.thecontrarian.manorama >/dev/null 2>&1 || { echo "the plain bundle could not be launched" >&2; exit 1; }
shoot 01-opening-screen.png 5 || failures="$failures 01"

log "harness states"
xcrun simctl install "$UDID" "$(prep_app "$HARNESS_APP")" >/dev/null 2>&1 || { echo "the harness bundle could not be installed" >&2; exit 1; }
drive 0 02-gallery-curtain.png 1 || failures="$failures 02"
drive 1 03-first-image-hover.png 1 || failures="$failures 03"
drive 2 04-controls-popover.png 1 || failures="$failures 04"
drive 3 05-account-admin.png 3 || failures="$failures 05"
drive 4 06-global-view.png 2 || failures="$failures 06"

kill "$SERVER_PID" 2>/dev/null || true
log "done"
[[ -n "$failures" ]] && { echo "states that never became ready:$failures" >&2; exit 1; }
exit 0