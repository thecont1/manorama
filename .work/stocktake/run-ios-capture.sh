#!/usr/bin/env bash
#
# Drive the already-built simulator apps through the capture harness states and
# photograph each one. This is scripts/capture-screens.sh minus the two Xcode
# builds, which are slow and already done.
#
#   bash .work/stocktake/run-ios-capture.sh            # all six states
#   bash .work/stocktake/run-ios-capture.sh 0 1 2      # selected states
#
set -euo pipefail

REPO=/Users/home/DEV/tools/manorama
PORT=4181
UDID="${UDID:-650056B7-209D-435F-892F-4D9391C5C3C7}"
OUT="$REPO/.work/stocktake/ios"
HARNESS=/tmp/capture-harness-build/Build/Products/Debug-iphonesimulator/App.app
PLAIN=/tmp/capture-plain-build/Build/Products/Debug-iphonesimulator/App.app
BUNDLE=in.thecontrarian.manorama

states=("$@")
if [[ ${#states[@]} -eq 0 ]]; then states=(0 1 2 3 4); fi

log() { printf '\033[1m%s\033[0m\n' "$*"; }

stage() { # <src app> <stage dir>
  local src="$1" dest="$2"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$src" "$dest/App.app"
  local plist="$dest/App.app/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true" "$plist" 2>/dev/null || true
  codesign --force -s - "$dest/App.app" >/dev/null 2>&1
}

wait_ready() { # <seconds>
  local limit="$1" i
  for ((i = 0; i < limit; i++)); do
    sleep 2
    if curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null | grep -q '"ready":true'; then
      return 0
    fi
  done
  return 1
}

mkdir -p "$OUT"

for state in "${states[@]}"; do
  case "$state" in
    0) name=02-gallery-curtain.png ;;
    1) name=03-first-image.png ;;
    2) name=04-controls-popover.png ;;
    3) name=05-account-admin.png ;;
    4) name=06-global-view.png ;;
    *) echo "unknown state $state" >&2; exit 2 ;;
  esac

  if [[ "$state" == "0" ]]; then
    log "state 0 (curtain) — harness"
    stage "$HARNESS" /tmp/stage-harness
    curl -sf "http://localhost:$PORT/state/$state" >/dev/null
    xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
    xcrun simctl install "$UDID" /tmp/stage-harness/App.app >/dev/null 2>&1
    xcrun simctl launch "$UDID" "$BUNDLE" >/dev/null 2>&1
    sleep 8
    xcrun simctl io "$UDID" screenshot "$OUT/$name" >/dev/null 2>&1
    printf '  %-30s %s\n' "$name" "$(sips -g pixelWidth -g pixelHeight "$OUT/$name" 2>/dev/null | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}')"
    continue
  fi

  log "state $state -> $name"
  curl -sf "http://localhost:$PORT/state/$state" >/dev/null
  xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
  xcrun simctl launch "$UDID" "$BUNDLE" >/dev/null 2>&1
  if ! wait_ready 45; then
    echo "state $state never reported ready; last report:" >&2
    curl -sf "http://localhost:$PORT/__capture/report" >&2 || echo "(none)" >&2
    exit 1
  fi
  sleep 2
  xcrun simctl io "$UDID" screenshot "$OUT/$name" >/dev/null 2>&1
  printf '  %-30s %s\n' "$name" "$(sips -g pixelWidth -g pixelHeight "$OUT/$name" 2>/dev/null | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}')"
done

log "done"