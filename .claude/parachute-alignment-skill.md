# Skill: Aligning Prism with Parachute Vault Data

**Context:** Prism is a Tauri desktop app that renders content from a Parachute vault. The vault uses **tags** as its primary type system (22 tag schemas), while Prism uses `metadata.type` to select renderers. This skill documents how we bridged them without breaking either system.

---

## The Problem

Prism's renderer registry maps `ContentType` → React component. It expects `metadata.type: "document"` on every note. But the Parachute vault:
- Uses **tags** for typing (`task`, `meeting`, `concept`, `writing`, `slides`, etc.)
- Stores structured fields in **tag schemas** (e.g., the `task` tag schema has `status`, `priority`, `due`)
- Has `metadata.type` set to vault-specific values like `"project-update"`, `"concept"` — not Prism's 15 known `ContentType` values
- Has 591+ topical tags (`governance`, `bioregional`) that are semantic, not structural

## The Solution: Three-Layer Bridge

### Layer 1: Frontend `inferContentType()` with Tag Awareness

**File:** `src/lib/schemas/content-types.ts`

Priority chain for type inference:
```
1. metadata.prism_type  (backend-enriched, always a known ContentType)
2. metadata.type        (only if it's a known Prism ContentType)
3. Tag-based mapping    (first matching structural tag wins)
4. Path extension       (.md → document, .py → code, etc.)
5. Default: "document"
```

The tag mapping is ordered by priority — when a note has multiple structural tags, higher-priority types win:
```typescript
const TAG_TO_CONTENT_TYPE: [string, ContentType][] = [
  // High priority: specific renderers
  ["task", "task"],
  ["slides", "presentation"],
  ["dashboard", "project"],
  // Medium priority: document subtypes
  ["meeting", "document"],
  ["concept", "document"],
  ["writing", "document"],
  // ... etc
];
```

**Key insight:** Most vault tags (591 out of ~600) are topical/semantic and should NOT influence renderer selection. Only ~22 structural tags map to content types.

### Layer 2: Rust Backend Enrichment (`enrich_note()`)

**File:** `src-tauri/src/commands/vault.rs`

Every note returned by `vault_list_notes`, `vault_get_note`, and `vault_search` passes through `enrich_note()` before reaching the frontend. This function:

1. **Adds `prism_type`** — infers the Prism content type from tags when `metadata.type` isn't a known Prism type
2. **Preserves `vault_type`** — saves the original `metadata.type` value for display in the Context Panel
3. **Normalizes field names** — maps tag schema fields to Prism-expected names:
   - `due` → `deadline` (tasks)
   - `attendees` → `participants` (meetings)
4. **Passes through unknown fields** — tag schema fields like `fathom_url`, `recording_id`, `confidence` flow through untouched for future renderers

This follows the architecture principle: "the frontend decides nothing about data."

### Layer 3: Path Normalization

**File:** `src/components/navigation/ProjectTree.tsx`

- Strips `vault/` prefix from paths for cleaner display
- Filters `_templates` and `_staging` directories from the sidebar
- `_inbox` items show normally in the tree

## What We Learned

1. **Content-based heuristics are dangerous.** Our initial `---` detection for presentations matched markdown horizontal rules and table dividers, misidentifying nearly every document. Removed entirely — presentations require explicit `metadata.type: "presentation"` or the `slides` tag.

2. **Unknown `metadata.type` values must not pass through.** The vault uses types like `"concept"`, `"project-update"` which aren't Prism renderer types. If passed through, they hit the PlaceholderRenderer instead of DocumentRenderer. Fix: only accept known types.

3. **Tag schemas are richer than PrismMetadata.** Fields like `fathom_url`, `recording_id`, `confidence`, `estimated-duration` don't map to any current Prism field. The enrichment layer preserves them for future use.

4. **The vault's tag system is actually better** than a flat `metadata.type` field — a note can be tagged `meeting` AND `project-update` simultaneously. The priority ordering in the tag mapping handles this gracefully.

## Testing Checklist

- [ ] Notes with `metadata.type: "document"` → DocumentRenderer
- [ ] Notes with no metadata.type but tag `meeting` → DocumentRenderer (via enrichment)
- [ ] Notes with no metadata.type but tag `task` → TaskRenderer (when implemented)
- [ ] Notes with `metadata.type: "concept"` (unknown) → DocumentRenderer (falls through)
- [ ] Notes with tag `slides` → PresentationRenderer (when implemented)
- [ ] `_templates/` notes hidden from sidebar
- [ ] `vault/` prefix stripped from displayed paths
- [ ] Tag schema fields like `due`, `status`, `priority` available in metadata

## Files Modified

| File | What Changed |
|------|-------------|
| `src/lib/schemas/content-types.ts` | Added `KNOWN_TYPES`, `TAG_TO_CONTENT_TYPE`, tag-aware `inferContentType()`, `getStructuralTag()` |
| `src-tauri/src/commands/vault.rs` | Added `enrich_note()` function, applied to list/get/search commands |
| `src/components/navigation/ProjectTree.tsx` | Added `normalizePath()`, `HIDDEN_PREFIXES`, path filtering |

## Parachute API Reference

- **Tag schemas:** `GET /api/tag-schemas` or MCP tool `list-tag-schemas`
- **Tag schema detail:** MCP tool `describe-tag` with `tag: "task"`
- **Notes with tags:** `GET /api/notes` returns `tags: string[]` on each note
- **Metadata:** `GET /api/notes/:id` returns `metadata: object` with tag schema fields populated
