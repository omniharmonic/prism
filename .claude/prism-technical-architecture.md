# Prism — Technical Architecture Document

**Version:** 1.0 | **Date:** April 10, 2026 | **Status:** Implementation-Ready
**Companion:** `prism-prd-v3.md` (Product Requirements Document)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Runtime Environment](#2-runtime-environment)
3. [Tauri Backend (Rust)](#3-tauri-backend)
4. [Frontend Application (React)](#4-frontend-application)
5. [Parachute Integration](#5-parachute-integration)
6. [Content Type System](#6-content-type-system)
7. [Renderer Architecture](#7-renderer-architecture)
8. [Sync Engine](#8-sync-engine)
9. [Matrix Messaging Integration](#9-matrix-messaging-integration)
10. [Gmail Integration](#10-gmail-integration)
11. [Google Calendar Integration](#11-google-calendar-integration)
12. [Agent Integration](#12-agent-integration)
13. [Task System Integration](#13-task-system-integration)
14. [Authentication & Security](#14-authentication--security)
15. [State Management](#15-state-management)
16. [Design System](#16-design-system)
17. [Command Bar System](#17-command-bar-system)
18. [Keyboard Shortcuts](#18-keyboard-shortcuts)
19. [File Export Pipeline](#19-file-export-pipeline)
20. [Error Handling & Offline Behavior](#20-error-handling--offline-behavior)
21. [Build & Development](#21-build--development)
22. [Configuration & Environment](#22-configuration--environment)
23. [Performance Considerations](#23-performance-considerations)
24. [Future Extension Points](#24-future-extension-points)

---

## 1. System Overview

### 1.1 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     PRISM (Tauri 2.x)                       │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              React Frontend (Webview)                  │  │
│  │                                                       │  │
│  │  Navigation ◄──► Canvas (Renderer) ◄──► Context Panel │  │
│  │                                                       │  │
│  │  Stores: Zustand (UI) + TanStack Query (server data)  │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │ Tauri IPC (invoke / events)       │
│  ┌──────────────────────┴────────────────────────────────┐  │
│  │              Rust Backend (Tauri Core)                 │  │
│  │                                                       │  │
│  │  ┌─────────┐ ┌─────────┐ ┌────────┐ ┌─────────────┐  │  │
│  │  │Parachute│ │ Matrix  │ │ Google │ │   Notion    │  │  │
│  │  │ Client  │ │ Client  │ │ Client │ │   Client    │  │  │
│  │  └────┬────┘ └────┬────┘ └───┬────┘ └──────┬──────┘  │  │
│  │  ┌────┴────┐ ┌────┴────┐ ┌───┴────┐ ┌──────┴──────┐  │  │
│  │  │  Sync   │ │  Auth   │ │ Agent  │ │   Tasks     │  │  │
│  │  │ Engine  │ │ (OAuth) │ │(Claude)│ │  Manager    │  │  │
│  │  └─────────┘ └─────────┘ └────────┘ └─────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
      │              │              │              │
      ▼              ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐
│Parachute │  │  Matrix   │  │ Google   │  │    Notion    │
│  Vault   │  │ Synapse   │  │  APIs    │  │     API      │
│          │  │           │  │          │  │              │
│ REST API │  │ CS API    │  │ Gmail    │  │ Pages        │
│ :1940    │  │ :8008     │  │ Calendar │  │ Databases    │
│          │  │           │  │ Docs     │  │              │
│ SQLite   │  │ Postgres  │  │ Slides   │  │              │
│ vault.db │  │           │  │ Sheets   │  │              │
└──────────┘  └──────────┘  └──────────┘  └──────────────┘
```

### 1.2 Key Architectural Principles

**Principle 1: Parachute owns the data.** Prism never touches `vault.db` directly. All reads and writes go through the Parachute HTTP API at `localhost:1940`. This keeps Prism as a pure presentation/sync layer and maintains compatibility with Parachute's MCP tools and other clients.

**Principle 2: The frontend decides nothing about data.** All external API calls (Google, Notion, Matrix, Claude) happen in the Rust backend. The frontend only talks to the Rust backend via Tauri IPC. This ensures secrets never touch the webview, and network operations are centralized.

**Principle 3: Content type determines rendering.** The `metadata.type` field on each Parachute note is the sole input to renderer selection. No heuristics, no guessing. If the type is wrong, the user changes it.

**Principle 4: Sync is explicit and per-document.** Nothing syncs unless the user configures it. Each document can have zero or more `SyncConfig` entries in its metadata. The sync engine processes these independently.

### 1.3 Process Model

Prism runs as a single Tauri process with two threads of execution:

1. **Main thread (Rust):** Tauri core, window management, system tray, global hotkey listener, IPC command handlers
2. **Webview thread (JavaScript):** React application, rendering, user interaction

Background work (sync polling, Matrix long-polling, Gmail polling) runs on Tokio async tasks within the Rust process. These emit events to the frontend via Tauri's event system.

---

## 2. Runtime Environment

### 2.1 System Requirements

| Requirement | Value |
|-------------|-------|
| OS | macOS 13+ (Ventura) — primary target. Linux/Windows possible later via Tauri cross-platform |
| Runtime | Tauri 2.x (bundles native webview — WKWebView on macOS) |
| Rust | 1.75+ (for async trait support) |
| Node | 20+ (build toolchain only — not runtime) |
| Disk | ~50MB app bundle + vault size |
| Network | localhost access to Parachute (:1940), Matrix (:8008). Internet for Google/Notion/Claude APIs |

### 2.2 Local Services (Must Be Running)

| Service | Port | Purpose | How to start |
|---------|------|---------|-------------|
| Parachute Vault | 1940 | Data layer | `~/.parachute/start.sh` |
| Matrix Synapse | 8008 | Messaging hub | `docker compose up -d` (in `omniharmonic_agent/matrix/`) |
| Matrix bridges | — | Platform bridges | Started by docker compose (WhatsApp, Telegram, Discord, LinkedIn, Instagram, Messenger, Twitter) |

### 2.3 External Services (Internet Required)

| Service | Auth | Purpose |
|---------|------|---------|
| Google APIs (Gmail, Calendar, Docs, Slides, Sheets) | OAuth2 | Email, calendar, document sync |
| Notion API | Bearer token (integration) | Page/database sync |
| Anthropic API (Claude) | API key | AI agent |
| GitHub API | Personal access token | Code sync, deploy |

---

## 3. Tauri Backend

### 3.1 Crate Structure

```
src-tauri/
├── Cargo.toml
├── tauri.conf.json
├── capabilities/              # Tauri 2 permission capabilities
│   └── default.json
├── icons/
└── src/
    ├── main.rs                # Entry point, app builder
    ├── lib.rs                 # Re-exports
    ├── error.rs               # Unified error type
    │
    ├── commands/              # Tauri IPC command handlers
    │   ├── mod.rs
    │   ├── vault.rs           # Parachute CRUD proxies
    │   ├── matrix.rs          # Matrix messaging
    │   ├── google.rs          # All Google API operations
    │   ├── notion.rs          # Notion API operations
    │   ├── agent.rs           # Claude API calls
    │   ├── tasks.rs           # Task system (active-tasks.json)
    │   ├── sync.rs            # Sync trigger/status commands
    │   ├── export.rs          # File export (docx, pdf, pptx)
    │   ├── config.rs          # App settings CRUD
    │   └── system.rs          # Health checks, service status
    │
    ├── clients/               # HTTP client wrappers
    │   ├── mod.rs
    │   ├── parachute.rs       # Parachute REST client
    │   ├── matrix.rs          # Matrix Client-Server API
    │   ├── google.rs          # Google API client (with token refresh)
    │   ├── notion.rs          # Notion API client
    │   └── anthropic.rs       # Claude API client
    │
    ├── sync/                  # Sync engine
    │   ├── mod.rs
    │   ├── engine.rs          # Coordinator: polls, dispatches adapters
    │   ├── adapters/
    │   │   ├── mod.rs
    │   │   ├── google_docs.rs
    │   │   ├── google_slides.rs
    │   │   ├── google_sheets.rs
    │   │   ├── notion.rs
    │   │   ├── gmail.rs
    │   │   ├── calendar.rs
    │   │   └── github.rs
    │   ├── transform/         # Content format transformers
    │   │   ├── mod.rs
    │   │   ├── md_to_gdocs.rs
    │   │   ├── gdocs_to_md.rs
    │   │   ├── md_to_notion.rs
    │   │   ├── notion_to_md.rs
    │   │   ├── md_to_slides.rs
    │   │   └── md_to_sheets.rs
    │   └── conflict.rs        # Conflict detection and resolution
    │
    ├── auth/
    │   ├── mod.rs
    │   ├── oauth2.rs          # OAuth2 flow (Google, Notion)
    │   ├── keychain.rs        # macOS Keychain read/write
    │   └── tokens.rs          # Token storage, refresh, validation
    │
    ├── services/
    │   ├── mod.rs
    │   ├── matrix_poller.rs   # Long-poll Matrix /sync endpoint
    │   ├── gmail_poller.rs    # Periodic Gmail inbox check
    │   ├── calendar_poller.rs # Periodic calendar event refresh
    │   ├── sync_scheduler.rs  # Auto-sync timer for configured docs
    │   ├── file_watcher.rs    # Watch Parachute for external changes
    │   └── notifications.rs   # macOS native notifications
    │
    └── models/                # Shared Rust types
        ├── mod.rs
        ├── note.rs            # Note, NoteIndex, PrismMetadata
        ├── link.rs            # Link
        ├── sync_config.rs     # SyncConfig, SyncStatus
        ├── message.rs         # MatrixMessage, Thread
        ├── email.rs           # Email, EmailThread
        ├── event.rs           # CalendarEvent
        ├── task.rs            # Task (maps to active-tasks.json)
        └── agent.rs           # AgentRequest, AgentResponse, Diff
```

### 3.2 Tauri IPC Commands

Every function the frontend can call. Organized by domain.

#### 3.2.1 Vault Commands (`commands/vault.rs`)

```rust
// All vault commands proxy to Parachute API at localhost:1940

#[tauri::command]
async fn vault_list_notes(
    tags: Option<Vec<String>>,
    tag_match: Option<String>,       // "all" | "any"
    exclude_tag: Option<String>,
    date_from: Option<String>,       // ISO-8601
    date_to: Option<String>,
    sort: Option<String>,            // "asc" | "desc"
    limit: Option<u32>,              // default 100
    offset: Option<u32>,
    include_content: Option<bool>,   // default false (returns NoteIndex)
) -> Result<Vec<NoteIndex>, PrismError>;

#[tauri::command]
async fn vault_get_note(id: String) -> Result<Note, PrismError>;

#[tauri::command]
async fn vault_create_note(
    content: String,
    path: Option<String>,
    tags: Option<Vec<String>>,
    metadata: Option<serde_json::Value>,
) -> Result<Note, PrismError>;

#[tauri::command]
async fn vault_update_note(
    id: String,
    content: Option<String>,
    path: Option<String>,
    metadata: Option<serde_json::Value>,
) -> Result<Note, PrismError>;

#[tauri::command]
async fn vault_delete_note(id: String) -> Result<(), PrismError>;

#[tauri::command]
async fn vault_search(
    query: String,
    tags: Option<Vec<String>>,
    limit: Option<u32>,
) -> Result<Vec<Note>, PrismError>;

#[tauri::command]
async fn vault_get_tags() -> Result<Vec<TagCount>, PrismError>;

#[tauri::command]
async fn vault_add_tags(id: String, tags: Vec<String>) -> Result<(), PrismError>;

#[tauri::command]
async fn vault_remove_tags(id: String, tags: Vec<String>) -> Result<(), PrismError>;

#[tauri::command]
async fn vault_get_links(
    note_id: Option<String>,
    direction: Option<String>,       // "outbound" | "inbound" | "both"
    relationship: Option<String>,
) -> Result<Vec<Link>, PrismError>;

#[tauri::command]
async fn vault_create_link(
    source_id: String,
    target_id: String,
    relationship: String,
    metadata: Option<serde_json::Value>,
) -> Result<Link, PrismError>;

#[tauri::command]
async fn vault_delete_link(
    source_id: String,
    target_id: String,
    relationship: String,
) -> Result<(), PrismError>;

#[tauri::command]
async fn vault_get_graph(
    tags: Option<Vec<String>>,
    include_content: Option<bool>,
) -> Result<Graph, PrismError>;

#[tauri::command]
async fn vault_get_stats() -> Result<VaultStats, PrismError>;

#[tauri::command]
async fn vault_upload_attachment(
    note_id: String,
    file_path: String,
    mime_type: String,
) -> Result<Attachment, PrismError>;
```

#### 3.2.2 Matrix Commands (`commands/matrix.rs`)

```rust
#[tauri::command]
async fn matrix_get_rooms() -> Result<Vec<MatrixRoom>, PrismError>;

#[tauri::command]
async fn matrix_get_messages(
    room_id: String,
    limit: Option<u32>,              // default 50
    from: Option<String>,            // pagination token
) -> Result<MessageBatch, PrismError>;

#[tauri::command]
async fn matrix_send_message(
    room_id: String,
    body: String,
    msg_type: Option<String>,        // "m.text" (default) | "m.image" | "m.file"
) -> Result<String, PrismError>;    // returns event_id

#[tauri::command]
async fn matrix_get_room_members(
    room_id: String,
) -> Result<Vec<MatrixMember>, PrismError>;

#[tauri::command]
async fn matrix_mark_read(
    room_id: String,
    event_id: String,
) -> Result<(), PrismError>;

#[tauri::command]
async fn matrix_search_messages(
    query: String,
    room_id: Option<String>,         // None = search all rooms
) -> Result<Vec<SearchResult>, PrismError>;
```

#### 3.2.3 Google Commands (`commands/google.rs`)

```rust
// --- Gmail ---
#[tauri::command]
async fn gmail_list_threads(
    account: String,                 // "benjamin@opencivics.co" | "omniharmonicagent@gmail.com"
    query: Option<String>,           // Gmail search syntax
    max_results: Option<u32>,
    page_token: Option<String>,
) -> Result<GmailThreadList, PrismError>;

#[tauri::command]
async fn gmail_get_thread(
    account: String,
    thread_id: String,
) -> Result<GmailThread, PrismError>;

#[tauri::command]
async fn gmail_send(
    account: String,
    to: Vec<String>,
    cc: Option<Vec<String>>,
    bcc: Option<Vec<String>>,
    subject: String,
    body: String,                    // Plain text (NO markdown)
    in_reply_to: Option<String>,     // message ID for threading
) -> Result<String, PrismError>;    // returns message ID

#[tauri::command]
async fn gmail_archive(account: String, thread_id: String) -> Result<(), PrismError>;

#[tauri::command]
async fn gmail_label(
    account: String,
    thread_id: String,
    add_labels: Vec<String>,
    remove_labels: Vec<String>,
) -> Result<(), PrismError>;

// --- Calendar ---
#[tauri::command]
async fn calendar_list_events(
    from: String,                    // ISO-8601
    to: String,
    calendar_id: Option<String>,     // default "primary"
) -> Result<Vec<CalendarEvent>, PrismError>;

#[tauri::command]
async fn calendar_create_event(
    summary: String,
    start: String,
    end: String,
    attendees: Option<Vec<String>>,
    description: Option<String>,
    location: Option<String>,
    with_meet: Option<bool>,         // default true
) -> Result<CalendarEvent, PrismError>;

#[tauri::command]
async fn calendar_update_event(
    event_id: String,
    summary: Option<String>,
    start: Option<String>,
    end: Option<String>,
    attendees: Option<Vec<String>>,
    description: Option<String>,
) -> Result<CalendarEvent, PrismError>;

#[tauri::command]
async fn calendar_delete_event(event_id: String) -> Result<(), PrismError>;

// --- Docs sync ---
#[tauri::command]
async fn gdocs_push(note_id: String) -> Result<SyncResult, PrismError>;

#[tauri::command]
async fn gdocs_pull(note_id: String) -> Result<SyncResult, PrismError>;

#[tauri::command]
async fn gdocs_create(note_id: String, title: String) -> Result<String, PrismError>; // returns doc ID

// --- Slides sync ---
#[tauri::command]
async fn gslides_push(note_id: String) -> Result<SyncResult, PrismError>;
#[tauri::command]
async fn gslides_create(note_id: String, title: String) -> Result<String, PrismError>;
```

#### 3.2.4 Notion Commands (`commands/notion.rs`)

```rust
#[tauri::command]
async fn notion_push(note_id: String) -> Result<SyncResult, PrismError>;

#[tauri::command]
async fn notion_pull(note_id: String) -> Result<SyncResult, PrismError>;

#[tauri::command]
async fn notion_create_page(
    note_id: String,
    parent_page_id: Option<String>,  // Notion page ID to create under
) -> Result<String, PrismError>;    // returns Notion page ID

#[tauri::command]
async fn notion_search(query: String) -> Result<Vec<NotionSearchResult>, PrismError>;
```

#### 3.2.5 Agent Commands (`commands/agent.rs`)

```rust
#[tauri::command]
async fn agent_edit(
    note_id: String,
    selection: Option<String>,       // selected text, if any
    cursor_position: Option<u32>,
    prompt: String,                  // user's intent
    context_note_ids: Option<Vec<String>>,  // additional context notes
) -> Result<AgentEditResponse, PrismError>;

#[tauri::command]
async fn agent_chat(
    messages: Vec<ChatMessage>,      // conversation history
    current_note_id: Option<String>, // current document for context
) -> Result<ChatMessage, PrismError>;

#[tauri::command]
async fn agent_transform(
    note_id: String,
    target_type: String,             // ContentType to transform to
) -> Result<Note, PrismError>;      // returns newly created note

#[tauri::command]
async fn agent_generate(
    prompt: String,
    content_type: String,            // what type of content to generate
    project: Option<String>,         // project context
) -> Result<Note, PrismError>;
```

#### 3.2.6 Task Commands (`commands/tasks.rs`)

```rust
// Reads/writes state/active-tasks.json with file locking
// Matches existing OmniHarmonic task schema

#[tauri::command]
async fn tasks_list(
    project: Option<String>,
    status: Option<String>,
    priority: Option<String>,
) -> Result<Vec<Task>, PrismError>;

#[tauri::command]
async fn tasks_get(id: String) -> Result<Task, PrismError>;

#[tauri::command]
async fn tasks_create(
    description: String,
    project: Option<String>,
    priority: Option<String>,        // "urgent" | "high" | "medium" | "low"
    deadline: Option<String>,
    task_type: Option<String>,
) -> Result<Task, PrismError>;

#[tauri::command]
async fn tasks_update(
    id: String,
    status: Option<String>,
    priority: Option<String>,
    description: Option<String>,
    deadline: Option<String>,
) -> Result<Task, PrismError>;

#[tauri::command]
async fn tasks_move_column(
    id: String,
    column: String,                  // "inbox" | "todo" | "in-progress" | "blocked" | "done"
) -> Result<Task, PrismError>;

#[tauri::command]
async fn tasks_get_kanban(
    project: Option<String>,
) -> Result<KanbanData, PrismError>;
```

#### 3.2.7 Sync Commands (`commands/sync.rs`)

```rust
#[tauri::command]
async fn sync_trigger(note_id: String) -> Result<Vec<SyncResult>, PrismError>;

#[tauri::command]
async fn sync_status(note_id: String) -> Result<Vec<SyncStatus>, PrismError>;

#[tauri::command]
async fn sync_add_config(
    note_id: String,
    adapter: String,
    direction: String,
    auto_sync: bool,
) -> Result<SyncConfig, PrismError>;

#[tauri::command]
async fn sync_remove_config(
    note_id: String,
    adapter: String,
    remote_id: String,
) -> Result<(), PrismError>;

#[tauri::command]
async fn sync_resolve_conflict(
    note_id: String,
    adapter: String,
    resolution: String,              // "local" | "remote" | "merged"
    merged_content: Option<String>,  // if resolution is "merged"
) -> Result<(), PrismError>;
```

#### 3.2.8 System Commands (`commands/system.rs`)

```rust
#[tauri::command]
async fn system_health() -> Result<SystemHealth, PrismError>;

#[tauri::command]
async fn system_service_status() -> Result<ServiceStatus, PrismError>;
// Returns: { parachute: bool, matrix: bool, gmail_auth: bool, calendar_auth: bool, notion_auth: bool }

#[tauri::command]
async fn system_open_oauth(service: String) -> Result<(), PrismError>;
// Opens browser for OAuth flow

#[tauri::command]
async fn system_get_config() -> Result<AppConfig, PrismError>;

#[tauri::command]
async fn system_set_config(config: AppConfig) -> Result<(), PrismError>;
```

### 3.3 Tauri Events (Backend → Frontend)

Events emitted by background services that the frontend subscribes to:

```rust
// Matrix
"matrix:new-message"       → { room_id, event_id, sender, body, timestamp }
"matrix:typing"            → { room_id, user_id }
"matrix:read-receipt"      → { room_id, event_id, user_id }
"matrix:room-update"       → { room_id, unread_count }

// Gmail
"gmail:new-email"          → { account, thread_id, from, subject, snippet }
"gmail:inbox-update"       → { account, unread_count }

// Calendar
"calendar:event-reminder"  → { event_id, summary, start, minutes_until }
"calendar:events-updated"  → { events: CalendarEvent[] }

// Sync
"sync:started"             → { note_id, adapter }
"sync:completed"           → { note_id, adapter, result }
"sync:conflict"            → { note_id, adapter, local_version, remote_version }
"sync:error"               → { note_id, adapter, error }

// System
"system:service-down"      → { service, error }
"system:service-up"        → { service }
```

### 3.4 Background Services

#### Matrix Poller (`services/matrix_poller.rs`)

Long-polls the Matrix `/sync` endpoint continuously. Maintains a `since` token for incremental sync. Emits `matrix:*` events to the frontend.

```rust
pub struct MatrixPoller {
    client: MatrixClient,
    since_token: Option<String>,
    room_cache: HashMap<String, RoomState>,  // room_id → cached state
}

impl MatrixPoller {
    pub async fn run(&mut self, app_handle: AppHandle) -> ! {
        loop {
            let response = self.client.sync(
                self.since_token.as_deref(),
                Some(30_000),  // 30s long-poll timeout
            ).await;

            match response {
                Ok(sync) => {
                    self.since_token = Some(sync.next_batch);
                    for (room_id, room_data) in sync.rooms.join {
                        for event in room_data.timeline.events {
                            app_handle.emit("matrix:new-message", &event).ok();
                        }
                    }
                }
                Err(e) => {
                    app_handle.emit("system:service-down", &json!({"service": "matrix", "error": e.to_string()})).ok();
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    }
}
```

#### Gmail Poller (`services/gmail_poller.rs`)

Polls Gmail inbox every 60 seconds (configurable). Checks both accounts.

```rust
pub struct GmailPoller {
    client: GoogleClient,
    accounts: Vec<String>,          // ["benjamin@opencivics.co", "omniharmonicagent@gmail.com"]
    poll_interval: Duration,        // default 60s
    last_history_id: HashMap<String, String>,  // per-account incremental sync
}
```

#### Sync Scheduler (`services/sync_scheduler.rs`)

Monitors notes with `auto_sync: true` in their sync config. On save events from the frontend, triggers the appropriate sync adapter after a debounce period (5 seconds).

```rust
pub struct SyncScheduler {
    pending_syncs: HashMap<String, Instant>,  // note_id → last_edit_time
    debounce: Duration,                       // 5 seconds
}
```

---

## 4. Frontend Application

### 4.1 Entry Point and Routing

```tsx
// src/app/App.tsx
import { Shell } from "@/components/layout/Shell";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useListenMatrixEvents } from "@/hooks/useMatrixEvents";
import { useListenSyncEvents } from "@/hooks/useSyncEvents";
import { useListenGmailEvents } from "@/hooks/useGmailEvents";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,        // 30s before refetch
      gcTime: 5 * 60_000,       // 5min cache retention
      retry: 2,
      refetchOnWindowFocus: true,
    },
  },
});

export function App() {
  // Subscribe to Tauri backend events
  useListenMatrixEvents(queryClient);
  useListenSyncEvents(queryClient);
  useListenGmailEvents(queryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}
```

Prism does not use URL-based routing. Navigation is state-driven: the active note/view is stored in Zustand. This avoids URL complexity and keeps the app feeling like a native desktop tool rather than a web app.

### 4.2 Component Tree

```
<App>
  <QueryClientProvider>
    <Shell>
      ├── <Navigation>                    # Left sidebar
      │   ├── <SearchBox />               # Quick search (⌘K triggers full command bar)
      │   ├── <InboxSection />            # Unified unread: messages + emails
      │   │   └── <InboxItem />           # Single unread item with platform badge
      │   ├── <CalendarMini />            # Today's schedule
      │   │   └── <MiniEventCard />
      │   ├── <ProjectTree />             # Project file tree
      │   │   └── <ProjectNode />         # Expandable project folder
      │   │       ├── <NoteNode />        # Document/code/presentation node
      │   │       ├── <TasksSubsection /> # Task count for project
      │   │       └── <ThreadsSubsection />  # Message threads for project
      │   ├── <RecentSection />           # Recently opened
      │   └── <NewContentMenu />          # + New button with type selector
      │
      ├── <Canvas>                        # Center: active content
      │   ├── <TabBar />                  # Open document tabs
      │   │   └── <Tab />                 # Single tab with title, close, sync indicator
      │   └── <RendererContainer />       # Renders active tab's content
      │       └── <DocumentRenderer />    # (or any renderer — selected by type)
      │
      ├── <ContextPanel>                  # Right sidebar (collapsible)
      │   ├── <ContextTabs />             # Agent | Metadata | Links | History
      │   ├── <AgentChat />               # Conversational agent
      │   │   └── <ChatMessage />
      │   ├── <MetadataPanel />           # Tags, type, sync configs, project
      │   │   ├── <TagEditor />
      │   │   ├── <SyncStatusList />
      │   │   └── <TypeSelector />
      │   ├── <LinksPanel />              # Linked notes (from Parachute links)
      │   └── <HistoryPanel />            # Version history
      │
      ├── <StatusBar>                     # Bottom strip
      │   ├── <UnreadBadge />
      │   ├── <SyncIndicator />
      │   ├── <NextEventBadge />
      │   └── <ServiceHealth />
      │
      ├── <CommandBar />                  # ⌘K overlay (modal)
      │   ├── <CommandInput />
      │   └── <CommandResults />
      │
      └── <InlinePrompt />               # ⌘J overlay (positioned at selection)
          ├── <PromptInput />
          └── <DiffPreview />
    </Shell>
  </QueryClientProvider>
</App>
```

### 4.3 TanStack Query Keys

All server data is cached and refetched through TanStack Query. Query keys follow a consistent hierarchy:

```typescript
// Query key factory
export const queryKeys = {
  // Vault
  vault: {
    all: ["vault"] as const,
    notes: (filters?: NoteFilters) => ["vault", "notes", filters] as const,
    note: (id: string) => ["vault", "notes", id] as const,
    search: (query: string) => ["vault", "search", query] as const,
    tags: () => ["vault", "tags"] as const,
    links: (noteId?: string) => ["vault", "links", noteId] as const,
    graph: (filters?: GraphFilters) => ["vault", "graph", filters] as const,
    stats: () => ["vault", "stats"] as const,
  },

  // Matrix
  matrix: {
    all: ["matrix"] as const,
    rooms: () => ["matrix", "rooms"] as const,
    messages: (roomId: string) => ["matrix", "messages", roomId] as const,
    members: (roomId: string) => ["matrix", "members", roomId] as const,
  },

  // Gmail
  gmail: {
    all: ["gmail"] as const,
    threads: (account: string, query?: string) => ["gmail", "threads", account, query] as const,
    thread: (account: string, threadId: string) => ["gmail", "thread", account, threadId] as const,
  },

  // Calendar
  calendar: {
    all: ["calendar"] as const,
    events: (from: string, to: string) => ["calendar", "events", from, to] as const,
  },

  // Tasks
  tasks: {
    all: ["tasks"] as const,
    list: (project?: string) => ["tasks", "list", project] as const,
    kanban: (project?: string) => ["tasks", "kanban", project] as const,
    task: (id: string) => ["tasks", id] as const,
  },

  // Sync
  sync: {
    status: (noteId: string) => ["sync", "status", noteId] as const,
  },

  // System
  system: {
    health: () => ["system", "health"] as const,
    config: () => ["system", "config"] as const,
  },
};
```

### 4.4 Tauri IPC Wrapper

All frontend-to-backend communication goes through typed invoke wrappers:

```typescript
// src/lib/tauri.ts
import { invoke } from "@tauri-apps/api/core";

// Type-safe invoke wrapper
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

// Example usage in hooks:
export const vaultApi = {
  listNotes: (filters?: NoteFilters) =>
    call<NoteIndex[]>("vault_list_notes", filters),

  getNote: (id: string) =>
    call<Note>("vault_get_note", { id }),

  createNote: (params: CreateNoteParams) =>
    call<Note>("vault_create_note", params),

  updateNote: (id: string, params: UpdateNoteParams) =>
    call<Note>("vault_update_note", { id, ...params }),

  deleteNote: (id: string) =>
    call<void>("vault_delete_note", { id }),

  search: (query: string, tags?: string[], limit?: number) =>
    call<Note[]>("vault_search", { query, tags, limit }),

  getTags: () =>
    call<TagCount[]>("vault_get_tags"),
};

export const matrixApi = {
  getRooms: () => call<MatrixRoom[]>("matrix_get_rooms"),
  getMessages: (roomId: string, limit?: number, from?: string) =>
    call<MessageBatch>("matrix_get_messages", { room_id: roomId, limit, from }),
  sendMessage: (roomId: string, body: string) =>
    call<string>("matrix_send_message", { room_id: roomId, body }),
  markRead: (roomId: string, eventId: string) =>
    call<void>("matrix_mark_read", { room_id: roomId, event_id: eventId }),
};

export const gmailApi = {
  listThreads: (account: string, query?: string) =>
    call<GmailThreadList>("gmail_list_threads", { account, query }),
  getThread: (account: string, threadId: string) =>
    call<GmailThread>("gmail_get_thread", { account, thread_id: threadId }),
  send: (params: SendEmailParams) =>
    call<string>("gmail_send", params),
};

export const agentApi = {
  edit: (params: AgentEditParams) =>
    call<AgentEditResponse>("agent_edit", params),
  chat: (messages: ChatMessage[], currentNoteId?: string) =>
    call<ChatMessage>("agent_chat", { messages, current_note_id: currentNoteId }),
  transform: (noteId: string, targetType: string) =>
    call<Note>("agent_transform", { note_id: noteId, target_type: targetType }),
};

export const syncApi = {
  trigger: (noteId: string) =>
    call<SyncResult[]>("sync_trigger", { note_id: noteId }),
  status: (noteId: string) =>
    call<SyncStatus[]>("sync_status", { note_id: noteId }),
  addConfig: (noteId: string, adapter: string, direction: string, autoSync: boolean) =>
    call<SyncConfig>("sync_add_config", { note_id: noteId, adapter, direction, auto_sync: autoSync }),
};

export const tasksApi = {
  list: (project?: string) => call<Task[]>("tasks_list", { project }),
  getKanban: (project?: string) => call<KanbanData>("tasks_get_kanban", { project }),
  create: (params: CreateTaskParams) => call<Task>("tasks_create", params),
  update: (id: string, params: UpdateTaskParams) => call<Task>("tasks_update", { id, ...params }),
  moveColumn: (id: string, column: string) => call<Task>("tasks_move_column", { id, column }),
};

export const calendarApi = {
  listEvents: (from: string, to: string) =>
    call<CalendarEvent[]>("calendar_list_events", { from, to }),
  createEvent: (params: CreateEventParams) =>
    call<CalendarEvent>("calendar_create_event", params),
};

export const systemApi = {
  health: () => call<SystemHealth>("system_health"),
  serviceStatus: () => call<ServiceStatus>("system_service_status"),
  openOAuth: (service: string) => call<void>("system_open_oauth", { service }),
  getConfig: () => call<AppConfig>("system_get_config"),
  setConfig: (config: AppConfig) => call<void>("system_set_config", { config }),
};
```

---

## 5. Parachute Integration

### 5.1 Client Implementation (Rust)

```rust
// src-tauri/src/clients/parachute.rs

pub struct ParachuteClient {
    base_url: String,     // "http://localhost:1940/api"
    api_key: Option<String>,
    client: reqwest::Client,
}

impl ParachuteClient {
    pub fn new(port: u16, api_key: Option<String>) -> Self {
        Self {
            base_url: format!("http://localhost:{}/api", port),
            api_key,
            client: reqwest::Client::new(),
        }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut req = self.client.request(method, format!("{}{}", self.base_url, path));
        // Localhost bypasses auth, but include key if configured
        if let Some(key) = &self.api_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }
        req
    }

    // -- Notes --
    pub async fn list_notes(&self, params: &ListNotesParams) -> Result<Vec<NoteIndex>> { ... }
    pub async fn get_note(&self, id: &str) -> Result<Note> { ... }
    pub async fn create_note(&self, params: &CreateNoteParams) -> Result<Note> { ... }
    pub async fn update_note(&self, id: &str, params: &UpdateNoteParams) -> Result<Note> { ... }
    pub async fn delete_note(&self, id: &str) -> Result<()> { ... }

    // -- Search --
    pub async fn search(&self, query: &str, tags: &[String], limit: u32) -> Result<Vec<Note>> { ... }

    // -- Tags --
    pub async fn get_tags(&self) -> Result<Vec<TagCount>> { ... }
    pub async fn add_tags(&self, id: &str, tags: &[String]) -> Result<()> { ... }
    pub async fn remove_tags(&self, id: &str, tags: &[String]) -> Result<()> { ... }

    // -- Links --
    pub async fn get_links(&self, params: &GetLinksParams) -> Result<Vec<Link>> { ... }
    pub async fn create_link(&self, params: &CreateLinkParams) -> Result<Link> { ... }
    pub async fn delete_link(&self, params: &DeleteLinkParams) -> Result<()> { ... }

    // -- Graph --
    pub async fn get_graph(&self, params: &GetGraphParams) -> Result<Graph> { ... }

    // -- Stats --
    pub async fn get_vault_info(&self, name: &str) -> Result<VaultInfo> { ... }

    // -- Storage --
    pub async fn upload(&self, file_path: &Path, transcribe: bool) -> Result<StorageResult> { ... }

    // -- Health --
    pub async fn health(&self) -> Result<HealthResponse> { ... }
}
```

### 5.2 Parachute Configuration

```rust
// Read from ~/.parachute/config.yaml at startup
pub struct ParachuteConfig {
    pub port: u16,                     // default 1940
    pub default_vault: String,         // default "default"
    pub api_key: Option<String>,       // from config.yaml api_keys[0].id
}

impl ParachuteConfig {
    pub fn load() -> Result<Self> {
        let home = dirs::home_dir().expect("no home dir");
        let config_path = home.join(".parachute/config.yaml");
        let config: serde_yaml::Value = serde_yaml::from_reader(File::open(config_path)?)?;
        Ok(Self {
            port: config["port"].as_u64().unwrap_or(1940) as u16,
            default_vault: config["default_vault"].as_str().unwrap_or("default").to_string(),
            api_key: None,  // Localhost bypasses auth
        })
    }
}
```

### 5.3 Note Path Convention

Parachute notes use the `path` field for hierarchical organization. Prism interprets paths as project membership:

```
path: "Projects/SquadSwarm/prd"           → Project: SquadSwarm
path: "Projects/OpenCivics/q2-planning"   → Project: OpenCivics
path: "Communications/Inbox/2026-04"      → Communications section
path: "Notes/daily/2026-04-10"            → Quick notes
path: null                                → Unfiled
```

The frontend builds the project tree by parsing paths:

```typescript
function buildProjectTree(notes: NoteIndex[]): TreeNode[] {
  const tree: Record<string, TreeNode> = {};
  for (const note of notes) {
    const parts = (note.path || "Unfiled").split("/");
    let current = tree;
    for (const part of parts) {
      if (!current[part]) {
        current[part] = { name: part, children: {}, notes: [] };
      }
      current = current[part].children;
    }
    current.__notes = current.__notes || [];
    current.__notes.push(note);
  }
  return tree;
}
```

---

## 6. Content Type System

### 6.1 Type Registry

```typescript
// src/lib/types.ts

export type ContentType =
  | "document"
  | "note"
  | "presentation"
  | "code"
  | "email"
  | "message-thread"
  | "task-board"
  | "task"
  | "event"
  | "project"
  | "spreadsheet"
  | "website"
  | "canvas"
  | "briefing"
  | "voice-memo";

// Metadata type discriminator
export interface PrismMetadata {
  type: ContentType;
  schema_version: number;
  project?: string;
  sync?: SyncConfig[];
  created_by?: "user" | "agent";
  [key: string]: unknown;
}

// How new content is initialized per type
export const CONTENT_DEFAULTS: Record<ContentType, { content: string; metadata: Partial<PrismMetadata> }> = {
  document: {
    content: "",
    metadata: { type: "document", schema_version: 1, status: "draft" },
  },
  note: {
    content: "",
    metadata: { type: "note", schema_version: 1 },
  },
  presentation: {
    content: "# Untitled Presentation\n\n---\n\n## Slide 2\n\n---\n\n## Slide 3",
    metadata: { type: "presentation", schema_version: 1, aspect_ratio: "16:9", slide_separator: "---" },
  },
  code: {
    content: "",
    metadata: { type: "code", schema_version: 1 },
  },
  email: {
    content: "",
    metadata: { type: "email", schema_version: 1, status: "draft", to: [], subject: "", account: "benjamin@opencivics.co" },
  },
  "message-thread": {
    content: "",
    metadata: { type: "message-thread", schema_version: 1 },
  },
  "task-board": {
    content: "",
    metadata: { type: "task-board", schema_version: 1 },
  },
  task: {
    content: "",
    metadata: { type: "task", schema_version: 1, status: "pending", priority: "medium" },
  },
  event: {
    content: "",
    metadata: { type: "event", schema_version: 1 },
  },
  project: {
    content: "",
    metadata: { type: "project", schema_version: 1, status: "active" },
  },
  spreadsheet: {
    content: "",
    metadata: { type: "spreadsheet", schema_version: 1, columns: [], row_count: 0 },
  },
  website: {
    content: "<!DOCTYPE html>\n<html>\n<head><title>Untitled</title></head>\n<body>\n\n</body>\n</html>",
    metadata: { type: "website", schema_version: 1 },
  },
  canvas: {
    content: "{}",
    metadata: { type: "canvas", schema_version: 1 },
  },
  briefing: {
    content: "",
    metadata: { type: "briefing", schema_version: 1 },
  },
  "voice-memo": {
    content: "",
    metadata: { type: "voice-memo", schema_version: 1 },
  },
};
```

### 6.2 Type Detection

For imported vault notes that lack a `metadata.type`, Prism infers the type:

```typescript
export function inferContentType(note: Note): ContentType {
  const meta = note.metadata as PrismMetadata | undefined;

  // Explicit type always wins
  if (meta?.type) return meta.type;

  // Infer from path
  if (note.path?.startsWith("Communications/")) return "email";
  if (note.path?.includes("/tasks/")) return "task";

  // Infer from tags
  if (note.tags?.includes("presentation")) return "presentation";
  if (note.tags?.includes("email")) return "email";

  // Infer from content
  if (note.content.includes("---\n") && note.content.split("---").length > 3) return "presentation";
  if (note.content.startsWith("<!DOCTYPE") || note.content.startsWith("<html")) return "website";
  if (note.content.startsWith("{") || note.content.startsWith("[")) return "spreadsheet";

  // Default
  return "document";
}
```

---

## 7. Renderer Architecture

### 7.1 Registry

```typescript
// src/components/renderers/Registry.ts
import { lazy } from "react";

const DocumentRenderer = lazy(() => import("./DocumentRenderer"));
const PresentationRenderer = lazy(() => import("./PresentationRenderer"));
const CodeRenderer = lazy(() => import("./CodeRenderer"));
const EmailRenderer = lazy(() => import("./EmailRenderer"));
const MessageRenderer = lazy(() => import("./MessageRenderer"));
const TaskBoardRenderer = lazy(() => import("./TaskBoardRenderer"));
const CalendarRenderer = lazy(() => import("./CalendarRenderer"));
const SpreadsheetRenderer = lazy(() => import("./SpreadsheetRenderer"));
const WebsiteRenderer = lazy(() => import("./WebsiteRenderer"));
const ProjectRenderer = lazy(() => import("./ProjectRenderer"));

export const RENDERER_MAP: Record<ContentType, React.LazyExoticComponent<any>> = {
  "document":       DocumentRenderer,
  "note":           DocumentRenderer,
  "briefing":       DocumentRenderer,
  "voice-memo":     DocumentRenderer,
  "presentation":   PresentationRenderer,
  "code":           CodeRenderer,
  "email":          EmailRenderer,
  "message-thread": MessageRenderer,
  "task-board":     TaskBoardRenderer,
  "task":           TaskBoardRenderer,
  "event":          CalendarRenderer,
  "project":        ProjectRenderer,
  "spreadsheet":    SpreadsheetRenderer,
  "website":        WebsiteRenderer,
  "canvas":         DocumentRenderer,   // placeholder until CanvasRenderer ships
};
```

### 7.2 Renderer Container

```tsx
// src/components/layout/Canvas.tsx
import { Suspense } from "react";
import { RENDERER_MAP } from "@/components/renderers/Registry";
import { useActiveNote } from "@/hooks/useActiveNote";
import { inferContentType } from "@/lib/types";

export function RendererContainer() {
  const { note, isLoading } = useActiveNote();

  if (isLoading) return <Skeleton />;
  if (!note) return <EmptyState />;

  const contentType = inferContentType(note);
  const Renderer = RENDERER_MAP[contentType];

  if (!Renderer) return <div>Unknown content type: {contentType}</div>;

  return (
    <Suspense fallback={<Skeleton />}>
      <Renderer
        note={note}
        onSave={handleSave}
        onMetadataChange={handleMetadataChange}
      />
    </Suspense>
  );
}
```

### 7.3 Renderer Interface

Every renderer receives the same props and communicates through the same callbacks:

```typescript
export interface RendererProps {
  note: Note;
  onSave: (content: string) => void;
  onMetadataChange: (metadata: Partial<PrismMetadata>) => void;
}

// Optional interface for agent interaction
export interface AgentCapableRenderer {
  getSelection: () => string | null;
  getCursorPosition: () => number | null;
  applyDiff: (diff: AgentDiff) => void;
  insertAtCursor: (content: string) => void;
}
```

### 7.4 Auto-Save Protocol

All renderers use a shared auto-save hook:

```typescript
// src/hooks/useAutoSave.ts
export function useAutoSave(noteId: string, content: string, debounceMs = 2000) {
  const updateNote = useMutation({
    mutationFn: (newContent: string) =>
      vaultApi.updateNote(noteId, { content: newContent }),
    onSuccess: () => queryClient.invalidateQueries(queryKeys.vault.note(noteId)),
  });

  const debouncedSave = useDebouncedCallback(
    (value: string) => updateNote.mutate(value),
    debounceMs
  );

  useEffect(() => {
    debouncedSave(content);
  }, [content]);

  return {
    isSaving: updateNote.isPending,
    lastSaved: updateNote.data?.updatedAt,
  };
}
```

### 7.5 DocumentRenderer Technical Details

```tsx
// Uses TipTap 3 with these extensions:
const extensions = [
  StarterKit,                    // Paragraphs, headings, lists, blockquotes, code blocks, etc.
  Placeholder.configure({ placeholder: "Start writing, or press / for commands..." }),
  Image,
  Table.configure({ resizable: true }),
  TaskList,
  TaskItem,
  Highlight,
  Link.configure({ openOnClick: false }),
  CodeBlockLowlight.configure({ lowlight }),  // Syntax highlighting in code blocks
  Typography,                    // Smart quotes, em-dashes
  SlashCommands,                 // Custom extension: / menu
  InlineAgent,                   // Custom extension: ⌘J prompt
  Collaboration,                 // Future: Yjs integration
];
```

### 7.6 PresentationRenderer Technical Details

Presentation content is markdown with `---` slide separators:

```typescript
function parseSlides(content: string, separator = "---"): Slide[] {
  return content.split(`\n${separator}\n`).map((slideContent, index) => {
    // Split speaker notes if present
    const [main, notes] = slideContent.split("\n???\n");
    return {
      index,
      content: main.trim(),
      speakerNotes: notes?.trim() || "",
    };
  });
}

function serializeSlides(slides: Slide[], separator = "---"): string {
  return slides.map(slide => {
    if (slide.speakerNotes) {
      return `${slide.content}\n\n???\n\n${slide.speakerNotes}`;
    }
    return slide.content;
  }).join(`\n\n${separator}\n\n`);
}
```

### 7.7 MessageRenderer Technical Details

The MessageRenderer does NOT store messages in Parachute. It reads directly from Matrix via the Tauri backend. This avoids duplicating the Matrix database and keeps messages live.

```tsx
function MessageRenderer({ note }: RendererProps) {
  const roomId = (note.metadata as MessageThreadMeta).matrix_room_id;

  const { data: messages, fetchNextPage, hasNextPage } = useInfiniteQuery({
    queryKey: queryKeys.matrix.messages(roomId),
    queryFn: ({ pageParam }) => matrixApi.getMessages(roomId, 50, pageParam),
    getNextPageParam: (lastPage) => lastPage.end,
    initialPageParam: undefined,
  });

  // ... render chat thread
}
```

For the unified inbox, the sidebar aggregates unread counts across all Matrix rooms and Gmail:

```typescript
function useUnifiedInbox() {
  const { data: rooms } = useQuery({
    queryKey: queryKeys.matrix.rooms(),
    queryFn: matrixApi.getRooms,
    refetchInterval: 10_000,
  });

  const { data: gmailBenjamin } = useQuery({
    queryKey: queryKeys.gmail.threads("benjamin@opencivics.co", "is:unread"),
    queryFn: () => gmailApi.listThreads("benjamin@opencivics.co", "is:unread"),
    refetchInterval: 60_000,
  });

  const { data: gmailAgent } = useQuery({
    queryKey: queryKeys.gmail.threads("omniharmonicagent@gmail.com", "is:unread"),
    queryFn: () => gmailApi.listThreads("omniharmonicagent@gmail.com", "is:unread"),
    refetchInterval: 60_000,
  });

  // Merge and sort by timestamp
  return mergeInboxItems(rooms, gmailBenjamin, gmailAgent);
}
```

---

## 8. Sync Engine

### 8.1 Sync Config Schema

Stored in each note's `metadata.sync` array:

```typescript
interface SyncConfig {
  adapter: "google-docs" | "google-slides" | "google-sheets"
         | "notion" | "gmail" | "github" | "vercel";
  remote_id: string;          // Google Doc ID, Notion page ID, etc.
  last_synced: string;        // ISO-8601 timestamp
  direction: "push" | "pull" | "bidirectional";
  conflict_strategy: "local-wins" | "remote-wins" | "ask";
  auto_sync: boolean;
}
```

### 8.2 Sync Adapter Trait

```rust
// src-tauri/src/sync/adapters/mod.rs

#[async_trait]
pub trait SyncAdapter: Send + Sync {
    /// Push local content to remote
    async fn push(&self, note: &Note, config: &SyncConfig) -> Result<SyncResult>;

    /// Pull remote content to local
    async fn pull(&self, note: &Note, config: &SyncConfig) -> Result<SyncResult>;

    /// Create a new remote resource from a local note
    async fn create_remote(&self, note: &Note) -> Result<String>;  // returns remote_id

    /// Check if remote has changed since last sync
    async fn remote_modified_since(&self, config: &SyncConfig) -> Result<bool>;

    /// Get remote content for conflict resolution
    async fn get_remote_content(&self, config: &SyncConfig) -> Result<String>;
}
```

### 8.3 Sync Flow (Bidirectional)

```rust
// src-tauri/src/sync/engine.rs

pub async fn sync_note(
    note: &Note,
    config: &SyncConfig,
    adapter: &dyn SyncAdapter,
    parachute: &ParachuteClient,
) -> Result<SyncResult> {
    let local_changed = note.updated_at > config.last_synced;
    let remote_changed = adapter.remote_modified_since(config).await?;

    match (local_changed, remote_changed) {
        // Nothing changed
        (false, false) => Ok(SyncResult::NoChange),

        // Only local changed — push
        (true, false) => adapter.push(note, config).await,

        // Only remote changed — pull
        (false, true) => {
            let result = adapter.pull(note, config).await?;
            // Update local note with pulled content
            parachute.update_note(&note.id, &UpdateNoteParams {
                content: Some(result.content.clone()),
                ..Default::default()
            }).await?;
            Ok(result)
        },

        // Both changed — conflict
        (true, true) => {
            match config.conflict_strategy.as_str() {
                "local-wins" => adapter.push(note, config).await,
                "remote-wins" => {
                    let result = adapter.pull(note, config).await?;
                    parachute.update_note(&note.id, &UpdateNoteParams {
                        content: Some(result.content.clone()),
                        ..Default::default()
                    }).await?;
                    Ok(result)
                },
                "ask" | _ => {
                    let remote = adapter.get_remote_content(config).await?;
                    Ok(SyncResult::Conflict {
                        local: note.content.clone(),
                        remote,
                    })
                }
            }
        }
    }
}
```

### 8.4 Content Transformers

#### Markdown → Google Docs

```rust
// src-tauri/src/sync/transform/md_to_gdocs.rs
// Converts markdown to Google Docs API batchUpdate requests

pub fn markdown_to_gdocs_requests(markdown: &str) -> Vec<Request> {
    let mut requests = Vec::new();
    let mut index = 1;  // Google Docs starts at index 1

    for event in pulldown_cmark::Parser::new(markdown) {
        match event {
            Event::Text(text) => {
                requests.push(Request::InsertText {
                    location: Location { index },
                    text: text.to_string(),
                });
                index += text.len() as i32;
            },
            Event::Start(Tag::Heading(level, ..)) => {
                // Apply heading style after text insertion
                // ...
            },
            // ... handle all markdown elements
        }
    }
    requests
}
```

#### Markdown → Notion Blocks

```rust
// src-tauri/src/sync/transform/md_to_notion.rs
// Converts markdown to Notion block objects

pub fn markdown_to_notion_blocks(markdown: &str) -> Vec<NotionBlock> {
    let parser = pulldown_cmark::Parser::new(markdown);
    let mut blocks = Vec::new();

    for event in parser {
        match event {
            Event::Start(Tag::Heading(level, ..)) => {
                blocks.push(NotionBlock::Heading {
                    level: level as u8,
                    text: collect_text(&mut parser),
                });
            },
            Event::Start(Tag::Paragraph) => {
                blocks.push(NotionBlock::Paragraph {
                    text: collect_rich_text(&mut parser),
                });
            },
            Event::Start(Tag::CodeBlock(info)) => {
                blocks.push(NotionBlock::Code {
                    language: info.to_string(),
                    text: collect_text(&mut parser),
                });
            },
            // ... handle all block types
        }
    }
    blocks
}
```

---

## 9. Matrix Messaging Integration

### 9.1 Matrix Client (Rust)

```rust
// src-tauri/src/clients/matrix.rs

pub struct MatrixClient {
    homeserver: String,        // "http://localhost:8008"
    access_token: String,
    user_id: String,           // "@benjamin:localhost" or similar
    client: reqwest::Client,
}

impl MatrixClient {
    // Client-Server API v1.x endpoints

    pub async fn sync(
        &self,
        since: Option<&str>,
        timeout: Option<u64>,
    ) -> Result<SyncResponse> {
        let mut url = format!("{}/_matrix/client/v3/sync", self.homeserver);
        // Add query params: since, timeout, filter
        self.get(&url).await
    }

    pub async fn get_messages(
        &self,
        room_id: &str,
        limit: u32,
        from: Option<&str>,
        dir: &str,               // "b" for backward (older messages)
    ) -> Result<MessagesResponse> {
        let url = format!(
            "{}/_matrix/client/v3/rooms/{}/messages?limit={}&dir={}",
            self.homeserver, room_id, limit, dir
        );
        self.get(&url).await
    }

    pub async fn send_message(
        &self,
        room_id: &str,
        body: &str,
        msg_type: &str,          // "m.text"
    ) -> Result<SendResponse> {
        let txn_id = uuid::Uuid::new_v4().to_string();
        let url = format!(
            "{}/_matrix/client/v3/rooms/{}/send/m.room.message/{}",
            self.homeserver, room_id, txn_id
        );
        self.put(&url, json!({
            "msgtype": msg_type,
            "body": body,
        })).await
    }

    pub async fn get_joined_rooms(&self) -> Result<Vec<String>> { ... }
    pub async fn get_room_state(&self, room_id: &str) -> Result<RoomState> { ... }
    pub async fn mark_read(&self, room_id: &str, event_id: &str) -> Result<()> { ... }
    pub async fn search(&self, query: &str) -> Result<SearchResults> { ... }
}
```

### 9.2 Platform Identification

Matrix bridges encode the source platform in room metadata. The frontend maps this to display badges:

```typescript
// src/lib/matrix/bridge-map.ts

export type Platform = "whatsapp" | "telegram" | "discord" | "linkedin"
                     | "instagram" | "messenger" | "twitter" | "matrix";

export function identifyPlatform(room: MatrixRoom): Platform {
  // Bridges set specific state events or naming patterns
  const bridgeBot = room.members.find(m =>
    m.userId.startsWith("@whatsappbot:") ||
    m.userId.startsWith("@telegrambot:") ||
    m.userId.startsWith("@discordbot:") ||
    m.userId.startsWith("@linkedinbot:") ||
    m.userId.startsWith("@instagrambot:") ||
    m.userId.startsWith("@messengerbot:") ||
    m.userId.startsWith("@twitterbot:")
  );

  if (!bridgeBot) return "matrix";

  if (bridgeBot.userId.includes("whatsapp")) return "whatsapp";
  if (bridgeBot.userId.includes("telegram")) return "telegram";
  if (bridgeBot.userId.includes("discord")) return "discord";
  if (bridgeBot.userId.includes("linkedin")) return "linkedin";
  if (bridgeBot.userId.includes("instagram")) return "instagram";
  if (bridgeBot.userId.includes("messenger")) return "messenger";
  if (bridgeBot.userId.includes("twitter")) return "twitter";

  return "matrix";
}

// Platform display config
export const PLATFORM_CONFIG: Record<Platform, { label: string; color: string; icon: string }> = {
  whatsapp:  { label: "WhatsApp",  color: "#25D366", icon: "message-circle" },
  telegram:  { label: "Telegram",  color: "#0088cc", icon: "send" },
  discord:   { label: "Discord",   color: "#5865F2", icon: "hash" },
  linkedin:  { label: "LinkedIn",  color: "#0A66C2", icon: "linkedin" },
  instagram: { label: "Instagram", color: "#E4405F", icon: "instagram" },
  messenger: { label: "Messenger", color: "#0084FF", icon: "message-square" },
  twitter:   { label: "X",         color: "#1DA1F2", icon: "twitter" },
  matrix:    { label: "Matrix",    color: "#0DBD8B", icon: "globe" },
};
```

---

## 10. Gmail Integration

### 10.1 Gmail Client (Rust)

```rust
// src-tauri/src/clients/google.rs (Gmail subset)

impl GoogleClient {
    // Uses Gmail API v1

    pub async fn list_threads(
        &self,
        account: &str,
        query: Option<&str>,
        max_results: u32,
        page_token: Option<&str>,
    ) -> Result<ThreadListResponse> {
        let url = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
        self.get_authed(account, url, &[
            ("q", query.unwrap_or("")),
            ("maxResults", &max_results.to_string()),
            ("pageToken", page_token.unwrap_or("")),
        ]).await
    }

    pub async fn get_thread(
        &self,
        account: &str,
        thread_id: &str,
    ) -> Result<ThreadResponse> {
        let url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/threads/{}?format=full",
            thread_id
        );
        self.get_authed(account, &url, &[]).await
    }

    pub async fn send_email(
        &self,
        account: &str,
        raw: &str,  // RFC 2822 encoded, base64url
    ) -> Result<MessageResponse> {
        let url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
        self.post_authed(account, url, json!({ "raw": raw })).await
    }

    // Helper: build RFC 2822 message
    pub fn build_raw_email(
        from: &str,
        to: &[String],
        cc: &[String],
        subject: &str,
        body: &str,
        in_reply_to: Option<&str>,
    ) -> String {
        // Returns base64url-encoded RFC 2822 message
        // IMPORTANT: body must be plain text, not markdown
    }
}
```

### 10.2 Gmail Accounts

Two accounts with independent OAuth tokens:

| Account | Purpose | Token Key |
|---------|---------|-----------|
| `benjamin@opencivics.co` | Primary work email | `google_token_benjamin` |
| `omniharmonicagent@gmail.com` | Agent's operational email | `google_token_agent` |

---

## 11. Google Calendar Integration

### 11.1 Calendar Client

```rust
impl GoogleClient {
    pub async fn list_events(
        &self,
        calendar_id: &str,      // "primary" or specific calendar ID
        time_min: &str,         // ISO-8601
        time_max: &str,
    ) -> Result<EventListResponse> {
        let url = format!(
            "https://www.googleapis.com/calendar/v3/calendars/{}/events",
            calendar_id
        );
        self.get_authed("benjamin@opencivics.co", &url, &[
            ("timeMin", time_min),
            ("timeMax", time_max),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
        ]).await
    }

    pub async fn create_event(
        &self,
        calendar_id: &str,
        event: &CalendarEventCreate,
    ) -> Result<CalendarEvent> {
        let url = format!(
            "https://www.googleapis.com/calendar/v3/calendars/{}/events",
            calendar_id
        );
        let mut body = json!({
            "summary": event.summary,
            "start": { "dateTime": event.start },
            "end": { "dateTime": event.end },
        });
        if event.with_meet {
            body["conferenceData"] = json!({
                "createRequest": {
                    "requestId": uuid::Uuid::new_v4().to_string(),
                    "conferenceSolutionKey": { "type": "hangoutsMeet" }
                }
            });
        }
        self.post_authed("benjamin@opencivics.co", &url, body).await
    }
}
```

---

## 12. Agent Integration

### 12.1 Claude API Client (Rust)

```rust
// src-tauri/src/clients/anthropic.rs

pub struct AnthropicClient {
    api_key: String,
    model: String,              // "claude-sonnet-4-20250514"
    client: reqwest::Client,
}

impl AnthropicClient {
    pub async fn complete(
        &self,
        system: &str,
        messages: &[Message],
        max_tokens: u32,
    ) -> Result<CompletionResponse> {
        let response = self.client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&json!({
                "model": self.model,
                "max_tokens": max_tokens,
                "system": system,
                "messages": messages,
            }))
            .send()
            .await?;

        response.json::<CompletionResponse>().await.map_err(Into::into)
    }
}
```

### 12.2 Agent Context Builder

```rust
// src-tauri/src/commands/agent.rs

fn build_agent_context(
    note: &Note,
    selection: Option<&str>,
    cursor_position: Option<u32>,
    linked_notes: &[NoteIndex],
) -> String {
    let mut context = format!(
        "Current document: {}\nPath: {}\nType: {}\nTags: {}\n\n",
        note.id,
        note.path.as_deref().unwrap_or("none"),
        note.metadata.get("type").and_then(|v| v.as_str()).unwrap_or("document"),
        note.tags.as_deref().unwrap_or(&[]).join(", "),
    );

    context.push_str("--- DOCUMENT CONTENT ---\n");
    context.push_str(&note.content);
    context.push_str("\n--- END CONTENT ---\n");

    if let Some(sel) = selection {
        context.push_str(&format!("\n--- SELECTED TEXT ---\n{}\n--- END SELECTION ---\n", sel));
    }

    if !linked_notes.is_empty() {
        context.push_str("\n--- LINKED DOCUMENTS ---\n");
        for linked in linked_notes {
            context.push_str(&format!("- {} ({})\n", linked.path.as_deref().unwrap_or("untitled"), linked.id));
        }
    }

    context
}
```

### 12.3 Agent Edit Response

```typescript
interface AgentEditResponse {
  original: string;              // The text that was selected/targeted
  suggested: string;             // The agent's replacement
  explanation: string;           // Why this edit was suggested
  diff: DiffChunk[];             // Structured diff for rendering
}

interface DiffChunk {
  type: "equal" | "insert" | "delete";
  content: string;
}
```

### 12.4 Inline Prompt Flow

```
1. User selects text in renderer
2. User presses ⌘J
3. InlinePrompt component appears at selection coordinates
4. User types intent ("make more concise")
5. Frontend calls agentApi.edit({
     note_id, selection, cursor_position, prompt
   })
6. Rust backend:
   a. Loads full note from Parachute
   b. Loads linked notes
   c. Builds context
   d. Calls Claude API with edit-focused system prompt
   e. Parses response into AgentEditResponse
7. Frontend shows DiffView inline at the selection
8. User clicks Accept → content updated, auto-saved
   User clicks Reject → diff dismissed, no change
```

---

## 13. Task System Integration

### 13.1 File Locking

The task system reads/writes `state/active-tasks.json` in the OmniHarmonic agent directory. Multiple processes (dashboard, Telegram bot, cron jobs) may access this concurrently. Prism MUST use file locking:

```rust
// src-tauri/src/commands/tasks.rs

use std::fs::{File, OpenOptions};
use std::os::unix::io::AsRawFd;

fn read_tasks_locked(path: &Path) -> Result<Vec<Task>> {
    let file = File::open(path)?;
    // Shared lock for reading
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH) };
    let tasks: Vec<Task> = serde_json::from_reader(&file)?;
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    Ok(tasks)
}

fn write_tasks_locked(path: &Path, tasks: &[Task]) -> Result<()> {
    let file = OpenOptions::new().write(true).truncate(true).open(path)?;
    // Exclusive lock for writing
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    serde_json::to_writer_pretty(&file, tasks)?;
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    Ok(())
}
```

### 13.2 Task Schema (matches existing `active-tasks.json`)

```typescript
interface Task {
  id: string;                    // "task-001"
  type: string;                  // "scheduling" | "research" | "coordination" | etc.
  description: string;
  requester: string;             // "Benjamin" | other
  dateReceived: string;          // ISO-8601
  deadline?: string;             // ISO-8601 | "recurring-daily" | "recurring-every-2h"
  status: string;                // "pending" | "todo" | "in-progress" | "blocked" | "completed"
  priority?: string;             // "urgent" | "high" | "medium" | "low"
  project?: string;
  context?: string;
  lastUpdate: string;            // ISO-8601
  notionPageId?: string;         // For Notion sync
}
```

### 13.3 Tasks File Path

```rust
const TASKS_FILE: &str = "/Users/benjaminlife/iCloud Drive (Archive)/Documents/cursor projects/omniharmonic_agent/state/active-tasks.json";
```

This path is configurable via `AppConfig`.

---

## 14. Authentication & Security

### 14.1 OAuth2 Flow (Google APIs)

```
1. User triggers: systemApi.openOAuth("google")
2. Rust backend starts local HTTP server on random port (e.g., 27182)
3. Opens browser to Google OAuth consent screen with redirect_uri=http://localhost:27182/callback
4. User grants access
5. Google redirects to localhost:27182/callback?code=...
6. Rust backend exchanges code for access_token + refresh_token
7. Tokens stored in macOS Keychain
8. Local HTTP server shuts down
```

### 14.2 Token Storage (macOS Keychain)

```rust
// src-tauri/src/auth/keychain.rs
use security_framework::passwords;

pub fn store_token(service: &str, account: &str, token: &str) -> Result<()> {
    passwords::set_generic_password(service, account, token.as_bytes())?;
    Ok(())
}

pub fn get_token(service: &str, account: &str) -> Result<String> {
    let (_, bytes) = passwords::get_generic_password(service, account)?;
    String::from_utf8(bytes).map_err(Into::into)
}

// Token keys:
// Service: "com.prism.google"
// Accounts: "benjamin@opencivics.co", "omniharmonicagent@gmail.com"
//
// Service: "com.prism.notion"
// Account: "default"
//
// Service: "com.prism.anthropic"
// Account: "default"
```

### 14.3 Token Refresh (Google)

```rust
pub async fn refresh_google_token(account: &str) -> Result<String> {
    let refresh_token = keychain::get_token("com.prism.google.refresh", account)?;
    let response = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", &CLIENT_ID),
            ("client_secret", &CLIENT_SECRET),
            ("refresh_token", &refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?;
    let data: TokenResponse = response.json().await?;
    keychain::store_token("com.prism.google", account, &data.access_token)?;
    Ok(data.access_token)
}
```

### 14.4 Security Rules

- **No secrets in the webview.** API keys and tokens live in the Rust backend only.
- **No direct external API calls from the frontend.** Everything goes through Tauri IPC.
- **Keychain-only storage.** No tokens in config files, env vars, or localStorage.
- **Parachute API on localhost only.** No exposure to network.
- **Matrix on localhost only.** Synapse listens on 127.0.0.1:8008.

---

## 15. State Management

### 15.1 Zustand Stores (UI State)

```typescript
// src/app/stores/ui.ts
interface UIStore {
  // Navigation
  sidebarOpen: boolean;
  sidebarWidth: number;          // pixels, resizable
  contextPanelOpen: boolean;
  contextPanelWidth: number;
  contextPanelTab: "agent" | "metadata" | "links" | "history";

  // Tabs
  openTabs: TabState[];
  activeTabId: string | null;

  // Command bar
  commandBarOpen: boolean;
  commandBarQuery: string;

  // Inline prompt
  inlinePromptOpen: boolean;
  inlinePromptPosition: { x: number; y: number } | null;

  // Actions
  toggleSidebar: () => void;
  toggleContextPanel: () => void;
  openTab: (noteId: string, title: string, type: ContentType) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  openCommandBar: () => void;
  closeCommandBar: () => void;
}

interface TabState {
  id: string;                    // unique tab ID
  noteId: string;                // Parachute note ID
  title: string;
  type: ContentType;
  dirty: boolean;                // unsaved changes
  syncStatus?: "synced" | "syncing" | "conflict" | "error";
}
```

### 15.2 Server State (TanStack Query)

All data from external sources is managed by TanStack Query. The frontend never stores server data in Zustand — it's always fetched, cached, and refetched through queries. See section 4.3 for query keys.

---

## 16. Design System

### 16.1 Design Tokens

```css
/* src/styles/tokens.css */
:root {
  /* ─── Background ─── */
  --bg-base: #0a0a0b;
  --bg-surface: rgba(255, 255, 255, 0.04);
  --bg-elevated: rgba(255, 255, 255, 0.06);
  --bg-overlay: rgba(0, 0, 0, 0.70);

  /* ─── Glass ─── */
  --glass-bg: rgba(255, 255, 255, 0.06);
  --glass-bg-hover: rgba(255, 255, 255, 0.10);
  --glass-bg-active: rgba(255, 255, 255, 0.14);
  --glass-border: rgba(255, 255, 255, 0.08);
  --glass-blur: 24px;

  /* ─── Text ─── */
  --text-primary: rgba(255, 255, 255, 0.92);
  --text-secondary: rgba(255, 255, 255, 0.55);
  --text-muted: rgba(255, 255, 255, 0.30);
  --text-inverse: #0a0a0b;

  /* ─── Accent ─── */
  --accent: #7C9FE8;
  --accent-hover: #93B0ED;
  --accent-dim: rgba(124, 159, 232, 0.15);
  --accent-text: #7C9FE8;

  /* ─── Semantic Colors ─── */
  --success: #6FCF97;
  --warning: #F2C94C;
  --error: #EB5757;
  --info: #56CCF2;

  /* ─── Typography ─── */
  --font-sans: 'Inter', -apple-system, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', monospace;
  --font-serif: 'Newsreader', Georgia, serif;

  --text-xs: 0.75rem;     /* 12px */
  --text-sm: 0.8125rem;   /* 13px */
  --text-base: 0.875rem;  /* 14px */
  --text-lg: 1rem;        /* 16px */
  --text-xl: 1.25rem;     /* 20px */
  --text-2xl: 1.5rem;     /* 24px */
  --text-3xl: 2rem;       /* 32px */

  /* ─── Spacing ─── */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;

  /* ─── Borders ─── */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 20px;

  /* ─── Shadows ─── */
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 12px 48px rgba(0, 0, 0, 0.5);

  /* ─── Motion ─── */
  --transition-fast: 100ms ease-out;
  --transition-base: 150ms ease-out;
  --transition-slow: 300ms ease-out;

  /* ─── Layout ─── */
  --sidebar-width: 240px;
  --sidebar-min-width: 180px;
  --sidebar-max-width: 400px;
  --context-panel-width: 320px;
  --context-panel-min-width: 240px;
  --context-panel-max-width: 500px;
  --status-bar-height: 28px;
  --tab-bar-height: 36px;
  --titlebar-height: 38px;       /* macOS traffic lights */
}
```

### 16.2 Glass Component

```tsx
// src/components/ui/Glass.tsx
interface GlassProps {
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;        // adds hover/active states
  elevated?: boolean;           // stronger blur + shadow
}

export function Glass({ children, className, interactive, elevated }: GlassProps) {
  return (
    <div className={cn(
      "backdrop-blur-[24px] border border-white/8 rounded-[10px]",
      elevated ? "bg-white/8 shadow-lg" : "bg-white/[0.04]",
      interactive && "hover:bg-white/10 active:bg-white/14 transition-colors duration-150",
      className
    )}>
      {children}
    </div>
  );
}
```

---

## 17. Command Bar System

### 17.1 Command Registry

```typescript
interface Command {
  id: string;
  label: string;
  shortcut?: string;
  icon?: string;
  category: "navigation" | "create" | "sync" | "transform" | "agent";
  action: (args?: string) => void | Promise<void>;
  when?: () => boolean;         // conditional visibility
}

const COMMANDS: Command[] = [
  // Navigation
  { id: "search", label: "Search vault", shortcut: "⌘K", category: "navigation", action: () => {} },
  { id: "goto-inbox", label: "Go to Inbox", category: "navigation", action: () => openInbox() },

  // Create
  { id: "new-document", label: "New Document", category: "create", action: () => createNote("document") },
  { id: "new-presentation", label: "New Presentation", category: "create", action: () => createNote("presentation") },
  { id: "new-email", label: "New Email", category: "create", action: () => createNote("email") },
  { id: "new-task", label: "New Task", category: "create", action: () => createTask() },
  { id: "new-code", label: "New Code File", category: "create", action: () => createNote("code") },
  { id: "new-spreadsheet", label: "New Spreadsheet", category: "create", action: () => createNote("spreadsheet") },
  { id: "new-website", label: "New Website", category: "create", action: () => createNote("website") },

  // Sync
  { id: "sync-gdocs", label: "Sync to Google Docs", category: "sync",
    action: () => syncActiveNote("google-docs"), when: () => hasActiveNote() },
  { id: "sync-notion", label: "Sync to Notion", category: "sync",
    action: () => syncActiveNote("notion"), when: () => hasActiveNote() },
  { id: "sync-gslides", label: "Sync to Google Slides", category: "sync",
    action: () => syncActiveNote("google-slides"), when: () => activeNoteType() === "presentation" },
  { id: "deploy-vercel", label: "Deploy to Vercel", category: "sync",
    action: () => deployActiveNote("vercel"), when: () => activeNoteType() === "website" },

  // Transform
  { id: "to-presentation", label: "Transform to Presentation", category: "transform",
    action: () => transformActiveNote("presentation"), when: () => activeNoteType() === "document" },
  { id: "to-document", label: "Transform to Document", category: "transform",
    action: () => transformActiveNote("document"), when: () => activeNoteType() === "presentation" },
  { id: "export-pdf", label: "Export as PDF", category: "transform", action: () => exportActiveNote("pdf") },
  { id: "export-docx", label: "Export as DOCX", category: "transform", action: () => exportActiveNote("docx") },
];
```

### 17.2 Command Bar Behavior

1. `⌘K` opens the command bar
2. Typing filters commands AND searches the vault simultaneously
3. If no command matches, the query is treated as a vault search
4. If the query looks like natural language ("draft an email to Patricia about..."), it falls through to the agent
5. `Enter` executes the top result
6. `Escape` closes

---

## 18. Keyboard Shortcuts

```typescript
const SHORTCUTS: Record<string, () => void> = {
  "mod+k":       openCommandBar,
  "mod+j":       openInlinePrompt,
  "mod+s":       saveActiveNote,
  "mod+n":       newDocument,
  "mod+shift+n": openNewContentMenu,
  "mod+w":       closeActiveTab,
  "mod+tab":     nextTab,
  "mod+shift+tab": prevTab,
  "mod+1":       goToTab(0),
  "mod+2":       goToTab(1),
  "mod+3":       goToTab(2),
  "mod+b":       toggleSidebar,
  "mod+shift+b": toggleContextPanel,
  "mod+/":       toggleAgentPanel,
  "mod+f":       searchInDocument,
  "mod+shift+f": searchInVault,
  "escape":      closeOverlays,
};
```

---

## 19. File Export Pipeline

### 19.1 Export Targets

| Format | Method | Library |
|--------|--------|---------|
| DOCX | Rust → Node subprocess | `docx` npm package |
| PDF | Rust → `wkhtmltopdf` or `weasyprint` | System binary |
| PPTX | Rust → Node subprocess | `pptxgenjs` npm package |
| HTML | Rust string template | Built-in |
| Markdown | Direct from Parachute content | No processing |

### 19.2 Export Flow

```
1. User: ⌘K → "export as PDF"
2. Frontend: invoke("export_note", { note_id, format: "pdf" })
3. Rust backend:
   a. Load note from Parachute
   b. Convert markdown to HTML (pulldown-cmark)
   c. Apply export template (CSS for print)
   d. Render HTML to PDF via wkhtmltopdf
   e. Save to temp file
   f. Open native save dialog (Tauri dialog API)
   g. Copy to user-selected location
4. Frontend: show success toast
```

---

## 20. Error Handling & Offline Behavior

### 20.1 Unified Error Type (Rust)

```rust
#[derive(Debug, thiserror::Error, Serialize)]
pub enum PrismError {
    #[error("Parachute error: {0}")]
    Parachute(String),

    #[error("Matrix error: {0}")]
    Matrix(String),

    #[error("Google API error: {0}")]
    Google(String),

    #[error("Notion error: {0}")]
    Notion(String),

    #[error("Agent error: {0}")]
    Agent(String),

    #[error("Auth error: {0}")]
    Auth(String),

    #[error("Sync conflict")]
    SyncConflict { local: String, remote: String },

    #[error("Service unavailable: {0}")]
    ServiceUnavailable(String),

    #[error("IO error: {0}")]
    Io(String),
}
```

### 20.2 Offline Behavior

| Service | When Down | User Experience |
|---------|-----------|-----------------|
| Parachute | App non-functional (core dependency) | Show error screen: "Parachute vault not running. Start it at ~/.parachute/start.sh" |
| Matrix | Messages unavailable | Sidebar shows "Messaging offline" badge. All other features work. |
| Gmail | Email unavailable | Email section shows "Gmail offline". Other features work. |
| Google Calendar | Calendar unavailable | Calendar shows cached data with "Last updated: X" label. |
| Notion | Notion sync fails | Sync indicator shows error. Local editing continues. Retry on reconnect. |
| Claude API | Agent features unavailable | ⌘J and agent panel show "Agent offline". All editing continues. |

---

## 21. Build & Development

### 21.1 Prerequisites

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node
brew install node@20

# Tauri CLI
cargo install tauri-cli

# System deps
brew install wkhtmltopdf   # PDF export
```

### 21.2 Project Init

```bash
# Create Tauri + React project
cargo create-tauri-app prism --template react-ts

# Frontend deps
cd prism
npm install @tauri-apps/api @tanstack/react-query zustand
npm install @tiptap/react @tiptap/starter-kit @tiptap/extension-*
npm install @monaco-editor/react
npm install @dnd-kit/core @dnd-kit/sortable
npm install @tanstack/react-table
npm install lucide-react
npm install tailwindcss @tailwindcss/typography
npm install matrix-js-sdk
npm install zod
```

### 21.3 Development Workflow

```bash
# Terminal 1: Start Parachute
~/.parachute/start.sh

# Terminal 2: Start Matrix (if messaging needed)
cd ~/iCloud\ Drive\ \(Archive\)/Documents/cursor\ projects/omniharmonic_agent/matrix
docker compose up -d

# Terminal 3: Start Prism in dev mode
cd prism
cargo tauri dev
```

### 21.4 Build for Distribution

```bash
cargo tauri build
# Produces: src-tauri/target/release/bundle/macos/Prism.app
```

---

## 22. Configuration & Environment

### 22.1 App Configuration File

Stored at `~/Library/Application Support/com.prism.app/config.json`:

```json
{
  "parachute": {
    "port": 1940,
    "vault": "default"
  },
  "matrix": {
    "homeserver": "http://localhost:8008",
    "user_id": "@benjamin:localhost"
  },
  "google": {
    "client_id": "...",
    "client_secret": "...",
    "accounts": ["benjamin@opencivics.co", "omniharmonicagent@gmail.com"]
  },
  "notion": {
    "integration_token_keychain_key": "com.prism.notion"
  },
  "anthropic": {
    "model": "claude-sonnet-4-20250514",
    "api_key_keychain_key": "com.prism.anthropic"
  },
  "tasks": {
    "file_path": "/Users/benjaminlife/iCloud Drive (Archive)/Documents/cursor projects/omniharmonic_agent/state/active-tasks.json"
  },
  "ui": {
    "theme": "dark",
    "sidebar_width": 240,
    "context_panel_width": 320,
    "auto_save_debounce_ms": 2000,
    "gmail_poll_interval_ms": 60000,
    "calendar_poll_interval_ms": 300000
  }
}
```

### 22.2 Required Secrets (Keychain)

| Keychain Service | Keychain Account | Value |
|------------------|------------------|-------|
| `com.prism.google` | `benjamin@opencivics.co` | Google OAuth access token |
| `com.prism.google.refresh` | `benjamin@opencivics.co` | Google OAuth refresh token |
| `com.prism.google` | `omniharmonicagent@gmail.com` | Google OAuth access token |
| `com.prism.google.refresh` | `omniharmonicagent@gmail.com` | Google OAuth refresh token |
| `com.prism.notion` | `default` | Notion integration token |
| `com.prism.anthropic` | `default` | Anthropic API key |
| `com.prism.matrix` | `default` | Matrix access token |

---

## 23. Performance Considerations

### 23.1 Vault Size

The vault may contain hundreds or thousands of notes. Mitigations:

- **Virtualized lists.** The project tree and inbox use virtualization (react-window or similar) for lists > 100 items.
- **Lazy loading.** Note content is loaded on demand (NoteIndex for lists, full Note on open).
- **Search debounce.** Search queries debounced at 200ms.
- **Stale-while-revalidate.** TanStack Query serves cached data immediately while refetching in the background.

### 23.2 Matrix Performance

With 7 bridges active, the Matrix /sync response can be large. Mitigations:

- **Filtered sync.** Use Matrix filter to limit sync to needed event types.
- **Room list caching.** Cache room list in memory, update incrementally from /sync.
- **Message pagination.** Load 50 messages per room, paginate backward on scroll.

### 23.3 Editor Performance

TipTap/ProseMirror handles documents up to ~50,000 words well. For very large documents:

- **Lazy rendering.** Only render visible blocks (TipTap supports this).
- **Auto-save debounce.** 2 seconds prevents write storms.

---

## 24. Future Extension Points

### 24.1 Plugin System (Phase 3)

Custom renderers and sync adapters can be added without modifying core:

```typescript
// Future: plugin interface
interface PrismPlugin {
  id: string;
  name: string;
  renderers?: Record<string, React.ComponentType<RendererProps>>;
  syncAdapters?: Record<string, SyncAdapterConfig>;
  commands?: Command[];
  navigationSections?: NavigationSection[];
}
```

### 24.2 Real-Time Collaboration (Phase 3)

If Parachute adds WebSocket subscriptions:
- TipTap has built-in Yjs support for collaborative editing
- Parachute would need to act as a Yjs persistence layer
- Prism would connect via WebSocket for real-time sync between multiple users

### 24.3 Mobile Companion (Phase 3)

- Read-only vault browser + quick capture
- Push notifications for messages and calendar
- Built with React Native or Swift (native iOS)
- Syncs through Parachute's HTTP API (exposed via Cloudflare Tunnel or similar)

---

*This document is the implementation specification for Prism. An agentic coding agent should be able to scaffold the full project from this document, the companion PRD, and the Parachute HTTP API reference.*
