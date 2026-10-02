# Backend status — identity + linking ("the graph")

Branch `feat/backend-graph`. Server-side only (`apps/server`). Every job is a
dry run unless told otherwise and every ingest flag defaults to off. What
changes on deploy with all flags off is listed under
[What changes on deploy](#what-changes-on-deploy).

This revision (2026-10-02, second pass) folds in the independent review
(C1, M7, H1–H4, M1–M6, the lows) and the owner's six decisions.

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

- **Tombstones.** Tag `merged-stub` or `superseded`, `status:
  merged_into_canonical`, or a non-empty `merged_into` / `mergedInto` /
  `superseded_by`. `merged_into` may be a note id, a path, `[[path]]`, a path
  leaf, or the exact name of one other live person. Chains are followed; cycles
  and dead ends resolve to nothing.
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
and the current one over the same corpus (846 cases) and asserts:

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
 "maxWrites": 200, "enqueue": false, "allowNameLinks": false, "useMatrixMembers": true}
```

- `dryRun` is true unless exactly `false`.
- `phases` defaults to all eight, always run in the order above.
- `maxWrites`: 1 … `PEOPLE_LINK_MAX_WRITES_CEILING`. A write run without it uses
  `PEOPLE_LINK_MAX_WRITES`; a dry run without it is uncapped.
- `enqueue`: false for a dry run, true for a write run.
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
`oversize`, `deferred` for what a write run did. `sample.link` / `sample.review`
hold up to 20 note ids each. `normalize` adds `byName` and `untouched`. The job
itself reports `writes`, `capped`, `queuedNew`, `memberLookups`,
`ownerPersonKnown`, `liveNotes`, `allowNameLinks`, `status`, `error`.

| Phase | Reads (lean, never content) | Does |
|---|---|---|
| `owner` | people; the whole-vault listing only if the owner has tombstones | Checks the configured owner note is a live person (`owner-unresolved` otherwise, and nothing is written). Appends `OWNER_EMAIL`, configured emails and aliases the note lacks (never one somebody else claims). Moves links held by the owner's tombstones onto it. Counts live notes that share a key with the owner (`ownerDuplicatesNeedingMerge`) — merging them is a `/merge` call, not the job's. |
| `tombstones` | people | For each tombstone whose target cannot be found: the one live person sharing a strong key, else the one whose own full name (≥2 tokens) is slug-equal → writes `merged_into` (CAS). No unique match → review queue, reason `tombstone-unresolved`. |
| `repoint` | people + the whole-vault listing | Links held by a resolvable tombstone move to its canonical person, same relationship, same direction. Inbound: rewritten on the linking note in one PATCH. Outbound: added to the canonical, then removed from the stub. `wikilink` stays; the canonical gains a `references` twin. |
| `emails` | `email`: `from`, `to`, `labels` | `email-from` and `email-to` by **exact address only**. An exact match to one live person links even on `BULK` / `AUTOMATED` / `PROMOTIONS` mail and for role mailboxes; nothing else links or queues there, and a bulk mail's recipients are never linked. A name-only match on ordinary mail is a review item. More than `PEOPLE_LINK_MAX_RECIPIENTS` recipients → none. Never the owner. |
| `meetings` | `meeting`, `transcript`: `attendees`, `attendeeEmails` | `attended-by`: address first; a name links only with `allowNameLinks`, otherwise review. The owner is linked by address or by a configured name of two or more tokens. Calendar resource addresses skipped. |
| `threads` | `message-thread`: `participants`, `participantIds`, `matrixRoomId` | `messages-with` **by Matrix id**: stored `participantIds`, else the membership lookup (budget `PEOPLE_LINK_MEMBER_LOOKUPS`, paced). Looked-up ids are written back as `participantIds` in the same PATCH as the links (and alone when nobody links, so the room is not looked up again). A display name never links a thread; in rooms of up to `PEOPLE_LINK_GROUP_NAME_MAX` it is a review item. Rooms over `PEOPLE_LINK_GROUP_MAX_MEMBERS` are skipped; at most `PEOPLE_LINK_GROUP_LINK_CAP` links per group. Bots and the owner never linked. Smallest rooms first. |
| `tasks` | `task`: `assigned`, `assignee`, `project`; `project` notes | `assigned-to`: the owner by configured alias or address; a `[[wikilink]]` exactly; any other name only with `allowNameLinks`. `belongs-to`: the one project whose path, slug, name, title or alias matches. |
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
- A note over 2 MB is skipped (`byteSize` when the listing reports it, else the
  vault's `413`).
- A note open in the collab editor is written and `markReconciled` is called, so
  the reconciler does not fold the stored body over unsaved typing.
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
`{merge, pair, requiresConfirmUnrelated}` where `merge.expect` holds the two
versions it read. **A write run (`dryRun: false`) is refused unless:**

| Check | Otherwise |
|---|---|
| it comes from a session or device token, not an agent origin | `403 agent_origin_refused` |
| `canonicalId` is given | `400 canonical_required` |
| `expect` is given | `400 expect_required` |
| both notes are still at those versions | `409 stale` |
| the secondary is not the owner's person note | `409 owner_is_secondary` (cannot be overridden) |
| the pair is currently returned by `/duplicates` with strength strong or medium, or `confirmUnrelated: true` | `409 not_a_duplicate` / `weak_match` |
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
3. **Secondary**, last — tag `merged-stub`, `merged_into`, `status`,
   `merged_at`, `merged_by`; only the identity fields the canonical verifiably
   holds are removed (kept under `prism_merged_identities`; the rest listed in
   `leftOnSecondary`); its outgoing links removed.

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

| Variable | Default | Recommended at deploy | Effect |
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
| `PEOPLE_VAULT_TIMEOUT_MS` | `30000` | | Timeout of every vault call this layer makes. |
| `PEOPLE_LINK_GROUP_NAME_MAX` | `8` | | Largest room in which a display name becomes a review item. |
| `PEOPLE_LINK_GROUP_MAX_MEMBERS` | `50` | | Rooms above this are skipped. |
| `PEOPLE_LINK_GROUP_LINK_CAP` | `15` | | Most links per room of more than 3. |
| `PEOPLE_LINK_MEMBER_LOOKUPS` | `300` | | Matrix membership lookups per run. |
| `PEOPLE_LINK_MEMBER_PACE_MS` | `150` | | Pause between lookups. |
| `PEOPLE_LINK_MAX_RECIPIENTS` | `10` | | More `To` recipients than this → no `email-to`. |

On ingest a display name never links anything; only strong keys do.

## What changes on deploy

With every flag off:

1. **Shared people index** (calendar ingest today). A tombstone claimant
   redirects to its canonical person, so an address held by a stub and its
   canonical is no longer "ambiguous" and the attendee links. A claimant that is
   a non-human note or an unresolvable tombstone no longer links (the old index
   linked the bot or stub note itself) and is never re-created. Addresses inside
   a multi-value string and `contact_emails` are found when nobody claims the
   address the old way, so calendar ingest links that person instead of creating
   a duplicate. Nothing else: the parity test covers 846 cases.
2. **People directory**: `GET /api/people` no longer lists tombstones and
   non-human notes; a tombstone id opens its canonical person.
3. `identity_candidates` is created (`CREATE TABLE IF NOT EXISTS`).
4. `vaultClient()` accepts an optional `{timeoutMs}`; existing callers pass
   nothing and are unchanged.

## Runbook — first cleanup in production

Overseer only.

### Pre-flight (once, on the sandbox vault — never production)

The fake vault in the tests proves the code against the documented API; these
four behaviours of the real vault must be confirmed before a write run:

1. **Nested metadata merge.** PATCH a throwaway note's metadata with
   `{channels: {a: 1}}`, then `{channels: {b: 2}}`. Either result is handled
   (this layer always sends the complete object), but note which it is: under a
   shallow merge a stripped channel key is stored as a literal `null`.
2. **`links.remove` semantics.** Remove a link that does not exist (expect a
   no-op, not an error) and remove one of two links to the same target with
   different relationships (expect only that one to go).
3. **Link metadata.** `GET /notes/:id?include_links=true` on a note whose link
   was written with extra fields: if links carry `metadata` or `created_at`, a
   move re-creates the link without them. The job and the merge skip any link
   with non-empty `metadata` (`link-metadata` / `linksWithMetadata`);
   `created_at` is not preserved.
4. **`updatedAt` on lean rows.** `GET /notes?tag=email&include_metadata=from`:
   every row must carry `updatedAt`. If it does not, every write is skipped as
   `no-stamp` and nothing happens — safe, but the job is useless until fixed.

### Steps

1. **Back up** the vault and `prism-server.db` together
   (`scripts/backup-parachute.sh`). This is the rollback point for links.
2. **Pick a quiet time.** Run when the owner is not editing, and when no
   local-model skill run is active (`GET /api/agent/skills/running` empty): each
   written thread or email is a note update on the single-threaded vault.
3. **Deploy** with `MATRIX_LINK_EXISTING=true`,
   `MATRIX_STORE_PARTICIPANT_IDS=true`, `PEOPLE_QUEUE_ON_INGEST=true`; the other
   link flags off for now. Restart pm2; confirm `GET /acl/workers` is green.
4. **Set the owner**: `PUT /api/admin/people/owner {"person":
   "<path of the owner's person note>", "aliases": ["<first name>"]}`. Confirm
   `GET /owner` → `ownerPersonKnown: true`, `configuredNote.merged: false`.
5. **Dry-run each phase, one at a time**, in order: `{"phases":["owner"]}`,
   then `tombstones`, `repoint`, `emails`, `meetings`, `threads`, `tasks`,
   `normalize`. For each read `byEvidence`, `queuedByReason`, `skipped`, and open
   the notes in `sample.link` and `sample.review`. Stop if a sample is wrong.
6. **First write run: small and strong-key only.**
   `{"dryRun":false,"phases":["owner","tombstones"],"maxWrites":10}`, then
   `{"dryRun":false,"phases":["repoint"],"maxWrites":25,"enqueue":false}`.
   `allowNameLinks` stays false. Confirm `conflicts: 0`, `errors: 0`, look at the
   written notes in the People workspace.
7. **Full strong-key runs, phase by phase**: `repoint`, `emails`, `meetings`,
   `threads`, `tasks`, each with `"maxWrites": 2000`, re-run until
   `capped: false` and `notesToWrite: 0`. Decide `enqueue` first: a default write
   run queues every name-only attendee and assignee (about 2,100 rows on the
   audited vault). Either pass `"enqueue": false` for `meetings` and `tasks` and
   do step 8, or accept the queue.
8. **Names, if wanted.** Dry-run `{"phases":["meetings","tasks"],
   "allowNameLinks":true}`, review the `full-name` / `alias` samples, then write.
   Names never link mail or chat in any mode.
9. **`normalize`** last.
10. **Queue.** `GET /candidates`; resolve or dismiss. `applyToKey` handles a
    sender that appears on many notes. `tombstone-unresolved` rows are the stubs
    whose target the job could not find.
11. **Duplicates.** `GET /duplicates?strength=strong`; per pair `POST /merge`
    dry run → read the report → write with `canonicalId` + `expect`.
12. **Remaining forward flags**, one at a time, a day apart:
    `TRANSCRIPT_LINK_PEOPLE`, `CLICKUP_LINK_ENABLED`, `PROTON_LINK_PEOPLE` +
    `PROTON_LINK_RECIPIENTS`. Leave `MATRIX_LINK_PEOPLE` off.

**Rollback.** A flag: set it back and restart; nothing it wrote is removed. A
dry run: nothing. A write run: there is no automatic inverse — restore the vault
and `prism-server.db` from step 1. The queue: `DELETE FROM identity_candidates`
is safe. Code: revert the branch; the table can stay.

## Offline estimate (second pass)

Dry run of the job over the audit dumps (1,036 people, 1,325 threads, 3,467
emails, 1,816 meetings, 1,750 tasks, 151 projects and organizations), with the
owner note configured and one first-name alias, **no Matrix lookup** (offline).
Counts only.

Default run (`allowNameLinks: false`):

| Phase | Links added, by evidence | Removed | Notes written | Already linked | Queued, by reason |
|---|---|---|---|---|---|
| owner | 0 (1 identity appended; 1 owner tombstone) | 1 | 2 | 1 | 0 |
| tombstones | 1 `merged_into` repaired (email) | 0 | 1 | — | 7 tombstone-unresolved |
| repoint | 419 path | 411 | 318 | 126 | 0 |
| emails | 380 email | 0 | 348 | 331 | 157: ambiguous-key 84, single-token-name 39, name-key-mismatch 25, name-only 9 |
| meetings | 3,035: email 2,671, owner-alias 364 | 0 | 1,045 | 57 | 1,227: name-only 1,142, ambiguous-key 48, single-token-name 37 |
| threads | 0 (no ids offline) | 0 | 0 | 0 | 374: name-only 281, single-token-name 93 |
| tasks | 1,138: project 664, owner-alias 468, path 6 | 0 | 809 | 0 | 373: name-only 329, single-token-name 44 |
| normalize | 59 | 125 | 104 | 65 | 0 (4 synonyms left untouched) |
| **total** | **5,031** | **537** | **2,627** | | **2,138** |

With `allowNameLinks: true`, `meetings` becomes 3,818 links (adds full-name 731,
alias 52; queued 85) and `tasks` 1,446 (adds full-name 277, alias 31; queued
44): 6,121 links, 2,805 notes, 667 queued in total. Emails and threads are
identical in both modes.

Other counts:

- 136 tombstones; 128 resolve, 8 did not. The `tombstones` phase repairs 1 and
  queues 7.
- **C1 exposure:** 8 person notes are dead ends (all unresolvable tombstones;
  no note in the dump is tagged or typed non-human). 5 of them are the sole
  claimant of an email address (5 addresses) — the cases where the first pass
  would have let calendar ingest create a new person.
- Emails: 1,553 bulk-labelled and 830 role-mailbox senders match nobody; 252
  unknown senders; 31 senders are claimed by a dead-end note; 18 are the owner.
- Threads: 158 rooms over 50 participants, 138 name-only rooms over 8. Every
  thread link depends on the Matrix lookup or stored `participantIds`; the
  number cannot be estimated offline.
- Duplicates: 19 pairs (12 strong, 5 medium, 2 weak).

`repoint` and `normalize` are lower bounds: the dumps cover six note kinds (17
linking notes were outside them).

## Limitations

- **Review queue size.** A default write run queues every name-only match
  (about 2,100 rows on the audited vault). See runbook step 7.
- **Threads need ids.** Until `participantIds` are stored or the lookup has run,
  a thread cannot link. The lookup budget is 300 rooms per run, smallest first;
  several runs are needed for 1,300 rooms.
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
