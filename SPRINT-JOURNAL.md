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
