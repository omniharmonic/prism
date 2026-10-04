# Notion parity — what is left to reach 161 / 161

Written 2026-10-03 from the second verification pass at main `d4a7d00`; updated the same day by the third-pass spec slice (slice G, `feat/w8-specs` on main `3c1df0a`). Evidence per row: [PARITY-EVIDENCE.md](PARITY-EVIDENCE.md). The gate itself: [NOTION-PARITY-CHECKLIST.md](NOTION-PARITY-CHECKLIST.md).

| Status | Rows (after slice G) | Second pass | First pass |
|---|---|---|---|
| passed | 59 | 52 | 20 |
| deviation (built; owner decision pending) | 6 | 5 | — |
| needs-screenshot | 35 | 30 | 19 |
| needs-device | 29 | 26 | 18 |
| partial | 27 | 43 | 83 |
| missing | 4 | 4 | 12 |
| not-measured | 1 | 1 | 9 |

So **102 rows are not passed**. Of those: 64 wait only for a person (35 screenshot reviews, 29 device checks), 6 for an owner decision, and 32 need work (27 partial, 4 missing, 1 not measured). Slice G moved 16 rows out of `partial` (7 to passed, 5 to needs-screenshot, 3 to needs-device, 1 to deviation) and found 8 behaviour gaps that had been listed as test gaps (slices I–M below). "Passed" means passed on Chromium; one WebKit run of the whole suite is still owed (b.1).

Nothing here is marked done to improve a number. A row leaves this file only when its evidence is on main.

Sizes: **S** = under a day, one or two files. **M** = one to three days, a new component or route. **L** = more than that.

---

## (a) Build gaps — behaviour that is missing or different

### a.1 Behaviour gaps, by slice

Each slice owns the files named. Nothing here touches the collab schema, so no `COLLAB_SCHEMA_VERSION` bump is expected.

| Slice | Row · clause | What is missing | Where it goes | Size |
|---|---|---|---|---|
| **A · Editor links** | ~~NP-ED-18 · "Hovering a link shows the URL with Open, Edit and Remove"~~ | ~~No hover card. A link is opened or edited only through the selection toolbar.~~ **Closed on `feat/w8-gaps-a`** (awaiting re-verification): `LinkCard` (`components/renderers/LinkCard.tsx`) in both editors: hover or caret in a link → address + Open / Edit / Remove (Open / Copy read-only); ⌘K with the caret in a link moves into it. Spec `editor-links.spec.ts`. | New `packages/core/src/lib/tiptap/LinkHover.ts` (plugin) + a small popover beside `components/renderers/SelectionActions.tsx`; reuse `EDIT_LINK_EVENT`. Spec: `editor-toolbar.spec.ts`. | S |
| | ~~NP-ED-18 · "Pasting an internal Prism URL becomes a page mention"~~ | ~~A pasted `/page/<id>` URL is treated like any other URL (link + "Paste as" menu).~~ **Closed on `feat/w8-gaps-a`** (awaiting re-verification):  `UrlPaste` + `lib/tiptap/prismLinks.ts` (`pageIdFromUrl`: own origin only, strict id): the URL lands as a page `mention` chip; "Paste as" offers URL instead. Spec `editor-links.spec.ts`. | `lib/tiptap/UrlPaste.ts`: recognise our own origin + `/page/<id>`, insert the `mention` node (`kind: page`) directly. Spec: `notion-media.spec.ts` or `notion-mentions.spec.ts`. | S |
| **H · Title rename** | ~~NP-PG-03 · "A rename shows live in the tree, tabs and breadcrumbs"~~ | ~~**Found in this pass.** Renaming a page that has sub-pages from its title PATCHes only that note's path: the sub-pages stay under a plain folder with the old name. A non-owner's title rename is a path PATCH, which the gateway refuses (`move_required`). The tree's Rename is correct (it uses the move route).~~ **Closed on `feat/w8-gaps-a`** (awaiting re-verification): both title renames call `renamePageFromTitle` (`lib/pages/titleRename.ts`) = the move route; conflict / offline revert the title with an inline reason. Specs `parity2-pages.spec.ts` (sub-pages, member, taken title, offline), `notion-offline-writes.spec.ts`, `document-polish.spec.ts` (live document). | `packages/core/src/components/renderers/DocumentRenderer.tsx` `handleRename` and `apps/web/src/collab/CollabDoc.tsx` `handleRename` → the move route (`usePageActions.move(page, { newPath })` / `POST /api/notes/:id/move`). Un-fixme `parity2-pages.spec.ts › "renaming a page with sub-pages from its title keeps them under it"`. | S |
| ~~**B · Templates**~~ | ~~NP-TX-01 · "Save as template is in the page ⋯ menu"~~ | **Closed (feat/w8-gaps-b).** Page ⋯ → "Save as template" (body, icon, cover, properties, own copies of files). A template is always PRIVATE to its saver and carries only the `template` tag — the page's tags are remembered and re-applied on Use; sharing it is an explicit toggle in the gallery. Never part of a publication or a database view. | `lib/pages/model.ts` `templateSource`, `usePageActions.saveAsTemplate`. Spec: `notion-templates.spec.ts › "save page as template"`. | done |
| | ~~NP-TX-01 · "A Templates gallery lists, edits and deletes templates"~~ | **Closed (feat/w8-gaps-b).** `components/pages/TemplatesGallery.tsx`: Use, Edit, Rename, Delete (Trash + Undo), from the chooser, the command bar and the save toast. Not browser-tested: saving a LIVE (collaborative) page — the editor-state copy is unit-tested only. | Specs: `notion-templates.spec.ts` (9 new). | done |
| ~~**C · Agent on pages**~~ | ~~NP-AI-03 · "Summarize, draft and transform a page or selection … with sources shown"~~ | **Closed (feat/w8-gaps-b)** for people who have the agent (the server owner — `/api/agent/*` is owner-only, decision D3): page ⋯ / command bar / selection toolbar "AI" / block menu → Summarize, Draft (continue, expand), Transform (shorter, longer, grammar, tone, translate) as a TEXT-ONLY run (no tools, no note id — `profile:"text"`); the result is a proposal with Sources and Insert / Replace / Copy / Discard. Not built: the same for members (needs per-actor agent access), and linked pages as extra sources (the agent is given this page only). | `lib/agent/pageActions.ts`, `components/agent/PageAgentPanel.tsx`. Spec: `notion-page-agent.spec.ts`. | done |
| | ~~NP-AI-01 · "the header Agent button … with the selection attached"~~ | **Closed (feat/w8-gaps-b).** With text selected the header button attaches it (unsent) to the same document-bound conversation; with nothing selected it opens the panel as before. | `components/layout/TabBar.tsx` (`HeaderSelectionAsk`). Spec: `notion-page-agent.spec.ts › "header Agent button attaches the current selection…"`. | done |
| | NP-PG-09 · "agents in Read-write mode are refused for that page" | **Partly closed (feat/w8-gaps-b).** A `vault-rw` session turn whose page (named by the turn, or bound to the session) is locked is refused 423 at turn start; so is a one-shot write dispatch with that `noteId`; the owner / admin REST passthrough now refuses every body write on a locked note (PATCH/PUT content, restore, overwriting create) with 423; all checks fail closed (503 `lock_unknown`). **Still open:** a `vault-rw` agent can write OTHER locked pages by id through the vault MCP — the vault has no lock, and the turn runs on the vault token. | Complete fix = owner decision c.9: make `prism-rw` (gateway-enforced) the Read-write profile. Tests: `agent-sessions.test.ts` (5), `pages-review.test.ts` (2). | S (decision) |
| **D · Phone gestures** | ~~NP-MB-06 · "pull-to-refresh on lists"~~ | ~~Not built.~~ **Closed on `feat/w8-gaps-a`** (awaiting re-verification): `lib/gestures/usePullToRefresh` on Inbox, Messages, Trash and the sidebar / Browse drawer, each with a Refresh button. Spec `notion-pull.spec.ts`. | `lib/gestures/` (new `usePullToRefresh`), Inbox, Messages, Trash, tree. | M |
| | ~~NP-MB-06 · "swipe on list rows (Messages: archive/read; Trash: restore)"~~ | ~~Row swipes exist on Inbox rows (read / archive) and tree rows (favorite / actions). Not on Messages rows, not in the Trash.~~ **Closed on `feat/w8-gaps-a`** (awaiting re-verification): Messages unread email rows (mark read, only with live email actions; also a button on the row) and Trash rows (restore). Spec `notion-pull.spec.ts`. **Deviation from the clause:** archive is deliberately NOT a swipe (it moves mail in the real mailbox with no undo) and chat (Matrix) rows have no archive / read action. | `lib/gestures/useSwipeActions` is reusable: `components/renderers/*Messages*`, the Trash dialog in `components/pages`. Spec: `notion-swipe.spec.ts`. | S |
| **E · Native links and shortcuts** | NP-NA-04 · universal links | The server serves no `apple-app-site-association`; the client declares no associated domain; nothing tests that a page URL opens the page. | `apps/server/src/app.ts` (AASA route + SW denylist entry `/.well-known/` is already there), `apps/client/**` (associated domains, `prism://` handler), `apps/web/src/main.tsx` routing. New fixture + `notion-links.spec.ts › "page URL routes to page"` — this also closes the `[T]` of NP-PG-16. | M |
| | NP-SB-13 · "⌘N creates a page" | No binding. A browser tab cannot take ⌘N; the native shell has no New Page menu item. | `apps/client/src-tauri` menu accelerator → the existing `usePagesUI.openCreate({})`. | S |
| **F · Search filter** | ~~NP-SR-04 · "created/edited by"~~ | ~~The UI offers "Edited by me" only. The server already takes `author=` (creator).~~ **Closed on `feat/w8-gaps-a`** (awaiting re-verification): "Created by" beside "Edited by" in `searchFilters.tsx` (client narrows the server's `author=me` rows to pages the caller created). Spec `notion-search.spec.ts › "created by me and edited by me…"`, which also asserts the date range. "Edited by me" is the server's new `editor=me` (the opaque writer stamp), "Created by me" its `author=me` (creator only); the control is hidden where the server cannot answer it. | `components/navigation/searchFilters.tsx`. Spec: `notion-search.spec.ts › "filters narrow results"` (assert the date range narrowing in the same change). | S |
| **I · Live title** *(found by slice G)* | NP-PG-03 · "a collab title edit syncs to other clients" | A rename reaches the server and the renamer's screen; another client that has the page OPEN as a live document keeps the old title until it reopens the page. `CollabDoc` sets its title/path once, at open (and after its own rename). `test.fixme`: parity3-collab › "NP-PG-03: a title edit in a live document reaches another client…". | `apps/web/src/collab/CollabDoc.tsx` (follow the page's path: the tree row in the workspace, or a Hocuspocus stateless "renamed" message from the move route so the share route gets it too — then `apps/server/src/routes/pages.ts` / `collab.ts`). | S–M |
| **J · Suggesting mode** *(found by slice G)* | NP-CO-12 · "marks inserts and deletes with attribution" | While Suggesting, typing (or pasting) over a selection removes the selected text outright: only Backspace / Delete are tracked. The new words are marked, the replaced ones are gone with nothing to reject. `test.fixme`: parity3-suggestions › "…typing over a selection while Suggesting keeps the replaced text as a tracked deletion". | `packages/core/src/editor/suggestions.ts` (`appendTransaction`: for a replaced range, put the removed slice back with a `deletion` mark; cover cut and paste). | S–M |
| | NP-CO-12 · "a stale suggestion shows Needs refresh" and NP-AI-02 · "refresh-when-stale" | No such state or control exists. A change that was reviewed or edited elsewhere leaves the queue with "This change has already been reviewed or changed." (tested in suggestion-review.spec). Either build the label + a refresh action, or the owner accepts the current behaviour by editing both rows. | `components/renderers/SuggestionReview.tsx`. | S |
| **K · Colours** *(found by slice G)* | NP-ED-08 · callout "colour" and NP-ED-16 · "background colour per block" | A callout's BACKGROUND colour is stored (`data-block-color="blue_background"`) but not shown: `.prose-editor div[data-type="callout"] { background … }` outranks `[data-block-color$="_background"]`. Text colour works. `test.fixme`: parity3-editor › "…a callout background colour changes the callout's background". | `packages/core/src/components/renderers/editor-blocks.css` (callout rules per colour). | S |
| | NP-CO-10 · "colour-distinct from agent identity" | An agent has no colour of its own: its marks carry `colorFor(<account email>)` — the caret colour of the person it acts for — and the seven-colour caret palette contains the agent's default green and red (`#22c55e`, `#ef4444`). `test.fixme`: parity3-collab › "NP-CO-10: an agent's marks never share a collaborator's caret colour". | `apps/server/src/mcp/tool-collab.ts` `authorOf` + `collab-ops.ts` (a reserved agent colour), `apps/web/src/collab/CollabDoc.tsx` `COLORS` (keep that colour out of the palette). | S |
| **L · Export and publish fidelity** *(found by slice G)* | NP-ED-24 · "survives … export" | The **Markdown** export keeps every block's words but exports to-dos as plain bullets (checked state lost), flattens a table to one paragraph per cell, and drops an image's caption and a bookmark card's description. The HTML export keeps every block. `todo`: server block-roundtrip.test › "…blocks the Markdown / HTML export does not keep as blocks". | `apps/server/src/convert/core.ts` (the export's turndown rules: GFM task items and tables; caption → a line under the image; bookmark → link + description). | M |
| | NP-ED-24 · "survives … the publishing render" (NP-ED-19) | A published page does not draw the table-of-contents block: it is an empty element (the site has its own outline in the chrome). `test.fixme`: parity3-publication › "…published page draws every block (known gaps: table of contents)". | `apps/web/src/publish/templates/WikiTemplate.tsx` + `wiki-utils.ts` (fill `div[data-type="toc"]` from `extractToc`). | S |
| **M · Database row title** *(found by slice G)* | NP-DB-20 · "Renaming the row updates the view" | True for a row named by its page. A row CREATED IN the view (and every ingest row) carries `metadata.title`, which the view shows first; the title rename moves the path only, so the view keeps the old name. `test.fixme`: parity3-databases › "…renaming a row that was created in the view updates the row in the view". | `packages/core/src/lib/pages/titleRename.ts` (also write `metadata.title` when the page has one — a metadata write, CAS), or stop storing the title on created rows (`DatabaseRenderer.createRow`). | S |
| ~~**N · Markdown reader: to-dos**~~ *(found by slice L, recorded on `feat/w9-gaps`)* | ~~NP-ED-24 · "survives … import" (the way back)~~ | **Closed on `feat/w10-fixes`.** ~~Prism's Markdown reader made no to-do blocks of GFM task items (`- [x]` / `- [ ]`): a Markdown-bodied page with task items opened as a plain bulleted list, the checked state was lost, and the first save of the live document wrote it back that way.~~ A list whose every item is a task item now opens as the editor's to-do list with its checked state (nested lists judged on their own items; a mixed list stays a list and keeps `[x]` / `[ ]` as text) — in the server's reader (worker and inline lane), the plain editor's Markdown path of every shell, and the Markdown paste. Tests: server `markdown-tasks.test.ts` (8), fixture `markdown-todos.spec.ts` (plain + live, Chromium + WebKit). After the merge with `feat/w9-gaps`, its pin in `export-blocks.test.ts` ("the round trip…": `taskItem` count 0) must be changed to the real count. | `packages/core/src/lib/html/taskLists.ts` (`taskListsInHtml`, one linear pass over the parser's HTML), called by `apps/server/src/convert/core.ts` `markdownToHtmlSync`, `convertApi.markdownToHtml`, `markdownToPasteHtml`. | — |

### a.2 Test gaps — the behaviour exists, an assertion does not

**Slice G (verification specs) ran on `feat/w8-specs`** — specs and fixtures only, no product code. Struck = asserted (spec in brackets; evidence per row in PARITY-EVIDENCE "Third pass"). Where the behaviour turned out to be missing, the clause moved to §a.1 (slice letter in brackets) and its test is kept as `test.fixme`.

| Fixture | Row · clause to assert |
|---|---|
| `workspace.html?navigation` / session fixture | ~~NP-SB-01 tree contents and search scope after a vault switch~~ (parity3-vaults) |
| `notion-shell.html` | ~~NP-PG-02 a cover from a valid https link~~ · ~~NP-PG-06 Agent activity dot~~ · ~~NP-PG-14 "Ask agent" starter~~ · ~~NP-SR-04 date range narrowing~~ · ~~NP-SR-06 "Ask agent" command row~~ · ~~NP-OF-05 an open database view refreshing on a remote change~~ (parity3-shell) |
| `collab-route.html?app` (real server) | NP-PG-03 a title edit reaching the second client → **behaviour gap, slice I** · ~~NP-PG-08 page style on a live document~~ · ~~NP-CO-10 `"remote caret name tags"` (several collaborators~~, colour distinct from the agent → **slice K**) · ~~NP-CO-14 guest ⌘K, @ menu, Inbox and database UI~~ (parity3-collab) · NP-CO-12 ~~Accept all, Undo after accept~~ (parity3-suggestions), "Needs refresh" → **slice J** |
| history fixture (`context-history`) | ~~NP-PG-12 day groups, "compare with the version before", the consequence line, phone compare~~ (parity3-history) |
| `editor-blocks.html` | ~~NP-ED-02 block menu → Comment~~ (already on main: editor-toolbar › "live editor…") · ~~NP-ED-10 column resize~~ · ~~NP-ED-16 block text colour + dark values~~ · NP-ED-08 ~~numbered continuation, checked to-do style, callout~~ text ~~colour~~ (parity3-editor); callout BACKGROUND colour → **slice K** |
| server test + publication fixture | ~~NP-ED-24 `"block round-trip through publish and export"`~~ (server block-roundtrip.test + parity3-publication) — it found the Markdown-export and published-TOC gaps → **slice L** |
| `notion-mentions.html` | ~~NP-RF-02 an ISO date through the @ menu~~ (not a behaviour gap: the earlier attempt failed under Playwright's fake clock) · ~~NP-RF-06 inbox item opens scrolled to the chip; edit a reminder's time~~ · ~~NP-CO-01 delete own comment~~, ~~phone sheet~~ (parity3-collab) · ~~NP-CO-03 accepted / rejected-suggestion item in the Inbox~~ (parity3-mentions) · ~~NP-RF-07 person-mention backlink in the browser~~ (a fixture limit, not a behaviour gap) |
| `databases.html` | ~~NP-DB-07 calendar on another date property (`dateKey`)~~ · ~~NP-DB-08 multi-select and URL editors~~ · NP-DB-20 ~~edit the row's body; rename the row and see the view update~~ for a row named by its page (parity3-databases); a row created in the view → **slice M** |
| agent fixtures | ~~NP-AI-02 an agent's suggestions end to end~~ (parity3-collab, real server + Prism MCP); refresh-when-stale → **slice J** |
| a main.tsx routing fixture | ~~NP-PG-16 a `/page/<id>` URL opens the page and respects access~~ (parity3-links, `collab-route.html?page=<id>`; the iOS half waits for slice E) |

**Still open after slice G (test gaps):**

| Row · clause | Why it is open | Where |
|---|---|---|
| NP-CO-03 · a REPLY item landing on the commented passage | The anchor (`[data-comment-id]`) exists only in a live document; the inbox fixture renders the plain editor. Mention and reminder deep links are asserted. | A real-server journey (parity3-collab): one person comments, another replies, the first opens the item from the Inbox. |
| NP-DB-08 · sorting per type through the UI | Sort semantics per type are engine-tested on the server; the UI sort is asserted for date and select only. | `databases.html`: the Sort dialog once per property kind. |
| NP-AI-02 · the agent TURN itself | The browser test makes the MCP calls a Suggested-edits turn makes; the CLI runner is not driven in a browser (it cannot be, on a fixture). | Covered by server tests (`agent-sessions`, `agent-profiles`) + the device / production smoke. |

Noted for the a11y pass (not changed here): the phone comments panel's close button in `apps/web/src/collab/CollabDoc.tsx` is an icon with no accessible name.

### a.3 Accessibility rows (owned by the pass-2 a11y branch, not by this list)

| Row | State on main | Needed |
|---|---|---|
| NP-AX-02 | missing | The named keyboard-only journey test; focus return, traps, Esc. |
| NP-AX-05 | missing | 200 % zoom reflow test; Dynamic Type on a device. |
| NP-AX-07 | missing | ≥ 44 px sweep on phone. Known from the CSS: the phone tree's row actions are 36 px (`components/pages/pages.css`). |
| NP-AX-01 | partial | Assert the Light / Dark / System setting; sweep the surfaces left out; native launch screen on a device. |
| NP-AX-04 | partial | The named token-pair contrast test; non-text contrast. |
| NP-AX-06 | partial | Measure menu, sheet and peek durations; assert the in-app Reduce motion setting. |
| NP-AX-08 | partial | Slash-menu IME case, double-insert case; device keyboards. |
| NP-AX-03 | needs-device | VoiceOver on macOS and iOS. |

---

## (b) Rows that need a person or a device

### b.1 One WebKit run of the whole fixture suite (blocks every row)

Checklist §1.1 and §4 step 3 ask for Chromium **and** WebKit. This pass relied on the Chromium run. Before the WebKit run can be green, four spec harness problems need fixing (spec changes, not product): clipboard permissions (`notion-editor › "code block language picker, copy, wrap"`, `pages-nav › "page ⋯ menu: favorite, duplicate, copy link…"`, `editor-blocks › "block menu Move to another page"`), the Chromium-only CDP IME step (`notion-mentions › "@ menu offers people, pages, dates"`), `new Touch()` (`notion-mobile › "edge swipe…"`, `notion-swipe`). Run it on a machine that is **not** the production host.

### b.2 Screenshot review (S) — one reviewer session

For each row: capture the fixture state at 1440×900 and 390×844, light and dark (four images), and compare with the named board, or with a Notion reference capture the reviewer takes. Fail on clipped text, sideways page scroll, white panels in dark, overlapping bottom controls, focus rings around the writing surface, or icon-only controls the board labels. Store the sheet under `verification/notion-parity/rc-ios-1/`.

| Board | Rows |
|---|---|
| 01, 14 (workspace, phone) | NP-SB-02 (11), SB-04, SB-06, SB-14, SB-15 (01, 16), PG-01, PG-04 (01, 13), PG-11 (01), ED-03, MB-07 (14) |
| 11 (search) | NP-SR-01, SR-02, SR-03 |
| 12, 13 (properties, history) | NP-PG-10 (12), PG-13 (13), CO-15 (13) |
| 16 (states) | NP-CO-13, OF-01 (14, 16) |
| 20 (boards) | NP-DB-04, DB-23, DB-24 |
| 23, 24 (share, publish) | NP-CO-05, CO-06, CO-07 (and CO-08 once decided) |
| 03, 15, 18, desktop-collaboration, 09 | NP-CO-11, ED-17, RF-03 |
| Notion reference capture | NP-SB-03, SB-12, DB-18 |

Rows that are `partial` or `deviation` and also carry an S step (SB-01, SB-13, PG-02, PG-03, PG-05, PG-06, PG-08, PG-12, PG-14, CO-01, CO-03, CO-08, CO-12, SR-04, AI-01, AI-02, AX-01, AX-06) need the same review once their gap is closed.

### b.3 Device steps (D)

Device, OS, build number and result are recorded per row. iPhone = a physical iPhone on a TestFlight-equivalent Release build; simulator results do not count.

| Row | Exact step |
|---|---|
| NP-NA-01 | iPhone and Mac: sign in through the system-browser sheet, confirm the token is in the Keychain, sign out (token revoked on the server, caches cleared), sign in again. |
| NP-NA-02 | iPhone: Face ID lock on launch and after the idle time, passcode fallback, settings toggle, blurred content in the app switcher. |
| NP-NA-03, NP-CO-04, NP-RF-06 | iPhone on production APNs: permission prompt; an agent turn end, a mention and a reminder each arrive; tapping opens the target; opt-out works. Installed PWA: web push for the same three. Email digest reaches an inactive account. |
| NP-NA-04, NP-PG-16 | After slice E: open an `https://<server>/page/<id>` link and a `prism://` link from Messages and Mail — the app opens the page; without the app the web opens it. |
| NP-NA-05 | iPhone: icon (light, dark, tinted), launch screen, no rubber-band on chrome, no selectable chrome text, status bar follows the theme, external links open in the in-app browser sheet. |
| NP-NA-06, NP-OF-03 | iPhone: edit in airplane mode, force-quit, reopen, reconnect — one merge, no lost text; background 10 minutes then resume — page, scroll and drafts back, no duplicate send or turn. |
| NP-NA-07, NP-TX-03 | Mac Prism Client: menus and ⌘ shortcuts reach the app (⌘K, ⌘\, ⌘/, ⌘P, ⌘[ ⌘]), several windows, quick capture, native export dialog, drop from Finder. iPhone: export through the share sheet. |
| NP-MB-01 … 05, 08, 09 | iPhone SE and a Pro Max, portrait and landscape: bottom bar and reply composer, new page with the keyboard up, page actions sheet, keyboard toolbar above the iOS keyboard (and with an external keyboard), block tap target while scrolling, safe areas, native selection handles vs the selection toolbar, long-press on a link. |
| NP-MB-10 | iPad (1024×768 and 820×1180): sidebar, pointer hover, external-keyboard shortcuts. |
| NP-SR-08 | iPhone: Search tab opens with the keyboard up. |
| NP-ED-12, ED-13, ED-15, PG-02 | iPhone: uploaded images, file / PDF / audio / video blocks and covers render in the app; drop from Files; embeds (after decision c.7). |
| NP-OF-04 | iPhone: favourite a page, go offline, open it. |
| NP-AX-03, AX-05, AX-08 | VoiceOver (open a page, edit, slash menu); Dynamic Type XXL; kana and pinyin keyboards, emoji, dictation. |
| NP-PF-01, PF-03, PF-07 | See (d). |

### b.4 Production smoke (P)

Checklist §4 step 6, owner account, synthetic `_test` notes only. Rows that depend on it: NP-PF-02, NP-PF-05.

---

## (c) Owner decisions pending

Each of these is built and tested; the row reads `deviation` (or carries an `[O]` note) until the owner either accepts the behaviour by editing the row, or asks for the row's wording to be built.

| # | Row | The row says | What Prism does | If the owner wants the row's wording |
|---|---|---|---|---|
| c.1 | NP-ED-05 | ⌘K = link | ⌘K is the link field **with** a text selection and quick find without one (NP-SB-02 needs ⌘K while typing). Find and replace is ⌘⌥F. | Not possible together with NP-SB-02: one of the two rows must change. |
| c.2 | NP-ED-06 | ⌘/ opens Turn into | ⌘/ opens the shortcut sheet everywhere (NP-ED-07); Turn into is ⌘⇧/. | S: swap the bindings in `lib/shortcuts.ts` + `EditorKeys.ts`. |
| c.3 | NP-ED-08 | toggle "open state stored" | Open / closed is view state, never written to the document. | M and a schema bump (an attribute on `toggle`); makes every expand an edit for all collaborators. |
| c.4 | NP-DB-11 | rename, change type with a conversion preview, delete with data handling | Presentation-only: a label, a presentation of the same stored type, hide; values are removed only by the separate, explicit remove-values run. The vault schema stays additive. | L: real key renames and type conversions need a vault-side migration of every note with the tag. |
| c.5 | NP-DB-12 | reverse property written with CAS on both notes | One stored side; the reverse list is computed and editing it writes the linking page. | M–L: a second stored field kept in step. |
| c.6 | NP-CO-08 | publish / unpublish "through the existing studio" | The Share dialog explains per-tag publishing, previews and hands off to the studio, **and** keeps its own publish controls. | S: remove the direct controls from the dialog. |
| c.7 | NP-ED-15 | embeds "work in the iOS app" | In the native build an embed is an "Open in <provider>" card: the client CSP has no `frame-src`. | S after the decision: set `frameOrigins` in the host + the client CSP (reviewer's minimal set: youtube-nocookie, player.vimeo). |
| c.8 | NP-PG-05 | "3–5 pinned values, the rest behind + Add property" | Every filled property shows; empty ones are behind "+ Add property". No cap, no pinning. | S–M: a per-tag pin list in the schema-ui hints. |
| c.9 | NP-PG-09 | "agents in Read-write mode are refused for that page" | The owner REST bypass is **closed** (content writes on a locked note → 423 for everyone). Read-write agent sessions on `vault-rw` are refused for the locked page they are bound to or name — but can still write any OTHER locked page by id through the vault MCP (no lock concept there). | **Decide: make `prism-rw` the default Read-write profile** (`AGENT_PRISM_PROFILES=true`, retire `vault-rw` for sessions): every agent write then goes through the gateway, which enforces locks, grants and private pages. Cost: `prism-rw` has no delete and no attachment tools. |
| c.10 | NP-PG-06 (now `deviation`: its last test gap, the Agent activity dot, is asserted) | the header bar "shows breadcrumb" | The breadcrumb sits above the title, not in the bar. | S–M: move `Breadcrumbs` into `TabBar`. |
| c.11 | NP-RF-07 | "a page or person mention adds a vault link" | A member mentioned by **account** (no person page) gets no backlink — there is no page to link to. | None needed unless every member must have a person page. |

---

## (d) Measurements not yet taken

| Row | What exists | What is owed |
|---|---|---|
| NP-PF-09 | Browser side measured (12 requests / min for 3 tabs). Vault side was 92 calls / min **before** the reconciler gate (`cda6d93`, `d4a7d00`). | Re-measure with `apps/server/scripts/measure-idle-clients.ts` against a sandbox vault that has a live subscribe socket: 3 tabs + the iOS app, 30 minutes, server and vault CPU against baseline. |
| NP-PF-01 | Desktop warm cache 419 / 427 ms; iPhone figure is a desktop proxy. | iPhone 13-class device, Safari Web Inspector, p50 / p95 over 20 cold starts. |
| NP-PF-03 | Desktop p50 13.1 ms, no long task. | Safari timeline on the device; 10k-word page. |
| NP-PF-07 | Web proxy only (60.8 MB JS heap). | Xcode Instruments, 30 minutes and 50 page opens. |
| NP-PF-02, 04, 05, 06 | All inside budget, but 5 samples each (best / median) against the fixture server. **Slice G made the harness ready, and did not run it:** `PERF_RUNS=20 PERF_PORT=5363 npx playwright test -c playwright.perf.config.ts` now records p50 and p95 per metric (the 5th percentile for fps) and judges each budget on BOTH; a run with fewer than 20 samples is marked "not the row's method". The perf server has 26 never-read pages so PF-02 has one per run. | Run exactly that command after `npx vite build`, on a quiet machine — **not this host while it serves production** — and copy p50 / p95 into PERF-RESULTS and the rows. PF-02 and PF-05 also in the production smoke. PF-06: scroll with all 5,000 rows loaded. |

---

## Order of work proposed

1. ~~**Slice G (specs only)**~~ — done on `feat/w8-specs` (16 rows moved; 8 behaviour gaps found → slices I–M, all S or M). The WebKit harness fixes are still owed.
2. **Owner decisions c.1 – c.11** — several rows flip on a yes.
3. Slice **H** first (a data-shape bug: sub-pages left behind by a title rename), then **A, B, F** (small, independent files), then **C** (agent; touches the server) and **D** (phone). Then the slices slice G found: **J** first (Suggesting mode loses replaced text — a review-integrity bug), **M** and **K** (small), **L** (export fidelity), **I** (live title).
4. Slice **E** (native) with the device session, which also clears b.3.
5. Screenshot session b.2, then measurements (d) on a quiet machine and a device.
