---
name: Schema Bridge
description: "Translates between OPAL's schema format (resource_types, dimensions, relationships) and Parachute Vault's tag_schemas format. Handles bidirectional conversion for import/export and schema evolution."
version: 1.0.0
---

# Schema Bridge Skill

You translate between OPAL's schema model and Parachute Vault's schema model. These two systems represent knowledge structure differently, and this skill handles the mapping.

## When to Use

- During `/oparachute-setup` when converting OPAL schemas to Parachute format
- When importing an existing OPAL vault into Parachute
- When exporting Parachute vault data back to OPAL format
- When evolving schemas (adding new types, fields, dimensions)

## Schema Model Comparison

### OPAL Schema (schema.yaml)

```yaml
resource_types:
  - id: pattern
    name: Pattern
    directory: patterns/
    template: pattern.md
    extraction:
      auto: true
      confidence: 0.8
    fields:
      - name: sectors
        type: array
        values: [governance, economic, environmental]
      - name: scales
        type: array
        values: [individual, neighborhood, municipal, bioregional]
      - name: status
        type: enum
        values: [draft, active, archived]

dimensions:
  - id: sector
    values: [governance, economic, environmental, social, technological]
  - id: scale
    values: [individual, household, neighborhood, municipal, bioregional, national, global]

relationships:
  - id: implements
    inverse: implemented_by
  - id: part_of
    inverse: contains
  - id: relates_to
    bidirectional: true
  - id: member_of
    inverse: has_member
```

### Parachute Schema (vault.yaml tag_schemas + vault description)

```yaml
tag_schemas:
  pattern:
    description: "A reusable solution pattern for civic/governance challenges"
    fields:
      status:
        type: string
        enum: ["draft", "active", "archived"]
      aliases:
        type: array
        description: "Alternative names for deduplication"
      source:
        type: string
      confidence:
        type: number
      mention_count:
        type: number
```

Dimensions and relationships go into the **vault description** (natural language instructions for AI clients).

## Translation Rules

### OPAL Resource Type → Parachute Tag Schema

| OPAL field | Parachute equivalent |
|---|---|
| `resource_type.id` | Tag name (e.g., `pattern`) |
| `resource_type.name` | `tag_schema.description` prefix |
| `resource_type.directory` | Path convention: `{type.id}/{slug}` |
| `resource_type.template` | Vault description instructions |
| `resource_type.extraction.auto` | Noted in vault description |
| `resource_type.extraction.confidence` | Default confidence threshold in description |
| `resource_type.fields[*]` | `tag_schema.fields[*]` with type mapping |

**Always add these standard fields to every tag schema:**
- `aliases` (array) — for deduplication
- `source` (string) — provenance tracking
- `confidence` (number) — extraction confidence
- `mention_count` (number) — usage tracking

### OPAL Dimensions → Parachute Tags or Metadata

**Decision rule:**
- If a dimension has **< 15 values** and users will **filter by it** → Use namespaced tags (e.g., `sector/governance`)
- If a dimension has **many values** or is **informational only** → Use metadata fields on tag schemas

**Tag approach:**
```
# Vault description section:
## Dimension Tags
- sector/governance, sector/economic, sector/environmental, sector/social, sector/technological
- scale/individual, scale/neighborhood, scale/municipal, scale/bioregional, scale/national, scale/global
```

**Metadata approach:**
```yaml
tag_schemas:
  pattern:
    fields:
      sectors:
        type: array
        description: "Applicable sectors"
        enum: ["governance", "economic", "environmental", "social", "technological"]
```

### OPAL Relationships → Parachute Link Types

Relationships are documented in the vault description and enforced by convention:

```
## Relationship Types
- `implements` / `implemented_by` — A pattern/protocol implements a concept
- `part_of` / `contains` — Hierarchical containment
- `relates_to` (bidirectional) — General association
- `member_of` / `has_member` — Person belongs to organization
- `authored_by` / `authored` — Authorship attribution
```

The `links` table's `relationship` column stores these as strings. The `metadata` JSON on each link can store `confidence` and `evidence`.

## OPAL Entity Index → Parachute Notes

When migrating from OPAL's `_index/entities.json`:

| OPAL index field | Parachute equivalent |
|---|---|
| `entity.id` (slug) | `note.path` = `{type}/{slug}` |
| `entity.canonical_name` | First line of `note.content` as `# Name` |
| `entity.type` | Tag (e.g., `person`) |
| `entity.aliases` | `note.metadata.aliases` |
| `entity.sectors` | Tags (`sector/X`) or `metadata.sectors` |
| `entity.scales` | Tags (`scale/X`) or `metadata.scales` |
| `entity.mention_count` | `note.metadata.mention_count` |
| `entity.sources` | `note.metadata.sources` |
| `entity.file_path` | `note.path` (normalized) |
| `entity.created` | `note.created_at` |
| `entity.last_updated` | `note.updated_at` |

Relationships from `_index/relationships.json` map directly to `links` table entries.

## Schema Evolution

When adding new types or fields to an existing vault:

1. **Read current schema** — `mcp__parachute-vault__get-vault-description` + `mcp__parachute-vault__list-tag-schemas`
2. **Merge changes** — Add new types/fields without removing existing ones
3. **Update vault description** — Append new types/dimensions/relationships
4. **Notify about tag_schemas** — Display the updated YAML for vault.yaml
5. **Backfill** — Optionally tag existing notes that match the new type

## API Data Shapes

When translating schemas, understand Parachute's two response shapes:

**Note** (full shape — from `get-note`, `search-notes`):
```json
{
  "id": "2026-04-10-...",
  "content": "# Full markdown content...",
  "path": "person/sarah-chen",
  "metadata": {"role": "Director", "aliases": ["Sarah"]},
  "createdAt": "2026-04-10T21:08:52.165Z",
  "updatedAt": "2026-04-11T03:08:52.935Z",
  "tags": ["person", "sector/governance"]
}
```

**NoteIndex** (lightweight — from `read-notes` with `include_content: false`):
```json
{
  "id": "2026-04-10-...",
  "path": "person/sarah-chen",
  "metadata": {"role": "Director", "aliases": ["Sarah"]},
  "createdAt": "2026-04-10T21:08:52.165Z",
  "updatedAt": "2026-04-11T03:08:52.935Z",
  "tags": ["person", "sector/governance"],
  "byteSize": 1234,
  "preview": "# Sarah Chen\n\nDirector of the Bioregional Food Council..."
}
```

**Link**:
```json
{
  "sourceId": "note-abc",
  "targetId": "note-xyz",
  "relationship": "member_of",
  "metadata": {"confidence": 0.85, "evidence": "mentioned in meeting"},
  "createdAt": "2026-04-10T21:08:52.165Z"
}
```

NoteIndex is crucial for schema bridge operations — it gives you metadata and paths for all entity matching without downloading full content. Always prefer `include_content: false` for index-building and reconciliation.

## Important Notes

- Parachute's tag_schemas are defined in `vault.yaml` (file-based config), not stored in the database
- The vault description IS stored via MCP and is the primary schema communication channel
- `list-tag-schemas` MCP tool reads the current tag_schemas from vault.yaml
- `describe-tag` MCP tool returns the schema for a specific tag
- When in doubt, put structured constraints in tag_schemas (machine-readable) AND explain them in the vault description (AI-readable)
- Tag schemas enforce metadata fields; vault description teaches conventions and context
- Response payloads use camelCase (`createdAt`, `sourceId`); query params use snake_case (`include_content`, `tag_match`)
