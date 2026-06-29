# Desktop vs Web/PWA Feature Divergence & Parity Plan

> Status: research + plan (no app code changed). Authored 2026-06-28.
> Scope: maps what works on **desktop** (Tauri, Rust backend on the host) vs the **web PWA** (`apps/web` → Prism Server gateway `apps/server`), classifies every capability, and proposes a concrete parity roadmap. Special focus: **monitoring + triggering agent skills / `claude -p` from the web**.

## TL;DR

Prism ships one React core (`packages/core`) over two shells. The web shell wires the **vault CRUD + search + graph + tags + links** path and the **entire sharing / publishing / federation / multi-vault / collab** path correctly (the latter via the `useCollabSharing()` / `useVaultClient()` seams, not `invoke`). Everything that depends on the desktop Rust backend's external integrations — **AI agent, Gmail, Calendar, Matrix, Notion-DB sync, GitHub sync, the generic sync engine, native config writes, CLI/connection tests** — is in the browser either a **hard throw** or a **hollow empty-stub** (`apps/web/src/tauri-shim/core.ts:103-104` rejects any unhandled command with `"… is not available in Prism Web"`).

The critical UX trap: **Settings renders but silently fails to save** — `get_full_config` is stubbed to `{}` so the panel mounts, but every write (`update_config`, `set_anthropic_key`, `set_skill_model`) throws, and most call sites have **no error handling**, so the user sees nothing happen.

Classification counts (capabilities, not individual commands):

| Class | Meaning | Count (approx) |
|---|---|---|
| **A — inherently desktop/local** | needs host creds / CLIs / processes / files | ~14 capability groups |
| **B — already web-served** | the gateway already proxies it for the owner | 4 groups (vault CRUD, semantic search, ACL/share, embedding index) |
| **C — bringable-to-web** | server runs on host, could expose it | the headline: **agent skills + `claude -p` + local models**, plus markdown convert, wikilink resolve, URL/key probes |

**Top 5 recommendations**
1. **Gate the dead panels now** (quick win, ~0.5 day): hide or "desktop only" the credential/sync/agent panels that silently fail in the browser (full list below). This stops the worst trap (Settings looking saveable but discarding writes).
2. **Bring agent-skills *monitoring* to web first** (~1 day): skills (`agent-skill`) and dispatch history (`agent-dispatch`/`agent-output`) are **already vault notes** — the owner passthrough means the web app can list/read them today with zero new endpoints. Make the `agent-activity` tab read from the vault instead of `invoke`.
3. **Add an owner-only dispatch-trigger endpoint on the server** (~3-4 days): a new `/api/agent/*` router (mounted before the gateway, owner-gated like `/acl`) that spawns `claude -p` on the host with the same bounded args the desktop uses. This is the owner's top ask and is feasible because the server runs on the same machine as Parachute + Claude.
4. **Add live status via SSE/WS** (~1-2 days, after #3): the desktop only ever polls its in-memory `DispatchManager`; the server can stream run status to the browser over SSE, and the in-memory list problem disappears because durable history is already in the vault.
5. **Local/Ollama models over web** (~2 days, optional): the server can proxy to the host's local OpenAI-compatible endpoint (`/v1`) for owner-only model listing + structured runs.

**Agent-skills-over-web verdict:** Feasible and high-value. ~1 day for monitor (read-only, vault-backed), ~3-4 days for trigger (`claude -p` executor on the server), ~1-2 days for live streaming. Total ~1 week for a real owner-only "Agent" surface in the browser. The dominant risk is **arbitrary-command-execution**: the server gains the power to spawn `claude -p` with host permissions, so it must be strictly owner-gated (session cookie, not capability/anon), bounded to a fixed arg template, and never accept a free-form command line from the client.

---

## 1. Divergence table

Legend — **D**: desktop status, **W**: web status. Class A/B/C as above. Effort is rough (S < 1d, M 1-3d, L 3-5d).

| Capability | D | W today | Class | Effort to web | Recommendation |
|---|---|---|---|---|---|
| **Vault CRUD / search / tags / links / graph** (`vault_*`, `commands/vault.rs`) | full | **full** (REST via `apps/web/src/parachute/rest.ts`; shim `core.ts:26-68`) | B | — | done |
| **Semantic search / reindex** (`commands/semantic.rs:13,25,47`) | client of server | **full** (`/api/search/semantic`; `rest.ts:191`) | B | — | done (desktop is itself just a server client) |
| **Sharing / capability links / people grants** (`acl_request`, `config.rs:559`) | bridges to server | **full** (`apps/web/src/collab/grant.ts`, owner-only `/acl`) | B | — | done |
| **Publishing / federation / spaces / multi-vault** | bridges to server | **full** (`grant.ts:72-228`; Network panels use no `invoke`) | B | — | done — the model for all WIRE work |
| **Live collab editing** (Yjs, all 4 kinds) | in-app swap | **full** (`apps/web/src/collab/*`, `/collab` WS) | B | — | done |
| **Markdown ⇄ HTML** (`commands/convert.rs`) | Rust | **full** (client-side `marked`/Turndown; `core.ts:71-74`) | C→done | — | done |
| **Wikilink resolution** (`commands/wikilinks.rs`) | Rust over vault | **degraded** — returns content unchanged / `[]` (`core.ts:77-80`) | C | S | WIRE (vault-read; do client-side or server) |
| **Matrix messaging** (`matrix_*`, `commands/matrix.rs`; `message_sync`) | full | **dead** (throws) / sync N/A | A | — | leave-desktop (host token; not in gateway) |
| **Gmail** (`gmail_*`, `commands/google.rs` via `gog` CLI) | full | **dead** (throws) | A | — | leave-desktop (`gog` binary + keychain) |
| **Calendar** (`calendar_*`; `calendar_sync`) | full | **dead** (throws) | A | — | leave-desktop (`gog` binary) |
| **Agent — interactive** (`agent_chat/edit/transform/generate`, `commands/agent.rs`) | full (`claude -p`) | **dead** (throws) | **C** | L | **bring-to-web** (server spawns `claude -p`) |
| **Agent — skills list/edit** (`agent_get_skills`, `agent_update_skill`) | Tauri | **stub `[]`** (`core.ts:93-94`) | **C** | S | **bring-to-web** (skills are vault notes — read via passthrough) |
| **Agent — dispatch trigger/cancel** (`agent_dispatch`, `agent_cancel_dispatch`, `service_cmds.rs:85,147`) | full | **dead** (throws) | **C** | L | **bring-to-web** (new `/api/agent` executor) |
| **Agent — dispatch history/monitor** (`agent_get_dispatches`) | in-memory poll | **stub `[]`** (`core.ts:92`) | **C** | S/M | **bring-to-web** (history is `agent-dispatch` vault notes; live via SSE) |
| **`agent-activity` virtual tab** (`AgentActivity.tsx`, `Canvas.tsx:22`) | works | **renders but inert** (empty lists, actions throw) | C | M | bring-to-web (rewire to vault + new endpoints) |
| **Local/Ollama models** (`ollama_cmds.rs`, `ModelRouter`) | full | **stub** (`ollama_status`→false, models→`[]`) | A/C | M | bring-to-web (server proxies host `/v1`) — owner-only |
| **GitHub sync** (`github_cmds.rs` via `git`+`gh`) | full | **stub/dead** (`github_check_auth`→`{authenticated:false}`; init throws) | A | — | gate-clearly (needs `gh` CLI + local working tree) |
| **Notion-DB sync** (`notion_db_cmds.rs`) | full | **stub/dead** (`notion_db_list`→`[]`; init throws) | A | (L) | gate-now; WIRE later (server could hold Notion key) |
| **Notion pages embed** (`notion_list_pages`) | full | **dead** (throws, loud) | A | (M) | gate-now |
| **Generic sync engine** (`sync_*`, `commands/sync_cmds.rs`, 4 adapters) | full | **dead** (throws) | A | — | gate-clearly (adapters lean on host CLIs/tokens) |
| **Transcript sync** (Fathom/Fireflies/Meetily; `transcript_sync`) | full | N/A (background) | A | — | leave-desktop (host API keys + local SQLite) |
| **Config writes** (`update_config`, `set_anthropic_key`→Keychain) | full | **dead** (silently throws) | A | — | gate-clearly (desktop owns `prism-config.json` + Keychain) |
| **Connection tests** (`test_parachute/matrix/notion/local_ai`, `check_claude_cli/google_cli`, `discover_meetily_path`) | full | **dead** (throws) | A (some C) | S each | gate-now; `test_parachute`/`test_notion` are C (server could probe) |
| **Service status / health** (`get_service_status`, `check_services`) | full | **stub `[]`/canned** | A | M | gate-now; could WIRE if services move to server |
| **Editor IPC** (`editor_set_content`, `editor_replace_selection`) | Tauri window events | N/A (web editor uses React paths) | A | — | leave-desktop (shell-specific) |

---

## 2. Dead web panels to GATE now (file:line)

These render in the browser (no platform gate exists — `Shell.tsx` mounts Settings/CommandBar/agent tab unconditionally; the only `isViewer` gate is the onboarding wizard at `apps/web/src/main.tsx:117`) but back onto desktop-only `invoke`s. Most have **no try/catch**, so the failure is **silent**. Gate = hide the control in web, or render a "Desktop only" notice.

| # | Panel | file:line | Failing invoke(s) | Symptom |
|---|---|---|---|---|
| 1 | Settings · Core Services credentials (Parachute/Matrix/Google/Claude fields) | `packages/core/src/components/layout/Settings.tsx:143-202`, save at `:82` | `update_config` | **silent** — "saved" check never appears |
| 2 | Settings · AI Models skill matrix | `Settings.tsx:333-377` (handler `:74`) | `set_skill_model`; `ollama_list_models` (stub `[]`) | **silent** — dropdowns empty, change discarded |
| 3 | Settings · Local AI sub-panel | `Settings.tsx:512-643` | `local_ai_list_models`, `test_local_ai`, `update_config` | shows "Unreachable"; saves silently fail |
| 4 | Settings · Data Sources (transcripts + Notion key) | `Settings.tsx:384-435`; `handleDiscoverMeetily` `:92` | `update_config`, `discover_meetily_path` | **silent** save fail; discover throws |
| 5 | GitHubSyncModal | `packages/core/src/components/layout/GitHubSyncModal.tsx:60,88` (mounted `MetadataPanel.tsx:839`, `ProjectTree.tsx:912`) | `github_check_auth` (stub), `github_sync_init` | dead-end "Not authenticated", Next disabled |
| 6 | NotionDbSyncModal | `packages/core/src/components/layout/NotionDbSyncModal.tsx:91,114,151,167` | `notion_db_list` (stub), `notion_db_schema`, `notion_db_sync_init`, `notion_db_sync` | "No databases found"; sync fails |
| 7 | AgentActivity tab — action controls | `packages/core/src/components/agent/AgentActivity.tsx:90,95,453-499` | `agent_dispatch`, `agent_cancel_dispatch`, `agent_update_skill` | **silent** — Run / toggle / edit click, nothing happens |
| 8 | MetadataPanel · Sync tab | `packages/core/src/components/layout/MetadataPanel.tsx:626-693,824` | `sync_status`, `sync_*`, `github_sync_*` | query errors / dead controls |
| 9 | MetadataPanel · Notion embed picker | `MetadataPanel.tsx:887-891` | `notion_list_pages` | **loud** ("Failed to search Notion") — has `.catch` |

**Keep visible (these actually work in web):** Settings · Vault Description (`Settings.tsx:242-319`, uses `vault_get_info`/`vault_update_description` → REST); Settings · Vaults list, Sync-direction default, Appearance/theme/fonts (`:205-240,321-331,438-491`, local Zustand only).

**Implementation note for gating:** there is no existing `isWeb`/platform flag passed into `packages/core`. The clean approach mirrors the existing onboarding gate — thread a prop/context (e.g. `platform: "web" | "desktop"`) from each shell's root (`apps/web/src/main.tsx` vs `apps/desktop` entry) into `Settings.tsx` / `AgentActivity.tsx`, and conditionally render the panels above. The Network panels (`components/renderers/network/{FederatePanel,PublishPanel,VaultsPanel}.tsx`) are the **reference pattern** — they use only the `useCollabSharing()`/`useVaultClient()` seams and work identically in both shells.

---

## 3. What's already free in the browser (no new code)

Because the gateway gives the **owner a transparent, token-free passthrough to the full Parachute REST API** (`apps/server/src/routes/api.ts:30-59` `proxyToVault` + owner short-circuit), anything that is *just vault data* is already reachable in the web app for the owner:

- **Skill definitions** are `agent-skill` notes (`skill_scheduler.rs:291-372`; path `vault/agent/skills/{slug}`). The web app can `GET /api/notes?tag=agent-skill` today.
- **Dispatch history** is persisted as `agent-dispatch` + `agent-output` notes (`agent_dispatch.rs:524-567`; path `vault/agent/dispatches/{date}/{slug}-{id}`). Readable from the browser today.
- **Agent insights / briefings / reports** produced by skills are vault notes — already visible.

So **monitoring of completed runs and editing skill cadence/prompts is a pure-frontend rewire** (swap `agentApi.*` invoke calls for `vaultApi.*` reads/writes). Only **triggering a run** and **live status of an in-flight run** need new server code.

---

## 4. Parity roadmap (prioritized)

### Phase 0 — Stop the bleeding (quick win, ~0.5 day) — GATE dead panels
Thread a `platform` flag into core and hide panels #1-#9 from §2 in the web shell (or show a compact "Manage this on the Prism desktop app" notice). Net effect: the browser stops presenting controls that silently discard input. No backend work.

### Phase 1 — Agent monitor on web (read-only, ~1 day) — vault-backed, no new endpoints
- Rewire `AgentActivity.tsx` so that, in the web shell, it sources **skills** from `tag=agent-skill` notes and **dispatch history** from `tag=agent-dispatch` notes via the existing `useVaultClient()`/REST path instead of `agent_get_skills`/`agent_get_dispatches`.
- Skill *editing* (enable/disable, interval, prompt) is already a vault `update-note` (the desktop `SkillBuilder` even creates skills via `vaultApi.createNote` directly — `AgentActivity.tsx:334-363`), so it works through the passthrough with no server change.
- Result: the owner can review every past run and tune skills from the browser. Trigger + live status still desktop-only (clearly indicated).

### Phase 2 — Trigger `claude -p` from web (~3-4 days) — new owner-only server executor
New router `apps/server/src/routes/agent.ts`, mounted **before** `app.route("/api", api)` in `apps/server/src/app.ts:98` (so the owner short-circuit doesn't proxy it to the vault), with the `/acl`-style owner-only middleware (`apps/server/src/routes/acl.ts:90-96`). Port a minimal `DispatchManager` to Node (spawn `claude -p` via `child_process`, same bounded args the desktop uses). See §5 for the full design. After this, the web "Run now" / custom-prompt controls become real.

### Phase 3 — Live status streaming (~1-2 days) — SSE
Add `GET /api/agent/runs/:id/stream` (SSE) so the browser sees a run progress live, replacing the desktop's poll-the-in-memory-map model. Durable history stays in the vault, so a server restart loses only in-flight streams, not history.

### Phase 4 — Local/Ollama models over web (~2 days, optional) — server proxy
Server proxies the host's local OpenAI-compatible endpoint (`/v1/models`, structured runs) behind owner-only `/api/agent/models`. Lets the web AI-Models panel list + select local models and run structured skills. (Pure inference proxy; lower risk than `claude -p`.)

### Phase 5 — Selective integration WIRE (larger, opportunistic)
Some Class-A items *could* migrate to the server if the owner wants them server-hosted rather than desktop-hosted (the server already holds the vault token and runs on the host):
- **Notion-DB sync / Notion pages** — server could hold the Notion key and run the sync loop (currently `notion_task_sync` is a desktop tokio service). Effort L.
- **`test_parachute` / `test_notion`** — trivial server-side URL/key probes (Class C). Effort S.
- Matrix/Google/GitHub remain best left desktop (host CLIs `gog`/`gh`, keychains, local git trees) unless the owner explicitly wants to relocate those credentials onto the server.

---

## 5. Design sketch — web agent-skills + `claude -p` triggering (the headline)

### 5.1 Why it's feasible
The Prism Server runs on the **same host** as Parachute, the `claude` binary, the project root (`.mcp.json`), and any local model server. It already holds the vault token and is the single trust boundary. Today it has **no process-spawn / LLM capability** — confirmed: the only subprocess in `apps/server/src` is a fixed-arg `execFile("parachute-vault", …)` in `vault-provision.ts:16,32` (vault provisioning, not an agent). So an agent executor is net-new, but the precedent for "server shells out to a fixed-arg binary" exists.

The desktop reference implementation to port:
- `spawn_claude_process` (`apps/desktop/src-tauri/src/services/agent_dispatch.rs:393-488`): resolves `claude` via `which`, sets **cwd = project root** (for `.mcp.json`), strips `CLAUDECODE` from env, augments PATH, args `-p --model sonnet --dangerously-skip-permissions --disallowedTools Write,Edit,Bash,Glob,Grep --mcp-config <root>/.mcp.json -- <prompt>`, **30-min wall-clock timeout**, then persists the result as a vault note (`agent-dispatch`/`agent-output`).
- Skill model (`skill_scheduler.rs:291-372`): skills are `agent-skill` notes with metadata `{skillName, intervalSecs, enabled, lastRun, runAtHour, dependsOn, executionMode, provider, model}`; prompt = note content; template vars `{{today}}/{{yesterday}}/{{now}}`.

### 5.2 Endpoint list (all owner-only, session-cookie auth)
New router `apps/server/src/routes/agent.ts`, owner-gated middleware, mounted before the gateway:

| Method · Path | Purpose | Notes |
|---|---|---|
| `GET /api/agent/skills` | list skills | could just read `tag=agent-skill`; provided for symmetry/runtime status merge |
| `GET /api/agent/runs` | list recent dispatches | reads `agent-dispatch` notes + any in-memory in-flight runs |
| `GET /api/agent/runs/:id` | one run's status/output | merges in-memory (if running) + vault note (if done) |
| `GET /api/agent/runs/:id/stream` | **SSE** live status/output for an in-flight run | replaces desktop polling |
| `POST /api/agent/runs` | **trigger** a run: `{ skillName? , prompt? }` | the dangerous one — see security |
| `POST /api/agent/runs/:id/cancel` | cancel an in-flight run | best-effort (desktop also can't hard-kill) |
| `GET /api/agent/models` | list local models (Phase 4) | proxies host `/v1/models` |

All paths under `/api/*` are already in the PWA service-worker `navigateFallbackDenylist`, so no SW change needed (per CLAUDE.md gotcha).

### 5.3 Security model
- **Owner-only, session-cookie only.** Reuse the `/acl` middleware (`acl.ts:90-96`): `if (!resolveActor(c).isOwner) return 403`. Crucially, **reject capability/anon actors** even if a future grant would say otherwise — agent execution is not a shareable resource. `resolveActor` marks capability + anon as `isOwner:false` structurally (`auth/actor.ts:47-60`), and the local-owner-token path is gated by `isLocalRequest()` (`actor.ts:38-45`), so over the public tunnel only a real owner session qualifies. Consider additionally requiring `isLocalRequest()` for the trigger endpoint if the owner wants spawn restricted to LAN.
- **No free-form command from the client.** The client sends only `{ skillName }` (server looks up the `agent-skill` note and uses its prompt) or `{ prompt }` (a string that becomes the **`-p` positional only**). The server builds the argv array itself (no shell, `spawn` with an array, never `exec`/string interpolation) using the **fixed template** from `spawn_claude_process`. The prompt is data passed after `--`, never flags.
- **Bounded blast radius.** Keep the desktop's `--disallowedTools Write,Edit,Bash,Glob,Grep` (forces Parachute-MCP-only, no host FS/shell writes) and the 30-min wall-clock timeout. Cap concurrent runs (e.g. 2) and rate-limit `POST /api/agent/runs` (reuse `middleware/ratelimit.ts`).
- **No new secret to the browser.** The browser still holds only the session cookie; `claude`/MCP creds live on the host. The server already runs as the owner's process.
- **Audit.** Every trigger persists an `agent-dispatch` note (already the desktop behavior) — durable, vault-visible audit trail.
- **Honest risk callout:** this endpoint *is* "let an authenticated owner spawn `claude -p` on the host." That's the whole point (the owner wants it), but it must never broaden past owner-session. The single biggest mistake would be allowing a capability/published actor to reach it, or accepting client-supplied argv/flags.

### 5.4 Seam / UI shape
- Introduce an **`AgentClient` seam** in `packages/core` (mirroring the `VaultClient`/`CollabSharing` pattern): an interface `{ listSkills, listRuns, getRun, streamRun, trigger, cancel }`, dependency-injected per shell.
  - Desktop impl wraps the existing Tauri `agentApi.*` (`packages/core/src/lib/agent/client.ts`).
  - Web impl calls `/api/agent/*` + the SSE stream.
- Rewire `AgentActivity.tsx` to consume `useAgentClient()` instead of importing `agentApi` directly. Then the **same tab works in both shells**, and the `agent-activity` virtual tab (`Canvas.tsx:22`) becomes real on web.
- For Phase 1 (monitor-only) the web impl can be backed purely by vault reads; Phases 2-3 swap in the real endpoints.

### 5.5 The `agent-activity` virtual tab — current state & minimal path to web
- It is registered as a renderer keyed `"agent-activity"` (`Registry.ts:21,47`) and listed in `VIRTUAL_TAB_IDS` (`Canvas.tsx:22`), so it **already mounts in the web shell** (virtual tabs synthesize a fake note, no Parachute fetch).
- Today in web it is **inert**: `getSkills`/`getDispatches` return the stub `[]` (`core.ts:92-93`) so lists are empty, and every action (`dispatch`, `cancel`, `updateSkill`) throws (`core.ts:103-104`).
- **Minimal server support to make it real:** Phase 1 makes the lists + skill editing real with **zero server code** (read `agent-skill`/`agent-dispatch` notes via passthrough). Phase 2's `POST /api/agent/runs` makes "Run now" real. Phase 3's SSE makes live status real. So the tab can light up incrementally.

---

## 6. Appendix — key file references

Desktop backend:
- Command registry: `apps/desktop/src-tauri/src/lib.rs:138-252` (79 commands), managed state `:128-137`.
- Agent: `commands/agent.rs` (PRISM_CONTEXT `:25-50`); `services/agent_dispatch.rs` (`spawn_claude_process:393-488`, persist `:524-567`); `services/skill_scheduler.rs` (skills `:291-372`, defaults `:13-217`); `clients/anthropic.rs` (`ClaudeClient::run:106`, `run_conversational:156`); `clients/model_router.rs` (Claude vs local, `:108-205`).
- Services: `services/mod.rs:51` (`message_sync`, `calendar_sync`, `email_sync`, `transcript_sync`, `notion_task_sync`, `embedding_index`, `skill_scheduler`).
- Integrations: `clients/matrix.rs`, `clients/google.rs` (delegates to `gog` CLI), `commands/github_cmds.rs` (`git`+`gh`), `commands/notion_db_cmds.rs`, `sync/adapters/{github,google_docs,notion,notion_db}.rs`.
- Config/Keychain: `commands/config.rs` (`set_anthropic_key:330`, `update_config:655`, `acl_request:559`, `create_collab_share_link:512`).

Web shell:
- `invoke` shim: `apps/web/src/tauri-shim/core.ts` (real `:26-74`, stubs `:83-101`, throw `:103-104`); event no-ops `tauri-shim/event.ts:11-21`.
- REST client: `apps/web/src/parachute/rest.ts`; offline outbox `:70-109`.
- Share/ACL seam: `apps/web/src/collab/grant.ts`.
- Gating: `apps/web/src/main.tsx:112-156` (onboarding skip `:117`, login gate `:122-142`).

Server gateway:
- App + mounts: `apps/server/src/app.ts:79-105`; entry `index.ts`.
- Gateway: `routes/api.ts` (passthrough `:30-52`, owner short-circuit `:54-59`, allowlist `:95-207`, catch-all 403 `:211`).
- Owner-only patterns: `routes/acl.ts:90-96` (middleware), `routes/vaults.ts:15-30` / `routes/rag.ts:23` (per-route `ownerOnly`), mounted-before-gateway ordering `app.ts:88-98`.
- Actor/permissions: `auth/actor.ts:21-61`, `permissions.ts:10-61`.
- Collab auth: `collab.ts:384-461` (`resolveLevel`/`authorizeConnection`).
- No existing agent/spawn: only `vault-provision.ts:16,32` (fixed-arg `execFile`).

Core UI:
- Agent tab: `packages/core/src/components/agent/AgentActivity.tsx`; client `lib/agent/client.ts:128-156`.
- Settings: `packages/core/src/components/layout/Settings.tsx`.
- Sync modals: `GitHubSyncModal.tsx`, `NotionDbSyncModal.tsx`, `MetadataPanel.tsx`.
- Virtual tabs: `Canvas.tsx:22` (`VIRTUAL_TAB_IDS`), `Registry.ts:21,47`.
- Reference WIRE pattern (no `invoke`): `components/renderers/network/{FederatePanel,PublishPanel,VaultsPanel}.tsx`.
