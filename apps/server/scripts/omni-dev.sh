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
#   OMNI_DEV_STUB_STATE where the stub keeps its sessions between runs (default: <the db>.stub.json,
#                       git-ignored). Delete it — and the db — to start clean.
#   OMNI_DEV_WEB_BUILD  0 = never build apps/web here (default: build it when apps/web/dist is
#                       missing or older than the sources — the browser sign-in page needs it)
#
# Two backends can run side by side: give the second one its own OMNI_DEV_PORT,
# OMNI_DEV_STUB_PORT and OMNI_DEV_DB.
#
# The Hermes key and the hook service token are random, made at start, kept only in the
# two processes' environment, never written to a file and never printed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)" # apps/server
ENV_FILE="${OMNI_DEV_ENV_FILE:-$HERE/.env.dev}"
PORT="${OMNI_DEV_PORT:-8797}"
STUB_PORT="${OMNI_DEV_STUB_PORT:-18642}"
DB="${OMNI_DEV_DB:-$HERE/prism-omni-dev.db}"
STUB_STATE="${OMNI_DEV_STUB_STATE:-$DB.stub.json}"
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

# The browser sign-in page is the built web app (apps/web/dist). Build it when it is missing
# or older than its sources, so the first sign-in does not land on a 404.
REPO="$(cd "$HERE/../.." && pwd)"
WEB_DIST="$REPO/apps/web/dist/index.html"
web_stale() {
  [ -f "$WEB_DIST" ] || return 0
  [ -n "$(find "$REPO/apps/web/src" "$REPO/apps/web/index.html" "$REPO/apps/web/public" "$REPO/packages/core/src" -type f -newer "$WEB_DIST" -print -quit 2>/dev/null)" ]
}
if [ "${OMNI_DEV_WEB_BUILD:-1}" != "0" ] && web_stale; then
  if [ -f "$WEB_DIST" ]; then echo "omni-dev: the web app's build is older than its sources — rebuilding (about a minute)…"; else echo "omni-dev: the web app is not built yet — building it (about a minute; the browser sign-in page needs it)…"; fi
  if (cd "$REPO" && npm run build -w @prism/web >"$HERE/.omni-dev-web-build.log" 2>&1); then
    rm -f "$HERE/.omni-dev-web-build.log"
    echo "omni-dev: web app built"
  else
    echo "omni-dev: THE WEB BUILD FAILED — the last lines:" >&2
    tail -15 "$HERE/.omni-dev-web-build.log" >&2 || true
    if [ -f "$WEB_DIST" ]; then echo "omni-dev: carrying on with the older build (full log: apps/server/.omni-dev-web-build.log)" >&2
    else echo "omni-dev: carrying on WITHOUT the web app: the browser sign-in page will say so. Fix the build (npm run build -w @prism/web) and start again." >&2; fi
  fi
elif [ ! -f "$WEB_DIST" ]; then
  echo "omni-dev: apps/web/dist is missing and OMNI_DEV_WEB_BUILD=0 — the browser sign-in page will not load (npm run build -w @prism/web)" >&2
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

OMNI_STUB_PORT="$STUB_PORT" OMNI_STUB_GATEWAY_URL="http://127.0.0.1:$PORT" OMNI_STUB_STATE="$STUB_STATE" node --import tsx scripts/omni-stub-hermes.ts &
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

# Threads the gateway's database lists but the stub no longer has (its state file was deleted,
# or the database is older than the file) cannot be opened: take them out of the list. They
# are archived in THIS dev database only — never deleted — and say so here.
if [ -f "$DB" ] && [ "${OMNI_DEV_RECONCILE:-1}" != "0" ]; then
  # The ids the stub has, one per line, quoted for SQL (ids are [A-Za-z0-9_-] only; anything else is dropped).
  KNOWN="$(OMNI_DEV_STUB_STATE_FILE="$STUB_STATE" node -e '
    let ids = [];
    try { ids = (JSON.parse(require("node:fs").readFileSync(process.env.OMNI_DEV_STUB_STATE_FILE, "utf8")).sessions ?? []).map((s) => s && s.id); } catch {}
    process.stdout.write(ids.filter((x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(x)).map((x) => `\x27${x}\x27`).join(","));
  ' 2>/dev/null || true)"
  if [ -n "$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='omni_threads'" 2>/dev/null)" ]; then
    DEAD="$(sqlite3 "$DB" "UPDATE omni_threads SET archived = 1 WHERE archived = 0 AND id NOT IN (${KNOWN:-''}); SELECT changes();" 2>/dev/null || echo "?")"
    case "$DEAD" in
      0) ;;
      '?') echo "omni-dev: could not check old threads (one the stub no longer has shows as “no longer available” in the app)" >&2 ;;
      *) echo "omni-dev: $DEAD old thread(s) the stub no longer has were archived in the dev database (they could not be opened)" ;;
    esac
  fi
fi

echo "omni-dev: stub Hermes on http://127.0.0.1:$STUB_PORT, dev gateway starting on http://127.0.0.1:$PORT"
echo "omni-dev: executors OFF (no proton_send, ACTIONS_* false) — an approved draft answers executor_disabled"
echo "omni-dev: the app's server URL is http://127.0.0.1:$PORT (this Mac and its simulators only)"

echo "omni-dev: browser sign-in: use your dev password, or ask for the email link — no email is sent; the link is printed HERE, in a box"

# The server's log passes through unchanged; the one line that carries a sign-in link is
# repeated in a box so it cannot be missed among the request log. (The link is a one-time,
# 15-minute dev credential for this laptop's gateway; the server already prints it.)
highlight_link() {
  while IFS= read -r line; do
    printf '%s\n' "$line"
    case "$line" in
      *"[email:dev no RESEND]"*"/auth/callback?token="*)
        printf '\n  ┌─ SIGN-IN LINK — open it in the SAME browser that shows the sign-in page ─────\n  │\n  │  %s\n  │\n  └─ one use, 15 minutes ──────────────────────────────────────────────────────\n\n' "${line##* :: }"
        ;;
    esac
  done
}
PRISM_HTTP_ERRLOG=1 node --env-file="$ENV_FILE" --import tsx src/index.ts > >(highlight_link) 2>&1 &
SERVER_PID=$!
# Either process ending ends the pair.
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$STUB_PID" 2>/dev/null; do sleep 1; done
