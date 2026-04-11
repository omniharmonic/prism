---
name: Entity Reconciliation
description: "Three-phase deduplication and matching of extracted entities against existing Parachute Vault notes. Determines whether each extracted entity should create a new note, update an existing one, or be merged with a duplicate. Uses exact matching, fuzzy matching, and semantic reasoning."
version: 1.0.0
---

# Entity Reconciliation Skill

You are reconciling newly extracted entities against the existing knowledge in a Parachute Vault. Your job is to prevent duplicates, merge related entries, and ensure the vault remains a clean, authoritative knowledge graph.

## When to Use

This skill activates after entity extraction, before entities are written to the vault. It is called by the `/oparachute-process` command pipeline.

## Reconciliation Pipeline

### Phase 0: Load Existing Entity Index (Efficient)

Before matching individual entities, build a lightweight index of existing typed notes:

```
For each resource type tag defined in the schema:
  mcp__parachute-vault__read-notes
    tags: [type_tag]
    include_content: false    ← KEY: returns NoteIndex (id, path, metadata, preview, byteSize) — no full content
    limit: 200
    sort: "desc"
```

This gives you paths, metadata (including aliases), and previews for matching WITHOUT downloading full note content. Only fetch full content (`get-note`) when you need to inspect a specific match candidate.

Also use `path_prefix` to efficiently browse entity directories:
```
mcp__parachute-vault__read-notes
  path_prefix: "person/"     ← browse all persons
  include_content: false
```

### Phase 1: Exact Match

For each extracted entity, check for exact matches:

1. **Path match** — Search for a note at the expected path `{type}/{slug}`
   - Use `mcp__parachute-vault__get-note` with `path: "{type}/{slug}"`
   - If found: this is an UPDATE operation

2. **Batch path check** — For multiple entities of the same type, use the preloaded NoteIndex from Phase 0 to check paths in memory before making individual calls

3. **Name match** — Search for notes whose content or metadata contains the canonical name
   - Use `mcp__parachute-vault__search-notes` with the canonical name as query and `tags: [type_tag]` to narrow scope
   - Search returns full Note shape — use for content-level matching

4. **Alias match** — Check the preloaded NoteIndex metadata for alias arrays, then confirm with search if needed
   - Use `mcp__parachute-vault__search-notes` with each alias

**If exact match found** → Generate UPDATE operation (merge new info into existing note)

### Phase 2: Fuzzy Match

For entities that didn't match exactly:

1. **Similar name search** — Search for notes with similar names
   - Use `mcp__parachute-vault__search-notes` with partial name variations
   - Consider common variations:
     - With/without middle names
     - Abbreviations vs full names
     - Hyphenated vs separate words
     - Singular vs plural

2. **Levenshtein-style assessment** — For each search result, assess string similarity:
   - Names within edit distance 3 (for names > 8 chars) are candidates
   - Names that share 2+ words are candidates
   - Organization names that share key terms are candidates

**If fuzzy match found** → Flag for REVIEW with both entities shown side-by-side

### Phase 3: Semantic Match

For entities that didn't match in phases 1-2:

1. **Semantic search** — If embeddings are available, use `mcp__parachute-vault__semantic-search` to find conceptually similar notes
   - Filter by type tag: `tags: [type_tag]`
   - Use `exclude_tags: ["needs-review"]` to skip unconfirmed entities
   - Set `hybrid: true` for combined keyword + semantic matching (default)
   - Look at the top 5 results

2. **Contextual reasoning** — For each candidate:
   - Consider: Are these describing the same real-world entity?
   - Factor in: type, description, relationships, dimensional attributes
   - A "Participatory Budgeting" pattern and a "Community Budget Process" pattern might be the same thing

3. **Confidence thresholds**:
   - **> 0.85**: Merge automatically (add alias, combine metadata)
   - **0.7 - 0.85**: Flag for REVIEW with merge recommendation
   - **< 0.7**: Treat as NEW entity

### Phase 4: Generate Operations

For each extracted entity, produce one operation:

```
OPERATION: CREATE | UPDATE | MERGE | REVIEW
─────────────────────────────────────────────
Entity: [canonical name]
Type: [resource type tag]
Confidence: [0.0-1.0]
Rationale: "Why this decision"

For UPDATE:
  Existing note: [note ID and path]
  Changes: [what would be added/changed]

For MERGE:
  Primary: [note ID — the one to keep]
  Secondary: [note ID — the one to merge in]
  Combined aliases: [union of both]
  Combined metadata: [merged fields]

For REVIEW:
  Candidates: [list of potential matches with similarity scores]
  Recommendation: [what you think should happen]

For CREATE:
  Path: [type/slug]
  Tags: [type tag + dimension tags]
  Metadata: [all extracted fields]
  Content: [generated note content]
```

## Merge Rules

When merging two entities:

1. **Primary selection** — Keep the entity with:
   - More links/relationships (more connected)
   - Earlier creation date (established first)
   - More complete metadata

2. **Alias union** — Combine all aliases from both entities (include the secondary's canonical name)

3. **Metadata merge**:
   - Arrays: union (deduplicated)
   - Strings: prefer longer/more descriptive value
   - Numbers (mention_count): sum them
   - Enums (status): prefer the more "active" value

4. **Content merge** — Append secondary's unique content under a "## Merged From" section

5. **Link transfer** — All links pointing to/from the secondary should be updated to point to the primary
   - Use `mcp__parachute-vault__get-links` with `id: secondary_id, direction: "both"` to get all links
   - Recreate each link pointing to/from the primary via `mcp__parachute-vault__create-link`
   - Delete old links via `mcp__parachute-vault__delete-link`

6. **Alias redirect** — The secondary's path should become an alias entry pointing to the primary

7. **Batch operations** — When merging results in tag changes across multiple notes, use `mcp__parachute-vault__batch-tag` and `mcp__parachute-vault__batch-untag` for efficiency

## Output Format

Present operations as a reconciliation report:

```
## Reconciliation Report

### Summary
- Entities processed: N
- CREATE (new): N
- UPDATE (existing): N
- MERGE (duplicates): N
- REVIEW (uncertain): N

### Operations

#### CREATE: Sarah Chen (person, confidence: 0.95)
Path: person/sarah-chen
Tags: person, sector/governance
Metadata: {role: "Director", org: "BFC", aliases: ["Sarah"]}
Rationale: No existing match found in vault

#### UPDATE: Bioregional Food Council (organization, confidence: 0.90)
Existing: note-id-123 at organization/bioregional-food-council
Add to metadata: {member_count: 15}
Add mention from: [source document]
Rationale: Exact path match, adding new information

#### MERGE: Community Budgeting → Participatory Budgeting (pattern)
Primary: note-id-456 (Participatory Budgeting)
Secondary: note-id-789 (Community Budgeting)
Combined aliases: ["PB", "Community Budgeting", "community budgets"]
Rationale: Semantic match confidence 0.92 — same concept, different names

#### REVIEW: Open Civics Lab (organization, confidence: 0.75)
Candidate 1: OpenCivics Labs (note-id-101, similarity: 0.82)
Candidate 2: Open Civic Innovation Lab (note-id-102, similarity: 0.71)
Recommendation: Likely match with Candidate 1 (name variation)
```

## Important Guidelines

1. **Err on the side of REVIEW over automatic MERGE** — False merges destroy information; missed merges can be caught later
2. **Never merge across types** — A person and an organization with similar names are NOT the same entity
3. **Check relationships for clues** — Two entities with overlapping relationships are more likely to be the same
4. **Consider temporal context** — An entity mentioned in 2024 and one in 2026 with the same name might be different (organizations rebrand, people change roles)
5. **Preserve provenance** — Always record which source document triggered each operation
