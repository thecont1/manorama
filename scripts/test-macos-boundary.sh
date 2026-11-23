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

"$SWIFTC" -O \
  -sdk "$SDK_PATH" \
  -module-cache-path "$CLANG_MODULE_CACHE_PATH" \
  "$APP"/{LocalGallery,FolderStore,LocalSchemeHandler,Trace,OAuthLoopback,NativeBridge,InvokeReply,FolderDumpScanner,RawDumpEvents}.swift \
  "$CORE"/*.swift \
  "$ROOT/macos/BoundaryTests"/{BoundaryTests,main}.swift \
  -framework AppKit \
  -framework WebKit \
  -framework Security \
  -framework Vision \
  -framework CoreServices \
  -o "$SCRATCH/boundary"

"$SCRATCH/boundary"
