#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RESULTS=()
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

record() {
  local status="$1" name="$2" detail="${3:-}"
  case "$status" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)); RESULTS+=("PASS | $name") ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)); RESULTS+=("FAIL | $name${detail:+ | $detail}") ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT + 1)); RESULTS+=("SKIPPED: $detail | $name") ;;
  esac
}

run_at() {
  local name="$1" directory="$2"
  shift 2
  printf '\n== %s ==\n' "$name"
  if (cd "$directory" && "$@"); then
    record PASS "$name"
  else
    local status=$?
    record FAIL "$name" "exit $status"
  fi
}

run() {
  run_at "$1" "$ROOT" "${@:2}"
}

skip() {
  record SKIP "$1" "$2"
  printf '\n== %s ==\nSKIPPED: %s\n' "$1" "$2"
}

lane_enabled() {
  local variable="MANORAMA_SKIP_$1"
  [[ "${!variable:-0}" != "1" ]]
}

has_bun() {
  command -v bun >/dev/null 2>&1 && [[ -d "$ROOT/node_modules" ]]
}

java21_home() {
  local candidate
  for candidate in \
    /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
    /usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    if [[ -x "$candidate/bin/java" ]] && [[ "$("$candidate/bin/java" -version 2>&1)" == *'version "21'* ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

printf 'manorama cross-surface verification\nrepository: %s\n' "$ROOT"

if lane_enabled TYPESCRIPT; then
  if ! command -v bun >/dev/null 2>&1; then
    skip 'TypeScript typecheck' 'bun is not installed'
  elif [[ ! -d "$ROOT/node_modules" ]]; then
    skip 'TypeScript typecheck' 'dependencies are not installed; run bun install'
  else
    run 'TypeScript typecheck' bunx tsc --noEmit
  fi
else
  skip 'TypeScript typecheck' 'disabled by MANORAMA_SKIP_TYPESCRIPT'
fi

if lane_enabled BUN; then
  if has_bun; then
    run 'Bun unit suite' bun run test:unit
  else
    skip 'Bun unit suite' 'bun or installed dependencies are missing'
  fi
else
  skip 'Bun unit suite' 'disabled by MANORAMA_SKIP_BUN'
fi

if lane_enabled RUST; then
  if command -v cargo >/dev/null 2>&1; then
    run 'Rust core default features' cargo test --locked -p event-clustering
    run 'Rust core fs-scan' cargo test --locked -p event-clustering --features fs-scan
    run 'Rust core android bridge' cargo test --locked -p event-clustering --features android
    run 'Rust core fs-scan and android bridge' cargo test --locked -p event-clustering --features fs-scan,android
    run 'Rust core Clippy' cargo clippy --locked -p event-clustering --all-targets --features fs-scan,android -- -D warnings
  else
    skip 'Rust core feature matrix' 'cargo is not installed'
    skip 'Rust core Clippy' 'cargo is not installed'
  fi
else
  skip 'Rust core feature matrix' 'disabled by MANORAMA_SKIP_RUST'
  skip 'Rust core Clippy' 'disabled by MANORAMA_SKIP_RUST'
fi

if lane_enabled SWIFT; then
  if [[ "$(uname -s)" != Darwin ]]; then
    skip 'Swift event engine' 'requires macOS with Xcode'
    skip 'macOS native boundary' 'requires macOS with Xcode'
  elif ! command -v xcrun >/dev/null 2>&1 || ! xcode-select -p >/dev/null 2>&1; then
    skip 'Swift event engine' 'a selected Xcode toolchain is unavailable'
    skip 'macOS native boundary' 'a selected Xcode toolchain is unavailable'
  else
    run 'Swift event engine' bash scripts/test-event-clustering.sh
    run 'macOS native boundary' bash scripts/test-macos-boundary.sh
  fi
else
  skip 'Swift event engine' 'disabled by MANORAMA_SKIP_SWIFT'
  skip 'macOS native boundary' 'disabled by MANORAMA_SKIP_SWIFT'
fi

if lane_enabled TAURI; then
  if ! command -v cargo >/dev/null 2>&1; then
    skip 'Tauri desktop bundle' 'cargo is not installed'
    skip 'Tauri shell tests' 'cargo is not installed'
    skip 'Tauri shell Clippy' 'cargo is not installed'
  elif ! has_bun; then
    skip 'Tauri desktop bundle' 'bun or installed dependencies are missing'
    skip 'Tauri shell tests' 'desktop bundle prerequisites are missing'
    skip 'Tauri shell Clippy' 'cargo or Bun prerequisites are missing'
  elif [[ "$(uname -s)" == Linux ]] && ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    skip 'Tauri desktop bundle' 'Linux WebKitGTK development dependencies are unavailable'
    skip 'Tauri shell tests' 'Linux WebKitGTK development dependencies are unavailable'
    skip 'Tauri shell Clippy' 'Linux WebKitGTK development dependencies are unavailable'
  else
    run 'Tauri desktop bundle' bun run build:desktop --configLoader runner
    run 'Tauri shell tests' cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets
    run 'Tauri shell Clippy' cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
  fi
else
  skip 'Tauri desktop bundle' 'disabled by MANORAMA_SKIP_TAURI'
  skip 'Tauri shell tests' 'disabled by MANORAMA_SKIP_TAURI'
  skip 'Tauri shell Clippy' 'disabled by MANORAMA_SKIP_TAURI'
fi

if lane_enabled PLAYWRIGHT; then
  if ! has_bun; then
    skip 'Desktop Camera Roll Playwright' 'bun or installed dependencies are missing'
  elif ! command -v curl >/dev/null 2>&1; then
    skip 'Desktop Camera Roll Playwright' 'curl is unavailable for server readiness checks'
  elif [[ -n "${DESKTOP_URL:-}" ]]; then
    run 'Desktop Camera Roll Playwright' env DESKTOP_URL="$DESKTOP_URL" \
      bunx playwright test specs/desktop-events.playwright.ts --reporter=line
  else
    desktop_port="$(node -e 'const server = require("node:net").createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); })')"
    desktop_log="$(mktemp "${TMPDIR:-/tmp}/manorama-desktop-events.XXXXXX")"
    if (
      set -uo pipefail
      bunx vite --config vite.config.desktop.ts --host 127.0.0.1 --port "$desktop_port" --strictPort >"$desktop_log" 2>&1 &
      desktop_pid=$!
      trap 'kill "$desktop_pid" 2>/dev/null || true; wait "$desktop_pid" 2>/dev/null || true; rm -f "$desktop_log"' EXIT
      desktop_ready=0
      for _ in {1..100}; do
        if curl --max-time 1 -fsS "http://127.0.0.1:$desktop_port" >/dev/null 2>&1; then
          desktop_ready=1
          break
        fi
        if ! kill -0 "$desktop_pid" 2>/dev/null; then break; fi
        sleep 0.1
      done
      if [[ "$desktop_ready" != 1 ]]; then
        printf 'Desktop Vite did not become ready.\n' >&2
        sed -n '1,160p' "$desktop_log" >&2
        exit 1
      fi
      DESKTOP_URL="http://127.0.0.1:$desktop_port" \
        bunx playwright test specs/desktop-events.playwright.ts --reporter=line
    ); then
      record PASS 'Desktop Camera Roll Playwright'
    else
      desktop_status=$?
      record FAIL 'Desktop Camera Roll Playwright' "exit $desktop_status"
    fi
    rm -f "$desktop_log"
  fi
else
  skip 'Desktop Camera Roll Playwright' 'disabled by MANORAMA_SKIP_PLAYWRIGHT'
fi

if lane_enabled IOS; then
  if [[ "$(uname -s)" != Darwin ]]; then
    skip 'iOS seeded simulator tests' 'requires macOS with Xcode'
  elif [[ -z "${MANORAMA_IOS_SIMULATOR_ID:-}" ]]; then
    skip 'iOS seeded simulator tests' 'set MANORAMA_IOS_SIMULATOR_ID to an installed simulator UDID'
  elif ! has_bun || ! command -v xcodebuild >/dev/null 2>&1; then
    skip 'iOS seeded simulator tests' 'Bun dependencies or Xcode are unavailable'
  else
    ios_derived="$(mktemp -d "${TMPDIR:-/tmp}/manorama-events-ios.XXXXXX")"
    (
      set -euo pipefail
      export DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p)}"
      export EVENT_FIXTURE_PREFIX="event-demo-$(date +%s)-$$-"
      bun run build:native --configLoader runner
      bunx cap copy ios
      xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
        -destination "platform=iOS Simulator,id=$MANORAMA_IOS_SIMULATOR_ID" \
        -derivedDataPath "$ios_derived/DerivedData" \
        -clonedSourcePackagesDirPath "$ios_derived/SourcePackages" build-for-testing
      ios_app="$ios_derived/DerivedData/Build/Products/Debug-iphonesimulator/App.app"
      /usr/bin/codesign --verify --deep --strict "$ios_app"
      xcrun simctl bootstatus "$MANORAMA_IOS_SIMULATOR_ID" -b
      xcrun simctl install "$MANORAMA_IOS_SIMULATOR_ID" "$ios_app"
      app_data="$(xcrun simctl get_app_container "$MANORAMA_IOS_SIMULATOR_ID" in.thecontrarian.manorama data)"
      mkdir -p "$app_data/Documents"
      printf '%s\n' "$EVENT_FIXTURE_PREFIX" > "$app_data/Documents/event-fixture-prefix.txt"
      # A fresh simulator install has no TCC client until its first launch, and
      # the injected XCTest bundle has its own Photos client identity.
      xcrun simctl launch "$MANORAMA_IOS_SIMULATOR_ID" in.thecontrarian.manorama >/dev/null
      xcrun simctl terminate "$MANORAMA_IOS_SIMULATOR_ID" in.thecontrarian.manorama >/dev/null
      xcrun simctl privacy "$MANORAMA_IOS_SIMULATOR_ID" grant photos in.thecontrarian.manorama
      xcrun simctl privacy "$MANORAMA_IOS_SIMULATOR_ID" grant photos in.thecontrarian.manorama.EventAssetImagesTests
      EVENT_FIXTURE="$ios_derived/event-synthetic.png" bun -e 'import sharp from "sharp"; await sharp({create:{width:1024,height:768,channels:3,background:"#da1680"}}).png().toFile(process.env.EVENT_FIXTURE)'
      xcrun simctl addmedia "$MANORAMA_IOS_SIMULATOR_ID" "$ios_derived/event-synthetic.png"
      xcrun swiftc "$ROOT/scripts/seed-ios-event-photos.swift" -o "$ios_derived/event-seed"
      "$ios_derived/event-seed" "$ios_derived/event-photos" "$EVENT_FIXTURE_PREFIX"
      xcrun simctl addmedia "$MANORAMA_IOS_SIMULATOR_ID" "$ios_derived/event-photos/"*.jpg
      xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
        -destination "platform=iOS Simulator,id=$MANORAMA_IOS_SIMULATOR_ID" \
        -derivedDataPath "$ios_derived/DerivedData" \
        -clonedSourcePackagesDirPath "$ios_derived/SourcePackages" \
        -resultBundlePath "$ios_derived/tests.xcresult" \
        -parallel-testing-enabled NO test-without-building
    ) &
    ios_pid=$!
    if wait "$ios_pid"; then
      record PASS 'iOS seeded simulator tests'
    else
      ios_status=$?
      record FAIL 'iOS seeded simulator tests' "simulator $MANORAMA_IOS_SIMULATOR_ID; exit $ios_status"
    fi
    xcrun simctl terminate "$MANORAMA_IOS_SIMULATOR_ID" in.thecontrarian.manorama >/dev/null 2>&1 || true
    rm -rf "$ios_derived"
  fi
else
  skip 'iOS seeded simulator tests' 'disabled by MANORAMA_SKIP_IOS'
fi

ANDROID_SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
ANDROID_ADB="$ANDROID_SDK/platform-tools/adb"
ANDROID_NDK="${ANDROID_NDK_HOME:-$ANDROID_SDK/ndk/27.2.12479018}"
export ANDROID_HOME="$ANDROID_SDK"
export ANDROID_NDK_HOME="$ANDROID_NDK"

if lane_enabled ANDROID; then
  java_home="$(java21_home || true)"
  if [[ -z "$java_home" ]]; then
    skip 'Android JVM and debug package' 'Java 21 is not installed'
    skip 'Android packaged JNI libraries' 'Java 21 is not installed'
  elif ! command -v cargo-ndk >/dev/null 2>&1; then
    skip 'Android JVM and debug package' 'cargo-ndk is not installed'
    skip 'Android packaged JNI libraries' 'cargo-ndk is not installed'
  elif [[ ! -x "$ANDROID_ADB" || ! -d "$ANDROID_SDK/platforms/android-36" || ! -d "$ANDROID_NDK" ]]; then
    skip 'Android JVM and debug package' 'Android SDK 36 or NDK 27.2.12479018 is not configured'
    skip 'Android packaged JNI libraries' 'Android SDK 36 or NDK 27.2.12479018 is not configured'
  else
    export JAVA_HOME="$java_home"
    export PATH="$JAVA_HOME/bin:$PATH"
    run_at 'Android JVM and debug package' "$ROOT/android" ./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebug
    run 'Android packaged JNI libraries' bash scripts/test-android-libraries.sh
  fi

  android_serial="${MANORAMA_ANDROID_SERIAL:-}"
  if [[ -z "$android_serial" && -x "$ANDROID_ADB" ]]; then
    while IFS= read -r line; do
      if [[ "$line" == emulator-*$'\tdevice' ]]; then
        android_serial="${line%%$'\t'*}"
        break
      fi
    done < <("$ANDROID_ADB" devices 2>/dev/null)
  fi
  if [[ -z "$android_serial" ]]; then
    skip 'Android emulator instrumentation' 'no emulator is connected; set MANORAMA_ANDROID_SERIAL to opt in'
  elif [[ -z "$java_home" || ! -x "$ANDROID_ADB" || ! -d "$ANDROID_NDK" ]] || ! command -v cargo-ndk >/dev/null 2>&1; then
    skip 'Android emulator instrumentation' 'Java 21, Android SDK, NDK or cargo-ndk is unavailable'
  else
    export JAVA_HOME="$java_home"
    export PATH="$JAVA_HOME/bin:$PATH"
    run_at 'Android emulator instrumentation' "$ROOT/android" env ANDROID_SERIAL="$android_serial" ./gradlew --no-daemon :app:connectedDebugAndroidTest
  fi
else
  skip 'Android JVM and debug package' 'disabled by MANORAMA_SKIP_ANDROID'
  skip 'Android packaged JNI libraries' 'disabled by MANORAMA_SKIP_ANDROID'
  skip 'Android emulator instrumentation' 'disabled by MANORAMA_SKIP_ANDROID'
fi

if lane_enabled LINUX; then
  if [[ "${MANORAMA_LINUX_DOCKER:-0}" != 1 ]]; then
    skip 'Linux Rust event core' 'set MANORAMA_LINUX_DOCKER=1 to run the cached rust:1 Docker image'
  elif ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    skip 'Linux Rust event core' 'Docker is unavailable or not running'
  elif ! docker image inspect rust:1 >/dev/null 2>&1; then
    skip 'Linux Rust event core' 'the rust:1 Docker image is not cached; pull it explicitly before opting in'
  else
    run 'Linux Rust event core' docker run --rm -e CARGO_TARGET_DIR=/tmp/manorama-events-linux-target -v "$ROOT:/workspace" -w /workspace rust:1 cargo test --locked -p event-clustering --all-features
  fi
else
  skip 'Linux Rust event core' 'disabled by MANORAMA_SKIP_LINUX'
fi

if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  if lane_enabled WINDOWS && command -v cargo >/dev/null 2>&1; then
    run 'Windows Tauri shell tests' cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets
  else
    skip 'Windows Tauri shell tests' 'cargo is unavailable or the lane is disabled'
  fi
else
  skip 'Windows Tauri shell tests' 'requires a Windows runner'
fi

printf '\n== Summary ==\n'
for result in "${RESULTS[@]}"; do
  printf '%s\n' "$result"
done
printf '\n%d passed, %d failed, %d skipped\n' "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"
[[ "$FAIL_COUNT" -eq 0 ]]
