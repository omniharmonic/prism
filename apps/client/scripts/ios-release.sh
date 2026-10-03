#!/usr/bin/env bash
# Build, sign and export the iOS app for App Store Connect / TestFlight (WP5).
# Run it in YOUR OWN Terminal on the Mac that holds the "Apple Distribution"
# identity: codesign needs the login keychain, and the first run may show
# "codesign wants to access key …" (click Always Allow). It never uploads.
#
#   apps/client/scripts/ios-release.sh            # → apps/client/ios/build/export/Prism.ipa
#
# Env (defaults = the owner's App Store Connect API key; the .p8 is never read here,
# only its path is handed to Apple's tools):
#   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH
#
# Why two steps: `tauri ios build` archives fine, but its own export uses Xcode
# cloud signing, which this API key's role is not allowed to use ("Cloud signing
# permission error"). So we export the archive ourselves with the local
# distribution certificate and the "Prism Workspace App Store" profile
# (apps/client/ios/ExportOptions-AppStore.plist).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLIENT="$ROOT/apps/client"
APPLE="$CLIENT/src-tauri/gen/apple"
OUT="$CLIENT/ios/build"
export APPLE_API_KEY="${ASC_KEY_ID:-AB84HRLBUA}"
export APPLE_API_ISSUER="${ASC_ISSUER_ID:-7c2856fc-0bdf-4d41-b95d-a2ffab2ba726}"
export APPLE_API_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${APPLE_API_KEY}.p8}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$CLIENT/src-tauri/target}"
[ -f "$APPLE_API_KEY_PATH" ] || { echo "API key not found at $APPLE_API_KEY_PATH" >&2; exit 1; }

ARCHIVE="$APPLE/build/prism-client_iOS.xcarchive"
rm -rf "$ARCHIVE" "$OUT/export"
mkdir -p "$OUT"
echo "▶ building + archiving (release, aarch64)…"
# The export step inside tauri fails on cloud signing (see above); the archive is what we need.
(cd "$CLIENT" && npx tauri ios build --export-method app-store-connect --ci) || true
[ -d "$ARCHIVE" ] || { echo "no archive at $ARCHIVE — see the tauri output above" >&2; exit 1; }

echo "▶ exporting with the local Apple Distribution identity…"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$CLIENT/ios/ExportOptions-AppStore.plist" \
  -exportPath "$OUT/export" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$APPLE_API_KEY_PATH" \
  -authenticationKeyID "$APPLE_API_KEY" \
  -authenticationKeyIssuerID "$APPLE_API_ISSUER"

IPA="$OUT/export/Prism.ipa"
[ -f "$IPA" ] || { echo "export produced no IPA" >&2; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
unzip -q "$IPA" -d "$TMP"
APP="$TMP/Payload/Prism.app"
echo "▶ $IPA ($(du -h "$IPA" | cut -f1))"
codesign -dv "$APP" 2>&1 | grep -E "Identifier|Authority=Apple Distribution|TeamIdentifier"
security cms -D -i "$APP/embedded.mobileprovision" | plutil -extract Name raw -o - -
security cms -D -i "$APP/embedded.mobileprovision" | plutil -extract ExpirationDate raw -o - -
codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -p -
plutil -p "$APP/Info.plist" | grep -E "CFBundleShortVersionString|CFBundleVersion\"|ITSAppUsesNonExemptEncryption"
echo
echo "Upload (owner):"
echo "  xcrun altool --upload-app --type ios --file \"$IPA\" --apiKey $APPLE_API_KEY --apiIssuer $APPLE_API_ISSUER"
echo "  (altool looks for AuthKey_$APPLE_API_KEY.p8 in ~/.appstoreconnect/private_keys)"
