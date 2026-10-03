# Notion parity — evidence log (wave 3D review)

Reviewer: wave 3D verification agent (independent of the implementing groups). Date 2026-10-03. Product code under review: main `c5afd09`. New/strengthened specs and one small fix are on `feat/w3-verify` (`dd55c20`, `445f798`) and count only once merged.

## How to read this

- **passed** — the row's Verify column is fixture-only (no S/D), the named tests assert every acceptance clause, and they pass on Chromium and WebKit. The 4-variant screenshots of checklist §1.1 are still owed for these rows in the §4 step-4 contact sheet.
- **needs-screenshot / needs-device** — the fixture part is verified; the S (mockup / Notion comparison) or D (physical device) step in the Verify column has not been done.
- **partial** — something in the acceptance text is not met or not asserted; the last column says exactly what. `PRODUCT:` marks behaviour the app does not have (not a missing test).
- **missing** — not built, or no verification exists. **not-measured** — performance rows (3C).
- Criteria the product does not meet are recorded as `test.fixme` in the specs, never weakened.

## Runs

`E2E_PORT=5323 npx playwright test -c playwright.parity.config.ts --project=<browser> --workers=2` (config added in `dd55c20`; the default config is Chromium-only).

| Browser | Result (main c5afd09 specs) | After re-running each failure alone ×3 |
|---|---|---|
| Chromium | 763 passed, 4 failed, 1 skipped | `thread-reading:160` fails (known, fixed elsewhere); `pages-nav:70` raced the tree refetch — spec fixed; `companion-density:17` flaky under load (1/3 alone); `editor-upload:64` passes alone |
| WebKit | 741 passed, 28 failed (+2 of the new tests), 6 skipped | **Cannot run on WebKit (spec, not product):** `notion-editor:14` and `pages-nav` page ⋯ menu (`grantPermissions clipboard-write` unsupported), `notion-mentions:26` (Chromium-only CDP session for IME), `notion-mobile:20` (`new Touch()` illegal on desktop WebKit). **Flaky alone (2/3 fail):** `companion-density:56`, `editor-blocks:366`, `selection-agent:48`, `selection-agent:73`. **Pass alone ×3:** all 14 `outbox.spec` tests, `agent:124`, `context-history:161`, `creation-entrypoints:24`, `navigation` sidebar preferences. `thread-reading:160` fails as on Chromium. |

The WebKit run is not part of the default `npm run test:e2e`; §4 step 3 needs it green, so the four spec incompatibilities and four flakes above block the gate independently of any row.

## Rows

| ID | Status | Owner | Verification (spec › test, what it asserts) | Missing |
|---|---|---|---|---|
| NP-SB-01 | partial | 3D spec + S | navigation.spec › writing navigation… (switcher above tree, vault list, Manage workspaces & vaults), workspace-session › vault switch / late reads, shortcuts › each vault keeps its own favorites | Tree contents after a switch and the phone switcher's top position are not asserted; S 01/14 not compared. |
| NP-SB-02 | partial | 3D (fix on branch 445f798) + S | notion-search › ⌘K opens while typing in the editor and Esc returns to the caret; search.spec | Caret return needed a product fix that is on feat/w3-verify, not main. Sidebar search is an inline field, not asserted as a row; S 11. |
| NP-SB-03 | needs-screenshot | reviewer | notion-home › home shows recents, upcoming events, my tasks (all clauses) | Notion reference capture. 'My tasks' = assigned-to-me is being closed by the gaps group. |
| NP-SB-04 | partial | gaps group (product) | pages-nav › favorites and recents sync through the server; page ⋯ menu | PRODUCT: no reorder of favorites (drag or keyboard), no star from ⌘K. Named test 'favorites reorder by drag and keyboard' does not exist. |
| NP-SB-05 | partial | gaps group (product) | pages-nav › ⌘K lists recent pages first; favorites and recents sync | PRODUCT: synced recents are capped at 50 and all rendered (lib/pages/model.ts:204, Navigation.tsx:218), not 12. Collapse and second-device recents unasserted. |
| NP-SB-06 | partial | gaps group (product) | pages-nav › a page with sub-pages is one node | PRODUCT: tree expansion is in-memory only (lib/pages/store.ts:50), not persisted per device. Row icons and phone tree unasserted; S. |
| NP-SB-07 | partial | gaps group (product) | pages-nav › phone drawer sheet; tree menu used in three tests | PRODUCT: no 'Open in new tab'. Hover reveal, Favorite/Duplicate/Copy link/Rename in the tree menu and long-press unasserted; named test 'tree row hover + and ⋯' does not exist. |
| NP-SB-08 | partial | 3D spec | pages-nav › drag and drop reparents a page and reorders siblings (race fixed in dd55c20) | Drop line / target highlight and order after reload are not asserted. |
| NP-SB-09 | passed | — | notion-sharing › guest sidebar shows only shared pages; guest sees only shared content everywhere (real server) | — |
| NP-SB-10 | passed | — | pages-nav › Trash: delete moves to Trash with Undo… (search, restore, two-step delete, retention notice, Undo toast) | — |
| NP-SB-11 | partial | gaps group (product) | none | PRODUCT: ⌘\ toggles the context panel (useKeyboardShortcuts.ts:31; sidebar is ⌘B); sidebar width and collapsed state are not persisted (app/stores/ui.ts). Named test does not exist. |
| NP-SB-12 | needs-screenshot | reviewer | notion-sidebar › collapsed sidebar peeks on edge hover; …reachable and dismissible from the keyboard | Notion reference capture. |
| NP-SB-13 | partial | 3C (timing) + S | notion-sidebar › one action → focused untitled page; pages-nav; notion-home | The spec allows 1500 ms, the row says < 300 ms (NP-PF territory); ⌘N only arrives in the native app (D). |
| NP-SB-14 | needs-screenshot | reviewer | navigation › writing navigation…; sidebar preferences… (Tools collapsible, all four tools reachable) | S 14. The row's example names (Network, Agent activity, Dashboards) are not tools in the product. |
| NP-SB-15 | partial | 3D spec + S | notion-sync-state › footer reflects sync state | Footer 'Offline · saved on this device' and 'Waiting for server' not asserted (header variants are); S 01/16. |
| NP-PG-01 | partial | gaps group (product) + spec | none (named test missing) | PRODUCT: icon is not shown in tabs, breadcrumbs or favorites (no metadata.icon read in TabBar/Breadcrumbs/Navigation). Picker, tree, ⌘K, chips exist but no spec. |
| NP-PG-02 | partial | 3D spec + D | notion-page-cover › cover add, reposition, remove; cover renders cropped on phone and in dark | A cover from a valid link is not asserted (only the refusal); D and Notion reference. |
| NP-PG-03 | partial | gaps group (product) | document-polish; workspace › document title supports keyboard rename; pages-nav | PRODUCT: Enter in the title commits but does not move into the body (DocumentChrome.tsx:41). Placeholder, live rename in tabs/breadcrumbs and collab title sync unasserted. |
| NP-PG-04 | needs-screenshot | reviewer | pages-nav › breadcrumbs open parent pages, reveal folders, and collapse long trails | S 01/13. |
| NP-PG-05 | partial | 3D spec + S | page-properties (6 tests); notion-db-props › relation | URL and checkbox editors in the page bar and the 3–5 pinned rule are not asserted (no cap constant found in PropertyBar); S 12. |
| NP-PG-06 | partial | 3D spec + S | notion-page › header carries save state, Share, Agent, ⋯; notion-sync-state; notion-presence | Agent activity dot not asserted; breadcrumb sits above the title, not in the bar (recorded deviation). |
| NP-PG-07 | partial | gaps group (product) | pages-nav › page ⋯ menu…; integration-owned pages… | PRODUCT: no 'Open in new tab'; Trash gives no reason for integration pages. WebKit: the test cannot run (grantPermissions clipboard-write unsupported). |
| NP-PG-08 | partial | 3D spec + S | notion-page › full width, small text, font persist per page | Not asserted in a live collab document; S 15. |
| NP-PG-09 | partial | 3D spec | pages-nav › page ⋯ menu (lock/unlock); server pages-review.test (423) | Named test 'locked page refuses agent writes' does not exist; no MCP-specific lock test found. |
| NP-PG-10 | needs-screenshot | reviewer | notion-page › backlinks pill lists linking pages | S 12. |
| NP-PG-11 | partial | gaps group (product) | document-polish › outline opens without moving the selection… | PRODUCT: the outline does not highlight the current section (DocumentOutline.tsx). |
| NP-PG-12 | partial | 3D spec + S | context-history (10 tests) | Day grouping, the 'compare with version before' switch and the consequence line exist but are not asserted; S 13. |
| NP-PG-13 | needs-screenshot | reviewer | notion-history › versions name their author kind | S 13. |
| NP-PG-14 | partial | 3D spec + S | notion-page › empty page starters vanish on typing | 'Ask agent' starter not asserted (conditional in EmptyPageStarters.tsx:74). |
| NP-PG-15 | partial | gaps group (product) | pages-nav › …adds a page inside | PRODUCT: no /page slash item, no page-link block inserted in the parent, no trash offer when the block is deleted. |
| NP-PG-16 | partial | 3B (deep link) + D | pages-nav › page ⋯ menu… copy link | Opening the copied URL and its access check are not asserted (fixtures do not boot main.tsx routing); D. |
| NP-PG-17 | passed | — | notion-page › page info footer; pages-nav › page ⋯ menu ends with the page info footer | — |
| NP-ED-01 | partial | gaps group (product) | editor-blocks › hover/drag, live move, read-only, one undo step | PRODUCT: no multi-block selection drag (BlockHandles drags one block). Drop line unasserted. |
| NP-ED-02 | partial | gaps group (product) | editor-blocks › the block menu turns blocks into every kind… | PRODUCT: block menu has no Copy, Move to (another page), Comment, Ask agent or search field. Named test 'block menu Move to another page' does not exist. |
| NP-ED-03 | needs-screenshot | reviewer | editor-slash (6 tests) | S 01/14. Markdown hints show only on items without a shortcut; Agent group asserted in selection-agent. |
| NP-ED-04 | partial | gaps group (product) | notion-editor › markdown shortcuts convert as you type (every listed prefix + inline marks + ---); wikilinks › [[ | PRODUCT: (1) ⌘Z after a conversion leaves an empty line, not the literal characters — fixme 'markdown shortcuts convert and undo to literal'; (2) no `>>` toggle rule (Typography makes »). |
| NP-ED-05 | partial | gaps group (product decision) | editor-toolbar › ⌘B ⌘I ⌘U ⌘⇧S ⌘E toggle marks from the keyboard; bold, italic… (buttons) | PRODUCT: ⌘K in the editor opens quick find (conflicts with NP-SB-02), ⌘⇧H opens Replace (SearchHighlight.ts:84). fixme '⌘K link, ⌘⇧H highlight'. |
| NP-ED-06 | partial | gaps group (product) | editor-blocks › Alt/Option+Shift+↑/↓…; ⌘/ opens the block menu | PRODUCT: no Esc block selection, ⌘⇧↑/↓, ⌘D, ⌘↵, Backspace on a selected block. Tab/⇧Tab nesting unasserted. |
| NP-ED-07 | missing | 3D per §3 — not built under the test-only rule | none (shortcuts.spec.ts is about favorites) | PRODUCT: no shortcut sheet exists anywhere; ⌘/ outside a block does nothing. |
| NP-ED-08 | partial | gaps group (product) | editor-slash › every slash block inserts…; collapsing a toggle… | PRODUCT: no toggle headings; toggle open state is deliberately view-only (the row says stored). H2/H3/lists via slash, numbering, nesting unasserted. |
| NP-ED-09 | partial | gaps group (product) | editor-slash › columns (2, 3) and phone stacking | PRODUCT: 4–5 columns, drag-to-side and gutter resize do not exist (blocks.ts column{2,3}). |
| NP-ED-10 | partial | gaps group (product) | editor-table (3 tests) | PRODUCT: no header column, no cell background colour. Column resize and Tab-to-next-cell exist but are not really asserted. |
| NP-ED-11 | partial | 3C/§4 (WebKit harness) | notion-editor › code block language picker, copy, wrap (all clauses, Chromium) | WebKit: the test cannot run (grantPermissions clipboard-write unsupported) — no WebKit pass. |
| NP-ED-12 | needs-device | gaps group (published/copied attachments) + device | editor-upload (6); notion-editor › image resize, caption, lightbox | Published pages and copied pages cannot load attachments (being closed elsewhere); click-to-lightbox in edit mode unasserted; D. |
| NP-ED-13 | needs-device | device | notion-media › file, pdf, audio, video blocks | Native Finder/Files drop is D (the fixture pastes). |
| NP-ED-14 | passed | — | notion-media › pasted URL offers bookmark card; server unfurl.test | — |
| NP-ED-15 | needs-device | owner decision (native frame-src) + device | notion-media › allowlisted embeds render; others fall back | Google Maps and Sheets not in the asserted cases; in the iOS/Mac app embeds are 'Open in…' cards until the owner approves a client CSP — contradicts 'works in the iOS app'. |
| NP-ED-16 | partial | 3D spec | editor-toolbar › text colour and highlight come from the token palette; editor-blocks (block background) | Dark-mode equivalents and block text colour not asserted. |
| NP-ED-17 | partial | gaps group (product) + S | editor-toolbar (7); selection-agent | PRODUCT: no Mention button in the selection toolbar (only the phone keyboard toolbar). iOS callout is D. |
| NP-ED-18 | partial | gaps group (product) | editor-toolbar › links are typed inline, validated, applied and removable | PRODUCT: ⌘K does not open the link editor; no hover card (Open/Edit/Remove); internal URL does not become a page mention; paste-over-selection unverified. |
| NP-ED-19 | passed | — | notion-editor › toc block tracks headings | — |
| NP-ED-20 | passed | — (spec dd55c20) | notion-editor › undo covers block ops; collab undo is per-user (typing, move, turn into, colour, delete, table row: ⌘Z + ⌘⇧Z; live pair: B's undo keeps A's edit) | Passes Chromium + WebKit alone ×3; one WebKit failure under full-suite load. |
| NP-ED-21 | partial | gaps group (product) | notion-editor › paste fidelity from Notion/GDocs/Markdown (HTML from Notion, Google Docs, Word, web: headings, lists, links, table, code, image; wikilink text); wikilinks.spec | PRODUCT (fixme tests): pasted to-do lists lose their checkboxes; plain Markdown text is pasted literally; copying out gives no Markdown. |
| NP-ED-22 | partial | gaps group (product) | notion-editor › find in page counts and steps (⌘F, count, next/previous, wrap, highlight, Esc) | PRODUCT: no phone entry from ⋯ (fixme). ⌘F in read-only collab docs is being closed elsewhere. |
| NP-ED-23 | passed | — | notion-editor › replace and replace all; …live document…; replace keeps offsets… | — |
| NP-ED-24 | partial | 3A (export) + 3D spec | editor-table › live editor…; server editor-blocks.test, editor-blocks-v4.test | Named test 'block round-trip through publish and export' does not exist; MCP edit, publishing render and export content are not asserted. |
| NP-ED-25 | partial | gaps group (product) | editor-regressions › a focused editor does not draw a box… | PRODUCT: no placeholder is rendered at all (Placeholder is configured, no CSS shows it); no heading or list-item hints. |
| NP-RF-01 | partial | gaps group (product) | wikilinks (3 tests) | PRODUCT: no "Create page '<query>'" (dropdown hides on no match); no icon in rows. |
| NP-RF-02 | partial | 3D spec (WebKit) | notion-mentions › @ menu offers people, pages, dates | WebKit: fails 3/3 — the IME step uses a Chromium-only CDP session. 'next Monday' and ISO dates unasserted. Mentioning members without a person note is being closed elsewhere. |
| NP-RF-03 | needs-screenshot | reviewer | notion-mentions › person mention hover card + notifies; server notifications.test | S 09. |
| NP-RF-04 | passed | — | notion-mentions › page mention tracks rename; no-access state | — |
| NP-RF-05 | passed | — | notion-mentions › date chip edit and relative display | — |
| NP-RF-06 | partial | 3D spec + D | notion-mentions › reminder lands in inbox at time | Opening the item scrolled to the block and editing a reminder's time are not asserted; push is D. |
| NP-RF-07 | partial | 3D spec | notion-mentions › mention appears in target backlinks | Only a page mention is asserted; the person-mention backlink is not. |
| NP-DB-01 | partial | gaps group (product) | boards › a task board opens as a database…; notion-editor › inline database (sub-page) | PRODUCT: no database entry in the New page menu and no slash 'Database – full page'. 'Open as database' from a tag exists but no fixture mounts TagView. Named test missing. |
| NP-DB-02 | passed | — | notion-db-inline › inline linked board inside a page; notion-editor › inline database: slash → new table view, and a linked view | Per-view sort independence and the board/gallery/list/calendar slash variants are not driven. |
| NP-DB-03 | partial | gaps group (product) | databases › table: typed cells…; filter, header sort, hide and resize…; phone sticky | PRODUCT: no arrow-key or Tab cell navigation. Column reorder (View settings), Esc cancel, desktop frozen column, 'Use theirs' unasserted; named test missing. |
| NP-DB-04 | partial | gaps group (product) + S | databases › board: move by menu and by drag…; new rows… | PRODUCT: empty groups cannot be hidden. Group by person, within-column order, Move earlier/later, Open unasserted. |
| NP-DB-05 | partial | gaps group (product) | databases › gallery, list and calendar…; gallery card size and cover | PRODUCT: no S/M/L card size (the test named 'size' never sets one). |
| NP-DB-06 | partial | 3D spec | databases › gallery, list and calendar render the same rows | Chosen properties on list rows are not asserted. |
| NP-DB-07 | partial | gaps group (product) | databases › …calendar adds on a day; UTC datetime lands on its local day | PRODUCT: no drag to reschedule, no multi-day bar. Month navigation exists, unasserted; named test missing. |
| NP-DB-08 | partial | gaps group (product) | databases; page-properties; notion-db-props | PRODUCT: no number format, no date range/time, status has no groups. Multi-select/URL editors and most per-type filters and sorts unasserted. |
| NP-DB-09 | passed | — | notion-db-props › email, phone, files properties | — |
| NP-DB-10 | passed | — | notion-db-props › system properties sort and filter | The second sort assertion is weak (same first row either way). |
| NP-DB-11 | partial | gaps group (product + server) | page-properties › owner adds a typed property and a new option…; viewers see properties without edit affordances | PRODUCT: no rename, no retype with preview, no option rename/colour/reorder, no delete (PUT /api/schemas is additive-only). Named test missing. |
| NP-DB-12 | partial | gaps group (product) | notion-db-props › relation picker and reverse property | PRODUCT: relation chips do not open the related page; the reverse side is a read-only computed list, not a property. |
| NP-DB-13 | partial | 3D spec | databases › table: filter…; AND/OR filter groups; notion-db-inline | Operators-per-type are never read; only eq / exists / lt / contains are driven in the UI (engine covered by server database-engine.test). |
| NP-DB-14 | passed | — (spec dd55c20) | databases › multi-level sort (two levels from the Sort menu, saved per view, flip and remove); table: filter, header sort… | — |
| NP-DB-15 | passed | — | notion-db-views › table group by with counts | — |
| NP-DB-16 | partial | gaps group (product) | databases › adding a view…; viewer: …session-only view changes; a saved view is renamed and deleted from View settings | PRODUCT: views cannot be duplicated or reordered (fixme). |
| NP-DB-17 | passed | — | notion-db-views › database search box | — |
| NP-DB-18 | needs-screenshot | reviewer | notion-db-views › side peek, center peek, full page; side peek: phones always open the full page | Notion reference. Editing the body inside the peek is not asserted. |
| NP-DB-19 | passed | — | notion-db-views › database template applies on new row | — |
| NP-DB-20 | partial | 3D spec | databases › adding a view and opening a row; page-properties | Editing the row's body and 'renaming the row updates the view' are not asserted. |
| NP-DB-21 | passed | — | notion-db-views › bulk edit and bulk trash with undo | — |
| NP-DB-22 | passed | — | databases › viewer: read-only cells, hidden private rows…; page-properties › viewers…; server databases.test | Editor-but-not-owner schema case is server-tested only. |
| NP-DB-23 | partial | gaps group (product) + S | databases › phone: sticky first column, no page overflow, filters in a sheet | PRODUCT: database boards do not default to list on phone (only legacy task boards do). |
| NP-DB-24 | needs-screenshot | reviewer | boards › per-column add, card menu, due chips; a task board opens as a database… | S 20. The scroll-affordance assertion is skipped when all columns fit. |
| NP-DB-25 | partial | gaps group (product) | notion-db-csv › csv import preview and export | PRODUCT: import only into the open database, not into a new one. |
| NP-CO-01 | partial | 3D spec + S | notion-mentions › comment mention, edit own, reopen; editor-toolbar › live editor Comment; suggest-only | Delete own and the phone sheet presentation are not asserted. |
| NP-CO-02 | missing | gaps group (product) | none | PRODUCT: no page-level (unanchored) discussion exists. |
| NP-CO-03 | partial | gaps group (suggestion notifications) | notion-inbox › inbox lists mentions, replies, shares; mark read; mark all read clears the badge with one write; notion-mobile › bottom bar Inbox badge | PRODUCT: no accepted/rejected-suggestion items (being closed elsewhere). LOW: 'Mark all read' stays enabled after everything is read. Deep link to a comment thread unasserted; S Notion. |
| NP-CO-04 | needs-device | device | notion-inbox › notification settings respected; server notifications.test | Push/APNs/email delivery is D. |
| NP-CO-05 | needs-screenshot | reviewer | sharing.spec; notion-sharing › sub-pages inherit…; workspace-access | S 23. A successful remove and the five level labels as a set are not asserted. |
| NP-CO-06 | needs-screenshot | reviewer | sharing › links use the selected expiry…; notion-sharing | S 23. Successful revoke unasserted; guest-invite account creation is server-tested. |
| NP-CO-07 | needs-screenshot | reviewer | notion-sharing › share dialog is a phone sheet with underline tabs… | S 23 only. |
| NP-CO-08 | partial | gaps group (product) + S | sharing › publishing and peer sync retain their independent controls… | PRODUCT: the Publish tab publishes directly — no preview or hand-off to the studio. Per-tag explanation exists, unasserted. |
| NP-CO-09 | passed | — | notion-sharing › sub-pages inherit and show source; pages-nav › Move to… confirms first…; server page-grants.test | — |
| NP-CO-10 | partial | 3D spec | notion-presence (one remote caret with its name) | Named test 'remote caret name tags' does not exist; several collaborators and colour distinct from the agent are not asserted. |
| NP-CO-11 | needs-screenshot | reviewer | notion-presence › header avatars and jump to cursor (real server) | S 03/15/18. |
| NP-CO-12 | partial | gaps group (live suggest editor in workspace) | suggestion-review; suggestions; suggest-only › suggest-only human cannot edit directly (real server) | Inside the workspace a suggest person gets the propose draft, not the live suggest editor (being closed elsewhere). Accept all never clicked; no 'Needs refresh' label; Undo after accept unasserted. |
| NP-CO-13 | needs-screenshot | reviewer | notion-sharing › request access → owner approves | S 16. Deny and the read-only-page request are server-tested / unasserted in the UI. |
| NP-CO-14 | partial | 3D spec | notion-sharing › guest sees only shared content everywhere (API level, real server); guest sidebar | ⌘K, @-mention candidates, inbox and database UI for a guest are not driven. |
| NP-CO-15 | needs-screenshot | reviewer | notion-history › page updates feed | S 13. |
| NP-SR-01 | partial | gaps group (product) | pages-nav › ⌘K lists recent pages first; search.spec | PRODUCT: no ⌘↵ open in new tab; no edited date in rows. <100 ms unmeasured. |
| NP-SR-02 | needs-screenshot | reviewer | search › palette prioritizes readable notes…; saved-note-handoff › command search has a separate keyboard action | S 11. |
| NP-SR-03 | needs-screenshot | reviewer | notion-search › match highlighting | S 11. |
| NP-SR-04 | partial | 3D spec + S | notion-search › filters narrow results; vault scope… | Date range is selected but never shown to narrow; the control is 'Edited by', 'created by' unasserted. |
| NP-SR-05 | partial | gaps group (product) | search › search shows ranked passages and openly labels keyword fallback | PRODUCT: ranked and keyword results are never blended (useParachute.ts:66). |
| NP-SR-06 | partial | gaps group (product) | pages-nav (Open Trash); creation-entrypoints; workspace | PRODUCT: no Toggle theme command; no shortcut hints on commands. |
| NP-SR-07 | partial | gaps group (product) | open-documents › tab keyboard reorder… (Back/Forward buttons); notion-mobile edge swipe | PRODUCT: no ⌘[ / ⌘]; scroll position is not restored. Named test missing. |
| NP-SR-08 | partial | gaps group (product) + D | search › phone search contains focus…; dark phone search filters fit | PRODUCT: phone search is a 78dvh bottom sheet, not full-screen. Phone recents unasserted. |
| NP-TX-01 | partial | 3A | pages-nav › New page from template copies… | Owned by 3A (in progress): save as template, gallery. |
| NP-TX-02 | missing | 3A | none | Owned by 3A. |
| NP-TX-03 | partial | 3A | pages-nav › page ⋯ menu… export (file name only) | Owned by 3A: sub-pages/images zip, PDF; D. |
| NP-TX-04 | missing | 3A | none | Owned by 3A. |
| NP-TX-05 | missing | 3A | none | Owned by 3A. |
| NP-TX-06 | missing | 3A | none | Owned by 3A. |
| NP-AI-01 | partial | gaps group (product) | selection-agent (8 tests incl. ⌘J and slash attach to the existing session without starting another); agent.spec; notion-page | PRODUCT: no 'Ask agent' in the block menu; the header Agent button opens the panel but attaches no selection. |
| NP-AI-02 | partial | 3D spec + S | suggestion-review; suggestions; agent › session permission selector…; notion-history | Fixtures seed the marks: an agent edit arriving as suggestions and a Read-write edit producing the attributed version are server-tested only (mcp-collab.test); no explicit refresh-when-stale control. |
| NP-AI-03 | partial | gaps group (product) | agent-summary (7); agent-reply (11); agent.spec (sources) | Summarise/draft are proven for message and email threads only; there is no page/selection summarise or transform action beyond generic chat. reply-agent.spec.ts does not exist (agent-reply.spec.ts). |
| NP-MB-01 | needs-device | device | mobile-navigation › labeled destinations…; keyboard viewport hides navigation…; notion-mobile | Reply composer owning the bottom edge is unasserted; D. |
| NP-MB-02 | needs-device | device | notion-mobile › phone new page focuses title | The test goes More → New page (two taps); D. |
| NP-MB-03 | partial | gaps group (product) + D | pages-nav › phone: the page actions sheet lists every page action with 44px rows and closes three ways; phone drawer sheet | PRODUCT: the sheet has no Share, Find or Agent rows. |
| NP-MB-04 | needs-device | device | notion-mobile › keyboard toolbar complete | Nine buttons are presence-only; iOS keyboard is D. |
| NP-MB-05 | needs-device | device | editor-blocks › phones: no hover affordance… | Tap target asserted ≥32 px (AX-07 wants 44); D. |
| NP-MB-06 | partial | gaps group (list swipe actions) + D | notion-mobile › edge swipe goes back, else opens the drawer… | PRODUCT: no row swipe actions, no pull-to-refresh (being closed elsewhere). WebKit: the test fails 3/3 (new Touch() is illegal on desktop WebKit). |
| NP-MB-07 | partial | 3D spec + S | pages-nav › phone drawer; mobile-navigation | Favorites, Recents, disclosure, Tools, Trash, Settings and 44 px rows are not asserted in the phone drawer. |
| NP-MB-08 | needs-device | 3B / device | responsive-companion; composer-growth; mobile-navigation landscape; notion-mobile | Safe areas and keyboard-vs-composer are D; 16 px inputs measured in one place. |
| NP-MB-09 | needs-device | 3B / device | editor-toolbar › phones: the toolbar stays on screen with 44px targets | No link long-press preview found in the editor; rest is D. |
| NP-MB-10 | partial | 3B/3C + D | responsive-companion › tablet companion overlays… (1024) | Named test 'tablet layouts' does not exist; 820×1180 and sidebar behaviour unasserted. |
| NP-OF-01 | needs-screenshot | reviewer | notion-sync-state (4 tests); outbox; notion-offline-writes | S 14/16. 'Waiting for server' label and phone Saving/Failed states unasserted; recovery.spec.ts does not exist. |
| NP-OF-02 | partial | gaps group (product) | notion-offline › favorites readable offline after prefetch; document-recovery › a failed first read… | PRODUCT: no 'Offline copy from <time>' label anywhere. Named test missing. |
| NP-OF-03 | needs-device | device | outbox (12); collab-storage; notion-offline-writes; notion-collab-offline; notion-outbox | App kill / airplane mode is D. Known: leaving within ~100 ms of the last keystroke with the socket down loses it. |
| NP-OF-04 | needs-device | device | notion-offline (2); notion-offline-cache | Last-20 recents prefetch unasserted; D. |
| NP-OF-05 | partial | gaps group (product) | notion-live › a remote change event re-reads the open page from the server; document-recovery; editor-blocks live | PRODUCT (two fixme tests): an open plain editor never adopts the re-read content; the sidebar tree query ["vault","tree"] is not invalidated by note events. |
| NP-OF-06 | passed | — | notion-sync-state; document-recovery; notion-offline › …cleared at sign-out; outbox › switching accounts…; notion-offline-writes; notion-outbox; collab-storage | WebKit: outbox.spec failed 14 tests in the full run but passes alone ×3 (load/ordering). Sign-out button in the web app is being closed elsewhere. |
| NP-AX-01 | partial | 3C | editor-regressions › the document companion stays dark… | Owned by 3C: no dark sweep over menus/peeks/databases/share. |
| NP-AX-02 | missing | 3C | none (named test missing) | Owned by 3C. |
| NP-AX-03 | missing | 3C | none; @axe-core/playwright is not installed | Owned by 3C. PRODUCT: the tree has no role=tree/treeitem. |
| NP-AX-04 | missing | 3C | none (one contrast check in settings-presentation) | Owned by 3C. |
| NP-AX-05 | missing | 3C | none (brand.spec zooms the brand page only) | Owned by 3C; D. |
| NP-AX-06 | partial | 3C | notion-a11y › reduced motion disables transitions (search sheet only) | Menus, sheets and peeks unmeasured; S 15. |
| NP-AX-07 | missing | 3C | none (scattered ≥44 px point checks) | Owned by 3C: no sweep. |
| NP-AX-08 | partial | 3C + D | agent-composer-growth; composer-growth (IME Enter never sends) | No editor IME case for slash/@ in the named form; D. |
| NP-NA-01 | needs-device | 3B / device | cargo test (client) | Native row; sign-out button is being closed elsewhere. |
| NP-NA-02 | needs-device | 3B / device | — | Native row. |
| NP-NA-03 | needs-device | 3B / device | server apns tests | Native row. |
| NP-NA-04 | missing | 3B | none (notion-links.spec.ts does not exist) | Native row: universal links / AASA. |
| NP-NA-05 | needs-device | 3B / device | verify-client.mjs | Native row. |
| NP-NA-06 | needs-device | 3B / device | — | Native row. |
| NP-NA-07 | needs-device | 3B / device | — | Native row. |
| NP-PF-01 | not-measured | 3C | — | Owned by 3C: not measured. |
| NP-PF-02 | not-measured | 3C | — | Owned by 3C: not measured. |
| NP-PF-03 | not-measured | 3C | — | Owned by 3C: not measured. |
| NP-PF-04 | not-measured | 3C | — | Owned by 3C: not measured. |
| NP-PF-05 | not-measured | 3C | — | Owned by 3C: not measured. |
| NP-PF-06 | not-measured | 3C | — | Owned by 3C: not measured. |
| NP-PF-07 | not-measured | 3C | — | Owned by 3C: not measured. |
| NP-PF-08 | not-measured | 3C | — | Owned by 3C: not measured. |
| NP-PF-09 | not-measured | 3C | — | Owned by 3C: not measured. |

## Counts

- partial: 83
- passed: 20
- needs-screenshot: 19
- needs-device: 18
- missing: 12
- not-measured: 9
