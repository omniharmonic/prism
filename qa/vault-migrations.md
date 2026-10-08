# Vault clean-up: schema changes and migrations

Prepared for Benjamin Life · 2026-10-08 · input: `qa/vault-health.md` · status: **every item below is awaiting Benjamin's approval. Nothing has been run against any real vault.**

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
| S1 | `message-thread.participants`: text → **list** | The Matrix ingester writes a list of names | 98 of 100 threads warn | None; no note changes | awaiting Benjamin's approval |
| S2 | `message-thread.lastMessageAt`: text → **integer** (epoch ms) | The ingester writes a number and every reader expects one | 99 of 100 | None | awaiting Benjamin's approval |
| S3 | `message-thread.platform`: add `matrix`, `twitter`, `instagram`, `messenger` | These are what the bridge detector writes | 26 of 100 | None | awaiting Benjamin's approval |
| S4 | `task.status`: add `pending`, `waiting`, `completed`, `archived` (keep `todo`, `done`, `in-progress`, `blocked`, `cancelled`; default stays `todo`) | `tasks_store.py` writes the new words. Prism and the ClickUp mirror still write `todo`/`done` | 81 of 100 (1 note with `review` keeps its warning) | None | awaiting Benjamin's approval |
| S5 | `confidence` on person, project, organization, concept: number → **label** `high` / `medium` / `low` | Every writer writes a label | person 89/100, project 33/37, org 97/100 (10 old person notes with a number, and `""` values, still warn) | None | awaiting Benjamin's approval |
| S6 | `organization.status`: add `merged_into_canonical` | The merge flow writes it on tombstones | 2 of 100 | None | awaiting Benjamin's approval |
| S7 | `spec.version`: number → **text** | Versions are labels like `v1` | 36 of 50 | None | awaiting Benjamin's approval |
| S8 | `project.role`: fixed list → **free text** | Roles are prose ("Co-Founder and Network Steward") | 27 of 37 | The vault may keep the old list when it merges definitions. The script re-reads and says "NOT TAKEN" if so | awaiting Benjamin's approval |
| S9 | `meeting.source` and `transcript.source`: the **same** free-text definition (fathom, meetily, fireflies, voice, calendar, manual) | Notes tagged both kept clashing; `voice` and `""` failed the old list | 116 clashes + 1 `voice` | Prism shows `transcript.source` as text, not a pick-list | awaiting Benjamin's approval |
| S10 | `report.date`: date → **text** | Every other tag stores `date` as text | 17 clashes + 2 non-ISO values | None | awaiting Benjamin's approval |
| S11 | `writing.status`: add `active` | 5 notes use it | 5 | None | awaiting Benjamin's approval |
| S12 (optional) | Declare `task.owner`, `deadline`, `deadline_source`, `source_ref` | Written by `tasks_store.py` / the ledger, never declared | new fields, no warnings today | Low | awaiting Benjamin's approval |
| S13 (optional) | Declare the email ingest keys `source`, `messageId`, `labels`, `mailbox`, `uid`, `account`, `to`, `lastMessageAt` | So Prism database views type them | 0 warnings today | Low: a note whose value has another shape would start to warn | awaiting Benjamin's approval |

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
| M-a | `migrate-empty-lists.ts`: remove `""` placeholders from list fields | Deletes the key (or writes `[]` with `--mode empty-list`) on person `organizations`/`aliases`/`projects`, project `aliases`/`collaborators`, organization `aliases`/`people`/`projects`, briefing `projects`/`people`, meeting `projects`, concept `aliases`/`related`. `--include-scalars` also removes `""` from `writing.published` and the `confidence` labels | ~85–89 per person field, ~56–85 per org field, 54 briefings, 32 meetings (sample counts; the dry run prints the real ones) | Low. Email and message-thread notes are never touched. **Writer fix still needed**, or the Google Contacts import, the weave and the transcript pipeline will write `""` again | `undo.ts --log <undo log>` puts every `""` back | awaiting Benjamin's approval |
| M-b | `migrate-project-folder-links.ts`: repoint `[[vault/projects/<slug>]]` to the project note | Rewrites the link text in the note body and in list fields, keeping any `\|label` or `#heading`. Only when exactly one project note answers for the slug; anything else is listed, never guessed | 28+ dangling folder links in the sample (schelling-point ×9, opencivics ×8, …), plus 29 folder links in `organization.projects` | Medium: it edits note bodies. Open live pages receive the change as an outside edit, which Prism merges. The undo log holds the old bodies, so keep it as private as the backup | `undo.ts --log …` restores body and values, but only on notes nobody edited since | awaiting Benjamin's approval |
| M-c | `trash-duplicates.ts`: move `duplicate`-tagged notes to Trash | Only notes whose twin is identified: the note names it (`duplicate_of`, `canonical`, `merged_into`, …), or exactly one other note has the same recording id. Others are listed for you. A duplicate with sub-pages is skipped. Goes through Prism's own Trash, so everything stays restorable from the Trash view | 63 tagged `duplicate`; start with the 23 Fireflies inbox ones (`--path-prefix vault/_inbox/transcripts/fireflies/`) | Low | Restore from Prism's Trash, or `undo.ts --log … --prism-url …` | awaiting Benjamin's approval |
| M-d | `report-untagged.ts`: untagged notes by folder | **Report only, writes nothing.** Prints each folder, its count, and a suggested tag (project slug + `document`/`research`; `_templates/` stays untagged) | 395 untagged | None | n/a | awaiting Benjamin's approval to run |
| M-e | People links (email / thread / meeting orphans) | Not a new script: use Prism's own job `POST /api/admin/people/link {"dryRun": true}` (server owner only, through the admin API), which is conservative and already dry-run by default | 2,818 email, 1,169 thread, 506 meeting, 139 person orphans | Medium (write run) | That job's own audit + per-note CAS | awaiting Benjamin's approval |

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

## Decisions for Benjamin

1. Approve or strike each of S1–S13. S8 (free-text role) and S9 (free-text source) give up a pick-list in exchange for no warnings.
2. M-a: remove the key (default) or write `[]`?
3. Order. Suggested: schema S1–S11 → M-a → M-c (Fireflies batch first) → M-b → people-link dry run.
4. Writer fixes are separate work, not covered here: stop writing `""` for lists, link projects as `…/PROJECT`, write `recording_id` as text.
