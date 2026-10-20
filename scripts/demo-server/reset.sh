#!/usr/bin/env bash
# Reset the App Review demo server to its sample state — run AS THE DEMO macOS USER.
#
#   bash ~/demo-kit/reset.sh [--dry-run]
#
#   1. deletes EVERY note in the demo vault (sample pages and whatever the reviewer made);
#   2. stops the demo Prism Server and moves its database aside (accounts, sessions, devices,
#      grants, comments' live state — the reviewer account goes with it; a deleted reviewer
#      account therefore comes back here). The moved copy is kept in $DEMO_PREFIX/backups/,
#      newest 3; the server's secrets in config/.env are kept;
#   3. starts it again and seeds: the sample pages + a NEW reviewer password, printed once.
# The demo Parachute (hub + vault process, its admin, the server's vault token) is untouched.
# Run it before each App Review submission and after a review.
set -euo pipefail
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
  esac
done
# shellcheck source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
load_demo_env
guard_isolation
[ -f "$DEMO_PREFIX/.prism-host" ] || die "no demo install at $DEMO_PREFIX (run install.sh)"
PRISM="$DEMO_PREFIX/bin/prism"
DATA="$DEMO_PREFIX/data"
[ "$DRY_RUN" = 1 ] && echo "▶ DRY RUN: nothing is deleted, moved or restarted"
if [ "$DRY_RUN" = 0 ] && [ ! -t 1 ]; then die "run this in a terminal: the new reviewer password is printed once"; fi

echo "▶ 1/3 deleting every note in the demo vault"
if [ "$DRY_RUN" = 1 ]; then
  run "$NODE" "$KIT/seed.mjs" --prefix "$DEMO_PREFIX" --dry-run --wipe-only
else
  "$NODE" "$KIT/seed.mjs" --prefix "$DEMO_PREFIX" --wipe-only
fi

echo "▶ 2/3 stopping the demo server; its database goes to backups/"
run "$PRISM" stop --prefix "$DEMO_PREFIX"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$DEMO_PREFIX/backups/$STAMP-demo-reset"
run mkdir -p "$DEST"
run chmod 700 "$DEST"
for f in "$DATA"/prism-server.db "$DATA"/prism-server.db-wal "$DATA"/prism-server.db-shm; do
  if [ -e "$f" ] || [ "$DRY_RUN" = 1 ]; then run mv "$f" "$DEST/"; fi
done
if [ "$DRY_RUN" = 0 ]; then
  # Keep the newest three reset copies (and every other backup prism made).
  find "$DEMO_PREFIX/backups" -maxdepth 1 -type d -name '*-demo-reset' | sort -r | tail -n +4 | while read -r old; do rm -rf "$old"; done
fi

echo "▶ 3/3 starting it again and seeding"
run "$PRISM" start --prefix "$DEMO_PREFIX"
run "$NODE" "$KIT/seed.mjs" --prefix "$DEMO_PREFIX"
