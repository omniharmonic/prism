# Relation-target backfill — dry run against the production vault (2026-10-08)

Read-only. Inputs: `list-tags {include_schema:true}` from the production vault (996 tag rows → 29 tags with a schema or description, 26 with fields), fed to the real `planRelationTargets` (`packages/core/src/lib/database/schema.ts:939`) exactly as `POST /api/schemas/relation-targets` does (`vaultSchemas` row filter + `present()` + `LOCKED_TAG` skip). **Existing schema-ui hints (Prism SQLite) were assumed EMPTY** — the production DB was not reachable, so `alreadySet` = 0 here; on the server any field the owner already targeted would be left alone. Nothing was written anywhere.

## Plan: 26 proposals, 1 unresolved, 0 already set

| Tag | Field | Vault type | Kind | Proposed target | Verdict |
|---|---|---|---|---|---|
| briefing | projects | array | relation | project | ok |
| briefing | people | array | person | person | ok |
| dashboard | project | string | relation | project | ok |
| decision-record | project | string | relation | project | ok |
| decision-record | participants | array | person | person | ok |
| grant-application | org | string | relation | organization | ok (description: "granting organization") |
| grant-application | collaborators | array | person | person | ok |
| index | project | string | relation | project | ok |
| meeting | projects | array | relation | project | ok — 98 % resolve |
| meeting | attendees | array | person | person | ok — 52 % resolve (see below) |
| message-thread | participants | string (stored as array) | person | person | **questionable** — 8 % resolve |
| organization | people | array | person | person | ok |
| organization | projects | array | relation | project | ok |
| person | organizations | array | relation | organization | ok — 36 % resolve (free text) |
| person | projects | array | relation | project | ok — 100 % resolve |
| person | contact | string | person | person | **FALSE POSITIVE** |
| project | org | string | relation | organization | ok |
| project | collaborators | array | person | person | ok |
| project-update | project | string | relation | project | ok |
| proposal | project | string | relation | project | ok |
| research | projects | array | relation | project | ok |
| script | project | string | relation | project | ok |
| slides | project | string | relation | project | ok |
| spec | project | string | relation | project | ok |
| task | project | string | relation | project | **mixed** — 63 % resolve; ClickUp list names |
| task | assigned | string | person | person | ok — 24 % resolve |

Unresolved: `concept.related` (array) — "no tag matches this name". Correct to leave for the owner; the natural target is `concept` itself (self-relation), which the name rule cannot know.

## Value resolution check (real `resolveRelationValue` + `buildRelationIndex`, candidates built with the verbatim `candidateOf` from `hooks.ts:313`)

Targets indexed: project 37 notes, organization 114, person 1,036. "10" = the 10 newest notes with a value; "wider" = all notes with a value in the fetched sample (meetings 300, tasks 60, persons 80, threads 200 newest).

| Field | 10-note rate | Wider rate (values) | Encodings seen | Main cause of misses |
|---|---|---|---|---|
| meeting.projects → project | 100 % (10/10) | 98 % (149/152) | full-path wikilink 144, slug 5, raw path 2, name 1 | 2 raw paths + 1 name with no project note |
| person.projects → project | 100 % | 100 % (11/11) | full-path wikilink 9, slug 2 | — |
| meeting.attendees → person | 78 % (18/23) | 52 % (753/1456; 100 ambiguous) | email 1143, full-path wikilink 215, name 98 | 50 distinct addresses (529 values) have no person note at all — expected; 46 more values only match an address stored under `channels.*`, which `candidateOf` does not read |
| task.project → project | 50 % (5/10) | 63 % (26/41) | slug 28, "raw path" 8, name 5 | values are ClickUp list names ("Sprint 6 (10/6 - 10/20)", "Product Milestones"); the `/` in a sprint date range sends them down the path branch |
| task.assigned → person | 30 % (3/10) | 24 % (11/46) | name 46 | "Benjamin" (28 of 46) is not a person title or alias; the owner's aliases live in the identity layer, not in `metadata.aliases` |
| person.organizations → organization | 36 % (4/11) | 36 % | name 11 | free text ("X (inferred from email domain)", "A; B; C" in one string) |
| message-thread.participants → person | 25 % (15/60) | 8 % (370/4845) | display name 4366, slug-like 452 | display names, bridge bots, "omni-agent", deleted accounts |

Hints never rewrite values, so a low rate is only "shown as its text", never data loss.

## Findings / proposed fixes (no code changed)

1. **False positive `person.contact` → person.** `PERSON_TARGET_NAMES` (`packages/core/src/lib/database/schema.ts:258`) matches `contacts?`, and `PERSON_KEYS` (`:247`) contains `contact`. On a `person` note `contact` is "Email or primary contact method" — the person's own address (and `candidateOf` already reads it as an email). Fix: drop `contacts?`/`contact` from both, or have the planner skip a field whose proposed target equals its own tag when the name is singular (`person.contact`), or skip fields whose description/sample values look like addresses. Owner action now: exclude it.
2. **`message-thread.participants`** is ingest-owned display names (schema says comma-joined string; values are arrays). Making it a person relation is harmless but resolves 8 %. Suggest the planner skip `INGEST_TAGS`, or leave this field unresolved.
3. **`task.project`** mixes Prism slugs with ClickUp list names on ClickUp mirrors. Acceptable as a hint; note that `resolveRelationValue` (`relations.ts:118`) treats any value containing `/` as a path — a name with a slash can never resolve by name.
4. **Resolution gaps (not inference bugs):** `candidateOf` (`packages/core/src/lib/database/hooks.ts:313`) ignores `metadata.channels.email` and `metadata.name`; the server `PeopleIndex` reads `channels.*`. Adding `channels.email` would lift `meeting.attendees`. Owner aliases ("Benjamin") are not in person metadata.
5. Not tested: the planner's behaviour with existing hints (assumed none).
