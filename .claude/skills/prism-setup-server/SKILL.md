---
name: Prism Setup — Server
description: "The `machine`, `install`, `secrets`, `server` and `owner` steps of `prism setup` (host bundle: the CLI does them), plus the checkout path (apps/server/.env via prism-setup.ts, npm run dev), secure storage, the owner's first sign-in, optional email, and federation's stable key."
version: 0.4.0
---

# Prism Setup — Server

## Host install: steps of `prism setup`

With the host bundle (`prism-host-<version>-darwin-arm64.tar.gz`), these steps are done by
`prism setup --json` (the `prism-setup` skill drives it). Re-run from one with `--from <id>`.

| Step | What it checks | What it does when needed |
|---|---|---|
| `machine` | `prism doctor`: macOS 14+, Apple silicon, not root, the port free, 2 GB free | nothing — a failure is said as it is (`failed`, exit 4) |
| `install` | a host install exists at the prefix | `prism install --owner-email <email> --no-start --no-signin`: folders 0700, `.env` 0600 with fresh secrets, the launchd agent written but not started. The first run needs `--owner-email`: ask the person which address the owner account uses (a sign-in name, not a secret). |
| `secrets` | every generated secret is in `.env` | adds the missing ones; an existing value is never replaced |
| `server` | the server answers `/health?live=1` and its version | `prism start` (or `restart` when `.env` changed in this run) and waits for health; `failed` → `prism logs --lines 50` |
| `owner` | the checklist's `owner` step (the owner has a password) | opens a one-time sign-in link in the browser on this Mac (`prism signin`); the person signs in and sets a password |

The CLI writes the `.env` itself (`~/Library/Application Support/Prism/Host/config/.env`,
0600); you never edit it by hand and never see a secret. Restart and status are `prism restart`,
`prism status --json`, `prism logs` — never npm or pm2. Commands and exit codes:
`docs/host-bundle.md`.

## Checkout: `apps/server/.env` by hand

When developing from a clone of this repository (no `prism` command):

1. **Preview** (no writes), then run for real:
   ```bash
   cd apps/server
   node --import tsx scripts/prism-setup.ts --dry-run    # preview the .env + seed plan
   node --import tsx scripts/prism-setup.ts              # write .env, seed, render .mcp.json
   ```
   (Or `npm run setup` from the repo root.) It prompts for `APP_ORIGIN`, `OWNER_EMAIL`,
   `PARACHUTE_URL`, `PARACHUTE_VAULT`, `PARACHUTE_TOKEN` and optional `RESEND_API_KEY` /
   `MAGIC_FROM`, and generates `SESSION_SECRET` / `CAPABILITY_SECRET` / `COLLAB_TOKEN` /
   `GOVERNANCE_SIGNING_SECRET` / `SECRETS_KEY` (an existing `GOVERNANCE_SIGNING_SECRET` and
   `SECRETS_KEY` are kept even with `--force`). The person runs it and pastes the vault token at
   its prompt; never take a token in this conversation. On vault ≥0.7.1 the seed mints a 1h
   `vault:<name>:admin` token itself (see `prism-setup-schema`).
2. **Build the web PWA** (the server serves it), then **start**:
   ```bash
   npm run build -w @prism/web            # → apps/web/dist
   cd apps/server && npm run dev          # or: npm start
   ```
   Restart after any change — tsx compiles on start but does not hot-reload.

## Secure storage (checklist step `secrets`)

`SECRETS_KEY` encrypts every stored connection (Matrix, email, transcripts, …). Without it no
integration can be connected. Host install: the `secrets` step adds it when missing. A checkout
set up before the script wrote one:

```bash
cd apps/server
grep -q '^SECRETS_KEY=.' .env || printf 'SECRETS_KEY=%s\n' "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" >> .env
```

then restart. **Add it only when it is missing. Never replace one that is there:** every stored
connection would become unreadable.

## First sign-in (checklist step `owner`)

The owner signs in on the server's own computer without email:

- Host install: `prism setup` opens the link at the `owner` step; on its own, `prism signin`.
  It opens a one-time link in the default browser (once, this computer only, 10 minutes) and
  prints nothing secret.
- A checkout: `npm run signin -w @prism/server` while the server runs. Same thing.

The browser lands on the setup checklist (Workspace settings → Server). If the owner has no
password yet, it asks for one first. A password is what signs a phone or another computer in.

**Never paste a sign-in link, a token or the host key into this conversation**, and never print
one into the transcript. `prism signin --print` is for a headless Mac only: it prints the link (a
credential until used or expired) for the person to open on that Mac themselves.

## Email (checklist step `email`, optional)

`RESEND_API_KEY` and `MAGIC_FROM` make the owner's emailed sign-in link (the recovery path) and
invitations arrive by email. Creating the Resend key and verifying the sending domain are the
person's actions; the key goes into the `.env` by the person. Without email, the owner signs in
with `prism signin`, and an invitation is a link the owner copies from the app and sends.

## Federation (only on explicit opt-in)

Hub-to-hub federation needs a **stable** Ed25519 identity:

```bash
cd apps/server && node --import tsx -e \
  "import {generateKeyPairB64url} from './src/auth/peer.ts'; console.log(generateKeyPairB64url())"
# add to .env:  PEER_SIGNING_KEY=<privateKeyB64url>   and   FEDERATION_ENABLED=true
```

This prints a private key: have the person run it and add it to `.env` themselves. Without
`PEER_SIGNING_KEY` the server uses an ephemeral identity (pairings won't survive a restart). Leave
federation off by default (`docs/federation.md`).

## Config artifact

The server's `.env` (0600). Required: `PARACHUTE_TOKEN`, `SESSION_SECRET`, `CAPABILITY_SECRET`,
`OWNER_EMAIL`, `APP_ORIGIN`; plus `PARACHUTE_URL`, `PARACHUTE_VAULT`, `COLLAB_TOKEN`,
`SECRETS_KEY`; optional `RESEND_API_KEY`, `MAGIC_FROM`, `FEDERATION_ENABLED`, `PEER_SIGNING_KEY`,
`WEB_ROOT`, `DB_PATH`. Validated by `apps/server/src/config.ts` → `assertConfig()`.

## Verify (pass / fail)

- Host install: `prism status --json` exits 0; `prism setup --json` reports `server` done.
- Checkout: `cd apps/server && npm run typecheck` is clean and the server starts with no
  `assertConfig()` throw; `curl -fsS http://localhost:8787/api/version` answers.
- Signed in as the owner, **Workspace settings → Server** shows the checklist with every "Your
  workspace" step ticked.
- Security e2e (checkout, self-provisioning, safe on any vault):
  `cd apps/server && node --env-file=.env --import tsx scripts/verify-gateway.ts` →
  `ALL GATEWAY CHECKS PASSED`.
