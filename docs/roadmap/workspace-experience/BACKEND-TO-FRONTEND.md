# Backend → frontend (Codex) handoff notes

Updated 2026-10-02 by the backend agent. This is the single file to read for everything the backend stream needs from, or wants to tell, the frontend stream. Nothing here has been merged to main, deployed, or run in a browser. All evidence is fixture-only (in-memory fake vault, real Hocuspocus/WS/SQLite in tests).

## Branches ready for you to look at

**Integrate ONE branch: `feat/backend-combined`** (worktree `.worktrees/backend-combined`, base `6069ccd`). It merges the three slices below; the per-slice branches are kept only for reference/review history.

| Slice | Source branch | State |
|---|---|---|
| Human suggest-only enforcement (server half) | `feat/backend-followup` | Two independent security reviews; every finding fixed with tests (last fix round not itself re-reviewed; fails closed). Deploy with `COLLAB_SUGGEST_ENFORCED=false` first — see release order. |
| Transcript/calendar review | `feat/backend-transcripts` | Independently reviewed; fixes applied. Ready. |
| Graph identity + linking (people ↔ messages/emails/meetings/tasks/projects) | `feat/backend-graph` + agent tools committed on `feat/backend-combined` | Two independent reviews; fixes applied. Deploys inert: every new flag off, every job dry-run by default. Agent tools under a third (short) review at time of writing. |

Detailed contracts live on each branch:

- `docs/roadmap/workspace-experience/BACKEND-STATUS-TRANSCRIPTS.md` (on `feat/backend-transcripts`)
- `docs/roadmap/workspace-experience/BACKEND-STATUS.md` (on `feat/backend-followup`)

Test counts (server suite, `npm test -w @prism/server`): baseline 1,440 → combined branch 1,673, all passing; root `npm run typecheck` passes. Known flake: the Proton test "a hostile message … parses fast" is timing-bound and can fail under machine load (unrelated code; rerun that file alone).

---

## 1. Human suggest-only enforcement

### Release order (important)

With enforcement on (the code default), the **currently shipped client breaks for suggest-level users**: their typing is refused by the socket and never saved. Safe sequence:

1. Deploy the server with `COLLAB_SUGGEST_ENFORCED=false` (old behaviour; the command endpoint works either way).
2. Ship the client with the suggestion composer.
3. Turn enforcement on (remove the flag or set it true) and restart.

Keep the "trusted collaborators" warning in `ShareDialog.tsx` until step 3 is live.

### What the server now does

- Raw Yjs updates on `/collab` require **edit**. A suggest-level actor (signed-in user or capability-link guest) gets a read-only socket: live reading and presence still work.
- Suggest actors mutate only through `POST /api/collab/:id/commands` — kinds `suggest` (insert/delete/replace over an exact range + quote), `comment`, `reply`, `resolve`, `delete-comment`. Prose documents only; code/sheet/canvas return 400 with an explanation.
- Each command carries `requestId` (uuid), `createdAt`, and `revision` (SHA-256 over canonical prose + comments). Stale revision or changed quote → 409, nothing mutated, keep the draft.
- A command returns 200 only after the document save succeeded. Otherwise 503 `not_confirmed`: retry **the identical request** (same `requestId`, same body); the server will not apply it twice.
- Author identity comes from the server, never the body. Extra body fields are rejected.


### Contract changes after the security review (2026-10-02, supersede anything above that conflicts)

- **Suggested text may not contain line breaks** (`\n`, `\r`, U+2028/U+2029 → 400). A marked line break cannot be cleanly rejected by a reviewer, so multi-line suggestions are refused. The composer should be single-line or split per paragraph.
- **Range:** `from` and `to` must be in the same paragraph and the range must be fully markable. A selection containing inline code, a line break or an embedded node is refused whole (400). Explain this in the composer rather than letting the request fail.
- **`:id` must be the real note id** (`[A-Za-z0-9_-]{1,128}`); a path or title returns 404.
- **Comment and reply text ≤ 4,000 chars** (`HUMAN_COLLAB_LIMITS.commentText` in `@prism/core/collab-commands`).
- **New error codes:** `actor_request_limit` (429), `too_many_pending_suggestions` (429, 100 pending per actor per document), `too_many_threads` (429), `thread_full` (409, 200 comments), `document_too_large` (413).
- **Retry after a lost change:** the identical retry can return 200 *without* `Idempotent-Replayed` and with new ids. Only trust ids from a 200 body.
- **Lost `resolve` / `delete-comment` after a failed save:** the client saw 503, the retry gets 409, but the effect may persist. Reload thread state on 409 instead of assuming it failed.
- **Access change closes the socket** with reason "Access changed." (observed close code 1000, not 4403 — key on the reason, as the shipped `CollabDoc` does). Re-read the scope on every `authenticated` event.
- **Text typed locally while suggest-only stays in the client's Y.Doc** and will sync if the user is upgraded to edit on the same page. With the editor non-editable for suggest users this should not arise; do not leave a raw-typing path open.
- No client code handles Hocuspocus stateless messages today; keep it that way or tell the backend agent (read-only sockets can still broadcast them).


### Second review round (2026-10-02, latest — supersedes conflicts above)

- **Socket document names:** `/collab` now refuses a path or title alias for EVERY user (not just suggest). Always open a document by `note.id` (`[A-Za-z0-9_-]{1,128}`), `<vaultId>::<id>`, or a federation space key. Please confirm in a browser that every place the client opens a collab document passes the id — a path would now fail to connect.
- **New error code:** `actor_growth_limit` (429) — one person's per-document budget (100,000 body bytes and 100,000 comment bytes per ~24 h).
- **`rate_limited` (429) has two sources:** per IP (120/min, body `{error, retryAfter}`) and per actor per document (30/min, body `{error, message, retry: true}`).
- **`actor_request_limit`** is checked first and wins over `stale_revision`. Resolve and delete-comment have their own separate cap, so they still work when the actor is at its change cap.
- **`document_too_large` (413)** also fires for a deletion, or any single command adding more than 64 KB rendered.
- **`invalid_command` (400)** also covers: ill-formed Unicode in any text field (check `text.isWellFormed()` client-side); control characters; in SUGGESTED text: tabs, whitespace-only text, double whitespace, or a leading/trailing space that HTML would collapse; a range covering more than 100 text runs; a `threadId` not matching `[A-Za-z0-9_-]{1,200}`. Comments may contain `\n` and `\t`. The `message` names the problem.
- **Display names** on marks/threads are cleaned and capped at 80 characters server-side.
- **Review race:** if a reviewer accepts/rejects a suggestion in the instant between a command and its save, the commander gets 503 then 409. Treat as a conflict: reload and let the user re-submit.

### Files the backend added outside `apps/server`

- `packages/core/src/lib/collab/commands.ts` (new: command/result/error types, canonical JSON, browser revision helper)
- one line in `packages/core/package.json`: the `./collab-commands` subpath export

No existing file under `packages/core/src` or `apps/web/src` was changed.

### Client changes needed (frontend-owned files — backend has not touched them)

1. **`packages/core/src/lib/collab/access.ts` — `collabAffordances`** needs the socket scope. Hocuspocus already reports `readonly` vs `read-write` (`provider.authorizedScope`). The suggest row becomes `editable: socketScope === "read-write"`. `apps/server/test/comment-level.test.ts` pins the shipped row and must be updated in the same change — tell the backend agent when you make it.
2. **Composer wiring** in `CollabDoc.tsx` / `CollabEditor.tsx` / `CommentsSidebar.tsx`: suggest + readonly scope → use the command composer instead of raw editing; comment/reply/resolve/delete callbacks go through commands. The WIP on `feat/human-suggestions` (`20ffc13`) is reference only.
3. **Transport** (`apps/web/src/collab/humanCommands.ts` in the WIP): the error body is now `{ error: <code>, message: <text> }`. The WIP composer read `error` as display text — show `message`, branch on `error`.
4. **Capability links:** a signed-in user who opens a suggest link must send the link token (`?t=`) on the command request as well as on the socket.

### Questions for you

1. Does `editor.state.doc.toJSON()` in the real `CollabEditor` match the server's ProseMirror JSON? Revision parity is proven only between the shared helper and the server using the shared schema. If any client-only extension adds an attribute, every command will 409 — in that case the revision helper should read the Yjs fragment instead. **This is the highest-risk unknown.**
2. Can a non-editable TipTap editor express the caret and range the composer needs, on desktop and mobile?
3. Showing "Delete" only on a suggest actor's own threads needs that actor's opaque id (an `h_…` hash, not the email). Should the server return it in each 200 body, or from a small GET? Neither exists yet — say which you want.
4. A caret that only touches someone else's pending suggestion is refused as `suggestion_overlap`. Is that the behaviour you want?

### Behaviour changes users will see

- **Deleting comment threads is narrower for suggest users:** only threads where every comment is theirs. Editors unchanged. All guests on one share link count as one actor. Threads written by the old raw client can only be deleted by an editor.
- Resolve/reopen: any suggest-or-above actor on any thread (unchanged).
- Federated peers at suggest level become read-only with no command path (federation is off by default).

### Not proven

- No browser run, no installed-app run.
- Crash-before-save is modelled (in-memory doc discarded without a store), not a killed process.
- Edge: if a **comment** command's save fails and the document unloads, the retry gets 409 `stale_revision` and an unanchored thread is left in the comments map. No duplicate, no false success; documented, not fixed.

---

## 2. Transcript / calendar review

### Contract

Unchanged from the agreed one and matches prototype `11a38b6`:

- `GET /api/transcripts/events/:meetingId?query=`
- `POST /api/transcripts/events/:meetingId/decisions`

Signed-in users only (capability links and anon → 401). Full status-code table is in `BACKEND-STATUS-TRANSCRIPTS.md`.

### Prototype gaps to fix on your side (`feat/transcript-review-ui`, `11a38b6`)

1. **`409` with `error: "superseded"` during a pending retry** leaves the panel stuck on "Retry pending decision". Drop the pending request and reload.
2. **`409` has four causes** — `stale`, `superseded`, `vault_unavailable`, and the existing `write_actor_changed`. The single "changed in another window" message fits only `stale`.
3. **`404` after losing all access** gets the generic message; only `403` gets the permission copy.
4. **`422 request_reused`** gets the generic message (the current panel should never trigger it).
5. **`429 rate_limited`** (60/min per user per route, with `Retry-After`) gets the generic message.
6. **`400`** for a malformed `transcriptId` in the body; a malformed or aliased `:meetingId` is `404`. Always send real note ids, never paths or titles.
7. **`start` is omitted for date-only recordings** (the panel would render a date-only value as the previous evening).
8. Pending retry must resend the **byte-identical** body with the same `requestId` — the prototype already does this; keep it.

### Behaviour to know

- A manual unlink suppresses only that transcript–meeting pair for the worker; the transcript can still auto-link to a different meeting. A manual link is never moved by the worker.
- Moving a transcript writes up to three notes. If interrupted, the response is `{status: "pending"}`; the identical retry repairs it.
- If a half-finished move is replaced by a newer decision, the old meeting can keep listing the transcript until the next live calendar pass cleans it up.
- Candidates are anchored on the meeting's date, capped at 200 (50 with `query`), with `limited: true` when truncated.
- `linkedElsewhere` is a boolean only; the other meeting's id/title is never returned.

### Test helper change that affects every server test

`apps/server/test/helpers.ts`: the shared fake vault's `/notes/:id` now resolves by id, then case-insensitive path (to match the real vault). Mention it if any frontend-branch server test starts behaving differently.

---

## 3. Graph identity + linking (why People / messages-by-person look empty)

Diagnosis (live vault audit, 2026-10-02): server ingest has written no person links since the Matrix/email ingest moved to the server (0 of 1,177 threads since July, 0 of 2,299 emails since August), meetings mostly link by `wikilink` not `attended-by`, tasks hold assignee/project as plain strings, and 102 merged stubs still hold 636 links. The UI reads typed links only, so most context is invisible. The backend fix is a deterministic identity index + review queue + backfill job + forward linking + owner-approved merge, plus Prism MCP tools for agents. Full contract: `docs/roadmap/workspace-experience/BACKEND-STATUS-GRAPH.md` (routes under `/api/admin/people/*`, owner-only + CSRF).

### Needs a frontend change (small, high value)

1. **`VaultMessagesDashboard` lists merged people** (tombstones). It reads `GET /api/notes?tag=person` through the owner passthrough, which the server cannot filter without changing every consumer. Exact change at `packages/core/src/components/comms/VaultMessagesDashboard.tsx` line 93:
   ```ts
   const isMerged = (n: Note) =>
     n.tags?.includes("merged-stub") || n.tags?.includes("superseded") ||
     n.metadata?.status === "merged_into_canonical";
   const personNotes = peopleError ? undefined : loadedPeople?.filter((n) => !isMerged(n));
   ```
   (Use exactly this rule — tag `merged-stub`/`superseded` or that status. A bare `merged_into` pointer without a marker is deliberately treated as a live person server-side.)
2. **Add `email-to` to that dashboard's link filter** if recipients should count (server now writes `email-to`).
3. `GET /api/people` and the person detail route already hide tombstones server-side; opening a tombstone id returns the canonical person with an additive `mergedFrom` field. `PeopleWorkspace` ignores unknown keys, so no change is required — showing "merged from …" is optional.

### Could add (no backend change needed)

- **Review queue UI:** `GET /api/admin/people/candidates` grouped by key; "This is …" → resolve (optionally "remember this address" = `addIdentity`, "apply to all N" = `applyToKey`); "Not a person" → dismiss. `tombstone-unresolved` rows need a person picker. `open.total` for a badge.
- **Possible matches / merge on a person page:** `/duplicates` filtered to that id; Merge → dry run → confirmation (identities, skipped fields, link counts) → write with `canonicalId` + `expect`. `confirmUnrelated` only behind a second explicit confirmation. Merges refuse agent origin, so this must be a human UI action.
- **Agent recommendations + audit:** `GET /duplicates` returns agents' merge `recommendations` (show beside the pair with the rationale; dismiss → `POST /recommendations/:id/dismiss`); `GET /agent/decisions` lists what agents resolved.
- **"This is me"** on a person note → `PUT /owner`.
- **Backfill control panel:** per-phase dry run → table (`byEvidence`, `queuedByReason`, bulk samples) → write, like "Resolve All Wikilinks".

### Behaviour change on deploy (no flag)

Calendar ingest creates fewer new person notes (an attendee matching an existing alias becomes a review candidate instead of a duplicate), and adds a one-time batch of `attended-by` links to canonical people for meetings in the current window.


---

## 4. Release notes for whoever cuts the combined server release

- **Transcripts:** worker linking changes on the next server restart (version-checked writes, multiple recordings per event). Kill switch: `TRANSCRIPT_LINK_JOURNAL=0`. Hand-made half-linked pairs in the current calendar window are completed once (two history versions each).
- **Suggestions:** see release order above; kill switch `COLLAB_SUGGEST_ENFORCED=false`.
- **Graph linking:** deploys inert (all `MATRIX_LINK_EXISTING`, `MATRIX_STORE_PARTICIPANT_IDS`, `PROTON_LINK_RECIPIENTS`, `TRANSCRIPT_LINK_PEOPLE`, `CLICKUP_LINK_ENABLED`, `PEOPLE_QUEUE_ON_INGEST` off; jobs dry-run by default). The live cleanup follows the staged runbook in `BACKEND-STATUS-GRAPH.md` and is run by the backend agent with the owner, not as part of the deploy.
- The slices create their SQLite tables on first start (`collab_command_receipts`; four `transcript_link_*` tables; `identity_candidates`; people-agent tables). Take the usual online DB backup first. Take the usual online DB backup first.
- Docs still describing the old "read-only below suggest" rule, to be updated by the backend agent after review: `CLAUDE.md`, `docs/mcp-access.md`, `docs/native-auth.md`, `docs/federation.md`.

## 5. Boundary reminders

- Backend has not edited and will not edit: `CollabDoc.tsx`, `CollabEditor.tsx`, `CommentsSidebar.tsx`, `collab/access.ts`, `humanCommands.ts`, `ShareDialog.tsx`, `apps/server/src/app.ts`, manifests/lockfiles (other than the one export line above).
- Backend will not advance main, deploy, restart the server, or rebuild the client. Codex owns the combined release.
- Reply to any question above by editing `COORDINATION.md` in the main checkout or telling the owner; the backend agent re-reads it before integrating.
