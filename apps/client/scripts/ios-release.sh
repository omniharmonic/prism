#!/usr/bin/env bash
# Build, sign and export the iOS app (WP5). Run it in YOUR OWN Terminal on the
# Mac that holds the "Apple Distribution" identity: codesign needs the login
# keychain, and the first run may show "codesign wants to access key …" (click
# Always Allow). It never uploads and never installs.
#
#   apps/client/scripts/ios-release.sh -adhoc     # DEVICE PASS: an ad hoc .ipa for registered test devices
#                                                 # → apps/client/src-tauri/gen/apple/build/release/adhoc/Prism.ipa
#   apps/client/scripts/ios-release.sh            # App Store Connect / TestFlight export (ONLY after parity sign-off)
#                                                 # → apps/client/src-tauri/gen/apple/build/release/export/Prism.ipa
#
# Both are Release builds on the PRODUCTION APNs environment; they differ only in
# the provisioning profile (gen/apple/ExportOptions.adhoc.plist: "Prism Workspace
# Ad Hoc", which lists device UDIDs; gen/apple/ExportOptions.plist: "Prism
# Workspace App Store").
#
# Env (defaults = the owner's App Store Connect API key; the .p8 is never read here,
# only its path is handed to Apple's tools):
#   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH
#
# Why two steps: `tauri ios build` archives fine, but its own export uses Xcode
# cloud signing, which this API key's role is not allowed to use ("Cloud signing
# permission error"). So we export the archive ourselves with the local
# distribution certificate and the "Prism Workspace App Store" profile
# (apps/client/src-tauri/gen/apple/ExportOptions.plist).
set -euo pipefail
MODE="appstore"
case "${1:-}" in
  "") ;;
  -adhoc|--adhoc) MODE="adhoc" ;;
  *) echo "usage: $0 [-adhoc]" >&2; exit 2 ;;
esac
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLIENT="$ROOT/apps/client"
APPLE="$CLIENT/src-tauri/gen/apple"
OUT="$APPLE/build/release"
export APPLE_API_KEY="${ASC_KEY_ID:-AB84HRLBUA}"
export APPLE_API_ISSUER="${ASC_ISSUER_ID:-7c2856fc-0bdf-4d41-b95d-a2ffab2ba726}"
export APPLE_API_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${APPLE_API_KEY}.p8}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$CLIENT/src-tauri/target}"
[ -f "$APPLE_API_KEY_PATH" ] || { echo "API key not found at $APPLE_API_KEY_PATH" >&2; exit 1; }

if [ "$MODE" = "adhoc" ]; then
  EXPORT_METHOD="release-testing"; EXPORT_PLIST="$APPLE/ExportOptions.adhoc.plist"; EXPORT_DIR="$OUT/adhoc"
else
  EXPORT_METHOD="app-store-connect"; EXPORT_PLIST="$APPLE/ExportOptions.plist"; EXPORT_DIR="$OUT/export"
fi

ARCHIVE="$APPLE/build/prism-client_iOS.xcarchive"
rm -rf "$ARCHIVE" "$EXPORT_DIR"
mkdir -p "$OUT"
echo "▶ building + archiving (release, aarch64; $MODE)…"
# The export step inside tauri fails on cloud signing (see above); the archive is what we need.
(cd "$CLIENT" && npx tauri ios build --export-method "$EXPORT_METHOD" --ci) || true
[ -d "$ARCHIVE" ] || { echo "no archive at $ARCHIVE — see the tauri output above" >&2; exit 1; }

echo "▶ exporting with the local Apple Distribution identity ($(basename "$EXPORT_PLIST"))…"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -exportPath "$EXPORT_DIR" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$APPLE_API_KEY_PATH" \
  -authenticationKeyID "$APPLE_API_KEY" \
  -authenticationKeyIssuerID "$APPLE_API_ISSUER"

IPA="$EXPORT_DIR/Prism.ipa"
[ -f "$IPA" ] || { echo "export produced no IPA" >&2; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
unzip -q "$IPA" -d "$TMP"
APP="$TMP/Payload/Prism.app"
echo "▶ $IPA ($(du -h "$IPA" | cut -f1))"
codesign -dv "$APP" 2>&1 | grep -E "Identifier|Authority=Apple Distribution|TeamIdentifier"
security cms -D -i "$APP/embedded.mobileprovision" | plutil -extract Name raw -o - -
security cms -D -i "$APP/embedded.mobileprovision" | plutil -extract ExpirationDate raw -o - -
codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -p -
plutil -p "$APP/Info.plist" | grep -E "CFBundleShortVersionString|CFBundleVersion\"|ITSAppUsesNonExemptEncryption|NSFaceIDUsageDescription|NSAppTransportSecurity"
echo "URL schemes (expect exactly: prism):"
plutil -extract CFBundleURLTypes.0.CFBundleURLSchemes json -o - "$APP/Info.plist" || echo "  (none registered)"
echo
if [ "$MODE" = "adhoc" ]; then
  echo "Install on a registered test device (owner; nothing is uploaded):"
  echo "  xcrun devicectl list devices"
  echo "  xcrun devicectl device install app --device <device id> \"$IPA\""
  echo "  (or drag the .ipa onto the device in Finder / Apple Configurator)"
else
  echo "Upload (owner) — ONLY after full parity sign-off (docs/client-app.md):"
  echo "  xcrun altool --upload-app --type ios --file \"$IPA\" --apiKey $APPLE_API_KEY --apiIssuer $APPLE_API_ISSUER"
  echo "  (altool looks for AuthKey_$APPLE_API_KEY.p8 in ~/.appstoreconnect/private_keys)"
fi
