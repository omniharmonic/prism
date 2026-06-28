---
name: Prism Setup — Server
description: "Provision the Prism Server: write apps/server/.env (secrets generated, chmod 600) via the prism-setup.ts script, seed tag schemas, render .mcp.json, build the web PWA, and start the server. Optionally generate a stable PEER_SIGNING_KEY for federation. Verifies with typecheck + verify-gateway.ts."
version: 0.1.0
---

# Prism Setup — Server (.env + run)

Provision `apps/server/.env` and get the gateway running. This wraps the
existing `prism-setup.ts` script (which generates secrets, writes `.env` chmod
600, seeds tag schemas, and renders `.mcp.json`) with a conversational layer.
**Step 2** — needs the vault + `PARACHUTE_TOKEN` from `prism-setup-vault`.

## When to use

After the vault step, or standalone to (re)provision the server.

## Steps

1. **Preview** (no writes), then run for real, from the repo root:
   ```bash
   cd apps/server
   node --import tsx scripts/prism-setup.ts --dry-run    # preview the .env + seed plan
   node --import tsx scripts/prism-setup.ts              # write .env, seed, render .mcp.json
   ```
   (Or `npm run setup` from the repo root — it calls `setup:full` in the server
   workspace.) Use `--force` only to **rotate** secrets on an existing `.env`.
   The script prompts for `APP_ORIGIN`, `OWNER_EMAIL`, `PARACHUTE_URL`,
   `PARACHUTE_VAULT`, `PARACHUTE_TOKEN`, optional `RESEND_API_KEY` / `MAGIC_FROM`.
   It generates `SESSION_SECRET` / `CAPABILITY_SECRET` / `COLLAB_TOKEN`.
2. **Federation (only on explicit opt-in).** If the user wants hub-to-hub
   federation, generate a **stable** Ed25519 identity and append it:
   ```bash
   cd apps/server && node --import tsx -e \
     "import {generateKeyPairB64url} from './src/auth/peer.ts'; console.log(generateKeyPairB64url())"
   # add to .env:  PEER_SIGNING_KEY=<privateKeyB64url>   and   FEDERATION_ENABLED=true
   ```
   Without `PEER_SIGNING_KEY` the server uses an **ephemeral** identity that
   changes on restart (pairings won't survive). Leave federation **off** by
   default — see `docs/roadmap/handoff/FEDERATION-TWO-HUB-HANDOFF.md`.
3. **Build the web PWA** (the server serves it), then **start**:
   ```bash
   npm run build -w @prism/web            # → apps/web/dist
   cd apps/server && npm run dev          # or: npm start
   ```

## Config artifact

`apps/server/.env` (chmod 600). Required: `PARACHUTE_TOKEN`, `SESSION_SECRET`,
`CAPABILITY_SECRET`, `OWNER_EMAIL`, `APP_ORIGIN`; plus `PARACHUTE_URL`,
`PARACHUTE_VAULT`, `COLLAB_TOKEN`; optional `RESEND_API_KEY`, `MAGIC_FROM`,
`FEDERATION_ENABLED`, `PEER_SIGNING_KEY`, `WEB_ROOT`, `DB_PATH`. Validated by
`apps/server/src/config.ts` → `assertConfig()` (fails fast on a missing secret).

## Verify (pass / fail)

- `cd apps/server && npm run typecheck` → clean.
- Server starts with **no `assertConfig()` throw**.
- `curl -fsS http://localhost:8787/` returns the PWA `index.html`.
- Security e2e (self-provisioning, safe on any vault):
  ```bash
  cd apps/server && node --env-file=.env --import tsx scripts/verify-gateway.ts
  ```
  → `ALL GATEWAY CHECKS PASSED`.
- **FAIL:** `assertConfig` throws ⇒ a required key is missing/empty in `.env`.

## Note

Restart the server after any change — it compiles via tsx on start but does
**not** hot-reload.
