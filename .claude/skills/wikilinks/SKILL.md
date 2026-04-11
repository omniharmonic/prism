# Skill: Wikilink Management for Parachute Vault

Use this skill when the user wants to work with `[[wikilinks]]` — the double-bracket link syntax from Obsidian/markdown knowledge bases. This is essential functionality for using Parachute as a second brain.

## What are Wikilinks?

Wikilinks (`[[target]]`) are inline references between notes. They originate from wiki systems and are heavily used in Obsidian, Logseq, and other knowledge management tools. When a vault is imported into Parachute, the `[[text]]` syntax exists in the markdown content but isn't automatically linked in the Parachute knowledge graph.

## Three Operations

### 1. Rendering — Display wikilinks as clickable links
**How it works in Prism:**
- The `WikilinkExtension` TipTap plugin scans document text nodes for `[[...]]` patterns
- Uses ProseMirror `Decoration.inline` to style them (accent color, dotted underline, cursor pointer)
- Click handler walks up the DOM tree to find the `.wikilink` class and reads `data-wikilink-target`
- Navigation resolves the target name to a Parachute note ID via fuzzy path matching

**Supported formats:**
```
[[simple name]]           → target = "simple name"
[[path/to/note]]          → target = "path/to/note"  
[[path/to/note|Display]]  → target = "path/to/note" (pipe separates target from display text)
```

**Resolution priority:**
1. Exact path match
2. Last path segment match (case-insensitive)
3. Path with `vault/` prefix stripped
4. Last segment of stripped path

### 2. Creation — Type [[ to autocomplete and create new wikilinks
**How it works in Prism:**
- The `WikilinkAutocomplete` TipTap extension tracks cursor position
- When the user types `[[`, it detects the trigger and exposes the query string
- A React dropdown shows matching notes from the vault (fuzzy search by path/name)
- Clicking a result inserts `[[full/path/to/note]]` at the cursor position
- The link immediately renders as a clickable wikilink via the decoration system

### 3. Resolution — Convert wikilinks to Parachute graph links
**Tauri commands:**
- `resolve_wikilinks(noteId)` — Scans a single note for `[[wikilinks]]`, matches them to existing notes, creates Parachute `links` (source → target with "references" relationship)
- `resolve_all_wikilinks()` — Batch processes all notes in the vault

**Matching logic (Rust):**
```rust
// For each [[wikilink]] in the note content:
let target = all_notes.iter().find(|n| {
    let path = n.path.as_deref().unwrap_or("");
    let name = path.split('/').last().unwrap_or("");
    let stripped = path.strip_prefix("vault/").unwrap_or(path);
    
    name.eq_ignore_ascii_case(wikilink)
        || path == wikilink
        || stripped == wikilink
        || stripped.split('/').last().unwrap_or("").eq_ignore_ascii_case(wikilink)
});
```

**What gets created:**
```json
{
  "source_id": "<note-with-wikilink>",
  "target_id": "<matched-note>",
  "relationship": "references",
  "metadata": {
    "source": "wikilink",
    "original": "[[vault/people/Patricia Parkinson|Patricia]]"
  }
}
```

## Architecture

### Files
| File | Purpose |
|------|---------|
| `src/lib/tiptap/WikilinkMark.ts` | TipTap decoration plugin — renders `[[text]]` as clickable spans |
| `src/lib/tiptap/WikilinkAutocomplete.ts` | TipTap plugin — detects `[[` trigger, exposes autocomplete state |
| `src/components/renderers/DocumentRenderer.tsx` | React integration — WikilinkDropdown component, navigation handler |
| `src-tauri/src/commands/wikilinks.rs` | Rust — `resolve_wikilinks` and `resolve_all_wikilinks` commands |
| `src/styles/typography.css` | CSS — `.wikilink` styling for both dark and light modes |

### Data Flow
```
User types [[par → WikilinkAutocomplete detects trigger
  → WikilinkDropdown shows matching notes
  → User clicks "Patricia Parkinson"
  → Editor inserts [[vault/people/Patricia Parkinson]]
  → WikilinkExtension decorates it as a clickable link
  → User clicks the link → handleWikilinkNavigate resolves to note ID → opens in tab
```

### Graph Link Creation Flow
```
User invokes resolve_wikilinks(noteId)
  → Rust parses [[wikilinks]] from note content
  → Each wikilink matched against all vault note paths
  → Parachute API: POST /api/links { source_id, target_id, relationship: "references" }
  → Links visible in the "Links" tab of the Context Panel
```

## When to Use This Skill

- After importing an Obsidian vault into Parachute
- When the user asks about "links between notes", "knowledge graph", or "connecting notes"
- When notes have `[[brackets]]` that should be navigable
- When building a second brain workflow on Parachute

## Integration with Parachute MCP

The wikilink resolution creates links via the Parachute HTTP API, which are then queryable via MCP tools:
- `traverse-links` — follow links from a note to find connected notes
- `get-links` — get all links for a specific note
- `find-path` — find paths between notes in the graph

This enables the AI agent to navigate the knowledge graph that wikilinks create.
