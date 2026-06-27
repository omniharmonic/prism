# Roadmap Implementation Progress

Tracking execution of [`master-implementation-plan.md`](./master-implementation-plan.md) on branch `claude/prism-roadmap-exploration-u90og6`.

Legend: ⬜ not started · 🟡 in progress · ✅ done · 🔵 verified at barrier

## P0 — Foundations & seams → barrier B0  ✅
- 🔵 L-Onb-A1 — `skipOnboarding` prop + gate in `packages/core/src/App.tsx`
- 🔵 L-Core-RO — `RendererProps.readOnly` + optional callbacks (call sites guarded)
- 🔵 L-Schema — canonical `packages/core/src/lib/schemas/tag-schemas.json` (35 tags, drift: dashboard+project)
- 🔵 L-Pub-DB + L-P2P-DB — `db.ts` tables (publications, peers, peer_pairings, spaces, federated_notes, federation_outbox; grant peer/space) + helpers
- 🔵 L-Perm — `effectiveLevel` space-membership extension (`NoteRef.spaceIds`)
- 🔵 **B0** — core/web/server tsc clean; cargo check clean; desktop onboarding unchanged; migrations idempotent on 180MB dev DB

## P1 — First end-to-end wins → barrier B1  ✅
- 🔵 L-Onb-A2 — web `main.tsx` `isViewer` wiring + `VITE_WEB_OWNER_ONBOARDING` (web skips wizard by default; browser confirm in final QA)
- 🔵 L-Pub-Spine — `publish.ts` manifest + single note; JSON mounted at **`/api/p`** (not `/p`, to avoid SPA-shadow), `/p` client route + `PublicationView`
- 🔵 L-Pub-ACL — `POST/DELETE /acl/tags/:tag/publish` + `GET /acl/publications` (idempotent; anyone-grant primitive)
- 🔵 L-Core-RO-impl — `readOnly` honored in Document/Code/Spreadsheet/Canvas (editable default unchanged)
- 🔵 L-P2P-Trust — `auth/peer.ts` Ed25519 + `routes/federation.ts` pairing + `acl` owner pairing/identity/list
- 🔵 **B1** — publish→manifest→note 200, out-of-pub 403; SPA at /p, JSON at /api/p; pairing valid/reuse-403/bad-key-400/listed; core+web+server tsc clean; web prod build green

> Design note: JSON moved from `/p` (plan) to `/api/p` so the human `/p/:slug` URL serves the SPA shell while data stays under the already-denylisted `/api/*` — cleaner than the plan's `/^\/p\//` denylist add, which would have shadowed the client route.

## P2 — Depth: Wiki + bidirectional CRDT → barrier B2
- ⬜ L-Pub-Wiki — template registry + WikiTemplate slots, scoped wikilink onNavigate, Backlinks
- ⬜ L-Pub-Graph — `/p/:slug/graph` scoped + edge-filtered + client graph
- ⬜ L-P2P-Mirror — `space_note_key` mint + one-way Yjs push, `PEER_ORIGIN`, kind-pinning
- ⬜ L-P2P-Bi — bidirectional edit merge + `federation_outbox` flush + external-edit race rule
- ⬜ L-Onb-Schema2 — refactor TS `TAG_TO_CONTENT_TYPE` + Rust `tag_map` from `tag-schemas.json`; reconcile dashboard
- ⬜ **B2** — Wiki browsable (nav/wikilinks/backlinks/search), no graph leak, two-hub convergence, mapping parity

## P3 — Hardening, gates, suggest-mode, setup tooling → barrier B3
- ⬜ L-Pub-Pwd — `password_hash` + `/p/:slug/auth` scrypt gate + cookie mw + UI
- ⬜ L-Pub-UX — Publish tab in Share dialog + publications list/unpublish
- ⬜ L-Pub-Sec — `verify-gateway.ts` publish assertions
- ⬜ L-P2P-Suggest — durable pending-suggestions store + accept/reject API
- ⬜ L-P2P-UX — federated markers + sync status + Share-a-Space dialog
- ⬜ L-Onb-Seed — shared `seedTagSchemas()` lib → `prism-setup` SKILL + `seed.ts`
- ⬜ L-Onb-CLI — `prism setup` orchestrator (port `bootstrap.sh`)
- ⬜ **B3** — verify-gateway passes; password gate enforced; suggest survives restart; `prism setup` idempotent

## P4 — Packaging, migration, docs, accelerators → barrier B4 (release)
- ⬜ L-Onb-Plugin — `.claude-plugin/plugin.json` + `.mcp.json.template` + `validate_config`
- ⬜ L-Onb-Docs — `docs/onboarding.md` + CLAUDE.md update
- ⬜ L-P2P-Migrate — GitHub `id_map` → `space_note_key` importer
- ⬜ L-Pub-Docs — HTTPS/password docs + SW-denylist automated check
- ⬜ L-P2P-Accel — optional Parachute-core accelerators (only if reachable)
- ⬜ **B4** — full gates green; plugin installs; migrated binding syncs p2p

## Final
- ⬜ Final QA e2e pass across all 3 horizons → merge to `main`
