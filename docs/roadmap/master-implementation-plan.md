# Prism Master Implementation Plan — Onboarding · Publishing · Parachute‑to‑Parachute Collaboration

> Status: program plan (architecture‑approved). Audience: the executing agent swarm + their human lead.
> Scope: three product horizons over the existing dual‑shell Prism stack (`packages/core`, `apps/desktop`, `apps/web`, `apps/server`).
> Authoritative context: `/home/user/prism/CLAUDE.md`. Every code reference below was opened and verified against the current tree.

---

## 1. Executive Summary

Prism is one shared React 19 UI core (`packages/core`) running over two shells — the trusted Tauri **desktop** app (`apps/desktop`) and a static **web** PWA (`apps/web`) that talks only to the **Prism Server** gateway (`apps/server`). The server is the single trust boundary: it holds the vault token, resolves an actor (owner / signed‑in user / capability link / anon), and gates every read/write through `effectiveLevel(grants, note, isOwner)` (`apps/server/src/permissions.ts:36`). Grants live in SQLite with a `(subject_type, subject, resource_type, resource, level)` shape and already reserve an `anyone` subject type that is parsed but never written (`apps/server/src/db.ts:35`). Real‑time collaboration is a type‑aware Hocuspocus/Yjs server (`apps/server/src/collab.ts`) that self‑seeds each note's Y.Doc from Parachute and persists it back per kind.

The three horizons, and the single throughline that connects them:

- **Horizon A — Onboarding.** Make the *right person* land in the *right surface*. A web/shared viewer must never see the owner setup wizard, and a brand‑new owner must be able to provision a working vault (running Parachute + minted token + seeded tag schemas + config) with one guided command. Touches the **actor/ownership** signal at app entry and a new **canonical tag‑schema** source of truth.
- **Horizon B — Publishing.** Turn the dormant `anyone` grant into a first‑class **Publish** capability: pick a tag, choose the *Wiki* template, optionally set a password, get a live public read‑only site served same‑origin from Prism Server — reusing `effectiveLevel` as the only guard. Touches the **anon/permission** path and adds **read‑only rendering** to the shared renderers.
- **Horizon C — Parachute‑to‑Parachute Collaboration.** Two independent Prism Servers, each with its own vault and token, keep a defined *shared space* of notes continuously merged via the **same Yjs CRDT engine** already in `collab.ts` — with **zero Parachute‑core changes** for v1. Touches the **peer/permission** path and the **collab transport**.

**The throughline is the actor → grant → `effectiveLevel` pipeline plus the Yjs CRDT engine.** All three horizons extend the *same* authorization chokepoint rather than forking it:

| Horizon | New subject on the actor | Reuses |
|---|---|---|
| Onboarding | (none) — reads existing `actor.isOwner` from `/auth/me` | actor resolution, owner detection |
| Publishing | `anyone` (synthetic read‑only anon actor, scoped to `/p`) | `effectiveLevel`, `atLeast`, the renderers |
| P2P Collab | `peer` (Ed25519‑authenticated, `resource_type='space'`) | `effectiveLevel`, the whole `collab.ts` seed/merge/persist engine |

Because all three converge on `permissions.ts`, `actor.ts`, `db.ts`, and `collab.ts`, those four files are the program's **coordination hotspots** — they must be edited under a single owner per phase with explicit merge barriers (see §4). Get the actor/permission seam right once, and all three horizons compose on top of it.

---

## 2. Per‑Area Deep Dives

### 2A. Onboarding

#### Goals
1. A web/shared viewer (capability‑link **or** invited non‑owner) lands directly in the Shell and never sees the owner setup wizard.
2. The Tauri‑only onboarding wizard is never rendered where its `invoke()`‑based actions cannot run (the web shell).
3. Desktop first‑run onboarding is preserved **bit‑for‑bit** (no regression).
4. A new owner can provision a working Prism (running vault + minted token + 29 seeded tag schemas + config files) with one guided command.
5. Claude‑Code users install one Prism plugin bundling the existing skills plus an idempotent `prism-setup` skill.
6. The tag list + tag→contentType mapping has **one** canonical machine‑readable source, ending the current TS/Rust duplication and drift.
7. Seeding is idempotent: safe on a fresh **or** existing vault (adds missing tags, never clobbers).

#### Design criteria
- `packages/core` stays shell‑agnostic: it may not import `apps/web`/`apps/desktop` and must not sniff the runtime. Onboarding policy is **injected (prop)**, not detected in core.
- Viewer‑vs‑owner detection **reuses the server authority** (`actor.isOwner` via `/auth/me`, plus presence of a capability token). No parallel client notion of ownership.
- The skip signal is **per‑session/per‑actor**, never persisted to `localStorage` settings (a logout or downgrade re‑evaluates).
- Desktop default (no prop) equals today's behavior exactly.
- One source of truth for tag schemas; both the Rust `tag_map` and TS `TAG_TO_CONTENT_TYPE` derive from / are asserted against it.
- Seeding diffs‑then‑upserts (`list-tags` before `update-tag`); re‑running is a no‑op on present tags; never deletes fields.
- The CLI and the `prism-setup` skill share **one** `seedTagSchemas()` implementation.
- No secrets committed: `.mcp.json` stays gitignored; ship `.mcp.json.template` with `${VAR}` placeholders.
- The plugin manifest follows Claude Code's standard layout (`.claude-plugin/plugin.json`).

#### Product requirements
- Opening a `?t=` link or signing in as a non‑owner → straight to shared content, no wizard.
- Owner first‑run on desktop → existing guided onboarding (Parachute, schema, integrations).
- `prism setup` (or equivalent) → a running, correctly‑schema'd vault + valid desktop + server config, with no hand‑edited JSON or curl.
- Installable Prism Claude plugin exposing a `/prism-setup` skill that seeds tags + a starter dashboard.
- Re‑running setup on an existing vault adds missing tags without altering existing notes/tags.
- End‑to‑end onboarding docs (install Parachute → `prism setup` → optional plugin → invite yourself to the web app).
- A non‑owner later granted owner status is not permanently locked out of any future owner‑only setup affordance.

#### Recommended approach
Two independent parts.

- **Part A — viewer skip (the seam).** Add an optional `skipOnboarding?: boolean` prop to the core `App` and flip the render gate so a viewer goes straight to `Shell`. The web shell computes `isViewer = !!capability || !me?.isOwner` from signals it *already has* and passes it down. Desktop passes nothing → unchanged. This is small and fixes a broken‑screen bug for **every web viewer today**, so it ships first.
- **Part B — owner setup CLI + plugin.** Promote the tag schemas to one canonical `tag-schemas.json`, build one idempotent `seedTagSchemas()` library, refactor both mappings to derive from it, then build the `prism-setup` skill and the `prism setup` CLI on top of that single seed function, and bundle the skills into a Claude plugin.

#### Key code references (path → change)

| Path | Change | Verified anchor |
|---|---|---|
| `packages/core/src/App.tsx` | `function App({ skipOnboarding }: { skipOnboarding?: boolean })`; change the gate at **line 66** from `onboarded ? <Shell/> : <Onboarding/>` to `(onboarded \|\| skipOnboarding) ? <Shell/> : <Onboarding/>`. Keep the `prism:onboarded` localStorage path (lines 48–61) for the desktop default. | confirmed: gate is a single ternary at line 66 |
| `apps/web/src/main.tsx` | After `initCapability()` (line 47) and the `fetchMe()` branch (line 102), compute `isViewer = !!capability \|\| !me?.isOwner` and render `<App skipOnboarding={isViewer} />` at the final render (line 126). Gate the web‑owner exception behind `VITE_WEB_OWNER_ONBOARDING` (default: always skip on web). | confirmed: `capability` at line 47, `fetchMe()` at 102, `<App />` at 126 |
| `apps/desktop/src/main.tsx` | **No change.** Renders `<App/>` with no prop → onboarding preserved. | — |
| `apps/web/src/config.ts` | Reuse `fetchMe()`/`cachedMe` and `getCapabilityToken()`; optionally export `isViewer()`. No change required. | per dossier |
| `packages/core/src/components/layout/Onboarding.tsx` | No structural change; document that it depends on Tauri `invoke` (via `lib/agent/client.ts`) and is therefore desktop‑only — the load‑bearing reason web must skip it. | per dossier |
| `packages/core/src/lib/schemas/content-types.ts` | `TAG_TO_CONTENT_TYPE` (lines 38–72) is one of two duplicated mappings; derive it from the new canonical `tag-schemas.json`. | confirmed: array at lines 38–72 |
| `apps/desktop/src-tauri/src/commands/vault.rs` | `tag_map` (the `enrich_note` priority list, lines 40–66) duplicates the TS mapping **and already disagrees**: `dashboard → project` here vs `dashboard → dashboard` in TS. Generate from / assert against the canonical source and reconcile. | confirmed: `tag_map` lines 40–66, `("dashboard", "project")` at line 47 |
| `.claude/tag-schemas.md` | Promote to canonical `packages/core/src/lib/schemas/tag-schemas.json` (29 tags: description, fields, contentType, priority). Keep the `.md` as generated docs. | vault‑info confirms 29 schema'd tags |
| `apps/server/scripts/bootstrap.sh` | Port secret‑gen + `.env` writer to portable `apps/server/scripts/setup.ts`; make it callable from the top‑level CLI. | per dossier |
| `.claude/skills/classify/SKILL.md` (+ `extract-entities`, `reconcile`, `schema-bridge`, `wikilinks`) | Template for the new `prism-setup` SKILL; bundle all five into the plugin manifest. | confirmed: skills exist |
| **NEW** `.claude-plugin/plugin.json` | Claude Code plugin manifest (none exists). Lists `prism-setup` + existing skills + Parachute MCP wiring so `/plugin install` works. | confirmed: absent today |
| **NEW** `.claude/skills/prism-setup/SKILL.md` + `seed.ts` | Idempotent setup skill: `list-tags` → upsert 29 schemas → starter dashboard + index notes → optional agent‑skill notes; calls the shared `seedTagSchemas`. | — |
| **NEW** `.mcp.json.template` | Committed template with `${PARACHUTE_URL}/${PARACHUTE_VAULT}/${PARACHUTE_TOKEN}`; CLI renders the gitignored `.mcp.json`. | — |
| **NEW** `apps/cli/` (or `scripts/prism-setup.ts`) + shared `seedTagSchemas()` | Orchestrator: launch/check vault, mint token, run shared seed, write `prism-config.json` + `.env` + `.mcp.json`. | — |
| `apps/desktop/src-tauri/src/commands/config.rs` | Add `validate_config` pinging vault `/health`; surface defaults for `parachute_url`/`vault`/`api_key`. | per dossier |

#### Risks / open questions
- **Web owner with no setup affordance** if web always skips. Mitigation: setup is owned by desktop+CLI; keep the `VITE_WEB_OWNER_ONBOARDING` flag for a future web‑native flow.
- **Capability viewers skip `fetchMe` entirely** (main.tsx line 100) → the skip *must* key on `!!capability` too, or they stay wizard‑trapped.
- **Existing mapping drift** (`dashboard → project` Rust vs `→ dashboard` TS): consolidating could change desktop enrichment for existing dashboard notes. Verify `inferContentType` still resolves dashboards (content/tag precedence) before/after.
- **Idempotency bug could clobber a customized tag schema.** Diff first; only add missing fields; never delete.
- **Claude Code plugin schema unverified** — confirm the current manifest format before merge or `/plugin install` silently fails.
- **`prism:onboarded` per‑origin localStorage**: a viewer who later becomes owner in the same browser keeps `skipOnboarding`. Acceptable (owner onboarding is desktop/CLI), but note it.
- **The wizard's agent‑driven schema step** creates ad‑hoc tags that may not match the 29 canonical tags renderers expect; the CLI/skill seed is the deterministic replacement — keep them from diverging.
- **`parachute` binaries assumed on PATH** (hub on :1939). Detect‑and‑instruct, don't fail hard.
- **Token TTL (≤1yr) + ~60s revoke cache**: minted tokens expire later with no renewal path. Flag a follow‑up 401→reauth flow (out of scope).

---

### 2B. Publishing

#### Goals
1. **One‑click publish**: from the owner's app, pick a tag (tag‑scoped for v1), choose **Wiki**, optionally set a password, get a live public URL — no separate build, no GitHub, no Quartz.
2. Public, anonymous, read‑only multi‑note site served **same‑origin** from Prism Server, working even when the owner is offline (the server self‑seeds from Parachute, exactly as `collab.ts` does).
3. **Quartz‑parity** reader experience: nav (path/tag tree), working `[[wikilink]]` → public‑URL resolution, backlinks, client‑side full‑text search scoped to the publication, optional scoped knowledge graph.
4. Reuse the trust boundary: publishing = an `anyone` grant + a `publications` config row; `effectiveLevel` stays the only authoritative guard.
5. Optional password gate reusing the server's scrypt + cookie primitives — no new crypto.
6. Zero breaking changes to the `@prism/core` renderer contract: read‑only rendering is **additive**, not a fork.

#### Design criteria
- `effectiveLevel` (`apps/server/src/permissions.ts:36`) stays the gate. Publication routes filter through it; tag scoping only **narrows** the fetch (defense‑in‑depth vs the Parachute REST tag‑scope gap, vault #404).
- **No vault token reaches the browser** on the public path. `proxyToVault` (`api.ts:30`) is owner‑only and stays that way.
- Public routes go in `navigateFallbackDenylist` (`apps/web/vite.config.ts`, currently `[/^\/auth\//, /^\/api\//]` at line 59) — the documented SW‑shadowing gotcha is a **hard release gate**.
- The `anyone` subject (`db.ts:35`, already UNIONed in `grantsForUser`) is the publication primitive. Publish creates an `anyone` grant; unpublish deletes it via `removeGrantBySubjectResource`.
- Anonymous reads are capped to `view` only. Never expose comment/suggest/edit to `anyone` in v1.
- Wikilinks resolve to **stable** public URLs: `/p/:slug/notes/:noteId` is canonical; the human path is a non‑load‑bearing display segment (renames must not 404).
- HTML served to anon readers is sanitized (reuse `sanitizeHtml` from `@prism/core`, already used in `ShareView.tsx`). The CSP in `app.ts` (`frame-ancestors 'none'`, tight `script-src`) is not loosened.
- The public graph/backlinks are computed from a **publication‑scoped node set only**, never the full vault graph.

#### Product requirements
- Owner picks a tag, template = Wiki, optional password + expiry, clicks Publish; dialog shows the public URL + copy button + a count ("this will publish N notes").
- Visiting the public URL with no account renders read‑only: a landing page (configurable home note, default = highest‑priority `index`‑tagged note or first note), a collapsible nav, and the rendered document.
- `[[wikilinks]]` navigate within the public site when the target is in the publication; targets outside render as inert text (no leak, no dead link).
- Each note shows a Backlinks ("Linked references") section over published notes only.
- Client‑side full‑text search over published notes (titles + body), in‑publication results only.
- Optional graph toggle showing the publication's own graph (published nodes + edges between them), scoped so no private node appears.
- Password gate: correct password sets a scoped httpOnly cookie; wrong password is rate‑limited with a generic error.
- Owner can list publications, see URL/template/password state, and unpublish instantly.
- Document/code/spreadsheet render read‑only; canvas renders read‑only or a static image fallback; unsupported types degrade to a titled "not available in this view" card.

#### Recommended approach — **live server‑rendered data + client template, NOT static export**
Static export duplicates the render pipeline server‑side (TipTap/Excalidraw outside a browser is painful), goes stale the instant a collaborator edits via Hocuspocus, and needs a build/invalidation story Prism lacks. The live path reuses everything Prism already does for collab: the server self‑seeds from Parachute, serves JSON, and the existing React renderers paint it in the browser. Content endpoints are trivially HTTP‑cacheable. An optional static snapshot exporter is explicitly out of scope for v1.

- **Data model.** Add a `publications` SQLite table (sibling to grants/capabilities): `id` (slug), `resource_type` ('tag' v1), `resource` (tag), `template` ('wiki'), `title`, `home_note_id`, `password_hash` (scrypt, reuse `auth/password.ts`), `theme` (JSON), `expires_at`, `created_by`, `created_at`. **Config (table) is separate from access (grant).** Publish = transaction: insert row + `upsertGrant({subject_type:'anyone', subject:'*', resource_type:'tag', resource:tag, level:'view'})`. Unpublish = delete row + `removeGrantBySubjectResource('anyone','*','tag',tag)`.
- **Actor/gateway wiring.** Do **not** globally hand `anyone` grants to every anon `/api` request. Isolate publishing in its own namespace `app.route('/p', publish)` (mounted **before** the static/SPA fallback at `app.ts:78–80`). `publish.ts` resolves the publication by slug, loads its `anyone` grants via `grantsForResource('tag', tag)`, builds a synthetic read‑only actor `{kind:'anon', grants:<those>}`, and reuses `effectiveLevel` + `atLeast` exactly as `api.ts:visibleNotes` does — shared guard, blast radius contained to `/p/*`.
- **Public endpoints** (`publish.ts`): `GET /p/:slug` (manifest: title, template, theme, home note id, nav tree, password‑required flag); `GET /p/:slug/notes/:id` (rendered note, 403 if `effectiveLevel < view`); `GET /p/:slug/graph` (publication‑scoped nodes + **edge‑filtered** to in‑set endpoints); `POST /p/:slug/auth` (scrypt verify → httpOnly slug‑scoped cookie). Search runs client‑side over the already‑fetched note list (no server index for v1).
- **Template abstraction.** Mirror the renderer Registry pattern (`packages/core/src/components/renderers/Registry.ts`): a Template registry keyed by template name → lazy component implementing `PublicationTemplateProps`. Wiki slots: header (title + search), left nav (tag/path tree), center article, right rail (TOC + Backlinks), optional graph overlay, footer. The per‑note body reuses the existing renderers in read‑only mode → visual parity with the app.
- **Wiki specifics.** Nav = client‑side path tree + tag filter; home note pinned. Wikilink resolution: supply an `onNavigate` that matches the target against the **publication's** note list (not the whole vault) → route to `/p/:slug/notes/:targetId`; on no match, render inert (reuse the `renderMarkdown` wikilink‑flattening fallback in `ShareView.tsx`). Backlinks: reverse‑index the `/p/:slug/graph` edges; extract a reusable component out of `LinksPanel.tsx`. Graph: feed `/p/:slug/graph` into the existing `react-force-graph` rendering, scoped to published nodes only.

#### Key code references (path → change)

| Path | Change | Verified anchor |
|---|---|---|
| `apps/server/src/db.ts` | Add `publications` table + `createPublication`/`getPublicationBySlug`/`listPublications`/`deletePublication`. The `anyone` subject + `grantsForUser` UNION already exist — publishing just starts inserting `anyone` rows via `upsertGrant`. | confirmed: `anyone` at line 35; grants schema lines 33–44 |
| `apps/server/src/routes/publish.ts` | **NEW.** Public read router at `/p`: resolve publication by slug, load anyone‑grants via `grantsForResource('tag',tag)`, synthetic read‑only actor, reuse `effectiveLevel`+`atLeast`. Endpoints: manifest, single note, scoped+edge‑filtered graph, password auth. | — |
| `apps/server/src/routes/acl.ts` | Add owner‑only `POST /tags/:tag/publish` (row + anyone grant, return URL), `DELETE /tags/:tag/publish`, `GET /publications`. Mirror `grantAndInvite`/`upsertGrant` patterns. | confirmed: owner‑only guard line 52, `upsertGrant`/`grantsForResource` imported |
| `apps/server/src/app.ts` | Mount `app.route('/p', publish)` **before** the static/SPA fallback (lines 78–80). No token, no CORS (same‑origin public). | confirmed: SPA fallback at lines 78–80 |
| `apps/web/vite.config.ts` | Add `/^\/p\//` to `navigateFallbackDenylist` (line 59). Add `/p/*` `NetworkFirst` runtimeCaching for offline reading. | confirmed: denylist `[/^\/auth\//, /^\/api\//]` at line 59 |
| `apps/web/src/main.tsx` | Add a `/p/:slug[/:noteId]` route branch alongside `/share` (line 71) and `/collab` (line 83), rendering `PublicationView` with no session/capability. | confirmed: share branch line 71, collab branch line 83 |
| `apps/web/src/publish/PublicationView.tsx` + `WikiTemplate.tsx` | **NEW.** PublicationView fetches the manifest, handles the password gate, dispatches to the template registry. WikiTemplate implements the slots, reuses read‑only renderers, scoped wikilink `onNavigate`, and `react-force-graph`. | — |
| `packages/core/src/components/renderers/RendererProps.ts` | Add optional `readOnly?: boolean`; make `onSave`/`onMetadataChange` optional. Additive — desktop callers unaffected. | confirmed: today requires `note`, `onSave`, `onMetadataChange` |
| `packages/core/src/components/renderers/DocumentRenderer.tsx` (+ Code/Spreadsheet/Canvas) | Honor `readOnly`: TipTap `editable=false`, skip `useAutoSave`/`onSave`. Canvas falls back to a static image. | per dossier |
| `packages/core/src/components/layout/LinksPanel.tsx` | Extract the inbound‑links ("backlinks") rendering into a reusable `Backlinks` component; public version fed by `/p/:slug/graph` edges. | per dossier |
| `apps/web/src/share/ShareView.tsx` | Factor the single‑note render + `sanitizeHtml` + wikilink‑flatten fallback into a shared `PublicNoteRenderer`. | confirmed: ShareView exists |
| `apps/server/scripts/verify-gateway.ts` | Add assertions: anon sees only published notes, never the token, never out‑of‑publication notes; graph edge‑filtering; password enforced. Gates release. | per CLAUDE.md (security e2e) |

#### Risks / open questions
- **SW shadowing**: missing `/^\/p\//` in the denylist → "works in curl, blank in browser." Release‑checklist item + ideally an automated check.
- **Graph/backlinks leakage**: the existing `format=graph` path is owner‑passthrough; naive reuse exposes the whole vault graph. `/p/:slug/graph` MUST build nodes from the tag's notes and **drop any edge whose endpoint isn't in the published set**.
- **Wikilink existence probing**: resolving `[[target]]` against the whole vault lets a reader probe private notes. Public resolution matches **only** the publication's list; non‑matches render inert.
- **Read‑only renderer gaps**: Canvas (Excalidraw) and Spreadsheet may not fully disable input; Canvas especially needs a static fallback (Excalidraw is fragile per CLAUDE.md).
- **Publishing must stay strictly READ** on the public path — a stale non‑hot‑reloaded server writing through the wrong `noteKind` corrupts notes (CLAUDE.md).
- **Password only as strong as transport**: require HTTPS for password‑protected sites (HSTS only set when `appOrigin` is https).
- **Tag over‑publishing**: a broad tag (e.g. `meeting`) could expose far more than intended, including future notes. UI must show a live count and warn the publication is dynamic, not a snapshot.
- **Anon‑actor blast radius**: never wire `anyone` grants into the generic `resolveActor`; keep resolution inside `publish.ts`.
- **Open questions**: tag‑scoped only for v1 (per‑note later)? additional templates (Blog/Docs) = new registry entries; not v1.

---

### 2C. Parachute‑to‑Parachute Collaboration

#### Goals
1. Two collaborators each keep their **own** Parachute vault + token + Prism Server, while a defined set of shared docs/repos stays continuously, automatically synced — no manual push/pull.
2. Reuse the existing Yjs CRDT machinery in `collab.ts` (per‑kind seed/persist + diff) as the merge engine; no new diff/merge layer, no last‑write‑wins.
3. Implement entirely at the Prism Server layer with **zero Parachute‑core changes** for v1.
4. A concrete cross‑hub trust/identity model: each server proves identity to a peer and authorizes a peer's edits to a bounded note set, **without sharing any vault token**.
5. A "shared space" abstraction: a named, bidirectionally‑synced collection scoped by tag/path, with a stable cross‑vault identity per note.
6. A clean migration path off today's GitHub‑intermediary directory sync onto direct hub‑to‑hub CRDT sync.
7. Honesty about the small set of capabilities that genuinely require Parachute‑core changes, gated behind a clearly labeled Phase 4.

#### Design criteria
- **No vault token crosses the trust boundary.** A peer authenticates to MY server; MY server talks to MY vault with MY token. (Today only `apps/server` holds `PARACHUTE_TOKEN`; `proxyToVault` never leaks it.)
- **Parachute stays unmodified for v1.** Change detection is approximated with per‑note `updatedAt` high‑water marks + tag/path‑scoped polling — exactly what `reconcileLoadedDocs` already does. No reliance on a Parachute change‑feed/WAL cursor in Phases 1–3.
- **CRDT correctness over the wire.** The exchange unit is a Yjs update (`Y.encodeStateAsUpdate`/`Y.applyUpdate`), never a rendered‑content round‑trip. The content↔Yjs round‑trip stays the SAME per‑kind functions so server and client can never disagree on schema (the `noteKind` invariant, `collab.ts:90`).
- **Structured‑content hazards respected**: canvas re‑seed set‑by‑id, spreadsheet rebuild‑in‑place, document minimal diff — the same guards in CLAUDE.md.
- **Note identity is explicitly mapped, not assumed.** A note id is unique only within one vault; every shared note needs a persisted bidirectional mapping (my id ↔ shared key ↔ peer's id).
- **Permissions stay authoritative, extended not bypassed.** `effectiveLevel` stays the chokepoint; a peer is a new subject resolved to a Level against a workspace's grants.
- **Fail‑safe + offline‑tolerant.** If a peer is unreachable, my hub keeps working and queues outbound updates, retrying on reconnect. A down peer never blocks or corrupts local editing.
- **Revocation enforceable** within the ~60s capability cache TTL, via the same revoke‑by‑deleting‑grants model.
- **No silent corruption on kind divergence.** Kind is agreed per shared note and pinned in the mapping; mismatched inbound updates are rejected.

#### Product requirements
- Create a "Shared Space" from a tag query or path prefix and invite a peer (own Parachute), choosing view/suggest/edit.
- Once established, edits on either hub appear on the other continuously (target: seconds, bounded by the reconcile interval), no manual action.
- Documents/code/spreadsheets sync with true CRDT merge; canvas syncs element‑by‑element (the four kinds `collab.ts` supports).
- A `suggest`‑level peer's changes arrive as pending suggestions on the owner's hub, not direct mutations (mirrors `authorizeConnection`'s read‑only‑below‑`suggest` behavior).
- New notes matching scope auto‑include and propagate; notes leaving scope stop syncing ("scope is a filter, not a copy").
- Federated notes are visibly marked ("shared from/with <peer>") with per‑space sync status (synced/syncing/queued‑offline/conflict).
- Revoke a peer at any time; they stop receiving updates and lose push within ~60s.
- Existing GitHub directory‑sync bindings migrate to a direct shared space without data loss.

#### Recommended approach — a Yjs federation provider inside Prism Server
For every note in a shared space, the **existing server‑side Y.Doc is the sync unit**, exchanged with the peer over an authenticated WebSocket — no Parachute‑core changes for v1.

- **Why this layer.** `collab.ts` already runs a Hocuspocus/Yjs server that self‑seeds each note's Y.Doc from Parachute and persists it back per kind. That Y.Doc is the perfect CRDT sync unit. Add a FederationProvider that, per shared note, maintains a Y.Doc on MY server, subscribes to updates, ships them to the peer, and applies inbound peer updates with a distinct `PEER_ORIGIN` tag (extending the `EXTERNAL_ORIGIN` pattern) so they round‑trip to MY Parachute via the SAME `storeDocumentState` path. Yjs guarantees convergence regardless of delivery order.
- **Trust/identity.** Two servers can't validate each other's hub JWTs (issued by each owner's own hub). Establish a **pairwise** relationship: each server holds an Ed25519 keypair; exchange **public** keys out‑of‑band via a one‑time pairing code (same UX as `invite.ts`). Every federation request/WS connection is signed by the sender and carries a workspace‑scoped assertion; the receiver verifies against the stored peer pubkey, then runs the SAME `effectiveLevel(grants, {workspace}, false)` math — the peer is a new `subject_type='peer'`. This mirrors capability links exactly (HMAC → grants lookup becomes Ed25519 → grants lookup). No vault token crosses; each side authorizes against its OWN grants and talks to its OWN vault.
- **Note identity across vaults.** Mint a content‑independent `space_note_key` (UUID) when a note first enters a space on the originating hub; store a bidirectional map in `federated_notes(space_id, space_note_key, local_id, kind, …)`. The peer stores the inverse (key → THEIR local id, namespaced under `vault/shared/<space>/`). The Yjs `documentName` for federation is the `space_note_key`, so both servers address the same CRDT regardless of differing local ids. This is the direct evolution of the GitHub `id_map`.
- **CRDT transport.** Reuse Hocuspocus framing: MY server acts as a Yjs **client** to the peer's `/collab` endpoint (`documentName=space_note_key`, peer token via the `?t=` param `authorizeConnection` already reads). The peer's `authorizeConnection` is extended to recognize peer tokens and resolve a Level. Both servers then hold a live Y.Doc for the same key and Hocuspocus keeps them convergent — Hocuspocus as a *server‑to‑server* federation provider. A `federation_outbox` table buffers `Y.encodeStateAsUpdate` deltas when the peer WS is down; on reconnect we flush (Yjs is idempotent under replay). No Parachute change‑feed required — MY server owns the Y.Doc and the reconciler already detects external Parachute edits via `updatedAt` and folds them into the live doc, which naturally propagates to the peer.
- **Conflict/merge.** For document/code/spreadsheet, Yjs CRDT *is* the merge. For canvas, set‑by‑id Y.Map gives element‑level LWW. The only policy decision is the boundary between CRDT state and Parachute's authoritative content: when both a peer update and a local external Parachute edit race, keep the existing rule "external Parachute edit wins for the overlapping region" and fold both into the one shared Y.Doc. Suggest‑level peers do **not** merge into the live doc; their updates land in a durable pending‑suggestions store keyed by `space_note_key`.
- **Shared space / repo.** A shared space is a `tag:workspace` note on the owner's hub naming scope (include/exclude tags, path prefix), members (peer pubkey + email + level), and `space_id`. Membership reuses the SAME scope‑filter logic the gateway already uses (`visibleNotes`, `api.ts:70`). A "shared repo" is just a space of code‑kind notes (Y.Text → line‑level merge, strictly better than Git‑blob diff).
- **Migration.** A one‑time importer reads a `DirectorySyncConfig`, mints a `space_note_key` per `id_map` entry, and creates a space scoped to the binding's `vault_path`. CRDT merge replaces whole‑file local/remote‑wins — strictly safer, no data‑loss window. No flag‑day: a space can run both github‑sync and peer‑sync during transition.

#### Key code references (path → change)

| Path | Change | Verified anchor |
|---|---|---|
| `apps/server/src/collab.ts` | Core reuse target. Extend `authorizeConnection`/`resolveLevel` to recognize a peer‑signed token and resolve a Level against workspace grants. Add a FederationProvider per `space_note_key` with a new `PEER_ORIGIN` (parallel to `EXTERNAL_ORIGIN`) so `storeDocumentState` writes peer updates back to MY vault via the SAME per‑kind path. Reuse `loadDocumentState`, the per‑kind seed/serialize fns, and `applyExternalContent` verbatim — they are the merge engine; the reconciler already fans external edits out to peers. | confirmed: `noteKind` line 90, seed fns lines 48–120, `EXTERNAL_ORIGIN` pattern + reconcile per dossier |
| `apps/server/src/db.ts` | Add `peers(pubkey, email, label, created_at, paired_at)`; `federated_notes(space_note_key PK, space_id, local_id, kind, peer_synced_at, source_updated_at)`; `spaces(id, scope_include_tags, scope_exclude_tags, path_prefix, created_by)`; `federation_outbox(space_note_key, update BLOB, queued_at)`. Extend grants with `subject_type='peer'`, `resource_type='space'`. | confirmed: grants schema lines 33–44, `ResourceType` is `'note'\|'tag'` line 83 |
| `apps/server/src/permissions.ts` | `effectiveLevel` (line 36) stays the single guard. Extend `NoteRef` matching (or a sibling) so a `resource_type='space'` grant matches when the note's `space_note_key` belongs to that space. The `view<comment<suggest<edit<own` ladder is reused unchanged. | confirmed: `effectiveLevel` line 36, ladder line 13 |
| `apps/server/src/auth/capability.ts` | Reuse as the template for `auth/peer.ts`: prove "pubkey K + workspace + not‑expired" via Ed25519, then look up peer grants; same revoke‑by‑deleting‑grants story. | confirmed: capability module exists |
| `apps/server/src/config.ts` | Add optional `PEER_SIGNING_KEY` (this server's Ed25519 private key) + `FEDERATION_ENABLED`. No secondary vault token — each server uses only its OWN `parachuteToken`. | per dossier |
| `apps/server/src/routes/api.ts` | Reuse `visibleNotes` (line 70) verbatim to compute a space's current membership. Add a `/api/federation/*` group (handshake, inbound‑suggestion, presence) registered **before** the owner short‑circuit (line 51) so peer requests authorize by signature, not owner passthrough or the 403 catch‑all. New server route → add to the PWA denylist. | confirmed: owner short‑circuit line 51, `visibleNotes` line 70 |
| `apps/server/src/parachute.ts` | Reuse unchanged: `createNote` under `vault/shared/<space>/...` for new incoming notes, `updateNote` for updates. No change‑feed method — change detection stays the `updatedAt` high‑water mark. | per dossier |
| `apps/desktop/src-tauri/src/sync/adapters/github.rs` | Migration source: `id_map` (HashMap<note_id, file_path>) is the ancestor of `federated_notes`; the importer seeds `space_note_key`s. The four‑way `conflict_strategy` (local/remote‑wins) is what CRDT merge replaces. | per dossier |
| `packages/core/src/data/VaultClient.ts` | UI seam: federated notes need a marker (`_federated_from`/`_space`) + `getSpaces()`/`spaceStatus()` so renderers can show "shared with <peer>" + sync status without coupling UI to transport. | per dossier |

#### Risks / open questions
- **Genuinely needs Parachute‑core (Phase 4 only, never a blocker for 1–3):** (1) an efficient change feed — v1 polls scope + per‑note `updatedAt` (O(notes‑in‑scope) per tick per space, won't scale large); (2) scoped MCP for a peer's *agent* (Prism‑side filtering is bypassable); (3) server‑enforced per‑note ACLs inside Parachute (deferred — v1 never gives a peer direct vault access).
- **Note‑identity drift / split‑brain**: a lost `space_note_key` row on one side can duplicate the note on re‑sync. Treat the key as durable, back it up with docState, reconcile by key not content (cross‑hub analog of "Y.Array can double if docState is lost").
- **Kind divergence corruption, amplified**: if hub A treats a note as document and hub B as canvas, the shared Y.Doc structure mismatches and the note is destroyed on one side. Pin kind in `federated_notes` at join; reject inbound updates whose kind disagrees.
- **Wikilinks across the namespace boundary**: incoming notes namespaced under `vault/shared/<space>/`; cross‑vault links are explicitly **not** perfectly rewritten in v1 — out‑of‑space links render dangling (flagged non‑goal).
- **Revocation latency**: removing a peer stops new acceptance within ~60s, not instantly; a mid‑edit peer may land one more update. Acceptable for v1.
- **Trust bootstrap is the weakest link**: the pairing handshake is only as safe as the out‑of‑band channel. Use short‑lived single‑use pairing codes (reuse `invite.ts` TTL+hash) and display a key fingerprint for both owners to verify.
- **Suggest‑mode persistence**: pending peer suggestions must survive a server crash (today suggests are read‑only‑connection only and never persisted). A durable pending‑suggestions table is **required**, not optional.
- **Polling load O(n·m)**: per‑space adaptive intervals + presence‑driven Y.Doc opening (idle notes sync lazily).
- **Circular federation**: detect by `space_note_key` provenance and refuse to re‑federate a key that originated from the same peer (Yjs prevents corruption, but loops waste traffic).

---

## 3. Master Phased Rollout

Phases are program‑wide. Within a phase, **work‑streams (= swarm lanes) run concurrently** unless a dependency arrow says otherwise. A **barrier** is a hard convergence gate: all streams feeding it must merge and pass the gate's check before the next phase's dependent streams start.

### Cross‑area dependency map (the shared seam)

```
                       ┌──────────────────────────────────────────────┐
                       │  SHARED ACTOR / PERMISSION / DB SEAM           │
                       │  permissions.ts · actor.ts · db.ts · collab.ts │
                       └──────────────────────────────────────────────┘
                          ▲                ▲                  ▲
        Onboarding A      │   Publishing   │   P2P Collab     │
   reads actor.isOwner ───┘  adds `anyone` ─┘  adds `peer` ───┘
                              (synthetic       (Ed25519 +
                               anon @ /p)       resource_type='space')
```

- **Publishing's public‑anon‑render path** and **Onboarding's viewer detection** both touch the actor/permission layer, but from opposite ends: Onboarding *reads* `isOwner`; Publishing *writes/reads* `anyone` grants. They do not conflict at the file level if Publishing keeps `anyone` resolution inside `publish.ts` (never in `resolveActor`). **Coordination point:** any change to `actor.ts`'s shape is a barrier both must respect.
- **Publishing** and **P2P** both extend `effectiveLevel`/`db.ts` grant model (`anyone`+`publications` vs `peer`+`spaces`). These are **additive, non‑overlapping rows/tables** but **same files** → isolation‑sensitive; serialize the `db.ts` and `permissions.ts` edits behind a single integration owner per phase (see §4).
- **Publishing** and **P2P** both reuse the read‑only renderer + `RendererProps.readOnly` work and the extracted `Backlinks`/`PublicNoteRenderer` components. Land the `@prism/core` additive contract **once**, early, and both consume it.
- **Onboarding's canonical `tag-schemas.json`** unblocks the `content-types.ts` ⇄ `vault.rs` reconciliation, which de‑risks every renderer‑selection path the other two horizons rely on.

### Phase table

| Phase | Objective | Parallel work‑streams (lanes) | Dependencies / sequencing | Barrier gate (convergence) |
|---|---|---|---|---|
| **P0 — Foundations & seams** | Land every additive seam the other phases build on, with zero behavior change. | **L‑Onb‑A1**: `skipOnboarding` prop + gate in `App.tsx`. **L‑Core‑RO**: `RendererProps.readOnly` + make callbacks optional (`RendererProps.ts`). **L‑Schema**: author canonical `tag-schemas.json`. **L‑Pub‑DB**: `publications` table + helpers in `db.ts`. **L‑P2P‑DB**: `peers`/`spaces`/`federated_notes`/`federation_outbox` tables + grant `subject_type='peer'`/`resource_type='space'` in `db.ts`. **L‑Perm**: extend `effectiveLevel` for `space` membership (pure fn + tests). | L‑Pub‑DB and L‑P2P‑DB **both edit `db.ts`** → serialize behind one DB owner (single PR sequence). L‑Perm depends on L‑P2P‑DB grant shape. All others independent. | **B0:** `npx tsc --noEmit` clean across workspaces; `cd apps/server && npm run typecheck`; `cargo check`; desktop first‑run onboarding visually unchanged. DB migrations apply idempotently on an existing dev DB. |
| **P1 — First end‑to‑end wins** | Ship the viewer‑skip fix; expose a single published note read‑only; prove the peer trust handshake. | **L‑Onb‑A2**: wire `apps/web/src/main.tsx` to pass `skipOnboarding=isViewer`; `VITE_WEB_OWNER_ONBOARDING` flag. **L‑Pub‑Spine**: `publish.ts` manifest + single‑note endpoint, `app.route('/p')` mount, vite denylist `/^\/p\//` + runtimeCaching, `main.tsx` `/p` route, minimal `PublicationView` (one note read‑only). **L‑Pub‑ACL**: `POST/DELETE /tags/:tag/publish` + `GET /publications` in `acl.ts`. **L‑Core‑RO‑impl**: honor `readOnly` in Document/Code/Spreadsheet/Canvas renderers. **L‑P2P‑Trust**: `auth/peer.ts` (Ed25519 keygen/sign/verify) + pairing‑handshake route + `peers` table wiring + fingerprint display. | L‑Pub‑Spine depends on P0 L‑Pub‑DB helper signatures and L‑Core‑RO contract. L‑Onb‑A2 depends on P0 L‑Onb‑A1 (the prop must exist). L‑P2P‑Trust depends on P0 L‑P2P‑DB (`peers`). | **B1:** viewer (capability + invited non‑owner) lands in Shell with no wizard (manual + Playwright); `curl /p/:slug/notes/:id` returns a sanitized read‑only note for a test slug and **403** for an out‑of‑publication note; the same page renders in‑browser (denylist verified). Pairing handshake establishes a verified peer record. |
| **P2 — Depth: Wiki + bidirectional CRDT** | Quartz‑parity reader; two hubs merging edits both ways. | **L‑Pub‑Wiki**: template registry + WikiTemplate slots (nav, TOC, search), scoped wikilink `onNavigate`, extracted `Backlinks`. **L‑Pub‑Graph**: `/p/:slug/graph` scoped node build + **edge filtering** + client graph. **L‑P2P‑Mirror**: one‑way mirror — originating hub mints `space_note_key`s and pushes Yjs updates to the peer's `/collab`; peer applies with `PEER_ORIGIN` + persists to namespaced notes; **kind‑pinning** in `federated_notes`. **L‑P2P‑Bi**: bidirectional `edit`‑level merge + `federation_outbox` flush on reconnect + external‑Parachute‑edit‑vs‑peer race rule. **L‑Onb‑Schema2**: refactor `TAG_TO_CONTENT_TYPE` + Rust `tag_map` to derive from / assert against `tag-schemas.json`; reconcile `dashboard` mapping. | L‑Pub‑Graph and L‑Pub‑Wiki share the manifest shape (mockable, parallel). L‑P2P‑Bi depends on L‑P2P‑Mirror (mapping + kind‑pinning must be solid first). L‑Onb‑Schema2 depends on P0 L‑Schema. | **B2:** public Wiki site browsable (nav + wikilinks + backlinks + search) with **no private node/edge in `/p/:slug/graph`** (leak test); a `_test` note edited concurrently on two hubs converges with no loss; `inferContentType` resolves all 29 tags identically pre/post mapping refactor (assertion test). |
| **P3 — Hardening, gates, suggest‑mode, setup tooling** | Make it safe, operable, and self‑provisioning. | **L‑Pub‑Pwd**: `publications.password_hash` + `POST /p/:slug/auth` scrypt gate + cookie middleware + UI. **L‑Pub‑UX**: extend the Share dialog with a Publish tab (tag, template, password, expiry, URL, note‑count warning) + publications list/unpublish. **L‑Pub‑Sec**: `verify-gateway.ts` assertions (anon scope, no token, out‑of‑pub 403, graph filtering, password). **L‑P2P‑Suggest**: durable pending‑suggestions store + accept/reject API. **L‑P2P‑UX**: federated markers + per‑space sync status + Share‑a‑Space dialog (`VaultClient` fields). **L‑Onb‑Seed**: shared `seedTagSchemas()` lib → `prism-setup` SKILL + `seed.ts`. **L‑Onb‑CLI**: `prism setup` orchestrator (vault check, mint token, run seed, write configs) porting `bootstrap.sh`. | L‑Onb‑Seed (shared lib) blocks L‑Onb‑CLI and the skill. L‑Pub‑Sec depends on all Publishing routes existing. L‑P2P‑Suggest depends on P2 L‑P2P‑Bi. | **B3:** `verify-gateway.ts` passes incl. new publish assertions; password‑gated publication enforces correctly under HTTPS; a `suggest`‑level peer's change lands as a pending suggestion (survives a server restart); `prism setup` provisions a fresh vault to 29 seeded tags + valid config in one run, and is a no‑op on an already‑seeded vault. |
| **P4 — Packaging, migration, optional accelerators** | Ship the plugin, migrate GitHub bindings, document, and (optionally) adopt Parachute‑core accelerators. | **L‑Onb‑Plugin**: `.claude-plugin/plugin.json` + `.mcp.json.template` + `validate_config` Tauri cmd. **L‑Onb‑Docs**: `docs/onboarding.md` + CLAUDE.md update. **L‑P2P‑Migrate**: GitHub `id_map` → `space_note_key` importer (no flag‑day; both channels co‑exist). **L‑Pub‑Docs**: HTTPS/password publishing docs + the SW‑denylist automated check. **L‑P2P‑Accel (optional, Parachute‑core)**: change‑feed cursor, scoped peer‑agent MCP, push revocation — accelerators only. | L‑Onb‑Plugin depends on the Claude Code plugin schema being verified (risk). L‑P2P‑Accel is independent and never blocks 1–3. | **B4 (release):** plugin `/plugin install` works against the verified schema; a migrated GitHub binding syncs peer‑to‑peer with no data loss while the Git channel stays passive; docs complete; full `tsc`/`typecheck`/`cargo check`/`verify-gateway` green. |

**What runs concurrently vs what blocks (at a glance):**
- **Maximally concurrent in P0:** all six lanes, except the two `db.ts` lanes serialize.
- **P1 is the widest fan‑out:** five independent lanes; only L‑Onb‑A2 and L‑Pub‑Spine have a P0 dependency.
- **Hard blockers:** P0 `db.ts`/`permissions.ts`/`RendererProps.ts` seams block their respective P1+ consumers; `tag-schemas.json` (P0) blocks the P2 mapping refactor; `seedTagSchemas()` (P3) blocks the CLI and skill; Mirror→Bi→Suggest is a strict P2→P2→P3 chain.

---

## 4. Swarm Orchestration Model

### Lanes and ownership

Each lane is owned by **one agent** (the *lane lead*); high‑surface lanes get a second agent as *reviewer/pair*. Lane IDs match §3.

| Lane | Agents | Owns (files) | Isolation‑sensitive? |
|---|---|---|---|
| **DB‑Integration** (absorbs L‑Pub‑DB + L‑P2P‑DB) | 1 lead | `apps/server/src/db.ts` (publications + peers/spaces/federated_notes/outbox + grant enum) | **YES** — single writer; both horizons' schema lands through this one lane, serialized. |
| **Perm‑Integration** (L‑Perm) | 1 lead | `apps/server/src/permissions.ts`, `apps/server/src/auth/actor.ts` | **YES** — the shared chokepoint; only this lane edits these two files. |
| **Core‑Contract** (L‑Core‑RO + L‑Schema) | 1 lead + 1 reviewer | `RendererProps.ts`, the four renderers, `tag-schemas.json`, `Backlinks`/`PublicNoteRenderer` extraction | Partly — `RendererProps.ts` is a one‑time additive edit consumed by two horizons; land early, freeze. |
| **Onb‑Web** | 1 lead | `packages/core/src/App.tsx`, `apps/web/src/main.tsx` (onboarding branch only) | Shares `main.tsx` with Pub‑Web → coordinate route‑branch insertions. |
| **Onb‑Setup** | 1 lead | `seedTagSchemas()`, `prism-setup` skill, `apps/cli`, `setup.ts`, plugin manifest, `.mcp.json.template`, `config.rs` validate | No — mostly new files. |
| **Onb‑Mapping** | 1 lead | `content-types.ts` mapping, `vault.rs` `tag_map` | No — but must wait on Core‑Contract's `tag-schemas.json`. |
| **Pub‑Server** | 1 lead | `apps/server/src/routes/publish.ts` (new), `acl.ts` publish endpoints, `app.ts` mount | `acl.ts`/`app.ts` are shared → small, well‑scoped diffs. |
| **Pub‑Web** | 1 lead + 1 reviewer | `apps/web/src/publish/*` (new), `apps/web/src/main.tsx` `/p` branch, `vite.config.ts` denylist | Shares `main.tsx`/`vite.config.ts` with Onb‑Web → coordinate. |
| **Pub‑Sec** | 1 lead | `apps/server/scripts/verify-gateway.ts` | No — append‑only assertions; gates release. |
| **P2P‑Transport** | 1 lead + 1 reviewer | `apps/server/src/collab.ts`, `apps/server/src/auth/peer.ts` (new), `routes/api.ts` federation group, `parachute.ts` reuse | **YES** — `collab.ts` is fragile (CLAUDE.md: stale server corrupts notes); single writer, throwaway `_test` notes only. |
| **P2P‑UX** | 1 lead | `VaultClient.ts` fields, Share‑a‑Space dialog, federated markers | No — frontend, parallel once interface fields agreed. |
| **P2P‑Migrate** | 1 lead | GitHub `id_map` importer (standalone tool) | No. |

### Coordination / merge protocol
- **Worktrees per lane.** Each lane works in its own git worktree off a shared `program/<phase>` integration branch. No lane edits another lane's owned files; cross‑file touches go through the owning lane via a small request PR.
- **Hotspot single‑writer rule.** `db.ts`, `permissions.ts`, `actor.ts`, and `collab.ts` are **isolation‑sensitive** (parallel mutation = corruption/merge hell). Each has exactly one owning lane per phase; all schema/permission/transport changes from other horizons are submitted *to* that lane as typed‑interface requests, not direct edits. `main.tsx` and `vite.config.ts` are shared by Onb‑Web + Pub‑Web → both insert into disjoint, clearly‑commented regions (route branches at distinct path patterns; denylist additions appended).
- **Contract‑first.** Before consumers start, the owning lane publishes the TypeScript interface/signature (e.g. `RendererProps.readOnly`, `createPublication(...)`, `getSpaces()`). Consumers code against the published signature with mocks/fixtures; integration happens at the barrier.
- **Review gates.** Every PR: `npx tsc --noEmit` (+ `apps/server` typecheck, `cargo check` for Rust lanes) green; a peer‑lane review for hotspot files; security‑sensitive PRs (anything touching `permissions.ts`, `actor.ts`, `publish.ts`, `auth/peer.ts`) require a Pub‑Sec/Perm‑Integration sign‑off. **Restart pm2 `prism-server` after any server change** before testing (CLAUDE.md — it does not hot‑reload; a stale `noteKind` corrupts notes).
- **Barriers (B0–B4) are merge‑freeze checkpoints.** At each barrier, all feeding lanes merge to the integration branch, the gate's automated checks (typecheck/build/`verify-gateway`/Playwright) run, and only then are the next phase's dependent lanes unblocked. No lane proceeds past a barrier on a red gate.
- **Isolation for collab tests.** P2P‑Transport and Pub renderer tests run against throwaway `_test` notes and mint capabilities/peer tokens against a disposable DB+secret (the existing collab‑test methodology). Bust the PWA service worker between web tests or you test stale JS.

### Which lanes are isolation‑sensitive (must serialize file mutation)
`DB‑Integration` (`db.ts`), `Perm‑Integration` (`permissions.ts`/`actor.ts`), and `P2P‑Transport` (`collab.ts`) — single writer, no concurrent edits. The shared web‑entry files (`main.tsx`, `vite.config.ts`) are *semi*‑sensitive: concurrent but only in disjoint regions, reconciled at each barrier.

---

## 5. Sequencing Recommendation — build order and why

1. **Onboarding Part A (viewer skip) — ship first.** It's the smallest change (a prop + a gate flip at `App.tsx:66` + one line in `main.tsx`) and it fixes a **live broken‑screen bug** for every web viewer today (capability‑link and invited non‑owner users currently get wizard‑trapped). Highest value‑per‑line; unblocks nothing but costs almost nothing and de‑risks the whole web sharing story.
2. **The P0 shared seams — next, in parallel.** `RendererProps.readOnly`, `tag-schemas.json`, the `db.ts` tables, and the `effectiveLevel` extension. These **unblock the most downstream work**: read‑only renderers feed both Publishing and (indirectly) the P2P UI; the schema source unblocks the mapping reconciliation; the DB tables + permission extension are prerequisites for *both* Publishing and P2P. Doing the seams first means Phase 1's five lanes can fan out with no further blocking.
3. **Publishing spine (P1) — third.** It's the shortest path to a second visible, demoable win (an anonymous read‑only note off the live server) and it exercises the `anyone`‑grant + synthetic‑actor pattern end‑to‑end, validating the trust boundary on the simplest possible surface before the Wiki depth lands. It depends only on the P0 seams.
4. **P2P trust handshake (P1, concurrently).** Pure plumbing (`auth/peer.ts` + pairing), independently testable, and it de‑risks the hardest open question (cross‑hub identity without a shared issuer) **before** any transport work commits. Land it early so P2 Mirror→Bi has a verified trust base.
5. **Then depth (P2): Wiki + bidirectional CRDT**, then **hardening + setup tooling (P3)**, then **packaging/migration/accelerators (P4)** — in the phase order above.

**Rationale summary:** lead with the cheapest live‑bug fix (Onboarding A), then pour effort into the **shared seams** that unblock the most lanes, then take the **shortest path to each horizon's first end‑to‑end demo** (publish‑one‑note, peer‑handshake) before investing in depth. The two Parachute‑core‑dependent items (P2P accelerators) are deliberately last and optional — nothing in Horizons A/B and Phases 1–3 of C blocks on Aaron's roadmap.

---

### Appendix — verified anchor index (opened during planning)
`packages/core/src/App.tsx:66` (onboarding gate) · `apps/web/src/main.tsx:47,71,83,100,102,126` (capability/share/collab/fetchMe/render) · `apps/server/src/permissions.ts:13,36` (level ladder, `effectiveLevel`) · `apps/server/src/db.ts:33–44,55–60,82–83` (grants schema, `anyone`, collab_docs, `ResourceType`) · `apps/server/src/routes/api.ts:30,51,70` (`proxyToVault`, owner short‑circuit, `visibleNotes`) · `apps/server/src/routes/acl.ts:39,52` (`upsertGrant`, owner‑only guard) · `apps/server/src/app.ts:39,49,78–80` (CSP, HSTS, SPA fallback mount point) · `apps/server/src/collab.ts:43–120` (FIELD, per‑kind seed fns, `noteKind`) · `packages/core/src/lib/schemas/content-types.ts:38–72` (`TAG_TO_CONTENT_TYPE`) · `apps/desktop/src-tauri/src/commands/vault.rs:40–66` (`tag_map`, `dashboard→project` drift) · `packages/core/src/components/renderers/RendererProps.ts:3–7` (required callbacks) · `apps/web/vite.config.ts:59` (`navigateFallbackDenylist`). Parachute vault confirms 29 schema'd tags.
