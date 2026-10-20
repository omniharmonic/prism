#!/usr/bin/env bash
# Install the App Review demo server — run AS THE DEMO macOS USER on the demo host (README.md).
#
#   bash ~/demo-kit/install.sh [--dry-run]
#
# Idempotent: each step checks first and is skipped when it is already done, so run it again
# after the one step a person has to do (the Parachute admin password) and after any failure.
#
# What it sets up, all owned by the demo user and nothing shared with production:
#   1. the demo's own Parachute: PARACHUTE_HOME=$DEMO_PARACHUTE_HOME, hub on $DEMO_HUB_PORT,
#      vault "$DEMO_VAULT_NAME" on $DEMO_VAULT_PORT, loopback only, under the demo user's own
#      launchd agent ($DEMO_PARACHUTE_LABEL). Not `prism setup`'s stock mode: that mode only runs
#      Parachute on the default ports 1939/1940, which production uses — and `prism setup` would
#      find production's Parachute answering on :1940 and REUSE it. So the kit never runs
#      `prism setup`; it runs `prism install --parachute external` against this Parachute.
#   2. the stock-CLI issuer workaround: $DEMO_PARACHUTE_HOME/hub/run/hub.port = $DEMO_HUB_PORT
#      BEFORE any token is minted (stock `auth mint-token` reads the issuer from that file, which
#      `parachute serve` never writes; without it tokens name :1939 and the demo vault refuses them
#      — docs/host-bundle.md "Stock Parachute's issuer bug"; the compat suite does the same).
#   3. `prism install --prefix $DEMO_PREFIX --port $DEMO_SERVER_PORT --app-origin https://$DEMO_HOST`
#      → `prism token mint` (a vault write token straight into the demo's config/.env)
#      → `prism start`.
set -euo pipefail
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
  esac
done
# shellcheck source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
load_demo_env
guard_isolation
[ "$DRY_RUN" = 1 ] && echo "▶ DRY RUN: checks run, nothing is created, started or written"

[ -x "$DEMO_BUNDLE/bin/prism" ] || die "no host bundle at $DEMO_BUNDLE (unpack prism-host-<version>-darwin-arm64.tar.gz there)"
if [ ! -x "$PARACHUTE_BIN" ] || [ ! -x "$PARACHUTE_VAULT_BIN" ]; then die "stock Parachute is not installed for $DEMO_USER: curl -fsSL https://bun.sh/install | bash; ~/.bun/bin/bun add -g @openparachute/hub@0.7.19 @openparachute/vault@0.7.9"; fi
[ -n "$NODE" ] || die "no node: the bundle's runtime/node/bin/node is missing"

HUB="http://127.0.0.1:$DEMO_HUB_PORT"
VAULT="http://127.0.0.1:$DEMO_VAULT_PORT"
PRISM="$(prism_bin)"
PH="$DEMO_PARACHUTE_HOME"
pc() { run env PARACHUTE_HOME="$PH" PARACHUTE_HUB_ORIGIN="$HUB" PARACHUTE_HUB_JWKS_ORIGIN="$HUB" PARACHUTE_HUB_PORT="$DEMO_HUB_PORT" PARACHUTE_BIND_HOST=127.0.0.1 "$@"; }
agent_loaded() { launchctl print "gui/$(id -u)/$DEMO_PARACHUTE_LABEL" >/dev/null 2>&1; }
answers() { curl -fsS --max-time 2 -o /dev/null "$1"; }

# ── 1. ports: free, or already ours ──────────────────────────────────────────
if ! agent_loaded; then
  for p in "$DEMO_HUB_PORT" "$DEMO_VAULT_PORT"; do port_in_use "$p" && die "port $p is in use by something else (lsof -nP -iTCP:$p -sTCP:LISTEN)"; done
fi
if [ ! -f "$DEMO_PREFIX/.prism-host" ] && port_in_use "$DEMO_SERVER_PORT"; then die "port $DEMO_SERVER_PORT is in use by something else"; fi

# ── 2. the demo's Parachute home, its vault port and the issuer workaround ────
echo "▶ Parachute home $PH (hub $DEMO_HUB_PORT, vault $DEMO_VAULT_PORT)"
run mkdir -p "$PH/vault" "$PH/hub/run" "$PH/logs"
run chmod 700 "$PH" "$PH/vault" "$PH/hub" "$PH/hub/run" "$PH/logs"
if [ ! -f "$PH/vault/config.yaml" ]; then
  if [ "$DRY_RUN" = 1 ]; then echo "+ write $PH/vault/config.yaml (port: $DEMO_VAULT_PORT, autostart: false, embeddings_enabled: false; 0600)"
  else (umask 077; printf 'port: %s\nautostart: false\nembeddings_enabled: false\n' "$DEMO_VAULT_PORT" > "$PH/vault/config.yaml"); fi
fi
if [ "$(cat "$PH/hub/run/hub.port" 2>/dev/null || true)" != "$DEMO_HUB_PORT" ]; then
  if [ "$DRY_RUN" = 1 ]; then echo "+ write $PH/hub/run/hub.port = $DEMO_HUB_PORT (0600; the stock-CLI issuer workaround)"
  else (umask 077; printf '%s\n' "$DEMO_HUB_PORT" > "$PH/hub/run/hub.port"); fi
fi

# ── 3. the vault, and the admin (the one step a person does) ─────────────────
if [ ! -d "$PH/vault/data/$DEMO_VAULT_NAME" ]; then
  echo "▶ creating vault $DEMO_VAULT_NAME"
  pc PORT="$DEMO_VAULT_PORT" "$PARACHUTE_VAULT_BIN" create "$DEMO_VAULT_NAME" --no-mirror --json >/dev/null
fi
if [ ! -f "$PH/operator.token" ]; then
  echo
  echo "▶ ONE STEP FOR YOU: create the demo Parachute's admin (a password of its own — never production's):"
  echo "    PARACHUTE_HOME=\"$PH\" PARACHUTE_HUB_PORT=$DEMO_HUB_PORT \"$PARACHUTE_BIN\" auth set-password"
  echo "  then run this script again."
  [ "$DRY_RUN" = 1 ] || exit 12
fi
# The operator token must be issued by THIS hub (rotate once if it names another port).
if [ -f "$PH/operator.token" ]; then
  ISS="$("$NODE" -e 'const t=require("fs").readFileSync(process.argv[1],"utf8").trim().split(".")[1]||"";try{console.log(JSON.parse(Buffer.from(t,"base64url")).iss||"")}catch{console.log("")}' "$PH/operator.token")"
  if [ "$ISS" != "$HUB" ]; then
    echo "▶ operator token names '$ISS', not $HUB: rotating it"
    pc "$PARACHUTE_BIN" auth rotate-operator
  fi
fi

# ── 4. the demo's Parachute agent ────────────────────────────────────────────
PLIST="$HOME/Library/LaunchAgents/$DEMO_PARACHUTE_LABEL.plist"
RENDERED="$(sed -e "s#{{LABEL}}#$DEMO_PARACHUTE_LABEL#g" -e "s#{{PARACHUTE_BIN}}#$PARACHUTE_BIN#g" -e "s#{{PARACHUTE_HOME}}#$PH#g" \
  -e "s#{{HUB_PORT}}#$DEMO_HUB_PORT#g" -e "s#{{VAULT_PORT}}#$DEMO_VAULT_PORT#g" -e "s#{{HOME}}#$HOME#g" -e "s#{{LOG_DIR}}#$PH/logs#g" "$KIT/parachute.plist.in")"
if [ "$(cat "$PLIST" 2>/dev/null || true)" != "$RENDERED" ]; then
  if [ "$DRY_RUN" = 1 ]; then echo "+ write $PLIST (0644, from parachute.plist.in)"
  else mkdir -p "$HOME/Library/LaunchAgents"; printf '%s\n' "$RENDERED" > "$PLIST"; chmod 644 "$PLIST"; fi
  if agent_loaded; then run launchctl bootout "gui/$(id -u)/$DEMO_PARACHUTE_LABEL"; fi
fi
agent_loaded || run launchctl bootstrap "gui/$(id -u)" "$PLIST"
if [ "$DRY_RUN" = 0 ]; then
  echo "▶ waiting for the demo hub and vault…"
  for _ in $(seq 1 60); do answers "$HUB/health" && answers "$VAULT/health" && break; sleep 1; done
  answers "$HUB/health" || die "the demo hub does not answer on $HUB (see $PH/logs/demo-parachute.log)"
  answers "$VAULT/health" || die "the demo vault does not answer on $VAULT (see $PH/logs/demo-parachute.log)"
fi

# ── 5. Prism, from the host bundle, against that Parachute ───────────────────
if [ ! -f "$DEMO_PREFIX/.prism-host" ]; then
  echo "▶ prism install → $DEMO_PREFIX"
  run "$DEMO_BUNDLE/bin/prism" install --prefix "$DEMO_PREFIX" --owner-email "$DEMO_OWNER_EMAIL" \
    --port "$DEMO_SERVER_PORT" --app-origin "https://$DEMO_HOST" \
    --parachute external --parachute-url "$VAULT" --parachute-vault "$DEMO_VAULT_NAME" --parachute-hub-origin "$HUB" \
    --parachute-bin "$PARACHUTE_BIN" --parachute-vault-bin "$PARACHUTE_VAULT_BIN" --parachute-home "$PH" \
    --no-start --no-signin
  PRISM="$DEMO_PREFIX/bin/prism"
fi
ENVF="$DEMO_PREFIX/config/.env"
# A small footprint beside production on the same Mac (one conversion thread, a smaller heap).
for kv in CONVERT_THREADS=1 CONVERT_HEAP_MB=384; do
  if [ "$DRY_RUN" = 1 ]; then echo "+ add ${kv} to $ENVF unless it is set"
  elif ! grep -q "^${kv%%=*}=" "$ENVF"; then printf '%s\n' "$kv" >> "$ENVF"; fi
done
if [ "$DRY_RUN" = 1 ] || ! "$PRISM" token status --prefix "$DEMO_PREFIX" >/dev/null 2>&1; then
  echo "▶ vault token (minted by the demo Parachute straight into $ENVF; never shown)"
  run "$PRISM" token mint --prefix "$DEMO_PREFIX"
fi
echo "▶ starting the demo server"
run "$PRISM" start --prefix "$DEMO_PREFIX"
run "$NODE" "$KIT/seed.mjs" --prefix "$DEMO_PREFIX" --dry-run

echo
echo "Next: the tunnel (cloudflared.yml.template → https://$DEMO_HOST), then: bash $KIT/reset.sh"
echo "(reset.sh seeds the sample pages and prints the App Review password once)."
