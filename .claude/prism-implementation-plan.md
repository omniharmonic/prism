# Prism — Implementation Plan

**The step-by-step blueprint for building the universal interface.**
**Version:** 1.0 | **Date:** April 10, 2026
**Companion docs:** `prism-prd-v3.md` (PRD), `prism-technical-architecture.md` (Architecture)
**Notation:** Tasks reference architecture doc sections as `[ARCH §X.Y]` and PRD sections as `[PRD §X.Y]`

---

## How to Use This Document

This plan is designed so an agentic coding agent (Claude Code, Cursor, etc.) can execute tasks sequentially within each phase. Each task includes:

- **What to build** — specific files, functions, types
- **Dependencies** — which prior tasks must be complete
- **Inputs** — what data/APIs/files this task reads from
- **Outputs** — what files/components this task produces
- **Acceptance criteria** — how to verify the task is done
- **Cross-references** — links to architecture and PRD sections

Tasks within a phase can often be parallelized. Tasks across phases cannot — each phase depends on the prior phase being complete.

---

## Phase 0: Project Scaffolding

**Goal:** Empty Tauri + React app that compiles, opens a window, and shows "Prism" on screen.

### Task 0.1: Initialize Tauri Project

**Depends on:** Nothing
**Outputs:** `prism/` project directory with Tauri + React + TypeScript scaffold

```bash
# Run from ~/iCloud Drive (Archive)/Documents/cursor projects/
cargo create-tauri-app prism --template react-ts --manager npm
cd prism
```

**Acceptance:** `cargo tauri dev` opens a native window with React boilerplate.

### Task 0.2: Install Frontend Dependencies

**Depends on:** 0.1
**Outputs:** Updated `package.json` with all required packages

```bash
# Core
npm install @tauri-apps/api @tauri-apps/plugin-shell @tauri-apps/plugin-dialog
npm install react@19 react-dom@19

# State
npm install zustand @tanstack/react-query

# Editor
npm install @tiptap/react @tiptap/starter-kit @tiptap/pm
npm install @tiptap/extension-placeholder @tiptap/extension-image
npm install @tiptap/extension-table @tiptap/extension-table-row @tiptap/extension-table-cell @tiptap/extension-table-header
npm install @tiptap/extension-task-list @tiptap/extension-task-item
npm install @tiptap/extension-highlight @tiptap/extension-link
npm install @tiptap/extension-code-block-lowlight @tiptap/extension-typography
npm install lowlight

# Monaco (code editor)
npm install @monaco-editor/react

# Data grid
npm install @tanstack/react-table

# Drag and drop
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities

# Styling
npm install tailwindcss @tailwindcss/typography postcss autoprefixer
npm install lucide-react
npm install clsx tailwind-merge

# Matrix
npm install matrix-js-sdk

# Validation
npm install zod

# Utilities
npm install date-fns use-debounce
```

**Acceptance:** `npm install` completes without errors. `npm run build` compiles.

### Task 0.3: Configure Tailwind CSS

**Depends on:** 0.2
**Outputs:** `tailwind.config.ts`, `postcss.config.js`, `src/styles/tokens.css`

Create `tailwind.config.ts`:
```typescript
import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}', './index.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'monospace'],
        serif: ['Newsreader', 'Georgia', 'serif'],
      },
      colors: {
        accent: {
          DEFAULT: '#7C9FE8',
          hover: '#93B0ED',
          dim: 'rgba(124, 159, 232, 0.15)',
        },
      },
      backdropBlur: {
        glass: '24px',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
} satisfies Config;
```

Create `src/styles/tokens.css` with the full design token set from `[ARCH §16.1]`.

Create `src/styles/glass.css`:
```css
.glass {
  background: rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
}
.glass-hover:hover {
  background: rgba(255, 255, 255, 0.10);
}
.glass-active:active {
  background: rgba(255, 255, 255, 0.14);
}
```

**Acceptance:** Tailwind utility classes work in React components. Custom tokens accessible.

### Task 0.4: Configure Rust Backend Dependencies

**Depends on:** 0.1
**Outputs:** Updated `src-tauri/Cargo.toml`

Add to `[dependencies]`:
```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
reqwest = { version = "0.12", features = ["json", "multipart"] }
tokio = { version = "1", features = ["full"] }
thiserror = "2"
anyhow = "1"
uuid = { version = "1", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
dirs = "5"
base64 = "0.22"
pulldown-cmark = "0.12"
security-framework = "3"     # macOS Keychain
url = "2"
async-trait = "0.1"
log = "0.4"
env_logger = "0.11"
```

**Acceptance:** `cargo build` completes in `src-tauri/`.

### Task 0.5: Create Directory Structure

**Depends on:** 0.1
**Outputs:** Empty directory tree matching `[ARCH §4.4]` and `[ARCH §3.1]`

Create all directories:

```
# Frontend
mkdir -p src/app/stores src/app/hooks
mkdir -p src/components/{layout,navigation,renderers,agent,comms,tasks,calendar,dashboard,ui}
mkdir -p src/lib/{parachute,matrix,sync,schemas,agent}
mkdir -p src/styles/themes

# Backend
mkdir -p src-tauri/src/{commands,clients,sync/adapters,sync/transform,auth,services,models}
```

Create empty `mod.rs` files in each Rust subdirectory.

**Acceptance:** Directory tree matches architecture doc. All Rust modules compile (empty).

### Task 0.6: Create Rust Module Structure

**Depends on:** 0.4, 0.5
**Outputs:** `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/error.rs`, all `mod.rs` files

Create `src-tauri/src/error.rs`:
```rust
use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum PrismError {
    #[error("Parachute: {0}")]
    Parachute(String),
    #[error("Matrix: {0}")]
    Matrix(String),
    #[error("Google: {0}")]
    Google(String),
    #[error("Notion: {0}")]
    Notion(String),
    #[error("Agent: {0}")]
    Agent(String),
    #[error("Auth: {0}")]
    Auth(String),
    #[error("Sync conflict")]
    SyncConflict { local: String, remote: String },
    #[error("Service unavailable: {0}")]
    ServiceUnavailable(String),
    #[error("IO: {0}")]
    Io(String),
    #[error("{0}")]
    Other(String),
}

impl From<reqwest::Error> for PrismError {
    fn from(e: reqwest::Error) -> Self {
        PrismError::Other(e.to_string())
    }
}

impl From<std::io::Error> for PrismError {
    fn from(e: std::io::Error) -> Self {
        PrismError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for PrismError {
    fn from(e: serde_json::Error) -> Self {
        PrismError::Other(e.to_string())
    }
}
```

Create `src-tauri/src/main.rs` with Tauri app builder registering all command modules (initially empty handlers). See `[ARCH §3.2]` for the full command list.

Create `src-tauri/src/lib.rs` re-exporting all modules.

**Acceptance:** `cargo build` succeeds. App opens. No runtime errors.

---

## Phase 1: Parachute Client + Vault Browser

**Goal:** Connect to Parachute, list all notes in a sidebar, open a note and display its raw content.

### Task 1.1: Rust Parachute Client

**Depends on:** 0.6
**Inputs:** Parachute HTTP API at `localhost:1940` (see `[ARCH §5.1]`)
**Outputs:** `src-tauri/src/clients/parachute.rs`

Implement `ParachuteClient` struct with all methods from `[ARCH §5.1]`:
- `new(port: u16, api_key: Option<String>)` — constructor
- `list_notes(&self, params: &ListNotesParams) -> Result<Vec<NoteIndex>>`
- `get_note(&self, id: &str) -> Result<Note>`
- `create_note(&self, params: &CreateNoteParams) -> Result<Note>`
- `update_note(&self, id: &str, params: &UpdateNoteParams) -> Result<Note>`
- `delete_note(&self, id: &str) -> Result<()>`
- `search(&self, query: &str, tags: &[String], limit: u32) -> Result<Vec<Note>>`
- `get_tags(&self) -> Result<Vec<TagCount>>`
- `add_tags(&self, id: &str, tags: &[String]) -> Result<()>`
- `remove_tags(&self, id: &str, tags: &[String]) -> Result<()>`
- `get_links(&self, params: &GetLinksParams) -> Result<Vec<Link>>`
- `create_link(&self, params: &CreateLinkParams) -> Result<Link>`
- `delete_link(&self, params: &DeleteLinkParams) -> Result<()>`
- `get_graph(&self, params: &GetGraphParams) -> Result<Graph>`
- `get_vault_info(&self, name: &str) -> Result<VaultInfo>`
- `health(&self) -> Result<HealthResponse>`

**Key variables:**
- `base_url: String` — `"http://localhost:1940/api"`
- `client: reqwest::Client` — reusable HTTP client
- `api_key: Option<String>` — from `~/.parachute/config.yaml`, but localhost bypasses auth

**Acceptance:** Unit test calling `health()` returns `{status: "ok"}`. Unit test calling `list_notes()` returns notes from the vault.

### Task 1.2: Rust Data Models

**Depends on:** 0.6
**Outputs:** `src-tauri/src/models/note.rs`, `src-tauri/src/models/link.rs`, `src-tauri/src/models/sync_config.rs`

Define Rust structs matching Parachute's JSON shapes. All structs derive `Serialize, Deserialize, Clone, Debug`.

```rust
// models/note.rs
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub content: String,
    pub path: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndex {
    pub id: String,
    pub path: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub tags: Option<Vec<String>>,
    pub metadata: Option<serde_json::Value>,
    pub byte_size: u64,
    pub preview: String,
}

// ... TagCount, ListNotesParams, CreateNoteParams, UpdateNoteParams
```

```rust
// models/link.rs
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub source_id: String,
    pub target_id: String,
    pub relationship: String,
    pub metadata: Option<serde_json::Value>,
    pub created_at: String,
}
```

```rust
// models/sync_config.rs
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncConfig {
    pub adapter: String,
    pub remote_id: String,
    pub last_synced: String,
    pub direction: String,
    pub conflict_strategy: String,
    pub auto_sync: bool,
}
```

**Acceptance:** All structs serialize/deserialize correctly against Parachute API JSON samples.

### Task 1.3: Vault Tauri Commands

**Depends on:** 1.1, 1.2
**Outputs:** `src-tauri/src/commands/vault.rs`

Implement all vault commands from `[ARCH §3.2.1]`. Each command:
1. Gets the `ParachuteClient` from Tauri app state
2. Calls the appropriate client method
3. Returns the result or a `PrismError`

Register the `ParachuteClient` as managed state in `main.rs`:
```rust
let parachute = ParachuteClient::new(1940, None);
app.manage(parachute);
```

Register all commands in the Tauri builder:
```rust
.invoke_handler(tauri::generate_handler![
    vault_list_notes,
    vault_get_note,
    vault_create_note,
    vault_update_note,
    vault_delete_note,
    vault_search,
    vault_get_tags,
    vault_add_tags,
    vault_remove_tags,
    vault_get_links,
    vault_create_link,
    vault_delete_link,
    vault_get_graph,
    vault_get_stats,
])
```

**Acceptance:** From the browser devtools console, `window.__TAURI__.invoke('vault_list_notes', {})` returns an array of NoteIndex objects.

### Task 1.4: Frontend TypeScript Types

**Depends on:** 0.2
**Outputs:** `src/lib/types.ts`, `src/lib/schemas/content-types.ts`

Define all TypeScript interfaces from `[ARCH §6.1]`:
- `ContentType` union type
- `PrismMetadata` interface
- `Note`, `NoteIndex`, `Link`, `TagCount`, `VaultStats` interfaces
- `SyncConfig` interface
- `CONTENT_DEFAULTS` map
- `inferContentType(note: Note): ContentType` function from `[ARCH §6.2]`

Also define all type-specific metadata interfaces (DocumentMeta, EmailMeta, etc.) from `[PRD §9]`.

**Acceptance:** All types compile. `inferContentType` correctly identifies types from metadata and content heuristics.

### Task 1.5: Parachute API Hooks

**Depends on:** 1.3, 1.4, 0.2
**Outputs:** `src/lib/parachute/client.ts`, `src/lib/parachute/queries.ts`, `src/app/hooks/useParachute.ts`

Create `src/lib/parachute/client.ts` — the typed Tauri invoke wrapper from `[ARCH §4.4]`:
```typescript
export const vaultApi = {
  listNotes: (filters?: NoteFilters) =>
    invoke<NoteIndex[]>("vault_list_notes", filters || {}),
  getNote: (id: string) =>
    invoke<Note>("vault_get_note", { id }),
  createNote: (params: CreateNoteParams) =>
    invoke<Note>("vault_create_note", params),
  updateNote: (id: string, params: UpdateNoteParams) =>
    invoke<Note>("vault_update_note", { id, ...params }),
  deleteNote: (id: string) =>
    invoke<void>("vault_delete_note", { id }),
  search: (query: string, tags?: string[], limit?: number) =>
    invoke<Note[]>("vault_search", { query, tags, limit }),
  getTags: () =>
    invoke<TagCount[]>("vault_get_tags"),
};
```

Create `src/lib/parachute/queries.ts` — TanStack Query key factory from `[ARCH §4.3]`.

Create `src/app/hooks/useParachute.ts` — custom hooks wrapping TanStack Query:
```typescript
export function useNotes(filters?: NoteFilters) {
  return useQuery({
    queryKey: queryKeys.vault.notes(filters),
    queryFn: () => vaultApi.listNotes(filters),
  });
}

export function useNote(id: string | null) {
  return useQuery({
    queryKey: queryKeys.vault.note(id!),
    queryFn: () => vaultApi.getNote(id!),
    enabled: !!id,
  });
}

export function useVaultSearch(query: string) {
  return useQuery({
    queryKey: queryKeys.vault.search(query),
    queryFn: () => vaultApi.search(query),
    enabled: query.length > 0,
  });
}

export function useTags() {
  return useQuery({
    queryKey: queryKeys.vault.tags(),
    queryFn: vaultApi.getTags,
  });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: vaultApi.createNote,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.vault.all }),
  });
}

export function useUpdateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...params }: { id: string } & UpdateNoteParams) =>
      vaultApi.updateNote(id, params),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.vault.note(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.vault.notes() });
    },
  });
}
```

**Acceptance:** `useNotes()` returns data from Parachute in a React component. Loading and error states work.

### Task 1.6: UI Foundation Components

**Depends on:** 0.3
**Outputs:** `src/components/ui/Glass.tsx`, `Button.tsx`, `Input.tsx`, `Badge.tsx`, `Tabs.tsx`, `Spinner.tsx`, `Skeleton.tsx`, `Toast.tsx`, `Tooltip.tsx`, `ContextMenu.tsx`

Build each component using Tailwind + the glass design tokens. Each component:
- Uses `clsx`/`tailwind-merge` for conditional class composition
- Accepts `className` prop for override
- Uses `React.forwardRef` where DOM access is needed
- Has glass-morphism styling as default

Key component specs:

**Glass:** See `[ARCH §16.2]`. Background, blur, border. Props: `children`, `className`, `interactive` (adds hover/active), `elevated` (stronger blur).

**Button:** Variants: `primary` (accent bg), `secondary` (glass bg), `ghost` (transparent). Sizes: `sm`, `md`, `lg`. Supports `loading` state with spinner. Supports `icon` (Lucide component) + `label`.

**Badge:** Small label. Props: `variant` (`default`, `success`, `warning`, `error`, `info`, `platform`), `children`. Platform variant accepts `platform` prop for color from `[ARCH §9.2] PLATFORM_CONFIG`.

**Tabs:** Controlled tabs. Props: `tabs: { id, label, icon? }[]`, `activeTab`, `onChange`. Glass-style tab bar with accent underline on active.

**Skeleton:** Loading placeholder. Animated shimmer on glass background. Props: `width`, `height`, `rounded`.

**Toast:** Notification popup. Bottom-right positioned. Auto-dismiss after 3s. Variants: `success`, `error`, `info`. Uses Zustand store for queue management.

**Acceptance:** Each component renders correctly in isolation. Glass blur visible against dark background. All interactive states (hover, active, focus) work.

### Task 1.7: Shell Layout

**Depends on:** 1.6
**Outputs:** `src/components/layout/Shell.tsx`, `src/app/stores/ui.ts`, `src/app/App.tsx`

Create `src/app/stores/ui.ts` — the Zustand UI store from `[ARCH §15.1]`:
```typescript
interface UIStore {
  sidebarOpen: boolean;
  sidebarWidth: number;
  contextPanelOpen: boolean;
  contextPanelWidth: number;
  contextPanelTab: "agent" | "metadata" | "links" | "history";
  openTabs: TabState[];
  activeTabId: string | null;
  commandBarOpen: boolean;
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
```

Create `src/components/layout/Shell.tsx`:
- Three-panel layout: Navigation | Canvas | ContextPanel
- Resize handles between panels (drag to resize, double-click to collapse)
- Navigation width bounded by `[ARCH §16.1]` `--sidebar-min-width` / `--sidebar-max-width`
- Context panel collapsible
- Status bar at bottom
- Renders `<Navigation />`, `<Canvas />`, `<ContextPanel />`, `<StatusBar />`

Update `src/app/App.tsx` to wrap `<Shell />` in `<QueryClientProvider>`.

**Acceptance:** Three-panel layout visible. Panels resize by dragging dividers. Sidebar collapses with `⌘B`. Context panel collapses with `⌘\`. Background is `--bg-base` dark color.

### Task 1.8: Project Tree Navigation

**Depends on:** 1.5, 1.7
**Outputs:** `src/components/navigation/Navigation.tsx`, `src/components/navigation/ProjectTree.tsx`, `src/components/navigation/SearchPanel.tsx`

Create `src/components/navigation/Navigation.tsx`:
- Search box at top (simple text input, debounced 200ms)
- Sections: Inbox (placeholder), Calendar (placeholder), Projects, Recent
- `+ New` button at bottom

Create `src/components/navigation/ProjectTree.tsx`:
- Reads from `useNotes()` hook
- Groups notes by `path` field using `buildProjectTree()` function from `[ARCH §5.3]`
- Top-level paths become expandable project folders
- Notes render as leaf nodes with content type icon
- Icon mapping: document → `FileText`, code → `Code`, presentation → `Presentation`, email → `Mail`, task → `CheckSquare`, etc. (Lucide icons)
- Click a note → calls `uiStore.openTab(note.id, title, type)`
- Right-click → context menu (placeholder: rename, delete, sync)

Create `src/components/navigation/SearchPanel.tsx`:
- Renders below search box when query is non-empty
- Uses `useVaultSearch(query)` hook
- Shows results as a flat list with note title, path, and preview
- Click result → opens in tab

**Acceptance:** Sidebar shows all vault notes organized by path. Search returns results. Clicking a note updates the active tab ID in the UI store.

### Task 1.9: Tab Bar + Raw Content Display

**Depends on:** 1.5, 1.7
**Outputs:** `src/components/layout/Canvas.tsx`, `src/components/layout/TabBar.tsx`

Create `src/components/layout/TabBar.tsx`:
- Reads `openTabs` and `activeTabId` from UI store
- Renders horizontal tab strip with note titles
- Active tab has accent underline
- Close button (×) on each tab
- Click tab → `setActiveTab(tabId)`
- Tab overflow: horizontal scroll

Create `src/components/layout/Canvas.tsx`:
- Reads `activeTabId` from UI store
- If no active tab → show empty state ("Open a document from the sidebar")
- If active tab → load note via `useNote(noteId)` and display raw content in a `<pre>` block (temporary — renderers come in Phase 2)
- Shows loading skeleton while fetching

**Acceptance:** Click a note in sidebar → tab appears in tab bar → raw markdown content displays in canvas. Multiple tabs can be open. Switching tabs shows correct content.

### Task 1.10: Status Bar

**Depends on:** 1.7
**Outputs:** `src/components/layout/StatusBar.tsx`

Create minimal status bar:
- Left: vault name + note count (from `useNotes()`)
- Center: active document word count (count words in content)
- Right: "Parachute: Connected" / "Disconnected" indicator

**Acceptance:** Status bar renders at bottom. Shows note count. Shows connection status.

---

## Phase 2: Document Editor

**Goal:** Edit documents with a rich TipTap editor that auto-saves to Parachute.

### Task 2.1: Renderer Registry

**Depends on:** 1.4
**Outputs:** `src/components/renderers/Registry.ts`

Create the registry from `[ARCH §7.1]`. Initially, only `DocumentRenderer` is real — all others map to a `PlaceholderRenderer` that shows "Renderer not yet implemented for type: {type}".

```typescript
export function getRenderer(type: ContentType): React.LazyExoticComponent<any> {
  return RENDERER_MAP[type] || PlaceholderRenderer;
}
```

**Acceptance:** Registry returns correct component for each type. Unknown types get placeholder.

### Task 2.2: Renderer Container

**Depends on:** 2.1, 1.9
**Outputs:** Updated `src/components/layout/Canvas.tsx`

Replace the raw `<pre>` display with the `<RendererContainer>` from `[ARCH §7.2]`:
- Determine content type via `inferContentType(note)`
- Look up renderer via `getRenderer(type)`
- Wrap in `<Suspense>` with `<Skeleton>` fallback
- Pass `note`, `onSave`, `onMetadataChange` props

**Acceptance:** Opening a document note loads DocumentRenderer. Opening a code note loads PlaceholderRenderer with appropriate message.

### Task 2.3: Auto-Save Hook

**Depends on:** 1.5
**Outputs:** `src/app/hooks/useAutoSave.ts`

Implement `useAutoSave` from `[ARCH §7.4]`:
```typescript
export function useAutoSave(noteId: string, getContent: () => string, debounceMs = 2000) {
  // Uses useUpdateNote mutation
  // Debounces content changes
  // Returns { isSaving, lastSaved, saveNow }
  // saveNow() flushes immediately (for ⌘S)
}
```

**Acceptance:** Editing content in the editor triggers a PATCH to Parachute after 2s of inactivity. `isSaving` is true during save. `lastSaved` updates on success.

### Task 2.4: TipTap Document Renderer

**Depends on:** 2.2, 2.3
**Outputs:** `src/components/renderers/DocumentRenderer.tsx`

Implement the full document editor:

**TipTap extensions to include** (from `[ARCH §7.5]`):
```typescript
const extensions = [
  StarterKit.configure({
    codeBlock: false, // replaced by CodeBlockLowlight
  }),
  Placeholder.configure({
    placeholder: "Start writing, or press / for commands...",
  }),
  Image,
  Table.configure({ resizable: true }),
  TableRow,
  TableCell,
  TableHeader,
  TaskList,
  TaskItem.configure({ nested: true }),
  Highlight.configure({ multicolor: true }),
  Link.configure({ openOnClick: false, autolink: true }),
  CodeBlockLowlight.configure({ lowlight }),
  Typography,
];
```

**Component structure:**
```tsx
function DocumentRenderer({ note, onSave, onMetadataChange }: RendererProps) {
  const editor = useEditor({
    extensions,
    content: note.content,  // Parse markdown to ProseMirror doc
    onUpdate: ({ editor }) => {
      const markdown = editor.storage.markdown?.getMarkdown() || editor.getHTML();
      onSave(markdown);
    },
  });

  useAutoSave(note.id, () => editor?.getHTML() || "", 2000);

  // ... render editor with toolbar
}
```

**Toolbar** (floating or fixed, above editor):
- Bold, Italic, Strikethrough, Code
- Heading 1, 2, 3 dropdown
- Bullet list, Ordered list, Task list
- Blockquote, Code block, Divider
- Link, Image
- Table insert

**Styling:** Editor content area uses `--font-serif` for body text at `--text-lg` (16px). Headings use `--font-sans`. Code blocks use `--font-mono`. Glass background on the editor surface. Max content width: 720px centered in canvas.

**Markdown round-trip:** TipTap stores content as ProseMirror JSON internally. On save, convert to markdown (or store as HTML for now — markdown conversion can be improved later). On load, parse markdown content into the editor.

Note: TipTap doesn't natively parse markdown. Options:
1. Use `@tiptap/extension-markdown` (if available)
2. Convert markdown → HTML via `pulldown-cmark` on the Rust side before sending to frontend
3. Store content as HTML in Parachute (simplest for MVP, convert later)

**Recommended for MVP:** Add a Tauri command `markdown_to_html(markdown: String) -> String` using `pulldown_cmark` in Rust. Call it when loading a note. Store editor output as HTML. Convert back to markdown on save via a `html_to_markdown` command using a Rust HTML-to-markdown library.

**Acceptance:** Open a markdown document from the vault → renders with rich formatting. Edit text → auto-saves after 2s. Reload note → edits persist. Toolbar buttons apply formatting. Headings, lists, code blocks, links, images all render correctly.

### Task 2.5: Markdown Conversion Commands

**Depends on:** 0.6
**Outputs:** `src-tauri/src/commands/convert.rs`

Add two Tauri commands for markdown ↔ HTML conversion:

```rust
#[tauri::command]
fn markdown_to_html(markdown: String) -> Result<String, PrismError> {
    let parser = pulldown_cmark::Parser::new_ext(&markdown, pulldown_cmark::Options::all());
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    Ok(html)
}

#[tauri::command]
fn html_to_markdown(html: String) -> Result<String, PrismError> {
    // Use a library like `html2md` or `htmd`
    // Add: htmd = "0.1" to Cargo.toml
    Ok(htmd::convert(&html).unwrap_or_default())
}
```

Add `htmd = "0.1"` to Cargo.toml dependencies.

**Acceptance:** `markdown_to_html("# Hello\n\nWorld")` returns `<h1>Hello</h1>\n<p>World</p>`. Round-trip preserves content structure.

### Task 2.6: New Content Creation Flow

**Depends on:** 1.5, 1.8, 1.4
**Outputs:** `src/components/navigation/NewContentMenu.tsx`

Create the "+ New" button and type selector dropdown:

```typescript
const CONTENT_TYPE_OPTIONS = [
  { type: "document",     label: "Document",     icon: FileText,     shortcut: "⌘N" },
  { type: "presentation", label: "Presentation", icon: Presentation },
  { type: "code",         label: "Code File",    icon: Code },
  { type: "email",        label: "Email",        icon: Mail },
  { type: "spreadsheet",  label: "Spreadsheet",  icon: Table2 },
  { type: "website",      label: "Website",      icon: Globe },
  { type: "task",         label: "Task",         icon: CheckSquare },
];
```

On selection:
1. Call `useCreateNote().mutate()` with defaults from `CONTENT_DEFAULTS[type]`
2. If in a project context (project selected in sidebar), set `path` to `Projects/{projectName}/{untitled}`
3. Open the new note in a tab
4. Focus the editor

**Acceptance:** Click "+ New" → dropdown appears → select "Document" → new note created in Parachute → opens in editor → cursor focused.

### Task 2.7: Context Panel — Metadata

**Depends on:** 1.7, 1.5
**Outputs:** `src/components/layout/ContextPanel.tsx`, `src/components/layout/MetadataPanel.tsx`

Create `ContextPanel.tsx`:
- Tabbed panel: Agent (placeholder) | Metadata | Links (placeholder) | History (placeholder)
- Default to Metadata tab

Create `MetadataPanel.tsx`:
- Shows for the active note:
  - **Type:** dropdown selector (change triggers metadata update)
  - **Path:** editable text field
  - **Tags:** tag editor (add/remove tags, autocomplete from existing tags via `useTags()`)
  - **Created:** formatted timestamp
  - **Updated:** formatted timestamp
  - **Sync:** list of sync configs (empty for now, placeholder "Add sync destination" button)
  - **Word count, reading time:** computed from content

**Acceptance:** Context panel shows metadata for active note. Changing type updates metadata via `vault_update_note`. Adding/removing tags works.

---

## Phase 3: Communications

**Goal:** Read and write messages across all platforms. Read and send email.

### Task 3.1: Matrix Client (Rust)

**Depends on:** 0.4
**Inputs:** Matrix Synapse at `localhost:8008`
**Outputs:** `src-tauri/src/clients/matrix.rs`

Implement `MatrixClient` from `[ARCH §9.1]`:
- `new(homeserver: &str, access_token: &str, user_id: &str)` — constructor
- `sync(&self, since: Option<&str>, timeout: Option<u64>) -> Result<SyncResponse>`
- `get_joined_rooms(&self) -> Result<Vec<String>>`
- `get_room_state(&self, room_id: &str) -> Result<RoomState>`
- `get_messages(&self, room_id: &str, limit: u32, from: Option<&str>, dir: &str) -> Result<MessagesResponse>`
- `send_message(&self, room_id: &str, body: &str, msg_type: &str) -> Result<SendResponse>`
- `mark_read(&self, room_id: &str, event_id: &str) -> Result<()>`
- `search(&self, query: &str) -> Result<SearchResults>`

**Configuration:** Matrix access token must be obtained manually first (register/login via Matrix API or Element). Store in Keychain as `com.prism.matrix` / `default`.

**Acceptance:** Unit test calls `get_joined_rooms()` and returns room IDs. `get_messages(room_id, 10, None, "b")` returns messages.

### Task 3.2: Matrix Tauri Commands

**Depends on:** 3.1
**Outputs:** `src-tauri/src/commands/matrix.rs`

Implement all matrix commands from `[ARCH §3.2.2]`:
- `matrix_get_rooms` — calls `get_joined_rooms()`, then `get_room_state()` for each room to build `MatrixRoom` structs with name, avatar, member count, unread count, last message preview
- `matrix_get_messages` — paginated message fetch
- `matrix_send_message` — send text message to a room
- `matrix_get_room_members` — room member list
- `matrix_mark_read` — mark event as read
- `matrix_search_messages` — full-text search

Register `MatrixClient` as managed state in `main.rs`.

**Acceptance:** `invoke('matrix_get_rooms')` returns rooms with platform identification.

### Task 3.3: Matrix Room Models + Platform Detection

**Depends on:** 3.2
**Outputs:** `src-tauri/src/models/message.rs`, `src/lib/matrix/bridge-map.ts`

Rust model:
```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MatrixRoom {
    pub room_id: String,
    pub name: String,
    pub platform: String,        // "whatsapp" | "telegram" | etc.
    pub is_dm: bool,
    pub unread_count: u32,
    pub last_message: Option<LastMessage>,
    pub members: Vec<MatrixMember>,
}
```

Platform detection logic in Rust (check room member user IDs for bridge bot patterns — see `[ARCH §9.2]`).

Frontend platform config (`src/lib/matrix/bridge-map.ts`): label, color, icon for each platform. Used by `<PlatformBadge>`.

**Acceptance:** Rooms correctly identified as WhatsApp, Telegram, etc. based on bridge bot presence.

### Task 3.4: Matrix Poller Service

**Depends on:** 3.1
**Outputs:** `src-tauri/src/services/matrix_poller.rs`

Implement the background poller from `[ARCH §3.4]`:
- Spawned as a Tokio task on app startup
- Long-polls Matrix `/sync` with 30s timeout
- Maintains `since_token` for incremental sync
- Emits Tauri events: `matrix:new-message`, `matrix:room-update`
- On error, emits `system:service-down`, waits 5s, retries

**Acceptance:** New messages from any bridged platform trigger a Tauri event within seconds. Frontend can listen via `listen('matrix:new-message', handler)`.

### Task 3.5: Message Renderer

**Depends on:** 3.2, 3.3, 2.1
**Outputs:** `src/components/renderers/MessageRenderer.tsx`, `src/components/comms/MessageThread.tsx`, `src/components/comms/MessageComposer.tsx`, `src/components/comms/PlatformBadge.tsx`

Register `MessageRenderer` in the renderer registry for type `"message-thread"`.

**MessageRenderer:**
- Takes a note with `metadata.type === "message-thread"` and `metadata.matrix_room_id`
- Uses `useInfiniteQuery` with `matrixApi.getMessages(roomId, 50, pageParam)` for paginated loading
- Scrolls to bottom on load, loads older messages on scroll-up
- Shows `<PlatformBadge>` for the thread's platform

**MessageThread:**
- Renders messages in chat-bubble style
- Groups consecutive messages from the same sender
- Timestamps between groups (relative: "2 min ago", "Yesterday")
- Media messages: show image thumbnails, file download links
- Right-align outgoing messages, left-align incoming

**MessageComposer:**
- Text input at bottom of thread
- Send button (or Enter key)
- Calls `matrixApi.sendMessage(roomId, body)` on send
- Invalidates message query on success

**PlatformBadge:**
- Small colored badge with platform icon + label
- Props: `platform: Platform`
- Uses `PLATFORM_CONFIG` from `[ARCH §9.2]`

**Acceptance:** Open a message thread → see chat history from the bridged platform. Type a reply → message appears in the thread AND in the actual platform (e.g., WhatsApp, Telegram).

### Task 3.6: Unified Inbox

**Depends on:** 3.2, 3.5
**Outputs:** `src/components/navigation/Inbox.tsx`

Create the unified inbox section in the navigation sidebar:
- Queries `matrixApi.getRooms()` with `refetchInterval: 10000` (10s)
- Filters to rooms with `unread_count > 0`
- Sorts by last message timestamp (newest first)
- Each item shows: platform badge, contact name, message preview, unread count badge
- Click → opens a "virtual note" in the tab system

**Virtual notes for message threads:**
Message threads are NOT stored in Parachute (they live in Matrix). When the user clicks a thread in the inbox:
1. Create a temporary `TabState` with `noteId: "matrix:{room_id}"`, `type: "message-thread"`
2. The `RendererContainer` detects the `matrix:` prefix and passes `room_id` directly to `MessageRenderer` instead of fetching from Parachute

**Acceptance:** Inbox shows unread messages across all platforms. Badge counts update in real time (via Matrix poller events). Clicking opens the thread in the canvas.

### Task 3.7: Gmail Client (Rust)

**Depends on:** 0.4
**Outputs:** `src-tauri/src/clients/google.rs` (Gmail portion)

Implement Gmail API methods from `[ARCH §10.1]`:
- `list_threads(account, query, max_results, page_token) -> ThreadListResponse`
- `get_thread(account, thread_id) -> ThreadResponse`
- `send_email(account, raw) -> MessageResponse`
- `build_raw_email(from, to, cc, subject, body, in_reply_to) -> String`

Uses OAuth2 access tokens from Keychain. Token refresh logic in `auth/tokens.rs`.

**Acceptance:** `list_threads("benjamin@opencivics.co", Some("is:unread"), 10, None)` returns Gmail threads.

### Task 3.8: Gmail Tauri Commands

**Depends on:** 3.7
**Outputs:** `src-tauri/src/commands/google.rs` (Gmail commands)

Implement Gmail commands from `[ARCH §3.2.3]`:
- `gmail_list_threads`, `gmail_get_thread`, `gmail_send`, `gmail_archive`, `gmail_label`

**Acceptance:** Frontend can invoke Gmail commands and receive thread data.

### Task 3.9: Email Renderer

**Depends on:** 3.8, 2.1, 2.4
**Outputs:** `src/components/renderers/EmailRenderer.tsx`, `src/components/comms/EmailComposer.tsx`, `src/components/comms/EmailThread.tsx`, `src/components/comms/EmailInbox.tsx`

Register `EmailRenderer` in the registry for type `"email"`.

**EmailRenderer** switches between three modes based on `metadata.status`:
- `"received"` or thread view → `<EmailThread>` (read mode)
- `"draft"` → `<EmailComposer>` (compose mode)
- Inbox → `<EmailInbox>` (list mode)

**EmailComposer:**
- Fields: From (dropdown: two accounts), To, CC, BCC (with autocomplete from contacts — future), Subject
- Body: TipTap editor (same as DocumentRenderer but **output must be plain text, not HTML** — Gmail doesn't render markdown or HTML reliably for plain-text users)
- Send button: calls `gmailApi.send(params)`, moves note status to "sent"

**EmailThread:**
- Conversation-style thread view (messages stacked chronologically)
- Each message shows: sender, date, body
- "Reply" button opens inline composer at bottom

**EmailInbox:**
- Opened when user clicks "Email" section in navigation
- List of threads with sender, subject, snippet, date
- Triage badges: urgent (red), action (yellow), informational (gray)
- Two-column: thread list (left) + selected thread detail (right)

**Acceptance:** Can read email threads. Can compose and send email. Sent email appears in Gmail.

### Task 3.10: Add Email + Messages to Inbox

**Depends on:** 3.6, 3.9
**Outputs:** Updated `src/components/navigation/Inbox.tsx`

Extend the unified inbox to include Gmail unread alongside Matrix messages:
- Add `useGmailUnread()` hook for both accounts
- Merge Gmail threads and Matrix rooms into single sorted list
- Email items show `<Badge variant="platform" platform="email">Email</Badge>`
- Click email → opens EmailRenderer in thread mode

**Acceptance:** Inbox shows WhatsApp messages, Telegram messages, Discord messages, AND email threads — all in one list, sorted by recency.

### Task 3.11: Gmail Poller Service

**Depends on:** 3.7
**Outputs:** `src-tauri/src/services/gmail_poller.rs`

Background poller:
- Polls every 60s (configurable)
- Checks both accounts
- Uses Gmail History API for incremental sync (stores `historyId` per account)
- Emits `gmail:new-email` and `gmail:inbox-update` events

**Acceptance:** New emails trigger frontend notifications within 60 seconds.

---

## Phase 4: Sync Engine

**Goal:** Bidirectional sync between Parachute and Google Docs / Notion.

### Task 4.1: Sync Adapter Trait

**Depends on:** 0.6
**Outputs:** `src-tauri/src/sync/adapters/mod.rs`

Define the `SyncAdapter` trait from `[ARCH §8.2]`.

### Task 4.2: Google Docs Sync Adapter

**Depends on:** 4.1, 3.7 (Google client), 2.5 (markdown conversion)
**Outputs:** `src-tauri/src/sync/adapters/google_docs.rs`, `src-tauri/src/sync/transform/md_to_gdocs.rs`, `src-tauri/src/sync/transform/gdocs_to_md.rs`

**Push (local → Google Docs):**
1. Read note content from Parachute
2. Convert markdown → Google Docs API format (using `md_to_gdocs.rs`)
3. If first sync: create new Google Doc via Docs API, store doc ID in `metadata.sync[].remote_id`
4. If subsequent: clear doc content, re-insert (simpler than diff-based update for MVP)

**Pull (Google Docs → local):**
1. Read Google Doc content via Docs API
2. Convert Google Docs JSON → markdown (using `gdocs_to_md.rs`)
3. Update note content in Parachute

**Conflict detection:** Compare `note.updated_at` vs `doc.modifiedTime`. If both changed since `last_synced`, return `SyncResult::Conflict`.

**Acceptance:** Create a note in Prism → sync to Google Docs → Doc appears in Google Drive with correct content. Edit the Doc in Google → pull → content updates in Prism.

### Task 4.3: Notion Sync Adapter

**Depends on:** 4.1
**Outputs:** `src-tauri/src/sync/adapters/notion.rs`, `src-tauri/src/sync/transform/md_to_notion.rs`, `src-tauri/src/sync/transform/notion_to_md.rs`

Same pattern as Google Docs but converting between markdown and Notion block format.

**Notion client:** Uses `NOTION_API_KEY` from Keychain. Standard Notion REST API v1.

**Acceptance:** Sync a document to Notion → page appears with correct content. Edit in Notion → pull → updates in Prism.

### Task 4.4: Sync Engine Coordinator

**Depends on:** 4.1, 4.2, 4.3
**Outputs:** `src-tauri/src/sync/engine.rs`

Implement the coordinator from `[ARCH §8.3]`:
- `sync_note(note, config, adapter, parachute)` — the main sync function
- Handles all four cases: no change, local only, remote only, conflict
- Updates `metadata.sync[].last_synced` on success

### Task 4.5: Sync Tauri Commands

**Depends on:** 4.4
**Outputs:** `src-tauri/src/commands/sync.rs`

Implement commands from `[ARCH §3.2.7]`:
- `sync_trigger(note_id)` — syncs all configs for a note
- `sync_status(note_id)` — returns current sync status
- `sync_add_config(note_id, adapter, direction, auto_sync)` — adds a sync destination
- `sync_remove_config(note_id, adapter, remote_id)` — removes a sync destination
- `sync_resolve_conflict(note_id, adapter, resolution, merged_content)` — resolves a conflict

### Task 4.6: Sync UI

**Depends on:** 4.5, 2.7
**Outputs:** Updated `MetadataPanel.tsx`, `src/components/layout/SyncStatusIndicator.tsx`

Add to MetadataPanel:
- "Sync Destinations" section
- "Add Sync" button → dropdown: Google Docs, Notion
- Each sync config shows: adapter icon, remote ID (link), last synced time, auto-sync toggle
- "Sync Now" button per destination
- Status indicator: ✓ synced, ↻ syncing, ⚠ conflict, ✕ error

Add `SyncStatusIndicator` to TabBar tabs — small dot showing sync state.

**Acceptance:** Add Google Docs sync to a document → first sync creates Doc → subsequent syncs update. Conflict detected → UI shows conflict state. User resolves → sync completes.

### Task 4.7: Google Calendar Integration

**Depends on:** 3.7 (Google client)
**Outputs:** `src-tauri/src/commands/google.rs` (calendar commands), `src/components/renderers/CalendarRenderer.tsx`, `src/components/calendar/WeekView.tsx`, `src/components/calendar/DayView.tsx`, `src/components/navigation/CalendarMini.tsx`

Implement calendar commands from `[ARCH §3.2.3]`.

**CalendarMini** (sidebar):
- Shows today's events in a compact list
- Each event: time, title, attendee count
- Click → opens event detail (future)

**CalendarRenderer** (canvas):
- Week view as default
- Day/week toggle
- Events rendered as colored blocks on time grid
- Click event → detail panel in context panel
- "New Event" button → create event dialog

**Acceptance:** Calendar section in sidebar shows today's events. Full calendar view shows week. Creating an event creates it in Google Calendar.

---

## Phase 5: Additional Renderers

**Goal:** Presentation editor, kanban board, code editor, project dashboard.

### Task 5.1: Code Renderer

**Depends on:** 2.1
**Outputs:** `src/components/renderers/CodeRenderer.tsx`

Wrap `@monaco-editor/react`:
```tsx
function CodeRenderer({ note, onSave }: RendererProps) {
  const language = (note.metadata as any)?.language || detectLanguage(note.path);
  return (
    <MonacoEditor
      language={language}
      value={note.content}
      onChange={(value) => onSave(value || "")}
      theme="vs-dark"
      options={{
        fontSize: 14,
        fontFamily: "JetBrains Mono",
        minimap: { enabled: true },
        lineNumbers: "on",
        wordWrap: "on",
      }}
    />
  );
}
```

Register in renderer registry for type `"code"`.

**Acceptance:** Open a code file → syntax-highlighted editor. Edit → auto-saves.

### Task 5.2: Presentation Renderer

**Depends on:** 2.1, 2.4
**Outputs:** `src/components/renderers/PresentationRenderer.tsx`

Two views:
1. **Grid view:** All slides as thumbnails. Drag-and-drop reorder with `@dnd-kit`.
2. **Edit view:** Single slide in TipTap editor (same extensions as DocumentRenderer).

Parse content using `parseSlides()` from `[ARCH §7.6]` (split on `---`).

Serialize back using `serializeSlides()`.

Slide rendering: Each slide is a 16:9 aspect ratio card with the TipTap-rendered content. Background configurable (theme system — future).

**Acceptance:** Open a presentation → see slide grid. Click slide → edit in TipTap. Reorder slides → content updates. New slides added with "+".

### Task 5.3: Task Board Renderer (Kanban)

**Depends on:** 2.1
**Outputs:** `src/components/renderers/TaskBoardRenderer.tsx`, `src/components/tasks/KanbanBoard.tsx`, `src/components/tasks/KanbanCard.tsx`, `src/components/tasks/TaskDetail.tsx`, `src/components/tasks/TaskCreate.tsx`, `src-tauri/src/commands/tasks.rs`

**Rust task commands (Task 5.3a):**
Implement task commands from `[ARCH §3.2.6]`. These read/write `state/active-tasks.json` at the path configured in `AppConfig` (default: `~/iCloud Drive (Archive)/Documents/cursor projects/omniharmonic_agent/state/active-tasks.json`). **Must use file locking** — see `[ARCH §13.1]`.

**Frontend (Task 5.3b):**
`KanbanBoard`:
- 5 columns: Inbox, To Do, In Progress, Blocked, Done
- Cards draggable between columns via `@dnd-kit`
- On drop: calls `tasksApi.moveColumn(id, newColumn)`
- Filter by project (reads from current project context)

`KanbanCard`:
- Shows: description (truncated), priority badge, deadline (if present), project tag
- Click → opens `TaskDetail` dialog

`TaskCreate`:
- Dialog form: description, project, priority, deadline
- Creates via `tasksApi.create()`

Register `TaskBoardRenderer` for types `"task-board"` and `"task"`.

**Acceptance:** Open a project → see kanban board. Drag cards between columns → status updates in `active-tasks.json`. Create task → appears in Inbox column. Notion sync updates if task has `notionPageId`.

### Task 5.4: Project Renderer

**Depends on:** 5.3, 3.6, 4.7
**Outputs:** `src/components/renderers/ProjectRenderer.tsx`

Aggregates everything for a project:
- **Tasks section:** Kanban board filtered to this project (embed `<KanbanBoard project={name}>`)
- **Documents section:** List of notes under this project's path (from `useNotes({ path prefix })`)
- **Threads section:** Message threads tagged to this project (future — requires project-thread linking)
- **Events section:** Upcoming events related to this project (future)

**Acceptance:** Open a project node → see dashboard with kanban, document list. Can navigate to individual documents by clicking them.

---

## Phase 6: Agent Integration

**Goal:** Claude inline editing, command bar, and panel conversation.

### Task 6.1: Anthropic Client (Rust)

**Depends on:** 0.4
**Outputs:** `src-tauri/src/clients/anthropic.rs`

Implement `AnthropicClient` from `[ARCH §12.1]`:
- `new(api_key: &str, model: &str)` — constructor
- `complete(system: &str, messages: &[Message], max_tokens: u32) -> Result<CompletionResponse>`

API key from Keychain (`com.prism.anthropic` / `default`).
Default model: `claude-sonnet-4-20250514`.

### Task 6.2: Agent Context Builder

**Depends on:** 6.1
**Outputs:** `src-tauri/src/commands/agent.rs`

Implement `build_agent_context()` from `[ARCH §12.2]` and all agent commands from `[ARCH §3.2.5]`:
- `agent_edit` — takes note + selection + prompt, returns suggested edit as diff
- `agent_chat` — conversational exchange with document context
- `agent_transform` — transform content type (creates new note)
- `agent_generate` — generate new content from prompt

System prompts per operation:
- **Edit:** "You are an expert editor. Given the document and the user's selected text, apply the requested edit. Return ONLY the replacement text, nothing else."
- **Chat:** "You are a writing collaborator. You can see the user's current document. Help them brainstorm, refine, and improve their work."
- **Transform:** "Convert the following document into a [target type]. Preserve the semantic content. Use the appropriate formatting conventions."

### Task 6.3: Inline Prompt (`⌘J`)

**Depends on:** 6.2, 2.4
**Outputs:** `src/components/agent/InlinePrompt.tsx`, `src/components/agent/DiffView.tsx`

**InlinePrompt:**
- Triggered by `⌘J` when text is selected in any renderer
- Positioned at the selection coordinates (floating)
- Small text input: "What should I do with this?"
- On submit: calls `agentApi.edit({ note_id, selection, cursor_position, prompt })`
- Shows loading spinner while waiting
- On response: renders `<DiffView>` inline

**DiffView:**
- Shows original text (red/strikethrough) and suggested text (green) side by side or inline
- Two buttons: "Accept" (applies edit) and "Reject" (dismisses)
- Accept: replaces selection in editor, triggers auto-save

**TipTap integration:** Add a custom TipTap extension `InlineAgent` that:
- Listens for `⌘J` keydown
- Gets current selection text and coordinates
- Calls `uiStore.openInlinePrompt(position)`
- The `InlinePrompt` component reads position from store

**Acceptance:** Select text → ⌘J → type "make more concise" → see diff of suggested edit → accept → text replaced in editor.

### Task 6.4: Agent Panel Chat

**Depends on:** 6.2
**Outputs:** `src/components/agent/PanelChat.tsx`

Replace the placeholder "Agent" tab in the context panel:
- Chat-style interface
- Messages: user messages (right-aligned) and agent responses (left-aligned)
- Input at bottom
- On send: calls `agentApi.chat(messages, currentNoteId)`
- Agent responses can contain "Apply to document" buttons for suggested edits

**Acceptance:** Open agent panel → type a question about the current document → get a contextual response. "Apply" button inserts suggested text into the editor.

### Task 6.5: Command Bar

**Depends on:** 6.2, 1.5
**Outputs:** `src/components/layout/CommandBar.tsx`

Implement the command bar from `[ARCH §17]`:

**Component:**
- Modal overlay triggered by `⌘K`
- Large text input at top
- Results section below showing matching commands + vault search results
- Categories: Navigation, Create, Sync, Transform

**Behavior:**
1. On keystroke: filter `COMMANDS` array by fuzzy match on label
2. Simultaneously run `useVaultSearch(query)` for vault results
3. Display commands above vault results, separated
4. If no commands match and query looks like natural language → show "Ask Claude: {query}" option
5. Enter → execute top result
6. Escape → close

**Command registration:** Import the `COMMANDS` array from `[ARCH §17.1]`. Each command has a `when()` predicate — only show commands that are contextually valid.

**Acceptance:** ⌘K opens command bar. Typing "new doc" shows "New Document" command. Typing "sync" shows sync commands. Typing "what is SquadSwarm" searches vault and shows matching notes. Typing natural language shows "Ask Claude" option.

### Task 6.6: Keyboard Shortcuts

**Depends on:** 6.3, 6.5, 1.7
**Outputs:** `src/app/hooks/useKeyboard.ts`

Register all shortcuts from `[ARCH §18]`:
```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "k") { e.preventDefault(); openCommandBar(); }
    if (mod && e.key === "j") { e.preventDefault(); openInlinePrompt(); }
    if (mod && e.key === "s") { e.preventDefault(); saveActiveNote(); }
    if (mod && e.key === "n") { e.preventDefault(); newDocument(); }
    if (mod && e.key === "b") { e.preventDefault(); toggleSidebar(); }
    if (mod && e.key === "w") { e.preventDefault(); closeActiveTab(); }
    if (e.key === "Escape") { closeOverlays(); }
    // ... all shortcuts
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, []);
```

**Acceptance:** All keyboard shortcuts work as documented.

---

## Phase 7: Authentication & Configuration

**Goal:** OAuth2 flows for Google and Notion. App settings. Onboarding.

### Task 7.1: OAuth2 Flow (Google)

**Depends on:** 0.4
**Outputs:** `src-tauri/src/auth/oauth2.rs`, `src-tauri/src/auth/keychain.rs`, `src-tauri/src/auth/tokens.rs`

Implement the OAuth2 flow from `[ARCH §14.1]`:
1. Start local HTTP server on random port
2. Open browser to Google OAuth consent screen
3. Handle redirect callback
4. Exchange code for tokens
5. Store in Keychain
6. Refresh tokens on 401 responses

**Google OAuth scopes needed:**
```
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/presentations
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/drive.file
```

### Task 7.2: Settings UI

**Depends on:** 7.1
**Outputs:** `src/components/layout/Settings.tsx`

Settings dialog (opened from status bar or ⌘K → "Settings"):
- **Connections:**
  - Google: "Connect" button → triggers OAuth. Shows connected accounts. "Disconnect" button.
  - Notion: "Connect" button → paste integration token. "Disconnect."
  - Claude: "Connect" → paste API key. "Disconnect."
  - Matrix: shows connection status.
- **Parachute:** shows vault name, note count, port.
- **Appearance:** theme toggle (dark/light — future), font size.
- **Sync:** default conflict strategy, auto-sync interval.

### Task 7.3: Onboarding Flow

**Depends on:** 7.1, 7.2
**Outputs:** `src/components/layout/Onboarding.tsx`

First-run experience:
1. Welcome screen: "Prism — One interface for everything"
2. Check Parachute connection → if down, show instructions
3. "Connect Google" → OAuth flow
4. "Connect Notion" → token input
5. "Add Claude API Key" → key input
6. "Matrix" → auto-detect if running
7. "Ready!" → dismiss, open main app

**Acceptance:** First launch shows onboarding. After connecting services, they appear as connected in Settings.

---

## Phase 8: Polish & Integration Testing

**Goal:** Everything works together. Edge cases handled. Performance optimized.

### Task 8.1: Error Handling & Offline

**Depends on:** All prior phases
**Outputs:** Updated error handling throughout

Implement behavior from `[ARCH §20.2]`:
- Parachute down → full error screen
- Matrix down → "Messaging offline" badge, other features work
- Gmail down → "Email offline" badge
- Claude down → "Agent offline" badge, editing continues
- Toast notifications for transient errors

### Task 8.2: Performance Optimization

**Depends on:** All prior phases
**Outputs:** Optimized components

Per `[ARCH §23]`:
- Virtualize project tree for large vaults (react-window)
- Virtualize message lists
- Lazy-load renderers (already done via `React.lazy`)
- Debounce search at 200ms
- Auto-save debounce at 2000ms

### Task 8.3: End-to-End Testing

**Depends on:** All prior phases

Test scenarios:
1. Open app → vault loads → sidebar shows projects → open a document → edit → save → reload → edits persist
2. Send a WhatsApp message from phone → appears in Prism inbox within 30s → reply from Prism → appears on phone
3. Create document in Prism → sync to Google Docs → edit in Docs → pull → changes appear in Prism
4. ⌘J on selected text → agent suggests edit → accept → content updated
5. ⌘K → "new presentation" → slides editor opens → add slides → export
6. Kanban: create task → drag to In Progress → check active-tasks.json → status updated

### Task 8.4: App Distribution

**Depends on:** 8.1, 8.2
**Outputs:** `Prism.app` bundle

```bash
cargo tauri build
# Output: src-tauri/target/release/bundle/macos/Prism.app
```

Configure `tauri.conf.json`:
- App name: "Prism"
- Bundle identifier: "com.prism.app"
- Window: 1440×900 default, resizable
- Titlebar: transparent (macOS native)

---

## Dependency Graph Summary

```
Phase 0: Scaffolding
  0.1 → 0.2 → 0.3
  0.1 → 0.4
  0.1 → 0.5 → 0.6

Phase 1: Vault Browser (depends on Phase 0)
  1.1 → 1.3
  1.2 → 1.3
  0.2 → 1.4 → 1.5
  0.3 → 1.6 → 1.7
  1.5 + 1.7 → 1.8
  1.5 + 1.7 → 1.9
  1.7 → 1.10

Phase 2: Document Editor (depends on Phase 1)
  1.4 → 2.1
  2.1 + 1.9 → 2.2
  1.5 → 2.3
  2.2 + 2.3 → 2.4
  0.6 → 2.5
  1.5 + 1.8 + 1.4 → 2.6
  1.7 + 1.5 → 2.7

Phase 3: Communications (depends on Phase 2)
  0.4 → 3.1 → 3.2 → 3.3 → 3.4
  3.2 + 3.3 + 2.1 → 3.5
  3.2 + 3.5 → 3.6
  0.4 → 3.7 → 3.8 → 3.9
  3.6 + 3.9 → 3.10
  3.7 → 3.11

Phase 4: Sync (depends on Phase 3)
  0.6 → 4.1
  4.1 + 3.7 + 2.5 → 4.2
  4.1 → 4.3
  4.1 + 4.2 + 4.3 → 4.4 → 4.5 → 4.6
  3.7 → 4.7

Phase 5: Renderers (depends on Phase 2)
  2.1 → 5.1, 5.2, 5.3
  5.3 + 3.6 + 4.7 → 5.4

Phase 6: Agent (depends on Phase 2)
  0.4 → 6.1 → 6.2
  6.2 + 2.4 → 6.3
  6.2 → 6.4
  6.2 + 1.5 → 6.5
  6.3 + 6.5 + 1.7 → 6.6

Phase 7: Auth (depends on Phase 3)
  0.4 → 7.1 → 7.2 → 7.3

Phase 8: Polish (depends on all)
  All → 8.1, 8.2, 8.3 → 8.4
```

---

## Total Task Count

| Phase | Tasks | Estimated Effort |
|-------|-------|-----------------|
| 0: Scaffolding | 6 | 1 day |
| 1: Vault Browser | 10 | 3 days |
| 2: Document Editor | 7 | 4 days |
| 3: Communications | 11 | 5 days |
| 4: Sync Engine | 7 | 4 days |
| 5: Renderers | 4 | 3 days |
| 6: Agent | 6 | 3 days |
| 7: Auth & Config | 3 | 2 days |
| 8: Polish | 4 | 3 days |
| **Total** | **58** | **~28 days** |

---

*This implementation plan, combined with the PRD and technical architecture document, provides a complete blueprint for building Prism. An agentic coding agent should be able to execute these tasks sequentially, producing a fully functional application by the end of Phase 8.*
