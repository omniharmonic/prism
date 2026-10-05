# WebKit pass — fixture browser suite

Date: 2026-10-04 · branch `feat/w9-webkit` (from main `de6924e4`) · Playwright 1.61.1, WebKit build 2311 (`Desktop Safari` device, headless, macOS).

## Result

| | files | tests |
|---|---|---|
| Passed | 139 | **1602** |
| Failed | 0 | **0** |
| Skipped | 8 files carry skips | **12** (5 are WebKit-specific, 7 are skipped on Chromium too) |
| Total | 139 | 1614 |

**Update (`feat/w10-fixes`, same day):** the four product bugs this pass left open are fixed (below, 3–6), the `settings-account · desktop` fixme is gone (WebKit-specific skips: 4, all CDP composition), selects are judged on WebKit again, and two specs dropped the "Tab highlights each item" fixture. The table above and the per-file table are the original pass; the files that changed were re-run on both engines (see "Re-runs on `feat/w10-fixes`").

How the numbers were produced: every spec file was run on WebKit as its own command with one worker (the three large accessibility files in `--shard` slices). The totals are the **latest full-file run of each file**, collected over several passes on a shared production host — not one single invocation. Files that were changed after their first run were re-run on WebKit and on Chromium (see "Chromium is unchanged").

Seen once and not reproduced (WebKit): `editor-toolbar.spec.ts › turn into re-shapes the selected block` — `selectText()` on the last paragraph left the editor selection empty in the first pass; it passed in three later runs and in an isolated probe. Cause unknown; treat as a possible intermittent.

## How to run

WebKit is opt-in. The default `npx playwright test` is Chromium only, exactly as before (`--list` gives 1614 tests in 139 files, none `[webkit]`).

```bash
cd apps/web
# one file (the host rule: one file per command, one worker)
E2E_PORT=5362 npx playwright test -c playwright.config.ts --project=webkit e2e-fixtures/<file>.spec.ts --workers=1 --reporter=line
# a large file in slices
E2E_PORT=5362 npx playwright test -c playwright.config.ts --project=webkit e2e-fixtures/notion-a11y-axe.spec.ts --shard=1/4 --workers=1
```

`--project=webkit` (or `E2E_WEBKIT=1`) adds the project; `playwright.config.ts` copies the flag into the environment so worker processes load the same project list. Install the browser once with `npx playwright install webkit`. There are no phone-sized projects in the config; phone specs set their own viewport / `hasTouch` / `isMobile`, and ran that way on WebKit.

Runner note: a 900 s `perl alarm` does not stop the Playwright node process, and killing the runner can leave its Vite dev server on the port (every later run then fails at once with "already used"). Use a watchdog that TERMs the runner and kill the leftover `vite --port <E2E_PORT>` before the next file.

## Product bugs fixed

1. **Deleting a comment: the "Delete?" confirmation never cancelled in Safari, and (once focused) could not be confirmed.**
   `packages/core/src/components/renderers/CommentsSidebar.tsx:341-351` (`DeleteButton`).
   Safari does not focus a button when it is clicked, and React reuses the same `<button>` for the icon and the confirmation, so `autoFocus` never ran: the confirmation had no focus to lose and "moving away cancels" (`onBlur`) never fired. Fix: focus the button when it enters the confirm state, and keep the confirming press from moving focus (`onMouseDown` preventDefault) — otherwise Safari blurs the button on mousedown and cancels before the click.
   Found by `parity3-mentions.spec.ts › NP-CO-01: you can delete your own comment, and only your own`.

2. **Calendar view: dropping a dragged item could open that page.**
   `packages/core/src/components/database/views.tsx:585-597, 654, 676` (`CalChip`, `noteCalendarDrop`, `isDragRelease`).
   dnd-kit swallows the click that follows the releasing mouseup for only 50 ms; WebKit can deliver it later, so the item's `onClick` opened the row peek, whose overlay then blocked the calendar. Intermittent (2 of 3 runs). Fix: a click at the release point within 400 ms of a drag end/cancel is that click and is ignored; any other click opens the page as before.
   Found by `databases.spec.ts › calendar drag reschedule and multi-day span` (5/5 repeats green after the fix).

3. **Command palette: a press on a row was lost when rows moved between mouse down and up** (all engines).
   `packages/core/src/components/layout/CommandBar.tsx` (`pressRow`, `clickRow`, the `pointerup` listener; `CmdRow` carries `data-command-item`).
   Page results landing above a command — or the filter bar appearing above the list — move the row; the button then comes up over another element and the browser makes no click. A mouse press is now remembered by ITEM id at `pointerdown` and runs at `pointerup` when the button comes up on its row, or anywhere in the dialog once the row has moved since the press. A drag off an unmoved row cancels; the row the pointer ends on is never opened. Touch, assistive tech and scripts keep the plain click; keyboard and the held-results rule are unchanged.
   Spec: `notion-search.spec.ts › ⌘K: a press on a command runs it when page results land between mouse down and up` (the search answer is held until the button is down; failed first on Chromium) and `› ⌘K: dragging from one row to another, or out of the list, opens nothing`. The press-again loop in `transfer-helpers.ts` `runCommand` is removed. (The same loss showed on WebKit in `notion-search › match highlighting`: the status row appearing pushed the "recent search" row 45 px down mid-press.)

4. **Safari's default Tab skips buttons: the link card and the table cell editor depended on it.**
   `packages/core/src/lib/a11y/tabWalk.ts` (`walkTab`), used by `components/renderers/LinkCard.tsx` (the card's `onKeyDown`) and `components/database/views.tsx` (`onGridKey`).
   The two widgets now move focus to their own next / previous stop on Tab / Shift+Tab (document order, the order native Tab uses) and leave the key to the browser at their first / last stop — nothing handles Tab globally. In a table, focusing the next cell blurs the cell editor, which commits it (as before).
   Specs: `editor-links.spec.ts › keyboard: the caret in a link shows the card; ⌘K moves into it, Tab walks on…` and `databases.spec.ts › column reorder and cell keyboard nav` now run on WebKit with the plain Playwright `test` (both failed first on WebKit without the fixture); each also walks back with Shift+Tab.

5. **Settings: the section column scrolled sideways by its own scrollbar width** (WebKit, 720×450 with the text-spacing override).
   `packages/core/src/components/layout/settings-workspace.css` (`.prism-settings__body`, `.prism-settings__navigation`).
   Measured in the app: WebKit did not re-lay the column's items when its `overflow: auto` scrollbar appeared — not as flex items, and not a block child either (a wrapper was tried: 194 px list in a 184 px client width). The column now always keeps room for its vertical scrollbar (`overflow-y: scroll`; the track is transparent) and is 10 px wider (205 px) to pay for it, so nothing depends on whether the scrollbar is there. Chromium: buttons the width they were (170 px). Playwright's WebKit reserves no room for that scrollbar, so the buttons are 180 px there.
   Test: `notion-a11y-reflow.spec.ts › settings-account · desktop` runs on WebKit again (the `test.fixme` is removed).

6. **Native `<select>` controls were 20–23 px tall in desktop Safari whatever CSS height they had** (22 controls).
   `packages/core/src/styles/workspace.css` — one rule for every `select:not([multiple]):not([size])`: `appearance: none`, an own chevron, room for it; `:disabled`, the existing focus ring, `forced-colors` (back to the system control). The surfaces' own heights / borders / backgrounds now apply in every engine. They are still native selects. The canvas drawer's separate chevron icon and the context panel's duplicate chevron rule were removed.
   Test: `notion-a11y-touch.spec.ts` judges `select` on WebKit again (the `webkit-native-select` exemption is removed; 12 surfaces failed first, 69 / 69 pass).

## Product bugs found, not fixed

None open from this pass.

Still true by platform design: with Safari's defaults Tab stops only at text fields and lists. The link card and database tables no longer depend on that (fix 4); every OTHER journey through buttons and links (menus, dialogs, toolbars, the sidebar) needs Option+Tab or Safari → Settings → Advanced → "Press Tab to highlight each item on a webpage", as on any website.

## Tests skipped on WebKit

WebKit-specific (4 since `feat/w10-fixes`; 5 in the original pass, which also had `notion-a11y-reflow › settings-account · desktop` as `test.fixme`), plus one pre-existing skip listed for completeness:

| Test | Reason |
|---|---|
| `notion-a11y-ime.spec.ts` › slash, @ and [[ menus stay closed mid-composition… | composition is synthesised with CDP `Input.imeSetComposition` (Chromium only) |
| `notion-a11y-ime.spec.ts` › a "/" or "[[" committed by a composition opens its menu | same |
| `notion-a11y-ime.spec.ts` › Markdown input rules do not fire mid-composition | same |
| `notion-a11y-ime.spec.ts` › autosave and a remote update do not interrupt a composition | same |
| `human-command-native.spec.ts` (1 test) | pre-existing: needs `PRISM_TEST_NATIVE=1` (skipped on Chromium too) |

The two IME tests that do not need CDP (the committing Enter, both browser shapes) run and pass on WebKit. There are no CPU-throttling / CDP performance tests in `e2e-fixtures`.

Partial, inside a running test:
- `notion-mentions.spec.ts › @ menu offers people, pages, dates` — the last step (menu stays closed mid-composition) needs CDP and runs on Chromium only; everything before it runs on WebKit.
- `wikilinks.spec.ts › autocomplete supports keyboard selection…` — its clipboard round-trip branch was already Chromium-only before this pass.

Skipped on both engines as well (pre-existing `test.fixme`, 6): `parity3-collab` (2), `parity3-databases` (1), `parity3-editor` (1), `parity3-publication` (1), `parity3-suggestions` (1).

## Harness changes

All cross-browser helpers are in `apps/web/e2e-fixtures/browser-compat.ts`:

- `grantClipboard(context, browserName)` — Chromium: the real `clipboard-read`/`clipboard-write` permissions. WebKit has no such permissions and refuses `readText()` outside a user gesture, so the async clipboard API is replaced by an in-memory one with the same surface (installed for later navigations and for pages already open). The product still calls the real API names with the real arguments; assertions read what it passed. Used by `editor-blocks`, `notion-a11y-live` (2), `notion-editor`, `notion-page-agent`, `pages-nav`.
- `touchDrag(page, …)` / `touchRelease(locator)` — WebKit has no `Touch` constructor and its `TouchEvent` accepts only a `TouchList`; the helper builds points with `document.createTouch` / `createTouchList` there and `new Touch` on Chromium. Used by `notion-swipe`, `notion-pull`, `notion-mobile` (same coordinates, step counts and cancelable flags as before).
- `chromiumOnly(browserName, reason)` — the CDP skips above.
- `test` (extended fixture) — on WebKit, `page.keyboard.press("Tab" | "Shift+Tab")` is sent with Option held and a capture listener makes the event read as a plain Tab to page scripts: Safari with "Press Tab to highlight each item" on. Used by `notion-a11y-keyboard` only (`editor-links` and `databases` dropped it on `feat/w10-fixes`: the link card and the table walk Tab themselves). `notion-a11y-keyboard` keeps it for controls OUTSIDE those two widgets, which follow the browser's Tab rule — the stops its tests Tab to: the sidebar's "New page" and "Settings" buttons and its tree rows, the control after the editor and after the tree, the page ⋯ and Share triggers, the Share dialog's buttons and its tab strip, the live editor's "Comment" button, a table's first row title (from outside the table), the database toolbar's "New" button and the control after the table, the inbox row and its Archive button, the Settings dialog's section buttons and the "Reduce motion" switch, and every menu / dialog opener of the "Esc closes and focus returns" tests.
- `lineEndKey(browserName)` — `End` moves the caret on Chromium; macOS WebKit follows the platform (⌘→). Used once in `editor-links`.

Spec adjustments that are not helpers (assertions unchanged in meaning):
- `notion-page-cover.spec.ts` — "edge to edge" is measured against the page scroller's client width (desktop WebKit at 390 px draws a classic 10 px scrollbar beside the content; Chromium and phones overlay it). Still requires ≥ 380 px of room and the cover within 2 px of it; on Chromium this is the same 388 px bound.
- `notion-templates.spec.ts` — the full-screen gallery height is rounded before comparing with 844 (WebKit lays out in 1/64 px: 843.984).
- `notion-page-agent.spec.ts › block menu and command bar run the same actions` — blurs the editor before ⌘K. Safari does not move focus to a clicked button, so after "Discard" the editor still held the selection the block action made, and ⌘K with a text selection is "add link" (the documented contextual key).
- ~~`transfer-helpers.ts` `runCommand` pressed again until the command had run~~ — removed on `feat/w10-fixes` (fix 3).
- ~~`notion-a11y-touch.spec.ts` did not judge selects on WebKit; `notion-a11y-reflow.spec.ts` had one WebKit fixme~~ — both removed on `feat/w10-fixes` (fixes 6 and 5).

## Chromium is unchanged

- `npx playwright test --list` on this branch and on main: `Total: 1614 tests in 139 files`, all `[chromium]`.
- Every spec this pass edited, and the specs covering the two product fixes, were re-run on Chromium after the last change, all green: `parity3-mentions` 9, `notion-comments` 3, `suggest-only` 9, `editor-blocks` 20, `editor-links` 15, `databases` 27, `notion-db-views` 9, `parity2-databases` 3, `parity3-databases` 6 (+1 fixme), `notion-a11y-keyboard` 22, `notion-a11y-live` 4, `notion-editor` 27, `notion-page-agent` 22, `pages-nav` 22, `notion-swipe` 4, `notion-pull` 5, `notion-mobile` 6, `notion-a11y-ime` 6, `notion-mentions` 9, `notion-page-cover` 2, `notion-templates` 20, `notion-import` 5, `notion-export` 4, `notion-a11y-touch` 69, `notion-a11y-reflow` (settings surfaces) 5.
- Root `npm run typecheck` and `npm run typecheck:e2e -w @prism/web`: clean.
- The rest of the Chromium suite was not re-run in this pass (no file it loads was changed apart from the two product components above).

## Re-runs on `feat/w10-fixes`

One file per command, one worker, behind the host gate. Each fix's spec was seen failing before the fix on the engine named.

| Fix | Failed first | After — WebKit | After — Chromium |
|---|---|---|---|
| 3 · palette press | `notion-search` (Chromium: 1 failed) | `notion-search` 15, `notion-import` 5, `notion-export` 4, `notion-templates` 20 | `notion-search` 15, `search` 10, `creation-entrypoints` 4, `mobile-navigation` 7, `notion-import` 5, `notion-templates` 20, `notion-export` 4 |
| 4 · Tab in the link card / table | `editor-links`, `databases` (WebKit, no fixture: 1 failed each) | `editor-links` 15, `databases` 27, `notion-a11y-keyboard` 22 | `editor-links` 15, `databases` 27, `notion-a11y-keyboard` 22 |
| 5 · settings column | `notion-a11y-reflow` settings-account (WebKit: 1 failed) | `notion-a11y-reflow` 150 (no skip), `settings-presentation` 3, `workspace-settings` 3 | `notion-a11y-reflow` 150, `settings-presentation` 3, `workspace-settings` 3 |
| 6 · selects | `notion-a11y-touch` (WebKit: 12 failed) | `notion-a11y-touch` 69, `boards` 27, `notion-db-views` 9 | `notion-a11y-touch` 69, `boards` 27, `sharing` 12, `canvas` 14 |
| Markdown to-dos (PARITY-GAPS slice N) | `markdown-todos` (Chromium: 2 failed) | `markdown-todos` 2 | `markdown-todos` 2, `notion-editor` 27 (paste) |

**Review round (same branch).** Palette: "moved" is judged in the list's own coordinates (scrolling is not a move), a pending press is forgotten by Enter / a press elsewhere / a context menu / the window blurring (`notion-search` 18 on each engine). `walkTab`: IME guard, a stop that refuses focus is stepped over (`tab-walk` 2 on each engine; `editor-links` 15, `databases` 27 on each). The intermittent `parity2-mentions › @ menu dates: next Monday` had a product cause — the @ menu listed the people of an OLDER (debounced) query above a just-typed date and Enter took a person — fixed in `MentionMenu.tsx`, with a deterministic spec (`parity2-mentions` 3 on each engine; `notion-mentions` 9, `parity3-mentions` 9 on Chromium). Select chevron: `currentColor`-based, mirrored in RTL (`notion-a11y-touch` 69 on each engine).

Not re-run after these changes: `notion-a11y-axe` (either engine), the rest of the suite, and a second complete WebKit pass. Root `npm run typecheck` and `npm run typecheck:e2e -w @prism/web`: clean.

## Not reached

- Real Safari / iOS Safari on a device (touch keyboard, `visualViewport` with the software keyboard, iOS form controls, Dynamic Type, a real IME, pull-to-refresh rubber-banding). Playwright's WebKit is the desktop engine.
- Service worker / Web Push behaviour (the suite blocks service workers on both engines).
- `apps/web/e2e` (live) and `e2e-native` suites.
- A second complete WebKit pass in one go, to measure flakiness across the whole suite.

## Per file (WebKit)

| File | Passed | Failed | Skipped | Result |
|---|---|---|---|---|
| `agent-composer-growth.spec.ts` | 2 | 0 | 0 | pass |
| `agent-context-visual.spec.ts` | 2 | 0 | 0 | pass |
| `agent-queue.spec.ts` | 6 | 0 | 0 | pass |
| `agent-reply.spec.ts` | 13 | 0 | 0 | pass |
| `agent-snapshots.spec.ts` | 3 | 0 | 0 | pass |
| `agent-states.spec.ts` | 7 | 0 | 0 | pass |
| `agent-summary.spec.ts` | 9 | 0 | 0 | pass |
| `agent-visual.spec.ts` | 5 | 0 | 0 | pass |
| `agent.spec.ts` | 19 | 0 | 0 | pass |
| `boards.spec.ts` | 27 | 0 | 0 | pass |
| `brand.spec.ts` | 1 | 0 | 0 | pass |
| `calendar.spec.ts` | 6 | 0 | 0 | pass |
| `canvas-visual.spec.ts` | 6 | 0 | 0 | pass |
| `canvas.spec.ts` | 14 | 0 | 0 | pass |
| `collab-route.spec.ts` | 4 | 0 | 0 | pass |
| `collab-storage.spec.ts` | 7 | 0 | 0 | pass |
| `collab-too-complex.spec.ts` | 4 | 0 | 0 | pass |
| `companion-density.spec.ts` | 4 | 0 | 0 | pass |
| `composer-growth.spec.ts` | 8 | 0 | 0 | pass |
| `connections-entry-settings.spec.ts` | 1 | 0 | 0 | pass |
| `connections.spec.ts` | 16 | 0 | 0 | pass |
| `context-history.spec.ts` | 14 | 0 | 0 | pass |
| `context-links.spec.ts` | 9 | 0 | 0 | pass |
| `context-properties.spec.ts` | 9 | 0 | 0 | pass |
| `creation-entrypoints.spec.ts` | 4 | 0 | 0 | pass |
| `databases.spec.ts` | 27 | 0 | 0 | pass |
| `document-polish.spec.ts` | 4 | 0 | 0 | pass |
| `document-recovery.spec.ts` | 7 | 0 | 0 | pass |
| `editor-blocks.spec.ts` | 20 | 0 | 0 | pass |
| `editor-links.spec.ts` | 15 | 0 | 0 | pass |
| `editor-regressions.spec.ts` | 3 | 0 | 0 | pass |
| `editor-schema.spec.ts` | 2 | 0 | 0 | pass |
| `editor-slash.spec.ts` | 8 | 0 | 0 | pass |
| `editor-table.spec.ts` | 4 | 0 | 0 | pass |
| `editor-toolbar.spec.ts` | 10 | 0 | 0 | pass |
| `editor-upload.spec.ts` | 6 | 0 | 0 | pass |
| `email-collaboration.spec.ts` | 11 | 0 | 0 | pass |
| `governance-workspace.spec.ts` | 5 | 0 | 0 | pass |
| `graph-saved.spec.ts` | 9 | 0 | 0 | pass |
| `graph.spec.ts` | 9 | 0 | 0 | pass |
| `human-command-helpers.spec.ts` | 14 | 0 | 0 | pass |
| `human-command-native.spec.ts` | 0 | 0 | 1 | pass |
| `inbox-people.spec.ts` | 4 | 0 | 0 | pass |
| `inbox-visibility.spec.ts` | 4 | 0 | 0 | pass |
| `inbox.spec.ts` | 11 | 0 | 0 | pass |
| `index-settings.spec.ts` | 3 | 0 | 0 | pass |
| `isolation.spec.ts` | 1 | 0 | 0 | pass |
| `lazy-editors.spec.ts` | 4 | 0 | 0 | pass |
| `live-thread.spec.ts` | 3 | 0 | 0 | pass |
| `markdown-todos.spec.ts` | 2 | 0 | 0 | pass (new on `feat/w10-fixes`) |
| `messages.spec.ts` | 15 | 0 | 0 | pass |
| `mobile-navigation.spec.ts` | 7 | 0 | 0 | pass |
| `navigation.spec.ts` | 5 | 0 | 0 | pass |
| `notion-a11y-axe.spec.ts` | 299 | 0 | 0 | pass |
| `notion-a11y-ime.spec.ts` | 2 | 0 | 4 | pass |
| `notion-a11y-keyboard.spec.ts` | 22 | 0 | 0 | pass |
| `notion-a11y-live.spec.ts` | 4 | 0 | 0 | pass |
| `notion-a11y-reflow.spec.ts` | 150 | 0 | 0 | pass (`feat/w10-fixes`; 149 + 1 fixme in the original pass) |
| `notion-a11y-touch.spec.ts` | 69 | 0 | 0 | pass |
| `notion-a11y.spec.ts` | 19 | 0 | 0 | pass |
| `notion-collab-offline.spec.ts` | 4 | 0 | 0 | pass |
| `notion-comments.spec.ts` | 3 | 0 | 0 | pass |
| `notion-db-csv.spec.ts` | 6 | 0 | 0 | pass |
| `notion-db-inline.spec.ts` | 3 | 0 | 0 | pass |
| `notion-db-props.spec.ts` | 10 | 0 | 0 | pass |
| `notion-db-views.spec.ts` | 9 | 0 | 0 | pass |
| `notion-editor.spec.ts` | 27 | 0 | 0 | pass |
| `notion-export.spec.ts` | 4 | 0 | 0 | pass |
| `notion-history.spec.ts` | 2 | 0 | 0 | pass |
| `notion-home.spec.ts` | 3 | 0 | 0 | pass |
| `notion-import.spec.ts` | 5 | 0 | 0 | pass |
| `notion-inbox.spec.ts` | 3 | 0 | 0 | pass |
| `notion-live-safety.spec.ts` | 13 | 0 | 0 | pass |
| `notion-live.spec.ts` | 4 | 0 | 0 | pass |
| `notion-media.spec.ts` | 5 | 0 | 0 | pass |
| `notion-mentions.spec.ts` | 9 | 0 | 0 | pass |
| `notion-mobile.spec.ts` | 6 | 0 | 0 | pass |
| `notion-offline-cache.spec.ts` | 2 | 0 | 0 | pass |
| `notion-offline-writes.spec.ts` | 6 | 0 | 0 | pass |
| `notion-offline.spec.ts` | 3 | 0 | 0 | pass |
| `notion-outbox.spec.ts` | 13 | 0 | 0 | pass |
| `notion-page-agent.spec.ts` | 22 | 0 | 0 | pass |
| `notion-page-cover.spec.ts` | 2 | 0 | 0 | pass |
| `notion-page.spec.ts` | 7 | 0 | 0 | pass |
| `notion-presence.spec.ts` | 1 | 0 | 0 | pass |
| `notion-pull.spec.ts` | 5 | 0 | 0 | pass |
| `notion-search.spec.ts` | 15 | 0 | 0 | pass (`feat/w10-fixes`: +2 tests) |
| `notion-sharing.spec.ts` | 5 | 0 | 0 | pass |
| `notion-sidebar.spec.ts` | 6 | 0 | 0 | pass |
| `notion-signout.spec.ts` | 3 | 0 | 0 | pass |
| `notion-suggest-routing.spec.ts` | 3 | 0 | 0 | pass |
| `notion-swipe.spec.ts` | 4 | 0 | 0 | pass |
| `notion-sync-state.spec.ts` | 4 | 0 | 0 | pass |
| `notion-templates.spec.ts` | 20 | 0 | 0 | pass |
| `open-documents.spec.ts` | 7 | 0 | 0 | pass |
| `outbox.spec.ts` | 16 | 0 | 0 | pass |
| `page-creation.spec.ts` | 13 | 0 | 0 | pass |
| `page-properties.spec.ts` | 9 | 0 | 0 | pass |
| `pages-nav.spec.ts` | 22 | 0 | 0 | pass |
| `parity2-databases.spec.ts` | 3 | 0 | 0 | pass |
| `parity2-mentions.spec.ts` | 1 | 0 | 0 | pass |
| `parity2-pages.spec.ts` | 11 | 0 | 0 | pass |
| `parity2-shell.spec.ts` | 4 | 0 | 0 | pass |
| `parity3-collab.spec.ts` | 5 | 0 | 2 | pass |
| `parity3-databases.spec.ts` | 6 | 0 | 1 | pass |
| `parity3-editor.spec.ts` | 7 | 0 | 1 | pass |
| `parity3-history.spec.ts` | 5 | 0 | 0 | pass |
| `parity3-links.spec.ts` | 4 | 0 | 0 | pass |
| `parity3-mentions.spec.ts` | 9 | 0 | 0 | pass |
| `parity3-publication.spec.ts` | 2 | 0 | 1 | pass |
| `parity3-shell.spec.ts` | 7 | 0 | 0 | pass |
| `parity3-suggestions.spec.ts` | 3 | 0 | 1 | pass |
| `parity3-vaults.spec.ts` | 2 | 0 | 0 | pass |
| `people-profile.spec.ts` | 9 | 0 | 0 | pass |
| `people.spec.ts` | 5 | 0 | 0 | pass |
| `presentation.spec.ts` | 5 | 0 | 0 | pass |
| `publication-navigation.spec.ts` | 12 | 0 | 0 | pass |
| `publication-settings.spec.ts` | 7 | 0 | 0 | pass |
| `publication-typography.spec.ts` | 15 | 0 | 0 | pass |
| `publication.spec.ts` | 11 | 0 | 0 | pass |
| `publishing-studio.spec.ts` | 8 | 0 | 0 | pass |
| `renderer-preservation.spec.ts` | 22 | 0 | 0 | pass |
| `responsive-companion.spec.ts` | 2 | 0 | 0 | pass |
| `saved-note-handoff.spec.ts` | 13 | 0 | 0 | pass |
| `search.spec.ts` | 10 | 0 | 0 | pass |
| `selection-agent.spec.ts` | 9 | 0 | 0 | pass |
| `settings-presentation.spec.ts` | 3 | 0 | 0 | pass |
| `sharing.spec.ts` | 12 | 0 | 0 | pass |
| `shortcuts.spec.ts` | 9 | 0 | 0 | pass |
| `suggest-only.spec.ts` | 9 | 0 | 0 | pass |
| `suggestion-review.spec.ts` | 5 | 0 | 0 | pass |
| `suggestions.spec.ts` | 5 | 0 | 0 | pass |
| `thread-reading.spec.ts` | 11 | 0 | 0 | pass |
| `transcript-review.spec.ts` | 29 | 0 | 0 | pass |
| `wikilinks.spec.ts` | 3 | 0 | 0 | pass |
| `workspace-access.spec.ts` | 7 | 0 | 0 | pass |
| `workspace-session.spec.ts` | 10 | 0 | 0 | pass |
| `workspace-settings.spec.ts` | 3 | 0 | 0 | pass |
| `workspace-setup.spec.ts` | 6 | 0 | 0 | pass |
| `workspace.spec.ts` | 16 | 0 | 0 | pass |
