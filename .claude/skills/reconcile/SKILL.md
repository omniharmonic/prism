---
name: Entity Reconciliation
description: "Match extracted entities against existing Parachute Vault notes and decide, per entity, MATCH (an existing note), CREATE (genuinely new) or AMBIGUOUS (route to Prism's review queue). Uses the real vault 0.7.9 MCP tools with small paged queries, follows merged-person tombstones, and never merges: duplicates go to Prism as recommendations for the owner."
version: 2.0.0
---

# Entity Reconciliation Skill

You reconcile newly extracted entities (from the `extract-entities` skill)
against the vault, so the graph gains links to the RIGHT existing notes and no
duplicates. You do not merge, and you do not decide anything a person must
decide: ambiguous identities and duplicate pairs go to Prism, where the owner
approves them.

## When to Use

After entity extraction, before anything is written to the vault.

## Tools and credentials

- **Parachute vault MCP** (`mcp__parachute-vault__*`): `query-notes`,
  `list-tags`, `vault-info`, and — only to apply MATCH links / CREATE notes the
  caller asked for — `update-note`, `create-note`. These are the only note
  tools vault 0.7.9 has; there is no `read-notes`, `get-note`, `search-notes`,
  `semantic-search`, `get-links`, `create-link`, `delete-link`, `batch-tag`.
- **Prism MCP** with Benjamin's token (`prism-rw` profile, or a Read & write
  token from Prism → Settings → Account → Connect your agent):
  `prism_people_review_queue`, `prism_people_file_review`,
  `prism_people_duplicates`, `prism_people_recommend_merge`. Without it, list
  AMBIGUOUS items and duplicates in your output instead of filing them.

## Limits

- Every list query: `limit` ≤ 25, `include_content: false`, and
  `include_metadata` naming only the fields you compare. Never page through a
  whole tag to build an index.
- Read a candidate's body only when you must, with `content_length` ≤ 6000.
- ≤ 5 candidate lookups per entity.

## Where notes live

- People: `vault/people/<Name>` (tag `person`). Not `person/…`.
- Organizations: tag `organization`; projects: tag `project`; meetings:
  `vault/meetings/<date>/<title>` (tag `meeting`); transcripts: tag
  `transcript`.
- Check `vault-info` once for the current tags if the entity type is unusual.

## Tombstones (merged people)

A `person` note tagged `merged-stub` or `superseded`, or with `status:
merged_into_canonical`, is a merged duplicate. Never match TO it: follow
`metadata.merged_into` (a note id or path, `[[…]]` allowed; follow chains,
stop on a loop) and match the live note. If the pointer leads nowhere, treat
the entity as AMBIGUOUS. A note that merely carries a `merged_into` pointer
without one of those markers is still a live person.

## Matching, in order (stop at the first decisive result)

For a **person**:

1. **Strong key** — the entity's email, Matrix id (`@x:server`), Telegram
   handle/id, or international phone (`+…`):
   `query-notes { tag: "person", search: "<address or id>", limit: 5, include_metadata: ["name","email","emails","channels","matrix","telegram","phone","merged_into","status"] }`
   and confirm the key literally appears in the returned metadata.
   Exactly one live person (after following tombstones) → **MATCH**. Two or
   more → **AMBIGUOUS** (it is probably a duplicate pair — see below).
2. **Exact path** — `query-notes { path: "vault/people/<Full Name>", include_content: false }`.
   One live note → MATCH only if a second signal agrees (same organization,
   or the entity's context names the same project/meeting the note is linked
   to). Otherwise AMBIGUOUS.
3. **Name** — `query-notes { tag: "person", search: "<full name>", limit: 10, include_metadata: ["name","aliases","organization"] }`.
   A name is never decisive on its own: one hit → AMBIGUOUS with that one
   candidate unless a second signal agrees (same organization or a shared
   linked note via `query-notes { near: { note_id: <candidate>, depth: 1 }, limit: 25 }`).
   Several hits → AMBIGUOUS with all of them. Single-token names ("Sam") are
   always AMBIGUOUS.
4. Nothing found → **CREATE**, only if the entity is clearly a real human
   with a full name; a first name only, a role mailbox, a bot or a group is
   never created.

For an **organization / project / concept**: exact path or exact name
(`query-notes { tag, search, limit: 10 }`, compare `name` and `aliases`
case-insensitively) → MATCH; several → AMBIGUOUS; none → CREATE.

Never match across types: a person and an organization with the same name are
different entities.

## Output (one line per entity)

```
MATCH      <type> "<canonical name>" → <note id> (<path>)   evidence: <key or signals>
CREATE     <type> "<canonical name>" → vault/people/<Name>   evidence: <why it is new>
AMBIGUOUS  <type> "<canonical name>" → candidates [<id>, <id>]   evidence: <what is missing>
```

then a short summary (counts of each).

## What happens to each result

- **MATCH** — the caller links its source note to the matched note using a
  **canonical** relationship (`attended-by`, `email-from`, `email-to`,
  `messages-with`, `assigned-to`, `belongs-to`, `member-of`, `works-at`,
  `references`, `related-to`) in the right direction, with
  `update-note { id: <source>, if_updated_at, links: { add: [{ target, relationship }] } }`,
  after checking the link does not already exist.
- **CREATE** — only when the calling workflow allows creating notes. For a
  person, prefer filing instead: `prism_people_file_review` with no
  candidates (the owner creates the person). Never create a person whose name
  matched anyone.
- **AMBIGUOUS** — for a person on a record (meeting, email, thread, task):
  `prism_people_file_review { source_note_id, relationship, key: { kind: "name" | "email" | …, value }, display, candidate_ids, rationale }`.
  Otherwise list it for the owner.
- **Duplicates noticed** (two live person notes for one human, e.g. a strong
  key on both): check `prism_people_duplicates`; if the pair is detected and
  the evidence is strong, `prism_people_recommend_merge { person_ids, canonical_id, rationale, confidence }`.
  This only records a recommendation; the owner merges in Prism.

<!-- field-shapes:begin contract=v1 sha256=df82b8ed9815 · GENERATED from vault-shapes.json — do not edit by hand -->
## Field shapes (bind hard — every note you create or update)

The vault validates these shapes; a wrong one is a warning on that note forever and breaks Prism's database views. This block is generated from the approved schema (Prism `packages/core/src/lib/schemas/vault-shapes.json`); the write guards and the daily vault lint enforce the same rules.

- LIST fields are lists, and an empty list is ABSENT: never write `""` (or `" "`, or `[""]`) to a list field. Nothing to say → leave the key out; to clear a list, write `[]`. One value is still a list: `["[[…]]"]`. The list fields — person: `organizations`, `projects`, `aliases`; organization: `people`, `projects`, `aliases`; project: `collaborators`, `aliases`, `keywords`; concept: `aliases`, `related`, `sectors`, `scales`; briefing: `projects`, `people`; meeting: `projects`, `attendees`, `concepts`, `organizations`; transcript: `projects`, `attendees`; research: `projects`; decision-record: `participants`; grant-application: `collaborators`; message-thread: `participants`, `participantIds`.
- No empty scalars either: omit a field you have no value for (`source`, `role`, `contact`, `confidence`, `due`, …) instead of writing `""`.
- Project links point at the project NOTE, never the folder: `[[vault/projects/<slug>/PROJECT]]`. `[[vault/projects/<slug>]]` resolves to nothing. Only link a project slug that already has that note (query-notes { id: "vault/projects/<slug>/PROJECT" }); otherwise mention it in prose.
- People links point at an EXISTING person note path you looked up; never invent `[[vault/people/<Title Name>]]`.
- Keep what you write linked: a meeting, transcript, briefing or research note names its people and projects in the list fields above (`attendees` / `people` / `projects`) as links to those existing notes — that is what keeps the vault connected.
- `confidence` on person / project / organization / concept is a label: `high`, `medium` or `low` (never a number).
- Task `status` (only when you touch an existing task): `pending`, `in-progress`, `blocked`, `waiting`, `completed`, `cancelled`, `archived` (`todo`/`done` only on ClickUp mirrors). Status lives in metadata, never as a tag.
- meeting / transcript `source`: one lower-case word — `fathom`, `meetily`, `fireflies`, `voice`, `calendar` or `manual`; leave an existing `source` exactly as it is.
- `recording_id` is text (`"12345"`, quoted), never a number. Spec `version` is text too (`"1.2"`). `lastMessageAt` on message threads is epoch milliseconds (an integer) — and is owned by the ingester: do not write it.
<!-- field-shapes:end -->

The extractor's 0.0–1.0 score maps to the `confidence` label: ≥ 0.8 high, ≥ 0.5
medium, else low. Prism's server guard (`apps/server/src/vault-shapes.ts`) and the
agent's (`scripts/vault_shapes.py`) enforce the block above on their own writes; a
direct vault MCP write is NOT guarded, so the block is the rule there.

## Never

- Never merge, never write `merged_into` / `merged-stub`, never delete a note,
  never move links between notes. (The old "auto-merge above 0.85" rule is
  gone: false merges destroy information.)
- Never use `force: true`; every update carries `if_updated_at`.
- Never invent a relationship name or a tag.
- Never link on a name alone.
- Always record which source note produced each operation.
