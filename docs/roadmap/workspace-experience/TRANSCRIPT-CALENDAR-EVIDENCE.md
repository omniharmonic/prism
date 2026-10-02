# D02 — Calendar conversation records

Frontend implementation on `feat/transcript-calendar`, based on `64bd9cd`. This slice addresses transcript review and calendar presentation; canonical people links, linked decisions/tasks, and contextual agent actions remain broader D02 work. This is a frontend integration candidate, not a production/server acceptance claim.

## Requirement and reference

`FRONTEND-ACCEPTANCE.md` D02 and the original calendar/transcript linking plan require exact meeting-note navigation, confirmed transcript relationships, explicit review of uncertain matches, safe correction, and readable mobile details. Board `assets/22-calendar-transcripts.png` guides the calendar/detail hierarchy, conversation-record grouping, search, and retry presentation. Its illustrative audio playback, person photos, inline notes/tasks, and extra controls are not implemented as pretend capabilities.

## Implemented

- Actual `CalendarDashboard` retains month/week/day, all-day and overlapping event behavior, meeting-note navigation, RSVP/edit/delete/notification/series flows. Detail typography and controls are clearer, with a roomier desktop panel and full-width mobile sheet. Safari event openers explicitly receive focus so Escape restores the correct button. Nested dialog cancellation stops propagation. New-event default date uses the local calendar day.
- `EventTranscripts` uses the injected transcript review client only when available. Capability/legacy contexts retain stored-link navigation with no fallback write API. Path aliases cannot start review requests; only canonical meeting IDs are accepted. Server-provided match evidence remains distinct from confirmed links. Missing timestamps do not invent a time; date-only legacy values keep their local day.
- `TranscriptReviewPanel` supports search, link, deliberate move from another meeting, unlink without deleting the source, reasons bounded to 500 characters, access-aware actions, partial/pending outcomes, and explicit recovery. Scope changes hide drafts and prevent late responses from changing another audience.
- The web transport preserves the existing signed-in credentials, workspace/vault/write-actor headers, and error code/message. Its only shared transport extension retains bounded `retryAfter` metadata from body or `Retry-After` (seconds or HTTP date).
- A versioned bounded receipt stores the exact serialized decision before sending. Keys include server, workspace, vault, authenticated actor, and meeting ID. Web Locks serialize reservation and clearing across windows. Existing unresolved or unreadable records are never silently replaced. Reload restores the request and reason but never sends automatically; retry reuses the same body and request ID.
- Pending/network/503/rate-limit outcomes retain the receipt. Confirmed applied, stale, superseded, request reuse, and invalid terminal outcomes clear it according to the contract. Changed access/vault/actor keeps the unresolved receipt and requires fresh review. Revoked meeting management disables retry.
- Storage denial keeps an in-memory receipt with a keep-window-open/copy warning. Copyable details contain no credentials. Unsupported Web Locks blocks starting a new decision while preserving read/open/review and existing-request replay. Browser eviction or logout cleanup is not promised to preserve recovery.

## Verification

Focused fixture journeys exercise the real React components and production HTTP transport against an isolated deterministic HTTP fixture, with no live credentials or production mutations. They cover link/unlink, mobile search/move confirmation, duplicate request identity, exact resend after reload, a lost applied response, scope switch, read-only/revoked access, all documented error classes, GET and POST rate limits, stale/superseded recovery, canceled stale draft recovery, denied/corrupt storage, two-window reservation, absent Web Locks, canonical IDs/provider absence, local dates, and actual calendar-to-note navigation. Existing calendar regression journeys cover exact stored references, revocation, phone sheet dismissal/focus, all-day edits, overnight/multi-day intervals, and overlap layout.

Final stable runs: **35 Chromium + 35 WebKit passed** (29 transcript/recovery journeys and 6 existing calendar regressions per engine). Core, web, and scoped fixture TypeScript checks passed; `git diff --check` passed. Actual screenshots below were captured from the final WebKit run and visually inspected. Local commands: `playwright test -c apps/server/data/workspace-experience/checks/calendar-regression-{chromium,webkit}.config.mts`; `npm run typecheck --workspace=@prism/core`; `npm run typecheck --workspace=@prism/web`; and `tsc --noEmit -p apps/server/data/workspace-experience/checks/transcript-review-types.json`. The committed specs also run through the default `apps/web/playwright.config.ts` by selecting `transcript-review.spec.ts calendar.spec.ts` (Chromium, default port 5188). The isolated runner uses port 5193, fixture mode, `PRISM_SERVER=http://127.0.0.1:1`, blocked service workers, and America/Denver. No server merge, deployment, native build, or production write was performed in this branch.

Screenshots are actual fixture renders, not generated mockups:

- `assets/evidence/transcript-calendar/calendar-records-desktop.png`
- `assets/evidence/transcript-calendar/calendar-records-phone-dark.png`
- `assets/evidence/transcript-calendar/transcript-review-phone.png`

## Remaining release gates

1. **Do not deploy this enabled frontend provider against the old production server:** the new read endpoint must be live, otherwise it would replace working stored-link navigation with404. Do not treat404 as unsupported because it also represents access loss. Integrate the approved server transcript slice (`feat/backend-transcripts`, reviewed contract at `ea412e0`) through the root agent's combined backend branch. The frontend does not provide matching or authorization itself.
2. Exercise real authenticated GET/POST with an isolated owner-only meeting/transcript pair: link, unlink, competing revision, pending retry, and loss of access. Confirm persistence/restart behavior against the actual backend journal, not this fixture model.
3. Verify the installed native WKWebView exposes `navigator.locks`, review/open/link flows work, and a pending request survives an app restart without an automatic write. Playwright WebKit passing is not installed desktop evidence.
4. Confirm real read-only/capability views disclose no hidden meeting identities and preserve stored-link navigation, and check phone/desktop layout inside the integrated shell.

D02 frontend fixture acceptance must not be described as completion of the entire original roadmap or production parity.
