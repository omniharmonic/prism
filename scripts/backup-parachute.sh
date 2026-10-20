#!/usr/bin/env bash
# Consistent, verified, READ-ONLY snapshot of every piece of live Parachute +
# Prism state. Safe to run while the hub, vault and prism-server are serving:
# SQLite files are copied with the online `.backup` API (a consistent
# point-in-time copy even mid-write), never `cp` of a WAL-mode db.
#
#   scripts/backup-parachute.sh [label]
#
# Writes ~/parachute-backups/<UTC timestamp>-<label>/ (chmod 700 — it holds
# tokens and secrets) with a MANIFEST.txt of versions, row counts, integrity
# results and sha256s. Exits non-zero if any integrity check fails.
# Logs (~2GB) are intentionally skipped.
set -euo pipefail

LABEL="${1:-manual}"
P="$HOME/.parachute"
PRISM="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/parachute-backups/$(date -u +%Y%m%dT%H%M%SZ)-$LABEL"
MAN="$DEST/MANIFEST.txt"
FAIL=0

umask 077
mkdir -p "$DEST"
chmod 700 "$HOME/parachute-backups" "$DEST"

log() { echo "$*" | tee -a "$MAN"; }

# snapshot_db <src> <dest> <count-sql or "">
snapshot_db() {
  local src="$1" dst="$2" count_sql="$3"
  mkdir -p "$(dirname "$dst")"
  sqlite3 "$src" ".timeout 30000" ".backup '$dst'"
  # A copy of a WAL-mode db can't be opened -readonly without its -shm; make
  # the snapshot a self-contained single file instead.
  sqlite3 "$dst" "PRAGMA journal_mode=DELETE;" >/dev/null
  local ic
  ic="$(sqlite3 -readonly "$dst" "PRAGMA integrity_check;" | head -1)"
  local count=""
  [ -n "$count_sql" ] && count="$(sqlite3 -readonly "$dst" "$count_sql")"
  local sv
  sv="$(sqlite3 -readonly "$dst" "SELECT group_concat(version) FROM schema_version;" 2>/dev/null || echo "?")"
  log "db  ${src#$HOME/}  integrity=$ic  schema_version=$sv  ${count:+rows=$count}  sha256=$(shasum -a 256 "$dst" | cut -c1-16)"
  [ "$ic" = "ok" ] || FAIL=1
}

log "Parachute/Prism backup — $(date -u +%FT%TZ) — label=$LABEL"
log "hub   $(jq -r .version "$HOME/.bun/install/global/node_modules/@openparachute/hub/package.json")"
log "vault $(jq -r .version "$HOME/.bun/install/global/node_modules/@openparachute/vault/package.json")"
log "prism $(git -C "$PRISM" rev-parse --short HEAD) ($(git -C "$PRISM" branch --show-current))"
log ""

# Vault databases (one per vault)
for d in "$P"/vault/data/*/; do
  name="$(basename "$d")"
  [ -f "$d/vault.db" ] || continue
  snapshot_db "$d/vault.db" "$DEST/parachute/vault/data/$name/vault.db" "SELECT count(*) FROM notes;"
  [ -f "$d/vault.yaml" ] && cp -p "$d/vault.yaml" "$DEST/parachute/vault/data/$name/"
done

# Hub database (users, grants, signing keys, tokens, oauth clients)
snapshot_db "$P/hub.db" "$DEST/parachute/hub.db" "SELECT count(*) FROM tokens;"

# Prism server database (ACL grants, sessions, publications, governance, collab docs)
snapshot_db "$PRISM/apps/server/prism-server.db" "$DEST/prism/prism-server.db" ""

# Config, state and secrets (small files, plain copy)
copy() { [ -e "$1" ] && { mkdir -p "$DEST/$2"; cp -Rp "$1" "$DEST/$2/"; log "cfg ${1#$HOME/}"; } || true; }
for f in services.json expose-state.json cloudflared-state.json operator.token well-known cloudflared; do
  copy "$P/$f" parachute
done
for f in config.yaml .env start.sh server-path; do copy "$P/vault/$f" parachute/vault; done
copy "$HOME/Library/LaunchAgents/computer.parachute.hub.plist" launchd
for f in "$HOME"/Library/LaunchAgents/computer.parachute.cloudflared.*.plist; do copy "$f" launchd; done
copy "$HOME/.bun/install/global/package.json" bun-global
copy "$HOME/.bun/install/global/bun.lock" bun-global
copy "$HOME/Library/Application Support/prism/prism-config.json" prism
copy "$PRISM/apps/server/.env" prism
copy "$PRISM/.mcp.json" prism
pm2 jlist 2>/dev/null | jq '[.[] | {name, pm_exec_path: .pm2_env.pm_exec_path, cwd: .pm2_env.pm_cwd, args: .pm2_env.args}]' > "$DEST/prism/pm2-processes.json" || true

log ""
log "total $(du -sh "$DEST" | cut -f1)  →  $DEST"
if [ "$FAIL" -ne 0 ]; then
  log "INTEGRITY FAILURE — do not rely on this backup"
  exit 1
fi
log "all integrity checks ok"

# Retention (only after a verified backup): keep the newest $BACKUP_KEEP snapshots
# plus any whose label contains "baseline" or "keep" (pin a rollback point by
# naming it, e.g. `backup-parachute.sh pre-upgrade-baseline`). Each snapshot is
# ~850 MB, so per-deploy backups otherwise fill the disk (2026-10-01: 25 in 2 days).
# BACKUP_KEEP=0 disables pruning.
KEEP="${BACKUP_KEEP:-5}"
if [ "$KEEP" -gt 0 ]; then
  ROOT="$HOME/parachute-backups"
  n=0
  for d in $(ls -1 "$ROOT" | grep -E '^[0-9]{8}T[0-9]{6}Z-' | sort -r); do
    case "$d" in *baseline*|*keep*) continue ;; esac
    n=$((n + 1))
    if [ "$n" -gt "$KEEP" ] && [ "$ROOT/$d" != "$DEST" ]; then
      rm -rf -- "${ROOT:?}/$d" && log "pruned old backup $d"
    fi
  done
fi
