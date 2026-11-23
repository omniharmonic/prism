#!/bin/bash
# Deployment layout: this script, bin/KokoroWorker, asset-tools/{download.py,...}.
# Verification never consumes protocol stdin. Diagnostics stay off stdout.
set -euo pipefail
readonly deployment_root="$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
: "${OMNI_TTS_EVALUATION_CACHE:?An absolute Kokoro cache directory is required}"
case "$OMNI_TTS_EVALUATION_CACHE" in
  /*) ;;
  *) exit 64 ;;
esac
readonly executable="$deployment_root/bin/KokoroWorker"
readonly verifier="$deployment_root/asset-tools/download.py"
[[ -x "$executable" && -f "$verifier" ]] || exit 66
# Exact pinned files, frontend and notices are checked before every worker spawn.
# No --download flag: missing/corrupt assets fail closed without network access.
/usr/bin/python3 "$verifier" --cache "$OMNI_TTS_EVALUATION_CACHE" </dev/null >&2
exec "$executable"
