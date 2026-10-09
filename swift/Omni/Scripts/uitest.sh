#!/bin/bash
# Run the Omni UI tests (UITests/, XCUITest) against the laptop dev backend and export a
# screenshot of every screen. Doc: TESTING.md.
#
#   Scripts/uitest.sh mac    [light|dark] [default|narrow]
#   Scripts/uitest.sh iphone [light|dark] [default|xxxl]
#   Scripts/uitest.sh ipad   [light|dark] [portrait|landscape|split]
#   Scripts/uitest.sh all                 every combination above, one after another
#
# The backend (apps/server/scripts/omni-dev.sh) must be up. Sign-in: the script signs in as
# the DEV owner the way OmniSmoke and omni-walkthrough.ts do — a ten-minute browser session
# row in the DEV database, then the real device sign-in (PKCE, client omni-native) — and
# hands the device token to the test runner in its environment. It is never printed, and it
# is revoked when the run ends. The app accepts it only in a DEBUG build launched by the
# runner (Sources/OmniUI/UITestSupport.swift).
#
# Settings (optional):
#   OMNI_DEV_ENV_FILE, OMNI_DEV_PORT, OMNI_DEV_DB   as for omni-dev.sh
#   OMNI_UITEST_IPHONE, OMNI_UITEST_IPAD   simulator UDIDs (default: devices named
#                                          "Omni UITest iPhone" / "Omni UITest iPad", created
#                                          when missing; never the simulator you use yourself)
#   OMNI_UITEST_DERIVED    derived data (default swift/Omni/.build/uitest-dd)
#   OMNI_UITEST_SHOTS      where the PNGs go (default <repo>/qa/screenshots/omni)
#   OMNI_UITEST_ONLY       what to run, comma-separated -only-testing values (default: OmniUITests),
#                          e.g. OmniUITests/OmniWalkTests/test08Approvals
#   OMNI_UITEST_MANUAL=1   include the manual browser sign-in test (the owner step)
#   OMNI_UITEST_KEEP_SIMS=1   leave the simulators booted afterwards
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # swift/Omni
REPO="$(cd "$HERE/../.." && pwd)"
SERVER="$REPO/apps/server"
ENV_FILE="${OMNI_DEV_ENV_FILE:-$SERVER/.env.dev}"
PORT="${OMNI_DEV_PORT:-8797}"
DB="${OMNI_DEV_DB:-$SERVER/prism-omni-dev.db}"
DERIVED="${OMNI_UITEST_DERIVED:-$HERE/.build/uitest-dd}"
SHOTS="${OMNI_UITEST_SHOTS:-$REPO/qa/screenshots/omni}"
ONLY="${OMNI_UITEST_ONLY:-OmniUITests}"
BASE="http://127.0.0.1:$PORT"
WHAT="${1:-}"

die() { echo "uitest: $*" >&2; exit 1; }
case "$WHAT" in mac|iphone|ipad|all) ;; *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac
[ -f "$ENV_FILE" ] || die "no dev env file at $ENV_FILE"
[ "$(basename "$ENV_FILE")" != ".env" ] || die "refusing to use .env — that is the production file"
[ -f "$DB" ] || die "no dev database at $DB — start the backend first (apps/server/scripts/omni-dev.sh)"
curl -s -o /dev/null --max-time 5 "$BASE/api/omni/version" || die "nothing answers on 127.0.0.1:$PORT — start apps/server/scripts/omni-dev.sh"

# ── the dev owner's device token (in the environment only) ────────────────────────────────
session_tool() { # mint | drop
  (cd "$SERVER" && DB_PATH="$DB" PORT="$PORT" OMNI_UITEST_OP="$1" node --env-file="$ENV_FILE" --import tsx -e '
    import("./src/db.ts").then(async (m) => {
      const { config } = await import("./src/config.ts");
      if (process.env.OMNI_UITEST_OP === "mint") {
        const id = (await import("node:crypto")).randomUUID();
        m.createSession(id, config.ownerEmail, 10 * 60_000);
        process.stdout.write(id);
      } else if (process.env.OMNI_UITEST_SESSION) {
        m.db.prepare("DELETE FROM sessions WHERE id = ?").run(process.env.OMNI_UITEST_SESSION);
      }
    });')
}
device_token() { # the real device sign-in, with the session above playing the browser
  OMNI_UITEST_BASE="$BASE" node -e '
    const { randomBytes, createHash } = require("node:crypto");
    (async () => {
      const BASE = process.env.OMNI_UITEST_BASE, cookie = `prism_session=${process.env.OMNI_UITEST_SESSION}`;
      const fail = (m) => { console.error("uitest: sign-in: " + m); process.exit(1); };
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const state = randomBytes(8).toString("hex");
      const q = new URLSearchParams({ client_id: "omni-native", redirect_uri: "omni://auth/callback", code_challenge: challenge, code_challenge_method: "S256", state, label: "Omni UI tests (laptop)" });
      const a = await fetch(`${BASE}/auth/device/authorize?${q}`, { headers: { cookie }, redirect: "manual" });
      if (a.status !== 200) fail(`authorize answered ${a.status}`);
      const html = await a.text();
      const req = /name="req" value="([^"]+)"/.exec(html)?.[1], csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
      const reqCookie = /prism_device_req=([^;]+)/.exec(a.headers.get("set-cookie") ?? "")?.[1];
      if (!req || !csrf || !reqCookie) fail("the consent page carried no form");
      const ap = await fetch(`${BASE}/auth/device/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${cookie}; prism_device_req=${reqCookie}` }, body: new URLSearchParams({ req, csrf, decision: "approve" }).toString(), redirect: "manual" });
      if (ap.status !== 302) fail(`approve answered ${ap.status}`);
      const loc = new URL(ap.headers.get("location") ?? "x:");
      if (loc.searchParams.get("state") !== state) fail("state was not echoed");
      const t = await fetch(`${BASE}/auth/device/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", client_id: "omni-native", redirect_uri: "omni://auth/callback", code: loc.searchParams.get("code"), code_verifier: verifier }) });
      const tj = await t.json().catch(() => ({}));
      if (t.status !== 200 || typeof tj.access_token !== "string" || !tj.access_token.startsWith("pd_")) fail(`token answered ${t.status}`);
      process.stdout.write(tj.access_token);
    })();'
}

OMNI_UITEST_SESSION="$(session_tool mint)"
[ -n "$OMNI_UITEST_SESSION" ] || die "could not mint a dev-owner session"
export OMNI_UITEST_SESSION
TOKEN=""
TOKEN2=""
CREATED_BOOT=""
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$TOKEN" ]; then printf 'Authorization: Bearer %s' "$TOKEN" | curl -s -o /dev/null --max-time 5 -X POST -H @- -H 'Content-Type: application/json' -d '{}' "$BASE/auth/device/revoke" || true; fi
  if [ -n "$TOKEN2" ]; then printf 'Authorization: Bearer %s' "$TOKEN2" | curl -s -o /dev/null --max-time 5 -X POST -H @- -H 'Content-Type: application/json' -d '{}' "$BASE/auth/device/revoke" || true; fi
  session_tool drop >/dev/null 2>&1 || true
  if [ "${OMNI_UITEST_KEEP_SIMS:-0}" != "1" ]; then for u in $CREATED_BOOT; do xcrun simctl shutdown "$u" >/dev/null 2>&1 || true; done; fi
}
trap cleanup EXIT INT TERM
TOKEN="$(device_token)"
[ -n "$TOKEN" ] || die "could not sign in as the dev owner"
# A second device, for the sign-out test alone: signing out revokes the token it used.
TOKEN2="$(device_token)"
[ -n "$TOKEN2" ] || die "could not sign in a second time"

# ── simulators: this script's own devices, by name ────────────────────────────────────────
sim() { # sim <name> <device type> → UDID (created when missing, booted)
  local name="$1" type="$2" udid
  udid="$(xcrun simctl list devices -j | /usr/bin/python3 -c 'import json,sys; n=sys.argv[1]; d=json.load(sys.stdin)["devices"]; print(next((x["udid"] for v in d.values() for x in v if x["name"]==n and x.get("isAvailable")), ""))' "$name")"
  [ -n "$udid" ] || udid="$(xcrun simctl create "$name" "$type")"
  # One of this script's simulators at a time: two at once, with a build, has run a laptop out of memory.
  for other in $CREATED_BOOT; do [ "$other" = "$udid" ] || xcrun simctl shutdown "$other" >/dev/null 2>&1 || true; done
  if ! xcrun simctl list devices | grep "$udid" | grep -q Booted; then xcrun simctl boot "$udid" >/dev/null; CREATED_BOOT="$CREATED_BOOT $udid"; fi
  xcrun simctl bootstatus "$udid" >/dev/null 2>&1 || true
  echo "$udid"
}

# A thread only the gateway knows, so the app's "no longer available" screen has something
# real to show: a row in the DEV database that the stub Hermes never had.
gone_thread() {
  local id now
  id="omni_uitestgone$(openssl rand -hex 4)"; now="$(($(date +%s) * 1000))"
  sqlite3 "$DB" "INSERT INTO omni_threads (id, title, state, source, created_at, last_activity_at) VALUES ('$id', 'Plan the retreat agenda', 'done', 'text', $now - 86400000, $now - 86400000);" 2>/dev/null || echo "uitest: could not add the 'no longer available' sample thread (that screen will be skipped)" >&2
}

# Wait while the Mac is short of memory (under 30% free) rather than add a build to it.
wait_for_memory() {
  local free n=0
  while :; do
    free="$(memory_pressure -Q 2>/dev/null | sed -n 's/.*free percentage: \([0-9]*\)%.*/\1/p')"
    [ -z "$free" ] && return 0
    [ "$free" -ge 30 ] && return 0
    n=$((n + 1)); [ "$n" -gt 60 ] && die "memory stayed under 30% free for ten minutes — not starting a run"
    [ "$n" = 1 ] && echo "uitest: memory is ${free}% free — waiting for 30%…" >&2
    sleep 10
  done
}

FAILED=0
run() { # run <platform> <theme> <variant>
  wait_for_memory
  local platform="$1" theme="$2" variant="$3" dest device udid="" extra=()
  case "$platform" in
    mac) dest="platform=macOS"; device="mac" ;;
    iphone)
      udid="${OMNI_UITEST_IPHONE:-$(sim "Omni UITest iPhone" com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro)}"
      dest="platform=iOS Simulator,id=$udid"; device="iphone-18-pro" ;;
    ipad)
      udid="${OMNI_UITEST_IPAD:-$(sim "Omni UITest iPad" com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB)}"
      dest="platform=iOS Simulator,id=$udid"; device="ipad-pro-13" ;;
  esac
  if [ -n "$udid" ]; then
    xcrun simctl ui "$udid" appearance "$theme" >/dev/null
    if [ "$variant" = "xxxl" ]; then xcrun simctl ui "$udid" content_size accessibility-extra-extra-extra-large >/dev/null; else xcrun simctl ui "$udid" content_size large >/dev/null; fi
  fi
  [ "${OMNI_UITEST_MANUAL:-0}" = "1" ] || extra+=(-skip-testing:OmniUITests/ManualSignInTests)
  local only; IFS=',' read -r -a only <<<"$ONLY"
  for o in "${only[@]}"; do extra+=(-only-testing:"$o"); done
  gone_thread
  local out="$SHOTS/$platform/$device${variant:+-$variant}/$theme"
  [ "$variant" = "default" ] && out="$SHOTS/$platform/$device/$theme"
  mkdir -p "$out"
  echo "uitest: ── $platform · $theme · $variant → ${out#"$REPO"/}"
  local log="$DERIVED/logs/$platform-$theme-$variant.log"; mkdir -p "$DERIVED/logs"
  # TEST_RUNNER_<NAME> reaches the test runner's environment as <NAME>. The token is passed
  # that way, never on a command line.
  if TEST_RUNNER_OMNI_UITEST_SERVER="$BASE" TEST_RUNNER_OMNI_UITEST_TOKEN="$TOKEN" TEST_RUNNER_OMNI_UITEST_SIGNOUT_TOKEN="$TOKEN2" TEST_RUNNER_OMNI_UITEST_SHOTS="$out" \
     TEST_RUNNER_OMNI_UITEST_THEME="$theme" TEST_RUNNER_OMNI_UITEST_VARIANT="$variant" TEST_RUNNER_OMNI_UITEST_PLATFORM="$platform" TEST_RUNNER_OMNI_UITEST_MANUAL="${OMNI_UITEST_MANUAL:-0}" \
     xcodebuild test -project "$HERE/Omni.xcodeproj" -scheme Omni -destination "$dest" -derivedDataPath "$DERIVED" \
       ${extra[@]+"${extra[@]}"} -parallel-testing-enabled NO -collect-test-diagnostics never \
       OMNI_BUNDLE_SUFFIX=.uitest >"$log" 2>&1; then
    grep -E "Executed [0-9]+ tests?" "$log" | tail -1 | sed 's/^[[:space:]]*/uitest:    /'
  else
    FAILED=$((FAILED + 1))
    grep -E "error:|failed -|Executed [0-9]+ tests?|\*\* TEST" "$log" | grep -v "pd_" | tail -25 | sed 's/^[[:space:]]*/uitest:    /'
    echo "uitest:    FAILED — full log: $log"
  fi
}

if [ "$WHAT" = "all" ]; then
  for t in light dark; do run mac "$t" default; done
  run mac light narrow
  for t in light dark; do run iphone "$t" default; done
  run iphone light xxxl
  for t in light dark; do run ipad "$t" portrait; done
  run ipad light landscape
  run ipad light split
else
  theme="${2:-light}"
  case "$WHAT" in mac|iphone) variant="${3:-default}" ;; ipad) variant="${3:-portrait}" ;; esac
  run "$WHAT" "$theme" "$variant"
fi
[ "$FAILED" = "0" ] || die "$FAILED run(s) failed"
echo "uitest: done — screenshots under ${SHOTS#"$REPO"/}"
