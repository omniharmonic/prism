#!/bin/bash
# Notarize a SIGNED "Prism Client.app" or DMG with an App Store Connect API key, wait for the
# verdict, staple the ticket and validate it. Run by .github/workflows/release-client.yml;
# docs/client-app.md § Release (CI).
#
#   notarize.sh <path.app | path.dmg> <api-key.p8> <key-id> <issuer-id>
#
# An app is submitted as a ditto zip (notarytool takes zip, pkg or dmg); the ticket is stapled to
# the app itself. The notary log is printed on any verdict but Accepted, and the step fails.
set -euo pipefail

target="${1:?usage: notarize.sh <app|dmg> <api-key.p8> <key-id> <issuer-id>}"
key="${2:?api key file}"
key_id="${3:?key id}"
issuer="${4:?issuer id}"
[[ -e "$target" ]] || { echo "notarize: no $target" >&2; exit 2; }
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prism-client-notarize.XXXXXX")"
trap 'rm -rf "$work"' EXIT

case "$target" in
  *.app)
    submit="$work/$(basename "$target" .app).zip"
    /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$target" "$submit"
    ;;
  *.dmg) submit="$target" ;;
  *) echo "notarize: expected a .app or a .dmg" >&2; exit 2 ;;
esac

result="$work/result.json"
/usr/bin/xcrun notarytool submit "$submit" --key "$key" --key-id "$key_id" --issuer "$issuer" --wait --timeout 30m --output-format json >"$result"
status="$(/usr/bin/plutil -extract status raw -o - "$result" 2>/dev/null || true)"
id="$(/usr/bin/plutil -extract id raw -o - "$result" 2>/dev/null || true)"
echo "notarize: $(basename "$target") submission ${id:-?} → ${status:-unknown}"
if [[ "$status" != "Accepted" ]]; then
  [[ -n "$id" ]] && /usr/bin/xcrun notarytool log "$id" --key "$key" --key-id "$key_id" --issuer "$issuer" || true
  exit 1
fi

# The ticket can take a moment to reach the CDN stapler reads from.
for attempt in 1 2 3 4 5; do
  if /usr/bin/xcrun stapler staple "$target"; then break; fi
  [[ "$attempt" == 5 ]] && { echo "notarize: stapling failed" >&2; exit 1; }
  sleep 15
done
/usr/bin/xcrun stapler validate "$target"
