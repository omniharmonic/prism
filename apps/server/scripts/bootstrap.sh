#!/usr/bin/env bash
# Prism Server setup — generates strong secrets and writes apps/server/.env.
# Safe to read before running. Refuses to clobber an existing .env unless --force.
#
#   npm run setup            # interactive
#   npm run setup -- --force # overwrite an existing .env
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=".env"
FORCE="${1:-}"

if [[ -f "$ENV_FILE" && "$FORCE" != "--force" ]]; then
  echo "✗ $ENV_FILE already exists. Re-run with --force to overwrite (this rotates secrets)." >&2
  exit 1
fi

gen() { openssl rand -base64 "${1:-48}" | tr -d '\n'; }

echo "Prism Server setup — generating secrets and collecting config."
echo "(Press Enter to accept the [default].)"
echo

read -r -p "Public https origin (your tunnel hostname) [https://prism.example.com]: " APP_ORIGIN
APP_ORIGIN="${APP_ORIGIN:-https://prism.example.com}"

read -r -p "Owner email (full-access admin): " OWNER_EMAIL
while [[ -z "${OWNER_EMAIL:-}" || "$OWNER_EMAIL" != *@*.* ]]; do
  read -r -p "  Please enter a valid email: " OWNER_EMAIL
done

read -r -p "Parachute vault name [default]: " PARACHUTE_VAULT
PARACHUTE_VAULT="${PARACHUTE_VAULT:-default}"

echo "Mint a vault token with:"
echo "  parachute auth mint-token --scope vault:${PARACHUTE_VAULT}:write --expires-in 31536000"
read -r -p "Paste the Parachute vault token (PARACHUTE_TOKEN): " PARACHUTE_TOKEN
while [[ -z "${PARACHUTE_TOKEN:-}" ]]; do
  read -r -p "  Required. Paste the token: " PARACHUTE_TOKEN
done

read -r -p "Resend API key for emailed magic links/invites (optional, Enter to skip): " RESEND_API_KEY
MAGIC_FROM_DEFAULT="Prism <login@$(echo "$APP_ORIGIN" | sed -E 's#https?://[^.]+\.##; s#/.*##')>"
read -r -p "Magic-link From address [${MAGIC_FROM_DEFAULT}]: " MAGIC_FROM
MAGIC_FROM="${MAGIC_FROM:-$MAGIC_FROM_DEFAULT}"

SESSION_SECRET="$(gen 48)"
CAPABILITY_SECRET="$(gen 48)"
COLLAB_TOKEN="collab_$(openssl rand -base64 30 | tr '/+' '_-' | tr -d '=\n')"

umask 177  # .env created as 0600
cat > "$ENV_FILE" <<EOF
APP_ORIGIN=${APP_ORIGIN}
PORT=8787
PARACHUTE_URL=http://localhost:1940
PARACHUTE_VAULT=${PARACHUTE_VAULT}
PARACHUTE_TOKEN=${PARACHUTE_TOKEN}
SESSION_SECRET=${SESSION_SECRET}
CAPABILITY_SECRET=${CAPABILITY_SECRET}
COLLAB_TOKEN=${COLLAB_TOKEN}
OWNER_EMAIL=${OWNER_EMAIL}
RESEND_API_KEY=${RESEND_API_KEY}
MAGIC_FROM=${MAGIC_FROM}
DB_PATH=./prism-server.db
WEB_ROOT=../web/dist
EOF

echo
echo "✓ Wrote $ENV_FILE (chmod 600)."
echo
echo "NEXT — point the desktop app at this server (so its edits sync + it can share):"
echo "  Add to the desktop config (macOS: ~/Library/Application Support/prism/prism-config.json):"
echo "    \"collab_url\":   \"ws://localhost:8787/collab\","
echo "    \"collab_token\": \"${COLLAB_TOKEN}\""
echo
echo "Then: npm run build -w @prism/web && (cd apps/server && npm start)"
echo "Keep $ENV_FILE secret. Never commit it."
