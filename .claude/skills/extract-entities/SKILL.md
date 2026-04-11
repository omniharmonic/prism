---
name: Entity Extraction
description: "Extract structured entities and relationships from unstructured content (transcripts, notes, documents) using the vault's schema as a guide. Produces typed entities with metadata, aliases, and confidence scores ready for reconciliation against the Parachute Vault."
version: 1.0.0
---

# Entity Extraction Skill

You are performing domain-aware entity extraction from unstructured content. Unlike generic NER, you extract entities according to the vault's schema — the resource types, dimensions, and relationships defined during setup.

## When to Use

This skill activates when processing raw content (transcripts, notes, documents) that needs entity extraction. It is called by the `/oparachute-process` command pipeline.

## Inputs Required

Before extracting, you MUST gather:

1. **The vault's schema** — Call `mcp__parachute-vault__get-vault-description` to get the resource types, dimensions, and relationship types defined for this vault
2. **Existing entities** — Load a lightweight entity index for context and dedup awareness:
   ```
   For each resource type in the schema:
     mcp__parachute-vault__read-notes
       tags: [type_tag]
       include_content: false          ← NoteIndex: id, path, metadata, preview only
       exclude_tags: ["needs-review"]  ← only confirmed entities
       limit: 200
       sort: "desc"                    ← most recent first
   ```
   This gives you paths and metadata (including aliases) to check against without downloading full content
3. **The source content** — The raw text to extract from
4. **Source metadata** — Date, speakers, source type (transcript, document, etc.)

## Extraction Process

### Step 1: Read the Schema

Parse the vault description to understand:
- What resource types exist (e.g., person, pattern, organization, project)
- What fields each type expects (e.g., person needs role, org, email)
- What dimensions are tracked (e.g., sector, scale)
- What relationship types are valid (e.g., member_of, implements)

### Step 2: Identify Entities

For each entity found in the content:

```yaml
entity:
  canonical_name: "Full Proper Name"
  type: person|pattern|organization|project|[schema-defined type]
  aliases:
    - "Nickname"
    - "Abbreviation"
  confidence: 0.95  # How confident you are this is a real entity
  mentions:
    - text: "exact quote from source"
      context: "surrounding sentence for disambiguation"
  attributes:
    # Type-specific fields from schema
    role: "Community Organizer"
    org: "Bioregional Food Council"
    # Dimension values
    sectors: ["governance", "food-systems"]
    scales: ["municipal", "bioregional"]
  description: "One-sentence summary of who/what this is"
```

### Step 3: Identify Relationships

For each relationship between extracted entities:

```yaml
relationship:
  source: "Entity A canonical name"
  target: "Entity B canonical name"
  type: member_of|implements|relates_to|[schema-defined type]
  confidence: 0.85
  evidence: "Quote or context supporting this relationship"
```

### Step 4: Quality Assessment

For each extraction, assess:
- **High confidence (0.9+)**: Entity is explicitly named and discussed
- **Medium confidence (0.7-0.89)**: Entity is mentioned but context is ambiguous
- **Low confidence (0.5-0.69)**: Entity is implied or only partially referenced

Flag low-confidence extractions for human review.

## Output Format

Return extractions as a structured list ready for the reconciliation skill:

```
## Extracted Entities

### [Type]: [Canonical Name] (confidence: 0.95)
- **Aliases**: Name1, Name2
- **Fields**: role=X, org=Y
- **Dimensions**: sector/governance, scale/municipal
- **Source**: "exact mention in content"
- **Description**: One-sentence summary

### Relationships
- [Source] --[relationship_type]--> [Target] (confidence: 0.85)
  Evidence: "supporting quote"
```

## Extraction Guidelines

1. **Prefer specificity over recall** — It's better to extract fewer entities with high confidence than many with low confidence
2. **Respect the schema** — Only extract entity types defined in the vault's schema. If you find something that doesn't fit, note it but don't force it into a type
3. **Deduplicate within extraction** — If the same entity appears multiple times in the source, consolidate into one entry with all mentions
4. **Preserve attribution** — Always include the exact text that supports each extraction
5. **Use canonical names** — Normalize names to their most formal/complete form. "Sarah" in context of "Sarah Chen from BFC" → canonical_name: "Sarah Chen"
6. **Capture aliases naturally** — If someone is referred to as both "PB" and "Participatory Budgeting", capture both
7. **Don't hallucinate relationships** — Only extract relationships explicitly stated or strongly implied in the content
8. **Note meeting context** — For transcripts, capture who said what when relevant to entity attributes
