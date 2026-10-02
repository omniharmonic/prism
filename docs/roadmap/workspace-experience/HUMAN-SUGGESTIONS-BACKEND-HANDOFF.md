# Human suggestion enforcement: isolated WIP handoff

**2026-10-02: paused when the user redirected priority to frontend aesthetics. Not release-ready; do not merge or deploy this branch.**

Worktree: `.worktrees/human-suggestions`; branch `feat/human-suggestions`; base `dc615f9`. Dependencies were copied with APFS copy-on-write from the redesign worktree. No production environment, database, credentials, or app artifacts were copied. No production mutations, deployment, native build, browser test server or external sends occurred.

## Agreed contract

The current shipped human “Can suggest” mode tracks edits in the client, but its raw collaborative connection can write arbitrary document updates. This is separate from the already enforced hosted-agent session modes.

The proposed replacement requires edit access for raw Yjs updates. Suggest-level people and capability-link guests keep live reading/presence and an explicit selected-passage composer: insert at a text position, delete a selected passage, or replace selected text. Normal direct editors and their existing tracking/review controls remain unchanged. Anchored comments/replies/resolution must also use authorized commands, preserving existing suggest-user collaboration. Non-prose files need an honest view-only explanation, since they have no existing suggestion semantics.

The parent approved an initial conservative concurrency rule: capture a precise ProseMirror range and quote plus a SHA-256 revision of canonical live prose/comment state. Any intervening state change returns 409, retains the draft and requires explicit reselection/review. This is not seamless concurrent merging and must not be described that way.

The server, not submitted user fields, derives author identity. Commands carry bounded plain text, never arbitrary marks, transforms or raw Yjs updates. Credentials, vault, fresh note visibility/grants and access revision must be rechecked immediately before synchronous mutation. Retries use the same request ID; no optimistic raw mutation precedes confirmation.

## Written, but incomplete

- `packages/core/src/lib/collab/commands.ts`: command/result types, stable JSON and browser SHA-256 helper; new package subpath export.
- `apps/server/src/human-collab.ts`: proposed pure command application, bounded positions/text, quote/revision/overlap checks, attributed suggestion marks, anchored comment operations, and same-transaction request receipts in a separate Y.Doc root. Current limit is 5,000 retained requests per document; requests expire after 24 hours and receipts are retained for two days. These limits and wording require review.
- `apps/server/src/routes/human-collab.ts`: strict command schema, body/rate bounds, actor/capability access checks, live-document opening, fresh authorization, and error responses. Mounted under `/api/collab/:id/commands` before the owner proxy.
- `apps/server/src/collab.ts`: connection admission and revalidation changed to raw read-only below edit. `collab-ops.ts` exports its existing fragment-transform helper.
- `HumanSuggestionComposer.tsx`: draft/command persistence, selection capture, insert/delete/replace explanations, conflict reselection and same-request retry UI. `CollabEditor.tsx` accepts this optional composer.
- `apps/web/src/collab/humanCommands.ts`: audience-pinned request transport. `CollabDoc.tsx` starts wiring the composer, non-prose explanation and comment callbacks; `collab/access.ts` makes suggest bodies read-only.

## Exact validation state

- `npm run typecheck -w @prism/server`: **passes** on the paused WIP.
- `npm run typecheck -w @prism/web`: **fails**, because `CollabDoc.tsx` passes new command-related props to `CommentsSidebar` that are not implemented yet. This is known unfinished integration, not a production failure.
- No new behavioral, raw-socket, browser or persistence acceptance tests have run. Existing suggest-access tests still expect a writable socket and must be intentionally updated only alongside meaningful replacement coverage.

## Required before any integration

1. Implement sidebar comment/reply/resolve/delete command callbacks with retained drafts, disabled duplicate submissions, errors and scope guards. Ensure suggest-only users have no remaining raw-write affordances, including comment bubbles, history, formatting, non-prose tools or programmatic commands. Review legacy hosts: they currently cannot use the new structured composer.
2. Audit body/comment canonicalization against actual client/server schemas; test caret insertion, duplicate text, marks, multiline text, overlapping suggestions and full deletion. Confirm read-only selection can express the intended caret/range.
3. Verify request receipts through actual document store/unload/reload, server restart, external vault reconciliation/reseed, lost acknowledgements and already-reviewed suggestions. **A reseed may discard the extra receipt root**; a durable server receipt design may therefore be required. Do not claim idempotency from the current in-memory implementation.
4. Review outstanding races and failure behavior: revoked capability/session/device after awaits, vault mismatch, unknown vault, external privacy changes, deleted/changed note, pending HTTP response after audience switch, quota failure, rejected capture promise and storage recovery. Review schema/rate limits and old clients explicitly.
5. Add real Hocuspocus tests rejecting raw suggest-client inserts, deletes, pending structs and hidden-root writes, while edit clients still work. Test signed-in and capability commands, authorization denial, concurrent edits/409 without data loss, comments/replies and reconnect. Add a real browser journey through the shared CollabDoc/editor and command endpoint on isolated port 5193/test database.
6. Update stale server/access comments and the shipped trusted-collaborator warning only after enforcement and replacement UI are proven. Preserve legacy suggestion marks, reviewer/governance rules and existing agent policies.

This checkpoint preserves a design and partial implementation for the next backend agent. It does not solve the shipped permission gap yet and must not be cherry-picked into the visual redesign as-is.
