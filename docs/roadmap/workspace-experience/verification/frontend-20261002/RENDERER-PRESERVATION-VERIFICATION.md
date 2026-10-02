# D08 renderer preservation — 2026-10-02

Source checkpoint: `773cefd`, isolated branch `feat/renderer-preservation`, based on `a2421c6`. This audits D08 / R03.5 / R15.2 against the registered-renderer journeys in FEATURE-LEDGER.md. It is a preservation checkpoint, **not full D08 acceptance**.

## Concrete findings and fixes

- **Plain spreadsheet lost edits:** changing `getContent` on every cell render caused autosave cleanup to flush the previous closure and clear the pending newer save. A stable ref-backed getter now saves the displayed cells. The actual injected-client fixture failed before this fix and passes cell edit, retry, row/column change and reload afterward. No collaborative sheet or shared autosave code changed.
- **Read-only controls remained editable:** Website and Presentation ignored their read-only prop; Dashboard offered layout editing and mutating quick actions. These renderer-local actions now honor the existing prop. The server remains the write authority; hiding controls is not presented as authorization.
- **Save failures were hidden:** Website, Presentation and plain Spreadsheet now expose the existing autosave error and explicit Retry while retaining local content.
- **Injected clients were bypassed:** the widget editor's path suggestions called the global host path command; legacy CalendarWidget omitted an existing optional VaultClient argument. Both now use the injected client, audience/scope query identities and late-response guards. Location hints derive sorted unique directory prefixes, normalize the legacy `vault/` prefix, and distinguish unavailable hints from an empty inventory without disabling typed paths. The fixture asserts no `/api/` calls for the full widget inventory.
- **Project prefix overmatched:** `Projects/Prism2` appeared in `Projects/Prism`. Matching now requires the directory boundary; explicit project metadata matching still works.
- **Map read failures masqueraded as empty:** errors now show an unavailable state and Retry rather than “Nothing on the map yet.” No map engine or proxy contract changed.
- **Narrow containers:** dashboard columns collapse to one while board widgets keep their own horizontal scroll; map/list stack; presentation controls/source and raw unsupported content remain inside the viewport. Presentation, website and sheet controls now have meaningful accessible names where tested.

## Named journeys and their limits

| FEATURE-LEDGER surface | Verified here | Still open or absent in inspected renderer |
| --- | --- | --- |
| Presentation | Actual Registry renderer, slide navigation, add/delete, source editing and injected save/reload, read-only source, failed-save retry, 390 px controls | No presentation-specific fullscreen or export control found in this renderer. Native/export journey remains open. Drag ordering and broad markdown fidelity are not newly accepted by these checks. |
| Project | Related task/document counts and actual linked-record tab navigation; exact folder boundary and explicit project metadata retained | Global property editing was outside ownership. Threads/events remain explicit existing placeholders. Production/native navigation remains open. |
| Dashboard/widgets | All 9 current and 4 legacy widget types render without page errors; actual injected sources, task grouping, embedded note, current-day calendar event; widget edit/save/reload preserves source and unrelated metadata; read-only controls; 390 px layout | Full filter/editor combinations, shared board source semantics, failure handling for every widget and production/native journeys remain open. The board widget was not turned into the task-board engine. |
| Website | Opaque-origin `sandbox="allow-scripts"` preview, attempted parent-document access blocked, source/split/preview navigation, source persistence/reload, failed-save retry, read-only source | No hosted build/publish controls found in this renderer. Publication studio is a separate feature. External embeds, network access and native publishing are not accepted by this fixture. |
| Map | Actual injected notes, tag filter/list navigation, 1440/390 px, explicit unavailable read state, deterministic no-WebGL fallback preserving list | Real GPU marker interaction, native token-free proxy and real provider failure require further runtime checks. No claim of complete map rendering from a fallback test. |
| Bioregion | Actual type-specific property display, read-only body and exact wikilink resolution/opening without writes | Geometry drawing, property mutation, real map/entity interaction and native behavior remain open. Renderer source was not changed. |
| Unknown type | Actual Registry fallback displays exact raw text including markup and long lines; no writes; phone overflow contained | No format conversion or raw editor introduced. Unknown content remains unsupported but readable/copyable. |
| Code | Existing real-Hocuspocus deferred-load, remote edit, local edit, resize/focus, undo/redo, reload and view-only downgrade suite reused; plain code read-only source displayed | Export/rename, language round-trip and production two-client editing are not newly accepted. No Code engine changes. |
| Spreadsheet | Existing real-Hocuspocus failed-import/reload/cell-persistence suite reused; plain cell edits, failed-save retry, row/column additions, literal formula preservation, read-only and reload | Both inspected grids store literal cell text; `=B2+1` is preserved, not evaluated. Plain CSV parser still lacks quoted-field handling. Formula engine, robust import/export, paste ranges and production concurrent editing remain open. |

## Test evidence

- Final Chromium: **26 passed (28.3 s)**.
- Final WebKit: **26 passed (40.7 s)**.
- Suites: new `apps/web/e2e-fixtures/renderer-preservation.spec.ts` plus unchanged `lazy-editors.spec.ts` (4 real collaborative-engine regression journeys).
- Aggregate fixture TypeScript passed: `npm exec -w @prism/web -- tsc --noEmit -p tsconfig.e2e.json`.
- `git diff --check` passed.
- Isolated fixture server port 5192; no production credentials, native builds, real external destinations or backend modifications.
- An intermediate Chromium location-hints case timed out during Playwright scrolling; the focused rerun and both complete final runs passed. No retry setting was enabled for final runs.

## Reviewed fictional visual evidence

- [Read-only presentation at 390 px](renderer-presentation-390-webkit.png)
- [Responsive dashboard at 390 px](renderer-dashboard-390-webkit.png)
- [Unsupported content preserved at 390 px](renderer-unknown-390-chromium.png)

These screenshots are isolated renderer fixtures, not production screenshots or a claim that the specialist engines now match every original design commitment.

The separately outlined [C07 summary/task intent contract](C07-SUMMARY-TASK-INTENT-CONTRACT.md) remains a proposal. No summarize or task-creation action was added in this checkpoint.
