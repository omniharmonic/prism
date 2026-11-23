#!/bin/bash
# Sign SHA256SUMS with minisign (Ed25519) → SHA256SUMS.minisig, then verify it against the
# committed public key. Run by .github/workflows/release.yml; docs/host-bundle.md § Release.
#
#   sign-sums.sh <out-dir> <secret-key-file> "<trusted comment>"
#
# The secret key is never in the repository: it lives only in the CI secret MINISIGN_SECRET_KEY
# (written to a 0600 file under the runner's temp folder for this step, then removed). It must be
# a key made WITHOUT a password (`minisign -G -W`): CI has no terminal to type one into; the GitHub
# secret store is what protects it. The PUBLIC key is packaging/host/release/minisign.pub.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?usage: sign-sums.sh <out-dir> <secret-key-file> <trusted comment>}"
key="${2:?secret key file}"
comment="${3:?trusted comment}"
pub="$here/minisign.pub"
[[ -f "$pub" ]] || { echo "sign-sums: $pub is missing — commit the public key before signing releases (docs/host-bundle.md § Release)" >&2; exit 1; }
[[ -f "$out/SHA256SUMS" ]] || { echo "sign-sums: no $out/SHA256SUMS" >&2; exit 1; }

minisign -S -s "$key" -m "$out/SHA256SUMS" -x "$out/SHA256SUMS.minisig" -t "$comment" </dev/null
minisign -V -p "$pub" -m "$out/SHA256SUMS" -x "$out/SHA256SUMS.minisig"
