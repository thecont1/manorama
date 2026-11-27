#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
NDK="${ANDROID_NDK_HOME:-${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}/ndk/27.2.12479018}"
LIMIT=1572864

[[ -f "$APK" ]] || { printf 'Missing Android debug package: %s\n' "$APK" >&2; exit 1; }
READELF="$(find "$NDK/toolchains/llvm/prebuilt" -path '*/bin/llvm-readelf' -print -quit)"
[[ -n "$READELF" && -x "$READELF" ]] || { printf 'llvm-readelf is unavailable under %s\n' "$NDK" >&2; exit 1; }

count=0
while IFS= read -r entry; do
  [[ -n "$entry" ]] || continue
  count=$((count + 1))
  bytes="$(unzip -p "$APK" "$entry" | wc -c)"
  [[ "$bytes" -le "$LIMIT" ]] || { printf '%s is %s bytes; limit is %s\n' "$entry" "$bytes" "$LIMIT" >&2; exit 1; }
  symbols="$(unzip -p "$APK" "$entry" | "$READELF" --dyn-syms -)"
  for symbol in cluster decodeIndex encodeIndex; do
    export_name="Java_in_thecontrarian_manorama_events_RustBridge_${symbol}"
    [[ "$symbols" == *"$export_name"* ]] || { printf '%s lacks %s\n' "$entry" "$export_name" >&2; exit 1; }
  done
  printf '%s: %s bytes; three JNI exports present\n' "$entry" "$bytes"
done < <(unzip -Z1 "$APK" 'lib/*/libmanorama_events.so')

[[ "$count" -eq 2 ]] || { printf 'Expected two ABI libraries, found %s\n' "$count" >&2; exit 1; }
