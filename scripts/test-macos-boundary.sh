#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/manorama-macos-boundary.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p)}"
export CLANG_MODULE_CACHE_PATH="$SCRATCH/modules"
# Keep fixture files inside this run's scratch even when a check exits early.
export TMPDIR="$SCRATCH/"
mkdir -p "$CLANG_MODULE_CACHE_PATH"

APP="$ROOT/macos/ManoramaMac"
CORE="$ROOT/native/EventClustering/Sources/ManoramaEventClustering"
SWIFTC="$(xcrun --sdk macosx --find swiftc)"
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"

SWIFT_SOURCES=(
  "$APP"/{LocalGallery,FolderStore,LocalSchemeHandler,Trace,OAuthLoopback,AppleSignIn,NativeBridge,InvokeReply,FolderDumpScanner,RawDumpEvents}.swift
  "$CORE"/*.swift
)

for suite in BoundaryTests ManoramaMacTests; do
  if [[ "$suite" == ManoramaMacTests ]]; then
    SWIFT_SOURCES+=("$APP"/{AppModel,ViewerWebView}.swift)
  fi
  "$SWIFTC" -O \
    -sdk "$SDK_PATH" \
    -module-cache-path "$CLANG_MODULE_CACHE_PATH" \
    "${SWIFT_SOURCES[@]}" \
    "$ROOT/macos/$suite"/*.swift \
    -framework AppKit \
    -framework WebKit \
    -framework Security \
    -framework Vision \
    -framework CoreServices \
    -o "$SCRATCH/$suite"

  "$SCRATCH/$suite"
done

# Slice 6's budget is part of the normal macOS boundary lane, not a silent
# opt-in. It is a separate invocation of the same optimized binary and the
# same production sources, so the other suites' WebKit/process allocations
# cannot contaminate the kernel-reported peak RSS.
printf '\n== macOS event index 50,000-item performance ==\n'
"$SCRATCH/BoundaryTests" --event-index-performance-50k
