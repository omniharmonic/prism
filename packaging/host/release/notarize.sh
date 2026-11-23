#!/bin/bash
# Notarize a SIGNED host bundle: unpack the tarball, zip the bundle folder (notarytool takes zip,
# pkg or dmg — not tar.gz), submit it with an App Store Connect API key and wait for the verdict.
# Run by .github/workflows/release.yml after sign-bundle.sh; docs/host-bundle.md § Release.
#
#   notarize.sh <tarball> <api-key.p8> <key-id> <issuer-id>
#
# Notarization records the bundle's code-directory hashes with Apple; the tarball itself cannot be
# stapled (only app bundles, dmg and pkg can), so Gatekeeper looks the ticket up online the first
# time it assesses one of these binaries. The notary log is printed on any verdict but Accepted.
set -euo pipefail

tarball="${1:?usage: notarize.sh <tarball> <api-key.p8> <key-id> <issuer-id>}"
key="${2:?api key file}"
key_id="${3:?key id}"
issuer="${4:?issuer id}"
name="$(basename "$tarball" .tar.gz)"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prism-notarize.XXXXXX")"
trap 'rm -rf "$work"' EXIT

/usr/bin/tar -xzf "$tarball" -C "$work"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$work/$name" "$work/$name.zip"
result="$work/result.json"
xcrun notarytool submit "$work/$name.zip" --key "$key" --key-id "$key_id" --issuer "$issuer" --wait --timeout 30m --output-format json >"$result"
status="$(/usr/bin/plutil -extract status raw -o - "$result" 2>/dev/null || true)"
id="$(/usr/bin/plutil -extract id raw -o - "$result" 2>/dev/null || true)"
echo "notarize: submission ${id:-?} → ${status:-unknown}"
if [[ "$status" != "Accepted" ]]; then
  [[ -n "$id" ]] && xcrun notarytool log "$id" --key "$key" --key-id "$key_id" --issuer "$issuer" || true
  exit 1
fi
# Gatekeeper's own view of the runtime, now that the ticket exists (online check).
/usr/sbin/spctl --assess --type execute --verbose=2 "$work/$name/runtime/node/bin/node" || {
  echo "notarize: spctl did not accept the runtime yet (the ticket can take a moment to propagate)" >&2
}
