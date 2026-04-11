# Prism

**One window for documents, messages, tasks, and calendar—grounded in a local vault, mirrored to the services you already use.**

Prism is an early-stage **desktop shell** (Tauri + React) for a product vision described in detail in [`.claude/prism-prd-v3.md`](.claude/prism-prd-v3.md): a **universal interface** where you stop thinking about *where* data lives (Gmail vs Matrix vs Notion vs Google Docs) and instead work in **one place**, with **type-aware editors**, **sync**, and an **embedded agent** that operates on the same canonical store as the UI.

This repository is **active development**—the architecture and many UI surfaces exist; some integrations are wired end-to-end, others are scaffolding toward the PRD.

---

## Vision (from the PRD)

- **Unified mental model:** A message is a message, a document is a document—platform badges are secondary; the canvas and navigation are primary.
- **Three zones:** **Navigation** (projects, inbox, calendar, search) · **Canvas** (renderer switches by content type) · **Context panel** (agent chat, metadata, sync context)—plus a **status bar** and **command bar** (`⌘K`).
- **Parachute as source of truth:** Notes in the vault (via the **Parachute HTTP API**, default `localhost:1940`) are canonical. External systems are **mirrors** with **per-document sync config** and conflict strategies (`local-wins`, `remote-wins`, `ask`).
- **Agent in the background:** Inline edit (`⌘J`), command palette, and panel chat—wired in code to **Claude** (CLI / MCP) with instructions to use **Parachute MCP tools** for vault read/write/search.

For full renderer specs, sync matrix, and UX detail, read the PRD and [`prism-implementation-plan.md`](.claude/prism-implementation-plan.md).

---

## What the code does today

### Desktop app layout

- **Onboarding** then **`Shell`**: resizable **sidebar** + **canvas** + **context panel**, **status bar**, and overlay **command bar**.
- **Keyboard shortcuts** are centralized (e.g. command palette, toggles)—see `src/app/hooks/useKeyboardShortcuts.ts`.
- **UI state** (tabs, panel widths, open items) via **Zustand** (`src/app/stores/ui.ts`); server-ish data via **TanStack Query**.

### Canvas and content types

- Each open item is a **tab**. The canvas loads a **Parachute note** (or a **virtual** tab such as a Matrix room id) and picks a **renderer** from `metadata` / inferred type.
- **`getRenderer`** in [`src/components/renderers/Registry.ts`](src/components/renderers/Registry.ts) maps types like `document`, `note`, `briefing`, `message-thread`, `email`, `event`, `code`, `presentation`, `task` / `task-board`, and `project` to lazy-loaded React renderers; unknown types fall back to a **placeholder**.
- **TipTap** powers rich document editing; **Monaco** is used for code; other renderers cover messages, email, calendar, tasks, presentations, and project overview—at varying levels of completeness vs the PRD.

### Rust / Tauri backend

- **`ParachuteClient`** (`src-tauri/src/clients/parachute.rs`) talks to the vault REST API (`http://localhost:1940/api`): list/get/create/update/delete notes, search, tags, links, stats.
- **`MatrixClient`** exposes room list, messages, send, members, read receipts, search—backed by config from env.
- **`GoogleClient`** covers **Gmail** (threads, send, archive, label) and **Google Calendar** (list/create/update/delete events).
- **Markdown helpers:** `markdown_to_html` / `html_to_markdown`.
- **`system::check_services`:** health / connectivity style checks for local dependencies.
- **Sync:** A **sync engine** ([`src-tauri/src/sync/engine.rs`](src-tauri/src/sync/engine.rs)) coordinates local vs remote changes with strategies; **adapters** exist for **Google Docs** and **Notion** ([`src-tauri/src/sync/adapters/`](src-tauri/src/sync/adapters/)) implementing a shared `SyncAdapter` trait. Tauri commands expose trigger, status, config CRUD, and conflict resolution.
- **Agent:** [`src-tauri/src/commands/agent.rs`](src-tauri/src/commands/agent.rs) implements **inline edit**, **chat** (with session tracking), **transform**, and **generate** via **`ClaudeClient`**, with system context pointing at **Parachute MCP** tool usage. The CLI is run from the Prism project directory so **`.mcp.json`** is picked up for vault tools.

Invoke surface is registered in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) (vault, convert, system, matrix, google, sync, agent, config).

### Configuration

- **`AppConfig`** ([`src-tauri/src/commands/config.rs`](src-tauri/src/commands/config.rs)) loads **`omniharmonic_agent/.env`** (path is currently under the author’s home layout—adjust or symlink for your machine). It supplies Matrix, Notion, Google account hints, and **Anthropic** key (from env or macOS keychain entry `com.prism.anthropic`).
- Runtime commands include **`get_config_status`** and **`set_anthropic_key`**.
- **`lib.rs`** falls back to sensible defaults if the file is missing (with a warning).

---

## Tech stack

| Area | Choice |
|------|--------|
| Shell | **Tauri 2** (Rust) |
| UI | **React 19**, **TypeScript**, **Vite 7** |
| Styling | **Tailwind CSS 4**, custom **glass** tokens (`src/styles/`) |
| Editors | **TipTap** (documents), **Monaco** (code), **@dnd-kit** (drag and drop) |
| Data fetching | **TanStack Query** |
| Local state | **Zustand** |
| Matrix (frontend) | **matrix-js-sdk** (see `src/lib/matrix/`) |

---

## Prerequisites

- **Node.js** (LTS recommended) and **npm**
- **Rust** toolchain suitable for Tauri 2
- **Parachute** vault API reachable at **`http://localhost:1940`** (or update the port in `src-tauri/src/lib.rs` where `ParachuteClient::new` is constructed)
- For Matrix / Google / Notion / agent features: configure **`omniharmonic_agent/.env`** (or your fork of that layout) and OAuth/credentials as those clients expect
- Optional: **Bun** for the **Parachute Vault MCP** entry in `.mcp.json`

---

## Development

```bash
npm install
npm run tauri dev
```

Frontend only (no desktop window):

```bash
npm run dev
```

Vite dev server is configured for port **1420** to match `tauri.conf.json`.

## Build

```bash
npm run tauri build
```

---

## Repository layout

| Path | Purpose |
|------|---------|
| `src/` | React app: layout, navigation, renderers, hooks (`useParachute`, auto-save, shortcuts), lib clients (Parachute, Matrix, sync, agent) |
| `src-tauri/` | Rust: commands, HTTP clients, sync engine, models |
| `.claude/` | **PRD**, implementation plan, and internal design notes—source of truth for *intent* and roadmap |
| `.mcp.json` | MCP server config for **Parachute** (default: `../parachute-vault/src/server.ts` relative to this repo—sibling checkout) |

---

## Optional: Cursor + Parachute MCP

The repo’s `.mcp.json` starts a **parachute-vault** MCP server with **Bun** so Claude (in Cursor or via the agent commands) can call vault tools. If your vault server lives elsewhere, change the `args` path in `.mcp.json`.

---

## Status

Prism is **not** a finished product; it is a **working codebase** aligned with a detailed PRD. Treat features as **until proven in your environment**: local services, OAuth, and paths must match your setup.

---

## License

No `LICENSE` file is included yet; add one when you decide how to distribute the project.
