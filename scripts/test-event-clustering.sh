#!/usr/bin/env bash
#
# Event-clustering core tests.
#
# The engine is pure Foundation Swift, so its suite needs no app bundle, no
# simulator, no signing identity and no photographs: `swift test` on the
# package under native/EventClustering is the whole thing. It is separate
# from `bun run test:unit` because it is a Swift toolchain run, and separate
# from the macOS boundary suite because that one needs the shell's own
# sources and a filesystem.
#
# Scratch and module caches go under /tmp by default. On a machine where the
# toolchain cannot write its own caches (a sandboxed CI runner, a locked-down
# login), the build fails with an "Operation not permitted" on a
# ModuleCache path — those two variables are the escape hatch, and
# --disable-sandbox is SwiftPM's own sandbox, which nests badly inside
# anything else.
#
# Usage: scripts/test-event-clustering.sh [swift test arguments…]

set -euo pipefail

cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p)}"

PACKAGE="native/EventClustering"
SCRATCH="${MANORAMA_SWIFT_SCRATCH:-/tmp/manus-event-clustering-build}"
MODULE_CACHE="${MANORAMA_SWIFT_MODULE_CACHE:-/tmp/manus-event-clustering-modules}"
mkdir -p "$SCRATCH" "$MODULE_CACHE"
export CLANG_MODULE_CACHE_PATH="$MODULE_CACHE"

exec swift test --package-path "$PACKAGE" \
  --disable-sandbox \
  --scratch-path "$SCRATCH" \
  "$@"
