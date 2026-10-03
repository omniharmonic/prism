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
