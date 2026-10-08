# Vault clean-up: schema changes and migrations

Prepared for Benjamin Life · 2026-10-08 · input: `qa/vault-health.md` · status: **every item below (S1–S13, M-a…M-e) was APPROVED by Benjamin on 2026-10-08** ("whatever keeps the data clean long-term"). Nothing has been run against any real vault yet: run `scripts/vault-hygiene/apply-all.sh` on the Mini (§4). The writer fixes (§3) stop the drift from coming back and must be deployed first.

Two kinds of work, kept apart:

- **Schema changes** tell the vault what the data really looks like, so the warnings stop. They rewrite **no notes**. They are cheap to undo.
- **Migrations** rewrite notes. Each one is a script that only **reads and reports** until you add `--apply --backup-confirmed`. Every write is compare-and-set: if a note changed after it was read, it is skipped, never forced. Writes are paced at 2 a second by default. Each write is recorded in an undo log that `undo.ts` can play back.

Every command refuses the production vault (`:1940` or `agent.omniharmonic.com`) unless `--production` is typed, and that includes dry runs. Tokens come from environment variables and are never printed.

## Before any `--apply`

```bash
scripts/backup-parachute.sh                       # take the backup, keep the archive
export PARACHUTE_TOKEN=…                          # the vault:default:write token Prism already uses
```

Schema changes also need a short-lived admin token: `export PARACHUTE_ADMIN_TOKEN=$(parachute auth mint-token --scope vault:default:admin --ephemeral)`.

All commands run from the repo root as `node --import tsx scripts/vault-hygiene/<script>.ts --vault-url http://127.0.0.1:1940 --production …`. Below this prefix is written as `… <script>`.

---

## 1. Schema changes (`apply-schema-fixes.ts`, source: `scripts/vault-hygiene/schema-fixes.json`)

| # | Change | Why (what the data really is) | Notes affected (from the health sample) | Risk | Status |
|---|---|---|---|---|---|
| S1 | `message-thread.participants`: text → **list** | The Matrix ingester writes a list of names | 98 of 100 threads warn | None; no note changes | **approved 2026-10-08** |
| S2 | `message-thread.lastMessageAt`: text → **integer** (epoch ms) | The ingester writes a number and every reader expects one | 99 of 100 | None | **approved 2026-10-08** |
| S3 | `message-thread.platform`: add `matrix`, `twitter`, `instagram`, `messenger` | These are what the bridge detector writes | 26 of 100 | None | **approved 2026-10-08** |
| S4 | `task.status`: add `pending`, `waiting`, `completed`, `archived` (keep `todo`, `done`, `in-progress`, `blocked`, `cancelled`; default stays `todo`) | `tasks_store.py` writes the new words. Prism and the ClickUp mirror still write `todo`/`done` | 81 of 100 (1 note with `review` keeps its warning) | None | **approved 2026-10-08** |
| S5 | `confidence` on person, project, organization, concept: number → **label** `high` / `medium` / `low` | Every writer writes a label | person 89/100, project 33/37, org 97/100 (10 old person notes with a number, and `""` values, still warn) | None | **approved 2026-10-08** |
| S6 | `organization.status`: add `merged_into_canonical` | The merge flow writes it on tombstones | 2 of 100 | None | **approved 2026-10-08** |
| S7 | `spec.version`: number → **text** | Versions are labels like `v1` | 36 of 50 | None | **approved 2026-10-08** |
| S8 | `project.role`: fixed list → **free text** | Roles are prose ("Co-Founder and Network Steward") | 27 of 37 | The vault may keep the old list when it merges definitions. The script re-reads and says "NOT TAKEN" if so | **approved 2026-10-08** |
| S9 | `meeting.source` and `transcript.source`: the **same** free-text definition (fathom, meetily, fireflies, voice, calendar, manual) | Notes tagged both kept clashing; `voice` and `""` failed the old list | 116 clashes + 1 `voice` | Prism shows `transcript.source` as text, not a pick-list | **approved 2026-10-08** |
| S10 | `report.date`: date → **text** | Every other tag stores `date` as text | 17 clashes + 2 non-ISO values | None | **approved 2026-10-08** |
| S11 | `writing.status`: add `active` | 5 notes use it | 5 | None | **approved 2026-10-08** |
| S12 (optional) | Declare `task.owner`, `deadline`, `deadline_source`, `source_ref` | Written by `tasks_store.py` / the ledger, never declared | new fields, no warnings today | Low | **approved 2026-10-08** |
| S13 (optional) | Declare the email ingest keys `source`, `messageId`, `labels`, `mailbox`, `uid`, `account`, `to`, `lastMessageAt` | So Prism database views type them | 0 warnings today | Low: a note whose value has another shape would start to warn | **approved 2026-10-08** |

S1–S11 are also written into `packages/core/src/lib/schemas/tag-schemas.json`, so new vaults are seeded right. The seeder never overwrites an existing field, so that file cannot change production by itself. S12/S13 are deliberately left out of it, so a plain `npm run seed` cannot add them.

| Step | Command |
|---|---|
| Dry run (prints the exact diff against the live schema) | `… apply-schema-fixes.ts` (add `--include-optional` to see S12/S13, `--only task` for one tag) |
| Apply | `… apply-schema-fixes.ts --apply --backup-confirmed` |
| Undo | `… apply-schema-fixes.ts --reverse` (dry run), then add `--apply --backup-confirmed`. S12/S13 additions can only be removed by hand with the vault's tag tools |

The script compares only type, list of allowed values and default. If a field was changed by someone since this file was written, it is reported as "drift" and left alone.

Not proposed as a schema change: renaming `meeting.status` to `processing_status`. That touches ~1.8k notes, and the transcript pipeline has to change first.

---

## 2. Migrations (each needs approval **and** a backup)

| # | Migration | What it changes | Notes (health report) | Risk | How to undo | Status |
|---|---|---|---|---|---|---|
| M-a | `migrate-empty-lists.ts`: remove `""` placeholders from list fields | Deletes the key (or writes `[]` with `--mode empty-list`) on person `organizations`/`aliases`/`projects`, project `aliases`/`collaborators`, organization `aliases`/`people`/`projects`, briefing `projects`/`people`, meeting `projects`, concept `aliases`/`related`. `--include-scalars` also removes `""` from `writing.published` and the `confidence` labels | ~85–89 per person field, ~56–85 per org field, 54 briefings, 32 meetings (sample counts; the dry run prints the real ones) | Low. Email and message-thread notes are never touched. Writer fixes: §3 | `undo.ts --log <undo log>` puts every `""` back | **approved 2026-10-08** |
| M-b | `migrate-project-folder-links.ts`: repoint `[[vault/projects/<slug>]]` to the project note | Rewrites the link text in the note body and in list fields, keeping any `\|label` or `#heading`. Only when exactly one project note answers for the slug; anything else is listed, never guessed | 28+ dangling folder links in the sample (schelling-point ×9, opencivics ×8, …), plus 29 folder links in `organization.projects` | Medium: it edits note bodies. Open live pages receive the change as an outside edit, which Prism merges. The undo log holds the old bodies, so keep it as private as the backup | `undo.ts --log …` restores body and values, but only on notes nobody edited since | **approved 2026-10-08** |
| M-c | `trash-duplicates.ts`: move `duplicate`-tagged notes to Trash | Only notes whose twin is identified: the note names it (`duplicate_of`, `canonical`, `merged_into`, …), or exactly one other note has the same recording id. Others are listed for you. A duplicate with sub-pages is skipped. Goes through Prism's own Trash, so everything stays restorable from the Trash view | 63 tagged `duplicate`; start with the 23 Fireflies inbox ones (`--path-prefix vault/_inbox/transcripts/fireflies/`) | Low | Restore from Prism's Trash, or `undo.ts --log … --prism-url …` | **approved 2026-10-08** |
| M-d | `report-untagged.ts`: untagged notes by folder | **Report only, writes nothing.** Prints each folder, its count, and a suggested tag (project slug + `document`/`research`; `_templates/` stays untagged) | 395 untagged | None | n/a | **approved 2026-10-08** |
| M-e | People links (email / thread / meeting orphans) | Not a new script: use Prism's own job `POST /api/admin/people/link {"dryRun": true}` (server owner only, through the admin API), which is conservative and already dry-run by default | 2,818 email, 1,169 thread, 506 meeting, 139 person orphans | Medium (write run) | That job's own audit + per-note CAS | **approved 2026-10-08** |

### Commands

| Migration | Dry run | Apply (after the backup) |
|---|---|---|
| M-a | `… migrate-empty-lists.ts` (`--only person` to narrow) | `… migrate-empty-lists.ts --apply --backup-confirmed` |
| M-b | `… migrate-project-folder-links.ts` | `… migrate-project-folder-links.ts --apply --backup-confirmed` |
| M-c | `… trash-duplicates.ts --path-prefix vault/_inbox/transcripts/fireflies/` | `PRISM_OWNER_TOKEN=… … trash-duplicates.ts --path-prefix vault/_inbox/transcripts/fireflies/ --prism-url http://127.0.0.1:8787 --apply --backup-confirmed` |
| M-d | `… report-untagged.ts` (`--json` for a file) | (none) |
| Undo any | `… undo.ts --log vault-hygiene-undo-<script>-<time>.jsonl` | add `--apply` (and `--prism-url` + `PRISM_OWNER_TOKEN` for M-c) |

Useful options on every migration: `--limit N` (write at most N notes, good for a first small batch), `--rate N` (writes a second, default 2), `--undo-log <file>`.

A dry run prints counts and at most 10–20 note ids and paths. It never prints a note body. Undo logs are written with owner-only permissions (0600) in the current directory.

---

## Decisions (Benjamin, 2026-10-08)

1. S1–S13 all approved, the optional S12/S13 included (`--include-optional`). S8 and S9 give up a pick-list for no warnings — accepted.
2. M-a: **remove the key** (the default). Empty is ABSENT — the same rule every writer now follows (§3). `--include-scalars` too, so `""` confidence labels and `writing.published` go as well.
3. Order: schema → M-a → M-c (Fireflies batch first, then the rest) → M-b → M-e (dry run, then a capped write run) → M-d report. This is what `apply-all.sh` runs.
4. Writer fixes: done in code (§3), with a write-side guard in both repos and a daily read-only lint so new drift is caught early.

---

## 3. Writer fixes (so the drift cannot come back)

The migrations heal the past. These stop new notes coming out wrong. Each shape rule exists in exactly three places, kept in step by tests: `scripts/vault-hygiene/schema-fixes.json` (what the vault validates), Prism `apps/server/src/vault-shapes.ts` (the server guard) and the agent repo's `scripts/vault_shapes.py` (the agent guard). `test/vault-shapes.test.ts` and the agent's `tests/test_vault_shapes.py` both read schema-fixes.json and fail if a vocabulary drifts.

**Guards (both write paths).**

| Where | What |
|---|---|
| Prism `vaultClient().createNote/updateNote` (`src/parachute.ts` → `shapeMetadata`) | Every server write: ingesters, people/identity jobs, member gateway writes, alerts. `""` in a list field: dropped on create, `null` (= remove the key) on update. Empty/duplicate list elements removed. Tag rules when tags are known: string → one-element list, `confidence` → high/medium/low, task status synonyms → canonical, thread `lastMessageAt` → epoch-ms integer, `platform` lower case, meeting/transcript `source` lower case, `recording_id` and `spec.version` → text. Governance notes (`gov_sig`, `governance-*`) are never touched. Off switch `VAULT_SHAPE_GUARD=0`. The owner passthrough (`proxyToVault`) is not shaped. |
| Agent `ParachuteClient.create_note/update_note` (`scripts/parachute_client.py` → `vault_shapes.normalize_metadata`) | Every agent write (tasks_store, ledger, ParachuteWriter, missions, proton_mail). Same rules. Off switch `PARACHUTE_SHAPE_GUARD=0`. A guard error never blocks a write. |

**Writers fixed at the source.**

| Writer | Drift it caused | Fix |
|---|---|---|
| `parachute_writer.py` `_upsert` (create path) | `""` placeholders on every new person/org/project (`role`, `contact`, `confidence`, `url`, `org` …) | A create sends no empty key (`strip_empty`); an update already skipped them. |
| `parachute_writer.py` person / meeting / task project links | `[[vault/projects/<slug>]]` folder links (dangle) | `ParachuteWriter.project_link()` → `[[vault/projects/<slug>/PROJECT]]`; a legacy note sitting at the folder path is honoured. |
| `parachute_writer.py` `upsert_project` / `find_project` | New projects created at the folder path | Created at `vault/projects/<slug>/PROJECT` (`project_path()`); existing legacy notes are still found and updated in place. |
| `parachute_writer.py` `upsert_task` | `todo`/`done` vocabulary, status word as a TAG (`todo`, `done` tags) | tasks_store vocabulary (`pending`, `completed` …), status in metadata only. |
| `parachute_writer.py` `upsert_meeting` | `recording_id` as a number | Written as text. |
| Prism `worker/clickup.ts` | `project: ""` on tasks without a list | No list → no key. |
| Routine `nightly-parachute-weave` (agent repo) | `""` lists, folder links, numeric confidence from the LLM weave | New "Field shapes (bind hard)" section in the prompt. Re-sync to claude.ai: `sync_routines.py --emit-update nightly-parachute-weave`. |
| Routine `process-vault-transcripts` (agent repo) | low-confidence meetings got a guessed `projects` hint; `""` sources | Low confidence writes `project_guess: "<slug>"` and leaves `projects` out; same "Field shapes" section. Re-sync like the weave. |
| Prism `.claude/skills/reconcile` | numeric `confidence`, `""` lists from agent writes | "Field shapes when you write" section. |
| Google Contacts takeout import | `""` in person list fields (79 of the newest 100 persons) | Not in either repo (a one-off run). Any re-run that goes through `ParachuteClient`, `vaultClient` or the Prism MCP is now shaped by the guards; a direct vault REST/MCP write is not — keep it on those paths. |

Already clean (checked, no change): Prism `worker/people.ts` person creation (no list placeholders), Fathom/Fireflies ingest (`recording_id`/`source_id` already text, `source` lower case), Matrix ingest (`participants` list, `lastMessageAt` integer), `tasks_store.py` (canonical statuses).

**Not fixed here (known):** the `standing_agent/` seed scripts write literal data (no placeholders); the `.claude/skills/extract-entities` and `reconcile` symlinks in the agent repo point at an archived OPAL checkout on the Mac and were not edited.

**Lint (catches new drift early).** `apps/server/src/worker/vault-lint.ts`: once a day (`VAULT_LINT_INTERVAL_MS`, 24 h), ONE lean listing per tag (person, organization, project, concept, meeting, transcript, task, message-thread, briefing, spec, report, writing) of the newest `VAULT_LINT_SAMPLE` (100) notes, only the keys the check reads, checked with the same rules (`shapeViolations`) plus the vault's own `validation_status` when present. Health source `vault-lint` in `GET /acl/workers`: per-tag rates in `detail`, `failing` (→ the usual email + alert note, once per episode) when a tag with ≥ `VAULT_LINT_MIN_SAMPLE` (10) sampled notes is above `VAULT_LINT_MAX_RATE` (0.2), `rose` lists tags up ≥ 5 points since the last run, `stale` after two missed days. Counts and field names only. **OFF unless `VAULT_LINT_ENABLED=true`** — turn it on after `apply-all.sh` (before the migrations every tag would read as failing).

---

## 4. One-command apply on the Mini (`scripts/vault-hygiene/apply-all.sh`)

**Before:** deploy the writer fixes (Prism: restart pm2 `prism-server`; agent repo: pull on the Mini, re-sync the two routines). Otherwise the next ingest pass writes `""` again behind the migration.

**Keychain, once** (the value is prompted for; never type a token on a command line):

```bash
security add-generic-password -U -a "$USER" -s prism-parachute-token -w      # vault:default:write token (PARACHUTE_TOKEN in apps/server/.env)
security add-generic-password -U -a "$USER" -s prism-owner-device-token -w   # a Prism owner device token (pd_…), for Trash + the people-link job
```

**Run** from the Prism checkout on the Mini:

```bash
scripts/vault-hygiene/apply-all.sh                    # takes the backup itself (label pre-vault-hygiene-keep, pinned)
scripts/vault-hygiene/apply-all.sh --i-have-a-backup ~/parachute-backups/<snapshot>   # use an existing verified snapshot
```

It refuses anywhere but the Mini (macOS + the local vault database + the vault answering on :1940). Then, in order, each step shows its dry run and asks before applying (`--yes` skips the questions, never the dry runs):

| Step | Dry run | Apply | Undo (printed after each step) |
|---|---|---|---|
| schema | diff vs the live schema (S1–S13) | one PUT per tag with a 1-hour minted admin token | `apply-schema-fixes.ts --include-optional --reverse --apply --backup-confirmed` |
| m-a | counts per tag/field | `migrate-empty-lists.ts --include-scalars` | `undo.ts --log <run dir>/undo-m-a.jsonl --apply` |
| m-c-ff | Fireflies inbox duplicates | to Prism's Trash | Trash view, or `undo.ts --log …/undo-m-c-ff.jsonl --prism-url … --apply` |
| m-c | all other identified duplicates | to Prism's Trash | same, `undo-m-c.jsonl` |
| m-b | folder links → `…/PROJECT`, unresolved slugs listed | CAS rewrite | `undo.ts --log …/undo-m-b.jsonl --apply` |
| m-e | people-link job dry run (strong keys only, no names, nothing queued) | write run capped at `PEOPLE_LINK_CAP` (500) writes; re-run `--only m-e` to continue | links are additive + audited; full rollback = the backup |
| m-d | untagged report | — | — |

Every step stops the run on error and prints its undo. Undo logs and a transcript go to `~/parachute-backups/vault-hygiene-<time>/` (0700; the m-b log holds old note bodies). Tokens are read from the Keychain into the child processes' environment and sent to curl on stdin — never on a command line, never printed. Resume with `--from <step>`, run one with `--only <step>`. Whole rollback: stop pm2 `prism-server` and the vault, restore `vault.db` and `prism-server.db` from the snapshot, start both.

**After:** set `VAULT_LINT_ENABLED=true` in `apps/server/.env`, restart pm2 `prism-server`, and check `GET /acl/workers` → `vault-lint` the next day.
