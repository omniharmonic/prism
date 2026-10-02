# B05 independent client helpers — checkpoint 1

2026-10-02. Frontend preparation only. No live editor command activation, server merge/restart, enforcement change, or removal of the trusted-collaborator warning.

Source checkpoint: `cb8dc6d`.

Dependency: root `327572e`, importing the exact backend-owned `0839820` command module and package export. This work does not change that contract.

## Included

- `lib/collab/human/validation.ts`: strict payload recovery validation; well-formed Unicode and text limits; one fully markable textblock per suggestion; refusal of inline code, breaks, embedded nodes, review overlap and overlong formatted ranges. Captures ProseMirror positions, exact quote, body and comments before asynchronous hashing. Inserts use explicit before/after-selected-passage or a seeded empty textblock, never an inferred read-only caret.
- `lib/collab/human/receipt.ts`: one durable immutable serialized request per document/audience. Web Locks coordinate reservation and comparison before clearing. Reload preserves exact request bytes; another window cannot replace an unresolved request. Corrupt/denied storage or missing locks block new command submission while retaining available recovery text. Records are not silently expired/evicted. Clearing another window's completed record does not resurrect a stale memory copy.
- `apps/web/src/collab/humanCommands.ts`: no production identity resolver or caller. Null authoritative identity refuses before network access. Injected confirmed fixture audiences demonstrate canonical-ID endpoint use, explicit workspace/vault headers and capability query retention alongside normal cookie/native bearer authentication. Response validation requires matching request/kind/thread and result IDs. Unknown network/save/malformed-response outcomes remain unknown; rate-limit metadata and human-readable messages remain available to the future controller. The transport never applies a Yjs edit or retries automatically.

The audience interface is internal client state, **not an invented `/commands/me` response schema**. Production activation depends on the backend's acknowledged identity/audience contract.

## Evidence

- Fourteen helper journeys passed in Chromium and WebKit (28 cases), using the actual read-only CollabEditor for capture/validation and isolated HTTP fixtures for transport.
- Native-mode Vite fixture passed in Chromium and WebKit: device bearer plus capability query and omitted cookies (2 cases). No native build/install; this does not prove installed WKWebView behavior.
- Core, web and focused fixture TypeScript checks passed; diff whitespace check passed.
- Tests cover immutable capture across selection/comment changes, empty insertion, invalid rich ranges/text/author fields, exact-byte dropped-response → reload → resend, concurrent tabs, corrupt/denied recovery, missing locks, audience changes and malformed confirmation IDs.
- WebKit intercepted fixture requests do not expose a final Cookie header. Cookie evidence there checks the cookie jar and `credentials: include`; the real cookie-authenticated server journey remains required. Chromium additionally exposed the cookie header.

Reproduce with the committed fixture-only configuration (port 5193, backend destination disabled):

```sh
npx playwright test --config apps/web/playwright.human-helpers.config.ts --workers=2
PRISM_TEST_NATIVE=1 npx playwright test --config apps/web/playwright.human-helpers.config.ts --workers=2
```

## Remaining integration gates

Composer/controller and comment callbacks, authoritative actor/audience resolution, fresh scope at each authentication, safe grant downgrade/upgrade, cache retirement/recovery, actual Hocuspocus command round trips, backend orphan-recovery acknowledgement, independent combined-backend review, and installed desktop/PWA acceptance remain unimplemented or unverified in this checkpoint. Existing raw editing/comment behavior is untouched.

Installed Hocuspocus starts synchronization from `onOpen` after sending the token, before its authenticated event. A retired raw cache therefore needs a **pre-sync reconnect guard**; checking generation only after authentication is insufficient. Also, the existing local persistence helper merges every write with the prior stored Yjs record, so a fresh document using that same key can resurrect old edits. No cache lifecycle wiring has been changed here. The approved next checkpoint must prove retirement across reload and a second stale window while preserving original bytes for fresh-access-guarded recovery and normal authorized online editing when storage is unavailable.

The current POST contract has no expected-actor precondition. An authoritative identity preflight and client scope checks cannot make a later credential change atomic with the server mutation. This remains a backend coordination question before activation; these helpers do not claim to solve it.
