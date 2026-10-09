#!/bin/bash
# Laptop-only Omni dev backend: a STUB Hermes + a dev Prism Server with the Omni gateway on,
# pointed at the stub. Nothing here can send anything: every executor is forced off.
# Doc: docs/omni-module.md "Developing against a stub Hermes".
#
#   scripts/omni-dev.sh               start the stub and the dev gateway (Ctrl-C stops both)
#   scripts/omni-dev.sh walkthrough   run the end-to-end walk-through against a running one
#   scripts/omni-dev.sh scenarios     list the stub's scripted behaviours
#
# Settings (all optional):
#   OMNI_DEV_ENV_FILE   the DEV env file (default apps/server/.env.dev). Never `.env`.
#   OMNI_DEV_PORT       dev gateway port (default 8797)
#   OMNI_DEV_STUB_PORT  stub Hermes port (default 18642)
#   OMNI_DEV_DB         this backend's own SQLite file (default apps/server/prism-omni-dev.db;
#                       seeded once from the env file's DB_PATH when that exists)
#
# The Hermes key and the hook service token are random, made at start, kept only in the
# two processes' environment, never written to a file and never printed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)" # apps/server
ENV_FILE="${OMNI_DEV_ENV_FILE:-$HERE/.env.dev}"
PORT="${OMNI_DEV_PORT:-8797}"
STUB_PORT="${OMNI_DEV_STUB_PORT:-18642}"
DB="${OMNI_DEV_DB:-$HERE/prism-omni-dev.db}"
MODE="${1:-up}"

die() { echo "omni-dev: $*" >&2; exit 1; }
# A value from the env file (the last assignment wins, quotes stripped). Never echoed by callers
# except for the non-secret keys read below.
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }

cd "$HERE"

if [ "$MODE" = "scenarios" ]; then
  exec node --import tsx -e 'import("./scripts/lib/hermes-stub.ts").then((m) => { for (const [k, v] of Object.entries(m.SCENARIOS)) console.log(`stub:${k}\n    ${v}`); })'
fi

[ -f "$ENV_FILE" ] || die "no env file at $ENV_FILE (set OMNI_DEV_ENV_FILE to your DEV env file)"
[ "$(basename "$ENV_FILE")" != ".env" ] || die "refusing to use .env — that is the production file. Use a dev env file."
case "$(env_value PARACHUTE_URL)" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) die "PARACHUTE_URL in $(basename "$ENV_FILE") is not a loopback dev vault — refusing" ;;
esac
for p in "$PORT" "$STUB_PORT"; do
  case "$p" in ''|*[!0-9]*) die "ports must be numbers" ;; esac
done
[ "$STUB_PORT" != "8642" ] || die "8642 is the real Hermes API server's port — the stub must not sit there"
[ "$PORT" != "$STUB_PORT" ] || die "the gateway and the stub need different ports"

# This backend's own database: never the file another dev server has open.
SRC_DB="$(env_value DB_PATH)"
case "$SRC_DB" in /*|'') ;; *) SRC_DB="$HERE/${SRC_DB#./}" ;; esac
[ "$DB" != "$SRC_DB" ] || die "OMNI_DEV_DB must not be the env file's own DB_PATH"

export PORT DB_PATH="$DB"
export OMNI_DEV_URL="http://127.0.0.1:$PORT"

if [ "$MODE" = "walkthrough" ]; then
  [ -f "$DB" ] || die "no dev database at $DB — start the backend first (scripts/omni-dev.sh)"
  # Only the session row needs the database; no vault call is made from this process.
  exec node --env-file="$ENV_FILE" --import tsx scripts/omni-walkthrough.ts
fi
[ "$MODE" = "up" ] || die "usage: scripts/omni-dev.sh [up|walkthrough|scenarios]"

in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
in_use "$PORT" && die "port $PORT is already in use (set OMNI_DEV_PORT)"
in_use "$STUB_PORT" && die "port $STUB_PORT is already in use (set OMNI_DEV_STUB_PORT)"

if [ ! -f "$DB" ] && [ -n "$SRC_DB" ] && [ -f "$SRC_DB" ]; then
  # A consistent copy (the source may be open in another dev server): accounts, grants and
  # the owner's password come along, so the browser sign-in works here too.
  rm -f "$DB.seed"
  sqlite3 "$SRC_DB" ".backup '$DB.seed'" || { rm -f "$DB.seed"; die "could not copy the dev database"; }
  mv "$DB.seed" "$DB"
  echo "omni-dev: seeded $(basename "$DB") from $(basename "$SRC_DB")"
fi

# A vault token for the laptop's own hub, as the laptop dev launcher mints it. It lives only
# in this process's environment (the process environment wins over the env file).
if [ -z "${PARACHUTE_TOKEN:-}" ] && command -v parachute >/dev/null 2>&1; then
  PARACHUTE_TOKEN="$(cd ~ && parachute auth mint-token --scope vault:default:write --label prism-omni-dev --expires-in 604800 2>/dev/null | tail -1 || true)"
  if [ "${#PARACHUTE_TOKEN}" -gt 200 ]; then export PARACHUTE_TOKEN; else unset PARACHUTE_TOKEN; echo "omni-dev: could not mint a dev vault token; using the env file's (Today's agenda/tasks may fail)" >&2; fi
fi

# Dev-only secrets: random, in memory only.
OMNI_HERMES_KEY="$(openssl rand -hex 32)"
OMNI_SERVICE_TOKEN="$(openssl rand -hex 32)"
export OMNI_HERMES_KEY OMNI_SERVICE_TOKEN
export OMNI_HERMES_KEY_ENV=OMNI_HERMES_KEY
export OMNI_ENABLED=true
export OMNI_HERMES_URL="http://127.0.0.1:$STUB_PORT"

# Nothing outward. An empty value counts as unset for the Omni settings, and a variable that
# is already in the environment is never replaced by the env file.
export OMNI_PROTON_SEND="" OMNI_EMAIL_EXECUTOR=proton-send
export ACTIONS_EMAIL_ENABLED=false ACTIONS_CALENDAR_ENABLED=false ACTIONS_MATRIX_ENABLED=false
export BIND_HOST=127.0.0.1 TRUST_LOCAL=true
export APP_ORIGIN="http://127.0.0.1:$PORT"

STUB_PID=""
SERVER_PID=""
cleanup() {
  trap - EXIT INT TERM
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

OMNI_STUB_PORT="$STUB_PORT" OMNI_STUB_GATEWAY_URL="http://127.0.0.1:$PORT" node --import tsx scripts/omni-stub-hermes.ts &
STUB_PID=$!

# Wait for OUR stub: only it accepts the key made above, so a 200 here proves the gateway
# will not be talking to some other Hermes. The key goes to curl on stdin, not in its argv.
ok=""
for _ in $(seq 1 50); do
  kill -0 "$STUB_PID" 2>/dev/null || die "the stub Hermes did not start"
  if printf 'Authorization: Bearer %s' "$OMNI_HERMES_KEY" | curl -fsS -o /dev/null -H @- "http://127.0.0.1:$STUB_PORT/api/sessions?limit=1" 2>/dev/null; then ok=1; break; fi
  sleep 0.2
done
[ -n "$ok" ] || die "the stub Hermes did not answer on 127.0.0.1:$STUB_PORT"

echo "omni-dev: stub Hermes on http://127.0.0.1:$STUB_PORT, dev gateway starting on http://127.0.0.1:$PORT"
echo "omni-dev: executors OFF (no proton_send, ACTIONS_* false) — an approved draft answers executor_disabled"
echo "omni-dev: the app's server URL is http://127.0.0.1:$PORT (this Mac and its simulators only)"

PRISM_HTTP_ERRLOG=1 node --env-file="$ENV_FILE" --import tsx src/index.ts &
SERVER_PID=$!
# Either process ending ends the pair.
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$STUB_PID" 2>/dev/null; do sleep 1; done
