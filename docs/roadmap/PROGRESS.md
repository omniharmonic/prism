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

## P2 — Depth: Wiki + bidirectional CRDT → barrier B2  ✅
- 🔵 L-Pub-Wiki — template registry + WikiTemplate (nav path-tree, TOC, search, scoped wikilinks, backlinks from graph); web build green
- 🔵 L-Pub-Graph — `/api/p/:slug/graph` scoped + edge-filtered (wikilinks; drops out-of-set endpoints) — leak test PASS
- 🔵 L-P2P-Mirror + L-P2P-Bi — gated federation foundation: peer-conn tokens, `collab.ts` additive (federationTarget + peer-auth + space→note mapping + kind-pin + PEER_ORIGIN), FederationManager (HocuspocusProvider bridge + outbox), space ACL; 14/14 invariant tests
- 🔵 L-Onb-Schema2 — TS `TAG_TO_CONTENT_TYPE` + Rust `tag_map` both derive from `tag-schemas.json`; `dashboard→dashboard` fixed on both sides
- 🔵 **B2** — graph leak test PASS; mapping parity 35/35; collab regression 42/42 (federation-off = unchanged); Wiki SPA served; tsc+cargo+web build green

> Federation honest gaps (documented in `federation-manager.ts`, flagged for live two-hub validation): peer collab-URL registry, client opening federated notes by `space_note_key`, and end-to-end two-hub convergence (needs a 2nd hub+vault). All in-process invariants are tested; the path is fully gated (`FEDERATION_ENABLED`, default off).

## P3 — Hardening, gates, suggest-mode, setup tooling → barrier B3  ✅
- 🔵 L-Pub-Pwd — `publish.ts` scrypt `/api/p/:slug/auth` + signed httpOnly `pub_<slug>` unlock cookie; locked manifest hides nav; PublicationView password prompt; owner `password` param + `PUT .../publish/password` in acl
- 🔵 L-Pub-UX — Publish tab in core ShareDialog via extended CollabSharing seam (gated on `publishTag`); web impl in grant.ts
- 🔵 L-Pub-Sec — `verify-gateway.ts` publish/federation assertions (anon scope, no token leak, in/out-of-pub 403, graph edge-filter, password) — ALL PASS
- 🔵 L-P2P-Suggest — durable `pending_suggestions` table + owner `/acl/suggestions` list/accept/reject/delete (survives restart)
- 🔵 L-Onb-Seed + L-Onb-CLI — shared `seedTagSchemas()` (idempotent, additive-only) + `prism setup` CLI (ports bootstrap.sh, --dry-run) + `prism-setup` skill
- 🔵 **B3** — verify-gateway ALL PASS (live password gate); unlock flow e2e; suggestion survives restart; seed dry-run idempotent (29 unchanged); collab regression 42/42; tsc+web build green

> L-P2P-UX (federated markers / Share-a-Space) folded into the seam work as optional methods; the live federated-marker UI rides on the deferred two-hub transport (gated).

## P4 — Packaging, migration, docs, accelerators → barrier B4 (release)
- ⬜ L-Onb-Plugin — `.claude-plugin/plugin.json` + `.mcp.json.template` + `validate_config`
- ⬜ L-Onb-Docs — `docs/onboarding.md` + CLAUDE.md update
- ⬜ L-P2P-Migrate — GitHub `id_map` → `space_note_key` importer
- ⬜ L-Pub-Docs — HTTPS/password docs + SW-denylist automated check
- ⬜ L-P2P-Accel — optional Parachute-core accelerators (only if reachable)
- ⬜ **B4** — full gates green; plugin installs; migrated binding syncs p2p

## Final
- ⬜ Final QA e2e pass across all 3 horizons → merge to `main`
