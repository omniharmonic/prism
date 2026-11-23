#!/bin/bash
# Sign "Prism Client.app" with a Developer ID Application identity: hardened runtime, secure
# timestamp, NO entitlements (the shipped app has none; WKWebView's JIT runs in WebKit's own
# processes). Inside out: any extra Mach-O file first, the bundle last. Run by
# .github/workflows/release-client.yml; docs/client-app.md § Release (CI).
#
#   sign-app.sh <path/Prism Client.app> "<identity>" [--keychain <path>]
#
# <identity> is the SHA-1 or the full name of the identity. A nested bundle (.framework, .app,
# .xpc, .appex, .bundle) is refused: the client has none, and one would need its own entitlement
# decision — change this script deliberately when that happens.
set -euo pipefail

app="${1:?usage: sign-app.sh <app> <identity> [--keychain <path>]}"
identity="${2:?usage: sign-app.sh <app> <identity> [--keychain <path>]}"
keychain=()
if [[ "${3:-}" == "--keychain" ]]; then keychain=(--keychain "${4:?--keychain needs a path}"); fi
[[ -d "$app/Contents/MacOS" ]] || { echo "sign-app: $app is not an app bundle" >&2; exit 2; }

nested="$(find "$app/Contents" -mindepth 1 \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' -o -name '*.appex' -o -name '*.bundle' \) -print)"
if [[ -n "$nested" ]]; then
  echo "sign-app: nested bundles are not expected in Prism Client:" >&2
  echo "$nested" >&2
  exit 1
fi

main="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
[[ -f "$main" ]] || { echo "sign-app: main executable missing ($main)" >&2; exit 1; }

# Strip Finder / quarantine metadata that codesign refuses to seal (Apple QA1940).
/usr/bin/xattr -cr "$app"

args=(--force --sign "$identity" --options runtime --timestamp ${keychain[@]+"${keychain[@]}"})
# Extra Mach-O files (there is no nesting: nested bundles were refused above), never the main
# executable — the bundle's own signature covers it.
while IFS= read -r -d '' f; do
  [[ "$f" == "$main" ]] && continue
  if /usr/bin/file -b "$f" | grep -q 'Mach-O'; then
    echo "sign-app: signing $(basename "$f")"
    /usr/bin/codesign "${args[@]}" "$f"
  fi
done < <(find "$app/Contents" -type f -print0)

/usr/bin/codesign "${args[@]}" "$app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
echo "sign-app: signed $(basename "$app")"
