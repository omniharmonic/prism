# Notion parity — evidence log (second verification pass)

**Product code under review: main `d4a7d00`. Date 2026-10-03.** Reviewer: second-pass verification agent (independent of the implementing groups). New specs written in this pass are on `feat/w7-verify` and count only once that branch is merged. The first pass was at `8094d9f` (product code `c5afd09`). The work list that follows from this log is [PARITY-GAPS.md](PARITY-GAPS.md).

## How to read this

Each row was judged against its exact acceptance text. A test named after a feature is cited only where its body asserts the clause.

| Status | Meaning |
|---|---|
| **passed** | Every clause is asserted by the named automated tests (or is a measured number in PERF-RESULTS / A11Y-RESULTS), and the row's Verify column asks for nothing but fixtures. |
| **deviation** | Built and tested, but it differs from the acceptance text by a decision recorded in `CLAUDE.md`. It passes only if the owner accepts the deviation (or edits the row). Not counted as passed. |
| **needs-screenshot** | Every automatable clause is asserted; the row's **S** step (compare against the mockup board or a Notion reference capture, 1440×900 and 390×844, light and dark) has not been done by a person. |
| **needs-device** | Every automatable clause is asserted (or none can be); the row's **D** step on a physical device is owed. Some of these also owe an S step. |
| **partial** | At least one clause is not demonstrated. `[B]` = the behaviour is missing or different. `[T]` = the behaviour exists in the code but no test asserts it. |
| **missing** | Not built, or nothing verifies it. |
| **not-measured** | A measurement the row asks for has not been taken. |

Marks in the last column: `[B]` behaviour gap · `[T]` test gap · `[S]` screenshot step · `[D]` device step · `[P]` production smoke · `[O]` owner decision.

## What this pass did and did not run

- **Relied on, not re-run:** at main `d4a7d00` the full fixture browser suite (`apps/web/e2e-fixtures/*.spec.ts`, 1,154 tests, default config = **Chromium**) and the full server suite (2,285 tests) pass. An existing test is cited as evidence on that basis; this pass read the test bodies, it did not re-run them. This machine is the production host, so the suites were not run again.
- **Run in this pass:** only the new specs listed below, one file at a time, one worker, behind a load gate.
- **WebKit: not run in this pass.** Checklist §1.1 asks for a Chromium **and** WebKit pass per row. The first pass found four tests that cannot run on WebKit as written (spec harness, not product): clipboard permissions in `notion-editor › "code block language picker, copy, wrap"` and `pages-nav › "page ⋯ menu: favorite, duplicate, copy link…"`, the Chromium-only CDP session for IME in `notion-mentions › "@ menu offers people, pages, dates"`, and `new Touch()` in `notion-mobile › "edge swipe…"`. `editor-blocks › "block menu Move to another page"` now grants clipboard permissions too. Every `passed` below therefore means "passed on Chromium"; the WebKit run of §4 step 3 is still owed for the whole suite and is listed in PARITY-GAPS.md.
- **Screenshots:** none were compared by a person in this pass, so no row with an S step is `passed`.
- **Accessibility rows:** what is recorded is the state of main. Another branch (pass-2 a11y: keyboard journeys, reflow, touch targets, IME) is in progress; those rows say "pending pass-2 a11y branch" and were not duplicated here.

## New specs written in this pass

All in `apps/web/e2e-fixtures/` unless stated. Each asserts behaviour that already existed; no product code was changed.

| File › test | Row · clause | Result |
|---|---|---|
| parity2-shell › "footer reflects offline and waiting-for-server states" | NP-SB-15, NP-OF-01 · footer "Offline · saved on this device", "Waiting for server" (header too), Settings in the sidebar | pass |
| parity2-shell › "tablet layouts" | NP-MB-10 · 1024×768 and 820×1180: persistent sidebar, hover peek, ⌘K, ⌘\ | pass |
| parity2-shell › "icon picker search, change and remove" | NP-PG-01 · searchable picker, change, remove | pass |
| parity2-shell › "search is a sidebar row" | NP-SB-02 · search row in the sidebar | pass |
| parity2-pages › "tree ⋯ menu favorites a page" | NP-SB-04 · star from the tree ⋯ menu | pass |
| parity2-pages › "a rename shows live in the tree and the tabs" | NP-PG-03 · rename in tree and tabs | pass |
| parity2-pages › "renaming a page with sub-pages from its title keeps them under it" | NP-PG-03 · **product bug found**, see the row | `test.fixme` (failed when run) |
| parity2-pages › "tree drag shows a drop line and a target highlight" | NP-SB-08 · drop line, target highlight | pass |
| parity2-pages › "phone drawer: favorites, recents, tree, tools, trash, new page and settings with 44px rows" | NP-MB-07, NP-SB-01 (phone) | pass |
| parity2-mentions › "@ menu dates: next Monday" | NP-RF-02 · "next Monday" | pass |
| parity2-databases › "filter operators follow the property type" | NP-DB-13, NP-DB-08 · operators per type | pass |
| parity2-databases › "table: the first column stays frozen on a wide table and the row count shows" | NP-DB-03 · frozen first column, row count | pass |
| parity2-databases › "list rows and gallery cards show the view's chosen properties" | NP-DB-05, NP-DB-06 · chosen properties | pass |
| apps/server/test/mcp-tools.test.ts › "locked page refuses agent writes" | NP-PG-09 · the test title the checklist asks for (Prism MCP path) | pass (file: 23 / 23) |

13 new passing tests + 1 `test.fixme`. Commands: `E2E_PORT=5377 npx playwright test -c playwright.config.ts <one file> --workers=1` (Chromium) and, for the server file, `node --import tsx --test --test-force-exit --env-file=.env.test test/mcp-tools.test.ts` from `apps/server`.

Tried and dropped (not kept as failing tests): an ISO date through the @ menu (NP-RF-02) and a person-mention backlink in the browser (NP-RF-07) — both did not pass in the mentions fixture; see those rows.

## Totals

| Status | This pass | First pass (8094d9f) |
|---|---|---|
| passed | 52 | 20 |
| deviation | 5 | 0 |
| needs-screenshot | 30 | 19 |
| needs-device | 26 | 18 |
| partial | 43 | 83 |
| missing | 4 | 12 |
| not-measured | 1 | 9 |
| **total** | **161** | **161** |

Per section:

| Section | passed | deviation | needs-screenshot | needs-device | partial | missing | not-measured |
|---|---|---|---|---|---|---|---|
| 2.1 Sidebar and workspace navigation | 6 | 0 | 7 | 0 | 2 | 0 | 0 |
| 2.2 Page chrome | 3 | 0 | 5 | 0 | 9 | 0 | 0 |
| 2.3 Editor and blocks | 12 | 2 | 2 | 3 | 6 | 0 | 0 |
| 2.4 Inline references | 4 | 0 | 1 | 0 | 2 | 0 | 0 |
| 2.5 Databases | 16 | 2 | 4 | 0 | 3 | 0 | 0 |
| 2.6 Collaboration, sharing and notifications | 2 | 1 | 6 | 1 | 5 | 0 | 0 |
| 2.7 Search and ⌘K | 2 | 0 | 3 | 1 | 2 | 0 | 0 |
| 2.8 Templates, import and export | 4 | 0 | 0 | 1 | 1 | 0 | 0 |
| 2.9 Prism agent | 0 | 0 | 0 | 0 | 3 | 0 | 0 |
| 2.10 Phone app patterns | 0 | 0 | 1 | 8 | 1 | 0 | 0 |
| 2.11 Offline, sync and reliability | 2 | 0 | 1 | 2 | 1 | 0 | 0 |
| 2.12 Accessibility, theming and motion | 0 | 0 | 0 | 1 | 4 | 3 | 0 |
| 2.13 Native app | 0 | 0 | 0 | 6 | 0 | 1 | 0 |
| 2.14 Performance budgets | 1 | 0 | 0 | 3 | 4 | 0 | 1 |

## Rows

### 2.1 Sidebar and workspace navigation

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-SB-01 | partial | navigation › "writing navigation keeps the vault above the page tree and tools reachable" (switcher at top, current name, every vault + Manage workspaces & vaults, switch call); workspace-session › "vault switch returns to the correct saved workspace", "late reads from the previous vault cannot reopen its documents"; shortcuts › "each vault keeps its own favorites and recent history"; parity2-pages › "phone drawer: favorites, recents, tree, tools, trash, new page and settings with 44px rows" (phone: switcher is the drawer's first control) | [T] tree contents after a switch and the search scope after a switch are not asserted (tabs, favorites and recents are). [S] 01, 14. |
| NP-SB-02 | needs-screenshot | parity2-shell › "search is a sidebar row"; notion-search › "⌘K opens while typing in the editor and Esc returns to the caret"; search › "palette prioritizes readable notes…" | [S] 11. |
| NP-SB-03 | needs-screenshot | notion-home › "home shows recents, upcoming events, my tasks" (recents, upcoming, my tasks = assignedToMe, unread mentions, default on launch with "Start with last open document" off), "my tasks: an older server…", "my tasks: an owner with no owner identity set…"; server my-tasks.test | [S] Notion reference capture. |
| NP-SB-04 | needs-screenshot | shortcuts › "each vault keeps its own favorites…" (empty text "Star a page to pin it here."); pages-nav › "favorites reorder by drag and keyboard" (drag, Alt+Shift+↑/↓, second device), "favorites and recents sync through the server…" (header star); parity2-pages › "tree ⋯ menu favorites a page"; notion-search › "a page can be starred from ⌘K without opening it" | [S] 01, 14. |
| NP-SB-05 | passed | notion-sidebar › "recents are capped at 12 in the sidebar" (15 stored, 12 shown, collapsible section, ⌘K empty state); pages-nav › "favorites and recents sync through the server…", "⌘K lists recent pages first…" | — |
| NP-SB-06 | needs-screenshot | pages-nav › "a page with sub-pages is one node: it opens, discloses its children, and adds a page inside", "tree expansion persists on this device"; notion-page › "icon propagates to tree, tabs, ⌘K" (row icon); parity2-pages › "phone drawer…" (same tree, disclosure, on phone) | [S] 01, 14. |
| NP-SB-07 | passed | pages-nav › "tree row hover + and ⋯" (quiet at rest, shown on hover; Add to Favorites, Duplicate, Copy link, Rename, Move to…, Open in new tab, Move to Trash; Open in new tab opens a background tab), "phone: the drawer tree offers page actions in a sheet and the header ⋯ works"; notion-swipe › "page tree rows: swipe right favorites the page, swipe left opens its actions" | Long-press is not asserted (the row says "⋯ button or a long-press"; the ⋯ button and a swipe are). |
| NP-SB-08 | passed | pages-nav › "drag and drop reparents a page and reorders siblings" (reparent, reorder, prism_order written to the server), "Move to… moves a page with its sub-pages…" (keyboard alternative); parity2-pages › "tree drag shows a drop line and a target highlight" | The order on a SECOND device is shown only as the server write (prism_order), not by loading another client. |
| NP-SB-09 | passed | notion-sharing › "guest sidebar shows only shared pages", "guest sees only shared content everywhere" (real server); pages-nav › "sidebar: Shared with me lists shared pages for a member…", "sidebar: a guest sees Shared with me and none of the workspace sections" | — |
| NP-SB-10 | passed | pages-nav › "Trash: delete moves to Trash with Undo; the Trash restores and deletes permanently" (search, Restore, two-step Delete forever, retention notice, Undo toast) | — |
| NP-SB-11 | passed | notion-sidebar › "⌘\\ collapses and width persists" (⌘\ from the editor too, collapsed + dragged width survive reload), "the shortcut sheet's shell rows are the working bindings" | — |
| NP-SB-12 | needs-screenshot | notion-sidebar › "collapsed sidebar peeks on edge hover" (overlay, mouse-out, Esc), "the sidebar peek is reachable and dismissible from the keyboard" | [S] Notion reference capture. |
| NP-SB-13 | partial | notion-sidebar › "one action → focused untitled page" (measured < 300 ms click → focused title; chooser optional); pages-nav › "a page with sub-pages is one node…" (+ on a tree row); notion-home (New page); PERF-RESULTS § NP-SB-13 | [B] ⌘N: no binding exists — a browser tab cannot take ⌘N and the native shell (apps/client) defines no New Page menu item/accelerator (size S, apps/client/src-tauri + a `prism:new-page` hook in useKeyboardShortcuts). [S] 14. |
| NP-SB-14 | needs-screenshot | navigation › "writing navigation keeps the vault above the page tree and tools reachable" (Tools collapsed by default, Calendar/People/Automations/Map reachable), "sidebar preferences pin, hide and order tools…", "dark writing navigation retains every specialist destination" | [S] 14. |
| NP-SB-15 | needs-screenshot | notion-sync-state › "footer reflects sync state" (Synced, Saving…); parity2-shell › "footer reflects offline and waiting-for-server states" (Offline · saved on this device, Waiting for server, Settings in the sidebar, never Synced before delivery) | [S] 01, 16. |

### 2.2 Page chrome

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-PG-01 | needs-screenshot | notion-page › "icon propagates to tree, tabs, ⌘K" (tab, tree, favorites, ⌘K row, breadcrumbs, second load); parity2-shell › "icon picker search, change and remove"; notion-mentions › "page mention tracks rename; no-access state" (the link chip shows the page icon); notion-live-safety › "M3: a refused icon write does not leave the icon showing…" | [S] 01, 14. |
| NP-PG-02 | partial | notion-page-cover › "cover add, reposition, remove" (gallery preset, upload, reposition by drag, Change, Remove, non-https link refused), "cover renders cropped on phone and in dark mode; read-only has no controls" | [T] a cover from a VALID https link is not asserted (only the refusal). [D] phone. [S] Notion reference. |
| NP-PG-03 | partial | notion-page › "Enter in the title moves into the body"; workspace › "document title supports keyboard rename and cancel"; parity2-pages › "a rename shows live in the tree and the tabs"; notion-sidebar › "one action → focused untitled page" (a new page is "Untitled") | [B] renaming a page that HAS sub-pages from its TITLE writes only that note's path (`DocumentRenderer.handleRename` and `CollabDoc.handleRename` → a single-note PATCH), so the sub-pages stay behind under a plain folder with the old name and their breadcrumbs no longer name the page; by the gateway's documented rule a non-owner's path PATCH is refused (`move_required`), so their title rename fails. The tree's Rename already uses the move route. Recorded as `test.fixme` parity2-pages › "renaming a page with sub-pages from its title keeps them under it" (seen failing before it was marked). [T] a title edit in a live document reaching another client, and the breadcrumbs following a rename, are not asserted. [S] 01. |
| NP-PG-04 | needs-screenshot | pages-nav › "breadcrumbs open parent pages, reveal folders, and collapse long trails" (… menu, each crumb opens, phone) | [S] 01, 13. |
| NP-PG-05 | partial | page-properties › "properties under the title: typed values, metadata-only CAS writes, empty fields behind Add property" (status, select, date), "tags use a searchable checklist", "person picker links a person note as a wikilink", "viewers see properties without edit affordances", "property bar light/dark"; notion-db-props › "relation picker and reverse property" | [T] checkbox, URL and number editors in the page bar are not asserted (they are in the table: databases › "table: typed cells edit in place…"). [O] "3–5 pinned values": the bar shows every FILLED property and puts empty ones behind "+ Add property" — there is no pin/cap; owner to accept or ask for a cap. [S] 12. |
| NP-PG-06 | partial | notion-page › "header carries save state, Share, Agent, ⋯" (one row, labelled Share and Agent, star, ⋯; phone: title, save dot, ⋯); notion-presence › "header avatars and jump to cursor"; notion-sync-state | [T] the Agent activity dot is not asserted (useAgentActive). [O] the breadcrumb sits above the title, not inside the bar (recorded deviation). [S] 01, 12, 18, 14. |
| NP-PG-07 | passed | pages-nav › "page ⋯ menu: favorite, duplicate, copy link, lock, export and history", "page ⋯ menu: Open in new tab opens the page's own address", "Move to… moves a page…", "Trash: …", "integration-owned pages can't be moved or trashed from the page menu" (both disabled, each with its reason); notion-page › "full width, small text, font persist per page" (style options in the same menu) | — |
| NP-PG-08 | partial | notion-page › "full width, small text, font persist per page" (metadata-only writes, honoured after reload, per page); server page-style.test | [T] not asserted on a LIVE collab document (Canvas applies the same attributes to every renderer, so this is a missing assertion). [S] 15, Notion. |
| NP-PG-09 | partial | pages-nav › "page ⋯ menu: …lock…" (banner, editor read-only for the owner, Unlock); server pages-review.test › "LOCK: content writes and restores on a locked note → 423…", "LOCK: the collab socket is read-only on a locked note"; server mcp-tools.test › "locked page refuses agent writes" (NEW: prism_update_note refused for editor AND owner) | [B] an agent session in Read-write mode on the `vault-rw` profile (the default while AGENT_PRISM_PROFILES is off) writes with the vault token straight to the vault MCP, where the lock is unknown — not refused. [O] the owner/admin REST passthrough lets a content PATCH through on a locked page (audited `[pages] lock bypass`), while the row says "refuses edits for everyone, including the owner" — the UI and MCP do refuse. |
| NP-PG-10 | needs-screenshot | notion-page › "backlinks pill lists linking pages" (count, snippets, opens, hidden when none, hidden pages never counted) | [S] 12. |
| NP-PG-11 | needs-screenshot | document-polish › "outline opens without moving the selection, follows heading edits and navigates the same editor" (aria-current=location on the section being read, click scrolls, selection + scroll kept) | [S] 01. |
| NP-PG-12 | partial | context-history › "history keeps real attribution, paginates and traps/returns dialog focus", "restore flushes unsaved work and checks the fresh updatedAt before replacing it", "<mode> can compare and read, but cannot restore", "history visual phone/desktop" (screenshot only) | [T] the day grouping, the "compare with the version before" switch and the consequence line ("your previous version stays in history") exist but are not asserted; the phone compare is a screenshot, not an assertion. [S] 13. |
| NP-PG-13 | needs-screenshot | notion-history › "versions name their author kind" (you / another person / Agent revision / Accepted suggestion) | [S] 13. |
| NP-PG-14 | partial | notion-page › "empty page starters vanish on typing" (Empty page, Template, Import; gone on typing, back on undo); suggest-only › "a suggest-only person gets no empty-page starters…" | [T] the "Ask agent" starter (shown only with an agent client) is not asserted — the shell fixture mounts no AgentClientProvider. [S] 16. |
| NP-PG-15 | passed | notion-editor › "child page block appears in parent body" (slash Page creates the child, block stores the id only, No access state, Trash offer names the page, Keep / Trash, never after a cut), "moving a sub-page row to another page offers no Trash", "sub-pages and [[ create refuse a temporary offline id"; pages-nav › "a page with sub-pages is one node…" (tree +); server editor-blocks-v5.test | — |
| NP-PG-16 | partial | pages-nav › "page ⋯ menu: …copy link…" (clipboard = /page/<id>), "page ⋯ menu: Open in new tab opens the page's own address" | [T] opening a /page/<id> URL and its access check are not asserted: no fixture boots apps/web/src/main.tsx routing (named test notion-links.spec › "page URL routes to page" does not exist). [D] iOS app (NP-NA-04). |
| NP-PG-17 | passed | notion-page › "page info footer" (words, characters, created, last edited, last edited by); pages-nav › "page ⋯ menu ends with the page info footer" | — |

### 2.3 Editor and blocks

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-ED-01 | passed | editor-blocks › "hovering a block shows + and ⋮⋮; dragging reorders top-level blocks in one step and saves", "a multi-block selection drags as one block group in one undo step" (drop line), "live collaborative editor: a block move reaches the other client…", "read-only documents show no block handles"; notion-editor › "live document: block selection moves as a group…" | — |
| NP-ED-02 | partial | editor-blocks › "the block menu turns blocks into every kind, colours, duplicates and deletes — keyboard first", "block menu Move to another page" (search field, Copy as HTML + Markdown, Move to through the server, kept on anything but 200), "Move to carries the block's files to the target page…"; selection-agent › "block menu Ask agent attaches the block to the existing session" | [T] the block menu's Comment item (live documents only, BlockHandles onComment) is not asserted. |
| NP-ED-03 | needs-screenshot | editor-slash › "the slash menu is grouped, shows shortcut hints and is a keyboard-driven listbox", "fuzzy search ranks the intended block first", "phones: the slash menu fits the screen and uses large targets; columns stack"; selection-agent › "keyboard and slash entries reuse the same unsent conversation flow" (Agent group) | [S] 01, 14. |
| NP-ED-04 | passed | notion-editor › "markdown shortcuts convert as you type", "markdown shortcuts convert and undo to literal", "markdown shortcuts: >> + space makes a toggle", "live document: …markdown undo restores the literal"; wikilinks › "autocomplete supports keyboard selection…" ([[) | `>` = quote is the owner-approved deviation of §1.3. |
| NP-ED-05 | deviation | editor-toolbar › "⌘B ⌘I ⌘U ⌘⇧S ⌘E toggle marks from the keyboard", "⌘K link, ⌘⇧H highlight" (last colour; link field from the keyboard); notion-editor › "find in page: phone reaches it from ⋯" (⌘K with no selection is quick find) | [O] ⌘K is contextual: the link field WITH a text selection, quick find without (NP-SB-02 needs ⌘K "while typing in the editor"). Find and replace moved to ⌘⌥F. Conflicts with native-app menus are a device check (NP-NA-07). |
| NP-ED-06 | deviation | editor-blocks › "⌘⇧↑↓, ⌘D, ⌘/, Esc block selection" (Esc selects, ↑/↓, Shift extends, ⌘⇧↑/↓, ⌘D, ⌘↵ to-do, Backspace deletes, Tab/⇧Tab nest), "Alt/Option+Shift+↑/↓ moves the current block…", "Esc block selection ignores unrelated popups…"; editor-slash › "toggle headings" (⌘↵ flips a toggle) | [O] ⌘/ opens the shortcut sheet everywhere (NP-ED-07); Turn into is ⌘⇧/ — the row says ⌘/. |
| NP-ED-07 | passed | editor-blocks › "shortcut sheet lists editor shortcuts" (Text formatting, Blocks, Markdown, Find, Navigation, Databases; platform keys; no key with two meanings; searchable; phone fits); notion-sidebar › "the shortcut sheet's shell rows are the working bindings" | — |
| NP-ED-08 | partial | editor-slash › "every slash block inserts the node it names and the stored HTML keeps it", "toggle headings" (levels 1–3, nested list in the body), "collapsing a toggle hides its body locally and never writes to the document"; notion-editor › "markdown shortcuts convert as you type" (H1–H3, lists, to-do, quote, divider); editor-blocks (Tab nesting); server editor-blocks.test, editor-blocks-v5.test | [O] toggle open/closed is view state, never stored (the row says "open state stored") — documented decision. [T] numbered lists continuing their numbering, the checked to-do style and a callout colour change are not asserted. |
| NP-ED-09 | passed | editor-slash › "every slash block inserts…" (2, 3), "4 and 5 columns insert; dragging the gutter resizes and saves", "phones: …columns stack"; editor-blocks › "drag block to side creates columns"; server editor-beside-live.test | — |
| NP-ED-10 | partial | editor-table › "table controls add and remove rows and columns, toggle the header row and delete the table" (Tab moves to the next cell), "header column and cell background colour", "table controls stay hidden for read-only documents and fit a phone" | [T] column resize is not asserted. |
| NP-ED-11 | passed | notion-editor › "code block language picker, copy, wrap"; server editor-blocks-v4.test › "table of contents marker and highlighted code keep their stored shape" | The test needs clipboard permissions: it cannot run on WebKit as written (see Runs). |
| NP-ED-12 | needs-device | editor-upload (6 tests: paste, drop, slash upload, URL, refusals); notion-editor › "image resize, caption, lightbox"; publication › "published pages load note attachments from the publication-scoped route"; pages-nav › "export with sub-pages and images"; server attachments.test, publish-attachments.test | [D] rendering in the iOS app (blob: URLs through serverFetch). |
| NP-ED-13 | needs-device | notion-media › "file, pdf, audio, video blocks", "H1: a 'pdf'/'video' block never frames or plays a URL that is not our own attachment" | [D] native drag-drop from Finder / Files. |
| NP-ED-14 | passed | notion-media › "pasted URL offers bookmark card" (Mention / URL / Bookmark, Embed when supported; card fields); server unfurl.test | — |
| NP-ED-15 | needs-device | notion-media › "allowlisted embeds render; others fall back" (provider list, resize handle, fallback card); server app.test (frame-src) | [O] in the native build an embed is an "Open in <provider>" card until the owner approves a client CSP frame-src — the row says "works in the iOS app". [D] iOS. |
| NP-ED-16 | partial | editor-toolbar › "text colour and highlight come from the token palette"; editor-blocks › "the block menu turns blocks into every kind, colours…" (block background); notion-a11y-axe (contrast of the colour menus in both themes) | [T] a block TEXT colour and the dark-mode values of the palette are not asserted. |
| NP-ED-17 | needs-screenshot | editor-toolbar › "Notion-like order: turn into, marks, link, colour", "the Mention button opens the @ menu after the selection", "phones: the toolbar stays on screen with 44px targets", "live editor: the toolbar carries Comment…"; selection-agent › "plain selection becomes an unsent attachment…" (Ask agent) | [S] desktop-collaboration, 01. The iOS callout menu is NP-MB-09 [D]. |
| NP-ED-18 | partial | editor-toolbar › "links are typed inline, validated, applied and removable", "⌘K link, ⌘⇧H highlight"; notion-editor › "paste URL over selection links the text" | [B] no hover card on a link (URL + Open / Edit / Remove): a link is edited only through the selection toolbar (size S, a ProseMirror plugin + small popover in lib/tiptap). [B] pasting an internal Prism page URL does not become a page mention (size S, lib/tiptap/UrlPaste.ts). |
| NP-ED-19 | passed | notion-editor › "toc block tracks headings" | — |
| NP-ED-20 | passed | notion-editor › "undo covers block ops; collab undo is per-user"; editor-blocks › "a move is two transactions, undoes as one step…" | — |
| NP-ED-21 | passed | notion-editor › "paste fidelity from Notion/GDocs/Markdown" (Notion, Google Docs, Word, web), "paste fidelity: a pasted to-do list stays a to-do list", "paste fidelity: pasted Markdown text becomes blocks", "copy fidelity: copying out gives rich text and Markdown", "paste heuristic: plain paste, inline code and single signals stay literal"; server markdown-clipboard.test | — |
| NP-ED-22 | passed | notion-editor › "find in page counts and steps", "find in page: phone reaches it from ⋯"; notion-mobile › "page sheet rows: Share, Find in page, Agent" | — |
| NP-ED-23 | passed | notion-editor › "replace and replace all", "replace all in a live document reaches the other client as one undo step", "replace keeps offsets, deletes only the match…" | — |
| NP-ED-24 | partial | editor-table › "live editor: tables, callouts, toggles and columns reach the other client intact"; editor-slash › "every slash block…stored HTML keeps it"; server editor-blocks.test, editor-blocks-v4.test, editor-blocks-v5.test (storage round trip of every block), mcp-collab.test (agent edit merges) | [T] the named test "block round-trip through publish and export" does not exist: no test puts every block type through the publishing renderer, the export (Markdown/HTML) and a prism_update_note edit and checks each survives. |
| NP-ED-25 | passed | notion-editor › "placeholders: empty document, empty line, headings and list items"; editor-regressions › "a focused editor does not draw a box around the whole document" | — |

### 2.4 Inline references

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-RF-01 | passed | notion-editor › "[[ create page from query" (title, path, icon; Create page), "[[ create page: typing elsewhere while the page is created does not misplace the link"; wikilinks › "ambiguous links offer full paths and recheck access before opening", "autocomplete supports keyboard selection…" | — |
| NP-RF-02 | partial | notion-mentions › "@ menu offers people, pages, dates" (People, Pages, Dates, Remind me; tomorrow 9am; not in an email address; not mid-composition), "@ menu lists workspace members without a person page…"; parity2-mentions › "@ menu dates: next Monday" | [T] an ISO date through the @ menu is unverified: `MentionDates` parses `YYYY-MM-DD`, but one attempt in this pass (type `@2026-12-24`, Enter) did not produce a chip in the fixture and was not investigated — it may be a behaviour gap. The IME step uses a Chromium CDP session: no WebKit run as written. |
| NP-RF-03 | needs-screenshot | notion-mentions › "person mention hover card + notifies"; server notifications.test | [S] 09. |
| NP-RF-04 | passed | notion-mentions › "page mention tracks rename; no-access state" (live title + icon, hover preview, No access, Deleted page, no title stored) | — |
| NP-RF-05 | passed | notion-mentions › "date chip edit and relative display" | — |
| NP-RF-06 | partial | notion-mentions › "reminder lands in inbox at time" (set, fires at the time as an inbox item carrying the chip anchor, cancel); server notifications.test (worker, push fan-out, PATCH) | [T] opening the inbox item and landing scrolled on the block, and EDITING a reminder's time from the chip, are not asserted. [D] APNs / web push. |
| NP-RF-07 | passed | notion-mentions › "mention appears in target backlinks" (page mention, in the browser); server notifications.test › "a new person mention notifies that person's account, never the author; re-saving does not re-notify; backlink added", "L1: deleting the last chip to a target removes the mentions backlink…" | The person-mention backlink is proven on the server only (a browser attempt in this pass did not show the person's Links panel in the fixture). A member mentioned by ACCOUNT (no person page) gets no backlink — documented. |

### 2.5 Databases

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-DB-01 | passed | databases › "create database from New page and from tag"; notion-db-inline › "slash: full-page database creates a sub-page and leaves a link" | — |
| NP-DB-02 | passed | notion-db-inline › "inline linked board inside a page", "inline database: phone width keeps the page inside the viewport"; notion-editor › "inline database: slash → new table view, and a linked view of an existing database" | — |
| NP-DB-03 | passed | databases › "table: typed cells edit in place with per-field compare-and-set, and conflicts are recoverable", "table: filter, header sort, hide and resize…", "column reorder and cell keyboard nav" (arrows, Enter, Esc, Tab), "new rows are created with the tag, schema defaults…"; parity2-databases › "table: the first column stays frozen on a wide table and the row count shows" | — |
| NP-DB-04 | needs-screenshot | databases › "board: move by menu and by drag writes the group property, rank stays view-local", "board: hide empty groups, group by person, card menu order and open", "new rows are created with…the group they were added to" | [S] 20. |
| NP-DB-05 | passed | databases › "gallery card size and cover" (page cover with focal point, gradient, S/M/L saved per view); parity2-databases › "list rows and gallery cards show the view's chosen properties" | — |
| NP-DB-06 | passed | databases › "gallery, list and calendar render the same rows…"; parity2-databases › "list rows and gallery cards show the view's chosen properties" | — |
| NP-DB-07 | partial | databases › "gallery, list and calendar…; calendar adds on a day", "calendar drag reschedule and multi-day span" (one bar per week row, CAS write, conflict refused), "calendar: a viewer cannot drag an item to another day" (Next month), "a UTC datetime lands on its local calendar day…" | [T] choosing ANOTHER date property for the calendar (view `dateKey`) is not asserted — "on any date property". |
| NP-DB-08 | partial | databases › "table: typed cells…" (text, number, select, checkbox), notion-db-props › "property management from the table: retype preview, number format…", "date range and time, status groups", "relation picker and reverse property"; page-properties › "person picker…"; parity2-databases › "filter operators follow the property type"; server database-engine.test, database-dates.test (filter + sort per type) | [T] the multi-select and URL EDITORS are not driven in a fixture; sorting per type is proven in the engine (server tests), not through the UI for each type. |
| NP-DB-09 | passed | notion-db-props › "email, phone, files properties" | — |
| NP-DB-10 | passed | notion-db-props › "system properties sort and filter" | — |
| NP-DB-11 | deviation | page-properties › "owner adds a typed property and a new option through the schema", "rename, retype with preview, delete property", "non-owners see no schema controls"; notion-db-props › "property management from the table: retype preview, number format, delete and remove values", "L5: removing values is chunked"; server database-props.test | [O] property management is presentation-only: rename = a label (the metadata key never moves), change type = only between presentations of the stored vault type, an option "delete" hides it, a property "delete" hides it everywhere and the values go only through the separate remove-values run. The vault schema stays additive. |
| NP-DB-12 | deviation | notion-db-props › "relation picker and reverse property", "relation chips open pages; the reverse property edits the forward side", "the reverse property is read-only for someone who cannot edit the page" | [O] the reverse property is computed from the forward side and editing it writes the LINKING page's value (one stored side, per-field CAS) — the row's backend note asks for a write on both notes. |
| NP-DB-13 | passed | databases › "table: filter, header sort, hide and resize are saved to the database note" (chip "Filter · 1", saved), "AND/OR filter groups"; parity2-databases › "filter operators follow the property type"; server database-engine.test | — |
| NP-DB-14 | passed | databases › "multi-level sort", "table: filter, header sort…" | — |
| NP-DB-15 | passed | notion-db-views › "table group by with counts" | — |
| NP-DB-16 | passed | databases › "adding a view and opening a row", "a saved view is renamed and deleted from View settings", "saved views: duplicate and reorder tabs", "viewer: …session-only view changes", "viewer: duplicating or reordering a view stays in this tab" | — |
| NP-DB-17 | passed | notion-db-views › "database search box"; databases › "L8: the search box is debounced" | — |
| NP-DB-18 | needs-screenshot | notion-db-views › "side peek, center peek, full page", "side peek: phones always open the full page"; notion-editor › "row peek: Esc from inside the peeked page's editor closes the peek" | [S] Notion reference. Editing the BODY inside the peek is not asserted (the peek mounts the same renderer). |
| NP-DB-19 | passed | notion-db-views › "database template applies on new row", "templates: an entry that is not a template of this database copies nothing" | — |
| NP-DB-20 | partial | databases › "adding a view and opening a row" (Open as page); page-properties (properties under the title) | [T] editing the row's body and "renaming the row updates the view" are not asserted. |
| NP-DB-21 | passed | notion-db-views › "bulk edit and bulk trash with undo", "bulk: viewers get no selection and no bulk actions", "bulk duplicate keeps a private page private" | — |
| NP-DB-22 | passed | databases › "viewer: read-only cells, hidden private rows, honest 'limited' and session-only view changes"; page-properties › "non-owners see no schema controls"; server databases.test | — |
| NP-DB-23 | needs-screenshot | databases › "phone: sticky first column, no page overflow, filters in a sheet", "phone: boards default to list" (rows open full-page) | [S] 20 (phone). |
| NP-DB-24 | needs-screenshot | boards › "per-column add, card menu, due chips", "a task board opens as a database without rewriting a task", "manual rank belongs to the view…", "L9: the due chip shows a range…" | [S] 20. |
| NP-DB-25 | passed | notion-db-csv › "csv import preview and export", "csv import into a new database", "csv import is offered only to people who can change the schema"; notion-import › "a single CSV offers Import as a new database"; server database-depth.test | — |

### 2.6 Collaboration, sharing and notifications

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-CO-01 | partial | notion-mentions › "comment mention, edit own, reopen" (thread, reply, edit own, resolve, Resolved tab, reopen, mentions); editor-toolbar › "live editor: the toolbar carries Comment…"; suggest-only › "comments, replies and resolve go through commands for a suggest-only person" | [T] deleting one's OWN comment and the phone sheet presentation are not asserted (thread delete is: notion-comments). [S] desktop-collaboration. |
| NP-CO-02 | passed | notion-comments › "page-level discussion" (unanchored thread, second client, reply, resolve, Show resolved, reopen, delete), "…suggest-level people go through the command endpoint; a refusal keeps the draft", "…view and comment levels can read it but get no composer; phone and dark fit"; server human-collab.test | — |
| NP-CO-03 | partial | notion-inbox › "inbox lists mentions, replies, shares; mark read", "mark all read clears the badge with one write"; notion-mobile › "the bottom bar carries Inbox with its unread badge…"; notion-mentions › "reminder lands in inbox at time"; server notifications.test (suggestion accepted / declined / resolved items) | [T] an accepted / rejected-suggestion item is not shown in the Inbox fixture (the producer is server-tested); a deep link landing on the block is not asserted. [S] Notion. |
| NP-CO-04 | needs-device | notion-inbox › "notification settings respected"; server notifications.test, push.test, apns.test (ids-only payload, email digest) | [D] APNs on a TestFlight build and web push on an installed PWA; the email to an inactive user. |
| NP-CO-05 | needs-screenshot | sharing › "sharing separates people, links, publishing and peer sync…", "failed changes retain drafts and grants…", "custom permissions remain explicit…"; notion-sharing › "sub-pages inherit and show source" (names, avatars, owner row); workspace-access (7 tests) | [S] 23. |
| NP-CO-06 | needs-screenshot | sharing › "links use the selected expiry, clipboard failure stays explicit and failed revocation retains the link"; workspace-access › "member invite errors retain email and successful links can be copied manually"; server capability.test | [S] 23. |
| NP-CO-07 | needs-screenshot | notion-sharing › "share dialog is a phone sheet with underline tabs and no horizontal scroll" | [S] 23. |
| NP-CO-08 | deviation | sharing › "Publish tab: explains per-tag publishing, previews the collection and hands off to the Publishing studio", "Publish tab: a published collection is managed in the studio…", "publishing and peer sync retain their independent controls and failure recovery"; publishing-studio (5 tests) | [O] the Share dialog still has its own direct publish / unpublish controls beside the hand-off — the row says publishing happens "through the existing studio". [S] 23, 24. |
| NP-CO-09 | passed | notion-sharing › "sub-pages inherit and show source"; pages-nav › "Move to… confirms first when the move changes who can open the page"; server page-grants.test, sharing-security.test | — |
| NP-CO-10 | partial | notion-presence › "header avatars and jump to cursor" (one remote caret carrying its name tag) | [T] the named test "remote caret name tags" does not exist: several collaborators at once and a caret colour distinct from the agent's identity colour are not asserted. |
| NP-CO-11 | needs-screenshot | notion-presence › "header avatars and jump to cursor" (real server; phone compact count) | [S] 03, 15, 18. |
| NP-CO-12 | partial | suggest-only › "suggest-only human cannot edit directly", "…in the workspace itself: Shared with me opens the LIVE suggest-only editor…" (real server); notion-suggest-routing (3 tests); suggestion-review › "focused review walks changes…" (previous / next, accept, attribution); suggestions › "accept/reject reviews one complete replacement…"; server suggest-enforcement.test | [T] "Accept all" is only shown, never clicked; Undo after an accept and the stale "Needs refresh" state (CollabToolbar / CollabEditor) are not asserted. [S] 06. |
| NP-CO-13 | needs-screenshot | notion-sharing › "request access → owner approves"; server notifications.test (deny, escalation refused) | [S] 16. |
| NP-CO-14 | partial | notion-sharing › "guest sees only shared content everywhere" (real server: shared-with-me, tree, notes, search, graph, query, comments, tags; unshared = missing), "guest sidebar shows only shared pages"; isolation | [T] the guest's ⌘K, @-menu candidates, Inbox and database UI are proven at the API, not driven in the UI. |
| NP-CO-15 | needs-screenshot | notion-history › "page updates feed" | [S] 13. |

### 2.7 Search and ⌘K

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-SR-01 | needs-screenshot | pages-nav › "⌘K lists recent pages first…" (↵ opens); notion-search › "⌘↵ opens a result in a new tab; rows show the edited date", "⌘K keeps its rows while the next search is in flight…"; notion-page › "icon propagates…" (icon in rows); PERF-RESULTS NP-PF-05 (open 25 / 49 ms) | [S] 11. |
| NP-SR-02 | needs-screenshot | search › "palette prioritizes readable notes, filters returned messages and keeps every result accessible"; saved-note-handoff › "command search has a separate keyboard action and neutral new draft" | [S] 11. |
| NP-SR-03 | needs-screenshot | notion-search › "match highlighting" | [S] 11. |
| NP-SR-04 | partial | notion-search › "filters narrow results" (type, title only, edited by me), "vault scope searches another vault the account can reach", "without several vaults there is no vault selector"; server search.test (author=, after / before, date=created) | [T] the date range is selected but its narrowing is not asserted. [B] the UI offers "Edited by me" only: no "created by" choice although the server has `author=` (size S, navigation/searchFilters.tsx). [S] 11. |
| NP-SR-05 | passed | search › "ranked and keyword results are blended: title matches first, ranked next, other keyword hits last", "search shows ranked passages and openly labels keyword fallback…"; server rag.test (409 semantic_index_primary_only) | — |
| NP-SR-06 | partial | notion-search › "commands carry icons and shortcut hints; Toggle theme works from the palette and the keyboard" (New Page, New Page from Template, Open Trash, Settings, Open Inbox, Toggle Theme); pages-nav › "…the palette opens the Trash and templates" | [T] the "Ask agent" command row (icon + hint) is not in the asserted list. |
| NP-SR-07 | passed | notion-search › "back/forward restores scroll" (⌘[ / ⌘], header arrows); notion-mobile › "edge swipe goes back, else opens the drawer…"; notion-sidebar › "the shortcut sheet's shell rows are the working bindings" | — |
| NP-SR-08 | needs-device | notion-search › "phone search recents" (full screen, field focused at once, recent searches + pages, 44 px rows); search › "phone search contains focus…", "dark phone search filters fit…" | [D] keyboard actually up on an iPhone. [S] 08, 14. |

### 2.8 Templates, import and export

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-TX-01 | partial | pages-nav › "New page from template copies the template's body, properties and tags"; notion-templates (2 tests) | [B] no "Save as template" in the page ⋯ menu, and no Templates gallery that lists, edits and deletes templates (templates are ordinary notes tagged `template`, listed only in the New page chooser). Size S–M: PageActionsMenu + a Templates view in components/pages. |
| NP-TX-02 | passed | notion-templates › "date variables resolve on create" (@today, @now, @me in body and properties; not in code or addresses), "a template without variables is copied as it is" | — |
| NP-TX-03 | needs-device | pages-nav › "export with sub-pages and images" (Markdown / HTML / PDF, sub-pages + images ZIP, single file, print), "page ⋯ menu: …export…"; server export.test | [D] the native export dialog (Mac) and the iOS share sheet. |
| NP-TX-04 | passed | notion-export › "vault zip export" (tree as folders, attachments, front matter, progress), "workspace import and export are the owner's and admins'…"; server export.test, transfer-pure.test | — |
| NP-TX-05 | passed | notion-import › "notion zip dry run then import" (dry run first, nesting, image → attachment, links → wikilinks, CSV → database), "a single Markdown file imports as one page…", "importing into a shared page says who will see the pages…"; server import.test | — |
| NP-TX-06 | passed | notion-export › "print stylesheet hides chrome (light theme)", "…(dark theme)" | ⌘P is the browser's own shortcut on the web; the native shell binding is NP-NA-07 [D]. |

### 2.9 Prism agent

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-AI-01 | partial | selection-agent › "⌘J and slash attach to the existing session without starting another", "block menu Ask agent attaches the block to the existing session", "plain selection becomes an unsent attachment…" (selection toolbar), "actual collaborative host hands off selected text…"; notion-page › "header carries save state, Share, Agent, ⋯" (header button opens the companion) | [T/B] the header Agent button opening the same session WITH the current selection attached is not demonstrated (it opens the companion; no attachment asserted). [S] 01, 02, desktop-collaboration. |
| NP-AI-02 | partial | suggestion-review (2 tests), suggestions (4 tests); agent › "session permission selector supports all three modes…"; notion-history › "versions name their author kind" (Agent revision); server mcp-collab.test (agent edit → suggestion marks; live merge), sharing-routes.test (agent change kind) | [T] fixtures seed the marks: an agent turn producing the suggestions end to end, and the refresh-when-stale control, are not asserted in a browser. [S] 06, desktop-review. |
| NP-AI-03 | partial | agent-summary (7 tests), agent-reply (11 tests) — message and email threads; agent › "attached sources survive reload…", "source preview preserves the draft…" | [B] for a PAGE or a selection there is no summarise / draft / transform action with sources shown — only the generic chat (PanelChat offers "Summarize this document" as a prompt suggestion) and the owner-only ⌘J inline edit. Size M: components/agent + host services. |

### 2.10 Phone app patterns

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-MB-01 | needs-device | mobile-navigation › "labeled destinations preserve the real document…", "keyboard viewport hides navigation during editing and bounds an open sheet"; notion-mobile › "the bottom bar carries Inbox with its unread badge; Messages moves to More"; workspace › "phone thread composer stays above the mobile workspace navigation" | [D] iPhone. [S] 14, 08. |
| NP-MB-02 | needs-device | notion-mobile › "phone new page focuses title" (More → New page; focused title; "Saved on this device" offline); parity2-pages › "phone drawer…" (New page in Browse) | [D] keyboard up on an iPhone. [S] 14. |
| NP-MB-03 | needs-device | pages-nav › "phone: the page actions sheet lists every page action with 44px rows and closes three ways"; notion-mobile › "page sheet rows: Share, Find in page, Agent" | [D] iPhone. [S] 14. |
| NP-MB-04 | needs-device | notion-mobile › "keyboard toolbar complete" (every button, 44 px, rides the visualViewport, caret stays visible, dismiss) | [D] iOS keyboard and an external keyboard. |
| NP-MB-05 | needs-device | editor-blocks › "phones: no hover affordance — the caret's block gets a tap target that opens the same menu" | [D] no accidental drag while scrolling, on a device. |
| NP-MB-06 | partial | notion-mobile › "edge swipe goes back, else opens the drawer; mid-screen swipes are left to the page"; notion-swipe (4 tests: inbox rows read / archive, tree rows favorite / actions, reduced motion, sideways scrollers) | [B] no pull-to-refresh on any list; no swipe-to-restore in the Trash; the read / archive swipe is on Inbox rows, not Messages. Size S–M: lib/gestures + Inbox / Trash / Messages lists. [D] iPhone. |
| NP-MB-07 | needs-screenshot | parity2-pages › "phone drawer: favorites, recents, tree, tools, trash, new page and settings with 44px rows" (touch context: the 44 px rule is `@media (pointer: coarse)`; measured 30–38 px with a fine pointer); pages-nav › "phone: the drawer tree offers page actions in a sheet…"; mobile-navigation | [S] 14. The row ACTIONS (⋯, disclosure) are 36 × 36 px on touch — see NP-AX-07. |
| NP-MB-08 | needs-device | responsive-companion (2 tests); composer-growth (5 tests); mobile-navigation › "keyboard viewport hides navigation…"; notion-mobile › "keyboard toolbar complete" | [D] iPhone SE and Pro Max, landscape, safe areas. |
| NP-MB-09 | needs-device | editor-toolbar › "phones: the toolbar stays on screen with 44px targets" | [D] native selection handles, the iOS callout menu, long-press on a link. |
| NP-MB-10 | needs-device | parity2-shell › "tablet layouts" (1024×768 and 820×1180: persistent sidebar, hover peek, ⌘K and ⌘\); responsive-companion › "tablet companion overlays instead of squeezing the document…" | [D] iPad with pointer and external keyboard. |

### 2.11 Offline, sync and reliability

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-OF-01 | needs-screenshot | notion-sync-state › "desktop header: Saving… until the server confirms, Save failed · Retry, offline copy", "phone header sync state", "a save that conflicts with a newer server copy goes to review…"; parity2-shell › "footer reflects offline and waiting-for-server states" (header "Waiting for server"); outbox; `npm run verify:sync` | [S] 14, 16. |
| NP-OF-02 | passed | notion-offline › "offline read of cached page" (label "Offline copy from <time>", uncached page honestly unavailable), "favorites readable offline after prefetch" | — |
| NP-OF-03 | needs-device | outbox (12 tests); notion-outbox (13 tests); notion-offline-writes (5 tests); notion-collab-offline (4 tests: leave at once, reload, background sync); collab-storage | [D] airplane mode and a force-quit on an iPhone. |
| NP-OF-04 | needs-device | notion-offline › "favorites readable offline after prefetch" (per-page toggle), "offline copies: removed on request, evicted when access is revoked…"; notion-offline-cache (2 tests) | [D] iPhone. The last-20-opened prefetch is exercised only through the favourite + recently opened page. |
| NP-OF-05 | partial | notion-live › "remote edit appears within 2s", "a page created elsewhere appears in the tree within 2s", "a remote edit never replaces unsaved typing"; notion-live-safety (13 tests); `npm run verify:events`; server events.test, events-tree-flag.test | [T] an open DATABASE view refreshing on a remote change is not asserted in a fixture (the invalidation of note lists is unit-tested). |
| NP-OF-06 | passed | notion-sync-state › "desktop header: …Save failed · Retry…"; document-recovery (7 tests); notion-signout (3 tests); notion-offline › "…cleared at sign-out"; outbox › "switching accounts cannot replay another actor's saved changes"; notion-outbox › "M4/M5: sign-out warns about unsent changes…"; notion-collab-offline › "sign-out removes local live-document state…" | — |

### 2.12 Accessibility, theming and motion

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-AX-01 | partial | notion-a11y-axe › "<surface> · <viewport> · dark" (123 dark runs over 66 surfaces: no light panel, A11Y-RESULTS); editor-regressions › "the document companion stays dark in dark mode" | [T] the Light / Dark / System setting itself is not asserted (the sweep forces the class); surfaces outside the sweep (sign-in, published wiki, governance, map, people, messages, canvas). [D] native launch screen. [S] 09, 15. Pending pass-2 a11y branch. |
| NP-AX-02 | missing | notion-a11y-axe (structural rules only: tab stops in scrolling menus, activedescendant lists, no nested controls) | The named test "keyboard-only journey: create, format, share, database edit" is not on main. Pending pass-2 a11y branch. |
| NP-AX-03 | needs-device | notion-a11y-axe (246 / 246 surface runs: 0 serious or critical axe violations, tree / treeitem, menu / listbox roles, names on icon buttons) | [D] VoiceOver on macOS and iOS; live-region announcements are in the markup but nobody has listened. Pending pass-2 a11y branch. |
| NP-AX-04 | partial | notion-a11y-axe (axe color-contrast on every swept surface, both themes; suggestion marks keep strike / underline) | [T] the named test "contrast tokens AA" (token pairs) does not exist; non-text contrast (borders, icons, focus rings) and text over images are not checked. Pending pass-2 a11y branch. |
| NP-AX-05 | missing | — | Nothing checks 200 % zoom on main. [D] Dynamic Type XXL. Pending pass-2 a11y branch. |
| NP-AX-06 | partial | notion-a11y › "reduced motion disables transitions" (search sheet); notion-swipe › "reduced motion: the row does not slide…" | [T] menu, sheet and peek durations (120–180 ms) are not measured; the in-app Reduce motion setting is not asserted. [S] 15. Pending pass-2 a11y branch. |
| NP-AX-07 | missing | scattered ≥ 44 px point checks only (phone sheets, toolbar, search rows, drawer rows) | No sweep on main; the phone tree's row actions are 36 px by CSS (pages.css). Pending pass-2 a11y branch. |
| NP-AX-08 | partial | composer-growth › "composition Enter never sends…"; agent-composer-growth; notion-mentions › "@ menu offers people, pages, dates" (@ stays closed mid-composition) | [T] no slash-menu IME case; no double-insert case. [D] kana / pinyin keyboards and dictation on iOS. Pending pass-2 a11y branch. |

### 2.13 Native app

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-NA-01 | needs-device | apps/client cargo tests (PKCE, loopback, token exchange); notion-signout (3 tests); server device-auth.test | [D] sign in, sign out, sign in again on an iPhone and a Mac. |
| NP-NA-02 | needs-device | — | [D] Face ID / passcode lock, app-switcher blur. |
| NP-NA-03 | needs-device | server apns.test, push.test | [D] production APNs on a TestFlight build, tap-to-open, opt-out. |
| NP-NA-04 | missing | — | [B] the server serves no apple-app-site-association file and has no universal-link routing; the named test notion-links.spec › "page URL routes to page" does not exist. Size M: apps/server route + apps/client associated domains + main.tsx route test. [D] after that. |
| NP-NA-05 | needs-device | apps/client/scripts/verify-client.mjs | [D] icon, launch screen, rubber-band, status bar, in-app browser. |
| NP-NA-06 | needs-device | — | [D] background 10 minutes, resume. |
| NP-NA-07 | needs-device | — | [D] Mac: menus, shortcuts, windows, quick capture, export, drop. |

### 2.14 Performance budgets

| ID | Status | Evidence (spec › test) | Gaps and owed steps |
|---|---|---|---|
| NP-PF-01 | needs-device | PERF-RESULTS: desktop warm cache 419 / 427 ms (budget 2.0 s); iPhone proxy 1,172 / 1,200 ms | [D] iPhone 13-class device with Safari Web Inspector. Desktop: 5 samples (best / median), not p95 over 20 runs. |
| NP-PF-02 | partial | PERF-RESULTS: cached 65 / 80 ms (⌘K), 60 / 68 ms (tree); uncached 50 KB 185 / 204 ms | Within budget, but on 5 samples (best / median) against the fixture server: p50 / p95 over 20 runs and the production smoke [P] are owed. |
| NP-PF-03 | needs-device | PERF-RESULTS: keystroke to paint p50 13.1 / 13.2 ms; no long task in 375 keystrokes | [D] Safari timeline on a device. Desktop p50 is close to the 16 ms limit. |
| NP-PF-04 | partial | PERF-RESULTS: tree render 132 / 205 ms; scroll 60 fps (3,018 rows in the DOM, headless) | Within budget on 5 samples; 20 runs p50 / p95 and a non-headless FPS reading are owed. |
| NP-PF-05 | partial | PERF-RESULTS: open 25 / 49 ms, title 6 / 10 ms; full-text 238 / 257 ms in the UI (server p95 9.9 ms over 20 runs) | Vault time is not in the full-text figure: the production smoke [P] is owed, plus 20 UI runs. |
| NP-PF-06 | partial | PERF-RESULTS: first paint 662 / 702 ms; sort 41 / 49 ms; search filter 385 / 391 ms; scroll 60 fps (100 rows in the DOM); /api/query p95 18.7 ms over 20 runs | Within budget on 5 samples; scrolling through all 5,000 loaded rows was not measured. |
| NP-PF-07 | needs-device | PERF-RESULTS: web proxy 60.8 MB JS heap after 50 opens, flat | [D] Xcode Instruments on an iPhone, 30 minutes. |
| NP-PF-08 | passed | PERF-RESULTS: initial JS 417.5 KB gzip (budget 600); guard `npm run check:initial -w @prism/web`; `npm run perf:bundle` | — |
| NP-PF-09 | not-measured | PERF-RESULTS: browser side 12 requests / min for 3 tabs; server → vault 92 calls / min BEFORE the reconciler gate (cda6d93, d4a7d00); server reconciler-gate.test | The vault side has not been re-measured since the gate, and never with the iOS app or for 30 minutes: run apps/server/scripts/measure-idle-clients.ts against a sandbox vault with a live subscribe socket. |
