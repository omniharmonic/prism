# Vault health report

Prepared for Benjamin Life · 2026-10-08 · Parachute vault `default` (production)

**Method.** Read-only. Tools used: `vault-info` (stats only, no description write), `list-tags` data (via vault-info), `query-notes` (lists capped at 100, no content, short metadata field lists, `aggregate: count`), `doctor` (non-deep). Nothing was written. Samples are the newest 100 notes per tag unless noted (tags with fewer notes were read in full). This report has no note bodies, email subjects or message text. It holds only paths, tag and field names, counts, value *shapes*, and enum values.

**Recommendation key.**
- **SCHEMA**: change the tag schema so it matches what the data actually is. This is a cheap, reversible schema write that needs an admin token. It changes no notes.
- **MIGRATION**: rewrite notes. Every migration in this report **needs Benjamin's approval + a backup first**, and must run as a dry run first. Writes must be CAS (`if_updated_at`) and must respect ingest ownership, so a writer like `proton_mail.py`, the Matrix ingester or ClickUp does not overwrite the fix.
- **WRITER FIX**: change the code that produces the data, so new notes come out right whichever of the two options above is picked.

---

## 1. Overview

| Metric | Value |
|---|---|
| Notes | 14,826 |
| Tags in use | 944 (29 have schemas; one indexed field: `task.priority`) |
| Links | 12,958 |
| Content | ~115 MB |
| Attachments | 0 |
| Notes with no path | 0 |
| Version-history storage | ~59 MB in 1,618 whole blobs. The largest single history is 16.6 MB (100 versions) for one note. |

**Path buckets:**

| Bucket | Notes |
|---|---|
| `vault/` | 14,558 |
| `wiki/` | 201 |
| `_test/` | 22 |
| `_templates/` | 13 |
| `projects/` | 10 |
| `_inbox/` | 9 |
| `Notes/` | 8 |
| `omniharmonic/` | 5 |

The small top-level buckets (`projects/`, `_inbox/`, `Notes/`, `omniharmonic/`) sit outside the `vault/` convention. They look like legacy import leftovers.

**Growth by month:** 2026-04 2.3k · 05 1.1k · 06 2.1k · 07 1.4k · 08 3.8k · 09 3.1k · 10 (8 days) 0.9k.

**Top tags:**

| Tag | Notes |
|---|---|
| `triaged` | 4,586 |
| `email` | 3,735 |
| `agent-dispatch` | 2,613 |
| `agent-output` | 2,595 |
| `informational` | 2,028 |
| `meeting` | 1,849 |
| `task` | 1,755 |
| `low` | 1,585 |
| `message-thread` | 1,340 |
| `processed` | 1,139 |
| `archived` | 1,111 |
| `action-required` | 1,100 |
| `person` | 1,036 |
| `transcript` | 938 |
| `todo` | 681 |
| `fathom` | 654 |

**Tag sprawl.** There are 944 tags, and most are used by one or two notes (topic tags written by agents). Several *status words* are used as tags as well as metadata: `todo`, `done`, `in-progress`, `archived`, `tracked`, `proposed`, `processed`, `stale`, `blocked`, `waiting`. Status therefore lives in two places that can disagree.

**Recommendation (later, low priority):** pick one place for status (metadata). Then retire the status tags by MIGRATION *(needs Benjamin's approval + backup)*.

---

## 2. Schema conformance by tag

Warnings are the vault's own `validation_status`. The counts below are the number of notes in the sample that carry each warning.

### message-thread (sample 100 newest; 99 have warnings)

| Field | Problem | Count |
|---|---|---|
| `lastMessageAt` | type mismatch: schema `string`, data is a **number** (epoch ms) | 99/100 |
| `participants` | type mismatch: schema `string`, data is an **array** | 98/100 |
| `platform` | enum mismatch | 26/100 |

- **`platform` values in the sample:** `telegram` 72, `matrix` 24, `twitter` 2, `whatsapp` 1.
- **The enum is** `whatsapp|telegram|signal|discord|email`. `matrix` and `twitter` are outside it.
- **SCHEMA (recommended):**
  - `participants` → `array`.
  - `lastMessageAt` → `integer` (epoch ms is what the Matrix ingester and Prism's code expect, `metadata.lastMessageAt` monotonic).
  - Add `matrix` and `twitter` to the `platform` enum (also consider `slack` and `instagram` if the bridges carry them).
  - A migration is the wrong direction here: the live ingester rewrites these fields on every append.

### email (sample 100 newest; 0 warnings)

- All 100 are `source: proton-bridge`.
- `date` is an ISO string, `isUnread` is a boolean, `messageCount` is an integer.
- Healthy. The schema does not declare the ingest keys (`source`, `messageId`, `labels`, `mailbox`, `uid`, `account`, `to`, `lastMessageAt`).
- **SCHEMA (optional):** declare them, so Prism database views type them.

### meeting (sample 100 newest; 65 have warnings)

| Field | Problem | Count |
|---|---|---|
| `source` | `schema_conflict`: `meeting.source` (free string) vs `transcript.source` (enum); see §3 | 33 |
| `projects` | type mismatch: schema `array`, data is the **empty string `""`** | 32 |
| `recording_id` | number where the schema says string (older project meeting notes, seen in spot checks) | not counted |

- **Other shapes:**
  - `source` is `""` on 42 notes, `fireflies` on 33, and absent on 25.
  - `status` is `processed` 39 / `raw` 37 (both in the enum).
  - `event_status` is `confirmed` on 73.
- **MIGRATION** *(needs Benjamin's approval + backup)*: turn `projects: ""` into `[]`, or delete the key. These are writer artifacts: some ingest path writes an empty string for an empty list.
- **WRITER FIX:** emit `[]` or omit the key.
- **SCHEMA:** `recording_id` → string, or accept both, by recording the value as `string` in the writer.

### transcript (sample 100 newest; 84 have warnings)

- `source` `schema_conflict` with `meeting`: 83 notes. These carry both tags. See §3.
- `source` enum mismatch: 1 note, value `voice`. The enum is `fathom|meetily|fireflies`.
- **Shapes:** `projects` is a list of wikilinks (77/83). `attendees` is a list of wikilinks plus email strings. `date` and `synced_at` are ISO strings in 97/100 and 96/100.
- **SCHEMA:** add `voice` (and any other capture sources) to the enum, and resolve the conflict in §3.

### task (sample 100 newest; 81 have warnings)

- `status` enum mismatch: **81/100**.
  - **Actual values:** `pending` 73, `todo` 8, `waiting` 7, `done` 7, `in-progress` 4, `review` 1.
  - **The enum is** `todo|in-progress|blocked|done|cancelled`.
  - The live task system (`tasks_store.py`, the ledger) uses `pending|in-progress|blocked|waiting|completed|cancelled|archived`.
- `priority` is clean (`medium` 58, `high` 34, `low` 5, `critical` 3).
- `due` is `""` on 53 notes and an ISO date on 34 (no warning, because the field is a free string).
- **SCHEMA (recommended):** set the enum to the tasks_store vocabulary (`pending, in-progress, blocked, waiting, completed, cancelled, archived`). Keep `todo`/`done` only if old notes must still validate.
- Optionally declare `owner`, `deadline`, `deadline_source`, `source_ref`. These are written today but not declared.
- A data migration of the old `todo`/`done` values is optional, because tasks_store normalises them on read.

### person (sample 100 newest; 94 have warnings)

| Field | Problem | Count |
|---|---|---|
| `organizations` | schema `array`, data is a string | 89 |
| `aliases` | schema `array`, data is a string | 89 |
| `confidence` | schema `number`, data is a string | 89 |
| `projects` | schema `array`, data is a string | 84 |

- **What the strings are:**
  - The `organizations`, `aliases` and `projects` strings are almost all the **empty string `""`** (85/89/83).
  - `confidence` is a **label**: `high` 57, `medium` 25, `""` 7. 10 notes hold a float.
- The newest 100 are dominated by the Google Contacts takeout import (79 have `source` = google-contacts-takeout).
- `relationship_type`: `contact` 95, `collaborator` 4.
- **SCHEMA:** change `confidence` to `string` with enum `high|medium|low`. Labels are what every writer produces (people, project and organization notes all do this).
- **MIGRATION** *(needs Benjamin's approval + backup)*: turn the `""` placeholders into `[]`, or remove them. These are importer artifacts carrying no information.
- **WRITER FIX:** the Google Contacts import and the nightly weave should omit empty fields.

### project (all 37 notes; 35 have warnings)

| Field | Problem | Count |
|---|---|---|
| `confidence` | type mismatch: a string label or `""` | 33 |
| `aliases` | type mismatch: a string | 30 |
| `collaborators` | type mismatch: a string | 14 |
| `role` | enum mismatch | 27 |
| `status` | enum mismatch | 2 |

- **`role` values:** `lead` 7, `Contributor` 6, `Lead` 3, `contributor` 3, plus free-text roles such as "Co-Founder and Network Steward", "Track Lead", "Producer", "Steward", "Coordinator" and "Lead Developer". The enum is `lead|contributor|advisor|observer`.
- **`status` values:** `in-progress`, `draft-v1`.
- **SCHEMA:** make `role` a free `string`. It describes Benjamin's role in prose and an enum cannot hold it. Alternatively, add a separate `role_kind` enum. `confidence` → string label.
- **MIGRATION** *(needs Benjamin's approval + backup)*: lower-case `Lead`/`Contributor` if `role` stays an enum. Turn `""` into `[]`.

### organization (sample 100; 100 have warnings)

| Field | Problem | Count |
|---|---|---|
| `confidence` | type mismatch: all are strings | 97 |
| `aliases` | type mismatch | 85 |
| `people` | type mismatch | 62 |
| `projects` | type mismatch | 56 |
| `status` | enum mismatch | 4 |

- The type mismatches are almost all `""`.
- **`status` values:** `active` 90, `archived` 3, `""` 2, `merged_into_canonical` 2.
- **SCHEMA:** add `merged_into_canonical` to the enum, because the people/org merge flow writes it. `confidence` → string.
- **MIGRATION** *(needs Benjamin's approval + backup)*: `""` → `[]`.

### briefing (all 66 notes; 61 have warnings)

- `projects` and `people`: type mismatch on 54 each. They are `""` on 54 and lists of slugs or names on 10.
- `date` `schema_conflict` with `report`: 8 notes (see §3).
- **MIGRATION** *(needs Benjamin's approval + backup)*: `""` → `[]`. The briefing producer is retired, so this is cosmetic. **SCHEMA** alternative: none needed.

### report (sample 100 newest; 20 have warnings)

- `status` `schema_conflict` with `spec` or `research`: 14.
- `date` `schema_conflict` with `briefing`: 8.
- `date` type mismatch: 2. `report.date` is declared type `date` and two values are not ISO.
- `status` enum mismatch: 1, value `draft v0.1`.
- `processed-by` is an email string on 66 notes and plain text on 30.
- **SCHEMA:** see §3. **MIGRATION** of the 3 odd values is trivial *(approval + backup)*.

### agent-insight (sample 100; 1 has a warning)

- The one warning is a `date` `schema_conflict` with `report`. Otherwise healthy (ISO dates on 95/100).

### capture

- **1 note** carries `capture`. The schema is empty; nothing to fix. Consider retiring the tag, or wiring Prism quick-capture to it.

### page (2 notes, both under `wiki/about/`; 0 warnings)

### writing (all 83 notes; 51 have warnings)

- `published`: type mismatch on 50. The schema says `date`; the value is `""` or non-ISO text. 32 are ISO.
- `status` enum mismatch: 5 notes `active`, 2 notes `archived`. Note that `archived` *is* in the writing enum: these warnings come from the *task* enum on notes that also carry `task`.
- **`status` values:** `published` 62, `draft` 13, `active` 5, `archived` 2, `processed` 1.
- **MIGRATION** *(approval + backup)*: `published: ""` → remove the key.
- **SCHEMA:** add `active`, or map it to `editing`.

### spec (all 50 notes; 36 have warnings)

- `version` type mismatch: 36. The schema says `number`; 36 values are strings (e.g. `v1`-style). 8 are floats and 6 are integers.
- `status` values: `draft` 43, `review` 3, `active` 1, `approved` 1, `draft-v1` 1, `vision` 1.
- `status` `schema_conflict` with `report`/`research`/`project`/`proposal`: 16, on notes that carry several tags.
- **SCHEMA (recommended):** `version` → `string`. Version labels are strings by nature.

---

## 3. Cross-tag field conflicts

These are schema-level conflicts. When a note carries both tags, the vault keeps one spec and ignores the other, and emits `schema_conflict`.

| Field | Tag A | Tag B | Effect (sample) |
|---|---|---|---|
| `source` | `meeting`: free string. Values are `""` or `fireflies`, meaning "which recorder" | `transcript`: enum `fathom/meetily/fireflies` | **116 warnings**; every note tagged both `meeting` and `transcript` |
| `date` | `briefing`, `agent-insight`, `meeting`, `email`, `transcript`: `string` | `report`: `date` | 17 warnings (briefing+report, agent-insight+report) |
| `status` | 13 tags, each with its own enum: `task`, `project`, `meeting` (`raw/cleaned/processed`), `report`, `spec`, `research`, `writing`, `organization`, `proposal`, `script`, `slides`, `decision-record`, `grant-application` | (each pair) | ~25 warnings in the samples. `report` vs `spec`/`research` and `project` vs `research` are the commonest. **`meeting.status` is a processing state, not a lifecycle state.** |
| `participants` | `message-thread`: `string` | `decision-record`: `array` | Latent (no overlap seen); `message-thread` is wrong anyway (§2) |
| `role` | `project`: enum | `person`, `organization`, `grant-application`: free string | Latent |
| `confidence` | `person`, `project`, `organization`, `concept`: `number` | (the data is string labels everywhere) | See §2 |

**Recommendations:**
- **`source` (SCHEMA):** give `meeting.source` the same enum as `transcript.source`, plus `calendar`, `voice` and `manual`. Alternatively, drop `source` from `meeting` and let `transcript` own it.
- **`date` (SCHEMA):** make every `date` the same type. `string` is the least disruptive, because `report` is the outlier. A real `date` type everywhere would be nicer for Prism date views, but it needs a check that every value is ISO (a few are not, see §2).
- **`status` (SCHEMA):** keep per-tag enums, but rename `meeting.status` to `processing_status`. That one is a MIGRATION *(approval + backup)*: it touches about 1.8k notes and the transcript pipeline writes the field, so the writer changes first.
- **Multi-tag notes (WRITER FIX):** where one note carries both a `status` enum tag and another `status` enum tag (`spec`+`report`, `project`+`research`), stop double-tagging.
- **`confidence` (SCHEMA):** standardise as a `string` enum `high|medium|low` across all four tags.

---

## 4. doctor findings

**3,803 findings: 0 errors, 0 warnings, 3,803 info.**

**`dead_tag_metadata_reference` (3,801 findings, heuristic).** A metadata value looks like a stale tag name.

| Field | Findings | Notes affected | Note |
|---|---|---|---|
| `metadata.subject` | 2,712 | 3,747 | False positive: email subjects that are not tags. |
| `metadata.contact` | 318 | 324 | False positive: addresses. |
| `metadata.requester` | 224 | 1,013 | Person names; legacy Notion tasks, e.g. `Notion (OpenCivics)`. |
| `metadata.assigned` | 193 | 881 | Person names. `Benjamin` vs `Benjamin Life` both appear, an identity inconsistency. |
| `metadata.projects` | 110 | 152 | **Real signal:** project names that are not tags. |
| `metadata.project` | 72 | 265 | **Real signal:** same. |
| `metadata.type` | 72 | 293 | **Real signal:** e.g. `review` (43 notes), `decision` (26). |
| `metadata.skill` | 2 | 2,555 | False positive: `message-classify`, `clickup-task-triage`. |
| `confidence`, `project_match_confidence`, `source_store`, `fireflies_delete_status` | | | Small, mostly false positives. |

**History.**
- `deleted_note_history`: 5 version rows (about 0.95 MB) remain for notes that no longer exist.
- `history_storage`: about 59 MB, dominated by a few notes with 100-version histories of 3–16 MB each. These are likely large message threads, which matches the Matrix-rollover design in Prism.

**Recommendations:**
- None of the `dead_tag_metadata_reference` findings is a data-integrity error. **No action, except:**
  - The `assigned`/`requester` identity drift (`Benjamin` / `Benjamin Life`). Configure the Prism owner aliases instead of rewriting.
  - Whether `metadata.type: review|decision` should become tags. That is a MIGRATION *(approval + backup)*; it is low value.
- **History:** the vault's own daily compaction (`worker/history-compact.ts`) already bounds history growth. Nothing to do now.

---

## 5. Duplicates

| Set | Count |
|---|---|
| Notes tagged `duplicate` (exact tag) | **63** |
| …of which are under `vault/_inbox/transcripts/fireflies/` | **23** |
| Person tombstones (`merged-stub`) | **105** |

- 4 of the `duplicate`-tagged notes have broken links and 19 are orphans (from the rollups).
- Tombstones are expected output of the merge flow. Prism hides them from `/api/people`.
- **Recommendation:** review the 63 `duplicate` notes and, once confirmed, trash them through Prism's Trash so they stay restorable. That is a MIGRATION *(needs Benjamin's approval + backup)*. The 23 Fireflies inbox duplicates are the safest first batch.

---

## 6. Broken and ambiguous links

**Notes with at least one broken link: 283.**
- In the newest 100 of them there are 224 dangling targets, all `wikilink`.
- 177 (79%) are path-like and 47 are bare names.
- **Where the sources live:** `vault/tasks/active` (12), `vault/projects/opencivics` (8), `vault/projects/spirit-of-the-front-range` (7), `vault/projects/bioregional-coordination` (7), `vault/projects/regen-commons` (7), `vault/projects/trustgraph` (5).
- **By tag:** `meeting` 130, `processed` 132, `transcript` 53, `task` 50, `archived` 43, `fathom` 38, `opencivics` 32, `person` 31.

**Top dangling targets, grouped:**

| Pattern | Count (sample) | Cause |
|---|---|---|
| `vault/projects/<slug>` (a folder) | 28 (e.g. `schelling-point` ×9, `opencivics` ×8, `spirit-of-the-front-range` ×4, `bioregional-coordination` ×2, `bioregional-foodchain-design` ×2, `clawsmos` ×2) | Project notes live at `vault/projects/<slug>/PROJECT`, so a link to the folder resolves to nothing. |
| `vault/people/<Title Name>` | 31 (one target ×7, one ×5, one ×4, several ×2–3) | The person was never created, or exists under a slug path (`vault/people/<slug>`). Both conventions coexist. |
| `vault/research/…` | 31 | Research notes moved or never written. |
| `vault/organizations/<Name>` | 5 (one org ×5, one ×2) | Org notes under other names. |
| `wiki/concepts/…`, `concepts/…` | 7 | Concept notes moved under `wiki/`. |

**Ambiguous links: 1 note.** It is a `_test/` fixture whose target matches 2 notes. Ignore it.

**Recommendations:**
- Mostly a **WRITER FIX** in the transcript pipeline and the nightly weave:
  - Link projects as `[[vault/projects/<slug>/PROJECT]]`.
  - Link people to an *existing* note path only.
- For the existing notes, either:
  - add a resolver alias, by giving each `PROJECT` note `aliases: ["vault/projects/<slug>"]` (SCHEMA/metadata only; check that vault 0.7.9 resolves aliases for path links before relying on it), or
  - rewrite the links (MIGRATION, *needs Benjamin's approval + backup*). Prism's owner-only wikilink job does **not** rewrite content, so this would be a separate, dry-run-first rewrite.

---

## 7. Untagged and orphan notes

**Untagged notes: 395.** Paths in a sample of 100:

| Path | Notes |
|---|---|
| `vault/projects/cri/…` | 14 |
| `vault/projects/bioregional-food-chain/…` | 8 |
| `vault/projects/dacc-research/…` | 7 |
| `vault/_inbox/documents` | 3 |
| `vault/projects/civic-innovator-crm` | 3 |
| `vault/projects/deac` | 3 |
| `_templates/*` | 5 (PROJECT, meeting, organization, person, task) |
| `_inbox/transcripts/…`, `vault/_staging/…`, `vault/_inbox/PROCESSING-SUMMARY…` | the rest |

Most are project working files (outputs and research). They are reachable by path but invisible to every tag-driven view.

- **Recommendation:** a MIGRATION *(approval + backup)* to tag project files with their project slug, plus `research` or `document`. Leave `_templates/` untagged on purpose.

**Orphans (no inbound or outbound links): 9,503 (64%).** Rollup by tag (membership, so the counts overlap):

| Tag | Orphans |
|---|---|
| `triaged` | 3,628 |
| `email` | 2,818 |
| `agent-dispatch` | 2,613 |
| `agent-output` | 2,573 |
| `informational` | 1,568 |
| `low` | 1,480 |
| `message-thread` | 1,169 |
| `task` | 857 |
| `action-required` | 638 |
| `archived` | 605 |
| `meeting` | 506 |
| `todo` | 503 |
| `promise` | 320 |
| `proposed` | 263 |
| `person` | 139 |
| `google-contact` | 139 |
| `meeting-prep` | 109 |
| `agent-insight` | 112 |
| `report` | 99 |

- Agent dispatch/output notes are orphans by design, as run logs.
- The important gaps are **email (2,818), message-thread (1,169), meeting (506) and person (139)**. These mean the people-linking layer (Prism `/api/admin/people/link`, `MATRIX_LINK_EXISTING`, `PROTON_LINK_PEOPLE`) has not run, or is off.
- **Recommendation:** run Prism's people-link job as a *dry run* first. Prism's People tab already resolves these at read time, so linking is an enrichment, not a fix. A write run is a MIGRATION *(needs Benjamin's approval + backup)*.

---

## 8. Relation fields (input for a Prism "relation bound to a tag" field)

These are value shapes for fields that point at projects or people.

| Tag.field | Notes with key | Shape |
|---|---|---|
| `meeting.projects` | 76 | list of `[[vault/projects/<slug>/PROJECT]]` (42 lists, 40 elements); `""` on 32; 2 bare slugs |
| `transcript.projects` | 83 | list of `[[vault/projects/<slug>/PROJECT]]` (80 elements); 1 comma-string; 1 plain name |
| `task.project` | 88 | **bare slug** 64 (e.g. `spirit-of-the-front-range`), plain project name 13, `""` 11. Never a wikilink. |
| `spec.project` | 50 | `""` 31, bare slug 13, wikilink to `…/PROJECT` 5, wikilink to the folder 1 |
| `person.projects` | 99 | `""` 83; list of `…/PROJECT` wikilinks 10 |
| `organization.projects` | 97 | `""` 56; list of wikilinks, **mostly to the folder `vault/projects/<slug>`** (29, which dangle) vs `…/PROJECT` (8); 4 plain names |
| `briefing.projects` | 64 | `""` 54; lists of bare slugs (16) or names (3) |
| `meeting.attendees` | 99 | list mixing **email addresses** (307), `[[vault/people/<Title Name>]]` (68), plain names (31), `[[vault/people/<slug>]]` (1) |
| `transcript.attendees` | 96 | `[[vault/people/<Title Name>]]` (173), emails (105), slug wikilinks (4), names (2) |
| `organization.people` | 97 | `""` 61; `[[vault/people/<Title Name>]]` 39; `[[<bare name>]]` 7 |
| `project.collaborators` | 37 | plain names 13, `[[vault/people/<Title Name>]]` 10, `""` 14 |
| `project.org` | 37 | `[[vault/organizations/<x>]]` 9, `""` 25, raw path 1, plain name 1 |
| `task.assigned` | 88 | plain name (86): `Benjamin`, `Benjamin Life`, other people. Never a link. |
| `message-thread.participants` | 98 | array of display names (not links, not ids) |

**What this means for the relation feature:**

1. **Four encodings coexist:**
   - full-path wikilink: `[[vault/projects/<slug>/PROJECT]]` or `[[vault/people/<X>]]`
   - folder wikilink, which dangles
   - bare slug: `task.project`, `spec.project`
   - plain display name: `task.assigned`, `attendees`

   A relation field must **read all four**. Resolve them in this order:
   1. wikilink path, exact
   2. wikilink path + `/PROJECT`
   3. `vault/projects/<slug>/PROJECT` for a bare slug
   4. name or alias match against the target tag's notes; ambiguous counts as unresolved, and a name never silently links

   It should **write one** form: the full-path wikilink, the convention the transcript pipeline already uses for 80/83.
2. **`""` is everywhere as "empty list"** (person, organization, briefing, meeting). A relation reader must treat `""` as empty. A relation writer should write `[]` or omit the key.
3. **Scalar vs list:**
   - `task.project`, `spec.project` and `project.org` are single-valued.
   - Everything plural (`projects`, `attendees`, `people`, `collaborators`) is a list.
   - The relation hint needs a `multiple` flag rather than inferring from the vault type, because `task.project` is declared `string`.
4. **People targets are split** between `vault/people/<Title Name>` (older notes, the majority in links) and `vault/people/<slug>` (Prism-created). Resolve via Prism's identity layer (`IdentityIndex`) rather than by path string, and follow `merged-stub` tombstones.
5. **Attendees mix email addresses with links.** An email element should resolve through the person's `email`/`contact` identity, not be treated as a dangling name.

**Recommended path:**
- Ship the relation feature as a READ-tolerant **presentation hint** (`relationTag` already exists in Prism's schema-ui hints). Run no migration first.
- Normalising existing values to the full-path wikilink form is an optional later MIGRATION *(needs Benjamin's approval + backup)*. It is best done per field with the Prism conversion-job pattern (dry run, CAS, counts-only audit). Start with `task.project` (88 sampled, bare slugs, mechanical) and `organization.projects` (folder links → `/PROJECT`, which also fixes broken links).

---

## Priority summary

| # | Action | Type | Effort / risk |
|---|---|---|---|
| 1 | `message-thread`: `participants`→array, `lastMessageAt`→integer, `platform` enum + `matrix`/`twitter` | SCHEMA | Trivial; clears ~99% of thread warnings |
| 2 | `task.status` enum → tasks_store vocabulary | SCHEMA | Trivial; clears ~81% of task warnings |
| 3 | `confidence` → string label enum (person, project, organization, concept); `spec.version` → string; `project.role` → free string | SCHEMA | Trivial |
| 4 | Unify `meeting.source`/`transcript.source`, and the type of `date` across tags | SCHEMA | Low |
| 5 | Writers emit `[]` or omit the key, never `""`, for list fields (Google Contacts import, weave, transcript pipeline, briefing) | WRITER FIX | Low |
| 6 | Project links → `…/PROJECT`; people links only to existing notes | WRITER FIX | Medium |
| 7 | Clean `""` list placeholders; normalise relation values; fix folder project links | MIGRATION, **needs Benjamin's approval + backup** | Medium |
| 8 | Review and trash the 63 `duplicate` notes (23 Fireflies first) | MIGRATION, **needs Benjamin's approval + backup** | Low |
| 9 | People-link job (dry run first) to cut email/thread/meeting orphans | MIGRATION, **needs Benjamin's approval + backup** | Medium |
| 10 | Tag the 395 untagged project working files | MIGRATION, **needs Benjamin's approval + backup** | Low |

Note: tag-schema writes need a `vault:default:admin` token (vault ≥0.7.1). Prism's `PUT /api/schemas/:tag` is additive-only and refuses type changes, so items 1–4 must go through the vault's `update-tag` with an admin token, not through Prism.
