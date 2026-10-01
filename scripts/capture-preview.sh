#!/usr/bin/env bash
#
# Records the manorama App Store preview clip.
#
#   5  the 14.5s cut as briefed
#   6  the 16s App Store Connect cut — same timeline, scroll eased out, end
#      frame held two seconds longer
#
# Everything in the frame is the app. The harness serves the real
# `native/dist` bundle and injects the choreography, so the account surface, the
# curtain, the lift and the strip are the product's own pixels in the app's own
# webview, and the drag runs the viewer's own pointer path — the 1:1 tracking
# and the momentum glide in the clip are the shipping physics, not a
# re-creation. Nothing is drawn over the photographs here; the copy overlays
# are composited afterwards by scripts/encode-preview.sh.
#
# The recorder starts first and only then releases the choreography's gate, so
# the take opens on the first frame of the hold rather than whenever the app
# happened to finish booting. The page reports the wall-clock instant that was,
# and this script writes it next to the take for the encoder to trim against.
#
# Reuses the harness build from scripts/capture-screens.sh. That build embeds
# `server.url` pointing here; the committed capacitor.config.ts does not, which
# is why that script owns the toggle and restores it.
#
#   scripts/capture-screens.sh            # once, to produce the harness build
#   scripts/capture-preview.sh            # this script
#   scripts/encode-preview.sh             # trim, overlays, encode
#
# Options:
#   --state 5|6   one take only (default: both)
#   --out DIR     where the raw takes land (default: .work/preview)
#   --skip-dims   reuse /tmp/mano-photo-dims.json instead of measuring

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=4181
HARNESS_APP=/tmp/capture-harness-build/Build/Products/Debug-iphonesimulator/App.app
BUNDLE=in.thecontrarian.manorama
STATES=(5 6)
OUT="$REPO/.work/preview"
SKIP_DIMS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state) STATES=("$2"); shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --skip-dims) SKIP_DIMS=1; shift ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1m%s\033[0m\n' "$*"; }
cleanup() { pkill -f 'capture-server.ts' 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# --- the device ---------------------------------------------------------------

existing="$(xcrun simctl list devices available | grep -E 'iPhone 13 Pro Max' | sed -n '1p' | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/' || true)"
[[ -n "$existing" ]] || { echo "no available iPhone 13 Pro Max simulator" >&2; exit 1; }
UDID="$existing"
log "using simulator $UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true

# --- the app ------------------------------------------------------------------

[[ -d "$HARNESS_APP" ]] || {
  echo "no harness build at $HARNESS_APP" >&2
  echo "run scripts/capture-screens.sh once to produce it" >&2
  exit 1
}

# The staged copy carries the ATS exception that lets the webview reach
# localhost. Same reasoning as capture-screens.sh's prep_app: the shipped
# bundle must not gain a cleartext allowance, only the capture copy.
STAGE=/tmp/stage-capture-preview
mkdir -p "$STAGE"
rm -rf "$STAGE/App.app"
cp -R "$HARNESS_APP" "$STAGE/App.app"
PLIST="$STAGE/App.app/Info.plist"
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true" "$PLIST" 2>/dev/null || true
codesign --force -s - "$STAGE/App.app" >/dev/null 2>&1

# --- true pixel dimensions ----------------------------------------------------

# The public manifest advertises the 256x171 thumbnail, not the master. A
# manifest that serves the real originals has to declare the real width and
# height or the viewer heals each frame the moment it decodes, and the strip
# reflows in the middle of the clip.
if [[ "$SKIP_DIMS" -eq 0 ]]; then
  log "measuring the owner's originals"
  python3 - <<'PY'
import json, subprocess, pathlib
pd = pathlib.Path('/Users/home/Library/CloudStorage/Dropbox/italy')
dims = {}
for p in sorted(pd.glob('*.jpg')):
    out = subprocess.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', str(p)],
                         capture_output=True, text=True).stdout
    w = h = None
    for line in out.splitlines():
        if 'pixelWidth' in line: w = int(line.split(':')[1])
        if 'pixelHeight' in line: h = int(line.split(':')[1])
    dims[p.name] = [w, h]
if not dims:
    raise SystemExit('no originals found — the capture would race the network')
pathlib.Path('/tmp/mano-photo-dims.json').write_text(json.dumps(dims, indent=1))
print(f'  {len(dims)} originals, {len({tuple(v) for v in dims.values()})} distinct sizes')
PY
fi

# --- the harness --------------------------------------------------------------

mkdir -p "$OUT"
( cd "$REPO" && bun .work/capture-server.ts >/tmp/capture-preview-server.log 2>&1 & )
for _ in $(seq 1 20); do
  sleep 1
  curl -sf "http://localhost:$PORT/__capture/report" >/dev/null 2>&1 && break
done
curl -sf "http://localhost:$PORT/state/0" >/dev/null || { echo "harness did not start; see /tmp/capture-preview-server.log" >&2; exit 1; }
log "harness up on $PORT"

# --- one take per state -------------------------------------------------------

# How long to keep rolling after the choreography reports it is done. The last
# stroke settles before the end frame; the frame itself is a hold, so the tail
# is what actually records it.
TAIL=2.4

for state in "${STATES[@]}"; do
  case "$state" in
    5) name=preview-14.5s ;;
    6) name=preview-16s-asc ;;
    *) echo "state $state is not a preview state" >&2; exit 2 ;;
  esac
  log "state $state -> $name"

  curl -sf "http://localhost:$PORT/state/$state" >/dev/null
  xcrun simctl terminate "$UDID" "$BUNDLE" >/dev/null 2>&1 || true
  xcrun simctl install "$UDID" "$STAGE/App.app" >/dev/null 2>&1
  xcrun simctl launch "$UDID" "$BUNDLE" >/dev/null 2>&1

  ready=0
  for _ in $(seq 1 60); do
    sleep 2
    if curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null | grep -q '"stage":"account"'; then
      ready=1
      break
    fi
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "state $state never reached the account surface" >&2
    curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null >&2 || echo "(no report)" >&2
    exit 1
  fi

  raw="$OUT/$name.mov"
  rm -f "$raw"
  # --mask=ignored keeps the recording free of the simulator's own furniture;
  # there is no device frame in the delivered clip either way.
  xcrun simctl io "$UDID" recordVideo --codec=h264 --mask=ignored "$raw" >/dev/null 2>&1 &
  recorder=$!
  # Let the encoder actually roll before the gate opens, or the head of the
  # hold is lost to spin-up.
  sleep 2.5
  send_ms=$(python3 -c 'import time; print(int(time.time()*1000))')
  curl -sf -X POST "http://localhost:$PORT/__capture/run" >/dev/null
  recv_ms=$(python3 -c 'import time; print(int(time.time()*1000))')

  done_ok=0
  for _ in $(seq 1 40); do
    sleep 1
    if curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null | grep -q '"stage":"done"'; then
      done_ok=1
      break
    fi
    if curl -sf "http://localhost:$PORT/__capture/report" 2>/dev/null | grep -q '"stage":"error"'; then
      break
    fi
  done
  sleep "$TAIL"
  # SIGINT is how simctl finalises the container; without it the file has no
  # moov atom and will not open.
  kill -INT "$recorder" 2>/dev/null || true
  wait "$recorder" 2>/dev/null || true

  [[ -s "$raw" ]] || { echo "no take recorded for state $state" >&2; exit 1; }

  python3 - "$raw" "$send_ms" "$recv_ms" <<'PY'
import json, subprocess, sys, pathlib
raw, send_ms, recv_ms = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
report = json.loads(subprocess.run(
    ['curl', '-sf', 'http://localhost:4181/__capture/report'],
    capture_output=True, text=True).stdout or '{}')
marks = report.get('marks') or {}
meta = {'state': report.get('state'), 'ready': report.get('ready'), 'marks': marks,
        'triggerSendMs': send_ms, 'triggerRecvMs': recv_ms}
if 'epochAtT0' in marks:
    # Cross-check only. The recorder's own spin-up is unknowable from here, so
    # the encoder measures the head from the footage instead: the account screen
    # is static until the tap, so the first frame that changes is t0 + 1.5s.
    meta['headEstimate'] = round(max(0.0, (send_ms - marks['epochAtT0']) / 1000), 3)
pathlib.Path(raw).with_suffix('.json').write_text(json.dumps(meta, indent=1))
print('  marks:', json.dumps({k: v for k, v in marks.items() if k != 'epochAtT0'}))
if 'headEstimate' in meta:
    print('  head estimate (encoder measures the real one):', meta['headEstimate'], 's')
PY

  ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,codec_name \
    -of default=nw=1 "$raw" | sed 's/^/  /'
done

log "takes in $OUT"
