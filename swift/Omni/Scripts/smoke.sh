#!/bin/bash
# Run OmniSmoke against the laptop dev backend (apps/server/scripts/omni-dev.sh must be up).
#
# It mints a ten-minute browser session for the DEV owner in the DEV database — the same
# existing dev tooling `omni-walkthrough.ts` uses; there is no bypass in the server — hands
# it to OmniSmoke in the environment (never printed, never in argv), and deletes the row
# afterwards. OmniSmoke itself signs in through PrismKit as `omni-native`.
#
# Settings (optional): OMNI_DEV_ENV_FILE, OMNI_DEV_PORT, OMNI_DEV_DB — as for omni-dev.sh.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # swift/Omni
SERVER="$(cd "$HERE/../../apps/server" && pwd)"     # apps/server
ENV_FILE="${OMNI_DEV_ENV_FILE:-$SERVER/.env.dev}"
PORT="${OMNI_DEV_PORT:-8797}"
DB="${OMNI_DEV_DB:-$SERVER/prism-omni-dev.db}"

die() { echo "smoke: $*" >&2; exit 1; }
[ -f "$ENV_FILE" ] || die "no dev env file at $ENV_FILE"
[ "$(basename "$ENV_FILE")" != ".env" ] || die "refusing to use .env — that is the production file"
[ -f "$DB" ] || die "no dev database at $DB — start the backend first (apps/server/scripts/omni-dev.sh)"
curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/api/omni/version" || die "nothing answers on 127.0.0.1:$PORT — start apps/server/scripts/omni-dev.sh"

session_tool() { # mint | drop <id>   (the id travels in the environment, not in argv)
  (cd "$SERVER" && DB_PATH="$DB" PORT="$PORT" OMNI_SMOKE_OP="$1" node --env-file="$ENV_FILE" --import tsx -e '
    import("./src/db.ts").then(async (m) => {
      const { config } = await import("./src/config.ts");
      if (process.env.OMNI_SMOKE_OP === "mint") {
        const id = (await import("node:crypto")).randomUUID();
        m.createSession(id, config.ownerEmail, 10 * 60_000);
        process.stdout.write(id);
      } else if (process.env.OMNI_SMOKE_SESSION) {
        m.db.prepare("DELETE FROM sessions WHERE id = ?").run(process.env.OMNI_SMOKE_SESSION);
      }
    });')
}

OMNI_SMOKE_SESSION="$(session_tool mint)"
[ -n "$OMNI_SMOKE_SESSION" ] || die "could not mint a dev-owner session"
export OMNI_SMOKE_SESSION
trap 'session_tool drop >/dev/null 2>&1 || true' EXIT

OMNI_SMOKE_URL="http://127.0.0.1:$PORT" swift run --package-path "$HERE" OmniSmoke
