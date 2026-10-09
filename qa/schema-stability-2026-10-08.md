# Keeping the vault schema stable and the vault linked

Prepared for Benjamin Life · 2026-10-08 · phase close after the schema clean-up (`qa/vault-migrations.md`).
Scope: both repos (Prism, `omniharmonicagent`). Everything here was done on the laptop, in code, docs and tests. Nothing touched the Mini, the live vault or any cloud routine.

## In plain words

**The question.** The vault was cleaned today. What stops it from drifting again, with no one reviewing it by hand?

**The short answer.** Three things write to the vault: Prism's server, the agent repo's Python scripts, and AI agents that talk to the vault directly. The first two had a guard. The third had none, and it is the one that caused most of the old drift. This work closes what can be closed in code and makes the rest visible within a day.

**What was wrong.**

1. **The rules were copied by hand into three places** (Prism's guard, the agent's guard, two routine prompts). Six of the eight routines had no rules at all. One of them (`meeting-prep`) was told to write `attendees` as one comma-separated string.
2. **AI agents write past every guard.** Cloud routines, the claude.ai connector, Claude Code and Prism's own hosted agents talk to the vault directly. No code checks what they send. Prism's hosted agents were never told the rules.
3. **The owner's own path is not guarded.** Anything an owner or admin sends through Prism is forwarded untouched, by design. That included Prism's own agent tools (`prism_create_note`, `prism_update_note`) when the owner's agent used them.
4. **The guards were weaker on updates than on creates.** On an update the guard does not know what kind of note it is, so most rules do not run.
5. **The daily check was slow and partial.** It looked at 12 of 29 schema'd tags. It alerted only when more than 20% of a tag's newest 100 notes were wrong. A routine writing 3 bad notes a night would never trip it. It did not say who wrote the bad notes. It did not measure links at all.
6. **An old script could undo today's work.** `apply_tag_schemas.py` in the agent repo would have re-declared five corrected fields from a stale doc.
7. **Nothing keeps new notes linked.** Every forward-linking switch is off on the Mini. Only ClickUp tasks get a project, and it is a list name, not a link.

**What is now in place (two PRs, not merged).**

1. **One rulebook file**, the field-shape contract. Both guards load it. The prompt block is generated from it. Tests fail when the schema files, the guards and the prompts disagree.
2. **Every prompt that writes notes carries the generated block**: all eight routines, the agent's `CLAUDE.md`, Prism's hosted agents, and the repo skills. A check fails when a block is missing, stale or edited by hand.
3. **Prism's agent tools now pass the guard** for the owner too.
4. **The daily check covers every schema'd tag**, reports notes written wrong since yesterday (`fresh`), and names the writer.
5. **A new daily link check** measures how many recent meetings, transcripts, tasks, emails and threads are linked to people and projects, and how many links point at nothing. It alerts when a measure falls well below its usual level. It is off until switched on.
6. **The old schema script now refuses** to run against the rulebook.

**What is still open** (needs your decision, listed at the end): the nightly self-heal, the forward-linking switches, the admin-level connector, and whether the vault itself should refuse wrong types.

**How fast would drift be noticed now?** Within one day for shape drift in any schema'd tag, with the writer named, once `VAULT_LINT_FRESH_MAX` is set. Within one day for a sharp fall in linking, once `LINK_HEALTH_ENABLED` is on. Notes in tags with no schema (for example `meeting-prep`, `agent-insight` bodies, `promise`) are still not checked.

---

## Part 1. Audit: every writer of the vault

How to read the tables. **Guard** means the write passes `shapeMetadata` (Prism) or `normalize_metadata` (agent repo). **Name rules** are the rules that work without knowing the note's tags: `""` in a list field is removed, list items are cleaned, `recording_id` becomes text. **Tag rules** need the tags: text to list, `confidence` label, task status words, `lastMessageAt`, `platform`, `source`, `version`.

### 1.1 What the vault itself checks

| Layer | What it does | Evidence |
|---|---|---|
| Parachute 0.7.9 at write time | Refuses (422, nothing written) only a wrong-typed value in an **indexed** field. Indexable types: text, integer, boolean, reference, date. Lists and numbers cannot be indexed. | Prism `CLAUDE.md`, "Parachute MCP". |
| Indexed fields on the live vault | One: `task.priority`. | The vault's own summary on the claude.ai connector. |
| Everything else | Stored as sent. A mismatch becomes a `validation_status` warning on the note. No refusal. | `qa/vault-health.md`. |
| Tag schema changes | Need an admin token. | Prism `CLAUDE.md`. |

So the vault does not protect itself. A direct write of `aliases: ""` or `confidence: 0.9` succeeds.

### 1.2 Paths that reach the vault with no guard at all

| Path | Who uses it | Guard | Gap |
|---|---|---|---|
| claude.ai connector (`mcp__claude_ai_parachute__*`) | All eight cloud routines, interactive Claude sessions | None | Prompt is the only prevention. The connector in this session also exposes `update-tag`, `delete-tag`, `merge-tags`, `prune-schema`, `manage-token`, which Parachute shows only to an **admin** token. A routine could change the schema itself. |
| Claude Code `.mcp.json` → vault MCP on `:1940` | Interactive sessions on the Mini | None | Same. (On this laptop the token is revoked, so it cannot write today.) |
| Prism hosted agents, profiles `vault-rw` (default) and `skill` | Agent chat, page actions, claude-routed skills | None: they use the raw vault MCP (`agent-profiles.ts:92`, `agent-exec.ts:233`) | Were not told the shapes. **Fixed in this PR:** the preamble now carries the rule. |
| Owner/admin passthrough `proxyToVault` (`routes/api.ts:670`) | The owner's web/desktop app, any admin | None, by design (bodies are forwarded as sent) | Stays. Typed-property edits go through `/api/properties`, which is guarded by name rules. |
| `prism_create_note` / `prism_update_note` for an owner/admin | Owner's MCP agents, `prism-*` profiles | Was none (dispatch ends in the passthrough) | **Fixed in this PR:** shaped in the tool. |
| Desktop app (Rust client) | Prism.app | None | Low volume now that the server ingests. Not changed. |
| Agent repo `fireflies_prune.py` raw REST fallback | Disabled job | None | Retired; left alone. |
| Agent repo swarm coordinator prompt (`swarm/coordinator.py:200`) | `/swarm launch` | None | Not changed. It reads `CLAUDE.md`, which now carries the block. |

### 1.3 Prism server writers (all go through `vaultClient`)

| Writer | Tags | Fields it writes | Conforms? | Links | Guard today | Gap |
|---|---|---|---|---|---|---|
| Matrix ingest (`worker/matrix.ts`) | `message-thread` | `platform` (lower case), `lastMessageAt` (integer), `participants` (list), `messageCount`, optional `participantIds` (list) | Yes | `messages-with` → person, only with `MATRIX_LINK_EXISTING` / `MATRIX_LINK_PEOPLE` (both off) | Create: full. Append: name rules | Threads are unlinked today. |
| Matrix rollover | archive tag | `archiveOf`, hashes, counts; `platform` may be `null` on create | Yes (not a schema'd tag) | body wikilinks | Name rules | None. |
| ClickUp mirror (`worker/clickup.ts`) | `task`, `clickup` | `status` (todo, in-progress, blocked, done, cancelled), `priority`, `assigned` (name), `project` (the ClickUp **list name**), `due`; `clickup_status` / `clickup_url` can be `""` | Shape yes. `project` is text that often is not a project (sprint names) | `assigned-to`, `belongs-to` only with `CLICKUP_LINK_ENABLED` (off) | Create: full. Update: name rules | 63% of task `project` values resolve to a project. `""` in `clickup_*` scalars. |
| Fathom ingest | `transcript`, `fathom` | `source`, `source_id`, `attendees` (list, can be `[]`), `attendeeEmails`, `fathom_url` (can be `""`) | Yes | `attended-by` only with `TRANSCRIPT_LINK_PEOPLE` (off) | Create only: full | Transcripts are unlinked until the evening routine runs. |
| Fireflies ingest | `transcript`, `fireflies` | as Fathom + `fireflies_*` (server-owned) | Yes | same | Create: full. `markNote`: name rules | Same. |
| Transcript ↔ meeting links (`transcript-links.ts`) | none | `transcriptNoteId(s)`, `meetingNoteId` (note ids) | Yes | `has-transcript` | CAS, user action only | Only when a person confirms the match. |
| Proton mail ingest | `email` | `from`, `to` (text), `labels` (list, never empty), `isUnread`, `lastMessageAt` (integer), ingest keys | Yes | `email-from` (`PROTON_LINK_PEOPLE`), `email-to` (`PROTON_LINK_RECIPIENTS`), both off | Create: full. Flag refresh: CAS | Emails are unlinked today. No `projects` ever. |
| Gmail ingest (off on the Mini) | `email` | as above, `platform: "email"` | Yes | `email-from`; **creates person notes** | Forced update | Off; not relevant while mail is Proton. |
| Calendar ingest | `meeting` | `attendees` (list of names or addresses), `attendeeEmails`, `event_status`, `date`; `location` / `meetLink` can be `null` | Yes | `attended-by` → person, always. **Creates person notes** for attendees with none | Create: full. Patch: name rules | The one ingester that links without a switch. No `projects`. |
| Person creation (`worker/people.ts`) | `person` | `name`, `channels`, `email` | Yes (no list placeholders) | none | Full | New people have no `organizations` / `projects`. |
| People link job, merge, identity review | — | links, `participantIds`, `merged_into`, `status: merged_into_canonical` | Yes | all kinds, strong keys only | CAS, capped, audited | Runs only when the owner starts it. |
| Wikilinks job | — | `references` links only | Yes | body `[[links]]` → links | CAS; owner-started | No write cap, no undo log. |
| Skill scheduler, structured skills | — | tags only (label, `triaged`, `triage-failed`) | Yes | none | n/a | None. |
| Skill scheduler, dispatch notes; agent session notes | `agent-dispatch`, `agent-output`, `agent-session` | run status fields | Yes (not schema'd) | none | Name rules | None. |
| Skill scheduler, **claude-routed skills** | whatever the skill prompt says | whatever the model writes | **Unknown** | **Unknown** | **None** (raw vault MCP) | Now told the rule in the preamble. |
| Alerts (`worker/health.ts`) | `alert` | `source`, `status`, `kind`, `at` | Yes | none | Full | None. |
| Typed properties (`/api/properties`), database tools | any | one or more metadata keys, CAS | Depends on the person; `""` is allowed | none | Name rules only | A person can type any value. The lint's `declared` check now reports enum breaks. |
| CSV import | one tag | mapped columns, coerced by the vault schema | Yes on create | none | Create: full. Update: name rules | None. |
| Import (`transfer/import.ts`) | from the file | the file's metadata + `prism_import` | As good as the file | none | Full (tags known) | None. |
| Vault mirror | source note's tags | copies metadata | As good as the source | none | Name rules | None. |
| GitHub / Notion sync | config tag | `title`, `source`; Notion properties | Not verified | none | Full on create | Notion builder not read. |
| Member gateway POST / PATCH | any | what the member sends | Create: yes. Update: name rules only | none | Create: full. Update: name rules | The PATCH has the note in hand but does not pass its tags to the guard. Specified in §2.1. |
| Governance | `governance-*` | signed metadata | n/a | n/a | Skipped on purpose (signature) | None. |

### 1.4 Agent repo writers (Python, all through `ParachuteClient`)

| Writer | Tags | Fields | Conforms? | Links | Guard today | Gap |
|---|---|---|---|---|---|---|
| `ParachuteWriter.upsert_person / organization / concept / project` | `person` … | lists as lists, `confidence`, `org` (one wikilink), project slug as a **tag** | Yes after today's fixes | slug wikilinks in metadata (`organizations`, `projects`, `collaborators`), never looked up | Create: full. Update: was name rules. **Now tag rules** (`shape_tags`) | Wikilinks are built from slugs; the target may not exist. Link health `dangling` now measures it. |
| `ParachuteWriter.upsert_meeting` | `meeting`, `transcript`, project-slug tag | `projects`, `attendees`, `concepts`, `organizations` (lists), `source`, `recording_id` (text) | Yes | slug wikilinks | same | Path style differs from the transcript routine (`<date>-<slug>` vs `<date>_<slug>`). |
| `ParachuteWriter.upsert_task` | `task` | `status` (canonical), `project` (wikilink) | Yes | `project` wikilink | same | Used only by `/ingest-meetings-auto`, which contradicts "no routine creates tasks". |
| `tasks_store.create_task / update_task` | `task` | `status` (own normaliser), `owner`, `deadline`, `project` (raw text), `context` (can be `""`) | Yes | none | Create: full. Update: **now tag rules** | Tasks have no project link. Different key set from `upsert_task` (`deadline` vs `due`). |
| `ledger.py` | `promise` | many scalars, several can be `""`; numeric `confidence` (correct for promises) | Not schema'd | none | Name rules | `""` scalars on promises. Not linted (no schema). |
| `telegram_bot.py` | adds `posted` / `discarded` / `stale` | `status`, `discardedAt` | n/a | none | Name rules | Status as a tag on tweet drafts. |
| `proton_mail.py` | `email` | as Prism's Proton ingest | Yes | none | Full | The job is disabled on the Mini, but no code stops it. Two mail writers would duplicate. |
| `dashboard/dispatch.py` | `agent-output`, `dispatch` | run fields | n/a | none | Full | None. |
| `standing_agent/*` (EA passes, dedup) | `pattern`, `person`, `organization` … | one model-chosen field; `merged_into` as a **bare path** (Prism writes the note id; `tombstone_person` writes a wikilink) | Mostly; empty lists sent as `[]` | body wikilinks | Name rules | Three encodings of `merged_into`. Prism's link job repairs dangling ones. |
| `apply_tag_schemas.py` | — | **tag schemas** from `docs/tag-schemas.md`, doc wins per field | **No**: 5 fields contradict the approved schema | — | Was none | **Fixed:** refuses while the doc contradicts the contract. |
| One-off scripts (`_cleanup_*`, `_tune_*`, migrations) | various | literal data | n/a | `belongs-to` (task migration) | Full | Already run. |

### 1.5 Prompts that tell an agent to write (no code guard applies)

| Prompt | Writes | Shapes stated before | Drift found | Now |
|---|---|---|---|---|
| Routine `nightly-parachute-weave` | merges, tags, links anywhere; a report note | Yes (hand-written) | Free linking with no relationship names and no cap; may create tags; may delete in a merge | Generated block. Behaviour unchanged. |
| Routine `process-vault-transcripts` | meeting notes, people, calendar stubs, report | Yes (hand-written) | New person notes have no template | Generated block. |
| Routine `meeting-prep` | `meeting-prep` notes | **No** | `attendees` as one comma-separated **string** | Template fixed to a list; generated block. |
| Routines `benjamin-morning-intelligence`, `midday-` / `afternoon-sensing-scan`, `evening-review`, `daily-tweet` | one note each, 2–3 fixed fields | **No** | None in the fixed fields | Generated block. |
| Agent `CLAUDE.md` (system prompt for Omni, Buzz `omni`, interactive sessions) | tasks through MCP are allowed ("either is fine") | **No** | MCP task creation skips the quality bar and the guard | Generated block added. The "either is fine" line is unchanged (your decision, §4). |
| Agent `.claude/PARACHUTE.md` | MCP patterns | **No** | Three examples used the folder form of a project link | Examples fixed; generated block. |
| Agent `.claude/commands/add-project.md`, `ingest-meetings-auto.md` | through `ParachuteWriter` | No | `ingest-meetings-auto` creates tasks per action item; calls `upsert_concept(source=…)`, which that function does not accept | Guarded by code. Not edited. |
| Agent `.claude/skills/*` (30 symlinks into the archived `opal` checkout) | `meeting-processor` maps to folder links; `extract-entities` shows `confidence: 0.95` | No | Yes | **Not edited**: the files live outside the repo. |
| Hermes skills (`hermes/skills/omni-*`) | forbid direct vault writes; go through `omni_cli.py` | n/a | None | Guarded by code. On Buzz, `omni-buzz-guard` blocks MCP writes. |
| Prism `.claude/skills/reconcile` | person / org / project notes | Yes (hand-written) | None | Generated block. |
| Prism `.claude/skill-meeting-processor.md`, `.claude/vault-description.md` | meeting notes | No | Five folder-form project links | Fixed; generated block; a test now fails on that form. |
| Prism `.claude/skills/extract-entities` | entities for reconcile | No | Numeric `confidence` examples | Note added: the number is an extraction score, the stored value is a label. |
| Prism hosted-agent preambles (`buildPrompt`, `buildSessionPrompt`) | anything | **No** | Not told any shape | Compact rule added for every run that can write. |
| Desktop `PRISM_CONTEXT` (Rust) | anything | No | Same | **Not changed** (cannot be built or tested here; superseded by the server runner). |

### 1.6 What the daily lint measured, and what it did not

| Question | Before | Now |
|---|---|---|
| Which tags? | 12: person, organization, project, concept, meeting, transcript, task, message-thread, briefing, spec, report, writing | 26: every schema'd tag of the personal vault. `research`, `decision-record` and `grant-application` have list rules and were never sampled. The 14 new tags are **report-only** until named in `VAULT_LINT_ALERT_TAGS`. |
| Which notes? | Newest 100 per tag by last change | Same. |
| Which rules? | The guard's rules + the vault's own warnings | The same, plus a **declared-schema** check (value outside its allowed list, wrong type, empty string). Report-only by default. |
| Would it notice a routine writing `""` to a list tomorrow? | Only if more than 20 of the newest 100 notes of that tag were wrong. A few notes a night: **never**. | Yes, the next day: `fresh.<tag>` counts mis-shaped notes written since the last run. Alerting needs `VAULT_LINT_FRESH_MAX` (default 0 = report). |
| How fast? | Daily | Daily. |
| Who wrote them? | Not reported | `writers.<tag>`: the ingest source word, or calendar / matrix / routine / skill / import / prism-user / unknown. "unknown" means a direct vault write. |
| Is anyone alerted? | Yes: one email and one `alert` note per episode, and one on recovery, when a tag is over the rate. A rising rate (`rose`) is shown but does not alert. | Same channel. `fresh` alerts when the threshold is set. |
| Links? | **Not measured at all.** | New `link-health` source (§2.2). |
| Tags with no schema (`meeting-prep`, `promise`, `agent-sense`, `tweet-draft` …) | Not sampled | Still not sampled. |
| Schema changes made directly on the vault | Not detected | Still not detected (the lint reads notes, not tag schemas). See §4, decision 1. |

Live numbers known from the Mini inventory (2026-10-08, after the clean-up): every linted tag is under the 20% line; the highest is `project` at 16%. Left on purpose: 28 decimal `confidence` values, 40 task priorities outside the list, 9 `relationship_type` values, 25 links to project folders with no project note. The new declared-schema check will show the priorities and `relationship_type` values; that is why it starts as report-only. **I did not query the live vault for this report.**

---

## Part 2. The guardrails, by layer

### 2.1 Prevent at the source

| # | Guardrail | Catches | State |
|---|---|---|---|
| P1 | One contract file (`packages/core/src/lib/schemas/vault-shapes.json`), loaded by both guards, vendored byte-for-byte in the agent repo | Rules drifting apart between the two repos and the prompts | **Built** |
| P2 | Generated "Field shapes" block in all eight routines, the agent `CLAUDE.md`, `.claude/PARACHUTE.md`, Prism's reconcile and meeting-processor prompts | An agent that was never told a rule; a prompt that states an old rule | **Built** (routines not synced) |
| P3 | `sync_routines.py --check` and `gen_field_shapes.py` fail on a missing, stale or hand-edited block | A routine falling behind a schema change | **Built** |
| P4 | Compact rule in Prism's hosted-agent preamble (every run that can write) | Hosted agents writing through the raw vault MCP | **Built** |
| P5 | `prism_create_note` / `prism_update_note` shape their metadata before dispatch | Owner/admin agent writes through Prism MCP | **Built** |
| P6 | Python `update_note(shape_tags=…)`; `ParachuteWriter` and `tasks_store` pass the note's tags | Updates that skipped the tag rules | **Built** |
| P7 | The Python guard warns once when it cannot run | A broken guard failing open in silence | **Built** |
| P8 | `apply_tag_schemas.py` refuses a doc that contradicts the contract | The schema being re-declared from a stale doc | **Built** |
| P9 | Member gateway PATCH passes the note's tags to the guard | Member updates with tag-rule violations | **Specified, not built.** `vaultClient().updateNote` would take a `shapeTags` option; `routes/api.ts` already holds the note. Low value today (the owner is the main user and uses the passthrough). |
| P10 | Normalise on the owner passthrough | Owner writes | **Not recommended.** The passthrough is byte-for-byte by rule; rewriting bodies there risks the stamp and collab invariants. Detect instead (lint). |
| P11 | Make key text/integer fields **indexed** so the vault refuses a wrong type from any writer | `confidence` as a number, `recording_id` as a number, `lastMessageAt` as text, from every path including direct MCP | **Your decision** (§4). Cannot cover lists. A refused write is lost, so an ingester bug would drop a note instead of storing a warning. Needs a trial on a scratch vault with existing data first. |
| P12 | Give the claude.ai connector a write-scope token, not admin | A routine or session changing tag schemas | **Your decision** (§4). |

### 2.2 Detect fast

| # | Guardrail | Catches | State |
|---|---|---|---|
| D1 | Lint samples every schema'd tag | Drift in tags nobody was watching | **Built** (new tags report-only) |
| D2 | `fresh.<tag>`: mis-shaped notes written since the last complete run | A writer that drifts by a few notes a day | **Built**, report-only until `VAULT_LINT_FRESH_MAX` is set |
| D3 | `writers.<tag>` | Which writer to fix | **Built** |
| D4 | `declared.<tag>`: values outside the declared list or type, empty strings | Status words outside the vocabulary, on any tag | **Built**, report-only |
| D5 | `link-health` source | Linking that stops or degrades | **Built**, off until `LINK_HEALTH_ENABLED=true` |
| D6 | Detect a tag-schema change on the vault (compare the live schemas with the contract daily) | Someone or something editing a schema | **Not built.** Needs one extra read of the tag list per day. Recommended next. |

Link-health measures (share of the newest 150 notes of each kind):

| Measure | Meaning | What moves it |
|---|---|---|
| `meeting.person` | Meetings with at least one link to a person note | Calendar ingest (links attendees), the transcript routine |
| `meeting.project` | Meetings with a project that resolves | The transcript routine, the weave |
| `meeting.project.resolved` | Of the project values meetings hold, the share that resolve (was 98%) | Folder links, invented slugs |
| `transcript.meeting` | Transcripts tied to a meeting | The transcript routine, manual matching |
| `task.project` / `task.project.resolved` | Tasks with a project that resolves (values resolved 63%) | ClickUp list names, `CLICKUP_LINK_ENABLED` |
| `email.person` | Emails linked to a person | `PROTON_LINK_PEOPLE`, the link job |
| `thread.person` | Message threads linked to a person | `MATRIX_LINK_EXISTING`, the link job |
| `person.linked` | People with any link (not orphans) | Everything above |
| `dangling` (lower is better) | Links in relation fields that point at no note | Slug-built wikilinks, invented people |

It alerts when a measure with at least 20 notes falls 20 points below its own running level, or under a floor you set. The level is a slow average and does not move while the measure is low, so a stopped linker keeps the alert on. No floor is set by default, because the true baselines are not known yet.

Limits: it does not read note bodies, so `[[links]]` in body text are not checked (the wikilinks job owns those). It samples the newest notes only.

### 2.3 Repair automatically and safely

None of this is built. Each existing tool, judged for running unattended:

| Tool | What it changes | Unattended? | Why |
|---|---|---|---|
| `migrate-empty-lists.ts` (M-a) | Removes `""` from list fields (metadata only) | **Yes, with a cap** | Lossless: `""` carries nothing. Compare-and-set. Skips email and message-thread notes. Undo log. |
| `migrate-field-shapes.ts` (M-f), number → text and one value → one-item list | `recording_id`, `spec.version` to text; a single text in a list field to a one-item list | **Yes, with a cap** | Lossless and reversible. |
| M-f, splitting "a, b" into two items | Text → several items | **No** | A guess, even when careful. Keep manual. |
| `confidence` number → label | 0.93 → high | **No** | Loses the number. You left 28 of these alone on purpose. |
| Task status synonyms → canonical | "review" → in-progress | **No** | Changes a value people and the ClickUp write-back read. |
| `migrate-project-folder-links.ts` (M-b) | Rewrites links in **bodies** and lists | **No** for bodies. **Maybe** for list fields only, when exactly one project note answers | Body edits reach open pages; the undo log holds note text. |
| People link job (M-e) | Adds links on strong keys; repairs dangling tombstones | **Yes, weekly, small cap, `enqueue` off, names off** | Additive, compare-and-set, audited, capped. No undo log: rollback is the backup. It is the only thing that links mail that arrived before a person note existed. |
| Wikilinks job | Adds `references` links from body `[[links]]` | **Not yet** | No write cap, no undo log, reads every candidate body. Add a cap first. |
| `trash-duplicates.ts` (M-c) | Moves notes to Trash | **No** | A judgement about which note is the copy. |
| `apply-schema-fixes.ts` | Tag schemas | **No** | Needs an admin token; a schema change is a decision. |
| `backfill-subpage-links.ts` (M-g) | Parent → sub-page links | **No** | One-time backfill, not approved. |

Specification for a nightly self-heal, if you want it built (default off):

- Switches: `VAULT_SELF_HEAL_ENABLED=false`, `VAULT_SELF_HEAL_DRY_RUN=true`, `VAULT_SELF_HEAL_MAX_WRITES=25`.
- Runs after the lint, on the primary vault, only on notes the lint just found mis-shaped (so the work is bounded by the lint sample, never by the vault).
- Fixes exactly three things: `""` in a list field → key removed; one non-empty text in a declared list field → one-item list (no splitting); a number in `recording_id` or `spec.version` → text.
- Never touches: `email`, `message-thread`, `clickup` and governance notes; any ingest-owned key; `confidence`; status words; note bodies; a note open in live collaboration.
- Each write: one fresh read of that note, then compare-and-set with its own `if_updated_at`. A conflict is skipped, never forced. Never built from a listing row.
- Records every change (note id, field, old value, new value) in a SQLite undo table; an owner route replays it.
- Stops after 5 failed writes in a row. Reports as a `vault-self-heal` health source: fixed, skipped, errors. In dry-run mode it reports what it would fix and writes nothing.

Why it is not built now: it is the first thing that would write to the vault on a schedule without a person. That deserves its own review and a dry-run week on the Mini. The lint's `fresh` count tells us first whether it is needed at all: if the prevention holds, there is nothing to heal.

### 2.4 Keep linking forward

All of these are off on the Mini today (`MATRIX_LINK_*` and `PEOPLE_*` are not set).

| Switch | What it does | Risk | Recommendation | Evidence |
|---|---|---|---|---|
| `MATRIX_LINK_EXISTING` | Links a thread to participants who already have a person note, by Matrix id. Creates nobody. Never links the owner's own note. | Low. A wrong Matrix id on a person note links the wrong person. | **On** (first wave) | Prism `CLAUDE.md` already says "recommended ON"; `test/matrix-people.test.ts`. |
| `MATRIX_STORE_PARTICIPANT_IDS` | Keeps members' Matrix ids on the thread note (`participantIds`) so later matching is by id, not display name. | Low. Ids travel with the note's metadata (exports, mirrors). | **On** (first wave) | Display-name matching resolved 8% of thread participants; the link job's thread phase needs the ids. |
| `PROTON_LINK_PEOPLE` | Links a new email to its sender's person note. Existing people only. | Low. | **On** (first wave) | `test/proton-ingest.test.ts`; 2,818 email orphans in the health report. |
| `TRANSCRIPT_LINK_PEOPLE` | Links new Fathom/Fireflies transcripts to attendees by address. A name alone never links. | Low. | **On** (first wave) | `test/people-forward.test.ts`. |
| `PROTON_LINK_RECIPIENTS` | Adds `email-to` links for up to 10 direct recipients, exact address, never role mailboxes or bulk mail. | Low to medium: many more links per person (graph noise). | **On** (second wave, after a few days) | Same tests; cap `PEOPLE_LINK_MAX_RECIPIENTS`. |
| `CLICKUP_LINK_ENABLED` | Links tasks to the assignee and, when the list name matches exactly one project, to that project. | Medium. Every task assigned to you links to your own person note (one very connected note). Only some list names match a project. Runs on every 5-minute poll. | **On** (second wave), then read `task.project` in link health | `test/people-forward.test.ts`; task `project` resolves 63%. |
| `PEOPLE_QUEUE_ON_INGEST` | Writes nothing to the vault. Puts unresolved people into a review queue. | None to data. It creates review work. | **Off**, unless an agent on the `prism-graph` profile clears the queue | Your goal is no manual review. |
| `MATRIX_LINK_PEOPLE` | As `MATRIX_LINK_EXISTING` but **creates** person notes in small rooms. | Medium: new person notes from chat display names. | **Off** | Duplicate people are what the dedup work removes. |

I could not measure a mis-link rate: the forward flags have never run on the live vault. The same matching code wrote about 1,500 links through the M-e job today.

Projects. How new notes get one today:

| Kind | How it gets a project | Keeps it filled? |
|---|---|---|
| Task (ClickUp mirror) | `project` = the ClickUp list name, as text | Partly. `CLICKUP_LINK_ENABLED` adds a real link when the name matches one project. Adding ClickUp list names to a project note's `aliases` would raise the match rate (not verified that the matcher reads aliases). |
| Task (ledger, `/tasks`) | Only if the caller passes one, as raw text | No. |
| Meeting with a transcript | The evening transcript routine matches a project and writes `projects` at high or medium confidence, and copies it to the calendar stub | Yes, for recorded meetings. |
| Meeting without a transcript (calendar only) | Nothing | **No.** |
| Email, message thread | Nothing | **No.** |

What would keep it filled: one more step in the nightly weave ("for yesterday's meetings and tasks with no project, apply the transcript routine's matching rules; write only at high confidence, otherwise leave it out"). That is a change to what the routine does, so it is a recommendation (§4), not part of this work. A server-side rule would have to guess from titles and attendees; the routine already does that with more context. `link-health` (`meeting.project`, `task.project`) will show whether it works.

### 2.5 Schema change control

One file → generated artefacts → tests that fail on drift. The steps are in `docs/vault-schema-change.md`.

| Check | Fails when |
|---|---|
| `apps/server/test/schema-drift.test.ts` | `tag-schemas.json` lacks an approved correction; a declared list is not in the contract (or the reverse); a vocabulary differs; a schema'd tag is not linted; the guard's output would fail the lint; the committed block is not what the contract renders; a prompt in `.claude/` teaches the folder link form; a write-capable agent preamble lacks the rule. |
| `scripts/vault-hygiene/gen-field-shapes.ts` | The block or a prompt file is stale (exit 1). |
| Agent `tests/test_vault_shapes.py` | The guard's data is not the contract; the block is not rendered from it; a routine lacks the block; a block was edited by hand; the vendored files differ from a Prism checkout (when one is found); the tag-schema script would run against the contract. |
| Agent `scripts/sync_routines.py --check` | A block is stale; a routine's cloud copy differs from the repo (with `--dump`). |

Limit: the two repos share no build. The cross-repo comparison runs only where both checkouts exist.

---

## Part 3. What was implemented

Prism PR (branch `phase-close/schema-guardrails`):

| Item | Files |
|---|---|
| Contract + typed loader + block renderer | `packages/core/src/lib/schemas/vault-shapes.json`, `vault-shapes.ts` |
| Guard and lint load the contract | `apps/server/src/vault-shapes.ts` |
| Generator and generated block | `scripts/vault-hygiene/gen-field-shapes.ts`, `docs/vault-field-shapes.md`, `.claude/skills/reconcile/SKILL.md`, `.claude/skill-meeting-processor.md` |
| Lint: all schema'd tags, `fresh`, `writers`, `declared`, alert-tag list | `apps/server/src/worker/vault-lint.ts`, `health.ts`, `config.ts` |
| Link health | `apps/server/src/worker/link-health.ts`, `scheduler.ts`, `health.ts`, `config.ts` |
| Agent preamble rule | `apps/server/src/agent-exec.ts`, `agent-sessions.ts` |
| MCP tools shaped | `apps/server/src/mcp/tool-notes.ts` |
| Prompt fixes | `.claude/vault-description.md`, `.claude/skills/extract-entities/SKILL.md` |
| Tests | `test/schema-drift.test.ts`, `test/link-health.test.ts`, one case in `test/mcp-tools.test.ts`, one bound in `test/agent-sessions.test.ts` |
| Docs | this file, `docs/vault-schema-change.md`, `CLAUDE.md`, a note in `qa/vault-migrations.md` |

Agent repo PR (branch `phase-close/schema-guardrails`): the vendored contract and block (`config/`), `scripts/gen_field_shapes.py`, the guard loading the contract, `shape_tags`, the warning, the `sync_routines.py` check, the `apply_tag_schemas.py` refusal, the block in eight routines + `CLAUDE.md` + `.claude/PARACHUTE.md`, the `meeting-prep` list fix, tests.

Behaviour that changes when the Prism PR is deployed, with no switch:

| Change | Effect |
|---|---|
| Lint lists 26 tags a day instead of 12 | 14 more small read-only listings a day. The new tags cannot alert. |
| Lint asks for more metadata keys per listing | Slightly larger responses (declared fields + 8 provenance keys). |
| Hosted agents get about 1.2 KB more preamble on every turn | A little more input per turn. |
| Owner MCP writes through `prism_*` tools are shaped | `""` in a list field is removed; a string in a list field becomes a one-item list; `confidence` becomes a label. |

Nothing else changes until a switch is set.

---

## Part 4. Switches to turn on, in order, and decisions

| # | Step | Risk | Rollback |
|---|---|---|---|
| 1 | Merge and deploy the Prism PR (`deploy.sh prism <tag>`, dry run first) | Low. See the table above. | Deploy the previous tag. |
| 2 | Next day: read `GET /acl/workers` → `vault-lint`. Note `fresh.*`, `writers.*`, `declared.*`, `overReportOnly`. | None (reading). | — |
| 3 | Set `LINK_HEALTH_ENABLED=true`, restart `prism-server` | None to data: read-only, about 9 capped listings a day. It cannot alert on its first run (no level yet). | Unset, restart. |
| 4 | Merge and deploy the agent PR (`deploy.sh agent <tag>`) | Low. The guard reads `config/vault-shapes.json`; if that file were missing the guard warns and sends metadata unshaped. | Deploy the previous tag. |
| 5 | Re-sync all eight routines (`sync_routines.py --emit-update <name> --dump <list>`, RemoteTrigger `update`; `daily-tweet` is device-bound: `--to-desktop`). Then `--check --dump` must show every routine ok. | Low: prompt text only. `meeting-prep` starts writing `attendees` as a list. | Revert the commit, re-sync again. |
| 6 | After two clean daily runs: `VAULT_LINT_FRESH_MAX=5` | A false alert if someone edits an old mis-shaped note (it then counts as fresh). | Set to 0. |
| 7 | First linking wave: `MATRIX_LINK_EXISTING=true`, `MATRIX_STORE_PARTICIPANT_IDS=true`, `PROTON_LINK_PEOPLE=true`, `TRANSCRIPT_LINK_PEOPLE=true`; restart | Low. Links are added, never removed. A wrong link stays until removed by hand. | Unset and restart stops new links. Existing links stay; full undo is the backup. |
| 8 | After a week of `link-health`: second wave `PROTON_LINK_RECIPIENTS=true`, `CLICKUP_LINK_ENABLED=true` | Medium (more links; your person note becomes very connected). | As step 7. |
| 9 | When the new tags' rates are known: `VAULT_LINT_ALERT_TAGS=all` (or a list); optionally floors such as `LINK_HEALTH_MIN_MEETING_PROJECT_RESOLVED=0.8` | Alerts on tags that were never judged. | Unset. |

Decisions only you can make:

1. **Connector scope.** The claude.ai Parachute connector appears to hold an admin token (it lists the tag-schema tools). Routines only need write. Re-issuing it with write scope removes the one path by which an agent can change the schema itself.
2. **Vault-side refusal.** Index `confidence`, `recording_id`, `spec.version`, `lastMessageAt` so the vault refuses a wrong type from any writer? Stronger than any prompt, but a refused write is a lost write. Needs a trial on a copy first.
3. **Nightly self-heal** (§2.3). Build it, default off with a dry-run week? Or wait and see whether `fresh` ever shows anything.
4. **A weekly capped run of the people-link job**, so mail and threads that arrived before a person note existed get linked without you starting it.
5. **Project step in the nightly weave** (§2.4), so calendar-only meetings and tasks get a project.
6. **`CLAUDE.md` Task Protocol** still says creating a task through MCP is "fine". It skips the quality bar and the guard. Remove that line?
7. **`/ingest-meetings-auto`** still creates a task per action item, against the rule that only you, ClickUp and the ledger create tasks. Retire it?
8. **`docs/tag-schemas.md`** (agent repo) is stale and its script now refuses to run. Bring it in line with the contract, or retire both?
9. **`proton_mail.py`** has no code lock; only the disabled launchd job keeps it from writing mail notes beside Prism. Add a refusal while `PROTON_SYNC_ENABLED` is on?
10. **`PEOPLE_QUEUE_ON_INGEST`**: stay off (recommended), or on with an agent that clears the queue?

## What this work did not verify

- No query was made against the live vault. Live rates come from the Mini inventory doc.
- The forward-linking flags were judged from code and tests, not from a run.
- The Notion sync's metadata builder and the desktop (Rust) writers were not read in depth.
- The 30 symlinked skills and commands in the agent repo point into an archived checkout outside the repo. They still hold old examples and were not edited.
