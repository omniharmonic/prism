#!/bin/bash
# Check a built "Prism Client.app" before it is packaged or published. Run by
# .github/workflows/release-client.yml; docs/client-app.md § Release (CI).
#
#   check-app.sh <app> --version <v>                         identity + version only (unsigned build)
#   check-app.sh <app> --version <v> --team <TEAMID>         + Developer ID signature checks
#   check-app.sh <app> --version <v> --team <TEAMID> --notarized   + stapled ticket + Gatekeeper
#
# Signature checks: strict deep verification, "Developer ID Application" authority of that team,
# hardened runtime, a secure timestamp, and NO entitlements at all (in particular no
# get-task-allow) — the shipped app has none (qa/pre-release-polish/RELEASE.md).
set -euo pipefail

app="${1:?usage: check-app.sh <app> --version <v> [--team <id>] [--notarized]}"
shift
version="" team="" notarized=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) version="${2:?}"; shift 2 ;;
    --team) team="${2:?}"; shift 2 ;;
    --notarized) notarized=1; shift ;;
    *) echo "check-app: unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ -n "$version" ]] || { echo "check-app: --version is required" >&2; exit 2; }
plist="$app/Contents/Info.plist"
[[ -f "$plist" ]] || { echo "check-app: no Info.plist in $app" >&2; exit 2; }

fail() { echo "check-app: $*" >&2; exit 1; }
key() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist" 2>/dev/null || true; }

[[ "$(key CFBundleIdentifier)" == "com.benjaminlife.prism.client" ]] || fail "bundle id is $(key CFBundleIdentifier)"
[[ "$(key CFBundleShortVersionString)" == "$version" ]] || fail "CFBundleShortVersionString $(key CFBundleShortVersionString) ≠ $version"
[[ "$(key CFBundleExecutable)" == "prism-client" ]] || fail "executable is $(key CFBundleExecutable)"
schemes="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes:0:CFBundleURLSchemes' "$plist" 2>/dev/null | tr -d ' {}\n' || true)"
[[ "$schemes" == "Array prism" || "$schemes" == "Arrayprism" ]] || fail "URL schemes: $schemes (expected exactly prism)"
arch="$(/usr/bin/lipo -archs "$app/Contents/MacOS/prism-client")"
echo "check-app: $(key CFBundleIdentifier) $version ($arch)"

if [[ -z "$team" ]]; then
  echo "check-app: unsigned build — signature checks skipped"
  exit 0
fi

/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
info="$(/usr/bin/codesign -dvvv "$app" 2>&1)"
grep -q "^Authority=Developer ID Application: .*($team)\$" <<<"$info" || fail "not signed with a Developer ID Application identity of team $team"
grep -q "^TeamIdentifier=$team\$" <<<"$info" || fail "TeamIdentifier is not $team"
grep -q "flags=.*(runtime)" <<<"$info" || fail "no hardened runtime"
grep -q "^Timestamp=" <<<"$info" || fail "no secure timestamp"
ents="$(/usr/bin/codesign -d --entitlements - --xml "$app" 2>/dev/null || true)"
if [[ -n "$ents" ]] && /usr/bin/plutil -p - <<<"$ents" 2>/dev/null | grep -q '=>'; then
  echo "$ents" >&2
  fail "the app carries entitlements (expected none)"
fi
echo "check-app: Developer ID ($team), hardened runtime, timestamp, no entitlements"

if [[ "$notarized" == 1 ]]; then
  /usr/bin/xcrun stapler validate "$app"
  /usr/sbin/spctl --assess --type execute --verbose=2 "$app"
  echo "check-app: stapled and accepted by Gatekeeper"
fi
