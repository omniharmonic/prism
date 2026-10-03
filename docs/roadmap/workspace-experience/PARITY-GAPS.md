# Notion parity — what is left to reach 161 / 161

Written 2026-10-03 from the second verification pass at main `d4a7d00`. Evidence per row: [PARITY-EVIDENCE.md](PARITY-EVIDENCE.md). The gate itself: [NOTION-PARITY-CHECKLIST.md](NOTION-PARITY-CHECKLIST.md).

| Status | Rows | First pass |
|---|---|---|
| passed | 52 | 20 |
| deviation (built; owner decision pending) | 5 | — |
| needs-screenshot | 30 | 19 |
| needs-device | 26 | 18 |
| partial | 43 | 83 |
| missing | 4 | 12 |
| not-measured | 1 | 9 |

So **109 rows are not passed**. Of those: 56 wait only for a person (30 screenshot reviews, 26 device checks), 5 for an owner decision, and 48 need work (43 partial, 4 missing, 1 not measured). "Passed" means passed on Chromium; one WebKit run of the whole suite is still owed (b.1).

Nothing here is marked done to improve a number. A row leaves this file only when its evidence is on main.

Sizes: **S** = under a day, one or two files. **M** = one to three days, a new component or route. **L** = more than that.

---

## (a) Build gaps — behaviour that is missing or different

### a.1 Behaviour gaps, by slice

Each slice owns the files named. Nothing here touches the collab schema, so no `COLLAB_SCHEMA_VERSION` bump is expected.

| Slice | Row · clause | What is missing | Where it goes | Size |
|---|---|---|---|---|
| **A · Editor links** | NP-ED-18 · "Hovering a link shows the URL with Open, Edit and Remove" | No hover card. A link is opened or edited only through the selection toolbar. | New `packages/core/src/lib/tiptap/LinkHover.ts` (plugin) + a small popover beside `components/renderers/SelectionActions.tsx`; reuse `EDIT_LINK_EVENT`. Spec: `editor-toolbar.spec.ts`. | S |
| | NP-ED-18 · "Pasting an internal Prism URL becomes a page mention" | A pasted `/page/<id>` URL is treated like any other URL (link + "Paste as" menu). | `lib/tiptap/UrlPaste.ts`: recognise our own origin + `/page/<id>`, insert the `mention` node (`kind: page`) directly. Spec: `notion-media.spec.ts` or `notion-mentions.spec.ts`. | S |
| **H · Title rename** | NP-PG-03 · "A rename shows live in the tree, tabs and breadcrumbs" | **Found in this pass.** Renaming a page that has sub-pages from its title PATCHes only that note's path: the sub-pages stay under a plain folder with the old name. A non-owner's title rename is a path PATCH, which the gateway refuses (`move_required`). The tree's Rename is correct (it uses the move route). | `packages/core/src/components/renderers/DocumentRenderer.tsx` `handleRename` and `apps/web/src/collab/CollabDoc.tsx` `handleRename` → the move route (`usePageActions.move(page, { newPath })` / `POST /api/notes/:id/move`). Un-fixme `parity2-pages.spec.ts › "renaming a page with sub-pages from its title keeps them under it"`. | S |
| ~~**B · Templates**~~ | ~~NP-TX-01 · "Save as template is in the page ⋯ menu"~~ | **Closed (feat/w8-gaps-b).** Page ⋯ → "Save as template" (body, icon, cover, properties, tags, own copies of files; never identity / visibility / lock / ingest keys). | `lib/pages/model.ts` `templateSource`, `usePageActions.saveAsTemplate`. Spec: `notion-templates.spec.ts › "save page as template"`. | done |
| | ~~NP-TX-01 · "A Templates gallery lists, edits and deletes templates"~~ | **Closed (feat/w8-gaps-b).** `components/pages/TemplatesGallery.tsx`: Use, Edit, Rename, Delete (Trash + Undo), from the chooser, the command bar and the save toast. Not browser-tested: saving a LIVE (collaborative) page — the editor-state copy is unit-tested only. | Specs: `notion-templates.spec.ts` (9 new). | done |
| **C · Agent on pages** | NP-AI-03 · "Summarize, draft and transform a page or selection … with sources shown" | Only message and email threads have summary / reply actions. For a page there is the generic chat and the owner-only ⌘J edit. | `components/agent/*` (page actions: Summarize page, Draft from selection, Transform selection → the document-bound session, sources listed), `lib/agent/*`. Specs beside `agent-summary.spec.ts`. | M |
| | NP-AI-01 · "the header Agent button … with the selection attached" | The header button opens the companion; it does not attach the current selection. (Slash, toolbar, block menu and ⌘J do.) | `components/layout/TabBar.tsx` (Agent button) → `useSelectionAsk().ask("selection")` when a selection exists. Spec: `selection-agent.spec.ts`. | S |
| | NP-PG-09 · "agents in Read-write mode are refused for that page" | Refused through Prism MCP (`prism_update_note`, tested) and the gateway. **Not** refused for an agent session on the `vault-rw` profile — the default while `AGENT_PRISM_PROFILES` is off — because that turn writes with the vault token to the vault's own MCP, which knows nothing about `prism_locked`. | Either make `prism-rw` the Read-write profile (turn `AGENT_PRISM_PROFILES` on and retire `vault-rw` for sessions), or a guard in `apps/server/src/agent-sessions.ts` that refuses a `vault-rw` turn bound to a locked note. Owner decision (c.9) on the owner REST bypass belongs with it. Test: `agent-sessions.test.ts`. | S–M |
| **D · Phone gestures** | NP-MB-06 · "pull-to-refresh on lists" | Not built. | `lib/gestures/` (new `usePullToRefresh`), Inbox, Messages, Trash, tree. | M |
| | NP-MB-06 · "swipe on list rows (Messages: archive/read; Trash: restore)" | Row swipes exist on Inbox rows (read / archive) and tree rows (favorite / actions). Not on Messages rows, not in the Trash. | `lib/gestures/useSwipeActions` is reusable: `components/renderers/*Messages*`, the Trash dialog in `components/pages`. Spec: `notion-swipe.spec.ts`. | S |
| **E · Native links and shortcuts** | NP-NA-04 · universal links | The server serves no `apple-app-site-association`; the client declares no associated domain; nothing tests that a page URL opens the page. | `apps/server/src/app.ts` (AASA route + SW denylist entry `/.well-known/` is already there), `apps/client/**` (associated domains, `prism://` handler), `apps/web/src/main.tsx` routing. New fixture + `notion-links.spec.ts › "page URL routes to page"` — this also closes the `[T]` of NP-PG-16. | M |
| | NP-SB-13 · "⌘N creates a page" | No binding. A browser tab cannot take ⌘N; the native shell has no New Page menu item. | `apps/client/src-tauri` menu accelerator → the existing `usePagesUI.openCreate({})`. | S |
| **F · Search filter** | NP-SR-04 · "created/edited by" | The UI offers "Edited by me" only. The server already takes `author=` (creator). | `components/navigation/searchFilters.tsx`. Spec: `notion-search.spec.ts › "filters narrow results"` (assert the date range narrowing in the same change). | S |

### a.2 Test gaps — the behaviour exists, an assertion does not

These rows stay `partial` until a spec asserts the clause. One slice (**G · verification specs**, fixtures and specs only, no product files) can close them. Grouped by the fixture that can host the test.

| Fixture | Row · clause to assert |
|---|---|
| `workspace.html?navigation` / session fixture | NP-SB-01 tree contents and search scope after a vault switch |
| `notion-shell.html` | NP-PG-02 a cover from a valid https link · NP-PG-06 Agent activity dot (needs a seeded agent session list) · NP-PG-14 "Ask agent" starter (needs an `AgentClientProvider` in the fixture) · NP-SR-04 date range narrowing · NP-SR-06 "Ask agent" command row · NP-OF-05 an open database view refreshing on a remote change |
| `collab-route.html?app` (real server) | NP-PG-03 a title edit reaching the second client (and, in `pages-nav.html`, the breadcrumbs following a rename — after slice H) · NP-PG-08 page style on a live document · NP-CO-10 `"remote caret name tags"` (several collaborators, colour distinct from the agent) · NP-CO-14 guest ⌘K, @ menu, Inbox and database UI · NP-CO-12 Accept all, Undo after accept, "Needs refresh" |
| history fixture (`context-history`) | NP-PG-12 day groups, "compare with the version before", the consequence line, phone compare |
| `editor-blocks.html` (live mode) | NP-ED-02 block menu → Comment · NP-ED-10 column resize · NP-ED-16 block text colour + dark values · NP-ED-08 numbered continuation, checked to-do style, callout colour |
| server test + publication fixture | NP-ED-24 `"block round-trip through publish and export"`: every block of ED-08…ED-19 through the publishing renderer, the Markdown / HTML export and a `prism_update_note` edit |
| `notion-mentions.html` | NP-RF-02 an ISO date through the @ menu (an attempt in this pass produced no chip — check whether it is a behaviour gap) · NP-RF-06 inbox item opens scrolled to the chip; edit a reminder's time · NP-CO-01 delete own comment, phone sheet · NP-CO-03 accepted / rejected-suggestion item in the Inbox |
| `databases.html` | NP-DB-07 calendar on another date property (`dateKey`) · NP-DB-08 multi-select and URL editors · NP-DB-20 edit the row's body; rename the row and see the view update |
| agent fixtures | NP-AI-02 an agent turn producing suggestions end to end; refresh-when-stale |
| a main.tsx routing fixture (new) | NP-PG-16 a `/page/<id>` URL opens the page and respects access (with slice E) |

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
| c.9 | NP-PG-09 | a locked page refuses edits "for everyone, including the owner" | The editor and MCP refuse for everyone. The owner / admin REST passthrough lets a content PATCH through and logs `[pages] lock bypass`. | S: refuse in `proxyToVault` instead of logging (decide together with slice C). |
| c.10 | NP-PG-06 | the header bar "shows breadcrumb" | The breadcrumb sits above the title, not in the bar. | S–M: move `Breadcrumbs` into `TabBar`. |
| c.11 | NP-RF-07 | "a page or person mention adds a vault link" | A member mentioned by **account** (no person page) gets no backlink — there is no page to link to. | None needed unless every member must have a person page. |

---

## (d) Measurements not yet taken

| Row | What exists | What is owed |
|---|---|---|
| NP-PF-09 | Browser side measured (12 requests / min for 3 tabs). Vault side was 92 calls / min **before** the reconciler gate (`cda6d93`, `d4a7d00`). | Re-measure with `apps/server/scripts/measure-idle-clients.ts` against a sandbox vault that has a live subscribe socket: 3 tabs + the iOS app, 30 minutes, server and vault CPU against baseline. |
| NP-PF-01 | Desktop warm cache 419 / 427 ms; iPhone figure is a desktop proxy. | iPhone 13-class device, Safari Web Inspector, p50 / p95 over 20 cold starts. |
| NP-PF-03 | Desktop p50 13.1 ms, no long task. | Safari timeline on the device; 10k-word page. |
| NP-PF-07 | Web proxy only (60.8 MB JS heap). | Xcode Instruments, 30 minutes and 50 page opens. |
| NP-PF-02, 04, 05, 06 | All inside budget, but 5 samples each (best / median) against the fixture server. | The row's method: production build, a vault of ≥ 14k notes, p50 and p95 over 20 runs on a quiet machine — **not this host while it serves production**. PF-02 and PF-05 also in the production smoke. PF-06: scroll with all 5,000 rows loaded. |

---

## Order of work proposed

1. **Slice G (specs only)** and the WebKit harness fixes — no product risk, moves the most rows.
2. **Owner decisions c.1 – c.11** — several rows flip on a yes.
3. Slice **H** first (a data-shape bug: sub-pages left behind by a title rename), then **A, B, F** (small, independent files), then **C** (agent; touches the server) and **D** (phone).
4. Slice **E** (native) with the device session, which also clears b.3.
5. Screenshot session b.2, then measurements (d) on a quiet machine and a device.
