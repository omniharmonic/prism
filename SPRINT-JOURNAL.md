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
