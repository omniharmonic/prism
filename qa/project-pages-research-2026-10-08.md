# PROJECT pages: findings and plan (2026-10-08)

Research only; no data was changed. Counts come from the laptop's scrubbed copy of the
vault (13,680 notes), so production differs slightly.

## Findings

- **The "bad markdown" was the page's own display.** `ProjectRenderer` never rendered the
  note body. It printed the path leaf ("PROJECT") as the title of every page and the first
  non-heading body line as raw text, so asterisks and link brackets showed as typed. The
  rest of the body was invisible and not editable. 12 of 36 pages showed raw markup.
- **No page connected to anything.** The renderer looked for notes under
  `vault/projects/<slug>/PROJECT/…` or with `metadata.project === "PROJECT"`. Neither ever
  matches, so every page showed "Tasks 0 / Documents 0", after downloading the whole vault.
- **The connections exist in the data.** 2,718 project-to-note connections across 36
  projects; every project has at least one.

  | Signal | Connections |
  |---|---|
  | The note's `projects` / `project` field | 2,097 |
  | Living in the project's folder | 1,328 |
  | Vault links | 1,046 |
  | Wikilinks in the text | 333 |

- **Stored bodies are in reasonable shape.** The clutter is agent boilerplate (19 of 36
  carry a template with empty "Key Context for Agents" / "Recent Activity" sections),
  duplicated titles (33) and empty sections. Generators in the agent repo still write it:
  `.claude/commands/add-project.md`, `scripts/parachute_writer.py` (`upsert_project`),
  `scripts/setup_project_swarm.py`.
- **Housekeeping gaps.** 36 PROJECT notes, 47 folders; 10 folders have no PROJECT note.
  Duplicate pairs: `eth-boulder` / `ethboulder`, `bioregional-foodchain-design` /
  `bioregional-food-chain`. Sub-folders treated as projects by other notes but without a
  PROJECT note: `opencivics/icfc` (220 notes),
  `opencivics-case-studies/planetary-regeneration-alliance` (107 notes).

## Plan

| Phase | What | Status |
|---|---|---|
| 0 | Project pages open on the normal document surface: real title, rendered and editable body, properties under the title. No data change. | Done (PR #33) |
| 1 | Hygiene migrations with the dry-run-first, undoable tooling in `scripts/vault-hygiene/`: normalise how notes point at projects, stamp the project on folder notes that lack it, strip boilerplate and duplicate titles from project bodies. | Not started |
| 2 | Live sections under the body (Meetings, Tasks, Documents, People), each a real query over connected notes. | Not started |
| 3 | Fix the agent-repo generators so the boilerplate does not return. | Not started |
| 4 | Missing and duplicate projects: merge the two duplicate pairs, create PROJECT notes where others already reference a project. | Not started |

## Owner decisions (Benjamin, 2026-10-08)

1. Membership truth is the note's `projects` field; folder placement is back-filled to match.
2. The agent boilerplate section moves out of the body into metadata.
3. `icfc` and `planetary-regeneration-alliance` are promoted to real projects.
4. The 53,000-character project body moves to a sub-page with a short summary on top.
5. Placeholder objectives are left alone; project status gets a manual pass; Dataview
   `index` notes are trashed only after Phase 2 ships.

Phases 1 and 4 write to the live vault: dry run first, then applied on the Mini through
`apply-all.sh` (which takes the backup), on Benjamin's explicit yes.
