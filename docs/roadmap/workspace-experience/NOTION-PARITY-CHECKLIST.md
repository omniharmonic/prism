# Notion UX parity checklist — the TestFlight / App Store release gate

**Written 2026-10-02 against main `11a1e14`.** In-flight branches were read but not counted as passed: `feat/ux-editor-blocks` `279f509`, `feat/ux-databases` `7fd2fdf` plus uncommitted WIP, `feat/ux-pages-nav` (uncommitted WIP on `ee8f975`), `feat/native-ios` `3d62da6` and `feat/backend-apns`.

**Sources.** [FRONTEND-GAP-ANALYSIS.md](FRONTEND-GAP-ANALYSIS.md) (fixture captures from main `2fd27b6`), [MOCKUPS.md](MOCKUPS.md) boards 01–25 plus the three overview concepts, [DESIGN.md](DESIGN.md), [BRAND.md](BRAND.md), [FRONTEND-ACCEPTANCE.md](FRONTEND-ACCEPTANCE.md) and [FEATURE-LEDGER.md](FEATURE-LEDGER.md). Notion's own 2025–2026 desktop, web and iOS behaviour sets the bar wherever no board exists.

## 1. Purpose and the rule

**The rule:** no build goes to TestFlight or the App Store until **every item in §2 is `passed` on `main`**.

- A passing feature branch, a fixture that only runs on a branch, or a production deploy of an unmerged branch does not count.
- An item that regresses after passing goes back to `failing`, and the gate is closed again.
- Items cannot be waived silently. To drop one, move it to §1.3 in a commit the owner approves, with a reason.

### 1.1 How an item is marked `passed`

1. **Code is on main.** Record the merge commit SHA that delivered the behaviour.
2. **Evidence exists.** Add `verification/notion-parity/<ID>.md`, or one row in a shared evidence log, containing:
   - **Fixture runs.** The Playwright spec and test name, and the pass result on **Chromium and WebKit** from main.
   - **Screenshots.** Fictional fixture screenshots at **1440×900 and 390×844, in light and dark**, for every item with UI.
   - **Comparison.** A visual comparison against the named mockup board. Where no board exists, compare against a reference capture of the same state in Notion, taken by the reviewer and stored with the evidence.
   - **Device notes.** For items marked "D", the manual device check: device, OS, build and result.
   - **Remaining limits.** Any limits stated plainly. If a limit contradicts the acceptance text, the item has not passed.
3. **An independent reviewer checks it.** This is someone other than the implementing agent: the orchestrator or a review sub-agent. They re-run the named fixture on main and inspect the screenshots, then write `passed (<sha>, <evidence link>, <reviewer>, <date>)` into the Status cell.
4. **The owner countersigns** the whole checklist once, during the final procedure in §4. That countersignature opens the gate.

Private production captures never go into git. Production checks use synthetic `_test` notes, which are removed afterwards.

### 1.2 Verification legend

| Code | Meaning |
|---|---|
| **F** `file.spec.ts › "test"` | A Playwright fixture journey in `apps/web/e2e-fixtures/`, run under `playwright.config.ts` on Chromium and WebKit. **Existing** names are real tests on main or on the named branch. **New** names are specs still to be written; the test title given here is the required title. |
| **S** `nn` | A screenshot comparison against the mockup board `assets/nn-*.png` at 1440×900 and 390×844, in light and dark. `S Notion` means the comparison is against a Notion reference capture. |
| **D** | A manual check on a physical iPhone (and iPad where stated) running the TestFlight-candidate build. Simulator results alone don't count. |
| **P** | Production smoke on the real vault after deploy, using synthetic notes. |

**Status column, as of 2026-10-08 (the fourth verification pass at main `44238483` + the reconciliation and quick wins of branch `polish4/parity-quick-wins`; 12 rows changed status and all seven `deviation` rows are resolved — see PARITY-EVIDENCE "Totals"). Counts: 68 passed · 43 needs-screenshot · 33 needs-device · 16 partial · 1 not-measured · 0 deviation · 0 missing = 161. Eight of the 16 partial rows (NP-PG-03, ED-08, ED-16, ED-24, DB-20, CO-10, CO-12, AI-02) are **in progress (w9-gaps)**: built on `feat/w9-gaps`, not on main. Phone work of 2026-10-08 (keyboard toolbar, tab bar hiding, zoom, properties, the Calendar tool) was exercised on the owner's iPhone that day, but no per-row device result is recorded yet — those rows stay `needs-device` until `qa/device-pass-script.md` is filled in. The iPad uses the iPhone build (it is not its own project).**

**How to read a status:** one word per row — `passed`, `deviation` (built, differs from the text by a recorded decision; owner decision pending), `needs-screenshot`, `needs-device`, `partial`, `missing`, `not-measured`. The evidence and the exact gap for every row are in [PARITY-EVIDENCE.md](PARITY-EVIDENCE.md); the remaining work is in [PARITY-GAPS.md](PARITY-GAPS.md). `passed` here means the fixture evidence exists on Chromium and — since the WebKit pass ([WEBKIT-RESULTS.md](WEBKIT-RESULTS.md)) — on Playwright WebKit, with the per-row skips named in PARITY-EVIDENCE; the reviewer sign-off format of §1.1 step 3 is still owed. Rows whose behaviour is built only on `feat/w9-gaps` / `feat/w10-fixes` are judged on main and do not count until those branches merge.

**Status values used before the first pass** (kept for the record):

- `missing` — not built anywhere.
- `in-progress (<branch>)` — being built on that branch, not merged.
- `exists-needs-verification` — on main but not yet proven against the acceptance text. The gap analysis may already note a specific shortfall, which is quoted.

### 1.3 What "parity" deliberately excludes (owner to confirm)

These Notion features are **not** gate items. Each row gives a decision rather than a silent drop.

| Notion feature | Decision | Why | Revisit |
|---|---|---|---|
| **Notion AI**: AI blocks, Q&A, AI autofill properties, AI meeting notes, translate, "Ask AI" | **Replaced by the Prism agent.** The agent's entry points are gated in NP-AI. | The agent already has durable sessions, Read-only / Suggested edits only / Read-write modes, sources and reviewable changes. A second AI surface would duplicate state and weaken the review guarantee. | No; extend the agent instead |
| **Synced blocks** and **links to a block** | **Deferred past 1.0** | Both need stable block IDs that survive storage as vault HTML/Markdown, Yjs, agent MCP edits and publishing. That is a collab-schema migration (gap N15, XL). Heading anchors remain available through the Outline. | After the block-ID design |
| **Formulas and rollups** | **Deferred past 1.0 (recommended)** | To be correct in filters, sorts, board grouping, `/api/query` and MCP, a formula must be evaluated server-side and indexed. A client-only formula would show different values on each surface. Interim: dashboard stat widgets and agent skills. Plain relations are in scope (NP-DB-12). | When `/api/query` gains computed columns |
| **Timeline/Gantt, Chart, Form, Feed and Map database views** | **Deferred** | Calendar and the existing Dashboard widgets cover the daily need, and Map is already a separate tool. Five views are gated (table, board, gallery, list, calendar). | 1.x |
| **Database automations, Buttons, sub-items, dependencies** | **Excluded** | The agent skill scheduler is Prism's automation model. | No |
| **Equations (KaTeX)** | **Deferred** | Rarely used in this vault, and it adds a collab-schema node plus a publishing renderer. | On request |
| **Teamspaces** as a separate concept | **Mapped to vaults/workspaces** | The vault switcher and Workspaces already provide the boundary, and permissions are vault-scoped. | No |
| **Per-page "Publish to web" with a custom domain (Notion Sites)** | **Deviation: Prism publishes per tag** | The existing Publishing studio is tag-based and audited. NP-CO-08 gates the entry point, not per-page publishing. | 1.x |
| **Web clipper and iOS share extension** | **Deferred** | A separate native target and review. It doesn't block the first TestFlight build. | WP5 follow-up |
| **Analytics, verified pages, page owners, SAML/SCIM, billing, guest seats** | **Excluded** | These are enterprise/admin features with no personal-knowledge value. | No |
| **Notion Mail and Notion Calendar** | **Outside parity** | Prism's own Messages and Calendar are governed by MESSAGES.md and boards 07–10 and 22. | — |
| **Markdown `>` = toggle (Notion)** | **Deliberate deviation.** `>` stays a quote, because notes are stored as Markdown. Toggle is `/toggle` or `>>` + space. | Keeps vault Markdown and other editors consistent. | No |

---

## 2. The checklist

Unless a row says otherwise, "desktop" means the web PWA and the Prism Client at 1440×900, and "phone" means 390×844 in the PWA and the iOS app. "Backend" names the server contract the item needs, or "—" when it needs none.

### 2.1 Sidebar and workspace navigation (NP-SB)

| ID | Acceptance criteria (user-observable) | Verify | Backend | Status |
|---|---|---|---|---|
| NP-SB-01 | The vault switcher sits at the top of the sidebar and shows the current vault name. Opening it lists every accessible vault plus "Manage vaults". Switching reloads the tree, favorites, recents and search scope with no data from the previous vault. Phone: the same control at the top of the Browse drawer. | F `navigation.spec.ts`, `workspace-session.spec.ts` (existing); S 01, 14 | — | needs-screenshot |
| NP-SB-02 | Search is a sidebar row, and ⌘K / Ctrl+K opens quick find from anywhere, including while typing in the editor. Esc returns focus to the caret. | F `search.spec.ts` (existing); S 11 | — | needs-screenshot |
| NP-SB-03 | **Home** is a landing page with recently visited pages, upcoming calendar events, my open tasks and unread updates. It is the default on launch when "Start with last open document" is off. | F new `notion-home.spec.ts › "home shows recents, upcoming events, my tasks"`; S Notion | — (existing note, calendar and task reads) | needs-screenshot |
| NP-SB-04 | **Favorites** is always visible. When empty it shows "Star a page to pin it here". Pages can be starred from the header, the tree ⋯ menu and ⌘K. Favorites can be reordered by drag or keyboard and are **synced across devices**. | F `pages-nav.spec.ts › "favorites and recents sync through the server…"` + new `"favorites reorder by drag and keyboard"`; S 01, 14 | `GET/PUT /api/me/preferences` (on the branch) | needs-screenshot |
| NP-SB-05 | **Recents** are synced across devices and capped at 12. They appear in a collapsible sidebar section and as the empty state of ⌘K. | F `pages-nav.spec.ts › "⌘K lists recent pages first…"` | same | passed |
| NP-SB-06 | The tree shows **pages**, not only folders, each with its icon. A page with sub-pages has a disclosure. Expansion state persists per device. Desktop and phone render the same tree. | F `pages-nav.spec.ts › "a page with sub-pages is one node…"`; S 01, 14 | `GET /api/tree` (exists) | needs-screenshot |
| NP-SB-07 | Hovering a tree row shows `+` (add a page inside) and `⋯` (Favorite, Duplicate, Copy link, Rename, Move to, Open in new tab, Move to Trash). Touch: the row ⋯ button or a long-press opens the same actions as a sheet. | F `pages-nav.spec.ts › "phone: the drawer tree offers page actions in a sheet…"` + new `"tree row hover + and ⋯"` | — | passed |
| NP-SB-08 | Drag and drop in the tree reorders siblings and reparents, with a visible drop line and target highlight. Keyboard alternative: Move to… The order persists on every device. | F `pages-nav.spec.ts › "drag and drop reparents a page and reorders siblings"` | `POST /api/notes/:id/move` (on the branch) | passed |
| NP-SB-09 | A **"Shared with me"** section lists pages other people shared with a non-owner. A guest sees only that section and never sees workspace structure they can't view. | F new `notion-sharing.spec.ts › "guest sidebar shows only shared pages"` | `GET /api/shared-with-me` | passed |
| NP-SB-10 | A **Trash** entry opens a Trash view with search, Restore and Delete permanently (confirmed), plus a retention notice. Deleting anywhere shows an Undo toast. | F `pages-nav.spec.ts › "Trash: delete moves to Trash with Undo…"` | `/api/notes/:id/trash`, `/api/trash*` (on the branch) | passed |
| NP-SB-11 | The sidebar collapses with ⌘\ and resizes by drag. Width and collapsed state persist. | F `navigation.spec.ts` (existing) + new `notion-sidebar.spec.ts › "⌘\\ collapses and width persists"` | — | passed |
| NP-SB-12 | When the sidebar is collapsed, hovering the left edge reveals it as a floating overlay, which dismisses on mouse-out or Esc. | F new `notion-sidebar.spec.ts › "collapsed sidebar peeks on edge hover"`; S Notion | — | needs-screenshot |
| NP-SB-13 | **New page** in one action: the sidebar button, ⌘N, or `+` on a tree row creates an "Untitled" page in the current context with the title focused, in under 300 ms. A type or folder choice may be offered but is never required before typing. | F `page-creation.spec.ts`, `creation-entrypoints.spec.ts` (existing) + new `"one action → focused untitled page"`; S 14 (New page) | — | needs-screenshot |
| NP-SB-14 | The Tools section (Calendar, Map, Network, Agent activity, Dashboards…) is collapsible and every tool stays reachable. | F `navigation.spec.ts` (existing); S 14 | — | needs-screenshot |
| NP-SB-15 | The sidebar footer shows a sync state ("Synced", "Saving…", "Offline · saved on this device", "Waiting for server") and Settings. The state is truthful (see NP-OF-01). | F new `notion-sync-state.spec.ts › "footer reflects sync state"`; S 01, 16 | — | needs-screenshot |

### 2.2 Page chrome (NP-PG)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-PG-01 | **Icon.** Add, change or remove an emoji icon with a searchable picker. The icon then appears in the tree, tabs, breadcrumbs, ⌘K results, link chips and favorites. | F `document-polish.spec.ts` (existing) + new `notion-page.spec.ts › "icon propagates to tree, tabs, ⌘K"`; S 01, 14 | — | needs-screenshot |
| NP-PG-02 | **Cover.** Add a cover from presets, upload or link. Reposition by drag, then Change / Remove. It renders cropped and responsive on phone and in dark mode. | F new `notion-page.spec.ts › "cover add, reposition, remove"`; S Notion; D | Attachments upload + `GET /api/attachments/:id` | needs-device |
| NP-PG-03 | **Title.** Large and editable, with an "Untitled" placeholder. Enter moves into the body. A rename shows live in the tree, tabs and breadcrumbs, and a collab title edit syncs to other clients. | F `document-polish.spec.ts`, `saved-note-handoff.spec.ts` (existing); S 01 | — | partial |
| NP-PG-04 | **Breadcrumbs** show the full ancestor trail. Each crumb opens its page, and long trails collapse into a "…" menu. | F `pages-nav.spec.ts › "breadcrumbs open parent pages…"`; S 01, 13 | — | needs-screenshot |
| NP-PG-05 | **Typed properties under the title.** Schema-driven editors (select, status, date, person, relation, checkbox, URL, number). 3–5 pinned values, the rest behind "+ Add property". The tag picker is a searchable checklist. Viewers see values without edit affordances. | F `page-properties.spec.ts` (all six tests, branch); S 12 | `GET /api/schemas`, `POST /api/properties/:id` (on the branch) | needs-screenshot |
| NP-PG-06 | **Header bar** shows breadcrumb, save state ("Saved" ✓ / "Saving…" / "Offline"), labelled **Share**, labelled **Agent** with an activity dot, presence avatars (NP-CO-11), a favorite star and ⋯. It stays one quiet row. Phone: title, save dot, ⋯. | F new `notion-page.spec.ts › "header carries save state, Share, Agent, ⋯"`; S 01, 12, 18, 14 | — | needs-screenshot |
| NP-PG-07 | **Page ⋯ menu** contains Favorite, Copy link, Duplicate, Move to…, Lock page, Version history, Export, Move to Trash, Open in new tab, and the style options (PG-08). Integration-owned pages disable Move and Trash and say why. | F `pages-nav.spec.ts › "page ⋯ menu: favorite, duplicate, copy link, lock, export and history"`, `"integration-owned pages can't be moved or trashed…"` | — | passed |
| NP-PG-08 | **Per-page style.** Font (Default / Serif / Mono), **Small text** and **Full width**, stored on the page and honoured on every device and in collab. These are separate from the global reading-font preference. | F new `notion-page.spec.ts › "full width, small text, font persist per page"`; S 15, Notion | — (page metadata) | needs-screenshot |
| NP-PG-09 | **Lock page.** A locked page refuses edits for everyone, including the owner, until unlocked. A banner explains it with an Unlock action, and agents in Read-write mode are refused for that page. | F `pages-nav.spec.ts › "page ⋯ menu…lock…"` + new `"locked page refuses agent writes"` | Server-side honouring of `prism_locked` for agent/MCP writes | partial |
| NP-PG-10 | **Backlinks** appear as an "N backlinks" pill under the title. It opens a list with snippets, and each item opens its page. A page with no backlinks hides the pill. | F new `notion-page.spec.ts › "backlinks pill lists linking pages"`; S 12 | — (links API exists) | needs-screenshot |
| NP-PG-11 | **Outline panel** for long pages: the heading list highlights the current section and clicking a heading scrolls to it. Toggling the panel preserves selection and scroll. | F `document-polish.spec.ts` (outline cases, existing); S 01 | — | needs-screenshot |
| NP-PG-12 | **Version history.** A day-grouped list, preview, compare against current or previous, and Restore with a consequence line ("your previous version stays in history"). Pending autosaves are flushed first. Phone: readable full-width compare. | F `context-history.spec.ts` (existing); S 13 | — | needs-screenshot |
| NP-PG-13 | **Version attribution.** Each version names who made it: you, another person, "Agent revision" or "Accepted suggestion". | F new `notion-history.spec.ts › "versions name their author kind"`; S 13 | Writer stamp `prism_last_writer` on agent and suggestion writes | needs-screenshot |
| NP-PG-14 | **Empty-page starters.** An empty page offers Empty, Template, Import and Ask agent. They disappear as soon as the user types. | F new `notion-page.spec.ts › "empty page starters vanish on typing"`; S 16 (Empty document) | — | needs-screenshot |
| NP-PG-15 | **Sub-pages in the body.** "Add a page inside" (tree `+`, slash `/page`) creates the child and inserts a page-link block in the parent at the caret. Deleting that block offers to move the child to Trash. | F `pages-nav.spec.ts › "…adds a page inside"` + new `"child page block appears in parent body"` | — | passed |
| NP-PG-16 | **Copy link** gives a URL that opens the same page on another device and in the iOS app (see NP-NA-04), and respects access. | F `pages-nav.spec.ts › "page ⋯ menu…copy link…"` + new deep-link test; D | — | needs-device |
| NP-PG-17 | **Page info.** The ⋯ menu footer shows word and character count, created time, last edited time and last editor. | F new `notion-page.spec.ts › "page info footer"` | Writer stamp (as NP-PG-13) for "last edited by" | passed |

### 2.3 Editor and blocks (NP-ED)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-ED-01 | Hovering any block shows `⋮⋮` and `+`. Dragging `⋮⋮` moves the block, including a multi-block selection, with a drop line, and saves as one undo step. This works in plain and live collab editors. Read-only shows no handles. | F `editor-blocks.spec.ts › "hovering a block shows + and ⋮⋮…"`, `"live collaborative editor: a block move reaches the other client…"`, `"read-only documents show no block handles"` | — | passed |
| NP-ED-02 | The **block menu** (click ⋮⋮) has Turn into (every type), Color (text and background), Duplicate, Copy, Move to (another page), Comment, Ask agent and Delete. It is keyboard-first and has a search field. | F `editor-blocks.spec.ts › "the block menu turns blocks into every kind…"` + new `"block menu Move to another page"` | — (Move to another page uses the existing note PATCH) | passed |
| NP-ED-03 | The **slash menu** is grouped (Basic, Media, Database, Advanced, Agent), fuzzy-ranked, shows shortcut and Markdown hints, works as a keyboard listbox, filters as you type and closes on Esc or a space after no match. Phone: fits the screen with large targets. | F `editor-slash.spec.ts` (all six tests, branch); S 01, 14 | — | needs-screenshot |
| NP-ED-04 | **Markdown shortcuts:** `#`/`##`/`###`, `-`/`*`/`+`, `1.`, `[]`, `>` (quote, see §1.3), `>>` (toggle), ```` ``` ````, `---`, `**b**`, `*i*`, `` `c` ``, `~~s~~`, and `[[`. Each converts on typing, and ⌘Z restores the literal characters. | F new `notion-editor.spec.ts › "markdown shortcuts convert and undo to literal"` | — | passed |
| NP-ED-05 | **Inline format shortcuts:** ⌘B, ⌘I, ⌘U, ⌘⇧S (strike), ⌘E (code), ⌘K (link), ⌘⇧H (highlight / last colour). Windows/Linux use the Ctrl equivalents. None conflict with browser or native-app menus. | F `editor-toolbar.spec.ts › "bold, italic, underline, strikethrough and code toggle…"` + new `"⌘K link, ⌘⇧H highlight"` | — | passed |
| NP-ED-06 | **Block keyboard:** Esc selects the current block; ↑/↓ moves the block selection; **⌘⇧↑/↓ (Notion)** and Alt+⇧↑/↓ move a block; ⌘D duplicates; ⌘/ opens Turn into; ⌘↵ toggles a to-do or toggle; Tab / ⇧Tab nest and un-nest; Backspace on a selected block deletes it. | F `editor-blocks.spec.ts › "Alt/Option+Shift+↑/↓ moves the current block…"` + new `"⌘⇧↑↓, ⌘D, ⌘/, Esc block selection"` | — | passed |
| NP-ED-07 | A **keyboard shortcuts sheet** (⌘/ outside a block, or Help → Shortcuts) lists every editor, navigation and database shortcut for the current platform. | F `shortcuts.spec.ts` (existing, extend) + new `"shortcut sheet lists editor shortcuts"` | — | passed |
| NP-ED-08 | **Text blocks:** paragraph, H1–H3, toggle headings H1–H3, bulleted, numbered (continues numbering), to-do (checked style), toggle list (open state stored), quote, divider, callout (icon + colour). Nested children work under every list and toggle. *Owner decision 2026-10-08 (c.3): a toggle's open / closed state is per viewer and is not stored.* | F `editor-slash.spec.ts › "every slash block inserts the node it names…"`, `"a collapsed toggle hides its body…"` + new `"toggle headings"` | — | partial |
| NP-ED-09 | **Columns:** 2–5 columns from slash, **and** by dragging a block to the left or right edge of another. Columns resize by dragging the gutter and stack on phone. | F `editor-slash.spec.ts › "phones: …columns stack"` + new `"drag block to side creates columns"` | — | passed |
| NP-ED-10 | **Simple table:** add or remove rows and columns, header row and column, column resize, Tab to the next cell, cell background colour. Phone: horizontal scroll inside the block without page overflow. | F `editor-table.spec.ts` (three tests, branch) | — | passed |
| NP-ED-11 | **Code block:** searchable language picker, syntax highlighting in both themes, Copy button, wrap toggle; Tab indents inside the block. | F new `notion-editor.spec.ts › "code block language picker, copy, wrap"` | — | passed |
| NP-ED-12 | **Images:** paste, drop, upload or URL. Resize by drag, align, caption, and open full-screen on click or tap. Uploaded images render in the PWA, the iOS app (CSP-safe), publishing and export. | F `editor-upload.spec.ts` (five tests, branch) + new `"image resize, caption, lightbox"`; D | `POST /api/notes/:id/attachments`, `GET /api/attachments/:id` (the branch has only the client seam) | needs-device |
| NP-ED-13 | **Files and media blocks:** any file (shows name and size, then downloads), inline PDF preview, audio and video players. Native drag-drop from Finder or Files creates them. | F new `notion-media.spec.ts › "file, pdf, audio, video blocks"`; D | Attachments as in ED-12, with type and size caps and a view check | needs-device |
| NP-ED-14 | **Paste a URL** offers a menu: Mention, URL or Bookmark (and Embed when supported). A bookmark card shows title, description, favicon and image. | F new `notion-media.spec.ts › "pasted URL offers bookmark card"` | `GET /api/unfurl?u=` behind the media-proxy netguard | passed |
| NP-ED-15 | **Embeds:** YouTube, Vimeo, Figma, Google Maps/Docs/Sheets, Loom, tweets, plus a generic allowlisted iframe with a resize handle. Unsupported or blocked origins fall back to a bookmark card, never a blank frame. Works in the iOS app. *Owner decision 2026-10-08 (c.7): in the iOS and Mac apps YouTube (no-cookie) and Vimeo play in the page; every other provider is an "Open in …" card there. The web plays all of them.* | F new `notion-media.spec.ts › "allowlisted embeds render; others fall back"`; D | An embed allowlist and native CSP `frame-src` decision (security review) | needs-device |
| NP-ED-16 | **Colours:** text and background colour per block and inline, from the token palette, with dark-mode equivalents. Not colour-only: the meaning stays legible. | F `editor-toolbar.spec.ts › "text colour and highlight come from the token palette"` | — | partial |
| NP-ED-17 | **Selection toolbar** shows Turn into, B/I/U/S/code, Link, Colour, Comment, Ask agent and Mention. It keeps away from the viewport edge and the iOS callout menu and uses 44 px targets on phone. | F `editor-toolbar.spec.ts` (seven tests, branch); S desktop-collaboration, 01 | — | needs-screenshot |
| NP-ED-18 | **Links:** an inline ⌘K editor validates the URL. Pasting a URL over a selection links it. Hovering a link shows the URL with Open, Edit and Remove. Pasting an internal Prism URL becomes a page mention. | F `editor-toolbar.spec.ts › "links are typed inline, validated…"` + new `"paste URL over selection; internal URL → mention"` | — | passed |
| NP-ED-19 | **Table of contents block** (`/toc`) lists the page's headings, updates live and scrolls to the heading on click. | F new `notion-editor.spec.ts › "toc block tracks headings"` | — | passed |
| NP-ED-20 | **Undo/redo** (⌘Z, ⌘⇧Z) covers typing, block moves, turn-into, colour, table edits and deletes, in plain and collab editors. In collab, undo reverts only your own changes. | F new `notion-editor.spec.ts › "undo covers block ops; collab undo is per-user"` | — | passed |
| NP-ED-21 | **Copy and paste fidelity.** Paste from Notion, Google Docs, Word, a web page and Markdown keeps headings, lists, to-dos, links, tables, code and images. Copying out gives rich text and Markdown. Wikilinks survive. | F `wikilinks.spec.ts` (existing) + new `notion-editor.spec.ts › "paste fidelity from Notion/GDocs/Markdown"` | — | passed |
| NP-ED-22 | **Find in page** (⌘F) shows a match count and next/previous, with matches highlighted. Phone: reachable from ⋯. | F new `notion-editor.spec.ts › "find in page counts and steps"` | — | passed |
| NP-ED-23 | **Replace / Replace all** in the find bar, as a single undo step, respecting read-only. | F new `notion-editor.spec.ts › "replace and replace all"` | — | passed |
| NP-ED-24 | **Round-trip.** Every block type in ED-08…ED-19 survives save → reload, two live clients, vault Markdown/HTML storage, an agent MCP edit (`prism_update_note`), the publishing render and export. Unsupported content is preserved, never dropped. | F `editor-table.spec.ts › "live editor: tables, callouts, toggles and columns reach the other client intact"` + server `editor-blocks.test.ts` + new `"block round-trip through publish and export"` | — | partial |
| NP-ED-25 | **Placeholders.** "Type '/' for commands" on the focused empty line, heading-level placeholders, and an empty list item hint. A focused editor draws no box around the document. | F `editor-regressions.spec.ts › "a focused editor does not draw a box…"` (branch) | — | passed |

### 2.4 Inline references: links, mentions, dates and reminders (NP-RF)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-RF-01 | **`[[` page link** autocompletes titles with icon and path. "Create page '<query>'" makes the page and links it. Ambiguous names prompt a choice. | F `wikilinks.spec.ts` (existing) + new `"[[ create page from query"` | — | passed |
| NP-RF-02 | **`@` menu** offers People, Pages and Dates ("today", "tomorrow", "next Monday", ISO dates) and "Remind me…". It doesn't open mid-IME-composition or inside an email address. | F new `notion-mentions.spec.ts › "@ menu offers people, pages, dates"` | `GET /api/people?q=` (exists) | passed |
| NP-RF-03 | A **person mention** renders as a chip; hovering shows name and linked identities, and clicking opens the People profile. Mentioning someone with an account notifies them (NP-CO-04). | F new `notion-mentions.spec.ts › "person mention hover card + notifies"`; S 09 (identity card) | Mention extraction on store, then notifications | needs-screenshot |
| NP-RF-04 | A **page mention** shows the live title and icon (it updates on rename), a preview on hover, and a clear "no access / deleted" state. | F new `notion-mentions.spec.ts › "page mention tracks rename; no-access state"` | — | passed |
| NP-RF-05 | A **date mention** is an inline chip edited with a date and time picker. It reads relatively ("Tomorrow 9:00") and is timezone-correct. | F new `notion-mentions.spec.ts › "date chip edit and relative display"` | — | passed |
| NP-RF-06 | **Reminders.** "Remind me" on a date chip fires at that time as push (APNs or web push) plus an Inbox item. Tapping it opens the page scrolled to the block. Reminders can be cancelled and edited. | F new `notion-mentions.spec.ts › "reminder lands in inbox at time"` (fake clock); D (push) | `POST/DELETE /api/reminders`, worker delivery, push fan-out | needs-device |
| NP-RF-07 | **Mentions create backlinks:** a page or person mention adds a vault link, so it appears in the target's backlinks (NP-PG-10). | F new `notion-mentions.spec.ts › "mention appears in target backlinks"` | — (vault links) | passed |

### 2.5 Databases (NP-DB)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-DB-01 | **Create a database** as a full page (New page menu, slash "Database – full page") or from an existing tag ("Open as database"). It starts as a Table view over that tag. | F `databases.spec.ts › "adding a view and opening a row"` + new `"create database from New page and from tag"` | `/api/schemas`, `/api/query` (on the branch) | passed |
| NP-DB-02 | **Inline and linked database blocks.** `/table view`, `/board view`… embeds a database view inside a page, either a new database or a linked view of an existing one. Each view has its own filter and sort. | F new `notion-db-inline.spec.ts › "inline linked board inside a page"` | `/api/query` | passed |
| NP-DB-03 | **Table view.** Typed cells edit in place. Keyboard navigation uses arrows, Enter, Esc and Tab. "+ New" adds a row at the bottom. Columns resize, reorder and hide; the first column freezes; a row count shows. Conflicts are recoverable. | F `databases.spec.ts › "table: typed cells edit in place…"`, `"table: filter, header sort, hide and resize…"` + new `"column reorder and cell keyboard nav"` | `POST /api/properties/:id` | passed |
| NP-DB-04 | **Board view.** Group by select, status or person. Each column has "+ New" (created in that group). Drag works within and between columns. Empty groups can be hidden. Cards show chosen properties with a ⋯ menu (Open, Move to…, Move earlier/later). | F `databases.spec.ts › "board: move by menu and by drag…"`, `"new rows are created with…the group they were added to"`; S 20 | — | needs-screenshot |
| NP-DB-05 | **Gallery view.** Cards show a cover (page cover or first image), size S/M/L and chosen properties. | F `databases.spec.ts › "gallery, list and calendar render the same rows…"` + new `"gallery card size and cover"` | Attachments for covers (NP-PG-02) | passed |
| NP-DB-06 | **List view**: compact rows with chosen properties. | F `databases.spec.ts › "gallery, list and calendar…"` | — | passed |
| NP-DB-07 | **Calendar view** on any date property. Add on a day, drag to reschedule, navigate months. Multi-day items span as one bar. | F `databases.spec.ts › "…calendar adds on a day"` + new `"calendar drag reschedule and multi-day span"` | — | passed |
| NP-DB-08 | **Core property types** work as editors, filters and sorts: text, number (with format), select, multi-select, status (groups), date (range and time), person, relation, checkbox and URL. | F `databases.spec.ts`, `page-properties.spec.ts` (branch) | `/api/schemas` | passed |
| NP-DB-09 | **Further property types:** email, phone, and files & media (upload, preview). | F new `notion-db-props.spec.ts › "email, phone, files properties"` | Attachments for files | passed |
| NP-DB-10 | **System properties:** Created time, Last edited time, Created by and Last edited by. They are read-only, sortable and filterable. | F new `notion-db-props.spec.ts › "system properties sort and filter"` | Created by = `prism_creator`; "last edited by" needs the writer stamp | passed |
| NP-DB-11 | **Property management** (owner/admin): add a property (name + type), rename it, change type with a conversion preview, edit select options (rename, colour, reorder), and delete with explicit data handling. Non-owners see no schema controls. *Owner decision 2026-10-08 (c.4): a type conversion stays refused on tags an integration writes (`task`, `person`, `meeting`, `email`, …).* | F `page-properties.spec.ts › "owner adds a typed property and a new option…"` + new `"rename, retype with preview, delete property"` | `PUT /api/schemas/:tag` (on the branch) | passed |
| NP-DB-12 | **Relation** picker searches the target database and shows related pages as chips that open them. An optional reverse property appears on the target. | F new `notion-db-props.spec.ts › "relation picker and reverse property"` | Reverse write must use CAS on both notes | passed |
| NP-DB-13 | **Filters.** Operators match the type (is / is not / contains / before / after / is empty…). Simple filter chips plus advanced AND/OR groups, saved per view. | F `databases.spec.ts › "table: filter, header sort…"` + new `"AND/OR filter groups"` | `/api/query` filter grammar | passed |
| NP-DB-14 | **Sorts:** multi-level sort from the header or the sort menu, saved per view. | F `databases.spec.ts › "table: filter, header sort…"` + new `"multi-level sort"` | `/api/query` | passed |
| NP-DB-15 | **Group by** in table and list: collapsible groups with counts, and "+ New" in a group. | F new `notion-db-views.spec.ts › "table group by with counts"` | — | passed |
| NP-DB-16 | **Saved views** are tabs that can be added, renamed, duplicated, deleted and reordered. Each keeps its own type, filter, sort, group and visible properties, stored in the database note. Viewers change views for their session only, without saving. | F `databases.spec.ts › "adding a view and opening a row"`, `"viewer: …session-only view changes"` | — | passed |
| NP-DB-17 | **Search within a database** filters rows live by title and text properties. | F new `notion-db-views.spec.ts › "database search box"` | `/api/query` text match | passed |
| NP-DB-18 | **Open a row** as a side peek (desktop default), center peek or full page, with a per-database preference. The peek edits properties and body. ⌘-click opens the full page. Phone always opens a full page. Esc closes the peek and keeps the scroll position. | F new `notion-db-views.spec.ts › "side peek, center peek, full page"`; S Notion | — | needs-screenshot |
| NP-DB-19 | **Database templates:** per-database page templates, a default template, and a template picker on "+ New ▾". A new row gets the template body and properties. | F new `notion-db-views.spec.ts › "database template applies on new row"` | — | passed |
| NP-DB-20 | **Rows are pages.** Every row opens as a normal page with its properties under the title (NP-PG-05) and the body editable. Renaming the row updates the view. | F `databases.spec.ts › "adding a view and opening a row"` | — | partial |
| NP-DB-21 | **Bulk actions.** Multi-select rows by checkbox, shift-click or ⌘A. Then bulk-edit a property, duplicate, or move to Trash, with one Undo. | F new `notion-db-views.spec.ts › "bulk edit and bulk trash with undo"` | Batched CAS writes | passed |
| NP-DB-22 | **Permissions.** Viewers get read-only cells. Private rows are hidden and an honest "limited results" note shows. Non-owners can't change the schema. | F `databases.spec.ts › "viewer: read-only cells, hidden private rows…"` | — | passed |
| NP-DB-23 | **Phone.** Tables have a sticky first column and no page overflow. Filters open in a sheet. Boards default to list. Rows open full-page. | F `databases.spec.ts › "phone: sticky first column…"`; S 20 (phone) | — | needs-screenshot |
| NP-DB-24 | **Existing task boards keep parity:** per-column "+ Add task", card ⋯ menu (Open, Move to, earlier/later), due-date chips, manual order. Columns never bleed off-screen without a scroll affordance. These boards open in, or are superseded by, the database board without data loss. | F `boards.spec.ts` (existing) + new `"per-column add, card menu, due chips"`; S 20 | — | needs-screenshot |
| NP-DB-25 | **CSV.** Import a CSV into a new or existing database with a column-to-property mapping preview and dry run. Export any view to CSV. | F new `notion-db-csv.spec.ts › "csv import preview and export"` | `POST /api/import/csv` (owner, dry-run first), or client-side batch create | passed |

### 2.6 Collaboration, sharing and notifications (NP-CO)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-CO-01 | **Inline comments.** Select text → Comment opens a thread in the margin (desktop) or a sheet (phone). Reply, edit own, delete own, resolve and reopen. "Show resolved" lists resolved threads. @mentions work inside comments. | F `suggestions.spec.ts`, `editor-toolbar.spec.ts › "live editor: the toolbar carries Comment…"` + new `"comment mention, edit own, reopen"`; S desktop-collaboration | Mentions depend on NP-RF-03 | needs-screenshot |
| NP-CO-02 | **Page-level comments**: a discussion at the top of the page, not anchored to text, with the same thread actions. | F new `notion-comments.spec.ts › "page-level discussion"` | Unanchored threads in the collab `comments` map and command endpoint | passed |
| NP-CO-03 | **Comment and mention inbox.** "Inbox" shows mentions, replies to my threads, pages shared with me, accepted or rejected suggestions and reminders. It has an unread badge in the sidebar and phone bottom bar, mark read / mark all read, and deep links to the block. | F new `notion-inbox.spec.ts › "inbox lists mentions, replies, shares; mark read"`; S Notion | `GET /api/notifications`, `POST /api/notifications/:id/read`, `GET /api/comments?mine=1&unresolved=1` | partial |
| NP-CO-04 | **Notification delivery** sends push (APNs on iOS, web push on the PWA) and, for inactive users, email. Per-type settings exist. The payload carries ids only. | F new `notion-inbox.spec.ts › "notification settings respected"`; D | Notification fan-out reusing `push.ts`/`apns.ts`/`email.ts` | needs-device |
| NP-CO-05 | **Share dialog, People tab.** Invite by email with a level (Full access / Can edit / Can suggest / Can comment / Can view). The people list shows **names and avatars**, the Owner row and level menus. Change or remove access, with partial-failure messages. | F `sharing.spec.ts`, `workspace-access.spec.ts` (existing); S 23 | `displayName` per grantee in `/acl/notes/:id` | needs-screenshot |
| NP-CO-06 | **Share dialog, link access.** Restricted vs anyone-with-link (view, comment or edit), Copy link with a manual-copy fallback, and revoke. A guest invite creates an account. | F `sharing.spec.ts` (existing); S 23 | — | needs-screenshot |
| NP-CO-07 | **Share dialog styling:** underline tabs (People · Link access · Publish), and a phone sheet layout matching board 23. | S 23 | — | needs-screenshot |
| NP-CO-08 | **Publish** is reachable from Share. It explains that publishing is per tag, previews, and publishes or unpublishes through the existing studio. | F `publishing-studio.spec.ts` (existing); S 23, 24 | — | needs-screenshot |
| NP-CO-09 | **Inherited access.** Sharing a page shares its sub-pages. The dialog shows "Inherited from <parent>", and a child can be restricted or expanded explicitly. Moving a page out changes its inherited access, with a warning. | F new `notion-sharing.spec.ts › "sub-pages inherit and show source"` | Path-prefix (page-subtree) grants in `permissions.ts`, honoured by tree, events, collab, MCP | passed |
| NP-CO-10 | **Live carets** with name tags for every collaborator in collab documents, colour-distinct from agent identity. | F `collab-route.spec.ts` (existing) + new `"remote caret name tags"` | — | partial |
| NP-CO-11 | **Presence avatars** of the people on the page appear in the header. Clicking one jumps to that person's caret. Phone shows a compact count. | F new `notion-presence.spec.ts › "header avatars and jump to cursor"`; S 03, 15, 18 | — (awareness exists) | needs-screenshot |
| NP-CO-12 | **Suggested edits.** A Suggesting mode marks inserts and deletes with attribution. Accept or reject one at a time with previous/next, or all; Undo after accept; a stale suggestion shows "Needs refresh". A **suggest-level human cannot type a direct edit.** | F `suggestion-review.spec.ts`, `human-command-helpers.spec.ts` (existing) + new `"suggest-only human cannot edit directly"`; S 06 | Human command client activation, then `COLLAB_SUGGEST_ENFORCED=true` | partial |
| NP-CO-13 | **Request access** on a no-access or read-only page. The owner gets a notification and can approve (choosing a level) or deny. | F new `notion-sharing.spec.ts › "request access → owner approves"`; S 16 (Read-only page) | `POST /api/access-requests`, `GET/POST /acl/access-requests` | needs-screenshot |
| NP-CO-14 | **Guests** see only what was shared with them, everywhere: sidebar, ⌘K, backlinks, mentions, inbox and databases. | F `isolation.spec.ts` (existing) + new `"guest sees only shared content everywhere"` | `GET /api/shared-with-me` | passed |
| NP-CO-15 | **Page activity:** an "Updates" view per page combining edits (with author kind), comments, shares and accepted suggestions. | F new `notion-history.spec.ts › "page updates feed"`; S 13 | Writer stamp, comment index | needs-screenshot |

### 2.7 Search and ⌘K (NP-SR)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-SR-01 | ⌘K opens in under 100 ms and shows **recent pages** before typing. ↑/↓ navigate, ↵ opens, ⌘↵ opens in a new tab and Esc closes. Results show icon, title, breadcrumb and edited date. | F `pages-nav.spec.ts › "⌘K lists recent pages first…"`, `search.spec.ts`; S 11 | `/api/me/preferences` | needs-screenshot |
| NP-SR-02 | Results group by kind (Notes, Messages, Commands) with All/Notes/Messages/Commands chips. Open and "Add to context" are separate actions. | F `search.spec.ts`, `saved-context` config (existing); S 11 | — | needs-screenshot |
| NP-SR-03 | **Matched terms are highlighted** in titles and snippets. | F new `notion-search.spec.ts › "match highlighting"`; S 11 | Optional match offsets from `/api/search` | needs-screenshot |
| NP-SR-04 | **Search filters:** title only, type, vault scope ("Personal vault ▾"), created/edited by, date range. | F new `notion-search.spec.ts › "filters narrow results"`; S 11 | `/api/search` parameters | needs-screenshot |
| NP-SR-05 | Semantic and full-text results are blended. A non-primary vault silently and honestly falls back to full-text. | F `search.spec.ts` (existing) | — | passed |
| NP-SR-06 | **Commands:** New page, New from template, Open Trash, Toggle theme, Go to settings, Open Inbox, Ask agent. Each has an icon and its shortcut hint. | F `pages-nav.spec.ts › "…the palette opens the Trash and templates"` | — | passed |
| NP-SR-07 | Back and forward (⌘[ / ⌘], phone back) walk visited pages and restore scroll position. | F `open-documents.spec.ts` (existing) + new `"back/forward restores scroll"` | — | passed |
| NP-SR-08 | **Phone search** is a full-screen Search tab with the keyboard up immediately, recent searches and pages, and 44 px rows. | F `mobile-navigation.spec.ts` (existing) + new `"phone search recents"`; S 08, 14; D | — | needs-device |

### 2.8 Templates, import and export (NP-TX)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-TX-01 | **Templates.** New page → From template copies the body, properties and tags. "Save as template" is in the page ⋯ menu. A Templates gallery lists, edits and deletes templates (notes tagged `template`). *Owner decision 2026-10-08 (c.16): someone else's template offers its tags as unticked boxes; they are never copied silently.* | F `pages-nav.spec.ts › "New page from template copies…"` + new `"save page as template"` | — | passed |
| NP-TX-02 | **Template variables:** `@today`, `@now` and the creator resolve when a page is created from the template. | F new `notion-templates.spec.ts › "date variables resolve on create"` | — | passed |
| NP-TX-03 | **Export a page** as Markdown, HTML or PDF, optionally including sub-pages and images. It works through a web download, the native export dialog and the iOS share sheet. | F `pages-nav.spec.ts › "page ⋯ menu…export…"` + new `"export with sub-pages and images"`; D | Zip assembly for sub-pages and attachments | needs-device |
| NP-TX-04 | **Export the whole vault** as a Markdown ZIP that preserves the tree, attachments and properties as front-matter. The owner sees progress. | F new `notion-export.spec.ts › "vault zip export"` | `POST /api/export` job with streamed ZIP | passed |
| NP-TX-05 | **Import Markdown or a Notion export ZIP.** A dry-run summary comes first. Then it preserves nesting, imports images, converts internal links to wikilinks and maps CSV databases to databases. | F new `notion-import.spec.ts › "notion zip dry run then import"` | `POST /api/import` (owner, dry-run default, idempotent), plus attachments | passed |
| NP-TX-06 | **Print (⌘P)** gives a clean page with no app chrome, readable in both themes' print output. | F new `notion-export.spec.ts › "print stylesheet hides chrome"` | — | passed |

### 2.9 Prism agent in place of Notion AI (NP-AI)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-AI-01 | **Ask agent** is available from slash, the selection toolbar, the block menu, the header Agent button and ⌘J. It opens the **same** document-bound session with the selection attached, and never a second chat. *Owner decision 2026-10-08 (c.15): for 1.0 the agent is for the server owner only.* | F `selection-agent.spec.ts`, `agent.spec.ts` (existing); S 01, 02, desktop-collaboration | — | needs-screenshot |
| NP-AI-02 | **Agent changes are reviewable:** in Suggested-edits mode, edits arrive as suggestions with previous/next, accept, dismiss and refresh-when-stale. In Read-write mode they appear as an attributed version. | F `suggestion-review.spec.ts`, `agent-states.spec.ts` (existing); S 06, desktop-review | — | partial |
| NP-AI-03 | **Summarize, draft and transform** a page or selection (the Notion AI equivalents) all work through the agent, with sources shown. *Owner decision 2026-10-08 (c.15): for 1.0 page AI actions are for the server owner only.* | F `agent-summary.spec.ts`, `reply-agent.spec.ts` (existing); S 02, 04 | — | needs-screenshot |

### 2.10 Phone app patterns (NP-MB)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-MB-01 | The **bottom bar** is labelled (Notes/Browse, Search, Inbox or Messages, Agent, More), shows the active state and hides while the keyboard is up. The reply composer owns the bottom edge in threads. | F `mobile-navigation.spec.ts` (existing); S 14, 08; D | — | needs-device |
| NP-MB-02 | **New page** is one tap from Browse or the bar's create affordance. It opens a focused title with the keyboard up and shows "Saved on this device" in the header. | F `page-creation.spec.ts` (existing) + new `"phone new page focuses title"`; S 14; D | — | needs-device |
| NP-MB-03 | The **page actions sheet** (header ⋯) has Favorite, Share, Copy link, Move, Lock, History, Find, Export, Trash and Agent, with 44 px rows. It is dismissed by drag handle, Esc or Close. | F `pages-nav.spec.ts › "phone: …the header ⋯ works"`; S 14; D | — | needs-device |
| NP-MB-04 | The **editing toolbar above the keyboard** has `+` insert block, Turn into, B/I/U/S, Link, To-do, indent/outdent, @ mention, image, undo/redo and dismiss keyboard. It sticks to `visualViewport` in the iOS app and Safari and never covers the caret. | F `editor-blocks.spec.ts › "phones: no hover affordance…"` + new `"keyboard toolbar complete"`; D (iOS keyboard, external keyboard) | — | needs-device |
| NP-MB-05 | **Block move on phone:** the caret's block gets a tap target that opens the block menu with Move up/down and Turn into, without accidental drag while scrolling. | F `editor-blocks.spec.ts › "phones: …tap target that opens the same menu"`; D | — | needs-device |
| NP-MB-06 | **Gestures:** swipe from the left edge goes back or opens the drawer; swipe on list rows for row actions (Messages: archive/read; Trash: restore); pull-to-refresh on lists. Every gesture has a visible button alternative. *Owner decision 2026-10-08 (c.12): on Messages rows only "mark read" is a swipe; archive is never a swipe.* | F new `notion-mobile.spec.ts › "edge swipe back; row swipe actions"` (touch emulation); D | — | needs-device |
| NP-MB-07 | The **Browse drawer** has the vault switcher, Favorites, Recents, the page tree with disclosure and row ⋯, Tools, Trash, New page and Settings. Rows are 44 px. | F `pages-nav.spec.ts › "phone: the drawer tree…"`, `mobile-navigation.spec.ts`; S 14 | — | needs-screenshot |
| NP-MB-08 | **Safe areas and keyboard.** No control sits under the notch or home indicator. The keyboard never covers the caret, composer or accept controls. Landscape works. Inputs are 16 px, so there is no zoom on focus. | F `responsive-companion.spec.ts`, `composer-growth.spec.ts` (existing); D (iPhone SE and 15/16 Pro Max, landscape) | — | needs-device |
| NP-MB-09 | **iOS text selection** shows native handles. The selection toolbar doesn't collide with the iOS callout menu. Long-press on a link previews it rather than navigating. | F `editor-toolbar.spec.ts › "phones: the toolbar stays on screen…"`; D | — | needs-device |
| NP-MB-10 | **Tablet** (iPad 1024×768 and 820×1180): sidebar persistent or overlay by width, pointer hover affordances work, and external-keyboard shortcuts match the desktop. | F new `notion-mobile.spec.ts › "tablet layouts"`; D (iPad) | — | needs-device |

### 2.11 Offline, sync and reliability (NP-OF)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-OF-01 | **Truthful sync state** in the desktop header and the phone header: Saved / Saving… / Offline · changes saved on this device / Waiting for server / Save failed · Retry. It is never "Saved" before the server confirms. | F `outbox.spec.ts`, `recovery.spec.ts` (existing) + new `"phone header sync state"`; S 14, 16 | — | needs-screenshot |
| NP-OF-02 | **Recently opened pages read offline** with an "Offline copy from <time>" label. Uncached pages show an honest unavailable state. | F `document-recovery.spec.ts` (existing) + new `"offline read of cached page"` (context.setOffline) | — | passed |
| NP-OF-03 | **Offline editing.** Typing offline in an open page is saved locally, survives an app kill or reload and syncs on reconnect. Collab pages merge through Yjs. Plain pages use CAS with a conflict choice. Text is never lost. | F `outbox.spec.ts`, `collab-storage.spec.ts` (existing); D (airplane mode, force-quit) | — | needs-device |
| NP-OF-04 | **Make available offline:** favorites and the last 20 pages are prefetched (Notion's 2025 offline pages), with a per-page "Available offline" toggle. | F new `notion-offline.spec.ts › "favorites readable offline after prefetch"`; D | — | needs-device |
| NP-OF-05 | **Live updates** from another device or the agent appear without reload within 2 s (SSE invalidation and the collab socket). The tree and databases update too. | F new `notion-live.spec.ts › "remote edit appears within 2s"` | `/api/events` (exists) | passed |
| NP-OF-06 | **Failed save keeps the draft** and offers retry. Signing out or switching account clears caches with no cross-account leakage. | F `recovery.spec.ts`, `isolation.spec.ts` (existing) | — | passed |

### 2.12 Accessibility, theming and motion (NP-AX)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-AX-01 | **Dark mode parity** on every surface: menus, slash, block menu, peeks, databases, comments, share, the companion panel, and the native launch screen. No white panels. Light/Dark/System setting. | F `editor-regressions.spec.ts › "the document companion stays dark…"` (branch) + new screenshot sweep; S 09, 15, desktop-review | — | partial |
| NP-AX-02 | **Keyboard-only** use reaches every action: tree, block menu, slash, database cells, share, history and inbox. Focus is visible, there are no traps, Esc closes and focus returns to the opener. | F new `notion-a11y.spec.ts › "keyboard-only journey: create, format, share, database edit"` | — | passed |
| NP-AX-03 | **Screen readers** (VoiceOver on macOS and iOS): icon buttons are labelled, the tree uses `tree`/`treeitem` with `aria-expanded`, menus use `menu`/`listbox` roles, and live regions announce save state and toasts. axe has 0 serious or critical violations on every fixture page. | F new `notion-a11y.spec.ts › "axe: no serious violations"` (@axe-core/playwright); D (VoiceOver) | — | needs-device |
| NP-AX-04 | **Contrast** meets WCAG AA in both themes. Colour is never the only signal: suggestion marks use strike and underline, and status has text. | F new `notion-a11y.spec.ts › "contrast tokens AA"` | — | partial |
| NP-AX-05 | At **200 % zoom and iOS Dynamic Type XXL**, no clipped controls and no horizontal page scroll. | F new `notion-a11y.spec.ts › "200% zoom no overflow"`; D | — | needs-device |
| NP-AX-06 | **Motion:** 120–180 ms opacity/translate transitions for menus, sheets and peeks, all disabled under `prefers-reduced-motion` and the in-app Reduce motion setting. | F new `notion-a11y.spec.ts › "reduced motion disables transitions"`; S 15 | — | needs-screenshot |
| NP-AX-07 | **Touch targets** are at least 44×44 px on phone, measured. | F new `notion-a11y.spec.ts › "touch targets ≥44px"` | — | passed |
| NP-AX-08 | **IME, dictation and autocorrect:** Japanese and Chinese composition, emoji and iOS dictation never trigger slash or @ menus mid-composition, never send early, and never double-insert. | F `agent-composer-growth.spec.ts` (existing IME cases) + new editor IME case; D | — | needs-device |

### 2.13 Native app (NP-NA)

| ID | Acceptance criteria | Verify | Backend | Status |
|---|---|---|---|---|
| NP-NA-01 | **Sign-in** through the system-browser PKCE sheet returns to the app. The device token lives in the Keychain. Sign-out revokes the token server-side and clears caches. | D; `cargo test` (client) | Device tokens (exist) | needs-device |
| NP-NA-02 | **Face ID / passcode lock** on launch and on resume after the configured idle time, with a passcode fallback and a settings toggle. Content is blurred in the app switcher. | D | — | needs-device |
| NP-NA-03 | **Push (APNs):** a permission prompt at a sensible moment, delivery in a TestFlight (production APNs) build, a tap that deep-links to the target, and opt-out. | D; server `test` for `apns.ts` | `/api/push/apns` (feat/backend-apns) | needs-device |
| NP-NA-04 | **Deep and universal links:** `https://<server>/…` page links and `prism://` open the right page in the app, and fall back to the web when the app isn't installed. | D; F new `notion-links.spec.ts › "page URL routes to page"` | AASA file served by the server | needs-device |
| NP-NA-05 | **Native feel:** app icon (light/dark/tinted) and launch screen, no rubber-band on app chrome, no selectable chrome text, no tap delay, status bar follows the theme, and external links open in an in-app browser sheet. | D; `verify-client.mjs` | — | needs-device |
| NP-NA-06 | **Background and resume** restores the page, scroll position and drafts, reconnects collab and SSE, and never duplicates a send or turn. | D | — | needs-device |
| NP-NA-07 | **macOS Prism Client:** menus and ⌘ shortcuts aren't swallowed by the webview, multiple windows, quick capture, and native export and drop. | D (Mac) | — | needs-device |

### 2.14 Performance budgets (NP-PF)

Measure on main's production build: the web PWA in Chromium on an M-series Mac, and the iOS app on an iPhone 13-class device. Use a vault of at least 14k notes; the real vault works for read-only timing. Record p50 and p95 over 20 runs.

| ID | Budget (p95 unless noted) | Method | Status |
|---|---|---|---|
| NP-PF-01 | Cold start to interactive editor: **≤ 2.0 s desktop (warm HTTP cache), ≤ 3.0 s iPhone** | Playwright trace `performance.mark`; Safari Web Inspector timeline on device | needs-device |
| NP-PF-02 | Open a page from tree or ⌘K: **≤ 300 ms cached, ≤ 1.0 s uncached** (50 KB page) | Playwright trace; P | partial |
| NP-PF-03 | Typing in a 10k-word, 200-block page: **no long task > 50 ms**, keystroke-to-paint ≤ 16 ms p50 | Chrome performance trace; Safari timeline on device | needs-device |
| NP-PF-04 | Sidebar tree of 14k notes renders in **≤ 500 ms** and scrolls at 60 fps (virtualised or lazily expanded) | Trace + FPS meter | partial |
| NP-PF-05 | ⌘K results: **≤ 150 ms** for titles/recents, **≤ 500 ms** for server full-text | Trace; P | partial |
| NP-PF-06 | Database with 5k rows: first paint **≤ 1.5 s**, filter or sort change **≤ 500 ms**, 60 fps scroll | `/api/query` timing + trace | partial |
| NP-PF-07 | iOS memory after 30 minutes and 50 page opens: **≤ 300 MB, no monotonic growth** | Xcode Instruments (Allocations) | needs-device |
| NP-PF-08 | Initial JS **≤ 600 KB gzip**; editor, database, canvas, graph and map chunks lazy | `vite build` report | passed |
| NP-PF-09 | Idle clients (3 tabs + iOS app, 30 min): no polling storm; server and vault CPU at baseline | `apps/server/scripts/measure-idle-clients.ts` | not-measured |

---

## 3. What remains after wave 1, ranked

**Wave 1** is the current set: `feat/ux-editor-blocks`, `feat/ux-databases`, `feat/ux-pages-nav`, `feat/native-ios` and `feat/backend-apns`. They must merge to main in this order, integrating in an isolated worktree each time:

1. `ux-editor-blocks`
2. `ux-databases`, which touches `DocumentRenderer.tsx` and `MetadataPanel`
3. `ux-pages-nav`, which touches `Navigation`, `ProjectTree`, `DocumentChrome`, `CommandBar`, `TabBar` and `api.ts`
4. the APNs and iOS branches

After that the groups below can run in parallel. Each group owns a distinct set of files. The shared hotspots are `Navigation.tsx`, `DocumentChrome.tsx`, the collab schema and `routes/api.ts`; each is assigned to exactly one group per wave, and the others go through that owner.

| Rank | Wave · group | Items | Owns (files) | Backend needs |
|---|---|---|---|---|
| 1 | **2A · Mentions, inbox and notifications** | RF-02…07, CO-01 (mentions), CO-03, CO-04, CO-13, SB-03 (Home) | new `lib/tiptap/Mention*.ts`, `components/inbox/*`, `components/home/*`; **owns `Navigation.tsx` in wave 2** | `notifications` table, `GET /api/notifications`, `POST …/read`; mention extraction at collab/vault store; `POST/DELETE /api/reminders` + worker; push/email fan-out (`push.ts`, `apns.ts`); `POST /api/access-requests` + owner review |
| 2 | **2B · Media, embeds and editor depth** | PG-02, ED-11…15, ED-19, ED-23, DB-05 (covers), DB-09 (files) | `editor/blocks.ts`, `lib/tiptap/*` (new nodes), `EditorFindBar.tsx`; **owns the collab schema and `DocumentChrome.tsx` (cover) in wave 2** | `POST /api/notes/:id/attachments`, `GET /api/attachments/:id` (caps, sniffing, view check, native-safe); `GET /api/unfurl` on the media netguard; embed allowlist + client CSP `frame-src` security review |
| 3 | **2C · Database depth** | DB-02, DB-09/10 UI, DB-12 reverse, DB-15, DB-17, DB-18, DB-19, DB-21, DB-24, DB-25 | `components/database/*`, `lib/database/*`, `TaskBoardRenderer.tsx`/`boards/*` | `/api/query` text search + AND/OR grammar; writer stamp `prism_last_writer` (shared with 2D); CSV import endpoint; batched CAS writes |
| 4 | **2D · Sharing, presence and review** | SB-09, CO-05…07, CO-09, CO-11, CO-12 (activation), CO-14, CO-15, PG-13, PG-17 | `ShareDialog.tsx`, `components/sharing/*`, `HistoryPanel.tsx`, header presence component (mounted by 2B's chrome via a slot) | Path-prefix (subtree) grants in `permissions.ts` honoured by tree/events/collab/MCP; `GET /api/shared-with-me`; grantee `displayName`; writer stamp; comment index; then human-command client activation and `COLLAB_SUGGEST_ENFORCED=true` per the release order |
| 5 | **2E · Shell, phone and offline polish** | SB-12, SB-13, SB-15, PG-06, PG-08, PG-10, PG-14, MB-02, MB-04 (completion), MB-06, OF-01, OF-04, SR-03, SR-04, AX-06 | `Shell.tsx`, `MobileActionBar.tsx`, `FormattingBar.tsx`, `TabBar.tsx`, `styles/*`, `navigation/search*`, `offline/*` | `/api/search` filter params and match offsets; nothing else |
| 6 | **3A · Import, export and templates** | TX-02, TX-04, TX-05, TX-06, TX-03 (sub-pages zip) | `components/import-export/*`, `lib/pages/templates*` | `POST /api/import` (dry-run default, idempotent, owner), `POST /api/export` ZIP job, attachments from 2B |
| 7 | **3B · Native completion** | NA-04, NA-05 follow-ups, MB-08…10 device fixes | `apps/client/**` (iOS), server AASA route | Apple App Site Association file; universal-link routing |
| 8 | **3C · Performance and accessibility sweep** | PF-01…09, AX-02…05, AX-07, AX-08 | Cross-cutting fixes only, each as a small owned commit after 2A–2E merge | None, unless PF-04 needs a paged tree projection (`/api/tree?prefix=`) |
| 9 | **3D · ED-07 shortcut sheet, ED-04/20/21/22 verification, AI-01…03 and all remaining `exists-needs-verification` rows** | Verification-only rows | Fixture specs only | — |

Wave 3 starts when the wave 2 groups it depends on are merged: 3A needs 2B, and 3C runs after everything else. Every group writes its new fixtures under the names in §2 so the reviewer can re-run them unchanged.

## 4. Final acceptance procedure before the first TestFlight upload

Run this only once every §2 row reads `passed` on one main SHA. The owner countersigns at the end.

1. **Freeze.**
   - Tag the candidate `rc-ios-1` at main SHA *X*.
   - Record *X* in [CURRENT-RELEASE.md](CURRENT-RELEASE.md).
   - From here on, the only commits allowed before upload are fixes for failures found in this procedure, each followed by a re-run of the affected steps.
2. **Static and server checks.** All of these must pass at *X*:
   - `npx tsc --noEmit`
   - `cd apps/server && npm run typecheck && npm test` (server tests **only** through `npm test`)
   - `npm run verify:native`, `verify:agent`, `verify:events`, `verify:host`, `verify:media` and `check:sw` in `@prism/web`
   - `node apps/client/scripts/verify-client.mjs --build`
   - `cd apps/client/src-tauri && cargo test`
3. **Full fixture e2e**, both Chromium and WebKit, at *X*:
   - `npm run test:e2e -w @prism/web` covers every spec in `e2e-fixtures/`.
   - Also run the `playwright.native`, `human-helpers`, `inbox-people` and `saved-context` configs.
   - Pass condition: **0 failures**. Every skip must be one of the documented native-only skips.
   - Use a dedicated `E2E_PORT`, never a port in use by other agents.
4. **Screenshot review.**
   - Capture every UI item's fixture state at **1440×900 and 390×844, in light and dark**: four images per state, shown as a contact sheet.
   - The reviewer compares each state with its named board (01, 02, 06, 11–16, 18, 20, 23, desktop-collaboration, mobile-workflow) or its Notion reference capture.
   - Fail conditions: clipped text, horizontal page scroll, white panels in dark, overlapping bottom controls, focus rings around the writing surface, or icon-only controls the board labels.
   - Store the sheet under `verification/notion-parity/rc-ios-1/`. Fictional data only.
5. **Production deploy.** Follow the runbook:
   - Back up the vault and `prism-server.db` together.
   - Check that no agent turn is active, restart pm2 `prism-server`, and confirm `/acl/workers` is green.
   - Rollback artifacts stay ready.
6. **Real-vault production smoke (P)**, owner account, synthetic `_test` notes only, deleted afterwards:
   - sign in on web and in the macOS client
   - open the largest real page and time it against NP-PF-02
   - create a page, add a sub-page, then move, trash and restore it
   - favorite on one device and see it on the other
   - open the `task` tag as a database; edit a property; check board and calendar
   - insert an image, a table, a callout and a toggle; reload; open in a second client
   - comment and @mention a test account, then confirm the inbox item and the push
   - share to the test account (Can suggest) and confirm it cannot edit directly
   - ⌘K search and a semantic result
   - go offline, edit, reconnect and confirm a single merge
   - export a page; ask the agent and accept a suggestion
   - **Check that the vault contains no stray `_test` notes afterwards.**
7. **Native iOS pass.**
   - **Simulator:** iPhone SE (3rd gen), iPhone 16 Pro Max and iPad (A16), in both themes.
   - **Physical iPhone** with a TestFlight-equivalent Release build, signed by `apps/client/scripts/ios-release.sh`:
     - PKCE sign-in, sign-out and re-sign-in
     - Face ID lock/unlock, passcode fallback, and app-switcher blur
     - APNs in the **production** environment: agent turn end, mention, reminder; tap-to-open
     - Keyboard: toolbar above the keyboard, Japanese kana IME, emoji, dictation, autocorrect, external keyboard shortcuts on iPad
     - Rotation; background for 10 minutes, then resume
     - Airplane-mode editing, then reconnect
     - Network Link Conditioner on "3G"
     - VoiceOver: open a page, edit, use the slash menu
     - Dynamic Type XXL
     - Deep and universal links from Messages and Mail
   - Record device, OS, build number and result for every NA, MB and AX "D" row.
8. **Performance.**
   - Measure NP-PF-01…09 by the stated methods at *X*.
   - Record p50 and p95 in the evidence log.
   - Any budget miss fails the gate. The owner may only relax a budget in a committed edit to this document.
9. **Sign-off and upload.**
   - The orchestrator confirms every row shows `passed` with SHA, evidence and reviewer.
   - The owner countersigns in [CURRENT-RELEASE.md](CURRENT-RELEASE.md).
   - Only then run `ios-release.sh`. Build numbers follow the rule in `docs/client-app.md`.
   - Upload, and add testers.
