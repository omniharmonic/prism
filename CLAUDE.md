# Prism — Development Guide

## What is Prism?

Prism is a Tauri 2.x desktop app (Rust backend + React 19 frontend) that serves as a universal interface for documents, messages, tasks, calendar, and knowledge management. It reads from a Parachute vault (SQLite-backed knowledge graph at localhost:1940).

## Architecture

```
Frontend (React/TypeScript)     ← Tauri IPC →     Backend (Rust)
├── components/renderers/       ← invoke() →      ├── commands/
├── components/layout/                             ├── clients/ (parachute, matrix, google, claude)
├── app/stores/ (Zustand)                          ├── sync/adapters/
├── lib/parachute/ (API hooks)                     └── models/
└── lib/dashboard/ (filter engine)
```

## Key Principles

1. **Parachute owns the data.** Never touch SQLite directly. All reads/writes via HTTP API at localhost:1940.
2. **Tags are the type system.** The vault uses 22 tag schemas (task, meeting, person, project, etc.) — not `metadata.type`.
3. **Frontend decides nothing about data.** All external API calls happen in Rust. Frontend only talks to Rust via Tauri IPC.
4. **Content type determines rendering.** `inferContentType()` maps tags → ContentType → lazy-loaded renderer.
5. **Agent uses Claude Code CLI.** Spawns `claude -p` processes, not Anthropic API. Runs in Prism project directory for .mcp.json access.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2.x (Rust) |
| Frontend | React 19 + TypeScript |
| Styling | Tailwind CSS v4 + glass design tokens |
| State | Zustand (UI) + TanStack Query (server) |
| Document editor | TipTap 3 (ProseMirror) |
| Data source | Parachute Vault (localhost:1940) |
| Messaging | Matrix Synapse (localhost:8008) via mautrix bridges |
| Google APIs | `gog` CLI subprocess |
| AI Agent | Claude Code CLI subprocess |

## Commands

```bash
npm run tauri dev        # Dev mode with hot reload
npm run tauri build      # Production build → src-tauri/target/release/bundle/
npm run build            # Frontend only
npx tsc --noEmit         # Type check
cargo check              # Rust check (from src-tauri/)
```

## Content Type System

Notes are typed via tags, NOT `metadata.type`. The inference chain:
1. `metadata.prism_type` (backend-enriched)
2. `metadata.type` (if known Prism type)
3. Tag-based: `task` → "task", `meeting` → "document", `slides` → "presentation", `dashboard` → "dashboard"
4. Path extension: `.py` → "code", `.html` → "website"
5. Default: "document"

## Renderers (11 total)

Document, Code, Presentation, Message, Email, Calendar, TaskBoard, Project, Spreadsheet, Website, Dashboard

Each is lazy-loaded via `Registry.ts`. Dashboard has 9 configurable widget types with a schema-driven filter engine.

## Parachute MCP

The `.mcp.json` registers the Parachute vault MCP server. Claude Code sessions spawned by Prism have access to:
- `search-notes`, `get-note`, `create-note`, `update-note`
- `list-tags`, `describe-tag`, `traverse-links`, `find-path`
- `semantic-search`, `embed-notes`

## File Structure

```
src/
├── app/stores/          # Zustand: ui.ts, settings.ts
├── app/hooks/           # TanStack Query hooks: useParachute.ts, useWidgetData.ts
├── components/
│   ├── layout/          # Shell, Canvas, TabBar, StatusBar, Settings, CommandBar
│   ├── renderers/       # 11 content renderers + Registry
│   ├── navigation/      # Sidebar, ProjectTree, Inbox, TagView
│   ├── dashboard/       # Widget components + editor
│   ├── agent/           # InlinePrompt, PanelChat
│   └── ui/              # Glass design system components
├── lib/
│   ├── parachute/       # API client + query keys
│   ├── matrix/          # Matrix types + client
│   ├── dashboard/       # Filter engine + widget registry
│   ├── tiptap/          # WikilinkMark, WikilinkAutocomplete
│   └── schemas/         # Content type inference + tag mapping
src-tauri/src/
├── commands/            # Tauri IPC handlers
├── clients/             # HTTP clients (parachute, matrix, google, claude)
├── sync/                # Sync engine + adapters (Google Docs, Notion)
└── models/              # Rust data types
```

## Configuration

Config loads from: `~/.config/prism/prism-config.json` → `omniharmonic_agent/.env` → defaults.

Key env vars (from omniharmonic .env):
- `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER`
- `NOTION_API_KEY`
- `GOOGLE_ACCOUNT_BENJAMIN`, `GOOGLE_ACCOUNT_AGENT`

## Common Patterns

**Adding a new renderer:**
1. Create `src/components/renderers/FooRenderer.tsx`
2. Add to `Registry.ts`: `const FooRenderer = lazy(() => import("./FooRenderer"));`
3. Map in `RENDERER_MAP`: `foo: FooRenderer`
4. Add "foo" to `ContentType` union in `types.ts`
5. Add to `KNOWN_TYPES` in `content-types.ts` AND in Rust `enrich_note` known list

**Adding a Tauri command:**
1. Create handler in `src-tauri/src/commands/`
2. Register in `src-tauri/src/lib.rs` invoke_handler
3. Add frontend wrapper in appropriate `client.ts`
