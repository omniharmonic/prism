#!/usr/bin/env bash
# One-command vault clean-up for the Mac mini (approved by Benjamin 2026-10-08).
#
#   scripts/vault-hygiene/apply-all.sh                 # backup → every step: dry run, confirm, apply
#   scripts/vault-hygiene/apply-all.sh --i-have-a-backup /path/to/backup   # skip the backup step
#   scripts/vault-hygiene/apply-all.sh --from m-b      # resume at a step
#   scripts/vault-hygiene/apply-all.sh --only m-d      # one step
#   scripts/vault-hygiene/apply-all.sh --yes           # no confirmation prompts (still dry-runs first)
#   scripts/vault-hygiene/apply-all.sh --only m-g      # an OPTIONAL step: runs only when named (never by default, never with --from)
#
# Steps, in order (qa/vault-migrations.md):
#   schema   S1–S13 tag-schema corrections (apply-schema-fixes.ts --include-optional)
#   m-a      remove "" placeholders from list fields (+ empty scalar labels)
#   m-c-ff   trash identified duplicates — Fireflies inbox batch first
#   m-c      trash identified duplicates — everything else
#   m-b      repoint [[vault/projects/<slug>]] folder links to …/PROJECT
#   m-f      stored shapes lint still reports: numbers kept as text, blank fields removed,
#            one value / an unambiguous "a, b" turned into a list (never a guess)
#   m-e      Prism people-link job: dry run, then a CAPPED write run
#   m-d      untagged-notes report (writes nothing)
# Optional steps — NOT part of the approved order above; each runs only with `--only <step>`:
#   m-g      backfill the parent → sub-page link for sub-page rows saved before the server
#            wrote it (backfill-subpage-links.ts; links only, no body, no metadata)
#
# Every step stops the run on error and prints its undo command. Every write is
# compare-and-set; every migration logs what it replaced to an undo log in the
# run directory (0700). Tokens come from the macOS Keychain and are handed to the
# child processes through the environment only — never argv, never printed.
#
# Keychain items (create once, the value is PROMPTED for, never typed on a command line):
#   security add-generic-password -U -a "$USER" -s prism-parachute-token -w
#       → the vault:default:write token Prism already uses (PARACHUTE_TOKEN in apps/server/.env)
#   security add-generic-password -U -a "$USER" -s prism-owner-device-token -w
#       → a Prism owner device token (pd_…; Settings → Account → Signed-in devices / the Prism Client's)
# The schema step mints its own 1-hour admin token (`parachute auth mint-token … --ephemeral`);
# set the Keychain item prism-parachute-admin-token to use a stored one instead.
# Override service names with KC_PARACHUTE_TOKEN / KC_OWNER_TOKEN / KC_ADMIN_TOKEN.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VAULT_URL="${VAULT_URL:-http://127.0.0.1:1940}"
PRISM_URL="${PRISM_URL:-http://127.0.0.1:8787}"
VAULT_NAME="${VAULT_NAME:-default}"
RATE="${HYGIENE_RATE:-2}"
PEOPLE_LINK_CAP="${PEOPLE_LINK_CAP:-500}"
KC_PARACHUTE_TOKEN="${KC_PARACHUTE_TOKEN:-prism-parachute-token}"
KC_OWNER_TOKEN="${KC_OWNER_TOKEN:-prism-owner-device-token}"
KC_ADMIN_TOKEN="${KC_ADMIN_TOKEN:-prism-parachute-admin-token}"
STEPS=(schema m-a m-c-ff m-c m-b m-f m-e m-d)
# Run only by `--only <step>`: not in the approved order, so never part of a default or --from run.
OPTIONAL_STEPS=(m-g m-project-repair m-project-hygiene m-project-indexes)

BACKUP=""
FROM=""
ONLY=""
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --i-have-a-backup) BACKUP="${2:-}"; shift 2 || { echo "--i-have-a-backup needs the backup directory" >&2; exit 2; } ;;
    --from) FROM="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --yes) YES=1; shift ;;
    -h|--help) sed -n '2,36p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[ -z "$FROM" ] || printf '%s\n' "${STEPS[@]}" | grep -qx -- "$FROM" || { echo "unknown step '$FROM' (steps: ${STEPS[*]})" >&2; exit 2; }
[ -z "$ONLY" ] || printf '%s\n' "${STEPS[@]}" "${OPTIONAL_STEPS[@]}" | grep -qx -- "$ONLY" || { echo "unknown step '$ONLY' (steps: ${STEPS[*]}; optional, --only: ${OPTIONAL_STEPS[*]})" >&2; exit 2; }

die() { echo "✗ $*" >&2; exit 1; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ── 1. Refuse anywhere but the Mini ─────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "this runs on the Mac mini only (uname is $(uname -s))"
[ -f "$HOME/.parachute/vault/data/$VAULT_NAME/vault.db" ] || die "no local vault at ~/.parachute/vault/data/$VAULT_NAME — not the Mini's vault host"
curl -fsS -m 5 "$VAULT_URL/health" >/dev/null 2>&1 || curl -fsS -m 5 "$VAULT_URL/vault/$VAULT_NAME/api/health" >/dev/null 2>&1 \
  || die "the vault does not answer at $VAULT_URL"
command -v node >/dev/null && command -v jq >/dev/null && command -v security >/dev/null || die "needs node, jq and security on PATH"

# ── 2. Tokens (Keychain → environment of the child processes only) ─────────
kc() { security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null || security find-generic-password -s "$1" -w 2>/dev/null || true; }
PARACHUTE_TOKEN="${PARACHUTE_TOKEN:-$(kc "$KC_PARACHUTE_TOKEN")}"   # an already-exported token wins (an ssh session cannot read the Keychain)
[ -n "$PARACHUTE_TOKEN" ] || die "Keychain item '$KC_PARACHUTE_TOKEN' not found — create it: security add-generic-password -U -a \"\$USER\" -s $KC_PARACHUTE_TOKEN -w   (you will be prompted for the value)"
export PARACHUTE_TOKEN

RUN_DIR="$HOME/parachute-backups/vault-hygiene-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN_DIR" && chmod 700 "$RUN_DIR"
LOG="$RUN_DIR/run.log"
echo "run directory (undo logs + transcript): $RUN_DIR"

# ── 3. Backup (taken here unless one is named) ──────────────────────────────
if [ -n "$BACKUP" ]; then
  [ -d "$BACKUP" ] && [ -f "$BACKUP/MANIFEST.txt" ] || die "--i-have-a-backup: '$BACKUP' is not a backup-parachute.sh snapshot (no MANIFEST.txt)"
  grep -q "all integrity checks ok" "$BACKUP/MANIFEST.txt" || die "that backup did not pass its integrity checks"
  echo "using backup: $BACKUP"
else
  say "backup"
  BACKUP_KEEP="${BACKUP_KEEP:-5}" "$ROOT/scripts/backup-parachute.sh" "pre-vault-hygiene-keep" | tee -a "$LOG"
  BACKUP="$(ls -1d "$HOME"/parachute-backups/*-pre-vault-hygiene-keep 2>/dev/null | sort | tail -1)"
  [ -n "$BACKUP" ] && grep -q "all integrity checks ok" "$BACKUP/MANIFEST.txt" || die "backup failed — nothing was changed"
  echo "snapshot: $BACKUP"
fi
echo "ROLLBACK OF EVERYTHING = stop pm2 prism-server + the vault, restore $BACKUP/parachute/vault/data/$VAULT_NAME/vault.db and $BACKUP/prism/prism-server.db, start both" | tee -a "$LOG"

# ── helpers ──────────────────────────────────────────────────────────────────
HY=(node --import tsx)
COMMON=(--vault-url "$VAULT_URL" --vault "$VAULT_NAME" --production)
confirm() {
  [ "$YES" = 1 ] && return 0
  local a
  read -r -p "Apply this step? [y/N] " a </dev/tty || true
  [ "$a" = "y" ] || [ "$a" = "Y" ]
}
undo_hint=""
run_step() { # name, then the command; prints the undo hint and exits on failure
  local name="$1"; shift
  if ! "$@" 2>&1 | tee -a "$LOG"; then
    echo "✗ step $name failed — stopping. Nothing after it ran." >&2
    [ -n "$undo_hint" ] && echo "  undo: $undo_hint" >&2
    exit 1
  fi
}
want() { # should step $1 run?
  [ -n "$ONLY" ] && { [ "$ONLY" = "$1" ]; return; }
  [ -z "$FROM" ] && return 0
  local seen=0 s
  for s in "${STEPS[@]}"; do [ "$s" = "$FROM" ] && seen=1; [ "$s" = "$1" ] && { [ $seen = 1 ]; return; }; done
  return 1
}
migration() { # name, script, extra args…: dry run → confirm → apply with an undo log
  local name="$1" script="$2"; shift 2
  local undo="$RUN_DIR/undo-$name.jsonl"
  say "$name — dry run ($script)"
  undo_hint=""
  run_step "$name (dry run)" "${HY[@]}" "scripts/vault-hygiene/$script" "${COMMON[@]}" --rate "$RATE" "$@"
  if ! confirm; then echo "skipped $name"; return 0; fi
  say "$name — apply"
  undo_hint="node --import tsx scripts/vault-hygiene/undo.ts --log $undo ${COMMON[*]} [--prism-url $PRISM_URL]   (dry run; add --apply)"
  run_step "$name" "${HY[@]}" "scripts/vault-hygiene/$script" "${COMMON[@]}" --rate "$RATE" "$@" --undo-log "$undo" --apply --backup-confirmed
  echo "  undo log: $undo"
  echo "  undo:     $undo_hint"
}

# ── schema (S1–S13) ──────────────────────────────────────────────────────────
if want schema; then
  say "schema — dry run (diff against the live schema)"
  undo_hint=""
  run_step "schema (dry run)" "${HY[@]}" scripts/vault-hygiene/apply-schema-fixes.ts "${COMMON[@]}" --include-optional
  if confirm; then
    PARACHUTE_ADMIN_TOKEN="$(kc "$KC_ADMIN_TOKEN")"
    if [ -z "$PARACHUTE_ADMIN_TOKEN" ]; then
      command -v parachute >/dev/null || die "no admin token: install the parachute CLI or store Keychain item $KC_ADMIN_TOKEN"
      PARACHUTE_ADMIN_TOKEN="$(parachute auth mint-token --scope "vault:$VAULT_NAME:admin" --ephemeral 2>/dev/null | tail -1)"
    fi
    [ -n "$PARACHUTE_ADMIN_TOKEN" ] || die "could not get a vault admin token"
    export PARACHUTE_ADMIN_TOKEN
    say "schema — apply"
    undo_hint="PARACHUTE_ADMIN_TOKEN=… node --import tsx scripts/vault-hygiene/apply-schema-fixes.ts ${COMMON[*]} --include-optional --reverse --apply --backup-confirmed   (S12/S13 additions are removed by hand with the vault's tag tools)"
    run_step schema "${HY[@]}" scripts/vault-hygiene/apply-schema-fixes.ts "${COMMON[@]}" --include-optional --apply --backup-confirmed
    unset PARACHUTE_ADMIN_TOKEN
    echo "  undo: $undo_hint"
  fi
fi

want m-a && migration m-a migrate-empty-lists.ts --include-scalars

if want m-c-ff || want m-c; then
  PRISM_OWNER_TOKEN="$(kc "$KC_OWNER_TOKEN")"
  [ -n "$PRISM_OWNER_TOKEN" ] || die "Keychain item '$KC_OWNER_TOKEN' not found — create it: security add-generic-password -U -a \"\$USER\" -s $KC_OWNER_TOKEN -w"
  export PRISM_OWNER_TOKEN
  want m-c-ff && migration m-c-ff trash-duplicates.ts --path-prefix vault/_inbox/transcripts/fireflies/ --prism-url "$PRISM_URL"
  want m-c && migration m-c trash-duplicates.ts --prism-url "$PRISM_URL"
fi

want m-b && migration m-b migrate-project-folder-links.ts

want m-f && migration m-f migrate-field-shapes.ts

# ── M-e: Prism's own people-link job (admin API, owner device token) ────────
prism_api() { # METHOD PATH [JSON] — the bearer goes to curl on stdin, never argv
  printf 'header = "Authorization: Bearer %s"\n' "$PRISM_OWNER_TOKEN" |
    curl -fsS -m 60 -K - -X "$1" -H "Content-Type: application/json" ${3:+--data "$3"} "$PRISM_URL/api/admin/people/$2"
}
people_job() { # JSON body → waits, prints the counts-only summary
  local body="$1" st
  prism_api POST link "$body" >/dev/null || { echo "people-link request refused (is pm2 prism-server running, and is the token the server owner's?)" >&2; return 1; }
  for _ in $(seq 1 720); do
    st="$(prism_api GET link | jq -r '.job.status // "none"')"
    [ "$st" = "running" ] || break
    sleep 5
  done
  prism_api GET link | jq '{status: .job.status, dryRun: .job.dryRun, writes: .job.writes, capped: .job.capped, error: .job.error,
    report: ((.job.report // {}) | map_values({status, scanned, wouldLink, notesToWrite, alreadyLinked, linked, queued}))}'
  [ "$(prism_api GET link | jq -r '.job.status')" = "done" ]
}
if want m-e; then
  PRISM_OWNER_TOKEN="${PRISM_OWNER_TOKEN:-$(kc "$KC_OWNER_TOKEN")}"
  [ -n "$PRISM_OWNER_TOKEN" ] || die "Keychain item '$KC_OWNER_TOKEN' not found"
  say "m-e — people-link dry run (strong keys only, no names, nothing queued)"
  undo_hint=""
  run_step "m-e (dry run)" people_job '{"dryRun": true, "enqueue": false, "allowNameLinks": false}'
  if confirm; then
    say "m-e — write run, capped at $PEOPLE_LINK_CAP writes"
    undo_hint="links are additive and audited (action_audit); a whole rollback = restore the backup above. Re-run with --only m-e to continue a capped run."
    run_step m-e people_job "{\"dryRun\": false, \"enqueue\": false, \"allowNameLinks\": false, \"maxWrites\": $PEOPLE_LINK_CAP}"
    echo "  $undo_hint"
  fi
fi

# ── optional steps (only with --only) ───────────────────────────────────────
[ "$ONLY" = "m-g" ] && migration m-g backfill-subpage-links.ts
if [ "$ONLY" = "m-project-repair" ] || [ "$ONLY" = "m-project-indexes" ]; then
  PRISM_OWNER_TOKEN="${PRISM_OWNER_TOKEN:-$(kc "$KC_OWNER_TOKEN")}"
  [ -n "$PRISM_OWNER_TOKEN" ] || die "Keychain item '$KC_OWNER_TOKEN' not found"
  export PRISM_OWNER_TOKEN
fi
[ "$ONLY" = "m-project-repair" ] && migration m-project-repair project-pages.ts --phase repair --prism-url "$PRISM_URL"
[ "$ONLY" = "m-project-hygiene" ] && migration m-project-hygiene project-pages.ts --phase hygiene
if [ "$ONLY" = "m-project-indexes" ]; then
  [ "${PROJECT_LIVE_SECTIONS_CONFIRMED:-}" = "1" ] || die "deploy live project sections first, then set PROJECT_LIVE_SECTIONS_CONFIRMED=1"
  migration m-project-indexes project-pages.ts --phase indexes --live-sections-confirmed --prism-url "$PRISM_URL"
fi

if want m-d; then
  say "m-d — untagged notes report (writes nothing)"
  undo_hint=""
  run_step m-d "${HY[@]}" scripts/vault-hygiene/report-untagged.ts "${COMMON[@]}"
fi

say "done — transcript: $LOG"
echo "Next: VAULT_LINT_ENABLED=true in apps/server/.env, restart pm2 prism-server, and watch GET /acl/workers → vault-lint."
