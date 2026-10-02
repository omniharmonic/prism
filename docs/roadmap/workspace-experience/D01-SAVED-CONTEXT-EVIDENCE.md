# D01 saved-note context from search

Implementation: `2bcfc2a` on `feat/search-context`, based on root `c074cf4`. Frontend-only; no backend changes, production tests or deployment are claimed.

## Requirement and presentation

Original D01 search-to-context action appears in approved board 11 (`assets/11-search-command-palette.png`). Existing search already provided ranked/keyword labels, filters, readable passages and Open. This slice implements Add to context in SearchPanel and CommandBar using existing agent and vault clients.

The command palette keeps its keyboard listbox behavior and places the selected note's action in a separate toolbar. This intentionally differs from the generated board's action nested in a result: interactive controls remain outside the listbox options. SearchPanel uses independent sibling buttons. Actions are at least 44px high and remain usable on a phone.

## Behavior and boundaries

- One pending saved-note handoff per window. A second request cannot overwrite it; its action explains that pending context must be finished or dismissed.
- Preserve session, working note, message draft and agent permission mode. With no conversation or draft, create an empty unsent draft, not a server session.
- Bind handoff to authenticated scope, target session and exact window-local draft object. Switching destinations, including a second draft on the same note, requires explicit confirmation. Scope change clears it.
- The composer rechecks note access through the existing VaultClient, then synchronously checks destination, send state, latest attachment value, duplicate and server limits before appending and acknowledging. Another mounted view's attachment is preserved.
- Wait while sending/creating or while a queue receipt exists. Read-only ordinary request-receipt inspection also blocks attachment after an uncertain send or reload; malformed receipts and unavailable reads remain blocked. No receipts are cleared or replaced by this feature. Normal successful sends already clear their receipts.
- Successful in-memory attachment retains the existing local-storage failure warning. An unresolved pending handoff itself is window-local and is not claimed to survive reload.
- Saved-note references coexist with selected-passage snapshots. No automatic turn is sent; existing context picker and receipt/send behavior remain unchanged. No agent provider means no context action.

## Verification

`npx playwright test --config apps/web/playwright.saved-context.config.ts saved-note-handoff.spec.ts --workers=2`: **26 passed**, 13 scenarios each in Chromium and WebKit. Covers desktop/phone keyboard flow, current session and mode, empty draft, access failure/retry, limits, duplicates, latest-value append during access lookup, changed scope/destination, same-note new draft, storage failure, in-flight success, uncertain ordinary receipt/reload, malformed/read-denied receipts, exact queue bytes, concurrent selected passage and unavailable provider.

Existing `search.spec.ts`, `selection-agent.spec.ts` and `agent-queue.spec.ts`: **44 passed**, across both engines. The selected-passage suite includes its existing real isolated Hocuspocus journey. The D01 addition itself uses deterministic client fixtures, not production access.

Core and web TypeScript checks passed sequentially. The focused fixture/import check also passed:

`npx tsc --noEmit -p apps/web/tsconfig.saved-context-fixture.json`

The first combined run had two failures in the new concurrent-snapshot fixture because its synthetic snapshot omitted required fields; the fixture was corrected and the complete new suite passed. No existing regression failed. All browser runs used at most two workers, isolated port 5193 and no production credentials. Test server stopped after verification.

## Inspected screenshots

- [Desktop search action](assets/verification/d01-context-search-desktop.png)
- [Phone search action](assets/verification/d01-context-search-mobile.png)
- [Existing conversation with its draft and attachment](assets/verification/d01-context-attached-desktop.png)
- [Phone unsent draft with attachment](assets/verification/d01-context-attached-mobile.png)

These capture real components in the isolated fixture. Fixture controls and simplified background layout are not proposed product UI. Root still owns aggregate integration, production web and installed desktop acceptance.
