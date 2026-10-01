#!/usr/bin/env bash
#
# Prepare the three App Store signing secrets the iOS release workflow needs.
#
#   IOS_DIST_CERTIFICATE_BASE64      the Apple Distribution identity as a .p12
#   IOS_DIST_CERTIFICATE_PASSWORD    that .p12's export password
#   IOS_PROVISIONING_PROFILE_BASE64  the App Store provisioning profile
#
# Why these exist at all: `xcodebuild -allowProvisioningUpdates` can create a
# *development* profile on a CI runner, and `-exportArchive` then fails with
#
#     error: exportArchive No signing certificate "iOS Distribution" found
#
# A development profile cannot produce an App Store package. Supplying the
# distribution identity and the App Store profile lets the workflow sign
# manually and upload without depending on cloud signing.
#
# Usage:
#   bash scripts/prepare-ios-signing-cert.sh [output-directory]
#
# The script never prints key material to a screen that is being logged; it
# writes files, then prints only the `gh secret set` commands to run.

set -euo pipefail

REPO_SLUG="${REPO_SLUG:-thecont1/manorama}"
BUNDLE_ID="${BUNDLE_ID:-in.thecontrarian.manorama}"
TEAM_ID="${TEAM_ID:-373K7W3LKU}"
OUT_DIR="${1:-$HOME/DEV/manorama-secrets}"

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

P12="$OUT_DIR/ios-distribution.p12"
P12_PASSWORD_FILE="$OUT_DIR/ios-p12-password.txt"
PROFILE_OUT="$OUT_DIR/manorama-appstore.mobileprovision"

# 1. The Apple Distribution identity, with its private key.
if ! security find-identity -v -p codesigning | grep -q "Apple Distribution"; then
  echo "error: no \"Apple Distribution\" identity in the login keychain." >&2
  echo "       Open Xcode -> Settings -> Accounts -> Manage Certificates and add one," >&2
  echo "       or download it from developer.apple.com and double-click the .cer." >&2
  exit 1
fi

PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
printf '%s' "$PASSWORD" > "$P12_PASSWORD_FILE"
chmod 600 "$P12_PASSWORD_FILE"

# `security export -t identities` exports every identity that has a key, so the
# .p12 also carries the development and Developer ID identities. That is
# harmless: the workflow signs explicitly with "Apple Distribution".
security export \
  -t identities \
  -f pkcs12 \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  -P "$PASSWORD" \
  -o "$P12" >/dev/null

# 2. The App Store provisioning profile for this bundle id. Xcode keeps them in
#    two places depending on age, so both are searched; a distribution profile
#    is recognised by get-task-allow being false.
PROFILE_SOURCES=(
  "$HOME/Library/MobileDevice/Provisioning Profiles"
  "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
)

found_profile=""
for dir in "${PROFILE_SOURCES[@]}"; do
  [ -d "$dir" ] || continue
  for file in "$dir"/*.mobileprovision; do
    [ -e "$file" ] || continue
    decoded="$(openssl smime -inform der -verify -noverify -in "$file" -out - 2>/dev/null || true)"
    [ -n "$decoded" ] || continue
    app_id="$(printf '%s' "$decoded" | plutil -extract Entitlements.application-identifier raw - 2>/dev/null || true)"
    task_allow="$(printf '%s' "$decoded" | plutil -extract Entitlements.get-task-allow raw - 2>/dev/null || true)"
    name="$(printf '%s' "$decoded" | plutil -extract Name raw - 2>/dev/null || true)"
    [ "$app_id" = "$TEAM_ID.$BUNDLE_ID" ] || continue
    [ "$task_allow" = "false" ] || continue
    found_profile="$file"
    profile_name="$name"
    break 2
  done
done

if [ -z "$found_profile" ]; then
  echo "error: no App Store provisioning profile for $TEAM_ID.$BUNDLE_ID." >&2
  echo "       Create one at developer.apple.com -> Certificates, Identifiers & Profiles" >&2
  echo "       -> Profiles -> Distribution -> App Store, then download and double-click it." >&2
  exit 1
fi

cp "$found_profile" "$PROFILE_OUT"
chmod 600 "$PROFILE_OUT"

echo "certificate: $P12"
echo "password:    $P12_PASSWORD_FILE"
echo "profile:     $PROFILE_OUT"
echo "profile name: $profile_name"
echo
echo "Upload them with:"
echo "  gh secret set IOS_DIST_CERTIFICATE_BASE64 --repo $REPO_SLUG < <(base64 -i \"$P12\" | tr -d '\\n')"
echo "  gh secret set IOS_DIST_CERTIFICATE_PASSWORD --repo $REPO_SLUG < \"$P12_PASSWORD_FILE\""
echo "  gh secret set IOS_PROVISIONING_PROFILE_BASE64 --repo $REPO_SLUG < <(base64 -i \"$PROFILE_OUT\" | tr -d '\\n')"
echo
echo "The workflow signs with this exact name, so keep it in step with"
echo ".github/workflows/ios.yml (env.PROFILE_NAME) and ios/ExportOptions.plist."