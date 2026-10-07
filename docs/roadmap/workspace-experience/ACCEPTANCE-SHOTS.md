# Acceptance shots — the screenshot review of checklist §4 step 4

Captured on branch `feat/w11-shots` (product code = main `44238483`), 2026-10-04. Chromium only.

The reviewer scrolls ONE page (or its parts) of labelled screenshots and ticks each row. Each state is shown in light and dark at 1440×900 and 390×844 where the row applies to that viewport.

## How to regenerate

```bash
cd apps/web
# 1. Capture. One slice (-g) per command, one worker, behind the host gate (AGENT-RULES).
PRISM_SHOTS=1 E2E_PORT=<port> npx playwright test -c playwright.config.ts \
  e2e-fixtures/acceptance-shots.spec.ts --workers=1 --reporter=line -g "2.5 Databases"
#    -g takes a section heading ("2.1 Sidebar", … "Other surfaces"), a row id ("NP-DB-18") or a slug.
# 2. Build the gallery (Node ≥ 22.18; older: add --import tsx). No browser, no network.
node scripts/build-acceptance-gallery.mjs --max-mb 13
#    → apps/web/acceptance-gallery.html, or acceptance-gallery-1.html, -2.html … when one page would exceed the limit.
#    --gaps <file> reads a newer PARITY-GAPS.md than the tree's (e.g. `git show feat/w11-verify:docs/…/PARITY-GAPS.md`).
```

- `apps/web/e2e-fixtures/acceptance-shots.ts` — the shot list: row id, section, fixture URL, the steps that reach the state, the "look at" note.
- `apps/web/e2e-fixtures/acceptance-shots.spec.ts` — the runner. **Without `PRISM_SHOTS` it defines no tests**: the default suite count is unchanged (measured on this branch: 1614 tests in 139 files without the variable, 1785 in 140 with it — the difference is the 171 shot tests then defined; 182 after the rows added from §b.2).
- `apps/web/scripts/build-acceptance-gallery.mjs` — the page: PNG → JPEG q70 through macOS `sips`, embedded as data URIs; acceptance text verbatim from `NOTION-PARITY-CHECKLIST.md`; "what to verify" from `PARITY-GAPS.md` §b.2 (both the board table and the `row | fixture | viewport | theme | what` capture list) and the `[S]` note of `PARITY-EVIDENCE.md`. The page has no `<html>/<head>/<body>`, no external resource, a pass / fail / skip control and notes per row (kept in `localStorage`), and an "Export results" text block.
- Output directories `apps/web/acceptance-shots/` and `apps/web/acceptance-gallery*.html` are git-ignored.

**Determinism.** Each theme is a fresh browser context: theme set through `prism-settings` + the `<html>` class + `prefers-color-scheme`; the clock is fixed at Monday 5 Oct 2026 15:00 local (`clock: "run"` for the four states whose code measures elapsed time — search and the date menu); reduced motion; animations and carets off; `document.fonts.ready` awaited; every request that is not to 127.0.0.1 is aborted. Phone shots emulate a touch device (`hasTouch`, `isMobile`) unless the shot says `touch: false`.

**Limits of what the shots show — read before judging.**

1. **Typeface.** The fixtures do not load the app's web fonts (Inter, Newsreader, JetBrains Mono come from Google Fonts in `index.html`) and the capture allows no network, so text is in the fallback stack: system sans, Georgia, and a Courier-like monospace. Judge layout, colour, spacing and weight — not the face. Code, key caps and the "Serif / Mono" labels look worse here than in the app.
2. **Fixture pages, not the app.** `editor-blocks`, `notion-media`, `notion-mentions?comments`, `sharing`, `suggestion-review`, `context-history`, `agent`, `boards`, `people-profile` mount one surface with no sidebar; some show a line of fixture buttons at the top left ("Share fixture", "Switch workspace", "Toggle panel"). `workspace.html` shows "Agent unavailable" in its side panel.
3. **No software keyboard.** The phone editing toolbar is shown above the bottom bar; on a device it rides on the keyboard and the bar hides.
4. **Embeds and remote images** are blocked: the YouTube embed is an empty frame, one gallery cover is a broken image.
5. Chromium only; no WebKit capture.

## Rows covered

183 shot tests → 366 images (each test = light + dark). 105 states over 82 gallery cards (w14 added `NP-PG-11 outline-beside`).

| Section | Rows | States | Images |
|---|---|---|---|
| 2.1 Sidebar and workspace navigation | NP-SB-01, 02, 03, 04, 06, 07, 09, 10, 12, 13, 14, 15 | 12 | 42 |
| 2.2 Page chrome | NP-PG-01, 02, 03, 04, 05, 06, 07, 08, 10, 11, 12, 13, 14 | 18 | 66 |
| 2.3 Editor and blocks | NP-ED-01, 02, 03, 07, 08, 10, 16, 17, 18, 22 | 14 | 44 |
| 2.4 Inline references | NP-RF-01, 02, 03, 05 | 4 | 14 |
| 2.5 Databases | NP-DB-02, 03, 04, 05, 06, 07, 13, 15, 18, 21, 23, 24 | 14 | 48 |
| 2.6 Collaboration, sharing and notifications | NP-CO-01, 02, 03, 05, 06, 08, 11, 12, 13, 15 | 13 | 52 |
| 2.7 Search and ⌘K | NP-SR-01, 02, 03, 04 | 4 | 16 |
| 2.8 Templates, import and export | NP-TX-01, 03, 04, 05 | 6 | 22 |
| 2.9 Prism agent | NP-AI-01, 03 | 4 | 12 |
| 2.10 Phone app patterns | NP-MB-01, 03, 04, 07 | 6 | 12 |
| 2.11 Offline, sync and reliability | NP-OF-01, 06 | 3 | 12 |
| Other surfaces | NP-AX-01 (Settings → Appearance, also AX-06), workspace settings, person profile, calendar, messages | 6 | 24 |

Every `needs-screenshot` row of the evidence log has at least one state. Rows of the §b.2 capture list that share a state with another row and have no card of their own: NP-CO-07 (= the phone shots of NP-CO-05/06), NP-AI-02 (= NP-CO-12 suggestion review), NP-SR-08 (= the phone shots of NP-SR-01), NP-AX-06 (= NP-AX-01 Settings → Appearance), NP-MB-01 on `workspace.html` (captured on `notion-shell.html?inbox&agent` instead, which shows the Inbox badge).

The recipes are this file's own (written before the §b.2 list named `a11y-surfaces.ts` recipes); they reach the same states. Converting them to call `openSurface` is possible and not done.

## Rows and states NOT staged, and what would be needed

| Row | What is missing | Why | Real-app state needed |
|---|---|---|---|
| NP-CO-13 | The request form "with a level choice" | The fixture's unavailable page has one Request access button (level `view`); the level is chosen by the owner on approval (`access-request-inbox` state shows that). | — (matches the product) |
| NP-PG-01 | Chosen icon in a breadcrumb | Needs a sub-page of the page that got the icon; the `icon-everywhere` state shows tab + tree + title only. | Open a sub-page of a page with an icon. |
| NP-PG-02 | Reposition by drag; uploaded image cover | A gradient cover has no Reposition; the upload needs the spec's attachment route. | A page with an uploaded cover. |
| NP-ED-13/15 | PDF / audio / video blocks, a playing embed | Network is blocked; own-attachment media needs served bytes. | A page with uploaded media on the real server. |
| NP-RF-05/06 | A date chip with its picker and "Remind me" set | The chip did not appear within the timeout under the fixed clock; the state shows the @ menu's date entries instead. | Insert a date mention, open its picker. |
| NP-MB-04 | Toolbar riding on the keyboard | Headless Chromium has no software keyboard. | Device (already a D row). |
| NP-MB-08/09/10, NP-AX-05/07/08, all NP-NA, NP-PF | — | Device, zoom or measurement rows; not screenshot rows. | Device pass. |
| NP-CO-10 | A collaborator's caret WITH its name tag | In the presence state the caret is visible, the name tag is not shown at rest. | Two real clients; hover the caret. |
| NP-DB-08…12, 19, 25 | Property editor, relation picker, row templates, CSV dialogs | Not in the `needs-screenshot` set; not staged for time. | Fixture recipes exist in `notion-db-props|csv.spec.ts`. |
| NP-OF-06 | The unsent-changes list with a row in it | The dialog opened but listed "No pending changes" while the header said changes were saved on this device (see defect 20). | Type offline, wait for the queue, open the dialog. |

## Defects found

Seen by reading the captured PNGs (about 110 of the 364: at least one per state, usually light-desktop and dark-phone). Product code was not changed. Size: S = a CSS tweak, M = a component change, L = wrong or unreadable. "Fixture" in the note = may be an artefact of the fixture page; confirm in the app.

**L**

| # | Row / surface | Shot | What is wrong | Suspected place |
|---|---|---|---|---|
| 1 | NP-ED-08 highlight, dark | `NP-ED-08__text-blocks__dark__*.png` | The default `<mark>` highlight is saturated `#ff0` yellow with near-white text on it: "a highlight" cannot be read in dark. In light it is neon yellow, outside the palette. | editor CSS for `mark` / Highlight default colour (`styles/workspace.css`, `lib/tiptap` highlight config) |
| 2 | NP-DB-23 phone table | `NP-DB-23__phone-table-scrolled__*__phone.png`, `NP-DB-03__table__*__phone.png` | Row titles are cut hard with no ellipsis ("A living worksp", "Write release n"). The sticky title column is ~150 px, a third of it checkbox. After a sideways scroll the sticky column's opaque background reaches past its text and blanks the next column (Status cells look empty, with slivers of chips). | `components/database/views.tsx` table, `.db-table-wrap` sticky rules |
| 3 | NP-PG-08 serif font | `NP-PG-08__page-style__*__desktop.png` | Choosing "Serif font" in the page ⋯ menu makes a raw property appear under the title: **Content Font: serif**, in an editable box. An internal metadata key is shown as a user property. | `components/database/PropertyBar` free-key scan (should skip `contentFont`) |

**M**

| # | Row / surface | Shot | What is wrong | Suspected place |
|---|---|---|---|---|
| 4 | Sidebar, all desktop shots | `NP-SB-02__sidebar-search-row__*__desktop.png`, `NP-SB-04…` | The fixed footer (New page, Trash, sync state, Workspace settings, account) is ~250 px tall; at 900 px the tree gets five rows and is cut mid-row with no fade. | `components/layout/Navigation.tsx`, `styles/workspace.css` |
| 5 | NP-SB-14 Tools | `NP-SB-14__tools-section__*__desktop.png` (first capture) | Expanding Tools shows only "Calendar": the rest opens under the footer and is not scrolled into view. (The gallery state scrolls it into view by hand.) | Navigation tools section |
| 6 | NP-SB-15 / NP-OF-01 offline | `NP-SB-15__footer-offline__*`, `NP-OF-01__offline__*` | Offline is announced four times at once: header badge, a full-width "Offline copy from 3:00 PM" banner that pushes the toolbar down, the sidebar footer, and a floating "Offline" pill that overlaps the status-bar border. | `OfflineIndicator`, `OfflineCopyNotice`, `SyncStateBadge` |
| 7 | NP-PG-05 properties | `NP-PG-05__properties__*` | Three control styles in one row: property values in input-like boxes, grey tag chips with ×, an outlined blue "Add tag", a ghost "+ Add property", and a vertical rule between them. Reads as a form, not a quiet label/value list. On phone the block takes ~200 px before the body. | `PropertyBar`, `DocumentChrome` tags row |
| 8 | NP-PG-07 page menu | `NP-PG-07__page-menu__*` | ~18 rows scrolling inside a 520 px box; the last visible row is cut in half with no fade, and the page-info footer the row asks for is below the fold. "Small text" has a smaller icon and its label starts 2 px left. | `PageMenuPopover`, `usePageMenuItems` |
| 9 | NP-PG-11 outline | `NP-PG-11__outline__*` | The outline is a popover that covers the breadcrumb, the icon/cover buttons and the top of the title (the row says it must not cover the text). No current-section mark at rest. | `DocumentOutline` |
| 10 | NP-PG-01 icon picker | `NP-PG-01__icon-picker__*` | Stock emoji-picker look: pure black search field with a white border in dark, its own radius and type scale, a yellow skin-tone square. It covers the title. | icon picker theme variables in `DocumentChrome` |
| 11 | NP-ED-17 phone toolbar | `NP-ED-17__selection-toolbar__*__phone.png` | The toolbar wraps to a second row that holds only colour and mention, and covers the "Add property · Updated · Properties" line. | `SelectionActions` CSS |
| 12 | NP-CO-05 share dialog | `NP-CO-05__share-people__*` | Level pickers are browser-native `<select>` boxes beside custom controls (also Link access, filters, agent permissions, settings fonts); boxed trash buttons; four paragraphs of explanation. The dialog is taller than 900 px and its last card is cut at the edge. | `components/sharing/ShareDialog` |
| 13 | NP-CO-01 comments panel | `NP-CO-01__inline-comment__*` | Open / Resolved are two full-width buttons, the active one solid blue; thread actions are 12 px unlabelled icons; the Reply field is 16 px text beside 13 px comments. | `CommentsSidebar` |
| 14 | NP-CO-11 share route | `NP-CO-11__presence__*__desktop.png` | On `/collab` the Outline / Formatting + Editing / ✓ / ✗ toolbar sits between the page header and the body and is wider than the text column; ✓ and ✗ are unlabelled coloured icons. | `apps/web/src/collab/CollabDoc.tsx` |
| 15 | NP-DB-24 task board | `NP-DB-24__task-board__*` | Each card has its own status `<select>`, a ⋯ and a drag grip — three controls on a two-line card, the select repeating the column. The last column is cut by the viewport with only a small round arrow. | `TaskBoardRenderer` |
| 16 | Database, phone | `NP-DB-03__table__*__phone.png` | Four stacked control rows (tabs, Search, Filter/Sort/settings/⋯, a full-width New split button whose dropdown half is as wide as the action) use ~230 px before the first row. | `ViewControls` CSS |
| 17 | NP-SR-01 palette | `NP-SR-01__palette-recents__*` | Four rows of chrome above the first result and two footer rows; commands in Title Case ("New Document") against sentence case elsewhere; every recent row repeats "Recently opened · Edited 4 days ago". | `CommandBar` |
| 18 | NP-SR-03 highlight | `NP-SR-03__match-highlight__*` | The match is only bold, with no tint: in result titles it is nearly invisible. The first snippet glues the heading to the body ("Purpose A shared place…"). | `searchHighlight`, snippet builder |
| 19 | NP-SR-04 filters, phone | `NP-SR-04__search-filters__*__phone.png` | Filters open as five native selects and a native checkbox over four rows (~250 px) above the results. | `navigation/searchFilters.tsx` |
| 20 | NP-OF-06 | `NP-OF-06__saved-changes-dialog__*` | Header says "Offline · changes saved on this device"; the Saved changes dialog says "No pending changes for this account and workspace." Fixture — may be the save debounce; confirm. | `OfflineIndicator` dialog |
| 21 | Tabs, everywhere | compare `NP-CO-05`, `X-SETTINGS__workspace-settings`, `NP-CO-01`, `NP-PG-12__history-compare` | Four tab styles: underline (Share, History, Inbox, database views), filled pill (workspace settings, ⌘K kinds), solid segmented (comments), text segmented (version viewer). | shared tab component |
| 22 | NP-SB-03 Home | `NP-SB-03__home__*` | Recently visited cards are 90 px tall with an icon and a title only; the row is left-aligned and leaves the right half empty while the cards below span the width. Task status is raw text ("in-progress"). | `components/home` |
| 23 | Desktop chrome | every workspace shot | A status bar (vault note count, content type, Sans / Serif / Mono, vault name, gear) and a second toolbar row (Outline, Formatting) frame the page: two rows above and one below that Notion does not have. Owner's call. | `StatusBar`, document toolbar |
| 24 | NP-DB-18 peek | `NP-DB-18__row-peek__*` | The side peek repeats the whole page chrome (toolbar row, breadcrumb, Add icon / cover) and a 40 px title in a 640 px panel. | `RowPeek` |

**S**

| # | Row / surface | Shot | What is wrong |
|---|---|---|---|
| 25 | NP-SB-01 | `NP-SB-01__vault-switcher__*__desktop.png` | "Manage workspaces & vaults…" wraps to two lines in the 240 px menu. |
| 26 | NP-SB-07 | `NP-SB-07__tree-row-menu__*` | Three export entries (Export as Markdown, Export as HTML, Export…). The phone sheet has no Rename. |
| 27 | NP-SB-10 phone | `NP-SB-10__trash__*__phone.png` | Row detail truncated: "… 1 page inside · deleted O…". Desktop dialog has no visible scrim. |
| 28 | Phone drawer | `NP-SB-06__page-tree__*__phone.png` | Search placeholder says "(⌘K)" on a phone; a strip of the selected row shows under the sticky search field; the chevron keeps a grey pressed square. |
| 29 | NP-PG-12 | `NP-PG-12__history-*` | Viewer control row is two segmented controls joined by loose text; "50/50" unlabelled; each row repeats the date of its day heading. |
| 30 | NP-PG-14 | `NP-PG-14__empty-starters__*` | Two prompts stacked ("Start writing, or press / …" and "Press Enter to write, or start with"). |
| 31 | NP-ED-08 | `NP-ED-08__text-blocks__*` | List items ~40 px apart; nested bullet uses the parent's marker; toggle arrow sits 2 px low. |
| 32 | NP-ED-03 phone | `NP-ED-03__slash-menu__*__phone.png` | Menu opens above the caret over the title; last row cut with no scroll cue. |
| 33 | NP-ED-16 | `NP-ED-16__colour-menu__*` | A long text list with 12 px swatches; the Highlight group is cut after "Gray highlight". |
| 34 | NP-ED-07 | `NP-ED-07__shortcut-sheet__*` | The two columns start 10 px apart in height; last rows cut with no fade. |
| 35 | NP-ED-18 | `NP-ED-18__link-card__*` | The card sits over the next line of text. |
| 36 | NP-DB-03/04 | `NP-DB-03__table__*`, `NP-DB-04__board__*` | Status and priority shown as stored enums ("in-progress", "todo"); all titles bold; board "+ Add item" at the top of the column. |
| 37 | NP-DB-05 | `NP-DB-05__gallery__*` | A cover that fails to load shows the broken-image glyph with an outline (no fallback tile). Letter tiles look like placeholders. |
| 38 | NP-CO-06 | `NP-CO-06__share-link__*` | "Expires 10/6/2026" — numeric date; elsewhere "Oct 6". |
| 39 | NP-CO-12 | `NP-CO-12__suggestion-review__*` | Suggestions are green / red for every author (row: author's colour); Accept is light blue with dark text in dark. |
| 40 | NP-CO-13 | `NP-CO-13__request-access__*` | An unavailable document still shows the save dot, star and share; "Retry document" outline is heavier than the primary button. |
| 41 | NP-CO-08 | `NP-CO-08__publication-page__*` | Page title lighter and smaller than the first H1 below it. |
| 42 | NP-TX-01 | `NP-TX-01__templates-gallery__*` | Row subtitle truncated ("Shared with the workspace ·…") because five text actions share the row. |
| 43 | NP-AI-03 phone | `NP-AI-03__page-agent-proposal__*__phone.png` | Three buttons in a row then a full-width Discard; button text larger than the sheet's. |
| 44 | NP-MB-04 | `NP-MB-04__keyboard-toolbar__*` | Toolbar cut at the right edge with no scroll cue; block grip 2 px from the text. |
| 45 | NP-OF-01 | `NP-OF-01__save-failed__*` | Failure stated three times (header, footer, status-bar sentence with a second Retry). |
| 46 | NP-MB-01 | `NP-MB-01__more-sheet__*` | Sheet titled with the page name but mixes destinations with page actions; last row cut. |
| 47 | NP-AX-01 | `NP-AX-01__settings-appearance__*` | 12 px native checkbox for Reduce motion at the far right of a full-width row; last row cut by the dialog edge. |
| 48 | Header | every workspace shot | "Open 1 ⌄" has no label that says what it counts. |

### Status after the w14 visual pass (branch `feat/w14-visual`)

Fixed = changed in product code and the state recaptured and looked at (light and dark; desktop and phone where the state has both) unless the row says otherwise. "Before" images are the ones this list was written from.

| # | Status | What changed / why not |
|---|---|---|
| 1 | **fixed** | A plain `<mark>` uses `--highlight-bg` (themed tint, AA text) instead of the browser's `#ff0` — `styles/workspace.css` `:where(mark)`. |
| 2 | **fixed (CSS)** / rest → track db-calc | Phone table: the hover-only arrow no longer takes room, the 44 px title button is a block (ellipsis works), tighter checkbox gutter, stronger edge line — `database.css`. The "blank Status column" in the old shot was one column scrolled partly under the frozen one (the recipe now scrolls a whole column). Still needed in `views.tsx` (db-calc): the table's inline `width` keeps the 280 px title column while phone CSS forces 168 px, so the difference is spread over every column — compute the total from the phone title width. |
| 3 | **fixed** (spec failed first) | `contentFont` is presentation state, never listed as a property: `PRESENTATION_KEYS` / `isListableKey` in `lib/database/schema.ts`. |
| 4 | **fixed** | Sidebar footer ~180 px (was ~250): tighter rows, sync state beside the account (it wraps to its own line when long); the tree ends in a fade (a sticky gradient, not a mask — a mask hid the tree row menus). |
| 5 | **fixed** (spec failed first) | A section opened from its header scrolls itself into view (`NavSection`). |
| 6 | **fixed** | Header badge = the state and the one live region; the sidebar footer mirrors it silently; "Offline copy from …" is the one page line (caption, no band); the floating pill no longer appears for plain offline / healthy queued changes. |
| 7 | **fixed** | Properties under the title: one quiet style (label over value, no boxes, no vertical rule, ghost "Add tag"). |
| 8 | **fixed** | Page ⋯ menu: font / layout / export are one row each; the list fits the window and the page info is pinned under it. |
| 9 | **partly** | With room beside the text column the outline opens IN the margin (covers nothing) — new state `NP-PG-11 outline-beside`. In a window too narrow for that (document panel open, as in `NP-PG-11 outline`) it is still an overlay over the top-left of the page. A never-covering outline there needs a docked panel that stays open — a product decision. |
| 10 | **fixed** | Icon picker wears Prism tokens (surface, search field, focus ring, type scale, round tone swatch). It still opens over the title (a transient picker). |
| 11 | **fixed** | Phone selection toolbar: one row that scrolls sideways with a fading end. It still sits above the selection (a bubble covers what is above it). |
| 12 | **partly** | Selects carry the app's one chevron (main's form-control rule, after the old capture); person rows use quiet controls (no boxed select / trash). Not changed: the amount of explanation text and the dialog's height. |
| 13 | **fixed** | Comments: the one tabs style, 28 px thread actions with 14 px icons, 13 px fields (16 px on touch). |
| 14 | **partly** / rest → CollabDoc tracks | "Accept all" / "Reject all" are labelled. The toolbar's position and width on `/collab` are laid out in `apps/web/src/collab/CollabDoc.tsx` (not edited here): mount the bar above the page header, full width and sticky, as the workspace does. |
| 15 | **partly** | Card controls are quiet text until pointed at. Removing the per-card status select and the Earlier / Later buttons (the ⋯ menu and drag already do both) is a `TaskBoardRenderer` change that `boards.spec.ts` drives — not done. |
| 16 | **fixed (CSS)** | Phone database toolbar: tabs, search, one row of 44 px icon actions + New. |
| 17 | **partly** | Filters sits in the kinds row, the status line is slim, recent rows show where the page lives instead of repeating "Recently opened". Not changed: Title Case command names (specs select commands by name) and the two footer rows. |
| 18 | **fixed** (highlight) | A match is tinted (`--highlight-bg`) as well as bold. The snippet's heading-to-body join is unchanged. |
| 19 | **fixed (CSS)** | Phone search filters: one row of chips that scrolls sideways. |
| 20 | **fixed — product bug** (spec failed first) | The header said "saved on this device" during the autosave debounce, before the change was in the on-device queue; the dialog lists that queue. Now: `Offline · saving on this device…` until it is queued, and the dialog says "Saving your latest edit on this device…" in the gap. |
| 21 | **fixed** | ONE tabs style: `.prism-tabs` / `.prism-tab` (`styles/workspace.css`), applied to workspace settings, the document panel, History, Comments, the version viewer, ⌘K kinds; Share / Inbox / database views aligned to the same look. |
| 22 | **fixed** | Home: recent pages are compact one-line cards that fill the row; task status reads as words. |
| 23 | **not changed — owner's call** | Status bar and second toolbar row. |
| 24 | **fixed (CSS)** | Row peek: no breadcrumb, 28 px title, less air above. The toolbar row remains. |
| 25 | **fixed** | One line ("Workspaces & vaults…", full name kept for assistive tech). |
| 26 | **partly** | The three exports are one row in the tree row menu too. The phone sheet still has no Rename. |
| 27 | **partly** | Phone: the row detail wraps to two lines. Desktop scrim unchanged. |
| 28 | **partly** | No "(⌘K)" on a phone. The strip under the sticky search field and the chevron's pressed square are unchanged. |
| 29 | **partly** | The two switches use the tabs style. "50/50" and the repeated dates are unchanged. |
| 30 | **fixed** | One prompt (the starters line reads "Or start with"). |
| 31 | **partly** | List items sit closer; nested bullets use circle / square. The toggle arrow is unchanged. |
| 32 | not changed | Slash menu placement on a phone. |
| 33 | **fixed** | The colour menu shows both groups (taller). |
| 34 | → track deviations | `ShortcutSheet.tsx` is theirs. |
| 35 | not changed | Link card placement. |
| 36 | not changed | Showing "In progress" for `in-progress` in database cells changes what many specs read; needs an owner decision (option labels exist as a schema hint). |
| 37 | not changed | Needs an `onError` fallback in the gallery card (`views.tsx`). |
| 38 | **fixed** | "Expires Oct 6". |
| 39 | **partly** | Accept uses the action tokens in both themes. Per-author colours unchanged. |
| 40 | **partly** | The heavy outline was `--border-subtle`, used in 16 places and defined nowhere (borders fell back to the text colour) — now defined. The header's save dot / star / share on an unavailable page are unchanged. |
| 41 | **fixed** | Published page title: 34 px, bold. |
| 42–43, 46 | not changed | |
| 44 | **partly** | The keyboard toolbar's end fades. Grip spacing unchanged. |
| 45 | not changed | The footer sentence is the only place the server's reason is shown and four specs drive its Retry. |
| 47 | → track appearance | Settings → Appearance is theirs. |
| 48 | → track deviations | `TabBar` header is theirs. |

Not seen in any capture: a white panel in dark mode, sideways page scroll, a focus ring around the writing surface, bottom controls over content.

**Not looked at:** roughly 250 of the 364 images (mostly the second theme of a state already read in the other). Dark-mode leaks in those would be missed by this list — the reviewer's pass over the gallery covers them.
