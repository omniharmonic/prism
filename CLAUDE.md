# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Prism?

Prism is a universal interface for documents, messages, tasks, calendar, and knowledge management, backed by a Parachute vault (SQLite knowledge graph at localhost:1940). It ships in two shells over one shared React 19 UI core:

- **Desktop** (`apps/desktop`) — Tauri 2.x (Rust backend + React frontend). The trusted, local, full-featured app; talks to Parachute (and Matrix/Google/Claude/Notion) directly.
- **Web** (`apps/web`) — a static PWA (mobile + desktop browser) for editing the vault from anywhere and **Google-Docs-style sharing**. The browser holds **no vault credentials**; it talks only to the **Prism Server** gateway.

### Monorepo layout (npm workspaces)

```
packages/core         Shared React UI: renderers, editor, layout, stores, VaultClient seam
apps/desktop          Tauri shell (was the repo root; src-tauri lives here)
apps/web              Vite PWA shell (HttpVaultClient → Prism Server gateway)
apps/server           Prism Server — Node home-server: auth + permission gateway + (P3) collab
apps/collab-server    Cloudflare Worker (Yjs) — RETIRED, superseded by apps/server collab
```

**VaultClient seam** (`packages/core/src/data/`): the UI core depends on a `VaultClient` interface, dependency-injected per shell — `TauriVaultClient` (invoke) for desktop, `HttpVaultClient` (fetch → gateway) for web. One UI, two transports.

## Commands

```bash
# Desktop (Tauri) — run from apps/desktop
cd apps/desktop && npm run tauri dev      # Dev mode with hot reload
cd apps/desktop && npm run tauri build    # Production bundle
cd apps/desktop/src-tauri && cargo check  # Rust check

# Web PWA
npm run build -w @prism/web               # Build static PWA → apps/web/dist
npm run dev -w @prism/web                  # Vite dev server

# Prism Server (the gateway) — run from apps/server
cd apps/server && npm run dev              # node --env-file=.env --watch (needs .env; see below)
cd apps/server && npm run typecheck        # tsc --noEmit
cd apps/server && node --env-file=.env --import tsx scripts/verify-gateway.ts   # security e2e

# Type check everything
npx tsc --noEmit                           # (per-workspace tsconfigs exist too)
```

There are no unit test suites; verification is typecheck + build + run-against-the-live-vault (curl / Playwright). `apps/server/scripts/verify-gateway.ts` is the gateway security check.

## Architecture

```
Frontend (React/TypeScript)     ← Tauri IPC →     Backend (Rust)
├── components/renderers/       ← invoke() →      ├── commands/        (IPC handlers)
├── components/layout/                             ├── clients/         (HTTP: parachute, matrix, google, claude, ollama)
├── app/stores/ (Zustand)                          ├── services/        (background tokio tasks)
├── lib/parachute/ (API hooks)                     ├── sync/adapters/   (Google Docs, Notion, GitHub)
└── lib/dashboard/ (filter engine)                 └── models/          (Rust data types)
```

### Key Principles

1. **Parachute owns the data.** Never touch SQLite directly. All reads/writes go via HTTP API at localhost:1940.
2. **Tags are the type system.** Notes are typed by tags (`task`, `meeting`, `person`, `project`, etc.), not `metadata.type`. The `inferContentType()` function in `src/lib/schemas/content-types.ts` maps tags → `ContentType` → renderer.
3. **Frontend talks only to Rust.** All external API calls (Matrix, Google, Claude, Notion) happen in Rust commands. Frontend calls `invoke()` only.
4. **Agent uses Claude Code CLI.** The `ClaudeClient` spawns `claude -p` subprocesses (not the Anthropic HTTP API). It runs in the Prism project root so it picks up `.mcp.json` and gets Parachute MCP access.
5. **Tauri commands return `Result<T, PrismError>`.** `PrismError` serializes to a string for the frontend. All new commands must follow this pattern.

## Prism Server & Web Sharing (the security gateway)

`apps/server` is a Node home-server (Hono + better-sqlite3) that is the **single trust boundary** for the web/shared path. It is the **only** component that holds the vault token; clients never get one.

```
Browser ── session cookie OR capability link ──▶ PRISM SERVER (apps/server) ── vault token ──▶ Parachute
          (httpOnly, no token in JS)              ├ /auth/*  magic-link sign-in, sessions, logout, me
                                                   ├ /api/*   permission gateway (authorize every read/write)
                                                   └ /*       serves the built web PWA (same-origin)
```

**Auth (`src/auth/`).** Three actor kinds resolved per request (`actor.ts`): a signed-in **user** (httpOnly session cookie → SQLite row, `session.ts`), an **anyone-with-link capability** (HMAC-signed token naming a grant id, `capability.ts`), or **anon**. Auth is **invite-only with passwords** — there is no open self-signup:
- **Owner** (`OWNER_EMAIL`) signs in via **magic link**, which is **owner-only** (gated at both `/auth/request` and `/auth/callback`) — bootstrap/recovery, since the owner controls that inbox.
- **Everyone else**: the owner issues an **invite** (`invite.ts` — single-use, hashed, 7-day) → recipient **registers** a password account (`password.ts` — scrypt) at `/accept-invite?token=` → logs in with email + password (`/auth/login`). Sharing by email (`/acl` people endpoints) auto-invites, so a grant binds to a real authenticated account, not a bare email. Generic 401s avoid account enumeration; `/auth/login` + `/auth/register` are rate-limited.
- Email via **Resend** (`RESEND_API_KEY`, shared sender in `email.ts`); with no key, links log to the console (dev only). A signed-in **non-owner with no grants sees nothing** (empty `/api/notes`, 403 on notes + the graph) — authentication never implies authorization.

**Permissions (`src/permissions.ts`).** Levels `view < comment < suggest < edit < own`. `effectiveLevel(grants, note, isOwner)` = max over grants matching the note **id** or any of its **tags**, with owner → `own`. Grants live in SQLite (`db.ts`): `(subject_type: user|link|anyone, subject, resource_type: note|tag, resource, level)`.

**Gateway (`src/routes/api.ts`).** The owner short-circuits to a **transparent passthrough** (`proxyToVault`) — full vault, token-free, so the desktop-grade app works unchanged in the browser. Non-owners hit only allowlisted routes (notes/search/tags), each filtered by `effectiveLevel`; **every other `/api` path → 403**. `effectiveLevel` is the authoritative guard — tag queries only *narrow* what's fetched (defense-in-depth vs. the Parachute REST tag-scope gap, vault #404).

**Web client.** `apps/web` talks to the gateway with `credentials: "include"` (the session cookie); it stores **no token** (verified: `document.cookie` empty, nothing in localStorage). `main.tsx` gates the app on `GET /auth/me` → `LoginScreen` when unauthenticated.

**Gotchas.**
- The PWA service worker's `navigateFallback: index.html` will **shadow server routes** unless they're in `navigateFallbackDenylist` (currently `[/^\/auth\//, /^\/api\//]`). Any new server-owned route must be added there, or sign-in/API breaks **only in the browser** (curl still works).
- Run config: `apps/server/.env` (gitignored) — `PARACHUTE_TOKEN`, `SESSION_SECRET`, `CAPABILITY_SECRET`, `OWNER_EMAIL`, optional `RESEND_API_KEY`/`MAGIC_FROM`, `APP_ORIGIN`, `WEB_ROOT` (default `../web/dist`). `assertConfig()` fails fast on missing required secrets.
- Token rotation: `parachute auth revoke-token <jti>` has a **~60s cache TTL** before the vault enforces it. The macOS desktop config is `~/Library/Application Support/prism/prism-config.json` (NOT `~/.config/prism`).

## Real-time Collaboration (type-aware Hocuspocus)

`apps/server/src/collab.ts` runs a **Hocuspocus (Yjs) WebSocket** at `/collab`. It is **type-aware**: `noteKind(note)` → `document | code | spreadsheet | canvas` (by `metadata.prism_type` → tag → file extension), and `loadDocumentState`/`storeDocumentState` (plus the "already populated" guard) seed and persist the matching Yjs structure ⇄ the note's canonical content. The server self-seeds from Parachute, so a shared doc opens even with the owner offline. Per note, the live Yjs binary is cached in SQLite (`collab_docs`) for CRDT continuity; an external Parachute edit (vault `updatedAt` newer than our snapshot) wins and re-seeds.

| Kind | Yjs structure (field) | Persisted as | Client editor (`@prism/core`) |
|---|---|---|---|
| document | `XmlFragment` ("default") | HTML | `CollabEditor` (TipTap) — + comments + suggestions |
| code | `Y.Text` ("codemirror") | raw source | `CollabCodeEditor` (CodeMirror + y-codemirror.next) |
| spreadsheet | `Y.Array<Y.Array<string>>` ("rows") | CSV | `CollabSpreadsheet` (grid) |
| canvas | `Y.Map<id, element>` ("elements") | Excalidraw scene JSON | `CollabCanvas` (Excalidraw) |

Connection auth (`authorizeConnection`) resolves the same `effectiveLevel`: below `view` → reject; below `suggest` → read-only. Comments + suggested edits are **document-only**; code/sheet/canvas are pure collaborative data. `apps/web/src/collab/CollabDoc.tsx` mirrors `detectKind` and routes to the right editor; `Canvas.tsx`'s `COLLAB_TYPES` set drives the **in-app** live-editor swap (the owner's main app shows the live collaborative editor for any shared note of these kinds). 98 server tests (`test/collab.test.ts`) cover kind detection + per-kind round-trip + corruption guards.

**Collab gotchas (learned the hard way).**
- **Restart pm2 `prism-server` after ANY server change** — it compiles via tsx on start but does NOT hot-reload. A stale server with an older `noteKind` will persist a note through the WRONG path and **corrupt it** (e.g. canvas scene JSON wrapped in `<p>`).
- **Excalidraw**: paint RAW `Y.Map` values via `updateScene`; do NOT use `restoreElements` (it silently drops valid elements when reconciling fractional indices across a set). Loop-safety: `onChange` only writes elements whose monotonic `version` increased; the map observer ignores `LOCAL`-origin transactions. `appState` (zoom/scroll) is per-viewer, not synced.
- The Y.Map (canvas) re-seeds **idempotently** (set-by-id); the Y.Array (spreadsheet) can **double** if re-seeded while a client holds rows — only happens if the SQLite docState is lost under a live client.
- Test on throwaway `_test` notes; mint an edit capability against the running DB+secret (`createCapability` + `signCapability`) to drive `/collab/:id?t=` without owner login. Bust the PWA service worker (`getRegistrations().unregister()` + `caches.delete()`) or you test stale JS.

## Content Type & Renderer Pipeline

The full chain from vault note → screen:

1. `Canvas.tsx` fetches the active tab's note via `useNote(id)`
2. `inferContentType(note)` checks (in order): `metadata.prism_type` → `metadata.type` (if in `KNOWN_TYPES`) → tag mapping in `TAG_TO_CONTENT_TYPE` → path extension → default `"document"`
3. `getRenderer(contentType)` in `Registry.ts` returns the lazy-loaded React component
4. The renderer receives `RendererProps`: `{ note, onSave, onMetadataChange }`

**Virtual tabs** (e.g. `"messages-dashboard"`, `"calendar-dashboard"`, `"agent-activity"`) never hit Parachute — `Canvas.tsx` synthesizes a fake `Note` object and bypasses `useNote()`. Their `noteId` either contains `:` (non-numeric) or is in `VIRTUAL_TAB_IDS`.

**Adding a new renderer:**
1. Create `src/components/renderers/FooRenderer.tsx` — `export default function FooRenderer({ note, onSave, onMetadataChange }: RendererProps)`
2. Add lazy import and map entry in `Registry.ts`
3. Add `"foo"` to `ContentType` union in `src/lib/types.ts`
4. Add to `KNOWN_TYPES` in `content-types.ts` and to `TAG_TO_CONTENT_TYPE` if tag-driven
5. Add to `KNOWN_TYPES` list in the Rust `enrich_note` function

## State Management

Two Zustand stores, no cross-store dependencies:

- **`useUIStore`** (`src/app/stores/ui.ts`) — ephemeral UI: open tabs, active tab, sidebar/context-panel widths, command bar, inline prompt, ghost text, pending editor edits. Tab IDs are `"tab-{noteId}"`.
- **`useSettingsStore`** (`src/app/stores/settings.ts`) — persisted to `localStorage` as `"prism-settings"`: theme, fonts, vault URLs, AI provider/model routing (`skillModels`), sync defaults.

TanStack Query handles all server state. Query keys are defined in `src/lib/parachute/queries.ts`. Always invalidate via `queryKeys.vault.*` helpers, not raw strings.

## Tauri Commands & IPC

All commands are registered in `src-tauri/src/lib.rs` `invoke_handler`. The frontend wrapper lives in `src/lib/parachute/client.ts` (vault/system/GitHub) or `src/lib/agent/client.ts` (agent ops).

**Adding a Tauri command:**
1. Add `#[tauri::command] pub async fn my_cmd(...) -> Result<T, PrismError>` in the relevant `src-tauri/src/commands/*.rs` file
2. Add `commands::my_module::my_cmd` to `invoke_handler` in `lib.rs`
3. Add `invoke<T>("my_cmd", { ...params })` wrapper in the appropriate frontend client

Managed state injected into commands via `State<'_, T>`: `ParachuteClient`, `MatrixClient`, `GoogleClient`, `ModelRouter`, `AgentSessions`, `AppConfig`, `ServiceManager`, `DispatchManager`, `GitHubSyncState`, `NotionDbSyncState`.

## Background Services

`ServiceManager` (in `src-tauri/src/services/mod.rs`) starts tokio tasks on app launch — each runs a poll loop with a `watch::Receiver<bool>` shutdown channel:

| Service | Interval | Trigger condition |
|---|---|---|
| `message_sync` | 60s | `matrix_access_token` configured |
| `calendar_sync` | 5 min | `google_account_primary` configured |
| `email_sync` | 3 min | `google_account_primary` configured |
| `transcript_sync` | 10 min | `fathom_api_key` or `meetily_db_path` configured |
| `notion_task_sync` | background | `notion_api_key` configured |
| `skill_scheduler` | varies | started via `start_scheduler()` after `DispatchManager` is ready |

`DispatchManager` (`src-tauri/src/services/agent_dispatch.rs`) handles on-demand background agent dispatches — each spawns a `claude -p` process, tracks status, and optionally writes output to a Parachute note.

## AI / Model Routing

`ModelRouter` (`src-tauri/src/clients/model_router.rs`) routes agent calls to either:
- **Claude Code CLI** (default) — `claude -p` subprocess, picks up `.mcp.json`, supports `--resume` for session continuity
- **Ollama + MCP** (opt-in per skill) — `OllamaAgent` connects to `http://localhost:11434` with the Parachute MCP client built in

Per-skill routing is stored in `ModelRouter.skill_config` (a `Mutex<HashMap<String, SkillModelConfig>>`). Skills: `"edit"`, `"chat"`, `"transform"`, `"generate"`. Frontend controls routing via `ollama_cmds::set_skill_model`.

The `PRISM_CONTEXT` constant in `commands/agent.rs` is the system prompt prepended to all agent calls — it describes the vault MCP tools and Benjamin's data context.

## Configuration

Desktop config loads from the platform app-config dir — on **macOS that is `~/Library/Application Support/prism/prism-config.json`** (Tauri app-data), not `~/.config/prism`. On first launch the file is created with defaults. The Settings UI writes back to it. No external `.env` is required for desktop. (The web/server path uses `apps/server/.env` instead — see *Prism Server* above.)

Key fields in `AppConfig`:
- `parachute_url` (default: `http://localhost:1940`) — server root; the client appends the vault-scoped `/vault/{name}/api` path itself
- `parachute_vault` (default: `default`) — vault name for the scoped REST/MCP URLs (`/vault/{name}/...`)
- `parachute_api_key` — Bearer token for vault auth. As of Parachute **0.5.x** this is a **hub-issued JWT** (`vault:<name>:write`, ≤1yr TTL), minted via `parachute auth mint-token`. The pre-0.5 `pvt_*` opaque tokens are rejected (401). The hub (`@openparachute/hub`, port 1939) is the token issuer.
- `matrix_homeserver` / `matrix_access_token` / `matrix_user`
- `google_account_primary` — account name for `gog` CLI
- `notion_api_key`
- `fathom_api_key` / `meetily_db_path` — transcript sources
- `anthropic_api_key` — also checked in macOS Keychain as fallback

## Parachute MCP

`.mcp.json` at project root registers the Parachute vault MCP server at `http://127.0.0.1:1940/vault/default/mcp` (vault-scoped as of Parachute 0.5.x; the old unscoped `/mcp` was removed). Auth is the same hub JWT as the REST client. Claude Code sessions spawned by Prism have access to 9 tools (prefixed `mcp__parachute-vault__`):

- `query-notes` — read by ID/path, or filter by tag/search/path/metadata/date; supports `near` for graph neighborhoods
- `create-note` — single or batch (pass `notes` array)
- `update-note` — content, metadata merge, tags add/remove, links add/remove
- `delete-note`
- `list-tags` — with optional schema detail
- `update-tag` — upsert tag description + field schema
- `delete-tag`
- `find-path` — BFS shortest path between two notes
- `vault-info` — vault description + stats

## Dashboard Widget System

Dashboard notes (`tag: dashboard`) store their layout in `metadata.layout.widgets` — an array of `DashboardWidgetConfig` objects. The filter engine (`src/lib/dashboard/filter-engine.ts`) runs entirely client-side on notes fetched from the vault.

9 widget types are registered in `src/lib/dashboard/widget-registry.ts`: `list`, `board`, `gallery`, `stat`, `progress`, `timeline`, `chart`, `embed`, `quick-actions`. Each widget's `source` field specifies tags/pathPrefix/metadataFilters that determine which notes feed it.

## Document Editor

`DocumentRenderer` uses TipTap 3 (ProseMirror). Wikilinks (`[[target]]`) are rendered via `WikilinkDecoration` (a ProseMirror plugin in `src/lib/tiptap/WikilinkMark.ts`) — it uses `font-size: 0` + CSS `::after` to show only the clean display name. `WikilinkAutocomplete` (`src/lib/tiptap/WikilinkAutocomplete.ts`) provides `[[` completion against vault paths. Auto-save is handled by `useAutoSave` hook (debounced, calls `onSave`).

## Sync Adapters

`src-tauri/src/sync/adapters/` contains adapters for: `google_docs`, `notion`, `notion_db`, `github`. Each adapter implements the sync engine's trait. GitHub sync pushes vault notes as markdown files to a repo. Notion DB sync bidirectionally maps Parachute notes to Notion database rows using `PropertyMapping` config stored in `NotionDbSyncConfig`.

## Graph

The knowledge graph is fetched whole via `vault_get_graph` (all nodes + edges, cached 60s). Client-side BFS via `filterNeighborhood()` in `useParachute.ts` extracts neighborhoods (capped at 600 nodes). `react-force-graph-3d` renders it. Graph fullscreen is a separate overlay controlled by `useUIStore.graphFullscreen`.
