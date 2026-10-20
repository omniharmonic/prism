# Changing the vault schema (so everything stays in step)

Prepared for Benjamin Life · 2026-10-08 · companion to `qa/schema-stability-2026-10-08.md`.

A field shape (which fields are lists, which words a status may hold, what a project link looks like) is written down in **one file**, the field-shape contract:

`packages/core/src/lib/schemas/vault-shapes.json`

Everything else is loaded from it, generated from it, or pinned to it by a test.

| What | Where | How it follows the contract |
|---|---|---|
| Server write guard | `apps/server/src/vault-shapes.ts` (`shapeMetadata`) | Loads the contract at start. |
| Daily lint | `apps/server/src/worker/vault-lint.ts` | Same rules; samples every tag in `lintTags`. |
| Agent preamble (hosted agents) | `FIELD_SHAPES_RULE` in `apps/server/src/agent-exec.ts` | Rendered from the contract at start. |
| Prompt block | `docs/vault-field-shapes.md`, and between the `field-shapes` markers in `.claude/skills/reconcile/SKILL.md`, `.claude/skill-meeting-processor.md` | Generated: `gen-field-shapes.ts --write`. |
| Agent repo guard | `omniharmonicagent/scripts/vault_shapes.py` | Loads its vendored copy, `config/vault-shapes.json`. |
| Agent repo prompts | all eight `routines/*/SKILL.md`, `CLAUDE.md`, `.claude/PARACHUTE.md` | Generated: `scripts/gen_field_shapes.py --write`. |
| Seeded tag schemas | `packages/core/src/lib/schemas/tag-schemas.json` | Hand-edited; `schema-drift.test.ts` fails if it disagrees. |
| Approved corrections | `scripts/vault-hygiene/schema-fixes.json` | Hand-edited; the same test fails if it disagrees. |
| The live vault's tag schemas | Parachute (needs an admin token) | Applied by `apply-schema-fixes.ts`, dry run first. |

## The steps, in order

1. **Decide the change and write it in two files.**
   - `schema-fixes.json`: one entry with `from` (what the vault holds today) and `to` (the new definition). This is what gets applied to the live vault.
   - `tag-schemas.json`: the same `to` definition, so a new vault is seeded right.
2. **Update the contract** (`vault-shapes.json`) if the change touches a shape rule: a list field, a vocabulary (`taskStatus`, `threadPlatforms`, `confidence`), a text or integer field, or a tag that should be linted (`lintTags`).
3. **Regenerate** (local files only):
   ```bash
   node --import tsx scripts/vault-hygiene/gen-field-shapes.ts --write
   ```
4. **Run the tests.** `cd apps/server && npm test`. `schema-drift.test.ts` fails, naming the field, when the three files disagree or a prompt block is stale.
5. **Agent repo.** In `omniharmonicagent`:
   ```bash
   python3 scripts/gen_field_shapes.py --pull <prism checkout> --write
   python3 tests/test_vault_shapes.py
   ```
   `--pull` copies the contract; `--write` re-renders the block into every routine and prompt.
6. **Merge and deploy both repos** (`scripts/deploy.sh prism <tag>`, then `agent <tag>`, dry run first). Writers must emit the new shape before the vault starts to expect it.
7. **Apply the schema to the live vault** on the Mini, after a backup:
   ```bash
   … apply-schema-fixes.ts                                   # dry run: prints the diff
   … apply-schema-fixes.ts --apply --backup-confirmed
   ```
8. **Re-sync the routines whose prompt changed.** `python3 scripts/sync_routines.py --check --dump <list>` names them (`live:DRIFT`); send each `--emit-update` body with RemoteTrigger `update`. `--check` must end with every routine `ok`.
9. **If old notes hold the old shape**, run the matching migration from `scripts/vault-hygiene/` (dry run, backup, apply). See `qa/vault-migrations.md`.
10. **Watch the lint the next day.** `GET /acl/workers` → `vault-lint`: the tag's rate, `fresh.<tag>` (newly written mis-shaped notes) and `writers.<tag>` (who wrote them).

## One type per field name (vault 0.7.9), and renaming a field

Vault 0.7.9 keeps one definition per field NAME across every tag: all tags that declare a field
must agree on its type and on `indexed`, or the vault refuses the tag's whole schema PUT (422
`tag_field_conflict`). `schema-drift.test.ts` fails when `tag-schemas.json` (or an approved
correction) declares one name two ways. Never fix such a clash by changing a field's TYPE — that
changes how existing notes read. Rename it on the tags that are not the name's main users, and
copy the data:

1. Rename the field in `tag-schemas.json` on those tags (keep the name where existing data uses
   it), and every code reader and writer of it.
2. A vault seeded before the rename keeps the old declarations; the seed (`prism setup --from
   schemas`) only ADDS the new names. It never touches or removes an existing field.
3. Copy the values: a migration in `scripts/vault-hygiene/` (dry run first, backup, undo log).

Done on 2026-10-20 (clean-VM run: 13 type clashes, 5 index-flag clashes):

| Was | Now | On | Kept as it was on | Migration |
|---|---|---|---|---|
| `confidence` (number) | `confidence_score` | the 11 bioregional tags | person, project, organization, concept (the high/medium/low label) | `migrate-field-renames.ts` |
| `species` (array) | `constituent_species` | ecological-entity | herbal-use (a wikilink string) | same |
| `published` (boolean) | `is_published` | governance-revision | writing (a date) | same (the value is copied unchanged, so the note's signature still verifies) |
| `indexed` on `status` (ecological-entity, signal), `subject` (governance-membership), `at` (flow) | not indexed | | | none: a flag only (the value a fresh vault already got) |
| `proposal` not indexed (governance-revision) | indexed | | | none |

## What catches a skipped step

| Skipped | Caught by |
|---|---|
| Changed `tag-schemas.json` only | `schema-drift.test.ts` (contract and `schema-fixes.json` disagree with it). |
| Changed the contract, forgot to regenerate | `schema-drift.test.ts` ("the generated prompt block is current everywhere"); `gen-field-shapes.ts` exits 1. |
| Forgot the agent repo | `tests/test_vault_shapes.py` there (compares its vendored copy with a Prism checkout when it finds one; set `PRISM_REPO`), and `gen_field_shapes.py --prism <checkout>`. |
| Forgot to re-sync a routine | `sync_routines.py --check --dump …` shows `live:DRIFT`. |
| Edited a block by hand | The same checks: the block no longer equals what the contract renders. |
| A writer still emits the old shape | The lint: `fresh.<tag>` rises the next day, with the writer named. |
| Someone runs the old `apply_tag_schemas.py` | It refuses while `docs/tag-schemas.md` contradicts the contract. |

## Known limits

- The two repos have no shared build. The cross-repo comparison runs only where both checkouts exist (the laptop, the Mini). Run step 5 every time.
- A direct vault write (claude.ai connector, Claude Code `.mcp.json`, a routine) passes no guard. The prompt block is the only prevention there; the lint is the detection.
- The vault itself refuses a wrong-typed write only for **indexed** fields. Today one field is indexed (`task.priority`). Lists cannot be indexed.
