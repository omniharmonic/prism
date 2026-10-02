---
name: wikilinks
description: "Work with [[wikilinks]] in Benjamin's Parachute vault and Prism: how they render and autocomplete in the editor, how the vault itself resolves them into `wikilink` links, how Prism's owner-only server job adds `references` twins, and how an agent finds broken or ambiguous wikilinks with the real vault 0.7.9 MCP tools — without rewriting note bodies."
version: 2.0.0
---

# Skill: Wikilink Management for Parachute Vault

Use this skill when the user works with `[[wikilinks]]` — after importing an
Obsidian/markdown vault, when the Links tab shows no connections, or when
asked to "resolve", "fix" or "connect" wikilinks.

## Formats

```
[[simple name]]           → target "simple name"
[[path/to/note]]          → target "path/to/note"
[[path/to/note|Display]]  → target "path/to/note", label "Display"
```

## Who resolves what (three layers)

1. **The vault (automatic).** Parachute ≥ 0.7 parses `[[…]]` in note content on
   every write and keeps a vault-managed link with relationship **`wikilink`**
   (target resolved like `id` → exact path → basename → H1 title, only when
   exactly one note matches). A target that matches nothing is recorded as a
   **broken** link; one that matches two or more notes as an **ambiguous** link —
   neither is guessed. You never add or remove `wikilink` links yourself; they
   follow the content.
2. **Prism's server job (owner).** "Resolve All Wikilinks" in the command bar =
   `POST /api/admin/wikilinks/resolve {dryRun: true}` (server owner only; dry
   run by default; `GET` polls; `…/cancel` stops). It adds a **`references`**
   link beside each resolvable wikilink, never rewrites content, skips
   existing links, never links an ambiguous file name, and writes with
   `if_updated_at`. Code: `apps/server/src/wikilinks-job.ts`. (The old desktop
   Tauri commands `resolve_wikilinks` / `resolve_all_wikilinks` are legacy.)
3. **The editor.** `WikilinkMark.ts` decorates `[[…]]` as clickable links;
   `WikilinkAutocomplete.ts` + `WikilinkDropdown.tsx` complete `[[` against
   vault paths (all under `packages/core/src/`).

Read `wikilink` and `references` as the same fact ("A mentions B").

## Agent workflow (vault MCP, read-mostly)

Tools: `query-notes`, `find-path`, and — only to repair a link the user asked
for — `update-note`. There are no `get-links`, `traverse-links`,
`create-link` or `delete-link` tools.

- **Count broken wikilinks:** `query-notes { has_broken_links: true, aggregate: { op: "count" } }`.
- **See them:** `query-notes { has_broken_links: true, include_broken_links: true, include_content: false, limit: 10 }`
  → each note's `broken_links: [{target, relationship}]`. Page with `offset`;
  never list more than 3 pages in one go.
- **Ambiguous targets:** the same with `has_ambiguous_links` /
  `include_ambiguous_links` (`candidate_count` per target).
- **A note's links:** `query-notes { id, include_links: true, include_content: false }`.
- **Neighbourhood:** `query-notes { near: { note_id, depth: 1 }, limit: 25 }`;
  **path between two notes:** `find-path { source, target, max_depth: 4 }`.

### Fixing (only when the user asks, one note at a time)

- **Broken target, the right note exists under another path:** do NOT edit the
  body. Add the structured link instead:
  `update-note { id, if_updated_at, links: { add: [{ target: <note id>, relationship: "references" }] } }`,
  then re-read with `include_links: true` to verify. Mention to the user that
  the `[[…]]` text itself still points nowhere; they can fix the text in the
  editor.
- **Ambiguous target:** list the candidates (`query-notes { search: "<target>", limit: 10, include_content: false }`)
  and ask which one is meant. Never pick. If the candidates are duplicate
  person notes, say so — the owner merges people in Prism (an agent may
  record `prism_people_recommend_merge`, never merge).
- **Vault-wide resolution:** suggest the owner runs "Resolve All Wikilinks" (dry
  run first) rather than doing it note by note.

## Never

- Never rewrite or "normalize" note content to change wikilink text.
- Never add or remove `wikilink`-relationship links (removing one also strips
  the brackets from the content).
- Never create stub notes for unresolved targets.
- Never use `force: true`; never invent a relationship name — use `references`.
