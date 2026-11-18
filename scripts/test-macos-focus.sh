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
#   MANORAMA_FOCUS_SESSION=/path/to/session.json \
#     scripts/test-macos-focus.sh [view-dir] [disposable-dir]
#
#   view-dir       a folder of photographs to open and navigate. Read-only:
#                  nothing in this script writes to it.
#   disposable-dir a folder this script DELETES to test error recovery.
#                  Must live inside the focus-test container; defaults to a
#                  fresh one there.
#
# MANORAMA_FOCUS_SESSION names a session.json to seed into the test's
# isolated config — local galleries are a Visionary feature, so the suite
# needs a signed-in account to have anything to open. It is never guessed:
# pointing the suite at an account is an explicit act, not a silent
# borrow, because the session belongs to a real owner.
#
# Defaults: the ETHIOPIA originals for viewing, and a throwaway copy in
# the focus-test container for the deletion test.

set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

VIEW_DIR="${1:-/Users/home/DEV/websites/thecontrarian.in-original/public/library/originals/ETHIOPIA}"

if [ ! -d "$VIEW_DIR" ]; then
  echo "FATAL: view-dir does not exist: $VIEW_DIR" >&2
  echo "       pass a folder of photographs as the first argument" >&2
  exit 1
fi

APP="$ROOT/macos/ManoramaMac/build-focus-test/manorama.app"
# The suite's app is built with its OWN bundle identifier — a startup-arg
# probe override alone is not enough: `tell application id`, focusprobe,
# and the single-instance check all resolve the bundle's real
# CFBundleIdentifier, so only a distinct one keeps every probe aimed at
# this instance instead of an installed copy. The sandboxed container is
# keyed to that id too, so all scratch lives under the focus-test one.
BUNDLE_ID="in.thecontrarian.manorama.desktop.focus-test"
# The app is sandboxed (App Store posture): a literal /tmp is denied, and a
# security-scoped bookmark cannot be minted for a path the app was never
# granted. Its own container is the one place it can always read and write,
# so every scratch artefact the suite hands it lives in the container tmp.
CTMP="$HOME/Library/Containers/$BUNDLE_ID/Data/tmp"
mkdir -p "$CTMP"

# The disposable folder lives inside the focus-test container, never the
# installed app's: a supplied path outside this container is refused,
# because the test deletes it and deletion belongs inside the sandbox's
# own scratch.
DISPOSABLE="${2:-$CTMP/disposable-$$}"
# A lexical prefix check alone lets "$CTMP/../x" or a symlinked parent
# escape the container — and the suite rm -rf's this path. Resolve both
# sides (realpath collapses .. and follows links even for tails that do
# not exist yet), require a strict descendant of the resolved scratch
# dir, and keep the resolved path so every later use stays validated.
CTMP_REAL="$(CTMP="$CTMP" python3 -c 'import os; print(os.path.realpath(os.environ["CTMP"]))')"
DISPOSABLE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$DISPOSABLE")"
case "$DISPOSABLE" in
  "$CTMP_REAL"/*) ;;
  *)
    echo "FATAL: disposable-dir must live inside $CTMP_REAL" >&2
    echo "       got: $DISPOSABLE" >&2
    exit 1
    ;;
esac

# The account session is an explicit argument, not something found on
# disk. Seeding the test config from a file the caller chose is what keeps
# an "isolated" run honest about which account it touches.
SESSION_FILE="${MANORAMA_FOCUS_SESSION:-}"
if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
  echo "FATAL: MANORAMA_FOCUS_SESSION does not name a session.json" >&2
  echo "       the suite needs an explicitly authorized test account —" >&2
  echo "       point it at a session.json for the account it may use" >&2
  exit 1
fi

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

# Every exit — pass, fail or a mid-suite abort — retires the test app and
# its scratch. A failure must not leave a running instance writing the
# next run's store, and the disposable fixture is always under the
# focus-test container, so its removal is bounded by construction.
cleanup() {
  pkill -f "build-focus-test/manorama.app/Contents/MacOS/manorama" 2>/dev/null
  rm -rf "$SEED_DIR" "$DISPOSABLE" "$CONFIG" 2>/dev/null
  rm -f "$STORE" 2>/dev/null
}
trap cleanup EXIT

# The title the Library gives a local gallery: the folder's own name.
TITLE="$(basename "$VIEW_DIR")"

mkdir -p "$SHOTS"

# The probes live in the tree, not in a scratch directory: the suite has to
# be runnable by someone else.
if [ ! -x "$PROBE" ] || [ macos/Probes/AXProbe.swift -nt "$PROBE" ]; then
  echo "building the AX probe"
  swiftc -O macos/Probes/AXProbe.swift -framework AppKit -o "$PROBE" || exit 1
fi
if [ ! -x /tmp/winlist ] || [ macos/Probes/WindowList.swift -nt /tmp/winlist ]; then
  echo "building the window probe"
  swiftc -O macos/Probes/WindowList.swift -o /tmp/winlist || exit 1
fi

# The suite's own .app — rebuilt every run so the binary under test always
# matches the tree — lands outside the shared build directory so a normal
# build is never clobbered.
echo "building the focus-test shell ($BUNDLE_ID)"
MANORAMA_MACOS_BUNDLE_ID="$BUNDLE_ID" MANORAMA_MACOS_BUILD_DIR="$ROOT/macos/ManoramaMac/build-focus-test" \
  scripts/build-macos.sh >/dev/null || { echo "FATAL: the focus-test build failed"; exit 1; }

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
# into a Space animates, and until it has, the app has no window to ask —
# and the first readable answer is not the settled one. Poll until the
# expected fullscreen state arrives; on timeout return the last state
# seen so the caller can report what the window actually did.
wait_window() {
  local want="$1" deadline=$((SECONDS + ${2:-25})) last=""
  while [ $SECONDS -lt $deadline ]; do
    act
    S=$(/tmp/focusprobe "$BUNDLE_ID" fullscreen 2>/dev/null)
    case "$S" in
      *fullscreen=$want*) echo "$S"; return 0 ;;
      *fullscreen=*) last="$S" ;;
    esac
    sleep 1
  done
  echo "$last"
  return 1
}

wait_trace() {
  # Poll the app's own trace for a marker line — the ordered witness for
  # events an AX sample can miss between polls (a fullscreen interval,
  # for one). The argument is a grep basic regular expression.
  local want="$1" deadline=$((SECONDS + ${2:-15}))
  while [ $SECONDS -lt $deadline ]; do
    grep -q "$want" "$TRACE" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

stop_app() {
  # Only the focus-test build is killed — a running installed copy is
  # what the suite proves it can coexist with.
  pkill -f "build-focus-test/manorama.app/Contents/MacOS/manorama" 2>/dev/null
  # Two instances share one grant list, so a survivor would rewrite the
  # file underneath the test. Wait for the last one to go.
  local n=1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    n=$(pgrep -f "build-focus-test/manorama.app/Contents/MacOS/manorama" | wc -l | tr -d ' ')
    [ "$n" = "0" ] && break
  done
  [ "$n" = "0" ]
}

quit_app() {
  # A graceful quit, the way a person leaves the app. State that only
  # exists in memory — SwiftUI's window-frame autosave included — is
  # flushed to defaults here; a SIGTERM skips that flush, so tests that
  # measure persistence across a relaunch must end the first run this
  # way. Fall back to the kill if the quit does not take.
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1
  local n=1
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sleep 0.5
    n=$(pgrep -f "build-focus-test/manorama.app/Contents/MacOS/manorama" | wc -l | tr -d ' ')
    [ "$n" = "0" ] && return 0
  done
  stop_app
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
    # The session the caller named is copied in — the account is what says
    # whether local galleries are allowed, and the caller's explicit file
    # is the only credential this suite will ever use.
    cp "$SESSION_FILE" "$CONFIG/session.json" || {
      echo "FATAL: could not seed $SESSION_FILE into the test config"
      exit 1
    }
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
  # The suite's instance must coexist with an installed manorama.app —
  # its real bundle id is the focus-test one, so the single-instance
  # probe sees no installed copy and every AX call resolves this app.
  open -n "$APP" --args $SEED --store "$STORE" --config "$CONFIG" --trace --eval "$PROBE_JS" ${EXTRA_ARGS---windowed}
  if ! wait_for_window 45; then
    echo "FATAL: the app did not come up"
    exit 1
  fi
  local n
  n=$(pgrep -f "build-focus-test/manorama.app/Contents/MacOS/manorama" | wc -l | tr -d ' ')
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

# Isolation is only proven if it was exercised: a signed-in Library
# registers the device with PUT /api/devices/{id} on mount, so by this
# point the guard must have answered at least one mutating call locally.
# An empty marker list means either registration never fired or the guard
# never logged — either way the "isolated" claim is unproven.
GUARDED=$(grep -c "isolated: answered" "$TRACE" 2>/dev/null)
GUARDED=${GUARDED:-0}
note "mutations answered locally by the guard: $GUARDED"
if [ "$GUARDED" -gt 0 ]; then
  ok "the isolation guard intercepted mutating calls"
  grep "isolated: answered" "$TRACE" | head -3 | sed 's/^/      /'
else
  bad "the isolation guard intercepted mutating calls" \
      "no mutation reached the scheme handler across the run"
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
echo "== 10. the floating Library capsule =="
# On 26+ the shell's own glass capsule takes the web pill's seat: it mounts
# while the viewer's chrome is showing and pressing it must land back on
# the Library — the same contract Escape holds, exercised on the native
# control itself. The web pill is suppressed (data-macos-glass), so this
# press also proves there is still exactly one way back. The capsule is a
# macOS 26 API — on older systems the web pill stays and there is nothing
# native to press, so the section skips rather than fails.
MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if [ "${MACOS_MAJOR:-0}" -lt 26 ]; then
  echo "  (skipped: the glass capsule needs macOS 26+, this is $MACOS_MAJOR)"
elif POSITION=$(open_gallery); then
note "readout after reopening: ${POSITION:-none}"
dismiss_curtain
act
/tmp/focusprobe "$BUNDLE_ID" clickweb >/dev/null 2>&1
sleep 2
if /tmp/focusprobe "$BUNDLE_ID" pressnative "Library" >/dev/null 2>&1; then
  ok "the glass capsule is present and pressable"
else
  bad "the glass capsule is present and pressable" "no native Library button in the AX tree"
fi
sleep 2
CLOSED=$(readout)
if [ -z "$CLOSED" ]; then
  ok "the capsule returns to the Library"
else
  bad "the capsule returns to the Library" "still reporting ${CLOSED}"
fi
else
  # Skipping the whole section on a setup failure would let the capsule
  # pass untested — the open ran its five attempts, so the failure is a
  # finding, not an absence.
  bad "the glass capsule is present and pressable" "the gallery never opened for the capsule test"
fi

echo
echo "== 11. error recovery: the folder disappears under an open gallery =="
stop_app || { echo "FATAL: the shell would not quit"; exit 1; }
rm -rf "$DISPOSABLE"
mkdir -p "$DISPOSABLE"
# Thirty real photographs, copied — enough that the viewer's decode
# window cannot hold them all. With fewer, every frame is fetched before
# the folder goes and the deletion never reaches the scheme handler.
# This folder is the one the test deletes, so it is never the user's
# originals.
i=0
for src in "$VIEW_DIR"/*.jpg; do
  [ -e "$src" ] || break
  cp "$src" "$DISPOSABLE/$(basename "$src")"
  i=$((i+1))
  [ "$i" -ge 30 ] && break
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
# for — twenty arrows into thirty photographs guarantees that.
for _ in $(seq 1 20); do
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
echo "== 12. the shell jumps to an arbitrary photograph =="
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
cp "$SESSION_FILE" "$CONFIG/session.json"
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
echo "== 13. relaunch keeps the grant =="
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
echo "== 14. the window mode is the user's choice =="
# The old kiosk behaviour — every launch opening into its own fullscreen
# Space — is now the "Open in full screen" setting, and the default is a
# normal window. The setting is a UserDefaults value in the focus-test
# app's own domain, so these runs can flip it between launches without
# touching the installed app's preferences.
#
# The fresh-install case deletes the key rather than writing false: an
# explicit false is a decision the user made, an absent key is a default
# the app must supply — only the second proves what a new owner gets.
defaults delete "$BUNDLE_ID" openInFullScreen 2>/dev/null
stop_app || { echo "FATAL: the shell would not quit"; exit 1; }
# EXTRA_ARGS="" means no --windowed: the one place a launch may enter a
# Space, because the setting is what is being measured.
EXTRA_ARGS=""
launch "$SEED_DIR" keep
FULL=$(wait_window false 30)
note "at launch, fresh default: ${FULL:-no window}"
case "$FULL" in
  *fullscreen=false*) ok "a launch with no preference stays windowed" ;;
  *) bad "a launch with no preference stays windowed" "at launch: ${FULL:-no window}" ;;
esac

# The setting is the Settings scene's own toggle, so the test drives the
# real control rather than an outside defaults write: open the pane,
# press the checkbox, prove the value persisted, and only then prove the
# next launch honours it.
act
/tmp/focusprobe "$BUNDLE_ID" press manorama "Settings" >/dev/null 2>&1 \
  || /tmp/focusprobe "$BUNDLE_ID" key 43 1 - cmd >/dev/null 2>&1
sleep 2
if /tmp/focusprobe "$BUNDLE_ID" pressui "Open in full screen" >/dev/null 2>&1; then
  sleep 1
  PERSISTED=$(defaults read "$BUNDLE_ID" openInFullScreen 2>/dev/null || echo absent)
  note "after pressing the toggle, persisted: $PERSISTED"
  if [ "$PERSISTED" = "1" ]; then
    ok "the Settings toggle persists the fullscreen preference"
  else
    bad "the Settings toggle persists the fullscreen preference" "persisted: $PERSISTED"
  fi
else
  bad "the Settings toggle persists the fullscreen preference" "no toggle in Settings"
fi
# Close the pane before measuring the launch it configured.
act
/tmp/focusprobe "$BUNDLE_ID" key 13 1 - cmd >/dev/null 2>&1
sleep 1
stop_app || { echo "FATAL: the shell would not quit"; exit 1; }
EXTRA_ARGS=""
launch "$SEED_DIR" keep
FULL=$(wait_window true 30)
note "at launch, setting on: ${FULL:-no window}"
case "$FULL" in
  *fullscreen=true*) ok "the fullscreen setting opens into its own Space" ;;
  *) bad "the fullscreen setting opens into its own Space" "at launch: ${FULL:-no window}" ;;
esac

# The flag beats the setting: a test launch keeps the screen even when
# the user asked for fullscreen — the suite itself depends on that.
stop_app || { echo "FATAL: the shell would not quit"; exit 1; }
EXTRA_ARGS="--windowed"
launch "$SEED_DIR" keep
FULL=$(wait_window false 30)
note "at launch, setting on + --windowed: ${FULL:-no window}"
case "$FULL" in
  *fullscreen=false*) ok "--windowed overrides the fullscreen setting" ;;
  *) bad "--windowed overrides the fullscreen setting" "at launch: ${FULL:-no window}" ;;
esac
# Leave the test domain the way a default install finds it.
defaults delete "$BUNDLE_ID" openInFullScreen 2>/dev/null

# The windowed decision's correction also has to still be listening after
# the window is visible: a restoration record's Space migration can land
# a beat after the window ordered in (#252). `--probe-enter-fullscreen`
# makes the app drive its own `toggleFullScreen` once the window is
# visible — a real entry with no input event in flight, which is exactly
# how the system's replay arrives. A user press comes later, through the
# View menu in section 15, and must still be honoured.
stop_app || { echo "FATAL: the shell would not quit"; exit 1; }
EXTRA_ARGS="--windowed --probe-enter-fullscreen"
launch "$SEED_DIR" keep
# A windowed sample proves nothing on its own: the launch begins
# windowed, so a poll can pass before the probe has even run. The proof
# is ordered — the app's own trace records the entry being driven and
# the correction seeing it land (fullScreen=true), and only then does a
# windowed AX state mean the entry was undone rather than never taken.
if wait_trace "launch-mode: probe enters fullscreen" 10 \
   && wait_trace "fullscreen entry.*fullScreen=true" 10; then
  FULL=$(wait_window false 15)
  note "probe entry observed; state after correction: ${FULL:-no window}"
  case "$FULL" in
    *fullscreen=false*) ok "a launch-time fullscreen entry with no input is undone" ;;
    *) bad "a launch-time fullscreen entry with no input is undone" "entered but stayed: ${FULL:-no window}" ;;
  esac
else
  bad "a launch-time fullscreen entry with no input is undone" \
      "the entry never landed in the trace — there was nothing to undo"
fi

echo
echo "== 15. fullscreen is a trip the user controls =="
# The user's trip is proven on a fresh launch — one that never carried
# the probe flag, so neither a lingering probe nor a leftover Space can
# satisfy the check. Verify the relaunched window is windowed before
# pressing anything: a window that is already in a Space would turn
# "Enter Full Screen" into a no-op the probe cannot tell from a pass.
stop_app || { echo "FATAL: the shell would not quit"; exit 1; }
EXTRA_ARGS="--windowed"
launch "$SEED_DIR" keep
FULL=$(wait_window false 15)
note "fresh launch for the user's trip: ${FULL:-no window}"
case "$FULL" in
  *fullscreen=false*)
    # Entering and leaving a Space stays available the whole time —
    # these are the AppKit menu items, not shell commands.
    act
    /tmp/focusprobe "$BUNDLE_ID" press View "Enter Full Screen" >/dev/null 2>&1
    FULL=$(wait_window true 15)
    note "after Enter Full Screen: ${FULL:-no window}"
    case "$FULL" in
      *fullscreen=true*) ok "the user can enter fullscreen" ;;
      *) bad "the user can enter fullscreen" "after Enter Full Screen: ${FULL:-no window}" ;;
    esac
    act
    /tmp/focusprobe "$BUNDLE_ID" press View "Exit Full Screen" >/dev/null 2>&1
    FULL=$(wait_window false 15)
    note "after Exit Full Screen: ${FULL:-no window}"
    case "$FULL" in
      *fullscreen=false*) ok "the user can bring the window back" ;;
      *) bad "the user can bring the window back" "after Exit Full Screen: ${FULL:-no window}" ;;
    esac
    ;;
  *)
    bad "the user can enter fullscreen" "fresh launch not windowed: ${FULL:-no window}"
    bad "the user can bring the window back" "skipped — the launch was not windowed"
    ;;
esac

echo
echo "== 16. the window remembers its frame =="
# The scene's own restoration is the mechanism — the shell deliberately
# does not set a frame autosave name, because a saved frame applied
# through the representable's update path would loop resize → update →
# resize. What is asserted here is the user's experience: move the window,
# relaunch, and it comes back where it was left.
# A mid-screen frame: macOS adjusts restored frames that sit close to a
# display edge, so an edge-hugging rectangle would come back nudged and
# read as a failure the user would never see. The rectangle is derived
# from the main screen's *visible* frame — a hardcoded 500,200,900,620
# falls off smaller displays — with a fixed inset keeping it clear of
# every edge, and dimensions clamped so it still fits the smallest
# supported screen.
# The horizontal margin needs more room than the vertical one: AppKit
# nudges a restored frame that sits closer to a screen edge than its own
# interior margin — ≈206pt from the left on a 1728-wide display — and the
# shifted frame reads as forgotten under the strict comparison (#256).
# The margin scales with the visible width so the rectangle stays
# interior on small screens, with a floor past the observed nudge point.
# kAXPosition is top-left-origin while NSScreen frames are bottom-left —
# on the main screen the conversion is axY = screenHeight - (vy + vh).
read SH VX VY VW VH <<EOF
$(osascript -l JavaScript -e 'ObjC.import("AppKit"); var s=ObjC.unwrap($.NSScreen.mainScreen.frame); var f=ObjC.unwrap($.NSScreen.mainScreen.visibleFrame); s.size.height+","+f.origin.x+","+f.origin.y+","+f.size.width+","+f.size.height' | tr ',' ' ')
EOF
AXVY=$(( SH - VY - VH ))
INSET=48
XMARGIN=$(( VW / 8 )); [ "$XMARGIN" -lt 240 ] && XMARGIN=240
TW=$(( VW - 2 * XMARGIN )); [ "$TW" -gt 900 ] && TW=900
TH=$(( VH - 2 * INSET )); [ "$TH" -gt 620 ] && TH=620
TX=$(( VX + XMARGIN ))
TY=$(( AXVY + INSET ))
SET_RESULT=$(/tmp/focusprobe "$BUNDLE_ID" setbounds "$TX" "$TY" "$TW" "$TH" 2>/dev/null)
note "setbounds: ${SET_RESULT:-none} (target ${TX},${TY} ${TW}x${TH} of visible ${VW}x${VH})"
sleep 1
SET=$(/tmp/focusprobe "$BUNDLE_ID" bounds 2>/dev/null)
note "frame set to: ${SET:-none}"
read SX SY SW SH <<EOF
$(echo "$SET" | sed -n 's/bounds=\([0-9-]*\),\([0-9-]*\) \([0-9]*\)x\([0-9]*\)/\1 \2 \3 \4/p')
EOF
# The assertion only means something if the window actually moved: a
# failed resize read back twice passes as "restored" on the default frame.
MOVED=yes
for pair in "${SX:-9999} $TX" "${SY:-9999} $TY" "${SW:-0} $TW" "${SH:-0} $TH"; do
  set -- $pair
  diff=$(( $1 - $2 ))
  [ $diff -lt 0 ] && diff=$(( -diff ))
  [ $diff -gt 8 ] && MOVED=no
done
if [ "$MOVED" != yes ]; then
  bad "the window's frame survives a relaunch" \
      "window never took the nondefault frame (setbounds: ${SET_RESULT:-none}, got ${SET:-none})"
else
  # Persistence lives in the quit: the scene's frame autosave flushes on
  # a graceful exit, so ending this run with a kill would test nothing.
  quit_app || { echo "FATAL: the shell would not quit"; exit 1; }
  EXTRA_ARGS="--windowed"
  launch "$SEED_DIR" keep
  sleep 2
  BACK=$(/tmp/focusprobe "$BUNDLE_ID" bounds 2>/dev/null)
  note "frame after relaunch: ${BACK:-none}"
  read BX BY BW BH <<EOF
$(echo "$BACK" | sed -n 's/bounds=\([0-9-]*\),\([0-9-]*\) \([0-9]*\)x\([0-9]*\)/\1 \2 \3 \4/p')
EOF
  RESTORED=no
  if [ -n "${SX:-}" ] && [ -n "${BX:-}" ]; then
    # A few points of slack is honest — display bookkeeping can nudge the
    # rectangle — but a default-size window means the frame was forgotten.
    RESTORED=yes
    for pair in "$SX $BX" "$SY $BY" "$SW $BW" "$SH $BH"; do
      set -- $pair
      diff=$(( $1 - $2 ))
      [ $diff -lt 0 ] && diff=$(( -diff ))
      [ $diff -gt 8 ] && RESTORED=no
    done
  fi
  if [ "$RESTORED" = yes ]; then
    ok "the window's frame survives a relaunch"
  else
    bad "the window's frame survives a relaunch" "set ${SET:-none}, got ${BACK:-none}"
  fi
fi

echo
echo "== 17. Settings is a real window =="
# The Settings scene is the app's own — the system menu item under the
# app menu opens it, it arrives as a second window, and it closes without
# taking the Library with it.
act
/tmp/focusprobe "$BUNDLE_ID" press manorama "Settings" >/dev/null 2>&1 \
  || /tmp/focusprobe "$BUNDLE_ID" key 43 1 - cmd >/dev/null 2>&1
sleep 2
WINS=$(/tmp/focusprobe "$BUNDLE_ID" wincount 2>/dev/null)
note "after opening Settings: $(echo "$WINS" | tr '\n' ' ' | cut -c1-200)"
# Counts alone cannot say WHICH windows these are: the pair must be a
# pane without the web surface beside the window that still carries it.
if echo "$WINS" | grep -q "^windows=2" \
   && [ "$(echo "$WINS" | grep -c "\[web\]")" = "1" ]; then
  ok "Settings opens as its own window beside the Library"
else
  bad "Settings opens as its own window beside the Library" "$(echo "$WINS" | head -3 | tr '\n' ' ')"
fi
# ⌘W goes to the key window. The pane is key from opening, so it goes —
# and what must be left is the window with the web area, not just any one.
act
/tmp/focusprobe "$BUNDLE_ID" key 13 1 - cmd >/dev/null 2>&1
sleep 1.5
WINS=$(/tmp/focusprobe "$BUNDLE_ID" wincount 2>/dev/null)
note "after closing Settings: $(echo "$WINS" | tr '\n' ' ' | cut -c1-200)"
if echo "$WINS" | grep -q "^windows=1" && echo "$WINS" | grep -q "\[web\]"; then
  ok "Settings closes without taking the Library"
else
  bad "Settings closes without taking the Library" "$(echo "$WINS" | head -3 | tr '\n' ' ')"
fi

echo
echo "== 18. the Library reopens after its window closes =="
# Closing the last window does not quit the app — and a reopen (the Dock
# click a person would make) must bring the Library back, because a shell
# that cannot be reached after ⌘W is a shell you have to relaunch.
act
/tmp/focusprobe "$BUNDLE_ID" key 13 1 - cmd >/dev/null 2>&1
sleep 1.5
WINS=$(/tmp/focusprobe "$BUNDLE_ID" wincount 2>/dev/null)
note "after closing the Library: $(echo "$WINS" | tr '\n' ' ' | cut -c1-120)"
case "$WINS" in
  windows=0*) ok "the Library window closes without quitting the app" ;;
  *) bad "the Library window closes without quitting the app" "$(echo "$WINS" | head -3 | tr '\n' ' ')" ;;
esac
# The harder case: Settings is the only window left. It is not the app's
# content window, so a Dock reopen must still bring the Library back
# rather than ordering the pane forward and calling it done.
act
/tmp/focusprobe "$BUNDLE_ID" press manorama "Settings" >/dev/null 2>&1 \
  || /tmp/focusprobe "$BUNDLE_ID" key 43 1 - cmd >/dev/null 2>&1
sleep 2
osascript -e "tell application id \"$BUNDLE_ID\" to reopen" >/dev/null 2>&1
if wait_for_window 20; then
  # The window returning is only half of it — the page has to remount the
  # Library, and a one-shot read can land before the text does.
  REOPENED=""
  for _ in $(seq 1 15); do
    REOPENED=$(library_texts | head -4 | tr '\n' ' ')
    echo "$REOPENED" | grep -qi "Add Gallery\|$TITLE" && break
    sleep 1
  done
  WINS=$(/tmp/focusprobe "$BUNDLE_ID" wincount 2>/dev/null)
  note "after reopen: ${REOPENED:-no text}; $(echo "$WINS" | tr '\n' ' ' | cut -c1-120)"
  if echo "$WINS" | grep -q "\[web\]" \
     && echo "$REOPENED" | grep -qi "Add Gallery\|$TITLE"; then
    ok "reopening brings the Library back"
  else
    bad "reopening brings the Library back" "no [web] window/Library text (${REOPENED:-empty})"
  fi
else
  bad "reopening brings the Library back" "no window after reopen"
fi

echo
echo "== 19. the app survived =="
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
