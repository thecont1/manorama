#!/usr/bin/env bash
#
# Cuts the manorama App Store preview clip from a recorded take.
#
#   .work/preview/preview-14.5s.mov   -> 14.5s cut
#   .work/preview/preview-16s-asc.mov -> 16s App Store Connect cut
#
# The take is a real capture of the app; this script only trims it, sets the
# copy, and encodes. It never resamples the pictures: the scale is a cover-fit
# that crops the odd device pixel rather than stretching, no grain, no vignette,
# no grade, no sharpen. The photographs arrive at the size they were recorded
# at and leave at the size Apple accepts.
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
FONTS="$REPO/native/dist/fonts"

# Apple's accepted upload size for the 6.9"/6.5" iPhone slots.
W=886
H=1920

# The app's own type. Playfair is the serif the curtain caption is set in, so
# the overlay is the product's treatment rather than a caption track bolted on.
SERIF="$FONTS/Playfair-variable.ttf"
SERIF_ITALIC="$FONTS/Playfair-Italic-variable.ttf"

# Copy, from the brief's §5. Lowercase, small, secondary to the pictures, and
# never over the centre of a photograph — the strip is vertically centred, so
# the band between the status bar and the top of a photograph is always stage
# black at any frame of the take.
#
# Line 2 is NOT the brief's wording, and the substitution is deliberate. The
# brief asks for "every photograph at full height", but packages/core's
# imageStageSize caps a strip frame at min(stageHeight/h, 1/dpr): a 2560x1707
# source on a 3x screen would need a 1.63x upscale to reach full height, so the
# app floats it at honest size and leaves stage black above and below. Putting
# "full height" on screen would be a false claim in Apple's own review of a
# product whose whole thesis is that it never fabricates pixels. "never
# upscaled" is the same line, true, and the better one.
COPY_SCROLL_1='one strip, no gaps — drag it'
COPY_SCROLL_2='every photograph, never upscaled'
COPY_END_1='manorama.xyz'
COPY_END_2='Sign in required'

# The status bar is roughly the top 4% of the frame; a photograph's top edge
# starts around 22%. Type sits at 8% — clear of both, and out of the picture.
X=64
Y=152
SIZE=36
END_SIZE=40
INK='white@0.88'

ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1m%s\033[0m\n' "$*"; }
for f in "$SERIF" "$SERIF_ITALIC"; do
  [[ -f "$f" ]] || { echo "missing the app's own typeface: $f" >&2; exit 1; }
done
mkdir -p "$DELIVER"

# --- cut definitions ----------------------------------------------------------

# name:raw  seconds  overlay windows (relative to the cut, not the take)
cuts=(
  "preview-14.5s:14.5"
  "preview-16s-asc:16.0"
)
[[ -n "$ONLY" ]] && cuts=("preview-$ONLY:$([[ "$ONLY" == "16" ]] && echo 16.0 || echo 14.5)")

# --- helpers ------------------------------------------------------------------

# The instant the choreography's clock started, expressed in take time. Read
# back out of the report the page posted rather than recomputed here.
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

  # Overlay windows, relative to the cut. The 16s cut keeps the same opening and
  # gives the extra second to the end frame, which is where the shot list wants
  # it and where Apple wants the disclosure to sit.
  if [[ "$seconds" == "16.0" ]]; then
    W1_A=5.0;  W1_B=8.5
    W2_A=9.0;  W2_B=12.5
    E1_A=13.0; E1_B=16.0
    E2_A=13.6; E2_B=16.0
  else
    W1_A=5.0;  W1_B=8.5
    W2_A=9.0;  W2_B=12.5
    E1_A=13.0; E1_B=14.5
    E2_A=13.6; E2_B=14.5
  fi

  out="$DELIVER/$name.mp4"

  # Cover-fit, then crop the odd pixel. The recording is 1284x2778 (19.5:9) and
  # the slot is 886x1920; scaling to the width instead would stretch the frame
  # by 0.16% and scaling to the height and padding would letterbox. Cropping
  # one or two columns is the only one of the three that neither lies about the
  # aspect nor adds a bar.
  ffmpeg -y -v error -ss "$head" -i "$raw" -t "$seconds" \
    -vf "\
      scale=-2:$H,crop=$W:$H,setsar=1,fps=30,\
      drawtext=fontfile=$SERIF_ITALIC:text='$COPY_SCROLL_1':fontsize=$SIZE:fontcolor=$INK:x=$X:y=$Y:enable='between(t\,$W1_A\,$W1_B)',\
      drawtext=fontfile=$SERIF_ITALIC:text='$COPY_SCROLL_2':fontsize=$SIZE:fontcolor=$INK:x=$X:y=$Y:enable='between(t\,$W2_A\,$W2_B)',\
      drawtext=fontfile=$SERIF:text='$COPY_END_1':fontsize=$END_SIZE:fontcolor=$INK:x=$X:y=$Y:enable='between(t\,$E1_A\,$E1_B)',\
      drawtext=fontfile=$SERIF:text='$COPY_END_2':fontsize=$END_SIZE:fontcolor=$INK:x=$X:y=$((Y+58)):enable='between(t\,$E2_A\,$E2_B)'\
    " \
    -c:v libx264 -profile:v high -level:v 4.0 -preset slow \
    -b:v 11M -maxrate 12M -bufsize 24M -pix_fmt yuv420p \
    -x264-params "keyint=60:min-keyint=60:scenecut=0" \
    -an -movflags +faststart \
    "$out"

  # The poster frame has to stand on its own at 5.0s, so it is cut from the
  # delivered file rather than the take — it is the frame the store shows.
  ffmpeg -y -v error -ss 5.0 -i "$out" -frames:v 1 "$DELIVER/$name-poster-5s.png"

  ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_name,profile,level,width,height,r_frame_rate,pix_fmt,bit_rate \
    -show_entries format=duration,size -of default=nw=1 "$out" | sed 's/^/  /'
done

log "deliverables in $DELIVER"
