# Backend status — identity + linking ("the graph")

Branch `feat/backend-graph`. Server-side only (`apps/server`). Every job is a
dry run unless told otherwise and every ingest flag defaults to off. What
changes on deploy with all flags off is listed under
[What changes on deploy](#what-changes-on-deploy).

This revision (2026-10-02, third pass) folds in the independent review
(C1, M7, H1–H4, M1–M6, the lows), the owner's six decisions, and the re-review
(H-1, H-2, M-1 … M-6, the lows).

## Why

The UI shows a record under a person only when a typed link exists. The
2026-10-02 audit found people split across duplicate notes and channels, merged
stubs still holding links and identities, most threads, emails, meetings and
tasks with no person link, and 143 relationship names for a dozen facts. This
layer is the deterministic fix: one identity index, one vocabulary, a backfill
job, a review queue for everything the server will not decide alone, and an
explicit merge for duplicates.

## What is in the box

| Piece | File | What it does |
|---|---|---|
| Identity index | `src/identity.ts` | Pure. Indexes `person` notes by email, Matrix id, Telegram id/handle, international phone, bridge handle and name/alias/path slug. `match()` is the conservative resolver. |
| People index | `src/worker/people.ts` | The per-pass index every ingester shares. Pinned against its pre-layer behaviour by `test/people-parity.test.ts`. |
| Vocabulary | `src/relationships.ts` | Canonical relationship names, their endpoint kinds, the synonym map. |
| Review queue | `src/identity-store.ts`, `src/identity-review.ts` | SQLite `identity_candidates` + resolve / dismiss. |
| Backfill job | `src/people-link-job.ts` | Eight phases, dry run by default. |
| Forward linking | `src/people-forward.ts` | Per-pass helpers the ingesters call when their flag is on. |
| Duplicates | `src/people-merge.ts` | Detector + explicit merge. |
| Metadata edits | `src/people-metadata.ts` | Append-only merge-patch builders. |
| Owner identity | `src/people-owner.ts` | Who "me" is: stored settings, else environment. |
| Lock / cache | `src/people-lock.ts`, `src/people-cache.ts` | One writer at a time; a 60 s shared people listing. |
| Routes | `src/routes/people-admin.ts` | Mounted on the admin router. |
| Health | `src/worker/health.ts` | `people-link` source. |

### How an identity is resolved (`IdentityIndex.match`)

1. **Strong keys** — email, Matrix id, Telegram id or `@handle`, phone with a
   country code, bridge handle. Exactly one live person across every key supplied
   → linked. More than one → review (`ambiguous-key`). Never a pick.
2. **Claimed keys.** A key held only by a non-human note (tag `bot`,
   `non-human`, `organization`, or `type: bot|organization`) or by a tombstone
   whose target cannot be found is *claimed*: nothing links to it, nothing is
   queued, and no ingester may create a new person for it.
3. **Names are weak.** A display name is free text its sender controls. A
   unique full-name or alias match is a **review item** (`name-only`) by default.
   It links only when the caller passes `allowName` — the backfill job does that
   for meeting attendee lists and task assignee strings when the run was started
   with `allowNameLinks: true`, and never for email `From` names or chat display
   names. Even then: at least two tokens, exactly one live person answers to it,
   the name is not generic, and no unknown strong key of a kind that person
   already has rode along (`name-key-mismatch`).
4. Single-token and shared names with a candidate → review. No candidate →
   nothing. This layer never creates a person.

Details:

- **Tombstones — precisely.** A person note is a tombstone when it has the tag
  `merged-stub` or `superseded`, or `status: merged_into_canonical`. Nothing
  else. A live note that merely carries a `merged_into` / `mergedInto` /
  `superseded_by` pointer is **still a person** (listed, linked, indexed); the
  job reports such notes as `pointerWithoutMarker`. The People directory hides
  exactly what `isTombstone` and `isNonHumanPerson` say — one rule, two callers.
- **Following a tombstone.** On every ingest path the pointer is followed only
  when it is a note id or a full path (`[[…]]` accepted). A bare leaf or a name
  is **not** followed there: the stub is a dead end and its keys are claimed.
  Only the reviewed backfill job (`refByName`) also resolves a bare leaf or the
  exact name of one other live person. Chains are followed; cycles and dead ends
  resolve to nothing. New pointers are written as the note **id**.
- **Non-human.** Tag `bot`, `non-human` or `organization`, or `metadata.type`
  `bot` / `organization`. A `type: document` person note is still a person.
- **A display name is never a key.** An address-shaped display name
  (`alex@example.org` as a chat nickname) is free text; only the explicit
  `email` / `matrixId` / `telegram` / `phone` fields of a query are keys.
- **The owner by name.** The owner note's own multi-word name
  (`owner-full-name`), or a name **explicitly configured** as an alias
  (`owner-alias`). Aliases written on the note, and names inherited from stubs
  merged into it, do not mean the owner. A single-token alias counts only for
  task assignees, and never when another live person answers to it.
- **Bridge puppets.** Only the prefixes this deployment bridges
  (`telegram`, `whatsapp`, `signal`, `discord`, `instagram`, `messenger`,
  `facebook`, `twitter`) and only with an id-shaped remote part (digits, a
  `lid-` id, a UUID). `@pat_smith:matrix.org`, `@telegram_fan:host` and
  `@linkedin_123:host` are ordinary Matrix ids.
- **Telegram field.** A puppet id, `telegram_<id>`, a numeric id (string or
  number), `@handle`, or a `t.me/` link. A bare word (`none`, a first name) is
  not a handle.
- **Phone.** A key only with `+` or `00` and 7–15 digits. A local number is not
  a key. `contact` counts only when the whole string is an address or such a
  number.
- **Names.** `metadata.name`, the path leaf, the note heading, and `aliases`.
  **`metadata.title` is never a name** (it holds job titles). Generic names
  (`GENERIC_NAMES`: Deleted Account, Unknown, Guest, Admin, Support, Team, …)
  are never keys and never match.
- **Slugs.** `slugKey` folds the three person-path rules in use to one key.

### The shared people index (`PeopleIndex`) — default-on, so pinned

Calendar ingest (and Gmail / Proton / Matrix linking when their flags are on)
call `PeopleIndex.findOrCreate` on every pass. `test/people-parity.test.ts`
runs the index as it was at `6069ccd` (a verbatim copy under `test/fixtures/`)
and the current one over the same corpus (1,148 cases, including the `existed: true` branch) and asserts:

- where the old index **linked** note N, the new one links N — or N's canonical
  person when N is a resolvable tombstone — or nothing when N is a non-human
  note or an unresolvable tombstone. It never creates.
- where the old index **skipped**, the new one never creates.

Keys are claimed exactly as before (whole-string addresses, Matrix ids, name /
path leaf / heading). The identity layer's extra keys (addresses inside a
multi-value string, `contact_emails`, puppet-derived ids) are tried only when
nobody claims the key the old way, so they can only turn a duplicate-create
into a link. Alias and slug-variant name matches block creation only when the
caller passed a review sink (`PEOPLE_QUEUE_ON_INGEST`), so a miss is reported
rather than silent; without the flag the old behaviour (create) stands.

### Relationship vocabulary

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

Normalization rewrites a synonym only when it is unambiguous: both notes have
exactly one kind, and the kinds fit the canonical relationship in its stated
direction. Only `attended`, `attendee`, `attendees`, `member`, `has-member` may
be read backwards. `from`, `to`, `sender`, `recipient`, `owner`, `assignee`,
`project`, `participant` are never flipped; a note tagged both `task` and
`project` is never guessed. Such links are left untouched and counted
(`untouched`, per name). A link that carries its own metadata is never
re-created (`link-metadata`). `wikilink` is vault-managed and never rewritten;
`transcript-of` belongs to the transcript-linking branch.

`VaultMessagesDashboard` filters on exactly `messages-with` and `email-from`;
`EventTranscripts` on `has-transcript`; the People workspace lists every
relationship in both directions.

## Routes

All under `/api/admin/people`, on the existing admin router:

- **Auth:** server owner only, by email (`OWNER_EMAIL`), session cookie or device
  token. Everyone else → `403 {error:"forbidden"}`.
- **CSRF** on every non-GET: `Content-Type: application/json` (`415`), and for
  anything but a device token a cross-site `Sec-Fetch-Site` or a foreign `Origin`
  → `403 csrf_refused`.
- **Vault:** the owner's active vault (`X-Prism-Vault`).
- **One writer:** the job, a merge and a resolve / dismiss are mutually
  exclusive → `409 {error:"busy"}`.
- Every vault call is abandoned after `PEOPLE_VAULT_TIMEOUT_MS`. No write is
  ever sent without `if_updated_at`.

### Owner identity

`GET /owner` →

```json
{"configured": {"person": "noteId | null", "emails": [], "aliases": [], "source": "settings | env"},
 "ownerPersonKnown": true,
 "resolved": {"personId": "…", "path": "…"},
 "configuredNote": {"found": true, "merged": false, "nonHuman": false}}
```

`PUT /owner` — body `{person, emails?, aliases?}`. `person` is a note id or
path and must be a live person note (`404 person_not_found`, `409
not_a_live_person`). Stored per vault in SQLite settings, by note id. `emails`
(≤20 addresses) and `aliases` (≤20 names, e.g. a first name used on tasks) are
optional. Writes nothing to the vault. `DELETE /owner` clears it; the
`PEOPLE_OWNER_*` environment then applies. `OWNER_EMAIL` always counts as one of
the owner's addresses.

### Review queue

`GET /candidates?status=open|resolved|dismissed&reason=&relationship=&limit=1..200&after=<cursor>`
→ `{candidates, next, open: {total, byReason}}`. A candidate:

```json
{"id": "uuid", "vaultId": "primary", "sourceNoteId": "…", "relationship": "email-from",
 "key": {"kind": "email", "value": "…", "hash": "sha256"}, "display": "name as seen | null",
 "candidateIds": ["personId"],
 "reason": "ambiguous-key | ambiguous-name | single-token-name | name-key-mismatch | name-only | tombstone-unresolved",
 "origin": "backfill:emails | ingest:calendar | …", "status": "open",
 "resolvedPersonId": null, "decidedBy": null, "createdAt": "…", "updatedAt": "…"}
```

`POST /candidates/:id/resolve` — body `{personId, addIdentity?: false, applyToKey?: false}`

Links the source note to the person: one links-only PATCH with `if_updated_at`,
skipped when that directed edge exists. **`addIdentity` defaults to false.**
With `true` the key is also written onto the person (read-modify-write, complete
nested object) unless someone else claims it or the target field has an
unexpected type. `applyToKey` covers every open candidate with the same key, up
to 50 notes. A `tombstone-unresolved` candidate resolves by writing
`merged_into` on the stub instead of a link.

```json
{"ok": true, "personId": "…", "resolved": 1, "linked": 1, "alreadyLinked": 0, "conflicts": 0,
 "missing": 0, "noStamp": 0, "errors": 0, "identityAdded": false, "identitySkipped": "not_requested"}
```

`identitySkipped`: `not_requested`, `already_present`,
`claimed_by_another_person`, `unsupported_kind`, `unexpected_type`, `conflict`.
A source that changed (`conflicts`) or has no version (`noStamp`) stays open.
Errors: `400`, `404 not_found` / `person_not_found`, `409 not_open` / `busy`,
`503`. One `action_audit` row (ids, key kind, 16-hex key hash, counts).

`POST /candidates/:id/dismiss` — body `{applyToKey?: false}` → `{ok, dismissed}`.
A dismissed identity is never linked for that note and never re-queued.

### Backfill job

`POST /link` — body, every field optional:

```json
{"dryRun": true,
 "phases": ["owner","tombstones","repoint","emails","meetings","threads","tasks","normalize"],
 "maxWrites": 200, "enqueue": false, "allowNameLinks": false, "excludeBulkLinks": false,
 "useMatrixMembers": true}
```

- `dryRun` is true unless exactly `false`.
- `phases` defaults to all eight, always run in the order above.
- `maxWrites`: 1 … `PEOPLE_LINK_MAX_WRITES_CEILING`. A write run without it uses
  `PEOPLE_LINK_MAX_WRITES`; a dry run without it is uncapped.
- `enqueue`: **false for every run** unless explicitly `true`. With `true`, review
  rows are written only for the part of a phase a capped run actually reached
  (`extra.reviewsBeyondWindow` counts the rest), and never past
  `PEOPLE_QUEUE_MAX_OPEN` open rows (`skipped["queue-full"]`). `queued` always
  reports what would be queued. A link that lands closes the open rows that
  asked about that person (status `resolved`, decided by `linked-by-job`).
- `excludeBulkLinks`: false. With true, bulk-labelled mail is not linked at all.
- `allowNameLinks`: false. With true, a unique full name or alias links in
  `meetings` and `tasks` only.
- `useMatrixMembers`: **on whenever a Matrix credential is stored** and the
  `threads` phase is selected; pass `false` to disable. Passing `true` without
  a credential → `409 matrix_not_configured`. A dry run performs the lookups too
  (read-only requests to the homeserver).

→ `202 {job}`; `409 busy`; `400 bad_request`. `GET /link` → `{job | null,
phases}`. `POST /link/cancel` → `{ok}`.

Per phase the job reports: `scanned`, `wouldLink`, `wouldUnlink`,
`notesToWrite`, `alreadyLinked`, **`byEvidence`** (planned links per evidence
kind: `email`, `mxid`, `telegram`, `phone`, `handle`, `alias`, `full-name`,
`path`, `owner-alias`, `project`), `queued`, `queuedByReason`, `skipped` (by
reason), `extra` — all identical in a dry run and a write run with the same
options — and `linked`, `unlinked`, `notesWritten`, `conflicts`, `errors`,
`oversize`, `deferred` for what a write run did. `sample.link`, `sample.review`,
`sample.bulk` (bulk-labelled mail that would link) and `sample.role` (role
mailboxes a person note claims) hold up to 20 note ids each. `notesToWrite` and
`notesWritten` count a note once even when it is written in both waves; the
job's `writes` counts PATCHes. Evidence kinds also include `owner-full-name`
and `wikilink`. `normalize` adds `byName` and `untouched`. The job
itself reports `writes`, `capped`, `queuedNew`, `memberLookups`,
`ownerPersonKnown`, `liveNotes`, `allowNameLinks`, `status`, `error`.

| Phase | Reads (lean, never content) | Does |
|---|---|---|
| `owner` | people; the whole-vault listing only if the owner has tombstones | Checks the configured owner note is a live person (`owner-unresolved` otherwise, and nothing is written). Appends `OWNER_EMAIL`, configured emails and aliases the note lacks (never one somebody else claims). Moves links held by the owner's tombstones onto it. Counts live notes that share a key with the owner (`ownerDuplicatesNeedingMerge`). |
| `tombstones` | people + the whole-vault listing | Repairs **dangling** stubs only: the pointer is absent, or resolves to nothing in the whole vault. Exactly one live person sharing a **strong key** → `merged_into` = that note's id, the previous value kept in `prism_merged_into_prev`. A name match, several matches, or none → review queue (`tombstone-unresolved`), never a write. A stub whose target exists but is not a live person (an organization, a project, a bot note, another dead end) is left exactly as it is (`extra.leftTargetNotAPerson`). A stub repaired in this run is not repointed and not used for matching until the next run. |
| `repoint` | people + the whole-vault listing | Links held by a resolvable tombstone move to its canonical person, same relationship, same direction. Inbound: rewritten on the linking note in one PATCH. Outbound: added to the canonical, then removed from the stub. `wikilink` stays; the canonical gains a `references` twin. Skips `repaired-this-run` and `no-canonical` stubs. |
| `emails` | `email`: `from`, `to`, `labels` | `email-from` and `email-to` by **exact address only**. A **role mailbox** (no-reply, notifications, team@, info@, support@, …) never links, whoever's note holds the address: `skipped["role-address-claimed"]` + `sample.role` when a person note does, `role-sender` / `role-recipient` otherwise. On `BULK` / `AUTOMATED` / `PROMOTIONS` mail an exact sender address still links (owner decision), counted in `extra.bulkLinked` and sampled in `sample.bulk`; nothing else links or queues there; `excludeBulkLinks` turns it off. A name-only match on ordinary mail is a review item. Never the owner. |
| `meetings` | `meeting`, `transcript`: `attendees`, `attendeeEmails` | `attended-by`: address first; a name links only with `allowNameLinks`, otherwise review. The owner is linked by address, by their note's own full name, or by a configured multi-word alias. Role mailboxes and calendar resources never link. |
| `threads` | `message-thread`: `participants`, `participantIds`, `matrixRoomId` | `messages-with` **by Matrix id**: stored `participantIds`, else the membership lookup. Looked-up ids are written back as `participantIds` in the same PATCH as the links. **When the lookup cannot answer the thread waits** — `lookup-budget` (over `PEOPLE_LINK_MEMBER_LOOKUPS`), `lookup-failed`, or `lookup-unavailable` after `PEOPLE_LINK_MEMBER_FAILURES` failures in a row (`extra.lookupBreaker`) — and is picked up by a later run; it never falls back to display names. Display names are used only when the lookup is off or the note has no room id, and then only as review items in rooms of up to `PEOPLE_LINK_GROUP_NAME_MAX`. A room whose real membership exceeds `PEOPLE_LINK_GROUP_MAX_MEMBERS` gets neither links nor `participantIds`. At most `PEOPLE_LINK_GROUP_LINK_CAP` links per group. Bots and the owner never linked. Smallest rooms first. |
| `tasks` | `task`: `assigned`, `assignee`, `project`; `project` notes | `assigned-to`: the owner by address, own full name, or configured alias; a `[[reference]]` to exactly one person note (evidence `wikilink`); any other name only with `allowNameLinks`. `belongs-to`: the one project whose path, slug, name, title or alias matches. |
| `normalize` | the whole-vault listing | Unambiguous synonyms → canonical, add then remove. |

Safety, every phase:

- Lean listings only. One listing per tag; `owner`, `repoint` and `normalize`
  share **one** whole-vault lean listing (ids, tags, `type`, links) per run, taken
  only when one of them needs it and kept current in memory as the run writes.
- Every write carries `if_updated_at`. A note with no version is skipped and
  counted (`no-stamp`); a 409 is counted; nothing is forced.
- "Already linked" is directed: only source → target counts.
- A removal is sent only after its addition succeeded.
- At most two writes in flight, `PEOPLE_LINK_PACE_MS` apart; a hard write cap.
- `PEOPLE_LINK_MAX_CONSECUTIVE_ERRORS` failed writes in a row (409s excluded)
  **abort the run**: status `error`, the `people-link` health source counts a
  failure, the audit row says `failed`.
- A note over 2 MB is skipped. The pre-skip reads an untyped `byteSize` field
  on lean rows; if the vault does not send it, the write is attempted and the
  vault's `413` is counted as `oversize` (a 413 never trips the error breaker).
- A note open in the collab editor is written and `markReconciled` is called —
  liveness is checked before **and after** the write — so the reconciler does
  not fold the stored body over unsaved typing.
- A listing that reaches 50,000 notes aborts the run before any write.

### Duplicates and merge

`GET /duplicates?strength=strong|medium|weak&limit=1..200&offset=0` →
`{pairs, total, counts, next}`. Read-only. All pages are served from one cached
people listing and one detection (60 s, dropped on any write by this layer).
`evidence` is kinds only: `email`, `matrix`, `telegram`, `phone`, `handle`,
`email-derived-name`, `email-as-name` (strong); `name` (medium);
`abbreviated-name` (weak). `title`, a bare word in `telegram` and a local phone
number never pair people.

`POST /merge` — body

```json
{"personIds": ["a", "b"], "canonicalId": "a", "dryRun": true,
 "expect": {"canonicalUpdatedAt": "…", "secondaryUpdatedAt": "…"}, "confirmUnrelated": false}
```

A dry run needs only `personIds`; the server suggests the canonical. It returns
`{merge, pair, requiresConfirmUnrelated, warnings?}` where `merge.expect` holds
the two versions it read. `warnings` says in capitals when the pair is not a
detected duplicate, and when that would merge a stranger into the owner's own
person note (allowed only with `confirmUnrelated: true`; the absorbed name
becomes an alias on the note and never a name that means the owner). **A write run (`dryRun: false`) is refused unless:**

| Check | Otherwise |
|---|---|
| it comes from a session or device token, not an agent origin | `403 agent_origin_refused` |
| `canonicalId` is given | `400 canonical_required` |
| `expect` is given | `400 expect_required` |
| both notes are still at those versions | `409 stale` |
| the secondary is not the owner's person note | `409 owner_is_secondary` (cannot be overridden) |
| the pair is a strong or medium duplicate on a detection run **now** (not the 60 s cache), or `confirmUnrelated: true` | `409 not_a_duplicate` / `weak_match` |
| or: it finishes a merge this module started (the canonical's `prism_merge_history` names the secondary) | — a stub that merely points at the canonical gets the full checks |
| nothing else is running | `409 busy` |

`merge`:

```json
{"dryRun": false, "canonicalId": "…", "secondaryId": "…",
 "expect": {"canonicalUpdatedAt": "…", "secondaryUpdatedAt": "…"}, "resumed": false,
 "identities": {"email": 1, "matrix": 1, "alias": 1}, "skippedFields": [], "leftOnSecondary": [],
 "bodyAppended": true, "bodySkippedLive": false, "linksWithMetadata": 0,
 "outbound": 2, "inbound": 4, "alreadyPresent": 1, "notesToWrite": 6,
 "notesWritten": 6, "conflicts": 0, "errors": 0, "noStamp": 0, "aborted": false,
 "tombstoned": true, "complete": true}
```

Order of a write run:

1. **Canonical** — one CAS write. Metadata is append-only: an existing value is
   never re-serialized, split or replaced; a field whose current value has an
   unexpected type is skipped and listed in `skippedFields`; `channels` is sent
   as the complete object. The secondary's body goes under a `Merged from`
   heading (as HTML when the canonical body is collab HTML), and
   `prism_merged_from` records that it was appended — no HTML comment marker. If
   either note is open in the editor the body is left alone
   (`bodySkippedLive`); run the merge again later. If this write fails, nothing
   else is touched.
2. **Every note linking to the secondary** — one links-only CAS write each.
   Their versions are read one by one, or from one lean listing above 40 notes.
   A conflict, an error or a missing version leaves that note's old link.
3. **Secondary**, last — tag `merged-stub`, `merged_into` (the canonical's
   note id), `status`, `merged_at`, `merged_by`; only the identity fields the
   canonical verifiably holds are removed — judged on a **re-read** of the
   canonical after step 1, never on the plan or the write's response; if that
   read fails, nothing is stripped and the secondary is left live for the next
   call (kept under `prism_merged_identities`; the rest listed in
   `leftOnSecondary`); its outgoing links removed.

The merge marker (`prism_merge_history` on the canonical) is written in step 1
of every merge, even when the canonical gains nothing.

Nothing is deleted. `complete: false` → call the same merge again (after a new
dry run for `expect`); it resumes. One `action_audit` row per write merge.

**Undo.** Restore the canonical and the secondary to their pre-merge versions in
the history panel (content and metadata come back; then remove the `merged-stub`
tag — restore does not touch tags). Links are not part of a version restore:
re-point them by hand or restore the vault from the pre-run backup.

### People directory (owner decision 5)

`GET /api/people` now lists live humans only: tombstones and non-human notes
are filtered out. `GET /api/people/:id` on a tombstone returns the person it was
merged into, with one additive key, `mergedFrom: {id, path}` — when the caller
may view that person. A stub whose target cannot be found opens as itself.
`PeopleWorkspace` reads `person`, `related`, `next` and ignores unknown keys, so
no client change is needed.

`VaultMessagesDashboard` cannot be fixed server-side without changing the
contract: it loads people with `vault.listNotes({tag: "person", limit: 2000})`
through the owner passthrough, which is a transparent proxy to the vault.
Filtering that response would change what every other consumer of
`GET /api/notes?tag=person` receives. The frontend change needed, in
`packages/core/src/components/comms/VaultMessagesDashboard.tsx` where
`personNotes` is derived (line 93):

```ts
const isMerged = (n: Note) =>
  n.tags?.includes("merged-stub") || n.tags?.includes("superseded") ||
  n.metadata?.status === "merged_into_canonical" || !!n.metadata?.merged_into;
const personNotes = peopleError ? undefined : loadedPeople?.filter((n) => !isMerged(n));
```

After the `repoint` phase has run, stubs hold no links, so they would also
drop out of that view's "people with threads" list on their own.

## Flags

Read at server start; restart pm2 after a change.

| Variable | Default | Recommended (enable in stage 10) | Effect |
|---|---|---|---|
| `MATRIX_LINK_PEOPLE` | `false` | `false` | Existing. Links participants and **creates** people in rooms of ≤3. |
| `MATRIX_LINK_EXISTING` | `false` | **`true`** | Links participants who already have a person note, by Matrix id. Creates nobody. Never the owner's note. |
| `MATRIX_STORE_PARTICIPANT_IDS` | `false` | **`true`** | Keeps members' Matrix ids on thread notes (`participantIds`). |
| `PEOPLE_QUEUE_ON_INGEST` | `false` | **`true`** | Ingesters queue what they could not link: Proton sender/recipient names, transcript attendees, ClickUp assignees, calendar attendees, and Matrix **DM** counterparts (rooms of ≤3; deduped). With it on, calendar ingest also treats an alias / slug-variant name match as a candidate instead of creating a new person. |
| `PROTON_LINK_PEOPLE` | `false` | `true` | Existing. `email-from` for an exact sender address. |
| `PROTON_LINK_RECIPIENTS` | `false` | `true` | `email-to` for an exact recipient address. Does not change how the sender is linked. |
| `TRANSCRIPT_LINK_PEOPLE` | `false` | `true` | `attended-by` on new Fathom / Fireflies transcripts, by address. |
| `CLICKUP_LINK_ENABLED` | `false` | `true` | `assigned-to` / `belongs-to` on ClickUp tasks. |
| `PEOPLE_OWNER_PERSON` / `_EMAILS` / `_ALIASES` | empty | set via `PUT /owner` instead | Fallback owner identity. |
| `PEOPLE_LINK_MAX_WRITES` | `200` | | Cap of a write run that passes no `maxWrites`. |
| `PEOPLE_LINK_MAX_WRITES_CEILING` | `20000` | | Largest `maxWrites` a request may ask for. |
| `PEOPLE_LINK_PACE_MS` | `50` | | Pause per writer between writes. |
| `PEOPLE_LINK_MAX_CONSECUTIVE_ERRORS` | `5` | | Failed writes in a row that abort a run or a merge. |
| `PEOPLE_QUEUE_MAX_OPEN` | `1000` | | Most open review rows per vault; past it nothing is inserted. |
| `PEOPLE_LINK_MEMBER_FAILURES` | `3` | | Failed membership lookups in a row that end a run's lookup stage. |
| `PEOPLE_VAULT_TIMEOUT_MS` | `30000` | | Timeout of every vault call, and of every Matrix read (`whoami`, membership), this layer makes. |
| `PEOPLE_LINK_GROUP_NAME_MAX` | `8` | | Largest room in which a display name becomes a review item. |
| `PEOPLE_LINK_GROUP_MAX_MEMBERS` | `50` | | Rooms above this are skipped. |
| `PEOPLE_LINK_GROUP_LINK_CAP` | `15` | | Most links per room of more than 3. |
| `PEOPLE_LINK_MEMBER_LOOKUPS` | `300` | | Matrix membership lookups per run. |
| `PEOPLE_LINK_MEMBER_PACE_MS` | `150` | | Pause between lookups. |
| `PEOPLE_LINK_MAX_RECIPIENTS` | `10` | | More `To` recipients than this → no `email-to`. |

On ingest a display name never links anything; only strong keys do.

## What changes on deploy

With every flag off:

1. **Shared people index** (calendar ingest today). A tombstone claimant whose
   pointer is a note id or a full path redirects to its canonical person, so an
   address held by a stub and its canonical is no longer "ambiguous" and the
   attendee links — **expect a one-time batch of `attended-by` additions** on
   meetings inside calendar ingest's window (today −3 d … +31 d), one PATCH per
   affected meeting, on the first passes after deploy. A claimant that is
   a non-human note or an unresolvable tombstone no longer links (the old index
   linked the bot or stub note itself) and is never re-created. Addresses inside
   a multi-value string and `contact_emails` are found when nobody claims the
   address the old way, so calendar ingest links that person instead of creating
   a duplicate. A stub whose pointer is only a name or a bare leaf is NOT
   followed on ingest (it is a dead end there). Nothing else: the parity test
   covers 1,148 cases, including the `existed: true` branch.
2. **People directory**: `GET /api/people` no longer lists tombstones and
   non-human notes; a tombstone id opens its canonical person.
3. `identity_candidates` is created (`CREATE TABLE IF NOT EXISTS`).
4. `vaultClient()` accepts an optional `{timeoutMs}`; existing callers pass
   nothing and are unchanged.

## Runbook — first cleanup in production

Overseer only. Ten stages, in order. Do not start a stage until the gate of the
one before it is met. "Undo" for any write stage is the vault +
`prism-server.db` backup taken in stage 0 unless a cheaper undo is named.

### Stage 0 — pre-flight (sandbox vault, never production) and backup

The tests prove the code against the documented API with a fake vault. Confirm
these four behaviours of the real vault on the sandbox:

1. **Nested metadata merge.** PATCH `{channels: {a: 1}}`, then
   `{channels: {b: 2}}`. Either outcome is handled (this layer always sends the
   complete object); note which it is — under a shallow merge a stripped channel
   key is stored as a literal `null`.
2. **`links.remove`.** Removing a link that does not exist is a no-op, not an
   error; removing one of two links to the same target removes only that one.
3. **Link metadata.** If hydrated links carry `metadata`, the job and the merge
   skip them (`link-metadata` / `linksWithMetadata`); `created_at` is not
   preserved on a move.
4. **`updatedAt` on lean rows** (`GET /notes?tag=email&include_metadata=from`).
   Without it every write is skipped as `no-stamp`. Also note whether lean rows
   carry `byteSize`; without it oversize notes are found by the vault's `413`.

Then, on production: back up the vault and `prism-server.db` together
(`scripts/backup-parachute.sh`) and write down the time. Run every write stage
when the owner is not editing and no local-model run is active
(`GET /api/agent/skills/running` is empty).

**Gate:** all four confirmed; backup exists.

### Stage 1 — deploy with every flag off

Merge, restart pm2. All link flags stay off.

**Look at:** `GET /acl/workers` green. Over the next calendar passes the log
shows a one-time batch of `~N updated` meetings — the `attended-by` additions
described under *What changes on deploy*. It should stop after the window has
been covered once.
**Gate:** workers green; the calendar update count returns to its usual level.
**Undo:** revert the deploy. The added `attended-by` links stay (they are
correct links to canonical people).

### Stage 2 — set and verify the owner

`PUT /api/admin/people/owner {"person": "<path or id of the owner's person
note>", "aliases": ["<first name used on tasks>"]}`, then `GET /owner`.

**Look at:** `ownerPersonKnown: true`; `resolved.personId` is the right note;
`configuredNote` is `{found: true, merged: false, nonHuman: false}`.
**Gate:** all three. **Undo:** `DELETE /owner` (nothing was written to the vault).

### Stage 3 — dry-run every phase

`POST /link {"phases": ["<one phase>"]}` for each of the eight phases, polling
`GET /link` until `done`.

**Look at, per phase:** `byEvidence` (strong kinds only, apart from
`owner-*`, `wikilink`, `project`, `path`); `skipped`; open the notes in
`sample.link` and `sample.review`. For `emails` also open `sample.bulk` (every
bulk-labelled mail that would link — decide whether to pass
`excludeBulkLinks`) and `sample.role`. For `tombstones` read
`extra.repaired`, `extra.leftTargetNotAPerson`, `extra.pointerWithoutMarker`.
**Gate:** no sample is wrong; `ownerPersonKnown: true`.
**Undo:** nothing was written.

### Stage 4 — first writes: `emails`, then `meetings`, strong keys only

`{"dryRun": false, "phases": ["emails"], "maxWrites": 50, "allowNameLinks":
false, "enqueue": false}`; check; then the same for `meetings`.

**Look at:** `conflicts: 0`, `errors: 0`; open several written notes in the
People workspace; `byEvidence` shows only `email` (and `owner-full-name` for
meetings).
**Gate:** the 50 are right. Then widen: repeat with `"maxWrites": 500`, then
`2000`, until `capped: false` and `notesToWrite: 0`.
**Undo:** the backup. (There is no automatic inverse of a links write.)

### Stage 5 — `tombstones`, alone; later, `repoint`, alone

`{"dryRun": false, "phases": ["tombstones"], "maxWrites": 50}`. Strong-key
repairs only; nothing else is written. **Review each repaired stub**
(`sample.link`): its `merged_into` is now a note id and
`prism_merged_into_prev` holds what was there.

**Gate:** every repair is right. **Undo:** set `merged_into` back from
`prism_merged_into_prev` (or restore the stub's previous version).

Then — as a **separate, later run** — `{"dryRun": false, "phases":
["repoint"], "maxWrites": 50, "enqueue": false}`, widen as in stage 4.

**Look at:** canonical people now show the records their stubs held.
**Gate:** `conflicts: 0`; spot-check five canonical people. **Undo:** the backup.

### Stage 6 — `owner`, then `tasks`

`{"dryRun": false, "phases": ["owner"]}`: appends the configured identities to
the owner's note and brings home links from the owner's tombstones.
**Look at:** the owner note's `channels.email` / `aliases`; nothing else changed.
**Undo:** restore the owner note's previous version.

`{"dryRun": false, "phases": ["tasks"], "maxWrites": 50, "enqueue": false}`,
then widen. **Look at:** `byEvidence` = `owner-alias`, `owner-full-name`,
`wikilink`, `project`. **Gate:** the owner's tasks appear under the owner; no
task is linked to somebody else by name. **Undo:** the backup.

### Stage 7 — `threads`, with the member lookup

`{"dryRun": false, "phases": ["threads"], "maxWrites": 50, "enqueue": false}`.
The lookup is on when a Matrix credential is stored.

**Look at:** `byEvidence` (`telegram`, `mxid`, `phone`, `handle` only);
`extra.idsBackfilled`; `skipped["lookup-budget"]` (expected: 300 lookups per
run); `extra.lookupBreaker` must be absent.
**Gate:** samples right; no breaker. Repeat (each run takes the next 300 rooms)
until `lookup-budget` is gone. **Undo:** the backup; `participantIds` are
harmless to leave.

### Stage 8 — `normalize`

`{"dryRun": false, "phases": ["normalize"], "maxWrites": 50}`, then widen.
**Look at:** `byName`, `untouched`. **Undo:** the backup.

### Stage 9 — merges, one pair at a time

`GET /duplicates?strength=strong`. Per pair: `POST /merge {personIds}` (dry
run) → read `identities`, `skippedFields`, `leftOnSecondary`, the link counts
and any `warnings` → `POST /merge {personIds, canonicalId, expect, dryRun:
false}`. Strong detected pairs first; medium after; weak pairs and anything
needing `confirmUnrelated` only after a human look at both notes.

**Gate per pair:** `complete: true`. If not, dry-run again and repeat the call.
**Undo:** restore both notes' pre-merge versions and remove the `merged-stub`
tag; links come from the backup.

### Stage 10 — forward flags, one at a time

A day apart, watching `GET /acl/workers` and the queue depth:
`MATRIX_STORE_PARTICIPANT_IDS`, `MATRIX_LINK_EXISTING`,
`PEOPLE_QUEUE_ON_INGEST`, `TRANSCRIPT_LINK_PEOPLE`, `CLICKUP_LINK_ENABLED`,
`PROTON_LINK_PEOPLE` + `PROTON_LINK_RECIPIENTS`. Leave `MATRIX_LINK_PEOPLE` off.

**Gate per flag:** a day with no unexpected queue growth. **Undo:** set the flag
back and restart; nothing it wrote is removed.

### Optional, any time after stage 4

- **Names.** Dry-run `{"phases": ["meetings","tasks"], "allowNameLinks":
  true}`, review the `full-name` / `alias` samples, then write. Names never
  link mail or chat.
- **The review queue.** Add `"enqueue": true` to a run to fill it (bounded by
  `PEOPLE_QUEUE_MAX_OPEN`); resolve or dismiss from `GET /candidates`.
  `DELETE FROM identity_candidates` is a safe reset.

## Offline estimate (third pass)

Dry run of the job over the audit dumps (1,036 people, 1,325 threads, 3,467
emails, 1,816 meetings, 1,750 tasks, 151 projects and organizations), with the
owner note configured and one first-name alias, **no Matrix lookup** (offline).
Counts only. "Would queue" is what `enqueue: true` would insert (before the
1,000-row cap); by default nothing is queued.

Default run (`allowNameLinks: false`):

| Phase | Links added, by evidence | Removed | Notes written | Would queue, by reason |
|---|---|---|---|---|
| owner | 0 (1 identity appended; 1 owner tombstone) | 1 | 2 | 0 |
| tombstones | 1 repair (email) | 0 | 1 | 3 tombstone-unresolved |
| repoint | 416 path | 408 | 315 | 0 |
| emails | 348 email (149 of them on bulk-labelled mail) | 0 | 316 | 157: ambiguous-key 89, single-token-name 39, name-key-mismatch 20, name-only 9 |
| meetings | 2,974: email 2,610, owner-full-name 364 | 0 | 1,045 | 1,286: name-only 1,142, ambiguous-key 107, single-token-name 37 |
| threads | 0 (no ids offline) | 0 | 0 | 374: name-only 281, single-token-name 93 |
| tasks | 1,138: project 664, owner-alias 295, owner-full-name 173, wikilink 6 | 0 | 809 | 373: name-only 329, single-token-name 44 |
| normalize | 59 | 125 | 104 | 0 (4 synonyms left untouched) |
| **total** | **4,935** | **534** | **2,592** | **2,193** |

With `allowNameLinks: true`, `meetings` becomes 3,757 links (adds full-name 731,
alias 52; would queue 144) and `tasks` 1,446 (adds full-name 277, alias 31;
would queue 44): 6,025 links, 2,770 notes, 722 would queue. Emails and threads
are identical in both modes.

Breakdowns asked for:

- **Emails.** 348 links, all by exact address; **149 are on bulk-labelled mail**
  (`extra.bulkLinked`; `excludeBulkLinks` would leave 199). **Role mailboxes:
  1,744 senders skipped as `role-sender`, plus 35 where a person note holds the
  role address (`role-address-claimed`, never linked).** 650 bulk-labelled mails
  match nobody; 252 unknown senders; 20 senders are claimed by a dead-end note;
  23 are the owner.
- **Owner.** Meetings: 364 by `owner-full-name`, none by alias. Tasks: 173 by
  `owner-full-name`, 295 by the configured single-token `owner-alias`. In
  threads 549 participant entries are a nickname that is only an alias on the
  owner's note: not linked and not queued.
- **Tombstones.** 135 (the precise rule; one further note carries a bare
  pointer and is reported as `pointerWithoutMarker`). 127 resolve. Of the 8
  that do not: **1 repaired** (strong key), **3 queued**
  (`tombstone-unresolved`), **4 left alone** (their target exists but is not a
  live person). Offline, "dangling" is judged against the six dumped note kinds
  only, so repaired + queued may be overstated.
- **C1 exposure.** 8 dead-end person notes, all unresolvable tombstones; none is
  tagged or typed non-human. 5 are the sole claimant of an email (5 addresses).
- **The pointer-only note.** Because it is now a live person, the address it
  shares with its successor is ambiguous: about 60 meeting attendee entries and
  5 mails move from "linked" to "would queue" until that pair is merged (it is
  one of the 13 strong duplicate pairs).
- **Duplicates.** 20 pairs: 13 strong, 5 medium, 2 weak.
- **Threads.** Every link depends on the Matrix lookup or stored
  `participantIds`; it cannot be estimated offline. 158 rooms have over 50
  participants, 138 name-only rooms have over 8.

`repoint` and `normalize` are lower bounds: 17 linking notes were outside the
dumps.

## Limitations

- **Review queue.** Nothing is queued unless a run passes `enqueue: true`; then
  at most `PEOPLE_QUEUE_MAX_OPEN` (1,000) rows are open at once. On the audited
  vault about 2,200 items would qualify.
- **Tombstone repair and repoint take two runs** by design (stage 5).
- **A stub whose pointer is a name** is a dead end on ingest; only the job
  follows it.
- **A live note with a bare merge pointer** is treated as a person; the address
  it shares with its successor is ambiguous until the two are merged.
- **Threads need ids.** Until `participantIds` are stored or the lookup has run,
  a thread cannot link. The lookup budget is 300 rooms per run, smallest first;
  several runs are needed for 1,300 rooms. A dry run performs the lookups too.
- **Reversed existing links.** "Already linked" is directed. Where an agent
  wrote `person --attended-by--> meeting` (60 such links in the dump), the job
  adds `meeting --attended-by--> person` beside it.
- **Proton recipients** are stored as bare addresses; there is no recipient
  name to review.
- **`member-of` / `works-at` are not derived** from person metadata.
- **No re-link pass.** A person added later does not retroactively link old
  notes; run the job again.
- **Matrix forward linking queues DMs only**, and a thread created in the same
  pass queues its counterpart on the next append.
- **Link `created_at`** is not preserved when a link moves.
- **A merge reads both person notes with content**, and each linking note once
  (content included) when there are 40 or fewer.
- **A shallow-merging vault** would store `null` for a stripped channel key.
- **Paging.** The vault client has no offset parameter; listings are per tag
  and a run aborts at 50,000 rows.
- **`VaultMessagesDashboard`** still lists tombstones until the frontend change
  above is made.

## What the frontend could add

- **Review queue UI**: `GET /candidates` grouped by key; "This is …" →
  `resolve` (offer "also remember this address" = `addIdentity: true`, and
  "apply to all N" = `applyToKey`); "Not a person" → `dismiss`. `open.total`
  makes a badge. `tombstone-unresolved` rows need a person picker.
- **Possible matches on a person**: `/duplicates` filtered to that id; Merge →
  dry run → confirmation showing `identities`, `skippedFields`,
  `leftOnSecondary`, link counts → write with `canonicalId` + `expect`. Offer
  `confirmUnrelated` only behind an explicit second confirmation.
- **Owner setting**: a "This is me" action on a person note → `PUT /owner`.
- **Backfill control**: per-phase dry run → table (`byEvidence`,
  `queuedByReason`) → write, like "Resolve All Wikilinks".
- **`mergedFrom`** on the person detail: show "merged from …".
- **Recipients in the messages dashboard**: add `email-to` to its filter.
- **Health**: `people-link` in `/acl/workers` carries `detail.openCandidates`.
