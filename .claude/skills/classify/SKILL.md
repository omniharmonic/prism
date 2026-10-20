---
name: Content Classification
description: "Classify raw content by type (transcript, document, voice memo, research, etc.) and determine the appropriate processing strategy. Detects content structure, identifies speakers, and assesses extraction potential."
version: 1.0.0
---

# Content Classification Skill

You classify raw content entering the processing pipeline to determine how it should be handled. Different content types need different preprocessing and extraction strategies.

## When to Use

This skill activates at the start of the processing pipeline, before entity extraction. It examines raw content and produces a classification that guides downstream processing.

## Classification Process

### Step 1: Detect Content Type

Examine the content and classify as one of:

| Type | Signals | Processing Strategy |
|------|---------|-------------------|
| `transcript` | Speaker labels, timestamps, conversational flow | Extract speakers as people, topics as entities, decisions as events |
| `meeting-note` | Agenda items, action items, date/attendees in header | Extract attendees, decisions, action items, topics discussed |
| `voice-memo` | First-person, informal, stream-of-consciousness | Light extraction, capture key ideas and references |
| `research` | Citations, structured arguments, references | Extract concepts, cited works, key findings |
| `document` | Formal structure, sections, formal tone | Extract main topics, referenced entities, key points |
| `link` | URL, web content, article text | Extract source, key claims, referenced entities |
| `activity` | Event/grant/program description | Extract organizations, dates, funding amounts, participants |

### Step 2: Assess Structure

Evaluate the content's structure:

- **Speaker detection**: Are there labeled speakers? (e.g., "Benjamin: ...", "Speaker 1: ...")
- **Timestamp presence**: Are there timestamps? What format?
- **Section headers**: Is content organized into sections?
- **Metadata header**: Is there existing YAML frontmatter or structured header?
- **Language quality**: Is this raw transcription (may need cleanup) or polished text?
- **Length**: Short (< 500 words), medium (500-2000), long (> 2000)

### Step 3: Extraction Potential

Assess how much extractable knowledge the content contains:

- **High potential**: Multiple entities, relationships, and structured information
- **Medium potential**: Some entities and context, but mostly narrative
- **Low potential**: Personal reflection, emotional content, little factual content

### Step 4: Preprocessing Needs

Determine if content needs preprocessing before extraction:

- **Transcript cleanup**: Remove filler words, fix speaker attribution, paragraph breaks
- **Content splitting**: Long content may need chunking for extraction
- **Metadata enrichment**: Add date, source, attendee info from context clues
- **None**: Content is clean and ready for extraction

## Output Format

```
## Classification

**Type**: transcript
**Structure**: Speaker-labeled, timestamped, ~3500 words
**Speakers**: Benjamin Life, Sarah Chen, Gregory Landua
**Date detected**: 2026-02-20
**Source**: Fathom recording
**Extraction potential**: High
**Preprocessing needed**: Light cleanup (remove filler, fix paragraph breaks)

**Recommended pipeline**:
1. Clean up transcript formatting
2. Extract entities (people, organizations, patterns, projects)
3. Extract relationships (membership, collaboration, implementation)
4. Extract action items and decisions
5. Reconcile against vault
```

## Classification Rules

1. **Use vault schema context** — The vault description tells you what types of entities to look for. A governance-focused vault will extract different entities from the same transcript than a tech-focused one.
2. **Don't over-classify** — If content doesn't clearly fit a type, use `document` as the default
3. **Detect mixed content** — A meeting transcript might contain both transcript sections and pre-written agenda items. Note this for the extraction stage.
4. **Flag low-value content** — If content has low extraction potential, recommend skipping extraction and just storing as-is with basic tags
