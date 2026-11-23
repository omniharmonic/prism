#!/bin/bash
# Package "Prism Client.app" as a compressed, read-only DMG (the app + an /Applications link),
# and sign the DMG when an identity is given. The DMG is made from the app AFTER it was signed,
# notarized and stapled, so what a person drags out of it is the stapled app. Run by
# .github/workflows/release-client.yml; docs/client-app.md § Release (CI).
#
#   make-dmg.sh <app> <out.dmg> ["<identity>" [--keychain <path>]]
set -euo pipefail

app="${1:?usage: make-dmg.sh <app> <out.dmg> [<identity> [--keychain <path>]]}"
out="${2:?usage: make-dmg.sh <app> <out.dmg> [<identity> [--keychain <path>]]}"
identity="${3:-}"
keychain=()
if [[ "${4:-}" == "--keychain" ]]; then keychain=(--keychain "${5:?--keychain needs a path}"); fi
[[ -d "$app/Contents" ]] || { echo "make-dmg: $app is not an app bundle" >&2; exit 2; }
[[ "$out" == *.dmg ]] || { echo "make-dmg: the output must end in .dmg" >&2; exit 2; }

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prism-client-dmg.XXXXXX")"
trap 'rm -rf "$work"' EXIT
stage="$work/stage"
mkdir -p "$stage"
/usr/bin/ditto "$app" "$stage/$(basename "$app")"
ln -s /Applications "$stage/Applications"
rm -f "$out"
/usr/bin/hdiutil create -volname "Prism Client" -srcfolder "$stage" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$out" >/dev/null
/usr/bin/hdiutil verify "$out" >/dev/null

if [[ -n "$identity" ]]; then
  /usr/bin/codesign --force --sign "$identity" --timestamp ${keychain[@]+"${keychain[@]}"} "$out"
  /usr/bin/codesign --verify --strict --verbose=2 "$out"
fi
echo "make-dmg: $(basename "$out") ($(/usr/bin/du -h "$out" | cut -f1))"
