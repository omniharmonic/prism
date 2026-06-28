#!/usr/bin/env bash
# two-hub-up.sh — bring up an ISOLATED second Prism stack (Hub B) for the live
# federation convergence test (verify-two-hub.ts / GAP 3).
#
#   ⚠️  This stands up a SECOND local stack. It does NOT touch the live default
#       vault: Hub B reads/writes a SEPARATE Parachute vault ("fed-b") with its
#       own token, its own Prism Server DB (prism-b.db), and its own port (8788).
#       Nothing here mutates the default vault or the running prism-server.
#
# Idempotent: safe to re-run. Each phase checks state and skips if already done.
# It prints every step. Token minting may require you to paste a value (like
# prism-setup) if the CLI can't be captured non-interactively.
#
#   cd apps/server
#   bash scripts/two-hub-up.sh                 # provision .env.b + vault, then start Hub B (foreground)
#   bash scripts/two-hub-up.sh --provision-only# write .env.b + ensure vault, do NOT start the server
#   bash scripts/two-hub-up.sh --bg            # start Hub B in the background (logs → prism-b.log)
#   bash scripts/two-hub-up.sh --force         # rotate .env.b secrets (regenerates keys/token)
#
# After Hub B is up, in another terminal run the harness:
#   cd apps/server && node --import tsx scripts/verify-two-hub.ts
#
# ── Topology note ────────────────────────────────────────────────────────────
# Parachute 0.7.x is HUB-CENTRIC: one hub serves many vaults by NAME on one port
# (/vault/<name>/api). So "Hub B's vault" is a second vault ("fed-b") on the SAME
# running hub — a fully independent NOTE SET with its own token, which is all the
# convergence test needs (two distinct vaults, two Prism Servers). The harness
# only ever talks to the two Prism Servers (:8787 / :8788), never the hub
# directly, so the vault port is irrelevant to it.
#
# For STRICTER network isolation matching the handoff's original 2939/2940
# topology, run a second hub on its own data dir + port and set
# PARACHUTE_URL=http://localhost:2940 in .env.b instead (see the commented block
# near the vault step). The rest of this script is unchanged.

set -euo pipefail
cd "$(dirname "$0")/.."   # → apps/server

ENV_FILE=".env.b"
VAULT_NAME="${FED_B_VAULT:-fed-b}"
HUB_URL="${FED_B_PARACHUTE_URL:-http://localhost:1940}"   # same hub, different vault
PORT="${FED_B_PORT:-8788}"
OWNER_EMAIL_B="${FED_B_OWNER:-ownerB@example.com}"
DB_PATH_B="./prism-b.db"

PROVISION_ONLY=0
BG=0
FORCE=0
for a in "$@"; do
  case "$a" in
    --provision-only) PROVISION_ONLY=1 ;;
    --bg) BG=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

# ── 0. tooling ───────────────────────────────────────────────────────────────
step "0. Checking tooling (parachute, node, openssl)"
command -v parachute-vault >/dev/null || { echo "✗ parachute-vault not found in PATH" >&2; exit 1; }
command -v node            >/dev/null || { echo "✗ node not found" >&2; exit 1; }
command -v openssl         >/dev/null || { echo "✗ openssl not found" >&2; exit 1; }
echo "  parachute: $(parachute --version 2>/dev/null || echo '?'), node: $(node --version)"

# ── 1. ensure the fed-b vault exists + obtain a write token ───────────────────
step "1. Ensuring isolated vault '${VAULT_NAME}' + write token"
# A second hub on :2940 (strict isolation) would look like, in a separate shell:
#   PARACHUTE_DATA_DIR=~/.parachute-b parachute serve --port 2940   # (see `parachute serve --help`)
# then set HUB_URL=http://localhost:2940 above. We default to the same hub below.
PARACHUTE_TOKEN_B=""
if parachute-vault list 2>/dev/null | grep -qw "${VAULT_NAME}"; then
  echo "  vault '${VAULT_NAME}' already exists — minting a fresh write token"
  PARACHUTE_TOKEN_B="$(parachute auth mint-token --scope "vault:${VAULT_NAME}:write" --expires-in 31536000 2>/dev/null | tr -d '\n' || true)"
else
  echo "  creating vault '${VAULT_NAME}' (--mint --scope write, --no-mirror for a clean sandbox)"
  # --json emits { name, token, ... }; capture the token if we can.
  CREATE_JSON="$(parachute-vault create "${VAULT_NAME}" --mint --scope write --no-mirror --json 2>/dev/null || true)"
  PARACHUTE_TOKEN_B="$(printf '%s' "$CREATE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).token||"")}catch{}})' 2>/dev/null || true)"
fi
# Paste fallback (mirrors prism-setup) if we could not capture a token.
if [ -z "${PARACHUTE_TOKEN_B}" ]; then
  echo "  Could not capture a token automatically. Mint one and paste it:"
  echo "    parachute auth mint-token --scope vault:${VAULT_NAME}:write --expires-in 31536000"
  read -r -p "  Paste PARACHUTE_TOKEN for ${VAULT_NAME}: " PARACHUTE_TOKEN_B
fi
[ -n "${PARACHUTE_TOKEN_B}" ] || { echo "✗ no vault token — aborting" >&2; exit 1; }
echo "  token acquired (${#PARACHUTE_TOKEN_B} chars)"

# ── 2. generate Hub B secrets (incl. a STABLE PEER_SIGNING_KEY) ───────────────
step "2. Generating Hub B secrets"
if [ -f "${ENV_FILE}" ] && [ "${FORCE}" -ne 1 ]; then
  echo "  ${ENV_FILE} exists — keeping its secrets (re-run with --force to rotate)."
else
  [ -f "${ENV_FILE}" ] && cp "${ENV_FILE}" "${ENV_FILE}.bak.$(date +%s)" && echo "  backed up existing ${ENV_FILE}"
  gen() { openssl rand -base64 "${1:-48}" | tr -d '\n'; }
  SESSION_SECRET="$(gen 48)"
  CAPABILITY_SECRET="$(gen 48)"
  COLLAB_TOKEN="collab_$(openssl rand -base64 30 | tr '/+' '_-' | tr -d '=\n')"
  # PEER_SIGNING_KEY: the exact generator the server uses (pkcs8 DER, base64url).
  PEER_SIGNING_KEY="$(node --import tsx -e 'import("./src/auth/peer.ts").then(m=>process.stdout.write(m.generateKeyPairB64url().privateKeyB64url))')"
  [ -n "${PEER_SIGNING_KEY}" ] || { echo "✗ failed to generate PEER_SIGNING_KEY" >&2; exit 1; }

  umask 177  # .env.b → 0600
  cat > "${ENV_FILE}" <<EOF
# Hub B — ISOLATED second Prism stack for the federation convergence test.
# Generated by scripts/two-hub-up.sh. Distinct from .env in EVERY secret + port.
APP_ORIGIN=http://localhost:${PORT}
PORT=${PORT}
PARACHUTE_URL=${HUB_URL}
PARACHUTE_VAULT=${VAULT_NAME}
PARACHUTE_TOKEN=${PARACHUTE_TOKEN_B}
SESSION_SECRET=${SESSION_SECRET}
CAPABILITY_SECRET=${CAPABILITY_SECRET}
COLLAB_TOKEN=${COLLAB_TOKEN}
OWNER_EMAIL=${OWNER_EMAIL_B}
DB_PATH=${DB_PATH_B}
# Stable Ed25519 federation identity (PKCS8 DER, base64url). REQUIRED — an unset
# key means an ephemeral identity that breaks pairing on restart (auth/peer.ts).
PEER_SIGNING_KEY=${PEER_SIGNING_KEY}
FEDERATION_ENABLED=true
EOF
  echo "  wrote ${ENV_FILE} (0600)"
fi
# Always refresh the token in an existing file (tokens are short-rotation).
if [ -f "${ENV_FILE}" ] && [ "${FORCE}" -ne 1 ]; then
  # Replace the PARACHUTE_TOKEN line in place (portable sed).
  tmp="$(mktemp)"; awk -v t="PARACHUTE_TOKEN=${PARACHUTE_TOKEN_B}" '/^PARACHUTE_TOKEN=/{print t;next}{print}' "${ENV_FILE}" > "$tmp" && mv "$tmp" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "  refreshed PARACHUTE_TOKEN in ${ENV_FILE}"
fi

# ── 3. fingerprint sanity ─────────────────────────────────────────────────────
step "3. Hub B federation identity"
PEER_PRIV="$(awk -F= '/^PEER_SIGNING_KEY=/{print $2}' "${ENV_FILE}")"
node -e "
  const crypto=require('node:crypto');
  const priv=crypto.createPrivateKey({key:Buffer.from('${PEER_PRIV}','base64url'),format:'der',type:'pkcs8'});
  const pub=crypto.createPublicKey(priv).export({format:'der',type:'spki'});
  const hex=crypto.createHash('sha256').update(pub).digest('hex').slice(0,16);
  console.log('  pubkey  ', pub.toString('base64url').slice(0,24)+'…');
  console.log('  fingerprint', (hex.match(/.{2}/g)||[]).join(':'));
" || true

if [ "${PROVISION_ONLY}" -eq 1 ]; then
  step "Provision-only: done. Start Hub B with:"
  echo "  node --env-file=${ENV_FILE} --import tsx src/index.ts"
  exit 0
fi

# ── 4. start Hub B ────────────────────────────────────────────────────────────
step "4. Starting Hub B Prism Server on :${PORT}"
if curl -sf "http://localhost:${PORT}/auth/me" >/dev/null 2>&1 || curl -s "http://localhost:${PORT}/auth/me" >/dev/null 2>&1; then
  echo "  something already responds on :${PORT} — assuming Hub B is up. Skipping start."
  exit 0
fi

if [ "${BG}" -eq 1 ]; then
  echo "  launching in background → prism-b.log"
  nohup node --env-file="${ENV_FILE}" --import tsx src/index.ts >prism-b.log 2>&1 &
  echo "  PID $!  (tail -f prism-b.log)"
  for i in $(seq 1 40); do
    if curl -s "http://localhost:${PORT}/auth/me" >/dev/null 2>&1; then echo "  Hub B is up on :${PORT}"; break; fi
    sleep 0.5
  done
  echo "  Next: node --import tsx scripts/verify-two-hub.ts"
else
  echo "  foreground (Ctrl-C to stop — handy for the AC-9 offline test)."
  echo "  Run the harness in ANOTHER terminal: node --import tsx scripts/verify-two-hub.ts"
  exec node --env-file="${ENV_FILE}" --import tsx src/index.ts
fi
