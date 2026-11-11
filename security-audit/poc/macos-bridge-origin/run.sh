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
#   STEP2a target=_blank click — does WebKit navigate the app's webview?
#   STEP2b window.open — same question for the other external-link idiom
#   STEP2  the navigation that did happen
#   STEP3  what the remote page managed to do
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
