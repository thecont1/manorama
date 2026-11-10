# macOS native shell — focus and error-recovery boundary test
#
# Drives the live app through the boundary the web app cannot test:
# keyboard focus moving between the native chrome and the retained web
# surface, the photographs being served from the user's own folder, and
# what happens when that folder disappears under an open gallery.
#
# The probes are AX reads and synthesised input, so the test observes the
# app the way a person would — not through the app's own internals. The
# app's own trace file is read only to confirm which side of the bridge
# handled a key.
#
# The shell opens on the app's own Library — the same bundle the Tauri
# build ships — so the test drives the Library, not a native sidebar:
# the folder is added through the app's own add flow, and the gallery is
# opened from the Library's own card.
#
# Usage:
#   scripts/test-macos-focus.sh [view-dir] [disposable-dir]
#
#   view-dir       a folder of photographs to open and navigate. Read-only:
#                  nothing in this script writes to it.
#   disposable-dir a folder this script DELETES to test error recovery.
#                  Never point it at anything you want to keep.
#
# Defaults: the ETHIOPIA originals for viewing, and a throwaway copy in
# /tmp for the deletion test.

set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

VIEW_DIR="${1:-/Users/home/DEV/websites/thecontrarian.in-original/public/library/originals/ETHIOPIA}"
DISPOSABLE="${2:-$HOME/Library/Containers/in.thecontrarian.manorama.desktop/Data/tmp/manorama-boundary-disposable}"

if [ ! -d "$VIEW_DIR" ]; then
  echo "FATAL: view-dir does not exist: $VIEW_DIR" >&2
  echo "       pass a folder of photographs as the first argument" >&2
  exit 1
fi

APP="$ROOT/macos/ManoramaMac/build/ManoramaMac.app"
BUNDLE_ID="in.thecontrarian.manorama.desktop"
# The app is sandboxed (App Store posture): a literal /tmp is denied, and a
# security-scoped bookmark cannot be minted for a path the app was never
# granted. Its own container is the one place it can always read and write,
# so every scratch artefact the suite hands it lives in the container tmp.
CTMP="$HOME/Library/Containers/in.thecontrarian.manorama.desktop/Data/tmp"
mkdir -p "$CTMP"
PROBE="/tmp/focusprobe"
TRACE="$CTMP/manorama-mac-trace.log"
SHOTS="$CTMP/manorama-mac-shots"
STORE="$CTMP/manorama-mac-folders.$$.json"
CONFIG="$CTMP/manorama-mac-config.$$"

# The view-dir is seeded inside the container as an APFS clone: the sandbox
# grants no access to an arbitrary outside path, but the container is always
# readable — and the clone keeps the folder's name, which is the title the
# Library gives the card.
SEED_DIR="$CTMP/seed-$(basename "$VIEW_DIR")"
rm -rf "$SEED_DIR"
cp -Rc "$VIEW_DIR" "$SEED_DIR"

# Where the real app keeps its account. The test borrows the session —
# the account is what says whether local galleries are allowed — and keeps
# everything else to itself. Under the sandbox the live config is in the
# container; an unsandboxed or Tauri install is the fallback source.
REAL_CONFIG="$HOME/Library/Containers/in.thecontrarian.manorama.desktop/Data/Library/Application Support/in.thecontrarian.manorama.desktop"
[ -f "$REAL_CONFIG/session.json" ] || REAL_CONFIG="$HOME/Library/Application Support/in.thecontrarian.manorama.desktop"

# The title the Library gives a local gallery: the folder's own name.
TITLE="$(basename "$VIEW_DIR")"

mkdir -p "$SHOTS"

# The probes live in the tree, not in a scratch directory: the suite has to
# be runnable by someone else.
if [ ! -x "$PROBE" ] || [ macos/Probes/AXProbe.swift -nt "$PROBE" ]; then
  echo "building the probes"
  swiftc -O macos/Probes/AXProbe.swift -framework AppKit -o "$PROBE" || exit 1
  swiftc -O macos/Probes/WindowList.swift -o /tmp/winlist || exit 1
fi

PASS=0
FAIL=0
KNOWN=0

ok()   { PASS=$((PASS+1)); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $1 — $2"; }
# Notes go to stderr: a note printed inside a command substitution would
# otherwise be captured as the command's answer.
note() { echo "      $1" >&2; }
# A limitation that was measured and is understood: reported, not failed.
known() { KNOWN=$((KNOWN+1)); echo "KNOWN $1 — $2"; }

# The app must be frontmost for the AX tree to expose its windows; a
# background app's windows live on another Space and are not addressable.
act() {
  osascript -e "tell application id \"$BUNDLE_ID\" to activate" >/dev/null 2>&1
  sleep 1.0
}

readout() {
  act
  # Each match is quoted on its own line; take the first quoted run
  # rather than the last, so a web readout and a native readout do not
  # splice into "1 of 55".
  /tmp/focusprobe "$BUNDLE_ID" readout 2>/dev/null \
    | grep -o '"[0-9][0-9]* of [0-9][0-9]*"' | head -1 | tr -d '"'
}

# Poll for the shell to report a position — the gallery opening is
# asynchronous, and a fixed sleep is either too short or a waste.
wait_readout() {
  local deadline=$((SECONDS + ${1:-12}))
  while [ $SECONDS -lt $deadline ]; do
    R=$(readout)
    [ -n "$R" ] && { echo "$R"; return 0; }
    sleep 1
  done
  echo ""
  return 1
}

# The Library's own text, as a person would read it.
library_texts() {
  act
  /tmp/focusprobe "$BUNDLE_ID" texts 2>/dev/null
}

# Wait for the Library to offer the gallery we seeded. The add runs
# through the app's own flow — pick, scan, record — so it takes a moment
# after the page reports itself ready.
wait_gallery_card() {
  local deadline=$((SECONDS + ${1:-25}))
  while [ $SECONDS -lt $deadline ]; do
    if library_texts | grep -q "$TITLE"; then return 0; fi
    sleep 1
  done
  return 1
}

# Open the seeded gallery from the Library's own card.
open_gallery() {
  for attempt in 1 2 3 4 5; do
    act
    /tmp/focusprobe "$BUNDLE_ID" pressweb "$TITLE" >/dev/null 2>&1
    R=$(wait_readout 8)
    if [ -n "$R" ]; then echo "$R"; return 0; fi
    note "attempt $attempt did not open a gallery"
  done
  echo ""
  return 1
}

# The curtain has to be dismissed before the viewer fetches anything, so
# any test that needs the photographs has to clear it first.
dismiss_curtain() {
  act
  /tmp/focusprobe "$BUNDLE_ID" pressweb "Enter gallery" >/dev/null 2>&1
  sleep 2
}

focus_domain() {
  act
  /tmp/focusprobe "$BUNDLE_ID" focus 2>/dev/null | sed -n 's/^focus: \([a-z]*\).*/\1/p'
}

page_state() {
  grep -o '"cls":"[^"]*"' "$TRACE" 2>/dev/null | tail -1
}

# Wait for the app to have a window at all.
#
# A fixed sleep is the wrong shape here for two reasons. The window
# animates into its Space after the app is up, and — right after a
# rebuild — macOS assesses the newly signed bundle on first launch, which
# takes seconds and is not the app's doing. Poll for the window instead.
wait_for_window() {
  local deadline=$((SECONDS + ${1:-45}))
  while [ $SECONDS -lt $deadline ]; do
    act
    if /tmp/focusprobe "$BUNDLE_ID" tree >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# The window's own state, once the app has a window to report. A launch
# into a Space animates, and until it has, the app has no window to ask.
wait_window() {
  local deadline=$((SECONDS + ${1:-25}))
  while [ $SECONDS -lt $deadline ]; do
    act
    S=$(/tmp/focusprobe "$BUNDLE_ID" fullscreen 2>/dev/null)
    case "$S" in
      *fullscreen=*) echo "$S"; return 0 ;;
    esac
    sleep 1
  done
  echo ""
  return 1
}

stop_app() {
  pkill -f "ManoramaMac.app/Contents/MacOS/ManoramaMac" 2>/dev/null
  # Two instances share one grant list, so a survivor would rewrite the
  # file underneath the test. Wait for the last one to go.
  local n=1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    n=$(pgrep -f "ManoramaMac.app/Contents/MacOS/ManoramaMac" | wc -l | tr -d ' ')
    [ "$n" = "0" ] && break
  done
  [ "$n" = "0" ]
}

launch() {
  # Each run gets its own grant list AND its own private documents. The
  # default location is shared with the Tauri build — which is what makes
  # the two shells one app — but a test run that wrote the user's
  # catalogue would be a test run that changes the user's library.
  #
  # "keep" leaves both alone, which is what the relaunch test needs: the
  # point is that the grant and the catalogue survive the process.
  if [ "${2:-fresh}" != "keep" ]; then
    rm -f "$STORE"
    rm -rf "$CONFIG"
    mkdir -p "$CONFIG"
    # The account is borrowed, not invented: local galleries are a Visionary
    # feature, so the test needs a signed-in session to have a local
    # gallery to open at all.
    if [ -f "$REAL_CONFIG/session.json" ]; then
      cp "$REAL_CONFIG/session.json" "$CONFIG/session.json"
    else
      echo "FATAL: no session at $REAL_CONFIG/session.json — the test cannot sign in"
      exit 1
    fi
  fi
  rm -f "$TRACE"
  PROBE_JS='JSON.stringify({cls:document.body.className,active:(document.activeElement||{}).tagName,curtain:!!document.querySelector("[data-curtain]")})'
  # `--windowed` keeps the app off the user's screen. It is the default
  # for every run except the one that proves the kiosk launch state, and
  # EXTRA_ARGS is set to empty — not unset — for that one. The expansion
  # is `${VAR-default}`, not `${VAR:-default}`, so an explicitly empty
  # value stays empty instead of falling back to `--windowed`.
  #
  # "keep" also means "do not seed again": the gallery is already in the
  # catalogue, and adding it twice would leave two cards with the same
  # name for the test to choose between.
  local SEED=""
  [ "${2:-fresh}" != "keep" ] && SEED="--seed-folder $1"
  open -n "$APP" --args $SEED --store "$STORE" --config "$CONFIG" --trace --eval "$PROBE_JS" ${EXTRA_ARGS---windowed}
  if ! wait_for_window 45; then
    echo "FATAL: the app did not come up"
    exit 1
  fi
  local n
  n=$(pgrep -f "ManoramaMac.app/Contents/MacOS/ManoramaMac" | wc -l | tr -d ' ')
  if [ "$n" != "1" ]; then
    echo "FATAL: expected exactly one instance, found $n"
    exit 1
  fi
  # One remembered folder, one gallery in the catalogue. A stale entry here
  # means a survivor rewrote the store and the card the test presses is not
  # the one it seeded.
  if [ "${2:-fresh}" = "keep" ]; then return; fi
  local stored
  stored=$(python3 -c "
import json
try: print(len(json.load(open('$STORE'))))
except Exception: print(0)")
  if [ "$stored" != "1" ]; then
    echo "FATAL: the folder store holds $stored entries, expected 1"
    exit 1
  fi
}

echo "==> stopping anything already running"
stop_app || { echo "FATAL: the shell would not quit"; exit 1; }

echo "==> opening $SEED_DIR (clone of $VIEW_DIR)"
launch "$SEED_DIR"

echo
echo "== 1. the shell comes up on the Library =="
# The Library is the landing screen because it is where the account, the
# tier, the vault meter, the pinned galleries and the local catalogue
# live. A native list of folders beside it would deliver none of that.
TEXTS=$(library_texts)
note "library text: $(echo "$TEXTS" | tr '\n' ' ' | cut -c1-160)"
if /tmp/focusprobe "$BUNDLE_ID" tree >/dev/null 2>&1; then
  ok "the shell comes up with a window"
else
  bad "the shell comes up with a window" "no window"
fi
if echo "$TEXTS" | grep -qi "Add Gallery"; then
  ok "the landing screen is the Library"
else
  bad "the landing screen is the Library" "no Add Gallery in the first screen"
fi

echo
echo "== 2. the folder is added through the app's own flow =="
# The shell hands the picker a path and the page does the rest — pick,
# scan, record — because local galleries are a Visionary feature and the
# add cannot happen before the session says who the owner is.
if wait_gallery_card 30; then
  ok "the Library offers the folder as a local gallery"
else
  bad "the Library offers the folder as a local gallery" "no card titled $TITLE"
fi
CATALOGUE=$(python3 -c "
import json
try:
  cat = json.load(open('$CONFIG/catalogue.json'))
  print(len(cat.get('galleries', [])))
except Exception:
  print(0)")
note "catalogue entries in the test's own store: $CATALOGUE"
if [ "$CATALOGUE" = "1" ]; then
  ok "the add is recorded in the app's own catalogue"
else
  bad "the add is recorded in the app's own catalogue" "$CATALOGUE entries"
fi

echo
echo "== 3. opening the gallery from the Library =="
POSITION=$(open_gallery)
note "native readout after opening: ${POSITION:-none}"
if [ -n "$POSITION" ]; then
  ok "the Library's own card opens a gallery"
else
  bad "the Library's own card opens a gallery" "no position reported"
fi

echo
echo "== 4. the web curtain =="
# The gallery opens behind the curtain, the way the web does. The page's
# own body class says whether the viewer considers itself entered, and the
# viewer's keyboard handling is gated on exactly that class — so the
# curtain has to be dismissed before the viewer answers the keyboard.
act
sleep 1
STATE=$(page_state)
note "page state before dismissing: ${STATE:-unknown}"
case "$STATE" in
  *gallery-entered*) bad "the gallery opens behind the curtain" "already entered: ${STATE:-unknown}" ;;
  *) ok "the gallery opens behind the curtain" ;;
esac
dismiss_curtain
STATE=$(page_state)
note "page state after dismissing: ${STATE:-unknown}"
case "$STATE" in
  *gallery-entered*) ok "the curtain dismisses and the page reports itself entered" ;;
  *) bad "the curtain dismisses and the page reports itself entered" "page state: ${STATE:-unknown}" ;;
esac

echo
echo "== 5. the native chrome is reachable by keyboard =="
# With the gallery open the page holds the keyboard, and Tab follows the
# page's own focus ring — the same thing the web does, and the same thing
# a WKWebView does with no browser chrome to fall through to. So Tab is
# not how the native chrome is reached.
#
# What matters is that the native commands are reachable from the
# keyboard at all. They are: Gallery > Next Photograph carries the
# option-modified arrow, which the page does not claim.
ESCAPED=no
for i in 1 2 3 4 5 6; do
  act
  /tmp/focusprobe "$BUNDLE_ID" key 48 >/dev/null 2>&1   # Tab
  sleep 0.5
  D=$(focus_domain)
  note "tab #$i -> $D"
  [ "$D" != "web" ] && ESCAPED=yes
done
if [ "$ESCAPED" = yes ]; then
  ok "Tab leaves the web surface"
else
  note "Tab stays in the page's focus ring — the same behaviour as the web"
fi
act
BEFORE=$(readout)
act
/tmp/focusprobe "$BUNDLE_ID" key 124 1 alt >/dev/null 2>&1   # option-right
sleep 1.8
AFTER=$(readout)
note "option-right: ${BEFORE:-none} -> ${AFTER:-none}"
if [ -n "$BEFORE" ] && [ "$BEFORE" != "$AFTER" ]; then
  ok "the native command answers its keyboard equivalent"
else
  bad "the native command answers its keyboard equivalent" "position unchanged (${BEFORE:-none})"
fi

echo
echo "== 6. arrow keys drive the viewer =="
act
/tmp/focusprobe "$BUNDLE_ID" clickweb
sleep 1
BEFORE=$(readout)
act
/tmp/focusprobe "$BUNDLE_ID" key 124 >/dev/null 2>&1   # Right
sleep 1.8
AFTER=$(readout)
note "right arrow: ${BEFORE:-none} -> ${AFTER:-none}"
if [ -n "$BEFORE" ] && [ "$BEFORE" != "$AFTER" ]; then
  ok "Right moves the viewer"
else
  bad "Right moves the viewer" "position unchanged (${BEFORE:-none})"
fi

echo
echo "== 7. the native menu advances by exactly one photograph =="
SEQUENCE=""
for i in 1 2 3 4; do
  act
  /tmp/focusprobe "$BUNDLE_ID" press Gallery "Next Photograph" >/dev/null
  sleep 1.6
  R=$(readout)
  # Keep the index only. The full readout ("3 of 55") would word-split
  # into three fields, and "of" is not a variable.
  SEQUENCE="$SEQUENCE ${R%% *}"
done
note "Gallery > Next Photograph, indices:$SEQUENCE"
# The command computes its target from the index the viewer last
# reported, so a step of one must land one frame on.
STEPPED=yes
PREV=""
for R in $SEQUENCE; do
  if [ -n "$PREV" ]; then
    WANT=$(( PREV + 1 ))
    [ "$R" = "$WANT" ] || STEPPED=no
  fi
  PREV="$R"
done
if [ "$STEPPED" = yes ]; then
  ok "the native menu advances one photograph at a time"
else
  bad "the native menu advances one photograph at a time" "sequence:$SEQUENCE"
fi

echo
echo "== 8. every photograph the shell served was really served =="
# The shell reads the user's originals and hands them to the viewer. A
# read that fails is the one thing the user cannot work around, and the
# alert it raises has to be about the file, not about the folder.
FAILED=$(grep -c "media read failed\|media refused" "$TRACE" 2>/dev/null)
FAILED=${FAILED:-0}
note "media failures in the trace: $FAILED"
if [ "$FAILED" = "0" ]; then
  ok "no photograph failed to load"
else
  bad "no photograph failed to load" "$FAILED media failures"
  grep "media read failed\|media refused" "$TRACE" | head -3 | sed 's/^/      /'
fi

echo
echo "== 9. Escape leaves the gallery =="
act
/tmp/focusprobe "$BUNDLE_ID" key 53 >/dev/null 2>&1   # Escape
sleep 2
# The page tells the shell that the key was not claimed by one of the
# viewer's own overlays, and the shell's own status bar goes away with the
# gallery.
ESCAPES=$(grep -c "message escape" "$TRACE" 2>/dev/null)
ESCAPES=${ESCAPES:-0}
CLOSED=$(readout)
note "escape messages: $ESCAPES, readout after Escape: ${CLOSED:-none}"
if [ -n "$CLOSED" ]; then
  bad "Escape closes the gallery" "still reporting ${CLOSED}"
elif [ "$ESCAPES" -gt 0 ]; then
  ok "Escape closes the gallery"
else
  bad "Escape closes the gallery" "the page never reported the key"
fi

echo
echo "== 10. error recovery: the folder disappears under an open gallery =="
stop_app || { echo "FATAL: the shell would not quit"; exit 1; }
rm -rf "$DISPOSABLE"
mkdir -p "$DISPOSABLE"
# A handful of real photographs, copied. This folder is the one the test
# deletes, so it is never the user's originals.
i=0
for src in "$VIEW_DIR"/*.jpg; do
  [ -e "$src" ] || break
  cp "$src" "$DISPOSABLE/$(basename "$src")"
  i=$((i+1))
  [ "$i" -ge 12 ] && break
done
DISPOSABLE_TITLE="$(basename "$DISPOSABLE")"
launch "$DISPOSABLE"
wait_gallery_card 30 >/dev/null
# The disposable gallery's card carries its own name, so the press has to
# name that one rather than the view folder's.
act
/tmp/focusprobe "$BUNDLE_ID" pressweb "$DISPOSABLE_TITLE" >/dev/null 2>&1
wait_readout 10 >/dev/null
dismiss_curtain
rm -rf "$DISPOSABLE"
sleep 1
act
# Walk past the frames the viewer already decoded. A frame still in
# memory loads from the cache and never reaches the scheme handler, so
# the loss only shows when a frame the viewer has never fetched is asked
# for.
for _ in $(seq 1 12); do
  /tmp/focusprobe "$BUNDLE_ID" key 124 >/dev/null 2>&1   # Right, into the missing folder
  sleep 0.4
done
sleep 2
STILL=$(readout)
note "readout after the folder was deleted: ${STILL:-none}"
# The shell must not crash, and it must not keep saying everything is
# fine while the photographs are gone.
TEXT=""
for _ in $(seq 1 20); do
  TEXT=$(/tmp/focusprobe "$BUNDLE_ID" texts 2>/dev/null)
  echo "$TEXT" | grep -qi "no longer in the folder\|could not be opened\|are missing" && break
  sleep 1
done
if echo "$TEXT" | grep -qi "no longer in the folder\|could not be opened\|are missing"; then
  ok "the shell tells the user the photographs are gone"
  echo "$TEXT" | grep -i "no longer in the folder\|could not be opened\|are missing" | head -2 | sed 's/^/      /'
  # The alert is the evidence, but it is a modal on somebody's screen.
  # Capture it, then put it away.
  WID=$(/tmp/winlist | awk '$3 ~ /manorama/ {print $1}' | head -1)
  [ -n "$WID" ] && screencapture -x -o -l "$WID" "$SHOTS/50-error-alert.png" 2>/dev/null
  act
  /tmp/focusprobe "$BUNDLE_ID" key 36 >/dev/null 2>&1   # Return dismisses the alert
  sleep 1
else
  bad "the shell tells the user the photographs are gone" "no error in the shell's text"
fi

echo
echo "== 11. the shell jumps to an arbitrary photograph =="
# The Viewer owns its index, and the shell asks for a target through the
# Viewer's navigation handle — it moves the stage, it never sets the
# index. The alternative, synthesising the keys a person would press,
# cannot express a jump: the right arrow is a viewport gesture rather
# than a step, so "Home, then N times ArrowRight" lands on whatever frame
# the strip stopped at rather than on N.
#
# The probe waits for the gallery to be open before asking, because the
# shell has nothing to jump to until there are frames to jump between.
stop_app || { echo "FATAL: the shell would not quit"; exit 1; }
JUMP_PROBE=$(cat <<'JS'
(() => {
  const frames = document.querySelectorAll('[data-index]').length;
  if (frames === 0) return 'no frames yet';
  if (typeof window.__manoramaGoTo !== 'function') return 'no navigation handle yet';
  if (!window.__jumpDone) {
    window.__jumpDone = true;
    window.__manoramaGoTo(30);
    return 'JUMP requested 30';
  }
  return 'JUMP settled';
})()
JS
)
rm -f "$TRACE"
# The error-recovery step left the disposable gallery in the catalogue, so
# this run seeds the view folder again — the jump is about the seam, not
# about the folder.
rm -f "$STORE"
rm -rf "$CONFIG"
mkdir -p "$CONFIG"
cp "$REAL_CONFIG/session.json" "$CONFIG/session.json"
open -n "$APP" --args --seed-folder "$SEED_DIR" --store "$STORE" --config "$CONFIG" --trace --eval "$JUMP_PROBE" --windowed
wait_for_window 45 || true
wait_gallery_card 30 >/dev/null
act
/tmp/focusprobe "$BUNDLE_ID" pressweb "$TITLE" >/dev/null 2>&1
wait_readout 10 >/dev/null
sleep 10
LANDED=$(grep "position index" "$TRACE" 2>/dev/null | tail -1 | sed -n 's/.*index=\([0-9]*\).*/\1/p')
note "asked for photograph 30, landed on index ${LANDED:-unknown}"
if [ "$LANDED" = "30" ]; then
  ok "the shell can jump to an arbitrary photograph"
else
  bad "the shell can jump to an arbitrary photograph" \
      "asked for 30, landed on ${LANDED:-unknown}"
fi

echo
echo "== 12. relaunch keeps the grant =="
stop_app || { echo "FATAL: the shell would not quit"; exit 1; }
launch "$SEED_DIR" keep
wait_gallery_card 20 >/dev/null
RESTARTED=$(open_gallery)
note "readout after a relaunch: ${RESTARTED:-none}"
if [ -n "$RESTARTED" ]; then
  ok "the folder survives a relaunch and still opens"
else
  bad "the folder survives a relaunch and still opens" "nothing reported after the restart"
fi

echo
echo "== 13. the window opens in its own Space =="
# A deliberate kiosk decision: the photographs are the product, and the
# app gives them the whole screen with no window chrome in the way. The
# menu still offers a way back to a window.
#
# This is the one launch that is allowed to take over the screen, so the
# app is relaunched WITHOUT `--windowed` — that flag is what every other
# step uses to stay out of the user's way.
stop_app || { echo "FATAL: the shell would not quit"; exit 1; }
EXTRA_ARGS=""
launch "$SEED_DIR" keep
FULL=$(wait_window 30)
note "at launch: ${FULL:-no window}"
case "$FULL" in
  *fullscreen=true*) ok "the app opens fullscreen, in its own Space" ;;
  *) bad "the app opens fullscreen, in its own Space" "at launch: ${FULL:-no window}" ;;
esac
act
/tmp/focusprobe "$BUNDLE_ID" press View "Exit Full Screen" >/dev/null 2>&1
sleep 2.5
FULL=$(/tmp/focusprobe "$BUNDLE_ID" fullscreen 2>/dev/null)
note "after Exit Full Screen: $FULL"
case "$FULL" in
  *fullscreen=false*) ok "the user can bring the window back" ;;
  *) bad "the user can bring the window back" "after Exit Full Screen: $FULL" ;;
esac
act
/tmp/focusprobe "$BUNDLE_ID" press View "Enter Full Screen" >/dev/null 2>&1
sleep 2.5
FULL=$(/tmp/focusprobe "$BUNDLE_ID" fullscreen 2>/dev/null)
note "after Enter Full Screen: $FULL"
case "$FULL" in
  *fullscreen=true*) ok "the user can go back to fullscreen" ;;
  *) bad "the user can go back to fullscreen" "after Enter Full Screen: $FULL" ;;
esac

echo
echo "== 14. the app survived =="
act
if /tmp/focusprobe "$BUNDLE_ID" tree >/dev/null 2>&1; then
  ok "the app is still alive and has a window"
else
  bad "the app is still alive and has a window" "no window"
fi

stop_app
rm -f "$STORE"
rm -rf "$CONFIG"

echo
echo "----------------------------------------"
echo "PASS $PASS   FAIL $FAIL   KNOWN $KNOWN"
[ "$FAIL" -eq 0 ] || exit 1
