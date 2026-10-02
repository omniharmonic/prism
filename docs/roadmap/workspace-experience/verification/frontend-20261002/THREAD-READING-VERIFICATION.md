# C09 scoped reading positions — 2026-10-02

Source checkpoint: `c5de6a0`, following C10 `2e91fb2` on `feat/composer-growth`.

## Behavior

The reader persists the first visible event ID and its pixel offset, plus near-bottom state. Reopen/reload restores that exact event when it is loaded. Incoming messages and explicit earlier-page loading preserve the active reading position; delayed content height and composer resizing preserve either the event offset or latest position according to the reader’s prior state. One viewport controller owns correction, with native overflow anchoring disabled to avoid competing adjustments.

When a saved event is absent from the loaded window, the reader says so. A visible notice offers the existing manual Load earlier action and Jump to latest; no history is fetched automatically and no archive completeness is implied. Deliberate scrolling abandons the pending restore. Programmatic corrections are distinguished from user scrolling, and observers disconnect with a late-callback guard.

## Identity and storage boundary

- HTTP action and vault clients both currently return `agentScope()`: API origin, workspace ID, vault ID and authenticated email. The implementation nevertheless includes **both** scopes plus the subscribed actor scope in its persistence audience key.
- Conversation identity separately contains note ID, platform, room ID and saved/live view. Saved legacy derived event IDs never mingle with live source IDs.
- A known audience and vault scope are required; legacy hosts without guaranteed scope retain ephemeral reading behavior. Guest/capability paths with no authenticated scope do not get unscoped persistence.
- Versioned local storage records only conversation identity, event ID, offset, near-bottom flag and timestamp. No message body, sender or title is stored.
- At most 100 positions are retained per audience; entries older than 30 days are ignored and pruned on subsequent writes. Corrupt values and denied reads/writes in this namespace do not break reading.

## Verification

**47 Chromium + 47 WebKit tests passed** across `thread-reading.spec.ts`, `composer-growth.spec.ts`, `live-thread.spec.ts`, `messages.spec.ts` and `email-collaboration.spec.ts`. Aggregate fixture TypeScript and `git diff --check` passed. Processes ran sequentially with no more than two browser workers.

Focused assertions measure event identity **and offset within 2 px**, including 1440/390 px reopen/reload, account/vault/room/saved-live separation, actual MessageRenderer audience composition, missing-event manual pagination, deliberate cancellation, delayed height, composer resize and latest/incoming behavior. Storage tests cover field whitelisting, corruption, namespace-denied storage, age and count bounds. Existing live pagination, failed reads, read-only rendering, draft, email and delayed-content tests remain green.

The C10 follow-up also verifies ordinary typing at the 160 px cap keeps the caret line visible, and editing a middle selection retains its caret and scroll. No speculative composer change was needed.

Reviewed fictional screenshots:

- [Restored desktop position](restored-thread-1440-webkit.png)
- [Restored phone position](restored-thread-390-webkit.png)

## Limits

These are isolated fixture checks, not production/native verification or archive traversal acceptance. Missing source IDs cannot be reconstructed; earlier history remains limited by the current host read contract. Blocking all browser storage at application startup also affects unrelated application initialization; the denied-storage fixture intentionally tests this feature’s namespace, not full app cold-start resilience. No backend, archive, ingestion, agent runtime or outbound messaging behavior changed.
