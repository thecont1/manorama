#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" || $# -lt 4 ]]; then
  echo "usage: scripts/verify-smart-events-corpus.sh <originals> <baseline-ref> <output-dir> <folder>..." >&2
  exit 2
fi

ORIGINALS="$1"
BASELINE_REF="$2"
OUT="$3"
shift 3
FOLDERS=("$@")
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/manorama-event-corpus.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

mkdir -p "$OUT" "$SCRATCH/baseline" "$SCRATCH/current"
git archive "$BASELINE_REF" native/EventClustering/Sources/ManoramaEventClustering \
  | tar -x -C "$SCRATCH/baseline"

SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
COMMON=(
  "$ROOT/macos/ManoramaMac/LocalGallery.swift"
  "$ROOT/macos/ManoramaMac/FolderDumpScanner.swift"
  "$ROOT/macos/ManoramaMac/RawDumpEvents.swift"
  "$ROOT/scripts/scan-event-corpus.swift"
  -framework ImageIO -framework Vision -framework CoreServices -framework Security
)

xcrun --sdk macosx swiftc -O -sdk "$SDK_PATH" "${COMMON[@]}" \
  "$SCRATCH/baseline/native/EventClustering/Sources/ManoramaEventClustering/"*.swift \
  -o "$SCRATCH/baseline/scan"
xcrun --sdk macosx swiftc -O -sdk "$SDK_PATH" "${COMMON[@]}" \
  "$ROOT/native/EventClustering/Sources/ManoramaEventClustering/"*.swift \
  -o "$SCRATCH/current/scan"

"$SCRATCH/baseline/scan" "$ORIGINALS" "$SCRATCH/baseline/cache" "${FOLDERS[@]}" > "$OUT/baseline.json"
"$SCRATCH/current/scan" "$ORIGINALS" "$SCRATCH/current/cache" "${FOLDERS[@]}" > "$OUT/final.json"
shasum -a 256 native/EventClustering/Sources/ManoramaEventClustering/*.swift > "$OUT/engine-sources.sha256"

python3 - "$OUT/baseline.json" "$OUT/final.json" "$OUT/summary.txt" "$BASELINE_REF" <<'PY'
import json
import sys
from datetime import datetime, timezone

baseline_path, final_path, summary_path, baseline_ref = sys.argv[1:]
baseline = json.load(open(baseline_path))
final = json.load(open(final_path))
assert baseline.keys() == final.keys(), "folder sets differ"
for folder in baseline:
    assert baseline[folder]["itemCount"] == final[folder]["itemCount"], f"item loss in {folder}"

lines = [
    f"generated_utc: {datetime.now(timezone.utc).isoformat()}",
    f"baseline_ref: {baseline_ref}",
    "scope: aggregate counts only; no folder names, filenames, paths, dates, coordinates, or image bytes",
    "",
    "folder | items | baseline events | final events | baseline multi-day | final multi-day",
    "--- | ---: | ---: | ---: | ---: | ---:",
]
for folder in baseline:
    b, f = baseline[folder], final[folder]
    lines.append(f"{folder} | {b['itemCount']} | {b['eventCount']} | {f['eventCount']} | {b['multiDayCount']} | {f['multiDayCount']}")
lines.extend([
    "",
    f"baseline_items: {sum(r['itemCount'] for r in baseline.values())}",
    f"final_items: {sum(r['itemCount'] for r in final.values())}",
    f"baseline_events: {sum(r['eventCount'] for r in baseline.values())}",
    f"final_events: {sum(r['eventCount'] for r in final.values())}",
    "item_accounting: PASS",
])
open(summary_path, "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
PY
