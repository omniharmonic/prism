#!/bin/bash
# Prove the UI-test launch path (Sources/OmniUI/UITestSupport.swift: a handed-in device token,
# an in-memory Keychain, no Touch ID before Send, altered server answers) is NOT in a
# Release build.
#
#   Scripts/check-release.sh            source check + a Release build of the Mac app, searched
#   Scripts/check-release.sh --source   the source check only (seconds; no build)
#
# 1. Source: the whole file is inside `#if DEBUG`, and every use of it elsewhere is too.
# 2. Binary: a Release build is made and searched for the launch path's names. A Debug
#    build must contain them (so the search itself is known to work) when one is at hand.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DERIVED="${OMNI_RELEASE_CHECK_DERIVED:-$HERE/.build/release-check-dd}"
fail() { echo "check-release: FAIL — $*" >&2; exit 1; }

FILE="$HERE/Sources/OmniUI/UITestSupport.swift"
[ -f "$FILE" ] || fail "UITestSupport.swift is missing"
first="$(grep -v '^[[:space:]]*//' "$FILE" | grep -v '^[[:space:]]*$' | head -1)"
last="$(grep -v '^[[:space:]]*$' "$FILE" | tail -1)"
[ "$first" = "#if DEBUG" ] || fail "UITestSupport.swift does not begin with #if DEBUG"
[ "$last" = "#endif" ] || fail "UITestSupport.swift does not end with #endif"
# Every other mention of the launch path must sit between `#if DEBUG` and its `#endif`.
bad="$(cd "$HERE" && grep -rlE 'UITestLaunch|UITestCompactWidth|OMNI_UITEST' Sources App | grep -v 'Sources/OmniUI/UITestSupport.swift' | while read -r f; do
  awk -v file="$f" '
    /^[[:space:]]*#if DEBUG/ { depth++ ; if (depth == 1) inDebug = 1; next }
    /^[[:space:]]*#if / { depth++; next }
    /^[[:space:]]*#endif/ { if (depth == 1) inDebug = 0; if (depth > 0) depth--; next }
    /UITestLaunch|UITestCompactWidth|OMNI_UITEST/ { if (!inDebug) print file ":" NR }
  ' "$f"
done)"
[ -z "$bad" ] || fail "the UI-test launch path is used outside #if DEBUG: $bad"
echo "check-release: source — UITestSupport.swift is DEBUG-only, and so is every use of it"
[ "${1:-}" = "--source" ] && exit 0

NAMES='OMNI_UITEST|UITestLaunch|FaultInjectingService|NeverReturningFlow'
xcodebuild build -project "$HERE/Omni.xcodeproj" -scheme Omni -configuration Release -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO >"$DERIVED.log" 2>&1 || { tail -20 "$DERIVED.log" >&2; fail "the Release build failed (log: $DERIVED.log)"; }
BIN="$DERIVED/Build/Products/Release/Omni.app/Contents/MacOS/Omni"
[ -f "$BIN" ] || fail "no Release binary at $BIN"
hits="$( (strings -a "$BIN"; nm "$BIN" 2>/dev/null) | grep -cE "$NAMES" || true)"
[ "$hits" = "0" ] || fail "the Release binary mentions the UI-test launch path ($hits places)"
echo "check-release: binary — the Release build of Omni.app has no trace of it"
for DEBUG_BIN in "$HERE"/.build/*/Build/Products/Debug/Omni.app/Contents/MacOS/Omni*; do
  [ -f "$DEBUG_BIN" ] || continue
  if (strings -a "$DEBUG_BIN"; find "$(dirname "$DEBUG_BIN")" -name '*.dylib' -exec strings -a {} + 2>/dev/null) | grep -qE "$NAMES"; then
    echo "check-release: (a Debug build does contain it, so the search works)"
  fi
  break
done
rm -f "$DERIVED.log"
