#!/bin/bash
# Sign every Mach-O file in a built host bundle with a Developer ID (hardened runtime, secure
# timestamp), check the signatures, run the signed runtime's self-test, and replace the tarball +
# its SHA256SUMS line with the signed one. Run by .github/workflows/release.yml; docs/host-bundle.md
# § Release. Never run it on a laptop that holds no signing identity (it refuses without one).
#
#   sign-bundle.sh <out-dir>/prism-host-<v>-darwin-arm64.tar.gz "<identity>" [--keychain <path>]
#   sign-bundle.sh <tarball> --list          # only print what would be signed (no signing)
#
# <identity> is the SHA-1 or the full name of a "Developer ID Application" identity.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
tarball="${1:?usage: sign-bundle.sh <tarball> <identity> [--keychain <path>] | <tarball> --list}"
identity="${2:?usage: sign-bundle.sh <tarball> <identity> [--keychain <path>] | <tarball> --list}"
keychain=()
if [[ "${3:-}" == "--keychain" ]]; then keychain=(--keychain "${4:?--keychain needs a path}"); fi
[[ -f "$tarball" ]] || { echo "sign-bundle: no tarball at $tarball" >&2; exit 2; }
tarball="$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")"
outdir="$(dirname "$tarball")"
name="$(basename "$tarball" .tar.gz)"
entitlements="$here/entitlements/node.plist"

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prism-sign.XXXXXX")"
trap 'rm -rf "$work"' EXIT
/usr/bin/tar -xzf "$tarball" -C "$work"
bundle="$work/$name"
[[ -x "$bundle/runtime/node/bin/node" ]] || { echo "sign-bundle: $name has no runtime/node/bin/node" >&2; exit 1; }

list="$work/macho.tsv"
(cd "$repo" && node --import tsx "$here/macho.ts" "$bundle") >"$list"  # tsx resolves from the repository
echo "sign-bundle: $(wc -l <"$list" | tr -d ' ') Mach-O file(s):"
sed 's/^/  /' "$list"
if [[ "$identity" == "--list" ]]; then exit 0; fi

# Inside out: add-ons and executables first, the runtime last (sorted so by macho.ts).
while IFS=$'\t' read -r kind rel; do
  file="$bundle/$rel"
  args=(--force --sign "$identity" --options runtime --timestamp ${keychain[@]+"${keychain[@]}"})
  if [[ "$kind" == "node" ]]; then args+=(--entitlements "$entitlements"); fi
  /usr/bin/codesign "${args[@]}" "$file"
done <"$list"

# Every file: a valid, strict signature by our team, with the hardened runtime.
team="${APPLE_TEAM_ID:?APPLE_TEAM_ID must be set}"
while IFS=$'\t' read -r kind rel; do
  file="$bundle/$rel"
  /usr/bin/codesign --verify --strict --verbose=1 "$file"
  info="$(/usr/bin/codesign -dvv "$file" 2>&1)"
  grep -q "^TeamIdentifier=$team\$" <<<"$info" || { echo "sign-bundle: $rel is not signed by team $team" >&2; exit 1; }
  grep -q "flags=.*(runtime)" <<<"$info" || { echo "sign-bundle: $rel has no hardened runtime" >&2; exit 1; }
done <"$list"
echo "sign-bundle: node entitlements:"
/usr/bin/codesign -d --entitlements - --xml "$bundle/runtime/node/bin/node" 2>/dev/null | plutil -p - | sed 's/^/  /'

# The signed runtime still works: JIT, WebAssembly, the add-on, esbuild.
"$bundle/runtime/node/bin/node" "$here/selftest.mjs" "$bundle"
"$bundle/bin/prism" version --json >/dev/null

# Re-pack exactly as build.ts does, and replace this tarball's SHA256SUMS line.
signed="$work/$name.tar.gz"
COPYFILE_DISABLE=1 /usr/bin/tar --no-mac-metadata --no-xattrs --uid 0 --gid 0 --uname "" --gname "" -czf "$signed" -C "$work" "$name"
mv -f "$signed" "$tarball"
sum="$(/usr/bin/shasum -a 256 "$tarball" | awk '{print $1}')"
sums="$outdir/SHA256SUMS"
{ [[ -f "$sums" ]] && grep -v "  $name.tar.gz\$" "$sums" || true; echo "$sum  $name.tar.gz"; } >"$sums.new"
mv -f "$sums.new" "$sums"
echo "sign-bundle: $name.tar.gz signed; sha256 $sum"
