#!/usr/bin/env bash
#
# Photograph the simulator app in each driver state. Assumes driver-server.ts is
# already listening on 4181 and the harness build is installed.
#
#   bash .work/stocktake/shoot-ios.sh 0 1 2
#
set -euo pipefail

UDID="${UDID:-650056B7-209D-435F-892F-4D9391C5C3C7}"
BUNDLE=in.thecontrarian.manorama
OUT="${OUT:-/Users/home/DEV/tools/manorama/.work/stocktake/ios}"

names=("01-curtain" "02-strip" "03-controls" "04-info" "05-selector" "06-vertical")

mkdir -p "$OUT"
for step in "$@"; do
  name="${names[$step]}"
  curl -sf "http://localhost:4181/__step?n=$step" >/dev/null
  xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
  xcrun simctl launch "$UDID" "$BUNDLE" >/dev/null 2>&1
  ready=0
  for _ in $(seq 1 40); do
    sleep 2
    body="$(curl -sf http://localhost:4181/__report 2>/dev/null || echo '')"
    if printf '%s' "$body" | grep -q '"ready":true'; then ready=1; break; fi
  done
  sleep 1
  xcrun simctl io "$UDID" screenshot "$OUT/$name.png" >/dev/null 2>&1
  printf '\n[%s] step %s -> %s.png\n' "$(date +%H:%M:%S)" "$step" "$name"
  curl -sf http://localhost:4181/__report | python3 -m json.tool 2>/dev/null | head -30 || true
  if [[ "$ready" -ne 1 ]]; then echo "  !! not ready" >&2; fi
done