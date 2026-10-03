# Frontend gap analysis: approved mockups and Notion parity

Snapshot: **2026-10-02**, against the deployed redesign (main `2fd27b6`, application source `252657b` via `cb3178a`). This is a read-only design audit. No source was changed.

## Method and evidence

- **Design sources.** Read `MOCKUPS.md`, `DESIGN.md` and `CURRENT-RELEASE.md`, and looked at the mockup boards 01, 06, 07, 11, 12, 13, 14, 16 and 20–23. The workspace-experience worktree and the main checkout hold identical copies; nothing newer exists on main.
- **What was compared.** The current code is main `2fd27b6`, the same commit as `feat/workspace-experience`. `feat/backend-combined` does **not** contain the redesign: its merge-base is `98287de`, and main has about 28k more frontend lines.
- **Live screenshots were captured in fixture mode only.**
  - Main `2fd27b6` was exported with `git archive` into the scratchpad, using backend-combined's `node_modules` through symlinks.
  - Vite ran with `--mode fixture` on **:5194**, with `PRISM_SERVER=http://127.0.0.1:1` and no `.env`. Every page was an `apps/web/e2e-fixtures/*.html` harness, so the data is fictional and no network was reachable.
  - Captures were taken with headless Chromium at 1440×900 and 390×844, then the server was stopped.
  - The files are in the session scratchpad `…/scratchpad/ux/` and are **not committed**. File names are cited below in `this-style.png`.
- **Earlier evidence.** The team's own screenshots under `docs/roadmap/workspace-experience/{verification,evidence,assets/evidence}` were also consulted.
- **Caveat.** Fixture harnesses render isolated components. A missing surround in a capture (for example `sharing-1440.png`, `search-1440.png`) is a harness artefact, not a product gap. The gaps below were confirmed in code.

**Severity:** **V** = blocks the vision · **M** = major · **P** = polish.
**Effort:** S ≤ 1 day · M 2–4 days · L 1–2 weeks · XL more than 2 weeks.

---

## Part 1 — Mockup-by-mockup comparison

### 01 · Writing workspace (`workspace-1440.png`, `slash-menu-1440.png`, `selection-toolbar-1440.png`, `formatting-menu-1440.png`, `tools-expanded-1440.png`)

The shell is close to the board: a vault switcher above search, Pages / Recent / Tools, New page, an Outline toggle, the icon slot, a breadcrumb, a large title and a working slash menu. Differences:

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| **Favorites only appear after something is starred**, and they are stored per device in `localStorage` (`settings.ts favorites`). The board shows Favorites as a primary section. Add an empty-state hint ("Star a page to pin it here") and sync favorites across devices. | M | `navigation/Navigation.tsx`, `app/stores/settings.ts` | Yes for sync: `GET/PUT /api/me/preferences` storing `{favorites[], recent[], sidebar}` per user per vault (SQLite) | M (S without sync) |
| **The header has no labelled Share or Agent buttons and no "Saved" state.** The board has `Saved ✓ · [Share] · [Agent •]`. Current builds show icon-only star, share, agent and panel buttons, and save state sits in the status bar. | P | `layout/TabBar.tsx`, `layout/ShareButton.tsx` | No | S |
| **The selection bubble has only Bold, Italic, Code and Ask agent.** It lacks link, strikethrough, highlight, "Turn into" and comment. The full toolbar does have them, behind *Formatting*. | M | `renderers/SelectionActions.tsx` (22 lines) | No | S–M |
| **The slash menu is a basic block set** (text, H1–3, lists, to-do, quote, code, divider, ask). It has no shortcut hints (the board shows ⌘T / ⌘H), and it lacks Table, Image, Callout and Toggle even though the editor registers Table and Image. | M | `renderers/SlashMenu.tsx` | No for these items; see N7 for embeds and uploads | S |
| **Probable regression: a focused editor draws a 1px blue box around the whole document body** (`slash-menu-1440.png`, `selection-toolbar-1440.png`). Focus-visible should be subtle or absent on the prose surface. | P | `styles/workspace.css` / `DocumentChrome.css` (focus-ring on `.tiptap`) | No | S |
| **Probable dark-mode regression: the companion and context panel renders white on a dark shell** (`workspace-dark-1440.png`). The 10-02 evidence `navigation-desktop-dark.png` shows it dark. Verify outside the fixture, since `?dark` toggles the class after mount. | M if real | `layout/ContextPanel.tsx`, `styles/workspace.css`, the companion CSS from the companion-density slice | No | S |
| **Page tree rows are folders only, with no hover actions.** Rows have a right-click menu (New note, New folder, Rename, Delete) but no inline `+` / `⋯` on hover. Top-level pages and folders don't show page icons. | M | `navigation/ProjectTree.tsx` | No | M |

### 06 · Reviewing proposed changes (`suggestion-review-1440.png`, `suggestions-1440.png`)

Inline insert and delete marks render, along with a collapsible "3 suggested changes" summary. The board's **focused review mode** is not the default inline experience. That mode is "Review changes 1 of 2 ‹ ›" with one hunk at a time, Dismiss / Accept change, an Accepted · Undo toast, a "Needs refresh" stale state that compares current and proposed text, and a Governed banner with Submit proposal. A focused `SuggestionReview.tsx` exists as a standalone entry (B05). Gaps:

- **No previous/next stepping** through suggestions from the inline summary.
- **No undo affordance** after accepting a suggestion.

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| Inline stepper and accept/undo toast; make the focused review reachable from the summary | M | `renderers/SuggestionReview.tsx`, `CollabEditor.tsx`, `ReviewBanner.tsx` | No | M |
| Human suggest-only enforcement is still off (`COLLAB_SUGGEST_ENFORCED=false`), so "Can suggest" carries a trusted-collaborator disclosure | V for shared use | client human-command flow (B05) | Already built server-side (`/api/collab/:id/commands`); the client activation is the gap | L |

### 07–10 · Messages, mobile messages, history and email (`messages-1440.png`, `inbox-1440.png`, `messages-email-1440.png`, evidence `chromium-messages-desktop-light.png`)

Master/detail, a compact header, date dividers, outgoing "You" bubbles and an auto-growing composer all match. Gaps against board 07:

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| **The conversation list shows no last-message preview.** Rows show only title and platform, while the board shows "Mira: I added the agenda". There are also no per-row unread dots or participant avatar stacks. | M | `navigation/Inbox.tsx`, `comms/*` | Partly. A thread list with `lastMessagePreview` (≤140 chars, server-parsed from the last line) and `unread` per thread avoids fetching full thread bodies: `GET /api/threads?…&fields=preview` (`routes/threads.ts`) | M |
| No attachment chips or reply-reference quotes in Matrix bubbles | P | `renderers/MessageRenderer.tsx` | Yes: the Matrix ingest must persist attachment metadata (`m.file` name/size/mxc) and `m.relates_to` in the thread note; the line format currently drops them | L |
| **No "Draft with agent" button in the chat composer.** The email reader has the docked agent; Matrix chats lack the composer entry. | P | comms composer | No (agent sessions exist) | S |
| "Show earlier messages" and the jump-to-new pill are present in thread-reading; there is no conversation filter dropdown ("All conversations") | P | `Inbox.tsx` | No | S |

### 11 · Search and command palette (evidence `search-command-desktop.png`, `command-k-1440.png`)

The palette matches the board: All / Notes / Messages / Commands chips, grouped results, separate Open and Add-to-context actions, and keyboard hints.

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| **Matched terms are not highlighted in snippets** (the board bolds "workshop") | P | `navigation/searchPresentation.ts` | Optional: `/api/search` could return match offsets | S |
| No vault scope picker inside the palette ("Personal vault ▾") | P | `SearchPanel.tsx` | No | S |
| No recent pages / recent searches before typing | M | `CommandBar.tsx` | Same preferences endpoint as favorites | S |

### 12 · Properties and related context (`context-properties-1440.png`, `details-links-1440.png`)

**This is the largest visible gap on the document surface.** The board puts **properties inline under the title**: Status ▾, Project ▾, tag chips with a searchable picker, and Updated. In the build, the title row shows only "Updated · Properties ›", which opens the **side panel** with a type select, a free-text tag input and generic text fields.

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| **Add an inline property bar under the title.** It should be schema-driven (enum → select, date → date picker, reference → note picker, boolean → toggle) and show 3–5 pinned properties, with "+ Add property". | V | `renderers/DocumentChrome.tsx` (`PageProperties`), `layout/MetadataPanel.tsx`, `lib/schemas/*` | Yes: a read endpoint for the tag field schema usable by every role, `GET /api/schemas?tags=a,b` → `{tag: {fields: {name: {type, enum?, indexed}}}}`, filtered to tags the actor can view | M–L |
| **The tag picker is a free-text input plus an Add button.** Use a searchable checklist of existing tags with counts. | M | `MetadataPanel.tsx` | `GET /api/tags` exists; non-owners need a view-filtered tag list (allowlisted already) | S |
| **Related notes ("Suggested from this page") are missing.** Links shows only incoming/outgoing edges. | M | `layout/LinksPanel.tsx` | Yes: `GET /api/notes/:id/related?limit=5` (semantic neighbours from the embedding index, view-filtered, primary vault only, 409 elsewhere) | M |
| "Agent is working on this page · Return to conversation" footer when an inspector replaces the companion | P | `ContextPanel.tsx` | No | S |

### 13 · Document history (`context-history-1440.png`)

The history timeline exists in the Activity tab. The board's **full-surface history view** is a version list beside a Preview/Compare pane, with a sticky "Restore this version / Return to current" footer and attribution avatars. The build uses a narrow side panel plus a `VersionViewer` dialog, which is functionally equivalent.

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| Version rows lack named kinds ("Agent revision", "Accepted by you") | P | `HistoryPanel.tsx` | Partly: vault `actor`/`via` exists for owners; to tag a version as agent-made, the server must stamp `metadata.prism_last_writer = {kind: human|agent, sessionId?}` on agent and suggestion writes | M |

### 14 · Mobile navigation and creation (`mobile-nav-390.png`, `mobile-more-390.png`, `workspace-390.png`)

The bottom bar (Notes, Messages, Search, Agent, More), the browse drawer with vault switcher, New page and Settings, and a More sheet with Open documents and history all match.

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| **No "Saved on this device / Synced" indicator in the mobile header** (the board shows "● Saved on this device") | M | `MobileActionBar.tsx`, `Shell.tsx` | No (offline read cache / drafts already exist) | S |
| **The drawer has no Favorites section** (the board does) | M | `Navigation.tsx` | Preferences sync (see 01) | S |
| **The slash menu is not reachable without a keyboard on phones.** Add a `+` block-insert affordance in the mobile formatting bar. | M | `FormattingBar.tsx` | No | S |

### 16 · Empty, offline and recovery states

Document unavailable / retry, agent unavailable, interrupted turns and the reply-failed draft-kept state are implemented (see `Canvas.tsx` and the comms evidence).

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| **The empty document has no starter actions.** Today it shows only a placeholder. The board has "Ask agent"; Notion offers "Start with: Empty / Template / Import / AI". | M | `DocumentRenderer.tsx` | No | S |
| **Read-only page has no "Request access" button** | M | `ReviewBanner.tsx`, `Canvas.tsx` unavailable branch | Yes: `POST /api/access-requests {noteId, level}` → owner notification and email, plus `GET /acl/access-requests` with approve/deny | M |
| No global offline banner in the document header (the board shows "Offline · Changes saved on this device") | P | `Shell.tsx` | No | S |

### 20 · Task boards (`boards-1440.png`, `boards-alt-1440.png`, `boards-390.png`, `dashboard-1440.png`)

Board/List tabs, View settings, New task, filter, grouping, drag ordering and the phone list mode are present.

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| **No per-column "+ Add task"** (only the global New task) | M | `TaskBoardRenderer.tsx`, `boards/BoardForms.tsx` | No | S |
| **Cards carry a full-width status `<select>`.** That is noisy compared with the board's card `⋯` menu (Open, Move to…, Move earlier/later) and visible **due date** chips. | M | `TaskBoardRenderer.tsx` | No (`due` is in the task schema) | S–M |
| **Only Board and List views exist.** There are no Table, Calendar, Gallery or Timeline views of the same source. | V (Notion parity) | see N2 | see N2 | L |
| "Ungrouped" column bleeds off-screen at 1440 with 5 columns (no horizontal scroll affordance) | P | `boards/BoardWorkspace.css` | No | S |

### 21 · People (`people-dir-1440.png`, `people-profile-1440.png`, evidence `people-profile-1440-light-chromium.png`)

This is close to the board: directory, profile, linked identities, the record tabs (All / Conversations / Meetings / Tasks / Notes) and the "Accounts identify people" note.

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| Record rows lack a snippet and date ("Telegram · Sep 28 · Morgan: Here are the initial notes…") and platform icons | P | `components/people/*` | Yes: the related-records route should return `{lastActivityAt, platform, snippet≤160}` per record | S + S |
| No "Review identities" entry from the directory (the owner-only queue exists server-side) | M | `components/people/*` | Already exists: `/api/admin/people/candidates*` (owner-only); the UI is missing | M |

### 22 · Calendar and transcripts (`calendar-1440.png`, evidence `calendar-records-desktop.png`)

Month, Week and Day views, the event side panel, conversation records with Review matches, and meeting notes are present.

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| **Multi-day events repeat per cell** instead of spanning as one bar (`calendar-1440.png`) | M | `CalendarRenderer.tsx` / `CalendarDashboard` | No | M |
| **No Agenda view** (the board has Month / Week / Agenda) | P | same | No | S–M |
| Attendees are plain text, not links to People profiles | P | event panel | Partly: the `attended-by` links already exist; expose them in the event payload | S |
| No decisions/tasks checklist on the event | P | event panel | Uses the C07 task-extraction contract gap (already tracked) | — |

### 23 · Sharing and governance (`share-dialog-1440.png`, `share-dialog-390.png`)

People, Links, Publish and Sync tabs, private-document handling, and per-person level selects are present. Gaps:

| Gap | Sev | Files | Backend | Effort |
|---|---|---|---|---|
| **People with access show bare emails.** There are no avatars or names, and the Owner row isn't shown. | P | `ShareDialog.tsx` | Yes: `/acl/notes/:id` should return `displayName` per grantee from accounts and People | S |
| **The tab buttons are heavy bordered boxes**, where the board uses underline tabs | P | `ShareDialog.tsx` | No | S |
| **No "Change proposals" side panel next to Share** for governed docs | P | governance UI | No | M |

### Brand, tokens, typography and motion

The tokens (`styles/tokens.css`), light/dark themes, the Sans/Serif/Mono reading-font switch and the vector prism mark are in place and consistent. Remaining work is polish:

- **No motion language.** Sheets, menus and the companion appear without easing. Add 120–180 ms opacity/translate transitions and `prefers-reduced-motion` guards.
- **Hard-coded colours.** A few values like `white` in `context-panels.css` should become tokens.

---

## Part 2 — Notion parity checklist

These are core Notion UX components that Prism lacks entirely, even where no mockup shows them. They are ranked by daily-use impact for a personal knowledge worker.

| # | Missing component | Sev | Likely files | Backend needs (exact) | Effort |
|---|---|---|---|---|---|
| N1 | **Block handles: hover `⋮⋮` drag-to-reorder and `+` insert** on every block, with a block menu (Turn into, Duplicate, Delete, Copy link, Colour). The block-hover capture shows nothing. | V | new `lib/tiptap/BlockHandle.ts` (or `@tiptap/extension-drag-handle-react`), `DocumentRenderer.tsx`, `CollabEditor.tsx` | None. Collab-schema parity must be verified (DESIGN.md §Document editing). | L |
| N2 | **Database views over a tag.** Table (inline-editable property columns), Gallery, Calendar and Timeline views beside Board/List, with saved filters, sorts and grouping per view. Also **inline database blocks** inside documents. Today, boards cover tasks only; dashboard widgets are a separate edit-mode surface. | V | `TaskBoardRenderer.tsx` → generalised `DatabaseView`, `lib/dashboard/filter-engine.ts`, `TagView.tsx` | (a) the schema read `GET /api/schemas?tags=` (above); (b) owner-only **schema write** `PUT /api/schemas/:tag {fields}`, because vault schema writes need an admin token, so the server must mint an ephemeral admin token (`mintEphemeralAdminToken`) behind the CSRF guard; (c) view configs stored in the database note's metadata (no backend); (d) for large tags, server-side query `GET /api/notes?tag=&filter=<json>&sort=&limit=&cursor=` with indexed-field filters, view-filtered for non-owners | XL |
| N3 | **Nested pages.** A page can contain sub-pages, shown in the tree with a disclosure on the page itself and "Add a page inside". Today only folders nest; the tree shows folders, not page hierarchies (`mobile-nav-390.png`). | V | `ProjectTree.tsx`, `NewContentMenu.tsx`, `lib/navigation` | Mostly frontend: path convention `A` + `A/…`, and a child-page block (`[[A/child]]`). Optional: `metadata.prism_parent` so renames keep children. Moving a page with children needs a batch path rename (`POST /api/notes/move {fromPrefix, toPrefix}`) that is atomic or idempotent and safe for history | L |
| N4 | **Inline property bar and per-type property editors** (Part 1 · 12) | V | `DocumentChrome.tsx`, `MetadataPanel.tsx` | Schema read endpoint | M–L |
| N5 | **@-mentions of people, pages and dates** with a hover card. Today `[[` handles wikilinks only. Also date reminders ("@tomorrow 9am"). | M | `lib/tiptap/` new Mention extension, `WikilinkAutocomplete.ts` | People search exists (`/api/people?q=`). Mentions of other accounts need **notifications**: `POST`-side detection on save (server diff of `mention` marks), a `notifications` table, `GET /api/notifications`, `POST /api/notifications/:id/read`, plus Web Push and email reuse. Reminders: `POST /api/reminders {noteId, at}` delivered through the worker tick. | M (UI) + L (notifications) |
| N6 | **Trash and restore** of deleted pages. Delete is a hard delete with a confirm (`ProjectTree.tsx` DeleteConfirm); the vault keeps history on delete, but no UI can bring a note back. | M | new Trash view in `Navigation.tsx` | `GET /api/trash` (deleted notes with their last captured version, view-filtered) and `POST /api/trash/:id/restore` recreating the note at its old path, with `if_exists` conflict handling. Check whether vault 0.7.9 history allows restoring a deleted id; if not, recreate it from the version content and metadata. | M |
| N7 | **File, image and media upload, plus embeds.** Image insert is `window.prompt("Image URL")` (`EditorToolbar.tsx:159`). There is no paste/drop of images or files, no file block, and no bookmark or embed blocks (YouTube, Figma, tweet). | M | `EditorToolbar.tsx`, `DocumentRenderer.tsx` paste/drop handlers, new FileBlock and Bookmark extensions | `POST /api/notes/:id/attachments` (multipart, size/type caps, write cap) → vault attachment API; `GET /api/attachments/:id` streamed with the view cap check, CSP-safe for the native client; `GET /api/unfurl?u=` for bookmark metadata (title, description, favicon) reusing the media-proxy SSRF guard | L |
| N8 | **Callout, Toggle and Columns blocks** (plus toggle headings) | M | new TipTap nodes, `SlashMenu.tsx`, the collab schema, HTML↔Markdown round-trip | None; must round-trip through the server's collab serializer (`collab.ts` document kind) | M |
| N9 | **Page cover image and a full-width toggle.** The icon exists; there is no cover and no "Full width" option (`fullWidth` appears once). | P | `DocumentChrome.tsx` | Cover upload uses N7 attachments; unsplash/gradient presets need no backend | S–M |
| N10 | **Templates.** "New from template" and per-database default templates. `newContent.ts` lists formats, not user templates. | M | `NewContentMenu.tsx`, `newContent.ts` | None: templates can be notes tagged `template`; the instantiation copy is client-side | M |
| N11 | **Page actions menu (`⋯`).** Duplicate, Move to…, Copy link, Lock page, Export (MD/PDF/HTML), Word count, Undo history. Today these are scattered across Details and More. | M | `TabBar.tsx` overflow, `ShareButton.tsx` | Duplicate and Move use existing note create/patch; Lock page = `metadata.prism_locked` honoured by the client (server enforcement would be a caps change) | M |
| N12 | **Comments beyond inline anchors.** Page-level discussion, @-mentions in comments, and an **inbox of comment and mention activity across pages** (Notion "Updates"). | M | `CommentsSidebar.tsx`, `Navigation.tsx` | Notifications API (N5); a comment index `GET /api/comments?mine=1&unresolved=1` derived from Yjs `comments` maps at store time (server-side extraction into SQLite) | L |
| N13 | **Backlinks at the bottom of the page** (Notion's "N backlinks" pill under the title) rather than only in the Details tab | P | `DocumentChrome.tsx`, `LinksPanel.tsx` | None (links API exists) | S |
| N14 | **Sidebar polish.** Drag-to-reorder pages, "Shared with me" section, Teamspaces per vault, Trash entry, hover `+` / `⋯`, persisted manual order. | M | `ProjectTree.tsx`, `Navigation.tsx` | Manual order: `metadata.prism_order` (fractional index) per note (no new route), or preferences sync. "Shared with me": `GET /api/shared-with-me` (notes where the actor has a direct grant, for non-owners) | M |
| N15 | **Synced blocks / transclusion** (embed another page's block live) | P | new node | `GET /api/notes/:id/blocks/:blockId` needs stable block ids in stored HTML; defer | XL |
| N16 | **Quick find inside a page (⌘F) plus replace.** `EditorFindBar` exists; check replace parity. | P | `EditorFindBar.tsx` | None | S |
| N17 | **Markdown shortcuts and keyboard power use:** `⌘⇧↑/↓` move block, `⌘D` duplicate, `⌘/` turn-into. StarterKit gives input rules only. | M | block-handle extension (N1) | None | S (with N1) |
| N18 | **Import** (Notion export ZIP, Markdown folder) and **export a page or tree** from the UI | P | Settings → Import | `POST /api/import/markdown` (zip → notes, owner-only, dry-run first) | L |

---

## Top 15, ranked

1. **N1 block drag handles and `+` insert with a block menu** — V, L, no backend.
2. **N2 database views** (Table, Gallery, Calendar over a tag; saved views; inline database) — V, XL, needs schema read/write and a server query.
3. **N4 / 12 inline schema-driven property bar under the title** — V, M–L, needs `GET /api/schemas`.
4. **N3 nested pages** (page-with-children tree, add page inside, move subtree) — V, L, needs a batch move.
5. **Suggest-only human command flow activation** (B05, `COLLAB_SUGGEST_ENFORCED`) — V for sharing, L, server already built.
6. **N7 image/file paste-drop upload and bookmark/embed blocks** — M, L, needs attachments and unfurl routes.
7. **N5 @-mentions plus a notifications inbox** (with N12 activity) — M, L, needs a notifications API.
8. **Selection bubble parity** (link, strike, highlight, turn into, comment) and **slash menu breadth** (table, image, callout, toggle, shortcuts) — M, S–M.
9. **N6 Trash and restore** — M, M, needs trash routes.
10. **Messages list previews, unread state and avatars** (07) — M, M, needs thread previews.
11. **Favorites and Recent as first-class, synced sections**, plus recent pages in ⌘K — M, M, needs a preferences endpoint.
12. **N10 templates and N11 page `⋯` menu** (duplicate, move, lock, export, copy link) — M, M, no backend.
13. **Task board card polish** (per-column add, card `⋯` menu, due chips, column overflow) — M, S–M.
14. **Calendar multi-day spanning bars and an Agenda view** — M, M.
15. **Dark-mode companion panel and editor focus-box regressions**, plus motion tokens — M/P, S (verify the dark panel outside the fixture first).

## Backend requests (for the backend agent)

| Request | Purpose | Notes |
|---|---|---|
| `GET /api/schemas?tags=a,b` | Inline properties, database columns | View-filtered; any signed-in role; no admin token exposed |
| `PUT /api/schemas/:tag` | Add or edit database properties | Server-owner (or vault admin) only, CSRF, server mints an ephemeral admin token; additive by default |
| `GET /api/notes?tag=&filter=&sort=&limit=&cursor=` | Database views at scale | Indexed-field operators; non-owner results view-filtered |
| `GET/PUT /api/me/preferences` | Favorites, recents, sidebar order and state across devices | Per user × vault, SQLite, small JSON (≤64 KB) |
| `POST /api/notes/:id/attachments`, `GET /api/attachments/:id` | Image and file upload, covers | Caps, type sniffing, view/edit checks, native-client compatible |
| `GET /api/unfurl?u=` | Bookmark and embed cards | Reuse the media-proxy netguard; signed-in only |
| `GET /api/trash`, `POST /api/trash/:id/restore` | Trash | Depends on vault history semantics for deleted ids |
| `POST /api/notes/move {fromPrefix,toPrefix}` | Move a page with its children | Idempotent, resumable, `if_updated_at` per note |
| Notifications: `GET /api/notifications`, `POST /api/notifications/:id/read`, mention extraction on store, `POST /api/reminders` | Mentions, comments inbox, reminders | Reuse push and email plumbing; ids only in push |
| `GET /api/comments?mine=1&unresolved=1` | Cross-page comment inbox | Extract from Yjs comments at store time |
| `POST /api/access-requests` + owner review | "Request access" on read-only or unavailable pages | Rate-limited; email the owner |
| `GET /api/notes/:id/related` | "Suggested from this page" | Embedding neighbours, primary vault only (409 elsewhere) |
| Thread list `preview` / `unread` fields; persist Matrix attachment and reply metadata | Messages parity | Ingest change, so restart pm2 after |
| Grantee `displayName` in `/acl/notes/:id`; record `snippet` / `platform` / `lastActivityAt` in people related-records | Sharing and People polish | Small |
| Writer kind stamp (`prism_last_writer`) on agent and suggestion writes | History attribution | Optional |

## Live screenshots

Live screenshots were captured. There are 63 PNGs in fixture mode from main `2fd27b6`, at 1440×900 and 390×844, saved to the session scratchpad `ux/`. One capture attempt (`properties-expand-1440`) failed to find its control and is excluded. No production server, real `.env` or reserved port was used, and the server was stopped afterwards. The screenshots are intentionally kept out of git.
