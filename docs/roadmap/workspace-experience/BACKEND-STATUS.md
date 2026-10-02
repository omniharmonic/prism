# Backend status — human suggest-only enforcement

Updated 2026-10-02. Branch `feat/backend-followup`, worktree `.worktrees/backend-followup`. **Not merged, not deployed, no server restarted.** Everything below was verified against fixtures only (in-memory SQLite, fake vault, a real in-process Hocuspocus server with real WebSocket provider clients). Nothing here was run in a browser, against production, or with the real editor.

This closes the server half of `BACKEND-HANDOFF.md` §1. The client half is not done and is frontend-owned; the exact contract and hunks are in "Client contract requested for suggest-only enforcement" below.

## What changed on the server

| Area | Change |
|---|---|
| `/collab` socket | Raw Yjs updates require **edit**. A suggest-level connection (signed-in user, capability guest, or federated peer) is read-only: Hocuspocus refuses its `Update` and `SyncStep2` messages wholesale. It still receives every update and may publish presence. |
| Kill switch | `COLLAB_SUGGEST_ENFORCED` (default on). `false` restores the old writable suggest socket. Read through `config.collabSuggestEnforced`; restart required. |
| New endpoint | `POST /api/collab/:id/commands` — bounded commands `suggest`, `comment`, `reply`, `resolve`, `delete-comment`. Mounted before the gateway's owner/admin passthrough. Works with the switch on or off. |
| New table | `collab_command_receipts` (SQLite) — durable idempotency receipts. Created with `CREATE TABLE IF NOT EXISTS`; no existing table is altered. |
| Shared projection | `collabLevelFor()` in `collab.ts` is now the one level projection used by the socket and the endpoint. `resolveLevel` behaves as before. |
| Unchanged | Edit/own sockets, the desktop owner-token path, MCP collab tools (`prism_suggest_edit`, `prism_add_comment`, `prism_resolve_comment`, `prism_update_note` on live docs), agent session policies, the reconciler, version history. |

Files: `apps/server/src/{human-collab.ts, routes/human-collab.ts, collab.ts, collab-ops.ts, config.ts, db.ts, routes/api.ts}`, `apps/server/.env.example`, tests `apps/server/test/{suggest-enforcement, human-collab, comment-level, collab}.test.ts` and `test/helpers.ts`. Outside `apps/server`: the new file `packages/core/src/lib/collab/commands.ts`, one export line in `packages/core/package.json`, and this document. No existing file under `packages/core/src` or `apps/web/src` was touched; `apps/server/src/app.ts` was not touched; no dependency or lockfile change.

## Release order (important)

The shipped web client still lets a suggest user type into the editor. With enforcement on, that typing is refused by the server and never saved (see "What old clients experience"). So:

1. Deploy this server with `COLLAB_SUGGEST_ENFORCED=false`. Nothing changes for users; the command endpoint is available.
2. Ship the client that follows the contract below.
3. Remove the env line (or set it to `true`) and restart. Enforcement is on.
4. Rollback at any point: set `COLLAB_SUGGEST_ENFORCED=false` and restart. No data migration either way.

Deploying with the default (on) before step 2 breaks suggesting for current clients.

## Client contract requested for suggest-only enforcement

### 1. Discovering the mode (no new contract)

Hocuspocus already tells the client its scope in the `Authenticated` message: `provider.authorizedScope` is `"readonly"` or `"read-write"` (also the `onAuthenticated({ scope })` callback). Verified for a suggest user and a suggest guest (`suggest-enforcement.test.ts`, "the server reports a readonly scope to a suggest actor").

Use the command composer when `level === "suggest"` **and** `scope === "readonly"`, on a document note. With the kill switch off the scope is `"read-write"` and the legacy tracked-typing behaviour should stay. Every grant change closes live sockets with code 4403 and the provider reconnects, so re-read the scope on each `authenticated` event rather than once.

### 2. `collabAffordances` (the one-line change)

`packages/core/src/lib/collab/access.ts`, the suggest row:

```diff
-export function collabAffordances(level: string | null): CollabAffordances {
+export function collabAffordances(level: string | null, socketScope?: "readonly" | "read-write"): CollabAffordances {
   …
   if (level === "suggest") {
-    return { editable: true, suggestOnly: true, canComment: true, canReview: false };
+    return { editable: socketScope === "read-write", suggestOnly: true, canComment: true, canReview: false };
   }
```

`editable` then means "may type into the shared body". Before authentication (`undefined`) the body is not editable, which is the safe side. `canComment` stays true for suggest, but every comment action must go through commands when the scope is readonly. `apps/server/test/comment-level.test.ts` pins the shipped row (`editable: true`) with a comment pointing here; update that assertion in the same change.

### 3. Endpoint

`POST {api}/collab/{noteId}/commands` — `humanCollabCommandPath(noteId)` in `@prism/core/collab-commands` returns `/api/collab/<encoded id>/commands`.

Request:
- `Content-Type: application/json` is required (415 otherwise).
- Credentials exactly as other `/api` calls: session cookie, or `Authorization: Bearer pd_…`, or a capability link as `?t=<token>` or `Authorization: Capability <token>`. A signed-in user who opened a suggest link should send both the session and `?t=`; the server combines the grants the same way the socket does and attributes the change to the account.
- `X-Prism-Vault`, if sent, must be the id of the vault the caller is bound to (a link's own vault; for an account, a registered vault). An unknown or different id is refused (403 `vault_mismatch`); it never silently falls back to the primary vault.
- Cookie requests with `Sec-Fetch-Site: cross-site|same-site`, or an `Origin` that is not `APP_ORIGIN`/a native origin, are refused (403 `csrf_refused`). Same-origin PWA and native bearer requests are unaffected. A Vite dev server on another port is `same-site`: use its proxy.
- Body ≤ 80,000 bytes. 120 requests/minute per client IP.

Body (types in `@prism/core/collab-commands`; the schema is **strict** — any unknown key is a 400, so do not send author, name, color or actor fields):

```ts
type HumanCollabCommand =
  | { kind: "suggest";        requestId; createdAt; revision; from; to; quote; text }   // text may be ""
  | { kind: "comment";        requestId; createdAt; revision; from; to; quote; text }   // from < to, text non-empty
  | { kind: "reply";          requestId; createdAt; revision; threadId; text }
  | { kind: "resolve";        requestId; createdAt; revision; threadId; resolved: boolean }
  | { kind: "delete-comment"; requestId; createdAt; revision; threadId };
```

- `requestId`: a UUID, new per user action. A retry after a lost or failed response **must** reuse it with the identical body.
- `createdAt`: `Date.now()` when prepared. More than 24 h old or more than 5 min in the future → 409 `expired`.
- `revision`: see §4.
- `from`/`to`: ProseMirror positions (`editor.state.selection`). `quote`: `editor.state.doc.textBetween(from, to, "\n", "￼")`.
- `suggest` operation is decided by shape: `from === to` + text → insert; `from < to` + `""` → delete; `from < to` + text → replace. `text` is plain text, ≤ 10,000 chars; `\n` becomes a hard break in the same block. Both ends must be inside a text block that allows the suggestion marks (not a code block).
- `threadId`: the thread's id in the `comments` Y.Map.

Success — `200`, body is the receipt's result and is identical on every replay:

```ts
{ requestId, kind, suggestionId? /* suggest */, threadId? /* all comment kinds */, commentId? /* comment, reply */, resolved? /* resolve */ }
```

A replay carries the header `Idempotent-Replayed: true`. The change itself arrives over the client's own (read-only) socket; do not apply anything optimistically.

Errors — always `{ error: <code>, message: <text safe to show>, retry?: true, noteKind? }`:

| Status | `error` | Meaning / what the client should do |
|---|---|---|
| 400 | `invalid_command` | Schema or range problem. Drop the anchor, keep the text. |
| 400 | `unsupported_kind` | The note is code / a spreadsheet / a canvas (`noteKind`). Show the explanation; these stay view-only for suggest actors. |
| 401 | `unauthenticated` | No valid session, device token or link. |
| 403 | `forbidden` | Below suggest on this note (also: a private note that is not yours). |
| 403 | `access_changed` | Access, credential, workspace or note privacy changed while the request was in flight. Nothing was applied. Reopen the document. |
| 403 | `vault_mismatch` | See `X-Prism-Vault` above. |
| 403 | `not_author` | `delete-comment` on a thread that is not entirely yours (rule below). |
| 403 | `csrf_refused` | Cross-site cookie request. |
| 404 | `not_found` | No such note in that vault. |
| 409 | `stale_revision` | The document or its comments changed. **Keep the draft**, clear the anchor, ask the user to reselect and review. |
| 409 | `quote_changed` | The range no longer holds that text. Same handling. |
| 409 | `suggestion_overlap` | The passage (or the caret position) already carries or touches a pending suggestion. |
| 409 | `thread_missing` | The thread was deleted. |
| 409 | `request_id_reused` | This `requestId` was already used with a different body. Use a new id. |
| 409 | `expired` | `createdAt` out of range. Prepare the change again. |
| 415 | `unsupported_media_type` | Missing JSON content type. |
| 429 | `rate_limited` / `document_request_limit` | Back off (`Retry-After` on the first). |
| 502 | `upstream_error` (`retry: true`) | Outcome unknown. Retry the **same** request. |
| 503 | `not_confirmed` (`retry: true`) | Applied in the live document but the save could not be confirmed. Retry the **same** request; it will not apply twice. |

Do not treat a network failure, 502 or 503 as "not applied": keep the pending command (same `requestId` and body) and retry it. The rate-limit 429 body is the shared middleware's `{ error: "rate_limited", retryAfter }` (no `message`).

### 4. Revision

```ts
import { humanCollabRevision } from "@prism/core/collab-commands";
const revision = await humanCollabRevision(editor.state.doc.toJSON(), ydoc.getMap("comments").toJSON());
```

Lowercase hex SHA-256 of the UTF-8 bytes of `canonicalCollabState({ comments, doc })`: keys sorted by UTF-16 code unit, no whitespace, `undefined` → `null`. The server imports the same `canonicalCollabState`, and computes the ProseMirror JSON from the shared `collabExtensions()` schema. Compute the revision from the **same** editor state the range and quote were read from, while connected and synced.

Any change to the body or to any comment thread by anyone between capture and submit gives 409. This is the approved conservative rule, not concurrent merging; do not describe it as such in the UI.

### 5. Authorization rules the UI should mirror

- `suggest`, `comment`, `reply`: suggest level or higher. A comment-level actor is refused (comments still need suggest).
- `resolve` / reopen: any actor at suggest or higher, on any thread. Same as the shipped editor and the MCP tools.
- `delete-comment`: an editor (edit/own) may delete any thread. A suggest actor may delete a thread only if **every** comment in it carries that actor's server-stamped `actorId`. This is narrower than the shipped editor, where a suggest user could delete any thread including other people's replies. Consequences: a thread with someone else's reply cannot be deleted by its starter; a thread written by the old raw client (no `actorId`) can be deleted only by an editor; all guests using one link are one actor.
- Attribution written by the server: suggestion marks get `user` = the account's profile name (else email) or `"Guest"`, `color`, `suggestionId`, `actorId`; comment items get `{ id, author, actorId, color, text, createdAt, agent: false }`. `actorId` is an opaque keyed hash (`h_…`), not the email. To show "delete" only on own threads the client needs its own `actorId`; there is no endpoint for that yet (open question 3).

### 6. What old clients experience (switch on, client not updated)

A suggest user's editor is still editable. Their keystrokes apply locally, the server answers each update with "not applied", and nothing is saved or shown to anyone else. `provider.unsyncedChanges` stays above zero. They keep receiving other people's edits, merged into their locally diverged copy; on reload their local text is gone (unless the client's own offline persistence replays it, in which case it is refused again). Comment threads they add behave the same way. Nothing is corrupted server-side. This is why the release order above matters.

### 7. Copy

`packages/core/src/components/layout/ShareDialog.tsx` line 39 ("Use it only with trusted collaborators: the server does not yet prevent direct document changes with this permission") was **not** changed. It can be removed once the updated client ships and enforcement is on in production.

## Receipt design

Table `collab_command_receipts`, primary key `(vault_id, note_id, actor, request_id)`, with `command_hash` (SHA-256 of the canonical body), `kind`, `result` JSON (ids only), `state`, `created_at`, `durable_at`. `actor` is server-derived: `user:<email>` or `capability:<id>`.

Two states:

- **applied** — inserted in the same better-sqlite3 transaction and the same JS tick as the Yjs mutation. The change exists only in the in-memory document.
- **durable** — set by `storeDocumentState` in the same transaction that writes the document snapshot (`collab_docs`), and only if the vault write succeeded or the content already matched.

Rules:

- The endpoint returns 200 only when the receipt is durable. Otherwise 503 `not_confirmed`.
- A durable receipt answers a replay on its own, without loading the document and without a revision check. So a replay returns the original result after unload/reload, after a reviewer accepted or rejected the suggestion, and after an external vault edit reseeded the document.
- Loading a document deletes that note's `applied` receipts before anything else. An unconfirmed change belonged to a document instance that no longer exists, so the retry applies the command afresh rather than reporting a change that was lost.
- A retry that finds an `applied` receipt while the document is still in memory does not re-apply; it runs the store again and answers when that confirms.
- Same `requestId`, different body → 409 `request_id_reused`.
- Independent of receipts: applying requires the document's revision to equal the pre-command revision, and every effect changes the revision, so a command cannot apply twice while its first effect is present.
- A refused command releases the document without storing, so a refusal never causes a vault write.
- Retention: receipts older than 7 days are pruned (per document on each command, globally at most hourly). Commands older than 24 h are refused, so a pruned receipt can never be replayed into a second application. Cap: 5,000 retained receipts per document, then 429.

What "durable" does not promise: a later reviewer action or an external vault edit can remove the change's effect. The receipt still answers with the original result and the command is not re-applied. That is "applied, then superseded", and it is what the external-reseed acceptance case requires.

## Evidence

Baseline at HEAD `6069ccd`: 1,440 tests, 1,440 pass. Final: 1,499 tests, 1,499 pass (`npm test -w @prism/server`). `npm run typecheck` at the repo root passes for core, desktop, web and server.

The raw-socket rejection tests were run against HEAD before the change: 14 of 16 failed there (the 2 kill-switch tests pass at HEAD because they describe the old behaviour), and all 16 pass after it.

| Acceptance item | Test (file → name) |
|---|---|
| Normal insert rejected, nothing persisted | `suggest-enforcement` → "a normal insert from a suggest socket never reaches the server or storage" |
| Deletion-set-only update | → "a deletion-set-only update is rejected" (provider path and a hand-built frame with zero structs) |
| Hidden / extra roots, comments map | → "writes to hidden / extra Y roots … are rejected" |
| Pending structs / clock gap | → "an update with pending structs (a clock gap) is rejected, and leaves nothing pending" |
| SyncStep2 with unseen content at connect | → "a SyncStep2 carrying unseen content at connect is rejected" |
| User and guest | every test above runs once per actor kind |
| Editors unaffected, suggest actor reads live | → "editors keep collaborating beside a suggest actor, who keeps reading live"; `human-collab` → "suggest: insert, delete and replace …" |
| Every command kind, user and guest, server attribution | `human-collab` → "suggest: insert, delete and replace …", "comment → reply → resolve → reopen → delete …" |
| Spoofed fields refused | → "a body that tries to name its own author is refused (strict schema)" |
| Revocation / downgrade / credential loss in flight | → 10 "race […] at vault read #2/#3" tests, plus "the note becomes private to someone else while the request is in flight" |
| Vault mismatch | → "vault mismatch fails closed" |
| Stale revision, changed quote, overlap | → "stale revision, changed quote and overlapping suggestion → 409, nothing mutated" |
| Replay, id reuse | → "the same request replayed returns the identical result and mutates exactly once", "the same request sent twice AT ONCE" |
| Store → unload → reload → replay | → "receipt survives store → unload → reload" (also replays after a reviewer reject) |
| External vault edit → reseed → replay | → "receipt survives an external vault edit that reseeds the document" (marks kept, and marks wiped) |
| Crash before store | → "crash before the store: the lost change is NOT reported as applied, and the retry applies it exactly once" |
| Failed vault write | → "failed vault write: 503 not_confirmed (never a false 200)" (document still open, and document unloaded) |
| Flag off | `suggest-enforcement` → "kill switch …"; `collab` → "kill switch …"; `human-collab` → "kill switch off: the command endpoint still works" |
| Non-prose kinds | `human-collab` → "non-prose kinds are refused with an explanation" |
| Browser/server canonicalisation | → "canonical JSON is key-order independent …", "the browser helper and the server compute the SAME revision" |
| MCP collab tools not regressed | `mcp-collab` (22 tests, unchanged, passing) |

## Limits and things not proven

- **No browser run.** Revision parity is proven between `@prism/core`'s helper and the server over a client Y.Doc converted with the shared schema. It is not proven against `editor.state.doc.toJSON()` in the real TipTap editor, whose extension list is `collabExtensions()` plus view-only extensions. If any of those adds a node or mark attribute, every command will get 409 `stale_revision`. This needs one check in a browser.
- **Crash test is a model.** The crash case loads a document with the real `loadDocumentState`, applies the command with the real engine, and discards the in-memory document without a store; the retry then goes through real Hocuspocus. The process is not actually killed.
- **Failed vault write, document unloaded, comment commands.** If the save fails and the document then unloads, the reload folds the vault copy back over the body but the `comments` Y.Map entry from the unsaved snapshot remains (existing reload behaviour for any failed store). A retried `comment` then gets 409 `stale_revision` and an unanchored thread is left behind. No duplicate and no false success, but not clean. Suggest commands in the same situation are re-applied once (tested).
- **Federated peers.** A peer hub with a suggest-level space grant now has a read-only socket too, and peer hubs have no command path. Federation is off by default. `docs/federation.md` ("Suggest-mode: the durable inbox") describes the old behaviour.
- **Guests sharing a link** are one actor: one idempotency namespace, and any of them can delete a thread another of them wrote.
- **Note privacy** is re-read from the vault immediately before the mutation, but a privacy change made directly in the vault between that read and the mutation (same tick, effectively impossible in-process) or not routed through this server's access events is only seen on the next request. Same exposure as the socket's own revalidation.
- **Stateless broadcast.** A read-only Hocuspocus connection can still send `BroadcastStateless` messages to other connections of the same document. This existed for view-level sockets before this change and does not touch the document; noted, not changed.
- Not updated because they are outside this slice's boundary: `CLAUDE.md` ("below `suggest` → read-only"), `docs/mcp-access.md` line 179, `docs/native-auth.md` line 84, `docs/federation.md`.

## Open questions for the frontend

1. Does `editor.state.doc.toJSON()` in `CollabEditor` equal the server's JSON for the same document (see first limit)? If not, the revision helper should take the Y fragment instead, which is a core-only change.
2. Can a non-editable TipTap editor express the caret position and range the composer needs, on desktop and mobile?
3. Showing "Delete" only on a suggest actor's own threads needs the caller's `actorId`. Options: return it in the 200 body of every command, or add `GET /api/collab/:id/commands/me`. Say which you prefer; neither exists yet.
4. A signed-in user on a suggest link must send `?t=` on the command request as well as on the socket. Does the current transport keep the capability token available in that state?
5. The WIP composer reads `body.error` as display text. The contract is now `error` = code, `message` = text.
6. Should `suggestion_overlap` at a caret that only *touches* someone's suggestion be allowed? It is refused today, which is the conservative choice.
