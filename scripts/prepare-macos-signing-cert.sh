#!/usr/bin/env bash
#
# Turn a Developer ID Application certificate into the two repository secrets
# the desktop release needs.
#
# Why this exists: macOS's `security import` refuses a .p12 written by OpenSSL
# 3 with its default encryption, and reports it as
#
#     SecKeychainItemImport: MAC verification failed during PKCS12 import
#     (wrong password?)
#
# which reads like a wrong password but is usually an encoding mismatch. This
# re-exports the same identity using the legacy algorithms macOS accepts, then
# prints the values to paste into GitHub.
#
# Usage:
#   scripts/prepare-macos-signing-cert.sh ~/certificates/developer-id.p12
#
# Nothing is uploaded and the input file is never modified; the working copy
# lives in a temporary directory that is removed on exit.

set -euo pipefail

P12="${1:-}"
if [ -z "$P12" ] || [ ! -f "$P12" ]; then
  echo "usage: $(basename "$0") <certificate.p12>" >&2
  exit 2
fi

if ! command -v openssl >/dev/null 2>&1 || ! command -v base64 >/dev/null 2>&1; then
  echo "openssl and base64 are required" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Reading $P12"
echo -n "Password for the certificate: "
read -rs PASSWORD
echo

# Step 1 — prove the password opens the file at all.
if ! openssl pkcs12 -in "$P12" -passin "pass:$PASSWORD" -nokeys -nomacver \
      -out "$WORK/chain.pem" 2>"$WORK/read.err"; then
  echo "Could not read the certificate with that password:" >&2
  cat "$WORK/read.err" >&2
  exit 1
fi

if ! openssl pkcs12 -in "$P12" -passin "pass:$PASSWORD" -nocerts -nodes \
      -out "$WORK/key.pem" 2>/dev/null; then
  echo "The file has no private key. Export the certificate with its key from" >&2
  echo "Keychain Access (select both entries, then File > Export Items)." >&2
  exit 1
fi

echo
echo "Identity found:"
openssl pkcs12 -in "$P12" -passin "pass:$PASSWORD" -nokeys -nomacver 2>/dev/null \
  | openssl x509 -noout -subject -enddate 2>/dev/null | sed 's/^/  /' || true
echo

# Step 2 — choose the password the secret will carry, so the two values are
# produced together and cannot drift apart.
SECRET_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
if ! openssl pkcs12 -export \
      -legacy \
      -macalg sha1 \
      -keypbe PBE-SHA1-3DES \
      -certpbe PBE-SHA1-3DES \
      -out "$WORK/signing.p12" \
      -inkey "$WORK/key.pem" \
      -in "$WORK/chain.pem" \
      -passout "pass:$SECRET_PASSWORD" 2>"$WORK/export.err"; then
  echo "Re-export failed:" >&2
  cat "$WORK/export.err" >&2
  exit 1
fi

# Step 3 — verify the re-export before it is handed over, so the values that
# get pasted into GitHub are known good.
if ! openssl pkcs12 -in "$WORK/signing.p12" -passin "pass:$SECRET_PASSWORD" \
      -nokeys -nomacver -out /dev/null 2>"$WORK/verify.err"; then
  echo "The re-export did not verify:" >&2
  cat "$WORK/verify.err" >&2
  exit 1
fi

echo "Re-exported with legacy encryption — macOS will accept this one."
echo
echo "Copy each value below into GitHub: Settings -> Secrets and variables ->"
echo "Actions -> New repository secret."
echo
echo "APPLE_CERTIFICATE_PASSWORD"
echo "----------------------------------------"
echo "$SECRET_PASSWORD"
echo
echo "APPLE_CERTIFICATE            (one line, no wrapping)"
echo "----------------------------------------"
base64 -i "$WORK/signing.p12" | tr -d '\n'
echo
echo
echo "Then add the notarization values the release uses, if they are not set:"
echo "  APPLE_ID        the Apple ID that owns the certificate"
echo "  APPLE_PASSWORD  an app-specific password for that Apple ID"
echo "  APPLE_TEAM_ID   373K7W3LKU"
echo
echo "Finally re-run: Actions -> Desktop release -> Run workflow."