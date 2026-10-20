#!/bin/bash
# The in-app updater's archive: "Prism Client.app" (signed, notarized, stapled) as a tar.gz whose
# single top-level entry is the bundle (the layout tauri-plugin-updater unpacks), signed with the
# updater key and bound to the version (`tauri signer sign --app-version`), then verified against
# the COMMITTED public key. Run by .github/workflows/release-client.yml; docs/client-app.md
# § Release (CI).
#
#   updater-archive.sh <app> <out.app.tar.gz> <version>
#
# Needs TAURI_SIGNING_PRIVATE_KEY (+ TAURI_SIGNING_PRIVATE_KEY_PASSWORD) in the environment; they
# are read by the Tauri CLI only and never written to disk here. Writes <out>.sig.
# UPDATER_ARCHIVE_UNSIGNED_OK=1 skips only the final codesign/stapler check of the unpacked app
# (for testing the archive step on a dummy bundle); the release workflow never sets it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
app="${1:?usage: updater-archive.sh <app> <out.app.tar.gz> <version>}"
out="${2:?usage: updater-archive.sh <app> <out.app.tar.gz> <version>}"
version="${3:?usage: updater-archive.sh <app> <out.app.tar.gz> <version>}"
pub="$repo/apps/client/src-tauri/updater/updater.key.pub"
[[ -d "$app/Contents" ]] || { echo "updater-archive: $app is not an app bundle" >&2; exit 2; }
[[ -f "$pub" ]] || { echo "updater-archive: no committed public key at $pub (the updater is off)" >&2; exit 1; }
[[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] || { echo "updater-archive: TAURI_SIGNING_PRIVATE_KEY is not set" >&2; exit 1; }

rm -f "$out" "$out.sig"
COPYFILE_DISABLE=1 /usr/bin/tar --no-mac-metadata --no-xattrs --uid 0 --gid 0 --uname "" --gname "" \
  -czf "$out" -C "$(dirname "$app")" "$(basename "$app")"
(cd "$repo/apps/client" && npx --no-install tauri signer sign --app-version "$version" "$out" >/dev/null)
[[ -s "$out.sig" ]] || { echo "updater-archive: the signer wrote no $out.sig" >&2; exit 1; }
node "$here/updater-manifest.mjs" verify --pubkey "$pub" --archive "$out" --sig "$out.sig" --version "$version"

# What the updater will unpack is exactly the stapled, signed app.
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prism-client-upd.XXXXXX")"
trap 'rm -rf "$work"' EXIT
/usr/bin/tar -xzf "$out" -C "$work"
entries="$(/usr/bin/tar -tzf "$out" | cut -d/ -f1 | sort -u)"
[[ "$entries" == "$(basename "$app")" ]] || { echo "updater-archive: unexpected top-level entries: $entries" >&2; exit 1; }
if [[ "${UPDATER_ARCHIVE_UNSIGNED_OK:-}" != "1" ]]; then
  /usr/bin/codesign --verify --deep --strict "$work/$(basename "$app")"
  /usr/bin/xcrun stapler validate "$work/$(basename "$app")"
fi
echo "updater-archive: $(basename "$out") signed for $version and verified"
