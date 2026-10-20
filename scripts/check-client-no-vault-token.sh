#!/usr/bin/env bash
# check-client-no-vault-token.sh — WP4.3 acceptance: "no process on any client
# holds a vault token". READ-ONLY: it reads config files and process
# environments, never writes, never prints a secret value (only where it was
# found and which key/shape matched).
#
# Usage:
#   scripts/check-client-no-vault-token.sh [--no-processes] [--all-processes] [DIR ...]
#
#   DIR               client config dir(s) to scan (recursively, text files).
#                     Default (macOS):
#                       ~/Library/Application Support/com.benjaminlife.prism.client   (Prism Client)
#                       ~/Library/Application Support/prism                           (legacy desktop config)
#   --no-processes    skip the process-environment scan
#   --all-processes   scan EVERY process of this user, not just Prism app processes
#                     (informational: on the server host, pm2/prism-server legitimately
#                     holds the vault token, so expect findings there)
#
# What counts as a finding:
#   config files : a NON-EMPTY "parachute_api_key" / "collab_token" / "anthropic_api_key"
#                  value, a pvt_… opaque vault token, or a JWT-shaped string (hub tokens
#                  are JWTs: eyJ….eyJ….sig)
#   processes    : PARACHUTE_TOKEN / PARACHUTE_API_KEY / COLLAB_TOKEN /
#                  PARACHUTE_ADMIN_TOKEN set in the environment, or a pvt_/JWT-shaped
#                  value in it. (This script can't know the server's COLLAB_TOKEN VALUE,
#                  so it only checks names and shapes.)
#
# Exit: 0 = clean, 1 = findings, 2 = usage error.
set -uo pipefail

scan_procs=1
all_procs=0
dirs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-processes) scan_procs=0 ;;
    --all-processes) all_procs=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) dirs+=("$1") ;;
  esac
  shift
done
if [ ${#dirs[@]} -eq 0 ]; then
  dirs=("$HOME/Library/Application Support/com.benjaminlife.prism.client" "$HOME/Library/Application Support/prism")
fi

findings=0
note() { echo "  ✗ $*"; findings=$((findings + 1)); }

JWT_RE='eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+'
PVT_RE='pvt_[A-Za-z0-9]{8,}'
KEYS_RE='"(parachute_api_key|collab_token|anthropic_api_key)"[[:space:]]*:[[:space:]]*"[^"]+'

echo "== config files =="
for d in "${dirs[@]}"; do
  if [ ! -e "$d" ]; then
    echo "  · $d (absent)"
    continue
  fi
  echo "  · $d"
  while IFS= read -r -d '' f; do
    # Text files only; skip anything large (logs/caches are not config).
    if ! grep -Iq . "$f" 2>/dev/null; then continue; fi
    size=$(wc -c < "$f" 2>/dev/null || echo 0)
    if [ "$size" -gt 5000000 ]; then continue; fi
    keys=$(grep -oE "$KEYS_RE" "$f" 2>/dev/null | sed -E 's/^"([a-z_]+)".*/\1/' | sort -u | tr '\n' ' ')
    [ -n "$keys" ] && note "$f: non-empty credential key(s): $keys"
    grep -qE "$PVT_RE" "$f" 2>/dev/null && note "$f: contains a pvt_… vault token"
    grep -qE "$JWT_RE" "$f" 2>/dev/null && note "$f: contains a JWT-shaped token (hub/vault token?)"
  done < <(find "$d" -type f -print0 2>/dev/null)
done

if [ "$scan_procs" -eq 1 ]; then
  echo "== process environments =="
  if [ "$all_procs" -eq 1 ]; then
    pids=$(ps -x -o pid= 2>/dev/null)
  else
    # Prism app processes: the legacy desktop (Prism.app) and the Prism Client.
    pids=$(ps -x -o pid=,command= 2>/dev/null | grep -E 'Prism( Client)?\.app/|/prism-client( |$)|/prism( |$)' | grep -v grep | awk '{print $1}')
  fi
  count=$(printf '%s\n' $pids | grep -c . || true)
  echo "  · scanning $count process(es)"
  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    envline=$(ps eww -o command= -p "$pid" 2>/dev/null) || continue
    [ -z "$envline" ] && continue
    name=$(ps -o comm= -p "$pid" 2>/dev/null | awk -F/ '{print $NF}')
    vars=$(printf '%s\n' "$envline" | grep -oE '(^| )(PARACHUTE_TOKEN|PARACHUTE_API_KEY|PARACHUTE_ADMIN_TOKEN|COLLAB_TOKEN)=[^ ]' | sed -E 's/^ ?([A-Z_]+)=.*/\1/' | sort -u | tr '\n' ' ')
    [ -n "$vars" ] && note "pid $pid ($name): environment sets $vars"
    printf '%s' "$envline" | grep -qE "$PVT_RE" && note "pid $pid ($name): a pvt_… token in its command line/environment"
    printf '%s' "$envline" | grep -qE "$JWT_RE" && note "pid $pid ($name): a JWT-shaped token in its command line/environment"
  done
fi

echo
if [ "$findings" -eq 0 ]; then
  echo "check-client-no-vault-token: clean (no vault token found)"
  exit 0
fi
echo "check-client-no-vault-token: $findings finding(s) — see docs/client-app.md \"Switch-over runbook\""
exit 1
