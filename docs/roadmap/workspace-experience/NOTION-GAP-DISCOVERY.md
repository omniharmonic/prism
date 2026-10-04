# Notion gap discovery — what the parity checklist does not ask for

Written 2026-10-04 from main `44238483`. Read-only research: nothing was run (no tests, builds or servers).

**Inputs.** `NOTION-PARITY-CHECKLIST.md` (all 161 rows and §1.3), `PARITY-GAPS.md`, `CLAUDE.md`, code greps over `packages/core/src`, `apps/web/src`, `apps/server/src`, `apps/client/src-tauri/src`, and the Notion help-center pages listed under Sources. `PARITY-EVIDENCE.md` was not read in full; row statuses come from the checklist and PARITY-GAPS.

**How "absent" was decided.** By grep for the obvious names, plus reading the nearest module. A grep miss is strong but not proof; rows where I could not confirm either way say "not found by grep" or "unverified".

**Status codes in Table A.**
- `C` — covered by a checklist row.
- `X` — excluded in §1.3.
- `N-has` — not in the checklist, but Prism has it (needs a row, not a build).
- `N-absent` — not in the checklist and not built.

**Priority** (single owner plus collaborators, personal knowledge system with an agent): P0 = noticed within a day; P1 = within a week; P2 = occasional; P3 = team/enterprise or irrelevant here.

---

## Summary

Table A has 94 capability lines (many `C` lines bundle several checklist rows).

| Status | Lines | By priority |
|---|---|---|
| `C` covered | 25 | 2 of them flagged weak or deviation |
| `X` excluded in §1.3 | 12 | 5 worth reconsidering (Table C.2) |
| `N-has` (Prism has it, no row) | 16 | P1: 2 · P2: 8 · P3: 6 |
| `N-absent` (not built, not in checklist) | 41 | **P0: 1 · P1: 7** (one is a decision, not a build) · P2: 26 (2 unverified) · P3: 7 |

| Category | Covered | Excluded | Has, no row | Absent |
|---|---|---|---|---|
| Editor | 7 | 3 | 2 | 11 |
| Pages and navigation | 2 | 2 | 2 | 6 |
| Databases | 5 | 3 | 3 | 10 |
| Sharing and collaboration | 4 | 2 | 3 | 4 |
| Search | 1 | 0 | 0 | 1 |
| Templates, import, export | 1 | 0 | 0 | 1 |
| AI | 0 | 1 | 1 | 1 |
| Phone and desktop apps | 3 | 1 | 1 | 2 |
| Settings, account, platform | 2 | 0 | 4 | 5 |

The seven absent P0/P1 builds fall into six slices (N1–N6, Table B): one P0 of size M, and five P1 slices of size S to M. None needs an editor schema bump or a vault schema change. A seventh slice (N7) only adds rows and specs for things that already exist.

The checklist is thorough on what it covers. The misses cluster in three places:

1. **Mouse-and-typing habits in the editor** that Notion users perform without thinking: selecting blocks by dragging from the margin or shift-clicking, `:emoji`, ⌘A escalating to the block.
2. **Database conveniences just below the headline features**: column calculations, a "Me" filter, wrap cells, unique ID.
3. **Notification triggers beyond mentions and comments**: being assigned in a person property, and choosing a per-page notification level.

Separately, about a dozen things Prism already has (tabs, link expiry, profile, quick capture, block-type shortcuts, inbox archive) have no row, so a regression in them would not close the gate.

---

## Table A — Notion capability → status → evidence or gap → priority

### A.1 Editor

| # | Notion capability | Status | Prism evidence or gap | Pri |
|---|---|---|---|---|
| 1 | Basic blocks, toggle headings, callout, quote, divider, columns, simple table, code, TOC | C | NP-ED-08…11, ED-19 | — |
| 2 | Select blocks with the mouse: drag from the margin across blocks, Shift+click a range, ⌘⇧click to add one | N-absent | Block selection is keyboard-only (`lib/tiptap/EditorKeys.ts`: Esc, ↑/↓, Shift+↑/↓). No mousedown handling there or in `BlockHandles.tsx`; no marquee code anywhere. A native text drag across blocks followed by Esc does select them. NP-ED-01 and ED-06 never mention the mouse. | **P0** |
| 3 | ⌘A selects the current block, again selects the page's blocks | N-absent | No `Mod-a` binding in `packages/core/src`; the browser default selects all text. | P1 |
| 4 | Inline emoji by typing `:name` (and `/emoji`) | N-absent | No emoji suggestion plugin (grep `EmojiSuggest`, `shortcode`: nothing). The only picker is the page-icon picker in `DocumentChrome.tsx` (`emoji-picker-react`). | P1 |
| 5 | Block-type shortcuts ⌘⌥0–9 | N-has | Listed in `ShortcutSheet.tsx` and `SlashMenu.tsx`. NP-ED-06 does not name them. | P2 |
| 6 | Option+drag duplicates a block | N-absent | Not found by grep. ⌘D and the block menu cover it. | P2 |
| 7 | Expand / collapse all toggles (⌘⌥T) | N-absent | `expandAll` exists only for the page tree. | P2 |
| 8 | Markdown shortcuts, inline format keys, undo, find/replace, placeholders | C | NP-ED-04, 05, 20, 22, 23, 25 | — |
| 9 | Indent any block under any block with Tab (nested paragraphs) | C (weak) | NP-ED-06 says "Tab / ⇧Tab nest and un-nest" and ED-08 "under every list and toggle". Unverified whether a paragraph nests under a paragraph. See Table C. | — |
| 10 | Images, files, PDF, audio, video, bookmarks, embeds | C | NP-ED-12…15 | — |
| 11 | Image actions: replace, download original, copy | N-absent | Not found by grep (`Replace image`, `Download original`). Resize, align, caption and lightbox exist (ED-12). Unverified. | P2 |
| 12 | Code block caption; Mermaid preview | N-absent | No `mermaid` anywhere. | P2 |
| 13 | Synced blocks, link to block | X | "Deferred past 1.0 … needs stable block IDs" | see C |
| 14 | Equations, inline and block | X | "Deferred … rarely used in this vault" | — |
| 15 | Button block, template button | X | "Database automations, Buttons, sub-items, dependencies — Excluded" | — |
| 16 | Breadcrumb block | N-absent | No node in `editor/blocks.ts`. Page breadcrumbs exist (PG-04). | P3 |
| 17 | Link-to-page block, sub-page block | C | NP-PG-15, RF-01; slash "Link to page" in `SlashMenu.tsx` | — |
| 18 | Turn a block into a page; turn a simple table into a database | N-absent | Not found by grep. "Move to" another page exists (ED-02). | P2 |
| 19 | Drag a page from the sidebar into the body, or a block onto a sidebar page | N-absent | Not found. "Move to" and `[[` cover the result. | P2 |
| 20 | Block menu, slash menu, colours, selection toolbar, links, paste fidelity | C | NP-ED-02, 03, 16, 17, 18, 21 | — |
| 21 | Comments on a non-text block | C | Block menu → Comment (`onComment` in `BlockHandles.tsx`), NP-ED-02 | — |
| 22 | Spell check | N-has | Browser-native; some inputs set `spellCheck`. | P3 |
| 23 | Copy page URL with ⌘L | N-absent | Not in `lib/shortcuts.ts`. Copy link is in menus (PG-07). | P2 |

### A.2 Pages and navigation

| # | Notion capability | Status | Prism evidence or gap | Pri |
|---|---|---|---|---|
| 24 | Icon, cover, title, breadcrumbs, width, font, small text, lock, backlinks, outline, history, page info | C | NP-PG-01…17 | — |
| 25 | Custom icons: uploaded image, Notion icon set with colours | N-absent | Emoji only (`DocumentChrome.tsx`); the tree accepts `metadata.icon` ≤ 32 chars. NP-PG-01 says "emoji icon". | P2 |
| 26 | Duplicate a page **with its sub-pages** | N-absent | `usePageActions.duplicate` creates one note (`duplicateCopy` + one `createNote`); sub-pages are not copied. NP-PG-07 only says "Duplicate". | P1 |
| 27 | Tabs in the app: open, close (⌘W), reorder, ⌘-click opens a new tab | N-has | `TabBar.tsx` (`reorderTabs`, `closeTab`), `Mod-W` in `lib/shortcuts.ts`, `openInNewTab()`. No row gates tab behaviour; SR-07 and PG-06 touch it only in passing. | P1 (row) |
| 28 | New tab ⌘T, reopen closed tab, pin a tab | N-absent | No binding or store field (grep `reopenTab`, `pinTab`). A browser tab cannot take ⌘T; the native client could. | P2 |
| 29 | Go up one level (⌘⇧U) | N-has | Listed in `ShortcutSheet.tsx`. | P3 |
| 30 | Sidebar: favourites, recents, tree, drag, shared, trash, peek, resize, Home | C | NP-SB-01…15 | — |
| 31 | Teamspaces | X | "Mapped to vaults/workspaces" | — |
| 32 | Follow a page / per-page notification level (all comments, replies and mentions only) | N-absent | No such setting (grep `follow`, `notification_level`). Settings are per category only. | P2 |
| 33 | Customize page (how backlinks and comments display) | N-absent | Not found. | P3 |
| 34 | Page analytics, verification, wiki | X | "Analytics, verified pages … Excluded" | — |
| 35 | Zoom in/out in the desktop app | N-absent | Not found in `apps/client/src-tauri`. Unverified whether the webview default applies. | P2 |

### A.3 Databases

| # | Notion capability | Status | Prism evidence or gap | Pri |
|---|---|---|---|---|
| 36 | Table, board, gallery, list, calendar views; inline and linked views | C | NP-DB-01…07 | — |
| 37 | Timeline, chart, form, feed, map views | X | "Deferred … five views are gated". Note: dashboards already have `timeline` and `chart` widgets (`widget-registry.ts`). | see C |
| 38 | Column calculations at the foot of a table (count, count values, unique, empty, percent, sum, average, median, min, max, range, earliest/latest date) | N-absent | `views.tsx` shows group and row counts only. Not in §1.3 either (formulas and rollups are; calculations are not). | P1 |
| 39 | Core and further property types, system properties | C | NP-DB-08…10 | — |
| 40 | Formula, rollup | X | "Deferred past 1.0 (recommended)" | see C |
| 41 | Unique ID property | N-absent | No kind in `lib/database/schema.ts`. Not listed in §1.3. | P2 |
| 42 | Button property, sub-items, dependencies, automations | X | "Excluded — the agent skill scheduler is Prism's automation model" | — |
| 43 | Place property | N-has (different) | Geometry metadata and the Map tab. | P3 |
| 44 | Filters with groups, sorts, group by, saved views, search | C | NP-DB-13…17 | — |
| 45 | Relative date filters ("today", offsets) | N-has | `@today`, `@today±N` in `lib/database/query.ts`. DB-13 does not name them. | P2 (row) |
| 46 | "Me" as a person filter value in a saved view | N-absent | `assignedToMe` exists only as a whole-query flag for Home (`my-tasks.ts`); no `@me` filter value in `query.ts`. | P2 |
| 47 | Wrap cells toggle | N-absent | CSS only; no view option in `config.ts`. | P2 |
| 48 | Reorder rows by drag in a table (manual order) | N-absent? | No sortable rows in `views.tsx` (dnd-kit is used for the calendar and boards). Boards keep manual order (DB-24). Unverified. | P2 |
| 49 | Conditional row colour, sub-groups | N-absent | Not found. | P3 |
| 50 | Row peek, templates, bulk actions, CSV, permissions, phone | C | NP-DB-18…25 | — |
| 51 | Previous / next row while a peek is open | N-absent? | Not found by grep. Unverified. | P2 |
| 52 | Repeating database templates | N-absent | Not found. An agent skill could do it; nothing is wired. | P2 |
| 53 | Reminder on a date **property** | N-absent | Reminders attach to date chips in the body (`reminders` table, RF-06) only. | P2 |
| 54 | Lock database / lock views | N-absent | Page lock exists (PG-09); no view lock. | P2 |
| 55 | Property visibility on the page (always show / hide when empty), page layouts | C (deviation) | NP-PG-05, owner decision c.8. Layout builder: absent, P3. | — |
| 56 | "Can edit content" / "Can create" database levels | N-has | Caps `create`, `organize` in `permissions.ts`. | P3 |

### A.4 Sharing and collaboration

| # | Notion capability | Status | Prism evidence or gap | Pri |
|---|---|---|---|---|
| 57 | Permission levels, invite, guests, inherited access, request access | C | NP-CO-05, 06, 09, 13, 14 | — |
| 58 | Link sharing with an expiry | N-has | `ShareDialog.tsx` "Link expires after", expired state. CO-06 does not mention expiry. | P2 (row) |
| 59 | Publish to web per page, custom domain | X | "Deviation: Prism publishes per tag". Anyone-with-link (CO-06) covers the common case. | — |
| 60 | Password on a published site | N-has | `publish.ts` unlock cookie. | P3 |
| 61 | Groups, SAML, SCIM, guest seats | X | "Excluded" | — |
| 62 | Inline comments, page discussion, suggested edits, presence, carets, activity | C | NP-CO-01, 02, 10, 11, 12, 15 | — |
| 63 | Emoji reactions on comments | N-absent | "reaction" appears only in Matrix code. | P2 |
| 64 | Files or images inside a comment | N-absent | Not found. | P3 |
| 65 | Inbox with mentions, replies, shares, reminders, suggestions | C | NP-CO-03 | — |
| 66 | Inbox archive and filter by type | N-has | `box=archived`, `type=` in `/api/notifications`; swipe to archive. CO-03 does not ask for it. | P2 (row) |
| 67 | Notification when you are **added to a person property** (assigned) | N-absent | Producers in `notifications.ts` are mentions, comments, reminders, shares, access requests, suggestions. `POST /api/properties/:id` produces none. | P1 |
| 68 | Notification on property changes of a followed database page (status, due date) | N-absent | As above. | P2 |
| 69 | Push and email delivery, per-type settings | C | NP-CO-04 | — |

### A.5 Search

| # | Notion capability | Status | Prism evidence or gap | Pri |
|---|---|---|---|---|
| 70 | Quick find, recents, highlight, filters, blended ranking, commands, back/forward | C | NP-SR-01…08 | — |
| 71 | Sort results (best match, last edited, created) | N-absent | `/api/search` has no sort parameter; `searchFilters.tsx` has none. | P2 |

### A.6 Templates, import, export

| # | Notion capability | Status | Prism evidence or gap | Pri |
|---|---|---|---|---|
| 72 | Templates, variables, export page/vault, Markdown/HTML/CSV/Notion ZIP import, print | C | NP-TX-01…06, DB-25 | — |
| 73 | Import Word (.docx), Google Docs, Confluence, Evernote, Trello, Asana | N-absent | Import accepts .zip, .md, .html, .csv (`routes/import.ts`). `docx` appears only as a content type and a drop target. | P2 (docx), P3 (rest) |

### A.7 AI

| # | Notion capability | Status | Prism evidence or gap | Pri |
|---|---|---|---|---|
| 74 | Ask, summarize, translate, AI blocks, Q&A, autofill | X | "Replaced by the Prism agent" — NP-AI-01…03 | see C |
| 75 | AI meeting notes | N-has (different) | Fireflies/Fathom transcript ingest and meeting notes. | P3 |
| 76 | AI for every member | N-absent | `/api/agent/*` is server-owner only (decision D3); a collaborator has no AI surface at all. | P1 (decision) |

### A.8 Phone and desktop apps

| # | Notion capability | Status | Prism evidence or gap | Pri |
|---|---|---|---|---|
| 77 | Bottom bar, new page, action sheet, keyboard toolbar, gestures, safe areas, tablet | C | NP-MB-01…10 | — |
| 78 | Share-sheet capture, web clipper | X | "Deferred … separate native target" | see C |
| 79 | Home-screen / lock-screen widgets, Siri shortcuts, Spotlight | N-absent | No widget target. | P2 |
| 80 | Voice capture | N-absent | No `MediaRecorder` use. | P2 |
| 81 | Offline pages, sync state | C | NP-OF-01…06 | — |
| 82 | Desktop quick capture (tray, global shortcut), native notifications, export, drop | N-has | `apps/client/src-tauri/src/capture*.rs`, `shortcut.rs`, `menu.rs`. NP-NA-07 names "quick capture" in one clause with no acceptance detail. | P2 (row) |
| 83 | Sign-in, biometric lock, push, deep links, resume | C | NP-NA-01…06 | — |

### A.9 Settings, account, platform

| # | Notion capability | Status | Prism evidence or gap | Pri |
|---|---|---|---|---|
| 84 | Profile: display name and photo | N-has | `AccountSettings.tsx` (name, avatar, password). No row. | P1 (row) |
| 85 | Signed-in devices, sign out everywhere | N-has | Settings → Account → Signed-in devices. No row. | P2 (row) |
| 86 | Start week on Monday; date and time format; timezone | N-absent | Calendars are Monday-first in code (`views.tsx` `(getDay()+6)%7`, `CalendarRenderer.tsx` `weekStartsOn: 1`); no preference in `Settings.tsx` or `stores/settings.ts`. Dates use the browser locale. | P1 |
| 87 | Appearance, reduce motion, start page | C | NP-AX-01, AX-06, SB-03 | — |
| 88 | Language | N-absent | No i18n layer. | P3 |
| 89 | Connections / integrations settings | N-has | Settings → Data Sources, Network → Server integrations. No row. | P2 (row) |
| 90 | API, integrations, MCP | N-has | Prism MCP at `/mcp`, agent access tokens (`AgentAccessTokens.tsx`). No row. | P2 (row) |
| 91 | Webhooks | N-absent | None outbound. | P3 |
| 92 | Trash and restore | C | NP-SB-10 | — |
| 93 | Help, getting-started content, what's new | N-absent | Only the keyboard shortcut sheet (ED-07). A collaborator invited to a page gets no orientation. | P2 |
| 94 | High-contrast mode, multi-account switcher | N-absent | Not found. | P3 |

---

## Table B — absent P0/P1 items as build slices

None of these needs an editor schema bump (`COLLAB_SCHEMA_VERSION` stays 5) or a vault tag-schema change. Sizes follow PARITY-GAPS: S under a day, M one to three days, L more.

| Slice | Title | Checklist rows to add (proposed acceptance text) | Files / modules | Data model impact | Size | Parallel-safe with |
|---|---|---|---|---|---|---|
| **N1** | Mouse block selection (Table A 2, 3, 6) | **NP-ED-26** — "Dragging from the page margin across blocks selects whole blocks with the same highlight as Esc. Shift+click extends the block selection to the clicked block; ⌘⇧click adds or removes one. ⌘A selects the current block's text, a second ⌘A the block, a third every block. The selection then takes ⌘D, Delete, drag and the block menu. Works in plain and live editors; read-only allows select and copy only." | New `lib/tiptap/BlockMouseSelect.ts` (ProseMirror plugin writing the existing `blockSelectionKey` state); `EditorKeys.ts` for ⌘A; `editor-blocks.css`. | None. View-only plugin state. | M | N2 (only shared touch point is the one-line extension registration in both editors' config), N3–N6 |
| **N2** | Inline emoji (Table A 4) | **NP-ED-27** — "Typing `:` plus two letters opens an emoji list filtered by name; ↵ inserts the character, Esc leaves the typed text. It never opens inside code, a URL or a time (`10:30`), nor during IME composition. `/emoji` opens the same list." | New `lib/tiptap/EmojiSuggest.ts` + small menu component (reuse `MentionMenu` listbox pattern and the lazy `emoji-picker-react` data); add `.prism-emoji-menu` to `EDITOR_POPUPS`. | None. Inserts plain text. | S | N1 (see above), N3–N6 |
| **N3** | Table calculations (Table A 38) | **NP-DB-26** — "A table view has a footer row. Each column offers Count, Count values, Count unique, Count empty / not empty, Percent empty / not empty; numbers add Sum, Average, Median, Min, Max, Range; dates add Earliest, Latest, Range. The figure covers every row the viewer can see that matches the view's filter, not only loaded rows; grouped tables show it per group. The choice is saved per view." | `components/database/views.tsx` (table footer), `ViewControls.tsx`, `config.ts` (`calculations?: {key: fn}` on a view), `lib/database/query.ts` (pure aggregate), `apps/server/src/routes/databases.ts` (`/api/query` returns `aggregates` computed after the permission filter, so hidden rows never count). | `prism_database.views[].calculations` in the database note's metadata. Unknown values must fail closed like the rest of `config.ts`. No vault schema change. | M | N1, N2, N4, N5. **Not** N6 (both edit `views.tsx`) — run N6 after N3 or split the calendar grid out first |
| **N4** | Duplicate with sub-pages (Table A 26) | **NP-PG-18** — "Duplicate on a page that has sub-pages copies them too, keeps their order, and gives every copy its own files. Pages the person cannot view are skipped and the toast says how many. A private page's copies stay private to the person duplicating. One Undo moves the whole copy to Trash." | New `POST /api/notes/:id/duplicate` in `apps/server/src/routes/pages.ts` (reuse the move route's subtree listing, `createCapsAt`, `placementRefusal`, the attachment copy route's logic); `lib/pages/usePageActions.ts`; optional `VaultClient.duplicatePage`. Fallback on the legacy desktop: today's single-note copy. | None. `prism_client_op` for idempotent retry. | M | N1, N2, N3, N5, N6 |
| **N5** | Assignment notifications (Table A 67; 32 and 68 as a follow-up) | **NP-CO-16** — "When someone else adds you to a person property of a page you can view, you get an Inbox item ('assigned you to <page>') and push per the notification settings. Removing and re-adding within an hour does not notify twice. Ingest writes and your own changes never notify." | `apps/server/src/notifications.ts` (new producer + type `assigned`, category under `mention` or a new `assignment`), hook in `routes/databases.ts` `POST /properties/:id` and `/properties/batch` (diff of person-kind fields, resolve through `my-tasks.ts` identity rules), `components/inbox/*` row copy. | New notification type; `notification_settings` gains a category only if a separate toggle is wanted. SQLite only. | M | N1–N4, N6 |
| **N6** | Regional preferences (Table A 86) | **NP-AX-09** — "Settings → Appearance has Start week on (Sunday / Monday), Date format and 12/24-hour time. Database calendars, the Calendar tool, date pickers, date chips and 'edited' stamps all follow them on every device." | `stores/settings.ts` + `/api/me/preferences` (synced), `Settings.tsx`, `lib/database/dates.ts`, the calendar grid in `components/database/views.tsx`, `CalendarRenderer.tsx`, `CalendarDashboard.tsx`, `DatePicker`. | Preference keys only. | S–M | N1, N2, N4, N5. After N3 (shared `views.tsx`) |
| **N7** | Rows for what already exists (spec-only, like slice G) | **NP-SR-09** tabs: "Open pages are tabs: ⌘W closes, drag reorders, ⌘-click or 'Open in new tab' opens behind the current one, and the set is restored on reload." **NP-CO-06** add "…an optional expiry; an expired link says so". **NP-CO-03** add "archive, and filter by type". **NP-ST-01** (new section): "Settings → Account edits display name and photo, shows signed-in devices with Revoke, and changes the password." **NP-NA-07** split quick capture into its own sentence with a result ("a captured note appears in the vault within 5 s"). **NP-ED-06** add ⌘⌥0–9. **NP-DB-13** add "relative dates (today, ±N days)". | Fixtures only under `apps/web/e2e-fixtures/`. | None. | S–M | Everything (no product code) |

**Decision rather than build:** Table A 76 (AI for members). Notion AI is available to every member; Prism's agent is owner-only because turns run on the vault token. The route out already exists behind a flag (`AGENT_PRISM_PROFILES`, per-turn `pp_` credential bound to the caller's account). Opening `prism-ro` to members is a security decision plus M of work in `routes/agent.ts`, budgets per account, and UI gating.

---

## Table C — weak rows and exclusions to reconsider

### C.1 Rows that can pass while the product still feels behind

| Row | Why it is weak | Suggested tightening |
|---|---|---|
| **NP-AI-01…03** | They pass with the server owner alone. Every collaborator sees no agent entry point (`useAgentAvailable` is false on 403), where a Notion guest's workspace has AI on every page. | State who gets it. Either "owner only (decision D3)" written into the row, or a member read-only profile. |
| **NP-ED-06** | Keyboard only. A user who drags from the margin or shift-clicks gets a text selection, not blocks. "Tab / ⇧Tab nest" is not tied to block types, so it can pass with list items alone. | Add the mouse clauses (N1) and "any block nests under any block, or the row lists which do". |
| **NP-DB-03** | "A row count shows" is the only footer requirement. No calculations, wrap, or row reorder. A Notion table user reaches for Sum in the first session. | Add NP-DB-26 (N3); add "wrap cells" as a view option or exclude it by name. |
| **NP-PG-07** | "Duplicate" passes with a copy that silently leaves sub-pages behind. | Add the sub-page clause (N4). |
| **NP-CO-03 / CO-04** | The trigger list omits assignment and property changes, and there is no per-page level. A collaborator assigned a task hears nothing. | Add NP-CO-16 (N5). |
| **NP-PG-01** | "Emoji icon" — Notion also takes an uploaded image and a coloured icon set. Passes while custom icons are impossible. | Either add "or an uploaded image" (S–M: `metadata.icon` would hold an own-attachment URL; the tree's 32-char cap and `PageIcon` need to accept it) or record the limit. |
| **NP-SR-04** | Filters only; no sort order. | Add "sort by best match / last edited / created" or exclude by name. |
| **NP-NA-07** | "Multiple windows, quick capture, and native export and drop" has no observable result per item, and ⌘N / ⌘T are not named (⌘N is known gap E). | One sentence per item with a result. |
| **NP-MB-04** | Lists toolbar buttons but not what the phone cannot do that desktop can (columns, table edits, block selection). | Add "every block type can be inserted and edited on phone, or the row lists the exceptions". |
| **NP-ED-08 (toggle open state)** | Already decision c.3; noting that Notion persists it and users notice a page reopening collapsed. | Per-device memory (localStorage keyed by page + block position) would meet the expectation without a schema change. |

### C.2 §1.3 exclusions to reconsider

| Exclusion | Why reconsider | Cheaper alternative |
|---|---|---|
| **Formulas and rollups** ("Deferred past 1.0") | The most-used database feature after select and relation. Any imported Notion database with a formula column arrives with dead text values (the CSV import maps them to properties). A daily Notion user meets this in the first week. The stated reason (server-side evaluation) is right. | A first step that keeps the reasoning honest: **rollup-lite = table calculations (N3)** plus a read-only "count of related pages" on relation columns, both computed in `/api/query`. Full formulas stay deferred. |
| **Links to a block** ("needs stable block IDs") | "Copy link to block" is how people point a collaborator at a paragraph. Comments, mentions and reminders already deep-link by their own ids (`data-comment-id`, `data-mention-uid`). | **Copy link to heading** needs no block ids: the Outline already derives heading anchors. `pageLink(id) + #<heading slug>` and scroll on open. S. Add as a row; keep arbitrary-block links deferred. |
| **Web clipper and iOS share extension** ("doesn't block the first TestFlight build") | For a personal knowledge system, capturing from the phone's share sheet is a daily action, and it is the one capture path Notion's phone app has that Prism's will not. The desktop already has quick capture. | A PWA `share_target` is not available on iOS; the real option is the share extension posting to the same `POST /api/notes` path the desktop capture uses (`capture.rs` is the model). Keep deferred but name it as the first post-1.0 item. |
| **Timeline view** ("Calendar … covers the daily need") | Dashboards already ship a `timeline` widget and dates already support ranges (`lib/database/dates.ts`, calendar multi-day bars). The view may be closer than the exclusion assumes. | Size it before confirming the deferral; if it is M, it removes the most visible missing view. |
| **Sub-items** ("Excluded — agent scheduler is the automation model") | Grouped with automations, but sub-items are a data-shape feature, not automation. Rows are pages and pages nest, so a parent/child task display is plausible without new storage. | Leave excluded for 1.0; move it out of the "automation" line so the reason is accurate. |
| **Equations** | No change recommended. Agree with the deferral. | — |
| **Synced blocks** | No change recommended. The block-ID dependency is real. | — |

---

## Sources

- https://www.notion.com/help/keyboard-shortcuts
- https://www.notion.com/help/writing-and-editing-basics
- https://www.notion.com/help/tables
- https://www.notion.com/help/updates-and-notifications
- https://www.notion.com/help/database-properties
- https://www.notion.com/help/sharing-and-permissions
- https://www.notion.com/help/notion-for-mobile
- https://www.notion.com/releases
- https://www.notion.com/releases/2025-08-19 (offline mode; via search)

Not confirmed from a source and therefore left out of the tables: Heading 4, a "tabs" block, and current details of Notion's phone bottom bar and widgets beyond the AI widget.
