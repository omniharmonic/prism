#!/usr/bin/env bash
# Shared by the demo-server scripts: settings, the dry-run printer, and the isolation guards.
# Sourced, never run.

# shellcheck disable=SC2034  # variables are used by the scripts that source this file
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_ENV="${DEMO_ENV:-$HOME/demo.env}"
DRY_RUN="${DRY_RUN:-0}"
PRODUCTION_PORTS="1939 1940 8787"

die() { echo "REFUSED: $*" >&2; exit 4; }

# Print a command (dry run) or run it. The plan goes to fd 3 (= stdout), so a redirect on the
# command itself (`run … >/dev/null`) never hides a line of the plan.
exec 3>&1
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+' >&3
    printf ' %q' "$@" >&3
    printf '\n' >&3
  else
    "$@"
  fi
}

load_demo_env() {
  [ -f "$DEMO_ENV" ] || die "no $DEMO_ENV — copy $KIT/demo.env.example there and fill it in"
  # shellcheck source=/dev/null
  . "$DEMO_ENV"
  : "${DEMO_USER:?}" "${DEMO_PREFIX:?}" "${DEMO_SERVER_PORT:?}" "${DEMO_HUB_PORT:?}" "${DEMO_VAULT_PORT:?}" "${DEMO_VAULT_NAME:?}"
  : "${DEMO_HOST:?}" "${DEMO_OWNER_EMAIL:?}" "${DEMO_REVIEWER_EMAIL:?}" "${DEMO_PARACHUTE_LABEL:?}"
  : "${DEMO_PARACHUTE_HOME:?}" "${DEMO_BUNDLE:?}" "${PARACHUTE_BIN:?}" "${PARACHUTE_VAULT_BIN:?}"
  NODE="$DEMO_BUNDLE/runtime/node/bin/node"
  [ -x "$NODE" ] || NODE="$(command -v node || true)"
  # The stock Parachute CLIs start with `#!/usr/bin/env bun`. Bun's installer puts ~/.bun/bin on
  # the PATH only in ~/.zshrc, which a non-interactive shell (ssh host 'cmd') never reads.
  PATH="$(dirname "$PARACHUTE_BIN"):$PATH"
  export PATH DEMO_REVIEWER_EMAIL DEMO_REVIEWER_NAME
}

# Stock hub 0.7.x snaps every first-party module back to its compiled-in "canonical" port
# before spawning it (serve-boot.ts reconcilePortToCanonical, channel#41) — for the vault that is
# 1940, PRODUCTION's port — unless ANOTHER row of the same services.json already holds that port.
# It never looks at what is listening on the machine. So the demo's services.json carries a
# placeholder row on the canonical vault port: no installDir and no first-party name (the
# supervisor skips it, "no-spec"), and NO paths (the hub never proxies anything to it).
# Prints "changed" when it had to write the file.
CANONICAL_VAULT_PORT=1940
RESERVATION_ROW=prism-demo-port-reservation
reserve_canonical_vault_port() {
  local manifest="$DEMO_PARACHUTE_HOME/services.json"
  if [ "$DRY_RUN" = 1 ]; then
    echo "+ ensure $manifest reserves the canonical vault port ($CANONICAL_VAULT_PORT, row '$RESERVATION_ROW': no paths, nothing started there) and keeps parachute-vault on :$DEMO_VAULT_PORT" >&3
    return 0
  fi
  "$NODE" -e '
    const fs = require("fs");
    const [path, row, canon, vaultPort] = process.argv.slice(1);
    let m = { services: [] };
    if (fs.existsSync(path)) m = JSON.parse(fs.readFileSync(path, "utf8"));
    if (!Array.isArray(m.services)) throw new Error(path + ": no services array");
    const before = JSON.stringify(m);
    // Anything else on the canonical port would be the vault itself, snapped there earlier.
    m.services = m.services.filter((s) => s.name === row || s.port !== Number(canon) || s.name === "parachute-vault");
    for (const s of m.services) if (s.name === "parachute-vault") s.port = Number(vaultPort);
    const reservation = { name: row, port: Number(canon), paths: [], health: "/__" + row, version: "0",
      displayName: "Reserved: the canonical vault port, so the demo vault stays on its own (Prism demo kit)" };
    m.services = m.services.filter((s) => s.name !== row).concat([reservation]);
    if (JSON.stringify(m) === before) process.exit(0);
    fs.writeFileSync(path + ".tmp", JSON.stringify(m, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(path + ".tmp", path);
    console.log("changed");
  ' "$manifest" "$RESERVATION_ROW" "$CANONICAL_VAULT_PORT" "$DEMO_VAULT_PORT"
}

# True when THIS user listens on a production port (the check `lsof -u` alone would not make:
# without -a, lsof ORs its filters).
listens_on_production_port() {
  local p
  for p in $PRODUCTION_PORTS; do
    lsof -a -nP -u "$(id -un)" -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  done
  return 1
}

# The guards every script runs before it changes anything.
#  - the demo user, a Standard (non-admin) account: it cannot read the production user's
#    folders, and the production user's launchd agents are in another gui/<uid> domain;
#  - its own ports, none of production's, distinct, and (for install) free;
#  - its own prefix: absolute, inside the demo user's home, never ~/.parachute or the
#    default production prefix (~/Library/Application Support/Prism/Host);
#  - a public https name of its own.
guard_isolation() {
  local me
  me="$(id -un)"
  [ "$me" = "$DEMO_USER" ] || die "run this as the demo macOS user '$DEMO_USER' (you are '$me'): log in to that user and use its own Terminal (launchd needs its GUI session)"
  if [ "${DEMO_ALLOW_ADMIN:-0}" != 1 ] && dseditgroup -o checkmember -m "$me" admin >/dev/null 2>&1; then
    die "'$me' is an administrator; the demo user must be a Standard account (System Settings → Users & Groups)"
  fi
  case "$DEMO_PREFIX" in
    "$HOME"/*) ;;
    *) die "DEMO_PREFIX ($DEMO_PREFIX) must be inside $HOME" ;;
  esac
  case "$DEMO_PREFIX" in
    "$HOME/.parachute"*|"$HOME/Library/Application Support/Prism/Host") die "DEMO_PREFIX must be a folder of its own, not $DEMO_PREFIX" ;;
  esac
  case "$DEMO_PARACHUTE_HOME" in
    "$HOME"/*) ;;
    *) die "DEMO_PARACHUTE_HOME ($DEMO_PARACHUTE_HOME) must be inside $HOME" ;;
  esac
  case "$DEMO_PARACHUTE_HOME" in
    "$HOME/.parachute"|"$HOME/.parachute/"*|"$DEMO_PREFIX"|"$DEMO_PREFIX/"*) die "DEMO_PARACHUTE_HOME must be its own folder (not ~/.parachute, not inside DEMO_PREFIX)" ;;
  esac
  local p seen=""
  for p in "$DEMO_SERVER_PORT" "$DEMO_HUB_PORT" "$DEMO_VAULT_PORT"; do
    case "$p" in ''|*[!0-9]*) die "port '$p' is not a number" ;; esac
    if [ "$p" -lt 1024 ] || [ "$p" -gt 65535 ]; then die "port $p is out of range"; fi
    case " $PRODUCTION_PORTS " in *" $p "*) die "port $p is a PRODUCTION port ($PRODUCTION_PORTS)" ;; esac
    case " $seen " in *" $p "*) die "port $p is used twice" ;; esac
    seen="$seen $p"
  done
  case "$DEMO_HOST" in
    *.*) ;;
    *) die "DEMO_HOST ($DEMO_HOST) must be a public DNS name" ;;
  esac
  case "$DEMO_HOST" in *[!a-z0-9.-]*) die "DEMO_HOST must be a lowercase DNS name" ;; esac
}

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

prism_bin() {
  if [ -x "$DEMO_PREFIX/bin/prism" ]; then echo "$DEMO_PREFIX/bin/prism"; else echo "$DEMO_BUNDLE/bin/prism"; fi
}
