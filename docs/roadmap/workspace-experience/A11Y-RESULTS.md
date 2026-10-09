# Accessibility results (NP-AX-01 … 08)

Branch `feat/w5-a11y`, 2026-10-03. Evidence for the NP-AX rows of `NOTION-PARITY-CHECKLIST.md`.
This file records what was checked, how, the result, and what is **not** verified. It does not
change the checklist or `PARITY-EVIDENCE.md`.

## How it was checked

`apps/web/e2e-fixtures/notion-a11y-axe.spec.ts` (new, `@axe-core/playwright` 4.13) opens every
primary surface from `a11y-surfaces.ts` — 66 surfaces — in **light and dark**, at **1440×900 and
390×844** (surfaces that exist on one form factor only run there): 246 runs + one static check
that `index.html` has `lang` and a `<title>`. Each run asserts

1. zero axe violations of impact **serious** or **critical**, and
2. in dark, no element larger than a chip paints a light background ("no white panels", soft).

Surfaces: page tree, tree row menu, sidebar peek, new-page chooser; the page shell (plain, with
inbox badge + favorites); plain editor blocks, media blocks, the live editor (single and paired);
slash menu, block menu (+ Turn into, Color), selection toolbar (+ Color, Turn into), @ menu, find
bar, page ⋯ menu, cover dialog, icon picker; ⌘K (results, filters), search page; database table,
board, gallery, list, calendar, filter, sort, view settings, add view, column menu, select editor,
date editor, side and center peek, bulk bar, CSV import, page properties, task board; Share
(people, link, publish, sync); page discussion + comments sidebar, live comments panel, suggestion
review; Inbox, notification settings, Home; Settings (Appearance, Services, Account), account
menu; import and export dialogs; move dialog, Trash + toast; history panel, version viewer, page
updates; shortcut sheet; agent chat (with history, empty), document companion (desktop, phone),
phone More sheet.

Not in the sweep: sign-in screens, the published wiki (`/p/:slug`), governance, network/federation
panels, the map, people directory, messages/email/calendar dashboards, the canvas (Excalidraw).

What the spec does not check, and why:

| Excluded | Scope | Reason |
|---|---|---|
| `document-title`, `html-has-lang` | rule, all fixture pages | Fixture pages are scaffolds; the real `index.html` is asserted by its own test in the same file. |
| `.excalidraw`, `.EmojiPickerReact` | element subtree | Third-party widgets (their own chrome). |
| `scrollable-region-focusable` | only the slash and @ `role="listbox"` elements | They are driven from the editor with `aria-activedescendant`: focus stays in the text, the active option is scrolled into view, ↑/↓ reach every option. A tab stop inside the list would pull focus out of the text being typed. |
| `.page-toast` | "no white panel" check only (axe still runs on it) | An inverted snackbar by design (light pill on dark); its text is AA on it. |

Nothing else is disabled. Moderate and minor axe findings are **not** asserted and were not triaged.

## Result of the sweep

First run on the interrupted work: 155 pass / 88 fail. Final: **246 / 246 surface runs clean**
(reports in the run's `A11Y_REPORT` directory: 0 files with a violation or a light panel), run in
five slices with one worker.

### Found → fixed (by surface)

**Roles and structure (NP-AX-03)**

- Slash / @ / `[[` menus: `aria-activedescendant` and `aria-autocomplete` sat on a contenteditable
  with no role (ignored by assistive tech). While one of these lists is open the editor is now a
  named multi-line `textbox` that controls the list (`lib/tiptap/popupAria.ts`); everything is
  removed again when the list closes. `aria-expanded` was dropped (not valid on a textbox).
- Block menu and "Move to": the search field (and its "No results" status) lived inside
  `role="menu"`. The popup is now a plain container holding the field and the menu.
- Editor menus (Color, Turn into…): a scrolling menu had no tab stop; the first enabled item is
  now the roving tab stop.
- Page ⋯ menu: the page-info `<dl>` was a child of `role="menu"`; it now sits beside the menu.
- Cover dialog: "Remove" was inside the `tablist`; swatches were `role="listitem"` buttons with
  `aria-pressed`. Now: the tablist owns only tabs, swatches are pressed buttons in a labelled group.
- Board: columns (regions) were direct children of `role="list"`; each is now in a box-less list item.
- Gallery: the "New" tile was a non-item child of the list; the list now owns only the page cards.
- Status / select / relation pickers: `role="option"` wrapped a `<button>` (nested control). The
  button is the option now.
- A reader's relation / person cell: links inside a button → a labelled group of links (a
  read-only cell has no other action). URL / email / phone cells: the link sits beside the cell's
  button, named by its value.
- Shortcut sheet: the scrolling body is a focusable, labelled region.
- Settings → Services: unnamed "add vault" icon button, vault name/address fields and five
  `<select>`s now have names.
- From the interrupted work (re-verified by the sweep, not re-derived): the page tree is
  `tree`/`treeitem` with `aria-expanded`; labels and roles across agent chat, inline prompt,
  calendar, compose, messages, transcript review, dashboard editor, metadata panel, move dialog,
  share button, inbox, board forms, publish panel, task dialog, canvas.

**Contrast (NP-AX-04), both themes**

- Tokens (`styles/workspace.css`, mirrored in `print.css`): `--text-muted` and light
  `--text-secondary` darkened/lightened to ≥ 4.5:1 on page, sidebar and hover fills; light
  `--color-accent`, status colours and `--text-accent` AA as text on white and on their tints;
  dark `--color-danger` 5.1:1 as text on menus; new `--danger-bg` for white-on-danger fills.
- Muted text on the stronger selected fills (active slash row, selected ⌘K row, open agent
  session) steps up to secondary.
- Primary buttons use `--action-bg` / `--action-fg` (white on the dark theme's light accent was
  2.4:1): share dialog, comments tabs, comment composer, remote-update bar, settings, others.
- Option chips (yellow was 4.2:1 in light), person-avatar initials (3.0–4.3:1), calendar
  out-of-month day numbers (opacity → muted colour), the account hint (opacity removed), bulk bar
  count, danger menu items in dark.
- Suggestion marks: the stored mark's inline colour (any collaborator colour) was 2.05:1 for
  green on its tint in light. The words now keep reading contrast; the underline / strike and
  tint carry the author colour (the agent's default green/red map to the AA status tokens). The
  document is not rewritten — it is a stylesheet override.

## Per row

| Row | What was checked | How | Result | Not verified |
|---|---|---|---|---|
| NP-AX-01 dark parity | No light panel and no serious axe violation in dark on all 66 surfaces, desktop + phone | `notion-a11y-axe.spec.ts` dark runs | Pass (123 dark runs) | The native launch screen; the surfaces listed as not in the sweep; the Light/Dark/System setting itself (theme is forced by class in the sweep); visual review by a person. |
| NP-AX-02 keyboard only | Structural pieces only: scrolling menus and the shortcut sheet have a tab stop; activedescendant lists are wired to a role that honours them; no control nested in another | axe rules (`scrollable-region-focusable`, `nested-interactive`, `aria-*`) | Pass for those rules | **The named keyboard-only journey test does not exist.** Focus return to the opener, focus traps, Esc behaviour and visible focus were not swept. |
| NP-AX-03 screen readers | axe: 0 serious/critical on every surface; tree roles; menu/listbox/option roles; names on icon buttons and fields | `notion-a11y-axe.spec.ts` | Pass (246/246) | **Real VoiceOver (macOS, iOS) — not run.** Live-region announcements (save state, toasts) are present in markup but not listened to. Moderate/minor axe findings not triaged. axe covers roughly a third of WCAG; passing it is not conformance. |
| NP-AX-04 contrast | Text contrast ≥ 4.5:1 (3:1 large) on every swept surface in both themes; suggestions carry strike/underline, not colour alone | axe `color-contrast` in the sweep | Pass | The named "contrast tokens AA" token-pair test does not exist. Non-text contrast (borders, icons, focus rings), text over images/gradients (axe skips them), hover/pressed states other than the ones the recipes open, white on `--color-danger` fills outside the five converted to `--danger-bg`. |
| NP-AX-05 200 % zoom / Dynamic Type | — | — | **Not checked** | Everything. |
| NP-AX-06 motion | Existing `notion-a11y.spec.ts › reduced motion disables transitions` (search sheet). Sweep harness note: colour transitions on `*` (0.3 s, inherited level by level) are disabled under reduced motion by the existing rule | existing spec, not extended | Unchanged | Menus, sheets and peeks durations are still unmeasured. |
| NP-AX-07 touch targets | — | — | **Not checked** (no ≥ 44 px sweep was written) | Everything beyond the existing point checks. |
| NP-AX-08 IME / dictation | — | — | **Not checked** | Everything beyond the existing composer cases. |

## Verification runs

See the hand-off report for the exact commands and counts. All browser runs: fixture config
(`playwright.config.ts`), `E2E_PORT=5362`, headless Chromium only. No WebKit/Safari, no Firefox,
no real device.

---

# Pass 2 (branch `feat/w7-a11y`, 2026-10-03)

Pass 1 left NP-AX-02, -05, -07 and -08 unchecked and -06 unchanged. Pass 2 writes the missing specs,
fixes what they found, and adds the surfaces Pass 1 skipped. Everything below was run in headless
Chromium against the fixture config (`E2E_PORT=5362`, one worker). No WebKit, no Firefox, no device,
no screen reader, no real IME. The full browser suite was **not** run by this pass.

## Per row

| Row | What was checked | Spec › test | Result | Human-only / not verified |
|---|---|---|---|---|
| NP-AX-01 dark parity | The 13 added surfaces in dark, desktop + phone: no serious axe finding, no light panel | `notion-a11y-axe.spec.ts › axe: no serious violations › <surface> · <vp> · dark` | Pass | Native launch screen; the Light/Dark/System control itself; a person looking at it. |
| NP-AX-02 keyboard only | 8 journeys driven with `page.keyboard` only after load, plus 14 menus/dialogs that must close on Esc with focus back on the opener. At each stop a focus indicator; Tab leaves every non-modal widget | `notion-a11y-keyboard.spec.ts › keyboard-only journey › …` (8) and `› Esc closes and focus returns to the opener › …` (14) | **Pass, 22/22** after the fixes below | Chromium only. "Focus indicator" = a computed outline or box-shadow; for a text field or the editor a caret is accepted; for an `aria-activedescendant` list the marked option is accepted. Whether the ring is *visible enough* (non-text contrast) is not measured. History panel journey is covered only as "open version viewer, Esc, focus returns". |
| NP-AX-03 screen readers | Live regions exist and carry the text for: save state (saving / failed + retry / saved / offline), moved to Trash + Undo, Link copied, share-dialog copy, inbox archive (focus kept). Axe on the 13 added surfaces | `notion-a11y-live.spec.ts` (4); axe sweep | Pass | **VoiceOver / TalkBack were not run.** A live region in the markup is not proof it is spoken (toasts are inserted with their text, which some readers skip). |
| NP-AX-04 contrast | Added surfaces only (calendar dashboard fixed) | axe `color-contrast` in the sweep | Pass on what was run | Same gaps as Pass 1 (non-text contrast, text over images, hover states). |
| NP-AX-05 200 % zoom | Every surface: desktop opened at 1440×900 then set to 720×450; phone opened at 390×844 then set to 320×568. No sideways page scroll (document, main, dialogs, panels), no control off the side, no control under another control, WCAG 1.4.12 text spacing does not clip | `notion-a11y-reflow.spec.ts › 200% zoom no overflow › <surface> · <vp>` (149) + a self-test that the measures detect a broken page | **Pass, 150/150** | It is a viewport change, not a browser zoom. **iOS Dynamic Type XXL was not checked.** The text-spacing check only sees text cut off by an `overflow: hidden` box; text that spills out of a box and overlaps a neighbour is not detected. Overlap is only detected between controls in the same scroller. Tables, boards and code scroll inside their own scroller by design. |
| NP-AX-06 motion | 18 popups (page menu, tree menu, block menu, slash menu, selection toolbar, database popover, side + center peek, share dialog, sidebar peek, ⌘K, Trash + toast, shortcut sheet, account menu; phone: More sheet, drawer, page sheet, filter sheet): entrance ≤ 180 ms; under `prefers-reduced-motion` and under the in-app setting the entrance is ≤ 1 ms and nothing on the page keeps animating | `notion-a11y.spec.ts › reduced motion disables transitions: menus, sheets, peeks › …` (18) + the Pass 1 test | Pass, 19/19 | Only the upper bound is asserted: a popup with no entrance at all passes (the measured value is in each test's `entrance-ms` annotation). Exit animations are not measured. |
| NP-AX-07 touch targets | Every surface at 390×844 with touch + coarse pointer. A control passes at ≥ 44×44, or with a ≥ 44×44 hit area, or at ≥ 24×24 with no other control inside the 44 px square around it | `notion-a11y-touch.spec.ts › touch targets ≥44px › <surface> · phone` (67) | **Pass, 67/67, with one pinned exception:** the database month grid (40 controls: per-day "+" 19–22 px, page chips 42×18) | **Only controls in the first screenful of each surface are measured** (off-screen and covered controls are skipped), and an opener whose popup is open is skipped. Unstyled buttons that the fixture pages add are excluded by name. Not measured: Excalidraw, the emoji picker, the map, inline links in text. No real finger. |
| NP-AX-08 IME | Composition via Chromium `Input.imeSetComposition`: slash / @ / `[[` menus stay closed, candidate-list keys do nothing, Markdown input rules do not fire, committed text lands once; the committing Enter (both browser shapes, dispatched) does not split a block, pick a slash row, commit a title, open a ⌘K row, post a page comment or send a reply; a remote update and the autosave debounce during a composition leave it running and the page unadopted | `notion-a11y-ime.spec.ts › IME composition › …` (5); existing `agent-composer-growth.spec.ts` still passes | Pass, 5/5 | **No real Japanese/Chinese IME, no iOS dictation, no autocorrect.** The committing Enter is a dispatched event, not a key the input method swallowed. Safari's behaviour is modelled, not run. |

## Found → fixed in Pass 2

**Keyboard (NP-AX-02)**
- Database popovers (Filter, Sort, View settings, column menu, More actions, cell editors, templates,
  card menus — one `Popover`): opened with no focus inside. They focus their first control and give
  focus back to the anchor when they close with focus inside.
- Block menu opened with ⌘⇧/: Esc left focus on nothing. It returns to the text.
- ⌘K on a selection: the link field appeared but the caret stayed in the document, so typing the
  address replaced the selected words. Cause: the bubble is attached to the page about 250 ms after a
  selection or format change, and focusing a detached field does nothing.
- Inbox: archiving the row that has focus dropped focus to `<body>`; it moves to the next row's
  button. The notification settings panel takes focus, closes on Esc, and returns focus.
- Page ⋯ and tree ⋯ menu items showed only the hover fill when focused; they have a ring.

**IME (NP-AX-08)**
- One guard at window capture (`lib/ime/keyGuard.ts`) stops composition key events before any handler.
  Before it, the comment reply field sent on the committing Enter and the slash menu picked a row on
  Safari's key shape.
- A composed "/" opened the slash menu (and `[[` the page list). They no longer open mid-composition.
  An already open menu keeps filtering, so Android keyboards (which compose every word) still filter.

**Reflow and touch (NP-AX-05 / -07)**
- Live-document selection toolbar on a phone was 560 px wide in a 390 px screen: "Comment" was off
  screen. It wraps inside the screen.
- Comment reply row overflowed its card at narrow widths.
- `styles/touch.css` (one media query, phones / coarse pointers only): top bar, breadcrumbs, title and
  icon controls, tree disclosure and row actions, sidebar section buttons, block handle hit area, find
  bar, comment icon buttons, database tabs / row titles / cells / checkboxes / icon buttons / option
  remove, dialog checkbox rows, notification-settings checkboxes, share invite field, messages search
  field, sign-in "email me a link".

**Surfaces Pass 1 skipped** — now in `a11y-surfaces.ts` (axe, touch, reflow): sign-in, accept-invite,
published wiki, locked published wiki, people directory, person profile, messages inbox, message
thread, email thread, calendar dashboard, governance, governance proposals, map (no-WebGL fallback).
Serious findings: calendar dashboard only — days outside the month (2.45:1 light, 3.43:1 dark) and
event chips (3.83:1). Fixed.
Still not swept: set-password and reconnect screens, native sign-in, network/federation panels, the
map with WebGL, the canvas (Excalidraw), the graph.

**Announcements** — Share dialog and share popover: "Copy" only swapped its own label; a polite live
text now says "… copied".

## Moderate axe findings (recorded, not asserted)

From the desktop half of the sweep (both themes). The phone half was collected only for the 27
surfaces re-run at the end.

| Rule | Where | Status |
|---|---|---|
| `landmark-no-duplicate-banner` | database row peeks | **Fixed** (database and peek headers are plain containers). |
| `heading-order` | database calendar (h1 → h3) | **Fixed** (month is an h2). |
| `aria-allowed-role` (minor) | gallery cards (`article` + `listitem`) | **Fixed**. |
| `landmark-one-main`, `region` | sign-in, accept-invite | **Fixed** (`role="main"`). |
| `region` | sidebar brand row, popup menus portaled to `<body>`, shortcut sheet, sidebar peek | Open. The sidebar is not inside a landmark of its own; menus are portaled. |
| `landmark-one-main`, `page-has-heading-one`, `region` | agent chat, messages, email, calendar, search, live-editor fixtures | Fixture pages mount the component without the app shell (`<main>` comes from the shell). Not checked in the shell. |
| `landmark-no-duplicate-main`, `landmark-main-is-top-level`, `landmark-unique` | database fixtures, comments fixture | The fixture page wraps the app in its own `<main>`; the comments fixture renders two views side by side. Fixture artefacts. |

## Open

- Database month grid on phones: 40 controls under 44 px (seven 51 px columns). Needs a design
  decision (e.g. day tap opens a list), not padding.
- `region` findings on the sidebar and portaled menus.
- Everything in the "Human-only" column above.

## Verification runs (Pass 2)

All with `--workers=1 --reporter=line`, behind a host-load gate.

| Run | Result |
|---|---|
| `notion-a11y-keyboard`, `-ime`, `-live`, `notion-a11y` (motion) | 50 passed |
| `notion-a11y-touch` (67 phone surfaces) | 67 passed (month grid pinned as known) |
| `notion-a11y-reflow` (149 surface runs + self-test) | 150 passed |
| `notion-a11y-axe`, desktop half, all surfaces | 162 passed, 2 failed (calendar dashboard — fixed, re-run below) |
| `notion-a11y-axe`, 27 new/changed surfaces, both viewports and themes | 105 passed |
| Existing specs for changed components: `databases`, `notion-db-views/props/inline/csv`, `boards`, `page-properties`, `notion-inbox`, `notion-comments`, `notion-mentions`, `inbox`, `messages`, `calendar`, `notion-swipe`, `agent-composer-growth`, `editor-toolbar`, `editor-slash`, `editor-blocks`, `shortcuts`, `pages-nav`, `sharing`, `notion-sharing`, `notion-sidebar`, `notion-mobile`, `mobile-navigation`, `publication`, `notion-page`, `notion-editor` | all passed after three corrections: a `databases.spec` assertion that looked the month up by heading level 3; a block-menu focus regression introduced and fixed in this pass; a `sharing.spec` strict-mode clash with a new `role="status"` (now `aria-live` only) |
| `npm run typecheck` (root), `npm run typecheck:e2e -w @prism/web` | clean |

Not run: the phone half of the axe sweep for surfaces this pass did not change; the full browser
suite; server tests (no server code changed).

## Pass 2 — review fixes (2026-10-03)

Five should-fix items from the independent review, plus three small ones. "Failed first" = the new
test was run against the code before the fix.

| # | Fix | Spec › test | Failed first? |
|---|---|---|---|
| 1 | Slash and `[[` plugins re-run their check 60 ms after `compositionend`, so a trigger produced BY a composition opens its menu even if ProseMirror does not call `update` again | `notion-a11y-ime.spec.ts › a "/" or "[[" committed by a composition opens its menu` | **No.** With Chromium's CDP composition ProseMirror does call `update` after the commit, so the test passed before the fix too. The fix is defensive; the reported case (Japanese half-width input, Android keyboards) is not reproduced by any test here. |
| 2 | Dialog checkbox-row rule excludes editor content (`:not(.tiptap *, .ProseMirror *)`). No other rule in `touch.css` selects inside editor content, except the `.db-*` rules, which also size inline database blocks (intended) | `notion-a11y-touch.spec.ts › touch.css stays out of editor content and out of print; breadcrumbs keep their ellipsis` | Yes (`flex 44px 8px` on a task item inside a dialog) |
| 3 | Both media-query branches are `screen and …` | same test (print emulation) | Run against the old sheet only as part of the same test, which stopped at item 2 — not shown separately |
| 4 | The phone block handle's hit area grows to the left only, never past its right edge | `notion-a11y-touch.spec.ts › phone: a tap on the first character of a paragraph places the caret` | Yes (the tap opened the block menu) |
| 5 | The IME guard listens to `keydown` only | none — no test presses Shift during a composition | — |
| — | Breadcrumb parts keep their ellipsis on phones (inline-block + line-height, not flex) | same test as 2 | Not run separately |
| — | `touch.css` header comment corrected: the width branch also applies to a narrow desktop window | — | — |
| — | Calendar dashboard: events on days outside the month are quiet chips (neutral fill, secondary text) in both themes; the day number stays on the muted token | axe `calendar-dashboard`, both themes and viewports | — |

Also corrected in the specs: the IME test's menu locator named the `[[` list wrongly ("Link to a page";
it is "Link to a document"), so the "stays closed mid-composition" assertion did not cover `[[` in the
first Pass 2 run. It does now, and passes. The touch measure accepts a hit area that is not centred
(it measures the reach each way from the control's centre).

Runs after the fixes (`--workers=1`, gated): touch sweep + IME + keyboard 96 passed; the two new
touch tests 2 passed; `editor-blocks`, `editor-slash`, `calendar`, `notion-mobile`,
`agent-composer-growth` 42 passed; axe + reflow on six touched surfaces 35 passed; root typecheck
and `typecheck:e2e` clean. Not re-run: the full reflow sweep, the full axe sweep, the motion and
live specs (no code they cover changed).

## 2026-10-08 — scrolled touch sweep, non-text contrast, three more surfaces (`polish4/parity-quick-wins`)

Chromium and WebKit: notion-a11y-touch 152 / 152 on both, notion-a11y-contrast 182 / 182 on both, axe + reflow for the new and changed surfaces 41 / 41 on WebKit (the whole axe / reflow files on Chromium). The numbers in the tables below are the Chromium run's. Implemented and run by the same agent; not independently reviewed.

### Surfaces added to every sweep (NP-AX-01)

`a11y-surfaces.ts` gained **set-password**, **reconnect** and **network-connections** (the Connections / network panel). Because every sweep reads that list, each is now covered by axe + "no light panel in dark" (both themes, both viewports), reflow, touch targets (first screen and scrolled) and non-text contrast. Result: no axe finding, no light panel. One touch defect found and fixed: "Skip for now" on set-password was 18 px tall on a phone.

Still not swept: the native sign-in screen (it is the shell's), the graph, the canvas chrome (Excalidraw).

### Touch targets below the first screen (NP-AX-07)

`notion-a11y-touch.spec.ts` › "touch targets ≥44px · scrolled › <surface> · phone · below the first screen": `touchTargetsBelowFold` (`a11y-measure.ts`) scrolls every vertically scrolling region of the top layer a screenful at a time (two rows of overlap) and applies the same rule at each stop.

| Found | Was | Fix |
|---|---|---|
| @-menu rows ("Today", "Tomorrow", people, pages) | 40 px, stacked with no gap | `touch.css`: `.prism-mention-option` 44 px |
| View settings on a phone: Layout, Group by, "Add a calculation" selects | 34 px (the sheet is not `.db-dialog`, so the dialog rule missed them) | `touch.css`: `.db-settings select`, `select.db-control` 44 px |
| Context panel → Properties: a tag's "×" | 29 px wide beside the tag name | `context-panels.css`: 44 px |
| Context panel → "Raw JSON" | 82 × 21 px | 44 px tall; it now also says `aria-expanded` |
| Database view tabs at 320 px | the tab list shrank and its last tab sat under "Add a view" — Calendar could not be tapped | `.db-tablist { flex: none }`: the row scrolls (parity6-databases › "320 px: every view tab can be reached") |

The one pinned exception of the first sweep — the database month grid on phones — is gone: `CalendarMonthTouch` (one ≥ 44 px target per day; parity6-databases › "NP-AX-07: … at 390 px / at 320 px"). **No exception is left in the touch sweep.** Not covered: an iPad shows the desktop month grid, whose page chips are 18 px tall (PARITY-GAPS slice U).

### Non-text contrast (NP-AX-04, WCAG 1.4.11)

`notion-a11y-contrast.spec.ts`, every surface at 1440×900, light and dark — 178 runs + 4 composer tests. Colours are resolved by painting them (so `color-mix`, `oklch` and translucent values are handled) and composited over what is behind.

**Focus indicators — a gate, ≥ 3 : 1.** Tab through each surface (up to 40 stops); at each stop the outline or hard `box-shadow` ring — the most visible one — is measured against what it is drawn on.

| | |
|---|---|
| Stops measured | 3,018 |
| Below 3 : 1 | **0** (after the two fixes below) |
| Not judged | 226 — 110 show focus with a caret, a soft shadow or a change of fill only; 80 are inside the third-party emoji picker; 36 draw their ring over a gradient or an image |

Found and fixed:
- **The pressed Messages view toggle (Triage / People / Platforms) had no focus ring.** Its own `box-shadow` (a 1 px hairline) outranked `.focus-ring:focus-visible`, so a keyboard user saw nothing on the selected toggle. The pressed state now keeps the hairline and adds the ring.
- **The message composer and the agent composer** showed focus with a soft glow (1.1 : 1) and a part-strength border (2.3 : 1 in light). The focused border is now full strength — asserted ≥ 3 : 1 in both themes ("… the focused composer's border is at least 3 : 1"). The glow stays as decoration; these two are recorded as "soft-ring text fields" in the report, not failures.

**Control boundaries — measured and reported, not a gate.** Every visible text field, select, textarea and custom checkbox / radio / switch: the best of its border and its fill against what is behind it (also looking at up to two wrappers that draw the box).

| Theme | ≥ 3 : 1 | Below 3 : 1 | Not judged (gradient / native) | Median of the low ones | Range |
|---|---|---|---|---|---|
| light | 6 | 79 | 27 | 1.24 : 1 | 1.0 – 1.84 |
| dark | 7 | 78 | 27 | 1.38 : 1 | 1.0 – 1.42 |

By kind (both themes): text inputs 64, search inputs 28, custom checkboxes 16, selects 14, custom radios 10, password 7, textareas 6, combobox inputs 6, email 4, searchbox 2. A ratio of 1.0 means a borderless field on a same-coloured surface whose box is drawn further out than the two wrappers the measure looks at — those few are an under-count of the real boundary, not a new finding.

Why this is not fixed here: every one of these is the shared 1 px hairline (`--glass-border`), which is also every divider in the app. Raising it is a design decision, not a token typo — owner decision **c.17** in PARITY-GAPS (recommended: a `--control-border` token at 3 : 1 for form fields only).

Not measured at all: icon-only controls against their background, text over cover images.

### Page property editors (NP-PG-05)

page-properties › "NP-PG-05: checkbox, URL and number editors under the title — …". It found that **adding a checkbox property ticked it** (the "open the editor of the property just added" effect calls the checkbox's toggle; twice under StrictMode, and again whenever that property remounted while it was still the last one added). Fixed: a checkbox is shown unticked and nothing is written until it is tapped.
