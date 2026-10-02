# Backend status: calendar/transcript review and reconciliation

Branch `feat/backend-transcripts`, worktree `.worktrees/backend-transcripts`, based on `6069ccd`. Implements §2 of [BACKEND-HANDOFF.md](BACKEND-HANDOFF.md). **Not merged, not deployed.** Evidence is fixture-only: the server test suite against the in-memory fake vault. Nothing here was run against a real vault, real `gog`, a browser or the frontend prototype `11a38b6`.

| | Tests | Pass | Fail |
| --- | --- | --- | --- |
| Baseline `6069ccd` | 1,440 | 1,440 | 0 |
| This branch (after the review fixes) | 1,490 | 1,490 | 0 |

`npm run typecheck -w @prism/server` is clean. New tests: `test/transcript-links.test.ts` (27), `test/transcripts-route.test.ts` (18), five added to `test/transcript-match.test.ts`.

## What exists now

| File | Role |
| --- | --- |
| `apps/server/src/transcript-links-store.ts` | The decision journal. Creates its four tables at import (`CREATE TABLE IF NOT EXISTS`); `db.ts` is untouched. |
| `apps/server/src/transcript-links.ts` | Per-transcript lock, manual decisions, note convergence, the worker gate. |
| `apps/server/src/routes/transcripts.ts` | The two HTTP routes. Mounted in `routes/api.ts` before the owner passthrough. |
| `apps/server/src/worker/transcript-match.ts` | `matchTranscripts` (multiple recordings), exported `score`, `meetingFromNote`. |
| `apps/server/src/worker/calendar.ts` | Optional `links` gate on a pass, supplied by the real runners; wider deletion protection. |

### Data model

Every row is keyed by `vault_id` **and** `vault_identity` (`JSON.stringify([entry.url, entry.vault])`). A registry entry that is replaced therefore starts at revision 0 with no receipts.

- `transcript_link_state` — one row per transcript: `revision`, desired `meeting_id` (nullable), `origin` (`manual` | `auto`). `decisionRevision` in the API is this revision, 0 when there is no row.
- `transcript_link_suppressions` — a manual unlink of (transcript, meeting), with the meeting's calendar event id. A manual link of the same pair removes it.
- `transcript_link_decisions` — the journal: actor (`user:<email>` | `worker`), request id, body hash, action, reason, revision, `pending | applied | superseded`, last completed step. `UNIQUE(vault_id, vault_identity, actor, request_id)`.

- `transcript_link_cleanups` — (transcript, meeting) detaches owed by a superseded or abandoned decision.

Accepting a decision is one SQLite transaction: record the detaches owed by any pending row it supersedes, supersede those rows, insert the pending row, bump the state, add or remove the suppression.

**Ids are canonical ids only.** The vault also resolves `/notes/:x` by path and title. An id must match `[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}` before any vault call, and a note the vault returns under a different id than the one asked for is treated as missing. The lock, the journal and every id written into another note are therefore keyed on the real id. Ids found in editable metadata (`meetingNoteId`, `transcriptNoteId`) go through the same check and count as dangling when they fail it.

**Superseded decisions are repaired.** When a newer decision supersedes a pending one, every meeting the old one may have written that is not the new desired meeting is owed a detach. The superseding decision performs the detaches its actor may edit; any it may not are left without an error (so nothing about an unviewable meeting is disclosed) and the worker sweep completes them. The defence for the sweep acting without a user: the removal was authorized when the superseded decision was accepted, the journal says the transcript is not that meeting's, and a cleanup only ever removes that one transcript's claim. A cleanup is dropped unexecuted if a later decision makes that meeting the desired one again.

**Vault calls under the lock are bounded** (`TRANSCRIPT_LINK_VAULT_TIMEOUT_MS`, default 15 s). On timeout the decision stays pending and the lock is released. This is a race, not an `AbortSignal`: the underlying request is not cancelled (that needs a change to the shared vault client), so a write can land late; it is still a CAS write of the desired state.

**Retention.** `applied` and `superseded` decision rows older than `TRANSCRIPT_LINK_JOURNAL_RETENTION_DAYS` (90) are pruned at most daily from the worker sweep. State, suppressions, cleanups and pending rows are never pruned. A replay of a pruned request id is treated as a new request (and will be `stale`).

### Note projection

| Note | Written keys |
| --- | --- |
| Meeting | `metadata.transcriptNoteIds` (plural, the union), legacy `metadata.transcriptNoteId` (set only when empty or dangling), `transcriptLinkOrigin` (`manual` or `calendar-match-v1`) and `transcriptLinkEvidence` when the singular is set, typed link `has-transcript` → transcript |
| Transcript | `metadata.meetingNoteId` |

Order: link or move writes the new meeting, then the transcript, then the old meeting. Unlink writes the transcript, then the meeting. Each step re-authorizes, re-reads, skips when already as desired, and otherwise PATCHes with `if_updated_at` set to the value just read. One re-read and retry on a CAS conflict. Content, tags and other metadata are never written; no note is ever deleted. When the old meeting's singular pointed at the moved transcript it is re-pointed at another remaining recording, else cleared.

## HTTP contract as implemented

Both routes need a signed-in user (session cookie or `pd_` device token). Both answer `Cache-Control: private, no-store`. Both are rate limited per user: `TRANSCRIPT_REVIEW_PER_MINUTE` (60) and `TRANSCRIPT_DECISIONS_PER_MINUTE` (60) → `429 {error:"rate_limited", retryAfter}` with `Retry-After`. The existing `/api` middleware still applies, so a mismatched `X-Prism-Write-Actor` is `409 write_actor_changed` before either handler runs.

### `GET /api/transcripts/events/:meetingId?query=`

`200`:

```
{ meeting: {id, eventId, title, updatedAt},
  linked:     [{id, title, start?, updatedAt, decisionRevision, canManage}],
  candidates: [{id, title, start?, updatedAt, decisionRevision, canManage, score, evidence: string[], linkedElsewhere}],
  limited: boolean, canManage: boolean }
```

- `meeting.eventId` is `""` for a hand-made meeting.
- The review reads ONE listing of the vault's newest 5,000 transcripts: no content, only the nine metadata keys it uses (`include_metadata`). Identical in-flight requests share it, it is reused for `TRANSCRIPT_LIST_TTL_MS` (5 s), and any note write by this module drops it. No candidate is fetched individually.
- `linked` is the union of the meeting's singular, plural and typed-link claims, the journal, and any transcript in the scan whose backpointer names this meeting — independent of the candidate cap. Items the actor cannot view, and ids that no longer exist or are aliases, are dropped silently. At most 100 are returned.
- `candidates` are view-filtered **before** scoring and anchored on the meeting by the matcher itself (exact event id, or a date within a day), not on recency, so an old meeting still finds its recordings. Without `query` only positive scores are listed, capped at 200. With `query` (case-insensitive substring of title or path, trimmed, first 200 characters) every match is listed even at score 0, capped at 50.
- `limited` is true when the candidate cap or the linked cap truncated. A full 5,000-row scan also sets it, but only for an actor whose role already sees the whole vault (owner/admin); for everyone else it is computed from viewable rows only, so it never reveals how many transcripts exist.
- `linkedElsewhere` is a boolean only. The other meeting's id and title never appear.
- `canManage` (top level) = edit on the meeting. Item `canManage` = edit on that transcript, the note is tagged `transcript`, and for a `linkedElsewhere` candidate also view + edit on the meeting it is currently linked to.
- `start` is present only when the transcript has a real `metadata.start`. A date-only record omits it.

| Status | Body | When |
| --- | --- | --- |
| 401 | `unauthorized` | Anonymous or capability link |
| 409 | `vault_unavailable` | `X-Prism-Vault` does not name the vault the actor resolved to, or the vault left the registry |
| 409 | `write_actor_changed` | Existing middleware |
| 429 | `rate_limited` | Per-user limit |
| 404 | `not_found` | Missing, not tagged `meeting`, not viewable, a malformed id, or a path/title alias — identical bodies |
| 503 | `transcripts_unavailable` | Vault read failed |

### `POST /api/transcripts/events/:meetingId/decisions`

Body, exactly these keys: `{transcriptId, action: "link"|"unlink", reason, meetingUpdatedAt, transcriptUpdatedAt, expectedRevision, requestId}`. `reason` is non-blank and at most 500 characters. `expectedRevision` is a non-negative integer. `requestId` is 1–200 characters of `[A-Za-z0-9._:-]`.

`200 {status: "applied" | "pending", revision}`.

| Status | Body | When |
| --- | --- | --- |
| 401 | `unauthorized` | Anonymous or capability link |
| 415 | `unsupported_media_type` | Content type is not `application/json` |
| 429 | `rate_limited` | Per-user limit |
| 400 | `bad_request` | Unparseable, extra or missing key, wrong type, blank or over-long reason, or a `transcriptId` outside the id allowlist |
| 404 | `not_found` | Meeting or transcript missing or unviewable; either id is a path/title alias; `:meetingId` is malformed; meeting not tagged `meeting`; target not tagged `transcript`; on a move, the old meeting is unviewable; or the session no longer resolves to the same user |
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
- A transcript is unavailable to the worker when it has a backpointer, some meeting claims it, the journal links it anywhere, or this pair is suppressed. The pass loads journal state and suppressions once; the gate re-checks them and the fresh backpointer inside the per-transcript lock.
- The worker never moves a linked transcript, manual or automatic. A manual unlink bars only that (transcript, meeting) pair and the same calendar event; the transcript may still be auto-linked to a different meeting.
- A half-written legacy pair (one direction only, no journal state) is completed only when the matcher independently scores the pair at 6 or more. A meeting's own claim is not authority to write a transcript.
- A live pass first re-drives automatic decisions left pending, performs owed cleanups and prunes old receipts. Manual pending decisions are re-driven only by the original actor's identical request.
- A pending worker decision is abandoned (superseded, its automatic state cleared, its meeting owed a detach) when its meeting or transcript no longer exists, or when the transcript's backpointer was set to another meeting outside the journal. It is never retried forever and never overwrites that edit.
- Shadow mode reads the journal and writes nothing.
- Deletion protection: a meeting is treated as having a transcript when it has a singular or plural id, a typed link, a journal row, or any transcript's backpointer. The backpointer check reuses the pass's own transcript listing (one per pass). If that listing fails the note is not deleted.

## Limitations

1. **Legacy desktop writers bypass the journal.** The Rust calendar/transcript code writes `transcriptNoteId` / `meetingNoteId` directly. The server tolerates this (the review unions every form; a backpointer counts as a link; a sweep abandons rather than overwrites) but cannot stop it, and a desktop running its own calendar sync could re-link a manually unlinked pair.
2. **Editable transcript metadata can drive a worker link.** Anyone who can edit a transcript can set its `calendarEventId`; the worker then links it to that event's meeting, including one that already has recordings, without that user holding edit on the meeting. The link is visible in the review and can be unlinked (which then suppresses the pair).
3. **One-time completion of half-written pairs costs history.** Each legacy half-pair the matcher agrees with is completed once, and each completion writes up to two notes, so up to two history versions per pair on the first gated pass.
4. **The journal is committed before the notes.** Between acceptance and convergence (or supersession) the review can show a link that exists only in the journal, and `decisionRevision` is already bumped.
5. **Owed cleanups wait for a live calendar pass.** A detach the superseding actor could not perform is completed by the worker sweep, which only runs with calendar sync live (not in shadow, not when calendar is off, not with `TRANSCRIPT_LINK_JOURNAL=0`). Until then that meeting still lists the transcript.
6. **The scan is bounded at the newest 5,000 transcripts** by creation time; older ones are invisible to candidates, `query` and backpointer discovery. `query` is a title/path substring, not full-text. The 5,000-row lean listing is the cost centre; it is cached, coalesced and rate limited but not paged.
7. **The rate limit and the list cache are in-process.** A second server process would have its own; so would the per-transcript lock.
8. **Timeouts do not cancel the request** (see above).
9. **Registry removal leaves rows behind.** They are inert under a different identity. Re-adding the same id with the same URL and vault name makes the old journal current again.
10. **An in-flight decision caught by a registry replacement** may have written one note of the old vault before it is refused; its row stays pending under the old identity.
11. **A manual decision whose transcript is deleted** after journaling stays pending.
12. **Not validated:** real vault behaviour for `include_links=true` on single-note reads, `include_metadata` on a tag-filtered list, and alias resolution (the fake vault now resolves by path to prove the id check); real `gog`; the prototype UI; concurrent human editors.

## What prototype `11a38b6` needs

The shapes, the transport (`managementRequest('/api', …)`), the `canManage` and `linkedElsewhere` semantics and the pending retry all match. Read-only review of the prototype found these gaps; none was changed here:

1. **`409 superseded` during a pending retry.** The panel keeps its "Retry pending decision" state and shows the generic reload message. The request can never succeed; the panel should drop the pending request and reload when `error === "superseded"`.
2. **`404` after losing all access** falls into the generic "could not be confirmed" message. Only `403` gets the permission copy.
3. **`422 request_reused`** also gets the generic message. It should not occur with the current panel, which mints a new id whenever the payload changes.
4. **`start` is optional and absent for date-only recordings.** The panel should not assume a time.
5. **`409` has four causes** (`stale`, `superseded`, `vault_unavailable`, `write_actor_changed`). The panel's single "changed in another window" message is accurate only for the first.
6. **`429 rate_limited`** (with `Retry-After`) is new and falls into the generic message.
7. After an applied decision the meeting's `updatedAt` changes, so the next decision needs the refreshed review. The panel already invalidates `["calendar"]`, which covers its own review query.
