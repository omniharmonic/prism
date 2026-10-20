#!/usr/bin/env bash
# M1 acceptance check (Architecture v2, WP1.4): "quit Prism.app for an hour and lose nothing".
#
# READ-ONLY. Run it on the Mac mini (or anywhere that can reach the Prism Server) BEFORE
# quitting Prism.app, and again an hour after:
#   1. GET /acl/workers  - every active ingest source must be kind=server and status=ok.
#      A source still kind=desktop is inferred from vault notes the desktop writes: if the
#      desktop quits, that source goes stale. That is the thing this check exists to catch.
#   2. Reads the desktop prism-config.json for ingest_mode / disable_* flags (booleans and
#      the mode only; NEVER prints a token or any secret value).
#
# Env:
#   PRISM_OWNER_TOKEN    (required) the server owner's Bearer: the COLLAB_TOKEN (loopback only)
#                        or an owner device token. Handed to curl on stdin, never on argv,
#                        never printed.
#   PRISM_SERVER_URL     default http://127.0.0.1:8787
#   PRISM_DESKTOP_CONFIG default ~/Library/Application Support/prism/prism-config.json
#
# Exit: 0 = independent, 1 = something would be lost, 2 = could not check.
set -u

URL="${PRISM_SERVER_URL:-http://127.0.0.1:8787}"
CFG="${PRISM_DESKTOP_CONFIG:-$HOME/Library/Application Support/prism/prism-config.json}"
rc=0

echo "== Desktop config: $CFG"
if [ -r "$CFG" ]; then
  python3 - "$CFG" <<'PY' || rc=1
import json, sys
c = json.load(open(sys.argv[1]))
mode = "client" if c.get("ingest_mode") == "client" else "host"   # same rule as the app
print(f"  ingest_mode            : {mode}")
flags = ["disable_message_sync", "disable_fathom_sync", "disable_fireflies_sync", "disable_email_sync",
         "disable_calendar_sync", "disable_embedding_index", "disable_skill_scheduler"]
for f in flags:
    print(f"  {f:<23}: {bool(c.get(f, False))}")
# Presence only (booleans). Values are never printed.
print(f"  parachute_api_key set  : {bool(c.get('parachute_api_key'))}")
print(f"  collab_token set       : {bool(c.get('collab_token'))}")
if mode == "client":
    print("  OK: client mode starts no background service and no skill scheduler.")
else:
    live = [f.replace("disable_", "") for f in flags if not c.get(f, False)]
    print("  NOTE: host mode; services that still run when configured: " + ", ".join(live))
    print("        (expected until the server cutovers are done; then set ingest_mode=client)")
PY
else
  echo "  (config not readable here; if this is not the desktop machine, run the check there too)"
fi

echo
echo "== Server worker health: $URL/acl/workers"
if [ -z "${PRISM_OWNER_TOKEN:-}" ]; then
  echo "  PRISM_OWNER_TOKEN is not set; cannot read worker health." >&2
  exit 2
fi
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
# The Authorization header goes to curl via a stdin config so it never appears in argv / ps.
code="$(printf 'header = "Authorization: Bearer %s"\n' "$PRISM_OWNER_TOKEN" \
  | curl -sS -K - -o "$tmp" -w '%{http_code}' --max-time 20 "$URL/acl/workers" 2>/dev/null)" || code="000"
if [ "$code" != "200" ]; then
  echo "  GET /acl/workers -> HTTP $code (needs the server-owner token; the COLLAB_TOKEN only works over loopback)" >&2
  exit 2
fi
python3 - "$tmp" <<'PY' || rc=1
import json, sys
d = json.load(open(sys.argv[1]))
src = d.get("sources", [])
print(f"  checkedAt {d.get('checkedAt')}")
print(f"  {'source':<22}{'kind':<9}{'status':<10}{'last success':<27}streak")
bad = []
for s in src:
    name, kind, st = s.get("name"), s.get("kind"), s.get("status")
    print(f"  {str(name):<22}{str(kind):<9}{str(st):<10}{str(s.get('lastSuccessAt')):<27}{s.get('failureStreak')}")
    if st == "disabled":
        continue                      # not configured / not in use: nothing to lose
    if kind == "desktop":
        bad.append(f"{name}: still DESKTOP-owned (inferred from desktop-written notes); it stops when Prism.app quits")
    elif st != "ok":
        bad.append(f"{name}: {st}" + (f" ({s.get('lastError')})" if s.get("lastError") else ""))
print()
if bad:
    print("NOT independent of the desktop:")
    for b in bad:
        print("  - " + b)
    sys.exit(1)
print("OK: every active ingest source is server-owned and healthy.")
PY
exit $rc
