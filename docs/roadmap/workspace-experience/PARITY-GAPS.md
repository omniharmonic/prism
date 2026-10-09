# Notion parity — what is left to reach 161 / 161

Rewritten 2026-10-04 by the fourth verification pass at main `44238483` (branch `feat/w11-verify`). Evidence per row: [PARITY-EVIDENCE.md](PARITY-EVIDENCE.md). The gate itself: [NOTION-PARITY-CHECKLIST.md](NOTION-PARITY-CHECKLIST.md). WebKit: [WEBKIT-RESULTS.md](WEBKIT-RESULTS.md).

> **`feat/w9-gaps` (2026-10-08).** The branch was finished on `feat/w9-gaps-finish` (merged with main `5fcfc629`, review round 3 completed, its specs green on Chromium and WebKit there) and is proposed as one pull request. Its rows in §a.0 below are marked "in the pull request"; the totals in this file are still the fourth pass's (judged on main) and move only when that pull request is merged and the specs are green on main.

| Status | Rows now | Third-pass slice | Second pass | First pass |
|---|---|---|---|---|
| passed | 62 | 59 | 52 | 20 |
| deviation (built; owner decision pending) | 7 | 6 | 5 | — |
| needs-screenshot | 39 | 35 | 30 | 19 |
| needs-device | 31 | 29 | 26 | 18 |
| partial | 20 | 27 | 43 | 83 |
| missing | 1 | 4 | 4 | 12 |
| not-measured | 1 | 1 | 1 | 9 |

So **99 rows are not passed**. Of those: 70 wait only for a person (39 screenshot reviews, 31 device checks), 7 for an owner decision, and 22 need work or a measurement (20 partial, 1 missing, 1 not measured). Of the 20 partial rows, **8 are built on `feat/w9-gaps` / `feat/w10-fixes` and only wait for the merge** (§a.0), 4 are performance rows that only need the 20-run measurement (§d), and 8 need a build, a decision or an assertion (§a.1, §a.2).

Nothing here is marked done to improve a number. A row leaves this file only when its evidence is on main.

Sizes: **S** = under a day, one or two files. **M** = one to three days, a new component or route. **L** = more than that.

---

## (a) Build gaps — behaviour that is missing or different

### a.0 Built, not on main — re-verify after the merge

Judged on main these rows are still `partial`. Their `test.fixme` / `todo` pins are still in main's specs; the branch un-pins them. The `feat/w9-gaps` rows are in the `feat/w9-gaps-finish` pull request (specs green there on Chromium and WebKit; the four IME tests of parity4-suggestions are Chromium-only — the composition is driven over CDP).

| Row | Clause | Branch · commits | Spec that must be green on main after the merge | Row becomes |
|---|---|---|---|---|
| NP-PG-03 | a collab title edit syncs to other clients | `feat/w9-gaps-finish` (pull request) | parity3-collab › "NP-PG-03: a title edit in a live document reaches another client…", parity4-collab, server page-notice.test | needs-screenshot (S 01) |
| NP-ED-08, NP-ED-16 | callout background colour | `feat/w9-gaps-finish` (pull request) | parity3-editor › "…a callout background colour changes the callout's background", parity4-colours | ED-16 passed; ED-08 deviation (c.3) |
| NP-CO-10 | carets colour-distinct from agent identity | `feat/w9-gaps-finish` (pull request) | parity3-collab › "NP-CO-10: an agent's marks never share a collaborator's caret colour", server agent-colour.test | passed |
| NP-CO-12, NP-AI-02 | every removal while Suggesting is tracked (marks on text only — a chip, image or line break is refused, not struck); "Needs refresh" | `feat/w9-gaps-finish` (pull request) | parity3-suggestions › "…typing over a selection while Suggesting keeps the replaced text as a tracked deletion", parity4-suggestions, server suggesting-putback.test | needs-screenshot (S 06) |
| NP-ED-24 | Markdown export keeps to-dos, tables, captions, bookmark text; published TOC | `feat/w9-gaps-finish` (pull request) | server block-roundtrip.test (the former `todo` is gone: every block is asserted, the fixture has no `gaps` list any more), export-blocks.test; parity3-publication › "…published page draws every block", parity4-publication | passed — together with the next line |
| NP-ED-24 | a Markdown note's task items open as a to-do list (slice N) | `feat/w10-fixes` · `5296c4a6`, `0cafe63d` | that branch's server + editor tests | passed |
| NP-DB-20 | renaming a row created in the view updates the view | `feat/w9-gaps-finish` (pull request) | parity3-databases › "…renaming a row that was created in the view updates the row in the view", parity4-databases, parity4-pages, server title-sync.test | passed |
| (WebKit findings 1–4 of WEBKIT-RESULTS) | palette press, Tab in the link card and the table, settings column, native selects | `feat/w10-fixes` · `e44bdd48`, `f851066f`, `a13fc14b`, `fb62f2d6` | notion-a11y-reflow (un-fixme settings-account on WebKit), notion-a11y-touch (judge selects on WebKit), editor-links + databases WITHOUT the Tab-preference fixture | lifts the WebKit caveats on NP-ED-18, AX-02, AX-05, AX-07 |

### a.1 Open on main — dispatch-ready, smallest first

Nothing here touches the collab schema (`COLLAB_SCHEMA_VERSION` stays 5). "Self-contained" = one slice, no other track's files, can be dispatched at once.

| # | Slice | Row · clause | What is missing | Files (owner of the slice) | Size |
|---|---|---|---|---|---|
| 1 | **P · Phone sheet entrance** — *self-contained, dispatch now* | NP-AX-06 · "120–180 ms … transitions for menus, **sheets** and peeks" | **Found in this pass.** The phone sheets appear with NO entrance (measured 0 ms for opacity / transform on the sheet, its children and grandchildren): the "More" sheet (`dialog.prism-mobile-sheet`, the `MobileSheet` component) and the page-actions sheet (a `dialog[open]` on a phone — check whether it is the same component). Desktop menus and peeks do enter (120–180 ms). | `packages/core/src/components/ui/mobile-workspace.css` (an opacity + translate entrance on `.prism-mobile-sheet` using `--motion-slow`, off under `prefers-reduced-motion` and `html.reduce-motion` — the tokens already zero). Un-fixme parity5-a11y › "NP-AX-06: a sheet enters in 120–180 ms (phone-more-sheet · phone)" and "… (page-actions-menu · phone)"; notion-a11y's 18-popup test must stay green. | S |
| 2 | **Q · System theme** — *self-contained, dispatch now* | NP-AX-01 · "Light/Dark/**System** setting" | **Found in this pass.** The setting is Dark / Light only (`Theme = "dark" \| "light"`). No choice follows `prefers-color-scheme`. | `packages/core/src/app/stores/settings.ts` (`Theme` + `applyTheme` + a `matchMedia` listener; `toggleTheme` keeps reading the class), `packages/core/src/components/layout/Settings.tsx` (third button), print.css untouched. Un-fixme parity5-shell › "NP-AX-01: the theme setting offers System…". | S |
| 3 | **R · Locked pages and Read-write agents** — a flag, after decision c.9 | NP-PG-09 · "agents in Read-write mode are refused for that page" | A `vault-rw` session can write a locked page OTHER than the one it is bound to or names, by id, through the vault MCP. Everything else is closed (bound / named page → 423; owner REST bypass → 423; fail closed). | No code: `AGENT_PRISM_PROFILES=true` and make `prism-rw` the Read-write profile in the session picker (`apps/server/src/agent-profiles.ts` default list, `components/agent/*` profile labels). | S (decision) |
| 4 | **S · Calendar month grid on phones** | NP-AX-07 · "at least 44×44 px on phone" | The one pinned exception of the touch sweep: 40 controls under 44 px (per-day "+" 19–22 px, page chips 42×18 in seven 51 px columns). Needs a design choice — recommended: on a phone a day tap opens that day's list (sheet) with "+ New"; chips stop being separate targets. | `packages/core/src/components/database/views.tsx` (calendar), `database.css`; un-pin the exception in `notion-a11y-touch.spec.ts`. | M |
| 5 | **E · Native links** | NP-NA-04 · universal links (also the iOS half of NP-PG-16) | No `apple-app-site-association`, no associated domain, no `prism://` page route. | `apps/server/src/app.ts` (AASA route; `/.well-known/` is already in the SW denylist), `apps/client/**` (associated domains, URL handler), `apps/web/src/main.tsx` (route). The web half is asserted (parity3-links). | M |

Closed since the last edition of this file (on main, re-verified in this pass): ~~A · Editor links (NP-ED-18)~~ → passed. ~~H · Title rename (NP-PG-03, sub-pages, member, conflict, offline)~~. ~~B · Templates (NP-TX-01)~~ → passed. ~~C · Agent on pages (NP-AI-03, NP-AI-01)~~ → needs-screenshot. ~~D · Phone gestures (NP-MB-06)~~ → deviation c.12. ~~F · Search filter (NP-SR-04)~~ → needs-screenshot. ~~NP-SB-13 ⌘N~~ — the binding exists in `useKeyboardShortcuts` and is asserted (parity5-shell); what is left is the device check that the native shell delivers ⌘N to the page (b.3, Mac). ~~a.3 accessibility rows AX-02, AX-05, AX-08~~ (specs on main).

### a.2 Test gaps — the behaviour exists, an assertion does not

Specs only; one track can take all of them (`apps/web/e2e-fixtures/parity6-*.spec.ts`).

| Row · clause | Why it is open | Fixture | Size |
|---|---|---|---|
| NP-PG-05 · checkbox, URL and number editors in the page property bar | Asserted in the table (databases), not under the title. The last `[T]` of the row; then it is c.8 (pins) + S 12. | `/e2e-fixtures/databases.html?open=page` | S |
| NP-DB-08 · sorting per type through the UI | Engine-tested per type on the server; the UI sort is asserted for date and select. | `/e2e-fixtures/databases.html` — the Sort dialog once per property kind | S |
| NP-CO-03 · a REPLY item landing on the commented passage | The anchor exists only in a live document; the inbox fixture renders the plain editor. | real-server journey (as parity3-collab): comment, reply from a second account, open the item from the Inbox | S–M |
| NP-AX-04 · non-text contrast (WCAG 1.4.11) | Text contrast is covered twice (axe sweep + the token-pair test written in this pass). Focus rings, input borders and icon-only controls at ≥ 3 : 1 are not measured; text over cover images is not either. | extend `a11y-measure.ts` `focusIndicator` with the ring's contrast against its backdrop; run over `notion-a11y-keyboard`'s stops | S–M |
| NP-AX-07 · controls below the first screenful | The sweep measures what is on screen at open. | `notion-a11y-touch.spec.ts`: scroll each surface once and re-measure | S |
| NP-AX-01 · surfaces not in the dark sweep | set-password, reconnect, native sign-in, network / federation panels, graph, canvas chrome. | `a11y-surfaces.ts` | S |
| parity5-shell, parity5-a11y on WebKit | Written in this pass, run on Chromium only. | `--project=webkit`, one file per command | S |

### a.3 Accessibility rows — state after pass 2 + this pass

| Row | Status | What is left |
|---|---|---|
| NP-AX-01 | partial | Slice Q (System). Then: the surfaces above, the native launch screen on a device, S 09 / 15. |
| NP-AX-02 | passed | — (WebKit under Safari's "Tab highlights each item"; `feat/w10-fixes` removes the need in the link card and tables). |
| NP-AX-03 | needs-device | VoiceOver on macOS and iOS. |
| NP-AX-04 | partial | Non-text contrast assertion (a.2). |
| NP-AX-05 | needs-device | Dynamic Type XXL on an iPhone. |
| NP-AX-06 | partial | Slice P. Then S 15. |
| NP-AX-07 | partial | Slice S (month grid). |
| NP-AX-08 | needs-device | Real kana / pinyin keyboards, emoji, dictation, autocorrect. |

---

## (b) Rows that need a person or a device

### b.1 WebKit — done for the suite; what is still owed

The WebKit run of checklist §1.1 / §4 step 3 exists (1,602 passed, 0 failed, 12 skipped; WEBKIT-RESULTS.md). Owed: (1) the two spec files written in this pass on WebKit; (2) the specs of `feat/w9-gaps` / `feat/w10-fixes` on WebKit after they merge; (3) one complete WebKit pass in one go on a machine that is not the production host (the totals were collected file by file); (4) real Safari on a device — covered by b.3.

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
NP-PG-06 | /e2e-fixtures/notion-shell.html?agent=running | D,P | LK | boards 01/12/18/14: one quiet row — save state, star, labelled Share, labelled Agent with dot, ⋯; P: title, save dot, ⋯ (decision c.10: breadcrumb is above the title)
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

Rows in this list whose status is not `needs-screenshot` (PG-02, PG-03, PG-05, PG-06, CO-03, CO-08, CO-12, AI-02, SR-08, MB-01, MB-03, AX-01, AX-06) need the same capture; it closes their S step, not the row.

### b.3 Device session script

Record per row: device, OS, build number, result. Simulator results do not count. Build: a Release build of the iOS app on production APNs (TestFlight-equivalent, installed ad hoc — the no-upload rule stands) and the Prism Client on a Mac, both against the production server with synthetic `_test` pages. Bring: an iPhone SE-class and a Pro Max-class phone, an iPad with a keyboard + trackpad, a Mac, a second account (member).

**Part A — iPhone, first launch (15 min)**

| Row | Steps | Expected |
|---|---|---|
| NP-NA-05 | Look at the home screen icon in light, dark and tinted mode; launch. | Icon in all three; launch screen matches the theme (no white flash in dark — NP-AX-01). |
| NP-NA-01 | Tap Sign in → system-browser sheet → sign in → back in the app. Settings → Account → Sign out. Sign in again. | Returns to the app signed in; after sign-out the device is gone from "Signed-in devices" on the web and the app shows the sign-in screen with no cached page. |
| NP-NA-02 | Enable the lock in Settings; kill and relaunch; background past the idle time; open the app switcher. | Face ID on launch and on resume, passcode fallback, content blurred in the switcher. |
| NP-NA-03 | Accept the notification prompt when it appears. | Prompt at a sensible moment (not at first launch before sign-in). |

**Part B — iPhone, writing (20 min)**

| Row | Steps | Expected |
|---|---|---|
| NP-MB-01 | Open a page, a thread, then tap in the editor. | Labelled bottom bar with active state; hidden while the keyboard is up; the reply composer owns the bottom edge in a thread. |
| NP-MB-02, NP-SB-13 | Browse → New page. | Focused "Untitled" title with the keyboard up in one tap. |
| NP-MB-04 | Type; use each toolbar button above the keyboard; rotate; attach an external keyboard. | Toolbar sits on the keyboard, never covers the caret; all buttons work; with an external keyboard it does not float mid-screen. |
| NP-MB-05 | Scroll a long page with a thumb starting on text; then tap the block tap-target. | No accidental block drag while scrolling; the menu opens with Move up / down, Turn into. |
| NP-MB-09 | Long-press a word; drag the handles; long-press a link. | Native handles; Prism's toolbar does not sit under the iOS callout; a link previews, it does not navigate. |
| NP-MB-08 | Repeat on the SE and the Pro Max, portrait and landscape. | Nothing under the notch or the home indicator; no zoom on focus; composer and accept controls stay above the keyboard. |
| NP-MB-03 | Header ⋯. | Sheet with every action, 44 px rows; closes by drag, Close and tapping outside. |
| NP-MB-06 | Swipe from the left edge on a page; swipe an Inbox row, a Trash row; pull down on Inbox, Trash, Messages, Browse. | Back / drawer; row actions; pull-to-refresh with no fight against the system rubber-band. |
| NP-SR-08 | Tap Search. | Full-screen search with the keyboard up at once. |
| NP-AX-08 | Type with the Japanese kana and the Chinese pinyin keyboards: "/", "@", "[[" mid-composition; commit with Return in the body, the title, a comment reply. Dictate a sentence. Insert an emoji. | No menu opens mid-composition, nothing is sent or split by the committing Return, no text twice. |
| NP-AX-05 | Settings → Display → Text Size at the largest accessibility size; open a page, the tree, a database, Share. | No clipped control, no sideways page scroll. |
| NP-AX-03 | Turn on VoiceOver: open a page from the tree, edit a line, open the slash menu, save, trash a page. | Buttons are named, the tree announces expanded / collapsed, the save state and the "Moved to Trash" toast are spoken. |

**Part C — iPhone, media, offline, push (20 min)**

| Row | Steps | Expected |
|---|---|---|
| NP-ED-12, NP-PG-02 | Open a page with an uploaded image and a cover; tap the image. | Both render in the app; the image opens full screen. |
| NP-ED-13 | Open file / PDF / audio / video blocks; drag a file in from Files (iPad split view or the picker). | Players work; a dropped file becomes a block. |
| NP-ED-15 | Open a page with a YouTube embed. | Per decision c.7: today an "Open in YouTube" card (the row says it plays). |
| NP-TX-03 | Page ⋯ → Export → Markdown. | The iOS share sheet opens with the file. |
| NP-OF-04 | Favourite a page; wait a minute; airplane mode; open it. Toggle "Make available offline" on another page and repeat. | Both open offline with "Offline copy from <time>". |
| NP-OF-03, NP-NA-06 | Airplane mode: type in a live page and a plain page; force-quit; reopen; reconnect. Then background the app 10 minutes mid-draft and resume. | All text there after the relaunch; one merge on reconnect, nothing lost or doubled; page, scroll and draft restored; no duplicate send or agent turn. |
| NP-NA-03, NP-CO-04, NP-RF-06 | From the second account: mention the owner, reply to their comment. Set a reminder two minutes ahead. Start an agent turn and background the app. | A push for each (generic text, ids only); tapping opens the page at the block; turning a category off in notification settings stops it. Leave an item unread for 30+ minutes on an inactive account: one digest email. |
| NP-NA-04, NP-PG-16 | (after slice E) Tap an `https://<server>/page/<id>` link in Messages and in Mail; then a `prism://` link. | The app opens that page; without the app, Safari does. |
| NP-PF-01, PF-03, PF-07 | Safari Web Inspector attached: 20 cold starts; type in the 10k-word page; Instruments (Allocations) for 30 minutes and 50 page opens. | ≤ 3.0 s p95 to an interactive editor; no long task > 50 ms, ≤ 16 ms p50 keystroke to paint; ≤ 300 MB and no monotonic growth. |

**Part D — iPad (10 min)**

| Row | Steps | Expected |
|---|---|---|
| NP-MB-10 | Landscape 1024×768 and portrait 820×1180, trackpad + keyboard: hover a tree row and a block; ⌘K, ⌘\, ⌘/, ⌘N. | Sidebar persistent or overlay by width; hover affordances appear; shortcuts as on the desktop. |

**Part E — Mac, Prism Client (15 min)**

| Row | Steps | Expected |
|---|---|---|
| NP-NA-07, NP-SB-13, NP-ED-05 | Press ⌘N, ⌘K (with and without a selection), ⌘\, ⌘/, ⌘⇧/, ⌘P, ⌘[ and ⌘], ⌘F, ⌘⌥F, ⌘B / I / U / E. Open a second window. Use quick capture (tray + global shortcut). | Every shortcut reaches the app and none is swallowed by a native menu — **⌘N must create a page** (if it does not: add a New Page menu accelerator in `apps/client/src-tauri`, size S). Several windows work. |
| NP-TX-03 | Page ⋯ → Export; ⌘P. | Native save dialog; print preview without app chrome. |
| NP-ED-13 | Drag a PDF and an image in from Finder. | Blocks are created. |
| NP-NA-01 | Sign out and in. | Keychain token; revoked on the server. |
| NP-AX-03 | VoiceOver: tree, block menu, a database cell, Share. | As in Part B. |

**Part F — desktop Safari + installed PWA (10 min)**

| Row | Steps | Expected |
|---|---|---|
| NP-CO-04, NP-RF-06 | Install the PWA on the iPhone home screen and allow notifications; repeat the mention and the reminder. | Web push arrives; tap opens `/inbox/<id>` → the page. |
| WebKit caveats | In desktop Safari with DEFAULT settings (Tab does not highlight each item): Tab through the link card and a database cell edit. | After `feat/w10-fixes`: both walk with plain Tab. |

### b.4 Production smoke (P)

Checklist §4 step 6, owner account, synthetic `_test` notes only.

| Row | Step |
|---|---|
| NP-PF-02, NP-PF-05 | Open-page and ⌘K full-text timings against the real vault (read-only). |
| NP-AI-03 | **Run one Summarize on a `_test` page with the real CLI** (or `scripts/verify-agent-exec.ts --env <sandbox.env>`, text-only case): the text profile (an MCP config with no servers, no `--allowedTools`) has never been run against the real `claude`. Deploy the server before the PWA (an older server answers 400 to `profile:"text"`). |
| NP-AI-02 | One Suggested-edits turn on a `_test` page: suggestions arrive, accept one, reject one. |

---

## (c) Owner decisions pending

One line each: the question, and the recommended answer. A "yes" to the recommendation means the checklist row's text is edited to say what Prism does, and the row moves to the status shown.

| # | Row | Question | Recommended answer | Row then |
|---|---|---|---|---|
| c.1 | NP-ED-05 | **Closed (w11d): no question left.** ⌘K is "link" with a selection and quick find without one — Notion's own rule, and what NP-SB-02 needs. Every binding of the row is asserted with ⌘ (Apple) and Ctrl (Windows/Linux). | — (native-app menu conflicts stay a device check, NP-NA-07) | passed |
| c.2 | NP-ED-06 | **Built as the row says (w11d): no question left.** ⌘/ with the caret in a block opens that block's menu on Turn into; the shortcut sheet is ⌘⇧/, `?` outside text fields, ⌘/ outside a block (NP-ED-07) and the command bar. Shortcut change: in a block ⌘/ was the sheet, ⌘⇧/ was the block menu. | — | passed |
| c.3 | NP-ED-08 | A toggle's open / closed state is per viewer and never stored — accept? | **Yes.** Storing it makes every expand an edit for all collaborators and needs a schema bump. | passed once `feat/w9-gaps` (callout colour) is merged |
| c.4 | NP-DB-11 | **Change type now converts across stored types (w11d):** dry-run preview, a NEW field of the target type with each page's coerced value (compare-and-set per page), the old property kept deleted-but-restorable, every database's saved views following the property (alias, no rewrite). Rename is still a label; delete is hide + the explicit remove-values run. Remaining question: conversions are refused on tags an integration writes (`task`, `person`, `meeting`, `email`, …) — accept? | **Yes.** An ingester keeps writing the old key; lifting it needs a per-field "who writes this" record. | passed |
| c.5 | NP-DB-12 | **Closed (w11d): no question left.** The row's text (picker over the target database, chips that open, an optional reverse property) is met and proven from BOTH sides; the reverse property is named / renamed / cleared on the relation itself. One stored side stays (it cannot drift). | — | passed |
| c.6 | NP-CO-08 | **Rebuilt as one flow and decided (w11d):** Share → Publish explains per-tag publishing, previews and counts, shows the address, publishes / unpublishes behind a confirm step with the studio's own operation, has the password option and offers the studio in every state. The coordinator's decision: this satisfies "through the existing studio". | — | needs-screenshot |
| c.7 | NP-ED-15 | Allow embeds to play inside the iOS / Mac app (client CSP `frame-src`)? | **Yes, the reviewer's minimal set only** (youtube-nocookie, player.vimeo; no popups). S after the yes. | needs-device |
| c.8 | NP-PG-05 | Show every filled property under the title (today), or cap at 3–5 pinned? | **Keep today's behaviour** (edit the row); a pin list is S–M. | needs-screenshot after the a.2 spec |
| c.9 | NP-PG-09 | Make `prism-rw` (gateway-enforced: locks, grants, private pages) the Read-write agent profile and retire `vault-rw` for sessions? | **Yes.** Cost: no delete and no attachment tools for the agent. | passed |
| c.10 | NP-PG-06 | **Built as the row says (w11d): no question left.** The breadcrumb is in the header bar's one row (the active tab leads with its ancestors; folds by measurement; phone: the page name lists the trail). | — | needs-screenshot |
| c.11 | NP-RF-07 | A member mentioned by account (no person page) gets no backlink — accept? | **Yes.** There is no page to link to. | stays passed |
| c.12 | NP-MB-06 | **New.** On Messages rows only "mark read" is a swipe; archive is never a swipe (it moves real mail, no undo) and chat rows have none — accept? | **Yes.** Archive stays a button in the opened email. | needs-device |
| c.13 | NP-AX-01 | **New.** Add a "System" theme choice (the row names it), or drop the word from the row? | **Build it** (slice Q, S). | partial → needs-device (launch screen) |
| c.14 | NP-AX-07 | **New.** On phones, should a calendar day open that day's list instead of showing 19–22 px "+" and 18 px chips? | **Yes** (slice S, M). | passed after the build |
| c.15 | NP-AI-03 / NP-AI-01 | **New.** Page AI actions and the agent exist for the server owner only (decision D3) — is that the 1.0 scope? | **Yes for 1.0**; members wait for per-actor agent access. Say so in the rows. | unchanged |
| c.16 | NP-TX-01 | **New.** Using someone ELSE's template offers its tags as unticked boxes instead of copying them — accept as "copies … tags"? | **Yes** (a template must never share or publish a page as a side effect). | stays passed |

---

## (d) Measurements not yet taken

| Row | What exists | What is owed |
|---|---|---|
| NP-PF-09 | Browser side 12 requests / min for 3 tabs. Vault side 92 calls / min BEFORE the reconciler gate; the gate is on main and unit-proven (`reconciler-gate.test`: 0 reads in 20 idle ticks with a live projection). | `apps/server/scripts/measure-idle-clients.ts` against a SANDBOX vault with a live subscribe socket, `PRISM_VAULT_TRACE=1`: 3 tabs + the iOS app, 30 minutes, server and vault CPU against baseline. |
| NP-PF-02, 04, 05, 06 | Inside budget on 5 samples (best / median) against the fixture server. The harness reports p50 / p95 at `PERF_RUNS=20`; **not run**. | `PERF_RUNS=20 PERF_PORT=5363 npx playwright test -c playwright.perf.config.ts` after `npx vite build`, on a quiet machine — not this host while it serves production. PF-02 and PF-05 also in the production smoke. PF-06: scroll with all 5,000 rows loaded. |
| NP-PF-01, 03, 07 | Desktop numbers and web proxies. | Device, Part C. |

---

## Order of work proposed

1. **Merge the `feat/w9-gaps-finish` pull request** (`feat/w9-gaps`, finished), then `feat/w10-fixes` if anything of it is still off main; run the specs of §a.0 on main (Chromium + WebKit). Eight partial rows move.
2. **Dispatch slices P and Q now** (both S, self-contained, with a pinned `test.fixme` each). Slice S after decision c.14.
3. **Owner decisions c.1 – c.16** — seven deviation rows and four partial rows turn on a yes.
4. **Spec slice a.2** (one track, specs only).
5. **Screenshot gallery** from §b.2, then the reviewer's pass over it.
6. **Device session** §b.3 (about 90 minutes), then slice E (native links) with a second short session.
7. **Measurements** (d) on a quiet machine and a sandbox vault; production smoke b.4.
