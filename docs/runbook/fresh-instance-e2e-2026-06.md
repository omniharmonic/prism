# Fresh-Instance End-to-End Simulation (2026-06)

A full dry-run of a new user's journey: clone from GitHub → stand up Parachute +
Prism Server → onboard → ingest → federate, driven by the `prism-setup` skill, on an
**isolated** stack (fresh vault `freshtest`, port 8790) that never touched the live
production instance (pm2 `prism-server` :8787, vault `default`). Everything below was
exercised live, not reasoned about. The disposable stack was torn down afterward.

## What passed (a normie can get here)

| Phase | Result |
|---|---|
| GitHub clone + `npm install` | clean (827 pkgs) |
| Fresh vault + minted JWT (`parachute-vault create` + token) | authed `/tags` 200, no-token 401 |
| `npm run setup` (prism-setup.ts) | wrote `.env` (chmod 600), **35 tag schemas seeded**, rendered `.mcp.json` |
| Schema seed idempotency | re-run → **0 created / 0 updated / 35 unchanged** |
| MCP against fresh vault | `initialize` + `tools/list` (9 tools) + `vault-info` all OK |
| Gateway security (`verify-gateway.ts`) | **ALL CHECKS PASSED** incl. anon password-gated site (no Prism login) |
| Owner magic-link sign-in | console link → `/auth/callback` → owner session → owner `/api/notes` passthrough |
| Invite a friend (`verify-invite-flow.ts`) | **ALL CHECKS PASSED** (invite→register→login→scoped gateway→collab edit) |
| Ingest loop (MCP `create-note` → `query-notes`) | typed notes (task/person/meeting) round-trip |
| Federation, two isolated hubs (`verify-two-hub.ts`) | **12 PASS / 0 FAIL / 2 SKIP** incl. A↔B live convergence, AC-9 offline replay, revocation |
| Federation primitives (`verify-federation.ts`) | **14 / 14** |

## Fixes applied (in this pass)

- **F5 — verify scripts hardcoded `:8787`.** `verify-gateway.ts` + `verify-invite-flow.ts`
  ignored `PORT` and hit a hardcoded `localhost:8787` while provisioning fixtures in the
  `.env` vault — so on any other port (or beside another `:8787` instance) they silently
  tested the WRONG server. Now derive `BASE = http://localhost:${config.port}` (matches
  `verify-collab-share.ts`). Re-run → all green.
- **F6 — login screen lied with no Resend.** It said "a sign-in link is on its way" even
  when no email was configured, stranding a fresh owner. `/auth/request` now returns
  `{ ok, emailDelivery }` (a server-wide fact — no account enumeration), and the login
  screen tells a no-email owner to read the link from the **server console**.
- **F2 — desktop-created vault tokens expired in ~90 days.** `vault_create` used
  `parachute-vault create --mint` (90-day default TTL); a desktop-created vault would
  silently stop authenticating. Now mints a **1-year** token via a separate
  `parachute auth mint-token --expires-in 31536000`. (cargo check clean.)
- **F1 — README "Getting Started" was desktop-only + stale.** No Parachute install path,
  no mention of the server / `npm run setup` / the `prism-setup` plugin, stale build path.
  Rewritten to the validated three-track flow and pointed at `docs/onboarding.md`.

## Key truths for launch (answers to "do I need X?")

- **Resend is optional.** Owner gets the magic link from the server console (or
  `scripts/mk-owner-session.ts`); friends get the invite link from the Share dialog
  (auto-copied to clipboard → paste into a DM). Resend only *automates* delivery.
- **Integrations (Matrix/Google/Notion/transcripts)** need the **desktop app + real
  third-party credentials**; they can't be exercised headless and are correctly
  config-gated (absent credential ⇒ background service stays off). The server/web path
  gives a working vault + capture immediately; pulling in external services is a later,
  per-service, opt-in step.

## Open follow-ups (not blocking, noted honestly)

- **F3/F4 (LOW):** `prism-setup.ts` echoes the pasted token in cleartext (no readline
  masking) and its "NEXT" hints hardcode `:8787` regardless of chosen `PORT`. Fine for the
  default single-instance user.
- **F7 (ops, no product impact):** running a second stack beside the pm2 prod server,
  kill test servers **by listener** — `lsof -ti tcp:PORT -sTCP:LISTEN`. `pkill -f "tsx
  src/index.ts"` matches the prod server too; plain `lsof -ti tcp:PORT` also matches
  *connected* sockets (the harness, the federation bridge).
- **Vault cleanup:** there's no `parachute-vault delete` — it's `parachute-vault remove
  <name> --yes`. Test vaults otherwise accumulate.
