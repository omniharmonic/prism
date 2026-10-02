# Backend status — identity + linking ("the graph")

Branch `feat/backend-graph`. Server-side only (`apps/server`). Nothing in this
layer runs, links, or writes to the vault until the server owner asks for it:
every job is a dry run unless told otherwise, and every ingest flag defaults to
off. The one thing that changes on deploy is a bug fix: the people index no
longer lets a merged stub claim an identity (see [What changes on deploy](#what-changes-on-deploy)).

## Why

The UI shows a record under a person only when a typed link exists
(`messages-with`, `email-from`, …). The 2026-10-02 audit of the live vault found
people split across duplicate notes and channels, merged stubs still holding
links and identities, most threads, emails, meetings and tasks with no person
link at all, and 143 different relationship names for a dozen facts. This layer
is the deterministic fix: one identity index, one vocabulary, a backfill job, a
review queue for everything the server will not decide on its own, and an
explicit merge for duplicates.

## What is in the box

| Piece | File | What it does |
|---|---|---|
| Identity index | `src/identity.ts` | Pure. Indexes `person` notes by email, Matrix id, Telegram id/handle, phone, bridge-puppet handle and name/alias/path slug. Folds merged stubs into their canonical person. `match()` is the conservative resolver. |
| People index | `src/worker/people.ts` | The existing per-pass index every ingester uses, now a thin shell over the identity index. Same contract. |
| Vocabulary | `src/relationships.ts` | The canonical relationship names, their endpoint kinds, and the synonym map. |
| Review queue | `src/identity-store.ts`, `src/identity-review.ts` | SQLite `identity_candidates` + resolve / dismiss. |
| Backfill job | `src/people-link-job.ts` | Six phases, dry run by default. |
| Forward linking | `src/people-forward.ts` | Per-pass helper the ingesters call when their flag is on. |
| Duplicates | `src/people-merge.ts` | Detector + explicit merge. |
| Metadata edits | `src/people-metadata.ts` | Merge-patch deltas that never overwrite. |
| Routes | `src/routes/people-admin.ts` | Mounted on the admin router. |
| Health | `src/worker/health.ts` | `people-link` source. |

### How an identity is resolved

1. **Strong keys** — email, Matrix id, Telegram id or handle, phone, bridge handle.
   Exactly one live person across every key supplied → linked. More than one →
   review (`ambiguous-key`). Never a pick.
2. **Name rule**, only when no strong key hit: the cleaned name has at least two
   tokens and equals (slug-folded) a name, alias or path leaf of exactly one live
   person. If a strong key came along that nobody claims, the name is accepted
   only when that person has no key of the same kind on file — a person with a
   known email receiving mail from an unknown address is a review
   (`name-key-mismatch`).
3. A single-token name, or a name two people share, with at least one candidate →
   review (`single-token-name`, `ambiguous-name`).
4. No candidate at all → nothing. This layer never creates a person.

Details that matter:

- **Tombstones.** A person note is a tombstone when it has the tag `merged-stub`
  or `superseded`, `status: merged_into_canonical`, or a non-empty `merged_into` /
  `superseded_by`. A tombstone claims nothing; its keys and names resolve to the
  end of its `merged_into` chain (path, `[[path]]` or id; cycles and dead ends are
  dropped).
- **Bridge puppets.** `@telegram_<id>:host` also yields `telegram:<id>`;
  `@whatsapp_<digits>` / `@signal_<digits>` / `@gmessages_<digits>` yield a phone
  key; `@whatsapp_lid-<id>` and every other `<network>_<id>` (twitter, instagram,
  messenger/meta, discord, linkedin, …) yield a `handle`. Bot localparts (`…bot:`)
  yield nothing extra.
- **Phone** = digits only, 7–15 of them, a leading `+`/`00` dropped. No country
  code is ever inferred.
- **Slugs.** `slugKey` folds the three person-path rules in use (the server's
  Unicode-keeping `rustSanitizePath`, the agent repo's ASCII-fold slugify, and
  `vault/people/{Full Name}`) to one key.
- **The owner** is configuration plus the owner's own person note — see
  `PEOPLE_OWNER_*` below. Nothing is hardcoded.

### Relationship vocabulary

Source → target, as written by the server:

| Relationship | From | To |
|---|---|---|
| `messages-with` | thread | person |
| `email-from` | email | person |
| `email-to` | email | person |
| `attended-by` | meeting / transcript | person |
| `has-transcript` | meeting | transcript |
| `assigned-to` | task | person |
| `belongs-to` | task | project |
| `member-of` | person | organization / project |
| `works-at` | person | organization |
| `references` | any | any |
| `related-to` | any | any |

`member-of` and `works-at` are in the vocabulary and the normalization map; no
phase derives them from metadata yet (see [Limitations](#limitations)).

Synonyms normalized (only when the endpoint kinds fit, in either direction):
`attendee`, `attendees`, `attended`, `has-attendee` → `attended-by`; `from`,
`sender`, `sent-by` → `email-from`; `recipient`, `to`, `sent-to` → `email-to`;
`owner`, `assignee`, `assigned`, `owned-by` → `assigned-to`; `project`,
`in-project`, `part-of` → `belongs-to`; `member`, `has-member` → `member-of`;
`participant`, `participants`, `chat-with` → `messages-with`; `related`,
`relates-to` → `related-to`; `reference`, `refers-to` → `references`.

Left alone on purpose: `wikilink` (the vault derives it from note content and
would re-create it), `transcript-of` (owned by the transcript-linking branch),
and every name not listed above (`mentions`, `promised-to`, …).

**What the UI filters on today.** `VaultMessagesDashboard` reads exactly
`messages-with` and `email-from`; `EventTranscripts` reads `has-transcript`; the
People workspace (`GET /api/people/:id`) lists every relationship in both
directions. So `email-to`, `attended-by`, `assigned-to` and `belongs-to` show in
the People workspace but **not** in the messages dashboard — `email-to` would
need adding to its filter if recipients should appear there.

## Routes

All under `/api/admin/people`, mounted on the existing admin router, so all of
them share its gate:

- **Auth:** server owner only, by email (`OWNER_EMAIL`), via session cookie or
  device token. Vault admins, vault-role owners, members, guests, capability
  links and anonymous callers get `403 {error:"forbidden"}`.
- **CSRF** on every non-GET: `Content-Type: application/json` required (`415`),
  and for anything but a device token a cross-site `Sec-Fetch-Site` or a foreign
  `Origin` is refused (`403 csrf_refused`).
- **Vault:** the owner's active vault (`X-Prism-Vault`).

### Review queue

`GET /candidates?status=open|resolved|dismissed&reason=&relationship=&limit=1..200&after=<cursor>`

```json
{
  "candidates": [{
    "id": "uuid", "vaultId": "primary", "sourceNoteId": "…", "relationship": "email-from",
    "key": {"kind": "email", "value": "…", "hash": "sha256"},
    "display": "name as seen | null", "candidateIds": ["personId", "…"],
    "reason": "ambiguous-key | ambiguous-name | single-token-name | name-key-mismatch",
    "origin": "backfill:emails | ingest:proton | …", "status": "open",
    "resolvedPersonId": null, "decidedBy": null, "createdAt": "…", "updatedAt": "…"
  }],
  "next": "cursor | null",
  "open": {"total": 0, "byReason": {}}
}
```

Oldest first. `400 bad_request` for an unknown status, a limit outside 1–200 or
an over-long cursor.

`POST /candidates/:id/resolve` — body `{personId, addIdentity?: true, applyToKey?: false}`

Links the source note to the chosen person (one links-only PATCH with
`if_updated_at`, skipped when the edge exists). `addIdentity` (default true)
also writes the key onto the person so it never queues again — skipped when
another live person already claims that key. `applyToKey` covers every open
candidate with the same key, up to 50 notes per call. `personId` may be a note
id or path; a tombstone resolves to its canonical person.

```json
{"ok": true, "personId": "…", "resolved": 1, "linked": 1, "alreadyLinked": 0,
 "conflicts": 0, "missing": 0, "errors": 0, "identityAdded": true, "identitySkipped": null}
```

`identitySkipped`: `not_requested`, `already_present`,
`claimed_by_another_person`, `unsupported_kind`, `conflict`. A source that
changed meanwhile is counted in `conflicts` and stays open. Errors: `400
bad_request`, `404 not_found` (candidate), `404 person_not_found`, `409 not_open`,
`503 people_unavailable` / `resolve_failed`. One `action_audit` row
(`admin.people-candidate-resolve`: ids, key kind, 16-hex key hash, counts).

`POST /candidates/:id/dismiss` — body `{applyToKey?: false}` → `{ok, dismissed}`.
No vault call. A dismissed identity is never linked for that note and never
re-queued. `409 not_open`.

### Backfill job

`POST /link` — body

```json
{"dryRun": true, "phases": ["repoint","emails","meetings","threads","tasks","normalize"],
 "maxWrites": 200, "enqueue": false, "useMatrixMembers": false}
```

Every field is optional. `dryRun` is true unless it is exactly `false`.
`phases` defaults to all six, always run in the order above. `maxWrites` is an
integer from 1 to `PEOPLE_LINK_MAX_WRITES_CEILING`; a write run without it uses
`PEOPLE_LINK_MAX_WRITES`; a dry run without it is uncapped. `enqueue` defaults to
false for a dry run and true for a write run. `useMatrixMembers` asks the
homeserver for room membership (paced, budgeted); `409 matrix_not_configured`
without a stored Matrix credential.

→ `202 {job}`. `409 {error:"busy", job}` while a job or a merge is running. `400
bad_request` for a wrong type, an unknown phase or an out-of-range `maxWrites`.

`GET /link` → `{job | null, phases}`. `POST /link/cancel` → `{ok}`; the write in
flight finishes, nothing after it starts.

`job`:

```json
{"id": "uuid", "vaultId": "primary", "dryRun": true, "phases": ["…"], "maxWrites": 0,
 "status": "running | done | error | cancelled", "startedAt": "…", "endedAt": null, "error": null,
 "writes": 0, "capped": false, "queuedNew": 0, "memberLookups": 0, "ownerPersonKnown": true,
 "report": {"emails": {
   "phase": "emails", "status": "pending | running | done | skipped", "scanned": 0,
   "wouldLink": 0, "wouldUnlink": 0, "notesToWrite": 0, "alreadyLinked": 0, "queued": 0,
   "skipped": {"role-sender": 0},
   "linked": 0, "unlinked": 0, "notesWritten": 0, "conflicts": 0, "errors": 0, "oversize": 0, "deferred": 0,
   "sample": {"link": ["noteId"], "review": ["noteId"]}
 }}}
```

`wouldLink`, `wouldUnlink`, `notesToWrite`, `alreadyLinked`, `queued` and
`skipped` are the plan, and are the same in a dry run and a write run with the
same options (a dry run carries earlier phases' planned edits into later ones).
`linked`, `unlinked`, `notesWritten`, `conflicts`, `errors`, `oversize` are what a
write run did. `deferred` counts planned note writes not attempted — over the
cap, or a removal whose addition did not land. `sample` holds up to 20 note ids
per list, nothing else. `normalize` adds `byName` (planned rewrites per name).
A write run records one `action_audit` row (`admin.people-link`, counts only).

Skip reasons: `no-person`, `dismissed`, `already-reviewed`, `oversize`; repoint
`no-canonical`, `stub-to-canonical`, `source-missing`; emails `bulk-label`,
`role-sender`, `role-recipient`, `no-sender`, `too-many-recipients`,
`sent-without-recipient`; meetings `no-attendees`, `role-attendee`,
`owner-unresolved`, `not-a-name`; threads `no-participants`, `large-group`,
`group-names-only`, `group-link-cap`; tasks `owner-unresolved`, `not-a-name`,
`project-unknown`, `project-ambiguous`.

What each phase does:

| Phase | Reads (lean, no content) | Writes |
|---|---|---|
| `repoint` | people + one whole-vault listing (`type`, links) | Links held by a tombstone move to its canonical person. An inbound link is rewritten on the linking note in one PATCH; an outbound link is added to the canonical, then removed from the stub. A `wikilink` stays and the canonical gains a `references` twin. |
| `emails` | `email` notes: `from`, `to`, `labels` | `email-from` for the sender, `email-to` for direct `To` recipients (at most `PEOPLE_LINK_MAX_RECIPIENTS`, else none). Never the owner's addresses, role / no-reply addresses, or mail labelled `BULK`, `AUTOMATED`, `PROMOTIONS`, `CATEGORY_PROMOTIONS`. |
| `meetings` | `meeting` and `transcript` notes: `attendees`, `attendeeEmails` | `attended-by`. Address first, then the name rule. The owner **is** linked when their person note is known — that is what calendar ingest already does. Calendar resource addresses are skipped. |
| `threads` | `message-thread` notes: `participants`, `participantIds`, `matrixRoomId` | `messages-with`. Member source: stored `participantIds`, else the optional Matrix lookup, else display names. Smallest rooms first. Above `PEOPLE_LINK_GROUP_MAX_MEMBERS` (50) the room is skipped; above `PEOPLE_LINK_GROUP_NAME_MAX` (8) only strong-key matches link, at most `PEOPLE_LINK_GROUP_LINK_CAP` (15). Bridge bots and the owner are never linked. |
| `tasks` | `task` notes: `assigned`, `assignee`, `project`; `project` notes | `assigned-to` (CSV, `&`, "and" and `[[wikilink]]` values; an owner alias links to the owner's person note) and `belongs-to` (the one project whose path, slug, name or alias matches exactly). |
| `normalize` | one whole-vault listing (`type`, links) | Synonym → canonical: the canonical link is added, then the synonym removed. |

Safety, for every phase: links-only PATCH with `if_updated_at` (a 409 is
counted, never forced); an existing edge is skipped and a note with nothing new
is not written; a removal is sent only after its addition succeeded; at most two
writes in flight with `PEOPLE_LINK_PACE_MS` between them; the write cap is hard;
a note over the vault's 2 MB history ceiling is skipped (`byteSize` on the
listing when the vault reports it, otherwise the vault's `413`); a listing that
reaches 50,000 notes aborts the job before any write. Re-running converges to
zero writes.

### Duplicates and merge

`GET /duplicates?strength=strong|medium|weak&limit=1..200&offset=0`

```json
{"pairs": [{"a": {"id": "…", "name": "…", "path": "…", "links": 12},
            "b": {"id": "…", "name": "…", "path": "…", "links": 3},
            "strength": "strong", "evidence": ["email", "email-derived-name"],
            "suggestedCanonicalId": "…"}],
 "total": 0, "counts": {"strong": 0, "medium": 0, "weak": 0}, "next": null}
```

Read-only. `evidence` is kinds only — `email`, `matrix`, `telegram`, `phone`,
`handle`, `email-derived-name` (a note named after an address the other claims),
`email-as-name` (strong); `name` (medium); `abbreviated-name` (weak). Strongest
first. Tombstones never appear. `503 people_unavailable`.

`POST /merge` — body `{personIds: [a, b], canonicalId?, dryRun?: true}`

`canonicalId` must be one of the two; without it the server picks: a profile
with a real written name beats an address- or slug-shaped stub, then more
links, more fields, older. Returns `{merge}`:

```json
{"dryRun": true, "canonicalId": "…", "secondaryId": "…", "resumed": false,
 "identities": {"email": 1, "matrix": 1, "alias": 1}, "bodyAppended": true,
 "outbound": 2, "inbound": 4, "alreadyPresent": 1, "notesToWrite": 6,
 "notesWritten": 0, "conflicts": 0, "errors": 0, "tombstoned": false, "complete": false}
```

A write run, in this order:

1. **Canonical** — one CAS write: identities, aliases, organizations and
   projects the secondary has and the canonical lacks (an existing value is never
   replaced), the secondary's body under `## Merged from <path> (<date>)` if it
   has any beyond a heading and the auto-create line, and the secondary's
   outgoing links. If this write fails nothing else is touched.
2. **Every note linking to the secondary** — one links-only CAS write each. A
   conflict is counted and that note keeps its old link.
3. **Secondary**, last — tag `merged-stub`, `merged_into: <canonical path>`,
   `status: merged_into_canonical`, `merged_at`, `merged_by`; its identity keys
   removed (kept under `prism_merged_identities`); its outgoing links removed.

No note is deleted. `complete: false` means some linking notes still point at
the secondary: call the same merge again (`resumed: true`) or run the `repoint`
phase. A completed merge re-run writes nothing. One `action_audit` row per write
merge (`admin.people-merge`: note ids and counts).

Errors: `400 bad_request`, `400 same_person` / `not_a_person` / `non_human`,
`404 not_found`, `409 canonical_is_merged`, `409 secondary_merged_elsewhere`,
`409 conflict` (another merge in flight), `409 busy` (a link job is running),
`503 inventory_limit` / `merge_failed`.

**Undo.** Each write is one history version. To undo a merge: restore the
canonical note to the version before the merge (metadata and body come back),
restore the secondary the same way (its identities and tombstone fields come
back; then remove the `merged-stub` tag — restore does not touch tags), and for
the links re-point them by hand: a version restore brings back content and
metadata only, so the reliable undo for links is the pre-run backup. This is
why the runbook starts with one.

## Flags

All read at server start; restart pm2 after a change.

| Variable | Default | Effect |
|---|---|---|
| `MATRIX_LINK_PEOPLE` | `false` | Existing. Links thread participants and **creates** people in rooms of ≤3 members. Unchanged. |
| `MATRIX_LINK_EXISTING` | `false` | Links thread participants who already have a person note. Creates nobody. |
| `MATRIX_STORE_PARTICIPANT_IDS` | `false` | Adds `participantIds` (Matrix ids, unioned like `participants`) to thread notes on create and append. |
| `PROTON_LINK_PEOPLE` | `false` | Existing. `email-from` for an exact sender-address match. Unchanged. |
| `PROTON_LINK_RECIPIENTS` | `false` | Adds `email-to` for direct recipients who exist as people. When `PROTON_LINK_PEOPLE` is also on, this flag or `PEOPLE_QUEUE_ON_INGEST` additionally lets the name rule try a sender the exact address match missed. |
| `TRANSCRIPT_LINK_PEOPLE` | `false` | New Fathom / Fireflies transcripts get `attended-by` links to existing people. |
| `CLICKUP_LINK_ENABLED` | `false` | ClickUp tasks get `assigned-to` and `belongs-to` to existing notes, on create and update. |
| `PEOPLE_QUEUE_ON_INGEST` | `false` | Forward linkers queue what they could not resolve. |
| `PEOPLE_OWNER_PERSON` | empty | The owner's person note, by path or id. Empty: the one live person claiming `OWNER_EMAIL` / `PEOPLE_OWNER_EMAILS`, if exactly one. |
| `PEOPLE_OWNER_EMAILS` | empty | Extra owner addresses, comma-separated. |
| `PEOPLE_OWNER_ALIASES` | empty | Extra names meaning the owner, comma-separated (the owner note's own names and aliases already count). |
| `PEOPLE_LINK_MAX_WRITES` | `200` | Write cap of a write run that does not pass `maxWrites`. |
| `PEOPLE_LINK_MAX_WRITES_CEILING` | `20000` | Largest `maxWrites` a request may ask for. |
| `PEOPLE_LINK_PACE_MS` | `50` | Pause per writer between writes. |
| `PEOPLE_LINK_GROUP_NAME_MAX` | `8` | Largest room in which display names may link. |
| `PEOPLE_LINK_GROUP_MAX_MEMBERS` | `50` | Rooms above this are skipped. |
| `PEOPLE_LINK_GROUP_LINK_CAP` | `15` | Most links per room of more than 3 members. |
| `PEOPLE_LINK_MEMBER_LOOKUPS` | `300` | Matrix membership lookups per run (`useMatrixMembers`). |
| `PEOPLE_LINK_MEMBER_PACE_MS` | `150` | Pause between lookups. |
| `PEOPLE_LINK_MAX_RECIPIENTS` | `10` | An email with more `To` recipients gets no `email-to` links. |

Calendar ingest is unchanged and has no new flag: it already links attendees.

## What changes on deploy

With every flag at its default, exactly one behaviour changes: `PeopleIndex` —
used by calendar ingest today, and by Gmail / Proton / Matrix linking when those
flags are on — is tombstone-aware and reads more identity fields. Consequences:

- An attendee whose address is also on a merged stub now resolves to the
  canonical person instead of being skipped as ambiguous. Calendar ingest will
  add the missing `attended-by` link the next time it sees that event (one
  write per affected meeting in its window).
- A name that only matches a tombstone no longer blocks or attracts anything; it
  resolves through to the canonical person as a candidate.
- Name candidates are now found through `aliases` and slug folding too. Calendar
  ingest creates a person for an attendee it cannot find; an attendee whose name
  matches an existing person's alias, or the same name under another slug rule,
  is now a candidate (no link, no new note) where it used to be a miss (a new,
  duplicate person note). So calendar ingest creates fewer people.
- An address stored under `contact_emails` now counts as that person's email.
- Nothing else is written. No new table is touched until a route is called.
  `identity_candidates` is created at start (`CREATE TABLE IF NOT EXISTS`).

## Runbook — first cleanup in production

Overseer only. Each step is small and reversible up to the write runs.

1. **Back up.** Run `scripts/backup-parachute.sh` (vault + `prism-server.db`).
   Note the time; this is the rollback point for links.
2. **Deploy with every flag off.** Merge, restart pm2 `prism-server`, confirm
   `GET /acl/workers` is green. Set `PEOPLE_OWNER_PERSON` (and
   `PEOPLE_OWNER_ALIASES` for a first name used on tasks) before the restart if
   the owner has more than one person note claiming their address.
3. **Dry-run each phase, one at a time.**
   `POST /api/admin/people/link {"phases":["repoint"]}` → poll `GET
   /api/admin/people/link` until `status: "done"`. Repeat for `emails`,
   `meetings`, `threads`, `tasks`, `normalize`. Check `ownerPersonKnown: true`.
4. **Review.** For each phase read `wouldLink`, `queued` and `skipped`, and open
   the notes in `sample.link` and `sample.review`. Stop if a sample is wrong.
   Expected order of magnitude is in [Offline estimate](#offline-estimate).
5. **Small capped write run.** `{"dryRun":false,"phases":["repoint"],"maxWrites":25}`.
   Confirm `conflicts: 0`, `errors: 0`, look at a few of the written notes in the
   People workspace, and confirm `GET /api/admin/people/candidates` looks sane.
6. **Full run, phase by phase.** `{"dryRun":false,"phases":["repoint"],"maxWrites":2000}`,
   then `emails`, `meetings`, `threads`, `tasks`, and `normalize` last. Re-run a
   phase until `capped: false` and `wouldLink: 0`. Run them when the local model
   is idle: each written thread or email is a note update.
7. **Work the queue.** `GET /candidates`, then resolve or dismiss. Use
   `applyToKey` for a sender that appears on many notes.
8. **Duplicates.** `GET /duplicates?strength=strong`, then `POST /merge` per pair —
   dry run first, read the report, then `dryRun:false`. Leave `weak` pairs for a
   human look.
9. **Forward flags, one at a time**, a day apart, watching `GET /acl/workers` and
   the queue depth: `MATRIX_STORE_PARTICIPANT_IDS`, `TRANSCRIPT_LINK_PEOPLE`,
   `CLICKUP_LINK_ENABLED`, `PROTON_LINK_PEOPLE` + `PROTON_LINK_RECIPIENTS`,
   `MATRIX_LINK_EXISTING`, and `PEOPLE_QUEUE_ON_INGEST` last. Leave
   `MATRIX_LINK_PEOPLE` off.

**Rollback.** A flag: set it back and restart pm2; nothing it wrote is removed.
A dry run: nothing to roll back. A write run: every write is a links-only PATCH,
so the reverse is a links PATCH — but there is no automatic inverse; for a bad
run restore the vault from the step-1 backup, together with `prism-server.db`.
The queue: `DELETE FROM identity_candidates` is safe (the next run refills it).
Code: revert the branch; the `identity_candidates` table can stay.

## Offline estimate

Computed 2026-10-02 by running the job in dry-run mode over the audit dumps
(1,036 people, 1,325 threads, 3,467 emails, 1,816 meetings, 1,750 tasks, 151
projects and organizations), with no Matrix membership lookup. Counts only.

| Phase | Links added | Links removed | Notes written | Already linked | Queued for review |
|---|---|---|---|---|---|
| repoint | 400 | 411 | 310 | 148 | 0 |
| emails | 206 | 0 | 174 | 313 | 148 |
| meetings | 3,810 | 0 | 1,062 | 398 | 85 |
| threads | 215 | 0 | 149 | 62 | 93 |
| tasks | 1,446 | 0 | 969 | 20 | 44 |
| normalize | 57 | 125 | 104 | 67 | 0 |
| **total** | **6,134** | **536** | **2,768** | | **370** |

Largest skips: emails — 1,739 bulk-labelled, 862 role senders, 266 unknown
senders; meetings — 4,126 attendee entries with no matching person; threads —
1,919 participant names with no match, 158 rooms over 50 participants, 138
name-only rooms over 8; tasks — 193 project values matching no project note.
136 person notes are tombstones (8 with no resolvable canonical). Duplicate
detector: 21 pairs among live people (12 strong, 7 medium, 2 weak).

The dumps cover only these note kinds, so `repoint` and `normalize` are lower
bounds (17 linking notes were outside the dumps). Threads would rise with
`useMatrixMembers` or stored `participantIds`.

## Limitations

- **Queue holds only identities with a candidate.** An unknown sender with no
  matching person is counted `no-person` and not queued; creating people is out
  of scope here.
- **Proton recipients link by address only.** The Proton note stores `to` as
  bare addresses, so the name rule has nothing to work with.
- **Legacy threads have display names, not ids.** Until `participantIds` are
  stored or `useMatrixMembers` is used, threads link by name, and name-only rooms
  over 8 participants are skipped.
- **`member-of` / `works-at` are not derived.** `organizations` on person notes
  is free text in several shapes; only the synonym normalization writes these.
- **No re-link pass.** A person added later does not retroactively link old
  notes; run the backfill job again. A tree-change-driven pass was left out — it
  would need the same lean listings on every person edit.
- **Matrix forward linking does not queue.** It links exact matches only;
  the `threads` backfill phase is what queues.
- **Fireflies forward linking** shares the Fathom code path and is covered by
  the Fathom test only.
- **Two whole-vault lean listings** when `repoint` and `normalize` run together
  (ids, tags, `type`, links — no content). On a 14k-note vault that is the same
  cost as the existing wikilinks job's listing, twice.
- **A merge reads both person notes with content** and, when notes link to the
  secondary, takes one whole-vault lean listing for their versions.
- **A live collaborative session** on the canonical person note during a merge
  is not merged through Yjs; the reconciler folds the vault write in.
- **Paging.** The vault client has no offset parameter; listings are per tag and
  the job aborts at 50,000 rows rather than page.
- **Dry-run samples are ids.** There is no route that expands them; open them
  in the app.

## What the frontend could add

- **Hide tombstones in the People list.** Today it does not: `GET /api/people`
  filters on `isPerson` only, and `VaultMessagesDashboard` builds its people
  list from every `person`-tagged note, so merged stubs appear as people. The
  server could filter them in `routes/people.ts` (not done here — that file
  belongs to the People surface), or the client can drop notes tagged
  `merged-stub` / `superseded` or with `metadata.merged_into`.
- **"Possible matches" on a person.** `GET /duplicates` filtered to pairs
  containing that person id, with a Merge button → `POST /merge` dry run →
  confirmation showing the report → `dryRun:false`.
- **Review queue.** A list from `GET /candidates` grouped by key, each row
  showing the source note, the key, the candidates (names from the people list)
  and the reason, with "This is …" (`resolve`, `applyToKey` as "apply to all N")
  and "Not a person / ignore" (`dismiss`). The `open.total` number makes a badge.
- **Backfill control.** A dry-run → review → write flow like the existing
  "Resolve All Wikilinks" command, per phase, showing the per-phase table.
- **Recipients in the messages dashboard.** Add `email-to` to the
  `VaultMessagesDashboard` relationship filter if sent mail should appear under
  the recipient.
- **Health.** `GET /acl/workers` now includes `people-link` with
  `detail.openCandidates` and the last job; the ingest-health card can show it.
