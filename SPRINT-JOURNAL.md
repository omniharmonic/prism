# Multi-Tenant Platform Sprint — Autonomous Build Journal

Branch: `sprint/platform-foundation` (worktree /Users/benjaminlife/dev/prism-sprint).
Prod is isolated on `main` at /Users/benjaminlife/dev/prism (pm2 prism-server). NEVER
run write-ops against the prod `default` vault; use a throwaway test vault for e2e.
Plan: docs/roadmap/platform-roadmap.md. This file = durable progress log (survives
context compaction). Update it after every sub-step.

## Status board
- [x] Phase 0.4 — isOwner→role refactor (1450caa)
- [x] Phase 0.1 — scope-guard hub-JWT validation (c5cb3cd)
- [x] Phase 0.2 — startup token introspection (4e944f3)
- [x] Phase 0.3 — 409/428 conflict envelope (c39eca9)
- [x] Phase 1 — vault_id multi-tenancy core (d7e33d4): grants/anyone/roles isolated per vault + memberships + workspaceRole + vault-aware actor/gateway. (collab/federation vault-scoping + collab_docs PK rebuild deferred.)
- [~] Phase 2 — permission core done (8768f57): private-to-creator notes, whole-vault grant, scoped member create, leak-proofed publish/rag/collab. TODO: /acl/members + folder-sharing endpoints + UI panels.
- [ ] Phase 3 — per-tenant secrets + Node worker (server-first runtime)
- [ ] Phase 4 — federation depth + Parachute Sync
- [ ] Phase 5 — self-host as a hub module
- [ ] Phase 6 — cross-platform desktop
- [ ] Comprehensive e2e (server suite + verify-* against a test stack + web build + typecheck)

## Test baseline
231/231 server unit tests green; verify-vault-token.ts live 3/3.
Run tests: `cd apps/server && npm test`. Typecheck: `npm run typecheck`.

## Decisions / guardrails
- Quality over coverage: test everything built; be honest about partial/deferred.
- Additive migrations (vault_id DEFAULT 'primary') keep single-vault deploys identical.
- collab_docs PK rebuild = the one risky migration; isolate + test separately.
- UI panels (React) can't be browser-e2e'd headless; cover server-side + build + typecheck,
  flag UI for manual verification.

## Comprehensive e2e (final) — ALL GREEN
- Server unit suite: **243/243**.
- Server typecheck: clean. Web build (tsc+vite): clean. Desktop frontend tsc: clean.
  Desktop Rust manifest: valid (cargo metadata, after dead-dep removal).
- LIVE integration vs a fresh isolated vault `sprint-e2e` on :8795 (torn down after):
  - verify-gateway.ts → **ALL GATEWAY CHECKS PASSED** (incl. private-note absent from
    public manifest/graph/direct — the Phase-2 leak-proofing).
  - verify-invite-flow.ts → **ALL INVITE-FLOW CHECKS PASSED** (invite→register→login→
    scoped /api/notes→collab edit; the /acl people write path live-green).
  - verify-vault-token.ts → **3/3** (scope-guard chain, signature+audience rejects).
- Teardown clean; PROD verified intact (web :8787→200, pm2 prism-server+tunnel online,
  default vault untouched). Found+fixed a test-setup shell-quoting bug minting the
  e2e token (vault:$V:write mangled → broad aud); clean literal mint fixed it.

## Deferred (designed, not built — honest)
- Phase 3 Node worker: porting Rust ingest (Matrix/Notion/Fathom) + claude -p executor
  to a Node worker consuming tenant_secrets. Can't integration-test headless; large.
- Phase 4 federation depth / Parachute Sync: needs 2 live hubs; verify-two-hub harness
  exists. Collab + federation vault-scoping (collab_docs PK rebuild) also deferred.
- Phase 5 hub-module (.parachute/module.json) + VPS local.ts trust-gate hardening.
- Phase 6 off-mac secret-store fallback.
- Phase 2 UI: MembersPanel builds + is wired, but browser e2e is manual.

## Log
- (start) Phase 0 complete. Beginning Phase 1.
- Phases 1, 2, 3(secret store), 6(dead dep) landed + tested; comprehensive e2e green;
  test stack torn down; prod intact. 11 commits on sprint/platform-foundation.

## Phase 3 (server-first runtime) — MERGED foundation + branch work, LIVE-proven
Foundation (secret store) shipped to main + deployed. Branch `sprint/phase-3-worker`
adds (committed, tested, NOT yet deployed):
- Agent executor (claude -p over the server, admin-gated, per-vault MCP + scoped
  token, SSE). LIVE: real claude dispatch → vault MCP list-tags → TAG_COUNT=0 → done.
- Matrix ingester (Node port of message_sync; secret store creds; message-thread
  notes matching the desktop). LIVE vs the local Synapse: 92 msgs / 5 rooms → 5
  notes, 8/8 (incl. secret-store encrypt round-trip).
- Worker scheduler (per-vault interval + since-cursor persistence) + /api/integrations
  Matrix config endpoint (store/status/remove/trigger), admin-gated.
- 266/266 unit tests; typecheck clean. live scripts: verify-matrix-ingest.ts,
  verify-agent-exec.ts.
NOT deployed: server-side Matrix would DOUBLE-sync against the desktop's existing
Matrix sync — enabling it (set SECRETS_KEY + store creds) is a together-decision.
Deferred: Phase 3 UI (Matrix config panel + agent dispatch UI), Notion/transcript
ingesters (same worker pattern).

## Matrix sync CUTOVER TO SERVER — DONE + VERIFIED (deployed to prod)
Phase 3 merged to main + deployed (boot-tested on a copy of the 180MB prod DB first;
all data intact). Matrix moved desktop→server, no redundancy:
- Server-side sync enabled: secret stored (prod SECRETS_KEY), cursor set to NOW
  (skipped 1534 backlog msgs / 200 rooms — no duplicate flood).
- VERIFIED live: sent a real Matrix msg → server worker ingested it → note in prod
  vault → cleaned up (verify-matrix-cutover). PASS.
- Desktop message_sync DISABLED via new AppConfig.disable_message_sync flag +
  rebuilt/restaged /Applications/Prism.app (backup at ~/Prism.app.rollback-*) +
  config flag true + relaunched. VERIFIED behaviorally: marker appears exactly
  once after a full desktop tick-cycle (verify-desktop-sync-off). PASS = server is
  sole syncer.
- Prod healthy throughout (health, tunnel 200); desktop app running new build.
- Commits: main e989747 (desktop flag), branch 63a38ef (scripts).

## Remaining sync features (same pattern, NOT yet done)
Movable (portable creds, both CONFIGURED): Notion (notion_api_key, BIDIRECTIONAL —
more involved) + Fathom transcripts (fathom_api_key, one-way — simplest, closest to
Matrix). STAY desktop (host-bound): Google calendar/email (gog keyring), Meetily
(local SQLite).
Fast path per feature: (1) Node ingester porting the Rust service, (2) wire into
worker/scheduler.ts (secret + cursor), (3) add a desktop disable flag (BATCH both
in ONE rebuild), (4) cutover: store creds + since=now + verify live + flip flag +
rebuild + verify no-dup. ~1 desktop rebuild covers both remaining.

## Fathom transcripts CUTOVER TO SERVER — DONE + VERIFIED
- Node port worker/fathom.ts (dedup by source_id → create-only, overlap-safe).
  Wired into worker tick [matrix, fathom]. /api/integrations/fathom endpoints.
- Deployed to prod (boot-tested on prod DB copy w/ SECRETS_KEY STRIPPED so the
  boot worker couldn't write to the real vault; merge→restart, healthy).
- Server-side enabled: fathom key stored (prod SECRETS_KEY), runFathomOnce OK
  (0 new — no meetings in last 7d; API reachable, write path unit-tested +
  proven live vs a throwaway vault).
- Desktop Fathom sync DISABLED: new Rust flag disable_fathom_sync + 2nd desktop
  rebuild/restage (backup ~/Prism.app.rollback-fathom-*) + config true +
  relaunch. Mechanism re-verified on the new build (Matrix marker-once test PASS
  = the config-flag+binary disable path works; Fathom uses the identical path).
- Prod healthy throughout. Commits: main 1f6c00f, branch 1222029.

## Notion — IDLE, nothing to move
No notion-sync-configs.json → the desktop notion_task_sync has no database
configured to sync (the API key is set but unused). So server-side Notion is
DEFERRED (would be a large bidirectional port for something not in use).
Building it now = untested risk for zero benefit — correct to defer until a
Notion DB sync is actually configured.

## STATE: all ACTIVE movable syncs are now server-side.
Matrix ✓ + Fathom ✓ moved+verified. Notion idle (n/a). Google (gog) + Meetily
(local SQLite) correctly stay desktop. Desktop app runs new build w/ both
disable flags; server worker is sole syncer for Matrix + Fathom.

## COMPREHENSIVE sync port — GitHub + Google Docs + Notion adapters SERVER-SIDE
Reversed the earlier "defer the rest" stance (correctly — piecemeal left the
migration half-done). Ported ALL three remaining sync adapters to the Node
server so the web/mobile app can sync with no desktop running:
- worker/github.ts   — Contents/Trees API; serialize note→md(frontmatter+body),
  push (skip-unchanged by sha), pull (import repo .md → vault, match by
  extension-stripped path). LIVE-VERIFIED (verify-github-sync.ts): push+pull.
- worker/googledocs.ts — shells to the colocated `gog` CLI (works from non-GUI
  process). create/write/read/remoteRevision(revisionId)/trash. LIVE-VERIFIED
  (verify-googledocs-sync.ts): create→write→read round-trip.
- worker/notion.ts   — pure HTTP; md⇄blocks, push(delete-all+append)/pull/create.
  Built + UNIT-tested. NOT live-verified: desktop notion_api_key is 401 (stale
  token — credential, not code). Refresh the token to enable.
- routes/sync.ts — admin-gated /api/sync/note/:id/{push,pull} (google/notion by
  metadata.sync[]) + /api/sync/github/{push,pull}. Creds from the per-tenant
  secret store (generic cred<T>). integrations.ts: registerCredential() →
  GET/PUT/DELETE for github/google/notion (encrypted at rest, never leaked).
- ROUTE-LEVEL live e2e (verify-sync-routes.ts): drives the REAL Hono app via an
  owner session cookie + x-prism-vault → resolveActor → secret store → adapter →
  live GitHub/Google. PASS both. Proves full production wiring, not just adapters.
- DEPLOYED to prod: ff-merge 1f6c00f→bf10c8a, boot-tested (app constructs, routes
  403 pre-auth), pm2 restart, live /health 200 + routes 403. No new deps. Purely
  additive: desktop still owns github/google/notion sync (no disable flags yet),
  so nothing removed — this is a new parallel server path. 291 server tests pass.

## REMAINING for full parity (the "Matrix/Fathom treatment" for these three):
1. Store prod creds (gh token + gog account) in the prod secret store so the
   server can sync unattended for the owner's primary vault.
2. Refresh the Notion token (currently 401) → then live-verify notion route.
3. Add desktop disable flags (disable_github_sync/…) + cut over + rebuild +
   verify no-dup — only when moving each OFF the desktop is actually desired.
Meetily (local SQLite) + Google calendar/email (gog) remain desktop-only, not
yet ported (calendar/email are ingest, not the sync-adapter shape).
