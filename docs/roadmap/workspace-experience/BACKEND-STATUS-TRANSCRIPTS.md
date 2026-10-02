# Backend status: calendar/transcript review and reconciliation

Branch `feat/backend-transcripts`, worktree `.worktrees/backend-transcripts`, based on `6069ccd`. Implements §2 of [BACKEND-HANDOFF.md](BACKEND-HANDOFF.md). **Not merged, not deployed.** Evidence is fixture-only: the server test suite against the in-memory fake vault. Nothing here was run against a real vault, real `gog`, a browser or the frontend prototype `11a38b6`.

| | Tests | Pass | Fail |
| --- | --- | --- | --- |
| Baseline `6069ccd` | 1,440 | 1,440 | 0 |
| This branch | 1,476 | 1,476 | 0 |

`npm run typecheck -w @prism/server` is clean. New tests: `test/transcript-links.test.ts` (18), `test/transcripts-route.test.ts` (13), five added to `test/transcript-match.test.ts`.

## What exists now

| File | Role |
| --- | --- |
| `apps/server/src/transcript-links-store.ts` | The decision journal. Creates its three tables at import (`CREATE TABLE IF NOT EXISTS`); `db.ts` is untouched. |
| `apps/server/src/transcript-links.ts` | Per-transcript lock, manual decisions, note convergence, the worker gate. |
| `apps/server/src/routes/transcripts.ts` | The two HTTP routes. Mounted in `routes/api.ts` before the owner passthrough. |
| `apps/server/src/worker/transcript-match.ts` | `matchTranscripts` (multiple recordings), exported `score`, `meetingFromNote`. |
| `apps/server/src/worker/calendar.ts` | Optional `links` gate on a pass, supplied by the real runners; wider deletion protection. |

### Data model

Every row is keyed by `vault_id` **and** `vault_identity` (`JSON.stringify([entry.url, entry.vault])`). A registry entry that is replaced therefore starts at revision 0 with no receipts.

- `transcript_link_state` — one row per transcript: `revision`, desired `meeting_id` (nullable), `origin` (`manual` | `auto`). `decisionRevision` in the API is this revision, 0 when there is no row.
- `transcript_link_suppressions` — a manual unlink of (transcript, meeting), with the meeting's calendar event id. A manual link of the same pair removes it.
- `transcript_link_decisions` — the journal: actor (`user:<email>` | `worker`), request id, body hash, action, reason, revision, `pending | applied | superseded`, last completed step. `UNIQUE(vault_id, vault_identity, actor, request_id)`.

Accepting a decision is one SQLite transaction: supersede older pending rows for the transcript, insert the pending row, bump the state, add or remove the suppression.

### Note projection

| Note | Written keys |
| --- | --- |
| Meeting | `metadata.transcriptNoteIds` (plural, the union), legacy `metadata.transcriptNoteId` (set only when empty or dangling), `transcriptLinkOrigin` (`manual` or `calendar-match-v1`) and `transcriptLinkEvidence` when the singular is set, typed link `has-transcript` → transcript |
| Transcript | `metadata.meetingNoteId` |

Order: link or move writes the new meeting, then the transcript, then the old meeting. Unlink writes the transcript, then the meeting. Each step re-authorizes, re-reads, skips when already as desired, and otherwise PATCHes with `if_updated_at` set to the value just read. One re-read and retry on a CAS conflict. Content, tags and other metadata are never written; no note is ever deleted. When the old meeting's singular pointed at the moved transcript it is re-pointed at another remaining recording, else cleared.

## HTTP contract as implemented

Both routes need a signed-in user (session cookie or `pd_` device token). Both answer `Cache-Control: private, no-store`. The existing `/api` middleware still applies, so a mismatched `X-Prism-Write-Actor` is `409 write_actor_changed` before either handler runs.

### `GET /api/transcripts/events/:meetingId?query=`

`200`:

```
{ meeting: {id, eventId, title, updatedAt},
  linked:     [{id, title, start?, updatedAt, decisionRevision, canManage}],
  candidates: [{id, title, start?, updatedAt, decisionRevision, canManage, score, evidence: string[], linkedElsewhere}],
  limited: boolean, canManage: boolean }
```

- `meeting.eventId` is `""` for a hand-made meeting.
- `linked` is the union of the meeting's singular, plural and typed-link claims, the journal, and any transcript in the scan window whose backpointer names this meeting. Items the actor cannot view, and ids that no longer exist, are dropped silently.
- `candidates` come from the newest 200 transcripts, view-filtered **before** scoring. Without `query` only transcripts with a positive score are listed. With `query` (case-insensitive substring of title or path, trimmed, first 200 characters) the scan widens to 2,000 transcripts, every match is listed even at score 0, and the list is capped at 50.
- `limited` is true when a scan window was full, the candidate cap truncated, or more than 100 linked ids exist.
- `linkedElsewhere` is a boolean only. The other meeting's id and title never appear.
- `canManage` (top level) = edit on the meeting. Item `canManage` = edit on that transcript, the note is tagged `transcript`, and for a `linkedElsewhere` candidate also view + edit on the meeting it is currently linked to.
- `start` is present only when the transcript has a real `metadata.start`. A date-only record omits it.

| Status | Body | When |
| --- | --- | --- |
| 401 | `unauthorized` | Anonymous or capability link |
| 409 | `vault_unavailable` | `X-Prism-Vault` does not name the vault the actor resolved to, or the vault left the registry |
| 409 | `write_actor_changed` | Existing middleware |
| 404 | `not_found` | Missing, not tagged `meeting`, or not viewable — identical bodies |
| 503 | `transcripts_unavailable` | Vault read failed |

### `POST /api/transcripts/events/:meetingId/decisions`

Body, exactly these keys: `{transcriptId, action: "link"|"unlink", reason, meetingUpdatedAt, transcriptUpdatedAt, expectedRevision, requestId}`. `reason` is non-blank and at most 500 characters. `expectedRevision` is a non-negative integer. `requestId` is 1–200 characters of `[A-Za-z0-9._:-]`.

`200 {status: "applied" | "pending", revision}`.

| Status | Body | When |
| --- | --- | --- |
| 401 | `unauthorized` | Anonymous or capability link |
| 415 | `unsupported_media_type` | Content type is not `application/json` |
| 400 | `bad_request` | Unparseable, extra or missing key, wrong type, blank or over-long reason |
| 404 | `not_found` | Meeting or transcript missing or unviewable; meeting not tagged `meeting`; target not tagged `transcript`; on a move, the old meeting is unviewable; or the session no longer resolves to the same user |
| 403 | `forbidden` | Viewable but not editable: meeting, transcript, or the old meeting of a move |
| 409 | `stale` | `expectedRevision`, `meetingUpdatedAt` or `transcriptUpdatedAt` differs from the current value; or an unlink of a pair that is not linked. Nothing is journaled |
| 409 | `superseded` | This request id's decision was pending and a newer decision for the transcript replaced it |
| 409 | `vault_unavailable` | Header mismatch, or the registry identity changed during the request |
| 409 | `write_actor_changed` | Existing middleware |
| 422 | `request_reused` | The request id was already used by this actor with a different body |
| 503 | `transcripts_unavailable` | Vault failure before anything was journaled |

Behaviour worth knowing:

- **Order of checks on a first attempt:** access (404/403), then staleness (409), then journal. A stale request leaves no trace.
- **Replay of an applied request:** returns `applied` with the original revision and touches no note.
- **Replay of a pending request:** the client's `meetingUpdatedAt` / `transcriptUpdatedAt` are **not** compared again (the server's own partial writes moved them). Every step re-authorizes the current actor instead. This is what makes the prototype's byte-identical retry work.
- **`pending` is a 200.** It means the decision is journaled and at least one note write did not complete. A refusal during convergence (403/404/409) also leaves the row pending.
- A move is a `link` whose transcript is currently linked elsewhere. There is no separate action and no old-meeting `updatedAt` in the body; the old meeting is CAS-written from a fresh read.
- Manual link to a cancelled or hand-made meeting is allowed.

## Worker behaviour

`runCalendarOnce` and `runCalendarRange` pass the gate; a direct `syncCalendarWindow` call without `links` keeps the legacy single-recording path (existing tests rely on it). `TRANSCRIPT_LINK_JOURNAL=0` makes the runners use the legacy path again.

- Every available recording carrying the occurrence's exact event id links. Fuzzy matching is single-winner with the existing margins and only runs for a meeting with no recording.
- A transcript is unavailable to the worker when it has a backpointer, some meeting claims it, it has any journal state, or the pair is suppressed. The gate re-checks journal state, suppression and the fresh backpointer inside the per-transcript lock.
- The worker never moves a transcript and never acts on one with a manual decision, including a manually unlinked one.
- A half-written legacy pair (one direction only, no journal state) is completed only when the matcher independently scores the pair at 6 or more. A meeting's own claim is not authority to write a transcript.
- A live pass first re-drives automatic decisions left pending. Manual pending decisions are re-driven only by the original actor's identical request.
- Shadow mode reads the journal and writes nothing.
- Deletion protection: a meeting is treated as having a transcript when it has a singular or plural id, a typed link, a journal row, or any transcript's backpointer. If the transcript listing fails the note is not deleted.

## Limitations

1. **Legacy desktop writers bypass the journal.** The Rust calendar/transcript code writes `transcriptNoteId` / `meetingNoteId` directly. The server tolerates this (the review unions every form; a backpointer counts as a link) but cannot stop it, and a desktop running its own calendar sync could re-link a manually unlinked pair.
2. **A superseded half-applied move can leave a stale claim.** If a move wrote the new meeting, stalled, and was superseded, a meeting may still list the transcript. It shows as linked in that meeting's review and can be unlinked there. Nothing cleans it automatically.
3. **A manually unlinked transcript is never auto-linked again,** to any meeting. This is deliberate and conservative; linking it elsewhere is a manual action.
4. **Candidate window is recency-bounded.** A recording older than the newest 200 is only reachable through `query`, and `query` only searches the newest 2,000 by title or path. It is not full-text.
5. **No rate limit** on either route beyond what `/api` already has, and **no pruning** of the journal.
6. **Registry removal leaves rows behind.** They are inert under a different identity. Re-adding the same id with the same URL and vault name makes the old journal current again.
7. **An in-flight decision caught by a registry replacement** may have written one note of the old vault before it is refused; its row stays pending under the old identity.
8. **A decision whose transcript is deleted** after journaling stays pending.
9. **Not validated:** real vault link hydration on single-note reads (`include_links=true` in both directions), real `gog`, the prototype UI, concurrent human editors, or two server processes (the lock is in-process).

## What prototype `11a38b6` needs

The shapes, the transport (`managementRequest('/api', …)`), the `canManage` and `linkedElsewhere` semantics and the pending retry all match. Read-only review of the prototype found these gaps; none was changed here:

1. **`409 superseded` during a pending retry.** The panel keeps its "Retry pending decision" state and shows the generic reload message. The request can never succeed; the panel should drop the pending request and reload when `error === "superseded"`.
2. **`404` after losing all access** falls into the generic "could not be confirmed" message. Only `403` gets the permission copy.
3. **`422 request_reused`** also gets the generic message. It should not occur with the current panel, which mints a new id whenever the payload changes.
4. **`start` is optional and absent for date-only recordings.** The panel should not assume a time.
5. **`409` has four causes** (`stale`, `superseded`, `vault_unavailable`, `write_actor_changed`). The panel's single "changed in another window" message is accurate only for the first.
6. After an applied decision the meeting's `updatedAt` changes, so the next decision needs the refreshed review. The panel already invalidates `["calendar"]`, which covers its own review query.
