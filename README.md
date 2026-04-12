<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2.x-blue?logo=tauri&logoColor=white" alt="Tauri 2.x" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React 19" />
  <img src="https://img.shields.io/badge/Rust-1.75+-DEA584?logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS v4" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License" />
</p>

<h1 align="center">Prism</h1>

<p align="center"><strong>The universal interface for your entire digital life.</strong></p>

<p align="center">
Prism is a desktop app that unifies your documents, messages, tasks, calendar, and knowledge into a single glass-pane interface. Built with Tauri 2.x (Rust + React), it connects to your existing services and presents them as one coherent world.
</p>

---

## :crystal_ball: What is Prism?

**One window. Everything flows through it.**

Prism is a desktop shell built on a single promise: you should never have to think about *where* your data lives. A message is a message — whether it crossed WhatsApp, Telegram, email, or a dozen other paths. A document is a document — whether it began in a local vault, a Google Doc, or a Notion page. The interface bends to the shape of what you are doing, not the other way around.

- **Unified workspace** — Documents, messages, tasks, calendar, and knowledge in one window
- **Parachute vault** — SQLite-backed knowledge graph as the canonical data layer (localhost:1940)
- **Glass-morphism design** — Polished dark and light modes with frosted-glass UI
- **AI agent** — Claude Code CLI integration with full tool access and vault operations
- **Service bridges** — Matrix for messaging, Google for email/calendar/docs, Notion for sync

---

## :sparkles: Features

### :memo: Document Editor

A full-featured writing environment powered by TipTap (ProseMirror).

- Rich text editing with headings, lists, tables, task lists, code blocks, and images
- Markdown round-trip via Rust (`pulldown-cmark`) — lossless conversion in both directions
- Auto-save every 2 seconds with debounced writes
- `[[wikilinks]]` with inline autocomplete — link any note in your vault
- `@mentions` for people, projects, and tags
- Syntax-highlighted code blocks via `lowlight`

### :speech_balloon: Unified Messaging

All your conversations in one interface via Matrix/Synapse bridges.

- WhatsApp, Telegram, Discord, Signal, and more through mautrix bridges
- Platform badges showing each message's source network
- Send and receive from a single compose box
- Full message threading and room management

### :globe_with_meridians: Google Integration

Gmail, Calendar, and Docs — no browser tabs required.

- **Gmail** — Read, compose, and reply via the `gog` CLI
- **Google Calendar** — Week and day views with event creation
- **Google Docs** — Bidirectional sync between your vault and Google Docs

### :arrows_counterclockwise: Notion Sync

Two-way content synchronization with Notion.

- Push and pull content between your vault and Notion pages
- Page picker with search for selecting sync targets
- Markdown-to-Notion blocks conversion and back
- Conflict-aware sync with last-write metadata

### :bar_chart: Dashboard Builder

Customizable dashboards with a schema-driven widget system.

- **9 widget types:** List, Board, Gallery, Stat, Progress, Timeline, Chart, Embed, Quick Actions
- Schema-driven metadata filters discovered from your tag schemas
- One-click templates for common dashboard layouts
- Configurable grid layout with drag-and-drop positioning
- Live data from your Parachute vault

### :robot: AI Agent

Claude as a first-class collaborator, not a chatbot.

- **Claude Code CLI integration** — not the API. Full tool access, file operations, and MCP
- **Inline editing** (`Cmd+J`) — highlight text and prompt for AI rewrites
- **Panel chat** — side panel with full document context
- **Parachute MCP** — Claude can search, read, create, and update vault notes directly
- **Apply/Replace buttons** — push AI-generated edits into the editor with one click
- Runs in Prism's project directory for `.mcp.json` access

### :label: Tag-Based Type System

Your vault's tags drive the entire UI.

- **22 tag schemas** from the Parachute vault (task, meeting, person, project, slides, dashboard, etc.)
- **Content type inference:** tags determine which renderer loads — no manual configuration
- **Interactive tag chips** — click any tag to see all notes with that tag
- Inference chain: `metadata.prism_type` -> tags -> path extension -> default

### :art: Additional Renderers

Prism ships with 11 renderers, each tailored to a content type.

| Renderer | Description |
|----------|-------------|
| **Code** | Monaco editor with line numbers, language detection, and syntax highlighting |
| **Presentation** | Slide grid with drag-reorder via dnd-kit |
| **Task Board** | Kanban columns with drag-and-drop cards |
| **Spreadsheet** | Editable cell grid powered by TanStack Table |
| **Website** | Split code editor and live preview |
| **Project** | Aggregated dashboard of tasks and documents for a project |
| **Message** | Threaded message view with platform badges |
| **Email** | Email composer and reader |
| **Calendar** | Day and week views with event management |
| **Dashboard** | Configurable widget grid (see Dashboard Builder above) |
| **Document** | Default rich text editor (see Document Editor above) |

---

## :rocket: Getting Started

### Prerequisites

| Requirement | Version |
|-------------|---------|
| macOS | 13+ (Ventura or later) |
| Rust | 1.75+ |
| Node.js | 20+ |
| Parachute vault | Running on `localhost:1940` |

### Optional Services

| Service | Purpose | Default |
|---------|---------|---------|
| Matrix Synapse | Unified messaging via mautrix bridges | `localhost:8008` |
| `gog` CLI | Gmail, Google Calendar, Google Docs | Installed globally |
| Notion API key | Two-way Notion page sync | Set in config |

### Installation

```bash
git clone https://github.com/omniharmonic/prism.git
cd prism
npm install
npm run tauri dev
```

This starts Prism in development mode with hot reload. The frontend runs on Vite; the Rust backend compiles and launches the native window.

### Production Build

```bash
npm run tauri build
```

The signed `.app` bundle lands in:

```
src-tauri/target/release/bundle/macos/Prism.app
```

To install:

```bash
cp -R src-tauri/target/release/bundle/macos/Prism.app /Applications/
```

### Configuration

Prism loads configuration from a cascade:

1. `~/.config/prism/prism-config.json` (primary)
2. `omniharmonic_agent/.env` (fallback for API keys)
3. Built-in defaults

Open **Settings** via the gear icon in the status bar. Configurable options include:

- **Theme** — dark / light / system
- **Fonts** — editor and UI font families
- **Multi-vault** — connect multiple Parachute instances
- **Sync defaults** — Notion, Google Docs sync behavior
- **Matrix credentials** — homeserver, access token, user ID

---

## :building_construction: Architecture

```
Frontend (React 19 / TypeScript)      <-- Tauri IPC -->      Backend (Rust)
├── components/renderers/             <-- invoke() -->       ├── commands/
├── components/layout/                                       ├── clients/ (parachute, matrix, google, claude)
├── app/stores/ (Zustand)                                    ├── sync/adapters/
├── lib/parachute/ (API hooks)                               └── models/
└── lib/dashboard/ (filter engine)
```

| Layer | Technology | Role |
|-------|-----------|------|
| Desktop shell | **Tauri 2.x** (Rust) | Native window, IPC, filesystem, all external API calls |
| Frontend | **React 19** + TypeScript | UI rendering, state, user interaction |
| Styling | **Tailwind CSS v4** + glass design tokens | Frosted-glass design system, dark/light modes |
| State | **Zustand** (UI) + **TanStack Query** (server) | Client state and server cache |
| Document editor | **TipTap 3** (ProseMirror) | Rich text editing with extensions |
| Data source | **Parachute Vault** | SQLite knowledge graph at `localhost:1940` |
| Messaging | **Matrix Synapse** | Bridged messaging at `localhost:8008` |
| Google services | **`gog` CLI** subprocess | Gmail, Calendar, Docs |
| AI | **Claude Code CLI** subprocess | Agent with MCP tool access |

**Key architectural principles:**

1. **Parachute owns the data.** All reads and writes go through its HTTP API. Never touch SQLite directly.
2. **Tags are the type system.** The vault's 22 tag schemas drive content type inference and renderer selection.
3. **Frontend decides nothing about data.** All external API calls happen in Rust. The frontend only talks to Rust via Tauri IPC.
4. **Agent uses Claude Code CLI.** Spawns `claude -p` processes (not the Anthropic API) for full tool and MCP access.

---

## :world_map: Roadmap

| Version | Focus |
|---------|-------|
| **v0.2** | Mobile companion app, real-time collaboration |
| **v0.3** | Plugin system for custom renderers and integrations |
| **v0.4** | Voice memo capture + transcription |
| **v0.5** | Knowledge graph visualization |
| **v0.6** | End-to-end encryption |
| **Future** | Multi-device sync, shared vaults, web version |

---

## :handshake: Contributing

Contributions are welcome! To get started:

1. Fork the repository and create a feature branch
2. Read [`CLAUDE.md`](./CLAUDE.md) for the full development guide, architecture details, and common patterns
3. Run `npx tsc --noEmit` and `cargo check` (from `src-tauri/`) before submitting
4. Open a pull request with a clear description of what changed and why

Please [open an issue](https://github.com/omniharmonic/prism/issues) for bugs, feature requests, or questions.

---

## :page_facing_up: License

This project is licensed under the [MIT License](./LICENSE).

---

## :pray: Credits

Built by **Benjamin Life** / [OmniHarmonic](https://github.com/omniharmonic)

Powered by:

- [Parachute](https://github.com/omniharmonic/parachute) — universal data layer and knowledge graph
- [Tauri](https://tauri.app) — native desktop app framework
- [TipTap](https://tiptap.dev) — headless rich text editor
- [Claude Code](https://claude.ai) — AI agent by Anthropic
