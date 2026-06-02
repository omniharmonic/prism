# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Prism?

Prism is a Tauri 2.x desktop app (Rust backend + React 19 frontend) that serves as a universal interface for documents, messages, tasks, calendar, and knowledge management. It reads from a Parachute vault (SQLite-backed knowledge graph at localhost:1940).

## Commands

```bash
npm run tauri dev        # Dev mode with hot reload
npm run tauri build      # Production build → src-tauri/target/release/bundle/
npm run build            # Frontend only (Vite)
npx tsc --noEmit         # TypeScript type check
cd src-tauri && cargo check   # Rust check
cd src-tauri && cargo build   # Rust build only
```

There are no test suites currently in the project.

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

Config loads from `~/.config/prism/prism-config.json`. On first launch the file is created with defaults. The Settings UI writes back to this file. No external `.env` is required.

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
