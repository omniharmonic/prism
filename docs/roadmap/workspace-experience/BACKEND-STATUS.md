# Backend status — human suggest-only enforcement

Updated 2026-10-02 (third pass: two independent security reviews — see "Security review follow-up" and "Second review follow-up"). Branch `feat/backend-followup`, worktree `.worktrees/backend-followup`. **Not merged, not deployed, no server restarted.** Everything below was verified against fixtures only (in-memory SQLite, fake vault, a real in-process Hocuspocus server with real WebSocket provider clients). Nothing here was run in a browser, against production, or with the real editor.

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

## Release order — editor schema v2 (block editor)

Server with the schema gate first (`pm2 restart prism-server`), then the PWA build, then rebuild and reinstall Prism Client; the legacy desktop must not be used for editing afterwards. Details and the gate contract: `docs/client-app.md` § Editor schema handshake.

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

Use the command composer when `level === "suggest"` **and** `scope === "readonly"`, on a document note. With the kill switch off the scope is `"read-write"` and the legacy tracked-typing behaviour should stay. Every grant change makes the server close the document channel (reason starts with `Access changed.`). The provider does **not** reconnect by itself after that close; the shipped `CollabDoc` already does (`disconnect()` → wait for transport close → `connect()`), and the new scope arrives with the next `authenticated` event — so read the scope on every `authenticated`, not once. Text a user typed locally while suggest-only stays in their Y.Doc and will sync if they are later upgraded to edit on the same page; clear or remount the document when switching modes if that is not wanted.

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
- Body ≤ 80,000 bytes. 120 requests/minute per client IP, and **30 accepted-for-processing requests/minute per actor per document** (`COLLAB_COMMANDS_PER_MINUTE`).

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
- `suggest` operation is decided by shape: `from === to` + text → insert; `from < to` + `""` → delete; `from < to` + text → replace. `text` is plain text, ≤ 10,000 chars, **with no line break** (`\n`, `\r`, U+2028/9 → 400), no tab or other control character, no run of two whitespace characters, not whitespace-only, and no leading/trailing space where HTML would collapse it (at a paragraph edge or next to another space). These are refused because the stored note is HTML and the document is rebuilt from it after an external edit. The range may cover at most 100 differently formatted text runs.
- Every text field must be well-formed Unicode (`str.isWellFormed()`); a lone surrogate is a 400. Comment and reply text may contain line breaks and tabs, but no other control characters. `threadId` must match `[A-Za-z0-9_-]{1,200}`. `from` and `to` must be in the **same paragraph** (text block), and the range must be fully markable: a selection that includes inline code, a line break or an embedded node is refused whole (400), never applied in part. The composer should offer one suggestion per paragraph and disable submit for such selections.
- `comment` / `reply` `text`: 1–4,000 chars (`HUMAN_COLLAB_LIMITS.commentText`).
- `:id` must be the note's **id** (`[A-Za-z0-9_-]{1,128}`). A path or title is answered 404 exactly like a missing note, even though the gateway's `GET /api/notes/:x` resolves them. Always use `note.id` from the note you loaded.
- `threadId`: the thread's id in the `comments` Y.Map.

Success — `200`, body is the receipt's result and is identical on every replay:

```ts
{ requestId, kind, suggestionId? /* suggest */, threadId? /* all comment kinds */, commentId? /* comment, reply */, resolved? /* resolve */ }
```

A replay carries the header `Idempotent-Replayed: true`. The change itself arrives over the client's own (read-only) socket; do not apply anything optimistically.

Errors — always `{ error: <code>, message: <text safe to show>, retry?: true, noteKind? }`:

| Status | `error` | Meaning / what the client should do |
|---|---|---|
| 400 | `invalid_command` | Schema or range problem, a line break in suggested text, a range spanning paragraphs, or a range that cannot be marked completely. `message` says which. Drop the anchor, keep the text. |
| 400 | `unsupported_kind` | The note is code / a spreadsheet / a canvas (`noteKind`). Show the explanation; these stay view-only for suggest actors. |
| 401 | `unauthenticated` | No valid session, device token or link. |
| 403 | `forbidden` | Below suggest on this note (also: a private note that is not yours). |
| 403 | `access_changed` | Access, credential, workspace or note privacy changed while the request was in flight. Nothing was applied. Reopen the document. |
| 403 | `vault_mismatch` | See `X-Prism-Vault` above. |
| 403 | `not_author` | `delete-comment` on a thread that is not entirely yours (rule below). |
| 403 | `csrf_refused` | Cross-site cookie request. |
| 404 | `not_found` | No note with that **id** in that vault (also returned for a path/title alias or a malformed id). |
| 409 | `stale_revision` | The document or its comments changed. **Keep the draft**, clear the anchor, ask the user to reselect and review. |
| 409 | `quote_changed` | The range no longer holds that text. Same handling. |
| 409 | `suggestion_overlap` | The passage (or the caret position) already carries or touches a pending suggestion. |
| 409 | `thread_missing` | The thread was deleted. |
| 409 | `thread_full` | The thread has 200 comments. Start a new thread. |
| 413 | `document_too_large` | The change would push the rendered note past 1,000,000 bytes or the comments past 1,000,000 bytes, or one command would add more than 64,000 bytes. Applies to deletions too (their marks add markup). |
| 409 | `request_id_reused` | This `requestId` was already used with a different body. Use a new id. |
| 409 | `expired` | `createdAt` out of range. Prepare the change again. |
| 415 | `unsupported_media_type` | Missing JSON content type. |
| 429 | `rate_limited` | Either 120 requests/min per client IP (body is the shared middleware's `{ error, retryAfter }`, no `message`) or 30/min per actor per document (`{ error, message, retry: true }`). Both set `Retry-After`. |
| 429 | `actor_growth_limit` | This actor has added 100,000 bytes of rendered body, or 100,000 bytes of comments, to this document within ~24 h. Resolve / delete-comment still work. |
| 429 | `actor_request_limit` | This actor has 500 suggest/comment/reply receipts on this document in ~24 h (resolve and delete-comment are counted separately, 500). Checked before anything expensive, so it wins over `stale_revision`. |
| 429 | `document_request_limit` | 20,000 receipts on this document across all actors (backstop). |
| 429 | `too_many_pending_suggestions` | This actor already has 100 unreviewed suggestions on this document. |
| 429 | `too_many_threads` | The document has 1,000 comment threads. |
| 502 | `upstream_error` (`retry: true`) | Outcome unknown. Retry the **same** request. |
| 503 | `not_confirmed` (`retry: true`) | Applied in the live document but the save could not be confirmed. Retry the **same** request; it will not apply twice. |

Do not treat a network failure, 502 or 503 as "not applied": keep the pending command (same `requestId` and body) and retry it. After a reload that lost an unconfirmed change, that same retry is applied afresh and returns 200 **without** `Idempotent-Replayed`, possibly with different ids than a response the client never saw — only trust ids from a 200.

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
- `delete-comment`: an editor (edit/own) may delete any thread. A suggest actor may delete a thread only if **every** comment in it carries that actor's server-stamped `actorId`. This is narrower than the shipped editor, where a suggest user could delete any thread including other people's replies. Consequences: a thread with someone else's reply cannot be deleted by its starter; a thread written by the old raw client (no `actorId`) can be deleted only by an editor.
- **Budgets are per actor.** A signed-in user who also presents a link is still that one account (same budgets — tested). The same person acting once signed-in and once as an anonymous guest of a link is two actors; the server cannot tell them apart.
- **Guests on one link are one actor.** A capability link is the principal: everyone using the same link shares one `actorId`, one idempotency namespace and one set of per-actor budgets, all show as "Guest", and any of them can delete a thread that only guests of that link wrote. Per-person guest identity does not exist in Prism today.
- Attribution written by the server: suggestion marks get `user` = the account's profile name (else email) or `"Guest"`, `color`, `suggestionId`, `actorId`; comment items get `{ id, author, actorId, color, text, createdAt, agent: false }`. `actorId` is an opaque keyed hash (`h_…`), not the email. To show "delete" only on own threads the client needs its own `actorId`; there is no endpoint for that yet (open question 3).

### 6. What old clients experience (switch on, client not updated)

A suggest user's editor is still editable. Their keystrokes apply locally, the server answers each update with "not applied", and nothing is saved or shown to anyone else. `provider.unsyncedChanges` stays above zero. They keep receiving other people's edits, merged into their locally diverged copy; on reload their local text is gone (unless the client's own offline persistence replays it, in which case it is refused again). Comment threads they add behave the same way. Nothing is corrupted server-side. This is why the release order above matters.

### 7. Copy

`packages/core/src/components/layout/ShareDialog.tsx` line 39 ("Use it only with trusted collaborators: the server does not yet prevent direct document changes with this permission") was **not** changed. It can be removed once the updated client ships and enforcement is on in production.

## Receipt design

Table `collab_command_receipts`, primary key `(vault_id, note_id, actor, request_id)`, with `doc_name` (the in-memory collab document it was applied to), `command_hash` (SHA-256 of the canonical body), `kind`, `result` JSON (ids only), `state`, `created_at`, `durable_at`. `actor` is server-derived: `user:<email>` or `capability:<id>`.

Two states:

- **applied** — inserted in the same better-sqlite3 transaction and the same JS tick as the Yjs mutation. The change exists only in the in-memory document.
- **durable** — set by `storeDocumentState` in the same transaction that writes the document snapshot (`collab_docs`), only if the vault write succeeded or the content already matched, and only for the receipts that already existed when that store **rendered** the content it wrote **and whose change was still in the document at that moment** (suggestion marks / thread + anchor + comment item present). A change a vault fold has removed is cleaned up and its receipt deleted: the caller gets 503, the retry 409 `stale_revision`. A command applied while a store's vault write is in flight is not confirmed by that store; its own store confirms it.

Rules:

- The endpoint returns 200 only when the receipt is durable. Otherwise 503 `not_confirmed`.
- A durable receipt answers a replay on its own, without loading the document and without a revision check. So a replay returns the original result after unload/reload, after a reviewer accepted or rejected the suggestion, and after an external vault edit reseeded the document.
- Loading a document deletes the `applied` receipts of **that document name** before anything else, and then removes whatever those commands left in the restored snapshot (`undoLostCommands`: reject that suggestion id; remove the comment item the command created and, only if nobody else has replied, the thread and its anchor; remove that reply; for a lost `delete-comment`/`resolve` it makes body and comments map agree — those two cannot be undone, their retry gets 409). The document is then the pre-command state, so the retry applies the command afresh rather than reporting a change that was lost.
- A retry that finds an `applied` receipt while the document is still in memory does not re-apply; it runs the store again and answers when that confirms.
- Same `requestId`, different body → 409 `request_id_reused`.
- Independent of receipts: applying requires the document's revision to equal the pre-command revision, and every effect changes the revision, so a command cannot apply twice while its first effect is present.
- A refused command releases the document without storing, so a refusal never causes a vault write.
- Retention: 24 h + 10 min (command max age + twice the 5-min clock skew), pruned per document on each command and globally at most hourly. A pruned receipt can never be re-applied: a receipt's `created_at` is the server time of application and the command was accepted only with `createdAt ≤ created_at + 5 min`; once `created_at < now − retention`, `createdAt < now − 24 h`, which is refused as `expired`. Caps: 500 suggest/comment/reply receipts and, separately, 500 resolve/delete-comment receipts per (document, actor); 20,000 per document. Each receipt also records the body and comment bytes it added, which is what the per-actor size budgets sum.

What "durable" does not promise: a later reviewer action or an external vault edit can remove the change's effect. The receipt still answers with the original result and the command is not re-applied. That is "applied, then superseded", and it is what the external-reseed acceptance case requires.

## Evidence

Baseline at HEAD `6069ccd`: 1,440 tests, 1,440 pass. After the first pass: 1,499. After the first review follow-up: 1,513. Final, after the second: 1,522 tests, 1,522 pass (`npm test -w @prism/server`). `npm run typecheck` at the repo root passes for core, desktop, web and server.

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

## Security review follow-up (second pass)

Each finding was reproduced first, then fixed. Test names are in `human-collab.test.ts` unless noted.

| Finding | Outcome | Proof |
|---|---|---|
| H1 unattributed line breaks | Confirmed: the shared Yjs types keep no mark on a hard break, so `\n` text added breaks no reviewer could reject. Line breaks in `text` are now refused (400). | "H1: a suggestion can never add unattributed content …" |
| H1 post-condition / partial marking | Confirmed (`aa <code>bb</code> cc` was marked in part and returned 200). Every suggest command is now checked on a Yjs round-trip of the result: rejecting the new suggestion id must give back exactly the current body and accepting it must give exactly the plain edit; otherwise 400 and nothing is mutated. Ranges are limited to one paragraph. | "H1: a range that cannot be marked completely is refused whole …" |
| H2 path/title alias | Confirmed (a path alias returned 200 and opened a second document). Strict id shape before any vault call; `note.id !== id` → 404 identical to a missing note; the fake vault now resolves by path like the real one. | "H2: the endpoint addresses a note ONLY by its id …" |
| M1 store confirms a command it did not write | Confirmed with a gated vault write (the test fails with the old confirmation rule). The store now confirms only receipts captured when it rendered. | "M1: a command applied WHILE another store's vault write is in flight …" |
| M2 cap exhaustible by one actor | Fixed: 500 per (document, actor), 20,000 per document; retention 24 h + 10 min with the no-re-apply argument above. | "M2: the receipt cap is per actor …", "M2: short retention can never permit a re-apply …", "receipts are bounded per document across all actors …" |
| M3 unbounded growth | Fixed: rendered note ≤ 1,000,000 bytes and comments ≤ 1,000,000 bytes for growing commands, 100 pending suggestions per actor per document, 200 comments per thread, 1,000 threads per document, comment text ≤ 4,000 chars. Resolve and delete stay possible at the limits. | "M3: growth budgets …" |
| LOW-a orphan thread | Fixed by cleanup at load (see Receipt design). Fails without the cleanup. | "LOW-a: a comment whose store failed …", "LOW-a: a reply whose store failed …" |
| LOW-b federation document names | Fixed: unconfirmed receipts are dropped/confirmed per document name. | "LOW-b: unconfirmed receipts belong to ONE in-memory document …" |
| Session-cookie socket | Added. | `suggest-enforcement` → "a suggest user authenticated by SESSION COOKIE …" |
| Live downgrade / upgrade | Added. | `suggest-enforcement` → "live downgrade edit → suggest and upgrade suggest → edit over an open socket …" |
| Loopback `COLLAB_TOKEN` | Added; unchanged behaviour. | `suggest-enforcement` → "the loopback COLLAB_TOKEN owner path is unchanged …" |
| Awareness from a read-only socket | Added (real awareness; leaked intervals cleared in the test). | `suggest-enforcement` → "presence: a read-only suggest socket can publish awareness …" |

Contract changes in the second pass, for the client (see the next section for the third): no line breaks in suggested text; one paragraph per suggestion; fully markable ranges only; `:id` is the note id only; comment/reply text ≤ 4,000; new error codes `actor_request_limit`, `too_many_pending_suggestions`, `too_many_threads`, `thread_full`, `document_too_large`; `HumanCommandContext`/table gained a document name (server-internal).

## Second review follow-up (third pass)

Each item was reproduced or A/B-tested against the previous behaviour. Tests are in `human-collab.test.ts` unless noted.

| Item | Outcome | Test |
|---|---|---|
| 1 Store fold confirms a removed change | Fixed. Every store checks that each unconfirmed command's change is still present before confirming; otherwise it cleans up and forgets the receipt. This also covers folds done by the reconciler before the store. Fails with the check removed. | "R1: a store that folds a newer vault copy does NOT confirm …" |
| 2 Lone surrogate / control text | Fixed: all text fields must be well-formed; control characters refused (comments keep `\n` and `\t`); suggested text also refuses tabs, whitespace-only, double whitespace and edge spaces. Display names are cleaned and capped at 80 characters. | "R2: ill-formed or control text is refused …" |
| 3 Deletion skips the size budget | Fixed: the budget applies to every suggest and to comment anchors; one command may add at most 64,000 rendered bytes; a range may cover at most 100 text runs. | "R3: a deletion-only suggestion is under the size budget too …" |
| 4 Cost / DoS | Fixed: limits before planning; 30/min per actor per document; verification and size delta on the touched blocks only; revision hash cached per document state. Timings below. | "R4: limits are checked before the expensive work …" |
| 5 One actor blocks others | Fixed: per-actor budgets of 100,000 body bytes and 100,000 comment bytes per document per ~24 h; resolve/delete-comment budgeted separately. | "R5: per-actor size budgets …", "R4 …" |
| 6 Alias on the socket | Fixed in `resolveLevel` for every credential including the owner token: id shape first, then the vault's resolved id must equal the name. Fails with the check removed. | `suggest-enforcement` → "socket: a path or title alias of a note is refused …", "socket: every legitimate document name still works …"; federation space keys: existing `federation.test.ts` |
| 7 No migration | Fixed: `migrateCollabReceipts` runs at module load; an older table shape is dropped and recreated with the current indexes. | "R7: a database created by the earlier branch commits is migrated at boot …" |
| LOW cleanup deletes others' replies | Fixed (see Receipt design). | "LOW: cleaning up a lost comment never deletes other people's replies" |
| LOW overstated comment | Corrected in `human-collab.ts` and here: a lost resolve/delete-comment is not re-applied; its retry gets 409. | — |
| LOW fake vault title | The fixture vault resolves id → path → unique title; the endpoint and socket alias tests use all three. | "H2: the endpoint addresses a note ONLY by its id …" |

**Document names the socket accepts** (anything else is refused): a note id `[A-Za-z0-9_-]{1,128}` in the primary vault; `<vaultId>::<note id>` for another vault; a federation `space_note_key` when federation is on (mapped to its local note id before the check). The owner token keeps opening a note the vault cannot read, as before.

**Timings**, ~898 KB rendered document (3,880 formatted paragraphs), one command including the revision hash, measured in-process on the development Mac (not production hardware):

| | Before | After |
|---|---|---|
| suggest insert | 364 ms | 45–87 ms |
| comment | 239 ms | 42–86 ms |

About 45 ms of the remaining time is the revision hash of the whole document, which is needed once per document state. The store that follows every command still renders the whole document; that cost is the same as for any editor's store and was not changed. At 30 commands/minute one actor can keep the event loop busy for roughly 2–3 s per minute on a document this size.

Known gaps after this pass:
- Raw typing by editors between two stores is not in the rendered-size estimate until the next store (seconds).
- The size estimate after a load of a Markdown-source note is measured once with a full render (one slow command per load).
- A change that a reviewer accepts or rejects in the few milliseconds between a command and its store is treated like a fold: the caller gets 503 and then 409, although the reviewer saw it.
- Dropping an older receipts table loses durable receipts younger than 24 h; a retry of such a command gets 409 `stale_revision` (or applies once if the document is back in its pre-command state).

## Limits and things not proven

- **No browser run.** Revision parity is proven between `@prism/core`'s helper and the server over a client Y.Doc converted with the shared schema. It is not proven against `editor.state.doc.toJSON()` in the real TipTap editor, whose extension list is `collabExtensions()` plus view-only extensions. If any of those adds a node or mark attribute, every command will get 409 `stale_revision`. This needs one check in a browser.
- **Crash test is a model.** The crash case loads a document with the real `loadDocumentState`, applies the command with the real engine, and discards the in-memory document without a store; the retry then goes through real Hocuspocus. The process is not actually killed.
- **Lost `resolve` / `delete-comment`.** After a failed store + reload these cannot be undone (the thread data is gone or already flagged), so the load finishes the body side to match the comments map. The retry of the same request then gets 409 (`stale_revision`, then `thread_missing` for a delete). No false 200 and no duplicate, but the effect persisted although the client was told 503. Additive commands (suggest, comment, reply) are undone and re-applied once (tested).
- **Raw edits after a failed store are still lost on reload.** `storeDocumentState` keeps writing a snapshot with no source version when the vault write fails, and the next load folds the older vault copy over it. That is existing behaviour for editors' raw typing and was not changed.
- **Federated peers.** A peer hub with a suggest-level space grant now has a read-only socket too, and peer hubs have no command path. Federation is off by default; `docs/federation.md` now says so. A federated note can be loaded under its space key and under its bare id as two in-memory documents (pre-existing); the endpoint always uses the space key, and unconfirmed receipts are scoped by document name so the two instances cannot drop or confirm each other's commands (tested at the store/load level, not with two live hubs).
- **Note privacy** is re-read from the vault immediately before the mutation, but a privacy change made directly in the vault between that read and the mutation (same tick, effectively impossible in-process) or not routed through this server's access events is only seen on the next request. Same exposure as the socket's own revalidation.
- **404 vs 403.** A missing note id is 404 and an existing note the caller may not use is 403, so the endpoint tells a caller whether an id exists. This is the same as the existing `GET /api/notes/:id` (vault 404 passed through, no-view 403); it adds no new oracle. Paths and titles are never resolved here, so it is narrower than the GET.
- **Stateless broadcast.** A read-only Hocuspocus connection can still send `BroadcastStateless` messages to other connections of the same document. This existed for view-level sockets before this change and does not touch the document. No client code acts on stateless messages: a search of `packages/core/src` and `apps/web/src` finds no `onStateless` handler and no `stateless` listener, so today such a message is ignored by every Prism client. Not changed.
- `CLAUDE.md` (Real-time Collaboration, WP6.3 rule line), `docs/mcp-access.md`, `docs/native-auth.md` and `docs/federation.md` were updated in the second pass to describe the edit threshold, the command path, the flag and the release order.

## Open questions for the frontend

1. Does `editor.state.doc.toJSON()` in `CollabEditor` equal the server's JSON for the same document (see first limit)? If not, the revision helper should take the Y fragment instead, which is a core-only change.
2. Can a non-editable TipTap editor express the caret position and range the composer needs, on desktop and mobile?
3. Showing "Delete" only on a suggest actor's own threads needs the caller's `actorId`. Options: return it in the 200 body of every command, or add `GET /api/collab/:id/commands/me`. Say which you prefer; neither exists yet.
4. A signed-in user on a suggest link must send `?t=` on the command request as well as on the socket. Does the current transport keep the capability token available in that state?
5. The WIP composer reads `body.error` as display text. The contract is now `error` = code, `message` = text.
6. Should `suggestion_overlap` at a caret that only *touches* someone's suggestion be allowed? It is refused today, which is the conservative choice.
