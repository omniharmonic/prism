# Notion parity — what is left to reach 161 / 161

Rewritten 2026-10-04 by the fourth verification pass at main `44238483`; **brought up to date 2026-10-08** (main `5fcfc629` + branch `polish4/parity-quick-wins`: a reconciliation with what had landed on main, the owner's decisions of that day, and a set of quick wins). Evidence per row: [PARITY-EVIDENCE.md](PARITY-EVIDENCE.md). The gate itself: [NOTION-PARITY-CHECKLIST.md](NOTION-PARITY-CHECKLIST.md). WebKit: [WEBKIT-RESULTS.md](WEBKIT-RESULTS.md). The device sitting: [qa/device-pass-script.md](../../../qa/device-pass-script.md).

> **`feat/w9-gaps` merged 2026-10-09 (PR #42, finished on `feat/w9-gaps-finish`, independent review + fixes).** Its rows below read **merged (PR #42)**; their `test.fixme` / `todo` pins are gone from main. The header totals still count them as they stood before the merge — re-count on the next pass.

| Status | Rows now (2026-10-08) | Fourth pass | Third-pass slice | Second pass | First pass |
|---|---|---|---|---|---|
| passed | 68 | 62 | 59 | 52 | 20 |
| deviation (built; owner decision pending) | 0 | 7 | 6 | 5 | — |
| needs-screenshot | 43 | 39 | 35 | 30 | 19 |
| needs-device | 33 | 31 | 29 | 26 | 18 |
| partial | 16 | 20 | 27 | 43 | 83 |
| missing | 0 | 1 | 4 | 4 | 12 |
| not-measured | 1 | 1 | 1 | 1 | 9 |

So **93 rows are not passed**. Of those: 76 wait only for a person (43 screenshot reviews, 33 device checks) and 17 need work or a measurement (16 partial, 1 not measured). Of the 16 partial rows: **8 are merged (PR #42)** — built on `feat/w9-gaps`, not on main (§a.0); 4 are performance rows that only need the 20-run measurement (§d); and 4 need a decision, a small build or an assertion (NP-PG-09, NP-AX-01, NP-AX-04, NP-CO-03 — §a.1, §a.2, §c).

Nothing here is marked done to improve a number. A row leaves this file only when its evidence is on main. The rows moved on 2026-10-08 by the quick-wins branch (NP-AX-07, NP-DB-08, NP-PG-05) were implemented and run by one agent; an independent re-run is still owed (order of work, step 2).

**Device note.** On 2026-10-08 the iOS app was compiled, run in the simulator and run on the owner's iPhone against production as a debug build. The keyboard toolbar, the tab bar hiding with the keyboard, zoom on focus, page properties and the Calendar tool were exercised there. No per-row device result was recorded, so no `needs-device` row has moved. TestFlight stays closed until parity sign-off. **The iPad rides along with the iPhone build — it is not its own project.**

Sizes: **S** = under a day, one or two files. **M** = one to three days, a new component or route. **L** = more than that.

---

## (a) Build gaps — behaviour that is missing or different

### a.0 In progress (w9-gaps) — built on `feat/w9-gaps`, not on main

These eight rows were `partial` until PR #42 merged (2026-10-09); the statuses in the last column are what they move to. The four IME tests of parity4-suggestions are Chromium-only. Suggesting-mode limits recorded with the merge: a removal across a table-cell boundary is refused with a notice; slash-menu inserts and Enter are untracked; a line break cannot be removed while suggesting.

| Row | Clause | State | Spec that must be green on main after the merge | Row becomes |
|---|---|---|---|---|
| NP-PG-03 | a collab title edit syncs to other clients | merged (PR #42) | parity3-collab › "NP-PG-03: a title edit in a live document reaches another client…", parity4-collab, server page-notice.test | needs-screenshot (S 01) |
| NP-ED-08, NP-ED-16 | callout background colour | merged (PR #42) | parity3-editor › "…a callout background colour changes the callout's background", parity4-colours | both passed (c.3 was answered yes on 2026-10-08) |
| NP-CO-10 | carets colour-distinct from agent identity | merged (PR #42) | parity3-collab › "NP-CO-10: an agent's marks never share a collaborator's caret colour", server agent-colour.test | passed |
| NP-CO-12, NP-AI-02 | every removal while Suggesting is tracked; "Needs refresh" | merged (PR #42) | parity3-suggestions › "…typing over a selection while Suggesting keeps the replaced text as a tracked deletion", parity4-suggestions, server suggesting-putback.test | needs-screenshot (S 06) |
| NP-ED-24 | Markdown export keeps to-dos, tables, captions, bookmark text; published TOC | merged (PR #42). The other half — a Markdown note's task items open as a to-do list (slice N) — is on main (`5296c4a6`, `0cafe63d`). | server block-roundtrip.test (the `todo`), export-blocks.test; parity3-publication › "…published page draws every block", parity4-publication | passed |
| NP-DB-20 | renaming a row created in the view updates the view | merged (PR #42) | parity3-databases › "…renaming a row that was created in the view updates the row in the view", parity4-databases, parity4-pages | passed |

**On main since the fourth pass (checked 2026-10-08):** `feat/w10-fixes` — `e44bdd48` (⌘K row press), `f851066f` (Tab in the link card and the table), `a13fc14b` (settings column), `fb62f2d6` (selects in desktop Safari). It lifts the WebKit caveats on NP-ED-18, NP-AX-02, NP-AX-05, NP-AX-07; the Safari-default-settings check is device-pass-script F2.

### a.1 Open on main — dispatch-ready, smallest first

Nothing here touches the collab schema (`COLLAB_SCHEMA_VERSION` stays 5).

| # | Slice | Row · clause | What is missing | Files | Size |
|---|---|---|---|---|---|
| 1 | **R · Locked pages and Read-write agents** — a flag, after decision c.9 | NP-PG-09 · "agents in Read-write mode are refused for that page" | A `vault-rw` session can write a locked page OTHER than the one it is bound to or names, by id, through the vault MCP. Everything else is closed (bound / named page → 423; owner REST bypass → 423; fail closed). | No code: `AGENT_PRISM_PROFILES=true` and make `prism-rw` the Read-write profile in the session picker (`apps/server/src/agent-profiles.ts` default list, `components/agent/*` profile labels). | S (decision) |

Closed 2026-10-09 (`polish5/gaps-db`): ~~T · Select and status sort by option order (NP-DB-08)~~ → a select / status / multi-select column sorts by its option order on the server and in the client fallback (server `database-option-sort.test`, parity6-databases › "NP-DB-08: …", "a select sorts by its options as the owner ordered them…"). ~~U · Calendar page chips on an iPad (NP-AX-07)~~ → chips, multi-day bars and the day "+" are 44 px targets under a coarse pointer (parity6-databases › "iPad 1024 px: …", "iPad 820 px: …").

Closed since the last edition of this file (on main or on `polish4/parity-quick-wins`, each checked against its spec on 2026-10-08): ~~P · Phone sheet entrance (NP-AX-06)~~ → needs-screenshot. ~~Q · System theme (NP-AX-01)~~ → built; the row is still partial for other reasons (§a.3). ~~S · Calendar month grid on phones (NP-AX-07)~~ → passed. ~~E · Native links (NP-NA-04)~~ → needs-device. ~~Embeds in the apps (NP-ED-15, decision c.7)~~ → built, needs-device. Earlier: ~~A · Editor links~~, ~~H · Title rename~~, ~~B · Templates~~, ~~C · Agent on pages~~, ~~D · Phone gestures~~, ~~F · Search filter~~, ~~⌘N~~.

### a.2 Test gaps — the behaviour exists, an assertion does not

| Row · clause | Why it is open | Fixture | Size |
|---|---|---|---|
| NP-CO-03 · a REPLY item landing on the commented passage | The anchor exists only in a live document; the inbox fixture renders the plain editor. | real-server journey (as parity3-collab): comment, reply from a second account, open the item from the Inbox | S–M |
| NP-AX-04 · what the contrast sweep does not judge | Focus indicators are gated at 3 : 1 on every surface. Not measured: icon-only controls, text over cover images, rings drawn over a gradient (34 stops), and "focus shown only by a change of fill" (counted, not judged). | `notion-a11y-contrast.spec.ts`, `a11y-measure.ts` | S–M |
| NP-AX-01 · surfaces still not in the dark sweep | native sign-in screen, graph, canvas chrome. (set-password, reconnect and the network / connections panel were added on 2026-10-08.) | `a11y-surfaces.ts` | S |

Closed 2026-10-08 (`polish4/parity-quick-wins`): ~~NP-PG-05 · checkbox, URL and number editors under the title~~ (page-properties › "NP-PG-05: …"). ~~NP-DB-08 · sorting per type through the UI~~ (parity6-databases › "NP-DB-08: …"). ~~NP-AX-07 · controls below the first screenful~~ (notion-a11y-touch › "… · scrolled"). ~~NP-AX-04 · focus-indicator contrast~~ (notion-a11y-contrast). ~~parity5-shell, parity5-a11y on WebKit~~ (15 / 15 and 8 / 8); notion-a11y-contrast on WebKit 182 / 182.

### a.3 Accessibility rows — state on 2026-10-08

| Row | Status | What is left |
|---|---|---|
| NP-AX-01 | partial | System is built. Left: three unswept surfaces (a.2), the native launch screen on a device, S 09 / 15. |
| NP-AX-02 | passed | — |
| NP-AX-03 | needs-device | VoiceOver on macOS and iOS. |
| NP-AX-04 | partial | Decision c.17 is answered and built (2026-10-09: `--control-border`, every measured form control ≥ 3 : 1, asserted by `notion-a11y-contrast`). Left: the unmeasured kinds in a.2 (icons, text over images) and a look by eye at the darker field borders. |
| NP-AX-05 | needs-device | Dynamic Type XXL on an iPhone. |
| NP-AX-06 | needs-screenshot | S 15. |
| NP-AX-07 | passed | — (iPad chips: slice U, not a clause of the row). |
| NP-AX-08 | needs-device | Real kana / pinyin keyboards, emoji, dictation, autocorrect. |

---

## (b) Rows that need a person or a device

### b.1 WebKit — done for the suite; what is still owed

The WebKit run of checklist §1.1 / §4 step 3 exists (1,602 passed, 0 failed, 12 skipped; WEBKIT-RESULTS.md). The 2026-10-08 branch ran its new and touched specs on WebKit (509 passed; PARITY-EVIDENCE "Verification runs"). Owed: (1) — done 2026-10-08 (parity5-shell, parity5-a11y, notion-a11y-contrast); (2) the specs of `feat/w9-gaps` on WebKit after it merges; (3) one complete WebKit pass in one go on a machine that is not the production host (the totals were collected file by file); (4) real Safari on a device — covered by b.3.

### b.2 Screenshot review (S) — machine-usable capture list

One line per capture target: `row | fixture path + query | viewport | theme | what to verify`.

- **Viewport** `D` = 1440×900, `P` = 390×844 (touch, coarse pointer). **Theme** `L` = light, `K` = dark; `LK` = capture both. So `D,P | LK` = four images.
- **`surface:<id>`** = a recipe in `apps/web/e2e-fixtures/a11y-surfaces.ts` (`SURFACES.find(s => s.id === id)` → `openSurface(page, s, vp, theme)`): it opens the fixture, sets the theme and performs the clicks that reach the state. Use it as is. **`steps:`** = interaction the gallery script must add after `page.goto`. **`real-server`** = the state needs the real-server harness (`real-server.ts`); take the steps from the named spec.
- Theme on a plain fixture: toggle `light` / `dark` on `<html>` (what `setTheme` in a11y-surfaces does). Some fixtures also take `&dark`.
- **Fail on:** clipped text, sideways page scroll, a white panel in dark, bottom controls overlapping content, a focus ring around the writing surface, an icon-only control the board labels, text under 4.5 : 1.
- Compare with `docs/roadmap/workspace-experience/assets/<board>-*.png`; `Notion` = a reference capture of the same state in Notion, taken by the reviewer. Store under `verification/notion-parity/rc-ios-1/<row>/<viewport>-<theme>.png`.

**Group 1 — workspace shell (boards 01, 14, 16)**

```
NP-SB-01 | /e2e-fixtures/workspace.html?navigation&vaultdata · steps: click the vault switcher at the top of the sidebar (P: open Browse first) | D,P | LK | board 01/14: switcher at the top with the vault name; menu lists every vault + "Manage workspaces & vaults"
NP-SB-04 | /e2e-fixtures/notion-shell.html?inbox&favorites · surface:shell-page-inbox-badge | D,P | LK | board 01/14: Favorites section always present; starred rows with icons; (second capture without ?favorites: "Star a page to pin it here")
NP-SB-06 | /e2e-fixtures/pages-nav.html · surface:tree | D,P | LK | board 01/14: pages (not folders) with icons and disclosures; same tree in the phone drawer
NP-SB-13 | /e2e-fixtures/notion-shell.html · steps: click sidebar "New page" (P: More → New page) | D,P | LK | board 14 (New page): "Untitled" title focused, no chooser in the way, P header says "Saved on this device" when offline
NP-SB-14 | /e2e-fixtures/workspace.html?navigation · steps: expand "Tools" in the sidebar | D,P | LK | board 14: Tools collapsible; Calendar, People, Automations, Map reachable
NP-SB-15 | /e2e-fixtures/notion-shell.html · steps: none (Synced); second capture after context.setOffline(true) + typing one character | D,P | LK | board 01/16: footer reads "Synced" / "Offline · saved on this device"; Settings in the footer
NP-PG-01 | /e2e-fixtures/notion-shell.html · surface:icon-picker | D,P | LK | board 01/14: searchable emoji picker; the chosen icon shows in tab, tree row, breadcrumb
NP-PG-03 | /e2e-fixtures/notion-shell.html · steps: click the page title | D,P | LK | board 01: large title, editable in place, no box around the document
NP-PG-04 | /e2e-fixtures/pages-nav.html?open=week1 | D,P | LK | board 01/13: full ancestor trail above the title; a long trail collapses into "…"
NP-PG-06 | /e2e-fixtures/notion-shell.html?agent=running | D,P | LK | boards 01/12/18/14: one quiet row — save state, star, labelled Share, labelled Agent with dot, ⋯; P: title, save dot, ⋯ (c.10, built: the breadcrumb is in the bar's one row)
NP-PG-11 | /e2e-fixtures/workspace.html · steps: open the Outline panel (context panel → Outline) | D | LK | board 01: heading list, current section marked, panel does not move the text
NP-PG-14 | /e2e-fixtures/notion-shell.html?agent · steps: sidebar "New page", then press Escape on the title | D,P | LK | board 16 (Empty document): starters Empty / Template / Import / Ask agent
NP-OF-01 | /e2e-fixtures/notion-shell.html · steps: capture header at rest ("Saved"); then context.setOffline(true), type, capture | D,P | LK | boards 14/16: header "Saved" ✓ → "Offline · changes saved on this device"; never "Saved" while offline
NP-MB-07 | /e2e-fixtures/pages-nav.html · surface:tree | P | LK | board 14: drawer with vault switcher, Favorites, Recents, tree with disclosure and ⋯, Tools, Trash, New page, Settings; 44 px rows
NP-MB-01 | /e2e-fixtures/workspace.html?navigation | P | LK | boards 14/08: labelled bottom bar (Notes, Inbox, Search, Agent, More), active state visible
NP-MB-03 | /e2e-fixtures/pages-nav.html?open=prism · surface:page-actions-menu | P | LK | board 14: page actions sheet with 44 px rows and a drag handle
NP-AX-01 | /e2e-fixtures/workspace.html · surface:settings-appearance | D,P | LK | boards 09/15: Appearance panel; in K no white panel anywhere (also review every K capture in this list)
NP-AX-06 | /e2e-fixtures/workspace.html · surface:settings-appearance | D | LK | board 15: "Reduce motion" control present and labelled
```

**Group 2 — editor (boards 01, 14, desktop-collaboration, 06)**

```
NP-ED-03 | /e2e-fixtures/editor-blocks.html · surface:slash-menu | D,P | LK | board 01/14: grouped slash menu (Basic, Media, Database, Advanced, Agent) with hints; P fits the screen, large rows
NP-ED-17 | /e2e-fixtures/editor-blocks.html · surface:selection-toolbar | D,P | LK | desktop-collaboration/01: Turn into, B I U S code, Link, Colour, Comment, Ask agent, Mention; stays inside the viewport; P 44 px targets
NP-CO-01 | /e2e-fixtures/notion-mentions.html?comments · surface:comments-live-panel | D,P | LK | desktop-collaboration: thread in the margin (D) / panel over the page (P); reply, resolve, Resolved tab
NP-CO-12 | /e2e-fixtures/suggestion-review.html · surface:suggestion-review | D,P | LK | board 06: insert underlined, delete struck, attribution, previous / next, Accept / Reject (re-capture after feat/w9-gaps merges: "Needs refresh")
NP-AI-02 | /e2e-fixtures/suggestion-review.html · surface:suggestion-review | D,P | LK | board 06 / desktop-review: an agent's suggestion reads as "(agent)", same review controls
NP-AI-01 | /e2e-fixtures/notion-page-agent.html · steps: select a sentence, click the header "Agent" button | D,P | LK | boards 01/02: the companion opens on this page with the selection as an unsent attachment
NP-AI-03 | /e2e-fixtures/notion-page-agent.html · steps: page ⋯ → Summarize; wait for the result panel | D,P | LK | boards 02/04: result as a proposal, "Sources" lists this page, Insert / Replace / Copy / Discard; P: bottom sheet, 44 px actions
```

**Group 3 — page properties, history, sharing states (boards 12, 13, 16, 23, 24)**

```
NP-PG-05 | /e2e-fixtures/databases.html?open=page | D,P | LK | board 12: typed properties under the title; "+ Add property"; (second capture with &viewer: values, no edit affordances)
NP-PG-10 | /e2e-fixtures/notion-shell.html · steps: follow notion-page.spec "backlinks pill lists linking pages" to the open list | D,P | LK | board 12: pill under the title; list with snippets
NP-PG-08 | /e2e-fixtures/notion-shell.html · steps: page ⋯ → Full width; second capture ⋯ → Small text | D | LK | board 15 / Notion: full-width and small-text renderings
NP-PG-12 | /e2e-fixtures/context-history.html?days · surface:history-viewer | D,P | LK | board 13: day-grouped list; compare view; Restore with its consequence line; P full-width compare
NP-PG-13 | /e2e-fixtures/notion-sharing.html?panel=history | D,P | LK | board 13: each version names its author kind (you / person / Agent revision / Accepted suggestion)
NP-CO-15 | /e2e-fixtures/notion-sharing.html?panel=history · surface:history-updates | D,P | LK | board 13: Updates feed — edits, comments, shares, accepted suggestions
NP-CO-05 | /e2e-fixtures/sharing.html?page · surface:share-people | D,P | LK | board 23: People tab — invite field + level, names and avatars, Owner row, level menus
NP-CO-06 | /e2e-fixtures/sharing.html?page · surface:share-link | D,P | LK | board 23: Restricted vs anyone-with-link, Copy link, revoke
NP-CO-07 | /e2e-fixtures/sharing.html?page · surface:share-people | P | LK | board 23: underline tabs (People · Link access · Publish), phone sheet, no sideways scroll
NP-CO-08 | /e2e-fixtures/sharing.html?page · surface:share-publish | D,P | LK | boards 23/24: per-tag explanation, preview, hand-off to the studio (decision c.6: direct controls remain)
NP-CO-13 | /e2e-fixtures/notion-sharing.html?panel=shared&guest · steps: follow notion-sharing.spec "request access → owner approves" up to the request form | D,P | LK | board 16 (Read-only page): "Request access" with a level choice; the owner's approve / deny
NP-RF-03 | /e2e-fixtures/notion-mentions.html · steps: hover the person chip | D | LK | board 09 (identity card): name + linked identities
```

**Group 4 — search (board 11, 08)**

```
NP-SB-02 | /e2e-fixtures/notion-shell.html · surface:command-bar | D,P | LK | board 11: quick find over the page; Search row in the sidebar
NP-SR-01 | /e2e-fixtures/notion-shell.html · surface:command-bar | D,P | LK | board 11: recents before typing; rows with icon, title, breadcrumb, edited date
NP-SR-02 | /e2e-fixtures/search.html?many · surface:search-page | D,P | LK | board 11: groups Notes / Messages / Commands with chips; Open and "Add to context" are separate
NP-SR-03 | /e2e-fixtures/notion-shell.html · steps: ⌘K, type "workshop" | D,P | LK | board 11: matched terms highlighted in titles and snippets
NP-SR-04 | /e2e-fixtures/notion-shell.html · surface:command-bar-filters (the identity filters also at ?authors: ⌘K, type "workshop", click Filters) | D,P | LK | board 11: Title only, Type, Created by, Edited by, Date (vault scope only with several vaults)
NP-SR-08 | /e2e-fixtures/notion-shell.html · steps: tap Search in the bottom bar | P | LK | boards 08/14: full-screen search, field focused, recent searches and pages, 44 px rows
```

**Group 5 — databases (board 20)**

```
NP-DB-04 | /e2e-fixtures/databases.html · surface:db-board | D | LK | board 20: columns by status with "+ New", cards with chosen properties and ⋯
NP-DB-23 | /e2e-fixtures/databases.html · surface:db-table | P | LK | board 20 (phone): sticky first column, no page overflow; second capture surface:db-filter (filters in a sheet); third surface:db-board (list first)
NP-DB-24 | /e2e-fixtures/boards.html?due · surface:task-board | D,P | LK | board 20: per-column "+ Add task", card ⋯, due chips, scroll affordance at the edge
NP-DB-18 | /e2e-fixtures/databases.html · surface:db-row-peek-side (second: surface:db-row-peek-center) | D | LK | Notion reference: side peek and center peek with properties and body
```

**Group 6 — collaboration presence, Home, peek (boards 03, 15, 18; Notion reference)**

```
NP-CO-11 | real-server · notion-presence.spec.ts › "header avatars and jump to cursor" (/e2e-fixtures/collab-route.html?target=<server>) | D,P | LK | boards 03/15/18: avatars in the header; P compact count
NP-SB-03 | /e2e-fixtures/notion-inbox.html?reset · surface:home | D,P | LK | Notion reference (Home): recents, upcoming events, my tasks, unread updates
NP-SB-12 | /e2e-fixtures/notion-shell.html?collapsed · surface:sidebar-peek | D | LK | Notion reference: floating sidebar over the page on left-edge hover
NP-CO-03 | /e2e-fixtures/notion-inbox.html?reset&open=notifications · surface:inbox | D,P | LK | Notion reference (Inbox): mention, reply, share, suggestion and reminder items; unread badge; mark all read
NP-PG-02 | /e2e-fixtures/notion-media.html · surface:page-cover-dialog (second: a page with a cover set) | D,P | LK | Notion reference: cover cropped and responsive; Change / Reposition / Remove
```

Rows in this list whose status is not `needs-screenshot` (PG-02, PG-03, CO-03, CO-12, AI-02, SR-08, MB-01, MB-03, AX-01) need the same capture; it closes their S step, not the row.

### b.3 Device session script

**The script is one file now: [qa/device-pass-script.md](../../../qa/device-pass-script.md)** — parts A (iPhone, first launch), B (writing), C (media, offline, push), D (iPad), E (Mac, Prism Client), F (Safari and the installed web app). Every step is "do → expect" with a box for device / OS / build / result. Steps exercised informally on the owner's iPhone on 2026-10-08 are marked `◐ 10-08` there; none of them has a recorded result yet. Simulator results do not count.

Rows the sitting covers: NP-NA-01 … 07, NP-MB-01 … 10, NP-SB-13, NP-SR-08, NP-AX-03 / 05 / 07 / 08, NP-ED-12 / 13 / 15, NP-PG-02 / 05 / 16, NP-TX-03, NP-OF-03 / 04, NP-CO-04, NP-RF-06, NP-PF-01 / 03 / 07, and the two things with no row of their own (the offline-storage pill after a long background; desktop Safari's default Tab behaviour).

### b.4 Production smoke (P)

Checklist §4 step 6, owner account, synthetic `_test` notes only.

| Row | Step |
|---|---|
| NP-PF-02, NP-PF-05 | Open-page and ⌘K full-text timings against the real vault (read-only). |
| NP-AI-03 | **Run one Summarize on a `_test` page with the real CLI** (or `scripts/verify-agent-exec.ts --env <sandbox.env>`, text-only case): the text profile (an MCP config with no servers, no `--allowedTools`) has never been run against the real `claude`. Deploy the server before the PWA (an older server answers 400 to `profile:"text"`). |
| NP-AI-02 | One Suggested-edits turn on a `_test` page: suggestions arrive, accept one, reject one. |

---

## (c) Owner decisions

### Decided on 2026-10-08 (all as recommended)

| # | Row | Decision | Row now |
|---|---|---|---|
| c.3 | NP-ED-08 | A toggle's open / closed state is per viewer and is not stored. | partial — merged (PR #42) for the callout colour; passes when that lands |
| c.4 | NP-DB-11 | Type conversion stays refused on tags an integration writes (`task`, `person`, `meeting`, `email`, …). | passed |
| c.7 | NP-ED-15 | Embeds play inside the iOS / Mac apps: YouTube-nocookie and Vimeo only, no popups. Everything else stays an "Open in …" card there. | needs-device (built; compiled; not seen running) |
| c.12 | NP-MB-06 | Archive is never a swipe (Messages rows: only "mark read"). | needs-device |
| c.15 | NP-AI-03 / NP-AI-01 | AI is for the server owner only in 1.0; members wait for per-actor agent access. | unchanged (needs-screenshot) |
| c.16 | NP-TX-01 | Someone else's template offers its tags as unticked boxes — never copied silently. | stays passed |

Also decided: **the iPad rides along with the iPhone build** (it is not its own project).

### Closed without a question (built as the row says; re-checked on main 2026-10-08)

c.1 NP-ED-05 → passed · c.2 NP-ED-06 → passed · c.5 NP-DB-12 → passed · c.6 NP-CO-08 → needs-screenshot · c.10 NP-PG-06 → needs-screenshot · c.13 NP-AX-01 System theme → built · c.14 NP-AX-07 phone month → built, passed · c.8 NP-PG-05 → the pin list exists (owner pins properties; with no pins every filled property shows), needs-screenshot.

### Still pending

| # | Row | Question | Recommended answer | Row then |
|---|---|---|---|---|
| c.9 | NP-PG-09 | Make `prism-rw` (gateway-enforced: locks, grants, private pages) the Read-write agent profile and retire `vault-rw` for sessions? | **Yes.** Cost: no delete and no attachment tools for the agent. | passed |
| c.11 | NP-RF-07 | A member mentioned by account (no person page) gets no backlink — accept? | **Yes.** There is no page to link to. | stays passed |
| c.17 | NP-AX-04 | **New (2026-10-08).** Text fields, selects and custom checkboxes are drawn with the shared 1 px hairline (about 1.3 : 1 against the page; 157 of 170 measured are under 3 : 1). WCAG 1.4.11 asks 3 : 1 for a control's boundary. Raise the field border, or accept the hairline as Notion does? | **Raise it for form fields only**: a `--control-border` token at 3 : 1 used by inputs / selects / checkboxes, leaving dividers on `--glass-border`. Size M (every field style), with a screenshot review. | **Answered and built 2026-10-09** as recommended: `--control-border` in `tokens.css` (both themes + print), re-pointed on form controls and on the boxes around seamless fields; 224 of 224 measured controls ≥ 3 : 1 (was 13 of 170), and `notion-a11y-contrast` now fails on any below. NP-AX-04 passes after the a.2 leftovers. |

---

## (d) Measurements not yet taken

| Row | What exists | What is owed |
|---|---|---|
| NP-PF-09 | Browser side 12 requests / min for 3 tabs. Vault side 92 calls / min BEFORE the reconciler gate; the gate is on main and unit-proven (`reconciler-gate.test`: 0 reads in 20 idle ticks with a live projection). | `apps/server/scripts/measure-idle-clients.ts` against a SANDBOX vault with a live subscribe socket, `PRISM_VAULT_TRACE=1`: 3 tabs + the iOS app, 30 minutes, server and vault CPU against baseline. |
| NP-PF-02, 04, 05, 06 | Inside budget on 5 samples (best / median) against the fixture server. The harness reports p50 / p95 at `PERF_RUNS=20`; **not run**. | `PERF_RUNS=20 PERF_PORT=5363 npx playwright test -c playwright.perf.config.ts` after `npx vite build`, on a quiet machine — not this host while it serves production. PF-02 and PF-05 also in the production smoke. PF-06: scroll with all 5,000 rows loaded. |
| NP-PF-01, 03, 07 | Desktop numbers and web proxies. | Device, Part C. |

---

## Order of work proposed

1. **`feat/w9-gaps` is merged (PR #42).** Re-run the specs of §a.0 on main (Chromium + WebKit) and re-count the header: eight partial rows move.
2. **Independent re-run** of the rows moved on 2026-10-08 (NP-AX-07, NP-DB-08, NP-PG-05 and the reconciled rows) by someone other than the agent that built them — Chromium + WebKit.
3. **Device sitting** — `qa/device-pass-script.md` (about 100 minutes). It records the 33 `needs-device` rows, including embeds in the apps and native links.
4. **Screenshot gallery** from §b.2 (43 rows), then the reviewer's pass over it.
5. **Decisions c.9, c.11** (c.17 is answered and built); then the slices still open.
6. **Spec leftovers** of §a.2 (the NP-CO-03 real-server journey; three surfaces; WebKit for the newest specs).
7. **Measurements** (d) on a quiet machine and a sandbox vault; production smoke b.4.
