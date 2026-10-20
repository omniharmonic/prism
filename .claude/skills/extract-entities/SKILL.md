---
name: Entity Extraction
description: "Extract structured entities and relationships from unstructured content (transcripts, notes, documents) using the vault's schema as a guide. Produces typed entities with metadata, aliases, and confidence scores ready for reconciliation against the Parachute Vault."
version: 2.0.0
---

# Entity Extraction Skill

You are performing domain-aware entity extraction from unstructured content. Unlike generic NER, you extract entities according to the vault's schema — the tags with schemas and the canonical relationship vocabulary.

## When to Use

This skill activates when processing raw content (transcripts, notes, documents) that needs entity extraction. Its output feeds the `reconcile` skill.

## Tools and limits

Parachute vault MCP (vault 0.7.9) only — read tools: `vault-info`,
`list-tags`, `query-notes`. (There is no `get-vault-description` or
`read-notes`.) This skill writes nothing.

- Every list query: `limit` ≤ 25, `include_content: false`, and
  `include_metadata` naming only the fields you need.
- Read long source content in slices: `query-notes { id, content_length: 6000, content_offset }`,
  following `content_next_offset`.

## Inputs Required

Before extracting, gather:

1. **The vault's schema** — `vault-info` (tags with schemas) and, for the
   types you will extract, `list-tags { tag: "<type>" }` for its fields.
2. **A small context sample of existing entities** — only for the people and
   organizations the source plausibly mentions, not a whole-tag index:
   ```
   query-notes { tag: "person", search: "<a name from the source>", limit: 10,
                 include_metadata: ["name", "aliases", "organization", "email", "merged_into", "status"] }
   ```
   People live under `vault/people/`. A person tagged `merged-stub` /
   `superseded` (or `status: merged_into_canonical`) is a merged duplicate —
   use the note its `merged_into` points to.
3. **The source content** — the raw text to extract from.
4. **Source metadata** — date, speakers/attendees, source type, and the
   source note id (every extraction must carry it).

## Extraction Process

### Step 1: Read the Schema

From `vault-info` / `list-tags`, note which entity types exist (person,
organization, project, meeting, concept, …) and which fields each expects.

### Step 2: Identify Entities

For each entity found in the content:

```yaml
entity:
  canonical_name: "Full Proper Name"
  type: person|organization|project|[schema-defined type]
  aliases:
    - "Nickname"
  confidence: 0.95
  identifiers:            # ONLY what the source states literally
    email: "sam@example.org"
  mentions:
    - text: "exact quote from source"
      context: "surrounding sentence for disambiguation"
  attributes:
    role: "Community Organizer"
    organization: "Example Org"
  description: "One-sentence summary of who/what this is"
```

### Step 3: Identify Relationships

Use ONLY the canonical relationship names, in their stated direction (the
source is the record, the target is what it points at):

| Relationship | From → to |
|---|---|
| `attended-by` | meeting or transcript → person |
| `has-transcript` | meeting → transcript |
| `email-from` / `email-to` | email → person |
| `messages-with` | chat thread → person |
| `assigned-to` | task → person |
| `belongs-to` | task → project |
| `member-of` | person → organization or project |
| `works-at` | person → organization |
| `references` | any → any (one note mentions another) |
| `related-to` | any → any (use sparingly) |

If a fact does not fit one of these, do not invent a name (`supersedes`,
`from`, `owner`, `participant`, `mentions` …) — record it as a sentence in
the entity's description instead.

```yaml
relationship:
  source: "Entity A canonical name (or the source note id)"
  target: "Entity B canonical name"
  type: works-at            # canonical name only
  confidence: 0.85
  evidence: "Quote that states it explicitly"
```

`works-at` and `member-of` need an explicit statement ("Sam is the director
of Example Org"); never infer them from an email domain or a shared meeting.

### Step 4: Quality Assessment

For each extraction, assess:
- **High confidence (0.9+)**: Entity is explicitly named and discussed
- **Medium confidence (0.7-0.89)**: Entity is mentioned but context is ambiguous
- **Low confidence (0.5-0.69)**: Entity is implied or only partially referenced

Flag low-confidence extractions for human review.

These numbers are EXTRACTION scores for the reconcile step. They are never stored as
they are: when a note is written, `confidence` on a person / project / organization /
concept is the label `high` (≥ 0.8), `medium` (≥ 0.5) or `low` — see the "Field
shapes" block in `.claude/skills/reconcile/SKILL.md` (generated from
`packages/core/src/lib/schemas/vault-shapes.json`).

## Output Format

Return extractions as a structured list ready for the reconciliation skill:

```
## Extracted Entities

### [Type]: [Canonical Name] (confidence: 0.95)
- **Aliases**: Name1, Name2
- **Fields**: role=X, org=Y
- **Source**: "exact mention in content"
- **Description**: One-sentence summary

### Relationships
- [Source] --[canonical relationship]--> [Target] (confidence: 0.85)
  Evidence: "supporting quote"
```

## Extraction Guidelines

1. **Prefer specificity over recall** — It's better to extract fewer entities with high confidence than many with low confidence
2. **Respect the schema** — Only extract entity types defined in the vault's schema. If you find something that doesn't fit, note it but don't force it into a type
3. **Never decide identity here** — matching extracted people to existing notes is the `reconcile` skill's job (MATCH / CREATE / AMBIGUOUS); ambiguous people go to Prism's review queue there
4. **Deduplicate within extraction** — If the same entity appears multiple times in the source, consolidate into one entry with all mentions
5. **Preserve attribution** — Always include the exact text that supports each extraction
6. **Use canonical names** — Normalize names to their most formal/complete form. "Sarah" in context of "Sarah Chen from BFC" → canonical_name: "Sarah Chen"
7. **Capture aliases naturally** — If someone is referred to as both "PB" and "Participatory Budgeting", capture both
8. **Don't hallucinate relationships** — Only extract relationships explicitly stated or strongly implied in the content
9. **Note meeting context** — For transcripts, capture who said what when relevant to entity attributes
