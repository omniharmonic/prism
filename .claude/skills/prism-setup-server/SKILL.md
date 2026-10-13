---
name: Prism Setup — Server
description: "Provision the Prism Server: write apps/server/.env (secrets generated, chmod 600) via the prism-setup.ts script, seed tag schemas, render .mcp.json, build the web PWA, and start the server. Optionally generate a stable PEER_SIGNING_KEY for federation. Verifies with typecheck + verify-gateway.ts."
version: 0.3.0
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
   # On vault ≥0.7.1 the seed step mints a 1h vault:<name>:admin token via the
   # operator CLI (schema writes are admin-only there); set PARACHUTE_ADMIN_TOKEN
   # to supply one yourself. See prism-setup-schema.
   ```
   (Or `npm run setup` from the repo root — it calls `setup:full` in the server
   workspace.) Use `--force` only to **rotate** secrets on an existing `.env`.
   The script prompts for `APP_ORIGIN`, `OWNER_EMAIL`, `PARACHUTE_URL`,
   `PARACHUTE_VAULT`, `PARACHUTE_TOKEN`, optional `RESEND_API_KEY` / `MAGIC_FROM`.
   It generates `SESSION_SECRET` / `CAPABILITY_SECRET` / `COLLAB_TOKEN` /
   `GOVERNANCE_SIGNING_SECRET` / `SECRETS_KEY`. An existing
   `GOVERNANCE_SIGNING_SECRET` and `SECRETS_KEY` are kept even with `--force`.
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

## Secure storage (checklist step `secrets`)

`SECRETS_KEY` encrypts every stored connection (Matrix, email, transcripts, …).
Without it no integration can be connected. A fresh run of the script writes
one. On a server set up before the script did:

```bash
cd apps/server
grep -q '^SECRETS_KEY=.' .env || printf 'SECRETS_KEY=%s\n' "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" >> .env
```

then restart the server. **Add it only when it is missing. Never replace one
that is there:** every stored connection would become unreadable.

## First sign-in (checklist step `owner`)

The owner signs in with a link sent to `OWNER_EMAIL`: open the server's address,
choose "Owner? Email me a sign-in link". Without `RESEND_API_KEY` the link is
not emailed; it is printed in the server's log. Read it there and open it on the
same computer.

## Email (checklist step `email`, optional)

`RESEND_API_KEY` and `MAGIC_FROM` make sign-in links and invitations arrive by
email. Creating the Resend key and verifying the sending domain are the
person's actions. Without them everything still works through the server log.

## Config artifact

`apps/server/.env` (chmod 600). Required: `PARACHUTE_TOKEN`, `SESSION_SECRET`,
`CAPABILITY_SECRET`, `OWNER_EMAIL`, `APP_ORIGIN`; plus `PARACHUTE_URL`,
`PARACHUTE_VAULT`, `COLLAB_TOKEN`, `SECRETS_KEY`; optional `RESEND_API_KEY`, `MAGIC_FROM`,
`FEDERATION_ENABLED`, `PEER_SIGNING_KEY`, `WEB_ROOT`, `DB_PATH`. Validated by
`apps/server/src/config.ts` → `assertConfig()` (fails fast on a missing secret).

## Verify (pass / fail)

- `cd apps/server && npm run typecheck` → clean.
- Server starts with **no `assertConfig()` throw**.
- `curl -fsS http://localhost:8787/` returns the PWA `index.html`.
- `curl -fsS http://localhost:8787/api/version` answers the server's release.
- Signed in as the owner, **Workspace settings → Server** shows the setup
  checklist with every "Your workspace" step ticked.
- Security e2e (self-provisioning, safe on any vault):
  ```bash
  cd apps/server && node --env-file=.env --import tsx scripts/verify-gateway.ts
  ```
  → `ALL GATEWAY CHECKS PASSED`.
- **FAIL:** `assertConfig` throws ⇒ a required key is missing/empty in `.env`.

## Note

Restart the server after any change — it compiles via tsx on start but does
**not** hot-reload.
