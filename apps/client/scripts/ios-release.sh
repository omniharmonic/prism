#!/usr/bin/env bash
# Build, sign, export — and, with --upload, send to TestFlight — the iOS app (WP5).
# Run it in YOUR OWN Terminal on the laptop that holds the "Apple Distribution"
# identity: codesign needs the login keychain, and the first run may show
# "codesign wants to access key …" (click Always Allow). It REFUSES to run on the
# production host (a Mac mini, or a machine with ~/.prism-production-host).
#
#   apps/client/scripts/ios-release.sh -adhoc        # DEVICE PASS: an ad hoc .ipa for registered test devices
#                                                    # → apps/client/src-tauri/gen/apple/build/release/adhoc/Prism.ipa
#   apps/client/scripts/ios-release.sh               # App Store Connect export, NOT uploaded
#                                                    # → apps/client/src-tauri/gen/apple/build/release/export/Prism.ipa
#   apps/client/scripts/ios-release.sh --upload      # the export above, validated and uploaded, then added to the
#                                                    #   INTERNAL TestFlight group (PRISM_TESTFLIGHT_GROUP, default "Owners")
#   apps/client/scripts/ios-release.sh --upload-only # upload the export that is already there (no build)
#   … --upload --external                            # external testers — ONLY after the recorded device pass (asks first)
#   … --dry-run                                      # print every command it would run; changes nothing, uploads nothing
#
# Owner rule (2026-10-19): internal TestFlight any time; external testers only after
# the recorded device pass (docs/client-app.md, step 10).
#
# Upload route: `xcrun altool --validate-app` then `xcrun altool --upload-package`
# with App Store Connect API key auth (--api-key / --api-issuer / --p8-file-path).
# altool and Transporter are the command-line routes Apple lists for uploading
# builds (App Store Connect Help → "Upload builds"); `--upload-package` is the
# altool command the current altool documents for an .ipa (`xcrun altool --help`,
# altool 27: "Upload an ipa: altool --upload-package … --api-key … --api-issuer …").
# Not used: `--upload-app` (the older form), notarytool (notarization only, not
# the App Store), and `xcodebuild -exportArchive` with destination=upload (it
# needs Xcode's own account / cloud signing, which this key's role may not use —
# the same reason the export below is done by hand).
#
# Env:
#   ASC_API_KEY_ID, ASC_API_ISSUER_ID, ASC_API_KEY_PATH
#       the App Store Connect API key. REQUIRED for --upload / --upload-only (no defaults);
#       the .p8 must be mode 0600 and outside the repository. The older names
#       ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH are still read for a build without upload.
#   PRISM_ASSOCIATED_DOMAINS  universal-link hosts THIS build claims (comma list of DNS names).
#                             EMPTY BY DEFAULT (decision D-H): the build carries no Associated
#                             Domains and links reach the app as prism://… . The publisher's
#                             App Store build passes the publisher's own domain only. The two
#                             entitlements files are patched for the build and restored when
#                             this script exits (they must never be committed with a host).
#   PRISM_TESTFLIGHT_GROUP           internal group to add the build to (default "Owners")
#   PRISM_TESTFLIGHT_EXTERNAL_GROUP  external group for --external (no default)
#   PRISM_IOS_UPLOAD_STATE           local upload record (default ~/.prism-release/ios-uploads.json)
#
# Safety checks, all BEFORE anything is built:
#   1. not the production host            (asc.mjs host-check)
#   2. one version everywhere              (node scripts/version.mjs check)
#   3. upload: the API key env + file      (asc.mjs key-check)
#   4. upload: the iOS build number is higher than the last upload recorded on this
#      Mac AND than every build App Store Connect lists (asc.mjs build-check --remote;
#      --skip-remote-build-check = the local record only, said loudly)
#   5. --external: the owner rule is printed and must be confirmed by typing "external"
# After the export the IPA's CFBundleShortVersionString / CFBundleVersion must equal the
# checked version and build number, or nothing is uploaded.
#
# Why two build steps: `tauri ios build` archives fine, but its own export uses Xcode
# cloud signing, which this API key's role is not allowed to use ("Cloud signing
# permission error"). So we export the archive ourselves with the local
# distribution certificate and the "Prism Workspace App Store" profile
# (apps/client/src-tauri/gen/apple/ExportOptions.plist).
set -euo pipefail

usage() {
  echo "usage: $0 [-adhoc] [--upload | --upload-only] [--external] [--skip-remote-build-check] [--dry-run]" >&2
  exit 2
}

MODE="appstore"
UPLOAD=0
BUILD=1
EXTERNAL=0
DRY_RUN=0
REMOTE_CHECK=1
for a in "$@"; do
  case "$a" in
    -adhoc|--adhoc) MODE="adhoc" ;;
    --upload) UPLOAD=1 ;;
    --upload-only) UPLOAD=1; BUILD=0 ;;
    --external) EXTERNAL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-remote-build-check) REMOTE_CHECK=0 ;;
    *) usage ;;
  esac
done
if [ "$MODE" = "adhoc" ] && [ "$UPLOAD" = 1 ]; then echo "an ad hoc build is never uploaded (drop -adhoc)" >&2; exit 2; fi
if [ "$EXTERNAL" = 1 ] && [ "$UPLOAD" = 0 ]; then echo "--external only applies to --upload / --upload-only" >&2; exit 2; fi

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLIENT="$ROOT/apps/client"
APPLE="$CLIENT/src-tauri/gen/apple"
OUT="$APPLE/build/release"
ASC="$CLIENT/scripts/asc.mjs"
UL="$CLIENT/scripts/universal-links.mjs"

# Print a command (dry run) or run it. The plan goes to fd 3 (= stdout), so a redirect on
# the command itself (`run … >/dev/null`) never hides a line of the plan.
exec 3>&1
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+' >&3
    printf ' %q' "$@" >&3
    printf '\n' >&3
  else
    "$@"
  fi
}
# The same in another directory.
run_in() {
  local dir="$1"
  shift
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ (cd %q &&' "$dir" >&3
    printf ' %q' "$@" >&3
    printf ')\n' >&3
  else
    (cd "$dir" && "$@")
  fi
}
REFUSALS=0
# A safety check: always runs (they are read-only). In a dry run a refusal is reported and the
# plan goes on, so the whole plan is visible; the dry run then exits 1.
check() {
  if "$@"; then return 0; fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "  (dry run: the real run would stop here)" >&2
    REFUSALS=$((REFUSALS + 1))
    return 0
  fi
  exit 1
}

[ "$DRY_RUN" = 1 ] && echo "▶ DRY RUN: nothing is built, signed, patched or uploaded; checks still run"

# ── 1–2: where and what ──────────────────────────────────────────────────────
echo "▶ checks"
check node "$ASC" host-check
check node "$ROOT/scripts/version.mjs" check
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
BUILD_NUMBER="$(node -p 'require(process.argv[1]).bundle.iOS.bundleVersion' "$CLIENT/src-tauri/tauri.ios.conf.json")"
echo "  version $VERSION, iOS build $BUILD_NUMBER"

# ── 3–5: upload preconditions ────────────────────────────────────────────────
if [ "$UPLOAD" = 1 ]; then
  export ASC_API_KEY_ID="${ASC_API_KEY_ID:-}" ASC_API_ISSUER_ID="${ASC_API_ISSUER_ID:-}" ASC_API_KEY_PATH="${ASC_API_KEY_PATH:-}"
  check node "$ASC" key-check
  if [ "$REMOTE_CHECK" = 1 ] && [ "$DRY_RUN" = 0 ]; then
    check node "$ASC" build-check --build "$BUILD_NUMBER" --remote
  else
    [ "$REMOTE_CHECK" = 0 ] && echo "  WARNING: --skip-remote-build-check: App Store Connect is not asked; only this Mac's record is compared" >&2
    [ "$DRY_RUN" = 1 ] && [ "$REMOTE_CHECK" = 1 ] && echo "  (dry run: App Store Connect's build list is not asked; the real run asks it)"
    check node "$ASC" build-check --build "$BUILD_NUMBER"
  fi
  ALTOOL_HELP="$(xcrun altool --help 2>&1 || true)"
  if ! grep -q -- '--upload-package' <<<"$ALTOOL_HELP" || ! grep -q -- '--p8-file-path' <<<"$ALTOOL_HELP"; then
    echo "REFUSED: this Xcode's altool has no --upload-package / --p8-file-path (update Xcode)" >&2
    check false
  fi
  GROUP="${PRISM_TESTFLIGHT_GROUP:-Owners}"
  if [ "$EXTERNAL" = 1 ]; then
    echo
    echo "  ┌─ OWNER RULE (2026-10-19) ─────────────────────────────────────────────────────┐"
    echo "  │ External TestFlight testers ONLY after the RECORDED device pass                 │"
    echo "  │ (docs/client-app.md step 9: every row of PARITY-GAPS.md §b.3 with device, OS,   │"
    echo "  │ build number and result). Internal testers may get any build.                   │"
    echo "  └────────────────────────────────────────────────────────────────────────────────┘"
    GROUP="${PRISM_TESTFLIGHT_EXTERNAL_GROUP:-}"
    if [ -z "$GROUP" ]; then echo "REFUSED: --external needs PRISM_TESTFLIGHT_EXTERNAL_GROUP (the external group's name)" >&2; check false; fi
    if [ "$DRY_RUN" = 1 ]; then
      echo "  (dry run: the real run asks you to type \"external\" here)"
    else
      if [ ! -t 0 ]; then echo "REFUSED: --external needs a person at the terminal to confirm" >&2; exit 1; fi
      printf '  Has the device pass for build %s been recorded? Type "external" to continue: ' "$BUILD_NUMBER"
      read -r answer
      [ "$answer" = "external" ] || { echo "not confirmed; nothing was built or uploaded" >&2; exit 1; }
    fi
  fi
  echo "  TestFlight group: \"$GROUP\" ($([ "$EXTERNAL" = 1 ] && echo external || echo internal))"
fi

# Signing for the build/export: the new names, else the older ones, else the owner's key id
# (an id and issuer are not secrets; the .p8 itself is never read by this script).
export APPLE_API_KEY="${ASC_API_KEY_ID:-${ASC_KEY_ID:-AB84HRLBUA}}"
export APPLE_API_ISSUER="${ASC_API_ISSUER_ID:-${ASC_ISSUER_ID:-7c2856fc-0bdf-4d41-b95d-a2ffab2ba726}}"
export APPLE_API_KEY_PATH="${ASC_API_KEY_PATH:-${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${APPLE_API_KEY}.p8}}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$CLIENT/src-tauri/target}"
if [ ! -f "$APPLE_API_KEY_PATH" ]; then echo "API key not found at $APPLE_API_KEY_PATH" >&2; check false; fi

if [ "$MODE" = "adhoc" ]; then
  EXPORT_METHOD="release-testing"; EXPORT_PLIST="$APPLE/ExportOptions.adhoc.plist"; EXPORT_DIR="$OUT/adhoc"
else
  EXPORT_METHOD="app-store-connect"; EXPORT_PLIST="$APPLE/ExportOptions.plist"; EXPORT_DIR="$OUT/export"
fi
IPA="$EXPORT_DIR/Prism.ipa"

# Associated Domains for THIS build only (universal-links.mjs; restored on exit, whatever happens).
TMP=""
cleanup() {
  run node "$UL" --ios --none >/dev/null || echo "WARNING: restore the entitlements: node $UL --ios --none" >&2
  [ -z "$TMP" ] || rm -rf "$TMP"
}
trap cleanup EXIT

if [ "$BUILD" = 1 ]; then
  if [ -n "${PRISM_ASSOCIATED_DOMAINS:-}" ]; then
    echo "▶ universal links for: $PRISM_ASSOCIATED_DOMAINS"
    run node "$UL" --ios --hosts "$PRISM_ASSOCIATED_DOMAINS"
  else
    echo "▶ no PRISM_ASSOCIATED_DOMAINS: no universal links in this build (links arrive as prism://…)"
    run node "$UL" --ios --none >/dev/null
  fi

  ARCHIVE="$APPLE/build/prism-client_iOS.xcarchive"
  run rm -rf "$ARCHIVE" "$EXPORT_DIR"
  run mkdir -p "$OUT"
  echo "▶ building + archiving (release, aarch64; $MODE)…"
  # The export step inside tauri fails on cloud signing (see above); the archive is what we need.
  run_in "$CLIENT" npx tauri ios build --export-method "$EXPORT_METHOD" --ci || true
  if [ "$DRY_RUN" = 0 ] && [ ! -d "$ARCHIVE" ]; then echo "no archive at $ARCHIVE — see the tauri output above" >&2; exit 1; fi

  echo "▶ exporting with the local Apple Distribution identity ($(basename "$EXPORT_PLIST"))…"
  run xcodebuild -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportOptionsPlist "$EXPORT_PLIST" \
    -exportPath "$EXPORT_DIR" \
    -allowProvisioningUpdates \
    -authenticationKeyPath "$APPLE_API_KEY_PATH" \
    -authenticationKeyID "$APPLE_API_KEY" \
    -authenticationKeyIssuerID "$APPLE_API_ISSUER"
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "+ inspect $IPA: codesign identity + team, profile name + expiry, entitlements, CFBundleShortVersionString = $VERSION, CFBundleVersion = $BUILD_NUMBER, URL schemes"
else
  if [ ! -f "$IPA" ]; then
    if [ "$BUILD" = 0 ]; then echo "no IPA at $IPA (run with --upload instead of --upload-only to build one)" >&2; else echo "export produced no IPA at $IPA" >&2; fi
    exit 1
  fi
  TMP="$(mktemp -d)"
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
  IPA_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Info.plist")"
  IPA_BUILD="$(plutil -extract CFBundleVersion raw -o - "$APP/Info.plist")"
  if [ "$UPLOAD" = 1 ] && { [ "$IPA_VERSION" != "$VERSION" ] || [ "$IPA_BUILD" != "$BUILD_NUMBER" ]; }; then
    echo "REFUSED: the IPA says version $IPA_VERSION build $IPA_BUILD, the checks were for $VERSION build $BUILD_NUMBER — rebuild (nothing uploaded)" >&2
    exit 1
  fi
fi
echo

if [ "$MODE" = "adhoc" ]; then
  echo "Install on a registered test device (owner; nothing is uploaded):"
  echo "  xcrun devicectl list devices"
  echo "  xcrun devicectl device install app --device <device id> \"$IPA\""
  echo "  (or drag the .ipa onto the device in Finder / Apple Configurator)"
elif [ "$UPLOAD" = 0 ]; then
  echo "Not uploaded. To upload this export: $0 --upload-only   (internal TestFlight; external after the device pass)"
else
  echo "▶ validating with App Store Connect…"
  run xcrun altool --validate-app "$IPA" --api-key "$ASC_API_KEY_ID" --api-issuer "$ASC_API_ISSUER_ID" --p8-file-path "$ASC_API_KEY_PATH" --output-format normal
  echo "▶ uploading build $BUILD_NUMBER ($VERSION)…"
  run xcrun altool --upload-package "$IPA" --api-key "$ASC_API_KEY_ID" --api-issuer "$ASC_API_ISSUER_ID" --p8-file-path "$ASC_API_KEY_PATH" --show-progress
  run node "$ASC" record --build "$BUILD_NUMBER" --version "$VERSION"
  echo "▶ waiting for processing, then adding the build to \"$GROUP\"…"
  if [ "$EXTERNAL" = 1 ]; then
    run node "$ASC" assign --build "$BUILD_NUMBER" --version "$VERSION" --group "$GROUP" --external
    echo "External testers get it only after Beta App Review: App Store Connect → Prism Workspace → TestFlight → the build → Submit for Review."
  else
    run node "$ASC" assign --build "$BUILD_NUMBER" --version "$VERSION" --group "$GROUP" \
      || echo "WARNING: uploaded, but not added to \"$GROUP\" — add it in App Store Connect → TestFlight when it has processed" >&2
  fi
fi

if [ "$DRY_RUN" = 1 ] && [ "$REFUSALS" -gt 0 ]; then
  echo "▶ DRY RUN: $REFUSALS check(s) would refuse the real run" >&2
  exit 1
fi
