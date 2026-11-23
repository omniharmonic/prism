# Skill: Resolve Wikilinks to Parachute Links

Use this skill when the user asks to "resolve wikilinks", "convert wikilinks", "fix links", "create graph links from wikilinks", or wants to translate `[[wikilink]]` references from imported Obsidian/markdown files into actual relational links in the Parachute vault.

## What it does

Scans vault notes for `[[wikilink]]` syntax, matches them to existing note paths, and creates Parachute graph links (source → target with "references" relationship).

## How to use

1. Use the `resolve_wikilinks` Tauri command for a single note:
   ```
   invoke("resolve_wikilinks", { noteId: "<note-id>" })
   ```

2. Use `resolve_all_wikilinks` for the entire vault:
   ```
   invoke("resolve_all_wikilinks")
   ```

3. Both return `{ total_wikilinks, resolved, unresolved }` counts.

## Matching rules

- Exact path match: `[[vault/people/Benjamin Life]]`
- Last segment match (case-insensitive): `[[Benjamin Life]]` matches `vault/people/Benjamin Life`
- Strips `vault/` prefix for matching
- Handles `[[target|display text]]` syntax (uses target part)

## When to use

- After importing an Obsidian vault into Parachute
- When the user notices "Links" tab shows no connections but their notes have `[[wikilinks]]`
- When asked to "build the knowledge graph" from existing notes

## Limitations

- Only resolves to existing notes — doesn't create stub notes for unresolved links
- Doesn't update the note content (wikilinks remain as `[[text]]` in markdown)
- Creates `"references"` relationship type for all links
