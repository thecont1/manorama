#!/usr/bin/env bash
#
# Cuts the manorama App Store preview clip from a recorded take.
#
#   .work/preview/preview-14.5s.mov   -> 14.5s cut
#   .work/preview/preview-16s-asc.mov -> 16s App Store Connect cut
#
# The take is a real capture of the app; this script only trims it and encodes
# it. The copy is not burned on here: it is set in the app's own type inside the
# capture itself (see CHOREO in .work/capture-server.ts), so Playfair is
# rasterised by the same engine that rasterised the photographs beside it and
# there is no second compositor to disagree about colour. This build of ffmpeg
# has no drawtext or overlay filter in any case.
#
# It never resamples the pictures: the scale is a cover-fit that crops the odd
# device pixel rather than stretching, no grain, no vignette, no grade, no
# sharpen. The photographs arrive at the size they were recorded at and leave at
# the size Apple accepts.
#
# The head is measured, not assumed. The choreography holds the account screen
# still until it taps at a known time, so the first frame that changes is t0
# plus that tap: the difference is the head to cut. Guessing it from the
# recorder's spin-up is off by a variable few hundred milliseconds, which lands
# inside the opening hold and eats into it.
#
#   scripts/capture-preview.sh   # record
#   scripts/encode-preview.sh    # this script
#
# Options:
#   --only 14.5|16   encode one cut (default: both)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAKES="$REPO/.work/preview"
DELIVER="$REPO/.work/preview/deliver"


# Apple's accepted upload size for the 6.9"/6.5" iPhone slots.
W=886
H=1920

ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1m%s\033[0m\n' "$*"; }
mkdir -p "$DELIVER"

# --- cut definitions ----------------------------------------------------------

# name:raw  seconds  overlay windows (relative to the cut, not the take)
cuts=(
  "preview-14.5s:14.5"
  "preview-16s-asc:16.0"
)
[[ -n "$ONLY" ]] && cuts=("preview-$ONLY:$([[ "$ONLY" == "16" ]] && echo 16.0 || echo 14.5)")

# --- helpers ------------------------------------------------------------------

# The instant the choreography's clock started, expressed in take time.
#
# The tap is the anchor: the account screen is held still until the choreography
# taps the gallery card at a time the page reported, and the tap is by far the
# largest change in the take. So the first frame that moves by more than a
# threshold is t0 plus that tap, and the difference is the head to cut.
#
# A much lower threshold finds a smaller, earlier change — the copy layer
# mounting at t0 — and lands within ~30ms of the same answer. It is a useful
# cross-check but not the primary: before the copy was part of the capture there
# was nothing at t0 at all, and the low threshold would have reported the tap
# itself as the first motion. The tap is the one landmark that is always there.
t0_in_take() {
  local raw="$1"
  ffmpeg -v error -i "$raw" -vf "select='gt(scene,0.0015)',metadata=print:file=-" -an -f null - 2>/dev/null \
    | sed -n 's/.*pts_time:\([0-9.]*\).*/\1/p' | head -1
}

tapped_at() {
  python3 -c "
import json,sys
m=json.load(open('$1'.replace('.mov','.json')))
print(m['marks']['tappedCard'])"
}

# --- one cut ------------------------------------------------------------------

for cut in "${cuts[@]}"; do
  name="${cut%%:*}"
  seconds="${cut##*:}"
  raw="$TAKES/$name.mov"
  [[ -s "$raw" ]] || { echo "no take at $raw — run scripts/capture-preview.sh" >&2; exit 1; }

  log "$name -> ${seconds}s"

  tap="$(tapped_at "$raw")"
  first_motion="$(t0_in_take "$raw")"
  if [[ -z "$first_motion" ]]; then
    echo "  could not find the first motion in the take" >&2
    exit 1
  fi
  head="$(python3 -c "print(round(max(0.0, $first_motion - $tap), 3))")"
  echo "  tap at ${tap}s, first motion at ${first_motion}s -> head ${head}s"

  # The copy rides the take's own clock, so there is nothing to window here.
  # The 16s cut simply holds the same end frame 1.5s longer, which is where the
  # extra second goes and where Apple wants the sign-in disclosure to sit.
  out="$DELIVER/$name.mp4"

  # Cover-fit, then crop the odd pixel. The recording is 1284x2778 (19.5:9) and
  # the slot is 886x1920; scaling to the width instead would stretch the frame
  # by 0.16% and scaling to the height and padding would letterbox. Cropping
  # one or two columns is the only one of the three that neither lies about the
  # aspect nor adds a bar.
  # Output seeking, not input. The simulator's recording carries a keyframe
  # every couple of seconds, and `-ss` before `-i` snaps to one — which silently
  # threw away 1.6s of the head and left the cut short. Seeking after `-i`
  # decodes and discards, so the cut starts where it says it does.
  ffmpeg -y -v error -i "$raw" -ss "$head" -t "$seconds" \
    -vf "scale=-2:$H,crop=$W:$H,setsar=1,fps=30" \
    -c:v libx264 -profile:v high -level:v 4.0 -preset slow \
    -b:v 12M -minrate 10M -maxrate 12M -bufsize 24M -pix_fmt yuv420p \
    -x264-params "keyint=60:min-keyint=60:scenecut=0" \
    -an -movflags +faststart \
    "$out"

  # The poster frame has to stand on its own at 5.0s, so it is cut from the
  # delivered file rather than the take — it is the frame the store shows.
  ffmpeg -y -v error -ss 5.0 -i "$out" -frames:v 1 "$DELIVER/$name-poster-5s.png"

  ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_name,profile,level,width,height,r_frame_rate,pix_fmt,bit_rate \
    -show_entries format=duration,size -of default=nw=1 "$out" | sed 's/^/  /'

  # A take that ran short must fail here rather than ship as a clip that ends
  # mid-gesture. 0.2s of tolerance is the frame boundary.
  got="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")"
  short="$(python3 -c "print(1 if $got < $seconds - 0.2 else 0)")"
  if [[ "$short" -eq 1 ]]; then
    echo "  cut is ${got}s, wanted ${seconds}s — the take ran short" >&2
    echo "  raise TAIL in scripts/capture-preview.sh and record again" >&2
    exit 1
  fi
done

log "deliverables in $DELIVER"
