# Prism — Product Requirements Document

**The universal interface for your entire digital life.**
**Version:** 0.3 | **Date:** April 10, 2026 | **Author:** Benjamin Life

---

## 1. The Core Idea

You should never have to think about where your data lives.

A message is a message — whether it came from WhatsApp, Telegram, Discord, LinkedIn, Instagram, Messenger, Twitter, iMessage, or email. You read it in the same place. You reply in the same place. The platform badge is a footnote, not a destination.

A document is a document — whether it lives in your local vault, Google Docs, or Notion. You edit it in the same editor. When you save, it syncs to wherever it needs to go. You never open Google Docs. You never open Notion. You open Prism.

A presentation is a presentation. A task board is a task board. A calendar is a calendar. A code project is a code project. The interface adapts to the content type. The data flows to and from external services invisibly. The AI agent is the bridge — it mediates transformations, suggests edits, drafts replies — but it's in the background. The star of the show is your work.

**Prism is one window. Everything flows through it.**

---

## 2. What You See

### 2.1 The Three Zones

```
┌────────────┬──────────────────────────────────┬─────────────────┐
│            │                                  │                 │
│ Navigation │         Active Canvas            │  Context Panel  │
│            │                                  │                 │
│ Projects   │  (adapts to content type)        │  Agent chat     │
│ Messages   │                                  │  Metadata       │
│ Calendar   │  Document? → prose editor        │  Sync status    │
│ Search     │  Presentation? → slide editor    │  Links          │
│            │  Messages? → chat thread         │  History        │
│            │  Tasks? → kanban board           │                 │
│            │  Code? → code editor             │                 │
│            │  Email? → composer/thread        │                 │
│            │  Calendar? → day/week/month      │                 │
│            │  Spreadsheet? → data grid        │                 │
│            │  Website? → live preview + code   │                 │
│            │                                  │                 │
├────────────┴──────────────────────────────────┴─────────────────┤
│ Status: 3 unread │ 2 syncing │ Next: Call w/ Patricia 2:30 PM   │
└─────────────────────────────────────────────────────────────────┘
```

**Navigation (left)** — How you find things. Organized by project, with top-level sections for Messages, Calendar, and Search. Every project groups its documents, tasks, threads, and events together. You click a project, you see everything related to it.

**Canvas (center)** — Where you work. The renderer changes based on what you opened. One tab system across all content types. You can have a document, a kanban board, an email draft, and a chat thread open as tabs simultaneously.

**Context Panel (right, collapsible)** — Where the agent lives, plus metadata. When you need AI help, it's here. When you want to see sync status, tags, linked documents, or version history, it's here. Collapse it when you just want to write.

### 2.2 Navigation Sidebar

```
┌─────────────────────┐
│ ⌘K Search...        │
│                     │
│ ▾ INBOX             │  ← Unified inbox: all unread across
│   3 WhatsApp        │     every platform + email
│   1 Email           │
│   1 Telegram        │
│                     │
│ ▾ CALENDAR          │  ← Today's schedule + upcoming
│   Call w/ Patricia   │
│   OpenCivics standup │
│                     │
│ ▾ PROJECTS          │
│   ▸ OpenCivics      │  ← Each project contains:
│   ▾ SquadSwarm      │     docs, tasks, threads, events
│     PRD.md          │
│     Technical Arch   │
│     ▸ Tasks (4)     │
│     ▸ Threads (2)   │
│   ▸ Potluck         │
│   ▸ Localism Fund   │
│   ▸ Barn Raise      │
│   ▸ Spirit of FR    │
│                     │
│ ▾ RECENT            │
│   Food Systems Doc   │
│   Email to Jim       │
│   Gitcoin Invoice    │
│                     │
│ + New...            │
└─────────────────────┘
```

**Unified Inbox** aggregates all unread items: emails from both Gmail accounts, messages from every Matrix-bridged platform, and any notifications. One list. Platform badges tell you the source. Click to open in the canvas. Reply right there.

**Projects** mirror your vault's path structure. A project is a folder in Parachute. Everything under `Projects/SquadSwarm/` groups together. Tasks associated with that project appear in a sub-section. Message threads tagged to that project appear too. The project view itself is a renderer — open the project node and you get a dashboard: kanban board, recent documents, active threads, upcoming events.

**+ New** opens a type selector: Document, Presentation, Spreadsheet, Code File, Email, Task, Event, Note. Each creates a new Parachute note with the appropriate `metadata.type` and opens the matching renderer.

---

## 3. The Renderers

Every content type has a dedicated editing experience. The canvas selects the renderer based on `metadata.type`. All renderers share: tabs, undo/redo, auto-save, inline agent prompt (`⌘J`), and the command bar (`⌘K`).

### 3.1 Document Renderer

**For:** essays, specs, reports, proposals, blog posts, letters, contracts, meeting notes

**Editor:** TipTap block editor with rich formatting

**What it does:**
- Full prose editing: headings, lists, blockquotes, code blocks, images, tables, callouts, toggles, embeds
- Slash commands (`/`) for inserting blocks or prompting the agent
- Focus mode (dim everything except current section)
- Document outline from heading structure
- Word count, reading time in status bar
- Templates: technical-spec, blog-post, proposal, letter, contract, meeting-notes

**Where it syncs:**
- Google Docs (bidirectional — collaborators edit in Docs, changes flow back)
- Notion pages (bidirectional)
- Export: DOCX, PDF, HTML, Markdown

### 3.2 Presentation Renderer

**For:** slide decks, pitch decks, talk materials

**Content format:** Markdown with `---` as slide separators

**What it does:**
- Grid view (all slides as thumbnails) + single-slide editor
- Each slide is a TipTap editing surface
- Slide types: title, content, image, split, code, quote
- Speaker notes below each slide
- Presenter mode: fullscreen with timer, next-slide preview, notes
- Drag-and-drop slide reordering
- Themes (dark, light, gradient, custom)

**Where it syncs:**
- Google Slides (push — creates/updates a Slides deck)
- Export: PPTX, PDF, HTML (self-contained)

### 3.3 Code Renderer

**For:** source code, scripts, config files

**Editor:** Monaco (the VS Code editor engine)

**What it does:**
- Syntax highlighting, line numbers, minimap, bracket matching
- Language detection from file extension or metadata
- Multiple cursors, find-and-replace
- Split view for side-by-side files
- Integrated terminal (optional)

**Where it syncs:**
- GitHub repos (push/pull via git)
- GitHub Pages / Cloudflare Pages / Vercel (deploy)

### 3.4 Message Renderer

**For:** ALL messaging platforms — unified UX

**Data source:** Matrix Client-Server API (localhost:8008) which bridges WhatsApp, Telegram, Discord, LinkedIn, Instagram, Messenger, Twitter. Plus iMessage via native macOS integration.

**What it does:**
- Chat thread view: messages grouped by sender, timestamps, media
- Platform badge on each thread (small, not dominant — the conversation is the point)
- Compose and reply inline — message routes through the appropriate bridge
- Contact cards with cross-platform presence
- Search across all message history regardless of platform
- Unread indicators roll up to the Inbox section
- Group chats and DMs both supported

**The key insight:** You don't go to WhatsApp. You don't go to Telegram. You go to Messages. Your conversation with Patricia shows all channels in one thread if you want, or separated by platform if you prefer.

### 3.5 Email Renderer

**For:** email composition, reading, and thread management

**Data source:** Gmail API (both `benjamin@opencivics.co` and `omniharmonicagent@gmail.com`)

**What it does:**
- **Inbox view:** Thread list with sender, subject, preview, triage badge. Filter by account, label. Batch archive/label.
- **Thread view:** Conversation-style, newest at bottom. Reply inline.
- **Compose view:** To/CC/BCC with autocomplete, subject, rich body editor. Account selector. Attachments from vault or filesystem.
- **CRITICAL:** Plain text email formatting only (no markdown — Gmail doesn't render it)

**Where it syncs:**
- Gmail (bidirectional — inbox pulls automatically, send pushes)
- Emails stored as vault notes for offline search

### 3.6 Task Board Renderer

**For:** kanban boards, project task management

**Data source:** `state/active-tasks.json` (existing OmniHarmonic task system) + Parachute notes with `type: "task"`

**What it does:**
- Kanban columns: Inbox → To Do → In Progress → Blocked → Done
- Drag-and-drop between columns
- Card details: description, project, priority, deadline, assignee
- Quick-add from any column
- Filter by project, priority, assignee
- Overdue highlighting with graduated urgency

**Where it syncs:**
- Notion tasks database (bidirectional — existing sync)
- Individual tasks linkable to documents, threads, events

### 3.7 Calendar Renderer

**For:** schedule, events, availability

**Data source:** Google Calendar API

**What it does:**
- Day, week, month views
- Create/edit events with attendees, location, Meet link
- See availability gaps (from existing `find_slots.py`)
- Events linked to projects when tagged

**Where it syncs:**
- Google Calendar (bidirectional)

### 3.8 Spreadsheet Renderer

**For:** tabular data, CSVs, structured data

**Editor:** TanStack Table (headless, high-performance)

**What it does:**
- Editable cells with type detection (number, date, text, boolean)
- Sort, filter, group by column
- Basic formulas
- Import CSV/XLSX, export CSV/XLSX

**Where it syncs:**
- Google Sheets (push)
- Export: CSV, XLSX

### 3.9 Website Renderer

**For:** web projects, HTML, static sites

**What it does:**
- Split view: code editor (left) + live preview (right)
- Hot reload on edit
- Multi-file support (HTML, CSS, JS)
- One-click deploy

**Where it syncs:**
- GitHub Pages / Cloudflare Pages / Vercel (deploy)
- GitHub repo (push)

### 3.10 Project Renderer

**For:** project overview dashboards

**What it does:**
- Aggregates everything tagged to a project:
  - Kanban board of project tasks
  - Recent/pinned documents
  - Active message threads related to the project
  - Upcoming calendar events
  - Active agent swarms
- Project health indicator (from intelligence layer)
- Quick actions: new document, new task, new thread

---

## 4. The Data Layer

### 4.1 Parachute is the Canonical Source

Every piece of content in Prism is a Parachute note. The vault is the single source of truth. External services (Google Docs, Notion, Gmail, Matrix, Google Calendar) are **mirrors** — Prism pushes to them and pulls from them, but the vault is authoritative.

```
Vault (SQLite via Parachute API at localhost:1940)
  │
  ├── Notes with metadata.type → determines renderer
  ├── Links between notes → knowledge graph
  ├── Tags → filtering and organization
  ├── Attachments → files, images, audio
  └── Full-text search → instant across everything
```

### 4.2 Content Type Metadata

Every note carries a `metadata.type` field. This is the only thing the UI needs to decide how to render it:

```typescript
// The renderer registry is simple
const RENDERERS: Record<string, Component> = {
  "document":       DocumentRenderer,
  "note":           DocumentRenderer,      // lightweight document
  "presentation":   PresentationRenderer,
  "code":           CodeRenderer,
  "email":          EmailRenderer,
  "message-thread": MessageRenderer,
  "task-board":     TaskBoardRenderer,
  "task":           TaskDetailRenderer,
  "event":          EventRenderer,
  "project":        ProjectRenderer,
  "spreadsheet":    SpreadsheetRenderer,
  "website":        WebsiteRenderer,
  "canvas":         CanvasRenderer,
  "briefing":       DocumentRenderer,      // read-only document
};
```

### 4.3 Sync Configs

Each note can have sync destinations stored in its metadata:

```typescript
interface SyncConfig {
  adapter: "google-docs" | "google-slides" | "google-sheets"
         | "notion" | "gmail" | "github" | "vercel";
  remote_id: string;           // Doc ID, page ID, repo URL, etc.
  last_synced: string;         // ISO timestamp
  direction: "push" | "pull" | "bidirectional";
  conflict_strategy: "local-wins" | "remote-wins" | "ask";
  auto_sync: boolean;          // Sync on every save?
}
```

**Sync is per-document, opt-in.** You choose which documents sync where. The status bar shows sync state. Conflicts surface as a diff you resolve in the canvas.

### 4.4 External Service Connectors

| Service | Protocol | What flows in | What flows out |
|---------|----------|--------------|----------------|
| **Gmail** | Gmail API (OAuth2) | Inbox emails → vault notes | Composed emails → sent |
| **Google Calendar** | Calendar API (OAuth2) | Events → vault notes | Created/edited events |
| **Google Docs** | Docs API (OAuth2) | Collaborator edits → vault | Document content → Doc |
| **Google Slides** | Slides API (OAuth2) | — | Presentation content → Deck |
| **Google Sheets** | Sheets API (OAuth2) | — | Spreadsheet data → Sheet |
| **Notion** | Notion API | Page edits → vault | Document content → Page |
| **Matrix/Synapse** | Client-Server API | All messages from all bridges | Replies → routed to platform |
| **iMessage** | macOS native (AppleScript) | Message threads | Replies |
| **GitHub** | GitHub API / git | Repo state, issues | Code pushes, deploys |
| **Vercel/Cloudflare** | Deploy APIs | Deploy status | Site builds |

**The agent's role here:** When you type `⌘K → "sync this to Google Docs"`, the agent doesn't do anything magical. It just sets up the sync config in metadata and triggers the adapter. When you type `⌘K → "turn this doc into a presentation"`, the agent transforms the content structure and changes the type. The agent is the natural language interface to operations that are ultimately deterministic.

---

## 5. The Agent Layer

The agent is embedded, not featured. It's available everywhere via three interaction patterns:

### 5.1 Inline Prompt (`⌘J`)

Select text in any renderer. Press `⌘J`. A small prompt field appears at the selection. Type your intent: "make this more concise," "add a counterargument," "translate to Spanish." The agent applies the edit as a diff you accept or reject. Fast, focused, non-disruptive.

### 5.2 Command Bar (`⌘K`)

Universal command palette. Does everything:
- **Search:** fuzzy search across vault, messages, emails, events
- **Create:** `new document`, `new presentation`, `new task`, `new email to Patricia`
- **Transform:** `turn this into a presentation`, `export as PDF`
- **Sync:** `sync to Google Docs`, `push to Notion`, `deploy to Vercel`
- **Navigate:** jump to any project, document, thread
- **Agent:** any natural language query falls through to Claude

### 5.3 Context Panel Chat

For longer conversations — brainstorming, multi-step drafts, research. The panel sees your current document as context. You can "apply" any suggestion to the canvas with one click.

---

## 6. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Desktop shell | **Tauri 2.x** | Native, lightweight, Rust backend for async sync + system APIs |
| Frontend | **React 19 + TypeScript** | Component ecosystem, concurrent rendering |
| Styling | **Tailwind CSS** + glass design tokens | `backdrop-filter` glass system, dark-first |
| Document editor | **TipTap 3** | Extensible block editor over ProseMirror |
| Code editor | **Monaco** | VS Code's engine |
| Data grid | **TanStack Table** | Headless, virtualized |
| Drag-and-drop | **@dnd-kit** | Accessible, performant (kanban, slides) |
| State | **Zustand** (UI) + **TanStack Query** (server) | Minimal + smart caching |
| Matrix client | **matrix-js-sdk** | Official SDK for Synapse |
| Icons | **Lucide** | Clean, consistent |
| Fonts | **Inter** / **JetBrains Mono** / **Newsreader** | Sans / mono / serif |

### 6.1 Glass Design System

```css
:root {
  --bg: #0a0a0b;
  --glass: rgba(255, 255, 255, 0.06);
  --glass-hover: rgba(255, 255, 255, 0.10);
  --glass-active: rgba(255, 255, 255, 0.14);
  --glass-border: rgba(255, 255, 255, 0.08);
  --glass-blur: 24px;

  --text: rgba(255, 255, 255, 0.92);
  --text-secondary: rgba(255, 255, 255, 0.55);
  --text-muted: rgba(255, 255, 255, 0.30);

  --accent: #7C9FE8;
  --accent-dim: rgba(124, 159, 232, 0.15);

  --green: #6FCF97;
  --yellow: #F2C94C;
  --red: #EB5757;

  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  --font-serif: 'Newsreader', Georgia, serif;

  --radius: 10px;
  --transition: 150ms ease-out;
}

.glass {
  background: var(--glass);
  backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: var(--radius);
}
```

Minimal chrome. Content-forward. Depth through transparency and blur, not borders and shadows. The interface should feel like looking through frosted glass at your ideas.

---

## 7. Implementation Architecture

### 7.1 Frontend File Structure

```
src/
├── app/
│   ├── App.tsx                    # Shell layout
│   ├── stores/                    # Zustand UI state
│   └── hooks/                     # Data hooks (TanStack Query)
│
├── components/
│   ├── layout/
│   │   ├── Shell.tsx              # Three-panel layout
│   │   ├── Navigation.tsx         # Left sidebar
│   │   ├── Canvas.tsx             # Tab bar + active renderer
│   │   ├── ContextPanel.tsx       # Agent + metadata
│   │   ├── StatusBar.tsx          # Bottom strip
│   │   └── CommandBar.tsx         # ⌘K overlay
│   │
│   ├── renderers/                 # One per content type
│   │   ├── Registry.ts            # type → component mapping
│   │   ├── DocumentRenderer.tsx
│   │   ├── PresentationRenderer.tsx
│   │   ├── CodeRenderer.tsx
│   │   ├── EmailRenderer.tsx
│   │   ├── MessageRenderer.tsx
│   │   ├── TaskBoardRenderer.tsx
│   │   ├── CalendarRenderer.tsx
│   │   ├── SpreadsheetRenderer.tsx
│   │   ├── WebsiteRenderer.tsx
│   │   └── ProjectRenderer.tsx
│   │
│   ├── navigation/
│   │   ├── Inbox.tsx              # Unified unread across platforms
│   │   ├── ProjectTree.tsx        # Project file tree
│   │   ├── CalendarMini.tsx       # Today's schedule
│   │   └── NewContentMenu.tsx     # + New type selector
│   │
│   ├── agent/
│   │   ├── InlinePrompt.tsx       # ⌘J selection prompt
│   │   ├── PanelChat.tsx          # Right panel conversation
│   │   └── DiffView.tsx           # Accept/reject agent edits
│   │
│   └── ui/                        # Glass design system components
│       ├── Glass.tsx
│       ├── Button.tsx
│       ├── Input.tsx
│       ├── Badge.tsx
│       ├── Tabs.tsx
│       ├── Dialog.tsx
│       └── Toast.tsx
│
├── lib/
│   ├── parachute.ts               # Typed client for localhost:1940
│   ├── matrix.ts                  # Client for localhost:8008
│   ├── sync/
│   │   ├── google-docs.ts         # Markdown ↔ Google Docs
│   │   ├── google-slides.ts       # Slides ↔ Google Slides
│   │   ├── notion.ts              # Markdown ↔ Notion blocks
│   │   ├── gmail.ts               # Email ↔ Gmail
│   │   ├── calendar.ts            # Events ↔ Google Calendar
│   │   └── github.ts              # Code ↔ GitHub
│   ├── transforms.ts              # Cross-type content transformation
│   └── types.ts                   # All TypeScript interfaces
│
└── styles/
    ├── tokens.css                 # Design tokens
    ├── glass.css                  # Glass utilities
    └── typography.css             # Type scale
```

### 7.2 Tauri Backend (Rust)

```
src-tauri/
├── src/
│   ├── main.rs
│   ├── commands/                  # Tauri command handlers
│   │   ├── vault.rs               # Proxy to Parachute API
│   │   ├── matrix.rs              # Matrix Client-Server API
│   │   ├── google.rs              # OAuth2 + all Google APIs
│   │   ├── notion.rs              # Notion API
│   │   ├── github.rs              # GitHub API
│   │   ├── agent.rs               # Anthropic API calls
│   │   ├── tasks.rs               # Read/write active-tasks.json
│   │   ├── sync.rs                # Background sync coordinator
│   │   └── export.rs              # DOCX, PDF, PPTX generation
│   ├── auth/
│   │   ├── oauth2.rs              # OAuth2 flows (deep links)
│   │   └── keychain.rs            # macOS Keychain storage
│   └── services/
│       ├── file_watcher.rs        # Watch for external vault changes
│       ├── notifications.rs       # Native macOS notifications
│       └── hotkey.rs              # Global hotkey (⌘+Space or similar)
```

### 7.3 Key Design Decision: Parachute API, Not Direct SQLite

Prism talks to Parachute's HTTP API (`localhost:1940`), never touches the SQLite file directly. This means:
- Parachute's MCP tools, other clients, and future features all stay compatible
- Prism is a presentation layer, not a database owner
- If Parachute adds real-time subscriptions or multi-device sync later, Prism gets it for free

### 7.4 Key Design Decision: Matrix for All Messaging

Every messaging platform is already bridged into Matrix via the mautrix bridges running in Docker. Prism doesn't need platform-specific clients for WhatsApp, Telegram, Discord, etc. It talks to one API (Matrix Client-Server at localhost:8008) and gets all of them. The bridge handles protocol translation. Prism just renders rooms and sends messages.

### 7.5 Key Design Decision: Content in Markdown, Structure in Metadata

Document content stays as markdown in Parachute's `content` field. This keeps it portable, human-readable, and compatible with the existing vault. Structural information (slide boundaries, email headers, task status) lives in `metadata`. Renderers parse the markdown into blocks for rich editing and write it back as markdown on save.

---

## 8. Data Flows

### 8.1 "I want to write a document and share it with Patricia"

```
1. ⌘K → "new document: Food Systems Proposal"
2. Prism creates note in Parachute: { type: "document", path: "Projects/FoodSystems/proposal" }
3. DocumentRenderer opens. You write.
4. Auto-save every 2s → PATCH /api/notes/{id}
5. ⌘K → "sync to Google Docs"
6. Tauri backend: OAuth2 check → create Google Doc → store doc ID in metadata
7. Content transformed: markdown → Google Docs API format → pushed
8. You share the Google Doc link with Patricia (outside Prism)
9. Patricia edits in Google Docs
10. Next sync: Prism pulls changes → shows diff if conflict → merges
11. You keep working in Prism. Patricia keeps working in Docs. Both stay synced.
```

### 8.2 "Patricia sent me a WhatsApp message about the proposal"

```
1. Matrix bridge receives WhatsApp message → syncs to Synapse
2. Prism's Matrix client sees new message → unread count increments in Inbox
3. You click the thread in Inbox
4. MessageRenderer opens: chat thread with Patricia
5. Platform badge: "WhatsApp" (small, top-right of thread)
6. You type a reply → Prism sends via Matrix → bridge routes to WhatsApp
7. Patricia receives your reply in WhatsApp. She has no idea you're using Prism.
```

### 8.3 "Turn this document into a presentation"

```
1. You're in DocumentRenderer with the Food Systems Proposal open
2. ⌘K → "turn this into a presentation"
3. Agent analyzes document structure:
   - H1 → title slide
   - H2s → slide titles
   - Key paragraphs → slide content
   - Images → full-bleed slides
4. Agent creates new note: { type: "presentation", content: transformed markdown }
5. PresentationRenderer opens with the generated slides
6. You edit, reorder, add speaker notes
7. ⌘K → "sync to Google Slides" → deck created in Google Slides
```

### 8.4 "What's on my plate this week?"

```
1. Click "Calendar" in navigation
2. CalendarRenderer opens in week view
3. Events pulled from Google Calendar API
4. Click any event → EventRenderer with details, attendees, Meet link
5. Switch to a project → ProjectRenderer shows:
   - Kanban board with 4 overdue tasks
   - 3 documents in progress
   - 2 unread message threads about this project
   - Tomorrow's standup event
```

---

## 9. Content Type Metadata Reference

```typescript
// Every Parachute note's metadata includes at minimum:
interface PrismMeta {
  type: ContentType;              // Determines which renderer to use
  project?: string;               // Project association
  sync?: SyncConfig[];            // Where this syncs to
}

// Type-specific extensions:

// document, note
{ type: "document", template?: string, status?: "draft"|"review"|"final" }

// presentation
{ type: "presentation", aspect_ratio: "16:9", theme: string, slide_separator: "---" }

// email
{ type: "email", from: string, to: string[], subject: string,
  account: string, gmail_id?: string, thread_id?: string,
  status: "draft"|"sent"|"received" }

// message-thread
{ type: "message-thread", platform: string, matrix_room_id: string,
  participants: string[], is_dm: boolean, unread_count: number }

// task
{ type: "task", status: string, priority: string, deadline?: string,
  project?: string, notion_page_id?: string }

// event
{ type: "event", title: string, start: string, end: string,
  attendees?: string[], google_event_id?: string, meet_url?: string }

// code
{ type: "code", language?: string, repo_url?: string }

// website
{ type: "website", framework?: string, deploy_target?: string, live_url?: string }

// spreadsheet
{ type: "spreadsheet", columns?: string[], row_count?: number }

// presentation
{ type: "presentation", slide_count: number, aspect_ratio: "16:9"|"4:3" }
```

---

## 10. Cross-Type Transformation Rules

The agent can transform any content type into any other where it makes sense. These are the core transformations:

| From | To | How |
|------|----|-----|
| Document → Presentation | H1→title slide, H2→slide titles, paragraphs→content, images→full-bleed |
| Document → Email | Title→subject, content→body, strip formatting to plain text |
| Document → Website | Title→page title, headings→sections, auto-generate nav |
| Presentation → Document | Slide titles→H2, content→paragraphs, speaker notes→callouts |
| Email thread → Document | Subject→title, messages→chronological sections |
| Task board → Spreadsheet | Columns→table columns, cards→rows |
| Voice memo → Document | Transcription→content, timestamp→metadata |
| Any → Note | Strip to plain text summary |

---

## 11. Build Roadmap

### Phase 1: Foundation (Weeks 1-2)

- [ ] Tauri project scaffolding (Rust + React + TypeScript + Tailwind)
- [ ] Glass design system: tokens, core components (Glass, Button, Input, Badge, Tabs)
- [ ] Shell layout: three-panel with resize handles
- [ ] Parachute client library (typed HTTP client for localhost:1940)
- [ ] Navigation sidebar: project tree from vault paths, search via `/search`
- [ ] Tab system: open multiple documents as tabs
- [ ] Command bar (`⌘K`): fuzzy search + basic commands

### Phase 2: Core Renderers (Weeks 3-4)

- [ ] DocumentRenderer: TipTap block editor, auto-save to Parachute
- [ ] CodeRenderer: Monaco integration
- [ ] Content type detection from metadata → renderer switching
- [ ] New content creation flow (+ New → type selector → renderer opens)
- [ ] Context panel: metadata display, tag editing

### Phase 3: Communications (Weeks 5-6)

- [ ] Matrix client integration (matrix-js-sdk → localhost:8008)
- [ ] MessageRenderer: unified chat thread across all platforms
- [ ] Unified Inbox: aggregated unread across Matrix + Gmail
- [ ] EmailRenderer: inbox list, thread view, compose with rich editor
- [ ] Gmail API integration via Tauri backend (OAuth2 + send/receive)

### Phase 4: Sync & Collaboration (Weeks 7-8)

- [ ] Google Docs sync adapter (markdown ↔ Docs API format)
- [ ] Notion sync adapter (markdown ↔ Notion blocks)
- [ ] Sync status UI: per-document indicators, conflict resolution
- [ ] Google Calendar integration: CalendarRenderer with day/week/month views

### Phase 5: Extended Renderers (Weeks 9-10)

- [ ] PresentationRenderer: slide editor, presenter mode
- [ ] TaskBoardRenderer: kanban with drag-and-drop, Notion sync
- [ ] ProjectRenderer: aggregated dashboard per project
- [ ] SpreadsheetRenderer: editable data grid

### Phase 6: Agent Integration (Weeks 11-12)

- [ ] Inline prompt (`⌘J`): selection-based agent interaction with diff view
- [ ] Panel chat: conversational agent in context panel
- [ ] Command bar agent fallthrough: natural language → operations
- [ ] Cross-type transformation via agent
- [ ] Google Slides sync, GitHub push, deploy integrations

### Phase 7: Polish & Extended (Weeks 13+)

- [ ] WebsiteRenderer: split code + preview, deploy
- [ ] CanvasRenderer: freeform spatial layout
- [ ] Knowledge graph visualization (Parachute `/graph` endpoint)
- [ ] Voice memo capture + transcription (Parachute `/ingest`)
- [ ] Plugin system for custom renderers
- [ ] Mobile companion app

---

## 12. Success Metrics

**Context switches per hour:** Target <2 (from current 10+). Measured by app-switch events.

**Unified inbox coverage:** All platforms (WhatsApp, Telegram, Discord, LinkedIn, Instagram, Messenger, Twitter, iMessage, Gmail) accessible in one inbox. Target: 100%.

**Sync reliability:** >95% of sync operations complete without manual intervention.

**Time-to-share:** From finishing a document to sharing it via Google Docs/Notion. Target: <5 seconds (currently: several minutes of manual export).

**Vault coverage:** >80% of active documents live in Parachute as canonical source within 30 days.

---

## 13. Open Questions

1. **Matrix bridge reliability.** How stable are the mautrix bridges for bidirectional messaging? What's the failure mode when a bridge disconnects? Need graceful degradation.

2. **Google Docs round-trip fidelity.** How much formatting survives markdown → Google Docs → markdown? Need to test with real documents and define acceptable loss.

3. **Sync conflict UX.** When both local and remote change, how do we present the conflict without overwhelming? Three-way merge diff? Side-by-side? Simple "keep mine / keep theirs / merge"?

4. **Offline messaging.** If Matrix/bridges are down, queue outbound messages and send when reconnected? Or just show an error?

5. **Performance at scale.** The vault has hundreds of notes. How does the file tree perform? Need virtualization for large lists.

6. **iMessage write access.** macOS restricts programmatic iMessage sending. AppleScript works but is fragile. May need to be read-only initially with a "open in Messages" button for replies.

7. **Parachute evolution.** As Aaron adds features (webhooks? real-time subscriptions?), Prism should adopt them. Need a close feedback loop.

---

*One window. Every message, every document, every task, every event. The data flows where it needs to. The interface meets you where you are. The agent handles the plumbing. You just think.*
