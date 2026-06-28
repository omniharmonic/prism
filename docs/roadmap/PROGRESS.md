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

## P4 — Packaging, migration, docs, accelerators → barrier B4 (release)  ✅
- 🔵 L-Onb-Plugin — `.claude-plugin/plugin.json` (schema VERIFIED via claude-code-guide: `skills`=dir, `author`=object, inline `mcpServers`+`${VAR}` ok) + `.claude-plugin/README.md` + `.mcp.json.template` + `validate_config` Tauri cmd + core wrapper
- 🔵 L-Onb-Docs — `docs/onboarding.md` + CLAUDE.md Onboarding/setup subsection
- 🔵 L-P2P-Migrate — `scripts/migrate-github-space.ts` (idempotent, dry-run; reuse space by path_prefix, durable space_note_key) — verified on synthetic id-map + cleaned up
- 🔵 L-Pub-Docs — `docs/publishing.md` + `docs/federation.md` + CLAUDE.md; `apps/web/scripts/check-sw-denylist.mjs` (`npm run check:sw`) guard
- ⏭ L-P2P-Accel — SKIPPED (Parachute-core changes; out of scope per plan, never blocks 1–3)
- 🔵 **B4** — core+server tsc clean; cargo clean (validate_config); check:sw passes; plugin.json + .mcp.json.template valid; migrate dry-run correct

## Final  ✅
- 🔵 Final QA across all 3 horizons: core+web+server tsc clean · cargo clean · web build green · `check:sw` pass · verify-gateway ALL PASS · verify-collab-share 42/42 · verify-federation 14/14 · publishing+password+suggestion+federation-pairing e2e · mapping parity 35/35 · seed idempotency · adversarial security review (no critical/high; 2 fixes applied)
- 🔵 **Merged to `main`** (`e541f77`) and pushed to origin. Branch `claude/prism-roadmap-exploration-u90og6` pushed.

### Deferred (documented, non-blocking)
- Live two-hub federation convergence (gated off; needs a 2nd hub+vault; transport bridge + invariants built & tested) — see `docs/federation.md`, `apps/server/src/federation-manager.ts`.
- L-P2P-Accel (Parachute-core change-feed / scoped peer-MCP / push revocation) — out of scope per plan.
- suggest≈edit at the CRDT layer (existing in-doc suggestion design) — see `docs/security-review-notes.md`.
