# Message People view: identity parity

Frontend checkpoint `5d6fbfb`, branch `feat/message-recipients`, based on root `373d1fd`. No server edits, graph mutations, recipient routing changes or production verification.

The backend handoff at `a98c9af` requests filtering in VaultMessagesDashboard because the notes API intentionally remains a transparent vault listing. The implementation follows the exact `apps/server/src/identity.ts:207–231` predicates, not the older example at BACKEND-STATUS-GRAPH.md:399.

- Hide tombstone tags `merged-stub` / `superseded`, or status `merged_into_canonical`.
- Hide nonhuman tags `non-human` / `bot` / `organization`, or metadata type `bot` / `organization`.
- Keep humans that merely carry `merged_into`, `mergedInto` or `superseded_by`. These pointers alone are not tombstones. A document-type person stays visible.
- Filter only the view's derived person list. Cached raw notes, underlying graph and conversation totals remain intact.
- Include `email-to` alongside `messages-with` / `email-from` in the existing bidirectional graph index. Recipient-only humans gain their linked email records. Existing per-person deduplication prevents repeated threads when multiple relations connect the same email and person.
- Existing fresh detail authorization and explicit Matrix conversation selection remain unchanged. No sender/name inference, canonical redirect guessing, admin controls or backfill UI was added.

## Verification

`npx playwright test --config apps/web/playwright.inbox-people.config.ts inbox-people.spec.ts --workers=2`: **8 passed**, four cases each in Chromium and WebKit. Covers all tombstone/nonhuman markers, all three bare pointer variants, document-type humans, untouched raw query data, recipient links in both directions, deduplication, opening an email, failed people revalidation, workspace change, denied detail access and phone overflow.

The existing `inbox.spec.ts` ran unchanged: **22 passed** across both engines, including explicit send destinations, unavailable messaging, failed reads, master/detail, phone navigation and capped-list disclosure. Initial new detail assertions also matched the preserved list preview; assertions were corrected to the Selected conversation region and the new suite passed completely.

`npx tsc --noEmit -p apps/web/tsconfig.inbox-people-fixture.json` passed. Port 5193 only, two workers maximum, isolated fixtures without production credentials. Test server stopped.

[Inspected actual People view screenshot](assets/verification/messages-canonical-people.png). Synthetic names deliberately describe classification cases. The screenshot is functional evidence, not a new design board.

The fixture exports `window.prismInboxQuery` for controlled refetch testing, coordinated with the separate triage-visibility slice. No triage-tier logic changed here. Root owns combined regression and production/installed desktop acceptance.
