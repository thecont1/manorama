#!/usr/bin/env bash
# Compile and run the shipped macOS boundary suite against this checkout.
#
# The programme under test is the app's own Swift — LocalSchemeHandler,
# NativeBridge, FolderStore, LocalGallery, OAuthLoopback — compiled from the
# pinned commit, not a re-implementation. It exercises the media resolver
# (traversal, symlink escape, prefix siblings, revoked grants), the URL
# capability scopes, the OAuth loopback, the invoke-reply contract and the
# deep-link bookkeeping.
#
# Safe to repeat: it writes only under $TMPDIR, touches no Keychain item of the
# running app, and opens no network connection beyond a loopback listener.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
app="$repo/macos/ManoramaMac"
out="${TMPDIR:-/tmp}/manorama-boundary-audit"
mkdir -p "$out"

swiftc -O \
  -framework AppKit -framework WebKit -framework Security \
  -o "$out/boundary" \
  "$app/LocalGallery.swift" \
  "$app/FolderStore.swift" \
  "$app/LocalSchemeHandler.swift" \
  "$app/Trace.swift" \
  "$app/OAuthLoopback.swift" \
  "$app/NativeBridge.swift" \
  "$app/InvokeReply.swift" \
  "$repo/macos/BoundaryTests/BoundaryTests.swift" \
  "$repo/macos/BoundaryTests/main.swift"

"$out/boundary"
