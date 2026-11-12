#!/usr/bin/env bash
# Build and run the macOS webview-boundary probe.
#
# It compiles the app's *own* Swift sources (LocalSchemeHandler, NativeBridge,
# FolderStore, ViewerWebView, InvokeReply, OAuthLoopback, LocalGallery, Trace)
# against a small driver, so the boundary under test is the shipped one. The
# only stand-ins are the page bundle (a one-anchor HTML file) and the "remote"
# origin (a loopback HTTP responder started by the driver).
#
# Safe: no network beyond 127.0.0.1, no Keychain writes, a throwaway config dir
# under $TMPDIR, no app bundle touched.
#
# Output lines to read:
#   STEP1  handler present on the bundled page
#   STEP1a the trusted document still gets a bridge reply
#   STEP2a target=_blank click — routed to the opener, webview stays bundled
#   STEP2b window.open — same question for the other external-link idiom
#   STEP2c location.assign — the in-place navigation attempt, also routed out
#   STEP3  a same-origin child frame's messages die at the main-frame gate
#   STEP4  an untrusted document's messages die at the origin gate
#   VERDICT BRIDGE-LEAKED-SESSION-TOKEN | BRIDGE-NOT-REACHABLE
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
repo="$(cd ../../.. && pwd)"
app="$repo/macos/ManoramaMac"
out="$(mktemp -d "${TMPDIR:-/tmp}/manorama-bridge-probe.XXXXXX")"

swiftc -target arm64-apple-macosx13.0 \
  -framework AppKit -framework WebKit -framework SwiftUI -framework Security \
  -o "$out/probe" \
  main.swift \
  "$app/LocalSchemeHandler.swift" \
  "$app/NativeBridge.swift" \
  "$app/FolderStore.swift" \
  "$app/ViewerWebView.swift" \
  "$app/InvokeReply.swift" \
  "$app/OAuthLoopback.swift" \
  "$app/LocalGallery.swift" \
  "$app/Trace.swift"

echo "built: $out/probe"
"$out/probe"
